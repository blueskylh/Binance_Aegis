/**
 * Order-integrity rules and human-in-the-loop escalation.
 *
 * These catch the failure modes specific to *LLM* traders rather than human
 * ones: a hallucinated price two orders of magnitude off, the same order
 * replayed after a retry, an entry opened with no exit plan.
 */

import { classifyRisk, isRiskReducing } from '../normalize.js';
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
/**
 * Protective-stop requirement.
 *
 * v2.0.0 accepted `hasStopLoss: true` on the agent's word, contradicting this
 * project's own stated philosophy that a claim is evidence, not proof. A
 * prompt-injected agent could assert the flag and open unprotected leverage.
 *
 * A price, unlike a boolean, can be checked — and in gateway mode it is actually
 * placed as a `STOP_MARKET reduceOnly` order once the entry fills.
 */
export function requireStopLossRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  if (!policy.guards.requireStopLoss) return [];
  if (isRiskReducing(action, ctx) || action.notionalUsd === 0) return [];
  if (!LEVERAGED_VENUES.has(action.venue)) return [];
  if (action.stopPrice !== null) return [];

  const claimedOnly = action.raw?.hasStopLoss === true;
  return [{
    ruleId: 'require-stop-loss',
    verdict: 'deny',
    severity: 'critical',
    message: claimedOnly
      ? `Policy requires a protective stop on ${action.venue} entries, and "hasStopLoss: true" is only a claim. ` +
        'Supply a concrete `stopPrice` — Aegis validates it and places it for you.'
      : `Policy requires a protective stop on ${action.venue} entries. Resubmit with a \`stopPrice\`.`,
    observed: claimedOnly ? 'unverifiable claim' : 'no stop supplied',
    limit: 'stopPrice required',
  }];
}

/**
 * Sanity-check the stop price itself.
 *
 * A stop on the wrong side of the entry is not protection — it is an instant
 * market order. A stop 90% away is not protection either.
 */
export function stopPriceSanityRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  if (action.stopPrice === null || action.side === null) return [];
  if (isRiskReducing(action, ctx)) return [];

  const reference = action.price ?? (action.symbol !== null ? ctx.marks[action.symbol] : undefined);
  if (typeof reference !== 'number' || !Number.isFinite(reference) || reference <= 0) return [];

  const deny = (message: string, observed: number | string): Finding[] => ([{
    ruleId: 'invalid-stop-price',
    verdict: 'deny',
    severity: 'critical',
    message,
    observed,
    limit: reference,
  }]);

  if (action.side === 'BUY' && action.stopPrice >= reference) {
    return deny(
      `Stop price ${action.stopPrice} is at or above the ${reference} entry on a long. ` +
      'That is not protection — it would trigger immediately.',
      action.stopPrice,
    );
  }
  if (action.side === 'SELL' && action.stopPrice <= reference) {
    return deny(
      `Stop price ${action.stopPrice} is at or below the ${reference} entry on a short. ` +
      'That is not protection — it would trigger immediately.',
      action.stopPrice,
    );
  }

  const distancePct = (Math.abs(reference - action.stopPrice) / reference) * 100;
  const maxDistance = policy.guards.maxStopDistancePct;
  if (maxDistance !== null && distancePct > maxDistance) {
    return deny(
      `Stop price ${action.stopPrice} sits ${round2(distancePct)}% from entry, beyond the ${maxDistance}% cap. ` +
      'A stop that far away is not a risk control.',
      round2(distancePct),
    );
  }
  return [];
}

/**
 * Reduce-only exemptions rest on the position snapshot. When that snapshot is
 * stale, the evidence is unreliable and the exemption is refused rather than
 * granted on a guess.
 */
export function snapshotFreshnessRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const maxAgeSec = policy.limits.maxPositionSnapshotAgeSec;
  if (maxAgeSec === null) return [];
  if (!action.reduceOnly && !action.closePosition) return [];
  const ageSec = ctx.snapshotAgeMs / 1000;
  if (ageSec <= maxAgeSec) return [];
  return [{
    ruleId: 'stale-position-data',
    verdict: 'deny',
    severity: 'critical',
    message:
      `This order claims to reduce risk, but the position snapshot is ${Math.round(ageSec)}s old ` +
      `(limit ${maxAgeSec}s). Aegis will not grant an exemption on stale evidence — run \`aegis sync\` ` +
      'or start the guardian, then resubmit.',
    observed: Math.round(ageSec),
    limit: maxAgeSec,
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
 * Unverifiable reduction claims.
 *
 * An agent that asserts `reduceOnly: true` is asking for every size limit to be
 * waived. When Aegis cannot match that claim to a real opposing position, the
 * claim is refused outright rather than silently downgraded — otherwise the flag
 * itself becomes the bypass. (Regression: SEC-04.)
 */
export function unverifiedReductionRule(action: NormalizedAction, _policy: Policy, ctx: RiskContext): Finding[] {
  if (!action.reduceOnly && !action.closePosition) return [];
  const direction = classifyRisk(action, ctx);
  if (direction.reducing) return [];
  return [{
    ruleId: 'unverified-reduce-only',
    verdict: 'deny',
    severity: 'critical',
    message:
      `This order claims to reduce risk, but that could not be verified: ${direction.reason}. ` +
      'Aegis refuses to grant limit exemptions on an unverified claim. ' +
      'Refresh positions with `aegis sync`, or resubmit without reduceOnly to be judged as a new entry.',
    observed: direction.reason,
    limit: direction.positionNotionalUsd,
  }];
}

/**
 * Human-in-the-loop escalation.
 *
 * Exits are never escalated. Waiting for a human to approve a close is how an
 * account bleeds out while everyone is asleep. (Regression: SEC-01.)
 */
export function reviewThresholdRule(action: NormalizedAction, policy: Policy, ctx: RiskContext): Finding[] {
  const threshold = policy.guards.reviewAboveNotionalUsd;
  if (threshold === null || action.notionalUsd === 0) return [];
  if (isRiskReducing(action, ctx)) return [];
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
