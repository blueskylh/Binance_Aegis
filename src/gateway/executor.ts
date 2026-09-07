/**
 * The execution gateway — Aegis as the only write path.
 *
 * ## Why this exists
 *
 * v1.0.0 wired Aegis and the Binance MCP server side by side and told the agent,
 * in its system prompt, to ask Aegis first. That is *advice*: a prompt-injected
 * or buggy agent could call Binance directly and the firewall would never see
 * the order. Gateway mode inverts the topology so the guarantee is structural:
 *
 *     agent ──▶ Aegis ──▶ Binance
 *
 * Aegis holds the `binance-cli` profile; the agent is given no Binance write
 * tool at all.
 *
 * ## What the second audit changed
 *
 * v2.0.0 got the topology right and the execution boundary wrong:
 *
 *  - **GW-01** Approval tickets lived in an in-memory `Map`, so the CLI's
 *    two-process approve flow could never find them. Now durable (`approvals.json`).
 *  - **GW-02** The adapter re-derived the futures quantity from notional, turning
 *    a judged $100 order into 100 BTC. Quantities are now resolved during
 *    normalization and passed through verbatim — the engine judges the exact
 *    order that gets sent.
 *  - **GW-03** Unsupported venues were silently rerouted to spot. Capability is
 *    now an explicit allowlist checked before dispatch.
 *  - **GW-04** A resting `NEW` order was booked as a full fill. Reconciliation
 *    is now status-aware and never falls back to the requested size.
 *  - **GW-05** Decisions ran against a possibly stale snapshot. The gateway
 *    refreshes before judging when an adapter is available.
 *  - **GW-06** `hasStopLoss: true` was believed. A `stopPrice` is now validated
 *    and actually placed after the entry fills.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Aegis, GuardResult } from '../aegis.js';
import { ApprovalStore, type ApprovalTicket } from './approvals.js';
import { InFlightRegistry } from './inflight.js';
import { describeCapabilities, isExecutable } from './capabilities.js';
import type { Finding, NormalizedAction, ProposedAction } from '../types.js';

/** What the venue reports back after an order. */
export interface FillReport {
  ok: boolean;
  orderId: string | null;
  clientOrderId: string | null;
  symbol: string;
  /** Venue order status: FILLED, PARTIALLY_FILLED, NEW, REJECTED, … */
  status: string;
  /** Actual filled notional in USD, as read from the venue. 0 when unfilled. */
  filledNotionalUsd: number;
  /** Actual filled base quantity. Used to size the protective stop. */
  filledQuantity: number;
  realizedPnlUsd: number;
  raw: unknown;
}

export interface OrderExecutor {
  placeOrder(action: NormalizedAction): Promise<FillReport>;
}

/** Optional account refresher, so decisions run against fresh positions. */
export interface AccountRefresher {
  equityUsd(): Promise<number>;
  positions(): Promise<import('../types.js').PositionSnapshot[]>;
  marks(symbols: readonly string[]): Promise<Record<string, number>>;
}

export type ExecutionStatus =
  | 'executed'
  | 'accepted-unfilled'
  | 'blocked'
  | 'pending-approval'
  | 'failed'
  | 'dry-run';

export interface ExecutionOutcome {
  status: ExecutionStatus;
  verdict: 'allow' | 'review' | 'deny';
  ticketId: string | null;
  decision: GuardResult;
  fill: FillReport | null;
  /** The protective stop placed alongside the entry, when one was required. */
  protectiveStop: FillReport | null;
  error: string | null;
  summary: string;
}

export interface GatewayOptions {
  dryRun?: boolean;
  /** How long a parked approval stays redeemable. Default 1 hour. */
  ticketTtlMs?: number;
  /** Where `approvals.json` lives. Defaults to the Aegis data dir. */
  dataDir?: string;
  /** When supplied, positions are refreshed before every decision. */
  refresher?: AccountRefresher;
  /** Symbols kept warm in the mark cache during a refresh. */
  watch?: string[];
}

/** Venues where the gateway can attach a STOP_MARKET bracket. */
const STOP_CAPABLE_VENUES = new Set(['futures-usds', 'futures-coin']);

/** Venue statuses that represent real, settled exposure. */
const FILLED_STATUSES = new Set(['FILLED', 'PARTIALLY_FILLED']);
/** Venue statuses that mean the order rests unfilled — accepted, but not exposure. */
const RESTING_STATUSES = new Set(['NEW', 'ACK', 'PENDING_NEW', 'ACCEPTED']);

