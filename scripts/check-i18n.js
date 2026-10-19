'use strict';
/**
 * 思而行 · 语言（i18n）守卫 —— 发布前 / 提交前必须跑
 * ============================================================================
 *   node scripts/check-i18n.js              # 全套检查（默认）
 *   node scripts/check-i18n.js --update     # 收紧"中文硬编码预算"基线（只能用来记账）
 *   node scripts/check-i18n.js --stats      # 只打印统计
 *   node scripts/check-i18n.js --json       # 机器可读结果
 *
 * 它检查四件事（对应 AGENTS.md §8 / language/README.md 的规则）：
 *  ① 源语言目录 language/locales/zh-CN/ui.json 是否与代码同步 ——
 *     改了界面文字没跑 `npm run build:lang`，这里会红；
 *  ② 各语言包是否完整、占位符是否一致、英文里是否残留中文；
 *  ③ 中文硬编码预算（language/legacy-baseline.json）——
 *     旧代码还没迁移完的部分记在基线里；**新增的界面文字必须用 tr()**，
 *     否则某个文件的计数会超过基线、检查失败（棘轮只会越收越紧）；
 *  ④ 语言包文件本身的结构（meta 必填字段、UI 是否 原文→译文 的对象）。
 *
 * 零依赖、秒级、不联网、不写业务数据。
 */
const fs = require('node:fs');
const path = require('node:path');
const sourceFilesMod = require('../language/source-files');
const extract = require('../language/extract');

const APP_DIR = path.resolve(__dirname, '..');
const LANG_DIR = path.join(APP_DIR, 'language');
const ZH_UI = path.join(LANG_DIR, 'locales', 'zh-CN', 'ui.json');
const BASELINE = path.join(LANG_DIR, 'legacy-baseline.json');
const SOURCE_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const args = process.argv.slice(2);
const update = args.indexOf('--update') >= 0;
const statsOnly = args.indexOf('--stats') >= 0;
const asJson = args.indexOf('--json') >= 0;

const errors = [];
const warnings = [];
function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function hasCJK(s) { return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(s || '')); }
function placeholders(s) { return (String(s).match(/\{\d+\}/g) || []).map(function (x) { return x.replace(/[{}]/g, ''); }).sort().join(','); }
function isCJKTarget(meta, code) {
  if (meta && meta.cjk === true) return true;
  return /^(?:zh|ja|yue|wuu|hak)(?:-|$)/i.test(String(code || ''));
}
function rel(p) { return path.relative(APP_DIR, p).split(path.sep).join('/'); }

/* ---------------------------------------------------------------------------
 * ① 源语言目录 vs 代码
 * ------------------------------------------------------------------------- */
function checkSourceCatalog() {
  const built = sourceFilesMod.buildCatalog(APP_DIR);
  const catalog = readJson(ZH_UI);
  if (!catalog || typeof catalog !== 'object') {
    fail('源语言目录不存在或不是合法 JSON：language/locales/zh-CN/ui.json（先跑 npm run build:lang）');
    return { built: built, keys: Object.keys(built.source) };
  }
  const codeKeys = Object.keys(built.source);
  const catKeys = Object.keys(catalog);
  const added = codeKeys.filter(function (k) { return !(k in catalog); });
  const removed = catKeys.filter(function (k) { return !(k in built.source); });
  if (added.length || removed.length) {
    const lines = [];
    if (added.length) lines.push('新增 ' + added.length + ' 条：' + added.slice(0, 6).map(function (k) { return JSON.stringify(k).slice(0, 40); }).join('、') + (added.length > 6 ? ' …' : ''));
    if (removed.length) lines.push('移除 ' + removed.length + ' 条：' + removed.slice(0, 6).map(function (k) { return JSON.stringify(k).slice(0, 40); }).join('、') + (removed.length > 6 ? ' …' : ''));
    fail('源语言目录和代码不一致（' + lines.join('；') + '）。解决：node scripts/build-language-source.js');
  }
  return { built: built, keys: codeKeys };
}

/* ---------------------------------------------------------------------------
 * ② 语言包完整性 / 占位符 / 中文残留
 * ------------------------------------------------------------------------- */
function checkLocales(sourceKeys) {
  const dir = path.join(LANG_DIR, 'locales');
  let dirs = [];
  try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(function (d) { return d.isDirectory(); }).map(function (d) { return d.name; }); } catch (e) {}
  const report = [];
  for (const name of dirs) {
    const localeDir = path.join(dir, name);
    const meta = readJson(path.join(localeDir, 'meta.json'));
    const ui = readJson(path.join(localeDir, 'ui.json'));
    if (!meta || !meta.code) fail('语言 ' + name + '：meta.json 缺失或没有 code');
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) { fail('语言 ' + name + '：ui.json 缺失或不是对象'); continue; }
    const code = String((meta && meta.code) || name);
    const cjkTarget = isCJKTarget(meta, code);
    /* 「语言名称示例」这类条目本来就该保留日语/中文等原生写法：允许用允许清单豁免 */
    let cjkAllow = [];
    try {
      const allow = readJson(path.join(localeDir, 'cjk-allow.json'));
      if (Array.isArray(allow)) cjkAllow = allow;
    } catch (e) {}
    let missing = 0;
    let bad = 0;
    let cjk = 0;
    const cjkSamples = [];
    for (const key of Object.keys(ui)) {
      if (typeof ui[key] !== 'string' || !ui[key].trim()) { bad++; continue; }
      if (placeholders(key) !== placeholders(ui[key])) { bad++; if (bad <= 5) warn(code + '：占位符不一致 ' + JSON.stringify(key).slice(0, 60) + ' → ' + JSON.stringify(ui[key]).slice(0, 60)); }
      if (!cjkTarget && hasCJK(ui[key]) && cjkAllow.indexOf(key) < 0) {
        cjk++;
        if (cjkSamples.length < 5) cjkSamples.push(JSON.stringify(key).slice(0, 50) + ' → ' + JSON.stringify(ui[key]).slice(0, 50));
      }
    }
    for (const key of sourceKeys) if (!(key in ui)) missing++;
    const partialAllowed = !!(meta && meta.partial);
    if (missing && !partialAllowed) fail('语言 ' + code + '：缺 ' + missing + ' 条译文（会在界面上回退中文）。补法：见 language/README.md');
    if (bad) fail('语言 ' + code + '：' + bad + ' 条译文结构/占位符有问题');
    if (cjk) fail('语言 ' + code + '：' + cjk + ' 条译文残留中文，例如：' + cjkSamples.join('；'));
    const extra = Object.keys(ui).filter(function (k) { return sourceKeys.indexOf(k) < 0; });
    if (extra.length) warn('语言 ' + code + '：有 ' + extra.length + ' 条译文在源目录里已经不存在了（可清理）');
    report.push({ code: code, entries: Object.keys(ui).length, missing: missing, bad: bad, cjk: cjk, builtin: !!meta });
  }
  return report;
}

