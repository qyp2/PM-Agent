# PM-Agent · 产品管理系统 Multi-Agent

An OpenCode-native implementation of the **产品管理系统** four-layer architecture, plus a separate read-only product-intro fact layer:

> **1 lead agent (A0) + 16 business sub-agents (5 modules) + 1 document sub-agent (A61) + 1 product-intro maintainer agent + 24 skills (20 business + 4 product intros) + data & knowledge layer.**

指令自上而下（A0 → 子 Agent → Skills），数据自下而上（来源 → 三大库 → Skills/Agent）。

产品介绍是**独立的一层只读事实**：A0 只能读，业务侧只有 product-intro 能改；开发用的 build 不设限。

## 分层映射

| 架构层 | 组成 | 代码位置 |
| --- | --- | --- |
| ① 核心 Agent 层 | A0-产品大脑（Lead Agent） | `.opencode/agents/pm-brain.md` |
| ② 子 Agent 层 | 5 个业务模块 · 16 个，另加终端交付 A61 | `.opencode/agents/pm-a*.md` |
| ③ Skills 层 | 5 类 · 20 项 | `.opencode/skills/s*/SKILL.md` |
| ④ 产品介绍层 | 4 个产品介绍技能，A0 只读注入、product-intro 可写、build 不设限 | `product-skills/product-intro-0*/SKILL.md` |
| ⑤ 数据与知识层 | 三大库 + 六大来源 | 见 [`docs/pm-agent-system.md`](./docs/pm-agent-system.md) |

模块：洞察与规划 `A11–A13` · 开发与发布 `A21–A23` · 运营 `A31–A32` · 销售 `A41–A44` · 支撑 `A51–A54`。成稿时最后调用交付 `A61`。

## 特性

- **Routing**：A0 按关键词命中打分，按业务链路排序（洞察→研发→发布→运营→销售→支撑），
  无命中且不出文件时走兜底流水线 `A11 → A13 → A21 → A23 → A54`。
  用户要求成稿时，先由对应业务 Agent 写出交付片段，再调用 `A61` 套模板并写入 `deliverables/`。
- **Capability matrix**：每个子 Agent 只能加载其被映射的技能，由 `skill` 权限规则强制
  （先 `deny *`，再 allow 映射的技能）。
- **产品介绍先读后传**：A0 命中产品后先读 `product-skills/registry.json` 与对应
  `SKILL.md`，把正文作为【产品介绍】事实块注入任务说明，再交给子 Agent 执行；
  产品事实不改变任务类型与技能选择。A0 无写权限，维护统一走 product-intro。
- **No recursion**：子 Agent 不能再启动子 Agent。
- **Aggregation**：产出 Markdown《产品任务报告》（执行过程 → 综合结论 → 建议下一步 → 技能调用统计）。

## 使用

```text
/pm 为新产品「智能报表助手」完成需求梳理与市场趋势分析，制定研发排期与发布推广方案，并评估主要风险
```

`pm-brain` 为默认 Agent，普通提问即已路由到 A0；也可用 `/pm` 命令，或直接点名某个子 Agent
（如 `使用 pm-a54-risk 子 Agent 评估该产品的合规风险`）。

维护产品介绍时用 `/product-intro` 切到产品介绍维护智能体 `product-intro`：它只能读写
`product-skills/` 下的四个产品介绍技能，不能读改其他 Agent、Skills 或配置。

完整的 Agent/Skill 清单与能力矩阵见 [`docs/pm-agent-system.md`](./docs/pm-agent-system.md)；
交互式架构图见 [`architecture-diagram.html`](./architecture-diagram.html)。

## 目录结构

```
.
├── architecture-diagram.html      # 交互式架构图（单文件网页）
├── opencode.jsonc                 # 默认 Agent = pm-brain
├── product-skills/                # 4 个产品介绍技能（A0 只读 / product-intro 可写）
│   ├── registry.json              # 产品名 / 别名 → 技能文件
│   ├── _guide/README.md
│   └── product-intro-01 … 04/SKILL.md
├── docs/
│   └── pm-agent-system.md         # Agent/Skill 清单、能力矩阵、数据与知识层
└── .opencode/
    ├── agents/                    # pm-brain + pm-a11 … pm-a54 + a61/a64/product-intro/a81（22）
    ├── commands/
    │   ├── pm.md                  # /pm 入口
    │   └── product-intro.md       # /product-intro 入口
    └── skills/                    # s11 … s64、s81、s82（业务技能，20）
```
