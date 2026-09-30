'use strict';
/**
 * 思而行 · 前端扩展组件：学习统计
 * ------------------------------------------------------------------
 * 两部分：
 * 1) 后台记账（ mute 静默）：番茄钟计时开着时每 ~15 秒上报一次：
 *    - 专注 + 本页可见 + 停在教程上 → 记到该节点；绑定了节点则在哪页都记它；
 *    - 专注 + 本页不可见（切标签/最小化/刷视频）→ 记"暂离应用"
 *      （网页拿不到别的标签页地址，只能知道切出去了）；
 *    - 休息计时走字 → 记"休息"。
 *    暂停/切页/关页面不记；暂停·结束·完成那一刻番茄钟会调 flush() 立刻结算零头。
 * 2) 日历页（#/studystats）：月历 + 每天专注/休息/暂离，点某天看时间线与各节点明细。
 */
(function () {
  const { api, esc, toast } = SiErXing;

  function enabled() { try { return typeof compOn === 'function' ? compOn('studystats') !== false : true; } catch (e) { return true; } }
  function pomoState() { try { return window.Pomodoro ? window.Pomodoro.state() : null; } catch (e) { return null; } }
  function curTid() { const m = (location.hash || '').match(/^#\/t\/(\d+)$/); return m ? Number(m[1]) : 0; }

  /* ---------------- 1) 后台记账 ---------------- */
  const TICK_MS = 15000, CAP_SEC = 60;
  let lastAt = Date.now();
  let lastTickTid = 0;   // 最近一次心跳所在的教程（切页结算零头时用它，不算到新页面上）
  const nodeCache = {};   // tid -> node_id（0 表示解析中/无节点）
  const pending = {};     // tid -> 等节点解析的秒数（仅专注可见态用）

  async function resolveNode(tid) {
    if (nodeCache[tid] != null) return nodeCache[tid];
    nodeCache[tid] = 0;
    try {
      const r = await api('/api/tutorials/' + tid);
      const nid = r && r.node ? Number(r.node.id) : 0;
      nodeCache[tid] = nid;
      if (nid > 0 && pending[tid] > 0) { const s = pending[tid]; pending[tid] = 0; report('focus', nid, s); }
    } catch (e) { nodeCache[tid] = 0; }
    return nodeCache[tid];
  }
  async function report(bucket, nid, sec) {
    sec = Math.round(sec);
    if (!(sec >= 1)) return null;
    try {
      return await api('/api/study/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, node_id: nid || 0, seconds: Math.min(sec, 600) })
      });
    } catch (e) {
      // 绑定的节点被删了：自动解绑，避免之后的时间全丢黑洞
      if (/节点不存在/.test(e.message || '')) {
        try {
          const pst = pomoState();
          if (pst && pst.bind && pst.bind.nodeId === nid && window.Pomodoro) {
            await window.Pomodoro.setBind(0, true);
            toast('绑定的节点已不存在，已自动解绑');
          }
        } catch (e2) {}
      }
      return null;
    }
  }
  /* 当前上下文节点：绑定优先，否则当前教程（需解析），都没有则 0 */
  async function contextNode(tid, pst) {
    if (pst && pst.bind && pst.bind.nodeId > 0) return pst.bind.nodeId;
    if (tid > 0) return resolveNode(tid);
    return 0;
  }
  async function tick() {
    try {
      const now = Date.now();
      const dt = Math.min((now - lastAt) / 1000, CAP_SEC);
      lastAt = now;
      const st = pomoState();
      if (!st || !st.running) return;
      const tid = curTid();
      lastTickTid = tid;
      if (st.phase === 'break') {
        await report('rest', await contextNode(tid, st), dt);
        return;
      }
      if (st.phase !== 'focus') return;
      if (document.visibilityState !== 'visible') {
        // 切出应用了：这段时间不算学，记暂离
        await report('away', await contextNode(tid, st), dt);
        return;
      }
      if (st.bind && st.bind.nodeId > 0) { await report('focus', st.bind.nodeId, dt); return; }
      if (!(tid > 0)) return;
      const nid = await resolveNode(tid);
      if (nid > 0) await report('focus', nid, dt);
      else pending[tid] = (pending[tid] || 0) + dt;
    } finally {
      // 统计页开着就地刷新，不用手动点
      try { if ((location.hash || '').startsWith('#/studystats')) await refresh(); } catch (e) {}
    }
  }
  setInterval(() => {
    try { if (enabled()) tick(); } catch (e) {}
  }, TICK_MS);
  // 切页面：先把上一页的零头记上（再清时钟，不丢十几秒）
  window.addEventListener('hashchange', () => {
    try {
      const t = document.getElementById('ssTip');
      if (t) t.hidden = true;
    } catch (e) {}
    try {
      const now = Date.now();
      const dt = Math.min((now - lastAt) / 1000, CAP_SEC);
      lastAt = now;
      const st = pomoState();
      if (st && st.running && dt >= 1) {
        const nid = (st.bind && st.bind.nodeId > 0) ? st.bind.nodeId : (nodeCache[lastTickTid] || 0);
        const bucket = st.phase === 'break' ? 'rest'
          : (document.visibilityState !== 'visible' ? 'away'
          : (nid > 0 ? 'focus' : null));
        if (bucket && (nid > 0 || bucket !== 'focus')) report(bucket, nid, dt);
      }
    } catch (e) {}
  });
  // 关页面：尽力把最后一段记上（只用已解析好的节点，不再起新请求解析）
  window.addEventListener('pagehide', () => {
    try {
      const st = pomoState();
      if (!st || !st.running) return;
      const now = Date.now();
      const dt = Math.min((now - lastAt) / 1000, CAP_SEC);
      if (!(dt >= 1)) return;
      const tid = curTid();
      let bucket = null, nid = 0;
      if (st.phase === 'break') { bucket = 'rest'; nid = (st.bind && st.bind.nodeId) || nodeCache[tid] || 0; }
      else if (st.phase === 'focus') {
        if (document.visibilityState !== 'visible') { bucket = 'away'; nid = (st.bind && st.bind.nodeId) || nodeCache[tid] || 0; }
        else if (st.bind && st.bind.nodeId > 0) { bucket = 'focus'; nid = st.bind.nodeId; }
        else if (tid > 0 && nodeCache[tid] > 0) { bucket = 'focus'; nid = nodeCache[tid]; }
      }
      if (bucket) {
        fetch('/api/study/report', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bucket, node_id: nid, seconds: Math.round(dt) }), keepalive: true
        }).catch(() => {});
      }
    } catch (e) {}
  });
  /* 番茄钟暂停/结束/完成时调用：把零头立刻记上 */
  function flush() { try { tick(); } catch (e) {} }
  if (!window.__ssTipBound) {
    window.__ssTipBound = true;
    // 滚动就收起悬停卡；点到空白处也收
    window.addEventListener('scroll', () => { try { const t = document.getElementById('ssTip'); if (t) t.hidden = true; } catch (e) {} }, { passive: true, capture: true });
    document.addEventListener('click', e => {
      try {
        const t = document.getElementById('ssTip');
        if (t && !t.hidden && !(e.target.closest && (e.target.closest('[data-seg]') || e.target.closest('#ssTip')))) t.hidden = true;
      } catch (err) {}
    });
  }

  /* ---------------- 2) 日历页 ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function localDayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + '秒';
    const m = Math.floor(sec / 60), h = Math.floor(m / 60);
    if (!h) return m + '分钟';
    return h + '小时' + (m % 60 ? (m % 60) + '分' : '');
  }
  function fmtShort(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), h = Math.floor(m / 60);
    if (!h) return m + '分';
    return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  }
  const KIND_TXT = { focus: '📖 学习', rest: '☕ 休息', away: '📵 暂离' };
  let curMonth = localDayStr(new Date()).slice(0, 7);
  let selDay = localDayStr(new Date());
  let monthData = { days: {}, total_focus: 0, total_rest: 0, total_away: 0, active_days: 0 };

  async function renderStatsPage() {
    curMonth = localDayStr(new Date()).slice(0, 7);
    selDay = localDayStr(new Date());
    builtMonth = ''; builtDay = '';   // 页面重建，骨架标记清零
    app.innerHTML = `<div class="page"><div class="pageHead">
        <button class="back" data-back="#/">← 返回</button>
        <span class="mapTitle">📊 学习统计</span>
        <span class="chip gray">专注按节点记 · 切出应用记暂离</span>
        <div class="spacer"></div>
        <button class="btn small" id="ssPrevM">‹ 上月</button>
        <button class="btn small" id="ssToday">本月</button>
        <button class="btn small" id="ssNextM">下月 ›</button>
      </div>
      <div class="ssSummary" id="ssSummary"></div>
      <div class="ssCal" id="ssCal"></div>
      <div class="ssDetail" id="ssDetail"></div>
    </div>`;
    document.getElementById('ssPrevM').addEventListener('click', () => shiftMonth(-1));
    document.getElementById('ssNextM').addEventListener('click', () => shiftMonth(1));
    document.getElementById('ssToday').addEventListener('click', () => {
      curMonth = localDayStr(new Date()).slice(0, 7);
      selDay = localDayStr(new Date());
      refresh();
    });
    await refresh();
  }
  function shiftMonth(d) {
    const [y, m] = curMonth.split('-').map(Number);
    const t = new Date(y, m - 1 + d, 1);
    curMonth = t.getFullYear() + '-' + pad(t.getMonth() + 1);
    refresh();
  }
  let builtMonth = '';
  async function refresh() {
    try {
      monthData = await api('/api/study/month?month=' + encodeURIComponent(curMonth));
    } catch (e) { monthData = { days: {}, total_focus: 0, total_rest: 0, total_away: 0, active_days: 0 }; }
    renderCal();
    await renderDay();
    updateLive();
  }
  function updateLive() {
    // 计时跑着就亮个“直播”点，让人知道数字会自己动
    let running = false;
    try { const p = pomoState(); running = !!(p && p.running); } catch (e) {}
    document.querySelectorAll('.ssLive').forEach(el => { el.hidden = !running; });
  }
  function renderCal() {
    const box = document.getElementById('ssCal');
    if (!box) return;
    const [y, m] = curMonth.split('-').map(Number);
    if (builtMonth !== curMonth) {
      // 月份变了才重建骨架；同月只补丁，避免闪烁
      const first = new Date(y, m - 1, 1);
      const offset = (first.getDay() + 6) % 7;   // 周一起
      const daysIn = new Date(y, m, 0).getDate();
      let h = `<div class="ssMonthTitle">${y} 年 ${m} 月</div><div class="ssGrid ssWeek">${['一', '二', '三', '四', '五', '六', '日'].map(w => `<div>${w}</div>`).join('')}</div><div class="ssGrid">`;
      for (let i = 0; i < offset; i++) h += '<div class="ssCell empty"></div>';
      for (let d = 1; d <= daysIn; d++) {
        const key = curMonth + '-' + pad(d);
        h += `<button class="ssCell" data-day="${key}"><span class="ssD">${d}</span><span class="ssT" hidden></span></button>`;
      }
      h += '</div>';
      box.innerHTML = h;
      box.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
        selDay = b.getAttribute('data-day');
        renderCal();
        renderDay();
      }));
      builtMonth = curMonth;
    }
    patchCal();
    document.getElementById('ssSummary').innerHTML =
      `<div class="ssStat"><span class="ssNum">${fmtDur(monthData.total_focus)}</span><span class="ssLbl">本月专注</span></div>` +
      `<div class="ssStat"><span class="ssNum">${fmtDur(monthData.total_rest)}</span><span class="ssLbl">本月休息</span></div>` +
      `<div class="ssStat"><span class="ssNum">${fmtDur(monthData.total_away)}</span><span class="ssLbl">本月暂离</span></div>` +
      `<div class="ssStat"><span class="ssNum">${monthData.active_days}</span><span class="ssLbl">学习天数</span></div>`;
  }
  function patchCal() {
    const today = localDayStr(new Date());
    document.querySelectorAll('#ssCal [data-day]').forEach(b => {
      const key = b.getAttribute('data-day');
      const dd = (monthData.days || {})[key] || { f: 0, r: 0, a: 0 };
      b.classList.toggle('has', (dd.f || 0) > 0);
      b.classList.toggle('today', key === today);
      b.classList.toggle('sel', key === selDay);
      b.classList.toggle('future', key > today);
      if (key > today) b.setAttribute('disabled', '');
      else b.removeAttribute('disabled');
      b.title = `专注 ${fmtDur(dd.f || 0)} · 休息 ${fmtDur(dd.r || 0)} · 暂离 ${fmtDur(dd.a || 0)}`;
      const t = b.querySelector('.ssT');
      if (t) {
        const showR = (dd.r || 0) > 0, showF = (dd.f || 0) > 0;
        t.hidden = !(showF || showR);
        t.innerHTML = (showF ? esc(fmtShort(dd.f)) : '') + (showF && showR ? ' <span class="ssRDot">·</span> ' : '') + (showR ? `<span class="ssR">休${esc(fmtShort(dd.r))}</span>` : '');
      }
    });
  }
  function weekdayStr(ds) {
    try {
      const [y, m, d] = ds.split('-').map(Number);
      return '周' + ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
    } catch (e) { return ''; }
  }
  /* ---------- 当天时间轴：6 条 4 小时横轴（上万条也只是绝对定位块，悬停看详情） ---------- */
  const AXES = [[0, 4], [4, 8], [8, 12], [12, 16], [16, 20], [20, 24]];
  const AXIS_MIN = 240;
  let segById = {};   // tooltip 查详情用：key 'seg'+id
  function segMin(t) {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function axesView() { try { return localStorage.getItem('sierxing-stats-axes') || 'cols2'; } catch (e) { return 'cols2'; } }
  function setAxesView(v) { try { localStorage.setItem('sierxing-stats-axes', v); } catch (e) {} }
  function axesView() { try { return localStorage.getItem('sierxing-stats-axes') || 'cols2'; } catch (e) { return 'cols2'; } }
  function setAxesView(v) { try { localStorage.setItem('sierxing-stats-axes', v); } catch (e) {} }
  /* 图例过滤：只看某几种状态（记忆选择） */
  let kindFilter = null;
  function loadKindFilter() {
    try {
      const o = JSON.parse(localStorage.getItem('sierxing-stats-kinds') || 'null');
      if (o && typeof o === 'object') return { focus: o.focus !== false, rest: o.rest !== false, away: o.away !== false };
    } catch (e) {}
    return { focus: true, rest: true, away: true };
  }
  kindFilter = loadKindFilter();
  function saveKindFilter() { try { localStorage.setItem('sierxing-stats-kinds', JSON.stringify(kindFilter)); } catch (e) {} }
  let lastSegs = [];
  function paintLegend(box) {
    box.querySelectorAll('.ssLg[data-kind]').forEach(sp => {
      sp.classList.toggle('off', !kindFilter[sp.getAttribute('data-kind')]);
    });
  }
  function renderAxes(box, segs) {
    lastSegs = segs;
    if (!box.dataset.built) {
      // 定死两列容器：左 0/4/8、右 12/16/20；单列模式只是竖排，不搬 DOM
      const col = idxs => idxs.map(i => {
        const a = AXES[i];
        return `<div class="ssAxis" data-ax="${i}"><div class="ssAxisHead"><span>${pad(a[0])}:00 – ${pad(a[1])}:00</span><span class="ssAxisTot" id="ssAxTot${i}"></span></div>` +
        `<div class="ssAxisTrack"><div class="ssAxisGrid">${[0, 1, 2, 3, 4].map(h => `<span class="ssTick" style="left:${h * 25}%"><i>${pad(a[0] + h)}</i></span>`).join('')}</div>` +
        `<div class="ssAxisSegs" id="ssAxSegs${i}"></div></div></div>`;
      }).join('');
      box.innerHTML = `<div class="ssDayAxes ${axesView()}" id="ssDayAxes"><div class="ssCol">${col([0, 1, 2])}</div><div class="ssCol">${col([3, 4, 5])}</div></div>` +
      `<div class="ssLegend"><span class="ssLg" data-kind="focus"><i class="ssLgDot k-focus"></i>专注</span><span class="ssLg" data-kind="rest"><i class="ssLgDot k-rest"></i>休息</span><span class="ssLg" data-kind="away"><i class="ssLgDot k-away"></i>暂离</span><span class="muted">悬停（触屏点一下）看详情</span></div>`;
      box.dataset.built = '1';
      box.querySelectorAll('.ssLg[data-kind]').forEach(sp => {
        sp.addEventListener('click', () => {
          const k = sp.getAttribute('data-kind');
          kindFilter[k] = !kindFilter[k];
          // 全关了等于没过滤，直接全开（避免白屏困惑）
          if (!kindFilter.focus && !kindFilter.rest && !kindFilter.away) kindFilter = { focus: true, rest: true, away: true };
          saveKindFilter();
          paintLegend(box);
          renderAxes(box, lastSegs);
        });
      });
      bindAxTip(box);
    } else {
      const w = document.getElementById('ssDayAxes');
      if (w) w.className = 'ssDayAxes ' + axesView();
    }
    paintLegend(box);
    segById = {};
    AXES.forEach((a, i) => {
      const s0 = a[0] * 60, s1 = a[1] * 60;
      let tF = 0, tR = 0, tA = 0;
      const inR = [];
      for (const s of segs) {
        if (!kindFilter[s.kind]) continue;   // 图例关掉的不画
        if (s.seconds < (s.kind === 'focus' ? 300 : (s.kind === 'rest' ? 60 : 120))) continue;   // 太碎的不画（专注<5分钟，休息<1分钟，暂离<2分钟），总数也不计入
        const st = segMin(s.from), en = segMin(s.to);
        if (isNaN(st) || isNaN(en) || en <= s0 || st >= s1) continue;
        segById['seg' + s.id] = s;
        inR.push(s);
        const cut = Math.max(0, Math.min(en, s1) - Math.max(st, s0)) * 60;
        if (s.kind === 'rest') tR += cut; else if (s.kind === 'away') tA += cut; else tF += cut;
      }
      const totEl = document.getElementById('ssAxTot' + i);
      if (totEl) {
        const parts = [];
        if (tF > 0) parts.push(`<span class="ssAxF">${esc(fmtShort(tF))}</span>`);
        if (tR > 0) parts.push(`<span class="ssAxR">休${esc(fmtShort(tR))}</span>`);
        if (tA > 0) parts.push(`<span class="ssAxA">离${esc(fmtShort(tA))}</span>`);
        const html = parts.join('<span class="ssAxSep">·</span>');
        if (totEl.dataset.html !== html) { totEl.dataset.html = html; totEl.innerHTML = html; }
      }
      const layer = document.getElementById('ssAxSegs' + i);
      const sig = inR.map(s => s.id + ':' + s.seconds).join(',');
      if (layer && layer.dataset.sig !== sig) {
        layer.dataset.sig = sig;
        // 全部画线段（长短只差在宽度）：专注≥5分钟、休息≥1分钟、暂离≥2分钟才到这里
        layer.innerHTML = inR.map(s => {
          const st = Math.max(segMin(s.from), s0);
          const l = (st - s0) / AXIS_MIN * 100;
          const w = Math.max((Math.min(segMin(s.to), s1) - st) / AXIS_MIN * 100, 1.2);
          return `<span class="ssSegB k-${esc(s.kind)}" style="left:${l}%;width:${w}%" data-seg="seg${s.id}"></span>`;
        }).join('');
      }
    });
  }
  function axTipEl() {
    let t = document.getElementById('ssTip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ssTip';
      t.className = 'ssTip';
      t.hidden = true;
      document.body.appendChild(t);
    }
    return t;
  }
  function bindAxTip(box) {
    const tip = axTipEl();
    const showFor = (b, ev) => {
      const s = segById[b.getAttribute('data-seg')];
      if (!s) { tip.hidden = true; return; }
      const html = `<div class="ssTipTop"><span class="ssKind k-${esc(s.kind)}">${KIND_TXT[s.kind] || esc(s.kind)}</span><span class="ssDur">${esc(fmtDur(s.seconds))}</span></div>` +
        `<div class="ssTipTime">${esc(s.from)} – ${esc(s.to)} · 持续${esc(fmtDur(s.seconds))}</div>` +
        `<div class="ssTipWhat">${esc(s.node_title || s.goal_title || '')}</div>`;
      if (tip._html !== html) { tip._html = html; tip.innerHTML = html; }
      tip.hidden = false;
      moveTip(ev);
    };
    const moveTip = ev => {
      if (tip.hidden) return;
      const pad2 = 12;
      tip.style.left = '0px'; tip.style.top = '0px';
      const r = tip.getBoundingClientRect();
      let x = (ev.clientX != null ? ev.clientX : 0) + 14, y = (ev.clientY != null ? ev.clientY : 0) + 14;
      if (x + r.width > window.innerWidth - pad2) x = window.innerWidth - r.width - pad2;
      if (y + r.height > window.innerHeight - pad2) y = window.innerHeight - r.height - pad2;
      tip.style.left = Math.max(pad2, x) + 'px';
      tip.style.top = Math.max(pad2, y) + 'px';
    };
    const fromEvent = ev => (ev.target && ev.target.closest ? ev.target.closest('[data-seg]') : null);
    // mouseover 进入即显示（比 mousemove 可靠，不用蹭位置）
    box.addEventListener('mouseover', ev => {
      const b = fromEvent(ev);
      if (!b || !box.contains(b)) return;
      showFor(b, ev);
    });
    // 移动只跟随，不重渲染内容
    box.addEventListener('mousemove', ev => { if (!tip.hidden) moveTip(ev); });
    // 离开当前段才隐藏；直接进另一段由 mouseover 接管（不闪）
    box.addEventListener('mouseout', ev => {
      const to = ev.relatedTarget;
      if (to && to.closest && to.closest('[data-seg]')) return;
      tip.hidden = true;
    });
    box.addEventListener('mouseleave', () => { tip.hidden = true; });
    box.addEventListener('click', ev => {   // 触屏点一下看
      const b = fromEvent(ev);
      if (b && box.contains(b)) showFor(b, ev);
    });
  }
  function nodeRowHTML(r) {
    return `<div class="ssRowTop"><span class="ssNode">${esc(r.node_title)}${r.node_gone ? ' <span class="chip gray">节点已删</span>' : ''}</span><span class="ssDur">${esc(fmtDur(r.focus_sec))}</span></div>` +
      (r.goal_title ? `<div class="ssRowSub"><a href="#/g/${r.goal_id}">${esc(r.goal_title)}</a></div>` : '') +
      `<div class="ssBar"><div class="ssFill" style="width:0%"></div></div>`;
  }
  /* 按 key 对账：已有的就地更新，新来的追加（带滑入动画），没了的移除 */
  function syncRows(box, items, keyFn, clsFn, buildInner) {
    const seen = new Set();
    const have = new Map();
    box.querySelectorAll(':scope > [data-k]').forEach(el => have.set(el.getAttribute('data-k'), el));
    for (const it of items) {
      const k = keyFn(it);
      seen.add(k);
      let elx = have.get(k);
      if (!elx) {
        elx = document.createElement('div');
        elx.className = clsFn(it) + ' ssNew';
        elx.setAttribute('data-k', k);
        elx.innerHTML = buildInner(it);
        box.appendChild(elx);
        setTimeout(() => elx.classList.remove('ssNew'), 600);
      } else {
        const fresh = document.createElement('div');
        fresh.innerHTML = buildInner(it);
        if (elx.innerHTML !== fresh.innerHTML) elx.innerHTML = fresh.innerHTML;
      }
    }
    have.forEach((elx, k) => { if (!seen.has(k)) elx.remove(); });
  }
  let builtDay = '';
  async function renderDay() {
    const box = document.getElementById('ssDetail');
    if (!box) return;
    if (builtDay !== selDay) box.innerHTML = '<p class="muted">加载中…</p>';
    let d;
    try { d = await api('/api/study/day?day=' + encodeURIComponent(selDay)); }
    catch (e) { if (builtDay !== selDay) box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; return; }
    if (builtDay !== selDay) {
      const [yy, mm, dd] = selDay.split('-').map(Number);
      box.innerHTML =
        `<div class="ssDayHero" id="ssDayHero"><div class="ssDayTop"><span class="ssDayDate">📅 ${mm}月${dd}日 · ${weekdayStr(selDay)}</span><span class="ssLive" hidden>● 直播</span></div>` +
        `<div class="ssDayTotal"><b id="ssDayFocus">0秒</b><span>专注</span></div>` +
        `<div class="ssDayPills"><span class="ssPill">☕ 休息 <b id="ssDayRest">0秒</b></span><span class="ssPill">📵 暂离 <b id="ssDayAway">0秒</b></span></div></div>` +
        `<div class="ssSecTitle" id="ssTlTitle" hidden>⏱ 当天时间线</div><div class="ssAxView" id="ssAxView" hidden><span>排列：</span><button class="ssViewBtn" data-v="cols2">左右两列</button><button class="ssViewBtn" data-v="cols1">上下单列</button></div><div class="ssTl" id="ssTl"></div>` +
        `<div class="ssSecTitle" id="ssNodeTitle" hidden>📖 按节点</div><div id="ssNodeRows"></div>` +
        `<div class="ssEmpty" id="ssEmpty" hidden><div class="ebText">这天还没记录。开着番茄钟、打开一篇教程专注，时间会自动记到对应节点上；切出应用的时间会记为暂离。</div></div>` +
        `<div class="ssFoot muted">暂离指本页面不可见的时段（切标签页/最小化/刷视频等），网页拿不到其它标签页地址，只能记到这个粒度。</div>`;
      builtDay = selDay;
      box.querySelectorAll('.ssViewBtn').forEach(b => {
        if (b.getAttribute('data-v') === axesView()) b.classList.add('active');
        b.addEventListener('click', () => {
          setAxesView(b.getAttribute('data-v'));
          const w = document.getElementById('ssDayAxes');
          if (w) w.className = 'ssDayAxes ' + axesView();
          box.querySelectorAll('.ssViewBtn').forEach(x => x.classList.toggle('active', x === b));
        });
      });
    }
    patchDay(box, d);
    updateLive();
  }
  function patchDay(box, d) {
    const t = d.totals || { focus: 0, rest: 0, away: 0 };
    const setText = (id, v) => { const elx = document.getElementById(id); if (elx && elx.textContent !== v) elx.textContent = v; };
    setText('ssDayFocus', fmtDur(t.focus));
    setText('ssDayRest', fmtDur(t.rest));
    setText('ssDayAway', fmtDur(t.away));
    const tl = d.timeline || [], recs = d.records || [];
    const tlTitle = document.getElementById('ssTlTitle');
    const axView = document.getElementById('ssAxView');
    const nodeTitle = document.getElementById('ssNodeTitle');
    const emptyBox = document.getElementById('ssEmpty');
    const foot = box.querySelector('.ssFoot');
    if (tlTitle) tlTitle.hidden = !tl.length;
    if (axView) axView.hidden = !tl.length;
    if (nodeTitle) nodeTitle.hidden = !recs.length;
    if (emptyBox) emptyBox.hidden = !!(tl.length || recs.length);
    if (foot) foot.style.display = (tl.length || recs.length) ? '' : 'none';
    const tlBox = document.getElementById('ssTl');
    if (tlBox) {
      if (!tl.length) { tlBox.innerHTML = ''; tlBox.style.display = 'none'; }
      else { tlBox.style.display = ''; renderAxes(tlBox, tl); }
    }
    const nrBox = document.getElementById('ssNodeRows');
    if (nrBox) {
      syncRows(nrBox, recs, r => 'node' + r.node_id, () => 'ssRow', nodeRowHTML);
      const max = Math.max(1, ...recs.map(r => r.focus_sec));
      nrBox.querySelectorAll(':scope > [data-k]').forEach(elx => {
        const r = recs.find(x => 'node' + x.node_id === elx.getAttribute('data-k'));
        const fill = elx.querySelector('.ssFill');
        if (r && fill) fill.style.width = Math.round(r.focus_sec / max * 100) + '%';
      });
    }
  }

  SiErXing.registerPlugin({
    id: 'studystats',
    goalEntry: {
      label: '学习统计',
      icon: '📊',
      order: 21,
      header: false,            // 不放目标页顶栏，只进左栏「组件」模块
      hash: () => '#/studystats',
      show: () => true          // 入口显示由宿主按目标判定；运行时总开关另见 enabled()
    },
    routes: [
      { match: h => h.match(/^#\/studystats$/), render: async () => { await renderStatsPage(); } }
    ]
  });

  /* 对外极小接口（测试 / 跨插件用） */
  window.StudyStats = { _tick: tick, flush, _cache: nodeCache };
})();
