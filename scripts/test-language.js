'use strict';
/**
 * 思而行 · 国际化（language/）单元测试
 *   node --no-warnings scripts/test-language.js
 *
 * 不联网、不碰真实数据：语言包引擎用临时目录，AI 用假函数。
 * 覆盖：提取器 / 语言包引擎 / 校验 / AI 生成（假 AI 全流程）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extract = require('../language/extract');
const createLanguage = require('../language');
const createLanguageGenerator = require('../language/generate');

const APP_DIR = path.resolve(__dirname, '..');
let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function section(name) { console.log('\n' + name); }

/* ------------------------------------------------------------------ */
section('提取器 extract.js');
{
  const src = [
    '// 这是注释，不该被收进来',
    'const a = "保存";',
    'const b = `共 <b>${n}</b> 项`;',
    'const c = `<div class="x"><p>第一步：打开设置</p><input placeholder="例如：转行做 AI 产品经理"><span>共 ${n} 个节点</span></div>`;',
    'const d = `已删除 ${ok} 份，${fail} 份失败`;',
    'const e = "<b>已完成</b>";',
    'const f = `<span>${x}</span>`;',
    'const g = "&nbsp;保存&nbsp;";',
    'const url = "/api/health";'
  ].join('\n');
  const r = extract.extractFromSource(src, { label: 't.js' });
  const keys = Object.keys(r.entries);
  assert.ok(keys.indexOf('保存') >= 0, '普通字符串');
  assert.ok(keys.indexOf('共') >= 0 && keys.indexOf('项') >= 0, '内联标签夹着的片段');
  assert.ok(keys.indexOf('第一步：打开设置') >= 0, 'HTML 标签之间的文字');
  assert.ok(keys.indexOf('例如：转行做 AI 产品经理') >= 0, 'display 属性');
  assert.ok(keys.indexOf('共 {0} 个节点') >= 0, 'HTML 里的插值');
  assert.ok(keys.some(function (k) { return /^已删除 \{0\} 份，\s*\{1\} 份失败$/.test(k); }), '整段模板拼接');
  assert.ok(keys.indexOf('已完成') >= 0, '字符串里拼 HTML');
  assert.ok(keys.indexOf('保存') >= 0 && keys.indexOf('&nbsp;保存&nbsp;') < 0, 'HTML 实体解码');
  assert.ok(!keys.some(k => k.indexOf('这是注释') >= 0), '注释不收');
  assert.ok(!keys.some(k => k.indexOf('var ') >= 0 || k.indexOf('const ') >= 0), '代码不收');
  ok('提取规则（字符串/模板/HTML/占位符/实体/注释过滤）');

  const tokens = extract.scanTokens('const a = "保存"; // "注释"');
  const tok = tokens.find(function (x) { return x.value === '保存'; });
  assert.ok(tok, 'scanTokens 能找到字面量');
  const managedSrc = 'tr("保存")';
  const tok2 = extract.scanTokens(managedSrc)[0];
  assert.ok(extract.isManagedToken(managedSrc, tok2), 'tr() 包裹可识别');
  assert.ok(!extract.isManagedToken('toast("保存")', extract.scanTokens('toast("保存")')[0]), '非 tr() 不算托管');
  ok('tr() 托管识别（守卫棘轮依赖它）');
}

