'use strict';
/**
 * 思而行 · 简历渲染（结构化数据 → docx / HTML / Markdown）
 * ==================================================================
 * 为什么结构化：Markdown 只能一张白纸往下排，做不出「左边项目名、右边时间、章节带
 * 分隔线、要点真缩进、行内加粗」这种简历版式。所以 finalize 让 AI 直接产出结构化
 * resume_data，再由这里渲染成 docx / HTML（预览与 Word 同源）。
 *
 * 参考的工作流（用户指定的四个开源项目，含 1 个重复）：
 *   resume-evidence-workflow → 可编辑 HTML 输出、Grooming（改写前后↔JD 要求↔依据）
 *   ASu-resume-skills        → 高密度履历：技术链拆解、角色强度、指标重算
 *   lofisu-identity-engine   → 定位先行（title/summary 就是定位句）
 *
 * 零依赖：docx 用最小 OOXML（STORE zip），HTML 自包含单文件。
 */

/* ---------- 转义 ---------- */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 行内加粗：**重点** → 片段数组 ---------- */
function splitBold(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  if (!out.length) out.push({ text: '', bold: false });
  return out;
}
function stripBold(text) {
  return String(text == null ? '' : text).replace(/\*\*([^*]+)\*\*/g, '$1');
}

/* ---------- 数据规范化：AI 可能少字段 / 把 bullets 给成字符串 ---------- */
function normData(d) {
  const o = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const arr = function (v) { return Array.isArray(v) ? v : []; };
  const S = function (v, n) { return stripBold(String(v == null ? '' : v)).trim().slice(0, n || 400); };
  const data = {
    name: S(o.name, 40),
    title: S(o.title || o.target_role, 80),
    contacts: arr(o.contacts || o.contact).slice(0, 8).map(function (x) { return S(x, 80); }).filter(Boolean),
    summary: S(o.summary, 800),
    sections: arr(o.sections).slice(0, 10).map(function (sec) {
      const s = sec && typeof sec === 'object' ? sec : {};
      return {
        title: S(s.title, 40),
        items: arr(s.items).slice(0, 14).map(function (it) {
          const x = it && typeof it === 'object' && !Array.isArray(it) ? it : {};
          return {
            left: S(x.left || x.title || x.org, 220),
            right: S(x.right || x.period || x.date, 60),
            bullets: arr(x.bullets).slice(0, 8).map(function (b) {
              if (typeof b === 'string') return S(b, 500);
              return S((b && (b.text || b.b)) || '', 500);
            }).filter(Boolean)
          };
        }).filter(function (x) { return x.left || x.bullets.length; })
      };
    }).filter(function (s) { return s.title && s.items.length; })
  };
  /* 去掉「item 标题 == section 标题」的重复行（AI 常把「获奖荣誉」既当章节名又当条目标题） */
  for (const sec of data.sections) {
    for (const it of sec.items) {
      if (it.left && stripBold(it.left).trim() === stripBold(sec.title).trim()) it.left = '';
    }
    sec.items = sec.items.filter(function (x) { return x.left || x.bullets.length; });
  }
  return data;
}

/* ---------- 结构化 → Markdown（预览 / 复制 / 兼容旧的 final_md） ---------- */
function dataToMarkdown(d) {
  const data = normData(d);
  const lines = [];
  if (data.name) lines.push('# ' + data.name);
  const meta = [];
  if (data.title) meta.push('**' + data.title + '**');
  if (data.contacts.length) meta.push(data.contacts.join(' ｜ '));
  if (meta.length) { lines.push(''); lines.push(meta.join(' ｜ ')); }
  if (data.summary) { lines.push(''); lines.push(data.summary); }
  for (const sec of data.sections) {
    lines.push('');
    lines.push('## ' + sec.title);
    for (const it of sec.items) {
      lines.push('');
      if (it.left) lines.push('**' + it.left + '**' + (it.right ? ' ｜ ' + it.right : ''));
      for (const b of it.bullets) lines.push('- ' + b);
    }
  }
  return lines.join('\n').trim() + '\n';
}

