'use strict';
/**
 * 思而行 · 语言（i18n）引擎 —— 服务端
 * ============================================================================
 * 这个模块是「界面上的每一个字」的唯一权威来源。约定（改代码前必读）：
 *
 * 1. `language/locales/zh-CN/ui.json` 是**源语言目录**（写死在代码里的中文原文
 *    就是 key）。其它语言（`locales/<code>/ui.json`）是「key → 译文」的映射。
 *    中文是源语言，所以在代码里写中文原文不算"硬编码文案"——它就是 gettext 的 key；
 *    但**新增/修改文案必须跑** `npm run build:lang` 把新 key 收进目录，否则守卫会报。
 *
 * 2. `language/locales/<code>/meta.json` 存语言元信息（显示名 / html lang /
 *    文档标题和描述 / RTL 等）。
 *
 * 3. AI 现场生成的语言包**不写进仓库**，落 `DATA_DIR/language/<code>.json`
 *    （见 saveGenerated；升级程序不会覆盖用户生成的语言）。
 *
 * 4. `language/prompts/` 管提示词模板（不在这个文件里；见 language/prompts/README.md）。
 *
 * 零依赖：只用 node 内置模块；前端拿到的字典由 `packJs()` 产出。
 */
const fs = require('node:fs');
const path = require('node:path');

const SETTING_KEY = 'app_language';           // 空字符串 = 跟随浏览器语言
const DEFAULT_LOCALE = 'zh-CN';
const SOURCE_LOCALE = 'zh-CN';
const PACK_SCHEMA = 1;
const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

function normalizeCode(code) {
  return String(code == null ? '' : code).trim().replace(/_/g, '-');
}
function validCode(code) {
  return LOCALE_CODE_RE.test(normalizeCode(code));
}
/** 只保留"有内容"的条目：源语言里 key===value 的不必下发给前端 */
function compactEntries(entries) {
  const out = {};
  for (const k of Object.keys(entries || {})) {
    const v = entries[k];
    if (typeof v !== 'string') continue;
    if (!v || v === k) continue;
    out[k] = v;
  }
  return out;
}
/** 解析 Accept-Language，按顺序返回小写语言标签（去权重参数） */
function parseAcceptLanguage(raw) {
  return String(raw || '')
    .split(',')
    .map(function (part) {
      const seg = part.split(';')[0].trim();
      return seg ? seg.toLowerCase() : '';
    })
    .filter(Boolean);
}
function codeMatchesTag(code, tag) {
  const c = String(code || '').toLowerCase();
  if (!c || !tag) return false;
  if (c === tag) return true;
  return c.indexOf(tag + '-') === 0 || tag.indexOf(c + '-') === 0;
}

