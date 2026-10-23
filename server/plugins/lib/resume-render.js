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
    avatar: S(o.avatar, 400),             /* 可选：data URI 或 http(s) 图片地址 */
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
 * 视觉设计 token：对齐「高密度技术履历」的排版语言
 * 目标样式：section 带图标 + 浅色底条 + 下细线；机构名加粗、右侧时间右对齐；
 * 顶部姓名大字 + 岗位副标题 + 联系方式 + 分隔线；紧凑但不挤。docx 与 HTML 共用。
 * ============================================================ */
const FONT = 'Microsoft YaHei';
const FONT_EA = String.fromCharCode(24494, 36719, 38597, 40657);
const PAGE_W = 11906;
const MARGIN_X = 560;
const TAB_RIGHT = PAGE_W - MARGIN_X * 2 - 10;

/* section 图标：按标题关键字匹配，匹配不到用方块 */
function sectionIcon(title) {
  const t = String(title || '');
  if (/教育|学历/.test(t)) return '\u{1F393}';
  if (/工作|实习|职业/.test(t)) return '\u{1F4BC}';
  if (/项目|经历/.test(t)) return '\u{1F6E0}';
  if (/科研|论文|研究/.test(t)) return '\u{1F4C4}';
  if (/技能|能力|专长/.test(t)) return '\u{1F527}';
  if (/获奖|荣誉|奖项/.test(t)) return '\u{1F3C6}';
  if (/实践|活动/.test(t)) return '\u{1F9EA}';
  if (/个人|概述|简介|总结/.test(t)) return '\u{1F464}';
  return '\u25AA';
}

function rFonts() {
  return '<w:rFonts w:ascii="' + FONT + '" w:hAnsi="' + FONT + '" w:eastAsia="' + FONT_EA + '" w:cs="' + FONT + '"/>';
}

/* docx 行内 runs（支持加粗 / 字号 / 颜色 / 右对齐 tail） */
function dxRuns(segments, o) {
  const opt = o || {};
  const out = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const rPr = ['<w:rPr>' + rFonts()];
    if (seg.bold || opt.bold) rPr.push('<w:b/>');
    if (opt.size) rPr.push('<w:sz w:val="' + Math.round(opt.size * 2) + '"/>');
    if (opt.color) rPr.push('<w:color w:val="' + opt.color + '"/>');
    rPr.push('</w:rPr>');
    out.push('<w:r>' + rPr.join('') + '<w:t xml:space="preserve">' + xmlEsc(seg.text) + '</w:t></w:r>');
  }
  if (opt.tail) {
    const rPr = '<w:rPr>' + rFonts()
      + (opt.tailSize ? '<w:sz w:val="' + Math.round(opt.tailSize * 2) + '"/>' : '')
      + (opt.tailColor ? '<w:color w:val="' + opt.tailColor + '"/>' : '') + '</w:rPr>';
    out.push('<w:r>' + rPr + '<w:tab/><w:t xml:space="preserve">' + xmlEsc(opt.tail) + '</w:t></w:r>');
  }
  return out.join('');
}

