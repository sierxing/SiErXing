/**
 * 思而行 × DSH 桥（host 侧插件）
 * ---------------------------------------------------------------------------
 * 目标：思而行作为 DSH 的插件运行时，用户在思而行里**不用再填 API Key**，
 * 直接就能选 DSH 当前可用的模型 —— 因为模型调用走 DSH 的 llm 服务。
 *
 * 做法（三步，全部在 DSH 宿主进程内）：
 *   1. 读 ctx.llm.listProviders() / listModels()，拼出「provider/model」模型目录；
 *   2. 在本机 webServer 上注册 OpenAI 兼容路由：
 *        GET  {mountPath}/models
 *        POST {mountPath}/chat/completions   （stream:true 也支持，SSE）
 *      只监听回环地址，且必须带本插件生成的 Bearer token；
 *   3. 把 {name,url,key,models} 写进思而行的 DATA_DIR/host-agent.json，
 *      再 POST 思而行的 /api/host-agent/refresh —— 思而行会把它登记成一条
 *      普通 AI 连接「当前宿主 Agent（DSH）」，模型直接进对话下拉。
 *
 * 模型 id 约定：provider/model（例如 deepseek-official/deepseek-v4-flash）。
 * 思而行发来的请求里 model 就是这种 id，插件拆出 provider 与 model 交给
 * ctx.llm.stream()。
 *
 * 真流式：ctx.llm.stream() 的 text-delta 直接转成 OpenAI SSE delta。
 * 单轮文本：思而行的 AI 调用是一段完整 prompt，所以这里把 OpenAI messages
 * 里的 system 合并成 system，其余文本合并成一条 user 消息（多轮历史暂不还原）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const name = 'sierxing-dsh-bridge';
export const inject = ['webServer', 'llm'];

const HOST_AGENT_FILE = 'host-agent.json';
const MAX_BODY = 8 * 1024 * 1024;

const DEFAULTS = {
  /** 思而行仓库目录；不填则用当前工作目录（含 server/server.js 时） */
  sierxingAppDir: '',
  /** 思而行服务地址（只用于探活与调用 refresh） */
  sierxingUrl: 'http://127.0.0.1:3213',
  /** 网关挂载点（OpenAI Base URL 路径） */
  mountPath: '/sierxing/v1',
  /** 连接显示名 */
  name: 'DSH',
  /** 固定 token；不填则每次启动随机生成 */
  token: '',
  /** 强制指定思而行 DATA_DIR；不填则按 data-location.json / data 解析 */
  dataDir: '',
  /** 思而行没在跑时是否自动拉起（会弹一次浏览器窗口，按需开） */
  autoStart: false
};

function cfgOf(raw) {
  const c = Object.assign({}, DEFAULTS, raw || {});
  c.mountPath = '/' + String(c.mountPath || DEFAULTS.mountPath).replace(/^\/+/, '').replace(/\/+$/, '');
  c.sierxingUrl = String(c.sierxingUrl || DEFAULTS.sierxingUrl).replace(/\/+$/, '');
  return c;
}

/* ---------------- 思而行数据目录解析 ----------------
 * 与 server/data-dir.js 同一规则：程序目录下的 data-location.json 指向真实
 * DATA_DIR；没有指针就退回 <appDir>/data。 */
export function resolveAppDir(config) {
  const explicit = String((config && config.sierxingAppDir) || '').trim();
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  try { if (fs.existsSync(path.join(cwd, 'server', 'server.js'))) return cwd; } catch (e) {}
  return '';
}

export function resolveDataDir(config, appDir) {
  const explicit = String((config && config.dataDir) || '').trim();
  if (explicit) return path.resolve(explicit);
  if (process.env.SIERXING_DATA_DIR) return path.resolve(process.env.SIERXING_DATA_DIR);
  const root = appDir || resolveAppDir(config);
  if (!root) return '';
  const dflt = path.join(root, 'data');
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'data-location.json'), 'utf8'));
    if (v && typeof v.dir === 'string' && v.dir.trim()) {
      const dir = path.resolve(v.dir.trim());
      if (fs.existsSync(dir)) return dir;
    }
  } catch (e) {}
  return dflt;
}

/* ---------------- OpenAI 兼容转换（纯函数，便于测试） ---------------- */

/** OpenAI messages -> { system, prompt }：system 合并成系统提示，其余文本按轮次拼成一段。 */
export function messagesToPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = [];
  const turns = [];
  for (const m of list) {
    if (!m || !m.role) continue;
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === 'system' || m.role === 'developer') sys.push(text);
    else if (m.role === 'assistant') turns.push('【助手】' + text);
    else turns.push(text);
  }
  return { system: sys.join('\n\n'), prompt: turns.join('\n\n') };
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part) return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[图片]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content);
}

/** provider/model -> { provider, model }；没有斜杠时用 defaultProvider。 */
export function splitModelId(id, defaultProvider) {
  const s = String(id || '').trim();
  if (!s) return null;
  const i = s.indexOf('/');
  if (i > 0 && i < s.length - 1) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  if (defaultProvider) return { provider: defaultProvider, model: s };
  return null;
}

