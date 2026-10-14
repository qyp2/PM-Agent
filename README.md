# PM-Agent · 产品管理系统 Multi-Agent

An OpenCode-native implementation of the **产品管理系统** four-layer architecture:

> **1 lead agent (A0) + 16 sub-agents (5 modules) + 18 skills (4 categories) + data & knowledge layer.**

指令自上而下（A0 → 子 Agent → Skills），数据自下而上（来源 → 三大库 → Skills/Agent）。

## 分层映射

| 架构层 | 组成 | 代码位置 |
| --- | --- | --- |
| ① 核心 Agent 层 | A0-产品大脑（Lead Agent） | `.opencode/agents/pm-brain.md` |
| ② 子 Agent 层 | 5 模块 · 16 个 | `.opencode/agents/pm-a*.md` |
| ③ Skills 层 | 4 类 · 18 项 | `.opencode/skills/s*/SKILL.md` |
| ④ 数据与知识层 | 三大库 + 六大来源 | 见 [`docs/pm-agent-system.md`](./docs/pm-agent-system.md) |

模块：洞察与规划 `A11–A13` · 开发与发布 `A21–A23` · 运营 `A31–A32` · 销售 `A41–A44` · 支撑 `A51–A54`。

## 特性

- **Routing**：A0 按关键词命中打分，按业务链路排序（洞察→研发→发布→运营→销售→支撑），
  无命中时走兜底流水线 `A11 → A13 → A21 → A23 → A54`。
- **Capability matrix**：每个子 Agent 只能加载其被映射的技能，由 `skill` 权限规则强制
  （先 `deny *`，再 allow 映射的技能）。
- **No recursion**：子 Agent 不能再启动子 Agent。
- **Aggregation**：产出 Markdown《产品任务报告》（执行过程 → 综合结论 → 建议下一步 → 技能调用统计）。

## 使用

```text
/pm 为新产品「智能报表助手」完成需求梳理与市场趋势分析，制定研发排期与发布推广方案，并评估主要风险
```

`pm-brain` 为默认 Agent，普通提问即已路由到 A0；也可用 `/pm` 命令，或直接点名某个子 Agent
（如 `使用 pm-a54-risk 子 Agent 评估该产品的合规风险`）。

完整的 Agent/Skill 清单与 16×18 能力矩阵见 [`docs/pm-agent-system.md`](./docs/pm-agent-system.md)；
交互式架构图见 [`architecture-diagram.html`](./architecture-diagram.html)。

## 目录结构

```
.
├── architecture-diagram.html      # 交互式架构图（单文件网页）
├── opencode.jsonc                 # 默认 Agent = pm-brain
├── docs/
│   └── pm-agent-system.md         # Agent/Skill 清单、能力矩阵、数据与知识层
└── .opencode/
    ├── agents/                    # pm-brain + pm-a11 … pm-a54（17）
    ├── commands/
    │   └── pm.md                  # /pm 入口
    └── skills/                    # s11 … s45（18）
```
