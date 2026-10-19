'use strict';
/**
 * 数据依赖上下文块（纯函数 + 薄适配层）回归：node scripts/test-prompt-context-data.js
 *
 * 这三个块以前在 server.js 里直接查 DB 再拼文本。现在：
 *   - 纯函数：digestsBlockFrom / nodeSourcesBlockFrom / sourcesIndexBlockFrom
 *   - server.js 里的 digestsBlock / nodeSourcesBlock / sourcesIndexBlock 只负责取数据
 * 这里钉住格式、空值、截断、分组与预算。
 */
const assert = require('node:assert');
const c = require('../server/prompts/context.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

T('digestsBlockFrom 空列表返回空串', () => {
  assert.strictEqual(c.digestsBlockFrom([]), '');
  assert.strictEqual(c.digestsBlockFrom(null), '');
});

T('digestsBlockFrom 标题/主题/正文格式', () => {
  const s = c.digestsBlockFrom([{ title: '主题 A', content: '内容 A' }, { title: '', topic: 'b', content: '内容 B' }]);
  assert.ok(s.includes('【资料提炼汇总'));
  assert.ok(s.includes('### 主题 A'));
  assert.ok(s.includes('内容 A'));
  assert.ok(s.includes('### b'));
  assert.ok(s.includes('内容 B'));
});

T('digestsBlockFrom 正文最多 4000 字', () => {
  const s = c.digestsBlockFrom([{ title: 'T', content: 'x'.repeat(5000) }]);
  assert.strictEqual((s.match(/x/g) || []).length, 4000);
});

T('nodeSourcesBlockFrom 空列表返回空串', () => {
  assert.strictEqual(c.nodeSourcesBlockFrom([], 10), '');
  assert.strictEqual(c.nodeSourcesBlockFrom(null, 10), '');
});

T('nodeSourcesBlockFrom 标签/正文/maxLen', () => {
  const s = c.nodeSourcesBlockFrom([{ label: 'L0', body: 'B0' }], 5);
  assert.ok(s.includes('【本节点对应的资料'));
  assert.ok(s.includes('- L0：B0'));
  const long = c.nodeSourcesBlockFrom([{ label: 'L', body: 'x'.repeat(100) }], 5);
  assert.strictEqual((long.match(/x/g) || []).length, 5);
});

T('nodeSourcesBlockFrom 最多 12 条', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ label: 'L' + i, body: 'B' + i }));
  const s = c.nodeSourcesBlockFrom(items, 10);
  assert.ok(s.includes('- L11'));
  assert.ok(!s.includes('- L12'));
});

T('sourcesIndexBlockFrom 空列表返回空串', () => {
  assert.strictEqual(c.sourcesIndexBlockFrom([], 400, '', 14000), '');
  assert.strictEqual(c.sourcesIndexBlockFrom(null, 400, '', 14000), '');
});

T('sourcesIndexBlockFrom 计数/分组/星标', () => {
  const sources = [
    { quality: 0, site: '用户提供的图片', kind: 'JD', title: 'JD A' },
    { quality: 1, site: '知乎', kind: '文章', title: '好文' },
    { quality: 0, site: 'CSDN', kind: '文章', title: 'CSDN 1' },
    { quality: 0, site: 'B站', kind: '视频', title: '视频 1' }
  ];
  const s = c.sourcesIndexBlockFrom(sources, 400, '', 14000);
  assert.ok(s.includes('共 4 条：自己提供 1 / 网络检索 3'), s.slice(0, 120));
  assert.ok(s.includes('【自己提供】[用户提供的图片｜JD] JD A'));
  assert.ok(s.includes('★[知乎｜文章] 好文'));
  assert.ok(s.includes('▸ 文章（2）'));
  assert.ok(s.includes('▸ 视频（1）'));
});

