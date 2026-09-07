# Architecture

## The one-sentence version

`evaluate(action, policy, context) → decision` is a pure function; everything else in this
repository exists to feed it good inputs and to make its outputs impossible to forge.

---

## Layering

```
┌──────────────────────────────────────────────────────────────────────┐
│  Integrations        CLI  ·  MCP server  ·  Guardian daemon          │
├──────────────────────────────────────────────────────────────────────┤
│  Facade              Aegis  (orchestration, one place)               │
├──────────────────────────────────────────────────────────────────────┤
│  Engine (pure)       normalize → 20 rules → aggregate → mode         │
├──────────────────────────────────────────────────────────────────────┤
│  Evidence            Ledger (hash chain)  ·  RiskStore (counters)    │
├──────────────────────────────────────────────────────────────────────┤
│  World               BinanceAdapter (read-only, via binance-cli)     │
└──────────────────────────────────────────────────────────────────────┘
```

Every integration is a thin shell over the same `Aegis` facade. The CLI command and the MCP tool
cannot enforce subtly different things, because they call the same method.

---

## Why the engine is pure

`evaluate` performs no I/O, reads no clock and mutates neither the policy nor the context it is
given. `now` is injected through `RiskContext`.

Three consequences:

1. **Reproducibility.** Any decision in the ledger can be re-evaluated years later and reach the
   same verdict. Auditability is not a feature bolted on; it falls out of the design.
2. **Testability.** 211 tests run with no mocks, no fake timers and no network.
3. **No hidden state.** A rule cannot accumulate anything between calls, so it cannot drift.

---

## Normalization: one notional to rule them all

Agents express the same intent many ways — `quoteOrderQty: 250`, `quantity: 0.0025 @ 100000`,
`quantity: 0.0025` at market. A limit is meaningless until all of those collapse to one comparable
USD number, so normalization runs before any rule.

Precedence: `quoteQuantity` → `quantity × price` → `quantity × mark` → asset amount × mark
(stablecoins at par).

**It fails closed.** An action that cannot be sized confidently raises, and the engine converts that
into a `deny` with a `malformed-action` finding. A firewall that guesses is not a firewall.

---

## Rule design

Every rule has the signature `(action, policy, context) → Finding[]`. Returning an array rather than
a boolean means one rule can report several distinct problems, and the caller sees *all* violations
rather than the first.

Verdicts aggregate by taking the most restrictive: `deny` > `review` > `allow`. Order-independent,
so the registry can be reordered for readability without changing behaviour.

### Invariant 1 — the exit is never blocked

Every breaker exempts `isRiskReducing(action)`: cancels, reduce-only orders, `STOP_MARKET` and
`TAKE_PROFIT_MARKET`. A risk system that traps you in a position *is* the risk.

This one caught a real bug during development: the rate limiter originally exempted only reads and
cancels, so a reduce-only exit could be throttled during exactly the fast market where you need it.
Fixed at root cause; three regression tests guard it.

### Invariant 2 — fail closed

- Malformed action → `deny`
- Unparseable policy → refuse to start
- Unknown policy key → hard error (a typo'd `maxLevrage:` must never mean "no limit")
- Rule throws → `deny` with an `:internal-error` finding, and the engine keeps going

### Invariant 3 — prospective, not retrospective

Limits ask *"what would exposure be if this executed"*, never *"what is it now"*. Retrospective
limits are how accounts blow through their own caps.

---

## Policy modes

| Mode | Behaviour | Use when |
|---|---|---|
| `enforce` | The verdict stands | Production |
| `monitor` | `deny` → `review`; nothing hard-blocked | Rolling out a new policy over live flow |
| `simulate` | Everything → `allow`, findings still reported | Tuning limits against historical flow |

The kill-switch is exempt from all three. An operator halt that a config flag could soften would not
be a halt.

---

## The ledger

```
hash(n) = SHA-256( hash(n-1) ‖ canonicalJSON(seq, ts, type, payload) )
genesis = SHA-256("aegis-ledger-genesis-v1")
```

`canonicalJSON` sorts keys recursively — `JSON.stringify` preserves insertion order, so two
structurally identical payloads could otherwise hash differently and defeat independent verification.

`verify()` recomputes the whole chain and reports the first divergence with its sequence number,
distinguishing three tamper classes: a mutated payload (hash mismatch), a deleted or reordered entry
(sequence gap), and a forged append (broken link).

**Why JSONL, not a database:** greppable, diffable, shippable to S3 or a SIEM with `cat`, and a crash
costs at worst one partial trailing line — which the reader stops cleanly at rather than discarding
an otherwise valid history. Appends are synchronous: an audit record that *might* have been written
is worse than a few milliseconds of latency.

---

## State: derived, never incremented

Rolling counters — daily notional, realized PnL, order tempo, replay ids — are **recomputed from
ledger executions on every read**, never incremented in place.

Counters that drift are counters that lie, and a limit computed from a lying counter is not a limit.
The cost is an O(n) scan per evaluation; at realistic agent volumes that is microseconds, and it buys
exact restart semantics for free.

The state file holds only the account snapshot, the equity high-water mark and the kill-switch —
small, atomically written (temp + rename), and safe to lose: everything but the peak can be re-fetched.

---

## The Binance adapter

Read-only by contract. Aegis authorizes; it never places orders. The single exception is
`cancelAllOpenOrders`, which only reduces risk and is what makes the guardian's breaker meaningful.

Reads go through `binance-cli` — the official Agent OS CLI — rather than a hand-rolled REST client,
so auth, signing and endpoint drift stay Binance's problem. `execFile` without a shell means no
interpolation surface.

Every call degrades gracefully: if the CLI is missing or unauthenticated, Aegis keeps enforcing on
its last known snapshot instead of failing open.

---

## The guardian

The engine judges one action; the guardian judges the whole account on a timer. That is how you catch
risk arriving with no agent action at all — a position moving against you while the agent is idle.

`assessBreakers` is pure, so the daemon's decision logic is testable without a network or a clock.
It is **edge-triggered**: once the kill-switch is engaged it reports nothing, so a breached account
halts once rather than spamming the ledger every poll.

It **refuses to act on stale data**. A transient CLI failure returning zero equity would otherwise
look like a 100% drawdown and trip every breaker simultaneously — the classic monitoring own-goal.
On a degraded read the snapshot is held and breakers are skipped for that cycle.

---

## MCP

Protocol logic (`mcp/handler.ts`) is split from transport (`mcp/server.ts`). The handler is a pure
`request → response` function, which is why every branch is covered without spawning a process; the
E2E suite then spawns the real server and drives it over real stdio.

stdout carries protocol frames only. Every diagnostic goes to stderr, because one stray
`console.log` corrupts an MCP session.

---

## Dependencies

Zero at runtime, including the YAML parser. A security control plane should not drag a supply chain
behind it — the whole point is to reduce the number of things that must be trusted.

The parser implements a deliberately small, strict subset and raises `YamlError` with a line number
on anything outside it. For a risk policy, a loud parse failure is strictly safer than a quiet misread
limit.
