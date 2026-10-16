'use strict';
/**
 * 结构守卫回归：`node scripts/test-tut-guard.js`
 *
 * 为什么值得单独留一个测试：`server/tut-guard.js` 里的判据全是正则和阈值，
 * 改一个字就可能退回"用户点名要重写，AI 照做却被拒收"那个线上事故
 * （2026-10-14：连续两次各白写 3 分钟，重试还必然再失败一次）。
 * 纯文本、零依赖、不碰 AI，秒级跑完。
 */
const assert = require('node:assert');
const tutGuard = require('../server/tut-guard.js');

/* 造一份像样的教程：12 节"前文" + 25 节"后半本"（跟线上那份的结构同形） */
function makeTut() {
  const head = [];
  head.push('# 概念②：MCP 协议——为什么出现、和 Function Calling 什么关系');
  for (const t of ['一、学完这一章，你要能回答的六个问题', '二、前置知识：Function Calling', '三、90 分钟怎么切',
    'MCP 前因、角色、能力与传输', '一、前因：一份能力，要写 N 遍适配', '二、三角色：Host / Client / Server',
    '三、三类能力：别把 Resources 当 Tools', '四、两种传输', '五、和 Function Calling 的边界',
    '六、信任边界：第三方 Server 的越权风险', '七、映射到思而行：插件≈Server，路由≈Client']) {
    head.push('## ' + t + '\n\n' + '正文正文正文。'.repeat(20) + '\n');
  }
  const tail = [];
  for (const t of ['把 interview 工具包成 MCP Server 的三步实践', '第一步：盘点 API、数据结构与调用入口',
    '第二步：定义 tools / resources / prompts 与 JSON Schema，搭 Server 骨架',
    '第三步：在 Host/Client 注册并验证调用', '三步清单', '暂不接 MCP 的话术',
    '动手练习：画图、填表、写三问答案', '练习一：画出 MCP 架构图', '练习二：填写 FC vs MCP 对比表',
    '练习三：写出 3 个面试问答', '自测清单：理解层与操作层', '理解层', '操作层', '判定与补救',
    '验收标准：MCP 架构图、FC vs MCP 对比表、3 问答案', '延伸学习：MCP 官方规范与思而行映射']) {
    tail.push('## ' + t + '\n\n' + '正文正文正文。'.repeat(80) + '\n');
  }
  return head.join('\n') + tail.join('\n');
}
const ORIG = makeTut();
const ANCHOR = tutGuard.headings(ORIG).findIndex(h => /三步实践/.test(h.title));   // 范围起点（0 基）

/* 造"重排了后半本"的新文：前文原样，后半换成新结构 */
function restructure(src, { dropBefore = null } = {}) {
  const hs = tutGuard.headings(src);
  const at = hs.findIndex(h => /三步实践/.test(h.title));
  let head = src.slice(0, hs[at].offset);
  if (dropBefore) {                       // 故意删掉范围外的一节
    const i = hs.findIndex(h => h.title === dropBefore);
    head = head.replace(src.slice(hs[i].offset, hs[i + 1].offset), '');
  }
  const tail = ['## 一条主线：三步走', '## 第一步：盘点能力', '## 第二步：定义 tools / resources / prompts',
    '## 第三步：注册 Host 并跑通一次调用', '## 接不接 MCP：思而行的判断', '## 练习、自测与验收']
    .map(t => t + '\n\n' + '重写后的正文。'.repeat(120) + '\n').join('\n');
  return head + tail;
}

const RANGE_FB = '重写范围：从「把 interview 工具包成 MCP Server 的三步实践」这一节的第一行开始，'
  + '直到全篇结束；前面所有章节一律不动。末尾把练习、自测、验收合并成一节并去重。';
const LOCAL_FB = '把 3. 三类能力那一节改清楚点，其余章节一个字别动';
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

