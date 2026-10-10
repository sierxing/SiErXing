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
const createTasks = require('./tasks');
const { readCodeFiles, buildCodeBlock, listCodeFiles } = require('./code-read');
const nodeFolders = require('./node-folders');

const APP_DIR = path.resolve(__dirname, '..');
/* 前端资源版本戳：启动时对 public 下的 js/css 求哈希，发版后浏览器必取新文件。
   用内容哈希而不用时间戳：只改后端重启时不打扰前端，避免误报“有新版”。 */
/* 数据存放位置可改（设置页 →「数据存储路径」）：默认程序目录下的 data/，
   改过之后指针写在 APP_DIR/data-location.json（指针不能跟着数据一起挪走）。
   切换/迁移后必须重启 —— DATA_DIR 在启动时被插件、同步、上传按值捕获。 */
const dataDir = require('./data-dir');
const DATA_DIR = dataDir.readPointer(APP_DIR).dir;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'sierxing.db');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
/* 前端资源版本戳：启动时对 public 下的 js/css 求内容哈希，发版后浏览器必取新文件。
   用内容哈希而不用时间戳：只改后端重启时不打扰前端。必须在 PUBLIC_DIR 之后定义，
   否则会撞 TDZ、哈希恒为空串的 sha256（e3b0c442…），版本戳形同虚设。 */
const ASSET_V = (() => {
  try {
    const crypto = require('node:crypto');
    const h = crypto.createHash('sha256');
    const files = ['index.html', 'app.js', 'sdk.js', 'style.css'];
    try {
      for (const f of fs.readdirSync(path.join(PUBLIC_DIR, 'plugins'))) {
        if (/\.js$|\.css$/.test(f)) files.push('plugins/' + f);
      }
    } catch (e) {}
    let n = 0;
    for (const f of files) {
      try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); n++; } catch (e) {}
    }
    if (!n) throw new Error('没有读到任何前端文件，版本戳不可信');
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    console.warn('[asset] 版本戳计算失败，回退到时间戳：', (e && e.message) || e);
    return String(Date.now());
  }
})();

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

/* 指针指向的目录可能已经不存在（比如用户拔了移动硬盘）—— 重建空的，别让程序起不来 */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('数据目录不可用：' + DATA_DIR + '（' + (e.message || e) + '）'); }
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = DELETE;
PRAGMA busy_timeout = 5000;
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
/* 教程版本：每次“AI 修改 / 手动保存”覆盖正文前，先把旧正文存一份。
   回滚本身也会先存当前版，所以恢复操作永远可撤销。
   只留最近 10 版，超了删最旧的（正文最长几万字，无限留会撑库）。 */
