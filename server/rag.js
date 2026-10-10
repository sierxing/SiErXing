'use strict';
/**
 * 思而行 · 检索增强（RAG）：把「资源库 / 信息源」当知识库用
 * ------------------------------------------------------------------
 * 为什么要有它：资料一多（几十上百条），把「前 N 条」整段塞进提示词既浪费
 * 又抓不住重点；规划时应该按当前问题去知识库里**检索**最相关的片段。
 *
 * 机制（零第三方依赖）：
 *   1. 入库：把每条资料的正文切成 750 字左右的小块存进 source_chunks（带内容哈希，
 *      资料变了自动重建）；哈希不需要向量模型，纯本地。
 *   2. 向量：配置了「向量模型」（OpenAI 兼容 /embeddings）时，后台任务批量把小块
 *      向量化，存为归一化 Float32 的 base64；换模型会自动按新模型重嵌。
 *   3. 检索：查询时算 余弦相似度（有向量的块）+ 关键词打分（所有块）取较大值合并 ——
 *      所以**没配向量模型也能用**（退化为词面检索），配置与否都不影响正确性。
 *   4. 注入：server.js 的 libraryBlock() / ragAugment() 把命中片段拼进提示词。
 *
 * 安全/成本：只读本地数据；向量走用户自己配置的接口；单块约 750 字，
 * 一次检索只发一条查询向量（成本极小）。索引是可再生的派生数据 ——
 * 不进 SYNC_TABLES（同 code_repo_files 的理由）。
 */
const crypto = require('node:crypto');
const ai = require('./ai');

let ctx = null;   // { db, tasks, nowISO, getSetting, log }
const CHUNK_CHARS = 750;
const CHUNK_OVERLAP = 80;
const MAX_CHUNKS_PER_SOURCE = 80;   // 单条资料最多切多少块（约 5.6 万字，防异常大文本）
const EMB_BATCH = 16;               // 一次 /embeddings 请求带多少块
const MAX_SCAN_CHUNKS = 4000;       // 单目标一次检索最多扫描多少块

function init(c) { ctx = c; }
const log = m => { try { (ctx && ctx.log ? ctx.log : console.log)('[rag] ' + m); } catch (e) {} };

/* ---------------- 分块 ---------------- */
function chunkText(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const paras = t.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const push = () => { const s = cur.trim(); if (s) out.push(s); cur = ''; };
  for (const p of paras) {
    if (p.length > CHUNK_CHARS * 1.6) {
      push();
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        out.push(p.slice(i, i + CHUNK_CHARS));
        if (out.length >= MAX_CHUNKS_PER_SOURCE) return out;
      }
      continue;
    }
    if (cur && cur.length + p.length + 2 > CHUNK_CHARS) {
      const tail = cur.slice(-CHUNK_OVERLAP);
      push();
      cur = tail + '\n' + p;
    } else {
      cur += (cur ? '\n\n' : '') + p;
    }
    if (out.length >= MAX_CHUNKS_PER_SOURCE) break;
  }
  push();
  return out.slice(0, MAX_CHUNKS_PER_SOURCE);
}
const srcHash = s => crypto.createHash('sha1').update(String((s && s.content) || '') + '\u0000' + String((s && s.snippet) || '')).digest('hex').slice(0, 16);

/* 让 source_chunks 与 sources 保持一致（纯本地、便宜；规划/检索前调用即可）。
   返回 { rebuilt, removed }。 */
