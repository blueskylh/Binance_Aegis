/**
 * The rule registry.
 *
 * Order matters only for the readability of the findings list — the verdict is
 * order-independent because aggregation takes the worst outcome. Keeping the
 * registry explicit (rather than auto-discovered) means a rule can never be
 * silently dropped by a build change.
 */

import {
  allowlistRule,
  defaultPostureRule,
  denylistRule,
  killSwitchRule,
} from './access.js';
import {
  maxDailyNotionalRule,
  maxLeverageRule,
  maxNotionalPerOrderRule,
  maxOpenExposureRule,
  maxPositionsOpenRule,
  minEquityRule,
} from './size.js';
import { dailyLossLimitRule, lossCooldownRule, maxDrawdownRule } from './loss.js';
import { rateLimitHourRule, rateLimitMinuteRule, tradingHoursRule } from './tempo.js';
import {
  duplicateActionRule,
  priceDeviationRule,
  requireStopLossRule,
  reviewThresholdRule,
} from './integrity.js';
import type { Rule } from '../../types.js';

export interface RegisteredRule {
  id: string;
  /** Short description surfaced by `aegis rules`. */
  about: string;
  fn: Rule;
}

export const RULES: readonly RegisteredRule[] = Object.freeze([
  { id: 'kill-switch', about: 'Operator halt on all risk-increasing actions', fn: killSwitchRule },
  { id: 'denylist', about: 'Explicit category/venue/symbol denials', fn: denylistRule },
  { id: 'allowlist', about: 'Positive category/venue/symbol permissions', fn: allowlistRule },
  { id: 'default-posture', about: 'Fallback verdict when nothing matched', fn: defaultPostureRule },
  { id: 'duplicate-action', about: 'Replay and double-submit protection', fn: duplicateActionRule },
  { id: 'min-equity', about: 'Account equity floor', fn: minEquityRule },
  { id: 'max-notional-per-order', about: 'Per-order USD notional cap', fn: maxNotionalPerOrderRule },
  { id: 'max-daily-notional', about: 'Daily traded-notional budget', fn: maxDailyNotionalRule },
  { id: 'max-open-exposure', about: 'Aggregate open exposure cap', fn: maxOpenExposureRule },
  { id: 'max-positions-open', about: 'Concurrent position count cap', fn: maxPositionsOpenRule },
  { id: 'max-leverage', about: 'Leverage ceiling', fn: maxLeverageRule },
  { id: 'daily-loss-limit', about: 'Daily realized-loss circuit breaker', fn: dailyLossLimitRule },
  { id: 'max-drawdown', about: 'Peak-to-trough equity breaker', fn: maxDrawdownRule },
  { id: 'loss-cooldown', about: 'Anti revenge-trading cooldown', fn: lossCooldownRule },
  { id: 'rate-limit-minute', about: 'Orders-per-minute brake', fn: rateLimitMinuteRule },
  { id: 'rate-limit-hour', about: 'Orders-per-hour brake', fn: rateLimitHourRule },
  { id: 'trading-hours', about: 'Permitted UTC trading window', fn: tradingHoursRule },
  { id: 'price-deviation', about: 'Fat-finger / hallucinated-price guard', fn: priceDeviationRule },
  { id: 'require-stop-loss', about: 'Mandatory protective stop on leveraged entries', fn: requireStopLossRule },
  { id: 'review-threshold', about: 'Human-confirmation escalation threshold', fn: reviewThresholdRule },
]);
