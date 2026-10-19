'use strict';
/**
 * 思而行 · AI 接入层
 * ------------------------------------------------------------------
 * 支持两类提供方，可在「设置」页面切换，也可用环境变量配置：
 *
 *  1. openai   —— 任意 OpenAI 兼容接口（默认）
 *        · OpenAI / DeepSeek / 通义千问(DashScope) / Kimi / 智谱GLM /
 *          硅基流动 / OpenRouter / Ollama / LM Studio / vLLM …
 *        · 只需要「API 地址 + 密钥 + 模型名」，不需要安装 opencode
 *        · 支持流式输出、思维链(reasoning_content)与图片输入
 *
 *  2. opencode —— 本机已安装 opencode CLI 时可选用（保留原有能力）
 *
 * 连接（connection）与模型池
 * ------------------------------------------------------------------
 * 原来的设计只有「一套地址 + 一个模型」，于是用户要手填 Base URL 和模型名，
 * 而且换个模型就得改设置、把对话里选好的模型顶掉。
 * 现在引入「连接」：一条连接 = 一个服务商 + 一套地址/密钥，可以挂多个模型。
 *
 *   · 设置页管理连接（可加多个 Base URL），每条连接里勾选要用的模型
 *   · 对话时按 连接::模型 选具体用哪个，两条连接里的模型不会重名打架
 *   · 老配置（单地址 + ai_model）自动迁移成一条连接，不丢用户原有设置
 *
 * 对外接口：
 *   ai.init({ getSetting, setSetting, appDir })
 *   ai.text({ prompt, model, images, timeoutMs, onEvent }) -> Promise<string>
 *     model 可为 '模型名' 或 '连接id::模型名'
 *   ai.connections() / ai.saveConnections() / ai.addConnection() / ai.removeConnection()
 *   ai.modelsFor(connId) -> { models: string[], error }
 *   ai.modelPool() -> [{ id, connId, connName, model, label }]
 *   ai.chatUrl / ai.test() -> Promise<{ ok, message, sample, provider, model }>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

let ctx = { getSetting: () => '', setSetting: () => {}, appDir: process.cwd() };
function log(...a) { try { console.log(...a); } catch (e) {} }

/* ---------------- 常用服务商的官方地址与模型 ---------------- */
/* 选服务商 → 自动填好 Base URL，用户不用手打；模型列表则在填好地址与密钥后
   向该地址的 /models 现取，取不到就退回这里的建议值。 */
/* 各家可调用的模型名（2026-10 核对过官方文档）。
   说明：① 这只是「点服务商后立刻能点的」种子；填好密钥点「获取可用模型」
   会向该地址的 /models 现取最新列表，取不到才用这里。② 每张卡另有手动输入框，
   官方改名/出新模型时用户可自己加，不会被这份名单卡住。 */
const PROVIDERS = [
  /* 已亲手核对 https://api-docs.deepseek.com/quick_start/pricing/：
     现只有 deepseek-flash（V4.1-Flash，支持视觉）与 deepseek-v4-pro（不支持视觉）。
     老的 deepseek-chat / deepseek-reasoner 已不在定价页。 */
  { id: 'deepseek', name: 'DeepSeek', brand: 'DS', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], vision: 'deepseek-flash', docs: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', name: '通义千问', brand: 'QW', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-plus', 'qwen-turbo', 'qwen-max'], vision: 'qwen-vl-max', docs: 'https://bailian.console.aliyun.com/' },
  /* 已亲手核对 https://platform.kimi.com/docs/models：
     moonshot-v1-* 全系 2026-08-31 下线；现为 kimi-k3 系列。地址仍是 api.moonshot.cn/v1。 */
  { id: 'moonshot', name: 'Kimi', brand: 'KM', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'], vision: 'kimi-k3', docs: 'https://platform.kimi.com/console/api-keys' },
  /* 已亲手核对 https://docs.bigmodel.cn/cn/guide/start/model-overview：
     API 侧用小写 id（glm-5.3 等）。 */
  { id: 'zhipu', name: '智谱 GLM', brand: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'], vision: 'glm-4.6v', docs: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'siliconflow', name: '硅基流动', brand: 'SF', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3.5-122B-A10B', 'moonshotai/Kimi-K2.6', 'zai-org/GLM-5.2'], vision: '', docs: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openai', name: 'OpenAI', brand: 'OA', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1'], vision: 'gpt-4o', docs: 'https://platform.openai.com/api-keys' },
  /* 已用公开接口 https://openrouter.ai/api/v1/models 实测（466 个），取各家旗舰做种子 */
  { id: 'openrouter', name: 'OpenRouter', brand: 'OR', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.6', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'], vision: '', docs: 'https://openrouter.ai/keys' },
  { id: 'baidu', name: '百度千帆', brand: 'BD', baseUrl: 'https://qianfan.baidubce.com/v2', models: ['ernie-5.1', 'ernie-5.0', 'ernie-4.5-turbo-128k', 'ernie-4.5-turbo-32k'], vision: 'ernie-4.5-turbo-vl-32k', docs: 'https://console.bce.baidu.com/qianfan/ais/console/apikey' },
  { id: 'volcengine', name: '火山方舟', brand: 'VE', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915', 'deepseek-v4-1-flash-260910', 'deepseek-v3-250324'], vision: 'doubao-seed-2-1-pro-260915', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'tencent', name: '腾讯混元', brand: 'HY', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-a13b'], vision: 'hunyuan-vision', docs: 'https://cloud.tencent.com/document/product/1729' },
  /* 已亲手核对 https://ollama.com/library（按 Pulls 排序，tag 为模型页实际标签） */
  { id: 'ollama', name: '本地 Ollama', brand: 'OL', baseUrl: 'http://localhost:11434/v1', models: ['qwen3:8b', 'llama3.1:8b', 'deepseek-r1:8b', 'qwen2.5:7b', 'gemma3:4b', 'mistral:7b', 'gpt-oss:20b', 'llava:7b'], vision: 'gemma3:4b', noKey: true, docs: 'https://ollama.com' },
  /* OpenCode Zen：官方 AI 网关，OpenAI 兼容直调（/chat/completions）。
     模型列表接口是公开的（无 key 也能取到 86 个），调用才要 key。
     key 去 https://opencode.ai/auth 登录后复制。免费款以 -free 结尾。 */
  { id: 'zen', name: 'OpenCode Zen', brand: 'ZEN', baseUrl: 'https://opencode.ai/zen/v1', models: ['space-bunny-free', 'big-pickle', 'mimo-v2.6-flash-free', 'ling-3.1-flash-free', 'longcat-2.5-preview-free', 'fledge-alpha-free', 'nemotron-3-ultra-free', 'muse-spark-1.3-contributor-free'], vision: '', docs: 'https://opencode.ai/auth' },
  { id: 'lmstudio', name: 'LM Studio', brand: 'LM', baseUrl: 'http://localhost:1234/v1', models: [], vision: '', noKey: true, docs: 'https://lmstudio.ai' },
  { id: 'custom', name: '其他 / 自填', brand: '···', baseUrl: '', models: [], vision: '', docs: '' },
  /* opencode 也放进服务商列表：前端按服务商按钮统一渲染，
     点它时先探本机装没装，探测通过才列出可用模型。
     没有这一项的话 opencode 就没有「选模型」的地方 —— 那正是用户报的毛病。 */
  { id: 'opencode', name: 'opencode CLI', brand: 'OC', baseUrl: '', models: [], vision: '', isOpencode: true, docs: 'https://opencode.ai/docs' }
];
/* 可添加的 Agent 类型（与 API 连接并列的第二种连接）。
   以后加 codex 之类只往这里添一项，前端卡片按这个列表渲染。 */
const AGENTS = [
  { id: 'opencode', name: 'opencode CLI', brand: 'OC', hint: '本机已安装 opencode 时可选，模型与登录都由它自己管' }
];
function agentById(id) { return AGENTS.find(a => a.id === id) || null; }
function providerById(id) { return PROVIDERS.find(p => p.id === id) || null; }

/* ---------------- 宿主 Agent 自动接入 ----------------
 * 场景：思而行作为某个 Agent（Claude Code / Cursor / DSH…）的插件被打开时，
 * 「当前 Agent」应该自动出现在设置 → AI 接入方式里，它的模型列表直接可选。
 *
 * 注入方式（宿主插件二选一，推荐文件）：
 *   ① 环境变量：SIERXING_HOST_AGENT_NAME / _URL / _KEY / _MODELS / _VISION
 *   ② DATA_DIR/host-agent.json（或 SIERXING_HOST_AGENT_CONFIG 指向的 JSON）：
 *      { "name":"DSH", "url":"http://127.0.0.1:8091/v1",
 *        "key":"", "models":["deepseek-v4.1-flash-1017"], "vision":"" }
 * 写文件后调 POST /api/host-agent/refresh 即可免重启生效。
 *
 * ⚠️ 边界：这里只负责「登记地址 + 模型列表」。思而行要真的用这些模型对话，
 * 宿主必须真的提供 OpenAI 兼容 /chat/completions（或一个兼容网关）。
 * MCP 是「宿主 → 思而行」单向的，思而行无法反向调用宿主 Agent 本身。 */
const HOST_AGENT_ID = 'host-agent';
const HOST_AGENT_PROVIDER = 'host';
const HOST_AGENT_FILE = 'host-agent.json';

