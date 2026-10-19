# 思而行 · 非核心组件自改流水线

> 目标：让 Agent 能读、改、装、卸**非核心的 file 插件**（extension 层），
> 同时保证用户能看代码、能批准、失败能回滚。
> 核心（plan / outlib）与 base 内置组件的代码补丁不在本流水线里。

## 一、命令

| 命令 | 风险 | 说明 |
| --- | --- | --- |
| component.export | read | 导出 file 插件的 server/client/style 成 bundle；内置组件不可导出 |
| component.validate | read | 只校验不安装：format / id / 内置保护 / 体积 / 入口 / 语法 |
| component.stage | write | 把 bundle 暂存到本机 component_staging（不碰正式目录），返回 changeId + previewUrl |
| component.install | admin | 安装已暂存的 bundle；必须用户批准；加载失败自动回滚旧文件 |
| component.uninstall | destructive | 删除 file 插件文件并 reload；必须用户批准 |

## 二、流程

~~~bash
# 1. 读现有组件（改它之前先导出）
node scripts/sierxing.js commands run component.export '{"id":"pomodoro"}' --json

# 2. 改 bundle，先校验
node scripts/sierxing.js commands run component.validate '{"bundle":{...}}' --json

# 3. 暂存（不写正式目录）
node scripts/sierxing.js commands run component.stage '{"bundle":{...}}' --json
# → { changeId, summary, previewUrl }

# 4. 把 previewUrl 给用户看代码；用户同意后再安装
node scripts/sierxing.js commands run component.install '{"changeId":"chg_..."}' --json
# → approval_required + approvalId/approveUrl
# 用户批准后：
node scripts/sierxing.js commands run component.install '{"changeId":"chg_..."}' --json --approval <approvalId>

# 5. 验证
node scripts/sierxing.js commands run component.list --json

# 6. 卸载
node scripts/sierxing.js commands run component.uninstall '{"id":"pomodoro"}' --json --approval <approvalId>
~~~

## 三、安全边界

- **只支持 file 插件**（server/plugins/*.js + public/plugins/*.js/css）。BUILTIN_COMPONENTS 里的 core/base 组件（plan、outlib、tutorial 等）不能通过本流水线覆盖。
- 组件 JS 在思而行进程内运行，**权限和宿主一致**，不是沙箱。所以：
  - 安装前必须让用户在审批页看代码（component.install 的审批页会链到 previewUrl）；
  - Agent 不能自己批准；
  - 只安装用户信任的代码。
- 校验：format、id 正则、内置 id 保护、服务端必须有 module.exports、体积上限（server 200k / client 500k / style 200k）、前后端语法（new Function 只编译不执行）。
- 安装前 backup()；写入后 reload，**加载失败会把旧文件写回并重新 reload**，不会留下半装状态。
- 回滚：安装前把旧 bundle 用 component.export 保存；需要回滚时重新 stage → install 旧 bundle。
- 卸载只删文件，不删组件自建的数据表；需要清数据时由组件自己的 onGoalDelete/清理逻辑或用户手动处理。

## 四、本机数据

- component_staging：changeId、bundle_json、summary_json、status、created_at；本机表，不同步；启动时清理 7 天前的暂存。
- component.install 的审批只绑定 {changeId}，所以审批页很小；代码在 previewUrl 里看。
- 预览页：GET /api/component-staging/:changeId/preview（本机 HTML，显示新代码 + 当前版本 + 风险提示）。

## 五、验证

- node scripts/test-component-pipeline.js（8 项：合法包 / 内置 id / 非法 id / 缺 module.exports / 服务端语法 / 前端语法 / 超大 / 哈希）。
- node --no-warnings scripts/test-commands-write.js（20 项：export/validate/stage/install 审批/uninstall 审批）。
- 实际安装/卸载已演练：暂存 → 批准 → install（loaded 27）→ component.list 可见 → DELETE 路由卸载 → 文件删除、reload 回 26；测试组件已清理。

## 六、下一步

- base 内置组件（tutorial 等）的代码补丁（component.patchBuiltin）仍待做；那会改 server.js/app.js 里的功能代码，风险更高，需要单独的 staging/diff/回滚。
- 组件版本快照表（安装成功时存旧 bundle）可以替代“手动导出旧 bundle”的回滚方式。
