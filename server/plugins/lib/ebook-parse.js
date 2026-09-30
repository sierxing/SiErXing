'use strict';
/**
 * 思而行 · 电子书文本提取（零依赖，只用 node 内置模块）
 * ------------------------------------------------------------------
 * 支持：.txt/.md（含 GBK）/ .pdf（文本型）/ .epub（zip）/ .mobi（无加密 PalmDoc）。
 * 不支持：扫描版 PDF（无文本层，请走截图识别）、Huff/KF8 编码或带 DRM 的 mobi
 *         （会给出明确提示）。解析上限 12 万字符，多余截断并注记。
 */
const zlib = require('node:zlib');

const MAX_CHARS = 120000;
const MAX_FILE = 12 * 1024 * 1024;   // 原始文件 12MB（base64 后约 16MB，低于请求体 20MB 上限）

/* ---------- 小工具 ---------- */
function u16(buf, o) { return buf.readUInt16BE(o); }
function u32(buf, o) { return buf.readUInt32BE(o); }
function latin1(buf) { return buf.toString('latin1'); }
function decodeText(buf) {
  // 先 UTF-8 严格解，失败再试 GBK（中文电子书常见）
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: t, encoding: 'utf-8' };
  } catch (e) {}
  try {
    const t = new TextDecoder('gbk', { fatal: false }).decode(buf);
    return { text: t, encoding: 'gbk' };
  } catch (e) {}
  return { text: buf.toString('utf8'), encoding: 'utf-8?' };
}
function stripBOM(t) { return String(t).replace(/^﻿/, ''); }
function normWS(t) {
  return String(t).replace(/\r\n?/g, '\n').replace(/[ \t 　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function stripTags(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\s*(br|p|div|h[1-6]|li|tr|section|article|blockquote|hr)[^>]*>/gi, '\n');
  t = t.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ' '; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ' '; } });
  return normWS(t);
}
function capText(t, meta) {
  t = normWS(t);
  if (t.length > MAX_CHARS) {
    meta.truncated = true;
    return t.slice(0, MAX_CHARS);
  }
  return t;
}

/* ---------- 类型识别（扩展名 + 文件头双保险） ---------- */
function detectKind(buf, filename) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
    return e === 'epub' ? 'epub' : null;   // zip 但扩展名不是 epub：拒绝，避免误吞 docx 等
  }
  if (buf.length >= 68 && buf.slice(60, 68).toString('latin1') === 'BOOKMOBI') return 'mobi';
  if (['txt', 'md', 'markdown', 'text', 'log'].includes(e)) return 'txt';
  if (['pdf', 'epub', 'mobi', 'azw', 'azw3'].includes(e)) {
    // 扩展名认识但文件头对不上：大概率是改了后缀或文件损坏
    return null;
  }
  return null;
}

/* ---------- .txt ---------- */
function parseTxt(buf) {
  const { text, encoding } = decodeText(buf);
  const meta = { encoding };
  const out = capText(stripBOM(text), meta);
  if (!out) throw new Error('文本文件是空的');
  return { text: out, meta };
}