function parseModelList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)) || ''))
      .map(s => String(s).trim()).filter(Boolean);
  }
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return parseModelList(j);
  } catch (e) { /* 不是 JSON，按逗号/换行分隔 */ }
  return s.split(/[\n,，]/).map(x => String(x).trim()).filter(Boolean);
}

function hostAgentFile() {
  const explicit = env('SIERXING_HOST_AGENT_CONFIG');
  if (explicit) return explicit;
  return (ctx && ctx.dataDir) ? path.join(ctx.dataDir, HOST_AGENT_FILE) : '';
}

/** 撤掉宿主自动创建的服务商与连接（宿主插件卸载 / 配置文件被删时）。 */
function pruneHostAgent() {
  const list = connections();
  const keep = list.filter(x => x.id !== HOST_AGENT_ID && x.providerId !== HOST_AGENT_PROVIDER);
  const removed = keep.length !== list.length;
  const pi = PROVIDERS.findIndex(x => x.id === HOST_AGENT_PROVIDER);
  if (pi >= 0) PROVIDERS.splice(pi, 1);
  if (removed) {
    saveConnections(keep);
    /* 只剩宿主连接时，saveConnections 不会清老的单值设置 —— 这里补一刀，
       否则 currentModel 还会指向已经消失的宿主地址。 */
    if (!keep.some(c => c.enabled && c.purpose !== 'vision')) {
      ctx.setSetting('ai_provider', 'openai');
      ctx.setSetting('ai_base_url', '');
      ctx.setSetting('ai_api_key', '');
      ctx.setSetting('ai_model', '');
      ctx.setSetting('ai_vision_model', '');
    }
  }
  return { pruned: removed };
}

/** 读宿主注入的配置；地址或模型列表缺一不可，否则视为「宿主没接」。 */
function hostAgentConfig() {
  let file = {};
  const fp = hostAgentFile();
  if (fp) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j && typeof j === 'object') file = j;
    } catch (e) { file = {}; }
  }
  const name = env('SIERXING_HOST_AGENT_NAME') || String(file.name || '').trim();
  const rawUrl = env('SIERXING_HOST_AGENT_URL') || String(file.url || file.baseUrl || '').trim();
  const apiKey = env('SIERXING_HOST_AGENT_KEY') || String(file.key || file.apiKey || '').trim();
  const models = parseModelList(env('SIERXING_HOST_MODELS') || file.models || '');
  const vision = env('SIERXING_HOST_AGENT_VISION') || String(file.vision || file.visionModel || '').trim();
  if (!rawUrl || !models.length) return null;
  return {
    name: name || '当前宿主 Agent',
    baseUrl: rawUrl.replace(/\/+$/, ''),
    apiKey, models, vision,
    file: fp || ''
  };
}

function env(name, alt) {
  const v = process.env[name];
  if (v != null && String(v).trim() !== '') return String(v).trim();
  if (alt) for (const a of alt) {
    const v2 = process.env[a];
    if (v2 != null && String(v2).trim() !== '') return String(v2).trim();
  }
  return '';
}

/** 连一条 id：时间戳 + 随机，避免同一毫秒建两条时重号 */
let connSeq = 0;
function newConnId() {
  connSeq++;
  return 'c' + Date.now().toString(36) + connSeq.toString(36);
}

/** 读出所有连接。老配置（单地址 + ai_model）会被自动折算成一条「默认」连接，
    这样升级后用户原来填好的地址/密钥/模型仍然直接可用。 */
function connections() {
  let list = [];
  try { list = JSON.parse(ctx.getSetting('ai_connections', '') || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter(c => c && typeof c === 'object').map(normalizeConn);
  if (!list.length) {
    const legacy = legacyAsConn();
    if (legacy) list = [legacy];
  }
  return list;
}
function normalizeConn(c) {
  const pid = String((c && c.providerId) || '');
  const p = pid ? providerById(pid) : null;
  const nm = String((c && c.name) || '').trim();
  const provider = (c && c.provider) === 'opencode' ? 'opencode' : 'openai';
  /* kind: api（默认，走 Base URL）/ agent（走本机 Agent，如 opencode）。
     老数据没有 kind：provider 是 opencode 的算 agent，其余算 api。 */
  const kind = (c && c.kind) === 'agent' || ((!(c && c.kind)) && provider === 'opencode') ? 'agent' : 'api';
  return {
    id: String((c && c.id) || newConnId()),
    /* 连接名前端不再让用户填（按服务商自动起）。
       这里是兜底：名字空了就按服务商补，别让界面上出现「未命名」。 */
    name: nm || (p ? p.name : '自定义连接'),
    provider,
    kind,
    /* purpose: chat（默认，进对话下拉）/ vision（识图专用，不进对话下拉）。
       有的服务商没有视觉模型，用户单加一条识图连接即可。 */
    purpose: (c && c.purpose) === 'vision' ? 'vision' : 'chat',
    providerId: String((c && c.providerId) || ''),
    baseUrl: String((c && c.baseUrl) || '').trim(),
    apiKey: String((c && c.apiKey) || ''),
    /* 勾选要用的模型。留空表示「这条连接下还没选模型」，
       调用时会退回 conn.defaultModel，再退回连接预设里的第一个。 */
    models: Array.isArray(c.models) ? c.models.map(String).filter(Boolean) : [],
    defaultModel: String((c && c.defaultModel) || ''),
    visionModel: String((c && c.visionModel) || ''),
    /* agent 参数（NoTools 之类）：只对 agent 连接有意义，放卡片里单独设，
       不再用全局那一个。api 连接忽略它。 */
    agent: String((c && c.agent) || ''),
    /* 单次请求超时毫秒：0 = 跟全局，卡片里可单独设 */
    timeoutMs: Math.max(0, Number((c && c.timeoutMs) || 0) || 0),
    enabled: !c || c.enabled !== false
  };
}
/** 老设置折算成连接。环境变量也算 —— 只用环境变量的人不该被迁移逻辑改动行为。 */
function legacyAsConn() {
  const get = ctx.getSetting;
  const dbOnly = k => (get(k, '') || '').toString().trim();
  const provider = (dbOnly('ai_provider') || env('SIERXING_PROVIDER', ['AI_PROVIDER']) || 'openai').toLowerCase();
  const baseUrl = dbOnly('ai_base_url') || env('SIERXING_API_BASE', ['OPENAI_BASE_URL', 'OPENAI_API_BASE']);
  const apiKey = dbOnly('ai_api_key') || env('SIERXING_API_KEY', ['OPENAI_API_KEY']);
  const model = dbOnly('ai_model') || dbOnly('model') || env('SIERXING_MODEL', ['OPENAI_MODEL']);
  if (!baseUrl && !apiKey && !model) return null;
  return normalizeConn({
    id: 'default', name: '默认连接', provider,
    kind: provider === 'opencode' ? 'agent' : 'api', purpose: 'chat',
    providerId: PROVIDERS.find(p => p.baseUrl && (p.baseUrl === baseUrl || p.baseUrl.replace(/\/v\d+$/, '') === String(baseUrl).replace(/\/v\d+$/, '').replace(/\/+$/, '')))?.id || '',
    baseUrl, apiKey,
    models: model ? [model] : [],
    defaultModel: model,
    visionModel: dbOnly('ai_vision_model') || dbOnly('vision_model') || env('SIERXING_VISION_MODEL', ['OPENAI_VISION_MODEL'])
  });
}
function saveConnections(list) {
  ctx.setSetting('ai_connections', JSON.stringify((list || []).map(normalizeConn)));
}
/** 找连接；找不到返回 null（不要静默回落到第一条 —— 那会用错地址和密钥去请求） */
function findConn(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return connections().find(c => c.id === want) || null;
}

/** '连接id::模型名' → 拆开；只给了模型名 → 返回 null 交给默认逻辑 */
function splitModelRef(ref) {
  const s = String(ref || '').trim();
  const i = s.indexOf('::');
  if (i < 0) return null;
  return { connId: s.slice(0, i), model: s.slice(i + 2) };
}

/** 某条连接实际该用的模型：显式指定 > 该连接的默认 > 勾选的第一个 > 预设第一个 */
function connModel(c, want) {
  if (want) return want;
  if (c.defaultModel) return c.defaultModel;
  if (c.models.length) return c.models[0];
  const p = providerById(c.providerId);
  return (p && p.models[0]) || '';
}

/**
 * 生成一次调用所需的配置。
 * modelRef 可以是：
 *   · 'connId::model'  → 用那条连接的地址/密钥 + 那个模型
 *   · 'model'          → 依次在已启用连接里找谁有这个模型
 *   · 空               → 用第一条启用连接
 * 这是「同一个 Base URL 挂多个模型、多条 Base URL 各挂各的」能成立的关键：
 * 地址与密钥跟着连接走，模型名只是挂在下面的标签。
 */
function cfg(modelRef) {
  const get = ctx.getSetting;
  const list = connections();
  const enabled = list.filter(c => c.enabled);
  /* 默认走第一条启用的对话连接 —— 识图专用连接不参与默认，
     否则聊天会走到识图连接的地址上去。 */
  const enabledChat = enabled.filter(c => c.purpose !== 'vision');
  const ref = splitModelRef(modelRef);
  let conn = null;
  let model = '';

  if (ref) {
    conn = findConn(ref.connId);
    if (!conn) throw new Error('找不到对应的模型连接（可能已被删除），请重新选择模型');
    model = ref.model;
  } else if (modelRef) {
    // 裸模型名：在启用连接里找第一条支持它的。找不到就退回第一条对话连接，
    // 让请求照常发出去、由接口报「模型不存在」—— 比在这里抛个含糊错好排查。
    model = String(modelRef).trim();
    conn = enabled.find(c => c.models.includes(model) || c.defaultModel === model)
      || standaloneVisionFor(model)
      || enabledChat[0] || null;
  } else {
    conn = enabledChat[0] || null;
    model = conn ? connModel(conn) : '';
  }

  if (!conn) {
    // 一条连接都没有：退回只读的环境变量 / 旧设置，行为与升级前一致
    const pick = (key, envNames, dflt) => {
      const dbVal = (get(key, '') || '').toString().trim();
      if (dbVal) return dbVal;
      return (envNames ? env(envNames[0], envNames.slice(1)) : '') || dflt || '';
    };
    const provider = (pick('ai_provider', ['SIERXING_PROVIDER', 'AI_PROVIDER'], 'openai') || 'openai').toLowerCase();
    const dbOnly = k => (get(k, '') || '').toString().trim();
    return {
      provider: provider === 'opencode' ? 'opencode' : 'openai',
      baseUrl: pick('ai_base_url', ['SIERXING_API_BASE', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'], ''),
      apiKey: pick('ai_api_key', ['SIERXING_API_KEY', 'OPENAI_API_KEY'], ''),
      model: model || dbOnly('ai_model') || dbOnly('model') || env('SIERXING_MODEL', ['OPENAI_MODEL']),
      visionModel: dbOnly('ai_vision_model') || dbOnly('vision_model') || env('SIERXING_VISION_MODEL', ['OPENAI_VISION_MODEL']),
      agent: pick('ai_opencode_agent', ['SIERXING_OPENCODE_AGENT'], 'NoTools'),
      timeoutMs: Number(pick('ai_timeout_ms', ['SIERXING_AI_TIMEOUT_MS'], '300000')) || 300000,
      connId: ''
    };
  }

  const p = providerById(conn.providerId);
  const isAgent = conn.kind === 'agent' || conn.provider === 'opencode';
  return {
    provider: isAgent ? 'opencode' : 'openai',
    kind: conn.kind,
    connId: conn.id,
    connName: conn.name,
    baseUrl: conn.baseUrl,
    /* 密钥留空时回落到环境变量：老用户可能在 settings 里没填但环境里有 */
    apiKey: conn.apiKey || env('SIERXING_API_KEY', ['OPENAI_API_KEY']),
    model: connModel(conn, model),
    visionModel: conn.visionModel || (p ? p.vision : ''),
    /* agent 参数跟连接走（卡片里单独设），没设才回落到全局旧值 */
    agent: (isAgent && conn.agent) || get('ai_opencode_agent', '') || env('SIERXING_OPENCODE_AGENT') || 'NoTools',
    /* 超时跟连接走，没设才回落全局 */
    timeoutMs: conn.timeoutMs || Number(get('ai_timeout_ms', '') || env('SIERXING_AI_TIMEOUT_MS') || '300000') || 300000
  };
}

/** 独立识图配置是否命中这个模型名：命中就返回合成连接（自带地址密钥） */
function standaloneVisionFor(model) {
  const v = standaloneVision();
  if (v && v.models.includes(model)) return v;
  return null;
}
/** 独立识图配置（设置页"识图模型"专区，用户自己填地址/密钥/模型名）。
 *  有的服务商没有视觉模型，跟对话连接绑在一起讲不清楚，干脆单列。
 *  只在 vis_base_url 填了时生效；不填则走原来的链路，老用户不受影响。 */
function standaloneVision() {
  const base = (ctx.getSetting('vis_base_url', '') || '').toString().trim();
  const model = (ctx.getSetting('vision_model', '') || '').toString().trim();
  if (!base || !model) return null;
  return normalizeConn({
    id: 'vision-standalone', name: '识图模型', kind: 'api', purpose: 'vision',
    provider: 'openai', providerId: '',
    baseUrl: base,
    apiKey: (ctx.getSetting('vis_api_key', '') || '').toString(),
    models: [model], defaultModel: model, visionModel: ''
  });
}
/** 对话栏的模型下拉：把所有启用连接里勾选的模型摊平成一张列表。
 *  id = '连接id::模型名'，label 带连接名，两条连接里同名模型也不会混。 */
function modelPool() {
  const out = [];
  for (const c of connections()) {
    if (!c.enabled) continue;
    if (c.purpose === 'vision') continue;   // 识图专用不进对话下拉
    for (const m of c.models) out.push({ id: c.id + '::' + m, connId: c.id, connName: c.name, model: m, label: c.name + ' · ' + m });
  }
  return out;
}
/** 识图模型池：只含 purpose=vision 的连接。全局识图选择器的数据源。 */
function modelPoolVision() {
  const out = [];
  for (const c of connections()) {
    if (!c.enabled) continue;
    if (c.purpose !== 'vision') continue;
    for (const m of c.models) out.push({ id: c.id + '::' + m, connId: c.id, connName: c.name, model: m, label: c.name + ' · ' + m });
  }
  return out;
}

/* ---------------- 通用工具 ---------------- */

function withTimeout(ms, outer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(5000, ms || 300000));
  const onAbort = () => { try { ctrl.abort(); } catch (e) {} };
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); }
  };
}

