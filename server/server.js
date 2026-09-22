const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('[思而行] 当前 Node.js 不支持内置 SQLite（node:sqlite）。');
  console.error('请使用 Node.js 23.4+，或 22.5+ 启动时加 --experimental-sqlite。');
  process.exit(1);
}

const ai = require('./ai');
const { loadPlugins, pluginMeta, matchRoute } = require('./plugins');
const createService = require('./service');
const createSync = require('./sync');
const createUpdate = require('./update');

const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'sierxing.db');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

/* 读取项目根目录的 .env（可选，便于自部署；不会覆盖已存在的环境变量） */
(function loadEnvFile() {
  try {
    const f = path.join(APP_DIR, '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || /^\s*#/.test(line)) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] == null) process.env[m[1]] = v;
    }
  } catch (e) {}
})();
const PORT = Number(process.env.PORT || 3213);
const KEEP_BACKUPS = 30;
const APP_NAME = '思而行';

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LEVEL_NAME = { 0: '阶段', 1: '小目标', 2: '任务' };

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '',
  materials TEXT NOT NULL DEFAULT '',
  weekly_hours TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  parent_id INTEGER,
  level INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  artifact TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'todo',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goal_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  ops TEXT NOT NULL DEFAULT '[]',
  version_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'md',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`);
ai.init({ getSetting: (k, d) => getSetting(k, d), appDir: APP_DIR });
function currentModel() { return getSetting('model', '') || ai.config().model || ''; }
const DEFAULT_VISION_MODEL = 'opencode-go/deepseek-v4-flash-vision-exp';   // opencode 用户的默认视觉模型（与实习速成一致）
function currentVisionModel() {
  const saved = getSetting('vision_model', '') || ai.config().visionModel;
  if (saved) return saved;
  // 没配视觉模型时：opencode 走可读图的默认模型，避免用纯文本模型硬读图导致"提炼失败"
  if (getSetting('ai_provider', 'openai') === 'opencode') return DEFAULT_VISION_MODEL;
  return currentModel();
}

const service = createService({ appDir: APP_DIR, port: PORT, log: (...a) => console.log(...a) });
const update = createUpdate({ appDir: APP_DIR, port: PORT, log: (...a) => console.log(...a) });
let sync = null;   // 多端同步（在 backup 定义后初始化）

sync = createSync({
  db, APP_DIR, DATA_DIR, getSetting, setSetting,
  backup: (...a) => backup(...a),
  log: (...a) => console.log(...a)
});

let PLUGINS = [];
let FILE_PLUGINS = [];   // 来自 server/plugins/*.js 的文件组件

/* 内置组件注册表：scope=core 不可关闭；base=默认开启（可关）；extra=默认关闭（可开）
   文件组件（server/plugins/*.js）默认 scope=extra，可被导入/分享 */
const BUILTIN_COMPONENTS = [
  { id: 'plan',        name: '路线图与规划', icon: '🧭', scope: 'core', order: 1, category: '核心组件',
    desc: '目标管理、骨架生成、任务细化、节点拆分、导图与清单（应用核心，不可关闭）' },
  { id: 'clarify',     name: '规划前问卷',   icon: '📝', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 10,
    desc: '规划前先问清楚：10-14 题问卷（含水平自测）、逐题深挖追问、补充信息' },
  { id: 'constraints', name: '规划约束',     icon: '⛓', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 11,
    desc: '把硬性要求（时间/预算/工具/期限）写成约束，所有 AI 环节严格遵守' },
  { id: 'sources',     name: '信息源检索',   icon: '🔎', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 12,
    desc: '自动检索真实资料（时间筛选 + 广告过滤）作为规划依据，也可手动导入' },
  { id: 'versions',    name: '版本对比与汇报', icon: '📜', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 13,
    desc: '每次改动保存版本快照，可左右对比差异，并生成 AI 变更汇报' },
  { id: 'chat',        name: '对话改规划',   icon: '💬', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 14,
    desc: '右侧对话侧边栏：随时用自然语言让 AI 修改路线图（支持多会话与模型切换）' },
  { id: 'tutorial',    name: '学习教程',     icon: '📘', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 15,
    desc: '为任意任务点生成“真正学会”的完整教程（HTML / Markdown，含练习与自测）' }
];

function componentSettings() {
  const raw = getSetting('components', '{}');
  let obj = {};
  try { obj = JSON.parse(raw) || {}; } catch (e) { obj = {}; }
  return obj;
}
function componentOn(id) {
  const b = BUILTIN_COMPONENTS.find(x => x.id === id);
  if (!b) return true;
  if (b.scope === 'core') return true;
  const map = componentSettings();
  return map[id] != null ? !!map[id] : !!b.defaultEnabled;
}
function setComponent(id, enabled) {
  const map = componentSettings();
  map[id] = !!enabled;
  setSetting('components', JSON.stringify(map));
}
/** 启用中的内置组件 id 列表（供前端隐藏界面用） */
function enabledBuiltins() {
  const out = {};
  for (const b of BUILTIN_COMPONENTS) out[b.id] = componentOn(b.id);
  return out;
}
/* ===== 组件分类（用户可自建/重命名/删除，组件可移动分类） ===== */
function componentCategoryList() {
  const raw = safeParse(getSetting('component_categories', '[]')) || [];
  return (Array.isArray(raw) ? raw : []).map(s => String(s).trim()).filter(Boolean);
}
function saveComponentCategories(list) {
  const uniq = [];
  for (const x of list) { const s = String(x).trim().slice(0, 24); if (s && !uniq.includes(s)) uniq.push(s); }
  setSetting('component_categories', JSON.stringify(uniq));
  return uniq;
}
/* 常用组件（侧边栏置顶，顺序即数组顺序） */
function componentPins() {
  const raw = safeParse(getSetting('component_pins', '[]')) || [];
  return (Array.isArray(raw) ? raw : []).map(String);
}
function saveComponentPins(list) {
  const uniq = [];
  for (const x of list) { const s = String(x); if (s && !uniq.includes(s)) uniq.push(s); }
  setSetting('component_pins', JSON.stringify(uniq));
  return uniq;
}
function componentCategoryMap() {
  const raw = safeParse(getSetting('component_category_map', '{}')) || {};
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}
function saveComponentCategoryMap(map) { setSetting('component_category_map', JSON.stringify(map || {})); }
/** 组件的有效分类：用户指定 > 插件声明 > 其它 */
function effectiveCategory(id, declared) {
  const map = componentCategoryMap();
  const c = map[id];
  return (c && String(c).trim()) || declared || '其它';
}
function allCategoriesWithUsage() {
  const comps = allComponents();
  const used = {};
  for (const c of comps) {
    // 统计全部组件（新建目标选择器的计数由前端按 goalToggle 单独计算）
    const k = c.category || '其它';
    used[k] = (used[k] || 0) + 1;
  }
  const declared = componentCategoryList();
  const auto = Object.keys(used).filter(k => k !== '其它' && !declared.includes(k));
  return { categories: declared.concat(auto), used };
}
function allComponents() {
  const list = BUILTIN_COMPONENTS.map(b => ({ ...b, builtin: true, removable: b.scope !== 'core', client: b.client || '', kind: 'feature',
    category: b.category || (b.scope === 'core' ? '核心组件' : (b.scope === 'base' ? '基础功能组件' : '其它')) }));
  for (const p of FILE_PLUGINS) {
    const kind = p.kind === 'theme' ? 'theme' : 'feature';
    let hasStyle = false;
    try { hasStyle = fs.existsSync(path.join(PUBLIC_DIR, 'plugins', p.id + '.css')); } catch (e) {}
    list.push({
      id: p.id, name: p.name || p.id, icon: p.icon || '✨', desc: p.desc || '',
      category: effectiveCategory(p.id, p.category || (kind === 'theme' ? '外观主题' : '其它')),
      scope: p.scope || (kind === 'theme' ? 'theme' : 'extra'), order: p.order || 100,
      defaultEnabled: !!p.defaultEnabled, goalToggle: p.goalToggle !== false,
      version: p.version || '1.0.0', author: p.author || '',
      kind, hasStyle,
      style: hasStyle ? '/plugins/' + p.id + '.css' : '',
      builtin: !!p.builtin, removable: !p.builtin && p.removable !== false, client: p.client || '',
      file: p.__file || ''
    });
  }
  return list.sort((a, b) => (a.order || 100) - (b.order || 100));
}
function goalPlugins(goal) {
  const raw = (goal && goal.plugins) || '{}';
  let obj = {};
  try { obj = JSON.parse(raw) || {}; } catch (e) { obj = {}; }
  const out = {};
  for (const p of PLUGINS) out[p.id] = obj[p.id] != null ? !!obj[p.id] : !!p.defaultEnabled;
  return out;
}
function pluginCtx() {
  return {
    db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup,
    log: (...a) => console.log(...a),
    fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR,
    getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel
  };
}
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!cols.includes('artifact')) db.exec("ALTER TABLE nodes ADD COLUMN artifact TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('acceptance')) db.exec("ALTER TABLE nodes ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('hours')) db.exec("ALTER TABLE nodes ADD COLUMN hours TEXT NOT NULL DEFAULT '';");
  const scols = db.prepare('PRAGMA table_info(sources)').all().map(c => c.name);
  if (!scols.includes('published_at')) db.exec("ALTER TABLE sources ADD COLUMN published_at TEXT NOT NULL DEFAULT '';");
  const gcols = db.prepare('PRAGMA table_info(goals)').all().map(c => c.name);
  if (!gcols.includes('clarify')) db.exec("ALTER TABLE goals ADD COLUMN clarify TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('clarify_answers')) db.exec("ALTER TABLE goals ADD COLUMN clarify_answers TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('clarify_stage')) db.exec("ALTER TABLE goals ADD COLUMN clarify_stage TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('constraints')) db.exec("ALTER TABLE goals ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]';");
  if (!gcols.includes('plugins')) db.exec("ALTER TABLE goals ADD COLUMN plugins TEXT NOT NULL DEFAULT '{}';");
  if (!gcols.includes('qa')) db.exec("ALTER TABLE goals ADD COLUMN qa TEXT NOT NULL DEFAULT '[]';");
  if (!gcols.includes('ask_round')) db.exec("ALTER TABLE goals ADD COLUMN ask_round INTEGER NOT NULL DEFAULT 0;");
  if (!cols.includes('qa')) db.exec("ALTER TABLE nodes ADD COLUMN qa TEXT NOT NULL DEFAULT '[]';");
  if (!cols.includes('ask_round')) db.exec("ALTER TABLE nodes ADD COLUMN ask_round INTEGER NOT NULL DEFAULT 0;");
  if (!cols.includes('qa_pending')) db.exec("ALTER TABLE nodes ADD COLUMN qa_pending TEXT NOT NULL DEFAULT '';");
  const vcols = db.prepare('PRAGMA table_info(goal_versions)').all().map(c => c.name);
  if (!vcols.includes('snapshot_after')) db.exec("ALTER TABLE goal_versions ADD COLUMN snapshot_after TEXT NOT NULL DEFAULT '';");
  const ccols = db.prepare('PRAGMA table_info(chats)').all().map(c => c.name);
  if (!ccols.includes('session_id')) {
    db.exec("ALTER TABLE chats ADD COLUMN session_id INTEGER NOT NULL DEFAULT 0;");
    for (const row of db.prepare('SELECT DISTINCT goal_id FROM chats WHERE session_id = 0').all()) {
      const t = nowISO();
      const r = db.prepare('INSERT INTO chat_sessions (goal_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)').run(row.goal_id, '默认对话', '', t, t);
      db.prepare('UPDATE chats SET session_id = ? WHERE goal_id = ? AND session_id = 0').run(Number(r.lastInsertRowid), row.goal_id);
    }
  }
  // 启动时修复上次中断的规划状态
  for (const g of db.prepare("SELECT id FROM goals WHERE status = 'planning'").all()) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE goal_id = ?').get(g.id).n;
    db.prepare('UPDATE goals SET status = ?, error = ? WHERE id = ?').run(n > 0 ? 'planned' : 'draft', n > 0 ? '' : '上次规划中断，请重新规划', g.id);
  }
})();
/* 一次性迁移：清理早期版本用过的分类名，让组件回到新的默认分类 */
(function migrateCategories() {
  const LEGACY = ['学习成长', '资料与素材', '刷题与算法', '效率工具', '外观主题'];
  try {
    const list = componentCategoryList();
    const kept = list.filter(x => !LEGACY.includes(x));
    if (kept.length !== list.length) saveComponentCategories(kept);
    const map = componentCategoryMap();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (LEGACY.includes(String(map[k]))) { delete map[k]; changed = true; }
    }
    if (changed) saveComponentCategoryMap(map);
    if (kept.length !== list.length || changed) console.log('[migrate] 已清理早期分类名，组件回到默认分类');
  } catch (e) {}
})();

/* 加载组件（server/plugins/*.js）：init 建表 / 注册路由 */
const PLUGIN_DIR = path.join(__dirname, 'plugins');
function reloadPlugins() {
  try {
    for (const f of fs.readdirSync(PLUGIN_DIR)) {
      if (!f.endsWith('.js')) continue;
      try { delete require.cache[require.resolve(path.join(PLUGIN_DIR, f))]; } catch (e) {}
    }
  } catch (e) {}
  FILE_PLUGINS = loadPlugins(PLUGIN_DIR, pluginCtx());
  PLUGINS = FILE_PLUGINS;
  return FILE_PLUGINS.length;
}
reloadPlugins();
function nowISO() { return new Date().toISOString(); }
function safeParse(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function getSetting(k, d) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
}
function backup() {
  try { if (sync) sync.schedulePush('数据变更'); } catch (e) {}
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `sierxing-${stamp()}.db`));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('sierxing-')).sort();
    while (files.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { console.error('备份失败:', e.message); }
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/* ===== 目标与节点 ===== */
function orderedLeaves(goalId) {
  const nodes = db.prepare('SELECT id, parent_id, title, status, sort_order FROM nodes WHERE goal_id = ?').all(goalId);
  const childrenOf = {};
  for (const n of nodes) (childrenOf[n.parent_id == null ? 'root' : n.parent_id] = childrenOf[n.parent_id == null ? 'root' : n.parent_id] || []).push(n);
  const sortFn = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);
  const out = [];
  const walk = key => {
    for (const k of (childrenOf[key] || []).sort(sortFn)) {
      const kids = childrenOf[k.id] || [];
      if (!kids.length) out.push(k);
      else walk(k.id);
    }
  };
  walk('root');
  return out;
}
function goalWithStats(g) {
  const leaves = orderedLeaves(g.id);
  const t = leaves.length;
  const d = leaves.filter(n => n.status === 'done').length;
  const next = leaves.find(n => n.status === 'doing') || leaves.find(n => n.status !== 'done');
  let nextPath = '';
  if (next && next.parent_id) {
    const sub = db.prepare('SELECT title, parent_id FROM nodes WHERE id = ?').get(next.parent_id);
    const stage = sub && sub.parent_id ? db.prepare('SELECT title FROM nodes WHERE id = ?').get(sub.parent_id) : null;
    nextPath = [stage && stage.title, sub && sub.title].filter(Boolean).join(' / ');
  }
  return { ...g, tasks_total: t, tasks_done: d, next_task: next ? next.title : '', next_task_id: next ? next.id : null, next_task_status: next ? next.status : '', next_path: nextPath };
}
function getGoal(id) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!g) return null;
  const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level ASC, sort_order ASC, id ASC').all(id);
  const tutorials = db.prepare('SELECT id, node_id, title, format, created_at FROM tutorials WHERE goal_id = ? ORDER BY id DESC').all(id);
  return { ...goalWithStats(g), nodes, tutorials };
}
function normalizeSources(arr) {
  if (!Array.isArray(arr)) return '[]';
  const out = [];
  for (const s of arr.slice(0, 8)) {
    if (!s) continue;
    if (typeof s === 'string') { const name = s.trim(); if (name) out.push({ name, note: '' }); continue; }
    const name = String(s.name || '').trim();
    const note = String(s.note || '').trim();
    if (name || note) out.push({ name: name || note.slice(0, 40), note });
  }
  return JSON.stringify(out);
}
function insertNode(goalId, parentId, level, title, detail, sources, sortOrder, extra) {
  const t = nowISO();
  const ex = extra || {};
  db.prepare('INSERT INTO nodes (goal_id, parent_id, level, title, detail, artifact, acceptance, hours, sources, status, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, String(title || '').trim().slice(0, 200), String(detail || '').trim().slice(0, 2000),
      String(ex.artifact || '').trim().slice(0, 500), String(ex.acceptance || '').trim().slice(0, 500), String(ex.hours || '').trim().slice(0, 50),
      normalizeSources(sources), 'todo', sortOrder || 0, t, t);
}
function deleteNodeTree(id) {
  const children = db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(id).map(x => x.id);
  for (const c of children) deleteNodeTree(c);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

/* ===== 信息源获取（必应搜索 + 页面抓取） ===== */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE_NAMES = {
  'nowcoder.com': '牛客网', 'zhipin.com': 'BOSS直聘', 'zhihu.com': '知乎', 'lagou.com': '拉勾',
  'liepin.com': '猎聘', 'csdn.net': 'CSDN', 'juejin.cn': '掘金', 'github.com': 'GitHub',
  'runoob.com': '菜鸟教程', 'cnblogs.com': '博客园', 'segmentfault.com': '思否',
  '51job.com': '前程无忧', 'shixiseng.com': '实习僧', 'jianshu.com': '简书',
  'bilibili.com': '哔哩哔哩', 'xiaohongshu.com': '小红书', 'baidu.com': '百度',
  'campus.qq.com': '腾讯招聘', 'jobs.bytedance.com': '字节招聘', 'talent.alibaba.com': '阿里招聘',
  'careers.tencent.com': '腾讯招聘', 'hr.baidu.com': '百度招聘', 'join.meituan.com': '美团招聘',
  'boos.com': 'BOSS直聘', 'maimai.cn': '脉脉', 'v2ex.com': 'V2EX', 'oschina.net': '开源中国',
  'liaoxuefeng.com': '廖雪峰', 'freecodecamp.org': 'freeCodeCamp', 'w3school.com.cn': 'W3school'
};
function siteOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function siteLabel(host) {
  if (!host) return '';
  for (const k in SITE_NAMES) if (host === k || host.endsWith('.' + k)) return SITE_NAMES[k];
  return host;
}
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t\r]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
function decodeHtml(buf) {
  let cs = 'utf-8';
  const head = buf.slice(0, 3000).toString('latin1').toLowerCase();
  const m = head.match(/charset\s*=\s*["']?([a-z0-9-]+)/);
  if (m) cs = m[1];
  try { return new TextDecoder(cs === 'gb2312' ? 'gbk' : cs, { fatal: false }).decode(buf); }
  catch (e) { return buf.toString('utf8'); }
}
function searchKeyword(title) {
  const k = String(title || '').replace(/^(我想|我想要|想|想要|要|成为|想做|想成为|转行到|转行做|转行|学习|学会|如何|怎么|怎样|准备做|准备)\s*/g, '').trim();
  return k || String(title || '').trim();
}
async function bingSearch(query, count, days) {
  try {
    let url = 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + (count || 20);
    if (days) url += '&qft=+filterui:age-lt' + Math.round(days * 1440);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = decodeHtml(Buffer.from(await res.arrayBuffer()));
    const items = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
    const out = [];
    for (const it of items) {
      const m = it.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!m) continue;
      let href = m[1].replace(/&amp;/g, '&');
      if (href.startsWith('/')) href = 'https://cn.bing.com' + href;
      const title = htmlToText(m[2]);
      const pm = it.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = pm ? htmlToText(pm[1]).slice(0, 400) : '';
      if (!title || !/^https?:/.test(href)) continue;
      out.push({ title, url: href, snippet, date: parseBlockDate(it) });
    }
    return out;
  } catch (e) { return []; }
}
function parseBlockDate(block) {
  const now = Date.now();
  let ts = 0;
  const dm = block.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (dm) ts = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).getTime();
  if (!ts) {
    const dm2 = block.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dm2) ts = new Date(Number(dm2[1]), Number(dm2[2]) - 1, Number(dm2[3])).getTime();
  }
  if (!ts) {
    const rel = block.match(/(\d+)\s*(分钟|小时|天|周|个月)前/);
    if (rel) {
      const n = Number(rel[1]);
      const unit = { '分钟': 60000, '小时': 3600000, '天': 86400000, '周': 7 * 86400000, '个月': 30 * 86400000 }[rel[2]];
      ts = now - n * unit;
    }
  }
  if (!ts && /昨天/.test(block)) ts = now - 86400000;
  if (!ts) return 0;
  if (ts > now + 86400000) return 0; // 未来日期视为无效
  return ts;
}
async function baiduSearch(query, count, days) {
  try {
    let url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query) + '&rn=' + (count || 30);
    if (days) {
      const now = Math.floor(Date.now() / 1000);
      url += `&gpc=stf%3D${now - days * 86400}%2C${now}%7Cstftype%3D2`;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!res.ok) return [];
    if (/wappass|captcha/i.test(res.url || '')) return null;
    const html = decodeHtml(Buffer.from(await res.arrayBuffer()));
    if (/wappass\.baidu|captcha\/tuxing/i.test(html.slice(0, 3000))) return null;
    const blocks = html.match(/<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*result[^"]*c-container|<\/body>)/g) || [];
    if (!blocks.length) return null;
    const out = [];
    for (const b of blocks) {
      const mu = b.match(/mu="([^"]+)"/);
      const titleM = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      let title = titleM ? htmlToText(titleM[2]) : '';
      if (!title) { const hm = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/); if (hm) title = htmlToText(hm[1]); }
      let target = mu ? mu[1].replace(/&amp;/g, '&') : (titleM ? titleM[1] : '');
      let snippet = '';
      const sd = b.match(/s-data:(\{[\s\S]*?\})\s*-->/);
      if (sd) {
        try {
          const data = JSON.parse(sd[1]);
          const lines = (data.summaryData && data.summaryData.generalLines) || [];
          const parts = [];
          for (const ln of lines) for (const d of (ln.data || [])) if (d.text) parts.push(String(d.text).replace(/<[^>]+>/g, ''));
          snippet = parts.join(' ');
        } catch (e) {}
      }
      if (!snippet) {
        let t2 = b.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
        t2 = htmlToText(t2);
        if (title && t2.includes(title)) t2 = t2.replace(title, ' ');
        snippet = t2.slice(0, 400);
      }
      snippet = htmlToText(snippet).slice(0, 400);
      // 解析百度标注的发布时间（含相对时间）
      const ts = parseBlockDate(b);
      if (title && /^https?:/.test(target)) out.push({ title, url: target, snippet, date: ts });
    }
    return out;
  } catch (e) { return []; }
}
async function webSearch(query) {
  const r = await baiduSearch(query, 16);
  if (r.length) return r;
  const b = await bingSearch(query, 10);
  return b;
}
function extractPublishDate(html, text) {
  const sources = [];
  const m1 = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)/i) || html.match(/content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i);
  if (m1) sources.push(m1[1]);
  const m2 = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (m2) sources.push(m2[1]);
  const m3 = html.match(/<meta[^>]+name=["'](?:publishdate|pubdate|date)["'][^>]*content=["']([^"']+)/i);
  if (m3) sources.push(m3[1]);
  const now = Date.now();
  for (const s of sources) {
    const t = Date.parse(s.replace(/[年月]/g, '-').replace(/日/g, ''));
    if (!isNaN(t) && t > 1000000000000 && t <= now + 86400000) return t;
  }
  // 正文头部区域的日期（用于无 meta 的站点）
  const head = String(text || '').slice(0, 600);
  const m4 = head.match(/(20\d{2})[年\-.\/](\d{1,2})[月\-.\/](\d{1,2})/);
  if (m4) {
    const t = new Date(Number(m4[1]), Number(m4[2]) - 1, Number(m4[3])).getTime();
    if (t > 1000000000000 && t <= now + 86400000) return t;
  }
  return 0;
}
async function fetchPage(url, maxLen) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    const finalUrl = res.url || url;
    if (!res.ok) return { text: '', url: finalUrl };
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain/i.test(ct)) return { text: '', url: finalUrl };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 800 * 1024) return { text: '', url: finalUrl };
    const html = decodeHtml(buf);
    const text = htmlToText(html);
    if (text.length < 80) return { text: '', url: finalUrl, date: 0 };
    return { text: text.slice(0, maxLen || 3000), url: finalUrl, date: extractPublishDate(html, text) };
  } catch (e) { return { text: '', url: url }; }
}
const AD_KEYWORDS = /包就业|保就业|保offer|付费内推|培训贷|报名咨询|免费试听|免费领取|领取资料|加微信|扫码|课程咨询|就业班|脱产班|学费|限时优惠|名额有限|点击咨询|在线咨询|试听课|零基础培训|IT培训|程序员培训|培训机构|名师授课|就业保障|简历代写|项目代做|毕设辅导|职业培训|招生简章|关注公众号|公众号回复|资料包|加群|私信我/;
const AD_SITE_RE = /itheima|itcast|qianfeng|tarena|kaikeba|lagouedu|mkbk|hqyj|zhonggong|offcn|huatu|tedu|bjsxt|bawei|xuexiniu|yuanrenxue|itxuexi|kuangstudy|imooc\.com\/course|ke\.qq\.com\/course|douyin\.com|jianli\.com|wondercv|diyifanwen|51test|zhan\.com/i;
// 营销/标题党特征（经验贴里出现即视为非真人经验）
const MARKETING_RE = /死磕|offer拿到手软|就够了|必知必会|最全|1000道|附答案|标准答案|满分|大白话|话术模板|速成|秘籍|宝典|保姆级|手把手|一文搞定|万字长文|全流程拆解|实战演练|超实用|亲测这套|揭秘|爆肝|小册|干货合集|收藏这一篇|看完这篇|建议收藏/;
// 真人经验特征
const REAL_EXP_RE = /面经|凉经|一面|二面|三面|四面|hr面|HR面|笔试|复盘|上岸|oc了|OC了|offer|秋招|春招|日常实习|暑期实习|面试经历|求职经历|个人向|记录|经历分享/;
function isAdSource(host, kind, title, snippet, content) {
  if (AD_SITE_RE.test(String(host || ''))) return true;
  const t = String(title || '');
  const text = t + ' ' + String(snippet || '') + ' ' + String(content || '').slice(0, 1000);
  if (AD_KEYWORDS.test(text)) return true;
  if (kind === '面经' || kind === '经验') {
    // 经验贴必须是真人分享：标题含真人特征且不含营销词
    if (!(REAL_EXP_RE.test(t) && !MARKETING_RE.test(t))) return true;
  } else if (MARKETING_RE.test(t) && /题|总结|合集|攻略/.test(t)) {
    // 其他类里的纯营销资料贴也排除
    return true;
  }
  return false;
}
const collectQueries = title => {
  const k = searchKeyword(title);
  return [
    { kind: 'JD', q: `${k} 招聘 任职要求`, days: 60 },
    { kind: 'JD', q: `${k} 岗位职责 技能要求`, days: 60 },
    { kind: 'JD', q: `${k} 实习生 招聘要求`, days: 60 },
    { kind: 'JD', q: `${k} 校招 岗位要求`, days: 60 },
    { kind: '面经', q: `${k} 面经 面试流程`, days: 365 },
    { kind: '面经', q: `${k} 面试题 高频`, days: 365 },
    { kind: '面经', q: `${k} 一面 二面 面经`, days: 365 },
    { kind: '面经', q: `site:nowcoder.com ${k} 面经`, days: 365 },
    { kind: '学习路线', q: `${k} 学习路线 详细`, days: 365 },
    { kind: '学习路线', q: `${k} 知识体系 技能树`, days: 365 },
    { kind: '学习路线', q: `${k} 怎么学 学习顺序`, days: 365 },
    { kind: '学习路线', q: `${k} 从零到一 自学`, days: 365 },
    { kind: '技能', q: `${k} 需要掌握 核心技能`, days: 365 },
    { kind: '技能', q: `${k} 技术栈 要求`, days: 365 },
    { kind: '项目', q: `${k} 练手项目 推荐`, days: 365 },
    { kind: '项目', q: `${k} 简历项目 项目经验`, days: 365 },
    { kind: '资源', q: `${k} 推荐书籍 教程 资源`, days: 365 },
    { kind: '经验', q: `site:zhihu.com ${k} 怎么准备`, days: 365 },
    { kind: '经验', q: `${k} 准备多久 时间规划`, days: 365 },
    { kind: '经验', q: `site:juejin.cn ${k} 学习总结`, days: 365 }
  ];
};
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  const n = Math.min(limit, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { ret[i] = await fn(items[i], i); } catch (e) { ret[i] = null; }
    }
  });
  await Promise.all(workers);
  return ret;
}
async function collectForGoal(goal, onProgress, signal) {
  return collectSources(goal, collectQueries(goal.title), onProgress, signal);
}
// 按节点主题搜集（拆分节点时使用，颗粒更聚焦）
const nodeQueries = title => {
  const k = searchKeyword(title);
  return [
    { kind: '技能', q: `${k} 具体怎么做 步骤 教程`, days: 365 },
    { kind: '学习路线', q: `${k} 学习路线 知识要点`, days: 365 },
    { kind: '项目', q: `${k} 练习案例 项目实战`, days: 365 },
    { kind: '经验', q: `${k} 经验 踩坑 注意`, days: 365 },
    { kind: '资源', q: `${k} 推荐资料 工具`, days: 365 },
    { kind: 'JD', q: `${k} 岗位要求`, days: 60 }
  ];
};
async function collectSources(goal, queries, onProgress, signal) {
  const seen = new Set();
  const all = [];
  let doneQ = 0, blocked = false;
  const checkStop = () => { if (signal && signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
  for (const item of queries) {
    checkStop();
    await new Promise(r => setTimeout(r, 1100 + Math.random() * 1200));
    checkStop();
    let rs = await baiduSearch(item.q, 30, item.days);
    if (rs === null) {
      if (!blocked) { blocked = true; onProgress({ status: '百度触发限流，切换备用搜索（必应）…' }); }
      rs = await bingSearch(item.q, 20, item.days);
    }
    for (const r of rs) {
      if (!r.url || seen.has(r.url)) continue;
      let pathname = '';
      try { pathname = new URL(r.url).pathname; } catch (e) { continue; }
      const host = siteOf(r.url);
      if (!host) continue;
      if (/(^|\.)(baidu|google|bing)\.com$/.test(host)) continue;
      seen.add(r.url);
      all.push({ ...r, host, site: siteLabel(host), kind: item.kind, days: item.days });
    }
    doneQ++;
    onProgress({ status: `搜索 ${doneQ}/${queries.length}：${item.q.slice(0, 26)}（已发现 ${all.length} 条）` });
  }
  const PRIORITY = ['nowcoder.com', 'zhipin.com', 'zhihu.com', 'juejin.cn', 'github.com', 'csdn.net', 'lagou.com', 'liepin.com', 'shixiseng.com', '51job.com'];
  const prio = h => { const i = PRIORITY.findIndex(d => h.endsWith(d)); return i < 0 ? 99 : i; };
  const KIND_QUOTA = { 'JD': 32, '面经': 26, '学习路线': 26, '技能': 16, '项目': 16, '资源': 12, '经验': 16 };
  const picked = [];
  for (const kind in KIND_QUOTA) {
    const arr = all.filter(s => s.kind === kind).sort((a, b) => prio(a.host) - prio(b.host));
    const siteCount = {};
    let taken = 0;
    for (const s of arr) {
      siteCount[s.site] = (siteCount[s.site] || 0) + 1;
      if (siteCount[s.site] > 8) continue; // 同类内单站点最多 8 条，保证多样性
      picked.push(s);
      taken++;
      if (taken >= KIND_QUOTA[kind]) break;
    }
  }
  // 累积式采集：保留已有来源，仅追加新来源（按 URL 去重），并清理超期数据
  const existingUrls = new Set(db.prepare('SELECT url FROM sources WHERE goal_id = ?').all(goal.id).map(r => r.url));
  const seenFinal = new Set();
  const now = Date.now();
  let fetched = 0, saved = 0, ads = 0, skipped = 0;
  await mapLimit(picked, 4, async s => {
    checkStop();
    fetched++;
    if (fetched % 8 === 0) onProgress({ status: `抓取正文 ${fetched}/${picked.length}（新增 ${saved} 条，排除广告 ${ads} 条，跳过已有 ${skipped} 条）` });
    if (existingUrls.has(s.url)) { skipped++; return; }
    const page = await fetchPage(s.url, 3500);
    const finalUrl = page.url || s.url;
    const host = siteOf(finalUrl) || s.host;
    if (seenFinal.has(finalUrl) || existingUrls.has(finalUrl)) { skipped++; return; }
    seenFinal.add(finalUrl);
    if (isAdSource(host, s.kind, s.title, s.snippet, page.text)) { ads++; return; }
    const pub = page.date || s.date || 0;
    const limitDays = s.kind === 'JD' ? 60 : 365;
    if (pub && now - pub > limitDays * 86400e3) return;
    db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(goal.id, String(s.title).slice(0, 200), finalUrl.slice(0, 500), siteLabel(host).slice(0, 50), s.kind,
        String(s.snippet || '').slice(0, 600), page.text.slice(0, 3500),
        pub ? new Date(pub).toISOString().slice(0, 10) : '', nowISO());
    saved++;
  });
  // 清理超期的旧来源
  let cleaned = 0;
  for (const r of db.prepare('SELECT id, kind, published_at FROM sources WHERE goal_id = ?').all(goal.id)) {
    if (!r.published_at) continue;
    const t = Date.parse(r.published_at);
    if (isNaN(t)) continue;
    const limitDays = r.kind === 'JD' ? 60 : 365;
    if (now - t > limitDays * 86400e3) { db.prepare('DELETE FROM sources WHERE id = ?').run(r.id); cleaned++; }
  }
  if (cleaned) onProgress({ status: `已清理 ${cleaned} 条超期来源` });
  backup();
  return { saved, blocked };
}
/* 客户端断开（用户点了「停止」）时，用它把上游 AI 请求也一起终止 */
function clientSignal(req) {
  const ac = new AbortController();
  try { req.on('close', () => { try { ac.abort(); } catch (e) {} }); } catch (e) {}
  return ac.signal;
}
function sourcesOf(goalId) {
  // 用户自己提供的图片资料（JD / 大纲 / 笔记…）排在最前，其次才是检索到的网络信息源
  return db.prepare("SELECT * FROM sources WHERE goal_id = ? ORDER BY CASE WHEN site = '用户提供的图片' OR kind = 'JD' THEN 0 ELSE 1 END, id").all(goalId);
}

/* ===== AI 规划 ===== */
function sourcesBlock(goal, maxItems, maxLen) {
  const all = sourcesOf(goal.id);
  if (!all.length) return '\n【注意】本次没有检索到网络信息源，请仅依据公开公认的岗位要求与学习路径规划，并在 sources 中注明依据，不确定处标注「待核实」。';
  // 用户自己提供的图片资料（JD / 大纲 / 笔记…）是最高优先级的一手信息
  const own = all.filter(s => s.site === '用户提供的图片' || s.site === '导入的资料');
  const net = all.filter(s => !(s.site === '用户提供的图片' || s.site === '导入的资料'));
  const fmt = (s, len) => {
    const body = String(s.content || s.snippet || '').replace(/\s+/g, ' ').slice(0, len);
    return `- [${s.site}｜${s.kind}] ${s.title}${body ? '：' + body : ''}`;
  };
  const lines = [''];
  if (own.length) {
    lines.push('【用户自己提供的资料（★最高优先级：用户真实场景的一手信息，必须严格依据）】');
    lines.push('要求：① 其中的硬性条件（学历 / 到岗天数 / 技能要求 / 时间节点 / 知识范围等）必须原样满足，不得忽略或改写；');
    lines.push('② 规划要与这些资料高度对齐：按真实 JD 的要求与优先级安排重点，按大纲/笔记的章节顺序组织学习路径；');
    lines.push('③ 若下面的网络信息源与用户资料冲突，一律以用户资料为准，并可在说明中指出差异；');
    lines.push('④ 在 sources 中标注这些资料时写明「用户提供的资料」。');
    for (const s of own.slice(0, maxItems)) lines.push(fmt(s, maxLen));
  }
  if (net.length) {
    lines.push('');
    lines.push(own.length
      ? '【网络检索到的信息源（参考用，优先级低于上面的用户资料）】'
      : '【已检索到的优质信息源（必须优先依据这些真实资料，并在 sources 中标注来源）】');
    for (const s of net.slice(0, Math.max(10, maxItems - own.length))) lines.push(fmt(s, maxLen));
  }
  return lines.join('\n');
}
function goalHeader(goal) {
  const lines = [];
  lines.push('【职业目标】' + goal.title);
  lines.push('【用户现状】' + (goal.profile || '（未填写）'));
  lines.push('【每周可投入】' + (goal.weekly_hours || '（未填写）') + '　【期望期限】' + (goal.deadline || '（未填写）'));
  if (goal.materials) lines.push('【用户提供的参考资料（优先采用）】' + goal.materials);
  return lines.join('\n');
}
function buildClarifyPrompt(goal) {
  const lines = [];
  lines.push('你是资深职业路径规划师。在制定规划前，你必须先做一份**完整的规划前问卷**，充分了解用户的真实情况与真实水平。');
  lines.push('问卷质量直接决定规划是否贴合用户——宁可多问，也不要凭假设规划。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(sourcesBlock(goal, 30, 180));
  lines.push('');
  lines.push('【问卷要求】生成 10-14 道题，按下面 6 个板块组织（每题带 section 字段）：');
  lines.push('  1. 现状与目标：为什么要学、期望达成的具体目标、目标岗位/方向细分、目标公司/城市倾向；');
  lines.push('  2. 真实水平（重点）：让用户用「可验证的证据」而非感觉来描述水平，例如能独立完成过什么、做过什么项目/练习、学到哪一章、上次系统学习是什么时候；');
  lines.push('  3. 水平自测（必出 2-3 题）：针对该方向的核心基础出**客观小测题**（type=quiz）——给出 4 个选项、1 个正确答案（answer 填选项的 v）与一句解析（explain）。题目要能区分「完全不会 / 一知半解 / 已掌握」，用于校准规划起点（例如看代码说输出、概念辨析、命令/语法判断）。');
  lines.push('  4. 时间与节奏：每周可投入小时数、可学习的时间段、单次可专注时长、期限是否硬性、能接受的总周期；');
  lines.push('  5. 偏好与资源：学习方式偏好（视频/文档/项目驱动）、是否接受付费课程、英语阅读能力、是否有可用的设备/环境；');
  lines.push('  6. 风险与心态：最容易放弃的环节、过往失败的学习经历、最担心的事、需要什么样的反馈与督促。');
  lines.push('  另外：必须有一题专门问「有没有必须遵守的硬性约束」（如只能周末学、预算上限、必须用某语言/工具、不能熬夜、期限不能变等），以便用户把约束写清楚。');
  lines.push('');
  lines.push('【题目类型】');
  lines.push('  - single：单选（2-5 个具体可判断的选项）');
  lines.push('  - multi：多选（列出常见选项）');
  lines.push('  - text：简答（给 placeholder 示例，用于开放信息）');
  lines.push('  - quiz：客观自测题（必须给 options 与 answer，另给 explain 一句解析）');
  lines.push('');
  lines.push('【其它要求】');
  lines.push('1. 不要问上面信息里已经明确的内容；问题要具体、好回答、直击规划关键。');
  lines.push('2. quiz 题的选项不要出现「以上都对」这类无效选项，answer 必须是某个选项的 v。');
  lines.push('3. 只输出一个 JSON 对象：');
  lines.push('{"analysis":"简短分析（120 字内，说明你最需要知道什么）","questions":[{"id":"q1","section":"现状与目标","type":"single|multi|text|quiz","title":"问题","desc":"为什么问（20字内）","options":[{"v":"a","label":"选项"}],"placeholder":"","answer":"a","explain":"解析（仅 quiz）"}]}');
  return lines.join('\n');
}
function buildDrillPrompt(goal, parentQ, answerText, allQuestions, note) {
  const lines = [];
  lines.push('你是资深职业路径规划师。用户正在填写规划问卷，并选择对下面这个问题「进一步探讨」——说明他很在意这个点，或还没被问清楚。');
  lines.push('请针对该问题生成 2-5 个更细、更具体的子问题，帮助彻底搞清用户的真实情况、真实水平与真实需求。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(constraintsBlock(goal));
  lines.push('');
  lines.push('【原问题】' + (parentQ.title || ''));
  if (parentQ.desc) lines.push('（为什么问：' + parentQ.desc + '）');
  if (parentQ.section) lines.push('【所属板块】' + parentQ.section);
  if (answerText) lines.push('【用户目前的回答】' + answerText);
  else lines.push('【用户目前的回答】（尚未回答）');
  if (note) lines.push('【用户主动补充的额外信息（重点参考，围绕它继续深挖）】' + note);
  lines.push('');
  const seen = (allQuestions || []).map(q => q.title).filter(Boolean).slice(-24);
  if (seen.length) {
    lines.push('【已经问过的问题（不要重复）】');
    seen.forEach(t => lines.push('- ' + t));
  }
  lines.push('');
  lines.push('【深挖方向（按需选用）】');
  lines.push('- 具体化：具体数字、时间、频率、范围（例如「每周几小时、哪个时段、能坚持几周」）；');
  lines.push('- 场景化：真实发生过的例子、最近一次做的具体事情、做到哪一步卡住；');
  lines.push('- 边界与例外：什么情况下做不到、哪些绝对不能接受、有没有硬性期限；');
  lines.push('- 优先级与取舍：如果时间不够先放弃什么、最看重哪个结果；');
  lines.push('- 动机与风险：为什么想做、最担心什么、以前为什么没坚持下来；');
  lines.push('- 可以用 quiz 出 1-2 道小测题验证该知识点是否真的掌握（给 answer 与 explain）。');
  lines.push('');
  lines.push('【要求】2-5 题；每题必须具体好回答；不要重复已问过的问题；不要问已有答案的内容。');
  lines.push('只输出一个 JSON 对象：');
  lines.push('{"reason":"一句话说明你还需要弄清什么","questions":[{"id":"s1","type":"single|multi|text|quiz","title":"子问题","desc":"为什么问（20字内）","options":[{"v":"a","label":"选项"}],"placeholder":"","answer":"a","explain":"解析（仅 quiz）"}]}');
  return lines.join('\n');
}
function streamDrill(req, res, goal, questionId, answers, note) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  (async () => {
    try {
      const data = safeParse(goal.clarify);
      if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('当前没有进行中的问卷');
      const parent = data.questions.find(q => String(q.id) === String(questionId));
      if (!parent) throw new Error('找不到该问题');
      const depth = Number(parent.depth || 0) + 1;
      if (depth > 3) throw new Error('这一层已经问得很细了，先把已有问题答完吧');
      const noteText = String(note || '').trim().slice(0, 1000);
      if (noteText) {
        parent.note = noteText;
        db.prepare('UPDATE goals SET clarify = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), nowISO(), goal.id);
      }
      const ans = (answers && typeof answers === 'object') ? answers : {};
      let answerText = '';
      if (ans[parent.id] != null) {
        const a = ans[parent.id];
        if (parent.type === 'quiz' && a && typeof a === 'object') {
          const opt = (parent.options || []).find(o => String(o.v) === String(a.picked));
          answerText = '选「' + (opt ? opt.label : a.picked) + '」' + (a.correct ? '（答对）' : '（答错）');
        } else answerText = Array.isArray(a) ? a.join('、') : String(a);
      }
      send({ status: 'AI 正在围绕「' + String(parent.title || '').slice(0, 18) + '」补充更细的问题…' });
      const prompt = buildDrillPrompt(goal, parent, answerText, data.questions, noteText);
      let raw1 = await aiText(prompt, model, 300000);
      let out = extractJSONRaw(raw1);
      if (!out || !Array.isArray(out.questions) || !out.questions.length) {
        console.log('[drill] 第一次解析失败（输出 ' + String(raw1 || '').length + ' 字），重试一次。原始输出前 400 字:', String(raw1 || '').slice(0, 400));
        send({ status: '正在重新整理问题…' });
        const retryPrompt = prompt + '\n\n【重要】你上一次的输出不是合法 JSON 或缺少 questions 字段。请严格只输出一个 JSON 对象：{"reason":"...","questions":[{...}]}，不要输出任何其他文字、不要用代码块包裹。';
        raw1 = await aiText(retryPrompt, model, 300000);
        out = extractJSONRaw(raw1);
        if (!out || !Array.isArray(out.questions) || !out.questions.length) {
          console.log('[drill] 重试仍失败，输出前 300 字:', String(raw1 || '').slice(0, 300));
          throw new Error('子问题生成失败，请重试');
        }
      }
      const existing = new Set(data.questions.map(q => String(q.id)));
      let n = 0;
      for (const q of out.questions.slice(0, 5)) {
        if (!q || !q.title) continue;
        n++;
        let qid = String(parent.id) + '_s' + n;
        while (existing.has(qid)) qid += '_';
        existing.add(qid);
        data.questions.push({
          id: qid, parent: parent.id, depth,
          section: parent.section || '',
          type: ['single', 'multi', 'text', 'quiz'].includes(q.type) ? q.type : 'text',
          title: String(q.title).slice(0, 300),
          desc: String(q.desc || '').slice(0, 100),
          options: Array.isArray(q.options) ? q.options.slice(0, 8) : [],
          placeholder: String(q.placeholder || '').slice(0, 120),
          answer: q.answer != null ? String(q.answer) : '',
          explain: String(q.explain || '').slice(0, 300)
        });
      }
      if (!n) throw new Error('子问题生成失败，请重试');
      db.prepare('UPDATE goals SET clarify = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), nowISO(), goal.id);
      send({ done: true, added: n, reason: out.reason || '', clarify: data, goal: getGoal(goal.id) });
    } catch (e) {
      send({ error: e.message });
    }
    res.end();
  })();
}
function qaRender(questions, answers, label) {
  const lines = [];
  let any = false;
  for (const q of (questions || [])) {
    const a = (answers || {})[q.id];
    if (a == null || (Array.isArray(a) && !a.length) || String(a).trim() === '') continue;
    any = true;
    const typeName = q.type === 'text' ? '简答' : q.type === 'multi' ? '多选' : q.type === 'quiz' ? '自测' : '单选';
    const pad = '　'.repeat(Math.min(Number(q.depth || 0), 3));
    if (q.note) lines.push(`${pad}【用户补充信息】${q.note}`);
    if (q.type === 'quiz') {
      const picked = (a && typeof a === 'object') ? a.picked : a;
      const ok = (a && typeof a === 'object') ? a.correct : null;
      const opt = (q.options || []).find(o => String(o.v) === String(picked));
      lines.push(`${pad}Q（${typeName}${q.depth ? '·追问' : ''}）：${q.title}`);
      lines.push(`${pad}A：选「${opt ? opt.label : picked}」${ok === true ? '（答对，该知识点已掌握）' : ok === false ? '（答错，规划需补齐该基础）' : ''}`);
    } else {
      const text = Array.isArray(a) ? a.join('、') : String(a);
      lines.push(`${pad}Q（${typeName}${q.depth ? '·追问' : ''}）：${q.title}`);
      lines.push(`${pad}A：${text}`);
    }
  }
  return { any, lines };
}
function constraintsOf(goal) {
  const list = safeParse((goal && goal.constraints) || '[]') || [];
  return (Array.isArray(list) ? list : []).map(c => (typeof c === 'string' ? { text: c } : c)).filter(c => c && String(c.text || '').trim());
}
function constraintsBlock(goal) {
  if (!componentOn('constraints')) return '';
  const list = constraintsOf(goal);
  if (!list.length) return '';
  const lines = ['', '【用户设置的硬性约束（最高优先级，必须严格遵守；与常规做法冲突时以约束为准）】'];
  list.forEach((c, i) => lines.push(`${i + 1}. ${String(c.text).trim()}`));
  lines.push('规划、任务拆分与建议都必须满足以上约束；若某条约束导致取舍，请在说明中写清你是如何满足它的。');
  return lines.join('\n');
}
function goalQaBlock(goal) {
  const g = db.prepare('SELECT qa, clarify, clarify_answers FROM goals WHERE id = ?').get(goal.id);
  if (!g) return '';
  const rounds = safeParse(g.qa) || [];
  const lines = ['', '【与用户的澄清问答（必须严格遵守，视为用户明确的约束与偏好）】'];
  let any = false;
  for (const r of (Array.isArray(rounds) ? rounds : [])) {
    const rl = qaRender(r.questions, r.answers, r.stage);
    if (rl.any) { any = true; lines.push(`— 第 ${(r.round != null ? r.round : 0) + 1} 轮确认 —`); lines.push(...rl.lines); }
  }
  if (!any) return '';
  lines.push('规划必须严格贴合以上回答（时间安排、基础水平、偏好与限制）；不要重复询问已确认的内容。');
  return lines.join('\n');
}
function goalPending(goalId) {
  const g = db.prepare('SELECT clarify, clarify_stage FROM goals WHERE id = ?').get(goalId);
  if (!g || !g.clarify_stage) return null;
  const data = safeParse(g.clarify);
  if (!data || !Array.isArray(data.questions) || !data.questions.length) return null;
  return { stage: g.clarify_stage, data };
}
function appendGoalQa(goalId, stage, questions, answers) {
  const g = db.prepare('SELECT qa, ask_round FROM goals WHERE id = ?').get(goalId);
  const rounds = safeParse(g.qa) || [];
  rounds.push({ stage, questions: questions || [], answers: answers || {}, round: g.ask_round || 0, at: nowISO() });
  db.prepare('UPDATE goals SET qa = ?, clarify = ?, clarify_stage = ?, ask_round = ask_round + 1, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(rounds), '', '', nowISO(), goalId);
}
function saveGoalQuestions(goalId, stage, data, extra) {
  const payload = { analysis: data.analysis || '', questions: data.questions };
  if (extra && extra.feedback) payload.feedback = extra.feedback;
  db.prepare('UPDATE goals SET clarify = ?, clarify_stage = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), stage, nowISO(), goalId);
}
function nodeQaBlock(node) {
  const rounds = safeParse(node.qa) || [];
  const lines = ['', '【关于本节点此前与用户的问答（必须遵守）】'];
  let any = false;
  for (const r of (Array.isArray(rounds) ? rounds : [])) {
    const rl = qaRender(r.questions, r.answers, 'node');
    if (rl.any) { any = true; lines.push(...rl.lines); }
  }
  if (!any) return '';
  return lines.join('\n');
}
function appendNodeQa(nodeId, questions, answers, feedback) {
  const n = db.prepare('SELECT qa, ask_round FROM nodes WHERE id = ?').get(nodeId);
  const rounds = safeParse(n.qa) || [];
  rounds.push({ questions: questions || [], answers: answers || {}, feedback: feedback || '', round: n.ask_round || 0, at: nowISO() });
  db.prepare('UPDATE nodes SET qa = ?, ask_round = ask_round + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(rounds), nowISO(), nodeId);
}
function saveNodeQuestions(nodeId, data, feedback) {
  const payload = { questions: data.questions, feedback: feedback || '' };
  db.prepare('UPDATE nodes SET qa_pending = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), nowISO(), nodeId);
}
function askBlock(round, subject) {
  const lines = ['', '【关键机制：遇到不确定信息必须先问用户确认，不要自行假设】'];
  lines.push(`输出前先自查：是否还有会实质影响${subject}的不确定信息（例如目标方向/岗位细分、现有基础与经验、可用时间、预算、地域、期限、学习偏好、已掌握技能等）。`);
  lines.push('如果有，本轮不要输出规划结果，只输出问题（最多 3 个，务必具体、好回答、直击规划关键）：');
  lines.push('{"questions":[{"id":"q1","type":"single|multi|text","title":"问题","desc":"为什么问（20字内）","options":[{"v":"a","label":"选项"}],"placeholder":""}]}');
  lines.push('如果没有不确定信息，直接输出规划结果（不要输出 questions 字段）。');
  if (round >= 2) lines.push(`注意：你已与用户确认过 ${round} 轮，本轮必须直接输出规划结果，不允许再提问。`);
  else lines.push('注意：不要重复已问过的问题；能合理推断的不要问；影响很小的问题不要问。');
  return lines.join('\n');
}
function buildSkeletonPrompt(goal) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。请为目标设计「路径骨架」：只规划 阶段 与 小目标（具体任务稍后单独细化）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(sourcesBlock(goal, 36, 170));
  lines.push(askBlock(round, '路径骨架'));
  lines.push('');
  lines.push('【要求】');
  lines.push('0. 【最重要】起点必须严格匹配问卷反映的真实水平：自测答对/自述已掌握的内容不要重复安排基础内容；自测答错或自述薄弱的环节必须补足基础。节奏要贴合用户每周可投入时间与期限。');
  lines.push('1. 阶段数量按目标规模与期限自行判断，不要凑数也不要硬挤：');
  lines.push('   · 小而聚焦的目标（单一技能、1 个月内）：3-4 个阶段；');
  lines.push('   · 中等目标（求职转型、3-6 个月）：5-6 个阶段；');
  lines.push('   · 跨度大 / 多线并行（补基础 + 做项目 + 求职 + 长期习惯）：6-8 个阶段，最多不超过 9 个；');
  lines.push('   · 从当前起点按能力/成果递进，最后一个阶段必须是「求职落地 / 投递面试 / 成果验收」这类收口阶段；');
  lines.push('   · 判断标准：每个阶段应是「一个能独立验收的能力台阶」，太大就拆、太小就合并。');
  lines.push('2. 每个阶段 3-5 个小目标（不超过 6 个）：小目标同样要「能独立验收」，能力或成果导向（如「掌握 X」「完成 Y 作品」）。');
  lines.push('3. 每个节点 detail 写 60-120 字：说明要达成什么、为什么这样安排。');
  lines.push('4. 每个节点 sources 给 1-3 条依据：name 必须写明实际来源（站点名+标题要点），note 写依据了什么要求/结论。');
  lines.push('5. 路径必须匹配用户现状（零基础从基础开始，有基础则跳过）；顺序体现「真实工作中最看重什么」。');
  lines.push('6. 只输出一个 JSON 对象（不要其他文字或代码块标记），量控制在 12000 字符内（阶段多时 detail 可适当精简到 40-80 字）：');
  lines.push('{"summary":"总体思路（120字内）","stages":[{"title":"阶段名","detail":"说明","sources":[{"name":"","note":""}],"goals":[{"title":"小目标","detail":"说明","sources":[{"name":"","note":""}]}]}]}');
  lines.push('7. 若按上面的「关键机制」需要先提问，则只输出 {"analysis":"你的分析","questions":[...]}，不要输出 stages。');
  return lines.join('\n');
}
function buildTasksPrompt(goal, stage, stageIndex) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。请为下面这个阶段细化出「具体可执行任务」。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(sourcesBlock(goal, 35, 220));
  lines.push(askBlock(round, '本阶段任务细化'));
  lines.push('');
  lines.push(`【当前阶段】第 ${stageIndex + 1} 阶段：${stage.title}`);
  lines.push('阶段说明：' + (stage.detail || ''));
  lines.push('【本阶段小目标】');
  (stage.goals || []).forEach((g, i) => lines.push(`${i}. ${g.title}${g.detail ? '（' + g.detail + '）' : ''}`));
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 为每个小目标产出 2-3 个任务，按执行顺序排列，每个任务能在一周内完成。');
  lines.push('   【硬约束】本阶段所有小目标的任务加起来不超过 10 个——任务太多会让用户压力过大、难以坚持；宁可粗一点，也要让用户觉得「做得完」。');
  lines.push('2. 每个任务必须给出：');
  lines.push('   - title：动词开头、具体可执行（如「用原生 JS 实现待办清单并部署到 GitHub Pages」）');
  lines.push('   - detail：怎么做，80-150 字，写清步骤/方法/用到的资源与练习方式');
  lines.push('   - artifact：产出物（具体的文件/仓库/笔记/作品，必须看得见摸得着）');
  lines.push('   - acceptance：验收标准（可自检，如「功能可用 + 代码已提交 + 有 README 说明」）');
  lines.push('   - hours：预计投入小时数（如「6-8h」）');
  lines.push('   - sources：1-2 条依据（name 写实际来源，note 写依据要点）');
  lines.push('3. 只输出一个 JSON 对象（不要其他文字或代码块标记）：');
  lines.push('{"goals":[{"index":0,"tasks":[{"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}]}]}');
  lines.push('4. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 goals。');
  return lines.join('\n');
}
/* ===== AI 调用（由 server/ai.js 提供，支持任意 OpenAI 兼容接口或 opencode CLI） ===== */
async function aiText(prompt, model, timeoutMs, onEvent, signal) {
  return ai.text({ prompt, model: model || currentModel(), timeoutMs, onEvent, signal });
}
async function aiTextFiles(prompt, model, files, timeoutMs, signal) {
  return ai.text({ prompt, model: model || currentVisionModel(), images: files || [], timeoutMs, signal });
}
function extractJSONObjects(text) {
  const objs = [];
  let i = 0;
  while (i < text.length) {
    const s = text.indexOf('{', i);
    if (s < 0) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = s; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    try { objs.push(JSON.parse(text.slice(s, end + 1))); } catch (e) {}
    i = end + 1;
  }
  return objs;
}
function extractJSONRaw(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const objs = extractJSONObjects(t);
  return objs.length ? objs[0] : null;
}
function extractJSON(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const objs = extractJSONObjects(t);
  if (!objs.length) return null;
  let main = null;
  for (const o of objs) if (o && Array.isArray(o.stages)) { main = o; break; }
  if (!main) return null;
  for (const o of objs) {
    if (o === main || !o) continue;
    if (o.title && Array.isArray(o.goals)) main.stages.push(o);
  }
  return main;
}
function buildExpandPrompt(goal, node, sources) {
  const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '节点';
  const lines = [];
  lines.push('你是资深职业路径规划师。请把下面这个节点拆成更细、可直接执行的任务（5-8 个，**最多 10 个**）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(nodeQaBlock(node));
  lines.push('');
  lines.push(`【当前节点（${levelName}）】${node.title}`);
  if (node.detail) lines.push('节点说明：' + node.detail);
  if (node.artifact) lines.push('节点产出物：' + node.artifact);
  lines.push(sourcesBlock(goal, 40, 220));
  lines.push(askBlock(node.ask_round || 0, '该节点的拆分'));
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 只围绕该节点主题展开，生成 5-8 个子任务（最多 10 个），颗粒度比现有任务更细（每个 2-6 小时可完成）。任务数量不要多，用户压力要小。');
  lines.push('2. 每个子任务必须给出：');
  lines.push('   - title：动词开头、具体可执行');
  lines.push('   - detail：怎么做，60-120 字，写清步骤/方法/用到的资源');
  lines.push('   - artifact：产出物（具体文件/仓库/笔记/作品）');
  lines.push('   - acceptance：验收标准（可自检）');
  lines.push('   - hours：预计投入小时数（如「3h」）');
  lines.push('   - sources：1-2 条依据（name 写实际来源（站点+标题要点），note 写依据内容）');
  lines.push('3. 优先依据上面检索到的真实资料；如果资料不足，依据公开公认做法并标注「待核实」。');
  lines.push('4. 只输出一个 JSON 对象（不要其他文字或代码块标记）：');
  lines.push('{"tasks":[{"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}]}');
  lines.push('5. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 tasks。');
  return lines.join('\n');
}
function buildTutorialPrompt(goal, node, format, note) {
  const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '任务';
  const lines = [];
  lines.push('你是耐心、严谨的技术导师。请为用户写一份「完整学习教程」，目标是让用户**真正掌握**这个任务背后的知识点与技能，而不是草草把任务做完。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push('');
  lines.push(`【教程主题（${levelName}）】${node.title}`);
  if (node.detail) lines.push('任务说明：' + node.detail);
  if (node.artifact) lines.push('应产出的成果：' + node.artifact);
  if (node.acceptance) lines.push('验收标准：' + node.acceptance);
  if (node.hours) lines.push('预计投入：' + node.hours);
  lines.push(sourcesBlock(goal, 25, 200));
  if (note) { lines.push(''); lines.push('【用户的额外要求（必须满足）】' + note); }
  lines.push('');
  lines.push('【教程必须包含的结构】');
  lines.push('1. 开头：这份教程能让你掌握什么（能力清单）、需要的前置知识（不会就先补什么）、预计学习时间分配。');
  lines.push('2. 知识点讲解：把任务涉及的核心概念/原理讲清楚——为什么需要它、它解决什么问题、关键术语解释。要有类比或例子，不能只列结论。');
  lines.push('3. 分步实践：每一步给出「做什么 → 为什么这样做 → 具体怎么做（命令/代码/操作，可复制）→ 预期结果/如何自检 → 常见错误与排查」。步骤要细到初学者能跟着做出来。');
  lines.push('4. 动手练习：2-3 个由浅入深的练习（含参考答案或思路提示），检验是否真的理解。');
  lines.push('5. 自测清单：用可勾选的问题帮用户确认「我真的掌握了」（理解层面 + 操作层面）。');
  lines.push('6. 与验收标准对应：说明做完哪些事、达到什么状态就算完成本任务。');
  lines.push('7. 延伸学习：想更深入可以看什么（写清楚看什么、关注什么点）。');
  lines.push('');
  lines.push('【写作要求】');
  lines.push('- 讲原理与思路，不要只给结论；对每个关键操作解释原因，让用户能举一反三。');
  lines.push('- 贴合用户现状与已确认的问答（基础、时间、偏好）；零基础就多解释、少跳跃。');
  lines.push('- 使用中文；专业术语首次出现时给出英文与解释。');
  lines.push('- 内容要具体、可执行：真实命令、真实代码、真实链接（不要编造不存在的网址）。');
  lines.push('- 宁可详细也不要省略关键步骤；但不要灌水。');
  lines.push('');
  if (format === 'html') {
    lines.push('【输出格式】只输出一个完整的 HTML 文档（<!DOCTYPE html> 开始，</html> 结束，UTF-8，内联 <style> 美化排版：清晰的标题层级、代码块样式、提示框、可勾选清单样式、目录导航）。不要输出 Markdown、不要用代码块包裹整篇文档、不要任何额外说明文字。不要使用外部 JS/CSS 依赖。');
  } else {
    lines.push('【输出格式】只输出 Markdown 正文（# 一级标题开始）。不要用 ``` 包裹整篇内容，不要输出任何额外说明文字。代码块、表格、清单、引用都要用标准 Markdown 语法。');
  }
  return lines.join('\n');
}
function buildRefineNodePrompt(goal, node, kids, feedback) {
  const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '节点';
  const lines = [];
  lines.push('你是资深职业路径规划师。用户对某个节点的子任务划分提出了意见，请严格按意见调整。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push('');
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(nodeQaBlock(node));
  lines.push(`【节点（${levelName}）】${node.title}`);
  if (node.detail) lines.push('节点说明：' + node.detail);
  lines.push('【现有子任务】');
  if (kids.length) kids.forEach((k, i) => lines.push(`${i + 1}. [${k.status}] ${k.title}${k.detail ? ' — ' + String(k.detail).slice(0, 60) : ''}`));
  else lines.push('（暂无子任务）');
  lines.push('');
  lines.push('【用户反馈（最高优先级，必须采纳）】' + feedback);
  lines.push(sourcesBlock(goal, 30, 180));
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 严格按用户反馈调整：该删的删、该加的加、该改顺序的改顺序、该拆细的拆细、该跳过的跳过。');
  lines.push('2. 输出调整后的完整子任务列表（最多 10 个），每个字段齐全。');
  lines.push('3. 每个子任务给出：title / detail（60-120字做法）/ artifact（产出物）/ acceptance（验收标准）/ hours（预计小时）/ sources（1-2 条依据）。');
  lines.push('4. 只输出一个 JSON 对象：{"tasks":[{"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}]}');
  lines.push('5. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 tasks。');
  return lines.join('\n');
}
/* ===== 版本快照与对比 ===== */
function beginVersion(goalId, reason) {
  if (!componentOn('versions')) return 0;
  const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
  if (!nodes.length) return 0;
  const res = db.prepare('INSERT INTO goal_versions (goal_id, reason, snapshot, summary, created_at) VALUES (?,?,?,?,?)')
    .run(goalId, reason, JSON.stringify(nodes), '', nowISO());
  return Number(res.lastInsertRowid);
}
function nodeKeyMap(nodes) {
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const memo = {};
  const build = n => {
    if (memo[n.id] != null) return memo[n.id];
    const parent = n.parent_id ? byId[n.parent_id] : null;
    const k = (parent ? build(parent) + ' / ' : '') + String(n.title || '');
    memo[n.id] = k;
    return k;
  };
  const map = {};
  for (const n of nodes) map[build(n)] = n;
  return map;
}
function diffVersions(oldNodes, newNodes) {
  const oldMap = nodeKeyMap(oldNodes);
  const newMap = nodeKeyMap(newNodes);
  const added = [], removed = [], changed = [];
  const fields = ['detail', 'artifact', 'acceptance', 'hours', 'sources', 'status'];
  for (const k in newMap) {
    if (!oldMap[k]) { added.push(newMap[k]); continue; }
    const a = oldMap[k], b = newMap[k];
    const diffFields = fields.filter(f => String(a[f] || '') !== String(b[f] || ''));
    if (diffFields.length) changed.push({ key: k, old: a, new: b, fields: diffFields });
  }
  for (const k in oldMap) if (!newMap[k]) removed.push(oldMap[k]);
  return { added, removed, changed, total: { old: Object.keys(oldMap).length, new: Object.keys(newMap).length } };
}
function templateReport(reason, diff) {
  const parts = [`本次「${reason}」`];
  if (diff.added.length) parts.push(`新增 ${diff.added.length} 项（${diff.added.slice(0, 3).map(n => n.title).join('、')}${diff.added.length > 3 ? ' 等' : ''}）`);
  if (diff.removed.length) parts.push(`移除 ${diff.removed.length} 项（${diff.removed.slice(0, 3).map(n => n.title).join('、')}${diff.removed.length > 3 ? ' 等' : ''}）`);
  if (diff.changed.length) parts.push(`调整 ${diff.changed.length} 项`);
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) parts.push('结构无变化');
  parts.push(`当前共 ${diff.total.new} 个节点`);
  return parts.join('；') + '。';
}
function buildReportPrompt(goal, reason, diff) {
  const lines = [];
  lines.push('你是职业规划助理。请用 3-5 句话简要汇报路线图的本次变更（中文，平实，不要列表，不要编造）。');
  lines.push(`【职业目标】${goal.title}`);
  lines.push(`【本次操作】${reason}`);
  lines.push(`【新增】${diff.added.slice(0, 12).map(n => n.title).join('、') || '无'}`);
  lines.push(`【移除】${diff.removed.slice(0, 12).map(n => n.title).join('、') || '无'}`);
  lines.push(`【调整】${diff.changed.slice(0, 12).map(c => c.new.title).join('、') || '无'}`);
  lines.push(`【当前规模】${diff.total.new} 个节点`);
  lines.push('要求：说明这次改了什么、为什么这么改、下一步建议；只依据上面事实，不要编造。');
  return lines.join('\n');
}
async function finishVersion(goal, vid, reason, useAI = true) {
  if (!vid || !componentOn('versions')) return '';
  const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(vid);
  if (!v) return '';
  const oldNodes = safeParse(v.snapshot) || [];
  const newNodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goal.id);
  const diff = diffVersions(Array.isArray(oldNodes) ? oldNodes : [], newNodes);
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    db.prepare('DELETE FROM goal_versions WHERE id = ?').run(vid);
    return '';
  }
  db.prepare('UPDATE goal_versions SET snapshot_after = ? WHERE id = ?').run(JSON.stringify(newNodes), vid);
  let report = templateReport(reason, diff);
  if (useAI) {
    try {
      const model = currentModel();
      const txt = await aiText(buildReportPrompt(goal, reason, diff), model, 120000);
      if (txt && txt.trim()) report = txt.trim().slice(0, 800);
    } catch (e) {}
  }
  db.prepare('UPDATE goal_versions SET summary = ? WHERE id = ?').run(report, vid);
  return report;
}


