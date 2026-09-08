# Aegis — 演示文稿 / Pitch Deck

面向币安 Agent OS Mini 黑客松 Track A 的 10 页中文提案 PPT。

| | |
|---|---|
| 文件 | [`Aegis-Pitch-Deck-zh.pptx`](./Aegis-Pitch-Deck-zh.pptx) |
| 页数 | 10 · 16:9 (13.33in × 7.50in) |
| 原生对象 | 588 个 DrawingML 形状,其中 192 个为可编辑文本 |
| 位图 | **0** — 全部为原生矢量,在 PowerPoint 中可继续编辑 |
| 生成方式 | [PPT Master](https://github.com/hugohe3/ppt-master) v6.3.0 · Quick Generate profile |
| 视觉风格 | `dark-tech` — 深色画布、发光强调、几何精度 |

## 页面结构

| # | 页面 | 承担的工作 |
|:--:|---|---|
| 01 | 封面 | Aegis · 执行控制平面 + 四项硬指标 |
| 02 | 问题 | TechCrunch 引言 —— 被留给用户的那一层 |
| 03 | 关键区别 | 建议模式 vs 网关模式,左右对照 |
| 04 | 架构 | 代理 → Aegis → 币安,以及三种裁决与退出码 |
| 05 | 三条不变量 | 平仓永不被拦 · 声明是证据 · 永远 fail closed |
| 06 | 23 条规则 | 六大类分组与计数 |
| 07 | 审计账本 | 哈希链示意 + 篡改检出 + 诚实的威胁模型 |
| 08 | 工程质量 | 333 测试 / 0 依赖 / 23 规则 / 28 缺陷 |
| 09 | 审计历史 | 四轮审计时间线 + 最严重缺陷 |
| 10 | 结语 | 定位金句 + 60 秒验证 + 仓库地址 |

## 重新生成

`svg_source/` 保留全部 10 页可编辑 SVG 源文件。修改后按 PPT Master 的 Quick 流程重新导出:

```bash
SKILL_DIR=/path/to/skills/ppt-master
python3 "$SKILL_DIR/scripts/svg_quality_checker.py" <project> \
  --quick-generate --canonical-authoring --stage final --json
python3 "$SKILL_DIR/scripts/svg_to_pptx.py" <project> --quick-generate --no-notes
```

## 质量门

`svg_quality_report.json` 是官方检查器的最终报告:**10/10 全部通过,0 警告,0 错误,0 阻塞项**。
导出器 postflight:`status=passed quality_gate=passed slides=10 warning_categories=0`。
