# 创造模式（Create mode）

> 在 AI 助手里通过对话**定制思而行的界面**或**新增功能组件**；AI 只准备文件，安装由你点按钮确认，装完随时可撤销。
> 设计参照 DeepSeek Harness 的 Creator preset（agent preset `cordis`）：
> inspect（把扩展点说明书喂给模型）→ author（生成插件包）→ plugin_manager 安装（用户批准）→ 用装好的插件本身预览 → 回滚。

---

## 1. 三种创造物

| kind | 能做什么 | 装到哪 | 生效方式 |
| --- | --- | --- | --- |
| `ui-page` | 整页重做某个内置页面（首页/目标页/路线图/设置/资料库/教程…） | `DATA_DIR/ui-plugins/<id>/` | 刷新；失败自动回退内置页面 |
| `skin` | 只改外观（配色 / 圆角 / 字体 / 间距），整站生效 | `DATA_DIR/ui-plugins/<id>/skin.css` | 刷新；叠在内置样式之后 |
| `component` | 新增一个可开关的功能组件（自己的服务端接口 + 前端入口 + 样式） | `DATA_DIR/plugins/<id>.js` + `DATA_DIR/plugins-client/<id>.{js,css}` | 刷新；按「组件」页/目标页开关控制 |

**共同点：只写数据目录，绝不改程序文件（`server/` / `public/` / `ui/`）**，所以思而行升级时不会被覆盖，也不会跟官方更新打架。

挑哪一种：

- 只改颜色/圆角/字体/间距 → `skin`（最稳，不动结构）。
- 要重做某页布局/内容 → `ui-page`（整页接管，原版随时回退）。
- 要在目标页里加一个带自己数据/接口的新功能 → `component`（可在「组件」页开关）。

---

## 2. 用户怎么用

1. 在任意**有目标上下文**的页面打开 AI 助手（右下角 💬）。
2. 点工具栏最左边的模式按钮 → 选 **🎨 创造**。
3. 直接说想要什么。例：
   - 「把首页改成暖色卡片风，圆角大一点」（→ skin 或 ui-page）
   - 「重做设置页，把 AI 接入放最上面」（→ ui-page）
   - 「在目标页加一个「专注计时」组件，能开始/暂停」（→ component）
   - 「这个页面太挤了，帮我重新排一下」（会结合"用户当前正在看的页面"）
4. AI 先回一段说明，并生成一张 **🎨 已生成** 卡片（列出产物类型、id、文件）。**此时还没有安装。**
5. 卡片上可以：
   - **安装并查看**：落盘 + 自动启用，然后点「刷新查看」在真实界面里看效果（用装好的插件本身当预览）。
   - **查看代码**：先读生成的文件再决定。
   - **放弃**：删掉暂存，什么都没发生。
6. 不满意就再聊一句让它改（同一 id 会覆盖上一版）；也可以点 **撤销安装** 回到安装前（有旧版本就恢复旧版本，没有就删掉）。

> 页面/皮肤装好后，以后想临时关掉：进 **#/ui-plugins（界面管理）** 停用即可，不用删文件。

---

## 3. 安全边界（为什么可以放心点安装）

| 约束 | 实现 |
| --- | --- |
| 只能改扩展点，不能改内核 | 页面 id 白名单（`server/create-mode.js` 的 `PAGES`）；不能占用内置组件 id；产物只进 `DATA_DIR` |
| 零依赖 / 不联网 / 不碰宿主 | 静态扫描：禁止 `require` 第三方包、`import` 外部模块、`fetch('http…')`、`WebSocket`、`XMLHttpRequest`、`child_process`、`eval` / `new Function`；CSS 禁止外部 `@import`/`url()` |
| 语法先过一遍 | 服务端把生成代码写临时文件跑 `node --check`（ESM 用 `.mjs`），不通过直接拒收 |
| 体积限制 | 单文件 ≤200KB（组件前端 300KB）、总 ≤800KB、文件数 ≤8 |
| 安装要用户批准 | 生成只做「校验 + 暂存」；`POST /api/create/changes/:id/install` 必须带 `confirm:true`；UI 上就是卡片按钮 |
| 失败可回滚 | 安装前把旧版本快照到 `DATA_DIR/agent-changes/<changeId>/backup/`；装失败自动恢复；成功后也能「撤销安装」 |
| 不静默破坏 | 校验错误/越界都会写回对话（用户看得到「为什么没装成」） |

> 功能组件的服务端 JS 仍然是在本进程里运行的 Node 代码（和普通组件一致）。所以它必须由用户点安装；不要给不可信来源的包点安装。

---

## 4. 实现结构

| 文件 | 作用 |
| --- | --- |
| `server/create-mode.js` | 解析 create 块 → 校验 → 暂存 → 安装/回滚/放弃；生成「扩展点说明书」提示词（页面表 / 三种契约 / CSS 变量 / 已装用户插件 / 红线 / 输出协议） |
| `server/server.js` | 对话模式 `mode:'create'`（`buildChatPrompt` → `buildCreateChatPrompt`；`streamChat` 解析 + 暂存 + SSE 下发 `create`）；`/api/create/*` 路由；用户组件目录加载 + `serveStatic` 兜底 |
| `public/app.js` | `AI_MODES` 里的「创造」；输入框提示；SSE 收尾把 create 存进消息（并随 trace 落库，刷新后卡片还在）；卡片渲染 + 安装/代码/放弃/刷新/撤销动作 |
| `public/style.css` | `.chCreate*` 卡片样式 |
| `scripts/test-create-mode.js` | 17 项：纯函数（围栏/校验/红线/语法）+ HTTP e2e（三种产物 暂存→安装→回滚/放弃、确认安装、内置 id 保护） |
| `scripts/test-create-ui.js` | 20 项：假 AI 驱动的前端闭环（切模式 → 提示词 → 生成卡片 → 不会自动安装 → 看代码 → 安装 → 撤销 → 无 JS 异常） |