/* ---------------- 读响应体：必须自己盯着 signal 和"多久没数据" ----------------
 * ⚠️ fetch 的 signal 只管到「响应头到达」为止：openaiRequest 一拿到 res 就 t.done()，
 * 超时计时器和取消监听全被摘掉 —— 而大模型 99% 的时间花在**吐正文**上。
 * 于是出现两种真实翻过的故障：
 *   ① 取消不生效：用户点了停止，当前这次调用照样把整段输出读完才结束
 *      （实测：取消后仍多打 8 次调用、多跑 10.6 秒）；
 *   ② 挂住不返回：上游连上了却一直不吐字，没有任何超时会触发，任务永远 running。
 * 所以 response body 一律走这里读：外 signal 一变红立刻中断，idleMs 没有字节就判超时。
 * idleMs 可用 SIERXING_AI_IDLE_MS 覆盖（测试用得到）。 */
const AI_IDLE_MS = Math.max(5000, Number(process.env.SIERXING_AI_IDLE_MS) || 120000);
function cancelledErr() { const e = new Error('已停止'); e.cancelled = true; return e; }
function bodyTimeoutErr(idleMs) {
  return new Error('AI 响应超时：超过 ' + Math.round(idleMs / 1000) + ' 秒没有收到任何内容（服务商或网络卡住了），可在设置里调大超时时间或稍后重试');
}
async function pumpBody(res, opts) {
  const o = opts || {};
  const signal = o.signal || null;
  const idleMs = Math.max(5000, Number(o.idleMs) || AI_IDLE_MS);
  if (!res || !res.body) return '';   // 没有 body（204 之类）：当作空内容，交给调用方判错
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let idle = null, timedOut = false, aborted = false, out = '';
  const kill = () => { try { reader.cancel(); } catch (e) {} };
  const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { timedOut = true; kill(); }, idleMs); };
  const onAbort = () => { aborted = true; kill(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  arm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      if (!value) continue;
      const piece = dec.decode(value, { stream: true });
      /* 给了 onChunk 就边收边处理（SSE 流）；没给就把整段攒起来返回（非流式 JSON）。 */
      if (o.onChunk) o.onChunk(piece);
      else out += piece;
    }
  } catch (e) {
    if ((signal && signal.aborted) || aborted) throw cancelledErr();
    if (timedOut) throw bodyTimeoutErr(idleMs);
    throw e;
  } finally {
    if (idle) clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', onAbort);
    kill();
  }
  /* reader.cancel() 会让挂着的 read() 以 done:true 收场，所以循环外再判一次 */
  if ((signal && signal.aborted) || aborted) throw cancelledErr();
  if (timedOut) throw bodyTimeoutErr(idleMs);
  return out;
}

function httpErrorText(status, body) {
  let extra = '';
  try {
    const j = JSON.parse(body);
    extra = (j.error && (j.error.message || j.error)) || j.message || '';
  } catch (e) {
    extra = String(body || '').slice(0, 300);
  }
  const tips = {
    401: '密钥无效或未授权（检查 API Key）',
    403: '没有权限（检查密钥权限/模型是否开通）',
    404: '接口地址不对（检查 API 地址，通常需要以 /v1 结尾）',
    429: '请求过于频繁或额度不足',
    500: '服务端错误',
    502: '网关错误（代理/中转不可用）',
    503: '服务暂不可用'
  };
  return `AI 接口返回 ${status}${tips[status] ? '：' + tips[status] : ''}${extra ? ' · ' + String(extra).slice(0, 300) : ''}`;
}

function candidateUrls(base, tail) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未配置 AI 接口地址（在「设置」里填写，或设置环境变量 SIERXING_API_BASE）');
  if (new RegExp('\\/' + tail + '$').test(b)) return [b];
  const list = [b + '/' + tail];
  if (!/\/v\d+$/.test(b)) list.push(b + '/v1/' + tail);
  return list;
}

/* ---------------- OpenAI 兼容接口 ---------------- */

function openaiHeaders(c) {
  const h = { 'Content-Type': 'application/json' };
  if (c.apiKey) h.Authorization = 'Bearer ' + c.apiKey;
  return h;
}

