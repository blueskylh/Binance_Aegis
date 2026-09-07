/**
 * Risk state.
 *
 * Two stores with different jobs:
 *
 *  - The **ledger** is the source of truth for anything historical. Every
 *    rolling counter the engine consults — daily notional, realized PnL, order
 *    tempo, replay ids — is *derived* from ledger entries, never incremented in
 *    place. Counters that drift are counters that lie, and a limit computed from
 *    a lying counter is not a limit.
 *
 *  - The **state file** holds only the latest account snapshot, the equity
 *    high-water mark and the kill-switch. Small, and safe to lose: everything
 *    except the peak can be re-fetched from Binance.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ledger } from '../ledger/ledger.js';
import type { LedgerEntry, PositionSnapshot, RiskContext, RollingCounters } from '../types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Cap on ids kept for the replay guard — bounded memory, generous window. */
const RECENT_ID_LIMIT = 500;

export interface AccountSnapshot {
  equityUsd: number;
  positions: PositionSnapshot[];
  marks: Record<string, number>;
}

export interface ExecutionRecord {
  actionId: string;
  category: string;
  venue: string;
  symbol: string | null;
  notionalUsd: number;
  realizedPnlUsd: number;
  meta?: Record<string, unknown>;
}

export interface DecisionRecord {
  verdict: string;
  rawVerdict: string;
  action: { id: string; category: string; venue: string; symbol: string | null; notionalUsd: number };
  findings: Array<{ ruleId: string; verdict: string; severity: string; message: string }>;
  policyName: string;
}

interface PersistedState {
  version: 1;
  equityUsd: number;
  peakEquityUsd: number;
  positions: PositionSnapshot[];
  marks: Record<string, number>;
  killSwitch: boolean;
  killSwitchReason: string | null;
  updatedAt: number;
}

const EMPTY_STATE: PersistedState = {
  version: 1,
  equityUsd: 0,
  peakEquityUsd: 0,
  positions: [],
  marks: {},
  killSwitch: false,
  killSwitchReason: null,
  updatedAt: 0,
};

/** Midnight UTC for the day containing `ts`. */
export function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export class RiskStore {
  private readonly path: string;
  private readonly ledger: Ledger;
  private state: PersistedState;

  constructor(path: string, ledger: Ledger) {
    this.path = path;
    this.ledger = ledger;
    mkdirSync(dirname(path), { recursive: true });
    this.state = this.load();
  }

  private load(): PersistedState {
    if (!existsSync(this.path)) return { ...EMPTY_STATE };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedState>;
      return {
        ...EMPTY_STATE,
        ...parsed,
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
        marks: parsed.marks && typeof parsed.marks === 'object' ? parsed.marks : {},
      };
    } catch {
      // A corrupt state file must not brick the firewall. Fall back to the safe
      // zeroed state — the ledger still holds the authoritative history.
      return { ...EMPTY_STATE };
    }
  }

  /** Atomic write: temp file + rename, so a crash never leaves a half-written state. */
  private persist(): void {
    const tmp = join(dirname(this.path), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  updateAccount(snapshot: AccountSnapshot): void {
    this.state.equityUsd = snapshot.equityUsd;
    this.state.positions = snapshot.positions;
    this.state.marks = { ...this.state.marks, ...snapshot.marks };
    if (snapshot.equityUsd > this.state.peakEquityUsd) {
      this.state.peakEquityUsd = snapshot.equityUsd;
    }
    this.state.updatedAt = Date.now();
    this.persist();
  }

  /** Deliberately re-baseline the drawdown breaker after a reviewed loss. */
  resetPeak(): void {
    this.state.peakEquityUsd = this.state.equityUsd;
    this.persist();
  }

  setKillSwitch(engaged: boolean, reason: string, ts: number): void {
    this.state.killSwitch = engaged;
    this.state.killSwitchReason = engaged ? reason : null;
    this.persist();
    this.ledger.append('breaker', { engaged, reason }, ts);
  }

  isKillSwitchEngaged(): boolean {
    return this.state.killSwitch;
  }

  killSwitchReason(): string | null {
    return this.state.killSwitchReason;
  }

  recordDecision(record: DecisionRecord, ts: number): LedgerEntry {
    return this.ledger.append('decision', record as unknown as Record<string, unknown>, ts);
  }

  recordExecution(record: ExecutionRecord, ts: number): LedgerEntry {
    return this.ledger.append('execution', record as unknown as Record<string, unknown>, ts);
  }

  note(message: string, ts: number, extra: Record<string, unknown> = {}): LedgerEntry {
    return this.ledger.append('note', { message, ...extra }, ts);
  }

  /** Recompute every rolling counter from ledger executions. */
  private counters(now: number): RollingCounters {
    const dayStart = utcDayStart(now);
    let dailyNotionalUsd = 0;
    let dailyRealizedPnlUsd = 0;
    let ordersLastMinute = 0;
    let ordersLastHour = 0;
    let lastLossAt: number | null = null;

    for (const entry of this.ledger.byType('execution')) {
      const payload = entry.payload as unknown as ExecutionRecord;
      const notional = Number(payload.notionalUsd) || 0;
      const pnl = Number(payload.realizedPnlUsd) || 0;

      if (entry.ts >= dayStart && entry.ts <= now) {
        dailyNotionalUsd += Math.abs(notional);
        dailyRealizedPnlUsd += pnl;
      }
      if (entry.ts > now - MINUTE_MS && entry.ts <= now) ordersLastMinute += 1;
      if (entry.ts > now - HOUR_MS && entry.ts <= now) ordersLastHour += 1;
      if (pnl < 0 && entry.ts <= now && (lastLossAt === null || entry.ts > lastLossAt)) {
        lastLossAt = entry.ts;
      }
    }

    return {
      dailyNotionalUsd: Math.round(dailyNotionalUsd * 1e8) / 1e8,
      dailyRealizedPnlUsd: Math.round(dailyRealizedPnlUsd * 1e8) / 1e8,
      ordersLastMinute,
      ordersLastHour,
      lastLossAt,
      peakEquityUsd: this.state.peakEquityUsd,
    };
  }

  private recentIds(): string[] {
    const ids: string[] = [];
    const entries = this.ledger.all();
    for (let i = entries.length - 1; i >= 0 && ids.length < RECENT_ID_LIMIT; i -= 1) {
      const e = entries[i] as LedgerEntry;
      if (e.type !== 'execution') continue;
      const id = (e.payload as unknown as ExecutionRecord).actionId;
      if (typeof id === 'string') ids.push(id);
    }
    return ids;
  }

  /** Assemble the immutable context the engine evaluates against. */
  buildContext(now: number): RiskContext {
    // A snapshot that was never taken is infinitely stale, not fresh.
    const snapshotAgeMs = this.state.updatedAt > 0
      ? Math.max(0, now - this.state.updatedAt)
      : Number.MAX_SAFE_INTEGER;
    return {
      now,
      snapshotAgeMs,
      equityUsd: this.state.equityUsd,
      positions: this.state.positions.map((p) => ({ ...p })),
      marks: { ...this.state.marks },
      counters: this.counters(now),
      recentActionIds: this.recentIds(),
      killSwitch: this.state.killSwitch,
    };
  }

  snapshot(): Readonly<PersistedState> {
    return { ...this.state };
  }
}
