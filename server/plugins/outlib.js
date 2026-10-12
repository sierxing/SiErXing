'use strict';
/**
 * 思而行 · 产出库（outlib）
 * ------------------------------------------------------------------
 * 用户推进一个目标时会产生各种产出：简历、作品、笔记、导出报告、代码、图……
 * 产出库就是这些产出的家：**每个目标一个独立产出库**，用户手动添加，
 * 用「文件夹 + 文件」的目录树管理 —— 能对真实目录做的事，这里都能做。
 *
 * 设计要点：
 * - 目录结构只落数据库（parent_id / name / kind），文件本体按 id 存成
 *   DATA_DIR/outlib-files/ 下的 blob。**改名、移动、排序只改库、不搬文件**，
 *   所以大文件也能秒改，且绝不会出现"改名后文件打不开"。
 * - 每个目标的产出彻底隔离（goal_id + 独立 blob 前缀），删目标连文件一起清。
 * - 文件内容不进 Git 同步与 JSON 备份（同一台设备上原地读写就有意义，
 *   跨设备互相覆盖反而会拿到别人的文件）；目录结构跟着走，方便重建。
 * - 目录路径由服务端按 parent_id 现算，前端只传 id —— 天然免疫路径逃逸。
 */
const { buildZip } = require('./workspace');

