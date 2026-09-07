# Integration guide

Three ways in, in ascending order of coupling. Pick one — they all enforce identically, because
they all call the same `Aegis` facade.

---

## 1. MCP server (recommended for Claude Code, Claude Desktop, Codex, Cursor)

Aegis runs as a second MCP server beside the Binance one. **Binance executes; Aegis authorizes.**

```bash
# Execution rails
claude mcp add --transport http binance-mcp-server https://agent.binance.com/mcp/agentic

# Authorization layer
claude mcp add aegis -- node /abs/path/to/aegis/dist/src/mcp/server.js \
  --policy /abs/path/to/aegis/policies/monitor-first.yaml
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "binance-mcp-server": {
      "type": "http",
      "url": "https://agent.binance.com/mcp/agentic"
    },
    "aegis": {
      "command": "node",
      "args": ["/abs/path/to/aegis/dist/src/mcp/server.js", "--policy", "/abs/path/to/policy.yaml"]
    }
  }
}
```

### Tools exposed

| Tool | When the agent calls it |
|---|---|
| `aegis_guard_action` | **Before** every order / transfer / exposure change |
| `aegis_record_execution` | **After** every fill |
| `aegis_status` | "How much room is left?" |
| `aegis_explain_policy` | "What are my limits?" / "Why was that blocked?" |
| `aegis_verify_ledger` | Audit integrity check |
| `aegis_recent_decisions` | Incident review |
| `aegis_emergency_stop` | "Stop" / "halt" / "panic" |
| `aegis_resume` | Only on explicit human request |

### System prompt to add

Copy this verbatim into `CLAUDE.md`, `AGENTS.md` or your system prompt:

```markdown
## Risk control — non-negotiable

Aegis is the risk firewall for this account. Before ANY Binance action that places an order,
moves funds, or changes exposure, call `aegis_guard_action` with the proposed action.

- verdict `allow`  → proceed with the Binance MCP call.
- verdict `review` → STOP. Show the user the finding messages and wait for explicit confirmation.
                     Silence is not approval.
- verdict `deny`   → do NOT proceed. Relay the finding messages verbatim. Do not retry with a
                     smaller size to slip under a limit unless the user explicitly asks you to resize.

After any order fills, call `aegis_record_execution` with the ACTUAL filled notional and realized
PnL, reusing the actionId from the guard call. If you skip this, every budget and loss limit goes blind.

Never edit the ledger. Never call `aegis_resume` on your own initiative. If the user says stop,
halt, or panic — call `aegis_emergency_stop` first, then explain what remains open.
```

---

## 2. CLI (shell agents, cron jobs, CI)

The exit code *is* the integration: `0` = allow or review, `1` = deny, `2` = bad input.

```bash
#!/usr/bin/env bash
set -euo pipefail

SYMBOL=BTCUSDT
NOTIONAL=250
ID="trade-$(date +%s)"

# 1. Ask permission
if ! aegis check --id "$ID" --category trade --venue spot \
       --symbol "$SYMBOL" --side BUY --orderType MARKET --quoteQuantity "$NOTIONAL"; then
  echo "Blocked by policy — not trading."
  exit 1
fi

# 2. Execute through Binance Agent OS
FILL=$(binance-cli spot new-order --symbol "$SYMBOL" --side BUY \
         --type MARKET --quoteOrderQty "$NOTIONAL")

# 3. Report back so the counters move
aegis record --actionId "$ID" --notionalUsd "$NOTIONAL" --symbol "$SYMBOL" --realizedPnlUsd 0
```

For machine parsing, add `--json` to any command.

---

## 3. Library (TypeScript / JavaScript agents)

```ts
import { Aegis } from '@aegis/agent-os-firewall';

const aegis = new Aegis({ policyPath: './policies/conservative.yaml' });

// Keep the firewall's world view fresh.
aegis.updateAccount({
  equityUsd: 10_000,
  positions: [],
  marks: { BTCUSDT: 100_000 },
});

const verdict = aegis.guard({
  id: 'trade-001',
  category: 'trade',
  venue: 'spot',
  symbol: 'BTCUSDT',
  side: 'BUY',
  orderType: 'MARKET',
  quoteQuantity: 250,
});

if (verdict.verdict === 'deny') {
  throw new Error(verdict.summary);
}
if (verdict.verdict === 'review') {
  await askHuman(verdict.findings);   // your confirmation flow
}

const fill = await placeOrderViaBinance();

aegis.recordExecution({
  actionId: verdict.actionId,
  category: 'trade',
  venue: 'spot',
  symbol: 'BTCUSDT',
  notionalUsd: fill.notionalUsd,
  realizedPnlUsd: 0,
});
```

The engine is also exported standalone if you want to evaluate without any persistence:

```ts
import { evaluate, loadPolicyFile } from '@aegis/agent-os-firewall';
const decision = evaluate(action, loadPolicyFile('./policy.yaml'), context);
```

---

## Rollout sequence

Do not start in `enforce`. The point of `monitor` mode is to learn your own limits from real flow.

1. **Day 1–3 — `policies/monitor-first.yaml`.**
   Nothing is blocked; every violation is downgraded to `review` and written to the ledger.
   ```bash
   aegis ledger tail 50      # what would have been caught
   aegis status              # where the budgets actually sit
   ```
2. **Tune.** If a limit fires constantly on legitimate flow, it is the wrong limit — raise it
   deliberately rather than letting the agent learn to route around it.
3. **Day 4 — switch `mode: enforce`**, keep `reviewAboveNotionalUsd` low so a human still sees
   anything meaningful.
4. **Then** raise the autonomy threshold as confidence builds.
5. **Always** run the guardian in `--dry-run` for a day before `--live`.

---

## Operational notes

| | |
|---|---|
| Data location | `~/.aegis` — override with `AEGIS_HOME` |
| Policy location | `--policy` flag, or `AEGIS_POLICY` |
| Ledger growth | ~400 bytes per decision; rotate by moving the file (verification is per-file) |
| Backups | `ledger.jsonl` is append-only — `rsync`/S3-sync it; `state.json` is disposable |
| Multiple agents | Give each its own `--data-dir` for independent budgets, or share one to pool them |
| Docker | `docker build -t aegis . && docker run -v aegis-data:/data aegis status` |

## Failure modes and what happens

| Situation | Behaviour |
|---|---|
| Policy file has a typo | Refuses to start, names the bad key and line |
| Action cannot be sized | `deny` with `malformed-action` |
| A rule throws | `deny` with `:internal-error`; the engine continues |
| `binance-cli` missing | Enforcement continues on the last snapshot; guardian skips breakers |
| Ledger edited | `aegis ledger verify` exits 1 and names the sequence number |
| Process crashes mid-write | At most one partial trailing line; the prefix stays valid |
| State file corrupted | Falls back to safe zeroed state; the ledger keeps the real history |
