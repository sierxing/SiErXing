# 内核重构与提示词剥离 · 迁移方案 v0.1

> 目标：把 server.js 从“什么都装”变成“组装 + 启动”；把提示词、管线、功能页挪到可编辑的功能层；把数据结构、不变量、守卫留在不可改的领域层。
> 原则：每一步都行为不变、可回滚、可测试；不做一次性大爆炸重写。

## 当前进度（2026-10-17）

- 已完成：
  - 分层与规则：layers.md、core/non-core（tutorial 是插件）、提示词全部可改不锁死。
  - 提示词：server/prompts/context.js（goalHeader、richMdSpec、vizSpec、digests、nodeSources、sourcesIndex、siblingScope、sourcesBlock、qaRender、constraints、goalQa）；server/prompts/digest.js；server.js 只留薄适配层（净删 242 行）。
  - 命令总线：server/commands/bus.js + index.js；15 个命令（9 read + 6 write）；/api/commands*。
  - 审批/审计/事件：approvals / command_audit / command_events 本机表；审批页 server/approvals-page.js；/api/approvals*、/api/audit。
  - CLI：scripts/sierxing.js（manifest / commands / brief / goal / node / tutorial / source / insight / approvals / approve / reject / audit）。
  - 语义洞察：server/insights.js（goal_health / stall / momentum / milestone / empty_goal / friction / constraint_conflict / goal_drift / nextAction）；insight.list；brief.goal / brief.user / goal.list 已带 health / momentum / insights；goal_field_events 记录目标字段变更（本机）。
  - 提示词包：server/prompts/packs.js（资料提炼 + chat.ask_rules/chat.agent_rules）+ chat-packs.js（对话静态规则块，从 buildChatPrompt 原样提取）+ plan-packs.js（plan.clarify/plan.skeleton）+ sources-packs.js（collect_plan/ebook_recommend/clean）+ tutorial-packs.js（tutorial.generate）+ tutorial-rules.js（篇幅/格式）+ registry.js（覆盖/版本/校验/动态注册/renderAsync/hasOverride）；prompt.list/get/preview/history/validate（read）、prompt.update/reset（admin，审批）；共 10 个包，默认仍走 builtinRender，行为不变。
  - 资料/教程管理：tutorial.list/rename/delete、source.add/update/delete（写审计；delete 走审批；资料变更后重建检索索引）。
  - 长任务入口（第一刀）：tutorial.generate 命令复用 streamTutorial + 假 res 后台启动教程生成，返回 taskId；tutorial.edit 调本机现有修改接口（结构守卫/版本快照不复制），同样立即返回 taskId；source.collect 复用 streamCollect + 假 res 后台启动资料搜集；source.digest 复用新包了 tasks.begin 的 streamDigest + 假 res 后台提炼；plan.generate 复用新包了 tasks.begin 的 streamPlan + 假 res 后台生成规划；进度都走任务中心。
  - 多形态：GET /api/manifest（schema sierxing.plugin/1；commands/prompts/components/surfaces/capabilities）；scripts/build-plugin.js 生成 Agent 插件包（manifest + MCP + skills + mcp.json + README）；test-plugin-package 7 项。
  - 领域拆分：server/domains/backups.js（createBackupDomain；注入 dbPath/backupDir/getSetting/nowStamp/onDataChange；backup/backupList/pruneBackups/backupDiff）+ server/domains/versions.js（createVersionDomain；注入 db/nowISO/safeParse/goalCompOn/aiText/currentModel；beginVersion/diffVersions/templateReport/buildReportPrompt/finishVersion）+ server/domains/goals.js（createGoalDomain；注入 db；orderedLeaves/goalWithStats/getGoal/roadmapOutline）+ server/domains/sources.js（createSourceDomain；注入 db/cleanText/nowISO；sourcesOf/digestsOf/digestBatches/buildLibraryMarkdown）；server.js 只做组装；test-backup-domain 6、test-versions-domain 8、test-goals-domain 6、test-sources-domain 6。
  - MCP + 多宿主：scripts/sierxing-mcp.js（stdio JSON-RPC，tools/list + tools/call + 审批状态工具）；scripts/install-skills.js（claude / cursor / generic + mcp-config）；docs/agent-plugin/mcp.md。
  - 操作全功能：goal.delete / node.delete（destructive，审批；服务端 deleteGoalData/deleteNodeData 与 HTTP 路由共用）；component.list/describe/toggle；setting.list/get/set（白名单，admin 审批）。
  - 摩擦闭环：friction.report/list/update + friction_reports 本机表；open 摩擦进入 insight.list / brief（insights 里 type=friction，带 evidence/suggestedActions）。
  - 组件自改（file 插件）：component.export/validate（read）、component.stage（write）、component.install（admin）、component.uninstall（destructive）；component-pipeline.js 纯校验、component-preview-page.js 预览页；安装前 backup、加载失败自动回滚旧文件；实际安装/卸载已演练。
