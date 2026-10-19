'use strict';
/**
 * 思而行 · 「哪些文件里有界面文案」的唯一清单 + 提取入口
 * ============================================================================
 * build-language-source.js（生成源语言目录）和 scripts/check-i18n.js（守卫）
 * 必须用**同一份文件清单与同一套过滤规则** —— 否则守卫会和目录生成打架。
 */
const fs = require('node:fs');
const path = require('node:path');
const extract = require('./extract');

/* 单个文件直接列出 */
const UI_FILES = ['public/app.js', 'public/sdk.js'];
/* 目录 + 后缀扫描 */
const UI_DIRS = [
  { dir: 'public/plugins', ext: /\.js$/ },
  { dir: 'public', ext: /\.html$/ },
  /* 内置页面插件的 manifest（界面管理页会显示 name/description；是生成的，但文案在这里） */
  { dir: 'ui/plugins/builtin', ext: /manifest\.json$/ }
];
const SERVER_DIRS = [
  { dir: 'server', ext: /\.js$/, skip: [/^server[\\/]prompts[\\/]/, /^server[\\/]commands[\\/]/] }
];

function walk(appDir, relDir, ext, skip) {
  const out = [];
  const abs = path.join(appDir, relDir);
  let items = [];
  try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const rel = relDir.replace(/[\\/]+$/, '') + '/' + it.name;
    if (skip && skip.some(function (re) { return re.test(rel); })) continue;
    if (it.isDirectory()) out.push.apply(out, walk(appDir, rel, ext, skip));
    else if (it.isFile() && ext.test(it.name)) out.push(rel);
  }
  return out;
}

function isServerFile(label) { return /^server[\\/]/.test(label); }

/** 返回 [{file, label, server, tokenAllowed}]（去重、稳定排序） */
function sourceFiles(appDir) {
  const root = appDir || path.resolve(__dirname, '..');
  const labels = [];
  for (const f of UI_FILES) if (fs.existsSync(path.join(root, f))) labels.push(f);
  for (const g of UI_DIRS) {
    for (const rel of walk(root, g.dir, g.ext, null)) {
      if (/^public[\\/]ui-dist[\\/]/.test(rel)) continue;
      if (labels.indexOf(rel) >= 0) continue;
      labels.push(rel);
    }
  }
  for (const g of SERVER_DIRS) {
    for (const rel of walk(root, g.dir, g.ext, g.skip)) {
      if (labels.indexOf(rel) >= 0) continue;
      labels.push(rel);
    }
  }
  labels.sort();
  return labels.map(function (label) {
    const server = isServerFile(label);
    return {
      file: path.join(root, label),
      label: label,
      server: server,
      tokenAllowed: server
        ? function (tok, src) { return extract.serverTokenAllowed(src, tok); }
        : function (tok, src) { return extract.uiTokenAllowed(src, tok); }
    };
  });
}

/** 提取单文件候选（build 与 guard 共用） */
function extractFile(item) {
  const src = fs.readFileSync(item.file, 'utf8');
  const r = extract.extractFromSource(src, {
    label: item.label,
    mode: item.server ? 'server' : 'ui',
    tokenAllowed: item.tokenAllowed,
    maxLen: item.server ? 120 : 0
  });
  return { src: src, entries: r.entries, tokens: r.tokens };
}

/** 整仓提取 → {source:{key:key}, raw:{key:{files,count}}, perFile:{"label":{src,entries,tokens}}} */
function buildCatalog(appDir) {
  const files = sourceFiles(appDir);
  const perFile = {};
  const list = [];
  for (const item of files) {
    let r;
    try { r = extractFile(item); } catch (e) { continue; }
    perFile[item.label] = { src: r.src, entries: r.entries, tokens: r.tokens };
    list.push({ entries: r.entries });
  }
  const raw = extract.mergeEntries(list);
  const source = {};
  const keys = Object.keys(raw).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
  for (const k of keys) source[k] = k;
  return { source: source, raw: raw, perFile: perFile, files: files };
}

/**
 * 守卫用：每个文件「还没被 tr() 管起来」的界面文案 token 数。
 * 注意：只统计**会产出界面候选**且没被 tr(...) 包住的字面量。
 */
/** 生成物（不是人写的代码）：预算统计跳过，但它们仍会进源语言目录（文案要能翻） */
function isGeneratedLabel(label) {
  return /^ui[\\/]plugins[\\/]builtin[\\/]/.test(label);
}

function unmanagedCounts(appDir) {
  const built = buildCatalog(appDir);
  const out = {};
  for (const label of Object.keys(built.perFile)) {
    if (isGeneratedLabel(label)) continue;
    const f = built.perFile[label];
    let n = 0;
    for (const tok of f.tokens) {
      if (!extract.tokenYieldsDisplay(tok)) continue;
      if (extract.isManagedToken(f.src, tok)) continue;
      n++;
    }
    out[label] = n;
  }
  return { counts: out, source: built.source, files: built.files };
}

module.exports = { sourceFiles, extractFile, buildCatalog, unmanagedCounts, isServerFile, isGeneratedLabel };
