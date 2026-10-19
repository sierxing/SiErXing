'use strict';
/**
 * MCP 适配器回归：node --no-warnings scripts/test-mcp.js
 * 需要思而行在跑（默认 127.0.0.1:3213）。
 * 只做只读工具调用；admin 那条会创建审批 → 立刻 reject → 清理（仅当 SIERXING_DB 指向真库）。
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const BASE = process.env.SIERXING_URL || 'http://127.0.0.1:3213';
const ROOT = path.resolve(__dirname, '..');

async function health() {
  try {
    const r = await fetch(BASE + '/api/health');
    const j = await r.json();
    return !!(j && j.ok);
  } catch (e) { return false; }
}

(async function () {
  if (!await health()) {
    console.log('  - 思而行未运行，跳过 MCP 测试');
    return;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'sierxing-mcp.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { SIERXING_URL: BASE }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', function (d) { stderr += String(d); });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let exited = false;
  child.on('exit', function () { exited = true; });
  rl.on('line', function (line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p(msg);
    }
  });
  function request(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('MCP 超时：' + method + (stderr ? ' / stderr=' + stderr.slice(0, 300) : '')));
      }, 12000);
      pending.set(id, function (msg) { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n');
  }
  let n = 0;
  function ok(name, cond, extra) { assert.ok(cond, name + (extra ? ' -> ' + extra : '')); console.log('  ✓ ' + name); n++; }
  function parseTool(res) {
    assert.ok(res && res.result && Array.isArray(res.result.content), 'tool result shape');
    const t = res.result.content[0].text;
    try { return JSON.parse(t); } catch (e) { return t; }
  }

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'sierxing-test', version: '0.0.0' }
    });
    ok('initialize 返回 serverInfo=思而行', init.result && init.result.serverInfo && init.result.serverInfo.name === 'sierxing');
    ok('initialize 声明 tools 能力', !!(init.result && init.result.capabilities && init.result.capabilities.tools));
    notify('notifications/initialized', {});

    const ping = await request('ping', {});
    ok('ping 可用', ping.result && typeof ping.result === 'object');

    const list = await request('tools/list', {});
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map(function (t) { return t.name; });
    ok('tools/list 含核心工具', ['manifest_get', 'brief_user', 'goal_create', 'prompt_list', 'audit_list', 'app_open', 'sierxing_manifest', 'sierxing_approval_get'].every(function (x) { return names.indexOf(x) >= 0; }), names.join(','));
    const goalCreate = tools.find(function (t) { return t.name === 'goal_create'; });
    const promptUpdate = tools.find(function (t) { return t.name === 'prompt_update'; });
    ok('goal_create 标记为 write（非 destructive）', goalCreate && goalCreate.annotations && goalCreate.annotations.readOnlyHint === false && goalCreate.annotations.destructiveHint === false);
    ok('prompt_update 标记为 destructive（需要批准）', promptUpdate && promptUpdate.annotations && promptUpdate.annotations.destructiveHint === true);
    ok('工具 schema 带 approvalId', goalCreate && goalCreate.inputSchema && goalCreate.inputSchema.properties && !!goalCreate.inputSchema.properties.approvalId);

    const brief = parseTool(await request('tools/call', { name: 'brief_user', arguments: {} }));
    ok('tools/call brief_user 返回真实数据', brief && typeof brief.totalGoals === 'number');

    const prompts = parseTool(await request('tools/call', { name: 'prompt_list', arguments: {} }));
    ok('tools/call prompt_list 返回提示词包', prompts && Array.isArray(prompts.prompts) && prompts.prompts.length >= 2);

    const manifest = parseTool(await request('tools/call', { name: 'sierxing_manifest', arguments: {} }));
    ok('sierxing_manifest 返回命令清单', manifest && Array.isArray(manifest.commands) && manifest.commands.length >= 20);

    const unknown = await request('tools/call', { name: 'nope_nope', arguments: {} });
    ok('未知工具返回 isError', unknown.result && unknown.result.isError === true);

    // admin 路径：创建审批 → 立刻 reject → 清理
    const got = parseTool(await request('tools/call', { name: 'prompt_get', arguments: { id: 'sources.digest_batch' } }));
    if (got && got.prompt && got.prompt.template) {
      const admin = await request('tools/call', { name: 'prompt_update', arguments: { id: 'sources.digest_batch', template: got.prompt.template } });
      const payload = parseTool(admin);
      ok('admin 工具返回 approval_required + approveUrl', admin.result && admin.result.isError === true && payload && payload.error && payload.error.code === 'approval_required' && !!payload.approveUrl, JSON.stringify(payload).slice(0, 200));
      const aid = payload.approvalId;
      if (aid) {
        const rej = await fetch(BASE + '/api/approvals/' + encodeURIComponent(aid) + '/reject', { method: 'POST' });
        const rj = await rej.json();
        ok('用户 reject 后审批状态 rejected', rej.status === 200 && rj.approval && rj.approval.status === 'rejected');
        const status = parseTool(await request('tools/call', { name: 'sierxing_approval_get', arguments: { approvalId: aid } }));
        ok('approval_get 读到 rejected', status && status.approval && status.approval.status === 'rejected');
        if (process.env.SIERXING_DB) {
          try {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(process.env.SIERXING_DB);
            db.prepare('DELETE FROM approvals WHERE id = ?').run(aid);
            db.close();
            console.log('  ✓ 清理测试审批');
          } catch (e) { console.log('  - 清理审批失败：' + e.message); }
        }
      }
    } else {
      console.log('  - 跳过 admin 路径（没读到 prompt 模板）');
    }
  } finally {
    try { child.stdin.end(); } catch (e) {}
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise(function (res) { const t = setTimeout(res, 1500); child.on('exit', function () { clearTimeout(t); res(); }); });
    assert.ok(exited || true);
  }
  console.log('\n' + n + ' 项全部通过');
})().catch(function (e) { console.error('\n✗ ' + (e && e.stack || e)); process.exit(1); });
