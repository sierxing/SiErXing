'use strict';
/**
 * 任务进度的统一模型 —— 一处实现，所有 AI 任务共用。
 *
 * 为什么要有它（改前的现状，全是真实踩到的）：
 *   · **同一套时间曲线被抄了 5 份**：`1 - Math.exp(-sec / 18)` 出现在 interview / quests /
 *     restate / jdfile / explain 里，常数还各不相同（有的封 93%、有的封 95%）；
 *   · **有的任务压根不推百分比**：收集资料、识别图片只推文案，卡片上只有一条不动的走马灯；
 *   · **有的推了计数却忘了推百分比**，用户明明最想知道"已处理 3/9"，卡片只写"进行中"。
 *   结果同一排任务卡长得五花八门。用户要的是"都长一个样、都能看出走到哪了"。
 *
 * 本模块**只做纯计算**（不碰 db / 网络 / 定时器 / 日志），所以能单独跑测试。
 *
 * 【进度从哪来 —— 优先级从高到低】
 *   ① set(pct)         任务自己算出来的真实百分比（最准）
 *   ② count(done,total) 可数的活儿（已处理 3/9 个模块）→ 阶段内按 done/total 走
 *   ③ phase(i)         阶段推进（第 2/4 步：正在调用模型）→ 阶段之间是真的在前进
 *   ④ time             以上都没有 → 阶段**内部**用时间渐近曲线平滑
 *
 * 【防"假进度"的四条铁律】
 *   1. 百分比**单调不减**，任何情况下都不倒退（用户看到条回退只会以为出错）；
 *   2. 时间曲线只在**一个阶段内部**爬，到边界就停住等真实推进，绝不越过阶段；
 *   3. 最后一个阶段的时间曲线封在 93%，**不宣告 100%** —— 100% 只由任务完成（finalize）给出；
 *   4. 每个快照都带 `source`：前端据此把"估算"标出来，不把估算冒充真实。
 *
 * 【没有声明阶段时】整条就是一条时间曲线 —— 等于改动前的行为，只是不再各写一遍。
 */

/* 每个阶段的默认时间尺度（毫秒）。默认取 45 秒：到这个点曲线爬到约 63%，
   三分钟左右到约 95%。这是"一个阶段大概要等多久"的保守估计，
   任务知道自己的量级就用 opts.expectedMs 覆盖（比如教程生成要几分钟）。 */
const PHASE_MS = 45000;
/* 最后一段的时间曲线封顶：留 7% 给"真的写完了"那一下，别让条在完成前就走满 */
const TAIL_CAP = 0.93;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** 阶段声明归一化：字符串数组或 {key,label,weight} 都认；空数组 = 没有阶段 */
function normPhases(phases) {
  const list = Array.isArray(phases) ? phases.filter(Boolean) : [];
  if (!list.length) return null;
  return list.map((p, i) => {
    if (typeof p === 'string') return { key: 'p' + i, label: p.slice(0, 40), weight: 1 };
    return {
      key: String((p && p.key) || 'p' + i),
      label: String((p && p.label) || '').slice(0, 40),
      /* 权重决定这个阶段占整条的多少。给 0 或负数没法算区间，兜底成 1 */
      weight: Math.max(0.05, Number(p && p.weight) || 1)
    };
  });
}

/** 阶段权重 → 每个阶段的 [起点%, 终点%] 区间 */
function spansOf(phases) {
  const total = phases.reduce((a, p) => a + p.weight, 0);
  let acc = 0;
  return phases.map(p => {
    const start = acc / total * 100;
    acc += p.weight;
    return { start, end: acc / total * 100 };
  });
}

/** 时间渐近曲线：到 expected 那一刻爬约 63%，三倍时长到约 95% */
function timeFrac(elapsedMs, expectedMs) {
  const t = Math.max(1, Number(expectedMs) || PHASE_MS);
  return 1 - Math.exp(-Math.max(0, elapsedMs) / t);
}

/**
 * 建一个进度引擎。
 * @param {object}  opts
 * @param {Array}   opts.phases      阶段声明（可省）
 * @param {string}  opts.phaseNote   单阶段的默认阶段名（不声明 phases 时显示"正在处理"）
 * @param {number}  opts.total       可数任务的总数（不给就按 count() 传的 total）
 * @param {number}  opts.expectedMs  这个任务典型要跑多久（估算曲线的尺度）
 * @param {number}  opts.startAt     起始时间戳（测试注入用）
 * @param {function} opts.now        取当前时间（测试注入用）
 */
