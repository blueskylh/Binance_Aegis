/**
 * Aegis facade — the object every integration talks to.
 *
 * The CLI, the MCP server and the guardian daemon are all thin shells around
 * this class. Keeping the orchestration in one place means the MCP tool and the
 * CLI command can never drift into enforcing subtly different things.
 */

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { evaluate, RULES } from './core/engine.js';
import { Ledger, type VerifyResult } from './ledger/ledger.js';
import { loadPolicyFile, loadPolicyFromString } from './policy/schema.js';
import { RiskStore, type AccountSnapshot, type ExecutionRecord } from './state/store.js';
import type { Decision, LedgerEntry, NormalizedAction, Policy, ProposedAction, RiskContext } from './types.js';

export interface AegisOptions {
  /** Path to a YAML/JSON policy file. */
  policyPath?: string;
  /** Pre-loaded policy, taking precedence over policyPath. */
  policy?: Policy;
  /** Directory for ledger.jsonl and state.json. */
  dataDir?: string;
  /** Injectable clock — the tests and the demo drive this. */
  clock?: () => number;
}

export function defaultDataDir(): string {
  return process.env['AEGIS_HOME'] ?? join(homedir(), '.aegis');
}

/** The shape returned to agents. Compact by design: agents pay for every token. */
export interface GuardResult {
  verdict: 'allow' | 'review' | 'deny';
  summary: string;
  actionId: string;
  notionalUsd: number;
  findings: Array<{ ruleId: string; verdict: string; severity: string; message: string; observed?: unknown; limit?: unknown }>;
  policy: string;
  mode: string;
  ledgerSeq: number;
  ledgerHash: string;
  /** The canonical action the engine actually judged. The gateway executes THIS. */
  normalized: NormalizedAction;
}

export class Aegis {
  readonly policy: Policy;
  readonly ledger: Ledger;
  readonly store: RiskStore;
  readonly dataDir: string;
  private readonly clock: () => number;

  constructor(options: AegisOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? defaultDataDir());
    this.clock = options.clock ?? (() => Date.now());

    if (options.policy) {
      this.policy = options.policy;
    } else if (options.policyPath) {
      this.policy = loadPolicyFile(options.policyPath);
    } else {
      const envPath = process.env['AEGIS_POLICY'];
      this.policy = envPath
        ? loadPolicyFile(envPath)
        : loadPolicyFromString(DEFAULT_POLICY_YAML);
    }