/* ---------- Markdown → 结构化（老数据 / AI 只回 markdown 时兜底） ---------- */
function markdownToData(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const data = { name: '', title: '', contacts: [], summary: '', sections: [] };
  let cur = null, curItem = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#\s+(.+)$/))) { data.name = stripBold(m[1]).trim(); continue; }
    if ((m = line.match(/^##\s+(.+)$/))) {
      cur = { title: stripBold(m[1]).trim(), items: [] }; data.sections.push(cur); curItem = null; continue;
    }
    if ((m = line.match(/^###\s+(.+)$/))) {
      const seg = stripBold(m[1]).trim();
      const parts = seg.split(/\s*[｜|]\s*/);
      if (!cur) { cur = { title: '', items: [] }; data.sections.push(cur); }
      curItem = { left: parts[0] || '', right: parts.slice(1).join(' ｜ '), bullets: [] };
      cur.items.push(curItem);
      continue;
    }
    if ((m = line.match(/^\*\*(.+?)\*\*\s*(?:[｜|]\s*(.*))?$/))) {
      if (!cur) {
        const head = stripBold(m[1]).trim();
        const tail = stripBold(m[2] || '').trim();
        if (tail) { data.title = data.title || head; data.contacts.push(tail); }
        else if (!data.title) data.title = head;
        else data.contacts.push(head);
        continue;
      }
      curItem = { left: stripBold(m[1]).trim(), right: stripBold(m[2] || '').trim(), bullets: [] };
      cur.items.push(curItem);
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.+)$/))) {
      const text = m[1].trim();
      if (!cur) { cur = { title: '', items: [] }; data.sections.push(cur); }
      if (!curItem) { curItem = { left: '', right: '', bullets: [] }; cur.items.push(curItem); }
      curItem.bullets.push(text);
      continue;
    }
    if (!cur) {
      if (/电话|邮箱|微信|｜|@/.test(line)) data.contacts.push(stripBold(line));
      else if (!data.summary) data.summary = stripBold(line);
      else if (!data.title) data.title = stripBold(line);
      continue;
    }
    if (!curItem) { curItem = { left: '', right: '', bullets: [] }; cur.items.push(curItem); }
    curItem.bullets.push(stripBold(line));
  }
  data.sections = data.sections.filter(function (s) { return s.title || s.items.length; });
  return data;
}

/* ============================================================
 * docx 渲染：简历版式（右对齐日期 + 章节分隔线 + 真缩进要点 + 行内加粗）
 * ============================================================ */
const FONT = 'Microsoft YaHei';
const FONT_EA = String.fromCharCode(24494, 36719, 38597, 40657);   /* 微软雅黑：字体名，不是界面文案 */
const PAGE_W = 11906;
const MARGIN_X = 620;
const TAB_RIGHT = PAGE_W - MARGIN_X * 2 - 20;

function rFonts() {
  return '<w:rFonts w:ascii="' + FONT + '" w:hAnsi="' + FONT + '" w:eastAsia="' + FONT_EA + '" w:cs="' + FONT + '"/>';
}
function runsXml(segments, opts) {
  const o = opts || {};
  const pieces = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const rPr = ['<w:rPr>' + rFonts()];
    if (seg.bold || o.bold) rPr.push('<w:b/>');
    if (o.size) rPr.push('<w:sz w:val="' + Math.round(o.size * 2) + '"/>');
    if (o.color) rPr.push('<w:color w:val="' + o.color + '"/>');
    rPr.push('</w:rPr>');
    pieces.push('<w:r>' + rPr.join('') + '<w:t xml:space="preserve">' + xmlEsc(seg.text) + '</w:t></w:r>');
  }
  return pieces.join('');
}
function p(content, o) {
  const opt = o || {};
  const segs = typeof content === 'string' ? splitBold(content) : content;
  const pPr = [];
  if (opt.borderBottom) {
    pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="' + (opt.borderSz || 6) + '" w:space="2" w:color="' + (opt.borderColor || 'AAAAAA') + '"/></w:pBdr>');
  }
  const sp = [];
  if (opt.before != null) sp.push('w:before="' + Math.round(opt.before * 20) + '"');
  if (opt.after != null) sp.push('w:after="' + Math.round(opt.after * 20) + '"');
  if (opt.line != null) sp.push('w:line="' + Math.round(opt.line * 240) + '" w:lineRule="auto"');
  if (sp.length) pPr.push('<w:spacing ' + sp.join(' ') + '/>');
  if (opt.indent != null || opt.hanging != null) {
    const ind = [];
    if (opt.indent != null) ind.push('w:left="' + Math.round(opt.indent * 567) + '"');
    if (opt.hanging != null) ind.push('w:hanging="' + Math.round(opt.hanging * 567) + '"');
    pPr.push('<w:ind ' + ind.join(' ') + '/>');
  }
  if (opt.align) pPr.push('<w:jc w:val="' + opt.align + '"/>');
  const props = pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '';
  const body = segs.some(function (x) { return x.text; })
    ? runsXml(segs, { size: opt.size, bold: opt.bold, color: opt.color }) : '';
  return '<w:p>' + props + body + '</w:p>';
}

