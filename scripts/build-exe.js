#!/usr/bin/env node
/**
 * 思而行 · 打包成单个 Windows .exe，并产出「可在线更新」的发布件
 * ---------------------------------------------------------------------------
 * 目标：让没装 Node、不会用命令行的用户也能「双击就用」，而且以后还能自动更新。
 *
 * 做法（Node 官方 SEA，Single Executable Application）：
 *   1. 把 server/ + public/ 打成一个小归档（payload，约 450KB）
 *   2. 下载官方 node.exe (win-x64)，校验 sha256
 *   3. node --experimental-sea-config 生成 blob
 *   4. postject 把 blob 注入 node.exe → dist/SiErXing.exe
 *
 * 为什么更新只换 payload 而不重下 exe：
 *   exe 里 99.5% 是 node 运行时，永远不变。变的只有那 450KB 的程序文件。
 *   所以发新版 = 换一个 payload + 改一行 release/latest.json，用户下次启动自动跟进。
 *
 * 运行时仍然是**零第三方依赖**：postject 只在构建这一刻用一次，不进产物。
 * 仓库依旧保持「clone 完直接 node server/server.js 就能跑」。
 *
 * 用法：
 *   node scripts/build-exe.js                      # 构建 exe + 发布件
 *   node scripts/build-exe.js --skip-exe           # 只出发布件（更新用，最快）
 *   node scripts/build-exe.js --node=v24.21.0      # 指定 Node 版本
 *   node scripts/build-exe.js --out=my.exe --notes="修了三处 bug"
 *
 * 交叉构建：可以在 Linux/macOS 上直接产出 Windows exe（只需能下 zip + 有 unzip）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'dist');
const BUILDDIR = path.join(ROOT, '.build');
const RELEDIR = path.join(ROOT, 'release');
const EXE_NAME = 'SiErXing.exe';

/* 固定版本：构建可复现。SEA 与 node:sqlite 都要 ≥22.5，这里用当期 LTS。 */
const DEFAULT_NODE = 'v24.21.0';

/* 在线更新的清单与载荷放在这个仓库（AtomGit 的 contents 接口免鉴权可读） */
const REPO_PATH = 'sierxing/SiErXing';

/* 要打进 exe 的东西。只放运行时真正会读的：
   package.json / scripts/ 运行时没人读（已核过），data/ 是用户数据绝对不能打进去。 */
const INCLUDE_DIRS = ['server', 'public'];
const INCLUDE_FILES = ['LICENSE', 'README.md', 'AGENTS.md'];

const argv = process.argv.slice(2);
const argOf = name => {
  const hit = argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
};
const hasFlag = name => argv.includes('--' + name);
const REL = String(require(path.join(ROOT, 'package.json')).version || '0.0.0');
const NODE_VER = argOf('node') || DEFAULT_NODE;
/* 产物名带版本号：换文件名能绕开 Windows / GNOME 侧的图标缓存（同一个路径覆盖过去时，
   资源管理器常常还拿着旧图标不放），顺带让 release 附件一眼能看出对应哪个版本。 */
const OUT_NAME = argOf('out') || ('SiErXing-' + REL + '.exe');
const NOTES = argOf('notes') || '';

function log(...a) { console.log('[build-exe]', ...a); }
function die(msg) { console.error('[build-exe] ✗ ' + msg); process.exit(1); }
function have(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
  if (r.status !== 0) die('命令失败：' + cmd + ' ' + args.join(' '));
  return r;
}

/* ---------------- 1. 收集运行时文件 ---------------- */
function collect() {
  const files = [];
  const walk = dirAbs => {
    const rel = path.relative(ROOT, dirAbs);
    for (const e of fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const abs = path.join(dirAbs, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (r.startsWith('data')) continue;             // 双保险：用户数据永不进包
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push({ p: r.split(path.sep).join('/'), abs });
    }
  };
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) die('缺少目录 ' + d);
    walk(abs);
  }
  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) files.push({ p: f, abs });
  }
  if (!files.length) die('没收集到任何文件');
  return files;
}

/* ---------------- 2. 归档格式（自制极简格式，纯 Node 可读可写） ----------------
   SXA1 | uint32 headerLen | JSON 头 | 各文件原始字节依次拼接，再整体 gzip。
   头里带 rel（发布版本号）与 ver（内容哈希），更新逻辑全靠这两个字段。
   不用 zip 是因为读写 zip 得自己实现中央目录，而这里只需要「一堆文件原样搬过去」。 */
