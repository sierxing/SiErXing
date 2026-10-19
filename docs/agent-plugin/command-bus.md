# 命令总线（Command Bus）· 草案 v0.1

> 目标：用户能做的操作，Agent 都能做；但只写一套实现，并且每一步都可校验、可授权、可审计、可撤销。

## 一、为什么是命令，不是 200 个工具

- 思而行现有 REST 路由很多，按端点一对一包工具会让 Agent 选错、也会把工具列表撑爆。
- 命令总线把「一个用户动作」收敛成一个**有 schema 的命令**；UI、CLI、MCP、Agent 都调它。
- Agent 只需要 3 个元工具：**list / describe / run**。具体能力由命令注册表动态发现。
- 命令总线同时是**事件源**：每次执行都发事件，语义引擎和审计都吃这份数据。

## 二、命令描述符

~~~json
{
  "name": "goal.create",
  "title": "创建目标",
  "description": "创建一个新目标。why 和 successCriteria 建议非空；创建后返回 goalId 与 UI 链接。",
  "category": "goal",
  "layer": "content",
  "risk": "write",
  "async": false,
  "idempotent": true,
  "idempotencyKey": "client_key",
  "inputSchema": {
    "type": "object",
    "required": ["title"],
    "properties": {
      "title": { "type": "string", "maxLength": 120 },
      "why": { "type": "string", "maxLength": 2000 },
      "successCriteria": { "type": "string", "maxLength": 2000 },
      "constraints": { "type": "string", "maxLength": 2000 },
      "client_key": { "type": "string", "maxLength": 80 }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "goalId": { "type": "integer" },
      "uiUrl": { "type": "string" }
    }
  },
  "effects": ["goal.created"],
  "undo": { "command": "goal.delete", "input": { "goalId": "$result.goalId" } },
  "handler": "commands/goal/create.js"
}
~~~

字段说明：

| 字段 | 作用 |
| --- | --- |
| name | 稳定标识，域.动作；不允许改名，只能加版本 |
| risk | read / write / destructive / admin |
| async | true 时返回 jobId；复用 server/tasks.js |
| idempotent | Agent 重试是否安全 |
| inputSchema | JSON Schema；既是校验，也是给 Agent 的说明书 |
| effects | 成功时发出的事件类型 |
| undo | 逆命令模板；生成撤销按钮 / 撤销令牌 |
| handler | 实现位置；先包现有 handler，后逐步内聚 |

## 三、执行流水线

~~~text
run(command, input, actor, approvalToken?)
  1. resolve        命令存在？版本匹配？
  2. validate       inputSchema 校验 + 业务前置校验
  3. authorize      目标 layer/editable + actor 权限 + risk 等级 + approvalToken
  4. idempotency    有 client_key 且窗口内重复 → 返回上次结果
  5. snapshot       before 快照（用于审计和撤销）
  6. execute        调 handler；async 则入任务队列
  7. audit          写审计表：谁、何时、命令、入参、before/after、结果
  8. emit           发 effects 事件（事件表 + SSE/轮询）
  9. return         { ok, result, undoToken?, uiUrl? }
~~~

任何一步失败都不写成功事件；失败也审计（带 error code）。

## 四、风险等级与审批

| risk | 例子 | Agent 默认 | 需要审批令牌 |
| --- | --- | --- | --- |
| read | goal.list、brief.get、events.list | 允许 | 否 |
| write | goal.create、node.update、note.create | 允许，记审计 | 否 |
| destructive | goal.delete、component.uninstall | 拒绝 | 是 |
| admin | component.install、component.patchBuiltin、prompt.update、theme.set、setting.set | 拒绝 | 是 |

### 层级与可编辑性（先于 risk 判断）

每个命令都要声明它改的**目标层**（layer）：

| layer | 例子 | Agent 能否改 |
| --- | --- | --- |
| kernel | server.js、DB、任务、AI 传输 | 禁止 |
| domain | 数据结构、不变量、解析/守卫 | 禁止 |
| feature | 提示词、管线、功能页 | 可改，admin 审批 |
| extension | 附加组件、主题、布局 | 可改，admin 审批 |
| content | 目标、节点、教程、资料、笔记 | 可改，按 write/destructive |

执行时先读目标的 layer/editable：

- **组件**：core/domain 或 editable=false → 直接 forbidden，不进入执行。
- **提示词包**：没有 editable=false；一律 layer=feature、risk=admin，可改，但必须预览 + 契约测试 + 审批 + 回滚。
- **content**：按 write/destructive 权限。

core.patch 这条命令**不存在**；核心内置组件（plan/outlib）没有 component patch 入口。
非核心内置组件走 component.patchBuiltin（tutorial 也在其中，可改可替换）；提示词走 prompt.*；两者回滚互相独立。

### 审批令牌（关键安全设计）

- 令牌由**用户侧**发放，不由模型发放：Web UI 的「批准并执行」按钮、或用户自己跑的 CLI 命令。
- 令牌绑定：command、target、changeId、actor、过期时间，**一次性**。
- Agent 调 admin/destructive 命令时不带令牌 → 返回：

~~~json
{
  "error": {
    "code": "approval_required",
    "message": "需要用户批准后才能执行 component.install",
    "details": {
      "command": "component.install",
      "changeId": "chg_20261017_001",
      "approveUrl": "http://127.0.0.1:3213/#/agent/approve/chg_20261017_001"
    }
  }
}
~~~

- Agent 把 approveUrl 给用户；用户点开、看 diff、批准；令牌写入审批表；Agent 再调用时带上令牌。
- 这样即使 Agent 被网页内容里的提示词注入，也**无法自己安装代码**。

