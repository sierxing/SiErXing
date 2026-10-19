# 提示词模板（language/prompts）—— 改提示词先看这里

这个目录是**提示词正文的唯一存放处**。服务端代码（`server/prompts/*.js`、`server.js`）只保留
「怎么取数据、怎么拼接、怎么调 AI」的**动态逻辑**，不再保存提示词正文。

> 一句话规则：**新增/修改提示词 → 改 `zh-CN/packs.json`；不要写回 `server.js` / `server/prompts/*.js`。**

---

## 1. 目录结构

```
language/prompts/
├── index.js              读模板的加载器（纯 Node，零第三方依赖）
├── README.md             本文件
└── zh-CN/
    └── packs.json        源语言：全部内置提示词模板（必须齐全）
```

以后要加别的语言，就在 `language/prompts/` 下建同名语言目录：

```
language/prompts/
├── en-US/packs.json      只写要覆盖的 id（可只写一小部分）
└── ja-JP/packs.json
```

- `zh-CN` 是**源语言**：所有模板都必须先在 `zh-CN/packs.json` 里存在。
- 其它语言是**覆盖层**：`packs.json` 里没写的 id 自动回退 `zh-CN`；文件/目录不存在也回退。
- `index.js` 的 `locales()` 会列出 `language/prompts/` 下现有的语言目录。

---

## 2. `packs.json` 的格式

一个 JSON 对象：**key = 提示词包 id，value = 模板字符串**。

```json
{
  "sources.digest_batch": "你是资料提炼助手……\n{{items}}",
  "chat.ask_rules": "0. **当前是「ASK 提问模式」**……"
}
```

硬性约定：

1. **value 必须是字符串**，不是数组、不是对象。
2. JSON 里不能写裸换行：换行一律用 `\n`（JSON 的标准转义）。中文直接写，文件按 UTF-8 保存。
3. `{{x}}` 是占位符，**名字和数量由 `server/prompts/*.js` 里该包的 `placeholders` 声明**；
   改正文时不要改占位符名字、不要漏掉任何一个，否则 `prompt.validate` / `prompt.update` 会拒绝。
4. 每个包的 `mustInclude` 关键片段（同样声明在 `server/prompts/*.js`）也不能删；
   现有回归 `scripts/test-prompt-packs.js` 会逐条校验。
5. **正文逐字迁移，不要顺手润色**：模板要和原 builder 的输出保持一致（见 §5）。
6. 不要加注释、不能有尾逗号 —— 它必须是能被 `JSON.parse` 读的合法 JSON。

当前共 11 个 key：

| id | 用途 | 所在包元数据 |
| --- | --- | --- |
| `sources.digest_batch` | 资料提炼（单批） | `server/prompts/packs.js` |
| `sources.digest_synthesis` | 资料提炼（多批汇总） | `server/prompts/packs.js` |
| `chat.ask_rules` | 对话 ASK 模式硬规则 | `server/prompts/packs.js` + `chat-packs.js` |
| `chat.agent_rules` | 对话 Agent 模式规则（含 `{{tutorialEditOp}}`） | `server/prompts/packs.js` + `chat-packs.js` |
| `chat.tutorial_edit_op` | `tutorial_edit` 操作块（`TUTORIAL_EDIT_OP` 的正文） | `server/prompts/chat-packs.js` |
| `plan.clarify` | 规划前问卷 | `server/prompts/plan-packs.js` |
| `plan.skeleton` | 路径骨架 | `server/prompts/plan-packs.js` |
| `sources.collect_plan` | 资料搜集方案 | `server/prompts/sources-packs.js` |
| `sources.ebook_recommend` | 入门书单 | `server/prompts/sources-packs.js` |
| `sources.clean` | 网页正文清洗 | `server/prompts/sources-packs.js` |
| `tutorial.generate` | 教程生成 | `server/prompts/tutorial-packs.js` |

