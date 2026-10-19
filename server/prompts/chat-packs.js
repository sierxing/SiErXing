'use strict';
/* chat 对话规则块：供提示词包 chat.ask_rules / chat.agent_rules 使用。
   正文统一在 language/prompts/zh-CN/packs.json（模板 id：chat.ask_rules /
   chat.agent_rules / chat.tutorial_edit_op）；这里只保留读取与 tutorialEditOp 的动态插槽。
   tutorialEditOp 是唯一的动态块：agentRules(ctx) 用它替换 {{tutorialEditOp}}。 */
const { template } = require('../../language/prompts');

const ASK_TEMPLATE = template('chat.ask_rules');
const AGENT_TEMPLATE = template('chat.agent_rules');
const TUTORIAL_EDIT_OP = template('chat.tutorial_edit_op');

function askRules() { return template('chat.ask_rules'); }

function agentRules(ctx) {
  const tpl = template('chat.agent_rules');
  const op = ctx && ctx.tutorialEditOp ? String(ctx.tutorialEditOp) : '';
  if (op) return tpl.split('{{tutorialEditOp}}').join(op);
  /* 没有动态块时，把占位符所在的整行一起去掉 —— 旧实现是「不 push 这一行」，
     要保证结果逐字一致，不能留下一个空行。 */
  return tpl.split('\n').filter(function (line) {
    return line.indexOf('{{tutorialEditOp}}') < 0;
  }).join('\n');
}

function tutorialSample() { return TUTORIAL_EDIT_OP; }

module.exports = {
  askRules: askRules,
  agentRules: agentRules,
  ASK_TEMPLATE: ASK_TEMPLATE,
  AGENT_TEMPLATE: AGENT_TEMPLATE,
  TUTORIAL_EDIT_OP: TUTORIAL_EDIT_OP,
  tutorialSample: tutorialSample
};
