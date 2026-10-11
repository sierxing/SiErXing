'use strict';
/**
 * 思而行 · 扩展组件：代码目录
 * ------------------------------------------------------------------
 * 一个节点对应一个文件夹，子目录嵌在父目录下，整棵导图镜像整棵目录树；
 * 建节点的同时自动创建对应目录（改名不搬家，目录稳定可找回）；
 * 教程页一键在 VSCode 中打开当前节点目录、边看教程边写代码；
 * 学完可一键打包整个目标的代码目录（零依赖自带 zip 打包，各平台可解压）。
 */
const { execFile, spawn } = require('node:child_process');

let db, sendJSON, nowISO, getGoal, DATA_DIR, APP_DIR, path, fs;
function bind(ctx) {
  ({ db, sendJSON, nowISO, getGoal, DATA_DIR, APP_DIR, path, fs } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_workspaces (
  node_id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const WS_MAX_BYTES = 800 * 1024 * 1024;

function wsRoot() {
  const r = path.join(DATA_DIR, 'workspaces');
  fs.mkdirSync(r, { recursive: true });
  return r;
}
/* 文件名安全段：去掉各平台非法字符 */
function wsSeg(title) {
  return String(title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名';
}
/* 限制在工作区内，防止路径逃逸 */
function wsAbs(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('非法目录');
  return abs;
}
/* 确保节点目录存在（含整条父链），返回绝对路径；已映射过的沿用旧路径 */
function wsEnsure(goalId, nodeId) {
  const root = wsRoot();
  const hit = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(nodeId);
  if (hit && hit.path) {
    const abs = wsAbs(root, hit.path);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }
  const chain = [];
  let cur = db.prepare('SELECT id, goal_id, parent_id, title FROM nodes WHERE id = ?').get(nodeId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_id ? db.prepare('SELECT id, goal_id, parent_id, title FROM nodes WHERE id = ?').get(cur.parent_id) : null;
  }
  if (!chain.length) throw new Error('节点不存在');
  const gid = chain[0].goal_id || goalId;
  let rel = 'goal-' + gid, abs = wsAbs(root, rel);
  fs.mkdirSync(abs, { recursive: true });
  const t = nowISO();
  for (const n of chain) {
    const m = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(n.id);
    if (m && m.path) {
      rel = m.path;
      abs = wsAbs(root, rel);
      fs.mkdirSync(abs, { recursive: true });
      continue;
    }
    const base = wsSeg(n.title);
    let name = base, k = 2;
    while (fs.existsSync(path.join(abs, name))) name = base + '(' + (k++) + ')';
    rel = rel + '/' + name;
    abs = wsAbs(root, rel);
    fs.mkdirSync(abs, { recursive: true });
    db.prepare('INSERT OR REPLACE INTO node_workspaces (node_id, goal_id, path, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(n.id, n.goal_id || gid, rel, t, t);
  }
  return abs;
}
/* 目标下所有节点补齐目录（打包前调用，老节点也能纳入镜像） */
function wsReconcileGoal(goalId) {
  const rows = db.prepare('SELECT id FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
  for (const r of rows) {
    try { wsEnsure(goalId, r.id); } catch (e) { console.error('[workspace] 补建目录失败:', r.id, e.message); }
  }
}
function wsStat(abs) {
  let files = 0, bytes = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(p).size; } catch (err) {}
        if (files > 20000 || bytes > WS_MAX_BYTES) return;
      }
    }
  };
  walk(abs);
  return { files, bytes };
}
function wsFindCode() {
  const cands = process.platform === 'win32' ? ['code.cmd', 'code'] : ['code'];
  if (process.platform === 'darwin') {
    // macOS 上 VSCode 的 code 命令经常不在 PATH 里，加上自带路径兜底
    cands.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
    try {
      const home = require('node:os').homedir();
      if (home) cands.push(path.join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'));
    } catch (e) {}
  }
  return (async () => {
    for (const c of cands) {
      try {
        await new Promise((res, rej) => execFile(c, ['--version'], { timeout: 8000 }, e => (e ? rej(e) : res())));
        return c;
      } catch (e) {}
    }
    return null;
  })();
}
/* 最小 zip 打包器（STORE 模式、无压缩、零依赖，各平台自带解压都能打开） */
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function dosTime(d) {
  const t = d || new Date();
  return ((t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1)) & 0xFFFF;
}
function dosDate(d) {
  const t = d || new Date();
  return (((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()) & 0xFFFF;
}
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = s => Buffer.from(s, 'utf8');
  for (const f of files) {
    const name = enc(f.name);
    const data = f.data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034B50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(dosTime(), 10);
    head.writeUInt16LE(dosDate(), 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    chunks.push(head, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014B50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime(), 12);
    c.writeUInt16LE(dosDate(), 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    for (const [o, v] of [[30, 0], [32, 0], [34, 0], [36, 0], [38, 0], [40, 0]]) c.writeUInt16LE(v, o);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}
function wsCollect(abs, base) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        let data = null;
        try {
          const st = fs.statSync(p);
          if (st.size > 100 * 1024 * 1024) continue;
          data = fs.readFileSync(p);
        } catch (err) { continue; }
        out.push({ name: r, data });
      }
      if (out.length > 20000) return;
    }
  };
  walk(abs, base || '');
  return out;
}

module.exports = {
  /* 给产出库打包复用：零依赖 zip 生成器（STORE 模式，各平台自带解压都能打开） */
  buildZip,

  id: 'workspace',
  name: '代码目录',
  icon: '📁',
  category: '其它',
  desc: '一个节点对应一个文件夹（子目录嵌在父目录下）：建节点自动建目录，教程页一键用 VSCode 打开边学边写，学完一键打包',
  order: 42,
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/workspace.js',

  /** 建表（宿主启动时调用一次） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  /** 建节点时同步建目录（由宿主 insertNode 统一回调，失败不影响建节点） */
  onNodeCreated(goalId, nodeId, ctx) {
    try { wsEnsure(goalId, nodeId); } catch (e) { console.error('[workspace] 建目录失败:', e.message); }
  },

  /** 目标被删除时清理映射（用户文件保留在磁盘，只删映射记录） */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM node_workspaces WHERE goal_id = ?').run(goalId);
  },

  /** 导出/导入/清空（设置页 JSON 备份与恢复时携带目录映射；文件本身不进备份，导入后按映射自动补建空目录） */
  exportData(ctx) {
    try { return ctx.db.prepare('SELECT * FROM node_workspaces ORDER BY node_id').all(); }
    catch (e) { return []; }
  },
  importData(rows, ctx) {
    try {
      ctx.db.prepare('DELETE FROM node_workspaces').run();
      if (!Array.isArray(rows)) return;
      const stmt = ctx.db.prepare('INSERT OR REPLACE INTO node_workspaces (node_id, goal_id, path, created_at, updated_at) VALUES (?,?,?,?,?)');
      for (const r of rows) {
        if (!r || !r.node_id || !r.path) continue;
        stmt.run(Number(r.node_id), Number(r.goal_id) || 0, String(r.path), String(r.created_at || ''), String(r.updated_at || ''));
      }
    } catch (e) { console.error('[workspace] 导入映射失败:', e.message); }
  },
  clearAll(ctx) {
    try { ctx.db.prepare('DELETE FROM node_workspaces').run(); } catch (e) {}
  },

  api: [
    {
      // 项目源码只读清单（给教程"结合源码"用）：可见范围由 code-read 硬黑名单决定
      method: 'GET',
      pattern: /^\/api\/code\/files$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/code\/files$/);
        if (!m || req.method !== 'GET') return false;
        try {
          const { listCodeFiles } = require('../code-read.js');
          return sendJSON(res, 200, { files: listCodeFiles(APP_DIR) });
        } catch (e) {
          return sendJSON(res, 500, { error: '列取失败：' + e.message });
        }
      }
    },
    {
      method: 'GET',
      pattern: /^\/api\/nodes\/(\d+)\/workspace$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/nodes\/(\d+)\/workspace$/);
        if (!m) return false;
        const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(m[1]));
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        const row = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(n.id);
        const root = wsRoot();
        const abs = row && row.path ? wsAbs(root, row.path) : null;
        const st = abs && fs.existsSync(abs) ? wsStat(abs) : { files: 0, bytes: 0 };
        return sendJSON(res, 200, {
          exists: !!(abs && fs.existsSync(abs)),
          path: row && row.path ? String(row.path).split(path.sep).join('/') : '',
          files: st.files, bytes: st.bytes
        });
      }
    },
    {
      method: 'POST',
      pattern: /^\/api\/nodes\/(\d+)\/workspace\/open$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/nodes\/(\d+)\/workspace\/open$/);
        if (!m) return false;
        const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(m[1]));
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        let dir = '';
        try {
          dir = wsEnsure(n.goal_id, n.id);
        } catch (e) {
          return sendJSON(res, 500, { error: '创建目录失败：' + e.message });
        }
        const bin = await wsFindCode();
        if (!bin) return sendJSON(res, 500, { error: '未检测到 VSCode（需要先安装，并在终端能运行 code --version），目录已建好：' + path.relative(wsRoot(), dir).split(path.sep).join('/') });
        try {
          const child = spawn(bin, [dir], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
          child.unref();
          child.on('error', () => {});
        } catch (e) {
          return sendJSON(res, 500, { error: '启动 VSCode 失败：' + e.message });
        }
        return sendJSON(res, 200, { ok: true, path: path.relative(wsRoot(), dir).split(path.sep).join('/') });
      }
    },
    {
      method: 'GET',
      pattern: /^\/api\/goals\/(\d+)\/workspace\/export$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/goals\/(\d+)\/workspace\/export$/);
        if (!m) return false;
        const g = (typeof getGoal === 'function' ? getGoal(Number(m[1])) : null) || db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(m[1]));
        if (!g) return sendJSON(res, 404, { error: '目标不存在' });
        wsReconcileGoal(g.id);
        const root = wsRoot();
        const abs = wsAbs(root, 'goal-' + g.id);
        const files = wsCollect(abs, 'goal-' + g.id);
        const total = files.reduce((a, f) => a + f.data.length, 0);
        if (total > WS_MAX_BYTES) return sendJSON(res, 400, { error: '代码目录过大（超过 800MB），请先清理后再打包' });
        const zip = buildZip(files);
        const safeTitle = String(g.title || '代码').replace(/[\\/:*?"<>|\r\n]/g, '').slice(0, 30) || '代码';
        const fname = encodeURIComponent('代码-' + safeTitle + '.zip');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': "attachment; filename=\"code.zip\"; filename*=UTF-8''" + fname
        });
        return res.end(zip);
      }
    }
  ]
};