/** 把 provider 目录 + 模型列表拼成思而行能用的模型 id 列表。 */
export async function listCatalog(llm) {
  const out = [];
  let providers = [];
  try { providers = llm.listProviders() || []; } catch (e) { providers = []; }
  for (const p of providers) {
    const pid = String((p && (p.id || p.provider)) || '');
    if (!pid) continue;
    let models = [];
    try { models = await llm.listModels(pid); } catch (e) { models = []; }
    for (const m of (models || [])) {
      const mid = String((m && (m.id || m.name)) || '');
      if (!mid) continue;
      const modalities = (m && m.inputModalities) || [];
      out.push({
        id: pid + '/' + mid,
        provider: pid,
        model: mid,
        name: String((m && m.name) || mid),
        vision: Array.isArray(modalities) ? modalities.includes('image') : false
      });
    }
  }
  return out;
}

/* ---------------- HTTP 小工具 ---------------- */

export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', c => {
      bytes += c.length;
      if (bytes > limit) { try { req.destroy(); } catch (e) {} reject(new Error('请求体过大')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}

function openaiError(res, code, message) {
  return sendJson(res, code, { error: { message, type: 'sierxing_bridge_error', code } });
}

function bearerOk(req, token) {
  if (!token) return false;
  const h = String((req.headers && req.headers.authorization) || '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!got || got.length !== token.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token)); } catch (e) { return false; }
}

export function writeHostAgentFile(dataDir, payload) {
  if (!dataDir) throw new Error('未解析到思而行 DATA_DIR（给插件配 dataDir 或 sierxingAppDir）');
  fs.mkdirSync(dataDir, { recursive: true });
  const fp = path.join(dataDir, HOST_AGENT_FILE);
  const tmp = fp + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, fp);
  return fp;
}

export function readHostAgentFile(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, HOST_AGENT_FILE), 'utf8')); }
  catch (e) { return null; }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

/* ---------------- 插件主体 ---------------- */

