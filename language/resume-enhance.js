'use strict';
/**
 * 思而行 · 简历增强：Owner 化拆分 + 技术链（参考 ASu-resume-skills）
 * ==================================================================
 * 两个纯函数，给 finalize / review 提示词补充结构化的「可核验增强」上下文：
 *
 *  1) roleLadder(text)       —— 按 ASu 的「角色强度按来源写」把原文措辞映射成允许用的
 *                              角色词，并给出**边界要求**（Owner 只能作用于最小闭环）。
 *  2) techChainHints(items)  —— 把「功能清单式」描述改写成「输入→表征→规划→工具→状态→评测」
 *                              这类技术链表达的可选句式，只做建议，不改事实。
 *
 * ⚠️ 这个模块不产生任何新事实：只是把用户/证据卡里已有的措辞，换成更容易被读懂的
 *   **结构化表达**；输出进提示词，由 AI 决定用不用。
 */

/* 角色强度阶梯：原文措辞 → 允许的角色词 + 必须限定的范围 */
const LADDER = [
  { test: /独立(负责|完成|开发|交付|定义)/, allow: ['模块级 Owner', '端到端 Owner', '0→1'], boundary: '必须说清「哪一个最小闭环」是独立完成的，不能外扩到整个系统/团队成果' },
  { test: /(主要|主导)(负责|推进|参与)?/, allow: ['策略架构 Owner', '方向负责人'], boundary: '正文必须保留具体责任边界（哪块由你定、哪块不是）' },
  { test: /(参与|共建|协作|配合)/, allow: ['系统级共建者', '核心参与者'], boundary: '不得写成 Owner / 主导，只能写参与的具体环节' },
  { test: /(计划|规划中|未来|待做|将要做)/, allow: ['当前方向', '规划中'], boundary: '不得写成已上线结果，时态必须是计划态' }
];

function roleLadder(text) {
  const s = String(text || '');
  for (const l of LADDER) {
    if (l.test.test(s)) return { allow: l.allow.slice(), boundary: l.boundary };
  }
  return { allow: [], boundary: '' };
}

/* 技术链：把常见「做了什么」映射到链路阶段，给出可选表达 */
const CHAIN_STAGES = [
  { stage: '输入', hint: '输入是什么（原始材料/数据/用户诉求）' },
  { stage: '表征', hint: '怎么理解与结构化（问卷、骨架、Schema、指标定义）' },
  { stage: '规划', hint: '怎么决定下一步（流程、优先级、取舍规则）' },
  { stage: '工具', hint: '用什么手段做（AI 调用、脚本、SQLite、可视化）' },
  { stage: '状态', hint: '怎么记录与追踪（版本、快照、指标落库）' },
  { stage: '评测', hint: '怎么验收（指标阈值、badcase、复测）' }
];

/** 找出证据卡里能映射到链路阶段的措辞（只返回命中的阶段，不编造） */
function techChainHints(text) {
  const s = String(text || '');
  const hits = [];
  const rules = {
    '输入': /(调研|访谈|问卷|收集|导入|读取|原始)/,
    '表征': /(结构化|schema|骨架|三级|拆解|指标定义|标签)/,
    '规划': /(流程|优先级|取舍|规则|策略|决策)/,
    '工具': /(AI|模型|prompt|脚本|SQLite|SQL|可视化|工具)/i,
    '状态': /(版本|快照|存档|回滚|落库|记录|追踪)/,
    '评测': /(指标|阈值|badcase|评测|验收|复测|通过率)/
  };
  for (const st of CHAIN_STAGES) {
    const re = rules[st.stage];
    if (re && re.test(s)) hits.push({ stage: st.stage, hint: st.hint });
  }
  return hits;
}

/** 生成给提示词的一段「增强规则」（Owner 化 + 技术链 + 学校 Title） */
function enhancementBlock(ctx) {
  const c = ctx || {};
  const lines = [];
  if (c.school) {
    lines.push('【可核验的机构 Title（写进教育条目的 left，只写这些，不要自行加 985/C9）】');
    lines.push(c.school);
    lines.push('');
  }
  lines.push('【Owner 化拆分（每个重点项目先做一次）】');
  lines.push('先找「你真正独立完成或主要负责的最小闭环」，例如：指标定义链路 / 节点身份迁移 / Prompt 评测闭环 / 数据可视化。');
  lines.push('只对这个闭环使用 Owner、0→1 这类词；不能把作用域外扩到整个平台或团队成果。');
  lines.push('角色词必须与来源一致：独立负责→模块级 Owner / 端到端 Owner / 0→1；主要负责→策略架构 Owner / 方向负责人；参与→系统级共建者 / 核心参与者；计划→当前方向 / 规划中。');
  lines.push('');
  lines.push('【技术链表达（把功能清单改成链路）】');
  lines.push('每个重点项目尽量写成「输入 → 表征 → 规划 → 工具 → 状态 → 评测」中的 3-4 段，而不是罗列功能：');
  for (const st of CHAIN_STAGES) lines.push('  · ' + st.stage + '：' + st.hint);
  lines.push('');
  return lines.join('\n');
}

module.exports = { roleLadder, techChainHints, enhancementBlock, CHAIN_STAGES, LADDER };
