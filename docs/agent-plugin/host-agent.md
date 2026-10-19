# 宿主 Agent 自动接入（思而行作为 Agent 插件）

> 场景：思而行作为某个 Agent（DSH / Claude Code / Cursor …）的插件被打开时，
> **「当前 Agent」应自动出现在设置 → AI 接入方式里，它的模型列表直接在对话下拉里可选**。
> 相关实现：`server/ai.js` 的 `hostAgentConfig() / mountHostAgent() / hostAgentStatus()`，
> 回归 `node scripts/test-host-agent.js`。

## 1. 它是怎么工作的

宿主插件做两件事：

1. 把「当前 Agent 的地址 + 可用模型」写成一个 JSON 文件：
   `DATA_DIR/host-agent.json`（推荐，`DATA_DIR` 见 `server/data-dir.js` 的数据目录指针）；
2. 调用一次 `POST /api/host-agent/refresh`（服务已在跑时）；若是宿主**启动**思而行，
   首启时读取该文件即可，不必调刷新。

思而行收到后把它登记成一条**普通 AI 连接**：

- 服务商列表多一项「当前宿主 Agent」（`providerId: "host"`）；
- 连接 id 固定为 `host-agent`，重复刷新只更新、不重复添加；
- 模型进 `ai.modelPool()`，对话栏和设置页直接出现；
- **默认只勾选第一个模型**：宿主一次可能给几百个，全部自动选上会把对话栏塞爆、也不好挑；
  其余的在设置页用「搜索模型 + 全选」按需勾；
- 之后每次刷新/重启**保留用户已挑过的模型**（只保留还在宿主列表里的那些，新模型不自动勾上）；
  挑过的模型全被宿主换掉时退回第一个，保证对话栏不会空；
- 用户在设置里手动关掉这条连接，刷新**不会**强行打开；
- 配置文件被删 / 宿主插件卸载后（再调一次 refresh 或重启），自动创建的 `host` 服务商与
  `host-agent` 连接会被撤掉，不留连不上的死条目（只清理自动创建项，不碰用户自己的连接）。

## 2. 注入格式

`DATA_DIR/host-agent.json`：

```json
{
  "name": "DSH",
  "url": "http://127.0.0.1:8091/v1",
  "key": "可留空",
  "models": ["deepseek-v4.1-flash-1017", "deepseek-v4-pro"],
  "vision": "deepseek-v4-pro"
}
```

也可以用环境变量（适合宿主直接拉起思而行进程）：

| 环境变量 | 说明 |
| --- | --- |
| `SIERXING_HOST_AGENT_CONFIG` | 指向一个 JSON 文件（优先于 `DATA_DIR/host-agent.json`） |
| `SIERXING_HOST_AGENT_NAME` | 显示名，默认「当前宿主 Agent」 |
| `SIERXING_HOST_AGENT_URL` | OpenAI 兼容 Base URL（必填，自动去掉结尾 `/`） |
| `SIERXING_HOST_AGENT_KEY` | 可选密钥 |
| `SIERXING_HOST_MODELS` | 模型列表：JSON 数组，或逗号/换行分隔（必填） |
| `SIERXING_HOST_AGENT_VISION` | 可选：识图模型名 |

`url` 或 `models` 缺一个 = 视为「宿主没接」，什么都不注册。

## 2.1 现成适配器：DSH

本仓库 `integrations/dsh-bridge/` 是 DSH 侧的参考实现（DSH 0.2.0-rc.2）：

- 注入 `ctx.llm` + `ctx.webServer`，在 DSH 本机 webServer 上注册
  `/sierxing/v1/models` 与 `/sierxing/v1/chat/completions`（带随机 Bearer token，仅回环）；
- 模型调用直接走 `ctx.llm.stream()`，所以**思而行用的就是 DSH 当前可用、当前账号连接的模型**；
- 启动时写 `DATA_DIR/host-agent.json` 并调 refresh；dispose 时删文件并让思而行撤连接。

安装步骤见 [integrations/dsh-bridge/README.md](../../integrations/dsh-bridge/README.md)。
其它宿主按同一份契约接即可；没有「可被调用的模型通道」的宿主（如只支持 MCP 的客户端）
只能做到列出模型，或后续走 MCP sampling 桥。

## 3. 为什么必须是 OpenAI 兼容接口

MCP 是 **宿主 → 思而行** 单向的：宿主能调思而行，思而行不能反过来调宿主的模型。
所以「思而行用宿主模型对话」只有一条干净的路 —— **宿主提供一个 OpenAI 兼容网关**：

```
GET  {url}/models
POST {url}/chat/completions     （支持 stream:true 更好）
```

宿主插件可以直接把它的 model service 包一层本地 HTTP 服务（只监听 127.0.0.1），
再写上面的 JSON 文件。这样不需要在思而行里复制密钥，也不会把宿主能力写死。

> 只登记模型列表、但 `url` 不可调用时，对话会报连接错误 —— 这是预期行为，
> 不要用假地址「先让它显示出来」。

## 4. 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/host-agent` | 状态：`{available, configured, id, name, baseUrl, models, enabled, file}` |
| POST | `/api/host-agent/refresh` | 重新读配置并登记；返回 `{mounted, id, name, baseUrl, models, enabled, file}` |

## 5. 验收

```bash
node --no-warnings scripts/test-host-agent.js          # 7 项纯本地
# 沙箱 e2e（临时目录 + NO_OPEN，不碰真实数据）：
TMP=$(mktemp -d); printf '%s' '{"name":"DSH","url":"http://127.0.0.1:8091/v1","models":["m1"]}' > "$TMP/host-agent.json"
NO_OPEN=1 PORT=3347 SIERXING_DATA_DIR="$TMP" node server/server.js &
curl -s http://127.0.0.1:3347/api/host-agent
```

## 6. 边界与下一步

- 本功能只解决「**自动出现在设置里 + 模型可选**」，不等于宿主能力全部开放。
- 用户定的方向：**不让主 Agent 直接改思而行源码**；要改界面/功能组件，走
  思而行内部的 AI 助手（创造模式：生成 → 用户点安装 → 可撤销），主 Agent 只负责
  规划核心与数据。详见 [mcp.md](mcp.md) 与 `docs/creation-mode.md`。
- 下一步（未做）：把 AI 助手的能力开放成 MCP 命令，让主 Agent 也能用同一套 ——
  `chat.ask` / `chat.agent` / `chat.create`（只暂存、安装仍要用户审批）、
  `create.list` / `create.install`（admin）/ `create.discard`。
