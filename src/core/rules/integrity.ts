/**
 * Order-integrity rules and human-in-the-loop escalation.
 *
 * These catch the failure modes specific to *LLM* traders rather than human
 * ones: a hallucinated price two orders of magnitude off, the same order
 * replayed after a retry, an entry opened with no exit plan.
 */

import { isRiskReducing } from '../normalize.js';
import type { Finding, NormalizedAction, Policy, RiskContext } from '../../types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Venues where an unprotected entry can be liquidated. */
const LEVERAGED_VENUES = new Set(['futures-usds', 'futures-coin', 'margin']);

/** Fat-finger / hallucinated-price guard. */
export function priceDeviationRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const tolerance = policy.guards.priceDeviationPct;
  if (tolerance === null || action.price === null || action.symbol === null) return [];
  const mark = ctx.marks[action.symbol];
  if (typeof mark !== 'number' || !Number.isFinite(mark) || mark <= 0) return [];

  const deviation = (Math.abs(action.price - mark) / mark) * 100;
  if (deviation <= tolerance) return [];
  return [{
    ruleId: 'price-deviation',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Limit price ${action.price} is ${round2(deviation)}% away from the ${action.symbol} mark of ${mark}, ` +
      `beyond the ${tolerance}% fat-finger tolerance. This usually means a hallucinated or stale price.`,
    observed: round2(deviation),
    limit: tolerance,
  }];
}

/** Never open leveraged risk without a declared exit. */
export function requireStopLossRule(action: NormalizedAction, policy: Policy): Finding[] {
  if (!policy.guards.requireStopLoss) return [];
  if (isRiskReducing(action) || action.notionalUsd === 0) return [];
  if (!LEVERAGED_VENUES.has(action.venue)) return [];
  if (action.hasStopLoss) return [];
  return [{
    ruleId: 'require-stop-loss',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Policy requires a protective stop on ${action.venue} entries. ` +
      'Attach one and resubmit with `hasStopLoss: true`.',
    observed: 'no stop attached',
    limit: 'stop required',
  }];
}

/** Replay / double-submit guard. Retries are normal for agents; duplicates are not. */
export function duplicateActionRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  if (!policy.guards.blockDuplicateActionIds) return [];
  if (action.category === 'read') return [];
  if (!ctx.recentActionIds.includes(action.id)) return [];
  return [{
    ruleId: 'duplicate-action',
    verdict: 'deny',
    severity: 'critical',
    message:
      `Action id "${action.id}" has already been processed. ` +
      'Blocking the replay — issue a fresh id if this is genuinely a new order.',
    observed: action.id,
    limit: 'unique ids required',
  }];
}

/**
 * Human-in-the-loop escalation. This is the rule that turns Aegis from a blunt
 * blocker into a workflow: below the line the agent is autonomous, above it a
 * person confirms.
 */
export function reviewThresholdRule(action: NormalizedAction, policy: Policy): Finding[] {
  const threshold = policy.guards.reviewAboveNotionalUsd;
  if (threshold === null || action.notionalUsd === 0) return [];
  if (isRiskReducing(action)) return [];
  if (action.notionalUsd <= threshold) return [];
  return [{
    ruleId: 'review-threshold',
    verdict: 'review',
    severity: 'warn',
    message:
      `Notional $${round2(action.notionalUsd)} is above the $${threshold} autonomy threshold. ` +
      'A human must confirm before this executes.',
    observed: round2(action.notionalUsd),
    limit: threshold,
  }];
}