### 4.1 输出协议（模型侧）

AI 在正文之后输出**恰好一个** create 围栏块（三个反引号 + `create`），内容是 JSON：

```json
{"kind":"ui-page","page":"home","id":"weekly-review","name":"每周复盘","summary":"…","files":{"index.js":"…"}}
{"kind":"skin","id":"warm-skin","name":"暖色","summary":"…","files":{"skin.css":"…"}}
{"kind":"component","id":"focus-timer","name":"专注计时","summary":"…","icon":"⏱","category":"其它","files":{"server.js":"…","client.js":"…","style.css":"…"}}
```

服务端会补/覆盖 `manifest.json` 里必须正确的字段（id / name / page / apiVersion），并生成 `manifest.json`。

### 4.2 页面插件契约（ui-page）

三种入口任选：

1. **ESM Vue 组件**（推荐）：`export default { setup() { const { h, ref } = window.SiErXingUI.vue; return () => h('div', { class: 'page' }, …); } }`；
   Vue 必须从 `window.SiErXingUI.vue` 取（宿主桥按需加载）。
2. **ESM mount**：`export function mount(root, ctx) { root.innerHTML = '…'; return { unmount() {} }; }`；
   `ctx` 有 `api / toast / esc / go / state / fmtDate / mdToHTML / safeParse / host / vue`。
3. **经典脚本**：`window.SXUIPlugin['<page>'] = { … }`。

CSS 建议写在入口里注入 `<style id="sxc-<id>">`（unmount 时一起删），或用 `style.css`（会随插件自动挂载）。

### 4.3 功能组件契约（component）

和普通组件一致（见 AGENTS.md §3.1/3.2）：

- `server.js`：`module.exports = { id, name, icon, desc, category, client: '/plugins/<id>.js', defaultEnabled, init(ctx), api: [{method, path|pattern, handler}] }`。
- `client.js`：`SiErXing.registerPlugin({ id, goalEntry, routes, mount, unmount })`（经典脚本）。
- 前端脚本逻辑路径仍是 `/plugins/<id>.js`，服务端会从 `DATA_DIR/plugins-client/` 兜底返回。

### 4.4 CSS 变量（skin 优先用）

创造模式提示词会从 `public/style.css` 扫出当前可用的主题 token（`--bg / --card / --text / --muted / --border / --soft …`）给模型；优先覆盖这些变量，深浅色会自动适配。

---

## 5. 开发 & 调试

### 5.1 HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/create/meta` | 页面表 + 限额 + 暂存目录 |
| GET | `/api/create/changes/:id` | 读回暂存内容（含文件代码） |
| POST | `/api/create/changes/:id/install` | 安装，body 必须 `{confirm:true}` |
| POST | `/api/create/changes/:id/discard` | 放弃 |
| POST | `/api/create/changes/:id/rollback` | 撤销安装/恢复旧版本 |
| POST | `/api/create/stage` | **仅测试/调试**：`SIERXING_CREATE_DEBUG=1` 时开放，直接把一份 create JSON 走同一套校验 + 暂存（自动化测试用） |

### 5.2 模块 API（server/create-mode.js）

导出 `createCreateMode(deps)`、`parseCreateOutput(text)`、`validateArtifact(artifact)`、`PAGES`、`CREATE_API`、`LIMITS`。

`createCreateMode` 的 `deps`：`db / dataDir / uiDir / uiPlugins / styleCssPath / installComponent / uninstallComponent / exportComponent / validateComponent / reloadPlugins / log`。

### 5.3 回归

```bash
npm run test:create          # 17 项纯函数+HTTP e2e（不花钱）+ 20 项前端闭环（假 AI）
# 或分开：
node --no-warnings scripts/test-create-mode.js
node --no-warnings scripts/test-create-ui.js
```

前端联动改动后至少再跑：`npm run test:mount`、`npm run test:parity`、`node scripts/test-user-vue-page.js`。

---

## 6. 已知边界（有意为之）

- **第一版就要能装**：提示词要求 AI 给最小可用的一版，别一次生成一整套；安装后用它本身当预览（不预装 mock）。
- **卡片随会话落库**：create 信息放在 `chats.trace` 的步骤里（`kind:'create'`），刷新/重开对话后卡片还在；暂存目录在服务重启后仍可安装。
- **同 id 覆盖**：用户自己的页面插件/组件允许用同 id 迭代；内置（core/base 及程序目录自带组件）不允许覆盖。
- **卡片动作不经过审批命令总线**：这是普通用户的显式点击，不是 Agent 自动执行的写操作；命令总线的 `component.*` 仍服务 Agent/MCP 场景。
- **功能组件前端需要刷新**：组件脚本按需加载，装好后点「刷新查看」才会加载新前端；页面/皮肤同理。
- **升级安全**：用户页面插件、皮肤、功能组件全部在 `DATA_DIR`；升级只替换程序目录，不会动它们。旧版本装在程序目录的组件会在用户目录版本存在时被同名覆盖（核心/基础组件除外）。
- **暂存清理**：`DATA_DIR/agent-changes/` 里的失败/放弃记录不会自动 GC（文件都很小）；需要时可手动删。
