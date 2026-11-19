# 产品介绍知识层（product-skills/）

这一层是 **A0-产品大脑 与 product-intro（产品介绍维护智能体）之间的只读事实层**。

## 为什么单独放一个目录

- 现有 20 个业务技能放在 `.opencode/skills/`，由各业务子 Agent 通过 `skill` 权限加载。
- 这 4 个产品介绍技能放在**仓库根目录** `product-skills/`，并通过 `opencode.jsonc` 的
  `"skills": ["./product-skills"]` 注册。
- 结果：它们是标准 OpenCode 技能，但不与业务技能混在一起，权限也能单独切分：
  - `pm-brain`：只能 `read`，不能 `edit`；
  - `product-intro`：业务侧唯一可以 `read` + `edit` 的 Agent；
  - `build`（开发 Agent）：不设限，可读可写，用于开发调试；
  - 其他子 Agent：不能 `edit`，由 `pm-brain` 把内容注入任务说明，不需要直接读。

## 目录约定

```text
product-skills/
├── registry.json                 # 产品名 / 别名 → 技能文件 的唯一索引（A0 先读它）
├── _guide/
│   └── README.md                 # 本说明（嵌套目录，不会被注册成技能）
├── product-intro-01/SKILL.md
├── product-intro-02/SKILL.md
├── product-intro-03/SKILL.md
└── product-intro-04/SKILL.md
```

- 技能 ID 由目录名决定：`product-intro-01` … `product-intro-04`。
- 4 个目录名是**固定槽位**。换产品时改 `registry.json` 里的 `name` / `aliases` 和 `SKILL.md` 正文，
  不要改目录名；改了目录名就要同步改 `registry.json` 的 `path` 和 `skill`。
- 不要在 `product-skills/` 根目录放 `README.md` 或其他 `*.md`：根目录的 Markdown 会被当成扁平技能注册。
  说明文档放 `_guide/`。

## 运行时链路

```text
用户提问
  └─ pm-brain 判断问题涉及具体产品
       ├─ 读取 registry.json，按 aliases 命中产品
       ├─ 读取 product-intro-0X/SKILL.md
       └─ 把正文作为【产品介绍】事实块写进子 Agent 的任务说明
            └─ 子 Agent 按原任务类型与技能执行（产品事实不改变路由）
```

## 维护规则

1. **业务侧只有 product-intro 能改**（开发调试用的 `build` 不设限）。在 `pm-brain` 里提出「改产品介绍」会被拒绝并引导到 `/product-intro`。
2. 条目用四种状态标签：`[已拍板]` / `[沟通中]` / `[已变更/废弃]` / `[待补充]`；正式材料只引用 `[已拍板]`。
3. 每次修改都要：
   - 更新 `SKILL.md` 页头的「最近更新」；
   - 在文末「变更记录」追加一行（日期 / 修改人 / 内容 / 来源）；
   - 同步 `registry.json` 的 `updated`、`summary`、`status`。
4. 没有可靠来源的内容保持 `【待维护】`，禁止编造。`【待维护】` 会被下游原样视为「后台暂无资料」。
5. 新增第 5 个产品时：复制一个 `product-intro-0X/` 目录 → 在 `registry.json` 增加一条 →
   在 `product-intro` 提示的产品表里补一行 → 不需要改路由逻辑。
