# UI 插件化（**已完成 · 全部自研页面 = 插件**）

> 目标：**目标规划是核心，UI 全部非核心、可替换**。用户可改 UI，升级不覆盖用户改动。
> 现状：**默认界面就是插件界面**，且与原版**逐路由像素一致**（21/21）。
>
> **P0–P3 已落地**：内核 + 服务化 + 用户页面插件 + 分层配置（详见 [kernel-contract.md](kernel-contract.md)）。
> 用户只改 `DATA_DIR/ui-plugins/` 与 `DATA_DIR/config/user.json`，升级不覆盖；
> 左栏「🧱 界面管理」（`#/ui-plugins`）可启停页面插件、看内置版、打开插件目录、看内核自检。
> **P4（内核瘦身）明确不做**：内核 = 容器 + 启动器，核心逻辑仍在 server.js / app.js。

## 当前状态（重要）

- **默认界面 = 插件界面**。每个自研页面都是 `ui/plugins/builtin/<page>/` 下的一个插件，
  宿主 `public/app.js` 的 `renderPagePlugin(page, extra)` 负责注入依赖并渲染。
- **插件失败静默回退原版** `render*`（保证任何情况都能显示）。回退开关：`?ui=legacy` 或
  `localStorage.sierxing-ui-<page>=legacy`。
- **Vue 版页面（`ui/pages/*`）是另一条实验线**：功能不完整，只在 `?ui=vue` 下体验，不作为默认；
  它不属于本文说的"页面插件"。
- `r.view === 'plugin'` 的页面（学习统计 / 今日任务 / 随堂测验 / 看懂代码 / 刷题 / 产出库 …）
  走的是 `public/plugins/*.js` 组件体系，本来就不是写死的，不在页面插件范围内。

### 已插件化的页面（11 个自研页 + 引导层）

| page id | 路由 | 原版实现根函数 |
| --- | --- | --- |
| `home` | `#/` | `renderHome` |
| `guide` | `#/guide/:step` | `showGuide` + `drawGuide`（首页 + 蒙层，两段都走插件） |
| `settings` | `#/settings`（ai/data/sync/rag/service/update/system/theme 全部子页） | `renderSettings` |
| `components` | `#/components` | `renderComponentsPage` |
| `library` | `#/library` | `renderLibraryPage` |
| `aitasks` | `#/aitasks` | `renderAiTasksPage` |
| `versions` | `#/g/:id/versions` | `renderVersionsPage` |
| `diff` | `#/g/:id/diff/:vid` | `renderDiffPage` |
| `roadmap` | `#/g/:id/map` | `renderMapPage` |
| `tutorial` | `#/t/:id` | `renderTutorialPage` |
| `goal` | `#/g/:id`（`#/g/:id/chat` 复用 + AI 抽屉） | `renderGoal` |

## 架构：插件怎么生成、怎么加载

**核心原则：不要手抄原版代码。** 插件由 `scripts/build-page-plugin.js` 从 `app.js` **机械提取**，
所以 DOM 结构 / CSS 类名 / 交互与原版逐字一致 —— 这是"像素级对齐"的根本保证。

```
public/app.js  ──(依赖闭包提取)──▶  ui/plugins/builtin/<page>/index.js
     │                                        │
     │  渲染时注入 host 依赖                    │  挂到 window.SXUIPlugin[<page>]
     ▼                                        ▼
renderPagePlugin(page, extra) ──▶ plugin.mount(host).render()
     │
     └─ 任何异常 → 回退原版 render*()
```

### 1）提取：`scripts/build-page-plugin.js`

- 只给**根函数**（如 `renderSettings`），自动递归收集它引用的所有 `app.js` 顶层声明。
- **边界**（不搬、改由 host 注入）：跨页渲染器（`renderGoal`/…）、路由与生命周期
  （`route`/`parseRoute`/`go`/`setHeader`/`rerenderCurrent`）、Vue 旧实现（`*Vue`）、
  AI 助手（`ai*`）、主题（`applyTheme*`）、markdown（`md*`）、教程阅读器（`tut*`）、
  自画下拉（`sxi*`）、任务条（`task*`）、全局单例（`app`/`state`/`ST_LABEL`…）。
- 用法：
  ```bash
  node scripts/build-page-plugin.js --list          # 看页面配置
  node scripts/build-page-plugin.js --report goal   # 只看依赖报告（不写文件）
  npm run build:pages                               # 重建全部
  ```
- 加一个页面：在 `PAGES` 里写 `{ roots: ['renderXxx'], render: 'renderXxx()' }` → `--all`。
  **改渲染逻辑仍然改 `app.js`**，插件是生成物，别直接改。

### 2）注入：`sxPageHostMap()`（`scripts/gen-host-map.js` 生成）

- 宿主把 `app.js` 的**全部真实顶层声明**暴露给插件（惰性构建，避开 TDZ）。
- `let/var` 用 **getter/setter**：设置页会写 `AI_PROVIDERS`/`AI_AGENTS`，
  插件里 `H.AI_PROVIDERS = x` 必须真正写回原版全局。
- 新增全局函数后跑 `npm run gen:hostmap` 重新生成。

### 3）加载：`renderPagePlugin(page, extra)`

