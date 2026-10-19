'use strict';
/**
 * 思而行 · 教程生成提示词包（动态注册）
 * ------------------------------------------------------------------
 * 默认渲染仍调用 server.js 的 buildTutorialPrompt（行为完全不变）；
 * 这里只提供可编辑模板 + 占位符，prompt.update 覆盖后才走模板。
 * budget / formatRules 两个动态片段由 server/prompts/tutorial-rules.js 生成。
 *
 * ⚠️ 模板正文统一在 language/prompts/zh-CN/packs.json（按下面的 id 读取），
 *    本文件只保留包元数据与样例上下文。
 */

const { template } = require('../../language/prompts');

module.exports = {
  'tutorial.generate': {
    id: 'tutorial.generate',
    title: '教程生成（tutorial generate）',
    description: '为某个节点生成完整学习教程（Markdown 或 HTML），含结构、篇幅与输出格式约束。',
    editable: true,
    placeholders: ['goalHeader', 'qa', 'constraints', 'topic', 'siblingScope', 'digests', 'nodeSources', 'sourcesIndex', 'codeBlock', 'note', 'budget', 'formatRules'],
    mustInclude: ['【范围重申】', '【教程必须包含的结构】', '【写作要求】'],
    template: template('tutorial.generate'),
    sampleCtx: {
      goalHeader: '【目标】示例目标：3 个月转行 AI 产品经理',
      qa: '【问卷回答】每周 10 小时；有数据分析基础。',
      constraints: '【硬性约束】只能周末学。',
      topic: '【教程主题（任务）】用 SQL 做一次留存分析',
      siblingScope: '',
      digests: '【资料提炼汇总】（示例）留存分析常用次日/7 日留存。',
      nodeSources: '【本节可用的资料】（示例）1. 用户提供的资料：留存分析笔记。',
      sourcesIndex: '',
      codeBlock: '',
      note: '',
      budget: '- **篇幅与结构**：整篇控制在 4000 字左右（用户读一遍约 11 分钟）。具体到结构：**二级标题不超过 3 个，每个二级标题下面正文不超过 3 段、每段 3~5 句**。',
      formatRules: '【输出格式】只输出 Markdown 正文（# 一级标题开始）。'
    }
  }
};
