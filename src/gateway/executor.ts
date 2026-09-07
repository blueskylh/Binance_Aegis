/**
 * The execution gateway — Aegis as the only write path.
 *
 * ## Why this exists
 *
 * v1.0.0 wired Aegis and the Binance MCP server side by side and told the agent,
 * in its system prompt, to ask Aegis first. That is *advice*. A prompt-injected
 * or simply buggy agent could call Binance directly and the firewall would never
 * see the order. The README claimed "nothing reaches Binance until Aegis says
 * allow" — but nothing in the architecture enforced it.
 *
 * The gateway closes that hole by inverting the topology:
 *
 *     agent ──▶ Aegis ──▶ Binance          (gateway mode: enforced)
 *
 * instead of
 *
 *     agent ──▶ Aegis                      (advisory mode: hope)
 *          └──▶ Binance
 *
 * In gateway mode Aegis holds the `binance-cli` profile and the agent is given
 * no Binance write tool at all. The guarantee stops being a promise about agent
 * behaviour and becomes a property of the deployment: the agent has no
 * credentials, so there is no path to the venue that does not pass through here.
 *
 * ## Three properties worth stating
 *
 * 1. **Counters move on real fills.** The gateway reads the venue's response, so
 *    a mis-reporting agent cannot understate its own consumption.
 * 2. **Approval binds to a digest.** A human approves one exact action; the
 *    ticket cannot be swapped for a bigger one after the fact.
 * 3. **Approval is consent, not a bypass.** Every ticket is re-evaluated at
 *    redemption, so a kill-switch pulled while it sat in the queue still wins.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Aegis, GuardResult } from '../aegis.js';
import type { NormalizedAction, ProposedAction } from '../types.js';

/** What the venue reports back after an order. */
export interface FillReport {
  ok: boolean;
  orderId: string | null;
  clientOrderId: string | null;
  symbol: string;
  status: string;
  /** Actual filled notional in USD, as read from the venue. */
  filledNotionalUsd: number;
  realizedPnlUsd: number;
  raw: unknown;
}

/** Anything able to place an order. Implemented by BinanceAdapter; faked in tests. */
export interface OrderExecutor {
  placeOrder(action: NormalizedAction): Promise<FillReport>;
}

export interface PendingTicket {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** SHA-256 over the normalized action — binds approval to exactly what was shown. */
  actionDigest: string;
  summary: string;
  symbol: string | null;
  notionalUsd: number;
  findings: string[];
  proposal: ProposedAction;
}

export type ExecutionStatus = 'executed' | 'blocked' | 'pending-approval' | 'failed' | 'dry-run';

export interface ExecutionOutcome {
  status: ExecutionStatus;
  verdict: 'allow' | 'review' | 'deny';
  ticketId: string | null;
  decision: GuardResult;
  fill: FillReport | null;
  error: string | null;
  /** One-line human summary, ready to relay to an operator. */
  summary: string;
}

export interface GatewayOptions {
  /** Evaluate and report, but never reach the venue. Default false. */
  dryRun?: boolean;
  /** How long a parked approval stays redeemable. Default 1 hour. */
  ticketTtlMs?: number;
}