/**
 * 规范化骨架：兼容模型偶发的「标题与目标分离」结构
 * （例如 [{title:'阶段一'}, {goals:[...]}, {title:'阶段二'}, {goals:[...]}]）
 * 规则：标题无目标 → 暂存并与后续的目标合并；目标无标题 → 并入上一个阶段；
 *       丢弃空阶段；每个阶段小目标最多 4 个。
 */
function normalizeSkeleton(stages) {
  const out = [];
  let pending = null;
  for (const raw of (Array.isArray(stages) ? stages : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim();
    const goals = (Array.isArray(raw.goals) ? raw.goals : []).filter(g => g && String(g.title || '').trim());
    if (title && !goals.length) { pending = { title, detail: raw.detail || '', sources: raw.sources || [] }; continue; }
    if (!title && goals.length) {
      const last = out[out.length - 1];
      if (last && !last.goals.length) {           // 上一个阶段还空着，直接补进去
        last.goals = goals.slice(0, 4);
        if (!last.detail && raw.detail) last.detail = raw.detail;
      } else {
        const base = pending || { title: '', detail: '', sources: [] };
        out.push({ title: base.title, detail: base.detail || raw.detail || '', sources: base.sources || raw.sources || [], goals: goals.slice(0, 4) });
      }
      pending = null;
      continue;
    }
    if (title && goals.length) {
      out.push({ title, detail: raw.detail || '', sources: raw.sources || [], goals: goals.slice(0, 4) });
      pending = null;
      continue;
    }
  }
  if (pending && out.length) {   // 结尾多出来的标题：把它的说明补进上一个阶段
    const last = out[out.length - 1];
    if (!last.detail && pending.detail) last.detail = pending.detail;
  }
  return out.filter(s => s.title && s.goals.length).slice(0, 8);
}
function saveSkeleton(goalId, plan) {
  const stages = normalizeSkeleton(plan.stages);
  if (!stages.length) throw new Error('骨架结构异常（没有可用阶段），请重试');
  const old = db.prepare('SELECT id FROM nodes WHERE goal_id = ?').all(goalId).map(x => x.id);
  for (const id of old) db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  const summary = String(plan.summary || '').slice(0, 800);
  db.prepare('UPDATE goals SET summary = ?, status = ?, error = ?, updated_at = ? WHERE id = ?').run(summary, 'planning', '', nowISO(), goalId);
  const stageIds = [];
  stages.forEach((st, si) => {
    insertNode(goalId, null, 0, st.title, st.detail || '', st.sources, si);
    const stageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    stageIds.push(stageId);
    let gi = 0;
    for (const g of st.goals) {
      insertNode(goalId, stageId, 1, g.title || '小目标', g.detail || '', g.sources, gi);
      gi++;
    }
  });
  return stageIds;
}
function saveStageTasks(goalId, stageId, goalsOut) {
  const subgoals = db.prepare('SELECT id, title FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(stageId);
  let stageTotal = 0;
  const STAGE_CAP = 10;
  for (const g of (Array.isArray(goalsOut) ? goalsOut : []).slice(0, 8)) {
    if (stageTotal >= STAGE_CAP) break;
    const idx = Number(g.index);
    let sub = subgoals[idx];
    if (!sub && g.title) sub = subgoals.find(s => s.title === g.title);
    if (!sub) continue;
    let ti = 0;
    for (const t of (Array.isArray(g.tasks) ? g.tasks.slice(0, 6) : [])) {
      if (stageTotal >= STAGE_CAP) break;
      insertNode(goalId, sub.id, 2, t.title || '任务', t.detail || '', t.sources, ti, { artifact: t.artifact, acceptance: t.acceptance, hours: t.hours });
      ti++;
      stageTotal++;
    }
  }
}
function streamClarify(req, res, goal) {
  // 规划第 0 步：AI 分析用户情况，生成澄清问题（选择/判断/简答）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      send({ status: 'AI 正在分析你的情况，准备澄清问题…' });
      const txt = await aiTextProgress(buildClarifyPrompt(goal), model, 300000, send, '问题', sig);
      const data = extractJSON(txt);
      if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('澄清问题生成失败，请重试');
      db.prepare('UPDATE goals SET clarify = ?, clarify_stage = ?, status = ?, error = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), 'clarify', 'clarify', '', nowISO(), goal.id);
      backup();
      send({ done: true, clarify: data, goal: getGoal(goal.id) });
    } catch (e) {
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', e.message, nowISO(), goal.id);
      send({ error: e.message });
    }
    res.end();
  })();
}
/* ---------- 规划过程的进度反馈 ----------
   流式增量 + 定时心跳：即使模型一段时间不吐字，也每 2.5s 汇报一次；
   并从已生成的 JSON 片段里数出"已经规划了几项"（阶段/小目标/任务），让用户知道没卡住。 */
