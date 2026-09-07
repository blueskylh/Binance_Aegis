/**
 * Portfolio-level circuit breakers.
 *
 * The policy engine judges one action at a time. These breakers judge the whole
 * account, on a timer — which is how you catch the risk that arrives without any
 * agent action at all: a position moving against you while the agent sits idle.
 *
 * Pure function, no I/O, so the daemon's decision logic is testable without a
 * network or a clock.
 */

import type { Policy } from '../types.js';

export interface GuardianSnapshot {
  equityUsd: number;
  peakEquityUsd: number;
  openExposureUsd: number;
  dailyRealizedPnlUsd: number;
  openPositions: number;
  killSwitch: boolean;
}

export interface Breach {
  id: 'drawdown' | 'daily-loss' | 'open-exposure' | 'min-equity';
  observed: number;
  limit: number;
  reason: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Return every breached breaker.
 *
 * Edge-triggered: once the kill-switch is engaged we report nothing, so the
 * daemon halts once and then stays quiet instead of spamming the ledger every
 * poll while the account sits below its limit.
 */
export function assessBreakers(snapshot: GuardianSnapshot, policy: Policy): Breach[] {
  if (snapshot.killSwitch) return [];
  const breaches: Breach[] = [];

  const ddLimit = policy.limits.maxDrawdownPct;
  if (ddLimit !== null && snapshot.peakEquityUsd > 0) {
    const dd = ((snapshot.peakEquityUsd - snapshot.equityUsd) / snapshot.peakEquityUsd) * 100;
    if (dd > ddLimit) {
      breaches.push({
        id: 'drawdown',
        observed: round2(dd),
        limit: ddLimit,
        reason:
          `Equity drawdown ${round2(dd)}% exceeds the ${ddLimit}% breaker ` +
          `(peak $${round2(snapshot.peakEquityUsd)} → now $${round2(snapshot.equityUsd)}).`,
      });
    }
  }

  const lossLimit = policy.limits.maxDailyLossUsd;
  if (lossLimit !== null) {
    const loss = -snapshot.dailyRealizedPnlUsd;
    if (loss >= lossLimit) {
      breaches.push({
        id: 'daily-loss',
        observed: round2(loss),
        limit: lossLimit,
        reason: `Daily realized loss $${round2(loss)} has reached the $${lossLimit} circuit breaker.`,
      });
    }
  }

  const expLimit = policy.limits.maxOpenNotionalUsd;
  if (expLimit !== null && snapshot.openExposureUsd > expLimit) {
    breaches.push({
      id: 'open-exposure',
      observed: round2(snapshot.openExposureUsd),
      limit: expLimit,
      reason:
        `Open exposure $${round2(snapshot.openExposureUsd)} exceeds the $${expLimit} cap across ` +
        `${snapshot.openPositions} position(s) — the market moved the book past its limit.`,
    });
  }

  const floor = policy.guards.minAccountEquityUsd;
  if (floor !== null && snapshot.equityUsd < floor) {
    breaches.push({
      id: 'min-equity',
      observed: round2(snapshot.equityUsd),
      limit: floor,
      reason: `Account equity $${round2(snapshot.equityUsd)} has fallen below the $${floor} floor.`,
    });
  }

  return breaches;
}