1. `pagePluginEnabled(page)`：`?ui=legacy` / `localStorage` 可强制回退；
2. 卸载上一实例（防监听泄漏）→ 挂插件 `style.css`（只放"全局没有的"样式）；
3. 入口优先级：**用户插件** `DATA_DIR/ui-plugins/<page>/` ＞ 内置 `ui/plugins/builtin/<page>/`；
4. `plugin.mount(host)` → `await inst.render()`（**必须 await**，见坑 #21）；
5. 埋点 `window.__sxPluginUsed[page] = true` —— 否则验收验不出"插件到底跑没跑"。

### 一致性验收（每步必跑）

```bash
npm run test:parity                    # 逐路由对比「默认界面」vs 原版（?ui=legacy）
npm run test:parity /g/166 /settings   # 只测指定路由
```

判定：像素差异 ≤ 600（≈0.05%，抗锯齿噪声）视为一致；截图存 `.sx-backup/parity-shots/`。

⚠️ **验收脚本必须等内容稳定再截图**：设置页等是「先渲染『加载中…』→ 异步拉数据 → 整体重绘」，
抢在中间截图会得到大面积假差异（实测 `/settings` 假差异 587281 像素）。脚本已内置
「hash 到位 + 无『加载中』+ 连续两次文本长度一致」的等待逻辑。

⚠️ **两种模式的取图方式必须对等**：两侧都要整页导航（`Page.navigate`）后再等稳定。
曾经「默认」那侧只用 `location.hash` 切 hash（不重载）：上一轮导航停在 `?ui=legacy`，
于是这侧其实还是原版渲染；再加上一步残留的 AI 抽屉 / 引导蒙层没清 —— 会拿到几万像素的假差异，
且每次失败的路线都不一样（13/20 那种完全不可复现的结果）。
同理，AI 助手是**常驻**的（抽屉状态记在 `localStorage.sierxing-ai-open`），取图前必须显式关掉。

⚠️ **比较必须带 `-fuzz` 容差**：`compare -metric AE` 把"任何一位不同的像素"都算差异，
于是**同一页面**两次渲染之间的抗锯齿噪声（番茄钟浮窗落在分数坐标 `y=249.828125`，
不同渲染轮次会落成相邻像素）会被记成几千像素，同一路由反复跑拿到 97 / 1052 / 1149 / 2347
等不可复现的数字。实测 `/guide/1` 两模式之间**最大单通道差只有 4/255（1.6%）**。
脚本默认 `-fuzz 2%`（`PARITY_FUZZ` 可覆盖）：噪声归零，而真正换了一个页面仍有 40 万+ 像素、
照样抓得住（做过反向验证：把 `/library` 的对照 URL 故意指到 `/g/166` → 438452 像素被判"不一致"）。
另外 `compare` 差异为 0 时退出码 0、stdout 是**空串**而不是 `"0"`，`parseInt("")` = NaN —— 别让它
退回"逐字节比 MD5"（同一张图两次编码的二进制差异会被误判成不一致）。

### 验收矩阵（发布前必须全绿）

| 命令 | 验什么 | 现状 |
| --- | --- | --- |
| `npm run test:mount` | **每页确实由插件接管**（`__sxPluginUsed[page]`） | 13/13 |
| `npm run test:parity` | 逐路由**像素一致**（21 条，`?ui=legacy` 对照，带 `-fuzz`） | 21/21 |
| `node scripts/test-plugin-func.js` | **只读交互**（卡片折叠 / 设置子页 / 筛选 / 教程正文 / 路线图展开） | 见输出 |
| `npm run test:ui` | 既有 UI 单测 | 204 + 7 项 |
| `scripts/test-plugin-func.js` | 只读交互冒烟（折叠 / 子页 / 筛选 / 目录 / 路线图） | 8/8 |
| `npm run test:home` | 首页目标桌面（长按拖拽 / 收藏夹 / 三档大小） | 9/9 |
| `npm run test:dom` | **DOM 骨架**（标签 + class + `data-*` 属性名）插件版 vs 原版 | 12/12 |
| `npm run test:audit` | **控件级**逐页真点（13 条路由 × 每页最多 10 个控件；捕获异常 + 判断有无反应） | 105 点 / **0 异常** |
| `npm run test:home` | 首页目标桌面（长按拖拽 / 收藏夹 / 三档大小） | 9/9 |

### 为什么「像素一致」还不够

像素对比只能证明**看起来**一样。插件化真正容易坏的是**行为**，而它有两个盲区：

1. **属性名被改坏**——构建器做过字符串级改写，`data-go="#/g/166"` 变成 `data-H.go="#/g/166"`。
   外观分毫不变（像素 21/21 全绿），但 `e.target.closest('[data-go]')` 全部失配，**首页目标卡片、返回按钮全点不动**。
   → `npm run test:dom` 逐元素比较 标签 + class 集合 + `data-*` 属性名，直接抓出来。
2. **事件委托 / 处理器失效**——插件接管成功、页面渲染正确，但点了没反应。
   → `npm run test:audit` 逐页逐控件真点，捕获 JS 异常并判断有无反应；危险控件（删除/更新/生成/导入/保存…）默认跳过，
     原生 `confirm` 自动拒绝，不写库。NOOP 需要人工甄别：body 级浮层、toast、已激活页签属于「本来就无视觉反馈」。