/* ------------------------------------------------------------------ */
section('语言引擎 language/index.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-lang-'));
const tmpData = path.join(tmpRoot, 'data');
const settings = {};
function makeEngine() {
  return createLanguage({
    appDir: APP_DIR,
    dataDir: tmpData,
    getSetting: function (k, d) { return settings[k] != null ? settings[k] : d; },
    setSetting: function (k, v) { settings[k] = String(v); },
    log: function () {}
  });
}
const engine = makeEngine();
{
  const codes = engine.codes();
  assert.ok(codes.indexOf('zh-CN') >= 0, '有中文');
  assert.ok(codes.indexOf('en-US') >= 0, '有英文');
  assert.strictEqual(engine.active(''), 'zh-CN', '默认中文');
  assert.strictEqual(engine.active('en-US,en;q=0.9'), 'en-US', '跟随浏览器 → 英文');
  assert.strictEqual(engine.active('zh-CN,zh;q=0.9,en;q=0.5'), 'zh-CN', '跟随浏览器 → 中文');
  assert.strictEqual(engine.active('ja-JP,ja;q=0.9'), 'zh-CN', '没有的语言回退中文');
  ok('语言列表 / 当前语言 / 跟随浏览器');

  const src = engine.sourceEntries();
  assert.ok(Object.keys(src).length > 1000, '源语言目录非空');
  assert.ok(src['保存'] === '保存', '源语言是 identity 目录');
  const zhDict = engine.clientDict('zh-CN');
  assert.strictEqual(Object.keys(zhDict.entries).length, 0, '源语言不必下发字典');
  const js = engine.packJs('zh-CN');
  assert.ok(js.indexOf('window.__SX_I18N_DATA__=') === 0, 'packJs 产出可执行脚本');
  ok('源语言目录 / 客户端字典 / packJs');

  assert.strictEqual(engine.setActive('en-US').ok, true, '切换英文');
  assert.strictEqual(engine.savedCode(), 'en-US', '设置里记住了');
  assert.strictEqual(engine.active(''), 'en-US', '显式设置优先于浏览器');
  assert.strictEqual(engine.setActive('fr-FR').ok, false, '不存在的语言不能切');
  assert.strictEqual(engine.setActive('').ok, true, '可以恢复跟随浏览器');
  assert.strictEqual(settings[engine.SETTING_KEY], '', '恢复自动');
  ok('切换语言 / 显式设置优先 / 非法语言拒绝');

  const v1 = engine.validateEntries({ '保存': 'Save', '共 {0} 个': '{0} items' }, {});
  assert.strictEqual(v1.ok, true, '合法译文');
  const v2 = engine.validateEntries({ '共 {0} 个': 'items' }, {});
  assert.strictEqual(v2.ok, false, '占位符丢失要报错');
  assert.ok(v2.errors.join('').indexOf('占位符') >= 0, '报错原因说清楚');
  const v3 = engine.validateEntries({ '保存': '' }, {});
  assert.strictEqual(v3.ok, false, '空译文要报错');
  ok('译文校验（占位符 / 空值）');

  const saved = engine.saveGenerated({
    meta: { code: 'eo', name: 'Esperanto', nativeName: 'Esperanto' },
    ui: { '保存': 'Konservi' }
  });
  assert.strictEqual(saved.ok, true, '保存生成语言包');
  assert.ok(fs.existsSync(path.join(tmpData, 'language', 'eo.json')), '落在 DATA_DIR/language');
  const list = engine.codes();
  assert.ok(list.indexOf('eo') >= 0, '列表里出现生成语言');
  assert.strictEqual(engine.setActive('eo').ok, true, '可以切到生成语言');
  assert.strictEqual(engine.clientDict('eo').entries['保存'], 'Konservi', '字典里是译文');
  const dup = engine.saveGenerated({ meta: { code: 'en-US', name: 'x' }, ui: { '保存': 'x' } });
  assert.strictEqual(dup.ok, false, '生成包不能覆盖内置语言');
  const del = engine.removeGenerated('eo');
  assert.strictEqual(del.ok, true, '删除生成语言');
  assert.strictEqual(settings[engine.SETTING_KEY], '', '删掉当前语言后恢复自动');
  ok('生成语言包保存 / 列表 / 删除（内置不可覆盖）');
}

