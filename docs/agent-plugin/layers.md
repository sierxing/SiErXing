# 分层与可编辑性 · 草案 v0.2

> 核心要小、要硬；非核心要大、要能改。
> 判断“能不能改”不看文件在哪，而看它属于哪一层、有没有契约保护。

## 一、五层模型

| 层 | 内容 | 可编辑 | 谁能改 | 保护 |
| --- | --- | --- | --- | --- |
| L0 内核 kernel | DB、HTTP、静态服务、鉴权、任务队列、AI 传输、插件加载器、命令总线、事件/审计、同步/更新/服务 | 否 | 只有代码提交 | 单测 + review |
| L1 领域核心 domain | 目标/节点/任务/教程/资料/笔记/进度的数据结构与不变量；输出解析与守卫 | 否 | 只有代码提交 | 契约测试 + 不变量测试 |
| L2 功能层 feature | 提示词、管线、功能页、功能测试 | 是 | 用户 / Agent | 审批 + 版本快照 + 契约测试 |
| L3 扩展层 extension | 附加组件、主题、布局、自定义页面 | 是 | 用户 / Agent | 审批 + 版本快照 + 回滚 |
| L4 内容层 content | 目标、节点、教程、资料、笔记、统计等用户数据 | 是 | 用户 / Agent | 命令权限 + 审计 |

一句话：

- **L0/L1 是宪法**：Agent 只读，代码层面不允许改。
- **L2/L3 是应用**：可以改，但必须走命令、审批、版本、回滚。
- **L4 是数据**：本来就可读写，按风险分级。

## 二、当前代码怎么分