⚠️ **为什么必须有 `test:mount`**：插件抛错时路由会**静默回退原版**，像素对比两边都是原版、
照样全绿 —— 看起来"全部通过"，其实插件一次都没跑起来。这条测试专门断言"插件真的接管了"。

### 踩过的坑（后续页面照此避坑）

- **插件 `render()` 必须 `return` Promise，宿主必须 `await`**：原版 `render*` 大多是 async
  （先画「正在读取…」→ await 数据 → 整体重绘）。宿主不等它就接着跑 `sxiSelify(document)` 之类
  的页面收尾，插件那时还没画出 `select.sxi-sel` —— 实测 `/aitasks` 的「每页」下拉在插件版是
  原生 `<select>`、原版是自画下拉，像素差 5000+。
- **索引不能用「行首正则」扫全文**：页面里渲染的示例代码是**模板字符串**，里面照样有行首
  `const card = ...`，会被当成真的顶层声明 → 生成 host 表后每次插件渲染都
  `ReferenceError: card is not defined`（现场表现：所有页面"能看"，但埋点全空 = 全部走回退）。
  必须字面扫描：跳过字符串/注释/正则、按括号深度判断顶层。
- **函数边界也不能按「行首 const」截断**：模板字符串里的示例代码会把函数**截断**，
  生成的文件直接语法错误。要字符级扫描 + 括号配平（还要认正则字面量，否则 `/{}` 破坏配平）。
- **改写外部依赖只改「调用位置 `name(` 与属性位置 `name.`/`name[`」**：裸名字全替换
  会把函数参数 `state` 改成 `H.state`（`function paintBtn(card, m, H.state, msg)` 语法错误），
  还会把函数声明名改成 `function H.xxx`。声明位置要先遮蔽再还原。
- **不要复制全局 CSS**：把 `style.css` 里的规则抄进插件再加载，会因加载顺序覆盖原值，
  实测像素差反而变大（45572 → 82938）。插件只放"全局没有的"样式。
- **CSS 提取不能只取第一条**：同一选择器可能有多条规则（`.mtbranch` 有两条，后者带
  `gap:9px`），漏抄会导致节点间距差约 1.4px、整棵树错位。
- **首帧要等布局稳定**：`mapFit()` 必须放在 `requestAnimationFrame` 里；只等一帧会差 0.5px。
- **非 API 路径别塞进 `handleAPI`**：`/ui/...` 走静态分发（`serveStatic`），要加在
  `http.createServer` 的分发处。
- **验收脚本要等"加载中"消失**：设置页等是"先渲染加载中 → 异步拉数据 → 整体重绘"，
  抢中间截图会得到大面积假差异（实测 `/settings` 假差异 587281 像素）。
- **写全局变量要走 setter**：设置页 `AI_PROVIDERS = provs` 这类赋值，插件里改成 `H.AI_PROVIDERS = ...`，
  host 表对 `let/var` 必须有 setter，否则 write 丢失、别处读到旧值。

### 稳定备份

`.sx-backup/stable-<时间戳>.tar.gz` 是改动前的可用状态快照；回滚：`tar xzf .sx-backup/stable-*.tar.gz -C .`

## 进度

