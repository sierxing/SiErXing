'use strict';
/**
 * 思而行 · AI 产出埋点与指标计算（metrics）
 * ------------------------------------------------------------------
 * 目的：让"AI 到底靠不靠谱"变成可测量的数字，而不是靠感觉。
 *
 * 三张表：
 *   task_runs          后台 AI 任务的成功/失败/重试（Q5 的「长任务」维度，原独立指标 P3）
 *   ai_calls           每一次 AI 调用的成败与耗时（Q5 AI 任务失败率）
 *   ai_quality_checks  AI 产出的质量闸门判定（Q4 AI 产出通过率）
 *
 * 为什么必须落库、不能只看日志：
 *   1) 任务队列只在内存里，进程一重启，历史全丢 → 算不出"上周成功率"；
 *   2) 失败有两副面孔——显式抛错（用户看得到）和被 catch 吞掉（用户以为成功了）。
 *      后者只有在这里记一行，才看得见；
 *   3) 一次调用失败后经常靠续写/抢救救回来，这部分（rescued）是 AI 正常工作的
 *      一部分，不能算失败，但它的占比本身说明模型输出撞上限的频率。
 *
 * 写入必须"绝不拖垮主流程"：所有落库都包 try/catch，记不上就记不上，
 * 绝不能因为埋点失败而让用户的任务失败。
 */

let db = null;
let nowISO = () => new Date().toISOString();

const SCHEMA = `
/* 后台 AI 任务的每一次执行（供 Q5 的「长任务」维度统计） */
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',          -- queued|running|done|failed|cancelled
  attempts INTEGER NOT NULL DEFAULT 1,     -- 第几次尝试（重试会新开一行）
  retried INTEGER NOT NULL DEFAULT 0,      -- 本行是否是"一键重试"产生的
  origin_id INTEGER NOT NULL DEFAULT 0,    -- 重试来源的那次 run id
  error TEXT NOT NULL DEFAULT '',
  cost_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs (status, created_at);

/* Q5 AI 任务失败率：每一次 AI 调用 */
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene TEXT NOT NULL DEFAULT '',          -- 调用点：骨架/教程/追问/面试/JD…
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',          -- ok | failed | rescued | silent_fail
  attempts INTEGER NOT NULL DEFAULT 1,
  error_type TEXT NOT NULL DEFAULT '',      -- network|timeout|quota|reject|bad_output|parse|unknown
  error TEXT NOT NULL DEFAULT '',
  cost_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_scene ON ai_calls (scene, created_at);

/* Q4 AI 产出通过率：质量闸门判定 */
CREATE TABLE IF NOT EXISTS ai_quality_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene TEXT NOT NULL DEFAULT '',           -- tutorial_gen|tutorial_edit|…
  check_name TEXT NOT NULL DEFAULT '',      -- integrity|anchor（列名避开保留字 check）
  passed INTEGER NOT NULL DEFAULT 1,       -- 首次是否通过
  attempts INTEGER NOT NULL DEFAULT 1,     -- 第几轮才通过（>1 = 靠续写救回来的）
  issue TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_checks_scene ON ai_quality_checks (scene, created_at);
`;

function init(ctx) {
  db = ctx.db;
  nowISO = ctx.nowISO || nowISO;
  db.exec(SCHEMA);
}

/* ---------- 写入：全部吞异常，埋点绝不影响主流程 ---------- */

