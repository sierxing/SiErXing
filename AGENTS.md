# AGENTS.md — 给 AI 助手的工程手册

> 面向**要读代码、改代码、扩功能**的 AI 助手（以及开发者）。
> 面向**使用者**的文档在 [`README.md`](README.md)。
> 本文件是「改这个项目之前必须知道的事」的集合，尽量只写**机器用得上、且靠猜会猜错**的内容。

---

## 0. 一句话画像

| 项 | 值 |
| --- | --- |
| 产品 / 目录名 | 思而行 / `SiErXing` |
| 形态 | 本地单进程 Web 应用，`localhost:3213` |
| 后端 | Node 内置 `http` + `node:sqlite`，**零第三方依赖** |
| 前端 | 原生 JS（无框架、**无构建步骤**），改完刷新即生效 |
| Node 要求 | ≥ 22.5（旧版需 `--experimental-sqlite`），推荐 24 LTS |
| 端口 | 3211 / 3212 / 3213，历史遗留，**不要改** |
| 协议 | MIT（见 `LICENSE`） |

**代码量**（改动前先有个规模概念）：`public/app.js` ≈ 6600 行、`server/server.js` ≈ 4600 行、`server/ai.js` ≈ 540 行、`public/sdk.js` ≈ 110 行。核心逻辑**高度集中在两个大文件**里，没有按模块拆分。

---

## 1. 目录结构

```
SiErXing/
├── server/
│   ├── server.js      ★ HTTP 路由 + SQLite + 核心规划逻辑（最大的文件）
│   ├── ai.js          AI 接入层：OpenAI 兼容接口 / opencode CLI / 视觉模型
│   ├── service.js     桌面图标 / 终端命令 / 开机自启（跨平台）
│   ├── sync.js        多端同步：Git 仓库快照 + 需要同步的表清单 SYNC_TABLES
│   ├── update.js      更新检查与一键更新
│   ├── tasks.js       后台长任务
│   ├── code-read.js   ★ 教程讲源码时的只读代码访问 + 密钥脱敏
│   └── plugins/       ★ 服务端组件（自动加载）
│       ├── index.js         加载器 + 接口约定（改组件先读这个）
│       ├── lib/             组件内部共享库（如 ebook-parse.js 零依赖电子书解析）
│       ├── jdfile.js        信息源导入（图片识别 + 电子书解析入库）
│       ├── quiz.js          随堂测验（大纲/题目/报告）
│       ├── workspace.js     代码工作区（建目录 + VSCode 打开 + 打包 zip）
│       ├── notes.js / tutbookmark.js / studystats.js / hot100.js
│       ├── pomodoro.js / aiprompts.js
│       └── theme-carbon.js / theme-paper.js   （只声明元数据，样式在前端）
├── public/
│   ├── index.html     页面骨架（body 里只有 3 个元素：nav#rail / main#app / div#toast + 2 个 script）
│   ├── app.js         ★ 前端核心（原生 JS，含导图、对话、Markdown、收藏栏）
│   ├── sdk.js         ★ 前端组件 SDK，109 行，改组件必读
│   ├── style.css      设计系统 + 深色模式 + 组件样式（~1800 行）
│   └── plugins/       ★ 前端组件（js + 可选 css），按需动态加载
├── scripts/           install.sh/.bat/.ps1、start.sh/.bat（不在根目录堆着）
├── examples/          示例组件包，可在「组件」页导入体验
├── docs/screenshots/  README 用截图
├── data/              ★ 运行时生成（数据库/备份/上传），已 gitignore
└── package.json       没有 dependencies，scripts 只有 start / start:sqlite / start:port
```

---

## 2. 启动与自测（改完必做）

```bash
node server/server.js                 # 启动，默认 3213
PORT=3214 node server/server.js       # 换端口
node --check public/app.js            # 前端语法
node --check server/server.js         # 后端语法
```

**⚠️ 重启服务前必须确认端口真正释放。** 曾多次出现「kill 没生效、旧进程还占着 3213、新实例因端口占用静默退出」，导致后续所有请求都是假 404，排查方向完全跑偏。标准流程：

```bash
PID=$(ss -ltnp 2>/dev/null | grep ':3213' | grep -oP 'pid=\K[0-9]+' | head -1)
kill -9 $PID; sleep 3
ss -ltn | grep -q ':3213' && echo STILL_HELD || echo 端口已释放   # 必须确认这一句
setsid nohup node --no-warnings --experimental-sqlite server/server.js > /tmp/sierxing.log 2>&1 < /dev/null &
sleep 6
curl -s http://localhost:3213/api/health          # {"ok":true}
curl -s http://localhost:3213/api/plugins | head  # 组件是否都加载上了
```

---

## 3. 组件（插件）系统

这是本项目最主要的扩展方式。**一个组件 = 服务端 js + 前端 js + 可选 css**，放进对应目录即自动加载，改完刷新生效。

### 3.1 服务端：`server/plugins/xxx.js`