function ensureChunks(goalId) {
  const db = ctx.db;
  const srcs = db.prepare('SELECT id, content, snippet FROM sources WHERE goal_id = ?').all(goalId);
  const have = db.prepare('SELECT source_id, src_hash FROM source_chunks WHERE goal_id = ? GROUP BY source_id, src_hash').all(goalId);
  const haveMap = {};
  for (const h of have) haveMap[h.source_id + ':' + h.src_hash] = true;
  const ids = new Set(srcs.map(s => s.id));
  let rebuilt = 0, removed = 0;
  for (const s of srcs) {
    const h = srcHash(s);
    if (haveMap[s.id + ':' + h]) continue;   // 已有且内容没变
    db.prepare('DELETE FROM source_chunks WHERE source_id = ?').run(s.id);
    const text = String(s.content || s.snippet || '');
    const chunks = chunkText(text);
    const ins = db.prepare('INSERT INTO source_chunks (goal_id, source_id, seq, text, src_hash, vec, dim, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    const now = ctx.nowISO();
    chunks.forEach((c, i) => ins.run(goalId, s.id, i, c, h, '', 0, '', now));
    rebuilt++;
  }
  /* 清理已删除资料的块 */
  const all = db.prepare('SELECT DISTINCT source_id FROM source_chunks WHERE goal_id = ?').all(goalId);
  for (const r of all) {
    if (!ids.has(r.source_id)) { removed += db.prepare('DELETE FROM source_chunks WHERE source_id = ?').run(r.source_id).changes ? 1 : 0; }
  }
  return { rebuilt, removed };
}
function dropSource(sourceId) { try { ctx.db.prepare('DELETE FROM source_chunks WHERE source_id = ?').run(Number(sourceId)); } catch (e) {} }
function dropGoal(goalId) { try { ctx.db.prepare('DELETE FROM source_chunks WHERE goal_id = ?').run(Number(goalId)); } catch (e) {} }
function dropAll() { try { ctx.db.exec('DELETE FROM source_chunks;'); } catch (e) {} }

/* ---------------- 向量 ---------------- */
function encodeVec(arr) {
  const f = new Float32Array(arr.length);
  let n = 0;
  for (let i = 0; i < arr.length; i++) { f[i] = Number(arr[i]) || 0; n += f[i] * f[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;   // 归一化：检索时点积即余弦
  return Buffer.from(f.buffer).toString('base64');
}
function decodeVec(b64) {
  try { const b = Buffer.from(String(b64), 'base64'); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)); } catch (e) { return null; }
}
function dot(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/* ---------------- 关键词打分（词面兜底 / 与向量取较大值） ---------------- */
function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of s.match(/[a-z0-9][a-z0-9_.\/_-]{2,}/g) || []) out.add(m);
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    if (out.size > 80) break;
  }
  return Array.from(out).slice(0, 60);
}
function lexicalScores(rows, query) {
  const tokens = tokensOf(query);
  const scores = new Array(rows.length).fill(0);
  if (!tokens.length) return scores;
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const hay = (rows[i].text + ' ' + (rows[i].title || '')).toLowerCase();
    let s = 0;
    for (const t of tokens) {
      const c = hay.split(t).length - 1;
      if (c > 0) s += Math.min(c, 4) * (t.length >= 3 ? 2 : 1);
    }
    scores[i] = s;
    if (s > max) max = s;
  }
  if (max > 0) for (let i = 0; i < scores.length; i++) scores[i] = scores[i] / max;
  return scores;
}

