---
name: agent-os-risk-firewall
description: |
  Use BEFORE any Binance action that places an order, moves funds, or changes exposure — spot/margin/futures
  orders, wallet transfers, on-chain swaps, leverage changes. Evaluates the proposed action against a
  declarative risk policy (notional caps, daily loss limits, leverage ceilings, rate limits, drawdown
  breakers, fat-finger guards, allowlists) and returns allow / review / deny with reasons. Also use for:
  "am I allowed to", "check this trade", "how much budget do I have left", "risk limits", "stop the agent",
  "emergency stop", "kill switch", "audit log", "what did my agent do", "verify the audit trail",
  "why was this blocked", "position limits", "guardrails", "risk policy", "风控", "限额", "紧急停止", "审计".
metadata:
  version: 1.0.0
  author: aegis
  openclaw:
    requires:
      bins:
        - node
    install:
      - kind: shell
        label: Install Aegis risk firewall
        script: |
          npm install -g @aegis/agent-os-firewall || {
            echo "Falling back to source install"
            git clone --depth 1 https://github.com/aegis-agent-os/aegis /tmp/aegis && \
            cd /tmp/aegis && npm install && npm run build && npm link
          }
          aegis --version
license: MIT
---

# Aegis — Agent OS Risk Firewall

Aegis is the **authorization layer** for Binance Agent OS. Binance MCP decides *how* to execute;
Aegis decides *whether you may*. It is deterministic — no LLM sits in the enforcement path — and
every decision is hash-chained into a tamper-evident audit ledger.

> **The one rule:** call `aegis check` **before** every order, transfer or exposure change, and
> `aegis record` **after** it fills. Nothing else in this skill matters if you skip that.

---

## When to Use This Skill

| User intent | What you do |
|---|---|
| Any order, transfer, swap or leverage change | `aegis check` **first**, then execute only on `allow` |
| An order just filled | `aegis record` with the real notional and PnL |
| "How much room do I have left?" | `aegis status` |
| "Why was that blocked?" / "What are my limits?" | `aegis policy show` |
| "Stop" / "halt" / "panic" / "something's wrong" | `aegis halt "<reason>"` |
| "Resume trading" (**only** on explicit human request) | `aegis resume` |
| "Show me what the agent did" / audit review | `aegis ledger tail 50` |
| "Has anyone tampered with the log?" | `aegis ledger verify` |

---

## The Loop

```
                    ┌──────────────────────┐
   agent decides →  │  aegis check <action>│  ← deterministic, ~1 ms, no network
                    └──────────┬───────────┘
              allow ┌──────────┼───────────┐ deny
                    │        review        │
                    ▼          ▼           ▼
              execute via  ask the      do NOT execute;
              Binance MCP   human       relay the reason
                    │
                    ▼
            aegis record <fill>  ← advances the budget counters
```

## Commands

Always append `--json` when you need to parse the result.

### 1. `aegis check` — the mandatory pre-flight

```bash
aegis check --json \
  --category trade --venue spot --symbol BTCUSDT \
  --side BUY --orderType MARKET --quoteQuantity 250
```

Or pass the action as one JSON argument:

```bash
aegis check --json '{"category":"trade","venue":"futures-usds","symbol":"ETHUSDT","side":"BUY","quoteQuantity":800,"leverage":10,"hasStopLoss":true}'
```

**Parameters**

| Field | Required | Values |
|---|---|---|
| `category` | ✅ | `read`, `trade`, `cancel`, `transfer`, `onchain`, `withdraw` |
| `venue` | ✅ | `spot`, `margin`, `futures-usds`, `futures-coin`, `convert`, `wallet`, `market-data` |
| `symbol` | for trades | e.g. `BTCUSDT` |
| `asset` | for transfers | e.g. `USDT` |
| `side` | for trades | `BUY`, `SELL` |
| `orderType` | | `MARKET`, `LIMIT`, `STOP_MARKET`, `TAKE_PROFIT_MARKET`, `STOP_LOSS_LIMIT`, `OCO` |
| `quantity` | one of | base-asset amount |
| `quoteQuantity` | one of | quote notional (`quoteOrderQty`) — **prefer this, it is unambiguous** |
| `price` | for `LIMIT` | limit price |
| `leverage` | for derivatives | integer |
| `reduceOnly` | | `true` when the order can only close |
| `hasStopLoss` | | `true` when a protective stop is attached |
| `id` | | your idempotency key; reusing one is rejected as a replay |

**Exit codes:** `0` = allow or review · `1` = deny · `2` = bad input.
This makes `aegis check ... && binance-cli spot new-order ...` a safe one-liner.

**Response**

