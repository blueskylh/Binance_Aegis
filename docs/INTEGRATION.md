# Integration guide

Two modes. The difference is not cosmetic — it decides whether Aegis is a control or a suggestion.

---

## Gateway mode — enforced (use this)

```
agent ──▶ Aegis ──▶ Binance
```

The agent is given **no Binance write tool at all**. Aegis holds the `binance-cli` profile and
exposes one execution tool. "No Binance write without an Aegis decision" stops being a claim about
agent behaviour and becomes a property of the deployment.

```bash
npm install && npm run build
node dist/src/cli/main.js init

claude mcp add aegis -- node $(pwd)/dist/src/mcp/server.js \
  --gateway --policy $(pwd)/policies/monitor-first.yaml
```

```json
{
  "mcpServers": {
    "aegis": {
      "command": "node",
      "args": ["/abs/path/dist/src/mcp/server.js", "--gateway", "--policy", "/abs/path/policy.yaml"]
    }
  }
}
```

> ⚠️ **Do not also register the Binance MCP server, and keep API keys out of the agent's
> environment.** Aegis cannot revoke a capability you hand out separately. If both are registered you
> are in advisory mode whether you meant to be or not.

### System prompt

```markdown
## Execution control — non-negotiable

Every Binance action goes through `aegis_execute`. It is the only path to the exchange.

- status `executed`          → report the real fill.
- status `accepted-unfilled` → the order is RESTING. Do not say it filled.
- status `pending-approval`  → STOP. Show the findings and the ticket id, wait for the human.
- status `blocked`           → do NOT proceed. Relay the reason verbatim. Do not retry smaller
                               unless the user explicitly asks you to resize.
- status `failed`            → the venue rejected it. Report the error.

Retrying after a timeout: reuse the SAME `id`. Aegis dedupes; a fresh id creates a second position.

For leveraged entries supply a real `stopPrice`. `hasStopLoss: true` is not accepted — Aegis
validates the price and places the stop itself.

Never call `aegis_approve` or `aegis_resume` on your own initiative.
```

---

## Advisory mode — a check, not a firewall

```
agent ──▶ Aegis          (asks politely)
     └──▶ Binance MCP    (…and can skip the asking)
```

Useful against the *confused* agent — limits, audit trail, kill-switch — but a prompt-injected one
can call Binance directly and Aegis never sees the order. Use it only when you genuinely cannot take
the credentials away.

```bash
#!/usr/bin/env bash
set -euo pipefail
ID="trade-$(date +%s)"

aegis check --id "$ID" --category trade --venue spot \
  --symbol BTCUSDT --side BUY --orderType MARKET --quoteQuantity 250
CODE=$?

case $CODE in
  0) : ;;                                                    # allow
  3) echo "Human approval required — not trading."; exit 0 ;; # review
  *) echo "Blocked by policy."; exit 1 ;;                     # deny / usage
esac

binance-cli spot new-order --symbol BTCUSDT --side BUY --rtype MARKET --quote-order-qty 250
aegis record --actionId "$ID" --notionalUsd 250 --symbol BTCUSDT --realizedPnlUsd 0
```

### Exit codes

| Code | Meaning | `&&` continues? |
|:--:|---|:--:|
| `0` | ALLOW | yes |
| `1` | DENY | no |
| `2` | USAGE error | no |
| `3` | **REVIEW — human must confirm** | **no** |

`review` is non-zero deliberately. In v1.0.0 it shared `0` with allow, so the documented one-liner
auto-executed exactly the orders a human was meant to approve.

---

## Library

```ts
import { Aegis } from '@aegis/agent-os-firewall';
import { ExecutionGateway } from '@aegis/agent-os-firewall/gateway';
import { BinanceAdapter } from '@aegis/agent-os-firewall/adapters';

const aegis = new Aegis({ policyPath: './policies/conservative.yaml' });
const adapter = new BinanceAdapter();
const gw = new ExecutionGateway(aegis, adapter, { refresher: adapter });

const r = await gw.execute({
  id: 'trade-001',
  category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
  side: 'BUY', orderType: 'MARKET', quoteQuantity: 250, stopPrice: 95_000,
});

if (r.status === 'pending-approval') await askHuman(r.ticketId, r.decision.findings);
if (r.status === 'executed') console.log(r.fill?.orderId, r.protectiveStop?.orderId);
```

The engine is also exported standalone:

```ts
import { evaluate, loadPolicyFile } from '@aegis/agent-os-firewall';
const decision = evaluate(action, loadPolicyFile('./policy.yaml'), context);
```

---

## Rollout sequence

Do not start in `enforce`. The point of `monitor` is to learn your real limits from real flow.

1. **Day 1–3 — `policies/monitor-first.yaml`.** Nothing is hard-blocked; every violation becomes a
   review and lands in the ledger.
   ```bash
   aegis ledger tail 50
   aegis status
   ```
2. **Tune.** A limit that fires constantly on legitimate flow is the wrong limit. Raise it
   deliberately rather than letting the agent learn to route around it.
3. **Switch `mode: enforce`**, keeping `reviewAboveNotionalUsd` low.
4. **Run `aegis execute` without `--live`** for a session and read the dry-run verdicts.
5. **Go live**, and keep the guardian running so exit verification has fresh positions.

---

## Operational notes

| | |
|---|---|
| Data | `~/.aegis` — override with `AEGIS_HOME`. Holds `ledger.jsonl`, `state.json`, `approvals.json`, `inflight.json` |
| Policy | `--policy`, or `AEGIS_POLICY` |
| Audit signing | Set `AEGIS_LEDGER_KEY` for HMAC mode; keep it out of the agent's environment |
| Ledger growth | ~400 bytes per decision; rotate by moving the file (verification is per-file) |
| Backups | `ledger.jsonl` is append-only — rsync it. `state.json` is disposable |
| Snapshot freshness | Run `aegis guardian`, or `aegis sync` before reasoning about exits |
| Multiple agents | Separate `--data-dir` for independent budgets; share one to pool them |
| After a CLI upgrade | Re-run `aegis doctor` |

## Failure modes

| Situation | Behaviour |
|---|---|
| Policy typo | Refuses to start, names the bad key and line |
| Action cannot be sized | `deny` with `malformed-action` |
| Derivatives order with no mark | `deny` — Aegis will not send a quantity it did not judge |
| Unsupported venue | `deny` with `unsupported-execution-capability`; **never rerouted** |
| A rule throws | `deny` with `:internal-error`; the engine continues |
| `binance-cli` missing | Enforcement continues on the last snapshot; stale exits are refused |
| Order rests unfilled | `accepted-unfilled`; **no budget consumed** |
| Concurrent duplicate id | `deny` with `action-in-flight`; exactly one executes |
| Approval race | The file lock ensures exactly one redemption |
| Ledger edited | `aegis ledger verify` exits 1 and names the sequence number |
| Crash mid-write | At most one partial trailing line; the prefix stays valid |
| Corrupt `approvals.json` | Degrades to "nothing approved", never "everything approved" |
