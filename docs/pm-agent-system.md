# 产品管理系统 · 多 Agent（OpenCode 原生实现）

四层架构 + 独立产品介绍事实层在 OpenCode 上的原生落地：**1 个主 Agent（A0-产品大脑）+ 16 个业务子 Agent（5 模块）+ 1 个文档生成子 Agent（A61）+ 1 个产品介绍维护 Agent（product-intro）+ 20 项业务 Skills（5 类）+ 4 项产品介绍技能 + 数据与知识层**。
指令自上而下（A0 → 子 Agent → Skills），数据自下而上（来源 → 三大库 → Skills/Agent）。

## 分层映射

| 架构层 | 组成 | 代码位置 |
|---|---|---|
| ① 核心 Agent 层 | A0-产品大脑（Lead Agent） | `.opencode/agents/pm-brain.md` |
| ② 子 Agent 层 | 5 个业务模块 · 16 个，另加终端交付 A61 | `.opencode/agents/pm-a*.md` |
| ③ Skills 层 | 5 类 · 20 项 | `.opencode/skills/s*/SKILL.md` |
| ④ 产品介绍层 | 4 个产品介绍技能 + 维护 Agent product-intro | `product-skills/`、`.opencode/agents/product-intro.md` |
| ⑤ 数据与知识层 | 三大库 + 六大来源 | 见下文「数据与知识层」 |

