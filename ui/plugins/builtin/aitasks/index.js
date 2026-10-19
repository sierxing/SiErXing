'use strict';
/**
 * 内置 UI 插件 · 任务中心（#/aitasks）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/aitasks/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

/* 本页的全部可变状态：筛选条件、哪些目标展开了、每组已加载的记录 */
function aitS() {
  if (!H.state.ait) H.state.ait = {
    /* preset: '' | today | 7 | 30 | custom；fromDate/toDate 是本地日历上的起止日
       （给 <input type=date> 用），from/to 是按本地日边界换算好的 UTC 时刻（给服务端用）。 */
    filter: { goal: 0, status: '', q: '', preset: '', from: '', to: '', fromDate: '', toDate: '' },
    pageSize: 20,
    open: {}, rows: {}
  };
  return H.state.ait;
}

function aitQuery(extra) {
  const f = aitS().filter, p = [];
  if (f.goal) p.push('goal=' + f.goal);
  if (f.status) p.push('status=' + encodeURIComponent(f.status));
  if (f.from) p.push('from=' + encodeURIComponent(f.from));
  if (f.to) p.push('to=' + encodeURIComponent(f.to));
  if (f.q) p.push('q=' + encodeURIComponent(f.q));
  for (const k of Object.keys(extra || {})) p.push(k + '=' + encodeURIComponent(extra[k]));
  return p.length ? '?' + p.join('&') : '';
}

function aitGoalLabel() {
  const f = aitS().filter;
  if (!f.goal) return '全部目标';
  const g = ((H.state.aitData && H.state.aitData.goals) || []).find(x => Number(x.id) === Number(f.goal));
  return g ? g.title : '（目标已删除）';
}

function aitStatusLabel() {
  const v = aitS().filter.status;
  return v === 'done' ? '✓ 完成' : v === 'failed' ? '✗ 失败' : v === 'cancelled' ? '已停止' : '全部状态';
}

function aitTimeLabel() {
  const f = aitS().filter;
  if (f.preset === 'today') return '今天';
  if (f.preset === '1h') return '最近 1 小时';
  if (f.preset === '6h') return '最近 6 小时';
  if (f.preset === '24h') return '最近 24 小时';
  if (f.preset === '7') return '最近 7 天';
  if (f.preset === '30') return '最近 30 天';
  if (f.preset === 'custom' && f.fromDT && f.toDT) return aitShortDT(f.fromDT) + ' – ' + aitShortDT(f.toDT);
  return '全部时间';
}

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

const aitPageSize = () => {
  const v = Number(aitS().pageSize) || 0;
  return H.AIT_PAGE_OPTS.includes(v) ? v : 20;
};

function aitPaintRun(data) {
  const host = document.getElementById('aitRun');
  if (!host) return;
  const html = aitRunHTML(data);
  if (host.__html !== html) { host.__html = html; host.innerHTML = html; }
  const n = (data.running || []).length;
  const hint = document.getElementById('aitHint');
  if (hint) {
    const sm = data.summary || {};
    hint.textContent = (n ? n + ' 个正在执行 · ' : '')
      + `历史 ${sm.total || 0} 条（✓ ${sm.done || 0} · ✗ ${sm.failed || 0} · ⏹ ${sm.cancelled || 0}）`;
  }
}

function aitPaintHist() {
  const host = document.getElementById('aitHist');
  if (!host) return;
  const data = H.state.aitData || {};
  const f = aitS().filter;
  let groups = data.groups || [];
  if (f.goal) groups = groups.filter(g => Number(g.goalId) === Number(f.goal));
  const body = groups.length
    ? groups.map(aitGrpHTML).join('')
    : `<div class="aitNone">${(data.summary || {}).total ? '没有符合筛选条件的记录。' : '还没有跑完的 AI 任务记录。'}</div>`;
  host.innerHTML = body;
  const allBtn = document.getElementById('aitToggleAll');
  if (allBtn) {
    const anyClosed = groups.some(g => !aitS().open[g.goalId]);
    allBtn.textContent = anyClosed ? '展开全部' : '收起全部';
    allBtn.disabled = !groups.length;
  }
}

