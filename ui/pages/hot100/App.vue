<template>
  <div class="dailyPage">
    <div class="dailyHead">
      <a class="back" :href="'#/g/' + gid">← 返回目标</a>
      <span class="mapTitle">🧩 每日刷题</span>
      <span class="chip gray">LeetCode 热题 100</span>
      <div class="spacer"></div>
      <a class="btn small" :href="'?ui=legacy#/g/' + gid + '/hot100'" title="练习设置 / 同步题单暂时在旧版">⚙ 旧版设置</a>
      <button class="btn small" type="button" :disabled="busy" @click="syncProblems">↻ 同步题单</button>
    </div>

    <div v-if="!hasProblems" class="emptyBox" style="margin-top:30px;">
      <div class="ebIcon">🧩</div><div class="ebTitle">还没有题目数据</div>
      <div class="ebText">点「同步题单」从 leetcode.cn 拉取「热题 100」并按知识点归类（需要已登录的 LeetCode 插件）。</div>
      <button class="btn primary" type="button" :disabled="busy" @click="syncProblems">立即同步热题 100</button>
    </div>

    <template v-else>
      <div class="statCards">
        <div class="statCard"><div class="scNum">{{ todayDone }}<span class="scOf">/{{ dailyItems.length }}</span></div><div class="scLabel">今日完成</div></div>
        <div class="statCard"><div class="scNum">{{ stats.solved || 0 }}<span class="scOf">/{{ stats.total || 0 }}</span></div><div class="scLabel">累计通过</div></div>
        <div class="statCard"><div class="scNum">{{ stats.streak || 0 }}<span class="scOf"> 天</span></div><div class="scLabel">连续打卡</div></div>
        <div class="statCard"><div class="scNum">{{ stats.attempts || 0 }}</div><div class="scLabel">累计作答</div></div>
      </div>

      <div class="secCard">
        <div class="secHead"><span>🔁 今日复习</span><span class="chip gray">AI 按你的遗忘风险排</span><div class="spacer"></div><span v-if="pool" class="muted" style="font-size:12px;">复习池 {{ pool }} 道<template v-if="review.overdue"> · {{ review.overdue }} 道该复习了</template></span><button class="btn tiny" type="button" :disabled="busy || !pool" @click="makePlan">{{ plan ? '换个排法' : 'AI 排今天练哪几道' }}</button></div>
        <div v-if="plan" class="pfPlan">
          <div class="pfPlanTop"><span class="pfChip risk mid">今天练 {{ planItems.length }} 道</span><div class="spacer"></div><span class="pfSub">{{ plan.date || daily.date || '' }}</span></div>
          <div v-if="plan.note" class="pfPlanNote">{{ plan.note }}</div>
          <div v-if="planItems.length" class="pfPlanGrid"><div v-for="it in planItems" :key="it.pid" class="pfTask" :class="{ done: it.done }"><div class="pfTaskTop"><span class="pfChip" :class="'diff-' + (it.difficulty || '')">{{ it.difficulty || '题' }}</span><span class="pfTaskT"><b>#{{ it.fid }}</b> {{ it.title }}</span></div><div class="pfTaskTop"><span class="pfSub">遗忘风险</span><span class="pfChip risk" :class="riskClass(it.risk)">{{ it.risk }}</span><span class="pfBar" :class="riskClass(it.risk)"><i :style="{ width: Math.max(4, Math.min(100, Number(it.risk) || 0)) + '%' }"></i></span></div><div class="pfTaskWhy">{{ it.reason || '' }}</div><div v-if="it.pitfall_open" class="pfTaskWhy"><span class="pfChip hit">⚠ {{ it.pitfall_open }} 张易错卡未攻克</span></div><div class="pfTaskFoot"><span v-if="it.done" class="pfChip fixed">✓ 今天练过了</span><span v-else class="pfSub">{{ Number(it.last_score) >= 0 ? '上次盲写 ' + it.last_score + '%' : '没盲写验证过' }}</span><div class="spacer"></div><button class="pfBtn sm ghost" type="button" @click="planDone(it)">{{ it.done ? '撤销' : '标练过' }}</button><a class="pfBtn sm go" :href="'#/p/' + it.pid">去重做 →</a></div></div></div>
          <div v-else class="pfEmpty">今天一道都没排上 —— 复习池里的题都还记着，不用练。</div>
        </div>
        <div v-else class="pfEmpty"><span class="pfEi">🔁</span>{{ pool ? '今天还没排复习。点上面「AI 排今天练哪几道」，它会看最近哪几道快忘了、踩过的坑还没攻克，再排一份清单。' : '还没有题进复习池。做对一道题就会自动进来（记一次「通过」即可）。' }}</div>
      </div>

      <div class="secCard">
        <div class="secHead"><span>📌 今日任务</span><span class="chip gray">{{ daily.date || '' }}</span><div class="spacer"></div><button class="btn tiny" type="button" :disabled="busy" @click="regenDaily">换一批</button></div>
        <div v-if="dailyItems.length" class="dailyItems"><div v-for="(it, i) in dailyItems" :key="it.pid" class="dailyItem" :class="{ done: it.done || (it.problem && it.problem.done) }"><span class="diIdx">{{ i + 1 }}</span><div class="diMain"><a class="diTitle" :href="'#/p/' + (it.problem || {}).id"><b>{{ (it.problem || {}).fid }}.</b> {{ (it.problem || {}).title }}</a><div class="diMeta"><span class="pfChip">{{ (it.problem || {}).difficulty || '题' }}</span><span v-for="x in ((it.problem || {}).groups || []).slice(0, 2)" :key="x" class="chip gray">{{ x }}</span><span class="prMeta">{{ (it.problem || {}).attempts ? '已作答 ' + (it.problem || {}).attempts + ' 次' : '未作答' }}</span></div></div><a class="btn tiny" :href="'#/p/' + (it.problem || {}).id">作答/记录</a><button class="btn tiny" :class="it.done || (it.problem && it.problem.done) ? '' : 'primary'" type="button" @click="toggleDaily(it)">{{ it.done || (it.problem && it.problem.done) ? '✓ 已完成' : '标记完成' }}</button></div></div>
        <div v-else class="muted" style="padding:12px 2px;">今天没有任务（可能已全部通过 🎉），点「换一批」重新生成。</div>
      </div>

      <div class="secCard">
        <div class="secHead"><span>📚 按知识点练习</span><div class="spacer"></div><span class="muted" style="font-size:12px;">共 {{ problems.length }} 题</span></div>
        <div class="groupList"><details v-for="gr in groups" :key="gr.name" class="probGroup" :open="!!openGroups[gr.name]"><summary @click.prevent="toggleGroup(gr.name)"><span class="pgName">{{ gr.name }}</span><span class="pgProg">{{ gr.solved }}/{{ gr.total }}</span><span class="pgBar"><i :style="{ width: gr.total ? Math.round(gr.solved / gr.total * 100) + '%' : '0%' }"></i></span></summary><div class="pgList"><div v-for="p in gr.problems" :key="p.id" class="probRow"><span class="prDot" :class="p.done ? 'done' : ''">{{ p.done ? '●' : '○' }}</span><a class="prTitle" :href="'#/p/' + p.id"><b>{{ p.fid }}.</b> {{ p.title }}</a><span class="pfChip">{{ p.difficulty || '' }}</span><span class="prMeta">{{ p.attempts ? '已作答 ' + p.attempts + ' 次' : '未作答' }}</span><div class="spacer"></div><button class="btn tiny" :class="p.done ? '' : 'primary'" type="button" @click="toggleProblem(p)">{{ p.done ? '✓ 已完成' : '标记完成' }}</button><a class="btn tiny" :href="'#/p/' + p.id">打开</a></div></div></details></div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, goalId: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const gid = Number(props.goalId) || 0;
