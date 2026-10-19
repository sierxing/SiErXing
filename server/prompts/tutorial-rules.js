'use strict';
/**
 * 思而行 · 教程提示词的动态片段（纯文本）
 * ------------------------------------------------------------------
 * 只给 tutorial.generate 的「覆盖模板」用；默认路径仍走 server.js 的原函数。
 * 这里不查 DB、不读 settings。
 */

const { richMdSpecLines, vizSpecLines } = require('./context');

function budgetBlock(budget, format) {
  if (!(budget && budget.target && format !== 'html')) return '';
  const mins = Math.max(5, Math.round(budget.target / 380));
  const secs = Math.max(4, Math.round(budget.target / 1500));
  return [
    '- **篇幅与结构**：整篇控制在 ' + budget.target + ' 字左右（用户读一遍约 ' + mins + ' 分钟）。'
      + '具体到结构：**二级标题不超过 ' + secs + ' 个，每个二级标题下面正文不超过 3 段、每段 3~5 句**。'
      + '宁可一节只讲透一个点，也不要为凑满结构把每节都写长。',
    '- 不要写"本节小结""总结一下"这类收尾段；不要重复解释同一个概念；不要堆砌与任务无关的背景。'
      + '真正一图胜千言的地方交给你下面的可视化块，而不是继续加字。'
  ].join('\n');
}

function formatBlock(format) {
  const lines = [];
  if (format === 'html') {
    lines.push('【输出格式】只输出一个完整的 HTML 文档（<!DOCTYPE html> 开始，</html> 结束，UTF-8，内联 <style> 美化排版：清晰的标题层级、代码块样式、提示框、可勾选清单样式、目录导航）。不要输出 Markdown、不要用代码块包裹整篇文档、不要任何额外说明文字。不要使用外部 JS/CSS 依赖。');
    lines.push('【HTML 附加铁律】第一行必须是 <!DOCTYPE html>，前面一个字都不能多；第一屏必须是本节标题和本节内容，不许写成其它主题。');
    lines.push('【页内脚本约法三章】只许操作本页 DOM（翻页、折叠、动画、高亮）；禁止 fetch/XHR、localStorage、Cookie、top 跳转、新窗口弹窗。违反即不合格。');
  } else {
    lines.push('【输出格式】只输出 Markdown 正文（# 一级标题开始）。不要用三反引号包裹整篇内容，不要输出任何额外说明文字。代码块、表格、清单、引用都要用标准 Markdown 语法。');
    for (const L of richMdSpecLines()) lines.push(L);
    for (const L of vizSpecLines()) lines.push(L);
  }
  return lines.join('\n');
}

module.exports = { budgetBlock, formatBlock };