/** Stable digest of the material fields of an action, including what will be sent. */
export function digestAction(action: NormalizedAction): string {
  return createHash('sha256').update(JSON.stringify({
    category: action.category,
    venue: action.venue,
    symbol: action.symbol,
    asset: action.asset,
    side: action.side,
    orderType: action.orderType,
    quantity: action.quantity,
    executionQuantity: action.executionQuantity,
    price: action.price,
    stopPrice: action.stopPrice,
    leverage: action.leverage,
    reduceOnly: action.reduceOnly,
    closePosition: action.closePosition,
    notionalUsd: action.notionalUsd,
  })).digest('hex');
}

export class ExecutionGateway {
  private readonly aegis: Aegis;
  private readonly executor: OrderExecutor;
  private readonly dryRun: boolean;
  private readonly ticketTtlMs: number;
  private readonly approvals: ApprovalStore;
  private readonly inflight: InFlightRegistry;
  private readonly refresher: AccountRefresher | null;
  private readonly watch: string[];
  /** Last refresh failure text, so an identical one is not re-logged (SA-04). */
  private lastRefreshError: string | null = null;

  constructor(aegis: Aegis, executor: OrderExecutor, options: GatewayOptions = {}) {
    this.aegis = aegis;
    this.executor = executor;
    this.dryRun = options.dryRun ?? false;
    this.ticketTtlMs = options.ticketTtlMs ?? 3_600_000;
    const home = options.dataDir ?? aegis.dataDir;
    this.approvals = new ApprovalStore(join(home, 'approvals.json'));
    this.inflight = new InFlightRegistry(join(home, 'inflight.json'));
    this.refresher = options.refresher ?? null;
    this.watch = options.watch ?? ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
  }

  /**
   * Pull fresh account state before judging.
   *
   * Reduce-only verification is only as good as the positions it checks against;
   * running it on a stale snapshot is the difference between verifying and
   * assuming. Failures are non-fatal — the `stale-position-data` rule then
   * refuses the exemption rather than granting it on old evidence.
   */
  private async refresh(): Promise<void> {
    if (!this.refresher) return;
    try {
      const [equityUsd, positions, marks] = await Promise.all([
        this.refresher.equityUsd(),
        this.refresher.positions(),
        this.refresher.marks(this.watch),
      ]);
      if (equityUsd > 0 || positions.length > 0 || Object.keys(marks).length > 0) {
        this.aegis.updateAccount({ equityUsd, positions, marks });
      }
      this.lastRefreshError = null;
    } catch (err) {
      // A broken CLI would otherwise write one note per call and bury the real
      // events under noise, which is its own kind of audit failure.
      const message = (err as Error).message;
      if (message !== this.lastRefreshError) {
        this.lastRefreshError = message;
        this.aegis.note(`pre-trade refresh failing, judging on last snapshot: ${message}`, { suppressRepeats: true });
      }
    }
  }

  /**
   * The single entry point an agent gets in gateway mode.
   *
   * refresh → capability check → policy → (allow: execute · review: park · deny: stop)
   */
  async execute(proposal: ProposedAction): Promise<ExecutionOutcome> {
    // SA-05: claim the action id synchronously, before the first await. The
    // duplicate-action rule reads the ledger, which only knows about orders that
    // have already completed — so without this, five concurrent retries of one
    // id all pass the check and all execute.
    const reservationId = this.reservationKeyFor(proposal);
    if (reservationId !== null && !this.inflight.reserve(reservationId, this.aegis.now())) {
      return this.inFlightRefusal(proposal, reservationId);
    }

    try {
      return await this.executeReserved(proposal);
    } finally {
      if (reservationId !== null) this.inflight.release(reservationId);
    }
  }

  /** Reads never move funds, so they need no reservation. */
  private reservationKeyFor(proposal: ProposedAction): string | null {
    if (proposal.category === 'read') return null;
    return typeof proposal.id === 'string' && proposal.id.trim() !== '' ? proposal.id.trim() : null;
  }

