'use strict';
/**
 * 思而行 · 简历内容硬过滤（代码级，不依赖 AI 自觉）
 * ==================================================================
 * 用户明确要求「不写进简历」的内容（如「遗珠新韵 / 非遗问答」），只靠提示词约束不可靠 ——
 * 实测同一个提示词连跑两次，第一次删了、第二次又写回去了。所以这里加一道**代码级**过滤：
 * 在 finalize 结果落库前，把命中的条目整段剔除，并记进 removed / warnings 告知原因。
 *
 * 用法：resume_docs.excluded（JSON 字符串数组）记「用户要求排除的关键词」；
 *       finalize 时按这些关键词过滤 sections/items/bullets。
 * 默认排除词为空（不误删）；用户点「不写这条」时由前端/Agent 写入。
 */
function norm(list) {
  return (Array.isArray(list) ? list : []).map(function (x) { return String(x == null ? '' : x).trim(); })
    .filter(function (x) { return x.length >= 2; }).slice(0, 30);
}

/** 一段文本是否命中排除词 */
function hitAny(text, words) {
  const s = String(text == null ? '' : text);
  for (const w of words) if (s.indexOf(w) >= 0) return w;
  return '';
}

/**
 * 过滤结构化简历数据
 * @returns {{data: object, removed: string[]}}
 */
function filterData(data, excluded) {
  const words = norm(excluded);
  if (!words.length) return { data: data, removed: [] };
  const d = data && typeof data === 'object' ? data : {};
  const removed = [];
  const sections = [];
  for (const sec of (d.sections || [])) {
    const items = [];
    for (const it of (sec.items || [])) {
      const blob = [it.left, it.right].concat(it.bullets || []).join(' ');
      const hit = hitAny(blob, words);
      if (hit) { removed.push(hit + ' → ' + (it.left || String((it.bullets || [''])[0]).slice(0, 40))); continue; }
      items.push(it);
    }
    if (items.length) sections.push({ title: sec.title, items: items });
  }
  /* summary / title 里命中时：按句/分号切掉命中的那一句，而不是整段丢弃 */
  const stripText = function (text, label) {
    const t = String(text == null ? '' : text);
    if (!t || !hitAny(t, words)) return t;
    const parts = t.split(/(?<=[。；;\n])/);
    const kept = parts.filter(function (x) { return !hitAny(x, words); });
    const hits = parts.filter(function (x) { return hitAny(x, words); });
    if (hits.length) removed.push(label + ' → ' + hits.join('').slice(0, 80));
    return kept.join('').trim();
  };
  const out = Object.assign({}, d, { sections: sections });
  out.summary = stripText(d.summary, 'summary');
  out.title = stripText(d.title, 'title');
  /* 姓名/联系方式命中也清（用户可能要求不显示某个曾用名/某条链接） */
  const nm = hitAny(d.name, words);
  if (nm) { removed.push('name → ' + String(d.name).slice(0, 60)); out.name = ''; }
  out.contacts = (Array.isArray(d.contacts) ? d.contacts : []).filter(function (c) {
    const h = hitAny(c, words);
    if (h) removed.push('contacts → ' + String(c).slice(0, 60));
    return !h;
  });
  return { data: out, removed: removed };
}

/** 从简历正文里「反推」用户可能想排除的条目（用于首次自动发现，可选） */
function suggestExcluded(resumeText, words) {
  const ws = norm(words);
  if (!ws.length) return [];
  const lines = String(resumeText || '').replace(/\r\n?/g, '\n').split('\n');
  return lines.map(function (l) { return l.trim(); })
    .filter(function (l) { return l && hitAny(l, ws); })
    .slice(0, 20);
}

module.exports = { filterData, hitAny, suggestExcluded, norm };
