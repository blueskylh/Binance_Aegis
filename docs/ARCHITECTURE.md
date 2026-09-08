# Architecture

## One sentence

`evaluate(action, policy, context) → decision` is a pure deterministic function; the rest of Aegis exists to feed it trustworthy inputs, preserve evidence, and ensure that in gateway mode nothing reaches Binance without passing through that decision.

---

## Layering

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Integrations       CLI · MCP server · Guardian                     │
├──────────────────────────────────────────────────────────────────────┤
│ Execution Gateway  only supported write path · approvals · fills    │
├──────────────────────────────────────────────────────────────────────┤
│ Aegis facade       orchestration                                    │
├──────────────────────────────────────────────────────────────────────┤
│ Pure engine        normalize → 23 rules → aggregate → mode           │
├──────────────────────────────────────────────────────────────────────┤
│ Evidence           Ledger · RiskStore · approval / in-flight state   │
├──────────────────────────────────────────────────────────────────────┤
│ Binance adapter    market/account reads + supported order execution  │
└──────────────────────────────────────────────────────────────────────┘
```

All front doors share the same core policy engine. The CLI, MCP server and gateway do not implement separate risk logic.

---

## Why the engine is pure

The policy engine performs no I/O, reads no wall clock directly, and does not mutate its inputs. Time and account state are injected through the risk context.

That gives Aegis three useful properties:

1. **Reproducibility** — a decision can be re-evaluated from the same action, policy and context.
2. **Testability** — the rule engine can be exercised without network calls or exchange credentials.
3. **No hidden rule state** — limits cannot drift because a rule secretly accumulated state between calls.

---

## Normalization: one executable interpretation

Agents can express an order size in several ways. A risk limit is meaningless if one layer believes `quoteQuantity` while another layer sends `quantity`.

Aegis therefore normalizes before policy evaluation and refuses ambiguous sizing.

Important invariants include:

- `quantity` and `quoteQuantity` cannot both describe the same trade.
- MARKET orders using base quantity are valued from a trusted market mark, not a caller-supplied fake price.
- LIMIT orders use the actual limit price.
- Derivatives quote-sized orders resolve the base quantity before execution.
- Before returning from normalization, the judged notional must remain consistent with the executable quantity and reference price.

If Aegis cannot size an action confidently, it fails closed.

---

## Rule model

Each rule has the shape:

```text
(action, policy, context) → Finding[]
```

Returning findings instead of a boolean means the caller can see every violated constraint rather than only the first one.

Verdicts aggregate by severity:

```text
DENY > REVIEW > ALLOW
```

The engine currently registers 23 deterministic rules covering access, size, loss, tempo, order integrity and human escalation.

---

## Core invariants

### 1. Verified exits remain available

Risk-reducing actions are not trusted merely because the caller says `reduceOnly`. Aegis verifies the claim against position direction, size and snapshot freshness.

Once an action is verified as genuinely risk-reducing, breakers such as kill-switch, daily loss, drawdown, cooldown, rate limits, size caps and review thresholds stand aside.

The purpose is simple: a risk system must not trap the operator inside a position.

### 2. Fail closed

Examples:

- malformed action → deny
- unknown policy key → refuse policy
- unsupported gateway capability → deny
- stale evidence → refuse the exemption
- unresolved execution quantity → deny
- lock / concurrency failure → refuse rather than continue

### 3. Prospective controls

Limits ask what account state would become **if this action executed**, not merely what the account looks like before the action.

### 4. Judged action equals wire action

This is the final execution-boundary property.

The sizing, venue and order semantics evaluated by the policy engine must be the same ones delivered to the execution adapter. Regression tests attack this property directly across the sizing input space.

---

## Gateway mode vs advisory mode

### Gateway mode

```text
Agent ──▶ Aegis ──▶ Binance
```

The agent has no independent Binance write tool. Aegis holds the execution capability and becomes the only write path.

This is the enforced deployment model.

### Advisory mode

```text
Agent ──▶ Aegis
     └──▶ Binance
