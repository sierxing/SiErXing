<template>
  <div class="jdPage qPage">
    <div class="jdHead">
      <a class="back" :href="'#/g/' + goalId">← 返回目标</a>
      <span class="mapTitle">🎯 今日任务</span>
      <span class="chip gray">{{ data.date || '' }}</span>
    </div>

    <div v-if="items.length" class="qTop">
      <div class="qTopL">
        <div class="qBig">{{ doneSub }}<span>/{{ totalSub }} 步</span></div>
        <div class="qTopM">{{ allDone ? '今天的任务全做完了 🎉' : ('预计还要 ' + fmtMin(remainMin())) }}</div>
      </div>
      <div class="qBar"><i :style="{ width: pct + '%' }"></i></div>
      <div class="qPct">{{ pct }}%</div>
    </div>

    <div v-if="data.day && data.day.note" class="qNote">{{ data.day.note }}</div>
    <div v-if="history.length" class="qHist">
      最近：
      <span v-for="h in history" :key="h.date" class="qHistI">{{ h.date.slice(5) }} 排 {{ fmtMin(h.planned) }}·完成 {{ h.sdone }}/{{ h.subs }} 步</span>
    </div>

    <div v-if="busy" class="rsBusy" id="qBusyTxt">{{ busyText }}</div>

    <div v-if="items.length" class="qList">
      <div v-for="it in items" :key="it.id" class="qCard" :class="stateOf(it)">
        <div class="qHd">
          <button class="qDot" :class="stateOf(it)" type="button" :title="it.done ? '取消完成' : '整条标为完成（子任务一起勾上）'" @click="toggleItem(it)">{{ stateOf(it) === 'done' ? '✓' : '' }}</button>
          <span class="qTitle">{{ it.title }}</span>
          <span v-if="it.hours_text" class="qChip">任务预估 {{ hoursLabel(it.hours_text) }}</span>
          <span class="qChip qToday">今天 {{ fmtMin(it.minutes) }}</span>
          <span v-if="(it.subs || []).length > 1" class="qProg">{{ subDone(it) }}/{{ (it.subs || []).length }} 步</span>
          <button v-if="stateOf(it) === 'done' && it.node_id" class="btn tiny" type="button" @click="markNodeDone(it.node_id)">标记该节点已完成</button>
        </div>
        <div v-if="it.why" class="qWhy">今天推进它的理由：{{ it.why }}</div>
        <div class="qSubs">
          <label v-for="(s, i) in (it.subs || [])" :key="i" class="qSub" :class="{ done: s.done }">
            <input type="checkbox" :checked="!!s.done" @change="toggleSub(it, i, $event)">
            <span class="qSubT">{{ s.t }}</span>
            <span class="qSubM">{{ fmtMin(s.min) }}</span>
          </label>
        </div>
      </div>
    </div>

    <div v-else class="qEmpty">
      <div class="qEmptyI">🎯</div>
      <div class="qEmptyT">今天还没排</div>
      <div class="qEmptyD">点下面的按钮，AI 会看你最近推进到哪、每个任务大概要多久，排今天推进哪几个节点、拆成哪几小步。</div>
      <button class="btn primary" type="button" @click="plan">AI 排今天的任务</button>
      <div class="qEmptyM">今天打算投入 <b>{{ fmtMin(data.minutes || 120) }}</b>
        <button class="rsLink" type="button" @click="changeMinutes">改</button>
      </div>
    </div>

    <div v-if="items.length || !busy" class="qOps">
      <button class="btn primary" type="button" @click="plan">{{ items.length ? '🔄 重新排今天' : 'AI 排今天的任务' }}</button>
      <button class="btn" type="button" @click="changeMinutes">⏱ 今天只有 <b>{{ fmtMin(data.minutes || 120) }}</b></button>
      <button class="btn" type="button" @click="showAdd = !showAdd">＋ 加一个节点</button>
      <button v-if="items.length" class="btn danger" type="button" @click="clearDay">🗑 清空今天</button>
    </div>

    <div v-if="showAdd" class="qAdd">
      <div class="qAddHd">挑一个节点加进今天（它会用你自己的预估耗时作为时长）</div>
      <div class="qAddList">
        <button v-for="c in (data.candidates || [])" :key="c.id" class="qAddI" type="button" @click="addNode(c.id)">
          <span class="qAddT">{{ c.title }}</span>
          <span class="qAddM">{{ hoursLabel(c.hours_text) || fmtMin(c.minutes) || '未估' }}</span>
        </button>
        <span v-if="!(data.candidates || []).length" class="muted">路线图上没有可加的节点了</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({
  host: { type: Object, default: () => ({}) },
  goalId: { type: Number, default: 0 }
});
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const data = ref({ date: '', day: null, items: [], minutes: 120, history: [], candidates: [] });
const busy = ref(false);
const busyMsg = ref('');
const busyAt = ref(0);
const now = ref(Date.now());
const showAdd = ref(false);
let timer = null;

