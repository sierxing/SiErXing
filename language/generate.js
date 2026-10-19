'use strict';
/**
 * 思而行 · 用 AI 生成一套新的界面语言
 * ============================================================================
 * 用户在「设置 → 语言」里输入「日本語 / Français / Kiswahili…」时：
 *   1. 先让 AI 给出语言代码（BCP-47，如 ja-JP）、本地名、英文名、是否 RTL；
 *   2. 把源语言目录（zh-CN/ui.json）分批发给 AI，翻译成目标语言；
 *   3. 校验（键齐全 / 占位符一致 / 不残留中文）后落 DATA_DIR/language/<code>.json；
 *   4. 前端刷新语言列表，用户点一下即可启用。
 *
 * 设计取舍：
 * - **分批**：5000+ 条文案一次塞不进上下文，按总字数/条数切批，单批失败只重试那一批；
 * - **可续**：每批成功即累加，最终失败也会把已翻译的返回（最多回退中文）；
 * - **不覆盖内置语言**：生成包不许顶掉 zh-CN / en-US，冲突自动改代码；
 * - 提示词/模型输出都不写进仓库：生成的语言包只落用户数据目录。
 */
const SIZE_LIMIT = 120;          /* 单批最多条数 */
const CHAR_LIMIT = 4200;         /* 单批最多源文字符数（控制上下文与费用） */
const MAX_RETRY = 2;             /* 单批解析/缺条目时的重试次数 */
const MIN_COVERAGE = 0.9;        /* 低于这个覆盖率算失败（已翻译的仍会保存） */

