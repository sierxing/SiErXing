/**
 * 思而行 · 前端插件：随堂测验（按教程逐点考察）
 * ------------------------------------------------------------------
 * 一次一题、无计时：大纲导图选题型 → 答题卡（即时反馈）→
 * 答错可追问/再来一道（用户说了算）→ 报告（掌握/薄弱/跳过 + 薄弱再练）。
 */
'use strict';
(function () {
  const { api, esc, toast, go, state, mdToHTML } = SiErXing;

  /* ---------- Vue 版页面（渐进迁移；加载失败自动回退旧页面） ---------- */
  let quizVueUnmount = null;
  function quizVueEnabled() {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q === 'legacy') return false;
      if (q === 'vue') return true;
      const saved = localStorage.getItem('sierxing-ui-quiz');
      if (saved === 'legacy') return false;
      if (saved === 'vue') return true;
    } catch (e) {}
    return false;   /* 默认原版界面（Vue 版仍在，?ui=vue 可体验）*/
  }
  function ensureQuizVueCss() {
    if (document.querySelector('link[data-ui-page="quiz"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui-dist/quiz.css'; l.setAttribute('data-ui-page', 'quiz');
    document.head.appendChild(l);
  }
  async function renderQuizPageVue(t) {
    const root = document.getElementById('app');
    if (!root) throw new Error('页面容器不存在');
    if (quizVueUnmount) { try { quizVueUnmount(); } catch (e) {} quizVueUnmount = null; }
    ensureQuizVueCss();
    const mod = await import('/ui-dist/quiz.js?v=' + Date.now());
    if (!mod || typeof mod.mountQuizPage !== 'function') throw new Error('UI 插件没有导出 mountQuizPage');
    quizVueUnmount = mod.mountQuizPage(root, { api: api, toast: toast, go: go, mdToHTML: mdToHTML, tid: Number(t) || 0 });
    return true;
  }
  window.addEventListener('hashchange', function () {
    if (quizVueUnmount && !/^#\/t\/\d+\/quiz/.test(location.hash)) {
      try { quizVueUnmount(); } catch (e) {}
      quizVueUnmount = null;
    }
  });
  const QTYPES = [
    { v: 'single', label: '单选' },
    { v: 'judge', label: '判断' },
    { v: 'text', label: '简答' },
  ];
  const QTN = { single: '单选', judge: '判断', text: '简答' };

  let tid = 0, outline = [], session = null, records = [];
  let view = 'setup';           // setup | card | report
  let curPoint = 0, curRec = null, busy = false;

  const livePoints = () => outline.map((p, i) => ({ ...p, i }))
    .filter(p => !(session && session.skip_idx && JSON.parse(session.skip_idx || '[]').includes(p.i)));
  function pointStats() {
    // 每个知识点的战绩（只看 qa 作答）
    const st = {};
    for (const r of records) {
      if (r.kind !== 'qa' || !r.user_text) continue;
      const s = st[r.point_idx] || (st[r.point_idx] = { ok: 0, bad: 0, total: 0 });
      s.total++;
      if (r.correct) s.ok++; else s.bad++;
    }
    return st;
  }
  function pointMark(pi) {
    const s = pointStats()[pi];
    if (!s) return 'todo';
    if (s.ok > 0 && s.bad === 0) return 'done';
    if (s.ok > 0) return 'fixed';
    return 'weak';
  }
  const MARK_TXT = { todo: '未练', done: '已掌握', fixed: '已补上', weak: '薄弱' };

  async function renderQuizPage(t) {
    tid = Number(t);
    app.innerHTML = '<p class="muted">加载测验…</p>';
    try {
      const o = await api('/api/tutorials/' + tid + '/quiz/outline');
      outline = o.outline || [];
    } catch (e) { outline = []; }
    try {
      const s = await api('/api/tutorials/' + tid + '/quiz/session');
      session = s.session || null;
      records = s.records || [];
    } catch (e) { session = null; records = []; }
    if (session && records.length) {
      curPoint = Math.min(session.point_idx || 0, Math.max(0, outline.length - 1));
      view = 'report';
    } else {
      view = 'setup';
    }
    draw();
  }

  function headHTML(title) {
    return `<div class="jdHead">
      <a class="back" href="#/t/${tid}">← 返回教程</a>
      <span class="mapTitle">📝 随堂测验</span>
      <span class="chip gray">${esc(title || '')}</span>
    </div>`;
  }

  function draw() {
    if (view === 'setup') drawSetup();
    else if (view === 'card') drawCard();
    else drawReport();
    window.scrollTo(0, 0);
  }

  /* ---------- 准备页：大纲导图 + 题型 + 开考 ---------- */
  function drawSetup() {
    const skips = session ? JSON.parse(session.skip_idx || '[]') : [];
    const qts = session ? JSON.parse(session.qtypes || '[]') : QTYPES.map(q => q.v);
    app.innerHTML = `<div class="jdPage quizPage">
      ${headHTML('选题型 · 勾大纲')}
      ${outline.length ? `
      <div class="quizSec">
        <div class="quizSecT">一、知识点大纲（可取消勾选跳过）</div>
        <div class="quizTree">${outline.map((p, i) => `
          <label class="quizPt">
            <input type="checkbox" data-qskip="${i}" ${skips.includes(i) ? '' : 'checked'}>
            <span class="quizPtDot">${i + 1}</span>
            <span class="quizPtBody"><b>${esc(p.title)}</b><span>${esc(p.summary || '')}</span></span>
          </label>`).join('')}</div>
      </div>` : `
      <div class="quizSec">
        <div class="quizSecT">一、知识点大纲</div>
        <p class="muted">还没提炼大纲，点下面按钮让 AI 从教程里提（约半分钟）。</p>
      </div>`}
      <div class="quizSec">
        <div class="quizSecT">二、考察题型（可多选，出题时轮换）</div>
        <div class="ppCats">${QTYPES.map(q => `<button type="button" class="ppCat${qts.includes(q.v) ? ' active' : ''}" data-qt="${q.v}">${q.label}</button>`).join('')}</div>
      </div>
      <div class="toolbarRow">
        ${!outline.length ? '<button class="btn primary" id="quizOutlineBtn">提炼大纲</button>' : ''}
        ${outline.length ? '<button class="btn primary" id="quizStartBtn">开始考察</button>' : ''}
        ${session ? '<button class="btn" id="quizResumeBtn">继续上次（' + records.filter(r => r.user_text).length + ' 题已答）</button>' : ''}
      </div>
      <p class="hint">一次只出一题，答完立刻讲；答错可以追问、再来一道，全程你说了算，没有倒计时。</p>
    </div>`;
    app.querySelectorAll('[data-qt]').forEach(b => b.addEventListener('click', () => b.classList.toggle('active')));
    const ob = document.getElementById('quizOutlineBtn');
    if (ob) ob.addEventListener('click', async () => {
      ob.disabled = true; ob.textContent = '提炼中…';
      try {
        const r = await api('/api/tutorials/' + tid + '/quiz/outline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        outline = r.outline || [];
        toast('大纲已提炼（' + outline.length + ' 个知识点）');
      } catch (e) { toast(e.message); }
      draw();
    });
    const st = document.getElementById('quizStartBtn');
    if (st) st.addEventListener('click', async () => {
      const qts2 = Array.from(app.querySelectorAll('[data-qt].active')).map(x => x.getAttribute('data-qt'));
      if (!qts2.length) return toast('至少选一种题型');
      const skip = Array.from(app.querySelectorAll('[data-qskip]')).map((x, i) => x.checked ? -1 : i).filter(x => x >= 0);
      if (skip.length >= outline.length) return toast('全跳过就没得考了，至少留一个');
      st.disabled = true;
      try {
        const r = await api('/api/tutorials/' + tid + '/quiz/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qtypes: qts2, skip }) });
        session = r.session; records = [];
        curPoint = firstLive(0);
        view = 'card'; curRec = null;
        draw();
      } catch (e) { toast(e.message); st.disabled = false; }
    });
    const rs = document.getElementById('quizResumeBtn');
    if (rs) rs.addEventListener('click', () => { curPoint = Math.min(session.point_idx || 0, outline.length - 1); view = 'card'; curRec = null; draw(); });
  }
  function firstLive(from) {
    const skip = session ? JSON.parse(session.skip_idx || '[]') : [];
    for (let i = from; i < outline.length; i++) if (!skip.includes(i)) return i;
    for (let i = 0; i < from; i++) if (!skip.includes(i)) return i;
    return 0;
  }
  function stepPoint(dir) {
    const skip = session ? JSON.parse(session.skip_idx || '[]') : [];
    let i = curPoint;
    for (let k = 0; k < outline.length; k++) {
      i = (i + dir + outline.length) % outline.length;
      if (!skip.includes(i)) { curPoint = i; return true; }
    }
    return false;
  }

  /* ---------- 答题卡：一次一题 ---------- */
  function drawCard() {
    const pts = livePoints();
    if (!pts.length) { view = 'setup'; draw(); return; }
    if (curPoint >= outline.length) curPoint = 0;
    const p = outline[curPoint];
    const mk = pointMark(curPoint);
    const dots = pts.map(q => `<span class="quizDot ${q.i === curPoint ? 'cur' : ''} ${pointMark(q.i) === 'done' ? 'ok' : pointMark(q.i) === 'weak' ? 'bad' : pointMark(q.i) === 'fixed' ? 'fix' : ''}" data-qdot="${q.i}" title="${esc(q.title)}（${MARK_TXT[pointMark(q.i)]}）"></span>`).join('');
    app.innerHTML = `<div class="jdPage quizPage">
      ${headHTML('')}
      <div class="quizDots">${dots}</div>
      <div class="quizCard">
        <div class="quizCardTop"><span class="chip">${esc(QTN[curRec ? curRec.qtype : ''] || '出题中')}</span>
          <span class="quizPtName">知识点 ${curPoint + 1}/${outline.length}：${esc(p.title)}</span>
          <span class="chip ${mk === 'done' ? 'ok' : mk === 'weak' ? 'danger' : ''}">${MARK_TXT[mk]}</span></div>
        <div class="quizQBody" id="quizQBody"><p class="muted">正在出题…</p></div>
        <div id="quizQOps"></div>
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn" id="quizPrev">← 上一个点</button>
        <button class="btn" id="quizNext">下一个点 →</button>
        <div class="spacer"></div>
        <button class="btn" id="quizToReport">看报告</button>
        <button class="btn danger" id="quizFinish">结束本轮</button>
      </div>
      <p class="quizAskHint">💬 这个点有疑问？点右下角 <b>AI 助手</b> 直接问 —— 它读得到这一页的题目、选项和你的作答，不用再把题目贴一遍。</p>
    </div>`;
    app.querySelectorAll('[data-qdot]').forEach(d => d.addEventListener('click', () => { curPoint = Number(d.getAttribute('data-qdot')); curRec = null; savePoint(); draw(); }));
    document.getElementById('quizPrev').addEventListener('click', () => { if (stepPoint(-1)) { curRec = null; savePoint(); draw(); } });
    document.getElementById('quizNext').addEventListener('click', () => { if (stepPoint(1)) { curRec = null; savePoint(); draw(); } });
    document.getElementById('quizToReport').addEventListener('click', () => { view = 'report'; draw(); });
    document.getElementById('quizFinish').addEventListener('click', async () => {
      if (!confirm('结束本轮考察，去看报告？（答题记录保留，可随时再开一轮）')) return;
      try { await api('/api/quiz-session/' + session.id + '/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
      view = 'report'; draw();
    });
    /* ⚠️ 这里原来有一个「对这个点有疑问？直接问 AI」的输入框 + `POST /api/quiz-session/:id/chat`。
       已删除：每个组件各写一套 AI 问答，效果一定参差不齐（同一件事要维护一百份提示词）。
       现在统一用**已有的 AI 助手**（常驻每个页面、能读到当前页面内容）——
       用户点右下角 💬 直接问，助手看得到这一页的题目/选项/作答。 */
    if (!curRec) askQuestion(curPoint);
    else paintRecord(curRec);
  }
  async function savePoint() {
    try {
      const r = await api('/api/quiz-session/' + session.id + '/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: curPoint }) });
      session = r.session;
    } catch (e) {}
  }
  async function askQuestion(pi, qtype) {
    const body = document.getElementById('quizQBody');
    const ops = document.getElementById('quizQOps');
    if (body) body.innerHTML = '<p class="muted"><span class="spinner"></span> 正在出题…</p>';
    if (ops) ops.innerHTML = '';
    try {
      const r = await api('/api/quiz-session/' + session.id + '/question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: pi, qtype: qtype || undefined }) });
      curRec = r.record;
      paintRecord(curRec);
    } catch (e) {
      if (body) body.innerHTML = '<p class="muted">出题失败：' + esc(e.message) + '</p>';
      if (ops) ops.innerHTML = '<button class="btn small" id="quizRetry">重试</button>';
      const rt = document.getElementById('quizRetry');
      if (rt) rt.addEventListener('click', () => askQuestion(pi, qtype));
    }
  }
  function paintRecord(r) {
    const body = document.getElementById('quizQBody');
    const ops = document.getElementById('quizQOps');
    if (!body || !ops) return;
    const p = outline[r.point_idx] || { title: r.point };
    let h = `<div class="quizQ mdBody">${mdToHTML(r.question)}</div>`;
    if (r.qtype === 'single') {
      const opts = JSON.parse(r.options || '[]');
      h += `<div class="quizOpts">${opts.map(o => {
        let cls = '';
        if (r.user_text) {
          if (o.v === r.answer) cls = ' right';
          else if (o.v === r.user_text) cls = ' wrong';
        }
        return `<button class="quizOpt${cls}" data-opt="${esc(o.v)}" ${r.user_text ? 'disabled' : ''}><b>${esc(o.v)}</b> ${esc(o.label)}</button>`;
      }).join('')}</div>`;
    } else if (r.qtype === 'judge') {
      h += `<div class="quizOpts">${['对', '错'].map(v => {
        let cls = '';
        if (r.user_text) {
          if (v === r.answer) cls = ' right';
          else if (v === r.user_text) cls = ' wrong';
        }
        return `<button class="quizOpt${cls}" data-opt="${v}" ${r.user_text ? 'disabled' : ''}>${v}</button>`;
      }).join('')}</div>`;
    } else {
      h += r.user_text
        ? `<div class="quizMine">你的作答：${esc(r.user_text)}</div>`
        : `<textarea id="quizTextIn" rows="3" placeholder="写下你的理解，一两句话就行…"></textarea>`;
    }
    body.innerHTML = h;
    if (r.user_text) {
      // 已作答：反馈 + 用户说了算的下一步
      const tries = records.filter(x => x.kind === 'qa' && x.point_idx === r.point_idx && x.user_text).length;
      ops.innerHTML = `<div class="quizFb mdBody ${r.correct ? 'ok' : 'bad'}">${r.correct ? '✓ 答对了' : '✗ 还差一点'}${r.explain ? '<br>' + mdToHTML(r.explain) : ''}</div>
        <div class="toolbarRow" style="margin-top:10px;">
          ${r.correct
            ? `<button class="btn primary" id="quizGoNext">✅ 掌握了，下一个</button><button class="btn" id="quizMore">🔁 再来一道</button>`
            : `<button class="btn primary" id="quizMore">🔁 再来一道（同知识点）</button><button class="btn" id="quizGoNext">下一个知识点 →</button>`}
        </div>
        ${!r.correct && tries >= 3 ? '<p class="hint">已经练了 ' + tries + ' 道啦，要不要先回教程重看这一节？继续练也可以，听你的。</p>' : ''}`;
      const nx = document.getElementById('quizGoNext');
      if (nx) nx.addEventListener('click', () => { if (stepPoint(1)) { curRec = null; savePoint(); draw(); } else { view = 'report'; draw(); } });
      const mr = document.getElementById('quizMore');
      if (mr) mr.addEventListener('click', () => { curRec = null; askQuestion(r.point_idx); });
    } else {
      ops.innerHTML = `<div class="toolbarRow" style="margin-top:10px;"><button class="btn primary" id="quizSub">提交答案</button></div>`;
      body.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => submitAnswer(r.id, b.getAttribute('data-opt'))));
      const sb = document.getElementById('quizSub');
      if (sb) sb.addEventListener('click', () => {
        const ta = document.getElementById('quizTextIn');
        submitAnswer(r.id, ta ? ta.value.trim() : '');
      });
    }
  }
  async function submitAnswer(rid, text) {
    if (!text) return toast('先写下你的答案');
    if (busy) return;
    busy = true;
    try {
      const isText = curRec && curRec.qtype === 'text';
      const r = await api('/api/quiz-records/' + rid + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isText ? { text } : { choice: text }) });
      const i = records.findIndex(x => x.id === rid);
      if (i < 0) records.push(r.record); else records[i] = r.record;
      curRec = r.record;
      draw();
    } catch (e) { toast(e.message); } finally { busy = false; }
  }

  /* ---------- 报告 ---------- */
  function drawReport() {
    const pts = livePoints();
    const rows = pts.map(p => {
      const mk = pointMark(p.i);
      const n = records.filter(r => r.kind === 'qa' && r.point_idx === p.i && r.user_text).length;
      return { ...p, mk, n };
    });
    const done = rows.filter(r => r.mk === 'done' || r.mk === 'fixed').length;
    app.innerHTML = `<div class="jdPage quizPage">
      ${headHTML('本轮报告')}
      <div class="quizScore">掌握 ${done}/${rows.length} 个知识点${rows.length ? `（${Math.round(done / rows.length * 100)}%）` : ''}</div>
      <div class="quizRepList">${rows.map(r => `
        <div class="quizRepRow ${r.mk}">
          <span class="quizDot ${r.mk === 'done' ? 'ok' : r.mk === 'weak' ? 'bad' : r.mk === 'fixed' ? 'fix' : ''}"></span>
          <span class="quizRepName">${esc(r.title)}<span class="muted">（练过 ${r.n} 道）</span></span>
          <span class="chip ${r.mk === 'done' || r.mk === 'fixed' ? 'ok' : r.mk === 'weak' ? 'danger' : ''}">${MARK_TXT[r.mk]}</span>
          <button class="btn tiny" data-retry-pt="${r.i}">练这个点</button>
        </div>`).join('')}</div>
      <div class="toolbarRow" style="margin-top:14px;">
        <button class="btn" id="quizBackSetup">← 回大纲重选</button>
        ${rows.some(r => r.mk === 'weak') ? '<button class="btn primary" id="quizWeakRound">薄弱点再练一轮</button>' : ''}
        <div class="spacer"></div>
        <a class="btn" href="#/t/${tid}">回教程重看</a>
      </div>
    </div>`;
    app.querySelectorAll('[data-retry-pt]').forEach(b => b.addEventListener('click', () => {
      curPoint = Number(b.getAttribute('data-retry-pt')); curRec = null; view = 'card'; savePoint(); draw();
    }));
    document.getElementById('quizBackSetup').addEventListener('click', () => { view = 'setup'; draw(); });
    const wr = document.getElementById('quizWeakRound');
    if (wr) wr.addEventListener('click', async () => {
      try {
        const r = await api('/api/tutorials/' + tid + '/quiz/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          qtypes: JSON.parse(session.qtypes || '[]'),
          skip: outline.map((p, i) => i).filter(i => pointMark(i) !== 'weak')
        }) });
        session = r.session; records = [];
        curPoint = firstLive(0); curRec = null; view = 'card';
        draw();
      } catch (e) { toast(e.message); }
    });
  }

  SiErXing.registerPlugin({
    id: 'quiz',
    routes: [
      {
        match: h => h.match(/^#\/t\/(\d+)\/quiz$/),
        render: async m => {
          const t = Number(m[1]);
          if (quizVueEnabled()) {
            try { if (await renderQuizPageVue(t)) return; }
            catch (e) { try { toast('随堂测验 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          await renderQuizPage(t);
        }
      }
    ]
  });
})();
