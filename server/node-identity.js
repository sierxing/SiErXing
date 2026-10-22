'use strict';
/**
 * 思而行 · 节点身份延续（换树后把「按 node_id 挂的东西」搬回新 id）
 * ------------------------------------------------------------------
 * 背景：切方案 / 恢复历史版本 = 整棵 nodes 删掉再从快照重插，节点 id 全部换新。
 * 但后面这些东西都是按 node_id 挂的：
 *   tutorials（教程）、tutorial_progress（读到哪里）、tutorial_bookmarks（划线）、
 *   node_notes（节点笔记）、study_records / study_segments（学习记录）、
 *   quiz_sessions（随堂测验）、explain_sessions（看懂代码）、
 *   restate_rounds（复述）、chat_sessions（节点对话）、
 *   task_runs（任务中心历史）、node_workspaces（代码目录）。
 * 换树前不搬，它们就全成了孤儿：数据还在库里、正文一个字没少，但节点面板/页面全看不到
 * —— 用户看到的就是「我原来目标下的教程全没了」（2026-10-21 真实翻车）。
 *
 * 做法（只搬 id，不碰内容）：
 *  1. 换树前把旧树建成「节点 id → 标题路径（阶段 / 小目标 / 任务）」索引；
 *  2. 换完树以后：同一个快照里的节点用「旧 id → 新 id」精确映射；
 *     教程可能指向更早的树（那批 id 早就不在快照里了），再用「标题路径」从历史版本
 *     里把它的身份认回来 —— 只要这一步改动前后标题路径没变，就认得回来；
 *  3. 代码目录：`node_workspaces` 的行**换树时不删**（它就是每个方案的目录档案），
 *     插入新节点后立刻按旧 id 把目录认回来；认回来之前会确认旧目录确实在新父目录下，
 *     免得计划结构变了以后目录树错位。换树建出来又没认领的空目录会清掉。
 *
 * 认不回来的（节点在更早之前就被删掉了）原样保留成孤儿，只报数，不删数据。
 *
 * 依赖注入：db / DATA_DIR（可缺省，缺省时不动代码目录）
 */
const path = require('node:path');
const fs = require('node:fs');

/* 按 node_id 挂的表：rebind 时逐张搬。列缺失的库会自动跳过。 */
const NODE_KEYED_TABLES = [
  'tutorials', 'tutorial_progress', 'tutorial_bookmarks', 'node_notes',
  'study_records', 'study_segments', 'restate_rounds', 'quiz_sessions',
  'explain_sessions', 'chat_sessions', 'task_runs', 'interview_sessions'
];
const SNAPSHOT_SCAN_MAX = 400;     // 兜底认身份时最多翻这么多历史版本（防老库很重）