- ✅ 第 1 步：Vue 3 + Vite 构建链 + UI Lab（宿主契约 / 用户覆盖 / 回退）。
- ✅ 第 2 步：服务端 UI 插件 API + `DATA_DIR/ui-plugins` 加载。
- ✅ 第 3 步：第一个真实页面迁移——**学习统计**（`#/studystats`）。
- ✅ 第 4 步：第二个页面迁移——**今日任务**（`#/g/:id/quests`）。
- ✅ 第 5 步：第三个页面迁移——**检索增强评测**（`#/g/:id/ragbench`）。
- ✅ 第 6 步：资源库**只读部分**迁移（`#/library`）：资料/汇总/归类/导出。
- ✅ 第 7 步：资源库**动作部分**迁移：导入/清洗/补抓/提炼/索引/删除汇总。
- ✅ 第 8 步：产出库**只读部分**迁移（`#/outlib`）：目标切换/目录树/文件列表/预览/下载。
- ✅ 第 9 步：产出库**写操作**迁移：新建文件夹/添加文件与文件夹/改名/删除/移动/拖拽排序。
- ✅ 第 10 步：任务中心迁移：运行中任务/筛选/按目标分组历史/停止/重试/分页。
- ✅ 第 11 步：教程内页「随堂测验」迁移（`#/t/:id/quiz`）：准备页/答题卡/报告/薄弱再练。（原「追问 AI」已删除 —— 2026-10-18 起统一用常驻 AI 助手，见 AGENTS.md §3.4）
- ✅ 第 12 步：目标内页「模拟面试」迁移（`#/g/:id/interview`）：历史/JD/项目摘要/考点/对话/现场讲解/总评。
- ✅ 第 13 步：目标内页「信息源导入」迁移（`#/g/:id/jd`）：图片/电子书双队列、SSE 进度、代码库导入、JSON 资料导入。
- ✅ 第 14 步：第一个**非页面 UI 组件**迁移——教程书签浮动面板（Vue 插件 + 旧面板回退），验证面板类组件也能插件化。
- ✅ 第 15 步：AI 输入框「提示词库」弹窗迁移（选择/管理/分类/排序，Vue + 旧弹窗回退）。
- ✅ 第 16 步：教程内页「用自己的话」**主流程**迁移（`#/t/:id/restate`）：选点/对话历史/对话/草稿/报告/笔记/串讲。
- ✅ 第 17 步：补齐 restate 高级交互：架构导图（主线/知识块/论点）+ 三栏宽度拖拽（本机记忆）。
- ✅ 第 18 步：看懂代码**第一段**迁移：讲解记录列表 / 贴代码准备页 / 风格示例 / 启动与续接交接。
- ✅ 第 19 步：看懂代码**运行界面核心**迁移：代码栏 + 行选中 + 逐行线程 + 前置知识确认/补课 + 追问 + 继续讲。
- ✅ 第 20 步：补齐看懂代码运行页三处拖拽边界（左栏比例 / 显示高度 / 两栏总宽，本机记忆 + 双击复位）与运行页风格弹窗（保存/上传/恢复默认/按新风格重讲）。
- ✅ 第 21 步：每日刷题**每日页**迁移：统计卡片 / 今日复习排期 / 今日任务勾选 / 按知识点练习列表。
- ✅ 第 22 步：每日刷题**题目详情**迁移核心：题面 / 标签 / 完成状态 / VSCode 作答 / 刷新题面 / 加入或移出复习流 / 作答记录与代码 / 思路卡摘要与易错卡。
- ✅ 第 23 步：组件管理迁移：全局/目标级范围切换、分类分组、全局开关、目标级开关、分类新建/重命名/删除、组件移动分类、导出、卸载；导入弹窗仍走旧版。
- ✅ 第 24 步：教程页右侧**笔记面板**迁移：Markdown 查看/编辑/保存、拖宽/收起、页签记忆、划线页签继续委托 `TutNotes.renderInto`。
- ✅ 第 25 步：**主页**迁移：目标卡片 / 新建目标 / 导入分享 / AI 未配置提示。
- ✅ 第 26 步：**番茄钟浮窗**迁移：可见 UI 由 Vue 接管；计时/通知/自动休息/绑定弹窗状态机仍留在 `pomodoro.js`。
- ✅ 第 27 步：**版本管理页**迁移：版本列表、筛选、收藏、保存当前方案、恢复、跳对比图。
- ✅ 第 28 步：**版本对比图**迁移：复用旧版节点树/匹配/变更判定逻辑，左右两栏、新增/移除/修改标记、AI 变更汇报。
- ✅ 第 29 步：设置页的**外观主题**子路由迁移：显示模式、亮暗主题皮肤、当前映射、主题组件清单。
- ✅ 第 30 步：**设置概览页**迁移：AI 连接状态/模型概览、外观入口、最新备份与占用、多端同步状态、其他入口；详细编辑仍进旧版设置。
- ✅ 第 31 步：设置 → **AI 连接编辑**迁移：连接卡片、服务商/Agent、地址/密钥/模型、新增/删除、保存、取模型、测试。
- ✅ 第 32 步：设置 → **数据备份**迁移：列表/大小/时间、立即备份、保留份数、变化对比、恢复、删除、导入导出。
- ✅ 第 33 步：设置 → **多端同步**迁移：状态、启用/仓库/分支/令牌/自动推拉/图片、保存测试、上传拉取、冲突二选一。
- ✅ 第 34 步：设置 → **检索增强（RAG）**迁移：开关、向量模型、Ollama/取模型/测试向量、索引状态、建索引、检索预览。
- ✅ 第 35 步：设置 → **服务与启动**迁移：访问地址、桌面图标/终端命令、开机自启。
- ✅ 第 36 步：设置 → **版本与更新**迁移：当前版本/安装方式、检查更新、更新状态与提交列表、立即更新。
- ✅ 第 37 步：设置 → **系统信息**迁移：数据存储路径状态（只读，迁移仍进旧版）、重新查看使用引导、关于与版本；设置页全部子页已有 Vue 版。
- ✅ 第 38 步：**使用引导页**迁移：`#/guide/:step` 6 步内容、进度点、上一步/下一步/完成、AI 连接与组件/同步上下文。
- ✅ 第 39 步：**教程阅读页**迁移：`#/t/:id` 标题/元信息、Markdown/HTML 正文、目录、笔记/书签/内部化/看懂代码/测验/写代码/打包入口、下载/重命名/删除。
- ✅ 第 40 步：**教程编辑类操作**接到 Vue 阅读页：AI 修改、手动编辑、历史版本；复用旧逻辑不重复实现。
- ✅ 第 41 步：**路线图页**迁移（只读）：`#/g/:id/map` 大纲视图、折叠、节点详情、版本对比与旧版入口。
- ✅ 第 42 步：**目标概览页**迁移（只读）：`#/g/:id` 规划思路/现状/进度、下一任务、阶段概览、最近教程、继续学习、约束、统计与快捷入口。
- ✅ 第 43 步：目标概览加**待办任务清单**（前 10 条可勾选完成/取消）与 **AI 助手入口**。
- ✅ 第 44 步：目标概览加**编辑目标信息**与**规划约束增删改**。
- ✅ 第 45 步：**路线图写操作**：叶子任务可勾选完成/取消，节点详情也有完成按钮。
- ✅ 第 46 步：目标概览加**规划问卷摘要**；首次运行从首页自动进 Vue 引导路由（深链接不劫持）。
- ✅ 第 47 步：**生成学习教程**迁移：选任务/补充要求/附带文件夹 → SSE 进度 → 完成后进 Vue 教程页。
- ✅ 第 48 步：**深度拆分**迁移：选节点 + 要求 → SSE → AI 追问 → 继续 → 原地刷新。
- ✅ 第 49 步：**规划骨架确认**迁移：`review` 目标显示统计与确认卡，确认后走 `/plan/tasks` SSE 细化。
- ✅ 第 50 步：**按意见调整骨架**迁移：`/plan/refine` SSE + 追问表单。
- ✅ 第 51 步：**重新规划**迁移：警示 → 澄清问卷 → 新骨架 → 回到待确认。
- ✅ 第 52 步：**目标页功能入口工具条**迁移（原生动作 + 6 个组件入口）。
- ✅ 第 53 步：**对话页** `#/g/:id/chat` 迁移（会话 / 消息 / 流式发送 / 停止）。
- ✅ 第 54 步：对话页增强：会话重命名、步骤文案对齐旧版、目标页「💬 对话」跳新页面。
- ✅ 第 55 步：**教程改动范围确认卡**迁到对话页（确认范围 / 范围不对重说）。
- ✅ 第 56 步：**对话节点附件**迁移（选择/搜索/含子任务/持久化）。
- ✅ 第 57 步：**教程绑定对话**迁移（教程页「让 AI 修改」→ `chat?tut=id`）。
- ✅ 第 58 步：**分享 / 导出弹窗**迁移（模块勾选 / 隐私隐去 / 导出文件）。
- ✅ 第 59 步：**数据存储路径迁移**迁到 Vue「系统信息」（状态/体检/迁移/重启）。
- ✅ 第 60 步：**全局 AI 入口**迁移（有目标进对话页 / 无目标进目标选择页 / legacy 抽屉回退）。
- ✅ 第 61 步：**路线图节点写操作**（编辑/添加子任务/删除）。
- ✅ 第 62 步：路线图节点可跳**生成教程 / 深度拆分**并预选节点。
- ✅ 第 63 步：**目标页 Vue 原生收藏栏**（拖拽/隐藏/恢复）。
- ✅ 第 64 步：**教程页 Vue 原生工具栏**（拖拽/隐藏/恢复，保留旧按钮 id）。
- ✅ 第 65 步：**教程历史版本**迁 Vue（列表/逐行对比/预览/恢复）。
- ✅ 第 66 步：**节点关联文件夹**迁 Vue（列表/继承标记/体检/挂载/取消）。
- ✅ 第 67 步：**节点 AI 功能**迁 Vue（教程/子节点批量/拆分/资料汇总）。
- ✅ 第 68 步：**教程手动编辑**迁 Vue（双击改块 / 整篇源码编辑，保存留历史版本）。
- ✅ 第 69 步：**legacy 入口清零 + 补齐最后两处**：
  - 空目标可在 Vue 目标页「开始 AI 规划」（澄清问卷 → 骨架 → 确认细化，不再依赖旧版执行页）；
  - 组件「导入」迁 Vue（多选 component.json → 预览校验（新装/覆盖/无法导入）→ 分类 → `/api/components/install-batch`，卸载已在 Vue）；
  - 移除 Vue 页面里所有「打开旧版」链接与提示（目标 / 路线图 / 设置 / 对话 / 资源库 / 版本），默认路径不再出现旧版入口；
  - 全路由冒烟：14 条默认路由均渲染 Vue 且 0 个 `ui=legacy` 链接；`?ui=legacy` 整站回退仍可渲染旧界面。
