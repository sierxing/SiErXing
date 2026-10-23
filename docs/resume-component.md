# 简历工坊（resume）—— 一步一步的简历工作流

> 思而行里的「写简历 / 改简历 / 投递版本」组件。
> **入口在目标页顶栏（收藏栏）的「📄 简历工坊」按钮，点开是整页 `#/g/:id/resume`** —— 和「🎯 达成条件」同一套形态，不是右下角浮窗/右侧抽屉。
> **开关按目标隔离**（`goalToggle:true`）：每个目标可以单独开关；关掉只隐藏入口，**数据是全目标共享的一份简历库**（换目标看到同一份）。
> 设计目标：用户每一步只做一件事；同样的步骤 Agent 也能通过命令 / MCP 逐步调用。

## 0. 参考的开源项目（用户给出的四个链接）

| # | 链接 | 借鉴的工作流思想 |
|---|------|------------------|
| 1 | https://github.com/Elowwwen/resume-evidence-workflow | 经历证据库、追问式经历盘点、JD-证据匹配矩阵、区分事实/估计/解释、改写依据可回看 |
| 2 | https://github.com/zclllyybb/lofisu-identity-engine | 身份/定位：先确定「我是谁、卖给谁」，再决定简历主线与素材取舍 |
| 3 | https://github.com/Claycui828/ASu-resume-skills | 高密度履历生成 + 证据优先审计：原子主张、证据等级、夸大模式（角色/范围/指标口径/时态） |
| 4 | https://github.com/Elowwwen/resume-evidence-workflow | 用户给出的四个链接中第 4 个与第 1 个相同（重复引用），描述与「关于」区按原样列出 |

> 参考的是**工作流思想**，没有复制上述仓库代码；实现、提示词、数据结构按思而行的组件规范重写。

## 1. 六步流水线（一次只做一件事）

| 步 | stage | 用户看到什么 | 做什么 | Agent 命令 |
|----|-------|--------------|--------|------------|
| 1 | `upload` | 虚线拖放框 | **把简历文件拖进来**（.docx / .pdf / .txt / .md）或粘贴正文 | `resume.upload` |
| 2 | `review` | 问题清单（严重/中等/轻微 + 位置 + 怎么改） | AI 审查，**不改简历** | `resume.review` |
| 3 | `supplement` | 追问列表 + 回答框 | 回答 AI 追问 → 自动整理成证据卡并入库 | `resume.questions` → `resume.answer` |
| 4 | `jd` | 资料库里的 JD 列表 | **直接从资料库选 JD**（不用重贴），或粘贴 | `resume.jd` |
| 5 | `match` | 要求-证据矩阵 | 逐条匹配 + 证据空白 + 补强建议 | `resume.match` |
| 6 | `finalize` | 终版简历预览 | AI 改写 + 排版 → 可**导出 .docx** | `resume.finalize` / `resume.export` |

每步都能单独调用、也能「上一步/下一步」跳转；进度落在 `resume_docs.stage`，刷新/换设备/换 Agent 都接得上。

## 2. 文件支持

- **读**：`.docx`（zip + `word/document.xml`，表格按单元格拆）、`.pdf`（复用 `ebook-parse`，无文字层会明确提示）、`.txt` / `.md`（UTF-8 / GBK / UTF-16 BOM）
- **写**：`.docx`（最小 OOXML，STORE 模式 zip，Word / WPS / LibreOffice 都能打开）
- 零依赖，实现在 `server/plugins/lib/resume-file.js`（`parseResumeBuffer` / `markdownToDocx`）

## 3. 数据（本机 SQLite）

- `resume_docs`：一份简历（正文 / 目标岗位 / 当前 stage / 来源文件名 / 问题清单 / 回答 / JD / 匹配矩阵 / 终版正文）
- `resume_evidence`：经历证据卡（title / org / role / period / situation / task / action / result / scope / metrics / source / tags）
- `resume_versions`：版本快照（note / stage / content）
- `resume_reports`：每次 AI 动作的报告（kind / jd_text / output_json）

删除简历级联清理证据/版本/报告。**删除目标不级联删简历**：简历库全目标共享（前端列表接口不带 `goalId` 就返回全部文档），`onGoalDelete` 是空实现 —— 否则删一个目标会把大家共用的简历一起删掉。

## 4. 领域与接口

