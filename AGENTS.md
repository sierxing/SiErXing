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
| 前端 | legacy 原生 JS（无框架、无构建）；UI 插件层 Vue 3 + Vite（构建后产物进 public/ui-dist，见 §3.4） |
| Node 要求 | ≥ 22.5（旧版需 `--experimental-sqlite`），推荐 24 LTS |
| 端口 | 3211 / 3212 / 3213，历史遗留，**不要改** |
| 协议 | MIT（见 `LICENSE`） |

**代码量**（改动前先有个规模概念）：`public/app.js` ≈ 6600 行、`server/server.js` ≈ 4600 行、`server/ai.js` ≈ 540 行、`public/sdk.js` ≈ 110 行。核心逻辑**高度集中在两个大文件**里，没有按模块拆分。

---

## 0.1 文案硬规则（写任何代码之前先读这一节）

> 一句话：**代码里不写死任何"给用户看的字"；文案统一由 `language/` 管理。**
> 这条是项目的**架构规则**，不是建议。详细操作手册在 [`language/README.md`](language/README.md)。

**必须遵守的 6 条：**

1. **用户可见文字一律走 `tr()`**：按钮、标题、标签、提示、toast、报错、空状态、`placeholder`、
   `title`、`aria-label`、`alt`……代码里写的是**源语言（中文）原文作为 key**，译文在语言包里：
   ```js
   button.textContent = tr('保存');                    // ✅
   button.textContent = '保存';                        // ❌ 守卫会失败
   ```
2. **带变量必须用占位符整句翻译**，不要自己拼字符串：
   ```js
   toast(tr('已删除 {0} 份', n));                       // ✅
   toast('已删除 ' + n + ' 份');                        // ❌ 英文语序/量词不同，拆出来是散装英文
   ```
3. **提示词正文不许写死在业务代码里**：模板放 `language/prompts/zh-CN/packs.json`
   （经 `server/prompts/*` 的 loader / 注册表读取）；新增提示词要先加模板，再在 builder 里引用。
4. **新增/修改文案后必须收进源语言目录**：`npm run build:lang`，否则 `npm run check:i18n` 会红。
5. **不许绕过守卫**：因为中文原文就是 key，**新增文案 = 新增词条**；`language/legacy-baseline.json`
   是旧代码的"硬编码预算"，只许降不许升（`node scripts/check-i18n.js --update` 只能用来收紧）。
6. **不等于"所有字符串都翻译"**：逻辑判断、数据库值、API 合同/字段名、解析标记（如 `### 第 N 行`）、
   文件路径、测试夹具**不是文案**，不要包 `tr()`、也不要进语言目录。

**AI / 开发者的收尾清单（每次改完代码）：**

```bash
npm run check:i18n     # 目录同步 / 语言包完整 / 占位符 / 英文残留中文 / 新增硬编码
npm run test:i18n      # 语言引擎 + AI 生成流程（假 AI，不花钱）
```
新增了文案却没跑 `build:lang` / 没补英文译文，这两条会直接报错——**不允许跳过**。
`node scripts/install-git-hooks.js` 可以装一个 pre-commit 钩子自动挡（可选）。
界面改动还要刷新页面用无头浏览器点一遍（`npm run test:i18n-ui`），`node --check` 证明不了运行时问题。

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
│   ├── prompts/page-context.js ★「AI 助手能读到当前页面」的提示词块（纯函数：清洗 + 限量 + 拼块，有 scripts/test-page-context.js）
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
├── ui/                ★ Vue UI 插件层：lab/ 验证页、sdk/ 宿主契约、plugins/builtin/ 内置 UI
│   └── （构建产物进 public/ui-dist/；用户插件在 DATA_DIR/ui-plugins/）
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
└── package.json       运行时无 dependencies；Vue/Vite 只在 devDependencies（构建 UI 用）
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

> ⚠️ **本机 3213 目前由 systemd 用户服务托管**（`systemctl --user status sierxing.service`，`Restart=always` + `RestartSec=3`）。重启请用 `systemctl --user restart sierxing.service`；直接 kill 会被 3 秒后自动拉起，于是 `ss` 会看到 `STILL_HELD`、手动 nohup 的新实例反而报「端口已被占用」——**那不是 kill 没生效**，别再反复 kill/起实例。判断新代码有没有生效看 `systemctl --user show sierxing.service -p ActiveEnterTimestamp` 与首页资源戳 `app.js?v=…`。

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

⚠️ **用 `timeout` 包住浏览器时，`kill` 的是 timeout，不是 msedge。** 给 timeout 发 SIGKILL 不会转发给子进程，浏览器照样变孤儿（2026-10-17 真实踩到：三份测试脚本各自留了一棵 msedge 进程树）。收尾必须**按 profile 杀整棵树**，并在脚本里放：

```js
finally {
  try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + profile], { stdio: 'ignore' }); } catch (e) {}
  try { edge.kill('SIGKILL'); } catch (e) {}       // 再收 timeout 包装器
  rmSync(profile, { recursive: true, force: true });
}
```

杀完要**当场验证**，别只看脚本退出码：`pgrep -af 'user-data-dir=<profile>'` 应为空、`ss -ltn | grep :<CDP端口>` 应无监听、profile 目录应已删除。发现漏网的再跑 `bash scripts/kill-test-browsers.sh`。

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

### 3.4 命令总线与 Agent 接入

- 命令注册/执行：server/commands/bus.js；命令实现：server/commands/index.js；审批页：server/approvals-page.js。
- 风险规则：read 直接执行；write 直接执行但写审计；destructive/admin 必须带用户批准的 approvalId（一次性、绑定命令与入参哈希、30 分钟过期）。
- HTTP：GET /api/commands、GET /api/commands/manifest、GET /api/manifest（增强版插件 manifest）、GET /api/commands/:name、POST /api/commands/run；
  GET /api/approvals/:id、GET /api/approvals/:id/page（用户审批页）、POST /api/approvals/:id/approve|reject；GET /api/audit。
- CLI：node scripts/sierxing.js ...（或 npm run cli），默认连 127.0.0.1:3213，可用 SIERXING_URL 覆盖；approve/reject 是用户动作，Agent 只轮询并转交 approveUrl。
- 本机表 approvals / command_audit / command_events 由 commands/index.js 幂等创建；故意不进 SYNC_TABLES（不跨设备同步）。
- commands 不 require server.js；db / getGoal / goalWithStats / nowISO 由 server.js 启动时注入，避免循环依赖。
- 语义洞察：server/insights.js（确定性规则，不调 AI、不写库）；命令 insight.list；brief.goal / brief.user / goal.list 已带 health / momentum / insights / nextAction。第一批信号：goal_health、stall、momentum、milestone、empty_goal；第二批：friction（friction_reports）、constraint_conflict（周可投入 × 期限 vs 剩余 hours）、goal_drift（goal_field_events 最近 14 天字段变更）。friction_reports / goal_field_events 都是本机表，不同步。
- 摩擦：friction.report/list/update（write/read）；表 friction_reports 由 commands/index.js 幂等创建，本机不同步；insights 查询时 try/catch 兼容没有表的旧库/单测。
- 提示词包：server/prompts/packs.js（静态包：资料提炼 + chat.ask_rules/chat.agent_rules） + chat-packs.js（对话静态规则块，从 buildChatPrompt 原样提取） + plan-packs.js（规划问卷/骨架） + sources-packs.js（搜集方案/书单/清洗） + tutorial-packs.js（教程生成） + tutorial-rules.js（篇幅/格式动态片段） + registry.js（本机覆盖/版本/校验/动态注册）；server.js 启动时创建 promptPacks、注册 6 个动态包并传给 commands（共 15 个可编辑包：原有 10 + 简历工坊 5）。
- 规划类提示词是异步的：registry 提供 renderAsync（有覆盖走模板，没覆盖 await builtinRender）和 hasOverride；server.js 只在 hasOverride 时组装模板上下文，没覆盖时仍直接调用原函数（行为/开销都不变）。
- prompt.* 命令：list/get/preview/history/validate 是 read；update/reset 是 admin（必须用户批准）；覆盖存 prompt_packs，历史存 prompt_pack_versions（本机，不进 SYNC_TABLES）。
- 删除：goal.delete / node.delete 是 destructive（审批后执行）；服务端 deleteGoalData() / deleteNodeData() 与 HTTP DELETE 路由共用，node 删除会先存版本快照。
- 资料/教程：tutorial.list/rename/delete、source.add/update/delete；写操作审计、delete destructive（审批）；资料变更后经注入的 onSourceChanged(goalId, action, sourceId) 重建检索索引（删除时 rag.dropSource）。
- **多方案（同一目标多份规划，2026-10-21，用户要求「agent 能直接在思而行里生成规划节点 + 一个目标下手动切换多份规划」）**：`goal_versions` 里 `manual=1` 的行 = 一份方案（快照 = 节点数组）；`nodes` 表永远是**当前方案**的实体，`goals.active_plan_id` 记它来自哪份方案（0 = 主方案）。领域在 `server/commands/plan-ops.js`（**故意放 commands/ 下**：这里的错误文案属 Agent/审批层，放 server/domains 会撞中文硬编码棘轮）；`server.js` 启动时 `createPlanDomain(...)` 并经 ctx 懒注入命令总线（commands 初始化早于 planDomain，所以传 `getPlanDomain` 函数）。命令：`plan.list`（read）、`plan.save`（把当前路径另存）/`plan.apply`（Agent 传 `stages[{title,goals:[{title,tasks:[…]}]}]` 写一份**新方案，不动当前**）/`plan.switch`/`plan.rename`（write）、`plan.delete`（destructive，不能删当前）。切换 = 先把当前节点存回当前方案（首次切走固化成「主方案」）→ `beginVersion` 自动快照 → 整棵替换 nodes（**保留 done/doing、父子关系、条件归属**）→ `backup()`。HTTP：`GET/POST /api/goals/:id/plans`、`POST /api/plans/:id/activate|rename`、`DELETE /api/plans/:id`。UI：路线图页工具栏「🗂 方案」（`public/app.js` 的 planPop* 一套）。⚠️ **路线图插件不在 `scripts/build-page-plugin.js` 的 PAGES 里**（旧版生成器产物、现在手维护）：改路线图必须**同时**改 `public/app.js` 与 `ui/plugins/builtin/roadmap/index.js` 两处，`build:pages` 不会重建它。**按方案分开的版本历史（2026-10-21 同轮追加，用户要求「不同方案的版本历史应该分别管理」+「像 git 一样把某个历史版本单独建成一版方案」+「手动创建一版空白方案」）**：`goal_versions.plan_id` 记这份自动快照属于哪份方案（0 = 主方案；`manual=1` 的方案行本身不算历史），`beginVersion` 自动带上当前 `active_plan_id`，`GET /api/goals/:id/versions?planId=` 只回该方案的历史；升级旧库时在加列那一步做一次性回填（把旧共用历史归到目标当前方案）。新增命令 `plan.create`（新建空白方案，0 节点，不切换）/ `plan.from_version`（把某个版本 id 的快照复制成一份新方案，类似 git 从 commit 建分支，不动当前路径），均 write；`plan.save` 仍负责「把当前路径另存成新方案」。HTTP 追加 `POST /api/versions/:id/to-plan`；`POST /api/versions/:id/restore` 改为 `planDomain.restoreVersion`（会先把当前存回当前方案，再把 active_plan_id 切到该版本所属方案）。`POST /api/goals/:id/plans {blank:true}` 建空白方案；切到空白方案允许 0 节点（`restoreSnapshot(...,{allowEmpty:true})`，目标 status 回 draft）。AI 助手新增对话 ops `plan_create` / `plan_switch` / `plan_save` / `plan_list`（提示词在 `language/prompts/zh-CN/packs.json` 的 `chat.agent_rules`；`buildChatPrompt` 用 `planDomain.chatBlock` 带【这个目标的规划方案】清单，助手才知道有哪些方案、当前用哪份），用户说「再规划一版 / 切到 19 天版」时不再 delete 当前节点。UI：版本管理页（`#/g/:id/versions`，`public/app.js` renderVersionsPage + `ui/plugins/builtin/versions/index.js` 生成物）按方案分开显示历史、页头有当前方案与「切换到…」按钮、「＋ 新建空白方案」；每条历史都有「＋ 存成方案」；🗂 方案弹层加「＋ 新建空白方案」；空白方案下路线图空状态仍保留「🗂 方案」入口（否则切过去回不来）。回归：`node --no-warnings scripts/test-plan-domain.js`（27 项，纯内存库：列表/存当前/写树/切换保留进度/空白方案/版本按方案隔离/版本建方案/恢复版本/chatBlock 方案清单/改名/删除保护）。

