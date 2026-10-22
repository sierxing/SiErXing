# 简历工坊（resume）—— 扩展组件设计说明

> 思而行里的「写简历 / 改简历 / 投递版本管理」AI 工作流组件。
> 组件 id：`resume`；服务端 `server/plugins/resume.js`，前端 `public/plugins/resume.js` + `public/plugins/resume.css`；
> 数据全部存本机 SQLite（路径与思而行一致，不上传）；AI 提示词在 `language/prompts/zh-CN/packs.json` 的 `resume.*` 五个包里，可在「提示词库」里覆盖。

## 0. 参考的开源项目（用户给出的四个链接）

| # | 链接 | 借鉴的工作流思想 |
|---|------|------------------|
| 1 | https://github.com/Elowwwen/resume-evidence-workflow | 经历证据库（Markdown 证据卡）、追问式经历盘点（先盘点再投递）、JD-证据匹配矩阵、区分事实/估计/解释、改写依据可回看、基础简历/版本管理 |
| 2 | https://github.com/zclllyybb/lofisu-identity-engine | 身份/定位视角：先确定「我是谁、卖给谁」，再决定简历主线与素材取舍（本组件落在「目标岗位 + 证据卡 + 匹配矩阵」这条链上） |
| 3 | https://github.com/Claycui828/ASu-resume-skills | 「高密度履历生成 × 证据优先审计」：原子主张、证据等级、夸大模式（角色膨胀/范围膨胀/指标口径/团队成果归个人/时态）、证据状态五档 |
| 4 | https://github.com/Elowwwen/resume-evidence-workflow | 用户给出的四个链接中第 4 个与第 1 个相同（重复引用）；组件描述与界面「关于」区都按用户给的原样列出四个链接 |

> 这是**工作流思想的参考与重组**，没有复制上述仓库的代码；组件实现、提示词、数据结构都是按思而行的组件规范重写的。

## 1. 它解决什么问题

AIPM / 求职实习最常见的两个死循环：
1. 「简历没东西写」——其实是经历没被挖出来（只有动作、没有个人边界与结果口径）。
2. 「投了 60 家没面试」——用一份通用简历盲投，没有按 JD 做证据匹配与定向改写。

所以组件做成四步闭环：

```
简历正文 →（AI 追问挖经历）→ 经历证据库 →（贴 JD）→ 匹配矩阵 →（按缺口补证据）→ 定向改写 →（证据审计）→ 定稿/存版本
```

## 2. 功能与页面

右下角「📄」浮动入口（组件管理里可开关；默认开启）。抽屉面板四个页签：

| 页签 | 做什么 | 对应参考 |
|------|--------|----------|
| 📝 简历 | 简历正文编辑、目标岗位、存版本/恢复、复制正文 | resume-evidence-workflow 的基础简历/版本 |
| 🧾 经历证据 | AI 追问 → 用户回答 → AI 整理成结构化证据卡；证据卡 CRUD；一键导入 | resume-evidence-workflow 的 evidence schema + 追问；lofisu 的定位上下文 |
| 🎯 JD 匹配与改写 | 贴 JD → 要求-证据矩阵（直接/相邻/薄弱/空白）→ 缺口与动作；按 JD 改写（每条给依据与风险） | resume-evidence-workflow Stage B/D；ASu 高密度写法 |
| 🔍 证据审计 | 把简历拆成原子主张，逐条给证据状态（已证实/部分证实/存在直接矛盾/缺乏支持/暂不可核验），标出夸大模式与待补证据 | ASu-resume-audit-skill |

深链接：`?resume=1` 或 `#/resume` 会自动打开面板。

## 3. 数据模型（SQLite，全部本机）

- `resume_docs`：简历文档（goal_id / title / target_role / content_md / 时间）
- `resume_evidence`：经历证据卡（title / org / role / period / situation / task / action / result / scope / metrics / source / tags）
- `resume_versions`：简历版本快照（note / content_md / 时间）
- `resume_reports`：AI 分析报告（kind / jd_text / output_json / 时间）

删除简历会级联删除证据卡/版本/报告；目标删除时 `onGoalDelete` 会清掉挂在该目标上的简历文档。

## 4. HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/resume/docs` | 简历列表（可带 `?goalId=`） |
| POST | `/api/resume/docs` | 新建（title 必填） |
| GET/PUT/DELETE | `/api/resume/docs/:id` | 详情（含证据/版本/报告索引）/ 保存 / 删除 |
| POST | `/api/resume/docs/:id/versions` | 存版本 |
| POST | `/api/resume/versions/:id/restore` | 恢复版本（会先自动存一份当前正文） |
| GET/POST | `/api/resume/docs/:id/evidence` | 证据卡列表 / 批量新增（≤10 张） |
| PUT/DELETE | `/api/resume/evidence/:id` | 改 / 删证据卡 |
| POST | `/api/resume/docs/:id/ai` | `{kind}`：questions / evidence / match / rewrite / audit |
| GET | `/api/resume/docs/:id/reports` | 历史分析列表 |
| GET/DELETE | `/api/resume/reports/:id` | 报告详情 / 删除 |

错误回 `{error, code}`（code 如 `need_title` / `need_jd` / `need_answers` / `ai_failed`），文案由前端 `tr()` 组装；服务端组件不写中文界面文案（见 `language/plugin-meta.js` 与 `language/resume-labels.js` 的说明）。

## 5. AI 提示词包（可在「提示词库」里覆盖）

| id | 作用 | 占位符 |
|----|------|--------|
| `resume.questions` | 通读简历+证据卡，找出信息缺口并提 6-8 个追问 | targetRole / resume / evidence |
| `resume.evidence` | 把口语回答整理成结构化证据卡（区分事实/估计/解释） | targetRole / answers |
| `resume.match` | JD 拆解 + 要求-证据匹配矩阵（direct/adjacent/weak/gap） | targetRole / jd / resume / evidence |
| `resume.rewrite` | 按 JD 定向改写（不新增事实、不升级角色、指标要有口径） | targetRole / jd / resume / evidence |
| `resume.audit` | 原子主张 + 证据状态 + 夸大模式 + 待补证据 | targetRole / resume / evidence |

模板正文在 `language/prompts/zh-CN/packs.json`；无覆盖时用 `fill` 把占位符替换成上下文，有覆盖时走用户的模板。

## 6. 测试

```bash
npm run test:resume        # = node --no-warnings --experimental-sqlite scripts/test-resume-component.js
```

32 项：组件元数据（含四个参考链接）、firstJSON/normalize/evidenceBlock/fakeAI、提示词包注册、以及沙箱 HTTP e2e（文档/版本/证据/五个 AI 动作入参校验与报告落库/删除级联/组件开关）。
AI 一律走 `SIERXING_RESUME_FAKE=1` 假实现，不花钱、不联网。

## 7. 已知边界 / 后续

- 现在按「单份简历 + 多版本」组织；还没有「岗位母版 / 项目素材库 / 可编辑 HTML 导出 / 网申字段复制」这些进阶能力，后续可以沿用 `resume.rewrite` 的输出继续做。
- 审计只在「简历 + 证据卡」范围内核验，不联网核验学校/奖项/开源链接；需要外部核验时会在报告里标「暂不可核验」。
- AI 输出都过了一层归一化（限长/限条数），失败时回原文 Markdown，不会把奇怪结构直接塞进界面。
