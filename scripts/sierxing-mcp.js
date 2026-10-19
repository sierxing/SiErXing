#!/usr/bin/env node
'use strict';
/**
 * 思而行 · MCP stdio 适配器（零依赖）
 * ------------------------------------------------------------------
 * 把命令总线暴露成 MCP tools：宿主（Claude Code / Cursor / DSH / 其它）通过
 * stdio JSON-RPC 调 tools/list、tools/call，就能读写思而行。
 *
 * 约定：
 * - stdout 只走 JSON-RPC，一行一条；调试日志只走 stderr（SIERXING_MCP_DEBUG=1）。
 * - 命令名里的点号映射成下划线（goal.create -> goal_create），描述里保留原命令名。
 * - admin/destructive 命令第一次调用返回 approval_required + approveUrl；
 *   用户在审批页批准后，用同一工具、同一份入参 + approvalId 重试。
 * - 额外工具：sierxing_manifest / sierxing_approval_get / sierxing_approval_list。
 *
 * 配置：SIERXING_URL（默认 http://127.0.0.1:3213）、SIERXING_MCP_DEBUG=1。
 */

const readline = require('node:readline');
const VERSION = require('../package.json').version;
const BASE = process.env.SIERXING_URL || ('http://127.0.0.1:' + (process.env.PORT || 3213));
const DEBUG = !!process.env.SIERXING_MCP_DEBUG;
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

let toolMap = null;
let cachedManifest = null;
let cachedAt = 0;

function log() {
  if (!DEBUG) return;
  const args = Array.prototype.slice.call(arguments).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); });
  process.stderr.write('[sierxing-mcp] ' + args.join(' ') + '\n');
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}
function replyError(id, code, message, data) {
  const e = { code: code, message: String(message || 'error') };
  if (data !== undefined) e.data = data;
  send({ jsonrpc: '2.0', id: id, error: e });
}
function text(t) {
  return { type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) };
}
function errorContent(message, extra) {
  const payload = { ok: false, error: { code: 'tool_error', message: String(message) } };
  if (extra) Object.assign(payload, extra);
  return { content: [text(payload)], isError: true };
}

