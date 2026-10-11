'use strict';
/**
 * 后台 AI 任务队列
 *   · 提交的任务在服务端后台执行：切换页面 / 关闭页面都不影响
 *   · 并发执行（默认 3 个），超出部分排队
 *   · 每个任务有进度、状态、备注、结果；可取消
 *   · 前端轮询 /api/tasks 获取列表（任意页面都能显示进度）
 */
module.exports = function createTasks({ log = () => {}, maxConcurrent = 3, metrics = null } = {}) {
  const tasks = new Map();
  let seq = 0;
  /* 任务健壮性埋点（P3）。
     为什么要落库：任务状态只在这个内存 Map 里，**进程一重启历史全丢**，
     于是"上周成功率多少""重试救回来多少次"永远算不出来。
     落库点就三处状态流转：提交 → 开跑 → 结束，写不进去也不影响任务本身。 */
  const M = metrics;

  const pub = t => ({
    id: t.id, type: t.type, title: t.title, goalId: t.goalId, nodeId: t.nodeId,
    note: t.note, status: t.status, message: t.message, progress: t.progress,
    createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
    error: t.error, result: t.result,
    canRetry: typeof t._retry === 'function', retrying: !!t.retrying
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
          if (M) {
            try {
              M.insTask({
                goalId: next.goalId, nodeId: next.nodeId, type: next.type, title: next.title,
                status: next.status, attempts: 1, error: next.error || '',
                costMs: Math.max(0, next.endedAt - next.createdAt)
              });
            } catch (e) {}
          }
          pump();
        }
      })();
    }
  }

  /** 提交任务：run({ signal, note, progress }) 返回结果 */
  function submit({ type, title, goalId, nodeId, note, run, message, retry }) {
    const id = ++seq;
    tasks.set(id, {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'queued', message: message || '排队中…',
      progress: 0, createdAt: Date.now(), startedAt: 0, endedAt: 0, error: '', result: null,
      _run: run, _abort: null, _retry: typeof retry === 'function' ? retry : null
    });
    if (M) { try { M.insTask({ goalId, nodeId, type, title, status: 'queued', attempts: 1 }); } catch (e) {} }
    pump();
    return id;
  }

  /* ---- 失败重试 ----
     用户不想为了重跑一次 AI 任务再把那句话/那条意见重新打一遍（线上真这么骂过）。
     重试 = 用当初那份入参重新提交一个新任务，所以旧任务原样保留（还能看它当时的报错）。
     retryFactory 由调用方（server.js）注入：从「当前请求」生成闭包，
     于是所有任务类型都能白拿重试能力，不必各自重构。 */
  let retryFactory = null;
  function setRetryFactory(fn) { retryFactory = typeof fn === 'function' ? fn : null; }
  function autoRetry() {
    if (!retryFactory) return null;
    try { const f = retryFactory(); return typeof f === 'function' ? f : null; } catch (e) { return null; }
  }
  /* 重试返回的可能是 Promise（比如"把当初那次请求原样再发一遍"要走 HTTP），
     所以这里是 async；taskId 拿不到就靠 retrying 标记让前端继续轮询 */
  async function retry(id) {
    const t = tasks.get(Number(id));
    if (!t) return { ok: false, error: '任务不存在（可能已刷新页面或重启过服务）' };
    if (running().some(x => x.id === t.id) || queued().some(x => x.id === t.id)) return { ok: false, error: '这个任务还在跑，先等它结束' };
    if (!t._retry) return { ok: false, error: '这个任务不支持重试（在页面里重新发起一次即可）' };
    t.message = '正在重新提交…';
    t.retrying = true;
    let nid = 0;
    try { nid = await t._retry(); } catch (e) {
      t.retrying = false;
      return { ok: false, error: '重试失败：' + (e && e.message ? e.message : String(e)) };
    }
    t.retrying = false;
    if (!nid) return { ok: true, taskId: 0, note: '已重新提交，进度会在左下角任务中心出现' };
    return { ok: true, taskId: nid };
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

  /* 结束的任务（done/failed/cancelled）才允许重试；进行中的按钮前端会置灰 */
  function retryable(id) {
    const t = tasks.get(Number(id));
    return !!(t && typeof t._retry === 'function' && ['done', 'failed', 'cancelled'].includes(t.status));
  }

  /* 手动模式：用于"流式接口 + 前端展示"的既有 AI 流程
     —— 任务立刻标记为 running，由调用方通过 progress/done/fail 汇报；客户端断开不会中断 */
  function begin({ type, title, goalId, nodeId, note, message, retry }) {
    const id = ++seq;
    const ac = new AbortController();
    const t = {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'running', message: message || '处理中…',
      progress: 0, createdAt: Date.now(), startedAt: Date.now(), endedAt: 0, error: '', result: null,
      _run: null, _abort: ac,
      _retry: typeof retry === 'function' ? retry : autoRetry()
    };
    tasks.set(id, t);
    if (M) { try { M.insTask({ goalId, nodeId, type, title, status: 'running', attempts: 1 }); } catch (e) {} }
    log('[task] 开始 #' + id, type, t.title);
    return {
      id,
      signal: ac.signal,
      progress: (p, msg) => { if (p != null) t.progress = Math.max(0, Math.min(100, Math.round(p))); if (msg) t.message = String(msg).slice(0, 200); },
      done: (result) => { t.status = 'done'; t.progress = 100; t.message = t.message || '完成'; t.result = result || null; t.endedAt = Date.now(); t._abort = null; if (M) { try { M.insTask({ goalId, nodeId, type, title, status: 'done', costMs: t.endedAt - t.createdAt }); } catch (e) {} } log('[task] 完成 #' + id, type); },
      fail: (e) => {
        if (e && (e.cancelled || e.name === 'AbortError')) { t.status = 'cancelled'; t.message = '已停止'; }
        else { t.status = 'failed'; t.error = (e && e.message) || String(e); t.message = '失败：' + t.error.slice(0, 120); }
        t.endedAt = Date.now(); t._abort = null;
        if (M) { try { M.insTask({ goalId, nodeId, type, title, status: t.status, error: t.error || '', costMs: t.endedAt - t.createdAt }); } catch (e) {} }
        log('[task] 结束 #' + id, t.status, t.error || '');
      }
    };
  }

  function status() {
    return { total: tasks.size, running: running().length, queued: queued().length, maxConcurrent };
  }

  return { submit, begin, list, cancel, clear, status, retry, retryable, setRetryFactory };
};