- ✅ 第 70 步：**验收归档**：14 条默认路由全部 Vue 渲染、默认页面 0 个旧版入口；`npm run test:ui` 204 项通过；`?ui=legacy` 整站回退可用；核心页面（`ui/pages`）与非核心 UI（`ui/panels` / `ui/plugins/builtin`）分两坨，用户插件在 `DATA_DIR/ui-plugins`（程序更新不覆盖）。

## 页面状态

| 页面 | 状态 | 回退方式 |
| --- | --- | --- |
| `#/studystats` 学习统计 | Vue 版默认；旧页保留 | `?ui=legacy#/studystats`，或 localStorage `sierxing-ui-studystats=legacy` |
| `#/g/:id/quests` 今日任务 | Vue 版默认；旧页保留 | `?ui=legacy#/g/:id/quests`，或 localStorage `sierxing-ui-quests=legacy` |
| `#/g/:id/ragbench` 检索增强评测 | Vue 版默认；旧页保留 | `?ui=legacy#/g/:id/ragbench`，或 localStorage `sierxing-ui-ragbench=legacy` |
| `#/library` 资源库 | Vue 版默认；只读 + 动作都已迁移 | `?ui=legacy#/library`，或 localStorage `sierxing-ui-library=legacy` |
| `#/outlib` 产出库 | Vue 版默认；只读 + 写操作都已迁移 | `?ui=legacy#/outlib`，或 localStorage `sierxing-ui-outlib=legacy` |
| `#/aitasks` 任务中心 | Vue 版默认；运行中/筛选/分组历史/停止/重试 | `?ui=legacy#/aitasks`，或 localStorage `sierxing-ui-aitasks=legacy` |
| `#/t/:id/quiz` 随堂测验 | Vue 版默认；完整迁移（追问改走常驻 AI 助手） | `?ui=legacy#/t/:id/quiz`，或 localStorage `sierxing-ui-quiz=legacy` |
| `#/g/:id/interview` 模拟面试 | Vue 版默认；完整迁移 | `?ui=legacy#/g/:id/interview`，或 localStorage `sierxing-ui-interview=legacy` |
| `#/g/:id/jd` 信息源导入 | Vue 版默认；完整迁移 | `?ui=legacy#/g/:id/jd`，或 localStorage `sierxing-ui-jdfile=legacy` |
| 教程书签浮动面板 | Vue 默认；旧面板回退 | `?ui=legacy#/t/:id`，或 localStorage `sierxing-ui-tutbookmark=legacy` |
| AI 输入框提示词弹窗 | Vue 默认；旧弹窗回退 | `?ui=legacy`，或 localStorage `sierxing-ui-aiprompts=legacy` |
| `#/t/:id/restate` 用自己的话 | Vue 版默认（主流程 + 架构导图 + 三栏拖拽） | `?ui=legacy#/t/:id/restate`，或 localStorage `sierxing-ui-restate=legacy` |
| `#/t/:id/explain` / `#/g/:id/explain` 看懂代码 | Vue 默认（列表/准备页 + 运行核心 + 拖拽/风格） | `?ui=legacy#/t/:id/explain`，或 localStorage `sierxing-ui-explain=legacy` |
| `#/g/:id/hot100` 每日刷题 | 每日页 + 题目详情核心 Vue | `?ui=legacy#/g/:id/hot100`，或 localStorage `sierxing-ui-hot100=legacy` |
| `#/p/:id` 题目详情 | Vue 核心（旧版入口保留） | `?ui=legacy#/p/:id` |
| 其余全部页面/面板（目标概览 / 路线图 / 教程 / 对话 / 设置子页 / 引导 / 版本 / 组件 / 资源库等） | **Vue 默认**（见目录树；页面 `ui/pages`、非核心面板 `ui/panels`） | `?ui=legacy#…` 或对应 localStorage 键 |