const insTask = (r) => {
  try {
    db.prepare(`INSERT INTO task_runs
      (goal_id,node_id,type,title,status,attempts,retried,origin_id,error,cost_ms,created_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.goalId|0, r.nodeId|0, String(r.type||''), String(r.title||'').slice(0,200),
           String(r.status||''), r.attempts||1, r.retried?1:0, r.originId|0,
           String(r.error||'').slice(0,500), r.costMs|0, nowISO(), r.endedAt || nowISO());
    return true;
  } catch (e) { return false; }
};

const updTask = (id, st) => {
  try {
    db.prepare('UPDATE task_runs SET status=?, error=?, cost_ms=?, ended_at=? WHERE id=?')
      .run(String(st.status||''), String(st.error||'').slice(0,500), st.costMs|0, nowISO(), id);
    return true;
  } catch (e) { return false; }
};

const insCall = (r) => {
  try {
    db.prepare(`INSERT INTO ai_calls
      (scene,model,status,attempts,error_type,error,cost_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(String(r.scene||'').slice(0,60), String(r.model||'').slice(0,120),
           String(r.status||''), r.attempts||1, String(r.errorType||''),
           String(r.error||'').slice(0,500), r.costMs|0, nowISO());
    return true;
  } catch (e) { return false; }
};

const insCheck = (r) => {
  try {
    db.prepare(`INSERT INTO ai_quality_checks (scene,check_name,passed,attempts,issue,created_at)
      VALUES (?,?,?,?,?,?)`)
      .run(String(r.scene||'').slice(0,60), String(r.check||''), r.passed ? 1 : 0,
           r.attempts||1, String(r.issue||'').slice(0,500), nowISO());
    return true;
  } catch (e) { return false; }
};

/** 把错误消息归成类型，分功能看失败原因时才用得上 */
function errType(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return '';
  if (/abort|取消|cancel|已停止/.test(s)) return 'cancel';
  if (/timeout|timed out|超时|etimedout/.test(s)) return 'timeout';
  if (/429|quota|额度|余额|rate limit|too many requests/.test(s)) return 'quota';
  if (/401|403|auth|key|登录|unauthorized|forbidden/.test(s)) return 'auth';
  if (/enotfound|econnrefused|network|fetch failed|networkerror|getaddrinfo|dns/.test(s)) return 'network';
  if (/没有返回|空的|empty|截断|不完整|写了一半/.test(s)) return 'bad_output';
  if (/解析|parse|json|格式/.test(s)) return 'parse';
  return 'unknown';
}

/* ---------- 8 个指标的计算（全部只用核心表 + 本模块三张表） ---------- */

const ONE = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return {}; } };
const ALL = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return []; } };
const pct = (a, b) => (b > 0 ? Math.round(1000 * a / b) / 10 : null);
const has = (t) => { try { db.prepare('SELECT 1 FROM ' + t + ' LIMIT 1').get(); return true; } catch (e) { return false; } };

