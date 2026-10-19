/**
 * 思而行 · 数据存放位置（可改、可迁移）
 * ---------------------------------------------------------------------------
 * 为什么要这个：默认把 data/ 放在程序目录下，Windows 上 exe 装在 C 盘，
 * 目标信息源、上传的图片、作答记录、备份全堆在系统盘 —— 几十 G 起，
 * 而用户真正想放的地方往往是 D 盘或移动硬盘。
 *
 * 设计要点：
 * 1. 指针必须放在「程序目录」而不是数据目录里 —— 否则数据一挪，指针跟着挪，
 *    就找不到「数据在哪」了。故 APP_DIR/data-location.json 始终不动。
 * 2. 迁移分「复制 → 校验 → 切指针 → 再校验」四步，任何一步失败都不切指针，
 *    宁可留在原地也不能把用户数据弄丢。
 * 3. 切完指针要重启：DATA_DIR 在启动时被各模块（插件、同步、上传）按值捕获，
 *    热改这些引用不现实，也不该在运行中换数据库连接。所以明确告诉用户重启，
 *    并提供自动重启。
 * 4. 原生目录选择器用系统自带命令实现（PowerShell / osascript / zenity），
 *    不引任何 npm 依赖；都没有就退回手填路径。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const POINTER = 'data-location.json';
const RESERVE = 64 * 1024 * 1024;   // 目标盘至少要留这么多空间，不然不放心搬

/** 读指针（没有就用程序目录下的 data/） */
function readPointer(appDir) {
  /* 测试/多实例沙箱可用 SIERXING_DATA_DIR 临时覆盖；默认仍读 data-location.json。 */
  if (process.env.SIERXING_DATA_DIR) {
    const envDir = path.resolve(process.env.SIERXING_DATA_DIR);
    return { dir: envDir, custom: true, at: 'env' };
  }
  try {
    const raw = fs.readFileSync(path.join(appDir, POINTER), 'utf8');
    const v = JSON.parse(raw);
    if (v && typeof v.dir === 'string' && v.dir.trim()) {
      const dir = path.resolve(v.dir.trim());
      const dflt = path.join(appDir, 'data');
      // 指针指向的目录必须还在 —— 拔了移动硬盘就别把程序启动崩了
      if (!fs.existsSync(dir)) return { dir: dflt, custom: false, at: v.at || '', lost: dir };
      /* custom 的判据是「不是默认目录」，不是「指针文件在不在」——
         指向默认目录时也可能是自定义回去的，那就不该显示成自定义。 */
      return { dir, custom: dir !== dflt, at: v.at || '' };
    }
  } catch (e) {}
  return { dir: path.join(appDir, 'data'), custom: false, at: '' };
}
function writePointer(appDir, dir) {
  fs.writeFileSync(path.join(appDir, POINTER), JSON.stringify({ dir: path.resolve(dir), at: new Date().toISOString() }, null, 2), 'utf8');
}
function clearPointer(appDir) {
  try { fs.unlinkSync(path.join(appDir, POINTER)); } catch (e) {}
}

/** 目录占用统计（递归，跳过 symlink） */
function usage(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { bytes += fs.statSync(p).size; files++; } catch (err) {}
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** 目标目录能不能用：不存在会自动建；不可写/空间不够会带原因返回 */
function checkTarget(dir, needBytes) {
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: '路径必须是绝对路径' };
  const d = path.resolve(dir);
  // 不能选程序目录本身（会把代码和数据搅在一起），也不能选 data 的子目录
  if (d === path.parse(d).root) return { ok: false, error: '不能选磁盘根目录，请选一个专门的文件夹' };
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    return { ok: false, error: '建不了这个目录：' + (e.message || e) };
  }
  // 试写：只 mkdir 不代表可写（挂载点、权限、只读盘都可能）
  const probe = path.join(d, '.sx-write-test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch (e) {
    return { ok: false, error: '这个目录不可写（权限或只读）：' + (e.message || e) };
  }
  try {
    const st = fs.statfsSync ? fs.statfsSync(d) : null;
    if (st && needBytes && st.bavail * st.bsize < needBytes + RESERVE) {
      const free = Math.round((st.bavail * st.bsize) / 1024 / 1024 / 1024 * 10) / 10;
      const need = Math.round((needBytes + RESERVE) / 1024 / 1024 / 100) / 10;
      return { ok: false, error: '空间不够：需要约 ' + need + ' GB（含预留），实际只剩 ' + free + ' GB' };
    }
  } catch (e) { /* statfs 不可用就跳过这项检查 */ }
  return { ok: true, dir: d };
}

