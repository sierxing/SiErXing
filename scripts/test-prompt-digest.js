'use strict';
/**
 * 资料提炼提示词回归：node scripts/test-prompt-digest.js
 *
 * 这批提示词从 server.js 抽到 server/prompts/digest.js。
 * 钉住：批次头、资料边界、维度清单、汇总计数、批次编号不能丢。
 * 纯计算、零依赖、秒级。
 */
const assert = require('node:assert');
const p = require('../server/prompts/digest.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

const batch = [
  { label: '[★优质信息源｜文章] AI PM 岗位要求', body: '需要懂模型评估与指标体系。' },
  { label: '[知乎｜问答] 转行经验', body: '先做两个真实项目，再投递。' }
];

T('digestBatchPrompt 带批次头与资料边界', () => {
  const s = p.digestBatchPrompt(batch, 1, 2);
  assert.ok(s.includes('第 1/2 批'), s.slice(0, 80));
  assert.ok(s.includes('【资料开始】'));
  assert.ok(s.includes('【资料结束】'));
  assert.ok(s.includes('## [★优质信息源｜文章] AI PM 岗位要求'));
  assert.ok(s.includes('需要懂模型评估与指标体系。'));
  assert.ok(s.includes('## [知乎｜问答] 转行经验'));
  assert.ok(!/undefined|\[object Object\]/.test(s));
});

T('digestBatchPrompt 保留提取维度清单', () => {
  const s = p.digestBatchPrompt(batch, 2, 3);
  for (const k of ['- tech', '- hard', '- duties', '- roadmap', '- interview', '- resources', '- timeline', '- other']) {
    assert.ok(s.includes(k), '缺少维度：' + k);
  }
  assert.ok(s.includes('只输出一个 JSON 对象'));
});

T('digestSynthesisPrompt 带总数/自己提供/网络检索', () => {
  const parts = [{ idx: 1, data: { tech: ['Python'] } }, { idx: 2, data: { hard: ['本科'] } }];
  const s = p.digestSynthesisPrompt(parts, { total: 10, ownCount: 3, netCount: 7 });
  assert.ok(s.includes('共处理 10 条资料'));
  assert.ok(s.includes('用户自己提供 3 条'));
  assert.ok(s.includes('网络检索 7 条'));
  assert.ok(s.includes('【各批提炼结果】'));
  assert.ok(s.includes('### 第 1 批'));
  assert.ok(s.includes('### 第 2 批'));
  assert.ok(s.includes('"digests"'));
  assert.ok(s.includes('3-8 篇'));
  assert.ok(!/undefined|\[object Object\]/.test(s));
});

T('空批次也能生成（不抛异常）', () => {
  const s = p.digestBatchPrompt([], 1, 1);
  assert.ok(s.includes('【资料开始】'));
  assert.ok(s.includes('【资料结束】'));
});

console.log('\n' + n + ' 项全部通过');
