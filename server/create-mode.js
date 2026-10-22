'use strict';
/**
 * 思而行 · 创造模式（Create mode）
 * ---------------------------------------------------------------------------
 * 仿 DSH 的 Creator preset（agent preset cordis）实现：
 *   1. 对话里给 AI 一份「扩展点说明书」：可改哪些页面、三种插件契约、CSS 变量、
 *      已装用户插件、安全红线、输出协议（create JSON 块，围栏用三个反引号）。
 *   2. AI 不直接写文件，只输出结构化 create 块；服务端解析 → 静态校验 → 暂存。
 *   3. 用户在对话卡片上点「安装并查看」才真正落盘（= DSH 的 plugin_manager
 *      install_bundle：AI 能准备代码，但不能自己批准）。安装前快照旧版本，
 *      失败自动回滚；装完立刻可以在真实页面里看效果（DSH：用装好的插件本身当预览）。
 *   4. 产物只写 DATA_DIR（ui-plugins / plugins），绝不写程序目录，升级不冲突。
 *
 * 为什么不用 function calling：思而行 AI 接入层是「单轮文本 + 结构化块」模型
 * （server/prompts/chat-packs.js 的 ops 同款），这样 DeepSeek / Qwen / Kimi 等
 * 任意 OpenAI 兼容接口都能用，不挑 provider。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { BUILTIN_ROUTES, UI_HOST_API } = require('./ui-plugins');
const { template } = require('../language/prompts');

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const CREATE_API = 'sierxing.create/1';
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
/* 同一条服务端错误文案多处复用（也帮 i18n 硬编码预算：复用只算一次）。 */
const MSG_NO_RECORD = '没有这个创造记录：';
const MSG_ALREADY_INSTALLED = '这个创造已经安装过：';
const MAX_FILES = 8;
const LIMITS = {
  manifest: 8 * 1024,
  entry: 200 * 1024,
  style: 100 * 1024,
  componentServer: 200 * 1024,
  componentClient: 300 * 1024,
  componentStyle: 100 * 1024,
  total: 800 * 1024
};

/* 可覆盖的页面（与 ui-plugins 的 BUILTIN_ROUTES 对齐；页面 id 就是插件覆盖的键）。 */
const PAGES = {
  home: { label: '首页', route: '#/', desc: '目标卡片墙、今日任务、快捷入口' },
  guide: { label: '新手引导', route: '#/guide/1', desc: '分步引导页' },
  settings: { label: '设置', route: '#/settings', desc: 'AI 接入、同步、外观、数据等设置' },
  components: { label: '组件管理', route: '#/components', desc: '功能组件开关/导入/分类' },
  library: { label: '资料库', route: '#/library', desc: '资料清单、提炼汇总、导入' },
  aitasks: { label: 'AI 任务', route: '#/aitasks', desc: '后台 AI 任务进度与历史' },
  versions: { label: '版本历史', route: '#/g/:id/versions', desc: '目标版本快照' },
  diff: { label: '版本对比', route: '#/g/:id/diff/:vid', desc: '两个版本的差异' },
  roadmap: { label: '路线图', route: '#/g/:id/map', desc: '阶段/小目标/任务树与导图' },
  goal: { label: '目标页', route: '#/g/:id', desc: '目标信息、条件、组件入口' },
  chat: { label: '对话页', route: '#/g/:id/chat', desc: '目标内的 AI 对话' },
  tutorial: { label: '教程', route: '#/t/:id', desc: '教程正文、标注、练习' }
};

