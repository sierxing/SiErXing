'use strict';
/**
 * 思而行 · 简历文件解析 / 生成（零依赖，只用 node 内置模块）
 * ------------------------------------------------------------------
 * 读：.docx（zip + word/document.xml）、.txt / .md（UTF-8 / GBK）
 * 写：.docx（最小 OOXML，STORE 模式 zip，Word / WPS / LibreOffice 都能打开）
 *
 * PDF 不在这里：复用 server/plugins/lib/ebook-parse.js 的 parseEbook（它自带文本层检测）。
 * 这里刻意只做「纯文本」，不保留原排版 —— 排版由 finalize 步骤重新生成。
 */
const zlib = require('node:zlib');

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_TEXT = 200000;

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipEntries(buf) {
  if (!buf || buf.length < 22) return [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf[p] !== 0x50 || buf[p + 1] !== 0x4B || buf[p + 2] !== 0x01 || buf[p + 3] !== 0x02) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lh = localOff;
    const ok = buf[lh] === 0x50 && buf[lh + 1] === 0x4B && buf[lh + 2] === 0x03 && buf[lh + 3] === 0x04;
    if (ok) {
      const lNameLen = buf.readUInt16LE(lh + 26);
      const lExtraLen = buf.readUInt16LE(lh + 28);
      out.push({ name: name, method: method, compSize: compSize, size: size, dataStart: lh + 30 + lNameLen + lExtraLen });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, entry) {
  const raw = buf.slice(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported-zip-method');
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = function (s) { return Buffer.from(String(s), 'utf8'); };
  for (const f of files) {
    const name = enc(f.name);
    const data = Buffer.isBuffer(f.data) ? f.data : enc(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(chunks), centralBuf, eocd]);
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch (e) {}
  try {
    return { text: new TextDecoder('gbk', { fatal: false }).decode(buf), encoding: 'gbk' };
  } catch (e) {}
  return { text: buf.toString('utf8'), encoding: 'utf-8?' };
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(Number(d)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&amp;/g, '&');
}
function docxXmlToText(xml) {
  const s = String(xml);
  const allRuns = [];
  let text = '';
  const blockRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let m;
  while ((m = blockRe.exec(s))) {
    const isRow = m[2] != null;
    const body = isRow ? m[2] : m[1];
    const cells = String(body).split(/<\/w:tc>/);
    const parts = [];
    for (const cell of cells) {
      const ts = [];
      const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let tm;
      while ((tm = tre.exec(cell))) { const v = decodeXmlEntities(tm[1]); ts.push(v); allRuns.push(v); }
      const brs = (cell.match(/<w:br\s*\/>/g) || []).length;
      parts.push(ts.join('') + (isRow && cell !== cells[cells.length - 1] ? '\t' : '') + (brs ? '\n'.repeat(brs) : ''));
    }
    text += parts.join('') + '\n';
  }
  if (!text.trim()) {
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm;
    while ((tm = tre.exec(s))) allRuns.push(decodeXmlEntities(tm[1]));
    text = allRuns.join('');
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function parseDocx(buf) {
  const entries = zipEntries(buf);
  if (!entries.length) throw new Error('not-docx');
  const doc = entries.find(function (e) { return e.name === 'word/document.xml'; });
  if (!doc) throw new Error('not-docx');
  return { text: docxXmlToText(zipRead(buf, doc)), encoding: 'docx' };
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function parseResumeBuffer(buf, filename) {
  const ext = extOf(filename);
  let out = null;
  if (ext === 'docx') out = parseDocx(buf);
  else if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'text' || ext === '') out = decodeText(buf);
  else if (ext === 'pdf' || ext === 'epub' || ext === 'mobi' || ext === 'azw' || ext === 'azw3') {
    let ebook = null;
    try { ebook = require('./ebook-parse'); } catch (e) {}
    if (!ebook || typeof ebook.parseEbook !== 'function') throw new Error('unsupported-format');
    const r = ebook.parseEbook(buf, filename);
    out = { text: (r && r.text) || '', encoding: ext, meta: (r && r.meta) || {} };
    if (!out.text || !out.text.trim()) throw new Error('no-text-layer');
  } else {
    throw new Error('unsupported-format');
  }
  let text = String((out && out.text) || '');
  if (!text.trim()) throw new Error('empty-document');
  let truncated = false;
  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
  return { text: text, encoding: (out && out.encoding) || '', truncated: truncated, chars: text.length };
}

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function run(text, opts) {
  const o = opts || {};
  const rPr = [];
  if (o.bold) rPr.push('<w:b/>');
  if (o.size) rPr.push('<w:sz w:val="' + Math.round(o.size * 2) + '"/>');
  if (o.color) rPr.push('<w:color w:val="' + o.color + '"/>');
  const props = rPr.length ? '<w:rPr>' + rPr.join('') + '</w:rPr>' : '';
  const pieces = String(text || '').split('\n');
  const out = [];
  pieces.forEach(function (p, i) {
    if (i) out.push('<w:br/>');
    out.push('<w:t xml:space="preserve">' + xmlEsc(p) + '</w:t>');
  });
  return '<w:r>' + props + out.join('') + '</w:r>';
}
function para(text, opts) {
  const o = opts || {};
  const pPr = [];
  if (o.line == null) o.line = 1.0;   /* 简历默认紧凑行距：一页 A4 装得下 */
  if (o.align) pPr.push('<w:jc w:val="' + o.align + '"/>');
  const spacing = [];
  if (o.before != null) spacing.push('w:before="' + Math.round(o.before * 12) + '"');
  if (o.after != null) spacing.push('w:after="' + Math.round(o.after * 12) + '"');
  if (o.line != null) spacing.push('w:line="' + Math.round(o.line * 240) + '" w:lineRule="auto"');
  if (spacing.length) pPr.push('<w:spacing ' + spacing.join(' ') + '/>');
  if (o.indent != null) pPr.push('<w:ind w:left="' + Math.round(o.indent * 20) + '"/>');
  const props = pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '';
  return '<w:p>' + props + (text == null || text === '' ? '' : run(text, o)) + '</w:p>';
}
function cleanInline(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}
function markdownToDocx(md, title) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const body = [];
  let firstBlock = true;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { body.push(para('', { after: 1 })); continue; }
    if (/^---+$/.test(line.trim())) { body.push(para('', { after: 0 })); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const lv = m[1].length;
      const sizes = { 1: 15, 2: 11.5, 3: 10.2, 4: 9.6 };
      body.push(para(cleanInline(m[2]), { bold: true, size: sizes[lv] || 9.6, before: firstBlock ? 0 : 4, after: 1.5 }));
      if (lv <= 2) body.push(para('', { after: 0 }));
      firstBlock = false;
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      body.push(para(cleanInline(m[1]), { indent: 0.32, after: 0.5, size: 9.4 }));
      firstBlock = false;
      continue;
    }
    if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      body.push(para(cleanInline(m[1] + '. ' + m[2]), { indent: 0.32, after: 0.5, size: 9.4 }));
      firstBlock = false;
      continue;
    }
    body.push(para(cleanInline(line), { after: 1, size: 9.4 }));
    firstBlock = false;
  }
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + body.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="520" w:right="620" w:bottom="480" w:left="620" w:header="0" w:footer="0" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const nm = String(title || 'resume').slice(0, 60);
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: docXml },
    { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + xmlEsc(nm) + '</dc:title></cp:coreProperties>' }
  ]);
}

module.exports = {
  MAX_INPUT, MAX_TEXT,
  extOf, parseResumeBuffer, parseDocx, docxXmlToText, decodeText,
  markdownToDocx, buildZip, zipEntries, zipRead, crc32
};