> ⚠️ `chat.tutorial_edit_op` 与 `chat.agent_rules` 里 `{{tutorialEditOp}}` 那一行是**同一段正文的两份拷贝**：
> 前者供 `TUTORIAL_EDIT_OP` / `tutorialSample()` / `prompt.preview` 的样例用，后者是拼进
> `agentRules()` 的插槽。**要改这段 tutorial_edit 说明，两边一起改**，否则覆盖前后的行为会不一致。
> `{{tutorialEditOp}}` 必须单独占一行。

---

## 3. 加载器 API（`language/prompts/index.js`）

```js
const { templates, template, locales, clearCache } = require('../../language/prompts');
```

| API | 行为 |
| --- | --- |
| `templates()` | 读取并缓存 `zh-CN/packs.json`，返回整个对象 |
| `templates(locale)` | 读取该语言的 `packs.json`；文件不存在返回 `{}`（不回退合并） |
| `template(id)` | 取 `zh-CN` 里的模板字符串；找不到抛错，错误信息带 id |
| `template(id, locale)` | 先取该语言；该语言没有这个 id 时**回退 zh-CN**；都找不到抛错，错误信息带 id |
| `locales()` | 列出 `language/prompts/` 下的语言目录（排序） |
| `clearCache()` | 清读取缓存（测试用；正常改完 JSON 重启进程即可） |

行为约定：

- 读取结果按语言缓存，进程运行期间不会反复读盘。
- `zh-CN/packs.json` 缺失或 JSON 损坏 → **直接抛错**（源语言不允许静默降级）。
- 其它语言的 `packs.json` 缺失 → 视为「没有该语言的覆盖」，逐个 id 回退 `zh-CN`；
  但文件存在却 JSON 损坏时会抛错（改坏了要立刻发现，不要假装没写）。
- 语言代码会做合法性校验（如 `zh-CN` / `en-US`），防止拼出目录外的路径。
- `language/index.js` 里的 `promptTemplates(code)` 读的是**同一份文件**（供语言状态/生成流程用），
  格式保持一致，不要另起一套。

---

## 4. 改提示词 / 加提示词的正确姿势

### 改一段正文

1. 改 `language/prompts/zh-CN/packs.json` 里对应 id 的字符串（保留全部 `{{占位符}}` 与 `mustInclude`）。
2. 如果对应包的 `builtinRender` 仍是原 builder（见 §5），把 builder 里同一段正文也改掉并保持逐字一致。
3. 跑回归：

   ```bash
   node --check server/prompts/packs.js
   node --no-warnings scripts/test-prompt-packs.js
   ```

4. 重启服务进程（模板在模块加载时读取并缓存）。

### 加一个新的提示词包

1. **先想清楚哪些是动态的**：取数据库、取资料、异步等逻辑留在 `server/prompts/<xxx>-packs.js`
   的 `builtinRender`（或 `server/prompts/digest.js` 这类纯函数）里；**正文**进 JSON。
2. 在 `language/prompts/zh-CN/packs.json` 加一个 key（id 建议 `领域.动作`，如 `plan.clarify`）。
3. 在对应的 `server/prompts/*-packs.js` 里登记包元数据：
   `id / title / description / editable / placeholders / mustInclude / template / sampleCtx`，
   其中 `template: template('<id>')`。
4. 需要动态注册的，在 `server.js` 启动时 `promptPacks.register(def)` 并补 `builtinRender`
   （**这一步只加注册代码，不要把正文写进 server.js**）。
5. 新增的语言目录同理：只放要覆盖的 id。

### 禁止的做法

- ❌ 在 `server.js` / `server/prompts/*.js` 里新写一段提示词正文常量。
- ❌ 在 JSON 里改占位符名（如把 `{{goalHeader}}` 改成 `{{goal}}`）而不改包元数据。
- ❌ 为了「读起来顺」删掉 `mustInclude` 里的契约片段（JSON、`stages`、`EMPTY` 等）。
- ❌ 在别的目录再建一份 `packs.json` 或另一套提示词加载逻辑。