学习统计迁移只换 UI：数据仍走原 `/api/study/month` / `/api/study/day`；后台计时与上报逻辑不动。
今日任务迁移同样只换 UI：数据仍走原 `/api/quests*`，AI 排程接口不变。
检索评测迁移只换 UI：数据仍走原 `/api/goals/:id/bench/*` 与 `/api/bench/runs/:id`。
资源库只读与动作都走原接口：`/api/goals/:id`、`/sources`、`/digests`、`/sources/import`、`/sources/clean`、`/sources/refetch`、`/sources/digest`、`/rag/build`、导出；SSE 进度框只负责显示，关掉不停止后台任务。

## 当前可用

- 验证页：`http://localhost:3213/uilab.html`（无用户插件时回退内置 SFC；`?builtin=1` 强制内置）。
- 学习统计 Vue 页：`http://localhost:3213/?ui=vue#/studystats`（默认已启用；旧版加 `?ui=legacy`）。
- 构建：`npm run build:ui` → `public/ui-dist/`（构建产物提交，clone 后不装依赖也能跑）。
- 回归：`npm run test:ui`（204 项：构建产物 / manifest / 加载器 / 注册表安全 / 六十三个页面/面板接入 / 资源库、产出库、任务中心、随堂测验、模拟面试、信息源导入、书签面板、提示词弹窗、用自己的话、看懂代码、每日刷题、组件管理（含导入）、笔记面板、主页、番茄钟、版本管理、版本对比、外观主题、设置概览、AI 连接、数据备份、多端同步、检索增强、服务与更新、系统信息（含数据目录迁移）、使用引导（含首次运行自动跳转）、教程阅读与编辑（工具栏 / 历史版本 / 双击改块 / 整篇编辑）、教程生成、深度拆分、骨架确认与调整、重新规划、初始规划与空目标入口、路线图（勾选 / 节点编辑 / 添加 / 删除 / 文件夹 / AI 功能）、目标收藏栏（拖拽 / 隐藏 / 恢复）、分享导出、对话页（重命名 / 步骤文案 / 范围确认卡 / 节点附件 / 教程绑定 / 目标选择 / 全局入口）、目标概览全套接口）。

## 目录