function messageContent(prompt, images) {
  if (!images || !images.length) return prompt;
  const parts = [{ type: 'text', text: prompt }];
  for (const img of images) {
    let url = img;
    if (!/^data:/.test(img)) {
      try {
        const buf = fs.readFileSync(img);
        const ext = path.extname(img).toLowerCase().replace('.', '') || 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        url = `data:image/${mime};base64,` + buf.toString('base64');
      } catch (e) {
        continue;
      }
    }
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

async function openaiRequest(c, body, timeoutMs, signal) {
  const urls = candidateUrls(c.baseUrl, 'chat/completions');
  let lastErr = null;
  for (const url of urls) {
    const t = withTimeout(timeoutMs || c.timeoutMs, signal);
    try {
      const res = await fetch(url, { method: 'POST', headers: openaiHeaders(c), body: JSON.stringify(body), signal: t.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if ((res.status === 404 || res.status === 400) && url !== urls[urls.length - 1]) { lastErr = new Error(httpErrorText(res.status, text)); continue; }
        throw new Error(httpErrorText(res.status, text));
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') {
          if (signal && signal.aborted) { const err = new Error('已停止'); err.cancelled = true; throw err; }
          throw new Error('AI 请求超时（可在设置里调大超时时间）');
        }
      if (String(e.message || '').includes('fetch failed') || e.cause) {
        if (url === urls[urls.length - 1]) throw new Error('无法连接 AI 接口：' + (c.baseUrl || '(未配置地址)') + '（检查地址、网络或代理）');
        continue;
      }
      throw e;
    } finally {
      t.done();
    }
  }
  throw lastErr || new Error('AI 请求失败');
}

async function openaiText(c, opts) {
  const { prompt, model, images, timeoutMs, onEvent, signal } = opts;
  const useStream = !!(onEvent && opts.stream !== false);
  const mdl = model || c.model;
  if (!mdl) throw new Error('未配置模型名（在「设置」里填写，或设置环境变量 SIERXING_MODEL）');
  // 输出上限：默认 16000（覆盖完整教程/长回复），各调用方可通过 maxTokens 覆盖；
  // 不传时很多接口默认只给 4k 左右，长教程会被拦腰截断。
  /* let 而不是 const：推理模型可能把输出额度全花在 reasoning_content 上，
   正文一个字没输出就撞上限 —— 这时要能就地加大额度重试（见下面 openaiText 里的判断）。 */
  let maxTokens = Number(opts.maxTokens) || 16000;
  if (!useStream) return openaiLongText(c, { model: mdl, prompt, images, timeoutMs, signal, onEvent, maxTokens });
  /* ⚠️ 这里不要有「试发一次」的 fetch：曾经非流式分支提前 return 后，下面还留着
     一份旧的一次性请求代码，结果每次流式调用都向 AI 发两次相同请求、第一次的
     响应被直接丢弃 —— 对话/规划/教程全走这条，等于用户付双倍费用。
     流式请求统一由下面的 for(;;) 循环发起（它还要处理 finish_reason=length 的续写）。 */
  /* 流式解析（SSE）。**要记 finish_reason** —— 模型因为输出上限被截断时
     （finish_reason=length），这段文本是断的；长 JSON（规划骨架、问卷、教程）会直接解析失败。
     以前流式这条路完全不处理截断（只有非流式的 openaiLongText 会续写），
     真实翻过：规划骨架写一半断掉 → 报"没有可用阶段"。 */
  const readStream = async r0 => {
    let buf = '', text = '', lastThink = '', finish = '';
    await pumpBody(r0, {
      signal,
      onChunk: chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let j;
          try { j = JSON.parse(payload); } catch (e) { continue; }
          const ch = j.choices && j.choices[0];
          if (ch && ch.finish_reason) finish = ch.finish_reason;
          const delta = ch && (ch.delta || ch.message);
          if (!delta) continue;
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            lastThink += delta.reasoning_content;
            onEvent({ thinking: lastThink.replace(/\s+/g, ' ').slice(-60) });
          } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
            lastThink += delta.reasoning;
            onEvent({ thinking: lastThink.replace(/\s+/g, ' ').slice(-60) });
          }
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            onEvent({ text: delta.content });
          }
        }
      }
    });
    return { text, finish };
  };
  let text = '', rounds = 0, grown = 0;
  let messages = [{ role: 'user', content: messageContent(prompt, images) }];
  for (;;) {
    const r = await readStream(await openaiRequest(c, { model: mdl, messages, stream: true, max_tokens: maxTokens }, timeoutMs, signal));
    /* 同 openaiLongText：一字正文都没输出就撞上限 = 推理把预算吃干了，
       这时续写只会拿到「请把尾部粘给我」这种废话。加预算重试，仍不行就报人话。 */
    if (!r.text && r.finish === 'length') {
      if (grown < 2 && maxTokens < 65536) {
        maxTokens = Math.min(65536, maxTokens * 2); grown++;
        messages = [{ role: 'user', content: messageContent(prompt, images) }];
        continue;
      }
      throw new Error('模型把输出额度全用在内部推理上了，一个字正文都没输出就撞上上限（已自动加大额度重试 ' + grown + ' 次仍如此）。'
        + '换 deepseek-chat 等非推理模型，或把这次要求拆小一点');
    }
    text += r.text;
    if (r.finish !== 'length') break;
    rounds++;
    if (rounds >= 4) throw new Error('AI 输出过长（多次续写仍未写完）：请把这次要求拆小一点，分多次提');
    if (onEvent) { try { onEvent({ thinking: '输出较长，正在继续生成（第 ' + (rounds + 1) + ' 段）…' }); } catch (e2) {} }
    /* 续写只带尾部做衔接：不带全文，省上下文（和非流式那条路一致） */
    messages = [
      { role: 'user', content: messageContent(prompt, images) },
      { role: 'assistant', content: text },
      { role: 'user', content: '（上一条被输出上限截断了）请**直接从最后一个字符接着往下写**，不要重复已输出的内容、不要重新开头、不要加任何说明或前后缀。' + CONTINUE_SUFFIX }
    ];
  }
  if (!text) throw new Error('AI 没有返回内容（检查模型名/额度，或稍后重试）');
  return text;
}

/* 非流式长文本（含截断自动续写）：finish_reason=length 时接着往下要，直到写完 */
const CONTINUE_SUFFIX = '\n\n（上次输出到这里就中断了，请从中断处紧接着继续往下输出剩余部分：不要重复已输出的内容，不要加开头语或解释）';
async function openaiOnce(c, messages, mdl, maxTokens, timeoutMs, signal) {
  const res = await openaiRequest(c, { model: mdl, messages, stream: false, max_tokens: maxTokens }, timeoutMs, signal);
  /* 非流式这两条路（对话/规划/教程都可能走）也一样：body 必须能被取消、也必须有超时。
     idleMs 用这次调用自己的超时额度 —— 非流式本来就是一整段一起到，没有"流式心跳"可依赖。 */
  let j = null;
  try {
    j = JSON.parse(await pumpBody(res, { signal, idleMs: timeoutMs || c.timeoutMs || 300000 }));
  } catch (e) {
    if (e && (e.cancelled || e.name === 'AbortError' || /响应超时/.test(String(e.message)))) throw e;
    j = null;
  }
  const ch = j && j.choices && j.choices[0];
  const text = ch && ch.message && ch.message.content;
  if (typeof text !== 'string') {
    const raw = (j && j.error && (j.error.message || j.error.code)) || '返回内容为空（检查模型名是否正确）';
    throw new Error('AI 返回异常：' + String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300));
  }
  return { text, finish: (ch && ch.finish_reason) || '' };
}
function isTokenLimitError(e) {
  return /max_tokens|maximum context|context length|token[^a-z]*limit|tokens[^a-z]*limit|too long|too_large|content.*too/i.test(String((e && e.message) || ''));
}
async function openaiLongText(c, { model: mdl, prompt, images, timeoutMs, signal, onEvent, maxTokens }) {
  let tokens = maxTokens, shrunk = 0, grown = 0;
  const firstMessages = [{ role: 'user', content: messageContent(prompt, images) }];
  let full = '', rounds = 0;
  let messages = firstMessages;
  for (;;) {
    let r;
    try {
      r = await openaiOnce(c, messages, mdl, tokens, timeoutMs, signal);
    } catch (e) {
      // 部分模型/中转不支持这么大的 max_tokens：减半重试（16k→8k→4k）
      if (isTokenLimitError(e) && tokens > 4000 && shrunk < 2) {
        tokens = Math.floor(tokens / 2); shrunk++;
        messages = firstMessages; full = ''; rounds = 0;
        continue;
      }
      throw e;
    }
    /* ⚠️ 一字正文都没输出就撞上输出上限（finish_reason=length 且内容为空）：
       推理模型（deepseek-flash / reasoner 这类）会把预算先花在 reasoning_content 上，
       正文一个字没轮到预算就耗光了。这时候**续写是续不出来的** ——
       尾部是空的，模型只会回一句「请把已输出内容的尾部粘给我」（实测就收到过这句 27 字），
       于是上层报「AI 只写了 27 字就停了」，看起来像提示词有问题，其实是被推理吃干了。
       正确处理：先把预算加大重试一次；还不行就报人话，别让上层拿到一句废话。 */
    if (!r.text && r.finish === 'length') {
      if (grown < 2 && tokens < 65536) {
        tokens = Math.min(65536, tokens * 2); grown++;
        messages = firstMessages; full = ''; rounds = 0;
        continue;
      }
      throw new Error('模型把输出额度全用在内部推理上了，一个字正文都没输出就撞上上限（已自动加大额度重试 ' + grown + ' 次仍如此）。'
        + '换 deepseek-chat 等非推理模型，或把这次要求拆小一点');
    }
    full += r.text;
    if (r.finish !== 'length') return full;
    rounds++;
    if (rounds >= 4) throw new Error('AI 输出过长（多次续写仍未写完）：请把这次要求拆小一点，分多次提');
    if (onEvent) { try { onEvent({ thinking: '输出较长，正在继续生成（第 ' + (rounds + 1) + ' 段）…' }); } catch (e2) {} }
    /* ⚠️ 续写必须**带上原提示词**。原来这里只发尾部 3000 字，等于从第二轮起
       模型手里只剩一段尾巴：不知道在写什么教程、不知道有哪些格式要求、更不知道
       有 ```viz 可视化块这回事 —— 于是它开始自由发挥。实测后果：改一份 32K 的教程，
       2 个 HTML 可视化块被整体丢掉、27 个章节少了 14 个、全文被换了个结构，
       而长度校验只看总数（还剩 71%）一路放行。流式那条路本来就带全文，这里跟它对齐。 */
    const TAIL = 9000;
    const earlier = full.length - TAIL;
    messages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: (earlier > 0 ? '……（以上你已输出约 ' + earlier + ' 字，其内容与本次任务开头一致，请原样保留，不要重写、不要重排）……\n' : '') + full.slice(-TAIL) },
      { role: 'user', content: '（上一条被输出上限截断了）请**直接从最后一个字符接着往下写**，不要重复已输出的内容、不要重新开头、不要加任何说明或前后缀。' + CONTINUE_SUFFIX }
    ];
  }
}