/* ---------- .pdf（文本型）：扫描内容流，解 Flate + ToUnicode ---------- */
function pdfInflateDict(dictText, raw) {
  if (/\/FlateDecode|\/Fl\b/.test(dictText)) {
    try { return zlib.inflateSync(raw); } catch (e) { return raw; }
  }
  return raw;
}
function pdfParseToUnicode(s) {
  // s 是 ToUnicode 流文本：解析 bfchar / bfrange
  const map = new Map();
  const hex = h => parseInt(h, 16);
  let m;
  const bf = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bf.exec(s))) {
    const pairs = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) || [];
    for (const p of pairs) {
      const mm = p.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (mm) map.set(hex(mm[1]), String.fromCodePoint(hex(mm[2])));
    }
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(s))) {
    const lines = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g) || [];
    for (const ln of lines) {
      const mm = ln.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/);
      if (!mm) continue;
      const lo = hex(mm[1]), hi = hex(mm[2]);
      if (mm[3][0] === '[') {
        const arr = (mm[3].match(/<([0-9a-fA-F]+)>/g) || []).map(x => x.slice(1, -1));
        arr.forEach((dst, i) => { if (lo + i <= hi) map.set(lo + i, String.fromCodePoint(hex(dst))); });
      } else {
        const base = hex(mm[3].slice(1, -1));
        for (let c = lo; c <= hi && c - lo < 5000; c++) map.set(c, String.fromCodePoint(base + (c - lo)));
      }
    }
  }
  return map;
}
function pdfDecodeBytes(bytes, font) {
  // font: { toUnicode: Map|null, encoding: 'win'|'mac'|null }
  let out = '';
  let unknown = 0;
  for (let i = 0; i < bytes.length;) {
    let code, width = 1;
    if (font && font.cmap2) {   // 双字节（Identity-H 等）
      if (i + 1 >= bytes.length) break;
      code = (bytes[i] << 8) | bytes[i + 1]; width = 2;
    } else {
      code = bytes[i];
    }
    let ch = null;
    if (font && font.toUnicode && font.toUnicode.has(code)) ch = font.toUnicode.get(code);
    else if (code >= 32 && code < 127) ch = String.fromCharCode(code);
    else if (code >= 160) {
      // WinAnsi 高位近似（latin1 直映，覆盖绝大多数西文）
      try { ch = Buffer.from([code]).toString('latin1'); } catch (e) { ch = null; }
    }
    if (ch == null || ch === '￾') { unknown++; }
    else out += ch;
    i += width;
  }
  return { text: out, unknown, total: Math.max(1, bytes.length) };
}
function pdfParseContent2(text, fonts) {
  let out = '', cur = fonts.get('__default') || null;
  let unknown = 0, total = 0;
  const n = text.length;
  let i = 0;
  const isW = c => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0';
  const readStr = () => {   // 调用时 text[i] === '('
    let buf = '', depth = 0;
    i++; // 跳过 (
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n) { buf += c + text[i + 1]; i += 2; continue; }
      if (c === '(') { depth++; buf += c; i++; continue; }
      if (c === ')') { if (!depth) { i++; break; } depth--; buf += c; i++; continue; }
      buf += c; i++;
    }
    return buf;
  };
  const readHex = () => {   // 调用时 text[i] === '<'（且不是 <<）
    let h = '';
    i++;
    while (i < n && text[i] !== '>') { h += text[i]; i++; }
    if (i < n) i++;
    return h;
  };
  const peekOp = (start) => {
    let j = start;
    while (j < n && isW(text[j])) j++;
    let op = '';
    while (j < n && /[A-Za-z'*"]/.test(text[j])) { op += text[j]; j++; }
    return { op, end: j };
  };
  const flushStr = (raw, isHex) => {
    let bytes;
    if (isHex) {
      const h = raw.replace(/\s+/g, '');
      bytes = Buffer.alloc(Math.ceil(h.length / 2));
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(h.substr(k * 2, 2) || '0', 16);
    } else {
      const arr = [];
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (c === '\\' && k + 1 < raw.length) {
          const nx = raw[++k];
          if (nx === 'n') arr.push(10);
          else if (nx === 'r') arr.push(13);
          else if (nx === 't') arr.push(9);
          else if (nx === '\\' || nx === '(' || nx === ')') arr.push(nx.charCodeAt(0));
          else if (/[0-7]/.test(nx)) {
            let oct = nx, q = 0;
            while (q < 2 && k + 1 < raw.length && /[0-7]/.test(raw[k + 1])) { oct += raw[++k]; q++; }
            arr.push(parseInt(oct, 8) & 255);
          } else arr.push(nx.charCodeAt(0));
        } else arr.push(c.charCodeAt(0) & 255);
      }
      bytes = Buffer.from(arr);
    }
    const r = pdfDecodeBytes(bytes, cur);
    out += r.text; unknown += r.unknown; total += r.total;
  };
  while (i < n) {
    const c = text[i];
    if (c === '%') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '(') {
      const raw = readStr();
      const { op, end } = peekOp(i);
      if (op === 'Tj' || op === "'" || op === '"') {
        flushStr(raw, false);
        if (op === "'" || op === '"') out += '\n';
        i = end;
      }
      continue;
    }
    if (c === '<' && text[i + 1] !== '<') {
      const raw = readHex();
      const { op, end } = peekOp(i);
      if (op === 'Tj') { flushStr(raw, true); i = end; }
      continue;
    }
    if (c === '[') {
      // TJ 数组：[...(... ) -123 (...)...] TJ
      let depth = 0, j = i, parts = [];
      j++;
      let cur2 = '';
      while (j < n) {
        const cc = text[j];
        if (cc === '(' && text[j - 1] !== '\\') {
          // 读完整括号串
          let k = j + 1, dep = 0, s = '';
          while (k < n) {
            const c2 = text[k];
            if (c2 === '\\' && k + 1 < n) { s += c2 + text[k + 1]; k += 2; continue; }
            if (c2 === '(') { dep++; s += c2; k++; continue; }
            if (c2 === ')') { if (!dep) { k++; break; } dep--; s += c2; k++; continue; }
            s += c2; k++;
          }
          parts.push({ t: 's', v: s }); j = k; continue;
        }
        if (cc === '<' && text[j + 1] !== '<') {
          let k = j + 1, s = '';
          while (k < n && text[k] !== '>') { s += text[k]; k++; }
          if (k < n) k++;
          parts.push({ t: 'h', v: s }); j = k; continue;
        }
        if (cc === ']') { j++; break; }
        const num = text.slice(j).match(/^(-?[\d.]+)/);
        if (num) { parts.push({ t: 'n', v: Number(num[1]) }); j += num[1].length; continue; }
        j++;
      }
      while (j < n && isW(text[j])) j++;
      let op = '';
      while (j < n && /[A-Za-z]/.test(text[j])) { op += text[j]; j++; }
      if (op === 'TJ') {
        for (const p of parts) {
          if (p.t === 's') flushStr(p.v, false);
          else if (p.t === 'h') flushStr(p.v, true);
          else if (typeof p.v === 'number' && p.v < -100) out += ' ';
        }
        i = j;
      } else { i++; }
      void depth;
      continue;
    }
    if (c === '/' ) {
      // /F1 12 Tf 形式
      const m = text.slice(i).match(/^\/([A-Za-z0-9_+-]+)\s+([\d.]+)\s+Tf\b/);
      if (m) {
        const f = fonts.get(m[1]);
        if (f) cur = f;
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (c === 'T' && (text[i + 1] === 'd' || text[i + 1] === 'D') && !/[A-Za-z]/.test(text[i + 2] || '')) {
      // 前面数字已跳过（主循环按字符走，数字直接忽略），Td/T* 换行
      out += '\n'; i += 2; continue;
    }
    if (c === 'T' && text[i + 1] === '*' && !/[A-Za-z]/.test(text[i + 2] || '')) { out += '\n'; i += 2; continue; }
    if ((c === 'B' && text.substr(i, 3) === 'BMC') || (c === 'E' && text.substr(i, 3) === 'EMC')) { i += 3; continue; }
    i++;
  }
  return { text: out, unknown, total };
}
function parsePdf(buf) {
  const s = latin1(buf);
  if (!s.startsWith('%PDF-')) throw new Error('不是有效的 PDF 文件');
  const objs = new Map();
  {
    // dict 只取到 stream 关键字为止，避免流二进制污染字体/资源匹配
    const re = /(\d+)\s+(\d+)\s+obj/g;
    let m;
    while ((m = re.exec(s))) {
      const id = Number(m[1]);
      if (objs.has(id)) continue;
      const rest = s.slice(m.index + m[0].length);
      const cut = rest.search(/\bstream\r?\n|endobj/);
      objs.set(id, { dict: cut < 0 ? rest.slice(0, 4000) : rest.slice(0, cut) });
    }
  }
  // 字体表：font名 -> { toUnicode, cmap2 }
  const fonts = new Map();
  // 遍历所有流，按需解码（用 Length 精确定位流字节，不找 endobj：二进制流里可能恰好含有 endobj 字样）
  const decodedStreams = new Map();  // objId -> { dict, buf }
  {
    const headers = [...s.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)];
    const smRe = /stream\r?\n/g;
    for (let h = 0; h < headers.length; h++) {
      const id = Number(headers[h][1]);
      if (decodedStreams.has(id)) continue;
      const bodyStart = headers[h].index + headers[h][0].length;
      const bodyEnd = h + 1 < headers.length ? headers[h + 1].index : s.length;
      smRe.lastIndex = bodyStart;
      const sm = smRe.exec(s);
      if (!sm || sm.index >= bodyEnd) continue;   // 无流，或流关键字属于下一个对象
      const dictText = s.slice(bodyStart, sm.index);
      let len = -1;
      let lm = dictText.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (lm) len = Number(lm[1]);
      else {
        lm = dictText.match(/\/Length\s+(\d+)\s+\d+\s+R/);
        if (lm) {
          const ro = new RegExp('\n' + lm[1] + '\\s+\\d+\\s+obj\\s*(\\d+)').exec(s);
          if (ro) len = Number(ro[1]);
        }
      }
      if (len < 0 || len > buf.length) continue;
      const start = sm.index + sm[0].length;   // latin1 下字符偏移 == 字节偏移
      const raw = buf.slice(start, start + len);
      decodedStreams.set(id, { dict: dictText, buf: pdfInflateDict(dictText, raw) });
    }
  }
  // PDF 1.5+ 对象流（/ObjStm）：页面/字体对象藏在压缩流里，从已解码的流里展开
  // 注意：N / First 在流字典里，流内容只有偏移表 + 对象拼接
  let objstmExpanded = 0;
  for (const [osId, os] of decodedStreams) {
    if (!/ObjStm/.test(os.dict)) continue;
    const nm = os.dict.match(/\/N\s+(\d+)/), fm = os.dict.match(/\/First\s+(\d+)/);
    if (!nm || !fm) continue;
    const n = Number(nm[1]), first = Number(fm[1]);
    if (!n || n > 5000 || first <= 0 || first >= os.buf.length) continue;
    const txt = os.buf.toString('latin1');
    const nums = txt.match(/^\s*(\d+(?:\s+\d+)*)/);
    if (!nums) continue;
    const parts = nums[1].trim().split(/\s+/).map(Number);
    if (parts.length < n * 2) continue;
    for (let k = 0; k < n; k++) {
      const oid = parts[k * 2], off = parts[k * 2 + 1];
      const nextOff = k + 1 < n ? parts[k * 2 + 3] : (os.buf.length - first);
      if (!oid || objs.has(oid) || off < 0 || nextOff <= off) continue;
      objs.set(oid, { dict: txt.slice(first + off, first + nextOff) });
      objstmExpanded++;
    }
    void osId;
  }
  // ToUnicode 映射：fontObjId -> Map（通过 /ToUnicode ref 找到流）
  const fontTU = new Map();
  for (const [id, o] of objs) {
    if (!/\/Font\b/.test(o.dict)) continue;
    const tm = o.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (tm) {
      const t = decodedStreams.get(Number(tm[1]));
      if (t) {
        try { fontTU.set(id, pdfParseToUnicode(t.buf.toString('latin1'))); } catch (e) {}
      }
    }
  }
  // 字体名 -> 字体信息（含所属对象，供 Identity 判定）
  const nameToFont = new Map();
  for (const [id, o] of objs) {
    if (!/\/Font\b/.test(o.dict)) continue;
    const nm = o.dict.match(/\/BaseFont\s*\/([A-Za-z0-9_+-]+)/);
    const key = nm ? nm[1] : ('F' + id);
    const tu = fontTU.get(id) || null;
    const cmap2 = /\/Identity-H|\/Identity-V/.test(o.dict) || /\/CIDFontType/.test(o.dict);
    nameToFont.set(key, { toUnicode: tu, cmap2 });
    // 资源字典里 /F1 12 0 R 这种别名：顺带记录
  }
  // 页面内容流：找 /Type /Page 的 /Contents
  const contents = [];
  for (const [id, o] of objs) {
    if (!/\/Page\b/.test(o.dict) || /\/Pages\b/.test(o.dict)) continue;
    const cm = o.dict.match(/\/Contents\s*(\[[\s\S]*?\]|(\d+)\s+\d+\s+R)/);
    if (!cm) continue;
    if (cm[2]) {
      const t = decodedStreams.get(Number(cm[2]));
      if (t) contents.push({ buf: t.buf, dict: t.dict });
    } else {
      const refs = cm[1].match(/(\d+)\s+\d+\s+R/g) || [];
      for (const r of refs) {
        const t = decodedStreams.get(Number(r.split(/\s+/)[0]));
        if (t) contents.push({ buf: t.buf, dict: t.dict });
      }
    }
  }
  // 字体别名（/F1 -> 字体对象）：从各页 /Resources 里找
  const aliasToFont = new Map([['__default', { toUnicode: null, cmap2: false }]]);
  for (const [id, o] of objs) {
    void id;
    const rx = /\/Font\s*<<([\s\S]*?)>>/g;
    let mm;
    while ((mm = rx.exec(o.dict))) {
      const pairs = mm[1].match(/\/([A-Za-z0-9_+-]+)\s+(\d+)\s+\d+\s+R/g) || [];
      for (const pr of pairs) {
        const pm = pr.match(/\/([A-Za-z0-9_+-]+)\s+(\d+)\s+\d+\s+R/);
        if (!pm) continue;
        const target = objs.get(Number(pm[2]));
        let info = null;
        if (target) {
          const nm = target.dict.match(/\/BaseFont\s*\/([A-Za-z0-9_+-]+)/);
          if (nm && nameToFont.has(nm[1])) info = nameToFont.get(nm[1]);
          else if (fontTU.has(Number(pm[2]))) info = { toUnicode: fontTU.get(Number(pm[2])), cmap2: /Identity/.test(target.dict) };
        }
        if (!aliasToFont.has(pm[1]) && info) aliasToFont.set(pm[1], info);
      }
    }
  }
  // 内容流解码（先 inflate）
  let text = '';
  let unknown = 0, total = 0, pages = 0;
  for (const c of contents) {
    pages++;
    const r = pdfParseContent2(c.buf.toString('latin1'), aliasToFont);
    text += r.text + '\n';
    unknown += r.unknown; total += r.total;
  }
  if (process.env.EBOOK_DEBUG) {
    console.log('[pdf-debug]', JSON.stringify({
      objs: objs.size, streams: decodedStreams.size, objstmExpanded,
      fonts: nameToFont.size, tounicode: fontTU.size, contents: contents.length,
      unknown, total
    }));
  }
  text = normWS(text);
  if (!text) throw new Error('PDF 里没提取到文字（可能是扫描版，没有文本层）。建议把页面截图，用图片识别导入。');
  const badRatio = unknown / Math.max(1, total);
  const meta = { pages };
  if (badRatio > 0.15) {
    meta.garbled = true;
    meta.note = '部分文字无法识别（可能是内嵌字体缺编码表），已尽力提取；看不懂的地方建议截图走图片识别补。';
  }
  return { text: capText(text, meta), meta };
}