/* docx 段落构造器：底纹 / 下边框 / 右对齐 tab / 缩进 / 行距 / keepNext 全部可控 */
function p(content, o) {
  const opt = o || {};
  const segs = typeof content === 'string' ? splitBold(content) : content;
  const pPr = [];
  if (opt.keepNext) pPr.push('<w:keepNext/>');
  if (opt.borderBottom) {
    pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="' + (opt.borderSz || 6)
      + '" w:space="' + (opt.borderSpace == null ? 2 : opt.borderSpace) + '" w:color="'
      + (opt.borderColor || 'CCCCCC') + '"/></w:pBdr>');
  }
  if (opt.shd) pPr.push('<w:shd w:val="clear" w:color="auto" w:fill="' + opt.shd + '"/>');
  const sp = [];
  if (opt.before != null) sp.push('w:before="' + Math.round(opt.before * 20) + '"');
  if (opt.after != null) sp.push('w:after="' + Math.round(opt.after * 20) + '"');
  if (opt.line != null) sp.push('w:line="' + Math.round(opt.line * 240) + '" w:lineRule="auto"');
  if (sp.length) pPr.push('<w:spacing ' + sp.join(' ') + '/>');
  if (opt.tail) pPr.push('<w:tabs><w:tab w:val="right" w:pos="' + TAB_RIGHT + '"/></w:tabs>');
  const left = opt.left != null ? opt.left : opt.indent;
  if (left != null || opt.hanging != null) {
    const ind = [];
    if (left != null) ind.push('w:left="' + Math.round(left * 567) + '"');
    if (opt.hanging != null) ind.push('w:hanging="' + Math.round(opt.hanging * 567) + '"');
    pPr.push('<w:ind ' + ind.join(' ') + '/>');
  }
  if (opt.align) pPr.push('<w:jc w:val="' + opt.align + '"/>');
  const props = pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '';
  const body = dxRuns(segs, { size: opt.size, bold: opt.bold, color: opt.color, tail: opt.tail, tailSize: opt.tailSize, tailColor: opt.tailColor });
  return '<w:p>' + props + body + '</w:p>';
}

/* ============================================================
 * docx 渲染：高密度技术履历版式
 *   顶部  姓名（大字）→ 岗位副标题 → 联系方式 → 深色分隔线
 *   概述  浅灰底纹块（一句话卖点）
 *   章节  图标 + 标题 + 浅蓝灰底纹 + 下细线
 *   条目  机构名（加粗）…… 右对齐日期
 *   要点  ▪ 悬挂缩进
 * ============================================================ */
/* 联系方式里的长链接：https://atomgit.com/sierxing/SiErXing → atomgit.com/sierxing/SiErXing */
function shortLink(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\//g, '')
    .replace(/\/$/, '');
}

