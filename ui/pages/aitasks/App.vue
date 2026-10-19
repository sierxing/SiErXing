<template>
  <div class="page aitPage">
    <div class="pageHead">
      <h2 class="title">🤖 AI 任务中心</h2>
      <span class="muted" style="font-size:12.5px;">{{ hint }}</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" @click="refresh">刷新</button>
    </div>

    <div class="aitFilters">
      <input v-model="filter.q" class="aitQ" type="search" placeholder="搜任务标题…" @input="onFilterInput">
      <select v-model.number="filter.goal" class="sxi-sel" @change="refresh">
        <option :value="0">全部目标</option>
        <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
      </select>
      <select v-model="filter.status" class="sxi-sel" @change="refresh">
        <option value="">全部状态</option>
        <option value="done">完成</option>
        <option value="failed">失败</option>
        <option value="cancelled">已停止</option>
      </select>
      <select v-model.number="filter.days" class="sxi-sel" @change="refresh">
        <option :value="0">全部时间</option>
        <option :value="1">最近 24 小时</option>
        <option :value="7">最近 7 天</option>
        <option :value="30">最近 30 天</option>
      </select>
      <span class="spacer"></span>
      <span class="aitSum"><span class="aitSt done">✓ {{ summary.done || 0 }}</span><span class="aitSt failed">✗ {{ summary.failed || 0 }}</span><span class="aitSt cancelled">⏹ {{ summary.cancelled || 0 }}</span><span class="muted">共 {{ summary.total || 0 }} 条</span></span>
    </div>

    <div v-if="running.length" class="aitSec">
      <div class="aitSecT">正在执行<span class="aitSecN">{{ running.length }}</span><span class="aitSecSub">{{ runningCount }} 个在跑 · {{ running.length - runningCount }} 个排队</span></div>
      <div class="aitRunGrid">
        <div v-for="t in running" :key="t.id" class="aitRun" :class="statusMeta(t.status).cls">
          <div class="aitRunHd">
            <span class="aitRunIco">{{ typeMeta(t.type).icon }}</span>
            <span class="aitRunTitle" :title="t.title">{{ t.title || typeMeta(t.type).label }}</span>
            <span class="aitSt" :class="statusMeta(t.status).cls">{{ statusMeta(t.status).text }}</span>
          </div>
          <div class="aitRunSub">{{ t.goalTitle || '（无目标）' }}<template v-if="t.nodeId"> · 节点 #{{ t.nodeId }}</template></div>
          <div class="taskProg" :title="'进度 ' + Math.round(t.progress || 0) + '%'"><i :style="{ width: Math.max(0, Math.min(100, Number(t.progress || 0))) + '%' }"></i></div>
          <div class="aitRunMsg"><span>{{ t.message || t.phaseLabel || '准备中…' }}</span><span v-if="t.total" class="muted">{{ t.done || 0 }} / {{ t.total }}</span><span v-if="t.pctSource === 'time'" class="chip gray">估算</span></div>
          <div class="aitRunFoot">
            <span class="muted" style="font-size:11.5px;">{{ fmtDur(t.elapsedMs) }}</span>
            <div class="spacer"></div>
            <button class="btn tiny" type="button" :disabled="cancelling[t.id]" @click="cancelTask(t)">{{ cancelling[t.id] ? '停止中…' : '停止' }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="aitSec">
      <div class="aitSecT">历史记录<span class="aitSecSub">按目标分组，点开才读记录</span><div class="spacer"></div><button class="btn tiny" type="button" :disabled="!groups.length" @click="toggleAll">{{ allOpen ? '收起全部' : '展开全部' }}</button></div>
      <div v-if="!groups.length" class="aitNone">{{ summary.total ? '没有符合筛选条件的记录。' : '还没有跑完的 AI 任务记录。' }}</div>
      <div v-for="g in groups" :key="g.goalId" class="aitGrp" :class="{ open: isOpen(g.goalId) }">
        <button class="aitGrpHd" type="button" :aria-expanded="isOpen(g.goalId) ? 'true' : 'false'" @click="toggleGroup(g.goalId)">
          <span class="aitGrpCaret">{{ isOpen(g.goalId) ? '▾' : '▸' }}</span>
          <span class="aitGrpName" :title="g.goalTitle">{{ g.goalTitle }}</span>
          <span class="aitGrpNums">
            <span class="aitSt done">✓ {{ g.done }}</span>
            <span v-if="g.failed" class="aitSt failed">✗ {{ g.failed }}</span>
            <span v-if="g.cancelled" class="aitSt cancelled">⏹ {{ g.cancelled }}</span>
            <span class="aitGrpTotal">共 {{ g.total }}</span>
          </span>
          <span class="aitGrpLast">{{ g.lastAt ? '最近 ' + when(g.lastAt) : '' }}</span>
        </button>
        <div v-if="isOpen(g.goalId)" class="aitGrpBody">
          <div v-if="!boxOf(g.goalId) || boxOf(g.goalId).loading && !boxOf(g.goalId).rows.length" class="aitNone">正在读取…</div>
          <template v-else>
            <div class="aitRowHead"><span></span><span></span><span>状态</span><span>时间</span><span>操作</span></div>
            <div v-for="r in boxOf(g.goalId).rows" :key="r.runId" class="aitRowWrap">
              <div class="aitRow" :class="{ hasErr: r.error }" :title="'去目标：' + r.goalTitle" @click="goGoal(r.goalId)">
                <span class="aitRowIcon">{{ typeMeta(r.type).icon }}</span>
                <span class="aitRowTitle">{{ r.title || typeMeta(r.type).label }}</span>
                <span class="aitSt" :class="statusMeta(r.status).cls">{{ statusMeta(r.status).text }}</span>
                <span class="aitRowMeta">{{ when(r.createdAt) }}<template v-if="r.costMs"> · {{ fmtDur(r.costMs) }}</template></span>
                <span class="aitRowOps"><button v-if="r.error" class="btn tiny" type="button" @click.stop="toggleErr(r.runId)">看原因</button><button v-if="r.status === 'failed'" class="btn tiny" type="button" :disabled="retrying[r.runId]" @click.stop="retryTask(r)">{{ retrying[r.runId] ? '重试中…' : '重试' }}</button></span>
              </div>
              <div v-if="r.error && errOpen[r.runId]" class="aitErrBox">{{ r.error }}</div>
            </div>
            <div class="aitMore"><button v-if="boxOf(g.goalId).hasMore" class="btn tiny" type="button" :disabled="boxOf(g.goalId).loading" @click="loadGroup(g.goalId, true)">{{ boxOf(g.goalId).loading ? '读取中…' : '再看 ' + Math.min(20, Math.max(0, boxOf(g.goalId).total - boxOf(g.goalId).rows.length)) + ' 条' }}</button><span v-else class="muted" style="font-size:11.5px;">已显示全部 {{ boxOf(g.goalId).rows.length }} 条</span></div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const go = (h) => { try { props.host.go ? props.host.go(h) : (location.hash = h); } catch (e) { location.hash = h; } };
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };

