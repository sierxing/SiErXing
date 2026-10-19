'use strict';
/**
 * 思而行 · 前端组件：达成条件
 * ------------------------------------------------------------------
 * 目标 → 若干条「达成条件」→ 路线图节点归到条件下面。
 * 这一页要回答两个问题：
 *   1. 每个条件现在推进到哪了（完成节点数 / 总数 + 进度条）；
 *   2. 这个条件对应规划图里的哪些节点（点开还能看节点详情、跳去路线图）。
 *
 * 条件本身由规划时 AI 产出（server.js 的 saveSkeleton），老目标可以在这里
 * 点「从现有规划梳理」让 AI 反推；也可以手动新建/编辑、批量调整节点归属。
 */
(function () {
  const H = window.SiErXing;
  const LV = ['阶段', '小目标', '任务', '子任务', '子任务', '子任务'];
  const ST = { todo: '未开始', doing: '进行中', done: '已完成' };
  const PRIO = { must: { t: '必须', c: 'danger' }, should: { t: '建议', c: 'warn' }, nice: { t: '加分', c: 'gray' } };
  let gid = 0, data = null, goal = null, busy = false, busyTimer = null, busyAt = 0;
  let escClose = null;
  /* 哪几条条件展开了详情（默认全收起：先让用户一眼看完所有条件） */
  let expanded = new Set();

  const appEl = () => document.getElementById('app');
  const esc = s => H.esc(String(s == null ? '' : s));
  const toast = msg => { try { H.toast(msg); } catch (e) {} };
  const pct = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const prioOf = p => PRIO[p] || PRIO.must;
  const nodeOf = id => ((goal && goal.nodes) || []).find(x => Number(x.id) === Number(id)) || null;
  const condOf = id => ((data && data.conditions) || []).find(x => Number(x.id) === Number(id)) || null;
  /* 目标是不是求职/转行类：决定"对应 JD"还是"对应依据"的措辞（组件对任何目标都适用）。 */
  const goalIsJob = () => {
    const g = goal || {};
    const blob = [g.title, g.profile, g.materials, g.summary].map(x => String(x || '')).join(' ');
    return /求职|转行|找工作|实习|校招|社招|面试|简历|岗位|招聘|JD|offer|职业/i.test(blob);
  };

  async function reload() { data = await H.api('/api/goals/' + gid + '/conditions'); }
  async function loadAll() {
    const app = appEl();
    if (!app) return;
    app.innerHTML = '<p class="muted">加载达成条件…</p>';
    try {
      /* loadGoal 的返回值是 undefined：它把目标写进宿主 state.goal（含 nodes） */
      await H.loadGoal(gid).catch(() => null);
      goal = H.state.goal || null;
      await reload();
      draw();
    } catch (e) {
      app.innerHTML = '<p class="muted">' + esc(e.message || e) + '</p>';
    }
  }

  function setBusy(on, msg) {
    busy = !!on;
    const box = document.getElementById('condBusy');
    if (box) { box.hidden = !on; const t = document.getElementById('condBusyTxt'); if (t) t.textContent = msg || ''; }
    if (on) {
      busyAt = Date.now();
      if (busyTimer) clearInterval(busyTimer);
      busyTimer = setInterval(() => {
        const txt = document.getElementById('condBusyTxt');
        if (txt) txt.textContent = (msg || '正在处理') + '（已等 ' + Math.round((Date.now() - busyAt) / 1000) + ' 秒）';
      }, 1000);
    } else if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    document.querySelectorAll('#condPage .btn, #condPage select').forEach(el => {
      if (el.closest('.condDialog')) return;
      if (el.tagName === 'SELECT') el.disabled = !!on; else el.disabled = !!on;
    });
  }

  /* ---------------- 页面 ------------- */
  function summaryHTML() {
    const s = (data && data.summary) || {};
    const conds = (data && data.conditions) || [];
    if (!conds.length) return '';
    const un = Number(s.nodes_unassigned) || 0;
    return '<div class="condSum">' +
      '<div class="condSumTop"><span class="condSumTitle">整体推进</span><span class="condBigPct">' + pct(s.percent) + '%</span></div>' +
      '<div class="bar big"><span class="barFill" style="width:' + pct(s.percent) + '%"></span></div>' +
      '<div class="condSumMeta">' +
        '<span class="chip gray">' + conds.length + ' 条条件 · 已达成 ' + (Number(s.conditions_met) || 0) + ' 条</span>' +
        '<span class="chip gray">节点完成 ' + (Number(s.tasks_done) || 0) + '/' + (Number(s.tasks_total) || 0) + '</span>' +
        (un ? '<span class="chip warn">' + un + ' 个节点未归属条件</span>' : '<span class="chip ok">全部节点已归属条件</span>') +
      '</div></div>';
  }

  function nodeRowHTML(n) {
    const st = ST[n.status] ? n.status : 'todo';
    return '<div class="condNode ' + st + '" data-nid="' + n.id + '" data-level="' + (Number(n.level) || 0) + '" title="点击查看这个节点">' +
      '<span class="condDot ' + st + '"></span>' +
      '<span class="condLv">' + esc(LV[n.level] || '节点') + '</span>' +
      '<span class="condNodeTitle">' + esc(n.title) + '</span>' +
      '<span class="condNodeMeta">' + esc(n.stage_title || '') + (n.hours ? ' · ' + esc(n.hours) : '') + '</span>' +
      '<span class="condNodeSt ' + st + '">' + esc(ST[st]) + '</span>' +
      '</div>';
  }

  function condCardHTML(c) {
    const st = c.stats || {};
    const p = prioOf(c.priority);
    const nodes = c.nodes || [];
    const prioKey = c.priority || 'must';
    const open = expanded.has(Number(c.id));
    /* 收起时只留「优先级 + 标题 + 进度」：所有条件一屏能扫完；展开才看说明 / 达成标准 / 操作 / 节点 */
    return '<div class="condCard prio-' + prioKey + (st.met ? ' met' : '') + (open ? ' open' : '') + '" data-cid="' + c.id + '">' +
      '<div class="condCardHead">' +
        '<span class="chip ' + p.c + '">' + esc(p.t) + '</span>' +
        '<span class="condCardTitle">' + esc(c.title) + '</span>' +
        (c.source === 'manual' ? '<span class="chip gray">手动</span>' : '') +
        (st.met ? '<span class="chip ok">✓ 已达成</span>' : '') +
        '<span class="condCardPct">' + pct(st.percent) + '%</span>' +
        '<button class="condToggle" data-ctoggle="' + c.id + '" aria-expanded="' + (open ? 'true' : 'false') + '" title="' + (open ? '收起这条条件' : '展开这条条件的说明与节点') + '"><span class="condChev">▾</span>详情</button>' +
      '</div>' +
      '<div class="condProgress"><span class="bar"><span class="barFill" style="width:' + pct(st.percent) + '%"></span></span>' +
        '<span class="condCount">' + (Number(st.done) || 0) + '/' + (Number(st.total) || 0) + ' 个节点完成</span></div>' +
      '<div class="condBody">' +
        (c.detail ? '<div class="condDetail">' + esc(c.detail) + '</div>' : '') +
        (c.jd_ref ? '<div class="condJd"><span class="condJdTag">' + (goalIsJob() ? '对应 JD' : '对应依据') + '</span>' + esc(c.jd_ref) + '</div>' : '') +
        (c.acceptance ? '<div class="condAccept"><span class="condAcceptTag">达成标准</span>' + esc(c.acceptance) + '</div>' : '') +
        '<div class="condCardActions">' +
          '<button class="btn tiny" data-cedit="' + c.id + '">✎ 编辑</button>' +
          '<button class="btn tiny danger" data-cdel="' + c.id + '">× 删除</button>' +
          '<span class="spacer"></span>' +
          '<span class="hint">' + (nodes.length ? '对应 ' + nodes.length + ' 个路线图节点' : '还没有节点归属这条条件') + '</span>' +
        '</div>' +
        (nodes.length ? '<div class="condNodes"><div class="condNodesHead">对应路线图节点 · ' + nodes.length + ' 个</div>' +
          '<div class="condNodeList">' + nodes.map(nodeRowHTML).join('') + '</div></div>' : '') +
      '</div>' +
      '</div>';
  }

  function unassignedHTML() {
    const s = (data && data.summary) || {};
    const list = (data && data.unassigned) || [];
    if (!list.length) return '';
    const titles = list.slice(0, 8).map(n => esc(n.title)).join('、');
    return '<div class="condWarn">' +
      '<div class="condWarnHead">⚠️ 还有 ' + (Number(s.unassigned_tasks) || list.length) + ' 个可执行节点没有归属条件</div>' +
      '<div class="condWarnText">未归属的节点不会出现在任何条件的进度里（当前共 ' + (Number(s.nodes_unassigned) || 0) + ' 个节点未归属）。把它们归到条件下面，进度才算完整。</div>' +
      '<div class="condWarnBtns"><button class="btn small" data-assign="1">⚙ 调整节点归属</button></div>' +
      '<details class="condWarnList"><summary>看看是哪些节点</summary><div>' + titles + (list.length > 8 ? ' 等 ' + list.length + ' 个' : '') + '</div></details>' +
      '</div>';
  }

  function pageHTML() {
    const conds = (data && data.conditions) || [];
    const hasNodes = !!(goal && (goal.nodes || []).length);
    const title = (goal && goal.title) || '';
    let body = '';
    if (!hasNodes) {
      body = '<div class="emptyBox"><div class="ebIcon">🧭</div><div class="ebTitle">还没有路线图节点</div>' +
        '<div class="ebText">达成条件要挂在规划节点上。先回到目标页完成 AI 规划（阶段 / 小目标 / 任务），再回来梳理条件。</div>' +
        '<a class="btn primary" href="#/g/' + gid + '">回到目标页</a></div>';
    } else if (!conds.length) {
      body = '<div class="emptyBox"><div class="ebIcon">🎯</div><div class="ebTitle">还没有「达成条件」</div>' +
        '<div class="ebText">阶段是推进台阶，不等于“要达成目标必须满足什么”。一条好的条件要能一句话判定「达成 / 没达成」。<br>让 AI 从现有规划里梳理，或者先手动新建一条，再把节点归到它下面。</div>' +
        '<div class="condEmptyBtns"><button class="btn primary" data-gen="1">✨ 按依据梳理达成条件</button>' +
        '<button class="btn" data-aichat="1">💬 让 AI 聊着梳理</button>' +
        '<button class="btn" data-new="1">＋ 手动新建条件</button></div>' +
        '<div class="hint">新规划时 AI 会自动产出条件；这是给已有规划补的一步。</div></div>';
    } else {
      const allOpen = conds.every(c => expanded.has(Number(c.id)));
      body = summaryHTML() +
        '<div class="condListBar"><span class="hint">共 ' + conds.length + ' 条条件 · 点每条右边的「详情」可以展开达成标准与对应节点</span>' +
        '<button class="btn tiny" data-ctoggleall="1">' + (allOpen ? '全部收起' : '全部展开') + '</button></div>' +
        '<div class="condList">' + conds.map(condCardHTML).join('') + '</div>' + unassignedHTML();
    }
    return '<div class="page condPage" id="condPage">' +
      '<div class="pageHead">' +
        '<button class="back" data-back="#/g/' + gid + '">← 返回目标</button>' +
        '<span class="mapTitle">🎯 达成条件</span>' +
        (title ? '<span class="chip gray">' + esc(title) + '</span>' : '') +
        '<div class="spacer"></div>' +
        (hasNodes ? '<button class="btn small" data-gen="1" title="按依据整批重写现有条件：求职目标按 JD，其它目标按考纲/资料/验收标准（规划生成的条件会被替换，手动条件保留）">✨ 重新梳理条件</button>' +
          '<button class="btn small" data-assign="1">⚙ 调整节点归属</button>' +
          '<button class="btn small" data-aichat="1">💬 让 AI 调整条件</button>' +
          '<button class="btn small primary" data-new="1">＋ 新建条件</button>' : '') +
      '</div>' +
      '<div class="condIntro"><b>阶段 ≠ 条件。</b>阶段是推进台阶；条件是要达成的东西（能判定「达成 / 没达成」）。每个路线图节点都归到某条条件下面，这样每条条件各自推进到哪一步就一目了然。' +
        '<br><span class="condAiTip">条件是「要达成这个目标必须满足的要求」，依据随目标类型走：求职/转行按 JD 条款，学习/考证按考纲与课程要求，项目/作品按交付物与验收标准，认知/习惯按可检验的结果。想<b>整批换掉</b>：点「✨ 重新梳理条件」（会替换规划生成的条件，手动条件保留），或点「💬 让 AI 调整条件」说「把现有条件整批换成 JD/考纲要求」——AI 只会改条件、不会动路线图节点。</span></div>' +
      body +
      '<div class="condBusy" id="condBusy" hidden><span class="condSpin"></span><span id="condBusyTxt"></span></div>' +
      '</div>';
  }

  function draw() {
    const app = appEl();
    if (!app) return;
    app.innerHTML = pageHTML();
    bindPage();
    if (busy) setBusy(true, document.getElementById('condBusyTxt') ? document.getElementById('condBusyTxt').textContent : '正在处理');
  }

  function bindPage() {
    const app = appEl();
    if (!app) return;
    app.querySelectorAll('[data-new]').forEach(el => el.addEventListener('click', () => openForm(null)));
    app.querySelectorAll('[data-aichat]').forEach(el => el.addEventListener('click', openAiChat));
    app.querySelectorAll('[data-gen]').forEach(el => el.addEventListener('click', doGenerate));
    app.querySelectorAll('[data-assign]').forEach(el => el.addEventListener('click', openAssign));
    /* 详情折叠：单条与全部展开/收起（直接改 class，不整页重绘，保留节点详情的展开状态） */
    const syncToggle = (card, btn, open) => {
      if (!card || !btn) return;
      card.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.title = open ? '收起这条条件' : '展开这条条件的说明与节点';
    };
    const syncAllBtn = () => {
      const allBtn = app.querySelector('[data-ctoggleall]');
      if (!allBtn) return;
      const cards = Array.from(app.querySelectorAll('.condCard'));
      allBtn.textContent = (cards.length && cards.every(x => x.classList.contains('open'))) ? '全部收起' : '全部展开';
    };
    app.querySelectorAll('[data-ctoggle]').forEach(btn => btn.addEventListener('click', () => {
      const cid = Number(btn.getAttribute('data-ctoggle'));
      const card = btn.closest('.condCard');
      if (!card) return;
      const open = !card.classList.contains('open');
      if (open) expanded.add(cid); else expanded.delete(cid);
      syncToggle(card, btn, open);
      syncAllBtn();
    }));
    app.querySelectorAll('[data-ctoggleall]').forEach(btn => btn.addEventListener('click', () => {
      const cards = Array.from(app.querySelectorAll('.condCard'));
      if (!cards.length) return;
      const allOpen = cards.every(x => x.classList.contains('open'));
      cards.forEach(card => {
        const cid = Number(card.getAttribute('data-cid'));
        if (allOpen) expanded.delete(cid); else expanded.add(cid);
        syncToggle(card, card.querySelector('[data-ctoggle]'), !allOpen);
      });
      syncAllBtn();
    }));
    app.querySelectorAll('[data-cedit]').forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      const c = condOf(el.getAttribute('data-cedit'));
      if (c) openForm(c);
    }));
    app.querySelectorAll('[data-cdel]').forEach(el => el.addEventListener('click', async e => {
      e.stopPropagation();
      const c = condOf(el.getAttribute('data-cdel'));
      if (!c) return;
      if (!confirm('删除条件「' + c.title + '」？\n它下面的节点只会回到「未归属」，不会删掉节点。')) return;
      setBusy(true, '正在删除条件');
      try { await H.api('/api/conditions/' + c.id, { method: 'DELETE' }); await reload(); draw(); toast('已删除条件'); }
      catch (e2) { toast(e2.message); }
      setBusy(false);
    }));
    /* 点节点行 → 展开详情（再点收起） */
    app.querySelectorAll('.condNode').forEach(el => el.addEventListener('click', ev => {
      if (ev.target.closest('a,button')) return;
      const next = el.nextElementSibling;
      if (next && next.classList && next.classList.contains('condNodeDetail')) { next.remove(); return; }
      app.querySelectorAll('.condNodeDetail').forEach(x => x.remove());
      const nd = nodeOf(el.getAttribute('data-nid'));
      if (!nd) return;
      const div = document.createElement('div');
      div.className = 'condNodeDetail';
      div.innerHTML = nodeDetailHTML(nd);
      el.after(div);
    }));
  }

  function nodeDetailHTML(nd) {
    const srcs = H.safeParse(nd.sources, []) || [];
    const st = ST[nd.status] ? nd.status : 'todo';
    return '<div class="condNdTop"><span class="chip gray">' + esc(LV[nd.level] || '节点') + '</span>' +
      '<span class="chip ' + (st === 'done' ? 'ok' : (st === 'doing' ? 'warn' : 'gray')) + '">' + esc(ST[st]) + '</span>' +
      (nd.hours ? '<span class="chip gray">预计 ' + esc(nd.hours) + '</span>' : '') +
      (srcs.length ? '<span class="chip gray">依据 ' + srcs.length + ' 条</span>' : '') + '</div>' +
      (nd.detail ? '<div class="condNdText">' + esc(nd.detail) + '</div>' : '<div class="condNdText muted">这个节点还没有说明</div>') +
      (nd.acceptance ? '<div class="condNdAcc"><b>验收：</b>' + esc(nd.acceptance) + '</div>' : '') +
      '<div class="condNdFoot"><a class="btn tiny" href="#/g/' + gid + '/map?node=' + nd.id + '">🗺 在路线图中查看</a></div>';
  }

  /* ---------------- 让 AI 助手改（不自己写一套对话） ----------------
     项目定调：AI 问答只有宿主那一套。这里只负责把助手打开、绑到这个目标、
     切到 Agent 模式（ASK 模式 AI 不会改任何东西），用户自己说要怎么改。 */
  async function openAiChat() {
    try {
      /* 用宿主抽屉在此页就地打开（不跳走）：用户可以一边看条件列表一边说怎么改。
         这就是同一个 AI 助手 / 同一批会话 —— 没有另写一套对话。
         只有抽屉不可用时才退回「跳去对话页」的统一入口。 */
      if (typeof H.aiToggleLegacy === 'function') H.aiToggleLegacy(true);
      else if (typeof H.aiToggle === 'function') H.aiToggle(true);
      if (typeof H.aiBindGoal === 'function') await H.aiBindGoal(gid);
      if (typeof H.aiModeSet === 'function') H.aiModeSet('agent');
      /* 关键：把「只改」范围钉到「达成条件」。没有这一句，AI 在条件页也可能去改
         路线图节点（用户真实反馈：让它按 JD 重写条件，它把节点改了一通）。
         服务端收到 edit_scope=conditions 后，会拒绝一切非 condition_* 的 op。 */
      if (typeof H.aiScopeSet === 'function') H.aiScopeSet('conditions');
      if (typeof H.aiFocusInput === 'function') setTimeout(() => { try { H.aiFocusInput(); } catch (e) {} }, 260);
      toast('在右侧直接说要怎么改：比如「把这些条件整批换成 JD 要求」「把第 2 条拆成两条」「把节点 16 归到第 1 条」');
    } catch (e) { toast('打开 AI 助手失败：' + (e.message || e)); }
  }

  /* ---------------- 弹层公共 ---------------- */
  function closeMask() {
    const m = document.getElementById('condMask');
    if (m) m.remove();
    if (escClose) { document.removeEventListener('keydown', escClose); escClose = null; }
  }
  function openMask(inner, opts) {
    closeMask();
    const d = document.createElement('div');
    d.id = 'condMask';
    d.className = 'condMask';
    d.innerHTML = '<div class="condDialog' + (opts && opts.wide ? ' condDialogWide' : '') + '">' + inner + '</div>';
    document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target === d) closeMask(); });
    d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeMask));
    escClose = e => { if (e.key === 'Escape') closeMask(); };
    document.addEventListener('keydown', escClose);
    return d;
  }
  const dlgHead = (title, sub) => '<div class="condDlgHead"><span>' + esc(title) + '</span>' +
    (sub ? '<span class="hint">' + esc(sub) + '</span>' : '') + '<button class="btn tiny" data-close>×</button></div>';

  /* ---------------- 新建 / 编辑条件 ---------------- */
  function openForm(c) {
    const t = c ? c.title : '';
    const detail = c ? c.detail : '';
    const acc = c ? c.acceptance : '';
    const jd = c ? (c.jd_ref || '') : '';
    const prio = c ? (c.priority || 'must') : 'must';
    const inner = dlgHead(c ? '编辑达成条件' : '新建达成条件', '条件要能一句话判定「达成 / 没达成」') +
      '<div class="condDlgBody">' +
        '<div class="field"><label>条件标题</label><input id="cfTitle" maxlength="120" value="' + esc(t) + '" placeholder="如：能独立产出合格的 PRD"></div>' +
        '<div class="field"><label>为什么必须满足它</label><textarea id="cfDetail" maxlength="800" rows="3" placeholder="这条条件在整个目标里的作用，缺了会怎样">' + esc(detail) + '</textarea></div>' +
        '<div class="field"><label>怎么判定达成（可自检）</label><textarea id="cfAcc" maxlength="600" rows="2" placeholder="如：能不看模板写出 1 份包含背景/目标/方案/指标的 PRD，并讲清取舍">' + esc(acc) + '</textarea></div>' +
        '<div class="field"><label>对应依据 / JD 条款（尽量照抄关键句）</label><textarea id="cfJd" maxlength="600" rows="2" placeholder="求职写 JD 原文（如：本科及以上、北京、每周到岗 ≥3 天）；其它目标写考纲/资料要求/验收标准">' + esc(jd) + '</textarea></div>' +
        '<div class="field"><label>优先级</label><select id="cfPrio">' +
          '<option value="must"' + (prio === 'must' ? ' selected' : '') + '>必须达成</option>' +
          '<option value="should"' + (prio === 'should' ? ' selected' : '') + '>建议达成</option>' +
          '<option value="nice"' + (prio === 'nice' ? ' selected' : '') + '>加分项</option>' +
        '</select></div>' +
      '</div>' +
      '<div class="condDlgFoot"><button class="btn" data-close>取消</button>' +
        '<button class="btn primary" id="cfSave">保存</button></div>';
    const d = openMask(inner);
    const saveBtn = d.querySelector('#cfSave');
    saveBtn.addEventListener('click', async () => {
      if (busy) return;
      const title = String((d.querySelector('#cfTitle') || {}).value || '').trim();
      if (!title) return toast('先填一个条件标题');
      const body = { title: title, detail: String((d.querySelector('#cfDetail') || {}).value || '').trim(), acceptance: String((d.querySelector('#cfAcc') || {}).value || '').trim(), jd_ref: String((d.querySelector('#cfJd') || {}).value || '').trim(), priority: (d.querySelector('#cfPrio') || {}).value || 'must' };
      if (c) body.id = c.id;
      setBusy(true, '正在保存条件');
      try {
        await H.api('/api/goals/' + gid + '/conditions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        closeMask();
        await reload(); draw(); toast(c ? '条件已更新' : '条件已创建');
      } catch (e) { toast(e.message); }
      setBusy(false);
    });
    setTimeout(() => { const inp = d.querySelector('#cfTitle'); if (inp) inp.focus(); }, 30);
  }

  /* ---------------- 调整节点归属 ---------------- */
  function assignGroupsHTML() {
    const nodes = (goal && goal.nodes) || [];
    const conds = (data && data.conditions) || [];
    const byParent = new Map();
    for (const n of nodes) {
      const k = n.parent_id == null ? 0 : Number(n.parent_id);
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(n);
    }
    const sorter = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || (Number(a.id) - Number(b.id));
    for (const arr of byParent.values()) arr.sort(sorter);
    function optionsOf(n) {
      const cur = Number(n.condition_id) || 0;
      return '<option value="0"' + (cur ? '' : ' selected') + '>未归属</option>' +
        conds.map(c => '<option value="' + c.id + '"' + (cur === Number(c.id) ? ' selected' : '') + '>' + esc(c.title) + '</option>').join('');
    }
    function rowOf(n) {
      return '<div class="condAssignRow' + (Number(n.condition_id) ? '' : ' unassigned') + '" data-row="' + n.id + '">' +
        '<span class="condLv">' + esc(LV[n.level] || '节点') + '</span>' +
        '<span class="condAssignTitle">' + esc(n.title) + '</span>' +
        '<select data-map="' + n.id + '">' + optionsOf(n) + '</select>' +
        '</div>';
    }
    const stageList = (byParent.get(0) || []).slice();
    if (!stageList.length) return '<div class="muted">这个目标还没有节点。</div>';
    return stageList.map(st => {
      const subs = byParent.get(Number(st.id)) || [];
      const subRows = subs.map(s => rowOf(s) + (byParent.get(Number(s.id)) || []).map(rowOf).join('')).join('');
      return '<div class="condAssignGroup"><div class="condAssignStage">📦 ' + esc(st.title) + '</div>' +
        rowOf(st) + subRows + '</div>';
    }).join('');
  }

  function openAssign() {
    const conds = (data && data.conditions) || [];
    if (!conds.length) return toast('先新建或梳理一条达成条件，再来分配节点');
    const nodes = (goal && goal.nodes) || [];
    if (!nodes.length) return toast('还没有可分配的路线图节点');
    const unassigned = nodes.filter(n => !Number(n.condition_id));
    const inner = dlgHead('调整节点归属', '把阶段 / 小目标 / 任务归到对应条件下面') +
      '<div class="condDlgBody">' +
        '<div class="condAssignTop">' +
          '<label class="condChk"><input type="checkbox" id="condOnlyUn"> 只看未归属</label>' +
          (unassigned.length ? '<span class="condBulk"><span>全部 ' + unassigned.length + ' 个未归属节点归到</span>' +
            '<select id="condBulkSel"><option value="">选择条件…</option>' + conds.map(c => '<option value="' + c.id + '">' + esc(c.title) + '</option>').join('') + '</select>' +
            '<button class="btn small" id="condBulkGo">应用</button></span>' : '') +
        '</div>' +
        '<div class="condAssignList">' + assignGroupsHTML() + '</div>' +
      '</div>' +
      '<div class="condDlgFoot"><span class="hint">改完点保存；任务也可以单独指定，不必跟小目标一致</span>' +
        '<button class="btn" data-close>取消</button><button class="btn primary" id="condAsSave">保存归属</button></div>';
    const d = openMask(inner, { wide: true });
    const onlyUn = d.querySelector('#condOnlyUn');
    if (onlyUn) onlyUn.addEventListener('change', () => {
      d.querySelectorAll('.condAssignRow').forEach(r => {
        r.style.display = (onlyUn.checked && !r.classList.contains('unassigned')) ? 'none' : '';
      });
      d.querySelectorAll('.condAssignGroup').forEach(g => {
        const any = Array.from(g.querySelectorAll('.condAssignRow')).some(r => r.style.display !== 'none');
        g.style.display = any ? '' : 'none';
      });
    });
    d.querySelectorAll('select[data-map]').forEach(sel => sel.addEventListener('change', () => {
      const row = sel.closest('.condAssignRow');
      if (row) row.classList.toggle('unassigned', Number(sel.value) === 0);
    }));
    const bulkGo = d.querySelector('#condBulkGo');
    if (bulkGo) bulkGo.addEventListener('click', async () => {
      if (busy) return;
      const cid = Number((d.querySelector('#condBulkSel') || {}).value) || 0;
      if (!cid) return toast('先选一条条件');
      setBusy(true, '正在批量归属节点');
      try {
        await H.api('/api/goals/' + gid + '/conditions/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ condition_id: cid, node_ids: unassigned.map(n => n.id), cascade: true }) });
        await reload();
        await H.loadGoal(gid).catch(() => null);
        goal = H.state.goal || goal;
        closeMask(); draw(); toast('已归入条件');
      } catch (e) { toast(e.message); }
      setBusy(false);
    });
    const save = d.querySelector('#condAsSave');
    save.addEventListener('click', async () => {
      if (busy) return;
      const map = {};
      d.querySelectorAll('select[data-map]').forEach(sel => {
        const nid = Number(sel.getAttribute('data-map'));
        const val = Number(sel.value) || 0;
        const n = nodes.find(x => Number(x.id) === nid);
        const old = n ? Number(n.condition_id) || 0 : 0;
        if (val !== old) map[nid] = val;
      });
      if (!Object.keys(map).length) { closeMask(); return toast('归属没有变化'); }
      setBusy(true, '正在保存节点归属');
      try {
        await H.api('/api/goals/' + gid + '/conditions/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ map: map }) });
        await reload();
        await H.loadGoal(gid).catch(() => null);
        goal = H.state.goal || goal;
        closeMask(); draw(); toast('归属已保存');
      } catch (e) { toast(e.message); }
      setBusy(false);
    });
  }

  /* ---------------- AI 从现有规划梳理 ---------------- */
  async function doGenerate() {
    if (busy) return;
    if (!(goal && (goal.nodes || []).length)) return toast('还没有路线图节点，先生成规划');
    const conds = (data && data.conditions) || [];
    const isJob = goalIsJob();
    if (conds.length && !confirm('按依据整批重写达成条件？\n\n· 会**替换**现有由 AI / 规划生成的条件；\n· 手动新建的条件会保留；\n· 节点归属会按新条件重新分配。\n\n' +
      (isJob ? '（会按 JD 原文重写；没有 JD 材料时按公共 AIPM JD 高频条款）' : '（会按目标类型选依据：考纲/课程要求、交付物与验收标准、可检验结果…）'))) return;
    setBusy(true, isJob ? 'AI 正在读 JD / 路线图，按 JD 条款重写达成条件' : 'AI 正在读目标资料 / 路线图，按依据重写达成条件');
    try {
      const out = await H.api('/api/goals/' + gid + '/conditions/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await reload();
      await H.loadGoal(gid).catch(() => null);
      goal = H.state.goal || goal;
      draw();
      const n = (out.generated || 0) || (out.conditions || 0);
      const warn = Array.isArray(out.warnings) && out.warnings.length
        ? '；有 ' + out.warnings.length + ' 条看起来像项目/节点名（' + out.warnings.slice(0, 2).join('、') + '），建议改成可判定的要求'
        : '';
      const head = isJob
        ? (out.jd_found ? '已按 JD 原文重写 ' : '没找到 JD 材料，已按公共 AIPM JD 条款重写 ')
        : '已按目标依据重写 ';
      toast(head + n + ' 条条件' + (out.assigned ? '，' + out.assigned + ' 个节点已归属' : '') + warn +
        (isJob && !out.jd_found ? '（把岗位 JD 粘到目标「参考资料」或导入资料库后重试，能对得更准）' : ''));
    } catch (e) { toast(e.message || '梳理失败'); }
    setBusy(false);
  }

  H.registerPlugin({
    id: 'conditions',
    goalEntry: {
      label: '达成条件', icon: '🎯', order: 19, header: true,
      hash: g => '#/g/' + g + '/conditions',
      show: g => H.pluginEnabled(g, 'conditions')
    },
    routes: [{
      match: h => h.match(/^#\/g\/(\d+)\/conditions$/),
      render: async m => {
        gid = Number(m[1]);
        expanded = new Set();   /* 进页面默认全部收起 */
        await loadAll();
      }
    }]
  });
})();
