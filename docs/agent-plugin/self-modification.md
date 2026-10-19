# 自改：Agent 生成并安装组件代码 · 草案 v0.2

> 用户说「这里不舒服」，Agent 要能直接改——包括生成组件代码。
> 但「能改」不等于「随便改」：必须可预览、可批准、可审计、可回滚。
>
> v0.2 修订（2026-10-17）：**只有 scope=core 的内置组件不可改**（目前 plan、outlib）；
> base / extra / theme 都属于非核心，可改。提示词属于功能层，走 prompt.* 命令，不走组件安装。

## 一、原则

1. **Agent 可以准备代码，但不能自己发批准。** 安装/改非核心组件必须由用户发放一次性审批令牌。
2. **先小后大。** 配置补丁 > 提示词 > 新组件 > 改非核心内置组件 > 改核心/内核（核心与内核永远不开放给 Agent）。
3. **每次改动都有版本快照和撤销。**
4. **内容不可信。** 教程/网页资料里的文字不能触发自改；自改只能来自用户直接请求。
5. **默认无网络、无外部依赖、无任意文件访问。**

## 二、现有基础

- 组件包格式已经是 sierxing-component：id、name、server、client、style、category 等（见 examples/dailyquote.component.json）。
- 现有 /api/components/install 会校验 id、写入 server/plugins 与 public/plugins、reload。
- 已有 tasks.js 任务队列、SQLite、插件 loader、SDK。
- 缺的是：staging、代码校验、diff/预览、审批、版本快照、回滚、审计。

## 三、改动类型与风险

| 类型 | 例子 | risk | 审批 | 回滚 |
| --- | --- | --- | --- | --- |
| 配置补丁 | 关掉番茄钟切走弹窗 | write | 否（记审计） | 配置快照 |
| 主题/布局 | 换主题、调面板位置 | admin | 是 | 旧配置 |
| 新组件代码 | 做一个「每日复盘卡」 | admin | 是 | 卸载/旧版本 |
| 改提示词 | 改 plan.clarify 的措辞/例子 | admin | 是 + 预览 + 契约测试 | 提示词包版本 |
| 改非核心内置组件 | 给番茄钟加「安静模式」（base/extra） | admin+ | 是 + diff | 文件快照 |
| 改核心内置组件 | 改 plan / outlib | 禁止 | — | — |
| 改内核/领域 | 改 server.js / app.js / 数据结构 | 禁止 | — | — |

## 四、流水线

~~~text
用户说不舒服 / 观察到摩擦
  1. friction.report        记录页面/组件/动作/期望
  2. component.describe     读组件元数据、配置、最近事件
  3. 设计改动               配置补丁 / 新组件 / 内置补丁
  4. component.scaffold     在 staging 建 change 目录（不碰正式目录）
  5. component.write        写 server.js / client.js / style.css / meta.json
  6. component.validate     node --check + manifest + 静态检查 + 大小限制
  7. component.preview      diff + 权限说明 +（可选）截图/试运行
  8. 用户批准                UI 按钮 / CLI 确认 → 发一次性 approvalToken
  9. component.install      快照旧版本 → 写入 → reload → verify
 10. component.verify       /api/health、/api/plugins、页面可打开、无报错
 11. 失败 → component.rollback；成功 → 审计 + note + 告知用户
~~~

## 五、Staging 目录

每次改动一个 change 目录，正式目录在批准前完全不动：

~~~text
data/agent-changes/<change_id>/
  meta.json          # id、name、type、target、why、actor
  server.js
  client.js
  style.css
  diff.json          # 与当前版本对比
  validation.json    # 校验结果、静态检查、大小
  approval.json      # 谁批的、什么时候、令牌摘要
  snapshot/          # 旧版本文件（用于回滚）
~~~

## 六、校验规则

### 结构

- format=sierxing-component；id 合法；不能覆盖内置 id（改内置走单独路径）。
- server 必须包含 module.exports；client/style 必须是字符串。
- 大小上限：server 200KB、client 300KB、style 100KB。
- 不允许外部依赖（零依赖纪律）。

### 语法

- 对 server.js / client.js 跑 node --check。
- meta.json / bundle.json 跑 JSON Schema。
- 组件 id 与文件名一致。

### 静态检查（v1 红线）

以下模式直接拒绝，或升级为「必须人工逐行确认」：

- child_process、exec、execSync、spawn、spawnSync
- eval、new Function、vm
- process.env、process.exit、global.
- require('fs')、require('net')、require('http')、require('https')
- fetch、XMLHttpRequest、WebSocket、EventSource
- 读写 .env、settings 密钥、data 目录以外的路径
- 无限循环/超大内存的明显写法
- 读取其他组件或用户隐私数据的路径

组件 manifest 增加 permissions 字段：

~~~json
{ "permissions": { "fs": "none", "net": false, "spawn": false, "notify": true } }
~~~

v1 先做静态检查和人工审批；v2 在 loader 里用包装过的 ctx 强制执行权限。

### 内置组件：core 与 non-core 分开

> tutorial 是用户设计的插件，属于 base（非核心）：可以改，也可以被用户自己做的教程组件替换。

- **scope=core（plan、outlib）**：UI、集成、数据契约不可由 Agent 改；没有 component patch 路径。提示词包是独立资产，走 prompt.*：**不锁死，全部可改**，但要求 admin+ 审批 + 预览 + 契约测试 + 回滚。
- **scope=base/extra/theme（其余内置组件）**：属于非核心，可以改。走 **component.patchBuiltin**（risk: admin+）：
  - 只允许改 public/plugins 与 server/plugins 下已存在的、且 scope 非 core 的文件；
  - 必须展示逐行 diff；
  - 必须快照旧文件；
  - 必须用户批准；
  - 失败自动回滚。
