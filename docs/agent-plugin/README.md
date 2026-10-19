# 思而行 Agent 插件 · 设计草案 v0.2

> 让主 Agent 成为思而行的**超级用户 + 语义理解者 + 共同作者**。
> 思而行以「独立应用 / Agent 插件 / CLI / 桌面壳」多种形态存在，共享同一个内核。

## 一、已确定的决策（2026-10-17）

1. **权限**：读全开；写操作记录审计；删除、安装、自改必须用户确认。
2. **自改深度**：**从第一版就允许生成组件代码**。设置 / 主题 / 布局 / 组件配置 / 组件代码都通过命令走，配审计、版本快照、回滚。
3. **语义**：不只给 schema，要给「健康度 / 卡点 / 摩擦 / 意图」这类带证据的判断。
4. **第一刀**：先跑「目标闭环」，再跑「自改闭环」。
5. **形态**：一个内核 + 一层能力 + 多个客户端。插件和独立应用都是客户端，不是分叉。
6. **分层**：核心（内核 + 领域契约）不可改；非核心（提示词 / 管线 / 附加组件 / 主题 / 布局）可改，配审批、版本快照、回滚。
7. **核心内置组件**：scope=core（目前 plan、outlib）的代码/UI/集成/数据契约不可改；scope=base/extra/theme 的内置组件属于非核心，可改。**tutorial 是用户设计的插件，不是核心，可改、可替换。**
8. **提示词**：属于功能层，**全部可改、不设锁死**（包括核心组件用到的提示词）；输出契约与守卫属于领域层（不可改）。改提示词必须过契约测试 + 预览 + 审批 + 回滚，UI 明确提示“慎重”。

## 二、架构

~~~text
┌──────────────────────────────────────────────┐
│ 客户端：Web UI / CLI / MCP / 桌面壳 / 主 Agent │
└───────────────┬──────────────────────────────┘
                │ 同一套命令 / 查询 / 事件
┌───────────────▼──────────────────────────────┐
│ 能力层（Capability Layer）                     │
│  Command Bus · Query · Event Log · Manifest    │
│  Semantics（健康度 / 卡点 / 摩擦 / 意图）       │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ 内核：SQLite / AI / 任务 / 组件 / 同步          │
└──────────────────────────────────────────────┘
~~~

核心原则：

- **一套实现，多个调用者**。UI 和 Agent 走同一条命令总线，不出现「Agent 能删、UI 不能删」。
- **命令而不是端点**。不把 200 个 REST 路由包成 200 个工具，而是命令注册表 + 3 个元工具 + 几个高层技能。
- **事件是语义的原料**。每条命令发事件；语义引擎从事件和数据推导判断。
- **自改必须可批准、可审计、可回滚**。Agent 可以准备代码，但不能自己给自己发批准。

## 三、核心契约

| 文件 | 回答的问题 |
| --- | --- |
| [layers.md](layers.md) | 哪些是核心、哪些可改？核心内置组件是哪些？提示词属于哪一层？ |
| [refactor-plan.md](refactor-plan.md) | server.js 怎么拆？提示词怎么从 server.js 剥出来？迁移顺序与测试策略？ |
| [command-bus.md](command-bus.md) | Agent 能做什么？怎么发现、怎么执行、怎么授权、怎么撤销？ |
| [acceptance.md](acceptance.md) | 目标验收：51 命令 / 10 提示词 / 4 领域 / CLI/MCP/技能/插件包 的实跑证据 |
| [cli.md](cli.md) | 当前 CLI 怎么用、有哪些只读命令、输出约定。 |
| [app-manifest.md](app-manifest.md) | 思而行里每个东西是什么意思？字段、关系、页面、不变量是什么？ |
| [semantics.md](semantics.md) | 原始数据代表什么？健康度、卡点、摩擦、意图从哪里来？ |
| [self-modification.md](self-modification.md) | 用户说不舒服，Agent 怎么生成/安装组件代码而不闯祸？ |
| [host-agent.md](host-agent.md) | 思而行作为 Agent 插件时，当前 Agent 与模型列表怎么自动进设置？宿主必须提供什么？ |
| [skills/goal-coach/SKILL.md](skills/goal-coach/SKILL.md) | 目标闭环：问清 → 建目标 → 拆节点 → 跟进 → 复盘。 |
| [skills/fix-friction/SKILL.md](skills/fix-friction/SKILL.md) | 自改闭环：捕获不适 → 诊断 → 改配置/写组件 → 审批 → 验证/回滚。 |

## 四、第一版范围（MVP）

### 命令总线

- 命令注册表 + 元工具：**commands.list / commands.describe / commands.run**
- 20~30 个核心命令：goal / node / task / tutorial / note / component / setting / event / insight
- 统一的校验、权限、审计、事件、撤销
- 异步命令复用现有任务队列（server/tasks.js）

### 目标闭环（先做）

- goal.clarify：结构化问清「为什么 / 成功标准 / 约束 / 起点」
- goal.create + node.bulkCreate + plan.generate（异步）
- brief.goal / brief.progress / brief.user
- goal.dashboard：返回可视化地图链接
- skill：goal-coach

### 自改闭环（第二步）

- friction.report：用户说「这里不舒服」的结构化记录
- component.describe / updateConfig：先做安全配置修改
- component.scaffold / write / validate / preview / install / verify / rollback：允许生成组件代码
- prompt.list / get / update / validate / preview / rollback：允许改提示词（不锁死，但必须过契约测试）
- 审批令牌 + 版本快照 + 审计 + 撤销
- skill：fix-friction

