'use strict';
/**
 * 思而行 · 资料类提示词包（动态注册）
 * ------------------------------------------------------------------
 * collect_plan / ebook_recommend / clean 原本在 server.js / text-clean.js 里拼接，
 * 都是同步函数。默认渲染仍调用原函数（builtinRender），行为完全不变；
 * 这里只提供可编辑模板 + 占位符，prompt.update 覆盖后才走模板。
 *
 * ⚠️ 模板正文统一在 language/prompts/zh-CN/packs.json（按下面的 id 读取），
 *    本文件只保留包元数据与样例上下文。
 */

const { template } = require('../../language/prompts');

module.exports = {
  'sources.collect_plan': {
    id: 'sources.collect_plan',
    title: '搜集方案（collect plan）',
    description: '让 AI 为当前目标生成 10-16 条可直接搜索的 query。',
    editable: true,
    placeholders: ['goalHeader'],
    mustInclude: ['JSON', '"kind"', '"q"', '"days"'],
    template: template('sources.collect_plan'),
    sampleCtx: { goalHeader: '【目标】示例目标：3 个月转行 AI 产品经理' }
  },
  'sources.ebook_recommend': {
    id: 'sources.ebook_recommend',
    title: '入门书单（ebook recommend）',
    description: '让 AI 为目标列 6-8 本入门书，含公版/获取渠道建议。',
    editable: true,
    placeholders: ['goalHeader'],
    mustInclude: ['JSON', '"title"', '"public_domain"', '"where"'],
    template: template('sources.ebook_recommend'),
    sampleCtx: { goalHeader: '【目标】示例目标：理解经济怎么运转' }
  },
  'sources.clean': {
    id: 'sources.clean',
    title: '资料清洗（clean）',
    description: '只删不改地清掉网页正文里的导航/广告/推荐位/页脚。',
    editable: true,
    placeholders: ['goalLine', 'titleLine', 'text'],
    mustInclude: ['EMPTY', 'TEXT_START', '一个字都不许改写'],
    template: template('sources.clean'),
    sampleCtx: {
      goalLine: '（读者要拿它学"示例目标"相关的东西，所以只留对学习有用的内容）',
      titleLine: '（资料标题：示例资料）',
      text: '正文第一段。\n相关阅读：xxx\n正文第二段。'
    }
  }
};