## 五、Actor 模型

| actor | 来源 | 默认权限 |
| --- | --- | --- |
| user:local | Web UI / 用户 CLI | 全部（admin 仍需点确认） |
| agent:<name>:<session> | MCP / CLI / 插件 | read + write；destructive/admin 需令牌 |
| system | 定时任务、迁移 | 按命令声明 |
| plugin:<id> | 组件内部调用 | 只能调白名单命令 |

审计里永远记录 actor；UI 显示「由 Claude 修改」这类来源。

## 六、事件

~~~json
{
  "id": "evt_01J...",
  "type": "goal.created",
  "at": "2026-10-17T14:03:11.000Z",
  "actor": "agent:claude-code:session-8f2",
  "command": "goal.create",
  "target": { "kind": "goal", "id": 53 },
  "before": null,
  "after": { "title": "转行 AI 产品经理", "status": "active" },
  "meta": { "uiUrl": "http://127.0.0.1:3213/#/g/53" }
}
~~~

事件类型分三类：

- **命令事件**：command.started / command.succeeded / command.failed
- **领域事件**：goal.created / node.completed / tutorial.generated / component.installed / friction.reported
- **学习事件**：study.reported / review.recorded / note.created

事件表建议：agent_events(id, type, at, actor, command, target_kind, target_id, before_json, after_json, meta_json)。

## 七、异步任务

- 慢命令（plan.generate、tutorial.generate、source.collect、component.verify）声明 async: true。
- 返回：

~~~json
{ "jobId": "t_123", "status": "queued", "poll": "jobs.get", "uiUrl": "...#/aitasks" }
~~~

- Agent 用 jobs.get 轮询；也支持 waitMs（不超过 25000）做有界等待。
- 复用现有任务队列的进度、阶段、取消、重试。
- 任务完成后把结果写入结果表，并发出领域事件。

## 八、对外接口

### 3 个元工具（MCP / CLI 共用）

- **commands.list**：按 category / risk / query 过滤，返回 name、title、risk、async。
- **commands.describe**：返回完整描述符（含 inputSchema、示例）。
- **commands.run**：执行；返回 result / jobId / approval_required。

### 辅助读工具

- manifest.get
- brief.get（goal / progress / user）
- events.list
- insights.list
- jobs.get / jobs.cancel

### CLI

~~~bash
sierxing commands list --category goal --json
sierxing commands describe goal.create --json
sierxing commands run goal.create --json '{"title":"转行 AI 产品经理"}' --actor agent:claude-code
sierxing brief get --scope goal --id 53 --json
sierxing events list --since 2026-10-17T00:00:00Z --json
sierxing jobs get t_123 --json
~~~

### MCP

- tools：sierxing_commands_list / sierxing_commands_describe / sierxing_commands_run / sierxing_manifest_get / sierxing_brief_get / sierxing_events_list / sierxing_insights_list / sierxing_jobs_get
- resources：sierxing://manifest、sierxing://brief/goal/{id}、sierxing://brief/user、sierxing://events/recent
- annotations：read 命令标 readOnlyHint；destructive/admin 标 destructiveHint；带 idempotencyKey 的标 idempotentHint

## 九、命令目录 v0（代表项）

| 域 | 命令 |
| --- | --- |
| goal | goal.list / get / create / update / archive / delete |
| plan | plan.clarify / generate / adjust / get / versions |
| node | node.create / bulkCreate / update / move / complete / delete |
| task | task.create / update / complete / delete |
| tutorial | tutorial.get / generate / update / delete |
| source | source.search / add / collect / refetch |
| note | note.create / update / delete / list |
| review | review.plan / record |
| component | component.list / describe / updateConfig / install / uninstall / reload |
| component 流水线 | component.scaffold / write / validate / preview / verify / rollback |
| component 内置 | component.patchBuiltin（仅 scope=base/extra；core 禁止） |
| prompt | prompt.list / get / update / validate / preview / rollback |
| feature | feature.list / get / update / validate / preview / rollback |
| 外观 | theme.set / layout.set |
| 设置 | setting.get / set |
| 番茄钟 | pomodoro.start / pause / stop / setKeys / setBind |
| 统计 | stats.get / study.report |
| 语义 | event.list / insight.list / brief.get / friction.report / friction.list |
| 元 | commands.list / describe / run / manifest.get / jobs.get / jobs.cancel |

完整目录由注册表生成，文档不手抄，避免漂移。

## 十、错误模型

~~~json
{
  "error": {
    "code": "bad_input",
    "message": "title 不能为空",
    "details": { "field": "title" }
  }
}
~~~

code 固定集合：bad_input / not_found / forbidden / approval_required / conflict / job_failed / internal。

## 十一、版本与兼容

- manifest 带 manifestVersion；命令带 commandVersion。
- 命令只增不改语义；破坏性变更发新名字（goal.create.v2）并保留旧名一个周期。
- CLI 和 MCP 启动时校验 manifestVersion，不匹配给出明确错误。

## 十二、迁移路径（不重写 server.js）

1. 新建命令注册表 + /api/commands/run 通用端点；先给每个命令标 layer/editable/risk。
2. 先包 20~30 个核心命令，handler 内部调用现有函数或 fetch 本地 REST。
3. CLI / MCP 先接这层；UI 暂不改。
4. 命令层稳定后，让 UI 逐步改调命令总线。
5. 每包一个命令就补审计 + 事件 + undo。

这样第一版不需要大爆炸式重构，也能先让 Agent 把整条链路跑通。