> 本仓库为 **OpenCode 原生实现**（agents + skills）。参考的纯 Python 可运行实现位于
> `D:\myproject\test\pm-agent-system\`（配置驱动，纯标准库）。

## ① 主 Agent：A0-产品大脑

- ID：`pm-brain`，`mode: primary`。
- 职责：任务接收 → 分解（关键词命中 + 链路排序 + 兜底流水线）→ 路由分发 → 结果聚合 → 归档 Trace。
- 权限：只能启动 `pm-*` 子 Agent；不直接调用任何 skill（编排而非执行）。
- 入口命令：`/pm`（`.opencode/commands/pm.md`）。

## ② 子 Agent 层（16 个 · 5 模块）

| ID | 名称 | 模块 | 调用技能 | 触发关键词 |
|---|---|---|---|---|
| `pm-a11-requirements` | 需求分析智能体 | 洞察与规划 | S11、S41 | 需求、调研、用户故事、需求池 |
| `pm-a12-competitor` | 竞品分析智能体 | 洞察与规划 | S12、S13 | 竞品、对手、对标 |
| `pm-a13-market` | 市场趋势分析智能体 | 洞察与规划 | S13、S44 | 市场、趋势、行业 |
| `pm-a21-rd` | 研发管理智能体 | 开发与发布 | S42、S43 | 研发、排期、迭代、开发、版本 |
| `pm-a22-qa` | 测试管理智能体 | 开发与发布 | S45、S43 | 测试、质量、缺陷、bug |
| `pm-a23-release` | 产品发布智能体 | 开发与发布 | S32、S34 | 发布、上线、launch |
| `pm-a31-ops` | 运营数据智能体 | 运营 | S44 | 运营、指标、留存、活跃 |
| `pm-a32-feedback` | 用户反馈智能体 | 运营 | S41 | 反馈、工单、舆情、投诉 |
| `pm-a41-leads` | 销售线索智能体 | 销售 | S13 | 线索、获客、lead |
| `pm-a42-followup` | 销售跟进智能体 | 销售 | S31、S41 | 跟进、客户、触达 |
| `pm-a43-conversion` | 销售转化智能体 | 销售 | S31、S32、S33、S34 | 转化、成交、商机、请示、退出 |
| `pm-a44-performance` | 销售业绩分析智能体 | 销售 | S44 | 业绩、销售额、漏斗、复盘 |
| `pm-a51-support` | 产品支持智能体 | 支撑 | S25 | 支持、客服、售后 |
| `pm-a52-knowledge` | 知识管理智能体 | 支撑 | S26、S41 | 知识、沉淀、文档 |
| `pm-a53-partner` | 合作伙伴管理智能体 | 支撑 | S21、S22 | 合作伙伴、伙伴、渠道、生态 |
| `pm-a54-risk` | 风险管理智能体 | 支撑 | S23、S24 | 风险、合规、预警 |

A61 不参与上表的关键词路由，只在成稿时由 A0 最后调用。

| ID | 名称 | 模块 | 调用技能 | 何时调用 |
|---|---|---|---|---|
| `pm-a61-deliverable` | 文档生成智能体 | 交付 | S61、S62 | 业务 Agent 全部返回之后；用户要求生成文件、导出、成稿或按模板填写 |

每个子 Agent 通过 `skill` 权限规则实现**能力矩阵固化**：先 `deny *`，再仅 `allow` 其被映射的技能。子 Agent 禁止再启动子 Agent（防递归）。

## ③ Skills 层（20 项 · 5 类，业务技能）

> 本层只统计 `.opencode/skills/` 下的业务技能；4 项产品介绍技能单独放在 `product-skills/`，见 ④。

| 类别 | 技能 ID |
|---|---|
| 基础能力 | `s11-requirement-analysis`、`s12-competitor-analysis`、`s13-market-research` |
| 核心能力 | `s21-partner-evaluation`、`s22-partner-management`、`s23-risk-assessment`、`s24-risk-monitoring`、`s25-support-evaluation`、`s26-knowledge-management` |
| 研发与运营 | `s31-business-plan`、`s32-product-packaging`、`s33-product-exit`、`s34-marketing-copy` |
| 工具类（DIGEX） | `s41-doc-interpretation`、`s42-meeting-minutes`、`s43-pm-platform`、`s44-bi-metrics`、`s45-test-data` |
| 交付 | `s61-template-adapt`、`s62-file-emit` |

### 能力矩阵（Agent × Skill）

| Agent | S11 | S12 | S13 | S21 | S22 | S23 | S24 | S25 | S26 | S31 | S32 | S33 | S34 | S41 | S42 | S43 | S44 | S45 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A11 | ✓ | | | | | | | | | | | | | ✓ | | | | |
| A12 | | ✓ | ✓ | | | | | | | | | | | | | | | |
| A13 | | | ✓ | | | | | | | | | | | | | | ✓ | |
| A21 | | | | | | | | | | | | | | | ✓ | ✓ | | |
| A22 | | | | | | | | | | | | | | | | ✓ | | ✓ |
| A23 | | | | | | | | | | | ✓ | | ✓ | | | | | |
| A31 | | | | | | | | | | | | | | | | | ✓ | |
| A32 | | | | | | | | | | | | | | ✓ | | | | |
| A41 | | | ✓ | | | | | | | | | ✓ | | | | | | |
| A42 | | | | | | | | | | ✓ | | | | ✓ | | | | |
| A43 | | | | | | | | | | ✓ | | | ✓ | | | | | |
| A44 | | | | | | | | | | | | | | | | | ✓ | |
| A51 | | | | | | | | ✓ | | | | | | | | | | |
| A52 | | | | | | | | | ✓ | | | | | ✓ | | | | |
| A53 | | | | ✓ | ✓ | | | | | | | | | | | | | |
| A54 | | | | | | ✓ | ✓ | | | | | | | | | | | |

> 复用度：S41 被 4 个 Agent 复用（最高）；S13、S31、S34、S44 各被 3 个复用。

A61 不进入上面的 16×18 矩阵。它只允许 S61、S62：S61 把业务 Agent 的交付片段填进模板，S62 把结果写入 `deliverables/`。业务正文仍由对应的 A11–A54 生成。

## ④ 产品介绍层（4 项 · 独立目录）

四个产品介绍技能放在 **`.opencode/skills/` 之外** 的 `product-skills/`，通过
`opencode.json` 的 `"skills": ["./product-skills"]` 注册。它们仍是标准 OpenCode 技能，
但不与业务技能混在一起，权限可以单独切分。

| 技能 ID | 目录 | 定位 |
|---|---|---|
| `product-intro-01` | `product-skills/product-intro-01/SKILL.md` | 移动安全管家 |
| `product-intro-02` | `product-skills/product-intro-02/SKILL.md` | 家庭看护 |
| `product-intro-03` | `product-skills/product-intro-03/SKILL.md` | 语音连接 |
| `product-intro-04` | `product-skills/product-intro-04/SKILL.md` | 移动优享 |

产品名、别名与文件路径的唯一索引是 `product-skills/registry.json`。目录名是固定槽位；换产品时改 `registry.json` 与 `SKILL.md` 正文，不改目录名。

每个产品介绍使用统一骨架：概览与套餐、引入背景、市场需求、竞品对标、功能与版本、合作伙伴、投入产出、渠道与转化、RACI、营销策略、FAQ、联动影响、变更记录。关键条目使用 `[已拍板]` / `[沟通中]` / `[已变更/废弃]` 状态标签。

### 读写权限

| 角色 | `product-skills/` 权限 |
|---|---|
| `pm-brain`（A0） | 只读：读 `registry.json` 与命中的 `SKILL.md`，不能编辑、改名、删除 |
| `product-intro`（产品介绍维护智能体） | 业务侧唯一可读写：只能碰 `product-skills/`，不能读改其他 Agent、Skills、配置与数据 |
| `build`（开发 Agent） | 不设限：可读可写，用于开发和调试产品介绍 |
| 其他子 Agent | 不直接读，由 A0 把产品事实注入任务说明 |

product-intro 是 `mode: primary`，单独入口 `/product-intro`，不在 A0 的 subagent 白名单里；
A0 也不会把「维护产品介绍」当成业务任务处理，只引导用户切到 product-intro。

### 运行时链路

```text
用户提问
  └─ A0 判断涉及具体产品
       ├─ 读 product-skills/registry.json，按 aliases 命中
       ├─ 读 product-skills/product-intro-0X/SKILL.md
       └─ 把正文作为【产品介绍 · 产品名】事实块写进子 Agent 任务说明
            └─ 子 Agent 按原任务类型与技能执行（产品事实不改变路由）
