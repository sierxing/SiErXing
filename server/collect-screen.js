'use strict';
/**
 * 信息源「AI 把关」——广撒网搜回来之后，由 AI 逐条判读，只有高质量的才入库。
 *
 * 为什么要有它（用户反馈 + 抓的真实数据）：
 *   老的搜集流程是"搜到就收"，只挡得住明显的培训广告。实测结果：
 *   某目标的 218 条网络资料里 123 条（56%）连正文都抓不到（知乎/招聘站反爬），
 *   最多的一类是 CSDN（71 条水文与转载），抽样里还有"软考三件套""网络工程师学习路线"
 *   这种和目标完全无关的内容 —— 它们照样进资料库、照样各占一个检索切片。
 *   而人工「★优质」标记 857 条里只标了 2 条：指望用户逐条筛是不现实的。
 *
 * 用户的定调（原话）：
 *   "先大量检索，然后 AI 审查这批信息源内容质量如何；字数限制太死板了，应该由 AI 判读，
 *    如果一个高质量的信息被截断了，应该选择继续把全部内容导入进来。"
 * 于是流程变成：
 *   广撒网搜 → 抓「探测正文」→ **AI 判读**（相关度/有没有实质内容/是不是营销水文/主题/一句话摘要）
 *   → 达标的入库；**达标且被截断的，回去把全文抓回来再入库**。
 *
 * 本模块只做纯文本/纯决策（拼提示词、解析判读、按阈值取舍、决定要不要抓全文），
 * 网络与 DB 都留在 server.js，方便单独验证。
 */

/* 判读阈值（0~5）：≥ 这个分数才入库。3 = "相关且有实质内容，能用" */
const DEFAULT_MIN_SCORE = 3;
const MAX_ITEMS_PER_CALL = 18;      // 一次调用判几条：够省额度，又不会让模型漏读
const PROBE_CHARS = 1400;           // 拼给模型看的正文长度（探测正文通常 3500 字，取前 1400 够判）
const SUMMARY_LEN = 90;             // 一句话摘要长度上限

/** 拼一次判读调用。items: [{ i, query, kind, title, site, snippet, text }] */
function buildScreenPrompt(goalTitle, items, opts) {
  const o = opts || {};
  const L = [];
  L.push('你在为一份「学习资料库」做入库把关。下面是刚从搜索引擎抓回来的一批候选资料，');
  L.push('请逐条判断它值不值得进库（用户后面要拿这些资料学东西、做规划、写作品，掺水会直接害到他）。');
  L.push('');
  L.push('【用户的目标】' + String(goalTitle || '').slice(0, 120));
  L.push('');
  L.push('【判读标准】');
  L.push('1. **相关度** score 0~5：讲的是不是这个目标/这批查询真正要的东西。');
  L.push('   5 = 正中靶心的一手经验/官方文档/系统教程；4 = 相关且有干货；3 = 相关但一般（能用）；');
  L.push('   2 = 只沾一点边；1 = 基本无关；0 = 完全无关（例如搜"AI 产品经理"却返回"软考信息安全考点汇总"）。');
  L.push('2. **有没有实质内容** substance：正文里有具体信息（步骤、代码、数据、真实经历、明确结论），');
  L.push('   而不是只有标题党开场、目录、广告或"关注领取资料"。');
  L.push('3. **是不是营销/水文/机构招生** promo：培训机构招生页、卖课页、纯 SEO 拼凑的"必知必会/建议收藏/万字长文"、以及同一篇被反复转载的水文。');
  L.push('4. **主题** topic：2~6 个字，这条资料主要讲什么（用于列表分类，如"面经""RAG 原理""岗位要求"）。');
  L.push('5. **一句话摘要** summary：≤' + SUMMARY_LEN + ' 字，说清"这条资料里有什么"，不要复述标题。');
  L.push('6. **要不要抓全文** full：这条资料**正文明显被截断**（结尾在句子/段落中间、或后面还有大段内容），');
  L.push('   且判为高质量（score ≥ 4 且有实质内容）→ true；其余 false。');
  L.push('   ⚠️ 别为了省事一律 false：用户明确说过"高质量的内容被截断了就把全文抓进来"。');
  L.push('');
  L.push('【候选资料' + (o.batch && o.batch.total ? '（第 ' + o.batch.no + '/' + o.batch.total + ' 批）' : '') + '】');
  for (const it of items) {
    L.push('');
    L.push('#' + it.i + '｜搜索词：' + String(it.query || '').slice(0, 60) + '｜类型：' + String(it.kind || '') + '｜站点：' + String(it.site || ''));
    L.push('标题：' + String(it.title || '').slice(0, 120));
    if (it.snippet) L.push('搜索摘要：' + String(it.snippet).slice(0, 300));
    const body = String(it.text || '').replace(/\s+/g, ' ');
    L.push('抓到的正文' + (it.truncated ? '（**这条是截断的**）' : '') + '：' + body.slice(0, PROBE_CHARS) + (body.length > PROBE_CHARS ? '…' : ''));
    if (!body) L.push('（正文一个都没抓到，只有上面的搜索摘要）');
  }
  L.push('');
  L.push('【输出】只输出一个 JSON 数组，每条一个对象，字段与 #编号 一一对应：');
  L.push('[{"i":1,"score":4,"substance":true,"promo":false,"topic":"面经","summary":"…","full":false}]');
  L.push('不要输出任何别的文字或代码块标记。');
  return L.join('\n');
}