- 验证：
  - 与迁移前原实现逐字对比 32 项一致（context 5 + digest 5 + 数据块 22）。
  - 新测试：test-prompt-context 6、test-prompt-context-data 16、test-prompt-digest 4、test-commands 15、test-commands-write 27（内存库；含删除/资料/资料搜集与提炼/教程生成与修改/规划生成/组件/设置/摩擦/组件自改/审批）、test-component-pipeline 8（组件包校验）、test-insights 11（内存库；含摩擦/漂移/约束冲突洞察）、test-backup-domain 6（备份领域）、test-versions-domain 8（版本领域）、test-goals-domain 6（目标读取领域）、test-sources-domain 6（资料/提炼领域）、test-plugin-package 7（插件包）、test-prompt-packs 14（模板=原函数 / 覆盖 / reset / 校验 / 动态 async 包 / 规划、资料、教程、chat 模板元数据 / 教程动态片段）、test-mcp 14（真实服务）、test-skills-install 7（临时目录）。
  - 审批链路 HTTP 端到端 5 项：GET 审批、审批页 HTML、POST approve、状态持久化、/api/audit。
  - 既有回归：tut-guard 19、tut-seg 12、explain 39、pomodoro probe 4。
  - 真实数据：CLI 读取目标 166（89 节点 / 27 教程 / 241 资料），教程分页正常；/api/health 正常。
- 下一步：
  1. 继续 Domain/features 拆分，server.js 变组装根。
  2. base 内置组件（tutorial 等）代码补丁 / component.patchBuiltin（file 插件已可自改）。

## 一、现状

