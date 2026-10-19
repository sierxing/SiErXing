# sierxing-dsh-bridge（思而行 × DSH）

> 让「思而行」作为 DSH 插件运行时，**不用在思而行里填 API Key**：
> DSH 当前可用的模型会直接出现在思而行「设置 → AI 接入方式」和对话模型下拉里，
> 调用走 DSH 自己的 `llm` 服务（和 DSH 里选的是同一批模型、同一套额度）。

## 它做了什么

```
思而行 UI / AI 对话
      │  OpenAI 兼容（/chat/completions、/models）
      ▼
本插件在 DSH webServer 上注册的本地网关  ──►  ctx.llm.stream()（DSH 模型服务）
      │
      └─ 启动时把 {url,key,models} 写进思而行 DATA_DIR/host-agent.json
         再 POST 思而行 /api/host-agent/refresh
```

- 只监听回环地址（DSH webServer 的 host 默认 127.0.0.1），路由必须带本插件随机生成的 Bearer token；
- 模型 id 统一为 `provider/model`（如 `deepseek-official/deepseek-v4-flash`），与 DSH 内部路由一致；
- 支持 `stream: true`（SSE）；单轮文本为主（把 system 合并成系统提示，其余消息合并成一条 user）；
- 插件卸载（dispose）时删除 `host-agent.json` 并让思而行撤掉自动连接，不留连不上的死条目。

## 安装（DSH 0.2.0-rc.2，已实测）

DSH 的 profile patch 支持 `insert` 追加条目，`name` 写**绝对路径**时会被转成 file URL 直接加载，
所以不必先装进 profile 的 node_modules。

**方式 A（推荐，不用 pnpm）**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在末尾追加：

```yaml
# 思而行 × DSH 桥
- insert:
    - name: /绝对路径/SiErXing/integrations/dsh-bridge/lib/index.js
      config:
        sierxingAppDir: /绝对路径/SiErXing
        sierxingUrl: http://127.0.0.1:3213   # 思而行在跑的地址
        autoStart: false                     # true = 思而行没跑时由 DSH 拉起（会弹一次浏览器）
```

web profile 的 `dsh-hmr` 会监听这个 patch 文件：**保存即热加载，不需要重启 DSH**
（没有 HMR 的 profile / headless 模式则需重启一次）。实测本机 0.2.0-rc.2 web profile
保存后 1 秒内生效，进程未重启。

**方式 B（包管理器安装）**：先装进 profile，再用裸包名插入：

```bash
dsh plugin --profile web add /绝对路径/SiErXing/integrations/dsh-bridge
```

```yaml
- insert:
    - name: sierxing-dsh-bridge
      config:
        sierxingAppDir: /绝对路径/SiErXing
        sierxingUrl: http://127.0.0.1:3213
```

**装完确认**：

```bash
# 1) DSH 侧网关（监听 127.0.0.1:<DSH 端口>/sierxing/v1）
curl -s http://127.0.0.1:3213/api/host-agent        # available 应为 true
# 2) 思而行 → 设置 → AI 接入方式：出现「DSH」连接，模型下拉里是 provider/model
# 3) 真调一次（会把请求转给 DSH 当前账号的模型）
curl -s http://127.0.0.1:3213/api/ai/test -X POST -H 'Content-Type: application/json' \
  -d '{"model":"host-agent::aliyun/deepseek-v4.1-flash-1017"}'
```

> 插件注册的路由只监听回环；`host-agent.json` 里的 token 是每次启动随机生成的（文件权限 600）。
> 卸载：删掉 patch 里的 `insert` 块 → HMR 热卸载（dispose 会删 `host-agent.json` 并让思而行撤连接）。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sierxingAppDir` | 当前工作目录（含 `server/server.js` 时） | 思而行仓库目录；用于找 `data-location.json` / `data/` |
| `sierxingUrl` | `http://127.0.0.1:3213` | 思而行服务地址（探活 + 调 refresh） |
| `mountPath` | `/sierxing/v1` | 网关挂载点，同时是思而行的 Base URL 路径 |
| `name` | `DSH` | 思而行里显示的连接名 |
| `token` | 随机 | 固定 token（不填则每次启动随机，写进 host-agent.json） |
| `dataDir` | 自动解析 | 强制指定思而行 DATA_DIR（测试/多实例时用） |
| `autoStart` | `false` | 思而行没在跑时是否自动拉起 |

## 边界

- 只暴露**文本对话**（含流式）。工具调用 / 图片输入 / 多轮回放暂不还原 ——
  思而行的 AI 助手本来就是「一段完整 prompt 要一段回答」，够用；
- 思而行侧必须能读到同一份 `DATA_DIR`（插件按 `sierxingAppDir` 解析，与 `server/data-dir.js` 同规则）；
- 网关只在本机回环、带 token；不要把 DSH webServer 开到公网（DSH 自己也不做 TLS/认证）；
- 想「任何 Agent 都能用」：这个插件是 DSH 适配器；其它宿主按同一份契约接
  （写 `DATA_DIR/host-agent.json` + 提供 OpenAI 兼容网关），详见
  [docs/agent-plugin/host-agent.md](../../docs/agent-plugin/host-agent.md)。

## 回归

```bash
node integrations/dsh-bridge/test/run.js        # 8 项：模型目录 / host-agent.json / 鉴权 / 非流式 / 流式 / 404 / dispose
```

不依赖 DSH 运行时（假 ctx + 假 llm + 真 http server），秒级、不花钱。
