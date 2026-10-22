# 多形态：独立应用 / CLI / MCP / 技能共享同一底座

思而行不是「一个网页 + 几个外挂脚本」，而是同一套能力的多个入口：

| 形态 | 入口 | 传输 | 用途 |
| --- | --- | --- | --- |
| 独立 Web 应用 | server/server.js | HTTP | 用户自己用：规划、教程、资料库、组件 |
| CLI | scripts/sierxing.js | HTTP | 本机脚本 / 终端 / 自动化 |
| MCP 适配器 | scripts/sierxing-mcp.js | stdio JSON-RPC | Claude / Cursor 等 Agent 宿主 |
| Agent 技能 | docs/agent-plugin/skills | filesystem | 教 Agent 什么时候用哪条命令 |

四个形态共用：

- 同一套命令总线（59 个命令，risk 分级 + 审批 + 审计）
- 同一份自描述 manifest（schema: sierxing.plugin/1）
- 同一套数据与语义洞察（insight.list / brief.*）
- 同一套提示词包（10 个可编辑包）

## 一、一份 manifest

- HTTP：GET /api/manifest（等价于 GET /api/commands/manifest 的增强版）
- CLI：node scripts/sierxing.js manifest --json
- MCP：工具 sierxing_manifest

manifest 里包含：

- schema / id / app（名称、版本）
- commands（每个命令的 name/title/risk/category/layer/inputSchema）
- layers / concepts（分层与核心概念）
- capabilities（命令数、风险计数、审批/审计/事件、提示词包数、可编辑层）
- prompts（提示词包清单）
- components（组件清单）
- surfaces（四个入口及传输方式）

## 二、构建 Agent 插件包

~~~bash
node scripts/build-plugin.js
# 或
npm run build:plugin
~~~

默认输出 dist/sierxing-agent-plugin/：

~~~text
manifest.json
mcp/sierxing-mcp.js
skills/goal-coach/SKILL.md
skills/fix-friction/SKILL.md
mcp.json
README.md
package.json
~~~

说明：

- 只打「适配层」，不打整个 Web 应用；插件通过 HTTP 连到正在运行的思而行。
- mcp.json 里的 args[0] 是构建时的绝对路径；插件目录移动后改一下即可。
- skills 从仓库 docs/agent-plugin/skills 复制，保持同一份内容。
- 可选参数：--out <dir>、--url <url>、--manifest <file>（离线构建/测试用）。

## 三、安装

1. 先启动思而行：node server/server.js（或 systemd 服务）。
2. 把 mcp.json 的 mcpServers 合并进宿主配置。
3. 可选：把 skills/goal-coach、skills/fix-friction 复制到宿主技能目录。
4. 开局让 Agent 调 sierxing_manifest / brief_user。

## 四、安全

- read 直接执行；write 执行并写审计；admin/destructive 必须用户在审批页确认。
- 审批令牌一次性、绑定命令与入参哈希、30 分钟过期。
- Agent 不能自己批准；组件代码在应用进程内运行，安装前必须看预览。
- 插件包不含 AI key / sync token；这些只存在本机 settings。

## 五、验证

- node --no-warnings scripts/test-plugin-package.js（7 项：目录/manifest/MCP 复制/技能/mcp.json/README/版本/错误 schema）
- node --no-warnings scripts/test-mcp.js（真实服务上的 MCP 协议回归）
- node --no-warnings scripts/test-skills-install.js（多宿主技能安装）
- node scripts/build-plugin.js --out /tmp/sx-plugin-live 后实际检查 manifest 51 命令 / 10 提示词 / 2 技能。
