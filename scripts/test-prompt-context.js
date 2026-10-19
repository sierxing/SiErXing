'use strict';
/**
 * 提示词上下文块（纯函数）的回归：node scripts/test-prompt-context.js
 *
 * 为什么留：这些块以前散在 server.js 里，移动时最容易“看起来一样、实际少一行”。
 * 这里钉住三件事：
 *   ① goalHeader 的字段/占位符不能漂；
 *   ② richMdSpecLines / vizSpecLines 的关键契约不能在搬运中丢；
 *   ③ 必须保持纯函数：不依赖 DB / settings / server.js。
 *
 * 纯计算、零依赖、秒级。
 */
const assert = require('node:assert');
const ctx = require('../server/prompts/context.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

T('goalHeader 输出目标/现状/时间/期限', () => {
  const s = ctx.goalHeader({ title: '转行 AI 产品经理', profile: '在职，有 C 基础', weekly_hours: '10', deadline: '3 个月' });
  assert.ok(s.includes('【职业目标】转行 AI 产品经理'), s);
  assert.ok(s.includes('在职，有 C 基础'), s);
  assert.ok(s.includes('【每周可投入】10'), s);
  assert.ok(s.includes('【期望期限】3 个月'), s);
});

T('goalHeader 缺字段时给占位符，不出现 undefined', () => {
  const s = ctx.goalHeader({ title: 'X' });
  assert.ok(s.includes('（未填写）'), s);
  assert.ok(!/undefined|\[object Object\]/.test(s), s);
});

T('goalHeader 有参考资料时附带', () => {
  const s = ctx.goalHeader({ title: 'X', materials: '我自己的项目源码' });
  assert.ok(s.includes('用户提供的参考资料'), s);
  assert.ok(s.includes('我自己的项目源码'), s);
});

T('richMdSpecLines 包含内联 HTML 契约', () => {
  const a = ctx.richMdSpecLines();
  assert.ok(Array.isArray(a) && a.length > 0);
  const s = a.join('\n');
  for (const k of ['#dc2626', '#c9701f', '#16a34a', '<details>', '<summary>', '每节最多 3 处', '除这几样以外', '<br>']) {
    assert.ok(s.includes(k), '缺少：' + k);
  }
  assert.ok(!/undefined|\[object Object\]/.test(s), '有脏值');
});

T('vizSpecLines 包含可视化块契约', () => {
  const a = ctx.vizSpecLines();
  assert.ok(Array.isArray(a) && a.length > 0);
  const s = a.join('\n');
  for (const k of ['<!DOCTYPE html>', '禁止用字符画', 'fetch/XHR', '自包含', '沙箱限制', '宽度按容器宽', '按钮']) {
    assert.ok(s.includes(k), '缺少：' + k);
  }
  assert.ok(!/undefined|\[object Object\]/.test(s), '有脏值');
});

T('每次返回新数组（调用方可以安全 push）', () => {
  const a = ctx.richMdSpecLines(); const b = ctx.richMdSpecLines();
  assert.notStrictEqual(a, b);
  a.push('x');
  assert.ok(!b.includes('x'));
});

console.log('\n' + n + ' 项全部通过');
