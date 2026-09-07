# Submission — Binance Agent OS Mini Hackathon, Track A

**Project:** Aegis — the risk firewall for Binance Agent OS
**Track:** A — Build an AI agent with Agent OS
**License:** MIT

---

## Judge's 60-second path

```bash
npm install && npm run build

node dist/src/demo/scenario.js     # three acts, ~5s, no keys, no network
node --test "dist/test/**/*.test.js"   # 245 tests
node dist/src/cli/main.js rules    # the 21 enforced rules
node dist/src/cli/main.js doctor   # real binance-cli integration evidence
node dist/src/cli/main.js ledger verify
```

Everything runs offline. Nothing can fail live.

---

## The thesis in one paragraph

Binance built excellent execution rails for agents — the MCP server, `binance-cli`, the Agentic
sub-account, confirm-before-execute. What it deliberately left to the user is the **policy layer**.
TechCrunch named the gap on launch day: *"Binance now lets AI agents trade, but keeping them in
check is largely up to users."* Today that layer is a paragraph in a system prompt, which can be
argued with, forgotten mid-context, prompt-injected, or truncated. Aegis makes it a deterministic,
testable, auditable control plane that sits between any agent and Binance.

**This is not another trading bot.** It is the layer every trading bot on Agent OS is missing —
including the ones competing in this hackathon.

---

## What was built

| | |
|---|---|
| **Policy engine** | 21 deterministic rules; pure `(action, policy, context) → decision`; no LLM in the enforcement path |
| **Policy language** | Declarative YAML, deny-by-default, strict schema — unknown keys are hard errors |
| **Audit ledger** | SHA-256 hash-chained append-only JSONL; detects mutation, deletion, reordering and forged appends by sequence number |
| **MCP server** | 8 tools over stdio; runs beside the Binance MCP server |
| **CLI** | 12 commands; exit code *is* the integration (`check && binance-cli ...`) |
| **Skills Hub skill** | `skill/agent-os-risk-firewall/SKILL.md`, in Binance's contribution format |
| **Guardian daemon** | Portfolio-level circuit breakers on a timer via `binance-cli`, with stale-data protection |
| **Execution gateway** | Aegis as the ONLY write path; approval tickets bound to an action digest |
| **Tests** | 245 passing — unit + gateway + 17 security regressions + real-process E2E |
| **Dependencies** | **Zero** at runtime, including the YAML parser |

---

## Three design decisions worth defending

**1. The exit is never blocked.** Every breaker exempts cancels, reduce-only closes and protective
stops. A risk system that traps you in a position *is* the risk. This is not aspirational — it is
enforced by regression tests, and it caught a real bug in this codebase during development (the rate
limiter would have throttled a reduce-only exit).

**2. Fail closed, always.** A malformed action, an unparseable policy, or a rule that throws all
produce `deny`. Never an accidental `allow`. Verified by adversarial testing: the engine never throws
and never fails open on hostile input.

**3. Counters are derived, never incremented.** Every rolling limit is recomputed from the ledger on
each read. Counters that drift are counters that lie, and a limit computed from a lying counter is
not a limit.

---

## Alignment with the hackathon

| Requirement | How it is met |
|---|---|
| Built with Agent OS | Consumes `binance-cli` (Skills Hub CLI); ships as an MCP server designed to run beside the Binance MCP server; contributes a Skills Hub skill back |
| Demo / video | `npm run demo` — 12 offline scenarios; shot list in `docs/DEMO-SCRIPT.md` |
| GitHub | This repository, MIT licensed |
| Safety posture | No credentials held, no orders placed, no withdrawal path, matching Binance's Agentic sub-account model |

---

## Repository map

```
README.md                 The pitch and the full feature tour
docs/ARCHITECTURE.md      Why the engine is pure, how the hash chain works, the three invariants
docs/INTEGRATION.md       MCP / CLI / library wiring + the rollout sequence + failure modes
docs/DEMO-SCRIPT.md       2-minute video shot list
skill/                    Skills Hub skill, ready to PR to binance/binance-skills-hub
policies/                 conservative · balanced · monitor-first
src/                      core · policy · ledger · state · adapters · guardian · mcp · cli
test/                     211 tests
```

---

## Honest limitations

- Aegis reduces the blast radius of agent error. It cannot make a losing strategy profitable.
- It authorizes actions; it does not verify that the agent actually *sent* what it declared. Pair it
  with the Binance Agentic sub-account's own permission scopes for defence in depth.
- The guardian polls; it is not a real-time stream. Sub-minute risk still belongs in exchange-side
  stop orders, which is why `requireStopLoss` exists.
- USD notional for exotic assets depends on marks being supplied; unknown assets are denied rather
  than guessed.

Not affiliated with or endorsed by Binance. Not investment advice.
