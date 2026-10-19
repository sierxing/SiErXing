<template>
  <div class="page">
    <div class="pageHead">
      <a class="back" :href="'#/g/' + goalId">← 返回</a>
      <span class="mapTitle">🧪 检索增强评测</span>
      <span class="chip gray">同一批题 · 只差给不给资料</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="doGen">✨ AI 出题</button>
      <button class="btn small" type="button" :disabled="busy" @click="doAdd">＋ 手动加题</button>
      <button class="btn small primary" type="button" :disabled="busy || !questions.length" @click="doRun">▶ 开始评测</button>
    </div>

    <div class="rbTip">
      <span>🧪</span>
      <span>想验证「接上向量模型后 RAG 到底有没有用」，就看这里：<b>同一批题、同一个模型，唯一差别是提示词里有没有把资料检索出来</b>。得分按要点命中率算，阅卷时不知道答案来自哪一臂。</span>
    </div>

    <div v-if="runs.length" class="rbCard">
      <template v-if="runs[0].status === 'running'">
        <div class="rbRunning">评测进行中…（已处理 {{ runs[0].done }}/{{ runs[0].total }} 题，进度见左下角任务中心）</div>
      </template>
      <template v-else-if="runs[0].status !== 'done'">
        <div class="rbBad">上次评测未完成：{{ runs[0].error || runs[0].status }}</div>
      </template>
      <template v-else>
        <div class="rbSumHead">
          <b>最近一次评测</b>
          <span class="muted">{{ fmtTime(runs[0].created_at) }} · {{ (runs[0].summary || {}).questions || 0 }} 道题 · 模型 {{ runs[0].model || '—' }}</span>
          <span class="spacer"></span>
          <span class="rbDelta" :class="deltaClass">{{ deltaText }}</span>
        </div>
        <div class="rbArms">
          <div class="rbArm"><span class="rbArmT">有 RAG</span><b class="rbBig">{{ pct(summary.rag && summary.rag.avg) }}</b><span class="rbBar"><i class="ok" :style="{ width: barPct(summary.rag && summary.rag.avg) + '%' }"></i></span><span class="muted">命中 {{ summary.ragHit || 0 }} 个要点</span></div>
          <div class="rbArm"><span class="rbArmT">无 RAG</span><b class="rbBig">{{ pct(summary.norag && summary.norag.avg) }}</b><span class="rbBar"><i class="warn" :style="{ width: barPct(summary.norag && summary.norag.avg) + '%' }"></i></span><span class="muted">命中 {{ summary.noragHit || 0 }} 个要点</span></div>
          <div class="rbArm rbArmNote">
            <div class="muted" style="font-size:12px;line-height:1.7;">
              同一批题、同一个模型、同一套提示词，<b>唯一差别是有没有把资料检索出来喂给模型</b>。<br>
              得分 = 命中要点数 ÷ 要点总数（阅卷时不知道答案来自哪一臂）。<br>
              {{ conclusion }}
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-if="detail && detail.items && detail.items.length" class="rbCard">
      <div class="rbSumHead"><b>逐题对比</b><span class="muted">点题目展开两臂的原话</span></div>
      <details v-for="(it, idx) in detail.items" :key="idx" class="rbItem">
        <summary>
          <span class="rbQ">{{ (it.question || {}).q }}</span>
          <span class="rbScores">
            <span class="rbTag" :class="{ win: winOf(it) === 'rag' }">有RAG {{ pct((it.rag || {}).score) }}</span>
            <span class="rbTag" :class="{ win: winOf(it) === 'norag' }">无RAG {{ pct((it.norag || {}).score) }}</span>
          </span>
        </summary>
        <div class="rbAnsWrap">
          <div class="rbAns"><div class="rbAnsT">要点（✓ 为被判定命中）</div><ul class="rbPts"><li v-for="(p, i) in pointsOf(it)" :key="i" :class="hitOf(it, i) ? 'hit' : 'miss'">{{ p }}</li></ul></div>
          <div class="rbAnsCols">
            <div class="rbAns"><div class="rbAnsT">有 RAG 的作答</div><div class="rbAnsBody">{{ (it.rag || {}).answer }}</div></div>
            <div class="rbAns"><div class="rbAnsT">无 RAG 的作答</div><div class="rbAnsBody">{{ (it.norag || {}).answer }}</div></div>
          </div>
        </div>
      </details>
    </div>

    <div class="rbCard">
      <div class="rbSumHead"><b>题库</b><span class="muted">共 {{ questions.length }} 道</span></div>
      <div v-if="!questions.length" class="rbEmpty">还没有题目。点上面「AI 出题」从资料里生成，或「手动加题」自己写。</div>
      <div v-else class="rbQs">
        <div v-for="(q, i) in questions" :key="q.id" class="rbQRow">
          <span class="rbQIdx">{{ i + 1 }}</span>
          <div class="rbQMain"><div class="rbQText">{{ q.q }}</div>
            <div class="rbQPts muted">要点 {{ (q.points || []).length }} 个：{{ (q.points || []).join('；').slice(0, 80) }}{{ (q.points || []).join('；').length > 80 ? '…' : '' }}</div>
          </div>
          <button class="btn tiny danger" type="button" :disabled="busy" @click="delQuestion(q.id)">删除</button>
        </div>
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
const questions = ref([]);
const runs = ref([]);
const detail = ref(null);
const busy = ref(false);
let pollTimer = null;

