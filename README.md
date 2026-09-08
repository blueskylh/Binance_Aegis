<div align="center">

<h1>🛡️ Aegis</h1>

### Binance Agent OS 的执行控制平面

**代理提议 · Aegis 裁决 · 币安执行**

`23 条确定性规则` · `执行链路零 LLM` · `哈希链审计账本` · `333 个测试` · `零运行时依赖`

**Binance Agent OS Mini Hackathon · Track A**

[English](./README.en.md) · [安全模型](./docs/SECURITY.md) · [架构设计](./docs/ARCHITECTURE.md) · [集成指南](./docs/INTEGRATION.md) · [评委速查](./docs/SUBMISSION.md)

</div>

---

## 为什么需要 Aegis

Binance Agent OS 给 AI Agent 提供真实的市场执行能力，但“允许交易”和“应该允许这笔交易”是两件不同的事。

很多所谓的风控 Agent 只是把一个检查工具放在交易工具旁边，再靠系统提示词要求模型“先检查”。这仍然是建议：如果 Agent 同时持有 Binance 写入工具，它可以因为 bug、提示注入或上下文漂移直接绕过检查。

Aegis 的 **Gateway mode** 改变的是拓扑，而不只是提示词：

```text
Agent  ──▶  Aegis  ──▶  Binance
```

Agent 不持有独立 Binance 写入能力；Aegis 持有执行凭证，并且只在策略判定允许时触发执行。

> **Most risk agents advise. Aegis enforces.**

---

## 60 秒验证

```bash
git clone https://github.com/blueskylh/Binance_Aegis.git
cd Binance_Aegis
npm install
npm run demo
```

无需 API Key、无需网络、不会触碰真实资金。Demo 会自动验证以下场景：

- 合规小额订单正常放行
- $5,000 超额订单被阻断，Binance 不被调用
- 合法但超过自主权限的订单进入人工审批
- Prompt Injection 尝试提币被结构性阻断
- 伪造 `reduceOnly` 无法绕过额度限制
- 所有熔断器触发后，新风险仍被阻断
- **经过验证的 reduce-only 平仓仍然能够退出**
- 篡改历史审计记录会被哈希链检测

然后运行完整测试：

```bash
npm test
```

当前版本：**333 tests · 0 failures**。

---

## 核心设计

### 1. 确定性策略引擎

```text
evaluate(action, policy, context) → decision
```

23 条规则覆盖访问控制、订单规模、敞口、亏损熔断、节奏控制、订单完整性与人工审批。执行路径中没有 LLM，相同输入得到相同结果。

### 2. Gateway：唯一写路径

Gateway mode 下，Aegis 是 Agent 到 Binance 的唯一执行入口。未支持的能力会被拒绝，而不是静默改道。

当前 Gateway 写入范围故意保持窄：

- Spot
- USD-M Futures

Margin、COIN-M、Convert、Wallet、On-chain 等未实现路径一律拒绝。

### 3. Human-in-the-loop

超过自主阈值的操作不会自动执行，而是进入持久化审批队列。审批票据：

- 单次使用
- 与原动作摘要绑定
- 兑付时重新评估
- 并发下保持动作级幂等

### 4. 审计账本

每一次决策——包括 `ALLOW`——都会进入哈希链 JSONL 账本。

```text
hash(n) = H(hash(n-1) || canonicalJSON(entry_n))
```

默认 SHA-256 模式是 **tamper-evident**；设置 `AEGIS_LEDGER_KEY` 后使用 HMAC，可显著提高本地伪造成本。

### 5. Fail closed

以下情况都会拒绝，而不是猜测：

- 畸形动作
- 未知策略字段
- 无法确定订单尺寸
- 不支持的 venue / capability
- 过期的仓位证据
- 并发重复动作
- 审批竞争
- 锁获取失败

---

## 三条最重要的不变量

**1. What is judged is what is sent.** 归一化阶段解析最终执行尺寸，Gateway 发送的就是被策略引擎判定的那一笔。

**2. Verified exits remain available.** 经过真实仓位验证的降险操作不会因为日亏、回撤、冷静期、额度或 Kill Switch 而被困住。

**3. No second path in Gateway mode.** 如果你又把 Binance 写工具直接交给 Agent，Aegis 就退化成 Advisory mode。Gateway 部署要求明确禁止这种双写路径。

---

## 接入

### MCP Gateway

```bash
npm install && npm run build
node dist/src/cli/main.js init

node dist/src/cli/main.js mcp \
  --gateway \
  --policy ./policies/conservative.yaml
```

部署时不要同时把 Binance 写入 MCP 暴露给同一个 Agent，也不要把 API Key 留在 Agent 环境中。

### CLI

```bash
aegis execute --category trade --venue spot \
  --symbol BTCUSDT --side BUY --quoteQuantity 250 --live
```

退出码：

| Code | Meaning |
|---:|---|
| `0` | ALLOW |
| `1` | DENY |
| `2` | USAGE ERROR |
| `3` | REVIEW — 需要人工确认 |

`REVIEW` 故意使用非零退出码，避免 shell 的 `&&` 误把待审批订单继续执行。

---

## 工程质量

- **333 tests / 0 failures**
- 23 deterministic rules
- TypeScript strict mode
- 0 runtime dependencies
- Real-process CLI + MCP stdio E2E
- Security / gateway / sizing / concurrency regression suites
- Docker build verification
- Final gate: **judged action === wire action**

Aegis 的安全缺陷不会被隐藏。历史审计发现、根因和回归测试全部公开记录在 [`docs/SECURITY.md`](./docs/SECURITY.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/SUBMISSION.md`](./docs/SUBMISSION.md) | **评委 90 秒速查页** |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | 威胁模型、保证边界、公开审计历史 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 系统分层、执行边界、不变量 |
| [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) | Gateway / Advisory / Library 接入说明 |

---

## Disclaimer

Aegis 是风险控制工具，不构成投资建议，不保证避免亏损，也不能让一个亏损策略变成盈利策略。它的目标是限制 AI Agent 出错时的爆炸半径。

本项目与 Binance 无隶属关系，亦未获得 Binance 背书。

MIT License.
