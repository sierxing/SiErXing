# 语义层：从「数据」到「这意味着什么」· 草案 v0.1

> 目标：Agent 不需要自己从 100 行记录里推断；它拿到的应该是「判断 + 证据 + 建议」。
> 先确定性规则，后 AI 解读；所有判断必须能指回证据。

## 已实现（v0.1 · 2026-10-17）

- 模块：server/insights.js（确定性规则，不调 AI、不写库）。
- 命令：insight.list（带 goalId 只返回该目标）；brief.goal / brief.user / goal.list 已带上。
- 已实现信号：
  - **goal_health**：on_track / at_risk / stalled / achieved / empty / archived。
  - **stall**：7 天无推进 = at_risk，14 天 = stalled；带下一任务与证据。
  - **milestone**：任务全部完成，提示复盘/归档/下一阶段。
  - **empty_goal**：目标还没有拆节点。
  - **momentum**：最近 7 天 vs 前 7 天的节点/教程更新数 + trend。
  - **nextAction**：下一任务（node.update）或先拆第一步（node.create）。
  - **friction**：读 friction_reports 里 open 的摩擦，带期望/实际证据与 component/setting/prompt 的建议动作。
  - **constraint_conflict**：解析 weekly_hours + 叶子节点 hours + deadline，比较剩余工时与可投入容量（ratio ≥1.15 warn，≥1.6 critical）。
  - **goal_drift**：读 goal_field_events（HTTP / 命令 / 对话 update_goal 写入），最近 14 天目标字段变更 → warn/info 洞察。
- 每条洞察带 severity / confidence / evidence / suggestedActions。
- 尚未实现：intent、confidence、preference、blocker、next_best_action；deadline 现在支持简单解析（YYYY-MM-DD / M月D日 / N 天/周/月/年）。

### 第二批（2026-10-18）

- **constraint_conflict**：`weekly_hours` × 期限（能解析时）或未来 4 周 = 可投入容量；未完成叶子节点 `hours` 求和 = 剩余工时。剩余明显超过容量时提示删减/降目标/拆阶段。
- **goal_drift**：`goal_field_events` 只记 title/profile/weekly_hours/deadline/materials 的真实变化；14 天内有变更就提示“目标在重新协商，先核对旧计划”。本机表，不同步。

## 一、洞察（Insight）的形状

~~~json
{
  "id": "ins_01J...",
  "type": "stall",
  "scope": { "goalId": 53, "nodeId": 412 },
  "severity": "warn",
  "confidence": 0.82,
  "evidence": [
    { "kind": "event", "ref": "evt_...", "summary": "节点 14 天无更新" },
    { "kind": "note", "ref": "note_...", "summary": "3 条笔记提到『不知道做什么项目』" },
    { "kind": "study", "ref": "study_...", "summary": "本周该节点学习 0 分钟" }
  ],
  "interpretation": "不是懒，是卡在『找项目』；计划时长与可用时间不匹配。",
  "suggestedActions": [
    {
      "command": "node.bulkCreate",
      "input": { "goalId": 53, "parentId": 412, "titles": ["列 3 个候选项目", "选 1 个复刻", "写 1 页分析"] },
      "why": "把『找项目』拆成可执行的 3 小步"
    }
  ],
  "createdAt": "2026-10-17T14:10:00.000Z",
  "expiresAt": "2026-10-24T14:10:00.000Z",
  "status": "open"
}
~~~

字段约定：

- type：信号类型（见下表）。
- scope：作用范围（goal / node / component / page / user）。
- severity：info / warn / critical。
- confidence：0~1；规则命中越多越高。
- evidence：必须能点回事件/笔记/统计/组件。
- interpretation：一句人话，不堆术语。
- suggestedActions：命令 + 入参 + 为什么；Agent 可以选择执行、询问或忽略。
- status：open / dismissed / acted / expired。

## 二、第一批信号

| type | 规则（确定性） | 含义 | 建议动作 |
| --- | --- | --- | --- |
| goal_health | 进度 vs 计划、最近活动、卡点数 | 目标是在轨 / 有风险 / 停滞 / 漂移 | 调整计划 / 复盘 / 缩小范围 |
| momentum | 最近 7 天 vs 前 7 天活动 | 在加速 / 稳定 / 减速 | 保持 / 降载 / 提醒 |
| stall | 节点 N 天无更新且无学习记录 | 卡住，不是懒 | 拆小 / 换资源 / 问一句 |
| blocker | 显式 blocker 笔记 / 重复失败 | 有具体阻塞 | 提供方案 / 找资料 / 换路径 |
| constraint_conflict | 计划时长 vs 实际时长、截止期 vs 剩余量 | 计划不可执行 | 重排 / 降目标 / 拆阶段 |
| friction | 反复撤销/删除/误触/关闭 + 用户抱怨 | 产品不适 | 改配置 / 改组件 / 改交互 |
| intent | 命令分布：搜索多写少=探索；节点更新多=执行；复盘多=反思 | 用户此刻在做什么 | 换对话策略 |
| confidence | 自报 + 测验/教程/笔记证据 | 真会 / 半懂 / 没底 | 复习 / 补基础 / 加练习 |
| preference | 活跃时段、会话长度、内容类型、组件使用 | 怎么学最舒服 | 调提醒 / 调任务量 |
| goal_drift | 成功标准/截止期/范围变更 | 目标在重新协商 | 重生成计划，别按旧计划催 |
| next_best_action | 依赖、阻塞、动量、可用时间 | 下一步做什么 | 给一个最小动作 |
| milestone | 节点/阶段完成 | 阶段性成果 | 庆祝 / 复盘 / 进入下一阶段 |

