/**
 * Access rules — who may do what, where.
 *
 * These run before any sizing rule: an action on a forbidden venue should be
 * rejected on identity alone, without Aegis needing to understand its economics.
 */

import { isRiskReducing } from '../normalize.js';
import type { Finding, NormalizedAction, Policy, RiskContext } from '../../types.js';

/**
 * Operator kill-switch. Absolute, and deliberately asymmetric: it stops new risk
 * but never traps the agent inside a position, so cancels and reads still pass.
 */
export function killSwitchRule(action: NormalizedAction, _policy: Policy, ctx: RiskContext): Finding[] {
  if (!ctx.killSwitch) return [];
  if (action.category === 'read' || action.category === 'cancel') {
    return [{
      ruleId: 'kill-switch',
      verdict: 'allow',
      severity: 'info',
      message: 'Kill-switch is engaged, but read and cancel actions remain permitted so you can always flatten.',
      observed: 'engaged',
      limit: null,
    }];
  }
  return [{
    ruleId: 'kill-switch',
    verdict: 'deny',
    severity: 'critical',
    message: 'Kill-switch is engaged: all risk-increasing actions are halted. Disengage it with `aegis resume`.',
    observed: 'engaged',
    limit: null,
  }];
}

/** Explicit denylists always beat allowlists. */
export function denylistRule(action: NormalizedAction, policy: Policy): Finding[] {
  const findings: Finding[] = [];
  const { deny } = policy;

  if (deny.categories?.includes(action.category)) {
    findings.push({
      ruleId: 'category-denylist',
      verdict: 'deny',
      severity: 'critical',
      message: `Action category "${action.category}" is on the policy denylist.`,
      observed: action.category,
      limit: deny.categories.join(', '),
    });
  }
  if (deny.venues?.includes(action.venue)) {
    findings.push({
      ruleId: 'venue-denylist',
      verdict: 'deny',
      severity: 'critical',
      message: `Venue "${action.venue}" is on the policy denylist.`,
      observed: action.venue,
      limit: deny.venues.join(', '),
    });
  }
  if (action.symbol && deny.symbols?.includes(action.symbol)) {
    findings.push({
      ruleId: 'symbol-denylist',
      verdict: 'deny',
      severity: 'critical',
      message: `Symbol "${action.symbol}" is on the policy denylist.`,
      observed: action.symbol,
      limit: deny.symbols.join(', '),
    });
  }
  return findings;
}

/** True when the policy expresses any positive access constraint at all. */
export function hasAllowConstraints(policy: Policy): boolean {
  const { allow } = policy;
  return allow.categories !== null || allow.venues !== null || allow.symbols !== null;
}

/** Allowlists. Each configured dimension must match for the action to pass. */
export function allowlistRule(action: NormalizedAction, policy: Policy): Finding[] {
  const findings: Finding[] = [];
  const { allow } = policy;

  if (allow.categories !== null && !allow.categories.includes(action.category)) {
    findings.push({
      ruleId: 'category-allowlist',
      verdict: 'deny',
      severity: 'critical',
      message: `Action category "${action.category}" is not on the policy allowlist.`,
      observed: action.category,
      limit: allow.categories.join(', '),
    });
  }
  if (allow.venues !== null && !allow.venues.includes(action.venue)) {
    findings.push({
      ruleId: 'venue-allowlist',
      verdict: 'deny',
      severity: 'critical',
      message: `Venue "${action.venue}" is not on the policy allowlist.`,
      observed: action.venue,
      limit: allow.venues.join(', '),
    });
  }
  if (allow.symbols !== null && action.symbol !== null && !allow.symbols.includes(action.symbol)) {
    findings.push({
      ruleId: 'symbol-allowlist',
      verdict: 'deny',
      severity: 'critical',
      message: `Symbol "${action.symbol}" is not on the policy allowlist.`,
      observed: action.symbol,
      limit: allow.symbols.join(', '),
    });
  }
  return findings;
}

/** The fallback posture when no allowlist expressed an opinion. */
export function defaultPostureRule(action: NormalizedAction, policy: Policy): Finding[] {
  if (hasAllowConstraints(policy)) return [];
  if (policy.default === 'allow') return [];
  if (isRiskReducing(action) && action.category === 'cancel') return [];
  return [{
    ruleId: 'default-posture',
    verdict: 'deny',
    severity: 'critical',
    message:
      'Policy is deny-by-default and no allowlist matched this action. ' +
      'Add the category/venue to `allow:` to permit it.',
    observed: `${action.category}/${action.venue}`,
    limit: 'deny-by-default',
  }];
}