- server/server.js：8043 行；组件分类、目标/节点、资料抓取、电子书、AI 规划、AI 调用、Markdown 规范、版本快照、规划进度、草稿、对话改规划、节点附件、质量埋点、教程体检、分节教程、HTTP 路由全在一个文件里。
- public/app.js：12483 行；壳、路由、页面、组件宿主、Markdown、对话、收藏栏也全在一起。
- 提示词散落在 server.js：buildClarifyPrompt、buildDrillPrompt、buildSkeletonPrompt、buildTasksPrompt、buildExpandPrompt、buildTutorialPrompt、buildTutorialEditPrompt、buildTutorialPatchPrompt、buildSegmentPrompt、buildChatPrompt、buildReportPrompt、digestBatchPrompt、digestSynthesisPrompt、buildCollectPlanPrompt、buildEbookRecommendPrompt、buildTruncRepairPrompt 等。
- server/tut-plan.js 顶部已经写明：大纲/资料库提示词块都在 server.js 里是模块私有的，只能靠工厂注入。这是结构问题的直接证据。
- 另外还有 collect-screen.js、text-clean.js、tut-guard.js、tut-seg.js、explain-chunk.js、server/plugins/*.js 里的提示词与守卫。

## 二、目标结构

~~~text
server/
  server.js                 # composition root：只负责组装和启动
  kernel/                   # L0 不可改
    http.js                 # 服务、静态资源、请求生命周期
    db.js                   # SQLite 连接、迁移、备份
    auth.js                 # 本地 token / 权限
    tasks.js                # 任务队列
    task-progress.js        # 进度模型
    ai-transport.js         # AI 传输（不含提示词）
    plugin-loader.js        # 组件加载
    command-bus.js          # 命令总线
    events.js               # 事件
    audit.js                # 审计
    manifest.js             # App Manifest 生成
    sync.js / update.js / service.js / data-dir.js / gui-env.js
  domain/                   # L1 不可改
    goals.js / nodes.js / tutorials.js / sources.js / notes.js / progress.js
    guards/                 # tut-guard、tut-seg、explain-chunk、解析器
    rag.js / code-read.js / code-store.js / node-folders.js / metrics.js
  prompts/                  # L2 共享提示词基础设施
    context.js              # goalHeader、constraintsBlock、digestsBlock…
    registry.js             # 解析内置包 + 用户覆盖包
  features/                 # L2 可改
    plan/                   # manifest.js / prompts.js / pipeline.js / routes.js
    tutorial/
    sources/
    chat/
    review/
    explain/
data/
  prompt-packs/             # 用户/Agent 覆盖的提示词包（可改、可回滚）
~~~

server.js 最终只做：

~~~js
const kernel = require('./kernel');
const domain = require('./domain');
const features = require('./features');
const app = kernel.create();
domain.register(app);
features.register(app);
app.start();
~~~

## 三、server.js 现有分区与归属

| 行区间（约） | 内容 | 归属 |
| --- | --- | --- |
| 455 | 组件分类、开关、内置组件 | L0 组件注册 + L3 组件实现 |
| 712 | 目标与节点 | L1 domain |
| 793 | 信息源抓取 | L2 features/sources |
| 1173 | 电子书搜集 | L2 features/sources |
| 1649 | AI 规划（提炼、问卷、骨架、任务、展开、细化） | L2 features/plan + sources |
| 2420 | AI 调用适配 | L0 kernel/ai-transport |
| 2544 | Markdown 内联 HTML 规范 | L2 prompts/context |
| 2574 | 可视化块规范 | L2 prompts/context |
| 2929 | 版本快照与对比 | L1 domain/versions |
| 3146 | 规划进度反馈 | L0 kernel/tasks |
| 3187 | 规划草稿、断点继续 | L2 features/plan |
| 3488 | 对话式改规划 | L2 features/chat |
| 3670 | 节点附件 | L2 features/chat 或 plan |
| 4384 | 质量闸门埋点 | L1 domain/metrics |
| 4467 | 教程完整性体检 | L1 domain/guards |
| 4684 | 分节教程生成 | L2 features/tutorial |
| 5090 | HTTP 路由 | L0 kernel/http + 各 feature routes |
| 6193 | 结构改动范围核对 | L2 features/plan |

## 四、提示词清单与归属

| 提示词/构建函数 | 功能 | 目标位置 | 依赖的上下文块 |
| --- | --- | --- | --- |
| buildClarifyPrompt / buildDrillPrompt | 问卷 / 深挖 | features/plan/prompts.js | goalHeader、digestsBlock、libraryBlock |
| buildSkeletonPrompt / buildSkeletonRepairPrompt / buildRefineSkeletonPrompt | 骨架 | features/plan/prompts.js | goalHeader、goalQaBlock、constraintsBlock、digestsBlock、libraryBlock |
| buildStageGoalsPrompt / buildTasksPrompt | 阶段目标 / 任务 | features/plan/prompts.js | goalHeader、constraintsBlock、digestsBlock |
| buildExpandPrompt / buildRefineNodePrompt | 展开 / 细化 | features/plan/prompts.js | goalHeader、constraintsBlock、nodeSourcesBlock |
| buildReportPrompt | 变更报告 | features/plan/prompts.js | goalHeader、constraintsBlock |
| digestBatchPrompt / digestSynthesisPrompt | 资料提炼 | features/sources/prompts.js | 纯输入（批次/结果） |
| buildCollectPlanPrompt / buildEbookRecommendPrompt | 搜集计划 / 电子书 | features/sources/prompts.js | goalHeader |
| collect-screen.buildScreenPrompt | AI 把关 | features/sources/prompts.js | 纯输入 |
| text-clean.buildCleanPrompt | AI 清洗 | features/sources/prompts.js | 纯输入 |
| buildChatPrompt | 对话 | features/chat/prompts.js | 大量上下文块 + 资料库 |
| buildTutorialPrompt / buildTutorialEditPrompt / buildTutorialPatchPrompt / buildSegmentPrompt / buildTruncRepairPrompt | 教程生成/修改 | features/tutorial/prompts.js | goalHeader、goalQaBlock、constraintsBlock、siblingScopeBlock、digestsBlock、nodeSourcesBlock、sourcesIndexBlock、richMdSpecLines、vizSpecLines |
| tut-plan.js 的大纲/逐节/复盘提示词 | 分节教程 | features/tutorial/prompts.js | 同上 |
| server/plugins/explain.js 的提示词 | 看懂代码 | features/explain/prompts.js | 代码/风格/前置知识 |
| quiz / restate / hot100 的提示词 | 各自功能 | 对应 extension/feature 包 | 各自输入 |
| richMdSpecLines / vizSpecLines | 输出规范 | prompts/context.js | 无 |

共享上下文块：goalHeader、goalQaBlock、constraintsBlock、siblingScopeBlock、digestsBlock、nodeSourcesBlock、sourcesIndexBlock、libraryBlock、richMdSpecLines、vizSpecLines。

## 五、提示词剥离的关键设计

### 1. 上下文块先变成纯函数

现在这些块在 server.js 里直接查 DB、调 RAG、读 settings。剥离后改成：

~~~js
function goalHeader(goal) { ... }                 // 纯
function constraintsBlock(goal) { ... }           // 纯
function digestsBlock(digests) { ... }            // 纯
function nodeSourcesBlock(node, sources) { ... }  // 纯
function libraryBlock(library) { ... }            // 纯，library 由调用方查好传进来
~~~

server.js / feature pipeline 负责查数据，拼一个 ctx：

~~~js
const ctx = {
  goal, nodes, tutorial, sources, digests,
  library: await rag.libraryFor(...),
  settings: {...},
  codeBlock: '...'
};
const prompt = prompts.build('tutorial.full', ctx);
~~~

**提示词层不 import DB、不 import server.js**。这样既能单测，也不会循环依赖。

### 2. Prompt Pack 契约

每个提示词包一个 manifest：

~~~json
{
  "id": "tutorial.full",
  "version": 1,
  "feature": "tutorial",
  "editable": true,
  "inputs": ["goal", "node", "format", "sources", "digests"],
  "output": "markdown",
  "contract": "tutorial.parse",
  "tests": ["tutorial.full.basic"]
}
~~~

- id 稳定；版本递增。
- contract 指向 L1 的解析/守卫；输出过不了 contract 就不算成功。
- 提示词包不设 editable=false；全部可改。保护靠 contract + fixture + 预览 + 审批 + 回滚。
- 用户/Agent 覆盖包放在 data/prompt-packs/<id>/，优先于内置包；加载失败回退内置。

### 3. 提示词不是“随便写”

- 允许改措辞、例子、输出格式、风格。
- 必须保留契约要求的字段/结构；由 L1 的 parser/guard 校验。
- 提示词包必须带至少一个 fixture 测试：固定输入 → 输出能被 contract 解析。
- 编辑提示词走 prompt.update 命令：staging → 预览（至少 3 个 fixture 的改前/改后输出）→ 用户批准 → 生效 → 可回滚。
- 改提示词要慎重：它会影响所有调用该包的功能；UI 明确提示影响面，用户确认后才生效。

## 六、迁移步骤（每一步都可独立发布）

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| R0 | 本文档 + layers.md + 组件 editable 元数据 | 文档齐、无行为变化 |
| R1 | 把上下文块抽到 prompts/context.js，server.js 改为引用 | 同一 fixture 生成的提示词逐字一致 |
| R2 | prompt registry + 第一个提示词家族（建议 digest） | 单测 + 内置/覆盖包切换 |
| R3 | 抽 plan 家族（clarify/skeleton/tasks/expand/refine/report） | 规划端到端假 AI 通过 |
| R4 | 抽 tutorial 家族 + tut-plan.js | 教程端到端假 AI 通过 + 守卫通过 |
| R5 | 抽 sources 家族 + collect-screen/text-clean 提示词 | 采集/清洗端到端 |
| R6 | 抽 chat / review / explain 提示词 | 对话与插件端到端 |
| R7 | 把目标/节点/教程/资料/笔记/进度拆到 domain/ | 路由行为不变 |
| R8 | 把管线/路由拆到 features/，server.js 变组装根 | server.js < 500 行，路由全通 |
| R9 | 命令总线 + 事件 + 审计 + Manifest | Agent 能 list/describe/run |
| R10 | 层约束 + 可编辑包 + 审批/回滚 | core 组件改不动；非 core 组件与所有提示词可改 |

建议先做 R1+R2，拿一个家族验证“零行为变化”的流程，再批量推进。

## 七、测试策略

### 提示词

- **Golden fixture**：固定 goal/node/sources/digests，移动前后各生成一次，逐字对比。
- **结构断言**：必须包含的段落、必须没有的泄漏（内部变量名、undefined、[object Object]）。
- **契约测试**：提示词输出交给 parsePlan / parseTutorial / tutGuard 等，必须能解析/通过。
- **覆盖包测试**：内置包、用户覆盖包、损坏包回退三条路径。

### 管线

- 假 AI 服务器（项目已有 fake-ai 模式）：固定回复，断言最终数据、任务状态、事件。
- 每个 feature 一个最小端到端：plan / tutorial / sources / chat。

### 工程

- 每步 node --check。
- 起 NO_OPEN=1 的实例，curl /api/health、/api/plugins。
- 路由 smoke：首页、目标页、教程页、组件页、统计页。
- 无头浏览器用完必须按 AGENTS.md 的清理流程收尸。

## 八、风险与对策

| 风险 | 对策 |
| --- | --- |
| 提示词移动后行为漂移 | 上下文块和提示词一起搬；golden fixture 逐字对比 |
| 循环依赖 | 提示词层不 import DB/server.js；用 ctx 注入 |
| 全局状态 | 所有数据从 ctx 进；不在提示词里读 settings |
| 一次性大改 | 一个家族一步；保留 re-export；每步可回滚 |
| 提示词可改导致质量下降 | 契约/守卫留在 L1；审批 + fixture + 回滚 |
| 提示词包热加载 | registry 缓存 + 显式 reload + 版本号 |
| 前端 app.js 太大 | 本轮不动前端；先 server，再按 feature 拆页面 |

## 九、第一刀建议

1. R1：抽 context.js（goalHeader/constraintsBlock/digestsBlock/nodeSourcesBlock/sourcesIndexBlock/siblingScopeBlock/richMdSpec/vizSpec）。
2. R2：抽 digest 家族（digestBatchPrompt / digestSynthesisPrompt）——输入纯、依赖少，最适合验证流程。
3. R3：抽 clarify 家族，验证“上下文块 + 提示词 + parser”一起搬。
4. 跑通后再批量抽 plan/tutorial。

## 十、已确认的边界（2026-10-17）

1. **core = plan、outlib**：组件代码/UI/集成/数据契约不可改，也不可替换。
2. **tutorial 是用户设计的插件，不是 core**：可改、可替换；用户也可以自己做一个教程组件替换它。
3. **所有提示词都可改，不设锁死**（包括 core 组件用到的）；保护靠预览 + 契约测试 + 审批 + 回滚，靠流程而不是禁令。
4. 其余 base/extra/theme 组件都是非核心，可改、可替换。

## 十一、还需要你确认

1. **覆盖包格式**：内置包用 JS 模块（可写条件逻辑）；用户/Agent 覆盖包也用 JS 模块（同契约 + 静态检查），还是只允许 JSON 模板？
2. **第一刀**：按 digest → clarify → plan 的顺序，先从 server.js 抽提示词，对吗？