/* 迁移进度：几 GB 的复制要几十秒，前端得能显示到百分比和当前文件，
   否则就是干等一行字，用户会以为死机了。 */
let progress = { active: false, phase: '', copied: 0, total: 0, files: 0, doneFiles: 0, cur: '', startedAt: 0, error: '' };
function progReset(total) {
  progress = { active: true, phase: 'scan', copied: 0, total: total || 0, files: 0, doneFiles: 0, cur: '', startedAt: Date.now(), error: '' };
}
function progSet(patch) { Object.assign(progress, patch); }
function progEnd(err) { progress.active = false; progress.phase = err ? 'error' : 'done'; if (err) progress.error = String(err); }
function progSnapshot() {
  const el = progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0;
  const pct = progress.total ? Math.min(100, Math.round(progress.copied / progress.total * 100)) : 0;
  return { ...progress, elapsed: el, pct };
}

/** 复制整棵目录（先复制到临时名，全部成功后再改名，避免半途而废被当成成功） */
function copyTree(src, dst) {
  const tmp = dst + '.迁移中';
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(tmp, { recursive: true });
  const skip = new Set(['sierxing.db-journal', 'sierxing.db-wal', 'sierxing.db-shm']);
  let bytes = 0, files = 0;
  const skipped = [];
  progSet({ phase: 'copy' });
  const walk = (relSrc, relDst) => {
    const ents = fs.readdirSync(relSrc, { withFileTypes: true });
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const s = path.join(relSrc, e.name), t = path.join(relDst, e.name);
      if (skip.has(e.name)) continue;
      if (e.isDirectory()) { fs.mkdirSync(t, { recursive: true }); walk(s, t); }
      else {
        /* 读不了的文件（比如从 docker 里克隆出来的 root 权文件）就跳过并记下来，
           不能让一个无关的日志文件拦住整个 4GB 的迁移。数据库文件要是读不了，
           后面 verify 那一步会不通过，指针照样不切 —— 数据安全不受影响。 */
        try {
          fs.copyFileSync(s, t);
        } catch (err) {
          skipped.push({ file: path.relative(src, s), error: String((err && err.message) || err).slice(0, 120) });
          try { progSet({ cur: '跳过读不了的文件：' + path.relative(src, s) }); } catch (_) {}
          continue;
        }
        try { bytes += fs.statSync(s).size; } catch (err) {}
        files++;
        /* 每 8 个文件报一次进度：太密会把事件循环塞满，反而更慢 */
        if (files % 8 === 0) progSet({ copied: bytes, files, doneFiles: files, cur: path.relative(src, s) });
      }
    }
  };
  try {
    walk(src, tmp);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) {}
    throw e;
  }
  return { bytes, files, skipped };
}

/** 校验：目标里的库文件存在、行数能读出来、大小与源基本一致 */
function verify(srcDir, dstDir) {
  const dbName = 'sierxing.db';
  const s = path.join(srcDir, dbName), d = path.join(dstDir, dbName);
  if (!fs.existsSync(d)) return { ok: false, error: '目标目录里没有 sierxing.db —— 没搬成功' };
  const sSize = fs.existsSync(s) ? fs.statSync(s).size : 0;
  const dSize = fs.statSync(d).size;
  if (sSize && dSize < sSize * 0.98) {
    return { ok: false, error: '搬过去的数据库比原来小（' + dSize + ' < ' + sSize + ' 字节）—— 已放弃切换' };
  }
  try {
    /* 真开一次读，确认不是坏库；顺带核对关键表行数对得上 */
    const { DatabaseSync } = require('node:sqlite');
    const t = new DatabaseSync(d, { readOnly: true });
    const counts = {};
    for (const tb of ['goals', 'nodes', 'sources', 'problems', 'practice_records']) {
      try { counts[tb] = t.prepare('SELECT COUNT(*) n FROM ' + tb).get().n; } catch (e) { counts[tb] = -1; }
    }
    t.close();
    const t2 = new DatabaseSync(s, { readOnly: true });
    const src2 = {};
    for (const tb of ['goals', 'nodes', 'sources', 'problems', 'practice_records']) {
      try { src2[tb] = t2.prepare('SELECT COUNT(*) n FROM ' + tb).get().n; } catch (e) { src2[tb] = -1; }
    }
    t2.close();
    for (const tb of Object.keys(counts)) {
      if (counts[tb] >= 0 && src2[tb] >= 0 && counts[tb] !== src2[tb]) {
        return { ok: false, error: '表 ' + tb + ' 行数对不上（源 ' + src2[tb] + ' / 目标 ' + counts[tb] + '）—— 已放弃切换' };
      }
    }
    return { ok: true, bytes: dSize, counts };
  } catch (e) {
    return { ok: false, error: '搬过去的库打不开：' + (e.message || e) };
  }
}