function bindAiTasks() {
  const q = document.getElementById('aitQ');
  if (q) {
    let t = null;
    const run = () => {
      aitS().filter.q = q.value.trim();
      aitS().open = {}; aitS().rows = {};
      aitPaintHist();
      const g = aitS().filter.goal || ((H.state.aitData && H.state.aitData.groups || [])[0] || {}).goalId;
      if (aitS().filter.goal) { aitS().open[g] = true; aitLoadRows(g, false).then(aitPaintHist); }
    };
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); });
  }
  /* 三个下拉按钮 + 弹层里的选项。弹层是 body 下的浮动元素，所以选项和"应用"
     都走**文档级委托**，只绑一次（每次进页都绑会越积越多）。 */
  const bar = document.getElementById('aitFilters');
  if (bar) bar.addEventListener('click', e => {
    const b = e.target.closest('[data-ait-open]');
    if (b) { e.stopPropagation(); H.sxiPopShow(b, b.getAttribute('data-ait-open')); return; }
  });
  if (!window.__sxiSelBound) {
    window.__sxiSelBound = true;
    document.addEventListener('click', async e => {
      const pick = e.target.closest && e.target.closest('[data-ait-pick]');
      if (pick) {
        const v = pick.getAttribute('data-ait-pick');
        if (v.indexOf('goal:') === 0) aitS().filter.goal = Number(v.slice(5)) || 0;
        else aitS().filter.status = v.slice(7);
        H.sxiPopClose(); await aitAfterFilterChange();
        return;
      }
      const tm = e.target.closest && e.target.closest('[data-ait-time]');
      if (tm) { aitApplyPreset(tm.getAttribute('data-ait-time')); H.sxiPopClose(); await aitAfterFilterChange(); return; }
      if (e.target.closest && e.target.closest('#sxiRangeGo')) {
        if (aitApplyCustom()) { H.sxiPopClose(); await aitAfterFilterChange(); }
      }
    }, true);
  }
  /* 每页条数：改了就重拉所有已经展开的组（否则旧的 20 条还挂在界面上，
     用户以为"选了 100 却没变"）。收起状态的组不动，等展开时自然会用新页长。 */
  const perPage = document.getElementById('aitPerPage');
  if (perPage) perPage.addEventListener('change', async () => {
    aitS().pageSize = Number(perPage.value) || 20;
    const opened = Object.keys(aitS().open).filter(k => aitS().open[k]);
    for (const k of opened) { aitS().rows[k] = null; await aitLoadRows(Number(k), false); }
    aitPaintHist();
    H.toast('每页显示 ' + aitPageSize() + ' 条');
  });
  const all = document.getElementById('aitToggleAll');
  if (all) all.addEventListener('click', async () => {
    const data = H.state.aitData || {};
    const f = aitS().filter;
    let gs = data.groups || [];
    if (f.goal) gs = gs.filter(g => Number(g.goalId) === Number(f.goal));
    const anyClosed = gs.some(g => !aitS().open[g.goalId]);
    /* ⚠️ 先把所有组的 open 一次性设好、**立刻重画**，再去逐组拉数据。
       曾经是「循环里逐组改状态 → await 拉数据 → 最后才重画」：跑到一半时 state 说已展开、
       DOM 还是收起；此时点某个组头，aitToggle 按 state 算出「展开中 → 该收起」，
       于是一个本来就收起的组被「关」了一下 —— 界面纹丝不动，看起来点了没反应
       （控件审计在「（未关联目标）」那一组上稳定复现）。 */
    const token = (aitS().expandToken || 0) + 1;
    aitS().expandToken = token;
    for (const g of gs) aitS().open[g.goalId] = anyClosed;
    aitPaintHist();
    if (!anyClosed) return;                        /* 收起：状态和 DOM 已一致，不用拉数据 */
    for (const g of gs) {
      if (aitS().expandToken !== token) return;    /* 用户中途手动点了 → 放弃这个循环 */
      if (aitS().rows[g.goalId]) continue;
      await aitLoadRows(g.goalId, false);
    }
  });
  const body = document.getElementById('aitHist');
  if (body) body.addEventListener('click', async e => {
    /* ① 清理「已删除目标」的全部历史（只删 task_runs） */
    const cl = e.target.closest('[data-ait-clean]');
    if (cl) {
      e.stopPropagation();
      const gid2 = Number(cl.getAttribute('data-ait-clean')) || 0;
      if (!gid2) return;
      if (!confirm('清理这个已删除目标的全部任务历史？\n\n只会删掉任务中心的这几行记录，不影响任何目标和数据。')) return;
      try {
        const r2 = await H.api('/api/ai-tasks/history?goal=' + gid2, { method: 'DELETE' });
        H.toast('已清理 ' + (r2.deleted || 0) + ' 条历史');
        aitS().open[gid2] = false; if (aitS().rows) delete aitS().rows[gid2];
        await aitReloadAll();
      } catch (err) { H.toast(err.message); }
      return;
    }
    /* ② 删单条历史 */
    const dl = e.target.closest('[data-ait-del]');
    if (dl) {
      e.stopPropagation();
      const rid2 = Number(dl.getAttribute('data-ait-del')) || 0;
      if (!rid2) return;
      if (!confirm('删掉这一条任务历史？\n\n只删任务中心里的这一行记录，不影响任何目标和数据。')) return;
      try {
        await H.api('/api/ai-tasks/history/' + rid2, { method: 'DELETE' });
        H.toast('已删除这条历史');
        await aitReloadAll();
      } catch (err) { H.toast(err.message); }
      return;
    }
    const hd = e.target.closest('[data-ait-grp]');
    if (hd) { await aitToggle(Number(hd.getAttribute('data-ait-grp'))); return; }
    const more = e.target.closest('[data-ait-more]');
    if (more) { await aitLoadRows(Number(more.getAttribute('data-ait-more')), true); return; }
    const eb = e.target.closest('[data-ait-err]');
    if (eb) {                       /* 要排在跳转前面：它就在可跳转的那一行里 */
      const box = eb.closest('.aitRowWrap') && eb.closest('.aitRowWrap').querySelector('.aitErrBox');
      if (box) box.hidden = !box.hidden;
      return;
    }
    const goEl = e.target.closest('[data-ait-go]');
    if (goEl) { const id = Number(goEl.getAttribute('data-ait-go')); if (id) H.go('#/g/' + id); }
  });
  /* 一键清理所有已删除目标的残留历史（只在真有的时候才渲染这个按钮） */
  const cleanAll = document.getElementById('aitCleanAll');
  if (cleanAll) cleanAll.addEventListener('click', async () => {
    if (!confirm('清理所有「目标已删除」的任务历史？\n\n只会删任务中心里的这些记录，不影响任何目标和数据。')) return;
    try {
      const r = await H.api('/api/ai-tasks/history/orphans', { method: 'DELETE' });
      H.toast('已清理 ' + (r.deleted || 0) + ' 条历史');
      aitS().open = {}; aitS().rows = {};
      await aitReloadAll();
    } catch (err) { H.toast(err.message); }
  });
  const runBox = document.getElementById('aitRun');
  if (runBox) runBox.addEventListener('click', async e => {
    const c = e.target.closest('[data-ait-cancel]');
    if (!c) return;
    try { await H.api('/api/tasks/' + c.getAttribute('data-ait-cancel') + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); H.toast('已请求停止'); await H.taskPoll(); }
    catch (err) { H.toast(err.message); }
  });
}