/* ---------- .epub（zip）：按 spine 顺序拼正文 + 章节目录 ---------- */
function zipEntries(buf) {
  if (buf.length < 22) throw new Error('不是有效的 epub（zip 损坏）');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 epub（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('epub 目录越界，文件可能损坏');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf[p] !== 0x50 || buf[p + 1] !== 0x4B || buf[p + 2] !== 0x01 || buf[p + 3] !== 0x02) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // local header 解析 data 位置
    const lh = localOff;
    if (buf[lh] !== 0x50 || buf[lh + 1] !== 0x4B || buf[lh + 2] !== 0x03 || buf[lh + 3] !== 0x04) { p += 46 + nameLen + extraLen + commentLen; continue; }
    const lNameLen = buf.readUInt16LE(lh + 26);
    const lExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    out.push({ name, method, compSize, dataStart });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, entry) {
  const raw = buf.slice(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('epub 用了不支持的压缩方式');
}
function parseEpub(buf) {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map(e => [e.name, e]));
  const get = name => {
    const e = byName.get(name);
    if (!e) return null;
    return zipRead(buf, e).toString('utf8');
  };
  const container = get('META-INF/container.xml');
  if (!container) throw new Error('不是有效的 epub（缺少 container.xml）');
  const rootMatch = container.match(/full-path="([^"]+)"/);
  if (!rootMatch) throw new Error('epub 结构异常（找不到 OPF）');
  const opfPath = rootMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = get(opfPath);
  if (!opf) throw new Error('epub 结构异常（OPF 缺失）');
  const titleM = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const creatorM = opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const title = titleM ? stripTags(titleM[1]).slice(0, 80) : '';
  const author = creatorM ? stripTags(creatorM[1]).slice(0, 60) : '';
  const manifest = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = itemRe.exec(opf))) {
    const idm = im[0].match(/\bid\s*=\s*"([^"]+)"/) || im[0].match(/\bid\s*=\s*'([^']+)'/);
    const hm = im[0].match(/href\s*=\s*"([^"]+)"/) || im[0].match(/href\s*=\s*'([^']+)'/);
    if (idm && hm) manifest.set(idm[1], decodeURIComponent(hm[1].split('#')[0]));
  }
  const spine = [];
  const refRe = /<itemref\b[^>]*>/gi;
  let rm;
  while ((rm = refRe.exec(opf))) {
    const idm = rm[0].match(/idref\s*=\s*"([^"]+)"/) || rm[0].match(/idref\s*=\s*'([^']+)'/);
    if (idm && manifest.has(idm[1])) spine.push(manifest.get(idm[1]));
  }
  if (!spine.length) throw new Error('epub 没有正文（spine 为空）');
  const chapters = [];
  const parts = [];
  for (const href of spine.slice(0, 400)) {
    const full = (opfDir + href).replace(/\/\.\//g, '/');
    const key = [...byName.keys()].find(k => k === full || k.endsWith('/' + href) || k === decodeURIComponent(full));
    if (!key) continue;
    let html = '';
    try { html = zipRead(buf, byName.get(key)).toString('utf8'); } catch (e) { continue; }
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let ct = tm ? stripTags(tm[1]).slice(0, 60) : '';
    if (!ct) {
      // 很多 epub 章节没有 <title>：退而求其次用第一个小标题
      const hm = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      if (hm) ct = stripTags(hm[1]).slice(0, 60);
    }
    const body = stripTags(html);
    if (!body) continue;
    if (ct) chapters.push(ct);
    parts.push((ct ? '# ' + ct + '\n\n' : '') + body);
  }
  const meta = { chapters: chapters.slice(0, 300), author };
  const text = capText(parts.join('\n\n'), meta);
  if (!text) throw new Error('epub 里没提取到文字');
  return { text, meta, title, author };
}