```

If the agent also has a direct Binance write tool, Aegis can only advise. A prompt-injected or buggy agent may bypass the check entirely.

This distinction is architectural, not cosmetic.

---

## Execution gateway

The gateway performs the sequence that must remain atomic from the safety model's perspective:

```text
proposal
  ↓
reserve action id
  ↓
refresh relevant account / market evidence
  ↓
normalize
  ↓
policy decision
  ↓
ALLOW ──▶ dispatch supported order
REVIEW ─▶ durable approval ticket
DENY ───▶ nothing sent
  ↓
reconcile real execution status / fill
  ↓
record evidence
```

Gateway capabilities are deliberately narrow. Current live order execution covers:

- Spot
- USD-M Futures

Unsupported venues are denied and never silently rerouted.

For leveraged risk-increasing entries, Aegis restricts execution to order types it can reconcile synchronously. Partial fills cancel the unreconciled remainder.

---

## Human approval

A `REVIEW` verdict creates a durable approval ticket rather than sending an order.

Tickets are:

- persisted across processes
- single-use
- digest-bound to the original action
- re-evaluated when redeemed
- protected by action-level in-flight reservation

This means approval is consent, not a bypass. If account state changes or a kill-switch is engaged after the ticket is created, the redeemed action can still be refused.

---

## Binance adapter

The adapter is the exchange-facing boundary used by the gateway and guardian.

It provides:

- market marks
- account equity / position snapshots
- supported Spot and USD-M order placement
- protective stop placement where supported
- cancellation used by the gateway / guardian for risk reduction

The adapter uses `execFile` without a shell, avoiding string interpolation through a shell command surface.

A key design rule is that the adapter must not reinterpret an action after policy evaluation. Resolved execution quantity is passed through rather than re-derived downstream.

---

## Fill reconciliation

Requested size is not treated as executed size.

The gateway distinguishes statuses such as:

- filled
- partially filled
- resting / accepted-unfilled
- rejected / failed

Budgets and counters move from actual execution evidence. Missing fill data never means “assume the request filled.”

---

## Protective stops

For supported leveraged entries, the agent must provide a concrete `stopPrice`. A bare boolean such as `hasStopLoss: true` is not evidence.

The stop is checked for direction and sane distance. After an entry fill, Aegis places the protective stop using the actual filled quantity.

A current limitation remains documented: later stop fills are not reconciled back into realized PnL by a dedicated lifecycle daemon.

---

## Audit ledger

Every decision is appended as one JSON object per line and chained to its predecessor.

```text
hash(n) = H(hash(n-1) || canonicalJSON(entry_n))
```

`canonicalJSON` sorts keys recursively so independent verification produces the same digest.

The unkeyed mode is **tamper-evident**, not tamper-proof. With `AEGIS_LEDGER_KEY`, the chain uses HMAC so recomputing a forged history also requires the operator-held key.

---

## State

Aegis persists only the state that needs to survive process boundaries:

- account snapshot / marks
- equity high-water mark
- kill-switch
- approval tickets
- in-flight reservations
- audit ledger

Rolling counters are derived from recorded executions rather than blindly incremented from agent claims.

---

## Guardian

The policy engine evaluates one proposed action. The guardian evaluates the wider account on a timer.

It can trip the kill-switch and cancel resting orders when configured breakers fire. It does not blindly flatten positions.

Stale account data is treated explicitly; unavailable evidence is not converted into a fabricated zero-equity state.

---

## MCP

The MCP transport is intentionally thin. Tool calls reach the same Aegis facade and execution gateway used by the CLI.

In gateway mode the important tool is `aegis_execute`: the agent proposes an action and receives a status such as executed, pending approval, blocked or failed.

The deployment requirement is critical: do not simultaneously expose a separate Binance write MCP to the same agent if you expect gateway enforcement.

---

## Dependencies

Aegis has zero runtime dependencies, including its strict YAML subset parser.

TypeScript is compiled with strict settings, and the test suite includes unit tests, real-process CLI/MCP E2E, security regressions, gateway hardening, sizing sweeps and the final judged-action-equals-wire-action gate.