async function main() {
/* ------------------------------------------------------------------ */
section('AI 生成 language/generate.js（假 AI，不花钱）');
const fakeState = { halfCalls: 0 };
function fakeAi(mode) {
  return async function (prompt) {
    if (prompt.indexOf('BCP-47') >= 0) {
      return '```json\n' + JSON.stringify({ code: 'eo', nativeName: 'Esperanto', englishName: 'Esperanto', rtl: false }) + '\n```';
    }
    if (prompt.indexOf('documentTitle') >= 0) {
      return JSON.stringify({ documentTitle: 'SiErXing: Your goal planner', documentDescription: 'Local-first goal planning.' });
    }
    const idx = prompt.lastIndexOf('输入：');
    assert.ok(idx >= 0, '翻译提示词里应有输入数组');
    if (mode === 'half') {
      /* 只让第一批成功，后续批次全部返回空对象 → 覆盖率不足 */
      fakeState.halfCalls++;
      if (fakeState.halfCalls > 1) return '{}';
    }
    const input = JSON.parse(prompt.slice(idx + 3).trim());
    const out = {};
    for (const k of input) {
      out[k] = String(k)
        .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, function () { return 'x'; })
        .replace(/\{(\d+)\}/g, function (all) { return all; });
    }
    return JSON.stringify(out);
  };
}
{
  const gen = createLanguageGenerator({ language: engine, aiText: fakeAi(), log: function () {} });
  const phases = [];
  const r = await gen.generate({ name: 'Esperanto', progress: function (o) { phases.push(o.phase); } });
  assert.strictEqual(r.code, 'eo', '识别出语言代码');
  assert.ok(r.entries > 1000, '翻译出全部词条：' + r.entries);
  assert.ok(r.coverage >= 99, '覆盖率');
  const pack = engine.pack('eo');
  assert.ok(pack && Object.keys(pack.ui).length > 1000, '语言包可读');
  assert.ok(pack.meta.documentTitle, '文档标题翻译');
  assert.ok(phases.indexOf(0) >= 0 && phases.indexOf(1) >= 0 && phases.indexOf(2) >= 0, '有阶段进度');
  ok('假 AI 全流程：识别语言 → 分批翻译 → 校验保存（' + r.entries + ' 条）');
  engine.removeGenerated('eo');
}
{
  /* 从语言清单点选（preset）：跳过"识别语言"的 AI 调用，直接按清单代码/名称生成 */
  let askedIdentify = 0;
  const spyAi = async function (prompt) {
    if (prompt.indexOf('BCP-47') >= 0) { askedIdentify++; return JSON.stringify({ code: '', nativeName: '', englishName: '', rtl: false }); }
    if (prompt.indexOf('documentTitle') >= 0) return JSON.stringify({ documentTitle: 't', documentDescription: 'd' });
    const idx = prompt.lastIndexOf('输入：');
    const input = JSON.parse(prompt.slice(idx + 3).trim());
    const out = {};
    for (const k of input) out[k] = k.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, 'x');
    return JSON.stringify(out);
  };
  const gen2 = createLanguageGenerator({ language: engine, aiText: spyAi, log: function () {} });
  const r2 = await gen2.generate({ name: '日本語', preset: { code: 'ja-JP', nativeName: '日本語', englishName: 'Japanese', rtl: false } });
  assert.strictEqual(r2.code, 'ja-jp', 'preset 语言代码（统一小写）');
  assert.strictEqual(askedIdentify, 0, 'preset 不应再调"识别语言"的 AI');
  engine.removeGenerated('ja-jp');
  ok('语言清单点选（preset）：跳过识别调用，直接用清单代码/名称生成');
}
{
  /* 半途失败：覆盖率过低 → 抛错，但已翻译部分保存 */
  const gen = createLanguageGenerator({ language: engine, aiText: fakeAi('half'), log: function () {} });
  let err = null;
  try { await gen.generate({ name: 'Esperanto' }); } catch (e) { err = e; }
  assert.ok(err, '覆盖率低应抛错');
  assert.ok(engine.pack('eo') === null || Object.keys(engine.pack('eo').ui).length < 5296, '部分译文已落盘');
  engine.removeGenerated('eo');
  ok('覆盖率过低会报错（已译部分仍保存，可续/重试）');
}
{
  /* 取消：signal 已 aborted → 立刻抛 cancelled */
  const gen = createLanguageGenerator({ language: engine, aiText: fakeAi(), log: function () {} });
  const ac = new AbortController();
  ac.abort();
  let err = null;
  try { await gen.generate({ name: 'Esperanto', signal: ac.signal }); } catch (e) { err = e; }
  assert.ok(err && (err.cancelled || /已停止/.test(err.message)), '取消能中断');
  ok('取消（AbortSignal）');
}
{
  /* 坏译文（占位符不一致 / 残留中文）会被重试后丢弃，不写进语言包 */
  const badAi = async function (prompt) {
    if (prompt.indexOf('BCP-47') >= 0) return JSON.stringify({ code: 'eo', nativeName: 'Eo', englishName: 'Eo', rtl: false });
    if (prompt.indexOf('documentTitle') >= 0) return JSON.stringify({ documentTitle: 't', documentDescription: 'd' });
    const idx = prompt.lastIndexOf('输入：');
    const input = JSON.parse(prompt.slice(idx + 3).trim());
    const out = {};
    for (const k of input) {
      if (/\{\d+\}/.test(k)) out[k] = 'bad translation';          /* 故意丢占位符 */
      else if (k === '保存') out[k] = '保存仍然是中文';              /* 故意残留中文 */
      else out[k] = k.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, 'x');
    }
    return JSON.stringify(out);
  };
  const gen = createLanguageGenerator({ language: engine, aiText: badAi, log: function () {} });
  const r = await gen.generate({ name: 'Esperanto' });
  assert.ok(r.coverage >= 90, '坏条目被丢弃后仍能达到覆盖率门槛：' + r.coverage + '%');
  assert.ok(r.entries < 5296, '坏条目没有全部进包：' + r.entries);
  const pack = engine.pack('eo');
  if (pack) {
    for (const k of Object.keys(pack.ui)) {
      const got = (String(pack.ui[k]).match(/\{\d+\}/g) || []).length;
      const want = (String(k).match(/\{\d+\}/g) || []).length;
      assert.strictEqual(got, want, '进包的译文占位符必须一致：' + k);
      assert.ok(!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(pack.ui[k]), '进包的译文不得残留中文：' + k);
    }
    engine.removeGenerated('eo');
  }
  ok('坏译文（占位符/中文残留）重试后丢弃，不进语言包');
}



  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  console.log('\n全部通过：' + passed + ' 组测试 ✓');
}
main().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });