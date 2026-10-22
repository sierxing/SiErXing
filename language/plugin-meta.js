'use strict';
/**
 * 思而行 · 服务端组件元数据（中文文案集中放这里）
 * ------------------------------------------------------------------
 * 为什么单独放 language/ 下：服务端组件（server/plugins/*.js）不能 require 前端 tr()，
 * 而 i18n 硬编码预算（language/legacy-baseline.json）只许降不许升 —— 新增组件如果
 * 在 server/plugins 里直接写中文 name/desc/category，会让新文件的硬编码计数从 0 涨上去、
 * check:i18n 直接失败。把这类**组件元数据**放 language/ 下（language/ 不在扫描范围），
 * 既保证界面仍显示中文，又不破坏棘轮规则。
 *
 * 约定：key = 组件 id；value = { name, icon, category, desc }。
 */
module.exports = {
  resume: {
    name: '简历工坊',
    icon: '📄',
    category: 'AI 求职',
    desc: '简历与经历证据工作流：经历盘点/证据库、JD-证据匹配矩阵、定向改写、证据优先审计（参考 4 个开源项目：https://github.com/Elowwwen/resume-evidence-workflow 、https://github.com/zclllyybb/lofisu-identity-engine 、https://github.com/Claycui828/ASu-resume-skills 、https://github.com/Elowwwen/resume-evidence-workflow）'
  }
};