- **⚠️ 切方案 = 整棵 nodes 重建，节点 id 全换 → 「按 node_id 挂」的数据必须搬家（2026-10-22 用户投诉「加完多方案功能后，原来目标下的教程全没了」的根因与修复）**：
  换树的三条路径都是「DELETE 整棵 nodes → 按快照重插」（id 自增、全部换新）：`plan-ops.js` 的 `restoreSnapshot`（切方案 / 恢复历史版本都走它）、`server.js` 的 `saveSkeleton`（重新规划 / 按意见调整骨架）。
  而 **`tutorials.node_id`、`tutorial_progress.node_id`、`tutorial_bookmarks.node_id`、`node_notes.node_id`、`study_records/study_segments.node_id`、`quiz_sessions/explain_sessions/restate_rounds/chat_sessions.node_id`、`task_runs.node_id`、`node_workspaces.node_id`** 全都指向节点 id —— 不搬就全成孤儿：数据还在库里、正文一个字没少，但**任何页面都看不到**（节点面板按 node_id 列教程、教程页 `node ? …` 静默为空）。
  修复：`server/node-identity.js`（`createNodeIdentity`，注入 planDomain 的 `repair` 钩子）：
  1. `begin(gid, index)` 在删旧树前记下「节点 id → 标题路径（阶段 / 小目标 / 任务）」+ 代码目录档案；
  2. 重插后 `rebind(gid, nodeRows)` 先按快照里的**旧 id → 新 id 精确映射**搬，映不到的（教程指向更早的树）用**标题路径**从 `goal_versions` 历史快照并集里认回来；
  3. `applyWorkspace` 让新节点**沿用旧代码目录**（目录稳定，不搬家、不新建 `(2)(3)` 垃圾目录）；`end()` 清掉换树建出来的空壳目录、以及「不指向存活节点、也不属于任何历史快照」的孤儿档案行。
  ⚠️ **`restoreSnapshot` 里不许再 `DELETE FROM node_workspaces WHERE goal_id = ?`** —— 那些行是每份方案各自的目录档案（key = 该方案快照里的节点 id），删了旧目录就再也认不回来；统一由 `end()` 清理。
  ⚠️ 认不回的只报数、绝不删数据（那批节点是更早被用户手动删掉的，教程正文仍完整）。
  回归：`npm run test:plan-identity`（`test-plan-domain` 27 项 + `test-plan-identity` 19 项：切走再切回后教程/笔记/学习记录/阅读进度/代码目录全部挂回新节点、正文不变、目录不搬、无空壳目录、恢复版本同样保住）。
  存量数据修复：`node scripts/repair-plan-switch.js <db> --goal 166 [--switch-plan 350] [--apply] [--clean-empty-dirs]`（默认 dry-run 在副本上模拟；要切方案时也写副本，原库不动；`--apply` 才落库并自动备份 db）。原理同上，救已经断掉的老数据。