    this.ledger = new Ledger(join(this.dataDir, 'ledger.jsonl'));
    this.store = new RiskStore(join(this.dataDir, 'state.json'), this.ledger);
  }

  now(): number {
    return this.clock();
  }

  /** Current risk context. Exposed so the gateway can classify risk direction. */
  context(): RiskContext {
    return this.store.buildContext(this.now());
  }

  /**
   * Evaluate a proposed action and record the decision.
   *
   * This is the single entry point an agent must call before touching Binance.
   * It always writes to the ledger — including allows, because "what did the
   * firewall let through" is exactly the question an incident review asks.
   */
  guard(proposal: ProposedAction): GuardResult {
    const now = this.now();
    const ctx = this.store.buildContext(now);
    const decision: Decision = evaluate(proposal, this.policy, ctx);

    const entry = this.store.recordDecision({
      verdict: decision.verdict,
      rawVerdict: decision.rawVerdict,
      action: {
        id: decision.action.id,
        category: decision.action.category,
        venue: decision.action.venue,
        symbol: decision.action.symbol,
        notionalUsd: decision.action.notionalUsd,
      },
      findings: decision.findings.map((f) => ({
        ruleId: f.ruleId, verdict: f.verdict, severity: f.severity, message: f.message,
      })),
      policyName: this.policy.name,
    }, now);

    return {
      verdict: decision.verdict,
      summary: decision.summary,
      actionId: decision.action.id,
      notionalUsd: decision.action.notionalUsd,
      findings: decision.findings.map((f) => ({
        ruleId: f.ruleId,
        verdict: f.verdict,
        severity: f.severity,
        message: f.message,
        observed: f.observed ?? null,
        limit: f.limit ?? null,
      })),
      policy: this.policy.name,
      mode: this.policy.mode,
      ledgerSeq: entry.seq,
      ledgerHash: entry.hash,
      normalized: decision.action,
    };
  }

  /** Full decision object, for callers that want the normalized action too. */
  evaluateOnly(proposal: ProposedAction): Decision {
    return evaluate(proposal, this.policy, this.store.buildContext(this.now()));
  }

  /**
   * Evaluate against a context with specific fields overridden.
   *
   * Used by tests and by `aegis simulate` to reason about conditions that are
   * awkward to reproduce for real, such as a stale position snapshot.
   */
  evaluateWith(proposal: ProposedAction, overrides: Partial<RiskContext>): Decision {
    const ctx = { ...this.store.buildContext(this.now()), ...overrides };
    return evaluate(proposal, this.policy, ctx);
  }

  /**
   * Confirm an action actually executed. Rolling counters only move here — a
   * blocked or abandoned proposal must never consume the day's budget.
   */
  recordExecution(record: ExecutionRecord): LedgerEntry {
    return this.store.recordExecution(record, this.now());
  }

  updateAccount(snapshot: AccountSnapshot): void {
    this.store.updateAccount(snapshot);
  }

  /** Append a free-form audit note. Used by the gateway to record its own actions. */
  note(message: string, extra: Record<string, unknown> = {}): LedgerEntry {
    return this.store.note(message, this.now(), extra);
  }

  halt(reason: string): void {
    this.store.setKillSwitch(true, reason, this.now());
  }

  resume(resetPeak = false): void {
    this.store.setKillSwitch(false, 'resumed by operator', this.now());
    if (resetPeak) this.store.resetPeak();
  }

  verifyLedger(): VerifyResult {
    return this.ledger.verify();
  }

  /** Current risk posture — what `aegis status` and the MCP status tool render. */
  status(): Record<string, unknown> {
    const now = this.now();
    const ctx = this.store.buildContext(now);
    const openExposure = ctx.positions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0);
    const peak = ctx.counters.peakEquityUsd;
    const drawdownPct = peak > 0 ? ((peak - ctx.equityUsd) / peak) * 100 : 0;

    return {
      policy: this.policy.name,
      mode: this.policy.mode,
      killSwitch: ctx.killSwitch,
      killSwitchReason: this.store.killSwitchReason(),
      equityUsd: ctx.equityUsd,
      peakEquityUsd: peak,
      drawdownPct: Math.round(drawdownPct * 100) / 100,
      openPositions: ctx.positions.length,
      openExposureUsd: Math.round(openExposure * 100) / 100,
      dailyNotionalUsd: ctx.counters.dailyNotionalUsd,
      dailyRealizedPnlUsd: ctx.counters.dailyRealizedPnlUsd,
      ordersLastMinute: ctx.counters.ordersLastMinute,
      ordersLastHour: ctx.counters.ordersLastHour,
      ledgerEntries: this.ledger.size(),
      ledgerHead: this.ledger.head(),
      rulesActive: RULES.length,
      budgets: this.budgets(ctx.counters.dailyNotionalUsd, openExposure, ctx.counters.dailyRealizedPnlUsd),
    };
  }

  private budgets(dailyNotional: number, openExposure: number, dailyPnl: number): Record<string, unknown> {
    const l = this.policy.limits;
    const pct = (used: number, cap: number | null): number | null =>
      cap === null || cap === 0 ? null : Math.round((used / cap) * 10000) / 100;
    return {
      dailyNotional: { used: dailyNotional, cap: l.maxDailyNotionalUsd, usedPct: pct(dailyNotional, l.maxDailyNotionalUsd) },
      openExposure: { used: Math.round(openExposure * 100) / 100, cap: l.maxOpenNotionalUsd, usedPct: pct(openExposure, l.maxOpenNotionalUsd) },
      dailyLoss: { used: Math.max(0, -dailyPnl), cap: l.maxDailyLossUsd, usedPct: pct(Math.max(0, -dailyPnl), l.maxDailyLossUsd) },
    };
  }

  rules(): Array<{ id: string; about: string }> {
    return RULES.map((r) => ({ id: r.id, about: r.about }));
  }
}

/**
 * The built-in fallback policy.
 *
 * Chosen to be safe enough that running Aegis with no configuration at all is
 * still meaningfully protective: reads are free, trading is capped small and
 * every entry above $200 needs a human.
 */
export const DEFAULT_POLICY_YAML: string = [
  'version: 1',
  'name: aegis-default-conservative',
  'mode: enforce',
  'default: deny',
  'limits:',
  '  maxNotionalUsdPerOrder: 500',
  '  maxDailyNotionalUsd: 5000',
  '  maxOpenNotionalUsd: 2000',
  '  maxLeverage: 5',
  '  maxDailyLossUsd: 250',
  '  maxDrawdownPct: 15',
  '  maxOrdersPerMinute: 5',
  '  maxOrdersPerHour: 40',
  '  maxPositionsOpen: 5',
  // Running with no policy file must not silently disable a control that every
  // shipped policy file enables. A default that is weaker than the examples is
  // the one most people will actually run.
  '  maxPositionSnapshotAgeSec: 120',
  'allow:',
  '  categories: ["read", "trade", "cancel", "transfer"]',
  '  venues: ["spot", "futures-usds", "convert", "market-data", "wallet"]',
  'deny:',
  '  categories: ["withdraw"]',
  'guards:',
  '  priceDeviationPct: 10',
  '  minAccountEquityUsd: 20',
  '  requireStopLoss: true',
  '  maxStopDistancePct: 10',
  '  cooldownSecondsAfterLoss: 180',
  '  reviewAboveNotionalUsd: 200',
  '  blockDuplicateActionIds: true',
].join('\n');
