---
name: agent-os-execution-gateway
description: |
  Use for EVERY Binance action that places an order, moves funds, or changes exposure — spot/futures orders,
  cancels, leverage changes. In gateway mode this skill is the ONLY path to Binance: it evaluates the action
  against a declarative risk policy (notional caps, daily loss limits, leverage ceilings, rate limits, drawdown
  breakers, fat-finger guards, allowlists), executes it if allowed, and settles the risk counters from the real
  fill. Also use for: "am I allowed to", "check this trade", "how much budget do I have left", "risk limits",
  "stop the agent", "emergency stop", "kill switch", "audit log", "what did my agent do", "verify the audit
  trail", "why was this blocked", "approve that trade", "what's waiting for approval", "position limits",
  "guardrails", "risk policy", "风控", "限额", "紧急停止", "审计", "审批".
metadata:
  version: 2.2.0
  author: aegis
  openclaw:
    requires:
      bins:
        - node
        - aegis
license: MIT
---

# Aegis — Agent OS Execution Gateway

Aegis is the **authorization and execution layer** for Binance Agent OS.

> **The agent proposes. Aegis decides. Binance executes.**

It is deterministic — no LLM sits in the enforcement path — and every decision is hash-chained
into a tamper-evident audit ledger.

---

## Two modes. Know which one you are in.

| | **Gateway mode** (preferred) | Advisory mode |
|---|---|---|
| You call | `aegis execute` | `aegis check` → your own Binance tool → `aegis record` |
| Who reaches Binance | **Aegis only** | You do |
| Can you bypass it | **No** — you hold no Binance credentials | Yes |
| Counters settle from | The real fill Aegis read back | Whatever you report |

**If `aegis capabilities` responds, you are in gateway mode. Use `aegis execute`.**
Only fall back to `check`/`record` if you genuinely hold a separate Binance write tool.

---

## The loop

```
                    ┌────────────────────────┐
   agent decides →  │  aegis execute <action>│
                    └───────────┬────────────┘
        allow ──────────────────┼──────────────── deny
          │              pending-approval           │
          ▼                     ▼                   ▼
   order placed by       human approves      nothing sent;
   Aegis; counters       via `aegis approve` relay the reason
   settle from the       then it executes
   real fill
```

---

## Commands

Append `--json` whenever you need to parse the result.

### 1. `aegis execute` — the only way to trade

```bash
aegis execute --json --live \
  --category trade --venue spot --symbol BTCUSDT \
  --side BUY --orderType MARKET --quoteQuantity 250
```

Without `--live` it is a dry run. **Always pass `--live` when the user has asked you to trade.**

**Parameters**

| Field | Required | Notes |
|---|---|---|
| `category` | ✅ | `read`, `trade`, `cancel` |
| `venue` | ✅ | `spot`, `futures-usds`, `market-data` |
| `symbol` | trades | e.g. `BTCUSDT` |
| `side` | trades | `BUY`, `SELL` |
| `orderType` | | `MARKET`, `LIMIT`, `STOP_MARKET`, `TAKE_PROFIT_MARKET` |
| `quantity` | one of | base-asset amount |
| `quoteQuantity` | one of | quote notional — **prefer this, it is unambiguous** |
| `price` | `LIMIT` | limit price |
| `stopPrice` | leveraged entries | protective stop. **Validated and actually placed** |
| `leverage` | derivatives | integer |
| `reduceOnly` | closes | verified against your real positions |
| `closePosition` | closes | flattens the whole position |
| `id` | | idempotency key. **Reuse it on retry — Aegis dedupes** |

**Response `status`**

| Status | Meaning | What you do |
|---|---|---|
| `executed` | Filled. Counters settled from the real fill | Report the fill |
| `accepted-unfilled` | Resting at the venue, **no exposure yet** | Say it is resting; do not claim a fill |
| `pending-approval` | Parked. **Nothing was sent** | Show the findings, give the ticket id, wait |
| `blocked` | Policy refused. **Nothing was sent** | Relay the reason verbatim. Do not retry smaller unless asked |
| `failed` | Aegis allowed it; the venue rejected it | Report the venue error |

### 2. `aegis approve` / `aegis pending` — the human loop

```bash
aegis pending --json                        # what is waiting
aegis approve tkt-1a2b3c4d --live           # redeem it
aegis reject  tkt-1a2b3c4d "changed my mind"
```

Tickets are **single-use**, expire in an hour, are bound to a digest of the exact action shown,
and are **re-evaluated at redemption** — a kill-switch pulled in the meantime still wins.

> ⚠️ Never call `approve` on your own initiative. Only after the human explicitly says yes
> **to that ticket**.

### 3. Situational awareness

```bash
aegis status --json          # equity, drawdown, exposure, budget consumption, kill-switch
aegis capabilities --json    # what the gateway can actually execute
aegis policy show --json     # active limits and guards
aegis sync --json            # refresh positions from Binance before reasoning about exits
aegis doctor                 # prove the binance-cli integration works
```

### 4. Safety controls

```bash
aegis halt "user asked to stop"
aegis resume                 # ONLY on explicit human request
```

