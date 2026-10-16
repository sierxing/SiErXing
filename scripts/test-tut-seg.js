'use strict';
/**
 * 分节改写（长教程）回归：`node scripts/test-tut-seg.js`
 *
 * 为什么单独留：切块边界、拼装偏移、模型多吐/少吐的清理，这几处错一个，
 * 结果就是"改完的教程被拼错位 / 内容重复 / 标题消失"——比不改更糟。
 * 纯文本、零依赖、秒级跑完。
 */
const assert = require('node:assert');
const guard = require('../server/tut-guard.js');
const seg = require('../server/tut-seg.js');

/* 造一份够长的教程：12 节，每节 ~3000 字（总 ~36K） */
const doc = ['# 概念②：MCP 协议'];
for (let i = 1; i <= 12; i++) {
  doc.push('## 第' + i + '节：主题 ' + i + '\n\n' + ('这是第' + i + '节独有的正文，只属于这一节。'.repeat(200)) + '\n');
}
const ORIG = doc.join('\n');
const hs = guard.headings(ORIG);
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

console.log('切块：');
T('点名一段 → 只切这一段，范围外不在块里', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  assert.ok(cs.length >= 2, '应该切成多块');
  assert.equal(cs[0].start, hs[2].offset);
  assert.equal(cs[cs.length - 1].end, hs[5].offset);          // 到「下一节」之前结束
  assert.ok(cs.every(c => c.chars > 0));
});
T('切块首尾相接、不重不漏', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i].start, cs[i - 1].end);
});
T('到全篇末尾（toIdx = 标题数）时最后一块收在文末', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 8, hs.length, 4000);
  assert.equal(cs[cs.length - 1].end, ORIG.length);
});
T('单节超长且内部没有标题 → 按行边界再切', () => {
  const big = '## 超长一节\n\n' + ('一句话。'.repeat(2000)) + '\n\n## 下一节\n\nx';
  const bs = guard.headings(big);
  const cs = seg.splitScopeChunks(big, bs, 0, 1, 3000);
  assert.ok(cs.length >= 2, cs.length + ' 块');
  assert.ok(cs.every(c => c.chars <= 3000 * 1.6));
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i].start, cs[i - 1].end);
});
T('每块都记了段首原文（用来补回被吃掉的标题）', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  assert.match(cs[0].firstLineRaw, /^## 第3节：主题 3$/);
});

console.log('清理模型返回：');
T('多吐了下一段 → 在下一段标题处截断', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  const raw = '## 第3节：主题 3\n\n改好的内容\n\n## 第4节：主题 4\n\n这段不该由我输出';
  const out = seg.cleanSegment(raw, cs[0], '第4节：主题 4', true);
  assert.ok(!out.includes('这段不该由我输出'));
  assert.ok(out.includes('改好的内容'));
});
T('把段首标题吃掉 → 补回来', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  const out = seg.cleanSegment('改好的内容，但没有标题\n', cs[0]);
  assert.match(out.split('\n')[0], /^## 第3节：主题 3$/);
});
T('整段被 ``` 包住 → 剥掉外壳', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  const out = seg.cleanSegment('```markdown\n## 第3节：主题 3\n\n内容\n\n```json\n{"a":1}\n```\n```\n', cs[0]);
  assert.ok(!out.startsWith('```markdown'));
  assert.ok(out.includes('```json'));
});
T('回显了输入标记 → 剥掉', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  const out = seg.cleanSegment('<<<SEGMENT_START>>>\n## 第3节：主题 3\n\n内容\n<<<SEGMENT_END>>>\n', cs[0]);
  assert.ok(!/SEGMENT_/.test(out));
});

console.log('拼装：');
T('范围外逐字保留、范围内换成新文', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  const outs = cs.map((c, i) => '## 第' + (3 + Number(i)) + '节：重写后的\n\n新的正文 ' + i + '\n');
  const merged = seg.splice(ORIG, cs, outs);
  assert.equal(merged.slice(0, cs[0].start), ORIG.slice(0, cs[0].start));
  assert.ok(merged.endsWith(ORIG.slice(cs[cs.length - 1].end)));
  assert.ok(merged.includes('新的正文 0'));
  assert.ok(!merged.includes('这是第3节独有的正文'));
  assert.ok(merged.includes('这是第6节独有的正文'));   // 范围外的原样还在
});
T('块数与结果数对不上 → 直接报错（宁可失败也不能拼错）', () => {
  const cs = seg.splitScopeChunks(ORIG, hs, 2, 5, 4000);
  assert.throws(() => seg.splice(ORIG, cs, ['只有一块']), /数量对不上/);
});
T('该不该分段：短教程不分，长教程点名了范围才分', () => {
  assert.equal(seg.shouldSegment('短', 'range', 28000), false);
  const long = 'x'.repeat(40000);
  assert.equal(seg.shouldSegment(long, 'range', 28000), true);
  assert.equal(seg.shouldSegment(long, 'doc', 28000), false);
});

console.log('\n全部通过（' + n + ' 项）');
