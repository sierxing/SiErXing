# 思而行 CLI · 当前可用版

> 这是主 Agent 的**通用入口**：任何能执行 shell 命令的宿主都能用。
> 不依赖 MCP；MCP 只是以后多加的一层薄适配。

## 运行

~~~bash
node scripts/sierxing.js manifest --json
node scripts/sierxing.js commands list --json
node scripts/sierxing.js commands describe brief.goal --json
node scripts/sierxing.js brief user --json
node scripts/sierxing.js goal list --json
~~~

默认连 http://127.0.0.1:3213；可用环境变量覆盖：

~~~bash
SIERXING_URL=http://127.0.0.1:3213 node scripts/sierxing.js manifest --json
~~~

## 输出约定

- 成功：{ "ok": true, "result": ... }
- 失败：{ "ok": false, "error": { "code": "...", "message": "...", "details"?: {...} } }
- 所有命令都支持 --json（Agent 用）；不带 --json 时会给人话摘要。

## 读命令

| 命令 | 用途 |
| --- | --- |
| manifest.get | 应用版本、分层、概念、全部命令 |
| goal.list | 目标列表（任务总数/完成数/下一任务） |
| goal.get | 单个目标 + 节点 + 教程索引 |
| node.list | 目标下的节点 |
| tutorial.get | 教程元数据 + 正文（offset/limit 分页） |
| tutorial.list | 目标下的教程清单（id/标题/节点/格式/正文长度） |
| brief.user | 用户全局简报（最近目标/活跃目标） |
| brief.goal | 目标简报（进度/下一任务/最近教程） |
| source.list | 目标下的资料清单 |
| insight.list | 目标健康度/卡点/动量/下一步；带 goalId 只返回该目标 |
| prompt.list / prompt.get / prompt.preview / prompt.history / prompt.validate | 可编辑提示词包：列表/模板/预览/版本历史/只校验不保存 |
| component.list / component.describe | 组件清单/详情（开关、scope、能否关闭） |
| component.export / component.validate | 导出/校验非核心 file 插件 bundle（不写盘） |
| friction.list | 摩擦记录（open / fixed / dismissed），可按目标/组件/状态过滤 |
| setting.list / setting.get | Agent 可见的非密钥设置白名单 |
| audit.list | 最近的命令执行记录 |

## 写命令（会写审计）

| 命令 | 用途 |
| --- | --- |
| goal.create | 创建目标（draft） |
| goal.update | 改 title/profile/materials/weekly_hours/deadline/status/summary |
| goal.archive | 归档目标（不删除数据） |
| plan.generate | 后台生成路径骨架（AI 长任务，返回 taskId；可能先返回问卷） |
| node.create | 建节点/任务（parentId 可嵌套，level 自动） |
| node.update | 改 title/detail/artifact/acceptance/hours/status |
| node.complete | 把节点置为 done |
| tutorial.generate | 为节点后台生成教程（AI 长任务，返回 taskId；进度看任务中心） |
| tutorial.edit | 按意见后台修改教程（AI 长任务，返回 taskId；结构守卫/版本快照沿用原路径） |
| tutorial.rename | 改教程标题 |
| source.add | 添加资料（标题/正文/链接/类型；重建检索索引） |
| source.collect | 为目标后台搜集信息源（AI 长任务，返回 taskId） |
| source.digest | 为目标后台提炼资料并生成主题汇总（AI 长任务，返回 taskId） |
| source.update | 改资料标题/正文/类型/人工星级 |
| component.toggle | 全局开关组件（write，审计；核心不可关，主题互斥） |
| component.stage | 暂存组件 bundle（write；只写本机 staging，不碰正式目录） |
| friction.report / friction.update | 记录/更新用户摩擦（write，审计） |

~~~bash
node scripts/sierxing.js commands run goal.create '{"title":"转行 AI 产品经理","weekly_hours":"10","deadline":"3 个月"}' --json
node scripts/sierxing.js commands run node.create '{"goalId":166,"title":"列 10 个目标岗位","acceptance":"有一张表"}' --json
~~~

## 危险命令（destructive，必须用户批准）

| 命令 | 作用 |
| --- | --- |
| goal.delete | 删除目标及节点/资料/教程/对话/版本；备份仍保留 |
| node.delete | 删除节点及其子树；删前保存版本快照 |
| tutorial.delete | 删除教程及其版本/书签/进度 |
| source.delete | 删除资料及其代码快照/检索索引 |
| component.uninstall | 删除非核心 file 插件文件并 reload |

流程同审批：第一次返回 approval_required + approveUrl；用户批准后，用同一命令 + 同一份入参 + --approval 重试。

~~~bash
node scripts/sierxing.js commands run goal.delete '{"goalId":123}' --json
node scripts/sierxing.js commands run node.delete '{"nodeId":456}' --json
~~~

## 管理命令（admin，必须用户批准）

| 命令 | 作用 |
| --- | --- |
| prompt.update / prompt.reset | 改/恢复提示词包 |
| component.install | 安装已暂存的非核心组件；失败自动回滚旧文件 |
| setting.set | 改非密钥设置（白名单：备份/搜集/清洗/检索/AI 模型/讲解风格） |

setting.* 只暴露白名单；AI key、sync token 等永远不在 Agent 可读/可写范围。

## 组件自改流水线（非核心 file 插件）

~~~bash
node scripts/sierxing.js commands run component.export '{"id":"pomodoro"}' --json
node scripts/sierxing.js commands run component.validate '{"bundle":{...}}' --json
node scripts/sierxing.js commands run component.stage '{"bundle":{...}}' --json
# → changeId + previewUrl；给用户看代码
node scripts/sierxing.js commands run component.install '{"changeId":"chg_..."}' --json
# → approval_required；用户批准后加 --approval 重试
~~~