const loading = ref(true);
const running = ref([]);
const summary = ref({ total: 0, done: 0, failed: 0, cancelled: 0 });
const groups = ref([]);
const goals = ref([]);
const filter = reactive({ q: '', goal: 0, status: '', days: 0 });
const boxes = reactive({});
const open = reactive({});
const cancelling = reactive({});
const retrying = reactive({});
const errOpen = reactive({});
let timer = null;
let filterTimer = null;

const runningCount = computed(() => running.value.filter(t => t.status === 'running').length);
const hint = computed(() => (running.value.length ? running.value.length + ' 个正在执行 · ' : '') + '历史 ' + (summary.value.total || 0) + ' 条');
const allOpen = computed(() => groups.value.length > 0 && groups.value.every(g => open[g.goalId]));

const TYPE_META = {
  tutorial: { icon: '📘', label: '生成教程' }, tutorial_edit: { icon: '✏️', label: '修改教程' },
  quests: { icon: '✅', label: '今日任务' }, plan: { icon: '🗺', label: '生成规划' },
  collect: { icon: '🔎', label: '搜集资料' }, digest: { icon: '📄', label: '信息提炼' },
  explain: { icon: '🔍', label: '看懂代码' }, quiz: { icon: '📝', label: '随堂测验' },
  jdfile: { icon: '📥', label: '导入资料' }, restate: { icon: '🗣', label: '用自己的话' },
  bench: { icon: '🧪', label: '检索评测' }, clean: { icon: '🧹', label: '清洗资料' },
  refetch: { icon: '🔄', label: '补抓正文' }, image: { icon: '🖼', label: '识别图片' }
};
function typeMeta(type) { return TYPE_META[type] || { icon: '🤖', label: String(type || '任务') }; }
const ST = { running: { text: '执行中', cls: 'running' }, queued: { text: '排队中', cls: 'queued' }, done: { text: '完成', cls: 'done' }, failed: { text: '失败', cls: 'failed' }, cancelled: { text: '已停止', cls: 'cancelled' } };
function statusMeta(s) { return ST[s] || { text: String(s || ''), cls: 'done' }; }
function boxOf(id) { return boxes[id]; }
function isOpen(id) { return !!open[id]; }
function query(extra) {
  const p = new URLSearchParams();
  if (filter.goal) p.set('goal', filter.goal);
  if (filter.status) p.set('status', filter.status);
  if (filter.days) p.set('days', filter.days);
  if (String(filter.q || '').trim()) p.set('q', String(filter.q).trim());
  if (extra) for (const k of Object.keys(extra)) { if (extra[k] != null && extra[k] !== '') p.set(k, extra[k]); }
  return p.toString() ? '?' + p.toString() : '';
}
function when(s) {
  if (!s) return '';
  const t = new Date(String(s).replace(' ', 'T'));
  if (isNaN(t.getTime())) return String(s).slice(0, 16);
  const d = Date.now() - t.getTime();
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
  return String(s).replace('T', ' ').slice(0, 10);
}
function fmtDur(ms) {
  ms = Number(ms || 0);
  if (!ms) return '';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' 秒';
  return Math.round(ms / 60000) + ' 分钟';
}
async function refresh() {
  try {
    const d = await api('/api/ai-tasks' + query());
    running.value = d.running || [];
    summary.value = d.summary || { total: 0, done: 0, failed: 0, cancelled: 0 };
    groups.value = d.groups || [];
    goals.value = d.goals || goals.value;
    const ids = new Set(groups.value.map(g => String(g.goalId)));
    if (filter.goal) { /* 单目标筛选时只展开这一组 */ if (!open[filter.goal] && groups.value.length === 1) toggleGroup(groups.value[0].goalId); }
    for (const k of Object.keys(open)) if (open[k] && !ids.has(String(k)) && !filter.goal) { delete open[k]; }
  } catch (e) { toast('任务中心加载失败：' + e.message); }
}
async function loadGroup(goalId, more) {
  const id = Number(goalId);
  const cur = boxes[id] || (boxes[id] = { rows: [], total: 0, hasMore: false, loading: false });
  if (cur.loading) return;
  cur.loading = true;
  try {
    const r = await api('/api/ai-tasks/history' + query({ goal: id, limit: 20, offset: more ? cur.rows.length : 0 }));
    cur.rows = more ? cur.rows.concat(r.rows || []) : (r.rows || []);
    cur.total = r.total || 0;
    cur.hasMore = !!r.hasMore;
  } catch (e) { toast('记录读取失败：' + e.message); }
  cur.loading = false;
}
function toggleGroup(goalId) {
  const id = Number(goalId);
  open[id] = !open[id];
  if (open[id] && !boxes[id]) loadGroup(id, false);
}
function toggleAll() {
  if (allOpen.value) { for (const g of groups.value) open[g.goalId] = false; }
  else { for (const g of groups.value) { open[g.goalId] = true; if (!boxes[g.goalId]) loadGroup(g.goalId, false); } }
}
function toggleErr(id) { errOpen[id] = !errOpen[id]; }
function onFilterInput() {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { resetBoxes(); refresh(); }, 300);
}
function resetBoxes() { for (const k of Object.keys(boxes)) delete boxes[k]; for (const k of Object.keys(open)) delete open[k]; }
function goGoal(gid) { if (gid) go('#/g/' + gid); }
async function cancelTask(t) {
  if (cancelling[t.id]) return;
  if (!window.confirm('停止任务「' + (t.title || typeMeta(t.type).label) + '」？')) return;
  cancelling[t.id] = true;
  try { await api('/api/tasks/' + t.id + '/cancel', { method: 'POST' }); toast('已请求停止'); await refresh(); }
  catch (e) { toast('停止失败：' + e.message); }
  cancelling[t.id] = false;
}
async function retryTask(r) {
  if (retrying[r.runId]) return;
  retrying[r.runId] = true;
  try { await api('/api/tasks/' + r.runId + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已重新提交'); await refresh(); }
  catch (e) { toast('重试失败：' + e.message); }
  retrying[r.runId] = false;
}
onMounted(async () => {
  await refresh();
  loading.value = false;
  timer = setInterval(() => { if (running.value.length) refresh(); }, 3000);
});
onUnmounted(() => { if (timer) clearInterval(timer); if (filterTimer) clearTimeout(filterTimer); });
</script>

<style scoped>
.aitPage { max-width: 1180px; }
.aitFilters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.aitQ { width: 220px; }
.aitSum { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.aitRunMsg { display: flex; align-items: center; gap: 8px; font-size: 12px; min-height: 18px; }
.aitRowOps { display: flex; gap: 4px; justify-content: flex-end; }
</style>