function parseJsonObject(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function placeholdersOf(s) {
  const out = String(s).match(/\{\d+\}/g) || [];
  return out.map(function (x) { return x.replace(/[{}]/g, ''); }).sort().join(',');
}
function hasCJK(s) { return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(s || '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function createLanguageGenerator(ctx) {
  const language = ctx.language;                  /* language/index.js 实例 */
  const aiText = ctx.aiText;                      /* (prompt, opts) => Promise<string> */
  const log = ctx.log || function () {};

  /** 让 AI 识别语言名 → 代码/本地名/英文名/是否从右往左 */
  async function identify(name, signal) {
    const prompt = [
      '你是多语言本地化专家。用户想在软件里新增一种界面语言，他输入的名称是：' + JSON.stringify(name),
      '请判断这指的是哪种语言，只输出一个 JSON 对象（不要代码围栏、不要解释）：',
      '{"code":"BCP-47 语言代码，如 ja-JP / fr-FR / ar-SA","nativeName":"该语言的本地写法（如 日本語 / Français / العربية）","englishName":"English name (e.g. Japanese)","rtl":false}',
      '要求：code 用小写语言 + 大写地区；rtl 表示是否从右往左书写；如果用户输入无法识别，code 用空字符串。'
    ].join('\n');
    const raw = await aiText(prompt, { scene: 'language.identify', timeoutMs: 60000, signal });
    const j = parseJsonObject(raw) || {};
    return {
      code: String(j.code || '').trim(),
      nativeName: String(j.nativeName || '').trim() || name,
      englishName: String(j.englishName || '').trim() || name,
      rtl: !!j.rtl
    };
  }

  function makeCode(info, name) {
    let code = String(info.code || '').trim().replace(/_/g, '-').toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(code)) {
      /* AI 没给可用代码：用名字的稳定短哈希兜底，保证同一种语言多次生成代码一致 */
      let h = 0;
      const src = String(name || 'language');
      for (let i = 0; i < src.length; i++) h = ((h << 5) - h + src.charCodeAt(i)) | 0;
      code = 'gen-' + Math.abs(h).toString(36).slice(0, 6);
    }
    /* 内置 / 已有生成语言冲突时换一个 */
    const exist = {};
    for (const p of language.locales()) exist[p.code.toLowerCase()] = 1;
    if (exist[code]) {
      let n = 2;
      while (exist[code + '-' + n]) n++;
      code = code + '-' + n;
    }
    return code;
  }

  /** 一批译文请求：返回 {ok 条数, miss 缺失 key, bad 占位符错误} */
  async function translateBatch(keys, meta, signal, onBatch) {
    const ask = function (batchKeys, extra) {
      return [
        '你是专业的软件界面本地化译者。把下面 JSON 数组里的中文界面文案翻译成「' + meta.nativeName + '」（' + meta.code + '）。',
        '要求：',
        '1. 只输出一个 JSON 对象：键 = 输入里的中文原文（逐字不变），值 = ' + meta.nativeName + ' 译文。不要代码围栏、不要解释、不要遗漏。',
        '2. 保留占位符 {0} {1} …（符号与数字不变，位置可调整）。保留 emoji、首尾空格、标点结构、HTML 标签、反引号里的代码（如 `npm run`、`#/g/1`）。',
        '3. 产品名「思而行」译作「SiErXing」。界面文案要简洁自然（按钮/标签不要写成句子）。',
        '4. 如果某条是句子片段（如「个」「：」「第」），译成在该界面语境下可拼接的短片段。',
        hasCJK(meta.nativeName) ? '' : '5. 译文中不得残留汉字。',
        extra || '',
        '输入：',
        JSON.stringify(batchKeys)
      ].filter(Boolean).join('\n');
    };
    let missing = keys.slice();
    const out = {};
    let bad = [];
    for (let attempt = 0; attempt <= MAX_RETRY && missing.length; attempt++) {
      if (signal && signal.aborted) throw cancelled();
      const raw = await aiText(ask(missing, attempt ? '上一次输出缺少这些键或不是合法 JSON，请重新完整输出（只输出 JSON 对象）。' : ''), {
        scene: 'language.translate', timeoutMs: 240000, signal
      });
      const obj = parseJsonObject(raw);
      if (!obj || typeof obj !== 'object') { await sleep(300); continue; }
      const still = [];
      for (const k of missing) {
        const v = obj[k];
        if (typeof v !== 'string' || !v.trim()) { still.push(k); continue; }
        if (placeholdersOf(k) !== placeholdersOf(v)) { bad.push(k); out[k] = v; continue; }   /* 占位符坏：先用译文，最后再重试 */
        if (!hasCJK(meta.nativeName) && hasCJK(v)) { bad.push(k); out[k] = v; continue; }
        out[k] = v;
      }
      /* 占位符/中文残留的条目下一轮重试（最多 2 轮），仍坏则丢弃 */
      missing = still.concat(bad.splice(0)).filter(function (k, i, arr) { return arr.indexOf(k) === i; });
      if (onBatch) onBatch(missing.length);
      if (!missing.length) break;
    }
    for (const k of missing) delete out[k];
    return { out: out, missing: missing };
  }

  /**
   * 主流程。
   * @param {{name:string, signal?:AbortSignal, progress?:Function}} opts
   * progress({phase, msg, count:{done,total}})
   */
  async function generate(opts) {
    const o = opts || {};
    const name = String(o.name == null ? '' : o.name).trim();
    if (!name) throw new Error('请先输入语言名称（例如：日本語 / Français）');
    if (name.length > 60) throw new Error('语言名称太长（最多 60 个字符）');
    const progress = typeof o.progress === 'function' ? o.progress : function () {};
    const signal = o.signal || null;

    const source = language.sourceEntries();
    const keys = Object.keys(source);
    if (!keys.length) throw new Error('源语言目录是空的（language/locales/zh-CN/ui.json）');

    progress({ phase: 0, msg: '正在识别语言：' + name });
    /* 从设置页的语言清单点进来的（preset）不用再让 AI 识别，省一次调用也避免识别跑偏 */
    const preset = o.preset || language.catalogFind(name) || null;
    const info = preset
      ? { code: preset.code, nativeName: preset.nativeName, englishName: preset.englishName, rtl: !!preset.rtl }
      : await identify(name, signal);
    const code = makeCode(info, name);
    const meta = {
      code: code,
      name: info.nativeName || name,
      nativeName: info.nativeName || name,
      englishName: info.englishName || name,
      rtl: !!info.rtl
    };
    log('[language] 生成目标语言：' + JSON.stringify(meta));

    /* 切批：按源文字符数与条数双上限（保持原顺序，便于分批重试） */
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const k of keys) {
      if (cur.length >= SIZE_LIMIT || chars + k.length > CHAR_LIMIT) {
        if (cur.length) batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(k);
      chars += k.length;
    }
    if (cur.length) batches.push(cur);

    const ui = {};
    let done = 0;
    progress({ phase: 1, msg: '准备翻译界面文案（共 ' + batches.length + ' 批）', count: { done: 0, total: keys.length } });
    for (let i = 0; i < batches.length; i++) {
      if (signal && signal.aborted) throw cancelled();
      const r = await translateBatch(batches[i], meta, signal);
      for (const k of Object.keys(r.out)) if (r.out[k] != null) ui[k] = r.out[k];
      done += Object.keys(r.out).length;
      progress({
        phase: 1,
        msg: '正在翻译界面文案：第 ' + (i + 1) + '/' + batches.length + ' 批（已译 ' + done + ' 条）',
        count: { done: done, total: keys.length }
      });
    }

    /* 文档标题 / 描述（不属于 ui 目录，单独翻一下；失败不影响主流程） */
    let title = '';
    let description = '';
    try {
      const zhMeta = language.sourceMeta();
      const raw = await aiText([
        '把下面两个字段翻译成「' + meta.nativeName + '」（' + meta.code + '），只输出 JSON 对象：{"documentTitle":"…","documentDescription":"…"}。',
        '产品名「思而行」译作「SiErXing」；标题要短；描述保持一段话。',
        JSON.stringify({ documentTitle: zhMeta.documentTitle || '', documentDescription: zhMeta.documentDescription || '' })
      ].join('\n'), { scene: 'language.meta', timeoutMs: 90000, signal });
      const j = parseJsonObject(raw) || {};
      title = String(j.documentTitle || '');
      description = String(j.documentDescription || '');
    } catch (e) {
      if (e && e.cancelled) throw e;
    }

    const coverage = keys.length ? Object.keys(ui).length / keys.length : 0;
    progress({ phase: 2, msg: '校验并保存语言包…', count: { done: Object.keys(ui).length, total: keys.length } });
    if (coverage < MIN_COVERAGE) {
      const err = new Error('这次只译出了 ' + Math.round(coverage * 100) + '% 的界面文案（低于 '
        + Math.round(MIN_COVERAGE * 100) + '%），可能 AI 接口不稳定。已译部分已保存，可重试或换模型。');
      err.code = 'low_coverage';
      /* 先保存，方便用户接着用/重试；再把错误抛出去让任务显示失败 */
      language.saveGenerated({ meta: Object.assign({ generatedBy: 'ai', generatedFrom: 'zh-CN' }, meta, { documentTitle: title, documentDescription: description }), ui: ui });
      throw err;
    }
    const saved = language.saveGenerated({
      meta: Object.assign({}, meta, {
        documentTitle: title,
        documentDescription: description,
        generatedBy: 'ai',
        generatedFrom: 'zh-CN'
      }),
      ui: ui
    });
    if (!saved.ok) throw new Error(saved.error || '保存语言包失败');
    progress({ phase: 2, msg: '已生成 ' + meta.nativeName + ' 语言包', count: { done: keys.length, total: keys.length } });
    return {
      code: saved.code,
      name: meta.nativeName,
      entries: saved.entries,
      coverage: Math.round(coverage * 100),
      missing: keys.length - saved.entries,
      file: saved.file,
      warnings: saved.entries < keys.length ? ['有 ' + (keys.length - saved.entries) + ' 条没译出来，界面上会回退中文'] : []
    };
  }

  function cancelled() {
    const e = new Error('已停止');
    e.cancelled = true;
    return e;
  }

  return { generate, identify, parseJsonObject, placeholdersOf };
}

module.exports = createLanguageGenerator;
module.exports.parseJsonObject = parseJsonObject;