/* ---------- .mobi（PalmDB，无加密 PalmDoc 文本） ---------- */
function palmDecompressPalmDoc(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b >= 0xC0) { out.push(32, b ^ 0x80); i++; }
    else if (b >= 0x80) {
      if (i + 1 >= data.length) break;
      const code = (b << 8) | data[i + 1];
      const len = (code & 7) + 3;
      const dist = (code >> 3) & 0x7FF;
      const start = out.length - dist;
      for (let k = 0; k < len; k++) out.push(out[start + k] >= 0 ? out[start + k] : 32);
      i += 2;
    } else if (b >= 0x09) { out.push(b); i++; }
    else if (b >= 0x01 && b <= 0x08) {
      const n = b;
      i++;
      for (let k = 0; k < n && i < data.length; k++, i++) out.push(data[i]);
    } else { out.push(b); i++; }
  }
  return Buffer.from(out);
}
function parseMobi(buf) {
  if (buf.length < 100 || buf.slice(60, 68).toString('latin1') !== 'BOOKMOBI') {
    throw new Error('不是有效的 mobi 文件');
  }
  const numRecords = u16(buf, 76);
  if (!numRecords || numRecords > 20000) throw new Error('mobi 记录数异常，文件可能损坏');
  const recOffs = [];
  for (let i = 0; i < numRecords; i++) {
    const o = 78 + i * 8;
    if (o + 4 > buf.length) break;
    recOffs.push(u32(buf, o));
  }
  const rec = idx => {
    if (idx < 0 || idx >= recOffs.length) return Buffer.alloc(0);
    const start = recOffs[idx];
    const end = idx + 1 < recOffs.length ? recOffs[idx + 1] : buf.length;
    if (start >= buf.length || end <= start) return Buffer.alloc(0);
    return buf.slice(start, Math.min(end, buf.length));
  };
  const r0 = rec(0);
  if (r0.length < 32 || r0.slice(16, 20).toString('latin1') !== 'MOBI') {
    throw new Error('mobi 头损坏，无法解析');
  }
  const compression = u16(r0, 0);
  const encoding = u32(r0, 28);
  const textLen = u32(r0, 24 + 4);   // PalmDoc textLength 位置（record0 + 4? 下面用 recordCount 为准）
  void textLen;
  // 文本记录数：PalmDoc 头部 recordCount（record0 偏移 8）
  const textRecords = r0.length >= 12 ? u16(r0, 8) : 0;
  const nText = textRecords > 0 && textRecords < recOffs.length ? textRecords : recOffs.length - 1;
  // DRM 快速判断：EXTH 里常见 DRM 标记，或解出来全是乱码
  if (compression !== 1 && compression !== 2) {
    throw new Error('这个 mobi 用了不受支持的压缩（HuffDict/KF8）：请先转成 epub 或 txt 再导入（Calibre 可免费转换）');
  }
  const chunks = [];
  for (let i = 1; i <= nText && i < recOffs.length; i++) {
    const d = rec(i);
    if (!d.length) continue;
    chunks.push(compression === 2 ? palmDecompressPalmDoc(d) : d);
  }
  let raw = Buffer.concat(chunks);
  let text;
  if (encoding === 65001) text = raw.toString('utf8');
  else {
    try { text = new TextDecoder('windows-1252', { fatal: false }).decode(raw); }
    catch (e) { text = latin1(raw); }
  }
  text = stripTags(text);
  text = normWS(text);
  // 加密书解出来是乱码：用可读字符占比判断
  const sample = text.slice(0, 5000);
  const readable = (sample.match(/[\u4e00-\u9fffA-Za-z0-9，。、；：？！,.!?:;\s]/g) || []).length;
  if (text.length > 200 && readable / Math.max(1, sample.length) < 0.5) {
    throw new Error('这本 mobi 可能是加密（DRM）版本，解出来是乱码：请先解密，或转成 epub/txt 后再导入');
  }
  const meta = { records: nText };
  const out = capText(text, meta);
  if (!out) throw new Error('mobi 里没提取到文字');
  return { text: out, meta };
}

