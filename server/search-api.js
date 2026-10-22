'use strict';
/**
 * 信息源检索的「搜索 API」抽象层
 * ============================================================================
 * 思而行默认用**内置搜索**（百度 + 必应网页抓取，见 server.js 的 baiduSearch /
 * bingSearch）。用户可以在「设置 → 信息源检索」里显式指定一个外部搜索 API：
 *
 *   · deepseek：DeepSeek 网页搜索 API（POST {base}/v1/tools/search，返回 results[]）
 *   · custom：自定义兼容接口（同一套请求/响应格式，可指向自建网关或代理）
 *
 * 规则（用户 2026-10 定调）：
 *   1. **指定了** 搜索 API → 搜集资料时优先用它；
 *   2. **没指定** 或调用失败 → 回落到思而行内置搜索（不阻断搜集，只在界面上说明）。
 *
 * 本文件只做「调用 + 结果归一化」，不碰数据库、不 require server.js；
 * 内置搜索由 server.js 通过 init({ builtin }) 注入，避免循环依赖。
 *
 * ⚠️ 界面文案规则：这里**不写用户可见的中文文案**，只回结构化错误码
 *   （code/detail/status），由前端 tr() 组装提示（见 AGENTS.md §0.1）。
 *
 * 回归：node --no-warnings scripts/test-search-api.js
 */

/* 搜索服务商（id 与 settings.search_provider 对应；builtin = 不指定） */
const PROVIDERS = ['builtin', 'deepseek', 'custom'];
const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_PATH = '/v1/tools/search';
const DEFAULT_COUNT = 20;
const MAX_COUNT = 50;
const DEFAULT_TIMEOUT_MS = 20000;

let deps = {
  getSetting: function () { return ''; },
  builtin: null,
  log: function () {}
};

/** 注入依赖（server.js 启动时调一次）：getSetting / builtin / log */
function init(o) {
  o = o || {};
  if (typeof o.getSetting === 'function') deps.getSetting = o.getSetting;
  if (typeof o.builtin === 'function') deps.builtin = o.builtin;
  if (typeof o.log === 'function') deps.log = o.log;
}

function readSetting(key, dflt) {
  try {
    const v = deps.getSetting(key, dflt);
    return v == null || v === '' ? dflt : v;
  } catch (e) { return dflt; }
}
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function envKey() {
  return String(process.env.SIERXING_SEARCH_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
}
/** 去掉尾部斜杠；没写协议时补 https:// */
function normBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}
/**
 * 拼出真正的 POST 地址：
 *  · deepseek：base（默认 https://api.deepseek.com）+ /v1/tools/search
 *  · custom：已经是完整接口地址就原样用；只给了域名/前缀才补默认路径
 */
function endpointOf(provider, base) {
  let b = String(base || '').trim();
  if (!b && provider === 'deepseek') b = DEFAULT_BASE;
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/+$/, '');
  if (/\/v1\/tools\/search$/i.test(b)) return b;
  if (provider === 'deepseek') return b + DEFAULT_PATH;
  try {
    const u = new URL(b);
    if (u.pathname && u.pathname !== '/') return b;
  } catch (e) { return b; }
  return b + DEFAULT_PATH;
}

/** 当前生效配置（密钥只给调用方，不外发） */
function config(over) {
  over = over || {};
  const rawSaved = String(readSetting('search_provider', '') || '').trim();
  const raw = String(over.provider != null ? over.provider : rawSaved).trim();
  const provider = (raw === 'deepseek' || raw === 'custom') ? raw : 'builtin';
  const savedBase = normBase(over.base != null ? over.base : readSetting('search_api_base', ''));
  const savedKey = String(over.apiKey != null ? over.apiKey : readSetting('search_api_key', '')).trim();
  const envK = provider === 'builtin' ? '' : envKey();
  const key = savedKey || envK;
  const count = clampInt(over.count != null ? over.count : readSetting('search_api_count', DEFAULT_COUNT), 1, MAX_COUNT, DEFAULT_COUNT);
  const contentRaw = over.content != null ? over.content : readSetting('search_api_content', '1');
  const content = String(contentRaw === true ? '1' : contentRaw === false ? '0' : contentRaw) !== '0';
  const base = savedBase || (provider === 'deepseek' ? DEFAULT_BASE : '');
  const endpoint = provider === 'builtin' ? '' : endpointOf(provider, savedBase);
  return {
    provider: provider,
    base: base,
    endpoint: endpoint,
    key: key,
    keySource: savedKey ? 'setting' : (key ? 'env' : ''),
    count: count,
    content: content,
    ready: provider === 'builtin' ? true : !!endpoint
  };
}
/** 供 GET /api/settings 回显（密钥只回「有没有」；provider 由前端映射成界面文字） */
function status() {
  const c = config();
  return {
    provider: c.provider,
    base: c.base,
    endpoint: c.endpoint,
    count: c.count,
    content: c.content,
    has_key: !!c.key,
    key_source: c.keySource,
    ready: c.ready
  };
}