  private inFlightRefusal(proposal: ProposedAction, id: string): ExecutionOutcome {
    const finding: Finding = {
      ruleId: 'action-in-flight',
      verdict: 'deny',
      severity: 'critical',
      message:
        `Action id "${id}" is already being executed. Refusing the duplicate — ` +
        'a retry after a timeout must not become a second position. ' +
        'Wait for the first result, or submit with a fresh id if this really is a new order.',
      observed: id,
      limit: 'one in-flight execution per action id',
    };
    this.aegis.note(`refused a concurrent duplicate of ${id}`, { actionId: id });
    return {
      status: 'blocked',
      verdict: 'deny',
      ticketId: null,
      decision: {
        verdict: 'deny', summary: finding.message, actionId: id, notionalUsd: 0,
        findings: [finding], policy: this.aegis.policy.name, mode: this.aegis.policy.mode,
        ledgerSeq: -1, ledgerHash: '',
        normalized: null as unknown as NormalizedAction,
      },
      fill: null,
      protectiveStop: null,
      error: null,
      summary: `BLOCKED — ${finding.message}`,
    };
    void proposal;
  }

  private async executeReserved(proposal: ProposedAction): Promise<ExecutionOutcome> {
    await this.refresh();

    const decision = this.aegis.guard(proposal);

    // Capability is a property of EXECUTION, not of policy. Check it after the
    // policy verdict so the ledger records both reasons, and before any dispatch.
    const unsupported = this.capabilityFinding(decision.normalized);
    if (unsupported) {
      const withFinding: GuardResult = {
        ...decision,
        verdict: 'deny',
        findings: [unsupported, ...decision.findings],
        summary: `DENY — ${unsupported.message}`,
      };
      this.aegis.note(`capability refusal: ${decision.normalized.category}/${decision.normalized.venue}`, {
        actionId: decision.actionId,
      });
      return this.blocked(withFinding, 'Nothing was sent to Binance.');
    }

    if (decision.verdict === 'deny') return this.blocked(decision, 'Nothing was sent to Binance.');

    if (decision.verdict === 'review') {
      const ticket = this.park(proposal, decision);
      return {
        status: 'pending-approval',
        verdict: 'review',
        ticketId: ticket.id,
        decision,
        fill: null,
        protectiveStop: null,
        error: null,
        summary:
          `AWAITING APPROVAL — ${decision.summary} ` +
          `Nothing was sent to Binance. Approve with: aegis approve ${ticket.id} --live`,
      };
    }

    if (this.dryRun) {
      return {
        status: 'dry-run',
        verdict: 'allow',
        ticketId: null,
        decision,
        fill: null,
        protectiveStop: null,
        error: null,
        summary: `DRY-RUN — would have executed: ${decision.summary}`,
      };
    }

    return this.dispatch(decision);
  }

  private capabilityFinding(action: NormalizedAction): Finding | null {
    if (isExecutable(action.category, action.venue)) return null;
    return {
      ruleId: 'unsupported-execution-capability',
      verdict: 'deny',
      severity: 'critical',
      message:
        `The gateway cannot execute ${action.category} on ${action.venue}. ` +
        `Supported: ${describeCapabilities()}. ` +
        'Aegis refuses rather than routing the order somewhere it was not authorised for.',
      observed: `${action.category}/${action.venue}`,
      limit: describeCapabilities(),
    };
  }

  private blocked(decision: GuardResult, note: string): ExecutionOutcome {
    return {
      status: 'blocked',
      verdict: 'deny',
      ticketId: null,
      decision,
      fill: null,
      protectiveStop: null,
      error: null,
      summary: `BLOCKED — ${decision.summary} ${note}`,
    };
  }