console.log('范围解析：');
T('引号里的章节名 + "直到全篇结束" → 定位到那一节', () => {
  const sc = tutGuard.parseEditScope(RANGE_FB, ORIG);
  assert.equal(sc.mode, 'range');
  assert.equal(sc.fromIdx, ANCHOR);
  assert.match(sc.fromTitle, /三步实践/);
});
T('用户原话（章节名没加引号）也能定位', () => {
  const sc = tutGuard.parseEditScope('把本教程从：把 interview 工具包成 MCP Server 的三步实践，这一节开始往后的内容重新写，看得晕', ORIG);
  assert.equal(sc.mode, 'range');
  assert.equal(sc.fromIdx, ANCHOR);
});
T('"第 7 节之后"优先认标题自己的编号（七、…），不按第 7 个标题算', () => {
  const sc = tutGuard.parseEditScope('从第 7 节之后的内容重新写', ORIG);
  assert.equal(sc.mode, 'range');
  assert.match(sc.fromTitle, /^七、/);
});
T('"从「A」到「B」之前" → 上界也要认（B 及其之后同样受保护）', () => {
  const hs = tutGuard.headings(ORIG);
  const sc = tutGuard.parseEditScope('重写范围：从「' + hs[2].title + '」开始，到「' + hs[5].title + '」这一节之前结束', ORIG);
  assert.equal(sc.mode, 'range');
  assert.equal(sc.fromIdx, 2);
  assert.equal(sc.toIdx, 5);
});
T('否定说法不算授权："不要写「允许重写结构」"', () => {
  /* 关键：那句否定语里的"允许重写"不能把整篇放行 */
  const t3 = tutGuard.headings(ORIG)[3].title;
  const sc = tutGuard.parseEditScope('不要写「允许重写结构」。只改「' + t3 + '」这一节', ORIG);
  assert.notEqual(sc.mode, 'all');
  assert.equal(sc.mode, 'range');            // "只改「X」这一节" → 就是这一节的范围
  assert.equal(sc.fromIdx, 3);
  assert.equal(tutGuard.parseEditScope('不允许改结构，只改这一节', ORIG).mode, 'doc');
});
T('只授权"某一节内部"不算整篇授权', () => {
  const t = tutGuard.headings(ORIG)[3].title;
  assert.notEqual(tutGuard.parseEditScope('重写范围：只重写「' + t + '」这一节，允许重写该节内部的子标题与结构。其余原样保留。', ORIG).mode, 'all');
});
T('"「A」之后的都不要动"是在钉边界，不是范围起点', () => {
  const t = tutGuard.headings(ORIG)[5].title;
  assert.equal(tutGuard.parseEditScope('「' + t + '」之后的章节都不要动，只改前面', ORIG).mode, 'doc');
});
T('"只重写「X」这一节" → 范围就是这一节本身（含它的子节），不是"从某处往后"', () => {
  const t = tutGuard.headings(ORIG)[5].title;
  const sc = tutGuard.parseEditScope('重写范围：只重写「' + t + '」这一节。边界钉死：前面所有章节一字不动；后面的原样保留。', ORIG);
  assert.equal(sc.mode, 'range');
  assert.equal(sc.fromIdx, 5);
  assert.equal(sc.toIdx, 6);                      // 就到下一节之前
  assert.match(sc.why, /只重写/);
});
T('"含其下子节" 时上界要跨过 ### 子节，一直到下一个同级标题', () => {
  const doc2 = ['# 标题', '## 甲节', '正文', '### 甲一', '正文', '### 甲二', '正文', '## 乙节', '正文', '## 丙节', '正文', '## 丁节', '正文'];
  const sc = tutGuard.parseEditScope('重写范围：只重写「甲节」这一节（含其下甲一、甲二）。其余不动。', doc2.join('\n'));
  assert.equal(sc.mode, 'range');
  assert.equal(sc.fromIdx, 0);
  assert.equal(sc.toIdx, 3, '应该包到「乙节」之前（含两个子节）');
});
T('只说改一小处 → 不做范围放行（整篇章节都要保留）', () => {
  assert.equal(tutGuard.parseEditScope(LOCAL_FB, ORIG).mode, 'doc');
});
T('明说允许重写结构 → 整篇放行', () => {
  assert.equal(tutGuard.parseEditScope('整篇重新组织一下，允许重写结构', ORIG).mode, 'all');
});
T('调用方显式放行（卡片上的「🔓 允许改结构再跑」）', () => {
  assert.equal(tutGuard.parseEditScope(LOCAL_FB, ORIG, { allowRestructure: true }).mode, 'all');
});

console.log('守卫判定：');
T('用户点名重写后半本、AI 照做 → 放行（原来这里会拒收）', () => {
  assert.equal(tutGuard.structureLoss(ORIG, restructure(ORIG), RANGE_FB), null);
  assert.equal(tutGuard.structureLoss(ORIG, restructure(ORIG), RANGE_FB, { allowRestructure: true }), null);
});
T('范围外的一节被删 → 拒收，且点名是哪一节', () => {
  const bad = restructure(ORIG, { dropBefore: '七、映射到思而行：插件≈Server，路由≈Client' });
  const r = tutGuard.structureLoss(ORIG, bad, RANGE_FB);
  assert.ok(r && r.kind === 'lost');
  assert.match(r.lost[0].title, /映射到思而行/);
});
T('范围内被删成空壳 → 拒收（kind=gutted）', () => {
  const gut = ORIG.slice(0, tutGuard.headings(ORIG)[ANCHOR].offset) + '## 新的结尾\n\n一句话带过。';
  const r = tutGuard.structureLoss(ORIG, gut, RANGE_FB);
  assert.ok(r && r.kind === 'gutted');
});
T('只改一小处却掉了大半本 → 拒收（老行为保住）', () => {
  const r = tutGuard.structureLoss(ORIG, restructure(ORIG), LOCAL_FB);
  assert.ok(r && r.kind === 'lost');
});
T('标题只是重新编号/换标点 → 不算章节消失', () => {
  const renamed = ORIG.replace(/^## /gm, '### ').replace(/^# /gm, '## ');
  assert.equal(tutGuard.structureLoss(ORIG, renamed, LOCAL_FB), null);
});
T('章节太少（<5）不做结构判断', () => {
  const tiny = '## 甲\n\nx\n\n## 乙\n\ny';
  assert.equal(tutGuard.structureLoss(tiny, '## 完全换掉\n\nz', LOCAL_FB), null);
});
T('成功回执能说清"哪几节没了"', () => {
  const note = tutGuard.structureChangeNote(ORIG, restructure(ORIG));
  assert.match(note, /章节结构有变化/);
  assert.match(note, /消失 \d+ 节/);
});

console.log('\n全部通过（' + n + ' 项）');