/* ---------------------------------------------------------------------------
 * ③ 中文硬编码预算（棘轮）
 * ------------------------------------------------------------------------- */
function checkBaseline() {
  const { counts, source } = sourceFilesMod.unmanagedCounts(APP_DIR);
  let total = 0;
  for (const k of Object.keys(counts)) total += counts[k];
  const base = readJson(BASELINE) || {};
  const baseFiles = base.files && typeof base.files === 'object' ? base.files : {};
  const over = [];
  const improved = [];
  for (const file of Object.keys(counts)) {
    const cur = counts[file];
    const old = Number(baseFiles[file] || 0);
    if (cur > old) over.push({ file: file, now: cur, base: old, delta: cur - old });
    else if (cur < old) improved.push({ file: file, now: cur, base: old, delta: old - cur });
  }
  for (const f of over) {
    fail('中文硬编码超预算：' + f.file + '（基线 ' + f.base + '，现在 ' + f.now + '，多了 ' + f.delta
      + '）—— 新增界面文字必须用 tr(\'中文原文\') 包起来（见 language/README.md）');
  }
  if (!over.length && !update) {
    for (const f of improved.slice(0, 12)) warn('可以收紧基线：' + f.file + '（' + f.base + ' → ' + f.now + '）');
  }
  return { counts: counts, total: total, over: over, improved: improved, sourceCount: Object.keys(source).length };
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */
function main() {
  const t0 = Date.now();
  const catalog = checkSourceCatalog();
  const localeReport = checkLocales(catalog.keys);
  const budget = checkBaseline();

  if (update) {
    const files = {};
    for (const file of Object.keys(budget.counts)) if (budget.counts[file] > 0) files[file] = budget.counts[file];
    const payload = {
      note: '中文硬编码预算（棘轮）：旧代码里还没迁移到 tr() 的界面文案数。只许降不许升；新增文案必须用 tr()。由 `node scripts/check-i18n.js --update` 生成。',
      updatedAt: new Date().toISOString(),
      total: budget.total,
      files: Object.keys(files).sort().reduce(function (o, k) { o[k] = files[k]; return o; }, {})
    };
    fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 1) + '\n', 'utf8');
    console.log('[check:i18n] 已更新预算基线：' + rel(BASELINE) + '（' + budget.total + ' 处待迁移）');
  }

  if (asJson) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      sourceEntries: budget.sourceCount,
      locales: localeReport,
      hardcoded: { total: budget.total, over: budget.over, improved: budget.improved.slice(0, 20) },
      ms: Date.now() - t0
    }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }

  if (statsOnly) {
    console.log('源语言词条：' + budget.sourceCount);
    for (const l of localeReport) console.log('  ' + l.code + '：' + l.entries + ' 条' + (l.missing ? '（缺 ' + l.missing + '）' : '') + (l.cjk ? '（残留中文 ' + l.cjk + '）' : ''));
    console.log('中文硬编码待迁移：' + budget.total + ' 处');
    const top = Object.keys(budget.counts).sort(function (a, b) { return budget.counts[b] - budget.counts[a]; }).slice(0, 15);
    for (const f of top) if (budget.counts[f]) console.log('  ' + String(budget.counts[f]).padStart(4) + '  ' + f);
    return;
  }

  for (const w of warnings) console.warn('[warn] ' + w);
  for (const e of errors) console.error('[error] ' + e);
  console.log('');
  console.log('[check:i18n] 源语言词条 ' + budget.sourceCount + ' · 语言包：'
    + localeReport.map(function (l) { return l.code + '(' + l.entries + (l.missing ? ',缺' + l.missing : '') + ')'; }).join(' · '));
  console.log('[check:i18n] 中文硬编码待迁移 ' + budget.total + ' 处（棘轮基线，只许降不许升）'
    + (budget.improved.length ? ' · 可收紧 ' + budget.improved.length + ' 个文件' : ''));
  if (errors.length) {
    console.error('[check:i18n] 失败：' + errors.length + ' 个问题，' + warnings.length + ' 个警告（' + (Date.now() - t0) + 'ms）');
    process.exit(1);
  }
  console.log('[check:i18n] 通过（' + (Date.now() - t0) + 'ms，' + warnings.length + ' 个警告）');
}

main();
