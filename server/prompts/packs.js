'use strict';
/**
 * 思而行 · 内置提示词包（v0）
 * ------------------------------------------------------------------
 * 每个包同时提供：
 *   - template：给用户/Agent 看和改的文本（{{placeholder}} 占位符）；
 *   - builtinRender：默认渲染（复用原纯函数，保证行为不变）；
 *   - sampleCtx：prompt.preview 用的样例。
 * 没被覆盖时 render 走 builtinRender；被覆盖后走 template。
 *
 * ⚠️ 模板正文不在本文件里：统一放在 language/prompts/zh-CN/packs.json，
 *    这里只按 id 读取（template('...')）。改提示词请改 language/ 下的 JSON。
 */

const { digestBatchPrompt, digestSynthesisPrompt } = require('./digest');
const { template } = require('../../language/prompts');
const chatPacks = require('./chat-packs');

/* 简历工坊（resume.*）等「模板即正文」的包用：把 {{key}} 换成上下文里的值。
   缺省保持占位符原样（预览时能一眼看出少传了什么）。 */
function fill(tpl, data) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, function (m, k) {
    return data && data[k] != null ? String(data[k]) : m;
  });
}

const PACKS = {
  'sources.digest_batch': {
    id: 'sources.digest_batch',
    title: '资料提炼（单批）',
    description: '把一批资料交给 AI，按固定维度提取 JSON。',
    editable: true,
    placeholders: ['batchNo', 'total', 'items'],
    mustInclude: ['JSON', '- tech', '- hard', '- roadmap', '- other'],
    template: template('sources.digest_batch'),
    sampleCtx: { batchNo: 1, total: 2, items: '## 示例资料\n这是一段示例正文。' },
    builtinRender: function (ctx) { return digestBatchPrompt(ctx.batch, ctx.batchNo, ctx.total); }
  },
  'sources.digest_synthesis': {
    id: 'sources.digest_synthesis',
    title: '资料提炼（多批汇总）',
    description: '把多批提炼结果汇总成主题 Markdown 文档。',
    editable: true,
    placeholders: ['total', 'ownCount', 'netCount', 'parts'],
    mustInclude: ['JSON', '"digests"', 'content_md', '3-8 篇'],
    template: template('sources.digest_synthesis'),
    sampleCtx: { total: 10, ownCount: 3, netCount: 7, parts: '### 第 1 批\n{"tech":["示例"]}' },
    builtinRender: function (ctx) { return digestSynthesisPrompt(ctx.partsArr, { total: ctx.total, ownCount: ctx.ownCount, netCount: ctx.netCount }); }
  },
  'chat.ask_rules': {
    id: 'chat.ask_rules',
    title: '对话 · ASK 模式规则',
    description: '只回答、不许改的硬规则（ASK 模式；不输出 ops）。',
    editable: true,
    placeholders: [],
    mustInclude: ['ASK 提问模式', '绝对不要修改任何东西', '不要编造事实'],
    template: template('chat.ask_rules'),
    sampleCtx: {},
    builtinRender: function () { return chatPacks.askRules(); }
  },
  'chat.agent_rules': {
    id: 'chat.agent_rules',
    title: '对话 · Agent 模式规则',
    description: '对话助手的工具边界、ops 契约与教程修改规则；{{tutorialEditOp}} 是唯一动态块。',
    editable: true,
    placeholders: ['tutorialEditOp'],
    mustInclude: ['不要使用任何工具', '"op":"add"', '删除类操作', '不设上限'],
    template: template('chat.agent_rules'),
    sampleCtx: { tutorialEditOp: chatPacks.TUTORIAL_EDIT_OP },
    builtinRender: function (ctx) { return chatPacks.agentRules({ tutorialEditOp: ctx && ctx.tutorialEditOp }); }
  },

  /* ===== 简历工坊（resume 组件）：五个包都是「模板即正文」，没有覆盖时用 fill 渲染 ===== */
  'resume.questions': {
    id: 'resume.questions',
    title: '简历 · 经历追问',
    description: '通读简历与经历证据卡，找信息缺口并输出 6-8 个追问（只发问，不等待回答）。',
    editable: true,
    placeholders: ['targetRole', 'resume', 'evidence'],
    mustInclude: ['JSON', '"questions"'],
    template: template('resume.questions'),
    sampleCtx: { targetRole: 'AI 产品经理实习', resume: '## 项目经历\n- 负责 XX 功能', evidence: '【证据 1】XX 项目：独立负责…' },
    builtinRender: function (ctx) { return fill(template('resume.questions'), ctx); }
  },
  'resume.evidence': {
    id: 'resume.evidence',
    title: '简历 · 整理证据卡',
    description: '把用户对追问的口语回答整理成结构化经历证据卡，区分事实/估计/解释。',
    editable: true,
    placeholders: ['targetRole', 'answers'],
    mustInclude: ['JSON', '"cards"'],
    template: template('resume.evidence'),
    sampleCtx: { targetRole: 'AI 产品经理实习', answers: '我在一个项目里主要负责访谈…' },
    builtinRender: function (ctx) { return fill(template('resume.evidence'), ctx); }
  },
  'resume.match': {
    id: 'resume.match',
    title: '简历 · JD 匹配矩阵',
    description: '把 JD 拆成要求并与证据卡做匹配矩阵（direct/adjacent/weak/gap），先矩阵后改写。',
    editable: true,
    placeholders: ['targetRole', 'jd', 'resume', 'evidence'],
    mustInclude: ['JSON', '"rows"'],
    template: template('resume.match'),
    sampleCtx: { targetRole: 'AI 产品经理实习', jd: '岗位职责：…', resume: '## 简历\n…', evidence: '【证据 1】…' },
    builtinRender: function (ctx) { return fill(template('resume.match'), ctx); }
  },
  'resume.rewrite': {
    id: 'resume.rewrite',
    title: '简历 · 定向改写',
    description: '按 JD 与证据卡改写简历要点：不新增事实、不升级角色、指标必须有口径。',
    editable: true,
    placeholders: ['targetRole', 'jd', 'resume', 'evidence'],
    mustInclude: ['JSON', '"bullets"'],
    template: template('resume.rewrite'),
    sampleCtx: { targetRole: 'AI 产品经理实习', jd: '岗位职责：…', resume: '## 简历\n…', evidence: '【证据 1】…' },
    builtinRender: function (ctx) { return fill(template('resume.rewrite'), ctx); }
  },
  'resume.audit': {
    id: 'resume.audit',
    title: '简历 · 证据审计',
    description: '把简历拆成原子主张并逐条给证据状态（已证实/部分证实/…），检查夸大模式。',
    editable: true,
    placeholders: ['targetRole', 'resume', 'evidence'],
    mustInclude: ['JSON', '"claims"', '已证实'],
    template: template('resume.audit'),
    sampleCtx: { targetRole: 'AI 产品经理实习', resume: '## 简历\n…', evidence: '【证据 1】…' },
    builtinRender: function (ctx) { return fill(template('resume.audit'), ctx); }
  }
};

module.exports = PACKS;