  /** Place the order and settle the counters from what the venue actually did. */
  private async dispatch(decision: GuardResult): Promise<ExecutionOutcome> {
    const action = decision.normalized;
    let fill: FillReport;
    try {
      fill = await this.executor.placeOrder(action);
    } catch (err) {
      const message = (err as Error).message;
      this.aegis.note(`execution error for ${action.id}: ${message}`);
      return {
        status: 'failed', verdict: 'allow', ticketId: null, decision,
        fill: null, protectiveStop: null, error: message,
        summary: `FAILED — Aegis allowed it, but the order could not be placed: ${message}`,
      };
    }

    const status = String(fill.status ?? '').toUpperCase();

    if (!fill.ok || (!FILLED_STATUSES.has(status) && !RESTING_STATUSES.has(status))) {
      this.aegis.note(`venue rejected ${action.id} with status ${status}`, { orderId: fill.orderId });
      return {
        status: 'failed', verdict: 'allow', ticketId: null, decision,
        fill, protectiveStop: null, error: `venue rejected the order (${status})`,
        summary: `FAILED — Aegis allowed it, but Binance rejected it (${status}).`,
      };
    }

    // GW-04: a resting order is an accepted order, not exposure. Booking the
    // requested size as a fill is precisely the misreporting this design exists
    // to prevent — so an unfilled order consumes no budget.
    if (!FILLED_STATUSES.has(status) || fill.filledNotionalUsd <= 0) {
      this.aegis.note(`order ${action.id} accepted but unfilled (${status}); no budget consumed`, {
        orderId: fill.orderId, status,
      });
      return {
        status: 'accepted-unfilled', verdict: 'allow', ticketId: null, decision,
        fill, protectiveStop: null, error: null,
        summary:
          `ACCEPTED (unfilled) — order ${fill.orderId ?? 'n/a'} is resting at the venue with status ${status}. ` +
          'No budget consumed until it fills.',
      };
    }

    this.aegis.recordExecution({
      actionId: action.id,
      category: action.category,
      venue: action.venue,
      symbol: action.symbol,
      notionalUsd: fill.filledNotionalUsd,
      realizedPnlUsd: fill.realizedPnlUsd,
      meta: { orderId: fill.orderId, status, source: 'gateway' },
    });

    const protectiveStop = await this.placeProtectiveStop(action, fill);

    const stopNote = protectiveStop === null
      ? ''
      : protectiveStop.ok
        ? ` Protective stop placed at ${action.stopPrice} (${protectiveStop.orderId ?? 'n/a'}).`
        : ' ⚠ PROTECTIVE STOP FAILED — the position is unprotected; close it or place a stop manually.';

    return {
      status: 'executed', verdict: 'allow', ticketId: null, decision,
      fill, protectiveStop, error: null,
      summary:
        `EXECUTED — ${action.side ?? ''} ${action.symbol ?? action.venue} ` +
        `filled $${Math.round(fill.filledNotionalUsd * 100) / 100} (order ${fill.orderId ?? 'n/a'}).${stopNote}`,
    };
  }

  /**
   * Place the protective stop the policy demanded.
   *
   * GW-06: `requireStopLoss` used to be satisfied by a boolean the agent set
   * itself. Now the entry carries a validated `stopPrice`, and the gateway
   * actually attaches the stop — sized to what really filled, not what was asked
   * for.
   */
  private async placeProtectiveStop(entry: NormalizedAction, fill: FillReport): Promise<FillReport | null> {
    if (entry.stopPrice === null || entry.side === null || entry.symbol === null) return null;
    if (entry.reduceOnly || entry.closePosition) return null;
    // Self-audit SA-02: STOP_MARKET is a derivatives order type. Sending one to
    // spot would be rejected at best and mean something else at worst, so the
    // bracket is only placed where the venue actually supports it.
    if (!STOP_CAPABLE_VENUES.has(entry.venue)) {
      this.aegis.note(`no protective stop placed for ${entry.id}: ${entry.venue} does not support STOP_MARKET`);
      return null;
    }

    const quantity = fill.filledQuantity > 0 ? fill.filledQuantity : entry.executionQuantity;
    if (quantity === null || quantity <= 0) {
      this.aegis.note(`cannot size a protective stop for ${entry.id}: unknown filled quantity`);
      return null;
    }

    const stop: NormalizedAction = {
      ...entry,
      id: `${entry.id}-stop`,
      side: entry.side === 'BUY' ? 'SELL' : 'BUY',
      orderType: 'STOP_MARKET',
      quantity,
      executionQuantity: quantity,
      price: entry.stopPrice,
      reduceOnly: true,
      closePosition: false,
      stopPrice: entry.stopPrice,
    };

    try {
      const result = await this.executor.placeOrder(stop);
      this.aegis.note(`protective stop for ${entry.id} at ${entry.stopPrice}`, {
        orderId: result.orderId, ok: result.ok, status: result.status,
      });
      return result;
    } catch (err) {
      // Loud, and recorded. An unprotected leveraged position is exactly the
      // state the policy was trying to prevent.
      this.aegis.note(`PROTECTIVE STOP FAILED for ${entry.id}: ${(err as Error).message}`, { severity: 'critical' });
      return {
        ok: false, orderId: null, clientOrderId: stop.id, symbol: entry.symbol,
        status: 'STOP_PLACEMENT_FAILED', filledNotionalUsd: 0, filledQuantity: 0,
        realizedPnlUsd: 0, raw: { error: (err as Error).message },
      };
    }
  }