- 长任务入口：tutorial.generate 通过注入的 startTutorialGeneration（复用 streamTutorial + 假 res，不挂 SSE）后台启动；tutorial.edit 通过 startTutorialEdit 调本机现有修改接口（结构守卫/版本快照不复制）；source.collect 通过 startSourceCollect 复用 streamCollect + 假 res；source.digest 通过 startSourceDigest 复用 streamDigest（已包 tasks.begin）+ 假 res；plan.generate 通过 startGoalPlan 复用 streamPlan（已包 tasks.begin）+ 假 res。五者都立即返回 taskId，进度在任务中心；规划问卷分支会把 questions 写进任务结果。
- 组件：component.list/describe（read）、component.toggle（write，核心 scope=core 不可关，主题互斥）；元数据来自 allComponents()/setComponent()。
- 组件自改：component.export/validate（read）、component.stage（write，只写本机 component_staging）、component.install（admin，失败自动回滚旧文件）、component.uninstall（destructive）；server/component-pipeline.js 纯校验，server/component-preview-page.js 预览页，HTTP /api/component-staging/:id/preview；只支持 file 插件，core/base 内置不走此路；组件 JS 在进程内运行，必须用户批准。
- **简历工坊（resume 扩展组件，2026-10-22，用户要求「参考 4 个开源项目做成帮助写简历/优化简历的 AI 组件」+「一步步、每次只专注一个操作、Agent 也能调用」）**：领域 `server/resume-domain.js`（`createResumeDomain`，组件 API 与命令总线**共用**），服务端组件 `server/plugins/resume.js`，前端 `public/plugins/resume.js` + `resume.css`；文件解析/生成 `server/plugins/lib/resume-file.js`（零依赖：读 .docx/.pdf/.txt/.md，写最小 OOXML .docx）。**六步流水线**（进度落 `resume_docs.stage`，刷新/换设备/换 Agent 都接得上）：`upload`（拖文件或粘正文）→ `review`（AI 审查出问题清单，不改简历）→ `supplement`（AI 追问 → 回答 → 自动整理成证据卡入库）→ `jd`（**直接从目标资料库选 JD**，不用重贴）→ `match`（要求-证据矩阵 + 缺口）→ `finalize`（改写+排版成终版 → 导出 .docx）。UI 入口：目标页 / 路线图页顶栏「📄 简历」按钮（`goalCompOn(g,'resume')` 门控）调 `SiErXing.openResumeWorkshop()`；**已撤掉右下角浮窗**（用户要求按钮放到功能栏）；`?resume=1` 或 `#/resume` 仍可深链直接打开。数据表 `resume_docs/resume_evidence/resume_versions/resume_reports`（本机 SQLite，删文档级联、`onGoalDelete` 清目标级数据；老库的 `stage/source_file/issues/answers/jd_text/jd_source_id/match_json/final_md` 列由领域层 ALTER 补）。HTTP 前缀 `/api/resume/*`（`docs` / `pipeline` / `upload` / `jd` / `ai` / `evidence` / `versions` / `reports` / `export`）；错误只回 code（`need_title/need_file/unsupported_format/no_text_layer/need_resume/need_jd/need_answers/need_final/ai_failed`），文案前端 `tr()`。**Agent 命令（MCP 同名下划线）**：`resume.docs`(read) / `resume.create` / `resume.upload`（接收 base64 简历文件）/ `resume.review` / `resume.questions` / `resume.answer` / `resume.jd`（不传参=列出资料库 JD）/ `resume.match` / `resume.finalize` / `resume.audit` / `resume.get`(read) / `resume.export`(read，回 base64 docx)；`commands/index.js` 通过 `ctx.getResumeDomain()` 拿领域（`server.js` 里 `resumeDomain` 在 `reloadPlugins` 之后创建，所以 `pluginCtx()`/commandBus 都传惰性 getter）。提示词 8 个包：`resume.review/questions/answers/match/rewrite/finalize/audit/evidence`（正文在 `language/prompts/zh-CN/packs.json`，packs.js 里 `fill` 渲染，可被用户覆盖）。⚠️ 服务端组件不写中文界面文案（i18n 棘轮）：组件元数据放 `language/plugin-meta.js`、提示词标签放 `language/resume-labels.js`。**参考的 4 个开源项目**（用户给的四个链接，含一个重复项）：https://github.com/Elowwwen/resume-evidence-workflow 、https://github.com/zclllyybb/lofisu-identity-engine 、https://github.com/Claycui828/ASu-resume-skills 、https://github.com/Elowwwen/resume-evidence-workflow（= 第一个，重复引用）；设计文档 `docs/resume-component.md`；回归 `npm run test:resume`（38 项，AI 走 `SIERXING_RESUME_FAKE=1` 假实现，不花钱；含 docx 往返、pipeline、Agent 命令全链路）。
- 设置：setting.list/get（read）、setting.set（admin，审批）；只暴露 SAFE_SETTINGS 白名单（备份/搜集/清洗/检索/AI 模型/讲解风格），AI key / sync token 永不进白名单。
- **信息源检索的搜索 API（2026-10-20）**：搜集资料默认用内置搜索（百度 + 必应抓取）；用户可在「设置 → 信息源检索」显式指定外部搜索 API（`search_provider` = `builtin`/`deepseek`/`custom`，`server/search-api.js`）。规则：**指定了优先用，没指定或调用失败自动回落内置**（进度与结果里标注回落，不阻断搜集）。DeepSeek 端点 `POST {base}/v1/tools/search`（默认 `https://api.deepseek.com`），`need_content:true` 带回来的正文会在页面抓取失败时兜底、并优先用于高分资料的全文（省一次抓取）；自定义接口支持完整 URL 与 DeepSeek 兼容的请求/响应（`results`/`data`/`items`/`organic_results`/裸数组都能归一化）。密钥 `search_api_key` 与 AI 接入密钥分开存、**永不进 SAFE_SETTINGS**（Agent 只能改 provider/地址/条数/正文开关）；`DEEPSEEK_API_KEY` / `SIERXING_SEARCH_API_KEY` 可当环境变量兜底。⚠️ `server/search-api.js` **不写用户可见中文**：错误只回 `code/detail`，进度用 `status_code`，文案全部由前端 `tr()` 组装（否则 i18n 硬编码预算会红）。设置页回归 `npm run test:search`（35 项，假 HTTP 服务，不联网）。
- **对话 ops 数量策略（2026-10-20）**：单轮 ops **不再一刀切 20 条**（用户反馈：保留 22 张截图、其余资料删掉，助手却按「单次最多 20 个操作」拆成多轮、还要用户回「继续」）。现在：服务端 `parseChatOutput` / `applyChatOps` 共用 `CHAT_OPS_SAFETY_MAX = 500`，只做异常巨大数组的兜底（原来两处 `slice(0, 25)` 会**静默吞掉**后面的 ops）；提示词 `chat.agent_rules`（`language/prompts/zh-CN/packs.json`）只对「重」操作要求分轮 —— `add` 单轮 ≤30、`add_source` 单轮 ≤10，**删除类（delete / delete_source / condition_delete）不设上限**，并明确禁止模型自己把操作拆成多轮。`packs.js` 的 `mustInclude` 改钉 `删除类操作` / `不设上限`（用户改提示词时也不许把这条改没）。回归 `npm run test:chat-ops`（11 项：假 AI 一轮吐 40 个 delete_source + 30 个 add，验全部落库、提示词无 20 条限制）；`test-prompt-packs` 也加了这条策略断言。
 补充（同日第二轮用户反馈：助手只删了 7 条、还让用户「把剩下的标题发我几条」）：chat 提示词的资料库清单只列了网络资料**前 20 条标题**，模型看不到其余条目；而 `delete_source` 以前一条只能删 1 条，模型以为「按站点名」能批量删、实际正好等于 op 条数。现在：① `chatSourcesBlock` 追加 `promptContext.chatNetSiteSummaryFrom(net)`（`server/prompts/context.js`，提示词中文放 prompts/ 以免抬高硬编码预算）输出**全部站点分布**与批量用法；② `delete_source` 支持 `{ids:[…]}`（≤500）、`{site:"CSDN"}` / `{sites:[…]}`（删该站点全部）、`{except_sites:[…]}`（"除了这些全删"，一条 op 清空其余网络资料）；批量形式**永远不碰** `OWN_SOURCE_SITES`（用户提供的图片/电子书、导入的资料/代码库），要删只能 ids/site 显式点名；删除同时清理 `code_repo_files` 与 `rag.dropSource`。`npm run test:chat-ops` 扩到 **20 项**（40 条单删 + 30 个 add + site 批量 + except 反向筛选不误删截图 + ids 点名）。
- MCP：scripts/sierxing-mcp.js（stdio JSON-RPC，零依赖）；工具名点号→下划线（goal.create → goal_create）；admin 首次返回 approval_required；stdout 只走协议，调试走 stderr（SIERXING_MCP_DEBUG=1）。
- 多宿主 skill：scripts/install-skills.js（claude / cursor / generic）+ mcp-config；配置说明在 docs/agent-plugin/mcp.md。回归：node scripts/test-mcp.js（需服务在跑）、node scripts/test-skills-install.js。
- **app.open（2026-10-19）**：让宿主 Agent 在用户本机浏览器打开思而行，可带 `route`（`#/g/12`、`#/t/3`、`#/settings`；留空=首页），MCP 工具名 `app_open`，risk=write（写审计）。实现在 `server/commands/index.js` → 注入的 `openApp` → `service.openBrowser(route)`（`server/service.js`）：服务端从 systemd 用户服务起来时没有 DISPLAY，靠 `server/gui-env.js` 的 `guiEnv()` 补 X11/Wayland 环境；测试实例 `NO_OPEN=1` 时**只返回** `{ok:false, reason:'NO_OPEN', url}`、不弹窗（回归依赖这条）。路由只收 `/` 或 `#` 开头、无空白、≤300 字（防 `javascript:` 之类）。
- **宿主 Agent 自动接入（2026-10-19）**：思而行作为某 Agent 插件时，宿主往 `DATA_DIR/host-agent.json`（或 `SIERXING_HOST_AGENT_*` 环境变量）写 `{name,url,key?,models,vision?}`，启动时 `ai.mountHostAgent()` 自动登记成服务商 `host` + 连接 `host-agent`（普通 api 连接，模型进 `modelPool` 直接可选；**默认只勾第一个**，之后刷新保留用户已挑的模型、新模型不自动勾——一次给几百个全选会被投诉）；`POST /api/host-agent/refresh` 可免重启刷新，`GET /api/host-agent` 看状态。重复刷新只更新不重复；用户手动关掉的不强行打开；缺 url 或 models 视为没接。**边界**：MCP 是宿主→思而行单向，思而行要用这些模型，宿主必须真提供 OpenAI 兼容 `/chat/completions`（本地网关），只登记列表不提供执行会报连接错误，别用假地址。配置文件被删/插件卸载后 refresh 会撤掉自动创建的 host 服务商与连接（不碰用户连接）。文档 `docs/agent-plugin/host-agent.md`，回归 `node scripts/test-host-agent.js`（10 项）。
- **DSH 桥适配器（2026-10-19）**：`integrations/dsh-bridge/` 是 host 侧参考实现（ESM，独立包 `sierxing-dsh-bridge`，peer 依赖 `@deepseek-ai/dsh-llm`/`dsh-host-webserver` 0.2.0-rc.2 + cordis）：注入 `ctx.llm`/`ctx.webServer`，在 DSH webServer 注册 `/sierxing/v1/models` 与 `/sierxing/v1/chat/completions`（随机 Bearer token、仅回环、支持 stream SSE），模型调用走 `ctx.llm.stream()`；启动写 `DATA_DIR/host-agent.json` + POST refresh，dispose 删文件并撤连接。安装（2026-10-20 已在 web profile 实测）：profile `cordis.patch.yml` 末尾加 `- insert: [{name: <绝对路径>/lib/index.js, config: {sierxingAppDir, sierxingUrl}}]` —— `name` 写绝对路径会被转成 file URL，且 `dsh-hmr` 监听 patch 文件，**保存即热加载、不用重启 DSH**；也可 `dsh plugin --profile web add <目录>` 装进 profile 后写裸包名。实测热加载约 1 秒、进程不重启，DSH 的 204 个模型进思而行，`/api/ai/test` 真实调用返回正常。 配套（2026-10-20）：同一 `cordis.patch.yml` 里再加一条 `@deepseek-ai/dsh-mcp-client`（stdio → `scripts/sierxing-mcp.js`，env `SIERXING_URL`），DSH Agent 在**任意工作区**都有 54 个 `mcp__sierxing__*` 工具读写思而行数据；读数据走 MCP/HTTP，不直接读 DATA_DIR/sqlite。`autoStart:true` 时桥先探活，没跑就 `systemctl --user start sierxing.service`（DSH web 进程环境没有 DBUS 变量，插件显式补 `/run/user/<uid>/bus`），没有 systemd 才兜底 spawn。插件/服务都是 profile 级 + 绝对路径，切换 workspace 不受影响。 回归 `npm run test:dsh-bridge`（8 项，假 ctx+假 llm+真 http server，不需要 DSH 运行时）。
- 多形态打包：GET /api/manifest 返回 schema sierxing.plugin/1 + commands/prompts/components/surfaces/capabilities；node scripts/build-plugin.js（npm run build:plugin）生成 manifest.json + mcp/ + skills/ + mcp.json + README；回归 node --no-warnings scripts/test-plugin-package.js。
- 提示词：server/prompts/context.js、digest.js、page-context.js 是纯函数；server.js 只留取数据的薄适配层。新增提示词优先放 server/prompts/ 或 server/features/<id>/prompts.js，不要再塞回 server.js。
- **AI 助手是「唯一的一套 AI 问答」**（2026-10-18 用户定调：一百个组件各实现一套 AI 问答，效果一定参差不齐）。组件**不要**再自己写「问 AI」输入框 + 自己的提示词：
  * 前端：`public/app.js` 的 `aiSyncRoute()` 在每个"有目标上下文"的页面渲染完后摆出入口（悬浮 💬 + 右侧抽屉），抽屉跨页保持；路由 → 目标用 `aiResolveRouteGoal()` 解析（`#/g/<gid>/…` 直接认；`#/t/<tid>/…` 查一次教程的 goal_id 并缓存）。
  * 上下文：发消息时 `collectPageContext()` 抓当前页面的文字（剔掉工具栏/页头，`innerText` 靠临时离屏容器量，别对游离节点读 innerText），随 `page_context` 发给服务端；`server/prompts/page-context.js` 清洗 + 9000 字预算（掐中间留头尾）后拼成【用户当前正在看的页面】，并在「它做了什么」里记一条「你当前页面上的内容」。教程页不重复带（正文已由教程块带上）。
  * 新组件只要保证**渲染出来的 DOM 就是内容**（题目/选项/代码/列表都正常渲染），AI 就能读到，不用再接任何东西。随堂测验原来的 `POST /api/quiz-session/:id/chat` 与界面追问框已按此删除（旧 `quiz_records.kind='chat'` 记录留在库里、不再显示）。
