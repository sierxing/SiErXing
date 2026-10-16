'use strict';
/**
 * 任务进度统一模型的回归：`node scripts/test-task-progress.js`
 *
 * 为什么留：进度条最容易出两类事故 —— ①"假进度"（自己往前跑到 100%，用户以为好了，
 * 其实还在跑）；②"倒退"（数字或条往回走，用户只会以为出错）。这里把两条钉死。
 * 纯计算、零依赖、秒级。
 */
const assert = require('node:assert');
const tp = require('../server/task-progress.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

/* 可控时钟：不给它就没法测时间曲线 */
function clock(start) { let t = start || 1_000_000; const f = () => t; f.advance = ms => { t += ms; return t; }; return f; }

console.log('没有声明阶段时（整条一条时间曲线）：');
T('时间越久百分比越大，且在完成前封顶 93% —— 不宣告 100%', () => {
  const c = clock(); const e = tp.create({ now: c, expectedMs: 45000 });
  const a = e.snapshot().pct;
  c.advance(45000); const b = e.snapshot().pct;
  c.advance(10 * 60 * 1000); const z = e.snapshot().pct;
  assert.ok(b > a, a + ' → ' + b);
  assert.ok(z > b);
  assert.ok(z <= tp.TAIL_CAP * 100, '不该出现 100：' + z);
  assert.ok(z >= 90, '该爬得很高：' + z);
});
T('source 如实标成 time（前端据此标"估算"）', () => {
  const e = tp.create({});
  assert.equal(e.snapshot().source, 'time');
});
T('没给 expectedMs 时用默认尺度，不许几秒钟就冲到头', () => {
  /* 真实翻车：没给 expectedMs 的表达式写错，让尺度变成 1 秒，
     条在 3 秒内就爬到 90% —— 用户以为马上了，其实还早。 */
  const c = clock();
  const e = tp.create({ now: c });          // 故意不给 expectedMs
  c.advance(3000);
  const p3 = e.snapshot().pct;
  assert.ok(p3 < 25, '3 秒时不该超过 25%，实际 ' + p3);
  c.advance(60000);
  const p63 = e.snapshot().pct;
  assert.ok(p63 > p3 && p63 < tp.TAIL_CAP * 100, '1 分钟左右该在爬、但没到头：' + p63);
});

console.log('阶段：');
T('进入第 2 阶段，百分比落在第 2 段的区间里（4 段 = 25% 一段）', () => {
  const c = clock(); const e = tp.create({ now: c, expectedMs: 40000, phases: ['甲', '乙', '丙', '丁'] });
  e.phase(1, '正在做乙');
  const s = e.snapshot();
  assert.equal(s.phaseIndex, 1);
  assert.ok(s.pct >= 25 && s.pct < 50, '实际 ' + s.pct);
  assert.equal(s.source, 'phase');
  assert.equal(s.phaseCount, 4);
  assert.equal(s.phaseLabel, '乙');
});
T('阶段点状态：之前的 done、当前的 active、之后的 pending', () => {
  const c = clock(); const e = tp.create({ now: c, phases: ['甲', '乙', '丙'] });
  e.phase(1, '做乙');
  const st = e.snapshot().steps;
  assert.deepEqual(st.map(x => x.state), ['done', 'active', 'pending']);
  assert.equal(st[1].detail, '做乙');
});
T('阶段只许往前走：乱序调用不让条倒退', () => {
  const c = clock(); const e = tp.create({ now: c, phases: ['甲', '乙', '丙'] });
  e.phase(2); const a = e.snapshot().pct;
  e.phase(0); const b = e.snapshot().pct;
  assert.ok(b >= a, a + ' → ' + b);
  assert.equal(e.snapshot().phaseIndex, 2);
});
T('按 key 进入阶段', () => {
  const c = clock(); const e = tp.create({ now: c, phases: [{ key: 'read', label: '读' }, { key: 'call', label: '调' }] });
  e.phase('call');
  assert.equal(e.snapshot().phaseIndex, 1);
});
T('不等权阶段：按权重切区间', () => {
  const c = clock();
  const e = tp.create({ now: c, phases: [{ label: '快', weight: 1 }, { label: '慢', weight: 3 }] });
  e.phase(1);
  const s = e.snapshot();
  assert.ok(s.pct >= 25 && s.pct < 26, '第 2 段应从 25% 起，实际 ' + s.pct);
});

T('阶段内：真实计数当地板，时间曲线在上面继续平滑（两次上报之间不会一动不动）', () => {
  const c = clock();
  const e = tp.create({ now: c, phases: ['甲', '乙'], expectedMs: 60000 });
  e.phase(1, '抓取正文', { frac: 0.1 });
  const a = e.snapshot().pct;
  assert.ok(a >= 50 && a <= 56, '地板 10% → 整条 50+5 附近，实际 ' + a);
  c.advance(300000);                       // 长时间没上报
  const b = e.snapshot().pct;
  assert.ok(b > a, '时间曲线该继续往上走：' + a + ' → ' + b);
  assert.ok(b < 100, '但也绝不能越过本阶段：' + b);
});
T('阶段内给了高地板 → 至少停在地板处，且不倒退', () => {
  const c = clock();
  const e = tp.create({ now: c, phases: ['甲', '乙', '丙'], expectedMs: 60000 });
  e.phase(1, '抓取', { frac: 0.9 });
  const a = e.snapshot().pct;
  assert.ok(a >= 33 + 33 * 0.9 - 1, '实际 ' + a);
  e.phase(1, '抓取', { frac: 0.2 });        // 上报乱序/回退也不许让条倒退
  assert.ok(e.snapshot().pct >= a);
});

console.log('计数（最准确的来源）：');
T('count(3,9) → 33%', () => {
  const e = tp.create({});
  e.count(3, 9);
  const s = e.snapshot();
  assert.equal(s.pct, 33);
  assert.equal(s.source, 'count');
  assert.equal(s.done, 3);
  assert.equal(s.total, 9);
});
T('计数走满 = 100%（真实来源允许到顶）', () => {
  const e = tp.create({});
  e.count(9, 9);
  assert.equal(e.snapshot().pct, 100);
});
T('有阶段时，计数只在当前阶段的区间里爬', () => {
  const c = clock(); const e = tp.create({ now: c, phases: ['甲', '乙', '丙', '丁'] });
  e.phase(1); e.count(5, 10);
  const s = e.snapshot();
  assert.ok(s.pct >= 25 && s.pct < 50, '实际 ' + s.pct);
});

console.log('单调性与来源优先级：');
T('时间推动的条，在真实计数到来时只前进不后退', () => {
  const c = clock(); const e = tp.create({ now: c });
  c.advance(5 * 60 * 1000);
  const hi = e.snapshot().pct;              // 时间曲线已经爬到 90+
  e.count(1, 10);                          // 真实计数只有 10%
  const after = e.snapshot().pct;
  assert.ok(after >= hi, hi + ' → ' + after + '（不许倒退）');
});
T('显式 set(80) 之后，时间曲线不会把它拉回去', () => {
  const c = clock(); const e = tp.create({ now: c });
  e.set(80);
  assert.ok(e.snapshot().pct >= 80);
  c.advance(60 * 60 * 1000);
  assert.ok(e.snapshot().pct >= 80);
});
T('set(null, "文案") 只换文案，不动进度来源', () => {
  const e = tp.create({});
  e.set(null, '正在写第 3 节…');
  assert.equal(e.snapshot().source, 'time');
});

console.log('健壮性（畸形输入不许抛）：');
T('乱七八糟的参数都不抛，且百分比始终落在 0~100', () => {
  const c = clock();
  const bad = [
    () => tp.create({ phases: null }),
    () => tp.create({ phases: [] }),
    () => tp.create({ phases: ['', null, 0] }),
    () => tp.create({ phases: [{ weight: -5, label: 'x' }] }),
    () => tp.create({ total: -3, expectedMs: -1 }),
    () => tp.create({ now: c }).count(NaN, NaN).phase('没有这个 key').set('abc').note(null),
    () => tp.create({ now: c }).count(999, 3).phase(999),
    () => tp.create({ now: c }).phase(-5)
  ];
  for (const f of bad) {
    const e = f();
    const s = e && e.snapshot ? e.snapshot() : null;
    if (!s) continue;
    assert.ok(s.pct >= 0 && s.pct <= 100, '越界：' + s.pct);
  }
  assert.ok(tp.create({ phases: ['只有一段'] }).snapshot().phaseCount === 1);
});
T('单阶段声明的阶段点也画得出来（1/1）', () => {
  const c = clock(); const e = tp.create({ now: c, phases: [{ key: 'only', label: '全过程' }] });
  const s = e.snapshot();
  assert.equal(s.phaseCount, 1);
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].state, 'active');
});

