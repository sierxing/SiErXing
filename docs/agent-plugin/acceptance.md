# 验收：思而行 × 主 Agent 深度嵌合

> 对应长期目标：把思而行改造成可与主 Agent 深度嵌合的插件——提示词/分层重构、命令总线、Manifest、事件与语义洞察、CLI/MCP/技能，Agent 可读取目标与进度、操作全功能、编辑提示词与非核心组件；独立应用/插件多形态共享同一底座；每步可运行、可测试、可回滚。
>
> 版本：v1.10.84　｜　验收日期：2026-10-18　｜　服务：http://127.0.0.1:3213

## 一、结论

目标中的交付物已全部落地并有可复现证据：

| 目标项 | 交付物 | 证据 |
| --- | --- | --- |
| 提示词重构 | 10 个可编辑提示词包（资料提炼 2 + 对话 2 + 规划 2 + 资料 3 + 教程 1） | `prompt.list` = 10；test-prompt-packs 14 项 |
| 分层重构 | 4 个领域模块 + prompts/ + commands/ + component-pipeline + insights | test-*-domain 6/8/6/6 项；server.js 只做组装 |
| 命令总线 | 59 个命令：24 read / 25 write / 4 admin / 6 destructive | `/api/manifest`；test-commands 15 项 + test-commands-write 28 项 |
| 事件与审计 | command_audit / command_events / approvals（本机表） | `audit.list`；test-commands 审批闭环 |
| 语义洞察 | goal_health / stall / momentum / milestone / empty_goal / friction / constraint_conflict / goal_drift | `insight.list`；test-insights 11 项 |
| 读目标与进度 | `goal.list / goal.get / brief.goal / brief.user / insight.list` | CLI 实跑；goal/sources 领域测试 |
| 操作全功能 | 目标/节点/教程/资料/组件/提示词/设置/摩擦/备份版本读取 + 5 个长任务 | `commands list`；test-commands-write 27 项 |
| 编辑提示词 | prompt.update / reset（admin，需用户批准，存覆盖+版本） | test-prompt-packs；prompt.history |
| 编辑非核心组件 | file 插件 export / validate / stage / install / uninstall（安装需批准，失败回滚） | component.export(pomodoro) 成功；component.export(plan) = forbidden |
| CLI | `node scripts/sierxing.js`（manifest/commands/goal/node/tutorial/source/brief/insight/approvals/audit） | CLI 实跑 manifest / brief / insight |
| MCP | stdio JSON-RPC 适配器，工具名点号→下划线（如 plan.apply → plan_apply），审批透传 | test-mcp 14 项全过 |
| 多宿主技能 | claude / cursor / generic 安装器 + mcp-config | test-skills-install 7 项全过 |
| 多形态底座 | 独立 Web 应用 + CLI + MCP + 技能 + 可构建 Agent 插件包 | `node scripts/build-plugin.js`：commands=59 / prompts=10 / skills=2 |
| 可回滚 | 组件安装失败自动回滚旧文件；备份/版本领域；审批一次性令牌 | test-component-pipeline / backup-domain / versions-domain |

## 二、实跑证据

```bash
curl -s http://localhost:3213/api/health
# {"ok":true,"app":"思而行"}

node scripts/sierxing.js manifest
# 思而行 v1.10.84 · 59 个命令

node scripts/sierxing.js brief user
# 目标总数：5 … 当前活跃 … 最值得注意：…

node scripts/sierxing.js insight list --goal 166
# 目标 #166 · on_track · 0 天未动
# [critical] 剩余任务约 105 小时 …

node scripts/build-plugin.js
# commands=59 prompts=10 skills=2
```

组件编辑边界：

```
component.export {id:"pomodoro"} → ok=true，返回 server/client/style 源码包
component.export {id:"plan"}     → ok=false, code=forbidden（核心组件不可改）
```

## 三、回归

```bash
node --no-warnings scripts/test-commands-write.js
node --no-warnings scripts/test-backup-domain.js
node --no-warnings scripts/test-versions-domain.js
node --no-warnings scripts/test-goals-domain.js
node --no-warnings scripts/test-sources-domain.js
node --no-warnings scripts/test-insights.js
node --no-warnings scripts/test-prompt-packs.js
node --no-warnings scripts/test-plugin-package.js
node --no-warnings scripts/test-component-pipeline.js
node --no-warnings scripts/test-mcp.js        # 需服务在跑
node --no-warnings scripts/test-skills-install.js
```

当前合计：**19 个套件 / 229 项**，全部通过；清理测试残留后，审批 / 提示词覆盖 / 目标字段变更事件均为 0。

## 四、安全边界（按用户定调）

- 核心组件 `plan` / `outlib` 不可关闭、不可卸载、不可导出/安装覆盖。
- 非核心的 file 插件（含基础功能组件）可 `component.export → 修改 → validate → stage → install`；安装是 admin 命令，必须用户在审批页/CLI 批准，失败自动回滚旧文件。
- 提示词可改，但 `prompt.update / reset` 是 admin，必须用户批准；每次覆盖进 `prompt_pack_versions` 可回看/回滚。
- AI key、同步 token 永不进命令/设置白名单；SSE 与审计只走本机。
- 组件源码在服务进程内运行，所以安装必须审批，不能由 Agent 自行批准。

## 五、已知边界

- 基础 UI 层（`public/app.js` 里的路线图/教程页面）不是 file 插件，未提供在线代码补丁；这些功能的**提示词**可改，核心规划/资料库逻辑按用户策略保持不可改。
- 规划/教程/资料的长任务已可从命令启动并返回 `taskId`，进度在任务中心；命令本身不阻塞等待 AI 完成。
- 多端同步仍按原有 `SYNC_TABLES`；审批/审计/覆盖/暂存等本机表故意不同步。

## 六、相关文档

- [命令总线](command-bus.md)
- [应用 Manifest](app-manifest.md)
- [语义洞察](semantics.md)
- [自改与组件](self-modification.md)
- [CLI](cli.md)
- [MCP](mcp.md)
- [多形态打包](packaging.md)