  private park(proposal: ProposedAction, decision: GuardResult): ApprovalTicket {
    const now = this.aegis.now();
    const ticket: ApprovalTicket = {
      id: `tkt-${randomUUID().slice(0, 8)}`,
      status: 'PENDING',
      createdAt: now,
      expiresAt: now + this.ticketTtlMs,
      actionDigest: digestAction(decision.normalized),
      summary: decision.summary,
      symbol: decision.normalized.symbol,
      notionalUsd: decision.normalized.notionalUsd,
      findings: decision.findings.map((f) => f.ruleId),
      proposal,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    this.approvals.put(ticket);
    this.aegis.note(`parked for human approval: ${ticket.id}`, {
      ticketId: ticket.id, actionDigest: ticket.actionDigest, notionalUsd: ticket.notionalUsd,
    });
    return ticket;
  }

  /** Human approval. Consumes the ticket atomically, re-evaluates, then executes. */
  async approve(ticketId: string, approver: string): Promise<ExecutionOutcome> {
    const now = this.aegis.now();
    const ticket = this.approvals.consume(ticketId, now, 'APPROVED', approver, 'approved by operator');
    if (!ticket) {
      return this.ticketFailure(ticketId, 'no such pending ticket (already used, rejected, expired, or never issued)');
    }

    await this.refresh();

    // Approval is consent to THIS action, not a standing exemption: a
    // kill-switch pulled while the ticket sat in the queue must still win.
    const decision = this.aegis.guard({ ...ticket.proposal, id: `${ticket.proposal.id ?? ticket.id}-approved` });

    if (digestAction(decision.normalized) !== ticket.actionDigest) {
      this.aegis.note(`approval digest mismatch on ${ticketId}`, { approver });
      return this.ticketFailure(ticketId, 'the action changed since it was shown for approval; refusing to execute');
    }

    const unsupported = this.capabilityFinding(decision.normalized);
    if (unsupported) {
      return this.blocked({ ...decision, verdict: 'deny', findings: [unsupported, ...decision.findings] }, 'Nothing was sent.');
    }

    if (decision.verdict === 'deny') {
      this.aegis.note(`approved ticket ${ticketId} re-evaluated to DENY`, { approver });
      return {
        ...this.blocked(decision, 'Conditions changed since approval.'),
        ticketId,
      };
    }

    this.aegis.note(`human approval granted for ${ticketId}`, { approver, digest: ticket.actionDigest });

    if (this.dryRun) {
      return {
        status: 'dry-run', verdict: decision.verdict, ticketId, decision,
        fill: null, protectiveStop: null, error: null,
        summary: `DRY-RUN — approved, would have executed: ${decision.summary}`,
      };
    }

    return { ...(await this.dispatch(decision)), ticketId };
  }

  /** Human rejection. Consumes the ticket and records the refusal. */
  reject(ticketId: string, reason: string): boolean {
    const consumed = this.approvals.consume(ticketId, this.aegis.now(), 'REJECTED', 'operator', reason);
    this.aegis.note(`human rejected ${ticketId}: ${reason}`, { ticketId, existed: consumed !== null });
    return consumed !== null;
  }

  listPending(): ApprovalTicket[] {
    return this.approvals.listPending(this.aegis.now());
  }

  listAllTickets(): ApprovalTicket[] {
    return this.approvals.listAll();
  }

  private ticketFailure(ticketId: string, error: string): ExecutionOutcome {
    return {
      status: 'failed',
      verdict: 'deny',
      ticketId,
      decision: {
        verdict: 'deny', summary: error, actionId: ticketId, notionalUsd: 0,
        findings: [], policy: this.aegis.policy.name, mode: this.aegis.policy.mode,
        ledgerSeq: -1, ledgerHash: '', normalized: null as unknown as NormalizedAction,
      },
      fill: null,
      protectiveStop: null,
      error,
      summary: `FAILED — ${error}`,
    };
  }
}