function makeError(code, detail, extra) {
  const e = new Error(detail || code);
  e.code = code;
  e.detail = detail || '';
  if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  return e;
}
function str(v) { return v == null ? '' : String(v); }
function pickArray(p) {
  if (Array.isArray(p)) return p;
  if (!p || typeof p !== 'object') return [];
  const keys = ['results', 'data', 'items', 'organic_results'];
  for (const k of keys) if (Array.isArray(p[k])) return p[k];
  if (p.web && Array.isArray(p.web.results)) return p.web.results;
  if (p.data && Array.isArray(p.data.results)) return p.data.results;
  return [];
}
function parseDate(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : (v > 1e9 ? v * 1000 : 0);
  const t = Date.parse(String(v).replace(/[年月]/g, '-').replace(/日/g, ''));
  if (isNaN(t)) return 0;
  return t > 0 && t <= Date.now() + 86400000 ? t : 0;
}
/** 把各家返回的字段归一成 {title,url,snippet,content,date,site}（接口字段名不同也不怕） */
function normalizeItem(r) {
  if (!r || typeof r !== 'object') return null;
  const url = str(r.url || r.link || r.href || r.target || (r.source && r.source.url)).trim();
  const title = str(r.title || r.name || r.headline).trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const content = str(r.content || r.markdown || r.text || r.raw_content);
  const snippet = str(r.snippet || r.summary || r.description || r.desc || content).replace(/\s+/g, ' ').trim().slice(0, 600);
  const date = parseDate(r.date || r.published_at || r.publishedAt || r.publish_date || r.published || r.age);
  let site = str(r.site_name || r.siteName || r.source).trim();
  if (!site) { try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { site = ''; } }
  return { title: title || url, url: url.slice(0, 500), snippet: snippet, content: content, date: date, site: site.slice(0, 80) };
}
function normalizeItems(payload) {
  const out = [];
  const seen = new Set();
  for (const r of pickArray(payload)) {
    const it = normalizeItem(r);
    if (!it || seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}
function errMessageOf(payload) {
  try {
    if (payload && payload.error) {
      if (typeof payload.error === 'string') return payload.error;
      if (payload.error.message) return String(payload.error.message);
    }
    if (payload && payload.message) return String(payload.message);
  } catch (e) {}
  return '';
}

/** 真正调一次外部搜索 API；失败抛带 code/detail 的 Error（文案留给前端 tr） */
async function callApi(query, cfg, opts) {
  opts = opts || {};
  const q = str(query).trim();
  if (!q) throw makeError('bad_input', 'empty query');
  if (!cfg.endpoint) throw makeError('no_endpoint', '');
  const count = clampInt(opts.count != null ? opts.count : cfg.count, 1, MAX_COUNT, cfg.count);
  const body = { query: q, count: count, need_content: opts.content != null ? !!opts.content : !!cfg.content };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
  let res, text = '';
  try {
    res = await fetch(cfg.endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') throw makeError('timeout', 'timed out after ' + Math.round(timeoutMs / 1000) + 's');
    throw makeError('network', str(e && e.message));
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) throw makeError('http', errMessageOf(data).slice(0, 300), { status: res.status });
  if (!data) throw makeError('bad_response', '');
  if (data.error) throw makeError('api_error', errMessageOf(data).slice(0, 300));
  return normalizeItems(data).slice(0, count);
}

/** 内置搜索（server.js 注入）；统一返回 {items, blocked} */
async function builtinSearch(query, opts, fallback, failCode, failDetail) {
  opts = opts || {};
  if (typeof deps.builtin !== 'function') {
    return { provider: 'builtin', items: [], fallback: !!fallback, fallbackCode: failCode || '', fallbackDetail: failDetail || '', blocked: false };
  }
  let r;
  try {
    r = await deps.builtin(str(query), clampInt(opts.count, 1, MAX_COUNT, DEFAULT_COUNT), opts.days);
  } catch (e) {
    return { provider: 'builtin', items: [], fallback: !!fallback, fallbackCode: failCode || 'builtin_error', fallbackDetail: failDetail || str(e && e.message), blocked: false };
  }
  const items = Array.isArray(r) ? r : ((r && r.items) || []);
  return { provider: 'builtin', items: items, fallback: !!fallback, fallbackCode: failCode || '', fallbackDetail: failDetail || '', blocked: !!(r && r.blocked) };
}

/**
 * 统一搜索入口（collectSources 用）。
 * 返回 { provider, items, fallback, fallbackCode, fallbackDetail, blocked }
 *   · provider=builtin：用的是内置搜索；fallback=true 表示「指定的 API 失败后回落」
 *   · items[].content：搜索 API 直接带回来的网页正文（可能为空）
 */
async function search(query, opts) {
  opts = opts || {};
  const cfg = opts.config || config();
  if (cfg.provider === 'builtin') return builtinSearch(query, opts, false, '', '');
  if (!cfg.endpoint) return builtinSearch(query, opts, true, 'no_endpoint', '');
  try {
    const items = await callApi(query, cfg, opts);
    return { provider: cfg.provider, items: items, fallback: false, fallbackCode: '', fallbackDetail: '', blocked: false };
  } catch (e) {
    const code = str(e && e.code) || 'api_error';
    const detail = str(e && e.detail);
    deps.log('[search] ' + cfg.provider + ' call failed (' + code + '), falling back to builtin' + (detail ? ': ' + detail : ''));
    return builtinSearch(query, opts, true, code, detail);
  }
}

/**
 * 设置页「测试搜索」：带着表单里的值真实打一次（不保存），返回样例。
 * opts: { provider, base, apiKey, count, content, query, timeoutMs }
 */
async function test(opts) {
  opts = opts || {};
  const cfg = config(opts);
  const query = str(opts.query).trim() || 'DeepSeek web search';
  const t0 = Date.now();
  if (cfg.provider === 'builtin') {
    const r = await builtinSearch(query, { count: 5 }, false, '', '');
    const ok = r.items.length > 0;
    return {
      ok: ok,
      provider: 'builtin',
      endpoint: '',
      ms: Date.now() - t0,
      count: r.items.length,
      items: r.items.slice(0, 3).map(function (x) { return { title: x.title, url: x.url, snippet: x.snippet }; }),
      code: ok ? '' : (r.fallbackCode === 'builtin_error' ? 'builtin_error' : 'builtin_empty'),
      detail: r.fallbackDetail || ''
    };
  }
  try {
    const items = await callApi(query, cfg, { count: Math.min(5, cfg.count), timeoutMs: opts.timeoutMs });
    return {
      ok: true,
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      ms: Date.now() - t0,
      count: items.length,
      items: items.slice(0, 3).map(function (x) { return { title: x.title, url: x.url, snippet: x.snippet }; }),
      code: '',
      detail: ''
    };
  } catch (e) {
    return {
      ok: false,
      provider: cfg.provider,
      endpoint: cfg.endpoint,
      ms: Date.now() - t0,
      count: 0,
      items: [],
      code: str(e && e.code) || 'api_error',
      detail: str(e && e.detail),
      status: Number(e && e.status) || 0
    };
  }
}

module.exports = {
  PROVIDERS: PROVIDERS,
  DEFAULTS: { base: DEFAULT_BASE, path: DEFAULT_PATH, count: DEFAULT_COUNT, maxCount: MAX_COUNT },
  init: init,
  config: config,
  status: status,
  search: search,
  test: test,
  normalizeItems: normalizeItems,
  normalizeItem: normalizeItem,
  endpointOf: endpointOf
};