- 只支持 file 插件（extension 层）；core/base 内置组件不能通过这条路覆盖。
- 组件 JS 在应用进程内运行，必须用户批准；加载失败会自动回滚旧文件。
- 详见 [component-pipeline.md](component-pipeline.md)。

## 提示词包（可编辑 / 可回滚）

提示词包 = 内置模板 + 本机用户覆盖（prompt_packs / prompt_pack_versions，不同步）。
没有覆盖时按原纯函数渲染，行为与改造前一致；覆盖后才走模板。

~~~bash
node scripts/sierxing.js commands run prompt.list --json
node scripts/sierxing.js commands run prompt.get '{"id":"sources.digest_batch"}' --json
node scripts/sierxing.js commands run prompt.preview '{"id":"sources.digest_batch"}' --json
node scripts/sierxing.js commands run prompt.history '{"id":"sources.digest_batch"}' --json
node scripts/sierxing.js commands run prompt.validate '{"id":"sources.digest_batch","template":"..."}' --json
~~~

修改（admin，需要用户批准）：

~~~bash
node scripts/sierxing.js commands run prompt.update '{"id":"sources.digest_batch","template":"..."}' --json
# → 403 approval_required + approvalId/approveUrl
# 用户批准后，用同一份入参重试：
node scripts/sierxing.js commands run prompt.update '{"id":"sources.digest_batch","template":"..."}' --json --approval <approvalId>
# 恢复内置：
node scripts/sierxing.js commands run prompt.reset '{"id":"sources.digest_batch"}' --json --approval <approvalId>
~~~

约束：

- 模板必须保留占位符（如 {{batchNo}} / {{total}} / {{items}}）与关键契约（JSON 字段名）；不满足直接 bad_input。
- 当前 10 个包：sources.digest_batch / sources.digest_synthesis（资料提炼）、chat.ask_rules（对话 ASK 模式规则）、chat.agent_rules（对话 Agent 模式规则，含 {{tutorialEditOp}}）、sources.collect_plan（搜集方案）、sources.ebook_recommend（入门书单）、sources.clean（资料清洗）、plan.clarify（规划前问卷）、plan.skeleton（路径骨架）、tutorial.generate（教程生成）。
- 规划类包改动会影响生成质量：先 prompt.preview + prompt.validate，再让用户批准；默认（没覆盖时）仍走原函数，行为不变。
- 修改前先 prompt.preview 给用户看；改坏用 prompt.reset 恢复内置。

## 危险操作与审批

destructive / admin 命令（未来的删除、安装组件、改提示词等）不会直接执行：

1. 第一次调用返回 403 + approval_required，details 里带 approvalId / approveUrl。
2. 用户在浏览器打开 approveUrl 点「批准并执行」，或运行：

~~~bash
node scripts/sierxing.js approve <approvalId>
~~~

3. Agent 用同一个命令 + 同一份入参 + --approval 重试：

~~~bash
node scripts/sierxing.js commands run <command> '<同样的 JSON>' --json --approval <approvalId>
~~~

4. 审批一次性、绑定命令与入参哈希、30 分钟过期；用过即失效。

Agent 也可以轮询：

~~~bash
node scripts/sierxing.js approvals get <approvalId> --json
node scripts/sierxing.js approvals list --status pending --json
~~~

当前 destructive 命令：goal.delete / node.delete / tutorial.delete / source.delete / component.uninstall；admin 命令：prompt.update / prompt.reset / component.install / setting.set。
组件安装、非核心组件代码补丁还没实现。
**Agent 不得自己调用 approve**——批准是用户动作；Agent 只负责把 approveUrl 给用户并轮询。

## 审计

每次命令执行（包括失败的 write）都会写 command_audit：

~~~bash
node scripts/sierxing.js audit list --limit 20 --json
~~~

记录：命令、actor、风险、成功/失败、耗时、入参摘要、错误。审计表是本机数据，不同步。

## Agent 推荐起手式

~~~bash
# 1. 认识应用
node scripts/sierxing.js manifest --json

# 2. 知道用户现在在做什么
node scripts/sierxing.js brief user --json

# 3. 深入当前目标
node scripts/sierxing.js brief goal --id 166 --json

# 3.5 看健康度/卡点/动量（brief.goal 已带，单独查也行）
node scripts/sierxing.js insight list --goal 166 --json
node scripts/sierxing.js insight list --json

# 4. 需要读教程时再分页读，不要一次拉全文
node scripts/sierxing.js tutorial get --id 144 --limit 8000 --json
~~~

## 从 CLI 到 MCP / 宿主技能

- MCP（stdio）：node scripts/sierxing-mcp.js；宿主配置见 [mcp.md](mcp.md)。
- 多宿主 skill：node scripts/install-skills.js list / install --host claude|cursor / mcp-config。
- 两者和 CLI 共用同一套命令总线、审计与审批；命令名点号在 MCP 里映射成下划线。

## 设计约束

- 命令总线是唯一能力清单；CLI / UI / 以后的 MCP 都走它。
- read 直接执行；write 直接执行但审计；destructive/admin 必须用户批准。
- 教程正文分页，避免把上下文撑爆。
- 当前服务实际监听 0.0.0.0:3213（局域网可达）；不要在公网暴露。后续加本地 token，或默认绑定 127.0.0.1。
- 审批/审计表是本机数据，不跨设备同步。