```text
ui/
  lab/                 # 验证页
  pages/studystats/    # 学习统计（Vue SFC）
  pages/quests/        # 今日任务（Vue SFC）
  pages/ragbench/      # 检索增强评测（Vue SFC）
  pages/library/       # 资源库（只读 + 动作，Vue SFC）
  pages/outlib/        # 产出库（只读 + 写操作，Vue SFC）
  pages/aitasks/       # 任务中心（Vue SFC）
  pages/quiz/          # 随堂测验教程内页（Vue SFC）
  pages/interview/     # 模拟面试目标内页（Vue SFC）
  pages/jdfile/        # 信息源导入目标内页（Vue SFC）
  panels/tutbookmark/  # 教程书签浮动面板（Vue SFC，非页面组件）
  panels/aiprompts/    # AI 输入框提示词弹窗（Vue SFC，非页面组件）
  pages/restate/       # 用自己的话（主流程 + 高级交互，Vue SFC）
  pages/explain/       # 看懂代码（列表/准备页 + 运行界面核心，Vue）
  pages/hot100/        # 每日刷题每日页 + 题目详情核心（高级编辑经 legacy 回退）
  pages/components/    # 组件管理（全局/目标级开关、分类、导入/导出/卸载）
  pages/home/          # 主页（我的目标 / 新建 / 导入分享）
  pages/versions/      # 目标版本管理（列表/筛选/收藏/恢复）
  pages/diff/          # 版本对比图（左右两栏/变更标记/AI 汇报）
  pages/settings/      # 设置概览（只读；点卡片进各设置子页）
  pages/settings-ai/   # 设置 → AI 连接编辑（连接/模型/测试）
  pages/settings-data/ # 设置 → 数据备份（列表/对比/恢复/删除/导入导出）
  pages/settings-sync/ # 设置 → 多端同步（状态/设置/上传拉取/冲突）
  pages/settings-rag/  # 设置 → 检索增强（开关/向量模型/索引/检索预览）
  pages/settings-service/ # 设置 → 服务与启动（图标/终端命令/自启）
  pages/settings-update/ # 设置 → 版本与更新（检查/更新/重启）
  pages/settings-system/ # 设置 → 系统信息（存储状态/目录迁移/帮助/关于）
  pages/guide/          # 使用引导（#/guide/:step 六步）
  pages/tutorial/       # 教程阅读页（正文/目录/手动编辑/工具栏/历史版本）
  pages/map/            # 路线图（大纲/节点详情/勾选/编辑/添加/删除/文件夹/AI 功能）
  pages/goal/           # 目标概览（Vue 收藏栏/任务/编辑/约束/问卷/教程/拆分/骨架/重新规划/分享）
  pages/chat/           # 对话页（会话/流式/重命名/范围确认卡/节点附件/教程绑定/目标选择）
  pages/settings-theme/ # 设置 → 外观主题（显示模式 / 亮暗主题皮肤）
  panels/notes/        # 教程页右侧笔记面板（Markdown 页签 Vue；划线页签委托 TutNotes）
  panels/pomodoro/     # 番茄钟可见 UI（状态机仍在 public/plugins/pomodoro.js）
  sdk/                 # 宿主契约：host.js / loader.js
  plugins/builtin/     # 内置非核心 UI（随程序更新，可被同 id 用户插件覆盖）
examples/ui-plugins/   # 示例插件（不自动安装）
DATA_DIR/ui-plugins/   # 真正的用户插件目录（更新永不覆盖）
public/ui-dist/        # Vite 构建产物（多入口 + 共享 Vue chunk）
```

安装示例插件：

```bash
cp -r examples/ui-plugins/home "<你的数据目录>/ui-plugins/"        # 整页接管首页（推荐先看这个）
cp -r examples/ui-plugins/demo-card "<你的数据目录>/ui-plugins/"   # UI Lab 卡片示例
# 目标：DATA_DIR/ui-plugins/demo-card/
```

数据目录默认是程序目录下 `data/`；可在「设置 → 数据存储路径」迁移。测试沙箱可用 `SIERXING_DATA_DIR=/tmp/...` 临时覆盖。

## 服务端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ui/plugins` | 列出合法用户插件（id/name/apiVersion/version/entry/source） |
| GET | `/api/ui/plugins/:id/manifest` | 返回单个插件 manifest；不存在 404 |
| GET | `/api/ui/plugins/:id/entry` | 返回入口 JS（`application/javascript`），只允许插件目录内文件 |

安全边界（`server/ui-plugins.js`）：

- id 只允许 `[a-z0-9._-]`，且必须等于目录名；
- entry 必须是插件目录内的 `.js/.mjs`，拒绝 `..`、绝对路径、符号链接逃逸；
- manifest ≤ 64KB、入口 ≤ 5MB；
- 坏 JSON / 缺 manifest / 目录不匹配 → 跳过，不影响其他插件。

P0–P3 新增接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/kernel | 内核状态：apiVersion、服务清单、每个插件的 loaded/skipped/failed、分层配置与升级差异 |
| GET | /api/ui/plugins | 列表（内置 + 用户，含 source / builtin / enabled / format / standalone） |
| GET | /api/ui/plugins/:id/manifest | 原始 manifest 文本（manifestRaw） |
| POST | /api/ui/plugins/:id/state | { enabled: false } 停用/启用（写 .state.json，不删文件；内置不可停用） |
| POST | /api/ui/plugins/open-dir | 打开用户插件目录（NO_OPEN=1 时只返回路径） |

## 宿主契约

- 全局：`window.SiErXingUI`，当前 `api: "sierxing.ui/1"`。
- 提供 `vue`（h/ref/reactive/computed/watch/生命周期）与 `toast`。
- 插件只通过宿主 SDK 访问能力，不直接摸 `app.js` 内部变量。
- 加载顺序：用户插件 → 内置组件；版本不兼容 / 加载失败 / 渲染异常均回退。

用户页面插件三种入口（完整契约见 kernel-contract.md）：

1. ESM + Vue 组件（export default，免构建，推荐）——Vue 来自 window.SiErXingUI.vue，**不要 import 'vue'**；
2. ESM + export function mount(root, ctx) 返回 unmount；
3. 经典脚本 + window.SXUIPlugin[page] = { mount(host), render() }。