/** 解析判读结果；容错：外面裹了 ``` / 夹杂说明文字都能救回来 */
function parseVerdicts(raw, items) {
  const ids = new Set((items || []).map(x => Number(x.i)));
  let arr = null;
  const txt = String(raw || '');
  const m = txt.match(/\[[\s\S]*\]/);
  if (m) { try { arr = JSON.parse(m[0]); } catch (e) { arr = null; } }
  if (!arr) {
    try { arr = JSON.parse(txt); } catch (e) { arr = null; }
  }
  const out = new Map();
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const i = Number(x && (x.i != null ? x.i : x.id));
    if (!i || !ids.has(i)) continue;
    const clamp = n => Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    out.set(i, {
      i,
      score: clamp(x.score != null ? x.score : x.relevance),
      substance: x.substance !== false,
      promo: !!x.promo,
      topic: String(x.topic || '').replace(/\s+/g, ' ').trim().slice(0, 12),
      summary: String(x.summary || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LEN),
      full: !!x.full
    });
  }
  return out;
}

/** 单条是否放行（判读结果 → 决定）。返回 { keep, reason } */
function gate(verdict, opts) {
  const o = opts || {};
  const min = Number(o.minScore || DEFAULT_MIN_SCORE);
  if (!verdict) return { keep: false, reason: 'ai-missing' };       // 模型没判到这条 → 不收（宁缺勿滥）
  if (verdict.promo) return { keep: false, reason: 'promo' };
  if (!verdict.substance) return { keep: false, reason: 'no-substance' };
  if (verdict.score < min) return { keep: false, reason: 'low-score(' + verdict.score + ')' };
  return { keep: true, reason: '' };
}

/** 达标且被截断 → 要不要回去抓全文 */
function needFullText(verdict, item, opts) {
  const o = opts || {};
  if (!verdict || !item) return false;
  if (o.minFullScore && verdict.score < Number(o.minFullScore)) return false;
  return !!(verdict.full || (item.truncated && verdict.score >= (o.minFullScore || 4)));
}

/** 本地硬闸门：连 AI 都不用花就能挡掉的（广告黑名单、正文太短、跑题词）。
 *  返回 null = 继续交给 AI 判；否则 { keep:false, reason } */
function hardGate(item, opts) {
  const o = opts || {};
  const text = String((item && item.text) || '');
  const title = String((item && item.title) || '');
  const minBody = Number(o.minBody == null ? 260 : o.minBody);
  /* 一条正文都没有：只有搜索摘要 —— 只有在「AI 判读」缺失时才可能收（这里先标记，交上层决定） */
  if (text.length < minBody) return { keep: false, reason: 'no-body(' + text.length + ')' };
  /* 明显跑题的招考/考证类（搜"AI 产品经理"混进来的软考/公考/考研内容）：
     注意只在**标题**里挑，别误伤正文里顺嘴提到的词 */
  if (o.offTopicRe && o.offTopicRe.test(title)) return { keep: false, reason: 'off-topic' };
  return null;
}

/** 把一批候选切成若干批（每批不超过 MAX_ITEMS_PER_CALL 条） */
function batches(items, size) {
  const n = Math.max(4, Math.min(MAX_ITEMS_PER_CALL, Number(size) || MAX_ITEMS_PER_CALL));
  const out = [];
  for (let i = 0; i < (items || []).length; i += n) out.push(items.slice(i, i + n));
  return out;
}

module.exports = {
  DEFAULT_MIN_SCORE, MAX_ITEMS_PER_CALL, PROBE_CHARS, SUMMARY_LEN,
  buildScreenPrompt, parseVerdicts, gate, needFullText, hardGate, batches
};
