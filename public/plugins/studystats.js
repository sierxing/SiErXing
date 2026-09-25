'use strict';
/**
 * 思而行 · 前端扩展组件：学习统计
 * ------------------------------------------------------------------
 * 两部分：
 * 1) 后台记账：番茄钟专注计时开着、且正停在某篇教程（#/t/:id）上时，
 *    每 ~15 秒把流过的秒数记到该节点名下；暂停/切走/关页面不记。
 * 2) 日历页（#/studystats）：月历 + 每天学了多久，点某天看各节点明细。
 * 由 app.js 经路由自动渲染（仅当组件启用…入口层面；页面本身打开即查）。
 */
(function () {
  const { api, esc } = SiErXing;

  function enabled() { try { return typeof compOn === 'function' ? compOn('studystats') !== false : true; } catch (e) { return true; } }
  function pomoState() { try { return window.Pomodoro ? window.Pomodoro.state() : null; } catch (e) { return null; } }
  function curTid() { const m = (location.hash || '').match(/^#\/t\/(\d+)$/); return m ? Number(m[1]) : 0; }

  /* ---------------- 1) 后台记账 ---------------- */
  const TICK_MS = 15000, CAP_SEC = 60;
  let lastAt = Date.now();
  const nodeCache = {};   // tid -> node_id（0 表示解析中/无节点）
  const pending = {};     // tid -> 等节点解析的秒数

  async function resolveNode(tid) {
    if (nodeCache[tid] != null) return nodeCache[tid];
    nodeCache[tid] = 0;
    try {
      const r = await api('/api/tutorials/' + tid);
      const nid = r && r.node ? Number(r.node.id) : 0;
      nodeCache[tid] = nid;
      if (nid > 0 && pending[tid] > 0) { const s = pending[tid]; pending[tid] = 0; credit(nid, s); }
    } catch (e) { nodeCache[tid] = 0; }
    return nodeCache[tid];
  }
  async function credit(nid, sec) {
    sec = Math.round(sec);
    if (!(nid > 0) || !(sec >= 1)) return;
    try {
      await api('/api/study/credit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nid, seconds: Math.min(sec, 600) })
      });
    } catch (e) {}
  }
  async function tick() {
    const now = Date.now();
    const dt = Math.min((now - lastAt) / 1000, CAP_SEC);
    lastAt = now;
    const st = pomoState();
    const tid = curTid();
    if (!st || !st.running || st.phase !== 'focus' || !(tid > 0)) return;
    const nid = await resolveNode(tid);
    if (nid > 0) credit(nid, dt);
    else pending[tid] = (pending[tid] || 0) + dt;
  }
  setInterval(() => {
    try { if (enabled()) tick(); } catch (e) {}
  }, TICK_MS);
  // 切页面：时钟清零（上一页的零头不算到新页面上，丢秒级零头可接受）
  window.addEventListener('hashchange', () => { lastAt = Date.now(); });
  // 关页面：尽力把最后一段记上（节点已解析才发，避免关页面时再起请求解析）
  window.addEventListener('pagehide', () => {
    try {
      const st = pomoState(), tid = curTid(), now = Date.now();
      const dt = Math.min((now - lastAt) / 1000, CAP_SEC);
      const nid = nodeCache[tid] || 0;
      if (st && st.running && st.phase === 'focus' && tid > 0 && nid > 0 && dt >= 1) {
        fetch('/api/study/credit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: nid, seconds: Math.round(dt) }), keepalive: true
        }).catch(() => {});
      }
    } catch (e) {}
  });

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
  let curMonth = localDayStr(new Date()).slice(0, 7);
  let selDay = localDayStr(new Date());
  let monthData = { days: {}, total_sec: 0, active_days: 0 };

  async function renderStatsPage() {
    curMonth = localDayStr(new Date()).slice(0, 7);
    selDay = localDayStr(new Date());
    app.innerHTML = `<div class="page"><div class="pageHead">
        <a class="back" href="#/">← 返回</a>
        <span class="mapTitle">📊 学习统计</span>
        <span class="chip gray">番茄专注秒数按节点记账</span>
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
  async function refresh() {
    try {
      monthData = await api('/api/study/month?month=' + encodeURIComponent(curMonth));
    } catch (e) { monthData = { days: {}, total_sec: 0, active_days: 0 }; }
    renderCal();
    await renderDay();
  }
  function renderCal() {
    const [y, m] = curMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const offset = (first.getDay() + 6) % 7;   // 周一起
    const daysIn = new Date(y, m, 0).getDate();
    const today = localDayStr(new Date());
    let h = `<div class="ssMonthTitle">${y} 年 ${m} 月</div><div class="ssGrid ssWeek">${['一', '二', '三', '四', '五', '六', '日'].map(w => `<div>${w}</div>`).join('')}</div><div class="ssGrid">`;
    for (let i = 0; i < offset; i++) h += '<div class="ssCell empty"></div>';
    for (let d = 1; d <= daysIn; d++) {
      const key = curMonth + '-' + pad(d);
      const sec = monthData.days[key] || 0;
      const cls = ['ssCell'];
      if (sec > 0) cls.push('has');
      if (key === today) cls.push('today');
      if (key === selDay) cls.push('sel');
      if (key > today) cls.push('future');
      h += `<button class="${cls.join(' ')}" data-day="${key}" ${key > today ? 'disabled' : ''}><span class="ssD">${d}</span>${sec > 0 ? `<span class="ssT">${fmtShort(sec)}</span>` : ''}</button>`;
    }
    h += '</div>';
    document.getElementById('ssCal').innerHTML = h;
    document.getElementById('ssSummary').innerHTML =
      `<div class="ssStat"><span class="ssNum">${fmtDur(monthData.total_sec)}</span><span class="ssLbl">本月共学</span></div>` +
      `<div class="ssStat"><span class="ssNum">${monthData.active_days}</span><span class="ssLbl">学习天数</span></div>`;
    document.querySelectorAll('#ssCal [data-day]').forEach(b => b.addEventListener('click', () => {
      selDay = b.getAttribute('data-day');
      renderCal();
      renderDay();
    }));
  }
  async function renderDay() {
    const box = document.getElementById('ssDetail');
    box.innerHTML = '<p class="muted">加载中…</p>';
    let d;
    try { d = await api('/api/study/day?day=' + encodeURIComponent(selDay)); }
    catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; return; }
    const max = Math.max(1, ...d.records.map(r => r.focus_sec));
    box.innerHTML = `<div class="ssDayHead"><span>📅 ${esc(selDay)}</span><span class="chip">共 ${esc(fmtDur(d.total_sec))}</span><span class="chip gray">${d.records.length} 个节点</span></div>` +
      (d.records.length ? d.records.map(r =>
        `<div class="ssRow"><div class="ssRowTop"><span class="ssNode">${esc(r.node_title)}${r.node_gone ? ' <span class="chip gray">节点已删</span>' : ''}</span><span class="ssDur">${esc(fmtDur(r.focus_sec))}</span></div>` +
        `<div class="ssRowSub">${r.goal_title ? `<a href="#/g/${r.goal_id}">${esc(r.goal_title)}</a>` : ''}</div>` +
        `<div class="ssBar"><div class="ssFill" style="width:${Math.round(r.focus_sec / max * 100)}%"></div></div></div>`
      ).join('') : '<div class="emptyBox" style="margin-top:8px;"><div class="ebText">这天还没记录。开着番茄钟、打开一篇教程专注，时间会自动记到对应节点上。</div></div>');
  }

  SiErXing.registerPlugin({
    id: 'studystats',
    goalEntry: {
      label: '学习统计',
      icon: '📊',
      order: 21,
      header: false,            // 不放目标页顶栏，只进左栏「组件」模块
      hash: () => '#/studystats',
      show: () => true          // 显示与否由组件总开关（compOn）决定
    },
    routes: [
      { match: h => h.match(/^#\/studystats$/), render: async () => { await renderStatsPage(); } }
    ]
  });

  /* 对外极小接口（测试用） */
  window.StudyStats = { _tick: tick, _cache: nodeCache };
})();
