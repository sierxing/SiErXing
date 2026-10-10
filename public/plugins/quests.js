/**
 * 思而行 · 前端插件：今日任务（像游戏里的任务栏）
 * ------------------------------------------------------------------
 * 一屏告诉你：今天推进哪几个节点、每个节点拆成哪几小步、各要多久、还剩多少。
 *   · AI 排今天的依据是「你的实际推进情况 + 每个任务的预计耗时」
 *   · 逐条勾；一个节点全勾完 → 一键把它标为已完成
 *   · 时间不够就点「今天只有 1 小时」，重排一份小的
 */
'use strict';
(function () {
  const { api, esc, toast, mdToHTML } = SiErXing;

  let gid = 0;
  let data = null;          // { date, day, items, minutes, default_minutes, history, candidates, node_titles }
  let busy = false;
  let busyMsg = '';
  let timer = null, busyAt = 0;
  let showAdd = false;

  const WS = '[' + String.fromCharCode(9, 10, 13, 32) + ']+';
  const T = s => String(s == null ? '' : s).split(new RegExp(WS, 'g')).join(' ').trim();
  function fmtMin(m) {
    const n = Math.max(0, Math.round(Number(m) || 0));
    if (!n) return '—';
    if (n % 60 === 0) return (n / 60) + 'h';
    if (n < 60) return n + 'm';
    return Math.floor(n / 60) + 'h' + (n % 60) + 'm';
  }
  /* 节点上的「预计投入」是自由文本：3h / 2 / 1.5 / 40分钟。
     纯数字补个 h，不然界面上会出现「任务预估 1.5」这种半截话。 */
  const hoursLabel = t => {
    const s0 = String(t == null ? '' : t).trim();
    if (!s0) return '';
    return /^\d+(\.\d+)?$/.test(s0) ? s0 + 'h' : s0;
  };
  const items = () => (data && data.items) || [];
  /* 剩余时间按**没勾的小步**算 —— 勾掉一步就该少一截（游戏任务栏那样实时缩） */
  const remainMin = () => items().reduce((a, x) => a + (x.subs || []).filter(s => !s.done)
    .reduce((b, s) => b + (Number(s.min) || 0), 0), 0);
  const totalSub = () => items().reduce((a, x) => a + ((x.subs || []).length), 0);
  const doneSub = () => items().reduce((a, x) => a + ((x.subs || []).filter(s => s.done).length), 0);
  const stateOf = it => it.done ? 'done' : ((it.subs || []).some(s => s.done) ? 'doing' : 'todo');

  function setBusy(on, msg) {
    busy = !!on; busyMsg = msg || '';
    if (on) {
      busyAt = Date.now();
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        const el = document.getElementById('qBusyTxt');
        if (el) el.textContent = busyMsg + '（已等 ' + Math.round((Date.now() - busyAt) / 1000) + ' 秒）';
      }, 1000);
    } else if (timer) { clearInterval(timer); timer = null; }
  }

  async function reload() {
    data = await api('/api/quests?goal_id=' + gid);
  }
  async function act(msg, fn) {
    if (busy) return;
    setBusy(true, msg); draw();
    try { await fn(); await reload(); }
    catch (e) { toast(e.message); }
    setBusy(false); draw();
  }

  /* ---------- 渲染 ---------- */
  function headHTML(extra) {
    return `<div class="jdHead">
      <a class="back" href="#/g/${gid}">← 返回目标</a>
      <span class="mapTitle">🎯 今日任务</span>
      ${extra || ''}
    </div>`;
  }
  function itemHTML(it) {
    const st = stateOf(it);
    const subs = it.subs || [];
    const sdone = subs.filter(s => s.done).length;
    return `<div class="qCard ${st}">
      <div class="qHd">
        <button class="qDot ${st}" data-qitem="${it.id}" data-flag="${it.done ? 0 : 1}"
          title="${it.done ? '取消完成' : '整条标为完成（子任务一起勾上）'}">${st === 'done' ? '✓' : ''}</button>
        <span class="qTitle">${esc(it.title || '')}</span>
        ${it.hours_text ? `<span class="qChip">任务预估 ${esc(hoursLabel(it.hours_text))}</span>` : ''}
        <span class="qChip qToday">今天 ${fmtMin(it.minutes)}</span>
        ${subs.length > 1 ? `<span class="qProg">${sdone}/${subs.length} 步</span>` : ''}
        ${(st === 'done' && it.node_id) ? `<button class="btn tiny" id="qNodeDone${it.id}" data-qnodedone="${it.node_id}">标记该节点已完成</button>` : ''}
      </div>
      ${it.why ? `<div class="qWhy">今天推进它的理由：${esc(it.why)}</div>` : ''}
      <div class="qSubs">${subs.map((s, i) => `
        <label class="qSub ${s.done ? 'done' : ''}">
          <input type="checkbox" data-qsub="${it.id}" data-idx="${i}" ${s.done ? 'checked' : ''}>
          <span class="qSubT">${esc(s.t)}</span>
          <span class="qSubM">${fmtMin(s.min)}</span>
        </label>`).join('')}
      </div>
    </div>`;
  }
  function historyHTML() {
    const h = (data.history || []).filter(x => x.date !== data.date && (x.planned || x.subs));
    if (!h.length) return '';
    return `<div class="qHist">最近：
      ${h.slice(0, 3).map(x => `<span class="qHistI">${esc(x.date.slice(5))} 排 ${fmtMin(x.planned)}·完成 ${x.sdone}/${x.subs} 步</span>`).join('')}
    </div>`;
  }
  function draw() {
    const it = items();
    const d = data || {};
    const n = it.length, dn = it.filter(x => x.done).length;
    const ts = totalSub(), ds = doneSub();
    const pct = ts ? Math.round(100 * ds / ts) : (n && dn === n ? 100 : 0);
    const allDone = n > 0 && dn === n;
    app.innerHTML = `<div class="jdPage qPage">
      ${headHTML(`<span class="chip gray">${esc(d.date || '')}</span>`)}
      ${n ? `<div class="qTop">
        <div class="qTopL">
          <div class="qBig">${ds}<span>/${ts} 步</span></div>
          <div class="qTopM">${allDone ? '今天的任务全做完了 🎉' : ('预计还要 ' + fmtMin(remainMin()))}</div>
        </div>
        <div class="qBar"><i style="width:${pct}%"></i></div>
        <div class="qPct">${pct}%</div>
      </div>` : ''}
      ${d.day && d.day.note ? `<div class="qNote">${esc(d.day.note)}</div>` : ''}
      ${historyHTML()}
      ${busy ? `<div class="rsBusy" id="qBusyTxt">${esc(busyMsg)}</div>` : ''}
      ${n ? `<div class="qList">${it.map(itemHTML).join('')}</div>`
        : `<div class="qEmpty">
             <div class="qEmptyI">🎯</div>
             <div class="qEmptyT">今天还没排</div>
             <div class="qEmptyD">点下面的按钮，AI 会看你最近推进到哪、每个任务大概要多久，
               排今天推进哪几个节点、拆成哪几小步。</div>
             <button class="btn primary" id="qPlanNow">AI 排今天的任务</button>
             <div class="qEmptyM">今天打算投入 <b>${fmtMin(d.minutes || 120)}</b>
               <button class="rsLink" id="qMinSet">改</button></div>
           </div>`}
      ${!n && !busy ? '' : `<div class="qOps">
        <button class="btn primary" id="qPlan">${n ? '🔄 重新排今天' : 'AI 排今天的任务'}</button>
        <button class="btn" id="qMinQ">⏱ 今天只有 <b>${fmtMin(d.minutes || 120)}</b></button>
        <button class="btn" id="qAddBtn">＋ 加一个节点</button>
        ${n ? '<button class="btn danger" id="qClear">🗑 清空今天</button>' : ''}
      </div>`}
      ${showAdd ? `<div class="qAdd">
        <div class="qAddHd">挑一个节点加进今天（它会用你自己的预估耗时作为时长）</div>
        <div class="qAddList">${(data.candidates || []).map(c => `
          <button class="qAddI" data-qadd="${c.id}">
            <span class="qAddT">${esc(c.title)}</span>
            <span class="qAddM">${esc(hoursLabel(c.hours_text) || fmtMin(c.minutes) || '未估')}</span>
          </button>`).join('') || '<span class="muted">路线图上没有可加的节点了</span>'}
        </div>
      </div>` : ''}
    </div>`;

    /* 事件 */
    app.querySelectorAll('[data-qsub]').forEach(cb => cb.addEventListener('change', async () => {
      const itemId = Number(cb.getAttribute('data-qsub'));
      const idx = Number(cb.getAttribute('data-idx'));
      try {
        const r = await api('/api/quests/sub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, item_id: itemId, idx, done: cb.checked }) });
        data.items = r.items;
        draw();
      } catch (e) { toast(e.message); cb.checked = !cb.checked; }
    }));
    app.querySelectorAll('[data-qitem]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/quests/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, item_id: Number(b.getAttribute('data-qitem')), done: b.getAttribute('data-flag') === '1' }) });
        data.items = r.items;
        toast(b.getAttribute('data-flag') === '1' ? '这条标为完成了 ✓' : '已取消');
        draw();
      } catch (e) { toast(e.message); }
    }));
    app.querySelectorAll('[data-qnodedone]').forEach(b => b.addEventListener('click', async () => {
      const nid = Number(b.getAttribute('data-qnodedone'));
      if (!confirm('把这个节点标为「已完成」吗？\n（路线图上的状态会变；今天这条会留在清单里作为记录）')) return;
      try {
        await api('/api/nodes/' + nid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
        toast('节点已标为完成 ✓');
      } catch (e) { toast(e.message); }
    }));
    const pl = document.getElementById('qPlan') || document.getElementById('qPlanNow');
    if (pl) pl.addEventListener('click', () => act('AI 正在看你的推进情况，排今天的任务栏…', async () => {
      const r = await api('/api/quests/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, minutes: data.minutes }) });
      if (r.empty) { toast(r.note || '路线图上的任务都做完了'); return; }
      toast('排好了：今天 ' + fmtMin(r.total || 0) + '、' + (r.items || []).length + ' 个节点');
    }));
    const mq = document.getElementById('qMinQ') || document.getElementById('qMinSet');
    if (mq) mq.addEventListener('click', async () => {
      const v = prompt('今天打算投入多少？（写分钟数，或像 1.5 这样写小时）\n常用：30 / 60 / 90 / 120 / 180', String(data.minutes || 120));
      if (v == null) return;
      const t = String(v).trim();
      const m = /^\d+(\.\d+)?$/.test(t) && Number(t) <= 12 ? Math.round(Number(t) * 60) : Math.round(Number(t) || 0);
      if (!m || m < 10) return toast('至少 10 分钟吧');
      act('记下了…', async () => {
        await api('/api/quests/minutes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, minutes: m }) });
      });
      if (items().length && confirm('要按新的时间重新排一份吗？（今天已勾的进度会尽量保留）')) {
        act('AI 正在按新的时间重排…', async () => {
          await api('/api/quests/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, minutes: m }) });
        });
      }
    });
    const ab = document.getElementById('qAddBtn');
    if (ab) ab.addEventListener('click', () => { showAdd = !showAdd; draw(); });
    app.querySelectorAll('[data-qadd]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/quests/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, node_id: Number(b.getAttribute('data-qadd')) }) });
        data.items = r.items;
        showAdd = false;
        toast(r.already ? '这个节点已经在今天了' : '加进今天了');
        draw();
      } catch (e) { toast(e.message); }
    }));
    const cl = document.getElementById('qClear');
    if (cl) cl.addEventListener('click', async () => {
      if (!confirm('清空今天的任务清单？（路线图上的节点状态不变）')) return;
      try {
        await api('/api/quests/today?goal_id=' + gid, { method: 'DELETE' });
        showAdd = false;
        await reload(); draw();
        toast('已清空');
      } catch (e) { toast(e.message); }
    });
  }

  async function renderPage(goal) {
    gid = Number(goal && goal.id) || 0;
    app.innerHTML = '<p class="muted">加载今日任务…</p>';
    try { await reload(); } catch (e) { app.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; return; }
    draw();
  }

  SiErXing.registerPlugin({
    id: 'quests',
    goalEntry: {
      label: '今日任务', icon: '🎯', order: 44, header: true,
      hash: g => '#/g/' + g + '/quests',
      show: goal => SiErXing.pluginEnabled(goal, 'quests')
    },
    routes: [
      {
        match: h => h.match(/^#\/g\/(\d+)\/quests$/),
        render: async m => { const goal = await SiErXing.loadGoal(Number(m[1])); await renderPage(goal || { id: Number(m[1]) }); }
      }
    ]
  });
})();