| 模块 | 层 | 说明 |
| --- | --- | --- |
| server/server.js 的启动/HTTP/DB/备份 | L0 | 重构后是 composition root + kernel |
| server/tasks.js、task-progress.js | L0 | 任务运行、进度模型 |
| server/ai.js | L0 | AI 传输（不是提示词） |
| server/sync.js、update.js、service.js、data-dir.js、gui-env.js | L0 | 生命周期与系统集成 |
| server/plugins/index.js | L0 | 组件加载器 |
| server/tut-guard.js、tut-seg.js、explain-chunk.js | L1 | 结构守卫、切段、解析；契约 |
| server/rag.js、code-read.js、code-store.js | L1 | 检索/代码访问的底层能力；有安全边界 |
| server/node-folders.js、metrics.js | L1 | 目录校验、质量埋点 |
| server/server.js 里的规划/教程/资料管线 | L2 | 重构后进 server/features/* |
| server/server.js 里的提示词 | L2 | 重构后进 features/*/prompts.js + prompt packs |
| server/tut-plan.js、collect-screen.js、text-clean.js | L2 | 教程/资料功能的提示词与策略；可编辑 |
| server/plugins/*.js（非 core） | L3 | 附加组件；可编辑 |
| server/plugins/*.js（scope=core） | L0/L1 | plan、outlib；不可编辑 |
| public/app.js 的壳/路由/布局 | L0 | 核心 UI 壳；重构后保留 |
| public/app.js 的功能页 | L2 | 重构后按 feature 拆分 |
| public/sdk.js、index.html、style.css 的壳 | L0 | 组件 SDK 与主题引擎 |
| public/plugins/* | L3 | 前端附加组件；可编辑 |
| SQLite 里的用户数据 | L4 | 通过命令读写 |

## 三、核心内置组件（不可改）

当前 BUILTIN_COMPONENTS 的 scope：

| scope | 组件 | 可改 |
| --- | --- | --- |
| core | plan（路线图与规划）、outlib（资料库侧边栏） | 组件代码/UI/集成/数据契约：否；提示词包：见第四节 |
| base | clarify、constraints、sources、versions、chat、tutorial | 是（非核心） |
| base | jdfile（导入资料） | 是（非核心） |
| extra | pomodoro、studystats、notes、quiz、restate、explain、workspace、hot100、aiprompts 等 | 是 |
| theme | 各主题 | 是 |

规则：

- **scope=core 的组件**：UI、集成、数据契约不可由 Agent 改；只能通过代码提交。提示词包是独立资产，见第四节。
- **scope=base/extra/theme 的组件**：属于非核心；Agent 可以改配置、改提示词、改组件代码，但必须审批 + 快照 + 回滚。
- 组件元数据增加 **editable** 字段：core=false，base/extra/theme=true。
- 命令总线、加载器、UI 三处都读同一个 editable，不能只在一处挡。
- **tutorial 是用户设计的插件，不是核心**：用户可以继续用它，也可以自己做一个教程组件替换它（禁用内置 tutorial + 装/启用新组件）。

## 四、提示词属于哪一层

提示词是 **L2 功能层**，不是 L1 领域核心。但两者要分开：

- **提示词本身可改**：措辞、例子、输出格式、风格。
- **输出契约与守卫不可改**：解析器（parsePlan/parseTutorial）、结构守卫（tut-guard）、切段校验（tut-seg）、字段不变量属于 L1。提示词改得再花，输出过不了解析/守卫就不算数。

这带来一个关键结论：

> 核心组件（如 plan）的 **UI/集成**不可改；但它的 **提示词包**可以改，前提是通过同一套契约测试 + 用户审批。

提示词**不设锁死开关**，全部可改，包括核心组件用到的提示词。默认策略：

- 所有 prompt pack：editable=true，admin 级审批。
- 核心组件的 prompt pack：同样是 editable=true，但要求更严格的预览（至少 3 个样例）+ 契约测试全过；失败自动回滚。
- 领域解析/守卫：editable=false，任何情况下不改。

“慎重”体现在流程，而不是禁令：

- 改前必须预览：同一批 fixture 改前/改后的输出对比。
- 必须过契约：输出仍能被 parse/守卫接受。
- 必须有审批令牌：用户看过 diff 才生效。
- 必须有版本和回滚：不满意一键恢复上一版。
- UI 上明确提示：“这会改变 AI 的输出风格/结构，影响所有使用该提示词的功能。”

## 五、不可改清单（v1）

- server/kernel/*：DB、HTTP、鉴权、任务、AI 传输、插件加载、命令总线、事件、审计。
- server/domain/*：目标/节点/教程/资料的结构与不变量、解析器、守卫。
- server/server.js 的启动与 composition root。
- public/sdk.js、index.html、核心路由/布局/主题引擎。
- scope=core 组件的 UI/集成/数据契约。
- 任何密钥、同步凭据、服务配置。

## 六、可改清单（v1）

- server/features/*/prompts.js：提示词与上下文块调用。
- data/prompt-packs/*：用户/Agent 覆盖的提示词包。
- server/features/*/pipeline.js：管线步骤与策略（必须满足契约）。
- server/features/*/routes.js、public 的功能页。
- server/plugins/*（非 core）、public/plugins/*、主题、布局。
- L4 用户内容。
- 功能级测试（Agent 可以新增测试，但不能删核心测试）。

## 七、命令总线怎么执行

命令描述符增加 **layer** 与 **editable**：

~~~json
{
  "name": "prompt.update",
  "layer": "feature",
  "editable": true,
  "risk": "admin",
  "target": { "kind": "prompt-pack", "id": "plan.clarify" }
}
~~~

执行时：

1. 解析目标对象，读它的 layer/editable。
2. 组件：layer=core/domain 或 editable=false → 返回 forbidden，不进入执行。
3. 提示词包：没有 editable=false；一律 layer=feature、risk=admin，可改但必须审批 + 契约测试。
4. 组件的 feature/extension 改动 → 需要 admin 审批令牌。
5. layer=content → 按 write/destructive 权限。
6. 所有改动写审计 + 版本快照。

命令命名建议：

- **prompt.list / get / update / validate / preview / rollback**：改提示词。
- **feature.list / get / update / validate / preview / rollback**：改管线。
- **component.patchBuiltin**：改非核心内置组件（仅 scope=base/extra）。
- **component.install / uninstall / rollback**：新组件。
- **core.patch：禁止**（返回 forbidden）。

## 八、和自改文档的关系

- self-modification.md 里的“改内置组件”只适用于 **非核心内置组件**。
- 核心内置组件（plan/outlib）没有 component patch 路径，只能走代码提交；但它们的**提示词包仍可改**（谨慎流程同上）。
- 提示词改动走 prompt.* 命令，不走 component.*；两者风险等级、审批、回滚都分开。
