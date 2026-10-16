'use strict';
/**
 * 后台 AI 任务队列
 *   · 提交的任务在服务端后台执行：切换页面 / 关闭页面都不影响
 *   · 并发执行（默认 3 个），超出部分排队
 *   · 每个任务有进度、状态、备注、结果；可取消
 *   · 前端轮询 /api/tasks 获取列表（任意页面都能显示进度）
 *
 * ⚠️ 进度**只有一套模型**（`server/task-progress.js`），`begin` 与 `submit` 两条路共用。
 *   以前这两条路各写了一遍 extra 处理，漏一处就是"某类任务的进度条永远停在 0%"；
 *   现在任何任务（哪怕一句进度都不报）都会拿到一条会动、且**带来源标注**的条，
 *   任务自己再按 `phase / count / note` 把"估算"换成"真实"。
 */
const progressEngine = require('./task-progress');

module.exports = function createTasks({ log = () => {}, maxConcurrent = 3, metrics = null } = {}) {
  const tasks = new Map();
  let seq = 0;
  /* 任务健壮性埋点（P3）。
     为什么要落库：任务状态只在这个内存 Map 里，**进程一重启历史全丢**，
     于是"上周成功率多少""重试救回来多少次"永远算不出来。
     落库点就三处状态流转：提交 → 开跑 → 结束，写不进去也不影响任务本身。 */
  const M = metrics;

  /* 对外的一份任务快照。
     ⚠️ 进度是**每次读的时候现算**的（而不是等任务来推）：时间估算型要"没人报也在走"，
     而前端是 1.5 秒轮询一次 —— 靠事件推根本推不出这个效果。 */
  const pub = t => {
    const live = t.status === 'running' && t._prog && !t._final;
    if (live) t._snap = t._prog.snapshot();
    const s = live ? t._snap : (t._snap || null);
    const done = t.status === 'done';
    return {
      id: t.id, type: t.type, title: t.title, goalId: t.goalId, nodeId: t.nodeId,
      note: t.note, status: t.status, message: t.message,
      /* 结束的任务用落定的值；跑着的用刚算出来的 */
      progress: live ? s.pct : t.progress,
      /* 百分比从哪来：count=真实计数 / set=任务自己算的 / phase=阶段推进 /
         time=按时间估算（前端要把它标成"估算"）/ final=已完成 */
      pctSource: live ? s.source : (done ? 'final' : (s ? s.source : '')),
      /* 阶段：前端据此画"第 2/4 步"和那一排阶段点 */
      phaseIndex: s ? s.phaseIndex : 0,
      phaseCount: s ? s.phaseCount : 0,
      phaseLabel: s ? s.phaseLabel : '',
      done: s ? s.done : 0,
      total: s ? s.total : 0,
      elapsedMs: s ? s.elapsedMs : (t.startedAt ? Math.max(0, (t.endedAt || Date.now()) - t.startedAt) : 0),
      createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
      error: t.error, result: t.result,
      /* 子任务：parentId 指向主任务。任务栏里折叠进主任务下面显示
         （"看懂代码"一次会并行派好几个模块，全平铺出来会把任务栏撑爆）。 */
      parentId: t.parentId || 0,
      canRetry: typeof t._retry === 'function', retrying: !!t.retrying, cancelling: !!t.cancelling,
      /* 距上一次"有进展"多久。前端据此把"进度恒 0%、计时器一直跳"的任务标出来
         （真实翻过：任务 6 分 38 秒没动静，用户只能干等）。
         用服务端算好的毫秒数而不是时间戳，免去前后端时钟不同步的麻烦。 */
      idleMs: t._tick ? Math.max(0, Date.now() - t._tick) : 0,
      /* 这条失败"有救"：它的错因是"AI 动了不该动的结构"这类，
         重跑之前先放行一次就能成 —— 前端据此多给一个按钮。
         （否则用户只会去点「🔄 重试」，而那是同一份入参，注定再失败一次。） */
      canAllowRestructure: !!t._restructureFail,
      /* 阶段清单 + 模型此刻在想什么：前端据此画动效进度条。
         调用方自己维护的（_stepsOwn）优先，否则用引擎按阶段声明推出来的。 */
      steps: t._stepsOwn ? (t.steps || null) : (s ? s.steps : (t.steps || null)),
      thinking: s ? s.thinking : (t.thinking || ''),
      eta: s ? s.eta : (t.eta || '')
    };
  };


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

  /* ---- 统一的进度入口 ----
     所有进度都从这几个函数进，**不再有第二处**：submit 那条路（pump 里）和 begin 那条路
     返回的是同一批方法名。以前两条路各写一遍 extra 解析，漏一处就是某类任务永远 0%。 */
  function mkEngine(o) {
    return progressEngine.create({
      phases: o && o.phases,
      phaseNote: o && o.phaseNote,
      total: o && o.total,
      expectedMs: o && o.expectedMs
    });
  }
  /* 调用方显式给了阶段点（老写法：自己维护一个 steps 数组）就原样存；
     否则用引擎按阶段声明推出来的。两种都能被前端同一套渲染画出来。 */
  function takeSteps(t, steps) {
    t.steps = steps.map(s => ({
      key: String(s.key || ''),
      label: String(s.label || '').slice(0, 40),
      state: s.state === 'done' ? 'done' : (s.state === 'active' ? 'active' : 'pending'),
      detail: String(s.detail || '').slice(0, 80)
    }));
    t._stepsOwn = true;
  }
  const say = (t, msg) => { if (msg) t.message = String(msg).slice(0, 200); };
  /* 老 API：progress(百分比, 文案, extra)。extra.steps/thinking/eta 都还认。 */
  function applyProgress(t, p, msg, extra) {
    touch(t);
    say(t, msg);
    if (!t._prog) { if (p != null) t.progress = Math.max(0, Math.min(100, Math.round(p))); return; }
    if (p != null) t._prog.set(p, null);
    if (extra && typeof extra === 'object') {
      if (Array.isArray(extra.steps)) takeSteps(t, extra.steps);
      if (extra.thinking != null) t._prog.note(extra.thinking);
      if (extra.eta != null) t._prog.eta(extra.eta);
      if (extra.count && typeof extra.count === 'object') t._prog.count(extra.count.done, extra.count.total, null);
    }
  }
  /* 新 API（三个糖）：任务只声明"我走到哪了"，百分比怎么算归引擎 */
  function applyPhase(t, i, msg, o) {
    touch(t);
    say(t, msg);
    if (!t._prog) return;
    t._prog.phase(i, null, o);
    /* 只声明阶段、没给文案时，用**阶段自己的名字**兜底。
       否则卡片会停在上一步那句话上（"正在切分资料…"挂到了向量化阶段），很误导。 */
    if (!msg) {
      const s = t._prog.snapshot();
      if (s && s.phaseMsg) t.message = String(s.phaseMsg).slice(0, 200);
    }
  }
  function applyCount(t, done, total, msg) { touch(t); say(t, msg); if (t._prog) t._prog.count(done, total, null); }
  function applyNote(t, text) { touch(t); if (t._prog) t._prog.note(text); }
  /* 交给任务体的那一套（submit 的 run() 与 begin 的返回值共用） */
  const handle = t => ({
    progress: (p, msg, extra) => applyProgress(t, p, msg, extra),
    phase: (i, msg, o) => applyPhase(t, i, msg, o),
    count: (done, total, msg) => applyCount(t, done, total, msg),
    note: text => applyNote(t, text),
    steps: arr => { if (Array.isArray(arr)) { touch(t); takeSteps(t, arr); } }
  });
  /* 任务真正开跑那一刻建引擎：排队时间不该算进"时间估算"里 */
  function startEngine(t) {
    if (!t._prog) t._prog = mkEngine(t._progOpts);
    return t._prog;
  }

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
      /* o.restructure：这条失败可以靠"再跑一次并允许改结构"救回来 → 卡片上多给一个按钮 */
      t._restructureFail = !!o.restructure;
    }
    if (o.result !== undefined) t.result = o.result;
    t.endedAt = Date.now();
    t._abort = null;
    t.cancelling = false;
    /* 子任务不落历史（parentId 那条同理）：一条讲解会并行派好几个模块 */
    if (M && !t.parentId) {
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
      startEngine(next);          // 真开跑了才开始计时（排队时间不算进估算）
      log('[task] 开始 #' + next.id, next.type, next.title);
      (async () => {
        try {
          const r = await next._run({
            signal: ac.signal,
            note: next.note,
            /* ⚠️ 这里和 begin 返回的是**同一套方法**（见 handle()）。
               别再在这两处各写一遍进度逻辑 —— 漏一处就是"某类任务永远 0%"。 */
            ...handle(next)
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
            /* 错误自己带 allowRestructure 标记 = 换个入参重跑就能过（见 pub 里的 canAllowRestructure） */
            finalize(next, 'failed', { error: msg, restructure: !!(e && e.allowRestructure) });
          }
        }
      })();
    }
  }

  /** 提交任务：run({ signal, note, progress, phase, count, note }) 返回结果。
   *  进度声明（都可省）：phases 阶段清单 / total 可数总量 / expectedMs 这个任务典型要多久。
   *  **一句都不传也有进度**：引擎会给一条按时间估算的条（前端会标"估算"）。 */
  function submit({ type, title, goalId, nodeId, note, run, message, retry, retried, originId, phases, total, expectedMs, phaseNote }) {
    const id = ++seq;
    tasks.set(id, {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'queued', message: message || '排队中…',
      progress: 0, createdAt: Date.now(), startedAt: 0, endedAt: 0, error: '', result: null,
      _run: run, _abort: null, _retry: typeof retry === 'function' ? retry : null,
      _progOpts: { phases, total, expectedMs, phaseNote },
      _tick: Date.now(), _final: false
    });
    if (M) {
      try {
        /* retried / originId：这条是不是「一键重试」产生的、从哪条来的。
           以前只有任务自己知道，转交时全丢了 —— 于是"重试救回来多少次"永远算不出来。 */
        const rid = M.insTask({ goalId, nodeId, type, title, status: 'queued', attempts: 1, retried: retried ? 1 : 0, originId: originId || 0 });
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
     所以这里是 async；taskId 拿不到就靠 retrying 标记让前端继续轮询。
     opts 会原样交给任务自己的重试闭包（例如 allowRestructure：卡片上的「🔓 允许改结构再跑」）。 */
  async function retry(id, opts) {
    const t = tasks.get(Number(id));
    if (!t) return { ok: false, error: '任务不存在（可能已刷新页面或重启过服务）' };
    if (running().some(x => x.id === t.id) || queued().some(x => x.id === t.id)) return { ok: false, error: '这个任务还在跑，先等它结束' };
    if (!t._retry) return { ok: false, error: '这个任务不支持重试（在页面里重新发起一次即可）' };
    t.message = '正在重新提交…';
    t.retrying = true;
    let nid = 0;
    try { nid = await t._retry({ fromRetry: true, originId: t.id, ...(opts || {}) }); } catch (e) {
      t.retrying = false;
      return { ok: false, error: '重试失败：' + (e && e.message ? e.message : String(e)) };
    }
    t.retrying = false;
    /* 收尾文案两条路都要给：新任务 id 拿不到时（localSelfPost 那条，
       拆分/教程的重试都走它）以前直接 return，卡片就永远停在"正在重新提交…"
       —— 看起来像还在动作，用户不敢再点、也看不出到底跑没跑。 */
    if (!nid) { t.message = '已重新提交，进度看左下角任务中心'; return { ok: true, taskId: 0, note: '已重新提交，进度会在左下角任务中心出现' }; }
    /* 旧卡片上那句"正在重新提交…"要收尾：不然它会永远停在那句话上，
       看起来像还在动作（真实翻过：失败卡一直显示"正在重新提交…"）。 */
    t.message = '已重新提交（新任务 #' + nid + '）';
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
     —— 任务立刻标记为 running，由调用方通过 progress/done/fail 汇报；客户端断开不会中断。
     进度声明（都可省）：phases / total / expectedMs —— 见 submit 上的说明。 */
  function begin({ type, title, goalId, nodeId, note, message, retry, parentId, phases, total, expectedMs, phaseNote }) {
    const id = ++seq;
    const ac = new AbortController();
    const parent = Number(parentId || 0) || 0;
    const t = {
      id, type, title: String(title || '').slice(0, 120), goalId: goalId || 0, nodeId: nodeId || 0,
      note: String(note || '').slice(0, 1000), status: 'running', message: message || '处理中…',
      progress: 0, createdAt: Date.now(), startedAt: Date.now(), endedAt: 0, error: '', result: null,
      parentId: parent,
      _run: null, _abort: ac, _final: false,
      _progOpts: { phases, total, expectedMs, phaseNote },
      _retry: typeof retry === 'function' ? retry : autoRetry()
    };
    tasks.set(id, t);
    touch(t);
    startEngine(t);
    /* 开始就落一行 task_runs。以前 begin 这条路只在结束时 updTask，但 _runRow 从没被赋过值 ——
       于是一条卡住的 begin 任务在 task_runs 里**一行都没有**（现场就是这样：表里只有 #75~77，
       卡住的 #2 查无此行），事后根本看不出它发生过。
       ⚠️ 子任务（parentId>0）不落历史：一条讲解可能并行派十几个模块，全记进 AI 任务历史
          会把"这个目标跑了多少任务"的统计撑得面目全非 —— 子任务的成败由主任务那一行代表。 */
    if (M && !parent) { try { t._runRow = M.insTask({ goalId: t.goalId, nodeId: t.nodeId, type: t.type, title: t.title, status: 'running', attempts: 1 }); } catch (e) {} }
    log('[task] 开始 #' + id, type, t.title);
    return {
      id,
      signal: ac.signal,
      /* ⚠️ 这里和 pump 里给 submit 的 run() 是**同一套方法**（同一个 handle()）。
         以前两处各写一遍、还各写错一处（"规划流程的进度条永远停在 0%"就是这么来的）。
         · progress(pct, msg, extra)  老写法，extra 认 steps/thinking/eta
         · phase(i|key, msg)          进入第 i 个阶段（begin 时用 phases 声明过）
         · count(done, total, msg)    可数的活儿
         · note(text) / steps(arr)    只更新"模型在想什么" / 直接给一整套阶段点 */
      ...handle(t),
      done: (result) => { log('[task] 完成 #' + id, type); finalize(t, 'done', { result: result || null }); },
      fail: (e) => {
        if (e && (e.cancelled || e.name === 'AbortError')) { log('[task] 结束 #' + id, 'cancelled'); finalize(t, 'cancelled'); }
        else {
          const msg = (e && e.message) || String(e);
          log('[task] 结束 #' + id, 'failed', msg);
          finalize(t, 'failed', { error: msg, restructure: !!(e && e.allowRestructure) });
        }
      }
    };
  }

  function status() {
    return { total: tasks.size, running: running().length, queued: queued().length, maxConcurrent };
  }

  return { submit, begin, list, cancel, clear, status, retry, retryable, setRetryFactory };
};
