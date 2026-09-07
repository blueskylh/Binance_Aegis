# Submission — Binance Agent OS Mini Hackathon, Track A

**Project:** Aegis — the execution control plane for Binance Agent OS
**Track:** A — Build an AI agent with Agent OS · **License:** MIT · **Version:** 2.1.0

---

## Judge's 90-second path

```bash
npm install && npm run build

node dist/src/demo/scenario.js          # three acts, ~5s, no keys, no network
node --test "dist/test/**/*.test.js"    # 297 tests
node dist/src/cli/main.js capabilities  # exactly what it will execute
node dist/src/cli/main.js doctor        # real binance-cli integration evidence
node dist/src/cli/main.js ledger verify
```

Everything runs offline. The demo asserts its own invariants and exits non-zero if any is violated.

---

## The thesis

TechCrunch on Agent OS launch day: *"Binance now lets AI agents trade, but keeping them in check is
largely up to users."*

Binance built excellent execution rails. The policy layer was left to the user, and today it lives in
a system prompt — which can be argued with, forgotten mid-context, or prompt-injected.

**Most risk agents advise. Aegis enforces.** The agent holds no Binance write tool; Aegis holds the
credentials and is the only path to the exchange.

---

## What was built

| | |
|---|---|
| **Policy engine** | 23 deterministic rules; pure `(action, policy, context) → decision`; no LLM in the enforcement path |
| **Execution gateway** | Aegis as the only write path; capability allowlist; real-fill settlement |
| **Human-in-the-loop** | Durable single-use approval tickets, digest-bound, re-evaluated at redemption |
| **Audit ledger** | SHA-256 (or HMAC) hash chain; detects mutation, deletion, reordering, forged appends |
| **MCP server** | 13 tools over stdio, gateway or advisory |
| **CLI** | 19 commands; exit codes `0/1/2/3` where `3` = review |
| **Guardian** | Portfolio circuit breakers with stale-data protection |
| **Skills Hub skill** | In Binance's contribution format |
| **Tests** | 297 — unit, gateway, 17 security regressions, 12 self-audit regressions, real-process E2E |
| **Dependencies** | **Zero** at runtime |

---

## Three properties worth defending

**1. What is judged is what is sent.** Derivatives quantities are resolved during normalization and
passed to the venue verbatim. An earlier build re-derived them and would have turned a judged $100
order into 100 BTC.

**2. The exit is never blocked.** Every breaker stands aside for a *verified* risk-reducing action —
verified against real positions, with a freshness bound on the evidence.

**3. Fail closed, everywhere.** Malformed action, unparseable policy, unsupported venue, unfilled
order, stale snapshot, unresolvable quantity, lock timeout — all produce a refusal, never an
accidental allow.

---

## Audited twice, openly

Two independent adversarial reviews found **7 + 8 defects**; a further **6** were found by attacking
our own code. All are fixed, each with a named regression test, and all are listed in
[`docs/SECURITY.md`](./SECURITY.md) rather than quietly patched.

The worst two:

- **GW-02** — a $100 futures order would have executed as 100 BTC. Every control above it passed.
- **SEC-05** — `review` exited `0`, so the documented `aegis check && binance-cli …` auto-executed
  exactly the orders a human was meant to approve.

A security tool that hides its own findings is not one you should trust.

---

## Alignment with Track A

| Requirement | How it is met |
|---|---|
| Built with Agent OS | Executes through `binance-cli` (Skills Hub CLI) with command names verified against the official repo; ships an MCP server; contributes a Skills Hub skill |
| Demo / video | `npm run demo` — three offline acts; shot list in [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md) |
| GitHub | This repository, MIT |
| Safety posture | No withdrawal path; Agentic sub-account model; credentials held only in gateway mode, on purpose |

---

## Honest limitations

- Advisory mode cannot enforce. Only gateway mode does.
- Gateway writes are **spot and USD-M futures only**. Margin, COIN-M, convert, wallet and on-chain
  are refused, not rerouted. Narrow and honest beats broad and wrong.
- The unkeyed ledger is tamper-*evident*, not tamper-*proof*. Set `AEGIS_LEDGER_KEY`.
- Reduce-only verification is only as fresh as the last snapshot; stale evidence is refused.
- A protective stop is placed after entry, but its later fill is not tracked back into PnL.
- It bounds the blast radius of agent error. It cannot make a losing strategy profitable.

Not affiliated with or endorsed by Binance. Not investment advice.