/* ---------- 原生目录选择器（系统自带命令，零依赖） ---------- */
const PICK_FILE = path.join(os.tmpdir(), 'sx-dir-pick-' + process.pid + '.txt');
let picking = false;
function pickerCmd() {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms;' +
        ' $d=New-Object System.Windows.Forms.FolderBrowserDialog;' +
        ' $d.Description="选择思而行的数据存放文件夹";' +
        ' $d.ShowNewFolderButton=$true;' +
        ' if($d.ShowDialog() -eq "OK"){ [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath }'],
      readStdout: true
    };
  }
  if (process.platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "选择思而行的数据存放文件夹" with create directories)'],
      readStdout: true
    };
  }
  /* Linux/BSD：zenity 优先，其次 kdialog，都没有就交给调用方退手填 */
  return { file: 'sh', args: ['-c', 'command -v zenity >/dev/null 2>&1 && exec zenity --file-selection --directory --title="选择思而行的数据存放文件夹" || exec kdialog --getexistingdirectory . --title "选择思而行的数据存放文件夹"'], readStdout: true };
}
function canPick() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  for (const c of ['zenity', 'kdialog']) {
    try { execSyncQuiet('command -v ' + c); return true; } catch (e) {}
  }
  return false;
}
function execSyncQuiet(cmd) { require('node:child_process').execSync(cmd, { stdio: 'ignore' }); }
/** 异步拉起选择器；结果写到临时文件，前端轮询取 */
function startPick(title) {
  if (picking) return { ok: false, error: '已经有一个选择窗口开着了' };
  picking = true;
  try { fs.unlinkSync(PICK_FILE); } catch (e) {}
  const c = pickerCmd();
  const p = spawn(c.file, c.args, { stdio: ['ignore', 'pipe', 'ignore'], detached: false });
  let out = '';
  p.stdout.on('data', d => { out += d.toString('utf8'); });
  p.on('error', () => { picking = false; });
  p.on('close', code => {
    picking = false;
    const v = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (code === 0 && v && fs.existsSync(v)) {
      try { fs.writeFileSync(PICK_FILE, v, 'utf8'); } catch (e) {}
    } else {
      try { fs.writeFileSync(PICK_FILE, '', 'utf8'); } catch (e) {}   // 空 = 用户取消了
    }
  });
  return { ok: true };
}
/** 取选择结果（取过一次就清掉，避免下次误读） */
function takePick() {
  try {
    const v = fs.readFileSync(PICK_FILE, 'utf8').trim();
    try { fs.unlinkSync(PICK_FILE); } catch (e) {}
    return { done: true, chosen: v || '', canceled: !v };
  } catch (e) {
    return { done: picking ? false : true, chosen: '', canceled: false, pending: picking };
  }
}

/** 汇总一份给设置页看的现状 */
function status(appDir) {
  const ptr = readPointer(appDir);
  const u = usage(ptr.dir);
  let writable = true;
  try { fs.accessSync(ptr.dir, fs.constants.W_OK); } catch (e) { writable = false; }
  const home = os.homedir();
  return {
    dir: ptr.dir,
    custom: ptr.custom,
    at: ptr.at || '',
    lost: ptr.lost || '',
    appDir,
    dbPath: path.join(ptr.dir, 'sierxing.db'),
    bytes: u.bytes,
    files: u.files,
    writable,
    platform: process.platform,
    defaultDir: path.join(appDir, 'data'),
    inHome: home && ptr.dir.indexOf(home) === 0,
    canPick: canPick(),
    picking
  };
}