function compute() {
  const m = [];

  /* ===== N1 规划推进率 ===== */
  const par = ONE(`
    WITH active_days AS (
      SELECT DISTINCT substr(updated_at,1,10) AS d FROM nodes WHERE status IN ('doing','done')
      UNION SELECT DISTINCT substr(created_at,1,10) FROM goal_versions
    ),
    adv_days AS (
      SELECT DISTINCT substr(updated_at,1,10) AS d FROM nodes WHERE status IN ('doing','done')
    )
    SELECT (SELECT COUNT(*) FROM active_days) AS a, (SELECT COUNT(*) FROM adv_days) AS b`);
  m.push({
    id: 'N1', name: '规划推进率', type: '北极星', unit: '%',
    value: pct(par.b || 0, par.a || 0),
    formula: '推进日 ÷ 使用日',
    source: 'nodes + goal_versions',
    detail: { 使用日: par.a || 0, 推进日: par.b || 0 },
    collectable: true
  });

  /* ===== P1 规划可执行性（叶子节点占比）===== */
  const pa = ONE(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE id NOT IN (SELECT parent_id FROM nodes WHERE parent_id IS NOT NULL)) AS leaf
    FROM nodes`);
  m.push({
    id: 'P1', name: '规划可执行性', type: '过程', unit: '%',
    value: pct(pa.leaf || 0, pa.total || 0),
    formula: '叶子节点数 ÷ 节点总数',
    source: 'nodes',
    detail: { 节点总数: pa.total || 0, 叶子节点: pa.leaf || 0 },
    collectable: true
  });

  /* ===== P2 首版规划留存率（按目标，再给一个按节点数加权的总览）===== */
  const frrByGoal = [];
  for (const g of ALL('SELECT id, title FROM goals ORDER BY id')) {
    const r = ONE(`SELECT json_array_length(snapshot_after) AS init_nodes FROM goal_versions v
      WHERE v.goal_id = ? AND length(COALESCE(v.snapshot_after,0)) > 0
      ORDER BY v.created_at LIMIT 1`, g.id);
    if (!r || !r.init_nodes) { frrByGoal.push({ 目标: g.id, 首版节点: 0, 留存: 0, 留存率: null }); continue; }
    let init = [];
    try {
      const row = ONE("SELECT snapshot_after FROM goal_versions WHERE goal_id=? AND length(COALESCE(snapshot_after,0))>0 ORDER BY created_at LIMIT 1", g.id);
      init = JSON.parse(row.snapshot_after).map(x => String(x.title || '').trim());
    } catch (e) {}
    const cur = new Set(ALL('SELECT title FROM nodes WHERE goal_id=?', g.id).map(x => String(x.title).trim()));
    const kept = init.filter(t => cur.has(t)).length;
    frrByGoal.push({ 目标: g.id, 首版节点: init.length, 留存: kept, 留存率: pct(kept, init.length) });
  }
  const okFrr = frrByGoal.filter(x => x.留存率 != null);
  m.push({
    id: 'P2', name: '首版规划留存率', type: '过程', unit: '%',
    value: pct(okFrr.reduce((s, x) => s + x.留存, 0), okFrr.reduce((s, x) => s + x.首版节点, 0)),
    formula: '首版仍在的节点数 ÷ 首版节点总数',
    source: 'goal_versions + nodes',
    detail: { 分目标: frrByGoal },
    collectable: true
  });

  /* ===== P4 规划收敛迭代次数（相邻快照变动 ≥15% 记一次结构调整）===== */
  const TH = 0.15;
  const convByGoal = [];
  for (const g of ALL('SELECT id, title FROM goals ORDER BY id')) {
    const rows = ALL("SELECT created_at, snapshot_after FROM goal_versions WHERE goal_id=? AND length(COALESCE(snapshot_after,0))>0 ORDER BY created_at", g.id);
    const seq = [];
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.snapshot_after);
        seq.push({ t: r.created_at, n: arr.length, set: new Set(arr.map(x => String(x.title || '').trim())) });
      } catch (e) {}
    }
    if (seq.length < 2) { convByGoal.push({ 目标: g.id, 总版本: seq.length, 结构调整版: 0 }); continue; }
    let big = 0;
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i - 1], c = seq[i];
      let ch = 0;
      for (const x of c.set) if (!p.set.has(x)) ch++;
      for (const x of p.set) if (!c.set.has(x)) ch++;
      if (ch / Math.max(p.n, c.n, 1) >= TH) big++;
    }
    convByGoal.push({ 目标: g.id, 总版本: seq.length, 结构调整版: big });
  }
  const totBig = convByGoal.reduce((s, x) => s + (x.结构调整版 || 0), 0);
  m.push({
    id: 'P4', name: '规划收敛迭代次数', type: '过程', unit: '版',
    value: totBig,
    formula: '相邻两版节点增删 ≥15% 的次数',
    source: 'goal_versions',
    detail: { 合计: totBig, 分目标: convByGoal },
    collectable: true
  });

  /* ===== Q1 规划完备度 ===== */
  const pc = ONE(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE COALESCE(acceptance,'')<>'') AS wa,
      COUNT(*) FILTER (WHERE COALESCE(hours,'')<>'') AS wh,
      COUNT(*) FILTER (WHERE COALESCE(acceptance,'')<>'' AND COALESCE(hours,'')<>'') AS both
    FROM nodes`);
  const byLevel = ALL(`SELECT level, COUNT(*) AS total,
      COUNT(*) FILTER (WHERE COALESCE(acceptance,'')<>'' AND COALESCE(hours,'')<>'') AS both
    FROM nodes GROUP BY level ORDER BY level`)
    .map(r => ({ level: r.level, 节点数: r.total, 完备: r.both, 完备度: pct(r.both, r.total) }));
  m.push({
    id: 'Q1', name: '规划完备度', type: '质量', unit: '%',
    value: pct(pc.both || 0, pc.total || 0),
    formula: '同时有验收标准和估时的节点 ÷ 节点总数',
    source: 'nodes',
    detail: {
      节点总数: pc.total || 0, 有验收标准: pc.wa || 0, 有估时: pc.wh || 0, 完备: pc.both || 0,
      按层级: byLevel
    },
    collectable: true
  });

  /* ===== Q4 AI 产出通过率（首次即通过）===== */
  if (has('ai_quality_checks')) {
    const q = ONE(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE passed=1 AND attempts=1) AS first_pass,
        COUNT(*) FILTER (WHERE passed=1 AND attempts>1) AS rescued
      FROM ai_quality_checks WHERE check_name='integrity'`);
    m.push({
      id: 'Q4', name: 'AI 产出通过率', type: '质量', unit: '%',
      value: pct(q.first_pass || 0, q.total || 0),
      formula: '首次生成即通过结构体检的比例',
      source: 'ai_quality_checks',
      detail: { 判定总数: q.total || 0, 首次通过: q.first_pass || 0, 续写救回: q.rescued || 0 },
      collectable: true
    });
  }

  /* ===== Q5 AI 任务失败率 ===== */
  if (has('ai_calls')) {
    const a = ONE(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='ok') AS ok,
        COUNT(*) FILTER (WHERE status='rescued') AS rescued,
        COUNT(*) FILTER (WHERE status='failed') AS failed,
        COUNT(*) FILTER (WHERE status='silent_fail') AS silent,
        COUNT(*) FILTER (WHERE status IN ('failed','silent_fail')) AS bad
      FROM ai_calls`);
    /* 分母 = AI 调用总数（rescued 也是一次真实调用，首轮失败靠续写救回来的，
       它同时进"首次失败率"和"调用总数"，只是不进"最终失败率"的分子）。 */
    const fin = a.total || 0;

    /* ---- 分层①：按功能（scene）看哪个功能最不靠谱 ----
       每层都带齐四种状态和平均耗时：只看一个"失败率"看不出
       "这个功能是稳定失败，还是偶尔失败还特别慢"。 */
    const byScene = ALL(`SELECT scene,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='ok')         AS ok,
        COUNT(*) FILTER (WHERE status='rescued')    AS rescued,
        COUNT(*) FILTER (WHERE status='failed')     AS failed,
        COUNT(*) FILTER (WHERE status='silent_fail') AS silent,
        CAST(COALESCE(AVG(cost_ms),0) AS INTEGER)  AS avg_ms
      FROM ai_calls GROUP BY scene ORDER BY
        (COUNT(*) FILTER (WHERE status IN ('failed','silent_fail'))) DESC, total DESC`)
      .map(r => ({
        场景: r.scene || '(未标注)',
        调用数: r.total,
        一次成功: r.ok,
        抢救成功: r.rescued,          // 续写/抢救救回来的，不算失败
        最终失败: r.failed,
        静默失败: r.silent,           // 被 catch 吞掉、用户以为成功的那类，最该盯
        失败率: pct((r.failed || 0) + (r.silent || 0), r.total),
        静默占比: pct(r.silent || 0, r.total),
        平均耗时ms: r.avg_ms
      }));

    /* ---- 分层②：按错误类型看"为什么失败" ----
       配额问题换模型能解，超时换网络环境能解，两者混在一起看就分不出行动方向。 */
    const errTotal = ALL(`SELECT COUNT(*) AS n FROM ai_calls WHERE error_type <> ''`)[0].n || 0;
    const byErr = ALL(`SELECT error_type, COUNT(*) AS n,
        CAST(COALESCE(AVG(cost_ms),0) AS INTEGER) AS avg_ms
      FROM ai_calls WHERE error_type <> '' GROUP BY error_type ORDER BY n DESC`)
      .map(r => ({ 错误类型: r.error_type, 次数: r.n, 占比: pct(r.n, errTotal), 平均耗时ms: r.avg_ms }));

    /* ---- 分层③：模型维度（换个模型能不能解决失败）---- */
    const byModel = ALL(`SELECT model,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('failed','silent_fail')) AS bad
      FROM ai_calls WHERE model <> '' GROUP BY model ORDER BY bad DESC, total DESC`)
      .map(r => ({ 模型: r.model, 调用数: r.total, 失败数: r.bad, 失败率: pct(r.bad, r.total) }));

    /* ---- 分层④：长任务队列（原 P3 任务健壮性）----
       合并进本指标的理由：长任务内部也是一次次 AI 调用，Q5 已经覆盖；
       但"任务整体有没有办完"仍是独立视角（AI 失败可能被内部兜住，任务仍算 done），
       所以作为 detail 的一个维度保留，而不是另立一个指标。 */
    const tj = has('task_runs') ? ONE(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='done')      AS done,
        COUNT(*) FILTER (WHERE status='failed')    AS failed,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
        COUNT(*) FILTER (WHERE retried=1)          AS retried
      FROM task_runs`) : {};
    const tFin = (tj.done || 0) + (tj.failed || 0);
    const byTaskType = ALL(`SELECT type, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='failed') AS failed
      FROM task_runs GROUP BY type ORDER BY total DESC`)
      .map(r => ({ 任务类型: r.type || '(未标注)', 次数: r.total, 失败: r.failed, 失败率: pct(r.failed, r.total) }));

    m.push({
      id: 'Q5', name: 'AI 任务失败率', type: '过程', unit: '%',
      value: pct(a.bad || 0, fin),
      formula: '(failed + silent_fail) ÷ 调用总数',
      source: 'ai_calls',
      detail: {
        调用总数: a.total || 0, 一次成功: a.ok || 0, 抢救成功: a.rescued || 0,
        最终失败: a.failed || 0, 静默失败: a.silent || 0,
        首次失败率: pct((a.total || 0) - (a.ok || 0), a.total || 0),
        按场景: byScene, 按错误类型: byErr, 按模型: byModel,
        长任务: {
          说明: '长任务队列的整体成败（AI 失败可能被内部兜住，任务仍算完成，所以这一维和上面不同视角）',
          总任务: tj.total || 0, 成功: tj.done || 0, 失败: tj.failed || 0,
          用户主动停止: tj.cancelled || 0,      /* 不算失败，单独列出 */
          重试产生: tj.retried || 0,
          成功率: pct(tj.done || 0, tFin), 失败率: pct(tj.failed || 0, tFin),
          按任务类型: byTaskType
        }
      },
      collectable: true
    });
  }

  return {
    collectedAt: nowISO(),
    goals: (ONE('SELECT COUNT(*) AS c FROM goals').c) || 0,
    nodes: (ONE('SELECT COUNT(*) AS c FROM nodes').c) || 0,
    metrics: m
  };
}

module.exports = { id: 'metrics', init, insTask, updTask, insCall, insCheck, errType, compute };