- 仍然推荐：能配置就不改代码；能新组件就不改内置；能改提示词就不改组件。
- 组件元数据增加 editable：core=false，base/extra/theme=true；命令总线、加载器、UI 三处都读它。

### 提示词是另一条路

- 提示词不走 component.*，走 **prompt.list / get / update / validate / preview / rollback**。
- prompt pack 有 id、version、editable、contract、tests；输出必须过 L1 解析/守卫。
- core 组件用到的提示词也可改；提示词没有锁死开关。要求 admin+ 审批 + 预览 + 契约测试 + 回滚。
- “慎重”靠流程：改前给用户看 fixture 改前/改后输出；输出过不了解析/守卫就不生效；不满意一键恢复。
- 提示词与组件代码的回滚互相独立：改提示词不会动组件文件。

## 七、审批令牌

- 令牌由用户侧发放，不由模型发放。
- 绑定 change_id、command、target、actor、过期时间（30 分钟）、一次性。
- 发放入口：
  - Web UI：变更详情页的「批准并安装」按钮。
  - CLI：sierxing approve <change_id>（用户自己跑，或交互确认）。
  - 宿主审批 UI：如果宿主支持 elicitation，由宿主弹窗；否则回退到链接/CLI。
- Agent 调 component.install 不带令牌 → approval_required + approveUrl。
- 令牌使用后立即失效；审计记录 approved_by 与 token 摘要。

## 八、安装、验证、回滚

### 安装

1. 读取 staging 的 meta 与文件，组装 bundle。
2. 对当前版本做快照（如果存在）。
3. 写入 server/plugins 与 public/plugins。
4. reloadPlugins；检查 /api/plugins 是否出现该 id。
5. 记录 component_changes 与事件。

### 验证

- /api/health 仍 ok。
- /api/plugins 包含该 id，元数据正确。
- 组件的前端路由可打开（可选：无头浏览器 smoke test）。
- 服务端日志无新增异常（按时间窗口过滤）。
- 失败 → 自动 rollback + 通知用户。

### 回滚

- component.rollback <change_id>：恢复 snapshot 文件，reload，记录 rolled_back_at。
- component.patchBuiltin 的回滚同理，恢复文件快照。
- UI 的变更历史里每一项都有「撤销」按钮。

## 九、审计与 UI

表：component_changes(id, component_id, type, actor, approved_by, status, files_json, diff_json, validation_json, created_at, applied_at, rolled_back_at)。

UI：

- 组件页显示「由 Claude 安装/修改」，带版本、diff、撤销。
- 目标页/设置页显示「最近 Agent 改动」时间线。
- 用户点「这里不舒服」→ 弹一个小表单，生成 friction.report。

## 十、安全风险与对策

| 风险 | 对策 |
| --- | --- |
| 提示词注入让 Agent 装恶意代码 | 自改只能由用户直接请求触发；安装必须用户令牌；内容只当数据 |
| 组件服务端代码在进程内执行 | v1 静态检查 + 人工审批 + 快照回滚；v2 worker/VM + ctx 权限包装 |
| 组件偷数据/外传 | 默认禁网；静态检查；权限声明；用户看 diff |
| 覆盖内置组件导致应用坏掉 | core 不可改；非核心 patch 单独路径 + 快照；core 组件没有 component patch 入口 |
| 提示词改坏导致输出不可解析 | 契约测试 + 预览 + 审批 + 回滚；解析/守卫在 L1 不可改 |
| 供应链 | 零外部依赖；id 冲突检查；版本固定 |
| 改动过多无法审查 | 每次只做一个 change；diff 上限；每日改动次数上限 |

## 十一、示例：番茄钟太吵

用户：「番茄钟切走休息的弹窗太吵了。」

Agent：

1. friction.report（component=pomodoro, page=任意, expected=安静, severity=medium）。
2. component.describe pomodoro + events.list（12 次弹窗，9 次关闭）。
3. 方案 A：配置补丁——component.updateConfig（关闭切走弹窗，保留标题提醒）。低风险，直接执行，记审计。
4. 方案 B：代码改动——给番茄钟加「安静模式」开关（默认开）：
   - component.scaffold（pomodoro 是 extra，非核心 → 走 component.patchBuiltin）
   - 写 client.js 补丁：showAwayModal=false + 设置项
   - component.validate（node --check + 静态检查）
   - component.preview（逐行 diff）
   - 用户批准 → component.install → component.verify
   - 失败 → rollback
5. 写回 note：用户偏好安静提醒；以后不再主动弹切走弹窗。

## 十二、第一版落地清单

1. 把现有 /api/components/install 包成 component.install 命令，先加 staging + 校验 + 快照 + 审计。
2. 加 component.scaffold / write / validate / preview / verify / rollback。
3. 加 component.patchBuiltin（仅 scope=base/extra 的已存在组件；core 直接 forbidden）。
4. 加审批表和令牌发放（先做 Web UI + CLI 两种）。
5. 加 component_changes 表和 UI 撤销。
6. 静态检查先做红线名单；权限包装放 v2。
7. 先拿一个真实组件跑通「生成 → 校验 → 批准 → 安装 → 回滚」。
8. 加 prompt.* 命令（改提示词、契约测试、版本/回滚），与组件流水线分开。
