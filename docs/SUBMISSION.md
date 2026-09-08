# Submission — Binance Agent OS Mini Hackathon, Track A

**Project:** Aegis — the execution control plane for Binance Agent OS  
**Track:** A — Build an AI agent with Agent OS  
**License:** MIT  
**Version:** 2.2.0

---

## Judge's 90-second path

```bash
npm install && npm run build

node dist/src/demo/scenario.js          # three acts, ~5s, no keys, no network
node --test "dist/test/**/*.test.js"    # 333 tests
node dist/src/cli/main.js capabilities  # exactly what the gateway executes
node dist/src/cli/main.js ledger verify
```

The main demo is offline and self-checking: if an invariant breaks, the process exits non-zero.

---

## The thesis

Binance Agent OS gives AI agents real execution capability. The missing layer is deterministic control over **what they are allowed to do, how much, how often, under what evidence, and what can be proved afterwards**.

A system prompt is not a hard safety boundary. It can be ignored, truncated, confused or prompt-injected.

**Most risk agents advise. Aegis enforces.**

In gateway mode the agent holds no independent Binance write tool. Aegis holds the execution capability and is the only write path:

```text
Agent ──▶ Aegis ──▶ Binance
```

---

## What was built

| Component | What it does |
|---|---|
| **Policy engine** | 23 deterministic rules; pure `(action, policy, context) → decision`; no LLM in the enforcement path |
| **Execution gateway** | Aegis as the only write path; explicit capability allowlist; real-fill settlement |
| **Human-in-the-loop** | Durable single-use approval tickets, digest-bound and re-evaluated at redemption |
| **Audit ledger** | SHA-256 / optional HMAC hash chain; detects mutation, deletion, reordering and naïve forged appends |
| **MCP server** | Agent-facing tools over stdio, with gateway and advisory modes |
| **CLI** | Human-facing integration with explicit `ALLOW / DENY / REVIEW` exit-code contract |
| **Guardian** | Portfolio breakers and stale-data protection |
| **Skills Hub skill** | Skill packaged in Binance Skills Hub contribution style |
| **Tests** | 333 total, including security, gateway, sizing, concurrency, E2E and final-gate regressions |
| **Runtime dependencies** | **0** |

---

## Three properties worth defending

### 1. What is judged is what is sent

Aegis resolves executable sizing before policy evaluation finishes, rejects conflicting size descriptions, and passes the resolved order semantics to the exchange adapter without re-deriving them downstream.

A dedicated final-gate suite attacks this property across the sizing input space.

### 2. Verified exits remain available

Aegis does not blindly trust `reduceOnly`. It verifies direction, size and snapshot freshness against real position evidence.

Once an action is proven risk-reducing, breakers such as kill-switch, daily loss, drawdown, cooldown, rate limits, size caps and review thresholds stand aside.

### 3. Fail closed

Malformed action, unknown policy field, unsupported venue, stale evidence, unresolved quantity, concurrency collision or lock failure all produce refusal rather than accidental execution.

---

## Why the security history is public

Aegis was repeatedly red-teamed during development. The important part is not that bugs were found; it is that each reproduced defect was converted into a named regression test and documented instead of being silently patched.

Examples include:

- a review exit-code bug that could have let a shell `&&` continue into execution;
- an execution-boundary sizing bug where the judged notional and downstream quantity could diverge;
- duplicate / approval races that could have produced multiple executions;
- unsupported capabilities that were previously broader in documentation than in the real dispatcher.

The threat model, guarantees, limitations and audit history are in [`SECURITY.md`](./SECURITY.md).

---

## Alignment with Track A

| Requirement | How it is met |
|---|---|
| Built with Agent OS | Executes through Binance's `binance-cli` integration surface; ships an MCP server and a Skills Hub-formatted skill |
| Demo / video | `npm run demo` provides a self-checking offline demonstration; the submitted video shows the agent-facing workflow |
| GitHub | Public MIT-licensed repository |
| Safety posture | No withdrawal path in the gateway; gateway writes intentionally limited to supported Spot and USD-M Futures paths |

---

## Honest limitations

- Advisory mode cannot enforce. Only gateway mode removes the second write path.
- Gateway order execution is intentionally limited to **Spot and USD-M Futures**; unsupported venues are refused rather than rerouted.
- Leveraged risk-increasing entries are restricted to order types Aegis can reconcile synchronously.
- The unkeyed ledger is tamper-*evident*, not tamper-*proof*. Use `AEGIS_LEDGER_KEY` for HMAC mode.
- Reduce-only verification is only as good as the freshness of the underlying position evidence.
- Protective stops are placed after entry fills, but later stop fills are not tracked back into realized PnL by a dedicated lifecycle daemon.
- Aegis reduces the blast radius of agent error. It cannot make a losing strategy profitable.

---

## Deeper review

- [`SECURITY.md`](./SECURITY.md) — threat model, guarantees, limitations, audit history
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system boundaries and execution model
- [`INTEGRATION.md`](./INTEGRATION.md) — gateway / advisory / library integration

Not affiliated with or endorsed by Binance. Not investment advice.
