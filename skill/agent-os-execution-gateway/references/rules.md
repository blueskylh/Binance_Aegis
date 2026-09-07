# Rule reference

The complete set of checks `aegis check` / `aegis_guard_action` runs. Every rule is a pure
function of `(action, policy, context)`; verdicts aggregate by taking the most restrictive
(`deny` > `review` > `allow`).

Columns: **Policy key** is what you set to activate the rule. **Exempt** lists actions the rule
never blocks.

---

## Access

| Rule | Policy key | Verdict | Exempt | Notes |
|---|---|---|---|---|
| `kill-switch` | *(operator, via `aegis halt`)* | deny | `read`, `cancel` | Absolute — not softened by `mode` |
| `category-denylist` | `deny.categories` | deny | — | Denylists beat allowlists |
| `venue-denylist` | `deny.venues` | deny | — | |
| `symbol-denylist` | `deny.symbols` | deny | — | |
| `category-allowlist` | `allow.categories` | deny | — | Only applies when the key is set |
| `venue-allowlist` | `allow.venues` | deny | — | |
| `symbol-allowlist` | `allow.symbols` | deny | — | Case-insensitive |
| `default-posture` | `default: deny` | deny | `cancel` | Fires only when no allowlist is configured at all |

## Size and exposure

| Rule | Policy key | Verdict | Exempt |
|---|---|---|---|
| `max-notional-per-order` | `limits.maxNotionalUsdPerOrder` | deny | zero-notional actions |
| `max-daily-notional` | `limits.maxDailyNotionalUsd` | deny | zero-notional actions |
| `max-open-exposure` | `limits.maxOpenNotionalUsd` | deny | risk-reducing |
| `max-positions-open` | `limits.maxPositionsOpen` | deny | risk-reducing, adds to an existing position |
| `max-leverage` | `limits.maxLeverage` | deny | actions with no leverage field |
| `min-equity` | `guards.minAccountEquityUsd` | deny | risk-reducing |

All size limits are **prospective**: they ask what exposure *would be* after the action, not what
it is now.

## Loss and drawdown

| Rule | Policy key | Verdict | Exempt |
|---|---|---|---|
| `daily-loss-limit` | `limits.maxDailyLossUsd` | deny | risk-reducing |
| `max-drawdown` | `limits.maxDrawdownPct` | deny | risk-reducing, `peakEquity == 0` |
| `loss-cooldown` | `guards.cooldownSecondsAfterLoss` | deny | risk-reducing |

## Tempo

| Rule | Policy key | Verdict | Exempt |
|---|---|---|---|
| `rate-limit-minute` | `limits.maxOrdersPerMinute` | deny | risk-reducing |
| `rate-limit-hour` | `limits.maxOrdersPerHour` | deny | risk-reducing |
| `trading-hours` | `guards.tradingHoursUtc` | deny | risk-reducing |

`tradingHoursUtc` supports windows that wrap past midnight (`from: "22:00", to: "06:00"`).

## Integrity

| Rule | Policy key | Verdict | Exempt |
|---|---|---|---|
| `price-deviation` | `guards.priceDeviationPct` | deny | actions with no `price`, or no mark for the symbol |
| `require-stop-loss` | `guards.requireStopLoss` | deny | risk-reducing, non-leveraged venues |
| `duplicate-action` | `guards.blockDuplicateActionIds` | deny | `read` |

## Human-in-the-loop

| Rule | Policy key | Verdict | Exempt |
|---|---|---|---|
| `review-threshold` | `guards.reviewAboveNotionalUsd` | **review** | risk-reducing, zero-notional |

## Internal

| Rule | Trigger | Verdict |
|---|---|---|
| `malformed-action` | The action could not be normalized or sized | deny |
| `<rule-id>:internal-error` | A rule threw during evaluation | deny |

---

## `isRiskReducing` — the exemption predicate

An action is risk-reducing when **any** of these hold:

- `category` is `read` or `cancel`
- `reduceOnly === true`
- `orderType` is `STOP_MARKET` or `TAKE_PROFIT_MARKET`

Risk-reducing actions are exempt from every breaker. This is invariant #1: a risk system that
traps you in a position *is* the risk.

## Notional derivation

Rules compare against one USD number, derived in this precedence order:

1. `quoteQuantity` → used directly *(prefer this — unambiguous)*
2. `quantity × price` → for limit orders
3. `quantity × mark[symbol]` → for market orders
4. asset amount × mark → for transfers; stablecoins valued at par

If none apply, the action is **denied** with `malformed-action` rather than sized by guesswork.