The kill-switch is asymmetric: reads, cancels and **verified exits still work**, so a position can
always be closed.

### 5. Audit

```bash
aegis ledger verify --json   # ok:false names the exact tampered sequence number
aegis ledger tail 50
```

### 6. Advisory fallback only

```bash
aegis check --json <action>   # exit 0 allow · 1 deny · 2 usage · 3 REVIEW
aegis record --json --actionId <id> --notionalUsd <real> --realizedPnlUsd <real>
```

**Exit code `3` (review) is non-zero on purpose**, so `aegis check … && binance-cli …` stops there.
Never treat a review as an allow.

---

## Rules you must follow

1. **Never execute a Binance action outside `aegis execute`.** In gateway mode there is no other path;
   do not go looking for one.
2. **`blocked` is final.** Relay the `message` verbatim. Do not shrink the order to slip under a limit
   unless the user explicitly asks you to resize.
3. **`pending-approval` is a hard stop.** Show the findings and the ticket id. Silence is not approval.
4. **`accepted-unfilled` is not a fill.** Do not tell the user they bought something.
5. **Reuse the same `id` when retrying.** Aegis refuses concurrent duplicates; a fresh id on a timeout
   retry is how you end up with two positions.
6. **Prefer `quoteQuantity`.** For derivatives Aegis converts it to the exact quantity it will send,
   using the mark — so what is judged is what is sent.
7. **Supply a real `stopPrice`, not `hasStopLoss: true`.** The boolean is no longer accepted; the price
   is validated and the stop is actually placed.
8. **Run `aegis sync` before reasoning about closes** if the session has been idle. Reduce-only
   verification needs fresh positions.
9. **Never edit `ledger.jsonl` or `approvals.json`.**
10. **On `halt`, stop immediately** and tell the user what remains open.

## Interpreting findings

| Rule | What tripped | Usual fix |
|---|---|---|
| `max-notional-per-order` | Single clip too large | Split, or ask the user to raise the cap |
| `max-daily-notional` | Day's turnover spent | Wait for UTC rollover |
| `max-open-exposure` | Aggregate exposure cap | Close something first |
| `max-leverage` | Above the ceiling | Lower leverage |
| `daily-loss-limit` | Realized-loss breaker | **Stop for the day.** Closes still allowed |
| `max-drawdown` | Peak-to-trough breaker | Needs a deliberate human reset |
| `loss-cooldown` | Too soon after a loss | Wait it out — anti revenge-trading |
| `rate-limit-minute/hour` | Firing too fast | Slow down; likely a loop |
| `price-deviation` | Limit price far from mark | **Re-fetch the price — your context is stale** |
| `require-stop-loss` | Leveraged entry with no `stopPrice` | Supply a real stop price |
| `invalid-stop-price` | Stop on the wrong side, or too far | Put it below entry for a long, above for a short |
| `unverified-reduce-only` | Close claimed with no matching position | Run `aegis sync`; or drop `reduceOnly` |
| `stale-position-data` | Snapshot too old to verify an exit | Run `aegis sync` |
| `duplicate-action` | This id already executed | It worked — verify before resending |
| `action-in-flight` | The same id is executing right now | Wait for the first result |
| `unsupported-execution-capability` | Venue the gateway cannot execute | Check `aegis capabilities` |
| `symbol-allowlist` | Off-mandate asset | Not tradeable under this policy |
| `kill-switch` | Operator halt | Only the human can lift it |
| `review-threshold` | Above the autonomy line | Ask the human |

## MCP mode

```bash
claude mcp add aegis -- node /abs/path/to/aegis/dist/src/mcp/server.js \
  --gateway --policy /abs/path/to/policy.yaml
```

Tools: `aegis_execute`, `aegis_pending_approvals`, `aegis_approve`, `aegis_reject`,
`aegis_capabilities`, `aegis_status`, `aegis_explain_policy`, `aegis_verify_ledger`,
`aegis_recent_decisions`, `aegis_emergency_stop`, `aegis_resume`, plus the advisory
`aegis_guard_action` / `aegis_record_execution`.

> **Deployment requirement:** in gateway mode do **not** also register the Binance MCP server, and
> keep API keys out of the agent's environment. Aegis cannot revoke a capability handed out separately.

## Security

- In gateway mode Aegis holds the `binance-cli` profile **on purpose** — that is what makes it the
  only write path. In advisory mode it holds nothing.
- There is **no withdrawal path** in either mode, matching the Binance Agentic sub-account model.
- The only non-order write is `cancel-all-open-orders`, which can only reduce risk.
- Zero runtime dependencies.
- Ledger and state live under `~/.aegis` (`AEGIS_HOME`). Set `AEGIS_LEDGER_KEY` for HMAC-signed audit.

## Disclaimer

Aegis is a risk-control tool, not investment advice, and does not guarantee against loss. It reduces
the blast radius of agent error; it cannot make a losing strategy profitable. You remain responsible
for supervising your agent, the policy you configure, and every trade placed. Digital-asset trading
carries substantial risk.
