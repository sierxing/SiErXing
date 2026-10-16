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
│   ├── code-store.js  ★ 导入代码库的完整快照存取 + 对话检索挑选（供 AI 助手查代码）
│   ├── rag.js         ★ 检索增强：资料切片 / 向量 / 混合检索（规划与对话按问题取片段）
│   ├── explain-chunk.js 看懂代码的纯文本部分（切段 + 解析模型输出 + 语言判断，有 scripts/test-explain.js）
│   └── plugins/       ★ 服务端组件（自动加载）
│       ├── index.js         加载器 + 接口约定（改组件先读这个）
│       ├── lib/             组件内部共享库（如 ebook-parse.js 零依赖电子书解析）
│       ├── jdfile.js        信息源导入（图片识别 + 电子书解析入库）
│       ├── quiz.js          随堂测验（大纲/题目/报告）
│       ├── restate.js       用自己的话（一问一答内化）
│       ├── explain.js       看懂代码（贴一段代码 → 逐行讲解；左边代码、右边按行归档的讲解与追问）
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
├── scripts/           install.sh/.bat/.ps1、start.sh/.bat、build-exe.js（打包 Windows exe）
├── release/           ★ 在线更新的发布件：latest.json + payload-<版本>.sxar（要提交）
├── examples/          示例组件包，可在「组件」页导入体验
├── docs/              开发期文档（如有）
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

### ⚠️ 起测试实例 / 无头浏览器时的两条铁律

**① 测试实例必须 `NO_OPEN=1`。** `server.listen` 回调里会 `xdg-open` 打开浏览器（`NO_OPEN` 是**唯一**的开关，见 `server/server.js` 末尾）。AI 会话反复起测试实例时，每起一次就在用户桌面上弹一个真窗口；更糟的是那个窗口里的操作会写进沙箱库，把"实验数据"和"真实数据"混在一起排查不清（真实翻过）。

```bash
NO_OPEN=1 PORT=3313 setsid nohup node --no-warnings --experimental-sqlite server/server.js > /tmp/t.log 2>&1 < /dev/null &
```

**② 无头浏览器必须"能被收尸"，否则会拖垮整台机器。** 最常见的写法是致命组合：

```js
spawn('microsoft-edge', ['--headless=new', '--disable-gpu', ...], { stdio: 'ignore' });
... 跑完
process.exit(0);            // ← 浏览器还活着，而且已经"没了爹"
```

进程一退，浏览器就被 systemd 收养、**永远活着**；而 `--headless=new --disable-gpu` 会留一个 `--type=gpu-process` **空转 ~86% CPU**。实测一天攒下 **21 个实例 / 80 个进程 / 903% CPU（≈9 个核）/ 13GB 内存**，`load average` 冲到 24，整台机器卡死。用户只会看到"电脑突然好卡"，根本联想不到是几天前的测试。

三条做法任选其一（推荐全上）：

```bash
# ① 用 timeout 包住浏览器本身：不管脚本怎么退出，它到点自杀
spawn('timeout', ['180', 'microsoft-edge', '--headless=new', ...]);
```
```js
// ② 留住句柄，退出前收尸（finally 一定要有）
const ed = spawn('microsoft-edge', [...], { stdio: 'ignore' });
try { /* …CDP 交互… */ } finally { try { ed.kill('SIGKILL'); } catch (e) {} }
```
```bash
# ③ 兜底：随手清一遍（默认只清"父进程已死"的孤儿，不会打断正在跑的测试）
bash scripts/kill-test-browsers.sh          # --dry 只看 / --all 连在跑的一起清 / --servers 顺带停沙箱服务
```

另外：每次测试一个新 `--user-data-dir=/tmp/…/cdp-<pid>` 会**攒 profile 目录**（实测一个沙箱目录 2.4GB、29 个 profile），收尾要连目录一起删。

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

**教程页里的组件入口**不是自动的：要在 `renderTutorialPage` 的工具条里手加一个 `<button class="btn small" data-tbtn id="tutXxxBtn">`（用 `goalCompOn(goal, 'xxx')` 门控），再在下面绑一个 `location.hash = '#/t/' + tid + '/xxx'`。教程内页路由写 `#/t/(\d+)/xxx`（见 quiz / restate / explain）。

### 3.3 样式组件（主题皮肤）
`public/plugins/xxx.css` 里覆盖 CSS 变量即可换肤，服务端 js 只声明元数据（`kind: 'theme'`，可加 `mode: 'light' | 'dark'` 标注适用模式）。

**亮 / 暗模式各用哪个主题**在「设置 → 外观主题」里选，存本机 `localStorage.sierxing-theme-map`（显示偏好，不做多端同步）。前端按当前模式挂 `link[data-theme-style]`；**组件管理页的开关对主题已不生效**（`applyComponentStyles` 会把主题样式过滤掉）。改这块注意：切换昼夜（`applyTheme`）与系统深浅色变化（`matchMedia` change）都要重挂主题样式。

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

`goals / nodes / plan_drafts / goal_versions / tutorials / sources / source_digests / chats / chat_sessions / settings / code_repo_files`，以及各组件自建表（`quiz_*` 等，已加入 `sync.js` 的 `SYNC_TABLES`）。

- `code_repo_files` 存「导入代码库」的完整文件快照（只读、脱敏），供 AI 助手对话时按问题检索（`server/code-store.js`）。**它故意不进 `SYNC_TABLES`**：路径与内容跟设备绑定、体积大，各设备自己导入一份即可，同步互相覆盖没意义（同 `review_plans` 的理由）。
- `source_chunks` 是「检索增强（RAG）」的知识库索引：资料按 ~750 字切块（`server/rag.js`），配了向量模型（设置 → 检索增强，独立于对话连接）时再批量向量化；检索 = 余弦相似度与关键词打分取较大值，**没配向量模型也能用**（退化词面检索）。派生数据、可随时重建，同样不进 `SYNC_TABLES`。规划/对话的提示词注入见 `libraryBlock()` / `ragAugment()`。

- 建表语句在 `server/server.js`，用 `db.exec` 幂等执行；新表记得加进 `server/sync.js` 的 `SYNC_TABLES`，否则多端同步会漏。
- `chats.trace` 存每轮对话的「它做了什么」（JSON 数组：看了什么上下文、调了哪些工具，见第 7 节坑 #18），列缺失时有 `ALTER TABLE` 兜底。
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

11. **`new URL(req.url, …)` 之类的解析必须放在 try 里面**。`server/server.js` 的请求处理曾经写成 `const u = new URL(...)` 在 try **外面** —— 请求行是 `//` 时抛异常 → unhandledRejection → **整个服务进程退出**，一次手滑的 URL 就能让应用挂掉、正在进行的会话全丢。现在已挡下回 400，并在进程级加了只记日志不退出的兜底。

12. **`--dump-dom` 会在 load 事件就快照**，那时 SPA 的 `route()` 还没跑完、`#app` 是空的。所以用它做路由自检会**假通过**（只 grep「页面出错」三个字当然全绿）。
    - 必须先用一个同源中转页关掉首次引导再跳到目标路由
    - 不能拿 DOM 字节数当判据（首页天生就小），要 grep **该路由特有的**标记元素
    - 拿不到 post-load 状态就别用 dump-dom，改用 `--screenshot` 看图

