# 思而行 · MCP 与多宿主接入

> 目标：让 Claude Code / Cursor / DSH / 任何支持 MCP stdio 的 Agent，都能直接读写思而行。
> CLI 是通用入口；MCP 是宿主原生入口；两者共用同一套命令总线与审批。
> 想直接分发「MCP + 技能 + manifest」给别的宿主：用 node scripts/build-plugin.js 生成插件包，见 [packaging.md](packaging.md)。

## 一、MCP stdio 适配器

- 脚本：scripts/sierxing-mcp.js
- 协议：JSON-RPC over stdio，一行一条；stdout 只走协议，调试日志走 stderr。
- 环境：SIERXING_URL（默认 http://127.0.0.1:3213）、SIERXING_MCP_DEBUG=1。
- 能力：initialize / ping / tools/list / tools/call；resources/prompts 暂时返回空。
- 工具 = 命令总线里的命令：点号换下划线（goal.create → goal_create），描述里保留原命令名。
- 额外工具：sierxing_manifest / sierxing_approval_get / sierxing_approval_list。
- 风险标注：read → readOnlyHint；write → readOnlyHint=false；admin/destructive → destructiveHint=true。

## 二、宿主配置

生成配置：

~~~bash
node scripts/install-skills.js mcp-config --json
~~~

Claude Code：

~~~bash
claude mcp add sierxing -- node /abs/path/SiErXing/scripts/sierxing-mcp.js
~~~

或项目里的 .mcp.json：

~~~json
{
  "mcpServers": {
    "sierxing": {
      "command": "node",
      "args": ["/abs/path/SiErXing/scripts/sierxing-mcp.js"],
      "env": { "SIERXING_URL": "http://127.0.0.1:3213" }
    }
  }
}
~~~

Cursor：放到 .cursor/mcp.json（项目）或 ~/.cursor/mcp.json（全局），内容同上。

DSH / 其它宿主：任何支持 MCP stdio 的宿主都填 command=node、args=[脚本绝对路径]、env=SIERXING_URL。

## 三、Agent 起手式

1. sierxing_manifest / manifest_get：看版本、概念、全部工具。
2. brief_user：用户当前目标与最值得注意的洞察。
3. brief_goal / insight_list：目标进度、卡点、动量、下一步。
4. 需要时 prompt_list / prompt_preview；改提示词走 prompt_validate → prompt_update（审批）。
5. 写目标/节点：goal_create / node_create（write，直接执行但审计）。
6. 想让用户看到界面：app_open（可带 route，例如 `#/g/12` 目标页、`#/t/3` 教程页）；返回 `{ok,url,note}`。
7. 危险操作：admin/destructive 第一次返回 approval_required + approveUrl。

## 四、审批流程（MCP）

第一次调用会返回类似：

~~~json
{
  "ok": false,
  "error": { "code": "approval_required", "message": "需要用户批准：prompt.update" },
  "approvalId": "ap_...",
  "approveUrl": "http://127.0.0.1:3213/api/approvals/ap_.../page",
  "hint": "把 approveUrl 给用户；用户批准后，用同一工具、同一份入参 + approvalId 重试。"
}
~~~

- 把 approveUrl 给用户；用户打开页面点「批准并执行」（或命令行 approve）。
- Agent 轮询 sierxing_approval_get；状态 approved 后，用同一工具、同一份入参 + approvalId 重试。
- 审批一次性、绑定入参哈希、30 分钟过期；Agent 不得自己调用 approve。
- prompt.update 的模板很长时，审批页会展示；重试必须原样传同一份入参（approvalId 会和入参一起传，适配器会把它从命令入参里剥掉）。

## 五、多宿主 skill 安装

~~~bash
node scripts/install-skills.js list
node scripts/install-skills.js install --all --host claude
node scripts/install-skills.js install --all --host cursor
node scripts/install-skills.js install --all --target /path/to/agent/skills
node scripts/install-skills.js install goal-coach --host claude --dry-run
~~~

- claude：~/.claude/skills/<name>/SKILL.md
- cursor：.cursor/rules/<name>.mdc（自动加 frontmatter）
- generic：<target>/<name>/SKILL.md
- --force 覆盖；--dry-run 只看。

## 六、验证

~~~bash
node scripts/test-mcp.js          # 需要思而行在跑
node scripts/test-skills-install.js
~~~

## 七、边界

- 只连本机；不要暴露到公网。审批页与 MCP 都没有远程鉴权。
- MCP 是本地 Agent 的适配层，不是公网 API。
- 当前 MCP 只暴露 tools；resources/prompts 后续再加。
- 工具名最长 64 字符；命令名保持短。
- 宿主重启 MCP 后才能看到新增命令（tools/list 每次会刷新，但宿主可能缓存）。