function renderDocx(raw, title) {
  const d = normData(raw);
  const B = [];
  if (d.name) B.push(p(d.name, { bold: true, size: 17, after: 1, line: 1.0 }));
  if (d.title) B.push(p(d.title, { size: 10.4, bold: true, color: '333333', after: 1, line: 1.0 }));
  if (d.contacts.length) {
    B.push(p(d.contacts.join('  ｜  '), { size: 8.6, color: '555555', after: 3, line: 1.0, borderBottom: true, borderSz: 10, borderColor: '888888' }));
  }
  if (d.summary) B.push(p(d.summary, { size: 9, after: 2, before: 3, line: 1.14 }));

  for (const sec of d.sections) {
    B.push(p(sec.title, { bold: true, size: 10.4, before: 7, after: 3, line: 1.0, borderBottom: true, borderColor: '999999' }));
    for (const it of sec.items) {
      if (it.left) {
        const headProps = '<w:pPr><w:tabs><w:tab w:val="right" w:pos="' + TAB_RIGHT + '"/></w:tabs>'
          + '<w:spacing w:before="50" w:after="10" w:line="240" w:lineRule="auto"/></w:pPr>';
        let head = '<w:p>' + headProps + runsXml(splitBold(it.left), { size: 9.2, bold: true });
        if (it.right && String(it.right).trim() && !/^[-—–]+$/.test(String(it.right).trim())) {
          head += '<w:r><w:rPr>' + rFonts() + '<w:sz w:val="17"/><w:color w:val="666666"/></w:rPr><w:tab/>'
            + '<w:t xml:space="preserve">' + xmlEsc(it.right) + '</w:t></w:r>';
        }
        B.push(head + '</w:p>');
      }
      for (const b of it.bullets) {
        B.push(p('• ' + b, { size: 8.9, after: 0.8, line: 1.14, indent: 0.42, hanging: 0.24 }));
      }
    }
  }

  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + B.join('')
    + '<w:sectPr><w:pgSz w:w="' + PAGE_W + '" w:h="16838"/>'
    + '<w:pgMar w:top="560" w:right="' + MARGIN_X + '" w:bottom="520" w:left="' + MARGIN_X + '" w:header="0" w:footer="0" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';
  return docXml;
}

/* ============================================================
 * HTML 渲染：自包含单文件、可直接编辑、可直接打印成 PDF
 * ============================================================ */
function renderHtml(raw, opts) {
  const d = normData(raw);
  const o = opts || {};
  const title = htmlEsc(o.title || d.name || 'Resume');
  const inline = function (s) { return String(s == null ? '' : s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); };
  const secHtml = d.sections.map(function (sec) {
    const items = sec.items.map(function (it) {
      const head = it.left
        ? '<div class="itHead"><span class="itName">' + inline(it.left) + '</span>'
          + (it.right && !/^[-—–]+$/.test(it.right) ? '<span class="itDate">' + htmlEsc(it.right) + '</span>' : '') + '</div>'
        : '';
      const bullets = it.bullets.length
        ? '<ul>' + it.bullets.map(function (b) { return '<li>' + inline(b) + '</li>'; }).join('') + '</ul>'
        : '';
      return '<div class="it">' + head + bullets + '</div>';
    }).join('');
    return '<section><h2>' + htmlEsc(sec.title) + '</h2>' + items + '</section>';
  }).join('');
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>'
    + ':root{--ink:#1a1a1a;--muted:#666;--line:#d6d6d6}'
    + '*{box-sizing:border-box}body{margin:0;background:#f2f3f5;color:var(--ink);'
    + 'font-family:"Microsoft YaHei","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11.6px;line-height:1.44}'
    + '.page{max-width:820px;margin:10px auto;background:#fff;padding:22px 30px;box-shadow:0 2px 14px rgba(0,0,0,.08)}'
    + 'h1{font-size:20px;margin:0 0 2px;letter-spacing:.5px}'
    + '.role{font-size:12.4px;font-weight:700;color:#333;margin-bottom:2px}'
    + '.meta{font-size:10.2px;color:var(--muted);padding-bottom:5px;border-bottom:1.5px solid #999}'
    + '.sum{margin:6px 0 1px;font-size:11.2px;line-height:1.5;color:#333}'
    + 'section{margin-top:9px}'
    + 'h2{font-size:12px;margin:0 0 3px;padding-bottom:1px;border-bottom:1px solid var(--line);letter-spacing:.3px}'
    + '.it{margin:3.5px 0 1px}'
    + '.itHead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}'
    + '.itName{font-weight:700;font-size:11.4px}.itDate{font-size:10.2px;color:var(--muted);white-space:nowrap}'
    + 'ul{margin:1.5px 0 0;padding-left:15px}li{margin:0.8px 0;font-size:11.2px;line-height:1.5}'
    + '.toolbar{position:fixed;right:16px;bottom:16px;display:flex;gap:8px;z-index:9}'
    + '.toolbar button{border:1px solid #ccc;background:#fff;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}'
    + '.toolbar button:hover{background:#eee}'
    + '@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}.toolbar{display:none}'
    + '@page{size:A4;margin:9mm 12mm}}'
    + '</style></head><body><div class="page" contenteditable="true" spellcheck="false">'
    + '<h1>' + htmlEsc(d.name) + '</h1>'
    + (d.title ? '<div class="role">' + htmlEsc(d.title) + '</div>' : '')
    + (d.contacts.length ? '<div class="meta">' + d.contacts.map(htmlEsc).join(' ｜ ') + '</div>' : '')
    + (d.summary ? '<div class="sum">' + inline(d.summary) + '</div>' : '')
    + secHtml
    + '</div><div class="toolbar"><button onclick="window.print()">' + (o.printLabel || 'Print / Save as PDF') + '</button></div></body></html>';
}

module.exports = {
  normData, splitBold, stripBold,
  dataToMarkdown, markdownToData,
  renderDocx, renderHtml
};
