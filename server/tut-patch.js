'use strict';
/**
 * 教程「局部修改」支持：判断改动规模 + 解析补丁 + 应用补丁。
 *
 * 为什么需要它：原来的修改流程是「把整篇教程发给 AI，让它输出改好的全文」。
 * 教程动辄六七万字，而单次输出上限只有 1.6 万 token，于是一篇修改要
 * 4 轮续写、每轮还重发整个提示词 —— 实测 190~355 秒。
 * 用户只是想改一句话的样式，却要等五分钟，体感就是"卡住了"。
 *
 * 现在：判断这是小改动时，只要 AI 回「原文片段 → 改后片段」的补丁，
 * 在本地套用。输出从 7 万字降到几十字，一轮就完，秒级返回。
 * 大改动（重写结构、加可视化）仍然走全文重写 —— 那种确实必须重发。
 *
 * 本模块只做纯文本处理（不碰 db / AI），方便单独验证。
 */

/* 明显是「整篇重做」的说法。命中就走全文重写，别用补丁硬凑。 */
const GLOBAL_RE = /整篇|全文|通篇|整体重写|重新组织|重写结构|推倒重来|全部重写|大改|每节|每一节|所有章节|通读|全篇|从头到尾|加可视化|补可视化|都加上|统一改成/;
/* 明显是「就改这一处」的说法。命中即走补丁。 */
const LOCAL_RE = /这段|这里|这一句|这句|这一行|这行|这一节|本节|这个表|这张表|这个标题|这个框|配色|颜色|字体|字号|间距|排版|错别字|改成|换成|删掉这|去掉这|补一句|加一句|措辞|语气/;

/** 判断用户这次要的是局部改动还是整篇重做。
 *  纯文本启发式，不花 AI 调用 —— 判断本身要是还得等 30 秒就本末倒置了。
 *  拿不准时返回 false（= 先试补丁）：补丁失败会自动退回全文重写，试错成本低。 */
function looksGlobal(feedback) {
  const s = String(feedback || '');
  if (GLOBAL_RE.test(s)) return true;
  if (LOCAL_RE.test(s)) return false;
  /* 又长又抽象（"讲得不够透，要更有深度"）通常是通篇问题；短句更像指着一处说 */
  return s.length > 120;
}

/** 解析 AI 回的补丁。容忍几种常见写法差异：
 *  <<<<<<< SEARCH / <<<<<<<SEARCH / ------- / ======= / >>>>>>> REPLACE / >>>>>>>REPLACE */
function parsePatches(raw) {
  let s = String(raw || '').replace(/\r\n/g, '\n');
  if (/^\s*NEED_FULL_REWRITE\s*$/m.test(s)) return { needFull: true, patches: [] };
  /* 有可能被 ``` 包起来 */
  s = s.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const lines = s.split('\n');
  const patches = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^<{5,}\s*SEARCH\s*$/i.test(lines[i].trim())) { i++; continue; }
    i++;
    const search = [];
    while (i < lines.length && !/^={5,}\s*$/.test(lines[i].trim())) { search.push(lines[i]); i++; }
    if (i >= lines.length) break;
    i++;   // 跳过 =======
    const replace = [];
    while (i < lines.length && !/^>{5,}\s*REPLACE\s*$/i.test(lines[i].trim())) { replace.push(lines[i]); i++; }
    if (i >= lines.length) break;
    i++;   // 跳过 >>>>>>> REPLACE
    const a = search.join('\n'), b = replace.join('\n');
    if (a.trim()) patches.push({ search: a, replace: b });
  }
  return { patches };
}

/* 逐行去掉行尾空格 + 统一缩进风格，用来做「宽松匹配」的第二轮尝试。
   模型复制原文时最常见的不一致就是行尾空格和末尾空行。 */
function relaxLines(s) {
  return String(s).split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
}
/** 在 content 里找 search 的位置。exact 找不到就退一步做宽松匹配，
 *  并返回宽松匹配对应的**原始下标范围**（这是能真正切对的关键）。 */
