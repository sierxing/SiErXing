/**
 * 思而行 · 前端插件：用自己的话（把教程知识点内化成用户自己的语言）
 * ------------------------------------------------------------------
 * 和每日刷题里的「🧭 AI 引导提炼思路」同一套机制：**不按固定剧本问**。
 * 提炼大纲时 AI 给每个知识点生成一份「覆盖清单」（3-6 条，照着这个知识点的实质内容定），
 * 用户每答一次，AI 读他已经讲过的话 → 标出讲到的维度（✓）→ 跳过已覆盖的 → 只补最关键的那一块。
 * 清单覆盖得差不多时进入「✦ 打磨」：不再补清单，改问能让表述更扎实的问题。
 * 卡住点「💡 提示」只给方向不给答案，且不消耗当前那一问。
 *
 * 全程用户说了算：可反复答、可追问、可跳过、可随时收尾，没有倒计时、不自动推进。
 */
'use strict';
(function () {
  const { api, esc, toast, mdToHTML } = SiErXing;

  /* ---------- Vue 版页面（渐进迁移；加载失败自动回退旧页面） ---------- */
  let restateVueUnmount = null;
  function restateVueEnabled() {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q === 'legacy') return false;
      if (q === 'vue') return true;
      const saved = localStorage.getItem('sierxing-ui-restate');
      if (saved === 'legacy') return false;
      if (saved === 'vue') return true;
    } catch (e) {}
    return false;   /* 默认原版界面（Vue 版仍在，?ui=vue 可体验）*/
  }
  function ensureRestateVueCss() {
    if (document.querySelector('link[data-ui-page="restate"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui-dist/restate.css'; l.setAttribute('data-ui-page', 'restate');
    document.head.appendChild(l);
  }
  async function renderRestatePageVue(t) {
    const root = document.getElementById('app');
    if (!root) throw new Error('页面容器不存在');
    if (restateVueUnmount) { try { restateVueUnmount(); } catch (e) {} restateVueUnmount = null; }
    ensureRestateVueCss();
    const mod = await import('/ui-dist/restate.js?v=' + Date.now());
    if (!mod || typeof mod.mountRestatePage !== 'function') throw new Error('UI 插件没有导出 mountRestatePage');
    restateVueUnmount = mod.mountRestatePage(root, { api: api, toast: toast, mdToHTML: mdToHTML, tid: Number(t) || 0 });
    return true;
  }
  window.addEventListener('hashchange', function () {
    if (restateVueUnmount && !/^#\/t\/\d+\/restate/.test(location.hash)) {
      try { restateVueUnmount(); } catch (e) {}
      restateVueUnmount = null;
    }
  });

  let tid = 0, points = [], rounds = [], arc = null;
  let view = 'pick';
  let cur = null;          // { round, point, turns }
  let busy = false;
  let busyMsg = '';
  let histIdx = -1;        // 对话存档当前看的知识点

  const DONE = r => r && r.status === 'done' && r.mine;
  /* 某个知识点做过的所有轮次（含对话条数），最新的在前 —— 对话不会因为退出而丢 */
  function roundsOf(idx) {
    return rounds.filter(r => Number(r.point_idx) === idx).slice().reverse();
  }
  /* ---------- 覆盖清单（引导模式）----------
     服务端每轮会带上 coach = { hit, focus, pending }：hit 是 AI 判断"你已经讲到"的维度，
     pending 是当前正等着你回答的那一问。清单本身随每个知识点的实质内容生成，不是写死的四级。 */
  const FALLBACK_DIMS = [
    { key: 'why', name: '为什么需要它', ask: '在遇到它之前这件事怎么做的？卡在哪？它解决了什么麻烦' },
    { key: 'gist', name: '它到底在做什么', ask: '用一句粗话概括它在做的事（别抠细节）' },
    { key: 'how', name: '关键机制', ask: '它靠哪条关键机制成立的，过程大致怎么走' },
    { key: 'cond', name: '前提与边界', ask: '什么条件下才成立、什么情况下会失效' },
    { key: 'contrast', name: '跟什么不一样', ask: '跟最接近的那个东西比，差别到底在哪' },
    { key: 'link', name: '和上下文怎么连', ask: '它在这门知识里处于什么位置，前后跟什么接得上' },
    { key: 'use', name: '什么时候用得上', ask: '什么场景下你会想起它、拿它做什么' }
  ];
  const dimsOf = p => (p && p.dims && p.dims.length) ? p.dims : FALLBACK_DIMS;
  /* 兜底也要能对上老数据：老 points 里只有 steps（名字是缘起/轮廓…），映射到通用维度 */
  const dimsOfPoint = p => {
    if (p && p.dims && p.dims.length) return p.dims;
    if (p && p.steps && p.steps.length) {
      const MAP = { 缘起: 'why', 轮廓: 'gist', 关键: 'how', 串讲: 'use' };
      return p.steps.map((s, i) => ({
        key: MAP[s.t] || ('k' + i), name: String(s.t || ('第' + (i + 1) + '项')).slice(0, 14),
        ask: String(s.q || ''), probe: String(s.hint || '')
      }));
    }
    return FALLBACK_DIMS;
  };
  /* 以**服务端那份清单**为准：它才是 AI 判定 hit/focus 时用的那份。
     两边各算一份的话，服务端挑到前端清单里没有的维度时，界面会出现光秃秃的
     「AI 关注「link」」，而且 ✓ 永远凑不齐。 */
  function curDims() {
    const c = (cur && cur.coach) || {};
    return (c.dims && c.dims.length) ? c.dims : dimsOfPoint(cur && cur.point);
  }
  function coachState() {
    const c = (cur && cur.coach) || {};
    const dims = curDims();
    const hit = (c.hit && c.hit.length) ? c.hit : collectHit();
    /* level/verdict/weak 可能只存在最新那一次的判定里（服务端存的 state 优先） */
    const lv = Number.isFinite(Number(c.level)) && c.level !== null && c.level !== undefined ? Number(c.level) : lastJudge().level;
    return {
      dims, hit, focus: String(c.focus || ''), pending: c.pending || null,
      level: Math.max(0, Math.min(3, lv || 0)),
      verdict: String(c.verdict || lastJudge().verdict || ''),
      weak: String(c.weak || lastJudge().weak || ''),
      /* 「接回自己那句话」独立存一份（用户可能先提问、后被 AI 问），
         pending 不在时也要显示，否则解释就只是"又看懂了一遍" */
      back: String(c.back || (c.pending && c.pending.back) || '')
    };
  }
  /* 服务端没给整体判断时，从最近一次带 level 的判定里取（刷新后也不至于空白） */
  function lastJudge() {
    for (let i = (cur.turns || []).length - 1; i >= 0; i--) {
      let v = {};
      v = objOf(cur.turns[i].verdict);
      if (v.level != null) return { level: Number(v.level) || 0, verdict: String(v.verdict || ''), weak: String(v.weak || '') };
    }
    return { level: 0, verdict: '', weak: '' };
  }
  /* 接口可能已经把数组解析好了（restate 的 gaps/kept 是服务端 parse 过再返回的）。
     这时候再 JSON.parse 会抛异常被 catch 吃掉 —— 页面就静默空一块，很难查。 */
  function listOf(v) {
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function objOf(v) {
    if (v && typeof v === 'object') return v;
    try { const o = JSON.parse(String(v || '{}')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
  }
  /* ---------- 对话名 ----------
     默认用「创建时间」当名字（用户没起名时）。时间必须转本地时区：
     库里存的是 toISOString() 的 UTC，直接切字符串会差 8 小时。 */
  function fmtTime(iso, withDate) {
    const d = new Date(String(iso || ''));
    if (isNaN(d.getTime())) return '';
    const p2 = n => String(n).padStart(2, '0');
    const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
    if (!withDate) return hm;
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    if (sameDay) return '今天 ' + hm;
    return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
  }
  const convName = r => String((r && r.title) || '').trim() || (fmtTime(r && r.created_at, true) || '未命名对话');
  const hasMine = r => !!(r && String(r.mine || '').trim());
  const isActive = r => r && r.status === 'active';
  const convCount = idx => rounds.filter(r => Number(r.point_idx) === idx).length;
  const lastConvOf = idx => {
    const rs = rounds.filter(r => Number(r.point_idx) === idx);
    return rs.length ? rs[rs.length - 1] : null;
  };
  /* 掌握档位的说法（别写"0/1/2/3"给用户看） */
  const LEVEL_TXT = ['还没开口', '能说出关键词', '能讲清机制', '能自己讲成一段'];
  const levelTxt = n => LEVEL_TXT[Math.max(0, Math.min(3, Number(n) || 0))];
  /* 服务端没给 hit（比如刚刷新、还没聊过）时，从历史 turn 的判定里并出来 ——
     这样左栏的 ✓ 不会因为刷新一下就没了。 */
  function collectHit() {
    const out = [];
    for (const t of (cur.turns || [])) {
      let v = {};
      v = objOf(t.verdict);
      for (const k of (v.hit || [])) if (out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }
  const dimName = k => { const d = curDims().find(x => x.key === k); return d ? d.name : (k === 'refine' ? '打磨' : ''); };
  function progressOf(idx) {
    const rs = rounds.filter(r => Number(r.point_idx) === idx && r.mine);
    return { done: rs.length, active: rounds.some(r => Number(r.point_idx) === idx && r.status === 'active') };
  }

  async function renderPage(t) {
    tid = Number(t);
    app.innerHTML = '<p class="muted">加载中…</p>';
    await reload();
    // 落地页要接着上次的地方，而不是一律丢回知识点列表 ——
    // 否则收尾后回来看不到自己说过的话，以为没保存。
    const act = rounds.filter(r => r.status === 'active').pop();
    const lastDone = rounds.filter(DONE).pop();
    const target = act || lastDone;
    if (target) {
      try {
        await loadRound(target.id);
        view = act ? 'talk' : 'done';
      } catch (e) { cur = null; view = 'pick'; }
    } else {
      cur = null;
      view = 'pick';
    }
    draw();
  }
  async function reload() {
    try {
      const r = await api('/api/tutorials/' + tid + '/restate/points');
      points = r.points || [];
      rounds = r.rounds || [];
      arc = r.arc || null;
    } catch (e) { points = []; rounds = []; arc = null; }
  }
  const branchOf = p => (arc && (arc.branches || []).find(b => b.id === p.branch)) || null;
  /* 这个点在架构里的位置：主线第几步 · 哪个知识块的第几个点 */
  function positionOf(idx) {
    if (!arc) return '';
    const p = points[idx];
    if (!p) return '';
    const br = branchOf(p);
    const inBr = br ? points.map((q, i) => (q.branch === br.id ? i : -1)).filter(i => i >= 0) : [];
    const bi = br ? (arc.branches || []).findIndex(b => b.id === br.id) : -1;
    const si = (arc.spine || []).findIndex(s => String(s).indexOf(String(p.title).slice(0, 6)) >= 0);
    const bits = [];
    if (bi >= 0) bits.push('知识块「' + (arc.branches[bi].name || '') + '」第 ' + (inBr.indexOf(idx) + 1) + '/' + inBr.length + ' 个点');
    if (si >= 0) bits.push('主线第 ' + (si + 1) + ' 步');
    return bits.join(' · ');
  }
  /* 读一轮（含 point、全部对话、引导状态），用于刷新后续接 */
  async function loadRound(id) {
    const r = await api('/api/restate-round/' + id);
    cur = { round: r.round, point: r.point || { title: r.round.point_title }, turns: r.turns || [] };
    if (r.coach) {
      cur.coach = r.coach;
      adoptHint();
    }
  }
  /* 提示那一轮不进 coach.pending（它只是挂在当前那一问下面），所以刷新后要从 turns 里捞回来。
     否则"刚才那条提示"会随刷新消失 —— 而它恰恰是用户最需要留着的那句。 */
  function adoptHint() {
    const p = cur && cur.coach && cur.coach.pending;
    if (!p || p.hint) return;
    for (let i = (cur.turns || []).length - 1; i >= 0; i--) {
      let v = {};
      v = objOf(cur.turns[i].verdict);
      if (v.kind === 'hint') { p.hint = { say: v.say || '', probe: v.probe || '' }; return; }
    }
  }

  function headHTML(title, extra) {
    return `<div class="jdHead">
      <a class="back" href="#/t/${tid}">← 返回教程</a>
      <span class="mapTitle">🧠 用自己的话</span>
      ${extra || ''}
      ${title ? `<span class="chip gray">${esc(title)}</span>` : ''}
    </div>`;
  }
  function draw() {
    if (view === 'pick') drawPick();
    else if (view === 'talk') drawTalk();
    else if (view === 'draft') drawDraft();
    else if (view === 'notes') drawNotes();
    else if (view === 'convs') drawConvs(histIdx);
    else drawDone();
    if (view !== 'convs') window.scrollTo(0, 0);
  }

  /* ---------- 知识架构：先看全局，再逐点深入 ---------- */
  function arcHTML() {
    if (!arc || (!arc.thesis && !(arc.spine || []).length && !(arc.branches || []).length)) return '';
    const used = new Set(points.map(p => p.branch));
    return `<div class="rsArc">
      ${arc.thesis ? `<div class="rsArcThesis"><b>这篇教程想让你理解的是</b><br>${esc(arc.thesis)}</div>` : ''}
      ${(arc.spine || []).length ? `<div class="rsArcBlock"><div class="rsArcT">主线怎么推进</div>
        <ol class="rsSpine">${arc.spine.map(s => '<li>' + esc(s) + '</li>').join('')}</ol></div>` : ''}
      ${(arc.branches || []).length ? `<div class="rsArcBlock"><div class="rsArcT">分成这几块</div>
        <div class="rsBranches">${arc.branches.map(b => {
          const n = points.filter(p => p.branch === b.id).length;
          return `<div class="rsBranch ${used.has(b.id) ? '' : 'off'}">
            <div class="rsBranchN">${esc(b.name || '')} <span class="muted">${n} 个点</span></div>
            ${b.gist ? '<div class="rsBranchG">' + esc(b.gist) + '</div>' : ''}</div>`;
        }).join('')}</div></div>` : ''}
    </div>`;
  }
  /* 各点在架构里的位置（悬停/标题都能看到） */
  const branchTagOf = p => {
    const b = branchOf(p);
    return b ? '<span class="rsBranchTag">' + esc(b.name || '') + '</span>' : '';
  };

  /* ---------- 挑知识点 ---------- */
  function drawPick() {
    const doneCount = rounds.filter(DONE).length;
    const woven = arc && arc.weave;
    app.innerHTML = `<div class="jdPage rsPage">
      ${headHTML('整篇的知识架构')}
      ${arcHTML()}
      ${woven ? `<div class="rsSec"><div class="rsSecT">🧩 你自己串起来的整篇</div>
        <div class="rsMine"><div class="rsMineB mdBody">${mdToHTML(woven.narrative || '')}</div></div>
        ${(woven.links || []).length ? '<div class="toolbarRow"><button class="btn" id="rsWeave2">看完整串联</button></div>' : ''}
      </div>` : ''}
      <div class="rsIntro">
        <p>看懂却说不出来，是最常见的假掌握。这里 AI <b>不会先甩答案给你</b>，而是读你写的、自己判断还缺哪一块：</p>
        <ul class="rsLadderIntro">
          <li>每个知识点有一份<b>覆盖清单</b>（由 AI 照着这个知识点的实质内容生成，不是写死的几级）</li>
          <li>你每答一次，它先判断<b>你已经讲到哪些</b>（✓ 打在清单上），已经讲清的<b>不会再问一遍</b></li>
          <li>只补<b>最关键的那一个</b>缺口，给方向不给答案；卡住可以点「💡 卡住了」只拿提示</li>
          <li>清单覆盖得差不多时进入<b>打磨</b>：不再补清单，改问能让你的表述更扎实的问题</li>
        </ul>
        <p class="muted">同一个知识点两次进来，问的顺序可以不一样 —— 它跟着你实际讲了什么走。全程你说了算：可反复答、可追问、可跳过。</p>
        <p class="muted">走完几个点之后，可以点下面的<b>「串起整篇」</b>，AI 会把你说过的话按主线拼成一篇连贯的整体叙述 —— 那是真正的"知识架构内化"。</p>
      </div>
      ${points.length ? `
      <div class="rsSec">
        <div class="rsSecT">知识点（${doneCount ? '已有 ' + doneCount + ' 个沉淀出「我的话」' : '共 ' + points.length + ' 个'}）</div>
        <div class="rsList">${points.map((p, i) => {
          const pr = progressOf(i);
          const rs = roundsOf(i);
          const dl = dimsOfPoint(p);
          // 进行中的那一轮：直接续接，别再开一轮空的（服务端也会兜住）
          const live = rs.find(r => r.status === 'active');
          const liveTurns = live ? (Number(live.turns) || 0) : 0;
          return `<div class="rsPt ${pr.done ? 'done' : ''}">
            <div class="rsPtL"><span class="rsPtDot">${i + 1}</span>
              <span class="rsPtBody"><b>${esc(p.title)} ${branchTagOf(p)}</b><span>${esc(p.summary || '')}</span>
                <span class="rsPtSteps">覆盖清单：${esc(dl.map(x => x.name).join(' · '))}</span>
                ${live ? `<span class="rsPtLive">✍️ 没做完，已说 ${liveTurns} 条 —— 点「继续」接着来</span>` : ''}
                ${rs.length ? `<span class="rsPtHist">🗨 ${rs.length} 个对话 · 共 ${rs.reduce((a, r) => a + (Number(r.turns) || 0), 0)} 条
                  · 最近 ${esc(fmtTime((lastConvOf(i) || {}).updated_at || (lastConvOf(i) || {}).created_at, true))}
                  <button class="btn tiny" data-rs-hist="${i}">对话历史</button></span>` : ''}</span></div>
            <div class="rsPtR">
              ${pr.done ? '<span class="rsTag ok">已沉淀 ' + pr.done + ' 版</span>' : ''}
              ${live ? '<span class="rsTag act">进行中</span>' : ''}
              <button class="btn small primary" data-rs-go="${i}">${live ? '继续' : (rs.length ? '新对话' : '开始')}</button>
              ${(!live && rs.length) ? `<button class="btn small" data-rs-hist="${i}" title="回到之前的某个对话继续">历史 ${rs.length}</button>` : ''}
            </div>
          </div>`;
        }).join('')}</div>
      </div>` : `
      <div class="rsSec"><div class="rsSecT">知识点大纲</div>
        <p class="muted">还没提炼。先让 AI 从这篇教程里拆出知识点，并为每个点生成一份覆盖清单。</p></div>`}
      <div class="toolbarRow">
        ${points.length ? `<button class="btn primary" id="rsWeave" ${doneCount < 1 ? 'disabled title="先至少走完一个点并收尾"' : ''}>🧩 串起整篇${doneCount ? '（已沉淀 ' + doneCount + ' 个点）' : ''}</button>
          <button class="btn" id="rsRedo">重新提炼架构</button>`
          + (doneCount ? `<button class="btn" id="rsNotes">看我沉淀的话（${doneCount}）</button>` : '')
          : '<button class="btn primary" id="rsOutline">提炼架构</button>'}
      </div>
    </div>`;

    const ob = document.getElementById('rsOutline');
    if (ob) ob.addEventListener('click', () => doOutline(ob));
    const rd = document.getElementById('rsRedo');
    if (rd) rd.addEventListener('click', async () => {
      if (!confirm('重新提炼会覆盖现有大纲（已沉淀的话不受影响）。继续？')) return;
      await doOutline(rd, true);
    });
    const nb = document.getElementById('rsNotes');
    if (nb) nb.addEventListener('click', drawNotes);
    const wv = document.getElementById('rsWeave');
    if (wv) wv.addEventListener('click', () => drawWeave());
    const wv2 = document.getElementById('rsWeave2');
    if (wv2) wv2.addEventListener('click', () => drawWeave());
    app.querySelectorAll('[data-rs-hist]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      await drawConvs(Number(b.getAttribute('data-rs-hist')));
    }));
    app.querySelectorAll('[data-rs-go]').forEach(b => b.addEventListener('click', async () => {
      const i = Number(b.getAttribute('data-rs-go'));
      b.disabled = true;
      try {
        const r = await api('/api/tutorials/' + tid + '/restate/round', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ point_idx: i })
        });
        // ⚠️ 必须用服务端返回的 turns。之前写死 turns:[]，
        // 续接已有轮次时对话全被清空 —— 表现就是"换个知识点再回来，记录没了"。
        cur = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null };
            await reload();          // 服务端可能把别的对话归档了（一个点只留一个进行中）
        view = 'talk';
        draw();
        if (r.resumed) toast('接着上次那一轮继续');
        // 还没有正在等回答的那一问（比如新开的一轮）→ 让 AI 先问第一句。
        // 已有的 pending 绝不覆盖：刷新页面不能把用户眼前那一问顶掉。
        if (!cur.coach || !cur.coach.pending) askNext(true);
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
  }
  async function doOutline(btn, force) {
    btn.disabled = true;
    btn.textContent = '提炼中…（约半分钟）';
    try {
      const r = await api('/api/tutorials/' + tid + '/restate/points', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force })
      });
      points = r.points || [];
      rounds = r.rounds || [];
      toast('大纲已提炼（' + points.length + ' 个知识点）');
    } catch (e) { toast(e.message); }
    draw();
  }

  /* ---------- 串起整篇：把各点的话按主线拼成一篇 ---------- */
  async function drawWeave() {
    app.innerHTML = '<p class="muted">加载…</p>';
    let w = (arc && arc.weave) || null;
    if (!w) {
      app.innerHTML = `<div class="jdPage rsPage">${headHTML('串起整篇')}
        <div class="rsSec"><p class="rsBusy" style="text-align:left;">AI 正在把你说过的话按主线串成一篇连贯叙述，这一步会比单点久一些…</p></div></div>`;
      try {
        const r = await api('/api/tutorials/' + tid + '/restate/weave', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        w = r.weave;
        arc = arc || {};
        arc.weave = w;
        toast('已串起 ' + (r.used || 0) + ' 个点');
      } catch (e) { toast(e.message); view = 'pick'; draw(); return; }
    }
    app.innerHTML = `<div class="jdPage rsPage">
      ${headHTML('你自己串起来的整篇')}
      <div class="rsSec">
        <div class="rsSecT">用你自己的话，把这篇教程讲了一遍</div>
        <div class="rsWeaveBody mdBody">${mdToHTML(w.narrative || '')}</div>
        <div class="toolbarRow"><button class="btn tiny" id="rsWCopy">复制</button><button class="btn tiny" id="rsWRe">用最新的话重串一次</button></div>
      </div>
      ${(w.links || []).length ? `<div class="rsSec">
        <div class="rsSecT">你可能还没连起来的关系</div>
        <div class="rsLinks">${w.links.map(l => `<div class="rsLink">
          <div class="rsLinkP"><span>${esc(l.a)}</span><i>↔</i><span>${esc(l.b)}</span></div>
          <div class="rsLinkH">${esc(l.how || '')}</div></div>`).join('')}</div>
      </div>` : ''}
      ${(w.missing || []).length ? `<div class="rsSec">
        <div class="rsSecT">还没走到的块</div>
        <div class="rsChips">${w.missing.map(x => '<span class="rsChip miss">' + esc(x) + '</span>').join('')}</div>
      </div>` : ''}
      <div class="toolbarRow">
        <button class="btn" id="rsWBack">← 回到知识点列表</button>
        <button class="btn" id="rsWTut">← 返回教程</button>
      </div>
    </div>`;
    const cp = document.getElementById('rsWCopy');
    if (cp) cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(w.narrative || ''); toast('已复制'); }
      catch (e) { toast('复制失败，可手动选中'); }
    });
    document.getElementById('rsWRe').addEventListener('click', async () => {
      if (!confirm('用你最新沉淀的话重新串一次？')) return;
      arc.weave = null;
      await drawWeave();
    });
    document.getElementById('rsWBack').addEventListener('click', () => { view = 'pick'; draw(); });
    document.getElementById('rsWTut').addEventListener('click', () => { location.hash = '#/t/' + tid; });
  }

  /* ---------- 对话存档（只读）：任何一轮都能翻回去看 ---------- */
  /* ---------- 会话管理 ----------
     一个知识点下可以有很多次对话。默认用创建时间当名字，用户可以改；
     可以「继续」任意一个（把它重新置为进行中）、看结果、看当时的对话，也可以删掉。
     以前这里只是只读的"对话存档"，翻出来也接不上，等于历史没用。 */
  async function drawConvs(idx) {
    view = 'convs';
    histIdx = idx;
    app.innerHTML = '<p class="muted">加载对话…</p>';
    const point = points[idx] || { title: '' };
    const rs = roundsOf(idx);                 // 最新的在前
    const live = rs.find(isActive);

    const rowHTML = r => {
      const badge = isActive(r) ? '<span class="rsTag act">进行中</span>'
        : (hasMine(r) ? '<span class="rsTag ok">已沉淀</span>' : '<span class="rsTag">已归档</span>');
      const n = Number(r.turns) || 0;
      const named = !!String(r.title || '').trim();
      return `<div class="rsConv${isActive(r) ? ' live' : ''}" data-conv="${r.id}">
        <div class="rsConvHd">
          <span class="rsConvName" data-cname="${r.id}" title="${named ? '双击可以改名' : '这个名字是按创建时间自动取的，可以改'}">${esc(convName(r))}</span>
          ${badge}
          <span class="rsConvMeta">${n ? n + ' 条' : '还没开口'} · ${esc(fmtTime(r.updated_at || r.created_at, true))}${named ? '' : ' 创建'}</span>
          <span class="rsConvActs">
            <button class="btn tiny primary" data-copen="${r.id}">${isActive(r) ? '继续' : '接着聊'}</button>
            ${hasMine(r) ? `<button class="btn tiny" data-cresult="${r.id}">看结果</button>` : ''}
            ${n ? `<button class="btn tiny" data-cturns="${r.id}">看对话</button>` : ''}
            <button class="btn tiny" data-cedit="${r.id}" title="重命名">✏️</button>
            <button class="btn tiny" data-cdel="${r.id}" title="删除这个对话">🗑</button>
          </span>
        </div>
        <div class="rsConvBody" hidden></div>
      </div>`;
    };

    app.innerHTML = `<div class="jdPage rsPage">
      ${headHTML('对话历史')}
      <div class="rsSec">
        <div class="rsSecT">${esc(point.title || '')}</div>
        <p class="hint" style="margin:0;">共 ${rs.length} 个对话。退出页面、刷新、关掉浏览器都不会丢；点「继续」就能接着上次聊。</p>
        <div class="toolbarRow" style="margin-top:10px;">
          <button class="btn primary" id="rsNewConv">＋ 新建对话</button>
          ${live ? '<span class="muted">（当前有个没聊完的，新建会把它收起来，随时还能回来）</span>' : ''}
        </div>
      </div>
      <div class="rsConvs">${rs.length ? rs.map(rowHTML).join('') : '<p class="muted">还没有对话。点上面的「新建对话」开始。</p>'}</div>
      <div class="toolbarRow"><button class="btn" id="rsHBack">← 返回知识点</button></div>
    </div>`;

    document.getElementById('rsHBack').addEventListener('click', () => { view = 'pick'; draw(); });
    document.getElementById('rsNewConv').addEventListener('click', e => newConv(e.currentTarget, idx));

    /* 继续 / 接着聊：把它重新置为进行中并进去。沉淀过的内容不受影响。 */
    app.querySelectorAll('[data-copen]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-copen'));
      b.disabled = true;
      try {
        const r = await api('/api/tutorials/' + tid + '/restate/round', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ point_idx: idx, round_id: id })
        });
        cur = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null };
            await reload();          // 重新置为进行中会让原来那个归档 → 列表要跟着更新
        view = 'talk';
        draw();
        if (!cur.coach || !cur.coach.pending) askNext(true);
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
    /* 看结果：沉淀过的那一版 */
    app.querySelectorAll('[data-cresult]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-cresult'));
      b.disabled = true;
      try {
        await loadRound(id);
        view = 'done';
        draw();
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
    /* 看对话：就地展开当时的记录，不用跳走 */
    app.querySelectorAll('[data-cturns]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-cturns'));
      const box = app.querySelector('[data-conv="' + id + '"] .rsConvBody');
      if (!box) return;
      if (!box.hidden) { box.hidden = true; b.textContent = '看对话'; return; }
      if (!box.dataset.loaded) {
        box.innerHTML = '<p class="muted">加载…</p>';
        try {
          const x = await api('/api/restate-round/' + id);
          const turns = x.turns || [];
          const r = rs.find(y => y.id === id) || {};
          let gaps = [], kept = [];
          gaps = listOf(r.gaps); kept = listOf(r.kept);
          box.innerHTML = (turns.length ? `<div class="rsThread">${turns.map(t => turnHTML(t, -1)).join('')}</div>`
              : '<p class="muted">这个对话还没说过话。</p>')
            + (hasMine(r) ? `<div class="rsMine"><div class="rsMineT">🗣 这个对话沉淀的「我的话」</div><div class="rsMineB mdBody">${mdToHTML(r.mine)}</div></div>
              ${r.line ? '<p class="rsLine">' + esc(r.line) + '</p>' : ''}` : '');
          box.dataset.loaded = '1';
        } catch (e) { box.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
      }
      box.hidden = false;
      b.textContent = '收起';
    }));
    /* 重命名：就地变成一个输入框 */
    app.querySelectorAll('[data-cedit]').forEach(b => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-cedit'));
      const span = app.querySelector('[data-cname="' + id + '"]');
      const r = rs.find(y => y.id === id) || {};
      if (!span || span.dataset.editing) return;
      span.dataset.editing = '1';
      span.innerHTML = `<input class="rsConvInput" maxlength="40" value="${esc(String(r.title || ''))}"
        placeholder="${esc(fmtTime(r.created_at, true) || '对话名')}">`;
      const inp = span.querySelector('input');
      inp.focus(); inp.select();
      let committing = false;
      const commit = async () => {
        if (committing) return;
        committing = true;
        const v = String(inp.value || '').trim();
        try {
          const x = await api('/api/restate-round/' + id + '/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v })
          });
          const t = rounds.find(y => y.id === id);
          if (t) t.title = (x.round && x.round.title) || '';
          if (cur && cur.round && cur.round.id === id) cur.round.title = (x.round && x.round.title) || '';
          toast(v ? '已改名：' + v : '已恢复成默认名字');
        } catch (e) { toast(e.message); }
        draw();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); span.dataset.editing = ''; draw(); }
      });
      inp.addEventListener('blur', () => { if (span.dataset.editing) commit(); });
    }));
    /* 删除：先确认，说清会删掉什么 */
    app.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-cdel'));
      const r = rs.find(y => y.id === id) || {};
      const n = Number(r.turns) || 0;
      const warn = '删掉这个对话？\n\n「' + convName(r) + '」' + (n ? '（' + n + ' 条对话记录）' : '')
        + (hasMine(r) ? '，包括它沉淀的那版「我的话」' : '') + '\n\n删了就找不回来了。';
      if (!confirm(warn)) return;
      b.disabled = true;
      try {
        await api('/api/restate-round/' + id, { method: 'DELETE' });
        rounds = rounds.filter(y => y.id !== id);
        if (cur && cur.round && cur.round.id === id) { cur = null; }
        toast('已删除');
      } catch (e) { toast(e.message); }
      draw();
    }));
  }
  /* 新建对话：把当前没聊完的那个收起来（不删），另开一个干净的 */
  async function newConv(btn, idx) {
    btn.disabled = true;
    try {
      const r = await api('/api/tutorials/' + tid + '/restate/round', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point_idx: idx, fresh: true })
      });
      cur = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null };
        await reload();          // 新对话要进历史列表（不然 rounds 还是旧的，列表里看不到它）
      view = 'talk';
      draw();
      askNext(true);
    } catch (e) { toast(e.message); btn.disabled = false; }
  }

  /* ---------- 覆盖清单 ----------
     不是顺序剧本，是「值得覆盖到」的检查表：✓ = AI 判断你已经讲到；
     高亮 = AI 这一轮选中的关注点。所以同一个知识点两次进来，问的顺序可以不一样。 */
  function ladderHTML() {
    const c = coachState();
    const allDone = c.dims.every(d => c.hit.indexOf(d.key) >= 0);
    /* 掌握档位：光有 ✓/✗ 看不出"AI 眼里我现在到底什么水平"，
       所以单独给一条 —— 从"能说出关键词"到"能自己讲成一段"是四个能感觉到的台阶。 */
    const lvHTML = `<div class="rsLevel">
      <div class="rsLevelHd"><span>AI 判断你的掌握</span><span class="rsSub">${esc(levelTxt(c.level))}</span></div>
      <div class="rsLevelBar">${[0, 1, 2, 3].map(i =>
        '<span class="rsLevelStep' + (i <= c.level ? ' on' : '') + '">' + (i === 0 ? '关键词' : i === 1 ? '说得清' : i === 2 ? '讲得透' : '讲成段') + '</span>'
      ).join('')}</div>
      ${c.verdict ? `<div class="rsLevelV">${esc(c.verdict)}</div>` : ''}
      ${c.weak ? `<div class="rsLevelW">最薄弱：${esc(c.weak)}</div>` : ''}
    </div>`;
    return lvHTML + `<div class="rsDims">
      <div class="rsDimsHd"><span>覆盖清单</span>
        <span class="rsSub">${c.hit.length}/${c.dims.length} 已讲到 · AI 自己挑下一个问什么</span></div>
      <div class="rsDimsRow">${c.dims.map(d => {
        const on = c.hit.indexOf(d.key) >= 0;
        return '<span class="rsDim' + (on ? ' on' : '') + (d.key === c.focus ? ' cur' : '') + '"'
          + ' title="' + esc(d.ask || d.name) + '">' + (on ? '✓ ' : '') + esc(d.name) + '</span>';
      }).join('')}
      ${(allDone || c.focus === 'refine') ? '<span class="rsDim cur refine" title="覆盖清单基本都到了 —— 这一轮改问能让表述更扎实的东西，而不是继续走清单">✦ 打磨</span>' : ''}
      </div>
    </div>`;
  }
  /* 当前该回的那一问：优先用服务端 pending（它才是"正等着你回答"的那一问） */
  function pendingAsk() {
    const c = coachState();
    return c.pending && c.pending.probe ? c.pending : null;
  }

  /* 三栏：左=问题（常驻可见）· 中=对话（自己滚）· 右=选中那一轮的解析。
     这样对话再长也压不跑问题；每一轮的解析都留在右栏，点哪轮看哪轮，翻回去也还在。 */
  function drawTalk() {
    const point = cur.point || { title: '' };
    const turns = cur.turns || [];
    const c = coachState();
    /* 叫 askQ 不叫 ask：同名会把下面的 ask() 函数遮蔽掉，
       结果「不明白，问一句」按钮永远绑不上事件（点着没反应）。 */
    const askQ = pendingAsk();
    const spoke = turns.some(x => x.user_text);
    const pos = positionOf(Number(cur.round.point_idx || 0));

    app.innerHTML = `<div class="jdPage rsPage rsTalkPage">
      ${headHTML('', '<span class="chip rsChipConv" title="当前对话（可以改名）">🗨 ' + esc(convName(cur.round)) + '</span>')}
      <div class="rsPanes" id="rsPanes">
        <aside class="rsPane rsPaneQ">
          <div class="rsPaneT">🧭 上下文</div>
          <div class="rsPaneBody">
            <div class="rsPaneTopic">${esc(point.title || '')}</div>
            ${pos ? '<div class="rsPos">📍 ' + esc(pos) + '</div>' : ''}
            ${ladderHTML()}
            ${askQ && askQ.hint
              ? `<div class="rsQ"><details class="rsKey" open><summary>刚才的提示（只给方向，不是答案）</summary><p>${esc((askQ.hint.probe || askQ.hint.say || ''))}</p></details></div>`
              : (!askQ && !busy
                ? '<p class="rsQQ muted">' + (spoke ? '覆盖清单上的点都讲到了 —— 点「下一问」让它继续追问，或直接收尾。' : '点下面「下一问」，AI 会挑最该先弄清的那一条问你。') + '</p>'
                : '')}
          </div>
          <div class="rsNav">
            <button class="btn tiny" id="rsHint" title="不给答案，只把方向指出来">💡 卡住了</button>
            <button class="btn tiny primary" id="rsNext">${askQ ? '换一个问法 →' : '下一问 →'}</button>
            <button class="btn tiny" id="rsConvs" title="回到这个知识点的对话历史">🗨 历史</button>
          </div>
          <div class="rsNavFoot">
            <button class="rsLink" id="rsBack">← 换个知识点</button>
          </div>
        </aside>
        <div class="rsSplit" data-k="q" role="separator" aria-orientation="vertical" title="${tr('拖动调宽 · 双击复位')}"><span class="rsGrip" aria-hidden="true" title="${tr('拖动调宽 · 双击复位')}"></span></div>

        <section class="rsPane rsPaneC">
          <div class="rsPaneT">💬 对话
            <span class="rsPaneN">${turns.length ? turns.length + ' 轮' : '还没开口'}</span>
            ${turns.length ? '<button class="btn tiny" id="rsLatest">跳到最新 ↓</button>' : ''}
          </div>
          <div class="rsThread" id="rsThread">${turns.length ? turns.map(t => turnHTML(t, false)).join('')
            : `<div class="rsEmpty"><span class="rsEmptyI">🤔</span>
                 <p>AI 会读你写的，<b>自己判断还缺哪一块</b>，然后只补那一块。<br>
                    你已经说清楚的地方，它不会再让你重说一遍。<br><br>
                    如果第一句还没出来，点左下「下一问」。</p></div>`}
          </div>
          ${busy ? '<div class="rsBusy">' + (busyMsg || 'AI 在想…') + '</div>' : ''}
          <div class="rsInput">
            <textarea id="rsSay" rows="2" placeholder="你怎么想就怎么说，不用组织语言（Ctrl/⌘+Enter 发送）"></textarea>
            <div class="rsInputBtns">
              <button class="btn primary" id="rsSend"${busy || !askQ ? ' disabled title="先让 AI 问一句"' : ''}>${busy ? 'AI 在读…' : '我说完了'}</button>
              <button class="btn" id="rsAsk">不明白，问一句</button>
              ${spoke ? '<button class="btn" id="rsFinish">整理成我的话</button>' : ''}
            </div>
          </div>
        </section>
      </div>
    </div>`;

    const ta = document.getElementById('rsSay');
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(false, false); }
    });
    document.getElementById('rsSend').addEventListener('click', () => send(false, false));
    document.getElementById('rsAsk').addEventListener('click', ask);   // ← 全局那个函数，别用被遮蔽的 askQ
    const nx = document.getElementById('rsNext');
    if (nx) nx.addEventListener('click', () => send(true, false));
    const hb = document.getElementById('rsHint');
    if (hb) hb.addEventListener('click', () => send(false, true));
    const fb = document.getElementById('rsFinish');
    if (fb) fb.addEventListener('click', finish);
    document.getElementById('rsBack').addEventListener('click', () => { cur = null; view = 'pick'; draw(); });
    const cv = document.getElementById('rsConvs');
    if (cv) cv.addEventListener('click', () => drawConvs(Number((cur.round && cur.round.point_idx) || 0)));
    const lt = document.getElementById('rsLatest');
    if (lt) lt.addEventListener('click', scrollThreadToEnd);
    initSplit();
    scrollThreadToEnd();
    setTimeout(() => { if (!busy) ta.focus(); }, 30);
  }
  /* ---------- 三栏宽度可拖动 ----------
     宽度写在 CSS 变量 --rs-col-q 上，存在 localStorage。
     两侧都夹住，中栏永远留够宽度 —— 否则拖过头会把对话挤成一条缝。
     ⚠️ 用户反馈过两个问题，别再改回去：
       ① 初始太窄（原来的 320px 只够放标题）→ 默认放大到 380；
       ② 把手只有 6px 透明热区，用户"看不出来能拖动"→ 现在把手常驻成
          一根带握把纹的竖条（见 .rsGrip），hover 变主题色。 */
  const COL_KEY = 'sierxing-restate-cols-v1';
  const COL_DEF = { q: 380 };
  const COL_MIN = { q: 230 };
  function colCfg() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(COL_KEY) || '{}') || {}; } catch (e) { o = {}; }
    let q = clampCol('q', o.q);
    /* 老默认值 320 当成"没调过"：用户没主动拖过就不该被旧默认值卡在窄栏上 */
    if (q === 320) q = COL_DEF.q;
    return { q: q };
  }
  function clampCol(k, v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), COL_MIN[k]), 680) : COL_DEF[k];
  }
  function applyCols(cfg) {
    const c = cfg || colCfg(), el = document.getElementById('rsPanes');
    if (!el) return;
    el.style.setProperty('--rs-col-q', c.q + 'px');
  }
  function initSplit() {
    const el = document.getElementById('rsPanes');
    if (!el) return;
    applyCols();
    el.querySelectorAll('.rsSplit').forEach(h => {
      h.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const k = h.getAttribute('data-k');
        const cfg = colCfg();
        const box = el.getBoundingClientRect();
        // 一根 12px 把手 + 中栏两侧的外边距(7px×2)
        const chrome = 26;
        const startX = e.clientX, startW = cfg[k];
        const MID_MIN = 420;
        const maxW = Math.max(COL_MIN[k], box.width - chrome - MID_MIN);
        document.body.classList.add('rsResizing');
        /* setPointerCapture 对合成事件会抛（pointerId 不存在）—— 包一层，
           免得监听器没绑上、拖动直接失效 */
        try { h.setPointerCapture && h.setPointerCapture(e.pointerId); } catch (err) {}
        const move = ev => {
          const d = ev.clientX - startX;
          /* 把手就在左栏右边：往右拖(d>0)左栏变宽、往左拖变窄。
             以前写成 startW - d —— 方向是反的，往左拖左栏反而变宽、边界往右跑。 */
          cfg[k] = Math.min(Math.max(startW + d, COL_MIN[k]), maxW);
          cfg[k] = Math.round(cfg[k]);
          applyCols(cfg);
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
          document.body.classList.remove('rsResizing');
          try { localStorage.setItem(COL_KEY, JSON.stringify(cfg)); } catch (e) {}
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      // 双击复位
      h.addEventListener('dblclick', () => {
        try { localStorage.removeItem(COL_KEY); } catch (e) {}
        applyCols(COL_DEF);
      });
    });
  }
  /* 对话栏滚到底（发送后看最新回复），不再把整页拉回顶部 */
  function scrollThreadToEnd() {
    const el = document.getElementById('rsThread');
    if (el) el.scrollTop = el.scrollHeight;
  }
  function turnHTML(t, hist) {
    let v = {};
    v = objOf(t.verdict);
    const isChat = v.kind === 'chat';
    const isHint = v.kind === 'hint';
    const hasV = !isChat && !isHint && ((v.hit || []).length > 0);
    const hitTxt = (v.hit || []).map(k => dimName(k) || k);
    const focusLbl = v.focus ? (dimName(v.focus) || (v.focus === 'refine' ? '打磨' : '')) : '';
    const mark = isChat ? '<span class="rsTurnTag chat">问了一句</span>'
      : isHint ? '<span class="rsTurnTag hint">💡 提示</span>'
        : (v.focus ? '<span class="rsTurnTag ai">AI 关注「' + esc(focusLbl || v.focus) + '」</span>' : '');
    const hd = `<div class="rsTurnHd">${mark}
      ${hitTxt.length && hist ? '<span class="rsStepTag">你讲到：' + esc(hitTxt.join('、')) + '</span>' : ''}
      ${v.step_t ? '<span class="rsStepTag">第 ' + ((Number(v.step_idx) || 0) + 1) + ' 级 · ' + esc(v.step_t) + '</span>' : ''}
      <span class="rsTurnTime">${esc(String(t.created_at || '').slice(11, 16))}</span>
    </div>`;
    /* AI 的提问本身就是一轮（user_text 为空）→ 只画 AI 那一半，
       别留一个空的"我"气泡在那里 */
    const bubble = (t.user_text
      ? `<div class="rsSay"><span class="rsWho">我</span><div class="rsBubble">${esc(t.user_text)}</div></div>` : '')
      + `<div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody">${mdToHTML(t.ai_text)}</div></div>`;
    const cls = 'rsTurn' + (isChat ? ' chat' : (isHint ? ' hint' : (v.focus === 'refine' ? ' refine' : '')));
    /* 历史（对话存档/历史）里仍把当时的判定一并摊开；当前对话里只留 AI 说的话，
       判定那套已经在左栏的覆盖清单和掌握档位上了，不再重复一份。 */
    if (hist) return `<div class="${cls}">${hd}${bubble}${verdictHTML(v)}</div>`;
    return `<div class="${cls}">${hd}${bubble}</div>`;
  }
  /* 判定结果。
     之前把 hit / missed / wrong / 方向 一律平铺成整行，4-5 行下来 AI 的回复框
     就被压成一条瘦高的竖条。这里改成：一行摘要计数 + 只把「最该补的那一条」摊开，
     其余折叠 —— AI 说的话始终是主角，机器判定只是脚手架。 */
  function verdictHTML(v) {
    const hit = v.hit || [], missed = v.missed || [], wrong = v.wrong || [];
    if (!hit.length && !missed.length && !wrong.length && !(v.scaffold || '')) return '';
    const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
    const counts = [];
    if (hit.length) counts.push('<span class="rsChip hit">✓ 讲到 ' + hit.length + ' 点</span>');
    if (missed.length) counts.push('<span class="rsChip miss">还缺 ' + missed.length + ' 处</span>');
    if (wrong.length) counts.push('<span class="rsChip wrong">有 ' + wrong.length + ' 处说反</span>');
    // 只摊开第一条 missed —— 那正是 AI 要你补的那一个
    const firstMiss = missed.length
      ? '<div class="rsMissFirst"><b>最该补的</b>' + esc(clip(missed[0], 200)) + (missed.length > 1 ? '<span class="muted">（还有 ' + (missed.length - 1) + ' 处，看下面展开）</span>' : '') + '</div>'
      : '';
    const wrongAll = wrong.length
      ? '<div class="rsWrongList">' + wrong.map(w => '<div class="rsChip wrong">你写「' + esc(clip(w.said, 60)) + '」→ 应是「' + esc(clip(w.right, 80)) + '」</div>').join('') + '</div>'
      : '';
    const full = (hit.length || missed.length > 1)
      ? '<details class="rsFullV"><summary>看完整判定</summary>'
        + (missed.length > 1 ? '<div class="rsChips">' + missed.slice(1).map(m => '<span class="rsChip miss"><b>还缺</b>' + esc(clip(m, 160)) + '</span>').join('') + '</div>' : '')
        + (hit.length ? '<div class="rsChips">' + hit.map(h => '<span class="rsChip hit"><b>✓ 讲到了</b>' + esc(clip(h, 160)) + '</span>').join('') + '</div>' : '')
        + '</details>'
      : '';
    return `<div class="rsVerdict">
      ${counts.length ? '<div class="rsVCnt">' + counts.join('') + '</div>' : ''}
      ${firstMiss}${wrongAll}
      ${v.scaffold ? '<div class="rsScaffold"><b>💡 方向</b>（不是答案）：' + esc(clip(v.scaffold, 200)) + '</div>' : ''}
      ${full}
    </div>`;
  }

  /* 提交一句话 / 点「下一问」/ 点「卡住了」都走这里。
     force = 这次不提交内容，只要下一个问题（或换一个问题）。 */
  async function send(force, hint) {
    if (busy) return;
    const ta = document.getElementById('rsSay');
    const text = String((ta && ta.value) || '').trim();
    if (!force && !hint && !text) return toast('先写下你的理解');
    const draft = text;                 // AI 想问题的时候用户可能已经在写了，这段话要带过去
    busy = true;
    busyMsg = hint ? '💡 只给方向，不给答案…' : 'AI 正在读你说的话、挑下一个缺口…';
    draw();
    try {
      const r = await api('/api/restate-round/' + cur.round.id + '/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : (hint ? { hint: true, draft } : { text }))
      });
      if (r.turns) cur.turns = r.turns; else if (r.turn) cur.turns.push(r.turn);
      if (r.coach) cur.coach = r.coach;
      /* 提示那一轮不进 pending，pending.hint 由服务端补；这里再兜一次，
         保证"刚才那条提示"永远挂在左栏那一问下面（刷新后也一样） */
      if (hint) adoptHint();
      if (!force && !hint && ta) { try { ta.value = ''; } catch (e) {} }
    } catch (e) { toast(e.message); }
    busy = false; busyMsg = '';
    draw();
    scrollThreadToEnd();        // 只滚对话栏，不再把整页拉回顶部
  }
  /* 开局/刷新后没有 pending 时，问第一句。已有 pending 绝不覆盖（刷新不能顶掉眼前那一问） */
  function askNext(force) {
    if (busy || !cur || !cur.round) return;
    const p = (cur.coach && cur.coach.pending) || null;
    if (!force && p) return;
    send(true, false);
  }
  /* 问一句 → AI 解释 → 立刻把"轮到你用自己的话说一遍"顶到左栏。
     解释如果不能接回自己的话，就只是"又看懂了一遍"。 */
  async function ask() {
    if (busy) return;
    const ta = document.getElementById('rsSay');
    const text = String(ta.value || '').trim();
    if (!text) return toast('先写下你的问题');
    busy = true; busyMsg = 'AI 正在答你的问题…';
    draw();
    try {
      const r = await api('/api/restate-round/' + cur.round.id + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
      });
      cur.turns.push(r.turn);
      /* back 由服务端存进 coach.back，这里只把它显示出来 */
      if (r.back) { cur.coach = cur.coach || { hit: [], focus: '', pending: null }; cur.coach.back = r.back; }
      try { ta.value = ''; } catch (e) {}
    } catch (e) { toast(e.message); }
    busy = false; busyMsg = '';
    draw();
    scrollThreadToEnd();
  }
  /* 收尾分两步：① 让用户自己把这段整理成一版（真正"内化"的那一步得他自己走）
     ② AI 只润色 + 对照原文找差距。
     直接一步让 AI 整理，沉淀出来的还是书上的话 —— 这个组件就白做了。 */
  function drawDraft() {
    const c = coachState();
    const hint = c.dims.map(d => d.name).join(' · ');
    app.innerHTML = `<div class="jdPage rsPage rsDraftPage">
      ${headHTML('把它整理成你自己的话')}
      <div class="rsDraftBox">
        <div class="rsDraftT">🗣 现在轮到你写</div>
        <p class="rsDraftLead">不看左边 AI 的原话，按<b>你刚才自己说的那些</b>，把这个知识点从头到尾讲一遍：</p>
        <ul class="rsDraftReq">
          <li>先说<b>为什么要它</b>（它解决了什么麻烦）</li>
          <li>再说<b>它大致怎么做到</b>（关键机制）</li>
          <li>最后说<b>什么情况下会失效</b>（边界）</li>
        </ul>
        <p class="muted">用你的话、你的类比，写多写少都行 —— 写出来才知道哪块其实还没真懂。
          <span class="muted">（覆盖清单：${esc(hint)}）</span></p>
        <textarea id="rsDraftTa" rows="9" placeholder="例：我一直以为 base 就是个公共配置片段，后来才明白它还得配合 profiles 才不至于重复写……"></textarea>
        <div class="rsDraftBtns">
          <button class="btn primary" id="rsDraftOk">写好了，让 AI 帮我顺一遍</button>
          <button class="btn" id="rsDraftBack">← 回去接着聊</button>
        </div>
        <p class="muted" style="margin-top:8px;">AI 只会理顺顺序、补上连接，<b>不会替你重写</b> —— 你这段用词就是最终沉淀下来的样子。</p>
      </div>
    </div>`;
    const ta = document.getElementById('rsDraftTa');
    ta.value = String((cur.round && cur.round.draft) || '');
    document.getElementById('rsDraftBack').addEventListener('click', () => { view = 'talk'; draw(); });
    document.getElementById('rsDraftOk').addEventListener('click', () => doFinish(ta.value));
    setTimeout(() => ta.focus(), 40);
  }
  async function doFinish(draft) {
    if (busy) return;
    const text = String(draft || '').trim();
    if (!text && !confirm('还没写整理稿。确定直接让 AI 从你说过的那些话里整理吗？\n（自己写一遍内化效果会好很多）')) {
      return;
    }
    busy = true; busyMsg = 'AI 正在帮你顺一遍，并对照原文找差距…';
    draw();
    try {
      const r = await api('/api/restate-round/' + cur.round.id + '/finish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: text })
      });
      cur.round = r.round;
      await reload();
      view = 'done';
    } catch (e) { toast(e.message); }
    busy = false; busyMsg = '';
    draw();
  }
  async function finish() {
    if (busy) return;
    view = 'draft';
    draw();
  }

  /* ---------- 收尾对照 ---------- */
  /* AI 写要点时爱把标识符包成 ```js\\ninterview.js\\n``` 或 `interview.js`。
     服务端出口已经会剥围栏（server/plugins/lib/inline-text.js），这里再兜一道：
     先 esc 再只把成对的 `xxx` 换成 <code> —— 顺序不能反，否则等于给自己开 XSS 口子。
     库里早期存下的旧记录（服务端清洗前）也靠这道兜底。 */
  function inlineCode(v, max) {
    let t = String(v == null ? '' : v)
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*[ \t]*\r?\n?([\s\S]*?)(?:`{3,}|~{3,})/g, function (m, body) { return String(body || ''); })
      .replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*/g, '')
      .replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (max) t = t.slice(0, max);
    return esc(t).replace(/`([^`\n]{1,120})`/g, '<code>$1</code>').replace(/`/g, '');
  }
  function drawDone() {
    const r = cur.round || {};
    let gaps = [], kept = [];
    gaps = listOf(r.gaps);
    kept = listOf(r.kept);
    app.innerHTML = `<div class="jdPage rsPage">
      ${headHTML('你的版本 vs 原文')}
      ${String(r.draft || '').trim() ? `<div class="rsSec rsOwnSec">
        <div class="rsSecT">✍️ 你自己写的原版（AI 只理顺了顺序，这段才是沉淀下来的主体）</div>
        <div class="rsOwnRaw">${esc(r.draft)}</div>
      </div>` : ''}
      <div class="rsSec">
        <div class="rsSecT">${esc(r.point_title || '')}</div>
        <div class="rsMine">
          <div class="rsMineT">🗣 我的话<button class="btn tiny" id="rsCopy">复制</button></div>
          <div class="rsMineB mdBody">${mdToHTML(r.mine || '')}</div>
        </div>
        ${r.line ? `<p class="rsLine">${inlineCode(r.line, 160)}</p>` : ''}
      </div>
      ${kept.length ? `<div class="rsSec">
        <div class="rsSecT">AI 认定你真讲对了的地方（${kept.length}）</div>
        <div class="rsKept">${kept.map(k => '<div class="rsKeptI">✓ ' + inlineCode(k, 120) + '</div>').join('')}</div>
      </div>` : ''}
      <div class="rsSec">
        <div class="rsSecT">${gaps.length ? '和关键要点的差距（' + gaps.length + '）' : '要点都覆盖了 ✓'}</div>
        ${gaps.length ? `<div class="rsGaps">${gaps.map(g => `
          <div class="rsGap"><b>${inlineCode(g.key, 80)}</b><span>${inlineCode(g.why || '', 160)}</span></div>`).join('')}</div>`
          : '<p class="muted">这一轮你已经用自己的话讲全了。</p>'}
        ${gaps.length ? '<p class="hint">不用现在补。过两天回来看这条，你会认出哪些点是「以为自己懂了」。</p>' : ''}
      </div>
      <div class="toolbarRow">
        <button class="btn" id="rsWHist">🗨 看这段对话（${(cur.turns || []).length} 条）</button>
        <button class="btn primary" id="rsNextPt">下一个知识点 →</button>
        <button class="btn" id="rsAll">看我沉淀的话</button>
        <button class="btn" id="rsBackT">← 返回教程</button>
      </div>
    </div>`;
    const wh = document.getElementById('rsWHist');
    if (wh) wh.addEventListener('click', () => drawConvs(Number(r.point_idx || 0)));
    const cp = document.getElementById('rsCopy');
    if (cp) cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.mine || ''); toast('已复制'); }
      catch (e) { toast('复制失败，可手动选中'); }
    });
    document.getElementById('rsNextPt').addEventListener('click', async () => {
      const idx = points.findIndex((p, i) => !rounds.find(x => Number(x.point_idx) === i && x.mine));
      if (idx < 0) { cur = null; view = 'pick'; draw(); return; }
      try {
        const res = await api('/api/tutorials/' + tid + '/restate/round', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: idx })
        });
        cur = { round: res.round, point: res.point, turns: res.turns || [], coach: res.coach || null };
        view = 'talk'; draw();
        if (!cur.coach || !cur.coach.pending) askNext(true);
      } catch (e) { toast(e.message); }
    });
    document.getElementById('rsAll').addEventListener('click', drawNotes);
    document.getElementById('rsBackT').addEventListener('click', () => { location.hash = '#/t/' + tid; });
  }

  /* ---------- 我沉淀的话 ---------- */
  async function drawNotes() {
    app.innerHTML = '<p class="muted">加载…</p>';
    let notes = [];
    try { const r = await api('/api/tutorials/' + tid + '/restate/notes'); notes = r.notes || []; } catch (e) {}
    app.innerHTML = `<div class="jdPage rsPage">
      ${headHTML('我说过的话')}
      ${notes.length ? `<div class="rsNotes">${notes.map(n => `
        <div class="rsNote">
          <div class="rsNoteT">${esc(n.point_title || '')}<span class="muted">${esc(String(n.created_at || '').slice(0, 10))}</span></div>
          <div class="rsNoteB mdBody">${mdToHTML(n.mine)}</div>
          ${n.line ? '<p class="rsLine">' + esc(n.line) + '</p>' : ''}
        </div>`).join('')}</div>`
        : '<p class="muted">还没有沉淀。先挑一个知识点和 AI 聊几轮吧。</p>'}
      <div class="toolbarRow"><button class="btn" id="rsNB">← 返回</button></div>
    </div>`;
    document.getElementById('rsNB').addEventListener('click', () => { view = 'pick'; draw(); });
  }

  SiErXing.registerPlugin({
    id: 'restate',
    routes: [
      {
        match: h => h.match(/^#\/t\/(\d+)\/restate$/),
        render: async m => {
          const t = Number(m[1]);
          if (restateVueEnabled()) {
            try { if (await renderRestatePageVue(t)) return; }
            catch (e) { try { toast('用自己的话 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          await renderPage(t);
        }
      }
    ]
  });
})();
