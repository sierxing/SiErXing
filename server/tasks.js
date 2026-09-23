'use strict';
/**
 * 后台 AI 任务队列
 *   · 提交的任务在服务端后台执行：切换页面 / 关闭页面都不影响
 *   · 并发执行（默认 3 个），超出部分排队
 *   · 每个任务有进度、状态、备注、结果；可取消
 *   · 前端轮询 /api/tasks 获取列表（任意页面都能显示进度）
 */
module.exports = function createTasks({ log = () => {}, maxConcurrent = 3 } = {}) {
  const tasks = new Map();
  let seq = 0;

  const pub = t => ({
    id: t.id, type: t.type, title: t.title, goalId: t.goalId, nodeId: t.nodeId,
    note: t.note, status: t.status, message: t.message, progress: t.progress,
    createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
    error: t.error, result: t.result
  });

  const list = (goalId) => [...tasks.values()]
    .filter(t => !goalId || Number(t.goalId) === Number(goalId))
    .sort((a, b) => a.id - b.id)
    .map(pub);

  const running = () => [...tasks.values()].filter(t => t.status === 'running');
  const queued = () => [...tasks.values()].filter(t => t.status === 'queued');

  function pump() {
    while (running().length < maxConcurrent) {
      const next = queued()[0];
      if (!next) break;
      next.status = 'running';
      next.startedAt = Date.now();
      next.message = next.message || '开始处理…';
      const ac = new AbortController();
      next._abort = ac;
      log('[task] 开始 #' + next.id, next.type, next.title);
      (async () => {
        try {
          const r = await next._run({
            signal: ac.signal,
            note: next.note,
            progress: (p, msg) => {
              if (p != null) next.progress = Math.max(0, Math.min(100, Math.round(p)));
              if (msg) next.message = String(msg).slice(0, 200);
            }
          });
          next.status = 'done';
          next.progress = 100;
          next.message = next.message || '完成';
          next.result = r || null;
          log('[task] 完成 #' + next.id, next.type);
        } catch (e) {
          if (e && (e.cancelled || e.name === 'AbortError')) {
            next.status = 'cancelled';
            next.message = '已停止';
          } else {
            next.status = 'failed';
            next.error = e && e.message ? e.message : String(e);
            next.message = '失败：' + next.error.slice(0, 120);
          }
          log('[task] 结束 #' + next.id, next.status, next.error || '');
        } finally {
          next.endedAt = Date.now();
          next._abort = null;
          pump();
        }
      })();
    }
  }

  /** 提交任务：run({ signal, note, progress }) 返回结果 */
  function submit({ type, title, goalId, nodeId, note, run, message }) {
    const id = ++seq;
    tasks.set(id, {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'queued', message: message || '排队中…',
      progress: 0, createdAt: Date.now(), startedAt: 0, endedAt: 0, error: '', result: null,
      _run: run, _abort: null
    });
    pump();
    return id;
  }

  function cancel(id) {
    const t = tasks.get(Number(id));
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'queued') { t.status = 'cancelled'; t.message = '已取消'; t.endedAt = Date.now(); pump(); return { ok: true }; }
    if (t.status === 'running' && t._abort) { try { t._abort.abort(); } catch (e) {} return { ok: true }; }
    return { ok: false, error: '任务已结束' };
  }

  /** 清理：删除已结束的任务记录 */
  function clear(goalId) {
    for (const [id, t] of [...tasks.entries()]) {
      if (goalId && Number(t.goalId) !== Number(goalId)) continue;
      if (['done', 'failed', 'cancelled'].includes(t.status)) tasks.delete(id);
    }
    return { ok: true };
  }

  /* 手动模式：用于"流式接口 + 前端展示"的既有 AI 流程
     —— 任务立刻标记为 running，由调用方通过 progress/done/fail 汇报；客户端断开不会中断 */
  function begin({ type, title, goalId, nodeId, note, message }) {
    const id = ++seq;
    const ac = new AbortController();
    const t = {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'running', message: message || '处理中…',
      progress: 0, createdAt: Date.now(), startedAt: Date.now(), endedAt: 0, error: '', result: null,
      _run: null, _abort: ac
    };
    tasks.set(id, t);
    log('[task] 开始 #' + id, type, t.title);
    return {
      id,
      signal: ac.signal,
      progress: (p, msg) => { if (p != null) t.progress = Math.max(0, Math.min(100, Math.round(p))); if (msg) t.message = String(msg).slice(0, 200); },
      done: (result) => { t.status = 'done'; t.progress = 100; t.message = t.message || '完成'; t.result = result || null; t.endedAt = Date.now(); t._abort = null; log('[task] 完成 #' + id, type); },
      fail: (e) => {
        if (e && (e.cancelled || e.name === 'AbortError')) { t.status = 'cancelled'; t.message = '已停止'; }
        else { t.status = 'failed'; t.error = (e && e.message) || String(e); t.message = '失败：' + t.error.slice(0, 120); }
        t.endedAt = Date.now(); t._abort = null; log('[task] 结束 #' + id, t.status, t.error || '');
      }
    };
  }

  function status() {
    return { total: tasks.size, running: running().length, queued: queued().length, maxConcurrent };
  }

  return { submit, begin, list, cancel, clear, status };
};
