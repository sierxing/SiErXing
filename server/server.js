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
const { loadPlugins, pluginMeta, matchRoute, kernelState } = require('./plugins');
const createService = require('./service');
const createSync = require('./sync');
const { createBackupDomain } = require('./domains/backups');
const { createVersionDomain } = require('./domains/versions');
const { createGoalDomain } = require('./domains/goals');
const { createSourceDomain } = require('./domains/sources');
const { createConditionsDomain } = require('./conditions');
const createUpdate = require('./update');
const createTasks = require('./tasks');
const metrics = require('./metrics');
const { readCodeFiles, buildCodeBlock, listCodeFiles } = require('./code-read');
const nodeFolders = require('./node-folders');
const codeStore = require('./code-store');
const rag = require('./rag');
/* 拉起 GUI 程序（VSCode / 浏览器）前补一份显示环境：开机自启起的实例不在桌面会话里 */
const { guiEnv } = require('./gui-env');
/* 教程分节生成（规划 / 逐节 / 自检）。提示词块在下面才定义，
   所以这里先占位，等函数都声明完再初始化（见文件末尾 tutPlanInit）。 */
let tutPlan = null;
/* 教程局部修改（补丁）：判断改动规模 + 解析/套用补丁，纯文本处理 */
const tutPatch = require('./tut-patch');
/* 改教程的结构守卫：判断这次改动是不是把不该动的章节改掉了（纯文本处理） */
const tutGuard = require('./tut-guard');
/* 长教程的「分节改写」：只把要改的那一段切块发过去、改完拼回整篇（纯文本处理） */
const tutSeg = require('./tut-seg');
/* 信息源「AI 把关」：搜回来的一批候选逐条判读（相关度/实质/营销/主题/摘要），只让高质量的进库 */
const collectScreen = require('./collect-screen');
/* 正文清洗：抓下来的网页里混着的导航/推荐/页脚/公众号引导等垃圾文字（本地规则 + 可选 AI 只删不改） */
const textClean = require('./text-clean');
/* 提示词上下文块（纯函数）：从 server.js 抽出的共享块，供各提示词复用。
   ⚠️ 这里只能放纯函数：不查 DB、不读 settings、不 require server.js。 */
const promptContext = require('./prompts/context');
const { goalHeader, richMdSpecLines, vizSpecLines, qaRender } = promptContext;
/* 「当前页面」上下文（纯函数）：AI 助手常驻每个页面后，用户说的"这个/这里"要能对上
   屏幕上那段内容。前端抓当前页文字随消息上来，这里清洗 + 限量 + 拼成提示词块。 */
const pageContext = require('./prompts/page-context');
/* 提示词包注册表：内置模板来自 server/prompts/packs.js，用户覆盖存本机 DB。
   启动时创建一次；server.js 只负责按 ctx 渲染，不在这里塞提示词正文。 */
const createPromptRegistry = require('./prompts/registry');
const tutorialRules = require('./prompts/tutorial-rules');
const componentPipeline = require('./component-pipeline');
/* 国际化（界面语言）：language/ 是文案唯一权威来源，见 language/README.md */
const createLanguage = require('../language');
const createLanguageGenerator = require('../language/generate');
const chatPacks = require('./prompts/chat-packs');
/* 审批页：Agent 发起的危险操作，让用户在浏览器里点批准/拒绝（本机、无外链） */
const renderApprovalPage = require('./approvals-page');
const renderComponentPreviewPage = require('./component-preview-page');
/* 结构改动"挂起等用户点头"的记录：goalId:tutorialId → { feedback, at }。
   ⚠️ 必须放模块级：写到请求处理函数里会每次请求都新建一个，挂起状态当场就丢
   （真实踩到：① 先问用户要不要改结构 ② 用户回"可以" 又变成"先问"，永远点不动）。 */
const PENDING_EDIT = new Map();
/* 用户表示"同意"的开头词（"可以""就这样改""确认"…）——用来认自然语言确认 */
const CONFIRM_WORDS = /^(可以|好的|好|行|嗯|对|是|可以了|就这么改|就这样改|就这样|按这个来|没问题|同意|确认|确定|开跑|开始|动手|改吧|继续|OK)/i;
/* 复杂度判断：决定每个 AI 功能该花多大力气（纯启发式，不花 AI 调用） */
const effort = require('./ai-effort');

const APP_DIR = path.resolve(__dirname, '..');
/* 前端资源版本戳：启动时对 public 下的 js/css 求哈希，发版后浏览器必取新文件。
   用内容哈希而不用时间戳：只改后端重启时不打扰前端，避免误报“有新版”。 */
/* 数据存放位置可改（设置页 →「数据存储路径」）：默认程序目录下的 data/，
   改过之后指针写在 APP_DIR/data-location.json（指针不能跟着数据一起挪走）。
   切换/迁移后必须重启 —— DATA_DIR 在启动时被插件、同步、上传按值捕获。 */
const dataDir = require('./data-dir');
const { createUiPluginRegistry } = require('./ui-plugins');
const { createCreateMode } = require('./create-mode');
const { createKernelConfig } = require('./kernel-config');
const DATA_DIR = dataDir.readPointer(APP_DIR).dir;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'sierxing.db');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
/* 内置 UI 插件源码目录（页面插件住这里，而不是 public/ 构建产物区） */
const UI_PLUGIN_DIR_BUILTIN = path.join(APP_DIR, 'ui', 'plugins', 'builtin');
/* 前端资源版本戳：启动时对 public 下的 js/css 求内容哈希，发版后浏览器必取新文件。
   用内容哈希而不用时间戳：只改后端重启时不打扰前端。必须在 PUBLIC_DIR 之后定义，
   否则会撞 TDZ、哈希恒为空串的 sha256（e3b0c442…），版本戳形同虚设。 */
const ASSET_V = (() => {
  try {
    const crypto = require('node:crypto');
    const h = crypto.createHash('sha256');
    const files = ['index.html', 'app.js', 'sdk.js', 'style.css', 'i18n.js'];
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
/* 备份领域：实现已抽到 server/domains/backups.js；这里只做组装。 */
const backups = createBackupDomain({
  dbPath: DB_PATH,
  backupDir: BACKUP_DIR,
  getSetting: getSetting,
  nowStamp: stamp,
  onDataChange: function () { try { if (sync) sync.schedulePush('数据变更'); } catch (e) {} }
});
const keepBackups = backups.keepBackups;
const backupList = backups.backupList;
const pruneBackups = backups.pruneBackups;
const backupDiff = backups.backupDiff;
const backup = backups.backup;
const APP_NAME = '思而行';

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LEVEL_NAME = { 0: '阶段', 1: '小目标', 2: '任务' };

/* 指针指向的目录可能已经不存在（比如用户拔了移动硬盘）—— 重建空的，别让程序起不来 */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('数据目录不可用：' + DATA_DIR + '（' + (e.message || e) + '）'); }
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
/* 用户 UI 插件：放数据目录，程序更新不覆盖；服务端只读 manifest 与入口文件。
   同时扫描内置页面插件（APP_DIR/ui/plugins/builtin），供 DIY 管理页展示「内置 vs 用户覆盖」。 */
const uiPlugins = createUiPluginRegistry({ dir: path.join(DATA_DIR, 'ui-plugins'), builtinDir: UI_PLUGIN_DIR_BUILTIN });
/* 用户级功能组件目录（创造模式 / 用户导入安装）：只写数据目录，升级不冲突。
   - plugins/ 放服务端组件（server/plugins 同款契约）
   - plugins-client/ 放前端脚本与样式（等价于 public/plugins，由 serveStatic 兜底路由） */
const USER_PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
const USER_PUBLIC_PLUGIN_DIR = path.join(DATA_DIR, 'plugins-client');

/* 分层配置（P3）：builtin(config/kernel.schema.json) < profile < user。
   用户改 DATA_DIR/config/user.json 即可开关页面插件 / 用户插件 / 皮肤，升级不会覆盖。 */
let kernelConfig = null;
try {
  kernelConfig = createKernelConfig({
    schemaPath: path.join(APP_DIR, 'config', 'kernel.schema.json'),
    dataDir: DATA_DIR,
    log: (...a) => console.log(...a)
  });
  for (const w of kernelConfig.warnings()) {
    console.log('[config] ' + w.level + '：' + (w.key ? w.key + ' — ' : '') + w.message);
  }
} catch (e) {
  console.error('[config] 分层配置校验失败，已忽略严格模式并使用内置默认：' + e.message);
  try {
    kernelConfig = createKernelConfig({
      schemaPath: path.join(APP_DIR, 'config', 'kernel.schema.json'),
      dataDir: DATA_DIR, ignoreStrict: true, log: (...a) => console.log(...a)
    });
  } catch (e2) {
    console.error('[config] 分层配置加载失败，全部使用内置默认：' + e2.message);
    kernelConfig = null;
  }
}

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
/* 达成条件：阶段 ≠ 条件。一个目标的路线图节点（阶段/小目标/任务）都归到某条条件下面，
   条件自己带可验收的判定标准；组件页据此看每条条件的推进进度与对应节点。
   nodes.condition_id 由下面的 migrate 补列（旧库），不在这里重复 ALTER。 */
CREATE TABLE IF NOT EXISTS goal_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  jd_ref TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'must',
  source TEXT NOT NULL DEFAULT 'plan',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_conditions_goal ON goal_conditions(goal_id, sort_order);
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
/* 导入代码库的完整文件快照（只读、已脱敏）：AI 助手对话时按问题从这里检索。
   不进 SYNC_TABLES —— 路径与内容跟设备绑定、体积大，各设备自己导入一份即可，
   跨设备同步互相覆盖没意义（同 review_plans 的理由）。 */
CREATE TABLE IF NOT EXISTS code_repo_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL DEFAULT 0,
  root TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crf_goal ON code_repo_files(goal_id);
/* 知识库检索索引（RAG）：资料按块切分 + 可选向量，可随时重建的派生数据。
   同样不进 SYNC_TABLES（向量与本机配置/模型相关，各端自己建即可）。 */
CREATE TABLE IF NOT EXISTS source_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  src_hash TEXT NOT NULL DEFAULT '',
  vec TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_goal ON source_chunks(goal_id, source_id);
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
ai.init({ getSetting: (k, d) => getSetting(k, d), setSetting: (k, v) => setSetting(k, v), appDir: APP_DIR, dataDir: DATA_DIR });
/* 宿主 Agent（思而行作为某 Agent 的插件时）：宿主插件往 DATA_DIR/host-agent.json 写
   { name, url, key?, models:[...], vision? }（或设 SIERXING_HOST_AGENT_* 环境变量），
   启动时自动登记成「当前宿主 Agent」连接 —— 设置页与对话模型下拉直接可选。
   写文件后调 POST /api/host-agent/refresh 可免重启刷新。 */
try {
  const ha = ai.mountHostAgent();
  if (ha && ha.mounted) console.log('[host-agent] 已接入「' + ha.name + '」：' + ha.models.length + ' 个模型 · ' + ha.baseUrl);
} catch (e) { console.warn('[host-agent] 接入失败：' + (e && e.message)); }
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
metrics.init({ db, nowISO });
const tasks = createTasks({ log: (...a) => console.log(...a), metrics });
/* 把 AI 调用埋点接进 ai.text() 这个唯一出口（Q5：AI 任务失败率）。
   scene 缺省记 'unknown'；各调用点传 opts.scene 就能按功能分场景统计。 */
ai.setStats((r) => metrics.insCall(r));
rag.init({ db, tasks, nowISO, getSetting, log: (...a) => console.log(...a) });
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
  /* AI 助手是**核心能力**：所有页面常驻、不可关闭（scope=core）；它拥有全局读取权限，
     目标/资料/条件/教程等页面级修改则按当前页面 + 「只改」范围执行。 */
  { id: 'chat',        name: 'AI 助手',   icon: '💬', scope: 'core', defaultEnabled: true, category: '核心组件', order: 2,
    desc: '全局常驻的 AI 助手：能读所有目标与页面内容，在目标/条件/资料/教程页可直接修改对应内容（核心组件，不可关闭）' },
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
  /* 核心组件不可按目标关闭（旧数据里可能存着 chat:false，必须忽略）。 */
  try {
    const c = allComponents().find(x => x.id === compId);
    if (c && c.scope === 'core') return true;
  } catch (e) {}
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
/** 组件的有效分类：用户指定 > 插件声明 > 其它
 *  ⚠️ 用户把组件拖到「其它」时会**显式存空串**（表示：我就是要它归到其它）。
 *  这里必须认这个空串，不能回落到插件声明 —— 否则「把组件移到『其它』」永远不生效、
 *  卡片下一次刷新又跳回插件声明的原分类（真实 bug：用户反馈「切分类不生效」就是这个）。
 *  没有这一条记录（undefined）时才回落到插件声明。 */
function effectiveCategory(id, declared) {
  const map = componentCategoryMap();
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    const c = String(map[id] == null ? '' : map[id]).trim();
    return c || '其它';
  }
  return declared || '其它';
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
  /* ⚠️ 内置组件也必须走 effectiveCategory：用户可以在组件页把「规划前问卷」之类移到别的分类，
     直接用它声明的 category 就是「在界面上改了、保存了、卡片下一次刷新又跳回去」。 */
  const list = BUILTIN_COMPONENTS.map(b => ({ ...b, builtin: true, removable: b.scope !== 'core', client: b.client || '', kind: 'feature',
    category: effectiveCategory(b.id, b.category || (b.scope === 'core' ? '核心组件' : (b.scope === 'base' ? '基础功能组件' : '其它'))) }));
  for (const p of FILE_PLUGINS) {
    const kind = p.kind === 'theme' ? 'theme' : 'feature';
    let hasStyle = false;
    try {
      hasStyle = fs.existsSync(path.join(PUBLIC_DIR, 'plugins', p.id + '.css'))
        || fs.existsSync(path.join(USER_PUBLIC_PLUGIN_DIR, p.id + '.css'));
    } catch (e) {}
    list.push({
      id: p.id, name: p.name || p.id, icon: p.icon || '✨', desc: p.desc || '',
      category: effectiveCategory(p.id, p.category || (kind === 'theme' ? '外观主题' : '其它')),
      scope: p.scope || (kind === 'theme' ? 'theme' : 'extra'), order: p.order || 100,
      defaultEnabled: !!p.defaultEnabled, goalToggle: p.goalToggle !== false,
      version: p.version || '1.0.0', author: p.author || '',
      kind, mode: p.mode || '', hasStyle,
      style: hasStyle ? '/plugins/' + p.id + '.css' : '',
      builtin: !!p.builtin, removable: !p.builtin && p.removable !== false, client: p.client || '',
      file: p.__file || ''
    });
  }
  return list.sort((a, b) => (a.order || 100) - (b.order || 100));
}
/* 组件的有效开关（core 永远 true；其余 settings > defaultEnabled） */
function componentEnabled(id) {
  const c = allComponents().find(x => x.id === id);
  if (!c) return false;
  if (c.scope === 'core') return true;
  const map = componentSettings();
  return map[id] != null ? !!map[id] : !!c.defaultEnabled;
}
/* 给 Agent 看的组件清单 */
function agentComponentList() {
  return allComponents().map(c => ({
    id: c.id, name: c.name, icon: c.icon, desc: c.desc, category: c.category,
    scope: c.scope, kind: c.kind, builtin: !!c.builtin, removable: !!c.removable,
    defaultEnabled: !!c.defaultEnabled, goalToggle: c.goalToggle !== false,
    version: c.version || '', author: c.author || '',
    enabled: componentEnabled(c.id), canToggle: c.scope !== 'core'
  }));
}
function agentDescribeComponent(id) {
  const c = allComponents().find(x => x.id === id);
  if (!c) return null;
  return {
    id: c.id, name: c.name, icon: c.icon, desc: c.desc, category: c.category,
    scope: c.scope, kind: c.kind, builtin: !!c.builtin, removable: !!c.removable,
    defaultEnabled: !!c.defaultEnabled, goalToggle: c.goalToggle !== false,
    version: c.version || '', author: c.author || '', mode: c.mode || '',
    enabled: componentEnabled(c.id), canToggle: c.scope !== 'core'
  };
}
/* 全局组件开关（写，审计）；core 不可关；主题互斥 */
function agentToggleComponent(id, enabled) {
  const c = allComponents().find(x => x.id === id);
  if (!c) { const e = new Error('组件不存在：' + id); e.code = 'not_found'; throw e; }
  if (c.scope === 'core') { const e = new Error('核心组件不可关闭：' + id); e.code = 'forbidden'; throw e; }
  setComponent(id, !!enabled);
  if (c.kind === 'theme' && enabled) {
    for (const other of allComponents()) {
      if (other.id !== id && other.kind === 'theme') setComponent(other.id, false);
    }
  }
  return { id: id, name: c.name, enabled: componentEnabled(id), settings: componentSettings() };
}
/* ===== 非核心组件自改：导出 / 校验 / 安装 / 卸载（命令与 HTTP 路由共用） ===== */
function pipelineError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function validateComponentBundle(bundle) {
  return componentPipeline.validateBundle(bundle, { builtinIds: BUILTIN_COMPONENTS.map(function (b) { return b.id; }) });
}
function exportComponentBundle(cid) {
  const comp = allComponents().find(function (c) { return c.id === cid; });
  if (!comp) throw pipelineError('not_found', '组件不存在：' + cid);
  if (comp.builtin) throw pipelineError('forbidden', '内置组件不可导出（核心/内置不可改）');
  let server = '', client = '', style = '';
  const readFirst = function (file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } };
  server = readFirst(path.join(PLUGIN_DIR, cid + '.js')) || readFirst(path.join(USER_PLUGIN_DIR, cid + '.js'));
  client = readFirst(path.join(PUBLIC_DIR, 'plugins', cid + '.js')) || readFirst(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.js'));
  style = readFirst(path.join(PUBLIC_DIR, 'plugins', cid + '.css')) || readFirst(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.css'));
  return {
    format: 'sierxing-component', formatVersion: 1,
    id: comp.id, name: comp.name, icon: comp.icon, desc: comp.desc,
    version: comp.version, author: comp.author, order: comp.order, kind: comp.kind,
    goalToggle: comp.goalToggle, defaultEnabled: comp.defaultEnabled,
    exportedAt: nowISO(), server: server, client: client, style: style
  };
}
function installComponentBundle(bundle) {
  const summary = validateComponentBundle(bundle);
  const cid = summary.id;
  /* 只装到数据目录（USER_PLUGIN_DIR / USER_PUBLIC_PLUGIN_DIR）：程序更新不会覆盖用户功能组件。
     以前装在程序目录 server/plugins + public/plugins，升级时整目录被替换就丢了。 */
  const serverPath = path.join(USER_PLUGIN_DIR, cid + '.js');
  const clientPath = path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.js');
  const stylePath = path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.css');
  const paths = [serverPath, clientPath, stylePath];
  const before = paths.map(function (f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } });
  const fileExisted = before[0] != null;
  try {
    backup();
    fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
    fs.mkdirSync(USER_PUBLIC_PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(serverPath, bundle.server);
    if (bundle.client) {
      fs.writeFileSync(clientPath, bundle.client);
    } else {
      try { fs.unlinkSync(clientPath); } catch (e) {}
    }
    if (typeof bundle.style === 'string' && bundle.style.trim()) {
      fs.writeFileSync(stylePath, bundle.style);
    } else {
      try { fs.unlinkSync(stylePath); } catch (e) {}
    }
    const n = reloadPlugins();
    const ok = FILE_PLUGINS.some(function (x) { return x.id === cid; });
    if (!ok) throw new Error('组件已写入但加载失败，请检查服务端代码（查看服务日志）；已自动回滚旧文件');
    return { id: cid, loaded: n, replaced: fileExisted, summary: summary };
  } catch (e) {
    /* 失败回滚：旧文件写回、新文件删除，再 reload 一次 */
    for (let i = 0; i < paths.length; i++) {
      try {
        if (before[i] == null) { try { fs.unlinkSync(paths[i]); } catch (_) {} }
        else { fs.mkdirSync(path.dirname(paths[i]), { recursive: true }); fs.writeFileSync(paths[i], before[i]); }
      } catch (_) {}
    }
    try { reloadPlugins(); } catch (_) {}
    throw e;
  }
}
function uninstallComponentBundle(cid) {
  if (BUILTIN_COMPONENTS.some(function (b) { return b.id === cid; })) throw pipelineError('forbidden', '内置组件不可卸载');
  if (!FILE_PLUGINS.some(function (x) { return x.id === cid; })) throw pipelineError('not_found', '组件不存在：' + cid);
  backup();
  /* 数据目录 + 老版本的“程序目录安装”一起清：否则删掉用户版本后，旧的程序目录文件会重新冒出来 */
  try { fs.unlinkSync(path.join(USER_PLUGIN_DIR, cid + '.js')); } catch (e) {}
  try { fs.unlinkSync(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.js')); } catch (e) {}
  try { fs.unlinkSync(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.css')); } catch (e) {}
  try { fs.unlinkSync(path.join(PLUGIN_DIR, cid + '.js')); } catch (e) {}
  try { fs.unlinkSync(path.join(PUBLIC_DIR, 'plugins', cid + '.js')); } catch (e) {}
  try { fs.unlinkSync(path.join(PUBLIC_DIR, 'plugins', cid + '.css')); } catch (e) {}
  reloadPlugins();
  return { id: cid, removed: true };
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
    getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel, tasks,
    conditions: conditionsDomain
  };
}
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!cols.includes('artifact')) db.exec("ALTER TABLE nodes ADD COLUMN artifact TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('acceptance')) db.exec("ALTER TABLE nodes ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';");
  if (!cols.includes('hours')) db.exec("ALTER TABLE nodes ADD COLUMN hours TEXT NOT NULL DEFAULT '';");
  /* 达成条件归属：这个节点主要服务哪条条件（0 = 未归属）。旧库/旧数据补 0，组件页会提示补归属。 */
  if (!cols.includes('condition_id')) db.exec('ALTER TABLE nodes ADD COLUMN condition_id INTEGER NOT NULL DEFAULT 0;');
  /* 对话绑定节点（2026-10-15）：一个节点的对话要跟别的节点分开。
     以前所有对话都挂在目标上，右键 SKILL 节点打开的是 MCP 节点那轮对话的内容（用户实测）。
     node_id = 这条对话属于哪个节点（0 = 目标级对话）；
     nodes = 这条对话"带上了哪些节点"的附件清单 JSON：[{id, withKids}]。
     两列都落库而不是只放前端内存 —— 否则切设备/刷新后"这个对话在聊哪些节点"就丢了。 */
  {
    const scols = db.prepare('PRAGMA table_info(chat_sessions)').all().map(c => c.name);
    if (!scols.includes('node_id')) db.exec('ALTER TABLE chat_sessions ADD COLUMN node_id INTEGER NOT NULL DEFAULT 0;');
    if (!scols.includes('nodes')) db.exec("ALTER TABLE chat_sessions ADD COLUMN nodes TEXT NOT NULL DEFAULT '[]';");
  }
  const scols = db.prepare('PRAGMA table_info(sources)').all().map(c => c.name);
  if (!scols.includes('quality')) db.exec('ALTER TABLE sources ADD COLUMN quality INTEGER NOT NULL DEFAULT 0;');   // 1=优质信息源（**人工**标★）
  if (!scols.includes('published_at')) db.exec("ALTER TABLE sources ADD COLUMN published_at TEXT NOT NULL DEFAULT '';");
  /* 「AI 把关」的判读结果（见 server/collect-screen.js）：
     quality_score = 相关度 0~5，ai_summary = 一句话摘要，topic = 主题标签，
     review = 判读原文（JSON，便于回看"为什么收它"），content_full = 正文是否已抓全文。 */
  if (!scols.includes('quality_score')) db.exec('ALTER TABLE sources ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 0;');
  if (!scols.includes('ai_summary')) db.exec("ALTER TABLE sources ADD COLUMN ai_summary TEXT NOT NULL DEFAULT '';");
  if (!scols.includes('topic')) db.exec("ALTER TABLE sources ADD COLUMN topic TEXT NOT NULL DEFAULT '';");
  if (!scols.includes('review')) db.exec("ALTER TABLE sources ADD COLUMN review TEXT NOT NULL DEFAULT '';");
  if (!scols.includes('content_full')) db.exec('ALTER TABLE sources ADD COLUMN content_full INTEGER NOT NULL DEFAULT 0;');
  /* 清洗（server/text-clean.js）：content_raw = 清洗前的原文（清洗任务首次执行时备份，
     便于对照与重跑）；cleaned = 是否已清洗；clean_removed = 洗掉了多少字。 */
  if (!scols.includes('content_raw')) db.exec("ALTER TABLE sources ADD COLUMN content_raw TEXT NOT NULL DEFAULT '';");
  if (!scols.includes('cleaned')) db.exec('ALTER TABLE sources ADD COLUMN cleaned INTEGER NOT NULL DEFAULT 0;');
  if (!scols.includes('clean_removed')) db.exec('ALTER TABLE sources ADD COLUMN clean_removed INTEGER NOT NULL DEFAULT 0;');
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
  /* 本轮「它做了什么」（看了什么上下文、调了哪些工具）—— JSON 数组，见 streamChat */
  if (!ccols.includes('trace')) db.exec("ALTER TABLE chats ADD COLUMN trace TEXT NOT NULL DEFAULT '[]';");
  /* 用户发过的图片（只存缩略图 data URL，用于刷新后还能看到自己发了什么；
     发给 AI 的原图只存在于当次请求，不落库、不参与多端同步）。 */
  if (!ccols.includes('images')) db.exec("ALTER TABLE chats ADD COLUMN images TEXT NOT NULL DEFAULT '[]';");
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

/* 目标读取领域：实现已抽到 server/domains/goals.js；这里只做组装。 */
const goalDomain = createGoalDomain({ db: db });
const orderedLeaves = goalDomain.orderedLeaves;
const goalWithStats = goalDomain.goalWithStats;
const getGoal = goalDomain.getGoal;
const roadmapOutline = goalDomain.roadmapOutline;

/* 达成条件领域：实现已抽到 server/conditions.js；这里只做组装。
   ⚠️ 必须在 reloadPlugins()（组件 init 会拿 pluginCtx）之前初始化 —— 组件页的 API 要用它。 */
const conditionsDomain = createConditionsDomain({
  db: db,
  nowISO: nowISO,
  safeParse: safeParse,
  aiText: function () { return aiText.apply(null, arguments); },
  currentModel: function () { return currentModel(); }
});
conditionsDomain.ensureSchema();

/* 资料/提炼领域：实现已抽到 server/domains/sources.js；这里只做组装。 */
const sourceDomain = createSourceDomain({ db: db, cleanText: cleanText, nowISO: nowISO });
const sourcesOf = sourceDomain.sourcesOf;
const digestsOf = sourceDomain.digestsOf;
const digestBatches = sourceDomain.digestBatches;
const buildLibraryMarkdown = sourceDomain.buildLibraryMarkdown;

/* 加载组件（server/plugins/*.js）：init 建表 / 注册路由 */
const PLUGIN_DIR = path.join(__dirname, 'plugins');
function reloadPlugins() {
  /* 两个目录：程序自带（server/plugins）+ 用户功能组件（DATA_DIR/plugins）。
     用户组件只写数据目录，升级不会覆盖；同名时非核心组件允许被用户版本覆盖。 */
  for (const dir of [PLUGIN_DIR, USER_PLUGIN_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || f === 'index.js') continue;
        try { delete require.cache[require.resolve(path.join(dir, f))]; } catch (e) {}
      }
    } catch (e) {}
  }
  const builtinList = loadPlugins(PLUGIN_DIR, pluginCtx());
  let userList = [];
  try {
    if (fs.existsSync(USER_PLUGIN_DIR)) userList = loadPlugins(USER_PLUGIN_DIR, pluginCtx()) || [];
  } catch (e) { console.error('[plugin] 用户功能组件加载失败：' + ((e && e.message) || e)); }
  const byId = new Map();
  for (const p of builtinList) byId.set(p.id, p);
  let userCount = 0, shadowed = 0;
  for (const p of userList) {
    if (!p || !p.id) continue;
    const coreIds = BUILTIN_COMPONENTS.map(function (b) { return b.id; });
    if (byId.has(p.id) && coreIds.indexOf(p.id) >= 0) {
      console.warn('[plugin] 用户组件与核心/基础组件重名，已跳过：' + p.id + '（请换一个 id）');
      continue;
    }
    if (byId.has(p.id)) shadowed++;
    try { Object.defineProperty(p, 'builtin', { value: false, writable: true, configurable: true, enumerable: true }); }
    catch (e) { try { p.builtin = false; } catch (e2) {} }
    byId.set(p.id, p);
    userCount++;
  }
  FILE_PLUGINS = Array.from(byId.values());
  FILE_PLUGINS.sort(function (a, b) {
    return (Number(a.order) || 100) - (Number(b.order) || 100) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  if (userCount || shadowed) console.log('[plugin] 用户功能组件 ' + userCount + ' 个' + (shadowed ? '（覆盖同名程序组件 ' + shadowed + ' 个）' : ''));
  PLUGINS = FILE_PLUGINS;
  /* 升级差异（P3）：每次重载都更新内存里的插件增删；快照只在启动时落盘 */
  try {
    if (kernelConfig) kernelConfig.checkUpgrade(FILE_PLUGINS.map(function (p) { return p.id; }));
  } catch (e) {}
  return FILE_PLUGINS.length;
}
reloadPlugins();
/* 首次启动：把本次的内置配置键 / 插件 id 记成快照，下次升级即可对比出「多了什么、少了什么」 */
try {
  if (kernelConfig) kernelConfig.writeSnapshot(FILE_PLUGINS.map(function (p) { return p.id; }));
} catch (e) { console.log('[config] 写升级快照失败：' + e.message); }
/* 创造模式（仿 DSH Creator preset）：对话生成 UI 页面插件 / 皮肤 / 功能组件，
   服务端校验 + 暂存，用户点「安装并查看」才真正落盘（只写数据目录，装前快照、可回滚）。 */
const createMode = createCreateMode({
  db: db,
  dataDir: DATA_DIR,
  uiDir: path.join(DATA_DIR, 'ui-plugins'),
  uiPlugins: uiPlugins,
  styleCssPath: path.join(PUBLIC_DIR, 'style.css'),
  installComponent: installComponentBundle,
  uninstallComponent: uninstallComponentBundle,
  exportComponent: exportComponentBundle,
  validateComponent: function (bundle) {
    const dupe = (PLUGINS || []).find(function (p) { return p.id === bundle.id; });
    if (dupe && dupe.builtin !== false) {
      throw pipelineError('forbidden', '已经有同名内置组件「' + bundle.id + '」，换一个 id');
    }
    return validateComponentBundle(bundle);
  },
  reloadPlugins: reloadPlugins,
  log: function () { console.log.apply(console, arguments); }
});
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

/* ---------- 界面语言（i18n） ----------
   语言包在 language/locales/（内置：zh-CN / en-US）+ DATA_DIR/language/（AI 生成）。
   ⚠️ 这里创建得比较早（serveStatic 注入 index.html 时会用），不要把它挪到插件加载之后。 */
const language = createLanguage({
  appDir: APP_DIR,
  dataDir: DATA_DIR,
  getSetting: (k, d) => getSetting(k, d),
  setSetting: (k, v) => setSetting(k, v),
  log: (...a) => console.log(...a)
});
const languageGenerator = createLanguageGenerator({
  language: language,
  aiText: (prompt, o) => ai.text(Object.assign({ prompt: prompt, model: currentModel() }, o || {})),
  log: (...a) => console.log(...a)
});

/** 把语言配置/字典/i18n.js 注入入口 HTML（字典在 app.js 之前同步加载） */
function injectLanguageHtml(html, req) {
  try {
    const accept = req && req.headers ? req.headers['accept-language'] : '';
    const code = language.active(accept);
    const pack = language.pack(code) || language.pack('zh-CN');
    const meta = (pack && pack.meta) || {};
    const title = meta.documentTitle || (APP_NAME + ':您的目标规划助手');
    const desc = meta.documentDescription || '';
    html = html.replace(/<html\b[^>]*>/, '<html lang="' + language.escHtml(code) + '"' + (meta.rtl ? ' dir="rtl"' : '') + '>');
    html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + language.escHtml(title) + '</title>');
    if (desc) {
      html = html.replace(/<meta name="description" content="[^"]*">/,
        '<meta name="description" content="' + language.escHtml(desc) + '">');
    }
    const tags = [
      '<script>' + language.cfgJs(code, ASSET_V) + '</script>',
      '<script src="/api/language/pack.js?code=' + encodeURIComponent(code) + '&v=' + encodeURIComponent(ASSET_V) + '"></script>',
      '<script src="/i18n.js"></script>'
    ].join('\n  ');
    if (html.indexOf('<script src="/i18n.js"></script>') >= 0) {
      html = html.replace('<script src="/i18n.js"></script>', tags);
    } else {
      /* 兜底：入口页里没留占位时，插在 sdk.js 前面 */
      html = html.replace('<script src="/sdk.js">', tags + '\n  <script src="/sdk.js">');
    }
    return html;
  } catch (e) {
    console.warn('[language] 注入语言包失败，回退默认：', (e && e.message) || e);
    return html;
  }
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

/* 提示词包：没有用户覆盖时 render 走 builtinRender（行为与重构前一致） */
const promptPacks = createPromptRegistry({ db, nowISO });
/* 规划主流程也注册成可编辑包：默认仍调用原函数，覆盖后才走模板 */
const planPacks = require('./prompts/plan-packs');
planPacks['plan.clarify'].builtinRender = async function (ctx) { return buildClarifyPrompt(ctx.goal); };
planPacks['plan.skeleton'].builtinRender = async function (ctx) { return buildSkeletonPrompt(ctx.goal); };
promptPacks.register(planPacks['plan.clarify']);
promptPacks.register(planPacks['plan.skeleton']);
/* 资料类：搜集方案 / 书单 / 清洗，默认仍调用原函数 */
const sourcePacks = require('./prompts/sources-packs');
sourcePacks['sources.collect_plan'].builtinRender = function (ctx) { return buildCollectPlanPrompt(ctx.goal); };
sourcePacks['sources.ebook_recommend'].builtinRender = function (ctx) { return buildEbookRecommendPrompt(ctx.goal); };
sourcePacks['sources.clean'].builtinRender = function (ctx) { return textClean.buildCleanPrompt(ctx.title, ctx.goalTitle, ctx.text); };
promptPacks.register(sourcePacks['sources.collect_plan']);
promptPacks.register(sourcePacks['sources.ebook_recommend']);
promptPacks.register(sourcePacks['sources.clean']);
/* 教程生成：默认仍调用 buildTutorialPrompt */
const tutorialPacks = require('./prompts/tutorial-packs');
tutorialPacks['tutorial.generate'].builtinRender = function (ctx) {
  return buildTutorialPrompt(ctx.goal, ctx.node, ctx.format, ctx.note, ctx.codeBlock, ctx.budget);
};
promptPacks.register(tutorialPacks['tutorial.generate']);
/* 命令总线：UI / CLI / Agent 共用的能力入口。
   read 直接执行；write 执行并审计；destructive/admin 必须带用户批准的 approvalId。 */
const commandBus = require('./commands')({
  db,
  getGoal,
  goalWithStats,
  nowISO,
  promptPacks,
  getSetting,
  setSetting,
  backup,
  deleteGoal: deleteGoalData,
  deleteNode: deleteNodeData,
  listComponents: agentComponentList,
  describeComponent: agentDescribeComponent,
  toggleComponent: agentToggleComponent,
  exportComponent: exportComponentBundle,
  validateComponent: validateComponentBundle,
  installComponent: installComponentBundle,
  uninstallComponent: uninstallComponentBundle,
  recordGoalChange: recordGoalFieldEvents,
  onSourceChanged: onSourceChanged,
  openApp: function (route) { return service.openBrowser(route); },
  startTutorialGeneration: startTutorialGeneration,
  startTutorialEdit: startTutorialEditTask,
  startSourceCollect: startSourceCollect,
  startSourceDigest: startSourceDigest,
  startGoalPlan: startGoalPlan,
  version: require('../package.json').version
});
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
  /* 条件归属：显式给了就用；否则继承父节点 —— 这样「小目标下加任务 / AI 细化任务 /
     对话里加子节点」都不用每条路径各写一遍，任务自动跟着小目标。 */
  let conditionId = Number(ex.condition_id) || 0;
  if (!conditionId && parentId) {
    try {
      const p = db.prepare('SELECT condition_id FROM nodes WHERE id = ?').get(Number(parentId));
      conditionId = Number(p && p.condition_id) || 0;
    } catch (e) {}
  }
  db.prepare('INSERT INTO nodes (goal_id, parent_id, level, title, detail, artifact, acceptance, hours, sources, status, condition_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, String(title || '').trim().slice(0, 200), String(detail || '').trim().slice(0, 2000),
      String(ex.artifact || '').trim().slice(0, 500), String(ex.acceptance || '').trim().slice(0, 500), String(ex.hours || '').trim().slice(0, 50),
      normalizeSources(sources), 'todo', conditionId, sortOrder || 0, t, t);
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
/* 删除一个目标的全部主表数据 + 插件清理；HTTP 路由与命令总线共用。
   destructive 命令必须用户批准后才会走到这里。 */
/* 记录目标字段变更（本地表 goal_field_events）：goal_drift 的唯一证据来源。
   三个写入口都调它：HTTP PUT、Agent 命令、对话 ops 的 update_goal。 */
/* 资料变更后：重建检索索引；删除时顺手清掉该资料的切片。命令与 HTTP 路由共用。 */
function onSourceChanged(goalId, action, sourceId) {
  try { if (action === 'delete' && sourceId) rag.dropSource(sourceId); } catch (e) {}
  try { rag.autoIndex(goalId); } catch (e) {}
}
function recordGoalFieldEvents(goalId, before, after, source) {
  try {
    const fields = ['title', 'profile', 'weekly_hours', 'deadline', 'materials'];
    const at = nowISO();
    const stmt = db.prepare('INSERT INTO goal_field_events (goal_id, field, old_value, new_value, source, created_at) VALUES (?,?,?,?,?,?)');
    for (const f of fields) {
      const a = before && before[f] != null ? String(before[f]) : '';
      const b = after && after[f] != null ? String(after[f]) : '';
      if (a !== b) stmt.run(goalId, f, a.slice(0, 500), b.slice(0, 500), String(source || '').slice(0, 40), at);
    }
  } catch (e) {}
}
function deleteGoalData(id) {
  db.prepare('DELETE FROM nodes WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM sources WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM code_repo_files WHERE goal_id = ?').run(id);
  try { rag.dropGoal(id); } catch (e) { console.error('[rag] dropGoal 失败:', e.message); }
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  db.prepare('DELETE FROM goal_versions WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM tutorials WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM chats WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE goal_id = ?').run(id);
  for (const pl of PLUGINS) { try { if (typeof pl.onGoalDelete === 'function') pl.onGoalDelete(id, pluginCtx()); } catch (e) { console.error('[plugin]', pl.id, '清理失败:', e.message); } }
  backup();
}
/* 删除节点树 + 版本快照；HTTP 路由与命令总线共用。找不到节点返回 null。 */
async function deleteNodeData(id) {
  const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!n) return null;
  const goalRow = db.prepare('SELECT * FROM goals WHERE id = ?').get(n.goal_id);
  const vidDel = beginVersion(n.goal_id, '手动删除：' + n.title);
  deleteNodeTree(id);
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
  if (vidDel && goalRow) await finishVersion(goalRow, vidDel, '手动删除：' + n.title, false);
  backup();
  return { node: n, goal: getGoal(n.goal_id) };
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
    let url = (process.env.SX_SEARCH_BING || 'https://cn.bing.com/search') + '?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + (count || 20);
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
    let url = (process.env.SX_SEARCH_BAIDU || 'https://www.baidu.com/s') + '?wd=' + encodeURIComponent(query) + '&rn=' + (count || 30);
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
/* 抓取重试的"换招"顺序。网页抓不到正文无非三类原因：
   ① **偶发**（限流 / 超时 / 网络抖）—— 缓一下重来就好。这是大头：实测随机抽 24 条
      历史"正文为空"的资料重抓，14 条（58%）当场就抓回来了，全是 CSDN / 51CTO / 公众号；
   ② 嫌请求不像浏览器（缺 Referer/Accept 这类头）—— 补全就好；
   ③ 要登录态（知乎 403、BOSS 直聘跳 security 页、php.cn 登录墙）—— 换招也没用，
      重试到次数就如实报失败，别在这上面死磕（死磕 = 一次采集多卡十几分钟）。
   手机 UA 放最后一档：不少站点给手机端放行（实测 B 站换手机 UA 正文更全）。 */
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FETCH_MODES = ['plain', 'browser', 'mobile'];

/** 抓一次（不重试）。返回 { text, why, permanent }：permanent = 再试也没用（404 / 不是网页 / 太大）。 */
async function fetchOnce(url, maxLen, o, mode) {
  const byteCap = Number(o.bytes) || 800 * 1024;
  const waitMs = Number(o.timeoutMs) || 9000;
  const headers = { 'User-Agent': mode === 'mobile' ? UA_MOBILE : UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  if (mode !== 'plain') {
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    headers['Upgrade-Insecure-Requests'] = '1';
    headers['Cache-Control'] = 'no-cache';
    try { headers['Referer'] = new URL(url).origin + '/'; } catch (e) {}
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), waitMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const finalUrl = res.url || url;
    if (!res.ok) return { text: '', url: finalUrl, why: 'HTTP ' + res.status, permanent: res.status === 404 || res.status === 410 };
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain/i.test(ct)) return { text: '', url: finalUrl, why: '不是网页（' + ct.slice(0, 30) + '）', permanent: true };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { text: '', url: finalUrl, why: '空响应', permanent: false };
    if (buf.length > byteCap) return { text: '', url: finalUrl, why: '页面太大(' + Math.round(buf.length / 1024) + 'KB)', permanent: true };
    const html = decodeHtml(buf);
    /* 清洗：挑主内容容器 + 逐行去掉导航/推荐位/页脚/公众号引导这类垃圾（见 server/text-clean.js）。
       以前这里是"把标签全删掉"，于是每条资料里都混着一堆站点废话，还会被切成检索片段。 */
    const cleaned = textClean.extractText(html);
    const text = cleaned.text || '';
    /* 反爬挑战页：抓到的"正文"其实是混淆脚本（见 text-clean.looksLikeChallenge）。
       当成"没抓到"报失败，绝不能把一段混淆代码当资料喂给 AI。 */
    if (text && textClean.looksLikeChallenge(text)) return { text: '', url: finalUrl, why: '反爬挑战页（正文是混淆脚本）', permanent: false };
    if (text.length < 80) return { text: '', url: finalUrl, why: '正文只剩 ' + text.length + ' 字', permanent: false };
    const keep = text.slice(0, maxLen || 3000);
    return {
      text: keep, url: finalUrl, date: extractPublishDate(html, text),
      truncated: keep.length < text.length, total: text.length, cleanDrop: cleaned.dropped || 0
    };
  } catch (e) {
    return { text: '', url, why: e.name === 'AbortError' ? '超时' : (e.message || e.name), permanent: false };
  } finally { clearTimeout(t); }
}

/* 镜像路线：某些站点在这台机器上直连不通，但内容其实有替代入口。
   目前只有 GitHub —— 实测这里 github.com **完全不可达**、raw.githubusercontent.com 会挂到超时，
   而 jsdelivr 是通的（它本来就是 GitHub 的 CDN，按 用户名/仓库@分支/路径 取文件，
   实测那篇 README 拿回来 14073 字）。仓库首页（目录）转不了，退而求其次试 README。
   ⚠️ 只做"多给一条路"，**绝不改写原地址** —— 换一台能上 GitHub 的电脑时原路照样优先走。 */
function mirrorUrls(url) {
  const out = [];
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, '') !== 'github.com') return out;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
    if (m) { out.push('https://cdn.jsdelivr.net/gh/' + m[1] + '/' + m[2] + '@' + m[3] + '/' + m[4]); return out; }
    const r = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (r) {
      out.push('https://cdn.jsdelivr.net/gh/' + r[1] + '/' + r[2] + '@main/README.md');
      out.push('https://cdn.jsdelivr.net/gh/' + r[1] + '/' + r[2] + '@master/README.md');
    }
  } catch (e) {}
  return out;
}

/* 抓网页正文（带"换招重试"）。maxLen = 保留多少字；opts.bytes = 允许下载多少字节（全文模式给更大的上限）。
   opts.retry=false 关掉重试；opts.attempts 指定最多试几档（默认 2 档：直连 → 补全浏览器头）；
   opts.mirrors=false 关掉镜像兜底。
   返回 truncated = 正文比 maxLen 长（「AI 把关」据此决定要不要回来抓全文）；why = 全部失败时的最后一档原因。 */
async function fetchPage(url, maxLen, opts) {
  const o = opts || {};
  const tries = o.retry === false ? 1 : Math.max(1, Math.min(FETCH_MODES.length, Number(o.attempts) || 2));
  const plan = [];
  for (let i = 0; i < tries; i++) plan.push({ u: url, m: FETCH_MODES[i] });
  if (o.retry !== false && o.mirrors !== false) for (const m of mirrorUrls(url)) plan.push({ u: m, m: 'plain' });
  let last = { text: '', url, why: '' };
  let skipUrl = '';
  for (let i = 0; i < plan.length; i++) {
    if (plan[i].u === skipUrl) continue;
    if (i) await new Promise(r => setTimeout(r, 600 + i * 400)); // 限流多半是瞬时的，缓一下再上
    const r = await fetchOnce(plan[i].u, maxLen, o, plan[i].m);
    if (r.text) return r;
    last = r;
    /* 404 这类是"这条链接本身就不存在"：只跳过同一个地址剩下的档，别把后面的镜像一起掐掉 */
    if (r.permanent) skipUrl = plan[i].u;
  }
  return last;
}
const AD_KEYWORDS = /包就业|保就业|保offer|付费内推|培训贷|报名咨询|免费试听|免费领取|领取资料|加微信|扫码|课程咨询|就业班|脱产班|学费|限时优惠|名额有限|点击咨询|在线咨询|试听课|零基础培训|IT培训|程序员培训|培训机构|名师授课|就业保障|简历代写|项目代做|毕设辅导|职业培训|招生简章|关注公众号|公众号回复|资料包|加群|私信我/;
const AD_SITE_RE = /itheima|itcast|qianfeng|tarena|kaikeba|lagouedu|mkbk|hqyj|zhonggong|offcn|huatu|tedu|bjsxt|bawei|xuexiniu|yuanrenxue|itxuexi|kuangstudy|imooc\.com\/course|ke\.qq\.com\/course|douyin\.com|jianli\.com|wondercv|diyifanwen|51test|zhan\.com/i;
// 营销/标题党特征（经验贴里出现即视为非真人经验）
const MARKETING_RE = /死磕|offer拿到手软|就够了|必知必会|最全|1000道|附答案|标准答案|满分|大白话|话术模板|速成|秘籍|宝典|保姆级|手把手|一文搞定|万字长文|全流程拆解|实战演练|超实用|亲测这套|揭秘|爆肝|小册|干货合集|收藏这一篇|看完这篇|建议收藏/;
// 真人经验特征
const REAL_EXP_RE = /面经|凉经|一面|二面|三面|四面|hr面|HR面|笔试|复盘|上岸|oc了|OC了|offer|秋招|春招|日常实习|暑期实习|面试经历|求职经历|个人向|记录|经历分享/;
/* 本地这一层只挡"一眼就是广告"的：培训/招聘站黑名单 + 明确广告词。
   ⚠️ 原来还按 kind 判"面经必须是真人分享、营销词+合集一律丢"——那是求职模板时代的规则，
   现在**质量判断交给 AI 把关**（见 collect-screen.js）：本地挡太多 = 好文章连被 AI 看见的机会都没有
   （用户定的调子："先大量检索，然后 AI 审查"）。 */
function isAdSource(host, kind, title, snippet, content) {
  if (AD_SITE_RE.test(String(host || ''))) return true;
  const text = String(title || '') + ' ' + String(snippet || '') + ' ' + String(content || '').slice(0, 1000);
  return AD_KEYWORDS.test(text);
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
      queries = await recommendCollectPlan(fresh, null, signal);
      saveCollectPlan(fresh.id, { asked: true, queries, updatedAt: nowISO() });
    } catch (e) {
      if (e && (e.cancelled || e.name === 'AbortError')) throw e;
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
async function recommendCollectPlan(goal, timeoutMs, signal) {
  const collectPrompt = promptPacks.hasOverride('sources.collect_plan')
    ? await promptPacks.renderAsync('sources.collect_plan', { goal: goal, goalHeader: goalHeader(goal) })
    : buildCollectPlanPrompt(goal);
  const txt = await aiText(collectPrompt, currentModel(), timeoutMs || 120000, null, signal || null, '资料收集');
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
async function recommendEbooks(goal, timeoutMs, signal) {
  const ebookPrompt = promptPacks.hasOverride('sources.ebook_recommend')
    ? await promptPacks.renderAsync('sources.ebook_recommend', { goal: goal, goalHeader: goalHeader(goal) })
    : buildEbookRecommendPrompt(goal);
  const txt = await aiText(ebookPrompt, currentModel(), timeoutMs || 120000, null, signal || null, '电子书推荐');
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
      const rec = await recommendEbooks(fresh, null, signal);
      books = rec;
      pref.books = (pref.books || []).concat(books);
      saveEbookPref(fresh.id, pref);
    } catch (e) {
      if (e && (e.cancelled || e.name === 'AbortError')) throw e;
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
/* 与目标无关的招考/考证类词（"搜 AI 产品经理却回来软考考点汇总"就是靠它挡掉）。
   目标本身就是考这些的话（用户目标里出现了同样的词）就不挡 —— 别把考研目标自己的资料筛没。 */
const OFFTOPIC_WORDS = ['软考', '公考', '公务员', '考研', '四六级', '教师资格', '期末复习', '自考', '成人高考', '一级建造师', '注册会计师', '护士资格', '驾照', '事业编', '考研复试'];
function buildOffTopicRe(goal) {
  const g = String((goal && goal.title) || '') + ' ' + String((goal && goal.profile) || '').slice(0, 120);
  const bad = OFFTOPIC_WORDS.filter(w => !g.includes(w));
  return bad.length ? new RegExp(bad.join('|')) : null;
}
/* 公开报告/论文的常见可信域名（PDF 直下全文时用） */
const DOC_TRUST_RE = /\.(gov|edu)(\.|$)|arxiv\.org|ssrn\.com|who\.int|imf\.org|worldbank\.org|oecd\.org|nber\.org|nature\.com|sciencedirect|springer|ieee\.org|acm\.org|cnki\.net|wanfangdata/i;

/* 一批候选交给 AI 判读（相关性/实质内容/营销水文/主题/一句话摘要/要不要抓全文）。
   判读失败不影响主流程：日志记一笔，这批按"未审"处理（阈值照旧 → 默认不收）。 */
async function screenCandidates(goal, cands, onProgress, signal, checkStop) {
  const out = new Map();
  if (!cands.length) return out;
  const bs = collectScreen.batches(cands, collectScreen.MAX_ITEMS_PER_CALL);
  for (let bi = 0; bi < bs.length; bi++) {
    checkStop();
    onProgress({ status: `AI 正在把关这批资料：第 ${bi + 1}/${bs.length} 批（每批最多 ${collectScreen.MAX_ITEMS_PER_CALL} 条，判相关度/实质内容/是否水文）…`, prog: { phase: 2, frac: (bi + 1) / Math.max(1, bs.length) } });
    try {
      const raw = await aiText(collectScreen.buildScreenPrompt(goal.title, bs[bi], { batch: { no: bi + 1, total: bs.length } }),
        currentModel(), 240000, null, signal, '资料把关');
      const m = collectScreen.parseVerdicts(raw, bs[bi]);
      for (const [k, v] of m) out.set(k, v);
      if (!m.size) console.log('[collect] 这一批判读没解析出结果（按未审处理）');
    } catch (e) {
      if (e && (e.cancelled || e.name === 'AbortError')) throw e;
      console.log('[collect] 判读失败（这批按未审处理）:', e.message);
    }
  }
  return out;
}

/* 搜集信息源。
   流程（用户定调："先大量检索，然后 AI 审查这批信息源内容质量如何；
   字数限制太死板了，应该由 AI 判读，高质量的被截断了就把全部内容导入"）：
     ① 广撒网：每条 query 的结果全收进来（不再按类型配额先到先得 —— 那等于让内容农场先占满）
     ② 候选池：按站点优先级排序 + 单站上限 + 总量上限（只做"别让一家刷屏"，不做质量判断）
     ③ 抓探测正文（3,500 字）+ 本地硬闸门（正文太短 / 标题跑题 / 广告 / 超期）
     ④ **AI 判读**：每批 ≤18 条，判 相关度 0~5 / 有没有实质内容 / 是不是营销水文 / 主题 / 一句话摘要 / 要不要抓全文
     ⑤ 达标的入库；**达标且正文被截断的，回来把全文抓一遍再入库**（单条上限 + 整次预算封顶）
   返回 stats 供前端如实汇报（搜到多少 → 抓了多少 → 合格多少 → 补全文多少）。 */
async function collectSources(goal, queries, onProgress, signal) {
  const seen = new Set();
  const all = [];
  let doneQ = 0, blocked = false;
  const checkStop = () => { if (signal && signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
  /* ① 广撒网 */
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
      try { new URL(r.url); } catch (e) { continue; }
      const host = siteOf(r.url);
      if (!host) continue;
      if (/(^|\.)(baidu|google|bing)\.com$/.test(host)) continue;
      seen.add(r.url);
      all.push({ ...r, host, site: siteLabel(host), kind: item.kind, q: item.q, days: item.days });
    }
    doneQ++;
    onProgress({ status: `搜索 ${doneQ}/${queries.length}：${item.q.slice(0, 26)}（候选池 ${all.length} 条）`, prog: { phase: 0, frac: doneQ / Math.max(1, queries.length) } });
  }
  /* ② 候选池：站点优先级 + 单站上限 + 总量上限 */
  const CAP = Math.max(40, Number(getSetting('collect_candidates', '220')) || 220);
  const MAX_PER_SITE = Math.max(4, Number(getSetting('collect_per_site', '12')) || 12);
  const PRIORITY = ['nowcoder.com', 'zhipin.com', 'zhihu.com', 'juejin.cn', 'github.com', 'csdn.net', 'lagou.com', 'liepin.com', 'shixiseng.com', '51job.com'];
  const prio = h => { const i = PRIORITY.findIndex(d => h.endsWith(d)); return i < 0 ? 99 : i; };
  const sorted = all.slice().sort((a, b) => prio(a.host) - prio(b.host));
  const picked = [];
  const siteCount = {};
  for (const s2 of sorted) {
    if (picked.length >= CAP) break;
    siteCount[s2.site] = (siteCount[s2.site] || 0) + 1;
    if (siteCount[s2.site] > MAX_PER_SITE) continue;
    picked.push(s2);
  }
  /* 把关设置 */
  const review = (getSetting('collect_review', '1') || '1') !== '0';
  const minScore = Math.max(0, Math.min(5, Number(getSetting('collect_min_score', '3')) || 3));
  const FULL_MAX = Math.max(4000, Number(getSetting('collect_full_max', '60000')) || 60000);
  const FULL_BUDGET = Math.max(0, Number(getSetting('collect_full_budget', '1600000')) || 1600000);
  const wantFull = (getSetting('collect_full', '1') || '1') !== '0';
  const offTopicRe = buildOffTopicRe(goal);
  /* ③ 抓探测正文 + 本地硬闸门 */
  const existingUrls = new Set(db.prepare('SELECT url FROM sources WHERE goal_id = ?').all(goal.id).map(r => r.url));
  const seenFinal = new Set();
  const cands = [];
  const now = Date.now();
  let fetched = 0, hardDrop = 0, ads = 0, skipped = 0, pdfSaved = 0;
  const MAX_PDF = 4;
  let haveDocTitles = [];
  try {
    haveDocTitles = db.prepare("SELECT title FROM sources WHERE goal_id = ? AND kind IN ('书籍','报告')").all(goal.id)
      .map(r => String(r.title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16)).filter(Boolean);
  } catch (e) {}
  const docSeen = t => { const k = String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16); return k && haveDocTitles.some(h => h.includes(k) || k.includes(h)); };
  const docMark = t => { const k = String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').slice(0, 16); if (k) haveDocTitles.push(k); };
  /* 同一家站点"连着抓不到正文"就不再试它了。
     为什么：知乎（HTTP 403）、BOSS 直聘（跳 security 页）这类要登录态的站，
     候选池里可能有十来条，抓一条废一条，而每条现在还要走最多三档重试 —— 白等好几分钟。
     这里的阈值取"连续 4 条"，够保守：内容站偶尔抖一两条不会误伤，只有整片抓不到才收手。
     只做**本轮内**的学习，不落库、不影响下次 —— 哪天站点放开或我们换了抓法，
     下一轮自然会重新尝试，不需要用户去某个设置里解封。 */
  const hostFails = new Map();
  const DEAD_AFTER = 4;
  let deadSkip = 0;
  await mapLimit(picked, 4, async s2 => {
    checkStop();
    fetched++;
    if (fetched % 8 === 0) onProgress({ status: `抓取正文 ${fetched}/${picked.length}（待审 ${cands.length}，已排除 ${hardDrop + ads}${deadSkip ? '，跳过抓不到的站 ' + deadSkip : ''}）`, prog: { phase: 1, frac: fetched / Math.max(1, picked.length) } });
    if (existingUrls.has(s2.url)) { skipped++; return; }
    if ((hostFails.get(s2.host) || 0) >= DEAD_AFTER) { deadSkip++; return; }
    /* PDF 直下全文入库：只认"可信域名"或"标题与本目标有关"的公开报告/论文，别乱下文件 */
    if (/\.pdf($|[?#])/i.test(s2.url) && pdfSaved < MAX_PDF && !docSeen(s2.title)) {
      const trust = DOC_TRUST_RE.test(s2.host || '');
      if (!trust) { skipped++; return; }
      try {
        const buf = await gFetch(s2.url, 25000, false);
        if (buf && buf.length > 500 && buf.length <= 12 * 1024 * 1024) {
          const base = (() => { try { return decodeURIComponent(s2.url.split('?')[0].split('/').pop() || ''); } catch (e) { return ''; } })();
          const fname = (base && /\.pdf$/i.test(base) ? base : (String(s2.title || 'report').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) + '.pdf'));
          const info = await require('./plugins/jdfile.js').ingestEbookBuffer(
            { id: goal.id }, buf, fname, '搜集时发现的公开 PDF 全文',
            st => onProgress({ status: `📄 ${st}` }), 0,
            '公开 PDF（' + siteLabel(siteOf(s2.url) || '') + '）', '报告', { rejectGarbled: true });
          seenFinal.add(s2.url);
          docMark(info.title); docMark(s2.title);
          pdfSaved++;
          onProgress({ status: `📄 PDF 全文已入库：《${String(s2.title).slice(0, 30)}》` });
          return;
        }
      } catch (e) { console.log('[collect] PDF 入库失败，回退普通抓取:', s2.url.slice(0, 80), e.message); }
    }
    const page = await fetchPage(s2.url, 3500);
    const finalUrl = page.url || s2.url;
    const host = siteOf(finalUrl) || s2.host;
    if (seenFinal.has(finalUrl) || existingUrls.has(finalUrl)) { skipped++; return; }
    seenFinal.add(finalUrl);
    if (isAdSource(host, s2.kind, s2.title, s2.snippet, page.text)) { ads++; return; }
    const pub = page.date || s2.date || 0;
    const limitDays = s2.kind === 'JD' ? 60 : 365;
    if (pub && now - pub > limitDays * 86400e3) return;
    const cand = {
      i: cands.length + 1, query: s2.q || '', kind: s2.kind, url: finalUrl, host, site: siteLabel(host),
      title: String(s2.title || '').slice(0, 200), snippet: String(s2.snippet || '').slice(0, 600),
      text: page.text || '', truncated: !!page.truncated, date: pub
    };
    const hard = collectScreen.hardGate(cand, { offTopicRe });
    if (hard && !hard.keep) {
      hardDrop++;
      /* 只有"连正文都拿不到"才算这家站抓不到；跑题/广告是**这条**的问题，不该连坐整站。 */
      if (/^no-body/.test(String(hard.reason))) hostFails.set(s2.host, (hostFails.get(s2.host) || 0) + 1);
      return;
    }
    hostFails.set(s2.host, 0);   // 这家能抓到正文 —— 前面抖过几次也不再计数
    cands.push(cand);
  });
  onProgress({ status: `抓取完成：待审 ${cands.length} 条（已排除：广告 ${ads} · 正文太少/跑题 ${hardDrop}${deadSkip ? ' · 跳过抓不到的站 ' + deadSkip : ''} · 已存在 ${skipped}）`, prog: { phase: 2, frac: 0 } });
  /* ④ AI 判读 */
  const verdicts = review ? await screenCandidates(goal, cands, onProgress, signal, checkStop) : new Map();
  /* ⑤ 入库 + 高价值截断的补全文 */
  let saved = 0, aiDrop = 0, fullGot = 0, fullChars = 0, fullFail = 0;
  onProgress({ status: '开始整理入库…', prog: { phase: 3, frac: 0 } });
  for (const c of cands) {
    checkStop();
    /* 入库这一段的进度也报出来：一条一条写库 + 回抓全文，末尾往往还要跑好一会儿 */
    if (cands.length > 3 && (saved + aiDrop) % 10 === 0) {
      onProgress({ status: `整理入库 ${saved + aiDrop}/${cands.length}（已入库 ${saved}）`, prog: { phase: 3, frac: (saved + aiDrop) / cands.length } });
    }
    const v = verdicts.get(c.i) || null;
    if (review) {
      const g2 = collectScreen.gate(v, { minScore });
      if (!g2.keep) { aiDrop++; continue; }
    }
    let content = c.text, isFull = 0;
    if (review && wantFull && collectScreen.needFullText(v, c, { minFullScore: 4 })) {
      if (fullChars >= FULL_BUDGET) { /* 预算用完：保留探测正文，不再抓 */ }
      else {
        try {
          onProgress({ status: `📄 这条质量高（${v ? v.score : '?'}/5），正在把全文抓回来：《${c.title.slice(0, 24)}》` });
          const fp = await fetchPage(c.url, FULL_MAX, { bytes: 2 * 1024 * 1024, timeoutMs: 15000, attempts: 3 });
          if (fp.text && fp.text.length > String(content || '').length) {
            content = fp.text; isFull = 1; fullGot++; fullChars += fp.text.length;
          } else fullFail++;
        } catch (e) { fullFail++; console.log('[collect] 全文抓取失败，保留探测正文:', e.message); }
      }
    }
    let snip = c.snippet;
    try { snip = textClean.cleanLines(String(c.snippet || ''), { minChars: 20 }).text || c.snippet; } catch (e) {}
    db.prepare(`INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at,quality_score,ai_summary,topic,review,content_full,cleaned)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(goal.id, c.title, c.url.slice(0, 500), c.site.slice(0, 50), c.kind,
        String(snip || '').slice(0, 600), String(content || '').slice(0, FULL_MAX + 4000),
        c.date ? new Date(c.date).toISOString().slice(0, 10) : '', nowISO(),
        v ? v.score : 0, v ? v.summary : '', v ? v.topic : '', v ? JSON.stringify(v) : '', isFull, 1);
    saved++;
  }
  const stats = { searched: all.length, candidates: picked.length, toReview: cands.length, saved, aiDrop, hardDrop, ads, skipped, deadSkip, fullGot, fullFail, pdf: pdfSaved, review, minScore };
  onProgress({ status: `把关完成：入库 ${saved} 条（AI 判为不合格 ${aiDrop} 条${fullGot ? ' · 补抓全文 ' + fullGot + ' 条' : ''}）` });
  /* 清理超期的旧来源 */
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
  return { saved, blocked, stats };
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
function digestsBlock(goal) { return promptContext.digestsBlockFrom(digestsOf(goal.id)); }
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
function nodeSourcesBlock(goal, node, maxLen) { return promptContext.nodeSourcesBlockFrom(nodeSourceItems(goal, node), maxLen); }
/* 其它资料的索引（只给标题，避免把全部正文塞进节点级提示词） */
/* 资料索引：给模型"有什么可依据"的全景。
   ⚠️ 原来是 all.slice(0, maxTitles) —— 只列**最靠前的 N 条**。
   用户攒到 290 条资料时，26 条自己提供的 + 264 条网络资料里只有前 16 条进得了
   提示词，模型能引用的依据被硬卡在 16 条以内 —— 于是每个节点只能挂 1 条依据，
   "这个节点为什么存在"就说不清楚了（线上就这么发生的）。
   改成：**按类别分组、尽量全量列标题**（标题很短，290 条约 1.2 万字，比正文省得多），
   并用字符预算兜底；「自己提供」的排最前并标出来（优先级最高）。 */
function sourcesIndexBlock(goal, maxTitles, scopeNote, charBudget) { return promptContext.sourcesIndexBlockFrom(sourcesOf(goal.id), maxTitles, scopeNote, charBudget); }
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
  /* 每条带上 AI 判读（相关度 / 主题 / 一句话摘要）——模型据此判断"这条要不要展开读"，
     用户也从清单里一眼看出资料库里都有什么（以前只有标题，标题党看不出来）。 */
  const line = s => '- ' + (Number(s.quality) === 1 ? '★' : '')
    + (Number(s.quality_score) ? '[AI ' + s.quality_score + '/5]' : '')
    + '[' + s.site + '｜' + s.kind + (s.topic ? '｜' + s.topic : '') + '] ' + s.title
    + (s.ai_summary ? ' —— ' + String(s.ai_summary).slice(0, 80) : '')
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
/* 对话助理的代码上下文：已导入代码库的完整文件清单 + 与本次问题最相关的文件内容。
   旧版导入只存了摘要、没有快照 —— 这里现场补存一次（目录还在的话），老用户不必重新导入。 */
function codeContextBlock(goal, message, stats) {
  const repos = db.prepare("SELECT id, url, title FROM sources WHERE goal_id = ? AND site = '导入的代码库'").all(goal.id);
  let rows = db.prepare('SELECT path, root, content, truncated FROM code_repo_files WHERE goal_id = ?').all(goal.id);
  if (!rows.length && repos.length) {
    for (const s of repos) {
      try { if (s.url && fs.existsSync(s.url)) codeStore.storeCodeRepoFiles(db, goal.id, s.id, s.url, nowISO); } catch (e) { console.log('[code-store] 现场补存失败：', e.message); }
    }
    rows = db.prepare('SELECT path, root, content, truncated FROM code_repo_files WHERE goal_id = ?').all(goal.id);
  }
  if (stats) { stats.repos = repos.length; stats.files = rows.length; }
  if (!rows.length && !repos.length) return '';
  const lines = ['', '【已导入的代码库】'];
  if (!rows.length) {
    lines.push('（有导入记录，但快照读不出来：' + repos.map(s => s.url || s.title).join('、') + ' —— 目录可能被移动或删除了，需要重新导入）');
    return lines.join('\n');
  }
  const byRoot = {};
  for (const f of rows) { const k = f.root || ''; (byRoot[k] = byRoot[k] || []).push(f); }
  for (const root of Object.keys(byRoot)) {
    const files = byRoot[root].slice().sort((a, b) => a.path.localeCompare(b.path));
    lines.push('');
    lines.push('● ' + (root || '（路径未知）') + '（已存 ' + files.length + ' 个文件的快照）');
    for (const f of files.slice(0, 400)) lines.push('- ' + f.path);
    if (files.length > 400) lines.push('…（其余 ' + (files.length - 400) + ' 个文件未列出）');
  }
  /* requireHits：没有真实命中时不要注入源码正文。
     否则"下一步做什么"这类与代码无关的话也会拖进 4 万字无关源码，
     每次对话凭空多 27k tokens（线上表现为"发消息特别慢"）。 */
  const picked = codeStore.pickCodeContext(rows, message, { requireHits: true });
  if (stats) stats.picked = picked.length;
  if (picked.length) {
    lines.push('');
    lines.push('【与本次问题最相关的源码（按你这句话里的关键词挑选，已脱敏；超长文件给的是命中处附近的片段）】');
    for (const f of picked) {
      lines.push('');
      lines.push('--- ' + f.path + (f.mid ? '（截断 · 中间片段）' : f.truncated ? '（截断）' : '') + ' ---');
      lines.push(f.text);
    }
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
  return promptContext.siblingScopeBlockFrom(sibs);
}
function sourcesBlock(goal, maxItems, maxLen) { return promptContext.sourcesBlockFrom(sourcesOf(goal.id), maxItems, maxLen, cleanText); }
/* 资料库注入（检索增强）：开了 RAG 就按当前问题检索片段，只把最相关的给模型；
   未启用/未命中/出错时自动回退到原来的「按条数铺开」方式 —— 行为安全可预期。
   两种情况都会附上标题索引，模型始终知道资料库里还有什么。 */
async function libraryBlock(goal, query, legacy) {
  if ((getSetting('rag_enabled', '1') || '1') !== '0') {
    try {
      const b = await rag.block(goal, query, { k: 10 });
      if (b) return b + sourcesIndexBlock(goal, 400, '【资料库索引（仅标题，未展开正文；需要时从检索结果里找）】', 12000);
    } catch (e) { console.log('[rag] 检索失败，回退整段资料：', e.message); }
  }
  return sourcesBlock(goal, (legacy && legacy.items) || 30, (legacy && legacy.len) || 180);
}
/* 在已有资料块之上，再补一段「按本节点/本阶段检索到的片段」（节点级资料之外的全库补充） */
async function ragAugment(goal, query, k) {
  if ((getSetting('rag_enabled', '1') || '1') === '0') return '';
  try { return await rag.block(goal, query, { k: k || 8 }); } catch (e) { return ''; }
}

async function buildClarifyPrompt(goal) {
  const lines = [];
  lines.push('你是资深的学习与成长路径规划师。规划前要先做一份**规划前问卷**，摸清用户的真实情况与真实水平。');
  lines.push('问卷质量直接决定规划是否贴合用户 —— 宁可多问，也不要凭假设规划。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(digestsBlock(goal));
  lines.push(await libraryBlock(goal, String(goal.title || '') + ' ' + String(goal.profile || '').slice(0, 300), { items: 30, len: 180 }));
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
      let raw1 = await aiText(prompt, model, 300000, null, null, '骨架生成');
      let out = extractJSONRaw(raw1);
      if (!out || !Array.isArray(out.questions) || !out.questions.length) {
        console.log('[drill] 第一次解析失败（输出 ' + String(raw1 || '').length + ' 字），重试一次。原始输出前 400 字:', String(raw1 || '').slice(0, 400));
        send({ status: '正在重新整理问题…' });
        const retryPrompt = prompt + '\n\n【重要】你上一次的输出不是合法 JSON 或缺少 questions 字段。请严格只输出一个 JSON 对象：{"reason":"...","questions":[{...}]}，不要输出任何其他文字、不要用代码块包裹。';
        raw1 = await aiText(retryPrompt, model, 300000, null, null, '骨架生成重试');
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

function constraintsOf(goal) {
  const list = safeParse((goal && goal.constraints) || '[]') || [];
  return (Array.isArray(list) ? list : []).map(c => (typeof c === 'string' ? { text: c } : c)).filter(c => c && String(c.text || '').trim());
}
function constraintsBlock(goal) {
  if (!goalCompOn(goal && goal.id, 'constraints')) return '';
  return promptContext.constraintsBlockFrom(constraintsOf(goal));
}
function goalQaBlock(goal) {
  const g = db.prepare('SELECT qa, clarify, clarify_answers FROM goals WHERE id = ?').get(goal.id);
  if (!g) return '';
  return promptContext.goalQaBlockFrom(safeParse(g.qa) || []);
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
async function buildStageGoalsPrompt(goal, stage) {
  const lines = [];
  lines.push('你是资深职业路径规划师。下面这个「阶段」的小目标太少，没有覆盖它要掌握的知识点。');
  lines.push('请把它的小目标补足：**阶段说明里提到的每个知识点 / 技术点 / 能力项都要有独立的小目标**（一个知识点一个，不要合并）。');
  lines.push('要求：① 保留原有小目标（措辞可微调）；② 补齐缺失的；③ 小目标要能独立验收、能力或成果导向；');
  lines.push('④ 一般 5-10 个，知识点多可到 16 个；⑤ 每个小目标给 **3-5 条** sources 依据（name 写来源，note 写「哪条要求导致这个节点必须存在」）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(digestsBlock(goal));
  lines.push(await libraryBlock(goal, String(stage.title || '') + ' ' + String(stage.detail || '').slice(0, 300), { items: 40, len: 200 }));
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
      const txt = await aiTextProgress(await buildStageGoalsPrompt(goal, st), model, 300000, send, '小目标', sig);
      const data = extractJSON(txt);
      const list = Array.isArray(data && data.goals) ? data.goals : (Array.isArray(data) ? data : []);
      const clean = list.filter(x => x && String(x.title || '').trim()).slice(0, 18);
      if (clean.length > before) {
        /* 补足会整段替换小目标：按标题把原来的条件归属带过去，新补的跟阶段走，
           否则补一次小目标，条件归属就全丢了。 */
        const oldCond = {};
        for (const g of (st.goals || [])) oldCond[titleOf(g)] = g.condition || '';
        st.goals = clean.map(g => Object.assign({}, g, { condition: g.condition || oldCond[titleOf(g)] || st.condition || '' }));
        console.log('[plan] 阶段补足:', String(st.title).slice(0, 20), before, '→', clean.length, '个小目标');
      }
    } catch (e) {
      if (e && e.cancelled) throw e;
      console.log('[plan] 阶段补足失败（忽略）:', e.message);
    }
  }
  return skeleton;
}
async function buildSkeletonPrompt(goal) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。请为目标设计「路径骨架」：只规划 阶段 与 小目标（具体任务稍后单独细化）。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(digestsBlock(goal));
  lines.push(await libraryBlock(goal, String(goal.title || '') + ' ' + String(goal.profile || '').slice(0, 400) + ' ' + String(goal.materials || '').slice(0, 200), { items: 60, len: 200 }));
  lines.push(askBlock(round, '路径骨架'));
  lines.push('');
  lines.push('【先想清楚：达成条件（必须做，不能只排阶段）】');
  lines.push('目标不是「把阶段走完」，而是「满足若干可验收的条件」。先列出要达到这个目标**必须满足的达成条件**：**先判断目标类型，再决定条件的依据与数量**——求职/转行/实习：依据 JD 原文（目标材料或资料库 JD；JD 不足时才按公共 AIPM JD 高频条款补齐）；学习/考证：依据考纲、课程大纲、教材要求；项目/产品/源码：依据交付物与验收标准（能运行 / 能上线 / 指标达标）；认知/兴趣：依据「能讲清 / 能应用 / 能做出东西」的检验点；习惯：依据可量化的频次与节奏。数量按「依据里的独立要求维度」决定：求职类通常 8-12 条（最多 14），学习/项目类 4-10 条，简单目标 3-6 条；一个维度至少一条、同类合并。按「硬性门槛 / 关键能力 / 成果证明 / 资源与资格」分组排序。');
  lines.push('条件 ≠ 阶段：阶段是时间上的推进台阶（先学什么、后做什么）；条件是要达成的东西，必须能用一句话判定「达成 / 没达成」。一条条件可以横跨多个阶段，一个阶段也可能同时服务多条条件。');
  lines.push('示例：目标「3 个月转行 AI 产品经理」→ 条件可以是「能独立产出合格 PRD」「掌握大模型能力边界」「有可演示的 AI 产品作品」「面试表达与项目讲述过关」「完成投递并进入面试」。');
  lines.push('**每条条件都要对到具体依据，不能是宽泛能力话术**：jd 字段写对应依据原文/条款——求职/转行类写 JD 原文；学习类写考纲/大纲/教材要求；项目类写交付物与验收标准；**非求职目标不要硬套 JD / 岗位条款**。求职类的 JD 材料不足时，才按**公共 AIPM（AI 产品经理）JD 高频条款**补足并标「（公共 AIPM JD 常见条款）」。');
  lines.push('2b. **条件写的是「必须做到 / 必须有」的东西，不是计划节点**：标题/说明里禁止路线图节点名或自造口号（反例：「按需解锁并落地」「XX 里程碑完成」）；**求职类尤其不能把目标名 / 个人项目名当条件**（反例：「思而行闭环与证据跑通」「思而行架构机制全景可盲讲」）；项目类目标可以写自己项目的可验收成果（如「一键跑起来并复现核心流程」），但要能判定。输出前**去重**：同一个要求只出一条，近义/重叠条款合并。');
  lines.push('然后：每个阶段、每个小目标都必须在 condition 字段写明它主要服务于哪一条条件（填 conditions 里的 key）；确保每条条件至少对应一个小目标。');
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
  lines.push('4. 每个节点 detail 写 60-120 字，并且**必须交代「为什么现在做它」**：要达成什么 + 它在整个目标里的作用（承接了什么、给后面的什么铺路）。用户点开最想知道的就是这个，不能只写做法。');
  lines.push('5. 【依据就是这个节点存在的理由，必须写足】每个节点都给 sources 依据：**阶段 4-6 条、小目标 3-5 条**。');
  lines.push('   · 千万不要只给 1 条 —— 一条依据撑不起一个节点，用户执行时会觉得「凭什么做这个」。');
  lines.push('   · name 写实际来源（站点名 + 标题要点；用户提供的写「用户提供的资料：<标题>」，导入的代码库写「导入的代码库：<路径>」）。');
  lines.push('   · note 必须写清「这条资料里的哪条要求/结论，导致了这个节点必须存在」，例如：「JD 明确要求 3 年 Go 经验，本节点补足语言基本功」「提炼汇总把 asyncio 列为必需，故单独成节点」「用户自述函数名写不出，本节点解决这个短板」。');
  lines.push('   · 依据要分散：不同节点尽量引用不同资料，让整条路线的支撑面铺开；优先级 ① 用户提供的资料 ② 提炼汇总结论 ③ 检索到的片段 ④ 索引条目。');
  lines.push('   优先引用：① 用户提供的资料 ② 提炼汇总里的结论 ③ 下面列出的资料；不同阶段尽量引用与它最相关的不同资料，让依据分布开来。');
  lines.push('6. 路径必须匹配用户现状（零基础从基础开始，有基础则跳过）；顺序体现「真实工作中最看重什么」。');
  lines.push('7. 只输出一个 JSON 对象（不要其他文字或代码块标记），量控制在 30000 字符内（内容多时 detail 可精简到 40-80 字，但小目标不要省）：');
  lines.push('{"summary":"总体思路","conditions":[{"key":"c1","title":"条件名（10-20字）","detail":"60-120字：为什么必须满足它","acceptance":"可验证的判定标准","jd":"对应的 JD 原文/条款（没有就写公共 AIPM JD 常见条款）","priority":"must|should|nice"}],"stages":[{"title":"阶段名","detail":"60-120字说明","condition":"c1","sources":[{"name":"来源","note":"依据要点"}],"goals":[{"title":"小目标名","detail":"60-120字","condition":"c1","sources":[{"name":"","note":""}]}]}]}');
  lines.push('8. 若按上面的「关键机制」需要先提问，则只输出 {"analysis":"你的分析","questions":[...]}，不要输出 stages。');
  return lines.join('\n');
}
async function buildTasksPrompt(goal, stage, stageIndex) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。请为下面这个阶段细化出「具体可执行任务」。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(digestsBlock(goal));
  lines.push(nodeSourcesBlock(goal, stage, 1000));
  const aug = await ragAugment(goal, String(stage.title || '') + ' ' + String(stage.detail || '').slice(0, 300), 8);
  if (aug) lines.push(aug);
  lines.push(sourcesIndexBlock(goal, 400, null, 14000));   // 全量索引：依据要挑得出来
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
  lines.push('   - sources：**3-5 条依据**（name 写实际来源，note 写清「这条资料里的哪条要求/结论导致这个任务必须做」——依据是任务存在的理由，只给 1 条说明不了问题）');
  lines.push('3. 只输出一个 JSON 对象（不要其他文字或代码块标记）：');
  lines.push('{"goals":[{"index":0,"tasks":[{"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}]}]}');
  lines.push('4. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 goals。');
  return lines.join('\n');
}
/* ===== AI 调用（由 server/ai.js 提供，支持任意 OpenAI 兼容接口或 opencode CLI） ===== */
/* scene 是 Q5 失败率的分组维度（"哪个功能最不靠谱"）。
   放在参数最末尾 → 既有调用点一行不改也能跑，不传就记 'unknown'。 */
async function aiText(prompt, model, timeoutMs, onEvent, signal, scene) {
  return ai.text({ prompt, model: model || currentModel(), timeoutMs, onEvent, signal, scene: scene || 'unknown' });
}
async function aiTextFiles(prompt, model, files, timeoutMs, signal, scene) {
  return ai.text({ prompt, model: model || currentVisionModel(), images: files || [], timeoutMs, signal, scene: scene || 'vision' });
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
async function buildExpandPrompt(goal, node, sources, folderCode) {
  const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '节点';
  const lines = [];
  /* 展开也要分档：层级越细的节点，子任务越少、依据条数越少。
     原来不分层级一律"5-8 个 × 每个 3-5 条依据"，一个"步骤"级节点也要
     吐出一大篇 JSON（实测单次调用 40~90 秒）。细节点不需要那么多。 */
  const ex = effort.expandEffort(node);
  lines.push('你是资深职业路径规划师。请把下面这个节点拆成更细、可直接执行的任务'
    + (ex.batch ? '（' + (ex.batch - 2) + '-' + ex.batch + ' 个）' : '（5-8 个，**最多 10 个**）') + '。');
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
  const aug = await ragAugment(goal, String(node.title || '') + ' ' + String(node.detail || '').slice(0, 300), 8);
  if (aug) lines.push(aug);
  if (folderCode) {
    lines.push('');
    lines.push('【挂载文件夹的源码节选（只读讲解依据，不要复述整段代码）】');
    lines.push(String(folderCode).slice(0, 15000));
  }
  lines.push(nodeTutorialBlock(node));
  lines.push(sourcesIndexBlock(goal, 400, null, 14000));   // 全量索引：依据要挑得出来
  lines.push(askBlock(node.ask_round || 0, '该节点的拆分'));
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 只围绕该节点主题展开，生成 ' + (ex.batch ? (ex.batch - 2) + '-' + ex.batch + ' 个子任务' : '5-8 个子任务（最多 10 个）')
    + '，颗粒度比现有任务更细（每个 2-6 小时可完成）。任务数量不要多，用户压力要小。'
    + (ex.batch ? '（该节点层级较细，本来就该是几个小步骤，不要硬凑数量）' : ''));
  lines.push('2. 每个子任务必须给出：');
  lines.push('   - title：动词开头、具体可执行');
  lines.push('   - detail：怎么做，60-120 字，写清步骤/方法/用到的资源');
  lines.push('   - artifact：产出物（具体文件/仓库/笔记/作品）');
  lines.push('   - acceptance：验收标准（可自检）');
  lines.push('   - hours：预计投入小时数（如「3h」）');
  lines.push('   - sources：' + (ex.batch ? '**2-3 条依据**（细步骤不必每条都凑满 5 条）' : '**3-5 条依据**')
    + '（name 写实际来源（站点+标题要点），note 写清这条资料支撑了什么要求/结论）');
  lines.push('3. 优先依据上面检索到的真实资料；如果资料不足，依据公开公认做法并标注「待核实」。');
  lines.push('4. 只输出一个 JSON 对象（不要其他文字或代码块标记）：');
  lines.push('{"tasks":[{"title":"","detail":"","artifact":"","acceptance":"","hours":"","sources":[{"name":"","note":""}]}]}');
  lines.push('5. 若按「关键机制」需要先提问，则只输出 {"questions":[...]}，不要输出 tasks。');
  lines.push('6. 如果上面给了挂载文件夹的源码节选：拆分必须沿代码的真实模块/目录结构走（每个子任务对应到具体的包、文件或组件），不要拍脑袋编阶段；detail 里点出要读哪几个文件。');
  return lines.join('\n');
}

/* 按用户意见修改已有教程 */

/* 「只改这一处」的补丁提示词。
   为什么要它：全文重写模式下，改一句话也要把整篇教程重新输出一遍
   （实测 7 万字的教程要 4 轮续写、190~355 秒）。补丁模式只让它回
   「原文片段 → 改后片段」，输出量从 7 万字降到几十字，秒级完成。 */
function buildTutorialPatchPrompt(tut, feedback, excerpt, whole, codeBlock) {
  const lines = [];
  lines.push('你是耐心、严谨的技术导师。用户对**已生成的教程**提了一处修改意见。');
  lines.push('');
  lines.push('⚠️ **不要重写整篇教程**，只输出需要改动的那个片段。');
  lines.push('整篇有几万字，逐字重发既慢、又容易把没提到的段落改坏。');
  lines.push('');
  lines.push('【教程主题】' + String(tut.title || ''));
  lines.push('');
  lines.push('【用户的修改意见（必须满足）】' + String(feedback || '').slice(0, 1500));
  lines.push('');
  lines.push(whole ? '【教程正文】' : '【教程正文（只给了相关章节；补丁只会套用到这些范围内）】');
  lines.push(excerpt);
  if (codeBlock) { lines.push(''); lines.push(codeBlock); }
  lines.push('');
  lines.push('【输出格式】只输出补丁，格式必须**一字不差**地照下面来：');
  lines.push('<<<<<<< SEARCH');
  lines.push('（要改的原文，必须和上面正文**逐字一致**，包括标点、空格、换行位置）');
  lines.push('=======');
  lines.push('（改完之后的样子）');
  lines.push('>>>>>>> REPLACE');
  lines.push('');
  lines.push('【规则】');
  lines.push('1. SEARCH 里只放**最小必要片段**：3~15 行，能唯一定位到就行；**绝不要**贴整节或整篇。');
  lines.push('2. 一处改动一个补丁；有多处就写多个补丁，按从上到下的顺序。');
  lines.push('3. SEARCH 必须在正文里**唯一**；如果那句话出现多次，多带一行上下文。');
  lines.push('4. 没提到的内容**一个字都不要输出**：不要复述目录、不要写总结、不要输出没改的段落。');
  lines.push('5. 补丁之外不要有任何解释文字、不要用 ``` 包起来。');
  lines.push('6. 改 ```viz 可视化块里的 HTML/样式时同样适用：只贴要改的那几行。');
  lines.push('7. 如果这份意见其实是**整篇重做**（重排结构、每节都要动），就不要硬写补丁，只回一行：NEED_FULL_REWRITE');
  return lines.join('\n');
}
/* 数一份教程里的 ```viz 块，并给每个块算个"长相指纹"（长度 + 开头特征），
   用来判断"这个块还在不在、还是不是原来那个"。改教程时 AI 把可视化整段删掉、
   或者悄悄换成一段文字，只看总长度是发现不了的 —— 那正是用户肉眼会发现的损失。 */
function vizBlocks(txt) {
  const out = [];
  const re = /```(?:viz|demo|htmlviz)\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(String(txt || '')))) {
    const b = m[1];
    out.push({ len: b.length, head: b.replace(/\s+/g, ' ').slice(0, 40), isHtml: /<[a-zA-Z][\w-]*[\s\S]*>/.test(b) });
  }
  return out;
}
/* 原教程里的可视化块，改完还在不在、还是不是原来那个。
   ⚠️ 之前这版在 `a.length <= b.length` 时直接返回 null —— 于是"删掉一个旧的、
   另写一个新的"这种最典型的丢失（实测：把我那张 HTML 流程图换成了一张字符画，
   块数不变，守卫全绿）根本不会被发现。数不变不代表没丢，要逐块对指纹。 */
function vizLoss(before, after) {
  const a = vizBlocks(before), b = vizBlocks(after);
  if (!a.length) return null;
  const match = x => b.some(y => y.isHtml === x.isHtml && Math.abs(y.len - x.len) < Math.max(300, x.len * 0.25));
  const gone = a.filter(x => !match(x));
  if (!gone.length) return null;
  const hadHtml = a.filter(x => x.isHtml).length, nowHtml = b.filter(x => x.isHtml).length;
  /* ⚠️ 只要「总块数」和「HTML 演示数」都没减少，就不算丢失 —— 那只是**重写**。
     实测误报（2026-10-12）：用户要求"把 ReAct 那段做成 HTML 可视化"，AI 从 6 块做到 8 块
     （净增 2 块），同时重写了原有的一块 → 指纹对不上 → 判成"丢失"，把用户正想要的结果拒了。
     真正要拦的是这两种，它们都会让计数**下降**：
       · 整块被删掉
       · HTML 演示被降级成一段文字或字符画（块数可能不变，但 HTML 数会掉） */
  if (b.length >= a.length && nowHtml >= hadHtml) {
    console.log('[tutorial] 可视化块被重写（块 ' + a.length + '→' + b.length + '，其中 HTML ' + hadHtml + '→' + nowHtml + '），不算丢失：'
      + gone.map(x => x.head).join(' / '));
    return null;
  }
  return { had: a.length, now: b.length, gone: gone.slice(0, 2).map(x => (x.isHtml ? 'HTML 演示「' : '非 HTML 内容「') + x.head + '」') };
}
/* 章节流失守卫（structureLoss）见 server/tut-guard.js ——
   它比原来聪明的地方：能认出"用户点名要重写的那一段"（从「X」往后 / 第 7 节之后 /
   整篇重写），只要求**范围外**的章节一节不少，范围内的重组放行。
   原来那版对全篇逐字比对，用户明确要求重写后半本也会被判"改坏了结构"而拒收
   （2026-10-14 线上：连续两次白写 3 分钟，见 tut-guard.js 顶部注释）。 */

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
  lines.push('   ⚠️ 用户往往只针对某一段提意见（"这节太抽象"），**绝不能因此把整本教程重写**：');
  lines.push('   原有的每一个章节（分步实践、验收标准、面试追问、速查卡、延伸阅读、小结…）都要留着，');
  lines.push('   标题可以微调，但不许整节整节地消失。要改哪就只改哪。');
  /* 意见里点明了重写范围时，把"哪一段可以动、哪一段必须原样保留"直接写进提示词 ——
     否则模型一边想按意见重排、一边又怕删章节，最后交出个四不像，
     而"范围外被动了"和"范围内没敢改"两边都会被守卫挡下来。 */
  const sc = tutGuard.parseEditScope(feedback, tut.content || '');
  if (sc.mode === 'range') {
    lines.push('   ✅ **本次允许改动的范围**（用户已经点名）：从「' + sc.fromTitle + '」这一节开始，到全篇结束。');
    lines.push('   这一段的章节结构可以按意见重排（合并、拆分、改标题、调顺序、重新编号都行）；');
    lines.push('   但**这一节之前的 ' + sc.fromIdx + ' 个章节必须原样保留** —— 标题、顺序、内容一个字都不要动'
      + '（范围外的章节少一个就会被系统拒收，这次修改就白做了）。');
  } else if (sc.mode === 'all') {
    lines.push('   ✅ **本次允许调整章节结构**：可以重排、合并、拆分、新增章节（用户已同意），');
    lines.push('   但已经讲过的知识点、代码、可视化演示不能凭空消失。');
  }
  lines.push('2. 保持原有格式与结构风格，篇幅可增可减，但要保证「能照着学会」；');
  lines.push('3. 直接输出修改后的完整教程正文（' + (format === 'md' ? 'Markdown' : 'HTML') + '），不要任何解释或前后缀。');
  lines.push('4. 范围顺手清理：如果正文里混入了与【教程主题】无关的其它章节的成段内容，且用户意见没有要求保留，可顺手删减；不要新增超出主题的新章节。');
  if (format === 'md') {
    lines.push('5. **可视化块要原样留住**：正文里的 ```viz … ``` 块是能跑起来的演示页面，除用户明确要求外不要删除、');
    lines.push('不要改成普通代码块、不要只留片段、更不要把里面的 HTML 换成一段文字描述；');
    lines.push('更不能改成 -> v ^ | ─ │ ┌ ┐ └ ┘ 这类字符画（网页里会因字体和缩进错位、箭头对不齐而读不出来）。');
    lines.push('6. **主动判断哪里该补可视化（不是只听用户提）**：用户往往只会说"这里没讲清"或"太抽象了"，');
    lines.push('不会说"你要插个 HTML"。所以你要**自己通读全文，逐段判断**：');
    lines.push('· 凡是涉及流程、调用链、状态流转、分支判断、时序先后、数据结构、并发交错的地方，');
    lines.push('  如果现在只有文字描述（哪怕写得很长），就在对应位置**插入一个新的 ```viz 可视化块**；');
    lines.push('· 插入位置要对：放在它所解释的那段文字**紧后面**，不要堆到章节末尾或全挤在一起；');
    lines.push('· 原来某个 ```viz 块覆盖得不全（比如只画了主流程没画异常分支），可以在它后面补一个，');
    lines.push('  也可以在同一个块内补全 —— 但**已有的块优先在原位改好，而不是删了重写**；');
    lines.push('· 已经在块里讲清楚了的，不要重复再造一个讲同样的事。');
    lines.push('');
    lines.push('（以下是可视化块的完整写法与规范，新增的块必须照着做）');
    for (const L of vizSpecLines()) lines.push(L);
    lines.push('');
    lines.push('7. **强调与折叠块的处理**：正文里已有的 `<span style="color:…">` 标红、`<details><summary>…</summary>` 折叠块'
      + '（见下面的规范）**要留住**，别删、别把 HTML 转义成文字；'
      + '如果用户意见是"看不清重点 / 样式太单一"，就按规范补上（每节最多 3 处标红）。');
    for (const L of richMdSpecLines()) lines.push(L);
  }
  lines.push('');
  lines.push('【原教程正文】');
  lines.push(fullTutorialForEdit(tut.content));
  if (codeBlock) { lines.push(''); lines.push(codeBlock); }
  return lines.join('\n');
}
/* 改教程时把原文喂给 AI 的预算。
   ⚠️ 原来是硬 slice(0, 30000)，而模型必须输出**改好的全文** —— 于是超 30K 的教程
   （线上最长 71K，5 份超限）AI 只看得到开头，尾部连同里面的可视化块会被静默删掉，
   而长度校验只比总长、看不出少了一整节。
   这里改成：额度内**整篇照给**；额度外宁可**直接报错**，也不偷偷截断 ——
   悄悄删内容比明确失败恶劣得多。90K 字符约 6~9 万 token，覆盖现有全部教程。 */
const TUT_EDIT_MAX = 90000;
function fullTutorialForEdit(content) {
  const s = String(content || '');
  if (s.length <= TUT_EDIT_MAX) return s;
  throw new Error('这份教程有 ' + s.length + ' 字，超出一次交给 AI 修改的上限（' + TUT_EDIT_MAX + ' 字），已**没有改动**。'
    + '把意见写得更具体一点 —— **点名到某一节**（写它的标题），系统就只把那一节发给 AI、其余正文逐字保留；也可以把意见拆小分多次提。'
    + '（绝不能只把前半截发给 AI 让它"改好"，那会把后半截整段删掉。）');
}
/* 长教程走「分节改写」（见 server/tut-seg.js）：只有"点名了范围 / 允许整篇重排"的意见才走，
   因为要切块就必须知道改哪几段；这种情况连 TUT_EDIT_MAX 也不受限制 —— 输出量只跟要改的那几节有关。 */
const SEG_MIN = 28000;      // 正文超过这个长度才值得分段（短教程一次改完，少一次拼装）
const SEG_CHUNK = 14000;    // 每块目标字数：撞单次输出上限前留足余量，也给续写留空间

/** 分节改写：逐块问 AI「只改这一段」，再把各块拼回整篇。返回拼好的整篇正文。 */
function buildSegmentPrompt(goal, node, tut, feedback, seg, info, codeBlock) {
  const L = [];
  L.push('你是耐心、严谨的技术导师。用户对一份**长教程**提了修改意见，现在按「分段重写」来改：');
  L.push('整篇太长没法一次改完，所以我们一次只改其中一段，改完全部再拼回整篇。');
  L.push('');
  L.push(goalHeader(goal));
  L.push(constraintsBlock(goal));
  L.push('');
  L.push('【教程主题】' + String(tut.title || (node && node.title) || ''));
  L.push('【用户的修改意见（必须全部满足；这一段也要按它改）】' + String(feedback || '').slice(0, 1500));
  L.push('');
  L.push('【这次只改第 ' + info.no + '/' + info.total + ' 段】');
  L.push('· 这一段的范围：从「' + seg.title + '」' + (seg.last && seg.last !== seg.title ? '到「' + seg.last + '」' : '') + '（这两节都含在内）'
    + (seg.mid ? '（注意：这一段是某一大节里的**一部分**，不是完整小节）' : ''));
  if (info.nextTitle) L.push('· 紧接着的下一节是「' + info.nextTitle + '」，**不在你这次的范围内**，一个字都不要碰、也不要输出。');
  if (info.prevTail) {
    L.push('· 上一段刚改完的结尾（衔接自然即可，别重复它的内容）：');
    L.push('```text');
    L.push(info.prevTail.slice(-600));
    L.push('```');
  }
  L.push('');
  L.push('【硬性要求】');
  L.push('1. **只输出这一段改好后的正文**。不要输出别的段、不要重述目录、不要写"已修改/以下是"之类的话 ——');
  L.push('   系统会把各段按顺序拼回整篇，你多输出别的段就会重复出现。');
  L.push('2. 这一段内部允许按意见重排、合并、拆分、改标题；但**段首那一节的标题要保留**（除非意见明确要求改名）。');
  L.push('3. 不要在本段末尾自行追加"小总结/下一步预告"这类内容，也不要新增超出本段主题的章节。');
  L.push('4. 代码块、表格、可视化块必须完整闭合 —— 分段重写最容易犯的错就是这里少一个 ```。');
  if (tut.format === 'md') {
    L.push('5. 本段里原有的 ```viz 可视化块除意见明确要求外要原样留住（不要换成文字描述、不要换成字符画）。');
    L.push('6. 标红强调（`<span style="color:#dc2626;font-weight:700">…</span>`）与 `<details><summary>参考答案</summary>…</details>`'
      + '折叠块是本产品认得的格式，原样留住、别删也别转义；要补重点时照这个写法加（每节最多 3 处）。');
    if (/可视化|viz|演示|图/.test(String(feedback || ''))) for (const x of vizSpecLines()) L.push(x);
  }
  if (codeBlock) { L.push(''); L.push(codeBlock); }
  L.push('');
  L.push('【这一段现在的正文（原样给你；改好后把整段返回，不要带下面这两行标记）】');
  L.push('<<<SEGMENT_START>>>');
  L.push(String(info.text || ''));
  L.push('<<<SEGMENT_END>>>');
  return L.join('\n');
}

function buildTutorialPrompt(goal, node, format, note, codeBlock, budget) {
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
  /* 篇幅预算：不给上限时模型会一路灌水（实测一个 1 小时的任务写出 6~7 万字）。
     写成"用户可以花多少时间读"比"多少字"更好执行 —— 模型对字数的感觉很不准。 */
  if (budget && budget.target && format !== 'html') {
    const mins = Math.max(5, Math.round(budget.target / 380));   // 中文阅读速度约 380 字/分钟
    /* ⚠️ 只写"控制在 X 字"没用 —— 实测要求 7000 字，模型照样写 21000。
       模型对字数的感知很不准，但对**结构数量**的遵守度高得多。
       所以这里同时给出可数的约束：几节、每节几段。 */
    const secs = Math.max(4, Math.round(budget.target / 1500));
    const perSec = Math.round(budget.target / secs);
    lines.push('- **篇幅与结构**：整篇控制在 ' + budget.target + ' 字左右（用户读一遍约 ' + mins + ' 分钟）。'
      + '具体到结构：**二级标题不超过 ' + secs + ' 个，每个二级标题下面正文不超过 3 段、每段 3~5 句**。'
      + '宁可一节只讲透一个点，也不要为凑满结构把每节都写长。');
    lines.push('- 不要写"本节小结""总结一下"这类收尾段；不要重复解释同一个概念；不要堆砌与任务无关的背景。'
      + '真正一图胜千言的地方交给你下面的可视化块，而不是继续加字。');
  }
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
    for (const L of richMdSpecLines()) lines.push(L);
    for (const L of vizSpecLines()) lines.push(L);
  }
  return lines.join('\n');
}
async function buildRefineNodePrompt(goal, node, kids, feedback, folderCode) {
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
  const aug = await ragAugment(goal, String(node.title || '') + ' ' + String(feedback || '').slice(0, 200), 8);
  if (aug) lines.push(aug);
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
  lines.push('3. 每个子任务给出：title / detail（60-120字做法 + 为什么现在做它）/ artifact（产出物）/ acceptance（验收标准）/ hours（预计小时）/ sources（**3-5 条依据**，note 写清依据了什么要求）。');
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
const versionDomain = createVersionDomain({
  db: db, nowISO: nowISO, safeParse: safeParse,
  goalCompOn: goalCompOn, aiText: aiText, currentModel: currentModel
});
const beginVersion = versionDomain.beginVersion;
const diffVersions = versionDomain.diffVersions;
const templateReport = versionDomain.templateReport;
const buildReportPrompt = versionDomain.buildReportPrompt;
const finishVersion = versionDomain.finishVersion;




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
    /* condition 是「这个阶段主要服务哪条达成条件」的 key，必须跟着阶段一路带下去 */
    if (title && !goals.length) { pending = { title, detail: raw.detail || '', sources: raw.sources || [], condition: raw.condition || raw.condition_key || '' }; continue; }
    if (!title && goals.length) {
      const last = out[out.length - 1];
      if (last && !last.goals.length) {           // 上一个阶段还空着，直接补进去
        last.goals = goals.slice(0, 20);
        if (!last.detail && raw.detail) last.detail = raw.detail;
        if (!last.condition && (raw.condition || raw.condition_key)) last.condition = raw.condition || raw.condition_key;
      } else {
        const base = pending || { title: '', detail: '', sources: [], condition: '' };
        out.push({ title: base.title, detail: base.detail || raw.detail || '', sources: base.sources || raw.sources || [], condition: base.condition || raw.condition || raw.condition_key || '', goals: goals.slice(0, 20) });
      }
      pending = null;
      continue;
    }
    if (title && goals.length) {
      out.push({ title, detail: raw.detail || '', sources: raw.sources || [], condition: raw.condition || raw.condition_key || '', goals: goals.slice(0, 20) });
      pending = null;
      continue;
    }
  }
  if (pending && out.length) {   // 结尾多出来的标题：把它的说明补进上一个阶段
    const last = out[out.length - 1];
    if (!last.detail && pending.detail) last.detail = pending.detail;
    if (!last.condition && pending.condition) last.condition = pending.condition;
  }
  return out.filter(s => s.title && s.goals.length).slice(0, 14);
}
function saveSkeleton(goalId, plan) {
  const stages = normalizeSkeleton(plan.stages);
  if (!stages.length) throw new Error('骨架结构异常（没有可用阶段），请重试');
  /* 先把规划里的「达成条件」写库（只替换 source='plan' 的，手动条件保留），
     拿到 key → id 的解析器，再把每个阶段/小目标挂上去。 */
  const condInfo = conditionsDomain.saveFromPlan(goalId, plan);
  const old = db.prepare('SELECT id FROM nodes WHERE goal_id = ?').all(goalId).map(x => x.id);
  for (const id of old) db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM node_workspaces WHERE goal_id = ?').run(goalId); } catch (e) {}
  const summary = String(plan.summary || '').slice(0, 800);
  // 骨架已定：旧问卷作废（clarify 答案保留在 clarify_answers 里），避免目标页 sticky 显示过期问卷
  db.prepare("UPDATE goals SET summary = ?, status = ?, error = ?, clarify = '', clarify_stage = '', updated_at = ? WHERE id = ?").run(summary, 'planning', '', nowISO(), goalId);
  const stageIds = [];
  stages.forEach((st, si) => {
    const stCond = condInfo.resolve(st.condition);
    insertNode(goalId, null, 0, st.title, st.detail || '', st.sources, si, { condition_id: stCond });
    const stageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    stageIds.push(stageId);
    let gi = 0;
    for (const g of st.goals) {
      /* 小目标没写条件时退到阶段的条件（不能让它掉成未归属） */
      insertNode(goalId, stageId, 1, g.title || '小目标', g.detail || '', g.sources, gi, { condition_id: condInfo.resolve(g.condition) || stCond });
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
/* 规划收尾：如果这次 AI 没产出达成条件（旧提示词覆盖、模型漏了、或老目标重排），
   就从已保存的路线图反推一遍。只补空，不覆盖：已有条件时直接返回。
   失败只记日志 —— 条件梳理失败不能把「规划成功」变成「规划失败」。 */
async function ensureConditionsFromPlan(goal, send) {
  try {
    const has = conditionsDomain.countForGoal(goal.id);
    if (has) return has;
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(goal.id).c;
    if (!cnt) return 0;
    if (send) send({ status: '正在梳理「要达成目标需要满足哪些条件」…' });
    await conditionsDomain.generateFromNodes(goal.id);
    return conditionsDomain.countForGoal(goal.id);
  } catch (e) {
    console.log('[conditions] 自动梳理达成条件失败（不影响规划）:', e.message);
    return 0;
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
      let clarifyPrompt;
      if (promptPacks.hasOverride('plan.clarify')) {
        clarifyPrompt = await promptPacks.renderAsync('plan.clarify', {
          goal: goal,
          goalHeader: goalHeader(goal),
          digests: digestsBlock(goal),
          library: await libraryBlock(goal, String(goal.title || '') + ' ' + String(goal.profile || '').slice(0, 300), { items: 30, len: 180 })
        });
      } else {
        clarifyPrompt = await buildClarifyPrompt(goal);
      }
      const txt = await aiTextProgress(clarifyPrompt, model, 300000, send, '问题', sig);
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
      prompt, model, timeoutMs, signal, scene: '助手对话',
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
  lines.push('{"summary":"总体思路","conditions":[{"key":"c1","title":"条件名","detail":"为什么必须满足","acceptance":"判定标准","jd":"对应的 JD 原文/条款","priority":"must|should|nice"}],"stages":[{"title":"阶段名","detail":"60-120字说明","condition":"c1","sources":[{"name":"来源","note":"依据要点"}],"goals":[{"title":"小目标名","detail":"60-120字","condition":"c1","sources":[{"name":"","note":""}]}]}]}');
  lines.push('要求：阶段 3-12 个；达成条件按 JD 独立维度给全（求职/转行类通常 8-12 条、最多 14；非求职 4-10 条；条件≠阶段，要能判定达成/没达成，**每条都要有 jd 字段对到 JD 原文或公共 AIPM JD 条款**），每个阶段和小目标都要写 condition（填 conditions 的 key）；每个阶段的小目标按知识点数量决定（一般 5-10 个，多的可到 16 个，一个知识点至少一个）；**阶段 5-8 条依据、小目标 3-5 条**（依据是节点存在的理由，不要只给 1 条）；detail 可精简到 40-80 字。');
  return lines.join('\n');
}
function streamPlan(req, res, goal, answers) {
  // 第一步：只生成骨架（阶段 + 小目标），等待用户确认（会带上澄清问答）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const tk = tasks.begin({ type: 'plan', title: '生成规划：' + String(goal.title || '').slice(0, 30), goalId: goal.id, phases: ['生成骨架', '细化小目标', '保存'] });
  const send = obj => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
    if (!obj) return;
    if (obj.status) tk.progress(undefined, obj.status);
  };
    const sig = tk.signal;
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
      let planPrompt;
      if (promptPacks.hasOverride('plan.skeleton')) {
        const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
        planPrompt = await promptPacks.renderAsync('plan.skeleton', {
          goal: goal,
          goalHeader: goalHeader(goal),
          qa: goalQaBlock(goal),
          constraints: constraintsBlock(goal),
          digests: digestsBlock(goal),
          library: await libraryBlock(goal, String(goal.title || '') + ' ' + String(goal.profile || '').slice(0, 400) + ' ' + String(goal.materials || '').slice(0, 200), { items: 60, len: 200 }),
          ask: askBlock(round, '路径骨架')
        });
      } else {
        planPrompt = await buildSkeletonPrompt(goal);
      }
      let skeletonText = await aiTextProgress(planPrompt, model, 600000, send, '阶段/小目标', sig);
      let skeleton = extractJSON(skeletonText);
      if (skeleton && Array.isArray(skeleton.questions) && skeleton.questions.length) {
        saveGoalQuestions(goal.id, 'plan', skeleton);
        tk.done({ questions: skeleton.questions.length, stage: 'plan' });
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
      const condCount = await ensureConditionsFromPlan(goal, send);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '生成新骨架');
      backup();
      tk.done({ stages: skeleton.stages.length, conditions: condCount, versionId: vid });
      send({ done: true, stages: skeleton.stages.length, conditions: condCount, goal: getGoal(goal.id), report, versionId: vid });
    } catch (e) {
      tk.fail(e);
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
  return tk;
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
      const condCount = await ensureConditionsFromPlan(goal, send);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '继续构思生成骨架');
      backup();
      clearPlanDraft(goal.id, 'skeleton');
      send({ done: true, stages: grown.stages.length, conditions: condCount, goal: getGoal(goal.id), report, versionId: vid });
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
  /* 调整骨架时要连「达成条件」一起给模型，否则它按旧模板只回 stages，
     条件就整批丢了（也看不出某个阶段/小目标原来服务哪条条件）。 */
  const conds = db.prepare('SELECT id, title, detail, acceptance, jd_ref, priority FROM goal_conditions WHERE goal_id = ? ORDER BY sort_order, id').all(goalId);
  const keyOf = new Map();
  const condList = conds.map((c, i) => {
    const key = 'c' + (i + 1);
    keyOf.set(Number(c.id), key);
    return { key, title: c.title, detail: c.detail, acceptance: c.acceptance, jd: c.jd_ref || '', priority: c.priority || 'must' };
  });
  const stages = db.prepare('SELECT id, title, detail, sources, condition_id FROM nodes WHERE goal_id = ? AND level = 0 ORDER BY sort_order, id').all(goalId);
  const out = stages.map(st => ({
    title: st.title, detail: st.detail, sources: safeParse(st.sources) || [],
    condition: keyOf.get(Number(st.condition_id)) || '',
    goals: db.prepare('SELECT title, detail, sources, condition_id FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(st.id)
      .map(s => ({ title: s.title, detail: s.detail, sources: safeParse(s.sources) || [], condition: keyOf.get(Number(s.condition_id)) || '' }))
  }));
  out.conditions = condList;
  return out;
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
          const txt = await aiTextProgress(await buildTasksPrompt(goal, st, i), model, 300000, send, '任务', sig);
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
async function buildRefineSkeletonPrompt(goal, current, feedback) {
  const round = db.prepare('SELECT ask_round FROM goals WHERE id = ?').get(goal.id).ask_round || 0;
  const lines = [];
  lines.push('你是资深职业路径规划师。用户对现有路径骨架提出了意见，请按意见调整。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  lines.push(digestsBlock(goal));
  lines.push(await libraryBlock(goal, String(goal.title || '') + ' ' + String(feedback || '').slice(0, 300), { items: 40, len: 200 }));
  lines.push(askBlock(round, '骨架调整'));
  lines.push('');
  lines.push('【现有骨架（含达成条件 conditions 与每个节点的 condition 归属）】');
  lines.push(JSON.stringify(Array.isArray(current) ? { conditions: current.conditions || [], stages: current } : current));
  lines.push('');
  lines.push('【用户反馈（必须采纳）】' + feedback);
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 只调整用户指出的问题，其余尽量保持原样（**除非用户明确要求增加 / 删除 / 合并阶段，否则阶段数量、顺序、命名保持稳定**）。用户说"阶段太少/太多/想加一个 XX 阶段"时，就按要求调整数量。');
  lines.push('   · 用户说某个阶段「小目标太少 / 没覆盖到 X」时：直接给该阶段补足小目标（一个知识点一个，必要时可到 16 个），不要只做表面微调。');
  lines.push('2. 输出完整的调整后骨架（含 conditions 与每个阶段/小目标的 condition）；用户没提条件时，条件与归属保持原样（key 可以重排，但要覆盖全部现有条件）；增删节点后每条小目标仍要有归属。');
  lines.push('2b. 条件必须保留 jd 字段（对应 JD 原文/条款）；用户要求按 JD 重写条件时，逐条对到 JD 具体描述，不要退回宽泛表述。');
  lines.push('3. 只输出一个 JSON 对象：{"summary":"总体思路","conditions":[{"key":"c1","title":"","detail":"","acceptance":"","jd":"","priority":"must|should|nice"}],"stages":[{"title":"","detail":"","condition":"c1","sources":[{"name":"","note":""}],"goals":[{"title":"","detail":"","condition":"c1","sources":[{"name":"","note":""}]}]}]}');
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
      const refinePrompt = await buildRefineSkeletonPrompt(goal, current, feedback);
      let txt = await aiTextProgress(refinePrompt, model, 480000, send, '阶段/小目标', sig);
      let plan = extractJSON(txt);
      if (!plan || !Array.isArray(plan.stages) || !plan.stages.length) {
        console.log('[refine] 解析失败（将重试），原始输出前 300 字:', String(txt || '').slice(0, 300).replace(/\n/g, ' '));
        send({ status: '正在重新整理调整结果…' });
        txt = await aiTextProgress(refinePrompt + '\n\n【重要】请严格只输出一个 JSON 对象（不要解释、不要代码块），格式：{"summary":"...","conditions":[{"key":"c1","title":"","detail":"","acceptance":"","jd":"","priority":"must"}],"stages":[{"title":"","detail":"","condition":"c1","sources":[],"goals":[{"title":"","detail":"","condition":"c1","sources":[]}]}]}', model, 480000, send, '阶段/小目标', sig);
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
      const condCount = await ensureConditionsFromPlan(goal, send);
      db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('review', '', nowISO(), goal.id);
      const report = await finishVersion(goal, vid, '按意见调整骨架');
      backup();
      send({ done: true, conditions: condCount, goal: getGoal(goal.id), report, versionId: vid });
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
/* 从教程正文里挑出「用户这次点名的那一节」。
   教程动辄五六万字，整篇塞进提示词不现实；用户点标题（如"1.2 ReAct"）时就带上那一节，
   没点名就只给目录 —— 不硬塞，免得白白烧掉几万 token。 */
/* 教程正文怎么塞进提示词。
   ⚠️ 这里给的是**两种模式（ASK / Agent）完全相同的量** —— 模式只决定"能不能改"，
   绝不决定"能看到什么"。上一版的错就在这儿：只给目录 + 用户点名的那一节，
   于是 AI 回答"我读不到正文"，用户还以为是 ASK 模式的限制。
   规则：正文不超预算 → 全给；超了 → 先给用户点名的节、再按顺序补满，
   并把**没带上的节列出来**，让模型能如实说"这几节我没看到，你点一下给我看"，
   而不是含糊地说"读不到"，更不是凭空猜。 */
const TUT_BUDGET = 30000;
function tutBodyBlock(content, message) {
  const body = String(content || '');
  if (!body.trim()) return '（这份教程还没有正文）';
  if (body.length <= TUT_BUDGET) return '【它的正文（完整）】\n' + body;
  const msg = String(message || '');
  const hrs = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)];
  const secs = hrs.map((h, i) => ({
    title: h[1].trim(),
    text: body.slice(h.index, i + 1 < hrs.length ? hrs[i + 1].index : body.length)
  }));
  if (!secs.length) return '【它的正文（节选）】\n' + body.slice(0, TUT_BUDGET) + '\n…（后面还有 ' + (body.length - TUT_BUDGET) + ' 字没带上）';
  const hit = x => { const k = x.title.replace(/^\d+(\.\d+)?[\.、\s]*/, '').slice(0, 12); return k.length >= 2 && msg.includes(k); };
  const order = [...secs.filter(hit), ...secs.filter(x => !hit(x))];
  const got = [], drop = [];
  let used = 0;
  for (const x of order) {
    if (used + x.text.length <= TUT_BUDGET) { got.push(x); used += x.text.length; }
    else drop.push(x.title);
  }
  got.sort((a, b) => body.indexOf(a.text) - body.indexOf(b.text));   // 按原文顺序放回去
  const out = ['【它的正文（节选，' + used + ' / ' + body.length + ' 字）】'];
  out.push(got.map(x => x.text).join('\n'));
  if (drop.length) out.push('\n【这次**没有**带上来的节】' + drop.join(' / ')
    + '\n（用户问的如果正是这几节，如实说"这几节我这边没看到"，请他在消息里点明节标题再看 —— 不要猜、也不要整篇否定。）');
  return out.join('\n');
}
function pickTutorialSection(content, message) {
  const c = String(content || ''), msg = String(message || '');
  const hrs = [...c.matchAll(/^#{2,3}\s+(.+)$/gm)];
  if (!hrs.length) return '';
  let best = null;
  for (let i = 0; i < hrs.length; i++) {
    const title = hrs[i][1].trim();
    const key = title.replace(/^\d+(\.\d+)?[\.、\s]*/, '').slice(0, 12);
    if (key && key.length >= 2 && msg.includes(key)) {
      if (!best || title.length > best.title.length) best = { i, title };
    }
  }
  if (!best) return '';
  const start = hrs[best.i].index;
  const end = hrs[best.i + 1] ? hrs[best.i + 1].index : c.length;
  return '《' + best.title + '》\n' + c.slice(start, end).slice(0, 4000);
}
/* 找从 start 处的 [ / { 开始、与之配对的那个括号的下标；找不到（被截断）返回 -1。 */
function bracketEnd(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return k; }
  }
  return -1;
}
/* 剥掉正文里形如 [{"op":…}] 的操作 JSON 段（按括号配对扫，串里的 ] } 不算数）。
   不是操作数组的 JSON（例如用户贴的资料）原样保留 —— 别把用户真正的话删了。 */
function stripOpsArrays(text) {
  let out = '', rest = String(text || '');
  for (let guard = 0; rest && guard < 50; guard++) {
    const i = rest.search(/\[\s*\{\s*"/);
    if (i < 0) { out += rest; break; }
    out += rest.slice(0, i);
    const end = bracketEnd(rest, i);
    if (end < 0) break;                                   // 没闭合 = 半截操作 JSON，整段丢
    const seg = rest.slice(i, end + 1);
    if (!/"op"\s*:|"type"\s*:/.test(seg)) out += seg;      // 别的 JSON 留着
    rest = rest.slice(end + 1);
  }
  return out;
}
/* 把 ``` 围栏补齐：奇数个说明有孤零零一个 ```（模型抄历史留下的），删掉多余的。 */
function dropLoneFence(s) {
  let n = (String(s).match(/```/g) || []).length;
  while (n % 2 === 1) {
    const i = s.lastIndexOf('```');
    if (i < 0) break;
    s = s.slice(0, i) + s.slice(i + 3);
    n--;
  }
  return s;
}
/* 【回喂历史前必须做的一步】剥掉历史消息里的"操作 JSON"，只留人类可读正文。
   ⚠️ 线上真实翻车（用户已反馈 4 次以上）：对话窗口从"固定 12 条"放宽成"按 26000 字取"
   之后，历史里那些巨大的 ops JSON（形如 {"op":"tutorial_edit","feedback":"…几千字…"}）
   被**原样喂回**给模型，模型于是开始模仿它们：回复末尾照抄一段半截 JSON 尾巴，
   甚至把上一轮的操作当自己的输出。
   实测 chats id=299（985 字）：整条回复里既没有 `[{` 也没有 `{"op"`，末尾却是
   `…不改技术结论与验收标准。"}]` —— 那段正是历史 id=284/286 里旧 tutorial_edit 的尾部。
   注意：只剥 ```ops 块与 {"op":…} JSON 段，用户真正写的修改意见正文一个字都不动。 */
function stripOpsFromText(content) {
  let s = String(content || '');
  s = s.replace(/```ops[ \t]*\r?\n[\s\S]*?(?:```|$)/gi, ' ');       // 1) ```ops 代码块（未闭合的半个也剥）
  s = stripOpsArrays(s);                                            // 2) 成对完整的 [{…"op"…}] 操作数组
  // 3) 散落的 {"op":…} 对象 —— 半截数组（模型把开头的 `[{` 也吞掉时）就靠这条。
  s = s.replace(/\{\s*"op"\s*:[\s\S]{0,4000}?\}\s*\]?/g, ' ');
  // 4) 剩下的 JSON 尾巴（例如 `…验收标准。"}]`、`…纯概念。"},]`）。
  //    两道约束避免误伤用户粘贴的 JSON：前面不能是字母数字（`"x"}` 这种值结尾就不碰）、
  //    后面必须是换行 / 结尾 / 代码围栏。
  s = s.replace(/(?<![A-Za-z0-9])"[ \t]*\}[ \t]*\]?[ \t]*[,，]?[ \t]*\]?(?=[ \t]*(?:\r?\n|$|`{3}))/g, ' ');
  s = s.replace(/[ \t]*,[ \t]*\[[ \t]*(?=\r?\n|$)/g, ' ');          // 5) 尾巴孤立的 `, [`
  s = dropLoneFence(s);                                             // 6) 孤立的 ``` 围栏
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
/* 单条消息按字数保头保尾截断 —— 防止一条几万字的回复吃光整个预算。 */
function clipHeadTail(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const cap = max || 1200;
  if (t.length <= cap) return t;
  const head = Math.round(cap * 0.6), tail = cap - head;
  return t.slice(0, head) + ' 〔中间省略 ' + (t.length - cap) + ' 字〕 ' + t.slice(-tail);
}
/* 按字数取"最近 N 轮"对话：从最新往回装，装不下就停。
   比"固定条数"适应性强得多 —— 短消息能带回几十轮，长回复也不会一条吃光预算。
   每条都先 stripOpsFromText（剥操作 JSON）+ clipHeadTail（单条上限 1200 字）。 */
function pickChatWindow(rows, budget) {
  const out = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i];
    const body = clipHeadTail(stripOpsFromText(c.content), 1200);
    if (!body) continue;   // 整条就是操作 JSON（剥完没正文了）→ 不带，免得诱发照抄
    const txt = (c.role === 'user' ? '用户：' : '你：') + body;
    if (out.length && used + txt.length > budget) break;
    out.unshift(txt);
    used += txt.length;
  }
  return { lines: out, dropped: rows.length - out.length, used };
}
/* 这个目标最近的 AI 任务（含正在跑的）。
   用户问"改了没有 / 跑完没 / 为什么失败"时，模型必须答得上来 ——
   上一版提示词里没有这块，AI 只能回"我查不了任务状态"。
   ⚠️ 同样两种模式都给：看到的信息一致，差别只在能不能动手。 */
function chatTasksBlock(goal) {
  let live = [];
  try { live = tasks.list(goal.id).filter(t => t.status === 'running' || t.status === 'queued'); } catch (e) {}
  let rows = [];
  try {
    rows = db.prepare("SELECT type,title,status,error,cost_ms,created_at FROM task_runs"
      + " WHERE goal_id = ? AND status IN ('done','failed','cancelled') ORDER BY id DESC LIMIT 8").all(goal.id);
  } catch (e) {}
  if (!live.length && !rows.length) return '';
  const out = ['', '【这个目标最近的 AI 任务（判断"到底改了没有"就看这里）】'];
  for (const t of live) out.push('- 🔄 进行中 ' + (t.progress || 0) + '%：' + String(t.title || t.type).slice(0, 50) + ' · ' + String(t.message || '').slice(0, 60));
  for (const r of rows) {
    out.push('- ' + String(r.created_at).replace('T', ' ').slice(0, 16) + ' [' + r.status + '] '
      + String(r.title || r.type).slice(0, 50) + (r.cost_ms ? ' · ' + Math.round(r.cost_ms / 1000) + ' 秒' : '')
      + (r.error ? ' · 原因：' + String(r.error).replace(/\s+/g, ' ').slice(0, 130) : ''));
  }
  out.push('⚠️ 注意口径：**失败 / 已停止 = 库里的内容可能一个字都没动**；"已提交任务"不等于"改成功了"。');
  return out.join('\n');
}
/* ===== 对话里的"节点附件" =====
   （2026-10-15）用户定调：每个节点的 AI 对话应该是独立的，而且右键节点 → AI 功能
   应该把节点**加进右侧 AI 助手**，而不是另开一个只看得到当前节点的小窗。
   于是有了这一组：对话带哪几个节点，跟对话一起落库；提示词里把范围钉死。 */
function sanitizeChatNodes(list, gid) {
  const out = [];
  const seen = new Set();
  for (const x of (Array.isArray(list) ? list : [])) {
    if (out.length >= 40) break;          // 一次最多带 40 个（前端 PICK_MAX 同值）：
                                          // 再多提示词会被清单撑爆，模型也会看花眼
    const id = Number(x && typeof x === 'object' ? x.id : x);
    if (!id || seen.has(id)) continue;
    const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND goal_id = ?').get(id, gid);
    if (!n) continue;                     // 只能带本目标里的节点，客户端编的 id 一律丢掉
    seen.add(id);
    out.push({ id, withKids: !!(x && typeof x === 'object' && x.withKids) });
  }
  return out;
}
const LEVEL_WORD = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' };
/* 整棵子树（只列 id 和标题，限量）—— withKids 的附件用它 */
function subtreeBrief(rootId, max) {
  const cap = max || 40;
  const out = [];
  const walk = id => {
    if (out.length >= cap) return;
    for (const k of db.prepare('SELECT id, title, parent_id FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(id)) {
      if (out.length >= cap) return;
      out.push('#' + k.id + ' ' + String(k.title || '').slice(0, 24));
      walk(k.id);
    }
  };
  walk(rootId);
  return out;
}
/* 提示词里的「用户在说哪几个节点」。和「用户当前打开的是教程」同构：
   范围钉死了，模型才不会把改动落到别的分支上（这是用户最烦的"改错地方"）。 */
function chatNodesBlock(list) {
  const rows = [];
  for (const a of (list || [])) {
    const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(a && a.id));
    if (n) rows.push({ n, withKids: !!(a && a.withKids) });
  }
  if (!rows.length) return null;
  const lines = [];
  lines.push('【用户正在这 ' + rows.length + ' 个节点上跟你说话】');
  for (const r of rows) {
    const n = r.n;
    let head = '· #' + n.id + ' 「' + String(n.title || '').slice(0, 60) + '」（' + (LEVEL_WORD[n.level] || '节点')
      + (n.hours ? ' · ' + n.hours : '') + (n.status === 'done' ? ' · 已完成' : n.status === 'doing' ? ' · 进行中' : '') + '）';
    if (n.detail) head += '：' + String(n.detail).replace(/\s+/g, ' ').slice(0, 160);
    lines.push(head);
    const kids = db.prepare('SELECT id, title FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(n.id);
    if (kids.length) lines.push('   它现有的子节点：' + kids.map(k => '#' + k.id + ' ' + String(k.title || '').slice(0, 26)).join(' ｜ '));
    if (r.withKids) {
      const all = subtreeBrief(n.id);
      if (all.length) lines.push('   用户要求连它下面的子节点一起纳入（' + all.length + ' 个，都会被一起改）：' + all.join(' ｜ '));
    }
  }
  lines.push('用户这句话默认是在说上面这些节点：要改就用它们的 id；要给某个节点加子任务，parent_id 填它；别去动别的分支。'
    + '若用户的要求听起来与它们明显无关，先在回复里问一句是不是说错了节点，不要擅自改别的。');
  return { text: lines.join('\n'), ids: rows.map(r => '#' + r.n.id).join(' '), count: rows.length, first: rows[0].n };
}

async function buildChatPrompt(goal, message, sessionId, opts) {
  const o = opts || {};
  /* 创造模式：不是"改路线图"，而是生成可安装的 UI 插件/皮肤/功能组件。
     走单独的提示词（扩展点说明书），产出 create JSON，由用户在卡片上确认安装。 */
  if (o.mode === 'create') return await buildCreateChatPrompt(goal, message, o);
  /* ASK 模式：只回答、不许改。这里是**服务端**的硬边界 —— 前端也会拦一道，
     但真正决定"能不能改"的是这里，因为 ops 是在这个函数里被允许或禁止的。 */
  const askOnly = o.mode === 'ask';
  const tutId = Number((o.tutorial && o.tutorial.id) || 0);
  const tutRow = tutId ? db.prepare('SELECT id,title,node_id,content,goal_id FROM tutorials WHERE id = ?').get(tutId) : null;
  const tut = (tutRow && Number(tutRow.goal_id) === Number(goal.id)) ? tutRow : null;
  const lines = [];
  /* 「它做了什么」的第一组：这一轮到底带了哪些上下文进去。
     ⚠️ 只记**真的带上了**的块（块为空就不记）—— 否则用户会看到一串"读了 XX"，
     其实什么都没读到，等于把这块做成装饰。 */
  const ctx = [];
  const addCtx = (label, detail) => { ctx.push({ kind: 'ctx', label, detail: detail || '' }); };
    lines.push('你是用户的「目标助理」：不只可以改路线图，还能操作这个目标下的所有可操作信息——管理信息源（添加/删除）、触发信息提炼与信息源收集、修改目标信息（现状/时间/期限/参考资料）、添加规划约束、新增/修改/删除「达成条件」并把节点归到条件下面。');
  lines.push('用户让你做这些事时，直接通过下面的 ops 执行，不要只说"你可以去某某页面点一下"。');
  lines.push('');
  lines.push(goalHeader(goal));
  lines.push(goalQaBlock(goal));
  lines.push(constraintsBlock(goal));
  addCtx('目标信息、现状与约束', String(goal.title || '').slice(0, 30));
  /* JD / 招聘原文：条件对齐 JD、简历改写、面试准备都要靠它。
     目标材料已由 goalHeader 带上；这里补**资料库里 kind 像 JD/招聘/岗位**的正文
     （以前只列标题，于是 AI 只能写"提升能力"这种空话，用户反馈"条件对不上 JD"）。 */
  try {
    const jdRows = db.prepare("SELECT title, kind, snippet, content FROM sources WHERE goal_id = ? AND (kind LIKE '%JD%' OR kind LIKE '%岗位%' OR kind LIKE '%招聘%' OR kind LIKE '%实习%' OR title LIKE '%JD%' OR title LIKE '%岗位%' OR title LIKE '%招聘%') ORDER BY id DESC LIMIT 6").all(goal.id);
    if (jdRows.length) {
      lines.push('');
      lines.push('【资料库里的 JD / 招聘原文（对齐条件、简历、面试时优先引用这里的条款）】');
      jdRows.forEach((r0, i) => {
        const txt = String(r0.content || r0.snippet || '').replace(/\s+/g, ' ').slice(0, 1500);
        lines.push('#' + (i + 1) + ' 「' + String(r0.title || '未命名').slice(0, 60) + '」' + (txt ? '：' + txt : ''));
      });
      addCtx('资料库里的 JD 原文', jdRows.length + ' 条');
    }
  } catch (e) {}
  const dgBlock = digestsBlock(goal);
  if (dgBlock) { lines.push(dgBlock); addCtx('资料提炼汇总', '多篇主题汇总'); }
  /* 轻档：省掉向量检索与代码检索，并把历史从 12 条压到 4 条。
     ⚠️ **资料清单无论如何都要留着** —— 它才是"资料库里有没有 XX"能答对的依据
     （AGENTS.md 坑 #16：漏了它模型只会说"看不到"，哪怕资料就在库里）。
     判断是纯启发式、不花 AI 调用；判断偏重了只是多一次检索，不会答错。 */
  const ce = effort.chatEffort(message);
  if (ce.heavy) {
    const augBlock = await ragAugment(goal, message, 8);
    if (augBlock) {
      lines.push(augBlock);
      addCtx('按你这句话检索了资料库', (augBlock.match(/^- /gm) || []).length + ' 段最相关片段');
    }
  }
  const srcBlock = chatSourcesBlock(goal);
  if (srcBlock) {
    lines.push(srcBlock);
    addCtx('资料库清单', '共 ' + sourcesOf(goal.id).length + ' 条');
  }
  if (ce.heavy) {
    const cstats = {};
    const codeBlock = codeContextBlock(goal, message, cstats);
    if (codeBlock) {
      lines.push(codeBlock);
      addCtx('代码库', cstats.repos + ' 个库 · 快照 ' + cstats.files + ' 个文件'
        + (cstats.picked ? '，挑了 ' + cstats.picked + ' 个最相关的读' : ''));
    }
  }
  /* 对话上下文：**按字数取窗口**，不再按"条数 + 轻重档"砍。
     ⚠️ 原先 `ce.heavy ? 12 : 4` —— 轻档只带 4 条，用户直接反馈"上下文像是被隔开的、
     只能看到刚发出去的那一条"。而**对话记忆跟"要不要做向量检索"不是一回事**：
     它统共几千字，砍掉省不了多少，代价却是 AI 失忆。
     现在从最近往回装，装到 26000 字预算为止（实测同一份 40 条会话：4 条 → 40 条）。 */
  const chats = sessionId
    ? db.prepare('SELECT role, content FROM chats WHERE session_id = ? ORDER BY id DESC LIMIT 300').all(sessionId).reverse()
    : db.prepare('SELECT role, content FROM chats WHERE goal_id = ? ORDER BY id DESC LIMIT 300').all(goal.id).reverse();
  if (chats.length) {
    const w = pickChatWindow(chats, 26000);
    lines.push('');
    lines.push('【最近的对话】' + (w.dropped ? '（更早的 ' + w.dropped + ' 条太长，这次没带上；需要时请用户复述）' : ''));
    lines.push('（下面是历史对话的**正文**，其中的操作当时已经执行过了 —— 不要照抄，也不要模仿它们的格式。）');
    lines.push(w.lines.join('\n'));
    /* 这条查询把"刚发出去的那条"也算进来了 —— 报给用户时要减掉，
       否则每轮都显示"历史 1 条"，看着像凭空多出一条。 */
    const hist = chats.length - 1;
    if (hist > 0) addCtx('这段对话的历史', hist + ' 条' + (w.dropped ? '（更早的 ' + w.dropped + ' 条太长没带上）' : ''));
  }
  lines.push('');
  lines.push('【当前路线图（方括号内是节点 id，修改时只能引用这些 id）】');
  lines.push(roadmapOutline(goal.id) || '（暂无节点）');
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE goal_id = ?').get(goal.id).n;
    addCtx('当前路线图', n ? n + ' 个节点' : '（还没有节点）');
  } catch (e) {}
  /* 达成条件：让助手能按 id 修改 / 重新归属（用户抱怨过"生成一版就定死了、改不了"）。
     条件 id 从【当前达成条件】里认；归属改的是节点 id（上面【当前路线图】里有）。 */
  try {
    const condData = conditionsDomain.list(goal.id);
    const conds = condData.conditions || [];
    if (conds.length) {
      lines.push('');
      lines.push('【当前达成条件（方括号内是条件 id；改条件 / 调归属只能引用这些 id；要**整批换成 JD 条款**用 condition_replace）】');
      for (const c of conds) {
        const st = c.stats || {};
        lines.push('[' + c.id + '] ' + String(c.title || '').slice(0, 80) +
          '（' + (c.priority || 'must') + '，完成 ' + (Number(st.done) || 0) + '/' + (Number(st.total) || 0) + '）' +
          (c.acceptance ? ' —— 达成标准：' + String(c.acceptance).replace(/\s+/g, ' ').slice(0, 160) : '') +
          (c.jd_ref ? '；对应 JD：' + String(c.jd_ref).replace(/\s+/g, ' ').slice(0, 200) : '') +
          (c.detail ? '；说明：' + String(c.detail).replace(/\s+/g, ' ').slice(0, 120) : ''));
      }
      const un = (condData.unassigned || []).slice(0, 60);
      if (un.length) lines.push('【还没有归属条件的节点】' + un.map(x => '[' + x.id + ']' + String(x.title || '').slice(0, 40)).join(' ｜ '));
      addCtx('这个目标的达成条件', conds.length + ' 条' + (un.length ? '，' + un.length + ' 个节点未归属' : ''));
    }
  } catch (e) {}
  /* 该目标的教程清单：让模型能**点名**要改哪一份（tutorial_edit 可带 tutorial_id） */
  try {
    const tlist = db.prepare('SELECT id,title FROM tutorials WHERE goal_id = ? ORDER BY updated_at DESC, id DESC LIMIT 8').all(goal.id);
    if (tlist.length) {
      lines.push('');
      lines.push('【这个目标的教程（要改哪份就说它的编号）】' + tlist.map(t => '#' + t.id + ' ' + String(t.title || '').slice(0, 40)).join(' ｜ '));
      addCtx('这个目标的教程清单', tlist.length + ' 份');
    }
  } catch (e) {}
  if (tut) {
    const body = String(tut.content || '');
    const heads = (body.match(/^#{2,3}\s+(.+)$/gm) || []).map(x => x.replace(/^#+\s+/, '').trim());
    lines.push('');
    lines.push('【用户正在看的教程】#' + tut.id + ' 「' + String(tut.title || '') + '」（正文 ' + body.length + ' 字）');
    if (heads.length) lines.push('它的目录：' + heads.join(' / '));
    lines.push(tutBodyBlock(body, message));
    addCtx('你正在看的那份教程', '「' + String(tut.title || '').slice(0, 24) + '」' + body.length + ' 字');
  }
  const taskBlock = chatTasksBlock(goal);
  if (taskBlock) { lines.push(''); lines.push(taskBlock); addCtx('这个目标的 AI 任务记录', '用来判断"到底改了没有"'); }
  /* 用户带上来的节点（右键节点 → AI 功能 / 助手里的 ＋添加节点）：
     把"这句话是在说哪些节点"钉死。以前只钉一个，而且历史还是整个目标的，
     于是打开 SKILL 节点看到的是 MCP 那轮对话（用户实测）。 */
  const focusList = Array.isArray(o.nodes) ? o.nodes : (o.node && o.node.id ? [{ id: o.node.id, withKids: false }] : []);
  const nb = chatNodesBlock(focusList);
  if (nb) {
    lines.push('');
    lines.push(nb.text);
    addCtx(nb.count > 1 ? '你在说的这几个节点' : '你在说的那个节点', nb.ids);
  }
  /* 用户当前正在看的页面（前端抓的文字）。
     ⚠️ 教程页不重复带：上面【用户正在看的教程】已经把正文（按预算）放进来了，
        再贴一遍屏幕上的同一段文字只会挤掉历史对话。其它页面（随堂测验 / 刷题 /
        面试 / 看懂代码 / 组件页…）都靠这块让 AI 知道"这个 / 这里"指什么。 */
  const pageRaw = pageContext.sanitizePageContext(o.page);
  if (pageRaw) {
    const sameTut = !!(tut && /^#\/t\//.test(pageRaw.route || ''));
    const block = sameTut
      ? null
      : pageContext.pageContextBlockFrom(pageRaw);
    if (block) {
      lines.push('');
      lines.push(block.text);
      addCtx('你当前页面上的内容', '「' + block.label + '」' + block.chars + ' 字' + (block.cut ? '（掐掉 ' + block.cut + ' 字）' : ''));
    } else if (sameTut) {
      addCtx('你正看着的那个页面', '「' + pageRaw.label + '」（正文已在上面的教程块里）');
    }
  }
  /* 用户用「🎯 只改」钉死的范围：放在【你的任务】之前、通用 agent_rules 之前，
     让模型先看到硬约束（否则它会照着后面那串通用 ops 清单乱改）。 */
  if (!askOnly && o.scope && o.scope !== 'auto') {
    const scopeBlock = chatScopePromptBlock(o.scope);
    if (scopeBlock) {
      lines.push('');
      lines.push(scopeBlock);
      addCtx('本轮改动范围（你指定的）', '只改「' + CHAT_SCOPE_LABEL[chatScopeOf(o.scope)] + '」');
    }
  }
  lines.push('【用户的新消息】' + message);
  lines.push('');
  lines.push('【你的任务】');
  if (askOnly) {
    lines.push(await promptPacks.renderAsync('chat.ask_rules', {}));
    return { prompt: lines.join('\n'), ctx };
  }
  lines.push(await promptPacks.renderAsync('chat.agent_rules', { tutorialEditOp: tut ? chatPacks.TUTORIAL_EDIT_OP : '' }));
  return { prompt: lines.join('\n'), ctx };
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
/* 「本轮只改哪儿」—— 对话栏上方的「🎯 只改」键把用户意图钉死。
   注意：提示词只是**引导**，真正的边界必须在应用层硬拦（模型会忘、会自作主张）。
   auto = 不限制；其余每个范围只放行对应的一组 op，越界的 op 直接拒绝并回报错。 */
const CHAT_SCOPE_OPS = {
  conditions: ['condition_add', 'add_condition', 'condition_update', 'update_condition', 'condition_delete', 'delete_condition',
    'condition_assign', 'assign_condition', 'condition_unassign', 'unassign_condition', 'condition_replace', 'replace_conditions'],
  nodes: ['add', 'update', 'delete', 'move', 'status'],
  goal: ['update_goal', 'goal', 'constraint'],
  sources: ['add_source', 'delete_source', 'source', 'digest', 'digest_sources', 'extract', 'collect', 'collect_sources'],
  tutorials: ['tutorial_edit']
};
const CHAT_SCOPE_LABEL = { auto: '自动', conditions: '达成条件', nodes: '路线图节点', goal: '目标信息', sources: '资料库', tutorials: '教程' };
function chatScopeOf(v) {
  const k = String(v || '').toLowerCase();
  return CHAT_SCOPE_LABEL[k] && k !== 'auto' ? k : 'auto';
}
function chatScopeAllows(scope, kind) {
  const s = chatScopeOf(scope);
  if (s === 'auto') return true;
  const list = CHAT_SCOPE_OPS[s] || [];
  return list.indexOf(String(kind || '').toLowerCase()) >= 0;
}
/* 给提示词的硬约束块：**先于**通用 agent_rules 出现（写"这条比下面的通用规则优先"，
   否则模型看到后面一长串 ops 清单就会按清单来）。 */
function chatScopePromptBlock(scope) {
  const s = chatScopeOf(scope);
  if (s === 'auto') return '';
  const label = CHAT_SCOPE_LABEL[s];
  const allow = CHAT_SCOPE_OPS[s] || [];
  const out = [];
  out.push('【本轮改动范围 · 用户已在界面上锁定：只改「' + label + '」】');
  out.push('- 这是用户用「🎯 只改」键明确指定的范围，**优先于下面所有通用规则**。');
  out.push('- 这次只允许输出这些 op：' + allow.join(' / ') + '。');
  out.push('- **禁止**输出任何范围外的 op（包括但不限于 add / update / delete / move / status / update_goal / constraint / add_source / delete_source / digest / collect / tutorial_edit / 其它 condition_*）：服务端会逐条拒绝，不会生效，用户只会看到"没改成"。');
  out.push('- 如果用户的要求必须改到范围之外（例如范围是「达成条件」却说"把路线图那个节点改成…"）：**不要动手，也不要用别的 op 绕**；直接回一句「这属于「路线图节点」，请把上方的『只改』切到那一项再发一次」即可。');
  out.push('- 只回答、不需要改任何东西时，正常回答即可（不必硬凑 op）。');
  return out.join('\n');
}
/* 按范围过滤 ops（应用层边界）；返回保留的 ops 与被挡下的 op 类型。 */
function chatScopeFilterOps(ops, scope) {
  const list = Array.isArray(ops) ? ops : [];
  const s = chatScopeOf(scope);
  if (s === 'auto') return { ops: list, blocked: [] };
  const keep = [], blocked = [];
  for (const op of list) {
    const kind = String((op && (op.op || op.type)) || '').toLowerCase();
    if (chatScopeAllows(s, kind)) keep.push(op);
    else blocked.push(kind || '未知');
  }
  return { ops: keep, blocked };
}

/* 对话 ops 里怎么认一条条件：优先 id，其次标题（精确 → 包含），用户口头说"第 2 条"也能靠标题对上 */
function chatConditionOf(goalId, op) {
  try {
    const list = ((conditionsDomain.list(goalId) || {}).conditions) || [];
    const o = op || {};
    const id = Number(o.id != null ? o.id : o.condition_id);
    if (id) return list.find(c => Number(c.id) === id) || null;
    const raw = String(o.title || o.condition || o.title_match || o.match || '').trim();
    if (!raw) return null;
    return list.find(c => String(c.title) === raw) ||
      list.find(c => String(c.title).indexOf(raw) >= 0) ||
      (function () {
        const m = raw.match(/^第?\s*(\d+)\s*条?$/);
        if (!m) return null;
        return list[Number(m[1]) - 1] || null;
      })();
  } catch (e) { return null; }
}
function applyChatOps(goalId, ops, opts) {
  const chatOpts = opts || {};
  const applied = [], errors = [];
  const nodeOf = id => db.prepare('SELECT * FROM nodes WHERE id = ? AND goal_id = ?').get(Number(id), goalId);
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, 25)) {
    try {
      const kind = String(op.op || op.type || '').toLowerCase();
      /* 第二道闸：即使调用方没先过滤（补操作 / 旧路径），这里也不让越界 op 落库。 */
      if (!chatScopeAllows(chatOpts.scope, kind)) {
        errors.push('本轮范围是「' + CHAT_SCOPE_LABEL[chatScopeOf(chatOpts.scope)] + '」，已跳过「' + kind + '」');
        continue;
      }
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
          rag.autoIndex(goalId);
      } else if (kind === 'delete_source') {
          const key = String(op.title || op.title_match || op.id || '').trim();
          if (!key) { errors.push('请给出要删除的资料标题'); continue; }
          const row = db.prepare("SELECT id,title FROM sources WHERE goal_id = ? AND title LIKE ? LIMIT 1").get(goalId, '%' + key.slice(0, 40) + '%');
          if (!row) { errors.push('没找到资料：' + key.slice(0, 30)); continue; }
          db.prepare('DELETE FROM sources WHERE id = ?').run(row.id);
          db.prepare('DELETE FROM code_repo_files WHERE source_id = ?').run(row.id);
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
          recordGoalFieldEvents(goalId, cur, { title: title, profile: profile, weekly_hours: weekly, deadline: deadline, materials: materials }, 'chat');
          applied.push({ op: 'update_goal', title: '已更新目标信息' });
      } else if (kind === 'condition_add' || kind === 'add_condition') {
          const title = String(op.title || op.condition || '').trim().slice(0, 120);
          if (!title) { errors.push('条件标题为空'); continue; }
          const out = conditionsDomain.saveManual(goalId, { title: title, detail: op.detail || '', acceptance: op.acceptance || '', jd_ref: op.jd_ref || op.jd || '', priority: op.priority || 'must' });
          applied.push({ op: 'condition_add', id: out.id, title: title.slice(0, 60) });
      } else if (kind === 'condition_replace' || kind === 'replace_conditions') {
          /* 整批替换达成条件：用户说"把现有条件换成 JD 要求"时用一条 op 完成，
             而不是让模型逐条 delete/add（中间失败会留下半套条件）。
             只替换 source='plan' 的条件；手动条件保留；旧条件的节点回未归属。 */
          const defs = Array.isArray(op.conditions) ? op.conditions : (Array.isArray(op.list) ? op.list : []);
          if (!defs.length) { errors.push('condition_replace 没有给出条件列表'); continue; }
          const saved2 = conditionsDomain.saveFromPlan(goalId, { conditions: defs });
          let assigned2 = 0;
          for (let ci = 0; ci < defs.length; ci++) {
            const d = defs[ci] || {};
            const cid = saved2.resolve(d.key != null ? d.key : (d.id != null ? d.id : ci + 1));
            if (!cid) continue;
            const rawIds = Array.isArray(d.nodes) ? d.nodes : (Array.isArray(d.node_ids) ? d.node_ids : []);
            const ids = rawIds.map(Number).filter(x => x > 0);
            if (!ids.length) continue;
            try {
              const out2 = conditionsDomain.assign(goalId, { condition_id: cid, node_ids: ids, cascade: true });
              assigned2 += Number(out2.changed) || 0;
            } catch (e2) { errors.push('条件「' + String(d.title || '').slice(0, 20) + '」归属失败：' + e2.message); }
          }
          applied.push({ op: 'condition_replace', conditions: saved2.defs.length, assigned: assigned2 });
      } else if (kind === 'condition_update' || kind === 'update_condition') {
          const c = chatConditionOf(goalId, op);
          if (!c) { errors.push('条件不存在：' + (op.id || op.title || op.condition || '')); continue; }
          const f2 = op.fields || op;
          const pick = (k, max) => (f2[k] != null ? String(f2[k]).trim().slice(0, max) : null);
          const title = pick('title', 120) || c.title;
          const jdPick = pick('jd_ref', 600) != null ? pick('jd_ref', 600) : (pick('jd', 600) != null ? pick('jd', 600) : (c.jd_ref || ''));
          db.prepare('UPDATE goal_conditions SET title = ?, detail = ?, acceptance = ?, jd_ref = ?, priority = ?, updated_at = ? WHERE id = ?')
            .run(title, pick('detail', 800) != null ? pick('detail', 800) : c.detail,
              pick('acceptance', 600) != null ? pick('acceptance', 600) : c.acceptance,
              jdPick,
              ['must', 'should', 'nice'].includes(String(f2.priority || '')) ? String(f2.priority) : c.priority,
              nowISO(), Number(c.id));
          applied.push({ op: 'condition_update', id: Number(c.id), title: String(title).slice(0, 60) });
      } else if (kind === 'condition_delete' || kind === 'delete_condition') {
          const c = chatConditionOf(goalId, op);
          if (!c) { errors.push('条件不存在：' + (op.id || op.title || op.condition || '')); continue; }
          conditionsDomain.remove(c.id);
          applied.push({ op: 'condition_delete', id: Number(c.id), title: String(c.title).slice(0, 60) });
      } else if (kind === 'condition_assign' || kind === 'assign_condition') {
          const c = chatConditionOf(goalId, op);
          if (!c) { errors.push('条件不存在：' + (op.id || op.condition_id || op.title || '')); continue; }
          const rawIds = Array.isArray(op.node_ids) ? op.node_ids
            : (Array.isArray(op.nodes) ? op.nodes : (op.node_id != null ? [op.node_id] : []));
          const ids = rawIds.map(Number).filter(x => x > 0);
          if (!ids.length) { errors.push('没有指定要归到这条条件的节点 id'); continue; }
          const out = conditionsDomain.assign(goalId, { condition_id: Number(c.id), node_ids: ids, cascade: op.cascade !== false });
          applied.push({ op: 'condition_assign', id: Number(c.id), title: String(c.title).slice(0, 40), nodes: out.changed });
      } else if (kind === 'condition_unassign' || kind === 'unassign_condition') {
          const rawIds = Array.isArray(op.node_ids) ? op.node_ids : (op.node_id != null ? [op.node_id] : []);
          const ids = rawIds.map(Number).filter(x => x > 0);
          if (!ids.length) { errors.push('没有指定要取消归属的节点 id'); continue; }
          const out = conditionsDomain.assign(goalId, { condition_id: 0, node_ids: ids, cascade: op.cascade !== false });
          applied.push({ op: 'condition_unassign', nodes: out.changed });
      } else if (kind === 'digest' || kind === 'digest_sources' || kind === 'extract') {
          applied.push({ op: 'start', action: 'digest', title: '开始信息提炼（通读全部资料 → 多篇主题汇总）' });
      } else if (kind === 'collect' || kind === 'collect_sources') {
          applied.push({ op: 'start', action: 'collect', title: '开始收集信息源' });
      } else if (kind === 'tutorial_edit') {
          /* 教程 id 只认**请求里带的那个**（用户当前正在看的那份），不信模型自己报的 id ——
             模型编一个 id 出来就会改错教程。 */
          /* 要改哪一份教程，按这个优先级找：
             ① 消息里点名的（op.tutorial_id，提示词里已把该目标的教程列出来给它挑）
             ② 用户当前正打开的那份（前端带的 tutorial_id）
             ③ 这个目标**最近改过**的那份 —— 用户说"当前教程"时通常就是它。
             ⚠️ 原来只认 ②，于是从目标页说"修改当前教程"时 tid=0 → 直接跳过，
             用户看到的是"Agent 说已交办、却什么都没发生"（连说了三次都这样）。 */
          const cand = [Number(op.tutorial_id || 0), Number((chatOpts.tutorial && chatOpts.tutorial.id) || 0)];
          let tr = null;
          for (const t of cand) { if (t) { const r = db.prepare('SELECT id,title,goal_id FROM tutorials WHERE id = ?').get(t); if (r && Number(r.goal_id) === Number(goalId)) { tr = r; break; } } }
          if (!tr) tr = db.prepare('SELECT id,title,goal_id FROM tutorials WHERE goal_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(goalId) || null;
          const fb = String(op.feedback || op.text || '').trim().slice(0, 1500);
          if (!tr) { errors.push('这个目标下还没有教程，改不了'); continue; }
          if (!fb) { errors.push('没说清要改什么'); continue; }
          applied.push({ op: 'start', action: 'tutorial_edit', tutorial_id: tr.id, feedback: fb, title: '修改教程：' + String(tr.title).slice(0, 30) });
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
  const valid = o => o && typeof o === 'object' && ['add', 'update', 'delete', 'move', 'status', 'constraint', 'add_source', 'delete_source', 'update_goal', 'goal', 'source', 'digest', 'digest_sources', 'extract', 'collect', 'collect_sources', 'tutorial_edit',
    'condition_add', 'add_condition', 'condition_update', 'update_condition', 'condition_delete', 'delete_condition',
    'condition_assign', 'assign_condition', 'condition_unassign', 'unassign_condition', 'condition_replace', 'replace_conditions'].includes(String(o.op || o.type || '').toLowerCase());
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
    const bare = [];
    for (const o of extractJSONObjects(s)) {
      if (!o || typeof o !== 'object') continue;
      if (typeof o.reply === 'string' && o.reply.trim()) s = o.reply.trim();
      if (Array.isArray(o.ops)) { ops = takeOps(o.ops); break; }
      /* ⚠️ 模型**没写 ```ops 围栏、也没写 "ops":**，直接把操作对象摊在正文里
         （实测收到过 `…},{"op":"constraint","text":"…"}]`）。以前这里遇到第一个
         对象就 break，于是整条操作列表全丢 —— 用户看到"AI 说已交办、队列里却没有"。
         现在把散落的合法 op 对象也收进来。 */
      if (valid(o)) bare.push(o);
    }
    if (!ops.length && bare.length) ops = takeOps(bare);
  }
  // 3) JSON 被截断时抢救操作列表
  if (!ops.length) {
    const r = repairOpsArray(s);
    if (r) ops = takeOps(r);
  }
  // 4) 清理正文里残留的内部指令片段
  s = s.replace(/```ops[\s\S]*$/i, '').trim();
  /* 从裸 JSON 里恢复出来的操作，还得把那段 JSON 从正文剪掉 ——
     否则用户会看到 {"op":"tutorial_edit",…} 这种内部指令。 */
  if (ops.length) {
    const bi = s.lastIndexOf('[{');
    if (bi > 0 && /^\s*\{\s*"op"/.test(s.slice(bi + 1))) s = s.slice(0, bi).trim();
  }
  const envIdx = s.search(/\{\s*"reply"\s*:|"\s*ops\s*"\s*:\s*\[/);
  if (envIdx >= 0) {
    const rep = extractReplyField(s);
    if (rep) s = rep;
    else if (envIdx > 0) s = s.slice(0, envIdx).trim();
  }
  if (!s) s = ops.length ? '已按你的要求更新路线图。' : '（AI 没有输出内容，请重试）';
  return { reply: s, ops };
}
/* 承诺性表述识别：AI 说"已交办 / 已提交任务"，或"我这就改 / 我将重写这一节教程"。
   只在 ops 为空时用它触发兜底，所以宁可窄一点，别为普通回答白跑一次 AI 调用。 */
function looksLikePromise(reply) {
  const s = String(reply || '');
  if (/已(?:经)?[^\n]{0,24}(?:交给|提交|交办|发起|安排)[^\n]{0,24}任务/.test(s)) return true;
  if (/(?:已|我)[^\n]{0,20}(?:交给|提交给|交办给)[^\n]{0,14}(?:教程|后台|任务)/.test(s)) return true;
  if (/(?:我|将|会)[^\n]{0,12}(?:这就|马上|立刻|现在|去)?[^\n]{0,8}(?:修改|重写|改这|更新这|调整这)[^\n]{0,14}(?:教程|这一节|本节|这一篇|这一块)/.test(s)) return true;
  return false;
}
/* 「模型嘴上答应、却没写 ops」的兜底补一刀。
   病根：正文与 ops 挤在一次回复里 —— 模型输出长正文时**根本没写 ops**（不是被截断，
   所以"截断抢救"那条路救不了，见 parseChatOutput 第 3 步）。
   实测 chats id=299：985 字的回复里既没有 `[{` 也没有 `{"op"`，末尾却抄了历史里旧
   tutorial_edit 的 JSON 尾巴，用户以为交办了、队列里却什么都没有。
   对策：再用**极小的一次性请求**让它把刚才答应的事表达成 JSON 操作数组（走 AI 埋点，
   scene='助手对话-补操作'）；最多试 2 次，拿不到就返回空数组，沿用"并没有真的交办"提示。 */
/* 补操作时给模型的 op 清单：带上范围标签，按「🎯 只改」过滤后才发给它 ——
   否则模型会照着全量清单挑一个范围外的 op 交差。 */
const OPS_SPEC_LINES = [
  { scope: 'nodes', text: '{"op":"add","parent_id":<父节点id>,"title":"","detail":"","artifact":"","acceptance":"","hours":""}' },
  { scope: 'nodes', text: '{"op":"update","id":<id>,"title":"","detail":"","artifact":"","acceptance":"","hours":""}' },
  { scope: 'nodes', text: '{"op":"delete","id":<id>}   {"op":"move","id":<id>,"parent_id":<新父节点id>}' },
  { scope: 'nodes', text: '{"op":"status","id":<id>,"status":"todo|doing|done"}' },
  { scope: 'goal', text: '{"op":"constraint","text":""}' },
  { scope: 'sources', text: '{"op":"add_source","title":"","kind":"JD|面经|大纲|笔记|资料","content":"","url":"","site":""}' },
  { scope: 'sources', text: '{"op":"delete_source","title":"关键词"}' },
  { scope: 'goal', text: '{"op":"update_goal","fields":{"title":"","profile":"","weekly_hours":"","deadline":"","materials":""}}' },
  { scope: 'conditions', text: '{"op":"condition_add","title":"","detail":"","acceptance":"","jd":"","priority":"must|should|nice"}' },
  { scope: 'conditions', text: '{"op":"condition_update","id":<条件id>,"title":"","detail":"","acceptance":"","jd":"","priority":""}' },
  { scope: 'conditions', text: '{"op":"condition_delete","id":<条件id>}' },
  { scope: 'conditions', text: '{"op":"condition_assign","condition_id":<条件id>,"node_ids":[<节点id>],"cascade":true}' },
  { scope: 'conditions', text: '{"op":"condition_replace","conditions":[{"key":"c1","title":"","detail":"","acceptance":"","jd":"","priority":"must","nodes":[<节点id>]}]}' },
  { scope: 'sources', text: '{"op":"digest"}   {"op":"collect"}' },
  { scope: 'tutorials', text: '{"op":"tutorial_edit","tutorial_id":<编号>,"feedback":"修改意见（改哪里、改成什么样；要动结构就写清范围，别随手加「允许重写结构」）"}' }
];
async function recoverChatOps(goal, message, reply, o, model, sig) {
  const lines = [
    '【任务】你刚才回复了用户，但那次的回复里**没有输出可执行的操作（ops）**。',
    '现在请把"你刚才答应要做的那件事"表达成一个 JSON 操作数组。',
    '',
    '【只输出 JSON 数组本身】不要解释、不要 Markdown 代码围栏、不要 JSON 信封。',
    '',
    goalHeader(goal)
  ];
  lines.push('【当前路线图（方括号内是节点 id，只能引用这些 id）】');
  lines.push(roadmapOutline(goal.id) || '（暂无节点）');
  try {
    const tl = db.prepare('SELECT id,title FROM tutorials WHERE goal_id = ? ORDER BY updated_at DESC, id DESC LIMIT 8').all(goal.id);
    if (tl.length) lines.push('【这个目标的教程】' + tl.map(t => '#' + t.id + ' ' + String(t.title || '').slice(0, 40)).join(' ｜ '));
  } catch (e) {}
  try {
    const cs = (conditionsDomain.list(goal.id) || {}).conditions || [];
    if (cs.length) lines.push('【当前达成条件（方括号内是条件 id，只能引用这些 id）】' +
      cs.map(c => '[' + c.id + ']' + String(c.title || '').slice(0, 40)).join(' ｜ '));
  } catch (e) {}
  const tutId = Number((o && o.tutorial && o.tutorial.id) || 0);
  if (tutId) lines.push('【用户当前打开的是教程】#' + tutId);
  const fnode = (o && Array.isArray(o.nodes) && o.nodes.length) ? o.nodes[0] : null;
  if (fnode) {
    const fn = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(Number(fnode.id));
    if (fn) lines.push('【用户是在这些节点上跟你说话的】' + (o.nodes || []).map(x => '#' + Number(x.id)).join(' ')
      + '（第一个是「' + String(fn.title || '').slice(0, 40) + '」）—— 你要做的改动默认落在它们身上，别改错分支');
  }
  const scope = chatScopeOf(o && o.scope);
  if (scope !== 'auto') {
    lines.push('');
    lines.push('【本轮范围 · 只改「' + CHAT_SCOPE_LABEL[scope] + '」】只允许输出下面列出的这些 op，其它一律不要写。');
  }
  lines.push('');
  lines.push('【可用的操作】');
  for (const l of OPS_SPEC_LINES) {
    if (scope !== 'auto' && l.scope !== scope) continue;
    lines.push('   ' + l.text);
  }
  lines.push('');
  lines.push('【用户的消息】' + String(message || '').slice(0, 800));
  lines.push('【你刚才的回复（节选）】' + String(reply || '').slice(-1500));
  lines.push('');
  lines.push('【铁律】确实没有要执行的操作就输出 []；不要编造 id；除 JSON 数组外不要输出任何内容。');
  const prompt = lines.join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = '';
    try {
      raw = await ai.text({ prompt, model: model || currentModel(), timeoutMs: 90000, signal: sig, scene: '助手对话-补操作' });
    } catch (e) {
      if (e && e.cancelled) throw e;   // 用户点了「停止」→ 别硬续
      continue;
    }
    const ops = parseChatOutput(raw).ops;
    if (ops.length) return ops;
  }
  return [];
}
/* 创造模式提示词：把「能改什么、怎么改、红线、输出协议」一次性交给模型。
   页面上下文复用 AI 助手那套（用户正在看的页面就是他最可能想改的那一页）。 */
async function buildCreateChatPrompt(goal, message, o) {
  const rawPage = pageContext.sanitizePageContext(o.page || null);
  const pageText = rawPage && pageContext.pageContextBlockFrom ? pageContext.pageContextBlockFrom(rawPage) : '';
  const prompt = createMode.promptBlock({ pageText: pageText })
    + '\n\n【用户这句话】\n' + String(message || '').trim();
  const ctx = [{ kind: 'ctx', label: '创造模式扩展点说明书', detail: '可覆盖页面 / 插件契约 / CSS 变量 / 安全红线 / 输出协议' }];
  if (pageText) ctx.push({ kind: 'ctx', label: '你当前页面上的内容', detail: '' });
  return { prompt: prompt, ctx: ctx };
}
/* ===== 对话图片（粘贴 / 拖入）：原图只随这次请求发给支持多模态的模型，
   数据库只留缩略图（刷新后还能看到自己发过什么；缩略图很小，不拖垮多端同步）。 */
const CHAT_IMG_MAX = 4;
const CHAT_IMG_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_THUMB_MAX_BYTES = 600 * 1024;
const CHAT_IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
function sanitizeChatImages(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    const s = String(x || '');
    if (!CHAT_IMG_RE.test(s) || s.length > CHAT_IMG_MAX_BYTES) continue;
    out.push(s);
    if (out.length >= CHAT_IMG_MAX) break;
  }
  return out;
}
function sanitizeChatThumbs(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    const s = String(x || '');
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/.test(s) || s.length > CHAT_THUMB_MAX_BYTES) continue;
    out.push(s);
    if (out.length >= CHAT_IMG_MAX) break;
  }
  return out;
}
/* 当前对话模型能不能识图：
   用户 2026-10-19 定调：**默认当作能识图**，先发过去试；模型要是回应不能识图，
   就把这个模型记进「不支持识图」名单（后面发图直接提示，不再白花一次请求）。
   名单存 settings.vision_unsupported_models；重新保存 AI 连接会清空（用户换了配置后重试）。 */
const VISION_UNSUP_KEY = 'vision_unsupported_models';
function visionUnsupportedList() {
  try { const a = JSON.parse(getSetting(VISION_UNSUP_KEY, '[]') || '[]'); return Array.isArray(a) ? a.map(x => String(x || '').toLowerCase()).filter(Boolean) : []; } catch (e) { return []; }
}
function isVisionUnsupported(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  return !!id && visionUnsupportedList().includes(id);
}
function markVisionUnsupported(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return false;
  const list = visionUnsupportedList();
  if (list.includes(id)) return false;
  list.push(id);
  try { setSetting(VISION_UNSUP_KEY, JSON.stringify(list.slice(-60))); } catch (e) {}
  try { console.log('[vision] 已标记模型不支持识图:', id); } catch (e) {}
  return true;
}
function clearVisionUnsupported() {
  try { setSetting(VISION_UNSUP_KEY, '[]'); } catch (e) {}
}
function modelSupportsVision(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return false;
  /* ① 已经被模型自己/上游明确拒绝过的：不再发图 */
  if (isVisionUnsupported(id)) return false;
  /* ② 明确的多模态证据 */
  try { for (const m of (ai.modelPoolVision() || [])) if (String(m.id || '').toLowerCase() === id) return true; } catch (e) {}
  try { const st = ai.standaloneVision(); if (st && (st.models || []).some(x => String(x).toLowerCase() === id)) return true; } catch (e) {}
  try { const ref = String(getSetting('vision_model', '') || '').trim().toLowerCase(); if (ref && ref === id) return true; } catch (e) {}
  try {
    const conns = ai.connections() || [];
    for (const c of conns) {
      const has = (c.models || []).some(x => String(x).toLowerCase() === id) || String(c.defaultModel || '').toLowerCase() === id;
      if (!has) continue;
      if (c.visionModel && String(c.visionModel).toLowerCase() === id) return true;
      const pr = (ai.PROVIDERS || []).find(x => x.id === c.providerId);
      if (pr && pr.vision && String(pr.vision).toLowerCase() === id) return true;
    }
  } catch (e) {}
  if (/(^|\/)(gpt-4o|gpt-4\.1|gpt-5|o4|claude|gemini|glm-4\.\dv|glm-4v|qwen.*vl|kimi-k3|llava|gemma3|.*-vl|.*vision|mimo.*vl|doubao.*vision|ernie.*vl|step.*vl)/i.test(id)) return true;
  /* ③ 判断不了就默认「能识图」：先发过去，失败了由上游报错自动标记 */
  return true;
}
function visionRejectText(model, learned) {
  const id = String(model || '未设置');
  const marked = learned || isVisionUnsupported(model);
  return '⚠️ 当前模型不支持识别图片（模型：' + id + '）' + (marked ? '，已把它标记为「不支持识图」' : '') + '。' + String.fromCharCode(10, 10)
    + '你可以：① 在对话上方模型下拉里换一个支持多模态的模型；'
    + '② 到「设置 → AI 接入方式」给这条连接配置识图模型；'
    + '③ 或者把图片里的关键文字直接粘成文本再发给我。' + String.fromCharCode(10, 10)
    + '（如果这个模型其实支持识图：到「设置 → AI 接入方式」重新保存一次连接，会清掉这个标记再试。）';
}

/* 设置里配置的识图模型（用户可能单独配了「识图模型」）：
   当前对话模型不支持识图时，自动改用它来识别图片，再把识别结果交给对话模型回答。 */
function configuredVisionModel() {
  try { const v = ai.standaloneVision(); if (v && v.models && v.models[0]) return String(v.models[0]); } catch (e) {}
  try { const ref = String(getSetting('vision_model', '') || '').trim(); if (ref) return ref; } catch (e) {}
  try { const vp = ai.modelPoolVision(); if (vp && vp.length) return String(vp[0].model || vp[0].id || ''); } catch (e) {}
  return '';
}
function visionFallbackFor(chatModel) {
  const vm = configuredVisionModel();
  if (!vm) return '';
  if (String(vm).toLowerCase() === String(chatModel || '').toLowerCase()) return '';
  return vm;
}
/* 明确知道「这个模型能识图」的证据（不是默认假设）：用于决定直接发图还是走识图模型。 */
function modelKnownVision(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return false;
  try { for (const m of (ai.modelPoolVision() || [])) { const a = String(m.id || '').toLowerCase(), b = String(m.model || '').toLowerCase(); if (a === id || b === id) return true; } } catch (e) {}
  try { const st = ai.standaloneVision(); if (st && (st.models || []).some(x => String(x).toLowerCase() === id)) return true; } catch (e) {}
  try { const ref = String(getSetting('vision_model', '') || '').trim().toLowerCase(); if (ref && ref === id) return true; } catch (e) {}
  try { const conns = ai.connections() || []; for (const c of conns) { const has = (c.models || []).some(x => String(x).toLowerCase() === id) || String(c.defaultModel || '').toLowerCase() === id; if (!has) continue; if (c.visionModel && String(c.visionModel).toLowerCase() === id) return true; const pr = (ai.PROVIDERS || []).find(x => x.id === c.providerId); if (pr && pr.vision && String(pr.vision).toLowerCase() === id) return true; } } catch (e) {}
  return /(^|\/)(gpt-4o|gpt-4\.1|gpt-5|o4|claude|gemini|glm-4\.\dv|glm-4v|qwen.*vl|kimi-k3|llava|gemma3|.*-vl|.*vision|mimo.*vl|doubao.*vision|ernie.*vl|step.*vl)/i.test(id);
}
/* 用识图模型看图：返回识别出的文字（最多 8000 字）；失败返回 { error } */
async function recognizeImagesWith(images, visionModel, signal) {
  if (!images || !images.length || !visionModel) return { error: '没有可用的识图模型' };
  const prompt = '请仔细识别这 ' + images.length + ' 张图片里的全部有用信息：逐字转写图片中的文字（OCR），并描述表格/数字/界面元素/代码/图表结构/关键结论。只输出识别结果本身，不要寒暄或评论。';
  try {
    const t = await ai.text({ prompt: prompt, model: visionModel, images: images, timeoutMs: 180000, signal: signal, scene: '识图' });
    return { text: String(t || '').trim().slice(0, 8000) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
function imageRecognitionBlock(rec, visionModel) {
  return '【图片识别结果（由设置里的识图模型「' + visionModel + '」识别）】' + String.fromCharCode(10) + rec + String.fromCharCode(10)
    + '回答时以这段识别结果为准；这是用户发来的图片内容，不要说你看不到图片。';
}

function streamChat(req, res, goal, message, session, opts) {
  const o = opts || {};
  const askOnly = o.mode === 'ask';
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const sig = clientSignal(req);   // 用户在对话里点「停止」时，终止上游 AI 请求
  const model = (session && session.model) ? session.model : currentModel();
  const sessionId = session ? session.id : 0;
  /* 用户这次粘贴/拖进来的图片：原图只发给模型，缩略图落库（刷新还能看到） */
  const images = sanitizeChatImages(o.images);
  const imageThumbs = sanitizeChatThumbs(o.image_thumbs);
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  /* 「它做了什么」：本轮看了什么上下文、调了哪些工具。
     一边收集一边下发（用户要能看着它干），收尾时随这条回复一起落库（刷新后还在）。
     两道上限：步数与总字节。带工具的代理会反复读文件，不设限 SSE、数据库、
     多端同步的快照都会被撑爆（一条消息几百 KB）。 */
  const trace = [];
  const TRACE_MAX_STEPS = 300, TRACE_MAX_BYTES = 60000;
  let traceBytes = 0;
  const pushStep = s => {
    if (!s || trace.length >= TRACE_MAX_STEPS) return;
    let j = '';
    try { j = JSON.stringify(s); } catch (e) { return; }
    if (traceBytes + j.length > TRACE_MAX_BYTES) return;
    traceBytes += j.length;
    trace.push(s);
    send({ step: s });
  };
  (async () => {
    let fullText = '';
    try {
      db.prepare('INSERT INTO chats (goal_id, session_id, role, content, images, created_at) VALUES (?,?,?,?,?,?)').run(goal.id, sessionId, 'user', String(message).slice(0, 30000), JSON.stringify(imageThumbs), nowISO());
      if (session && (!session.title || session.title === '新对话')) {
        const autoTitle = String(message).replace(/\s+/g, ' ').trim().slice(0, 24);
        if (autoTitle) {
          db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(autoTitle, nowISO(), sessionId);
          send({ sessionTitle: autoTitle });
        }
      }
      /* 图片策略：
         ① 明确知道当前模型能识图 → 直接把图发给它（原生多模态回答）；
         ② 判断不了或已知不能识图，且**设置里配了识图模型** → 先让识图模型看图，再把识别结果交给对话模型；
         ③ 两者都不行 → 说清楚不能识别。 */
      const visionFallback = images.length ? visionFallbackFor(model) : '';
      const knownVision = images.length ? modelKnownVision(model) : false;
      let imageRecognition = '';
      let sendImages = images;
      if (images.length && !knownVision) {
        if (visionFallback) {
          send({ status: '正在用识图模型「' + visionFallback + '」识别图片…' });
          const rec = await recognizeImagesWith(images, visionFallback, sig);
          if (rec && rec.text) {
            imageRecognition = rec.text;
            sendImages = [];
            pushStep({ kind: 'ctx', label: '用识图模型「' + visionFallback + '」识别了 ' + images.length + ' 张图片', detail: imageRecognition.length + ' 字' });
          } else {
            const why = '⚠️ 当前模型不能识图，设置里的识图模型「' + visionFallback + '」也没识别成功：' + String((rec && rec.error) || '未知错误')
              + String.fromCharCode(10, 10) + '可以检查「设置 → AI 接入方式」里的识图模型配置，或换一个支持多模态的模型再发。';
            send({ status: '识图失败' });
            send({ text: why }); send({ reply: why });
            const insF = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
              .run(goal.id, sessionId, 'assistant', why, '[]', 0, JSON.stringify(trace), nowISO());
            backup();
            send({ done: true, id: Number(insF.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace: trace, goal: getGoal(goal.id) });
            res.end(); return;
          }
        } else if (!modelSupportsVision(model)) {
          const why = visionRejectText(model);
          send({ status: '当前模型不支持识别图片' });
          send({ text: why });
          send({ reply: why });
          const ins2 = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(goal.id, sessionId, 'assistant', why, '[]', 0, JSON.stringify([{ kind: 'ctx', label: '图片识别', detail: '当前模型不支持' }]), nowISO());
          backup();
          send({ done: true, id: Number(ins2.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace: [], goal: getGoal(goal.id) });
          res.end();
          return;
        }
      }
      /* 先算提示词：它的副产物就是「这轮带了哪些上下文」——
         在调 AI 之前先发出去，用户点发送后马上能看到"它正在看什么"。 */
      const bp = await buildChatPrompt(goal, message, sessionId, o);
      if (imageRecognition) {
        bp.prompt += String.fromCharCode(10, 10) + imageRecognitionBlock(imageRecognition, visionFallback);
      } else if (sendImages.length) {
        bp.prompt += String.fromCharCode(10, 10) + '【用户这次还发了 ' + sendImages.length + ' 张图片】它们是随这条消息一起发来的图片输入，请结合图片内容回答；描述图片时说到关键文字/布局/数字。';
        pushStep({ kind: 'ctx', label: '你发来的 ' + sendImages.length + ' 张图片', detail: '已随消息一起交给模型' });
      }
      for (const s of (bp.ctx || [])) pushStep(s);
      send({ status: '正在理解你的要求…' });
      fullText = await ai.text({
        prompt: bp.prompt,
        model: model || currentModel(),
        images: sendImages.length ? sendImages : undefined,
        timeoutMs: 420000,
        signal: sig,
        scene: '助手对话',
        onEvent: ev => {
          if (ev.step) pushStep(ev.step);
          if (ev.text) send({ text: ev.text });
          else if (ev.thinking) send({ thinking: summarizeThinking(ev.thinking) });
        }
      });
      const parsed = parseChatOutput(fullText);
      let reply = parsed.reply.slice(0, 20000);
      /* 创造模式：AI 只负责生成 create JSON，**不直接改任何东西**。
         这里解析 + 校验 + 暂存；真正安装要等用户在对话卡片上点「安装并查看」
         （= DSH 的 agent 准备 workspace 包、plugin_manager 安装要用户批准）。 */
      let createInfo = null;
      let createParse = null;
      if (o.mode === 'create') {
        createParse = createMode.parse(fullText);
        reply = String(createParse.reply || parsed.reply || '').slice(0, 20000);
        if (createParse.error) {
          reply += '\n\n> ⚠️ ' + createParse.error + '\n> 可以说「按上面的问题改一下重新生成」，或把要求说短一点再试。';
        } else if (!createParse.artifact) {
          if (!reply) reply = '想改什么？告诉我页面/风格，或想要的新功能，我先给你一版。';
        } else {
          try {
            createInfo = createMode.stage(createParse.artifact);
            if (!reply) reply = '已生成「' + createInfo.name + '」。确认没问题就点下面的「安装并查看」。';
            pushStep({ kind: 'create', label: '已生成「' + createInfo.name + '」', detail: createInfo.kind + ' · ' + createInfo.id + ' · 等你确认安装', create: createInfo });
            send({ status: '已生成，等待你确认安装' });
          } catch (e) {
            createInfo = null;
            reply += '\n\n> ⚠️ 生成的内容没通过服务端校验：' + ((e && e.message) || e) + '\n> 可以说「按上面的问题改一下重新生成」。';
          }
        }
      }
      if (!reply) throw new Error('AI 回复为空，请重试');
      /* ASK 模式下服务端直接丢弃任何 ops —— 不给模型"忘了规矩"的机会。
         前端也会拦一道，但边界必须在这里。
         创造模式同样不走 ops：它产出的是插件文件，不是路线图操作。 */
      let ops = (askOnly || o.mode === 'create') ? [] : parsed.ops;
      /* 「🎯 只改」范围：越界的 ops 在这里就被挡掉，绝不下到 applyChatOps。
         同时把"挡掉了什么"写进回复，否则用户只会觉得"AI 说改了、界面没变"。 */
      let scopeBlocked = [];
      if (!askOnly && o.scope && o.scope !== 'auto') {
        const f = chatScopeFilterOps(ops, o.scope);
        ops = f.ops;
        scopeBlocked = f.blocked;
        if (scopeBlocked.length) {
          const kinds = Array.from(new Set(scopeBlocked)).slice(0, 4).join(' / ');
          reply += '\n\n> 🎯 这次你在上方限定只改「' + CHAT_SCOPE_LABEL[chatScopeOf(o.scope)] + '」，'
            + '有 ' + scopeBlocked.length + ' 处改动超出范围、已被挡掉（' + kinds + '）。'
            + '要改它们，请把「只改」切到对应项再发一次。';
        }
      }
      /* 模型"嘴上说已经交办了、其实没给出任何操作"——两种原因：
         ① 回复写到一半被输出上限截断，末尾那段 ops 直接丢了；
         ② **根本没写 ops**（长正文里 ops 最容易丢，实测 chats id=299）。
         ①的抢救在 parseChatOutput 里；②这里补一刀：先用极小的一次性请求让它把
         刚答应的事表达成 JSON 操作数组，补不到才在对话里说实话，别让人干等。 */
      if (!ops.length && !askOnly && o.mode !== 'create' && looksLikePromise(reply)) {
        send({ status: '正在补齐可执行的操作…' });
        ops = await recoverChatOps(goal, message, reply, o, model, sig);
      }
      /* ⚠️ 措辞必须准确：这次病根是"没写 ops"，**不是**被截断 ——
         写成"多半被截断"会把用户引导去"把要求写短"，而真正该做的是重试。 */
      if (!ops.length && looksLikePromise(reply)) {
        reply += '\n\n> ⚠️ **上面这些并没有真的交办** —— 这条回复只说了要做，却没带出可执行的操作'
          + '（可能模型漏写了，也可能写太长被截断）。请把要求写短一点再说一次，或把整篇拆成两三节分次提。';
      }
      send({ reply });
      let applied = [], errors = [], vid = 0;
      if (ops.length) {
        send({ status: `正在应用 ${ops.length} 处修改…` });
        vid = beginVersion(goal.id, '对话修改');
        const r = applyChatOps(goal.id, ops, o);
        applied = r.applied; errors = r.errors;
        db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
        const report = await finishVersion(goal, vid, '对话修改', false);
        if (vid && !report) vid = 0;
        else if (vid) db.prepare('UPDATE goal_versions SET summary = ? WHERE id = ?').run(reply.slice(0, 800), vid);
      }
      const t = nowISO();
      const ins = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(goal.id, sessionId, 'assistant', reply, JSON.stringify(applied), vid, JSON.stringify(trace), t);
      if (sessionId) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(t, sessionId);
      backup();
      send({ done: true, id: Number(ins.lastInsertRowid), reply, applied, errors, versionId: vid, trace, create: createInfo, createError: (createParse && createParse.error) || '', goal: getGoal(goal.id) });
    } catch (e) {
      if (e && e.cancelled) send({ cancelled: true, status: '已停止（本轮未执行任何修改）' });
      else {
        /* 图片相关的上游报错（模型其实不支持读图/不接受 image_url）：换成用户看得懂的说明，
           不要甩一段 HTTP 400 原文。 */
        if (images.length && /image|vision|multimodal|content[ _-]?type|unsupported|不支持|无法.*图/i.test(String((e && e.message) || e))) {
          markVisionUnsupported(model);
          send({ status: '模型不能识别图片，已记下' });
          const fbNow = visionFallbackFor(model);
          const why = visionRejectText(model, true) + String.fromCharCode(10, 10) + '（上游返回：' + String((e && e.message) || e).slice(0, 160) + '）'
            + (fbNow ? String.fromCharCode(10, 10) + '再发一次图片会自动改用识图模型「' + fbNow + '」识别后再回答。' : '');
          try {
            const ins2 = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
              .run(goal.id, sessionId, 'assistant', why, '[]', 0, JSON.stringify(trace), nowISO());
            if (sessionId) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sessionId);
            backup();
            send({ error: why }); send({ done: true, id: Number(ins2.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace, goal: getGoal(goal.id) });
            res.end();
            return;
          } catch (e2) {}
        }
        /* 失败也要在对话里留一条**看得见**的话。
           以前这里只 send({error}) → 前端弹个 toast，几秒后就没了；
           用户回头只看见自己那句孤零零的问题，以为"发出去没反应"（真实踩到过：
           会话里钉的模型连接被删掉后，每轮都这样静默失败）。 */
        const msg = String((e && e.message) || e);
        try {
          const ins = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(goal.id, sessionId, 'assistant', '⚠️ 这次没能处理：' + msg + '\n\n（可以原样再发一次；要是每次这样，去「设置 → AI 接入方式」看看这条对话选的模型连接还在不在）', '[]', 0, JSON.stringify(trace), nowISO());
          if (sessionId) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sessionId);
          send({ error: msg });
          send({ done: true, id: Number(ins.lastInsertRowid), reply: '⚠️ 这次没能处理：' + msg, applied: [], errors: [msg], versionId: 0, trace, goal: getGoal(goal.id) });
        } catch (e2) { send({ error: msg }); }
      }
    }
    res.end();
  })();
}

/* ===== 全局 AI 助手（不绑定具体目标） ===== 
   所有页面都能打开它；没有目标上下文时走这里：读全站内容 + 当前页面文字，但**只读**。
   修改能力保留在「有目标上下文」的页面（目标/路线图/条件/教程/插件页），
   由 buildChatPrompt + applyChatOps 处理；这里绝不落库任何 ops。 */
function globalOverviewBlock() {
  const lines = ['【全局概览 · 思而行全站】'];
  try {
    const goals = db.prepare('SELECT id,title,status,deadline,weekly_hours FROM goals ORDER BY updated_at DESC, id DESC LIMIT 50').all();
    lines.push('- 目标 ' + goals.length + ' 个：');
    for (const g of goals.slice(0, 30)) {
      let done = 0, total = 0;
      try {
        const rows = db.prepare('SELECT id,parent_id,status FROM nodes WHERE goal_id = ?').all(g.id);
        const parents = new Set(rows.filter(r => r.parent_id).map(r => Number(r.parent_id)));
        const leaves = rows.filter(r => !parents.has(Number(r.id)));
        total = leaves.length; done = leaves.filter(r => r.status === 'done').length;
      } catch (e) {}
      lines.push('  · #' + g.id + ' ' + String(g.title || '').slice(0, 50) + '（' + (total ? Math.round(done / total * 100) : 0) + '%，节点 ' + done + '/' + total +
        (g.deadline ? '，期限 ' + String(g.deadline).slice(0, 20) : '') + (g.weekly_hours ? '，每周 ' + String(g.weekly_hours).slice(0, 12) : '') + '）');
    }
  } catch (e) {}
  try { lines.push('- 资料库：' + db.prepare('SELECT COUNT(*) AS n FROM sources').get().n + ' 条'); } catch (e) {}
  try { lines.push('- 达成条件：' + db.prepare('SELECT COUNT(*) AS n FROM goal_conditions').get().n + ' 条'); } catch (e) {}
  try { lines.push('- 教程：' + db.prepare('SELECT COUNT(*) AS n FROM tutorials').get().n + ' 份'); } catch (e) {}
  try {
    const comps = allComponents().filter(c => c.kind !== 'theme');
    const on = comps.filter(c => c.scope === 'core' || componentEnabled(c.id)).length;
    lines.push('- 组件：' + comps.length + ' 个（启用 ' + on + '）');
  } catch (e) {}
  return lines.join(String.fromCharCode(10));
}
/* ===== 全局助手「按需查阅」工具（只读） ===== 
   用户要求（2026-10-19）：全局助手不能只是概览，设置/资源库/产出库/组件/界面插件/AI 任务
   这些具体内容**想查的时候都要能拿到**，而不是一次性全灌进上下文。
   做法：模型先输出一个 ```tool 代码块（JSON 数组），服务端执行只读工具、把结果回填后
   再让它回答。最多两轮查询，避免死循环/烧 token。 */
const GTICK = String.fromCharCode(96, 96, 96);
function globalToolDefs() {
  return [
    ['goals.list', '{}', '所有目标：id/标题/状态/进度/节点数/条件数/资料数/教程数'],
    ['goal.get', '{"id":166}', '单个目标详情：现状、材料节选、约束、节点大纲、达成条件、资料/教程清单'],
    ['sources.list', '{"goal_id":0,"kind":"","q":"","limit":10}', '资源库清单/搜索：q 同时搜标题与正文，返回命中片段；kind 可筛 JD/岗位/教程等'],
    ['sources.get', '{"id":123}', '单条资料的正文（最多 8000 字），需要看具体内容时用'],
    ['tutorials.list', '{"goal_id":0,"q":"","limit":10}', '教程清单：id/标题/所属目标/格式/字数/更新时间'],
    ['settings.get', '{}', '设置全貌：AI 连接与模型（密钥只显示是否已填）、检索增强、资料搜集、同步、讲解风格、数据位置等'],
    ['components.list', '{}', '组件管理：所有组件的 id/名称/分类/scope/是否启用/说明'],
    ['ui.list', '{}', '界面管理：内置页面插件、用户页面插件（覆盖/启用）、皮肤、内核加载状态'],
    ['tasks.list', '{}', 'AI 任务：正在跑/排队的任务、最近历史（状态/耗时/错误）、成功失败统计'],
    ['outlib.list', '{"goal_id":0}', '产出库：各目标的文件/目录数/体积、最近文件、顶层目录'],
    ['library.overview', '{}', '资源库总览：资料按 kind 计数、提炼汇总篇数、教程/目标/产出统计']
  ];
}
function globalToolCatalogText() {
  const lines = ['【可按需查阅的站内数据（只读；查到什么说什么，不要编造）】'];
  lines.push('需要具体信息时，**只输出一个 ' + GTICK + 'tool 代码块**（内容是 JSON 数组，一次 1~6 个工具），不要同时输出正文。例如：');
  lines.push(GTICK + 'tool');
  lines.push('[{"tool":"sources.list","args":{"q":"JD","limit":10}}]');
  lines.push(GTICK);
  lines.push('可用工具：');
  globalToolDefs().forEach((d, i) => lines.push((i + 1) + '. ' + d[0] + ' ' + d[1] + ' —— ' + d[2]));
  lines.push('用法：先判断需不需要查；需要就只发 tool 块（服务端执行后会把数据回填给你），再基于数据回答；最多查 2 轮。不需要查就直接回答。');
  return lines.join(String.fromCharCode(10));
}
function gClip(s, n) {
  s = String(s == null ? '' : s);
  if (n == null) n = 60;
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function globalToolLabel(name) {
  return ({
    'goals.list': '目标列表', 'goal.get': '目标详情', 'sources.list': '资源库清单', 'sources.get': '资料正文',
    'tutorials.list': '教程清单', 'settings.get': '设置', 'components.list': '组件管理', 'ui.list': '界面管理',
    'tasks.list': 'AI 任务', 'outlib.list': '产出库', 'library.overview': '资源库总览'
  })[name] || name;
}
function parseGlobalToolCalls(raw) {
  const s = String(raw || '');
  const out = [];
  const take = arr => {
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      const nm = String(o.tool || o.name || '').trim();
      if (!nm) continue;
      const args = (o.args && typeof o.args === 'object' && !Array.isArray(o.args)) ? o.args : (o.arguments && typeof o.arguments === 'object' ? o.arguments : {});
      out.push({ tool: nm.slice(0, 40), args: args });
      if (out.length >= 6) break;
    }
  };
  try {
    const re = new RegExp(GTICK + 'tool[\\t ]*\\r?\\n?([\\s\\S]*?)' + GTICK, 'gi');
    let m;
    while ((m = re.exec(s)) && out.length < 6) {
      const body = String(m[1] || '').trim();
      if (!body) continue;
      try {
        const j = JSON.parse(body);
        if (Array.isArray(j)) take(j);
        else if (j && Array.isArray(j.calls)) take(j.calls);
        else if (j && j.tool) take([j]);
      } catch (e) {}
    }
  } catch (e) {}
  if (out.length) return out;
  try {
    const i = s.search(/\[\s*\{\s*"(tool|name)"\s*:/);
    if (i >= 0) {
      const j = JSON.parse(s.slice(i));
      if (Array.isArray(j)) take(j);
      else if (j && j.tool) take([j]);
    }
  } catch (e) {}
  return out;
}
function stripGlobalToolFences(raw) {
  let s = String(raw || '');
  try {
    const re = new RegExp(GTICK + 'tool[\\t ]*\\r?\\n?[\\s\\S]*?' + GTICK, 'gi');
    s = s.replace(re, '');
  } catch (e) {}
  return s.trim();
}
/* 执行一个只读全局工具；参数只认数字/字符串，任何异常都返回 {ok:false}（绝不影响对话）。 */
function globalToolRun(name, args) {
  const a = (args && typeof args === 'object') ? args : {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : (d || 0); };
  const str = (v, max) => gClip(String(v == null ? '' : v), max || 80);
  const goalTitles = () => {
    const m = {};
    try { for (const g of db.prepare('SELECT id,title FROM goals').all()) m[g.id] = g.title; } catch (e) {}
    return m;
  };
  try {
    if (name === 'goals.list') {
      const rows = db.prepare('SELECT g.id,g.title,g.status,g.deadline,g.weekly_hours,'
        + ' (SELECT COUNT(*) FROM nodes n WHERE n.goal_id=g.id) AS nodes,'
        + ' (SELECT COUNT(*) FROM nodes n WHERE n.goal_id=g.id AND n.status=\'done\') AS nodes_done,'
        + ' (SELECT COUNT(*) FROM goal_conditions c WHERE c.goal_id=g.id) AS conds,'
        + ' (SELECT COUNT(*) FROM sources s WHERE s.goal_id=g.id) AS sources,'
        + ' (SELECT COUNT(*) FROM tutorials t WHERE t.goal_id=g.id) AS tutorials'
        + ' FROM goals g ORDER BY g.updated_at DESC, g.id DESC LIMIT 60').all();
      return { tool: name, ok: true, data: { count: rows.length, goals: rows.map(r => ({
        id: r.id, title: gClip(r.title, 60), status: r.status, deadline: r.deadline || '', weekly_hours: r.weekly_hours || '',
        nodes: r.nodes, nodes_done: r.nodes_done, percent: r.nodes ? Math.round(r.nodes_done / r.nodes * 100) : 0,
        conditions: r.conds, sources: r.sources, tutorials: r.tutorials })) } };
    }
    if (name === 'goal.get') {
      const gid = num(a.id);
      const g = gid ? db.prepare('SELECT * FROM goals WHERE id = ?').get(gid) : null;
      if (!g) return { tool: name, ok: false, error: '目标不存在：' + (a.id == null ? '（缺少 id）' : a.id) };
      const nodes = db.prepare('SELECT id,parent_id,level,title,status,condition_id FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id LIMIT 100').all(gid);
      const conds = db.prepare('SELECT id,title,acceptance,jd_ref,priority,source FROM goal_conditions WHERE goal_id = ? ORDER BY sort_order, id').all(gid);
      const srcs = db.prepare('SELECT id,title,kind,site,length(content) AS chars FROM sources WHERE goal_id = ? ORDER BY id DESC LIMIT 30').all(gid);
      const tuts = db.prepare('SELECT id,title,format,length(content) AS chars,updated_at FROM tutorials WHERE goal_id = ? ORDER BY updated_at DESC LIMIT 30').all(gid);
      return { tool: name, ok: true, data: {
        id: g.id, title: g.title, status: g.status, profile: gClip(g.profile, 1200), materials: gClip(g.materials, 2000),
        summary: gClip(g.summary, 1000), deadline: g.deadline || '', weekly_hours: g.weekly_hours || '',
        constraints: safeParse(g.constraints) || [],
        nodes: nodes.map(n => ({ id: n.id, parent_id: n.parent_id, level: n.level, title: gClip(n.title, 60), status: n.status, condition_id: n.condition_id })),
        conditions: conds.map(c => ({ id: c.id, title: gClip(c.title, 60), acceptance: gClip(c.acceptance, 160), jd: gClip(c.jd_ref, 200), priority: c.priority, source: c.source })),
        sources: srcs.map(s => ({ id: s.id, title: gClip(s.title, 80), kind: s.kind, site: gClip(s.site, 40), chars: s.chars })),
        tutorials: tuts.map(t => ({ id: t.id, title: gClip(t.title, 80), format: t.format, chars: t.chars, updated_at: t.updated_at }))
      } };
    }
    if (name === 'sources.list' || name === 'library.overview') {
      const gid = num(a.goal_id);
      const kind = str(a.kind || a.type, 20).trim();
      const qq = str(a.q || a.query, 40).trim();
      const lim = Math.min(20, Math.max(1, num(a.limit, 10)));
      if (name === 'library.overview') {
        const byKind = db.prepare('SELECT kind,COUNT(*) AS c FROM sources GROUP BY kind ORDER BY c DESC LIMIT 20').all();
        let digests = 0; try { digests = db.prepare('SELECT COUNT(*) AS n FROM source_digests').get().n; } catch (e) {}
        let tutorials = 0; try { tutorials = db.prepare('SELECT COUNT(*) AS n FROM tutorials').get().n; } catch (e) {}
        let goals = 0; try { goals = db.prepare('SELECT COUNT(*) AS n FROM goals').get().n; } catch (e) {}
        return { tool: name, ok: true, data: { sources_total: byKind.reduce((x, r) => x + r.c, 0), by_kind: byKind.map(r => ({ kind: r.kind, count: r.c })), digests: digests, tutorials: tutorials, goals: goals } };
      }
      const wh = [], ps = [];
      if (gid) { wh.push('goal_id = ?'); ps.push(gid); }
      if (kind) { wh.push('kind LIKE ?'); ps.push('%' + kind + '%'); }
      if (qq) { wh.push('(title LIKE ? OR content LIKE ?)'); const lk = '%' + qq + '%'; ps.push(lk, lk); }
      const rows = db.prepare('SELECT * FROM sources' + (wh.length ? ' WHERE ' + wh.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + lim).all(...ps);
      const titles = goalTitles();
      const findSnip = (row) => {
        const content = String(row.content || '') + ' ' + String(row.snippet || '');
        if (!qq) return gClip(content.replace(/\s+/g, ' ').trim(), 160);
        const low = content.toLowerCase(), idx = low.indexOf(qq.toLowerCase());
        if (idx < 0) return gClip(content.replace(/\s+/g, ' ').trim(), 160);
        const from = Math.max(0, idx - 90);
        return (from > 0 ? '…' : '') + content.slice(from, idx + qq.length + 120).replace(/\s+/g, ' ').trim() + '…';
      };
      return { tool: name, ok: true, data: { count: rows.length, q: qq || undefined, items: rows.map(r => ({
        id: r.id, title: gClip(r.title, 90), kind: r.kind, site: gClip(r.site, 40), goal_id: r.goal_id,
        goal: gClip(titles[r.goal_id] || '', 40), chars: String(r.content || '').length, created_at: r.created_at, snippet: findSnip(r) })) } };
    }
    if (name === 'sources.get') {
      const id = num(a.id);
      const r = id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(id) : null;
      if (!r) return { tool: name, ok: false, error: '资料不存在：' + (a.id == null ? '（缺少 id）' : a.id) };
      return { tool: name, ok: true, data: { id: r.id, title: r.title, kind: r.kind, site: r.site, goal_id: r.goal_id, created_at: r.created_at, content: gClip(String(r.content || r.snippet || ''), 8000) } };
    }
    if (name === 'tutorials.list') {
      const gid = num(a.goal_id);
      const qq = str(a.q || a.query, 40).trim();
      const lim = Math.min(30, Math.max(1, num(a.limit, 10)));
      const wh = [], ps = [];
      if (gid) { wh.push('goal_id = ?'); ps.push(gid); }
      if (qq) { wh.push('(title LIKE ? OR content LIKE ?)'); const lk = '%' + qq + '%'; ps.push(lk, lk); }
      const rows = db.prepare('SELECT id,goal_id,node_id,title,format,length(content) AS chars,updated_at FROM tutorials' + (wh.length ? ' WHERE ' + wh.join(' AND ') : '') + ' ORDER BY updated_at DESC, id DESC LIMIT ' + lim).all(...ps);
      const titles = goalTitles();
      return { tool: name, ok: true, data: { count: rows.length, items: rows.map(r => ({ id: r.id, title: gClip(r.title, 80), goal_id: r.goal_id, goal: gClip(titles[r.goal_id] || '', 40), format: r.format, chars: r.chars, updated_at: r.updated_at })) } };
    }
    if (name === 'settings.get') {
      let conns = [];
      try { conns = (ai.connections() || []).map(c => ({ id: c.id, name: c.name, provider: c.provider, kind: c.kind, purpose: c.purpose, baseUrl: c.baseUrl, key_set: !!c.apiKey, models: (c.models || []).slice(0, 10), defaultModel: c.defaultModel, visionModel: c.visionModel, enabled: c.enabled !== false })); } catch (e) {}
      let compSettings = {};
      try { compSettings = componentSettings(); } catch (e) {}
      return { tool: name, ok: true, data: {
        ai: { default_model: currentModel(), vision_model: currentVisionModel(), connections: conns,
          env_keys: { base: !!(process.env.SIERXING_API_BASE || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE), key: !!(process.env.SIERXING_API_KEY || process.env.OPENAI_API_KEY), model: !!(process.env.SIERXING_MODEL || process.env.OPENAI_MODEL) } },
        rag: { enabled: (getSetting('rag_enabled', '1') || '1') !== '0', emb_base_url: getSetting('emb_base_url', ''), emb_model: getSetting('emb_model', ''), emb_key_set: !!getSetting('emb_api_key', ''), vector_ready: (getSetting('rag_enabled', '1') || '1') !== '0' && !!getSetting('emb_api_key', '') },
        collect: { review: (getSetting('collect_review', '1') || '1') !== '0', min_score: getSetting('collect_min_score', '3'), candidates: getSetting('collect_candidates', '220'), per_site: getSetting('collect_per_site', '12'), full: (getSetting('collect_full', '1') || '1') !== '0', full_max: getSetting('collect_full_max', '60000') },
        sync: { enabled: getSetting('sync_enabled', '') === '1', repo: getSetting('sync_repo', ''), branch: getSetting('sync_branch', 'main'), user: getSetting('sync_user', ''), token_set: !!getSetting('sync_token', ''), auto_push: getSetting('sync_auto_push', '1') !== '0', auto_pull: getSetting('sync_auto_pull', '1') !== '0', images: getSetting('sync_images', '1') === '1' },
        explain: { style_sample_chars: String(getSetting('explain_style_sample', '') || '').length },
        app: { app_dir: APP_DIR, data_dir: DATA_DIR, node: process.version },
        theme: getSetting('theme', '') || '',
        component_settings: compSettings
      } };
    }
    if (name === 'components.list') {
      const comps = allComponents() || [];
      let settings = {};
      try { settings = componentSettings(); } catch (e) {}
      return { tool: name, ok: true, data: { count: comps.length, components: comps.map(c => ({
        id: c.id, name: c.name, scope: c.scope, category: c.category, desc: gClip(c.desc, 120),
        enabled: c.scope === 'core' ? true : (settings[c.id] != null ? !!settings[c.id] : !!c.defaultEnabled),
        defaultEnabled: !!c.defaultEnabled, goalToggle: c.goalToggle !== false, builtin: c.builtin !== false })) } };
    }
    if (name === 'ui.list') {
      let pages = [], skins = [], ks = null;
      try { pages = (uiPlugins.listAll() || []).map(m => ({ id: m.id, name: m.name || m.id, source: m.source || 'builtin', enabled: m.enabled !== false, route: m.route || '', format: m.format || '', overridden: !!m.overrides })); } catch (e) {}
      try { skins = (uiPlugins.listSkins() || []).map(s => ({ id: s.id, name: s.name, priority: s.priority })); } catch (e) {}
      try { ks = kernelState(PLUGIN_DIR); } catch (e) {}
      const kp = (ks && ks.plugins) || [];
      return { tool: name, ok: true, data: {
        pages: pages, skins: skins,
        kernel: { ok: !!(ks && ks.ok), plugin_count: kp.length, service_count: ((ks && ks.services) || []).length, failed: kp.filter(p => p && p.status && p.status !== 'loaded').map(p => ({ id: p.id, status: p.status, error: gClip(p.error, 160) })).slice(0, 10) },
        user_dir: (function () { try { return uiPlugins.dir; } catch (e) { return ''; } })()
      } };
    }
    if (name === 'tasks.list') {
      let live = [];
      try { live = (tasks.list(0) || []).map(t => ({ id: t.id, title: gClip(t.title, 80), type: t.type, status: t.status, progress: t.progress, goalId: t.goalId, message: gClip(t.message, 120), error: gClip(t.error, 160), createdAt: t.createdAt, elapsedMs: t.elapsedMs })); } catch (e) {}
      let recent = [], stats = [];
      try { recent = db.prepare('SELECT id,goal_id,type,title,status,error,cost_ms,created_at FROM task_runs ORDER BY id DESC LIMIT 15').all(); } catch (e) {}
      try { stats = db.prepare('SELECT status,COUNT(*) AS c FROM task_runs GROUP BY status').all(); } catch (e) {}
      const titles = goalTitles();
      return { tool: name, ok: true, data: {
        running: live.filter(t => t.status === 'running').length, queued: live.filter(t => t.status === 'queued').length,
        live: live.slice(0, 20),
        recent: recent.map(r => ({ id: r.id, title: gClip(r.title, 80), type: r.type, status: r.status, goal_id: r.goal_id, goal: gClip(titles[r.goal_id] || '', 40), error: gClip(r.error, 160), cost_ms: r.cost_ms, created_at: r.created_at })),
        stats: stats.map(r => ({ status: r.status, count: r.c }))
      } };
    }
    if (name === 'outlib.list') {
      const gid = num(a.goal_id);
      let rows = [], recent = [];
      try { rows = db.prepare('SELECT goal_id,kind,COUNT(*) AS c,COALESCE(SUM(size),0) AS s FROM outlib_nodes GROUP BY goal_id,kind').all(); } catch (e) {}
      try { recent = db.prepare('SELECT id,goal_id,kind,name,size,updated_at FROM outlib_nodes WHERE kind = \'file\' ORDER BY updated_at DESC, id DESC LIMIT 20').all(); } catch (e) {}
      const titles = goalTitles();
      const byGoal = {};
      for (const r of rows) {
        if (gid && Number(r.goal_id) !== gid) continue;
        const m = byGoal[r.goal_id] || (byGoal[r.goal_id] = { goal_id: r.goal_id, goal: gClip(titles[r.goal_id] || '', 40), files: 0, dirs: 0, bytes: 0 });
        if (r.kind === 'dir') m.dirs = r.c; else { m.files = r.c; m.bytes = r.s; }
      }
      return { tool: name, ok: true, data: {
        total_files: Object.keys(byGoal).reduce((x, k) => x + byGoal[k].files, 0),
        by_goal: Object.keys(byGoal).map(k => byGoal[k]),
        recent_files: recent.filter(r => !gid || Number(r.goal_id) === gid).map(r => ({ id: r.id, name: gClip(r.name, 80), goal_id: r.goal_id, goal: gClip(titles[r.goal_id] || '', 40), size: r.size, updated_at: r.updated_at }))
      } };
    }
    return { tool: name, ok: false, error: '没有这个工具：' + name };
  } catch (e) {
    return { tool: name, ok: false, error: String((e && e.message) || e) };
  }
}
function globalToolResultsText(results) {
  const lines = [];
  let budget = 16000;
  for (const r of results) {
    const label = globalToolLabel(r.tool);
    if (!r.ok) { lines.push('## ' + label + '（' + r.tool + '）失败：' + gClip(r.error, 200)); continue; }
    let s = '';
    try { s = JSON.stringify(r.data); } catch (e) { s = String(r.data); }
    if (budget > 0 && s.length > budget) s = s.slice(0, budget) + '…（已截断）';
    budget -= s.length;
    lines.push('## ' + label + '（' + r.tool + '）');
    lines.push(s);
  }
  return lines.join(String.fromCharCode(10));
}
function streamGlobalChat(req, res, session) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = obj => { try { res.write('data: ' + JSON.stringify(obj) + String.fromCharCode(10, 10)); } catch (e) {} };
  const trace = [];
  const pushStep = s => { trace.push(s); send({ step: s }); };
  (async () => {
    try {
      /* ⚠️ 必须先读完 body 再建 abort signal：clientSignal 绑在 req 的 close/aborted 上，
         先建再读的话，请求体读完触发 close 会立刻把本轮当"用户停止"取消掉（真实踩到）。 */
      const body = await readBody(req);
      const sig = clientSignal(req);
      let message = String(body.message || '').trim().slice(0, 30000);
      const hasImgs0 = Array.isArray(body.images) && body.images.some(x => /^data:image\//.test(String(x || '')));
      if (!message && hasImgs0) message = '请看我发的图片。';
      if (!message) { send({ error: '请先输入内容' }); send({ done: true, reply: '', applied: [], errors: ['请先输入内容'], trace: [], goal: null }); res.end(); return; }
      const sid = Number(session.id) || 0;
      const model = session.model || currentModel();
      const images = sanitizeChatImages(body.images);
      const imageThumbs = sanitizeChatThumbs(body.image_thumbs);
      db.prepare('INSERT INTO chats (goal_id, session_id, role, content, images, created_at) VALUES (?,?,?,?,?,?)').run(0, sid, 'user', message, JSON.stringify(imageThumbs), nowISO());
      if (!session.title || session.title === '新对话') {
        const at = message.replace(/\s+/g, ' ').trim().slice(0, 24);
        if (at) { db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(at, nowISO(), sid); send({ sessionTitle: at }); }
      }
      /* 图片策略同目标对话：明确能识图就直接发；否则用设置里的识图模型识别后再回答。 */
      const visionFallback = images.length ? visionFallbackFor(model) : '';
      const knownVision = images.length ? modelKnownVision(model) : false;
      let imageRecognition = '';
      let sendImages = images;
      if (images.length && !knownVision) {
        if (visionFallback) {
          send({ status: '正在用识图模型「' + visionFallback + '」识别图片…' });
          const rec = await recognizeImagesWith(images, visionFallback, sig);
          if (rec && rec.text) {
            imageRecognition = rec.text;
            sendImages = [];
            pushStep({ kind: 'ctx', label: '用识图模型「' + visionFallback + '」识别了 ' + images.length + ' 张图片', detail: imageRecognition.length + ' 字' });
          } else {
            const why = '⚠️ 当前模型不能识图，设置里的识图模型「' + visionFallback + '」也没识别成功：' + String((rec && rec.error) || '未知错误')
              + String.fromCharCode(10, 10) + '可以检查「设置 → AI 接入方式」里的识图模型配置，或换一个支持多模态的模型再发。';
            send({ status: '识图失败' }); send({ text: why }); send({ reply: why });
            const insF = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
              .run(0, sid, 'assistant', why, '[]', 0, JSON.stringify(trace), nowISO());
            if (sid) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sid);
            backup();
            send({ done: true, id: Number(insF.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace: trace, goal: null });
            res.end(); return;
          }
        } else if (!modelSupportsVision(model)) {
          const why = visionRejectText(model);
          send({ status: '当前模型不支持识别图片' });
          send({ text: why });
          send({ reply: why });
          const ins2 = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(0, sid, 'assistant', why, '[]', 0, JSON.stringify([{ kind: 'ctx', label: '图片识别', detail: '当前模型不支持' }]), nowISO());
          if (sid) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sid);
          backup();
          send({ done: true, id: Number(ins2.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace: [], goal: null });
          res.end();
          return;
        }
      }
      const baseLines = [];
      baseLines.push('你是思而行（SiErXing）的全局 AI 助手：**能读全站**——所有目标与路线图、达成条件、资料库、教程、产出库、AI 任务、组件管理、界面插件、设置，以及用户当前页面的文字。');
      baseLines.push('当前是「未绑定具体目标」的全局对话：**只读**。不要输出 ops，不要声称已经修改、删除或新增了任何数据；需要改动时告诉用户去哪个页面操作。');
      baseLines.push('');
      baseLines.push(globalOverviewBlock());
      pushStep({ kind: 'ctx', label: '全站目标与资源概览', detail: '目标/资料/条件/教程/组件' });
      try {
        const rawPage = pageContext.sanitizePageContext(body.page_context || body.page || null);
        if (rawPage) {
          const block = pageContext.pageContextBlockFrom(rawPage);
          if (block) { baseLines.push(''); baseLines.push(block.text); pushStep({ kind: 'ctx', label: '你当前页面上的内容', detail: '「' + block.label + '」' + block.chars + ' 字' }); }
        }
      } catch (e) {}
      baseLines.push('');
      baseLines.push('【用户的新消息】' + message);
      if (imageRecognition) {
        baseLines.push('');
        baseLines.push(imageRecognitionBlock(imageRecognition, visionFallback));
      } else if (sendImages.length) {
        baseLines.push('');
        baseLines.push('【用户这次还发了 ' + sendImages.length + ' 张图片】它们是随这条消息一起发来的图片输入，请结合图片内容回答（关键文字/布局/数字要说到）。');
        pushStep({ kind: 'ctx', label: '你发来的 ' + sendImages.length + ' 张图片', detail: '已随消息一起交给模型' });
      }
      baseLines.push('');
      baseLines.push(globalToolCatalogText());
      baseLines.push('');
      baseLines.push('【回答要求】');
      baseLines.push('1. **先判断需不需要查站内具体数据**：需要就按上面的方式**只输出 tool 块**（不要带正文），拿到数据后再回答；不需要就直接回答。');
      baseLines.push('2. 引用目标/资料/教程时写清 id 与标题；设置、组件、界面插件、AI 任务、产出库等按查到的实际字段回答，不要用猜测填空。');
      baseLines.push('3. 用户想改内容时：告诉用户去哪个页面/目标操作（例如「打开目标 #166 → 达成条件页，用『✨ 重新梳理条件』」），不要假装已改。');
      baseLines.push('4. 默认 500 字以内，除非用户要求详细；查不到就说查不到，不要编造。');
      const SEP = String.fromCharCode(10);
      const basePrompt = baseLines.join(SEP);
      let prompt = basePrompt + SEP + SEP + '【开始】如果需要站内具体数据，先输出 tool 块；不需要就直接回答。';
      let text = '';
      const MAX_ROUNDS = 3;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        send({ status: round === 0 ? '正在思考…' : '正在查阅站内数据…' });
        let acc = '';
        const full = await ai.text({
          prompt: prompt, model: model || currentModel(), images: sendImages.length ? sendImages : undefined,
          timeoutMs: 420000, signal: sig, scene: '助手对话-全局',
          onEvent: ev => { if (ev.text) acc += ev.text; else if (ev.thinking) send({ thinking: summarizeThinking(ev.thinking) }); }
        });
        const raw = String(acc || full || '');
        const calls = round < MAX_ROUNDS - 1 ? parseGlobalToolCalls(raw) : [];
        if (!calls.length) { text = stripGlobalToolFences(raw); break; }
        const results = [];
        for (const c of calls.slice(0, 6)) {
          const r = globalToolRun(c.tool, c.args || {});
          results.push(r);
          pushStep({ kind: 'ctx', label: '查了「' + globalToolLabel(r.tool) + '」', detail: r.ok ? '' : '失败：' + gClip(r.error, 80) });
        }
        prompt = basePrompt + SEP + SEP + '【你刚才请求的站内数据】' + SEP + globalToolResultsText(results) + SEP + SEP
          + '【接着回答用户】基于以上数据直接回答用户；如果确实还缺关键信息，可以再输出一次 tool 块（这是第 ' + (round + 2) + ' 轮），否则直接给出最终回答。不要重复粘贴数据原文。';
      }
      text = String(stripGlobalToolFences(text || '')).slice(0, 20000) || '（AI 没有输出内容，请重试）';
      send({ text: text });
      send({ reply: text });
      const ins = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(0, sid, 'assistant', text, '[]', 0, JSON.stringify(trace), nowISO());
      if (sid) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sid);
      backup();
      send({ done: true, id: Number(ins.lastInsertRowid), reply: text, applied: [], errors: [], versionId: 0, trace: trace, goal: null });
    } catch (e) {
      if (e && e.cancelled) send({ cancelled: true, status: '已停止（本轮没有改动任何内容）' });
      else {
        let msg = String((e && e.message) || e);
        if (/image|vision|multimodal|content[ _-]?type|unsupported|不支持|无法.*图/i.test(msg)) {
          markVisionUnsupported(session.model || currentModel());
          send({ status: '模型不能识别图片，已记下' });
          const fbNow = visionFallbackFor(session.model || currentModel());
          const why = visionRejectText(session.model || currentModel(), true) + String.fromCharCode(10, 10) + '（上游返回：' + msg.slice(0, 160) + '）'
            + (fbNow ? String.fromCharCode(10, 10) + '再发一次图片会自动改用识图模型「' + fbNow + '」识别后再回答。' : '');
          try {
            const ins2 = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
              .run(0, Number(session.id) || 0, 'assistant', why, '[]', 0, JSON.stringify(trace), nowISO());
            send({ error: why }); send({ done: true, id: Number(ins2.lastInsertRowid), reply: why, applied: [], errors: [], versionId: 0, trace: trace, goal: null });
            res.end();
            return;
          } catch (e2) {}
        }
        try {
          const ins = db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, version_id, trace, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(0, Number(session.id) || 0, 'assistant', '⚠️ 这次没能处理：' + msg, '[]', 0, '[]', nowISO());
          send({ error: msg }); send({ done: true, id: Number(ins.lastInsertRowid), reply: '⚠️ 这次没能处理：' + msg, applied: [], errors: [msg], versionId: 0, trace: trace, goal: null });
        } catch (e2) { send({ error: msg }); }
      }
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
/* ===== Q4 AI 产出通过率 · 质量闸门埋点 =====
   思而行已有两道质量闸门：教程结构体检 tutIntegrity() 与跑题守卫 topicDrifted()。
   它们的判定逻辑早就写好了，但**从不记录命中与否** → 通过率算不出来。
   这里只做"记一行"，**一行判定逻辑都没改**。
   attempts=1 表示首次判定；后续续写救回来的是被拒收后的事，不算"一次通过"。 */
function recordQualityCheck(r) {
  try { metrics.insCheck(r); } catch (e) { /* 埋点失败绝不影响正文 */ }
}

/* 原始判定（逻辑一行未改；埋点在下方同名包装层做） */
function topicDriftedRaw(newHtml, oldHtml, titles) {
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
/* 跑题守卫的埋点包装层。
   判定有 3 个 return 点（正文太短判不了 / 标题太泛判不了 / 没跑题），
   包一层最干净，也不用往判定里插代码。
   drift=null 有两种含义——没跑题，或正文太短/标题太泛判不了；
   后者不该算"跑题"，同样记 passed=1。 */
function topicDrifted(newHtml, oldHtml, titles) {
  const drift = topicDriftedRaw(newHtml, oldHtml, titles);
  recordQualityCheck({
    scene: (global.__tutScene || 'tutorial_edit'), check: 'anchor',
    passed: drift ? 0 : 1, attempts: 1,
    issue: drift ? ('疑似跑题，正文找不到：' + String(drift.used || '').slice(0, 100)) : ''
  });
  return drift;
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
/* 逐个围栏配对，找出**最后一个没被闭合**的围栏是什么类型。
   （数 ```viz 出现的个数是判断不出来的：两个开围栏配一个收围栏，
     开围栏个数是偶数、照样通过 —— MCP 那篇就是这么被放过去的。） */
function unclosedFences(txt) {
  const lines = String(txt || '').split('\n');
  let open = null;                       // { mark, lang }
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/);
    if (!m) continue;
    if (!open) { open = { mark: m[1][0], len: m[1].length, lang: String(m[2] || '') }; continue; }
    // 收尾围栏至少要跟开围栏一样长、且同种符号，否则 ``` 会把 ```` 开的块提前关掉
    if (m[1][0] === open.mark && m[1].length >= open.len && !m[2]) open = null;
  }
  if (!open) return { kind: '' };
  const L = String(open.lang || '').toLowerCase();
  if (L === 'viz' || L === 'demo' || L === 'htmlviz') return { kind: '可视化块（```' + L + '）' };
  if (L) return { kind: '代码块（```' + L + '）' };
  return { kind: '代码块（```）' };
}
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
    /* 真正被这个漏洞放过去过：MCP 那篇停在 viz 块中间一句
       `arguments: {role:"AI产品经理", count:`，只写出 2 个章节、8294 字，
       却当成成功写进了库。上面那条只判 soft，下面这条必须能兜住。
       ⚠️ 判断"viz 块有没有闭合"不能只数 ```viz 开头的个数 —— 两个开围栏
       配一个收围栏，开头的个数是偶数、照样通过。要按"逐个围栏配对"来数。 */
    const unclosed = unclosedFences(s);
    if (unclosed.kind) issues.push(unclosed.kind + ' 没有闭合（正文停在了半句话或半个文件上），教程不完整');
  }
  const ok = !issues.length;
  recordQualityCheck({
    scene: (global.__tutScene || 'tutorial_gen'), check: 'integrity',
    passed: ok, attempts: 1, issue: issues.slice(0, 2).join('；')
  });
  return { ok, issues, soft, missingAnchors };
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
  /* 只在「开头围栏是无语言 / md / markdown / text」时才拆包 —— 那才是模型把整篇
     包了一层。若开头是 ```viz，它和结尾的 ``` 只是"第一个可视化块的开 + 最后一个
     块的闭"，按老写法会把中间整段正文剥掉（正文直接少一大截）。 */
  const m = s.match(/^```(?:md|markdown|text|plain)?\n([\s\S]*?)\n```$/i);
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
/* 「AI 拆分」的重试：以前它没有重试闭包，任务卡住/失败后卡片上**连个重试按钮都没有**，
   用户只能把那段很长的意见再打一遍（最容易出错的地方）。这里照教程那条做法补上。 */
function expandRetry(node, feedback) {
  return async () => {
    const nid = node && node.id ? Number(node.id) : 0;
    if (!nid) return 0;
    await localSelfPost('/api/nodes/' + nid + '/expand', { feedback: feedback || '' });
    return 0;
  };
}
/* ===== 分节式教程生成：外层规划 → 内层逐节 → Reflection 定向补写 =====
   任何一步出问题（规划解析不出、大面积截断、Reflection 一直不合格）都返回空串，
   由调用方退回单次生成 —— 最坏情况和改造前一样，不会更差。 */
async function generateTutorialByPlan({ goal, node, note, codeBlock, model, send, aiText, budget, checkStop }) {
  const TP = tutPlan;
  const title = String(node.title || '').trim().slice(0, 120);
  /* 步间取消检查。之前这里一个都没有：aiText 连 signal 都没往下传，于是点"停止"
     只掐掉当前那一次请求，规划照样跑完、剩下几节照样写、自检照样查、
     最后照样把整篇写进库（实测：取消后还打了 8 次 AI 调用、10.6 秒后才结束）。
     每一"步"开始前查一次，取消就抛 cancelled 一路退出，绝不吞。 */
  const stop = () => { if (typeof checkStop === 'function') checkStop(); };

  /* ---------- 进度上报 ----------
     进度条要"让人感觉在推进"，就得有真实百分比而不是一个转圈的图标。
     下面把整件事切成 5 个阶段，权重按实际耗时给（逐节占大头）。
     STEPS 是阶段清单，前端把它渲染成一排步骤点，当前那个转圈、做过的打勾。 */
  const STEPS = [
    { key: 'load', label: '载入资料' },
    { key: 'plan', label: '规划大纲' },
    { key: 'write', label: '逐节撰写' },
    { key: 'review', label: '自检补全' },
    { key: 'save', label: '保存入库' }
  ];
  let curKey = '';
  let thinkTail = '';
  let thinkTimer = 0;
  const stepsNow = () => STEPS.map(s => ({
    key: s.key, label: s.label,
    state: s.key === curKey ? 'active' : (STEPS.findIndex(x => x.key === s.key) < STEPS.findIndex(x => x.key === curKey) ? 'done' : 'pending'),
    detail: s.detail || ''
  }));
  const emit = (pct, msg, detail, eta) => {
    if (detail != null) {
      const s = STEPS.find(x => x.key === curKey);
      if (s) s.detail = String(detail).slice(0, 80);
    }
    try { send({ status: msg, pct, steps: stepsNow(), thinking: thinkTail, eta: eta || '' }); } catch (e) {}
  };
  const phase = (key, pct, msg) => { curKey = key; emit(pct, msg); };
  /* 模型流式输出的尾巴：直接显示给人看"它现在在写什么/想什么"。
     节流到 1.2 秒一次 —— 每来一个 token 就推一次会把 SSE 和设备都打满。 */
  const onStream = ev => {
    if (!ev) return;
    const piece = ev.thinking || ev.text || '';
    if (!piece) return;
    thinkTail = String(piece).replace(/\s+/g, ' ').slice(-150);
    const now = Date.now();
    if (now - thinkTimer < 1200) return;
    thinkTimer = now;
    try { send({ status: null, steps: stepsNow(), thinking: thinkTail }); } catch (e) {}
  };
  const say = (s, d) => { try { if (d != null) { const st = STEPS.find(x => x.key === curKey); if (st) st.detail = String(d).slice(0, 80); } send({ status: s, steps: stepsNow(), thinking: thinkTail }); } catch (e) {} };

  const P = { plan: 6, write: 82, review: 93 };   // 三个阶段各自的完成百分比上限
  const pctOf = (from, to, i, n) => Math.round(from + (to - from) * (n ? i / n : 1));

  /* ---------- 1) 外层：规划 ---------- */
  let plan = null;
  stop();
  try {
    phase('plan', P.plan - 4, '正在规划教程大纲（先定要讲哪几节）…');
    plan = TP.parsePlan(await aiText(TP.buildPlanPrompt(goal, node, note, codeBlock, budget), onStream));
  } catch (e) {
    /* ⚠️ 取消不能在这里被吞掉：以前吞掉后 return '' 会让调用方**退回单次生成**，
       等于用户点了停止，系统反而又起一次几分钟的全文生成，最后照样写库。 */
    if (e && (e.cancelled || e.name === 'AbortError')) throw e;
    console.log('[tutorial] 规划失败，退回单次生成：', e.message);
    return '';
  }
  stop();
  if (!plan) { console.log('[tutorial] 大纲解析不出，退回单次生成'); return ''; }
  console.log('[tutorial] 规划出 ' + plan.length + ' 节：' + plan.map(s => s.title + (s.viz ? '(viz)' : '')).join(' / '));
  emit(P.plan, '大纲已定：共 ' + plan.length + ' 节', plan.map(s => s.title).join(' / ').slice(0, 78));

  /* ---------- 2) 内层：逐节生成（并行） ----------
     一开始是一节一节串着跑的，实测 9 节 × 每节 50~70 秒 = 十几分钟，
     用户看着进度条挪一格要等一分钟，体感就是卡死。而每一节其实**互不依赖**：
     提示词里已经有全文大纲、本节目标、上一节/下一节的标题，够写出一节连贯的内容了。
     所以改成并发 3 路（跟任务队列的上限一致，不额外抢额度）。
     代价是拿不到"上一节的结尾"做衔接，所以改成把相邻两节的标题显式给它。 */
  const CONC = 3;
  const parts = new Array(plan.length).fill(null);
  const badSet = new Set();
  const t0 = Date.now();
  let doneN = 0, secMs = [];
  const etaText = () => {
    if (!secMs.length) return '';
    const avg = secMs.reduce((a, b) => a + b, 0) / secMs.length;
    const left = Math.ceil((plan.length - doneN) / CONC) * avg;   // 并发下按批算
    if (left < 15000) return '';
    return '预计还需约 ' + (left < 60000 ? Math.round(left / 1000) + ' 秒' : Math.ceil(left / 60000) + ' 分钟');
  };

  async function genSection(i) {
    stop();
    const sec = plan[i];
    const secT0 = Date.now();
    /* 相邻节标题当衔接锚点。上一节若已写完，顺手把它结尾带上（并行下拿不到就算了，
       大纲本身已经限定了每节的范围，不会因此跑题）。 */
    const prevSec = i > 0 ? plan[i - 1] : null;
    const nextSec = i + 1 < plan.length ? plan[i + 1] : null;
    const prevTail = (i > 0 && parts[i - 1]) ? parts[i - 1].slice(-500) : '';
    let body = '', why = '';
    for (let round = 1; round <= 2; round++) {
      stop();
      let p = TP.buildSectionPrompt(sec, i + 1, plan.length, plan, prevTail, title, codeBlock, { prevSec, nextSec }, budget);
      if (round > 1 && why) p += TP.retryHint(why);
      try {
        body = cleanTutorialText(await aiText(p, onStream), 'md');
      } catch (e) {
        /* 取消要抛出去，不能 here 当成"这一节没写完"再重写一遍 */
        if (e && (e.cancelled || e.name === 'AbortError')) throw e;
        console.log('[tutorial] 第 ' + (i + 1) + ' 节生成抛错：', e.message);
        body = ''; why = e.message;
      }
      why = TP.sectionTruncated(body);
      if (!why) break;
      console.log('[tutorial] 第 ' + (i + 1) + ' 节疑似截断：' + why);
      if (round < 2) emit(null, '第 ' + (i + 1) + ' 节没写完，正在重写…', '重写第 ' + (i + 1) + ' 节');
    }
    if (why) {
      /* 两轮都没过：仍然收下，但把没收尾的围栏补上（文档结构必须合法），
         同时记一笔交给 Reflection 阶段定向补写 —— 直接丢掉整节会造成
         "目录有、正文没有"，比内容略糙更刺眼。 */
      console.log('[tutorial] 第 ' + (i + 1) + ' 节两轮未通过体检（' + why + '），补齐围栏后保留并交给 Reflection');
      body = TP.closeFences(body);
      badSet.add(i);
    }
    parts[i] = TP.normalizeSectionBody(body || '', sec.title);
    secMs.push(Date.now() - secT0);
    doneN++;
    const pct = pctOf(P.plan, P.write, doneN, plan.length);
    const stepsNowDone = Math.min(plan.length, doneN + (CONC - 1 - Math.min(CONC - 1, plan.length - doneN)));
    emit(pct, '已完成 ' + doneN + '/' + plan.length + ' 节（并行 ' + Math.min(CONC, plan.length) + ' 路）'
      + (etaText() ? ' · ' + etaText() : ''),
      '已完成 ' + doneN + '/' + plan.length + ' 节', etaText());
    console.log('[tutorial] 第 ' + (i + 1) + '/' + plan.length + ' 节完成（' + Math.round((Date.now() - secT0) / 1000) + 's，累计 ' + doneN + ' 节）');
  }

  curKey = 'write';
  emit(P.plan, '正在并行撰写 ' + plan.length + ' 节内容（' + Math.min(CONC, plan.length) + ' 路同时写，预计 2~4 分钟）…',
    '共 ' + plan.length + ' 节');
  /* 并发执行：用递增游标让先完成的 worker 接着领下一节，避免固定分片导致长尾 */
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, plan.length) }, () => (async () => {
    for (;;) {
      const i = cursor++;
      if (i >= plan.length) return;
      await genSection(i);
    }
  })()));
  stop();
  let bad = badSet.size;
  if (!parts.filter(Boolean).join('\n\n').length) return '';
  console.log('[tutorial] 逐节生成结束，总耗时 ' + Math.round((Date.now() - t0) / 1000) + 's / ' + plan.length + ' 节');

  let txt = '# ' + title + '\n\n' + parts.filter(Boolean).join('\n\n');

  /* ---------- 3) Reflection：对着大纲核对，定向补写 ---------- */
  curKey = 'review';
  for (let pass = 1; pass <= 2; pass++) {
    stop();
    const gaps = plan.filter(s => !TP.sectionPresent(txt, s.title)).map(s => s.title);
    let review = null;
    emit(P.write + (pass - 1) * 5, '正在自检教程完整性（Reflection 第 ' + pass + ' 轮）…', '第 ' + pass + ' 轮自检');
    try {
      review = TP.parseReview(await aiText(TP.buildReviewPrompt(title, plan, txt), onStream));
    } catch (e) {
      if (e && (e.cancelled || e.name === 'AbortError')) throw e;
      console.log('[tutorial] 自检抛错：', e.message);
    }
    const claim = TP.verifyReviewClaims(txt, plan, review);
    const miss = gaps.concat(claim.missing).filter((v, i, a) => a.indexOf(v) === i);
    const vizBad = claim.vizBad;
    const fenceBad = claim.fenceOpen;
    if (!miss.length && !vizBad.length && !fenceBad && !bad) {
      console.log('[tutorial] 自检通过（第 ' + pass + ' 轮）');
      break;
    }
    const whyList = []
      .concat(miss.length ? ['缺/未完成：' + miss.slice(0, 4).join('、')] : [])
      .concat(vizBad.length ? ['可视化有问题：' + vizBad.slice(0, 3).join('、')] : [])
      .concat(fenceBad ? ['有围栏没闭合'] : []);
    console.log('[tutorial] 自检发现问题：' + whyList.join('；'));
    if (pass >= 2) { console.log('[tutorial] 补写 2 轮后仍有缺口，保留现状交由后续人工判断'); break; }
    const want = (miss.length ? miss : vizBad).slice(0, 4);
    let add = '';
    try {
      stop();
      emit(P.write + 4, '正在补写缺失的章节：' + want.slice(0, 3).join('、') + '…', '补写 ' + want.length + ' 节');
      add = cleanTutorialText(await aiText(TP.buildFillPrompt(plan, want, title, txt), onStream), 'md');
    } catch (e) {
      if (e && (e.cancelled || e.name === 'AbortError')) throw e;
      console.log('[tutorial] 补写抛错：', e.message);
    }
    if (!add || add.length < 150) { console.log('[tutorial] 补写没产出可用内容，停止'); break; }
    /* 补写回来的是 Markdown 文本，可能一次写了好几节，其中有的其实已经有了。
       两层过滤：
       ① 正文里已经有的（按标题模糊匹配）→ 丢掉，否则整段重复
          （真实翻过：正文里已有 1 万字的《延伸学习》，补写又插了一份）；
       ② 我们没要的节 → **降级成三级标题**留在正文里，不让它占一个二级章节。
          真实翻过：一次补写塞进「## 何时使用 / ## 一、等价物 / ## 先判断」等
          八个计划外标题，二级章节从 7 个变成 15 个，整篇大纲被冲散。
          内容不丢，但大纲必须还是计划的那几条。 */
    const addSecs = TP.splitSections(add);
    const wanted = t => want.some(w => TP.sectionPresent(t, w) || TP.sectionPresent(w, t));
    const fresh = addSecs.filter(s => s.title && !TP.sectionPresent(txt, s.title) && wanted(s.title));
    const demote = addSecs.filter(s => s.title && !TP.sectionPresent(txt, s.title) && !wanted(s.title));
    const dropped = addSecs.length - fresh.length - demote.length;
    if (dropped) console.log('[tutorial] 补写内容里有 ' + dropped + ' 节正文里已经有了，丢弃');
    if (demote.length) console.log('[tutorial] 补写内容里有 ' + demote.length + ' 个计划外标题，降为三级标题保留内容：' + demote.map(s => s.title).join(' / '));
    const demoted = demote.map(s => s.text.replace(/^##(?=[^#])/m, '###')).join('\n\n');
    if (!fresh.length && !demoted) { console.log('[tutorial] 补写内容全都重复，停止'); break; }
    const addText = [fresh.map(s => s.text).join('\n\n'), demoted].filter(Boolean).join('\n\n');
    txt = txt + '\n\n' + addText;
    console.log('[tutorial] 补写并入 ' + fresh.length + ' 节' + (demote.length ? '（另有 ' + demote.length + ' 个标题降级）' : '')
      + (fresh.length ? '：' + fresh.map(s => s.title).join(' / ') : ''));
    bad = 0;
  }
  emit(P.review, '自检完成，共 ' + plan.length + ' 节', plan.length + ' 节全部到位');

  /* 最后一道机械闸：分节拼接理论上不会出现奇数围栏，真出现就别交付半成品。 */
  stop();
  const fin = tutIntegrity(txt, 'md');
  if (!fin.ok) {
    console.log('[tutorial] 分节生成结果仍有问题：' + fin.issues.join('；') + ' —— 退回单次生成');
    return '';
  }
  curKey = 'save';
  console.log('[tutorial] 分节生成完成：' + plan.length + ' 节 / ' + txt.length + ' 字');
  return { text: txt, steps: stepsNow(), count: plan.length };
}

/* 教程默认标题 = 节点名 + 生成时间。
   同一个节点可以生成多份（改意见重跑、换个篇幅再生成），以前标题就是节点名，
   几份完全同名，用户分不清哪份是哪份（2026-10-13 报的）。
   时间取到分钟就够短、够区分；同一分钟内再生成则补秒，仍撞上加序号。
   只影响 tutorials.title，不动节点标题、不动正文。 */
function tutorialDefaultTitle(node, when) {
  const d = when ? new Date(when) : new Date();
  const p2 = n => String(n).padStart(2, '0');
  const base = String((node && node.title) || '教程').trim().slice(0, 80) || '教程';
  const hm = p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  const mk = suffix => (base + '（' + hm + suffix + '）').slice(0, 120);
  const taken = t => !!db.prepare('SELECT id FROM tutorials WHERE node_id = ? AND title = ?').get(node ? node.id : 0, t);
  let title = mk('');
  if (taken(title)) title = mk(':' + p2(d.getSeconds()));
  for (let i = 2; taken(title); i++) title = mk(':' + p2(d.getSeconds()) + ' #' + i);
  return title;
}
function streamTutorial(req, res, node, format, note, codeFiles, withFolders, folderFiles) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const model = currentModel();
  const tk = tasks.begin({ type: 'tutorial', title: '生成教程：' + (node ? node.title : ''), goalId: node ? node.goal_id : 0, nodeId: node ? node.id : 0, note: note || '', retry: tutGenRetry(node, format, note, codeFiles, withFolders, folderFiles) });
  /* 取消的**唯一判据**是 tk.signal（用户点停止 → tasks.cancel → abort）。
     ⚠️ 以前这里每一步 AI 调用都把 signal 写成 null，等于教程生成**完全无法取消**：
     abort 掐不掉任何请求，规划/逐节/自检/补写一路跑完，最后还照样 INSERT 进库。
     现在：signal 一路传下去（aiText / 源码挑选 / 续写补齐），每步之间 checkStop()。 */
  const signal = tk.signal;
  const checkStop = () => { if (signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
  /* SSE 响应是"一次性输出"：重试发回来的这份没人读，所以显式说明一下，
     免得后来看日志的人以为前端断流了。 */
    /* obj 里的 pct / steps / thinking 一并转给任务中心 —— 前端据此画动效进度条。
       以前只转 status，于是分节生成跑到第 5/9 节时进度条还停在 0%。 */
    const send = obj => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
      /* 只报了"我在想什么"（status 为空）也要转给任务中心 ——
         不过滤的话实时思考文本根本刷不上去。 */
      if (obj && (obj.status || obj.thinking != null || obj.steps)) {
        tk.progress(obj.pct, obj.status, { steps: obj.steps, thinking: obj.thinking, eta: obj.eta });
      }
    };
  (async () => {
    try {
      checkStop();
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
            budget: room, skipRoots: pickedRoots, send, signal
          });
          if (auto.list.length) {
            codeBlock += (codeBlock ? '\n\n' : '') + auto.block;
            for (const f of auto.list) codeList.push({ root: f.root, path: f.path });
            send({ status: `已载入文件夹资料 ${auto.list.length} 个文件作为讲解依据…` });
          }
        } catch (e) {
          if (e && (e.cancelled || e.name === 'AbortError')) throw e;
          console.log('[tutorial] 文件夹资料载入失败:', e.message);
        }
      }
      /* ===== 生成：外层规划 → 内层逐节 → Reflection 体检 ===== */
      global.__tutScene = 'tutorial_gen';
      /* ---------- 先判断这份教程该花多大力气 ----------
         不分青红皂白就上「规划 → 7 节 → 自检」，代价是 3 分钟和 6 万字：
         一个 1 小时的小任务根本不需要那么长，用户也看不完。
         启发式只决定走哪条流程；判断偏了最多是慢一点/啰嗦一点，不会丢内容。 */
      const bud = effort.tutorialEffort(node);
      console.log('[tutorial] 复杂度判断：' + bud.mode + ' / 目标约 ' + bud.target + ' 字'
        + (bud.mode === 'plan' ? ' / ' + bud.sections + ' 节（每节约 ' + bud.perSection + ' 字）' : '')
        + ' ← ' + bud.why);
      let txt = '', planSteps = null;
      if (format === 'md' && bud.mode === 'plan') {
        const byPlan = await generateTutorialByPlan({
          goal, node, note, codeBlock, model, budget: bud,
          send, checkStop,
          aiText: (p, onEvent) => aiText(p, model, 600000, onEvent || null, signal, '教程生成')
        });
        /* 分节生成成功时返回 {text, steps}；失败/不适合时返回空串，退回单次生成。 */
        if (byPlan && byPlan.text) { txt = byPlan.text; planSteps = byPlan.steps; }
      }
      /* md 走分节生成；html 仍是单次（它是一整个页面，分节拼不出一个合法文档）。
         分节生成失败时自动退回单次生成老路。 */
      checkStop();   /* 取消后绝不"退回单次生成"再起一次全文重写 */
      if (!txt) {
        send({ status: `正在撰写「${String(node.title).slice(0, 18)}」的${format === 'html' ? ' HTML ' : ' Markdown '}教程`
          + (bud.mode === 'single' ? `（这是一份${bud.hours ? bud.hours + ' 小时' : '篇幅不大'}的教程，约需 30~60 秒）…` : '（讲原理、分步实践、练习与自测，约需 1-3 分钟）…'), pct: 10 });
        let prompt;
        if (promptPacks.hasOverride('tutorial.generate')) {
          const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '任务';
          const topicLines = ['【教程主题（' + levelName + '）】' + node.title];
          if (node.detail) topicLines.push('任务说明：' + node.detail);
          if (node.artifact) topicLines.push('应产出的成果：' + node.artifact);
          if (node.acceptance) topicLines.push('验收标准：' + node.acceptance);
          if (node.hours) topicLines.push('预计投入：' + node.hours);
          prompt = await promptPacks.renderAsync('tutorial.generate', {
            goal: goal, node: node, format: format, note: note, codeBlock: codeBlock, budget: bud,
            goalHeader: goalHeader(goal),
            qa: goalQaBlock(goal),
            constraints: constraintsBlock(goal),
            topic: topicLines.join('\n'),
            siblingScope: siblingScopeBlock(goal, node),
            digests: digestsBlock(goal),
            nodeSources: nodeSourcesBlock(goal, node, 1100),
            sourcesIndex: sourcesIndexBlock(goal, 12, '【资料库其它条目（仅索引；与本节无关的一律不读不用，更不要写入教程）】'),
            codeBlock: codeBlock ? String(codeBlock) : '',
            note: note ? '【用户的额外要求（必须满足）】' + note : '',
            budget: tutorialRules.budgetBlock(bud, format),
            formatRules: tutorialRules.formatBlock(format)
          });
        } else {
          prompt = buildTutorialPrompt(goal, node, format, note, codeBlock, bud);
        }
        txt = cleanTutorialText(await aiText(prompt, model, 600000, null, signal, '教程生成'), format);
      }
      if (!txt || txt.length < 200) throw new Error('教程生成失败：AI 只写了 ' + (txt ? txt.length : 0) + ' 字就停了。原教程没动，可以点任务上的「🔄 重试」，或换个输出更长的模型再试');
      /* 体检：结构不完整多半是被输出上限截断（长度够、结构缺）。
         自动续写补齐；补不齐就把问题说清楚 —— 不能把半截教程当成功写进库。 */
      let chk = tutIntegrity(txt, format);
      if (!chk.ok) {
        send({ status: '检测到教程被截断（' + chk.issues[0] + '），正在让 AI 补全…' });
        const fixed = await repairTruncatedText({
          raw: txt, format, title: node.title, issues: chk.issues,
          runText: (p) => aiText(p, model, 600000, null, signal, '教程生成')
        });
        txt = fixed.text; chk = tutIntegrity(txt, format);
        if (!chk.ok) {
          const hard = endsMidway(txt, format);
          throw new Error('教程没能写完整（已自动续写 2 次仍不完整）：' + chk.issues.join('；')
            + (hard ? '。原因：' + hard + ' —— 换 deepseek-chat / deepseek-reasoner 等输出上限更高的模型，或把篇幅要求调小一点' : '')
            + '。教程未保存，点任务上的「🔄 重试」可原样重跑');
        }
      }
      /* ⚠️ 落库前最后一道闸：用户点了停止就一个字节都不许写。
         改之前最刺眼的一种：取消后整篇照样生成完，教程被 INSERT 进库 ——
         用户以为"停止了"，刷新一看多了一篇新教程。 */
      checkStop();
      const t = nowISO();
      const title = tutorialDefaultTitle(node, t);
      /* 保存阶段也要报进度：写完全文到落库之间还有备份等动作，
         不报的话进度条会卡在 93% 好一会儿，看着像卡死了。 */
      send({
        status: '正在保存教程…', pct: 97,
        steps: (planSteps || []).map(s => ({ key: s.key, label: s.label, state: s.key === 'save' ? 'active' : 'done', detail: s.detail }))
      });
      const r = db.prepare('INSERT INTO tutorials (goal_id, node_id, title, format, content, code_files, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(goal.id, node.id, title, format, txt, JSON.stringify(codeList), t, t);
      const tid = Number(r.lastInsertRowid);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
      backup();
      send({ done: true, pct: 100, tutorial: { id: tid, node_id: node.id, title, format, created_at: t, chars: txt.length }, goal: getGoal(goal.id) });
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
  return tk;
}

/* 命令总线/Agent 用：不挂 SSE，后台启动教程生成，返回任务 id。
   复用 streamTutorial：给一个不写网络的假 res，任务照常进任务中心。 */
function startTutorialGeneration(nodeId, opts) {
  const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeId));
  if (!n) throw pipelineError('not_found', '节点不存在：' + nodeId);
  if (!goalCompOn(n.goal_id, 'tutorial')) throw pipelineError('forbidden', '「学习教程」组件在这个目标上已关闭');
  const o = opts || {};
  const format = o.format === 'html' ? 'html' : 'md';
  const note = String(o.note || '').slice(0, 500);
  const codeFiles = Array.isArray(o.codeFiles)
    ? o.codeFiles.filter(function (x) { return typeof x === 'string'; }).map(function (s) { return s.slice(0, 160); }).slice(0, 24)
    : [];
  const fakeRes = { writeHead: function () {}, write: function () {}, end: function () {} };
  const fakeReq = {};
  const tk = streamTutorial(fakeReq, fakeRes, n, format, note, codeFiles, false, []);
  return { taskId: tk.id, nodeId: n.id, goalId: n.goal_id, format: format, title: '生成教程：' + String(n.title || '') };
}

/* 命令总线/Agent 用：调本机现有的教程修改接口（它同步返回 taskId，不挂 SSE）。
   教程结构守卫、版本快照、任务中心都在原路径里，命令侧不复制。 */
async function startTutorialEditTask(tid, feedback, opts) {
  const id = Number(tid);
  const t = db.prepare('SELECT id,goal_id,title FROM tutorials WHERE id = ?').get(id);
  if (!t) throw pipelineError('not_found', '教程不存在：' + id);
  const fb = String(feedback || '').trim().slice(0, 1500);
  if (!fb) throw pipelineError('bad_input', '请填写修改意见');
  if (!goalCompOn(t.goal_id, 'tutorial')) throw pipelineError('forbidden', '「学习教程」组件在这个目标上已关闭');
  const body = { feedback: fb, quiet: false, allow_restructure: !!(opts && opts.allowRestructure) };
  let r;
  try {
    r = await fetch('http://127.0.0.1:' + PORT + '/api/tutorials/' + id + '/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch (e) {
    throw pipelineError('upstream_error', '启动教程修改失败：' + (e && e.message ? e.message : e));
  }
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok || !j || !j.ok) throw pipelineError('bad_input', (j && j.error) || ('教程修改启动失败：HTTP ' + r.status));
  return { taskId: j.taskId, tutorialId: id, sessionId: j.sessionId || 0 };
}

/* 资料搜集：HTTP 路由与命令总线共用。SSE 只是显示层；任务句柄由 tasks.begin 管理。 */
function streamCollect(req, res, g) {
  const id = g.id;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    /* 搜集资料要跑好几分钟：把四个阶段声明出来，条才会照着阶段往前走，
       而不是一条不动的走马灯（用户反馈："有的任务有条、有的只有一行字"）。 */
    const tk = tasks.begin({
      type: 'collect', title: '搜集信息源：' + String(g.title || '').slice(0, 30), goalId: id, nodeId: 0, note: '',
      phases: ['搜索候选', '抓取正文', 'AI 把关', '整理入库']
    });
    const sig = tk.signal;   // 只有主动取消才中断；切换/关闭页面不影响后台继续
    /* onProgress 带 `prog: {phase, frac}` 时走阶段推进，只带 status 时退化成"只换文案"
       （阶段内由引擎按时间平滑）—— 两种都能在同一套渲染里画出来。 */
    const tkSend = s => {
      try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch (e) {}
      if (!s) return;
      if (s.prog) tk.phase(s.prog.phase, s.status, { frac: s.prog.frac });
      else if (s.status) tk.progress(undefined, s.status);
    };
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
        try { res.write(`data: ${JSON.stringify({ done: true, count: r.saved, blocked: r.blocked, sources: list, ebooks: ebSummary, stats: r.stats || null })}\n\n`); } catch (e) {}
        rag.autoIndex(id);
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
  return tk;
}

/* 命令总线/Agent 用：后台启动资料搜集，立即返回 taskId。 */
function startSourceCollect(goalId) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(goalId));
  if (!g) throw pipelineError('not_found', '目标不存在：' + goalId);
  if (!goalCompOn(g.id, 'sources')) throw pipelineError('forbidden', '「信息源检索」组件在这个目标上已关闭');
  const fakeRes = { writeHead: function () {}, write: function () {}, end: function () {} };
  const tk = streamCollect({}, fakeRes, g);
  return { taskId: tk.id, goalId: g.id, title: '搜集信息源：' + String(g.title || '') };
}

/* 命令总线/Agent 用：后台启动资料提炼，立即返回 taskId。 */
function startSourceDigest(goalId) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(goalId));
  if (!g) throw pipelineError('not_found', '目标不存在：' + goalId);
  if (!goalCompOn(g.id, 'sources')) throw pipelineError('forbidden', '「信息源检索」组件在这个目标上已关闭');
  const fakeRes = { writeHead: function () {}, write: function () {}, end: function () {} };
  const tk = streamDigest({}, fakeRes, g);
  return { taskId: tk.id, goalId: g.id, title: '资料提炼：' + String(g.title || '') };
}

/* 资料提炼：HTTP 路由与命令总线共用；任务句柄由 tasks.begin 管理。 */
function streamDigest(req, res, g) {
  const id = g.id;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const tk = tasks.begin({ type: 'digest', title: '资料提炼：' + String(g.title || '').slice(0, 30), goalId: g.id, phases: ['通读资料', '主题汇总', '入库'] });
    const sig = tk.signal;
    const send = obj => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
      if (!obj) return;
      if (obj.progress && obj.progress.total) tk.count(obj.progress.done || 0, obj.progress.total, obj.status);
      else if (obj.status) tk.progress(undefined, obj.status);
    };
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
            const batch = info.batches[my];
            const items = batch.map(function (it) { return '## ' + it.label + '\n' + it.body; }).join('\n');
            const txt = await aiText(promptPacks.render('sources.digest_batch', { batch: batch, batchNo: my + 1, total: info.batches.length, items: items }), model, 300000, null, sig, '代码库摘要');
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
        const partsText = parts.map(function (p) { return '### 第 ' + p.idx + ' 批\n' + JSON.stringify(p.data); }).join('\n');
        const syn = await aiText(promptPacks.render('sources.digest_synthesis', { partsArr: parts, total: info.total, ownCount: info.ownCount, netCount: info.netCount, parts: partsText }), model, 600000, null, sig, '代码库综合');
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
        tk.done({ count: digestsOf(g.id).length });
      } catch (e) {
        tk.fail(e);
        if (e && e.cancelled) send({ cancelled: true, status: '已停止提炼' });
        else send({ error: '资料提炼失败：' + e.message });
      }
      res.end();
    })();
  return tk;
}

/* 命令总线/Agent 用：后台启动规划生成，立即返回 taskId；问卷分支会在任务结果里带 questions。 */
function startGoalPlan(goalId, answers) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(goalId));
  if (!g) throw pipelineError('not_found', '目标不存在：' + goalId);
  if (String(g.status || '') === 'archived') throw pipelineError('bad_input', '归档目标不能生成规划');
  const fakeRes = { writeHead: function () {}, write: function () {}, end: function () {} };
  const a = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : null;
  const tk = streamPlan({}, fakeRes, g, a);
  return { taskId: tk.id, goalId: g.id, title: '生成规划：' + String(g.title || '') };
}

/* ===== HTTP ===== */
async function handleAPI(req, res, u) {
  const p = u.pathname, method = req.method;

  if (p === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true, app: APP_NAME });

  /* ---------- 界面语言（i18n） ----------
     GET  /api/language/state        当前语言 + 可用语言列表（内置 + AI 生成的）
     GET  /api/language/pack.js      字典（注入到入口页面，必须在 app.js 之前加载）
     POST /api/language/active       切换界面语言（写 settings.app_language，''=跟随浏览器）
     POST /api/language/generate     输入任意语言名 → AI 翻译整套界面语言包（后台任务）
     POST /api/language/delete       删除 AI 生成的语言包 */
  if (p === '/api/language/state' && method === 'GET') {
    return sendJSON(res, 200, language.state(req.headers['accept-language']));
  }
  if (p === '/api/language/pack.js' && method === 'GET') {
    const wanted = String(u.searchParams.get('code') || '');
    const code = (wanted && language.pack(wanted)) ? language.normalizeCode(wanted) : language.active(req.headers['accept-language']);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(language.packJs(code));
  }
  if (p === '/api/language/active' && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    const r = language.setActive(body && body.code);
    if (!r.ok) return sendJSON(res, 400, r);
    return sendJSON(res, 200, r);
  }
  if (p === '/api/language/generate' && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    const name = String((body && body.name) || '').trim();
    if (!name) return sendJSON(res, 400, { ok: false, error: '请先输入语言名称（例如：日本語 / Français）' });
    if (name.length > 60) return sendJSON(res, 400, { ok: false, error: '语言名称太长（最多 60 个字符）' });
    const preset = language.catalogFind(name);
    if (!currentModel()) {
      return sendJSON(res, 400, { ok: false, error: '还没有配置 AI 模型：请先在「设置 → AI 接入方式」里加一个连接，再回来生成语言。' });
    }
    const tk = tasks.submit({
      type: 'language',
      title: '生成界面语言：' + name.slice(0, 40),
      phases: ['识别语言', '翻译界面文案', '校验并保存'],
      expectedMs: 150000,
      run: function (kit) {
        return languageGenerator.generate({
          name: name,
          preset: preset,
          signal: kit.signal,
          progress: function (o) {
            const msg = o && o.msg ? o.msg : '';
            if (o && o.count) kit.count(o.count.done, o.count.total, msg);
            else if (o && o.phase != null) kit.phase(o.phase, msg);
            else if (msg) kit.progress(null, msg);
          }
        });
      }
    });
    return sendJSON(res, 200, { ok: true, taskId: tk, name: name });
  }
  if (p === '/api/language/delete' && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    const r = language.removeGenerated(body && body.code);
    if (!r.ok) return sendJSON(res, 400, r);
    return sendJSON(res, 200, r);
  }

  /* ---------- 内核自检（P1）：服务清单 + 插件装载状态 + 为什么被跳过 ---------- */
  if (p === '/api/kernel' && method === 'GET') {
    const st = kernelState(PLUGIN_DIR);
    return sendJSON(res, 200, Object.assign({
      ok: true, app: APP_NAME, node: process.version, pid: process.pid,
      appDir: APP_DIR, dataDir: DATA_DIR
    }, st, { config: kernelConfig ? kernelConfig.state() : null }));
  }

  /* ---------- UI 插件（内置 + 用户覆盖 + 启停状态，P2） ---------- */
  if (p === '/api/ui/plugins' && method === 'GET') {
    return sendJSON(res, 200, {
      apiVersion: uiPlugins.apiVersion,
      plugins: uiPlugins.listAll(),
      userDir: uiPlugins.dir,
      builtinDir: uiPlugins.builtinDir
    });
  }
  /* 启停用户页面插件：停用 = 该页回退内置界面（不删文件、随时可恢复） */
  const uiStateMatch = p.match(/^\/api\/ui\/plugins\/([^/]+)\/state$/);
  if (uiStateMatch && method === 'POST') {
    let id = '';
    try { id = decodeURIComponent(uiStateMatch[1]); } catch (e) { id = ''; }
    const body = await readBody(req).catch(function () { return {}; });
    const enabled = !(body && body.enabled === false);
    const r = uiPlugins.setEnabled(id, enabled);
    if (!r) return sendJSON(res, 404, { error: '用户 UI 插件不存在：' + id });
    return sendJSON(res, 200, { ok: true, plugin: r });
  }
  /* 打开用户插件目录（本地应用；NO_OPEN 环境下只返回路径，方便测试与远程使用） */
  if (p === '/api/ui/plugins/open-dir' && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    const sid = String((body && body.id) || '');
    const m = sid ? uiPlugins.get(sid) : null;
    const target = (m && m.source === 'user') ? path.join(uiPlugins.dir, m.id) : uiPlugins.dir;
    if (process.env.NO_OPEN) return sendJSON(res, 200, { ok: false, reason: 'NO_OPEN', dir: target });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [target], { detached: true, stdio: 'ignore', env: guiEnv() }).unref();
      return sendJSON(res, 200, { ok: true, dir: target });
    } catch (e) { return sendJSON(res, 500, { ok: false, dir: target, error: '打不开目录：' + e.message }); }
  }
  /* ---------- 创造模式：AI 生成 → 暂存 → 用户确认后安装 ----------
     为什么不在生成时直接装：装上去就是**在用户真实界面里跑代码**。仿 DSH 的
     plugin_manager：Agent 只准备 bundle，安装动作由用户点按钮批准。 */
  if (p === '/api/create/meta' && method === 'GET') {
    return sendJSON(res, 200, {
      apiVersion: createMode.apiVersion,
      pages: createMode.PAGES,
      limits: createMode.limitInfo,
      stagingDir: createMode.stagingDir
    });
  }
  /* 测试/调试钩子：不经过 AI，直接把一份 create JSON 走同一套校验 + 暂存。
     只在 SIERXING_CREATE_DEBUG=1 时开放（自动化测试用；正常使用走对话生成）。 */
  if (p === '/api/create/stage' && method === 'POST' && process.env.SIERXING_CREATE_DEBUG === '1') {
    try {
      const body = await readBody(req);
      const artifact = body && body.artifact ? body.artifact : body;
      return sendJSON(res, 200, { ok: true, create: createMode.stage(artifact) });
    } catch (e) {
      return sendJSON(res, 400, { error: (e && e.message) || String(e), code: (e && e.code) || '' });
    }
  }
  const createMatch = p.match(/^\/api\/create\/changes\/([A-Za-z0-9_-]+)(?:\/(install|discard|rollback))?$/);
  if (createMatch) {
    const cid = createMatch[1];
    const action = createMatch[2] || '';
    const errStatus = function (e) {
      const c = e && e.code;
      if (c === 'not_found') return 404;
      if (c === 'conflict') return 409;
      if (c === 'forbidden' || c === 'syntax' || c === 'bad_input' || c === 'too_large') return 400;
      return 500;
    };
    try {
      if (!action && method === 'GET') return sendJSON(res, 200, { change: createMode.readChange(cid) });
      if (action === 'install' && method === 'POST') {
        const body = await readBody(req).catch(function () { return {}; });
        if (!body || body.confirm !== true) {
          return sendJSON(res, 400, { error: '安装需要用户确认（body.confirm = true）' });
        }
        const r = createMode.install(cid);
        try { backup(); } catch (e) {}
        console.log('[create] 已安装 ' + r.kind + '：' + r.id + '（' + r.name + '）');
        return sendJSON(res, 200, r);
      }
      if (action === 'discard' && method === 'POST') return sendJSON(res, 200, createMode.discard(cid));
      if (action === 'rollback' && method === 'POST') {
        const r = createMode.rollback(cid);
        try { backup(); } catch (e) {}
        console.log('[create] 已回滚 ' + r.kind + '：' + r.id);
        return sendJSON(res, 200, r);
      }
      return sendJSON(res, 405, { error: '不支持的方法' });
    } catch (e) {
      return sendJSON(res, errStatus(e), { error: (e && e.message) || String(e), code: (e && e.code) || '' });
    }
  }
  /* ---------- 用户 UI 皮肤：叠加在内置基础皮肤之上，用来「随意改 UI」 ---------- */
  if (p === '/api/ui/skins' && method === 'GET') {
    return sendJSON(res, 200, { skins: uiPlugins.listSkins().map(function (s) { return { id: s.id, name: s.name, priority: s.priority }; }) });
  }
  if (p === '/api/ui/skin.css' && method === 'GET') {
    /* 分层配置可以关掉用户皮肤（kernel：ui.skins=false） */
    if (kernelConfig && kernelConfig.get('ui.skins', true) === false) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end('');
    }
    /* 按 priority 从低到高拼接：后写的覆盖先写的 */
    const all = uiPlugins.listSkins();
    const css = all.map(function (s) { return '/* ' + s.id + ' */\n' + s.css; }).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(css);
  }
  const uiManifestMatch = p.match(/^\/api\/ui\/plugins\/([^/]+)\/manifest$/);
  if (uiManifestMatch && method === 'GET') {
    let id = '';
    try { id = decodeURIComponent(uiManifestMatch[1]); } catch (e) { id = ''; }
    const m = uiPlugins.manifestRaw(id);
    if (!m) return sendJSON(res, 404, { error: 'UI 插件不存在：' + id });
    return sendJSON(res, 200, m);
  }
  const uiEntryMatch = p.match(/^\/api\/ui\/plugins\/([^/]+)\/entry$/);
  if (uiEntryMatch && method === 'GET') {
    let id = '';
    try { id = decodeURIComponent(uiEntryMatch[1]); } catch (e) { id = ''; }
    const e = uiPlugins.readEntry(id);
    if (!e) return sendJSON(res, 404, { error: 'UI 插件入口不存在：' + id });
    try {
      res.writeHead(200, { 'Content-Type': e.contentType, 'Cache-Control': 'no-cache' });
      return res.end(e.body);
    } catch (err) { return; }
  }
  /* ===== 命令总线：CLI / Agent 的能力入口 ===== */
  if (p === '/api/commands' && method === 'GET') {
    return sendJSON(res, 200, {
      commands: commandBus.list({
        category: u.searchParams.get('category') || undefined,
        risk: u.searchParams.get('risk') || undefined,
        query: u.searchParams.get('q') || undefined
      })
    });
  }
  if (p === '/api/commands/manifest' && method === 'GET') {
    return sendJSON(res, 200, commandBus.fullManifest());
  }
  /* 插件 manifest 的稳定入口：独立应用 / CLI / MCP / 技能共用同一份自描述 */
  if (p === '/api/manifest' && method === 'GET') {
    return sendJSON(res, 200, commandBus.fullManifest());
  }
  if (p === '/api/commands/run' && method === 'POST') {
    const body = await readBody(req);
    const name = String((body && body.name) || '').trim();
    try {
      const result = await commandBus.run(name, (body && body.input) || {}, {
        actor: String((body && body.actor) || 'agent:http'),
        approvalId: String((body && body.approvalId) || '')
      });
      return sendJSON(res, 200, { ok: true, result: result });
    } catch (e) {
      const code = (e && e.code) || 'internal';
      const status = code === 'not_found' ? 404 : code === 'approval_required' ? 403 : code === 'bad_input' ? 400 : code === 'forbidden' ? 403 : 500;
      const err = { code: code, message: String((e && e.message) || e) };
      if (e && e.details) err.details = e.details;
      return sendJSON(res, status, { ok: false, error: err });
    }
  }
  const cmdMatch = p.match(/^\/api\/commands\/([^/]+)$/);
  if (cmdMatch && method === 'GET') {
    const d = commandBus.describe(decodeURIComponent(cmdMatch[1]));
    if (!d) return sendJSON(res, 404, { error: { code: 'not_found', message: '命令不存在：' + cmdMatch[1] } });
    return sendJSON(res, 200, { command: d });
  }

  /* ===== 审批：用户在本机页面点批准/拒绝；Agent 只轮询状态 ===== */
  if (p === '/api/approvals' && method === 'GET') {
    return sendJSON(res, 200, {
      approvals: commandBus.listApprovals(u.searchParams.get('status') || '', u.searchParams.get('limit'))
    });
  }
  const apPage = p.match(/^\/api\/approvals\/([A-Za-z0-9_]+)\/page$/);
  if (apPage && method === 'GET') {
    const a = commandBus.getApproval(apPage[1]);
    res.writeHead(a ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(a ? renderApprovalPage(a) : '<!DOCTYPE html><meta charset="utf-8"><h1>审批不存在或已过期</h1>');
    return true;
  }
  const apApprove = p.match(/^\/api\/approvals\/([A-Za-z0-9_]+)\/approve$/);
  if (apApprove && method === 'POST') {
    const a = commandBus.approve(apApprove[1], 'user:local');
    if (!a) return sendJSON(res, 404, { ok: false, error: { code: 'not_found', message: '审批不存在' } });
    return sendJSON(res, 200, { ok: true, approval: a });
  }
  const apReject = p.match(/^\/api\/approvals\/([A-Za-z0-9_]+)\/reject$/);
  if (apReject && method === 'POST') {
    const a = commandBus.reject(apReject[1], 'user:local');
    if (!a) return sendJSON(res, 404, { ok: false, error: { code: 'not_found', message: '审批不存在' } });
    return sendJSON(res, 200, { ok: true, approval: a });
  }
  const apMatch = p.match(/^\/api\/approvals\/([A-Za-z0-9_]+)$/);
  if (apMatch && method === 'GET') {
    const a = commandBus.getApproval(apMatch[1]);
    if (!a) return sendJSON(res, 404, { ok: false, error: { code: 'not_found', message: '审批不存在' } });
    return sendJSON(res, 200, { ok: true, approval: a });
  }
  if (p === '/api/audit' && method === 'GET') {
    const limit = Number(u.searchParams.get('limit')) || 50;
    return sendJSON(res, 200, { entries: commandBus.listAudit(limit) });
  }
  /* 指标接口：一次性返回 8 个可测量指标（AI 埋点数据 + 规划核心表计算）。
     不依赖任何可选组件，组件全关也能算。 */
  if (p === '/api/metrics' && method === 'GET') {
    try { return sendJSON(res, 200, metrics.compute()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

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
      recordGoalFieldEvents(id, g, { title: title, profile: profile, materials: materials, weekly_hours: weekly, deadline: deadline }, 'http');
      backup();
      return sendJSON(res, 200, { goal: getGoal(id) });
    }
    if (method === 'DELETE') {
      deleteGoalData(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* 清洗已有资料：把"抓取时混进来的垃圾文字"从正文里去掉。
     本地规则免费、即时；勾选 AI 时再让模型"只删不改"地过一遍（同一批资料只做一次，
     原文备份进 content_raw，可反复对照/重跑）。 */
  const cleanMatch = p.match(/^\/api\/goals\/(\d+)\/sources\/clean$/);
  if (cleanMatch && method === 'POST') {
    const id = Number(cleanMatch[1]);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const cbody = await readBody(req).catch(() => ({}));
    const useAI = !(cbody && cbody.ai === false);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const tk = tasks.begin({ type: 'clean', title: '清洗资料：' + String(g.title || '').slice(0, 24), goalId: id, message: '准备清洗…' });
    const csig = tk.signal;
    const cSend = o => {
      try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (e) {}
      /* 清洗是纯计数型：done/total 就是真实进度，交给统一模型按 count 算 —— 
         以前是前端自己算好的 pct 再回传，等于同一件事算两遍。 */
      if (!o) return;
      if (o.total != null && o.done != null && o.total > 0) tk.count(o.done, o.total, o.status || undefined);
      else if (o.status || o.pct != null) tk.progress(o.pct != null ? o.pct : undefined, o.status);
    };
    cSend({ taskId: tk.id, status: '准备清洗…', done: 0, total: 0, pct: 0 });
    (async () => {
      try {
        const rows = db.prepare('SELECT * FROM sources WHERE goal_id = ? ORDER BY id').all(id);
        const todo = rows.filter(r => String(r.content || '').replace(/\s+/g, '').length >= 120);
        /* AI 那遍很慢（一条 10~30 秒）：单次运行设上限，跑完如实告诉你"还剩多少可以再跑一次"，
           否则一次点下去要等一小时，用户只会觉得卡死了。 */
        const aiMax = Math.max(0, Number(getSetting('clean_ai_max', '40')) || 40);
        let done = 0, changed = 0, removed = 0, aiCalls = 0, skipped = 0, aiLeft = 0;
        const t0 = Date.now();
        const el = () => { const sec = Math.round((Date.now() - t0) / 1000); return sec < 60 ? sec + ' 秒' : Math.floor(sec / 60) + ' 分' + (sec % 60 ? ' ' + (sec % 60) + ' 秒' : ''); };
        cSend({
          status: '共 ' + rows.length + ' 条资料，其中 ' + todo.length + ' 条需要清洗' + (useAI ? '（AI 那遍本次最多处理 ' + aiMax + ' 条）' : '（只做本地清洗）'),
          done: 0, total: todo.length, pct: 1
        });
        const upd = db.prepare('UPDATE sources SET content = ?, content_raw = ?, cleaned = 1, clean_removed = ? WHERE id = ?');
        for (const r of todo) {
          if (csig && csig.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; }
          const raw = String(r.content_raw || r.content || '');
          const before = raw.length;
          let text = '';
          try {
            /* 已经是纯文本的（电子书/图片 OCR/上次洗过的）只做行级清洗；HTML 走完整提取 */
            const looksHtml = /<\/(p|div|span|article|section|li|a)>|<br\s*\/?>/i.test(raw);
            text = (looksHtml ? textClean.extractText(raw) : textClean.cleanLines(raw, { minChars: 60 })).text || '';
          } catch (e) { text = raw; }
          /* AI 再过一遍：只删不改，按块调用；任何一块不达标就保留那一块的本地清洗结果 */
          let aiOut = '';
          /* 短资料不值得花调用（本地清洗就够了）：400 字以上才让 AI 再过一遍 */
          const aiAllowed = useAI && text.length >= 400 && aiCalls < aiMax;
          if (useAI && text.length >= 400 && !aiAllowed) aiLeft++;
          if (aiAllowed) {
            const chunks = textClean.aiChunks(text);
            const pieces = [];
            for (const c of chunks) {
              if (csig && csig.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; }
              try {
                aiCalls++;
                let cleanPrompt;
                if (promptPacks.hasOverride('sources.clean')) {
                  cleanPrompt = await promptPacks.renderAsync('sources.clean', {
                    title: r.title,
                    goalTitle: g.title,
                    text: c,
                    goalLine: g.title ? '（读者要拿它学"' + String(g.title).slice(0, 60) + '"相关的东西，所以只留对学习有用的内容）' : '',
                    titleLine: r.title ? '（资料标题：' + String(r.title).slice(0, 80) + '）' : ''
                  });
                } else {
                  cleanPrompt = textClean.buildCleanPrompt(r.title, g.title, c);
                }
                const raw2 = await aiText(cleanPrompt, currentModel(), 180000, null, csig, '资料清洗');
                const pr = textClean.parseCleanOutput(raw2, c);
                pieces.push(pr.ok ? (pr.empty ? '' : pr.text) : c);
              } catch (e) {
                if (e && (e.cancelled || e.name === 'AbortError')) throw e;
                pieces.push(c);
              }
            }
            aiOut = pieces.filter(Boolean).join('\n\n');
            /* 变短得离谱（>90%）说明模型删过头了 → 保留本地清洗结果 */
            if (aiOut && aiOut.length < text.length * 0.1) aiOut = '';
            if (aiOut) text = aiOut;
          }
          text = String(text || '').trim();
          /* 洗成空壳就保留原样（宁可留着垃圾，也不能把用户的资料洗没了）。
             ⚠️ 门槛按"原文多大"算，别用绝对字数：短资料（一二百字）洗掉站点废话后
             只剩几十字是正常的，用绝对 80 字会把它们全 skip 掉（实测踩到）。 */
          const rawLen = String(raw || '').replace(/\s+/g, '').length;
          const newLen = text.replace(/\s+/g, '').length;
          if (newLen < 30 || (rawLen >= 400 && newLen < rawLen * 0.15)) { skipped++; continue; }
          if (text.length === before && !r.content_raw) { skipped++; continue; } // 本来就没变化
          upd.run(text, r.content_raw || String(r.content || ''), Math.max(0, before - text.length), r.id);
          if (text !== raw) { changed++; removed += Math.max(0, before - text.length); }
          done++;
          /* 每处理完一条就报一次：用户要看的是"已经清洗了多少篇"，
             而不是一个不知道走没走的百分比（真实反馈）。 */
          cSend({
            status: '已清洗 ' + done + '/' + todo.length + ' 篇' + (useAI && aiCalls ? '（AI 调用 ' + aiCalls + ' 次）' : '') + ' · 已用 ' + el(),
            done, total: todo.length, pct: Math.round(done / Math.max(1, todo.length) * 100),
            title: String(r.title || '').slice(0, 46),
            removed, aiCalls, elapsedMs: Date.now() - t0, ai: useAI
          });
        }
        try { rag.autoIndex(id); } catch (e) {}
        backup();
        cSend({
          finish: true, ok: true, total: rows.length, cleaned: changed, skipped, removed, aiCalls, ai: useAI,
          aiLeft, aiMax, costMs: Date.now() - t0,
          status: '清洗完成：' + changed + ' 篇有改动' + (removed ? '，共去掉 ' + Math.round(removed / 1000) + 'k 字' : ''), pct: 100
        });
        tk.done({ ok: true });
      } catch (e) {
        tk.fail(e);
        try { cSend({ error: (e && e.message) || String(e), cancelled: !!(e && e.cancelled) }); } catch (e2) {}
      }
      try { res.end(); } catch (e) {}
    })();
    return;
  }

  /* 补抓正文（全部目标）：把"只有标题 + 搜索摘要、正文是空的"资料重抓一遍。
     为什么要它（实测数据）：库里 908 条网络资料有 483 条（53%）正文为空 —— 知乎 95%、
     BOSS 直聘 100%、CSDN 70%、51CTO 94%；它们照样各占一个检索切片，把真有内容的资料挤下去。
     而随手抽 24 条重抓，14 条（58%）**当场就抓回来了**：大头不是反爬，是当初抓失败没有重试
     （见 fetchPage 的三档重试）。
     所以：抓回来的写回正文（顺手补上发布时间）；换招到底仍抓不到的（要登录态那种）直接删掉 ——
     用户的原话是"抓不到就删"，留个空壳比没有更糟（它占检索位，还会让 AI 以为"这条我读过"）。
     删除前库里有自动备份可回滚；每次删除都同步清掉检索索引里的块。 */
  if (p === '/api/sources/refetch' && method === 'POST') {
    const rbody = await readBody(req).catch(() => ({}));
    /* 门槛跟采集时的硬闸门一致：正文少于 260 字的候选本来就不该入库（见 collect-screen.hardGate） */
    const minBody = Math.max(80, Math.min(2000, Number(rbody && rbody.minBody) || 260));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const tk = tasks.begin({ type: 'refetch', title: '补抓资料正文', message: '准备补抓…' });
    const rsig = tk.signal;
    const rSend = o => {
      try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (e) {}
      /* 补抓同样是纯计数型，理由同清洗那处 */
      if (!o) return;
      if (o.total != null && o.done != null && o.total > 0) tk.count(o.done, o.total, o.status || undefined);
      else if (o.status || o.pct != null) tk.progress(o.pct != null ? o.pct : undefined, o.status);
    };
    rSend({ taskId: tk.id, status: '准备补抓…', done: 0, total: 0, pct: 0 });
    (async () => {
      let stopped = false;
      try {
        const rows = db.prepare('SELECT id, goal_id, title, url, site FROM sources WHERE url LIKE ? AND length(trim(content)) < ? ORDER BY id')
          .all('http%', minBody);
        rSend({
          status: rows.length
            ? ('共 ' + rows.length + ' 条资料没有正文（少于 ' + minBody + ' 字），开始逐条补抓：抓到的写回，抓不到的删掉')
            : '没有需要补抓的资料：每条网络资料都已经有正文了',
          done: 0, total: rows.length, pct: rows.length ? 0 : 100
        });
        let done = 0, got = 0, dropped = 0, chars = 0;
        const t0 = Date.now();
        const el = () => { const sec = Math.round((Date.now() - t0) / 1000); return sec < 60 ? sec + ' 秒' : Math.floor(sec / 60) + ' 分' + (sec % 60 ? ' ' + (sec % 60) + ' 秒' : ''); };
        /* 归档原文？这里没有"原文"可存（当初就没抓到），content_raw 留空更诚实；
           published_at 只在原本是空的时候补，别把已有的日期覆盖掉。 */
        const upd = db.prepare("UPDATE sources SET content = ?, content_raw = '', cleaned = 1, clean_removed = 0, published_at = COALESCE(NULLIF(published_at, ''), ?) WHERE id = ?");
        const del = db.prepare('DELETE FROM sources WHERE id = ?');
        const touchedGoals = new Set();
        /* 4 条并发：补抓是纯网络 IO，串行跑 489 条要半小时以上，用户只会以为卡死了。
           ⚠️ mapLimit 会吞掉异常（它 catch 后置 null），所以取消要用标志位传，不能靠 throw。 */
        await mapLimit(rows, 4, async r => {
          if (rsig && rsig.aborted) { stopped = true; return; }
          let page = { text: '', why: '' };
          /* 6MB 上限而不是默认的 800KB：微信公众号、B 站这类页面本身就有 1~3MB，
             卡在体积上等于"明明能抓到却自己放弃"（实测有两条就是这样被丢的）。 */
          try { page = await fetchPage(r.url, 40000, { bytes: 6 * 1024 * 1024, timeoutMs: 15000, attempts: 3 }); }
          catch (e) { page = { text: '', why: e.message || String(e) }; }
          const text = String(page.text || '').trim();
          if (text.replace(/\s+/g, '').length >= minBody) {
            upd.run(text, page.date ? new Date(page.date).toISOString().slice(0, 10) : '', r.id);
            got++; chars += text.length;
            touchedGoals.add(r.goal_id);
          } else {
            del.run(r.id);
            db.prepare('DELETE FROM code_repo_files WHERE source_id = ?').run(r.id);
            try { rag.dropSource(r.id); } catch (e) {}
            dropped++;
            touchedGoals.add(r.goal_id);
          }
          done++;
          /* 每抓完一条就报一次：用户要看的是"已经补了多少条 / 救回几条 / 删了几条"，
             而不是一个转圈的百分比（真实反馈：只说"正在补抓"等于没说）。 */
          rSend({
            status: '补抓 ' + done + '/' + rows.length + '（抓回 ' + got + ' · 删掉 ' + dropped + '）· 已用 ' + el(),
            done, total: rows.length, pct: Math.round(done / Math.max(1, rows.length) * 100),
            title: String(r.title || '').slice(0, 46), got, dropped, chars,
            reason: page.why || '', site: String(r.site || '').slice(0, 16)
          });
        });
        if (stopped) { const e = new Error('已停止'); e.cancelled = true; throw e; }
        for (const gid of touchedGoals) { try { rag.autoIndex(gid); } catch (e) {} }
        backup();
        rSend({
          finish: true, ok: true, total: rows.length, got, dropped, chars, costMs: Date.now() - t0,
          status: rows.length
            ? ('补抓完成：抓回 ' + got + ' 条正文（+' + Math.round(chars / 1000) + 'k 字），删掉抓不到的 ' + dropped + ' 条')
            : '没有需要补抓的资料',
          pct: 100
        });
        tk.done({ ok: true });
      } catch (e) {
        tk.fail(e);
        try { rSend({ error: (e && e.message) || String(e), cancelled: !!(e && e.cancelled) }); } catch (e2) {}
      }
      try { res.end(); } catch (e) {}
    })();
    return;
  }

  const collectMatch = p.match(/^\/api\/goals\/(\d+)\/collect$/);
  if (collectMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(collectMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    return streamCollect(req, res, g);
  }

  /* ---------- 资料提炼：读全部资料 → 提炼 → 多主题 MD 汇总 ---------- */
  const digestMatch = p.match(/^\/api\/goals\/(\d+)\/sources\/digest$/);
  if (digestMatch && method === 'POST') {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(digestMatch[1]));
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    return streamDigest(req, res, g);
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
        digests: inc.digests ? digests.length : 0,
        conditions: inc.nodes ? db.prepare('SELECT COUNT(*) AS n FROM goal_conditions WHERE goal_id = ?').get(g.id).n : 0
      },
      conditions: inc.nodes ? db.prepare('SELECT * FROM goal_conditions WHERE goal_id = ? ORDER BY sort_order, id').all(g.id).map(c => ({
        id: c.id, title: R(c.title), detail: R(c.detail), acceptance: R(c.acceptance), jd_ref: R(c.jd_ref || ''), priority: c.priority, sort_order: c.sort_order
      })) : [],
      nodes: (inc.nodes ? nodes : []).map(n => ({
        id: n.id, parent_id: n.parent_id, level: n.level, sort_order: n.sort_order, title: R(n.title),
        detail: R(n.detail), artifact: R(n.artifact), acceptance: R(n.acceptance), hours: n.hours, status: n.status, condition_id: n.condition_id || 0,
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
    // 达成条件（分享文件里带的话；旧 id → 新 id 映射，节点按映射挂回去）
    const condMap = new Map();
    let condCount = 0;
    for (const c of (Array.isArray(body.conditions) ? body.conditions : []).slice(0, 24)) {
      if (!c || !String(c.title || '').trim()) continue;
      const cr = db.prepare('INSERT INTO goal_conditions (goal_id,title,detail,acceptance,jd_ref,priority,source,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(gid, String(c.title).trim().slice(0, 120), String(c.detail || '').slice(0, 800), String(c.acceptance || '').slice(0, 600), String(c.jd_ref || c.jd || '').slice(0, 600),
          c.priority === 'should' ? 'should' : (c.priority === 'nice' ? 'nice' : 'must'), 'plan',
          Number(c.sort_order) || condCount * 10, t, t);
      condMap.set(Number(c.id), Number(cr.lastInsertRowid));
      condCount++;
    }
    // 节点（按层级顺序插入，维护旧 id → 新 id 映射）
    const idMap = new Map();
    let nodeCount = 0;
    const sorted = (Array.isArray(body.nodes) ? body.nodes : []).slice().sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
    for (const n of sorted) {
      const parentNew = n.parent_id ? (idMap.get(Number(n.parent_id)) || null) : null;
      insertNode(gid, parentNew, Number(n.level) || 0, String(n.title || '节点').slice(0, 200),
        String(n.detail || '').slice(0, 2000), Array.isArray(n.sources) ? n.sources.slice(0, 20) : [],
        Number(n.sort_order) || 0, { artifact: String(n.artifact || '').slice(0, 500), acceptance: String(n.acceptance || '').slice(0, 500), hours: String(n.hours || '').slice(0, 50),
          condition_id: condMap.get(Number(n.condition_id)) || 0 });
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
    rag.autoIndex(gid);
    backup();
    return sendJSON(res, 200, { ok: true, goalId: gid, counts: { nodes: nodeCount, conditions: condCount, sources: srcCount, digests: digCount }, goal: getGoal(gid) });
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
    rag.autoIndex(gid);
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
    rag.autoIndex(row.goal_id);
    backup();
    return sendJSON(res, 200, { ok: true, sources: sourcesOf(row.goal_id) });
  }
  const sourceDelMatch = p.match(/^\/api\/sources\/(\d+)$/);
  if (sourceDelMatch && method === 'DELETE') {
    const sid = Number(sourceDelMatch[1]);
    db.prepare('DELETE FROM sources WHERE id = ?').run(sid);
    db.prepare('DELETE FROM code_repo_files WHERE source_id = ?').run(sid);
    rag.dropSource(sid);
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
    for (const id of new Set(ids)) { try { n += del.run(id, gid).changes; } catch (e) {} db.prepare('DELETE FROM code_repo_files WHERE source_id = ?').run(id); rag.dropSource(id); }
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
    db.prepare('DELETE FROM code_repo_files WHERE goal_id = ?').run(gid);
    rag.dropGoal(gid);
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
    const tk = tasks.begin({ type: 'expand', title: 'AI 拆分：' + (n ? n.title : ''), goalId: n ? n.goal_id : 0, nodeId: id, note: feedback, retry: expandRetry(n, feedback) });
    /* 同教程那条约定：signal 传进每一次 AI 调用，写入前再查一次取消。
       漏传 signal 的后果和教程一样 —— 点了停止，剩下的调用照打、节点照写。 */
    const sig = tk.signal;
    const checkStop = () => { if (sig.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
    /* 进度上报：⚠️ 这里以前**只转 status**，于是「AI 拆分」全程只有一句静态文案 ——
       切好一次 AI 调用就只能干等（实测那次「按意见调整」跑了 8 分 28 秒），
       卡片上进度恒 0%、没有阶段、没有"它在想什么"，用户只能判断成"卡死了"。
       现在 pct / steps / thinking / eta 一并转给任务中心，
       前端 taskProgressHTML 会画成「阶段点 + 动效条 + 实时思考」。 */
    const send = obj => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
      /* 只报"我在想什么"（status 为空）也要转 —— 不过滤的话实时思考刷不上去 */
      if (obj && (obj.status || obj.pct != null || obj.thinking != null || obj.steps)) {
        tk.progress(obj.pct, obj.status, { steps: obj.steps, thinking: obj.thinking, eta: obj.eta });
      }
    };
    /* ⚠️ 每条退出路径都必须落终态。这里原来有三条路直接 return 而**没调用 tk.done()**：
       「按意见调整」的调整成功分支 + 两个"需要先问几个问题"分支。
       现场就是这样卡住的：AI 跑完（39.9s）、节点也写进库了，
       任务卡片却永远显示"进行中 6 分 38 秒"、进度恒 0%（用户看到的是前端计时器）。
       现在统一走 ok/bad：谁先到谁说了算，后面的 done/fail 一律不再覆盖。 */
    let settled = false;
    const ok = (r) => { if (!settled) { settled = true; tk.done(r || { ok: true }); } };
    const bad = (e) => { if (!settled) { settled = true; tk.fail(e); } };
    (async () => {
      /* 心跳句柄放在 try 外面：任何退出路径（含上面两个 return）都要能清掉它，
         否则一个 3 秒的定时器会跟着进程转到底。 */
      let hb = 0;
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
        /* ---------- 进度上报 ----------
           为什么要有这一段：这条流程的 AI 调用是全应用最慢的一次
           （「按意见调整」实测 8 分 28 秒才回来），而它以前从头到尾**只发一句文案**，
           界面因此完全无法区分"在跑"和"卡死"（真实反馈："显示不出进度，
           不知道进展到哪一步"）。所以这里做三件事：
             ① 阶段清单：把整件事切成 4 步，前端画成一排阶段点，走到哪一目了然；
             ② 实时思考：把模型正在流的文本尾巴打上去（节流 1.2 秒）；
             ③ 心跳：哪怕一个字都没吐（推理模型尤其常见）也每 3 秒刷一次"已等 N 秒"，
                顺带把"太久没进展"的误报（看门狗与前端 90 秒提示）挡掉。 */
        const STEPS = feedback
          ? [{ key: 'prep', label: '备齐依据' }, { key: 'plan', label: '按意见重划' }, { key: 'write', label: '写入子任务' }, { key: 'save', label: '存版本收尾' }]
          : [{ key: 'src', label: '搜集资料' }, { key: 'plan', label: '制定拆分计划' }, { key: 'write', label: '写入子任务' }, { key: 'save', label: '存版本收尾' }];
        const idxOf = k => STEPS.findIndex(x => x.key === k);
        let curKey = STEPS[0].key, msgBase = '', thinkTail = '', full = '', thinkAt = 0, phaseAt = Date.now();
        /* 数"已经列出几项"：只认 "title" 这个键。
           ⚠️ 别用 progressTitles() —— 它把 "name" 也算一项（来源里的 name），
           6 个子任务会数成 10 几项，报给用户的数字就是错的。 */
        const countItems = () => (full.match(/"title"\s*:/g) || []).length;
        const secs = () => Math.max(0, Math.round((Date.now() - phaseAt) / 1000));
        const stepsNow = () => STEPS.map(s => ({
          key: s.key, label: s.label,
          state: s.key === curKey ? 'active' : (idxOf(s.key) < idxOf(curKey) ? 'done' : 'pending'),
          detail: s.detail || ''
        }));
        const emit = (pct, msg, detail) => {
          if (detail != null) { const s = STEPS.find(x => x.key === curKey); if (s) s.detail = String(detail).slice(0, 80); }
          send({ pct: pct == null ? undefined : pct, status: msg || null, steps: stepsNow(), thinking: thinkTail });
        };
        const phase = (key, pct, msg) => { curKey = key; phaseAt = Date.now(); msgBase = msg || ''; emit(pct, msg); };
        /* 模型流式输出的尾巴 → "它现在在想什么 / 已经列到第几项"。
           节流 1.2 秒：每个 token 推一次会把 SSE 打满（教程那条流程同此约定）。 */
        const onStream = ev => {
          if (!ev) return;
          if (ev.text) full += ev.text;
          const piece = ev.thinking || ev.text || '';
          if (piece) thinkTail = String(piece).replace(/\s+/g, ' ').slice(-120);
          const now = Date.now();
          if (now - thinkAt < 1200) return;
          thinkAt = now;
          const cnt = countItems();
          emit(null, msgBase + '（AI 已跑 ' + secs() + ' 秒' + (cnt ? ' · 已列出 ' + cnt + ' 项' : '') + '…）');
        };
        hb = setInterval(() => {
          /* 只在"等 AI"的阶段刷心跳；写库那几步本身很快，不需要 */
          if (curKey !== 'plan' && curKey !== 'prep') return;
          const cnt = countItems();
          emit(null, msgBase + '（已等 ' + secs() + ' 秒' + (cnt ? ' · 已列出 ' + cnt + ' 项' : '') + '…）');
        }, 3000);
        if (hb.unref) hb.unref();
        phase('prep', 3, feedback ? '正在准备重新划分的依据…' : '正在准备拆分依据…');
        /* 挂载文件夹的源码：拆分也要读 —— 否则 AI 只能拍脑袋编阶段。
           走共用的 prepareNodeCode（AI 先看清单挑，再读），失败就当没挂，照常拆。 */
        let expandCode = '';
        try {
          const hasFolders = nodeFolders.collectFolderEntries(db, Number(id)).filter(e => !e.missing);
          if (hasFolders.length) {
            phase('prep', 5, '正在读挂载文件夹的源码，拆分会沿代码真实结构走…');
            const g = await nodeFolders.prepareNodeCode({
              aiText, model, db, nodeId: Number(id),
              title: n.title, detail: n.detail, budget: 15000, signal: sig
            });
            if (g.block) {
              expandCode = g.block;
              emit(12, `已读入挂载文件夹的 ${g.list.length} 个源码文件，拆分会沿代码真实结构走…`, g.list.length + ' 个文件');
            }
          }
        } catch (e) {
          if (e && (e.cancelled || e.name === 'AbortError')) throw e;
          console.log('[expand] 文件夹代码载入失败:', e.message);
        }
        if (feedback) {
          // 带用户意见调整现有子任务
          const kids = db.prepare('SELECT title, detail, status FROM nodes WHERE parent_id = ? ORDER BY sort_order, id').all(n.id);
          phase('plan', 25, '正在根据你的意见调整划分…', '现有 ' + kids.length + ' 条子任务');
          const txt = await aiText(await buildRefineNodePrompt(goal, n, kids, feedback, expandCode), model, 300000, onStream, sig, '节点细化');
          const data = extractJSON(txt);
          if (data && Array.isArray(data.questions) && data.questions.length) {
            saveNodeQuestions(n.id, data, feedback);
            send({ questions: { questions: data.questions }, stage: 'expand', nodeId: n.id, nodeTitle: n.title, feedback, goal: getGoal(goal.id) });
            ok({ awaitingQuestions: true });   // 要等用户回答：这也是一个终态，不能留着 running
            res.end();
            return;
          }
          if (!data || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('调整结果解析失败，请重试');
          checkStop();   /* 取消后一个节点都不许写 */
          phase('write', 78, '正在按新划分写入子任务…', 'AI 列出 ' + data.tasks.length + ' 项');
          const vid = beginVersion(goal.id, reason);
          const statusByTitle = {};
          for (const k of kids) statusByTitle[k.title] = k.status;
          for (const oid of db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(n.id).map(x => x.id)) deleteNodeTree(oid);
          let order = 0, added = 0;
          const tot = data.tasks.slice(0, 10).length;
          for (const t of data.tasks.slice(0, 10)) {
            insertNode(goal.id, n.id, Math.min(n.level + 1, 5), t.title || '子任务', t.detail || '', t.sources, order++, { artifact: t.artifact, acceptance: t.acceptance, hours: t.hours });
            const newId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
            const st = statusByTitle[t.title];
            if (st && st !== 'todo') db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(st, newId);
            added++;
            emit(78 + Math.round(14 * added / Math.max(1, tot)), '正在写入子任务 ' + added + '/' + tot + '：' + String(t.title || '').slice(0, 30));
          }
          db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
          phase('save', 94, '正在生成版本快照与回执…');
          const report = await finishVersion(goal, vid, reason);
          backup();
          send({ done: true, added, refined: true, goal: getGoal(goal.id), report, versionId: vid });
          ok({ added, refined: true });   // ← 现场就是漏了这一句：调整成功却永远"进行中"
        } else {
          // 无意见：先搜集资料，再生成细分（回答追问后的续跑不再重复搜集）
          if (!answers && goalCompOn(goal.id, 'sources')) {
            phase('src', 4, '正在搜集资料（搜到的每一条都会过一遍 AI 质量判读）…');
            const before = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            try {
              await fetchEbooksForGoal(goal, s => send(s), sig);
            } catch (e) {
              if (e && (e.cancelled || e.name === 'AbortError')) throw e;
              send({ status: '电子书阶段跳过：' + e.message });
            }
            await collectSources(goal, nodeQueries(n.title), s => send(s), sig);
            const after = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE goal_id = ?').get(goal.id).n;
            send({ status: `信息源新增 ${after - before} 条（共 ${after} 条），开始制定拆分计划…`, sources: sourcesOf(goal.id) });
          }
          checkStop();
          phase('plan', 45, '正在制定拆分计划（AI 要给出每项的做法、产出物与验收标准，通常要等一两分钟）…');
          var vid = beginVersion(goal.id, reason);
          const txt = await aiText(await buildExpandPrompt(goal, n, null, expandCode), model, 300000, onStream, sig, '骨架展开');
          const data = extractJSON(txt);
          if (data && Array.isArray(data.questions) && data.questions.length) {
            saveNodeQuestions(n.id, data, feedback);
            send({ questions: { questions: data.questions }, stage: 'expand', nodeId: n.id, nodeTitle: n.title, feedback, goal: getGoal(goal.id) });
            ok({ awaitingQuestions: true });
            res.end();
            return;
          }
          if (!data || !Array.isArray(data.tasks) || !data.tasks.length) throw new Error('拆分结果解析失败，请重试');
          checkStop();   /* 取消后一个节点都不许写 */
          phase('write', 78, '正在写入子任务…', 'AI 列出 ' + data.tasks.length + ' 项');
          const childLevel = Math.min(n.level + 1, 5);
          let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM nodes WHERE parent_id = ?').get(n.id).n;
          let added = 0;
          const tot = data.tasks.slice(0, 10).length;
          for (const t of data.tasks.slice(0, 10)) {
            insertNode(goal.id, n.id, childLevel, t.title || '子任务', t.detail || '', t.sources, order++, { artifact: t.artifact, acceptance: t.acceptance, hours: t.hours });
            added++;
            emit(78 + Math.round(14 * added / Math.max(1, tot)), '正在写入子任务 ' + added + '/' + tot + '：' + String(t.title || '').slice(0, 30));
          }
          db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), goal.id);
          phase('save', 94, '正在生成版本快照与回执…');
          const report2 = await finishVersion(goal, vid, reason);
          backup();
          ok({ added });
          send({ done: true, added, goal: getGoal(goal.id), sources: sourcesOf(goal.id), report: report2, versionId: vid });
        }
      } catch (e) {
        /* 失败分支到此为止：绝不能再调 tk.done()，否则 failed 会被覆盖成"✓ 完成"，
           任务失败在任务中心显示成成功，用户完全看不出出了什么事。 */
        bad(e);
        send({ error: e.message });
      } finally {
        if (hb) clearInterval(hb);   /* 任何退出路径都要停掉心跳，别让定时器悬着 */
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
      /* node_title：对话列表里要能一眼看出"这条是哪个节点的对话"（🎯 前缀在界面上加） */
      const rows = db.prepare(`SELECT s.id, s.goal_id, s.title, s.model, s.node_id, s.nodes, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM chats c WHERE c.session_id = s.id) AS msg_count,
        (SELECT title FROM nodes n WHERE n.id = s.node_id) AS node_title
        FROM chat_sessions s WHERE s.goal_id = ? ORDER BY s.updated_at DESC, s.id DESC`).all(gid);
      return sendJSON(res, 200, { sessions: rows });
    }
    if (method === 'POST') {
      /* gid=0 = 全局对话（不绑定目标，只读全站内容）：不校验目标存在。 */
      if (gid !== 0) {
        const g = db.prepare('SELECT id FROM goals WHERE id = ?').get(gid);
        if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      }
      let title = '新对话', model = '', nodeId = 0, nodes = '[]';
      try {
        const b = await readBody(req);
        if (b.title) title = String(b.title).slice(0, 60);
        if (b.model) model = String(b.model).slice(0, 120);
        /* node_id：这条对话是"某个节点自己的对话"（右键节点 → AI 功能 走这条）。
           必须校验它属于本目标 —— 否则客户端编个 id 就能把别的目标的节点写进对话。 */
        const nid = Number(b.node_id || 0);
        if (nid) {
          const n = db.prepare('SELECT id, title FROM nodes WHERE id = ? AND goal_id = ?').get(nid, gid);
          if (n) { nodeId = nid; if (title === '新对话') title = String(n.title || '').slice(0, 60); }
        }
        if (Array.isArray(b.nodes)) nodes = JSON.stringify(sanitizeChatNodes(b.nodes, gid));
      } catch (e) {}
      const t = nowISO();
      const r = db.prepare('INSERT INTO chat_sessions (goal_id, title, model, node_id, nodes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(gid, title, model, nodeId, nodes, t, t);
      const session = db.prepare('SELECT id, goal_id, title, model, node_id, nodes, created_at, updated_at, 0 AS msg_count FROM chat_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
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
      /* nodes：对话里"带上了哪些节点"的附件清单（AI 助手里 ＋添加节点 / 取消某个节点）。
         走这里存，刷新和换设备都还在（和 node_id 同一个理由）。 */
      let nodes = s.nodes;
      if (Array.isArray(body.nodes)) nodes = JSON.stringify(sanitizeChatNodes(body.nodes, s.goal_id));
      db.prepare('UPDATE chat_sessions SET title = ?, model = ?, nodes = ?, updated_at = ? WHERE id = ?')
        .run(title || s.title, model, nodes || '[]', nowISO(), sid);
      return sendJSON(res, 200, { session: db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM chats WHERE session_id = ?').run(sid);
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sid);
      return sendJSON(res, 200, { ok: true });
    }
  }
  /* 取教程**当前正文**：版本对比要用它当"新"的一侧。
     不能指望 state.goal.tutorials —— 教程页根本不加载整个 goal（实测取不到）。 */
  const tutContentMatch = p.match(/^\/api\/tutorials\/(\d+)\/content$/);
  if (tutContentMatch && method === 'GET') {
    const t = db.prepare('SELECT id,title,format,content FROM tutorials WHERE id = ?').get(Number(tutContentMatch[1]));
    if (!t) return sendJSON(res, 404, { error: '教程不存在' });
    return sendJSON(res, 200, { id: t.id, title: t.title, format: t.format, content: t.content || '' });
  }
  const sessMsgsMatch = p.match(/^\/api\/chat-sessions\/(\d+)\/messages$/);
  if (sessMsgsMatch && method === 'GET') {
    const sid = Number(sessMsgsMatch[1]);
    const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid);
    if (!s) return sendJSON(res, 404, { error: '对话不存在' });
    const rows = db.prepare('SELECT id, role, content, ops, version_id, trace, images, created_at FROM chats WHERE session_id = ? ORDER BY id').all(sid);
    return sendJSON(res, 200, { session: s, messages: rows });
  }
  const sessChatMatch = p.match(/^\/api\/chat-sessions\/(\d+)\/chat$/);
  if (sessChatMatch && method === 'POST') {
    const sid = Number(sessChatMatch[1]);
    const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sid);
    if (!s) return sendJSON(res, 404, { error: '对话不存在' });
    /* goal_id=0：全局助手（不绑定目标，读全站、只回答与指路）。 */
    if (Number(s.goal_id) === 0) return streamGlobalChat(req, res, s);
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(s.goal_id);
    if (!g) return sendJSON(res, 404, { error: '目标不存在' });
    const body = await readBody(req);
    const hasImgs = Array.isArray(body.images) && body.images.some(x => /^data:image\//.test(String(x || '')));
    let message = String(body.message || '').trim().slice(0, 30000);
    if (!message && hasImgs) message = '请看我发的图片。';
    if (!message) return sendJSON(res, 400, { error: '请先输入内容' });
    /* mode: 'ask' = 只提问（服务端禁掉一切 ops）；其余一律当 agent（可意图识别 + 调工具）。
       tutorial_id: 用户当前在看哪份教程 —— 有它才允许 AI 提议改教程。 */
    const reqMode = String(body.mode || '').toLowerCase();
    /* 三种模式：ask 只读问答 / agent 改路线图（默认）/ create 创造模式（生成可安装的插件） */
    const mode = reqMode === 'ask' ? 'ask' : (reqMode === 'create' ? 'create' : 'agent');
    const tutorial = Number(body.tutorial_id || 0) ? { id: Number(body.tutorial_id) } : null;
    /* 这条对话带了哪些节点：以请求为准（前端可以随时加/去掉），落库到会话上，
       这样刷新、换设备、重新打开都还在。node_id 是老的单值参数，继续认。 */
    let chatNodes = null;
    if (Array.isArray(body.node_ids)) chatNodes = sanitizeChatNodes(body.node_ids, g.id);
    else if (Number(body.node_id || 0)) chatNodes = sanitizeChatNodes([{ id: Number(body.node_id), withKids: !!body.with_kids }], g.id);
    if (chatNodes) {
      try { db.prepare('UPDATE chat_sessions SET nodes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(chatNodes), nowISO(), sid); } catch (e) {}
    } else {
      try { chatNodes = sanitizeChatNodes(safeParse(s.nodes) || [], g.id); } catch (e) { chatNodes = []; }
    }
    /* edit_scope：用户在对话栏上方「🎯 只改」里指定的范围（auto / conditions / nodes / goal / sources / tutorials）。
       服务端按它硬拦 ops —— 用户在达成条件页说「改条件」时，AI 不会再把路线图节点也一起改了。 */
    const editScope = chatScopeOf(body.edit_scope);
    /* 粘贴的图片：原图随这次请求交给模型；缩略图落库用于刷新后显示。
       能不能识图由 streamChat 里按当前模型判断（不支持会直接回一句说明）。 */
    return streamChat(req, res, g, message, s, {
      mode, tutorial, nodes: chatNodes || [], page: body.page_context || body.page || null, scope: editScope,
      images: body.images, image_thumbs: body.image_thumbs
    });
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
/* 教程修改任务的进展写回对话。
   以前任务跑完只改数据库，对话里永远停在"已把这条修改意见交给 AI" ——
   用户不知道后来成了没有、为什么没成。 */
function tutEditSay(sess, tut, kind, payload, extra) {
  const sid = sess && sess.id ? Number(sess.id) : 0;
  const gid = tut && tut.goal_id ? Number(tut.goal_id) : 0;
  if (!gid) return;
  const e = extra || {};
  const title = String((tut && tut.title) || '').slice(0, 30);
  let text;
  if (kind === 'stopped') {
    text = '⏹ 已停止：教程没动。\n\n' + title + ' 还是原样。想重跑就点左下角任务上的「🔄 重试」，或者把要改什么再说一遍。';
  } else if (kind === 'ok') {
    text = '✅ 教程已改完：' + title + '（正文 ' + (payload ? String(payload).length : 0) + ' 字）\n\n'
      + (e.structureNote ? e.structureNote + '\n\n' : '')
      + '页面已自动刷新，可以直接往下读。改得不满意，点教程右上角的「📜 版本对比」就能回到上一版。';
  } else {
    /* ⚠️ 失败原因不同，能做的动作也不同：结构守卫拦下的那种，点「🔄 重试」是**注定再失败一次**
       （同一份意见、同一个提示词、同一个判据），要引导用户去点卡片上的「🔓 允许改结构再跑」。 */
    text = '✗ 教程没改成：' + title + '\n\n原因：' + String(payload || '未知').slice(0, 600) + '\n\n'
      + '原教程一个字没动。'
      + (e.allowRestructure
        ? '这条不是 AI 写不出来，是它这次动了你想保留的章节 —— 点任务卡片上的「🔓 允许改结构再跑」就会放行，直接点「🔄 重试」只会原样再失败一次。'
        : '点左下角任务上的「🔄 重试」可以原样重跑，或把修改意见拆小一点分多次提。');
  }
  try {
    db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)')
      .run(gid, sid, 'assistant', text.slice(0, 3000), nowISO());
    if (sid) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sid);
    backup();
  } catch (e) { console.log('[tutorial] 回执写库失败:', e.message); }
}
/* ---------- 结构改动先核对范围（给「Agent 替用户转述需求」那条路用）----------
   用户原话："我觉得 Agent 有必要跟用户核对一下改动范围再动手，不然容易错改。"
   为什么必须在**服务端**判：AI 把范围写宽这件事，用户在对话里看不出来 ——
   等发现时三分钟已经花掉、教程也已经改坏（真实翻车 2026-10-14）。
   这里只做纯文本判定（同 tut-guard 那套范围解析），不花 AI 调用。
   挂起状态与"同意"词表在模块级（见文件顶部的 PENDING_EDIT / CONFIRM_WORDS）。 */

/** 把一串标题说成人话：「A」「B」等 12 节（太长就截断，取前 n 个） */
function fmtTitles(list, n) {
  const titles = (list || []).map(x => String(x && x.title || x || '').replace(/\s+/g, ' '));
  if (!titles.length) return '（没有）';
  const head = titles.slice(0, n || 2).map(t => '「' + t.slice(0, 26) + (t.length > 26 ? '…' : '') + '」').join('');
  return head + (titles.length > (n || 2) ? ' 等 ' + titles.length + ' 节' : '');
}

/** 这次意见是不是要动结构？是的话给出"要改哪一段"的人类可读说法（给用户核对用）。
 *  ⚠️ 一定要用**小节标题**说，别只说"第 13~26 节" —— 用户看标题才知道要改的是哪些（真实反馈）。 */
function scopeConfirmAsk(tut, feedback) {
  const content = String((tut && tut.content) || '');
  const sc = tutGuard.parseEditScope(feedback, content);
  if (sc.mode === 'doc') return null;
  const hs = tutGuard.headings(content);
  const fromIdx = sc.mode === 'range' ? sc.fromIdx : 0;
  const toIdx = (sc.mode === 'range' && Number.isFinite(sc.toIdx)) ? sc.toIdx : hs.length;
  const inScope = hs.slice(fromIdx, toIdx);
  const keep = hs.slice(0, fromIdx).concat(hs.slice(toIdx));
  const toEnd = toIdx >= hs.length;
  const rangeLine = sc.mode === 'range'
    ? (toEnd
      ? '从「' + hs[fromIdx].title + '」这一节开始，一直到全篇最后'
      : '从「' + hs[fromIdx].title + '」开始，到「' + hs[toIdx].title + '」之前')
    : '整篇重排（每一节都可能被改动）';
  return {
    sc, line: rangeLine, before: keep.length, count: hs.length,
    keepTitles: fmtTitles(keep, 3),
    inTitles: fmtTitles(inScope, 3),
    view: {
      mode: sc.mode, from: sc.fromTitle || '', fromIdx, toIdx, sections: hs.length,
      fromTitle: hs[fromIdx] ? hs[fromIdx].title : '', toTitle: toEnd ? '' : (hs[toIdx] ? hs[toIdx].title : ''),
      toEnd, inCount: inScope.length, keepCount: keep.length,
      inSample: inScope.slice(0, 3).map(x => String(x.title).slice(0, 30)),
      keepSample: keep.slice(0, 3).map(x => String(x.title).slice(0, 30))
    }
  };
}

/** 用户最近说的那句话（用来判断"他有没有授权这次结构改动"） */
function lastUserWords(sess, goalId) {
  try {
    const sid = sess && sess.id ? Number(sess.id) : 0;
    const r = sid
      ? db.prepare("SELECT content FROM chats WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(sid)
      : db.prepare("SELECT content FROM chats WHERE goal_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(goalId);
    return r ? String(r.content || '') : '';
  } catch (e) { return ''; }
}

const tutEditMatch = p.match(/^\/api\/tutorials\/(\d+)\/edit$/);
  if (tutEditMatch && method === 'POST') {
    const tid = Number(tutEditMatch[1]);
    const tut = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid);
    if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
    const body = await readBody(req).catch(() => ({}));
    const feedback = String((body && body.feedback) || '').trim().slice(0, 1500);
    /* quiet = 这次修改是从对话里发起的（Agent 模式识别出意图）。
       用户那句话与 AI 的回复都已经记在对话里了，再插一份"【教程修改 · …】"和固定回执
       只会让对话变成一叠重复。 */
    const quiet = !!(body && body.quiet);
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
    /* ---------- 结构改动先跟用户核对范围（Agent 发起的那条路）----------
       为什么要这道闸：从对话发起的修改是 **AI 替用户转述需求**，它把范围写宽一点，
       用户是看不见的 —— 真跑完三分钟才发现教程被删了 12 节（真实翻车 2026-10-14：
       用户只想"再加一个 HTTP+SSE 的实现"，AI 把整段重写了）。用户的原话：
       "我觉得 Agent 有必要跟用户核对一下改动范围再动手，不然容易错改。"
       判定：
         · 用户自己的话里就点了范围 / 允许整篇重写 → 他授权了，直接开跑
         · 用户刚回过"可以 / 就这样改" → 视为对上一次挂起范围的确认
         · 其余情况（AI 想动结构、用户没提）→ 不跑，先在对话里把范围摊开问一句 */
    const pendKey = tut.goal_id + ':' + tid;
    if (quiet && !(body && body.confirmed)) {
      const ask = scopeConfirmAsk(tut, feedback);
      if (ask) {
        const pend = PENDING_EDIT.get(pendKey);
        const userWords = String(lastUserWords(sess, tut.goal_id) || '').trim();
        const userAsked = !!userWords && tutGuard.parseEditScope(userWords, tut.content || '').mode !== 'doc';
        const userOk = !!pend && (Date.now() - pend.at < 30 * 60 * 1000) && CONFIRM_WORDS.test(userWords);
        if (!userAsked && !userOk) {
          PENDING_EDIT.set(pendKey, { feedback, at: Date.now() });
          console.log('[tutorial] 结构改动挂起待确认：' + ask.line + '（用户没提结构：' + userWords.slice(0, 30) + '）');
          const text = '📐 这次要改的是**结构**，先跟你核对范围，确认了我再动手（不然白跑三分钟还可能删错）：\n\n'
            + '**· 改哪里**：' + ask.line + '\n'
            + (ask.sc.mode === 'range'
              ? '**· 这一段里的小节**（共 ' + ask.view.inCount + ' 节）：' + ask.inTitles + '\n'
                + '**· 保持不动**（共 ' + ask.view.keepCount + ' 节）：' + ask.keepTitles + '\n'
              : '**· 注意**：整篇重排时章节可能被合并、改名或删除（改完可用「📜 版本对比」回滚）\n')
            + '\n范围对就点「✅ 就按这个范围改」（回一句"可以"也行）；不对就点「✏️ 范围不对」，在下面的输入框里把要改哪几节说清楚。';
          try {
            db.prepare('INSERT INTO chats (goal_id, session_id, role, content, ops, created_at) VALUES (?,?,?,?,?,?)')
              .run(tut.goal_id, sess ? sess.id : 0, 'assistant', text.slice(0, 3000),
                JSON.stringify([{ op: 'pending_edit', tutorial_id: tid, feedback, view: ask.view }]), nowISO());
            if (sess) db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sess.id);
            backup();
          } catch (e) { console.log('[tutorial] 核对消息写库失败:', e.message); }
          return sendJSON(res, 200, { ok: true, pending: true, needConfirm: true, sessionId: sess ? sess.id : 0, scope: ask.view });
        }
        PENDING_EDIT.delete(pendKey);
      }
    }
    /* 任务重试闭包：重跑「教程修改」，入参与当初完全一致。
       失败时不必把那条修改意见重新打一遍（意见常常很长，重打一遍最容易出错）。
       opts.allowRestructure = 卡片上「🔓 允许改结构再跑」点的：结构守卫这次不再拦。
       opts.fromRetry / originId 只用来记「这条是重试来的」（失败率指标要分得清）。 */
    const startEditTask = (opts) => {
      const ro = opts || {};
      const allowRestructure = !!(ro.allowRestructure || (body && body.allow_restructure));
      return tasks.submit({
      type: 'tutorial', title: '修改教程：' + String(tut.title || '').slice(0, 30), goalId: tut.goal_id, nodeId: tut.node_id, note: feedback,
      retry: startEditTask,
      retried: ro.fromRetry ? 1 : 0, originId: ro.originId || 0,
      run: async ({ progress, signal }) => {
        try {
        /* 这条任务以前**不声明阶段**（只报一句百分比），左下角卡片就只有一个光秃秃的
           百分比 + 一条不确定态的走马灯条 —— 用户看不出走到哪、也不知道 AI 在干什么。
           照教程生成那条的做法，把**阶段表**和**实时思考**一并报上去。 */
        const est = [
          { key: 'load', label: '读原文' },
          { key: 'write', label: 'AI 重写' },
          { key: 'check', label: '结构自检' },
          { key: 'fix', label: '续写补齐' },
          { key: 'save', label: '保存版本' }
        ].map(x => ({ key: x.key, label: x.label, state: 'pending' }));
        let curStep = -1, thinkTail = '', etaLive = '';
        const stepAt = (k, pct, msg, think, eta) => {
          if (k != null && k > curStep) curStep = k;
          est.forEach((x, i) => { x.state = i < curStep ? 'done' : (i === curStep ? 'active' : 'pending'); });
          /* pct / msg 传 null = 「只更新阶段与思考」，别把百分比和当前文案覆盖掉。
             eta 传 undefined = 保持上一条（"约还需多久"要一直显示到这一步结束）；传 '' = 清掉。 */
          if (eta !== undefined) etaLive = eta;
          progress(pct == null ? null : pct, msg || null, { steps: est, thinking: think != null ? think : thinkTail, eta: etaLive });
        };
        stepAt(0, 5, '正在按你的意见修改教程…');
        /* 同教程生成那条约定：AI 调用都带 signal，写入前再查一次 ——
           点了停止就该一步都不落，不能"改了库里却没告诉用户"。 */
        const stopCheck = () => { if (signal && signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; } };
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
        /* ⚠️ 整篇修改提示词要**用的时候才拼**：它内部有"正文超过 9 万字就拒收"的保护
           （fullTutorialForEdit），而长教程现在走分节改写、根本不需要整篇提示词。
           提前拼会在 9 万字以上直接抛错，用户连分节改写的门都进不去。 */
        let editBaseLazy = null;
        const editBase = () => {
          if (editBaseLazy == null) editBaseLazy = buildTutorialEditPrompt(goal, node, tut, feedback, tut.format, editCodeBlock);
          return editBaseLazy;
        };
        /* ---------- 「AI 重写」那一步的进度是怎么算出来的 ----------
           这一步就是整个任务 95% 的时间（实测这篇 7.9 万字要 2~4 分钟），而它原来
           只报一句 15% 就一动不动，直到整个任务结束才跳到 100% —— 用户盯着一条
           不动的进度条干等，完全估不出还要多久（线上反馈）。
           现在用两个**真信号**推算，映射到 15%~68%：
             · 已写出多少字 ÷ 预计要写的字数（流式接口能拿到增量，最准）
             · 已花多少时间 ÷ 预估耗时（非流式 / agent 那条路拿不到增量时的兜底）
           两个取较大值；能量出速率时再补一句「约还需 X 分 Y 秒」。
           ⚠️ 别让它爬到顶就停：结构自检 / 续写补齐 / 保存版本还要走 68%→100%。 */
        const origChars = String(tut.content || '').length;
        let expectChars = Math.max(2000, Math.round(origChars * 0.9));
        let expectMs = Math.max(60000, Math.min(300000, 45000 + origChars * 1.6));
        let rewriteT0 = Date.now();
        let gotChars = 0, bodyTail = '';
        const fmtLeft = ms => {
          const s = Math.max(0, Math.round(ms / 1000));
          return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分' + (s % 60 ? ' ' + (s % 60) + ' 秒' : '');
        };
        const paintRewrite = () => {
          const el = Date.now() - rewriteT0;
          const byChars = gotChars / expectChars;
          const byTime = Math.min(0.9, el / expectMs);      // 时间兜底最多推到 63%，剩下的留给字数控
          const frac = Math.min(1, Math.max(byChars, byTime));
          let eta = '';
          if (gotChars >= 1200 && el >= 5000) {
            const rate = gotChars / el;                     // 字/毫秒
            const left = (expectChars - gotChars) / rate;
            eta = left > 0 ? '约还需 ' + fmtLeft(left) : '快写完了';
          } else if (el > 8000) {
            eta = '约还需 ' + fmtLeft(Math.max(0, expectMs - el));
          }
          stepAt(1, 15 + Math.round(53 * frac),
            gotChars >= 1000 ? '正在按你的意见重写正文…（已写约 ' + Math.round(gotChars / 1000) + ' 千字 / 全文约 ' + Math.round(expectChars / 1000) + ' 千字）' : null,
            null, eta);
        };
        /* onEvent 把模型此刻在写什么带回来（推理片段 / 正文尾巴）——
           卡片上那行 💭 才有内容，否则用户只知道"在跑"，不知道"在跑什么"。
           正文增量顺便拿来算上面的进度（只看尾巴 220 字，别把整篇正文留在内存里）。 */
        const runEdit = async (prompt) => {
          /* 保底心跳：万一这条连接根本不吐增量（非流式 / agent 那条路），
             也得让进度条按时间往前爬、并把「约还需多久」显示出来 ——
             否则卡片又是一动不动（用户报的就是这个）。
             unref + finally 清掉，别让定时器拖住进程或活到任务结束之后。 */
          const tick = setInterval(() => { try { paintRewrite(); } catch (e) {} }, 2500);
          if (tick.unref) tick.unref();
          try {
            return cleanTutorialText(String(await ai.text({
              prompt, model: currentModel(), timeoutMs: 600000, signal, scene: '教程修改',
              onEvent: ev => {
                if (ev.text) {
                  gotChars += String(ev.text).length;
                  bodyTail = (bodyTail + ev.text).slice(-220);
                  thinkTail = bodyTail;
                } else if (ev.thinking) {
                  thinkTail = ev.thinking;
                } else return;
                paintRewrite();
              }
            }) || ''), tut.format);
          } finally { clearInterval(tick); }
        };
        stepAt(1, 15, '正在按你的意见重写正文…', null, '');
        let out = '';
        /* ---------- 先试「补丁模式」：小改动不该等五分钟 ----------
           判断是纯文本启发式（不花 AI 调用，判断本身要等半分钟就本末倒置了）。
           补丁套不上、或模型说这是整篇重做，就原样回到下面的全文重写 —— 慢但正确。
           ⚠️ 意见里点名了重写范围（"从「X」往后重写"）时直接走全文重写：
           补丁只能改一处，把整段重排交给它只会白花一轮 AI 调用。 */
        const scopeHint = tutGuard.parseEditScope(feedback, tut.content || '');
        const ed = scopeHint.mode === 'doc'
          ? effort.editEffort(feedback, tutPatch)
          : { mode: 'full', why: scopeHint.why };
        console.log('[tutorial] 修改复杂度判断：' + ed.mode + ' ← ' + ed.why);
        if (tut.format === 'md' && ed.mode === 'patch') {
          try {
            const rel = tutPatch.pickRelevant(tut.content, feedback, 26000);
            console.log('[tutorial] 试补丁模式：相关章节 ' + (rel.whole ? '全文(' + rel.excerpt.length + '字)' : rel.picked.join(' / ')));
            stepAt(1, 10, rel.whole ? '正在定位要改的地方（只改这一处，不重写全文）…'
              : '正在定位要改的地方（已挑出相关章节：' + rel.picked.slice(0, 2).join('、') + '）…', null, '');
            /* 补丁也给它两轮：第一轮常犯的毛病是 REPLACE 里漏了收尾的 ```
               或把代码块截断（实测翻过：补丁套上后 ```json 没闭合）。
               补丁本身很快，重试一次比掉进"全文重写几分钟"划算得多。 */
            let patchHint = '';
            for (let pr = 1; pr <= 2 && !out; pr++) {
              const praw = String(await ai.text({
                prompt: buildTutorialPatchPrompt(tut, feedback, rel.excerpt, rel.whole, editCodeBlock) + patchHint,
                model: currentModel(), timeoutMs: 300000, signal, scene: '教程局部修改',
                onEvent: ev => {
                  const t2 = ev.thinking || ev.text;
                  if (t2) { thinkTail = t2; stepAt(null, null, null); }
                }
              }) || '');
              const parsed = tutPatch.parsePatches(praw);
              if (parsed.needFull) {
                console.log('[tutorial] 模型判定为整篇重做，转全文重写');
                stepAt(1, 15, '这次改动涉及整篇，正在重写正文…', null, '');
                break;
              }
              if (!parsed.patches.length) {
                console.log('[tutorial] 补丁模式没解析出补丁（回文长度 ' + praw.length + '），' + (pr < 2 ? '再试一次' : '转全文重写'));
                if (pr >= 2) break;
                patchHint = '\n\n【⚠️ 上一次你没有按格式输出】请严格按 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 三行标记输出补丁，不要有任何别的文字。';
                continue;
              }
              const ap = tutPatch.applyPatches(tut.content, parsed.patches);
              console.log('[tutorial] 补丁模式第 ' + pr + ' 轮：' + ap.applied + '/' + parsed.patches.length + ' 条命中'
                + (ap.failed.length ? '，未命中：' + ap.failed.join(' | ') : ''));
              if (!ap.ok) {
                if (pr >= 2) { console.log('[tutorial] 补丁两轮都没全部套上，转全文重写（宁可慢也不能只改一半）'); break; }
                /* 差一点就套上时，把没命中的原文片段回给模型让它照抄 —— 比让它凭记忆重写准得多 */
                patchHint = '\n\n【⚠️ 上一轮的这几段 SEARCH 在原文里找不到，必须**逐字**照抄原文再试一次】\n'
                  + ap.failed.map(x => '· ' + x).join('\n');
                continue;
              }
              stepAt(2, 40, '已改好，正在检查完整性…', null, '');
              const chkP = tutIntegrity(ap.text, tut.format);
              if (chkP.ok) { out = ap.text; break; }
              console.log('[tutorial] 补丁第 ' + pr + ' 轮结果结构不合法（' + chkP.issues.join('；') + '）');
              if (pr >= 2) { console.log('[tutorial] 补丁两轮都改坏了结构，转全文重写'); break; }
              patchHint = '\n\n【⚠️ 上一轮的补丁把代码块/可视化块改坏了】' + chkP.issues.join('；')
                + '。请重写补丁：SEARCH 与 REPLACE 里的围栏（```）数量必须一一对应，一个都不能多、不能少；'
                + '如果改动会让篇幅变长，宁少改一点也不要截断代码块。';
            }
          } catch (e) {
            console.log('[tutorial] 补丁模式异常，转全文重写：', e.message);
          }
        }
        if (out) {
          /* 补丁已经改完，跳过全文重写的那些重试/防截断逻辑，
             但下面共用的几道体检（围栏、可视化块、结构、跑题）照跑。 */
          stepAt(3, 62, '正在体检改动结果…', null, '');
          global.__tutScene = 'tutorial_edit';
          let chkP = tutIntegrity(out, tut.format);
          if (!chkP.ok) {
            /* 补丁改坏结构（比如把 ``` 删了）：不修，直接判失败退回全文重写。
               补丁本身就是"改动很小"，这里出问题说明模型抄错了原文。 */
            console.log('[tutorial] 补丁结果的围栏/结构不合法（' + chkP.issues.join('；') + '），退回全文重写');
            out = '';
          }
        }
        /* ---------- 长教程：分节改写（只把要改的那几段发过去） ----------
           为什么要有这条路：全文重写要求模型把整篇重新吐一遍 ——
           9 万字的教程光输出就要 4~6 轮续写（实测 8 万字就常撞"AI 输出过长"），
           9 万字以上更被 TUT_EDIT_MAX 直接拒收，用户根本改不了。
           而意见通常点名了范围（"从「X」到「Y」之前"），那就只改那一段：
           输出量从"整篇"降到"这一段"，范围外的正文逐字拼回、没机会被改坏。 */
        let segFail = '';
        if (!out && tutSeg.shouldSegment(tut.content, scopeHint.mode, SEG_MIN)) {
          try {
          const hsAll = tutGuard.headings(tut.content || '');
          const fIdx = scopeHint.mode === 'range' ? scopeHint.fromIdx : 0;
          const tIdx = (scopeHint.mode === 'range' && Number.isFinite(scopeHint.toIdx)) ? Math.min(scopeHint.toIdx, hsAll.length) : hsAll.length;
          const chunks = tutSeg.splitScopeChunks(tut.content || '', hsAll, fIdx, tIdx, SEG_CHUNK);
          const inScopeChars = chunks.reduce((s2, c) => s2 + c.chars, 0);
          console.log('[tutorial] 分节改写：范围 ' + (fIdx + 1) + '~' + tIdx + ' 节 → ' + chunks.length + ' 块 / ' + inScopeChars + ' 字（原文 ' + String(tut.content || '').length + ' 字）');
          expectChars = Math.max(1500, inScopeChars);
          expectMs = Math.max(45000, Math.min(300000, 25000 + inScopeChars * 1.6));
          rewriteT0 = Date.now(); gotChars = 0; bodyTail = '';
          const outs = [];
          let prevTail = '';
          for (let ci = 0; ci < chunks.length; ci++) {
            stopCheck();
            const c = chunks[ci];
            const info = {
              no: ci + 1, total: chunks.length, text: String(tut.content).slice(c.start, c.end),
              prevTail, nextTitle: tIdx < hsAll.length && ci === chunks.length - 1 ? hsAll[tIdx].title : ''
            };
            stepAt(1, null, '正文较长，正在分段重写（第 ' + (ci + 1) + '/' + chunks.length + ' 段：' + String(c.title).slice(0, 16) + '）…');
            let piece = await runEdit(buildSegmentPrompt(goal, node, tut, feedback, c, info, editCodeBlock));
            piece = tutSeg.cleanSegment(piece, c, info.nextTitle, true);
            /* 一块写得离谱地长（把别的段也带出来了）→ 判定这一段失败，整条路回退到全文重写 */
            if (piece.length > Math.max(4000, c.chars * 2.5)) {
              throw new Error('第 ' + (ci + 1) + ' 段返回长度异常（' + piece.length + ' 字 / 原文 ' + c.chars + ' 字），疑似把别的段也写回来了');
            }
            const uf = unclosedFences(piece);
            if (uf && uf.kind) throw new Error('第 ' + (ci + 1) + ' 段的 ' + uf.kind + ' 没有闭合，分段结果不可用');
            outs.push(piece);
            prevTail = piece;
          }
          out = tutSeg.splice(tut.content || '', chunks, outs);
          stepAt(2, 70, '分段重写完成，正在校验整篇…');
          } catch (e) {
            /* 分段没成 → 回退全文重写（短文/小改还能救）；正文超上限时给一句能照做的提示 */
            segFail = e && e.message ? e.message : String(e);
            console.log('[tutorial] 分节改写没成，回退全文重写：' + segFail);
            expectChars = Math.max(2000, Math.round(origChars * 0.9));
            expectMs = Math.max(60000, Math.min(300000, 45000 + origChars * 1.6));
            rewriteT0 = Date.now(); gotChars = 0; bodyTail = '';
            out = '';
            if (String(tut.content || '').length > TUT_EDIT_MAX) {
              throw new Error('这份教程有 ' + String(tut.content || '').length + ' 字，一次改完超出上限（' + TUT_EDIT_MAX + ' 字）；系统本来会按你点名的范围分段改，但这一次没成（' + segFail + '）。'
                + '请把意见写得更具体一点（**点名到某一节**，写它的标题），或把意见拆小分多次提。原教程没动。');
            }
          }
        }
        if (!out) {
        let out2 = await runEdit(editBase());
        out = out2;
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
          stepAt(1, 55 + round * 5, 'AI 第一次没给出正文，正在让它直接输出全文…', null, '');
          out = await runEdit(editBase() + '\n\n【重要】不要只回复确认、解释或道歉，也不要向我索要任何材料 —— 你需要的原文已经完整包含在上面了。现在直接输出修改后的完整教程正文。');
        }
        if (!out || out.length < 80) {
          console.log('[tutorial] 修改失败：清洗后长度 ' + (out ? out.length : 0) + '，原文长度 ' + String(tut.content || '').length);
          throw new Error(out && out.length
            ? 'AI 这次只返回了 ' + out.length + ' 个字（没写出正文），原教程没动：点「🔄 重试」可原样重跑；若反复如此，多半是模型单次输出上限不够，换 deepseek-chat / deepseek-reasoner 会更稳'
            : 'AI 返回内容为空，请重试');
        }
        // 防截断兜底：原文很长、新文却只有一小截时，宁可报错也不覆盖好教程
        const origLen = String(tut.content || '').length;
        stepAt(2, 70, '正在校验结果…', null, '');
        if (origLen > 3000 && out.length < Math.max(500, Math.floor(origLen * 0.2))) {
          throw new Error('AI 返回内容过短（仅原文 ' + Math.round(out.length / Math.max(1, origLen) * 100) + '%，疑似被截断），原教程没动：点任务上的「🔄 重试」即可原样重跑，或把修改意见拆小一点分多次提');
        }
        /* 结构体检：长度够不代表写完了（线上翻车：目录 12 节、正文只写到第 3 节，
           长度 25k 远超阈值，于是半截教程被当成功写进库，用户点后面几节全没反应）。
           这里改成先自动续写补齐，补不齐就拒收并说明缺什么。 */
        global.__tutScene = 'tutorial_edit';
        let chk = tutIntegrity(out, tut.format);
        if (!chk.ok) {
          console.log('[tutorial] 修改结果疑似截断：' + chk.issues.join('；'));
          stepAt(3, 76, '结果被截断，正在让 AI 补全缺失部分…', null, '');
          const fixed = await repairTruncatedText({
            raw: out, format: tut.format, title: tut.title, issues: chk.issues,
            runText: (p) => ai.text({ prompt: p, model: currentModel(), timeoutMs: 600000, signal, scene: '教程续写' })
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
        }

// 防跑题兜底：标题留着、正文被换成毫不相干的内容时，长度检查拦不住
        // （线上翻车：RAGFlow 教程被改成离线同步引擎）。命中即拒收，原教程不动。
        const drift = topicDrifted(out, tut.content, [tut.title, node && node.title]);
        if (drift) {
          const missed = (drift.anchorEn.length ? drift.anchorEn : drift.anchorZh.length ? drift.anchorZh : drift.strong).slice(0, 4);
          console.log('[tutorial] 修改疑似跑题，拒收。判定依据：' + drift.used + '；新文正文开头：' + drift.newBody);
          throw new Error('AI 新写的内容疑似跑题（正文里找不到“' + missed.join('”“') + '”等主题词），已保留原教程：请换个说法再提意见，或先问它复述一遍要改什么，确认对了再让它写');
        }
        /* 可视化块丢失兜底：用户要"改一下"，结果回来发现演示没了 ——
           这是最刺眼的一种内容丢失，而且长度校验完全看不出来。宁可拒收也不能悄悄交。 */
        const lost = vizLoss(tut.content, out);
        if (lost) {
          console.log('[tutorial] 修改后可视化块从 ' + lost.had + ' 降到 ' + lost.now + '，拒收。丢失块开头：' + lost.gone.join(' / '));
          throw new Error('AI 改完后教程里的可视化演示变少了（原有 ' + lost.had + ' 个，改后只剩 ' + lost.now + ' 个；丢失：'
            + lost.gone.join(' 、 ') + '），已保留原教程：'
            + '请在修改意见里明确写一句"保留所有可视化块"，或点「🔄 重试」原样重跑');
        }
        /* 章节流失兜底：一次"讲清楚一点"的要求，被改成了重写大半本教程。
           静默丢掉"分步实践 / 验收标准 / 面试追问"这类章节，用户过几天才发现。
           ⚠️ 判据分范围（见 tut-guard.js）：用户点名要重写的那一段允许重组，
           只有**范围外**的章节少了、或范围内被删成空壳才算问题。 */
        const lostSec = tutGuard.structureLoss(tut.content, out, feedback, { allowRestructure: allowRestructure });
        if (lostSec) {
          console.log('[tutorial] 结构守卫拒收（' + lostSec.kind + '，' + lostSec.scope.why + '）：'
            + (lostSec.kind === 'lost'
              ? '原有 ' + lostSec.had + ' 节，范围外 ' + lostSec.outScope + ' 节里消失了 ' + lostSec.lost.length + ' 节 → ' + lostSec.lost.map(x => x.title).join(' / ')
              : '范围内原有 ' + lostSec.inScopeChars + ' 字，改后整篇只剩 ' + lostSec.nowLen + ' 字'));
          const scope = lostSec.scope || {};
          const inRange = scope.mode === 'range';
          const e = new Error(lostSec.kind === 'gutted'
            ? '这次改动把「' + scope.fromTitle + '」往后的内容删得太狠了（原文那一段有 ' + lostSec.inScopeChars
              + ' 字，改完整篇只剩 ' + lostSec.nowLen + ' 字），已保留原教程。'
              + '想让 AI 放开手重写，点任务卡片上的「🔓 允许改结构再跑」；也可以把范围拆小一点分多次提'
            : inRange
              ? '这次改动动到了你要保留的章节「' + lostSec.lost.map(x => x.title).join('」「') + '」'
                + '（你要改的是从「' + scope.fromTitle + '」往后的部分，之前那 ' + lostSec.outScope + ' 节应当原样保留），已保留原教程。'
                + '想让 AI 连结构一起重排，点任务卡片上的「🔓 允许改结构再跑」；'
                + '只想改范围外的一小处，请把意见写得更具体（写清楚要改的是哪一节，用它的标题）'
              : '这次改动把教程的章节结构改掉了（原有 ' + lostSec.had + ' 个章节，至少消失了「' + lostSec.lost.map(x => x.title).join('」「') + '」等），已保留原教程：'
                + '只想改某一段的话，请把意见写得更具体（写清楚要改的是哪一节，用它的标题）；'
                + '确实想整篇重写，点任务卡片上的「🔓 允许改结构再跑」或在意见里加上"允许重写结构"');
          /* 这条失败有救：卡片上给一个"允许改结构再跑"的按钮，别让用户去点注定再失败一次的重试 */
          e.allowRestructure = true;
          throw e;
        }
        // 先存旧版（教程版本表），再覆盖正文 —— 改坏了能从历史版本恢复
        stopCheck();
        stepAt(4, 90, '正在保存新版本…', null, '');
        try { saveTutorialVersion(tid, 'AI 修改：' + String(feedback || '').slice(0, 100)); } catch (e) {}
        // 保留历史版本（写入 goal_versions 便于回滚），再覆盖教程内容
        stopCheck();
        try {
          const vid = beginVersion(tut.goal_id, '教程修改：' + String(tut.title || '').slice(0, 20));
          db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(out, nowISO(), tid);
          await finishVersion(goal, vid, '教程修改：' + String(tut.title || '').slice(0, 20), false);
        } catch (e) {
          db.prepare('UPDATE tutorials SET content = ?, updated_at = ? WHERE id = ?').run(out, nowISO(), tid);
        }
        est.forEach(x => { x.state = 'done'; });   // 收尾：全部打勾，别留一个转圈的
        progress(100, '修改完成', { steps: est, thinking: '', eta: '' });
        backup();
        /* 结构有变化就说一声（消失/新增了哪几节）—— 守卫现在允许"范围内重组"，
           那就必须让用户看得见"哪几节没了"，而不是等他过几天自己发现。 */
        tutEditSay(sess, tut, 'ok', out, { structureNote: tutGuard.structureChangeNote(tut.content, out) });
        return { tutorialId: tid, length: out.length };
        } catch (e) {
          /* 用户自己点了停止 ≠ 失败。混在一起报"没改成…原因：已停止"会让人以为出错了。 */
          const stopped = !!(e && (e.cancelled || e.name === 'AbortError'));
          tutEditSay(sess, tut, stopped ? 'stopped' : 'fail', e && e.message, { allowRestructure: !!(e && e.allowRestructure) });
          throw e;
        }
      }
    });
    };
    const taskId = startEditTask();
    // 先落库对话记录（任务在后台跑，记录立刻可见；刷新后从会话里读出来）
    if (sess) {
      const t = nowISO();
      try {
        if (!quiet) {
          db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)')
            .run(tut.goal_id, sess.id, 'user', ('【教程修改 · ' + String(tut.title || '').slice(0, 40) + '】' + feedback).slice(0, 3000), t);
          db.prepare('INSERT INTO chats (goal_id, session_id, role, content, created_at) VALUES (?,?,?,?,?)')
            .run(tut.goal_id, sess.id, 'assistant', ('收到！已把这条修改意见交给 AI（任务 #' + taskId + '），它会保留原有内容、只改需要改的地方。\n\n进度可以在左下角任务中心看到（切页面也不影响）；完成后教程会自动刷新，也可以点「📜 版本对比」回滚。').slice(0, 3000), t);
        }
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
  /* 重命名教程：只改标题，不碰正文（正文走上面的 PUT /api/tutorials/:id）。
     标题去首尾空格（含换行折成空格）、非空、最长 80 字，超长直接截断；
     允许重名（用户自己愿意）。不记版本：版本存的是正文，改名不该占版本名额。 */
  const tutRenameMatch = p.match(/^\/api\/tutorials\/(\d+)\/rename$/);
  if (tutRenameMatch && method === 'POST') {
    const tid = Number(tutRenameMatch[1]);
    const tut = db.prepare('SELECT id, title, goal_id FROM tutorials WHERE id = ?').get(tid);
    if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
    const body = await readBody(req);
    const title = String(body.title == null ? '' : body.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) return sendJSON(res, 400, { error: '标题不能为空' });
    db.prepare('UPDATE tutorials SET title = ?, updated_at = ? WHERE id = ?').run(title, nowISO(), tid);
    backup();
    return sendJSON(res, 200, { ok: true, title, tutorial: db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid) });
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
      const r = await deleteNodeData(id);
      if (!r) return sendJSON(res, 404, { error: '节点不存在' });
      return sendJSON(res, 200, { goal: r.goal });
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
    // 该分类下的组件（含回落到插件默认分类者）显式归入「其它」，否则会被自动检测重新加回。
    // 写空串而不是字符串 '其它'：effectiveCategory 认空串为「用户明确归到其它」。
    for (const c of allComponents()) {
      if (effectiveCategory(c.id, c.category) === name) map[c.id] = '';
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
    /* 「其它」要写成**显式空串**，不能 delete：删掉等于「从没设过」，
       下一次 effectiveCategory 会回落到插件自己声明的分类，卡片当场跳回原分类。 */
    if (category === '其它') map[cid] = ''; else map[cid] = category;
    if (category !== '其它' && !componentCategoryList().includes(category)) {
      const list = componentCategoryList(); list.push(category); saveComponentCategories(list);
    }
    saveComponentCategoryMap(map);
    return sendJSON(res, 200, { ok: true, category: effectiveCategory(cid, comp.category || '其它') });
  }

  /* ---- 后台 AI 任务（切换页面不影响；可并行、可取消） ---- */
  if (p === '/api/tasks' && method === 'GET') {
    const gid = Number(u.searchParams.get('goalId') || 0);
    return sendJSON(res, 200, { tasks: tasks.list(gid || 0), status: tasks.status() });
  }
  /* ---- AI 任务总览（左栏「AI 任务」页）----
     必须扛得住「10 个目标 × 每个 100 条任务」：一次任务一行，历史可能上千条，
     所以**只给汇总 + 分组计数**，具体记录另走分页接口（/api/ai-tasks/history）。
     正在跑的取自内存队列（带 progress / steps / thinking，够画进度与阶段）。

     ⚠️ 历史只认**终态**行。status 还是 queued/running 的行，要么是此刻正在跑的
     （已经在 running 里，再列一遍是重复），要么是旧埋点一次任务写 2~3 行留下的
     幽灵行（那个 bug 已修，但历史数据还在）—— 列出来只会让人以为任务卡住了。 */
  const AIT_TERMINAL = "status IN ('done','failed','cancelled')";
  /* 历史筛选条件：总览的汇总/分组和历史分页**必须用同一套** ——
     否则会出现"筛了今天、分组标题却还写共 30"这种自相矛盾（实测踩到）。 */
  const aitWhere = (uu) => {
    const goal = Number(uu.searchParams.get('goal') || 0);
    const status = String(uu.searchParams.get('status') || '');
    const days = Number(uu.searchParams.get('days') || 0);
    const qq = String(uu.searchParams.get('q') || '').trim().slice(0, 60);
    const fromTs = String(uu.searchParams.get('from') || '').slice(0, 40);
    const toTs = String(uu.searchParams.get('to') || '').slice(0, 40);
    const where = [AIT_TERMINAL], args = [];
    if (goal) { where.push('goal_id = ?'); args.push(goal); }
    /* goal_id=0 是「未关联目标」的真实分组；0 在 JS 里是 falsy，会被上面的 if 跳过，
       所以前端要精确取它时传 goalExp=zero（否则拉回来的是全部目标的行）。 */
    if (!goal && String(uu.searchParams.get('goalExp') || '') === 'zero') { where.push('goal_id = 0'); }
    if (['done', 'failed', 'cancelled'].includes(status)) { where.push('status = ?'); args.push(status); }
    /* created_at 老行是 'YYYY-MM-DD HH:MM:SS'、新行是 ISO（带 T），归一化后再比 */
    if (days > 0 && !fromTs) { where.push("REPLACE(created_at,' ','T') >= ?"); args.push(new Date(Date.now() - days * 864e5).toISOString()); }
    /* from/to 是**完整 ISO 时刻**（前端按本地日边界算好再换成 UTC）。
       不让前端传 "2026-10-12" 这种日期串 —— 数据是 toISOString() 存的 UTC，
       拿本地日期跟 UTC 串比会把"今天"切错 8 小时。 */
    if (fromTs) { where.push("REPLACE(created_at,' ','T') >= ?"); args.push(fromTs); }
    if (toTs) { where.push("REPLACE(created_at,' ','T') < ?"); args.push(toTs); }
    if (qq) { where.push('title LIKE ?'); args.push('%' + qq + '%'); }
    return { sql: where.join(' AND '), args };
  };
  if (p === '/api/ai-tasks' && method === 'GET') {
    const live = tasks.list(0).filter(t => t.status === 'running' || t.status === 'queued');
    const goals = db.prepare('SELECT id,title FROM goals ORDER BY id').all();
    const gtitle = {};
    for (const g of goals) gtitle[g.id] = g.title;
    const W = aitWhere(u);
    const sum = db.prepare('SELECT COUNT(*) n, SUM(status=\'done\') d, SUM(status=\'failed\') f, SUM(status=\'cancelled\') c FROM task_runs WHERE ' + W.sql).get(...W.args);
    /* 按目标聚合：每个目标一行汇总（总数 / 成败 / 最近一次时间），默认折叠就靠它 */
    const grp = db.prepare('SELECT goal_id, COUNT(*) n, SUM(status=\'done\') d, SUM(status=\'failed\') f,'
      + ' SUM(status=\'cancelled\') c, MAX(REPLACE(created_at,\' \',\'T\')) last_at, MAX(id) last_id'
      + ' FROM task_runs WHERE ' + W.sql + ' GROUP BY goal_id ORDER BY last_id DESC').all(...W.args);
    return sendJSON(res, 200, {
      running: live.map(t => Object.assign({}, t, { goalTitle: gtitle[t.goalId] || '' })),
      summary: { total: sum.n || 0, done: sum.d || 0, failed: sum.f || 0, cancelled: sum.c || 0 },
      groups: grp.map(g => ({
        goalId: g.goal_id,
        /* goal_id=0 = 没关联目标（不是目标被删），文案要区分开 */
        goalTitle: g.goal_id ? (gtitle[g.goal_id] || '（目标已删除）') : '（未关联目标）',
        goalMissing: g.goal_id > 0 && !gtitle[g.goal_id],   /* 目标已被删除 → 前端给一个「清理」入口 */
        total: g.n, done: g.d || 0, failed: g.f || 0, cancelled: g.c || 0, lastAt: g.last_at || ''
      })),
      goals: goals.map(g => ({ id: g.id, title: g.title })),
      status: tasks.status()
    });
  }
  /* 某个筛选条件下的一页历史。筛选全在 SQL 里做 —— 前端过滤等于迟早把上千条
     全塞进浏览器。offset/limit 分页，前端一组一次先拉 20 条。 */
  if (p === '/api/ai-tasks/history' && method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') || 20)));
    const offset = Math.max(0, Number(u.searchParams.get('offset') || 0));
    const W = aitWhere(u);
    const total = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE ' + W.sql).get(...W.args).n;
    const rows = db.prepare('SELECT id,goal_id,node_id,type,title,status,error,cost_ms,created_at'
      + ' FROM task_runs WHERE ' + W.sql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...W.args, limit, offset);
    const goals = db.prepare('SELECT id,title FROM goals').all();
    const gtitle = {};
    for (const g of goals) gtitle[g.id] = g.title;
    return sendJSON(res, 200, {
      total, offset, limit, hasMore: offset + rows.length < total,
      rows: rows.map(r => ({
        runId: r.id, goalId: r.goal_id,
        goalTitle: r.goal_id ? (gtitle[r.goal_id] || '（目标已删除）') : '（未关联目标）',
        type: r.type, title: r.title, status: r.status, error: r.error || '',
        costMs: r.cost_ms || 0, createdAt: r.created_at
      }))
    });
  }


  /* ---- 清理 AI 任务历史 ----
     背景：目标删掉之后，它的任务历史还留在 task_runs 里，任务中心就长期挂着
     几行「（目标已删除）」；用户既点不进去、也没法去掉（真实反馈）。
     两个删除入口都**只动 task_runs**，不碰目标/教程/产出等任何真实数据；删前备份。 */
  if (p === '/api/ai-tasks/history' && method === 'DELETE') {
    const gid = Number(u.searchParams.get('goal') || 0);
    if (!gid) return sendJSON(res, 400, { error: '要指定要清理的目标（goal）' });
    /* 目标还在 → 拒绝：这是「清理已删除目标的残留」，不是「清空某个目标的历史」。 */
    if (db.prepare('SELECT id FROM goals WHERE id = ?').get(gid)) {
      return sendJSON(res, 400, { error: '这个目标还在，不能批量清理它的任务历史' });
    }
    const n = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id = ?').get(gid).n;
    if (!n) return sendJSON(res, 200, { ok: true, deleted: 0 });
    try { backup(); } catch (e) {}
    db.prepare('DELETE FROM task_runs WHERE goal_id = ?').run(gid);
    return sendJSON(res, 200, { ok: true, deleted: n });
  }
  /* 一键清理所有已删除目标的残留历史（分组上方那个按钮走它） */
  if (p === '/api/ai-tasks/history/orphans' && method === 'DELETE') {
    const ORPHAN = 'goal_id > 0 AND goal_id NOT IN (SELECT id FROM goals)';
    const n = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE ' + ORPHAN).get().n;
    if (!n) return sendJSON(res, 200, { ok: true, deleted: 0 });
    try { backup(); } catch (e) {}
    db.prepare('DELETE FROM task_runs WHERE ' + ORPHAN).run();
    return sendJSON(res, 200, { ok: true, deleted: n });
  }
  /* 删单条历史（任务中心每行末尾的「删除」） */
  const aitRunDel = p.match(/^\/api\/ai-tasks\/history\/(\d+)$/);
  if (aitRunDel && method === 'DELETE') {
    const rid = Number(aitRunDel[1]);
    if (!db.prepare('SELECT id FROM task_runs WHERE id = ?').get(rid)) {
      return sendJSON(res, 404, { error: '任务记录不存在' });
    }
    try { backup(); } catch (e) {}
    db.prepare('DELETE FROM task_runs WHERE id = ?').run(rid);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 检索增强（RAG）：状态 / 重建索引 / 检索预览 ---- */
  if (p === '/api/rag/status' && method === 'GET') {
    const gid = Number(u.searchParams.get('goalId') || 0);
    return sendJSON(res, 200, rag.status(gid || 0));
  }
  const ragBuildMatch = p.match(/^\/api\/goals\/(\d+)\/rag\/build$/);
  if (ragBuildMatch && method === 'POST') {
    try { return sendJSON(res, 200, { ok: true, ...rag.buildIndex(Number(ragBuildMatch[1])) }); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  const ragSearchMatch = p.match(/^\/api\/goals\/(\d+)\/rag\/search$/);
  if (ragSearchMatch && method === 'POST') {
    const gid = Number(ragSearchMatch[1]);
    const rbody = await readBody(req).catch(() => ({}));
    const q = String(rbody.q || rbody.query || '').trim();
    if (!q) return sendJSON(res, 400, { error: '请输入检索词' });
    const hits = await rag.search(gid, q, { k: Math.min(20, Number(rbody.k) || 8) });
    return sendJSON(res, 200, {
      ok: true,
      hits: hits.map(h => ({ source_id: h.source_id, title: h.title, site: h.site, kind: h.kind, quality: h.quality, score: Math.round((h.score || 0) * 1000) / 1000, text: String(h.text || '').slice(0, 400) }))
    });
  }
  const taskCancelMatch = p.match(/^\/api\/tasks\/(\d+)\/cancel$/);
  if (taskCancelMatch && method === 'POST') {
    return sendJSON(res, 200, tasks.cancel(Number(taskCancelMatch[1])));
  }
  /* 失败重试：用当初那份入参重新提交一个新任务（用户不用把意见/命令再打一遍）。
     旧任务保留（还能看到它当时的报错），新任务是独立的一条。
     body.allow_restructure = 卡片上的「🔓 允许改结构再跑」：
     结构守卫拦下的那类失败，原样重跑必然再失败一次，必须带着这个标记重跑才有意义。 */
  const taskRetryMatch = p.match(/^\/api\/tasks\/(\d+)\/retry$/);
  if (taskRetryMatch && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return sendJSON(res, 200, await tasks.retry(Number(taskRetryMatch[1]), { allowRestructure: !!(b && b.allow_restructure) }));
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
    let bundle;
    try { bundle = exportComponentBundle(String(compExportMatch[1])); }
    catch (e) { return sendJSON(res, e.code === 'not_found' ? 404 : 400, { error: e.message }); }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(bundle.id + '.component.json')}`
    });
    return res.end(JSON.stringify(bundle, null, 2));
  }
  if (p === '/api/components/install' && method === 'POST') {
    const body = await readBody(req);
    let bundle = body && body.bundle;
    if (typeof bundle === 'string') { try { bundle = JSON.parse(bundle); } catch (e) { return sendJSON(res, 400, { error: '组件文件不是合法 JSON' }); } }
    let r;
    try { r = installComponentBundle(bundle); }
    catch (e) { return sendJSON(res, e && (e.code === 'bad_input' || e.code === 'forbidden') ? 400 : 500, { error: e.message }); }
    // 导入时可指定分类（批量导入时统一归类）
    let category = '';
    const wantCat = String(body.category || '').trim();
    if (wantCat && wantCat !== '__auto__') {
      const cat = wantCat.slice(0, 24);
      const map = componentCategoryMap();
      map[r.id] = cat;
      saveComponentCategoryMap(map);
      const list = componentCategoryList();
      if (!list.includes(cat)) { list.push(cat); saveComponentCategories(list); }
      category = cat;
    } else {
      category = effectiveCategory(r.id, (FILE_PLUGINS.find(x => x.id === r.id) || {}).category);
    }
    return sendJSON(res, 201, { ok: true, id: r.id, loaded: r.loaded, name: (bundle && bundle.name) || r.id, category, replaced: r.replaced });
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
        fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
        fs.mkdirSync(USER_PUBLIC_PLUGIN_DIR, { recursive: true });
        fs.writeFileSync(path.join(USER_PLUGIN_DIR, cid + '.js'), bundle.server);
        if (bundle.client) fs.writeFileSync(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.js'), bundle.client);
        if (typeof bundle.style === 'string' && bundle.style.trim()) fs.writeFileSync(path.join(USER_PUBLIC_PLUGIN_DIR, cid + '.css'), bundle.style);
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
    try { const r = uninstallComponentBundle(String(compDelMatch[1])); return sendJSON(res, 200, { ok: true, id: r.id }); }
    catch (e) { return sendJSON(res, e.code === 'not_found' ? 404 : 400, { error: e.message }); }
  }
  const compStagePreview = p.match(/^\/api\/component-staging\/([A-Za-z0-9_-]+)\/preview$/);
  if (compStagePreview && method === 'GET') {
    const stage = commandBus.getComponentStage ? commandBus.getComponentStage(compStagePreview[1]) : null;
    if (!stage) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><meta charset="utf-8"><h1>暂存组件不存在或已过期</h1>');
      return true;
    }
    let current = null;
    try { current = exportComponentBundle(stage.summary && stage.summary.id ? stage.summary.id : stage.bundle.id); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderComponentPreviewPage(stage, current));
    return true;
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
      /* core 判定必须查 allComponents()：核心组件不只有 BUILTIN_COMPONENTS 里的，
         文件插件（如 uimanager）也可以声明 scope:'core'，它们同样不可按目标关。 */
      const isCore = allComponents().some(x => x.id === pid && x.scope === 'core');
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
  /* 宿主 Agent（思而行作为插件运行时由宿主注入）：状态 + 免重启刷新。
     宿主插件写 DATA_DIR/host-agent.json 后 POST 这里，模型列表立刻进设置/对话下拉。 */
  if (p === '/api/host-agent' && method === 'GET') {
    return sendJSON(res, 200, ai.hostAgentStatus());
  }
  if (p === '/api/host-agent/refresh' && method === 'POST') {
    let r;
    try { r = ai.mountHostAgent(); }
    catch (e) { return sendJSON(res, 500, { mounted: false, error: (e && e.message) || 'mount failed' }); }
    return sendJSON(res, 200, r);
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
    /* 用户重新保存连接 = 可能换了地址/模型/配置：清掉「不支持识图」标记，下次发图会重新试一次 */
    try { clearVisionUnsupported(); } catch (e) {}
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
  /* 当前模型能不能识图：前端粘图时先问一句，避免发出去才被告知不支持。 */
  if (p === '/api/ai/can-vision' && method === 'GET') {
    const mdl = String(u.searchParams.get('model') || '').trim() || currentModel();
    return sendJSON(res, 200, {
      ok: modelSupportsVision(mdl),
      learned_unsupported: isVisionUnsupported(mdl),
      fallback_model: (function () {
        const vm = configuredVisionModel();
        return (vm && String(vm).toLowerCase() !== String(mdl).toLowerCase()) ? vm : '';
      })(),
      model: mdl,
      vision_model: (function () { try { return currentVisionModel(); } catch (e) { return ''; } })(),
      reason: '默认按可识图处理；模型回应不能识图后会被标记（重新保存 AI 连接可清除）'
    });
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
  /* 向量接口测试（检索增强用）：先按请求把配置存下去，再真实嵌一条最短文本 */
  if (p === '/api/ai/emb-test' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) {}
    const set = (k, v) => { if (v != null) setSetting(k, String(v).trim()); };
    if (body.baseUrl != null) set('emb_base_url', body.baseUrl);
    if (body.model != null) set('emb_model', body.model);
    if (body.apiKey != null && String(body.apiKey).trim() && !/^•+$/.test(String(body.apiKey).trim())) set('emb_api_key', body.apiKey);
    try {
      const v = await ai.embedTexts(['检索增强连通性测试']);
      const dim = (v && v[0] && v[0].length) || 0;
      return sendJSON(res, 200, { ok: true, dim, model: ai.embConfig().model });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, message: e.message });
    }
  }

  if (p === '/api/backup' && method === 'POST') {
    backup();
    const count = fs.readdirSync(BACKUP_DIR).filter(x => x.startsWith('sierxing-')).length;
    return sendJSON(res, 200, { ok: true, count });
  }
  /* 某次备份 vs 上一次备份，差了什么 */
  if (p === '/api/backup/diff' && method === 'GET') {
    const name = String(u.searchParams.get('name') || '');
    const list = backupList();                      // 由新到旧
    const i = list.findIndex(x => x.name === name);
    if (i < 0) return sendJSON(res, 404, { error: '这份备份已经不在了' });
    const cur = list[i];
    const prev = list[i + 1];                      // 时间上更早的那一份
    if (!prev) return sendJSON(res, 200, { first: true, name: cur.name, items: [] });
    return sendJSON(res, 200, { first: false, name: cur.name, prev: prev.name, ...backupDiff(prev.name, cur.name) });
  }
  /* 备份列表：设置页「最近备份」用 */
  if (p === '/api/backup/list' && method === 'GET') {
    const items = backupList();
    const totalBytes = items.reduce((a, x) => a + (x.size || 0), 0);
    return sendJSON(res, 200, {
      items, keep: keepBackups(), totalBytes,
      dir: BACKUP_DIR, dbSize: (() => { try { return fs.statSync(DB_PATH).size; } catch (e) { return 0; } })()
    });
  }
  /* 改保留份数：立刻按新值裁掉多出来的 */
  if (p === '/api/backup/keep' && method === 'POST') {
    const body = await readBody(req);
    const n = parseInt(body.keep, 10);
    if (!(n >= 1 && n <= 500)) return sendJSON(res, 400, { error: '保留份数需在 1~500 之间' });
    setSetting('backup_keep', String(n));
    pruneBackups();
    return sendJSON(res, 200, { ok: true, keep: n, count: backupList().length });
  }
  /* 删掉某一份备份（只认备份目录里的合法文件名，防路径逃逸） */
  if (p === '/api/backup/delete' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '');
    if (!/^sierxing-[0-9]{8}-[0-9]{6}\.db$/.test(name)) return sendJSON(res, 400, { error: '备份名不合法' });
    const f = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(f)) return sendJSON(res, 404, { error: '这份备份已经不在了' });
    fs.unlinkSync(f);
    return sendJSON(res, 200, { ok: true });
  }
  /* 恢复某一份备份：先把「当前状态」存一份再覆盖，安全网先铺好 */
  if (p === '/api/backup/restore' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '');
    if (!/^sierxing-[0-9]{8}-[0-9]{6}\.db$/.test(name)) return sendJSON(res, 400, { error: '备份名不合法' });
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) return sendJSON(res, 404, { error: '这份备份已经不在了' });
    // 校验能不能当库打开，避免用一个坏文件把现有数据顶掉
    try {
      const probe = new (require('node:sqlite').DatabaseSync)(src, { readOnly: true });
      probe.prepare('SELECT COUNT(*) c FROM goals').get();
      probe.close();
    } catch (e) {
      return sendJSON(res, 400, { error: '这份备份读不出来（可能已损坏），已取消恢复' });
    }
    try { fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `sierxing-${stamp()}.db`)); } catch (e) {}
    fs.copyFileSync(src, DB_PATH);
    return sendJSON(res, 200, { ok: true, needRestart: true });
  }
  if (p === '/api/export/json' && method === 'GET') {
    const goals = db.prepare('SELECT * FROM goals ORDER BY id').all();
    const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all();
    let conditions = [];
    try { conditions = db.prepare('SELECT * FROM goal_conditions ORDER BY id').all(); } catch (e) {}
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
    return res.end(JSON.stringify({ exportedAt: nowISO(), goals, nodes, conditions, sources, tutorials, tutorialVersions, settings, pluginData }, null, 2));
  }
  if (p === '/api/import/json' && method === 'POST') {
    const body = await readBody(req);
    const goals = Array.isArray(body.goals) ? body.goals : [];
    if (!goals.length) return sendJSON(res, 400, { error: '没有可导入的目标' });
    backup();
    db.exec('DELETE FROM nodes; DELETE FROM sources; DELETE FROM goals; DELETE FROM goal_versions; DELETE FROM tutorials; DELETE FROM tutorial_versions; DELETE FROM chats; DELETE FROM chat_sessions; DELETE FROM code_repo_files; DELETE FROM goal_conditions;');
    rag.dropAll();
    for (const pl of PLUGINS) { try { if (typeof pl.clearAll === 'function') pl.clearAll(pluginCtx()); } catch (e) {} }
    const insG = db.prepare('INSERT INTO goals (id,title,profile,materials,weekly_hours,deadline,status,error,summary,constraints,plugins,ebook_pref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const g of goals) insG.run(g.id != null ? Number(g.id) : null, g.title || '', g.profile || '', g.materials || '', g.weekly_hours || '', g.deadline || '', g.status || 'draft', g.error || '', g.summary || '', typeof g.constraints === 'string' ? g.constraints : JSON.stringify(g.constraints || []), typeof g.plugins === 'string' ? g.plugins : JSON.stringify(g.plugins || {}), typeof g.ebook_pref === 'string' ? g.ebook_pref : JSON.stringify(g.ebook_pref || {}), g.created_at || nowISO(), g.updated_at || nowISO());
    const insC = db.prepare('INSERT INTO goal_conditions (id,goal_id,title,detail,acceptance,jd_ref,priority,source,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const c of (Array.isArray(body.conditions) ? body.conditions : [])) {
      if (!c || !c.title) continue;
      insC.run(c.id != null ? Number(c.id) : null, Number(c.goal_id), String(c.title), c.detail || '', c.acceptance || '', c.jd_ref || c.jd || '', c.priority || 'must', c.source || 'plan', Number(c.sort_order || 0), c.created_at || nowISO(), c.updated_at || nowISO());
    }
    const insN = db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,condition_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of (Array.isArray(body.nodes) ? body.nodes : [])) insN.run(n.id != null ? Number(n.id) : null, Number(n.goal_id), n.parent_id ? Number(n.parent_id) : null, Number(n.level || 0), n.title || '', n.detail || '', n.artifact || '', n.acceptance || '', n.hours || '', typeof n.sources === 'string' ? n.sources : JSON.stringify(n.sources || []), n.status || 'todo', Number(n.condition_id || 0), Number(n.sort_order || 0), n.created_at || nowISO(), n.updated_at || nowISO());
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
    /* 快照里的 condition_id 可能指向后来被删掉的条件；只保留当前仍然存在的 id，
       否则节点会挂在一个不存在的条件上（条件页既看不到它、也统计不到）。 */
    const validConds = new Set(db.prepare('SELECT id FROM goal_conditions WHERE goal_id = ?').all(gid).map(c => Number(c.id)));
    for (const n of sorted) {
      const newParent = n.parent_id ? (idMap.get(n.parent_id) || null) : null;
      const condId = validConds.has(Number(n.condition_id)) ? Number(n.condition_id) : 0;
      insertNode(gid, newParent, n.level || 0, n.title, n.detail, safeParse(n.sources) || [], n.sort_order || 0,
        { artifact: n.artifact, acceptance: n.acceptance, hours: n.hours, condition_id: condId });
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
      /* 检索增强：向量模型独立配置（很多服务商没有 /embeddings，如 DeepSeek） */
      rag_enabled: (getSetting('rag_enabled', '1') || '1') !== '0',
      /* 信息源把关（搜集时 AI 判读的门槛；存本机、全局沿用） */
      collect_review: (getSetting('collect_review', '1') || '1') !== '0',
      collect_min_score: getSetting('collect_min_score', '3'),
      collect_candidates: getSetting('collect_candidates', '220'),
      collect_per_site: getSetting('collect_per_site', '12'),
      collect_full: (getSetting('collect_full', '1') || '1') !== '0',
      collect_full_max: getSetting('collect_full_max', '60000'),
      emb_base_url: getSetting('emb_base_url', ''),
      emb_has_key: !!getSetting('emb_api_key', ''),
      emb_model: getSetting('emb_model', ''),
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
    /* 检索增强（RAG）：开关 + 向量模型独立配置（地址/模型留空 = 未配置，退化为关键词检索） */
    if (body.rag_enabled != null) setSetting('rag_enabled', body.rag_enabled ? '1' : '0');
    /* 信息源把关设置（收集时 AI 判读的门槛、候选上限、全文抓取） */
    for (const k of ['collect_review', 'collect_min_score', 'collect_candidates', 'collect_per_site', 'collect_full', 'collect_full_max']) {
      if (body[k] != null) set(k, body[k]);
    }
    if (body.emb_base_url != null) set('emb_base_url', body.emb_base_url);
    if (body.emb_model != null) set('emb_model', body.emb_model);
    if (body.emb_api_key != null && String(body.emb_api_key).trim() && !/^•+$/.test(String(body.emb_api_key).trim())) set('emb_api_key', body.emb_api_key);
    if (body.emb_api_key === '') setSetting('emb_api_key', '');
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
  /* 用户功能组件的前端脚本/样式放数据目录 plugins-client/，逻辑路径仍是 /plugins/<id>.js|.css：
     用户版本优先（可覆盖程序目录里早期导入的同名组件），没有再回落到 public/。 */
  let userFile = '';
  if (rel.indexOf('plugins/') === 0) {
    const alt = path.join(USER_PUBLIC_PLUGIN_DIR, rel.slice('plugins/'.length));
    if (alt.startsWith(USER_PUBLIC_PLUGIN_DIR)) userFile = alt;
  }
  const finish = function (filePath, buf) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    let out = buf;
    if (rel === 'index.html') {
      // 入口页注入版本戳：发版/重启后前端必加载最新 js/css，不再被缓存坑
      let html = buf.toString('utf8');
      html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta name="asset-v" content="' + ASSET_V + '">');
      html = html.replace('href="/style.css"', 'href="/style.css?v=' + ASSET_V + '"');
      html = html.replace('src="/sdk.js"', 'src="/sdk.js?v=' + ASSET_V + '"');
      html = html.replace('src="/app.js"', 'src="/app.js?v=' + ASSET_V + '"');
      html = injectLanguageHtml(html, req);
      out = Buffer.from(html);
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(out);
  };
  const readUser = function () {
    if (!userFile) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(userFile, function (err2, buf2) {
      if (err2) { res.writeHead(404); return res.end('not found'); }
      finish(userFile, buf2);
    });
  };
  if (userFile && fs.existsSync(userFile)) return fs.readFile(userFile, function (err, buf) { if (err) return readUser(); finish(userFile, buf); });
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (userFile) return readUser();
      res.writeHead(404); res.end('not found'); return;
    }
    finish(file, buf);
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
    /* 内置 UI 插件源码（ui/plugins/builtin/<id>/）—— 页面插件住 ui/ 下，不走 public/ 静态。
       只放行 index.js / style.css / manifest.json，路径校验防穿越。 */
    const builtinUiMatch = u.pathname.match(/^\/ui\/plugins\/builtin\/([a-z0-9._-]+)\/(index\.js|style\.css|manifest\.json)$/i);
    if (builtinUiMatch) {
      const pid = builtinUiMatch[1], file = builtinUiMatch[2];
      const full = path.join(UI_PLUGIN_DIR_BUILTIN, pid, file);
      const rel = path.relative(UI_PLUGIN_DIR_BUILTIN, full);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        try {
          const body = fs.readFileSync(full);
          const type = /\.js$/i.test(file) ? 'application/javascript; charset=utf-8'
            : /\.css$/i.test(file) ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8';
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
          return res.end(body);
        } catch (e) { /* 落到下面 404 */ }
      }
    }
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
  /* 开机自启（systemd 用户服务）起来的实例环境里没有 DISPLAY，xdg-open 会静默失败：
     补一份显示环境再喊浏览器（见 gui-env.js） */
  else { try { execFile('xdg-open', [url], { env: guiEnv() }, () => {}); } catch (e) {} }
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

/* 分节生成模块在这里才初始化：它要用到本文件里定义的一堆提示词块
   （goalHeader / vizSpecLines / nodeSourcesBlock …），而 require 必须早于它们。
   所以 require 工厂时把函数引用注进去，而不是把那些函数搬进 tut-plan.js。 */
tutPlan = require('./tut-plan')({
  goalHeader, goalQaBlock, constraintsBlock, siblingScopeBlock,
  digestsBlock, nodeSourcesBlock, sourcesIndexBlock, vizSpecLines
});
