'use strict';
/**
 * 思而行 · 达成条件（conditions）
 * ------------------------------------------------------------------
 * 用户要解决的问题：原来的规划只有「阶段」，但阶段 ≠ 达成目标的条件。
 * 这个基础功能组件把「要达成目标必须满足哪些条件」单独拎出来：
 *   · 每条条件带可验收的判定标准（acceptance）；
 *   · 路线图上的节点（阶段 / 小目标 / 任务）都归到某条条件下面；
 *   · 组件页按条件看推进进度（完成节点数 / 总节点数）和对应节点。
 *
 * 数据由 server/conditions.js（领域层）负责；规划生成骨架时就会写进来
 * （见 server.js 的 saveSkeleton / ensureConditionsFromPlan）。
 * 这个文件只提供 HTTP 接口：读 / 手动新建编辑 / 调整节点归属 / 从现有路线图 AI 提取。
 */
let db, nowISO, safeParse, sendJSON, readBody, backup, log, conditions, aiText, currentModel, tasks;

function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, backup, log, conditions, aiText, currentModel, tasks } = ctx);
}
function goalOf(id) { return db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(id)) || null; }

module.exports = {
  id: 'conditions',
  name: '达成条件',
  icon: '🎯',
  desc: '把「要达成目标必须满足的条件」从阶段里独立出来：每个条件都能看到推进进度与对应路线图节点',
  category: '基础功能组件',
  scope: 'base',           // 与问卷/约束/版本一样，属于内置基础功能组件
  builtin: true,           // 随应用分发：不显示"第三方组件"标签，也不提供卸载（同 jdfile）
  order: 9,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/conditions.js',

  init(ctx) {
    bind(ctx);
    try { conditions.ensureSchema(); } catch (e) { log('[conditions] 建表失败:', e.message); }
  },

  onGoalDelete(goalId) {
    try { db.prepare('DELETE FROM goal_conditions WHERE goal_id = ?').run(Number(goalId)); } catch (e) {}
  },

  api: [
    /* 读某个目标的全部达成条件 + 进度 + 对应节点 + 未归属节点 */
    {
      method: 'GET', pattern: /^\/api\/goals\/(\d+)\/conditions$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/^\/api\/goals\/(\d+)\/conditions$/)[1]);
        const g = goalOf(gid);
        if (!g) return sendJSON(res, 404, { error: '目标不存在' });
        return sendJSON(res, 200, conditions.list(gid));
      }
    },
    /* 手动新建 / 编辑一条条件（source=manual；编辑 AI 条件也可以） */
    {
      method: 'POST', pattern: /^\/api\/goals\/(\d+)\/conditions$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/^\/api\/goals\/(\d+)\/conditions$/)[1]);
        if (!goalOf(gid)) return sendJSON(res, 404, { error: '目标不存在' });
        const body = await readBody(req).catch(() => ({}));
        try {
          const out = conditions.saveManual(gid, body);
          backup();
          return sendJSON(res, 200, { ok: true, id: out.id, data: out.data });
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
    },
    /* 从现有路线图让 AI 反推条件并自动归属（老目标 / 导入目标用；新规划会自动产出） */
    {
      method: 'POST', pattern: /^\/api\/goals\/(\d+)\/conditions\/generate$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/^\/api\/goals\/(\d+)\/conditions\/generate$/)[1]);
        if (!goalOf(gid)) return sendJSON(res, 404, { error: '目标不存在' });
        let job = null;
        try {
          job = tasks.begin({ type: 'conditions', title: '梳理达成条件', goalId: gid, message: 'AI 正在从路线图梳理「要达成目标需要满足哪些条件」' });
          const out = await conditions.generateFromNodes(gid);
          if (job) job.done({ conditions: out.conditions, assigned: out.assigned });
          backup();
          return sendJSON(res, 200, { ok: true, generated: out.conditions, assigned: out.assigned, data: out.data });
        } catch (e) {
          if (job) job.fail(e);
          return sendJSON(res, 400, { error: e.message || '梳理失败' });
        }
      }
    },
    /* 调整节点归属：{map:{nodeId:condId}} 精确；或 {condition_id,node_ids,cascade} */
    {
      method: 'POST', pattern: /^\/api\/goals\/(\d+)\/conditions\/assign$/,
      handler: async (req, res, u) => {
        const gid = Number(u.pathname.match(/^\/api\/goals\/(\d+)\/conditions\/assign$/)[1]);
        if (!goalOf(gid)) return sendJSON(res, 404, { error: '目标不存在' });
        const body = await readBody(req).catch(() => ({}));
        try {
          const out = conditions.assign(gid, body);
          backup();
          return sendJSON(res, 200, { ok: true, changed: out.changed, data: out.data });
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
    },
    /* 删除一条条件（节点自动回到未归属） */
    {
      method: 'DELETE', pattern: /^\/api\/conditions\/(\d+)$/,
      handler: async (req, res, u) => {
        const cid = Number(u.pathname.match(/^\/api\/conditions\/(\d+)$/)[1]);
        try {
          const out = conditions.remove(cid);
          backup();
          return sendJSON(res, 200, { ok: true, deleted: out.deleted, data: out.data });
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
    }
  ]
};