async function openaiModels(c) {
  const urls = candidateUrls(c.baseUrl, 'models');
  let lastErr = null;
  for (const url of urls) {
    const t = withTimeout(20000);
    try {
      const res = await fetch(url, { headers: openaiHeaders(c), signal: t.signal });
      if (!res.ok) { lastErr = new Error(httpErrorText(res.status, await res.text().catch(() => ''))); continue; }
      const j = await res.json().catch(() => null);
      const list = ((j && j.data) || []).map(x => x && (x.id || x.name)).filter(Boolean).sort();
      if (list.length) return list;
      lastErr = new Error('接口未返回模型列表');
    } catch (e) {
      lastErr = e;
    } finally { t.done(); }
  }
  throw lastErr || new Error('获取模型列表失败');
}

/** 取某条连接可用的模型列表。
 *  openai：问接口的 /models（失败就退回该服务商的建议列表，不让用户卡住）
 *  opencode：跑 `opencode models`
 *  传临时参数（还没保存的地址/密钥）也能取，供设置页「填完先试一下」用。 */
async function fetchModelsFor(target) {
  target = target || {};
  /* 已保存的连接优先按 id 取 —— opencode 连接没有 baseUrl，
     以前掉进 cfg(id) 被当成裸模型名，永远取不到opencode 的列表。 */
  const saved = target.id ? findConn(target.id) : null;
  const provider = target.provider || (saved && saved.provider) || 'openai';
  const providerId = target.providerId || (saved && saved.providerId) || '';
  let c;
  if (provider === 'opencode') {
    c = normalizeConn({
      id: (saved && saved.id) || 'draft',
      name: (saved && saved.name) || 'opencode',
      provider: 'opencode',
      providerId: providerId || 'opencode',
      baseUrl: '', apiKey: '',
      models: (saved && saved.models) || [],
      defaultModel: (saved && saved.defaultModel) || '',
      visionModel: (saved && saved.visionModel) || ''
    });
  } else if (target.baseUrl) {
    /* 未保存的草稿：用调用方给的地址/密钥，但模型勾选仍取已保存的那条（如果有）。
       useVisKey：识图专区密钥框空着时，用已存的 vis_api_key（不然每次取列表都得重填）。
       useEmbKey：检索增强的向量模型配置同理。 */
    const p = providerId ? providerById(providerId) : null;
    const key = target.apiKey || (target.useVisKey ? ctx.getSetting('vis_api_key', '') : '') || (target.useEmbKey ? ctx.getSetting('emb_api_key', '') : '') || (saved && saved.apiKey) || '';
    c = normalizeConn({
      id: (saved && saved.id) || 'draft',
      name: (saved && saved.name) || (p ? p.name : '草稿'),
      provider,
      providerId,
      baseUrl: target.baseUrl,
      apiKey: key,
      models: (saved && saved.models) || [],
      defaultModel: (saved && saved.defaultModel) || '',
      visionModel: (saved && saved.visionModel) || (p ? p.vision : '')
    });
  } else if (saved) {
    c = saved;
  } else {
    c = cfg(undefined);
  }

  if (c.provider === 'opencode') {
    /* 先探装没装。没装就别白等一次 spawn 超时，直接把提示给出去。 */
    const st = opencodeStatus();
    if (!st.installed) return { models: [], error: st.hint };
    try {
      const r = await runOpencode(c, ['models'], 60000);
      /* `opencode models` 的输出是每行一个模型名，可能带 provider 前缀；
         有的版本/系统会打成表格（含 │┃┌ 等制表符）或带对号，统一清理再过滤。
         Windows 上如果双击启动的 exe 继承不到终端 PATH，这里也会空，
         所以失败时把原始输出摘要带回去，前端可一键复制发来排查。 */
      const rawLines = String(r.out).split('\n');
      const models = rawLines
        .map(s => s.trim()
          .replace(/^[│┃┌┐└┘├┤┬┴┼─\s|]+/, '').replace(/[│┃┌┐└┘├┤┬┴┼─\s|]+$/, '')
          .replace(/^[✓✔•*-]\s*/, '').replace(/\s*\(.*\)$/, '').trim())
        .filter(Boolean)
        .filter(s => !/^(provider|model|models|available|available models|name)\b/i.test(s))
        .filter(s => /[a-z0-9]/i.test(s));
      if (models.length) return { models, error: '' };
      const diag = '命令已执行但解析不出模型。原始输出前 500 字：' + String(r.out).slice(0, 500)
        + (r.err ? '；stderr：' + String(r.err).slice(0, 200) : '');
      return { models: [], error: 'opencode 没有返回可识别的模型列表。' + diag, detail: String(r.out).slice(0, 2000) };
    } catch (e) {
      return { models: [], error: e.message, detail: '执行 `opencode models` 失败（双击启动时可能继承不到终端的 PATH，可尝试从终端启动一次）：' + e.message };
    }
  }
  try {
    const models = await openaiModels(c);
    return { models, error: '' };
  } catch (e) {
    /* 取不到就给建议列表：DeepSeek 这类官方接口不一定开放 /models，
       但用户照样要能选模型，不能因为这个把路堵死。 */
    const p = providerById(c.providerId);
    if (p && p.models.length) return { models: p.models.slice(), error: e.message + '（下面是该服务商的常用模型，可直接选）' };
    return { models: [], error: e.message };
  }
}

/* ---------------- opencode CLI（可选） ---------------- */

/**
 * 解析 opencode 可执行文件路径：
 * - Linux/macOS：直接用 PATH 里的 opencode
 * - Windows：opencode 常见是 .cmd/.exe 包装脚本，Node 直接 spawn 会 ENOENT，
 *   这里用 where 找到真实路径；.cmd/.bat 需要通过 cmd.exe 执行。
 */
/**
 * 仅在「使用 opencode CLI」时自动创建 .opencode/opencode.json（NoTools 代理：禁用工具、只输出文本）
 * · 已存在则不覆盖（尊重用户自己的配置）
 * · 不使用 opencode 时不会生成该目录
 */