function pack(files) {
  // 内容哈希：必须按**文件内容**算。早先只 hash 了 package.json，
  // 改 public/app.js 而不动 package.json 时哈希不变 → 更新会被当成"已是最新"跳过。
  const h = crypto.createHash('sha256');
  let total = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    h.update(f.p); h.update(String(buf.length)); h.update(buf);
    total += buf.length;
  }
  const ver = h.digest('hex').slice(0, 12);
  const head = Buffer.from(JSON.stringify({
    v: 1, rel: REL, ver, files: files.map(f => ({ p: f.p, size: fs.statSync(f.abs).size })),
  }), 'utf8');
  const headBuf = Buffer.alloc(8);
  headBuf.write('SXA1', 0, 'ascii');
  headBuf.writeUInt32LE(head.length, 4);
  const parts = [headBuf, head];
  for (const f of files) parts.push(fs.readFileSync(f.abs));
  return { buf: zlib.gzipSync(Buffer.concat(parts), { level: 9 }), ver, total };
}

/* ---------------- 3. 启动器（会被塞进 exe 的主脚本） ---------------- */
function launcherSource(ver) {
  return `'use strict';
/* 思而行 · 单文件启动器（由 scripts/build-exe.js 生成，请勿手改）
 * 双击后：把程序文件从 exe 里解到 %LOCALAPPDATA%\\SiErXing\\app，然后起服务、开浏览器。 */
const fs = require('fs'), path = require('path'), os = require('os'),
      zlib = require('zlib'), http = require('http');
const { execFileSync, spawn } = require('child_process');

/* 这个 exe 内嵌的载荷版本。构建时算好写死在这儿。 */
const EMBED_VER = ${JSON.stringify(ver)};
const EMBED_REL = ${JSON.stringify(REL)};

const PORT = Number(process.env.PORT) || 3213;
const BASE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'SiErXing');
const APP = path.join(BASE, 'app');
const MARK = path.join(APP, '.sx-current');     /* {rel, ver} 当前生效的载荷 */
const URL_ = 'http://localhost:' + PORT + '/';

function say(s) { try { console.log(s); } catch (e) {} }
function openBrowser() {
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', URL_], { stdio: 'ignore' });
    else if (process.platform === 'darwin') execFileSync('open', [URL_], { stdio: 'ignore' });
    else execFileSync('xdg-open', [URL_], { stdio: 'ignore' });
  } catch (e) {}
}
function sleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
function ping(cb) {
  const req = http.get(URL_ + 'api/health', { timeout: 1200 }, res => {
    let b = ''; res.on('data', d => { b += d; });
    res.on('end', () => cb(/思而行/.test(b)));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}
/* 版本比较：a 比 b 新返回正数。认 v1.2.3 / 1.2.3 / 1.2 这种写法。 */
function cmpVer(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.-]/).map(x => (parseInt(x, 10) || 0));
  const pb = String(b || '0').replace(/^v/i, '').split(/[.-]/).map(x => (parseInt(x, 10) || 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function readMark() {
  try { return JSON.parse(fs.readFileSync(MARK, 'utf8')) || {}; } catch (e) { return {}; }
}
function extract(arcBuf) {
  const raw = zlib.gunzipSync(arcBuf);
  if (raw.slice(0, 4).toString('ascii') !== 'SXA1') throw new Error('程序包已损坏');
  const hl = raw.readUInt32LE(4);
  const head = JSON.parse(raw.slice(8, 8 + hl).toString('utf8'));
  let off = 8 + hl;
  for (const f of head.files) {
    const out = path.join(APP, f.p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, raw.slice(off, off + f.size));
    off += f.size;
  }
  return head;
}
function unpackIfNeeded() {
  const cur = readMark();
  /* 关键：**版本号比较**，不是「不相等就解」。
     在线更新后本地会比 exe 内嵌的还新（exe 本身没换），
     若按"不相等"判断就会把旧的内嵌载荷又铺回去，把更新覆盖掉。 */
  if (cur.ver === EMBED_VER) return null;
  if (cur.rel && cmpVer(EMBED_REL, cur.rel) < 0) return 'ahead';
  say('');
  say('  首次运行，正在把程序文件释放到：');
  say('    ' + APP);
  say('  （用户数据留在 ' + path.join(APP, 'data') + '，升级不会丢）');
  say('');
  const asset = require('node:sea').getAsset('app');
  const head = extract(asset);
  fs.mkdirSync(APP, { recursive: true });
  /* 标记最后写：中途失败下次会重跑，不会用到半套文件 */
  fs.writeFileSync(MARK, JSON.stringify({ rel: head.rel || EMBED_REL, ver: head.ver || EMBED_VER }));
  say('  已释放 ' + head.files.length + ' 个文件。');
  return 'ok';
}
function banner() {
  const cur = readMark();
  say('');
  say('  ┌────────────────────────────────────────────┐');
  say('  │  思而行 SiErXing                           │');
  say('  └────────────────────────────────────────────┘');
  say('    界面地址  ' + URL_);
  say('    版本      ' + (cur.rel || EMBED_REL));
  say('    数据目录  ' + path.join(APP, 'data'));
  say('    停止服务  在这个黑窗口按 Ctrl + C');
  say('');
}
function boot() {
  let first = false;
  try {
    const r = unpackIfNeeded();
    if (r === 'ahead') say('');
    if (r !== 'ahead') { if (r === 'ok') first = true; }
  } catch (e) {
    say('✗ 释放程序文件失败：' + ((e && e.message) || e));
    say('  多半是 ' + BASE + ' 没有写入权限。可以试试把它整个删掉再运行。');
    process.exit(1);
  }
  if (!first) banner();
  process.chdir(APP);
  try {
    /* ⚠️ 必须用 node:module 的 createRequire，不能直接 require(绝对路径)。
       SEA 主脚本里的 require 是 embedderRequire，它会把绝对路径当成「内置模块名」，
       报 ERR_UNKNOWN_BUILTIN_MODULE。createRequire 造出来的就是普通 CJS require。 */
    const { createRequire } = require('node:module');
    createRequire(path.join(APP, 'package.json'))(path.join(APP, 'server', 'server.js'));
  } catch (e) {
    say('✗ 启动失败：' + ((e && e.message) || e));
    if (e && e.stack) say(e.stack);
    process.exit(1);
  }
}
/* SX_WAIT=1：被「立即重启」拉起的新实例。此时旧实例还占着端口，
   这里等它真正退出再起，否则新实例会 EADDRINUSE 自己把自己搞挂。 */
function bootWithWait() {
  const deadline = Date.now() + 30000;
  (function tryBoot() {
    ping(isMe => {
      if (isMe && Date.now() < deadline) { sleep(400); return tryBoot(); }
      boot();
    });
  })();
}
ping(isMe => {
  if (isMe) {
    say('思而行已经在运行了，直接打开：' + URL_);
    openBrowser();
    return;
  }
  if (process.env.SX_WAIT === '1') return bootWithWait();
  boot();
});
`;
}

