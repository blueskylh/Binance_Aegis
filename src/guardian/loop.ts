/**
 * The guardian daemon.
 *
 * Polls Binance through the Agent OS CLI, refreshes the risk snapshot and trips
 * the kill-switch when a portfolio-level breaker fires. This is the half of
 * Aegis that works while the agent is asleep.
 *
 * It is deliberately conservative about what it *does*: it halts and (optionally)
 * cancels resting orders. It never closes a position, because deciding when to
 * realize a loss is a human's call, not a daemon's.
 */

import { Aegis } from '../aegis.js';
import { BinanceAdapter } from '../adapters/binance.js';
import { assessBreakers, type GuardianSnapshot } from './breakers.js';

export interface GuardianOptions {
  aegis: Aegis;
  adapter: BinanceAdapter;
  /** Symbols to keep marks fresh for. */
  watch: string[];
  intervalMs: number;
  /** When true, log what would happen without engaging the kill-switch. */
  dryRun: boolean;
  /** Also cancel resting orders on the watched symbols when a breaker trips. */
  cancelOnBreach: boolean;
  log?: (line: string) => void;
}

export interface CycleResult {
  ts: number;
  snapshot: GuardianSnapshot;
  breaches: string[];
  halted: boolean;
  degraded: boolean;
}

export class Guardian {
  private readonly opts: GuardianOptions;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: GuardianOptions) {
    this.opts = options;
    this.log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  }

  /** One poll → assess → act cycle. Exposed so it can be driven from a test or a cron. */
  async cycle(): Promise<CycleResult> {
    const { aegis, adapter, watch } = this.opts;
    const ts = aegis.now();
    let degraded = false;

    try {
      const [equityUsd, positions, marks] = await Promise.all([
        adapter.equityUsd(),
        adapter.positions(),
        adapter.marks(watch),
      ]);
      // Only overwrite the snapshot when the read looks real. A transient CLI
      // failure returning 0 equity would otherwise fake a 100% drawdown and trip
      // every breaker at once — the classic monitoring own-goal.
      if (equityUsd > 0 || positions.length > 0 || Object.keys(marks).length > 0) {
        aegis.updateAccount({ equityUsd, positions, marks });
      } else {
        degraded = true;
      }
    } catch (err) {
      degraded = true;
      this.log(`[guardian] account refresh failed, holding last snapshot: ${(err as Error).message}`);
    }

    const status = aegis.status();
    const snapshot: GuardianSnapshot = {
      equityUsd: Number(status['equityUsd']),
      peakEquityUsd: Number(status['peakEquityUsd']),
      openExposureUsd: Number(status['openExposureUsd']),
      dailyRealizedPnlUsd: Number(status['dailyRealizedPnlUsd']),
      openPositions: Number(status['openPositions']),
      killSwitch: Boolean(status['killSwitch']),
    };

    // Never trip a breaker on data we could not refresh.
    const breaches = degraded ? [] : assessBreakers(snapshot, aegis.policy);
    let halted = false;

    if (breaches.length > 0) {
      const reason = breaches.map((b) => b.reason).join(' | ');
      if (this.opts.dryRun) {
        this.log(`[guardian] DRY-RUN would halt: ${reason}`);
      } else {
        aegis.halt(reason);
        halted = true;
        this.log(`[guardian] 🛑 KILL-SWITCH ENGAGED: ${reason}`);
        if (this.opts.cancelOnBreach) await this.cancelResting();
      }
    } else {
      const marker = degraded ? '~' : '·';
      this.log(
        `[guardian] ${marker} equity $${snapshot.equityUsd} | exposure $${snapshot.openExposureUsd} | ` +
        `day PnL $${snapshot.dailyRealizedPnlUsd} | positions ${snapshot.openPositions} | ` +
        `halt ${snapshot.killSwitch ? 'ON' : 'off'}`,
      );
    }

    return { ts, snapshot, breaches: breaches.map((b) => b.id), halted, degraded };
  }

  private async cancelResting(): Promise<void> {
    for (const symbol of this.opts.watch) {
      for (const venue of ['spot', 'futures-usds'] as const) {
        try {
          const res = await this.opts.adapter.cancelAllOpenOrders(symbol, venue);
          this.log(`[guardian] cancel ${venue} ${symbol}: ${res.ok ? 'ok' : `failed (${res.error ?? 'unknown'})`}`);
        } catch (err) {
          this.log(`[guardian] cancel ${venue} ${symbol} threw: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Run cycles forever. Each cycle is isolated: one failure never kills the loop. */
  async start(): Promise<void> {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.cycle();
      } catch (err) {
        this.log(`[guardian] cycle error (continuing): ${(err as Error).message}`);
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => { void tick(); }, this.opts.intervalMs);
        this.timer.unref?.();
      }
    };
    await tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
