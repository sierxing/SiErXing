'use strict';
/**
 * 思而行 · 「当前页面」提示词块（纯函数）
 * ------------------------------------------------------------------
 * 为什么要有它：AI 助手以前只看得到目标数据（路线图 / 资料库 / 教程），
 * 看不到用户此刻正在看的那个页面 —— 在随堂测验里问"这道题为什么选 B"，
 * 模型得先反问"哪道题"。
 *
 * 现在前端在发送消息时把**当前页面的文字**一起带上（`page_context`），
 * 服务端清洗后由这里拼成提示词块。约束：
 *   ① 只依赖入参，不查 DB、不读 settings（和 server/prompts/context.js 同一规矩）；
 *   ② **必须有预算**：资料库页 / 长教程的 innerText 动辄几万字，
 *      原样塞进提示词会顶掉路线图与历史对话（模型反而变笨）；
 *   ③ 页面文字是"程序抓的界面文本"，里面必然混着按钮/提示语 ——
 *      提示词要说明这一点，并明确"看不到的别编"。
 */

/* 页面正文预算：超了就掐掉中间、保留头尾。
   头部是页面标题/当前题目，尾部往往是用户刚看到的那一段，中间多是重复的列表项。 */
const PAGE_TEXT_BUDGET = 9000;
const PAGE_TEXT_INPUT_MAX = 20000;
/* 页面 DOM 骨架的上限（只留标签/class/id，不含文本）：够看清层级，又不会把提示词撑爆。 */
const PAGE_DOM_INPUT_MAX = 16000;

/* 把任意输入清洗成 { label, title, route, text } 或 null。
   ⚠️ 服务端**必须**再过一遍：客户端可以伪造 / 也可能带着整篇教程正文上来。 */
function sanitizePageContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text == null ? '' : raw.text)
    .replace(/[\u200b-\u200d\ufeff]/g, '')   // 零宽字符：从页面上抓下来的隐形垃圾
    .replace(/\u0000/g, '')
    .slice(0, PAGE_TEXT_INPUT_MAX);
  const label = String(raw.label == null ? '' : raw.label).replace(/\s+/g, ' ').trim().slice(0, 60);
  const title = String(raw.title == null ? '' : raw.title).replace(/\s+/g, ' ').trim().slice(0, 160);
  const route = String(raw.route == null ? '' : raw.route).replace(/\s+/g, ' ').trim().slice(0, 200);
  /* 创造模式额外要「页面结构」：只有文字时模型改不动布局（拿不到真实 class / 容器层级）。
     其它模式不带这个字段，避免每条消息都多传几 KB。 */
  const dom = String(raw.dom == null ? '' : raw.dom)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u0000/g, '')
    .slice(0, PAGE_DOM_INPUT_MAX);
  if (!text.trim() && !title && !dom.trim()) return null;
  return { label: label || '当前页面', title, route, text, dom };
}

/* 去掉抓取噪声：连续空行、行尾空白、零宽字符、纯分隔符行 */
function tidyPageText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s\-—=_·•]+$/gm, '')
    .trim();
}

/* 拼成提示词块。返回 { text, label, chars, cut } 或 null（页面没信息量时不占篇幅）。 */
function pageContextBlockFrom(page) {
  const p = sanitizePageContext(page);
  if (!p) return null;
  const body = tidyPageText(p.text);
  /* 太短就当没有：一两个字的页面（比如刚渲染的空壳）塞进去只会让模型分心。 */
  /* 创造模式只带 DOM 也算有内容（正文可能全是代码块/输入框），别直接丢掉。 */
  if (body.length < 20 && !p.title && !p.dom) return null;
  let shown = body;
  let cut = 0;
  if (body.length > PAGE_TEXT_BUDGET) {
    const head = Math.round(PAGE_TEXT_BUDGET * 0.7);
    const tail = PAGE_TEXT_BUDGET - head;
    cut = body.length - PAGE_TEXT_BUDGET;
    shown = body.slice(0, head) + '\n…（中间省略 ' + cut + ' 字）…\n' + body.slice(-tail);
  }
  const lines = [];
  lines.push('【用户当前正在看的页面】');
  lines.push('- 页面：' + p.label + (p.title ? '「' + p.title + '」' : '') + (p.route ? '（' + p.route + '）' : ''));
  if (body) {
    lines.push('- 页面上的文字（共 ' + body.length + ' 字'
      + (cut ? '，中间省略 ' + cut + ' 字' : '') + '；由程序抓取，可能混有按钮/提示语等界面文字）：');
    lines.push(shown);
  }
  lines.push('用户说「这个 / 这里 / 当前页面 / 上面这道题 / 这一页」时，默认指的就是上面这个页面的内容；'
    + '页面里没有的信息就说没看到，不要凭空补。');
  return { text: lines.join('\n'), label: p.label, chars: body.length, cut: cut, dom: p.dom };
}

module.exports = { pageContextBlockFrom, sanitizePageContext, tidyPageText, PAGE_TEXT_BUDGET, PAGE_TEXT_INPUT_MAX, PAGE_DOM_INPUT_MAX };