/* ---------------- 4. 发布件（latest.json + payload） ---------------- */
function writeRelease(payloadBuf, ver, total) {
  fs.mkdirSync(RELEDIR, { recursive: true });
  const file = 'release/payload-' + REL + '.sxar';
  fs.writeFileSync(path.join(ROOT, file), payloadBuf);
  const manifest = {
    version: REL,
    buildVer: ver,
    payload: file,
    /* 用 AtomGit 的 contents 接口取：免鉴权、返回 base64，机器好读 */
    url: 'https://atomgit.com/api/v5/repos/' + REPO_PATH + '/contents/' + file + '?ref=main',
    manifestUrl: 'https://atomgit.com/api/v5/repos/' + REPO_PATH + '/contents/release/latest.json?ref=main',
    sha256: crypto.createHash('sha256').update(payloadBuf).digest('hex'),
    size: payloadBuf.length,
    unpackedSize: total,
    publishedAt: new Date().toISOString(),
    notes: NOTES || '见 CHANGELOG / 提交记录',
    /* 提示：程序文件变了才需要重下 exe；否则用户下次启动会自动跟进这个载荷 */
    exeRequired: false,
  };
  fs.writeFileSync(path.join(RELEDIR, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/* ---------------- 5. 下载并校验官方 node.exe ---------------- */
function downloadNode() {
  fs.mkdirSync(BUILDDIR, { recursive: true });
  const base = 'https://nodejs.org/dist/' + NODE_VER + '/';
  const zipName = 'node-' + NODE_VER + '-win-x64.zip';
  const zip = path.join(BUILDDIR, zipName);
  if (!fs.existsSync(zip)) {
    log('下载 ' + zipName + ' …');
    const r = spawnSync('curl', ['-fsSL', '-o', zip, base + zipName], { stdio: 'inherit' });
    if (r.status !== 0) die('下载失败（网络不通？）：' + base + zipName);
  }
  const sumsTxt = path.join(BUILDDIR, 'SHASUMS256.txt');
  if (spawnSync('curl', ['-fsSL', '-o', sumsTxt, base + 'SHASUMS256.txt'], { stdio: 'ignore' }).status !== 0) {
    die('下载 SHASUMS256.txt 失败');
  }
  const line = fs.readFileSync(sumsTxt, 'utf8').split('\n').find(l => l.trim().endsWith(zipName));
  if (!line) die('SHASUMS256.txt 里没有 ' + zipName);
  const want = line.trim().split(/\s+/)[0];
  const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (want !== got) die('sha256 不匹配，下载的文件可能坏了\n  期望 ' + want + '\n  实际 ' + got);
  log('sha256 校验通过');

  const exe = path.join(BUILDDIR, 'node.exe');
  fs.rmSync(exe, { force: true });
  if (!have('unzip')) die('需要 unzip 来解 node 官方 zip（构建机上装一下）');
  sh('unzip', ['-j', '-o', '-q', zip, '*/node.exe', '-d', BUILDDIR]);
  if (!fs.existsSync(exe)) die('zip 里没找到 node.exe');
  return exe;
}

/* ---------------- 6. 构建期工具（postject / resedit，都不进产物） ---------------- */
/** 只负责「装好并返回路径」。有些包（如 resedit）主入口是 ESM，require 会炸，
 *  交给调用方按它自己的方式加载。 */
function ensureTool(name) {
  const p = path.join(BUILDDIR, 'node_modules', name);
  if (!fs.existsSync(p)) {
    log('安装 ' + name + '（构建期工具，不进产物）…');
    fs.mkdirSync(BUILDDIR, { recursive: true });
    const r = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', BUILDDIR, name], { stdio: 'inherit' });
    if (r.status !== 0 || !fs.existsSync(p)) die(name + ' 安装失败（构建机需要能访问 npm）');
  }
  return p;
}
/** CJS 的包直接 require（如 postject） */
function getBuildTool(name) { return require(ensureTool(name)); }

/* ---------------- 7. 给 exe 换上图标 ----------------
   用的就是 public/icon.ico —— 和 Linux 桌面图标（service.js 建 .desktop 时引用的
   icon.svg / icon.png / icon.ico）是同一套源，所以任务栏、资源管理器、开始菜单
   看到的图标与桌面上一致。
   node.exe 自带的图标在 .rsrc 段里，要用 resedit 改写整份 PE 资源。四个注意点：
     · NtExecutable.from(bin, {ignoreCert:true})：node.exe 带 Authenticode 签名，
       不给这个参数会直接抛 "Parsing signed executable binary is not allowed"。
       反正 postject 注入时签名已失效，这里顺手清掉。
     · 传进去的必须是 new Uint8Array(buf)（byteOffset=0）。直接传 Buffer 有可能
       落在 Node 的内存池里、offset 不为 0，解析出来的 PE 全是错的。
     · outputResource(exe) 不返回值，最后要从 exe 上 generate() 拿字节。
     · **图标数据必须是 DIB，不能是 PNG**：.ico 文件允许内嵌 PNG，但 PE 的
       RT_ICON 资源只认 BITMAPINFOHEADER。把 .ico 里的 PNG 原样塞进去，Windows
       会当成坏资源 → 图标不显示。所以统一走 dibsOfIco() 转一道。 */
function setExeIcon(exePath) {
  const icoPath = path.join(ROOT, 'public', 'icon.ico');
  if (!fs.existsSync(icoPath)) { log('（没有 public/icon.ico，跳过换图标）'); return; }
  // resedit v3 主入口是 ESM，但自带 CJS 版；用 createRequire 从它的目录解析
  const dir = ensureTool('resedit');
  const R = require('module').createRequire(path.join(dir, 'x.js'))('resedit');
  const dibs = require('./png-ico-to-dib.js').dibsOfIco(fs.readFileSync(icoPath));
  const pe = R.NtExecutable.from(new Uint8Array(fs.readFileSync(exePath)), { ignoreCert: true });
  const res = R.NtExecutableResource.from(pe, true);
  const groups = res.entries.filter(e => e.type === 14);   // 14 = RT_GROUP_ICON
  const g = groups[0];
  // 沿用已有组的 id/lang，等于「替换」；没有就新建一个。
  // dibs 已经是 DIB，这里喂 resedit 的「非 IconItem」那条分支（isIcon() 返回假）。
  const items = dibs.map(d => ({ width: d.width, height: d.height, bitCount: 32, bin: d.bin, isIcon: () => false }));
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g ? g.id : 1, g ? g.lang : 1033, items);
  res.outputResource(pe);
  fs.writeFileSync(exePath, Buffer.from(pe.generate()));
  log('已换图标：' + dibs.length + ' 种尺寸（' + dibs.map(d => d.width).join('/') + '），已确保是 DIB 格式');

  /* 把 exe 里真正嵌的那张 256 图标导出成 PNG 放在旁边。
     原因：**GNOME 文件管理器不读 PE 图标**，只看共享 MIME 里的通用/wine 图标，
     所以在 Linux 上打开 dist 看到的图标跟 exe 嵌了什么毫无关系。
     导出这张图就是在本机核对「exe 里到底嵌了啥」的唯一办法。 */
  try {
    const big = dibs.reduce((a, b) => (b.width > (a ? a.width : 0) ? b : a), null);
    if (big) {
      const png = require('./png-ico-to-dib.js').dibToPng(big.bin);
      const out = exePath.replace(/\.exe$/i, '.icon.png');
      fs.writeFileSync(out, png);
      log('已导出实际嵌入的图标 → ' + path.basename(out) + '（' + big.width + 'x' + big.width + '，可直接打开核对）');
    }
  } catch (e) { log('（图标导出失败，不影响 exe：' + ((e && e.message) || e) + '）'); }
}

/* ---------------- main ---------------- */
function main() {
  log('发布版本 ' + REL + ' · Node ' + NODE_VER);
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.mkdirSync(BUILDDIR, { recursive: true });

  const files = collect();
  const packed = pack(files);
  log('运行时文件 ' + files.length + ' 个，原始 ' + (packed.total / 1024 / 1024).toFixed(2)
    + ' MB → 载荷 ' + (packed.buf.length / 1024).toFixed(0) + ' KB（内容哈希 ' + packed.ver + '）');

  const arcPath = path.join(BUILDDIR, 'payload.sxar');
  fs.writeFileSync(arcPath, packed.buf);

  const launcherPath = path.join(BUILDDIR, 'launcher.js');
  fs.writeFileSync(launcherPath, launcherSource(packed.ver));

  const man = writeRelease(packed.buf, packed.ver, packed.total);
  log('发布件已写入：');
  log('    release/latest.json');
  log('    ' + man.payload + '  (' + (man.size / 1024).toFixed(0) + ' KB)');
  log('  ↑ 提交并推送这两个文件，exe 用户下次启动就会自动跟进。');

  if (hasFlag('skip-exe')) { log('（--skip-exe：跳过 exe 构建）'); return; }

  const seaConfig = {
    main: launcherPath,
    output: path.join(BUILDDIR, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // 代码缓存（V8 code cache）在 SEA 里会跨机器失效，反而变成随机崩溃，必须关掉
    useCodeCache: false,
    assets: { app: arcPath },
  };
  fs.writeFileSync(path.join(BUILDDIR, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

  log('生成 SEA blob …');
  if (spawnSync(process.execPath, ['--experimental-sea-config', path.join(BUILDDIR, 'sea-config.json')], { stdio: 'inherit' }).status !== 0) {
    die('SEA blob 生成失败');
  }
  const blob = path.join(BUILDDIR, 'sea-prep.blob');
  if (!fs.existsSync(blob)) die('没有产出 sea-prep.blob');

  const nodeExe = downloadNode();
  const outExe = path.join(OUTDIR, OUT_NAME);
  fs.copyFileSync(nodeExe, outExe);
  log('注入 blob …');
  getBuildTool('postject').inject(outExe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });
  setExeIcon(outExe);

  log('');
  log('✓ 产出 ' + path.relative(ROOT, outExe) + '  ' + (fs.statSync(outExe).size / 1024 / 1024).toFixed(1) + ' MB');
  log('');
  log('注意：');
  log('  · 没做代码签名，Windows SmartScreen 会拦一下 ——');
  log('    「更多信息」→「仍要运行」，或把文件属性里勾上「解除锁定」。');
  log('  · 首次运行会把程序文件解到 %LOCALAPPDATA%\\SiErXing\\app（约 2MB），');
  log('    用户数据在其中的 data\\ 目录，升级不丢。');
  log('  · 有些杀毒软件对这种「把 Node 塞进 exe」的程序会误报，属常见误报。');
}

main();