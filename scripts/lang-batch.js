'use strict';
/**
 * 语言包翻译辅助脚本（开发期用，不参与运行时）
 *   node scripts/lang-batch.js split [每批条数]       把 zh-CN/ui.json 拆成 batches
 *   node scripts/lang-batch.js check <in.json> <out.json>   校验一批译文
 *   node scripts/lang-batch.js merge                   合并 .parts/*.out.json → en-US/ui.json
 *   node scripts/lang-batch.js status                  看已翻译/缺失统计
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ZH = path.join(APP_DIR, 'language', 'locales', 'zh-CN', 'ui.json');
const EN = path.join(APP_DIR, 'language', 'locales', 'en-US', 'ui.json');
const PARTS = path.join(APP_DIR, 'language', 'locales', 'en-US', '.parts');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function placeholders(s) { const m = String(s).match(/\{\d+\}/g) || []; return m.map(x => x.replace(/[{}]/g, '')).sort().join(','); }
function hasCJK(s) { return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(s)); }

function split(per) {
  const zh = readJson(ZH) || {};
  const keys = Object.keys(zh).sort();
  const size = Math.max(20, Number(per) || 280);
  fs.mkdirSync(PARTS, { recursive: true });
  let no = 0;
  for (let i = 0; i < keys.length; i += size) {
    no++;
    const chunk = keys.slice(i, i + size);
    const name = 'batch-' + String(no).padStart(2, '0');
    fs.writeFileSync(path.join(PARTS, name + '.in.json'), JSON.stringify(chunk, null, 1) + '\n', 'utf8');
  }
  console.log('已拆分 ' + keys.length + ' 条 → ' + no + ' 批（每批 ' + size + ' 条），目录：language/locales/en-US/.parts/');
}

function check(inFile, outFile) {
  const keys = readJson(inFile);
  const out = readJson(outFile);
  if (!Array.isArray(keys)) { console.error('输入文件不是 JSON 数组：' + inFile); process.exit(2); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) { console.error('输出文件不是 JSON 对象：' + outFile); process.exit(2); }
  const missing = keys.filter(k => !(k in out));
  const extra = Object.keys(out).filter(k => keys.indexOf(k) < 0);
  const badPlaceholder = [];
  const empty = [];
  const cjk = [];
  const nonString = [];
  for (const k of keys) {
    if (!(k in out)) continue;
    const v = out[k];
    if (typeof v !== 'string') { nonString.push(k); continue; }
    if (!v.trim()) { empty.push(k); continue; }
    if (placeholders(k) !== placeholders(v)) badPlaceholder.push([k, v]);
    if (hasCJK(v)) cjk.push([k, v]);
  }
  const problems = missing.length + extra.length + badPlaceholder.length + empty.length + nonString.length;
  console.log('输入 ' + keys.length + ' 条 · 输出 ' + Object.keys(out).length + ' 条'
    + ' · 缺 ' + missing.length + ' · 多 ' + extra.length + ' · 占位符不符 ' + badPlaceholder.length
    + ' · 空 ' + empty.length + ' · 非字符串 ' + nonString.length + ' · 残留中文 ' + cjk.length);
  for (const k of missing.slice(0, 10)) console.log('  缺: ' + JSON.stringify(k).slice(0, 120));
  for (const k of extra.slice(0, 10)) console.log('  多: ' + JSON.stringify(k).slice(0, 120));
  for (const [k, v] of badPlaceholder.slice(0, 10)) console.log('  占位符: ' + JSON.stringify(k) + ' → ' + JSON.stringify(v));
  for (const [k, v] of cjk.slice(0, 10)) console.log('  中文残留: ' + JSON.stringify(k).slice(0, 80) + ' → ' + JSON.stringify(v).slice(0, 80));
  if (problems) { console.error('校验失败：请修正后重跑。'); process.exit(1); }
  console.log('校验通过 ✓');
}

function merge() {
  let files = [];
  try { files = fs.readdirSync(PARTS).filter(f => /\.out\.json$/.test(f)).sort(); } catch (e) { files = []; }
  const merged = {};
  for (const f of files) {
    const obj = readJson(path.join(PARTS, f));
    if (!obj || typeof obj !== 'object') { console.error('跳过无法解析的 ' + f); continue; }
    Object.assign(merged, obj);
  }
  const zh = readJson(ZH) || {};
  const keys = Object.keys(zh).sort();
  const out = {};
  for (const k of keys) if (merged[k] != null) out[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in out)) out[k] = merged[k];
  fs.writeFileSync(EN, JSON.stringify(out, null, 1) + '\n', 'utf8');
  const missing = keys.filter(k => !(k in out));
  console.log('已合并 ' + files.length + ' 批 → ' + path.relative(APP_DIR, EN) + '：' + Object.keys(out).length + ' 条；中文源缺 ' + missing.length + ' 条');
  if (missing.length) fs.writeFileSync(path.join(PARTS, '..', '.missing.json'), JSON.stringify(missing, null, 1) + '\n', 'utf8');
}

function status() {
  const zh = readJson(ZH) || {};
  const en = readJson(EN) || {};
  const keys = Object.keys(zh);
  const done = keys.filter(k => en[k] != null).length;
  console.log('中文源 ' + keys.length + ' 条 · 英文已译 ' + done + ' 条（' + Math.round(done / Math.max(1, keys.length) * 100) + '%）· 缺 ' + (keys.length - done));
  let files = [];
  try { files = fs.readdirSync(PARTS).filter(f => /\.out\.json$/.test(f)).sort(); } catch (e) {}
  console.log('输出分批文件：' + files.length + ' 个');
}

const cmd = process.argv[2] || 'status';
if (cmd === 'split') split(process.argv[3]);
else if (cmd === 'check') check(process.argv[3], process.argv[4]);
else if (cmd === 'merge') merge();
else status();