### 暂不做

- 多用户 / 远程部署 / 权限组
- 核心 / 内核代码修改（只允许非核心 feature、extension、prompt pack）
- 第三方组件市场
- 完整的 MCP 传输矩阵（先 CLI + stdio）

## 五、实现阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 地基 | ✅ 命令总线、Manifest、CLI、审计/事件表、审批令牌 | Agent 能发现命令；read/write 可执行；admin/destructive 需用户批准 |
| P1 目标 | ✅ goal/node 写命令 + 简报读模型 + goal-coach 技能 | 目标从「问清」到「建目标/拆节点/下次会话读进度」闭环 |
| P2 语义 | ✅ 两批：goal_health / stall / momentum / milestone / empty_goal / friction / constraint_conflict / goal_drift / nextAction | insight.list 与 brief 已带判断 + 证据；intent/confidence/preference 待补 |
| P3 自改 | 🟡 prompt.* + file 插件自改已落地（导出/校验/暂存/预览/审批安装/卸载+回滚）；base 内置补丁待做 | Agent 能安全改提示词与非核心 file 插件；下一步做 base 内置补丁 |
| P4 生态 | ✅ MCP、安装器、多宿主、插件 manifest + 可构建插件包 | 独立应用 / CLI / MCP / 技能共用同一份 manifest |

## 五·五、当前可用（2026-10-17）

命令总线、写命令、审批、审计与 CLI 已经可在真实数据上运行：

~~~bash
node scripts/sierxing.js manifest --json
node scripts/sierxing.js brief user --json
node scripts/sierxing.js brief goal --id 166 --json
node scripts/sierxing.js insight list --goal 166 --json
node scripts/sierxing.js commands run prompt.list --json
node scripts/sierxing.js commands run prompt.preview '{"id":"sources.digest_batch"}' --json
node scripts/sierxing.js commands run component.list --json
node scripts/sierxing.js commands run setting.list --json
node scripts/sierxing.js commands run goal.create '{"title":"..."}' --json
node scripts/sierxing.js commands run node.create '{"goalId":166,"title":"..."}' --json
node scripts/sierxing.js audit list --limit 20 --json
~~~

对应 HTTP 接口：

- GET /api/commands
- GET /api/commands/manifest / GET /api/manifest（后者是增强版插件 manifest）
- GET /api/commands/:name
- POST /api/commands/run
- GET /api/approvals/:id（Agent 轮询）
- GET /api/approvals/:id/page（用户审批页）
- POST /api/approvals/:id/approve / reject
- GET /api/audit

当前 51 个命令：23 个 read + 19 个 write + 4 个 admin + 5 个 destructive。
write 直接执行但写审计；destructive/admin 需要用户在审批页点批准（审批表/审计表本机、不同步）。
- write：goal/node 增改、component.toggle。
- destructive：goal.delete / node.delete（删前有备份/版本快照）。
- admin：prompt.update/reset、setting.set（设置白名单，不含 AI key / sync token）。
insight.list 已给出目标健康度/卡点/动量/下一步；brief.goal / brief.user / goal.list 都带上了。
friction.report/list/update 已接入洞察：用户记录过的「不舒服」会出现在 insight.list / brief 里，供 Agent 找到最小改动。
非核心 file 插件已可自改：component.export → validate → stage → preview → 用户批准 → install；失败自动回滚旧文件，component.uninstall 卸载。详见 [component-pipeline.md](component-pipeline.md)。
prompt.* 已把 10 个提示词变成可编辑包（资料提炼 / chat ASK 规则 / chat Agent 规则 / 搜集方案 / 书单 / 清洗 / 规划问卷 / 路径骨架 / 教程生成）：内置模板 + 用户覆盖 + 版本历史 + 审批 + reset 回滚。
详见 [cli.md](cli.md)。

### 接入任意 Agent

- **CLI**：任何能执行 shell 的宿主都能用。
- **MCP（stdio）**：scripts/sierxing-mcp.js；Claude Code / Cursor / DSH 配置见 [mcp.md](mcp.md)。
- **Agent 插件包**：node scripts/build-plugin.js（或 npm run build:plugin）生成 manifest.json + mcp/ + skills/ + mcp.json + README；见 [packaging.md](packaging.md)。
- **多宿主 skill**：scripts/install-skills.js（claude / cursor / generic），把 goal-coach / fix-friction 装进宿主。

## 六、与现有代码的关系

- 命令总线**先包一层**现有 REST handler，不要求一次性重写 server.js。
- 先用 **refactor-plan.md** 把提示词从 server.js 剥到 features/*/prompts.js，再逐步拆 domain/ 与 kernel/。
- 组件安装复用现有 **sierxing-component** bundle 格式（见 examples/dailyquote.component.json）。
- 异步命令复用 server/tasks.js 的任务队列与进度模型。
- 语义引擎先用**确定性规则**（卡点、节奏冲突、摩擦），再考虑 AI 解读。
- 所有 agent 写入都带 actor 和审计；数据仍以 SQLite 为唯一真源。
- 分层是硬约束：core/domain 不可改，feature/extension 可改，content 按数据权限改。

## 七、待你后续拍板的问题

1. 审批令牌的发放方式：Web UI 弹窗 / CLI 确认 / 宿主自己的审批 UI，先支持哪一种？
2. 组件代码的静态检查红线：哪些 API 一律拒绝（网络、spawn、任意 fs）？
3. 语义洞察的更新频率：命令后实时 / 每次会话结束 / 每日一次？
4. 目标闭环的第一个真实用例：用你自己的哪个目标来验收？
