<template>
  <div class="probPage">
    <div class="probSticky">
      <div class="probHead">
        <a class="back" :href="'#/g/' + goalId + '/hot100'">← 每日刷题</a>
        <h2 class="probTitle">{{ p.fid }}. {{ p.title }}</h2>
        <span class="pfChip" :class="'diff-' + (p.difficulty || '')">{{ p.difficulty || '题' }}</span>
        <span v-for="t in (p.tags || [])" :key="t" class="chip gray">{{ t }}</span>
        <span class="chip gray">Vue 插件</span>
        <div class="spacer"></div>
        <button class="btn small" :class="done ? '' : 'primary'" type="button" :disabled="busy" @click="toggleDone">{{ done ? '✓ 已完成' : '标记完成' }}</button>
        <button class="btn small primary" type="button" :disabled="busy" @click="openIDE">💻 在 VSCode 中作答</button>
        <a class="btn small" :href="p.link || '#'" target="_blank" rel="noopener">打开 LeetCode</a>
        <button class="btn small" type="button" :disabled="busy" @click="refreshStatement">↻ 刷新题面</button>
        <button v-if="!review" class="btn small" type="button" :disabled="busy" @click="enqueue">＋ 加入复习流</button>
        <button v-else class="btn small danger" type="button" :disabled="busy" @click="dequeue">移出复习流</button>
        <a class="btn small" :href="legacyHref" title="思路卡 / 易错卡片 / 盲写考核 / 作答记录编辑暂时在旧版">⋯ 旧版</a>
      </div>
    </div>
    <div class="probMeta">
      <span v-if="done" class="chip ok">{{ p.passed ? '已通过' : '已完成' }}</span>
      <span v-else-if="records.length" class="chip warn">未通过（已作答 {{ records.length }} 次）</span>
      <span v-else class="chip gray">未作答</span>
      <span class="muted">知识点：{{ (p.groups || []).join(' / ') || '—' }}</span>
      <span v-if="review" class="pfChip risk" :class="riskClass(review.risk)">🔁 遗忘风险 {{ review.risk }}<template v-if="review.last_review_at"> · 上次 {{ String(review.last_review_at).slice(0, 10) }}</template><template v-else> · 还没复习过</template></span>
      <span v-else class="chip gray">不在复习流</span>
      <span v-if="notice" class="chip danger">题面获取提示：{{ notice }}</span>
    </div>
    <div class="probCols">
      <div class="secCard probStmtCard">
        <div class="secHead"><span>📄 题目描述</span><div class="spacer"></div><span v-if="p.statement_at" class="muted" style="font-size:11.5px;">缓存于 {{ fmtDate(p.statement_at) }}</span></div>
        <div class="lcStatement" v-html="p.statement || '<p class=\'muted\'>暂无题面，点「刷新题面」重试。</p>'"></div>
      </div>
      <div class="secCard probRecCard">
        <div class="secHead"><span>📝 我的作答记录（{{ records.length }}）</span><div class="spacer"></div><a class="btn tiny" :href="legacyHref" title="新增/编辑作答记录暂时在旧版">＋ 记录一次作答（旧版）</a></div>
        <div v-if="records.length" class="recList">
          <div v-for="r in records" :key="r.id" class="recItem">
            <div class="recTop"><span class="recDate">{{ r.date }}</span><span class="chip" :class="r.passed ? 'ok' : 'gray'">{{ r.passed ? '通过' : '未通过' }}</span><span class="chip gray">{{ r.language || '代码' }}</span><span v-if="r.minutes" class="muted">用时 {{ r.minutes }} 分钟</span><div class="spacer"></div><span v-if="r.notes" class="muted recNote">{{ r.notes }}</span></div>
            <details v-if="r.code" class="recCode"><summary>看这次写的代码</summary><pre>{{ r.code }}</pre></details>
          </div>
        </div>
        <div v-else class="pfEmpty">还没有作答记录。去 VSCode 刷一遍，或者在旧版里补一条。</div>
      </div>
    </div>
    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>🧭 思路卡</span><div class="spacer"></div><span class="muted" style="font-size:12px;">{{ allPits.length }} 张易错卡 · {{ openPits }} 张未攻克</span></div>
      <div v-if="mind.approach" class="mindApproach">{{ mind.approach }}</div>
      <div v-else class="pfEmpty">还没有思路卡。旧版里的「引导提炼思路」可以用 AI 帮你整理。</div>
      <div v-if="allPits.length" class="pitMini"><span v-for="c in allPits.slice(0, 8)" :key="c.id" class="pfPitTag" :class="'t-' + (c.status || 'open')" :title="c.text || c.title || ''">{{ c.title || c.text || ('易错点 #' + c.id) }}</span></div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, problemId: { type: Number, default: 0 }, goalId: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 10));
const pid = Number(props.problemId) || 0;
const gid = Number(props.goalId) || 0;
const p = ref({});
const records = ref([]);
const notice = ref('');
const done = ref(false);
const mind = ref({});
const busy = ref(false);
const review = computed(() => (mind.value && mind.value.review) || null);
const allPits = computed(() => (mind.value && mind.value.pitfalls) || []);
const openPits = computed(() => allPits.value.filter(x => x.status === 'open').length);
const legacyHref = computed(() => '?ui=legacy#/p/' + pid);
function riskClass(n) { n = Number(n) || 0; return n >= 60 ? '' : n >= 35 ? 'mid' : 'low'; }
async function load() {
  try {
    const [d, m] = await Promise.all([api('/api/problems/' + pid), api('/api/problems/' + pid + '/mind').catch(() => ({ approach: '', pitfalls: '', review: null }))]);
    p.value = d.problem || {}; records.value = d.records || []; notice.value = d.notice || ''; done.value = !!d.done; mind.value = m || {};
  } catch (e) { toast('题目加载失败：' + e.message); }
}
async function toggleDone() {
  if (busy.value) return; busy.value = true;
  try { await api('/api/problems/' + pid + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: !done.value, goal_id: gid }) }); await load(); toast(done.value ? '已标记完成 ✓' : '已取消完成'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function refreshStatement() {
  if (busy.value) return; busy.value = true;
  try { const d = await api('/api/problems/' + pid + '?refresh=1'); p.value = d.problem || p.value; notice.value = d.notice || ''; toast('题面已更新'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function openIDE() {
  if (busy.value) return; busy.value = true;
  try { const r = await api('/api/problems/' + pid + '/ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已用 VSCode 打开：' + r.file.split('/').pop() + (r.created ? '（已生成模板）' : '')); }
  catch (e) { toast('打开失败：' + e.message); } busy.value = false;
}
async function enqueue() {
  if (busy.value) return; busy.value = true;
  try { await api('/api/reviews/' + pid + '/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid }) }); await load(); toast('已加入复习流 ✓'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function dequeue() {
  if (!window.confirm('移出复习流？思路卡、易错卡片、盲写记录都保留，只是以后不再被排进今天的清单。')) return;
  if (busy.value) return; busy.value = true;
  try { await api('/api/reviews/' + pid, { method: 'DELETE' }); await load(); toast('已移出复习'); }
  catch (e) { toast(e.message); } busy.value = false;
}
onMounted(load);
</script>

<style scoped>
.probPage { max-width: 1280px; }
.mindApproach { white-space: pre-wrap; line-height: 1.7; padding: 6px 2px; }
.pitMini { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.recCode pre { max-height: 300px; overflow: auto; }
</style>
