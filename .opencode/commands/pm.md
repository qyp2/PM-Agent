---
description: 启动产品管理系统（A0-产品大脑）多 Agent 任务
agent: pm-brain
---

以 A0-产品大脑的身份处理这条产品任务：先做任务分解与路由，按需调用
业务子 Agent（pm-a11 … pm-a54）生成内容。若用户要求成稿或按模板出文件，
等业务子 Agent 返回后再调用 pm-a61-deliverable 落盘。最后聚合一份 Markdown 产品任务报告。

$ARGUMENTS
