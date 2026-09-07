/**
 * Size and exposure rules.
 *
 * Every limit here is evaluated *prospectively*: the question is never "how much
 * risk do we carry now" but "how much would we carry if this action executed".
 * Retrospective limits are how accounts blow through their own caps.
 */

import { isRiskReducing } from '../normalize.js';
import type { Finding, NormalizedAction, Policy, RiskContext } from '../../types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Per-order notional cap.
 *
 * Exempts verified exits. A per-order cap that blocks a $1,000 close because the
 * cap is $500 does not reduce risk — it strands the position. (Regression:
 * SEC-01.)
 */
export function maxNotionalPerOrderRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxNotionalUsdPerOrder;
  if (limit === null || action.notionalUsd === 0) return [];
  if (isRiskReducing(action, ctx)) return [];
  if (action.notionalUsd <= limit) return [];
  return [{
    ruleId: 'max-notional-per-order',
    verdict: 'deny',
    severity: 'critical',
    message: `Order notional $${round2(action.notionalUsd)} exceeds the per-order cap of $${limit}.`,
    observed: round2(action.notionalUsd),
    limit,
  }];
}

export function maxDailyNotionalRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxDailyNotionalUsd;
  if (limit === null || action.notionalUsd === 0) return [];
  // An exhausted turnover budget must not strand an open position either.
  if (isRiskReducing(action, ctx)) return [];
  const projected = ctx.counters.dailyNotionalUsd + action.notionalUsd;
  if (projected <= limit) return [];
  return [{
    ruleId: 'max-daily-notional',
    verdict: 'deny',
    severity: 'critical',
    message:
      `This order would take today's traded notional to $${round2(projected)}, ` +
      `over the daily budget of $${limit} (already used $${round2(ctx.counters.dailyNotionalUsd)}).`,
    observed: round2(projected),
    limit,
  }];
}

export function maxOpenExposureRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxOpenNotionalUsd;
  if (limit === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  const current = ctx.positions.reduce((sum, p) => sum + Math.abs(p.notionalUsd), 0);
  const projected = current + action.notionalUsd;
  if (projected <= limit) return [];
  return [{
    ruleId: 'max-open-exposure',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Open exposure would reach $${round2(projected)}, over the cap of $${limit} ` +
      `(currently $${round2(current)} across ${ctx.positions.length} position(s)).`,
    observed: round2(projected),
    limit,
  }];
}

export function maxLeverageRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxLeverage;
  if (limit === null || action.leverage === null) return [];
  if (isRiskReducing(action, ctx)) return [];
  if (action.leverage <= limit) return [];
  return [{
    ruleId: 'max-leverage',
    verdict: 'deny',
    severity: 'critical',
    message: `Requested leverage ${action.leverage}x exceeds the policy cap of ${limit}x.`,
    observed: action.leverage,
    limit,
  }];
}

export function maxPositionsOpenRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxPositionsOpen;
  if (limit === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  // Adding to a position you already hold does not widen diversification risk.
  const alreadyHeld = action.symbol !== null && ctx.positions.some((p) => p.symbol === action.symbol);
  if (alreadyHeld) return [];
  if (ctx.positions.length < limit) return [];
  return [{
    ruleId: 'max-positions-open',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Opening ${action.symbol ?? 'a new position'} would exceed the cap of ${limit} concurrent position(s); ` +
      `${ctx.positions.length} already open.`,
    observed: ctx.positions.length + 1,
    limit,
  }];
}

export function minEquityRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const floor = policy.guards.minAccountEquityUsd;
  if (floor === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  if (ctx.equityUsd >= floor) return [];
  return [{
    ruleId: 'min-equity',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Account equity $${round2(ctx.equityUsd)} is below the $${floor} floor; ` +
      'new risk is blocked until the account is topped up.',
    observed: round2(ctx.equityUsd),
    limit: floor,
  }];
}