/* ---------------- 检索 ---------------- */
async function search(goalId, query, opts) {
  const o = opts || {};
  const k = o.k || 10;
  ensureChunks(goalId);
  const rows = ctx.db.prepare(`SELECT c.id, c.source_id, c.text, c.vec, c.model, s.title, s.site, s.kind, s.quality
    FROM source_chunks c JOIN sources s ON s.id = c.source_id
    WHERE c.goal_id = ? LIMIT ${MAX_SCAN_CHUNKS}`).all(goalId);
  if (!rows.length) return [];
  const lex = lexicalScores(rows, query);
  let qv = null;
  const cfg = ai.embConfig();
  if (cfg.configured && rows.some(r => r.vec)) {
    try {
      const v = await ai.embedTexts([String(query || '').slice(0, 2000)]);
      qv = v && v[0] ? (() => { const arr = new Float32Array(v[0].length); let n = 0; for (let i = 0; i < v[0].length; i++) { arr[i] = Number(v[0][i]) || 0; n += arr[i] * arr[i]; } n = Math.sqrt(n) || 1; for (let i = 0; i < arr.length; i++) arr[i] /= n; return arr; })() : null;
    } catch (e) { log('查询向量失败，用关键词兜底：' + e.message); }
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let sem = 0;
    if (qv && rows[i].vec && (!rows[i].model || rows[i].model === cfg.model)) {
      const dv = decodeVec(rows[i].vec);
      if (dv && dv.length === qv.length) sem = Math.max(0, dot(qv, dv));
    }
    const score = Math.max(sem * 1.05, lex[i]);   // 语义略优先；没有向量的块走词面
    if (score > 0.02) out.push({ ...rows[i], score, sem, lex: lex[i] });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/** 拼给提示词用的检索结果块；未启用 / 没命中时返回 '' */
async function block(goal, query, opts) {
  const o = opts || {};
  if ((ctx.getSetting('rag_enabled', '1') || '1') === '0') return '';
  let hits = [];
  try { hits = await search(goal.id, query, { k: o.k || 10 }); } catch (e) { log('检索失败：' + e.message); return ''; }
  if (!hits.length) return '';
  const total = ctx.db.prepare('SELECT COUNT(*) n FROM sources WHERE goal_id = ?').get(goal.id).n;
  const seen = new Set();
  const lines = ['', `【资料库检索结果（从 ${total} 条资料里按当前问题检索出的最相关片段；优先于通用常识）】`];
  lines.push('使用要求：① 用户自己提供的资料与★优质信息源优先级最高，与常识冲突时以它们为准；② 引用时在 sources 里写明来源标题；③ 与当前问题无关的片段不要用。');
  let shown = 0;
  for (const h of hits) {
    if (shown >= (o.max || 10)) break;
    const body = String(h.text || '').replace(/\s+/g, ' ');
    const cut = body.slice(0, o.maxLen || 900);
    const key = h.source_id + '|' + cut.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push('- ' + (Number(h.quality) === 1 ? '★' : '') + '[' + h.site + '｜' + h.kind + '] ' + h.title + '：' + cut + (body.length > cut.length ? '…' : ''));
    shown++;
  }
  return lines.join('\n');
}

/* ---------------- 索引任务 ---------------- */
function embPendingCount(goalId) {
  try {
    const model = ai.embConfig().model;
    return ctx.db.prepare("SELECT COUNT(*) n FROM source_chunks WHERE goal_id = ? AND (vec = '' OR model != ?)").get(goalId, model).n;
  } catch (e) { return 0; }
}
async function embedPending(job, goalId) {
  const cfg = ai.embConfig();
  if (!cfg.configured) throw new Error('还没配置向量模型（设置 → 检索增强）');
  ensureChunks(goalId);
  const stmt = ctx.db.prepare('SELECT id, text FROM source_chunks WHERE goal_id = ? AND (vec = \'\' OR model != ?) LIMIT ?');
  const upd = ctx.db.prepare('UPDATE source_chunks SET vec = ?, dim = ?, model = ? WHERE id = ?');
  let done = 0;
  const total = embPendingCount(goalId);
  if (!total) return { chunks: 0, model: cfg.model };
  for (;;) {
    if (job && job.signal && job.signal.aborted) { const e = new Error('已停止'); e.cancelled = true; throw e; }
    const rows = stmt.all(goalId, cfg.model, EMB_BATCH);
    if (!rows.length) break;
    const vecs = await ai.embedTexts(rows.map(r => r.text), { signal: job && job.signal });
    for (let i = 0; i < rows.length && i < vecs.length; i++) {
      upd.run(encodeVec(vecs[i]), vecs[i].length, cfg.model, rows[i].id);
    }
    done += Math.min(rows.length, vecs.length);
    if (job) job.progress(Math.round(done / total * 100), `已向量化 ${done}/${total} 段`);
  }
  return { chunks: done, model: cfg.model };
}

function ragTaskRunning(goalId) {
  try { return ctx.tasks.list(goalId).some(t => t.type === 'rag' && (t.status === 'running' || t.status === 'queued')); } catch (e) { return false; }
}
/** 手动/前端触发的重建：后台任务；已有任务在跑就不重复起 */
function buildIndex(goalId) {
  const g = ctx.db.prepare('SELECT id, title FROM goals WHERE id = ?').get(goalId);
  if (!g) throw new Error('目标不存在');
  if (ragTaskRunning(goalId)) return { taskId: 0, already: true };
  const id = ctx.tasks.submit({
    type: 'rag',
    title: '建立检索索引：' + String(g.title).slice(0, 24),
    goalId,
    message: '正在整理资料库…',
    run: async job => {
      job.progress(2, '正在切分资料…');
      ensureChunks(goalId);
      return await embedPending(job, goalId);
    }
  });
  return { taskId: id };
}
/** 资料变更后自动跟进（开了检索增强 + 配了向量模型才建向量；否则只维护分块） */
function autoIndex(goalId) {
  try {
    ensureChunks(goalId);
    if ((ctx.getSetting('rag_enabled', '1') || '1') === '0') return;
    if (!ai.embConfig().configured) return;
    if (!embPendingCount(goalId)) return;
    if (ragTaskRunning(goalId)) return;
    buildIndex(goalId);
  } catch (e) { log('自动索引跳过：' + e.message); }
}

function status(goalId) {
  const cfg = ai.embConfig();
  const where = goalId ? 'WHERE goal_id = ?' : '';
  const args = goalId ? [goalId] : [];
  const s = ctx.db.prepare('SELECT COUNT(*) n FROM sources ' + where).get(...args).n;
  const c = ctx.db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN vec != '' THEN 1 ELSE 0 END) emb FROM source_chunks ` + where).get(...args);
  const model = cfg.model;
  const stale = model ? ctx.db.prepare("SELECT COUNT(*) n FROM source_chunks " + (where ? where + ' AND' : 'WHERE') + " (vec = '' OR model != ?)").get(...args, model).n : (c.n || 0);
  return {
    enabled: (ctx.getSetting('rag_enabled', '1') || '1') !== '0',
    sources: s,
    chunks: c.n || 0,
    embedded: goalId ? c.emb || 0 : c.emb || 0,
    pending: stale,
    embConfigured: cfg.configured,
    embModel: model,
    embBaseUrl: cfg.baseUrl,
    building: ragTaskRunning(goalId || 0)
  };
}

module.exports = { init, chunkText, ensureChunks, dropSource, dropGoal, dropAll, search, block, buildIndex, autoIndex, status, tokensOf, encodeVec, decodeVec, embedPending };
