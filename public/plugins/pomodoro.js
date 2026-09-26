'use strict';
/**
 * 思而行 · 前端扩展组件：番茄钟
 * ------------------------------------------------------------------
 * 右下角悬浮窗（可拖动、可折叠成小圆标），在任何页面都可见；
 * 专注 / 休息时长可设，手动开始、暂停、继续、结束，不自动循环；
 * 时间到：应用内弹窗 + 系统通知 + 提示音 + 标题闪烁，
 * 即使切到别的标签页（如刷视频）也能收到提醒。
 * 计时锚定绝对时间戳，后台节流、睡眠唤醒都不会漂移；状态存 localStorage，
 * 刷新页面后进行中的计时可恢复。
 */
(function () {
  const toast = (...a) => { try { (SiErXing.toast || window.toast || console.log)(...a); } catch (e) {} };
  const LS = 'sierxing-pomodoro';
  const DAY = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

  const DEF = { focusMin: 25, breakMin: 5, phase: 'focus', running: false, deadline: 0, remaining: 25 * 60000, collapsed: false, right: 18, bottom: 18, doneToday: 0, dayStamp: DAY(), sound: true, notify: true, bindNodeId: 0, bindTitle: '', bindGoalId: 0, auto: true };

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { s = {}; }
    const st = Object.assign({}, DEF, s);
    if (st.dayStamp !== DAY()) { st.dayStamp = DAY(); st.doneToday = 0; }
    st.focusMin = clampMin(st.focusMin, DEF.focusMin);
    st.breakMin = clampMin(st.breakMin, DEF.breakMin);
    return st;
  }
  function clampMin(v, fb) { v = Math.round(Number(v)); return (v >= 1 && v <= 180) ? v : fb; }
  let S = load();
  function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }
  // 刷新后恢复：如果上次 running，本轮 tick 会按 deadline 继续（已超时则直接结算）
  if (!S.running) S.remaining = Math.max(0, Math.min(S.remaining || phaseLen(S.phase), phaseLen(S.phase)));

  function enabled() { try { return typeof compOn === 'function' ? compOn('pomodoro') !== false : true; } catch (e) { return true; } }
  function phaseLen(phase) { return (phase === 'break' ? S.breakMin : S.focusMin) * 60000; }
  function remainMs() { return S.running ? Math.max(0, S.deadline - Date.now()) : Math.max(0, S.remaining); }
  function fmt(ms) {
    const s = Math.ceil(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  /* ---------------- 提醒：弹窗 + 系统通知 + 提示音 + 标题闪烁 ---------------- */
  let audioCtx = null;
  function beep() {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const seq = [880, 880, 880, 1174];
      seq.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = audioCtx.currentTime + i * 0.28;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.25);
      });
    } catch (e) {}
  }
  function notify(title, body) {
    if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag: 'sierxing-pomo', requireInteraction: true });
      n.onclick = () => { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) {}
  }
  let flashTimer = null, origTitle = null;
  function flashTitle(on) {
    stopFlash();
    if (!on) return;
    try {
      origTitle = document.title;
      let alt = false;
      flashTimer = setInterval(() => { document.title = alt ? origTitle : '⏰ 时间到！——' + origTitle; alt = !alt; }, 1000);
    } catch (e) {}
  }
  function stopFlash() {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (origTitle != null) { try { document.title = origTitle; } catch (e) {} origTitle = null; }
  }

  /* ---------------- 计时核心 ---------------- */
  let finished = false;   // 本轮是否已结算（防重复触发）
  let autoPaused = false; // 系统自动暂停的（切出教程/久无滚动）：滚动回来可自动继续
  let runRoute = null; // 本轮跑起来时所在的页面：只有从教程页切走才自动暂停
  let awayMode = false;   // 切出应用后的休息计时中（回来前一直记休息）
  let awaySaved = null;   // 切出时暂存的专注轮次 { remaining }，回来恢复
  let awayStartAt = 0;    // 本次切出休息开始的时间戳，用来算“已休息多久”
  let awayInfoModal = false; // 当前弹窗只是“已开始休息”告知，点“知道了”不碰计时
  let pauseReason = '';   // 自动暂停原因展示
  let lastScrollAt = Date.now();
  function start(phase) {
    S.phase = (phase === 'break') ? 'break' : 'focus';
    S.remaining = phaseLen(S.phase);
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    finished = false;
    autoPaused = false; pauseReason = '';
    runRoute = location.hash || '#/';
    awayMode = false; awaySaved = null; awayInfoModal = false; awayStartAt = 0;
    closeModal();
    stopFlash();
    save(); render();
  }
  function pause() {
    if (!S.running) return;
    S.remaining = remainMs();
    S.running = false;
    S.deadline = 0;
    awayMode = false; awaySaved = null; awayStartAt = 0;   // 手动接管：切屏休息模式一并结束
    save(); render();
    flushStats();
  }
  /* 系统自动暂停（切出教程页 / 1 分钟没滚动）：不锁死，滚动回来自动继续 */
  function autoPause(reason) {
    if (!S.running) return;
    pause(false);
    autoPaused = true;
    pauseReason = reason;
    save(); render();
  }
  function resume() {
    if (S.running || S.remaining <= 0) return;
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    autoPaused = false; pauseReason = '';
    runRoute = location.hash || '#/';
    save(); render();
  }
  function stop() {
    S.running = false;
    S.deadline = 0;
    S.remaining = phaseLen(S.phase);
    finished = false;
    autoPaused = false; pauseReason = '';
    runRoute = null;
    awayMode = false; awaySaved = null; awayInfoModal = false; awayStartAt = 0;
    closeModal();
    stopFlash();
    save(); render();
    toast('🍅 已结束计时');
    flushStats();
  }
  /* 休息结束 → 继续休息：在现有余量上再加一段休息时长，到点再弹窗 */
  function extendBreak() {
    if (S.phase !== 'break') return;
    S.remaining = Math.min(S.remaining + S.breakMin * 60000, 180 * 60000);
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    finished = false;
    closeModal();
    stopFlash();
    save(); render();
    toast('☕ 继续休息 ' + S.breakMin + ' 分钟');
  }
  /* 把暂停/结束/完成那一刻的零头立刻记上，不用等下一轮心跳 */
  function flushStats() { try { if (window.StudyStats && typeof window.StudyStats.flush === 'function') window.StudyStats.flush(); } catch (e) {} }
  function complete() {
    if (finished) return;
    finished = true;
    awayMode = false; awayInfoModal = false; awayStartAt = 0;
    const was = S.phase;
    S.running = false;
    S.deadline = 0;
    S.remaining = 0;
    if (was === 'focus') {
      if (S.dayStamp !== DAY()) { S.dayStamp = DAY(); S.doneToday = 0; }
      S.doneToday++;
    }
    save();
    flushStats();   // 最后一段零头立刻记（不然暂停/结束那一下的十几秒就丢了）
    beep();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    flashTitle(true);
    if (was === 'focus') {
      notify('🍅 专注结束！', `你专注了 ${S.focusMin} 分钟，起来活动一下、看看远方吧。`);
      showModal('focus');
    } else {
      notify('☕ 休息结束！', `休息了 ${S.breakMin} 分钟，回来继续学习吧。`);
      showModal('break');
    }
    render();
  }

  /* ---------------- 界面 ---------------- */
  function el(id) { return document.getElementById(id); }
  function mount() {
    if (el('pomoRoot')) return;
    const root = document.createElement('div');
    root.id = 'pomoRoot';
    root.innerHTML =
      `<button id="pomoBadge" class="pomoBadge" title="番茄钟（点击展开）"><span id="pomoBadgeTime">25:00</span><span id="pomoBadgeDot" class="pomoDot"></span></button>` +
      `<div id="pomoPanel" class="pomoPanel">` +
        `<div id="pomoHead" class="pomoHead"><span>🍅 番茄钟</span><span id="pomoToday" class="pomoToday"></span><div class="spacer"></div>` +
        `<button id="pomoBell" class="pomoIconBtn" title="系统通知：切到别的标签页也能收到到点提醒，点我授权">🔕</button>` +
        `<button id="pomoCollapse" class="pomoIconBtn" title="折叠成小圆标">—</button></div>` +
        `<div class="pomoModes"><button id="pomoModeFocus" class="pomoMode">🎯 专注</button><button id="pomoModeBreak" class="pomoMode">☕ 休息</button></div>` +
        `<div id="pomoClock" class="pomoClock">25:00</div>` +
        `<div class="pomoBar"><div id="pomoFill" class="pomoFill"></div></div>` +
        `<div id="pomoStatus" class="pomoStatus">待开始</div>` +
        `<button id="pomoBind" class="pomoBind" title="绑定节点：专注时间全部记到该节点（在哪页都一样）；点我更换"></button>` +
        `<div class="pomoRows"><label>专注 <input id="pomoFocusMin" type="number" min="1" max="180" step="1"> 分钟</label>` +
        `<label>休息 <input id="pomoBreakMin" type="number" min="1" max="180" step="1"> 分钟</label></div>` +
        `<div class="pomoBtns"><button id="pomoMain" class="btn small primary">开始专注</button><button id="pomoStop" class="btn small">结束</button><a id="pomoStats" class="btn small" href="#/studystats" title="学习统计：按天/按节点看学了多久">📊</a></div>` +
        `<button id="pomoAuto" class="pomoAuto" title="开着时：滚动教程自动开始专注，切出教程/1分钟没滚动自动暂停"></button>` +
        `<div class="pomoHint">时间到会弹窗 + 系统通知 + 提示音，切页面、刷视频也能收到</div>` +
      `</div>` +
      `<div id="pomoModalWrap" class="pomoModalWrap" hidden><div class="pomoModal">` +
        `<div id="pomoModalIcon" class="pomoModalIcon">🍅</div>` +
        `<div id="pomoModalTitle" class="pomoModalTitle"></div>` +
        `<div id="pomoModalDesc" class="pomoModalDesc"></div>` +
        `<div class="pomoModalBtns"><button id="pomoModalGo" class="btn primary"></button><button id="pomoModalMore" class="btn" hidden></button><button id="pomoModalLater" class="btn">稍后</button></div>` +
      `</div></div>` +
      `<div id="pomoPickWrap" class="pomoModalWrap" hidden><div class="pomoModal pomoPick">` +
        `<div class="pomoModalTitle">📌 绑定节点</div>` +
        `<div class="pomoModalDesc">绑后专注时间全部记到该节点（在哪页都一样），与统计页同步；清空则回到按打开的教程记。</div>` +
        `<div id="pomoPickCur"></div>` +
        `<input id="pomoPickQ" placeholder="🔍 搜节点标题…" autocomplete="off">` +
        `<div id="pomoPickList" class="pomoPickList"></div>` +
        `<div class="pomoModalBtns"><button id="pomoPickUnbind" class="btn">解绑</button><button id="pomoPickClose" class="btn primary">关闭</button></div>` +
      `</div></div>`;
    document.body.appendChild(root);
    el('pomoCollapse').addEventListener('click', () => { S.collapsed = true; save(); render(); });
    el('pomoBell').addEventListener('click', async () => {
      try {
        if (!('Notification' in window)) { toast('当前浏览器不支持系统通知'); return; }
        const p = await Notification.requestPermission();
        render();
        toast(p === 'granted' ? '🔔 通知已开启：切走也能收到提醒' : '通知未授权，到点只有应用内弹窗和提示音');
      } catch (e) {}
    });
    el('pomoModeFocus').addEventListener('click', () => selectPhase('focus'));
    el('pomoModeBreak').addEventListener('click', () => selectPhase('break'));
    el('pomoMain').addEventListener('click', onMain);
    el('pomoStop').addEventListener('click', () => stop());
    el('pomoFocusMin').addEventListener('change', onDur);
    el('pomoBreakMin').addEventListener('change', onDur);
    el('pomoAuto').addEventListener('click', () => { S.auto = !S.auto; save(); render(); toast(S.auto ? '🤖 读教程自动计时：开' : '🤖 读教程自动计时：关'); });
    el('pomoModalLater').addEventListener('click', () => {
      if (awayInfoModal) { awayInfoModal = false; closeModal(); stopFlash(); render(); return; }  // 只是知道了，休息继续记
      S.remaining = phaseLen(S.phase); finished = false; closeModal(); stopFlash(); save(); render();
    });
    el('pomoModalGo').addEventListener('click', () => {
      const next = modalFor === 'focus' ? 'break' : 'focus';
      start(next);
    });
    el('pomoModalMore').addEventListener('click', () => extendBreak());
    el('pomoBind').addEventListener('click', async e => {
      if (e.target.closest && e.target.closest('.pomoUnbind')) { await setBind(0); return; }
      openPicker();
    });
    el('pomoPickClose').addEventListener('click', closePicker);
    el('pomoPickUnbind').addEventListener('click', async () => { await setBind(0); closePicker(); });
    let pickTm = null;
    el('pomoPickQ').addEventListener('input', () => {
      clearTimeout(pickTm);
      pickTm = setTimeout(searchPick, 300);
    });
    bindDrag();
    applyPos();
    render();
  }
  function unmount() {
    stopFlash();
    const r = el('pomoRoot');
    if (r) r.remove();
  }
  let modalFor = null;
  function showModal(was) {
    modalFor = was;
    awayInfoModal = false;
    const w = el('pomoModalWrap');
    if (!w) return;
    el('pomoModalGo').hidden = false;
    el('pomoModalLater').textContent = '稍后';
    if (was === 'focus') {
      el('pomoModalIcon').textContent = '🍅';
      el('pomoModalTitle').textContent = '专注结束，好好休息一下！';
      el('pomoModalDesc').textContent = `你刚专注了 ${S.focusMin} 分钟。建议起来走走、喝口水。准备好就开始 ${S.breakMin} 分钟休息（手动开始，不会自动计时）。`;
      el('pomoModalGo').textContent = `开始休息（${S.breakMin} 分钟）▶`;
      el('pomoModalMore').hidden = true;
    } else {
      el('pomoModalIcon').textContent = '☕';
      el('pomoModalTitle').textContent = '休息结束，开工！';
      el('pomoModalDesc').textContent = `休息了 ${S.breakMin} 分钟。回来继续学 ${S.focusMin} 分钟（手动开始），或者再休息一段。`;
      el('pomoModalGo').textContent = `开始专注（${S.focusMin} 分钟）▶`;
      const more = el('pomoModalMore');
      more.textContent = `继续休息（${S.breakMin} 分钟）`;
      more.hidden = false;
    }
    w.hidden = false;
  }
  function closeModal() { const w = el('pomoModalWrap'); if (w) w.hidden = true; modalFor = null; awayInfoModal = false; }
  /* 切出应用时的告知弹窗：计时不受影响，点“知道了”继续记 */
  function showAwayModal() {
    modalFor = null;
    awayInfoModal = true;
    const w = el('pomoModalWrap');
    if (!w) return;
    el('pomoModalIcon').textContent = '📵';
    el('pomoModalTitle').textContent = '开始休息计时了';
    el('pomoModalDesc').textContent = `检测到你切出了教程页，休息计时中（${S.breakMin} 分钟，到点会再提醒）。只要没切回教程页就持续计时；回来自动恢复专注。`;
    el('pomoModalGo').hidden = true;
    el('pomoModalMore').hidden = true;
    el('pomoModalLater').textContent = '知道了，继续休息';
    w.hidden = false;
  }

  /* ---- 绑定选择器 ---- */
  async function openPicker() {
    const w = el('pomoPickWrap');
    if (!w) return;
    el('pomoPickQ').value = '';
    w.hidden = false;
    // 快捷：当前教程节点
    const cur = el('pomoPickCur');
    cur.innerHTML = '';
    try {
      const m = (location.hash || '').match(/^#\/t\/(\d+)$/);
      if (m) {
        const r = await fetch('/api/tutorials/' + Number(m[1])).then(x => x.json()).catch(() => null);
        if (r && r.node) {
          const b = document.createElement('button');
          b.className = 'btn small primary pomoPickCurBtn';
          b.textContent = '绑定当前：' + String(r.node.title || '').slice(0, 20);
          b.addEventListener('click', async () => { if (await setBind(r.node.id)) closePicker(); });
          cur.appendChild(b);
        }
      }
    } catch (e) {}
    // 最近学过的节点
    await searchPick(true);
  }
  function closePicker() { const w = el('pomoPickWrap'); if (w) w.hidden = true; }
  async function searchPick(recent) {
    const list = el('pomoPickList');
    if (!list) return;
    const q = el('pomoPickQ').value.trim();
    list.innerHTML = '<div class="muted">搜索中…</div>';
    try {
      const url = q ? '/api/study/nodes?q=' + encodeURIComponent(q) + '&limit=20' : '/api/study/nodes?limit=10';
      const r = await fetch(url).then(x => x.json());
      const nodes = (r && r.nodes) || [];
      list.innerHTML = nodes.length
        ? nodes.map(n => `<button class="pomoPickItem" data-nid="${n.node_id}"><span class="pomoPickT">${escPick(n.node_title)}</span><span class="chip gray">${escPick(n.goal_title || '')}</span></button>`).join('')
        : `<div class="muted">${q ? '没找到，换个关键词试试' : '还没有学习记录，搜节点标题绑定'}</div>`;
      list.querySelectorAll('[data-nid]').forEach(b => b.addEventListener('click', async () => {
        if (await setBind(Number(b.getAttribute('data-nid')))) closePicker();
      }));
    } catch (e) { list.innerHTML = '<div class="muted">加载失败</div>'; }
  }
  function escPick(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function selectPhase(p) {
    if (S.running) return;
    S.phase = p;
    S.remaining = phaseLen(p);
    finished = false;
    save(); render();
  }
  /* 绑定节点：专注秒数全部记到该节点（在哪页都一样）；0 = 解绑，回到按打开的教程记 */
  async function setBind(nodeId, silent) {
    nodeId = Number(nodeId) || 0;
    if (!nodeId) {
      S.bindNodeId = 0; S.bindTitle = ''; S.bindGoalId = 0;
      save(); render();
      if (!silent) toast('📌 已解绑：回到按打开的教程记');
      return true;
    }
    try {
      const x = await fetch('/api/study/nodes?id=' + nodeId);
      const r = await x.json().catch(() => ({}));
      if (!x.ok || !r || !r.node) throw new Error((r && r.error) || '节点不存在');
      S.bindNodeId = r.node.node_id; S.bindTitle = r.node.node_title; S.bindGoalId = r.node.goal_id;
      save(); render();
      if (!silent) toast('📌 已绑定：' + S.bindTitle);
      return true;
    } catch (e) { if (!silent) toast(e.message || '绑定失败'); return false; }
  }
  async function onMain() {
    if (S.running) { pause(); return; }
    // 开始 / 继续都需要用户手势：顺手申请通知权限 + 解锁音频（都加超时，防个别环境卡死导致按钮没反应）
    const timeout = ms => new Promise(r => setTimeout(r, ms));
    try { if ('Notification' in window && Notification.permission === 'default') await Promise.race([Notification.requestPermission(), timeout(3000)]); } catch (e) {}
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') await Promise.race([audioCtx.resume(), timeout(3000)]); } catch (e) {}
    if (S.remaining > 0 && S.remaining < phaseLen(S.phase)) resume();
    else {
      // 在教程页手动开专注：同样先绑定，统计才跟得上
      if (S.phase === 'focus' && onTutorialRoute()) await autoBindCurrentTutorial();
      start(S.phase);
    }
  }
  function onDur() {
    if (S.running) { render(); return; }
    S.focusMin = clampMin(el('pomoFocusMin').value, S.focusMin);
    S.breakMin = clampMin(el('pomoBreakMin').value, S.breakMin);
    S.remaining = phaseLen(S.phase);
    finished = false;
    save(); render();
  }
  function applyPos() {
    const r = el('pomoRoot');
    if (r) { r.style.right = Math.max(8, S.right || 18) + 'px'; r.style.bottom = Math.max(8, S.bottom || 18) + 'px'; }
  }
  function bindDrag() {
    const head = el('pomoHead'), badge = el('pomoBadge');
    let badgeDragAt = 0;
    const startDrag = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, r0 = S.right, b0 = S.bottom;
      const move = ev => {
        S.right = Math.max(8, Math.min(window.innerWidth - 60, r0 + (sx - ev.clientX)));
        S.bottom = Math.max(8, Math.min(window.innerHeight - 60, b0 + (sy - ev.clientY)));
        applyPos();
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
    if (head) head.addEventListener('mousedown', e => startDrag(e));
    if (badge) {
      // 徽标可拖动：用时间戳区分“拖”与“点”，拖完不触发展开
      badge.addEventListener('click', () => {
        if (Date.now() - badgeDragAt < 350) return;
        S.collapsed = false; save(); render();
      });
      badge.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY, r0 = S.right, b0 = S.bottom;
        let dragged = false;
        const move = ev => {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) dragged = true;
          if (!dragged) return;
          S.right = Math.max(8, Math.min(window.innerWidth - 60, r0 + (sx - ev.clientX)));
          S.bottom = Math.max(8, Math.min(window.innerHeight - 60, b0 + (sy - ev.clientY)));
          applyPos();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (dragged) { badgeDragAt = Date.now(); save(); }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
  }

  function render() {
    const root = el('pomoRoot');
    if (!root) return;
    const ms = remainMs();
    const total = phaseLen(S.phase);
    // 空闲且余量为 0（如刚结束一轮）时显示整段时间，避免 00:00 待开始的怪异感
    const show = (S.running || ms > 0) ? ms : total;
    const badge = el('pomoBadge'), panel = el('pomoPanel');
    badge.style.display = S.collapsed ? '' : 'none';
    panel.style.display = S.collapsed ? 'none' : '';
    el('pomoBadgeTime').textContent = fmt(ms);
    el('pomoBadgeDot').className = 'pomoDot ' + (S.running ? (S.phase === 'break' ? 'brk run' : 'foc run') : 'idle');
    badge.title = S.running ? (S.phase === 'break' ? '休息中，点击展开' : '专注中，点击展开') : '番茄钟（点击展开）';
    el('pomoClock').textContent = fmt(show);
    el('pomoClock').className = 'pomoClock ' + (S.running ? S.phase : 'idle') + (S.running && show < 60000 ? ' urgent' : '');
    el('pomoFill').style.width = (total > 0 ? Math.max(0, Math.min(100, (total - show) / total * 100)) : 0) + '%';
    el('pomoFill').className = 'pomoFill ' + S.phase;
    el('pomoModeFocus').classList.toggle('active', S.phase !== 'break');
    el('pomoModeBreak').classList.toggle('active', S.phase === 'break');
    const st = el('pomoStatus');
    const rec = (S.bindNodeId && S.running && S.phase === 'focus') ? (' · 记到「' + String(S.bindTitle || '').slice(0, 12) + '」') : '';
    if (S.running) st.textContent = (S.phase === 'break' ? '☕ 休息中' : '🎯 专注中') + ' · 今日专注 ' + S.doneToday + ' 次' + rec;
    else if (ms > 0 && ms < total) st.textContent = '⏸ 已暂停' + (pauseReason ? '（' + pauseReason + '）' : '') + ' · 点击继续';
    else st.textContent = '待开始 · 今日专注 ' + S.doneToday + ' 次';
    el('pomoAuto').textContent = S.auto ? '🤖 读教程自动计时：开' : '🤖 读教程自动计时：关';
    el('pomoAuto').classList.toggle('off', !S.auto);
    try {
      const bell = el('pomoBell');
      const perm = ('Notification' in window) ? Notification.permission : 'denied';
      bell.textContent = perm === 'granted' ? '🔔' : '🔕';
      bell.title = perm === 'granted' ? '系统通知已开启' : '系统通知：切到别的标签页也能收到到点提醒，点我授权';
    } catch (e) {}
    // 绑定行：记到哪一目了然
    const bd = el('pomoBind');
    if (S.bindNodeId) {
      bd.innerHTML = `📌 <span class="pomoBindT">${escPick(S.bindTitle || ('节点 ' + S.bindNodeId))}</span><span class="pomoUnbind" title="解绑">×</span>`;
      bd.classList.add('on');
    } else {
      bd.textContent = '📌 未绑定（按打开的教程记）';
      bd.classList.remove('on');
    }
    el('pomoToday').textContent = S.doneToday ? ('今日 ' + S.doneToday + '🍅') : '';
    const main = el('pomoMain');
    main.textContent = S.running ? '⏸ 暂停' : (ms > 0 && ms < total ? '▶ 继续' : (S.phase === 'break' ? '开始休息' : '开始专注'));
    // 学习统计组件关闭时隐藏 📊 入口
    try { el('pomoStats').style.display = (typeof compOn === 'function' && compOn('studystats') === false) ? 'none' : ''; } catch (e) {}
    const dis = S.running;
    el('pomoFocusMin').disabled = dis;
    el('pomoBreakMin').disabled = dis;
    el('pomoModeFocus').disabled = dis;
    el('pomoModeBreak').disabled = dis;
    if (document.activeElement !== el('pomoFocusMin')) el('pomoFocusMin').value = S.focusMin;
    if (document.activeElement !== el('pomoBreakMin')) el('pomoBreakMin').value = S.breakMin;
  }

  /* ---------------- 读教程自动计时 ----------------
   * 教程页上下滚动 = 在学：暂停的半截直接继续，否则开新专注；
   * 切出教程页 / 1 分钟没滚动 → 自动暂停，回来滚动自动继续；
   * 手动点的暂停只是停住这一秒，下一次滚动就继续（想彻底停就点结束或关自动）。 */
  function onTutorialRoute() { return /^#\/t\/(\d+)$/.test(location.hash || ''); }
  function tutorialId() { const m = (location.hash || '').match(/^#\/t\/(\d+)$/); return m ? Number(m[1]) : 0; }
  window.addEventListener('scroll', () => {
    try {
      lastScrollAt = Date.now();
      if (onTutorialRoute()) maybeAutoStart();
    } catch (e) {}
  }, { passive: true });
  window.addEventListener('hashchange', () => {
    try {
      lastScrollAt = Date.now();
      autoPaused = false; pauseReason = '';
      // 切到别的教程页：自动绑的旧节点清掉（暂停的半截留着，滚一下就按新节点继续）
      if (onTutorialRoute() && !S.running && S.bindAuto) {
        S.bindNodeId = 0; S.bindTitle = ''; S.bindGoalId = 0; S.bindAuto = false;
        save();
      }
      if (el('pomoRoot')) render();
    } catch (e) {}
  });
  /* 在教程页开始专注时顺手绑定当前节点（手动点开始也一样），统计才跟得上 */
  async function autoBindCurrentTutorial() {
    try {
      const tid = tutorialId();
      if (!(tid > 0) || S.bindNodeId || S.running) return;
      const r = await fetch('/api/tutorials/' + tid).then(x => x.json()).catch(() => null);
      if (r && r.node && !S.running) {
        S.bindNodeId = r.node.id; S.bindTitle = r.node.title || ''; S.bindGoalId = r.node.goal_id || 0; S.bindAuto = true;
        save(); render();
      }
    } catch (e) {}
  }
  async function maybeAutoStart() {
    try {
      if (!S.auto || S.running) return;
      if (!onTutorialRoute()) return;
      if (el('pomoModalWrap') && !el('pomoModalWrap').hidden) return;   // 刚播完提醒，等用户选
      if (!enabled()) return;
      // 专注剩半截：直接继续（暂停就是暂时的，滚动=回来学了）
      if (S.phase === 'focus' && S.remaining > 0 && S.remaining < phaseLen('focus')) { resume(); return; }
      // 其他情况一律开新专注：上一轮是休息/休息半截也不沿用，滚动教程=回来学习
      if (S.phase !== 'focus') { S.phase = 'focus'; save(); }
      await autoBindCurrentTutorial();
      if (S.running) return;
      start('focus');
      toast('🍅 检测到阅读，已开始专注' + (S.bindTitle ? '（记到「' + S.bindTitle.slice(0, 16) + '」）' : ''));
    } catch (e) {}
  }
  function autoWatch() {
    if (!S.auto || !S.running) return;
    if (awayMode) return;   // 切出应用后的休息计时：回来前一直记，不暂停
    if (document.visibilityState === 'hidden') return;   // 藏起来的标签页不动它，交给 visibility 逻辑
    if (el('pomoModalWrap') && !el('pomoModalWrap').hidden) return;
    const cur = location.hash || '#/';
    if (runRoute == null) runRoute = cur;
    if (cur !== runRoute) {
      // 跑着跑着换了页面：只有从教程页切走才暂停（在那读的书，离开=不读了）
      const leftTut = /^#\/t\/(\d+)$/.test(runRoute || '');
      runRoute = cur;
      if (leftTut) { autoPause('切换页面'); return; }
    }
    if (onTutorialRoute() && Date.now() - lastScrollAt > 60000) autoPause('1 分钟没滚动');
  }
  /* 切出应用（标签不可见，如去刷视频）：专注转休息一直记，回来自动恢复专注。
   * 注意：只要标签藏起来就转，不要求计时是在教程页开始的——看不见页面就不算在学。 */
  function convertToAwayRest() {
    if (!S.auto || awayMode) return;
    if (!enabled()) return;
    if (S.running) {
      if (S.phase !== 'focus') return;   // 已经在休息就让它跑着
      flushStats();   // 先把专注零头结算了，再转休息
      awaySaved = { remaining: S.remaining };
    } else {
      // 暂停在半截：专注半截留档待恢复；休息半截就地继续；空闲不动
      if (!(S.remaining > 0 && S.remaining < phaseLen(S.phase))) return;
      if (S.phase === 'focus') awaySaved = { remaining: S.remaining };
    }
    awayMode = true;
    awayStartAt = Date.now();
    S.phase = 'break';
    if (!(S.remaining > 0 && S.remaining < phaseLen('break'))) S.remaining = phaseLen('break');
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    finished = false;
    autoPaused = false; pauseReason = '';
    save();
    beep();
    notify('📵 开始休息计时', '检测到你切出了教程页，休息计时中（' + S.breakMin + ' 分钟，到点提醒）。切回教程页自动恢复专注。');
    showAwayModal();
    render();
  }
  /* 切出休息中每满一段（休息时长）报一次：告诉已休息多久，没回来就自动续下一段 */
  function awayCheckpoint() {
    if (!awayMode || !S.running || S.phase !== 'break') return;
    const mins = Math.max(1, Math.round((Date.now() - (awayStartAt || Date.now())) / 60000));
    S.deadline += Math.max(60000, S.breakMin * 60000);   // 按设定 cadence 续（+= 防后台节流漂移）
    S.remaining = S.deadline - Date.now();
    save();
    beep();
    notify('☕ 还在休息', '已经休息了约 ' + mins + ' 分钟。切回教程页自动恢复专注，再过 ' + S.breakMin + ' 分钟会再提醒。');
    flashTitle(true);
    try {
      const desc = document.getElementById('pomoModalDesc');
      if (desc && awayInfoModal) desc.textContent = `已经休息了约 ${mins} 分钟。切回教程页自动恢复专注；不回来每 ${S.breakMin} 分钟提醒一次，计时一直在走。`;
    } catch (e) {}
    render();
  }
  /* 到期统一判定：切出休息走周期提醒，其他走正常结束 */
  function checkFinish() {
    if (awayMode && S.phase === 'break') { awayCheckpoint(); return; }
    complete();
  }
  function restoreFocus() {
    if (!awayMode) return;
    awayMode = false; awayInfoModal = false; awayStartAt = 0;
    const r = awaySaved && awaySaved.remaining > 0 ? awaySaved.remaining : phaseLen('focus');
    awaySaved = null;
    S.phase = 'focus';
    S.remaining = r;
    S.deadline = Date.now() + r;
    S.running = true;
    finished = false;
    autoPaused = false; pauseReason = '';
    closeModal();
    stopFlash();
    save(); render();
    toast('👋 欢迎回来，已恢复专注');
    runRoute = location.hash || '#/';
  }
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') {
        convertToAwayRest();
      } else {
        // 回来先追一次结算（后台节流可能延迟了到点判定）
        if (S.running && remainMs() <= 0) { checkFinish(); return; }
        if (onTutorialRoute()) lastScrollAt = Date.now();   // 露面了就给 fresh 的 60 秒，别落地秒停
        if (awayMode && S.running && S.phase === 'break' && onTutorialRoute()) restoreFocus();
      }
    } catch (e) {}
  });

  /* 主循环：250ms 刷新；组件被关闭则自我卸载 */
  setInterval(() => {
    try {
      if (!enabled()) { unmount(); return; }
      if (!el('pomoRoot')) mount();
      if (S.dayStamp !== DAY()) { S.dayStamp = DAY(); S.doneToday = 0; save(); }
      autoWatch();
      if (S.running && remainMs() <= 0) checkFinish();
      else render();
    } catch (e) {}
  }, 250);

  /* 对外极小接口（测试 / 调试 / 跨插件用） */
  window.Pomodoro = {
    start, pause, resume, stop, setBind,
    state: () => ({ phase: S.phase, running: S.running, remainMs: remainMs(), focusMin: S.focusMin, breakMin: S.breakMin, doneToday: S.doneToday, auto: S.auto, autoPaused, away: awayMode, awayMin: awayMode && awayStartAt ? Math.floor((Date.now() - awayStartAt) / 60000) : 0, bind: { nodeId: S.bindNodeId, title: S.bindTitle, goalId: S.bindGoalId } }),
    _finishNow: () => { if (S.running) { S.deadline = Date.now(); } }
  };

  SiErXing.registerPlugin({ id: 'pomodoro' });
})();
