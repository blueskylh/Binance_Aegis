<div align="center">

# 🛡️ Aegis

### The execution control plane for Binance Agent OS

**Binance Agent OS gives your AI agent real market power.**
**Aegis is the door it cannot walk around.**

**The agent proposes. Aegis decides. Binance executes.**

*23 deterministic rules · zero LLMs in the enforcement path · hash-chained audit ledger · zero runtime dependencies*

[![tests](https://img.shields.io/badge/tests-297%20passing-brightgreen)]()
[![security](https://img.shields.io/badge/security%20regressions-35-critical)]()
[![deps](https://img.shields.io/badge/runtime%20dependencies-0-blue)]()
[![node](https://img.shields.io/badge/node-%E2%89%A522-green)]()
[![license](https://img.shields.io/badge/license-MIT-black)]()

*Binance Agent OS Mini Hackathon — Track A*

[中文](./README.md) · [Security model](./docs/SECURITY.md) · [Architecture](./docs/ARCHITECTURE.md) · [Integration](./docs/INTEGRATION.md)

</div>

---

## The problem

When Binance shipped Agent OS, TechCrunch put the gap plainly:

> *"Binance now lets AI agents trade, but **keeping them in check is largely up to users**."*
> — TechCrunch, 20 Aug 2026

Binance built excellent execution rails — the MCP server, `binance-cli`, the Agentic sub-account,
confirm-before-execute. What it deliberately left to you is the **policy layer**: how much, how
often, on what, under what conditions, and with what evidence afterwards.

Today that layer is a paragraph in a system prompt. A system prompt is not a risk control. It can
be argued with, forgotten mid-context, injected into, or silently truncated at 40k tokens.

**Aegis is that layer, built properly.**

```
        ┌─────────────┐        ┌──────────────┐       ┌────────────────┐
        │  Your Agent │──ask──▶│  🛡️  AEGIS   │──ok──▶│  Binance MCP   │
        │  (any LLM)  │        │ policy engine │       │  binance-cli   │
        └─────────────┘        └───────┬──────┘       └────────────────┘
                                       │ deny / review
                                       ▼
                            ┌──────────────────────┐
                            │ hash-chained ledger  │
                            │  every decision      │
                            └──────────────────────┘
```

The agent proposes. Aegis disposes. Binance executes. **No LLM anywhere in the enforcement path** —
the same inputs always produce the same verdict, and you can prove it after the fact.

---

## Advisory vs gateway — the distinction that matters

This is the most important design decision in the project, and the one v1.0.0 got wrong.

| | ❌ Advisory mode | ✅ Gateway mode |
|---|---|---|
| Topology | `agent → Aegis` **and** `agent → Binance` | `agent → Aegis → Binance` |
| Agent holds a Binance write tool | Yes | **No** |
| Enforcement | A system prompt asking politely | A property of the deployment |
| Prompt injection can bypass | **Yes** | No — there is no second path |

In gateway mode Aegis holds the credentials and exposes exactly one execution tool. The guarantee
stops being a claim about agent behaviour and becomes structural: the agent cannot call Binance
directly because it was never handed a way to.

```bash
aegis mcp --gateway --policy ./policies/conservative.yaml
```

> **Deployment requirement:** in gateway mode, do not also register the Binance MCP server, and keep
> API keys out of the agent's environment. Aegis cannot revoke a capability you hand out separately.

---

## 60-second demo

```bash
git clone <this-repo> && cd aegis
npm install && npm run demo
```

No API keys. No network. No funds at risk. Twelve scenarios run in about four seconds:

| # | Scenario | Verdict | Rule that fired |
|---|---|---|---|
| 01 | Read market data | ✅ allow | *(reads are free)* |
| 02 | $150 spot buy, inside budget | ✅ allow | — |
| 03 | $400 buy, above autonomy line | ⚠️ **review** | `review-threshold` |
| 04 | $5,000 in one clip | ⛔ deny | `max-notional-per-order` |
| 05 | Limit buy at $9,000 while BTC is $100,000 | ⛔ deny | `price-deviation` |
| 06 | 20x futures, no stop attached | ⛔ deny | `max-leverage` + `require-stop-loss` |
| 07 | Off-mandate memecoin | ⛔ deny | `symbol-allowlist` |
| 08 | Withdrawal to an external address | ⛔ deny | `category-denylist` |
| 09 | 4th order in 60 seconds (runaway loop) | ⛔ deny | `rate-limit-minute` |
| 10 | Same order id replayed after a timeout | ⛔ deny | `duplicate-action` |
| 11 | Revenge trade straight after a loss | ⛔ deny | `daily-loss-limit` + `loss-cooldown` |
| 12 | **Reduce-only exit while everything is tripped** | ✅ **allow** | *(the exit is never blocked)* |

Then it rewrites a historical `deny` into an `allow` in the ledger file — and the chain
verification catches the forgery at the exact sequence number.

---

## Install & wire up

```bash
npm install && npm run build
node dist/src/cli/main.js init          # writes aegis.policy.yaml + prints MCP config
```

### As an MCP server, alongside Binance MCP

```bash
# Binance executes…
claude mcp add --transport http binance-mcp-server https://agent.binance.com/mcp/agentic
# …Aegis authorizes.
claude mcp add aegis -- node $(pwd)/dist/src/mcp/server.js --policy $(pwd)/aegis.policy.yaml
```

Add one line to your agent's instructions:

> *Before every Binance action that places an order, moves funds or changes exposure, call
> `aegis_guard_action`. Execute only on `allow`. Treat `review` as a hard stop pending human
> confirmation. After every fill, call `aegis_record_execution`.*

### As a CLI, for shell and cron agents

```bash
aegis check --category trade --venue spot --symbol BTCUSDT --side BUY --quoteQuantity 250 \
  && binance-cli spot new-order --symbol BTCUSDT --side BUY --type MARKET --quoteOrderQty 250
```

`check` exits **0** on allow/review and **1** on deny, so `&&` is a complete integration.

### As a Skills Hub skill

`skill/agent-os-execution-gateway/SKILL.md` follows the
[binance-skills-hub](https://github.com/binance/binance-skills-hub) contribution format and works
with Claude Code, OpenClaw, LangChain and CrewAI.

---

## The policy

One readable file is the whole security posture. Deny-by-default, so a capability you never
mentioned is a capability the agent never gets.

```yaml
version: 1
name: conservative-desk
mode: enforce          # enforce | monitor (report-only) | simulate (dry run)
default: deny

limits:
  maxNotionalUsdPerOrder: 250
  maxDailyNotionalUsd: 1500
  maxOpenNotionalUsd: 750
  maxLeverage: 2
  maxDailyLossUsd: 75
  maxDrawdownPct: 5
  maxOrdersPerMinute: 2
  maxOrdersPerHour: 12
  maxPositionsOpen: 2

allow:
  categories: ["read", "trade", "cancel"]
  venues: ["spot", "market-data"]
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"]

deny:
  categories: ["withdraw", "onchain", "transfer"]

guards:
  priceDeviationPct: 3
  minAccountEquityUsd: 200
  requireStopLoss: true
  tradingHoursUtc: { from: "06:00", to: "22:00" }
  cooldownSecondsAfterLoss: 900
  reviewAboveNotionalUsd: 100
  blockDuplicateActionIds: true
```

Ships with `conservative.yaml`, `balanced.yaml` and `monitor-first.yaml`.
**Start with `monitor-first`** — it blocks nothing, logs everything, and shows you what your agent
*would* have done before you give it teeth.

Unknown keys are a hard error, never a warning. A typo like `maxLevrage:` that silently means
"no limit" is exactly the failure this project exists to prevent.

---

## The 23 rules

| Category | Rules |
|---|---|
| **Access** | `kill-switch` · `category-allowlist` / `denylist` · `venue-allowlist` / `denylist` · `symbol-allowlist` / `denylist` · `default-posture` |
| **Size** | `max-notional-per-order` · `max-daily-notional` · `max-open-exposure` · `max-positions-open` · `max-leverage` · `min-equity` |
| **Loss** | `daily-loss-limit` · `max-drawdown` · `loss-cooldown` |
| **Tempo** | `rate-limit-minute` · `rate-limit-hour` · `trading-hours` |
| **Integrity** | `price-deviation` (fat-finger) · `require-stop-loss` · `duplicate-action` (replay) · **`unverified-reduce-only`** |
| **Human** | `review-threshold` |

Three invariants hold across all of them:

1. **The exit is never blocked.** Every breaker — kill-switch, daily loss, drawdown, cooldown, rate
   limits, size caps, review threshold — stands aside for a *verified* risk-reducing action. A risk
   system that traps you in a position *is* the risk.
2. **A claim is evidence, not proof.** `reduceOnly` is validated against real positions — opposite
   side, sufficient size — and the exemption is refused when it cannot be verified.

3. **Fail closed.** A malformed action, an unparseable policy or a rule that throws all produce
   `deny` — never an accidental `allow`.
4. **Prospective, not retrospective.** Limits ask *"what would exposure be if this executed"*, not
   *"what is it now"*.

---

## The audit ledger

Every decision — including every allow — is appended as one JSON line, hash-chained to its predecessor:

```
hash(n) = SHA-256( hash(n-1) ‖ canonicalJSON(seq, ts, type, payload) )
```

```bash
$ aegis ledger verify
  ✅ Ledger intact — 1,284 entries verified against the hash chain.
     head: c97e24813461ddf3d381a08d373c42448b5f1efc4bc25126c29591fc1fe656c7

$ aegis ledger verify   # after someone edits one historical line
  ❌ LEDGER TAMPERED — hash mismatch at seq 412: the payload was modified after it was written
     first bad entry: seq 412
```

Append-only JSONL over a database on purpose: greppable, diffable, shippable to S3 or a SIEM, and
survives a crash with at worst one partial trailing line. Keys are sorted before hashing so an
independent verifier reaches the same digest.

---

## The guardian daemon

The policy engine judges one action at a time. The guardian judges the **whole account, on a timer** —
which catches the risk that arrives with no agent action at all: a position moving against you while
the agent sits idle.

```bash
aegis guardian --watch BTCUSDT,ETHUSDT --interval 60 --dry-run
```

On breach it trips the kill-switch and optionally cancels resting orders. It never closes a
position — deciding when to realize a loss is a human's call.

It also **refuses to trip on stale data**: if `binance-cli` fails, the snapshot is held rather than
read as zero equity, because a monitoring system that fakes a 100% drawdown during an outage is
worse than none.

---

## Engineering

```
297 tests · 0 failures · 35 security regressions · 0 runtime dependencies
```

```bash
npm test        # unit + gateway + security regressions + real-process E2E
npm run verify  # tests + the full demo scenario
```

- **Pure engine.** `evaluate(action, policy, context) → decision` performs no I/O, reads no clock
  and mutates nothing it is given. Every decision is reproducible from the ledger.
- **Real E2E.** The suite spawns the actual CLI and the actual MCP server as child processes and
  drives them over stdio, exactly as Claude Code would.
- **Zero dependencies**, including the YAML parser. A security control plane should not drag a
  supply chain behind it. TypeScript `strict` + `noUncheckedIndexedAccess`.
- **Built test-first**, then independently audited. An adversarial review of v1.0.0 reproduced
  **seven defects**; all are fixed in v2.0.0 with a named regression test each, and all are listed
  openly in [`docs/SECURITY.md`](./docs/SECURITY.md) rather than quietly patched. Two were critical:
  a bare `STOP_MARKET` bypassed the loss breakers, and a fabricated `reduceOnly` flag unlocked every
  size limit.

```
src/
├── core/
│   ├── engine.ts          # pure evaluate()
│   ├── normalize.ts       # every sizing form → one USD notional
│   └── rules/             # access · size · loss · tempo · integrity
├── policy/                # strict schema + zero-dep YAML subset parser
├── ledger/                # hash chain + verification
├── state/                 # rolling counters, rebuilt from the ledger
├── gateway/               # the enforced write path + approval tickets
├── adapters/binance.ts    # binance-cli adapter (verified command names)
├── guardian/              # portfolio circuit breakers
├── mcp/                   # MCP server (handler + stdio transport)
└── cli/                   # the aegis command
```

---

## Security model

| | |
|---|---|
| Credentials held | advisory: none · gateway: the `binance-cli` profile, deliberately |
| Orders placed | **none** — the only write is `cancel-all-open-orders`, which only reduces risk |
| Withdrawal path | **none**, matching the Binance Agentic sub-account model |
| Supply chain | zero runtime dependencies |
| Shell injection | `execFile` without a shell, no interpolation surface |
| Data at rest | `~/.aegis` (override with `AEGIS_HOME`), atomic writes |

---

## Command reference

```
aegis execute <action>      GATEWAY — evaluate AND execute    (exit 1 deny / 3 review)
aegis approve <ticket>      Approve a parked action
aegis pending               List actions awaiting approval
aegis doctor                Probe the live binance-cli integration
aegis check <action>        Advisory-only evaluation (does NOT execute)
aegis record --actionId ..  Record a fill (advisory mode only)
aegis status                Posture, drawdown, budget bars
aegis rules                 The 20 enforced rules
aegis policy show|validate  Inspect / lint a policy
aegis ledger verify|tail    Audit the chain
aegis halt <reason>         Kill-switch on
aegis resume [--reset-peak] Kill-switch off
aegis init [path]           Starter policy + MCP wiring
aegis mcp [--gateway]       Run the MCP server on stdio
aegis guardian [...]        Run the circuit-breaker daemon
aegis demo                  The three-act walkthrough
```

---

## Disclaimer

Aegis is a risk-control tool. It is not investment advice, it does not guarantee against loss, and
it cannot make a losing strategy profitable — it reduces the blast radius of agent error. You remain
responsible for supervising your agent, for the policy you configure, and for every trade placed.
Digital-asset trading carries substantial risk. Not affiliated with or endorsed by Binance.

MIT licensed.