/** Stable digest of the material fields of an action. */
export function digestAction(action: NormalizedAction): string {
  return createHash('sha256').update(JSON.stringify({
    category: action.category,
    venue: action.venue,
    symbol: action.symbol,
    asset: action.asset,
    side: action.side,
    orderType: action.orderType,
    quantity: action.quantity,
    price: action.price,
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
  private readonly pending = new Map<string, PendingTicket>();

  constructor(aegis: Aegis, executor: OrderExecutor, options: GatewayOptions = {}) {
    this.aegis = aegis;
    this.executor = executor;
    this.dryRun = options.dryRun ?? false;
    this.ticketTtlMs = options.ticketTtlMs ?? 3_600_000;
  }

  /**
   * The single entry point an agent gets in gateway mode.
   *
   * Evaluate → (allow: execute) | (review: park) | (deny: stop). The venue is
   * only ever reached from inside the `allow` branch.
   */
  async execute(proposal: ProposedAction): Promise<ExecutionOutcome> {
    const decision = this.aegis.guard(proposal);

    if (decision.verdict === 'deny') {
      return {
        status: 'blocked',
        verdict: 'deny',
        ticketId: null,
        decision,
        fill: null,
        error: null,
        summary: `BLOCKED — ${decision.summary} Nothing was sent to Binance.`,
      };
    }

    if (decision.verdict === 'review') {
      const ticket = this.park(proposal, decision);
      return {
        status: 'pending-approval',
        verdict: 'review',
        ticketId: ticket.id,
        decision,
        fill: null,
        error: null,
        summary:
          `AWAITING APPROVAL — ${decision.summary} ` +
          `Nothing was sent to Binance. Approve with: aegis approve ${ticket.id}`,
      };
    }

    if (this.dryRun) {
      return {
        status: 'dry-run',
        verdict: 'allow',
        ticketId: null,
        decision,
        fill: null,
        error: null,
        summary: `DRY-RUN — would have executed: ${decision.summary}`,
      };
    }

    return this.dispatch(decision);
  }

  /** Place the order and settle the counters from what the venue actually did. */
  private async dispatch(decision: GuardResult): Promise<ExecutionOutcome> {
    const action = decision.normalized;
    try {
      const fill = await this.executor.placeOrder(action);
      if (!fill.ok) {
        this.aegis.note(`execution rejected by venue for ${action.id}: ${fill.status}`, { orderId: fill.orderId });
        return {
          status: 'failed',
          verdict: 'allow',
          ticketId: null,
          decision,
          fill,
          error: `venue rejected the order (${fill.status})`,
          summary: `FAILED — Aegis allowed it, but Binance rejected it (${fill.status}).`,
        };
      }

      // Settle from the venue's numbers, never the agent's claim.
      this.aegis.recordExecution({
        actionId: action.id,
        category: action.category,
        venue: action.venue,
        symbol: action.symbol,
        notionalUsd: fill.filledNotionalUsd,
        realizedPnlUsd: fill.realizedPnlUsd,
        meta: { orderId: fill.orderId, status: fill.status, source: 'gateway' },
      });

      return {
        status: 'executed',
        verdict: 'allow',
        ticketId: null,
        decision,
        fill,
        error: null,
        summary:
          `EXECUTED — ${action.side ?? ''} ${action.symbol ?? action.venue} ` +
          `filled $${Math.round(fill.filledNotionalUsd * 100) / 100} (order ${fill.orderId ?? 'n/a'}).`,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.aegis.note(`execution error for ${action.id}: ${message}`, { fatal: false });
      return {
        status: 'failed',
        verdict: 'allow',
        ticketId: null,
        decision,
        fill: null,
        error: message,
        summary: `FAILED — Aegis allowed it, but the order could not be placed: ${message}`,
      };
    }
  }

  private park(proposal: ProposedAction, decision: GuardResult): PendingTicket {
    const now = this.aegis.now();
    const ticket: PendingTicket = {
      id: `tkt-${randomUUID().slice(0, 8)}`,
      createdAt: now,
      expiresAt: now + this.ticketTtlMs,
      actionDigest: digestAction(decision.normalized),
      summary: decision.summary,
      symbol: decision.normalized.symbol,
      notionalUsd: decision.normalized.notionalUsd,
      findings: decision.findings.map((f) => f.ruleId),
      proposal,
    };
    this.pending.set(ticket.id, ticket);
    this.aegis.note(`parked for human approval: ${ticket.id}`, {
      ticketId: ticket.id,
      actionDigest: ticket.actionDigest,
      notionalUsd: ticket.notionalUsd,
    });
    return ticket;
  }

  /** Human approval. Consumes the ticket, re-evaluates, then executes. */
  async approve(ticketId: string, approver: string): Promise<ExecutionOutcome> {
    const ticket = this.pending.get(ticketId);
    if (!ticket) {
      return this.ticketFailure(ticketId, 'no such pending ticket (already used, rejected, or never issued)');
    }
    // Single-use: consume before doing anything that could throw.
    this.pending.delete(ticketId);

    if (this.aegis.now() > ticket.expiresAt) {
      this.aegis.note(`approval ticket expired: ${ticketId}`, { approver });
      return this.ticketFailure(ticketId, 'ticket expired; resubmit the action to get a fresh decision');
    }

    // Re-evaluate. Approval is consent to THIS action, not a standing exemption:
    // a kill-switch pulled while the ticket sat in the queue must still win.
    const decision = this.aegis.guard({ ...ticket.proposal, id: `${ticket.proposal.id ?? ticket.id}-approved` });

    if (digestAction(decision.normalized) !== ticket.actionDigest) {
      this.aegis.note(`approval digest mismatch on ${ticketId}`, { approver });
      return this.ticketFailure(ticketId, 'the action changed since it was shown for approval; refusing to execute');
    }

    if (decision.verdict === 'deny') {
      this.aegis.note(`approved ticket ${ticketId} re-evaluated to DENY`, { approver });
      return {
        status: 'blocked',
        verdict: 'deny',
        ticketId,
        decision,
        fill: null,
        error: null,
        summary: `BLOCKED — conditions changed since approval: ${decision.summary}`,
      };
    }

    this.aegis.note(`human approval granted for ${ticketId}`, { approver, digest: ticket.actionDigest });

    if (this.dryRun) {
      return {
        status: 'dry-run',
        verdict: decision.verdict,
        ticketId,
        decision,
        fill: null,
        error: null,
        summary: `DRY-RUN — approved, would have executed: ${decision.summary}`,
      };
    }

    return { ...(await this.dispatch(decision)), ticketId };
  }

  /** Human rejection. Consumes the ticket and records the refusal. */
  reject(ticketId: string, reason: string): boolean {
    const existed = this.pending.delete(ticketId);
    this.aegis.note(`human rejected ${ticketId}: ${reason}`, { ticketId, existed });
    return existed;
  }

  listPending(): PendingTicket[] {
    const now = this.aegis.now();
    for (const [id, t] of this.pending) if (now > t.expiresAt) this.pending.delete(id);
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
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
      error,
      summary: `FAILED — ${error}`,
    };
  }
}
