'use strict';
/**
 * 提示词包注册表回归：node --no-warnings scripts/test-prompt-packs.js
 * 纯内存 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const createRegistry = require('../server/prompts/registry.js');
const { digestBatchPrompt, digestSynthesisPrompt } = require('../server/prompts/digest.js');

const db = new DatabaseSync(':memory:');
const reg = createRegistry({ db: db, nowISO: function () { return '2026-10-17T00:00:00.000Z'; } });

function batchCtx(batch, idx, total) {
  return {
    batch: batch, batchNo: idx, total: total,
    items: batch.map(function (it) { return '## ' + it.label + '\n' + it.body; }).join('\n')
  };
}
function synthesisCtx(parts, meta) {
  return {
    partsArr: parts, total: meta.total, ownCount: meta.ownCount, netCount: meta.netCount,
    parts: parts.map(function (p) { return '### 第 ' + p.idx + ' 批\n' + JSON.stringify(p.data); }).join('\n')
  };
}

const batch = [
  { label: '资料 A', body: '正文 A：要求 Python 与 SQL。' },
  { label: '资料 B', body: '正文 B：要求分布式经验。' }
];
const parts = [
  { idx: 1, data: { tech: ['Python'], hard: ['本科'] } },
  { idx: 2, data: { roadmap: ['先学 SQL'], other: ['多练'] } }
];
const meta = { total: 9, ownCount: 3, netCount: 6 };
const batchCtxValue = batchCtx(batch, 1, 2);
const synthesisCtxValue = synthesisCtx(parts, meta);

// 1. 列表
const list = reg.list();
assert.strictEqual(list.length, 4);
assert.ok(list.some(function (p) { return p.id === 'sources.digest_batch' && p.source === 'builtin'; }));
assert.ok(list.some(function (p) { return p.id === 'sources.digest_synthesis' && p.editable === true; }));
assert.ok(list.some(function (p) { return p.id === 'chat.ask_rules' && p.source === 'builtin'; }));
assert.ok(list.some(function (p) { return p.id === 'chat.agent_rules' && p.editable === true; }));
console.log('  ✓ list 返回 4 个内置包（含 chat 规则）');

// 2. 无覆盖时 render 走 builtin，行为与重构前逐字一致
assert.strictEqual(reg.render('sources.digest_batch', batchCtxValue), digestBatchPrompt(batch, 1, 2));
assert.strictEqual(reg.render('sources.digest_synthesis', synthesisCtxValue), digestSynthesisPrompt(parts, meta));
console.log('  ✓ 无覆盖时 render = 原纯函数（逐字）');

// 3. 内置模板预览 = 原纯函数（非空样例）
const pv = reg.preview('sources.digest_batch', batchCtxValue);
assert.strictEqual(pv.source, 'builtin');
assert.strictEqual(pv.rendered, digestBatchPrompt(batch, 1, 2));
const pv2 = reg.preview('sources.digest_synthesis', synthesisCtxValue);
assert.strictEqual(pv2.rendered, digestSynthesisPrompt(parts, meta));
console.log('  ✓ 内置模板渲染 = 原纯函数（可安全预览）');

// 3b. chat 规则包：默认文本 = 原规则块；tutorialEditOp 是唯一动态块
const chat = require('../server/prompts/chat-packs.js');
assert.strictEqual(reg.render('chat.ask_rules', {}), chat.askRules());
assert.strictEqual(reg.render('chat.agent_rules', { tutorialEditOp: chat.TUTORIAL_EDIT_OP }), chat.agentRules({ tutorialEditOp: chat.TUTORIAL_EDIT_OP }));
assert.strictEqual(reg.render('chat.agent_rules', {}).indexOf('tutorial_edit'), -1);
console.log('  ✓ chat 规则包：ASK/Agent 默认文本 = 原规则块');

// 3b2. 批量 ops 策略（用户 2026-10-20 反馈：删除几十条资料被"单次最多 20 个操作"拆成多轮、还要回「继续」）
const agentBaseRules = chat.agentRules({});
assert.ok(agentBaseRules.indexOf('删除类操作') >= 0 && agentBaseRules.indexOf('不设上限') >= 0,
  'chat.agent_rules 必须说明删除类操作不设上限');
assert.ok(agentBaseRules.indexOf('单次最多 20 个操作') < 0, '不能再有一刀切的"单次最多 20 个操作"');
assert.ok(agentBaseRules.indexOf('不要自己把操作拆成多轮') >= 0, '必须明确禁止模型自己把操作拆成多轮');
console.log('  ✓ chat.agent_rules：删除类不设上限、禁止自己拆多轮');

// 3c. chat.agent_rules 覆盖 + 占位符注入 + reset
const agentPack = reg.get('chat.agent_rules');
reg.update('chat.agent_rules', agentPack.template.replace('5. 删除要谨慎', '5. 删除要谨慎（自定义）'), 'test');
const agentCustom = reg.render('chat.agent_rules', { tutorialEditOp: 'TUTORIAL_SLOT' });
assert.ok(agentCustom.indexOf('5. 删除要谨慎（自定义）') >= 0);
assert.ok(agentCustom.indexOf('TUTORIAL_SLOT') >= 0);
reg.reset('chat.agent_rules', 'test');
assert.strictEqual(reg.render('chat.agent_rules', { tutorialEditOp: 'TUTORIAL_SLOT' }), chat.agentRules({ tutorialEditOp: 'TUTORIAL_SLOT' }));
console.log('  ✓ chat.agent_rules 覆盖 + {{tutorialEditOp}} 注入 + reset');

// 4. update → 覆盖生效 + 版本 + 历史
const builtin = reg.get('sources.digest_batch');
const modified = builtin.template.replace('你是资料提炼助手。', '你是资料提炼助手（自定义版）。');
assert.notStrictEqual(modified, builtin.template);
const upd = reg.update('sources.digest_batch', modified, 'test:agent');
assert.strictEqual(upd.source, 'override');
assert.strictEqual(upd.version, 2);
assert.ok(reg.render('sources.digest_batch', batchCtxValue).indexOf('自定义版') >= 0);
assert.strictEqual(reg.history('sources.digest_batch').length, 1);
console.log('  ✓ update 覆盖生效 + version=2 + 历史 1 条');

// 5. reset → 恢复内置
const reset = reg.reset('sources.digest_batch', 'test:user');
assert.strictEqual(reset.source, 'builtin');
assert.strictEqual(reset.version, 1);
assert.strictEqual(reg.render('sources.digest_batch', batchCtxValue), digestBatchPrompt(batch, 1, 2));
assert.strictEqual(reg.history('sources.digest_batch').length, 2);
console.log('  ✓ reset 恢复内置模板');

// 6. 校验：缺占位符 / 缺关键内容
let e1 = null;
try { reg.update('sources.digest_batch', modified.split('{{items}}').join(''), 'test'); } catch (e) { e1 = e; }
assert.ok(e1 && e1.code === 'bad_input' && e1.message.indexOf('{{items}}') >= 0);
let e2 = null;
try { reg.update('sources.digest_batch', modified.split('- other').join('- 其它'), 'test'); } catch (e) { e2 = e; }
assert.ok(e2 && e2.code === 'bad_input' && e2.message.indexOf('- other') >= 0);
console.log('  ✓ 校验拦住缺占位符/缺关键内容');

// 7. 未知包
let e3 = null;
try { reg.update('nope', modified, 'test'); } catch (e) { e3 = e; }
assert.ok(e3 && e3.code === 'not_found');
assert.strictEqual(reg.preview('nope'), null);
console.log('  ✓ 未知提示词包被拒绝');

// 8. 自定义模板（含全部占位符与关键内容）可保存
const custom = builtin.template.replace('你是资料提炼助手。', '你是资料提炼助手（自定义版）。');
const upd2 = reg.update('sources.digest_synthesis', reg.get('sources.digest_synthesis').template.replace('你是资料提炼助手。', '你是资料提炼助手（自定义版）。').replace('下面是同一目标的资料提炼结果', '下面是同一目标的资料提炼结果（自定义）'), 'test');
assert.strictEqual(upd2.source, 'override');
console.log('  ✓ 自定义模板可保存 (synthesis)');

// 9. 动态注册 + async builtinRender（规划这类需要异步取资料的包）
(async function () {
  reg.register({
  id: 'test.async',
  title: '异步测试包',
  description: '测试动态注册',
  editable: true,
  placeholders: ['x'],
  mustInclude: ['ASYNC'],
  template: 'ASYNC {{x}} ' + '默认模板内容'.repeat(10),
  sampleCtx: { x: '样例' },
  builtinRender: async function (ctx) { return 'BUILTIN ' + ctx.x; }
});
assert.ok(reg.list().some(function (p) { return p.id === 'test.async'; }));
assert.strictEqual(await reg.renderAsync('test.async', { x: '1' }), 'BUILTIN 1');
const asyncTpl = 'ASYNC {{x}} ' + '自定义模板内容'.repeat(10);
reg.update('test.async', asyncTpl, 'test');
assert.ok(reg.hasOverride('test.async'));
assert.ok((await reg.renderAsync('test.async', { x: '1' })).indexOf('自定义模板内容') >= 0);
reg.reset('test.async', 'test');
assert.ok(!reg.hasOverride('test.async'));
assert.strictEqual(await reg.renderAsync('test.async', { x: '1' }), 'BUILTIN 1');
console.log('  ✓ 动态注册 + async builtinRender + 覆盖/回滚');

  // 10. 规划/资料类模板的占位符与关键契约齐全（不需要起服务）
  const sourcePacks = require('../server/prompts/sources-packs.js');
  const planPacks = require('../server/prompts/plan-packs.js');
  const tutorialPacks = require('../server/prompts/tutorial-packs.js');
  const tutorialRules = require('../server/prompts/tutorial-rules.js');
  const defs = Object.assign({}, sourcePacks, planPacks, tutorialPacks);
  for (const id of Object.keys(defs)) {
    const d = defs[id];
    assert.ok(d.template && d.template.length > 50, id + ' 模板太短');
    for (const ph of (d.placeholders || [])) assert.ok(d.template.indexOf('{{' + ph + '}}') >= 0, id + ' 缺少占位符 ' + ph);
    for (const s of (d.mustInclude || [])) assert.ok(d.template.indexOf(s) >= 0, id + ' 缺少关键内容 ' + s);
  }
  console.log('  ✓ 规划/资料/教程类模板占位符与契约齐全（' + Object.keys(defs).length + ' 个）');
  assert.ok(tutorialRules.budgetBlock({ target: 4000 }, 'md').indexOf('篇幅与结构') >= 0);
  assert.ok(tutorialRules.formatBlock('html').indexOf('DOCTYPE') >= 0);
  assert.ok(tutorialRules.formatBlock('md').indexOf('Markdown') >= 0);
  console.log('  ✓ 教程动态片段（budget / format）');

  console.log('\n14 项全部通过');
})().catch(function (e) { console.error('\n✗ ' + (e && e.stack || e)); process.exit(1); });