/**
 * 迁移：复制 → 校验 → 切指针
 * mode: 'move' = 搬过去并删掉原来的（默认）；'copy' = 复制一份，原处保留
 * 注意：删原目录是最后一步，且只在「校验通过 + 指针已切」之后做 ——
 * 出任何岔子都还能从原处拿回数据。
 */
function migrate(appDir, target, mode, opts) {
  const o = opts || {};
  const cur = readPointer(appDir);
  if (!fs.existsSync(cur.dir)) return { ok: false, error: '当前数据目录不存在：' + cur.dir };
  if (path.resolve(target) === path.resolve(cur.dir)) return { ok: false, error: '新的路径和现在一样，不用搬' };
  /* 不允许把数据搬进它自己的子目录（会无限套娃） */
  if (path.resolve(target).indexOf(path.resolve(cur.dir) + path.sep) === 0) {
    return { ok: false, error: '不能把数据搬到它自己的子目录里' };
  }
  const u = usage(cur.dir);
  const chk = checkTarget(target, u.bytes);
  if (!chk.ok) { progEnd(chk.error); return { ok: false, error: chk.error }; }

  progReset(u.bytes);
  let copied;
  try { copied = copyTree(cur.dir, chk.dir); }
  catch (e) { const msg = '复制失败：' + (e.message || e); progEnd(msg); return { ok: false, error: msg }; }
  progSet({ phase: 'verify' });
  const ver = verify(cur.dir, chk.dir);
  if (!ver.ok) {
    /* 校验不过就不切指针。目标目录留着让用户自己看一眼。 */
    progEnd(ver.error);
    return { ok: false, error: ver.error, keptAt: chk.dir };
  }
  /* 到这一步数据已经在新地方且校验过了，才切指针 */
  writePointer(appDir, chk.dir);
  if (mode === 'move' && !cur.custom) {
    progSet({ phase: 'cleanup' });
    /* 只在「原来就是默认目录」时才删 —— 用户自己指定过的目录不替他做主 */
    try { fs.rmSync(cur.dir, { recursive: true, force: true }); }
    catch (e) { /* 删不掉就算了，只是多占地方，位置保住了 */ }
  }
  progEnd('');
  void o;
  /* removedOld 必须复查：目录里要是有 root 权的文件（删不掉），
     就不能睁眼说删干净了 —— 如实告诉前端，免得用户以为腾出来了。 */
  const stillThere = fs.existsSync(cur.dir);
  return {
    ok: true, dir: chk.dir, moved: mode === 'move',
    removedOld: (mode === 'move' && !cur.custom) ? !stillThere : false,
    leftover: stillThere ? cur.dir : '',
    bytes: ver.bytes, files: copied.files, skipped: copied.skipped || [],
    counts: ver.counts, restartRequired: true
  };
}

/** 回到默认目录（同样是复制 + 校验；成功之后把指针删掉，
 *  而不是写一条「指向默认目录」的指针 —— 那会让 custom 一直显示成自定义。 */
function resetToDefault(appDir) {
  const dflt = path.join(appDir, 'data');
  const r = migrate(appDir, dflt, 'move');
  if (r.ok) { clearPointer(appDir); r.reset = true; }
  return r;
}
/** 只切指针、用那个目录里已有的数据（不搬） */
function useExisting(appDir, target) {
  const chk = checkTarget(target, 0);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!fs.existsSync(path.join(chk.dir, 'sierxing.db'))) {
    return { ok: false, error: '那个目录里没有 sierxing.db —— 它不是思而行的数据目录' };
  }
  writePointer(appDir, chk.dir);
  return { ok: true, dir: chk.dir, restartRequired: true };
}

module.exports = {
  POINTER, readPointer, status, migrate, resetToDefault, useExisting,
  startPick, takePick, canPick, usage, checkTarget, verify,
  progress: progSnapshot
};