'use strict';
/**
 * 思而行 · 达成条件领域（从 server.js 抽出，纯数据 + 纯提示词）
 * ------------------------------------------------------------------
 * 为什么单独有这么一层：
 *   「阶段」是推进台阶，不等于「要达成目标必须满足什么」。用户要的是另一根轴：
 *   目标 → 若干条可验收的达成条件 → 路线图节点归到条件下面，这样每个条件
 *   都能单独看推进进度（节点完成几个 / 共几个），而不是只有一个笼统的总进度。
 *
 * 数据：
 *   goal_conditions(id, goal_id, title, detail, acceptance, priority, source, sort_order)
 *   nodes.condition_id = 这个计划节点主要服务哪条条件（0 = 未归属）
 *
 * 归属规则：
 *   · AI 规划骨架时直接产出 conditions，并给每个阶段/小目标写 condition key；
 *   · 任务节点在 insertNode 时继承父级（小目标）的条件，不需要 AI 重复输出；
 *   · 老目标/导入目标没有条件时，组件页可以调 generateFromNodes() 让 AI 从现有路线图反推；
 *   · 手动新建的条件 source='manual'，重新规划只替换 source='plan' 的条件，手动条件保留。
 *
 * 进度口径：
 *   一条条件的"可执行节点" = 归属于它的、且没有归属子节点的深层节点（末端节点）。
 *   这样阶段/小目标只是容器，不会被重复计数；任务没细化到 level 2 时，小目标本身就是末端。
 */
const PRIORITIES = ['must', 'should', 'nice'];
const LEVEL_LABEL = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '子任务', 5: '子任务' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goal_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  jd_ref TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'must',
  source TEXT NOT NULL DEFAULT 'plan',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_conditions_goal ON goal_conditions(goal_id, sort_order);
`;

/* 从模型回复里抠第一个 JSON 对象（前后夹说明文字 / ``` 围栏都认） */
function firstJSON(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { break; } } }
    }
  }
  return null;
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 200);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function normPriority(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/should|建议|重要|优先/.test(s)) return 'should';
  if (/nice|加分|锦上添花|可选/.test(s)) return 'nice';
  return 'must';
}
/* 条件 key 的归一化：模型可能给 key / id / 数字序号 / 干脆没有 */
function normalizePlanConditions(list) {
  const out = [], seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (!raw) continue;
    const src = (typeof raw === 'string') ? { title: raw } : raw;
    const title = clip(src.title || src.name || src.text || '', 120);
    if (!title) continue;
    let key = clip(src.key || src.id || src.condition_key || '', 24).replace(/\s+/g, '');
    if (!key || seen.has(key)) {
      let i = out.length + 1;
      key = 'c' + i;
      while (seen.has(key)) { i++; key = 'c' + i; }
    }
    seen.add(key);
    out.push({
      key,
      title,
      detail: clip(src.detail || src.desc || src.why || src.reason || '', 800),
      acceptance: clip(src.acceptance || src.criteria || src.check || src.done_when || '', 600),
      jd_ref: clip(src.jd_ref || src.jd || src.jd_clause || src.jd_text || src.source_ref || '', 600),
      priority: normPriority(src.priority),
      sort_order: out.length
    });
    if (out.length >= 16) break;
  }
  return out;
}

