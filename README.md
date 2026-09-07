<div align="center">

<h1>🛡️ Aegis</h1>

### Binance Agent OS 的风控防火墙

**币安 Agent OS 赋予 AI 代理真实的市场权力。**
**Aegis 决定它被允许用这份权力做什么。**

<br/>

`20 条确定性规则` · `执行链路零 LLM` · `防篡改审计账本` · `零运行时依赖`

<br/>

[![测试](https://img.shields.io/badge/测试-211%20全部通过-brightgreen?style=flat-square)]()
[![依赖](https://img.shields.io/badge/运行时依赖-0-blue?style=flat-square)]()
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)]()
[![协议](https://img.shields.io/badge/协议-MIT-black?style=flat-square)]()

**币安 Agent OS Mini 黑客松 · 赛道 A 参赛作品**

[English](./README.en.md) · [架构设计](./docs/ARCHITECTURE.md) · [集成指南](./docs/INTEGRATION.md) · [演示脚本](./docs/DEMO-SCRIPT.md)

</div>

---

## 📌 目录

- [问题:被留给用户的那一层](#-问题被留给用户的那一层)
- [60 秒看懂](#-60-秒看懂)
- [安装与接入](#-安装与接入)
- [策略文件](#-策略文件)
- [20 条规则](#-20-条规则)
- [审计账本](#-审计账本)
- [守护进程](#-守护进程)
- [工程质量](#-工程质量)
- [安全模型](#-安全模型)
- [命令速查](#-命令速查)

---

## 🎯 问题:被留给用户的那一层

币安发布 Agent OS 当天,TechCrunch 的报道把缺口说得很直白:

> *"币安现在允许 AI 代理进行交易,**但管住它们这件事,基本上要靠用户自己**。"*
> —— TechCrunch,2026 年 8 月 20 日

币安把**执行轨道**造得很出色 —— MCP 服务器、`binance-cli`、Agentic 子账户、执行前确认机制。
但它有意留给用户的,是**策略与风控层**:能下多大、多频繁、交易什么、在什么条件下、事后留下什么证据。

今天这一层住在系统提示词里。

**而系统提示词不是风控措施。** 它可以被争辩、在长上下文中被遗忘、被提示注入攻破、在 40k token 处被静默截断。

**Aegis 就是这一层,而且是被认真实现的那一版。**

```
        ┌─────────────┐        ┌──────────────┐       ┌────────────────┐
        │  你的 AI 代理│──请求─▶│  🛡️  AEGIS   │──放行─▶│  币安 MCP      │
        │  (任意 LLM) │        │   策略引擎    │       │  binance-cli   │
        └─────────────┘        └───────┬──────┘       └────────────────┘
                                       │ 拒绝 / 需人工复核
                                       ▼
                            ┌──────────────────────┐
                            │   哈希链审计账本      │
                            │   记录每一次决策      │
                            └──────────────────────┘
```

**代理提议,Aegis 裁决,币安执行。**
执行链路中**没有任何 LLM** —— 相同输入永远产生相同裁决,且事后可逐条复算证明。

> 💡 **这不是又一个交易机器人。**
> 这是每一个跑在 Agent OS 上的交易机器人都缺失的那一层地基 —— 包括本次黑客松中的其他参赛作品。

---

## ⚡ 60 秒看懂

```bash
git clone https://github.com/blueskylh/Binance_Aegis.git && cd Binance_Aegis
npm install && npm run demo
```

**无需 API Key,无需网络,无资金风险。** 12 个场景约 4 秒跑完:

| # | 场景 | 裁决 | 触发的规则 |
|:--:|---|:--:|---|
| 01 | 读取市场行情 | ✅ 放行 | *(读操作永远免费)* |
| 02 | $150 现货买入,额度内 | ✅ 放行 | — |
| 03 | $400 买入,超出自主决策线 | ⚠️ **人工复核** | `review-threshold` |
| 04 | 单笔 $5,000 巨额下单 | ⛔ 拒绝 | `max-notional-per-order` |
| 05 | BTC 报价 $100,000 时挂 $9,000 限价买 | ⛔ 拒绝 | `price-deviation` |
| 06 | 20 倍杠杆合约,未附止损 | ⛔ 拒绝 | `max-leverage` + `require-stop-loss` |
| 07 | 授权范围外的山寨币 | ⛔ 拒绝 | `symbol-allowlist` |
| 08 | 向外部地址提币 | ⛔ 拒绝 | `category-denylist` |
| 09 | 60 秒内第 4 笔订单(失控循环) | ⛔ 拒绝 | `rate-limit-minute` |
| 10 | 超时重试导致的订单重放 | ⛔ 拒绝 | `duplicate-action` |
| 11 | 亏损后立即复仇性交易 | ⛔ 拒绝 | `daily-loss-limit` + `loss-cooldown` |
| 12 | **所有熔断器全部触发时的 reduce-only 平仓** | ✅ **放行** | *(平仓永不被拦)* |

随后 Demo 会**主动篡改账本中一条历史 `deny` 记录、改写成 `allow`** —— 哈希链验证器会在精确的序号上抓出这次伪造。

```
  TAMPER TEST
     正在把一条历史 DENY 记录改写成 ALLOW,模拟攻击者的做法…
     ✅ 已检出 — hash mismatch at seq 4: the payload was modified after it was written
        伪造在 seq 4 处被抓获;其后每一条哈希均不再匹配。
```

---

## 🔌 安装与接入

```bash
npm install && npm run build
node dist/src/cli/main.js init          # 生成 aegis.policy.yaml 并打印 MCP 接入配置
```

### 方式一:作为 MCP 服务器(推荐)

Aegis 作为**第二个 MCP 服务器**与币安的并肩运行。**币安负责执行,Aegis 负责授权。**

```bash
# 执行轨道
claude mcp add --transport http binance-mcp-server https://agent.binance.com/mcp/agentic

# 授权层
claude mcp add aegis -- node $(pwd)/dist/src/mcp/server.js --policy $(pwd)/policies/monitor-first.yaml
```

然后在代理的指令中加入这一段:

> 在执行任何下单、转账或改变敞口的币安操作**之前**,必须先调用 `aegis_guard_action`。
> 仅当裁决为 `allow` 时才可执行;`review` 视为硬性暂停,必须等待人工确认;`deny` 为最终结论。
> 每次成交后调用 `aegis_record_execution` 回报真实成交额与已实现盈亏。

<details>
<summary><b>暴露的 8 个 MCP 工具(点击展开)</b></summary>

| 工具 | 代理何时调用 |
|---|---|
| `aegis_guard_action` | **每一次**下单 / 转账 / 改变敞口**之前** |
| `aegis_record_execution` | **每一次**成交**之后** |
| `aegis_status` | "我还剩多少额度?" |
| `aegis_explain_policy` | "我的限额是什么?" / "为什么这笔被拦了?" |
| `aegis_verify_ledger` | 审计完整性校验 |
| `aegis_recent_decisions` | 事故复盘 |
| `aegis_emergency_stop` | "停" / "暂停" / "紧急停止" |
| `aegis_resume` | 仅在人类明确要求时 |

</details>

### 方式二:作为 CLI(Shell 代理、定时任务、CI)

**退出码本身就是集成方式** —— `0` = 放行或需复核,`1` = 拒绝。

```bash
aegis check --category trade --venue spot --symbol BTCUSDT --side BUY --quoteQuantity 250 \
  && binance-cli spot new-order --symbol BTCUSDT --side BUY --type MARKET --quoteOrderQty 250
```

一个 `&&` 就是完整的接入。

### 方式三:作为 Skills Hub 技能包

`skill/agent-os-risk-firewall/SKILL.md` 遵循
[binance-skills-hub](https://github.com/binance/binance-skills-hub) 的贡献格式,
兼容 Claude Code、OpenClaw、LangChain 与 CrewAI。

---

## 📋 策略文件

**一个可读的文件,就是全部安全姿态。** 默认拒绝 —— 你从未提及的能力,代理永远不会获得。

```yaml
version: 1
name: conservative-desk
mode: enforce          # enforce 强制 | monitor 仅观察 | simulate 空跑
default: deny          # 默认拒绝

limits:
  maxNotionalUsdPerOrder: 250    # 单笔名义金额上限
  maxDailyNotionalUsd: 1500      # 单日累计成交额
  maxOpenNotionalUsd: 750        # 总持仓敞口
  maxLeverage: 2                 # 杠杆天花板
  maxDailyLossUsd: 75            # 单日已实现亏损熔断
  maxDrawdownPct: 5              # 权益回撤熔断
  maxOrdersPerMinute: 2          # 每分钟下单数
  maxOrdersPerHour: 12           # 每小时下单数
  maxPositionsOpen: 2            # 并发持仓数

allow:                           # 白名单
  categories: ["read", "trade", "cancel"]
  venues: ["spot", "market-data"]
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"]

deny:                            # 黑名单优先级高于白名单
  categories: ["withdraw", "onchain", "transfer"]

guards:
  priceDeviationPct: 3           # 乌龙指 / 幻觉价格容差
  minAccountEquityUsd: 200       # 权益下限
  requireStopLoss: true          # 杠杆开仓必须带止损
  tradingHoursUtc: { from: "06:00", to: "22:00" }
  cooldownSecondsAfterLoss: 900  # 亏损后冷静期(反复仇交易)
  reviewAboveNotionalUsd: 100    # 超过此额度需人工确认
  blockDuplicateActionIds: true  # 阻断重放
```

内置三套开箱即用的策略:

| 策略文件 | 用途 |
|---|---|
| `policies/monitor-first.yaml` | **从这里开始。** 不拦截任何操作,只记录 —— 先观察代理"本会做什么" |
| `policies/conservative.yaml` | 首次实盘,或任何你输不起的账户 |
| `policies/balanced.yaml` | 已在观察模式下验证过的代理 |

> ⚠️ **未知字段是硬错误,不是警告。**
> 一个拼错的 `maxLevrage:` 会静默地变成"无限额" —— 这正是本项目要杜绝的失败模式。

---

## 📏 20 条规则

| 类别 | 规则 |
|---|---|
| **访问控制** | `kill-switch` · `category-allowlist`/`denylist` · `venue-allowlist`/`denylist` · `symbol-allowlist`/`denylist` · `default-posture` |
| **规模敞口** | `max-notional-per-order` · `max-daily-notional` · `max-open-exposure` · `max-positions-open` · `max-leverage` · `min-equity` |
| **亏损熔断** | `daily-loss-limit` · `max-drawdown` · `loss-cooldown` |
| **节奏控制** | `rate-limit-minute` · `rate-limit-hour` · `trading-hours` |
| **订单完整性** | `price-deviation`(乌龙指) · `require-stop-loss` · `duplicate-action`(重放) |
| **人机协同** | `review-threshold` |

完整规则参考见 [`skill/agent-os-risk-firewall/references/rules.md`](./skill/agent-os-risk-firewall/references/rules.md)。

### 三条贯穿全局的不变量

<table>
<tr>
<td width="33%" valign="top">

#### 1️⃣ 平仓永不被拦

所有熔断器都豁免撤单、`reduceOnly` 平仓单、以及 `STOP_MARKET` / `TAKE_PROFIT_MARKET` 保护性订单。

**一个会把你困在仓位里的风控系统,本身就是风险。**

这不是口号 —— 它由回归测试强制保障,并且在开发过程中**真的抓出了一个 bug**(限速规则原本会拦截 reduce-only 平仓单)。

</td>
<td width="33%" valign="top">

#### 2️⃣ 永远 fail closed

畸形动作、无法解析的策略文件、规则自身抛出异常 —— 一律产生 `deny`。

**绝不会意外产生 `allow`。**

已通过对抗性测试验证:面对 `null`、数字、超长字符串、原型污染等敌意输入,引擎**从不抛异常、从不 fail open**。

</td>
<td width="33%" valign="top">

#### 3️⃣ 前瞻而非回溯

所有限额问的是"**这笔执行后**敞口会是多少",而不是"现在是多少"。

回溯式限额,正是账户突破自己设定上限的原因。

</td>
</tr>
</table>

---

## 🔗 审计账本

每一次决策 —— **包括每一次放行** —— 都作为一行 JSON 追加写入,并与前一条哈希链接:

```
hash(n) = SHA-256( hash(n-1) ‖ canonicalJSON(seq, ts, type, payload) )
```

```bash
$ aegis ledger verify
  ✅ 账本完整 — 1,284 条记录通过哈希链校验
     head: c97e24813461ddf3d381a08d373c42448b5f1efc4bc25126c29591fc1fe656c7

$ aegis ledger verify   # 有人编辑了某条历史记录之后
  ❌ 账本已被篡改 — hash mismatch at seq 412: the payload was modified after it was written
     首个异常记录:seq 412
```

可检出四类篡改:**载荷改写**(哈希不匹配)、**记录删除/ 重排**(序号断裂)、**伪造追加**(链接断裂)、**非法字节**(解析失败)。

**为什么用 JSONL 而不是数据库:** 可 grep、可 diff、`cat` 一下就能推送到 S3 或 SIEM;
进程崩溃最多损失一行尾部残片 —— 读取器会在最后一条完整记录处干净停止,而不是丢弃整段有效历史。
写入是同步的:一条**可能没写成功**的审计记录,比几毫秒延迟糟糕得多。

序列化前会对 key 递归排序,确保独立验证方能算出相同摘要。

---

## 🚨 守护进程

策略引擎逐个动作裁决;守护进程则**按时间轮询整个账户** ——
这才能捕获那种**在代理毫无动作时到来的风险**:代理空闲时,持仓正在向不利方向移动。

```bash
aegis guardian --watch BTCUSDT,ETHUSDT --interval 60 --dry-run
```

触发熔断时,它会拉下总闸,并可选地撤销所有挂单。
**它从不平仓** —— 何时认赔离场是人类的决定。

它还**拒绝基于陈旧数据行动**:若 `binance-cli` 调用失败,快照会被保持,而不是被当作零权益读取 ——
一个在故障期间伪造出 100% 回撤、把所有熔断器同时打爆的监控系统,比没有监控更糟。

---

## 🧪 工程质量

```
211 个测试 · 0 失败 · 38 个套件 · 0 运行时依赖 · 6,177 行代码
```

```bash
npm test        # 211 个测试:单元测试 + 真实进程级 stdio E2E
npm run verify  # 测试 + 完整 Demo 场景
```

- **纯函数引擎。** `evaluate(action, policy, context) → decision` 不做 I/O、不读时钟、不修改任何入参。每一条决策都可从账本复现。
- **真进程级 E2E。** 测试会真实 spawn CLI 与 MCP 服务器子进程,通过 stdio 对话 —— 与 Claude Code 的方式完全一致。
- **零依赖,包括 YAML 解析器。** 安全控制平面不该拖着供应链。TypeScript `strict` + `noUncheckedIndexedAccess`。
- **测试先行构建。** 开发中浮现两个真实缺陷,均在根因处修复并各配回归测试 —— 其中最重要的一个,是限速器会拦截 reduce-only 平仓单,违反了上文的不变量 ①。

```
src/
├── core/
│   ├── engine.ts          # 纯函数 evaluate()
│   ├── normalize.ts       # 所有下单形态 → 统一 USD 名义金额
│   └── rules/             # 访问 · 规模 · 亏损 · 节奏 · 完整性
├── policy/                # 严格 Schema + 零依赖 YAML 子集解析器
├── ledger/                # 哈希链与校验
├── state/                 # 滚动计数器,全部从账本重建
├── adapters/binance.ts    # 只读 binance-cli 适配器
├── guardian/              # 组合层熔断器
├── mcp/                   # MCP 服务器(协议处理 + stdio 传输分离)
└── cli/                   # aegis 命令
```

---

## 🔐 安全模型

| 项目 | 设计 |
|---|---|
| 持有凭证 | **无** —— Aegis 只负责授权,由 `binance-cli` 执行 |
| 下单能力 | **无** —— 唯一的写操作是 `cancel-all-open-orders`,而它只会降低风险 |
| 提币路径 | **无**,与币安 Agentic 子账户模型一致 |
| 供应链 | 零运行时依赖 |
| 命令注入 | 使用 `execFile` 且不经过 shell,无插值面 |
| 数据落盘 | `~/.aegis`(可用 `AEGIS_HOME` 覆盖),原子写入(临时文件 + rename) |

---

## 📖 命令速查

```
aegis check <action>        评估一个待执行动作           (退出码 1 = 被拒绝)
aegis record --actionId ..  记录成交,推进额度计数器
aegis status                风险姿态、回撤、额度进度条
aegis rules                 列出 20 条生效规则
aegis policy show|validate  查看 / 校验策略文件
aegis ledger verify|tail    审计账本
aegis halt <reason>         拉下总闸
aegis resume [--reset-peak] 恢复运行
aegis init [path]           生成初始策略 + MCP 接入配置
aegis mcp                   以 stdio 运行 MCP 服务器
aegis guardian [...]        运行熔断守护进程
aegis demo                  12 场景完整演示
```

---

## 📂 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 为什么引擎是纯函数、哈希链如何工作、三条不变量的实现 |
| [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) | MCP / CLI / 库三种接入方式、灰度上线流程、故障模式对照表 |
| [`docs/DEMO-SCRIPT.md`](./docs/DEMO-SCRIPT.md) | 2 分钟演示视频分镜与逐句台词 |
| [`docs/SUBMISSION.md`](./docs/SUBMISSION.md) | 黑客松评委速查页 |

---

## ⚖️ 免责声明

Aegis 是一款风险控制工具。它**不构成投资建议**,不保证不发生亏损,也无法把一个亏损策略变成盈利策略 ——
它所做的,是**缩小代理犯错时的爆炸半径**。

你仍然需要对自己的代理、你所配置的策略、以及每一笔下单负全部责任。数字资产交易存在重大风险。

本项目与币安无隶属关系,亦未获得币安背书。

<div align="center">

<br/>

**MIT License**

*币安给了代理力量。Aegis 把控制权还给你。*

</div>