/* 安全红线：命中即拒绝（不是警告）。原则同 DSH：默认无外部依赖、无网络、无子进程。 */
const NET_PATTERNS = [
  [/\bfetch\s*\(\s*['"]https?:/i, '不允许 fetch 外部地址（只能用相对路径 /api/...）'],
  [/\bnew\s+WebSocket\s*\(\s*['"]wss?:/i, '不允许连接外部 WebSocket'],
  [/\bXMLHttpRequest\b/i, '不允许 XMLHttpRequest'],
  [/\bsendBeacon\s*\(\s*['"]https?:/i, '不允许向外部地址发包'],
  [/\bimport\s*\(\s*['"]https?:/i, '不允许 import 外部地址']
];
const JS_BAD = [
  [/\bchild_process\b/, '不允许子进程'],
  [/\bprocess\s*\.\s*(exit|kill|env|binding|dlopen)\b/, '不允许操作宿主进程'],
  [/\b(eval|new\s+Function)\s*\(/, '不允许 eval / new Function']
];
const COMPONENT_SERVER_BAD = [
  [/\bchild_process\b/, '不允许子进程'],
  [/\bnode:(http|https|net|tls|dgram|dns)\b/, '不允许网络模块'],
  [/\brequire\s*\(\s*['"](http|https|net|tls|dgram|dns)['"]\s*\)/, '不允许网络模块'],
  [/\b(eval|new\s+Function)\s*\(/, '不允许 eval / new Function']
];

function bad(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function nowISO() { return new Date().toISOString(); }

/* ---------------- 1. 解析 AI 输出里的 create 块 ---------------- */
/* 模型写 create 块最常见的坏法（用户真实碰到）：
   ① JSON 字符串里直接换行（JSON 不允许裸换行）→ JSON.parse 报 Unterminated string；
   ② 结尾多一个逗号 / 围栏前后夹着说明文字；
   ③ 围栏里再出现 \`\`\`（代码字符串里常见）→ 按「第一个结束围栏」切会把 JSON 截断。
   这里：先按原样解析；失败则把字符串内部的裸控制字符转义 + 去尾逗号；仍失败就依次试
   后面的结束围栏（取第一个能解析成功的）。都失败才把原始错误交给用户。 */
function repairJSONString(body) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  return out;
}
function tryParseCreateJSON(body) {
  try { return { ok: true, value: JSON.parse(body) }; } catch (e0) {
    const fixed = repairJSONString(body);
    const attempts = [fixed, fixed.replace(/,\s*([\]}])/g, '$1')];
    for (let i = 0; i < attempts.length; i++) {
      try { return { ok: true, value: JSON.parse(attempts[i]), repaired: true }; } catch (e) {}
    }
    return { ok: false, error: e0 };
  }
}
function parseCreateOutput(text) {
  const raw = String(text || '');
  /* 开围栏允许 ``` create / ```Create（模型经常带空格/大小写不同） */
  const openRe = new RegExp(FENCE + '\\s*[Cc]reate\\s*\\n', 'm');
  const om = openRe.exec(raw);
  if (!om) return { found: false, reply: raw.trim(), artifact: null, error: '' };
  const bodyStart = om.index + om[0].length;
  const rest = raw.slice(bodyStart);
  /* 所有候选结束围栏；依次尝试，取第一个能解析成 JSON 对象的 */
  const closes = [];
  let at = rest.indexOf(FENCE);
  while (at >= 0 && closes.length < 60) { closes.push(at); at = rest.indexOf(FENCE, at + FENCE.length); }
  const candidates = closes.length ? closes : [rest.length];
  let artifact = null, cutAt = -1, firstErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const r = tryParseCreateJSON(rest.slice(0, candidates[i]));
    if (!r.ok) { if (!firstErr) firstErr = r.error; continue; }
    if (r.value && typeof r.value === 'object') { artifact = r.value; cutAt = candidates[i]; break; }
  }
  let error = '';
  if (!artifact) {
    cutAt = closes.length ? closes[0] : rest.length;
    error = 'create 块不是合法 JSON：' + ((firstErr && firstErr.message) || '格式不完整');
  }
  /* 正文里切掉 JSON 块（含围栏）。围栏没闭合时 JSON 之后的内容一并丢掉 ——
     否则那坨 JSON 会当正文显示给用户（"它输出了一大堆东西"就是这么来的）。 */
  const endIndex = closes.length ? bodyStart + cutAt + FENCE.length : raw.length;
  let reply = closes.length ? (raw.slice(0, om.index) + raw.slice(endIndex)) : raw.slice(0, om.index);
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();
  if (!artifact) return { found: true, reply: reply, artifact: null, error: error };
  return { found: true, reply: reply, artifact: artifact, error: '' };
}

/* ---------------- 2. 校验 ---------------- */
function checkText(text, patterns, label) {
  for (const pair of patterns) if (pair[0].test(text)) throw bad('forbidden', label + '：' + pair[1]);
}
function checkSyntax(code, label, ext) {
  const tmp = path.join(os.tmpdir(), 'sx-create-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + (ext || '.js'));
  try {
    fs.writeFileSync(tmp, code, 'utf8');
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || e).split('\n').slice(0, 4).join(' ');
    throw bad('syntax', label + ' 语法检查未通过：' + detail.slice(0, 300));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

function normString(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw bad('bad_input', '没有可解析的创造内容');
  const kind = normString(artifact.kind, 20);
  if (['ui-page', 'skin', 'component'].indexOf(kind) < 0) {
    throw bad('bad_input', 'kind 必须是 ui-page / skin / component 之一（收到：' + (kind || '空') + '）');
  }
  const id = normString(artifact.id, 60);
  if (!ID_RE.test(id)) throw bad('bad_input', 'id 不合法：只能小写字母开头，含小写字母/数字/短横线，2-41 位');
  const name = normString(artifact.name, 40) || id;
  const summary = normString(artifact.summary, 300);
  const files = artifact.files && typeof artifact.files === 'object' && !Array.isArray(artifact.files) ? artifact.files : {};
  const fileNames = Object.keys(files);
  if (fileNames.length > MAX_FILES) throw bad('bad_input', '文件太多（最多 ' + MAX_FILES + ' 个）');
  const out = { kind: kind, id: id, name: name, summary: summary, warnings: [], files: {}, manifest: null, bundle: null, page: '' };

  const allText = fileNames.map(function (k) { return String(files[k] == null ? '' : files[k]); }).join('\n');
  if (allText.length > LIMITS.total) throw bad('too_large', '生成内容超过 ' + Math.round(LIMITS.total / 1024) + 'KB，请拆小一点');

  if (kind === 'ui-page') {
    const page = normString(artifact.page, 30);
    if (!PAGES[page]) throw bad('bad_input', 'page 必须是可覆盖页面之一：' + Object.keys(PAGES).join(' / '));
    out.page = page;
    let manifestRaw = files['manifest.json'] != null ? String(files['manifest.json']) : '';
    let manifest = null;
    if (manifestRaw) {
      if (manifestRaw.length > LIMITS.manifest) throw bad('too_large', 'manifest.json 过大');
      try { manifest = JSON.parse(manifestRaw); } catch (e) { throw bad('bad_input', 'manifest.json 不是合法 JSON：' + e.message); }
    }
    manifest = Object.assign({}, manifest || {});
    const entry = String(files['index.js'] == null ? '' : files['index.js']);
    if (!entry.trim()) throw bad('bad_input', 'ui-page 必须提供 index.js');
    if (entry.length > LIMITS.entry) throw bad('too_large', 'index.js 超过 ' + Math.round(LIMITS.entry / 1024) + 'KB');
    const style = files['style.css'] != null ? String(files['style.css']) : '';
    if (style.length > LIMITS.style) throw bad('too_large', 'style.css 超过 ' + Math.round(LIMITS.style / 1024) + 'KB');
    const hasContract = /export\s+default/.test(entry) || /export\s+function\s+mount/.test(entry) || /window\.SXUIPlugin\s*\[/.test(entry);
    if (!hasContract) throw bad('bad_input', 'index.js 必须 export default（Vue 组件）、export function mount，或注册 window.SXUIPlugin[page]');
    checkText(entry, JS_BAD.concat(NET_PATTERNS), 'index.js');
    if (!/window\.SiErXingUI/.test(entry) && !/export\s+function\s+mount/.test(entry) && !/window\.SXUIPlugin/.test(entry)) {
      out.warnings.push('没有使用 window.SiErXingUI（Vue 组件需要从它取 vue/h，否则拿不到运行时）');
    }
    if (style) checkText(style, [[/@import\s+(?:url\()?\s*['"]?https?:/i, '不允许 @import 外部样式']], 'style.css');
    checkSyntax(entry, 'index.js', '.mjs');
    manifest.id = id;
    manifest.name = name;
    manifest.page = page;
    manifest.apiVersion = UI_HOST_API;
    manifest.format = manifest.format === 'classic' ? 'classic' : 'esm';
    manifest.standalone = manifest.standalone !== false;
    out.manifest = manifest;
    out.files = { 'manifest.json': JSON.stringify(manifest, null, 2), 'index.js': entry };
    if (style) out.files['style.css'] = style;
    return out;
  }

  if (kind === 'skin') {
    const css = files['skin.css'] != null ? String(files['skin.css']) : (files['style.css'] != null ? String(files['style.css']) : '');
    if (!css.trim()) throw bad('bad_input', 'skin 必须提供 skin.css');
    if (css.length > LIMITS.style) throw bad('too_large', 'skin.css 超过 ' + Math.round(LIMITS.style / 1024) + 'KB');
    checkText(css, [
      [/@import\s+(?:url\()?\s*['"]?https?:/i, '不允许 @import 外部样式'],
      [/url\s*\(\s*['"]?https?:/i, '不允许引用外部图片/字体'],
      [/\bexpression\s*\(/i, '不允许 CSS expression'],
      [/<script/i, '不允许在 CSS 里写 script']
    ], 'skin.css');
    out.manifest = { id: id, name: name, apiVersion: UI_HOST_API, skin: 'skin.css', skinPriority: Number(artifact.skinPriority) || 10 };
    out.files = { 'manifest.json': JSON.stringify(out.manifest, null, 2), 'skin.css': css };
    return out;
  }

  const server = files['server.js'] != null ? String(files['server.js']) : String(artifact.server || '');
  const client = files['client.js'] != null ? String(files['client.js']) : String(artifact.client || '');
  const style = files['style.css'] != null ? String(files['style.css']) : String(artifact.style || '');
  /* 改现有组件时可以只交改动的文件（例如只改前端就只给 client.js）：
     缺的那份在 stage() 里从当前线上版本继承。新组件必须两份齐全。 */
  if (!server.trim() && !client.trim()) throw bad('bad_input', template('create.err_need_both'));
  if (server.length > LIMITS.componentServer) throw bad('too_large', 'server.js 过大');
  if (client.length > LIMITS.componentClient) throw bad('too_large', 'client.js 过大');
  if (style.length > LIMITS.componentStyle) throw bad('too_large', 'style.css 过大');
  if (server.trim() && !/module\.exports/.test(server)) throw bad('bad_input', 'server.js 必须包含 module.exports');
  checkText(server, COMPONENT_SERVER_BAD, 'server.js');
  checkText(client, JS_BAD.concat(NET_PATTERNS), 'client.js');
  if (style) checkText(style, [[/url\s*\(\s*['"]?https?:/i, '不允许引用外部资源']], 'style.css');
  if (server.trim()) checkSyntax(server, 'server.js', '.js');
  if (client.trim()) checkSyntax(client, 'client.js', '.js');
  if (server.trim() && !/client\s*:/.test(server)) out.warnings.push('server.js 没有声明 client 字段（应为 "/plugins/' + id + '.js"），前端脚本不会自动加载');
  out.bundle = {
    format: 'sierxing-component', formatVersion: 1,
    id: id, name: name, desc: normString(artifact.desc || summary, 200),
    icon: normString(artifact.icon, 8) || '✨',
    category: normString(artifact.category, 20) || '其它',
    version: normString(artifact.version, 20) || '1.0.0',
    order: Number(artifact.order) || 200,
    defaultEnabled: artifact.defaultEnabled !== false,
    goalToggle: artifact.goalToggle !== false,
    server: server, client: client, style: style
  };
  out.files = {};
  if (server.trim()) out.files['server.js'] = server;
  if (client.trim()) out.files['client.js'] = client;
  if (style) out.files['style.css'] = style;
  return out;
}

/* ---------------- 3. 暂存 / 安装 / 回滚 ---------------- */
function createCreateMode(deps) {
  const db = deps.db || null;
  const dataDir = path.resolve(deps.dataDir);
  const stagingDir = path.join(dataDir, 'agent-changes');
  const uiDir = path.resolve(deps.uiDir || path.join(dataDir, 'ui-plugins'));
  const styleCssPath = deps.styleCssPath || '';
  const uiPlugins = deps.uiPlugins || null;
  const log = deps.log || function () {};
  const installComponent = deps.installComponent || null;
  const uninstallComponent = deps.uninstallComponent || null;
  const exportComponent = deps.exportComponent || null;
  /* 数据目录里有没有这个组件的用户版本：决定「撤销安装」是恢复上一版还是删掉覆盖层 */
  const hasUserComponent = deps.hasUserComponent || null;
  /* 读「当前线上版本」的完整源码（用户版本优先，其次内置）：改现有组件时继承没交的文件 */
  const readComponentSource = deps.readComponentSource || null;
  const readComponentMeta = deps.componentMeta || null;
  const validateComponent = deps.validateComponent || null;
  const reload = deps.reloadPlugins || function () { return 0; };
  const mem = new Map();
  let tokenCache = '';

  function ensureSchema() {
    if (!db) return;
    try {
      db.exec('CREATE TABLE IF NOT EXISTS create_changes (' +
        'id TEXT PRIMARY KEY, kind TEXT, plugin_id TEXT, name TEXT, page TEXT, status TEXT, ' +
        'summary TEXT, meta_json TEXT, created_at TEXT, installed_at TEXT)');
    } catch (e) { log('[create] 建表失败：', e.message); }
  }
  ensureSchema();

  function saveRow(row) {
    mem.set(row.id, row);
    if (!db) return;
    try {
      db.prepare('INSERT INTO create_changes (id,kind,plugin_id,name,page,status,summary,meta_json,created_at,installed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET status=excluded.status, meta_json=excluded.meta_json, installed_at=excluded.installed_at')
        .run(row.id, row.kind, row.plugin_id || '', row.name || '', row.page || '', row.status, row.summary || '', JSON.stringify(row), row.created_at, row.installed_at || null);
    } catch (e) { log('[create] 保存暂存记录失败：', e.message); }
  }
  function getRow(id) {
    if (mem.has(id)) return mem.get(id);
    if (!db) return null;
    try {
      const r = db.prepare('SELECT * FROM create_changes WHERE id = ?').get(String(id));
      if (!r) return null;
      const row = JSON.parse(r.meta_json || '{}');
      mem.set(row.id, row);
      return row;
    } catch (e) { return null; }
  }

  function stage(artifact) {
    const v = validateArtifact(artifact);
    if (v.kind === 'component') {
      /* 改现有组件只交改动文件时，其余文件从「线上正在跑的版本」继承：
         用户版本优先，没有用户版本就读程序目录里的内置源码（同 id 覆盖语义）。
         这样「这次只替换前端脚本（client.js），服务端接口与逻辑不动」就不必把 60KB 的
         client.js 之外再整份重发 server.js —— 输出越大越容易截断/JSON 坏掉。 */
      if (!v.bundle.server || !v.bundle.client) {
        const prev = readComponentSource ? (function () { try { return readComponentSource(v.id); } catch (e) { return null; } })() : null;
        if (!prev || (!prev.server && !prev.client)) throw bad('bad_input', template('create.err_need_both'));
        if (!v.bundle.server) v.bundle.server = String(prev.server || '');
        if (!v.bundle.client) v.bundle.client = String(prev.client || '');
        if (!v.bundle.style) v.bundle.style = String(prev.style || '');
        if (!v.bundle.server || !v.bundle.client) throw bad('bad_input', template('create.err_need_both'));
        checkSyntax(v.bundle.server, 'server.js', '.js');
        checkSyntax(v.bundle.client, 'client.js', '.js');
        /* 没显式给的元数据从现版本继承：只改前端时别把组件的名字/图标/分类/开关默认值冲掉 */
        const meta = readComponentMeta ? (function () { try { return readComponentMeta(v.id); } catch (e) { return null; } })() : null;
        if (meta) {
          const art = artifact || {};
          if (!String(art.name || '').trim() && meta.name) { v.name = meta.name; v.bundle.name = meta.name; }
          if (!String(art.desc || '').trim() && !String(art.summary || '').trim() && meta.desc) v.bundle.desc = meta.desc;
          if (!String(art.icon || '').trim() && meta.icon) v.bundle.icon = meta.icon;
          if (!String(art.category || '').trim() && meta.category) v.bundle.category = meta.category;
          if (!String(art.version || '').trim() && meta.version) v.bundle.version = meta.version;
          if (!Number(art.order) && Number(meta.order)) v.bundle.order = Number(meta.order);
          if (art.defaultEnabled == null && meta.defaultEnabled != null) v.bundle.defaultEnabled = meta.defaultEnabled !== false;
          if (art.goalToggle == null && meta.goalToggle != null) v.bundle.goalToggle = meta.goalToggle !== false;
        }
        v.files['server.js'] = v.bundle.server;
        v.files['client.js'] = v.bundle.client;
        if (v.bundle.style) v.files['style.css'] = v.bundle.style;
      }
      if (validateComponent) {
        try { validateComponent(v.bundle); } catch (e) { throw bad(e.code || 'bad_input', e.message); }
      }
    }
    const changeId = 'chg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const dir = path.join(stagingDir, changeId);
    fs.mkdirSync(dir, { recursive: true });
    const fileList = [];
    for (const k of Object.keys(v.files)) {
      const full = path.join(dir, k);
      fs.writeFileSync(full, v.files[k], 'utf8');
      fileList.push({ name: k, bytes: Buffer.byteLength(v.files[k], 'utf8') });
    }
    const row = {
      id: changeId, kind: v.kind, plugin_id: v.id, name: v.name, page: v.page || '',
      summary: v.summary, status: 'staged', warnings: v.warnings || [],
      files: fileList, manifest: v.manifest, bundle: v.bundle,
      created_at: nowISO(), installed_at: null
    };
    saveRow(row);
    return {
      changeId: changeId, kind: v.kind, id: v.id, name: v.name, page: v.page || '',
      summary: v.summary, files: fileList, warnings: row.warnings,
      /* 只有页面插件需要「装完跳到它覆盖的页面」；组件/皮肤是给当前页面加能力，
         跳到组件管理页反而打断用户（真实反馈：改完当前组件刷新后被弹到 #/components，
         要再点好几步才回得来）。空 route = 前端原地刷新。 */
      route: v.kind === 'ui-page' ? (PAGES[v.page] && PAGES[v.page].route) || '#/' : '',
      verify: (row.warnings && row.warnings.length) ? '安装后检查页面是否报错' : '安装后刷新即可看到'
    };
  }

  function readChange(changeId) {
    const row = getRow(changeId);
    if (!row) throw bad('not_found', MSG_NO_RECORD + changeId + '（可能已清理或服务重启）');
    if (row.status === 'discarded') throw bad('not_found', '这个创造已经放弃了：' + changeId);
    const dir = path.join(stagingDir, row.id);
    if (!fs.existsSync(dir)) throw bad('not_found', '暂存文件已不存在（可能已安装到正式目录或已清理）：' + changeId);
    const files = (row.files || []).map(function (f) {
      let code = '';
      try { code = fs.readFileSync(path.join(dir, f.name), 'utf8'); } catch (e) { code = '（文件已不存在）'; }
      return { name: f.name, bytes: f.bytes, code: code.slice(0, 40000) };
    });
    return Object.assign({}, row, { files: files });
  }

  function snapshotTarget(row) {
    const backupDir = path.join(stagingDir, row.id, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    if (row.kind === 'ui-page' || row.kind === 'skin') {
      const dest = path.join(uiDir, row.plugin_id);
      if (fs.existsSync(dest)) {
        fs.cpSync(dest, path.join(backupDir, 'ui-plugin'), { recursive: true });
        row.hadBackup = true;
      }
    } else if (row.kind === 'component' && exportComponent) {
      /* 只有「数据目录里已经有一份用户版本」才需要快照来回滚；
         覆盖内置组件时数据目录本来就没有旧文件 —— exportComponent 会回落到读程序目录，
         把那份内置源码当备份写回去，撤销安装就变成「在数据目录里又放一份内置代码」，
         覆盖层永远撤不掉（真实 bug）。所以先问 hasUserComponent。 */
      const hadUser = !hasUserComponent || hasUserComponent(row.plugin_id);
      try {
        const prev = hadUser ? exportComponent(row.plugin_id) : null;
        if (prev && prev.server) {
          fs.writeFileSync(path.join(backupDir, 'component.json'), JSON.stringify(prev, null, 2), 'utf8');
          row.hadBackup = true;
        }
      } catch (e) {}
    }
    return backupDir;
  }

  function restoreBackup(row, backupDir) {
    if (row.kind === 'ui-page' || row.kind === 'skin') {
      const dest = path.join(uiDir, row.plugin_id);
      const saved = path.join(backupDir, 'ui-plugin');
      if (fs.existsSync(saved)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(saved, dest, { recursive: true });
        if (uiPlugins && typeof uiPlugins.setEnabled === 'function') { try { uiPlugins.setEnabled(row.plugin_id, true); } catch (e) {} }
      } else {
        fs.rmSync(dest, { recursive: true, force: true });
        if (uiPlugins && typeof uiPlugins.setEnabled === 'function') { try { uiPlugins.setEnabled(row.plugin_id, false); } catch (e) {} }
      }
      return;
    }
    if (row.kind === 'component') {
      const saved = path.join(backupDir, 'component.json');
      if (fs.existsSync(saved)) {
        const prev = JSON.parse(fs.readFileSync(saved, 'utf8'));
        if (installComponent) installComponent(prev);
      } else if (uninstallComponent) {
        try { uninstallComponent(row.plugin_id); } catch (e) {}
      }
    }
  }

  function install(changeId) {
    const row = getRow(changeId);
    if (!row) throw bad('not_found', MSG_NO_RECORD + changeId);
    if (row.status === 'installed') throw bad('conflict', MSG_ALREADY_INSTALLED + row.name);
    const dir = path.join(stagingDir, row.id);
    if (!fs.existsSync(dir)) throw bad('not_found', '暂存文件已不存在，请重新生成');
    const backupDir = snapshotTarget(row);
    try {
      if (row.kind === 'ui-page' || row.kind === 'skin') {
        const dest = path.join(uiDir, row.plugin_id);
        const tmp = path.join(uiDir, '.tmp-' + row.plugin_id + '-' + Date.now());
        fs.mkdirSync(uiDir, { recursive: true });
        fs.mkdirSync(tmp, { recursive: true });
        for (const f of row.files || []) fs.copyFileSync(path.join(dir, f.name), path.join(tmp, f.name));
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(tmp, dest);
        if (uiPlugins && typeof uiPlugins.setEnabled === 'function') uiPlugins.setEnabled(row.plugin_id, true);
        row.status = 'installed';
        row.installed_at = nowISO();
        saveRow(row);
        return {
          ok: true, changeId: row.id, kind: row.kind, id: row.plugin_id, name: row.name,
          page: row.page || '', route: row.kind === 'ui-page' ? (PAGES[row.page] && PAGES[row.page].route) || '#/' : '',
          reload: true, rolledBack: false,
          warnings: (row.warnings || []).concat(row.kind === 'skin' ? ['皮肤会在刷新页面后生效'] : [])
        };
      }
      if (row.kind === 'component') {
        if (!installComponent) throw bad('not_implemented', '服务端未接入组件安装');
        const bundle = Object.assign({}, row.bundle || {});
        bundle.server = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
        bundle.client = fs.readFileSync(path.join(dir, 'client.js'), 'utf8');
        try { bundle.style = fs.readFileSync(path.join(dir, 'style.css'), 'utf8'); } catch (e) { bundle.style = ''; }
        const r = installComponent(bundle);
        row.status = 'installed';
        row.installed_at = nowISO();
        saveRow(row);
        return {
          ok: true, changeId: row.id, kind: row.kind, id: row.plugin_id, name: row.name,
          page: '', route: '', reload: true, loaded: r && r.loaded,
          warnings: (row.warnings || []).concat(['功能组件需要刷新页面才能加载前端部分'])
        };
      }
      throw bad('bad_input', '未知类型：' + row.kind);
    } catch (e) {
      try { restoreBackup(row, backupDir); } catch (e2) {}
      throw e;
    }
  }

  function rollback(changeId) {
    const row = getRow(changeId);
    if (!row) throw bad('not_found', MSG_NO_RECORD + changeId);
    const backupDir = path.join(stagingDir, row.id, 'backup');
    restoreBackup(row, backupDir);
    row.status = 'rolled_back';
    row.installed_at = nowISO();
    saveRow(row);
    try { reload(); } catch (e) {}
    return { ok: true, changeId: row.id, id: row.plugin_id, restored: row.hadBackup ? 'previous' : 'removed', reload: true };
  }

  function discard(changeId) {
    const row = getRow(changeId);
    if (!row) throw bad('not_found', MSG_NO_RECORD + changeId);
    /* 已经装上了就不能「放弃」：用户点放弃的语义是「这次生成不要了」，
       但文件已经在正式目录里生效，悄悄删暂存记录会让「撤销安装」永久失效
       （真实 bug：组件装坏后卡片只能点放弃，结果弃了记录、坏文件还在）。 */
    if (row.status === 'installed') throw bad('conflict', MSG_ALREADY_INSTALLED + row.name);
    try { fs.rmSync(path.join(stagingDir, row.id), { recursive: true, force: true }); } catch (e) {}
    row.status = 'discarded';
    saveRow(row);
    return { ok: true, changeId: row.id, discarded: true };
  }

  /* 卡片状态同步：刷新对话后卡片不能退回「已生成」——否则已装好的版本又显示
     「安装并查看 / 放弃」，用户点了只会收到「已经安装过」。这里只回状态，不读暂存文件。 */
  function status(changeId) {
    const row = getRow(changeId);
    if (!row) throw bad('not_found', MSG_NO_RECORD + changeId);
    return {
      ok: true, changeId: row.id, kind: row.kind, id: row.plugin_id, name: row.name,
      page: row.page || '', status: row.status || 'staged', installed_at: row.installed_at || null
    };
  }

  function readTokens() {
    if (tokenCache) return tokenCache;
    const names = new Set();
    try {
      const css = fs.readFileSync(styleCssPath, 'utf8');
      const re = /--([a-z0-9][a-z0-9-]{2,40})\s*:/gi;
      let m;
      while ((m = re.exec(css))) names.add('--' + m[1]);
    } catch (e) {}
    tokenCache = Array.from(names).sort().slice(0, 60).join(' ');
    return tokenCache;
  }

  function pagesBlock() {
    const lines = ['【可覆盖的页面（page 字段只能填这些 id）】'];
    for (const k of Object.keys(PAGES)) {
      const p = PAGES[k];
      lines.push('- ' + k + '：' + p.label + '（路由 ' + p.route + '）— ' + p.desc);
    }
    return lines.join('\n');
  }

  function pluginsBlock() {
    const lines = ['【当前已安装的用户插件（同 id 会覆盖，优先起新 id 避免误覆盖）】'];
    let list = [];
    try { list = (uiPlugins && typeof uiPlugins.list === 'function') ? uiPlugins.list() : []; } catch (e) { list = []; }
    if (!list.length) lines.push('（还没有用户插件）');
    else for (const p of list.slice(0, 20)) lines.push('- ' + p.id + '：' + (p.name || '') + (p.page ? '（页面 ' + p.page + '）' : '') + (p.enabled === false ? ' [已停用]' : ''));
    return lines.join('\n');
  }

  function tokensBlock() {
    const t = readTokens();
    return '【可用 CSS 变量（主题 token，优先用它们，深浅色自动适配）】\n' + (t || '（读取失败，直接写颜色也可以）');
  }

  const TEMPLATE_UI_PAGE =
    '// index.js —— 覆盖某个页面（Vue 3，免构建；vue 必须从 window.SiErXingUI 取）\n' +
    'export default {\n' +
    '  setup() {\n' +
    '    const { h, ref, onMounted, onUnmounted } = window.SiErXingUI.vue;\n' +
    '    const n = ref(0);\n' +
    '    const css = ".sxc-page{padding:24px}.sxc-title{font-size:20px;margin-bottom:12px}";\n' +
    '    let styleEl = null;\n' +
    '    onMounted(() => { styleEl = document.createElement("style"); styleEl.id = "sxc-<id>"; styleEl.textContent = css; document.head.appendChild(styleEl); });\n' +
    '    onUnmounted(() => { if (styleEl) styleEl.remove(); });\n' +
    '    return () => h("div", { class: "page sxc-page" }, [\n' +
    '      h("h1", { class: "sxc-title" }, "我的页面"),\n' +
    '      h("button", { class: "btn", onClick: () => n.value++ }, "点了 " + n.value + " 次")\n' +
    '    ]);\n' +
    '  }\n' +
    '};\n' +
    '\n' +
    '// 也可以不用 Vue：export function mount(root, ctx) { root.innerHTML = "..."; return { unmount() {} }; }\n' +
    '// ctx 提供：api / toast / esc / go / state / fmtDate / mdToHTML / safeParse / host / vue';

  const TEMPLATE_SKIN =
    '/* skin.css —— 只改外观时优先用它：叠加在内置样式之后，改 CSS 变量或少量规则 */\n' +
    ':root {\n' +
    '  /* 只覆盖想改的变量，别整屏重写 */\n' +
    '  --card-radius: 18px;\n' +
    '}\n' +
    '/* 也可以写具体规则（用 .page / .btn / .card 等现有类） */\n' +
    '.page { letter-spacing: .2px; }';

  const TEMPLATE_COMPONENT =
    '// server.js —— 组件服务端（Node，module.exports；init(ctx) 里建表/注册路由）\n' +
    'module.exports = {\n' +
    '  id: "<id>", name: "我的功能", desc: "一句话说明", icon: "✨", category: "其它",\n' +
    '  client: "/plugins/<id>.js",   // 前端脚本（不写这一行，前端入口不会自动加载）\n' +
    '  defaultEnabled: false,\n' +
    '  api: [{ method: "GET", path: "/api/<id>/state", handler: function (req, res) { res.json({ ok: true }); } }],\n' +
    '  init: function (ctx) { /* ctx.db / ctx.nowISO / ctx.appDir ... 见 server/plugins/index.js */ }\n' +
    '};\n' +
    '// client.js —— 组件前端（经典脚本，通过 SDK 注册；goalEntry 出现在目标页左栏）\n' +
    'SiErXing.registerPlugin({\n' +
    '  id: "<id>",\n' +
    '  goalEntry: { label: "我的功能", icon: "✨", hash: function (gid) { return "#/g/" + gid + "/<id>"; } },\n' +
    '  routes: [{ match: function (h) { return h.match(/^#\\/g\\/(\\d+)\\/<id>$/); },\n' +
    '    render: async function (m, host) { host.app.innerHTML = "<div class=\\"page\\">你好</div>"; } }]\n' +
    '});';

  function rulesBlock() {
    return [
      '【你是「创造模式」】用户想通过对话定制思而行的界面或功能。你的职责：先理解要改什么，再生成可直接安装的插件文件。',
      '工作方式（仿 DSH Creator）：先给最小可用的一版 → 用户点「安装并查看」→ 在真实页面里验证 → 再迭代。不要一次做一整套。',
      '',
      '【输出协议（必须严格遵守）】',
      '1. 先用 Markdown 写 1~3 句说明：你准备做什么、改哪个页面/组件、为什么。',
      '2. 然后输出恰好一个 create 代码块，内容是一个 JSON 对象（不要注释、不要多余文字）：',
      '   kind=ui-page 时：{"kind":"ui-page","page":"home","id":"weekly-review","name":"每周复盘","summary":"在首页加一张每周复盘卡","files":{"manifest.json":"{...}","index.js":"..."}}',
      '   kind=skin 时：{"kind":"skin","id":"my-skin","name":"我的皮肤","summary":"暖色圆角","files":{"skin.css":"..."}}',
      '   kind=component 时：{"kind":"component","id":"my-tool","name":"我的功能","summary":"...","icon":"✨","category":"其它","files":{"server.js":"...","client.js":"...","style.css":"..."}}',
      '3. files 里是完整文件内容（不是片段）；JSON 里的代码要转义换行。不要输出第二个 create 块。',
      '4. 如果信息不够（改哪个页面、想要什么风格、功能怎么触发），先用一句话问清楚，不要输出 create 块。',
      '',
      '【三种产物怎么选】',
      '- 只改颜色/圆角/字体/间距 → skin（最稳，整站生效，不改结构）。',
      '- 要重做某个页面的布局/内容 → ui-page（整页接管，原版回退随时可用）。',
      '- 要在目标页里加一个可开关的新功能（带自己的数据/接口）→ component。',
      '',
      /* 「改现有组件 / 界面红线」正文在 language/prompts/zh-CN/packs.json（create.rules_ext），
         不写回本文件：提示词正文统一放语言目录，也避免中文硬编码预算上涨。 */
      template('create.rules_ext'),
      '',
      '【硬性约束（违反会被服务端拒绝）】',
      '- 零外部依赖：不许 require 第三方包、不许 import 外部模块；前端只用 window.SiErXingUI（vue/h 从它取）。',
      '- 不许联网（fetch 只能请求本站相对路径 /api/...）、不许子进程、不许 eval / new Function。',
      '- 只覆盖 page 表里的页面 id；id 用小写字母开头的短横线命名；单文件 ≤200KB。',
      '- 不要试图直接改程序目录的文件（server/、public/、ui/）；你的产物一律装到数据目录，内置组件用「同 id 覆盖」的方式改。',
      '- 不要输出「我已经改好了」这类假话：真正生效要等用户点安装。',
      '',
      '【页面与契约】',
      pagesBlock(),
      '',
      pluginsBlock(),
      '',
      tokensBlock(),
      '',
      '【前端可用能力】window.SiErXingUI = { vue, api(path,opts), toast(msg), host }；mount 契约的 ctx 里还有 esc/go/state/fmtDate/mdToHTML/safeParse。',
      '',
      '【模板（照着改，别发明新契约）】',
      '--- ui-page 模板 ---',
      TEMPLATE_UI_PAGE,
      '--- skin 模板 ---',
      TEMPLATE_SKIN,
      '--- component 模板 ---',
      TEMPLATE_COMPONENT
    ].join('\n');
  }

  function promptBlock(opts) {
    const o = opts || {};
    const lines = [];
    lines.push('你是思而行（SiErXing）的「创造模式」助手：通过对话帮用户定制界面（换肤 / 重做页面）或新增、修改功能组件。');
    lines.push('用户是产品的主人，你是执行者：先理解意图，再产出一版最小可用的插件；安装必须由用户点按钮确认，你只负责准备代码。');
    lines.push('');
    if (o.pageText) {
      lines.push('【用户当前正在看的页面】');
      lines.push(o.pageText);
      lines.push('');
    }
    /* 上下文块（由 server.js 组装）：现有源码 / 当前页面 DOM / 最近对话。
       没有对应上下文就整块不出现，免得模型对着一句「（无）」瞎猜。 */
    if (o.historyText) { lines.push(o.historyText); lines.push(''); }
    if (o.sourceText) { lines.push(o.sourceText); lines.push(''); }
    if (o.pageSourceText) { lines.push(o.pageSourceText); lines.push(''); }
    if (o.inventoryText) { lines.push(o.inventoryText); lines.push(''); }
    if (o.domText) { lines.push(o.domText); lines.push(''); }
    lines.push(rulesBlock());
    return lines.join('\n');
  }

  return {
    apiVersion: CREATE_API,
    PAGES: PAGES,
    stagingDir: stagingDir,
    parse: parseCreateOutput,
    validate: validateArtifact,
    stage: stage,
    install: install,
    rollback: rollback,
    discard: discard,
    readChange: readChange,
    status: status,
    promptBlock: promptBlock,
    rulesBlock: rulesBlock,
    limitInfo: LIMITS
  };
}

module.exports = {
  createCreateMode: createCreateMode,
  parseCreateOutput: parseCreateOutput,
  validateArtifact: validateArtifact,
  PAGES: PAGES,
  CREATE_API: CREATE_API,
  LIMITS: LIMITS
};
