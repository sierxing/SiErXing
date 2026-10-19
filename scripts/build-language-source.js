'use strict';
/**
 * 思而行 · 构建源语言目录（language/locales/zh-CN/ui.json）
 * ============================================================================
 * 用法：
 *   node scripts/build-language-source.js            # 写入/更新源语言目录
 *   node scripts/build-language-source.js --check    # 只检查（守卫用，有漂移就退出码 1）
 *   node scripts/build-language-source.js --stats    # 打印每个文件的候选数量
 *   node scripts/build-language-source.js --missing-en  # 看英文包还缺哪些词条
 *
 * 规则（AGENTS.md §8 / language/README.md）：
 *   · 代码里的中文原文 = 语言 key（gettext 风格）；改文案 = 改代码 + 重跑本脚本；
 *   · 非中文语言的译文在 `language/locales/<code>/ui.json`（AI 生成的落 DATA_DIR）；
 *   · 新增的文案如果没跑本脚本，`npm run check:i18n` 会失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const extract = require('../language/extract');
const sourceFilesMod = require('../language/source-files');

const APP_DIR = path.resolve(__dirname, '..');
const UI_JSON = path.join(APP_DIR, 'language', 'locales', 'zh-CN', 'ui.json');
const EN_JSON = path.join(APP_DIR, 'language', 'locales', 'en-US', 'ui.json');

function sourceFiles() {
  return sourceFilesMod.sourceFiles(APP_DIR);
}

function build(files) {
  const built = sourceFilesMod.buildCatalog(APP_DIR);
  return { source: built.source, raw: built.raw, tokensByFile: built.perFile };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function loadSource() {
  const obj = readJson(UI_JSON);
  return obj && typeof obj === 'object' ? obj : {};
}

function build(files) {
  const perFile = [];
  const tokensByFile = {};
  const seen = {};
  for (const item of files) {
    let src = '';
    try { src = fs.readFileSync(item.file, 'utf8'); } catch (e) { continue; }
    const label = item.label;
    if (seen[label]) continue;
    seen[label] = 1;
    const isServer = /^server[\/]/.test(label);
    const r = extract.extractFromSource(src, {
      label: label,
      mode: isServer ? 'server' : 'ui',
      /* 服务端：只留可能显示到界面上的短句；UI：去掉提示词函数里的字面量 */
      tokenAllowed: isServer ? function (tok, src) { return extract.serverTokenAllowed(src, tok); } : function (tok, src) { return extract.uiTokenAllowed(src, tok); },
      maxLen: isServer ? 120 : 0
    });
    perFile.push(r);
    tokensByFile[label] = { entries: r.entries, tokens: r.tokens, src: src };
  }
  const merged = extract.mergeEntries(perFile);
  const source = {};
  const keys = Object.keys(merged).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
  for (const k of keys) source[k] = k;
  return { source: source, raw: merged, tokensByFile: tokensByFile };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.indexOf('--check') >= 0;
  const stats = args.indexOf('--stats') >= 0;
  const missingEn = args.indexOf('--missing-en') >= 0;
  const files = sourceFiles();
  const built = build(files);
  const keys = Object.keys(built.source);
  const chars = keys.reduce(function (a, k) { return a + k.length; }, 0);

  if (stats) {
    console.log('文件数：' + files.length + ' · 候选词条：' + keys.length + ' · 源语言总字数：' + chars);
    const rows = [];
    for (const label of Object.keys(built.tokensByFile)) {
      const n = Object.keys(built.tokensByFile[label].entries).length;
      if (n) rows.push([n, label]);
    }
    rows.sort(function (a, b) { return b[0] - a[0]; });
    for (const r of rows) console.log(String(r[0]).padStart(5) + '  ' + r[1]);
    const patterns = keys.filter(function (k) { return /\{\d+\}/.test(k); }).length;
    console.log('其中带占位符（{0}…）的模式词条：' + patterns);
  }

  if (missingEn) {
    const en = readJson(EN_JSON) || {};
    const missing = keys.filter(function (k) { return !(k in en); });
    const extra = Object.keys(en).filter(function (k) { return keys.indexOf(k) < 0; });
    console.log('英文包缺：' + missing.length + ' 条；多余（源目录里已没有）：' + extra.length + ' 条');
    if (missing.length) {
      fs.mkdirSync(path.join(APP_DIR, 'language', 'locales', 'en-US'), { recursive: true });
      const out = path.join(APP_DIR, 'language', 'locales', 'en-US', '.missing.json');
      fs.writeFileSync(out, JSON.stringify(missing, null, 1) + '\n', 'utf8');
      console.log('缺失清单已写到：language/locales/en-US/.missing.json');
    }
    return;
  }

  const prev = loadSource();
  const prevKeys = Object.keys(prev);
  const added = keys.filter(function (k) { return !(k in prev); });
  const removed = prevKeys.filter(function (k) { return keys.indexOf(k) < 0; });

  if (check) {
    if (!added.length && !removed.length) {
      console.log('[check:i18n] 源语言目录已是最新：' + keys.length + ' 条');
      return;
    }
    console.error('[check:i18n] 源语言目录和代码不一致：新增 ' + added.length + ' 条、移除 ' + removed.length + ' 条');
    for (const k of added.slice(0, 20)) console.error('  + ' + JSON.stringify(k).slice(0, 120));
    if (added.length > 20) console.error('  + …还有 ' + (added.length - 20) + ' 条');
    for (const k of removed.slice(0, 10)) console.error('  - ' + JSON.stringify(k).slice(0, 120));
    console.error('\n解决：node scripts/build-language-source.js  （然后补齐其它语言的译文）');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(UI_JSON), { recursive: true });
  fs.writeFileSync(UI_JSON, JSON.stringify(built.source, null, 1) + '\n', 'utf8');
  console.log('[build:lang] 已写入 ' + path.relative(APP_DIR, UI_JSON)
    + '：' + keys.length + ' 条' + (added.length ? '（新增 ' + added.length + '）' : '')
    + (removed.length ? '（移除 ' + removed.length + '）' : ''));
  if (added.length) {
    console.log('新增词条（需要补其它语言译文；英文可以跑 build 后看 --missing-en）：');
    for (const k of added.slice(0, 40)) console.log('  + ' + JSON.stringify(k).slice(0, 120));
    if (added.length > 40) console.log('  + …还有 ' + (added.length - 40) + ' 条');
  }
}

main();
