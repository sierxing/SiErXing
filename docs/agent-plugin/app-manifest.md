# App Manifest（应用自描述）· 草案 v0.1

> 目标：让 Agent 一进门就知道「思而行里每个东西是什么、为什么存在、能对它做什么」。
> 不是手写文档，而是从代码和注册表生成，避免过期。

## 一、它解决什么问题

Agent 拿到原始数据（goal、node、status、restKeys）并不等于理解。Manifest 提供：

- **实体语义**：goal / node / task / tutorial / source / note / component / insight 各是什么。
- **字段语义**：status 有哪些值、意味着什么；bindNodeId 是干什么的。
- **关系**：goal → node → task；tutorial ← node；source → RAG；note → 目标/节点。
- **页面**：每个路由是干什么的、用户会在这里做什么。
- **动作**：每个命令的输入、输出、风险、影响。
- **不变量**：哪些操作会级联、哪些不可逆、哪些必须确认。
- **语义信号**：健康度、卡点、摩擦等判断的定义。

## 二、Manifest 结构

~~~json
{
  "app": {
    "name": "SiErXing",
    "version": "1.10.84",
    "manifestVersion": 1,
    "generatedAt": "2026-10-17T14:00:00.000Z"
  },
  "concepts": [],
  "commands": [],
  "events": [],
  "readModels": [],
  "components": [],
  "pages": [],
  "layers": [],
  "promptPacks": [],
  "invariants": [],
  "semantics": []
}
~~~

## 三、概念（Concepts）

~~~json
{
  "name": "goal",
  "title": "目标",
  "what": "用户想要达到的一个状态。",
  "why": "目标是一切计划和进度的根；没有 goal 的节点/教程不应存在。",
  "fields": {
    "id": "整数，稳定标识",
    "title": "目标标题",
    "why": "为什么想达到它（动机）",
    "successCriteria": "怎样算达成",
    "constraints": "时间、预算、能力等限制",
    "status": "active / paused / achieved / archived",
    "plugins": "目标级组件开关（JSON 文本）"
  },
  "relations": [
    { "to": "node", "kind": "has-many", "cascade": "delete" },
    { "to": "tutorial", "kind": "has-many", "via": "node" },
    { "to": "insight", "kind": "has-many" }
  ],
  "lifecycle": ["created", "active", "paused", "achieved", "archived"],
  "invariants": [
    "同一时间最多一个 active goal（建议）",
    "删除 goal 会级联删除 node/tutorial，必须确认",
    "goal 的 why/successCriteria 变更后，旧计划可能失效，应提示重新生成"
  ],
  "examples": [
    "转行 AI 产品经理：3 个月内拿到面试，先做 2 个真实项目"
  ]
}
~~~

建议第一批概念：

| 概念 | 一句话 |
| --- | --- |
| goal | 用户想达到的状态；有 why、成功标准、约束 |
| node | 目标下的一步；有状态、证据、卡点 |
| task | 节点下的最小动作；每日执行 |
| tutorial | 为节点生成的学习材料；可阅读/笔记/测验 |
| source | 外部资料；有摘要、引用、质量 |
| note | 用户或 Agent 的结构化记录；insight/question/misconception/decision |
| event | 系统里发生的事；命令和学习都会发 |
| component | 可安装的功能扩展；有配置、代码、版本 |
| insight | 从事件和数据推导出的判断；带证据和建议 |
| friction | 用户在使用中感到不舒服的信号 |

## 四、页面（Pages）

~~~json
{
  "route": "#/g/:goalId",
  "title": "目标地图",
  "purpose": "看阶段、节点、依赖和进度；从这里进入教程/测验",
  "data": ["goal", "nodes", "progress", "insights"],
  "actions": ["node.create", "node.update", "plan.generate", "goal.update"],
  "agentHints": [
    "用户说'我的路线/地图/计划'时，通常指这里",
    "用户说'我卡住了'时，先看这个页面的节点状态和 insights"
  ]
}
~~~

第一批页面：首页 / 目标地图 / 教程页 / 资源库 / 学习统计 / 组件管理 / AI 任务。

## 四·五、层级与提示词包

### layers

Manifest 必须告诉 Agent 每一层能不能改：

~~~json
[
  { "id": "kernel", "editable": false, "desc": "DB / HTTP / 任务 / AI 传输 / 插件加载 / 命令总线" },
  { "id": "domain", "editable": false, "desc": "数据结构 / 不变量 / 解析 / 守卫" },
  { "id": "feature", "editable": true, "desc": "提示词 / 管线 / 功能页" },
  { "id": "extension", "editable": true, "desc": "附加组件 / 主题 / 布局" },
  { "id": "content", "editable": true, "desc": "用户的目标、节点、教程、资料、笔记" }
]
~~~

