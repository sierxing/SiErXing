'use strict';
/**
 * 思而行 · 资料提炼提示词
 * ------------------------------------------------------------------
 * 从 server/server.js 抽出的纯提示词：
 *   - digestBatchPrompt：把一批资料交给 AI，按固定维度提取；
 *   - digestSynthesisPrompt：把多批结果汇总成主题 MD。
 * 两者只依赖入参，不查 DB、不读 settings、不 require server.js。
 * 输出契约由调用方的 parseDigests / 入库逻辑校验，提示词只管生成文本。
 */

function digestBatchPrompt(batch, idx, total) {
  const lines = [];
  lines.push(`你是资料提炼助手。下面是用户目标的资料（第 ${idx}/${total} 批）。`);
  lines.push('请把其中**对目标规划有价值的信息完整提取出来，宁多勿漏**：');
  lines.push('- tech：技术栈、技能、框架、语言、工具（逐条列出，保留原文的具体名词与限定词）');
  lines.push('- hard：硬性条件（学历 / 年限 / 到岗天数 / 证书 / 前置知识 / 地点等）');
  lines.push('- duties：职责与工作内容、项目类型、业务方向');
  lines.push('- roadmap：学习路线、知识体系、章节模块与顺序');
  lines.push('- interview：面试重点、高频考点、面经结论');
  lines.push('- resources：书 / 课程 / 网站 / 工具 / 证书等具体资源名');
  lines.push('- timeline：时间节点、流程（投递 / 面试轮次 / 截止时间）');
  lines.push('- other：其它对规划有用的结论');
  lines.push('只输出一个 JSON 对象，键为上面这些英文名，值为字符串数组；不要遗漏具体名词。');
  lines.push('');
  lines.push('【资料开始】');
  for (const it of batch) { lines.push('## ' + it.label); lines.push(it.body); }
  lines.push('【资料结束】');
  return lines.join('\n');
}
function digestSynthesisPrompt(parts, meta) {
  const lines = [];
  lines.push('下面是同一目标的资料提炼结果（多批汇总，来自用户提供的图片资料与网络检索资料）。');
  lines.push(`共处理 ${meta.total} 条资料（用户自己提供 ${meta.ownCount} 条、网络检索 ${meta.netCount} 条）。`);
  lines.push('请整理成若干篇「主题汇总」Markdown 文档，用于指导后续的目标规划。');
  lines.push('');
  lines.push('【要求】');
  lines.push('1. 按主题拆分（例如：岗位要求与技术栈 / 学习路线与知识体系 / 面试重点与高频考点 / 项目与作品 / 硬性条件与时间安排 / 资源与工具 …），篇数按内容多少决定（3-8 篇），不要硬凑。');
  lines.push('2. 内容要具体、可执行：保留具体技术名 / 工具名 / 公司 / 证书 / 书名 / 课程名；合并去重；对出现频次高的（更重要的）要求标注「高频」或按重要性排序。');
  lines.push('3. 技术栈那一篇要**逐项列全**，并标注每项在资料里体现的要求程度（必须掌握 / 加分项 / 了解即可）。');
  lines.push('4. 只输出一个 JSON 对象：{"digests":[{"topic":"主题","title":"标题","content_md":"# 标题\n\n正文…"}]}');
  lines.push('5. content_md 用 Markdown（列表 / 表格都行），每篇 400-1500 字，不要写空话。');
  lines.push('');
  lines.push('【各批提炼结果】');
  for (const p of parts) lines.push('### 第 ' + p.idx + ' 批\n' + JSON.stringify(p.data));
  return lines.join('\n');
}

module.exports = { digestBatchPrompt, digestSynthesisPrompt };