- 领域拆分：server/domains/backups.js（createBackupDomain 注入 dbPath/backupDir/getSetting/nowStamp/onDataChange；backup/backupList/pruneBackups/backupDiff）+ server/domains/versions.js（createVersionDomain 注入 db/nowISO/safeParse/goalCompOn/aiText/currentModel；beginVersion/diffVersions/templateReport/buildReportPrompt/finishVersion）+ server/domains/goals.js（createGoalDomain 注入 db；orderedLeaves/goalWithStats/getGoal/roadmapOutline）+ server/domains/sources.js（createSourceDomain 注入 db/cleanText/nowISO；sourcesOf/digestsOf/digestBatches/buildLibraryMarkdown）；server.js 只做组装，回归 test-backup-domain / test-versions-domain / test-goals-domain / test-sources-domain。
  - ⚠️ goal domain 必须在插件加载（reloadPlugins → pluginCtx 引用 getGoal）之前初始化；当前放在 const PLUGIN_DIR 之前，否则启动时报 Cannot access 'getGoal' before initialization。
- **达成条件（目标推进进度）组件**（2026-10-19）：
  - 领域 `server/conditions.js`：`goal_conditions`（含 `jd_ref` = 对应 JD 原文/条款）+ `nodes.condition_id`（0=未归属，继承父节点）；API saveFromPlan/list/assign/saveManual/remove/generateFromNodes；server.js 在 `reloadPlugins()` 前建域，`pluginCtx()` 注入。
  - 条件 ≠ 阶段，且**必须是 JD 岗位要求**（禁止拿项目/节点名当条件，按 JD 维度去重；求职类 8-12 条最多 14，非求职写具体依据）；生成超长会二次重试、像节点名会给 warning。四套提示词 + `buildPrompt` 都要求 `jd` 字段；`saveFromPlan` **只删 `source='plan'`**。
  - 组件：`server/plugins/conditions.js`（`scope:'base'`、`builtin:true`、默认开）+ `public/plugins/conditions.js/.css`，页 `#/g/:id/conditions`。列表默认全收起，「详情」展开说明 + **对应 JD** + 达成标准 + 节点；有全部展开/收起、调归属、「💬 让 AI 调整条件」。
  - **AI 改条件 + 「🎯 只改」范围**：`buildChatPrompt` 带【当前达成条件】(id/优先级/JD/达成标准)+未归属节点；ops `condition_add/update/delete/assign/unassign/condition_replace`（整批换 JD 条件）。对话栏上方「只改」→ `edit_scope`：`chatScopePromptBlock` 进提示词 + `chatScopeFilterOps` **服务端硬拦**越界 op 并告知用户。前端用 SDK 的 `aiToggleLegacy/aiBindGoal/aiModeSet/aiScopeSet`；`aiSendText` finally 只重画 goal/map/library，**插件页要单独加 conditions 分支**。
  - 进度按末端节点；导出/导入/分享都带条件。⚠️ `H.loadGoal(gid)` 无返回值，要 `await H.loadGoal(gid); goal = H.state.goal`。
  - 回归：`test-conditions-{domain,ui}.js`、`test-chat-conditions.js`（含 edit_scope 硬拦）、`test-conditions-chat-ui.js`（含只改范围 + JD 显示）。
- UI 插件化（**进行中 · 已覆盖全部自研页面**）：
  - **默认界面 = 插件界面**。每个页面在 `ui/plugins/builtin/<page>/` 下（`index.js` + `manifest.json`，可选 `style.css`），宿主 `public/app.js` 的 `renderPagePlugin(page, extra)` 负责注入依赖并渲染；失败**静默回退**原版 `render*`（保证任何情况都能显示）。
  - **已插件化页面**（全部 11 个自研页 + 引导层）：`home` `#/`、`guide` `#/guide/:step`（= 首页 + 蒙层，两段都走插件）、`settings` `#/settings`（含 ai/data/sync/rag/service/update/system/theme 全部子页）、`components` `#/components`、`library` `#/library`、`aitasks` `#/aitasks`、`versions` `#/g/:id/versions`、`diff` `#/g/:id/diff/:vid`、`roadmap` `#/g/:id/map`（⚠️ 手维护，不在 PAGES 里，改它要同时改 app.js 与插件）、`tutorial` `#/t/:id`、`goal` `#/g/:id`（`chat` `#/g/:id/chat` 复用 goal 插件 + AI 抽屉）。
  - `r.view === 'plugin'` 的页面（学习统计 / 今日任务 / 随堂测验 / 看懂代码 / 刷题 / 产出库 …）本来就走 `public/plugins/*.js` 组件体系，不在这套页面插件里。
