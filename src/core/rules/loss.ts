/**
 * Loss and drawdown circuit breakers.
 *
 * Design invariant: a breaker must never trap the agent inside a position. Every
 * rule here exempts risk-reducing actions, so an agent that has hit its daily
 * loss limit can still close, hedge or cancel — it just cannot open more risk.
 */

import { isRiskReducing } from '../normalize.js';
import type { Finding, NormalizedAction, Policy, RiskContext } from '../../types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function dailyLossLimitRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxDailyLossUsd;
  if (limit === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  const loss = -ctx.counters.dailyRealizedPnlUsd; // positive when we are down
  if (loss < limit) return [];
  return [{
    ruleId: 'daily-loss-limit',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Daily realized loss $${round2(loss)} has reached the $${limit} limit. ` +
      'New risk is halted for the rest of the UTC day; closing trades are still allowed.',
    observed: round2(loss),
    limit,
  }];
}

export function maxDrawdownRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxDrawdownPct;
  if (limit === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  const peak = ctx.counters.peakEquityUsd;
  if (peak <= 0) return [];
  const drawdownPct = ((peak - ctx.equityUsd) / peak) * 100;
  if (drawdownPct <= limit) return [];
  return [{
    ruleId: 'max-drawdown',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Equity is ${round2(drawdownPct)}% below its peak of $${round2(peak)}, past the ${limit}% drawdown breaker. ` +
      'Reset it deliberately with `aegis resume --reset-peak` once you have reviewed what happened.',
    observed: round2(drawdownPct),
    limit,
  }];
}

export function lossCooldownRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const seconds = policy.guards.cooldownSecondsAfterLoss;
  if (seconds === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  const lastLossAt = ctx.counters.lastLossAt;
  if (lastLossAt === null) return [];
  const elapsed = (ctx.now - lastLossAt) / 1000;
  if (elapsed >= seconds) return [];
  return [{
    ruleId: 'loss-cooldown',
    verdict: 'deny',
    severity: 'warn',
    message:
      `Cooling off after a realized loss: ${Math.ceil(seconds - elapsed)}s remaining of the ${seconds}s window. ` +
      'This is the guard against revenge-trading loops.',
    observed: Math.floor(elapsed),
    limit: seconds,
  }];
}
