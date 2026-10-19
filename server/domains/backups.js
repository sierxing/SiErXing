'use strict';
/**
 * 思而行 · 备份领域（从 server.js 抽出）
 * ------------------------------------------------------------------
 * 只负责：备份文件列表 / 创建备份 / 裁剪保留份数 / 两份备份的差异摘要。
 * 依赖注入：dbPath、backupDir、getSetting、nowStamp、onDataChange。
 * 不认识 HTTP、不认识 Agent、不 require server.js。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const KEEP_BACKUPS = 30; // 默认保留份数（用户可在设置里改）

/* 备份对比：只比「用户看得懂」的核心表，噪音表（分块/向量/统计）不比。
   主键不统一，所以每张表显式指定主键与「代表性字段」用于生成人类可读的摘要。 */
const BK_DIFF_TABLES = [
  { t: 'goals', pk: 'id', label: '目标', title: 'title' },
  { t: 'nodes', pk: 'id', label: '节点', title: 'title' },
  { t: 'sources', pk: 'id', label: '信息源', title: 'title' },
  { t: 'outlib_nodes', pk: 'id', label: '产出', title: 'name' },
  { t: 'tutorials', pk: 'id', label: '教程', title: 'title' },
  { t: 'quiz_records', pk: 'id', label: '测验记录', title: 'point' },
  { t: 'interview_sessions', pk: 'id', label: '模拟面试', title: 'title' },
  { t: 'chats', pk: 'id', label: '对话', title: 'content' },
  { t: 'settings', pk: 'key', label: '设置', title: 'key' },
  { t: 'problems', pk: 'id', label: '刷题', title: 'title' },
  { t: 'restate_points', pk: 'tutorial_id', label: '用自己的话', title: 'points' }
];

function createBackupDomain(opts) {
  const dbPath = opts.dbPath;
  const backupDir = opts.backupDir;
  const getSetting = opts.getSetting || function () { return ''; };
  const nowStamp = opts.nowStamp || function () {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const onDataChange = opts.onDataChange || function () {};

  /** 实际要保留的份数：设置项 backup_keep 可覆盖，非法值回落默认 */
  function keepBackups() {
    const n = parseInt(getSetting('backup_keep', ''), 10);
    return (n >= 1 && n <= 500) ? n : KEEP_BACKUPS;
  }
  /** 列出现有备份（新的在前）：{name, time, size} */
  function backupList() {
    let names = [];
    try { names = fs.readdirSync(backupDir).filter(function (f) { return /^sierxing-[0-9]{8}-[0-9]{6}\.db$/.test(f); }); } catch (e) { return []; }
    names.sort().reverse();
    return names.map(function (n) {
      let size = 0, time = '';
      try { const st = fs.statSync(path.join(backupDir, n)); size = st.size; time = st.mtime.toISOString(); } catch (e) {}
      return { name: n, size: size, time: time };
    });
  }
  /** 按当前保留份数裁掉最旧的 */
  function pruneBackups() {
    const keep = keepBackups();
    let files = [];
    try { files = fs.readdirSync(backupDir).filter(function (f) { return f.startsWith('sierxing-'); }).sort(); } catch (e) { return; }
    while (files.length > keep) { try { fs.unlinkSync(path.join(backupDir, files.shift())); } catch (e) {} }
  }
  function bkOpen(name) {
    const f = path.join(backupDir, name);
    if (!/^sierxing-[0-9]{8}-[0-9]{6}\.db$/.test(name)) throw new Error('备份名不合法');
    if (!fs.existsSync(f)) throw new Error('这份备份已经不在了');
    return new DatabaseSync(f, { readOnly: true });
  }
  function bkShort(v) {
    v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return v.length > 40 ? v.slice(0, 40) + '…' : v;
  }
  /** 比较两份备份：返回 {from,to,items:[{table,label,added,removed,changed,samples}]} */
  function backupDiff(fromName, toName) {
    const A = bkOpen(fromName), B = bkOpen(toName);
    const items = [];
    try {
      for (const cfg of BK_DIFF_TABLES) {
        const has = function (d) { try { return !!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(cfg.t); } catch (e) { return false; } };
        if (!has(A) || !has(B)) continue;
        const ra = A.prepare('SELECT * FROM ' + cfg.t).all();
        const rb = B.prepare('SELECT * FROM ' + cfg.t).all();
        const key = function (r) { return String(r[cfg.pk]); };
        const ma = new Map(ra.map(function (r) { return [key(r), r]; }));
        const mb = new Map(rb.map(function (r) { return [key(r), r]; }));
        let added = 0, removed = 0, changed = 0;
        const samples = [];
        for (const entry of mb) {
          const k = entry[0], rbw = entry[1];
          const rao = ma.get(k);
          if (!rao) { added++; if (samples.length < 5) samples.push({ type: 'add', text: bkShort(rbw[cfg.title]) }); continue; }
          if (JSON.stringify(rao) !== JSON.stringify(rbw)) {
            changed++;
            if (samples.length < 5) {
              const before = bkShort(rao[cfg.title]), after = bkShort(rbw[cfg.title]);
              samples.push({ type: 'edit', text: before === after ? after : before + ' → ' + after });
            }
          }
        }
        for (const k of ma.keys()) {
          if (!mb.has(k)) { removed++; if (samples.length < 5) samples.push({ type: 'del', text: bkShort(ma.get(k)[cfg.title]) }); }
        }
        if (added || removed || changed) items.push({ table: cfg.t, label: cfg.label, added: added, removed: removed, changed: changed, samples: samples });
      }
    } finally {
      try { A.close(); } catch (e) {}
      try { B.close(); } catch (e) {}
    }
    return { from: fromName, to: toName, items: items };
  }
  function backup() {
    try { onDataChange(); } catch (e) {}
    // 注：数据库用 DELETE journal 模式（单文件，无 WAL 旁文件），
    // 历史上 WAL 旁文件曾被外部删掉导致读写分裂，已不再用 WAL。
    try {
      fs.copyFileSync(dbPath, path.join(backupDir, 'sierxing-' + nowStamp() + '.db'));
      pruneBackups();
    } catch (e) { console.error('备份失败:', e.message); }
  }
  return { keepBackups: keepBackups, backupList: backupList, pruneBackups: pruneBackups, backupDiff: backupDiff, backup: backup };
}

module.exports = { createBackupDomain: createBackupDomain, KEEP_BACKUPS: KEEP_BACKUPS, BK_DIFF_TABLES: BK_DIFF_TABLES };