```js
module.exports = {
  id: 'myplugin',          // 唯一；也是目标级开关的 key
  name: '我的功能',
  icon: '✨',
  desc: '一句话说明',
  category: '扩展组件',
  order: 50,               // 排序
  goalToggle: true,        // 是否允许「按目标开关」
  defaultEnabled: false,   // 新建目标时默认是否勾选
  client: '/plugins/myplugin.js',   // 提供才有界面入口

  init(ctx) {},            // 启动时调一次：建表
  onGoalDelete(goalId, ctx) {},
  exportData(ctx) {},
  importData(data, ctx) {},
  api: [
    { method: 'GET',  path: '/api/foo',              handler: async (req, res, u, ctx) => {} },
    { method: 'POST', pattern: /^\/api\/bar\/(\d+)$/, handler: async (req, res, u, ctx) => {} },
  ],
};
```

`ctx` 提供：`db / nowISO / safeParse / sendJSON / readBody / getSetting / setSetting / backup / log`、`fs / path / os / spawn / APP_DIR / DATA_DIR / UPLOAD_DIR / PUBLIC_DIR`、`getGoal / sourcesOf / aiText / aiTextFiles / currentModel / currentVisionModel`。

### 3.2 前端：`public/plugins/xxx.js`

```js
SiErXing.registerPlugin({
  id: 'myplugin',
  goalEntry: {                    // 进目标页顶栏标签栏的入口
    label: '我的功能', icon: '✨', order: 30,
    header: true,                 // false = 不进顶栏（默认 true）
    hash: gid => '#/g/' + gid + '/myplugin',
    show: goal => SiErXing.pluginEnabled(goal, 'myplugin'),
  },
  routes: [{ match: h => h.startsWith('#/g/') && h.endsWith('/myplugin'), render: () => {} }],
  mount(root, host) {},            // 需要常驻浮窗时用
  unmount() {},
});
```

SDK（`public/sdk.js`，全部接口就这些）：`registerPlugin / getPlugins / findPlugin / pluginEnabled / goalEntries / matchRoute / setServerPlugins / serverPlugins / provide / host`。

### 3.3 样式组件
`public/plugins/xxx.css` 里覆盖 CSS 变量即可换肤，服务端 js 只声明元数据（`kind: 'theme'`）。

---

## 4. 组件开关「按目标隔离」——最容易搞错的地方

判定链路是**三层**，三层必须一致，否则会出现「界面关了但接口还能调」：

```
前端显示：  public/app.js  goalCompOn(goal, id)
              → goals.plugins[id]  ??  全局 enabled[id]  ??  meta.defaultEnabled
接口门控：  server/server.js  goalCompOn(gid, id)  → 不满足直接 403
组件入口：  public/sdk.js     SiErXing.pluginEnabled(goal, id)  （同样三段回退）
```

- **写入**分两种，别混：
  - 全局：`POST /api/components/:id/toggle`
  - 按目标：`POST /api/goals/:id/plugins` `{plugin_id, enabled}` → 只写 `goals.plugins`，**不会碰别的目标**
- `scope: 'core'` 的组件**不可关闭**、也不可按目标开关。
- `scope: 'theme'` 与应用级组件（番茄钟浮窗等）**天然全局**，不做目标隔离。

**界面陷阱**：组件管理页选中某个目标时，下面那一大堆分类卡片里的开关**仍然是全局开关**。所以已把它们整体折叠进 `details.cmpGlobalFold` 并标注「影响所有目标」。**新增任何按目标生效的开关时，务必确认它在目标范围区块内、且用的是 `data-gcmp` 而不是 `data-cmp`。**

---

## 5. 前端顶栏「收藏栏」

教程页与路线图页各有一条**共用同一套实现**的标签栏（钉选 / 收藏夹 / 横向拖拽排序 / ⋯ 收纳 / 自定义编辑器）。

- 实现在 `public/app.js`，按命名空间隔离：教程 `ns='tut'`、路线图 `ns='goal'`，各自存 `localStorage` 键 `sierxing-tutbar-v5` / `sierxing-goalbar-v1`。
- 入口：`applyBarOverflow(ns)`，由 `renderTutorialPage` / `renderGoal` 在渲染末尾调用。
- 组件的功能按钮通过给按钮加 `data-tbtn` 属性即可自动进入标签栏；`pluginButtonsHTML(g)` 负责渲染组件入口。

改这块之前请读第 7 节的坑。

---

## 6. 数据表

`goals / nodes / plan_drafts / goal_versions / tutorials / sources / source_digests / chats / chat_sessions / settings`，以及各组件自建表（`quiz_*` 等，已加入 `sync.js` 的 `SYNC_TABLES`）。

- 建表语句在 `server/server.js`，用 `db.exec` 幂等执行；新表记得加进 `server/sync.js` 的 `SYNC_TABLES`，否则多端同步会漏。
- `goals.plugins` 是 JSON 文本，存**目标级**组件开关；列缺失时有 `ALTER TABLE` 兜底。
- DB journal = `DELETE`，`busy_timeout 5000`。

---

## 7. 踩过的坑（改代码前务必知道）