async function aitLoadRows(goalId, more) {
  const st = aitS();
  const cur = st.rows[goalId] || { rows: [], total: 0, hasMore: false, loading: false };
  if (cur.loading) return;
  cur.loading = true; st.rows[goalId] = cur;
  if (more) { const box = document.querySelector('[data-ait-grpbox="' + goalId + '"] .aitGrpBody'); if (box) box.innerHTML = aitRowsHTML(goalId); }
  try {
    /* goalId=0 是「未关联目标」的真实分组，但 0 会被 aitQuery 的 if(f.goal) 跳过，显式补 goalExp=zero */
    const r = await H.api('/api/ai-tasks/history' + aitQuery({ goal: goalId || '', goalExp: goalId ? '' : 'zero', limit: aitPageSize(), offset: more ? cur.rows.length : 0 }));
    cur.rows = more ? cur.rows.concat(r.rows || []) : (r.rows || []);
    cur.total = r.total || 0;
    cur.hasMore = !!r.hasMore;
  } catch (e) {
    cur.error = e.message;
  }
  cur.loading = false;
  const box = document.querySelector('[data-ait-grpbox="' + goalId + '"] .aitGrpBody');
  if (box) box.innerHTML = aitRowsHTML(goalId);
}

function aitShortDT(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return aitShortDate(s) || String(s || '');
  const hm = m[4] + ':' + m[5];
  const today = new Date();
  const sameDay = Number(m[1]) === today.getFullYear() && Number(m[2]) === today.getMonth() + 1 && Number(m[3]) === today.getDate();
  return (sameDay ? '今天' : (Number(m[2]) + '月' + Number(m[3]) + '日')) + ' ' + hm;
}