let db, sendJSON, nowISO, getGoal, safeParse, DATA_DIR, path, fs, log;
function bind(ctx) {
  ({ db, sendJSON, nowISO, getGoal, safeParse, DATA_DIR, path, fs, log } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outlib_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'file',
  name TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  batch TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outlib_parent ON outlib_nodes(goal_id, parent_id, sort_order, id);`;

const MAX_DEPTH = 16;          // 目录层级上限，防手滑套太深
const MAX_FILE = 200 * 1024 * 1024;
const UPLOAD_LIMIT = 210 * 1024 * 1024;   // 比单文件上限略宽，留给 base64 与多文件

/* ---------- 基础工具 ---------- */
function olRoot() {
  const r = path.join(DATA_DIR, 'outlib-files');
  fs.mkdirSync(r, { recursive: true });
  return r;
}
function olBlob(file) {
  const abs = path.resolve(olRoot(), String(file || ''));
  if (abs !== olRoot() && !abs.startsWith(olRoot() + path.sep)) throw new Error('非法文件');
  return abs;
}
/* 名字安全段：去掉各平台非法字符，超长截断，空则兜底 */
function olSeg(name) {
  const s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return s || '未命名';
}
function olRow(id) {
  return db.prepare('SELECT * FROM outlib_nodes WHERE id = ?').get(Number(id)) || null;
}
/* 从该节点一路走到根，返回 [根...自身]；跨目标/成环/过深都算非法 */
function olChain(id) {
  const chain = [];
  let cur = olRow(id);
  let guard = 0;
  while (cur) {
    chain.unshift(cur);
    if (++guard > 64) throw new Error('目录层级异常');
    cur = cur.parent_id ? olRow(cur.parent_id) : null;
  }
  if (!chain.length) throw new Error('条目不存在');
  if (chain.some(c => Number(c.goal_id) !== Number(chain[0].goal_id))) throw new Error('跨目标操作被拒绝');
  if (chain.length > MAX_DEPTH) throw new Error('目录层级过深（最多 ' + MAX_DEPTH + ' 层）');
  return chain;
}
/* 该目标下某文件夹的直接子节点 */
function olChildren(goalId, parentId) {
  return db.prepare('SELECT * FROM outlib_nodes WHERE goal_id = ? AND parent_id = ? ORDER BY sort_order, id').all(Number(goalId), Number(parentId) || 0);
}
/* 目标下全部节点（客户端自己拼树） */
function olAll(goalId) {
  /* 必须带上 file 并走 olPublic：前端要靠 has_file 判断"这条打不开"，
     而 has_file 是在 olPublic 里现算的。少 SELECT 一个 file，整条就废了。 */
  return db.prepare('SELECT id, goal_id, parent_id, kind, name, file, size, mime, sort_order, created_at, updated_at FROM outlib_nodes WHERE goal_id = ? ORDER BY sort_order, id')
    .all(Number(goalId)).map(olPublic).filter(Boolean);
}
/* 同目录内去重：xxx、xxx(2)、xxx(3) */
function olUnique(goalId, parentId, name, exceptId) {
  const base = olSeg(name);
  const sibs = olChildren(goalId, parentId).filter(r => r.id !== Number(exceptId || 0));
  if (!sibs.some(r => r.name === base)) return base;
  let k = 2;
  for (;;) {
    const cand = base + '(' + (k++) + ')';
    if (!sibs.some(r => r.name === cand)) return cand;
  }
}
/* 某文件夹（含自身）下所有后代 id，用于递归删除 */
function olDescendants(id) {
  const out = [];
  const walk = pid => {
    for (const c of db.prepare('SELECT id FROM outlib_nodes WHERE parent_id = ? AND id != ?').all(Number(pid), Number(id))) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}
/* 展示用路径：产出 / 简历 / 终版.docx */
function olPathOf(row) {
  try {
    return olChain(row.id).map(c => c.name).join(' / ');
  } catch (e) {
    return row.name;
  }
}
function olSortNext(goalId, parentId) {
  const r = db.prepare('SELECT MAX(sort_order) AS m FROM outlib_nodes WHERE goal_id = ? AND parent_id = ?').get(Number(goalId), Number(parentId) || 0);
  return (r && r.m ? r.m : 0) + 1000;
}
function olMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const m = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.zip': 'application/zip', '.gz': 'application/gzip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
    '.java': 'text/plain; charset=utf-8', '.c': 'text/plain; charset=utf-8', '.cpp': 'text/plain; charset=utf-8',
    '.go': 'text/plain; charset=utf-8', '.rs': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook'
  };
  return m[ext] || '';
}
/* 文本类（可直接在内嵌预览里看） */
function olPreviewable(mime) {
  return /^text\/|^image\/|^audio\/|^video\/|^application\/(json|pdf)/.test(String(mime || ''));
}

/* 读原始 body（核心 readBody 只收 JSON 且限 20MB，这里要收大文件） */
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('文件过大（超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req, maxBytes) {
  const buf = await readRaw(req, maxBytes || UPLOAD_LIMIT);
  const t = buf.toString('utf8');
  if (!t.trim()) return {};
  return JSON.parse(t);
}
function olJson(res, code, obj) {
  try { return sendJSON(res, code, obj); } catch (e) { /* sendJSON 不可用时的兜底 */ }
}
/* 目标兜底：拿不到就明确报错，别把文件挂到 0 号目标上 */
function olGoal(id) {
  const gid = Number(id || 0);
  if (!gid) throw new Error('缺少目标');
  const g = (typeof getGoal === 'function' ? getGoal(gid) : null) || (db ? db.prepare('SELECT * FROM goals WHERE id = ?').get(gid) : null);
  if (!g) throw new Error('目标不存在');
  return Number(g.id);
}

/* ---------- 落地动作 ---------- */
/* 校验「往哪个文件夹里放」：必须是目录、属于同一目标、层级没超 */
function olAssertParent(pid, gid) {
  if (!pid) return;
  const p = olRow(pid);
  if (!p) throw new Error('目标文件夹不存在');
  if (p.kind !== 'dir') throw new Error('只能放进文件夹里');
  if (Number(p.goal_id) !== Number(gid)) throw new Error('不能操作其它目标的文件夹');
  olChain(pid);
}

/* 按相对路径逐级「新建」文件夹，返回末级 id。
   拖文件夹进来时靠它把整棵子树的目录结构还原出来。
   刻意**不复用**同名目录：每次拖入都独立成新文件夹（同名则 xxx(2)、xxx(3)…），
   避免第二次拖入把第一次的内容搅在一起。 */
function olEnsureDirPath(goalId, parentId, rel, batch) {
  const gid = Number(goalId);
  let pid = Number(parentId || 0);
  const segs = String(rel || '').split('/').filter(Boolean);
  for (const raw of segs) {
    if (raw === '.' || raw === '..') throw new Error('非法路径');
    pid = olCreate(gid, pid, 'dir', olSeg(raw), {}, '', batch).id;
  }
  return pid;
}

function olMkdir(goalId, parentId, name) {
  const gid = olGoal(goalId);
  const pid = Number(parentId || 0);
  olAssertParent(pid, gid);
  return olCreate(gid, pid, 'dir', name, {}, '');
}
/* 统一落库入口：返回新建行 */
function olCreate(goalId, parentId, kind, name, fileInfo, blobName, batch) {
  const gid = Number(goalId), pid = Number(parentId || 0);
  /* 同一次拖入（同一 batch）内的同名目录**直接复用已有那一行**，
     否则一个文件夹里的文件会被拆进一批同名的空目录里；
     不同批次则各自独立新建，重名自动变成 xxx(2)。 */
  if (batch && kind === 'dir') {
    const hit = db.prepare("SELECT id FROM outlib_nodes WHERE goal_id = ? AND parent_id = ? AND kind = 'dir' AND batch = ? ORDER BY id LIMIT 1").get(gid, pid, String(batch));
    if (hit) return olRow(hit.id);
  }
  const uniq = olUnique(gid, pid, name);
  const t = nowISO();
  const info = db.prepare(
    'INSERT INTO outlib_nodes (goal_id, parent_id, kind, name, file, size, mime, sort_order, batch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(gid, pid, kind, uniq, String(blobName || ''), Number(fileInfo.size || 0), String(fileInfo.mime || ''), olSortNext(gid, pid), String(batch || ''), t, t);
  return olRow(info.lastInsertRowid);
}
function olWriteBlob(name, buf) {
  const safe = 'f' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + path.extname(olSeg(name)).toLowerCase().slice(0, 12);
  fs.mkdirSync(olRoot(), { recursive: true });
  fs.writeFileSync(olBlob(safe), buf);
  return safe;
}
function olUnlink(blobName) {
  if (!blobName) return;
  try { fs.unlinkSync(olBlob(blobName)); } catch (e) {}
}
/* 收集某节点下的所有文件行（目录时递归），name 为库里的展示名 */
/* 收集某节点下所有文件行；name 是**相对于该节点的库内路径**，
   前缀由调用方决定（打包时拼在最外层），避免目录名重复出现 */
function olCollectFiles(row, prefix) {
  const out = [];
  const walk = (r, pre) => {
    if (r.kind !== 'dir') { out.push({ row: r, name: pre + r.name }); return; }
    for (const c of olChildren(r.goal_id, r.id)) walk(c, pre + r.name + '/');
  };
  if (row.kind === 'dir') {
    const pre = String(prefix || '');
    for (const c of olChildren(row.goal_id, row.id)) walk(c, pre);
  } else {
    out.push({ row, name: String(prefix || '') + row.name });
  }
  return out;
}
function olZipBlob(rows, zipName) {
  const files = [];
  for (const it of rows) {
    const r = it.row || it;
    if (!r || !r.file) continue;
    try {
      const abs = olBlob(r.file);
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) continue;
      files.push({ name: zipName + '/' + (it.name || r.name), data: fs.readFileSync(abs) });
    } catch (e) { console.error('[outlib] 打包跳过:', r.name, e.message); }
  }
  return buildZip(files);
}

module.exports = {
  id: 'outlib',
  name: '产出库',
  icon: '📦',
  desc: '每个目标一个独立产出库：手动添加推进过程中产生的各种文件，用文件夹目录树管理，能对真实目录做的事这里都能做',
  category: '核心组件',
  order: 20,
  scope: 'core',            // 内置且不可关闭（侧边栏常驻入口）
  goalToggle: false,        // 应用级：页面内自选目标，不占目标级开关
  removable: false,
  defaultEnabled: true,
  client: '/plugins/outlib.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
    /* 老库补列：CREATE TABLE IF NOT EXISTS 只对新建的库生效，
       已存在的 outlib_nodes 表不会有 batch 列（写法同 server.js 的迁移）。 */
    const cols = db.prepare('PRAGMA table_info(outlib_nodes)').all().map(c => c.name);
    if (!cols.includes('batch')) db.exec("ALTER TABLE outlib_nodes ADD COLUMN batch TEXT NOT NULL DEFAULT '';");
  },

  /* 目标删除：连目录结构和文件本体一起清（用户明确删了目标，产出也该没） */
  onGoalDelete(goalId, ctx) {
    try {
      const rows = ctx.db.prepare('SELECT id, file FROM outlib_nodes WHERE goal_id = ?').all(Number(goalId) || 0);
      for (const r of rows) { if (r.file) { try { ctx.fs.unlinkSync(olBlob(r.file)); } catch (e) {} } }
      ctx.db.prepare('DELETE FROM outlib_nodes WHERE goal_id = ?').run(Number(goalId) || 0);
    } catch (e) { (ctx.log || log || console.error)('[outlib] 清理目标产出失败:', e.message); }
  },

  /* 备份只带目录结构：文件本体太大且与设备绑定，链路见文件头说明。
     ⚠️ 但 `file` 这一列必须带上 —— 它是 blob 的文件名。以前这里不 SELECT 它、
     importData 又往回写 '' ，于是"恢复一次备份"就把所有产出文件的指针清空：
     条目还在、点开全是 404。多端同步走的是 SELECT * 所以没中招，
     但同一个坑埋在这儿，备份一恢复就踩。 */
  exportData(ctx) {
    try {
      return ctx.db.prepare('SELECT id, goal_id, parent_id, kind, name, file, size, mime, sort_order, created_at, updated_at FROM outlib_nodes ORDER BY id').all();
    } catch (e) { return []; }
  },
  importData(rows, ctx) {
    try {
      ctx.db.prepare('DELETE FROM outlib_nodes').run();
      if (!Array.isArray(rows)) return;
      const st = ctx.db.prepare('INSERT INTO outlib_nodes (id, goal_id, parent_id, kind, name, file, size, mime, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const r of rows) {
        if (!r || !r.id || !r.goal_id || !r.name) continue;
        /* file 是 blob 文件名。备份文件是可以被手改的，只放行安全字符，
           别让一个 "../../.." 顺着它读出 data 目录外的东西。 */
        const file = String(r.file == null ? '' : r.file).replace(/[^A-Za-z0-9._-]/g, '');
        st.run(Number(r.id), Number(r.goal_id), Number(r.parent_id || 0), r.kind === 'dir' ? 'dir' : 'file',
          String(r.name).slice(0, 80), file, Number(r.size || 0), String(r.mime || ''), Number(r.sort_order || 0),
          String(r.created_at || ''), String(r.updated_at || ''));
      }
    } catch (e) { (ctx.log || log || console.error)('[outlib] 导入结构失败:', e.message); }
  },
  clearAll(ctx) {
    try { ctx.db.prepare('DELETE FROM outlib_nodes').run(); } catch (e) {}
  },

  api: [
    /* ---- 列表：某目标全部节点（客户端自己拼树） ---- */
    {
      method: 'GET',
      pattern: /^\/api\/outlib\/nodes\/(\d+)$/,
      handler: async (req, res, u) => {
        const gid = olGoal(Number(u.pathname.match(/^\/api\/outlib\/nodes\/(\d+)$/)[1]));
        return olJson(res, 200, { goal_id: gid, nodes: olAll(gid) });
      }
    },
    /* ---- 各目标产出数量（目标切换器上显示「产出 N」） ---- */
    {
      method: 'GET',
      path: '/api/outlib/summary',
      handler: async (req, res) => {
        const rows = db.prepare('SELECT goal_id, kind, COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM outlib_nodes GROUP BY goal_id, kind').all();
        const map = {};
        for (const r of rows) {
          const m = map[r.goal_id] || (map[r.goal_id] = { files: 0, dirs: 0, bytes: 0 });
          if (r.kind === 'dir') m.dirs = r.c; else { m.files = r.c; m.bytes = r.s; }
        }
        return olJson(res, 200, { summary: map });
      }
    },

    /* ---- 新建文件夹 ---- */
    {
      method: 'POST',
      path: '/api/outlib/dir',
      handler: async (req, res) => {
        const b = await readJSONBody(req, 1 * 1024 * 1024);
        const row = olMkdir(b.goal_id, b.parent_id, b.name);
        return olJson(res, 200, { ok: true, node: olPublic(row) });
      }
    },
    /* ---- 上传文件（可一次多个；name + base64 data + 可选 rel 相对目录） ----
       拖文件夹进来时每个文件带自己的 rel（如 "截图/子图/a.png"），
       服务端据此逐级还原目录结构，而不是把所有文件平铺到一处。 */
    {
      method: 'POST',
      path: '/api/outlib/files',
      handler: async (req, res) => {
        const b = await readJSONBody(req, UPLOAD_LIMIT);
        const gid = olGoal(b.goal_id);
        const pid = Number(b.parent_id || 0);
        olAssertParent(pid, gid);
        const list = Array.isArray(b.files) ? b.files : (b.file ? [b.file] : []);
        if (!list.length) throw new Error('没有要上传的文件');
        /* 一次拖入 = 一个批次号：批次内的同名目录互相复用，批次之间各自独立 */
        const batch = String(b.batch || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))).slice(0, 40);
        const done = [];
        for (const f of list) {
          const name = olSeg(f.name);
          if (!name) throw new Error('文件名不能为空');
          const m = String(f.data || '').match(/^data:[^;,]*(;base64)?,(.*)$/);
          let buf;
          if (m && m[1]) buf = Buffer.from(m[2], 'base64');
          else if (m && !m[1]) buf = Buffer.from(decodeURIComponent(m[2]), 'utf8');
          else buf = Buffer.from(String(f.data || ''), 'base64');
          if (!buf.length) throw new Error('「' + name + '」内容为空');
          if (buf.length > MAX_FILE) throw new Error('「' + name + '」超过 ' + Math.round(MAX_FILE / 1024 / 1024) + 'MB 上限');
          const target = olEnsureDirPath(gid, pid, f.rel, batch);
          const blob = olWriteBlob(name, buf);
          const mime = String(f.mime || '').slice(0, 120) || olMime(name);
          const row = olCreate(gid, target, 'file', name, { size: buf.length, mime }, blob);
          done.push(olPublic(row));
        }
        return olJson(res, 200, { ok: true, added: done });
      }
    },
    /* ---- 重命名 ---- */
    {
      method: 'POST',
      path: '/api/outlib/rename',
      handler: async (req, res) => {
        const b = await readJSONBody(req, 1 * 1024 * 1024);
        const row = olRow(b.id);
        if (!row) throw new Error('条目不存在');
        const name = String(b.name == null ? '' : b.name).trim();
        if (!name) throw new Error('名字不能为空');
        const uniq = olUnique(row.goal_id, row.parent_id, name, row.id);
        db.prepare('UPDATE outlib_nodes SET name = ?, updated_at = ? WHERE id = ?').run(uniq, nowISO(), row.id);
        return olJson(res, 200, { ok: true, node: olPublic(olRow(row.id)) });
      }
    },
    /* ---- 移动（含改排序：to 为空数组时只移动到目标目录末尾） ---- */
    {
      method: 'POST',
      path: '/api/outlib/move',
      handler: async (req, res) => {
        const b = await readJSONBody(req, 1 * 1024 * 1024);
        const row = olRow(b.id);
        if (!row) throw new Error('条目不存在');
        const pid = Number(b.parent_id || 0);
        if (pid) {
          const target = olRow(pid);
          if (!target) throw new Error('目标文件夹不存在');
          if (target.kind !== 'dir') throw new Error('只能移进文件夹');
          /* 目标文件夹必须和被移动的条目属于同一个目标，否则就是跨目标乱挂 */
          if (Number(target.goal_id) !== Number(row.goal_id)) throw new Error('不能把条目移到别的目标的文件夹里');
          olChain(pid);                       // 层级校验
          if (row.kind === 'dir' && (target.id === row.id || olDescendants(row.id).includes(target.id))) {
            throw new Error('不能把文件夹移进它自己（或它的子目录）里');
          }
        }
        db.prepare('UPDATE outlib_nodes SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?')
          .run(pid, olSortNext(row.goal_id, pid), nowISO(), row.id);
        return olJson(res, 200, { ok: true, node: olPublic(olRow(row.id)) });
      }
    },
    /* ---- 同目录内拖拽排序 ---- */
    {
      method: 'POST',
      path: '/api/outlib/order',
      handler: async (req, res) => {
        const b = await readJSONBody(req, 1 * 1024 * 1024);
        const pid = Number(b.parent_id || 0);
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean);
        if (!ids.length) throw new Error('没有要排序的条目');
        const anchor = pid ? olRow(pid) : null;
        if (!anchor && pid) throw new Error('目标文件夹不存在');
        const goalId = anchor ? anchor.goal_id : (olRow(ids[0]) || {}).goal_id;
        const upd = db.prepare('UPDATE outlib_nodes SET sort_order = ?, updated_at = ? WHERE id = ? AND parent_id = ?');
        ids.forEach((id, i) => upd.run((i + 1) * 1000, nowISO(), id, pid));
        return olJson(res, 200, { ok: true, goal_id: goalId });
      }
    },
    /* ---- 删除（目录递归删；文件本体一起删） ---- */
    {
      method: 'POST',
      path: '/api/outlib/delete',
      handler: async (req, res) => {
        const b = await readJSONBody(req, 1 * 1024 * 1024);
        const row = olRow(b.id);
        if (!row) throw new Error('条目不存在');
        const ids = [row.id, ...olDescendants(row.id)];
        const sel = db.prepare('SELECT file FROM outlib_nodes WHERE id = ?');
        const del = db.prepare('DELETE FROM outlib_nodes WHERE id = ?');
        for (const id of ids) {
          const r = sel.get(id);
          if (r && r.file) olUnlink(r.file);
          del.run(id);
        }
        return olJson(res, 200, { ok: true, removed: ids.length });
      }
    },

    /* ---- 下载单个文件（inline=1 时内嵌预览） ---- */
    {
      method: 'GET',
      pattern: /^\/api\/outlib\/dl\/(\d+)$/,
      handler: async (req, res, u) => {
        const row = olRow(u.pathname.match(/^\/api\/outlib\/dl\/(\d+)$/)[1]);
        if (!row || row.kind === 'dir') { res.writeHead(404); return res.end('not found'); }
        let buf;
        try { buf = fs.readFileSync(olBlob(row.file)); }
        catch (e) {
          /* 以前这里直接 404，界面上就是"点了没反应/下载失败"，
             用户完全不知道是文件没同步过来。给一句能照着做的话。 */
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: '文件本体没在这台设备上（多半是多端同步没把它带过来，或文件已在本机删除）。'
              + '在产出库里右键删除这条记录，或到「设置 → 多端同步」点「立即上传」把本机文件补传上去。'
          }));
        }
        const mime = row.mime || olMime(row.name) || 'application/octet-stream';
        const inline = u.searchParams && u.searchParams.get('inline') === '1' && olPreviewable(mime);
        const fname = encodeURIComponent(row.name);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          'Content-Disposition': (inline ? 'inline' : "attachment; filename=\"file\"; filename*=UTF-8''" + fname)
        });
        return res.end(buf);
      }
    },
    /* ---- 打包下载：文件夹（id）或整个目标产出库（goal/<gid>） ---- */
    {
      method: 'GET',
      pattern: /^\/api\/outlib\/zip\/(\d+)$/,
      handler: async (req, res, u) => {
        const row = olRow(u.pathname.match(/^\/api\/outlib\/zip\/(\d+)$/)[1]);
        if (!row) { res.writeHead(404); return res.end('not found'); }
        const base = olSeg(row.name);
        const rows = row.kind === 'dir' ? olCollectFiles(row, '') : [{ row, name: row.name }];
        if (!rows.length) return olJson(res, 400, { error: '这个文件夹是空的，没有可打包的内容' });
        const zip = olZipBlob(rows, base);
        const fname = encodeURIComponent(base + '.zip');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': "attachment; filename=\"outlib.zip\"; filename*=UTF-8''" + fname
        });
        return res.end(zip);
      }
    },
    {
      method: 'GET',
      pattern: /^\/api\/outlib\/zip\/goal\/(\d+)$/,
      handler: async (req, res, u) => {
        const gid = olGoal(Number(u.pathname.match(/^\/api\/outlib\/zip\/goal\/(\d+)$/)[1]));
        const g = db.prepare('SELECT title FROM goals WHERE id = ?').get(gid) || { title: '产出' };
        const zipPrefix = olSeg('产出-' + (g.title || gid));
        const rows = [];
        for (const c of olChildren(gid, 0)) {
          if (c.kind === 'dir') rows.push(...olCollectFiles(c, c.name + '/'));
          else rows.push({ row: c, name: c.name });
        }
        if (!rows.length) return olJson(res, 400, { error: '这个目标的产出库还是空的' });
        const zip = olZipBlob(rows, zipPrefix);
        const fname = encodeURIComponent('产出-' + olSeg(g.title || gid) + '.zip');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': "attachment; filename=\"outlib.zip\"; filename*=UTF-8''" + fname
        });
        return res.end(zip);
      }
    }
  ]
};

/* 对外只暴露安全字段（file 是服务端 blob 名，绝不给前端） */
function olPublic(row) {
  if (!row) return null;
  const o = {
    id: row.id, goal_id: row.goal_id, parent_id: row.parent_id, kind: row.kind,
    name: row.name, size: row.size, mime: row.mime, sort_order: row.sort_order,
    created_at: row.created_at, updated_at: row.updated_at
  };
  /* 本机有没有这个文件的本体。多端同步只保证传得动 20MB 以内的，
     更大的、或者在别的设备上被删掉的，目录结构会过来而文件不会 ——
     与其让用户点下去吃一个 404，不如在列表上就标出来。 */
  if (row.kind === 'file') {
    let ok = false;
    if (row.file) { try { ok = fs.statSync(olBlob(row.file)).isFile(); } catch (e) { ok = false; } }
    o.has_file = ok;
  }
  return o;
}
