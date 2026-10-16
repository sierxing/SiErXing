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

  /* awayBreak / awayRemain：这一轮休息是**切出去休息**自动起的，以及切出前专注还剩多久。
   ⚠️ 必须持久化。awayMode 只是运行时变量，一旦刷新就没了 —— 新页面看到
   "phase=break + running"，会把它当成用户自己开的休息轮次接着倒数：
   用户回来刷个新，番茄钟就在那儿"自动开始休息计时"（线上报的 bug）。
   有了这两个标记，无论刷新几次，回到教程页都能把专注原样接回来。 */
  const DEF = { focusMin: 25, breakMin: 5, phase: 'focus', running: false, deadline: 0, remaining: 25 * 60000, collapsed: false, right: 18, bottom: 18, doneToday: 0, dayStamp: DAY(), sound: true, notify: true, bindNodeId: 0, bindTitle: '', bindGoalId: 0, auto: true, idleMin: 0, restKeys: ['bilibili'], awayBreak: false, awayRemain: 0 };

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { s = {}; }
    const st = Object.assign({}, DEF, s);
    if (st.dayStamp !== DAY()) { st.dayStamp = DAY(); st.doneToday = 0; }
    st.focusMin = clampMin(st.focusMin, DEF.focusMin);
    st.breakMin = clampMin(st.breakMin, DEF.breakMin);
    // idleMin：多少分钟没动静就自动暂停专注。0 = 不检测（只看页面切换）。
    // 旧存档没有这个字段 → 按 0 处理，等于不再有「1 分钟没滚动就停」的硬性打断。
    st.idleMin = clampIdle(st.idleMin, DEF.idleMin);
    // restKeys：切走页面时，只有前台窗口标题命中这些关键词才算「休息」。
    // 空数组 = 不做筛选，切走就算休息（等同旧行为）。
    st.restKeys = normKeys(st.restKeys !== undefined ? st.restKeys : DEF.restKeys);
    return st;
  }
  /* 关键词去空白、去重（大小写不敏感去重）、限长限量，避免脏存档把渲染/匹配搞坏 */
  function normKeys(v) {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' && v ? v.split(/[,，\s]+/) : DEF.restKeys);
    const seen = {}, out = [];
    for (const x of arr) {
      const k = String(x == null ? '' : x).trim().slice(0, 40);
      if (!k) continue;
      const kk = k.toLowerCase();
      if (seen[kk]) continue;
      seen[kk] = 1; out.push(k);
      if (out.length >= 12) break;
    }
    return out;
  }
  function matchKeys(hay, keys) {
    const h = String(hay || '').toLowerCase();
    if (!h) return false;
    for (const k of (keys || [])) { const kk = String(k).trim().toLowerCase(); if (kk && h.indexOf(kk) >= 0) return true; }
    return false;
  }
  function clampMin(v, fb) { v = Math.round(Number(v)); return (v >= 1 && v <= 180) ? v : fb; }
  // 允许 0（关闭检测）与 1~180（分钟）
  function clampIdle(v, fb) { v = Math.round(Number(v)); return (v === 0 || (v >= 1 && v <= 180)) ? v : fb; }
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

  /* 页面正在卸载（刷新 / 站内跳转 / 关标签 / 跳外链）。
     ⚠️ 卸载时浏览器也会发 visibilitychange→hidden，但那**不是"切出应用"** ——
        人还在这个页面上，只是页面自己要换了。把它当真会导致：
        刷新一下就被记成"去休息了"，新页面接着跑休息计时（线上报的 bug）。
        用 sessionStorage 留痕：卸载标记跟着标签页走，新开的标签不会有。 */
  let unloading = false;
  let resumeChecked = false;
  const UNLOAD_KEY = LS + '-unloading';
  function markUnloading() {
    unloading = true;
    try { sessionStorage.setItem(UNLOAD_KEY, String(Date.now())); } catch (e) {}
  }
  try { window.addEventListener('pagehide', markUnloading); window.addEventListener('beforeunload', markUnloading); } catch (e) {}

  /* ---------------- 计时核心 ---------------- */
  let finished = false;   // 本轮是否已结算（防重复触发）
  let autoPaused = false; // 系统自动暂停的（切出教程/久无滚动）：滚动回来可自动继续
  let runRoute = null; // 本轮跑起来时所在的页面：只有从教程页切走才自动暂停
  let awayMode = false;   // 切出应用后的休息计时中（回来前一直记休息）
  let awaySaved = null;   // 切出时暂存的专注轮次 { remaining }，回来恢复
  let awayStartAt = 0;    // 本次切出休息开始的时间戳，用来算“已休息多久”
  let awayInfoModal = false; // 当前弹窗只是“已开始休息”告知，点“知道了”不碰计时
  let researching = false;   // 切出去但判定为「在查资料」：专注继续跑，不记休息
  let researchAt = 0;
  let researchWin = '';
  let pauseReason = '';   // 自动暂停原因展示
  function start(phase) {
    S.phase = (phase === 'break') ? 'break' : 'focus';
    S.remaining = phaseLen(S.phase);
    S.deadline = Date.now() + S.remaining;
    S.running = true;
    finished = false;
    autoPaused = false; pauseReason = '';
    runRoute = location.hash || '#/';
    markActive();   // 手动点开始也算一次露面，给一个完整周期的宽限
    awayMode = false; awaySaved = null; awayInfoModal = false; awayStartAt = 0;
    S.awayBreak = false; S.awayRemain = 0;
    researching = false; researchAt = 0; researchWin = '';
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
    S.awayBreak = false; S.awayRemain = 0;
    researching = false; researchAt = 0; researchWin = '';
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
    markActive();   // 手动点继续也算露面，否则会被 idle 规则秒停
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
    S.awayBreak = false; S.awayRemain = 0;
    researching = false; researchAt = 0; researchWin = '';
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
    markActive();
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
    S.awayBreak = false; S.awayRemain = 0;
    researching = false; researchAt = 0; researchWin = '';
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
        `<label class="pomoIdleRow" title="读教程时多久没动静就自动暂停专注。默认「不检测」——专注只在你切走页面或手动点停时才会中断，适合长时间看代码。">` +
        `<span class="pomoIdleLabel">没动静</span><select id="pomoIdleMin">` +
        `<option value="0">不检测</option><option value="1">1 分钟</option><option value="3">3 分钟</option>` +
        `<option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option>` +
        `<option value="30">30 分钟</option><option value="60">1 小时</option></select>` +
        `<span class="pomoIdleLabel">自动暂停</span></label>` +
        `<div class="pomoKeys" id="pomoKeysBox" title="切走页面时，只有前台窗口标题里含下面这些关键词才判定为「在休息」；去查资料/看文档则不算，专注继续走。留空 = 切走就算休息（旧行为）。">` +
          `<div class="pomoKeysHead"><span>切走算休息</span><span class="pomoKeysHint" id="pomoKeysHint"></span></div>` +
          `<div class="pomoKeysList" id="pomoKeysList"></div>` +
          `<div class="pomoKeysAdd"><input id="pomoKeyIn" placeholder="加关键词，如 bilibili" maxlength="40" autocomplete="off">` +
          `<button class="btn tiny" id="pomoKeyAdd">添加</button></div>` +
        `</div>` +
        `<div class="pomoBtns"><button id="pomoMain" class="btn small primary">开始专注</button><button id="pomoStop" class="btn small">结束</button><a id="pomoStats" class="btn small" href="#/studystats" title="学习统计：按天/按节点看学了多久">📊</a></div>` +
        `<button id="pomoAuto" class="pomoAuto" title="开着时：在教程页有动静就自动开始专注，切出教程页自动暂停；「没动静」的时长在上面的下拉里调"></button>` +
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
    el('pomoIdleMin').addEventListener('change', () => {
      S.idleMin = clampIdle(el('pomoIdleMin').value, S.idleMin);
      save(); render();
      toast(S.idleMin === 0 ? '⏱ 已关闭没动静检测：专注只在你切走页面时中断' : '⏱ ' + S.idleMin + ' 分钟没动静就自动暂停专注');
    });
    el('pomoAuto').addEventListener('click', () => { S.auto = !S.auto; save(); render(); toast(S.auto ? '🤖 读教程自动计时：开' : '🤖 读教程自动计时：关'); });
    /* ---- 「切走算休息」的关键词：可增删改（逻辑在 renderKeys/commitKeys，模块级） ---- */
    el('pomoKeyAdd').addEventListener('click', () => {
      const k = el('pomoKeyIn');
      const v = String(k && k.value || '').trim();
      if (!v) return;
      commitKeys((S.restKeys || []).concat([v]), '已添加「' + v + '」');
      setTimeout(() => { const k2 = el('pomoKeyIn'); if (k2) { k2.value = ''; k2.focus(); } }, 0);
    });
    const keyIn0 = el('pomoKeyIn');
    if (keyIn0) keyIn0.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el('pomoKeyAdd').click(); } });
    renderKeys();
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
    el('pomoModalDesc').textContent = `检测到你切到了「${(S.restKeys || []).join('、')}」，休息计时中（${S.breakMin} 分钟，到点会再提醒）。只要没切回来就持续计时；回来自动恢复专注。`;
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
    // 运行中且在教程页时，提示当前用的哪种「算在专注」口径，免得用户以为被莫名暂停
    const mode = S.idleMin === 0 ? '不限时' : (S.idleMin + ' 分钟没动静才停');
    // 切出去但判定成「在查资料」：要说清楚，不然用户以为番茄钟坏了
    const research = (researching && S.running && S.phase === 'focus')
      ? ' · 📖 查资料中（不算休息）' + (researchWin ? '：' + researchWin : '') : '';
    if (S.running) st.textContent = (S.phase === 'break' ? '☕ 休息中' : '🎯 专注中') + ' · 今日专注 ' + S.doneToday + ' 次' + rec
      + (S.auto && S.phase === 'focus' && onTutorialRoute() ? ' · ' + mode : '') + research;
    else if (ms > 0 && ms < total) st.textContent = '⏸ 已暂停' + (pauseReason ? '（' + pauseReason + '）' : '') + ' · 点击继续';
    else st.textContent = '待开始 · 今日专注 ' + S.doneToday + ' 次';
    el('pomoAuto').textContent = S.auto ? '🤖 读教程自动计时：开' : '🤖 读教程自动计时：关';
    el('pomoAuto').classList.toggle('off', !S.auto);
    renderKeys();
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
    // 没动静检测时长：运行中也可以随时改，不用先暂停
    if (el('pomoIdleMin')) el('pomoIdleMin').value = String(S.idleMin || 0);
  }

  /* ---------------- 读教程自动计时 ----------------
   * 教程页有动静 = 在学：暂停的半截直接继续，否则开新专注；
   * 切出教程页 / 太久没动静（时长由用户设置，默认不检测）→ 自动暂停；
   * 手动点的暂停只是停住这一秒，下一次有动静就继续（想彻底停就点结束或关自动）。 */
  function onTutorialRoute() { return /^#\/t\/(\d+)$/.test(location.hash || ''); }
  function tutorialId() { const m = (location.hash || '').match(/^#\/t\/(\d+)$/); return m ? Number(m[1]) : 0; }
  /* 「在动」的判定不只看滚动：读代码时人可能一直盯着屏幕不动，
   * 但只要动了鼠标、敲了键盘、滚了滚轮，就说明还醒着。
   * mousemove 事件极密集，必须节流，否则每帧都写时间戳。 */
  let lastActiveAt = Date.now();
  let mousemoveAt = 0;
  function markActive() { lastActiveAt = Date.now(); }
  ['wheel', 'keydown', 'pointerdown', 'touchstart', 'focus'].forEach(ev => {
    window.addEventListener(ev, markActive, { passive: true, capture: true });
  });
  window.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - mousemoveAt < 2000) return;   // 2 秒节流一次即可
    mousemoveAt = now;
    markActive();
  }, { passive: true });
  window.addEventListener('scroll', () => {
    try {
      markActive();
      if (onTutorialRoute()) maybeAutoStart();
    } catch (e) {}
  }, { passive: true });
  window.addEventListener('hashchange', () => {
    try {
      markActive();
      autoPaused = false; pauseReason = '';
      // 切到别的教程页：自动绑的旧节点清掉（暂停的半截留着，滚一下就按新节点继续）
      if (onTutorialRoute() && !S.running && S.bindAuto) {
        S.bindNodeId = 0; S.bindTitle = ''; S.bindGoalId = 0; S.bindAuto = false;
        save();
      }
      // 应用内跳回教程页（visibility 没变化）：切屏休息同样恢复专注
      if (shouldResumeAway()) restoreFocus();
      else if (el('pomoRoot')) render();
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
    // 多久没动静就自动暂停：默认关闭（idleMin=0）。
    // 开着时按用户设定的分钟数判定，且只在教程页生效（休息本来就不用动手，不该停）。
    const idleMs = (S.idleMin || 0) * 60000;
    if (idleMs > 0 && S.phase === 'focus' && onTutorialRoute() && Date.now() - lastActiveAt > idleMs) {
      autoPause(S.idleMin + ' 分钟没动静');
    }
  }
  /* ---------------- 前台窗口探测（切走时判断「是在刷视频还是在查资料」） ----------------
   * ⚠️ 网页自己读不到别的窗口的网址（浏览器就是不给这个能力），所以由本机 Node 去问操作系统。
   *    拿回来的是**窗口标题**：Edge/Chrome 形如「页面标题 和另外 1 个页面 - 个人 - Microsoft Edge」，
   *    没有网址，但 bilibili 的 <title> 通常带 `_哔哩哔哩_bilibili`，所以关键词匹配可用。
   *    探测不可用（Wayland / 没装 xdotool / 权限不足）→ ok:false → 退回旧行为，
   *    宁可多记休息，也不要悄悄不记。 */
  let winProbeCache = { at: 0, val: null };
  let winProbeBroken = false;     // 连着失败几次就只提示一次，别反复弹
  async function fetchActiveWindow(maxAgeMs) {
    const now = Date.now();
    if (winProbeCache.val && now - winProbeCache.at < (maxAgeMs || 1500)) return winProbeCache.val;
    try {
      const r = await fetch('/api/pomodoro/activewin?maxAge=1200', { cache: 'no-store' });
      const j = await r.json();
      const v = { ok: !!j.ok, title: j.title || '', app: j.app || '', source: j.source || '', platform: j.platform || '' };
      winProbeCache = { at: Date.now(), val: v };
      if (v.ok) winProbeBroken = false;
      return v;
    } catch (e) {
      const v = { ok: false, title: '', app: '', err: String(e && e.message || e) };
      winProbeCache = { at: Date.now(), val: v };
      return v;
    }
  }
  /* 切出去之后必须**持续重判**，不能只在 hide 那一刻判一次。
     ⚠️ 用户实测踩到的坑：「先打开百度，再打开 B 站」判不出来。
        因为 visibilitychange 只在**整个标签页被藏起来**时触发一次；
        之后在同一浏览器窗口内换标签页，思而行那个标签始终是 hidden，
        事件根本不再发 —— 第一次判定成「查资料」之后就永远锁死了。
        而且 hide 那一刻读到的窗口标题还可能没更新（浏览器是异步改标题的）。
   * 只做单向升级：查资料 → 休息。已经是休息了就让它跑完，不来回抖。
   * 间隔别太短：后台标签页的定时器会被浏览器降频（隐藏后逐步到 1s/次，长时间后更慢），
     服务器侧也有 1.2s 缓存，2.5s 一次足够灵敏也不浪费。 */
  let lastAwayCheck = 0;
  function awayPoll() {
    try {
      if (!S.auto || awayMode) return;
      if (document.visibilityState !== 'hidden') return;
      if (!enabled()) return;
      if (!researching) return;                  // 只在「查资料」态才可能升级为休息
      if (!(S.restKeys || []).length) return;    // 没关键词 = 旧行为，hide 时已处理过
      const now = Date.now();
      if (now - lastAwayCheck < 2500) return;
      lastAwayCheck = now;
      recheckAway();
    } catch (e) {}
  }
  async function recheckAway() {
    const keys = S.restKeys || [];
    const v = await fetchActiveWindow(800);
    if (!v.ok) return;                            // 探测失败就保持现状，别来回乱改
    if (document.visibilityState !== 'hidden' || awayMode || !researching) return;
    if (winMatches(v, keys)) {
      researching = false; researchAt = 0; researchWin = '';
      convertToAwayRest();
    } else {
      researchWin = (v.title || v.app || '').slice(0, 60);
      try { save(); } catch (e) {}
    }
  }

  function winMatches(v, keys) {
    // 标题优先（能区分同一浏览器里的不同标签页）；再退到应用名（区分不同程序）
    return matchKeys(v && v.title, keys) || matchKeys(v && v.app, keys);
  }

  /* ---- 关键词编辑区（面板里那一小块）：模块级，render() 也要能刷新它 ---- */
  function commitKeys(list, msg) {
    S.restKeys = normKeys(list);
    save();
    renderKeys();
    if (msg) toast(msg);
  }
  function renderKeys() {
    const box = el('pomoKeysList');
    if (!box) return;
    const keys = S.restKeys || [];
    if (!keys.length) {
      box.innerHTML = '<span class="pomoKeysEmpty">留空 = 切走就算休息（同旧行为）</span>';
    } else {
      box.innerHTML = keys.map((k, i) => '<span class="pomoKey">' +
        `<input class="pomoKeyEdit" data-i="${i}" value="${String(k).replace(/"/g, '&quot;')}" maxlength="40" title="点一下就能改">` +
        `<button class="pomoKeyDel" data-i="${i}" title="删除">×</button></span>`).join('');
      box.querySelectorAll('.pomoKeyDel').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.getAttribute('data-i'));
        commitKeys(keys.filter((_, j) => j !== i), '已删除「' + keys[i] + '」');
      }));
      box.querySelectorAll('.pomoKeyEdit').forEach(inp => {
        const apply = () => {
          const i = Number(inp.getAttribute('data-i'));
          const v = String(inp.value || '').trim();
          if (!v || v === keys[i]) { renderKeys(); return; }   // 清空/没改 → 还原，不留空标签
          const next = keys.slice(); next[i] = v;
          commitKeys(next, '已改为「' + v + '」');
        };
        inp.addEventListener('change', apply);
        inp.addEventListener('blur', apply);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      });
    }
    const hint = el('pomoKeysHint');
    if (hint) hint.textContent = keys.length ? ('命中才算休息 · ' + keys.length + ' 条') : '未启用筛选';
  }

  /* 切出页面时的判定。异步是因为要问一次操作系统，串行不能省。
   * 用序号防止「问的功夫里已经切回来了」还傻乎乎转休息。 */
  let awaySeq = 0;
  async function decideAwayOnHide() {
    if (unloading) return;          // 页面自己在换（刷新/跳转），不是切出应用
    if (!S.auto || awayMode) return;
    if (!enabled()) return;
    const keys = S.restKeys || [];
    if (!keys.length) { convertToAwayRest(); return; }   // 没填关键词 = 旧行为
    const seq = ++awaySeq;
    lastAwayCheck = Date.now();     // 刚判过一次，轮询先让 2.5s
    const v = await fetchActiveWindow(1500);
    if (unloading) return;                                // 等结果的功夫页面开始卸载了
    if (seq !== awaySeq) return;                          // 已经切回来了
    if (document.visibilityState !== 'hidden') return;    // 同上
    if (v.ok && winMatches(v, keys)) { convertToAwayRest(); return; }
    if (!v.ok) {
      winProbeBroken = true;
      convertToAwayRest();   // 探测不了就按老规矩，别把功能弄没了
      return;
    }
    // 没命中 → 你是在查资料，专注继续跑，不记休息
    researching = true;
    researchAt = Date.now();
    researchWin = (v.title || v.app || '').slice(0, 60);
    try { save(); render(); } catch (e) {}
  }
  /* 切出应用（标签不可见，如去刷视频）：专注转休息一直记，回来自动恢复专注。
   * 注意：只要标签藏起来就转，不要求计时是在教程页开始的——看不见页面就不算在学。 */
  function convertToAwayRest() {
    if (unloading) return;          // 同上：卸载瞬间的 hidden 不算切走
    if (!S.auto || awayMode) return;
    if (!enabled()) return;
    if (S.running) {
      if (S.phase !== 'focus') return;   // 已经在休息就让它跑着
      flushStats();   // 先把专注零头结算了，再转休息
      awaySaved = { remaining: remainMs() };   // 必须用活的值：S.remaining 运行时是旧的
    } else {
      // 暂停在半截：专注半截留档待恢复；休息半截就地继续；空闲不动
      if (!(S.remaining > 0 && S.remaining < phaseLen(S.phase))) return;
      if (S.phase === 'focus') awaySaved = { remaining: S.remaining };
    }
    awayMode = true;
    awayStartAt = Date.now();
    /* 落两个持久化标记：这一轮是"切出休息"，以及切出前专注还剩多久 */
    S.awayBreak = true;
    S.awayRemain = awaySaved && awaySaved.remaining > 0 ? awaySaved.remaining : phaseLen('focus');
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
  /* 该不该把「切出休息」接回专注。
     ⚠️ 条件是 `awayMode || S.awayBreak` —— awayMode 是运行时变量，刷新就没了；
     S.awayBreak 是持久化的标记。只用 awayMode 判断的话，
     "切出去休息 → 刷新 → 回教程页"这条路上永远恢复不了专注，
     用户看到的就是"刷新后番茄钟自己在休息"。 */
  function shouldResumeAway() {
    return !!(awayMode || S.awayBreak) && S.running && S.phase === 'break' && onTutorialRoute();
  }
  function restoreFocus() {
    const savedR = awaySaved && awaySaved.remaining > 0 ? awaySaved.remaining
      : (S.awayRemain > 0 ? S.awayRemain : phaseLen('focus'));
    awayMode = false; awayInfoModal = false; awayStartAt = 0;
    researching = false; researchAt = 0; researchWin = '';
    const r = savedR;
    awaySaved = null;
    S.awayBreak = false; S.awayRemain = 0;
    S.phase = 'focus';
    S.remaining = r;
    S.deadline = Date.now() + r;
    S.running = true;
    finished = false;
    autoPaused = false; pauseReason = '';
    markActive();   // 回来=露面，给一个完整周期的宽限
    closeModal();
    stopFlash();
    save(); render();
    toast('👋 欢迎回来，已恢复专注');
    runRoute = location.hash || '#/';
  }
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') {
        decideAwayOnHide();   // 要问一次操作系统才能判断，异步；见 decideAwayOnHide
      } else {
        awaySeq++;            // 作废切出时那次未完成的判定（已经回来了）
        lastAwayCheck = 0;
        if (researching) { researching = false; researchAt = 0; researchWin = ''; }
        // 回来先追一次结算（后台节流可能延迟了到点判定）
        if (S.running && remainMs() <= 0) { checkFinish(); return; }
        if (onTutorialRoute()) markActive();   // 露面了就给一个完整周期的宽限，别落地秒停
        if (shouldResumeAway()) restoreFocus();
        else try { render(); } catch (e2) {}
      }
    } catch (e) {}
  });

  /* 主循环：250ms 刷新；组件被关闭则自我卸载 */
  setInterval(() => {
    try {
      if (!enabled()) { unmount(); return; }
      if (!el('pomoRoot')) mount();
      if (S.dayStamp !== DAY()) { S.dayStamp = DAY(); S.doneToday = 0; save(); }
      /* 刷新/重新打开后补一次恢复：awayMode 已经随旧文档消失，
         只能靠持久化的 awayBreak 判断"这一轮休息是切出去时自动起的"。
         人在教程页就说明回来了，把专注原样接回来（和切回来时的行为一致）。 */
      if (!resumeChecked) {
        resumeChecked = true;
        try { sessionStorage.removeItem(UNLOAD_KEY); } catch (e2) {}
        if (shouldResumeAway()) restoreFocus();
      }
      awayPoll();      // 切出去之后持续重判（同一浏览器窗口内换标签页不再有 visibilitychange）
      autoWatch();
      if (S.running && remainMs() <= 0) checkFinish();
      else render();
    } catch (e) {}
  }, 250);

  /* 对外极小接口（测试 / 调试 / 跨插件用） */
  window.Pomodoro = {
    start, pause, resume, stop, setBind,
    state: () => ({ phase: S.phase, running: S.running, remainMs: remainMs(), focusMin: S.focusMin, breakMin: S.breakMin, idleMin: S.idleMin || 0, doneToday: S.doneToday, auto: S.auto, autoPaused, away: awayMode, awayMin: awayMode && awayStartAt ? Math.floor((Date.now() - awayStartAt) / 60000) : 0, bind: { nodeId: S.bindNodeId, title: S.bindTitle, goalId: S.bindGoalId }, restKeys: (S.restKeys || []).slice(), researching, researchWin }),
    /* 供设置面板「试一下」按钮 / 调试用 */
    _probeWin: () => fetchActiveWindow(0),
    _matchKeys: (hay, keys) => matchKeys(hay, keys || (S.restKeys || [])),
    _setKeys: list => { commitKeys(list); return (S.restKeys || []).slice(); },
    _finishNow: () => { if (S.running) { S.deadline = Date.now(); } }
  };

  SiErXing.registerPlugin({ id: 'pomodoro' });
})();