function aitRunHTML(data) {
  const f = aitS().filter;
  let run = data.running || [];
  if (f.goal) run = run.filter(t => Number(t.goalId) === Number(f.goal));
  if (!run.length) return '';
  const running = run.filter(t => t.status === 'running').length;
  const queued = run.length - running;
  return `<div class="aitSec">
    <div class="aitSecT">正在执行<span class="aitSecN">${run.length}</span>
      <span class="aitSecSub">${running ? running + ' 个在跑' : ''}${running && queued ? ' · ' : ''}${queued ? queued + ' 个排队' : ''}</span></div>
    <div class="aitRunGrid">${run.map(aitRunningCard).join('')}</div>
  </div>`;
}

/* 一个目标的汇总行：折叠时只有这一行 —— 1000 条记录压成 10 行，靠的就是它 */
function aitGrpHTML(g) {
  const open = !!aitS().open[g.goalId];
  /* 目标已被删除的那一组：给一个「清理历史」（只删 task_runs 行）。 */
  const cleanup = g.goalMissing
    ? '<button type="button" class="btn tiny aitGrpClean" data-ait-clean="' + Number(g.goalId) + '" title="删掉这个已删除目标的全部任务历史（只删历史记录，不碰其它数据）">🧹 清理历史</button>'
    : '';
  return `<div class="aitGrp ${open ? 'open' : ''}" data-ait-grpbox="${g.goalId}">
    <div class="aitGrpHd">
      <button type="button" class="aitGrpOpen" data-ait-grp="${g.goalId}" aria-expanded="${open ? 'true' : 'false'}">
        <span class="aitGrpCaret">${open ? '▾' : '▸'}</span>
        <span class="aitGrpName" title="${H.esc(g.goalTitle)}">${H.esc(g.goalTitle)}</span>
        <span class="aitGrpNums">
          <span class="aitSt done">✓ ${g.done}</span>
          ${g.failed ? `<span class="aitSt failed">✗ ${g.failed}</span>` : ''}
          ${g.cancelled ? `<span class="aitSt cancelled">⏹ ${g.cancelled}</span>` : ''}
          <span class="aitGrpTotal">共 ${g.total}</span>
        </span>
        <span class="aitGrpLast">${g.lastAt ? '最近 ' + aitWhen(g.lastAt) : ''}</span>
      </button>
      ${cleanup}
    </div>
    <div class="aitGrpBody" ${open ? '' : 'hidden'}>${open ? aitRowsHTML(g.goalId) : ''}</div>
  </div>`;
}

/* 改完筛选统一走的收尾：清掉展开状态（换筛选后旧的那一组就不作数了） */
async function aitAfterFilterChange() {
  const st = aitS();
  st.open = {}; st.rows = {};
  if (st.filter.goal) st.open[st.filter.goal] = true;
  /* 汇总与分组也吃同一套筛选，所以换筛选要重拉一次总览 —— 否则筛了"今天"，
     分组标题还写"共 30"（实测踩到过） */
  try { H.state.aitData = await H.api('/api/ai-tasks' + aitQuery()); } catch (e) {}
  aitPaintRun(H.state.aitData || {});
  aitPaintHist();
  aitPaintFilterBtns();
  if (st.filter.goal) { await aitLoadRows(st.filter.goal, false); aitPaintHist(); }
}