function ensureOpencodeAgent() {
  try {
    const dir = path.join(ctx.appDir, '.opencode');
    const file = path.join(dir, 'opencode.json');
    if (fs.existsSync(file)) return file;
    const cfg = {
      '$schema': 'https://opencode.ai/config.json',
      agent: {
        NoTools: {
          description: '纯文本输出：禁用所有工具，只根据提示词中的信息作答（思而行 SiErXing 自动生成）',
          mode: 'primary',
          tools: {
            write: false, edit: false, bash: false, read: false, glob: false, grep: false,
            list: false, task: false, skill: false, webfetch: false, websearch: false, codesearch: false
          },
          permission: { '*': 'deny' }
        }
      }
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    log('[ai] 已自动创建 .opencode/opencode.json（NoTools 代理，禁用工具）');
    return file;
  } catch (e) { return ''; }
}

let opencodeCmdCache = null;
function opencodeCommand() {
  if (opencodeCmdCache) return opencodeCmdCache;
  if (process.platform !== 'win32') { opencodeCmdCache = { file: 'opencode', prefix: [] }; return opencodeCmdCache; }
  const cands = [];
  try {
    const out = execFileSync('where', ['opencode'], { encoding: 'utf8', windowsHide: true });
    out.split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(x => cands.push(x));
  } catch (e) {}
  const home = os.homedir();
  for (const p of [
    path.join(home, '.opencode', 'bin', 'opencode.exe'),
    path.join(home, '.opencode', 'bin', 'opencode.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'opencode', 'bin', 'opencode.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'opencode'),
    path.join(process.env.ProgramFiles || '', 'opencode', 'opencode.exe'),
    path.join(process.env.ProgramData || '', 'chocolatey', 'bin', 'opencode.exe')
  ]) { try { if (p && fs.existsSync(p)) cands.push(p); } catch (e) {} }
  const exe = cands.find(x => /\.exe$/i.test(x));
  const shim = cands.find(x => /\.(cmd|bat)$/i.test(x));
  const target = exe || shim || cands[0];
  if (!target) { opencodeCmdCache = { file: 'opencode', prefix: [], missing: true }; return opencodeCmdCache; }
  if (/\.(cmd|bat)$/i.test(target)) opencodeCmdCache = { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', target], resolved: target };
  else opencodeCmdCache = { file: target, prefix: [], resolved: target };
  return opencodeCmdCache;
}
/** opencode 装没装、装在哪。
 *  设置页要先探这个再列模型 —— 少一层「检测 → 刷新按钮」的来回，
 *  否则用户点了才发现没装，界面上却连「检测」的入口都没有。 */
function opencodeStatus() {
  const cmd = opencodeCommand();
  const cands = [];
  if (cmd.resolved) cands.push(cmd.resolved);
  /* Linux/macOS 上 PATH 里的 opencode 没有 resolved，用 which 补一次 */
  if (!cmd.resolved && process.platform !== 'win32') {
    try {
      const out = execFileSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8', timeout: 5000 });
      const w = String(out).trim().split('\n')[0];
      if (w) cands.push(w);
    } catch (e) {}
  }
  let version = '';
  try {
    const r = execFileSync(cmd.file, cmd.prefix.concat(['--version']), {
      encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    version = String(r).trim().split('\n')[0].slice(0, 40);
  } catch (e) {}
  const found = !!(cmd.resolved || cands.length) && !cmd.missing;
  return {
    installed: found,
    resolved: cands[0] || '',
    version,
    /* 没装时给一句能照着做的提示，别只说「未安装」 */
    hint: found ? '' : (process.platform === 'win32'
      ? '未检测到 opencode。Windows 上请确认已安装，且在命令行里执行 `where opencode` 能找到（npm 装的一般在 %APPDATA%\\npm\\opencode.cmd）。'
      : '未检测到 opencode。请先安装（npm i -g opencode），并确认终端里执行 `opencode --version` 有输出。')
  };
}

/** 统一 spawn：提示词通过 stdin 传入（避免 Windows 命令行转义/长度限制问题） */
function spawnOpencode(args, prompt) {
  ensureOpencodeAgent();
  const cmd = opencodeCommand();
  const child = spawn(cmd.file, cmd.prefix.concat(args), {
    cwd: ctx.appDir,
    env: { ...process.env, PWD: ctx.appDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  try {
    if (prompt != null) { child.stdin.write(prompt); }
    child.stdin.end();
  } catch (e) {}
  return child;
}
function opencodeMissingError() {
  const cmd = opencodeCommand();
  return '未找到 opencode 命令' + (process.platform === 'win32'
    ? '（Windows：请确认已安装 opencode 且 `where opencode` 能找到；若用 npm 安装，通常在 %APPDATA%\\npm\\opencode.cmd）。也可以改用「OpenAI 兼容接口」方式接入模型。'
    : '（请确认已安装 opencode，或改用「OpenAI 兼容接口」）') + (cmd.resolved ? '（已尝试：' + cmd.resolved + '）' : '');
}
function runOpencode(c, args, timeoutMs, prompt) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnOpencode(args, prompt == null ? null : prompt); } catch (e) { return reject(new Error(opencodeMissingError())); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('opencode 调用超时')); }, timeoutMs || 300000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new Error(opencodeMissingError())); });
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  });
}

function parseOpencodeJsonl(line) {
  try { return JSON.parse(line); } catch (e) { return null; }
}

/** 从 opencode 的 JSONL 输出里找 {type:'error'}，翻译成人话。
 *  这类错误走 stdout，不走 stderr —— 以前只看 stderr，所以报出来就是一句
 *  没头没尾的"未返回内容"，用户根本不知道是没登录（本次实测就是 403 未登录）。 */
function opencodeStdioError(out) {
  for (const line of String(out || '').split('\n')) {
    const d = parseOpencodeJsonl(line.trim());
    if (!d || d.type !== 'error' || !d.error) continue;
    const et = String(d.error.type || '');
    const msg = String(d.error.message || '');
    if (/agent/i.test(msg) && /(not found|不存在|unknown|无效|invalid)/i.test(msg)) return '';  // 代理问题走重试，不在这里报
    if (/auth|login|401|403|FreeTier|forbidden|unauthorized/i.test(et + ' ' + msg)) {
      /* 实测：CLI 下只有 space-bunny-free 能通，其余免费款都报这个 403。
         直接告诉用户，别让他一个个试。 */
      if (/freetier/i.test(et + ' ' + msg)) {
        return '这个免费模型只能在 OpenCode 内用，CLI 调不动。两条路：'
          + '① Agent 卡里选 opencode/space-bunny-free（当前实测 CLI 可通）；'
          + '② 其余免费款走「OpenCode Zen」API 连接（key 去 opencode.ai/auth 拿）。';
      }
      return 'opencode 本机登录不可用：' + (msg || et) + '（先在终端执行 `opencode auth login` 登录或配好 Key，再点测试）';
    }
    if (/quota|429|insufficient.*fund|UsageLimit|limit exceeded/i.test(et + ' ' + msg)) {
      return 'opencode 账号额度用完了：' + (msg || et) + '（去该账号的控制台充值或等额度重置；也可以换条 API 连接直接调官方接口）';
    }
    if (msg) return 'opencode 报错：' + msg.slice(0, 200);
  }
  return '';
}

function opencodeArgs(c, opts, withAgent) {
  const { model, images } = opts;
  const args = ['run', '--format', 'json', '--auto'];
  if (withAgent && c.agent) args.push('--agent', c.agent);
  if (model || c.model) args.push('-m', model || c.model);
  for (const f of (images || [])) { if (!/^data:/.test(f)) args.push('-f', f); }
  return args;
}
/** 代理不存在时的提示（.opencode 目录被删除等情况，会自动回退到默认代理） */
function isAgentError(msg) {
  return /agent/i.test(String(msg || '')) && /(not found|不存在|unknown|无效|invalid)/i.test(String(msg || ''));
}

/* ---------------- 工具调用 →「它做了什么」里的一步 ----------------
 * opencode 的 --format json 事件里，tool_use 带着完整的 input / output。
 * 但 output 可能是整份文件（几万字），直接塞进 SSE 会把一轮对话撑到几百 KB，
 * 落库更是存一份文件副本。这里只挑「说明它在干什么」的字段并各自截断，
 * 措辞（说人话）交给前端 —— 文案只在一处维护。
 */
const STEP_INPUT_KEYS = ['path', 'filePath', 'pattern', 'query', 'command', 'url', 'description', 'prompt', 'glob', 'include', 'workdir'];
/** 路径缩成「相对应用目录」：绝对路径（/home/xxx/…/public/app.js）对用户没有信息量，还占掉一整行。
    路径正好等于应用目录时返回 '.'（前端显示成「应用目录」），否则会变成空串、看着像没读到东西。 */
