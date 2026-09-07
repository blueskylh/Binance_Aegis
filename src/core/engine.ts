/**
 * The Aegis policy engine.
 *
 * `evaluate` is a pure function: (proposal, policy, context) -> decision. It
 * performs no I/O, reads no clock, and mutates nothing it is given. Every
 * decision is therefore reproducible from the ledger — which is what makes the
 * audit trail worth anything.
 */

import { normalizeAction } from './normalize.js';
import { RULES } from './rules/index.js';
import type {
  Decision,
  Finding,
  NormalizedAction,
  Policy,
  ProposedAction,
  RiskContext,
  Verdict,
} from '../types.js';

const VERDICT_RANK: Record<Verdict, number> = { allow: 0, review: 1, deny: 2 };

/** Aggregate findings into a single verdict by taking the most restrictive. */
export function aggregate(findings: readonly Finding[]): Verdict {
  let worst: Verdict = 'allow';
  for (const f of findings) {
    if (VERDICT_RANK[f.verdict] > VERDICT_RANK[worst]) worst = f.verdict;
  }
  return worst;
}

/**
 * Apply the policy mode to a raw verdict.
 *
 * - `enforce`  — the verdict stands.
 * - `monitor`  — nothing is blocked outright; denies become reviews so a human
 *                sees them. Useful when rolling a new policy out over live flow.
 * - `simulate` — pure dry run: report everything, block nothing.
 *
 * The kill-switch is exempt. An operator halt that a config flag could soften
 * would not be a halt.
 */
function applyMode(raw: Verdict, policy: Policy, findings: readonly Finding[]): Verdict {
  const killed = findings.some((f) => f.ruleId === 'kill-switch' && f.verdict === 'deny');
  if (killed) return 'deny';
  if (policy.mode === 'enforce') return raw;
  if (policy.mode === 'monitor') return raw === 'deny' ? 'review' : raw;
  return 'allow'; // simulate
}

function summarize(verdict: Verdict, raw: Verdict, action: NormalizedAction, findings: readonly Finding[], policy: Policy): string {
  const label = action.symbol ?? action.asset ?? action.venue;
  const size = action.notionalUsd > 0 ? ` ($${Math.round(action.notionalUsd * 100) / 100})` : '';
  const head = `${action.category.toUpperCase()} ${label}${size}`;

  const blockers = findings.filter((f) => f.verdict === 'deny').map((f) => f.ruleId);
  const reviews = findings.filter((f) => f.verdict === 'review').map((f) => f.ruleId);

  if (verdict === 'allow' && raw === 'allow') {
    return `ALLOW — ${head} passed all ${RULES.length} checks under policy "${policy.name}".`;
  }
  if (verdict === 'allow' && raw !== 'allow') {
    return `ALLOW (simulate) — ${head} would have been ${raw.toUpperCase()}ED by: ${[...blockers, ...reviews].join(', ')}.`;
  }
  if (verdict === 'review') {
    const why = blockers.length > 0 ? [...blockers, ...reviews] : reviews;
    return `REVIEW — ${head} needs human confirmation: ${why.join(', ')}.`;
  }
  return `DENY — ${head} blocked by: ${blockers.join(', ')}.`;
}

/**
 * Evaluate a proposed action against a policy.
 *
 * Never throws. A malformed proposal is a denial with a `malformed-action`
 * finding, because an agent that crashes its own firewall must not end up in a
 * state where the next call proceeds unchecked.
 */
export function evaluate(proposal: ProposedAction, policy: Policy, ctx: RiskContext): Decision {
  let action: NormalizedAction;
  try {
    action = normalizeAction(proposal, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const findings: Finding[] = [{
      ruleId: 'malformed-action',
      verdict: 'deny',
      severity: 'critical',
      message: `Action rejected before evaluation: ${message}`,
      observed: 'invalid',
      limit: null,
    }];
    const fallback: NormalizedAction = {
      id: typeof proposal?.id === 'string' ? proposal.id : 'unparseable',
      ts: ctx.now,
      category: (proposal?.category ?? 'read') as NormalizedAction['category'],
      venue: (proposal?.venue ?? 'market-data') as NormalizedAction['venue'],
      symbol: proposal?.symbol ?? null,
      asset: proposal?.asset ?? null,
      side: null,
      orderType: null,
      quantity: null,
      price: null,
      leverage: null,
      reduceOnly: false,
      hasStopLoss: false,
      destination: null,
      notionalUsd: 0,
      notionalBasis: 'none',
      raw: proposal,
    };
    return {
      verdict: 'deny',
      rawVerdict: 'deny',
      action: fallback,
      findings,
      policy: { name: policy.name, mode: policy.mode, version: policy.version },
      summary: `DENY — malformed action rejected: ${message}`,
      evaluatedAt: ctx.now,
    };
  }

  const findings: Finding[] = [];
  for (const rule of RULES) {
    // A rule that throws must not take the firewall down with it: convert the
    // fault into a deny so the system degrades closed, never open.
    try {
      findings.push(...rule.fn(action, policy, ctx));
    } catch (err) {
      findings.push({
        ruleId: `${rule.id}:internal-error`,
        verdict: 'deny',
        severity: 'critical',
        message: `Rule "${rule.id}" failed to evaluate (${(err as Error).message}); failing closed.`,
        observed: 'error',
        limit: null,
      });
    }
  }

  const rawVerdict = aggregate(findings);
  const verdict = applyMode(rawVerdict, policy, findings);

  return {
    verdict,
    rawVerdict,
    action,
    findings,
    policy: { name: policy.name, mode: policy.mode, version: policy.version },
    summary: summarize(verdict, rawVerdict, action, findings, policy),
    evaluatedAt: ctx.now,
  };
}

export { RULES };
