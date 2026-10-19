'use strict';
/**
 * 思而行 · 规划主流程提示词包（动态注册）
 * ------------------------------------------------------------------
 * 这些提示词原本在 server.js 里拼接，包含异步取资料的块（libraryBlock 等）。
 * 默认渲染仍然调用 server.js 的原函数（builtinRender），行为完全不变；
 * 这里只提供可编辑模板 + 占位符，prompt.update 覆盖后才走模板。
 *
 * ⚠️ 模板正文统一在 language/prompts/zh-CN/packs.json（按下面的 id 读取），
 *    本文件只保留包元数据与样例上下文。
 *
 * 模板里的占位符由调用方填：
 *   plan.clarify  : goalHeader / digests / library
 *   plan.skeleton : goalHeader / qa / constraints / digests / library / ask
 */

const { template } = require('../../language/prompts');

const DEFS = {
  'plan.clarify': {
    id: 'plan.clarify',
    title: '规划前问卷（clarify）',
    description: '让 AI 按目标类型生成 8-14 道澄清题（含水平自测与分析）。',
    editable: true,
    placeholders: ['goalHeader', 'digests', 'library'],
    mustInclude: ['JSON', '"questions"', 'quiz', 'q_collect'],
    template: template('plan.clarify'),
    sampleCtx: {
      goalHeader: '【目标】示例目标：3 个月转行 AI 产品经理\n【为什么】想做出能落地的 AI 产品',
      digests: '【资料提炼汇总】\n（示例）岗位要求：SQL、需求分析、原型工具',
      library: '【资料库清单】\n（示例）1. 用户提供的资料：AI 产品经理 JD'
    }
  },
  'plan.skeleton': {
    id: 'plan.skeleton',
    title: '路径骨架（skeleton）',
    description: '让 AI 根据目标 + 问卷 + 资料生成阶段/小目标骨架。',
    editable: true,
    placeholders: ['goalHeader', 'qa', 'constraints', 'digests', 'library', 'ask'],
    mustInclude: ['JSON', 'stages', 'questions', 'conditions'],
    template: template('plan.skeleton'),
    sampleCtx: {
      goalHeader: '【目标】示例目标：3 个月转行 AI 产品经理',
      qa: '【问卷回答】每周 10 小时；有数据分析基础；自测 2/3 正确。',
      constraints: '【硬性约束】只能周末学；预算 1000 元以内。',
      digests: '【资料提炼汇总】（示例）要求 SQL、需求分析、原型工具。',
      library: '【资料库清单】（示例）1. 用户提供的资料：AI 产品经理 JD',
      ask: ''
    }
  }
};

module.exports = DEFS;