const problems = ref([]);
const groups = ref([]);
const daily = ref({ items: [], stats: {}, date: '', hasProblems: false, settings: {} });
const review = ref({ plan: null, pool: 0, overdue: 0 });
const busy = ref(false);
const openGroups = reactive({});
const dailyItems = computed(() => (daily.value && daily.value.items) || []);
const stats = computed(() => (daily.value && daily.value.stats) || {});
const plan = computed(() => review.value && review.value.plan || null);
const planItems = computed(() => (plan.value && plan.value.items) || []);
const pool = computed(() => Number((review.value && review.value.pool) || 0));
const todayDone = computed(() => dailyItems.value.filter(i => i.done || (i.problem && i.problem.done)).length);
const hasProblems = computed(() => daily.value.hasProblems || problems.value.length > 0);
function riskClass(n) { n = Number(n) || 0; return n >= 60 ? '' : n >= 35 ? 'mid' : 'low'; }
async function load() {
  try {
    const [l, d, r] = await Promise.all([api('/api/problems'), api('/api/goals/' + gid + '/daily'), api('/api/reviews/plan?goal_id=' + gid).catch(() => ({ plan: null, pool: 0 }))]);
    problems.value = l.problems || []; groups.value = l.groups || []; daily.value = d || {}; review.value = r || {};
    for (const g of groups.value) if (openGroups[g.name] === undefined) openGroups[g.name] = false;
  } catch (e) { toast('刷题数据加载失败：' + e.message); }
}
async function refreshAll() { try { problems.value = (await api('/api/problems')).problems || []; groups.value = (await api('/api/problems')).groups || []; } catch (e) {} try { daily.value = await api('/api/goals/' + gid + '/daily'); } catch (e) {} try { review.value = await api('/api/reviews/plan?goal_id=' + gid); } catch (e) {} }
function toggleGroup(name) { openGroups[name] = !openGroups[name]; }
async function toggleDaily(it) { if (busy.value) return; const pid = Number((it.problem || {}).id || it.pid); const done = !(it.done || (it.problem && it.problem.done)); busy.value = true; try { await api('/api/goals/' + gid + '/daily/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, done }) }); await refreshAll(); toast(done ? '已完成 ✓' : '已取消'); } catch (e) { toast(e.message); } busy.value = false; }
async function toggleProblem(p) { if (busy.value) return; const done = !p.done; busy.value = true; try { await api('/api/problems/' + p.id + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done, goal_id: gid }) }); await refreshAll(); toast(done ? '已标记完成 ✓' : '已取消完成'); } catch (e) { toast(e.message); } busy.value = false; }
async function regenDaily() { if (busy.value) return; busy.value = true; try { await api('/api/goals/' + gid + '/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: Number((daily.value.settings || {}).daily_size) || 3 }) }); await refreshAll(); toast('已重新安排今日任务'); } catch (e) { toast(e.message); } busy.value = false; }
async function makePlan() { if (busy.value) return; busy.value = true; try { const r = await api('/api/reviews/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, size: Number((daily.value.settings || {}).daily_size) || 3 }) }); review.value = await api('/api/reviews/plan?goal_id=' + gid); toast(r.source === 'rule' ? 'AI 没排出来，先按风险分排了' : '排好了，今天就练这几道'); } catch (e) { toast(e.message); } busy.value = false; }
async function planDone(it) { if (busy.value) return; busy.value = true; try { await api('/api/reviews/plan/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, pid: it.pid, done: !it.done }) }); review.value = await api('/api/reviews/plan?goal_id=' + gid); toast(it.done ? '已撤销' : '记下了 ✓'); } catch (e) { toast(e.message); } busy.value = false; }
async function syncProblems() { if (busy.value) return; busy.value = true; try { const r = await api('/api/problems/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已同步：' + (r.count || r.total || '完成')); await load(); } catch (e) { toast('同步失败：' + e.message); } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.dailyPage { max-width: 1180px; }
</style>