function progressTitles(text) {
  const out = [];
  const re = /"(?:title|name)"\s*:\s*"((?:[^"\\]|\\.){1,80})"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}
async function aiTextProgress(prompt, model, timeoutMs, send, label, signal) {
  const t0 = Date.now();
  let full = '', thinking = '', lastSent = 0;
  const snapshot = extra => {
    const titles = progressTitles(full);
    return Object.assign({
      elapsed: Math.round((Date.now() - t0) / 1000),
      count: titles.length,
      titles: titles.slice(-4),
      thinking: thinking ? thinking.slice(-40) : '',
      label: label || ''
    }, extra || {});
  };
  const hb = setInterval(() => { send({ progress: snapshot({ heartbeat: true }) }); }, 2500);
  try {
    return await ai.stream({
      prompt, model, timeoutMs, signal,
      onEvent: ev => {
        if (ev && ev.text) {
          full += ev.text;
          const now = Date.now();
          if (now - lastSent > 1500) { lastSent = now; send({ progress: snapshot() }); }
        } else if (ev && ev.thinking) {
          thinking = ev.thinking;
        }
      }
    });
  } finally {
    clearInterval(hb);
  }
}
function streamPlan(req, res, goal, answers) {
  // 第一步：只生成骨架（阶段 + 小目标），等待用户确认（会带上澄清问答）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      const pend = goalPending(goal.id);
      if (answers && pend) appendGoalQa(goal.id, pend.stage, pend.data.questions, answers);
      send({ status: answers ? '正在结合你的补充回答生成路径骨架…' : '正在结合你的回答生成路径骨架…' });
      const planPrompt = buildSkeletonPrompt(goal);
      let skeletonText = await aiTextProgress(planPrompt, model, 600000, send, '阶段/小目标', sig);
      let skeleton = extractJSON(skeletonText);
      if (skeleton && Array.isArray(skeleton.questions) && skeleton.questions.length) {
        saveGoalQuestions(goal.id, 'plan', skeleton);
        send({ questions: { analysis: skeleton.analysis || '', questions: skeleton.questions }, stage: 'plan', goal: getGoal(goal.id) });
        res.end();
        return;
      }
      if (!skeleton || !Array.isArray(skeleton.stages) || !skeleton.stages.length) {
        console.log('[plan] 骨架解析失败（将重试），原始输出前 400 字:', String(skeletonText || '').slice(0, 400).replace(/\n/g, ' '));
        send({ status: '正在重新整理规划结果…' });
        skeletonText = await aiTextProgress(planPrompt + '\n\n【重要】你上一次的输出不是合法 JSON（可能被截断或夹带了说明文字）。请严格只输出一个 JSON 对象，不要任何解释、不要代码块标记；阶段数量按目标规模决定（3-9 个，不要凑数）、每阶段 3-5 个小目标，detail 精简到 60 字以内。', model, 600000, send, '阶段/小目标', sig);
        skeleton = extractJSON(skeletonText);
        if (skeleton && Array.isArray(skeleton.questions) && skeleton.questions.length) {
          saveGoalQuestions(goal.id, 'plan', skeleton);
          send({ questions: { analysis: skeleton.analysis || '', questions: skeleton.questions }, stage: 'plan', goal: getGoal(goal.id) });
          res.end();
          return;
        }
        if (!skeleton || !Array.isArray(skeleton.stages) || !skeleton.stages.length) {
          console.log('[plan] 重试后仍解析失败，原始输出前 400 字:', String(skeletonText || '').slice(0, 400).replace(/\n/g, ' '));
          throw new Error('骨架生成失败（模型返回内容不完整），请重试；若反复失败可在设置里换一个模型');
        }
      }
      const vid = beginVersion(goal.id, '生成新骨架');
      saveSkeleton(goal.id, skeleton);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '生成新骨架');
      backup();
      send({ done: true, stages: skeleton.stages.length, goal: getGoal(goal.id), report, versionId: vid });
    } catch (e) {
      if (e && e.cancelled) {
        // 用户点了「停止」：不算失败，回到可继续的状态
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(goal.id).c;
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'review' : 'todo', '', nowISO(), goal.id);
        send({ cancelled: true, status: '已停止（可随时继续）', goal: getGoal(goal.id) });
      } else {
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', e.message, nowISO(), goal.id);
        send({ error: e.message });
      }
    }
    res.end();
  })();
}
function currentSkeleton(goalId) {
  const stages = db.prepare('SELECT id, title, detail, sources FROM nodes WHERE goal_id = ? AND level = 0 ORDER BY sort_order, id').all(goalId);
  return stages.map(st => ({
    title: st.title, detail: st.detail, sources: safeParse(st.sources) || [],
    goals: db.prepare('SELECT title, detail, sources FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(st.id)
      .map(s => ({ title: s.title, detail: s.detail, sources: safeParse(s.sources) || [] }))
  }));
}
function streamPlanTasks(req, res, goal, answers) {
  // 第二步：逐阶段细化任务（支持中断后继续，已有任务的阶段自动跳过）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      const pend = goalPending(goal.id);
      if (answers && pend) appendGoalQa(goal.id, pend.stage, pend.data.questions, answers);
      const skeleton = currentSkeleton(goal.id);
      if (!skeleton.length) throw new Error('还没有骨架，请先生成骨架');
      const vid = beginVersion(goal.id, '细化任务');
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('planning', '', nowISO(), goal.id);
      const stageNodes = db.prepare('SELECT id, title FROM nodes WHERE goal_id = ? AND level = 0 ORDER BY sort_order, id').all(goal.id);
      for (let i = 0; i < skeleton.length; i++) {
        const st = skeleton[i];
        const stageNode = stageNodes[i];
        if (!stageNode) continue;
        const hasTasks = db.prepare('SELECT COUNT(*) AS n FROM nodes t JOIN nodes g ON t.parent_id = g.id WHERE g.parent_id = ?').get(stageNode.id).n;
        if (hasTasks) { send({ status: `第 ${i + 1}/${skeleton.length} 阶段已有任务，跳过` }); continue; }
        send({ status: `生成第 ${i + 1}/${skeleton.length} 阶段的任务：${String(st.title || '').slice(0, 22)}…` });
        try {
          const txt = await aiTextProgress(buildTasksPrompt(goal, st, i), model, 300000, send, '任务', sig);
          const data = extractJSON(txt);
          if (data && Array.isArray(data.questions) && data.questions.length) {
            saveGoalQuestions(goal.id, 'tasks', data);
            db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
            send({ questions: { analysis: data.analysis || '', questions: data.questions }, stage: 'tasks', stageTitle: st.title, goal: getGoal(goal.id) });
            res.end();
            return;
          }
          if (data && Array.isArray(data.goals)) {
            saveStageTasks(goal.id, stageNode.id, data.goals);
            db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
            send({ goal: getGoal(goal.id) });
          } else {
            console.log('[tasks] 解析失败，原始输出前 400 字:', String(txt || '').slice(0, 400).replace(/\n/g, ' '));
            send({ status: `第 ${i + 1} 阶段任务解析失败（可稍后继续）` });
          }
        } catch (e) {
          send({ status: `第 ${i + 1} 阶段任务生成失败：${e.message}` });
        }
      }
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('planned', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '细化任务');
      backup();
      const updated = getGoal(goal.id);
      send({ done: true, goal: updated, report, versionId: vid });
    } catch (e) {
      if (e && e.cancelled) {
        // 用户点了「停止」：不算失败，回到可继续的状态
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(goal.id).c;
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'review' : 'todo', '', nowISO(), goal.id);
        send({ cancelled: true, status: '已停止（可随时继续）', goal: getGoal(goal.id) });
      } else {
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', e.message, nowISO(), goal.id);
        send({ error: e.message });
      }
    }
    res.end();
  })();
}
function buildRefineSkeletonPrompt(goal, current, feedback) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。用户对现有路径骨架提出了意见，请按意见调整。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(sourcesBlock(goal, 40, 200));
  lines.push(askBlock(round, '骨架调整'));
  lines.push('');
  lines.push('【现有骨架】');
  lines.push(JSON.stringify(current));
  lines.push('');
  lines.push('【用户反馈（必须采纳）】' + feedback);
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 只调整用户指出的问题，其余尽量保持原样（**除非用户明确要求增加 / 删除 / 合并阶段，否则阶段数量、顺序、命名保持稳定**）。用户说"阶段太少/太多/想加一个 XX 阶段"时，就按要求调整数量。');
  lines.push('2. 输出完整的调整后骨架，格式与输入一致。');
  lines.push('3. 只输出一个 JSON 对象：{"summary":"总体思路","stages":[{"title":"","detail":"","sources":[{"name":"","note":""}],"goals":[{"title":"","detail":"","sources":[{"name":"","note":""}]}]}]}');
  lines.push('4. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 stages。');
  return lines.join('\n');
}
function streamPlanRefine(req, res, goal, feedback, answers) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      const pend = goalPending(goal.id);
      if (!feedback && pend && pend.data && pend.data.feedback) feedback = pend.data.feedback;
      if (answers && pend) appendGoalQa(goal.id, pend.stage, pend.data.questions, answers);
      const current = currentSkeleton(goal.id);
      if (!current.length) throw new Error('还没有骨架可调整');
      send({ status: '正在根据你的意见调整骨架…' });
      const refinePrompt = buildRefineSkeletonPrompt(goal, current, feedback);
      let txt = await aiTextProgress(refinePrompt, model, 480000, send, '阶段/小目标', sig);
      let plan = extractJSON(txt);
      if (!plan || !Array.isArray(plan.stages) || !plan.stages.length) {
        console.log('[refine] 解析失败（将重试），原始输出前 300 字:', String(txt || '').slice(0, 300).replace(/\n/g, ' '));
        send({ status: '正在重新整理调整结果…' });
        txt = await aiTextProgress(refinePrompt + '\n\n【重要】请严格只输出一个 JSON 对象（不要解释、不要代码块），格式：{"summary":"...","stages":[{"title":"","detail":"","sources":[],"goals":[{"title":"","detail":"","sources":[]}]}]}', model, 480000, send, '阶段/小目标', sig);
        plan = extractJSON(txt);
      }
      if (plan && Array.isArray(plan.questions) && plan.questions.length) {
        saveGoalQuestions(goal.id, 'refine', plan, { feedback });
        send({ questions: { analysis: plan.analysis || '', questions: plan.questions }, stage: 'refine', feedback, goal: getGoal(goal.id) });
        res.end();
        return;
      }
      if (!plan || !Array.isArray(plan.stages) || !plan.stages.length) throw new Error('调整结果解析失败，请重试');
      const vid = beginVersion(goal.id, '按意见调整骨架');
      saveSkeleton(goal.id, plan);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '按意见调整骨架');
      backup();
      send({ done: true, goal: getGoal(goal.id), report, versionId: vid });
    } catch (e) {
      if (e && e.cancelled) {
        // 用户点了「停止」：不算失败，回到可继续的状态
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(goal.id).c;
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'review' : 'todo', '', nowISO(), goal.id);
        send({ cancelled: true, status: '已停止（可随时继续）', goal: getGoal(goal.id) });
      } else {
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', e.message, nowISO(), goal.id);
        send({ error: e.message });
      }
    }
    res.end();
  })();
}