function createLanguage(options) {
  const opts = options || {};
  const appDir = opts.appDir || path.resolve(__dirname, '..');
  const dataDir = opts.dataDir || path.join(appDir, 'data');
  const getSetting = typeof opts.getSetting === 'function' ? opts.getSetting : function () { return ''; };
  const setSetting = typeof opts.setSetting === 'function' ? opts.setSetting : function () {};
  const log = typeof opts.log === 'function' ? opts.log : function () {};

  const ROOT = path.join(appDir, 'language');
  const BUILTIN_DIR = path.join(ROOT, 'locales');
  const PROMPT_DIR = path.join(ROOT, 'prompts');
  const USER_DIR = path.join(dataDir, 'language');

  /* ---------- 内置语言包（仓库里，随程序升级） ---------- */
  function listBuiltin() {
    let names = [];
    try { names = fs.readdirSync(BUILTIN_DIR, { withFileTypes: true }); } catch (e) { return []; }
    const out = [];
    for (const d of names) {
      if (!d.isDirectory()) continue;
      const meta = readJson(path.join(BUILTIN_DIR, d.name, 'meta.json'));
      if (!meta || !meta.code) continue;
      out.push({ code: normalizeCode(meta.code), dir: path.join(BUILTIN_DIR, d.name) });
    }
    return out;
  }
  /* ---------- 用户/AI 生成的语言包（DATA_DIR/language/<code>.json） ---------- */
  function listGeneratedFiles() {
    let names = [];
    try { names = fs.readdirSync(USER_DIR, { withFileTypes: true }); } catch (e) { return []; }
    const out = [];
    for (const f of names) {
      if (!f.isFile() || !/\.json$/i.test(f.name)) continue;
      out.push({ code: normalizeCode(f.name.replace(/\.json$/i, '')), file: path.join(USER_DIR, f.name) });
    }
    return out;
  }

  const builtinCache = new Map();
  const userCache = new Map();

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }
  function fingerprint(file) {
    try { const st = fs.statSync(file); return st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return ''; }
  }

  /** 内置语言包（meta + ui 合并；zh 的 ui 是源目录 identity） */
  function loadBuiltin(entry) {
    const fp = fingerprint(path.join(entry.dir, 'meta.json')) + '|' + fingerprint(path.join(entry.dir, 'ui.json'));
    const hit = builtinCache.get(entry.code);
    if (hit && hit.fp === fp) return hit.pack;
    const meta = readJson(path.join(entry.dir, 'meta.json')) || { code: entry.code, name: entry.code };
    const ui = readJson(path.join(entry.dir, 'ui.json')) || {};
    const prompts = readJson(path.join(entry.dir, 'prompts.json')) || null;
    const pack = { schema: PACK_SCHEMA, code: entry.code, meta: meta, ui: ui, prompts: prompts, builtin: true };
    builtinCache.set(entry.code, { fp: fp, pack: pack });
    return pack;
  }
  /** 用户生成的语言包 */
  function loadGenerated(entry) {
    const fp = fingerprint(entry.file);
    const hit = userCache.get(entry.code);
    if (hit && hit.fp === fp) return hit.pack;
    const raw = readJson(entry.file);
    if (!raw || typeof raw !== 'object') return null;
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : { code: entry.code, name: entry.code };
    const pack = {
      schema: Number(raw.schema) || PACK_SCHEMA,
      code: entry.code,
      meta: meta,
      ui: raw.ui && typeof raw.ui === 'object' ? raw.ui : {},
      prompts: raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : null,
      builtin: false,
      file: entry.file
    };
    userCache.set(entry.code, { fp: fp, pack: pack });
    return pack;
  }

  function allLocales() {
    const out = [];
    const seen = {};
    for (const b of listBuiltin()) {
      const pack = loadBuiltin(b);
      if (!pack || seen[b.code]) continue;
      seen[b.code] = 1;
      out.push(pack);
    }
    for (const g of listGeneratedFiles()) {
      if (seen[g.code]) continue;              /* 内置优先：生成包不覆盖内置（生成时已避开） */
      const pack = loadGenerated(g);
      if (!pack || !pack.meta || !pack.meta.name) continue;
      seen[g.code] = 1;
      out.push(pack);
    }
    /* 排序：源语言 > en-US > 其它（生成语言按显示名） */
    out.sort(function (a, b) {
      const rank = function (c) { return c === SOURCE_LOCALE ? 0 : c === 'en-US' ? 1 : 2; };
      const d = rank(a.code) - rank(b.code);
      if (d) return d;
      return String(a.meta.name || a.code).localeCompare(String(b.meta.name || b.code), 'zh');
    });
    return out;
  }

  function codes() { return allLocales().map(function (p) { return p.code; }); }
  function pack(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    return allLocales().find(function (p) { return p.code === c; }) || null;
  }

  /** 当前生效的语言代码（设置里显式选了就用它；否则跟随浏览器） */
  function active(acceptLanguage) {
    const saved = normalizeCode(getSetting(SETTING_KEY, '') || '');
    if (saved && pack(saved)) return saved;
    return auto(acceptLanguage);
  }
  /** 跟随浏览器：Accept-Language 里第一个"我们有的"语言 */
  function auto(acceptLanguage) {
    const locales = allLocales();
    const tags = parseAcceptLanguage(acceptLanguage);
    for (const tag of tags) {
      const hit = locales.find(function (p) { return codeMatchesTag(p.code, tag); });
      if (hit) return hit.code;
    }
    return DEFAULT_LOCALE;
  }
  function activePack(acceptLanguage) { return pack(active(acceptLanguage)) || pack(SOURCE_LOCALE); }
  /** 用户显式选择的语言代码（'' = 跟随浏览器）；给设置页回显用 */
  function savedCode() {
    const saved = normalizeCode(getSetting(SETTING_KEY, '') || '');
    return saved && pack(saved) ? saved : '';
  }
  function setActive(code) {
    const c = normalizeCode(code);
    if (!c) { setSetting(SETTING_KEY, ''); return { ok: true, code: '', auto: true }; }
    const p = pack(c);
    if (!p) return { ok: false, error: '没有这个语言包：' + c };
    setSetting(SETTING_KEY, c);
    return { ok: true, code: c };
  }

  /** 源语言目录里的全部条目（= 需要被翻译的文案清单） */
  function sourceEntries() {
    const p = pack(SOURCE_LOCALE);
    return p ? p.ui : {};
  }
  function sourceMeta() {
    const p = pack(SOURCE_LOCALE);
    return p ? p.meta : { code: SOURCE_LOCALE, name: '中文' };
  }

  /** 下发给前端的字典（只含"需要替换"的条目；源语言自定义过文案也支持） */
  function clientDict(code) {
    const p = pack(code);
    if (!p) return { code: code, name: code, nativeName: code, rtl: false, entries: {} };
    return {
      code: p.code,
      name: String(p.meta.name || p.code),
      nativeName: String(p.meta.nativeName || p.meta.name || p.code),
      englishName: String(p.meta.englishName || ''),
      rtl: !!p.meta.rtl,
      documentTitle: String(p.meta.documentTitle || ''),
      documentDescription: String(p.meta.documentDescription || ''),
      entries: compactEntries(p.ui)
    };
  }

  /** 给 index.html 用的入口脚本：window.__SX_I18N_DATA__ = {...} */
  function packJs(code) {
    const data = clientDict(code);
    return 'window.__SX_I18N_DATA__=' + safeJsonForScript(data) + ';\n';
  }
  function cfgJs(code, version) {
    const data = clientDict(code);
    const cfg = {
      code: data.code,
      name: data.name,
      nativeName: data.nativeName,
      rtl: data.rtl,
      documentTitle: data.documentTitle,
      documentDescription: data.documentDescription,
      version: String(version || '')
    };
    return 'window.__SX_I18N__=' + safeJsonForScript(cfg) + ';\n';
  }
  /** JSON 塞进 <script> 时必须防 `</script>` 与行分隔符 */
  function safeJsonForScript(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /** 简单 HTML 转义（注入 <title> / meta 用） */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 校验 ---------- */
  function placeholdersOf(s) {
    const out = [];
    const re = /\{(\d+)\}/g;
    let m;
    while ((m = re.exec(String(s)))) out.push(m[1]);
    return out;
  }
  function validateEntries(entries, source) {
    const errors = [];
    const warnings = [];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return { ok: false, errors: ['ui 必须是 "原文 → 译文" 的对象'], warnings: [] };
    }
    for (const key of Object.keys(entries)) {
      const val = entries[key];
      if (typeof val !== 'string') { errors.push('译文不是字符串：' + JSON.stringify(key).slice(0, 60)); continue; }
      if (!val.trim()) { errors.push('译文为空：' + JSON.stringify(key).slice(0, 60)); continue; }
      const want = placeholdersOf(key).sort().join(',');
      const got = placeholdersOf(val).sort().join(',');
      if (want !== got) {
        errors.push('占位符不一致：' + JSON.stringify(key).slice(0, 60) + ' → ' + JSON.stringify(val).slice(0, 60)
          + '（应含 {' + want.split(',').filter(Boolean).join('} {') + '}）');
      }
      const emoji = String(key).match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
      for (const e of emoji) {
        if (String(val).indexOf(e) < 0) warnings.push('译文丢了图标 ' + e + '：' + JSON.stringify(key).slice(0, 50));
      }
    }
    if (source) {
      const missing = Object.keys(source).filter(function (k) { return !(k in entries); });
      if (missing.length) warnings.push('缺 ' + missing.length + ' 条译文（会回退中文）：' + missing.slice(0, 8).map(function (k) { return JSON.stringify(k).slice(0, 30); }).join('、') + (missing.length > 8 ? ' …' : ''));
    }
    return { ok: errors.length === 0, errors: errors.slice(0, 30), warnings: warnings.slice(0, 20) };
  }

  /* ---------- 生成语言包（落 DATA_DIR，不进仓库） ---------- */
  function generatedFile(code) { return path.join(USER_DIR, code + '.json'); }
  function isBuiltinCode(code) { return listBuiltin().some(function (b) { return b.code === normalizeCode(code); }); }
  function saveGenerated(input) {
    const src = input || {};
    const meta = Object.assign({}, src.meta);
    const code = normalizeCode(meta.code);
    if (!validCode(code)) return { ok: false, error: '语言代码不合法：' + String(meta.code || '') };
    if (isBuiltinCode(code)) {
      /* 生成包不许顶掉内置语言（zh / en）——直接报错，让调用方换一个 code */
      return { ok: false, error: '这个语言代码是内置语言，不能覆盖：' + code };
    }
    const check = validateEntries(src.ui || {}, sourceEntries());
    if (!check.ok) return { ok: false, error: '语言包校验失败', errors: check.errors };
    meta.code = code;
    meta.name = String(meta.name || code).slice(0, 60);
    meta.nativeName = String(meta.nativeName || meta.name).slice(0, 60);
    meta.englishName = String(meta.englishName || '').slice(0, 60);
    meta.rtl = !!meta.rtl;
    meta.generated = true;
    meta.generatedAt = new Date().toISOString();
    const pack = {
      schema: PACK_SCHEMA,
      meta: meta,
      ui: src.ui || {},
      prompts: src.prompts && typeof src.prompts === 'object' ? src.prompts : null
    };
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      const tmp = generatedFile(code) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(pack, null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, generatedFile(code));
      userCache.delete(code);
      log('[language] 已保存生成语言包：' + code + '（' + Object.keys(pack.ui).length + ' 条）');
      return { ok: true, code: code, entries: Object.keys(pack.ui).length, file: generatedFile(code) };
    } catch (e) {
      return { ok: false, error: '写入语言包失败：' + ((e && e.message) || e) };
    }
  }
  function removeGenerated(code) {
    const c = normalizeCode(code);
    if (!c) return { ok: false, error: '缺少语言代码' };
    if (isBuiltinCode(c)) return { ok: false, error: '内置语言不能删除' };
    const file = generatedFile(c);
    if (!fs.existsSync(file)) return { ok: false, error: '没有这个语言包：' + c };
    try {
      fs.unlinkSync(file);
      userCache.delete(c);
      let reset = false;
      if (normalizeCode(getSetting(SETTING_KEY, '') || '') === c) { setSetting(SETTING_KEY, ''); reset = true; }
      log('[language] 已删除生成语言包：' + c);
      return { ok: true, code: c, resetActive: reset };
    } catch (e) {
      return { ok: false, error: '删除失败：' + ((e && e.message) || e) };
    }
  }

  /* ---------- 可选语言清单（language/languages.json） ---------- */
  function catalog() {
    const raw = readJson(path.join(ROOT, 'languages.json'));
    const list = raw && Array.isArray(raw.languages) ? raw.languages : [];
    return list.filter(function (x) { return x && x.code && x.nativeName; }).map(function (x) {
      return {
        code: normalizeCode(x.code).toLowerCase(),
        nativeName: String(x.nativeName),
        englishName: String(x.englishName || x.nativeName),
        emoji: String(x.emoji || '🌐'),
        rtl: !!x.rtl,
        builtin: !!x.builtin
      };
    });
  }
  /** 按代码 / 本地名 / 英文名在清单里找一项（AI 生成时用来跳过"识别语言"） */
  function catalogFind(text) {
    const s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s) return null;
    const list = catalog();
    return list.find(function (x) {
      return x.code.toLowerCase() === s
        || x.nativeName.toLowerCase() === s
        || x.englishName.toLowerCase() === s;
    }) || null;
  }

  /* ---------- 提示词模板（language/prompts/<code>/packs.json） ---------- */
  function promptTemplates(code) {
    const c = normalizeCode(code) || SOURCE_LOCALE;
    const file = path.join(PROMPT_DIR, c, 'packs.json');
    const pack = readJson(file);
    if (pack) return pack;
    return readJson(path.join(PROMPT_DIR, SOURCE_LOCALE, 'packs.json')) || {};
  }

  /** 给 /api/language/state 用的概览 */
  function state(acceptLanguage) {
    const act = active(acceptLanguage);
    const saved = savedCode();
    return {
      ok: true,
      active: act,
      saved: saved,
      auto: !saved,
      source: SOURCE_LOCALE,
      settingKey: SETTING_KEY,
      catalog: catalog().map(function (c) {
        const has = !!pack(c.code);
        return Object.assign({}, c, { installed: has });
      }),
      locales: allLocales().map(function (p) {
        const items = p.ui && typeof p.ui === 'object' ? p.ui : {};
        return {
          code: p.code,
          name: String(p.meta.name || p.code),
          nativeName: String(p.meta.nativeName || p.meta.name || p.code),
          englishName: String(p.meta.englishName || ''),
          rtl: !!p.meta.rtl,
          builtin: !!p.builtin,
          generated: !p.builtin,
          active: p.code === act,
          entries: Object.keys(items).length,
          translated: Object.keys(compactEntries(items)).length,
          generatedAt: String(p.meta.generatedAt || '')
        };
      })
    };
  }

  return {
    SETTING_KEY,
    DEFAULT_LOCALE,
    SOURCE_LOCALE,
    ROOT: ROOT,
    PROMPT_DIR: PROMPT_DIR,
    USER_DIR: USER_DIR,
    normalizeCode,
    validCode,
    locales: allLocales,
    codes,
    pack,
    active,
    activePack,
    auto,
    savedCode,
    setActive,
    sourceEntries,
    sourceMeta,
    catalog,
    catalogFind,
    clientDict,
    packJs,
    cfgJs,
    escHtml,
    validateEntries,
    saveGenerated,
    removeGenerated,
    generatedFile,
    promptTemplates,
    state
  };
}

module.exports = createLanguage;
module.exports.createLanguage = createLanguage;