function stepShortPath(p) {
  const s = String(p || '');
  const base = String((ctx && ctx.appDir) || '');
  let v = s;
  if (base && (s === base || s.startsWith(base + '/') || s.startsWith(base + path.sep))) {
    v = s.slice(base.length).replace(/^[\\/]/, '');
  }
  if (!v) return s ? '.' : '';
  return v.length > 80 ? '…' + v.slice(-79) : v;
}
function toolStepFromPart(part) {
  const p = part || {};
  const st = (p.state && typeof p.state === 'object') ? p.state : {};
  const raw = (st.input && typeof st.input === 'object') ? st.input : {};
  const input = {};
  for (const k of STEP_INPUT_KEYS) {
    if (raw[k] == null) continue;
    if (Array.isArray(raw[k])) { input[k] = raw[k].slice(0, 6).map(x => String(x).slice(0, 80)); continue; }
    input[k] = String(raw[k]).slice(0, 300);
  }
  /* 写入类工具：正文一个字都不留（几百字白占地方），只留长度 —— 用户想知道的是"动了多大" */
  if (raw.content != null) input.chars = String(raw.content).length;
  if (raw.oldString != null) input.oldChars = String(raw.oldString).length;
  if (raw.newString != null) input.newChars = String(raw.newString).length;
  if (input.path) input.path = stepShortPath(input.path);
  if (input.filePath) input.filePath = stepShortPath(input.filePath);
  if (input.workdir) input.workdir = stepShortPath(input.workdir);
  const step = {
    kind: 'tool',
    tool: String(p.tool || '').slice(0, 40),
    status: String(st.status || '').slice(0, 20),
    input
  };
  const rawOut = String(st.output == null ? '' : st.output);
  const outLines = rawOut.split('\n').map(x => x.trim()).filter(Boolean);
  if (outLines.length) {
    step.out = outLines.join(' ').slice(0, 200);
    /* read 也能读目录（opencode 会把里面的条目列出来）——
       这不是"读了一个文件"，前端要能说成"看了目录里有什么"。 */
    if (step.tool === 'read' && /^Read directory/.test(rawOut)) {
      step.dir = true;
      const em = rawOut.match(/entries \d+-(\d+)/);
      if (em) step.n = Number(em[1]);
    }
    /* 可数的信息单独留一个 n：前端说人话要用（"找到 11 个文件""8 处命中"），
       光靠折叠成一行的 out 数不出来。 */
    if (!step.dir && (step.tool === 'glob' || step.tool === 'list')) step.n = outLines.length;
    const fm = rawOut.match(/^Found (\d+) match/);
    if (fm) step.n = Number(fm[1]);
    const lm = rawOut.match(/lines (\d+)-(\d+)/);
    if (step.tool === 'read' && !step.dir && lm) step.n = Math.max(0, Number(lm[2]) - Number(lm[1]) + 1);
    if (step.tool === 'shell') step.first = outLines[0].slice(0, 140);
  }
  const tm = (st.time && typeof st.time === 'object') ? st.time : {};
  if (tm.start && tm.end) step.ms = Math.max(0, Number(tm.end) - Number(tm.start));
  const title = String(st.title || '').replace(/\s+/g, ' ').trim();
  if (title && title !== step.tool) step.title = title.slice(0, 120);
  return step;
}
async function opencodeText(c, opts) {
  const { prompt, model, images, timeoutMs, onEvent, signal } = opts;
    if (signal && signal.aborted) { const err = new Error('已停止'); err.cancelled = true; throw err; }
  const args = opencodeArgs(c, opts, true);
  // 提示词通过 stdin 传入（Windows 下 cmd 包装脚本 + 长文本更稳）
  if (onEvent) {
    return await new Promise((resolve, reject) => {
      let child;
      try { child = spawnOpencode(args, prompt); } catch (e) { return reject(new Error(opencodeMissingError())); }
      let buf = '', text = '', outAll = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('opencode 调用超时')); }, timeoutMs || 300000);
      child.stdout.on('data', chunk => {
        buf += chunk; outAll += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const d = parseOpencodeJsonl(line);
          if (!d) continue;
          if (d.type === 'text' && d.part && d.part.text) { text += d.part.text; onEvent({ text: d.part.text }); }
          else if (d.type === 'reasoning' && d.part && d.part.text) onEvent({ thinking: String(d.part.text).replace(/\s+/g, ' ').slice(-60) });
          else if (d.type === 'step_start') onEvent({ thinking: '正在分析…' });
          /* 工具调用：以前只报一句"正在使用工具：read"（连它读了哪个文件都不知道）。
             现在把整条工具事件整理成一步发给上层，界面上就能说成人话。 */
          else if (d.type === 'tool_use' && d.part) onEvent({ step: toolStepFromPart(d.part) });
        }
      });
      let errBuf = '';
      child.stderr.on('data', d => { errBuf += d; });
      child.on('error', () => { clearTimeout(timer); reject(new Error(opencodeMissingError())); });
      child.on('close', () => {
        clearTimeout(timer);
        if (text) return resolve(text);
        if (isAgentError(errBuf + outAll)) {
          log('[ai] 代理不可用，改用 opencode 默认代理重试');
          return opencodeText(c, { ...opts, onEvent: null }).then(resolve).catch(reject);
        }
        const se = opencodeStdioError(outAll);
        if (se) return reject(new Error(se));
        reject(new Error('opencode 未返回内容（可在终端执行 opencode run "你好" 检查是否可用）' + (errBuf ? '：' + errBuf.slice(0, 160) : '')));
      });
    });
  }
  let r = await runOpencode(c, args, timeoutMs, prompt);
  let text = '';
  for (const line of String(r.out).split('\n')) {
    if (!line.trim()) continue;
    const d = parseOpencodeJsonl(line);
    if (d && d.type === 'text' && d.part && d.part.text) text += d.part.text;
  }
  if (!text && isAgentError(r.err || r.out)) {
    log('[ai] 代理不可用，改用 opencode 默认代理重试（如需禁用工具，请保留项目里的 .opencode/opencode.json）');
    r = await runOpencode(c, opencodeArgs(c, opts, false), timeoutMs, prompt);
    for (const line of String(r.out).split('\n')) {
      if (!line.trim()) continue;
      const d = parseOpencodeJsonl(line);
      if (d && d.type === 'text' && d.part && d.part.text) text += d.part.text;
    }
  }
  if (!text) {
    const se = opencodeStdioError(r.out);
    if (se) throw new Error(se);
    const errText = String(r.err || '').split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error('opencode 未返回内容' + (errText ? '：' + errText.slice(0, 200) : ''));
  }
  return text;
}

/* ---------------- 对外接口 ---------------- */

/* 把错误消息归类，供失败率指标按原因分布（auth/quota/timeout/network…） */
function statsErrType(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return 'unknown';
  if (/abort|取消|cancel|已停止/.test(s)) return 'cancel';
  if (/timeout|timed out|超时|etimedout/.test(s)) return 'timeout';
  if (/429|quota|额度|余额|rate limit/.test(s)) return 'quota';
  if (/401|403|auth|key|登录/.test(s)) return 'auth';
  if (/enotfound|econnrefused|network|fetch failed|getaddrinfo|dns/.test(s)) return 'network';
  if (/没有返回|截断|不完整|写了一半/.test(s)) return 'bad_output';
  if (/解析|parse|json|格式/.test(s)) return 'parse';
  return 'unknown';
}

/* AI 调用埋点（Q5）。**ai.text() 是所有 AI 调用的唯一出口**（ai.stream 也转调它），
   所以在这里包一层就能覆盖全部 AI 功能：骨架生成 / 教程 / 追问 / 模拟面试 / JD 识别…
   stats 由 server.js 注入（metrics 模块），未注入时完全不启用。 */
let stats = null;