const items = computed(() => data.value.items || []);
const history = computed(() => (data.value.history || []).filter(x => x.date !== data.value.date && (x.planned || x.subs)).slice(0, 3));
const totalSub = computed(() => items.value.reduce((a, x) => a + ((x.subs || []).length), 0));
const doneSub = computed(() => items.value.reduce((a, x) => a + ((x.subs || []).filter(s => s.done).length), 0));
const allDone = computed(() => items.value.length > 0 && items.value.every(x => x.done));
const pct = computed(() => totalSub.value ? Math.round(100 * doneSub.value / totalSub.value) : (allDone.value ? 100 : 0));
const remainMin = computed(() => items.value.reduce((a, x) => a + (x.subs || []).filter(s => !s.done).reduce((b, s) => b + (Number(s.min) || 0), 0), 0));
const busyText = computed(() => busy.value ? busyMsg.value + '（已等 ' + Math.round((now.value - busyAt.value) / 1000) + ' 秒）' : '');

function fmtMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (!n) return '—';
  if (n % 60 === 0) return (n / 60) + 'h';
  if (n < 60) return n + 'm';
  return Math.floor(n / 60) + 'h' + (n % 60) + 'm';
}
function hoursLabel(t) {
  const s0 = String(t == null ? '' : t).trim();
  if (!s0) return '';
  return /^\d+(\.\d+)?$/.test(s0) ? s0 + 'h' : s0;
}
function stateOf(it) { return it.done ? 'done' : ((it.subs || []).some(s => s.done) ? 'doing' : 'todo'); }
function subDone(it) { return (it.subs || []).filter(s => s.done).length; }

async function reload() { data.value = await api('/api/quests?goal_id=' + props.goalId); }
function startBusy(msg) {
  busy.value = true; busyMsg.value = msg; busyAt.value = Date.now(); now.value = busyAt.value;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
}
function stopBusy() { busy.value = false; if (timer) { clearInterval(timer); timer = null; } }
async function act(msg, fn) {
  if (busy.value) return;
  startBusy(msg);
  try { await fn(); await reload(); } catch (e) { toast(e.message); }
  stopBusy();
}
async function toggleSub(it, idx, ev) {
  const checked = !!ev.target.checked;
  try {
    const r = await api('/api/quests/sub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, item_id: it.id, idx: idx, done: checked }) });
    data.value.items = r.items;
  } catch (e) { ev.target.checked = !checked; toast(e.message); }
}
async function toggleItem(it) {
  try {
    const next = !it.done;
    const r = await api('/api/quests/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, item_id: it.id, done: next }) });
    data.value.items = r.items;
    toast(next ? '这条标为完成了 ✓' : '已取消');
  } catch (e) { toast(e.message); }
}
async function markNodeDone(nid) {
  if (!window.confirm('把这个节点标为「已完成」吗？\n（路线图上的状态会变；今天这条会留在清单里作为记录）')) return;
  try { await api('/api/nodes/' + nid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) }); toast('节点已标为完成 ✓'); }
  catch (e) { toast(e.message); }
}
async function plan() {
  await act('AI 正在看你的推进情况，排今天的任务栏…', async () => {
    const r = await api('/api/quests/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, minutes: data.value.minutes }) });
    if (r.empty) { toast(r.note || '路线图上的任务都做完了'); return; }
    toast('排好了：今天 ' + fmtMin(r.total || 0) + '、' + (r.items || []).length + ' 个节点');
  });
}
async function changeMinutes() {
  const v = window.prompt('今天打算投入多少？（写分钟数，或像 1.5 这样写小时）\n常用：30 / 60 / 90 / 120 / 180', String(data.value.minutes || 120));
  if (v == null) return;
  const t = String(v).trim();
  const m = /^\d+(\.\d+)?$/.test(t) && Number(t) <= 12 ? Math.round(Number(t) * 60) : Math.round(Number(t) || 0);
  if (!m || m < 10) return toast('至少 10 分钟吧');
  await act('记下了…', async () => {
    await api('/api/quests/minutes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, minutes: m }) });
  });
  if (items.value.length && window.confirm('要按新的时间重新排一份吗？（今天已勾的进度会尽量保留）')) {
    await act('AI 正在按新的时间重排…', async () => {
      await api('/api/quests/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, minutes: m }) });
    });
  }
}
async function addNode(nodeId) {
  try {
    const r = await api('/api/quests/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: props.goalId, node_id: nodeId }) });
    data.value.items = r.items;
    showAdd.value = false;
    toast(r.already ? '这个节点已经在今天了' : '加进今天了');
  } catch (e) { toast(e.message); }
}
async function clearDay() {
  if (!window.confirm('清空今天的任务清单？（路线图上的节点状态不变）')) return;
  try { await api('/api/quests/today?goal_id=' + props.goalId, { method: 'DELETE' }); showAdd.value = false; await reload(); toast('已清空'); }
  catch (e) { toast(e.message); }
}
onMounted(async () => {
  try { await reload(); } catch (e) { data.value = { date: '', day: null, items: [], minutes: 120, history: [], candidates: [] }; toast(e.message); }
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.qPage { max-width: min(960px, 100%); }
</style>