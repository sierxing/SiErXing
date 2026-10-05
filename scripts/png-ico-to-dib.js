#!/usr/bin/env node
/**
 * 把 .ico 里的 PNG 压缩图换成 DIB —— 因为 **Windows 的 PE 图标资源只认 DIB**
 * ---------------------------------------------------------------------------
 * 踩过的坑：`.ico` 文件本身允许内嵌 PNG（Vista 起支持，文件小很多），
 * 但 PE 可执行文件里的 `RT_ICON` 资源**必须**是 DIB（BITMAPINFOHEADER + BGRA + AND 掩码）。
 * 把 .ico 里的字节原样塞进 exe，Windows 会当成坏资源 → 图标不显示（退回默认图标/旧缓存）。
 *
 * 而且这个坑很隐蔽：校验时若只验「exe 里的字节与源 ico 一致」，会**恰好验证了这个 bug**。
 * 正确校验要看数据头是不是 BITMAPINFOHEADER（0x28），不是看是否与源文件一致。
 *
 * 用法：
 *   node scripts/png-ico-to-dib.js public/icon.ico          # 就地转换
 *   node scripts/png-ico-to-dib.js public/icon.ico --check  # 只检查不修改
 *
 * 只处理「8 位 RGBA、非隔行」的 PNG（本项目 icon.ico 就是这种）；
 * 遇到别的格式直接报错，而不是默默产出坏图标。
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------------- PNG 解码（仅 8 位 RGBA / 非隔行） ---------------- */
function decodePngRGBA(buf) {
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG');
  let off = 8, ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.bitDepth !== 8 || ihdr.colorType !== 6) {
    throw new Error('只支持 8 位 RGBA（颜色类型 6），当前是位深 ' + ihdr.bitDepth + ' 类型 ' + ihdr.colorType);
  }
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');

  const w = ihdr.width, h = ihdr.height, bpp = 4, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    line.copy(cur);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return { width: w, height: h, rgba: out };
}

/* ---------------- RGBA → DIB（PE 图标资源要的那种） ---------------- */
function toDib(w, h, rgba) {
  /* AND 掩码是 1bpp，每行字节数向上对齐到 4 的倍数。
     行距 = ceil(w/32) 个 32 位字 * 4 字节。
     ⚠️ 之前写成 <<3（= *8 字节），每行多分配了一倍空间，7 张全错。 */
  const andStride = ((w + 31) >> 5) << 2;
  const xorSize = w * h * 4;
  const andSize = andStride * h;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);                      // biSize
  hdr.writeInt32LE(w, 4);                        // biWidth
  hdr.writeInt32LE(h * 2, 8);                    // biHeight = 颜色图 + 掩码
  hdr.writeUInt16LE(1, 12);                      // biPlanes
  hdr.writeUInt16LE(32, 14);                     // biBitCount
  hdr.writeUInt32LE(0, 16);                      // biCompression = BI_RGB
  hdr.writeUInt32LE(xorSize + andSize, 20);      // biSizeImage
  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * w * 4;               // DIB 是自下而上
    for (let x = 0; x < w; x++) {
      const sp = s + x * 4, dp = (y * w + x) * 4;
      xor[dp] = rgba[sp + 2]; xor[dp + 1] = rgba[sp + 1];
      xor[dp + 2] = rgba[sp]; xor[dp + 3] = rgba[sp + 3];   // BGRA
    }
  }
  /* AND 掩码全 0：32 位图靠 alpha 通道表示透明，这里再置 1 会被当成全透明 */
  const and = Buffer.alloc(andSize);
  const out = Buffer.concat([hdr, xor, and]);
  /* 自检：头部声明的长度必须等于实际拼出来的长度，否则说明行距算错了 */
  if (out.readUInt32LE(20) !== xorSize + andSize || out.length !== 40 + xorSize + andSize) {
    throw new Error('DIB 尺寸自检失败：' + w + 'x' + h + ' 声明 ' + out.readUInt32LE(20)
      + ' 实际 ' + (out.length - 40));
  }
  return out;
}

function isPng(b) { return b.length > 8 && b.slice(0, 8).equals(PNG_SIG); }
function isDib(b) { return b.length > 4 && b.readUInt32LE(0) === 0x28; }