## 三、规则 vs AI

**第一层：确定性规则（先做）**

- 时间、计数、比率、显式笔记关键词、命令分布。
- 优点：便宜、可解释、可测试、不会瞎编。
- 每个信号都有单测：给定事件序列 → 期望洞察。

**第二层：AI 解读（后做）**

- 输入：目标、节点、事件摘要、笔记、统计、规则洞察。
- 输出：更自然的 interpretation、更贴合的 suggestedActions。
- 约束：
  - 只能引用给定证据，不能新增事实。
  - 输出必须包含 evidence 引用。
  - 低置信度标 low，不装作确定。
  - 失败时退回规则洞察。

## 四、证据与置信度

- 每条洞察至少 1 条证据；没有证据的不发。
- 置信度由：规则强度、证据数量、时间新鲜度、用户反馈共同决定。
- 证据只存引用 + 摘要，不复制全文，避免膨胀。
- 洞察有有效期；过期自动 archived，避免「上周的卡点」一直挂着。

## 五、用户反馈

- 用户/Agent 可以：dismiss（不准确）、correct（补充原因）、act（已处理）。
- 反馈写入 insight_feedback，用于调规则和降低误报。
- 同一个信号连续被 dismiss 两次 → 降低权重或暂停。
- 用户手动写的 blocker/decision 优先级高于自动推断。

## 六、几个「原始数据 → 含义」的例子

### 例 1：卡点

原始：

- 节点「找项目」status=doing，14 天无更新
- 本周该节点学习 0 分钟
- 3 条笔记都提到「不知道做什么项目」

含义：

> 不是懒，是卡在「找项目」。计划里这一步太抽象，用户需要具体的候选和选择标准。

建议：

> 拆成「列 3 个候选 / 选 1 个复刻 / 写 1 页分析」，并把本周目标降到 1 个候选。

### 例 2：节奏冲突

原始：

- 计划每天 3 小时
- 实际每天 1.2 小时，持续 7 天
- 用户活跃时段 22:00–23:30

含义：

> 计划不可执行。不是用户不努力，是计划按「理想日」排的。

建议：

> 把每日任务量按 1.5 小时重排；把重任务放到周末；提醒改到 21:50。

### 例 3：摩擦

原始：

- 番茄钟「切走休息」弹窗 2 天内出现 12 次
- 用户 9 次点「知道了」
- 用户把 restKeys 从 bilibili 改成空又改回

含义：

> 用户不信任「切走算休息」的判定，弹窗在打扰他。

建议：

> 关掉切走弹窗，只保留标题提醒；或把判定逻辑改成「只在 B 站窗口才算休息」。

### 例 4：目标漂移

原始：

- 目标从「3 个月转行」改成「6 个月转行」
- 成功标准新增「先做副业」
- 旧计划仍是 3 个月节奏

含义：

> 目标在重新协商；旧计划已经过期，不能按旧节奏催进度。

建议：

> 重生成计划；把「副业」作为新阶段；确认是否保留旧里程碑。

### 例 5：偏好

原始：

- 90% 的学习发生在 22:00–23:30
- 周末几乎不学
- 长教程完成率低，短教程完成率高

含义：

> 晚间短时学习更有效；长教程要拆成 20 分钟一段。

建议：

> 提醒改到 21:50；教程默认按小节拆分；周末不排硬任务。

## 七、Agent 怎么用

- 每次学习/目标相关对话开始：读 brief + insights（最多 3 条，按严重度排序）。
- 对话中最多主动提 1~2 条洞察，不要变成「数据汇报」。
- 提洞察时带证据和不确定性：「我看到你 14 天没动这个节点，是卡住了还是目标变了？」
- 行动前先问；行动后写回 note/progress。
- 用户 dismiss 的洞察不要再提。

## 八、更新频率与存储

- 事件驱动：命令/学习事件后 debounce 计算（如 30 秒）。
- 会话结束：补一次「本次会话摘要 + 新洞察」。
- 每日一次：动量、偏好、计划冲突。
- 存储：insights 表 + insight_evidence + insight_feedback。
- 过期：默认 7 天；milestone/friction 可更长。

## 九、第一版落地清单

1. 先实现 5 个确定性信号：stall、constraint_conflict、friction、goal_health、next_best_action。
2. 每个信号写 3 组单测（命中/不命中/边界）。
3. 洞察表 + 证据表 + 反馈表。
4. brief 里带 insights（最多 3 条）。
5. UI 里能看到洞察、证据和「不准确」按钮。
6. AI 解读作为可选开关，失败自动回退规则。