function createConditionsDomain(opts) {
  const db = opts.db;
  const nowISO = opts.nowISO || function () { return new Date().toISOString(); };
  const safeParse = opts.safeParse || function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
  const aiText = opts.aiText;
  const currentModel = opts.currentModel || function () { return ''; };

  /* 建表/补列（服务启动时也会建，这里兜底让领域单测和旧库都能直接用） */
  function ensureSchema() {
    db.exec(SCHEMA);
    try {
      const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
      if (!cols.includes('condition_id')) db.exec('ALTER TABLE nodes ADD COLUMN condition_id INTEGER NOT NULL DEFAULT 0;');
      const ccols = db.prepare('PRAGMA table_info(goal_conditions)').all().map(c => c.name);
      if (!ccols.includes('jd_ref')) db.exec("ALTER TABLE goal_conditions ADD COLUMN jd_ref TEXT NOT NULL DEFAULT '';");
    } catch (e) {}
  }

  function tx(fn) {
    db.exec('BEGIN');
    try { const v = fn(); db.exec('COMMIT'); return v; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
  }
  function goalOf(goalId) { return db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(goalId)) || null; }
  function nodesOf(goalId) {
    return db.prepare('SELECT id, parent_id, level, title, detail, status, hours, sources, condition_id, sort_order FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(Number(goalId));
  }
  function condOf(id) { return db.prepare('SELECT * FROM goal_conditions WHERE id = ?').get(Number(id)) || null; }
  function countForGoal(goalId) {
    try { return Number(db.prepare('SELECT COUNT(*) AS n FROM goal_conditions WHERE goal_id = ?').get(Number(goalId)).n) || 0; } catch (e) { return 0; }
  }

  /* 把 ref（key / 标题 / 1 起的序号）解析成条件 id；解析不了就当未归属 */
  function resolveId(ref, defs, ids) {
    if (ref == null || ref === '') return 0;
    if (typeof ref === 'object') return resolveId(ref.key || ref.id || ref.condition_key || ref.title || '', defs, ids);
    const s = String(ref).trim();
    if (!s) return 0;
    let i = defs.findIndex(d => String(d.key) === s);
    if (i >= 0) return ids[i];
    i = defs.findIndex(d => d.title === s);
    if (i >= 0) return ids[i];
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1 && n <= ids.length) return ids[n - 1];
    return 0;
  }

  /* 保存规划产出的条件：只替换 source='plan' 的，手动条件保留 */
  function saveFromPlan(goalId, plan) {
    const defs = normalizePlanConditions(plan && plan.conditions);
    db.prepare("UPDATE nodes SET condition_id = 0 WHERE goal_id = ? AND condition_id IN (SELECT id FROM goal_conditions WHERE goal_id = ? AND source = 'plan')")
      .run(Number(goalId), Number(goalId));
    db.prepare("DELETE FROM goal_conditions WHERE goal_id = ? AND source = 'plan'").run(Number(goalId));
    const ids = [];
    if (defs.length) {
      const t = nowISO();
      const ins = db.prepare('INSERT INTO goal_conditions (goal_id,title,detail,acceptance,jd_ref,priority,source,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      defs.forEach((d, i) => {
        const r = ins.run(Number(goalId), d.title, d.detail, d.acceptance, d.jd_ref || '', d.priority, 'plan', i * 10, t, t);
        ids.push(Number(r.lastInsertRowid));
      });
    }
    return { defs: defs, ids: ids, resolve: function (ref) { return resolveId(ref, defs, ids); } };
  }

  /* 计算一个目标的整体视图：每条条件的进度 + 对应节点 + 未归属节点 */
  function list(goalId) {
    goalId = Number(goalId);
    const conditions = db.prepare('SELECT * FROM goal_conditions WHERE goal_id = ? ORDER BY sort_order, id').all(goalId);
    const nodes = nodesOf(goalId);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const children = new Map();
    for (const n of nodes) {
      const k = n.parent_id == null ? 0 : Number(n.parent_id);
      if (!children.has(k)) children.set(k, []);
      children.get(k).push(n);
    }
    const stageMemo = new Map();
    function stageOf(n) {
      if (n.level === 0) return n;
      if (stageMemo.has(n.id)) return stageMemo.get(n.id);
      let cur = n, guard = 0;
      while (cur && cur.level !== 0 && guard++ < 12) cur = cur.parent_id ? byId.get(Number(cur.parent_id)) : null;
      const st = cur || n;
      stageMemo.set(n.id, st);
      return st;
    }
    /* 末端：没有子节点，或子节点都没有归属（不再下钻计数） */
    function isTerminal(n) {
      const kids = children.get(n.id) || [];
      if (!kids.length) return true;
      return !kids.some(k => Number(k.condition_id) > 0);
    }
    const nodeOut = n => {
      const st = stageOf(n);
      const p = n.parent_id ? byId.get(Number(n.parent_id)) : null;
      return {
        id: n.id, parent_id: n.parent_id, level: n.level, title: n.title, status: n.status, hours: n.hours,
        condition_id: Number(n.condition_id) || 0,
        stage_id: st ? st.id : 0, stage_title: st ? st.title : '',
        parent_title: p ? p.title : '',
        terminal: isTerminal(n)
      };
    };
    const out = conditions.map(c => {
      const mine = nodes.filter(n => Number(n.condition_id) === c.id);
      const term = mine.filter(isTerminal);
      const done = term.filter(n => n.status === 'done').length;
      const doing = term.filter(n => n.status === 'doing').length;
      return {
        id: c.id, goal_id: c.goal_id, title: c.title, detail: c.detail, acceptance: c.acceptance,
        jd_ref: c.jd_ref || '', priority: c.priority || 'must', source: c.source || 'plan', sort_order: c.sort_order,
        nodes: mine.map(nodeOut),
        stats: {
          nodes_total: mine.length, total: term.length, done: done, doing: doing, todo: term.length - done - doing,
          percent: term.length ? Math.round(done / term.length * 100) : 0,
          met: term.length > 0 && done === term.length
        }
      };
    });
    const assignedTerm = nodes.filter(n => Number(n.condition_id) > 0 && isTerminal(n));
    const unassigned = nodes.filter(n => !(Number(n.condition_id) > 0));
    const unassignedLeaves = unassigned.filter(isTerminal);
    const allTerm = nodes.filter(isTerminal);
    const allDone = allTerm.filter(n => n.status === 'done').length;
    const sumDone = assignedTerm.filter(n => n.status === 'done').length;
    return {
      goal_id: goalId,
      conditions: out,
      unassigned: unassignedLeaves.map(nodeOut),
      summary: {
        conditions_total: conditions.length,
        conditions_met: out.filter(c => c.stats.met).length,
        nodes_total: nodes.length,
        nodes_assigned: nodes.filter(n => Number(n.condition_id) > 0).length,
        nodes_unassigned: unassigned.length,
        tasks_total: allTerm.length,
        tasks_done: allDone,
        percent: allTerm.length ? Math.round(allDone / allTerm.length * 100) : 0,
        assigned_tasks_total: assignedTerm.length,
        assigned_tasks_done: sumDone,
        assigned_percent: assignedTerm.length ? Math.round(sumDone / assignedTerm.length * 100) : 0,
        unassigned_tasks: unassignedLeaves.length
      }
    };
  }

  function descendants(goalId, nodeId) {
    const out = [];
    const stmt = db.prepare('SELECT id FROM nodes WHERE goal_id = ? AND parent_id = ?');
    const stack = [Number(nodeId)];
    while (stack.length) {
      const cur = stack.pop();
      for (const r of stmt.all(Number(goalId), cur)) { out.push(Number(r.id)); stack.push(Number(r.id)); }
    }
    return out;
  }
  function setCondition(goalId, ids, conditionId, cascade) {
    const upd = db.prepare('UPDATE nodes SET condition_id = ?, updated_at = ? WHERE id = ? AND goal_id = ?');
    const t = nowISO();
    for (const id of ids) {
      const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND goal_id = ?').get(Number(id), Number(goalId));
      if (!n) continue;
      upd.run(Number(conditionId) || 0, t, Number(id), Number(goalId));
      if (cascade) for (const cid of descendants(goalId, id)) upd.run(Number(conditionId) || 0, t, cid, Number(goalId));
    }
  }
  function assertCond(goalId, conditionId) {
    if (!conditionId) return 0;
    const c = condOf(conditionId);
    if (!c || Number(c.goal_id) !== Number(goalId)) throw new Error('条件不存在（可能已被删除）');
    return Number(conditionId);
  }

  /* 批量改归属：{ map: {nodeId: conditionId} }（精确）或 { condition_id, node_ids, cascade } */
  function assign(goalId, payload) {
    goalId = Number(goalId);
    const g = goalOf(goalId);
    if (!g) throw new Error('目标不存在');
    const body = payload || {};
    let changed = 0;
    tx(() => {
      if (body.map && typeof body.map === 'object') {
        const upd = db.prepare('UPDATE nodes SET condition_id = ?, updated_at = ? WHERE id = ? AND goal_id = ?');
        const t = nowISO();
        for (const key of Object.keys(body.map)) {
          const nid = Number(key);
          const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND goal_id = ?').get(nid, goalId);
          if (!n) continue;
          const cid = assertCond(goalId, Number(body.map[key]) || 0);
          upd.run(cid, t, nid, goalId);
          changed++;
        }
      } else if (Array.isArray(body.node_ids)) {
        const cid = assertCond(goalId, Number(body.condition_id) || 0);
        const ids = body.node_ids.map(Number).filter(x => x > 0);
        setCondition(goalId, ids, cid, body.cascade !== false);
        changed = ids.length;
      }
    });
    return { changed: changed, data: list(goalId) };
  }

  /* 手动新建 / 编辑条件（source 保持原值；新建为 manual） */
  function saveManual(goalId, body) {
    goalId = Number(goalId);
    const g = goalOf(goalId);
    if (!g) throw new Error('目标不存在');
    const b = body || {};
    const title = clip(b.title, 120);
    if (!title) throw new Error('条件标题不能为空');
    const detail = clip(b.detail, 800);
    const acceptance = clip(b.acceptance, 600);
    const jdRef = clip(b.jd_ref || b.jd || b.jd_clause || '', 600);
    const priority = normPriority(b.priority);
    const t = nowISO();
    const id = Number(b.id) || 0;
    if (id) {
      const old = condOf(id);
      if (!old || Number(old.goal_id) !== goalId) throw new Error('条件不存在');
      db.prepare('UPDATE goal_conditions SET title = ?, detail = ?, acceptance = ?, jd_ref = ?, priority = ?, updated_at = ? WHERE id = ?')
        .run(title, detail, acceptance, jdRef, priority, t, id);
      return { id: id, data: list(goalId) };
    }
    const max = Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM goal_conditions WHERE goal_id = ?').get(goalId).n) || 0;
    const r = db.prepare('INSERT INTO goal_conditions (goal_id,title,detail,acceptance,jd_ref,priority,source,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(goalId, title, detail, acceptance, jdRef, priority, 'manual', max + 10, t, t);
    return { id: Number(r.lastInsertRowid), data: list(goalId) };
  }
  function remove(id) {
    const c = condOf(id);
    if (!c) throw new Error('条件不存在');
    const goalId = Number(c.goal_id);
    tx(() => {
      db.prepare('UPDATE nodes SET condition_id = 0 WHERE goal_id = ? AND condition_id = ?').run(goalId, Number(id));
      db.prepare('DELETE FROM goal_conditions WHERE id = ?').run(Number(id));
    });
    return { deleted: Number(id), data: list(goalId) };
  }

  /* ---------- AI：从现有路线图反推达成条件并自动归属 ---------- */
  function buildPrompt(goal, nodes, existing) {
    const lines = [];
    lines.push('你是资深职业路径规划师。下面是一个已经排好的路线图（阶段 → 小目标 → 任务）。');
    lines.push('请回答一个关键问题：**要达到这个用户的目标，必须满足哪些「达成条件」？** 然后把这些节点归到对应条件下面。');
    lines.push('');
    lines.push('【目标】' + String(goal.title || '').slice(0, 200));
    if (goal.profile) lines.push('【用户现状】' + String(goal.profile).replace(/\s+/g, ' ').slice(0, 1200));
    if (goal.deadline) lines.push('【期限】' + goal.deadline);
    if (goal.weekly_hours) lines.push('【每周可投入】' + goal.weekly_hours);
    const cons = (safeParse(goal.constraints) || []).map(c => (c && c.text) || c).filter(Boolean);
    if (cons.length) lines.push('【硬性约束】' + cons.map(c => String(c).slice(0, 120)).join('；'));
    if (goal.summary) lines.push('【此前规划思路】' + String(goal.summary).slice(0, 800));
    /* 条件依据按**目标类型**选来源（不能所有目标都硬套 JD）：
       求职→JD；学习/考证→考纲/课程大纲；项目/产品→交付物与验收；认知/兴趣→能讲清/能做出来；习惯→量化节奏。
       用户粘贴的参考资料先原样给出，由模型按类型引用。 */
    const goalBlob = [goal.title, goal.profile, goal.materials, goal.summary].map(x => String(x || '')).join(' ').slice(0, 4000);
    const jobLike = /求职|转行|找工作|实习|校招|社招|面试|简历|岗位|招聘|JD|offer|职业/i.test(goalBlob);
    if (jobLike) lines.push('【目标类型】求职 / 转行 / 实习类：条件依据以 JD 原文为准。');
    else lines.push('【目标类型】非求职类目标：**不要硬套 JD / 岗位条款**，按目标本身的性质选依据（学习→考纲/教材/课程大纲；项目/作品→交付物与验收标准；认知/兴趣→能讲清/能应用/能做出东西；习惯→可量化结果与节奏）。');
    const jdChunks = [];
    const materials = String(goal.materials || '').replace(/\s+/g, ' ').trim();
    if (materials) jdChunks.push('【用户提供的参考资料（优先作为条件依据）】' + materials.slice(0, 3000));
    try {
      const rows = db.prepare("SELECT title, kind, snippet, content FROM sources WHERE goal_id = ? AND (kind LIKE '%JD%' OR kind LIKE '%岗位%' OR kind LIKE '%招聘%' OR kind LIKE '%实习%' OR title LIKE '%JD%' OR title LIKE '%岗位%' OR title LIKE '%招聘%') ORDER BY id DESC LIMIT 8").all(goal.id);
      if (rows.length) {
        jdChunks.push('【资料库里的 JD / 招聘信息（节选）】');
        let n = 0;
        for (const r of rows) {
          if (n++ >= 8) break;
          const txt = String(r.content || r.snippet || '').replace(/\s+/g, ' ').slice(0, 1200);
          jdChunks.push('- 「' + String(r.title || '未命名').slice(0, 60) + '」' + (txt ? '：' + txt : ''));
        }
      }
    } catch (e) {}
    if (jdChunks.length) { lines.push(''); lines.push(jdChunks.join('\n')); }
    lines.push('');
    lines.push('【路线图】');
    let count = 0;
    for (const n of nodes) {
      if (count++ >= 400) { lines.push('…（节点过多，已截断；按上面这些归纳即可）'); break; }
      const pad = '  '.repeat(Math.min(Number(n.level) || 0, 3));
      const det = n.detail ? ' —— ' + String(n.detail).replace(/\s+/g, ' ').slice(0, 100) : '';
      lines.push(pad + '[' + n.id + '] ' + (LEVEL_LABEL[n.level] || '节点') + '：' + String(n.title || '').slice(0, 100) + det);
    }
    if (existing && existing.length) {
      lines.push('');
      lines.push('【现有条件（尽量沿用，可补充或合并）】' + existing.map(c => c.title).join(' / '));
    }
    lines.push('');
    lines.push('【要求】');
    lines.push('0. **条件 ≠ 阶段**。阶段是时间上的推进台阶；条件是要达成的东西，必须能一句话判定「达成 / 没达成」。');
    lines.push('1. **每条条件都必须对到具体依据，不能是宽泛能力话术**：jd 字段写这条条件的依据原文/条款——求职类写 JD 原文/条款（照抄关键短语；JD 不够时按**公共 AIPM（AI 产品经理）JD 的高频条款**补足并标「（公共 AIPM JD 常见条款）」）；学习/考证类写考纲、课程大纲、教材要求；项目/作品类写交付物与验收标准；认知类写"能讲清/能应用"的检验点；习惯类写可量化结果与节奏。**非求职目标不要硬套 JD**。');
    if (jobLike) lines.push('   公共 AIPM JD 高频条款参考（只挑和目标相关的，不必全要）：① 学历/届别/专业（本科及以上、2026/2027 届、计算机相关优先）；② 到岗条件（北京/上海等城市、每周 ≥3~4 天、连续 3~6 个月）；③ AI 技术理解（RAG / Agent / Prompt / 模型评测 / 推理成本 能被面试追问）；④ 产品基本功（需求分析、PRD、流程图、原型、埋点、验收标准）；⑤ 成果证明（可演示 Demo / 作品集，带召回率、幻觉率、时延、单次成本等指标）；⑥ 项目/实习经历（场景 + 任务 + 动作 + 指标）；⑦ 投递与面试（岗位池、投递节奏、面试表达）。');
    lines.push('2. **条件数量按「依据里的独立要求维度」决定，不要压成少数几条**：先把依据里的每个独立要求维度列出来（求职类：学历/到岗/AI 技术理解/产品基本功/作品与指标/实习经历/简历/面试/投递；学习类：考纲的知识模块与考核项；项目类：交付物、可运行性、质量指标、验收；习惯类：频次/时长/结果），**一个维度至少一条，只有真同类才合并**；求职类通常 8-12 条（JD 维度多时可到 14），学习/项目类 4-10 条，简单目标 3-6 条。按「硬性门槛 → 关键能力 → 成果证明 → 资源与资格」排序；**每条都要能对回依据里的某个条款/验收项**，覆盖约束里的硬性要求，不要编造。');
    lines.push('2b. **条件写的是「必须有/必须能做到」的东西，不是计划节点**：条件标题与 detail 里**禁止**出现路线图节点名或自造口号（反例：「按需解锁并落地」「XX里程碑完成」）。**求职类尤其不能把目标名/个人项目名当条件**（反例：「思而行闭环与证据跑通」「思而行架构机制全景可盲讲」）；项目类目标可以写自己项目的可验收成果（如「项目能在本地一键跑起来并复现核心流程」），但也要写成可判定结果，不要照抄节点名。输出前自检去重：同一个要求只能出一条条件，近义/重叠条款合并。');
    lines.push('3. 每条都要有：title（10-20 字）、detail（60-120 字，为什么必须满足它）、acceptance（可验证的判定标准，能自检）、jd（对应依据原文/条款：求职类写 JD，其它类型写考纲/资料要求/验收标准，60-200 字）、priority（must / should / nice）。');
    lines.push('4. 只给**阶段和小目标**写归属（任务会跟随它所属的小目标），确保每条小目标都有归属；一条条件至少对应一个小目标。');
    lines.push('5. 只输出一个 JSON 对象，不要任何解释或代码块标记：');
    lines.push('{"conditions":[{"key":"c1","title":"","detail":"","acceptance":"","jd":"对应依据原文/条款","priority":"must"}],"map":[{"node_id":12,"condition":"c1"}]}');
    return lines.join('\n');
  }
  async function generateFromNodes(goalId) {
    goalId = Number(goalId);
    const goal = goalOf(goalId);
    if (!goal) throw new Error('目标不存在');
    const nodes = db.prepare('SELECT id, parent_id, level, title, detail, condition_id, sort_order FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
    if (!nodes.length) throw new Error('这个目标还没有路线图节点：先完成规划，再来梳理达成条件');
    if (typeof aiText !== 'function') throw new Error('当前环境没有可用的 AI');
    const existing = db.prepare('SELECT * FROM goal_conditions WHERE goal_id = ? ORDER BY sort_order, id').all(goalId);
    const prompt = buildPrompt(goal, nodes, existing);
    /* 有没有 JD 材料决定这次是"按 JD 条款重写"还是"按公共 AIPM JD 兜底" —— 界面提示要说准。 */
    const goalTypeBlob = [goal.title, goal.profile, goal.materials, goal.summary].map(x => String(x || '')).join(' ');
    const jobLikeGoal = /求职|转行|找工作|实习|校招|社招|面试|简历|岗位|招聘|JD|offer|职业/i.test(goalTypeBlob);
    const jdFound = jobLikeGoal && /【用户提供的参考资料|【资料库里的 JD|【目标类型】求职/.test(prompt);
    let raw = await aiText(prompt, currentModel(), 300000, null, null, '达成条件');
    let data = firstJSON(raw);
    /* 14 条条件 + 每个阶段/小目标的 map，输出容易超长被截断（真实踩到：JSON 断了 →
       firstJSON 拿不到 → 用户看到"AI 没给出可用的达成条件"）。补一次**更短输出**的重试。 */
    if (!data || !Array.isArray(data.conditions) || !data.conditions.length) {
      const retryPrompt = prompt + '\n\n【重要】上一次输出无法解析（可能太长被截断）。请重新输出一个**合法 JSON 对象**：条件最多 12 条，每条 detail ≤60 字、jd ≤100 字、acceptance ≤60 字；map 只给阶段和小目标（不要给任务）；不要代码块、不要解释、不要尾逗号。';
      raw = await aiText(retryPrompt, currentModel(), 300000, null, null, '达成条件（重试）');
      data = firstJSON(raw);
    }
    if (!data || !Array.isArray(data.conditions) || !data.conditions.length) {
      console.log('[conditions] 生成结果无法解析，原始输出前 300 字:', String(raw || '').slice(0, 300).replace(/\n/g, ' '));
      throw new Error('AI 没有给出可用的达成条件（可能输出太长被截断），请重试一次或手动新建');
    }
    const saved = saveFromPlan(goalId, { conditions: data.conditions });
    const byId = new Map(nodes.map(n => [n.id, n]));
    const items = Array.isArray(data.map) ? data.map : (Array.isArray(data.assignments) ? data.assignments : []);
    const mapped = [];
    for (const it of items) {
      if (!it) continue;
      const nid = Number(it.node_id != null ? it.node_id : (it.id != null ? it.id : it.nodeId));
      const n = byId.get(nid);
      if (!n) continue;
      const cid = saved.resolve(it.condition != null ? it.condition : (it.condition_key != null ? it.condition_key : it.condition_id));
      if (!cid) continue;
      mapped.push({ node: n, cid: cid });
    }
    tx(() => {
      const upd = db.prepare('UPDATE nodes SET condition_id = ?, updated_at = ? WHERE id = ?');
      const t = nowISO();
      const applySubtree = m => {
        upd.run(m.cid, t, m.node.id);
        for (const cid of descendants(goalId, m.node.id)) upd.run(m.cid, t, cid);
      };
      const levels = [0, 1, 2, 3, 4, 5];
      for (const lv of levels) {
        for (const m of mapped.filter(x => Number(x.node.level) === lv)) {
          if (lv <= 1) applySubtree(m); else upd.run(m.cid, t, m.node.id);
        }
      }
    });
    /* 轻量自检：条件标题如果和阶段/小目标名高度重合，多半是"把计划节点写成了条件"，
       而不是 JD 要求（用户反馈过「思而行闭环与证据跑通」这种）。只提示、不擅自改名。 */
    const warnings = [];
    try {
      const lcs = (a, b) => {
        let best = 0;
        const m = a.length, n = b.length;
        const dp = new Array(n + 1).fill(0);
        for (let i = 1; i <= m; i++) {
          let prev = 0;
          for (let j = 1; j <= n; j++) {
            const cur = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
            if (dp[j] > best) best = dp[j];
            prev = cur;
          }
        }
        return best;
      };
      const nodeTitles = nodes.filter(n => Number(n.level) <= 1).map(n => String(n.title || '')).filter(Boolean);
      for (const d of saved.defs) {
        const t = String(d.title || '');
        if (!t) continue;
        if (nodeTitles.some(nt => t.includes(nt) || nt.includes(t) || lcs(t, nt) >= 6)) warnings.push(t);
      }
    } catch (e) {}
    return { conditions: saved.defs.length, assigned: mapped.length, jd_found: jdFound, warnings: warnings, data: list(goalId) };
  }

  return {
    ensureSchema: ensureSchema,
    countForGoal: countForGoal,
    normalizePlanConditions: normalizePlanConditions,
    saveFromPlan: saveFromPlan,
    resolveId: resolveId,
    list: list,
    assign: assign,
    saveManual: saveManual,
    remove: remove,
    generateFromNodes: generateFromNodes,
    buildPrompt: buildPrompt
  };
}

module.exports = { createConditionsDomain: createConditionsDomain, normalizePlanConditions: normalizePlanConditions, SCHEMA: SCHEMA, firstJSON: firstJSON };