async function api(pathname, opts) {
  const res = await fetch(BASE + pathname, opts || {});
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch (e) { body = { raw: raw }; }
  return { status: res.status, ok: res.ok, body: body };
}
async function getManifest(force) {
  if (!force && cachedManifest && Date.now() - cachedAt < 5000) return cachedManifest;
  const r = await api('/api/commands/manifest');
  if (!r.ok || !r.body) throw new Error('思而行服务不可用（' + BASE + '）');
  cachedManifest = r.body;
  cachedAt = Date.now();
  return cachedManifest;
}
function toolName(commandName) {
  return String(commandName).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function cloneSchema(src) {
  let s;
  try { s = JSON.parse(JSON.stringify(src || {})); } catch (e) { s = {}; }
  if (!s.type) s.type = 'object';
  if (!s.properties) s.properties = {};
  s.properties.approvalId = {
    type: 'string',
    description: '仅 admin/destructive 命令用：用户在审批页批准后，用同一工具、同一份入参 + 这个 approvalId 重试。Agent 不能自己批准。'
  };
  return s;
}
function manifestTool() {
  return {
    name: 'sierxing_manifest',
    title: '思而行 · 应用自描述',
    description: '读取思而行的版本、分层、概念与全部命令。MCP 工具列表加载失败时可用它自检。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: '思而行 · 应用自描述', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
}
function approvalTools() {
  return [
    {
      name: 'sierxing_approval_get',
      title: '查看审批状态',
      description: '按 approvalId 查审批状态（pending / approved / rejected / used / expired）。admin 命令返回 approval_required 后用它轮询。',
      inputSchema: { type: 'object', required: ['approvalId'], properties: { approvalId: { type: 'string' } } },
      annotations: { title: '查看审批状态', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: 'sierxing_approval_list',
      title: '审批列表',
      description: '列出待审批/已处理的审批。',
      inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'pending / approved / rejected / used / expired，省略为全部' }, limit: { type: 'integer' } } },
      annotations: { title: '审批列表', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ];
}
async function buildTools() {
  const m = await getManifest(true);
  const tools = [manifestTool()].concat(approvalTools());
  toolMap = new Map();
  for (const c of (m.commands || [])) {
    const tn = toolName(c.name);
    toolMap.set(tn, c);
    const risk = c.risk || 'read';
    tools.push({
      name: tn,
      title: c.title || c.name,
      description: '[命令 ' + c.name + '] ' + (c.description || '') +
        '\n风险：' + risk + (risk === 'admin' || risk === 'destructive' ? '（需要用户批准）' : '') +
        '\n分类：' + (c.category || '') + '；层：' + (c.layer || '') +
        (risk === 'admin' || risk === 'destructive' ? '\n第一次调用会返回 approval_required + approveUrl；用户批准后带 approvalId 重试。' : ''),
      inputSchema: cloneSchema(c.inputSchema),
      annotations: {
        title: c.title || c.name,
        readOnlyHint: risk === 'read',
        destructiveHint: risk === 'admin' || risk === 'destructive',
        idempotentHint: risk === 'read',
        openWorldHint: false
      }
    });
  }
  toolMap.set('sierxing_manifest', { special: 'manifest' });
  toolMap.set('sierxing_approval_get', { special: 'approval_get' });
  toolMap.set('sierxing_approval_list', { special: 'approval_list' });
  return tools;
}
async function executeTool(name, args) {
  const a = args && typeof args === 'object' ? Object.assign({}, args) : {};
  const approvalId = a.approvalId ? String(a.approvalId) : '';
  delete a.approvalId;

  if (name === 'sierxing_manifest') {
    return { content: [text(await getManifest(true))] };
  }
  if (name === 'sierxing_approval_get') {
    if (!approvalId) return errorContent('缺少 approvalId');
    const r = await api('/api/approvals/' + encodeURIComponent(approvalId));
    if (!r.ok) return errorContent((r.body && r.body.error && r.body.error.message) || '审批不存在');
    return { content: [text(r.body)] };
  }
  if (name === 'sierxing_approval_list') {
    const q = [];
    if (a.status) q.push('status=' + encodeURIComponent(String(a.status)));
    if (a.limit) q.push('limit=' + encodeURIComponent(String(a.limit)));
    const r = await api('/api/approvals' + (q.length ? '?' + q.join('&') : ''));
    if (!r.ok) return errorContent('审批列表读取失败');
    return { content: [text(r.body)] };
  }

  if (!toolMap) {
    try { await buildTools(); } catch (e) { return errorContent(e.message || String(e)); }
  }
  const mapped = toolMap.get(name);
  if (!mapped || !mapped.name) {
    return errorContent('未知工具：' + name + '。先调 tools/list 或 sierxing_manifest 看可用命令。');
  }
  const r = await api('/api/commands/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: mapped.name, input: a, actor: 'agent:mcp', approvalId: approvalId })
  });
  if (r.status === 200 && r.body && r.body.ok) {
    return { content: [text(r.body.result)] };
  }
  const err = (r.body && r.body.error) || { code: 'http_' + r.status, message: '请求失败' };
  const payload = { ok: false, error: err };
  if (err.code === 'approval_required' && err.details && err.details.approveUrl) {
    payload.hint = '需要用户批准：把 approveUrl 给用户；用户批准后，用同一工具、同一份入参 + approvalId 重试。Agent 不能自己批准。';
    payload.approvalId = err.details.approvalId;
    payload.approveUrl = err.details.approveUrl;
    payload.command = err.details.command;
  }
  return { content: [text(payload)], isError: true };
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('initialized');
    return;
  }
  try {
    if (method === 'initialize') {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion = PROTOCOLS.indexOf(requested) >= 0 ? requested : PROTOCOLS[0];
      const instructions = [
        '思而行是本机目标管理应用。起手式：sierxing_manifest 看能力，brief_user 看用户当前目标，brief_goal / insight_list 看进度与卡点。',
        'read 命令直接执行；write 命令会写审计；admin/destructive 命令需要用户在审批页批准（返回 approval_required + approveUrl），批准后用同一工具、同一份入参 + approvalId 重试。',
        'Agent 不能自己批准；只把 approveUrl 给用户并轮询 sierxing_approval_get。'
      ].join(' ');
      return reply(id, {
        protocolVersion: protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sierxing', version: VERSION },
        instructions: instructions
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      try {
        const tools = await buildTools();
        return reply(id, { tools: tools });
      } catch (e) {
        log('tools/list failed:', e && e.message);
        return reply(id, { tools: [manifestTool()] });
      }
    }
    if (method === 'tools/call') {
      const params = msg.params || {};
      const name = String(params.name || '');
      const result = await executeTool(name, params.arguments || {});
      return reply(id, result);
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    return replyError(id, -32601, 'Method not found: ' + method);
  } catch (e) {
    log('request error:', e && e.stack || e);
    return replyError(id, -32603, String(e && e.message || e));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', function (line) {
  const s = String(line || '').trim();
  if (!s) return;
  let msg = null;
  try { msg = JSON.parse(s); } catch (e) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  Promise.resolve().then(function () { return handle(msg); }).catch(function (e) {
    log('unhandled:', e && e.stack || e);
    if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, String(e && e.message || e));
  });
});
rl.on('close', function () { process.exit(0); });
process.on('SIGTERM', function () { process.exit(0); });
process.on('SIGINT', function () { process.exit(0); });
log('started; base=' + BASE + ' version=' + VERSION);
