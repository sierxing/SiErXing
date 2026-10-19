<template>
  <div class="page">
    <div class="pageHead">
      <div class="phText"><h2 class="title">我的目标</h2><p class="phSub">说清你的目标与现状 → AI 先做问卷确认 → 拆成 阶段 · 小目标 · 任务，可随时调整</p></div>
      <div class="spacer"></div>
      <button class="btn" type="button" @click="showGuide">📖 使用引导</button>
      <button class="btn primary" type="button" @click="toggleNew">{{ showNew ? '取消新建' : '＋ 新建目标' }}</button>
      <label class="btn" title="导入别人分享的 *.share.json（含规划与资料库）">⬆ 导入分享<input type="file" accept=".json,application/json" hidden @change="importShare"></label>
    </div>

    <div v-if="!aiConfigured" class="setupCard" style="margin-bottom:14px;">
      <div class="scTitle">⚙ AI 还没配置</div>
      <p class="hint">配置 AI 之后，新建目标时就会自动做规划问卷、拆解路径。也可以先建目标，稍后再配置。</p>
      <a class="btn small" href="#/settings">去配置 AI →</a>
    </div>

    <form v-if="showNew" class="newForm" @submit.prevent="createGoal">
      <div class="field"><label>你的目标 *</label><input v-model="form.title" placeholder="如：转行成为数据分析师 / 3 个月学会前端并做出作品 / 考研上岸 / 掌握摄影后期"></div>
      <div class="grid2">
        <div class="field"><label>当前起点（基础 / 经验 / 背景）</label><textarea v-model="form.profile" placeholder="如：零基础 / 计算机专业大三，会一点 Python，没做过项目，每周能学 10 小时"></textarea></div>
        <div class="field"><label>参考资料（可选，粘贴越多规划越准）</label><textarea v-model="form.materials" placeholder="粘贴招聘 JD、课程大纲、别人总结的路线、考试大纲等，AI 会优先依据这些信息"></textarea></div>
      </div>
      <div class="grid2"><div class="field"><label>每周可投入</label><input v-model="form.hours" placeholder="如 10 小时"></div><div class="field"><label>期望期限</label><input v-model="form.deadline" placeholder="如 3 个月"></div></div>
      <div class="toolbarRow"><button class="btn primary" type="submit" :disabled="busy">{{ busy ? '创建中…' : '创建并开始 AI 规划' }}</button><button class="btn" type="button" @click="showNew = false">取消</button></div>
    </form>

    <div v-if="!goals.length && !showNew" class="emptyBox">
      <div class="ebIcon">🎯</div><div class="ebTitle">还没有目标</div>
      <div class="ebText">任何想达成的目标（转行就业、学一门技能、考研考证、做出作品…），AI 会先与你反复确认，再拆成可执行的路径。</div>
      <button class="btn primary" type="button" @click="showNew = true">＋ 新建目标</button>
    </div>

    <div v-if="goals.length" class="goalGrid">
      <div v-for="g in goals" :key="g.id" class="goalCard" @click="openGoal(g.id)">
        <div class="gcHead"><span class="gcTitle">{{ g.title }}</span><span class="chip" :class="statusOf(g).cls">{{ statusOf(g).txt }}</span><a class="btn tiny gcComps" :href="'#/components'" title="管理组件" @click.stop>🧩</a></div>
        <div v-if="g.summary" class="gcSummary">{{ oneLine(g.summary) }}</div><div v-else class="gcSummary muted">尚未生成规划</div>
        <div v-if="g.next_task" class="gcNext">▸ 下一步：{{ g.next_task }}</div>
        <div class="gcProgress"><div class="bar"><div class="barFill" :style="{ width: pct(g) + '%' }"></div></div><span class="gcPct">{{ pct(g) }}%</span></div>
        <div class="gcMeta"><span v-if="g.weekly_hours" class="chip gray">每周 {{ g.weekly_hours }}</span><span v-if="g.deadline" class="chip gray">期限 {{ g.deadline }}</span><span class="chip gray">{{ g.tasks_done || 0 }}/{{ g.tasks_total || 0 }} 任务</span><span v-if="g.updated_at" class="gcDate">更新于 {{ String(g.updated_at).slice(0, 10) }}</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const goals = ref([]);
const aiConfigured = ref(true);
const showNew = ref(false);
const busy = ref(false);
const form = reactive({ title: '', profile: '', materials: '', hours: '', deadline: '' });
const oneLine = (s) => String(s || '').replace(/[#*>\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
function pct(g) { return g.tasks_total ? Math.round((g.tasks_done || 0) / g.tasks_total * 100) : 0; }
function statusOf(g) { return ({ draft: { txt: '待规划', cls: 'warn' }, planning: { txt: '规划中', cls: '' }, planned: { txt: '已规划', cls: 'ok' }, failed: { txt: '规划失败', cls: 'danger' } })[g.status] || { txt: '未知', cls: 'gray' }; }
async function load() { try { const [r, st] = await Promise.all([api('/api/goals'), api('/api/ai/status').catch(() => ({}))]); goals.value = r.goals || []; aiConfigured.value = !!st.configured; } catch (e) { toast('加载失败：' + e.message); } }
function toggleNew() { showNew.value = !showNew.value; }
function openGoal(id) { location.hash = '#/g/' + id; }
function showGuide() { location.hash = '#/guide/0'; }
async function createGoal() {
  if (busy.value) return;
  const title = String(form.title || '').trim(); if (!title) return toast('请填写你的目标');
  busy.value = true;
  try { const r = await api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, plugins: {}, profile: form.profile, materials: form.materials, weekly_hours: form.hours, deadline: form.deadline }) }); showNew.value = false; toast('目标已创建，接下来去规划页开始 AI 问卷'); location.hash = '#/g/' + r.goal.id; }
  catch (e) { toast(e.message); } busy.value = false;
}
async function importShare(ev) { const f = (ev.target.files || [])[0]; ev.target.value = ''; if (!f) return; try { const data = JSON.parse(await f.text()); const r = await api('/api/share/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); toast('已导入分享：' + r.counts.nodes + ' 个节点 · ' + r.counts.sources + ' 条资料'); location.hash = '#/g/' + r.goalId; } catch (e) { toast(e.message); } }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1180px; }
</style>
