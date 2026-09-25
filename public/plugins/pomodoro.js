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

  const DEF = { focusMin: 25, breakMin: 5, phase: 'focus', running: false, deadline: 0, remaining: 25 * 60000, collapsed: false, right: 18, bottom: 18, doneToday: 0, dayStamp: DAY(), sound: true, notify: true };

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
  function start(phase) {
    S.phase = (phase === 'break') ? 'break' : 'focus';
    S.remaining = phaseLen(S.phase);
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    finished = false;
    closeModal();
    stopFlash();
    save(); render();
  }
  function pause() {
    if (!S.running) return;
    S.remaining = remainMs();
    S.running = false;
    S.deadline = 0;
    save(); render();
  }
  function resume() {
    if (S.running || S.remaining <= 0) return;
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    save(); render();
  }
  function stop() {
    S.running = false;
    S.deadline = 0;
    S.remaining = phaseLen(S.phase);
    finished = false;
    closeModal();
    stopFlash();
    save(); render();
    toast('🍅 已结束计时');
  }
  function complete() {
    if (finished) return;
    finished = true;
    const was = S.phase;
    S.running = false;
    S.deadline = 0;
    S.remaining = 0;
    if (was === 'focus') {
      if (S.dayStamp !== DAY()) { S.dayStamp = DAY(); S.doneToday = 0; }
      S.doneToday++;
    }
    save();
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
        `<button id="pomoCollapse" class="pomoIconBtn" title="折叠成小圆标">—</button></div>` +
        `<div class="pomoModes"><button id="pomoModeFocus" class="pomoMode">🎯 专注</button><button id="pomoModeBreak" class="pomoMode">☕ 休息</button></div>` +
        `<div id="pomoClock" class="pomoClock">25:00</div>` +
        `<div class="pomoBar"><div id="pomoFill" class="pomoFill"></div></div>` +
        `<div id="pomoStatus" class="pomoStatus">待开始</div>` +
        `<div class="pomoRows"><label>专注 <input id="pomoFocusMin" type="number" min="1" max="180" step="1"> 分钟</label>` +
        `<label>休息 <input id="pomoBreakMin" type="number" min="1" max="180" step="1"> 分钟</label></div>` +
        `<div class="pomoBtns"><button id="pomoMain" class="btn small primary">开始专注</button><button id="pomoStop" class="btn small">结束</button><a id="pomoStats" class="btn small" href="#/studystats" title="学习统计：按天/按节点看学了多久">📊</a></div>` +
        `<div class="pomoHint">时间到会弹窗 + 系统通知 + 提示音，切页面、刷视频也能收到</div>` +
      `</div>` +
      `<div id="pomoModalWrap" class="pomoModalWrap" hidden><div class="pomoModal">` +
        `<div id="pomoModalIcon" class="pomoModalIcon">🍅</div>` +
        `<div id="pomoModalTitle" class="pomoModalTitle"></div>` +
        `<div id="pomoModalDesc" class="pomoModalDesc"></div>` +
        `<div class="pomoModalBtns"><button id="pomoModalGo" class="btn primary"></button><button id="pomoModalLater" class="btn">稍后</button></div>` +
      `</div></div>`;
    document.body.appendChild(root);
    el('pomoCollapse').addEventListener('click', () => { S.collapsed = true; save(); render(); });
    el('pomoModeFocus').addEventListener('click', () => selectPhase('focus'));
    el('pomoModeBreak').addEventListener('click', () => selectPhase('break'));
    el('pomoMain').addEventListener('click', onMain);
    el('pomoStop').addEventListener('click', () => stop());
    el('pomoFocusMin').addEventListener('change', onDur);
    el('pomoBreakMin').addEventListener('change', onDur);
    el('pomoModalLater').addEventListener('click', () => { S.remaining = phaseLen(S.phase); finished = false; closeModal(); stopFlash(); save(); render(); });
    el('pomoModalGo').addEventListener('click', () => {
      const next = modalFor === 'focus' ? 'break' : 'focus';
      start(next);
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
    const w = el('pomoModalWrap');
    if (!w) return;
    if (was === 'focus') {
      el('pomoModalIcon').textContent = '🍅';
      el('pomoModalTitle').textContent = '专注结束，好好休息一下！';
      el('pomoModalDesc').textContent = `你刚专注了 ${S.focusMin} 分钟。建议起来走走、喝口水。准备好就开始 ${S.breakMin} 分钟休息（手动开始，不会自动计时）。`;
      el('pomoModalGo').textContent = `开始休息（${S.breakMin} 分钟）▶`;
    } else {
      el('pomoModalIcon').textContent = '☕';
      el('pomoModalTitle').textContent = '休息结束，开工！';
      el('pomoModalDesc').textContent = `休息了 ${S.breakMin} 分钟。回来继续学 ${S.focusMin} 分钟（手动开始）。`;
      el('pomoModalGo').textContent = `开始专注（${S.focusMin} 分钟）▶`;
    }
    w.hidden = false;
  }
  function closeModal() { const w = el('pomoModalWrap'); if (w) w.hidden = true; modalFor = null; }

  function selectPhase(p) {
    if (S.running) return;
    S.phase = p;
    S.remaining = phaseLen(p);
    finished = false;
    save(); render();
  }
  async function onMain() {
    if (S.running) { pause(); return; }
    // 开始 / 继续都需要用户手势：顺手申请通知权限 + 解锁音频
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {}
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') await audioCtx.resume(); } catch (e) {}
    if (S.remaining > 0 && S.remaining < phaseLen(S.phase)) resume();
    else start(S.phase);
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
    if (S.running) st.textContent = (S.phase === 'break' ? '☕ 休息中' : '🎯 专注中') + ' · 今日专注 ' + S.doneToday + ' 次';
    else if (ms > 0 && ms < total) st.textContent = '⏸ 已暂停 · 点击继续';
    else st.textContent = '待开始 · 今日专注 ' + S.doneToday + ' 次';
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

  /* 主循环：250ms 刷新；组件被关闭则自我卸载 */
  setInterval(() => {
    try {
      if (!enabled()) { unmount(); return; }
      if (!el('pomoRoot')) mount();
      if (S.dayStamp !== DAY()) { S.dayStamp = DAY(); S.doneToday = 0; save(); }
      if (S.running && remainMs() <= 0) complete();
      else render();
    } catch (e) {}
  }, 250);

  /* 对外极小接口（测试 / 调试用） */
  window.Pomodoro = {
    start, pause, resume, stop,
    state: () => ({ phase: S.phase, running: S.running, remainMs: remainMs(), focusMin: S.focusMin, breakMin: S.breakMin, doneToday: S.doneToday }),
    _finishNow: () => { if (S.running) { S.deadline = Date.now(); } }
  };

  SiErXing.registerPlugin({ id: 'pomodoro' });
})();