---

## 5. 与 registry（覆盖 / 版本 / 校验）的关系

`server/prompts/registry.js` 的模型是：

```
内置模板（builtin, version 1）  = language/prompts/zh-CN/packs.json 里的 template
用户覆盖（override, version≥2） = prompt_packs 表里的 template（prompt.update 写入，需用户批准）
```

- **没有覆盖**：`render(id, ctx)` 走该包的 `builtinRender`，行为与重构前一致；
  `preview(id, ctx)` 则用 JSON 里的 `template` + `sampleCtx` 渲染给人看。
- **有覆盖**：`render` / `renderAsync` 用覆盖模板；`prompt.reset` 删除覆盖，回到内置模板（version 1）。
- **历史**：每次 update/reset 都会往 `prompt_pack_versions` 写一条，可回看。
- **校验**：`prompt.validate` 检查 `placeholders` 是否齐全、`mustInclude` 是否还在；
  这些元数据在 `server/prompts/*-packs.js` 里，**不在 JSON 里**，所以加占位符要两边都改。

### 为什么「内置模板」与「builder」必须保持一致

回归 `scripts/test-prompt-packs.js` 会断言：

- 资料提炼两个包：内置模板渲染结果 **逐字等于** 原纯函数 `digestBatchPrompt` / `digestSynthesisPrompt`；
- chat 两个包：`render` 结果 **逐字等于** `askRules()` / `agentRules()`；
- 所有规划/资料/教程包：`template` 非空、`placeholders` 全部出现、`mustInclude` 全部出现。

如果只改 JSON、不改 builder（或反过来），会出现最难排查的一类问题：

- **预览是一个样、实际运行是另一个样**（没覆盖时走 builder，覆盖后才走 JSON）；
- 用户把模板 reset 回内置后，行为和「内置模板」展示的内容对不上；
- 回归直接红，或者更糟：回归绿但 `preview` 与真实提示词悄悄分叉。

**当前各包的 builtin 来源**（改正文时对着看）：

| 包 | 未覆盖时实际用的 builder | 改正文要动哪里 |
| --- | --- | --- |
| `chat.ask_rules` / `chat.agent_rules` | `chat-packs.js` 的 `askRules()` / `agentRules()`，**已经直接读本目录 JSON** | 只改 JSON |
| `sources.digest_batch` / `sources.digest_synthesis` | `server/prompts/digest.js` 的 `digestBatchPrompt` / `digestSynthesisPrompt` | JSON + `digest.js` |
| `plan.clarify` / `plan.skeleton` | `server.js` 的 `buildClarifyPrompt` / `buildSkeletonPrompt` | JSON + 对应 builder |
| `sources.collect_plan` / `ebook_recommend` / `clean` | `server.js` / 清洗流程里的原 builder | JSON + 对应 builder |
| `tutorial.generate` | `server.js` 的 `buildTutorialPrompt` | JSON + `buildTutorialPrompt` |

> 长期方向：逐步让 `builtinRender` 也直接渲染 JSON 模板（填好动态块），最终做到「只改 language/
> 就生效」。在完成那一步之前，上表就是必须同步改的清单。

---

## 6. 已知边界

- 模板在进程启动时读取并缓存；**改完 JSON 要重启服务**才会生效（`clearCache()` 只对同进程的
  require 方有用）。用户如果通过 `prompt.update` 覆盖，覆盖存在数据库里，升级不会覆盖。
- `string` 里的 `\n` 是正文的一部分，别在格式化/压缩 JSON 时把它变成裸换行或删掉。
- JSON 很长（单个模板上千字）时，不要用「查找替换整个文件」的方式批量改，容易误伤别的模板；
  改哪个 id 就只动那个 value。
- 模板里出现的 `{{...}}` 在未覆盖时不会被 registry 替换（走 builder）；只有覆盖模板会替换。
  所以示例/占位符要按「覆盖后如何使用」来写。
