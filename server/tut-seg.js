'use strict';
/**
 * 长教程的「分节改写」——把要改的那一段切块、逐块重写、再拼回整篇。
 *
 * 为什么需要它：原来的修改流程是「把整篇教程发给 AI，让它返回改好的全文」。
 * 9 万字的教程，光输出就要 4~6 轮续写：实测 8 万字就常撞"AI 输出过长"，
 * 9 万字以上更直接被上限拒收（TUT_EDIT_MAX），用户根本改不了。
 * 而用户点名的往往只是其中一段（"从「X」往后重写"）——
 * 那就**只把这一段发过去**：输出量从"整篇"降到"这一段"，
 * 范围外的正文逐字拼回，本来也就没机会被改坏。
 *
 * 本模块只做纯文本处理（切块 / 清理模型返回 / 拼装），不碰 db 与 AI，方便单独验证。
 */

/** 从 pos 往后找一个合适的切点：优先换行，其次句末标点，都没有就硬切。
 *  （中文教程里"一整节就一个大段"很常见，只认换行会切不动，等于没分块。） */
function snapCut(text, pos) {
  const s = String(text || '');
  if (pos >= s.length) return s.length;
  const win = s.slice(pos, Math.min(s.length, pos + 500));
  const nl = win.indexOf('\n');
  const sen = win.search(/[。！？!?；;]/);
  if (nl >= 0 && (sen < 0 || nl <= sen + 1)) return pos + nl + 1;
  if (sen >= 0) return pos + sen + 1;
  const nl2 = s.indexOf('\n', pos);
  return nl2 >= 0 ? nl2 + 1 : Math.min(s.length, pos + 200);
}

/**
 * 把 [fromIdx, toIdx) 这些标题覆盖的正文切成若干块。
 * @param content 整篇正文
 * @param hs      tut-guard.headings(content) 的结果（{title, offset} 按出现顺序）
 * @param fromIdx 起始标题下标（含）
 * @param toIdx   结束标题下标（不含；= hs.length 表示到全篇末尾）
 * @param maxChars 每块目标字数
 * @returns [{ start, end, title, last, mid }]（start/end 是 content 的字符偏移，按顺序）
 */
function splitScopeChunks(content, hs, fromIdx, toIdx, maxChars) {
  const text = String(content || '');
  const max = Math.max(2000, Number(maxChars) || 14000);
  const from = Math.max(0, Math.min(Number(fromIdx) || 0, hs.length - 1));
  const to = Math.max(from + 1, Math.min(Number(toIdx) || hs.length, hs.length));
  const endAll = to < hs.length ? hs[to].offset : text.length;
  const list = [];
  let start = hs[from].offset, title = hs[from].title, last = title;
  for (let i = from + 1; i < to; i++) {
    const off = hs[i].offset;
    if (off - start >= max) {
      list.push({ start, end: off, title, last });
      start = off; title = hs[i].title;
    }
    last = hs[i].title;
  }
  list.push({ start, end: endAll, title, last });
  /* 单节就超长（这一节里没有标题可切）→ 再按行边界切一刀，别指望模型一次吐出来 */
  const out = [];
  for (const c of list) {
    if (c.end - c.start <= max * 1.6) { out.push(c); continue; }
    let s = c.start;
    while (s < c.end) {
      let e = Math.min(c.end, s + max);
      if (e < c.end) e = snapCut(text, e);
      if (e <= s) e = c.end;
      out.push({ start: s, end: e, title: c.title, last: c.last, mid: s !== c.start || e !== c.end });
      s = e;
    }
  }
  return out.map((c, i) => Object.assign({}, c, {
    no: i + 1, total: out.length, chars: c.end - c.start,
    /* 这一块的**第一行原文**（可能是 "## 标题"）——用来判断模型有没有把段首标题吃掉 */
    firstLineRaw: text.slice(c.start, Math.min(c.end, snapCut(text, c.start + 300))).split('\n')[0] || ''
  }));
}

/** 该走分节改写吗？正文够长、而且这次的意见点名了范围（或者整篇本来就要重排）才走。 */
function shouldSegment(content, scopeMode, minChars) {
  const n = String(content || '').length;
  if (n <= (minChars || 28000)) return false;
  return scopeMode === 'range' || scopeMode === 'all';
}

/**
 * 清理模型返回的一段：
 *  · 整段被 ``` 包起来 → 剥掉；
 *  · 回显了输入标记 <<<SEG…>>> → 剥掉；
 *  · 把"下一段"也带出来了 → 在下一段标题处截断（多输出的部分由下一段自己负责）；
 *  · 把段首标题吃掉了 → 补回来（不许把标题搞丢）。
 */
function cleanSegment(raw, seg, nextTitle, nextIsHeading) {
  let t = String(raw || '').replace(/\r\n/g, '\n').trim();
  t = t.replace(/^<<<\s*SEGMENT_START\s*>>>\s*/i, '').replace(/<<<\s*SEGMENT_END\s*>>>\s*$/i, '');
  /* 整段被一个代码围栏包住（```markdown … ```）：只有当里面自己还有围栏时才剥，
     否则可能把"本来就是一段代码"的内容剥没了。 */
  const m = t.match(/^```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
  if (m && /```/.test(m[1])) t = m[1];
  if (nextIsHeading && nextTitle && nextTitle.length >= 4) {
    const at = t.indexOf(nextTitle);
    if (at > 0) t = t.slice(0, at);
  }
  /* 段首若是标题（原文这一段以 "## …" 开头），模型常把标题吃掉 → 补回来 */
  const hm = String((seg && seg.firstLineRaw) || '').trim().match(/^(#{2,3})[ \t]+(.+)$/);
  if (hm) {
    const firstLine = (t.split('\n').find(l => l.trim()) || '').trim();
    if (!/^#{1,6}[ \t]/.test(firstLine)) t = hm[1] + ' ' + hm[2].trim() + '\n\n' + t;
  }
  return t.trim() + '\n';
}

/** 拼回整篇：chunks 与改写结果一一对应，范围外逐字保留。 */
function splice(content, chunks, outs) {
  const text = String(content || '');
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('没有分段，无法拼装');
  if (!Array.isArray(outs) || outs.length !== chunks.length) throw new Error('分段结果数量对不上（' + (outs ? outs.length : 0) + '/' + chunks.length + '）');
  let out = '';
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.start < at) throw new Error('分段区间重叠，拒绝拼装');
    out += text.slice(at, c.start);
    out += String(outs[i] || '');
    at = c.end;
  }
  out += text.slice(at);
  return out;
}

module.exports = { snapCut, splitScopeChunks, shouldSegment, cleanSegment, splice };