13. **`mdToHTML` 的围栏正则曾有贪婪回溯 bug**：`/(```+[ \t]*[\w+-]*)[ \t]*([^\n`])/` 会把 ```` ```python\n ```` 拆成 ```` ```pytho\nn ````（语言标识少一个字母、代码块凭空多一行 `n`）。另外 ```` ```` ````（四个反引号）和 `#标题`（井号后无空格）会让 `while (i < lines)` **死循环、标签页卡死**。改这块前先读第 7 节附近的注释。

14. **HTML 教程的正文在 `<iframe id="tutFrame">` 里，而且是固定高度、滚动发生在 iframe 内部**。主文档不滚。任何要「找标题 / 读滚动位置 / 跳转」的功能都必须走 `tutDoc()` / `tutWin()` / `tutRoot()` / `tutHeadEl()` 这四个入口，直接 `document.querySelector('.tutBody')` + `window.scrollY` 会**静默失效**。

15. **`buildTree` 组装节点树时不能只遍历 `Object.values(byId)`**：节点 id 是数字键，JS 对象对数字键按**数值升序**枚举 —— 等于永远按 id 排序、把 `sort_order` 整个丢掉。曾导致「AI 对话里显示移动了节点、数据库也确实改了 `sort_order`，界面顺序却纹丝不动」。兄弟节点必须显式按 `sort_order`（id 兜底）排序（`renderGoal` / `renderMapPage` / 版本对比三处都走 `buildTree`，修一处即全修）。

16. **对话助理的提示词必须自带资料库**：`buildChatPrompt` 不附【资料提炼汇总】与【资料库清单】时，用户问「资料库里有没有 / 能不能看到 XX」模型只会瞎答「看不到」——哪怕「导入的代码库」摘要就躺在库里（导入代码库会同时写 `sources` 和 `source_digests` 两份）。资料多的目标里，清单要保证「自己提供 / 导入的代码库」完整列出（不能按 id 截前 N 条把最后的代码库挤没），网络资料只列标题。回归方法：假 AI 服务器抓提示词全文。

17. **`ai.js` 流式路径不要「试发一次再正式发」**：`openaiText` 的非流式分支已提前 `return openaiLongText(...)` 之后，曾残留一份旧的一次性请求代码（`const res = await openaiRequest(...)` 及其后永远为假的 `if (!useStream)` 分支）——每次流式调用（对话 / 规划 / 教程全走这条）都会向 AI 发**两次**相同请求、第一次响应被丢弃，用户付双倍费用。流式请求只能由下面的 `for(;;)` 循环发起（它还要处理 `finish_reason=length` 的续写）。回归方法：假 AI 服务器数请求数，一次对话应当只有 1 个 POST。

18. **「它做了什么」这条链路有三处容易改坏**（对话栏里"看了什么上下文、调了哪些工具"的折叠块）：
    - **数据来源分三段，别只盯着一段**：① 上下文（`buildChatPrompt` 顺带产出 `ctx`，只记真的带上了的块）；② 工具调用（`ai.js` 的 `toolStepFromPart`，来自 opencode `--format json` 的 `tool_use`）；③ 修改（仍是原有的 `✏️ 本次修改了 N 处` + 变更详情，**故意不并进折叠块**，免得同一批操作显示两遍）。
    - **SSE 与落库都必须限量**：opencode 的 `tool_use` 里 `state.output` 可能是整份文件（几万字）。`toolStepFromPart` 只留路径/模式/命令等几个字段（各截断），正文只留**字数**；`streamChat` 里另有 `TRACE_MAX_STEPS=300` / `TRACE_MAX_BYTES=60000` 两道上限。加字段前先想清楚它会不会把一轮对话撑到几百 KB（`chats.trace` 还会跟着多端同步走）。
    - **前端两步渲染**：`state.aiStream.steps` 边收边画（`chatRenderStream` 里**要负责把块补建出来** —— 第一组上下文步骤到得比流式气泡的第一帧还早，那时 `chTraceHTML` 返回的是空串）；收尾后随消息落库、由 `chatBubbleHTML` 渲染，默认收起（流式期间用户手动点开过才保持展开，见 `state.aiTraceOpenIds`）。
    - 说人话的映射表在 `public/app.js` 的 `chStepSay`（`read`→"读了 X"、`glob`→"找文件「…」N 个"、`shell`→"跑了命令"…）。**加了新工具名要在这里补一条**，否则会退化成"用了「todowrite」"这种黑话。
    - 回归方法（都不花钱）：`node --check` + 假 opencode CLI 喂真实抓下来的 JSONL 事件（验解析与截断）+ 无头浏览器真点一遍（验折叠/展开/流式/说人话）。

19. **改教程的「结构守卫」必须能认出"用户点名要改的那一段"**（`server/tut-guard.js`）：
    - 判据不是"标题有没有变"，而是**范围外交集**：意见点名了范围（"从「X」往后 / 第 7 节之后 / 到全篇结束"）就只要求 X **之前**的章节一节不少，范围内随便重组；意见明说"允许重写结构/整篇重写"才整篇放行；都没说才按老的整节比例判。
    - **别退回到"整篇逐字比对标题、掉得多就拒"**：2026-10-14 线上，用户明确要求重写 37 节里的后 25 节，AI 照做 → 守卫拒收 → 点「🔄 重试」是同一份入参、同一个判据，**注定再失败一次**，两次各白写 3 分钟。豁免也不能只认死咒语（"允许重写结构"），用户/Agent 说的是"重写范围…直到全篇结束"。
    - 标题比对要**归一化 + 容错**（去编号 `七、`/`第3步:`/标点，再看相等、包含、共同前缀≥4、最长公共子串≥8）。用"二元字重叠率"会误判：「二、三角色：Host / Client / Server」和「七、映射到思而行：插件≈Server，路由≈Client」重叠率 0.5，范围外的章节被删了也判"还在"。
    - 守卫拦下时错误要带 `e.allowRestructure = true`：`tasks.js` 会把它变成卡片上的「🔓 允许改结构再跑」（重跑同一份入参 + `allow_restructure`），**别再引导用户去点注定失败的「🔄 重试」**。成功写入时用 `structureChangeNote()` 在回执里列出"消失了哪几节、新增几节"，别静默改结构。
    - 还要同步三处：Agent 的 `tutorial_edit` 提示词（要动结构就写清范围 + "允许重写结构"）、`buildTutorialEditPrompt`（把范围写进提示词，免得模型一边想重排一边不敢删）、补丁模式判定（点名了范围就别试补丁，白花一轮调用）。
    - **否定说法必须是"不算授权"，不能是"命中授权"**：`permissionText()` 先把"不要写「允许重写结构」""允许重写该节内部结构""不允许改结构"这类摘掉再判。真实翻车：Agent 提醒模型"不要写「允许重写结构」"，那四个字本身命中了豁免 → 守卫被这句话关掉 → AI 删掉前半本 12 节，一路放行。同理 `BOUND_RE` 要拦住"「A」之后的都不要动"（那是在钉边界，不是"从 A 往后重写"）。
    - **范围可以有上界**："从「A」开始，到「B」之前结束" → `toIdx`，B 及其之后的目录同样受保护（Agent 常这么钉边界）；不认上界的话，它顺手删掉「B」之后那几节是拦不住的。
    - **结构改动必须先跟用户核对范围**（`scopeConfirmAsk` + 模块级 `PENDING_EDIT`，只在 Agent 发起的 `quiet` 请求上生效）：拿用户**自己那句话**跑一遍同一套范围解析 —— 他没提结构、AI 却要动结构，就不开跑，先在对话里发一张「📐 等你确认改动范围」卡片（`chats.ops` 里带 `pending_edit`，前端 `pendingEditHTML` 渲染 + `data-pend-ok` 一键确认），用户点按钮（`confirmed:true`）或回一句"可以"（`CONFIRM_WORDS` + 挂起记录）才跑。
    - 卡片上**「✏️ 范围不对」是个按钮，不是一句让人回话的说明**（用户原话："改成一个范围不对的按钮，点击之后用户可以在下方重新输入改动范围"）。点它 = 聚焦下面的输入框 + 在卡片里显示一行引导，用户自己把范围重说一遍（走正常对话，`userAsked` 会认）。**别再退回"范围不对就直接回一句"那种纯文字说明**：用户得先读懂再组织语言，还容易漏掉。
    - ⚠️ **举例子只许用用户自己教程里的小节标题**（`view.inSample[0]` / `view.fromTitle`）。写死一个"只改「HTTP + SSE 版」这一节，其余一个字别动"这种跟对方内容毫无关系的例子，用户只会觉得莫名其妙（真实反馈："看到会莫名其妙 HTTP 是啥"）。同一处坑在 `server.js` 有 4 个错误提示里也犯过（`TUT_EDIT_MAX` 超限、分段改写失败、结构守卫拒收两处），一律改成"点名到某一节（写它的标题）"这种不带假标题的说法。
    - 回归方法：无头浏览器里 `chatBubbleHTML({...ops:[{op:'pending_edit',view:{...}}]}, gid)` 塞进 `#adMsgs` → 断言卡片有两个按钮、通篇不含假标题 → 点 `[data-pend-no]` → 断言引导行出现、举例来自 `inSample`、`document.activeElement` 是 `#adText`。⚠️ 表达式别写成一大坨（实测超长模板串会让 `Runtime.evaluate` 永远不返回）——分几次调用，把受控数据挂到 `window.__x` 上再渲染。用户原话："Agent 有必要跟用户核对一下改动范围再动手，不然容易错改。"
    - 回归方法（不花钱、不用开 AI）：`node scripts/test-tut-guard.js`（17 项，纯文本、秒级）。`server/tut-guard.js` 是纯文本模块，也可以直接 require 进来，喂真实教程正文 + 几种意见，断言 `structureLoss()` 的放行/拒收与 `parseEditScope()` 的范围；核对方闸要跑起服务才能验（假 AI + `/api/tutorials/:id/edit` 四个入口：pending / 回"可以" / 用户自己点了范围 / confirmed）。

20. **「看懂代码」这个组件（`server/plugins/explain.js` + `server/explain-chunk.js`）的价值全在几条契约上，改它先读插件顶部**：
    - **分块权交给 AI，系统只做兜底**（用户原话："让 AI 划分讲解模块"，之前"一行 `}` 都要被拆出来讲"被投诉过）：
      * 第一步是**划模块**：一次调用让 AI 把整段代码划成讲解模块（`{"modules":[{"from","to","title"}]}`）→ `parseOutline()` 解析 → `normModules()` 规范化（钳到 [1,n]、拼成**首尾相接、不重不漏**、把"整块只有空行/收尾符号"的模块并进相邻模块、单块 >40 行按干净断点细拆）→ 落库到 `explain_sessions.modules`。AI 大纲完全不可用时才退回 `fallbackModules()`（机械切段）。
      * 第二步是**按模块讲**：标题契约 `### 第 N-M 行 · 模块名`（`parseExplain()` 会把模块名抽出来存进 `explain_turns.title`，界面表头右上方显示的就是它）。模型漏行 / 乱序 / 越界仍由 `toBlocks()` + `mergeFragments()` 兜底 —— 范围内**每一行都要能点出内容**，且**不许出现"整块只有 `}`/空行"的讲解**。
      * 别退回"一行一块"或"系统按固定行数切段"：那样既会出现孤零零的 `}` 一块，也会把一条语句劈成两半。
    - **并行预生成 + 子任务**（用户要求：别等点了才生成；也别让任务栏被十几个模块刷屏）：
      * 模块生成好之后**立刻并行**把每一块的讲解都写出来（不等用户点开），同一时刻最多 `PAR_CONC = 3` 路 AI 调用；相邻小模块会两两合成一次调用（`buildBatches({maxLines:22,maxMods:2})`，批次边界永远落在模块边界上）。
      * 每个批次 = 一个**子任务**（`tasks.begin({ parentId })`）：任务栏里折叠进主任务下面（默认收起，点「▸ N 个模块」展开）；**子任务不落 `task_runs` 历史、没有单独的重试按钮**（否则一条讲解会在历史里刷出十几行）。主任务被「停止」时子任务要一起 abort。
      * 并行会让讲解**乱序落库 + 中间有洞**：所以进度按 `modules_done` 算（前端自己按 turns 覆盖算），`explained` 只表示"连续讲到第几行"；「继续讲」也只补"还没讲完的模块"（`pendingModules()`），不会重复调 AI。
      * 失败不是全盘失败：讲成的模块留着，主任务报"还有 N 个模块没讲成（其它都讲好了），点「继续讲」重试"。
    - **`clarify_answers` 有两种历史形状**（`server/explain-chunk.js` 的 `clarifyBlock()`）：老的是数组 `[{q,a}]`，现在前端 `collectClarifyAnswers()` 发的是**对象** `{qid: 答案}`（线上目标 166 就是 `{"q1":"a"}`）。按数组硬来会抛 `qa.slice is not a function`、整轮讲解直接失败 —— 改这里必须两种形状都过单测。
    - **讲解风格示例（个性化，用户要求的）**：用户贴/上传一段他喜欢的讲解，之后每一段讲解都照这个风格写 —— 用户原话是"讲解文字太多"，所以风格块里写死了"示例写得短、你就写短"。
      * 存 `settings.explain_style_sample`（已进 `SYNC_SETTINGS`：是用户偏好、不是密钥，换设备也该跟着走），读写走 `/api/explain/style`；上限 6000 字（超了截断，别把提示词撑爆）。
      * 提示词里由 `styleBlock()` + `STYLE_RULES` 注入（`buildExplainPrompt` / `buildAskPrompt`）—— **风格优先**：语气、详略、排版听示例的（示例里没有「记住」那行就不许加）。没有示例时走 `NO_STYLE_RULES`（默认写法，带"宁短勿长"）。
      * 界面：准备页第 3 节 + 运行页「🎨 风格」弹窗，两处共用 `styleEditorHTML()` / `bindStyleEditor()`；支持**上传 .txt/.md**（FileReader 读进框里，**再点保存才生效**）。
      * 换风格后想立刻生效：`POST /api/explain/sessions/:id/redo`（清掉 explain/overview 讲解重讲，追问记录保留）；弹窗里就是「♻️ 保存并按新风格重讲这一段」。
      * ⚠️ 上传那段踩过：`fr.readAsText(f.files[0])` 是错的（`f` 已经是 File）—— 改成 `fr.readAsText(f)`，否则真人点上传也是静默失败。
    - **前置知识（开讲前先过一遍，用户要求）**：`prereq` 阶段 → AI 先列"看懂这段代码得提前知道哪几个概念"（3~6 个，带"为什么需要它"）→ 会话状态置 `prereq` 停下来等他确认（这一步**不许偷偷先把代码讲了**）；他在界面上逐个点「✅ 知道 / ❓ 不知道」→ `POST /api/explain/sessions/:id/prereqs`（`skip:true` = 全部跳过）→ 不知道的那些**一人一小节课**（并行、子任务，`buildPrereqLessonPrompt`），**同时**照旧并行讲代码（他读小课的时候代码讲解也在写）。小课存在 `prereqs[i].lesson`（不是 turns：它不是按行/模块挂的）。
      * 状态机：`todo` 待确认 → `known`（跳过）/ `unknown`（要补）→ `done`（课写好了）。`prereq` 是**新的会话状态**：列表/顶栏/回答区/空状态都要认它（回答区此刻无可问，给一句提示）。
      * 讲代码的提示词要带上"他已经补过的小课"（一句话带过、别重讲）—— ⚠️ 必须读**库里最新**的 `prereqs`，`startJob` 开头那份 `s0` 是快照，那会儿小课还没写出来（真实踩到过，于是那行提示没进去）。
      * 「按新风格重讲」时把 `done` 的小课打回 `unknown` 重写（风格也要跟着变），但"知不知道"的判断留着。
      * 一个前置都不需要的代码（AI 返回空数组）→ 不停，直接讲。
    - 追问只挂在**被点开的那一行所属的模块**上（`coveredBy()`）；没讲到的行不给追问。
    - 数据 `explain_sessions` / `explain_turns` 已进 `SYNC_TABLES`。它替换掉了早先的「带练」（coach_* 表在 `init()` 里一次性 DROP，组件 id 也从 `coach` 改成 `explain`）。
    - **教程页的代码块编号与右键入口也在这个组件里**（用户明确要求：别做成 app.js 原生功能）。组件自己靠 `hashchange` + `MutationObserver` + `load`（iframe）认领教程页，给渲染出来的 `pre` 挂 `#N` 徽标并接管右键（菜单：「🔍 看不懂？添加到「看懂代码」」/「⧉ 复制代码」）。三条不能破：
      * 徽标必须是**空 span**：编号与提示全靠 CSS 的 `::before + attr()` 生成。tutnotes 的划线笔记按"正文文本节点的绝对偏移"定位，正文里多一个文本节点，所有高亮就整体错位（顺势连代码复制也会带上 "#3 讲明白"）。
      * 右键只在「**没有选中文字** + 落在带编号的代码块上」时接管：有选中文字时那是划线笔记的地盘，其余一律放行系统菜单（用户还要复制/翻译）。
      * 编号的唯一权威是 `parseMdBlocks()` 解析出的列表（与教程页下拉列表同一份）：徽标只按**内容匹配**取号，匹配不上就不编号（宁缺勿错）。`viz`/`demo`/`htmlviz` 里是**真 HTML** 的那种在教程里渲染成的是图，不编号也不进下拉；viz 里其实是 JSON 的那种会退化成代码块 → 要编号（判定式与 `mdToHTML` 一致：`/<[a-zA-Z][\w-]*[\s\S]*>/`）。HTML 教程（正文在 iframe）同样处理：徽标与样式注入 iframe 文档，右键坐标按 iframe 的 rect 换算。
      * 注意 `::before` 里的 `attr()` **只读自己的属性** —— 编号必须同时挂在徽标 span 上（挂在 `pre` 上会渲染出一个没有数字的"# JS"，真实踩到过）。
    - 界面细节（改的时候别退化）：左侧代码面板用**宿主的语法高亮**（`hlCode`/`hlGuessLang` 已通过 `HOST_KEYS` 暴露给组件，别在组件里再写第二套；配色用全局的 `--tk-*` 变量）—— `splitHL()` 把整段高亮 HTML 按行切开时**必须把跨行的 `<span>` 在行尾闭合、下一行重开**（多行字符串/块注释会跨行）。
    - **三处边界都能拖（用户两条要求："不只是中间的分隔条，左右的也要能拖" + "下面的横条也能拖，自主调节显示范围"）**：
      * 左右：命中区不是那 14px 的条，而是**边界附近的整条带** —— 左栏右边缘 / 中间分隔条 / 右栏左边缘，靠近 `SPLIT_HIT`(12px) 内都算抓住（`class="exHot"` → `col-resize` + 分隔线发光），拖的是同一个比例，存 `localStorage.sierxing-explain-split`。
      * 上下：两栏区域的**底边 + 下面那条横握把 `.exSplitH`**（靠近 12~26px）→ `exHotV` / `row-resize`，拖的是容器高度（`--exH`，280px ~ 视口-140px），存 `sierxing-explain-height`；双击底边恢复默认。
      * 宽度用**比例**（%）、高度用**像素**、总宽用**像素**，都是本机显示偏好（不同步）。文档级监听只绑一次（`document.__exSplitBound`），容器引用每次渲染更新（`splitWrap`）——别再退回"只给分隔条本身绑 mousedown"，那样用户抓面板边缘就没反应（真实反馈）。
      * **最外两条边**（代码栏左边框 / 对话栏右边框）拖的是**整体宽度** `--exW`（超过页面容器时左右对称溢出，跟教程正文宽度同一套 `margin-left:calc((100% - w)/2)` 算法）；⚠️ 方向必须按抓的是哪条边分开算：抓左边往右拖是**变窄**（`-2×dx`），抓右边往右拖才是变宽（`+2×dx`）——两边都用 +2× 会出现"边不跟手、越拖越反"。
      * **别每次轮询都重画回答区**（`renderAsk()` 有签名判断，`askSig()` 没变就直接跳过）：每 2.6 秒重建一次 `<textarea>` 会把用户的**焦点**和他手动拖高的**输入框高度**一起丢掉 —— 用户报的"调节高度后立刻变回去"就是这个。输入框高度记在 `localStorage.sierxing-explain-tah`（`bindTaHeight()` 在 mouseup/pointerup/input 时存，重画时 `ta.style.height` 还原）。
    - 回归方法（不花钱）：`node scripts/test-explain.js`（39 项：切段首尾相接 / 漏行补洞 / 越界钳制 / **模块大纲规范化（含"只有 `}` 的模块被并掉"、巨块细拆）** / 批次边界 / `clarify_answers` 两种形状 / **`numCode` 传数组也要按行**）。端到端用假 AI（`fake-ai-explain.mjs`：先回一份**故意不老实**的大纲 —— 有洞、越界、把 `}` 当模块 —— 再按模块回讲解；另按提示词里的标记回「前置知识清单 / 前置小课」）跑：断言模块首尾相接、每一行都有讲解、没有"只有收尾符号"的块、每块都带模块名、`[[NAME]]` 没泄漏、**并发 ≥ 2 且 ≤ 3**、子任务带 `parentId` 且不落 `task_runs`、停止主任务时子任务一起停；前置知识那条链路单独跑（列出来就停住不偷讲 → 点"不知道"只给那个补课、"知道"的不写课 → 跳过 → 无前置直接讲 → 提示词里带"他已补过的小课"且代码是**按行**给的）。前端真点一遍：`#exProgTxt` 写"已讲 x/y 个模块"、代码栏有 `.exModStart` 分隔线、表头带模块名、任务栏里「▸ N 个模块」默认收起点开才展开、左侧代码有 `.tk-*` 上色、拖分隔条能改宽度且刷新后记得；教程页那条链路单独验（看编号 → 右键 → 添加到看懂代码 → 讲解页已经在讲；HTML 教程走 iframe 那条），并顺带验「选中文字后右键仍是划线菜单」「正文纯文本没被徽标污染」「下拉列表条数与编号上限一致」。
      * ⚠️ 无头浏览器（microsoft-edge + CDP）在这台机器上**偶尔会卡**：`Runtime.evaluate` 超时、甚至整个浏览器进程消失。写测试时每个 evaluate 都要能重试（别一次超时就当失败），而且**同一时刻只跑一个 CDP 脚本**（两个脚本共用一个浏览器会互相打架、日志交错，看起来像产品 bug）。

21. **长教程的修改走「分节改写」，别再退回"整篇重写"**（`server/tut-seg.js` + `server.js` 里那段 `tutSeg.shouldSegment`）：
    - 全文重写要求模型把整篇重新吐一遍：8 万字就要 4~6 轮续写（实测常撞"AI 输出过长"），9 万字以上被 `TUT_EDIT_MAX` 直接拒收 —— 用户根本改不了自己那份越来越长的教程（真实反馈）。
    - 现在的规则：正文 > `SEG_MIN`(28000) 且意见点名了范围（`parseEditScope` 的 range/all）→ 按标题边界切块（每块 `SEG_CHUNK`≈14000 字）→ 逐块让 AI「只改这一段」→ `tutSeg.splice` 拼回整篇。**范围外的正文逐字拼回**，所以结构守卫的"范围外不许少"天然满足，输出量只跟要改的那几节有关。
    - 三处不能错：① 切块必须首尾相接、不重不漏（`splitScopeChunks` 有单测）；② 模型多吐了下一段要在下一段标题处截断、段首标题被吃掉要补回（`cleanSegment`）；③ 拼装前校验块数与结果数一致（对不上就报错，宁可失败也不能拼错位）。
    - 分段没成/某块写坏了 → **自动回退全文重写**；这时若正文超上限，错误消息要能照做（"点名到某一节就能改"），别只说"请把意见拆小"。
    - `buildTutorialEditPrompt` 必须**懒构造**（`editBase()`）：它内部有 9 万字上限的拒收，提前拼会让长教程连分节改写的门都进不去。
    - 回归方法（不花钱）：`node scripts/test-tut-seg.js`（12 项，纯文本）；端到端用假 AI 回"分段"（`<<<SEGMENT_START>>>` 那段），断言"范围外逐字未变 + 只调了分段 + 输出量远小于整篇"。

22. **搜集信息源必须"AI 把关"，本地只挡一眼假广告**（`server/collect-screen.js` + `collectSources`）：
    - 用户的定调（原话）："先大量检索，然后 AI 审查这批信息源内容质量如何；字数限制太死板了，应该由 AI 判读，一个高质量的信息被截断了应该继续把全部内容导入进来。"
    - 流程：广撒网（每条 query 30 条，不再按 kind 配额先到先得）→ 候选池（站点优先 + 单站上限 + 总量上限，**只防一家刷屏，不做质量判断**）→ 抓 3,500 字探测正文 → 本地硬闸门（正文太短 / 标题跑题 / 广告词 / 超期）→ **AI 判读**（≤18 条一批：相关度 0~5、有没有实质内容、是不是营销水文、主题、一句话摘要、要不要抓全文）→ 达标入库 → **达标且被截断的回抓全文**（单条 `collect_full_max` 60k 字、整次预算 160 万字）。
    - ⚠️ 别再退回"按 kind 的先到先得配额 + 面经必须是真人分享"那套：那是求职模板时代的启发式，实测那个目标 218 条网络资料里 56% 是空壳（知乎/招聘站抓不到正文）、最多的一类 CSDN 71 条水文，抽样还有"软考三件套""网络工程师学习路线"这种完全跑题的内容。
    - 判读结果落库（`sources.quality_score / ai_summary / topic / review / content_full`）：资源库列表显示"AI n/5 · 主题 · 一句话摘要"，对话的【资料库清单】也带上（模型据此决定要不要展开读）。`quality`（人工★）与 `quality_score`（AI 分）是两件事，别混。
    - 设置：`collect_review`（开关）/`collect_min_score`（严格 4 / 标准 3 / 宽松 2）/`collect_candidates`/`collect_per_site`/`collect_full`/`collect_full_max` —— 在「搜集设置」弹窗里改（存本机、下次沿用）。**这几个键必须同时在 `/api/settings` 的 GET 回显与 POST 白名单里**，否则前端发了也会被静默丢掉。
    - 判读失败不影响主流程：按"未审"处理（宁缺勿滥，不收）；用户点停止要能中止（`signal` 一路透传）。
    - 回归方法（不花钱）：`node scripts/test-collect-screen.js`（17 项，纯文本）；端到端用 `SX_SEARCH_BAIDU=<假结果页>` 把搜索引擎指到本地假世界（`fake-world.mjs`：结果页 + 文章页 + 判读接口），断言"跑题的软考 / 广告 / 没正文 / AI 判低分"都被挡下、高质量长文补抓到全文、stats 漏斗如实记数。

23. **抓下来的正文要清洗，别让"网页牛皮癣"进库**（`server/text-clean.js`）：
    - 原来抓网页正文是"把 HTML 标签全删掉"，于是每条资料都混着导航菜单、面包屑、`相关阅读/猜你喜欢`的链接清单、关注公众号与加群引导、版权/免责/ICP 页脚、评论区、页码——实测抓 3,500 字里常有一多半是这种垃圾，还会被切成检索片段把真内容挤下去。
    - 两层：① **本地**（免费、确定性）`dropJunkBlocks`（按标签与 class/id 丢整块）→ `pickMain`（`<article>` / class 像正文的容器里挑最长的一块）→ `cleanLines`（逐行丢：垃圾词行、纯链接行、面包屑、连续三行以上的短菜单、重复≥3 次的行、页码行、英文页脚…）；② **可选 AI**（`buildCleanPrompt`）：只删不改，契约写死"一个字都不许改写/不许新增/代码原样保留"，并有**两道保险**——输出必须能在原文里找到（否则判为改写，拒收）且不许比原文长。
    - 接入点：`fetchPage()` 抓完立刻清洗（搜集/补全文都走它）；`jdfile` 的电子书/PDF 提取后过一遍 `cleanLines`（去页眉页脚）；**已有的老资料**走 `POST /api/goals/:id/sources/clean`（资源库页「🧹 清洗资料」按钮）。原文在首次清洗时备份进 `sources.content_raw`，可反复对照/重跑。
    - **弹窗只负责"看得见进度"，停止归左下角任务中心**（用户原话："用户要停掉任务完全可以到 AI 任务里面或者左下角的卡片里停掉，没必要在这个弹窗里操作；关掉弹窗不等于停止 AI 清洗任务"）。所以：弹窗里**只留「×」和「关掉，后台继续」，不放停止按钮**；关掉只是不再挡页面，服务端任务照跑（`tasks.begin` 的那条）。
    - 进度要回答"**已经清洗了多少篇**"，不是只转圈：服务端每处理完一条就推 `{done,total,pct,title,removed,aiCalls}`，弹窗画成「已清洗 5 / 27 篇（19%）+ 正在处理《标题》+ 已去掉 X 字」；任务卡片那行也带上篇数与百分比（`cSend` 同时调 `tk.progress(pct, status)`，别只传文案，否则卡片进度条恒 0%）。
    - AI 那遍很慢（一条十几秒）：`clean_ai_max`（默认 40）限制单次运行的 AI 处理条数，跑完如实报"还有 N 条没轮到 AI，可再跑一次"；否则一次点下去要等一小时，用户只会以为卡死了。
    - ⚠️ 前端这块踩过：删掉 AbortController 后残留了 `signal: ac.signal`，进 try 就 ReferenceError、被 catch 吞掉后立刻关弹窗 —— 表现成"点了按钮什么都没发生"。改这块要真在浏览器里点一遍（无头 CDP：点按钮 → 看是否有弹窗/进度 → 点 × 关掉 → 确认任务还在跑）。
    - ⚠️ 两个门槛别乱改：`cleanLines` 的"洗太狠就退回基本清洗"（防把正文洗没）；服务端的"洗成空壳就保留原样"按**原文相对比例**判（`newLen < 30` 或 `rawLen ≥ 400 且 newLen < 15%`）—— 用绝对字数会把一二百字的短资料全 skip 掉（实测踩到）。AI 只对清洗后 ≥400 字的资料跑（短文不值得花调用）。
    - 回归方法（不花钱）：`node scripts/test-text-clean.js`（27 项：垃圾必须走、正文必须留、实体解码、反爬挑战页、AI 契约与两道保险）；端到端用假世界（文章页故意包上导航/推荐位/页脚/软广）验"采集时就干净"+"清洗接口对老数据有效"。

24. **抓不到正文 ≠ 反爬，多半是"当初没重试"**（`fetchPage` 的三档重试 + 镜像 + 补抓）：
    - 真实体感来源：库里 908 条网络资料有 483 条（53%）正文为空（知乎 95% / BOSS 直聘 100% / CSDN 70% / 51CTO 94%），它们照样各占一个检索切片。而随机抽 24 条重抓，**14 条（58%）当场就抓回来了**，全是 CSDN / 51CTO / 公众号 —— 大头不是反爬，是当初批量采集时的限流/超时**没有重试**。
    - `fetchPage` 现在按「直连 → 补全浏览器头（Referer/Accept/Upgrade-Insecure-Requests）→ 手机 UA」三档换招，每档之间退避 0.6~1.8s；`opts.attempts` 控制试几档（采集默认 2、补抓/补全文 3），`opts.retry=false` 关掉。**404 只跳过同一个地址剩下的档**（`skipUrl`），别把后面的镜像一起掐掉。
    - GitHub 在这台机器**完全不可达**（raw.githubusercontent.com 会挂到超时），所以补一条 jsdelivr 镜像（`mirrorUrls()`：`github.com/u/r/blob/ref/path` → `cdn.jsdelivr.net/gh/u/r@ref/path`；仓库首页退而求其次试 `@main/README.md`、`@master/README.md`）。**只做"多给一条路"，绝不改写原地址** —— 换台能上 GitHub 的机器时原路照样优先。r.jina.ai 这类云阅读器在本机**不可达**，别往那上面设计。
    - 抓失败要**如实归因**（`fetchOnce` 的 `why`：HTTP 403 / 正文只剩 N 字 / 页面太大 / 反爬挑战页 / 超时）。补抓的进度里"抓回"和"删掉"必须分开记。
    - **反爬挑战页要当"没抓到"**：51CTO 给非浏览器请求回 988 字节的纯 `<script>` 混淆代码，而 `htmlToText` 原来只删标签、**不删 script 内容** —— 那段混淆 JS 就成了"正文"进库（实测）。现在 `htmlToText` 开头整块丢 `script/style/noscript/svg/iframe/template/canvas`（顺序要在实体解码**之前**，否则 `&lt;script&gt;` 这种文字会被误删），并用 `looksLikeChallenge()`（`_0x` 混淆标识符 ≥3 次）兜底判"这是挑战页"。
    - **实体解码必须支持十六进制**，且顺序是「数字实体 → 命名实体 → `&amp;` 放最后」：CSDN 把全角标点写成 `&#xff0c;`（=「，」），只认十进制会让整篇正文变成乱码（库里曾有 69 条被污染，`&#xff0c;` 一路混进检索切片和提示词）。`&amp;` 放最后是因为 `&amp;lt;` 里作者本意是**显示文字** `&lt;`（讲 HTML 转义的教程到处都是），先解会连解两层把讲解内容改坏。存量被污染的资料点一次「🧹 清洗资料」（**取消 AI** 那档，纯本地、免费）就能修好。
    - **同一家站连着抓不到就不再试**（采集时的 `hostFails`，阈值 `DEAD_AFTER=4` 条）：知乎/BOSS 这类要登录态的站，候选择里可能有十来条，抓一条废一条、每条还要走三档重试。只做**本轮内**的学习，不落库、不影响下次 —— 哪天站点放开或换了抓法，下一轮自然重试，不需要用户去某个设置里解封。只有 `hardGate` 的 `no-body` 才算连坐，跑题/广告是**这条**的问题。
    - 补抓接口 `POST /api/sources/refetch`（**全部目标**，资源库页「🔄 补抓正文」）：门槛与硬闸门一致（正文 <260 字算空壳）→ 逐条重抓（4 并发、`bytes` 上限放到 6MB，因为公众号/B站页面本身就有 1~3MB）→ 抓到的写回正文并补 `published_at`，**抓不到的直接删**（用户原话"抓不到就删"：留个空壳更糟，它占检索位、还会让 AI 以为"这条我读过"）。删除要照抄既有语义：`DELETE FROM sources` + `code_repo_files` + `rag.dropSource()`，并 `rag.autoIndex()` + `backup()`。
    - 全量实测（489 条空壳）：**抓回 206 条（+268 万字），删掉 283 条，用时 4.5 分钟**。删掉的分布就是硬墙清单：知乎 136（HTTP 403）、BOSS 直聘 46（跳 security 页）、51CTO 17、php.cn 13（登录墙）、GitHub 12（仓库已删/404）。
    - ⚠️ 建测试沙箱时**必须 `NO_OPEN=1`**：`server.listen` 回调里会 `xdg-open` 打开浏览器（`NO_OPEN` 是唯一的开关），否则会在用户桌面上弹出窗口，窗口里的操作会写进沙箱库、把"实验数据"和"真实数据"混在一起。另外沙箱里要**先把 `sync_enabled`/`sync_auto_push` 置 0**，否则沙箱会连上用户的真实同步仓库。
    - 回归方法（不花钱）：`node scripts/test-text-clean.js`；端到端在**隔离沙箱**上跑 `POST /api/sources/refetch`，断言"空壳清零、删掉的都是硬墙站、抓回的正文没有混淆脚本、状态真落库"。
    - ⚠️ 无头浏览器做前端回归时：新版 Chrome/Edge 必须加 `--remote-allow-origins=*` 才能收 CDP 命令（否则连上了也不回）；**直连一个已经存在的老标签页的 WS 常常压根不回命令**，要用 `PUT /json/new?<url>` 开一个干净标签页；`Runtime.evaluate` 里做 `location.href=...` 会让这次调用的响应永远丢失（导航销毁执行上下文），要导航就在启动参数里给 URL；也不需要 `Page.enable` / `Runtime.enable`，`Runtime.evaluate` 直接可用；`--headless=new` 下原生 `confirm()` 会被自动关掉（返回 false），测按钮要先把 `window.confirm` 换成 `()=>true` 并把参数记下来，否则测试是假通过。

25. **所有 AI 任务的进度都必须走同一套模型**（`server/task-progress.js` + `server/tasks.js` + `taskProgressHTML`）：
    - 改前的现状（真实踩到的三种不一致）：① `1 - Math.exp(-秒/18)` 这套时间曲线被**抄了 5 份**（interview / quests / restate / jdfile / explain），常数还各不相同（封 93% / 95%）；② 有的任务**压根不推百分比**（收集资料、识别图片只推文案），卡片上只有一条不动的走马灯；③ 有的推了计数却忘了推百分比，用户最想知道的"已处理 3/9"根本不显示。
    - **进度只有四种来源，优先级从高到低**：`set(pct)` 任务自己算的真实值 → `count(done,total)` 可数的活儿 → `phase(i)` 阶段推进 → `time`（都没有时按时间平滑）。每个快照都带 `source`，前端据此把 `time` 标成"**估算**"——**绝不把估算冒充真实数字**。
    - **四条防假进度的铁律**（`scripts/test-task-progress.js` 全部钉住）：① 百分比**单调不减**，任何情况下不倒退；② 时间曲线只在**一个阶段内部**爬，到边界就停住等真实推进；③ 最后一个阶段封在 93%，**100% 只由 `finalize(done)` 给出**；④ 阶段内取「真实下界」与「时间曲线」的**较大者**（很多阶段是"每 8 条才报一次"，只认地板的话条会长时间一动不动，跟卡死一样）。
    - ⚠️ **没给 `expectedMs` 时必须用 `null` 而不是算成 1000**：`Math.max(1000, Number(o.expectedMs) || 0) || null` 这种写法在"没给"时得到的是 **1000ms**（不是 null），于是尺度变成 1 秒、条 3 秒冲到 90%（真实任务上抓到，已加回归）。正确写法：`Number(o.expectedMs) > 0 ? Math.max(1000, ...) : null`。
    - **两条路必须共用同一批方法**：`submit` 的 `run({signal,note,...handle})` 和 `begin()` 的返回值都 spread 同一个 `handle(t)`。以前这两处各写一遍 extra 解析，漏一处就是"某类任务的进度条永远停在 0%"。
    - 任务侧只声明、不自己算：`tasks.begin({..., phases:['搜索候选','抓取正文','AI 把关','整理入库'], total, expectedMs})` + `job.phase(0,'…')/job.count(3,9,'…')/job.note('模型正在写…')`。SSE 型任务（collect / 清洗 / 补抓 / 识别图片）用 `onProgress({status, prog:{phase, frac}})`，`tkSend` 统一转发。
    - **零改动也有进度**：`begin`/`submit` 都会建引擎，一句进度都不报的任务也会拿到一条按时间走的条（前端标"估算"）。所以"有的能显示有的不能"从机制上不可能再出现。
    - `expectedMs` 的默认尺度是 **45 秒/阶段**（`PHASE_MS`）；知道量级的任务（教程生成等）自己传。别把默认值调小，否则条会冲得太快。
    - 前端**只有一个渲染器** `taskProgressHTML(t)`（左下角任务栏 + `#/aitasks` 页共用）：百分比/条/阶段点/实时思考/用时。`queued` 也要给同一块占位（"排队中 · 等前面腾出并发位"），否则卡片高度和跑着的那些对不上。
    - ⚠️ **`taskElapsedTick()` 必须在 `taskBarRender()` 里启动**：任务栏有好几条渲染路径（轮询、点开收起、子任务折叠、取消后重绘），只在 `taskPoll` 里启动的话别的路径画出来的卡片**没有计时**（实测那一行是空的）。
    - ⚠️ 任务卡上说人话的映射表是 `TASK_META`：**加了新任务类型要在这里补一条**（`interview`/`jdfile`/`quests`/`bench` 原来没登记，卡片上显示成"🤖 任务 · interview"这种黑话）。
    - 回归方法（不花钱）：`node scripts/test-task-progress.js`（21 项，纯计算、秒级）；端到端用无头浏览器**注入受控任务**验渲染——⚠️ 必须把"改 `state.tasks` → `taskBarRender()` → 读 `#taskBar` 的 innerText"放在**同一次 `Runtime.evaluate`** 里：应用每 1.5 秒 `taskPoll` 一次会把 `state.tasks` 覆盖回服务端的真实列表，中间隔一次 sleep 就什么都看不到（第一次就这么假失败过）。真任务用 `POST /api/goals/:id/rag/build`（两阶段、本地、不花 AI 调用）验"服务端真的按阶段推进"最省事。

26. **Markdown 正文要放行"一小撮内联 HTML"，渲染能力必须和提示词对齐**（`public/app.js` 的 `mdTags/mdSafeStyle/mdInline` + `mdToHTML` 的 `<details>` 分支 + `server/server.js` 的 `richMdSpecLines()`）：
    - 事故原貌（2026-10-15）：用户要"样式更丰富、标红重点"，`tutorial_edit` 照做，写出了 `<span style="color:#dc2626;font-weight:700">…</span>`；而 `mdToHTML` 把所有 `<` 都转义了 —— 教程正文里到处躺着裸标签（用户原话："我想让教程的样式更丰富，结果把 span 都显示出来了"）。**模型写出来的东西，渲染端要么支持、要么不许它写**，不能两边都不知道对方存在。
    - **白名单**：`span/b/strong/i/em/u/s/del/ins/mark/code/kbd/samp/var/small/big/sub/sup/br/wbr/abbr/cite/q/time/dfn/nobr`。**不在名单里的一律继续按纯文本显示** —— 正文里的 `<PHONE>` 占位符、`<doc id>`、`<stdin>`、`<Object>` 都长着标签的样子，顺手渲染就变成"凭空少了一截字"。
    - **span 只认 style，且只留排版属性**：值里出现 `url(` / `expression` / `javascript:` / `@import` / `!important` / `var(` / 引号尖括号一律丢。这是唯一的安全边界 —— AI 输出不可信，**别为了"让它更花哨"把 class / href / on* 放进来**。
    - **颜色映射到主题变量**：`#dc2626`→`var(--danger)`、`#c9701f`→`var(--warn)`、`#16a34a`→`var(--ok)`（只映射 `color`）。写死的红在暗色背景上发闷，而 `--danger` 亮/暗分别是 `#e02424` / `#f87171`。
    - **`<details><summary>` 走块级分支**（`mdToHTML` 里，不是 `mdInline`）：`<details>`/`</details>` 各占一行、必须找到配对才渲染，找不到就照旧当段落 —— **绝不能把后面整篇吞进一个没关上的块里**；嵌套用深度计数。`<details>`/`</details>` 同时进了 `isBlock()`，因为模型常紧贴上一段/列表写（中间不空行），不隔开就会被并进上一段、折叠块散架。
    - **行内代码先摘成占位符再做其它规则**（`mdInline` 里 `\u0000C<n>\u0000`）：否则 `` `<span>` `` 这种"讲 HTML 的教程"会被标签还原吃掉，变成正文里凭空少一段。
    - **与周边功能的契约**：`mdInline` 只加元素、不改字符 → tutnotes 的绝对偏移、`mdPickTarget` 的 `data-src`（`closest` 往上找）都照旧；`viz`/代码块的渲染路径完全不动。改这块要顺带跑一遍：划线笔记还在、双击能进就地编辑、目录/代码块编号正常。
    - **提示词侧**：`richMdSpecLines()` 三处共用（`buildTutorialPrompt` / `buildTutorialEditPrompt` / `buildSegmentPrompt`），写明"只这几样、每节最多 3 处标红、其余 HTML 一律不要写、讲 `<stdin>` 这类要用反引号包起来"。
    - 回归方法（不花钱）：起一个 `NO_OPEN=1` 的沙箱实例（数据目录拷一份真库的 `VACUUM INTO` 快照，`sync_enabled/sync_auto_push` 先置 0），无头 Edge + CDP 里直接调 `mdToHTML(...)` 断言输出，再打开真教程（`#/t/142` 有标红 span、`#/t/102` 有 details 与表格里的 `<br>`）读 DOM：正文里**不许再出现** `&lt;span`、`<details` 字样，`getComputedStyle(span).color` 是主题红。

27. **从应用里拉起 GUI 程序（VSCode / 浏览器）必须先补显示环境**（`server/gui-env.js` 的 `guiEnv()`）：
    - 事故原貌（2026-10-16）：教程页点「💻 写代码」→ 下方提示「已在 VSCode 打开」，**窗口永远不出现**。数据、目录、检测全正常，只有窗口没了。
    - 根因：应用是**开机自启**的，Linux 上就是 `service.js` 写的那个 systemd 用户服务 —— 它**不在桌面会话里**。`DISPLAY`/`XAUTHORITY` 是**登录之后**才被导入 systemd 用户管理器的（`systemctl --user show-environment`），而开机那一刻起来的实例环境里没有它们（`/proc/<pid>/environ` 里 grep 不到）。于是 spawn 出去的 Electron 只来得及打印 `Missing X server or $DISPLAY` + `The platform failed to initialize.  Exiting.`（exit 133）就自杀。**同一个服务，中途 `systemctl --user restart` 一次就好了**——这就是"以前能用、现在不行"的原因，别去前端找 bug。
    - ⚠️ **假成功是更坏的那一半**：VSCode 的 `code` 命令是「fork 出主进程、自己立刻 `exit 0`」，spawn 又是 `stdio:'ignore'`，所以后端拿到 0 就回 200 → 前端弹「已在 VSCode 打开」。**凡是"拉起外部程序"的接口，都不能把 spawn 返回当成"已打开"**：探测不到显示环境要如实回 `warn`，前端 `toast(r.warn || '已在…打开')`。别退回只报成功。
    - 修法：所有拉起 GUI 的地方都带上 `env: guiEnv()`（VSCode 见 `server/plugins/workspace.js`；启动自动开浏览器见 `server/server.js` 的 `listen` 回调；设置页「打开页面」见 `server/service.js` 的 `openBrowser()`）。`guiEnv()` **只补不覆盖**：已有 `DISPLAY`/`WAYLAND_DISPLAY` 原样返回（Windows/macOS 也原样返回）；缺了才扫 `/tmp/.X11-unix/X<N>`（优先本用户会话、其次最新的那个）、`$XDG_RUNTIME_DIR/wayland-*`，`XAUTHORITY` 在几个候选里挑 **mtime 最新**的（gdm 那份是登录时刚写的，家目录 `~/.Xauthority` 常躺着上个月的旧文件；挑不到就别写空值 —— 空 `XAUTHORITY` 会让 Xlib 直接认证失败）。
    - ⚠️ 别改成「往 systemd unit 里写死 `Environment=DISPLAY=:1`」：那是把某台机器的显示号钉进配置，换机、多屏、Wayland 全会翻车。
    - 回归方法（不花钱、不动用户桌面）：`env -u DISPLAY -u XAUTHORITY node -e "…guiEnv()…"` 断言补出可用的 `DISPLAY` + 存在的 `XAUTHORITY`，再 spawn 一个**只读的 X 客户端**（`xset q` / `xdpyinfo`）看退出码 —— 用它当判据，**别拿"窗口有没有出现"当唯一判据**（会打断用户正在做的事）。真要端到端验一次：删掉父进程的 `DISPLAY`/`XAUTHORITY` 后再走一遍插件的 `spawn`，然后用 `pgrep -af "/usr/share/code/code"` 确认主进程活着（顺带会真的打开一个窗口，验完记得跟用户打声招呼）。

---

## 8. 打包 exe 与在线更新（`scripts/build-exe.js`）

给「不想装 Node 的人」用的单文件 Windows 程序。**运行时依然零第三方依赖**。

```bash
node scripts/build-exe.js --skip-exe --notes="修了 XX"   # 只出发布件（更新用，最快）
node scripts/build-exe.js                                # 再加上 dist/SiErXing.exe（约 89MB）
```

产物三样：

| 产物 | 提交？ | 说明 |
| --- | --- | --- |
| `release/latest.json` | ✅ 提交 | 清单：版本号、下载地址、sha256、更新说明 |
| `release/payload-<版本>.sxar` | ✅ 提交 | 程序文件载荷，约 450KB |
| `dist/SiErXing.exe` | ❌ 只上传附件 | 89MB，其中 88.7MB 是 node 运行时，**永不变** |

**在线更新为什么成立**：exe 里 99.5% 是不变的 node 运行时，会变的只有那 450KB 的程序文件。
所以发新版 = 换一个 payload + 改一行 `latest.json`，用户下次启动只下 450KB，**不用重下 89MB**。

### 三种安装形态，`server/update.js` 按 `mode` 分发

| mode | 判定依据 | 更新方式 |
| --- | --- | --- |
| `git` | 存在 `.git` | `git pull --ff-only`（原有逻辑） |
| `payload` | 存在 `.sx-current` | 下载 payload → 校验 sha256 → 解包 |
| `none` | 两者都没有（zip 解压） | `supported:false` |

`SX_UPDATE=off` 完全关掉；`SX_UPDATE_URL` 可把清单指到自己的地址（离线/内网用）。

### ⚠️ 这里有四个必须记住的坑

1. **解出来的目录里没有 `.git`，而 node.exe 也不带 git** —— 所以打包版的更新**完全不能走 git 那条路**，`update.js` 必须有 payload 后端，否则 exe 用户永远更新不了。

2. **SEA 里不能 `require(绝对路径)`** —— SEA 主脚本的 `require` 是 `embedderRequire`，会把路径当成内置模块名，报 `ERR_UNKNOWN_BUILTIN_MODULE`。必须 `require('node:module').createRequire(...)`。

3. **载荷的版本标记必须按版本号比较，不能按「不相等就解」** —— 在线更新后本地会比 exe 内嵌的还新（exe 本身没换）。若按"不相等"判断，启动时会把**旧的内嵌载荷又铺回去，把刚更新的代码覆盖掉**。

4. **`VER` 必须按文件内容算哈希** —— 早先只 hash 了 `package.json`，改 `public/app.js` 而不动 `package.json` 时哈希不变 → 更新被当成"已是最新"静默跳过。

### 用户数据在任何路径下都不会被覆盖

- `DATA_DIR = APP_DIR/data`，而 `data/` **不在打包清单里**（`collect()` 里显式跳过）
- `applyPayload()` 解包时逐条 `if (f.p.startsWith('data/')) continue`
- payload 的 zip-slip 风险已挡：路径只来自自家生成的头部，且都在 `appDir` 下

**测打包版务必用别的端口**（`PORT=3214`）。用默认 3213 会把用户正在用的服务顶掉，
表现为「数据全都不见了」——其实数据好好地在，只是浏览器连到了空库的新实例。

---

## 9. 零依赖纪律

**不要引入任何 npm 依赖。** 这是产品的核心卖点（`git clone` 完直接 `node server/server.js` 就能跑）。

需要什么就自己实现：Markdown 渲染（`app.js` 的 `mdToHTML`）、电子书解析（`server/plugins/lib/ebook-parse.js`，支持 txt GBK / pdf 含 ObjStm+ToUnicode / epub spine / mobi PalmDoc）、测试用的 DOM 桩（直接用无头浏览器）。

---

## 10. 前端资源访问约定

**只有两个前端文件**：`app.js`（核心）与 `sdk.js`（组件 SDK）。没有打包器、没有模块系统。

- 组件脚本通过动态 `<script>` 加载，**必须用 `assetUrl()` 追加版本戳**。
- 全局事件用 `document.addEventListener` 委托；`.moreMenu` 的关闭、`[data-cmd]` 命令分发都是这种模式。
- Markdown / 代码块渲染走 `mdToHTML`；AI 返回的代码**必须用围栏包裹**（提示词里有这条铁律）。

---

## 11. 修改后的自检清单

```bash
node --check public/app.js && node --check server/server.js     # 语法
# 重启（务必确认端口释放）→ curl /api/health → curl /api/plugins
# 无头浏览器逐路由启动，确认无「页面出错」
# 组件改动：目标内开/关，确认其它目标不受影响
```

- 用了无头浏览器 → **收尾必须确认它真的退出了**（`bash scripts/kill-test-browsers.sh --dry` 看一遍）；测试实例一律 `NO_OPEN=1`，别在用户桌面上弹窗。见 §2 的两条铁律。
- 改了组件的开关粒度 → **必须**同时改前端显示、后端 403 门控、组件入口三处。
- 加了新表 → 加进 `server/sync.js` 的 `SYNC_TABLES`。
- 动了 `public/` 或 `public/plugins/` → 版本戳会变，用户普通刷新即可拿到新文件。

---

## 12. 许可

MIT。**不要修改 `LICENSE`**。分发时必须保留 `sierxing` 的署名。