export function apply(ctx, rawConfig) {
  const config = cfgOf(rawConfig);
  const state = {
    token: config.token || crypto.randomBytes(24).toString('hex'),
    catalog: [],
    catalogMap: new Map(),
    providers: new Set(),
    defaultProvider: '',
    gatewayUrl: '',
    dataDir: '',
    file: '',
    siErXingUp: false,
    child: null,
    disposed: false,
    lastError: ''
  };
  let disposeRoutes = null;

  async function refreshSiErXing() {
    try {
      const r = await fetchJson(config.sierxingUrl + '/api/host-agent/refresh', { method: 'POST' });
      state.siErXingUp = !!(r.ok && r.json && r.json.mounted);
      if (!state.siErXingUp) state.lastError = '已写 host-agent.json，但思而行没在跑（' + config.sierxingUrl + '）';
    } catch (e) {
      state.siErXingUp = false;
      state.lastError = '连不上思而行 ' + config.sierxingUrl + '，模型已写好但还没生效';
    }
  }

  async function bridgeUp() {
    if (state.disposed) return;
    const appDir = resolveAppDir(config);
    state.dataDir = resolveDataDir(config, appDir);
    state.catalog = await listCatalog(ctx.llm);
    state.catalogMap = new Map(state.catalog.map(m => [m.id, m]));
    try {
      state.providers = new Set((ctx.llm.listProviders() || []).map(p => String((p && (p.id || p.provider)) || '')));
    } catch (e) { state.providers = new Set(); }
    state.defaultProvider = state.catalog.length ? state.catalog[0].provider : '';
    const vision = (state.catalog.find(m => m.vision) || {}).id || '';
    const port = (ctx.webServer && ctx.webServer.port) || 0;
    state.gatewayUrl = 'http://127.0.0.1:' + port + config.mountPath;
    const payload = {
      name: config.name,
      url: state.gatewayUrl,
      key: state.token,
      models: state.catalog.map(m => m.id),
      vision
    };
    try {
      state.file = writeHostAgentFile(state.dataDir, payload);
    } catch (e) {
      state.lastError = '写 host-agent.json 失败：' + (e && e.message);
      console.warn('[sierxing-dsh-bridge] ' + state.lastError);
      return;
    }
    if (config.autoStart) try { await ensureSiErXing(); } catch (e) {}
    await refreshSiErXing();
    if (state.lastError) console.warn('[sierxing-dsh-bridge] ' + state.lastError);
    else if (state.siErXingUp) console.log('[sierxing-dsh-bridge] 已把 ' + state.catalog.length + ' 个 DSH 模型接入思而行：' + state.gatewayUrl);
  }

  async function waitHealth(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { const h = await fetch(config.sierxingUrl + '/api/health'); if (h.ok) return true; } catch (e) {}
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  }

  async function ensureSiErXing() {
    if (await waitHealth(1000)) return;
    /* 优先交给 systemd 用户服务启动：仍然是系统托管（Restart=always），
       避免 DSH 自己再拉一个实例和它抢 3213 端口。 */
    try {
      /* DSH 从终端/GUI 起来时进程环境里可能没有 DBUS/X 会话变量（实测 web 进程就没有），
         这里显式补上当前用户的 user bus，否则 systemctl 会报连不上总线而退化成野进程。 */
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
      const sysEnv = Object.assign({}, process.env, {
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/' + uid + '/bus',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/' + uid
      });
      await execFileAsync('systemctl', ['--user', 'start', 'sierxing.service'], { timeout: 20000, env: sysEnv });
      if (await waitHealth(15000)) return;
    } catch (e) { /* 没有 systemd 的用户环境，走下面的兜底 */ }
    const appDir = resolveAppDir(config);
    if (!appDir) throw new Error('思而行没在跑，且没配置 sierxingAppDir，无法自动拉起');
    const u = new URL(config.sierxingUrl);
    state.child = spawn(process.execPath, ['--no-warnings', 'server/server.js'], {
      cwd: appDir,
      env: Object.assign({}, process.env, { PORT: u.port || '3213' }),
      stdio: 'ignore',
      detached: true
    });
    state.child.unref();
    if (!(await waitHealth(15000))) throw new Error('自动拉起思而行超时：' + config.sierxingUrl);
  }

  async function handleModels(req, res) {
    if (!bearerOk(req, state.token)) return openaiError(res, 401, 'Unauthorized');
    return sendJson(res, 200, {
      object: 'list',
      data: state.catalog.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider }))
    });
  }

  async function handleChat(req, res) {
    if (!bearerOk(req, state.token)) return openaiError(res, 401, 'Unauthorized');
    if (!state.catalog.length) return openaiError(res, 503, 'DSH 还没有可用模型（等 llm 服务加载完再试）');
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return openaiError(res, 400, '请求体不是合法 JSON'); }
    const modelId = String((body && body.model) || '');
    let hit = state.catalogMap.get(modelId);
    if (!hit) {
      const parsed = splitModelId(modelId, state.defaultProvider);
      /* 允许「已注册 provider + 目录外模型」（DSH 核心路由本身允许），但 provider 必须存在 */
      if (parsed && state.providers.has(parsed.provider)) {
        hit = state.catalog.find(m => m.provider === parsed.provider && m.model === parsed.model)
          || { provider: parsed.provider, model: parsed.model };
      }
    }
    if (!hit) return openaiError(res, 404, '未知模型：' + modelId);
    const { system, prompt } = messagesToPrompt(body.messages);
    if (!prompt) return openaiError(res, 400, 'messages 里没有可用文本');
    const opts = {
      provider: hit.provider,
      model: hit.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    };
    if (system) opts.system = system;
    if (body.temperature != null && Number.isFinite(Number(body.temperature))) opts.temperature = Number(body.temperature);
    if (body.max_tokens != null && Number.isFinite(Number(body.max_tokens))) opts.maxTokens = Number(body.max_tokens);
    const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    if (!body.stream) {
      let text = '';
      try {
        for await (const ch of ctx.llm.stream(opts)) if (ch && ch.type === 'text-delta') text += ch.text;
      } catch (e) {
        return openaiError(res, 502, 'DSH 模型调用失败：' + ((e && e.message) || e));
      }
      return sendJson(res, 200, {
        id, object: 'chat.completion', created, model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
      });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = obj => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
    const chunk = delta => ({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: null }] });
    try {
      for await (const ch of ctx.llm.stream(opts)) {
        if (!ch) continue;
        if (ch.type === 'text-delta') send(chunk({ content: ch.text }));
        else if (ch.type === 'reasoning-delta') send(chunk({ reasoning_content: ch.text }));
      }
      send({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } catch (e) {
      send({ error: { message: 'DSH 模型调用失败：' + ((e && e.message) || e), type: 'sierxing_bridge_error' } });
    }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch (e) {}
  }

  const routes = [
    ctx.webServer.register({ kind: 'exact', path: config.mountPath + '/models', handler: handleModels }),
    ctx.webServer.register({ kind: 'exact', path: config.mountPath + '/chat/completions', handler: handleChat })
  ];
  disposeRoutes = () => routes.forEach(fn => { try { fn(); } catch (e) {} });

  ctx.effect(() => {
    bridgeUp().catch(e => console.warn('[sierxing-dsh-bridge] 初始化失败：' + ((e && e.message) || e)));
    return () => {
      state.disposed = true;
      try { disposeRoutes && disposeRoutes(); } catch (e) {}
      try {
        const cur = readHostAgentFile(state.dataDir);
        if (cur && cur.key === state.token) fs.unlinkSync(path.join(state.dataDir, HOST_AGENT_FILE));
      } catch (e) {}
      try { if (state.child) state.child.kill('SIGTERM'); } catch (e) {}
      try { fetch(config.sierxingUrl + '/api/host-agent/refresh', { method: 'POST' }).catch(() => {}); } catch (e) {}
    };
  });

  return { config, state };
}
