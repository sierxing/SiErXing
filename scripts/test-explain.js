'use strict';
/**
 * 看懂代码 · 纯文本回归：`node scripts/test-explain.js`
 *
 * 为什么单独留：这个组件的价值全在"讲解挂在正确的行上"。
 *   · chunkLines 错一个 → 有些行 AI 根本没被要求讲（会出现永远点不出内容的行）；
 *   · parseExplain / toBlocks 错一个 → 模型漏行时留洞、乱序时挂错行、越界时把别人的行覆盖掉。
 * 纯文本、零依赖、秒级跑完，不花一分钱 AI 调用。
 */
const assert = require('node:assert');
const EC = require('../server/explain-chunk.js');
const {
  chunkLines, parseExplain, toBlocks, detectLang, numCode, CHUNK_MAX_LINES,
  clarifyBlock, mergeFragments, parseOutline, normModules, fallbackModules, buildBatches, isFragmentLine
} = EC;

let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };
const cover = (blocks) => {
  const set = new Set();
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) set.add(i);
  return set;
};
const JS = [
  '#!/usr/bin/env node',                                  // 1
  'const readline = require("readline");',                // 2
  '',                                                     // 3
  'function main() {',                                    // 4
  '  const rl = readline.createInterface({',              // 5
  '    input: process.stdin,',                            // 6
  '    terminal: false',                                  // 7
  '  });',                                                // 8
  '  rl.on("line", line => {',                            // 9
  '    const msg = JSON.parse(line);',                    // 10
  '    if (msg.method === "initialize") {',               // 11
  '      console.log(JSON.stringify({ id: msg.id, result: { protocolVersion: "2024-11-05" } }));', // 12
  '    }',                                                // 13
  '  });',                                                // 14
  '}',                                                    // 15
  '',                                                     // 16
  'main();'                                               // 17
];

console.log('切段（chunkLines）：');
T('段与段首尾相接、不重不漏，覆盖到每一行', () => {
  const big = [];
  for (let i = 1; i <= 240; i++) big.push(i % 12 === 0 ? '' : '  line ' + i + '();');
  const cs = chunkLines(big, 1);
  assert.equal(cs[0].from, 1);
  assert.equal(cs[cs.length - 1].to, big.length);
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i].from, cs[i - 1].to + 1, '第 ' + i + ' 段与上一段不相接');
  assert.equal(cover(cs).size, big.length, '有行没被任何一段覆盖');
  assert.ok(cs.every(c => c.to - c.from + 1 <= CHUNK_MAX_LINES), '有段超过硬上限');
});
T('从中间开始（接着讲）也只覆盖 from..末尾', () => {
  const cs = chunkLines(JS, 9);
  assert.equal(cs[0].from, 9);
  assert.equal(cs[cs.length - 1].to, JS.length);
  assert.equal(cover(cs).size, JS.length - 8);
});
T('单行代码 → 只有一段', () => {
  const cs = chunkLines(['print("hi")'], 1);
  assert.deepEqual(cs, [{ from: 1, to: 1 }]);
});
T('段落不会切太碎（每段至少是"能断的地方"）', () => {
  const cs = chunkLines(JS, 1);
  assert.equal(cs.length, 1, '17 行的短代码不应该被切开');
});
T('大括号包围的整块尽量不拦腰断（断点在语句边界）', () => {
  const cs = chunkLines(JS.slice(0, 15), 1);
  for (const c of cs) {
    const last = JS[c.to - 1].trim();
    const okEnd = c.to === 15 || last === '' || /[{};:]\s*$/.test(last);
    assert.ok(okEnd, '第 ' + c.to + ' 行不是干净的断点：' + last);
  }
});