这些是**已经修好、但非常容易再犯**的坑。重写相关代码时请对照检查。

1. **静态资源缓存**：`serveStatic` 只发 `no-cache`，浏览器可能继续用旧文件。入口 HTML 会注入 `ASSET_V`（对 `public/**` 求 sha256），`app.js?v=…`；组件脚本/样式动态加载时也要带 `assetUrl()` 追加版本戳。
   > ⚠️ `ASSET_V` **必须定义在 `PUBLIC_DIR` 之后**。曾经写在前面撞 TDZ，`catch` 静默吞掉，导致**每次构建的哈希都是空输入的 sha256（`e3b0c44298fc`）**，版本戳形同虚设、浏览器一直吃缓存。现在哈希异常会打警告并回退到时间戳。

2. **`.moreMenu` 的「点别处关闭」必须豁免所有点开式按钮**：漏掉一个就会导致「菜单闪一下就没了」。豁免选择器是 `[data-morebtn]` 与 `[data-morebtn-of]`。

3. **`querySelectorAll` 匹配不到元素自己**。清理 `dropOn` / `dragging` 这类加在容器自身的类时，必须单独 `container.classList.remove(...)`。

4. **`dragleave` 要看 `relatedTarget`，不是 `e.target`**。用 `e.target === container` 判断「是否拖出了容器」永远为假（从子元素上拖出去时 target 是那个子元素）。

5. **`dragend` 可能永远不来**：拖拽源在拖动途中被重绘替换掉后，`dragend` 不再冒泡到容器，状态会永久卡住（虚线框不消失）。收尾要有多层兜底：`document` 级 `dragend`/`drop`、`Escape`、`window blur`、以及任意 `pointerdown`。

6. **事件监听不要在每次重绘里重复绑定**。`bindBarDnD` 曾每次渲染都绑一遍，旧闭包持有过期 `st`，会把用户数据覆盖掉。现在用 `dataset.barBound` 保证只绑一次，且**事件发生时才重新读状态**。

7. **收藏栏里的隐藏按钮绝不能从 DOM 消失**。收进 ⋯ 或归入文件夹的按钮只是 `display:none`，必须留在栏内 —— 否则 ⋯ 菜单点它时 `getElementById` 返回 null，表现为「点了没反应」。

8. **`hidden` 元素的 `getBoundingClientRect()` 全为 0**。用它定位右键菜单会跑到页面左上角 `(8,6)`；要么判零宽高，要么直接用鼠标坐标。

9. **不要用 `node --check` 当作充分验证**。它只查语法，查不出 `ReferenceError`（删多行时把被调用的定义一起删掉，语法完全合法、运行时才炸）。改完前端至少**用无头浏览器真启动一次 SPA**：

   ```bash
   timeout 90 microsoft-edge --headless=new --disable-gpu --no-sandbox \
     --window-size=1600,1000 --virtual-time-budget=7000 \
     --dump-dom 'http://localhost:3213/#/g/53' 2>/dev/null | grep -c '页面出错'
   ```
   逐个路由跑一遍（`/`、`#/g/<id>`、`#/components`、`#/library`、`#/studystats`）。

10. **在函数中间插入代码要读回上下文**。曾两次在函数中部插入内容引发 TDZ / 结构错误而 `node --check` 没发现。

---

## 8. 零依赖纪律

**不要引入任何 npm 依赖。** 这是产品的核心卖点（`git clone` 完直接 `node server/server.js` 就能跑）。

需要什么就自己实现：Markdown 渲染（`app.js` 的 `mdToHTML`）、电子书解析（`server/plugins/lib/ebook-parse.js`，支持 txt GBK / pdf 含 ObjStm+ToUnicode / epub spine / mobi PalmDoc）、测试用的 DOM 桩（直接用无头浏览器）。

---

## 9. 前端资源访问约定

**只有两个前端文件**：`app.js`（核心）与 `sdk.js`（组件 SDK）。没有打包器、没有模块系统。

- 组件脚本通过动态 `<script>` 加载，**必须用 `assetUrl()` 追加版本戳**。
- 全局事件用 `document.addEventListener` 委托；`.moreMenu` 的关闭、`[data-cmd]` 命令分发都是这种模式。
- Markdown / 代码块渲染走 `mdToHTML`；AI 返回的代码**必须用围栏包裹**（提示词里有这条铁律）。

---

## 10. 修改后的自检清单

```bash
node --check public/app.js && node --check server/server.js     # 语法
# 重启（务必确认端口释放）→ curl /api/health → curl /api/plugins
# 无头浏览器逐路由启动，确认无「页面出错」
# 组件改动：目标内开/关，确认其它目标不受影响
```

- 改了组件的开关粒度 → **必须**同时改前端显示、后端 403 门控、组件入口三处。
- 加了新表 → 加进 `server/sync.js` 的 `SYNC_TABLES`。
- 动了 `public/` 或 `public/plugins/` → 版本戳会变，用户普通刷新即可拿到新文件。

---

## 11. 许可

MIT。**不要修改 `LICENSE`**。分发时必须保留 `sierxing` 的署名。