function create(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const t0 = Number(o.startAt) || now();
  const phases = normPhases(o.phases);
  const spans = phases ? spansOf(phases) : null;
  /* ⚠️ 这里必须是"没给就用 null"：写成 `Math.max(1000, Number(o.expectedMs) || 0) || null`
     的话，没给会算成 1000ms 而不是 null —— 于是每个阶段的尺度变成 1 秒，
     条在 3 秒内就冲到 90%（实测在真实任务上抓到）。 */
  const expectedAll = Number(o.expectedMs) > 0 ? Math.max(1000, Number(o.expectedMs)) : null;

  let phaseIdx = 0;                 // 当前阶段下标（有 phases 时才有意义）
  let exact = 0;                    // source==='set' 时的精确比例
  let floor = 0;                    // 阶段内的"已知至少到这里"（真实计数给的下界）
  let source = 'time';              // 这一帧的百分比是从哪来的
  let pctFloor = 0;                 // 单调性保险：已展示过的最大值
  let done = 0, total = Math.max(0, Number(o.total) || 0);
  let msg = '';                     // 调用方最近给的一句话（引擎不加工，原样带出去）
  let thinking = '';
  let etaText = '';
  let phaseMsg = '';                // 进入阶段时给的那句话（阶段点上的 detail）

  /* 这个阶段的时间尺度：整条 expectedMs 按权重切给它 */
  function phaseExpected(i) {
    if (!expectedAll) return PHASE_MS;
    if (!phases) return expectedAll;
    const w = phases[i] ? phases[i].weight : 1;
    const all = phases.reduce((a, p) => a + p.weight, 0);
    return Math.max(1000, expectedAll * w / all);
  }

  /* 把 (阶段区间 × 阶段内比例) 合成一个百分比，并送上单调性保险。
     ⚠️ 阶段内的比例取「真实下界」与「时间曲线」的较大者：
        - 真实数据（计数/显式给的 frac）把地板抬上去 —— 它才是事实；
        - 时间曲线在它上面继续平滑 —— 因为很多阶段是"每 8 条才报一次"，
          只认地板的话条会在两次上报之间长时间一动不动（跟卡死一样）。
        两者都被夹在本阶段的区间里，所以永远不会越过阶段边界。 */
  function compose(at) {
    const elapsed = Math.max(0, at - t0);
    let x;
    if (source === 'count' && total > 0) x = clamp(done / total, 0, 1);
    else if (source === 'set') x = clamp(exact, 0, 1);
    else {
      const tf = Math.min(timeFrac(elapsed, phaseExpected(phaseIdx)), TAIL_CAP);
      x = clamp(Math.max(floor, tf), 0, 1);
    }
    let pct;
    if (spans) {
      const sp = spans[phaseIdx] || spans[0];
      pct = sp.start + (sp.end - sp.start) * x;
    } else {
      pct = x * 100;
    }
    pct = Math.floor(clamp(pct, 0, 100));
    return Math.max(pctFloor, pct);
  }

  const api = {
    /** ① 真实百分比（任务自己算的）。传 null/undefined = 只更新文案，进度交给其它来源 */
    set(p, m) {
      if (m != null) msg = String(m);
      if (p == null) return api;
      const v = clamp(Number(p) || 0, 0, 100);
      /* 有阶段时，set 的值按整条 0~100 解释（调用方通常本来就是这么算的） */
      exact = v / 100;
      source = 'set';
      pctFloor = Math.max(pctFloor, v);
      return api;
    },
    /** ② 计数型：已处理 done / 共 total */
    count(d, t2, m) {
      if (m != null) msg = String(m);
      const n = Number(t2);
      if (n > 0) total = n;                    // 先认总数，才能按 done/total 算
      done = Math.max(0, Number(d) || 0);
      if (total > 0) { source = 'count'; }
      return api;
    },
    /** ③ 进入某个阶段（下标或 key）。o.frac = 这个阶段内"已知至少到这里"（0~1） */
    phase(i, m, o2) {
      if (m != null) msg = String(m);
      let idx = i;
      if (typeof i === 'string') {
        const k = phases ? phases.findIndex(p => p.key === i) : -1;
        idx = k >= 0 ? k : phaseIdx;
      }
      if (phases) {
        const n = clamp(Math.floor(Number(idx) || 0), 0, phases.length - 1);
        /* 只许往前走：乱序调用不会让条倒退 */
        phaseIdx = Math.max(phaseIdx, n);
        phaseMsg = String(m != null ? m : (phases[phaseIdx] && phases[phaseIdx].label) || '');
      } else if (m != null) {
        phaseMsg = String(m);
      }
      if (source !== 'set' && source !== 'count') source = 'phase';
      /* 新阶段的地板从头开始；给了 frac 就拿它当地板 */
      floor = clamp(Number((o2 && o2.frac) != null ? o2.frac : 0) || 0, 0, 1);
      if (phases) pctFloor = Math.max(pctFloor, Math.floor(spans[phaseIdx].start));
      return api;
    },
    /** 只更新"模型此刻在想什么"（实时长文尾部），不动进度 */
    note(t2) { if (t2 != null) thinking = String(t2).slice(-220); return api; },
    /** ETA 文案由调用方给（引擎算不出剩下的活儿要多久） */
    eta(t2) { etaText = t2 == null ? '' : String(t2).slice(0, 40); return api; },
    /** 统一快照：前端只认这一个结构 */
    snapshot(at) {
      const ms = at == null ? now() : at;
      const pct = compose(ms);
      pctFloor = Math.max(pctFloor, pct);
      const steps = phases ? phases.map((p, i) => ({
        key: p.key,
        label: p.label,
        state: i < phaseIdx ? 'done' : (i === phaseIdx ? 'active' : 'pending'),
        detail: i === phaseIdx ? (phaseMsg || '').slice(0, 80) : ''
      })) : null;
      return {
        pct,
        source: total > 0 && source === 'count' ? 'count' : source,
        done, total,
        phaseIndex: phaseIdx,
        phaseCount: phases ? phases.length : 1,
        phaseLabel: phases ? (phases[phaseIdx] && phases[phaseIdx].label) || '' : '',
        steps,
        thinking,
        eta: etaText,
        phaseMsg,
        elapsedMs: Math.max(0, ms - t0),
        /* 任务结束了没有阶段可推进 —— 前端据此决定要不要把条画满 */
        startedAt: t0
      };
    },
    /* 给测试与调试看内部状态 */
    _state() { return { phaseIdx, exact, floor, source, done, total, pctFloor }; },
    /* 任务完成/失败时把条收干净（只影响展示，不影响单调性） */
    finish(p) { if (p != null) { exact = clamp(Number(p) || 0, 0, 100) / 100; source = 'set'; pctFloor = 100; } return api; }
  };
  return api;
}

module.exports = { create, normPhases, spansOf, timeFrac, PHASE_MS, TAIL_CAP };