console.log('\n解析（parseExplain）：');
T('认 `### 第 N 行` 单行块', () => {
  const r = parseExplain('### 第 2 行\n这行引入了 readline。\n\n### 第 3 行\n空行，分段用。');
  assert.equal(r.items.length, 2);
  assert.deepEqual([r.items[0].from, r.items[0].to], [2, 2]);
  assert.match(r.items[0].text, /readline/);
});
T('认 `### 第 N-M 行` 区间块（含中文破折号 / 至 / ~）', () => {
  for (const title of ['### 第 5-7 行', '### 第 5–7 行', '### 第 5~7 行', '### 第 5 至 7 行']) {
    const r = parseExplain(title + '\n多行表达式。');
    assert.deepEqual([r.items[0].from, r.items[0].to], [5, 7], '没认出：' + title);
  }
});
T('`### 概览` 单独抽出来，不当成某一行', () => {
  const r = parseExplain('### 概览\n这段代码是个最小 MCP 服务端。\n\n### 第 1 行\n她是指令行声明。');
  assert.match(r.overview, /MCP/);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].from, 1);
});
T('`[[NAME: …]]` 抽出来，且不会留在正文里', () => {
  const r = parseExplain('### 第 1 行\n讲完了。\n\n[[NAME: MCP stdio 服务器的主循环]]');
  assert.equal(r.name, 'MCP stdio 服务器的主循环');
  assert.ok(!/\[\[NAME/.test(r.items[0].text), '收尾标记泄漏进正文了');
});
T('模型不写标题（整段白话）→ items 为空、内容留在 pre（调用方会退化成"整段一块"）', () => {
  const r = parseExplain('这段代码其实是……（直接开始讲）');
  assert.equal(r.items.length, 0);
  assert.match(r.pre, /直接开始讲/);
});
T('`**第 3 行**` 这种加粗写法读不出来（不会误挂到错误的行上）', () => {
  const r = parseExplain('**第 3 行**\n讲讲讲。');
  assert.equal(r.items.length, 0);
});
T('`### 第 N-M 行 · 模块名` 里那个名字要抽出来（挂在 pre 上没用，得给徽标）', () => {
  const r = parseExplain('### 第 5-14 行 · 建一条按行读的管道\n讲解正文。');
  assert.deepEqual([r.items[0].from, r.items[0].to], [5, 14]);
  assert.equal(r.items[0].title, '建一条按行读的管道');
});
T('标题前后有内容也不影响：第一个标题之前的东西进 pre', () => {
  const r = parseExplain('开场白一句。\n\n### 第 4 行\n第四行。');
  assert.match(r.pre, /开场白/);
  assert.equal(r.items[0].from, 4);
});

console.log('\n补洞与钳范围（toBlocks）：');
T('模型漏行 → 空隙并进相邻块，范围内没有洞', () => {
  const bs = toBlocks([{ from: 1, to: 3, text: 'a' }, { from: 7, to: 10, text: 'b' }], 1, 12);
  assert.equal(bs.length, 2);
  assert.equal(cover(bs).has(5), true, '第 5 行没人管');
  assert.equal(bs[bs.length - 1].to, 12, '结尾没补齐');
  assert.equal(cover(bs).size, 12);
});
T('模型越界（讲到了范围外）→ 钳到本段范围里', () => {
  const bs = toBlocks([{ from: 20, to: 40, text: 'x' }], 20, 30);
  assert.deepEqual([bs[0].from, bs[0].to], [20, 30]);
});
T('模型乱序 → 按行号排好再存', () => {
  const bs = toBlocks([{ from: 5, to: 6, text: 'b' }, { from: 1, to: 4, text: 'a' }], 1, 6);
  assert.deepEqual(bs.map(b => b.from), [1, 5]);
});
T('重叠块 → 合并成一块，不出现两条讲解抢同一行', () => {
  const bs = toBlocks([{ from: 1, to: 5, text: 'a' }, { from: 4, to: 8, text: 'b' }], 1, 8);
  assert.equal(bs.length, 1);
  assert.match(bs[0].text, /a[\s\S]*b/);
});
T('一块都没有 → 返回空（调用方走"整段存一块"的兜底）', () => {
  assert.deepEqual(toBlocks([], 1, 9), []);
});
T('从头到尾完整覆盖：[from, to] 的每一行都恰好属于一块', () => {
  const bs = toBlocks([{ from: 3, to: 3, text: 'a' }, { from: 5, to: 5, text: 'b' }], 1, 6);
  const c = cover(bs);
  for (let i = 1; i <= 6; i++) assert.ok(c.has(i), '第 ' + i + ' 行漏了');
});

console.log('\n模块大纲（AI 划模块 + 系统兜底）：');
const MOD_LINES = [
  'const readline = require("readline");',   // 1
  'const rl = readline.createInterface({',    // 2
  '  input: process.stdin,',                  // 3
  '  terminal: false',                        // 4
  '});',                                      // 5  ← 纯收尾符号
  '',                                         // 6  ← 空行
  'function handle(msg) {',                   // 7
  '  if (!msg) {',                            // 8
  '    return null;',                         // 9
  '  }',                                      // 10 ← 纯收尾符号
  '  return msg.id;',                         // 11
  '}',                                        // 12 ← 纯收尾符号
  'main();'                                   // 13
];
T('parseOutline 认 {modules:[{from,to,title}]}', () => {
  const ms = parseOutline('```json\n{"modules":[{"from":1,"to":5,"title":"建管道"},{"from":7,"to":12,"title":"处理消息"}]}\n```');
  assert.equal(ms.length, 2);
  assert.deepEqual([ms[0].from, ms[0].to, ms[0].title], [1, 5, '建管道']);
});
T('parseOutline 也认裸数组 / start-end 写法', () => {
  const ms = parseOutline('[{"start":1,"end":3,"name":"a"},{"start":4,"end":6,"name":"b"}]');
  assert.equal(ms.length, 2);
  assert.deepEqual([ms[0].from, ms[0].to, ms[0].title], [1, 3, 'a']);
});
T('parseOutline 遇到胡言乱语 → 空数组（调用方退回机械切段）', () => {
  assert.deepEqual(parseOutline('我觉得可以分成三块～'), []);
  assert.deepEqual(parseOutline(''), []);
});
T('normModules：AI 给的范围有洞/重叠 → 拼成首尾相接、不重不漏', () => {
  const ms = normModules([
    { from: 1, to: 3, title: 'a' }, { from: 5, to: 6, title: 'b' }, { from: 9, to: 13, title: 'c' }
  ], 13, MOD_LINES);
  assert.equal(ms[0].from, 1);
  assert.equal(ms[ms.length - 1].to, 13);
  for (let i = 1; i < ms.length; i++) assert.equal(ms[i].from, ms[i - 1].to + 1);
  const cov = new Set(); for (const m of ms) for (let i = m.from; i <= m.to; i++) cov.add(i);
  assert.equal(cov.size, 13);
});
T('normModules：只有 `}`/空行的模块不许单独存在（并进相邻模块）', () => {
  const ms = normModules([
    { from: 1, to: 5, title: '建管道' },
    { from: 6, to: 6, title: '空行' },        // 空行
    { from: 7, to: 7, title: '函数签名' },
    { from: 8, to: 10, title: '判空' },
    { from: 11, to: 11, title: '返回' },
    { from: 12, to: 12, title: '收尾括号' },   // 纯 }
    { from: 13, to: 13, title: '调用' }
  ], 13, MOD_LINES);
  assert.equal(ms.length, 5, ms.map(m => m.from + '-' + m.to).join(' / '));
  assert.deepEqual(ms.map(m => [m.from, m.to]), [[1, 6], [7, 7], [8, 10], [11, 12], [13, 13]]);
  assert.ok(!ms.some(m => /空行|收尾括号/.test(m.title)), '碎片模块的标题不该留下');
});
T('normModules：AI 越界（to 超过总行数）→ 钳住；末尾没覆盖 → 补齐', () => {
  const ms = normModules([{ from: 1, to: 99, title: 'x' }], 13, MOD_LINES);
  assert.deepEqual([ms[0].from, ms[0].to], [1, 13]);
});
T('normModules：AI 甩一个 100 行的巨块 → 按干净断点细拆（上限保护）', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(i % 5 === 4 ? '' : 'line ' + i + ';');
  const ms = normModules([{ from: 1, to: 100, title: '一大块' }], 100, lines);
  assert.ok(ms.length >= 3, '应该被拆成几块：' + ms.length);
  assert.ok(ms.every(m => m.to - m.from + 1 <= 40), ms.map(m => m.to - m.from + 1).join(','));
  assert.ok(ms.every(m => m.title === '一大块'), '拆出来的小块仍用原模块名');
  const cov = new Set(); for (const m of ms) for (let i = m.from; i <= m.to; i++) cov.add(i);
  assert.equal(cov.size, 100);
});
T('normModules：全非法 → 空数组', () => {
  assert.deepEqual(normModules([], 13, MOD_LINES), []);
  assert.deepEqual(normModules([{ from: 0, to: 0 }], 13, MOD_LINES), []);
});
T('mergeFragments：把"只有收尾符号"的块并进相邻块，内容块不动', () => {
  const blocks = [
    { from: 1, to: 4, text: 'A', title: 'a' },
    { from: 5, to: 5, text: '}', title: '' },        // 碎片 → 并进上一块
    { from: 6, to: 6, text: '空行', title: '' },      // 碎片 → 并进上一块
    { from: 7, to: 9, text: 'B', title: 'b' }
  ];
  const out = mergeFragments(blocks, MOD_LINES);
  assert.deepEqual(out.map(b => [b.from, b.to]), [[1, 6], [7, 9]]);
});
T('mergeFragments：开头就是碎片 → 并进下一块', () => {
  const out = mergeFragments([
    { from: 1, to: 1, text: '', title: '' },          // 第 1 行是代码，不是碎片 —— 换个真碎片试试
    { from: 5, to: 5, text: '}', title: '' },
    { from: 7, to: 9, text: 'B', title: 'b' }
  ].slice(1), MOD_LINES);
  assert.deepEqual(out.map(b => [b.from, b.to]), [[5, 9]]);
});
T('buildBatches：批次边界落在模块边界上、不超行数上限', () => {
  const ms = [{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 30 }, { from: 31, to: 40 }];
  const bs = buildBatches(ms, 1, { maxLines: 22, maxMods: 2 });
  assert.equal(bs.length, 2);
  assert.deepEqual(bs.map(b => [b.from, b.to]), [[1, 20], [21, 40]]);
  assert.equal(bs[0].modules.length, 2);
});
T('buildBatches：已讲完的模块跳过（「继续讲」只排剩下的）', () => {
  const ms = [{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 30 }];
  const bs = buildBatches(ms, 11, { maxLines: 22, maxMods: 2 });
  assert.equal(bs[0].from, 11);
  assert.equal(bs[bs.length - 1].to, 30);
});
T('fallbackModules：AI 大纲不可用时按机械切段兜底', () => {
  const lines = [];
  for (let i = 0; i < 70; i++) lines.push('line ' + i + ';');
  const ms = fallbackModules(lines, 1);
  assert.ok(ms.length >= 2);
  const cov = new Set(); for (const m of ms) for (let i = m.from; i <= m.to; i++) cov.add(i);
  assert.equal(cov.size, 70);
});

console.log('\n提示词用的用户处境（曾把整轮讲解搞崩）：');
T('clarify_answers 是对象 {q1:"a"} → 翻成人话（拿 goals.clarify 的题目）', () => {
  const g = {
    clarify_answers: '{"q1":"a","q2":["x","y"]}',
    clarify: JSON.stringify({ questions: [{ id: 'q1', text: '你的基础？' }, { id: 'q2', text: '目标是什么？' }] })
  };
  const s = clarifyBlock(g);
  assert.match(s, /你的基础？ → a/);
  assert.match(s, /目标是什么？ → x \/ y/);
});
T('clarify_answers 是老数组 [{q,a}] → 照旧', () => {
  assert.match(clarifyBlock({ clarify_answers: '[{"q":"基础","a":"零基础"}]' }), /基础 → 零基础/);
});
T('坏 JSON / 空值 / 字符串都不会抛异常', () => {
  assert.equal(clarifyBlock({ clarify_answers: '不是 JSON' }), '');
  assert.equal(clarifyBlock({ clarify_answers: '' }), '');
  assert.equal(clarifyBlock({ clarify_answers: '"一个字符串"' }), '');
  assert.equal(clarifyBlock({ clarify_answers: '{}' }), '');
  assert.equal(clarifyBlock(null), '');
});

console.log('\n语言判断与带行号正文：');
T('认得 js / python / bash', () => {
  assert.equal(detectLang('const a = 1;\nfunction f(){}'), 'javascript');
  assert.equal(detectLang('import os\n\ndef main():\n    print(1)'), 'python');
  assert.equal(detectLang('#!/usr/bin/env bash\nnpm run build'), 'bash');
});
T('numCode 行号对齐且内容原样保留', () => {
  const s = numCode('const a = 1;\n  return a;');
  assert.equal(s, '1 | const a = 1;\n2 |   return a;');
});
T('numCode 传数组时也要按行（别变成逗号连接的一行）', () => {
  const s = numCode(['const a = 1;', 'console.log(a);', 'main();']);
  assert.equal(s, '1 | const a = 1;\n2 | console.log(a);\n3 | main();');
  assert.ok(!/,/.test(s.split('\n')[0]), '第一行里不该出现逗号拼接');
});
T('numCode 多位数行号对齐', () => {
  const arr = []; for (let i = 1; i <= 12; i++) arr.push('line' + i);
  const s = numCode(arr).split('\n');
  assert.equal(s[0], ' 1 | line1');
  assert.equal(s[11], '12 | line12');
});

console.log('\n通过 ' + n + ' 项');
