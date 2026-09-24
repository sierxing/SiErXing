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
 * 对外接口：
 *   ai.init({ getSetting, appDir })
 *   ai.text({ prompt, model, images, timeoutMs, onEvent }) -> Promise<string>
 *   ai.models() -> { provider, models: string[], default }
 *   ai.chatUrl / ai.test() -> Promise<{ ok, message, sample, provider, model }>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

let ctx = { getSetting: () => '', appDir: process.cwd() };
function log(...a) { try { console.log(...a); } catch (e) {} }

function env(name, alt) {
  const v = process.env[name];
  if (v != null && String(v).trim() !== '') return String(v).trim();
  if (alt) for (const a of alt) {
    const v2 = process.env[a];
    if (v2 != null && String(v2).trim() !== '') return String(v2).trim();
  }
  return '';
}

function cfg() {
  const get = ctx.getSetting;
  const pick = (key, envNames, dflt) => {
    const dbVal = (get(key, '') || '').toString().trim();
    if (dbVal) return dbVal;
    const ev = envNames ? env(envNames[0], envNames.slice(1)) : '';
    return ev || dflt || '';
  };
  const provider = (pick('ai_provider', ['SIERXING_PROVIDER', 'AI_PROVIDER'], 'openai') || 'openai').toLowerCase();
  const dbOnly = (key) => (get(key, '') || '').toString().trim();
  // 模型既支持新的 ai_model，也兼容应用原有的 model 设置
  const model = dbOnly('ai_model') || dbOnly('model') || env('SIERXING_MODEL', ['OPENAI_MODEL']);
  const visionModel = dbOnly('ai_vision_model') || dbOnly('vision_model') || env('SIERXING_VISION_MODEL', ['OPENAI_VISION_MODEL']);
  return {
    provider: provider === 'opencode' ? 'opencode' : 'openai',
    baseUrl: pick('ai_base_url', ['SIERXING_API_BASE', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'], ''),
    apiKey: pick('ai_api_key', ['SIERXING_API_KEY', 'OPENAI_API_KEY'], ''),
    model,
    visionModel,
    agent: pick('ai_opencode_agent', ['SIERXING_OPENCODE_AGENT'], 'NoTools'),
    timeoutMs: Number(pick('ai_timeout_ms', ['SIERXING_AI_TIMEOUT_MS'], '300000')) || 300000
  };
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
  const maxTokens = Number(opts.maxTokens) || 16000;
  if (!useStream) return openaiLongText(c, { model: mdl, prompt, images, timeoutMs, signal, onEvent, maxTokens });
  const body = {
    model: mdl,
    messages: [{ role: 'user', content: messageContent(prompt, images) }],
    stream: true,
    max_tokens: maxTokens
  };
  const res = await openaiRequest(c, body, timeoutMs, signal);
  if (!useStream) {
    const j = await res.json().catch(() => null);
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string') {
      const err = (j && j.error && j.error.message) || '返回内容为空（检查模型名是否正确）';
      throw new Error('AI 返回异常：' + err);
    }
    return text;
  }
  // 流式解析（SSE）
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', lastThink = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch (e) { continue; }
      const delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
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
  if (!text) throw new Error('AI 没有返回内容（检查模型名/额度，或稍后重试）');
  return text;
}

/* 非流式长文本（含截断自动续写）：finish_reason=length 时接着往下要，直到写完 */
const CONTINUE_SUFFIX = '\n\n（上次输出到这里就中断了，请从中断处紧接着继续往下输出剩余部分：不要重复已输出的内容，不要加开头语或解释）';
async function openaiOnce(c, messages, mdl, maxTokens, timeoutMs, signal) {
  const res = await openaiRequest(c, { model: mdl, messages, stream: false, max_tokens: maxTokens }, timeoutMs, signal);
  const j = await res.json().catch(() => null);
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
  let tokens = maxTokens, shrunk = 0;
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
    full += r.text;
    if (r.finish !== 'length') return full;
    rounds++;
    if (rounds >= 4) throw new Error('AI 输出过长（多次续写仍未写完）：请把这次要求拆小一点，分多次提');
    if (onEvent) { try { onEvent({ thinking: '输出较长，正在继续生成（第 ' + (rounds + 1) + ' 段）…' }); } catch (e2) {} }
    // 续写只带尾部 3000 字做衔接，不带全文，省上下文
    messages = [{ role: 'user', content: '你正在写一份教程，上次输出到下面这个位置就中断了' + CONTINUE_SUFFIX + '\n\n【已输出内容的尾部】\n' + full.slice(-3000) }];
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
async function opencodeText(c, opts) {
  const { prompt, model, images, timeoutMs, onEvent, signal } = opts;
    if (signal && signal.aborted) { const err = new Error('已停止'); err.cancelled = true; throw err; }
  const args = opencodeArgs(c, opts, true);
  // 提示词通过 stdin 传入（Windows 下 cmd 包装脚本 + 长文本更稳）
  if (onEvent) {
    return await new Promise((resolve, reject) => {
      let child;
      try { child = spawnOpencode(args, prompt); } catch (e) { return reject(new Error(opencodeMissingError())); }
      let buf = '', text = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('opencode 调用超时')); }, timeoutMs || 300000);
      child.stdout.on('data', chunk => {
        buf += chunk;
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
          else if (d.type === 'tool_use' && d.part) onEvent({ thinking: '正在使用工具：' + (d.part.tool || '') });
        }
      });
      let errBuf = '';
      child.stderr.on('data', d => { errBuf += d; });
      child.on('error', () => { clearTimeout(timer); reject(new Error(opencodeMissingError())); });
      child.on('close', () => {
        clearTimeout(timer);
        if (text) return resolve(text);
        if (isAgentError(errBuf)) {
          log('[ai] 代理不可用，改用 opencode 默认代理重试');
          return opencodeText(c, { ...opts, onEvent: null }).then(resolve).catch(reject);
        }
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
    const errText = String(r.err || '').split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error('opencode 未返回内容' + (errText ? '：' + errText.slice(0, 200) : ''));
  }
  return text;
}

/* ---------------- 对外接口 ---------------- */

const ai = {
  init(options) {
    ctx = { getSetting: (options && options.getSetting) || (() => ''), appDir: (options && options.appDir) || process.cwd() };
    return ai;
  },
  config: cfg,
  /** 统一入口：返回纯文本 */
  async text(opts) {
    const c = cfg();
    if (c.provider === 'opencode') return opencodeText(c, opts);
    return openaiText(c, opts);
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
  /** 使用 opencode 时确保代理配置存在（供设置页调用） */
  ensureOpencodeAgent,
  /** 连接测试：发一句最短的请求 */
  async test() {
    const c = cfg();
    try {
      const text = await ai.text({ prompt: '回复两个字：正常', timeoutMs: 60000 });
      return { ok: true, provider: c.provider, model: c.model || (c.provider === 'opencode' ? '(默认)' : '(未设置)'), sample: String(text).trim().slice(0, 40) };
    } catch (e) {
      return { ok: false, provider: c.provider, model: c.model || '', message: e.message };
    }
  },
  /** 当前生效配置（隐藏密钥，仅供前端展示状态） */
  status() {
    const c = cfg();
    // 是否已完成配置：opencode 只要模型名（默认走 CLI 默认模型）；openai 需要地址 + 模型
    const configured = c.provider === 'opencode' ? true : !!(c.baseUrl && c.model);
    let hint = '';
    if (!configured) {
      if (!c.baseUrl && !c.model) hint = '还没有配置 AI 接入方式：请选择服务商并填写 API 地址与模型';
      else if (!c.baseUrl) hint = '还缺 API 地址（Base URL）';
      else hint = '还缺模型名（Model）';
    }
    return {
      provider: c.provider,
      baseUrl: c.baseUrl,
      hasKey: !!c.apiKey,
      model: c.model,
      visionModel: c.visionModel,
      agent: c.agent,
      configured,
      hint
    };
  }
};

module.exports = ai;