/* ---------- 统一入口 ---------- */
function baseTitle(filename, fallback) {
  const b = String(filename || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').trim();
  return (b || fallback || '电子书').slice(0, 80);
}
function parseEbook(buf, filename) {
  if (!buf || !buf.length) throw new Error('文件是空的');
  if (buf.length > MAX_FILE) throw new Error('文件过大（请控制在 12MB 以内；大部头可拆分章节导入）');
  const kind = detectKind(buf, filename);
  if (!kind) {
    const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const e = ext ? ext[1] : '';
    if (['txt', 'md', 'markdown', 'text', 'pdf', 'epub', 'mobi', 'azw', 'azw3'].includes(e)) {
      throw new Error(`.${e} 文件头不对：文件可能损坏或被改过后缀；扫描版 PDF 没有文字层，请截图走图片识别导入`);
    }
    throw new Error('格式不支持：目前支持 .txt / .pdf / .epub / .mobi（扩展名与文件头需一致）；扫描版 PDF 请截图走图片识别导入');
  }
  const meta = { kind, truncated: false };
  let r;
  if (kind === 'txt') r = parseTxt(buf);
  else if (kind === 'pdf') r = parsePdf(buf);
  else if (kind === 'epub') r = parseEpub(buf);
  else r = parseMobi(buf);
  Object.assign(meta, r.meta || {});
  const warnings = [];
  if (meta.truncated) warnings.push(`正文超长，只取了前 ${Math.round(MAX_CHARS / 10000)} 万字提炼`);
  if (meta.garbled && meta.note) warnings.push(meta.note);
  return { kind, text: r.text, meta, title: r.title || '', author: r.author || '', warnings };
}

module.exports = { parseEbook, detectKind, MAX_FILE, MAX_CHARS };
