# Demo video script — 2 minutes

Track A requires **a video or demo plus your GitHub**. This is the shot list. Everything runs
offline, so nothing can fail live.

**Before recording:** `npm install && npm run build`, terminal at ~100 columns, dark theme.

---

## 0:00 – 0:20 · The problem

> "When Binance shipped Agent OS, TechCrunch's headline said it best: Binance now lets AI agents
> trade, but *keeping them in check is largely up to users*.
>
> Binance built the execution rails. The policy layer — how much, how often, on what — is left to
> you. Today that lives in a system prompt. A system prompt is not a risk control. It can be argued
> with, forgotten mid-context, or injected into.
>
> Aegis is that layer, built properly."

*On screen:* the README architecture diagram.

---

## 0:20 – 0:35 · What it is

> "Aegis sits between any AI agent and Binance. The agent proposes an action, Aegis judges it
> against a declarative policy, and only then does Binance execute. Twenty deterministic rules.
> No LLM anywhere in the enforcement path. Every decision hash-chained into a tamper-evident ledger."

```bash
node dist/src/cli/main.js rules
```

*Let the 20-rule table land on screen.*

---

## 0:35 – 1:20 · The demo — the centrepiece

```bash
npm run demo
```

Narrate over the scroll — do not read every line:

- **Beats 1–2** — "A well-behaved agent is not slowed down. Reads are free; a $150 buy inside budget
  just goes through."
- **Beat 3** — "$400 is legal but above the autonomy line. Aegis doesn't block it — it hands the
  decision back to a human. That's the workflow, not just a wall."
- **Beat 5** — *pause here* — "A limit buy at nine thousand dollars while Bitcoin trades at a
  hundred thousand. That's the stale-context failure every LLM trader hits eventually. Caught."
- **Beat 8** — "A withdrawal to an external address. Jailbreak, prompt injection or plain bug —
  structurally impossible under this policy."
- **Beat 9** — "Four orders in sixty seconds. Agents don't usually place one catastrophic order;
  they place two hundred small ones. This is the brake."
- **Beat 12** — *pause here* — "Every breaker is now tripped. And a reduce-only exit still passes.
  A risk system that traps you in a position **is** the risk. That invariant is enforced by three
  regression tests — it caught a real bug in this codebase."

---

## 1:20 – 1:40 · The audit ledger

*The demo's tamper test is already on screen.*

> "Every decision, including every allow, is hash-chained. Here the demo rewrites one historical
> DENY into an ALLOW — exactly what a bad actor would do — and verification catches the forgery at
> the precise sequence number. You can prove what your agent was permitted to do, not just what it did."

```bash
node dist/src/cli/main.js ledger verify
```

---

## 1:40 – 1:55 · Real integration

> "Two ways in. As an MCP server, it sits alongside the Binance MCP server: Binance executes,
> Aegis authorizes."

```bash
claude mcp add aegis -- node $(pwd)/dist/src/mcp/server.js --policy ./policies/conservative.yaml
```

> "Or as a CLI, where the exit code *is* the integration — deny exits 1, so `&&` is the whole thing."

```bash
aegis check --category trade --venue spot --symbol BTCUSDT --side BUY --quoteQuantity 250 \
  && binance-cli spot new-order --symbol BTCUSDT --side BUY --type MARKET --quoteOrderQty 250
```

---

## 1:55 – 2:00 · Close

```bash
npm test
```

> "211 tests. Zero runtime dependencies. Built test-first.
>
> Binance gave agents power. Aegis gives you control."

*End on the green test summary.*

---

## Backup shots

```bash
node dist/src/cli/main.js status                       # budget bars
node dist/src/cli/main.js check --category trade --venue spot \
  --symbol BTCUSDT --side BUY --quoteQuantity 5000     # a single clean deny
node dist/src/cli/main.js ledger tail 10               # the audit table
node dist/src/cli/main.js guardian --once --dry-run    # the daemon
```

## Submission checklist

- [ ] Follow [@Binance](https://x.com/binance) and repost the [announcement](https://x.com/binance/status/2094810011557838988)
- [ ] Reply / quote-repost with the video **and** the GitHub link
- [ ] Complete the [survey](https://www.binance.com/en/survey/2913aa200aac462c89a737779393f3d4)
- [ ] Deadline: **8 Sept 2026, 23:59 UTC**
- [ ] Optional but high-value: open a PR adding `skill/agent-os-risk-firewall/` to
      [binance/binance-skills-hub](https://github.com/binance/binance-skills-hub)