宿主桥按需加载 /ui-dist/uihost.js（只有装了 Vue 插件才加载）；用户插件实例在离开路由时自动卸载；
standalone: true 的插件不再注入内置页面样式；任何异常都静默回退内置页面。

## 迁移页面细节

- 新页面：`ui/pages/studystats/App.vue`，由 `public/plugins/studystats.js` 动态加载 `/ui-dist/studystats.js` 并挂到 `#app`。
- 默认走 Vue 版；加载失败自动回退旧 `renderStatsPage()`。
- 保留旧版用于对照与紧急回退；验证通过后再移除。
- 数据接口保持不变：`/api/study/month?month=YYYY-MM`、`/api/study/day?day=YYYY-MM-DD`。
- 样式暂复用 `public/plugins/studystats.css`（后续随页面迁移逐步收进插件）。

## 后续可选（不影响本目标）

1. ~~UI 插件安装器接 UI~~ 已完成：左栏「🧱 界面管理」（#/ui-plugins）可启停 / 打开目录 / 看内置版；
2. 内核瘦身（P4）不做：内核只是容器 + 启动器，不搬 server.js / app.js；
3. 任务中心自定义时间范围、每日刷题高级编辑等小口子按需补齐。

## 升级不冲突规则

- 用户插件放 `DATA_DIR/ui-plugins/`，程序更新不触碰；
- 同 id 用户插件覆盖内置插件；不兼容/加载失败自动回退；
- 路由、插槽、事件、主题变量版本化；
- 分层配置（builtin < profile < user）：用户只写要改的键，我们删键时旧配置只告警不生效；
- 插件 apiVersion 主版本不一致 → incompatible 跳过；缺依赖 → skipped，不阻断启动；
- DATA_DIR/kernel/builtin-snapshot.json 记录配置键 / 插件 id，升级时给出增删差异；
- 详见 kernel-contract.md「升级不冲突的六条机制」。
- UI 插件安装/构建走审批 + 暂存 + 回滚（后续步骤复用现有组件管线）。

## 验收记录（第 69–70 步）

| 检查 | 结果 |
| --- | --- |
| 默认路由渲染 | 14/14 路由 `#app` 非空、渲染对应 Vue 页（首页 / 学习统计 / 目标 / 路线图 / 对话 / 版本 / 版本对比 / 设置 / 系统信息 / 组件 / 资源库 / 任务中心 / 教程 / 引导） |
| 默认页面旧版入口 | `#app` 内 0 个 `href*=ui=legacy` 链接、0 处「旧版」文案 |
| 全量回归 | `npm run test:ui`：构建/集成 197 + 注册表 7 = **204 项通过** |
| 构建 | `npm run build:ui` 通过，产物 `public/ui-dist/`（入口 JS 35 个） |
| legacy 回退 | `?ui=legacy#/components`（`#cmpImport` 存在）、`?ui=legacy#/library`、`?ui=legacy#/g/166` 均可渲染旧界面 |
| 插件隔离 | 用户插件 `DATA_DIR/ui-plugins/<id>/`；内置在 `ui/plugins/builtin`；同 id 用户插件覆盖、加载失败回退 |
| 结构分组 | 核心页面 `ui/pages/*/App.vue`（30 个），非核心 UI `ui/panels/*` + `ui/plugins/builtin/*`；宿主契约 `ui/sdk` |

## 已知限制

- 默认路径已全部迁移。迁移了主页、学习统计、今日任务、检索增强评测、资源库（只读 + 动作）、产出库（只读 + 写操作）、任务中心、随堂测验、模拟面试、信息源导入、用自己的话（主流程 + 高级交互）、看懂代码（列表/准备页 + 运行核心 + 拖拽/风格）、每日刷题（每日页 + 题目详情核心）、组件管理（含导入/卸载）、版本管理与版本对比、设置页全部子页（含数据目录迁移）、使用引导页（首次运行自动进 Vue 引导）、教程阅读页与编辑入口（Vue 工具栏 / 历史版本 / 双击就地改块 / 整篇手动编辑）、教程生成、深度拆分、规划骨架确认与调整、重新规划、路线图（勾选 + 节点编辑/添加/删除 + 文件夹 + AI 功能）、目标概览（Vue 收藏栏 + 组件入口 / 任务勾选 / 编辑 / 约束 / 问卷 / 初始规划 / 生成教程 / 拆分 / 骨架确认与调整 / 重新规划 / 分享 / AI 入口）、对话页（会话 / 历史消息 / 流式发送 / 重命名 / 步骤文案 / 范围确认卡 / 节点附件 / 教程绑定 / 目标选择）、全局 AI 入口（默认进 Vue 对话页，旧抽屉仅 legacy 回退）、教程笔记面板、番茄钟可见 UI，以及教程书签、提示词库两个浮动面板。默认路径上的 UI 已全部 Vue 化；`?ui=legacy` 作为整站回退保留。
- 任务中心的自定义时间范围（from/to）暂未迁，仍可用旧版回退页。
- 页面插件安装已接「界面管理」页（启停 / 打开目录）；服务端组件仍走「组件」页导入管线，没有可视化构建器。
- 插件入口是运行时 ESM、免构建（示例 examples/ui-plugins/home）；.vue 源码要自己用 Vite 构建成 index.js 再放进来。