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
    canRetry: typeof t._retry === 'function', retrying: !!t.retrying, cancelling: !!t.cancelling,
    /* 距上一次"有进展"多久。前端据此把"进度恒 0%、计时器一直跳"的任务标出来
       （真实翻过：任务 6 分 38 秒没动静，用户只能干等）。
       用服务端算好的毫秒数而不是时间戳，免去前后端时钟不同步的麻烦。 */
    idleMs: t._tick ? Math.max(0, Date.now() - t._tick) : 0,
    /* 阶段清单 + 模型此刻在想什么：前端据此画动效进度条。
       steps 是「这次的阶段划分」，由任务自己声明（有的任务只有一步，有的九步）；
       thinking 是模型正在输出的推理/正文尾部，只在 running 时有意义。 */
    steps: t.steps || null,
    thinking: t.thinking || '',
    eta: t.eta || ''
  });

  const list = (goalId) => [...tasks.values()]
    .filter(t => !goalId || Number(t.goalId) === Number(goalId))
    .sort((a, b) => a.id - b.id)
    .map(pub);

  const running = () => [...tasks.values()].filter(t => t.status === 'running');
  const queued = () => [...tasks.values()].filter(t => t.status === 'queued');

  /* ---- 终态收口 + 看门狗 ----
     为什么要收口：任务的**每一条退出路径**都必须落到 done/failed/cancelled。
     真实翻过：拆分任务的"按意见调整"那条分支里漏了 done()，AI 早就跑完、节点也写进库了，
     任务卡片却一直显示"进行中 6 分 38 秒"（进度恒 0%），用户以为还在跑 ——
     其实永远不会再有下一步。这里两件事：
       ① finalize() 统一落终态，且**只生效一次**（看门狗先判定失败后，
         原本挂住的 _run 哪天回来了也不许把 failed 覆盖成 done）；
       ② 无进展超时：距上次 progress/消息更新超过 stallMs 还是 running → 判定失败，
          给出人话原因，并 abort 掉底层调用。
     默认 12 分钟：比代码里最长的单次 AI 超时（600s）还宽，宁可晚一点误判，
     也不能把正在跑的长任务掐死。可用 SIERXING_TASK_STALL_MS 调（测试用得到）。 */
  const stallMs = Math.max(5000, Number(process.env.SIERXING_TASK_STALL_MS) || 12 * 60 * 1000);
  const touch = t => { t._tick = Date.now(); };
  const humanMs = ms => (ms < 60000 ? Math.round(ms / 1000) + ' 秒' : Math.round(ms / 60000) + ' 分钟');

  function finalize(t, status, opts) {
    if (!t || t._final) return false;
    const o = opts || {};
    t._final = true;
    t.status = status;
    if (status === 'done') { t.progress = 100; t.message = t.message || '完成'; }
    if (status === 'cancelled') t.message = '已停止';
    if (status === 'failed') {
      t.error = o.error ? String(o.error) : (t.error || '未知错误');
      t.message = o.message || ('失败：' + t.error.slice(0, 120));
    }
    if (o.result !== undefined) t.result = o.result;
    t.endedAt = Date.now();
    t._abort = null;
    t.cancelling = false;
    if (M) {
      try {
        const st = { status: t.status, error: t.error || '', costMs: Math.max(0, t.endedAt - t.createdAt) };
        if (t._runRow) M.updTask(t._runRow, st);
        else {
          t._runRow = M.insTask({ goalId: t.goalId, nodeId: t.nodeId, type: t.type, title: t.title, attempts: 1, ...st });
        }
      } catch (e) {}
    }
    pump();
    return true;
  }

  /* 看门狗：只在有 running 任务时才转，进程退出不拦（unref） */
  let watchdog = null;
  function startWatchdog() {
    if (watchdog) return;
    const every = Math.max(1000, Math.min(30000, Math.floor(stallMs / 4)));
    watchdog = setInterval(() => {
      const now = Date.now();
      for (const t of tasks.values()) {
        if (t.status !== 'running' || t._final || !t._tick) continue;
        if (now - t._tick < stallMs) continue;
        const idle = humanMs(now - t._tick);
        log('[task] 看门狗：#' + t.id, t.type, '已 ' + idle + '没有任何进展，判定失败');
        try { if (t._abort) t._abort.abort(); } catch (e) {}
        finalize(t, 'failed', {
          error: '任务卡住了：已经 ' + idle + '没有任何进展（AI 调用没返回、或有分支忘了收尾），已自动停止',
          message: '可能卡住了：' + idle + '没有进展，已自动停止'
        });
      }
    }, every);
    if (watchdog.unref) watchdog.unref();
  }
  startWatchdog();

  function pump() {
    while (running().length < maxConcurrent) {
      const next = queued()[0];
      if (!next) break;
      next.status = 'running';
      next.startedAt = Date.now();
      next.message = next.message || '开始处理…';
      const ac = new AbortController();
      next._abort = ac;
      touch(next);
      log('[task] 开始 #' + next.id, next.type, next.title);
      (async () => {
        try {
          const r = await next._run({
            signal: ac.signal,
            note: next.note,
            progress: (p, msg, extra) => {
              touch(next);   // 有进展就刷新看门狗
              if (p != null) next.progress = Math.max(0, Math.min(100, Math.round(p)));
              if (msg) next.message = String(msg).slice(0, 200);
              /* extra 用来带"这次任务分哪几个阶段、现在卡在哪一步、模型在想什么"。
                 只有传了才覆盖 —— 阶段清单在整个任务里是稳定的，每帧都重发没意义。 */
              if (extra && typeof extra === 'object') {
                if (Array.isArray(extra.steps)) next.steps = extra.steps.map(s => ({
                  key: String(s.key || ''),
                  label: String(s.label || '').slice(0, 40),
                  state: s.state === 'done' ? 'done' : (s.state === 'active' ? 'active' : 'pending'),
                  detail: String(s.detail || '').slice(0, 80)
                }));
                if (extra.thinking != null) next.thinking = String(extra.thinking).slice(-220);
                if (extra.eta != null) next.eta = String(extra.eta).slice(0, 40);
              }
            }
          });
          log('[task] 完成 #' + next.id, next.type);
          /* 只写状态，收尾动作（endedAt / 落库 / pump）统一走 finalize ——
             任务卡住时就是靠它保证"任何退出路径都有终态"。 */
          finalize(next, 'done', { result: r || null });
        } catch (e) {
          if (e && (e.cancelled || e.name === 'AbortError')) {
            log('[task] 结束 #' + next.id, 'cancelled');
            finalize(next, 'cancelled');
          } else {
            const msg = e && e.message ? e.message : String(e);
            log('[task] 结束 #' + next.id, 'failed', msg);
            finalize(next, 'failed', { error: msg });
          }
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
      _run: run, _abort: null, _retry: typeof retry === 'function' ? retry : null,
      _tick: Date.now(), _final: false
    });
    if (M) {
      try {
        const rid = M.insTask({ goalId, nodeId, type, title, status: 'queued', attempts: 1 });
        const t = tasks.get(id); if (t) t._runRow = rid;   // 之后所有状态变化都更新这一行
      } catch (e) {}
    }
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
    if (t.status === 'queued') { finalize(t, 'cancelled'); return { ok: true }; }
    if (t.status === 'running' && t._abort) {
      /* 立刻改文案并打标记：以前这里只 abort()，任务卡片还停在原步骤那句话
         （"正在撰写第 5 节…"），看着像点了没反应。
         ⚠️ abort() 只能掐掉**当前那一次** AI 请求，剩下的步骤得靠各流程自己在
         步间检查 signal —— 这里同时给出 cancelling，让界面如实说"正在停止"。 */
      t.cancelling = true;
      t.message = '正在停止…';
      try { t._abort.abort(); } catch (e) {}
      /* 兜底：有些分支早已跑完、只是漏了 done()（进程不重启就永远 running）。
         这时候 abort 谁也掐不到，卡片会一直"正在停止…"。给个宽限期，到点按取消落终态。 */
      const tid = t.id;
      const grace = setTimeout(() => {
        const x = tasks.get(tid);
        if (x && x.status === 'running' && x.cancelling && !x._final) {
          log('[task] 取消宽限到点，#' + tid, '直接落终态（没有可中断的调用在跑）');
          finalize(x, 'cancelled');
        }
      }, Math.min(30000, Math.max(5000, Math.floor(stallMs / 4))));
      if (grace.unref) grace.unref();
      return { ok: true };
    }
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
      _run: null, _abort: ac, _final: false,
      _retry: typeof retry === 'function' ? retry : autoRetry()
    };
    tasks.set(id, t);
    touch(t);
    /* 开始就落一行 task_runs。以前 begin 这条路只在结束时 updTask，但 _runRow 从没被赋过值 ——
       于是一条卡住的 begin 任务在 task_runs 里**一行都没有**（现场就是这样：表里只有 #75~77，
       卡住的 #2 查无此行），事后根本看不出它发生过。 */
    if (M) { try { t._runRow = M.insTask({ goalId: t.goalId, nodeId: t.nodeId, type: t.type, title: t.title, status: 'running', attempts: 1 }); } catch (e) {} }
    log('[task] 开始 #' + id, type, t.title);
    return {
      id,
      signal: ac.signal,
      /* extra = { steps, thinking }：给前端画动效进度条用。
         ⚠️ 这一支（begin）才是教程生成走的路，pump 里那一支是 submit 走的 ——
         两处都要认 extra，只改一处会出现"规划流程的进度条永远停在 0%"。 */
      progress: (p, msg, extra) => {
        touch(t);
        if (p != null) t.progress = Math.max(0, Math.min(100, Math.round(p)));
        if (msg) t.message = String(msg).slice(0, 200);
        if (extra && typeof extra === 'object') {
          if (Array.isArray(extra.steps)) t.steps = extra.steps.map(s => ({
            key: String(s.key || ''),
            label: String(s.label || '').slice(0, 40),
            state: s.state === 'done' ? 'done' : (s.state === 'active' ? 'active' : 'pending'),
            detail: String(s.detail || '').slice(0, 80)
          }));
          if (extra.thinking != null) t.thinking = String(extra.thinking).slice(-220);
          if (extra.eta != null) t.eta = String(extra.eta).slice(0, 40);
        }
      },
      done: (result) => { log('[task] 完成 #' + id, type); finalize(t, 'done', { result: result || null }); },
      fail: (e) => {
        if (e && (e.cancelled || e.name === 'AbortError')) { log('[task] 结束 #' + id, 'cancelled'); finalize(t, 'cancelled'); }
        else {
          const msg = (e && e.message) || String(e);
          log('[task] 结束 #' + id, 'failed', msg);
          finalize(t, 'failed', { error: msg });
        }
      }
    };
  }

  function status() {
    return { total: tasks.size, running: running().length, queued: queued().length, maxConcurrent };
  }

  return { submit, begin, list, cancel, clear, status, retry, retryable, setRetryFactory };
};