T('sourcesIndexBlockFrom 自定义 scopeNote 与小预算截断', () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({ quality: 0, site: 'CSDN', kind: '文章', title: 'T' + i }));
  const s = c.sourcesIndexBlockFrom(sources, 400, '【自定义索引】' + 'x'.repeat(200), 80);
  assert.ok(s.includes('【自定义索引】'));
  assert.ok(s.includes('…（索引已按体积截断；需要更多时用检索结果）'));
});


T('siblingScopeBlockFrom 列出排除清单', () => {
  const s = c.siblingScopeBlockFrom(['节点 A', '节点 B']);
  assert.ok(s.includes('【本节范围'));
  assert.ok(s.includes('「节点 A」、「节点 B」'));
});
T('siblingScopeBlockFrom 空列表不列排除清单', () => {
  const s = c.siblingScopeBlockFrom([]);
  assert.ok(s.includes('【本节范围'));
  assert.ok(!s.includes('排除清单'));
});

T('sourcesBlockFrom 无资料时给提示语', () => {
  const s = c.sourcesBlockFrom([], 15, 10, x => String(x || ''));
  assert.ok(s.includes('没有检索到网络信息源'));
});
T('sourcesBlockFrom 星标/自己提供/网络分组', () => {
  const sources = [
    { quality: 0, site: '用户提供的图片', kind: 'JD', title: 'JD A', content: 'JD 正文' },
    { quality: 1, site: '知乎', kind: '文章', title: '好文', content: '优质正文' },
    { quality: 0, site: 'CSDN', kind: '文章', title: 'CSDN 1', content: 'CSDN 正文' }
  ];
  const s = c.sourcesBlockFrom(sources, 15, 10, x => String(x || '').replace(/\s+/g, ' ').trim());
  assert.ok(s.includes('优质信息源 1 条'));
  assert.ok(s.includes('用户自己提供 1 条'));
  assert.ok(s.includes('网络检索 1 条'));
  assert.ok(s.includes('【★优质信息源'));
  assert.ok(s.includes('【用户自己提供的资料'));
  assert.ok(s.includes('【网络检索到的信息源'));
});

T('qaRender 单选/quiz/空答案', () => {
  const qs = [{ id: 'q1', type: 'single', title: '单选', options: [{ v: 'a', label: 'A' }] }, { id: 'q2', type: 'quiz', title: '自测', options: [{ v: 'b', label: 'B' }], depth: 1 }];
  const r = c.qaRender(qs, { q1: 'a', q2: { picked: 'b', correct: true } }, 'goal');
  assert.strictEqual(r.any, true);
  assert.ok(r.lines.join('\n').includes('Q（单选）：单选'));
  assert.ok(r.lines.join('\n').includes('A：a'));
  assert.ok(r.lines.join('\n').includes('A：选「B」（答对，该知识点已掌握）'));
  const empty = c.qaRender(qs, {}, 'goal');
  assert.strictEqual(empty.any, false);
});

T('constraintsBlockFrom 编号与提示', () => {
  const s = c.constraintsBlockFrom([{ text: '每天 2 小时' }, { text: '只能周末学' }]);
  assert.ok(s.includes('1. 每天 2 小时'));
  assert.ok(s.includes('2. 只能周末学'));
  assert.ok(s.includes('最高优先级'));
  assert.strictEqual(c.constraintsBlockFrom([]), '');
});

T('goalQaBlockFrom 轮次/无答案/空', () => {
  const rounds = [{ round: 0, questions: [{ id: 'q1', type: 'text', title: '目标' }], answers: { q1: '转行' } }];
  const s = c.goalQaBlockFrom(rounds);
  assert.ok(s.includes('第 1 轮确认'));
  assert.ok(s.includes('Q（简答）：目标'));
  assert.ok(s.includes('A：转行'));
  assert.strictEqual(c.goalQaBlockFrom([{ round: 0, questions: [{ id: 'q1', type: 'text', title: 'T' }], answers: {} }]), '');
  assert.strictEqual(c.goalQaBlockFrom([]), '');
});

console.log('\n' + n + ' 项全部通过');
