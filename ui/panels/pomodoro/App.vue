<template>
  <div id="pomoVueRoot" :style="rootStyle">
    <button v-if="st.collapsed" class="pomoBadge" :title="badgeTitle" @mousedown="startDrag" @click="onBadgeClick"><span>{{ clock }}</span><span class="pomoDot" :class="dotClass"></span></button>
    <div v-else class="pomoPanel">
      <div class="pomoHead" title="按住这里拖到任意位置（位置会记住）" @mousedown="startDrag"><span>🍅 番茄钟</span><span class="pomoToday">{{ st.doneToday ? '今日 ' + st.doneToday + '🍅' : '' }}</span><div class="spacer"></div><button class="pomoIconBtn" :title="st.notify ? '系统通知已开启' : '系统通知：切到别的标签页也能收到到点提醒，点我授权'" @click="act('bell')">{{ st.notify ? '🔔' : '🔕' }}</button><button class="pomoIconBtn" title="折叠成小圆标" @click="act('collapse')">—</button></div>
      <div class="pomoModes"><button class="pomoMode" :class="{ active: st.phase !== 'break' }" :disabled="st.running" @click="act('focus')">🎯 专注</button><button class="pomoMode" :class="{ active: st.phase === 'break' }" :disabled="st.running" @click="act('break')">☕ 休息</button></div>
      <div class="pomoClock" :class="clockClass">{{ clock }}</div>
      <div class="pomoBar"><div class="pomoFill" :class="st.phase" :style="{ width: fillPct + '%' }"></div></div>
      <div class="pomoStatus">{{ statusText }}</div>
      <button class="pomoBind" :class="{ on: !!st.bindNodeId }" title="绑定节点：专注时间全部记到该节点；点我更换" @click="act('bind')">📌 {{ st.bindNodeId ? (st.bindTitle || ('节点 ' + st.bindNodeId)) : '未绑定（按打开的教程记）' }}</button>
      <div class="pomoRows"><label>专注 <input type="number" min="1" max="180" step="1" :value="st.focusMin" :disabled="st.running" @change="setDur('focus', $event.target.value)"> 分钟</label><label>休息 <input type="number" min="1" max="180" step="1" :value="st.breakMin" :disabled="st.running" @change="setDur('break', $event.target.value)"> 分钟</label></div>
      <div class="pomoBtns"><button class="btn small primary" @click="act('main')">{{ mainText }}</button><button class="btn small" @click="act('stop')">结束</button><a class="btn small" href="#/studystats" title="学习统计">📊</a></div>
      <button class="pomoAuto" :class="{ off: !st.auto }" title="开着时：在教程页有动静就自动开始专注，切出教程页自动暂停" @click="act('auto')">{{ st.auto ? '🤖 读教程自动计时：开' : '🤖 读教程自动计时：关' }}</button>
      <div class="pomoHint">时间到会弹窗 + 系统通知 + 提示音，切页面、刷视频也能收到</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
const st = ref({ running: false, phase: 'focus', remain: 0, total: 0, doneToday: 0, collapsed: false, focusMin: 25, breakMin: 5, bindNodeId: 0, bindTitle: '', auto: true, notify: false, paused: false });
let timer = null;
const bridge = () => window.Pomodoro;
function pull() { try { const b = bridge(); if (b && b.state) { const s = b.state(); const total = (s.phase === 'break' ? s.breakMin : s.focusMin) * 60000; st.value = Object.assign({}, s, { remain: s.remainMs || 0, total: total }); } } catch (e) {} if (!dragging) readPos(); }
function fmt(ms) { const s = Math.max(0, Math.ceil(Number(ms || 0) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
const clock = computed(() => fmt(st.value.remain));
const fillPct = computed(() => { const t = Number(st.value.total || 0); return t ? Math.max(0, Math.min(100, (t - Number(st.value.remain || 0)) / t * 100)) : 0; });
const clockClass = computed(() => [st.value.running ? st.value.phase : 'idle', st.value.running && st.value.remain < 60000 ? 'urgent' : '']);
const dotClass = computed(() => st.value.running ? (st.value.phase === 'break' ? 'brk run' : 'foc run') : 'idle');
const badgeTitle = computed(() => st.value.running ? (st.value.phase === 'break' ? '休息中，点击展开' : '专注中，点击展开') : '番茄钟（点击展开）');
const mainText = computed(() => st.value.running ? '⏸ 暂停' : (st.value.paused ? '▶ 继续' : (st.value.phase === 'break' ? '开始休息' : '开始专注')));
const statusText = computed(() => { const s = st.value; const rec = (s.bindNodeId && s.running && s.phase === 'focus') ? (' · 记到「' + String(s.bindTitle || '').slice(0, 12) + '」') : ''; if (s.running) return (s.phase === 'break' ? '☕ 休息中' : '🎯 专注中') + ' · 今日专注 ' + s.doneToday + ' 次' + rec; if (s.paused) return '⏸ 已暂停 · 点击继续'; return '待开始 · 今日专注 ' + (s.doneToday || 0) + ' 次'; });
const pos = ref({ right: 18, bottom: 18 });
const rootStyle = computed(() => ({ right: pos.value.right + 'px', bottom: pos.value.bottom + 'px', position: 'fixed', zIndex: 60 }));
let dragAt = 0;
let dragging = false;
function readPos() { try { const b = bridge(); if (b && b._pos) { const p = b._pos(); if (p) pos.value = { right: Math.max(8, Number(p.right) || 18), bottom: Math.max(8, Number(p.bottom) || 18) }; } } catch (e) {} }
function startDrag(e) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  const r0 = pos.value.right, b0 = pos.value.bottom;
  dragging = false;
  const move = ev => {
    const dx = sx - ev.clientX, dy = sy - ev.clientY;
    if (!dragging && Math.abs(dx) + Math.abs(dy) < 5) return;   // 没明显移动 = 点击
    dragging = true;
    e.preventDefault();
    const maxR = Math.max(8, (window.innerWidth || 1200) - 60);
    const maxB = Math.max(8, (window.innerHeight || 800) - 60);
    pos.value = { right: Math.max(8, Math.min(maxR, r0 + dx)), bottom: Math.max(8, Math.min(maxB, b0 + dy)) };
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (dragging) {
      dragAt = Date.now();
      try { const b = bridge(); if (b && b._setPos) b._setPos(pos.value.right, pos.value.bottom); } catch (e2) {}
    }
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
function onBadgeClick() { if (Date.now() - dragAt < 350) return; act('expand'); }
function act(name) { try { const b = bridge(); if (!b) return; if (name === 'expand' || name === 'collapse') b._toggleCollapse(); else if (name === 'main') b._main(); else if (name === 'stop') b.stop(); else if (name === 'focus') b._selectPhase('focus'); else if (name === 'break') b._selectPhase('break'); else if (name === 'auto') b._toggleAuto(); else if (name === 'bell') b._bell(); else if (name === 'bind') b._openBind(); pull(); } catch (e) {} }
function setDur(which, v) { try { const b = bridge(); if (b && b._setDur) b._setDur(which, v); pull(); } catch (e) {} }
onMounted(() => { readPos(); pull(); timer = setInterval(pull, 500); });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
#pomoVueRoot { position: fixed; z-index: 60; }
#pomoVueRoot .pomoPanel { position: relative; right: auto !important; bottom: auto !important; }
#pomoVueRoot .pomoHead { cursor: move; }
#pomoVueRoot .pomoBadge { cursor: move; touch-action: none; }
</style>