const summary = computed(() => (runs.value[0] && runs.value[0].summary) || {});
const delta = computed(() => Number(summary.value.delta || 0));
const deltaClass = computed(() => delta.value > 0 ? 'up' : (delta.value < 0 ? 'down' : ''));
const deltaText = computed(() => (delta.value > 0 ? '▲' : (delta.value < 0 ? '▼' : '·')) + ' ' + (delta.value * 100).toFixed(0) + ' 个百分点');
const conclusion = computed(() => {
  const d = delta.value;
  if (d > 0.05) return '结论：RAG 有明显帮助，资料确实被用上了。';
  if (d < -0.05) return '结论：这次没 RAG 反而更高，可能是题目不依赖资料，或检索没命中。';
  return '结论：两者接近，说明这些题的答案不太依赖你的资料（可换更贴合资料的题）。';
});

function pct(x) { return (Number(x || 0) * 100).toFixed(0) + '%'; }
function barPct(x) { return Math.max(0, Math.min(100, Math.round(Number(x || 0) * 100))); }
function fmtTime(s) { return String(s || '').replace('T', ' ').replace('Z', '').slice(0, 16); }
function winOf(it) {
  const rg = Number((it.rag || {}).score || 0), no = Number((it.norag || {}).score || 0);
  return rg > no ? 'rag' : (no > rg ? 'norag' : 'tie');
}
function pointsOf(it) { return ((it.question || {}).points) || []; }
function hitOf(it, i) { return (((it.rag || {}).hits) || []).indexOf(i) >= 0; }

async function load() {
  try { questions.value = ((await api('/api/goals/' + props.goalId + '/bench/questions')).questions) || []; } catch (e) { questions.value = []; }
  try { runs.value = ((await api('/api/goals/' + props.goalId + '/bench/runs')).runs) || []; } catch (e) { runs.value = []; }
  const done = runs.value.find(r => r.status === 'done');
  if (done && (!detail.value || detail.value.run.id !== done.id)) {
    try { detail.value = await api('/api/bench/runs/' + done.id); } catch (e) { detail.value = null; }
  }
}
async function draw() { await load(); }

async function doGen() {
  if (busy.value) return;
  const n = window.prompt('生成几道题？（建议 8~12）', '8');
  if (n == null) return;
  busy.value = true;
  try {
    const r = await api('/api/goals/' + props.goalId + '/bench/gen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: Number(n) || 8 }) });
    toast('已开始出题（采样 ' + r.sampled + ' 个资料片段），完成后会自动刷新');
    waitTask(r.taskId);
  } catch (e) { toast('出题失败：' + e.message); busy.value = false; }
}
async function doAdd() {
  const q = window.prompt('题目：');
  if (!q) return;
  const ps = window.prompt('要点（每行一个，用于判分）：');
  if (ps == null) return;
  try {
    await api('/api/goals/' + props.goalId + '/bench/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, points: ps.split('\n') }) });
    await draw();
    toast('已添加');
  } catch (e) { toast('添加失败：' + e.message); }
}
async function doRun() {
  if (busy.value) return;
  const limit = window.prompt('跑几道题？（留空=全部 ' + questions.value.length + ' 道；每题要 4 次 AI 调用，越少越快）', '');
  if (limit == null) return;
  busy.value = true;
  try {
    const r = await api('/api/goals/' + props.goalId + '/bench/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: Number(limit) || 0 }) });
    toast('评测已开始（' + r.total + ' 道题），进度见左下角任务中心');
    waitTask(r.taskId);
  } catch (e) { toast('启动失败：' + e.message); busy.value = false; }
}
async function delQuestion(id) {
  if (!window.confirm('删除这道题？')) return;
  try { await api('/api/bench/questions/' + id + '/delete', { method: 'POST' }); await draw(); }
  catch (e) { toast('删除失败：' + e.message); }
}
async function waitTask(taskId) {
  if (pollTimer) clearTimeout(pollTimer);
  const tick = async () => {
    try {
      const r = await api('/api/tasks');
      const t = (r.tasks || []).find(x => Number(x.id) === Number(taskId));
      if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) {
        busy.value = false;
        if (t && t.status !== 'done' && t.error) toast('任务结束：' + t.error);
        await draw();
        return;
      }
    } catch (e) {}
    pollTimer = setTimeout(tick, 2500);
  };
  pollTimer = setTimeout(tick, 2500);
}

onMounted(async () => {
  try { await draw(); } catch (e) { toast(e.message); }
});
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer); });
</script>

<style scoped>
.page { max-width: 1100px; }
</style>