function createNodeIdentity(opts) {
  const db = opts.db;
  const DATA_DIR = opts.DATA_DIR || '';
  const log = opts.log || function () {};
  const safeParse = opts.safeParse || function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };

  const wsRoot = () => (DATA_DIR ? path.join(DATA_DIR, 'workspaces') : '');
  const wsAbs = rel => { const r = wsRoot(); return r ? path.join(r, String(rel || '')) : ''; };
  const dirExists = rel => { if (!rel) return false; try { return fs.statSync(wsAbs(rel)).isDirectory(); } catch (e) { return false; } };

  function rowsOf(gid) { return db.prepare('SELECT id, parent_id, title, level, sort_order FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(gid); }
  function wsPathOf(nodeId) {
    try { const r = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(Number(nodeId)); return r ? String(r.path || '') : ''; } catch (e) { return ''; }
  }
  function titlePath(node, byId) {
    const parts = []; let c = node, guard = 0;
    while (c && guard++ < 16) { parts.unshift(String(c.title || '').trim()); c = c.parent_id ? byId.get(Number(c.parent_id)) : null; }
    return parts.join(' / ');
  }

  /** 当前树的索引：id→行、id→标题路径、标题路径→id（路径重复的不收，免得认错人） */
  function index(gid) {
    const rows = rowsOf(gid);
    const byId = new Map(rows.map(function (n) { return [Number(n.id), n]; }));
    const pathById = new Map();
    const byPath = new Map();
    const dup = new Set();
    for (const n of rows) {
      const p = titlePath(n, byId);
      pathById.set(Number(n.id), p);
      if (byPath.has(p)) { dup.add(p); continue; }
      byPath.set(p, Number(n.id));
    }
    for (const p of dup) byPath.delete(p);
    return { rows: rows, byId: byId, pathById: pathById, byPath: byPath, pathOf: id => pathById.get(Number(id)) || '' };
  }

  /** 换树前的代码目录槽位：node_id → workspaces 下的相对路径（保留全部方案的档案行） */
  function slots(gid) {
    const m = new Map();
    try {
      for (const r of db.prepare('SELECT node_id, path FROM node_workspaces WHERE goal_id = ?').all(gid)) m.set(Number(r.node_id), String(r.path || ''));
    } catch (e) {}
    return m;
  }

  /** 兜底身份池：从历史版本快照里翻「旧 id → 标题路径」，只翻还没认出来的 id */
  function historicalPaths(gid, needIds, before) {
    const pool = new Map();
    if (before) for (const [id, p] of before.pathById) pool.set(Number(id), p);
    const need = new Set([...needIds].filter(id => !pool.has(Number(id))));
    if (!need.size) return pool;
    let rows = [];
    try { rows = db.prepare('SELECT snapshot FROM goal_versions WHERE goal_id = ? ORDER BY id DESC LIMIT ' + SNAPSHOT_SCAN_MAX).all(gid); } catch (e) { return pool; }
    for (const v of rows) {
      const snap = safeParse(v.snapshot);
      if (!Array.isArray(snap) || !snap.length) continue;
      const byId = new Map(snap.map(function (n) { return [Number(n.id), n]; }));
      for (const n of snap) {
        const id = Number(n.id);
        if (!need.has(id) || pool.has(id)) continue;
        pool.set(id, titlePath(n, byId));
        need.delete(id);
      }
      if (!need.size) break;
    }
    return pool;
  }

  /* ---------- 换树过程中的状态 ---------- */
  let state = null;

  /** plan-ops 删旧树之前调用：记下旧树索引 + 代码目录档案 */
  function begin(gid, before) {
    state = {
      gid: gid,
      before: before || index(gid),
      slots: slots(gid),
      touchedDirs: new Set(),      // 换树时新建成、可能待回滚的目录
      relinked: 0
    };
    return state;
  }

  /**
   * 换树之后调用：把 NODE_KEYED_TABLES 里还指着旧 id 的行搬到新 id。
   * @param {number} gid
   * @param {Array<{oldId:number,newId:number}>} nodeRows 快照旧 id → 新 id 的精确映射
   */
  function rebind(gid, nodeRows) {
    const cur = index(gid);
    const conv = new Map();
    for (const r of (nodeRows || [])) conv.set(Number(r.oldId), Number(r.newId));
    const curIds = new Set(cur.byId.keys());
    const pending = [];
    const needIds = new Set();
    for (const t of NODE_KEYED_TABLES) {
      let hasCol = false;
      try { hasCol = db.prepare('PRAGMA table_info(' + t + ')').all().some(function (c) { return c.name === 'node_id'; }); } catch (e) { hasCol = false; }
      if (!hasCol) continue;
      let rows = [];
      try { rows = db.prepare('SELECT rowid AS rid, node_id FROM ' + t + ' WHERE goal_id = ?').all(gid); } catch (e) { continue; }
      for (const r of rows) {
        const oid = Number(r.node_id);
        if (!oid || curIds.has(oid)) continue;
        pending.push({ table: t, rid: r.rid, oldId: oid });
        if (!conv.has(oid)) needIds.add(oid);
      }
    }
    const pool = historicalPaths(gid, needIds, state && state.before);
    const stats = { moved: {}, unresolved: 0, totalMoved: 0 };
    for (const p of pending) {
      let nid = conv.get(p.oldId) || 0;
      if (!nid) {
        const titlePath = pool.get(p.oldId) || '';
        if (titlePath) nid = cur.byPath.get(titlePath) || 0;
      }
      if (!nid) { stats.unresolved++; continue; }
      try { db.prepare('UPDATE ' + p.table + ' SET node_id = ? WHERE rowid = ?').run(nid, p.rid); } catch (e) { stats.unresolved++; continue; }
      stats.moved[p.table] = (stats.moved[p.table] || 0) + 1;
      stats.totalMoved++;
    }
    return stats;
  }

  /**
   * 给某个刚插入的新节点认回旧代码目录。
   * 只在「旧目录还在磁盘上，且确实挂在同一个新父目录下」时才认，
   * 否则保留 insertNode 刚建的新目录（计划结构改了，目录树不能错位）。
   */
  function applyWorkspace(gid, newId, oldId) {
    if (!state) return 0;
    const oldPath = state.slots.get(Number(oldId)) || '';
    if (!oldPath || !dirExists(oldPath)) return 0;
    const newNode = db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(Number(newId));
    const parentPath = newNode && newNode.parent_id ? wsPathOf(newNode.parent_id) : ('goal-' + gid);
    if (parentPath && !oldPath.startsWith(parentPath + '/')) return 0;   // 父目录已经变了：不认，避免目录错位
    const nowPath = wsPathOf(newId);
    if (nowPath === oldPath) return 0;
    const t = new Date().toISOString();
    try {
      db.prepare('INSERT OR REPLACE INTO node_workspaces (node_id, goal_id, path, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(Number(newId), gid, oldPath, t, t);
    } catch (e) { return 0; }
    if (nowPath) state.touchedDirs.add(nowPath);
    state.relinked++;
    return 1;
  }

  /**
   * 换树结束：
   *  1. 清掉换树时建出来、又没被认领的空目录（有文件的一律不动）；
   *  2. 清掉「不指向任何存活节点、也不属于任何方案快照」的孤儿目录档案行
   *     （磁盘目录保留，只是不再挂到某个节点上）。
   */
  function end() {
    if (!state) return { removedDirs: 0, prunedRows: 0 };
    let removedDirs = 0;
    const dirs = [...state.touchedDirs].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const rel of dirs) {
      const abs = wsAbs(rel);
      if (!abs || !dirExists(rel)) continue;
      try { fs.rmdirSync(abs); removedDirs++; } catch (e) { /* 非空或没权限：留着 */ }
    }
    /* 归档行清理：哪些 node_id 还被历史版本 / 方案快照引用（引用着就留着，
       以便用户以后从版本恢复时还能认回原来的目录） */
    const keep = new Set();
    try {
      for (const v of db.prepare('SELECT snapshot FROM goal_versions WHERE goal_id = ? ORDER BY id DESC LIMIT ' + SNAPSHOT_SCAN_MAX).all(state.gid)) {
        for (const n of safeParse(v.snapshot)) keep.add(Number(n.id));
      }
    } catch (e) {}
    let prunedRows = 0;
    try {
      const live = new Set(db.prepare('SELECT id FROM nodes WHERE goal_id = ?').all(state.gid).map(function (r) { return Number(r.id); }));
      for (const r of db.prepare('SELECT node_id FROM node_workspaces WHERE goal_id = ?').all(state.gid)) {
        const id = Number(r.node_id);
        if (live.has(id) || keep.has(id)) continue;
        db.prepare('DELETE FROM node_workspaces WHERE node_id = ? AND goal_id = ?').run(id, state.gid);
        prunedRows++;
      }
    } catch (e) {}
    const out = { removedDirs: removedDirs, prunedRows: prunedRows, relinked: state.relinked };
    state = null;
    return out;
  }

  return { index: index, slots: slots, begin: begin, rebind: rebind, applyWorkspace: applyWorkspace, end: end, titlePath: titlePath, wsPathOf: wsPathOf };
}

module.exports = { createNodeIdentity: createNodeIdentity, NODE_KEYED_TABLES: NODE_KEYED_TABLES };