console.log('快照字段（前端只认这一个结构）：');
T('字段齐全', () => {
  const c = clock(); const e = tp.create({ now: c, phases: ['甲', '乙'], total: 4, expectedMs: 30000 });
  e.phase(0, '开始').count(1, 4).note('模型正在写…').eta('还要 2 分钟');
  const s = e.snapshot();
  for (const k of ['pct', 'source', 'done', 'total', 'phaseIndex', 'phaseCount', 'phaseLabel', 'steps', 'thinking', 'eta', 'elapsedMs']) {
    assert.ok(k in s, '缺字段 ' + k);
  }
  assert.equal(s.thinking, '模型正在写…');
  assert.equal(s.eta, '还要 2 分钟');
  assert.ok(s.elapsedMs >= 0);
});
T('finish() 之后条走满（完成才配 100%）', () => {
  const e = tp.create({ phases: ['甲', '乙'] });
  e.finish(100);
  assert.equal(e.snapshot().pct, 100);
});

console.log('权重换算：');
T('spansOf：2:3 权重 → 40 / 60', () => {
  const sp = tp.spansOf(tp.normPhases([{ weight: 2 }, { weight: 3 }]));
  assert.equal(Math.round(sp[0].start), 0);
  assert.equal(Math.round(sp[0].end), 40);
  assert.equal(Math.round(sp[1].end), 100);
});

console.log('\n全部通过（' + n + ' 项）');
