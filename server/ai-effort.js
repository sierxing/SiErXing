'use strict';
/**
 * AI 任务的「先判断复杂度，再决定花多大力气」。
 *
 * 起因：所有 AI 功能都走同一条最重的流程。改一句话的样式也要把整篇 7 万字
 * 重写一遍（实测 200 秒），生成一个 1 小时的小任务也走「规划 → 7 节 → 自检」
 * （3 分钟、产出 6~7 万字）。用户体感是"随便什么都要几分钟"。
 *
 * 这里做**不花 AI 调用**的启发式判断（判断本身要等半分钟就本末倒置了）：
 *   · 依据节点自带的特征（预计投入、层级、说明字数、资料量）
 *   · 依据用户这次输入的长度与措辞
 * 判断结果只决定「走哪条流程」，不影响正确性 —— 判断错了最多是慢一点或
 * 啰嗦一点，不会丢内容。
 *
 * ⚠️ 阈值是拿真实数据校准的，不是拍的。改阈值前先看 docs 里的对照表：
 *   线上 24 篇教程实测，单次生成产出 5K~24K 字，分节生成产出 41K~76K 字。
 *   也就是说"分节"会把篇幅放大 3~8 倍 —— 对 1 小时的小任务纯属灌水。
 */

/** 从 "6-8h" / "0.5h" / "1.5 小时" / "30 分钟" 这类文本里取投入时长（小时）。
 *  取区间上限（6-8h → 8）比取下限保守：宁可多花点力气，也别把大任务写薄了。 */
function parseHours(txt) {
  const s = String(txt == null ? '' : txt);
  const mins = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|min|minutes?)/i);
  if (mins) return Number(mins[1]) / 60;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])).filter(n => n > 0);
  if (!nums.length) return 0;
  const h = Math.max(...nums);
  /* 明确写了"小时/h/hours"才认；只写个裸数字（"2"）当小时处理 */
  return h;
}

/** 生成一份教程该花多大力气。
 *  返回 { mode:'single'|'plan', target, sections, perSection, hours, why } */
function tutorialEffort(node) {
  const n = node || {};
  const h = parseHours(n.hours);
  const lvl = Number.isFinite(Number(n.level)) ? Number(n.level) : 2;
  const detailLen = String(n.detail || '').length;

  /* 目标篇幅：先按投入时长定基数 */
  let target;
  if (h && h <= 1) target = 7000;
  else if (h && h <= 2) target = 12000;
  else if (h) target = Math.min(26000, 6000 + h * 3000);
  else target = 9000;

  /* 层级修正：阶段/小目标要铺得广（本该长），步骤/子任务就该短 */
  if (lvl <= 1) target = Math.max(target, 16000);
  if (lvl >= 4) target = Math.min(target, 6000);
  /* 说明写得细 → 内容确实多，给一点余量（但别无限加） */
  if (detailLen > 400) target = Math.round(target * 1.15);

  /* 单次生成一次能稳妥写完的上限约 9000 字（1.6 万 token 输出上限留足余量）。
     再长就必须分节，否则会撞上限被截断 —— 那正是当初引入分节的原因。 */
  const mode = target <= 9000 ? 'single' : 'plan';
  /* 每节 2200~3000 字：太少显得零碎，太多又会撞单节输出上限 */
  const sections = Math.max(4, Math.min(7, Math.round(target / 2800)));
  const perSection = Math.round(target / sections);

  const why = []
    .concat(h ? '预计投入约 ' + h + ' 小时' : '没写投入时长')
    .concat('节点层级 ' + lvl)
    .concat(mode === 'single' ? '目标约 ' + target + ' 字 → 一次写完更稳更快' : '目标约 ' + target + ' 字 → 分 ' + sections + ' 节写')
    .join('；');
  return { mode, target, sections, perSection, hours: h, level: lvl, why };
}

/** 这次「修改」该走补丁还是整篇重写。与 tut-patch.looksGlobal 同一套判断，
 *  单独放这里是为了让所有 AI 功能的入口长得一样、能被同一处审计。 */
function editEffort(feedback, tutPatch) {
  const global = tutPatch.looksGlobal(feedback);
  return global
    ? { mode: 'full', why: '意见涉及整篇（重排结构 / 每节都要动）' }
    : { mode: 'patch', why: '意见像是指着某一处说 → 只回补丁，不重写全文' };
}

/** 节点展开（把阶段拆成任务）该一次要多少个。
 *  原来固定一次要一整个阶段的任务量，产出 JSON 很大、单次调用 40~90 秒。
 *  任务多的阶段才需要分批，少的没必要。 */
function expandEffort(node) {
  const lvl = Number.isFinite(Number((node || {}).level)) ? Number(node.level) : 0;
  const h = parseHours((node || {}).hours);
  /* 阶段（0）/小目标（1）本来就要铺开，保持一次要完；更细的层级少要一点 */
  const many = lvl <= 1 || h >= 6;
  return many
    ? { batch: 0, why: '阶段级展开，一次要完（本来就需要铺开）' }
    : { batch: 6, why: '层级较细，一次最多 6 个，产出更小更快' };
}

/** 这一句对话值不值得做重检索。
 *  ⚠️ 注意分寸：即使是最轻的档，**资料清单（chatSourcesBlock）也必须保留** ——
 *  以前漏掉它，用户问"资料库里有没有 X"，模型只会瞎答"看不到"（AGENTS.md 坑 #16），
 *  哪怕那条资料就躺在库里。这里省掉的只是「向量检索 + 代码检索 + 长历史」。
 *  返回 { heavy:boolean, why } */
function chatEffort(message) {
  const s = String(message || '').trim();
  /* 寒暄、致谢、确认这类短句：没有任何检索需求 */
  if (s.length <= 12 && /^(你好|您好|hi|hello|嗨|在吗|谢谢|多谢|感谢|好的|好|ok|okay|嗯|收到|明白了|没事了|再见)[!！。.~～\s]*$/i.test(s)) {
    return { heavy: false, why: '短寒暄，不需要检索' };
  }
  /* 明确在问资料/来源/依据/教程内容 → 一定要检索 */
  if (/资料|来源|依据|文献|文档|库里|知识库|检索|引用|出处|教程|笔记|提炼/.test(s)) {
    return { heavy: true, why: '在问资料/教程内容，必须检索' };
  }
  /* 很短的句子（"改成 6 个月"、"第3节删掉"）多是命令，不需要向量检索；
     但代码块、长句、问句仍按重档走 —— 宁可多检索一次，也别答得没依据。 */
  if (s.length <= 20 && !/[?？]/.test(s) && !/```/.test(s)) {
    return { heavy: false, why: '短指令，靠对话历史和资料清单就够' };
  }
  return { heavy: true, why: '正常提问，走完整检索' };
}

module.exports = { parseHours, tutorialEffort, editEffort, expandEffort, chatEffort };
