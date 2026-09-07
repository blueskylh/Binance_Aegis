/**
 * Tempo rules — how often, and when.
 *
 * A hallucinating or looping agent rarely places one catastrophic order; it
 * places two hundred small ones. Rate limits are the cheapest defence against
 * that failure mode, and the one most trading bots forget.
 */

import { isRiskReducing } from '../normalize.js';
import type { Finding, NormalizedAction, Policy, RiskContext } from '../../types.js';

/**
 * Rate limits govern *new* order flow.
 *
 * Reads, cancels and verified exits are exempt: a throttle that stops you
 * closing a position during a fast market is not a safety control, it is the
 * accident. Same invariant the loss breakers hold.
 */
function isRateLimited(action: NormalizedAction, ctx: RiskContext): boolean {
  return !isRiskReducing(action, ctx);
}

export function rateLimitMinuteRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxOrdersPerMinute;
  if (limit === null || !isRateLimited(action, ctx)) return [];
  if (ctx.counters.ordersLastMinute < limit) return [];
  return [{
    ruleId: 'rate-limit-minute',
    verdict: 'deny',
    severity: 'warn',
    message:
      `Rate limit hit: ${ctx.counters.ordersLastMinute} order(s) in the last 60s, cap is ${limit}/min. ` +
      'This is the runaway-loop brake.',
    observed: ctx.counters.ordersLastMinute,
    limit,
  }];
}

export function rateLimitHourRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const limit = policy.limits.maxOrdersPerHour;
  if (limit === null || !isRateLimited(action, ctx)) return [];
  if (ctx.counters.ordersLastHour < limit) return [];
  return [{
    ruleId: 'rate-limit-hour',
    verdict: 'deny',
    severity: 'warn',
    message: `Rate limit hit: ${ctx.counters.ordersLastHour} order(s) in the last hour, cap is ${limit}/h.`,
    observed: ctx.counters.ordersLastHour,
    limit,
  }];
}

/** Minutes since UTC midnight for an "HH:MM" string. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function tradingHoursRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const window = policy.guards.tradingHoursUtc;
  if (window === null || isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];

  const d = new Date(ctx.now);
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);

  // A window whose end is before its start wraps past midnight (e.g. 22:00–06:00).
  const inside = from <= to ? nowMin >= from && nowMin <= to : nowMin >= from || nowMin <= to;
  if (inside) return [];

  const clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return [{
    ruleId: 'trading-hours',
    verdict: 'deny',
    severity: 'warn',
    message: `It is ${clock} UTC, outside the permitted trading window ${window.from}–${window.to} UTC.`,
    observed: clock,
    limit: `${window.from}-${window.to}`,
  }];
}
