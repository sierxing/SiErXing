'use strict';
/**
 * 信息源把关（collect-screen）回归：`node scripts/test-collect-screen.js`
 *
 * 为什么留：这几条判据决定"什么进资料库"。松一格就退回"搜到就收"（实测 56% 是空壳、
 * 一半是水文），紧一格会把好文章挡在外面。纯文本、零依赖、秒级。
 */
const assert = require('node:assert');
const cs = require('../server/collect-screen.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

const items = [
  { i: 1, query: 'AI产品经理 学习路线', kind: '学习路线', site: 'CSDN', title: '字节跳动 RAG 实践手册', snippet: 'RAG 全流程', text: 'x'.repeat(2000), truncated: true },
  { i: 2, query: 'AI产品经理 学习路线', kind: '学习路线', site: 'bilibili', title: '【白嫖】软考中级信息安全工程师 高频考点汇总，建议收藏', snippet: '', text: 'y'.repeat(1500), truncated: false },
  { i: 3, query: 'AI产品经理 面经', kind: '面经', site: '牛客网', title: 'AI 产品经理一面面经（已上岸）', snippet: '面试流程', text: 'z'.repeat(1800), truncated: false },
  { i: 4, query: 'AI产品经理 面经', kind: '面经', site: '知乎', title: '如何转型 AI 产品经理', snippet: '只有摘要', text: '', truncated: false }
];

console.log('拼提示词：');
T('带上目标、每条编号/搜索词/站点/正文，并明确"截断的要标出来"', () => {
  const p = cs.buildScreenPrompt('找到 AI 产品经理实习', items, { batch: { no: 1, total: 2 } });
  assert.ok(p.includes('找到 AI 产品经理实习'));
  assert.ok(p.includes('#1｜'));
  assert.ok(p.includes('字节跳动 RAG 实践手册'));
  assert.ok(p.includes('这条是截断的'));
  assert.ok(/full/.test(p) && /一句话摘要/.test(p));
});
T('一条正文都没抓到的，会注明"只有搜索摘要"', () => {
  const p = cs.buildScreenPrompt('目标', [items[3]]);
  assert.ok(p.includes('正文一个都没抓到'));
});

console.log('解析判读：');
T('标准 JSON 能解析', () => {
  const raw = '[{"i":1,"score":5,"substance":true,"promo":false,"topic":"RAG","summary":"RAG 全流程实践手册","full":true}]';
  const m = cs.parseVerdicts(raw, items);
  assert.equal(m.get(1).score, 5);
  assert.equal(m.get(1).full, true);
  assert.equal(m.get(1).topic, 'RAG');
});
T('裹在 ``` 里、或夹杂说明文字也能救回来', () => {
  const raw = '好的，我来判读：\n```json\n[{"i":3,"score":4,"substance":true}]\n```\n以上。';
  const m = cs.parseVerdicts(raw, items);
  assert.equal(m.get(3).score, 4);
});
T('字段名写成 relevance / id 也认；分数会被夹到 0~5', () => {
  const m = cs.parseVerdicts('[{"id":2,"relevance":9,"promo":true}]', items);
  assert.equal(m.get(2).score, 5);
  assert.equal(m.get(2).promo, true);
});
T('不在本批编号里的一律忽略（模型编编号不能污染别的条目）', () => {
  const m = cs.parseVerdicts('[{"i":99,"score":5}]', items);
  assert.equal(m.size, 0);
});
T('乱码/空回复 → 空 Map（上层按"一条都不收"处理）', () => {
  assert.equal(cs.parseVerdicts('抱歉我无法判断', items).size, 0);
  assert.equal(cs.parseVerdicts('', items).size, 0);
});

console.log('放行判定：');
T('高分 + 有实质 + 非营销 → 收', () => {
  assert.equal(cs.gate({ score: 4, substance: true, promo: false }).keep, true);
});
T('营销页 / 没实质 / 低分 → 不收，且给出原因', () => {
  assert.equal(cs.gate({ score: 5, substance: true, promo: true }).reason, 'promo');
  assert.equal(cs.gate({ score: 5, substance: false, promo: false }).reason, 'no-substance');
  assert.equal(cs.gate({ score: 2, substance: true, promo: false }).reason, 'low-score(2)');
});
T('模型漏判这一条 → 不收（宁缺勿滥）', () => {
  assert.equal(cs.gate(null).keep, false);
});
T('阈值可调：严格=4、标准=3、宽松=2', () => {
  assert.equal(cs.gate({ score: 3, substance: true }, { minScore: 4 }).keep, false);
  assert.equal(cs.gate({ score: 3, substance: true }, { minScore: 3 }).keep, true);
  assert.equal(cs.gate({ score: 2, substance: true }, { minScore: 2 }).keep, true);
});

console.log('要不要抓全文：');
T('高质量 + 截断 → 抓全文（用户明确要求的那条）', () => {
  assert.equal(cs.needFullText({ score: 5, substance: true, full: true }, { truncated: true }), true);
  assert.equal(cs.needFullText({ score: 4, substance: true, full: false }, { truncated: true }), true);
});
T('高质量但没截断 / 低质量 → 不抓', () => {
  assert.equal(cs.needFullText({ score: 5, substance: true }, { truncated: false }), false);
  assert.equal(cs.needFullText({ score: 2, substance: true }, { truncated: true }), false);
});

console.log('本地硬闸门（不花 AI 就挡掉的）：');
T('正文太短（只有搜索摘要）→ 挡', () => {
  assert.equal(cs.hardGate({ title: 'x', text: '' }).reason, 'no-body(0)');
  assert.equal(cs.hardGate({ title: 'x', text: '短'.repeat(50) }).reason.startsWith('no-body'), true);
});
T('标题明显跑题（招考/考证类）→ 挡，正文里的顺嘴提及不误伤', () => {
  const re = /软考|公考|考研|四六级|期末|期末复习/;
  assert.equal(cs.hardGate({ title: '软考中级 高频考点汇总', text: 'x'.repeat(900) }, { offTopicRe: re }).reason, 'off-topic');
  assert.equal(cs.hardGate({ title: 'RAG 实践手册', text: '文中提到软考，x'.repeat(200) }, { offTopicRe: re }), null);
});
T('正常条目 → 交给 AI 判（返回 null）', () => {
  assert.equal(cs.hardGate({ title: 'AI 产品经理面经', text: 'x'.repeat(900) }, { offTopicRe: /软考/ }), null);
});

console.log('分批：');
T('每批不超过 18 条，切分不重不漏', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ i: i + 1 }));
  const bs = cs.batches(big, 18);
  assert.equal(bs.length, 3);
  assert.equal(bs[0].length, 18);
  assert.equal(bs[2].length, 4);
  assert.equal(bs.flat().length, 40);
});

console.log('\n全部通过（' + n + ' 项）');
