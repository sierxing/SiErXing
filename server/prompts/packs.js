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
    mustInclude: ['不要使用任何工具', '"op":"add"', '单次最多 20 个操作'],
    template: template('chat.agent_rules'),
    sampleCtx: { tutorialEditOp: chatPacks.TUTORIAL_EDIT_OP },
    builtinRender: function (ctx) { return chatPacks.agentRules({ tutorialEditOp: ctx && ctx.tutorialEditOp }); }
  }
};

module.exports = PACKS;