/** 把一个 .ico 里的 PNG 图全部换成 DIB；返回新 Buffer 与统计 */
function convertIco(ico) {
  const n = ico.readUInt16LE(4);
  const dirs = [];
  const datas = [];
  let converted = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    const w = ico[o], h = ico[o + 1];
    const size = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
    let data = ico.slice(off, off + size);
    if (isPng(data)) {
      const img = decodePngRGBA(data);
      data = toDib(img.width, img.height, img.rgba);
      converted++;
    } else if (isDib(data)) { kept++; }
    else throw new Error('第 ' + i + ' 张既不是 PNG 也不是 DIB，不认识');
    dirs.push({ w, h, colors: ico[o + 2], planes: ico.readUInt16LE(o + 4), bitCount: ico.readUInt16LE(o + 6), size: data.length });
    datas.push(data);
  }
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let cursor = 6 + 16 * n;
  datas.forEach((d, i) => {
    const o = i * 16;
    dir[o] = dirs[i].w; dir[o + 1] = dirs[i].h; dir[o + 2] = dirs[i].colors;
    dir.writeUInt16LE(0, o + 4); dir.writeUInt16LE(dirs[i].bitCount, o + 6);
    dir.writeUInt32LE(dirs[i].size, o + 8);
    dir.writeUInt32LE(cursor, o + 12);
    cursor += dirs[i].size;
  });
  return { buf: Buffer.concat([head, dir, ...datas]), converted, kept, count: n };
}

/** 给某个 .ico 里仍是 PNG 的图提供 DIB 版本（供打包时直接用）
 *  返回 [{bin, width, height}]，bin 保证是 DIB（已是 DIB 的原样返回） */
function dibsOfIco(ico) {
  const n = ico.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    const size = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
    const data = ico.slice(off, off + size);
    let bin = data, w = ico[o] || 256, h = ico[o + 1] || 256;
    if (isPng(data)) {
      const img = decodePngRGBA(data);
      bin = toDib(img.width, img.height, img.rgba);
      w = img.width; h = img.height;
    } else if (!isDib(data)) {
      throw new Error('第 ' + i + ' 张既不是 PNG 也不是 DIB，不认识');
    }
    out.push({ bin, width: w, height: h });
  }
  return out;
}

/* 标准 CRC-32（PNG 分块校验用），查表法 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DIB（BGRA，自下而上）→ PNG。
 *  用途：把 exe 里**真正嵌的那张**图标导出成能看的图片。
 *  因为 Linux 的 GNOME 文件管理器**不读 PE 图标**（只看共享 MIME 里的通用/wine 图标），
 *  在本机文件管理器上根本看不出 exe 嵌得对不对 —— 导出成 PNG 才能自己核对。 */
function dibToPng(dib) {
  const w = dib.readInt32LE(4), h2 = dib.readInt32LE(8);
  if (h2 % 2 !== 0) throw new Error('biHeight 应为偶数（颜色图+掩码），当前 ' + h2);
  const h = h2 / 2, xorOff = 40;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0;                                     // 行过滤器：None
    const s = (h - 1 - y) * w * 4;                  // DIB 自下而上 → PNG 自上而下
    for (let x = 0; x < w; x++) {
      const sp = s + x * 4, dp = o + 1 + x * 4;
      raw[dp] = dib[xorOff + sp + 2];                // R
      raw[dp + 1] = dib[xorOff + sp + 1];            // G
      raw[dp + 2] = dib[xorOff + sp];                // B
      raw[dp + 3] = dib[xorOff + sp + 3];            // A
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                          // 8 位 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decodePngRGBA, toDib, dibToPng, convertIco, dibsOfIco, isPng, isDib };

if (require.main === module) {
  const file = process.argv[2];
  const check = process.argv.includes('--check');
  if (!file) { console.error('用法: node scripts/png-ico-to-dib.js <文件.ico> [--check]'); process.exit(1); }
  const ico = fs.readFileSync(file);
  const r = convertIco(ico);
  console.log('  共 ' + r.count + ' 张：PNG→DIB ' + r.converted + ' 张，本来就是 DIB ' + r.kept + ' 张');
  if (check) {
    const need = r.converted > 0;
    console.log(need ? '  ✗ 仍有 PNG 图，Windows 的 PE 里会失效' : '  ✓ 全部是 DIB');
    process.exit(need ? 1 : 0);
  }
  if (!r.converted) { console.log('  不用改'); process.exit(0); }
  const before = ico.length, after = r.buf.length;
  fs.writeFileSync(file, r.buf);
  console.log('  已就地转换：' + before + ' → ' + after + ' 字节' +
    '（会变大 —— PNG 压缩换成了未压缩的 BGRA，这是 PE 图标资源的硬性要求）');
}