/* ===== 对话式改规划 ===== */
function roadmapOutline(goalId) {
  const nodes = db.prepare('SELECT id, parent_id, level, title, detail, hours, status FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
  const byParent = {};
  for (const n of nodes) { const k = n.parent_id || 0; (byParent[k] = byParent[k] || []).push(n); }
  const lines = [];
  const walk = (pid, depth) => {
    if (lines.length > 600) return;
    for (const n of (byParent[pid] || [])) {
      const st = n.status === 'done' ? ' ✓已完成' : n.status === 'doing' ? ' ▶进行中' : '';
      const det = n.level >= 2 && n.detail ? '　' + String(n.detail).replace(/\s+/g, ' ').slice(0, 70) : '';
      lines.push('  '.repeat(depth) + `[${n.id}] ${n.title}${n.hours ? '（' + n.hours + '）' : ''}${st}${det}`);
      walk(n.id, depth + 1);
    }
  };
  walk(0, 0);
  if (lines.length > 600) lines.push('…（节点过多，仅显示前 600 个）');
  return lines.join('\n');
}
function buildChatPrompt(goal, message, sessionId) {
  const lines = [];
  lines.push('你是用户的职业规划助理。用户可以随时和你讨论并修改路线图，你要准确理解意图并执行。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  const chats = sessionId
    ? db.prepare('SELECT role, content FROM chats WHERE session_id = ? ORDER BY id DESC LIMIT 12').all(sessionId).reverse()
    : db.prepare('SELECT role, content FROM chats WHERE goal_id = ? ORDER BY id DESC LIMIT 12').all(goal.id).reverse();
  if (chats.length) {
    lines.push('');
    lines.push('【最近的对话】');
    for (const c of chats) lines.push((c.role === 'user' ? '用户：' : '你：') + String(c.content).replace(/\s+/g, ' ').slice(0, 1500));
  }
  lines.push('');
  lines.push('【当前路线图（方括号内是节点 id，修改时只能引用这些 id）】');
  lines.push(roadmapOutline(goal.id) || '（暂无节点）');
  lines.push('');
  lines.push('【用户的新消息】' + message);
  lines.push('');
  lines.push('【你的任务】');
  lines.push('0. 不要使用任何工具（不要读取文件、不要执行命令、不要联网）；规划的全部信息都在本提示里，直接基于它作答。');
  lines.push('1. 判断用户意图：只是咨询/提问 → 直接回答，不要修改；要求修改路线图 → 执行修改。');
  lines.push('2. 输出格式（必须严格遵守，便于界面实时渲染）：');
  lines.push('   先用 Markdown 写回复正文（可以分点、用列表、粗体、代码块，讲清你做了什么、为什么，以及建议；默认控制在 400 字以内，除非用户要求详细说明）；');
  lines.push('   然后在正文最后附一个 ops 代码块（JSON 数组，即你要执行的修改操作）：');
  lines.push('   ```ops');
  lines.push('   [{"op":"add","parent_id":123,"title":"..."}]');
  lines.push('   ```');
  lines.push('   - 如果不需要修改路线图，ops 代码块里写 [] 即可。');
  lines.push('   - 不要输出除正文和 ops 代码块以外的内容（不要输出 JSON 信封）。');
  lines.push('3. 支持的操作：');
  lines.push('   - {"op":"add","parent_id":<父节点id>,"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}（任一节点的直接子任务不要超过 10 个）');
  lines.push('   - {"op":"update","id":<id>,"title":"","detail":"","artifact":"","acceptance":"","hours":""}（只填要改的字段）');
  lines.push('   - {"op":"delete","id":<id>}');
  lines.push('   - {"op":"move","id":<id>,"parent_id":<新父节点id>}');
  lines.push('   - {"op":"status","id":<id>,"status":"todo|doing|done"}');
  lines.push('   - {"op":"constraint","text":"约束内容"}（用户提出长期性要求时使用，如「以后不要安排付费资源」「我只有周末能学」；这类要求应记为约束而不是改节点）');
  lines.push('4. 修改要精准：用户说改哪个就改哪个，不要顺手大改；单次最多 20 个操作。');
  lines.push('5. 删除要谨慎：只有用户明确要求才删除；阶段（最外层节点）不要删除，除非用户明确要求。');
  lines.push('6. 新增任务必须带 detail（怎么做，60-120 字）与 hours；依据已确认的问答与用户现状。');
  lines.push('7. 不要编造 id；只输出 JSON，不要输出其他内容。');
  return lines.join('\n');
}
function applyChatOps(goalId, ops) {
  const applied = [], errors = [];
  const nodeOf = id => db.prepare('SELECT * FROM nodes WHERE id = ? AND goal_id = ?').get(Number(id), goalId);
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, 25)) {
    try {
      const kind = String(op.op || op.type || '').toLowerCase();
      if (kind === 'add') {
        const parent = op.parent_id ? nodeOf(op.parent_id) : null;
        if (op.parent_id && !parent) { errors.push('父节点不存在：' + op.parent_id); continue; }
        const level = parent ? Math.min(parent.level + 1, 5) : 0;
        const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)').get(goalId, parent ? parent.id : null).n;
        insertNode(goalId, parent ? parent.id : null, level, op.title || '新任务', op.detail || '', op.sources || [], order, { artifact: op.artifact, acceptance: op.acceptance, hours: op.hours });
        const nid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        applied.push({ op: 'add', id: nid, title: String(op.title || '新任务').slice(0, 60), parent_id: parent ? parent.id : 0 });
      } else if (kind === 'update') {
        const n = nodeOf(op.id);
        if (!n) { errors.push('节点不存在：' + op.id); continue; }
        const pick = (f, max) => op[f] != null ? String(op[f]).trim().slice(0, max) : n[f];
        const title = pick('title', 200) || n.title;
        db.prepare('UPDATE nodes SET title=?, detail=?, artifact=?, acceptance=?, hours=?, updated_at=? WHERE id=?')
          .run(title, pick('detail', 2000), pick('artifact', 500), pick('acceptance', 500), pick('hours', 50), nowISO(), n.id);
        applied.push({ op: 'update', id: n.id, title: title.slice(0, 60) });
      } else if (kind === 'delete') {
        const n = nodeOf(op.id);
        if (!n) { errors.push('节点不存在：' + op.id); continue; }
        deleteNodeTree(n.id);
        applied.push({ op: 'delete', id: n.id, title: String(n.title).slice(0, 60) });
      } else if (kind === 'move') {
        const n = nodeOf(op.id);
        if (!n) { errors.push('节点不存在：' + op.id); continue; }
        const parent = op.parent_id ? nodeOf(op.parent_id) : null;
        if (op.parent_id && !parent) { errors.push('目标父节点不存在：' + op.parent_id); continue; }
        const newParentId = parent ? parent.id : null;
        if (newParentId === n.id) { errors.push('不能移动到自身'); continue; }
        const level = parent ? Math.min(parent.level + 1, 5) : 0;
        const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)').get(goalId, newParentId).n;
        db.prepare('UPDATE nodes SET parent_id = ?, level = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(newParentId, level, order, nowISO(), n.id);
        const fix = (id, lv) => {
          for (const c of db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(id)) {
            const cl = Math.min(lv + 1, 5);
            db.prepare('UPDATE nodes SET level = ? WHERE id = ?').run(cl, c.id);
            fix(c.id, cl);
          }
        };
        fix(n.id, level);
        applied.push({ op: 'move', id: n.id, title: String(n.title).slice(0, 60), parent_id: newParentId || 0 });
      } else if (kind === 'constraint') {
        const text = String(op.text || op.title || '').trim().slice(0, 300);
        if (!text) { errors.push('约束内容为空'); continue; }
        const g2 = db.prepare('SELECT constraints FROM goals WHERE id = ?').get(goalId);
        const list = safeParse(g2.constraints) || [];
        list.push({ text, created_at: nowISO(), source: 'chat' });
        db.prepare('UPDATE goals SET constraints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), nowISO(), goalId);
        applied.push({ op: 'constraint', title: text.slice(0, 60) });
      } else if (kind === 'status') {
        const n = nodeOf(op.id);
        if (!n) { errors.push('节点不存在：' + op.id); continue; }
        const st = ['todo', 'doing', 'done'].includes(op.status) ? op.status : n.status;
        db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(st, nowISO(), n.id);
        applied.push({ op: 'status', id: n.id, title: String(n.title).slice(0, 60), status: st });
      }
    } catch (e) { errors.push(e.message); }
  }
  return { applied, errors };
}
const TOOL_LABEL = { read: '读取文件', write: '写入文件', edit: '修改文件', bash: '执行命令', grep: '搜索代码', glob: '查找文件', list: '列目录', webfetch: '抓取网页', websearch: '搜索网络', task: '调度子任务', todowrite: '更新计划' };
function toolActivity(part) {
  const tool = (part && part.tool) || '';
  const input = (part && part.state && part.state.input) || {};
  const label = TOOL_LABEL[tool] || '执行操作';
  let detail = '';
  if (input.filePath) detail = String(input.filePath);
  else if (input.path) detail = String(input.path);
  else if (input.command) detail = String(input.command).replace(/\s+/g, ' ').slice(0, 40);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query) detail = String(input.query).slice(0, 40);
  else if (part && part.state && part.state.title) detail = String(part.state.title).replace(/\s+/g, ' ').slice(0, 40);
  return '正在' + label + (detail ? '：' + detail : '');
}
function summarizeThinking(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '正在思考…';
  const sentences = s.split(/[。！？!?；;]/).map(x => x.trim()).filter(x => x.length >= 3);
  const last = sentences.length ? sentences[sentences.length - 1] : s.slice(-40);
  return last.slice(0, 44);
}
function repairOpsArray(text) {
  const s = String(text || '');
  let arrStart = -1;
  const m1 = s.match(/"?ops"?\s*:\s*\[/);
  if (m1) arrStart = s.indexOf('[', m1.index);
  else { const m2 = s.search(/```ops/); if (m2 >= 0) arrStart = s.indexOf('[', m2); }
  if (arrStart < 0) return null;
  const ops = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let k = arrStart; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = k; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && objStart >= 0) { try { ops.push(JSON.parse(s.slice(objStart, k + 1))); } catch (e) {} objStart = -1; } }
    else if (c === ']' && depth === 0) break;
  }
  return ops.length ? ops : null;
}
function extractReplyField(s) {
  const m = String(s).match(/"reply"\s*:\s*"/);
  if (!m) return '';
  let i = m.index + m[0].length, out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === 'u') {
        const code = parseInt(s.slice(i + 2, i + 6), 16);
        if (!isNaN(code)) { out += String.fromCharCode(code); i += 4; }
      } else out += n;
      i += 2;
      continue;
    }
    if (c === '"') break;
    out += c;
    i++;
  }
  return out.trim();
}
function parseChatOutput(text) {
  let s = String(text || '').trim();
  let ops = [];
  const valid = o => o && typeof o === 'object' && ['add', 'update', 'delete', 'move', 'status', 'constraint'].includes(String(o.op || o.type || '').toLowerCase());
  const takeOps = arr => (Array.isArray(arr) ? arr.filter(valid).slice(0, 25) : []);
  // 1) ```ops 代码块（推荐格式）
  const m = s.match(/```ops[ \t]*\r?\n?([\s\S]*?)```/i);
  if (m) {
    const body = m[1].trim();
    try { const d = JSON.parse(body); ops = takeOps(Array.isArray(d) ? d : d.ops); } catch (e) { ops = takeOps(repairOpsArray(body)); }
    s = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  }
  // 2) 兼容旧的 JSON 信封（可能混有前后说明文字）
  if (!ops.length) {
    for (const o of extractJSONObjects(s)) {
      if (!o || typeof o !== 'object') continue;
      if (typeof o.reply === 'string' && o.reply.trim()) s = o.reply.trim();
      if (Array.isArray(o.ops)) ops = takeOps(o.ops);
      break;
    }
  }
  // 3) JSON 被截断时抢救操作列表
  if (!ops.length) {
    const r = repairOpsArray(s);
    if (r) ops = takeOps(r);
  }
  // 4) 清理正文里残留的内部指令片段
  s = s.replace(/```ops[\s\S]*$/i, '').trim();
  const envIdx = s.search(/\{\s*"reply"\s*:|"\s*ops\s*"\s*:\s*\[/);
  if (envIdx >= 0) {
    const rep = extractReplyField(s);
    if (rep) s = rep;
    else if (envIdx > 0) s = s.slice(0, envIdx).trim();
  }
  if (!s) s = ops.length ? '已按你的要求更新路线图。' : '（AI 没有输出内容，请重试）';
  return { reply: s, ops };
}
function streamChat(req, res, goal, message, session) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = (session && session.model) ? session.model : currentModel();
  const sessionId = session ? session.id : 0;
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  (async () => {
    let fullText = '';
    try {
      db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)').run(goal.id, sessionId, 'user', String(message).slice(0, 30000), nowISO());
      if (session && (!session.title || session.title === '新对话')) {
        const autoTitle = String(message).replace(/\s+/g, ' ').trim().slice(0, 24);
        if (autoTitle) {
          db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(autoTitle, nowISO(), sessionId);
          send({ sessionTitle: autoTitle });
        }
      }
      send({ status: '正在理解你的要求…' });
      fullText = await ai.text({
        prompt: buildChatPrompt(goal, message, sessionId),
        model: model || currentModel(),
        timeoutMs: 420000,
        onEvent: ev => {
          if (ev.text) send({ text: ev.text });
          else if (ev.thinking) send({ thinking: summarizeThinking(ev.thinking) });
        }
      });
      const parsed = parseChatOutput(fullText);
      const reply = parsed.reply.slice(0, 20000);
      if (!reply) throw new Error('AI 回复为空，请重试');
      const ops = parsed.ops;
      send({ reply });
      let applied = [], errors = [], vid = 0;
      if (ops.length) {
        send({ status: `正在应用 ${ops.length} 处修改…` });
        vid = beginVersion(goal.id, '对话修改');
        const r = applyChatOps(goal.id, ops);
        applied = r.applied; errors = r.errors;
        db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
        const report = await finishVersion(goal, vid, '对话修改', false);
        if (vid && !report) vid = 0;
        else if (vid) db.prepare('UPDATE goal_versions SET summary = ? WHERE id = ?').run(reply.slice(0, 800), vid);
      }
      const t = nowISO();
      const ins = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(goal.id, sessionId, 'assistant', reply, JSON.stringify(applied), vid, t);
      if (sessionId) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(t, sessionId);
      backup();
      send({ done: true, id: Number(ins.lastInsertRowid), reply, applied, errors, versionId: vid, goal: getGoal(goal.id) });
    } catch (e) {
      send({ error: e.message });
    }
    res.end();
  })();
}


function cleanTutorialText(txt, format) {
  let s = String(txt || '').trim();
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (m) s = m[1].trim();
  if (format === 'html') {
    const low = s.toLowerCase();
    const i = low.indexOf('<!doctype');
    const j = low.lastIndexOf('</html>');
    if (i >= 0 && j > i) s = s.slice(i, j + 7);
    else {
      const i2 = low.indexOf('<html');
      const j2 = low.lastIndexOf('</html>');
      if (i2 >= 0 && j2 > i2) s = '<!DOCTYPE html>\n' + s.slice(i2, j2 + 7);
    }
  }
  return s.trim();
}
function streamTutorial(req, res, node, format, note) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  (async () => {
    try {
      const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(node.goal_id);
      if (!goal) throw new Error('目标不存在');
      send({ status: `正在撰写「${String(node.title).slice(0, 18)}」的${format === 'html' ? ' HTML ' : ' Markdown '}教程（讲原理、分步实践、练习与自测，约需 1-3 分钟）…` });
      let txt = await aiText(buildTutorialPrompt(goal, node, format, note), model, 600000);
      txt = cleanTutorialText(txt, format);
      if (!txt || txt.length < 200) throw new Error('教程生成失败（内容过短），请重试');
      const t = nowISO();
      const title = String(node.title).trim().slice(0, 120);
      const r = db.prepare('INSERT INTO tutorials (goal_id, node_id, title, format, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(goal.id, node.id, title, format, txt, t, t);
      const tid = Number(r.lastInsertRowid);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
      backup();
      send({ done: true, tutorial: { id: tid, node_id: node.id, title, format, created_at: t, chars: txt.length }, goal: getGoal(goal.id) });
    } catch (e) {
      send({ error: e.message });
    }
    res.end();
  })();
}

/* ===== HTTP ===== */
async function handleAPI(req, res, u) {
  const p = u.pathname, method = req.method;

  if (p === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true, app: APP_NAME });

  /* ===== 组件能力开关：关闭的组件，其接口一律拒绝 =====
     注意：/api/components/*（组件管理接口）永远放行，否则会把自己锁死。 */
  if (!p.startsWith('/api/components')) {
    const HINT = '（左侧栏 → 🧩 组件 里可开启）';
    if ((p.startsWith('/api/goals/') && p.endsWith('/versions')) || p.startsWith('/api/versions/')) {
      if (!componentOn('versions')) return sendJSON(res, 403, { error: '「版本对比与汇报」组件已关闭' + HINT });
    }
    if (p.startsWith('/api/chat-sessions') || p.endsWith('/chat-sessions') || p.endsWith('/chats') || (p.startsWith('/api/goals/') && p.endsWith('/chat'))) {
      if (!componentOn('chat')) return sendJSON(res, 403, { error: '「对话改规划」组件已关闭' + HINT });
    }
    if (/^\/api\/nodes\/\d+\/tutorial$/.test(p) || p.startsWith('/api/tutorials/')) {
      if (!componentOn('tutorial')) return sendJSON(res, 403, { error: '「学习教程」组件已关闭' + HINT });
    }
    if (/^\/api\/goals\/\d+\/plan\/clarify$/.test(p) || p.startsWith('/api/goals/') && p.endsWith('/clarify/drill') || p.startsWith('/api/goals/') && p.endsWith('/clarify/note')) {
      if (!componentOn('clarify')) return sendJSON(res, 403, { error: '「规划前问卷」组件已关闭' + HINT });
    }
    if (p.endsWith('/constraints') || /\/constraints\/\d+$/.test(p)) {
      if (!componentOn('constraints')) return sendJSON(res, 403, { error: '「规划约束」组件已关闭' + HINT });
    }
    if (p.endsWith('/collect')) {
      if (!componentOn('sources')) return sendJSON(res, 403, { error: '「信息源检索」组件已关闭' + HINT });
    }
  }


  if (p === '/api/goals' && method === 'GET') {
    const goals = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC').all().map(goalWithStats);
    return sendJSON(res, 200, { goals });
  }
  if (p === '/api/goals' && method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    if (!title) return sendJSON(res, 400, { error: '目标不能为空' });
    const t = nowISO();
    let pluginSel = '{}';
    try {
      const sel = {};
      for (const pl of PLUGINS) sel[pl.id] = body.plugins && body.plugins[pl.id] != null ? !!body.plugins[pl.id] : !!pl.defaultEnabled;
      pluginSel = JSON.stringify(sel);
    } catch (e) {}
    db.prepare('INSERT INTO goals (title, profile, materials, weekly_hours, deadline, status, plugins, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(title.slice(0, 120), String(body.profile || '').trim().slice(0, 3000), String(body.materials || '').trim().slice(0, 5000),
        String(body.weekly_hours || '').trim().slice(0, 50), String(body.deadline || '').trim().slice(0, 50), 'draft', pluginSel, t, t);
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    backup();
    return sendJSON(res, 201, { goal: getGoal(id) });
  }

  const goalMatch = p.match(/^\/api\/goals\/(\d+)$/);
  if (goalMatch) {
    const id = Number(goalMatch[1]);
    if (method === 'GET') {
      const g = getGoal(id);
      return g ? sendJSON(res, 200, { goal: g }) : sendJSON(res, 404, { error: '目标不存在' });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      const title = body.title != null ? String(body.title).trim().slice(0, 120) : g.title;
      const profile = body.profile != null ? String(body.profile).trim().slice(0, 3000) : g.profile;
      const materials = body.materials != null ? String(body.materials).trim().slice(0, 5000) : g.materials;
      const weekly = body.weekly_hours != null ? String(body.weekly_hours).trim().slice(0, 50) : g.weekly_hours;
      const deadline = body.deadline != null ? String(body.deadline).trim().slice(0, 50) : g.deadline;
      db.prepare('UPDATE goals SET title=?, profile=?, materials=?, weekly_hours=?, deadline=?, updated_at=? WHERE id=?')
        .run(title, profile, materials, weekly, deadline, nowISO(), id);
      backup();
      return sendJSON(res, 200, { goal: getGoal(id) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM nodes WHERE goal_id = ?').run(id);
      db.prepare('DELETE FROM sources WHERE goal_id = ?').run(id);
      db.prepare('DELETE FROM goals WHERE id = ?').run(id);
      db.prepare('DELETE FROM goal_versions WHERE goal_id = ?').run(id);
      db.prepare('DELETE FROM tutorials WHERE goal_id = ?').run(id);
      db.prepare('DELETE FROM chats WHERE goal_id = ?').run(id);
      db.prepare('DELETE FROM chat_sessions WHERE goal_id = ?').run(id);
      for (const pl of PLUGINS) { try { if (typeof pl.onGoalDelete === 'function') pl.onGoalDelete(id, pluginCtx()); } catch (e) { console.error('[plugin]', pl.id, '清理失败:', e.message); } }
      backup();
      return sendJSON(res, 200, { ok: true });
    }
  }

  const collectMatch = p.match(/^\/api\/goals\/(\d+)\/collect$/);
  if (collectMatch && method === 'POST') {
    const id = Number(collectMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const sig = clientSignal(req);
    (async () => {
      try {
        const r = await collectForGoal(g, s => { try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch (e) {} }, sig);
        const list = sourcesOf(id);
        try { res.write(`data: ${JSON.stringify({ done: true, count: r.saved, blocked: r.blocked, sources: list })}\n\n`); } catch (e) {}
      } catch (e) {
        if (e && e.cancelled) {
          try { res.write(`data: ${JSON.stringify({ cancelled: true, status: '已停止收集', sources: sourcesOf(id) })}\n\n`); } catch (e2) {}
        } else {
          try { res.write(`data: ${JSON.stringify({ error: '信息源获取失败：' + e.message })}\n\n`); } catch (e2) {}
        }
      }
      res.end();
    })();
    return;
  }

  const sourcesMatch = p.match(/^\/api\/goals\/(\d+)\/sources$/);
  if (sourcesMatch && method === 'GET') {
    return sendJSON(res, 200, { sources: sourcesOf(Number(sourcesMatch[1])) });
  }
  const sourceDelMatch = p.match(/^\/api\/sources\/(\d+)$/);
  if (sourceDelMatch && method === 'DELETE') {
    db.prepare('DELETE FROM sources WHERE id = ?').run(Number(sourceDelMatch[1]));
    return sendJSON(res, 200, { ok: true });
  }

  const expandMatch = p.match(/^\/api\/nodes\/(\d+)\/expand$/);
  if (expandMatch && method === 'POST') {
    const id = Number(expandMatch[1]);
    let n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!n) return sendJSON(res, 404, { error: '节点不存在' });
    let feedback = '', answers = null;
    try { const b = await readBody(req); feedback = String(b.feedback || '').trim(); if (b && typeof b.answers === 'object') answers = b.answers; } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    (async () => {
      try {
        const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(n.goal_id);
        if (!goal) throw new Error('目标不存在');
        const model = currentModel();
        const pendNode = safeParse(n.qa_pending);
        if (!feedback && pendNode && pendNode.feedback) feedback = pendNode.feedback;
        if (answers && pendNode) {
          appendNodeQa(n.id, pendNode.questions, answers, feedback);
          n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
        }
        const reason = feedback ? ('按意见调整：' + n.title) : ('节点拆分：' + n.title);
        if (feedback) {
          // 带用户意见调整现有子任务
          send({ status: '正在根据你的意见调整划分…' });
          const kids = db.prepare('SELECT title, detail, status FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(n.id);
          const txt = await aiText(buildRefineNodePrompt(goal, n, kids, feedback), model, 300000);
          const data = extractJSON(txt);
          if (data && Array.isArray(data.questions) && data.questions.length) {
            saveNodeQuestions(n.id, data, feedback);
            send({ questions: { questions: data.questions }, stage: 'expand', nodeId: n.id, nodeTitle: n.title, feedback, goal: getGoal(goal.id) });
            res.end();
            return;
          }
          if (!data || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('调整结果解析失败，请重试');
          const vid = beginVersion(goal.id, reason);
          const statusByTitle = {};
          for (const k of kids) statusByTitle[k.title] = k.status;
          for (const oid of db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(n.id).map(x => x.id)) deleteNodeTree(oid);
          let order = 0, added = 0;
          for (const t of data.tasks.slice(0, 10)) {
            insertNode(goal.id, n.id, Math.min(n.level + 1, 5), t.title || '子任务', t.detail || '', t.sources, order++, { artifact: t.artifact, acceptance: t.acceptance, hours: t.hours });
            const newId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
            const st = statusByTitle[t.title];
            if (st && st !== 'todo') db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(st, newId);
            added++;
          }
          db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
          const report = await finishVersion(goal, vid, reason);
          backup();
          send({ done: true, added, refined: true, goal: getGoal(goal.id), report, versionId: vid });
        } else {
          // 无意见：先搜集资料，再生成细分（回答追问后的续跑不再重复搜集）
          if (!answers && componentOn('sources')) {
            const before = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            await collectSources(goal, nodeQueries(n.title), s => send(s));
            const after = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            send({ status: `信息源新增 ${after - before} 条（共 ${after} 条），开始制定拆分计划…`, sources: sourcesOf(goal.id) });
          }
          send({ status: '开始制定拆分计划…' });
          var vid = beginVersion(goal.id, reason);
          const txt = await aiText(buildExpandPrompt(goal, n, sourcesOf(goal.id)), model, 300000);
          const data = extractJSON(txt);
          if (data && Array.isArray(data.questions) && data.questions.length) {
            saveNodeQuestions(n.id, data, feedback);
            send({ questions: { questions: data.questions }, stage: 'expand', nodeId: n.id, nodeTitle: n.title, feedback, goal: getGoal(goal.id) });
            res.end();
            return;
          }
          if (!data || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('拆分结果解析失败，请重试');
          const childLevel = Math.min(n.level + 1, 5);
          let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nodes WHERE parent_id = ?').get(n.id).n;
          let added = 0;
          for (const t of data.tasks.slice(0, 10)) {
            insertNode(goal.id, n.id, childLevel, t.title || '子任务', t.detail || '', t.sources, order++, { artifact: t.artifact, acceptance: t.acceptance, hours: t.hours });
            added++;
          }
          db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
          const report2 = await finishVersion(goal, vid, reason);
          backup();
          send({ done: true, added, goal: getGoal(goal.id), sources: sourcesOf(goal.id), report: report2, versionId: vid });
        }
      } catch (e) {
        send({ error: e.message });
      }
      res.end();
    })();
    return;
  }
  const consMatch = p.match(/^\/api\/goals\/(\d+)\/constraints$/);
  if (consMatch) {
    const gid = Number(consMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    if (method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 300);
      if (!text) return sendJSON(res, 400, { error: '约束内容不能为空' });
      const list = safeParse(g.constraints) || [];
      list.push({ text, created_at: nowISO(), source: 'user' });
      db.prepare('UPDATE goals SET constraints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), nowISO(), gid);
      return sendJSON(res, 201, { goal: getGoal(gid) });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const idx = Number(body.index);
      const text = String(body.text || '').trim().slice(0, 300);
      const list = safeParse(g.constraints) || [];
      if (!(idx >= 0 && idx < list.length)) return sendJSON(res, 400, { error: '约束不存在' });
      if (!text) return sendJSON(res, 400, { error: '约束内容不能为空' });
      list[idx] = { ...list[idx], text, updated_at: nowISO() };
      db.prepare('UPDATE goals SET constraints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), nowISO(), gid);
      return sendJSON(res, 200, { goal: getGoal(gid) });
    }
  }
  const consDelMatch = p.match(/^\/api\/goals\/(\d+)\/constraints\/(\d+)$/);
  if (consDelMatch && method === 'DELETE') {
    const gid = Number(consDelMatch[1]);
    const idx = Number(consDelMatch[2]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const list = safeParse(g.constraints) || [];
    if (!(idx >= 0 && idx < list.length)) return sendJSON(res, 400, { error: '约束不存在' });
    list.splice(idx, 1);
    db.prepare('UPDATE goals SET constraints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), nowISO(), gid);
    return sendJSON(res, 200, { goal: getGoal(gid) });
  }
  const sessListMatch = p.match(/^\/api\/goals\/(\d+)\/chat-sessions$/);
  if (sessListMatch) {
    const gid = Number(sessListMatch[1]);
    if (method === 'GET') {
      const rows = db.prepare(`SELECT s.id, s.goal_id, s.title, s.model, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM chats c WHERE c.session_id = s.id) AS msg_count
        FROM chat_sessions s WHERE s.goal_id = ? ORDER BY s.updated_at DESC, s.id DESC`).all(gid);
      return sendJSON(res, 200, { sessions: rows });
    }
    if (method === 'POST') {
      const g = db.prepare('SELECT id FROM goals WHERE id = ?').get(gid);
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      let title = '新对话', model = '';
      try { const b = await readBody(req); if (b.title) title = String(b.title).slice(0, 60); if (b.model) model = String(b.model).slice(0, 120); } catch (e) {}
      const t = nowISO();
      const r = db.prepare('INSERT INTO chat_sessions (goal_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)').run(gid, title, model, t, t);
      const session = db.prepare('SELECT id, goal_id, title, model, created_at, updated_at, 0 AS msg_count FROM chat_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
      return sendJSON(res, 201, { session });
    }
  }
  const sessMatch = p.match(/^\/api\/chat-sessions\/(\d+)$/);
  if (sessMatch) {
    const sid = Number(sessMatch[1]);
    const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid);
    if (!s) return sendJSON(res, 404, { error: '对话不存在' });
    if (method === 'PUT') {
      const body = await readBody(req);
      const title = body.title != null ? String(body.title).trim().slice(0, 60) : s.title;
      const model = body.model != null ? String(body.model).trim().slice(0, 120) : s.model;
      db.prepare('UPDATE chat_sessions SET title = ?, model = ?, updated_at = ? WHERE id = ?').run(title || s.title, model, nowISO(), sid);
      return sendJSON(res, 200, { session: db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM chats WHERE session_id = ?').run(sid);
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sid);
      return sendJSON(res, 200, { ok: true });
    }
  }
  const sessMsgsMatch = p.match(/^\/api\/chat-sessions\/(\d+)\/messages$/);
  if (sessMsgsMatch && method === 'GET') {
    const sid = Number(sessMsgsMatch[1]);
    const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid);
    if (!s) return sendJSON(res, 404, { error: '对话不存在' });
    const rows = db.prepare('SELECT id, role, content, ops, version_id, created_at FROM chats WHERE session_id = ? ORDER BY id').all(sid);
    return sendJSON(res, 200, { session: s, messages: rows });
  }
  const sessChatMatch = p.match(/^\/api\/chat-sessions\/(\d+)\/chat$/);
  if (sessChatMatch && method === 'POST') {
    const sid = Number(sessChatMatch[1]);
    const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid);
    if (!s) return sendJSON(res, 404, { error: '对话不存在' });
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(s.goal_id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const message = String(body.message || '').trim().slice(0, 30000);
    if (!message) return sendJSON(res, 400, { error: '请先输入内容' });
    return streamChat(req, res, g, message, s);
  }
  const chatsMatch = p.match(/^\/api\/goals\/(\d+)\/chats$/);
  if (chatsMatch && method === 'DELETE') {
    const gid = Number(chatsMatch[1]);
    db.prepare('DELETE FROM chats WHERE goal_id = ?').run(gid);
    db.prepare('DELETE FROM chat_sessions WHERE goal_id = ?').run(gid);
    return sendJSON(res, 200, { ok: true });
  }
  const tutGenMatch = p.match(/^\/api\/nodes\/(\d+)\/tutorial$/);
  if (tutGenMatch && method === 'POST') {
    const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(tutGenMatch[1]));
    if (!n) return sendJSON(res, 404, { error: '节点不存在' });
    let format = 'md', note = '';
    try { const b = await readBody(req); format = b.format === 'html' ? 'html' : 'md'; note = String(b.note || '').trim().slice(0, 500); } catch (e) {}
    return streamTutorial(req, res, n, format, note);
  }
  const tutMatch = p.match(/^\/api\/tutorials\/(\d+)$/);
  if (tutMatch) {
    const id = Number(tutMatch[1]);
    if (method === 'GET') {
      const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(id);
      if (!t) return sendJSON(res, 404, { error: '教程不存在' });
      const node = db.prepare('SELECT id, title, level FROM nodes WHERE id = ?').get(t.node_id);
      const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(t.goal_id);
      return sendJSON(res, 200, { tutorial: t, node, goal });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM tutorials WHERE id = ?').run(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  const planTasksMatch = p.match(/^\/api\/goals\/(\d+)\/plan\/tasks$/);
  if (planTasksMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(planTasksMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    let answers = null;
    try { const b = await readBody(req); if (b && typeof b.answers === 'object' && b.answers) answers = b.answers; } catch (e) {}
    return streamPlanTasks(req, res, g, answers);
  }
  const planRefineMatch = p.match(/^\/api\/goals\/(\d+)\/plan\/refine$/);
  if (planRefineMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(planRefineMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const feedback = String(body.feedback || '').trim();
    let answers = null;
    if (body && typeof body.answers === 'object' && body.answers) answers = body.answers;
    if (!feedback && !answers) return sendJSON(res, 400, { error: '请填写调整意见' });
    return streamPlanRefine(req, res, g, feedback, answers);
  }
  const clarifyMatch = p.match(/^\/api\/goals\/(\d+)\/plan\/clarify$/);
  if (clarifyMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(clarifyMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    return streamClarify(req, res, g);
  }
  const drillMatch = p.match(/^\/api\/goals\/(\d+)\/clarify\/drill$/);
  if (drillMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(drillMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const qid = String(body.question_id || '');
    if (!qid) return sendJSON(res, 400, { error: '缺少问题 id' });
    return streamDrill(req, res, g, qid, body.answers || {}, body.note || '');
  }
  const noteMatch = p.match(/^\/api\/goals\/(\d+)\/clarify\/note$/);
  if (noteMatch && method === 'POST') {
    const gid = Number(noteMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const data = safeParse(g.clarify);
    if (!data || !Array.isArray(data.questions)) return sendJSON(res, 400, { error: '当前没有进行中的问卷' });
    const q = data.questions.find(x => String(x.id) === String(body.question_id));
    if (!q) return sendJSON(res, 404, { error: '找不到该问题' });
    const note = String(body.note || '').trim().slice(0, 1000);
    if (note) q.note = note; else delete q.note;
    db.prepare('UPDATE goals SET clarify = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), nowISO(), gid);
    return sendJSON(res, 200, { ok: true, clarify: data });
  }
  const planMatch = p.match(/^\/api\/goals\/(\d+)\/plan$/);
  if (planMatch && method === 'POST') {
    const id = Number(planMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    let answers = null;
    try { const b = await readBody(req); if (b && typeof b.answers === 'object') answers = b.answers; } catch (e) {}
    if (answers) db.prepare('UPDATE goals SET clarify_answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(answers), nowISO(), id);
    return streamPlan(req, res, g, answers);
  }

  const nodeAddMatch = p.match(/^\/api\/goals\/(\d+)\/nodes$/);
  if (nodeAddMatch && method === 'POST') {
    const goalId = Number(nodeAddMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
    let level = 0, parentId = null;
    if (body.parent_id) {
      const parent = db.prepare('SELECT * FROM nodes WHERE id = ? AND goal_id = ?').get(Number(body.parent_id), goalId);
      if (!parent) return sendJSON(res, 400, { error: '父节点不存在' });
      level = Math.min(parent.level + 1, 5);
      parentId = parent.id;
    }
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)').get(goalId, parentId).n;
    const vidAdd = beginVersion(goalId, '手动添加节点');
    insertNode(goalId, parentId, level, title, body.detail || '', body.sources || [], order);
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goalId);
    await finishVersion(g, vidAdd, '手动添加节点', false);
    backup();
    return sendJSON(res, 201, { goal: getGoal(goalId) });
  }

  const nodeMatch = p.match(/^\/api\/nodes\/(\d+)$/);
  if (nodeMatch) {
    const id = Number(nodeMatch[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (!n) return sendJSON(res, 404, { error: '节点不存在' });
      const title = body.title != null ? String(body.title).trim().slice(0, 200) : n.title;
      const detail = body.detail != null ? String(body.detail).trim().slice(0, 2000) : n.detail;
      const artifact = body.artifact != null ? String(body.artifact).trim().slice(0, 500) : n.artifact;
      const acceptance = body.acceptance != null ? String(body.acceptance).trim().slice(0, 500) : n.acceptance;
      const hours = body.hours != null ? String(body.hours).trim().slice(0, 50) : n.hours;
      const status = ['todo', 'doing', 'done'].includes(body.status) ? body.status : n.status;
      const sources = body.sources != null ? normalizeSources(body.sources) : n.sources;
      if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
      const contentChanged = ['title', 'detail', 'artifact', 'acceptance', 'hours', 'sources'].some(f => body[f] != null);
      const goalRow = contentChanged ? db.prepare('SELECT * FROM goals WHERE id = ?').get(n.goal_id) : null;
      const vidEdit = contentChanged ? beginVersion(n.goal_id, '手动编辑：' + n.title) : 0;
      db.prepare('UPDATE nodes SET title=?, detail=?, artifact=?, acceptance=?, hours=?, status=?, sources=?, updated_at=? WHERE id=?')
        .run(title, detail, artifact, acceptance, hours, status, sources, nowISO(), id);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
      if (vidEdit && goalRow) await finishVersion(goalRow, vidEdit, '手动编辑：' + n.title, false);
      return sendJSON(res, 200, { goal: getGoal(n.goal_id) });
    }
    if (method === 'DELETE') {
      const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (!n) return sendJSON(res, 404, { error: '节点不存在' });
      const goalRow = db.prepare('SELECT * FROM goals WHERE id = ?').get(n.goal_id);
      const vidDel = beginVersion(n.goal_id, '手动删除：' + n.title);
      deleteNodeTree(id);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
      if (vidDel && goalRow) await finishVersion(goalRow, vidDel, '手动删除：' + n.title, false);
      backup();
      return sendJSON(res, 200, { goal: getGoal(n.goal_id) });
    }
  }

  if (p === '/api/component-pins' && method === 'GET') {
    return sendJSON(res, 200, { pins: componentPins() });
  }
  if (p === '/api/component-pins' && method === 'POST') {
    const body = await readBody(req);
    if (Array.isArray(body.pins)) return sendJSON(res, 200, { ok: true, pins: saveComponentPins(body.pins) });
    const id = String(body.id || '');
    const valid = allComponents().some(c => c.id === id);
    if (!valid) return sendJSON(res, 404, { error: '组件不存在' });
    const list = componentPins();
    if (body.action === 'remove') {
      return sendJSON(res, 200, { ok: true, pins: saveComponentPins(list.filter(x => x !== id)) });
    }
    if (!list.includes(id)) list.push(id);
    return sendJSON(res, 200, { ok: true, pins: saveComponentPins(list) });
  }
  if (p === '/api/component-categories' && method === 'GET') {
    const { categories, used } = allCategoriesWithUsage();
    return sendJSON(res, 200, { categories, used, map: componentCategoryMap() });
  }
  if (p === '/api/component-categories' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 24);
    if (!name) return sendJSON(res, 400, { error: '分类名不能为空' });
    const list = componentCategoryList();
    if (list.includes(name)) return sendJSON(res, 400, { error: '该分类已存在' });
    list.push(name);
    saveComponentCategories(list);
    return sendJSON(res, 201, { ok: true, categories: allCategoriesWithUsage().categories });
  }
  if (p === '/api/component-categories' && method === 'PUT') {
    const body = await readBody(req);
    const from = String(body.from || '').trim();
    const to = String(body.name || '').trim().slice(0, 24);
    if (!from || !to) return sendJSON(res, 400, { error: '参数不完整' });
    const list = componentCategoryList();
    const idx = list.indexOf(from);
    if (idx >= 0) list[idx] = to; else list.push(to);
    saveComponentCategories(list);
    const map = componentCategoryMap();
    for (const k of Object.keys(map)) if (String(map[k]) === from) map[k] = to;
    saveComponentCategoryMap(map);
    return sendJSON(res, 200, { ok: true, categories: allCategoriesWithUsage().categories });
  }
  const catDelMatch = p.match(/^\/api\/component-categories\/(.+)$/);
  if (catDelMatch && method === 'DELETE') {
    const name = decodeURIComponent(catDelMatch[1]).trim();
    saveComponentCategories(componentCategoryList().filter(x => x !== name));
    const map = componentCategoryMap();
    // 该分类下的组件（含回落到插件默认分类者）显式归入「其它」，否则会被自动检测重新加回
    for (const c of allComponents()) {
      if (effectiveCategory(c.id, c.category) === name) map[c.id] = '其它';
    }
    saveComponentCategoryMap(map);
    return sendJSON(res, 200, { ok: true, categories: allCategoriesWithUsage().categories });
  }
  const compCatMatch = p.match(/^\/api\/components\/([a-z0-9_-]+)\/category$/i);
  if (compCatMatch && method === 'POST') {
    const cid = String(compCatMatch[1]);
    const comp = allComponents().find(c => c.id === cid);
    if (!comp) return sendJSON(res, 404, { error: '组件不存在' });
    const body = await readBody(req);
    const category = String(body.category || '').trim().slice(0, 24) || '其它';
    const map = componentCategoryMap();
    if (category === '其它') delete map[cid]; else map[cid] = category;
    if (category !== '其它' && !componentCategoryList().includes(category)) {
      const list = componentCategoryList(); list.push(category); saveComponentCategories(list);
    }
    saveComponentCategoryMap(map);
    return sendJSON(res, 200, { ok: true, category: effectiveCategory(cid, comp.category) });
  }

  /* ---- 更新检查与一键更新 ---- */
  if (p === '/api/update/status' && method === 'GET') {
    return sendJSON(res, 200, update.state);
  }
  if (p === '/api/update/check' && method === 'POST') {
    return sendJSON(res, 200, await update.check(true));
  }
  if (p === '/api/update/apply' && method === 'POST') {
    try { return sendJSON(res, 200, await update.apply()); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (p === '/api/update/restart' && method === 'POST') {
    return sendJSON(res, 200, update.restart());
  }

  if (p === '/api/sync/status' && method === 'GET') {
    return sendJSON(res, 200, await sync.status());
  }
  if (p === '/api/sync/settings' && method === 'POST') {
    const body = await readBody(req);
    const set = (k, v) => { if (v != null) setSetting(k, String(v).trim()); };
    if (body.repo != null) set('sync_repo', body.repo);
    if (body.branch != null) set('sync_branch', body.branch || 'main');
    if (body.user != null) set('sync_user', body.user);
    if (body.token != null && !/^•+$/.test(String(body.token).trim())) set('sync_token', body.token);
    if (body.enabled != null) set('sync_enabled', body.enabled ? '1' : '0');
    if (body.auto_push != null) set('sync_auto_push', body.auto_push ? '1' : '0');
    if (body.auto_pull != null) set('sync_auto_pull', body.auto_pull ? '1' : '0');
    if (body.images != null) set('sync_images', body.images ? '1' : '0');
    return sendJSON(res, 200, { ok: true, status: await sync.status() });
  }
  if (p === '/api/sync/test' && method === 'POST') {
    return sendJSON(res, 200, await sync.test());
  }
  if (p === '/api/sync/push' && method === 'POST') {
    try { return sendJSON(res, 200, await sync.push('手动上传')); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (p === '/api/sync/pull' && method === 'POST') {
    try { return sendJSON(res, 200, await sync.pull()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (p === '/api/service/status' && method === 'GET') {
    return sendJSON(res, 200, await service.status());
  }
  if (p === '/api/service/autostart' && method === 'POST') {
    const body = await readBody(req);
    const r = await service.setAutostart(!!body.enabled);
    const st = await service.status();
    return sendJSON(res, r.ok ? 200 : 500, { ...r, status: st });
  }
  if (p === '/api/service/shortcuts' && method === 'POST') {
    const r = await service.installShortcuts();
    const st = await service.status();
    return sendJSON(res, 200, { ...r, status: st });
  }
  if (p === '/api/service/open' && method === 'POST') {
    return sendJSON(res, 200, service.openBrowser());
  }
  if ((p === '/api/plugins' || p === '/api/components') && method === 'GET') {
    const comps = allComponents();
    const settings = componentSettings();
    const enabled = {};
    for (const c of comps) enabled[c.id] = (c.scope === 'core') ? true : (settings[c.id] != null ? !!settings[c.id] : !!c.defaultEnabled);
    return sendJSON(res, 200, {
      components: comps,
      pins: componentPins(),
      plugins: PLUGINS.map(pluginMeta),
      enabled,
      builtins: enabledBuiltins(),
      styles: comps.filter(c => c.style && enabled[c.id] !== false).map(c => c.style),
      dirs: { server: 'server/plugins', client: 'public/plugins' }
    });
  }
  const compToggleMatch = p.match(/^\/api\/components\/([a-z0-9_-]+)\/toggle$/i);
  if (compToggleMatch && method === 'POST') {
    const cid = String(compToggleMatch[1]);
    const comp = allComponents().find(c => c.id === cid);
    if (!comp) return sendJSON(res, 404, { error: '组件不存在' });
    if (comp.scope === 'core') return sendJSON(res, 400, { error: '核心组件不可关闭' });
    const body = await readBody(req);
    setComponent(cid, !!body.enabled);
    // 主题组件互斥：同时只启用一个主题
    if (comp.kind === 'theme' && body.enabled) {
      for (const other of allComponents()) {
        if (other.id !== cid && other.kind === 'theme') setComponent(other.id, false);
      }
    }
    const comps2 = allComponents();
    const map2 = componentSettings();
    const enabled2 = {};
    for (const c2 of comps2) enabled2[c2.id] = (c2.scope === 'core') ? true : (map2[c2.id] != null ? !!map2[c2.id] : !!c2.defaultEnabled);
    return sendJSON(res, 200, { ok: true, enabled: enabled2, settings: map2 });
  }
  const compExportMatch = p.match(/^\/api\/components\/([a-z0-9_-]+)\/export$/i);
  if (compExportMatch && method === 'GET') {
    const cid = String(compExportMatch[1]);
    const comp = allComponents().find(c => c.id === cid);
    if (!comp) return sendJSON(res, 404, { error: '组件不存在' });
    if (comp.builtin) return sendJSON(res, 400, { error: '内置组件不可导出（可在文档中查看其实现）' });
    let server = '', client = '', style = '';
    try { server = fs.readFileSync(path.join(PLUGIN_DIR, comp.id + '.js'), 'utf8'); } catch (e) {}
    try { client = fs.readFileSync(path.join(PUBLIC_DIR, 'plugins', comp.id + '.js'), 'utf8'); } catch (e) {}
    try { style = fs.readFileSync(path.join(PUBLIC_DIR, 'plugins', comp.id + '.css'), 'utf8'); } catch (e) {}
    const bundle = {
      format: 'sierxing-component', formatVersion: 1,
      id: comp.id, name: comp.name, icon: comp.icon, desc: comp.desc,
      version: comp.version, author: comp.author, order: comp.order, kind: comp.kind,
      goalToggle: comp.goalToggle, defaultEnabled: comp.defaultEnabled,
      exportedAt: nowISO(), server, client, style
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(comp.id + '.component.json')}`
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }
  if (p === '/api/components/install' && method === 'POST') {
    const body = await readBody(req);
    let bundle = body && body.bundle;
    if (typeof bundle === 'string') { try { bundle = JSON.parse(bundle); } catch (e) { return sendJSON(res, 400, { error: '组件文件不是合法 JSON' }); } }
    if (!bundle || bundle.format !== 'sierxing-component') return sendJSON(res, 400, { error: '不是有效的组件文件（缺少 format 标记）' });
    const cid = String(bundle.id || '').trim();
    if (!/^[a-z][a-z0-9_-]{1,30}$/i.test(cid)) return sendJSON(res, 400, { error: '组件 id 不合法（只允许字母数字与 - _）' });
    if (BUILTIN_COMPONENTS.some(b => b.id === cid)) return sendJSON(res, 400, { error: '不能覆盖内置组件 id：' + cid });
    if (typeof bundle.server !== 'string' || !bundle.server.includes('module.exports')) return sendJSON(res, 400, { error: '组件缺少服务端代码（server 字段）' });
    if (bundle.client != null && typeof bundle.client !== 'string') return sendJSON(res, 400, { error: 'client 字段必须是字符串' });
    backup();
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    const fileExisted = fs.existsSync(path.join(PLUGIN_DIR, cid + '.js'));
    fs.writeFileSync(path.join(PLUGIN_DIR, cid + '.js'), bundle.server);
    if (bundle.client) {
      fs.mkdirSync(path.join(PUBLIC_DIR, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(PUBLIC_DIR, 'plugins', cid + '.js'), bundle.client);
    }
    if (typeof bundle.style === 'string' && bundle.style.trim()) {
      fs.mkdirSync(path.join(PUBLIC_DIR, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(PUBLIC_DIR, 'plugins', cid + '.css'), bundle.style);
    }
    const n = reloadPlugins();
    const ok = FILE_PLUGINS.some(x => x.id === cid);
    if (!ok) return sendJSON(res, 500, { error: '组件已写入但加载失败，请检查服务端代码（查看服务日志）' });
    // 导入时可指定分类（批量导入时统一归类）
    let category = '';
    const wantCat = String(body.category || '').trim();
    if (wantCat && wantCat !== '__auto__') {
      const cat = wantCat.slice(0, 24);
      const map = componentCategoryMap();
      map[cid] = cat;
      saveComponentCategoryMap(map);
      const list = componentCategoryList();
      if (!list.includes(cat)) { list.push(cat); saveComponentCategories(list); }
      category = cat;
    } else {
      category = effectiveCategory(cid, (FILE_PLUGINS.find(x => x.id === cid) || {}).category);
    }
    return sendJSON(res, 201, { ok: true, id: cid, loaded: n, name: bundle.name || cid, category, replaced: fileExisted });
  }
  if (p === '/api/components/install-batch' && method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.bundles) ? body.bundles : [];
    if (!items.length) return sendJSON(res, 400, { error: '没有可导入的组件' });
    const wantCat = String(body.category || '').trim();
    const results = [];
    for (const raw of items) {
      let bundle = raw;
      if (typeof bundle === 'string') { try { bundle = JSON.parse(bundle); } catch (e) { results.push({ ok: false, error: '不是合法 JSON' }); continue; } }
      const cid = String((bundle && bundle.id) || '').trim();
      const name = String((bundle && bundle.name) || cid || '');
      if (!bundle || bundle.format !== 'sierxing-component') { results.push({ ok: false, id: cid, name, error: '不是有效的组件文件' }); continue; }
      if (!/^[a-z][a-z0-9_-]{1,30}$/i.test(cid)) { results.push({ ok: false, id: cid, name, error: '组件 id 不合法' }); continue; }
      if (BUILTIN_COMPONENTS.some(b => b.id === cid)) { results.push({ ok: false, id: cid, name, error: '不能覆盖内置组件' }); continue; }
      if (typeof bundle.server !== 'string' || !bundle.server.includes('module.exports')) { results.push({ ok: false, id: cid, name, error: '缺少服务端代码' }); continue; }
      try {
        backup();
        fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        fs.writeFileSync(path.join(PLUGIN_DIR, cid + '.js'), bundle.server);
        if (bundle.client) {
          fs.mkdirSync(path.join(PUBLIC_DIR, 'plugins'), { recursive: true });
          fs.writeFileSync(path.join(PUBLIC_DIR, 'plugins', cid + '.js'), bundle.client);
        }
        if (typeof bundle.style === 'string' && bundle.style.trim()) {
          fs.mkdirSync(path.join(PUBLIC_DIR, 'plugins'), { recursive: true });
          fs.writeFileSync(path.join(PUBLIC_DIR, 'plugins', cid + '.css'), bundle.style);
        }
        results.push({ ok: true, id: cid, name });
      } catch (e) {
        results.push({ ok: false, id: cid, name, error: e.message });
      }
    }
    const n = reloadPlugins();
    // 统一归类
    let category = '';
    if (wantCat && wantCat !== '__auto__') {
      const cat = wantCat.slice(0, 24);
      const map = componentCategoryMap();
      for (const r of results) if (r.ok) map[r.id] = cat;
      saveComponentCategoryMap(map);
      const list = componentCategoryList();
      if (!list.includes(cat)) { list.push(cat); saveComponentCategories(list); }
      category = cat;
    }
    const okCount = results.filter(r => r.ok).length;
    return sendJSON(res, 200, { ok: okCount > 0, loaded: n, category, results, okCount, failCount: results.length - okCount });
  }
  const compDelMatch = p.match(/^\/api\/components\/([a-z0-9_-]+)$/i);
  if (compDelMatch && method === 'DELETE') {
    const cid = String(compDelMatch[1]);
    if (BUILTIN_COMPONENTS.some(b => b.id === cid)) return sendJSON(res, 400, { error: '内置组件不可卸载' });
    if (!FILE_PLUGINS.some(x => x.id === cid)) return sendJSON(res, 404, { error: '组件不存在' });
    backup();
    try { fs.unlinkSync(path.join(PLUGIN_DIR, cid + '.js')); } catch (e) {}
    try { fs.unlinkSync(path.join(PUBLIC_DIR, 'plugins', cid + '.js')); } catch (e) {}
    try { fs.unlinkSync(path.join(PUBLIC_DIR, 'plugins', cid + '.css')); } catch (e) {}
    reloadPlugins();
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/components/reload' && method === 'POST') {
    const n = reloadPlugins();
    return sendJSON(res, 200, { ok: true, loaded: n });
  }
  const goalPluginsMatch = p.match(/^\/api\/goals\/(\d+)\/plugins$/);
  if (goalPluginsMatch) {
    const gid = Number(goalPluginsMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    if (method === 'GET') {
      return sendJSON(res, 200, { enabled: goalPlugins(g), config: safeParse(g.plugins) || {} });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const pid = String(body.plugin_id || '');
      if (!PLUGINS.some(x => x.id === pid)) return sendJSON(res, 404, { error: '插件不存在' });
      const cur = safeParse(g.plugins) || {};
      cur[pid] = !!body.enabled;
      db.prepare('UPDATE goals SET plugins = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cur), nowISO(), gid);
      return sendJSON(res, 200, { enabled: goalPlugins({ ...g, plugins: JSON.stringify(cur) }) });
    }
  }

  if (p === '/api/ai/models' && method === 'GET') {
    const r = await ai.models();
    return sendJSON(res, 200, { provider: r.provider, models: r.models || [], default: r.default || '', error: r.error || '' });
  }
  if (p === '/api/ai/status' && method === 'GET') {
    // visionModel 返回「实际会用的」视觉模型（含 opencode 默认值），前端据此提示
    return sendJSON(res, 200, { ...ai.status(), visionModel: currentVisionModel(), visionModelSaved: getSetting('vision_model', '') || '', env: { base: !!process.env.SIERXING_API_BASE || !!process.env.OPENAI_BASE_URL, key: !!process.env.SIERXING_API_KEY || !!process.env.OPENAI_API_KEY } });
  }
  if (p === '/api/ai/test' && method === 'POST') {
    const r = await ai.test();
    return sendJSON(res, 200, r);
  }

  if (p === '/api/backup' && method === 'POST') {
    backup();
    const count = fs.readdirSync(BACKUP_DIR).filter(x => x.startsWith('sierxing-')).length;
    return sendJSON(res, 200, { ok: true, count });
  }
  if (p === '/api/export/json' && method === 'GET') {
    const goals = db.prepare('SELECT * FROM goals ORDER BY id').all();
    const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all();
    const sources = db.prepare('SELECT * FROM sources ORDER BY id').all();
    const settings = db.prepare('SELECT * FROM settings').all();
    const tutorials = db.prepare('SELECT * FROM tutorials ORDER BY id').all();
    const pluginData = {};
    for (const pl of PLUGINS) { try { if (typeof pl.exportData === 'function') pluginData[pl.id] = pl.exportData(pluginCtx()); } catch (e) {} }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('思而行-导出-' + stamp() + '.json')}`
    });
    return res.end(JSON.stringify({ exportedAt: nowISO(), goals, nodes, sources, tutorials, settings, pluginData }, null, 2));
  }
  if (p === '/api/import/json' && method === 'POST') {
    const body = await readBody(req);
    const goals = Array.isArray(body.goals) ? body.goals : [];
    if (!goals.length) return sendJSON(res, 400, { error: '没有可导入的目标' });
    backup();
    db.exec('DELETE FROM nodes; DELETE FROM sources; DELETE FROM goals; DELETE FROM goal_versions; DELETE FROM tutorials; DELETE FROM chats; DELETE FROM chat_sessions;');
    for (const pl of PLUGINS) { try { if (typeof pl.clearAll === 'function') pl.clearAll(pluginCtx()); } catch (e) {} }
    const insG = db.prepare('INSERT INTO goals (id,title,profile,materials,weekly_hours,deadline,status,error,summary,constraints,plugins,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const g of goals) insG.run(g.id != null ? Number(g.id) : null, g.title || '', g.profile || '', g.materials || '', g.weekly_hours || '', g.deadline || '', g.status || 'draft', g.error || '', g.summary || '', typeof g.constraints === 'string' ? g.constraints : JSON.stringify(g.constraints || []), typeof g.plugins === 'string' ? g.plugins : JSON.stringify(g.plugins || {}), g.created_at || nowISO(), g.updated_at || nowISO());
    const insN = db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of (Array.isArray(body.nodes) ? body.nodes : [])) insN.run(n.id != null ? Number(n.id) : null, Number(n.goal_id), n.parent_id ? Number(n.parent_id) : null, Number(n.level || 0), n.title || '', n.detail || '', n.artifact || '', n.acceptance || '', n.hours || '', typeof n.sources === 'string' ? n.sources : JSON.stringify(n.sources || []), n.status || 'todo', Number(n.sort_order || 0), n.created_at || nowISO(), n.updated_at || nowISO());
    const insT = db.prepare('INSERT INTO tutorials (id,goal_id,node_id,title,format,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const t of (Array.isArray(body.tutorials) ? body.tutorials : [])) insT.run(t.id != null ? Number(t.id) : null, Number(t.goal_id), Number(t.node_id), t.title || '', t.format || 'md', t.content || '', t.created_at || nowISO(), t.updated_at || nowISO());
    const insS = db.prepare('INSERT INTO sources (id,goal_id,title,url,site,kind,snippet,content,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const s of (Array.isArray(body.sources) ? body.sources : [])) insS.run(s.id != null ? Number(s.id) : null, Number(s.goal_id), s.title || '', s.url || '', s.site || '', s.kind || '', s.snippet || '', s.content || '', s.created_at || nowISO());
    for (const pl of PLUGINS) {
      try { if (typeof pl.importData === 'function') pl.importData((body.pluginData || {})[pl.id], pluginCtx()); } catch (e) { console.error('[plugin]', pl.id, '导入失败:', e.message); }
    }
    return sendJSON(res, 200, { ok: true, goals: goals.length });
  }

  const versionsMatch = p.match(/^\/api\/goals\/(\d+)\/versions$/);
  if (versionsMatch && method === 'GET') {
    const rows = db.prepare('SELECT id, goal_id, reason, summary, created_at FROM goal_versions WHERE goal_id = ? ORDER BY id DESC LIMIT 30').all(Number(versionsMatch[1]));
    return sendJSON(res, 200, { versions: rows });
  }
  const versionMatch = p.match(/^\/api\/versions\/(\d+)$/);
  if (versionMatch && method === 'GET') {
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(Number(versionMatch[1]));
    if (!v) return sendJSON(res, 404, { error: '版本不存在' });
    const exact = u.searchParams.get('mode') === 'exact';
    const oldNodes = safeParse(v.snapshot) || [];
    const afterNodes = exact ? (safeParse(v.snapshot_after) || []) : null;
    const newNodes = (exact && afterNodes.length) ? afterNodes : db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(v.goal_id);
    const diff = diffVersions(Array.isArray(oldNodes) ? oldNodes : [], newNodes);
    const goal = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(v.goal_id);
    return sendJSON(res, 200, { version: { id: v.id, goal_id: v.goal_id, reason: v.reason, summary: v.summary, created_at: v.created_at }, exact, goal, old_nodes: oldNodes, new_nodes: newNodes, diff: { added: diff.added, removed: diff.removed, changed: diff.changed, total: diff.total } });
  }

  if (p === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, {
      sync: {
        enabled: getSetting('sync_enabled', '') === '1',
        repo: getSetting('sync_repo', ''),
        branch: getSetting('sync_branch', 'main'),
        user: getSetting('sync_user', ''),
        token_set: !!getSetting('sync_token', ''),
        auto_push: getSetting('sync_auto_push', '1') !== '0',
        auto_pull: getSetting('sync_auto_pull', '1') !== '0',
        images: getSetting('sync_images', '1') === '1'
      },
      model: currentModel(),
      vision_model: getSetting('vision_model', ''),
      ai_provider: getSetting('ai_provider', 'openai'),
      ai_base_url: getSetting('ai_base_url', ''),
      ai_api_key: getSetting('ai_api_key', '') ? '••••••••' : '',
      ai_vision_model: getSetting('ai_vision_model', ''),
      ai_opencode_agent: getSetting('ai_opencode_agent', 'NoTools'),
      ai_timeout_ms: getSetting('ai_timeout_ms', '300000'),
      env_keys: { base: !!(process.env.SIERXING_API_BASE || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE), key: !!(process.env.SIERXING_API_KEY || process.env.OPENAI_API_KEY), model: !!(process.env.SIERXING_MODEL || process.env.OPENAI_MODEL) }
    });
  }
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const set = (k, v) => { if (v != null) setSetting(k, String(v).trim()); };
    if (body.model != null) set('model', body.model);
    if (body.vision_model != null) set('vision_model', body.vision_model);
    if (body.ai_provider != null) {
      const pv = body.ai_provider === 'opencode' ? 'opencode' : 'openai';
      set('ai_provider', pv);
      if (pv === 'opencode') ai.ensureOpencodeAgent();   // 用到 opencode 才生成 .opencode/opencode.json
    }
    if (body.ai_base_url != null) set('ai_base_url', body.ai_base_url);
    if (body.ai_vision_model != null) set('ai_vision_model', body.ai_vision_model);
    if (body.ai_opencode_agent != null) set('ai_opencode_agent', body.ai_opencode_agent);
    if (body.ai_timeout_ms != null) set('ai_timeout_ms', body.ai_timeout_ms);
    if (body.ai_api_key != null && String(body.ai_api_key).trim() && !/^•+$/.test(String(body.ai_api_key).trim())) set('ai_api_key', body.ai_api_key);
    if (body.ai_api_key === '') setSetting('ai_api_key', '');
    return sendJSON(res, 200, { ok: true, settings: { model: currentModel(), ai_provider: getSetting('ai_provider', 'openai'), ai_base_url: getSetting('ai_base_url', ''), ai_vision_model: getSetting('ai_vision_model', ''), ai_timeout_ms: getSetting('ai_timeout_ms', '300000') } });
  }

  /* ===== 插件路由 ===== */
  const hit = matchRoute(PLUGINS, method, p);
  if (hit) {
    try {
      return await hit.route.handler(req, res, u, pluginCtx());
    } catch (e) {
      console.error('[plugin]', hit.plugin.id, '处理出错:', e.message);
      return sendJSON(res, 500, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

function serveUpload(req, res, p) {
  const name = path.basename(decodeURIComponent(p));
  const file = path.join(UPLOAD_DIR, name);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function serveStatic(req, res, p) {
  let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname.startsWith('/api/')) return await handleAPI(req, res, u);
    if (u.pathname.startsWith('/uploads/')) serveUpload(req, res, u.pathname.slice('/uploads/'.length));
    else serveStatic(req, res, u.pathname);
  } catch (e) {
    // 注意：流式（SSE）响应可能已经开始，此时不能再写响应头，否则会直接把进程搞崩
    console.error('[http] 请求处理失败:', (e && e.message) || e);
    try {
      if (!res.headersSent) sendJSON(res, 500, { error: e.message });
      else if (!res.writableEnded) res.end();
    } catch (e2) {}
  }
});

server.listen(PORT, () => {
  if (getSetting('ai_provider', 'openai') === 'opencode') ai.ensureOpencodeAgent();
  if (sync && getSetting('sync_enabled', '') === '1' && getSetting('sync_auto_pull', '1') !== '0') {
    sync.pull().then(r => console.log('[sync] 启动拉取:', r.imported ? ('已导入来自 ' + r.device + ' 的数据') : r.message))
      .catch(e => console.log('[sync] 启动拉取失败:', e.message));
  }
  update.startAutoCheck();   // 启动后台检查远端是否有新版本（不阻塞、失败静默）
  console.log(`思而行(SiErXing) started: http://localhost:${PORT}`);
  console.log('数据文件: data/sierxing.db');
  if (process.env.NO_OPEN) return;
  const url = `http://localhost:${PORT}`;
  if (process.platform === 'win32') { try { execFile('cmd', ['/c', 'start', '', url], () => {}); } catch (e) {} }
  else if (process.platform === 'darwin') { try { execFile('open', [url], () => {}); } catch (e) {} }
  else { try { execFile('xdg-open', [url], () => {}); } catch (e) {} }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用 PORT=3222 换端口启动。`);
    process.exit(1);
  } else console.error(e);
});