领域层 `server/resume-domain.js`（组件 API 与命令总线**共用一套**，避免逻辑漂移）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/resume/docs` | 列表（`?goalId=`）/ 新建 |
| GET/PUT/DELETE | `/api/resume/docs/:id` | 详情（含证据/版本/报告索引）/ 保存 / 删除 |
| GET | `/api/resume/docs/:id/pipeline` | 六步状态 + 当前 step + JD 候选 |
| POST | `/api/resume/docs/:id/upload` | 上传简历文件（`{filename, base64}`）或正文（`{text}`） |
| POST | `/api/resume/docs/:id/jd` | 选 JD（`{sourceId}`）或贴文本（`{jd}`） |
| POST | `/api/resume/docs/:id/ai` | `{kind}`：review / questions / answers / match / rewrite / finalize / audit |
| GET/POST | `/api/resume/docs/:id/evidence` | 证据卡列表 / 批量新增 |
| PUT/DELETE | `/api/resume/evidence/:id` | 改 / 删证据卡 |
| POST | `/api/resume/docs/:id/versions`、`/api/resume/versions/:id/restore` | 存版本 / 恢复（恢复前自动存当前） |
| GET | `/api/resume/docs/:id/reports`、`/api/resume/reports/:id` | 历史分析 |
| GET | `/api/resume/docs/:id/export` | 下载 `.docx` |

错误只回 `code`（`need_title / need_file / unsupported_format / no_text_layer / need_resume / need_jd / need_answers / need_final / ai_failed`），文案由前端 `tr()` 组装。

## 5. Agent 调用（MCP / 命令总线）

Agent 收到用户发来的简历文件后，可以直接跑完整条链（每步都可以停下来问用户）：

```
resume.docs   {goalId}                              # 有没有已有简历、进行到哪一步
resume.create {goalId, title, target_role}
resume.upload {docId, filename, base64}             # 用户发来的 .docx/.pdf 直接传进来
resume.review {docId}                               # → issues + missing（不改简历）
resume.questions {docId}                            # → 追问列表
resume.answer {docId, answers:[{id,q,a}]}           # → 证据卡并入库
resume.jd     {docId}                               # 不传参数 = 列出资料库里的 JD
resume.jd     {docId, sourceId} 或 {docId, jd}      # 选中 JD
resume.match  {docId}                               # → 要求-证据矩阵 + 缺口
resume.finalize {docId}                             # → 终版 Markdown
resume.export {docId}                               # → base64 .docx（由 Agent 交给用户）
resume.get    {docId, withBody:true}                # 读完整状态
```

MCP 工具名：`resume_docs` / `resume_create` / `resume_upload` / `resume_review` / `resume_questions` / `resume_answer` / `resume_jd` / `resume_match` / `resume_finalize` / `resume_export` / `resume_get`（点号→下划线）。

## 6. 提示词包（可在「提示词库」里覆盖）

| id | 作用 |
|----|------|
| `resume.review` | 审查问题清单（定位/证据/指标/关键词/结构/时态） |
| `resume.questions` | 追问信息缺口 |
| `resume.answers` | 回答 → 证据卡 |
| `resume.match` | JD 拆解 + 要求-证据矩阵 |
| `resume.rewrite` | 逐条定向改写（依据 + 风险） |
| `resume.finalize` | 改写 + 排版成终版（不新增事实、指标要口径） |
| `resume.audit` | 原子主张 + 五档证据状态 + 夸大模式 |
| `resume.evidence` | （旧）回答 → 证据卡，保留兼容 |

模板正文在 `language/prompts/zh-CN/packs.json`；无覆盖时 `fill` 填占位符。

## 7. 测试

```bash
npm run test:resume     # node --no-warnings --experimental-sqlite scripts/test-resume-component.js
```

41 项：组件元数据（含四个参考链接）、docx 往返解析、领域纯函数、HTTP e2e（上传/pipeline/JD/finalize/export/证据/版本/报告/删除级联）、**按目标开关**（出现在目标级清单里 / 只写本目标 / 不串全局与别的目标）、**删目标不删共享简历**、**Agent 命令全链路**。AI 走 `SIERXING_RESUME_FAKE=1` 假实现，不花钱不联网。

```bash
npm run test:resume-page   # 无头浏览器：顶栏入口 → 整页 → 目标级开关（关A不影响B）
```

16 项：顶栏有 `goalComp_resume` 入口、点开是 `#/g/:id/resume` 整页且**没有抽屉/蒙层**、六步步骤条 6 个、返回目标、关掉目标 A 后 A 无入口且直开页面显示「已关闭」空状态、目标 B 不受影响、全局值不被目标级开关串掉、目标级清单包含 resume、重新打开仍整页无残留、全程无 JS 异常。

## 8. 已知边界

- 只做纯文本解析，不保留原简历排版（排版由 finalize 重新生成）；扫描版 PDF 需要先截图识别。
- 审计只在「简历 + 证据卡」范围内核验，不联网核验学历/奖项/开源链接。
- 终版是 Markdown → docx 的简单排版（无图片/表格样式）；需要更精细排版时可再导出 Word 手动调整。

## 9. 三项「可核验增强」（汲取 ASu 与 lofisu，2026-10-23 追加）

| 能力 | 实现 | 为什么值钱 |
|---|---|---|
| **机构 Title**（ASu 的学校 Title 增强） | `language/school-titles.js`：211 / 985 / 双一流 / 部委直属标签库 + `detectFromResume()` 从简历识别学校。只写确定事实，未知学校返回 `null` 不猜 | 「中国石油大学（北京）」→「211工程｜双一流（一流学科建设高校）｜教育部直属」，纯可核验加分项 |
| **Owner 化拆分**（ASu 的角色强度） | `language/resume-enhance.js` 的 `roleLadder()`：把「独立完成 / 主要负责 / 参与 / 计划」映射成允许的角色词 + **边界要求**。提示词要求「先找最小闭环，只对这个闭环用 Owner」 | 解决「独立完成」写得太大、面试被追问的问题 |
| **技术链**（ASu 的技术链拆解） | `techChainHints()` + 「输入 → 表征 → 规划 → 工具 → 状态 → 评测」六段说明进提示词 | 把功能清单改写成链路，一眼看出产品理解 |
| **定位先行**（lofisu） | `finalize` 的 `title` = 岗位意向 + 最强卖点；`summary` 三句（定位/方法论/匹配） | 开头一句话抓住人 |

以上通过 `buildCtx().enhance` 注入 finalize / review 提示词（占位符 `{{enhance}}`）。

### 9.1 内容硬过滤（代码级，不信提示词）

用户要求「某段经历不写进简历」时，只靠提示词会反复写回（实测同一个提示词两次，一次删了、一次又写回去）。所以：

- `resume_docs.excluded` 存排除词（JSON 数组）；`resume.exclude` 命令 / `PUT /api/resume/docs/:id {excluded}` 设置；
- `language/resume-filter.js` 的 `filterData()` 在 finalize **落库前**做硬过滤：sections / items / summary / title / name / contacts 全覆盖；
- 被移除的条目会写进 `removed` 让用户知道原因；
- 排除词为空时不误删。