function renderDocx(raw, title) {
  const d = normData(raw);
  const B = [];
  /* 头部：姓名大字（黑色粗）+ 岗位行（主题色粗）+ 联系方式（灰）+ 深色分隔线 */
  if (d.name) B.push(p(d.name, { bold: true, size: 21, after: 1, line: 1.0, color: '0D0D0D' }));
  if (d.title) B.push(p(d.title, { size: 10.2, bold: true, color: '2F4B7C', after: 2, line: 1.0 }));
  if (d.contacts.length) {
    B.push(p(d.contacts.map(function (c) { return shortLink(c); }).join('   ·   '), {
      size: 8.5, color: '555555', after: 4, line: 1.0,
      borderBottom: true, borderSz: 12, borderColor: '2F4B7C'
    }));
  }
  if (d.summary) {
    B.push(p(d.summary, { size: 8.5, after: 2, before: 3, line: 1.16, color: '333333', shd: 'F5F7FA', left: 0.06 }));
  }
  for (const sec of d.sections) {
    /* 章节标题：图标（放大字号）+ 标题，浅蓝底纹 + 深色下边线，一眼分区 */
    const iconSegs = [{ text: sectionIcon(sec.title) + '  ', bold: false }, { text: sec.title, bold: true }];
    B.push(p(iconSegs, {
      bold: true, size: 10, color: '2F4B7C', before: 6, after: 2, line: 1.0,
      shd: 'EDF1F7', borderBottom: true, borderColor: '9AAECB', borderSz: 10, keepNext: true
    }));
    for (const it of sec.items) {
      if (it.left) {
        const hasTail = !!(it.right && String(it.right).trim() && !/^[-\u2014\u2013]+$/.test(String(it.right).trim()));
        B.push('<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="' + TAB_RIGHT + '"/></w:tabs>'
          + '<w:spacing w:before="40" w:after="6" w:line="240" w:lineRule="auto"/><w:keepNext/></w:pPr>'
          + dxRuns(splitBold(it.left), { size: 8.9, bold: true, color: '1A1A1A', tail: hasTail ? it.right : '', tailSize: 8.2, tailColor: '666666' })
          + '</w:p>');
      }
      for (const b of it.bullets) {
        B.push(p('\u25AA  ' + b, { size: 8.5, after: 0.4, line: 1.18, left: 0.32, hanging: 0.32, color: '262626' }));
      }
    }
  }
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + B.join('')
    + '<w:sectPr><w:pgSz w:w="' + PAGE_W + '" w:h="16838"/>'
    + '<w:pgMar w:top="440" w:right="' + MARGIN_X + '" w:bottom="380" w:left="' + MARGIN_X + '" w:header="0" w:footer="0" w:gutter="0"/>'
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
    return '<section><h2><span class="si">' + sectionIcon(sec.title) + '</span>' + htmlEsc(sec.title) + '</h2>' + items + '</section>';
  }).join('');
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>'
    + ':root{--ink:#1a1a1a;--muted:#666;--line:#ccd6e4;--accent:#2f4b7c;--soft:#edf1f7;--sum:#f5f7fa}'
    + '*{box-sizing:border-box}body{margin:0;background:#eef0f3;color:var(--ink);'
    + 'font-family:"Microsoft YaHei","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11.5px;line-height:1.42}'
    + '.page{max-width:820px;margin:10px auto;background:#fff;padding:22px 30px 26px;box-shadow:0 2px 14px rgba(0,0,0,.08)}'
    + 'h1{font-size:22px;margin:0 0 2px;letter-spacing:.5px;font-weight:800}'
    + '.role{font-size:12.6px;font-weight:700;color:var(--accent);margin-bottom:2px}'
    + '.meta{font-size:10px;color:var(--muted);padding-bottom:6px;border-bottom:2px solid var(--accent)}'
    + '.sum{margin:8px 0 2px;padding:6px 9px;font-size:10.8px;line-height:1.5;color:#333;background:var(--sum);border-radius:4px}'
    + 'section{margin-top:9px}'
    + 'h2{display:flex;align-items:center;gap:6px;font-size:12.2px;margin:0 0 4px;padding:3px 8px;'
    + 'background:var(--soft);border-bottom:1px solid var(--line);border-radius:3px 3px 0 0;color:var(--accent);letter-spacing:.3px}'
    + '.si{font-size:12.5px;line-height:1;font-family:"Segoe UI Emoji","Apple Color Emoji",sans-serif}'
    + '.it{margin:3px 0 1px}'
    + '.itHead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}'
    + '.itName{font-weight:700;font-size:11.3px}.itDate{font-size:9.8px;color:var(--muted);white-space:nowrap}'
    + 'ul{margin:1.5px 0 0;padding-left:14px;list-style:none}li{position:relative;margin:0.8px 0;font-size:10.6px;line-height:1.46;padding-left:9px}'
    + 'li::before{content:"\\25AA";position:absolute;left:0;color:var(--accent);font-size:9px;top:0.5px}'
    + '.toolbar{position:fixed;right:16px;bottom:16px;display:flex;gap:8px;z-index:9}'
    + '.toolbar button{border:1px solid #ccc;background:#fff;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}'
    + '.toolbar button:hover{background:#eee}'
    + '@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}.toolbar{display:none}'
    + '@page{size:A4;margin:9mm 12mm}}'
    + '</style></head><body><div class="page" contenteditable="true" spellcheck="false">'
    + '<h1>' + htmlEsc(d.name) + '</h1>'
    + (d.title ? '<div class="role">' + htmlEsc(d.title) + '</div>' : '')
    + (d.contacts.length ? '<div class="meta">' + d.contacts.map(htmlEsc).join('   ·   ') + '</div>' : '')
    + (d.summary ? '<div class="sum">' + inline(d.summary) + '</div>' : '')
    + secHtml
    + '</div><div class="toolbar"><button onclick="window.print()">' + (o.printLabel || 'Print / Save as PDF') + '</button></div></body></html>';
}

module.exports = {
  normData, splitBold, stripBold,
  dataToMarkdown, markdownToData,
  renderDocx, renderHtml
};