```

- 产品事实只补充「是什么」，不改变任务类型、主技能与输出格式。
- 注入时去掉 frontmatter 与末尾「填写参考（非事实）」一节。
- 正文 Agent 与片段 Agent 注入同一份事实，保证数字一致。
- `【待维护】` 一律视为「后台暂无该资料」，任何 Agent 不得推测或补写；`[沟通中]` 只能按「暂定」引用。
- 同一问题最多注入 3 个产品；registry 未命中则不注入。

## ⑤ 数据与知识层

| 库 | 定位 | 主要消费方 |
|---|---|---|
| 知识库 | 非结构化/半结构化知识的结构化沉淀（含 owner、标签、有效期） | 多数技能 |
| 数据库 | 结构化业务数据（需求、缺陷、工单、BI 指标） | 平台/BI/工单类技能 |
| skills库 | 技能定义、版本与调用统计 | 运维/治理复盘 |

六大数据来源：产品知识文档、产品管理平台、工单系统、FineBI、飞书进程信息、个人经验（**须经评审治理后入库**）。

## 使用

```text
/pm 为新产品「智能报表助手」完成需求梳理与市场趋势分析，制定研发排期与发布推广方案，并评估主要风险
```

A0 将命中 `A11/A13/A21/A23/A54`，按 洞察→研发→发布→支撑 顺序执行，并聚合出 Markdown《产品任务报告》
（任务元信息 → 一、执行过程 → 二、综合结论 → 三、建议下一步 → 四、技能调用统计）。

若用户同时要求成稿，例如「按上传的模板生成需求文档」，A0 先调用对应业务 Agent（此例为 A11）阅读上传材料并返回交付片段，再调用 A61 把片段写入 `deliverables/`。报告第五节只记录文件路径和未填槽位。

也可直接点名某个子 Agent，例如：`使用 pm-a54-risk 子 Agent 评估该产品的合规风险`。

维护产品介绍时用 `/product-intro` 切到 product-intro（`product-intro`）。product-intro 只读写
`product-skills/` 下的四个产品介绍技能；A0 对这些文件只读，用于回答前的产品事实注入。

## 与架构评审的对应

本实现已内置评审建议的部分约定（在子 Agent 提示中标注）：个人信息最小权限（R-08，见 A44/S44）、
经验治理（R-05，见 A52/S26）、高风险产出人工审批门（R-11，见 A23/A42/A43/A54）。分类命名沿用架构文档口径。