### promptPacks

提示词是功能层资产，Agent 需要知道有哪些包、哪些可改、改完要过什么契约：

~~~json
[
  {
    "id": "plan.clarify",
    "version": 1,
    "feature": "plan",
    "editable": true,
    "contract": "plan.parseClarify",
    "inputs": ["goal", "digests", "library"],
    "source": "builtin"
  },
  {
    "id": "tutorial.full",
    "version": 4,
    "feature": "tutorial",
    "editable": true,
    "contract": "tutorial.parse",
    "inputs": ["goal", "node", "sources", "digests"],
    "source": "user-pack"
  }
]
~~~

规则：

- 提示词包一律 editable=true；**没有锁死开关**。core 组件用到的提示词也一样。
- source=builtin / user-pack / agent-pack，方便审计和回滚。
- 改包必须通过 contract 对应的解析/守卫；Manifest 里写清 contract 名字。
- 保护靠 contract + fixture + 预览 + 审批 + 回滚，不靠 editable=false。
- “慎重”是流程：改前看 fixture 改前/改后输出；过不了解析/守卫就不生效。

### components

~~~json
[
  { "id": "plan", "scope": "core", "editable": false, "replaceable": false },
  { "id": "outlib", "scope": "core", "editable": false, "replaceable": false },
  { "id": "tutorial", "scope": "base", "editable": true, "replaceable": true },
  { "id": "pomodoro", "scope": "extra", "editable": true, "replaceable": true }
]
~~~

规则：

- scope=core：组件代码/UI/集成不可改，也不可替换；提示词仍可改（见 promptPacks）。
- scope=base/extra/theme：可改、可替换；tutorial 是典型例子，用户可以自己做一个教程组件替换它。
- replaceable=true 表示用户可以禁用内置组件、装一个自己的实现；责任由用户承担。

## 五、读模型（Read Models）

Manifest 只描述结构；Agent 真正读到的是**读模型**。第一批：

### goal_brief

- 目标：title、why、successCriteria、constraints、status
- 当前阶段与节点：进度、状态、最近活动
- 卡点：blockers、stall 信号
- 下一步：next_best_action
- 最近事件：3~10 条
- 相关洞察：insights（带证据）
- UI 链接

### progress_brief

- 时间：今日/本周/累计
- 完成度：节点、任务、教程
- 动量：最近 7 天 vs 前 7 天
- 卡点：stall、重复失败
- 复习：due、最近结果

### user_brief

- 动机与约束
- 可用时间与活跃时段
- 偏好：内容类型、节奏、组件
- 历史成败：什么方法有效/无效
- 沟通偏好：直接/鼓励/详细

### friction_log

- 页面/组件/动作
- 用户描述、期望 vs 实际
- 严重度、出现次数
- 状态：open / investigating / fixed / dismissed

## 六、生成与版本

- 从**命令注册表、schema、组件 manifest、页面注册表、语义信号注册表**生成。
- 每个概念/页面/命令必须有 description；缺了 CI 失败。
- manifestVersion 变更时提供 diff：新增/删除/语义变更。
- Agent 启动时校验 manifestVersion；不匹配时提示升级插件。

## 七、读取方式与 token 预算

- **summary**：只含概念名、命令名、页面名，控制在 ~1500 tokens。
- **concept detail**：单个概念 ~300-500 tokens，按需取。
- **brief**：按当前问题裁剪，控制在 ~3000 tokens；超出时用检索。
- 接口：
  - GET /api/manifest
  - GET /api/manifest?detail=goal
  - sierxing manifest --json
  - MCP resource: sierxing://manifest

## 八、和语义层的关系

Manifest 回答「是什么」，语义层回答「现在意味着什么」。

- Manifest 是静态的、版本化的。
- 语义信号是动态的、带证据的。
- Agent 先读 Manifest 建立地图，再读 brief/insights 获取当前判断。

## 九、第一版落地清单

1. 给 10 个核心概念写 what/why/fields/relations/invariants。
2. 给 7 个页面写 purpose/data/actions/agentHints。
3. 命令描述符自动进入 manifest，带 layer/editable/risk。
4. 组件与 prompt pack 自动进入 manifest，带 editable/contract/source。
5. 生成 summary + detail 两级。
6. CLI/MCP 暴露 manifest.get。
7. 加一个 CI 检查：概念/页面/命令/提示词包缺描述或契约就报错。
