/**
 * 思而行 · 前端插件：模拟面试
 * ------------------------------------------------------------------
 * 一次面试 = 一份 JD + 一个项目 + 一串问答。
 *   · JD：在这个框里直接 Ctrl+V 粘贴截图（自动识别成文字），也可以贴文字
 *   · 项目：填一个本地路径，AI 只读读取后生成「面试官视角」的项目摘要
 *   · 面试：AI 当面试官一轮轮问，每答完当场点评（好在哪 / 漏了什么 / 哪里说反了）
 *   · 结束：总评 + 分数 + 该补的地方
 *
 * 布局沿用「用自己的话」的教训：状态钉在左边（考点清单 / 进度 / 项目摘要），
 * 对话在右边；点评跟在回答下面（那是别处没有的信息，不算重复）。
 */
'use strict';
(function () {
  const { api, esc, toast, mdToHTML } = SiErXing;

  /* ---------- Vue 版页面（渐进迁移；加载失败自动回退旧页面） ---------- */
  let interviewVueUnmount = null;
  function interviewVueEnabled() {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q === 'legacy') return false;
      if (q === 'vue') return true;
      const saved = localStorage.getItem('sierxing-ui-interview');
      if (saved === 'legacy') return false;
      if (saved === 'vue') return true;
    } catch (e) {}
    return false;   /* 默认原版界面（Vue 版仍在，?ui=vue 可体验）*/
  }
  function ensureInterviewVueCss() {
    if (document.querySelector('link[data-ui-page="interview"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui-dist/interview.css'; l.setAttribute('data-ui-page', 'interview');
    document.head.appendChild(l);
  }
  async function renderInterviewPageVue(goalId) {
    const root = document.getElementById('app');
    if (!root) throw new Error('页面容器不存在');
    if (interviewVueUnmount) { try { interviewVueUnmount(); } catch (e) {} interviewVueUnmount = null; }
    ensureInterviewVueCss();
    const mod = await import('/ui-dist/interview.js?v=' + Date.now());
    if (!mod || typeof mod.mountInterviewPage !== 'function') throw new Error('UI 插件没有导出 mountInterviewPage');
    interviewVueUnmount = mod.mountInterviewPage(root, { api: api, toast: toast, goalId: Number(goalId) || 0 });
    return true;
  }
  window.addEventListener('hashchange', function () {
    if (interviewVueUnmount && !/^#\/g\/\d+\/interview/.test(location.hash)) {
      try { interviewVueUnmount(); } catch (e) {}
      interviewVueUnmount = null;
    }
  });

  let gid = 0;
  let sessions = [];
  let cur = null;          // { session, turns }
  let view = 'setup';      // setup | run | report | list
  let busy = false;
  let busyMsg = '';
  let busyAt = 0;
  let timer = null;
  let pendingImgs = [];    // 还没提交的 JD 截图（data URL）

  /* ---------- 小工具 ---------- */
  /* 列表接口只回 status/score，不回整份 report —— 两个都要认，
     否则已经给过总评的面试在列表里还显示成「面试中」。 */
  const statusOf = s => {
    if (!s) return 'setup';
    if (s.status === 'done' || (s.report && Number(s.report.score) >= 0)) return 'done';
    if (Number(s.rounds) > 0 || s.status === 'running') return 'run';
    return 'setup';
  };
  function fmtTime(iso, withDate) {
    const d = new Date(String(iso || ''));
    if (isNaN(d.getTime())) return '';
    const p2 = n => String(n).padStart(2, '0');
    const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
    if (!withDate) return hm;
    const t = new Date();
    if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
  }
  const sessName = s => String((s && s.title) || '').trim() || (fmtTime(s && s.created_at, true) || '未命名面试');
  const statusTag = s => {
    const st = statusOf(s);
    return st === 'done' ? '<span class="rsTag ok">已结束</span>'
      : st === 'run' ? '<span class="rsTag act">面试中</span>' : '<span class="rsTag">准备中</span>';
  };
  const listOf = v => { if (Array.isArray(v)) return v; try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const objOf = v => { if (v && typeof v === 'object') return v; try { const o = JSON.parse(String(v || '{}')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } };
  const digestOf = s => objOf((s && s.project_digest) || '{}');
  const nf = n => { const x = Number(n); return Number.isFinite(x) ? x : 0; };
  function setBusy(on, msg) {
    busy = !!on; busyMsg = msg || '';
    if (on) {
      busyAt = Date.now();
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        const el = document.getElementById('ivBusyTxt');
        if (el) el.textContent = busyMsg + '（已等 ' + Math.round((Date.now() - busyAt) / 1000) + ' 秒）';
      }, 1000);
    } else if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------- 数据 ---------- */
  async function reload() {
    try {
      const r = await api('/api/interviews?goal_id=' + gid);
      sessions = r.sessions || [];
    } catch (e) { sessions = []; }
  }
  async function loadSession(id) {
    const r = await api('/api/interviews/' + id);
    cur = { session: r.session, turns: r.turns || [] };
    view = statusOf(r.session);
    if (view === 'setup' && !(listOf(r.session.plan) || []).length) view = 'setup';
  }
  async function newSession() {
    const r = await api('/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, max_rounds: 8 }) });
    cur = { session: r.session, turns: [] };
    pendingImgs = [];
    view = 'setup';
    await reload();
    draw();
  }
  /* 所有会改会话的动作都走这里：包一层 busy + 进度文案 + 错误提示 */
  async function act(msg, fn) {
    if (busy) return;
    setBusy(true, msg);
    draw();
    try {
      await fn();
      await reload();
    } catch (e) { toast(e.message); }
    setBusy(false);
    draw();
  }

  /* ---------- 页面 ---------- */
  function headHTML(title, extra) {
    return `<div class="jdHead">
      <a class="back" href="#/g/${gid}">← 返回目标</a>
      <span class="mapTitle">🎤 模拟面试</span>
      ${extra || ''}
      ${title ? `<span class="chip gray">${esc(title)}</span>` : ''}
    </div>`;
  }
  function draw() {
    if (!cur) { drawList(); return; }
    if (view === 'run') drawRun();
    else if (view === 'done') drawReport();
    else if (view === 'list') drawList();
    else drawSetup();
    if (view !== 'list') window.scrollTo(0, 0);
  }

  /* ---------- 会话列表 ---------- */
  function drawList() {
    app.innerHTML = `<div class="jdPage ivPage">
      ${headHTML('历史面试')}
      <div class="rsSec">
        <div class="rsSecT">做过 ${sessions.length} 场</div>
        <div class="toolbarRow" style="margin-top:8px;"><button class="btn primary" id="ivNew">＋ 新面试</button></div>
      </div>
      <div class="rsConvs">${sessions.length ? sessions.map(s => `
        <div class="rsConv${statusOf(s) === 'run' ? ' live' : ''}">
          <div class="rsConvHd">
            <span class="rsConvName">${esc(sessName(s))}</span>
            ${statusTag(s)}
            <span class="rsConvMeta">${Number(s.rounds) || 0} 轮${s.score >= 0 ? ' · ' + s.score + ' 分' : ''} · ${esc(fmtTime(s.updated_at || s.created_at, true))}
              ${s.has_jd ? ' · 有JD' : ''}${s.has_project ? ' · 有项目' : ''}${Number(s.remedied) ? ' · 📖补救 ' + s.remedied + ' 题' : ''}</span>
            <span class="rsConvActs">
              <button class="btn tiny primary" data-ivopen="${s.id}">${statusOf(s) === 'run' ? '继续' : '打开'}</button>
              <button class="btn tiny" data-ivedit="${s.id}" title="重命名">✏️</button>
              <button class="btn tiny" data-ivdel="${s.id}" title="删除">🗑</button>
            </span>
          </div>
        </div>`).join('') : '<p class="muted">还没有面试。点上面的「新面试」开始 —— 把 JD 截图粘进去就行。</p>'}
      </div>
    </div>`;
    document.getElementById('ivNew').addEventListener('click', () => act('正在新建…', newSession));
    app.querySelectorAll('[data-ivopen]').forEach(b => b.addEventListener('click', () => act('加载…', async () => { await loadSession(Number(b.getAttribute('data-ivopen'))); })));
    app.querySelectorAll('[data-ivedit]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-ivedit'));
      const s = sessions.find(x => Number(x.id) === id) || {};
      const v = prompt('给这场面试起个名字（留空 = 用时间当名字）', String(s.title || ''));
      if (v === null) return;
      try {
        await api('/api/interviews/' + id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v }) });
        await reload();
        if (cur && Number(cur.session.id) === id) cur.session.title = String(v || '').trim();
        draw();
      } catch (e) { toast(e.message); }
    }));
    app.querySelectorAll('[data-ivdel]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-ivdel'));
      const s = sessions.find(x => Number(x.id) === id) || {};
      if (!confirm('删掉这场面试？\n\n「' + sessName(s) + '」' + (Number(s.rounds) ? '（' + s.rounds + ' 轮问答）' : '') + '\n删了就找不回来了。')) return;
      try {
        await api('/api/interviews/' + id, { method: 'DELETE' });
        if (cur && Number(cur.session.id) === id) cur = null;
        await reload();
        if (sessions.length) view = 'list';
        draw();
        toast('已删除');
      } catch (e) { toast(e.message); }
    }));
  }

  /* ---------- 准备阶段 ---------- */
  function jdCardHTML(s) {
    const has = !!String(s.jd_text || '').trim();
    return `<div class="ivCard">
      <div class="ivCardHd"><span class="ivCardT">① 岗位 JD</span>
        ${has ? '<span class="ivOk">已识别</span>' : '<span class="ivNeed">还没给</span>'}
        ${has ? '<button class="btn tiny" id="ivJdRedo">重贴</button>' : ''}</div>
      <div class="ivCardBody">
        ${has
          ? `<div class="ivJdText mdBody">${mdToHTML(s.jd_text)}</div>`
          : `<div class="ivPaste" id="ivPaste" tabindex="0">
               <div class="ivPasteI">📋</div>
               <div><b>点这里，然后 Ctrl/⌘+V 粘贴招聘截图</b></div>
               <div class="muted">也支持直接粘贴文字；可拖入图片。截图由 AI 识别成文字，图片本身不保存。</div>
               <div class="muted">截图识别不了时，去「设置 → AI 接入 → 识图模型」换个支持看图的模型；或者直接贴文字，效果一样。</div>
             </div>`}
      </div>
    </div>`;
  }
  function projectCardHTML(s) {
    const d = digestOf(s);
    const has = !!String(s.project_path || '').trim();
    const files = listOf(s.project_files);
    return `<div class="ivCard">
      <div class="ivCardHd"><span class="ivCardT">② 你的项目<span class="muted">（可选，但强烈建议 —— 面试官会深挖这里）</span></span>
        ${has ? '<span class="ivOk">已读 ' + files.length + ' 个文件</span>' : ''}</div>
      <div class="ivCardBody">
        <div class="ivPathRow">
          <input class="ivInput" id="ivPath" placeholder="项目路径，例如 /home/you/my-project 或 ~/code/app" value="${esc(s.project_path || '')}">
          <button class="btn" id="ivRead">${has ? '重新读取' : '读取'}</button>
        </div>
        ${has ? `<div class="ivDigest">
            ${d.what ? `<p class="ivDigestWhat">${esc(d.what)}</p>` : ''}
            ${(d.stack || []).length ? `<div class="ivChips">${d.stack.map(x => '<span class="chip gray">' + esc(x) + '</span>').join('')}</div>` : ''}
            ${(d.modules || []).length ? `<div class="ivMods">${d.modules.map(m => '<div class="ivMod"><b>' + esc(m.name) + '</b><span>' + esc(m.what) + '</span></div>').join('')}</div>` : ''}
            ${(d.highlights || []).length ? `<div class="ivBlock"><div class="ivBlockT">💡 最值得聊的点</div><ul>${d.highlights.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>` : ''}
            ${(d.risks || []).length ? `<div class="ivBlock warn"><div class="ivBlockT">⚠️ 容易被问穿的地方</div><ul>${d.risks.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>` : ''}
          </div>` : '<p class="muted" style="margin:8px 0 0;">只读读取：.env / 密钥 / node_modules 一律不读，路径不会离开这台机器。</p>'}
      </div>
    </div>`;
  }
  function drawSetup() {
    const s = cur.session;
    const plan = listOf(s.plan);
    app.innerHTML = `<div class="jdPage ivPage">
      ${headHTML(sessName(s), '<span class="chip rsChipConv">' + esc(fmtTime(s.created_at, true)) + '</span>')}
      ${jdCardHTML(s)}
      ${projectCardHTML(s)}
      <div class="ivCard">
        <div class="ivCardHd"><span class="ivCardT">③ 开始</span>
          <label class="ivMax">问几轮 <input id="ivMax" type="number" min="3" max="15" value="${nf(s.max_rounds) || 8}"></label></div>
        <div class="ivCardBody">
          ${plan.length
            ? `<div class="ivPlanBox"><div class="ivBlockT">这次要覆盖的考点</div>
                 <div class="rsDimsRow">${plan.map(p => '<span class="rsDim" title="' + esc(p.why || '') + '">' + esc(p.name) + '</span>').join('')}</div>
                 ${s.focus ? '<p class="muted" style="margin:8px 0 0;">' + esc(s.focus) + '</p>' : ''}</div>
               <div class="toolbarRow"><button class="btn primary" id="ivStart">开始面试 →</button>
                 <button class="btn" id="ivPlanAgain">重列考点</button></div>`
            : `<div class="toolbarRow"><button class="btn primary" id="ivPlan">定考点</button>
                 <span class="muted">AI 会根据 JD 和项目列出这次面试要问什么</span></div>`}
        </div>
      </div>
      <div class="toolbarRow"><button class="btn" id="ivHist">历史面试（${sessions.length}）</button></div>
    </div>`;
    const paste = document.getElementById('ivPaste');
    if (paste) {
      paste.setAttribute('tabindex', '0');
      paste.addEventListener('click', () => paste.focus());
      paste.addEventListener('paste', e => {
        const items = ((e.clipboardData || {}).items) || [];
        const files = [];
        for (const it of items) {
          if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
        }
        if (files.length) { e.preventDefault(); sendJdImages(files); return; }
        const t = (e.clipboardData || {}).getData('text') || '';
        if (t.trim()) { e.preventDefault(); act('正在保存 JD…', () => sendJd({ text: t })); return; }
        toast('剪贴板里没有图片或文字');
      });
      paste.addEventListener('dragover', e => { e.preventDefault(); paste.classList.add('over'); });
      paste.addEventListener('dragleave', () => paste.classList.remove('over'));
      paste.addEventListener('drop', async e => {
        e.preventDefault(); paste.classList.remove('over');
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^image\//.test(f.type));
        if (files.length) sendJdImages(files); else toast('请拖入图片文件');
      });
    }
    const redo = document.getElementById('ivJdRedo');
    if (redo) redo.addEventListener('click', () => act('正在清空 JD…', async () => {
      const r = await api('/api/interviews/' + cur.session.id + '/jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) });
      cur.session = r.session; cur.turns = r.turns || [];
    }));
    const rd = document.getElementById('ivRead');
    if (rd) rd.addEventListener('click', () => {
      const p = String((document.getElementById('ivPath') || {}).value || '').trim();
      if (!p) return toast('先填项目路径');
      act('AI 正在读这个项目（几十秒）…', async () => {
        const r = await api('/api/interviews/' + cur.session.id + '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
        cur.session = r.session; cur.turns = r.turns || [];
        toast('读完了：' + (r.read || 0) + ' 个文件');
      });
    });
    const pl = document.getElementById('ivPlan');
    if (pl) pl.addEventListener('click', () => act('AI 正在定考点…', async () => {
      const r = await api('/api/interviews/' + cur.session.id + '/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      cur.session = r.session; cur.turns = r.turns || [];
    }));
    const pa = document.getElementById('ivPlanAgain');
    if (pa) pa.addEventListener('click', () => act('AI 正在重列考点…', async () => {
      const r = await api('/api/interviews/' + cur.session.id + '/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      cur.session = r.session; cur.turns = r.turns || [];
    }));
    const st = document.getElementById('ivStart');
    if (st) st.addEventListener('click', () => {
      const mx = nf((document.getElementById('ivMax') || {}).value) || 8;
      act('面试官正在问第一个问题…', async () => {
        const r = await api('/api/interviews/' + cur.session.id + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_rounds: mx }) });
        cur.session = r.session; cur.turns = r.turns || [];
        view = 'run';
      });
    });
    const hs = document.getElementById('ivHist');
    if (hs) hs.addEventListener('click', async () => { await reload(); view = 'list'; draw(); });
  }
  /* 图片：小图原样发（PNG 保清晰），大图缩到 1800px 再发（视觉模型不需要 4K） */
  function readAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = rej; r.readAsDataURL(file); });
  }
  async function fileToDataURL(file) {
    if (file.size < 1.2 * 1024 * 1024) return readAsDataURL(file);
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (e) { return readAsDataURL(file); }
  }
  async function sendJdImages(files) {
    if (busy) return;
    const arr = [];
    for (const f of files.slice(0, 4)) { try { arr.push(await fileToDataURL(f)); } catch (e) {} }
    if (!arr.length) return toast('图片读不出来，换一张试试');
    act('AI 正在识别 JD 截图（' + arr.length + ' 张）…', () => sendJd({ images: arr }));
  }
  async function sendJd(body) {
    const r = await api('/api/interviews/' + cur.session.id + '/jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    cur.session = r.session; cur.turns = r.turns || [];
  }

  /* ---------- 面试中 ---------- */
  function planHTML(s) {
    const plan = listOf(s.plan);
    const covered = listOf(s.covered);
    if (!plan.length) return '';
    return `<div class="rsDims">
      <div class="rsDimsHd"><span>考点清单</span>
        <span class="rsSub">${covered.length}/${plan.length} 问过</span></div>
      <div class="rsDimsRow">${plan.map(p => {
        const on = covered.indexOf(p.key) >= 0;
        return '<span class="rsDim' + (on ? ' on' : '') + '" title="' + esc((p.why || '') + (p.level ? '（' + p.level + '）' : '')) + '">'
          + (on ? '✓ ' : '') + esc(p.name) + '</span>';
      }).join('')}</div>
    </div>`;
  }
  function verdictHTML(v) {
    /* 注意：score 可能是 undefined/NaN（比如"我"那句刚乐观插入、AI 还没回），
       这时 `v.score < 0` 是 false —— 用 Number()>=0 判断才不会渲染出一个空盒子。 */
    const hasScore = Number(v && v.score) >= 0;
    if (!v || (!hasScore && !(v.good || []).length && !(v.missing || []).length && !(v.wrong || []).length && !v.note)) return '';
    return `<div class="ivFb">
      ${v.note ? `<div class="ivFbNote">${esc(v.note)}</div>` : ''}
      <div class="ivFbRow">
        ${hasScore ? `<span class="pfChip risk ${v.score >= 80 ? 'low' : v.score >= 60 ? 'mid' : 'high'}">${v.score} 分</span>` : ''}
        ${v.level ? `<span class="rsTag">${esc(v.level)}</span>` : ''}
        ${(v.good || []).map(x => '<span class="pfChip hit">✓ ' + esc(x) + '</span>').join('')}
        ${(v.missing || []).map(x => '<span class="pfChip miss">缺 ' + esc(x) + '</span>').join('')}
      </div>
      ${(v.wrong || []).length ? `<div class="ivFbWrong">${v.wrong.map(w => '<div><b>你说的</b>' + esc(w.said || '—') + ' <b>→ 正确</b>' + esc(w.right || '—') + '</div>').join('')}</div>` : ''}
    </div>`;
  }
  /* opts.lastAskId：当前正等着回答的那道题 —— 只有它有「不会，讲一下」。
     opts.retryable：讲解完还没答，可以「换个问法再问一遍」。 */
  function turnHTML(t, opts) {
    const o = opts || {};
    if (t.role === 'answer') {
      return `<div class="rsTurn">
        <div class="rsSay"><span class="rsWho">我</span><div class="rsBubble">${esc(t.text)}</div></div>
        ${verdictHTML(objOf(t.verdict))}
      </div>`;
    }
    if (t.role === 'explain') {
      return `<div class="rsTurn ivExplainTurn">
        <div class="rsTurnHd"><span class="rsTurnTag explain">📖 现场讲解</span>
          <span class="rsTurnTime">${esc(fmtTime(t.created_at))}</span></div>
        <div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody ivExplainBubble">${mdToHTML(t.text)}</div></div>
        ${o.retryable ? `<div class="ivExplainActs">
          <button class="btn tiny" data-ivretry="${t.id}">🔁 换个问法再问一遍</button>
          <span class="muted">或者直接用刚讲的思路，在下面回答这道题</span>
        </div>` : ''}
      </div>`;
    }
    /* ask */
    return `<div class="rsTurn">
      <div class="rsTurnHd"><span class="rsTurnTag ai">面试官</span>
        <span class="rsTurnTime">${esc(fmtTime(t.created_at))}</span>
        ${(o.canExplain && Number(t.id) === Number(o.lastAskId)) ? `<button class="ivAskWhy" data-ivexplain="${t.id}" title="不会就点这里：切到教学，把这道题讲明白，再让你答一遍">🤔 不会，讲一下</button>` : ''}</div>
      <div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody">${mdToHTML(t.text)}</div></div>
    </div>`;
  }
  function drawRun() {
    const s = cur.session;
    const turns = cur.turns || [];
    const d = digestOf(s);
    const asked = turns.filter(t => t.role === 'ask').length;
    const answered = turns.filter(t => t.role === 'answer').length;
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    /* 球在求职者这边：最后一条是问题，或者刚讲完（讲完就该他答了） */
    const waiting = !!lastTurn && (lastTurn.role === 'ask' || lastTurn.role === 'explain');
    const lastAsk = turns.slice().reverse().find(t => t.role === 'ask') || null;
    const canExplain = !!lastAsk && waiting && lastTurn.role === 'ask' && !busy;
    const retryable = !!lastTurn && lastTurn.role === 'explain' && !busy;
    app.innerHTML = `<div class="jdPage ivPage ivRunPage">
      ${headHTML(sessName(s), '<span class="chip rsChipConv">🎤 第 ' + Math.min(asked, nf(s.max_rounds)) + '/' + (nf(s.max_rounds) || 8) + ' 问</span>')}
      <div class="ivPanes">
        <aside class="ivPaneQ">
          <div class="rsPaneT">🧭 进度</div>
          <div class="ivPaneBody">
            ${planHTML(s)}
            ${s.focus ? '<p class="ivFocus">' + esc(s.focus) + '</p>' : ''}
            ${String(d.what || '').trim() ? `<details class="ivDigestFold"><summary>📦 你的项目（面试官已读过）</summary>
              <p>${esc(d.what)}</p>
              ${(d.highlights || []).length ? '<ul>' + d.highlights.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : ''}
              ${(d.risks || []).length ? '<div class="ivBlock warn"><div class="ivBlockT">⚠️ 容易被问穿</div><ul>' + d.risks.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : ''}
            </details>` : ''}
          </div>
          <div class="rsNav">
            <button class="btn tiny" id="ivReport" ${(answered && !busy) ? '' : 'disabled'} title="${answered ? '不等问完，现在就给总评' : '先答一轮'}">📊 给总评</button>
            <button class="btn tiny" id="ivSetupBack">⚙ 设置</button>
          </div>
          <div class="rsNavFoot"><button class="rsLink" id="ivHist2">← 历史面试（${sessions.length}）</button></div>
        </aside>
        <section class="ivPaneC">
          <div class="rsThread" id="ivThread">${turns.length ? turns.map(t => turnHTML(t, { lastAskId: lastAsk && lastAsk.id, canExplain, retryable })).join('') : '<div class="rsEmpty">面试还没开始</div>'}</div>
          ${busy ? `<div class="rsBusy" id="ivBusyTxt">${esc(busyMsg)}</div>` : ''}
          <div class="rsInput">
            <textarea id="ivSay" rows="3" placeholder="${lastTurn && lastTurn.role === 'explain' ? '用刚讲的思路回答这道题（也可以点上面「换个问法再问一遍」）' : '像真的面试一样回答（Ctrl/⌘+Enter 发送）。也可以反问面试官。'}" ${waiting ? '' : 'disabled'}></textarea>
            <div class="rsInputBtns">
              <button class="btn primary" id="ivSend" ${(!waiting || busy) ? 'disabled' : ''}>${busy ? '面试官在听…' : (waiting ? '回答' : '等面试官提问…')}</button>
              <span class="muted">${waiting ? '答完它当场点评，再问下一题' : ''}</span>
            </div>
          </div>
        </section>
      </div>
    </div>`;
    const ta = document.getElementById('ivSay');
    if (ta) {
      ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendAnswer(); } });
      setTimeout(() => ta.focus(), 30);
    }
    const sd = document.getElementById('ivSend');
    if (sd) sd.addEventListener('click', sendAnswer);
    /* 现场补救：不会 → 单独讲一遍（不计轮次，不算他答过） */
    app.querySelectorAll('[data-ivexplain]').forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-ivexplain'));
      act('面试官切到教学，正在把这道题讲明白…', async () => {
        const r = await api('/api/interviews/' + cur.session.id + '/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: id }) });
        cur.session = r.session; cur.turns = r.turns || [];
      });
    }));
    /* 讲完换个问法再问一遍 */
    app.querySelectorAll('[data-ivretry]').forEach(btn => btn.addEventListener('click', () => {
      act('正在换个问法…', async () => {
        const r = await api('/api/interviews/' + cur.session.id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        cur.session = r.session; cur.turns = r.turns || [];
      });
    }));
    const rp = document.getElementById('ivReport');
    if (rp) rp.addEventListener('click', () => act('面试官正在写总评…', async () => {
      const r = await api('/api/interviews/' + cur.session.id + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      cur.session = r.session; cur.turns = r.turns || [];
      view = 'done';
    }));
    const sb = document.getElementById('ivSetupBack');
    if (sb) sb.addEventListener('click', () => { view = 'setup'; draw(); });
    const h2 = document.getElementById('ivHist2');
    if (h2) h2.addEventListener('click', async () => { await reload(); view = 'list'; draw(); });
    const th = document.getElementById('ivThread');
    if (th) th.scrollTop = th.scrollHeight;
  }
  async function sendAnswer() {
    if (busy) return;
    const ta = document.getElementById('ivSay');
    const text = String((ta && ta.value) || '').trim();
    if (!text) return toast('先写下你的回答');
    /* 先把这句显示出来，别等 AI —— 面试要像真的，敲完就发 */
    cur.turns.push({ id: 0, role: 'answer', text, verdict: '{}', created_at: new Date().toISOString() });
    setBusy(true, '面试官正在听，然后点评并追问…');
    draw();
    try {
      const r = await api('/api/interviews/' + cur.session.id + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      cur.session = r.session; cur.turns = r.turns || [];
      if (r.done) { toast('问完了 —— 点「给总评」看整场评价'); }
    } catch (e) {
      toast(e.message);
      cur.turns = cur.turns.filter(t => t.id !== 0);
    }
    setBusy(false);
    await reload();
    draw();
  }

  /* ---------- 总评 ---------- */
  function drawReport() {
    const s = cur.session;
    const rp = objOf(s.report);
    const turns = cur.turns || [];
    app.innerHTML = `<div class="jdPage ivPage">
      ${headHTML(sessName(s), '<span class="chip rsChipConv">' + esc(fmtTime(s.updated_at || s.created_at, true)) + '</span>')}
      <div class="rsSec">
        <div class="ivScoreTop">
          <div class="ivScoreBig ${rp.score >= 80 ? 'good' : rp.score >= 60 ? 'mid' : 'bad'}">${rp.score >= 0 ? rp.score : '—'}<span>分</span></div>
          <div>
            <div class="ivScoreLv">${esc(rp.level || '')}</div>
            ${rp.verdict ? '<div class="ivScoreVd">' + esc(rp.verdict) + '</div>' : ''}
          </div>
        </div>
        ${rp.summary ? `<p class="ivSummary">${esc(rp.summary)}</p>` : ''}
      </div>
      ${(rp.strengths || []).length ? `<div class="rsSec"><div class="rsSecT">✅ 长处</div><div class="ivChips">${rp.strengths.map(x => '<span class="pfChip hit">' + esc(x) + '</span>').join('')}</div></div>` : ''}
      ${(rp.weak || []).length ? `<div class="rsSec"><div class="rsSecT">⚠️ 最该补的</div><div class="ivWeak">${rp.weak.map((x, i) => '<div class="ivWeakI"><b>' + (i + 1) + '</b><span>' + esc(x) + '</span></div>').join('')}</div></div>` : ''}
      ${(rp.advice || []).length ? `<div class="rsSec"><div class="rsSecT">🧭 下一步怎么补</div><ul class="ivAdvice">${rp.advice.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>` : ''}
      ${(s.remedied || []).length ? `<div class="rsSec"><div class="rsSecT">📖 现场补救过的（${s.remedied.length} 题）</div>
        <p class="muted" style="margin:0 0 8px;">这几道当场说不会、靠讲解才接住的 —— 不算真会，建议隔天自己再答一遍。</p>
        <div class="ivWeak">${s.remedied.map((x, i) => '<div class="ivWeakI"><b>' + (i + 1) + '</b><span>' + esc(x.asked || '（题目）') + '</span></div>').join('')}</div>
      </div>` : ''}
      <div class="rsSec">
        <div class="rsSecT">整场问答（${turns.filter(t => t.role === 'ask').length} 问）</div>
        <div class="rsThread">${turns.map(t => turnHTML(t, {})).join('')}</div>
      </div>
      <div class="toolbarRow">
        <button class="btn primary" id="ivAgain">再来一场</button>
        <button class="btn" id="ivHist3">历史面试（${sessions.length}）</button>
        <button class="btn" id="ivBackSetup">回到设置</button>
      </div>
    </div>`;
    document.getElementById('ivAgain').addEventListener('click', () => act('正在新建…', newSession));
    document.getElementById('ivHist3').addEventListener('click', async () => { await reload(); view = 'list'; draw(); });
    document.getElementById('ivBackSetup').addEventListener('click', () => { view = 'setup'; draw(); });
  }

  /* ---------- 路由 ---------- */
  async function renderPage(goal) {
    gid = Number(goal && goal.id) || 0;
    app.innerHTML = '<p class="muted">加载…</p>';
    await reload();
    const live = sessions.find(s => statusOf(s) === 'run') || sessions[0] || null;
    if (live) {
      try { await loadSession(live.id); } catch (e) { cur = null; }
    } else { cur = null; view = 'list'; }
    draw();
  }

  SiErXing.registerPlugin({
    id: 'interview',
    goalEntry: {
      label: '模拟面试', icon: '🎤', order: 46, header: true,
      hash: g => '#/g/' + g + '/interview',
      show: goal => SiErXing.pluginEnabled(goal, 'interview')
    },
    routes: [
      {
        match: h => h.match(/^#\/g\/(\d+)\/interview$/),
        render: async m => {
          const gid0 = Number(m[1]);
          if (interviewVueEnabled()) {
            try { if (await renderInterviewPageVue(gid0)) return; }
            catch (e) { try { toast('模拟面试 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          const goal = await SiErXing.loadGoal(gid0);
          await renderPage(goal || { id: gid0 });
        }
      }
    ]
  });
})();