CREATE TABLE IF NOT EXISTS tutorial_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tutver_tid ON tutorial_versions(tutorial_id, id);
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
CREATE TABLE IF NOT EXISTS plan_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'skeleton',
  content TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(goal_id, kind)
);
`);
/* setSetting 也要给：连接列表存在 settings 表里，ai.js 要能自己写回去 */
ai.init({ getSetting: (k, d) => getSetting(k, d), setSetting: (k, v) => setSetting(k, v), appDir: APP_DIR });
function currentModel() { return getSetting('model', '') || ai.config().model || ''; }
const DEFAULT_VISION_MODEL = 'opencode-go/deepseek-v4-flash-vision-exp';   // opencode 用户的默认视觉模型（与实习速成一致）
function currentVisionModel() {
  /* 优先级：独立识图配置（自带地址密钥，最明确）> 用户选的识图引用 >
     识图专用连接的第一个模型 > 对话连接自带的视觉模型 > 旧单值。
     状态行直接显示最终用哪个，用户不再猜。 */
  try {
    const v = ai.standaloneVision();
    if (v) return v.models[0];
  } catch (e) {}
  const ref = getSetting('vision_model', '');
  if (ref) return ref;
  try {
    const vp = ai.modelPoolVision();
    if (vp && vp.length) return vp[0].id;
  } catch (e) {}
  const saved = ai.config().visionModel;
  if (saved) return saved;
  // 没配视觉模型时：opencode 走可读图的默认模型，避免用纯文本模型硬读图导致"提炼失败"
  if (getSetting('ai_provider', 'openai') === 'opencode') return DEFAULT_VISION_MODEL;
  return currentModel();
}

const service = createService({ appDir: APP_DIR, port: PORT, log: (...a) => console.log(...a) });
const update = createUpdate({ appDir: APP_DIR, port: PORT, log: (...a) => console.log(...a) });
const tasks = createTasks({ log: (...a) => console.log(...a) });
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
  { id: 'chat',        name: 'AI 助手',   icon: '💬', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 14,
    desc: '右侧对话侧边栏：随时用自然语言让 AI 修改路线图（支持多会话与模型切换）' },
  { id: 'tutorial',    name: '学习教程',     icon: '📘', scope: 'base', defaultEnabled: true, category: '基础功能组件', order: 15,
    desc: '为任意任务点生成“真正学会”的完整教程（HTML / Markdown，含练习与自测）' },
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
/* 可按目标独立管理的组件 id：基础内置组件 + 按目标启用的文件组件（主题/核心/应用级组件保持全局） */
function manageableCompIds() {
  const ids = BUILTIN_COMPONENTS.filter(b => b.scope === 'base').map(b => b.id);
  for (const p of (PLUGINS || [])) {
    if (p.kind === 'theme' || p.goalToggle === false) continue;
    if (!ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}
/* 组件有效开关（目标之间彻底隔离）：目标显式值 > 全局开关 > 默认值 */
function globalCompOn(id) {
  const b = BUILTIN_COMPONENTS.find(x => x.id === id);
  if (b) return componentOn(id);
  const p = (PLUGINS || []).find(x => x.id === id);
  const map = componentSettings();
  if (map[id] != null) return !!map[id];
  return !!(p && p.defaultEnabled);
}
function goalCompOn(goalId, compId) {
  if (goalId != null) {
    try {
      const g = db.prepare('SELECT plugins FROM goals WHERE id = ?').get(Number(goalId));
      const obj = safeParse(g && g.plugins) || {};
      if (obj[compId] != null) return !!obj[compId];
    } catch (e) {}
  }
  return globalCompOn(compId);
}
/* 新目标建档时，把当前全局有效值快照为显式值：之后全局再怎么拨，都不会串到已有目标 */
function snapshotCompSel() {
  const sel = {};
  for (const id of manageableCompIds()) sel[id] = globalCompOn(id);
  return sel;
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
  for (const id of manageableCompIds()) {
    if (obj[id] != null) out[id] = !!obj[id];
    else {
      const b = BUILTIN_COMPONENTS.find(x => x.id === id);
      const p = (PLUGINS || []).find(x => x.id === id);
      const map = componentSettings();
      out[id] = map[id] != null ? !!map[id] : !!((b && b.defaultEnabled) || (p && p.defaultEnabled));
    }
  }
  // 透传历史遗留的其它键（主题等），不参与按目标管理也不丢数据
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = !!obj[k];
  return out;
}
function pluginCtx() {
  return {
    db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup,
    log: (...a) => console.log(...a),
    fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR,
    getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel, tasks
  };
}
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!cols.includes('artifact')) db.exec("ALTER TABLE nodes ADD COLUMN artifact TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('acceptance')) db.exec("ALTER TABLE nodes ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('hours')) db.exec("ALTER TABLE nodes ADD COLUMN hours TEXT NOT NULL DEFAULT '';");
  const scols = db.prepare('PRAGMA table_info(sources)').all().map(c => c.name);
  if (!scols.includes('quality')) db.exec('ALTER TABLE sources ADD COLUMN quality INTEGER NOT NULL DEFAULT 0;');   // 1=优质信息源
  if (!scols.includes('published_at')) db.exec("ALTER TABLE sources ADD COLUMN published_at TEXT NOT NULL DEFAULT '';");
  const gcols = db.prepare('PRAGMA table_info(goals)').all().map(c => c.name);
  if (!gcols.includes('clarify')) db.exec("ALTER TABLE goals ADD COLUMN clarify TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('clarify_answers')) db.exec("ALTER TABLE goals ADD COLUMN clarify_answers TEXT NOT NULL DEFAULT '';");
  /* 用户在问卷里选的「要不要搜集外部资料」：'' 没问过 / yes / no / later */
  if (!gcols.includes('collect_pref')) db.exec("ALTER TABLE goals ADD COLUMN collect_pref TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('clarify_stage')) db.exec("ALTER TABLE goals ADD COLUMN clarify_stage TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('constraints')) db.exec("ALTER TABLE goals ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]';");
  if (!gcols.includes('plugins')) db.exec("ALTER TABLE goals ADD COLUMN plugins TEXT NOT NULL DEFAULT '{}';");
  if (!gcols.includes('ebook_pref')) db.exec("ALTER TABLE goals ADD COLUMN ebook_pref TEXT NOT NULL DEFAULT '';");
  if (!gcols.includes('collect_plan')) db.exec("ALTER TABLE goals ADD COLUMN collect_plan TEXT NOT NULL DEFAULT '';");
  const tcols = db.prepare('PRAGMA table_info(tutorials)').all().map(c => c.name);
  if (!tcols.includes('code_files')) db.exec("ALTER TABLE tutorials ADD COLUMN code_files TEXT NOT NULL DEFAULT '[]';");
  if (!gcols.includes('qa')) db.exec("ALTER TABLE goals ADD COLUMN qa TEXT NOT NULL DEFAULT '[]';");
  if (!gcols.includes('ask_round')) db.exec("ALTER TABLE goals ADD COLUMN ask_round INTEGER NOT NULL DEFAULT 0;");
  if (!cols.includes('qa')) db.exec("ALTER TABLE nodes ADD COLUMN qa TEXT NOT NULL DEFAULT '[]';");
  if (!cols.includes('ask_round')) db.exec("ALTER TABLE nodes ADD COLUMN ask_round INTEGER NOT NULL DEFAULT 0;");
  if (!cols.includes('qa_pending')) db.exec("ALTER TABLE nodes ADD COLUMN qa_pending TEXT NOT NULL DEFAULT '';");
  const vcols = db.prepare('PRAGMA table_info(goal_versions)').all().map(c => c.name);
  if (!vcols.includes('snapshot_after')) db.exec("ALTER TABLE goal_versions ADD COLUMN snapshot_after TEXT NOT NULL DEFAULT '';");
  if (!vcols.includes('manual')) db.exec("ALTER TABLE goal_versions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;");
  if (!vcols.includes('starred')) db.exec("ALTER TABLE goal_versions ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;");
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
/* 一次性回填：老目标缺的按目标开关 key，按当前有效值补齐（之后全局拨动不再串到已有目标） */
(function backfillGoalPlugins() {
  try {
    const ids = manageableCompIds();
    if (!ids.length) return;
    let n = 0;
    const upd = db.prepare('UPDATE goals SET plugins = ? WHERE id = ?');
    for (const g of db.prepare('SELECT id, plugins FROM goals').all()) {
      let obj = {};
      try { obj = JSON.parse(g.plugins || '{}') || {}; } catch (e) { obj = {}; }
      let changed = false;
      for (const id of ids) {
        if (obj[id] == null) { obj[id] = globalCompOn(id); changed = true; }
      }
      if (changed) { upd.run(JSON.stringify(obj), g.id); n++; }
    }
    if (n) console.log('[migrate] 已为 ' + n + ' 个老目标补齐按目标组件开关');
  } catch (e) { console.error('[migrate] 回填目标组件开关失败:', e.message); }
})();
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
  // 注：数据库用 DELETE journal 模式（单文件，无 WAL 旁文件），
  // 历史上 WAL 旁文件曾被外部删掉导致读写分裂，已不再用 WAL。
  try {
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
  for (const s of arr.slice(0, 12)) {
    if (!s) continue;
    if (typeof s === 'string') { const name = s.trim(); if (name) out.push({ name, note: '' }); continue; }
    const name = String(s.name || '').trim();
    const note = String(s.note || '').trim();
    /* 文件夹资料源条目：kind/path/source_id 必须原样保留，
       否则 PUT 保存一次就把挂载的文件夹洗掉了 */
    const entry = { name: name || note.slice(0, 40), note };
    if (s.kind === 'folder') {
      const p = String(s.path || '').trim().slice(0, 500);
      if (!p) continue;
      entry.kind = 'folder';
      entry.path = p;
    }
    const sid = Number(s.source_id || 0);
    if (sid) entry.source_id = sid;
    if (entry.name || entry.note || entry.kind === 'folder') out.push(entry);
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
  /* 建节点即建目录：一个节点对应一个文件夹，子目录嵌在父目录下（失败只记日志，不影响建节点） */
  try {
    const nid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    if (nid) for (const pl of PLUGINS) { try { if (typeof pl.onNodeCreated === 'function') pl.onNodeCreated(goalId, nid, pluginCtx()); } catch (e) { console.error('[plugin]', pl.id, 'onNodeCreated 失败:', e.message); } }
  } catch (e) { console.error('[workspace] 建目录失败:', e.message); }
}
function deleteNodeTree(id) {
  const children = db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(id).map(x => x.id);
  for (const c of children) deleteNodeTree(c);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  /* 节点删除时同步删掉目录映射（磁盘文件保留，避免误删代码） */
  try { db.prepare('DELETE FROM node_workspaces WHERE node_id = ?').run(id); } catch (e) {}
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
  // 有用户确认过的搜集方案就用它；没有则 AI 现场按目标定（求职目标会含 JD/面经，认知学习类则不会）
  const fresh = db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id) || goal;
  let plan = getCollectPlan(fresh);
  let queries = (plan.queries || []).filter(q => q && q.q && q.on !== false);
  if (!queries.length && !plan.asked) {
    onProgress({ status: '正在按目标制定搜集方案…' });
    try {
      queries = await recommendCollectPlan(fresh);
      saveCollectPlan(fresh.id, { asked: true, queries, updatedAt: nowISO() });
    } catch (e) {
      console.log('[collect] 方案推荐失败，用默认模板:', e.message);
      queries = collectQueries(goal.title);
    }
  }
  return collectSources(goal, queries.slice(0, 20).map(q => ({
    kind: String(q.kind || '资料').slice(0, 10),
    q: String(q.q || '').slice(0, 120),
    days: Math.min(730, Math.max(30, Number(q.days) || 365))
  })), onProgress, signal);
}
/* 搜集方案：用户说明/选择要搜什么（存目标上，重复搜集沿用，可随时改） */
function getCollectPlan(goal) {
  try {
    const p = JSON.parse((goal && goal.collect_plan) || 'null');
    if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  } catch (e) {}
  return { asked: false, queries: [] };
}
function saveCollectPlan(goalId, plan) {
  db.prepare('UPDATE goals SET collect_plan = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), nowISO(), goalId);
  backup();
}
function buildCollectPlanPrompt(goal) {
  const L = [];
  L.push('用户要搜集学习资料，现在请你为这个目标制定一份「搜集方案」：决定去网上搜什么。');
  L.push(goalHeader(goal));
  L.push('');
  L.push('【要求】');
  L.push('1. 先看目标类型再定搜集方向，千万不要把求职模板硬套到非求职目标上：');
  L.push('   · 求职/转行类：JD（招聘要求，days=60）、面经（days=365）、学习路线、技能、项目、经验；');
  L.push('   · 认知/通识/兴趣学习类（如理解经济商业运转）：概念解读、核心理论与模型、经典著作解读/书评、公开课与讲座、行业研报与数据、人物访谈、通俗入门文章；不要搜招聘 JD、面经、岗位职责；');
  L.push('   · 技能/考证/考研类：考试要求与大纲、真题与经验、学习路线、教材与课程、工具；');
  L.push('   · 其它类型：按目标自己定贴切的类别。');
  L.push('2. 10-16 条，每条都是可直接拿去搜的完整 query（带上目标关键词，中文为主；可加 site:限定，如 site:zhihu.com / site:bilibili.com，视频类用 B站/YouTube 文字页能抓到的才算数，抓不到正文的不要）。');
  L.push('3. kind 是短标签（2-4字，会显示在资料上），days 是时效（招聘 60，知识类 365）。');
  L.push('4. 只输出一个 JSON 数组：');
  L.push('[{"kind":"理论","q":"行为经济学 心理账户 前景理论 解读","days":365}]');
  return L.join('\n');
}
async function recommendCollectPlan(goal, timeoutMs) {
  const txt = await aiText(buildCollectPlanPrompt(goal), currentModel(), timeoutMs || 120000);
  let arr = extractJSON(txt);
  if (!Array.isArray(arr)) {
    const m = String(txt || '').match(/\[[\s\S]*\]/);
    arr = m ? extractJSON(m[0]) : null;
  }
  if (!Array.isArray(arr)) throw new Error('搜集方案生成失败');
  return arr.filter(x => x && x.q).slice(0, 16).map(x => ({
    kind: String(x.kind || '资料').slice(0, 10),
    q: String(x.q).slice(0, 120),
    days: Math.min(730, Math.max(30, Number(x.days) || 365)),
    on: true
  }));
}
/* ================= 电子书搜集：公版自动下载 + 待找书单 =================
 * 只碰完全免费的公版书（Project Gutenberg）。有版权的现代书下不到——
 * 走「待找书单」入库（含获取指引），用户用「信息源导入」页自行导入。 */
function getEbookPref(goal) {
  try {
    const p = JSON.parse((goal && goal.ebook_pref) || 'null');
    if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  } catch (e) {}
  return { asked: false, want: '', books: [], done: false };
}
function saveEbookPref(goalId, pref) {
  db.prepare('UPDATE goals SET ebook_pref = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(pref), nowISO(), goalId);
  backup();
}
function buildEbookRecommendPrompt(goal) {
  const L = [];
  L.push('用户立了一个学习目标，现在要为他/她列一份入门书单（书将作为学习信息源）。');
  L.push(goalHeader(goal));
  L.push('');
  L.push('【要求】');
  L.push('1. 6-8 本：从经典/入门到进阶排序，兼顾理论框架与实践；中文书优先（注明），实在没有再给英文经典。');
  L.push('2. 每本一句话推荐理由（40 字内，说清这本书解决什么认知问题）。');
  L.push('3. public_domain 字段：这本书是否很可能是公版书（作者去世超过 50 年的老经典，如亚当·斯密《国富论》填 true；现代书一律 false，不要猜）。');
  L.push('4. where 字段：这本书最靠谱的 1-2 个获取渠道（20 字内，如：微信读书有售 / 图书馆可借 / 京东购买 / 公版可直下；不知道就写"图书馆、微信读书搜书名"）。');
  L.push('5. en 字段：这本书的英文原名（只给外国书，且你确定知道原名才填，如 Wealth of Nations；中文原创书留空。用于去公版书库按原名兜底找）。');
  L.push('6. 只输出一个 JSON 数组：');
  L.push('[{"title":"书名","author":"作者（不详留空）","pitch":"一句话推荐理由","public_domain":false,"where":"微信读书有售","en":""}]');
  return L.join('\n');
}
async function recommendEbooks(goal, timeoutMs) {
  const txt = await aiText(buildEbookRecommendPrompt(goal), currentModel(), timeoutMs || 120000);
  let arr = extractJSON(txt);
  if (!Array.isArray(arr)) {
    const m = String(txt || '').match(/\[[\s\S]*\]/);
    arr = m ? extractJSON(m[0]) : null;
  }
  if (!Array.isArray(arr)) throw new Error('书单生成失败');
  return arr.filter(x => x && x.title).slice(0, 8).map(x => ({
    title: String(x.title).slice(0, 80), author: String(x.author || '').slice(0, 40),
    pitch: String(x.pitch || '').slice(0, 80), public_domain: !!x.public_domain,
    where: String(x.where || '').slice(0, 40), en: String(x.en || '').slice(0, 80), status: 'pending'
  }));
}
async function gFetch(url, ms, asText) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiErXing-ebook/1.0)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return asText ? await r.text() : Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}
function normTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[《》「」『』()（）\[\]【】:：·—–-]/g, ' ')
    .replace(/(全译本|译本|插图版|珍藏版|经典版|畅销|修订版|第[一二三四五\d]+版)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
async function findGutenbergBook(title, author) {
  const queries = author ? [`${title} ${author}`, title] : [title];
  const cands = new Map();
  for (const q of queries.slice(0, 2)) {
    let html = '';
    try { html = await gFetch('https://www.gutenberg.org/ebooks/search/?query=' + encodeURIComponent(q), 25000, true); }
    catch (e) { continue; }
    const ids = [...html.matchAll(/\/ebooks\/(\d+)/g)].map(m => m[1]);
    const titles = [...html.matchAll(/<span class="title">([^<]{1,120})<\/span>/g)].map(m => m[1]);
    ids.forEach((id, i) => { if (!cands.has(id)) cands.set(id, titles[i] || ''); });
    if (cands.size >= 5) break;
  }
  if (!cands.size) return null;
  const want = normTitle(title).replace(/ /g, '');
  const wantTokens = new Set(normTitle(title).split(' ').filter(x => x.length >= 2));
  const au = String(author || '').replace(/·.*/g, '').trim().toLowerCase();
  let best = null, bestScore = 0;
  for (const [id, t] of cands) {
    const got = normTitle(t).replace(/ /g, '');
    let score = 0;
    if (got && want && (got.includes(want) || want.includes(got))) score += 3;
    else {
      let hit = 0;
      for (const w of wantTokens) if (w && got.includes(w.replace(/ /g, ''))) hit++;
      score += hit / Math.max(1, wantTokens.size);
    }
    if (au && t.toLowerCase().includes(au.slice(0, 12))) score += 1;
    if (score > bestScore) { bestScore = score; best = { id, title: t }; }
  }
  return bestScore >= 1 ? best : null;
}
async function downloadGutenberg(id, title) {
  const urls = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/ebooks/${id}.epub.images`
  ];
  let lastErr = null;
  for (const u of urls) {
    try {
      const buf = await gFetch(u, 60000, false);
      if (!buf || buf.length < 500) { lastErr = new Error('文件太小，可能没下到'); continue; }
      const ext = u.endsWith('.epub.images') ? 'epub' : 'txt';
      const safe = String(title || ('gutenberg-' + id)).replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || ('gutenberg-' + id);
      return { buf, filename: `${safe}-gutenberg-${id}.${ext}` };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('下载失败');
}
function writeWantedList(goalId, books) {
  db.prepare("DELETE FROM sources WHERE goal_id = ? AND site = '待找书单'").run(goalId);
  const list = (books || []).filter(b => b && b.title);
  if (!list.length) { backup(); return; }
  const lines = list.map(b => {
    const base = `《${b.title}》${b.author ? '（' + b.author + '）' : ''}`;
    const why = b.pitch ? '——' + b.pitch : '';
    const src = b.where ? b.where : '图书馆、微信读书搜书名';
    const how = b.status === 'failed'
      ? `公版渠道没下到（${String(b.error || '网络问题').slice(0, 60)}），请自行找书`
      : '无公开免费版，请通过正版渠道获取';
    return `· ${base}${why}\n  去哪找：${src}\n  ${how}，找到后在「信息源导入」页拖进来，规划会自动参考。`;
  });
  const t = nowISO();
  db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(goalId, `待找书单（${list.length} 本）`, '', '待找书单', '书籍',
      list.map(b => `《${b.title}》`).join('、').slice(0, 300),
      '以下书建议作为本目标的信息源（搜集时没找到公开免费版，请自行找书导入）：\n\n' + lines.join('\n\n'), '', t);
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goalId);
  backup();
}
/* 搜集期的电子书阶段：公版自动下载入库 + 其余写待找书单。返回 {ok, missing, failed, listed, skipped} */
async function fetchEbooksForGoal(goal, send, signal) {
  const fresh = db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id) || goal;
  const pref = getEbookPref(fresh);
  const checkStop = () => { if (signal && signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
  if (!pref.asked || pref.want === 'no' || pref.want === '') return { skipped: true };
  let books = (pref.books || []).filter(b => b && b.title && b.status === 'pending');
  if (!books.length && !pref.done) {
    // 问卷里没写具体书：AI 现场按目标推荐
    send({ status: '正在按目标推荐入门书单…' });
    try {
      const rec = await recommendEbooks(fresh);
      books = rec;
      pref.books = (pref.books || []).concat(books);
      saveEbookPref(fresh.id, pref);
    } catch (e) {
      console.log('[ebooks] 推荐书单失败:', e.message);
      return { skipped: true, note: '书单推荐失败' };
    }
  }
  books = books.slice(0, 5);
  // 本批内按书名去重
  {
    const seenT = new Set();
    books = books.filter(b => {
      const k = String(b.title || '').toLowerCase().replace(/\s+/g, ' ');
      if (seenT.has(k)) return false;
      seenT.add(k);
      return true;
    });
  }
  if (!books.length) return { skipped: true, already: true };
  if (pref.want === 'list') {
    writeWantedList(fresh.id, books.map(b => ({ ...b, status: 'listed' })));
    for (const b of books) b.status = 'done';
    pref.done = !(pref.books || []).some(b => b && b.status === 'pending');
    saveEbookPref(fresh.id, pref);
    send({ status: `已生成待找书单（${books.length} 本），请自行找书后在「信息源导入」页拖进来` });
    return { listed: books.length };
  }
  // auto：公版渠道逐本下载入库（最多 2 本并发）
  let ok = 0;
  const missing = [], failed = [];
  // 已入库的不重复下载（问卷重跑导致重复推荐时直接跳过）
  let haveTitles = [];
  try { haveTitles = db.prepare("SELECT title FROM sources WHERE goal_id = ? AND kind = '书籍'").all(fresh.id).map(r => String(r.title || '')); } catch (e) {}
  const normT = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  await mapLimit(books, 2, async b => {
    checkStop();
    const key = normT(b.title).slice(0, 12);
    if (key && haveTitles.some(t => normT(t).includes(key))) {
      b.status = 'done'; ok++;
      send({ status: `《${b.title}》已在库，跳过 ✓` });
      return;
    }
    send({ status: `找书《${b.title}》（公版渠道）…` });
    try {
      let hit = await findGutenbergBook(b.title, b.author);
      if (!hit && b.en) {
        send({ status: `《${b.title}》中文没找到，试英文原名《${String(b.en).slice(0, 30)}》…` });
        hit = await findGutenbergBook(b.en, b.author);
      }
      if (!hit) { b.status = 'missing'; missing.push(b); return; }
      checkStop();
      send({ status: `下载《${b.title}》…` });
      const { buf, filename } = await downloadGutenberg(hit.id, b.title);
      const info = await require('./plugins/jdfile.js').ingestEbookBuffer(
        { id: fresh.id }, buf, filename, '公版书：用户在搜集前确认需要',
        st => send({ status: `《${b.title}》${st}` }), 0,
        `Project Gutenberg 公版（ebook #${hit.id}）`);
      b.status = 'done'; b.gid = hit.id; ok++;
      send({ status: `《${b.title}》已入库 ✓（${info.title.slice(0, 30)}）` });
    } catch (e) {
      console.log('[ebooks] 下载/入库失败', b.title, e.message);
      b.status = 'failed'; b.error = String(e.message || '').slice(0, 120); failed.push(b);
      send({ status: `《${b.title}》没下到：${String(e.message || '').slice(0, 60)}` });
    }
  });
  writeWantedList(fresh.id, missing.concat(failed));
  pref.done = !(pref.books || []).some(b => b && b.status === 'pending');
  saveEbookPref(fresh.id, pref);
  return { ok, missing: missing.length, failed: failed.length };
}
// 按节点主题搜集（拆分节点时使用，颗粒更聚焦；类别保持通用，不限定求职站点）
const nodeQueries = title => {
  const k = searchKeyword(title);
  return [
    { kind: '技能', q: `${k} 具体怎么做 步骤 教程`, days: 365 },
    { kind: '学习路线', q: `${k} 学习路线 知识要点`, days: 365 },
    { kind: '项目', q: `${k} 练习案例 项目实战`, days: 365 },
    { kind: '经验', q: `${k} 经验 踩坑 注意`, days: 365 },
    { kind: '资源', q: `${k} 推荐资料 工具`, days: 365 }
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
  // 已知类别沿用配额；AI 新定的类别默认每类 14 条、总量不超 160（老求职模板行为不变）
  const KIND_QUOTA = { 'JD': 32, '面经': 26, '学习路线': 26, '技能': 16, '项目': 16, '资源': 12, '经验': 16 };
  const quotaOf = k => KIND_QUOTA[k] || 14;
  const picked = [];
  let totalPicked = 0;
  for (const kind of [...new Set(all.map(s => s.kind))]) {
    const arr = all.filter(s => s.kind === kind).sort((a, b) => prio(a.host) - prio(b.host));
    const siteCount = {};
    let taken = 0;
    for (const s of arr) {
      if (totalPicked >= 160) break;
      siteCount[s.site] = (siteCount[s.site] || 0) + 1;
      if (siteCount[s.site] > 8) continue; // 同类内单站点最多 8 条，保证多样性
      picked.push(s);
      taken++;
      totalPicked++;
      if (taken >= quotaOf(kind)) break;
    }
    if (totalPicked >= 160) break;
  }
  // 累积式采集：保留已有来源，仅追加新来源（按 URL 去重），并清理超期数据
  const existingUrls = new Set(db.prepare('SELECT url FROM sources WHERE goal_id = ?').all(goal.id).map(r => r.url));
  const seenFinal = new Set();
  const now = Date.now();
  let fetched = 0, saved = 0, ads = 0, skipped = 0, pdfSaved = 0;
  const MAX_PDF = 4;   // 每次搜集最多全文入库 4 个 PDF（公开报告/论文/讲义），控制耗时
  // 已入库的报告/书籍标题（归一化前缀）：同一文档换个 URL 不重复下
  let haveDocTitles = [];
  try {
    haveDocTitles = db.prepare("SELECT title FROM sources WHERE goal_id = ? AND kind IN ('书籍','报告')").all(goal.id)
      .map(r => String(r.title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16)).filter(Boolean);
  } catch (e) {}
  const docSeen = t => { const k = String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16); return k && haveDocTitles.some(h => h.includes(k) || k.includes(h)); };
  const docMark = t => { const k = String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16); if (k) haveDocTitles.push(k); };
  await mapLimit(picked, 4, async s => {
    checkStop();
    fetched++;
    if (fetched % 8 === 0) onProgress({ status: `抓取正文 ${fetched}/${picked.length}（新增 ${saved} 条，排除广告 ${ads} 条，跳过已有 ${skipped} 条）` });
    if (existingUrls.has(s.url)) { skipped++; return; }
    // PDF 直下全文入库：公开报告 / 工作论文 / 讲义（合法公开的才下得到，付费墙/盗版站会直接失败跳过）
    if (/\.pdf($|[?#])/i.test(s.url) && pdfSaved < MAX_PDF && !docSeen(s.title)) {
      try {
        const buf = await gFetch(s.url, 25000, false);
        if (buf && buf.length > 500 && buf.length <= 12 * 1024 * 1024) {
          const base = (() => { try { return decodeURIComponent(s.url.split('?')[0].split('/').pop() || ''); } catch (e) { return ''; } })();
          const fname = (base && /\.pdf$/i.test(base) ? base : (String(s.title || 'report').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) + '.pdf'));
          const info = await require('./plugins/jdfile.js').ingestEbookBuffer(
            { id: goal.id }, buf, fname, '搜集时发现的公开 PDF 全文',
            st => onProgress({ status: `📄 ${st}` }), 0,
            '公开 PDF（' + siteLabel(siteOf(s.url) || '') + '）', '报告', { rejectGarbled: true });
          seenFinal.add(s.url);
          docMark(info.title); docMark(s.title);
          saved++; pdfSaved++;
          onProgress({ status: `📄 PDF 全文已入库：《${String(s.title).slice(0, 30)}》` });
          return;
        }
      } catch (e) { console.log('[collect] PDF 入库失败，回退普通抓取:', s.url.slice(0, 80), e.message); }
    }
    const page = await fetchPage(s.url, 3500);
    if (!page.text && /\.pdf($|[?#])/i.test(s.url)) { skipped++; return; }   // PDF 解析失败就不存空条目
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
/* 清洗抓取到的正文：去掉成片空行与多余空格（网络资料常带大量空白，直接截取会浪费额度） */
function cleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
/* 客户端断开（用户点了「停止」）时，用它把上游 AI 请求也一起终止 */
function clientSignal(req) {
  const ac = new AbortController();
  try { req.on('close', () => { try { ac.abort(); } catch (e) {} }); } catch (e) {}
  return ac.signal;
}
/* 资料提炼汇总（把全部资料交给 AI 提炼成多篇主题 MD，规划时优先依据） */
db.exec(`CREATE TABLE IF NOT EXISTS source_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  sources_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`);
function digestsOf(goalId) {
  return db.prepare('SELECT * FROM source_digests WHERE goal_id = ? ORDER BY id').all(goalId);
}
function sourcesOf(goalId) {
  // 用户自己提供的资料（图片 / 电子书…）排在最前，其次才是检索到的网络信息源
  return db.prepare("SELECT * FROM sources WHERE goal_id = ? ORDER BY quality DESC, CASE WHEN site = '用户提供的图片' OR site = '用户提供的电子书' OR site = '待找书单' OR kind = 'JD' THEN 0 ELSE 1 END, id").all(goalId);
}

/* ===== AI 规划 ===== */
/* ---------- 资料提炼：把全部资料分批喂给 AI，再汇总成多篇主题 MD ---------- */
function digestBatches(goal) {
  const all = sourcesOf(goal.id);
  const own = all.filter(x => x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料');
  const net = all.filter(x => !(x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'));
  // 用户自己提供的资料全文（最多 4000 字/条）；网络资料 900 字/条
  const ownCap = 6000, netCap = 3000;   // 用户提供的资料几乎读全文；网络资料 3000 字（覆盖绝大多数）
  const starred = all.filter(x => Number(x.quality) === 1);
  const items = starred.map(x => {
    const full = cleanText(x.content || x.snippet || '');
    return { label: `[★优质信息源｜${x.kind}] ${x.title}`, body: full.slice(0, 8000) + (full.length > 8000 ? `\n（本条共 ${full.length} 字，此处截取前 8000 字）` : '') };
  }).concat(own.map(x => {
    const full = cleanText(x.content || x.snippet || '');
    return { label: `[用户资料｜${x.kind}] ${x.title}`, body: full.slice(0, ownCap) + (full.length > ownCap ? `\n（本条共 ${full.length} 字，此处截取前 ${ownCap} 字）` : '') };
  })).concat(net.map(x => {
    const full = cleanText(x.content || x.snippet || '');
    return { label: `[${x.site}｜${x.kind}] ${x.title}`, body: full.slice(0, netCap) + (full.length > netCap ? `\n（本条共 ${full.length} 字，此处截取前 ${netCap} 字）` : '') };
  }));
  const batches = [];
  let cur = [], curLen = 0;
  const LIMIT = 16000;
  for (const it of items) {
    const len = it.label.length + it.body.length + 8;
    if (cur.length && curLen + len > LIMIT) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(it); curLen += len;
  }
  if (cur.length) batches.push(cur);
  return { batches, ownCount: own.length, netCount: net.length, total: items.length };
}
function digestBatchPrompt(batch, idx, total) {
  const lines = [];
  lines.push(`你是资料提炼助手。下面是用户目标的资料（第 ${idx}/${total} 批）。`);
  lines.push('请把其中**对目标规划有价值的信息完整提取出来，宁多勿漏**：');
  lines.push('- tech：技术栈、技能、框架、语言、工具（逐条列出，保留原文的具体名词与限定词）');
  lines.push('- hard：硬性条件（学历 / 年限 / 到岗天数 / 证书 / 前置知识 / 地点等）');
  lines.push('- duties：职责与工作内容、项目类型、业务方向');
  lines.push('- roadmap：学习路线、知识体系、章节模块与顺序');
  lines.push('- interview：面试重点、高频考点、面经结论');
  lines.push('- resources：书 / 课程 / 网站 / 工具 / 证书等具体资源名');
  lines.push('- timeline：时间节点、流程（投递 / 面试轮次 / 截止时间）');
  lines.push('- other：其它对规划有用的结论');
  lines.push('只输出一个 JSON 对象，键为上面这些英文名，值为字符串数组；不要遗漏具体名词。');
  lines.push('');
  lines.push('【资料开始】');
  for (const it of batch) { lines.push('## ' + it.label); lines.push(it.body); }
  lines.push('【资料结束】');
  return lines.join('\n');
}
function digestSynthesisPrompt(parts, meta) {
  const lines = [];
  lines.push('下面是同一目标的资料提炼结果（多批汇总，来自用户提供的图片资料与网络检索资料）。');
  lines.push(`共处理 ${meta.total} 条资料（用户自己提供 ${meta.ownCount} 条、网络检索 ${meta.netCount} 条）。`);
  lines.push('请整理成若干篇「主题汇总」Markdown 文档，用于指导后续的目标规划。');
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 按主题拆分（例如：岗位要求与技术栈 / 学习路线与知识体系 / 面试重点与高频考点 / 项目与作品 / 硬性条件与时间安排 / 资源与工具 …），篇数按内容多少决定（3-8 篇），不要硬凑。');
  lines.push('2. 内容要具体、可执行：保留具体技术名 / 工具名 / 公司 / 证书 / 书名 / 课程名；合并去重；对出现频次高的（更重要的）要求标注「高频」或按重要性排序。');
  lines.push('3. 技术栈那一篇要**逐项列全**，并标注每项在资料里体现的要求程度（必须掌握 / 加分项 / 了解即可）。');
  lines.push('4. 只输出一个 JSON 对象：{"digests":[{"topic":"主题","title":"标题","content_md":"# 标题\n\n正文…"}]}');
  lines.push('5. content_md 用 Markdown（列表 / 表格都行），每篇 400-1500 字，不要写空话。');
  lines.push('');
  lines.push('【各批提炼结果】');
  for (const p of parts) lines.push('### 第 ' + p.idx + ' 批\n' + JSON.stringify(p.data));
  return lines.join('\n');
}
/* 资源库整库导出：提炼汇总 + 全部资料（Markdown，便于分享） */
function buildLibraryMarkdown(goal) {
  const digests = digestsOf(goal.id);
  const all = sourcesOf(goal.id);
  const own = all.filter(x => x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料');
  const net = all.filter(x => !(x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'));
  const L = [];
  L.push('# 资源库：' + goal.title);
  L.push('');
  L.push('> 导出时间：' + nowISO() + '　·　资料 ' + all.length + ' 条（自己提供 ' + own.length + ' / 网络检索 ' + net.length + '）　·　提炼汇总 ' + digests.length + ' 篇');
  L.push('');
  if (digests.length) {
    L.push('## 一、提炼汇总（规划的主要依据）');
    L.push('');
    for (const d of digests) {
      L.push('### ' + (d.title || d.topic));
      L.push('');
      L.push(String(d.content || ''));
      L.push('');
      L.push('---');
      L.push('');
    }
  }
  const section = (title, list) => {
    if (!list.length) return;
    L.push('## ' + title);
    L.push('');
    for (const x of list) {
      L.push('### [' + x.kind + '] ' + x.title);
      L.push('');
      const meta = [];
      if (x.site) meta.push('来源：' + x.site);
      if (x.url) meta.push('链接：' + x.url);
      if (x.published_at) meta.push('时间：' + x.published_at);
      if (meta.length) { L.push('*' + meta.join('　·　') + '*'); L.push(''); }
      const full = cleanText(x.content || x.snippet || '（无正文）');
      const cap = (x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '导入的资料') ? 20000 : 4000;
      L.push(full.slice(0, cap) + (full.length > cap ? `\n\n> （本条共 ${full.length} 字，此处截取前 ${cap} 字）` : ''));
      L.push('');
      L.push('---');
      L.push('');
    }
  };
  section('二、你自己提供的资料（最高优先级）', own);
  section('三、网络检索资料', net);
  return L.join('\n');
}
function digestsBlock(goal) {
  const list = digestsOf(goal.id);
  if (!list.length) return '';
  const lines = ['', '【资料提炼汇总（已通读用户全部资料后整理，规划必须以此为主要依据，优先级高于下面的原始资料）】'];
  for (const d of list) {
    lines.push('');
    lines.push('### ' + (d.title || d.topic));
    lines.push(String(d.content || '').slice(0, 4000));
  }
  return lines.join('\n');
}
/* ---------- 节点级资料：每个节点有自己的资料，做节点级规划时只看这一份 ---------- */
/* 把 AI 写的依据名（可能带前缀/类型）匹配到资料库里的真实条目 */
function findSourceByRef(goalId, rawName) {
  const strip = t => String(t || '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^(用户自己提供的资料|用户提供的资料|用户资料|导入的资料)[｜|:：]?\s*/, '')
    .trim();
  const cands = [];
  const push = t => { const v = String(t || '').trim(); if (v.length >= 4 && !cands.includes(v)) cands.push(v); };
  push(rawName); push(strip(rawName));
  for (const c of cands.slice()) {
    const m = c.match(/^(JD|大纲|教材|笔记|表格|文章|资料)[：:]\s*(.+)$/);
    if (m) push(m[2]);
  }
  for (const c of cands) {
    for (const len of [24, 16, 12, 8]) {
      const key = c.slice(0, len);
      try {
        const hit = db.prepare('SELECT * FROM sources WHERE goal_id = ? AND title LIKE ? ORDER BY id LIMIT 1').get(goalId, '%' + key + '%');
        if (hit) return hit;
      } catch (e) {}
    }
  }
  return null;
}
function nodeSourceItems(goal, node) {
  let list = node && node.sources;
  if (typeof list === 'string') { try { list = JSON.parse(list) || []; } catch (e) { list = []; } }
  if (!Array.isArray(list)) list = [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    // 1) 明确关联到资料库某条（节点面板里选的）
    const sid = Number((it.source_id || it.id) || 0);
    if (sid) {
      const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(sid);
      if (src) { out.push({ label: `[${src.site}｜${src.kind}] ${src.title}`, body: String(src.content || src.snippet || '') }); continue; }
    }
    const name = String(it.name || it.title || '').trim();
    if (!name) continue;
    // 2) AI 写的依据：按标题在资料库里找对应正文（名字常带「用户提供的资料｜」这类前缀，逐级放宽匹配）
    const src = findSourceByRef(goal.id, name);
    if (src) out.push({ label: `[${src.site}｜${src.kind}] ${src.title}`, body: String(src.content || src.snippet || '') });
    else out.push({ label: name, body: String(it.note || '') });
  }
  /* 3) 文件夹资料源：自己 + 所有祖先挂的（子孙可见，同级/其它分支看不到）。
     每夹给文件清单 + README 摘要，细读留给教程阶段。目录没了只标出来，不报错。 */
  try {
    const nid = node && (node.id || node.node_id);
    if (nid && goal && goal.id) {
      for (const f of nodeFolders.collectFolderEntries(db, Number(nid))) {
        if (f.missing) { out.push({ label: `📁 文件夹｜${f.name}（目录已不在：${f.path}）`, body: String(f.note || '') }); continue; }
        out.push({
          label: `📁 文件夹｜${f.name}${f.inherited ? '（继承自「' + f.nodeTitle + '」）' : ''}`,
          body: nodeFolders.folderBodyForPrompt(f.path, 1200) + (f.note ? '\n说明：' + f.note : '')
        });
      }
    }
  } catch (e) { console.log('[node-folders] 规划提示词组装失败:', e.message); }
  return out;
}
function nodeSourcesBlock(goal, node, maxLen) {
  const items = nodeSourceItems(goal, node);
  if (!items.length) return '';
  const lines = ['', '【本节点对应的资料（只依据这些做本节点的规划/拆分/教程，不要去读其它节点的资料）】'];
  for (const it of items.slice(0, 12)) {
    const body = String(it.body || '').replace(/\s+/g, ' ').slice(0, maxLen || 900);
    lines.push('- ' + it.label + (body ? '：' + body : ''));
  }
  return lines.join('\n');
}
/* 其它资料的索引（只给标题，避免把全部正文塞进节点级提示词） */
function sourcesIndexBlock(goal, maxTitles, scopeNote) {
  const all = sourcesOf(goal.id);
  if (!all.length) return '';
  const lines = ['', scopeNote || '【资料库其它条目（仅索引，未展开正文；如本节点确实需要，可在资料标题里点明）】'];
  for (const x of all.slice(0, maxTitles || 20)) lines.push('- [' + x.site + '｜' + x.kind + '] ' + x.title);
  return lines.join('\n');
}
/* 对话助理的资料库清单：和「节点级规划」的视角不同 —— 用户常问「资料库里有没有 /
   能不能看到 XX」，所以「自己提供 + 导入的代码库」必须排前面完整列出（代码库的
   摘要正文就在条目里），不能按 id 截前 N 条把代码库挤没；网络资料只列标题，
   结论交给上面的提炼汇总。若非如此，资料一多，「导入的代码库」永远进不了提示词，
   助手就会答「资料库是空的 / 看不到源码」。 */
function chatSourcesBlock(goal) {
  const all = sourcesOf(goal.id);
  if (!all.length) return '';
  const isOwn = s => s.site === '用户提供的图片' || s.site === '用户提供的电子书' || s.site === '导入的资料' || s.site === '导入的代码库' || s.site === '待找书单';
  const own = all.filter(isOwn);
  const net = all.filter(s => !isOwn(s));
  const line = s => '- ' + (Number(s.quality) === 1 ? '★' : '') + '[' + s.site + '｜' + s.kind + '] ' + s.title
    + (String(s.url || '').startsWith('/') ? '（本机路径：' + s.url + '）' : '');
  const lines = ['', `【资料库清单（共 ${all.length} 条：自己提供 ${own.length} / 网络检索 ${net.length}）】`];
  for (const s of own.slice(0, 40)) lines.push(line(s));
  if (own.length > 40) lines.push('- …（其余 ' + (own.length - 40) + ' 条略）');
  if (net.length) {
    lines.push('');
    lines.push('【网络检索资料（仅列前 ' + Math.min(net.length, 20) + ' 条标题；完整结论见上面的提炼汇总）】');
    for (const s of net.slice(0, 20)) lines.push(line(s));
    if (net.length > 20) lines.push('- …（其余 ' + (net.length - 20) + ' 条略）');
  }
  return lines.join('\n');
}
/* 同级其它节点的标题：教程里点名排除，防止把别章节的知识点写进来 */
function siblingScopeBlock(goal, node) {
  let sibs = [];
  try {
    sibs = db.prepare('SELECT id, title FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0) AND id != ? ORDER BY sort_order, id LIMIT 12')
      .all(goal.id, node.parent_id || 0, node.id);
  } catch (e) { sibs = []; }
  sibs = sibs.map(s => String(s.title || '').trim().slice(0, 40)).filter(Boolean);
  const lines = [];
  lines.push('');
  lines.push('【本节范围（必须遵守，否则视为不合格）】');
  lines.push('1. 只写与上面【教程主题】直接相关的知识点；其它章节的内容一律不写、不展开、不举例——即使下面的背景资料里提到，也不行。');
  lines.push('2. 可以一句话点名前置知识（如“需要先懂变量”），但不展开讲解。');
  lines.push('3. 例外：只有【用户的额外要求】明确点名要加别的内容时，才允许超出本节范围。');
  if (sibs.length) {
    lines.push('4. 别的章节排除清单（出现以下任一主题的成段讲解即不合格）：' + sibs.map(t => '「' + t + '」').join('、'));
  }
  return lines.join('\n');
}
function sourcesBlock(goal, maxItems, maxLen) {
  const all = sourcesOf(goal.id);
  if (!all.length) return '\n【注意】本次没有检索到网络信息源，请仅依据公开公认的岗位要求与学习路径规划，并在 sources 中注明依据，不确定处标注「待核实」。';
  // 用户自己提供的图片资料（JD / 大纲 / 笔记…）是最高优先级的一手信息
  const starred = all.filter(s => Number(s.quality) === 1);
  const own = all.filter(s => Number(s.quality) !== 1 && (s.site === '用户提供的图片' || s.site === '导入的资料'));
  const net = all.filter(s => Number(s.quality) !== 1 && !(s.site === '用户提供的图片' || s.site === '导入的资料'));
  const fmt = (s, len) => {
    const full = cleanText(s.content || s.snippet || '');
    const body = full.replace(/\n+/g, ' ').slice(0, len);
    return `- [${s.site}｜${s.kind}] ${s.title}${body ? '：' + body + (full.length > len ? '…' : '') : ''}`;
  };
  const lines = [''];
    lines.push(`（说明：本目标共收集 ${all.length} 条资料——其中优质信息源 ${starred.length} 条、用户自己提供 ${own.length} 条、网络检索 ${net.length} 条；下面是与你目标最相关的部分，其余资料的结论已由「提炼汇总」概括。）`);
  if (starred.length) {
    lines.push('【★优质信息源（用户亲自标注，最高优先级——规划必须重点依据）】');
    lines.push('要求：① 这些是用户认可的高质量参考，知识体系 / 技术栈 / 学习顺序要优先对齐它们；');
    lines.push('   ② 在 sources 中引用时写明「优质信息源：<标题>」；③ 与其它资料冲突时以优质信息源为准。');
    for (const s of starred.slice(0, 20)) lines.push('★ ' + fmt(s, Math.max(maxLen, 700)).replace(/^- /, ''));
  }
  if (own.length) {
    lines.push('【用户自己提供的资料（★最高优先级：用户真实场景的一手信息，必须严格依据）】');
    lines.push('要求：① 其中的硬性条件（学历 / 到岗天数 / 技能要求 / 时间节点 / 知识范围等）必须原样满足，不得忽略或改写；');
    lines.push('② 规划要与这些资料高度对齐：按真实 JD 的要求与优先级安排重点，按大纲/笔记的章节顺序组织学习路径；');
    lines.push('③ 若下面的网络信息源与用户资料冲突，一律以用户资料为准，并可在说明中指出差异；');
    lines.push('④ 在 sources 中标注这些资料时写明「用户提供的资料」；');
    lines.push('⑤ 用户有多份同类资料（如多份 JD）时，请横向归纳「共同要求」（出现频次高的技能/条件优先安排），再兼顾各自特殊点。');
    // 用户资料给足篇幅：每条最多 450 字（关键字段已在正文最前面），最多 24 条
    for (const s of own.slice(0, 30)) lines.push(fmt(s, Math.max(maxLen, 600)));
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
  lines.push('你是资深的学习与成长路径规划师。规划前要先做一份**规划前问卷**，摸清用户的真实情况与真实水平。');
  lines.push('问卷质量直接决定规划是否贴合用户 —— 宁可多问，也不要凭假设规划。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(digestsBlock(goal));
  lines.push(sourcesBlock(goal, 30, 180));
  lines.push('');
  lines.push('【最重要的一步：先判断这是什么类型的目标，再照它出题】');
  lines.push('**不要默认用户在求职找工作。**先看目标本身属于哪一类，只问这一类真正需要知道的：');
  lines.push('  · 求职 / 转行：才问目标岗位细分、目标公司或城市、投递节奏；');
  lines.push('  · 读懂某个项目 / 代码库的源码（如「搞懂我这个项目的源码」）：问清他现在这门语言/框架的基础、');
  lines.push('    有没有翻过这个库、想读到什么程度（能改 bug / 能独立加功能 / 只为能讲清楚）、手上有没有别的资料；');
  lines.push('    这一类的核心资料就是代码库本身，**不要问去哪找工作、也不要让他去搜 JD/面经**；');
  lines.push('  · 学一门技能 / 考证 / 考研：问基础、目标分数或等级、手上已有的教材与课程；');
  lines.push('  · 认知 / 通识 / 兴趣（如「理解经济怎么运转」）：问已有的认知起点、最想搞清的困惑；');
  lines.push('  · 做产品 / 副业 / 习惯养成：问现状、可用时间、怎么算做成。');
  lines.push('凡是与这个目标无关的板块，**直接不要出题**（比如"读懂自己的项目源码"就不该问目标公司、城市、薪资、投递时间）。');
  lines.push('');
  lines.push('【问卷要求】生成 8-14 道题，按下面组织（每题带 section 字段）：');
  lines.push('  1. 现状与目标（**按目标类型定制**）：为什么想做这件事、想达成的具体结果（要能验收）、这次的范围边界（不做什么）；');
  lines.push('  2. 真实水平（重点）：让用户用「可验证的证据」而非感觉来描述，例如能独立完成过什么、做过什么项目/练习、学到哪一章、上次动手是什么时候、卡在哪一步；');
  lines.push('  3. 水平自测（必出 2-3 题）：针对这个目标**真正绕不开的基础**出客观小测题（type=quiz）——给出 4 个选项、1 个正确答案（answer 填选项的 v）与一句解析（explain）。题目要能区分「完全不会 / 一知半解 / 已掌握」，用来校准规划起点（例如看代码说输出、概念辨析、命令/语法判断）；');
  lines.push('  4. 时间与节奏：每周可投入小时数、可学习的时间段、单次可专注时长、期限是否硬性、能接受的总周期；');
  lines.push('  5. 偏好与资源：学习方式偏好（视频/文档/动手做）、英语阅读能力、**手上已经有什么资料/环境/工具**；');
  lines.push('  6. 风险与心态：最容易卡住或放弃的环节、过往失败的经历、最担心的事、需要什么样的反馈与督促。');
  lines.push('  7. 资料搜集（必出 1 题，id 固定为 q_collect）：问这次**要不要让 AI 去网上搜集外部资料**。');
  lines.push('     type=single，选项的 v 固定为这三个：');
  lines.push('       v=yes   「要 —— 让 AI 按目标去网上找真实资料」');
  lines.push('       v=no    「不用 —— 我有自己的资料（项目源码 / 教材 / 内部文档），或只靠这个目标本身」');
  lines.push('       v=later 「先不用，需要时再说」');
  lines.push('     desc 写清：选「不用」也不会影响规划，AI 会直接依据目标与你的回答来排。');
  lines.push('  8. 电子书（**只在目标确实涉及读书 / 系统学习时才出**，id 固定为 q_ebook_want）：问要不要顺带找电子书（single，v 固定为 auto/list/no：auto=公版书自动下载入库，list=只要书单自己找，no=不需要）。');
  lines.push('     如果这个目标的一手资料是代码库、项目、内部文档或已有教材，**就不要出这一题**。');
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
  if (!goalCompOn(goal && goal.id, 'constraints')) return '';
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
/* 某个阶段的小目标偏少时，按知识点补足 */
function buildStageGoalsPrompt(goal, stage) {
  const lines = [];
  lines.push('你是资深职业路径规划师。下面这个「阶段」的小目标太少，没有覆盖它要掌握的知识点。');
  lines.push('请把它的小目标补足：**阶段说明里提到的每个知识点 / 技术点 / 能力项都要有独立的小目标**（一个知识点一个，不要合并）。');
  lines.push('要求：① 保留原有小目标（措辞可微调）；② 补齐缺失的；③ 小目标要能独立验收、能力或成果导向；');
  lines.push('④ 一般 5-10 个，知识点多可到 16 个；⑤ 每个小目标给 1-3 条 sources 依据（name 写来源，note 写依据）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(digestsBlock(goal));
  lines.push(sourcesBlock(goal, 40, 200));
  lines.push('');
  lines.push('【当前阶段】' + String(stage.title || ''));
  lines.push('阶段说明：' + String(stage.detail || ''));
  lines.push('【当前的小目标（太少）】');
  (stage.goals || []).forEach((g, i) => lines.push(`${i + 1}. ${g.title}${g.detail ? '（' + g.detail + '）' : ''}`));
  lines.push('');
  lines.push('只输出一个 JSON 对象：{"goals":[{"title":"小目标","detail":"60-120字说明","sources":[{"name":"","note":""}]}]}');
  return lines.join('\n');
}
async function expandThinStages(goal, skeleton, model, send, sig) {
  const stages = (skeleton && skeleton.stages) || [];
  const need = [];
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const goals = Array.isArray(st.goals) ? st.goals : [];
    const text = String(st.title || '') + ' ' + String(st.detail || '');
    const marks = (text.match(/[、,，/；;]/g) || []).length;   // 阶段说明里列了几项
    // 小目标偏少、且说明里明显列了多个知识点 → 需要补足
    if (goals.length < 5 && marks >= 2) need.push(i);
  }
  if (!need.length) return skeleton;
  send({ status: `有 ${need.length} 个阶段的小目标偏少，正在按知识点补足…` });
  for (const i of need) {
    if (sig && sig.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; }
    const st = stages[i];
    send({ status: `补足第 ${i + 1}/${stages.length} 个阶段：${String(st.title || '').slice(0, 20)}…` });
    try {
      const before = (st.goals || []).length;
      const txt = await aiTextProgress(buildStageGoalsPrompt(goal, st), model, 300000, send, '小目标', sig);
      const data = extractJSON(txt);
      const list = Array.isArray(data && data.goals) ? data.goals : (Array.isArray(data) ? data : []);
      const clean = list.filter(x => x && String(x.title || '').trim()).slice(0, 18);
      if (clean.length > before) {
        st.goals = clean;
        console.log('[plan] 阶段补足:', String(st.title).slice(0, 20), before, '→', clean.length, '个小目标');
      }
    } catch (e) {
      if (e && e.cancelled) throw e;
      console.log('[plan] 阶段补足失败（忽略）:', e.message);
    }
  }
  return skeleton;
}
function buildSkeletonPrompt(goal) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。请为目标设计「路径骨架」：只规划 阶段 与 小目标（具体任务稍后单独细化）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(digestsBlock(goal));
  lines.push(sourcesBlock(goal, 60, 200));
  lines.push(askBlock(round, '路径骨架'));
  lines.push('');
  lines.push('【要求】');
  lines.push('0. 【最重要】起点必须严格匹配问卷反映的真实水平：自测答对/自述已掌握的内容不要重复安排基础内容；自测答错或自述薄弱的环节必须补足基础。节奏要贴合用户每周可投入时间与期限。');
  lines.push('1. 【覆盖度优先】先在心里列出资料里出现的**全部技术栈 / 能力项**（含硬性条件），再确保每一项都能落到某个阶段或小目标上；');
  lines.push('   **宁可多一个阶段，也不要为了「阶段少」而省去内容**（阶段上限放宽到 12 个）。');
  lines.push('2. 阶段数量按目标规模与期限自行判断，不要凑数也不要硬挤：');
  lines.push('   · 小而聚焦的目标（单一技能、1 个月内）：3-4 个阶段；');
  lines.push('   · 中等目标（求职转型、3-6 个月）：5-6 个阶段；');
  lines.push('   · 跨度大 / 多线并行（补基础 + 做项目 + 求职 + 长期习惯）：6-9 个阶段，资料要求多时最多 12 个；');
  lines.push('   · 从当前起点按能力/成果递进，最后一个阶段必须是「求职落地 / 投递面试 / 成果验收」这类收口阶段；');
  lines.push('   · 判断标准：每个阶段应是「一个能独立验收的能力台阶」，太大就拆、太小就合并。');
  lines.push('3. 【小目标数量必须按需决定，不要所有阶段都给同样数量】写每个阶段之前，先做这一步：');
  lines.push('   · 列出该阶段要覆盖的知识点 / 技术点 / 能力项（可参考提炼汇总里的技术栈篇与用户资料），记下个数 N；');
  lines.push('   · 小目标数量 ≈ N（一个知识点至少一个小目标，**不要合并**）；每个阶段一般 5-10 个，知识点多的阶段可到 16 个；');
  lines.push('   · 反面示例（不要这样）：每个阶段都只给 4 个、把「Python 语法 + 数据结构 + 算法 + 工程规范」挤进一个目标里；');
  lines.push('   · 小目标要「能独立验收」、能力或成果导向（如「掌握 X 并完成 Y 练习」「能用 Z 做出 W」）；');
  lines.push('   · 【自检】输出前逐条核对：本阶段涉及的每个技术点/知识点，是否都能找到对应的小目标？没有就补。');
  lines.push('4. 每个节点 detail 写 60-120 字：说明要达成什么、为什么这样安排。');
  lines.push('5. 每个节点都要给 sources 依据：**阶段给 3-5 条、小目标给 1-3 条**（不要空着）；name 写明实际来源（站点名+标题要点，用户资料写「用户提供的资料」），note 写依据了什么要求/结论。');
  lines.push('   优先引用：① 用户提供的资料 ② 提炼汇总里的结论 ③ 下面列出的资料；不同阶段尽量引用与它最相关的不同资料，让依据分布开来。');
  lines.push('6. 路径必须匹配用户现状（零基础从基础开始，有基础则跳过）；顺序体现「真实工作中最看重什么」。');
  lines.push('7. 只输出一个 JSON 对象（不要其他文字或代码块标记），量控制在 28000 字符内（内容多时 detail 可精简到 40-80 字，但小目标不要省）：');
  lines.push('8. 若按上面的「关键机制」需要先提问，则只输出 {"analysis":"你的分析","questions":[...]}，不要输出 stages。');
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
  lines.push(digestsBlock(goal));
  lines.push(nodeSourcesBlock(goal, stage, 1000));
  lines.push(sourcesIndexBlock(goal, 16));
  lines.push(askBlock(round, '本阶段任务细化'));
  lines.push('');
  lines.push(`【当前阶段】第 ${stageIndex + 1} 阶段：${stage.title}`);
  lines.push('阶段说明：' + (stage.detail || ''));
  lines.push('【本阶段小目标】');
  (stage.goals || []).forEach((g, i) => lines.push(`${i}. ${g.title}${g.detail ? '（' + g.detail + '）' : ''}`));
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 为每个小目标产出 2-3 个任务，按执行顺序排列，每个任务能在一周内完成。');
  lines.push('   【数量】每个小目标 2-3 个任务；本阶段合计不超过 14 个（内容特别多的阶段最多 18 个）。既要覆盖到该阶段的每个知识点，也别拆得过碎——让用户觉得「做得完」。');
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
/* 本节点的教程（用户已生成或手动导入）：拆分/调整时重点参考，可按教程章节规划子任务 */
function nodeTutorialBlock(node) {
  let list = [];
  try { list = db.prepare('SELECT id, title, format, content FROM tutorials WHERE node_id = ? ORDER BY id').all(node.id); } catch (e) {}
  if (!list.length) return '';
  const lines = ['', '【本节点的教程（重点参考：用户已有的学习教程）】'];
  lines.push('要求：若用户要求"依据教程规划子任务"，以教程的章节/知识点为主线拆分，确保每个重要知识点都有对应的子任务；任务 detail 可引用教程中的关键做法。');
  for (const t of list.slice(0, 2)) {
    lines.push('');
    lines.push('### 教程：' + String(t.title || '').slice(0, 80));
    lines.push(cleanText(String(t.content || '')).replace(/\n+/g, ' ').slice(0, 6000));
  }
  return lines.join('\n');
}
function buildExpandPrompt(goal, node, sources, folderCode) {
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
  lines.push(digestsBlock(goal));
  lines.push(nodeSourcesBlock(goal, node, 1100));
  if (folderCode) {
    lines.push('');
    lines.push('【挂载文件夹的源码节选（只读讲解依据，不要复述整段代码）】');
    lines.push(String(folderCode).slice(0, 15000));
  }
  lines.push(nodeTutorialBlock(node));
  lines.push(sourcesIndexBlock(goal, 16));
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
  lines.push('6. 如果上面给了挂载文件夹的源码节选：拆分必须沿代码的真实模块/目录结构走（每个子任务对应到具体的包、文件或组件），不要拍脑袋编阶段；detail 里点出要读哪几个文件。');
  return lines.join('\n');
}
/* 按用户意见修改已有教程 */
function buildTutorialEditPrompt(goal, node, tut, feedback, format, codeBlock) {
  const lines = [];
  lines.push('你是耐心、严谨的技术导师。用户对**已生成的教程**提出了修改意见，请按要求改好它。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(constraintsBlock(goal));
  lines.push('');
  lines.push('【教程主题】' + String(tut.title || (node && node.title) || ''));
  if (node && node.detail) lines.push('任务说明：' + node.detail);
  lines.push('');
  lines.push('【用户的修改意见（必须全部满足）】' + String(feedback || '').slice(0, 1500));
  lines.push('');
  lines.push('【修改要求】');
  lines.push('1. 在**保留原有优质内容**的基础上，按用户意见修改（增删改均可）；不要无故删掉原有章节；');
  lines.push('2. 保持原有格式与结构风格，篇幅可增可减，但要保证「能照着学会」；');
  lines.push('3. 直接输出修改后的完整教程正文（' + (format === 'md' ? 'Markdown' : 'HTML') + '），不要任何解释或前后缀。');
  lines.push('4. 范围顺手清理：如果正文里混入了与【教程主题】无关的其它章节的成段内容，且用户意见没有要求保留，可顺手删减；不要新增超出主题的新章节。');
  lines.push('');
  lines.push('【原教程正文】');
  lines.push(String(tut.content || '').slice(0, 30000));
  if (codeBlock) { lines.push(''); lines.push(codeBlock); }
  return lines.join('\n');
}
function buildTutorialPrompt(goal, node, format, note, codeBlock) {
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
  lines.push(siblingScopeBlock(goal, node));
  lines.push(digestsBlock(goal));
  lines.push(nodeSourcesBlock(goal, node, 1100));
  lines.push(sourcesIndexBlock(goal, 12, '【资料库其它条目（仅索引；与本节无关的一律不读不用，更不要写入教程）】'));
  if (codeBlock) { lines.push(''); lines.push(codeBlock); }
  if (note) { lines.push(''); lines.push('【用户的额外要求（必须满足）】' + note); }
  lines.push('');
  lines.push('【范围重申】动笔前先对照排除清单自查：教程里只能出现本节的知识点；其它章节成段出现即不合格，直接删掉重写该部分。');
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
    /* 血泪换来的三条：①模型爱在文档前加一句前言导致顶部挂废话；
       ②页内 JS 被沙箱拦过，现在放开了，必须约法三章；
       ③被要求做 PPT 时容易跑题去讲"怎么做幻灯片"。 */
    lines.push('【HTML 附加铁律】第一行必须是 <!DOCTYPE html>，前面一个字都不能多；第一屏必须是本节标题和本节内容，不许写成其它主题。');
    lines.push('【页内脚本约法三章】只许操作本页 DOM（翻页、折叠、动画、高亮）；禁止 fetch/XHR、localStorage、Cookie、top 跳转、新窗口弹窗。违反即不合格。');
  } else {
    lines.push('【输出格式】只输出 Markdown 正文（# 一级标题开始）。不要用 ``` 包裹整篇内容，不要输出任何额外说明文字。代码块、表格、清单、引用都要用标准 Markdown 语法。');
  }
  return lines.join('\n');
}
function buildRefineNodePrompt(goal, node, kids, feedback, folderCode) {
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
  lines.push(digestsBlock(goal));
  lines.push(nodeSourcesBlock(goal, node, 1000));
  if (folderCode) {
    lines.push('');
    lines.push('【挂载文件夹的源码节选（只读讲解依据，不要复述整段代码）】');
    lines.push(String(folderCode).slice(0, 15000));
  }
  lines.push(nodeTutorialBlock(node));
  lines.push(sourcesIndexBlock(goal, 12));
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
/* 教程改前存档：把当前正文存一份版本，超 10 版删最旧的。
   调用方保证：只在“真的要覆盖”之前调；reason 说明这次为什么存。 */
function saveTutorialVersion(tid, reason) {
  const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(Number(tid));
  if (!t || !t.content) return 0;
  const r = db.prepare('INSERT INTO tutorial_versions (tutorial_id, content, reason, created_at) VALUES (?,?,?,?)')
    .run(t.id, String(t.content), String(reason || '').slice(0, 120), nowISO());
  db.prepare('DELETE FROM tutorial_versions WHERE tutorial_id = ? AND id NOT IN (SELECT id FROM tutorial_versions WHERE tutorial_id = ? ORDER BY id DESC LIMIT 10)')
    .run(t.id, t.id);
  return Number(r.lastInsertRowid);
}
function beginVersion(goalId, reason) {
  if (!goalCompOn(goalId, 'versions')) return 0;
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
  if (!vid || !goalCompOn(goal && goal.id, 'versions')) return '';
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
/* 字段名兜底：模型偶尔把 title 写成 name（阶段名 / 小目标名都遇到过）。
   真实翻过：整份骨架的阶段全用 name，规范化只认 title → 全被过滤掉，
   最后报"没有可用阶段"，用户白等一场。这里统一取 title || name。 */
const titleOf = o => String((o && (o.title != null ? o.title : o.name)) || '').trim();
function normalizeSkeleton(stages) {
  const out = [];
  let pending = null;
  for (const raw of (Array.isArray(stages) ? stages : [])) {
    if (!raw || typeof raw !== 'object') continue;
    const title = titleOf(raw);
    const goals = (Array.isArray(raw.goals) ? raw.goals : []).filter(g => g && titleOf(g))
      .map(g => (g.title ? g : Object.assign({}, g, { title: titleOf(g) })));
    if (title && !goals.length) { pending = { title, detail: raw.detail || '', sources: raw.sources || [] }; continue; }
    if (!title && goals.length) {
      const last = out[out.length - 1];
      if (last && !last.goals.length) {           // 上一个阶段还空着，直接补进去
        last.goals = goals.slice(0, 20);
        if (!last.detail && raw.detail) last.detail = raw.detail;
      } else {
        const base = pending || { title: '', detail: '', sources: [] };
        out.push({ title: base.title, detail: base.detail || raw.detail || '', sources: base.sources || raw.sources || [], goals: goals.slice(0, 20) });
      }
      pending = null;
      continue;
    }
    if (title && goals.length) {
      out.push({ title, detail: raw.detail || '', sources: raw.sources || [], goals: goals.slice(0, 20) });
      pending = null;
      continue;
    }
  }
  if (pending && out.length) {   // 结尾多出来的标题：把它的说明补进上一个阶段
    const last = out[out.length - 1];
    if (!last.detail && pending.detail) last.detail = pending.detail;
  }
  return out.filter(s => s.title && s.goals.length).slice(0, 14);
}
function saveSkeleton(goalId, plan) {
  const stages = normalizeSkeleton(plan.stages);
  if (!stages.length) throw new Error('骨架结构异常（没有可用阶段），请重试');
  const old = db.prepare('SELECT id FROM nodes WHERE goal_id = ?').all(goalId).map(x => x.id);
  for (const id of old) db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM node_workspaces WHERE goal_id = ?').run(goalId); } catch (e) {}
  const summary = String(plan.summary || '').slice(0, 800);
  // 骨架已定：旧问卷作废（clarify 答案保留在 clarify_answers 里），避免目标页 sticky 显示过期问卷
  db.prepare("UPDATE goals SET summary = ?, status = ?, error = ?, clarify = '', clarify_stage = '', updated_at = ? WHERE id = ?").run(summary, 'planning', '', nowISO(), goalId);
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
      /* 「要不要搜集外部资料」是必问的开关：AI 漏了就补固定版（id 固定，前后端都认）。
         以前这里硬塞的是「要不要找电子书」两题 —— 对"读懂自己项目源码"这类目标纯属添乱，
         而且电子书需求本来就属于"收集信息源"那一步（收集面板里会问，见 /ebooks/pref），
         目标类型不对时不该被问。 */
      if (!data.questions.some(q => q && String(q.id || '') === 'q_collect')) {
        data.questions.push({
          id: 'q_collect', section: '资料搜集', type: 'single',
          title: '这次要不要让 AI 去网上搜集外部资料？',
          desc: '选「不用」也不影响规划：AI 会直接依据目标与你的回答来排',
          options: [
            { v: 'yes', label: '要 —— 让 AI 按目标去网上找真实资料' },
            { v: 'no', label: '不用 —— 我有自己的资料（项目源码 / 教材 / 内部文档），或只靠这个目标本身' },
            { v: 'later', label: '先不用，需要时再说' }
          ]
        });
      }
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
/* ---------- 规划草稿：骨架失败时保留 AI 的原始构思，支持断点继续 ----------
   出错（解析失败 / 规范化后无可用阶段）就把原始输出落盘，而不是扔掉；
   用户点「继续构思」时把原文喂回去，让模型按正确格式整理一遍。 */
function savePlanDraft(goalId, kind, content, meta) {
  const t = nowISO();
  const m = JSON.stringify(Object.assign({ attempts: 0 }, meta || {}));
  db.prepare(`INSERT INTO plan_drafts (goal_id, kind, content, meta, created_at, updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(goal_id, kind) DO UPDATE SET content = excluded.content, meta = excluded.meta, updated_at = excluded.updated_at`)
    .run(goalId, kind || 'skeleton', String(content || '').slice(0, 60000), m, t, t);
}
function getPlanDraft(goalId, kind) {
  try { return db.prepare('SELECT * FROM plan_drafts WHERE goal_id = ? AND kind = ?').get(goalId, kind || 'skeleton') || null; }
  catch (e) { return null; }
}
function clearPlanDraft(goalId, kind) {
  try { db.prepare('DELETE FROM plan_drafts WHERE goal_id = ? AND kind = ?').run(goalId, kind || 'skeleton'); } catch (e) {}
}
function draftInfo(d) {
  if (!d) return null;
  let meta = {};
  try { meta = JSON.parse(d.meta || '{}'); } catch (e) {}
  return {
    kind: d.kind, attempts: meta.attempts || 0,
    rawLen: String(d.content || '').length, updated_at: d.updated_at,
    preview: String(d.content || '').replace(/\s+/g, ' ').slice(0, 200)
  };
}
function buildSkeletonRepairPrompt(goal, rawText) {
  const lines = [];
  lines.push('你是资深职业路径规划师。下面是你刚才为同一目标做的规划构思（思路和内容是好的，但格式不符合要求，不要丢掉任何实质内容）：');
  lines.push('');
  lines.push(String(rawText || '').slice(0, 20000));
  lines.push('');
  lines.push('【任务】把上面的构思整理成标准 JSON，只输出 JSON 对象，不要任何解释、前后缀或代码块标记：');
  lines.push('{"stages":[{"title":"阶段名","detail":"60-120字说明","sources":[{"name":"来源","note":"依据要点"}],"goals":[{"title":"小目标名","detail":"60-120字","sources":[{"name":"","note":""}]}]}]}');
  lines.push('要求：阶段 3-12 个；每个阶段的小目标按知识点数量决定（一般 5-10 个，多的可到 16 个，一个知识点至少一个）；阶段 3-5 条依据、小目标 1-3 条；detail 可精简到 40-80 字。');
  return lines.join('\n');
}
function streamPlan(req, res, goal, answers) {
  // 第一步：只生成骨架（阶段 + 小目标），等待用户确认（会带上澄清问答）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      clearPlanDraft(goal.id, 'skeleton');   // 全新规划：旧草稿作废，失败时会写入新的
      const pend = goalPending(goal.id);
      if (answers && pend) appendGoalQa(goal.id, pend.stage, pend.data.questions, answers);
      /* 问卷里那题「要不要搜集外部资料」的答案落到 goals.collect_pref：
         目标页据此决定是"催你去收集"还是"安静地跳过"，别再默认人人都要搜集。 */
      if (answers && answers.q_collect) {
        const v = String(answers.q_collect).toLowerCase();
        if (['yes', 'no', 'later'].includes(v)) db.prepare('UPDATE goals SET collect_pref = ? WHERE id = ?').run(v, goal.id);
      }
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
        skeletonText = await aiTextProgress(planPrompt + '\n\n【重要】你上一次的输出不是合法 JSON（可能被截断或夹带了说明文字）。请严格只输出一个 JSON 对象，不要任何解释、不要代码块标记；阶段数量按目标规模决定（3-12 个，不要凑数）；**小目标数量按该阶段要覆盖的知识点决定（一个知识点至少一个，一般 5-10 个，多的可到 16 个）**，不要所有阶段都只给 4 个；detail 可精简到 60 字以内。', model, 600000, send, '阶段/小目标', sig);
        skeleton = extractJSON(skeletonText);
        if (skeleton && Array.isArray(skeleton.questions) && skeleton.questions.length) {
          saveGoalQuestions(goal.id, 'plan', skeleton);
          send({ questions: { analysis: skeleton.analysis || '', questions: skeleton.questions }, stage: 'plan', goal: getGoal(goal.id) });
          res.end();
          return;
        }
        if (!skeleton || !Array.isArray(skeleton.stages) || !skeleton.stages.length) {
          console.log('[plan] 重试后仍解析失败，原始输出前 400 字:', String(skeletonText || '').slice(0, 400).replace(/\n/g, ' '));
          savePlanDraft(goal.id, 'skeleton', skeletonText, { attempts: 2, error: 'parse' });
          throw new Error('骨架生成失败（模型返回内容不完整），原始构思已保留：点「继续构思」接着来，不用从头再想；若反复失败可在设置里换一个模型');
        }
      }
      if (!normalizeSkeleton(skeleton.stages).length) {
        // 能解析、但阶段全被规范化过滤（缺 title/goals）：同样保留原文，可继续
        savePlanDraft(goal.id, 'skeleton', skeletonText, { attempts: 2, error: 'empty-stages' });
        console.log('[plan] 阶段被规范化过滤光，原始输出前 400 字:', String(skeletonText || '').slice(0, 400).replace(/\n/g, ' '));
        throw new Error('AI 的构思不符合格式要求（没有可用阶段），原始构思已保留：点「继续构思」让 AI 按正确格式整理，不用从头再想');
      }
      // 小目标偏少的阶段自动补足（按知识点拆细），保证覆盖度
      skeleton = await expandThinStages(goal, skeleton, model, send, sig);
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
        send({ error: e.message, resume: draftInfo(getPlanDraft(goal.id, 'skeleton')) });
      }
    }
    res.end();
  })();
}
/* 断点继续：把上次失败保留的原始构思喂回去，让模型按正确格式整理，然后走正常保存流程 */
function streamPlanResume(req, res, goal) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    const sig = clientSignal(req);
  (async () => {
    try {
      const draft = getPlanDraft(goal.id, 'skeleton');
      if (!draft || !String(draft.content || '').trim()) throw new Error('没有可继续的构思，请重新规划');
      let meta = {};
      try { meta = JSON.parse(draft.meta || '{}'); } catch (e) {}
      const attempts = (meta.attempts || 0) + 1;
      send({ status: `正在接着上次的构思继续（第 ${attempts} 次整理，原构思 ${String(draft.content).length} 字已保留）…` });
      const txt = await aiTextProgress(buildSkeletonRepairPrompt(goal, draft.content), model, 600000, send, '阶段/小目标', sig);
      const skeleton = extractJSON(txt);
      if (!skeleton || !normalizeSkeleton(skeleton.stages || []).length) {
        savePlanDraft(goal.id, 'skeleton', txt, { attempts, error: 'empty-stages' });
        console.log('[plan-resume] 仍无可用阶段，原始输出前 400 字:', String(txt || '').slice(0, 400).replace(/\n/g, ' '));
        throw new Error(attempts >= 3
          ? '多次整理仍无可用阶段：建议换一个模型再试，或点“重新规划”从头来'
          : '整理后仍无可用阶段（已更新保留的构思）：可再点「继续构思」换种说法重试');
      }
      const fixed = Object.assign({}, skeleton, { stages: normalizeSkeleton(skeleton.stages) });
      const grown = await expandThinStages(goal, fixed, model, send, sig);
      const vid = beginVersion(goal.id, '继续构思生成骨架');
      saveSkeleton(goal.id, grown);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '继续构思生成骨架');
      backup();
      clearPlanDraft(goal.id, 'skeleton');
      send({ done: true, stages: grown.stages.length, goal: getGoal(goal.id), report, versionId: vid });
    } catch (e) {
      if (e && e.cancelled) {
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(goal.id).c;
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'review' : 'todo', '', nowISO(), goal.id);
        send({ cancelled: true, status: '已停止（构思还在，可随时继续）', goal: getGoal(goal.id) });
      } else {
        db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', e.message, nowISO(), goal.id);
        send({ error: e.message, resume: draftInfo(getPlanDraft(goal.id, 'skeleton')) });
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
  lines.push(digestsBlock(goal));
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
  lines.push('   · 用户说某个阶段「小目标太少 / 没覆盖到 X」时：直接给该阶段补足小目标（一个知识点一个，必要时可到 16 个），不要只做表面微调。');
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
    lines.push('你是用户的「目标助理」：不只可以改路线图，还能操作这个目标下的所有可操作信息——管理信息源（添加/删除）、触发信息提炼与信息源收集、修改目标信息（现状/时间/期限/参考资料）、添加规划约束。');
  lines.push('用户让你做这些事时，直接通过下面的 ops 执行，不要只说"你可以去某某页面点一下"。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  const dgBlock = digestsBlock(goal);
  if (dgBlock) lines.push(dgBlock);
  const srcBlock = chatSourcesBlock(goal);
  if (srcBlock) lines.push(srcBlock);
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
  lines.push('0. 不要使用任何工具（不要读取文件、不要执行命令、不要联网）；规划与资料库的全部信息都在本提示里，直接基于它作答。');
  lines.push('   用户问「资料库里有没有 / 能不能看到 XX（如某个代码库）」时，依据上面【资料库清单】与【资料提炼汇总】如实回答：site=导入的代码库 的条目，就是该代码库已被通读后产出的摘要（含它是什么、目录结构、怎么读），不要说资料库是空的；但你不能逐文件实时读取本机目录，需要更细的内容时，请用户把关键文件发来存进资料库。');
    lines.push('1. 判断用户意图：只是咨询/提问 → 直接回答，不要修改；要求修改路线图 / 管理资料 / 改目标信息 → 执行对应 ops。');
  lines.push('   用户口述或粘贴了一段资料（JD、笔记、经验）想留档 → 用 add_source 存进资料库；只是想让你参考着改规划 → 不用存。');
  lines.push('2. 输出格式（必须严格遵守，便于界面实时渲染）：');
  lines.push('   先用 Markdown 写回复正文（可以分点、用列表、粗体、代码块，讲清你做了什么、为什么，以及建议；默认控制在 400 字以内，除非用户要求详细说明）；');
  lines.push('   然后在正文最后附一个 ops 代码块（JSON 数组，即你要执行的修改操作）：');
  lines.push('   ```ops');
  lines.push('   [{"op":"add","parent_id":123,"title":"..."}]');
  lines.push('   ```');
  lines.push('   - 如果不需要修改路线图，ops 代码块里写 [] 即可。');
  lines.push('   - 不要输出除正文和 ops 代码块以外的内容（不要输出 JSON 信封）。');
  lines.push('3. 支持的操作：');
  lines.push('   - {"op":"add","parent_id":<父节点id>,"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}（任一节点的直接子任务不要超过 10 个；要插到指定位置就加 "after":<兄弟节点id> 放到它后面，或 "before":<兄弟节点id> 放到它前面；不加则追加到末尾）');
  lines.push('   - {"op":"update","id":<id>,"title":"","detail":"","artifact":"","acceptance":"","hours":""}（只填要改的字段）');
  lines.push('   - {"op":"delete","id":<id>}');
  lines.push('   - {"op":"move","id":<id>,"parent_id":<新父节点id>}（同一父节点内调整先后顺序也用它：加 "after":<兄弟节点id> 放到它后面，或 "before":<兄弟节点id> 放到它前面；不加则移到末尾）');
  lines.push('   - {"op":"status","id":<id>,"status":"todo|doing|done"}');
    lines.push('   - {"op":"constraint","text":"约束内容"}（用户提出长期性要求时使用，如「以后不要安排付费资源」「我只有周末能学」；这类要求应记为约束而不是改节点）');
  lines.push('   - {"op":"add_source","title":"资料标题","kind":"JD|面经|大纲|笔记|资料","content":"资料正文（尽量完整）","url":"可选链接","site":"来源（可选，默认 对话添加）"}（用户口述/粘贴一份资料时，直接存进资料库）');
  lines.push('   - {"op":"delete_source","title":"资料标题关键词"}（删除资料库里的一条资料，只有用户明确要求才用）');
  lines.push('   - {"op":"update_goal","fields":{"title":"","profile":"现状","weekly_hours":"每周可投入","deadline":"期望期限","materials":"参考资料"}}（只填要改的字段）');
  lines.push('   - {"op":"digest"}（用户要求「提炼资料 / 汇总资料 / 通读全部资料」时使用：会启动信息提炼，把全部资料整理成多篇主题汇总，规划时优先依据）');
  lines.push('   - {"op":"collect"}（用户要求「再收集一些资料 / 找找岗位信息」时使用：会启动信息源检索）');
  lines.push('4. 修改要精准：用户说改哪个就改哪个，不要顺手大改；单次最多 20 个操作。');
  lines.push('5. 删除要谨慎：只有用户明确要求才删除；阶段（最外层节点）不要删除，除非用户明确要求。');
  lines.push('6. 新增任务必须带 detail（怎么做，60-120 字）与 hours；依据已确认的问答与用户现状。');
  lines.push('7. 不要编造 id；只输出 JSON，不要输出其他内容。');
  return lines.join('\n');
}
/* 把节点放到父节点下的指定位置，并归一化这一组兄弟的 sort_order。
   定位支持 after / before（兄弟节点 id）或 index（0 起）；都不给就追加到末尾。
   旧行为只会「追加到 MAX+1」——表达不了「插到某节点前面」，反复移动序号还会
   无限增长，所以 AI 答应「按位置插入」时永远做不到。 */
function placeSibling(goalId, parentId, nodeId, op) {
  const sibs = db.prepare('SELECT id FROM nodes WHERE goal_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0) AND id != ? ORDER BY sort_order, id')
    .all(goalId, parentId, nodeId);
  let idx = sibs.length;
  const afterId = Number(op.after || op.after_id || 0);
  const beforeId = Number(op.before || op.before_id || 0);
  if (afterId) { const i = sibs.findIndex(x => x.id === afterId); if (i >= 0) idx = i + 1; }
  else if (beforeId) { const i = sibs.findIndex(x => x.id === beforeId); if (i >= 0) idx = i; }
  else if (op.index != null && String(op.index).trim() !== '') idx = Math.max(0, Math.min(Number(op.index) || 0, sibs.length));
  sibs.splice(idx, 0, { id: nodeId });
  const stmt = db.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?');
  sibs.forEach((x, i) => stmt.run(i, x.id));
  return idx;
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
        if (op.after != null || op.before != null || op.index != null) placeSibling(goalId, parent ? parent.id : null, nid, op);
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
        let anc = parent, cyc = false;
        while (anc) { if (anc.id === n.id) { cyc = true; break; } anc = anc.parent_id ? nodeOf(anc.parent_id) : null; }
        if (cyc) { errors.push('不能移动到自己的子节点下'); continue; }
        const level = parent ? Math.min(parent.level + 1, 5) : 0;
        db.prepare('UPDATE nodes SET parent_id = ?, level = ?, updated_at = ? WHERE id = ?').run(newParentId, level, nowISO(), n.id);
        placeSibling(goalId, newParentId, n.id, op);
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
        if (list.some(x => String(x.text || '').trim() === text)) { errors.push('这条约束已经有了'); continue; }
        list.push({ text, created_at: nowISO(), source: 'chat' });
        db.prepare('UPDATE goals SET constraints = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), nowISO(), goalId);
        applied.push({ op: 'constraint', title: text.slice(0, 60) });
      } else if (kind === 'add_source' || kind === 'source') {
          const title = String(op.title || '').trim().slice(0, 200);
          const content = String(op.content || op.text || '').trim().slice(0, 20000);
          if (!title && !content) { errors.push('信息源内容为空'); continue; }
          const dup = db.prepare("SELECT id FROM sources WHERE goal_id = ? AND ((title != '' AND title = ?) OR (content != '' AND content = ?)) LIMIT 1").get(goalId, title, content);
          if (dup) { errors.push('这条资料已存在：' + (title || content).slice(0, 30)); continue; }
          const kindV = String(op.kind || '资料').slice(0, 10);
          const siteV = String(op.site || '对话添加').slice(0, 40);
          const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(goalId, title || '对话添加的资料', String(op.url || ''), siteV, kindV, String(op.snippet || content.slice(0, 300)).slice(0, 300), content, String(op.published_at || ''), nowISO());
          applied.push({ op: 'add_source', id: Number(sr.lastInsertRowid), title: (title || '资料').slice(0, 60) });
      } else if (kind === 'delete_source') {
          const key = String(op.title || op.title_match || op.id || '').trim();
          if (!key) { errors.push('请给出要删除的资料标题'); continue; }
          const row = db.prepare("SELECT id,title FROM sources WHERE goal_id = ? AND title LIKE ? LIMIT 1").get(goalId, '%' + key.slice(0, 40) + '%');
          if (!row) { errors.push('没找到资料：' + key.slice(0, 30)); continue; }
          db.prepare('DELETE FROM sources WHERE id = ?').run(row.id);
          applied.push({ op: 'delete_source', id: row.id, title: String(row.title).slice(0, 60) });
      } else if (kind === 'update_goal' || kind === 'goal') {
          const f = op.fields || op;
          const cur = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
          const pick = (k, max) => (f[k] != null ? String(f[k]).trim().slice(0, max) : null);
          const title = pick('title', 200) || cur.title;
          const profile = pick('profile', 4000) != null ? pick('profile', 4000) : cur.profile;
          const weekly = pick('weekly_hours', 50) != null ? pick('weekly_hours', 50) : cur.weekly_hours;
          const deadline = pick('deadline', 50) != null ? pick('deadline', 50) : cur.deadline;
          const materials = pick('materials', 8000) != null ? pick('materials', 8000) : cur.materials;
          db.prepare('UPDATE goals SET title=?, profile=?, weekly_hours=?, deadline=?, materials=?, updated_at=? WHERE id=?')
            .run(title, profile, weekly, deadline, materials, nowISO(), goalId);
          applied.push({ op: 'update_goal', title: '已更新目标信息' });
      } else if (kind === 'digest' || kind === 'digest_sources' || kind === 'extract') {
          applied.push({ op: 'start', action: 'digest', title: '开始信息提炼（通读全部资料 → 多篇主题汇总）' });
      } else if (kind === 'collect' || kind === 'collect_sources') {
          applied.push({ op: 'start', action: 'collect', title: '开始收集信息源' });
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
  const valid = o => o && typeof o === 'object' && ['add', 'update', 'delete', 'move', 'status', 'constraint', 'add_source', 'delete_source', 'update_goal', 'goal', 'source', 'digest', 'digest_sources', 'extract', 'collect', 'collect_sources'].includes(String(o.op || o.type || '').toLowerCase());
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
  const sig = clientSignal(req);   // 用户在对话里点「停止」时，终止上游 AI 请求
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
        signal: sig,
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
      if (e && e.cancelled) send({ cancelled: true, status: '已停止（本轮未执行任何修改）' });
      else send({ error: e.message });
    }
    res.end();
  })();
}


/* 跑题检查（教程修改流程用）：线上真实翻车过 —— 模型把“RAGFlow 部署架构”
   改成了“离线同步引擎”，标题留着、正文全换，长度检查根本拦不住。
   规则：从标题抽主题词，要求“原文命中≥2 且新文命中≥2”；只有
   “旧的对、新的错”时才判跑题（新旧都不沾边的不管，免得标题太空时误杀）。 */
/* 主题词按可信度分级：
   strong = 长度≥3 的中文词 + 英文词（"部署架构"/"RAGFlow"）—— 正文里出现才算真讲了这个主题
   weak   = 二元切分（"部署"/"启动"）—— 只用来在 strong 不足时兜底
   ⚠️ 二元词极容易被"蒙中"：线上真翻过一次车 —— 新教程通篇讲"怎么写技术教程"，
      开头复述了一遍标题，于是"测绘/RAGFlow/部署/架构/启动/链路"全部出现在正文里，
      而 RAGFlow 一个字都没讲，跑题守卫因此放行。所以计数时 strong 与 weak 分开。 */
function topicKeywords(title) {
  const stop = new Set(['教程', '学习', '笔记', '总结', '阶段', '任务', '目标', '介绍', '指南', '规划', '讲解', '详解', '入门', '精通', '实战', '实践']);
  const anchorEn = [], anchor = [], strong = [], weak = [];
  const push = (arr, w) => { if (w && w.length >= 2 && !arr.includes(w)) arr.push(w); };
  const s = String(title || '');
  const runs = [];
  for (const m of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    let w = m;
    for (const st of stop) w = w.split(st).join(' ');
    for (const piece of w.split(' ')) {
      if (piece.length < 2) continue;
      runs.push(piece);
      push(strong, piece.length >= 3 ? piece : '');
      if (piece.length >= 5) push(anchor, piece);
    }
  }
  for (const m of s.match(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g) || []) { push(anchorEn, m); push(strong, m); }
  for (const r of runs) if (r.length >= 4) for (let i = 0; i + 1 < r.length; i++) push(weak, r.slice(i, i + 2));
  return {
    anchorEn: anchorEn.slice(0, 4),      // 英文专名（"RAGFlow"）：最可靠，判定首选
    anchorZh: anchor.slice(0, 3),        // 长中文短语：可靠，但容易在"复述主题"时蒙中
    strong: strong.slice(0, 8),
    weak: weak.slice(0, 10)
  };
}
/* 只留"读者能看到的内容"来判主题。
   ⚠️ 必须把 <head> 整块丢掉：HTML 教程的 <title> 里往往就是节点标题原样，
      而跑题的新教程照样会带着正确的 <title> —— 不去掉就等于用标题验证标题，
      守卫必然放行（线上真踩过：新教程通篇讲"怎么写教程"，只靠 <title> 就蒙混过关）。 */
function stripTags(html) {
  return String(html || '')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}
function topicDrifted(newHtml, oldHtml, titles) {
  const anchorEn = [], anchorZh = [], strong = [], weak = [];
  for (const t of (titles || [])) {
    const k = topicKeywords(t);
    for (const x of k.anchorEn) if (!anchorEn.includes(x)) anchorEn.push(x);
    for (const x of k.anchorZh) if (!anchorZh.includes(x)) anchorZh.push(x);
    for (const x of k.strong) if (!strong.includes(x)) strong.push(x);
    for (const x of k.weak) if (!weak.includes(x)) weak.push(x);
  }
  const bodyNew = stripTags(newHtml).toLowerCase();
  const bodyOld = stripTags(oldHtml).toLowerCase();
  const count = (w, body) => body.split(w.toLowerCase()).length - 1;
  const hits = (list, body) => list.filter(k => body.includes(k.toLowerCase()));
  const total = list => list.reduce((s, k) => s + count(k, bodyNew), 0);
  /* 判定优先级（从可靠到将就）：
       ① 标题里有英文专名 → 只看它（"RAGFlow" 出现与否几乎不可能被巧合骗过）
       ② 否则用长中文短语，且要求**反复出现**（≥2 次）——
          只出现一次往往只是开头复述了一遍主题，线上翻车那版就是这样蒙混过关的
       ③ 再退而求其次才用 strong/weak，且命中数要够多 */
  /* 关键在 stripTags 已丢掉 <head>：正文里出现 0 次专名才是跑题的可靠信号。
     出现 1 次就算在讲 —— 真实的 RAGFlow 教程里也有只出现一两次的，
     要求"≥2 次"会误杀好教程（实测导出样本里 RAGFlow 只出现 1 次）。
     唯一例外是正文太短：几百字的补充说明本来就可能只提一次，判不了就不判。 */
  if (bodyNew.length < 600) return null;
  let oldOn = false, newOff = false, used = '';
  /* 出现次数的要求**跟旧文对齐**，而不是一刀切：
     正文长（>3000 字）且旧文本来就反复提这个主题（≥2 次）→ 新文也得 ≥2 次，
     拦住"开头复述一遍主题就交差"；
     旧文自己都只提 1 次（真人写的、措辞精简）→ 就按 1 次要求，
     否则会把用户自己的好教程误杀（线上真有一份：正文 32k 字，
     "环境搭建与变量"整篇只出现 1 次，却完全没跑题）。 */
  const need = (() => {
    if (bodyNew.length <= 3000) return 1;
    const oldTotal = anchorEn.concat(anchorZh).reduce((s, w) => s + count(w, bodyOld), 0);
    return oldTotal >= 2 ? 2 : 1;
  })();
  const enough = list => total(list) >= need;
  if (anchorEn.length) {
    used = '英文专名 ' + anchorEn.join('/') + '（正文需出现≥' + need + '次）';
    oldOn = hits(anchorEn, bodyOld).length >= 1;
    newOff = !enough(anchorEn);
  } else if (anchorZh.length) {
    used = '长中文短语 ' + anchorZh.join('/') + '（正文需出现≥' + need + '次）';
    oldOn = hits(anchorZh, bodyOld).length >= 1;
    newOff = !enough(anchorZh);
  } else if (strong.length >= 2) {
    used = 'strong ' + strong.join('/');
    oldOn = hits(strong, bodyOld).length >= 1;
    newOff = hits(strong, bodyNew).length === 0;
  } else if (weak.length) {
    used = 'weak ' + weak.join('/');
    oldOn = hits(weak, bodyOld).length >= 2;
    newOff = hits(weak, bodyNew).length < 2;
  } else {
    return null;   // 标题太泛，没法判
  }
  if (oldOn && newOff) return { used, anchorEn, anchorZh, strong, weak, newBody: bodyNew.slice(0, 200) };
  return null;
}
/* ===== 教程完整性体检 =====
   线上真翻过车：AI 输出到一半被截断（目录列了 12 节，正文只写到第 3 节），
   而原来的校验只看「长度够不够」，25k 字远超阈值 → 半截内容照常入库。
   后果不是报错，而是用户看到的东西静默缺了一大块：页内目录点后面几节全没反应。
   所以除了长度，必须查结构：
     · HTML 有 <html> 却没有 </html>            → 中途断了
     · 结构标签开合不齐（div/section/style…）    → 中途断了
     · 目录里有 href="#x" 但全文找不到 id="x"  → 目录承诺的章节没写出来（最典型）
   宁可空着也不要假装完整：真断了就自动续写，续不上就明说，别悄悄存半截。 */
function countTag(s, tag) {
  const open = (s.match(new RegExp('<' + tag + '(?=[\\s>/])', 'gi')) || []).length;
  const close = (s.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length;
  return { open, close };
}
/* 结构标签只挑「几乎必然成对」的：p/li/td 这类 AI 常省略闭合标签，算进去会误判好教程。
   div 的闭合情况实测很脏（用户库里那份正常教程就少一个 </div>，多半是 </div></div> 手滑），
   少 1 个不作为截断证据 —— 缺一整段时下面的锚点检查会抓到。 */
const STRUCT_TAGS = ['html', 'head', 'body', 'section', 'style', 'script', 'table', 'ul', 'ol', 'pre', 'svg'];
function tutIntegrity(txt, format) {
  const s = String(txt || '');
  /* issues = 截断证据（命中即没写完 → 续写 / 拒收）
     soft   = 疑似瑕疵（模型自己写歪了，但正文可能确实是完整的，不作为拒收理由） */
  const issues = [], soft = [], missingAnchors = [];
  if (format === 'html') {
    const low = s.toLowerCase();
    if (/<html[\s>]/.test(low) && !/<\/html>\s*$/.test(low.trim())) issues.push('正文没有以 </html> 收尾（HTML 写了一半就断了）');
    const unbalanced = [];
    for (const tag of STRUCT_TAGS) {
      const c = countTag(s, tag);
      if (c.open && c.open !== c.close) unbalanced.push('<' + tag + '> 开 ' + c.open + ' / 闭 ' + c.close);
    }
    if (unbalanced.length) issues.push('标签开合不齐：' + unbalanced.slice(0, 4).join('，'));
    /* 目录承诺 vs 正文实有：链接目标 id 必须真的存在于正文里。
       正文断在第 3 节 → 目录里 #s4…#s12 全是空头支票，用户点后面几节全没反应。
       但模型也会在**完整**教程里留下个别失效锚点（用户库里那份正常教程就少了 s13/s14，
       而它结尾有 </html>、结构也齐），所以只在"已经有别的截断证据"时才把它当证据。 */
    const hrefs = new Set();
    for (const m of s.matchAll(/href\s*=\s*["']#([A-Za-z][\w:.-]*)["']/g)) hrefs.add(m[1]);
    for (const a of hrefs) {
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // id 可能写成 id="x" / id='x' / id=x（HTML 允许省略引号），三种都算存在
      if (new RegExp('id\\s*=\\s*(?:["\']' + esc + '["\']|' + esc + '(?=[\\s>]))', 'i').test(s)) continue;
      missingAnchors.push(a);
    }
    if (missingAnchors.length) {
      const msg = '目录里有 ' + missingAnchors.length + ' 个章节在正文里找不到（' + missingAnchors.slice(0, 5).join('、') + (missingAnchors.length > 5 ? '…' : '') + '）';
      if (issues.length) issues.push(msg);
      else soft.push(msg + '（正文本身完整，应该只是目录里多了几个失效链接）');
    }
  } else {
    /* Markdown 的围栏不闭合只当"疑似"（soft），不当拒收理由：
       线上用户库里就有一份 9 月的老教程，末尾代码块少了收尾的 ```（内容本身是完整的）。
       拿它拒收一次合法修改，比放过一次轻微不完整更糟。
       Markdown 真被截断由"长度比原文短太多"那条兜住，不靠围栏判断。 */
    const fences = (s.match(/^\s*(?:```|~~~)/gm) || []).length;
    if (fences % 2) soft.push('末尾代码块 ``` 没有闭合（内容看起来仍完整）');
  }
  return { ok: !issues.length, issues, soft, missingAnchors };
}
/* 续写提示词：给「已经写出的内容尾部」+ 具体缺什么，让模型接着往下写。
   只带尾部不带全文（省上下文），并明确禁止重复已输出内容与加前言。 */
/* 部分模型输出到上限时会"自己觉得写完了"，或者直接在 </section> 之后就停。
   结束标记不完整 = 硬截断，无从续写，只能明说。这种情况常见于 DeepSeek-flash 写长 HTML。 */
function endsMidway(txt, format) {
  const s = String(txt || '').trim();
  if (!s) return '内容为空';
  if (format === 'html') {
    if (!/<\/html>\s*$/i.test(s)) return '结尾缺少 </html>（输出到上限被硬截断，无法续写）';
    const tail = s.slice(-400);
    const lastOpen = tail.lastIndexOf('<section'), lastClose = tail.lastIndexOf('</section>');
    if (lastOpen > lastClose) return '结尾处 <section> 没闭合（输出到上限被硬截断，无法续写）';
  } else {
    const fences = (s.match(/^\s*(?:```|~~~)/gm) || []).length;
    if (fences % 2) return '结尾代码块 ``` 没闭合（输出到上限被硬截断，无法续写）';
  }
  return '';
}
function buildTruncRepairPrompt(title, format, tail, issues) {
  const isHtml = format === 'html';
  return [
    '你刚才写一份' + (isHtml ? ' HTML ' : ' Markdown ') + '教程《' + String(title || '').slice(0, 80) + '》时输出被截断了，只写了一半就断了。',
    '',
    '【检测到的问题】',
    ...issues.map(x => '· ' + x),
    '（这是一个"续写补全"请求，不是从头重写：下面的尾部就是你已经写到的位置）',
    '',
    '【你已经写出来的内容的尾部】',
    '```' + (isHtml ? 'html' : 'markdown'),
    String(tail || '').slice(-3000),
    '```',
    '',
    'SX-REPAIR-MARK —— 现在只输出续写部分，从上面中断的位置紧接着往下写】',
    '铁律：',
    '1) 不要重复任何已输出的内容，不要重写开头，不要写"以下是…"之类的说明或道歉。',
    '2) 不要输出 <!DOCTYPE>、<html>、<head> 这些开头标签（已有），只写后续片段。' + (isHtml ? '' : ''),
    isHtml
      ? '3) 把上一个没闭合的标签补上（如 </div> </section>），继续写完剩余章节，最后一定要有 </body></html> 收尾。'
      : '3) 如果上一段代码块没闭合，先补 ``` 收上，再继续写。',
    isHtml ? '4) 章节标题和 id 要跟已有目录保持一致，目录里列出的章节一个都不能少。' : '4) 保持与前文同样的结构与风格。',
    '5) 直接输出续写内容本身。'
  ].join('\n');
}
/* 体检不过就自动续写（最多 2 轮），续完再体检；仍不过把问题抛给调用方决定。 */
async function repairTruncatedText({ raw, format, title, issues, runText, progress }) {
  let out = String(raw || '');
  let tries = 0;
  while (tries < 2) {
    if (progress) progress(70 + tries * 5, '教程被截断了，正在让 AI 补全缺失部分（第 ' + (tries + 1) + ' 次）…');
    const more = await runText(buildTruncRepairPrompt(title, format, out.slice(-3000), issues));
    const add = cleanTutorialText(String(more || ''), format);
    if (!add || add.length < 80) break;
    out += (out.endsWith('\n') ? '' : '\n') + add;
    tries++;
    const chk = tutIntegrity(out, format);
    if (chk.ok) { console.log('[tutorial] 截断续写成功（第 ' + tries + ' 轮补齐）'); return { text: out, issues: [], fixed: true }; }
    issues = chk.issues;
  }
  return { text: out, issues, fixed: false };
}
function cleanTutorialText(txt, format) {
  let s = String(txt || '').trim();
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (m) s = m[1].trim();
  if (format === 'html') {
    /* 不要求全文被围栏包裹：模型经常在前面加一句前言（"这是根据您的意见重写的…"），
       后面再贴整篇 HTML。只认标记抽取 —— 找不到标记才原样保留。 */
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
/* 生成教程走 SSE 直推前端，响应体早就发出去了，没法在服务端"原样重跑"。
   于是重试时把当初那次 POST 原封不动地再发一遍给本进程（任务照样进队列、照样在后台跑，
   这次没人读 SSE 流而已 —— 前端本来也只看任务中心）。
   codeFiles 里的文件夹项带绝对路径，序列化回来仍会被同一套 root 校验拦住，不存在越权读。 */
function localSelfPost(path, payload) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req2 = http.request({
        host: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload || {})) }
      }, r => {
        /* SSE 流：只关心"被受理了"，读完立刻丢掉连接（res.write 失败在 streamTutorial 里有 try/catch） */
        r.on('data', () => {});
        r.on('end', () => done(0));
        r.on('error', () => done(0));
        setTimeout(() => done(0), 3000);
      });
      req2.on('error', () => done(0));
      req2.end(JSON.stringify(payload || {}));
      setTimeout(() => done(0), 8000);
    } catch (e) { done(0); }
  });
}
function tutGenRetry(node, format, note, codeFiles, withFolders, folderFiles) {
  return async () => {
    const nid = node && node.id ? Number(node.id) : 0;
    if (!nid) return 0;
    await localSelfPost('/api/nodes/' + nid + '/tutorial', {
      format, note: note || '', codeFiles: codeFiles || [], withFolders: withFolders !== false, folderFiles: folderFiles || []
    });
    return 0;   // 新任务 id 由前端从任务列表里看（提交即刻可见）
  };
}
function streamTutorial(req, res, node, format, note, codeFiles, withFolders, folderFiles) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const tk = tasks.begin({ type: 'tutorial', title: '生成教程：' + (node ? node.title : ''), goalId: node ? node.goal_id : 0, nodeId: node ? node.id : 0, note: note || '', retry: tutGenRetry(node, format, note, codeFiles, withFolders, folderFiles) });
  /* SSE 响应是"一次性输出"：重试发回来的这份没人读，所以显式说明一下，
     免得后来看日志的人以为前端断流了。 */
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} if (obj && obj.status) tk.progress(undefined, obj.status); };
  (async () => {
    try {
      const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(node.goal_id);
      if (!goal) throw new Error('目标不存在');
      // 结合源码：只读项目根下白名单文件（code-read 强制过滤），失败不阻断
      let codeBlock = '', codeList = [];
      try {
        const files = readCodeFiles(APP_DIR, codeFiles);
        if (files.length) {
          codeBlock = buildCodeBlock(files);
          codeList = files.map(f => f.path);
          send({ status: `已载入 ${files.length} 个源码文件作为讲解依据…` });
        }
      } catch (e) { console.log('[tutorial] 源码载入失败:', e.message); }
      /* 结合文件夹资料源：
           1) 用户在对话框里亲手勾的文件（folderFiles，root 已校验过是挂载过的夹）优先；
           2) 没勾或不够时，本节点 + 祖先挂的文件夹自动补上（除非调用方明确关掉）。
         RAGFlow 这类场景就靠它 —— 挂一次，全家（本节点及子节点）的教程都能读到。 */
      const pickedRoots = new Set();
      if (Array.isArray(folderFiles) && folderFiles.length) {
        try {
          const byRoot = new Map();
          for (const f of folderFiles) {
            if (!byRoot.has(f.root)) byRoot.set(f.root, []);
            byRoot.get(f.root).push(f.path);
          }
          for (const [root, rels] of byRoot) {
            const files = readCodeFiles(root, rels);
            if (files.length) {
              codeBlock += (codeBlock ? '\n\n' : '') + '【文件夹资料（用户亲手勾的）：' + root + '】\n'
                + files.map(f => '--- ' + f.path + (f.truncated ? '（过长已截断）' : '') + ' ---\n' + f.text).join('\n');
              for (const f of files) { codeList.push({ root, path: f.path }); pickedRoots.add(root); }
              send({ status: `已载入亲手勾的 ${files.length} 个文件…` });
            }
          }
        } catch (e) { console.log('[tutorial] 勾选文件载入失败:', e.message); }
      }
      if (withFolders !== false) {
        try {
          const room = Math.max(5000, 60000 - codeBlock.length);
          const auto = await nodeFolders.prepareNodeCode({
            aiText, model: (currentModel && currentModel()) || '',
            db, nodeId: Number(node.id), title: node.title, detail: node.detail,
            budget: room, skipRoots: pickedRoots, send
          });
          if (auto.list.length) {
            codeBlock += (codeBlock ? '\n\n' : '') + auto.block;
            for (const f of auto.list) codeList.push({ root: f.root, path: f.path });
            send({ status: `已载入文件夹资料 ${auto.list.length} 个文件作为讲解依据…` });
          }
        } catch (e) { console.log('[tutorial] 文件夹资料载入失败:', e.message); }
      }
      send({ status: `正在撰写「${String(node.title).slice(0, 18)}」的${format === 'html' ? ' HTML ' : ' Markdown '}教程（讲原理、分步实践、练习与自测，约需 1-3 分钟）…` });
      const prompt = buildTutorialPrompt(goal, node, format, note, codeBlock);
      let txt = cleanTutorialText(await aiText(prompt, model, 600000), format);
      if (!txt || txt.length < 200) throw new Error('教程生成失败：AI 只写了 ' + (txt ? txt.length : 0) + ' 字就停了。原教程没动，可以点任务上的「🔄 重试」，或换个输出更长的模型再试');
      /* 体检：结构不完整多半是被输出上限截断（长度够、结构缺）。
         自动续写补齐；补不齐就把问题说清楚 —— 不能把半截教程当成功写进库。 */
      let chk = tutIntegrity(txt, format);
      if (!chk.ok) {
        send({ status: '检测到教程被截断（' + chk.issues[0] + '），正在让 AI 补全…' });
        const fixed = await repairTruncatedText({
          raw: txt, format, title: node.title, issues: chk.issues,
          runText: (p) => aiText(p, model, 600000)
        });
        txt = fixed.text; chk = tutIntegrity(txt, format);
        if (!chk.ok) {
          const hard = endsMidway(txt, format);
          throw new Error('教程没能写完整（已自动续写 2 次仍不完整）：' + chk.issues.join('；')
            + (hard ? '。原因：' + hard + ' —— 换 deepseek-chat / deepseek-reasoner 等输出上限更高的模型，或把篇幅要求调小一点' : '')
            + '。教程未保存，点任务上的「🔄 重试」可原样重跑');
        }
      }
      const t = nowISO();
      const title = String(node.title).trim().slice(0, 120);
      const r = db.prepare('INSERT INTO tutorials (goal_id, node_id, title, format, content, code_files, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(goal.id, node.id, title, format, txt, JSON.stringify(codeList), t, t);
      const tid = Number(r.lastInsertRowid);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
      backup();
      send({ done: true, tutorial: { id: tid, node_id: node.id, title, format, created_at: t, chars: txt.length }, goal: getGoal(goal.id) });
      tk.done({ tutorialId: tid, length: txt.length });
    } catch (e) {
      tk.fail(e);
      send({ error: e.message });
      return res.end();
    }
    /* ⚠️ 别在这里无脑补一句 tk.done()：失败分支已经 tk.fail() 过了，
       再调 done 会把 failed 覆盖成"✓ 完成" —— 于是教程生成失败在任务中心
       显示成成功，用户完全不知道出了事（这正是"失败看不出原因"的一部分）。 */
    res.end();
  })();
}

/* ===== HTTP ===== */
async function handleAPI(req, res, u) {
  const p = u.pathname, method = req.method;

  if (p === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true, app: APP_NAME });

  /* ===== 组件能力开关：关闭的组件，其接口一律拒绝（按目标判定，目标之间不串） =====
     注意：/api/components/*（组件管理接口）永远放行，否则会把自己锁死。 */
  if (!p.startsWith('/api/components')) {
    const HINT = '（在该目标页点 🧩 组件 可单独开启，不影响别的目标）';
    const gidOf = () => {
      let m = p.match(/^\/api\/goals\/(\d+)/);
      if (m) return Number(m[1]);
      try {
        m = p.match(/^\/api\/versions\/(\d+)/);
        if (m) { const v = db.prepare('SELECT goal_id FROM goal_versions WHERE id = ?').get(Number(m[1])); if (v) return v.goal_id; }
        m = p.match(/^\/api\/chat-sessions\/(\d+)/);
        if (m) { const s = db.prepare('SELECT goal_id FROM chat_sessions WHERE id = ?').get(Number(m[1])); if (s) return s.goal_id; }
        m = p.match(/^\/api\/nodes\/(\d+)\/tutorial$/);
        if (m) { const n = db.prepare('SELECT goal_id FROM nodes WHERE id = ?').get(Number(m[1])); if (n) return n.goal_id; }
        m = p.match(/^\/api\/tutorials\/(\d+)/);
        if (m) { const t = db.prepare('SELECT goal_id FROM tutorials WHERE id = ?').get(Number(m[1])); if (t) return t.goal_id; }
      } catch (e) {}
      return null;
    };
    if ((p.startsWith('/api/goals/') && p.endsWith('/versions')) || p.startsWith('/api/versions/')) {
      if (!goalCompOn(gidOf(), 'versions')) return sendJSON(res, 403, { error: '「版本对比与汇报」组件已关闭' + HINT });
    }
    if (p.startsWith('/api/chat-sessions') || p.endsWith('/chat-sessions') || p.endsWith('/chats') || (p.startsWith('/api/goals/') && p.endsWith('/chat'))) {
      if (!goalCompOn(gidOf(), 'chat')) return sendJSON(res, 403, { error: '「对话改规划」组件已关闭' + HINT });
    }
    if (/^\/api\/nodes\/\d+\/tutorial$/.test(p) || p.startsWith('/api/tutorials/')) {
      if (!goalCompOn(gidOf(), 'tutorial')) return sendJSON(res, 403, { error: '「学习教程」组件已关闭' + HINT });
    }
    if (/^\/api\/goals\/\d+\/plan\/clarify$/.test(p) || p.startsWith('/api/goals/') && p.endsWith('/clarify/drill') || p.startsWith('/api/goals/') && p.endsWith('/clarify/note')) {
      if (!goalCompOn(gidOf(), 'clarify')) return sendJSON(res, 403, { error: '「规划前问卷」组件已关闭' + HINT });
    }
    if (p.endsWith('/constraints') || /\/constraints\/\d+$/.test(p)) {
      if (!goalCompOn(gidOf(), 'constraints')) return sendJSON(res, 403, { error: '「规划约束」组件已关闭' + HINT });
    }
    if (p.endsWith('/collect')) {
      if (!goalCompOn(gidOf(), 'sources')) return sendJSON(res, 403, { error: '「信息源检索」组件已关闭' + HINT });
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
      const sel = snapshotCompSel();
      for (const pl of PLUGINS) {
        if (body.plugins && body.plugins[pl.id] != null) sel[pl.id] = !!body.plugins[pl.id];
        else if (!(pl.id in sel)) sel[pl.id] = !!pl.defaultEnabled;
      }
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
    const tk = tasks.begin({ type: 'collect', title: '搜集信息源：' + String(g.title || '').slice(0, 30), goalId: id, nodeId: 0, note: '' });
    const sig = tk.signal;   // 只有主动取消才中断；切换/关闭页面不影响后台继续
    const tkSend = s => { try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch (e) {} if (s && s.status) tk.progress(undefined, s.status); };
    (async () => {
      try {
        let ebSummary = '';
        try {
          const eb = await fetchEbooksForGoal(g, tkSend, sig);
          if (eb && !eb.skipped) {
            const parts = [];
            if (eb.ok) parts.push(`电子书入库 ${eb.ok} 本`);
            if (eb.listed) parts.push(`待找书单 ${eb.listed} 本`);
            if (eb.missing) parts.push(`${eb.missing} 本没找到公开免费版`);
            if (eb.failed) parts.push(`${eb.failed} 本下载失败`);
            if (parts.length) ebSummary = '📚 ' + parts.join('，');
          }
        } catch (e) {
          if (e && e.cancelled) throw e;
          tkSend({ status: '电子书阶段跳过：' + e.message });
        }
        const r = await collectForGoal(g, tkSend, sig);
        const list = sourcesOf(id);
        try { res.write(`data: ${JSON.stringify({ done: true, count: r.saved, blocked: r.blocked, sources: list, ebooks: ebSummary })}\n\n`); } catch (e) {}
        tk.done({ ok: true });
      } catch (e) {
        tk.fail(e);
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

  /* ---------- 资料提炼：读全部资料 → 提炼 → 多主题 MD 汇总 ---------- */
  const digestMatch = p.match(/^\/api\/goals\/(\d+)\/sources\/digest$/);
  if (digestMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(digestMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const sig = clientSignal(req);
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
    (async () => {
      try {
        const info = digestBatches(g);
        if (!info.batches.length) throw new Error('还没有资料可以提炼：先「收集信息源」或上传图片资料');
        const model = currentModel();
        send({ status: `共 ${info.total} 条资料（你提供的 ${info.ownCount} 条 / 网络 ${info.netCount} 条），分 ${info.batches.length} 批通读…`, progress: { done: 0, total: info.batches.length } });
        const parts = [];
        let done = 0, next = 0;
        const worker = async () => {
          while (true) {
            const my = next++;
            if (my >= info.batches.length) return;
            if (sig.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; }
            send({ status: `正在通读第 ${my + 1}/${info.batches.length} 批资料…`, progress: { done, total: info.batches.length } });
            const txt = await aiText(digestBatchPrompt(info.batches[my], my + 1, info.batches.length), model, 300000, null, sig);
            let data = null;
            try { data = extractJSONRaw(txt) || {}; } catch (e) { data = {}; }
            parts.push({ idx: my + 1, data });
            done++;
            send({ status: `已通读 ${done}/${info.batches.length} 批`, progress: { done, total: info.batches.length } });
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, info.batches.length) }, worker));
        parts.sort((a, b) => a.idx - b.idx);
        send({ status: '正在汇总成主题文档（按主题拆分成多篇）…', progress: { done, total: info.batches.length } });
        const syn = await aiText(digestSynthesisPrompt(parts, info), model, 600000, null, sig);
        const parsed = extractJSONRaw(syn) || {};
        const list = Array.isArray(parsed.digests) ? parsed.digests : (Array.isArray(parsed) ? parsed : []);
        if (!list.length) throw new Error('汇总结果解析失败，可重试');
        const t = nowISO();
        db.prepare('DELETE FROM source_digests WHERE goal_id = ?').run(g.id);
        for (const d of list.slice(0, 12)) {
          const topic = String(d.topic || '').slice(0, 60);
          const title = String(d.title || topic || '汇总').slice(0, 120);
          const content = String(d.content_md || d.content || '').slice(0, 20000);
          if (!content.trim()) continue;
          db.prepare('INSERT INTO source_digests (goal_id, topic, title, content, sources_count, created_at) VALUES (?,?,?,?,?,?)')
            .run(g.id, topic, title, content, info.total, t);
        }
        db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, g.id);
        backup();
        send({ done: true, count: digestsOf(g.id).length, digests: digestsOf(g.id) });
      } catch (e) {
        if (e && e.cancelled) send({ cancelled: true, status: '已停止提炼' });
        else send({ error: '资料提炼失败：' + e.message });
      }
      res.end();
    })();
    return;
  }
  const digestsGetMatch = p.match(/^\/api\/goals\/(\d+)\/digests$/);
  if (digestsGetMatch && method === 'GET') {
    return sendJSON(res, 200, { digests: digestsOf(Number(digestsGetMatch[1])) });
  }
  const libExportMatch = p.match(/^\/api\/goals\/(\d+)\/library\/export$/);
  if (libExportMatch && method === 'GET') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(libExportMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const md = buildLibraryMarkdown(g);
    const fname = encodeURIComponent('资源库-' + String(g.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '.md');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': "attachment; filename=\"library.md\"; filename*=UTF-8''" + fname });
    return res.end(md);
  }
  const digestsExportMatch = p.match(/^\/api\/goals\/(\d+)\/digests\/export$/);
  if (digestsExportMatch && method === 'GET') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(digestsExportMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const list = digestsOf(g.id);
    if (!list.length) return sendJSON(res, 404, { error: '还没有提炼汇总' });
    const md = list.map(d => '# ' + (d.title || d.topic) + '\n\n' + d.content).join('\n\n---\n\n');
    const fname = encodeURIComponent('资料提炼汇总-' + String(g.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '.md');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': "attachment; filename=\"digests.md\"; filename*=UTF-8''" + fname });
    return res.end(md);
  }
  const digestDelMatch = p.match(/^\/api\/digests\/(\d+)$/);
  if (digestDelMatch && method === 'DELETE') {
    db.prepare('DELETE FROM source_digests WHERE id = ?').run(Number(digestDelMatch[1]));
    return sendJSON(res, 200, { ok: true });
  }

  const sourcesMatch = p.match(/^\/api\/goals\/(\d+)\/sources$/);
  if (sourcesMatch && method === 'GET') {
    return sendJSON(res, 200, { sources: sourcesOf(Number(sourcesMatch[1])) });
  }
  /* 分享脱敏：隐去学校 / 公司 / 年级 / 姓名 / 联系方式等个人隐私（保留能力描述，规划依据不受影响） */
function redactText(raw) {
  let t = String(raw == null ? '' : raw);
  if (!t) return t;
  // 联系方式
  t = t.replace(/1[3-9]\d{9}/g, '（已隐去手机号）');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '（已隐去邮箱）');
  t = t.replace(/\d{17}[\dXx]/g, '（已隐去证件号）');
  t = t.replace(/[Qq][Qq]?\s*[:：]\s*\d{5,12}/g, '（已隐去 QQ）');
  t = t.replace(/(微信|wechat|wx)\s*[:：]\s*[\w.-]{4,30}/gi, '（已隐去微信）');
  // 姓名
  t = t.replace(/(姓名|名字|我叫|本人)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}/g, '（已隐去姓名）');
  // 学校（含「中国石油大学（北京）」这类带括号的写法）
  t = t.replace(/[\u4e00-\u9fa5]{2,14}(大学|学院|学校)[（(][^)）]{1,10}[)）]/g, '（已隐去学校）');
  t = t.replace(/[\u4e00-\u9fa5]{2,14}(大学|学院|学校)/g, '（已隐去学校）');
  // 公司
  t = t.replace(/[\u4e00-\u9fa5]{2,14}(股份有限公司|有限责任公司|有限公司|集团|研究院|研究所)/g, '（已隐去单位）');
  t = t.replace(/[\u4e00-\u9fa5]{2,10}(科技有限公司|科技公司|公司)/g, '（已隐去单位）');
  // 年级 / 学历阶段
  t = t.replace(/(研一|研二|研三|大一|大二|大三|大四|博一|博二|博三|博四)/g, '（已隐去年级）');
  // 清理替换后残留的重复括号 / 空括号
  t = t.replace(/（已隐去(学校|单位|姓名|年级|手机号|邮箱|证件号|QQ|微信)）\s*[）)]/g, '（已隐去$1）');
  t = t.replace(/（（+/g, '（');
  t = t.replace(/））+/g, '）');
  t = t.replace(/\s*（已隐去学校）/g, '（已隐去学校）');
  return t;
}
/* 一键分享：把「规划（骨架+任务）+ 资料库 + 提炼汇总」打包成可分享文件 */
  const shareMatch = p.match(/^\/api\/goals\/(\d+)\/share$/);
  if (shareMatch && method === 'GET') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(shareMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(g.id);
    const sources = db.prepare('SELECT * FROM sources WHERE goal_id = ? ORDER BY quality DESC, id').all(g.id);
    const digests = digestsOf(g.id);
    const redact = u.searchParams.get('redact') !== '0';   // 默认隐去个人隐私
    const R = x => (redact ? redactText(x) : x);
    // 导出内容按模块勾选：parts 逗号分隔，缺省=全部
    const partsRaw = String(u.searchParams.get('parts') || '').trim();
    const want = k => !partsRaw || partsRaw.split(',').map(x => x.trim()).includes(k);
    const inc = { goal: want('goal'), profile: want('profile'), materials: want('materials'), constraints: want('constraints'), nodes: want('nodes'), sources: want('sources'), digests: want('digests') };
    const out = {
      format: 'sierxing-share', version: 1, exportedAt: nowISO(),
      redacted: redact,
      from: { device: redact ? '（已隐去设备名）' : os.hostname() },
      included: inc,
      goal: {
        title: inc.goal ? R(g.title) : '（未包含目标标题）',
        profile: inc.profile ? R(g.profile) : '',
        weekly_hours: inc.goal ? g.weekly_hours : '',
        deadline: inc.goal ? g.deadline : '',
        materials: inc.materials ? R(g.materials) : '',
        summary: inc.goal ? R(g.summary) : '',
        constraints: inc.constraints ? (safeParse(g.constraints) || []).map(x => Object.assign({}, x, { text: R(x && x.text) })) : []
      },
      counts: {
        nodes: inc.nodes ? nodes.length : 0,
        sources: inc.sources ? sources.length : 0,
        digests: inc.digests ? digests.length : 0
      },
      nodes: (inc.nodes ? nodes : []).map(n => ({
        id: n.id, parent_id: n.parent_id, level: n.level, sort_order: n.sort_order, title: R(n.title),
        detail: R(n.detail), artifact: R(n.artifact), acceptance: R(n.acceptance), hours: n.hours, status: n.status,
        sources: (safeParse(n.sources) || []).map(s2 => (redact && s2 && typeof s2 === 'object'
          ? Object.assign({}, s2, { name: R(s2.name), note: R(s2.note) }) : s2))
      })),
      sources: (inc.sources ? sources : []).map(x => {
        // 用户自己提供的资料里可能含个人隐私（简历/截图文字）：也一并脱敏；网络资料原样保留
        const own = x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料' || x.site === '手动添加' || x.site === '对话添加';
        return {
          title: R(x.title), url: x.url, site: x.site, kind: x.kind,
          snippet: own ? R(x.snippet) : x.snippet,
          content: own ? R(x.content) : x.content,
          published_at: x.published_at, quality: Number(x.quality) || 0
        };
      }),
      digests: (inc.digests ? digests : []).map(d => ({ topic: d.topic, title: d.title, content: d.content }))
    };
    const fname = encodeURIComponent('规划分享-' + String(g.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '.share.json');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': "attachment; filename=\"share.json\"; filename*=UTF-8''" + fname
    });
    return res.end(JSON.stringify(out, null, 1));
  }
  /* 一键导入分享文件：新建一个目标（含规划、资料库与提炼汇总） */
  if (p === '/api/share/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || body.format !== 'sierxing-share') return sendJSON(res, 400, { error: '不是有效的分享文件（需要 *.share.json）' });
    const gg = body.goal || {};
    const t = nowISO();
    const gr = db.prepare('INSERT INTO goals (title, profile, weekly_hours, deadline, materials, summary, constraints, status, plugins, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(gg.title || '来自分享的目标').slice(0, 200), String(gg.profile || '').slice(0, 4000),
        String(gg.weekly_hours || '').slice(0, 50), String(gg.deadline || '').slice(0, 50),
        String(gg.materials || '').slice(0, 8000), String(gg.summary || '').slice(0, 800),
        JSON.stringify(Array.isArray(gg.constraints) ? gg.constraints.slice(0, 30) : []), 'review', JSON.stringify(snapshotCompSel()), t, t);
    const gid = Number(gr.lastInsertRowid);
    // 节点（按层级顺序插入，维护旧 id → 新 id 映射）
    const idMap = new Map();
    let nodeCount = 0;
    const sorted = (Array.isArray(body.nodes) ? body.nodes : []).slice().sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
    for (const n of sorted) {
      const parentNew = n.parent_id ? (idMap.get(Number(n.parent_id)) || null) : null;
      insertNode(gid, parentNew, Number(n.level) || 0, String(n.title || '节点').slice(0, 200),
        String(n.detail || '').slice(0, 2000), Array.isArray(n.sources) ? n.sources.slice(0, 20) : [],
        Number(n.sort_order) || 0, { artifact: String(n.artifact || '').slice(0, 500), acceptance: String(n.acceptance || '').slice(0, 500), hours: String(n.hours || '').slice(0, 50) });
      const newId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      if (Number(n.id)) idMap.set(Number(n.id), newId);
      nodeCount++;
    }
    // 资料库
    let srcCount = 0;
    for (const x of (Array.isArray(body.sources) ? body.sources : []).slice(0, 800)) {
      const title = String(x.title || '').trim().slice(0, 200);
      const content = String(x.content || '').trim().slice(0, 40000);
      if (!title && !content) continue;
      db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at,quality) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(gid, title || '分享的资料', String(x.url || '').slice(0, 500), String(x.site || '来自分享').slice(0, 40),
          String(x.kind || '资料').slice(0, 10), String(x.snippet || content.slice(0, 300)).slice(0, 300),
          content, String(x.published_at || ''), t, x.quality ? 1 : 0);
      srcCount++;
    }
    // 提炼汇总
    let digCount = 0;
    for (const d of (Array.isArray(body.digests) ? body.digests : []).slice(0, 20)) {
      const content = String(d.content || '').slice(0, 30000);
      if (!content.trim()) continue;
      db.prepare('INSERT INTO source_digests (goal_id, topic, title, content, sources_count, created_at) VALUES (?,?,?,?,?,?)')
        .run(gid, String(d.topic || '').slice(0, 60), String(d.title || d.topic || '汇总').slice(0, 120), content, srcCount, t);
      digCount++;
    }
    backup();
    return sendJSON(res, 200, { ok: true, goalId: gid, counts: { nodes: nodeCount, sources: srcCount, digests: digCount }, goal: getGoal(gid) });
  }
  const sourcesAddMatch = p.match(/^\/api\/goals\/(\d+)\/sources$/);
  if (sourcesAddMatch && method === 'POST') {
    const gid = Number(sourcesAddMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 200);
    const content = String(body.content || body.text || '').trim().slice(0, 40000);
    if (!title && !content) return sendJSON(res, 400, { error: '请填写标题或正文' });
    const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at,quality) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(gid, title || '手动添加的资料', String(body.url || '').trim().slice(0, 500),
        String(body.site || '手动添加').slice(0, 40), String(body.kind || '资料').slice(0, 10),
        String(body.snippet || content.slice(0, 300)).slice(0, 300), content, String(body.published_at || ''), nowISO(), body.quality ? 1 : 0);
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), gid);
    backup();
    return sendJSON(res, 200, { ok: true, id: Number(sr.lastInsertRowid), sources: sourcesOf(gid), goal: getGoal(gid) });
  }
  const sourceUpdMatch = p.match(/^\/api\/sources\/(\d+)$/);
  if (sourceUpdMatch && method === 'PUT') {
    const id = Number(sourceUpdMatch[1]);
    const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!row) return sendJSON(res, 404, { error: '资料不存在' });
    const body = await readBody(req);
    const title = body.title != null ? String(body.title).trim().slice(0, 200) : row.title;
    const content = body.content != null ? String(body.content).trim().slice(0, 40000) : row.content;
    const kind = body.kind != null ? String(body.kind).slice(0, 10) : row.kind;
    const quality = body.quality != null ? (body.quality ? 1 : 0) : row.quality;
    db.prepare('UPDATE sources SET title=?, content=?, kind=?, quality=? WHERE id=?').run(title || row.title, content, kind, quality, id);
    backup();
    return sendJSON(res, 200, { ok: true, sources: sourcesOf(row.goal_id) });
  }
  const sourceDelMatch = p.match(/^\/api\/sources\/(\d+)$/);
  if (sourceDelMatch && method === 'DELETE') {
    db.prepare('DELETE FROM sources WHERE id = ?').run(Number(sourceDelMatch[1]));
    backup();
    return sendJSON(res, 200, { ok: true });
  }
  const srcBatchMatch = p.match(/^\/api\/goals\/(\d+)\/sources\/batch-delete$/);
  if (srcBatchMatch && method === 'POST') {
    const gid = Number(srcBatchMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req).catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 2000);
    if (!ids.length) return sendJSON(res, 400, { error: '没有选中的资料' });
    const del = db.prepare('DELETE FROM sources WHERE id = ? AND goal_id = ?');
    let n = 0;
    for (const id of new Set(ids)) { try { n += del.run(id, gid).changes; } catch (e) {} }
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), gid);
    backup();
    return sendJSON(res, 200, { ok: true, deleted: n, sources: sourcesOf(gid) });
  }
  const srcClearMatch = p.match(/^\/api\/goals\/(\d+)\/sources\/clear$/);
  if (srcClearMatch && method === 'POST') {
    const gid = Number(srcClearMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const nSrc = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(gid).n;
    const files = db.prepare('SELECT file FROM jd_images WHERE goal_id = ?').all(gid);
    db.prepare('DELETE FROM sources WHERE goal_id = ?').run(gid);
    db.prepare('DELETE FROM jd_images WHERE goal_id = ?').run(gid);
    let nFile = 0;
    for (const f of files) {
      if (!f.file) continue;
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f.file)); nFile++; } catch (e) {}
    }
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), gid);
    backup();
    return sendJSON(res, 200, { ok: true, deletedSources: nSrc, deletedFiles: nFile, sources: [] });
  }

  const expandMatch = p.match(/^\/api\/nodes\/(\d+)\/expand$/);
  if (expandMatch && method === 'POST') {
    const id = Number(expandMatch[1]);
    let n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!n) return sendJSON(res, 404, { error: '节点不存在' });
    let feedback = '', answers = null;
    try { const b = await readBody(req); feedback = String(b.feedback || '').trim(); if (b && typeof b.answers === 'object') answers = b.answers; } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const tk = tasks.begin({ type: 'expand', title: 'AI 拆分：' + (n ? n.title : ''), goalId: n ? n.goal_id : 0, nodeId: id, note: feedback });
      const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} if (obj && obj.status) tk.progress(undefined, obj.status); };
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
        /* 挂载文件夹的源码：拆分也要读 —— 否则 AI 只能拍脑袋编阶段。
           走共用的 prepareNodeCode（AI 先看清单挑，再读），失败就当没挂，照常拆。 */
        let expandCode = '';
        try {
          const hasFolders = nodeFolders.collectFolderEntries(db, Number(id)).filter(e => !e.missing);
          if (hasFolders.length) {
            send({ status: '正在读挂载文件夹的源码，拆分会沿代码真实结构走…' });
            const g = await nodeFolders.prepareNodeCode({
              aiText, model, db, nodeId: Number(id),
              title: n.title, detail: n.detail, budget: 15000
            });
            if (g.block) {
              expandCode = g.block;
              send({ status: `已读入挂载文件夹的 ${g.list.length} 个源码文件，拆分会沿代码真实结构走…` });
            }
          }
        } catch (e) { console.log('[expand] 文件夹代码载入失败:', e.message); }
        if (feedback) {
          // 带用户意见调整现有子任务
          send({ status: '正在根据你的意见调整划分…' });
          const kids = db.prepare('SELECT title, detail, status FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(n.id);
          const txt = await aiText(buildRefineNodePrompt(goal, n, kids, feedback, expandCode), model, 300000);
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
          if (!answers && goalCompOn(goal.id, 'sources')) {
            const before = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            try {
              await fetchEbooksForGoal(goal, s => send(s), null);
            } catch (e) {
              send({ status: '电子书阶段跳过：' + e.message });
            }
            await collectSources(goal, nodeQueries(n.title), s => send(s));
            const after = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            send({ status: `信息源新增 ${after - before} 条（共 ${after} 条），开始制定拆分计划…`, sources: sourcesOf(goal.id) });
          }
          send({ status: '开始制定拆分计划…' });
          var vid = beginVersion(goal.id, reason);
          const txt = await aiText(buildExpandPrompt(goal, n, null, expandCode), model, 300000);
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
          tk.done({ ok: true });
          send({ done: true, added, goal: getGoal(goal.id), sources: sourcesOf(goal.id), report: report2, versionId: vid });
        }
      } catch (e) {
        /* 失败分支到此为止：绝不能再调 tk.done()，否则 failed 会被覆盖成"✓ 完成"，
           任务失败在任务中心显示成成功，用户完全看不出出了什么事。 */
        tk.fail(e);
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
    let format = 'md', note = '', codeFiles = [], withFolders = true, folderFiles = [];
    try {
      const b = await readBody(req);
      format = b.format === 'html' ? 'html' : 'md';
      note = String(b.note || '').trim().slice(0, 500);
      if (Array.isArray(b.codeFiles)) {
        /* 字符串 = 本程序文件；{root, path} = 挂载文件夹里勾的。
           root 必须确实是本节点（或祖先）挂载过的文件夹 ——
           否则客户端伪造一个 root 就能读服务器上任意目录。 */
        let allowed = [];
        try {
          allowed = nodeFolders.collectFolderEntries(db, n.id).filter(f => !f.missing).map(f => {
            try { return fs.realpathSync(f.path); } catch (e) { return path.resolve(f.path); }
          });
        } catch (e) {}
        for (const x of b.codeFiles) {
          if (typeof x === 'string') { const s = x.slice(0, 160); if (s) codeFiles.push(s); }
          else if (x && typeof x === 'object') {
            const rt = String(x.root || ''), rel = String(x.path || '').slice(0, 160);
            if (!rt || !rel || rel.includes('..')) continue;
            let real = '';
            try { real = fs.realpathSync(rt); } catch (e) { continue; }
            if (!allowed.includes(real)) continue;
            folderFiles.push({ root: real, path: rel });
          }
          if (codeFiles.length + folderFiles.length >= 24) break;
        }
      }
      if (b.withFolders === false) withFolders = false;
    } catch (e) {}
    return streamTutorial(req, res, n, format, note, codeFiles, withFolders, folderFiles);
  }
  const tutEditMatch = p.match(/^\/api\/tutorials\/(\d+)\/edit$/);
  if (tutEditMatch && method === 'POST') {
    const tid = Number(tutEditMatch[1]);
    const tut = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid);
    if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
    const body = await readBody(req).catch(() => ({}));
    const feedback = String((body && body.feedback) || '').trim().slice(0, 1500);
    if (!feedback) return sendJSON(res, 400, { error: '请填写修改意见' });
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(tut.goal_id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(tut.node_id);
    // 修改意见记入对话（刷新也不丢）：调用方传当前会话 id，且必须属于同一目标
    let sess = null;
    const sidRaw = body && body.session_id != null ? Number(body.session_id) : 0;
    if (sidRaw) {
      sess = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sidRaw);
      if (!sess || Number(sess.goal_id) !== Number(tut.goal_id)) return sendJSON(res, 400, { error: '对话不存在或不属于该目标，请刷新后重试' });
    }
    /* 任务重试闭包：重跑「教程修改」，入参与当初完全一致。
       失败时不必把那条修改意见重新打一遍（意见常常很长，重打一遍最容易出错）。 */
    const startEditTask = () => tasks.submit({
      type: 'tutorial', title: '修改教程：' + String(tut.title || '').slice(0, 30), goalId: tut.goal_id, nodeId: tut.node_id, note: feedback,
      retry: startEditTask,
      run: async ({ progress, signal }) => {
        progress(5, '正在按你的意见修改教程…');
        let editCodeBlock = '';
        try {
          const stored = JSON.parse((tut && tut.code_files) || '[]');
          if (Array.isArray(stored) && stored.length) {
            /* code_files 两种形状：老的字符串（相对 APP_DIR）+ 新的 {root, path}
              （文件夹资料源的文件，各读各的 root） */
            const legacy = stored.filter(x => typeof x === 'string');
            const parts = [];
            if (legacy.length) {
              const files = readCodeFiles(APP_DIR, legacy);
              if (files.length) parts.push(buildCodeBlock(files));
            }
            const nf2 = nodeFolders.readStoredCodeFiles(stored);
            if (nf2.length) parts.push(buildCodeBlock(nf2));
            editCodeBlock = parts.join('\n\n');
          }
        } catch (e) { console.log('[tutorial] 修改时源码载入失败:', e.message); }
        const editBase = buildTutorialEditPrompt(goal, node, tut, feedback, tut.format, editCodeBlock);
        const runEdit = async (prompt) => cleanTutorialText(String(await ai.text({ prompt, model: currentModel(), timeoutMs: 600000, signal }) || ''), tut.format);
        let out = await runEdit(editBase);
        /* 模型偷懒有两类，都得再要一次全文，别让用户干等：
           ① 只回了句确认语（"好的，我来改…"）
           ② 更阴的一种：反过来向**我们**要材料 —— "请把上次已输出的尾部粘贴过来"
              （真实翻车日志：'【已输出内容的尾部】后面没有内容，无法确定中断位置'）。
              它把续写提示词当成了新任务，于是吐出 30 字就收工。 */
        const looksLikeAskBack = s => /请(把|将)?[^。]{0,20}(粘贴|提供|发来|贴上)|无法确定|发过来|才能继续/.test(String(s || ''));
        for (let round = 1; round <= 2; round++) {
          if (out && out.length >= 80 && !looksLikeAskBack(out)) break;
          if (!out || !out.length) break;
          console.log('[tutorial] 修改初回只有 ' + out.length + ' 字（' + (looksLikeAskBack(out) ? '模型反过来要我们提供材料' : '疑似确认语') + '），追加指令重试。首字：' + out.slice(0, 60));
          progress(55 + round * 5, 'AI 第一次没给出正文，正在让它直接输出全文…');
          out = await runEdit(editBase + '\n\n【重要】不要只回复确认、解释或道歉，也不要向我索要任何材料 —— 你需要的原文已经完整包含在上面了。现在直接输出修改后的完整教程正文。');
        }
        if (!out || out.length < 80) {
          console.log('[tutorial] 修改失败：清洗后长度 ' + (out ? out.length : 0) + '，原文长度 ' + String(tut.content || '').length);
          throw new Error(out && out.length
            ? 'AI 这次只返回了 ' + out.length + ' 个字（没写出正文），原教程没动：点「🔄 重试」可原样重跑；若反复如此，多半是模型单次输出上限不够，换 deepseek-chat / deepseek-reasoner 会更稳'
            : 'AI 返回内容为空，请重试');
        }
        // 防截断兜底：原文很长、新文却只有一小截时，宁可报错也不覆盖好教程
        const origLen = String(tut.content || '').length;
        progress(80, '正在保存新版本…');
        if (origLen > 3000 && out.length < Math.max(500, Math.floor(origLen * 0.2))) {
          throw new Error('AI 返回内容过短（仅原文 ' + Math.round(out.length / Math.max(1, origLen) * 100) + '%，疑似被截断），原教程没动：点任务上的「🔄 重试」即可原样重跑，或把修改意见拆小一点分多次提');
        }
        /* 结构体检：长度够不代表写完了（线上翻车：目录 12 节、正文只写到第 3 节，
           长度 25k 远超阈值，于是半截教程被当成功写进库，用户点后面几节全没反应）。
           这里改成先自动续写补齐，补不齐就拒收并说明缺什么。 */
        let chk = tutIntegrity(out, tut.format);
        if (!chk.ok) {
          console.log('[tutorial] 修改结果疑似截断：' + chk.issues.join('；'));
          progress(70, '结果被截断，正在让 AI 补全缺失部分…');
          const fixed = await repairTruncatedText({
            raw: out, format: tut.format, title: tut.title, issues: chk.issues,
            runText: (p) => ai.text({ prompt: p, model: currentModel(), timeoutMs: 600000, signal })
          });
          out = fixed.text;
          chk = tutIntegrity(out, tut.format);
          if (!chk.ok) {
            console.log('[tutorial] 续写 2 次仍不完整，拒收。' + chk.issues.join('；'));
            /* 硬截断（缺 </html> 这类结束标记）没法靠续写补：把"为什么"讲清楚，
               免得用户以为是随机故障反复重试 —— 真实原因是模型单次输出上限。 */
            const hard = endsMidway(out, tut.format);
            throw new Error('AI 这次没写完整（已自动续写 2 次仍缺：' + chk.issues.join('；') + '）'
              + (hard ? '。原因：' + hard + ' —— 换 deepseek-chat / deepseek-reasoner 等输出上限更高的模型，或把修改意见拆小一点分多次提' : '')
              + '。原教程没动，点「🔄 重试」可原样重跑');
          }
        }
        // 防跑题兜底：标题留着、正文被换成毫不相干的内容时，长度检查拦不住
        // （线上翻车：RAGFlow 教程被改成离线同步引擎）。命中即拒收，原教程不动。
        const drift = topicDrifted(out, tut.content, [tut.title, node && node.title]);
        if (drift) {
          const missed = (drift.anchorEn.length ? drift.anchorEn : drift.anchorZh.length ? drift.anchorZh : drift.strong).slice(0, 4);
          console.log('[tutorial] 修改疑似跑题，拒收。判定依据：' + drift.used + '；新文正文开头：' + drift.newBody);
          throw new Error('AI 新写的内容疑似跑题（正文里找不到“' + missed.join('”“') + '”等主题词），已保留原教程：请换个说法再提意见，或先问它复述一遍要改什么，确认对了再让它写');
        }
        // 先存旧版（教程版本表），再覆盖正文 —— 改坏了能从历史版本恢复
        try { saveTutorialVersion(tid, 'AI 修改：' + String(feedback || '').slice(0, 100)); } catch (e) {}
        // 保留历史版本（写入 goal_versions 便于回滚），再覆盖教程内容
        try {
          const vid = beginVersion(tut.goal_id, '教程修改：' + String(tut.title || '').slice(0, 20));
          db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(out, nowISO(), tid);
          await finishVersion(goal, vid, '教程修改：' + String(tut.title || '').slice(0, 20), false);
        } catch (e) {
          db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(out, nowISO(), tid);
        }
        progress(100, '修改完成');
        backup();
        return { tutorialId: tid, length: out.length };
      }
    });
    const taskId = startEditTask();
    // 先落库对话记录（任务在后台跑，记录立刻可见；刷新后从会话里读出来）
    if (sess) {
      const t = nowISO();
      try {
        db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)')
          .run(tut.goal_id, sess.id, 'user', ('【教程修改 · ' + String(tut.title || '').slice(0, 40) + '】' + feedback).slice(0, 3000), t);
        db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)')
          .run(tut.goal_id, sess.id, 'assistant', ('收到！已把这条修改意见交给 AI（任务 #' + taskId + '），它会保留原有内容、只改需要改的地方。\n\n进度可以在左下角任务中心看到（切页面也不影响）；完成后教程会自动刷新，也可以点「📜 版本对比」回滚。').slice(0, 3000), t);
        if (!sess.title || sess.title === '新对话') {
          const autoTitle = String(feedback).replace(/\s+/g, ' ').trim().slice(0, 24);
          if (autoTitle) db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(autoTitle, sess.id);
        }
        db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(t, sess.id);
        backup();
      } catch (e) { console.error('[tutEdit] 对话落库失败:', e.message); }
    }
    return sendJSON(res, 200, { ok: true, taskId, sessionId: sess ? sess.id : 0 });
  }
  const tutSaveMatch = p.match(/^\/api\/tutorials\/(\d+)$/);
  if (tutSaveMatch && method === 'PUT') {
    const tid = Number(tutSaveMatch[1]);
    const tut = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid);
    if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
    const body = await readBody(req);
    const content = body.content != null ? String(body.content) : '';
    if (!content.trim()) return sendJSON(res, 400, { error: '内容不能为空' });
    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(tut.goal_id);
    try { saveTutorialVersion(tid, '手动编辑'); } catch (e) {}
    try {
      const vid = beginVersion(tut.goal_id, '手动编辑教程：' + String(tut.title || '').slice(0, 20));
      db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(content, nowISO(), tid);
      await finishVersion(goal, vid, '手动编辑教程：' + String(tut.title || '').slice(0, 20), false);
    } catch (e) {
      db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(content, nowISO(), tid);
    }
    backup();
    return sendJSON(res, 200, { ok: true, length: content.length });
  }
  /* ---- 教程版本：列表 / 取正文 / 恢复 ----
     每次 AI 修改、手动保存覆盖正文前都会先存一份（只留最近 10 版）。
     恢复时先把当前版存一份（“回滚前自动保存”），所以恢复本身也可撤销。 */
  const tutVersMatch = p.match(/^\/api\/tutorials\/(\d+)\/versions$/);
  if (tutVersMatch && method === 'GET') {
    const tid = Number(tutVersMatch[1]);
    if (!db.prepare('SELECT id FROM tutorials WHERE id = ?').get(tid)) return sendJSON(res, 404, { error: '教程不存在' });
    const rows = db.prepare('SELECT id, tutorial_id, reason, LENGTH(content) AS chars, created_at FROM tutorial_versions WHERE tutorial_id = ? ORDER BY id DESC').all(tid);
    return sendJSON(res, 200, { versions: rows });
  }
  const tutVerOneMatch = p.match(/^\/api\/tutorials\/versions\/(\d+)$/);
  if (tutVerOneMatch && method === 'GET') {
    const v = db.prepare('SELECT * FROM tutorial_versions WHERE id = ?').get(Number(tutVerOneMatch[1]));
    if (!v) return sendJSON(res, 404, { error: '该版本不存在' });
    return sendJSON(res, 200, { version: v });
  }
  const tutRestoreMatch = p.match(/^\/api\/tutorials\/(\d+)\/restore$/);
  if (tutRestoreMatch && method === 'POST') {
    const tid = Number(tutRestoreMatch[1]);
    const tut = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid);
    if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
    const body = await readBody(req);
    const v = db.prepare('SELECT * FROM tutorial_versions WHERE id = ? AND tutorial_id = ?').get(Number(body.version_id), tid);
    if (!v) return sendJSON(res, 404, { error: '该版本不存在（或不属于这份教程）' });
    try { saveTutorialVersion(tid, '回滚前自动保存'); } catch (e) {}
    db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(v.content, nowISO(), tid);
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), tut.goal_id);
    backup();
    return sendJSON(res, 200, { ok: true, tutorial: db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid) });
  }
  const tutMatch = p.match(/^\/api\/tutorials\/(\d+)$/);
  if (tutMatch) {
    const id = Number(tutMatch[1]);
    if (method === 'GET') {
      const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(id);
      if (!t) return sendJSON(res, 404, { error: '教程不存在' });
      const node = db.prepare('SELECT id, title, level FROM nodes WHERE id = ?').get(t.node_id);
      const goal = db.prepare('SELECT id, title, plugins FROM goals WHERE id = ?').get(t.goal_id);
      return sendJSON(res, 200, { tutorial: t, node, goal });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM tutorials WHERE id = ?').run(id);
      try { db.prepare('DELETE FROM tutorial_bookmarks WHERE tutorial_id = ?').run(id); } catch (e) {}
      try { db.prepare('DELETE FROM tutorial_progress WHERE tutorial_id = ?').run(id); } catch (e) {}
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
  const planResumeMatch = p.match(/^\/api\/goals\/(\d+)\/plan\/resume$/);
  if (planResumeMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(planResumeMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    return streamPlanResume(req, res, g);
  }
  const planDraftMatch = p.match(/^\/api\/goals\/(\d+)\/plan\/draft$/);
  if (planDraftMatch && method === 'GET') {
    return sendJSON(res, 200, { draft: draftInfo(getPlanDraft(Number(planDraftMatch[1]), 'skeleton')) });
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
/* 问卷答案 → 电子书偏好：认 id/标题里带 ebook 的题；兼容 AI 自造的选项值 */
function extractEbookPrefFromAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  let want = '', booksRaw = '';
  for (const k of Object.keys(answers)) {
    if (!/ebook/i.test(k)) continue;
    const v = answers[k];
    const s = Array.isArray(v) ? String(v[0] || '') : String((v && v.picked) || v || '');
    if (/want/i.test(k)) {
      if (/^(no|n)$/i.test(s.trim()) || /不|否|无|不要/i.test(s)) want = 'no';
      else if (/^auto$/i.test(s.trim()) || /^(yes|y)$/i.test(s.trim()) || /自动|下载|想要|需要/i.test(s)) want = 'auto';
      else if (/^list$/i.test(s.trim()) || /书单|自己|我找/i.test(s)) want = 'list';
      else if (s.trim()) want = 'list';
    } else if (/book/i.test(k)) {
      booksRaw = Array.isArray(v) ? v.join('\n') : s;
    }
  }
  if (!want) return null;
  const books = String(booksRaw || '').split(/[\n,，、；;]+/).map(x => x.trim()).filter(Boolean).slice(0, 10).map(t => {
    let title = t, author = '';
    const m = t.match(/^(.*?)[《〈](.+?)[》〉]\s*$/);
    if (m) { author = m[1].trim().slice(0, 40); title = m[2].trim(); }
    return { title: title.slice(0, 80), author, pitch: '', public_domain: false, where: '', en: '', status: 'pending' };
  });
  return { asked: true, want, books, done: false };
}
  const planMatch = p.match(/^\/api\/goals\/(\d+)\/plan$/);
  if (planMatch && method === 'POST') {
    const id = Number(planMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    let answers = null;
    try { const b = await readBody(req); if (b && typeof b.answers === 'object') answers = b.answers; } catch (e) {}
    if (answers) db.prepare('UPDATE goals SET clarify_answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(answers), nowISO(), id);
    const ebPref = extractEbookPrefFromAnswers(answers);
    if (ebPref) saveEbookPref(id, ebPref);
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

  /* ---- 节点文件夹资料源：挂载 / 移除 / 预览 / 生效列表 ----
     可见性规则：挂在哪个节点，就只有它和它的子孙看得到（读时沿 parent_id 上收）。
     规划、拆分、教程都会自动带上；其它分支的节点不受影响。 */
  const nodeFolderMatch = p.match(/^\/api\/nodes\/(\d+)\/folder$/);
  if (nodeFolderMatch && (method === 'POST' || method === 'DELETE')) {
    const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeFolderMatch[1]));
    if (!n) return sendJSON(res, 404, { error: '节点不存在' });
    const body = await readBody(req);
    const list = nodeFolders.parseNodeSources(n);
    if (method === 'POST') {
      const chk = nodeFolders.validateAttachFolder(body.path, { appDir: APP_DIR, dataDir: DATA_DIR });
      if (!chk.ok) return sendJSON(res, 400, { error: chk.error });
      const name = String(body.name || path.basename(chk.dir)).trim().slice(0, 120) || path.basename(chk.dir);
      const note = String(body.note || '').trim().slice(0, 300);
      const ix = list.findIndex(x => x && x.kind === 'folder' && path.resolve(String(x.path || '')) === chk.dir);
      const entry = { kind: 'folder', path: chk.dir, name, note };
      if (ix >= 0) list[ix] = entry; else list.push(entry);
      db.prepare('UPDATE nodes SET sources = ?, updated_at = ? WHERE id = ?').run(normalizeSources(list), nowISO(), n.id);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
      return sendJSON(res, 200, { ok: true, folders: nodeFolders.collectFolderEntries(db, n.id), goal: getGoal(n.goal_id) });
    } else {
      const target = String(body.path || '').trim();
      if (!target) return sendJSON(res, 400, { error: '缺少 path' });
      const next = list.filter(x => !(x && x.kind === 'folder' && String(x.path || '') === target));
      if (next.length === list.length) return sendJSON(res, 404, { error: '本节点没挂这个文件夹（继承来的不能在这里删，去挂载的节点删）' });
      db.prepare('UPDATE nodes SET sources = ?, updated_at = ? WHERE id = ?').run(normalizeSources(next), nowISO(), n.id);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
      return sendJSON(res, 200, { ok: true, folders: nodeFolders.collectFolderEntries(db, n.id), goal: getGoal(n.goal_id) });
    }
  }
  const nodeFoldersMatch = p.match(/^\/api\/nodes\/(\d+)\/folders$/);
  if (nodeFoldersMatch && method === 'GET') {
    const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeFoldersMatch[1]));
    if (!n) return sendJSON(res, 404, { error: '节点不存在' });
    return sendJSON(res, 200, { folders: nodeFolders.collectFolderEntries(db, n.id) });
  }
  if (p === '/api/node-folders/preview' && method === 'GET') {
    /* 挂之前先看一眼里面有什么：文件数 + 前 30 个 + 有没有 README */
    const chk = nodeFolders.validateAttachFolder(u.searchParams.get('path'), { appDir: APP_DIR, dataDir: DATA_DIR });
    if (!chk.ok) return sendJSON(res, 400, { error: chk.error });
    let files = [];
    try { files = listCodeFiles(chk.dir); } catch (e) {
      return sendJSON(res, 500, { error: '列不出来：' + (e.message || e) });
    }
    return sendJSON(res, 200, {
      dir: chk.dir, total: files.length,
      top: files.slice(0, 30),
      hasReadme: files.some(f => /(^|\/)readme/i.test(f.path))
    });
  }
  if (p === '/api/node-folders/files' && method === 'GET') {
    /* 教程对话框里勾选用：返回完整可读清单（前端只渲染前 300，靠搜索筛）。
       同样走挂载校验 —— 没挂过的目录不给列。 */
    const chk = nodeFolders.validateAttachFolder(u.searchParams.get('path'), { appDir: APP_DIR, dataDir: DATA_DIR });
    if (!chk.ok) return sendJSON(res, 400, { error: chk.error });
    let files = [];
    try { files = listCodeFiles(chk.dir); } catch (e) {
      return sendJSON(res, 500, { error: '列不出来：' + (e.message || e) });
    }
    return sendJSON(res, 200, { dir: chk.dir, files });
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

  /* ---- 后台 AI 任务（切换页面不影响；可并行、可取消） ---- */
  if (p === '/api/tasks' && method === 'GET') {
    const gid = Number(u.searchParams.get('goalId') || 0);
    return sendJSON(res, 200, { tasks: tasks.list(gid || 0), status: tasks.status() });
  }
  const taskCancelMatch = p.match(/^\/api\/tasks\/(\d+)\/cancel$/);
  if (taskCancelMatch && method === 'POST') {
    return sendJSON(res, 200, tasks.cancel(Number(taskCancelMatch[1])));
  }
  /* 失败重试：用当初那份入参重新提交一个新任务（用户不用把意见/命令再打一遍）。
     旧任务保留（还能看到它当时的报错），新任务是独立的一条。 */
  const taskRetryMatch = p.match(/^\/api\/tasks\/(\d+)\/retry$/);
  if (taskRetryMatch && method === 'POST') {
    return sendJSON(res, 200, await tasks.retry(Number(taskRetryMatch[1])));
  }
  if (p === '/api/tasks/clear' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return sendJSON(res, 200, tasks.clear(b && b.goalId ? Number(b.goalId) : 0));
  }

  /* ---- 更新检查与一键更新 ---- */
  /* 关监听端口（给更新重启用）：已建立的连接不受影响，响应照常发完；
     新连接不再接受。1500ms 还关不掉就放弃等待直接继续。 */
  function closeHttpServer() {
    return new Promise(resolve => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try {
        if (server.closeIdleConnections) { try { server.closeIdleConnections(); } catch (e) {} }
        server.close(fin);
        setTimeout(fin, 1500);
      } catch (e) { fin(); }
    });
  }
  if (p === '/api/update/status' && method === 'GET') {
    return sendJSON(res, 200, update.state);
  }
  if (p === '/api/update/check' && method === 'POST') {
    return sendJSON(res, 200, await update.check(true));
  }
  if (p === '/api/update/apply' && method === 'POST') {
    /* 打包版走 payload 后端：只换 450KB 的程序文件，不碰 git */
    try { return sendJSON(res, 200, update.mode() === 'payload' ? await update.applyPayload() : await update.apply()); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  if (p === '/api/update/restart' && method === 'POST') {
    /* payload 版：先回响应，再关端口、拉新实例、退出旧进程。
       顺序不能乱 —— 响应要在关端口前发出去（已建立的连接不受 close 影响），
       新实例要在端口空闲后拉（老启动器只认空闲端口），旧进程最后退出。 */
    if (update.mode() === 'payload') {
      try {
        const r = await update.restartPayload(closeHttpServer);
        sendJSON(res, 200, r);
        if (r.restarting) setTimeout(() => process.exit(0), 800);
        return;
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    }
    return sendJSON(res, 200, update.restart());
  }

  if (p === '/api/sync/status' && method === 'GET') {
    return sendJSON(res, 200, await sync.status());
  }

  /* ===== 数据存放位置（可改 / 可迁移） =====
     切换后 DATA_DIR 已被各模块按值捕获，所以一律要求重启才生效 ——
     明确告诉前端 restartRequired，由它决定要不要立刻拉一次重启。 */
  if (p === '/api/data-location' && method === 'GET') {
    return sendJSON(res, 200, dataDir.status(APP_DIR));
  }
  if (p === '/api/data-location/pick' && method === 'POST') {
    /* 拉起系统自带的目录选择器（PowerShell / osascript / zenity / kdialog）。
       弹窗要等用户选，可能挂几分钟，所以异步跑、结果写临时文件，前端轮询。 */
    if (!dataDir.canPick()) {
      return sendJSON(res, 400, { error: '这个系统没有可用的图形目录选择器，请直接把路径粘进来' });
    }
    const r = dataDir.startPick();
    return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true, poll: '/api/data-location/pick' } : r);
  }
  if (p === '/api/data-location/pick' && method === 'GET') {
    return sendJSON(res, 200, dataDir.takePick());
  }
  if (p === '/api/data-location/progress' && method === 'GET') {
    /* 几 GB 的复制要几十秒，前端靠这个接口画进度条（不然就一行字干等，像死机） */
    return sendJSON(res, 200, dataDir.progress());
  }
  if (p === '/api/data-location/apply' && method === 'POST') {
    const body = await readBody(req);
    const mode = body.mode === 'copy' ? 'copy' : 'move';
    let r;
    try {
      if (body.reset) r = dataDir.resetToDefault(APP_DIR);
      else if (body.use_existing) r = dataDir.useExisting(APP_DIR, String(body.dir || '').trim());
      else r = dataDir.migrate(APP_DIR, String(body.dir || '').trim(), mode);
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    if (!r.ok) return sendJSON(res, 400, r);
    /* 成功了就顺手打一份备份（备份会落到新目录里，是用户要的） */
    try { backup('数据目录迁移'); } catch (e) {}
    return sendJSON(res, 200, r);
  }
  if (p === '/api/data-location/restart' && method === 'POST') {
    /* 迁移完立刻重启，省得用户手动来一下 */
    try {
      const r = await update.restartPayload(closeHttpServer);
      sendJSON(res, 200, r);
      if (r.restarting) setTimeout(() => process.exit(0), 800);
      return;
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  if (p === '/api/data-location/check' && method === 'POST') {
    /* 只体检不搬：设置页让用户先看清「这个目录行不行、要多大空间」 */
    const body = await readBody(req);
    const dir = String(body.dir || '').trim();
    if (!dir) return sendJSON(res, 400, { error: '先填一个目录' });
    const u = dataDir.usage(DATA_DIR);
    return sendJSON(res, 200, { ...dataDir.checkTarget(dir, u.bytes), need: u.bytes, src: DATA_DIR, srcBytes: u.bytes });
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
  /* 冲突二选一：choice = remote（用云端覆盖本地）/ local（保留本地并上传） */
  if (p === '/api/sync/resolve' && method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJSON(res, 200, await sync.resolve(body && body.choice));
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
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
  /* 电子书偏好：搜集前 AI 问用户要不要书，需要哪些（问卷答案 / 手动搜集前弹窗都会写到这里） */
  const ebPrefMatch = p.match(/^\/api\/goals\/(\d+)\/ebooks\/pref$/);
  if (ebPrefMatch) {
    const gid = Number(ebPrefMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    if (method === 'GET') return sendJSON(res, 200, { pref: getEbookPref(g) });
    if (method === 'POST') {
      const body = await readBody(req);
      const want = ['auto', 'list', 'no'].includes(body.want) ? body.want : 'no';
      const raw = Array.isArray(body.books) ? body.books : [];
      const books = raw.map(b => {
        if (typeof b === 'string') return { title: b.slice(0, 80), author: '', pitch: '', public_domain: false, where: '', en: '' };
        return { title: String((b && b.title) || '').slice(0, 80), author: String((b && b.author) || '').slice(0, 40), pitch: String((b && b.pitch) || '').slice(0, 80), public_domain: !!((b && b.public_domain)), where: String((b && b.where) || '').slice(0, 40), en: String((b && b.en) || '').slice(0, 80) };
      }).filter(b => b.title).slice(0, 10).map(b => ({ ...b, status: 'pending' }));
      const pref = { asked: true, want, books, done: false };
      saveEbookPref(gid, pref);
      return sendJSON(res, 200, { ok: true, pref });
    }
  }
  const ebRecMatch = p.match(/^\/api\/goals\/(\d+)\/ebooks\/recommend$/);
  if (ebRecMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(ebRecMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    try {
      const books = await recommendEbooks(g);
      return sendJSON(res, 200, { books });
    } catch (e) {
      return sendJSON(res, 200, { books: [], error: e.message });
    }
  }
  /* 搜集方案：用户说明/选择搜什么（存目标上，重复搜集沿用） */
  const cpMatch = p.match(/^\/api\/goals\/(\d+)\/collect-plan$/);
  if (cpMatch) {
    const gid = Number(cpMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    if (method === 'GET') return sendJSON(res, 200, { plan: getCollectPlan(g) });
    if (method === 'POST') {
      const body = await readBody(req);
      const raw = Array.isArray(body.queries) ? body.queries : [];
      const queries = raw.map(q => ({
        kind: String((q && q.kind) || '资料').slice(0, 10),
        q: String((q && q.q) || '').slice(0, 120),
        days: Math.min(730, Math.max(30, Number((q && q.days)) || 365)),
        on: (q && q.on) !== false
      })).filter(q => q.q).slice(0, 20);
      const plan = { asked: true, queries, updatedAt: nowISO() };
      saveCollectPlan(gid, plan);
      return sendJSON(res, 200, { ok: true, plan });
    }
  }
  const cpRecMatch = p.match(/^\/api\/goals\/(\d+)\/collect-plan\/recommend$/);
  if (cpRecMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(cpRecMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    try {
      const queries = await recommendCollectPlan(g);
      return sendJSON(res, 200, { queries });
    } catch (e) {
      return sendJSON(res, 200, { queries: [], error: e.message });
    }
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
      const isCore = BUILTIN_COMPONENTS.some(x => x.id === pid && x.scope === 'core');
      const manageable = manageableCompIds().includes(pid) || PLUGINS.some(x => x.id === pid);
      if (isCore || !manageable) return sendJSON(res, 404, { error: '插件不存在或不可按目标管理' });
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

  /* ---- AI 连接与模型池 ----
     模型 id 形如 '连接id::模型名'。对话栏选模型、设置页取列表都走这里。 */
  if (p === '/api/ai/providers' && method === 'GET') {
    return sendJSON(res, 200, { providers: ai.PROVIDERS });
  }
  /* 可添加的 Agent 类型（以后加 codex 之类只在服务端添一项） */
  if (p === '/api/ai/agents' && method === 'GET') {
    return sendJSON(res, 200, { agents: ai.AGENTS });
  }
  /* 按 Agent 类型探测本机装没装（?agent=opencode，缺省 opencode） */
  if (p === '/api/ai/agent-status' && method === 'GET') {
    const st = ai.agentStatus(u.searchParams.get('agent') || 'opencode');
    if (st.installed) ai.ensureOpencodeAgent();
    return sendJSON(res, 200, st);
  }
  /* opencode 装没装。设置页在列出 opencode 模型前先探这个，
     免得用户点了才发现没装、界面上却没有「检测」这一步。 */
  if (p === '/api/ai/opencode-status' && method === 'GET') {
    const st = ai.opencodeStatus();
    if (st.installed) ai.ensureOpencodeAgent();
    return sendJSON(res, 200, st);
  }
  if (p === '/api/ai/connections' && method === 'GET') {
    return sendJSON(res, 200, { connections: ai.connections() });
  }
  if (p === '/api/ai/connections' && method === 'POST') {
    const body = await readBody(req);
    /* 整体提交：设置页「保存」时一次存完，避免前端为每条连接各调一次 */
    if (!body || !Array.isArray(body.connections)) return sendJSON(res, 400, { error: '缺少 connections' });
    ai.saveConnections(body.connections);
    /* 用到 opencode Agent 才生成 .opencode/opencode.json（不用就不生成） */
    try {
      const list = ai.connections();
      if (list.some(c => c.enabled && c.kind === 'agent' && (c.providerId === 'opencode' || c.provider === 'opencode'))) ai.ensureOpencodeAgent();
    } catch (e) {}
    return sendJSON(res, 200, { ok: true, connections: ai.connections(), pool: ai.modelPool() });
  }
  /* 取某条连接（或一段草稿）的模型列表。草稿也能取，供设置页「填完先试一下」。 */
  if (p === '/api/ai/models-for' && method === 'GET') {
    const id = u.searchParams.get('conn') || '';
    const r = await ai.modelsFor({ id: id || undefined, baseUrl: u.searchParams.get('base') || undefined });
    return sendJSON(res, 200, { models: r.models || [], error: r.error || '', detail: r.detail || '' });
  }
  if (p === '/api/ai/models-for' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) {}
    const r = await ai.modelsFor(body || {});
    return sendJSON(res, 200, { models: r.models || [], error: r.error || '', detail: r.detail || '' });
  }
  if (p === '/api/ai/pool' && method === 'GET') {
    return sendJSON(res, 200, { pool: ai.modelPool() });
  }
  if (p === '/api/ai/status' && method === 'GET') {
    // visionModel 返回「实际会用的」视觉模型（含 opencode 默认值），前端据此提示
    return sendJSON(res, 200, { ...ai.status(), visionModel: currentVisionModel(), visionModelSaved: getSetting('vision_model', '') || '', env: { base: !!process.env.SIERXING_API_BASE || !!process.env.OPENAI_BASE_URL, key: !!process.env.SIERXING_API_KEY || !!process.env.OPENAI_API_KEY } });
  }
  if (p === '/api/ai/test' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) {}
    const r = await ai.test(body || {});
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
    let tutorialVersions = [];
    try { tutorialVersions = db.prepare('SELECT * FROM tutorial_versions ORDER BY id').all(); } catch (e) {}
    const pluginData = {};
    for (const pl of PLUGINS) { try { if (typeof pl.exportData === 'function') pluginData[pl.id] = pl.exportData(pluginCtx()); } catch (e) {} }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('思而行-导出-' + stamp() + '.json')}`
    });
    return res.end(JSON.stringify({ exportedAt: nowISO(), goals, nodes, sources, tutorials, tutorialVersions, settings, pluginData }, null, 2));
  }
  if (p === '/api/import/json' && method === 'POST') {
    const body = await readBody(req);
    const goals = Array.isArray(body.goals) ? body.goals : [];
    if (!goals.length) return sendJSON(res, 400, { error: '没有可导入的目标' });
    backup();
    db.exec('DELETE FROM nodes; DELETE FROM sources; DELETE FROM goals; DELETE FROM goal_versions; DELETE FROM tutorials; DELETE FROM tutorial_versions; DELETE FROM chats; DELETE FROM chat_sessions;');
    for (const pl of PLUGINS) { try { if (typeof pl.clearAll === 'function') pl.clearAll(pluginCtx()); } catch (e) {} }
    const insG = db.prepare('INSERT INTO goals (id,title,profile,materials,weekly_hours,deadline,status,error,summary,constraints,plugins,ebook_pref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const g of goals) insG.run(g.id != null ? Number(g.id) : null, g.title || '', g.profile || '', g.materials || '', g.weekly_hours || '', g.deadline || '', g.status || 'draft', g.error || '', g.summary || '', typeof g.constraints === 'string' ? g.constraints : JSON.stringify(g.constraints || []), typeof g.plugins === 'string' ? g.plugins : JSON.stringify(g.plugins || {}), typeof g.ebook_pref === 'string' ? g.ebook_pref : JSON.stringify(g.ebook_pref || {}), g.created_at || nowISO(), g.updated_at || nowISO());
    const insN = db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of (Array.isArray(body.nodes) ? body.nodes : [])) insN.run(n.id != null ? Number(n.id) : null, Number(n.goal_id), n.parent_id ? Number(n.parent_id) : null, Number(n.level || 0), n.title || '', n.detail || '', n.artifact || '', n.acceptance || '', n.hours || '', typeof n.sources === 'string' ? n.sources : JSON.stringify(n.sources || []), n.status || 'todo', Number(n.sort_order || 0), n.created_at || nowISO(), n.updated_at || nowISO());
    const insT = db.prepare('INSERT INTO tutorials (id,goal_id,node_id,title,format,content,code_files,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const t of (Array.isArray(body.tutorials) ? body.tutorials : [])) insT.run(t.id != null ? Number(t.id) : null, Number(t.goal_id), Number(t.node_id), t.title || '', t.format || 'md', t.content || '', typeof t.code_files === 'string' ? t.code_files : JSON.stringify(t.code_files || []), t.created_at || nowISO(), t.updated_at || nowISO());
    const insTV = db.prepare('INSERT INTO tutorial_versions (id,tutorial_id,content,reason,created_at) VALUES (?,?,?,?,?)');
    for (const v of (Array.isArray(body.tutorialVersions) ? body.tutorialVersions : [])) {
      if (v.tutorial_id == null || !v.content) continue;
      insTV.run(v.id != null ? Number(v.id) : null, Number(v.tutorial_id), String(v.content), String(v.reason || '').slice(0, 120), v.created_at || nowISO());
    }
    const insS = db.prepare('INSERT INTO sources (id,goal_id,title,url,site,kind,snippet,content,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const s of (Array.isArray(body.sources) ? body.sources : [])) insS.run(s.id != null ? Number(s.id) : null, Number(s.goal_id), s.title || '', s.url || '', s.site || '', s.kind || '', s.snippet || '', s.content || '', s.created_at || nowISO());
    for (const pl of PLUGINS) {
      try { if (typeof pl.importData === 'function') pl.importData((body.pluginData || {})[pl.id], pluginCtx()); } catch (e) { console.error('[plugin]', pl.id, '导入失败:', e.message); }
    }
    return sendJSON(res, 200, { ok: true, goals: goals.length });
  }

  const versionsMatch = p.match(/^\/api\/goals\/(\d+)\/versions$/);
  if (versionsMatch && method === 'GET') {
    const rows = db.prepare('SELECT id, goal_id, reason, summary, manual, starred, created_at FROM goal_versions WHERE goal_id = ? ORDER BY starred DESC, id DESC LIMIT 60').all(Number(versionsMatch[1]));
    return sendJSON(res, 200, { versions: rows });
  }
  if (versionsMatch && method === 'POST') {
    // 手动保存当前方案（命名存档，随时恢复）
    const gid = Number(versionsMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req).catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 40) || '手动存档';
    const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(gid);
    if (!nodes.length) return sendJSON(res, 400, { error: '当前还没有路径可存' });
    const r = db.prepare('INSERT INTO goal_versions (goal_id, reason, snapshot, summary, manual, created_at) VALUES (?,?,?,?,?,?)')
      .run(gid, name, JSON.stringify(nodes), '', 1, nowISO());
    backup();
    const rows = db.prepare('SELECT id, goal_id, reason, summary, manual, starred, created_at FROM goal_versions WHERE goal_id = ? ORDER BY starred DESC, id DESC LIMIT 60').all(gid);
    return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid), versions: rows });
  }
  const verStarMatch = p.match(/^\/api\/versions\/(\d+)\/star$/);
  if (verStarMatch && method === 'POST') {
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(Number(verStarMatch[1]));
    if (!v) return sendJSON(res, 404, { error: '版本不存在' });
    const body = await readBody(req).catch(() => ({}));
    const on = body.starred != null ? !!body.starred : !v.starred;
    db.prepare('UPDATE goal_versions SET starred = ? WHERE id = ?').run(on ? 1 : 0, v.id);
    backup();
    return sendJSON(res, 200, { ok: true, starred: on });
  }
  const verRestoreMatch = p.match(/^\/api\/versions\/(\d+)\/restore$/);
  if (verRestoreMatch && method === 'POST') {
    // 恢复到指定版本：先自动存档当前（可再 undo），再整体替换节点（含进度状态）
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(Number(verRestoreMatch[1]));
    if (!v) return sendJSON(res, 404, { error: '版本不存在' });
    const snap = safeParse(v.snapshot) || [];
    if (!snap.length) return sendJSON(res, 400, { error: '这个版本是空快照，无法恢复' });
    const gid = v.goal_id;
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    beginVersion(gid, '恢复版本前自动存档');
    db.prepare('DELETE FROM nodes WHERE goal_id = ?').run(gid);
    try { db.prepare('DELETE FROM node_workspaces WHERE goal_id = ?').run(gid); } catch (e) {}
    const sorted = snap.slice().sort((a, b) => ((a.level || 0) - (b.level || 0)) || ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)));
    const idMap = new Map();
    const t = nowISO();
    for (const n of sorted) {
      const newParent = n.parent_id ? (idMap.get(n.parent_id) || null) : null;
      insertNode(gid, newParent, n.level || 0, n.title, n.detail, safeParse(n.sources) || [], n.sort_order || 0,
        { artifact: n.artifact, acceptance: n.acceptance, hours: n.hours });
      const nid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      idMap.set(n.id, nid);
      if (n.status && n.status !== 'todo') db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(n.status, nid);
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(gid).c;
    db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'planned' : 'draft', '', t, gid);
    backup();
    return sendJSON(res, 200, { ok: true, goal: getGoal(gid) });
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
      /* 独立识图配置回显（密钥只回有没有，不给明文） */
      vis_base_url: getSetting('vis_base_url', ''),
      vis_has_key: !!getSetting('vis_api_key', ''),
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
    /* 独立识图配置（与对话连接分开）：地址留空 = 不启用，密钥留空 = 不修改 */
    if (body.vis_base_url != null) set('vis_base_url', body.vis_base_url);
    if (body.vis_api_key != null && String(body.vis_api_key).trim() && !/^•+$/.test(String(body.vis_api_key).trim())) set('vis_api_key', body.vis_api_key);
    if (body.vis_api_key === '') setSetting('vis_api_key', '');
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
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.azw': 'application/x-mobipocket-ebook', '.azw3': 'application/x-mobipocket-ebook' }[ext] || 'application/octet-stream';
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
    let out = buf;
    if (rel === 'index.html') {
      // 入口页注入版本戳：发版/重启后前端必加载最新 js/css，不再被缓存坑
      let html = buf.toString('utf8');
      html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta name="asset-v" content="' + ASSET_V + '">');
      html = html.replace('href="/style.css"', 'href="/style.css?v=' + ASSET_V + '"');
      html = html.replace('src="/sdk.js"', 'src="/sdk.js?v=' + ASSET_V + '"');
      html = html.replace('src="/app.js"', 'src="/app.js?v=' + ASSET_V + '"');
      out = Buffer.from(html);
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(out);
  });
}

const server = http.createServer(async (req, res) => {  let u;
  try {
    u = new URL(req.url, `http://localhost:${PORT}`);
  } catch (e) {
    /* ⚠️ 畸形请求行（例如 "//"）会让 new URL 直接抛异常。
       它原来写在下面那个 try 的**外面**，抛出后成为 unhandledRejection，
       Node 会**整个进程退出** —— 一次手滑的 URL / 代理转发就能让应用挂掉、
       正在进行的会话全丢。这里挡下来回 400。 */
    try { sendJSON(res, 400, { error: '非法请求地址' }); } catch (e2) { try { res.end(); } catch (e3) {} }
    return;
  }
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
    sync.pull().then(r => console.log('[sync] 启动拉取:', r.conflict ? '检测到冲突，需在设置页手动二选一' : (r.imported ? ('已导入来自 ' + r.device + ' 的数据') : r.message)))
      .catch(e => console.log('[sync] 启动拉取失败:', e.message));
  }
  update.startAutoCheck();   // 启动后台检查远端是否有新版本（不阻塞、失败静默）
  console.log(`思而行(SiErXing) started: http://localhost:${PORT}`);
  console.log('数据文件: ' + DB_PATH);
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

/* 本地单进程应用：一次没接住的异常不该让整个服务退出（正在进行的会话、番茄钟、
   同步都会丢）。这里只记日志、不退出；真正的 bug 依然会留在日志里可查。
   Node 默认对 unhandledRejection 是直接终止进程的。 */
process.on('unhandledRejection', e => { console.error('[未捕获的 Promise 拒绝]', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.error('[未捕获的异常]', (e && e.stack) || e); });