- **页面插件怎么生成**：不要手抄原版代码。`node scripts/build-page-plugin.js --all` 会从 `public/app.js` 按**依赖闭包**提取原版实现（根函数 → 递归收集它引用的顶层声明），只把「跨页渲染器 / 路由 / Vue 旧实现 / AI / 主题 / md / tut / sxi / task」这类全局基建留给 host 注入，其余逐字搬进插件 —— 所以 DOM 结构与原版完全一致。
  - 加/改一个页面：先在 `build-page-plugin.js` 的 `PAGES` 里写 `{ roots: ['renderXxx'], render: 'renderXxx()' }`，再 `--all` 重建；**改渲染逻辑仍改 app.js**，插件是生成物，别直接改。
  - `public/app.js` 里 `sxPageHostMap()`（由 `scripts/gen-host-map.js` 生成）暴露全部顶层声明给插件；`let/var` 用 getter/setter（设置页会写 `AI_PROVIDERS`/`AI_AGENTS`，插件里 `H.AI_PROVIDERS = x` 要能真正写回全局）。
  - ⚠️ 三个已经踩过的坑：① 索引**不能按行首正则**扫（模板字符串里的示例代码 `const card = ...` 会被当成真声明 → host 表里多一个不存在的名字 → 每次插件渲染 `ReferenceError: card is not defined`），必须用字面扫描（跳过字符串/注释/正则 + 括号深度）；② 改写外部依赖**只改调用位置 `name(` 与属性位置 `name.`/`name[`**（裸名字全替换会把参数 `state` 改成 `H.state`、把函数声明名改成 `function H.xxx`）；③ 插件 `render()` 必须 `return` Promise，宿主必须 `await`（否则页面收尾 `sxiSelify` 跑在内容画出之前）。
  - **内核 / 服务化 / 用户插件（P0–P3，已落地）**：`server/kernel.js`（provide/get/effect/plugin/loadPlugins/dispose/迁移/状态）、`server/kernel-services.js`（25 个服务）、`server/kernel-config.js`（分层配置 builtin < profile < user）。契约文档 `docs/ui-plugin/kernel-contract.md`；实时状态 `GET /api/kernel`（服务清单 + 插件 loaded/skipped/failed + 配置来源/告警/升级差异）。**P4（内核瘦身）不做**：server.js / app.js 仍是单体，内核只是容器 + 启动器。
  - **用户页面插件**：`DATA_DIR/ui-plugins/<page>/`（manifest 含 apiVersion/entry/format/standalone；id 必须等于目录名）。三种入口：ESM Vue 组件 / ESM `mount(root, ctx)` / 经典 `SXUIPlugin[page]`；Vue 必须从 `window.SiErXingUI.vue` 取，宿主桥 `/ui-dist/uihost.js` 按需加载（改 ui/sdk 后要 `npx vite build`）；实例在离开路由时自动卸载；任何异常静默回退内置页面。管理页 `#/ui-plugins`（显示名「🧱 界面管理」，服务端 `server/plugins/uimanager.js` + 前端 `public/plugins/uimanager.js`；**id 仍是 `uimanager`、路由仍是 `#/ui-plugins`，别跟着显示名改**，否则旧链接/设置/测试全断）。它是 `scope:'core'` 核心组件：用户关不掉（这是装坏插件后唯一的恢复入口）。
  - **分层配置**：`config/kernel.schema.json`（默认值）+ `DATA_DIR/config/profile.json` / `user.json`。只写要改的键；写 null 恢复默认；未知键/类型错只告警不阻断；`ui.pagePlugins` / `ui.userPlugins` / `ui.skins` 是前端总开关；升级差异存 `DATA_DIR/kernel/builtin-snapshot.json`；CLI `node scripts/kernel-config.js --dump|--diff|--explain|--init`。
  - **新验收**：`npm run test:kernel`（22 项）、`npm run test:kernel-config`（16 项）、`node scripts/test-user-vue-page.js`（23 项，用户 Vue/mount/停用回退/管理页）、`node scripts/test-kernel-live.js`（16 项，配置总开关/皮肤/快照/二次启动）。用户插件不参与像素回归。
  - **界面管理 = 核心组件**：`npm run test:core`（10 项）钉住：左栏「🧱 界面管理」对应的 `uimanager` 是 `scope:'core'`（归「核心组件」、removable=false），全局/目标级开关接口都拒绝关闭它；显示名可从「界面插件」改成「界面管理」，但 **id `uimanager` 与路由 `#/ui-plugins` 不许动**（旧链接/设置/测试都靠它）。
  - **创造模式（仿 DSH Creator，已落地）**：AI 助手第三种模式 `create`（`AI_MODES` 加一条即可；服务端 `mode:'create'`）。`server/create-mode.js` 负责：解析 create 围栏块 → 静态校验（页面白名单 / 三种插件契约 / 禁网络·子进程·eval / `node --check` / 体积上限）→ 暂存 `DATA_DIR/agent-changes/<id>/`；**用户点卡片按钮才安装**（`POST /api/create/changes/:id/install` 必须 `confirm:true`），装前快照旧版本、失败自动回滚、成功后「撤销安装」可恢复。产物落点：ui-page / skin → `DATA_DIR/ui-plugins/<id>/`；component → `DATA_DIR/plugins/<id>.js` + `DATA_DIR/plugins-client/<id>.{js,css}`（loader 第二目录 + `serveStatic` 对 `/plugins/*` 兜底；同名时用户版本优先）。
    - **上下文必须给全（用户真实投诉：「创造模式拿不到全局代码，感觉没法随意改」）**：`buildCreateChatPrompt` 除扩展点说明书外，还塞①最近对话（会话最近 24 条，8000 字预算）；②命中的组件**完整源码**（路由插件 id / 上次创造产物 / 文本里点名的组件 / 最多 3 个用户组件，用户版本优先，单文件 60KB、总量 140KB）；③被改页面的现有实现（`DATA_DIR/ui-plugins` 或 `ui/plugins/builtin`，超 70KB 就改成「体积过大」说明，别硬塞）；④当前页面 DOM 骨架（前端 `collectPageContext` 在 create 模式抓的 `dom`，服务端限 16000 字符）；⑤组件清单（id/名字/内置或用户/分类/开关）。**提示词正文一律放 `language/prompts/zh-CN/packs.json` 的 `create.*` 模板**（`template()` + `{{占位符}}`），不要写回 server.js —— 否则 i18n 硬编码预算（棘轮）会红。
    - **同 id 覆盖语义**：非核心内置功能组件（`restate` 等文件组件）允许同 id 覆盖：装到 `DATA_DIR`，`reloadPlugins` 里用户版本 `builtin:false` 盖住内置版，撤销时只删数据目录文件 → 内置版自动回来。**核心/基础组件**（`BUILTIN_COMPONENTS` + 插件声明的 `scope=core/base`，如 `conditions`）不能覆盖 id，要给它们加功能请起新 id。⚠️ 别删程序目录文件：`uninstallComponentBundle` 只删用户文件，`exportComponentBundle` 读用户版本优先；`hasUserComponent` 决定装前是否快照（覆盖内置组件前没有旧文件，撤销就该删覆盖层而不是把内置源码写进数据目录）。
    - **卡片状态与刷新**：create 信息随 `chats.trace` 的 `kind:'create'` 步骤落库；刷新/重开对话后前端 `chatCreateSync()` 用 `GET /api/create/changes/:id/status`（`staged/installed/rolled_back/discarded/missing`，记录被清理也回 200）校正卡片，已安装的不会再显示「已生成」。`discard` 对已安装的返回 409（否则丢掉撤销入口）。「刷新查看」**只有 ui-page 跳路由，组件/皮肤原地刷新**（组件 card 的 route 是空串；以前写死 `#/components`，改完当前组件一刷新就被弹去组件管理页）。
    - ⚠️ 别再让 AI 直接写 `server/plugins`/`public/plugins`：用户组件必须进数据目录，否则升级覆盖。**改现有组件可以只交改动的文件**（只动前端就只给 `client.js`，其余从线上版本继承），新组件才必须 `server.js` + `client.js` 都齐全；create 块 JSON 解析带容错（字符串内裸换行 / 结尾多逗号 / 围栏里再出现 ```` ``` ```` 都能修），提示词也要求字符串内换行写 `\n`、正文别贴整段代码。回归：`npm run test:create`（27 项纯函数+HTTP e2e + 24 项假 AI 前端闭环，不花钱）；文档 `docs/creation-mode.md`。
- **左栏功能按钮可拖动排序**（用户 2026-10-19 要求）：`public/app.js` 的 `railOrderLoad/Save/Apply` + `railBindDnD`，顺序存本机 `localStorage.sierxing-rail-order-v1`（显示偏好、不做多端同步；新加的按钮追加在末尾，不冲乱用户版式）。拖动用 pointer 事件：>5px 才算拖（否则当点击）；**松手后的 click 必须拦掉**（`railJustDragged`），否则拖完会误跳页面；`renderRail()` 在 `railDrag` 期间直接 return —— 轮询/路由重画会把手里拖着的元素换掉，手势就断了。底部「主题」和左上 logo 不参与排序。回归：`npm run test:rail`（路线图按钮 10 项 + 拖动排序 13 项；两个脚本同跑默认抢 3329/9804 端口，和别的回归并发时给 `APP_PORT`/`CDP_PORT` 各换一套）。
- **验收（发布前必须全绿）**：
  - `npm run test:mount` —— 断言每页确实**由插件接管**（`window.__sxPluginUsed[page] === true`）。没有这条就验不出插件化：插件抛错时路由静默回退原版，像素对比两边都是原版、照样全绿。（当前 13/13）
  - `npm run test:parity` —— 逐路由像素一致性（21 条路由，`?ui=legacy` 对照，带 `-fuzz`）。（当前 21/21）
  - `node scripts/test-plugin-func.js` —— 只读交互冒烟（节点折叠、设置子页切换、筛选、教程目录、路线图展开）。
  - `npm run test:ui` —— 既有 UI 单测（204 项）。
  - `npm run test:dom` —— **DOM 结构骨架对比**（插件版 vs `?ui=legacy`，逐元素比标签 + class + data-* 属性名，12 条路由）。（当前 12/12）
    像素一致看不出「属性名被改坏」：`data-go=` 变成 `data-H.go=` 时外观分毫不变，但事件委托全部失配、控件点不动。
  - `npm run test:audit` —— **控件级功能审计**：逐页逐控件真点，捕获 JS 异常并判断有无反应（弹层/抽屉/toast/状态变化都算）。（当前 13 条路由 / 105 点 / 0 异常）
    危险控件（删除/清空/更新/生成/导入/保存/分享…）默认跳过，原生 confirm 自动拒绝，不写库。
  - 回退开关：`?ui=legacy` 或 `localStorage.sierxing-ui-<page>=legacy`。用户插件放 `DATA_DIR/ui-plugins/<id>/` 可整页覆盖内置。
  - ⚠️ 插件**不要复制全局 style.css 的规则**（加载顺序会覆盖原值、像素差反而变大），只放全局没有的样式；`mapFit()` 要在 rAF 里等布局稳定。测试沙箱可用 `SIERXING_DATA_DIR=/tmp/...`。详见 docs/ui-plugin/README.md。
- **首页目标桌面（最近目标 / 收藏夹 / 三档大小 / 拖拽排序）**：`renderHome` 不再平铺 `.goalCard`，而是渲染顶部「最近目标」栏 + `所有目标` 桌面（`.homeDeskGrid` 里的 `.homeTile`，手机桌面式）。实现全在 `public/app.js` 的 `homeLauncher*` 一段，改完必须 `node scripts/build-page-plugin.js home` 重建 `ui/plugins/builtin/home/index.js`（生成器会按闭包把这一整段搬进插件；`homeRecentTouch` 只被 `route()` 用，不会进插件）。
  - 布局模型 `{items:[{type:'goal',id,size} | {type:'folder',id,name,size,goals:[id]}]}`，**只存本机 `localStorage`**（键 `sierxing-home-layout-v1`，属显示偏好、跟 `sierxing-*-bar` 同类，不做多端同步）。每次渲染 `homeLauncherLoad(goals)` 都跟当前目标列表**对账**：删掉已删除的目标、只剩 1 个目标的收藏夹自动摊平、**新目标一律追加到末尾**（顺序完全由用户拖动决定，绝不能把新目标插到最前面冲乱用户排好的版式）。
  - 「最近目标」栏：`homeRecentTouch(gid)` 在 `route()` 里对 `goal / map / chat / versions / diff` 路由记一笔（本机 `sierxing-home-recent-v1`，最多 12 条、前台展示 8 条、去重后最近在前）；`homeLauncherRecentHTML()` 只展示当前还存在且非空的目标，没有任何记录时整块不渲染。这是「最近**使用**」（打开过），不是「最近更新」，别拿 `updated_at` 排序来替代。
  - 桌面交互：`pointerdown` 后鼠标（`pointerType==='mouse'`）**一动（>5px）就拖**，触摸/笔先 **300ms 长按**（否则会和页面滚动抢手势；移动 >10px 放弃）。**排序是主手势**：拖动时按 rect 算插入位置、用 `.htDropBefore/.htDropAfter` 竖线标出，松手即 `items` 重排（拖到哪就是第几个）。**合并是显式按钮手势**：拖动压在另一张卡片上时，目标卡片底部长出「📁 收进收藏夹」（`.htMergeChip`，文案会区分「收进收藏夹 / 收进「收藏夹 1」/ 并入「收藏夹 2」」），**松手落在按钮上**才调 `homeLauncherMerge()`。按钮必须**做满卡片宽度**（左右各留 8px）+ 高度约 30px，判定用 `homeLauncherChipHit()` 再向**左右**外扩 `HOME_CHIP_SLOP_X=12`（用户反馈过「拖进收藏夹的区域太小、要对准很难受」）；但**纵向只留 2px**——小卡片高度才 82px，上下外扩会把「拖到卡片中间 = 排序」的区域吃掉，出现想排序却被融合；指针压在按钮上时按钮 `.on` 高亮、插入竖线隐去（`.htChipHover`）。**绝不要再退回「停 N 毫秒自动进合并态」**——用户反馈拖拽时手一慢就被误判成想合并，排序和融合的边界必须看得见、摸得着，不能依赖计时器。所有拖拽反馈统一走 `homeLauncherPaintDrop()`（按钮的增删与搬移也在这里，由 `homeLauncherMergeChipText()` 出文案），别在 hitTest 里散着加 class / 建节点。拖拽监听是**临时**挂到 document、结束必删（`homeLauncherAbortDrag`）—— 插件每次进首页都会重新执行一遍，**不能留常驻 window 监听**。
  - 收藏夹弹层（`.homeFolderMask` 挂 body，Esc / 点背景 / hashchange 关闭）：**里面也能拖拽排序**（同一套鼠标/触摸规则，`.hfcGhost` + `.hfcDropBefore/After`，松手写回 `folder.goals`）；**右键卡片**弹 `.ctxMenu`（打开目标 / 移出收藏夹），「移出」把目标作为普通卡片放回桌面**紧挨收藏夹的位置**；收藏夹只剩 1 个目标时连它一起摊平（单目标收藏夹没意义，渲染时本来也会摊平）。弹层内改动会置 `homeFolderDirty`，正常关闭时 `renderHome()` 重画；点卡片进目标页 / 路由变化用 `close({keepHome:true})`（路由自己会渲染，别在这里抢渲染）。
  - 三档尺寸 `s/m/l` = `.homeDeskGrid` 的 1/2/3 列（基准 6 列，≤959px 4 列，≤660px 2 列；⚠️ **别改回 `auto-fill`**，5 列时中卡会在右边空出半格）。小卡只留标题+进度、中卡加简介与关键信息、大卡再加「下一步 / 更新时间」。收藏夹卡片露 4/6/9 个迷你图标（`homeLauncherFolderMiniHTML`），预览网格必须**顶部对齐**（`.htFolderMini` 别加 `margin-top:auto`：卡片被同行更高卡片拉伸后，底部对齐会让第一行贴底、新增行往上叠，看起来是「从下往上排列」）。
  - 卡片右上角 `⋯` 菜单复用 `.ctxMenu`，按钮上必须带 `data-morebtn`（坑 #2：否则点开就被全局「点别处关闭」收掉）。
  - 回归：`npm run test:home`（沙箱实例 + 6 个目标 + CDP 真鼠标，覆盖：默认桌/批量大小/**按下即拖排序**/**停顿不自动融合**/**松在「📁」按钮上才合并**/弹层内拖拽排序/右键移出/最近目标栏/新目标追加到末尾/刷新持久化/恢复默认，不碰真实数据）。改这块**至少跑它** —— `node --check` 证明不了拖拽链路。
- 验收：docs/agent-plugin/acceptance.md（目标交付物矩阵 + 实跑证据 + 已知边界）；回归：node scripts/test-commands.js（总线/审批）、node --no-warnings scripts/test-commands-write.js（内存库写命令/组件/摩擦）、node --no-warnings scripts/test-backup-domain.js（备份领域）、node --no-warnings scripts/test-versions-domain.js（版本领域）、node --no-warnings scripts/test-goals-domain.js（目标读取领域）、node --no-warnings scripts/test-sources-domain.js（资料/提炼领域）、node --no-warnings scripts/test-component-pipeline.js（组件校验）、node --no-warnings scripts/test-insights.js（健康度/卡点/动量）、node --no-warnings scripts/test-prompt-packs.js（模板=原函数/覆盖/reset/校验）、node --no-warnings scripts/test-plugin-package.js（插件包）、test-prompt-context.js、test-prompt-context-data.js、test-prompt-digest.js、npm run test:collect-ui（信息源「重新收集」弹窗与搜集触发 + 「长任务按目标隔离」，假 AI + 无头浏览器，49 项）。

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

### 4.1 组件管理页（#/components，2026-10-19 重做）

改这块之前先读这段 —— 这里是用户投诉最集中的一页（「切换分类不生效」「组件全铺一屏找不动」「分类名一坨字很难看」）。

- **分类必须真生效**（曾经三处 bug 叠加，现在都有回归）：
  * `effectiveCategory(id, declared)`：`component_category_map` 里**有 key 就认**（空串 = 用户明确归到「其它」），没 key 才回落到插件声明。早期写的是 `(map[id]) || declared`，于是「移回其它」永远被插件声明抢回去；另外后端写「其它」时曾 `delete map[cid]`，等于「从没设过」，下次读又回落 —— 现在写 `map[cid] = ''`。
  * **内置组件（plan/chat/clarify/constraints/sources/versions/tutorial/jdfile）也必须走 `effectiveCategory`**。早期 `allComponents()` 对 `BUILTIN_COMPONENTS` 直接用自己的 `b.category`，用户在界面上给它们换分类是「保存成功、刷新就跳回去」。
  * 删除分类时把该分类下的组件写成显式空串（不是字符串 `'其它'`），否则它们会回落到插件声明分类、被自动检测重新加回这个已删分类。
  * 回归：`npm run test:components`（14 项）。
- **分类可折叠 + 顶部搜索**：每个分类 = 一个 `.cmpCatMod`，标题行整行可点（`.cmpCatHead` / `data-cmp-fold`），**默认全部收起**；状态存本机 `localStorage.sierxing-cmp-prefs`（`collapsed` / `goalCollapsed` / `q` / `goalQ`，显示偏好、不做多端同步）。搜索按 名字/说明/id/分类/作者 过滤，命中的分类自动展开、没命中的整块不显示。改分类后**只就地重画组件列表**（`paintGlobalList()`），不整页重画 —— 否则刚展开的分类会全部收起。
- **全局视图和目标视图长同一个样**（都是「分类折叠 + 搜索」），区别只在开关写哪：目标视图用 `data-gcmp`（只写 `goals.plugins`），全局视图用 `data-cmp`（写 `settings.components`）。选了目标时全局那块仍然折叠进 `details.cmpGlobalFold` 并标注「影响所有目标」。
- **「管理范围」是一个可搜索按钮**（不是一排目标按钮）：`cmpScopePickHTML()` + `cmpScopePickBind()`，弹层由通用件 `sxiGoalPick*` 提供。

### 4.2 「选目标」统一件（全站共用）

目标一多，原生的 `<select>` / 一排按钮都没法找。统一用 `public/app.js` 里的：

```
sxiGoalPickHTML(id, { value, goals, allLabel, label, compact })
sxiGoalPickBind(id, { onPick(gid) })          // gid=0 表示 allLabel 那一项
sxiGoalPickOpen/Close                         // 需要自己控制时用
sxiGoals() / sxiGoalsSync()                   // 目标列表（30s 缓存）
```

按钮显示当前目标，点开是**带搜索框的弹层**（输入即过滤、Esc 关、点外面关、视口下方放不下自动上翻）。用它的地方：组件管理「管理范围」、资源库页头、产出库页头（`public/plugins/outlib.js`，经典组件通过 `SiErXing.sxiGoalPickHTML` 拿）、AI 任务中心「按目标筛选」（`sxiPopShow` 的 goal 分支，弹层里嵌 `.sxiPopSearch`）。

⚠️ 经典组件（`public/plugins/*.js` 那种 IIFE）要用这些必须**同时**加进两处白名单：`public/app.js` 的 `SiErXing.provide({...})` 与 `public/sdk.js` 的 `HOST_KEYS`。只加 provide 的话，组件里 `SiErXing.sxiGoalPickHTML` 是 `undefined`（`bridge()` 只拷贝 HOST_KEYS 里的键），表现是「产出库页头空了一截、不报错」。

⚠️ **文案里别再自带图标**：`allLabel` 传「🌍 全局默认」这类带 emoji 的文案时，通用件会用 `sxiGoalSplitIcon()` 把开头 emoji **抽出来当图标、并从文案里去掉** —— 否则「图标一个地球 + 文案又一个地球」会在界面上出现两个（真实反馈）。以后加新的 `allLabel` 照常写 emoji 即可，不用自己两边都写、也不用为了避重而删掉 emoji。

回归：`npm run test:goal-picker`（12 项，覆盖四处 + 分类修复不回归 + 「全局默认只出现一个地球」）。

---

## 5. 前端顶栏「收藏栏」

教程页与路线图页各有一条**共用同一套实现**的标签栏（钉选 / 收藏夹 / 横向拖拽排序 / ⋯ 收纳 / 自定义编辑器）。

- 实现在 `public/app.js`，按命名空间隔离：教程 `ns='tut'`、路线图 `ns='goal'`，各自存 `localStorage` 键 `sierxing-tutbar-v5` / `sierxing-goalbar-v1`。
- 入口：`applyBarOverflow(ns)`，由 `renderTutorialPage` / `renderGoal` 在渲染末尾调用。
- 组件的功能按钮通过给按钮加 `data-tbtn` 属性即可自动进入标签栏；`pluginButtonsHTML(g)` 负责渲染组件入口。

改这块之前请读第 7 节的坑。

---

## 6. 数据表

`goals / nodes / goal_conditions / plan_drafts / goal_versions / tutorials / sources / source_digests / chats / chat_sessions / settings / code_repo_files`，以及各组件自建表（`quiz_*` 等，已加入 `sync.js` 的 `SYNC_TABLES`）。

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
    - **讲解记录按教程 / 任务节点隔离**（用户要求：别把一百个教程、五百段代码全摞在一个列表里）：
      * 从教程页进来（`#/t/:id/explain`）→ 列表只查 `?tutorial_id=<id>`，**切教程看不到别的教程的记录**；从目标页进来 → 查 `?goal_id=<id>`，界面**按教程/任务节点分组**（`.exGroupHead`，默认收起、只有一组时展开）。
      * 列表 SQL 要带 `tut_title` / `node_title`（前端分组标题用它，不然只有 id）；「＋ 贴一段新代码」在教程里进来自动带上 `tutorial_id`，在目标页进来说 `tutorial_id=0`（归到"没挂任务节点的代码"那一组）。
    - **前置知识的界面**（用户要求）：列表在**左边代码栏上方**（`.exPre` 在 `.exSide` 里、代码上方），**只列知识点名字**（左栏不许出现讲解正文）；点某一条 → 右边显示它的**讲解**（`renderPreThread`）+ 同一个追问框（`POST /prereq/:pid/ask`，记在 `prereqs[i].chat`）；选中时左边把它 `why` 里提到的行（`第 N 行`）轻轻标出来（`.exLine.exRef`）—— 这样就不用把代码在右边再贴一遍。
      * 「你说知道、其实想听」：`POST /prereq/:pid/teach` 把这一条打回 `unknown` 再跑一次（已讲好的逐行讲解不动）。
      * ⚠️ `startJob` 的"都讲完了 → 直接 done"短路**必须连前置小课一起看**（`prereqs` 里有 `unknown` 且没 `lesson` 就不许短路），否则 `teach` 会返回 `started:false`、那一课永远写不出来（真实踩到过）。
    - **右边不再重复显示"当前选中的这段代码"**（用户要求）：左边已经高亮着"在看哪儿"，右上再贴一遍只会挤压对话栏 —— 线程头只留 `第 N-M 行 · 模块名` 一行，`.exSnippet` 已删（连样式一起）。
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

21. **页面插件的 `render()` 必须 `await`，插件也要 `return` 那个 Promise**（`public/app.js` 的 `renderPagePlugin()` + `scripts/build-page-plugin.js`）：
    - 原版 `render*` 大多是 **async**（先画「正在读取…」→ `await api(...)` → 整体重绘，见 `renderAiTasksPage` / `renderVersionsPage` / `renderDiffPage`）。宿主渲染完还要跑 `sxiSelify(document)` 之类的"页面收尾"，**不等它就会收尾在插件画出内容之前**。
    - 实测：`#/aitasks` 的「每页」下拉在插件版是**原生 `<select>`**、原版是自画下拉，像素差 5000+（`test:parity` 报 `/aitasks` 不一致）。这条跟"AI 助手常驻"改动无关，是插件化时期就埋下的。
    - 两侧都要改，缺一不可：宿主 `await inst.render()`；生成器把包装器写成 `render: function () { return renderXxxPage(); }`（生成的 4 个内置插件已重跑构建，手写的 `roadmap` 也补了 `return`）。
    - 回归：`scripts/test-ui-lab.js` 有 3 条纯文件断言（宿主 await / 内置插件 return / 构建器 return），不需要服务。

22. **`test:parity` 的像素比较必须对等取图 + 带 `-fuzz`**（`scripts/test-ui-parity.js`）：
    - **两种模式都要整页导航**。曾把"默认"那侧写成 `location.hash = …`（不重载）：上一轮停在 `?ui=legacy`，这侧其实还是原版渲染，外加残留的 AI 抽屉/引导蒙层 —— 会得到几万像素假差异，且**每次失败的路线都不一样**（13/20 完全不可复现）。
    - **取图前必须显式关掉常驻 AI 抽屉**（`localStorage.sierxing-ai-open`）：抽屉跨页保持，一旦某页被拉开，后面每页都带右侧栏截图。
    - **比较要 `-fuzz`**：`compare -metric AE` 连"差 1 个色阶"的像素也算。番茄钟浮窗用分数坐标（`y=249.828125`），不同渲染轮次落成相邻像素 → 同一路由反复跑得到 97/1052/1149/2347 等噪声数字。实测 `/guide/1` 两模式**最大单通道差仅 4/255（1.6%）**；默认 `-fuzz 2%`，真正换页仍有 40 万+ 像素（反向验证过：故意把对照 URL 指错 → 438452 判"不一致"）。
    - ⚠️ `compare` **差异为 0 时退出码 0、stdout 是空串**（不是 `"0"`）：`parseInt("")` = NaN，别让它退回"逐字节比 MD5"（同图两次编码会被误判不一致）。
23. **改写插件代码只能动「代码区」，绝不能碰字符串/模板字面量**（`scripts/build-page-plugin.js` 的 `rewriteCode()`）：
    - 真实翻车：为让设置页能写全局 `AI_PROVIDERS`，给适配器加了「赋值目标改写 `name =` → `H.name =`」。它不区分字面量，于是 HTML 里的
      `data-go="#/g/166"` 被改成 `data-H.go="#/g/166"` —— 属性名坏了，`app.addEventListener('click')` 里的 `e.target.closest('[data-go]')` 全部失配，
      **首页目标卡片、返回按钮一类全点不动**。而 `test:parity` 21/21、`test:mount` 13/13 依然全绿（外观没变、插件也确实接管了）。
    - 正确做法：用一个「代码区遍历器」——跳过 `'…'` / `"…"` / 注释 / 正则字面量，模板字符串只对 `${…}` 里的**表达式**递归改写，字面量部分原样保留。
    - 另一条边界：`app.` / `state.` 这类前缀替换同样只能作用在代码区（营销文案里出现 `app.js` 不该变成 `H.app.js`）。
    - **回归工具**：`npm run test:dom` 直接比 DOM 骨架（属性名差异会被抓出来）；`npm run test:audit` 真点控件（点不动会被标 NOOP，需人工甄别）。
    - 判断 NOOP 是「真坏」还是「测量盲区」的方法：看它是否只改了**body 级浮层**（`.sxiPop`/`.moreMenu`/AI 抽屉）、只弹了 **toast**、或点的是**已经是激活态的页签**——
      这几种在审计签名里要额外计入（body 元素数 / toast 文本长度 / 激活态），否则会误报。
    - 已定案的「看起来没反应、其实不是 bug」四类（见 `scripts/test-plugin-audit.js` 首部注释）：
      ① 勾选框类按钮（`全选当前结果`）只改 `input.checked` 属性，DOM 骨架/文本都不变；
      ② `<details>` 折叠只改 `open` 属性（已单独计入 `details[open]` 数量）；
      ③ 占位按钮：任务中心每行的「看原因」**永远渲染**，没有失败任务时是 `aria-hidden` 隐形占位（设计如此，不该有反应）；
      ④ 已经处于激活态的页签 / 已经适配过的「适应屏幕」——点了本来就无事发生。

24. **用户页面插件别在模块顶层取 `window.SiErXingUI`**：宿主桥是渲染时才 import 安装的，顶层取值会 undefined 崩溃（`examples/ui-plugins/home` 在 setup 里取）。ESM 入口由 `/api/ui/plugins/:id/entry` 直接加载，失败会被静默回退内置页面——「装完看起来没变化」时先看 `window.__sxPluginSource[page]`、`window.__sxPluginUsed[page]` 和控制台 warn。
25. **`loadKernelConfig()` 必须在 `route()` 之前 await**：`pagePluginEnabled()` 是同步函数、读 `window.__sxKernelConfig`；早渲染会按内置默认走，`ui.pagePlugins=false` 的总开关就失效。配置改 `DATA_DIR/config/user.json`，重启生效；`/api/kernel` 可看每项来源（provenance）、告警与升级差异。

26. **目标页清单里「任意有子节点的任务」都必须能折叠**（`public/app.js` 的 `listTaskHTML`）：
    - 原实现只给阶段（`tl-s`）/小目标（`tl-g`）加 `data-fold`，第三层任务即使被「✨ 深度拆分」拆出子任务也**永远摊开**、没有折叠按钮；一个目标里这种节点一多，整页直接撑爆。
    - 现在 `listTaskHTML` 对 `t.children.length > 0` 渲染 `data-fold="tl-t<id>"` + `data-foldbody`，**任务层默认收起**（`foldClosed(gid, key, false)`），状态与其它折叠一起存 `sierxing-goal-folds-<gid>`（本机显示偏好）。
    - 深度拆分完成时（`startExpand` 的 `d.done`）要删掉该节点的 `tl-t<id>` 折叠记录，否则刚拆出来的子任务默认收起、用户以为没成功。
    - ⚠️ 这是页面插件生成物：改完必须 `node scripts/build-page-plugin.js goal` 重建 `ui/plugins/builtin/goal/index.js`（对话页也复用 goal 插件）。
    - 回归：`node scripts/test-plugin-func.js` 新增「执行页 有子节点的任务可折叠」（默认收起 → 点开 → 再收起）。

27. **「信息源 → 重新收集」的弹窗函数不能引用 `ensureCollectSetup` 的局部变量**（`public/app.js` 的 `showCollectSetupDialog`；改完要用 `node scripts/build-page-plugin.js goal` 重建 `ui/plugins/builtin/goal/index.js`）：
    - 真实翻车（2026-10-20 用户反馈）：点「重新收集」只弹一句「AI 正在按目标制定搜集方案…」，然后**什么都不发生、搜集永远跑不起来**。真因是 `csGate`（AI 把关设置）定义在 `ensureCollectSetup` 里的 `let`，而 `showCollectSetupDialog` 直接引用它 → `ReferenceError: csGate is not defined` → Promise reject、`startCollect` 静默中断。`node --check` 查不出来（两段代码语法都合法），`test:mount`/`test:dom` 也全绿（要真点这个按钮才会触发）。
    - 修法：`ensureCollectSetup` 把 `csGate` 放进 `showCollectSetupDialog(id, { queries, books, pref, editOnly, csGate, auto })` 的 opts，弹窗内 `const csGate = opts.csGate || {默认值}`。**别图省事把 csGate 提到模块顶层**：页面插件生成器对顶层 `let` 的读写走 host 表，插件里容易变 `undefined`。
    - 顺带把「先等两个 AI 推荐请求（10~30 秒）再弹窗」改成**弹窗先出来、方案/书单后台补**（`auto:{plan,books}` + 弹窗内补画 `paintQueries`/`paintBooks`）：旧流程中间只有一个 3.2 秒就消失的 toast，用户看到的就是"点了没反应"。也修了 `#csRetry` 给 `const queries` 赋值的隐患（`queries`/`books` 现在都是 `let`）。
    - 回归：`npm run test:collect-ui`（49 项，假 AI + 无头浏览器真点；插件版和 `?ui=legacy` 各验一遍：弹窗 ≤3 秒出现、方案/书单后台补入、把关控件在、点「跳过，直接搜集」真的发起 `/api/goals/:id/collect` 并出现进度条、全程无未捕获异常；另验「长任务按目标隔离」：A 目标搜集中打开 B 目标不显示 A 的进度、不禁用 B 的「重新规划/重新收集」，B 也能并行搜集，停止只影响自己的目标。隔离用例用假 `fetch` 挂住 `/collect` 把「搜集中」变成确定状态，别靠真实搜索耗时）。⚠️ 假 AI 必须同时支持 SSE（带 `onEvent` 的对话/规划）和 JSON（推荐类调用是非流式，`stream:false`），否则会误报"AI 返回异常：返回内容为空"。

---

## 8. 国际化（界面语言 i18n）—— 架构规则，改任何界面文字前必读

> 一句话：**界面上的每一个字都必须来自 `language/`；新代码用 `tr('中文原文')`，不许再写死文案。**
> 完整规则与操作手册在 [`language/README.md`](language/README.md)；这里只写 AI 助手最容易搞错的事。

### 8.1 目录与数据流

```
language/
├── index.js        服务端语言引擎（语言列表/当前语言/语言包/校验/生成包落盘/入口页注入）
├── extract.js      文案提取器（纯函数；build 脚本和守卫共用）
├── source-files.js 哪些文件算"有界面文案"（build 与守卫共用同一份清单，别各写一份）
├── generate.js     AI 生成新语言（识别语言 → 分批翻译 → 校验 → 落 DATA_DIR）
├── locales/zh-CN/  ★ 源语言：meta.json + ui.json（key=中文原文，value=原文）
├── locales/en-US/  ★ 英文：meta.json + ui.json（key=中文原文 → 英文）
├── prompts/        ★ 提示词模板（zh-CN/packs.json）+ 规则 README
└── legacy-baseline.json  中文硬编码预算（棘轮：只许降不许升）
```

- 当前语言存 `settings.app_language`（`''` = 跟随浏览器：中文浏览器用中文，否则英文）。
  已加入 `server/sync.js` 的 `SYNC_SETTINGS`（换设备语言一致）。
- AI 生成的语言包落 `DATA_DIR/language/<code>.json`（**不进仓库**，升级不覆盖）。
- 入口页注入链路在 `server/server.js` 的 `serveStatic` → `injectLanguageHtml()`：
  重写 `<html lang>` / `<title>` / meta description，并在 app.js **之前**注入
  `window.__SX_I18N__` + `/api/language/pack.js` + `/i18n.js`。
- 前端运行时 `public/i18n.js` 定义 `window.tr` / `window.SXI18N`；`ASSET_V` 的文件清单里
  必须包含 `i18n.js`（漏了会吃旧缓存）。

### 8.2 写新代码（强制）

```js
tr('保存')                    // 按钮/标题/提示
tr('已删除 {0} 份', n)        // 带变量一律用 {0} {1} 占位符，别自己拼字符串
tr('共 {0} 个节点 · {1}')     // 占位符数量/数字必须与译文一致
```

- 组件（`public/plugins/*.js`、页面插件、Vue 页面）里直接调全局 `tr(...)` 即可。
- **不要**把 `tr()` 用在逻辑判断 / DB 值 / API 合同 / 解析标记上（那些不是文案）。
- 新增/修改任何用户可见文字后**必须**跑：`npm run build:lang && npm run check:i18n`。
- 给新语言包补英文：`language/locales/en-US/ui.json`；占位符必须一一对应。

### 8.3 旧界面为什么现在就能切换？（运行时兜底层）

`public/app.js` / `public/plugins/*.js` 里还有大量历史文案没逐条改成 `tr()`。
`public/i18n.js` 会在渲染后（MutationObserver）按字典替换**文本节点**与
`title / placeholder / aria-label / aria-placeholder / alt` 属性，并包了
`confirm/alert/prompt`；带变量的文本用 `{0}` 模式匹配；服务端提示里的动态部分用
「前缀匹配」兜底（`保存失败：xxx` 只翻前缀）。

- 兜底层覆盖的区域**不许**当作长期方案；动到哪块旧代码，优先顺手把文字包成 `tr()`。
- **「文案 + 变量」必须用 `tr('…{0}…', v)` 一整个模板**，不要 `'文案' + v + '文案'` 硬拼：
  英文语序/量词/标点都不一样，拼接出来的是散装英文（真实改过：宝箱状态行、主题下拉、
  AI 抽屉页面标签、组件文件清单）。运行时兜底层虽然能按占位符/标点/前后缀拆着兜，但那是
  兜底，不是写法。
- **不翻译的区域**（AI 正文 / 教程正文 / 题面 / 代码等）用 `data-i18n-skip` 或
  `class="no-i18n"` 标出来；新增"内容区"记得标，否则用户数据 / AI 输出可能被误翻。
- `language/legacy-baseline.json` 记每个文件还剩多少「会显示但没被 tr() 包住」的字面量；
  `check:i18n` 发现哪个文件超过基线就失败。**下降后用 `--update` 收紧**（别手改）。

### 8.4 提示词（prompt）

- 可编辑提示词包的**正文模板**统一在 `language/prompts/zh-CN/packs.json`
  （由 `language/prompts/index.js` 读取；`server/prompts/*-packs.js` 只留注册信息与 builtinRender）。
- 改提示词 → 改 `language/prompts/zh-CN/packs.json`（或走 `prompt.update` 覆盖），
  再跑 `node --no-warnings scripts/test-prompt-packs.js`（模板与 builtin 行为必须一致）。
- 新增提示词不许再塞回 `server.js`：模板进 `language/prompts/`，动态逻辑放
  `server/prompts/*` 或 `server/features/<id>/prompts.js`。
- AI 生成的内容（问卷/规划/教程/对话）**当前不做语言切换**（2026-10-19 用户定调：
  只翻界面）。以后要做的话，在 `server/ai.js` 的 `ai.text()` 唯一出口注入"输出语言"
  指令，语言名从语言包 meta 取。

### 8.5 设置页「语言」

- 位置：设置 → 🌐 语言 Language（`SET_TABS` 里 `set-lang`；UI 在 `public/app.js` 的
  `languageSectionHTML / bindLanguageSection / languageBodyHTML`）。
- **这是页面插件生成物**：改完必须 `node scripts/build-page-plugin.js settings` 重建
  `ui/plugins/builtin/settings/index.js`。
- 功能：**已安装语言卡片列表（点一下手动切换中文/英文/任意已生成语言）+ 跟随浏览器开关**；
  **新语言从 `language/languages.json` 清单里选（chip 点一下即生成，不用打字）**，
  清单里没有再手填；生成有进度条 + 任务中心；生成完自动切换；生成的语言可删除。
- 生成是后台任务（`tasks.submit({type:'language'})`），服务端 `POST /api/language/generate`；
  别改成同步长请求（5000+ 条要几分钟）。

### 8.6 守卫 / 回归

```bash
npm run test:i18n                     # 语言引擎 + 提取器 + AI 生成流程（假 AI，不花钱）
npm run check:i18n                    # 目录同步 / 语言包完整 / 占位符 / 英文残留中文 / 硬编码预算
node scripts/build-language-source.js --stats   # 看各文件候选词条数
node scripts/lang-batch.js status               # 英文本地化进度（开发辅助）
```

改了 UI 之后至少还要跑：`node --check public/app.js && node --check server/server.js`，
并用无头浏览器实际切到英文看一遍（`npm run check:i18n` 查不出 DOM 层翻译失败）。

### 8.7 踩坑提示（会再犯的）

1. **`tr` 是全局函数**（`window.tr`），页面插件生成器不会改写它；但**不要**在 app.js
   顶层声明同名变量 `tr`/`SXI18N`，会在打包进插件时遮蔽全局。
2. **占位符不同步**：`{0}` 在译文里丢了/多了，语言包校验会失败；同一条文案的中英文
   占位符必须完全相同。提取器会给带 `${...}` 的模板自动生成 `{0}` 模式，别手改 key。
3. **别在 `language/locales/zh-CN/ui.json` 里手写新 key**：它由 `npm run build:lang` 生成，
   手写的会被下次 build 覆盖；要加文案就去代码里写 `tr('…')` 再 build。
4. **英文包不允许残留中文**（校验会红）；产品名是 `SiErXing`。日文等 CJK 语言在
   `meta.json` 里写 `"cjk": true` 可豁免这条（AI 生成时会自动判断并写入）。
5. **`html lang` / `<title>` 是服务端注入的**：改 `language/locales/*/meta.json` 的
   `documentTitle/documentDescription` 即可，不要改 `public/index.html` 里的静态标题。
6. **AI 生成语言会花用户的 API 费用**（约 20 批调用），UI 上已提示；测试时用
   `scripts/test-language.js` 的假 AI，别真调。
7. **`serveStatic` 注入失败要回退**：`injectLanguageHtml()` 已经 try/catch，失败时
   不做注入、页面仍可用；别把注入写成抛错。