function aitApplyPreset(preset) {
  const f = aitS().filter, today = new Date();
  f.preset = preset; f.fromDate = ''; f.toDate = ''; f.fromDT = ''; f.toDT = '';
  if (preset === 'today') { f.from = aitDayISO(today, 0); f.to = aitDayISO(today, 1); }
  else if (preset === '1h') { f.from = aitHoursISO(1); f.to = ''; }
  else if (preset === '6h') { f.from = aitHoursISO(6); f.to = ''; }
  else if (preset === '24h') { f.from = aitHoursISO(24); f.to = ''; }
  else if (preset === '7') { f.from = aitDayISO(today, -6); f.to = aitDayISO(today, 1); }
  else if (preset === '30') { f.from = aitDayISO(today, -29); f.to = aitDayISO(today, 1); }
  else { f.from = ''; f.to = ''; }
}

function aitApplyCustom() {
  const f = aitS().filter;
  const a = String((document.getElementById('aitFrom') || {}).value || '').trim();
  const b = String((document.getElementById('aitTo') || {}).value || '').trim();
  if (!a || !b) { H.toast('起止时间都要填（也可以直接点上面的快捷档）'); return false; }
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (!ta || !tb) { H.toast('时间格式不对，请用"年-月-日 时:分"'); return false; }
  if (ta > tb) { H.toast('开始时间不能晚于结束时间'); return false; }
  f.preset = 'custom'; f.fromDT = a; f.toDT = b; f.fromDate = ''; f.toDate = '';
  f.from = new Date(ta).toISOString();
  /* +59.999 秒：把用户选的那一分钟整个含进去 */
  f.to = new Date(tb + 59_999).toISOString();
  return true;
}

async function aitToggle(goalId, force) {
  /* 用户手动点分组 = 取消进行中的「展开全部」循环（那个循环每组 await 拉数据，
     要好几秒；不取消的话它会在后面把我们刚收起的组又设回展开，看起来像点了没反应）。 */
  aitS().expandToken = (aitS().expandToken || 0) + 1;
  const st = aitS();
  const open = force != null ? force : !st.open[goalId];
  st.open[goalId] = open;
  const box = document.querySelector('[data-ait-grpbox="' + goalId + '"]');
  if (!box) return;
  box.classList.toggle('open', open);
  const hd = box.querySelector('.aitGrpHd');
  if (hd) hd.setAttribute('aria-expanded', open ? 'true' : 'false');
  const caret = box.querySelector('.aitGrpCaret');
  if (caret) caret.textContent = open ? '▾' : '▸';
  const body = box.querySelector('.aitGrpBody');
  if (body) body.hidden = !open;
  if (open && !st.rows[goalId]) { if (body) body.innerHTML = '<div class="aitNone">正在读取…</div>'; await aitLoadRows(goalId, false); }
  else if (open && body) body.innerHTML = aitRowsHTML(goalId);
  const allBtn = document.getElementById('aitToggleAll');
  if (allBtn) {
    const gs = (H.state.aitData && H.state.aitData.groups) || [];
    allBtn.textContent = gs.some(g => !aitS().open[g.goalId]) ? '展开全部' : '收起全部';
  }
}

async function aitReloadAll() {
  try { H.state.aitData = await H.api('/api/ai-tasks' + aitQuery()); } catch (e) {}
  /* 没有「已删除目标」之后，标题旁那个一键清理按钮也要跟着收掉（它内联在标题区，只重画 aitHist 不会重算） */
  const cleanAllBtn = document.getElementById('aitCleanAll');
  if (cleanAllBtn && !((H.state.aitData || {}).groups || []).some(function (g) { return g.goalMissing; })) cleanAllBtn.remove();
  aitPaintRun(H.state.aitData || {});
  aitPaintHist();
  const st = aitS();
  for (const k of Object.keys(st.open)) {
    if (st.open[k]) { st.rows[k] = null; await aitLoadRows(Number(k), false); }
  }
  aitPaintHist();
}

/* 某一组已经加载出来的记录 + 「再看 N 条」 */
function aitRowsHTML(goalId) {
  const box = aitS().rows[goalId];
  if (!box) return '<div class="aitNone">正在读取…</div>';
  if (!box.rows.length) return '<div class="aitNone">这个目标下没有符合条件的记录。</div>';
  const rest = box.total - box.rows.length;
  return aitRowHeadHTML() + box.rows.map(aitHistRowHTML).join('')
    + (rest > 0 || box.hasMore
      ? `<div class="aitMore"><button class="btn tiny" data-ait-more="${goalId}">${box.loading ? '读取中…' : '再看 ' + Math.min(aitPageSize(), Math.max(0, rest)) + ' 条'}${rest > 0 ? '（还有 ' + rest + ' 条）' : ''}</button></div>`
      : '');
}

function aitShortDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (Number(m[2]) + '月' + Number(m[3]) + '日') : String(s || '');
}

function aitRunningCard(t) {
  const m = aitTypeMeta(t.type);
  const st = H.AITASK_ST[t.status] || H.AITASK_ST.running;
  return `<div class="aitRun ${st.cls}">
    <div class="aitRunHd">
      <span class="aitRunIco">${m.icon}</span>
      <span class="aitRunTitle" title="${H.esc(t.title || m.label)}">${H.esc(t.title || m.label)}</span>
      <span class="aitSt ${st.cls}">${st.text}</span>
    </div>
    <div class="aitRunSub">${H.esc(t.goalTitle || '（无目标）')}${t.nodeId ? ' · 节点 #' + t.nodeId : ''}</div>
    ${H.taskProgressHTML(t)}
    <div class="aitRunFoot"><button class="btn tiny" data-ait-cancel="${t.id}">停止</button></div>
  </div>`;
}

function aitWhen(v) {
  const t = Date.parse(String(v || '').replace(' ', 'T'));
  if (!t) return '';
  const d = new Date(t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (new Date().toDateString() === d.toDateString()) return '今天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

function aitPaintFilterBtns() {
  const bar = document.getElementById('aitFilters');
  if (!bar) return;
  const set = (kind, text, on) => {
    const b = bar.querySelector('[data-ait-open="' + kind + '"]');
    if (!b) return;
    b.querySelector('.aitFLabel').textContent = text;
    b.classList.toggle('on', !!on);
    if (text !== b.getAttribute('data-last')) { b.setAttribute('data-last', text); b.title = text; }
  };
  set('goal', aitGoalLabel(), !!aitS().filter.goal);
  set('status', aitStatusLabel(), !!aitS().filter.status);
  set('time', aitTimeLabel(), aitTimeOn());
}

function aitDayISO(base, addDays) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (addDays || 0), 0, 0, 0, 0);
  return d.toISOString();
}

function aitHoursISO(hours) {
  const now = new Date();
  return new Date(now.getTime() - hours * 3600 * 1000).toISOString();
}

function aitRowHeadHTML() {
  return `<div class="aitRowHead"><span></span><span></span><span>状态</span><span>时间</span><span>原因</span><span></span></div>`;
}

function aitHistRowHTML(r) {
  const m = aitTypeMeta(r.type);
  const st = H.AITASK_ST[r.status] || { text: r.status, cls: 'done' };
  /* 顺序固定为：标题 | 状态 | 时间 | 原因。三列宽度写死在 CSS 的网格里，
     所以有无错误、状态是"完成"还是"失败"，竖着看都是齐的。
     原因按钮**永远占位**（没错误时隐形），否则有错误的行会把时间列挤歪。 */
  return `<div class="aitRowWrap">
    <div class="aitRow${r.error ? ' hasErr' : ''}" data-ait-go="${r.goalId || 0}" title="点一下去这个目标">
      <span class="aitRowIcon">${m.icon}</span>
      <span class="aitRowTitle">${H.esc(r.title || m.label)}</span>
      <span class="aitSt ${st.cls}">${st.text}</span>
      <span class="aitRowMeta">${aitWhen(r.createdAt)}${r.costMs ? ' · ' + aitDur(r.costMs) : ''}</span>
      <button class="btn tiny aitRowErrBtn" data-ait-err="1"${r.error ? '' : ' tabindex="-1" aria-hidden="true"'}>看原因</button>
      <button class="btn tiny danger aitRowDelBtn" data-ait-del="${r.runId}" title="删掉这一条任务历史（只删历史记录）">删除</button>
    </div>
    ${r.error ? `<div class="aitErrBox" hidden>${H.esc(r.error)}</div>` : ''}
  </div>`;
}

function aitTypeMeta(type) { return H.TASK_META[type] || { icon: '🤖', label: String(type || '任务') }; }

function aitTimeOn() { return !!(aitS().filter.from || aitS().filter.to); }