function findRange(content, search) {
  const idx = content.indexOf(search);
  if (idx >= 0) return { start: idx, end: idx + search.length, how: 'exact' };
  const rc = relaxLines(content);
  const rs = relaxLines(search);
  const ri = rc.indexOf(rs);
  if (ri < 0) return null;
  /* 宽松串里的下标和原文对不上（行尾空格被删了），所以按「第几行」换算回原文 */
  const before = rc.slice(0, ri).split('\n').length - 1;
  const span = rs.split('\n').length;
  const origLines = content.split('\n');
  let start = 0;
  for (let k = 0; k < before; k++) start += origLines[k].length + 1;
  let end = start;
  for (let k = before; k < Math.min(before + span, origLines.length); k++) end += origLines[k].length + 1;
  end = Math.max(start, end - 1);
  return { start, end, how: 'relaxed' };
}

/** 应用全部补丁。**要求全部命中**才返回成功 —— 只改一半比不改更危险
 *  （用户看到"已修改"却漏了一处，比明确失败更难发现）。
 *  返回 { ok, text, applied, failed } */
function applyPatches(content, patches) {
  let text = String(content || '');
  let applied = 0;
  const failed = [];
  for (const p of patches) {
    const hit = findRange(text, p.search);
    if (!hit) { failed.push(p.search.split('\n')[0].slice(0, 40)); continue; }
    text = text.slice(0, hit.start) + p.replace + text.slice(hit.end);
    applied++;
  }
  return { ok: failed.length === 0 && applied > 0, text, applied, failed };
}

/* ---------- 只挑相关章节发给 AI ----------
   补丁模式下 AI 不需要看全文：它只要照抄要改的那一小段。
   把整篇 7 万字都塞进提示词，光输入就是五万 token、首字延迟明显。
   这里按「用户这句话和哪几节最相关」来挑，通常只要 1~2 节就够。
   挑漏了也不致命：补丁套不上会自动退回全文重写（慢，但正确）。 */
function splitByH2(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^#[^#]/.test(l) || /^##[^#]/.test(l)) {
      if (cur) out.push(cur);
      cur = { title: l.replace(/^#+\s*/, '').trim(), lines: [l] };
    } else if (cur) cur.lines.push(l);
    else { cur = { title: '', lines: [l] }; }
  }
  if (cur) out.push(cur);
  return out.map(s => ({ title: s.title, text: s.lines.join('\n') }));
}
/* 中文没有空格，按 2 字滑窗切词；英文/数字按完整词。 */
function keywords(s) {
  const t = String(s || '');
  const out = new Set();
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,}/g)) out.add(m[0].toLowerCase());
  const zh = t.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const run of zh) {
    if (run.length <= 2) { out.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}
function pickRelevant(content, feedback, budget) {
  const full = String(content || '');
  const B = budget || 26000;
  if (full.length <= B) return { excerpt: full, whole: true, picked: [] };
  const secs = splitByH2(full);
  const kw = keywords(feedback);
  const scored = secs.map((s, i) => {
    const body = s.text;
    let hit = 0;
    for (const k of kw) if (body.includes(k)) hit++;
    /* 标题命中权重更高：用户说"那个表"通常指的就是标题里有"表"的那节 */
    let titleHit = 0;
    for (const k of kw) if (s.title.toLowerCase().includes(k)) titleHit += 3;
    return { i, s, score: hit + titleHit, len: body.length };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const x of scored) {
    if (x.score === 0 && picked.length) break;
    if (used + x.len > B && picked.length) break;
    picked.push(x);
    used += x.len;
    if (used > B) break;
  }
  picked.sort((a, b) => a.i - b.i);
  const outline = secs.map(s => '  - ' + (s.title || '(开头)')).join('\n');
  const excerpt = '【全文目录】\n' + outline
    + '\n\n【与本次意见相关的章节正文（原文，逐字引用时必须和这里完全一致）】\n\n'
    + picked.map(x => x.s.text).join('\n\n---\n\n');
  return { excerpt, whole: false, picked: picked.map(x => x.s.title) };
}

module.exports = { looksGlobal, parsePatches, applyPatches, findRange, pickRelevant, splitByH2, relaxLines };
