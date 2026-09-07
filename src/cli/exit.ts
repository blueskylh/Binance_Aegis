/**
 * The CLI exit-code contract.
 *
 * `review` MUST be non-zero and distinct from both allow and deny. In v1.0.0 it
 * shared `0` with allow, which meant the documented one-liner
 *
 *     aegis check ... && binance-cli new-order ...
 *
 * silently executed exactly the orders a human was supposed to confirm — the
 * failure mode was worse than having no check at all, because it looked safe.
 *
 * Kept in its own module so the contract is testable and can never drift
 * between the CLI and its documentation.
 */
export const EXIT = {
  /** Allowed. Safe to proceed. */
  ALLOW: 0,
  /** Denied by policy. Do not proceed. */
  DENY: 1,
  /** Bad invocation — usage error, unparseable input, missing policy. */
  USAGE: 2,
  /** Allowed only after a human confirms. Non-zero on purpose. */
  REVIEW: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Map a verdict to its process exit code. */
export function exitCodeFor(verdict: 'allow' | 'review' | 'deny'): ExitCode {
  if (verdict === 'allow') return EXIT.ALLOW;
  if (verdict === 'review') return EXIT.REVIEW;
  return EXIT.DENY;
}