/* 给人话，不给裸毫秒和 ISO 串 */
function aitDur(ms) {
  const t = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (t < 60) return t + ' 秒';
  const m = Math.floor(t / 60);
  return m + ' 分' + (t % 60 ? ' ' + (t % 60) + ' 秒' : '');
}

async function renderAiTasksPage() {
  if (H.aitVueEnabled()) {
    try { if (await H.renderAiTasksPageVue()) return; }
    catch (e) { console.warn('[aitasks] Vue 页加载失败，回退旧版：', e && e.message); }
  }
  H.aiTasksStopPoll();
  aitS();
  H.app.innerHTML = '<p class="muted">正在读取 AI 任务…</p>';
  let data;
  try { data = await H.api('/api/ai-tasks' + aitQuery()); } catch (e) {
    H.app.innerHTML = `<div class="page"><div class="pageHead"><button class="back" data-back="#/">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🤖 AI 任务</h2></div>
      <div class="emptyBox" style="margin-top:30px;"><div class="ebIcon">⚠️</div><div class="ebTitle">读取失败</div><div class="ebText">${H.esc(e.message)}</div></div></div>`;
    return;
  }
  H.state.aitData = data;
  const f = aitS().filter;
  H.app.innerHTML = `<div class="page">
    <div class="pageHead">
      <button class="back" data-back="#/">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🤖 AI 任务</h2><span class="aitHeadHint" id="aitHint"></span>
    </div>
    <div id="aitRun"></div>
    <div class="aitSec">
      <div class="aitSecT">历史记录<span class="aitSecN">${(data.summary || {}).total || 0}</span>
        ${(data.groups || []).some(function (g) { return g.goalMissing; })
          ? '<button type="button" class="btn tiny aitCleanAll" id="aitCleanAll" title="一次性删掉所有「目标已删除」的任务历史（只删历史记录）">🧹 清理已删除目标</button>'
          : ''}</div>
      <div class="aitFilters" id="aitFilters">
      <div class="aitFilters" id="aitFilters">
        <input id="aitQ" class="aitQ" placeholder="搜任务标题…" value="${H.esc(f.q)}">
        <button class="aitFbtn" data-ait-open="goal"><span class="aitFLabel">${H.esc(aitGoalLabel())}</span><span class="aitFCaret">▾</span></button>
        <button class="aitFbtn" data-ait-open="status"><span class="aitFLabel">${H.esc(aitStatusLabel())}</span><span class="aitFCaret">▾</span></button>
        <button class="aitFbtn" data-ait-open="time"><span class="aitFLabel">${H.esc(aitTimeLabel())}</span><span class="aitFCaret">▾</span></button>
        <span class="spacer"></span>
        <label class="aitPerPage" title="每个目标一次显示多少条（展开后按这个数量拉取）">每页
          <select id="aitPerPage" class="sxi-sel">${H.AIT_PAGE_OPTS.map(n =>
            `<option value="${n}"${aitPageSize() === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <button class="btn tiny" id="aitToggleAll">展开全部</button>
      </div>
    </div>
    <div id="aitHist"></div>
  </div>`;
  /* 选了某个目标 → 直接把它展开，省一次点击 */
  if (f.goal) aitS().open[f.goal] = true;
  aitPaintRun(data);
  aitPaintHist();
  bindAiTasks();
  if (f.goal) await aitLoadRows(f.goal, false).then(aitPaintHist);
  /* 常驻轻轮询：这一页就是看任务的，随时可能新起一个。历史那块只在总数变了才重画 */
  H.aiTasksTimer = setInterval(async () => {
    if (H.parseRoute().view !== 'aitasks') { H.aiTasksStopPoll(); return; }
    try {
      const d = await H.api('/api/ai-tasks' + aitQuery());
      const before = ((H.state.aitData || {}).summary || {}).total || 0;
      H.state.aitData = d;
      aitPaintRun(d);
      if (((d.summary || {}).total || 0) !== before) aitPaintHist();
    } catch (e) {}
  }, 3000);
}

  function mountAitasks(host) {
    H = host || {};
    return {
      render: function () { return renderAiTasksPage(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['aitasks'] = { id: 'aitasks', mount: mountAitasks };
})();
