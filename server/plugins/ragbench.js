'use strict';
/**
 * 思而行 · 检索增强评测（ragbench）
 * ------------------------------------------------------------------
 * 回答一个问题：**接上 RAG 到底有没有让 AI 答得更准？**
 *
 * 做法是同一批题、同一个模型、同一套提示词，只差「给不给资料」：
 *   A 臂（rag）  ：提示词里注入 rag.block() 检索到的真实资料片段
 *   B 臂（norag）：提示词里只有问题，凭通用知识作答
 * 两臂都由模型按「要点」盲评（阅卷时不知道答案来自哪一臂），
 * 得分 = 命中要点数 ÷ 要点总数，最后对比两臂平均分。
 *
 * 题库不靠人手写：从该目标的资料里抽样片段交给模型出题，
 * 并要求「答案必须明确写在资料里、要点是资料里的具体事实」——
 * 这样才测得出「能不能用上资料」，而不是测常识。
 */
const OUT = require('../rag');

let db, nowISO, safeParse, sendJSON, readBody, getSetting, getGoal, aiText, currentModel, tasks, log;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, getGoal, aiText, currentModel, tasks, log } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bench_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  q TEXT NOT NULL DEFAULT '',
  points TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bench_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL DEFAULT 0,
  qid INTEGER NOT NULL DEFAULT 0,
  arm TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  hits TEXT NOT NULL DEFAULT '[]',
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_res_run ON bench_results(run_id, qid, arm);
CREATE INDEX IF NOT EXISTS idx_bench_q_goal ON bench_questions(goal_id, id);`;

/* ---------- 小工具 ---------- */
function jparse(txt) {
  const s = String(txt || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {}
  try { return JSON.parse(s.slice(i, j + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  return null;
}
function qrow(r) { return { id: r.id, goal_id: r.goal_id, q: r.q, points: safeParse(r.points) || [], note: r.note, created_at: r.created_at }; }
function runrow(r) { return { id: r.id, goal_id: r.goal_id, status: r.status, total: r.total, done: r.done, model: r.model, error: r.error, summary: safeParse(r.summary) || {}, created_at: r.created_at, finished_at: r.finished_at }; }

/** 抽样资料片段：跨来源铺开，优先优质源；太短的片段不要（出不了好题） */
function sampleChunks(goalId, n) {
  const rows = db.prepare(`
    SELECT c.id, c.text, s.title, s.site, s.kind, s.quality
    FROM source_chunks c JOIN sources s ON s.id = c.source_id
    WHERE c.goal_id = ? AND LENGTH(COALESCE(c.text,'')) >= 220
    ORDER BY (CASE WHEN s.quality = 1 THEN 0 ELSE 1 END), s.id, c.seq`).all(goalId);
  const out = [], used = new Set();
  for (const r of rows) {                      // 第一轮：每个来源只取一段，保证覆盖面
    if (used.has(r.title)) continue;
    used.add(r.title); out.push(r);
    if (out.length >= n) return out;
  }
  for (const r of rows) {                      // 不够再补
    if (out.indexOf(r) >= 0) continue;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

/* ---------- 提示词 ---------- */
function genPrompt(pieces, n) {
  return [
    `你在为一个资料库出题，用来检验 AI 回答能否用上这些资料。请依据下面的片段出 ${n} 道题。`,
    '',
    '出题方向：像真实的求职者 / 学习者会问的问题 —— 某岗位要求什么、某次面试问了什么、',
    '某个概念是什么、某个方法怎么做、先学哪个。',
    '',
    '硬性要求：',
    '· 每道题都要针对**一个具体对象**发问（某个岗位、某次面试、某个方法、某个概念），',
    '  这样「检索到对应片段就能答对」，题目才公平',
    '· **禁止穷举题**：不要问「资料中出现了哪些…」「请列举资料里提到的所有…」——',
    '  检索只会带回最相关的几段，要求穷举既不公平也测不出东西',
    '· **不要问网页元信息**：本期新增多少职位、薪资数字、公司地址、阅读量、发布时间、',
    '  页脚/导航文字、报名入口 —— 那不是知识',
    '· 答案必须**明确写在资料里**（具体事实、名称、步骤、方法、经验），不能靠常识猜',
    '· 每题 3~5 个要点，要点是资料里写到的**知识性内容**（要求 / 方法 / 经验 / 建议 / 流程）',
    '· 各题覆盖不同片段、不同方面，**不要几道题问同一件事**',
    '',
    '【资料片段】',
    ...pieces.map((p, i) => `〔片段${i + 1}｜${p.title}〕${String(p.text).replace(/\s+/g, ' ').slice(0, 700)}`),
    '',
    '只输出 JSON：{"questions":[{"q":"问题","points":["要点1","要点2"],"note":"来自哪份资料"}]}'
  ].join('\n');
}
/* 两臂共用同一模板，唯一差别就是 material —— 保证对比公平 */
function answerPrompt(material, q) {
  return [
    '你是资深的学习与职业规划顾问。请依据材料回答问题，给出具体、可执行的建议。',
    '',
    '【材料】',
    material || '（本次没有可用资料，请凭通用知识回答）',
    '',
    '【问题】',
    q,
    '',
    '要求：直接作答，条理清晰，不客套。若引用了材料，请写明来源标题。'
  ].join('\n');
}
function judgePrompt(q, points, answer) {
  return [
    '你是严格阅卷人。判断「答案」覆盖了「要点」里的哪些。',
    '',
    '【问题】' + q,
    '【要点】',
    ...points.map((p, i) => (i + 1) + '. ' + p),
    '【答案】',
    answer || '（空）',
    '',
    '判定：要点必须被答案**明确说到**才算命中；只是话题相关、含糊带过不算。',
    '只输出 JSON：{"hit":[命中要点的序号，从1开始],"reason":"一句话"}'
  ].join('\n');
}

module.exports = {
  id: 'ragbench',
  name: '检索增强评测',
  icon: '🧪',
  desc: '用题库检验 RAG 到底有没有让 AI 答得更准：同一批题、同一模型，只差给不给资料，按要点命中率对比',
  category: '其它',
  order: 47,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/ragbench.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  onGoalDelete(goalId, ctx) {
    try {
      ctx.db.prepare('DELETE FROM bench_questions WHERE goal_id = ?').run(Number(goalId) || 0);
      const runs = ctx.db.prepare('SELECT id FROM bench_runs WHERE goal_id = ?').all(Number(goalId) || 0);
      for (const r of runs) ctx.db.prepare('DELETE FROM bench_results WHERE run_id = ?').run(r.id);
      ctx.db.prepare('DELETE FROM bench_runs WHERE goal_id = ?').run(Number(goalId) || 0);
    } catch (e) {}
  },
  exportData(ctx) {
    try {
      return {
        questions: ctx.db.prepare('SELECT * FROM bench_questions ORDER BY id').all(),
        runs: ctx.db.prepare('SELECT * FROM bench_runs ORDER BY id').all(),
        results: ctx.db.prepare('SELECT * FROM bench_results ORDER BY id').all()
      };
    } catch (e) { return null; }
  },
  importData(data, ctx) {
    if (!data || typeof data !== 'object') return;
    try {
      ctx.db.exec('DELETE FROM bench_questions; DELETE FROM bench_runs; DELETE FROM bench_results;');
      const iq = ctx.db.prepare('INSERT INTO bench_questions (id,goal_id,q,points,note,created_at) VALUES (?,?,?,?,?,?)');
      for (const r of (data.questions || [])) iq.run(r.id, r.goal_id, r.q, r.points, r.note, r.created_at);
      const ir = ctx.db.prepare('INSERT INTO bench_runs (id,goal_id,status,total,done,model,error,summary,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const r of (data.runs || [])) ir.run(r.id, r.goal_id, r.status, r.total, r.done, r.model, r.error, r.summary, r.created_at, r.finished_at);
      const ib = ctx.db.prepare('INSERT INTO bench_results (id,run_id,qid,arm,answer,hits,score,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const r of (data.results || [])) ib.run(r.id, r.run_id, r.qid, r.arm, r.answer, r.hits, r.score, r.created_at);
    } catch (e) {}
  },
  clearAll(ctx) {
    try { ctx.db.exec('DELETE FROM bench_questions; DELETE FROM bench_runs; DELETE FROM bench_results;'); } catch (e) {}
  },

  api: [
    /* ---------------- 题库 ---------------- */
    {
      method: 'GET',
      pattern: /^\/api\/goals\/(\d+)\/bench\/questions$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/(\d+)/)[1]);
        const rows = db.prepare('SELECT * FROM bench_questions WHERE goal_id = ? ORDER BY id').all(gid);
        return sendJSON(res, 200, { ok: true, questions: rows.map(qrow) });
      }
    },
    /* 手动加题（q 必填；points 可留空，留空时评测按「无法判分」跳过） */
    {
      method: 'POST',
      pattern: /^\/api\/goals\/(\d+)\/bench\/questions$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/(\d+)/)[1]);
        const b = await readBody(req);
        if (!b.q || !String(b.q).trim()) throw new Error('题目不能为空');
        const points = (Array.isArray(b.points) ? b.points : String(b.points || '').split('\n'))
          .map(x => String(x).trim()).filter(Boolean);
        const t = nowISO();
        const info = db.prepare('INSERT INTO bench_questions (goal_id,q,points,note,created_at) VALUES (?,?,?,?,?)')
          .run(gid, String(b.q).trim(), JSON.stringify(points), String(b.note || ''), t);
        return sendJSON(res, 200, { ok: true, question: qrow(db.prepare('SELECT * FROM bench_questions WHERE id = ?').get(info.lastInsertRowid)) });
      }
    },
    {
      method: 'POST',
      pattern: /^\/api\/bench\/questions\/(\d+)\/delete$/,
      handler: async (req, res, u) => {
        const id = Number(u.pathname.match(/(\d+)/)[1]);
        db.prepare('DELETE FROM bench_questions WHERE id = ?').run(id);
        return sendJSON(res, 200, { ok: true });
      }
    },
    /* AI 出题：从资料片段生成，答案保证写在资料里 */
    {
      method: 'POST',
      pattern: /^\/api\/goals\/(\d+)\/bench\/gen$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/(\d+)/)[1]);
        const b = await readBody(req).catch(() => ({}));
        const n = Math.max(1, Math.min(30, Number(b.n) || 8));
        const g = getGoal(gid);
        if (!g) throw new Error('目标不存在');
        const chunks = sampleChunks(gid, Math.max(n, 6));
        if (!chunks.length) throw new Error('这个目标还没有可用的资料片段，先去「信息源」导入资料并建立检索索引');
        const model = currentModel();
        const job = tasks.begin({ type: 'bench', title: '生成评测题：' + String(g.title || '').slice(0, 20), goalId: gid, message: '正在出题…', phases: ['依据资料出题', '写入题库'] });
        (async () => {
          try {
            job.phase(0, '正在依据资料出题…');
            const txt = await aiText(genPrompt(chunks, n), model, 300000);
            const data = jparse(txt);
            const qs = (data && Array.isArray(data.questions)) ? data.questions : [];
            if (!qs.length) throw new Error('出题失败（模型没返回可解析的题目），可重试');
            const t = nowISO();
            const ins = db.prepare('INSERT INTO bench_questions (goal_id,q,points,note,created_at) VALUES (?,?,?,?,?)');
            let k = 0;
            for (const it of qs) {
              const q = String(it.q || it.question || '').trim();
              const pts = (Array.isArray(it.points) ? it.points : []).map(x => String(x).trim()).filter(Boolean);
              if (!q || !pts.length) continue;
              ins.run(gid, q, JSON.stringify(pts), String(it.note || ''), t);
              k++;
            }
            job.done({ added: k });
            log('[ragbench] 出题完成', k, '道');
          } catch (e) { job.fail(e); log('[ragbench] 出题失败:', e.message); }
        })();
        return sendJSON(res, 200, { ok: true, taskId: job.id, sampled: chunks.length });
      }
    },

    /* ---------------- 跑评测 ---------------- */
    {
      method: 'POST',
      pattern: /^\/api\/goals\/(\d+)\/bench\/run$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/(\d+)/)[1]);
        const b = await readBody(req).catch(() => ({}));
        const g = getGoal(gid);
        if (!g) throw new Error('目标不存在');
        if ((getSetting('rag_enabled', '1') || '1') === '0') throw new Error('检索增强当前是关闭的，先到「设置 → 检索增强」打开再跑');
        let rows = db.prepare('SELECT * FROM bench_questions WHERE goal_id = ? ORDER BY id').all(gid);
        /* limit 为 0 / 未填 = 跑全部。这里不能写成 Math.max(1, …)，
           否则「不限」会被压成 1，只跑一道题。 */
        const limit = Math.max(0, Math.min(30, Number(b.limit) || 0));
        if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
        if (!rows.length) throw new Error('还没有题目：先「AI 出题」或手动添加');
        const model = currentModel();
        const t0 = nowISO();
        const info = db.prepare('INSERT INTO bench_runs (goal_id,status,total,done,model,created_at) VALUES (?,?,?,?,?,?)')
          .run(gid, 'running', rows.length, 0, String(model || ''), t0);
        const runId = Number(info.lastInsertRowid);
        const job = tasks.begin({ type: 'bench', title: 'RAG 评测：' + String(g.title || '').slice(0, 20), goalId: gid, message: '正在评测…', phases: ['逐题评测', '汇总打分'] });

        (async () => {
          const per = { rag: [], norag: [] };
          let done = 0;
          let insRes = null;
          try {
            log('[ragbench] 评测开始 run=' + runId + ' 题数=' + rows.length + ' 模型=' + model);
            insRes = db.prepare('INSERT INTO bench_results (run_id,qid,arm,answer,hits,score,created_at) VALUES (?,?,?,?,?,?,?)');
            for (const q of rows) {
              if (job.signal && job.signal.aborted) throw Object.assign(new Error('已停止'), { cancelled: true });
              const points = safeParse(q.points) || [];
              job.count(done, rows.length, `第 ${done + 1}/${rows.length} 题：${String(q.q).slice(0, 24)}…`);

              /* 两臂：唯一差别是给不给资料 */
              let material = '';
              try { material = await OUT.block(g, q.q, { k: 8, max: 8, maxLen: 700 }); } catch (e) { material = ''; }
              if (!material) material = '';   // 检索没命中就当作「无资料」，避免两臂完全相同还假装有差别
              const ansRag = await aiText(answerPrompt(material, q.q), model, 300000).catch(e => '（作答失败：' + e.message + '）');
              const ansNo = await aiText(answerPrompt('', q.q), model, 300000).catch(e => '（作答失败：' + e.message + '）');

              /* 盲评：阅卷时不说答案来自哪一臂 */
              const judgeOne = async (ans) => {
                if (!points.length) return { hits: [], score: 0 };
                let txt = '';
                try { txt = await aiText(judgePrompt(q.q, points, ans), model, 180000); } catch (e) { return { hits: [], score: 0 }; }
                const d = jparse(txt) || {};
                const hit = (Array.isArray(d.hit) ? d.hit : []).map(x => Number(x) - 1).filter(i => i >= 0 && i < points.length);
                const uniq = Array.from(new Set(hit));
                return { hits: uniq, score: points.length ? uniq.length / points.length : 0 };
              };
              const jr = await judgeOne(ansRag);
              const jn = await judgeOne(ansNo);

              insRes.run(runId, q.id, 'rag', ansRag, JSON.stringify(jr.hits), jr.score, nowISO());
              insRes.run(runId, q.id, 'norag', ansNo, JSON.stringify(jn.hits), jn.score, nowISO());
              per.rag.push({ qid: q.id, score: jr.score, hits: jr.hits });
              per.norag.push({ qid: q.id, score: jn.score, hits: jn.hits });
              done++;
              db.prepare('UPDATE bench_runs SET done = ? WHERE id = ?').run(done, runId);
            }
            const avg = a => a.length ? a.reduce((s, x) => s + x.score, 0) / a.length : 0;
            const summary = {
              questions: rows.length,
              rag: { avg: avg(per.rag), per: per.rag },
              norag: { avg: avg(per.norag), per: per.norag },
              delta: avg(per.rag) - avg(per.norag),
              ragHit: per.rag.reduce((s, x) => s + (x.hits ? x.hits.length : 0), 0),
              noragHit: per.norag.reduce((s, x) => s + (x.hits ? x.hits.length : 0), 0)
            };
            db.prepare('UPDATE bench_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?')
              .run('done', JSON.stringify(summary), nowISO(), runId);
            job.done({ runId, summary });
            log('[ragbench] 评测完成 run', runId, 'delta', summary.delta.toFixed(3));
          } catch (e) {
            db.prepare('UPDATE bench_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
              .run(e && e.cancelled ? 'cancelled' : 'failed', String(e.message || e), nowISO(), runId);
            job.fail(e);
            log('[ragbench] 评测失败 run=' + runId + '：' + (e && e.message));
          }
        })().catch(e => {
          try { job.fail(e); } catch (e2) {}
          try { db.prepare('UPDATE bench_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run('failed', String(e && e.message || e), nowISO(), runId); } catch (e3) {}
          log('[ragbench] 评测异常兜底 run=' + runId + '：' + (e && e.message));
        });
        return sendJSON(res, 200, { ok: true, taskId: job.id, runId, total: rows.length });
      }
    },
    {
      method: 'GET',
      pattern: /^\/api\/goals\/(\d+)\/bench\/runs$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/(\d+)/)[1]);
        const rows = db.prepare('SELECT * FROM bench_runs WHERE goal_id = ? ORDER BY id DESC LIMIT 20').all(gid);
        return sendJSON(res, 200, { ok: true, runs: rows.map(runrow) });
      }
    },
    /* 单次运行详情：每题两臂的答案、命中了哪些要点、得分 */
    {
      method: 'GET',
      pattern: /^\/api\/bench\/runs\/(\d+)$/,
      handler: async (req, res, u) => {
        const rid = Number(u.pathname.match(/(\d+)/)[1]);
        const run = db.prepare('SELECT * FROM bench_runs WHERE id = ?').get(rid);
        if (!run) return sendJSON(res, 404, { error: '这次评测不在了' });
        const res2 = db.prepare('SELECT * FROM bench_results WHERE run_id = ? ORDER BY qid, arm').all(rid);
        const qs = {};
        const items = [];
        for (const r of res2) {
          if (!qs[r.qid]) {
            const q = db.prepare('SELECT * FROM bench_questions WHERE id = ?').get(r.qid);
            qs[r.qid] = true;
            items.push({ qid: r.qid, question: q ? qrow(q) : { id: r.qid, q: '(题目已删)', points: [] }, rag: null, norag: null });
          }
          const it = items.find(x => x.qid === r.qid);
          it[r.arm] = { answer: r.answer, hits: safeParse(r.hits) || [], score: r.score };
        }
        return sendJSON(res, 200, { ok: true, run: runrow(run), items });
      }
    }
  ]
};