const ai = {
  setStats(fn) { stats = typeof fn === 'function' ? fn : null; return ai; },

  init(options) {
    ctx = {
      getSetting: (options && options.getSetting) || (() => ''),
      setSetting: (options && options.setSetting) || (() => {}),
      appDir: (options && options.appDir) || process.cwd(),
      dataDir: (options && options.dataDir) || process.env.SIERXING_DATA_DIR || ''
    };
    return ai;
  },
  config: cfg,
  /* 连接与模型池 */
  PROVIDERS,
  AGENTS,
  /* 宿主 Agent：把插件宿主注入的模型登记成一条普通连接（设置页/对话下拉直接可用） */
  hostAgentConfig,
  hostAgentStatus() {
    const c = connections().find(x => x.id === HOST_AGENT_ID);
    const cfgHost = hostAgentConfig();
    return {
      available: !!cfgHost,
      configured: !!c,
      id: HOST_AGENT_ID,
      name: (cfgHost && cfgHost.name) || (c && c.name) || '',
      baseUrl: (cfgHost && cfgHost.baseUrl) || (c && c.baseUrl) || '',
      models: cfgHost ? cfgHost.models.slice() : (c ? c.models.slice() : []),
      enabled: c ? c.enabled : false,
      file: hostAgentFile()
    };
  },
  mountHostAgent() {
    const cfgHost = hostAgentConfig();
    if (!cfgHost) {
      /* 宿主插件卸了/文件被删了：把自动创建的那条连接一起撤掉，别留一个连不上的死条目。
         只清理 providerId=host 的自动连接，不碰用户自己加的任何连接。 */
      const p = pruneHostAgent();
      return { mounted: false, reason: 'no_host_config', pruned: p.pruned, file: hostAgentFile() };
    }
    /* 1) 服务商列表里加/更新一项，设置页的「服务商按钮」与卡片标题都靠它 */
    const prov = {
      id: HOST_AGENT_PROVIDER, name: cfgHost.name, brand: 'HOST',
      baseUrl: cfgHost.baseUrl, models: cfgHost.models.slice(), vision: cfgHost.vision || '',
      docs: '', hostAuto: true
    };
    const oldProv = PROVIDERS.find(x => x.id === HOST_AGENT_PROVIDER);
    if (oldProv) Object.assign(oldProv, prov); else PROVIDERS.push(prov);
    /* 2) 连接：按固定 id 更新，不重复添加；用户手动关掉的不强行打开 */
    const list = connections();
    const old = list.find(x => x.id === HOST_AGENT_ID) || list.find(x => x.providerId === HOST_AGENT_PROVIDER);
    const next = {
      ...(old || {}),
      id: HOST_AGENT_ID,
      name: cfgHost.name,
      provider: 'openai',
      kind: 'api',
      purpose: 'chat',
      providerId: HOST_AGENT_PROVIDER,
      baseUrl: cfgHost.baseUrl,
      apiKey: cfgHost.apiKey || (old && old.apiKey) || '',
      models: cfgHost.models.slice(),
      defaultModel: (old && cfgHost.models.includes(old.defaultModel)) ? old.defaultModel : cfgHost.models[0],
      visionModel: cfgHost.vision || '',
      enabled: old ? old.enabled !== false : true
    };
    if (old) Object.assign(old, next); else list.push(next);
    saveConnections(list);
    const c = connections().find(x => x.id === HOST_AGENT_ID);
    return {
      mounted: true, id: HOST_AGENT_ID, name: cfgHost.name,
      baseUrl: cfgHost.baseUrl, models: cfgHost.models.slice(),
      enabled: !!(c && c.enabled), file: hostAgentFile()
    };
  },
  connections() {
    /* 密钥不下发给前端，只回 hasKey —— 前端留空表示「不修改」 */
    return connections().map(c => ({ ...c, hasKey: !!c.apiKey, apiKey: '' }));
  },
  saveConnections(list) {
    /* 密钥：前端留空表示「不修改」。整体覆盖保存时也必须按这条规则补回旧值 ——
       否则设置页每点一次保存，用户已存的密钥就被清成空。 */
    const prev = {};
    for (const c of connections()) if (c.apiKey) prev[c.id] = c.apiKey;
    const next = (list || []).map(c => {
      const k = c && String(c.apiKey || '').trim();
      return normalizeConn(k ? c : { ...c, apiKey: prev[c && c.id] || '' });
    });
    saveConnections(next);
    /* 同步一份单值设置给老代码路径（currentModel 等），
       取第一条启用的对话连接 —— 识图专用不参与，不然默认聊天会走错地址。 */
    const first = next.find(c => c.enabled && c.purpose !== 'vision');
    if (first) {
      ctx.setSetting('ai_provider', first.provider);
      ctx.setSetting('ai_base_url', first.baseUrl);
      ctx.setSetting('ai_api_key', first.apiKey);
      ctx.setSetting('ai_model', connModel(first));
      ctx.setSetting('ai_vision_model', first.visionModel || '');
    }
    return { ok: true, count: next.length };
  },
  modelPool,
  modelPoolVision,
  standaloneVision,
  modelsFor: fetchModelsFor,

  /** 统一入口：返回纯文本。opts.model 可为 '连接id::模型名' */
  async text(opts) {
    const c = cfg(opts && opts.model);
    /* opts.model 原样传给下游的话，「连接id::模型名」会被当成模型名发给接口
       （接口回 400「模型不存在」）。这里换成 cfg 解析出来的裸模型名。 */
    const o = (opts && typeof opts === 'object') ? { ...opts } : {};
    if (o.model) o.model = c.model;
    else if (c.model) o.model = c.model;
    /* 埋点（Q5）：记录每次 AI 调用的成败与耗时。
       scene 由调用方传（opts.scene），没传就记 'unknown'，事后可按场景看谁最不靠谱。
       任何异常都在埋点里吞掉 —— 统计绝不影响真实调用。 */
    if (!stats) {
      if (c.provider === 'opencode') return opencodeText(c, o);
      return openaiText(c, o);
    }
    const t0 = Date.now();
    const scene = String(o.scene || 'unknown');
    const model = String(o.model || c.model || '');
    try {
      const r = c.provider === 'opencode' ? await opencodeText(c, o) : await openaiText(c, o);
      try { stats({ scene, model, status: 'ok', attempts: 1, costMs: Date.now() - t0 }); } catch (e) {}
      return r;
    } catch (e) {
      /* 这里是"用户真正看到失败"的地方（抛到调用方）。
         内部续写/抢救成功的路径不走这里，会被 rescue 钩子记成 rescued。 */
      try {
        stats({
          scene, model, status: 'failed', attempts: 1,
          errorType: statsErrType(e && e.message), error: (e && e.message) || String(e),
          costMs: Date.now() - t0
        });
      } catch (e2) {}
      throw e;
    }
  },
  /** 带流式回调：onEvent({ text } | { thinking }) */
  async stream(opts) {
    return ai.text({ ...opts, stream: true });
  },
  async models() {
    const c = cfg();
    if (c.provider === 'opencode') {
      try {
        const r = await runOpencode(c, ['models'], 60000);
        const models = String(r.out).split('\n').map(s => s.trim()).filter(Boolean);
        if (models.length) return { provider: 'opencode', models, default: c.model || models[0] };
      } catch (e) { /* 落到兜底 */ }
      return { provider: 'opencode', models: c.model ? [c.model] : [], default: c.model || '' };
    }
    try {
      const models = await openaiModels(c);
      return { provider: 'openai', models, default: c.model || models[0] || '' };
    } catch (e) {
      return { provider: 'openai', models: c.model ? [c.model] : [], default: c.model || '', error: e.message };
    }
  },
  /** 连接 CRUD（前端增删改连接时用；整表保存走 saveConnections） */
  addConnection(conn) {
    const list = connections();
    const c = normalizeConn(conn || {});
    if (!c.baseUrl && c.provider !== 'opencode') throw new Error('请先填写 API 地址');
    if (list.some(x => x.id === c.id)) c.id = newConnId();
    list.push(c);
    saveConnections(list);
    return c;
  },
  updateConnection(id, patch) {
    const list = connections();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    /* 密钥：前端留空表示「不修改」，别把已存的密钥冲掉 */
    const merged = { ...list[i], ...(patch || {}) };
    if (patch && !patch.apiKey) merged.apiKey = list[i].apiKey;
    list[i] = normalizeConn(merged);
    saveConnections(list);
    return list[i];
  },
  removeConnection(id) {
    const list = connections();
    const next = list.filter(x => x.id !== id);
    if (next.length === list.length) return false;
    saveConnections(next);
    return true;
  },
  newConnId,
  /** opencode 是否可用（设置页在列出 opencode 模型前先探这个） */
  opencodeStatus,
  /** 按 Agent 类型探测（以后加 codex 之类走这里，现在只有 opencode） */
  agentStatus(agentId) {
    const aid = String(agentId || 'opencode');
    if (aid !== 'opencode') return { installed: false, agent: aid, hint: '暂只支持 opencode CLI' };
    return { ...opencodeStatus(), agent: aid };
  },
  /** 使用 opencode 时确保代理配置存在（供设置页调用） */
  ensureOpencodeAgent,
  /** 连接测试：发一句最短的请求 */
  async test(opts) {
    /* 传了 model 就按那条连接/模型测（设置页「测试这条连接」用），
       没传就测第一条启用连接 —— 跟升级前一致。 */
    const ref = (opts && (opts.model || (opts.connId ? opts.connId + '::' + (opts.modelName || '') : ''))) || '';
    let c;
    try { c = cfg(ref); }
    catch (e) { return { ok: false, provider: '', model: '', message: e.message }; }
    const probe = ref || c.model;
    try {
      const text = await ai.text({ prompt: '回复两个字：正常', model: ref || undefined, timeoutMs: 60000 });
      return { ok: true, provider: c.provider, connName: c.connName || '', model: probe || (c.provider === 'opencode' ? '(默认)' : '(未设置)'), sample: String(text).trim().slice(0, 40) };
    } catch (e) {
      return { ok: false, provider: c.provider, connName: c.connName || '', model: c.model || probe || '', message: e.message };
    }
  },
  /* ---- 向量（检索增强用）：OpenAI 兼容 /embeddings，独立配置 ----
     不是所有服务商都提供向量接口（如 DeepSeek 就没有），所以要单独填一家；
     地址或模型留空 = 未配置，检索会自动退化为关键词方案。 */
  embConfig() {
    const get = ctx.getSetting;
    const baseUrl = String(get('emb_base_url', '') || '').trim();
    const apiKey = String(get('emb_api_key', '') || '').trim();
    const model = String(get('emb_model', '') || '').trim();
    return { baseUrl, apiKey, model, configured: !!(baseUrl && model) };
  },
  async embedTexts(texts, opts) {
    const c = ai.embConfig();
    if (!c.configured) throw new Error('未配置向量模型（设置 → 检索增强 → 向量模型）');
    const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t == null ? '' : t).slice(0, 8000) || ' ');
    const o = opts || {};
    const urls = candidateUrls(c.baseUrl, 'embeddings');
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: 'POST', headers: openaiHeaders({ apiKey: c.apiKey }), body: JSON.stringify({ model: c.model, input: list }), signal: o.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          lastErr = new Error(httpErrorText(res.status, txt));
          if ((res.status === 404 || res.status === 400) && url !== urls[urls.length - 1]) continue;
          throw lastErr;
        }
        const j = await res.json().catch(() => null);
        const data = (j && Array.isArray(j.data)) ? j.data.slice().sort((a, b) => ((a && a.index) || 0) - ((b && b.index) || 0)) : [];
        const out = data.map(d => (d && Array.isArray(d.embedding)) ? d.embedding : null).filter(Boolean);
        if (!out.length) throw new Error('向量接口没有返回数据（确认模型名是 embedding 模型）');
        return out;
      } catch (e) {
        lastErr = e;
        if (e && e.name === 'AbortError') throw e;
        if (String(e.message || '').includes('fetch failed') || e.cause) {
          if (url === urls[urls.length - 1]) throw new Error('无法连接向量接口：' + (c.baseUrl || '(未配置)') + '（检查地址、网络或代理）');
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('向量请求失败');
  },
  /** 当前生效配置（隐藏密钥，仅供前端展示状态） */
  status() {
    const list = connections().filter(c => c.enabled);
    const c = cfg();
    // 是否已完成配置：至少一条启用连接，且它（或连接预设）能定出模型名
    const configured = list.length > 0 && (c.provider === 'opencode' || !!(c.baseUrl && c.model));
    let hint = '';
    if (!list.length) {
      hint = '还没有配置 AI 接入方式：在「AI 接入方式」里添加一个服务商连接';
    } else if (!configured) {
      if (!c.baseUrl) hint = '还缺 API 地址（Base URL）';
      else if (!c.model) hint = '还缺模型名：到这条连接里勾选要用的模型';
    }
    return {
      provider: c.provider,
      connId: c.connId,
      connName: c.connName || '',
      baseUrl: c.baseUrl,
      hasKey: !!c.apiKey,
      model: c.model,
      visionModel: c.visionModel,
      agent: c.agent,
      configured,
      hint,
      connCount: list.length,
      modelCount: modelPool().length
    };
  }
};

module.exports = ai;
