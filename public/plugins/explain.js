'use strict';
/**
 * 思而行 · 前端组件：看懂代码（左边代码，右边讲解）
 * ------------------------------------------------------------------
 * 界面只服务一件事：**哪一行没看懂，就点哪一行**。
 *   · 左边：整段代码，每行可点。讲过的行有标记（✓ 色条）、有追问的行带个小圆点；
 *   · 右边：**当前这一行**的讲解 / 追问记录 —— 不是一长串从头到尾的对话；
 *   · 顶部：进度（已讲 N/M 行）+「继续讲」（停下 / 中断之后接着讲）。
 * 讲解由服务端在后台逐段生成：这一页只负责轮询进度、把新讲完的一段画出来；
 * 用户停在队尾时自动跟着往下走，他一旦点了别的行就不再打断他（follow=false）。
 */
(function () {
  const { api, esc, toast, mdToHTML, fmtDate, state } = SiErXing;
  const API = '/api/explain/sessions';

  /* ---------- Vue 版第一段（列表 + 准备页；运行界面仍由旧版接管） ---------- */
  let explainVueUnmount = null;
  function explainVueEnabled() {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q === 'legacy') return false;
      if (q === 'vue') return true;
      const saved = localStorage.getItem('sierxing-ui-explain');
      if (saved === 'legacy') return false;
      if (saved === 'vue') return true;
    } catch (e) {}
    return false;   /* 默认原版界面（Vue 版仍在，?ui=vue 可体验）*/
  }
  function ensureExplainVueCss() {
    if (document.querySelector('link[data-ui-page="explain"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui-dist/explain.css'; l.setAttribute('data-ui-page', 'explain');
    document.head.appendChild(l);
  }
  async function renderExplainPageVue(tid0, gid0) {
    const root = document.getElementById('app');
    if (!root) throw new Error('页面容器不存在');
    if (explainVueUnmount) { try { explainVueUnmount(); } catch (e) {} explainVueUnmount = null; }
    ensureExplainVueCss();
    const mod = await import('/ui-dist/explain.js?v=' + Date.now());
    if (!mod || typeof mod.mountExplainPage !== 'function') throw new Error('UI 插件没有导出 mountExplainPage');
    explainVueUnmount = mod.mountExplainPage(root, { api: api, toast: toast, fmtDate: fmtDate, mdToHTML: mdToHTML, tutorialId: Number(tid0) || 0, goalId: Number(gid0) || 0 });
    return true;
  }
  function takeExplainHandoff() {
    try { const v = Number(sessionStorage.getItem('sierxing-explain-open') || 0); if (v) sessionStorage.removeItem('sierxing-explain-open'); return v; } catch (e) { return 0; }
  }
  window.addEventListener('hashchange', function () {
    if (explainVueUnmount && !/^#\/(t|g)\/\d+\/explain/.test(location.hash)) {
      try { explainVueUnmount(); } catch (e) {}
      explainVueUnmount = null;
    }
  });
  /* 语法高亮复用宿主那套（hlCode 返回带 <span class="tk-xx"> 的 HTML；配色跟主题走）。
     拿不到就退回纯转义 —— 老版本 app.js 也不至于白屏。 */
  const hl = (code, lang) => {
    try { if (typeof SiErXing.hlCode === 'function') return SiErXing.hlCode(code, lang); } catch (e) {}
    return esc(String(code == null ? '' : code));
  };
  const hlLangOf = (code, lang) => {
    const key = String(lang || '').trim();
    if (key) return key;
    try { return typeof SiErXing.hlGuessLang === 'function' ? (SiErXing.hlGuessLang(code) || '') : ''; } catch (e) { return ''; }
  };
  /** 把整段高亮 HTML 按行切开，顺手把跨行的 <span> 在行尾闭合、下一行行首重开
      （多行字符串 / 块注释就是这么跨行的，直接 split('\n') 会让颜色漏到后面几行）。 */
  function splitHL(html) {
    const out = [];
    const s = String(html || '');
    let cur = '', open = [], i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        out.push(cur + open.map(() => '</span>').join(''));
        cur = open.map(t => '<span class="' + t + '">').join('');
        i++; continue;
      }
      if (c === '<' && s.startsWith('<span class="', i)) {
        const end = s.indexOf('>', i);
        const cls = s.slice(i + 13, end - 1);
        open.push(cls); cur += s.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === '<' && s.startsWith('</span>', i)) {
        open.pop(); cur += '</span>'; i += 7; continue;
      }
      cur += c; i++;
    }
    out.push(cur);
    return out;
  }
  /** 整段代码 → 每行的高亮 HTML */
  function highlightLines(code, lang) {
    const lines = String(code == null ? '' : code).split('\n');
    const key = hlLangOf(code, lang);
    if (!key) return lines.map(x => esc(x));
    try { return splitHL(hl(code, key)); } catch (e) { return lines.map(x => esc(x)); }
  }

  let gid = 0, tid = 0;
  let view = 'list';                   // list | setup | run
  let sessions = [], session = null, turns = [], tut = null;
  let selLine = 0;                     // 0 = 概览
  let selPre = '';                     // 当前点开的前置知识 id（非空 = 右边在看这个知识点）
  let follow = true;                   // 停在队尾时跟着新讲完的段落走
  let busy = false, busyMsg = '', busyT0 = 0, busyTimer = null;
  let askDraft = '';
  let poll = null;
  let tutBlocks = null;                // 从教程进来时：教程里的代码块
  let pendingOpenSid = 0;              // 教程里点「添加到看懂代码」后要直接打开的那条

  /* ---------- 通用 ---------- */
  function head(title, chip) {
    const back = tid ? `<a class="back" href="#/t/${tid}">← 返回教程</a>` : `<a class="back" href="#/g/${gid}">← 返回目标</a>`;
    return `<div class="jdHead">${back}<span class="mapTitle">${esc(title)}</span>${chip ? `<span class="chip gray">${esc(chip)}</span>` : ''}</div>`;
  }
  function stopBusy() {
    busy = false; busyMsg = '';
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
  }
  function busyText() {
    const sec = Math.max(1, Math.round((Date.now() - busyT0) / 1000));
    return busyMsg + '（已等 ' + sec + ' 秒）';
  }
  function isComment(s) { return /^\s*(?:\/\/|#|--|\*|\/\*|<!--|REM\b)/.test(String(s || '')); }
  function stopPoll() { if (poll) { clearTimeout(poll); poll = null; } }
  function startPoll() {
    stopPoll();
    const tick = async () => {
      poll = null;
      if (view !== 'run' || !session) return;
      if (!document.getElementById('exCode')) { stopPoll(); return; }   // 已经翻到别的页面了
      try {
        const r = await api(API + '/' + session.id);
        applyDetail(r);
      } catch (e) { /* 网络抖动：下一轮再试 */ }
      if (view === 'run' && session && session.status === 'working' && !poll) poll = setTimeout(tick, 2600);
    };
    poll = setTimeout(tick, 2600);
  }

  /* ---------- 页面入口 ---------- */
  async function renderExplainPage(tutorialId) {
    tid = Number(tutorialId || 0); gid = 0;
    /* 教程里点了「添加到看懂代码」：直接打开那条（AI 已经在讲了，不用再点一次开始） */
    if (pendingOpenSid) { const sid = pendingOpenSid; pendingOpenSid = 0; return openSession(sid); }
    const hoT = takeExplainHandoff(); if (hoT) return openSession(hoT);
    app.innerHTML = '<p class="muted">加载…</p>';
    try {
      const r = await api('/api/tutorials/' + tid);
      if (r.goal) gid = Number(r.goal.id || 0);
      tut = r.tutorial || null;
    } catch (e) {}
    await loadList();
    const live = sessions.find(s => s.status === 'working');
    view = live ? 'run' : (sessions.length ? 'list' : 'setup');
    if (view === 'run') return openSession(live.id);
    draw();
  }
  async function renderGoalExplainPage(goalId) {
    gid = Number(goalId || 0); tid = 0;
    const hoG = takeExplainHandoff(); if (hoG) return openSession(hoG);
    app.innerHTML = '<p class="muted">加载…</p>';
    await loadList();
    const live = sessions.find(s => s.status === 'working');
    view = live ? 'run' : (sessions.length ? 'list' : 'setup');
    if (view === 'run') return openSession(live.id);
    draw();
  }
  /* 讲解记录是**按教程 / 任务节点隔离**的（用户要求）：
     从某份教程进来就只看得到这份教程的代码讲解记录 —— 切教程不会看到别的教程攒下的东西；
     从目标页进来才看整个目标的（那时按任务节点分组显示，免得几百条摞成一坨）。 */
  async function loadList() {
    const q = tid ? ('?tutorial_id=' + tid) : ('?goal_id=' + gid);
    try { const r = await api(API + q); sessions = r.sessions || []; } catch (e) { sessions = []; }
  }
  function groupSessions() {
    const map = new Map();
    for (const s of sessions) {
      const key = s.tutorial_id ? ('t' + s.tutorial_id) : (s.node_id ? ('n' + s.node_id) : 'x');
      if (!map.has(key)) map.set(key, { key, title: s.tut_title || s.node_title || '（没挂任务节点的代码）', list: [] });
      map.get(key).list.push(s);
    }
    return Array.from(map.values());
  }
  let groupOpen = {};
  function draw() {
    stopPoll();
    if (view === 'setup') return drawSetup();
    if (view === 'run') return drawRun();
    return drawList();
  }

  /* ---------- 一、贴代码 ---------- */
  async function drawSetup() {
    await loadStyle();
    app.innerHTML = `<div class="jdPage exPage">
      ${head('🔍 看懂代码')}
      <div class="exIntro">
        <p>把你看不太懂的代码整段贴进来：AI 会把它<b>逐行讲明白</b> —— <b>左边是代码，右边是讲解</b>，点哪一行就看哪一行。<br>
        哪一行没看懂，就在那一行下面接着问，它只讲这一行的事。<br>
        开讲前它会先跟你确认<b>前置知识</b>：不知道的，先带你过一遍再逐行讲。</p>
      </div>
      <div class="exSec">
        <div class="exSecT">1. 要讲哪段代码</div>
        <textarea class="exInput exCodeIn" id="exCode" spellcheck="false" placeholder="把代码整段粘进来（Ctrl+V）——从教程里复制的、报错时贴的那种都行"></textarea>
        <div class="exHint" id="exCount">0 行 · 一次最多 400 行（长得像一整本书的就分两次贴）</div>
      </div>
      <div class="exSec" id="exTutSec" hidden>
        <div class="exSecT">…或者直接从这篇教程里挑一段<span class="exSecTip">编号 = 教程里代码块右上角的 #N</span></div>
        <select class="exInput" id="exTutPick"><option value="-1">（不选，自己在上面贴）</option></select>
      </div>
      <div class="exSec">
        <div class="exSecT">2. 一句说明（可选，能帮它讲得更准）</div>
        <input class="exInput" id="exNote" placeholder="例：mcp-min-server.js 的主循环；或者：这个函数我完全看不懂">
      </div>
      <div class="exSec" id="exStyleSec">
        <div class="exSecT">3. 讲解风格<span class="exSecTip">可留空。贴/上传一段你喜欢的讲解，以后每段讲解都照它的语气、详略、排版写</span></div>
        ${styleEditorHTML({})}
      </div>
      <div class="exStart">
        <button class="btn primary" id="exGo">开始讲解</button>
        ${sessions.length ? `<button class="btn" id="exToList">之前的讲解（${sessions.length}）</button>` : ''}
        <span class="exHint" id="exCalls"></span>
      </div>
    </div>`;

    const ta = document.getElementById('exCode');
    /* 风格示例编辑器（贴文本 / 上传文件 → 保存；保存后之后的讲解都照它写） */
    bindStyleEditor(document.getElementById('exStyleSec'), {});
    const count = document.getElementById('exCount');
    const calls = document.getElementById('exCalls');
    const updateCount = () => {
      const n = String(ta.value || '').replace(/\s+$/, '').split('\n').filter((x, i, a) => !(a.length === 1 && !x)).length;
      count.textContent = n + ' 行 · 一次最多 400 行';
      calls.textContent = n ? ('大约 ' + Math.max(1, Math.ceil(n / 30)) + ' 次 AI 调用，' + Math.max(1, Math.ceil(n / 30)) * 40 + ' 秒上下讲完') : '';
    };
    ta.addEventListener('input', updateCount);
    updateCount();

    const toList = document.getElementById('exToList');
    if (toList) toList.addEventListener('click', async () => { await loadList(); view = 'list'; draw(); });

    document.getElementById('exGo').addEventListener('click', async () => {
      const code = String(ta.value || '').replace(/\s+$/, '');
      if (!code.trim()) return toast('先把要讲的代码贴进来');
      const note = String((document.getElementById('exNote') || {}).value || '').trim();
      const btn = document.getElementById('exGo');
      btn.disabled = true; btn.textContent = '正在安排讲解…';
      try {
        const r = await api(API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal_id: gid, tutorial_id: tid || 0, code, note })
        });
        session = r.session; turns = [];
        view = 'run'; selLine = 1; follow = true;
        drawRun();
        startPoll();
      } catch (e) {
        toast('开始失败：' + e.message);
        btn.disabled = false; btn.textContent = '开始讲解';
      }
    });

    /* 从教程进来：把教程里的代码块列出来，点一下就能填进来 */
    if (tid) {
      const blocks = await loadTutBlocks();
      const sec = document.getElementById('exTutSec');
      const pick = document.getElementById('exTutPick');
      if (sec && pick && blocks.length) {
        sec.hidden = false;
        pick.innerHTML = '<option value="-1">（不选，自己在上面贴）</option>' + blocks.map((b, i) => {
          const first = String(b.code || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
          return `<option value="${i}">#${i + 1} · ${esc(b.lang || '代码')} · ${esc(first.slice(0, 42))} …（${b.code.split('\n').length} 行）</option>`;
        }).join('');
        pick.addEventListener('change', () => {
          const i = Number(pick.value);
          if (i < 0 || !blocks[i]) return;
          ta.value = blocks[i].code;
          document.getElementById('exNote').value = (tut && tut.title ? String(tut.title).slice(0, 60) + ' · 代码块 #' + (i + 1) : '');
          updateCount();
        });
      }
    }
  }
  async function loadTutBlocks() {
    if (tutBlocks) return tutBlocks;
    const info = await tutInfo(tid);
    tutBlocks = info ? info.blocks : [];
    if (info) tut = { id: info.id, title: info.title, goal_id: info.goal_id };
    return tutBlocks;
  }

  /* ---------- 二、讲解记录（列表） ---------- */
  function statusOf(s) {
    if (s.status === 'prereq') return { ico: '🧩', txt: '先确认前置知识' };
    if (s.status === 'done') return { ico: '✅', txt: '已讲完' };
    if (s.status === 'working') return { ico: '⏳', txt: '正在讲…' };
    if (Number(s.explained) > 0) return { ico: '⏸', txt: '停在第 ' + (Number(s.explained) + 1) + ' 行，可继续' };
    return { ico: '📄', txt: '还没开讲' };
  }
  function sessionItemHTML(s) {
    const st = statusOf(s);
    return `<div class="exItemWrap">
        <button class="exItem" data-sid="${s.id}">
          <span class="exItemIco">${st.ico}</span>
          <span class="exItemBody">
            <b>${esc(s.title || '一段代码')}</b>
            <span class="exItemMeta">${st.txt} · ${Number(s.modules_n) ? '已讲 ' + Number(s.modules_done || 0) + '/' + Number(s.modules_n) + ' 个模块' : '已讲 ' + Number(s.explained) + '/' + Number(s.lines) + ' 行'}${Number(s.asks || s.asked) ? ' · ' + (s.asks || s.asked) + ' 条追问' : ''} · ${esc(fmtDate(s.updated_at))}</span>
            ${s.note ? `<span class="exItemNote">${esc(String(s.note).slice(0, 70))}</span>` : ''}
          </span>
        </button>
        <button class="btn tiny" data-ren="${s.id}" title="改个名字">✎ 改名</button>
        <button class="btn tiny danger" data-del="${s.id}" title="删掉这条讲解">🗑</button>
      </div>`;
  }
  function drawList() {
    const inTut = !!tid;
    const groups = groupSessions();
    if (groups.length === 1 && groupOpen[groups[0].key] == null) groupOpen[groups[0].key] = true;   // 只有一组就不用再点一下
    app.innerHTML = `<div class="jdPage exPage">
      ${head('🔍 看懂代码 · 讲解记录')}
      <div class="exIntro">
        ${inTut
          ? `<p>这里只显示<b>这一份教程</b>的代码讲解记录${tut && tut.title ? '（《' + esc(String(tut.title).slice(0, 30)) + '》）' : ''} —— 点开哪一行就看哪一行，追问也记在那一行下面。</p>`
          : `<p>这是<b>整个目标</b>的讲解记录，按任务节点分组（点标题展开）。想只看某份教程的，就从教程页里进「看懂代码」。</p>`}
      </div>
      <div class="exStart">
        <button class="btn primary" id="exNew">＋ 贴一段新代码</button>
        <span class="exHint">共 ${sessions.length} 条记录${groups.length > 1 ? ' · ' + groups.length + ' 个节点' : ''}</span>
      </div>
      ${sessions.length ? (inTut
        ? `<div class="exList">${sessions.map(sessionItemHTML).join('')}</div>`
        : groups.map(g => `<div class="exGroup">
            <button class="exGroupHead" data-g="${esc(g.key)}">${groupOpen[g.key] ? '▾' : '▸'} 📚 ${esc(String(g.title).slice(0, 46))}<span class="exGroupN">${g.list.length} 条</span></button>
            ${groupOpen[g.key] ? `<div class="exList">${g.list.map(sessionItemHTML).join('')}</div>` : ''}
          </div>`).join(''))
        : '<p class="muted">还没有记录。点上面的按钮贴一段代码，AI 会逐行讲明白。</p>'}
    </div>`;
    const nb = document.getElementById('exNew');
    if (nb) nb.addEventListener('click', () => { view = 'setup'; draw(); });
    app.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-g');
      groupOpen[k] = !groupOpen[k];
      drawList();
    }));
    app.querySelectorAll('[data-sid]').forEach(b => b.addEventListener('click', () => openSession(Number(b.getAttribute('data-sid')))));
    app.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      const s = sessions.find(x => Number(x.id) === Number(b.getAttribute('data-ren')));
      if (s) await renameSession(s);
    }));
    app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      const id = Number(b.getAttribute('data-del'));
      if (!confirm('删掉这条讲解（含所有讲解与追问）？')) return;
      try { await api(API + '/' + id, { method: 'DELETE' }); } catch (e) { return toast(e.message); }
      sessions = sessions.filter(x => Number(x.id) !== id);
      toast('已删除'); drawList();
    }));
  }
  async function renameSession(s) {
    const cur = String((s && (s.title || '')) || '');
    const v = prompt('这段代码叫什么？（AI 起的名字，随时可改）', cur);
    if (v == null) return;
    const title = String(v).trim();
    if (!title || title === cur) return;
    try {
      const r = await api(API + '/' + s.id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      if (session && Number(session.id) === Number(s.id)) session = r.session;
      const i = sessions.findIndex(x => Number(x.id) === Number(s.id));
      if (i >= 0) sessions[i] = Object.assign({}, sessions[i], { title, renamed: 1 });
      toast('已改名');
      if (view === 'list') drawList(); else updateBar();
    } catch (e) { toast('改名失败：' + e.message); }
  }

  /* ---------- 三、讲解主界面 ---------- */
  async function openSession(sid) {
    stopPoll();
    app.innerHTML = '<p class="muted">加载这次讲解…</p>';
    try {
      await loadStyle();
      const r = await api(API + '/' + sid);
      if (r.style) style = Object.assign({}, style, { loaded: true, custom: !!r.style.custom, len: Number(r.style.len || 0) });
      session = r.session; turns = r.turns || []; tut = r.tutorial || null;
      gid = session.goal_id; tid = session.tutorial_id || tid;
      view = 'run'; follow = true;
      const ex = Number(session.explained || 0);
      selLine = hasOverview() ? (ex > 0 ? ex : 0) : Math.max(1, ex || 1);
      drawRun();
      if (session.status === 'working') startPoll();
    } catch (e) { toast('打开失败：' + e.message); view = 'list'; draw(); }
  }
  function hasOverview() { return turns.some(t => t.kind === 'overview'); }
  /** 已经讲完的模块数（并行讲解时中间可能有洞，所以按模块逐行核对，不看 explained） */
  function modsDone() {
    const mods = session.modules || [];
    if (!mods.length) return 0;
    const cov = new Set();
    for (const t of turns) if (t.role === 'ai' && t.kind === 'explain') for (let i = Number(t.line_from); i <= Number(t.line_to); i++) cov.add(i);
    let n = 0;
    for (const m of mods) {
      let ok = true;
      for (let i = m.from; i <= m.to; i++) if (!cov.has(i)) { ok = false; break; }
      if (ok) n++;
    }
    return n;
  }
  function coverOf(line) {
    return turns.find(t => t.role === 'ai' && t.kind === 'explain' && Number(t.line_from) <= line && line <= Number(t.line_to)) || null;
  }
  function threadOf(line) {
    if (line === 0) return turns.filter(t => t.kind === 'overview');
    return turns.filter(t => t.kind !== 'overview' && Number(t.line_from) <= line && line <= Number(t.line_to));
  }
  function codeHTML(lines) {
    let h = '';
    if (hasOverview()) h += `<div class="exLine exOv" data-line="0"><i class="exNo">📄</i><span class="exSrc">概览 · 这段代码整体在做什么</span></div>`;
    const modStarts = new Set((session.modules || []).map(m => Number(m.from)).filter(n => n > 1));
    const hlLines = highlightLines(lines.join('\n'), session.lang);
    for (let i = 0; i < lines.length; i++) {
      const n = i + 1;
      const body = hlLines[i] != null ? hlLines[i] : esc(lines[i]);
      h += `<div class="exLine${isComment(lines[i]) ? ' exCmt' : ''}${modStarts.has(n) ? ' exModStart' : ''}" data-line="${n}"><i class="exNo">${n}</i><span class="exSrc">${body}</span></div>`;
    }
    return h;
  }
  /* 「概览」是 AI 讲第一段时才产出的：新建会话那一刻它还不存在，左边画的是"还没概览"的版本。
     轮询拿到后必须补上这一行 —— 否则整个会话都没法点开概览（真实踩到过）。 */
  function ensureOverviewRow() {
    const box = document.getElementById('exCode');
    if (!box || !hasOverview() || box.querySelector('.exLine.exOv')) return;
    const div = document.createElement('div');
    div.className = 'exLine exOv';
    div.setAttribute('data-line', '0');
    div.innerHTML = '<i class="exNo">📄</i><span class="exSrc">概览 · 这段代码整体在做什么</span>';
    box.insertBefore(div, box.firstChild);
  }
  function drawRun() {
    const lines = String(session.code || '').split('\n');
    const total = Number(session.lines || lines.length);
    app.innerHTML = `<div class="jdPage exPage">
      ${head('🔍 ' + (session.title || '看懂代码'), statusOf(session).txt)}
      <div class="exBar">
        <div class="exProg"><i id="exProgBar"></i></div>
        <span class="exProgTxt" id="exProgTxt"></span>
        <span class="exStat" id="exStat"></span>
        <span class="spacer"></span>
        <button class="btn small primary" id="exContinue" hidden>▶ 继续讲</button>
        <button class="btn small" id="exStyleBtn" title="贴/上传一段你喜欢的讲解，以后的讲解都照它的风格写">${styleBtnText()}</button>
        <button class="btn small" id="exRen" title="改个名字">✎ 改名</button>
        <button class="btn small" id="exBack" title="回到讲解记录列表">☰ 讲解记录</button>
        <button class="btn small danger" id="exDel">删除</button>
      </div>
      <div class="exWrap">
        <aside class="exSide">
          <div class="exSideHead">
            <span class="chip gray">${esc(session.lang || '代码')}</span>
            <span class="exSideNote">${esc(String(session.note || '').slice(0, 50))}</span>
            <span class="spacer"></span>
            <span class="exSideCnt">共 ${total} 行${(session.modules || []).length ? ' · ' + session.modules.length + ' 个模块' : ''}</span>
          </div>
          <div class="exPre" id="exPre" hidden></div>
          <div class="exCode" id="exCode">${codeHTML(lines)}</div>
        </aside>
        <div class="exSplit" id="exSplit" title="按住左右拖动，调整代码栏 / 讲解栏的宽度（双击恢复默认）"></div>
        <section class="exMain">
          <div class="exThreadHead" id="exThreadHead"></div>
          <div class="exMsgs" id="exMsgs"></div>
          <div class="exAsk" id="exAsk"></div>
        </section>
      </div>
      <div class="exSplitH" id="exSplitH" title="按住上下拖动，调整代码 / 讲解区的高度（双击恢复默认）"><i></i></div>
    </div>`;

    bindSplit();

    document.getElementById('exCode').addEventListener('click', e => {
      const row = e.target.closest('.exLine');
      if (!row) return;
      selectLine(Number(row.getAttribute('data-line')), true);
    });
    document.getElementById('exRen').addEventListener('click', () => renameSession({ id: session.id, title: session.title }));
    const sb2 = document.getElementById('exStyleBtn');
    if (sb2) sb2.addEventListener('click', () => openStyleDialog(session.id));
    document.getElementById('exBack').addEventListener('click', async () => { await loadList(); view = 'list'; draw(); });
    document.getElementById('exDel').addEventListener('click', async () => {
      if (!confirm('删掉这条讲解（含所有讲解与追问）？')) return;
      try { await api(API + '/' + session.id, { method: 'DELETE' }); toast('已删除'); } catch (e) { toast(e.message); }
      await loadList(); view = 'list'; draw();
    });
    document.getElementById('exContinue').addEventListener('click', async () => {
      const btn = document.getElementById('exContinue');
      btn.disabled = true; btn.textContent = '正在继续…';
      try {
        await api(API + '/' + session.id + '/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast('接着讲…');
        startPoll();
      } catch (e) { toast('继续失败：' + e.message); }
      finally { btn.disabled = false; btn.textContent = '▶ 继续讲'; updateBar(); }
    });
    updateBar();
    renderPre();
    paintLines();
    renderThread(true);
  }
  /* ---------- 讲解风格示例（个性化） ----------
     用户贴/上传一段他喜欢的讲解，之后每段讲解都照这个风格写。
     文案和一个"已保存状态"在多个地方复用（准备页 + 运行页的弹窗），所以抽成一对函数。 */
  let style = { custom: false, len: 0, sample: '' };
  async function loadStyle(force) {
    if (!force && style.loaded) return style;
    try {
      const r = await api('/api/explain/style');
      style = { loaded: true, custom: !!r.len, len: Number(r.len || 0), sample: String(r.sample || ''), max: Number(r.max || 6000) };
    } catch (e) { style = { loaded: true, custom: false, len: 0, sample: '', max: 6000 }; }
    return style;
  }
  function styleLabel() {
    return style.custom ? ('当前：自定义风格（' + style.len + ' 字）') : '当前：默认风格';
  }
  function styleEditorHTML(opts) {
    const o = opts || {};
    return `<textarea class="exInput exStyleIn" id="exStyle" spellcheck="false" placeholder="把你喜欢的一段讲解贴进来 —— 一对一辅导记录、收藏的博客、你自己写的都行。贴完之后，这里的每一段讲解都会照它的语气、详略和排版来写（只学风格，不抄内容）。">${esc(style.sample || '')}</textarea>
      <div class="exStyleRow">
        <label class="btn small exFileBtn" title="支持 .txt / .md（读进上面的框，再点保存）">📄 上传文件
          <input type="file" id="exStyleFile" accept=".txt,.md,.markdown,.log,text/plain,text/markdown" hidden>
        </label>
        <button class="btn small primary" id="exStyleSave">保存风格</button>
        ${o.sid ? `<button class="btn small" id="exStyleRedo" title="把这一条已经讲好的讲解丢掉，按新风格重讲一遍（要重新花 AI 调用）">♻️ 保存并按新风格重讲这一段</button>` : ''}
        <button class="btn small" id="exStyleReset">恢复默认风格</button>
        <span class="exHint" id="exStyleState">${styleLabel()}</span>
      </div>
      <div class="exHint">风格示例只影响<b>之后</b>生成的讲解（已经在的讲解不会自己变）。示例写得短，讲解就跟着短。</div>`;
  }
  function bindStyleEditor(root, opts) {
    if (!root) return;
    const o = opts || {};
    const ta = root.querySelector('#exStyle');
    const stEl = root.querySelector('#exStyleState');
    const file = root.querySelector('#exStyleFile');
    if (file && ta) file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 400 * 1024) return toast('文件太大了（>400KB），截一段贴吧');
      const fr = new FileReader();
      fr.onload = () => {
        ta.value = String(fr.result || '').trim();
        if (stEl) stEl.textContent = '已读入「' + f.name + '」（' + ta.value.length + ' 字）—— 记得点「保存风格」';
        toast('已读入文件，点「保存风格」才会生效');
      };
      fr.onerror = () => toast('读取文件失败');
      fr.readAsText(f);
    });
    const save = root.querySelector('#exStyleSave');
    if (save) save.addEventListener('click', async () => {
      const v = ta ? String(ta.value || '').trim() : '';
      if (v.length > (style.max || 6000)) return toast('太长了（超过 ' + (style.max || 6000) + ' 字），截一段最有代表性的就行');
      save.disabled = true;
      try {
        const r = await api('/api/explain/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: v }) });
        style = { loaded: true, custom: !!r.len, len: Number(r.len || 0), sample: String(r.sample || ''), max: Number(r.max || 6000) };
        if (stEl) stEl.textContent = styleLabel();
        toast(style.custom ? ('已保存风格示例（' + style.len + ' 字），之后的讲解照它来') : '已切回默认风格');
        if (o.onSaved) o.onSaved(style);
      } catch (e) { toast('保存失败：' + e.message); }
      finally { save.disabled = false; }
    });
    const reset = root.querySelector('#exStyleReset');
    if (reset) reset.addEventListener('click', async () => {
      if (ta) ta.value = '';
      const sv = root.querySelector('#exStyleSave');
      if (sv) sv.disabled = true;
      try {
        await api('/api/explain/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: '' }) });
        style = { loaded: true, custom: false, len: 0, sample: '', max: style.max || 6000 };
        if (stEl) stEl.textContent = styleLabel();
        toast('已恢复默认风格');
        if (o.onSaved) o.onSaved(style);
      } catch (e) { toast('恢复失败：' + e.message); }
      finally { if (sv) sv.disabled = false; }
    });
    const redo = root.querySelector('#exStyleRedo');
    if (redo && o.sid) redo.addEventListener('click', async () => {
      if (!confirm('把这一条已经讲好的讲解丢掉、按新风格重讲一遍？（会重新花 AI 调用，追问记录保留）')) return;
      redo.disabled = true;
      try {
        await api(API + '/' + o.sid + '/redo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        closeStyleDialog();
        await openSession(o.sid);
        toast('开始按新风格重讲…');
        startPoll();
      } catch (e) { toast('重讲失败：' + e.message); redo.disabled = false; }
    });
  }
  function closeStyleDialog() {
    document.querySelectorAll('.exMask').forEach(x => x.remove());
  }
  function openStyleDialog(sid) {
    closeStyleDialog();
    const ov = document.createElement('div');
    ov.className = 'exMask';
    ov.innerHTML = `<div class="exDialog">
      <div class="exDlgHead"><span>🎨 讲解风格示例</span><button class="btn tiny" id="exStyleClose" title="关闭">✕</button></div>
      <div class="exDlgBody">${styleEditorHTML({ sid })}</div>
    </div>`;
    document.body.appendChild(ov);
    bindStyleEditor(ov.querySelector('.exDlgBody'), {
      sid,
      onSaved: () => { const b = document.getElementById('exStyleBtn'); if (b) b.textContent = styleBtnText(); }
    });
    const close = () => closeStyleDialog();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('#exStyleClose').addEventListener('click', close);
    const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
    setTimeout(() => { const t = ov.querySelector('#exStyle'); if (t) t.focus(); }, 50);
  }
  function styleBtnText() { return '🎨 风格：' + (style.custom ? '自定义' : '默认'); }

  /* ---------- 前置知识卡片（开讲前先过一遍） ----------
     用户要求："讲解代码之前把需要理解这段代码所需要的前置知识给用户过一遍，看用户知不知道，
     不知道的就拎出来带用户理解一遍。"
     两种形态：① status='prereq' → 让他逐个点「知道 / 不知道」；
               ② 之后 → 摘要条，可展开读补过的小课。 */
  let preOpen = true;               // 展开状态（默认展开：他就是来看这些小课的）
  let preUnknown = null;            // 待提交的"不知道"集合（点过之后才有）
  function prereqItems() { return (session && session.prereqs) || []; }
  function preOf(id) { return prereqItems().find(p => p.id === String(id || '')) || null; }
  function preIco(p) { return p.state === 'known' ? '✅' : (p.lesson ? '📖' : (p.state === 'unknown' ? '⏳' : '·')); }
  function renderPre() {
    const box = document.getElementById('exPre');
    if (!box || !session) return;
    const list = prereqItems();
    const asking = session.status === 'prereq';
    if (!list.length) {
      if (session.status === 'working' && !(session.modules || []).length) {
        box.hidden = false;
        box.innerHTML = '<div class="exPreHead"><span class="spinner"></span> AI 正在看：这段代码需要先知道哪些东西…</div>';
        return;
      }
      box.hidden = true; box.innerHTML = '';
      return;
    }
    box.hidden = false;
    const nUnk = preUnknown ? preUnknown.size : 0;
    const knownN = list.filter(p => p.state === 'known').length;
    const taughtN = list.filter(p => p.lesson).length;
    const pendingN = list.filter(p => p.state === 'unknown' && !p.lesson).length;
    const bits = [];
    if (asking) bits.push('不知道的点一下，我先带你过一遍');
    else {
      if (knownN) bits.push(knownN + ' 个知道');
      if (taughtN) bits.push(taughtN + ' 个补过课');
      if (pendingN) bits.push(pendingN + ' 个正在补');
    }
    box.innerHTML = `<div class="exPreBar">
        <button class="exPreToggle" id="exPreT" title="展开 / 收起前置知识">${preOpen ? '▾' : '▸'} 🧩 前置知识（${list.length}）</button>
        <span class="exPreSum">${esc(bits.join(' · '))}</span>
        ${pendingN ? '<span class="spinner" style="width:11px;height:11px;border-width:2px;"></span>' : ''}
      </div>
      ${preOpen ? `<div class="exPreRows">${list.map(p => `
        <div class="exPreRow ${p.state === 'known' ? 'know' : (p.lesson ? 'done' : (p.state === 'unknown' ? 'doing' : 'todo'))} ${selPre === p.id ? 'on' : ''}" data-pre="${esc(p.id)}" title="${esc(p.why || '')}">
          <i class="exPreIco">${preIco(p)}</i>
          <span class="exPreName">${esc(p.title)}</span>
          ${asking ? `<span class="exPreBtns">
            <button class="exPreSeg ${preUnknown && preUnknown.has(p.id) ? '' : 'on'}" data-prek="${esc(p.id)}">知道</button>
            <button class="exPreSeg ${preUnknown && preUnknown.has(p.id) ? 'on' : ''}" data-preu="${esc(p.id)}">不知道</button>
          </span>` : ''}
        </div>`).join('')}</div>` : ''}
      ${asking ? `<div class="exPreFoot">
        <button class="btn primary" id="exPreGo">${nUnk ? ('先补 ' + nUnk + ' 个，再讲代码') : '都知道了，开始讲代码'}</button>
        <button class="btn" id="exPreSkip" title="都不补，直接讲代码">跳过，直接讲</button>
      </div>` : ''}`;
    const t = box.querySelector('#exPreT');
    if (t) t.addEventListener('click', () => { preOpen = !preOpen; renderPre(); });
    box.querySelectorAll('.exPreRow').forEach(row => row.addEventListener('click', e => {
      if (e.target && e.target.closest && e.target.closest('.exPreSeg')) return;   // 点按钮不算"点开这一条"
      selectPre(row.getAttribute('data-pre'));
    }));
    box.querySelectorAll('[data-prek]').forEach(b => b.addEventListener('click', () => {
      if (preUnknown) preUnknown.delete(b.getAttribute('data-prek'));
      renderPre();
    }));
    box.querySelectorAll('[data-preu]').forEach(b => b.addEventListener('click', () => {
      if (!preUnknown) preUnknown = new Set();
      preUnknown.add(b.getAttribute('data-preu'));
      renderPre();
    }));
    const go = box.querySelector('#exPreGo');
    if (go) go.addEventListener('click', () => submitPrereqs(false));
    const sk = box.querySelector('#exPreSkip');
    if (sk) sk.addEventListener('click', () => submitPrereqs(true));
  }
  /** 点开一个前置知识：左边高亮它引用的代码行，右边显示它的讲解与追问 */
  function selectPre(id) {
    selPre = String(id || '');
    if (selPre) follow = false;
    renderPre();
    paintLines();
    renderThread(true);
    if (selPre) {
      const box = document.getElementById('exCode');
      const first = box && box.querySelector('.exLine.exRef');
      if (first) box.scrollTop = Math.max(0, first.offsetTop - box.clientHeight / 3);
    }
  }
  /** why 里提到的代码行号（"第 2 行 (msg) => {…}" → [2]），用来在左边把相关行标出来 */
  function preRefLines(p) {
    const nums = [];
    const re = /第\s*(\d{1,4})(?:\s*[-–—~至]\s*(\d{1,4}))?\s*行/g;
    let m;
    while ((m = re.exec(String((p && p.why) || ''))) && nums.length < 8) {
      const a = Number(m[1]); const b = Number(m[2] || m[1]);
      for (let i = a; i <= b && nums.length < 8; i++) if (!nums.includes(i)) nums.push(i);
    }
    return nums;
  }
  function renderPreThread(p, scroll) {
    const headEl = document.getElementById('exThreadHead');
    const msgs = document.getElementById('exMsgs');
    if (!headEl || !msgs || !p) return;
    headEl.innerHTML = `<div class="exThTitle">🧩 ${esc(p.title)}${p.why ? ' <span class="exPreWhy">' + esc(p.why) + '</span>' : ''}${p.state === 'known' ? ' <span class="exPendingTag">你说知道 · 跳过</span>' : ''}</div>`;
    let h = '';
    if (p.lesson) {
      h += `<div class="exMsg ai"><div class="exAiHead">📖 前置知识 · ${esc(p.title)}</div><div class="exAiBody mdBody">${mdToHTML(p.lesson)}</div></div>`;
    } else if (p.state === 'known') {
      h += '<div class="exMsg ai"><div class="exAiBody">这一条你标了<b>知道</b>，所以没讲。<br><span class="exHint">想听的话，点下面「📖 还是讲一下这个」。</span></div></div>';
    } else if (p.state === 'unknown') {
      h += '<div class="exEmpty"><span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> AI 正在给你写这一课…<br><span class="exHint">写完就能在这儿读，也能接着追问。</span></div>';
    } else {
      h += '<div class="exEmpty">还没有开始讲这个知识点。</div>';
    }
    for (const c of (p.chat || [])) {
      h += (c.role === 'me')
        ? `<div class="exMsg me"><div class="exMe">${esc(c.content)}</div></div>`
        : `<div class="exMsg ai"><div class="exAiHead">💬 回答</div><div class="exAiBody mdBody">${mdToHTML(c.content)}</div></div>`;
    }
    msgs.innerHTML = h;
    renderAsk();
    if (scroll) msgs.scrollTop = msgs.scrollHeight;
  }
  async function teachPre(id) {
    const p = preOf(id);
    if (!p) return;
    try {
      await api(API + '/' + session.id + '/prereq/' + encodeURIComponent(p.id) + '/teach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('好，这一课也讲一下');
      startPoll();
      renderThread(true);
    } catch (e) { toast('失败：' + e.message); }
  }
  async function submitPrereqs(skip) {
    if (!session) return;
    const unknown = skip ? [] : Array.from(preUnknown || []);
    try {
      const r = await api(API + '/' + session.id + '/prereqs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknown, skip })
      });
      if (r && r.session) session = r.session;
      preUnknown = null;
      preOpen = true;
      if (!skip && unknown.length) selPre = String(unknown[0]);   // 右边直接停在"正在补的这一课"上
      toast(skip ? '好，直接开始讲代码' : (unknown.length ? ('先补 ' + unknown.length + ' 个前置知识，同时开始讲代码') : '开始逐行讲代码…'));
      renderPre();
      paintLines();
      renderThread(true);
      startPoll();
    } catch (e) { toast('提交失败：' + e.message); }
  }

  /* ---------- 左右宽度 + 上下高度都能拖（用户要求） ----------
     宽度比例 / 高度都存本机 localStorage（显示偏好，跟教程正文宽度一个道理：各屏不同，不同步）。
     ⚠️ 用户提了两条：① "不只是中间的分隔条，左右的也要能拖"；② "下面的横条也能拖，自主调节显示范围"。
       · 左右：命中区不是那 14px 的条，而是**边界附近的整条带** ——
         左栏右边缘 / 中间分隔条 / 右栏左边缘，靠近 12px 内都算抓住边界；
       · 上下：两栏区域的**底边（含下面那条横握把）**，靠近即可按住上下拖，内部滚动范围随之变化。
     文档级监听只绑一次，容器每次渲染时更新引用。 */
  const SPLIT_KEY = 'sierxing-explain-split';
  const HEIGHT_KEY = 'sierxing-explain-height';
  const WIDTH_KEY = 'sierxing-explain-totalw';
  const SPLIT_HIT = 12;                       // 边界两侧各 12px 算命中
  let splitPct = 0, exHeight = 0, exW = 0;
  try { splitPct = Math.max(0, Math.min(78, Number(localStorage.getItem(SPLIT_KEY)) || 0)); } catch (e) { splitPct = 0; }
  try { exHeight = Math.max(0, Number(localStorage.getItem(HEIGHT_KEY)) || 0); } catch (e) { exHeight = 0; }
  try { exW = Math.max(0, Number(localStorage.getItem(WIDTH_KEY)) || 0); } catch (e) { exW = 0; }
  let splitWrap = null;
  function applySplit(wrap) {
    if (!wrap) return;
    if (splitPct > 0) wrap.style.setProperty('--exSide', splitPct + '%');
    else wrap.style.removeProperty('--exSide');
  }
  function applyHeight(wrap) {
    if (!wrap) return;
    if (exHeight > 0) wrap.style.setProperty('--exH', exHeight + 'px');
    else wrap.style.removeProperty('--exH');
  }
  /** 整体宽度（最外两条边拖的那个） */
  function applyWidth(wrap) {
    if (!wrap) return;
    if (exW > 0) wrap.style.setProperty('--exW', exW + 'px');
    else wrap.style.removeProperty('--exW');
  }
  const maxTotalW = () => Math.max(560, window.innerWidth - 110);
  /** 左/右边界 x 坐标（= 分隔条中线；拿不到分隔条就用比例算） */
  function splitBoundX() {
    const w = splitWrap;
    if (!w || !w.isConnected) return -1;
    const r = w.getBoundingClientRect();
    const sp = document.getElementById('exSplit');
    if (sp) {
      const b = sp.getBoundingClientRect();
      if (b.width) return b.left + b.width / 2;
    }
    const pct = splitPct > 0 ? splitPct : 44;
    return r.left + r.width * pct / 100;
  }
  function bindSplit() {
    splitWrap = document.querySelector('.exWrap');
    if (!splitWrap) return;
    applySplit(splitWrap);
    applyHeight(splitWrap);
    applyWidth(splitWrap);
    if (document.__exSplitBound) return;      // 文档级监听只绑一次
    document.__exSplitBound = true;
    const narrow = () => window.matchMedia('(max-width: 980px)').matches;
    const rectOf = () => {
      const w = splitWrap;
      if (!w || !w.isConnected) return null;
      const r = w.getBoundingClientRect();
      return r.width ? r : null;
    };
    /* 最外两条边（代码栏左边框 / 对话栏右边框）→ 整体宽度 */
    const nearEdge = (e, r) => {
      if (e.clientY < r.top || e.clientY > r.bottom) return '';
      const dl = e.clientX - r.left, dr = e.clientX - r.right;
      if (Math.abs(dl) <= SPLIT_HIT) return 'L';
      if (Math.abs(dr) <= SPLIT_HIT) return 'R';
      return '';
    };
    /* 左右：靠近"边界带"（左栏右边缘 / 分隔条 / 右栏左边缘） */
    const inZone = e => {
      if (narrow()) return false;
      const r = rectOf();
      if (!r) return false;
      if (e.clientX < r.left - SPLIT_HIT || e.clientX > r.right + SPLIT_HIT) return false;
      if (e.clientY < r.top || e.clientY > r.bottom) return false;
      const bx = splitBoundX();
      return bx > 0 && Math.abs(e.clientX - bx) <= SPLIT_HIT;
    };
    /* 上下：靠近两栏区域的底边（含下面那条横握把） */
    const inZoneV = e => {
      const r = rectOf();
      if (!r) return false;
      if (e.clientX < r.left || e.clientX > r.right) return false;
      return e.clientY >= r.bottom - SPLIT_HIT && e.clientY <= r.bottom + 26;
    };
    let drag = false, dragV = false, dragW = '', startY = 0, startH = 0, startX = 0, startW = 0;
    const clearHot = () => {
      if (!splitWrap || !splitWrap.isConnected) return;
      splitWrap.classList.remove('exHot', 'exHotV', 'exHotL', 'exHotR');
    };
    const stop = () => {
      if (!drag && !dragV && !dragW) return;
      const what = dragW ? 'W' : (dragV ? 'V' : 'H');
      drag = false; dragV = false; dragW = '';
      document.body.classList.remove('exResizing', 'exResizingV');
      clearHot();
      if (what === 'W') {
        try { localStorage.setItem(WIDTH_KEY, String(exW)); } catch (e) {}
        toast('两栏总宽 ' + exW + 'px（双击最外侧的边恢复默认）');
      } else if (what === 'V') {
        try { localStorage.setItem(HEIGHT_KEY, String(exHeight)); } catch (e) {}
        toast('显示高度 ' + exHeight + 'px（双击底边恢复默认）');
      } else {
        try { localStorage.setItem(SPLIT_KEY, String(splitPct)); } catch (e) {}
        toast('左栏宽度 ' + splitPct + '%（双击边界恢复默认）');
      }
    };
    document.addEventListener('mousemove', e => {
      const w = splitWrap;
      if (!w || !w.isConnected) return;
      if (dragW) {
        /* 抓的是最外侧的边：那条边要跟着鼠标走。整体是居中布局，所以另一边对称跟动 ——
           ⚠️ 方向要看抓的是哪条边：抓**左边**时往右拖 = 整体变窄（-2×），抓**右边**时往右拖 = 变宽（+2×）。
           两边都按 +2× 算的话，抓左边拖起来会"反向跑"（真实踩到过）。 */
        const dx = e.clientX - startX;
        const next = Math.round(startW + (dragW === 'L' ? -2 : 2) * dx);
        exW = Math.max(560, Math.min(maxTotalW(), next));
        applyWidth(w);
        return;
      }
      if (dragV) {
        const h = Math.max(280, Math.min(window.innerHeight - 140, Math.round(startH + (e.clientY - startY))));
        exHeight = h;
        applyHeight(w);
        return;
      }
      if (drag) {
        const r = w.getBoundingClientRect();
        if (!r.width) return;
        splitPct = Math.max(22, Math.min(78, Math.round((e.clientX - r.left) / r.width * 100)));
        applySplit(w);
        return;
      }
      const r = rectOf();
      const edge = r ? nearEdge(e, r) : '';
      const hot = !edge && inZone(e);
      const hotV = !edge && !hot && inZoneV(e);
      w.classList.toggle('exHotL', edge === 'L');
      w.classList.toggle('exHotR', edge === 'R');
      w.classList.toggle('exHot', hot);
      w.classList.toggle('exHotV', hotV);
    });
    document.addEventListener('mousedown', e => {
      const r = rectOf();
      if (r && nearEdge(e, r)) {
        dragW = nearEdge(e, r);
        startX = e.clientX;
        startW = r.width;
        document.body.classList.add('exResizing');
        e.preventDefault();
        return;
      }
      if (inZone(e)) {
        drag = true;
        document.body.classList.add('exResizing');
        e.preventDefault();
        return;
      }
      if (inZoneV(e)) {
        const rr = rectOf();
        if (!rr) return;
        dragV = true;
        startY = e.clientY;
        startH = rr.height;
        document.body.classList.add('exResizingV');
        e.preventDefault();
      }
    });
    document.addEventListener('mouseup', stop);
    document.addEventListener('dblclick', e => {
      const r = rectOf();
      if (r && nearEdge(e, r)) {
        exW = 0;
        applyWidth(splitWrap);
        clearHot();
        try { localStorage.removeItem(WIDTH_KEY); } catch (e2) {}
        toast('已恢复默认宽度（吃满页面）');
        return;
      }
      if (inZoneV(e)) {
        exHeight = 0;
        applyHeight(splitWrap);
        try { localStorage.removeItem(HEIGHT_KEY); } catch (e2) {}
        toast('已恢复默认高度');
        return;
      }
      if (inZone(e)) {
        splitPct = 0;
        applySplit(splitWrap);
        clearHot();
        try { localStorage.removeItem(SPLIT_KEY); } catch (e2) {}
        toast('已恢复默认宽度');
      }
    });
    /* 鼠标离开两栏区域 → 取消"发光"状态（否则会一直亮着） */
    document.addEventListener('mouseleave', () => { if (!drag && !dragV && !dragW) clearHot(); }, true);
  }

  function updateBar() {
    if (!session || !document.getElementById('exProgBar')) return;
    const total = Number(session.lines || 0);
    const ex = Number(session.explained || 0);
    const mods = session.modules || [];
    const totalMods = mods.length;
    const dMods = modsDone();
    const doneAll = totalMods ? dMods >= totalMods : ex >= total;
    const pct = totalMods ? Math.round(100 * dMods / totalMods) : (total ? Math.round(100 * ex / total) : 0);
    document.getElementById('exProgBar').style.width = pct + '%';
    document.getElementById('exProgTxt').textContent = totalMods
      ? ('已讲 ' + dMods + '/' + totalMods + ' 个模块 · ' + ex + '/' + total + ' 行')
      : ('已讲 ' + ex + '/' + total + ' 行');
    const st = document.getElementById('exStat');
    st.title = '';
    if (session.status === 'prereq') {
      st.innerHTML = '🧩 先确认上面的前置知识，再开始逐行讲';
    } else if (session.status === 'working') {
      st.innerHTML = '<span class="spinner"></span> ' + (totalMods
        ? ('AI 正在讲第 ' + Math.min(total, ex + 1) + ' 行起（' + totalMods + ' 个模块并行在写）')
        : 'AI 正在读整段、划分讲解模块…');
    } else if (session.status === 'done') st.textContent = '✅ 整段讲完了';
    else {
      const err = String(session.last_error || '').replace(/\s+/g, ' ').trim();
      st.textContent = err ? ('⏸ ' + (err.length > 40 ? err.slice(0, 40) + '…' : err)) : '⏸ 停下了';
      st.title = err;
    }
    document.getElementById('exContinue').hidden = !(session.status !== 'working' && session.status !== 'prereq' && !doneAll);
  }
  function selectLine(n, byUser) {
    const total = Number(session.lines || 1);
    if (n < 0 || n > total) return;
    selPre = '';
    /* 点了"已讲到的那一行"= 继续跟随最新；点到别处 = 他自己在看，别再打断他 */
    if (byUser) follow = (n === 0 || n >= Number(session.explained || 0));
    selLine = n;
    paintLines();
    renderThread(true);
    if (!byUser) {
      const box = document.getElementById('exCode');
      const row = box ? box.querySelector('.exLine[data-line="' + n + '"]') : null;
      if (row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2);
    }
  }
  function paintLines() {
    const box = document.getElementById('exCode');
    if (!box) return;
    ensureOverviewRow();
    const cover = new Map(), asked = new Set();
    for (const t of turns) {
      if (t.kind === 'overview') continue;
      const a = Number(t.line_from), b = Number(t.line_to);
      if (t.role === 'ai' && t.kind === 'explain') for (let n = a; n <= b; n++) cover.set(n, t);
      if (t.kind === 'ask') for (let n = a; n <= b; n++) asked.add(n);
    }
    const ov = hasOverview();
    const selCover = selLine > 0 ? cover.get(selLine) : null;
    const refSet = new Set(selPre ? preRefLines(preOf(selPre)) : []);
    box.querySelectorAll('.exLine').forEach(row => {
      const n = Number(row.getAttribute('data-line'));
      const isOv = n === 0;
      row.classList.toggle('exDone', isOv ? ov : cover.has(n));
      row.classList.toggle('exAsk', isOv ? false : asked.has(n));
      row.classList.toggle('exOn', !selPre && n === selLine);
      row.classList.toggle('exRng', !selPre && !!(selCover && !isOv && n >= Number(selCover.line_from) && n <= Number(selCover.line_to)));
      row.classList.toggle('exRef', !isOv && refSet.has(n));
    });
  }
  function msgHTML(t) {
    if (t.role === 'me') return `<div class="exMsg me"><div class="exMe">${esc(t.content)}</div></div>`;
    const h = t.kind === 'overview' ? '📄 概览'
      : t.kind === 'answer' ? '💬 回答'
        : '🔍 第 ' + t.line_from + (Number(t.line_to) > Number(t.line_from) ? '-' + t.line_to : '') + ' 行'
          + (t.title ? ' · ' + esc(String(t.title)) : '');
    return `<div class="exMsg ai"><div class="exAiHead">${h}</div><div class="exAiBody mdBody">${mdToHTML(t.content)}</div></div>`;
  }
  function renderThread(scroll) {
    const headEl = document.getElementById('exThreadHead');
    const msgs = document.getElementById('exMsgs');
    if (!headEl || !msgs || !session) return;
    if (selPre) {
      const p = preOf(selPre);
      if (p) return renderPreThread(p, scroll);
      selPre = '';
    }
    const lines = String(session.code || '').split('\n');
    if (selLine === 0) {
      headEl.innerHTML = '<div class="exThTitle">📄 概览 · 这段代码整体在做什么</div>';
    } else {
      const cover = coverOf(selLine);
      const from = cover ? Number(cover.line_from) : selLine;
      const to = cover ? Number(cover.line_to) : selLine;
      const snippet = lines.slice(from - 1, to).join('\n');
      const mtitle = String((cover && cover.title) || '').trim()
        || ((session.modules || []).find(m => Number(m.from) <= from && to <= Number(m.to)) || {}).title || '';
      /* 不在右边重复显示这一坨代码：左边已经高亮着"你正在看哪儿"了，
         再贴一遍只会挤压对话栏（用户明确要求去掉了）。 */
      headEl.innerHTML = `<div class="exThTitle">第 ${from === to ? from : from + '-' + to} 行${mtitle ? ' · ' + esc(mtitle) : ''}${cover ? '' : ' <span class="exPendingTag">还没讲到</span>'}</div>`;
    }
    const th = threadOf(selLine);
    msgs.innerHTML = th.length ? th.map(msgHTML).join('') : emptyThreadHTML();
    renderAsk();
    if (scroll) msgs.scrollTop = th.length ? msgs.scrollHeight : 0;
  }
  function emptyThreadHTML() {
    const ex = Number(session.explained || 0);
    const mods = session.modules || [];
    if (session.status === 'prereq') {
      return '<div class="exEmpty">先在上面把前置知识确认一下（不知道的我带你补）。<br><span class="exHint">确认完就自动开始逐行讲解。</span></div>';
    }
    if (session.status === 'working') {
      if (!mods.length) return '<div class="exEmpty">📖 AI 正在读整段代码、划分讲解模块…<br><span class="exHint">划好之后它会<b>并行</b>把每一块的讲解都写出来，你不用一行一行等。</span></div>';
      return `<div class="exEmpty">⏳ 这一块还没讲完（AI 正在并行写 ${mods.length} 个模块，已经讲到第 ${ex} 行）<br><span class="exHint">哪一块先写完，点它就能先看。</span></div>`;
    }
    if (mods.length ? modsDone() < mods.length : selLine > ex) {
      return `<div class="exEmpty">这块还没讲到（上次停在第 ${ex} 行）。<br><button class="btn small primary" id="exContinue2">▶ 从没讲的接着讲</button></div>`;
    }
    return '<div class="exEmpty">这一段还没有讲解。</div>';
  }
  /* 追问输入框的高度：用户拖右下角（resize:vertical）改过就记住 ——
     重画回答区、刷新页面都照旧。用户报的"调节高度后立刻变回去"就是这里没记住 + 每轮轮询重画。 */
  let taH = 0;
  try { taH = Math.max(0, Number(localStorage.getItem('sierxing-explain-tah')) || 0); } catch (e) { taH = 0; }
  function bindTaHeight(ta) {
    if (!ta) return;
    const save = () => {
      const h = Math.round(ta.getBoundingClientRect().height);
      if (h > 40 && Math.abs(h - taH) > 2) {
        taH = h;
        try { localStorage.setItem('sierxing-explain-tah', String(h)); } catch (e) {}
      }
    };
    ta.addEventListener('mouseup', save);
    ta.addEventListener('pointerup', save);
    ta.addEventListener('input', save);
  }
  function askSig() {
    const canAsk = selPre ? true : (selLine === 0 ? hasOverview() : !!coverOf(selLine));
    const pre = session && session.status === 'prereq' ? 1 : 0;
    const pp = selPre ? (preOf(selPre) || {}).state : '';
    return [Number(session && session.id) || 0, selLine, selPre, busy ? 1 : 0, canAsk ? 1 : 0, pre, pp].join('|');
  }
  function renderAsk(force) {
    const box = document.getElementById('exAsk');
    if (!box || !session) return;
    /* ⚠️ 别每轮都重画回答区：轮询每 2.6 秒一次，重画会把输入框换成新元素 ——
       用户手打的内容还在（askDraft），但**焦点丢了**、他手动拖高的输入框高度也没了
       （用户报的"调节高度后立刻变回去"就是这个）。状态没变就直接跳过。 */
    const sig = askSig();
    if (!force && box.dataset.sig === sig && box.querySelector('#exTa')) return;
    box.dataset.sig = sig;
    if (busy) {
      box.innerHTML = `<div class="exBusyWrap"><span class="spinner"></span><span id="exBusy">${esc(busyText())}</span></div>`;
      return;
    }
    if (session.status === 'prereq') {
      box.innerHTML = '<div class="exPreWait">🧩 先确认上面的前置知识（点「✅ 知道」或「❓ 不知道」）—— 之后每一行都可以在这里追问。</div>';
      return;
    }
    const preSel = selPre ? preOf(selPre) : null;
    const canAsk = preSel ? true : (selLine === 0 ? hasOverview() : !!coverOf(selLine));
    const ph = preSel ? ('针对「' + preSel.title + '」追问（例：能用生活里的例子再讲一遍吗？）')
      : (selLine === 0 ? '针对整段代码追问…' : '针对第 ' + selLine + ' 行追问（例：这里为什么不用 const？）');
    box.innerHTML = `<div class="exQuick">
        ${preSel && preSel.state === 'known' && !preSel.lesson ? '<button class="btn small" data-pq="teach" title="你标了知道，但也可以听一下">📖 还是讲一下这个</button>' : ''}
        <button class="btn small" data-q="redo" ${canAsk ? '' : 'disabled'}>🔁 没看懂，换个说法</button>
        <button class="btn small" data-q="example" ${canAsk ? '' : 'disabled'}>🧩 举个例子</button>
        <button class="btn small" data-q="why" ${canAsk ? '' : 'disabled'}>❓ 为什么必须这么写</button>
      </div>
      <div class="exInputRow">
        <textarea class="exInput exTa" id="exTa" rows="2" spellcheck="false" placeholder="${canAsk ? ph : '这一行还没讲到，先点「继续讲」'}"></textarea>
        <button class="btn primary" id="exSend" ${canAsk ? '' : 'disabled'}>发送</button>
      </div>`;
    const ta = document.getElementById('exTa');
    ta.value = askDraft;
    if (taH > 40) ta.style.height = taH + 'px';      // 用户拖高过就照着来（见下面 bindTaHeight）
    bindTaHeight(ta);
    ta.addEventListener('input', () => { askDraft = ta.value; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const s = document.getElementById('exSend'); if (s && !s.disabled) s.click(); }
    });
    box.querySelectorAll('[data-pq="teach"]').forEach(b => b.addEventListener('click', () => teachPre(selPre)));
    const TXT = { redo: '没看懂，换个更小的说法再讲一遍', example: '举个例子', why: '为什么必须这么写？不这么写会怎样？' };
    app.querySelectorAll('#exAsk [data-q]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-q');
      doAsk(TXT[k], k);
    }));
    const send = document.getElementById('exSend');
    if (send) send.addEventListener('click', () => {
      const v = String(document.getElementById('exTa').value || '').trim();
      if (!v) return toast('先写一句要问什么');
      doAsk(v, 'ask');
    });
    const c2 = document.getElementById('exContinue2');
    if (c2) c2.addEventListener('click', () => { const b = document.getElementById('exContinue'); if (b) b.click(); });
  }
  async function doAsk(text, kind) {
    if (busy || !session) return;
    if (!['redo', 'example', 'why'].includes(kind)) kind = 'ask';
    if (selPre) return askPre(selPre, text, kind);
    const cover = selLine > 0 ? coverOf(selLine) : null;
    const anchor = cover ? { from: Number(cover.line_from), to: Number(cover.line_to) } : { from: selLine, to: selLine };
    busy = true; busyMsg = 'AI 正在看这一行…'; busyT0 = Date.now();
    if (busyTimer) clearInterval(busyTimer);
    busyTimer = setInterval(() => { const el = document.getElementById('exBusy'); if (el) el.textContent = busyText(); }, 1000);
    const tmp = { id: 'tmp', role: 'me', kind: 'ask', line_from: anchor.from, line_to: anchor.to, content: text, created_at: '' };
    turns = turns.concat([tmp]);
    askDraft = '';
    paintLines(); renderThread(true); renderAsk();
    try {
      const r = await api(API + '/' + session.id + '/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: selLine, text, kind })
      });
      stopBusy();
      turns = r.turns || turns;
      paintLines(); renderThread(true); updateBar();
    } catch (e) {
      stopBusy();
      turns = turns.filter(t => t !== tmp);
      toast('追问失败：' + e.message);
      paintLines(); renderThread(false); renderAsk();
    }
  }
  /** 对某个前置知识的追问（挂在这个知识点名下，用同一套右边对话栏） */
  async function askPre(id, text, kind) {
    const p = preOf(id);
    if (!p) return;
    busy = true; busyMsg = 'AI 正在看这个知识点…'; busyT0 = Date.now();
    if (busyTimer) clearInterval(busyTimer);
    busyTimer = setInterval(() => { const el = document.getElementById('exBusy'); if (el) el.textContent = busyText(); }, 1000);
    const before = (p.chat || []).length;
    p.chat = (p.chat || []).concat([{ role: 'me', content: text }]);
    askDraft = '';
    renderThread(true); renderAsk();
    try {
      const r = await api(API + '/' + session.id + '/prereq/' + encodeURIComponent(p.id) + '/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, kind })
      });
      stopBusy();
      if (r && r.prereqs) session.prereqs = r.prereqs;
      renderThread(true); renderPre();
    } catch (e) {
      stopBusy();
      p.chat = (p.chat || []).slice(0, before);
      toast('追问失败：' + e.message);
      renderThread(false); renderAsk();
    }
  }

  /* 轮询回来的最新状态：只做"增量重画"，不整页重绘（否则会打断正在看的讲解）。
     并行讲解时模块可能乱序完成，所以"跟随最新"跟的是**最新写完的那一块**。 */
  function applyDetail(r) {
    if (!r || !r.session) return;
    const prevLen = turns.length;
    const prevEx = Number(session.explained || 0);
    session = r.session;
    turns = r.turns || [];
    const ex = Number(session.explained || 0);
    const grew = turns.length > prevLen;
    if (grew && follow && !selPre) {
      const last = turns.filter(t => t.role === 'ai' && t.kind === 'explain').slice(-1)[0];
      const target = last ? Number(last.line_from) : (selLine > 0 ? selLine : 0);
      if (target > 0 && target !== selLine) selectLine(target, false);
      else { paintLines(); renderThread(false); }
    } else if (ex > prevEx && follow && !selPre && (selLine === 0 || selLine >= prevEx)) {
      selectLine(ex, false);
    } else {
      paintLines(); renderThread(false);
    }
    updateBar();
    renderPre();
  }

  /* ================= 教程里的代码块：编号 + 右键「看不懂？讲明白」 =================
     整段都活在「看懂代码」自己里面：不改 app.js、也不改教程渲染。靠 hashchange +
     MutationObserver 认领教程页，给渲染出来的 <pre> 挂编号徽标与右键菜单。

     ⚠️ 三条不能破（每条都会踩坏别的功能）：
     1. 徽标**不能有文字节点** —— 只放一个空 <span>，编号与提示全用 CSS 的
        ::before + attr() 生成。tutnotes 的划线笔记是按"正文文本节点的绝对偏移"
        定位的，正文里多一个文本节点，所有高亮就会整体错位。
     2. 右键只在「没有选中文字 + 落在带编号的代码块上」时才接管：有选中文字时那是
        划线笔记的地盘；其余一律放行系统菜单（用户还要复制 / 翻译）。
     3. 编号的唯一权威是 tutInfo() 解析的 blocks（和教程页里的下拉列表同一份）：
        徽标只按**内容匹配**取号，匹配不上就不编号 —— 宁可没有，也不能给错号。
  */
  const EX_NO = 'data-exno';
  let tutInfoCache = new Map();     // tid -> { at, info }
  let decoTimer = null, decoTries = 0, decoBound = false;

  function curTutId() {
    const m = String(location.hash || '').match(/^#\/t\/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }
  /** 教程里"看得见的代码块"：与 mdToHTML 同一套围栏规则；viz 里是真 HTML 的那种在教程里
      渲染成的是图（不是代码块），不列、不编号 —— 否则编号和用户看到的对不上。 */
  function parseMdBlocks(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const m = String(lines[i]).match(/^[ \t]*(`{3,})([\w-]*)[ \t]*$/);
      if (!m) { i++; continue; }
      const mark = m[1].length;
      const lang = String(m[2] || '').toLowerCase();
      const buf = [];
      let j = i + 1, closed = false;
      while (j < lines.length) {
        const cl = String(lines[j]).match(/^[ \t]*(`{3,})[ \t]*$/);
        if (cl && cl[1].length >= mark) { closed = true; break; }
        buf.push(lines[j]); j++;
      }
      if (!closed) { i++; continue; }        // 同 mdToHTML：没闭合就当普通文本
      const code = buf.join('\n');
      const isViz = /^(?:viz|demo|htmlviz)$/.test(lang);
      const looksHTML = /<[a-zA-Z][\w-]*[\s\S]*>/.test(code);
      if (!(isViz && looksHTML)) out.push({ lang: isViz ? guessCodeLang(code) : lang, code, viz: isViz });
      i = j + 1;
    }
    return out.slice(0, 60);
  }
  function blocksFromHTML(html) {
    const out = [];
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      doc.querySelectorAll('pre').forEach(pre => {
        const code = String(pre.textContent || '').replace(/\s+$/, '');
        if (code.trim()) out.push({ lang: String(pre.getAttribute('data-lang') || '').toLowerCase(), code });
      });
    } catch (e) {}
    return out.slice(0, 60);
  }
  function guessCodeLang(code) {
    const c = String(code || '');
    if (/^\s*[\{\[]/.test(c) && /"\s*:/.test(c)) return 'json';
    if (/^\s*(?:from|import)\s+\w|^\s*def\s+\w+\s*\(/m.test(c)) return 'python';
    if (/^\s*(?:#!|\$\s|npm |pip |git |docker |python3 )/m.test(c)) return 'bash';
    if (/\b(?:const|let|var|function)\s|=>/.test(c)) return 'js';
    if (/<\/?[a-zA-Z][\w-]*[\s>]/.test(c)) return 'html';
    if (/^\s*SELECT\b/im.test(c)) return 'sql';
    return '';
  }
  async function tutInfo(tid) {
    const hit = tutInfoCache.get(Number(tid));
    if (hit && Date.now() - hit.at < 30000) return hit.info;
    let r = null;
    try { r = await api('/api/tutorials/' + tid); } catch (e) { return null; }
    const t = (r && r.tutorial) || {};
    const info = {
      id: Number(tid), title: t.title || '', goal_id: Number(t.goal_id || 0), goal: (r && r.goal) || null,
      blocks: (t.format === 'html' ? blocksFromHTML(t.content) : parseMdBlocks(t.content))
    };
    tutInfoCache.set(Number(tid), { at: Date.now(), info });
    return info;
  }
  const normCode = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '').trim();
  function tutPreRoots() {
    const out = [];
    const body = document.querySelector('.tutBody');
    if (body) out.push({ doc: document, box: body, frame: null });
    const f = document.getElementById('tutFrame');
    if (f) {
      try { const d = f.contentDocument; if (d && d.body) out.push({ doc: d, box: d.body, frame: f }); } catch (e) {}
    }
    return out;
  }
  /** iframe（HTML 教程）里没有 explain.css，徽标样式得自带一份 */
  const FRAME_BADGE_CSS = 'pre.exTutPre{position:relative}'
    + '.exTutNo{position:absolute;top:6px;right:10px;z-index:9;cursor:pointer;user-select:none;-webkit-user-select:none;'
    + 'font:600 10px/17px system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.4px;color:#6b7280;'
    + 'background:rgba(127,127,140,.12);border:1px solid rgba(127,127,140,.4);border-radius:5px;padding:0 6px;white-space:nowrap}'
    + '.exTutNo::before{content:"#" attr(data-exno) " " attr(data-exlang);font-weight:700}'
    + '.exTutNo::after{content:" · 🔍 讲明白";display:none}'
    + 'pre.exTutPre:hover .exTutNo::after{display:inline}'
    + 'pre.exTutPre:hover .exTutNo{color:#4f46e5;background:rgba(99,102,241,.14);border-color:rgba(99,102,241,.5)}';
  function ensureFrameStyle(doc) {
    try {
      if (!doc || doc === document || doc.getElementById('exTutBadgeCss')) return;
      const st = doc.createElement('style');
      st.id = 'exTutBadgeCss';
      st.textContent = FRAME_BADGE_CSS;
      (doc.head || doc.documentElement).appendChild(st);
    } catch (e) {}
  }
  /** 认领教程页上的监听（每个文档一次）：右键菜单 + 点徽标 */
  function bindTutDoc(root) {
    const doc = root.doc;
    if (!doc || doc.__exTutBound) return;
    doc.__exTutBound = true;
    const off = () => (root.frame ? root.frame.getBoundingClientRect() : { left: 0, top: 0 });
    doc.addEventListener('contextmenu', e => {
      const pre = e.target && e.target.closest ? e.target.closest('pre.exTutPre') : null;
      if (!pre) return;
      try { const s = doc.getSelection ? doc.getSelection() : null; if (s && String(s).trim()) return; } catch (e2) {}
      const n = Number(pre.getAttribute(EX_NO) || 0);
      const tid = curTutId();
      if (!n || !tid) return;
      e.preventDefault(); e.stopPropagation();
      const o = off();
      showTutMenu(o.left + e.clientX, o.top + e.clientY, tid, n);
    }, true);
    doc.addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('.exTutNo') : null;
      if (!b) return;
      const pre = b.closest('pre.exTutPre');
      const n = Number((pre && pre.getAttribute(EX_NO)) || 0);
      const tid = curTutId();
      if (!n || !tid) return;
      e.preventDefault(); e.stopPropagation();
      const o = off();
      showTutMenu(o.left + e.clientX, o.top + e.clientY, tid, n);
    }, true);
    doc.addEventListener('dblclick', e => {
      if (e.target && e.target.closest && e.target.closest('.exTutNo')) e.stopPropagation();
    }, true);
  }
  /** 给教程页里渲染出来的每一个代码块挂编号徽标（编号取解析列表里的序号） */
  function decorateTutorial(info) {
    let numbered = 0;
    for (const root of tutPreRoots()) {
      ensureFrameStyle(root.doc);
      bindTutDoc(root);
      const pres = Array.from(root.box.querySelectorAll('pre'));
      let cursor = 0;
      for (const pre of pres) {
        const code = normCode(pre.textContent);
        let idx = -1;
        for (let i = cursor; i < info.blocks.length; i++) if (normCode(info.blocks[i].code) === code) { idx = i; break; }
        if (idx < 0) for (let i = 0; i < cursor; i++) if (normCode(info.blocks[i].code) === code) { idx = i; break; }
        if (idx < 0) continue;                // 匹配不上就不编号（宁缺勿错）
        cursor = idx + 1;
        const n = idx + 1;
        pre.classList.add('exTutPre');
        if (pre.getAttribute(EX_NO) !== String(n)) pre.setAttribute(EX_NO, String(n));
        let b = pre.querySelector('.exTutNo');
        if (!b) {
          b = root.doc.createElement('span');
          b.className = 'exTutNo';
          b.setAttribute('role', 'button');
          b.setAttribute('tabindex', '0');
          pre.appendChild(b);
        }
        /* ⚠️ 编号要同时挂在徽标自己身上：CSS 的 ::before 里 attr() 只能读**自己**的属性，
           挂在 pre 上会渲染出一个没有数字的"# JS"（真实踩到过）。 */
        b.setAttribute(EX_NO, String(n));
        b.setAttribute('data-exlang', String(info.blocks[idx].lang || '').toUpperCase());
        b.title = '看不懂这一块？点这里让「看懂代码」逐行讲明白（也可以右键代码块）';
        numbered++;
      }
    }
    return numbered;
  }
  function scheduleTutDeco(delay) {
    if (decoTimer) return;
    decoTimer = setTimeout(() => { decoTimer = null; runTutDeco(); }, delay == null ? 250 : delay);
  }
  async function runTutDeco() {
    const tid = curTutId();
    if (!tid) { decoTries = 0; return; }
    const info = await tutInfo(tid);
    if (!info || curTutId() !== tid) return;
    if (info.goal && !SiErXing.pluginEnabled(info.goal, 'explain')) return;   // 组件关着就不插手
    const n = decorateTutorial(info);
    /* 正文 / iframe 可能还没画完：没编号就再来几轮（最多 8 次） */
    if (!n && decoTries < 8) { decoTries++; scheduleTutDeco(420); }
    else decoTries = 0;
  }
  function bindTutDeco() {
    if (decoBound) return;
    decoBound = true;
    window.addEventListener('hashchange', () => { decoTries = 0; scheduleTutDeco(80); });
    document.addEventListener('load', e => { if (e.target && e.target.id === 'tutFrame') scheduleTutDeco(200); }, true);
    try { new MutationObserver(() => { if (curTutId()) scheduleTutDeco(); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    scheduleTutDeco(300);
  }

  /* 右键菜单：复用应用既有的 .ctxMenu（点别处 / Esc / 滚动 / 换页都由它会自动收掉） */
  function showTutMenu(x, y, tid, n) {
    const info = tutInfoCache.get(Number(tid)) && tutInfoCache.get(Number(tid)).info;
    const b = info && info.blocks[n - 1];
    if (!b) return;
    const lines = String(b.code || '').split('\n').length;
    const el = document.createElement('div');
    el.className = 'ctxMenu exCtxMenu';
    el.setAttribute('role', 'menu');
    el.innerHTML = '<div class="ctxTitle">代码块 #' + n + (b.lang ? ' · ' + esc(String(b.lang).toUpperCase()) : '') + ' · ' + lines + ' 行</div>'
      + '<button type="button" data-exadd="1">🔍 看不懂？添加到「看懂代码」</button>'
      + '<button type="button" data-excopy="1">⧉ 复制代码</button>';
    document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
    document.body.appendChild(el);
    el.style.left = '0px'; el.style.top = '0px'; el.style.visibility = 'hidden';
    const w = el.offsetWidth || 240, h = el.offsetHeight || 90;
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    el.style.visibility = '';
    el.querySelector('[data-exadd]').addEventListener('click', () => { el.remove(); addTutBlock(tid, n); });
    el.querySelector('[data-excopy]').addEventListener('click', () => { el.remove(); copyText(b.code); });
  }
  function copyText(s) {
    const t = String(s || '');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove(); toast('已复制');
      } catch (e) { toast('复制失败，请手动选中复制'); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(() => toast('已复制'), fallback); return; }
    } catch (e) {}
    fallback();
  }
  /** 教程里点「添加到看懂代码」：建会话（AI 立刻开讲）→ 跳到讲解页打开它 */
  async function addTutBlock(tid, n) {
    const info = await tutInfo(tid);
    const b = info && info.blocks[n - 1];
    if (!b) return toast('这一段没找到，刷新教程页再试');
    if (!info.goal_id) return toast('这份教程还没有所属目标');
    try {
      const r = await api(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_id: info.goal_id, tutorial_id: tid, code: b.code,
          note: '教程《' + String(info.title || '').slice(0, 40) + '》· 代码块 #' + n
        })
      });
      pendingOpenSid = Number((r.session && r.session.id) || 0);
      toast('已送去讲解：AI 开始逐行讲这一块');
      location.hash = '#/t/' + tid + '/explain';
    } catch (e) { toast('添加失败：' + e.message); }
  }

  /* ---------- 注册 ---------- */
  SiErXing.registerPlugin({
    id: 'explain',
    goalEntry: {
      label: '看懂代码', icon: '🔍', order: 45,
      hash: gid2 => '#/g/' + gid2 + '/explain',
      show: goal => SiErXing.pluginEnabled(goal, 'explain')
    },
    routes: [
      {
        match: h => h.match(/^#\/t\/(\d+)\/explain$/),
        render: async m => {
          const t = Number(m[1]);
          if (explainVueEnabled()) {
            try { if (await renderExplainPageVue(t, 0)) return; }
            catch (e) { try { toast('看懂代码 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          await renderExplainPage(t);
        }
      },
      {
        match: h => h.match(/^#\/g\/(\d+)\/explain$/),
        render: async m => {
          const g = Number(m[1]);
          if (explainVueEnabled()) {
            try { if (await renderExplainPageVue(0, g)) return; }
            catch (e) { try { toast('看懂代码 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          await renderGoalExplainPage(g);
        }
      }
    ]
  });

  /* 教程页的代码块编号 / 右键菜单：组件自己认领，不依赖 app.js 调用 */
  try { bindTutDeco(); } catch (e) { console.warn('[explain] 教程代码块编号挂载失败', e); }
})();
