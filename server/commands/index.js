'use strict';
/**
 * 思而行 · 命令实现
 * ------------------------------------------------------------------
 * - read：直接执行
 * - write：直接执行 + 审计
 * - destructive / admin：必须带用户批准的 approvalId
 *
 * 审批/审计/事件都落在本机 SQLite（不同步、不上传）。
 * 这里不 require server.js：db 与领域助手由 server.js 启动时注入。
 */

const crypto = require('node:crypto');
const { createBus, hashInput } = require('./bus');
const insights = require('../insights');

module.exports = function createCommands(ctx) {
  const db = ctx && ctx.db;
  const getGoal = ctx && ctx.getGoal;
  const goalWithStats = ctx && ctx.goalWithStats;
  const nowISO = (ctx && ctx.nowISO) || function () { return new Date().toISOString(); };
  if (!db) throw new Error('commands: db required');
  if (typeof getGoal !== 'function') throw new Error('commands: getGoal required');
  if (typeof goalWithStats !== 'function') throw new Error('commands: goalWithStats required');

  const version = (ctx && ctx.version) || '0.0.0';
  const promptPacks = (ctx && ctx.promptPacks) || require('../prompts/registry')({ db: db, nowISO: nowISO });
  const getSetting = (ctx && ctx.getSetting) || function () { return ''; };
  const setSetting = (ctx && ctx.setSetting) || function () {};
  const backup = (ctx && ctx.backup) || function () {};
  const deleteGoal = ctx && ctx.deleteGoal;
  const deleteNode = ctx && ctx.deleteNode;
  const listComponents = ctx && ctx.listComponents;
  const describeComponent = ctx && ctx.describeComponent;
  const toggleComponent = ctx && ctx.toggleComponent;
  const exportComponent = ctx && ctx.exportComponent;
  const validateComponent = ctx && ctx.validateComponent;
  const installComponent = ctx && ctx.installComponent;
  const uninstallComponent = ctx && ctx.uninstallComponent;
  const recordGoalChange = ctx && ctx.recordGoalChange;
  const getPlanDomain = ctx && ctx.getPlanDomain;
  const getResumeDomain = ctx && ctx.getResumeDomain;
  const onSourceChanged = ctx && ctx.onSourceChanged;
  const startTutorialGeneration = ctx && ctx.startTutorialGeneration;
  const startTutorialEdit = ctx && ctx.startTutorialEdit;
  const startSourceCollect = ctx && ctx.startSourceCollect;
  const startSourceDigest = ctx && ctx.startSourceDigest;
  const startGoalPlan = ctx && ctx.startGoalPlan;
  const openApp = ctx && ctx.openApp;
  const port = process.env.PORT || 3213;

  /* 设置白名单：只暴露给 Agent 这些非密钥配置；AI key / sync token 永不进来 */
  const SAFE_SETTINGS = {
    backup_keep: { type: 'int', min: 1, max: 200, desc: '保留备份数' },
    collect_review: { type: 'bool', desc: '搜集后 AI 把关' },
    collect_min_score: { type: 'int', min: 0, max: 5, desc: '资料 AI 判读最低分' },
    collect_candidates: { type: 'int', min: 20, max: 2000, desc: '一轮候选资料上限' },
    collect_per_site: { type: 'int', min: 2, max: 50, desc: '单站候选上限' },
    collect_full: { type: 'bool', desc: '达标资料回抓全文' },
    collect_full_max: { type: 'int', min: 4000, max: 200000, desc: '单条全文上限字数' },
    collect_full_budget: { type: 'int', min: 0, max: 5000000, desc: '单次全文预算字数' },
    clean_ai_max: { type: 'int', min: 0, max: 500, desc: '清洗时单次 AI 处理条数' },
    rag_enabled: { type: 'bool', desc: '检索增强开关' },
    ai_provider: { type: 'enum', values: ['openai', 'opencode'], desc: 'AI 接入方式' },
    model: { type: 'string', max: 200, desc: '对话模型名' },
    /* 信息源检索的搜索 API：provider 空/builtin=内置搜索；deepseek/custom=外部搜索 API。
       密钥（search_api_key）是敏感信息，故意不进白名单。 */
    search_provider: { type: 'enum', values: ['', 'builtin', 'deepseek', 'custom'], desc: '信息源检索方式（空/内置=百度+必应）' },
    search_api_base: { type: 'string', max: 300, desc: '搜索 API 地址' },
    search_api_count: { type: 'int', min: 1, max: 50, desc: '每次搜索条数' },
    search_api_content: { type: 'bool', desc: '搜索 API 同时返回网页正文' },
    vision_model: { type: 'string', max: 200, desc: '视觉模型名' },
    explain_style_sample: { type: 'string', max: 6000, desc: '讲解风格示例' }
  };
  function settingRow(key) {
    const spec = SAFE_SETTINGS[key];
    if (!spec) return null;
    return { key: key, value: getSetting(key, ''), type: spec.type, desc: spec.desc, values: spec.values || undefined };
  }
  const uiBase = 'http://127.0.0.1:' + port;
  const APPROVAL_TTL_MS = 30 * 60 * 1000;

  /* 组件暂存：component.stage 只写本机表，不碰正式目录；
     component.install（admin）才真正安装。 */
  function newChangeId() {
    return 'chg_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  }
  function putComponentStage(bundle, summary) {
    const id = newChangeId();
    const at = nowISO();
    db.prepare('INSERT INTO component_staging (id, bundle_json, summary_json, status, created_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, JSON.stringify(bundle), JSON.stringify(summary), 'staged', at, '');
    return { changeId: id, summary: summary, status: 'staged', createdAt: at };
  }
  function getComponentStage(changeId) {
    const row = db.prepare('SELECT * FROM component_staging WHERE id = ?').get(String(changeId || ''));
    if (!row) return null;
    let bundle = null, summary = null;
    try { bundle = JSON.parse(row.bundle_json); } catch (e) { bundle = null; }
    try { summary = JSON.parse(row.summary_json); } catch (e) { summary = null; }
    return { changeId: row.id, bundle: bundle, summary: summary || {}, status: row.status, createdAt: row.created_at };
  }
  function markComponentStage(changeId, status) {
    db.prepare('UPDATE component_staging SET status = ? WHERE id = ?').run(String(status), String(changeId));
  }

  /* 本机表：审批 / 审计 / 事件。故意不进 SYNC_TABLES（不跨设备同步）。 */
  db.exec([
    'CREATE TABLE IF NOT EXISTS approvals (',
    '  id TEXT PRIMARY KEY,',
    '  command TEXT NOT NULL,',
    '  input_json TEXT NOT NULL DEFAULT \'{}\',',
    '  input_hash TEXT NOT NULL DEFAULT \'\',',
    '  actor TEXT NOT NULL DEFAULT \'\',',
    '  risk TEXT NOT NULL DEFAULT \'\',',
    '  reason TEXT NOT NULL DEFAULT \'\',',
    '  status TEXT NOT NULL DEFAULT \'pending\',',
    '  created_at TEXT NOT NULL,',
    '  expires_at TEXT NOT NULL,',
    '  approved_at TEXT NOT NULL DEFAULT \'\',',
    '  approved_by TEXT NOT NULL DEFAULT \'\',',
    '  used_at TEXT NOT NULL DEFAULT \'\'',
    ');',
    'CREATE TABLE IF NOT EXISTS command_audit (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  command TEXT NOT NULL,',
    '  actor TEXT NOT NULL DEFAULT \'\',',
    '  risk TEXT NOT NULL DEFAULT \'\',',
    '  approval_id TEXT NOT NULL DEFAULT \'\',',
    '  ok INTEGER NOT NULL DEFAULT 1,',
    '  duration_ms INTEGER NOT NULL DEFAULT 0,',
    '  input_json TEXT NOT NULL DEFAULT \'{}\',',
    '  result_json TEXT NOT NULL DEFAULT \'\',',
    '  error TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS command_events (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  type TEXT NOT NULL,',
    '  command TEXT NOT NULL DEFAULT \'\',',
    '  actor TEXT NOT NULL DEFAULT \'\',',
    '  risk TEXT NOT NULL DEFAULT \'\',',
    '  ok INTEGER NOT NULL DEFAULT 1,',
    '  duration_ms INTEGER NOT NULL DEFAULT 0,',
    '  error TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS friction_reports (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  goal_id INTEGER,',
    '  page TEXT NOT NULL DEFAULT \'\',',
    '  component TEXT NOT NULL DEFAULT \'\',',
    '  action TEXT NOT NULL DEFAULT \'\',',
    '  description TEXT NOT NULL DEFAULT \'\',',
    '  expected TEXT NOT NULL DEFAULT \'\',',
    '  actual TEXT NOT NULL DEFAULT \'\',',
    '  severity TEXT NOT NULL DEFAULT \'medium\',',
    '  status TEXT NOT NULL DEFAULT \'open\',',
    '  note TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS component_staging (',
    '  id TEXT PRIMARY KEY,',
    '  bundle_json TEXT NOT NULL,',
    '  summary_json TEXT NOT NULL,',
    '  status TEXT NOT NULL DEFAULT \'staged\',',
    '  created_at TEXT NOT NULL,',
    '  created_by TEXT NOT NULL DEFAULT \'\'',
    ');',
    'CREATE TABLE IF NOT EXISTS goal_field_events (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  goal_id INTEGER NOT NULL,',
    '  field TEXT NOT NULL,',
    '  old_value TEXT NOT NULL DEFAULT \'\',',
    '  new_value TEXT NOT NULL DEFAULT \'\',',
    '  source TEXT NOT NULL DEFAULT \'\',',
    '  created_at TEXT NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_goal_field_events_goal ON goal_field_events(goal_id, created_at);'
  ].join('\n'));
  try { db.prepare('DELETE FROM component_staging WHERE created_at < ?').run(new Date(Date.now() - 7 * 86400000).toISOString()); } catch (e) {}

  function cap(s, n) {
    const v = String(s == null ? '' : s);
    return v.length > n ? v.slice(0, n) + '…' : v;
  }
  function newApprovalId() {
    return 'ap_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  }
  function lastId() {
    return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  const approvals = {
    create: function (a) {
      const id = newApprovalId();
      const input = a.input && typeof a.input === 'object' ? a.input : {};
      const at = nowISO();
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
      db.prepare('INSERT INTO approvals (id, command, input_json, input_hash, actor, risk, reason, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, String(a.command || ''), cap(JSON.stringify(input), 8000), hashInput(input), String(a.actor || ''), String(a.risk || ''), cap(a.reason, 1000), 'pending', at, expiresAt);
      return {
        id: id, command: a.command, input: input, actor: a.actor || '', risk: a.risk || '',
        reason: a.reason || '', status: 'pending', createdAt: at, expiresAt: expiresAt,
        approveUrl: uiBase + '/api/approvals/' + id + '/page'
      };
    },
    get: function (id) {
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(String(id || ''));
      if (!row) return null;
      let status = row.status;
      if (status === 'pending' && row.expires_at && row.expires_at < nowISO()) {
        db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run('expired', row.id);
        status = 'expired';
      }
      let input = {};
      try { input = JSON.parse(row.input_json || '{}'); } catch (e) { input = {}; }
      return {
        id: row.id, command: row.command, input: input, input_hash: row.input_hash,
        actor: row.actor, risk: row.risk, reason: row.reason, status: status,
        createdAt: row.created_at, expiresAt: row.expires_at,
        approvedAt: row.approved_at, approvedBy: row.approved_by, usedAt: row.used_at,
        approveUrl: uiBase + '/api/approvals/' + row.id + '/page'
      };
    },
    approve: function (id, by) {
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(String(id || ''));
      if (!row) return null;
      if (row.status !== 'pending') return approvals.get(id);
      db.prepare('UPDATE approvals SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?').run('approved', nowISO(), String(by || 'user:local'), row.id);
      return approvals.get(id);
    },
    reject: function (id, by) {
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(String(id || ''));
      if (!row) return null;
      if (row.status !== 'pending') return approvals.get(id);
      db.prepare('UPDATE approvals SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?').run('rejected', nowISO(), String(by || 'user:local'), row.id);
      return approvals.get(id);
    },
    markUsed: function (id) {
      db.prepare('UPDATE approvals SET status = ?, used_at = ? WHERE id = ?').run('used', nowISO(), String(id || ''));
    },
    list: function (status, limit) {
      const n = Math.min(100, Math.max(1, Number(limit) || 20));
      let rows;
      if (status) rows = db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, n);
      else rows = db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(n);
      return rows.map(function (r) { return approvals.get(r.id); });
    }
  };

  function audit(entry) {
    try {
      db.prepare('INSERT INTO command_audit (command, actor, risk, approval_id, ok, duration_ms, input_json, result_json, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(String(entry.command || ''), String(entry.actor || ''), String(entry.risk || ''), String(entry.approvalId || ''), entry.ok ? 1 : 0, Number(entry.durationMs) || 0,
          cap(JSON.stringify(entry.input || {}), 4000), entry.result == null ? '' : cap(JSON.stringify(entry.result), 4000), cap(entry.error, 1000), entry.at || nowISO());
    } catch (e) { /* 审计失败不影响命令本身 */ }
  }
  function onEvent(ev) {
    try {
      db.prepare('INSERT INTO command_events (type, command, actor, risk, ok, duration_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(String(ev.type || ''), String(ev.command || ''), String(ev.actor || ''), String(ev.risk || ''), ev.ok === false ? 0 : 1, Number(ev.durationMs) || 0, cap(ev.error, 1000), ev.at || nowISO());
    } catch (e) {}
  }
  function listAudit(limit) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    return db.prepare('SELECT id, command, actor, risk, approval_id, ok, duration_ms, input_json, result_json, error, created_at FROM command_audit ORDER BY id DESC LIMIT ?').all(n);
  }

  const app = {
    name: 'SiErXing',
    version: version,
    manifestVersion: 1,
    generatedAt: new Date().toISOString()
  };
  const layers = [
    { id: 'kernel', editable: false, desc: 'DB / HTTP / 任务 / AI 传输 / 命令总线' },
    { id: 'domain', editable: false, desc: '数据结构 / 不变量 / 解析 / 守卫' },
    { id: 'feature', editable: true, desc: '提示词 / 管线 / 功能页' },
    { id: 'extension', editable: true, desc: '附加组件 / 主题 / 布局' },
    { id: 'content', editable: true, desc: '用户的目标、节点、教程、资料、笔记' }
  ];
  const concepts = [
    { name: 'goal', title: '目标', what: '用户想要达到的状态；有为什么、成功标准、约束、阶段与节点。', fields: ['id', 'title', 'status', 'weekly_hours', 'deadline'], relations: ['nodes', 'tutorials'] },
    { name: 'node', title: '节点', what: '目标下的一步；可嵌套阶段/小目标/任务；有状态与验收标准。', fields: ['id', 'parent_id', 'level', 'title', 'status', 'acceptance'], relations: ['goal', 'children', 'tutorials'] },
    { name: 'tutorial', title: '教程', what: '为节点生成的学习材料；正文可能很长，读取要分页。', fields: ['id', 'goal_id', 'node_id', 'title', 'format'], relations: ['node'] },
    { name: 'source', title: '资料', what: '外部检索或用户提供的资料；是规划与教程的依据。', fields: ['id', 'title', 'url', 'site', 'kind'], relations: ['goal'] },
    { name: 'approval', title: '审批', what: '危险/管理操作的一次性用户批准；绑定命令与入参哈希，30 分钟过期。', fields: ['id', 'command', 'status', 'expires_at'], relations: ['audit'] },
    { name: 'audit', title: '审计', what: '每次命令执行的记录：谁、什么风险、成功/失败、耗时。', fields: ['id', 'command', 'actor', 'risk', 'ok'], relations: ['approval'] }
  ];
  const bus = createBus({ audit: audit, onEvent: onEvent, approvals: approvals, nowISO: nowISO });

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  function num(v, name) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail('bad_input', name + ' 必须是正整数');
    return n;
  }
  function ui(hash) {
    return uiBase + '/' + (hash || '');
  }
  function fullManifest() {
    const m = bus.manifest({ app: app, layers: layers, concepts: concepts });
    const risks = { read: 0, write: 0, admin: 0, destructive: 0 };
    for (const c of m.commands) risks[c.risk] = (risks[c.risk] || 0) + 1;
    const prompts = promptPacks ? promptPacks.list() : [];
    m.schema = 'sierxing.plugin/1';
    m.id = 'sierxing';
    m.surfaces = [
      { id: 'app', title: '独立 Web 应用', entry: 'server/server.js', transport: 'http', url: uiBase },
      { id: 'cli', title: '命令行', entry: 'scripts/sierxing.js', transport: 'http' },
      { id: 'mcp', title: 'MCP stdio 适配器', entry: 'scripts/sierxing-mcp.js', transport: 'stdio-jsonrpc' },
      { id: 'skills', title: 'Agent 技能', entry: 'docs/agent-plugin/skills', transport: 'filesystem' }
    ];
    m.capabilities = {
      commands: m.commands.length,
      risks: risks,
      approvals: true,
      audit: true,
      events: true,
      promptPacks: prompts.length,
      editableLayers: ['feature', 'extension', 'content']
    };
    m.prompts = prompts.map(function (x) { return { id: x.id, title: x.title, editable: x.editable !== false, source: x.source, version: x.version }; });
    m.components = typeof listComponents === 'function' ? listComponents() : [];
    return m;
  }

  bus.define({
    name: 'manifest.get',
    title: '应用自描述',
    description: '返回思而行的版本、分层、核心概念与全部命令。Agent 开局先读它。',
    category: 'meta', layer: 'kernel', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'manifest',
    handler: function () { return fullManifest(); }
  });

  bus.define({
    name: 'app.open',
    title: '打开思而行页面',
    description: '在用户本机浏览器里打开思而行；可指定页面（例：#/g/12 目标页、#/t/3 教程页、#/settings）。不指定就打开首页。',
    category: 'meta', layer: 'kernel', risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string', description: '要打开的页面，以 # 或 / 开头；留空 = 首页' } }
    },
    output: 'json',
    handler: function (input) {
      const route = String((input && input.route) || '').trim();
      if (route && (route.length > 300 || !/^[#/]/.test(route) || /\s/.test(route))) {
        fail('bad_input', 'route 应以 / 或 # 开头，且不含空白（例：#/g/12）');
      }
      if (typeof openApp !== 'function') fail('not_implemented', '打开页面未接入服务端');
      const r = openApp(route);
      if (r && r.ok) {
        return { ok: true, url: ui(route), note: '已在浏览器打开；开机自启实例会自动补 DISPLAY 再打开。' };
      }
      if (r && r.reason === 'NO_OPEN') {
        return { ok: false, reason: 'NO_OPEN', url: ui(route), note: '当前实例以 NO_OPEN 运行（测试/远程），只返回地址、不弹窗口。' };
      }
      fail('open_failed', (r && r.error) || '打开失败');
    }
  });

  bus.define({
    name: 'goal.list',
    title: '目标列表',
    description: '列出全部目标（含任务总数/完成数/下一任务）。',
    category: 'goal', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'json',
    handler: function () {
      const goals = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC').all().map(goalWithStats);
      const now = nowISO();
      for (const g of goals) {
        try {
          const ins = insights.forGoal(db, g, now);
          g.health = ins.health;
          g.idleDays = ins.idleDays;
          g.momentum = ins.momentum;
          g.nextAction = ins.nextAction;
        } catch (e) {}
      }
      return { goals: goals, uiUrl: ui('') };
    }
  });

  bus.define({
    name: 'goal.get',
    title: '读取目标',
    description: '读取单个目标：字段、节点、教程索引与进度统计。',
    category: 'goal', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const id = num(input.goalId || input.id, 'goalId');
      const g = getGoal(id);
      if (!g) fail('not_found', '目标不存在：' + id);
      let ins = null;
      try { ins = insights.forGoal(db, g, nowISO()); } catch (e) {}
      return { goal: g, health: ins ? ins.health : '', insights: ins ? ins.insights : [], nextAction: ins ? ins.nextAction : null, uiUrl: ui('#/g/' + id) };
    }
  });

  bus.define({
    name: 'goal.create',
    title: '创建目标',
    description: '创建一个新目标（draft 状态）。title 必填；profile/materials/weekly_hours/deadline 可选。',
    category: 'goal', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: { title: { type: 'string' }, profile: { type: 'string' }, materials: { type: 'string' }, weekly_hours: { type: 'string' }, deadline: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      const title = String(input.title || '').trim();
      if (!title) fail('bad_input', 'title 不能为空');
      const at = nowISO();
      db.prepare('INSERT INTO goals (title, profile, materials, weekly_hours, deadline, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(title.slice(0, 120), String(input.profile || '').slice(0, 3000), String(input.materials || '').slice(0, 5000),
          String(input.weekly_hours || '').slice(0, 50), String(input.deadline || '').slice(0, 50), 'draft', at, at);
      const id = lastId();
      return { goalId: id, title: title, status: 'draft', uiUrl: ui('#/g/' + id) };
    }
  });

  bus.define({
    name: 'goal.update',
    title: '更新目标',
    description: '修改目标字段：title/profile/materials/weekly_hours/deadline/status/summary。',
    category: 'goal', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId'],
      properties: { goalId: { type: 'integer' }, title: { type: 'string' }, profile: { type: 'string' }, materials: { type: 'string' }, weekly_hours: { type: 'string' }, deadline: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      const id = num(input.goalId || input.id, 'goalId');
      const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
      if (!row) fail('not_found', '目标不存在：' + id);
      const allowed = ['title', 'profile', 'materials', 'weekly_hours', 'deadline', 'status', 'summary'];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (input[k] === undefined) continue;
        sets.push(k + ' = ?');
        vals.push(String(input[k]).slice(0, k === 'title' ? 120 : 5000));
      }
      if (!sets.length) fail('bad_input', '没有可更新的字段');
      sets.push('updated_at = ?'); vals.push(nowISO()); vals.push(id);
      db.prepare('UPDATE goals SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
      if (typeof recordGoalChange === 'function') {
        try { recordGoalChange(id, row, db.prepare('SELECT * FROM goals WHERE id = ?').get(id), 'command'); } catch (e) {}
      }
      const g = getGoal(id);
      return { goal: { id: g.id, title: g.title, status: g.status, weekly_hours: g.weekly_hours, deadline: g.deadline, profile: g.profile, summary: g.summary }, uiUrl: ui('#/g/' + id) };
    }
  });

  bus.define({
    name: 'goal.archive',
    title: '归档目标',
    description: '把目标状态改成 archived（不删除数据）。',
    category: 'goal', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.goalId || input.id, 'goalId');
      const row = db.prepare('SELECT id FROM goals WHERE id = ?').get(id);
      if (!row) fail('not_found', '目标不存在：' + id);
      db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?').run('archived', nowISO(), id);
      return { goalId: id, status: 'archived' };
    }
  });

  bus.define({
    name: 'node.list',
    title: '节点列表',
    description: '列出目标下的节点（阶段/小目标/任务）。',
    category: 'node', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.goalId, 'goalId');
      const nodes = db.prepare('SELECT id, parent_id, level, title, status, sort_order, artifact, acceptance, hours, updated_at FROM nodes WHERE goal_id = ? ORDER BY level ASC, sort_order ASC, id ASC').all(id);
      return { goalId: id, nodes: nodes };
    }
  });

  bus.define({
    name: 'node.create',
    title: '创建节点',
    description: '在目标下创建一个节点/任务。parentId 为空时是顶层；level 自动按父节点 +1；sort_order 自动排到最后。',
    category: 'node', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId', 'title'],
      properties: {
        goalId: { type: 'integer' }, parentId: { type: 'integer' }, title: { type: 'string' },
        detail: { type: 'string' }, artifact: { type: 'string' }, acceptance: { type: 'string' }, hours: { type: 'string' }
      }
    },
    output: 'json',
    handler: function (input) {
      const gid = num(input.goalId, 'goalId');
      const g = db.prepare('SELECT id FROM goals WHERE id = ?').get(gid);
      if (!g) fail('not_found', '目标不存在：' + gid);
      const title = String(input.title || '').trim();
      if (!title) fail('bad_input', 'title 不能为空');
      let parentId = input.parentId ? num(input.parentId, 'parentId') : null;
      let level = 0;
      if (parentId) {
        const p = db.prepare('SELECT id, goal_id, level FROM nodes WHERE id = ?').get(parentId);
        if (!p || Number(p.goal_id) !== gid) fail('bad_input', 'parentId 不属于这个目标');
        level = Number(p.level) + 1;
      }
      const maxSort = db.prepare('SELECT IFNULL(MAX(sort_order), 0) AS n FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)').get(gid, parentId || 0).n;
      const at = nowISO();
      db.prepare('INSERT INTO nodes (goal_id, parent_id, level, title, detail, artifact, acceptance, hours, status, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(gid, parentId, level, title.slice(0, 200), String(input.detail || '').slice(0, 5000), String(input.artifact || '').slice(0, 2000),
          String(input.acceptance || '').slice(0, 2000), String(input.hours || '').slice(0, 50), 'todo', Number(maxSort) + 1, at, at);
      const id = lastId();
      return { nodeId: id, goalId: gid, parentId: parentId, level: level, title: title, status: 'todo', uiUrl: ui('#/g/' + gid) };
    }
  });

  bus.define({
    name: 'node.update',
    title: '更新节点',
    description: '修改节点的 title/detail/artifact/acceptance/hours/status。',
    category: 'node', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['nodeId'],
      properties: { nodeId: { type: 'integer' }, title: { type: 'string' }, detail: { type: 'string' }, artifact: { type: 'string' }, acceptance: { type: 'string' }, hours: { type: 'string' }, status: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      const id = num(input.nodeId || input.id, 'nodeId');
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (!row) fail('not_found', '节点不存在：' + id);
      const allowed = ['title', 'detail', 'artifact', 'acceptance', 'hours', 'status'];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (input[k] === undefined) continue;
        sets.push(k + ' = ?');
        vals.push(String(input[k]).slice(0, k === 'title' ? 200 : 5000));
      }
      if (!sets.length) fail('bad_input', '没有可更新的字段');
      sets.push('updated_at = ?'); vals.push(nowISO()); vals.push(id);
      db.prepare('UPDATE nodes SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
      const n = db.prepare('SELECT id, parent_id, level, title, status, updated_at FROM nodes WHERE id = ?').get(id);
      return { node: n, uiUrl: ui('#/g/' + n.goal_id) };
    }
  });

  bus.define({
    name: 'node.complete',
    title: '完成任务',
    description: '把节点状态改成 done。',
    category: 'node', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.nodeId || input.id, 'nodeId');
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (!row) fail('not_found', '节点不存在：' + id);
      db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run('done', nowISO(), id);
      return { nodeId: id, status: 'done', goalId: row.goal_id };
    }
  });

  bus.define({
    name: 'tutorial.get',
    title: '读取教程',
    description: '读取教程元数据与正文；正文按 offset/limit 分页。',
    category: 'tutorial', layer: 'content', risk: 'read',
    inputSchema: {
      type: 'object', required: ['tutorialId'],
      properties: { tutorialId: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }
    },
    output: 'json',
    handler: function (input) {
      const id = num(input.tutorialId || input.id, 'tutorialId');
      const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(id);
      if (!t) fail('not_found', '教程不存在：' + id);
      const content = String(t.content || '');
      const offset = Math.max(0, Number(input.offset) || 0);
      const limit = Math.min(50000, Math.max(1000, Number(input.limit) || 20000));
      const slice = content.slice(offset, offset + limit);
      return {
        tutorial: { id: t.id, goal_id: t.goal_id, node_id: t.node_id, title: t.title, format: t.format, created_at: t.created_at, updated_at: t.updated_at },
        content: slice, total: content.length, offset: offset,
        nextOffset: offset + slice.length < content.length ? offset + slice.length : null,
        uiUrl: ui('#/t/' + id)
      };
    }
  });

  bus.define({
    name: 'brief.goal',
    title: '目标简报',
    description: '目标的结构化简报：目标字段、进度、下一任务、最近教程。',
    category: 'brief', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.goalId || input.id, 'goalId');
      const g = getGoal(id);
      if (!g) fail('not_found', '目标不存在：' + id);
      const counts = {
        tutorials: db.prepare('SELECT COUNT(*) AS c FROM tutorials WHERE goal_id = ?').get(id).c,
        sources: db.prepare('SELECT COUNT(*) AS c FROM sources WHERE goal_id = ?').get(id).c,
        digests: db.prepare('SELECT COUNT(*) AS c FROM source_digests WHERE goal_id = ?').get(id).c
      };
      const byKind = db.prepare('SELECT kind, COUNT(*) AS n FROM sources WHERE goal_id = ? GROUP BY kind ORDER BY n DESC').all(id);
      // JD 类资料单独点出来：这是「找工作」目标里最常被问到的内容，不能只给个总数让 Agent 去猜/联网。
      const jdLike = db.prepare(
        "SELECT id, title, kind, quality, length(content) AS chars FROM sources WHERE goal_id = ? AND (" +
        "kind LIKE '%JD%' OR kind LIKE '%岗位%' OR kind LIKE '%招聘%' OR title LIKE '%JD%') " +
        "ORDER BY CASE WHEN kind = 'JD' THEN 0 WHEN kind LIKE 'JD%' THEN 1 ELSE 2 END, quality DESC, id DESC LIMIT 12").all(id);
      let ins = null;
      try { ins = insights.forGoal(db, g, nowISO()); } catch (e) {}
      return {
        goal: { id: g.id, title: g.title, status: g.status, weekly_hours: g.weekly_hours, deadline: g.deadline, profile: g.profile, summary: g.summary },
        progress: {
          tasks_total: g.tasks_total, tasks_done: g.tasks_done, next_task: g.next_task, next_task_id: g.next_task_id,
          next_path: g.next_path, tutorials: counts.tutorials, sources: counts.sources, digests: counts.digests
        },
        health: ins ? ins.health : '',
        idleDays: ins ? ins.idleDays : null,
        momentum: ins ? ins.momentum : null,
        insights: ins ? ins.insights : [],
        nextAction: ins ? ins.nextAction : null,
        sources: { total: counts.sources, by_kind: byKind, jd_like: jdLike },
        recent_tutorials: (g.tutorials || []).slice(0, 5),
        uiUrl: ui('#/g/' + id)
      };
    }
  });

  bus.define({
    name: 'brief.user',
    title: '用户简报',
    description: '用户全局简报：最近目标、总数、当前活跃目标。',
    category: 'brief', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'json',
    handler: function () {
      const goals = db.prepare('SELECT id, title, status, updated_at FROM goals ORDER BY updated_at DESC LIMIT 20').all();
      const total = db.prepare('SELECT COUNT(*) AS c FROM goals').get().c;
      let overview = null;
      try { overview = insights.forUser(db, nowISO()); } catch (e) {}
      const healthById = new Map();
      if (overview) for (const g of overview.goals) healthById.set(g.goalId, g.health);
      for (const g of goals) g.health = healthById.get(g.id) || '';
      let active = null;
      for (const g of goals) { if (g.status !== 'done' && g.status !== 'archived') { active = g; break; } }
      return { totalGoals: total, goals: goals, activeGoal: active, topInsights: overview ? overview.topInsights : [], uiUrl: ui('') };
    }
  });

  bus.define({
    name: 'insight.list',
    title: '语义洞察',
    description: '目标健康度、卡点、动量、下一步；带 goalId 时只返回该目标。',
    category: 'insight', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', properties: { goalId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      if (input.goalId || input.id) {
        const id = num(input.goalId || input.id, 'goalId');
        const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
        if (!g) fail('not_found', '目标不存在：' + id);
        return insights.forGoal(db, g, nowISO());
      }
      return insights.forUser(db, nowISO());
    }
  });

  bus.define({
    name: 'source.list',
    title: '资料列表',
    description: '列出目标下的资料（标题/来源/类型/质量/AI 摘要）。',
    category: 'source', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' }, limit: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.goalId, 'goalId');
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
      const rows = db.prepare('SELECT * FROM sources WHERE goal_id = ? ORDER BY quality DESC, id DESC LIMIT ?').all(id, limit);
      const sources = rows.map(function (s) {
        const content = String(s.content || '');
        return { id: s.id, title: s.title, url: s.url, site: s.site, kind: s.kind, quality: s.quality,
          quality_score: s.quality_score == null ? null : s.quality_score, topic: s.topic || '', ai_summary: s.ai_summary || '',
          chars: content.length, has_content: content.trim().length > 0 };
      });
      return { goalId: id, sources: sources };
    }
  });

  bus.define({
    name: 'source.get',
    title: '读取资料正文',
    description: '读取一条资料的正文（分页）。回答 JD/岗位要求、资料内容类问题应先 source.list 找 id 再 source.get 读正文；思而行里已有的资料不要再去联网搜索。',
    category: 'source', layer: 'content', risk: 'read',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }
    },
    output: 'json',
    handler: function (input) {
      const id = num(input.id || input.sourceId, 'id');
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      if (!row) fail('not_found', '资料不存在：' + id);
      const content = String(row.content || '');
      const offset = Math.max(0, Number(input.offset) || 0);
      const limit = Math.min(20000, Math.max(500, Number(input.limit) || 6000));
      const slice = content.slice(offset, offset + limit);
      const next = offset + slice.length < content.length ? offset + slice.length : null;
      return {
        id: row.id, goalId: row.goal_id, title: row.title, url: row.url, site: row.site, kind: row.kind,
        quality: row.quality, quality_score: row.quality_score == null ? null : row.quality_score,
        topic: row.topic || '', ai_summary: row.ai_summary || '',
        chars: content.length, offset: offset, content: slice, next_offset: next
      };
    }
  });

  bus.define({
    name: 'audit.list',
    title: '审计日志',
    description: '最近的命令执行记录（谁、什么命令、风险、成功/失败、耗时）。',
    category: 'meta', layer: 'kernel', risk: 'read',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    output: 'json',
    handler: function (input) { return { entries: listAudit(input.limit) }; }
  });

  bus.define({
    name: 'prompt.list',
    title: '提示词包列表',
    description: '列出可编辑的提示词包（来源、版本、占位符）。',
    category: 'prompt', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'json',
    handler: function () { return { prompts: promptPacks.list() }; }
  });

  bus.define({
    name: 'prompt.get',
    title: '读取提示词包',
    description: '读取一个提示词包的当前模板、占位符、版本与来源。',
    category: 'prompt', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      const p = promptPacks.get(id);
      if (!p) fail('not_found', '提示词包不存在：' + id);
      return { prompt: p };
    }
  });

  bus.define({
    name: 'prompt.preview',
    title: '预览提示词包',
    description: '用样例上下文渲染当前模板，看改完之后会发给 AI 什么。',
    category: 'prompt', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, context: { type: 'object' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      const p = promptPacks.preview(id, input.context);
      if (!p) fail('not_found', '提示词包不存在：' + id);
      return { preview: p };
    }
  });

  bus.define({
    name: 'prompt.history',
    title: '提示词版本历史',
    description: '查看一个提示词包最近 20 次修改（版本/时间/修改者）。',
    category: 'prompt', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input) { return { history: promptPacks.history(String(input.id || '')) }; }
  });

  bus.define({
    name: 'prompt.validate',
    title: '校验提示词模板',
    description: '只校验不保存：占位符与关键契约是否齐全。改之前先跑它，别等用户批准完才发现模板不合格。',
    category: 'prompt', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', required: ['id', 'template'], properties: { id: { type: 'string' }, template: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      promptPacks.validate(String(input.id || '').trim(), String(input.template || ''));
      return { ok: true, valid: true, id: String(input.id || '').trim() };
    }
  });

  bus.define({
    name: 'prompt.update',
    title: '修改提示词包',
    description: '替换提示词模板（必须保留占位符与关键契约）；需要用户批准。',
    category: 'prompt', layer: 'feature', risk: 'admin',
    inputSchema: { type: 'object', required: ['id', 'template'], properties: { id: { type: 'string' }, template: { type: 'string' } } }, output: 'json',
    handler: function (input, hctx) {
      const p = promptPacks.update(String(input.id || '').trim(), String(input.template || ''), (hctx && hctx.actor) || 'agent');
      return { prompt: p, note: '已更新；prompt.reset 可恢复内置模板。' };
    }
  });

  bus.define({
    name: 'prompt.reset',
    title: '恢复内置提示词',
    description: '删除用户覆盖，恢复内置模板；需要用户批准。',
    category: 'prompt', layer: 'feature', risk: 'admin',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input, hctx) {
      return { prompt: promptPacks.reset(String(input.id || '').trim(), (hctx && hctx.actor) || 'agent') };
    }
  });

  bus.define({
    name: 'goal.delete',
    title: '删除目标',
    description: '删除目标及其节点/资料/教程/对话/版本。destructive：必须用户批准；不可恢复（备份仍保留）。',
    category: 'goal', layer: 'content', risk: 'destructive',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const id = num(input.goalId || input.id, 'goalId');
      const row = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(id);
      if (!row) fail('not_found', '目标不存在：' + id);
      if (typeof deleteGoal !== 'function') fail('not_implemented', '删除目标未接入服务端');
      deleteGoal(id);
      return { ok: true, goalId: id, title: row.title, note: '目标已删除；备份仍可在设置里找回。' };
    }
  });

  bus.define({
    name: 'node.delete',
    title: '删除节点',
    description: '删除节点及其所有子节点。destructive：必须用户批准；删前会保存版本快照。',
    category: 'node', layer: 'content', risk: 'destructive',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'integer' } } }, output: 'json',
    handler: async function (input) {
      const id = num(input.nodeId || input.id, 'nodeId');
      const row = db.prepare('SELECT id, title, goal_id FROM nodes WHERE id = ?').get(id);
      if (!row) fail('not_found', '节点不存在：' + id);
      if (typeof deleteNode !== 'function') fail('not_implemented', '删除节点未接入服务端');
      const r = await deleteNode(id);
      if (!r) fail('not_found', '节点不存在：' + id);
      return { ok: true, nodeId: id, goalId: row.goal_id, title: row.title, note: '节点已删除；删前版本快照可在版本对比里找回。' };
    }
  });

  bus.define({
    name: 'component.list',
    title: '组件列表',
    description: '列出全部组件（内置 + 文件插件）：scope/kind/开关/是否可关/是否可移除。',
    category: 'component', layer: 'extension', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'json',
    handler: function () {
      if (typeof listComponents !== 'function') fail('not_implemented', '组件列表未接入服务端');
      return { components: listComponents() };
    }
  });

  bus.define({
    name: 'component.describe',
    title: '组件详情',
    description: '读取单个组件的元数据、当前开关与能否关闭。',
    category: 'component', layer: 'extension', risk: 'read',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      if (typeof describeComponent !== 'function') fail('not_implemented', '组件详情未接入服务端');
      const c = describeComponent(id);
      if (!c) fail('not_found', '组件不存在：' + id);
      return { component: c };
    }
  });

  bus.define({
    name: 'component.toggle',
    title: '开关组件',
    description: '全局开启/关闭组件（write，审计）。核心组件不可关闭；主题组件互斥。',
    category: 'component', layer: 'extension', risk: 'write',
    inputSchema: { type: 'object', required: ['id', 'enabled'], properties: { id: { type: 'string' }, enabled: { type: 'boolean' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      if (typeof toggleComponent !== 'function') fail('not_implemented', '组件开关未接入服务端');
      if (input.enabled === undefined || input.enabled === null) fail('bad_input', '缺少 enabled');
      return { component: toggleComponent(id, !!input.enabled) };
    }
  });

  bus.define({
    name: 'setting.list',
    title: '设置列表',
    description: '只读列出 Agent 可见的非密钥设置（备份/搜集/清洗/检索/AI 模型/讲解风格）。',
    category: 'setting', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', properties: {} }, output: 'json',
    handler: function () {
      const settings = Object.keys(SAFE_SETTINGS).map(settingRow);
      return { settings: settings };
    }
  });

  bus.define({
    name: 'setting.get',
    title: '读取设置',
    description: '读取一个非密钥设置。AI key / sync token 等不在白名单，会返回 forbidden。',
    category: 'setting', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const key = String(input.key || '').trim();
      const row = settingRow(key);
      if (!row) fail('forbidden', '这个设置不在 Agent 可读白名单里：' + key);
      return { setting: row };
    }
  });

  bus.define({
    name: 'setting.set',
    title: '修改设置',
    description: '修改一个非密钥设置（admin，必须用户批准）。值会按类型/范围校验，改完写备份。',
    category: 'setting', layer: 'feature', risk: 'admin',
    inputSchema: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: {} } }, output: 'json',
    handler: function (input) {
      const key = String(input.key || '').trim();
      const spec = SAFE_SETTINGS[key];
      if (!spec) fail('forbidden', '这个设置不在 Agent 可写白名单里：' + key);
      if (input.value === undefined || input.value === null) fail('bad_input', '缺少 value');
      let value;
      if (spec.type === 'bool') {
        const s = String(input.value).toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(s)) value = '1';
        else if (['0', 'false', 'no', 'off'].includes(s)) value = '0';
        else fail('bad_input', key + ' 只接受 true/false');
      } else if (spec.type === 'int') {
        const n = Number(input.value);
        if (!Number.isFinite(n) || Math.floor(n) !== n) fail('bad_input', key + ' 必须是整数');
        if (n < spec.min || n > spec.max) fail('bad_input', key + ' 范围 ' + spec.min + '~' + spec.max);
        value = String(n);
      } else if (spec.type === 'enum') {
        const s = String(input.value);
        if (!spec.values.includes(s)) fail('bad_input', key + ' 只能是 ' + spec.values.join(' / '));
        value = s;
      } else {
        value = String(input.value).slice(0, spec.max || 500);
      }
      setSetting(key, value);
      backup();
      return { setting: { key: key, value: value, type: spec.type, desc: spec.desc }, note: '已写入；改坏了可以用同一个命令改回。' };
    }
  });

  bus.define({
    name: 'friction.report',
    title: '记录摩擦',
    description: '记录用户觉得不舒服的地方（页面/组件/动作/期望/实际/严重度），供后续修复与洞察使用。',
    category: 'friction', layer: 'feature', risk: 'write',
    inputSchema: {
      type: 'object', required: ['description'],
      properties: {
        goalId: { type: 'integer' }, page: { type: 'string' }, component: { type: 'string' },
        action: { type: 'string' }, description: { type: 'string' },
        expected: { type: 'string' }, actual: { type: 'string' }, severity: { type: 'string' }
      }
    }, output: 'json',
    handler: function (input) {
      const description = String(input.description || '').trim();
      if (!description) fail('bad_input', 'description 不能为空');
      const goalId = input.goalId ? num(input.goalId, 'goalId') : null;
      const severity = ['low', 'medium', 'high'].includes(String(input.severity)) ? String(input.severity) : 'medium';
      const at = nowISO();
      db.prepare('INSERT INTO friction_reports (goal_id, page, component, action, description, expected, actual, severity, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(goalId, String(input.page || '').slice(0, 100), String(input.component || '').slice(0, 60), String(input.action || '').slice(0, 120),
          description.slice(0, 1000), String(input.expected || '').slice(0, 500), String(input.actual || '').slice(0, 500), severity, 'open', '', at, at);
      const id = lastId();
      return { id: id, status: 'open', severity: severity, note: '已记录；fix-friction 会把它当成线索，但改之前仍要先问用户。' };
    }
  });

  bus.define({
    name: 'friction.list',
    title: '摩擦列表',
    description: '列出摩擦记录（open / fixed / dismissed），可按目标、组件、状态过滤。',
    category: 'friction', layer: 'feature', risk: 'read',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, component: { type: 'string' }, goalId: { type: 'integer' }, limit: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      const where = [], vals = [];
      if (input.status) { where.push('status = ?'); vals.push(String(input.status)); }
      if (input.component) { where.push('component = ?'); vals.push(String(input.component)); }
      if (input.goalId) { where.push('goal_id = ?'); vals.push(num(input.goalId, 'goalId')); }
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
      const sql = 'SELECT * FROM friction_reports' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';
      const stmt = db.prepare(sql);
      return { reports: stmt.all(...vals.concat([limit])) };
    }
  });

  bus.define({
    name: 'friction.update',
    title: '更新摩擦状态',
    description: '把摩擦标记为 fixed / dismissed / open，可附一句说明（write，审计）。',
    category: 'friction', layer: 'feature', risk: 'write',
    inputSchema: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'integer' }, status: { type: 'string' }, note: { type: 'string' } } },
    output: 'json',
    handler: function (input) {
      const id = num(input.id, 'id');
      const status = String(input.status || '');
      if (!['open', 'fixed', 'dismissed'].includes(status)) fail('bad_input', 'status 只能是 open / fixed / dismissed');
      const row = db.prepare('SELECT id FROM friction_reports WHERE id = ?').get(id);
      if (!row) fail('not_found', '摩擦记录不存在：' + id);
      db.prepare('UPDATE friction_reports SET status = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(status, String(input.note || '').slice(0, 500), nowISO(), id);
      return { id: id, status: status, note: String(input.note || '').slice(0, 500) };
    }
  });

  bus.define({
    name: 'component.export',
    title: '导出非核心组件',
    description: '把非核心组件的 server/client/style 导出成 bundle，供 Agent 阅读、修改后再安装。内置组件不可导出。',
    category: 'component', layer: 'extension', risk: 'read',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      if (typeof exportComponent !== 'function') fail('not_implemented', '组件导出未接入服务端');
      return { bundle: exportComponent(id) };
    }
  });

  bus.define({
    name: 'component.validate',
    title: '校验组件包',
    description: '只校验不安装：format/id/内置保护/体积/服务端入口/前端与服务端语法。',
    category: 'component', layer: 'extension', risk: 'read',
    inputSchema: { type: 'object', required: ['bundle'], properties: { bundle: { type: 'object' } } }, output: 'json',
    handler: function (input) {
      if (typeof validateComponent !== 'function') fail('not_implemented', '组件校验未接入服务端');
      return { summary: validateComponent(input.bundle || {}) };
    }
  });

  bus.define({
    name: 'component.stage',
    title: '暂存组件包',
    description: '把组件包暂存到本机（不写正式目录），返回 changeId 与 previewUrl；用户批准后用 component.install 安装。',
    category: 'component', layer: 'extension', risk: 'write',
    inputSchema: { type: 'object', required: ['bundle'], properties: { bundle: { type: 'object' } } }, output: 'json',
    handler: function (input) {
      if (typeof validateComponent !== 'function') fail('not_implemented', '组件校验未接入服务端');
      const summary = validateComponent(input.bundle || {});
      const stage = putComponentStage(input.bundle, summary);
      return {
        changeId: stage.changeId,
        summary: stage.summary,
        status: stage.status,
        previewUrl: uiBase + '/api/component-staging/' + stage.changeId + '/preview',
        next: '先把 previewUrl 给用户看代码；用户批准后调用 component.install（同一 changeId）并带 approvalId。'
      };
    }
  });

  bus.define({
    name: 'component.install',
    title: '安装组件包',
    description: '安装一个已暂存的非核心组件（admin，必须用户批准）。安装前备份，加载失败会自动回滚旧文件。',
    category: 'component', layer: 'extension', risk: 'admin',
    inputSchema: { type: 'object', required: ['changeId'], properties: { changeId: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const changeId = String(input.changeId || '').trim();
      const stage = getComponentStage(changeId);
      if (!stage || !stage.bundle) fail('not_found', '没有这个暂存组件：' + changeId);
      if (stage.status !== 'staged') fail('bad_input', '这个暂存已经处理过：' + stage.status);
      if (typeof installComponent !== 'function') fail('not_implemented', '组件安装未接入服务端');
      const r = installComponent(stage.bundle);
      markComponentStage(changeId, 'installed');
      return { ok: true, changeId: changeId, id: r.id, loaded: r.loaded, replaced: r.replaced, summary: r.summary, note: '已安装；component.uninstall 可移除，旧版本 bundle 可重新安装回滚。' };
    }
  });

  bus.define({
    name: 'component.uninstall',
    title: '卸载非核心组件',
    description: '删除非核心组件的文件并重新加载（destructive，必须用户批准）。内置组件不可卸载。',
    category: 'component', layer: 'extension', risk: 'destructive',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const id = String(input.id || '').trim();
      if (typeof uninstallComponent !== 'function') fail('not_implemented', '组件卸载未接入服务端');
      return Object.assign({ ok: true }, uninstallComponent(id), { note: '组件文件已删除；如果需要恢复，重新安装之前导出的 bundle。' });
    }
  });

  bus.define({
    name: 'tutorial.list',
    title: '教程列表',
    description: '列出某个目标下的教程（id/标题/节点/格式/更新时间/正文长度）。',
    category: 'tutorial', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const g = db.prepare('SELECT id FROM goals WHERE id = ?').get(gid);
      if (!g) fail('not_found', '目标不存在：' + gid);
      return {
        tutorials: db.prepare('SELECT id, goal_id, node_id, title, format, created_at, updated_at, LENGTH(content) AS content_length FROM tutorials WHERE goal_id = ? ORDER BY updated_at DESC, id DESC').all(gid)
      };
    }
  });

  bus.define({
    name: 'tutorial.rename',
    title: '教程改名',
    description: '修改教程标题（write，审计）。',
    category: 'tutorial', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['tutorialId', 'title'], properties: { tutorialId: { type: 'integer' }, title: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const tid = num(input.tutorialId || input.id, 'tutorialId');
      const title = String(input.title || '').trim().slice(0, 200);
      if (!title) fail('bad_input', '标题不能为空');
      const row = db.prepare('SELECT id,goal_id FROM tutorials WHERE id = ?').get(tid);
      if (!row) fail('not_found', '教程不存在：' + tid);
      const at = nowISO();
      db.prepare('UPDATE tutorials SET title = ?, updated_at = ? WHERE id = ?').run(title, at, tid);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(at, row.goal_id);
      backup();
      return { tutorialId: tid, title: title };
    }
  });

  bus.define({
    name: 'tutorial.delete',
    title: '删除教程',
    description: '删除教程及其版本/书签/进度（destructive，必须用户批准）。',
    category: 'tutorial', layer: 'content', risk: 'destructive',
    inputSchema: { type: 'object', required: ['tutorialId'], properties: { tutorialId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const tid = num(input.tutorialId || input.id, 'tutorialId');
      const row = db.prepare('SELECT id,goal_id,title FROM tutorials WHERE id = ?').get(tid);
      if (!row) fail('not_found', '教程不存在：' + tid);
      db.prepare('DELETE FROM tutorials WHERE id = ?').run(tid);
      try { db.prepare('DELETE FROM tutorial_versions WHERE tutorial_id = ?').run(tid); } catch (e) {}
      try { db.prepare('DELETE FROM tutorial_bookmarks WHERE tutorial_id = ?').run(tid); } catch (e) {}
      try { db.prepare('DELETE FROM tutorial_progress WHERE tutorial_id = ?').run(tid); } catch (e) {}
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), row.goal_id);
      backup();
      return { ok: true, tutorialId: tid, title: row.title };
    }
  });

  /* ===== 简历工坊（resume 组件）：Agent 逐步调用同一套领域方法 =====
     Agent 典型用法（每一步都能单独调用，不用一次跑完）：
       resume.docs {goalId}                       —— 看这个目标下已有几份简历、到哪一步
       resume.create {goalId,title,target_role}   —— 建一份新简历
       resume.upload {docId,filename,base64}      —— 直接传用户发来的简历文件（docx/pdf/txt）
       resume.review {docId}                      —— AI 审查，返回问题清单（不改简历）
       resume.questions {docId}                   —— AI 追问缺哪些信息
       resume.answer {docId,answers:[{id,q,a}]}   —— 把用户回答整理成证据卡
       resume.jd {docId,sourceId?|jd?}            —— 选资料库里已有的 JD，或直接给 JD 文本
       resume.match {docId}                       —— JD-证据匹配矩阵
       resume.finalize {docId}                    —— 生成改写+排版好的终版简历
       resume.get {docId}                         —— 读当前状态与终版正文
     */
  bus.define({
    name: 'resume.docs',
    title: '简历工坊 · 列表',
    description: '列出简历文档（可按目标过滤），返回每份的流水线步骤与进度（read）。',
    category: 'resume', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const docs = d.listDocs({ goalId: (input && input.goalId) || 0 });
      const pipelines = docs.slice(0, 30).map(function (x) {
        try { const p = d.pipeline(x.id); return { id: x.id, title: x.title, stage: p.stage, next_stage: p.next_stage, steps: p.steps, chars: x.chars, evidence_count: p.evidence_count }; }
        catch (e) { return { id: x.id, title: x.title, stage: x.stage || 'upload' }; }
      });
      return { ok: true, docs: docs, pipelines: pipelines, count: docs.length };
    }
  });

  bus.define({
    name: 'resume.create',
    title: '简历工坊 · 新建简历',
    description: '新建一份简历文档（write）。之后用 resume.upload 传文件、resume.review 审查。',
    category: 'resume', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['title'], properties: { goalId: { type: 'integer' }, title: { type: 'string' }, target_role: { type: 'string' }, content_md: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      return { ok: true, doc: d.createDoc(input || {}) };
    }
  });

  bus.define({
    name: 'resume.upload',
    title: '简历工坊 · 上传简历文件',
    description: '把用户发来的简历文件（.docx / .pdf / .txt / .md，base64）解析成正文并进入审查步骤（write）。Agent 收到用户附件后直接调它，用户不用自己点界面。',
    category: 'resume', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' }, filename: { type: 'string' }, base64: { type: 'string' }, text: { type: 'string' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const r = d.importFile(num((input && input.docId), 'docId'), input || {});
      return { ok: true, imported: r.imported, doc: r.doc, next: 'resume.review' };
    }
  });

  /* 审查 / 追问 / 回答 / 匹配 / 改写 / 终版 / 审计：都是「跑一次 AI + 落库」 */
  const AI_CMDS = [
    { name: 'resume.review', title: '简历工坊 · 审查简历', desc: 'AI 审查待修改简历，返回问题清单与需要补充的信息（不改正文）。', risk: 'write', props: ['docId'], next: 'resume.questions' },
    { name: 'resume.questions', title: '简历工坊 · 生成追问', desc: 'AI 找出简历的信息缺口并生成追问，等用户回答后调 resume.answer。', risk: 'write', props: ['docId'], next: 'resume.answer' },
    { name: 'resume.match', title: '简历工坊 · JD 匹配', desc: '把 JD 拆成要求并与证据卡做匹配矩阵，给出证据空白与补强建议。', risk: 'write', props: ['docId'], next: 'resume.finalize' },
    { name: 'resume.finalize', title: '简历工坊 · 生成终版', desc: '按 JD 改写并排版成可直接投递的终版简历（Markdown），之后可导出 docx。', risk: 'write', props: ['docId'], next: 'resume.export' },
    { name: 'resume.audit', title: '简历工坊 · 证据审计', desc: '把简历拆成原子主张，逐条给证据状态并标出夸大模式。', risk: 'write', props: ['docId'], next: '' }
  ];
  AI_CMDS.forEach(function (c) {
    bus.define({
      name: c.name,
      title: c.title,
      description: c.desc + '（write；AI 调用，可能耗时数十秒）',
      category: 'resume', layer: 'content', risk: c.risk,
      inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' }, jd: { type: 'string' }, extra: { type: 'string' } } }, output: 'json',
      async: true,
      handler: async function (input) {
        const d = getResumeDomain && getResumeDomain();
        if (!d) fail('not_found', '简历工坊未启用');
        const r = await d.runAI(num((input && input.docId), 'docId'), c.name.split('.')[1], input || {});
        return { ok: true, kind: r.kind, data: r.data, reportId: r.reportId, doc: r.doc, next: c.next };
      }
    });
  });

  bus.define({
    name: 'resume.answer',
    title: '简历工坊 · 回答转证据卡',
    description: '把用户对追问的回答整理成结构化经历证据卡并入库（write）。answers 传 [{id,q,a}] 或纯文本。',
    category: 'resume', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' }, answers: { type: 'array' } } }, output: 'json',
    async: true,
    handler: async function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const docId = num(input.docId, 'docId');
      const answers = Array.isArray(input.answers) ? input.answers : [];
      const text = answers.map(function (x, i) {
        if (typeof x === 'string') return x;
        return 'Q' + (i + 1) + '：' + String(x.q || x.question || '') + '\nA' + (i + 1) + '：' + String(x.a || x.answer || '');
      }).join('\n\n');
      const r = await d.runAI(docId, 'answers', { answers: text });
      const cards = (r.data && r.data.cards) || [];
      let added = null;
      if (cards.length) { try { added = d.addEvidence(docId, cards); } catch (e) {} }
      return { ok: true, cards: cards, evidence: (added && added.evidence) || [], reportId: r.reportId, next: 'resume.jd' };
    }
  });

  bus.define({
    name: 'resume.jd',
    title: '简历工坊 · 选择岗位 JD',
    description: '选目标资料库里已有的 JD（sourceId）或直接给 JD 文本（jd），避免用户重复上传（write）。不传参数时列出可选的 JD。',
    category: 'resume', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' }, sourceId: { type: 'integer' }, jd: { type: 'string' }, goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      if (input && !input.sourceId && !input.jd) {
        const cur = d.getDoc(num(input.docId, 'docId'));
        return { ok: true, need: 'jd', jd_sources: d.listJdSources((input && input.goalId) || (cur && cur.doc && cur.doc.goal_id) || 0), next: 'resume.match' };
      }
      const r = d.pickJd(num(input.docId, 'docId'), input || {});
      return { ok: true, doc: r.doc, next: 'resume.match' };
    }
  });

  bus.define({
    name: 'resume.get',
    title: '简历工坊 · 读简历状态',
    description: '读一份简历的流水线状态、问题清单、证据卡、匹配矩阵与终版正文（read）。',
    category: 'resume', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' }, withBody: { type: 'boolean' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const docId = num(input.docId, 'docId');
      const p = d.pipeline(docId);
      const g = d.getDoc(docId);
      const out = { ok: true, pipeline: p };
      if (input && input.withBody !== false) {
        out.final_data = (g.doc && g.doc.final_data) || {};
        out.doc = g.doc;
        out.evidence = g.evidence;
        out.versions = g.versions;
        out.reports = g.reports;
      }
      return out;
    }
  });

  bus.define({
    name: 'resume.export_html',
    title: '简历工坊 · 导出 HTML',
    description: '把终版简历导出成自包含、可直接编辑与打印成 PDF 的 HTML（read）。',
    category: 'resume', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const r = d.exportHtml(num(input.docId, 'docId'));
      return { ok: true, filename: r.filename, chars: r.html.length, html: r.html };
    }
  });

  bus.define({
    name: 'resume.export',
    title: '简历工坊 · 导出 docx',
    description: '把终版简历导出成 .docx（base64 返回给 Agent，由 Agent 交给用户；write 但只读正文不写库）。',
    category: 'resume', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['docId'], properties: { docId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const d = getResumeDomain && getResumeDomain();
      if (!d) fail('not_found', '简历工坊未启用');
      const r = d.exportDocx(num(input.docId, 'docId'), {});
      return { ok: true, filename: r.filename, bytes: r.buffer.length, base64: r.buffer.toString('base64'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
  });

  bus.define({
    name: 'source.add',
    title: '添加资料',
    description: '往目标资料库添加一条资料（write，审计；会重建检索索引）。',
    category: 'source', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' }, title: { type: 'string' }, content: { type: 'string' }, url: { type: 'string' }, site: { type: 'string' }, kind: { type: 'string' }, quality: { type: 'boolean' } } }, output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const g = db.prepare('SELECT id FROM goals WHERE id = ?').get(gid);
      if (!g) fail('not_found', '目标不存在：' + gid);
      const title = String(input.title || '').trim().slice(0, 200);
      const content = String(input.content || input.text || '').trim().slice(0, 40000);
      if (!title && !content) fail('bad_input', '请填写标题或正文');
      const at = nowISO();
      const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at,quality) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(gid, title || '手动添加的资料', String(input.url || '').trim().slice(0, 500),
          String(input.site || 'Agent 添加').slice(0, 40), String(input.kind || '资料').slice(0, 10),
          String(input.snippet || content.slice(0, 300)).slice(0, 300), content, String(input.published_at || ''), at, input.quality ? 1 : 0);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(at, gid);
      if (typeof onSourceChanged === 'function') { try { onSourceChanged(gid, 'add', 0); } catch (e) {} }
      backup();
      return { ok: true, id: Number(sr.lastInsertRowid), goalId: gid, title: title || '手动添加的资料' };
    }
  });

  bus.define({
    name: 'source.update',
    title: '更新资料',
    description: '修改资料标题/正文/类型/人工星级（write，审计；会重建检索索引）。',
    category: 'source', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'integer' }, title: { type: 'string' }, content: { type: 'string' }, kind: { type: 'string' }, quality: { type: 'boolean' } } }, output: 'json',
    handler: function (input) {
      const sid = num(input.sourceId || input.id, 'sourceId');
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(sid);
      if (!row) fail('not_found', '资料不存在：' + sid);
      const title = input.title != null ? String(input.title).trim().slice(0, 200) : row.title;
      const content = input.content != null ? String(input.content).trim().slice(0, 40000) : row.content;
      const kind = input.kind != null ? String(input.kind).slice(0, 10) : row.kind;
      const quality = input.quality != null ? (input.quality ? 1 : 0) : row.quality;
      db.prepare('UPDATE sources SET title=?, content=?, kind=?, quality=? WHERE id=?').run(title || row.title, content, kind, quality, sid);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), row.goal_id);
      if (typeof onSourceChanged === 'function') { try { onSourceChanged(row.goal_id, 'update', sid); } catch (e) {} }
      backup();
      return { ok: true, sourceId: sid, goalId: row.goal_id };
    }
  });

  bus.define({
    name: 'source.delete',
    title: '删除资料',
    description: '删除一条资料及其代码快照/检索索引（destructive，必须用户批准）。',
    category: 'source', layer: 'content', risk: 'destructive',
    inputSchema: { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const sid = num(input.sourceId || input.id, 'sourceId');
      const row = db.prepare('SELECT id,goal_id,title FROM sources WHERE id = ?').get(sid);
      if (!row) fail('not_found', '资料不存在：' + sid);
      db.prepare('DELETE FROM sources WHERE id = ?').run(sid);
      try { db.prepare('DELETE FROM code_repo_files WHERE source_id = ?').run(sid); } catch (e) {}
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), row.goal_id);
      if (typeof onSourceChanged === 'function') { try { onSourceChanged(row.goal_id, 'delete', sid); } catch (e) {} }
      backup();
      return { ok: true, sourceId: sid, goalId: row.goal_id, title: row.title };
    }
  });

  bus.define({
    name: 'tutorial.generate',
    title: '生成教程',
    description: '为节点在后台生成教程（AI 长任务，返回 taskId；进度看任务中心）。',
    category: 'tutorial', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'integer' }, format: { type: 'string' }, note: { type: 'string' }, codeFiles: { type: 'array' } } }, output: 'json',
    handler: function (input) {
      const nodeId = num(input.nodeId, 'nodeId');
      if (typeof startTutorialGeneration !== 'function') fail('not_implemented', '教程生成未接入服务端');
      const r = startTutorialGeneration(nodeId, { format: input.format, note: input.note, codeFiles: input.codeFiles });
      return { ok: true, taskId: r.taskId, nodeId: r.nodeId, goalId: r.goalId, format: r.format, status: 'started', uiUrl: ui('#/aitasks'), note: '教程在后台生成，进度看左下角任务中心；完成后刷新教程页。' };
    }
  });

  bus.define({
    name: 'tutorial.edit',
    title: '修改教程',
    description: '按修改意见在后台重写教程（AI 长任务，返回 taskId；结构守卫/版本快照沿用原路径）。',
    category: 'tutorial', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['tutorialId', 'feedback'], properties: { tutorialId: { type: 'integer' }, feedback: { type: 'string' }, allowRestructure: { type: 'boolean' } } }, output: 'json',
    handler: async function (input) {
      const tutorialId = num(input.tutorialId || input.id, 'tutorialId');
      const feedback = String(input.feedback || '').trim();
      if (!feedback) fail('bad_input', 'feedback 不能为空');
      if (typeof startTutorialEdit !== 'function') fail('not_implemented', '教程修改未接入服务端');
      const r = await startTutorialEdit(tutorialId, feedback, { allowRestructure: !!input.allowRestructure });
      return { ok: true, taskId: r.taskId, tutorialId: r.tutorialId, status: 'started', uiUrl: ui('#/aitasks'), note: '教程修改在后台执行；进度看任务中心，完成后刷新教程页。allowRestructure 只应在用户明确允许整篇/结构重写时使用。' };
    }
  });

  bus.define({
    name: 'source.collect',
    title: '搜集资料',
    description: '为目标后台搜集信息源（AI 长任务，返回 taskId；进度看任务中心）。',
    category: 'source', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      if (typeof startSourceCollect !== 'function') fail('not_implemented', '资料搜集未接入服务端');
      const r = startSourceCollect(gid);
      return { ok: true, taskId: r.taskId, goalId: r.goalId, status: 'started', uiUrl: ui('#/aitasks'), note: '搜集在后台执行；进度看任务中心。' };
    }
  });

  bus.define({
    name: 'source.digest',
    title: '提炼资料',
    description: '为目标后台提炼资料并生成主题汇总（AI 长任务，返回 taskId；进度看任务中心）。',
    category: 'source', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } }, output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      if (typeof startSourceDigest !== 'function') fail('not_implemented', '资料提炼未接入服务端');
      const r = startSourceDigest(gid);
      return { ok: true, taskId: r.taskId, goalId: r.goalId, status: 'started', uiUrl: ui('#/aitasks'), note: '提炼在后台执行；进度看任务中心，完成后汇总会出现在资料库。' };
    }
  });

  /* ---------- 方案（同一目标多份规划） ---------- */
  function planDomainOrFail() {
    const p = typeof getPlanDomain === 'function' ? getPlanDomain() : null;
    if (!p) fail('not_implemented', '方案功能未接入服务端');
    return p;
  }

  bus.define({
    name: 'plan.list',
    title: '方案列表',
    description: '列出某个目标下的所有规划方案：当前方案 + 其他方案（含节点数、是否当前）。',
    category: 'plan', layer: 'content', risk: 'read',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      return planDomainOrFail().list(num(input.goalId || input.id, 'goalId'));
    }
  });

  bus.define({
    name: 'plan.save',
    title: '保存方案',
    description: '把当前路径另存为一份新方案（不动当前节点）；也可直接传 nodes 快照存成方案。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId'],
      properties: { goalId: { type: 'integer' }, name: { type: 'string' }, nodes: { type: 'array' } }
    },
    output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const p = planDomainOrFail();
      const r = Array.isArray(input.nodes) && input.nodes.length
        ? p.saveFromNodes(gid, input.name, input.nodes)
        : p.saveCurrent(gid, input.name);
      return { ok: true, planId: r.planId, name: r.name, nodes: r.nodes };
    }
  });

  bus.define({
    name: 'plan.create',
    title: '新建空白方案',
    description: '新建一份空白方案（0 个节点，不切换当前路径）。用户想从零搭一版新规划时用；之后可用 plan.switch 切过去加节点。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId'],
      properties: { goalId: { type: 'integer' }, name: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const r = planDomainOrFail().createBlank(gid, input.name);
      return { ok: true, planId: r.planId, name: r.name, nodes: r.nodes };
    }
  });

  bus.define({
    name: 'plan.from_version',
    title: '从历史版本建方案',
    description: '把某个历史版本（版本 id）的快照复制成一份新方案（类似 git 从 commit 建分支），不改当前路径、也不切换。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['versionId'],
      properties: { versionId: { type: 'integer' }, name: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      const r = planDomainOrFail().toPlan(num(input.versionId, 'versionId'), input.name);
      return { ok: true, planId: r.planId, name: r.name, nodes: r.nodes };
    }
  });

  bus.define({
    name: 'plan.apply',
    title: '写入规划方案',
    description: '把「阶段→小目标→任务」树写成一份新方案（不切换当前路径，用户可随时手动切换）。字段：stages[{title,detail,goals:[{title,detail,tasks:[{title,detail,hours,artifact,acceptance}]}]}]；也可传 nodes 原始快照。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId'], properties: {
        goalId: { type: 'integer' }, name: { type: 'string' },
        stages: { type: 'array' }, nodes: { type: 'array' }
      }
    },
    output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const p = planDomainOrFail();
      let r;
      if (Array.isArray(input.stages) && input.stages.length) r = p.applyStages(gid, input.name, input.stages);
      else if (Array.isArray(input.nodes) && input.nodes.length) r = p.saveFromNodes(gid, input.name, input.nodes);
      else fail('bad_input', '需要一个非空的 stages 或 nodes');
      return { ok: true, planId: r.planId, name: r.name, nodes: r.nodes, note: '已存成方案，未切换当前路径；用 plan.switch 或界面「方案」菜单切换。' };
    }
  });

  bus.define({
    name: 'plan.switch',
    title: '切换方案',
    description: '切换到指定方案：先把当前路径存回当前方案，再用目标方案替换节点（保留 done/doing 进度），切换前自动写版本快照并备份。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['goalId', 'planId'],
      properties: { goalId: { type: 'integer' }, planId: { type: 'integer' } }
    },
    output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      const pid = num(input.planId, 'planId');
      return planDomainOrFail().switchTo(gid, pid);
    }
  });

  bus.define({
    name: 'plan.rename',
    title: '方案改名',
    description: '给一份方案改名。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: {
      type: 'object', required: ['planId', 'name'],
      properties: { planId: { type: 'integer' }, name: { type: 'string' } }
    },
    output: 'json',
    handler: function (input) {
      return planDomainOrFail().rename(num(input.planId, 'planId'), input.name);
    }
  });

  bus.define({
    name: 'plan.delete',
    title: '删除方案',
    description: '删除一份方案（不能删除当前正在使用的方案）。destructive：需要用户批准。',
    category: 'plan', layer: 'content', risk: 'destructive',
    inputSchema: { type: 'object', required: ['planId'], properties: { planId: { type: 'integer' } } },
    output: 'json',
    handler: function (input) {
      return planDomainOrFail().remove(num(input.planId, 'planId'));
    }
  });

  bus.define({
    name: 'plan.generate',
    title: '生成规划',
    description: '为目标后台生成路径骨架（AI 长任务，返回 taskId；可能先返回问卷，进度/结果看任务中心）。',
    category: 'plan', layer: 'content', risk: 'write',
    inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'integer' }, answers: { type: 'object' } } }, output: 'json',
    handler: function (input) {
      const gid = num(input.goalId || input.id, 'goalId');
      if (typeof startGoalPlan !== 'function') fail('not_implemented', '规划生成未接入服务端');
      const r = startGoalPlan(gid, input.answers);
      return { ok: true, taskId: r.taskId, goalId: r.goalId, status: 'started', uiUrl: ui('#/aitasks'), note: '规划在后台生成；如果 AI 先返回问卷，任务结果里会带 questions，回答后用同一个命令再跑。' };
    }
  });

  bus.fullManifest = fullManifest;
  bus.app = app;
  bus.getComponentStage = getComponentStage;
  bus.promptPacks = promptPacks;
  bus.approvals = approvals;
  bus.getApproval = approvals.get;
  bus.approve = approvals.approve;
  bus.reject = approvals.reject;
  bus.listApprovals = approvals.list;
  bus.listAudit = listAudit;
  return bus;
};