```json
{
  "verdict": "deny",
  "summary": "DENY — TRADE BTCUSDT ($5000) blocked by: max-notional-per-order.",
  "actionId": "auto-1f2e…",
  "notionalUsd": 5000,
  "findings": [
    { "ruleId": "max-notional-per-order", "verdict": "deny", "severity": "critical",
      "message": "Order notional $5000 exceeds the per-order cap of $500.",
      "observed": 5000, "limit": 500 }
  ],
  "policy": "conservative-desk", "mode": "enforce",
  "ledgerSeq": 42, "ledgerHash": "9c1f…"
}
```

### 2. `aegis record` — after the fill

```bash
aegis record --json --actionId <id-from-check> --notionalUsd 250 --realizedPnlUsd -12.4
```

Counters only move here. **If you skip this, every budget and loss limit goes blind.**

### 3. Situational awareness

```bash
aegis status --json          # equity, drawdown, exposure, budget consumption, kill-switch
aegis policy show --json     # active limits, allowlists, guards
aegis rules --json           # the 20 rules being enforced
```

### 4. Safety controls

```bash
aegis halt "user asked to stop"   # kill-switch ON — blocks new risk immediately
aegis resume                      # ONLY when the human explicitly asks
```

The kill-switch is asymmetric on purpose: reads and **cancels still work**, so positions can
always be closed. Never call `resume` on your own initiative.

### 5. Audit

```bash
aegis ledger verify --json   # ok:false names the exact tampered sequence number
aegis ledger tail 50         # recent decisions
```

---

## Rules You Must Follow

1. **Never execute a Binance action you did not `check` first.** Not "usually" — never.
2. **`deny` is final.** Do not retry with a smaller size hoping to slip under a limit unless
   the user explicitly asks you to resize. Relay the `message` verbatim.
3. **`review` is a hard stop.** Show the user the finding and wait for confirmation. Do not
   interpret silence as approval.
4. **Always `record` after a fill**, with the *actual* filled notional, not the requested one.
5. **Prefer `quoteQuantity`** over `quantity` — it removes an entire class of sizing ambiguity.
6. **Reuse the `id` from `check` in `record`.** That is what links the decision to its outcome.
7. **Never edit `ledger.jsonl`.** It is append-only and cryptographically chained; edits are detected.
8. **Never invent limits.** If the user asks what they can do, call `aegis policy show`.
9. **On `halt`, stop immediately** and tell the user what remains open.

## Interpreting Findings

| Rule | What tripped | Usual fix |
|---|---|---|
| `max-notional-per-order` | Single clip too large | Split the order or ask the user to raise the cap |
| `max-daily-notional` | Day's turnover budget spent | Wait for UTC rollover |
| `max-open-exposure` | Aggregate exposure cap | Close something first |
| `max-leverage` | Leverage above ceiling | Lower leverage |
| `daily-loss-limit` | Realized loss breaker tripped | **Stop for the day.** Closes still allowed |
| `max-drawdown` | Peak-to-trough equity breaker | Needs deliberate human reset |
| `loss-cooldown` | Too soon after a loss | Wait out the window — this is the anti-revenge guard |
| `rate-limit-minute/hour` | Firing too fast | Slow down; likely a loop bug |
| `price-deviation` | Limit price far from mark | **Re-fetch the price — your context is stale** |
| `require-stop-loss` | Leveraged entry with no stop | Attach a stop, resubmit with `hasStopLoss: true` |
| `duplicate-action` | Replayed id | It already executed — verify before resending |
| `symbol-allowlist` | Off-mandate asset | Not tradeable under this policy |
| `kill-switch` | Operator halt | Only the human can lift it |
| `review-threshold` | Above autonomy limit | Ask the human |

## MCP Mode

Aegis also runs as an MCP server, so it can sit alongside the Binance MCP server:

```bash
claude mcp add aegis -- node /path/to/aegis/dist/mcp/server.js --policy ./aegis.policy.yaml
```

Tools: `aegis_guard_action`, `aegis_record_execution`, `aegis_status`, `aegis_explain_policy`,
`aegis_verify_ledger`, `aegis_recent_decisions`, `aegis_emergency_stop`, `aegis_resume`.

## Security

- Aegis holds **no credentials** and places **no orders**. It reads account state through
  `binance-cli` and authorizes; execution stays with Binance MCP / `binance-cli`.
- There is **no withdrawal path**, matching the Binance Agentic sub-account model.
- Zero runtime dependencies — nothing in the supply chain to compromise.
- Ledger and state live under `~/.aegis` (override with `AEGIS_HOME`).

## Disclaimer

Aegis is a risk-control tool, not investment advice, and it does not guarantee against loss.
It reduces the blast radius of agent error; it cannot make a losing strategy profitable. You
remain responsible for supervising your agent, the policy you configure, and every trade placed.
Digital-asset trading carries substantial risk.
