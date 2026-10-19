<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="backGoal">← 返回目标</button>
      <h2 class="title" style="margin-left:10px;">📜 版本管理</h2>
      <span class="chip gray">{{ goalTitle }}</span>
      <div class="spacer"></div>
      <button class="btn small primary" type="button" :disabled="busy" @click="saveVersion">📌 保存当前方案</button>
    </div>
    <div class="sec">
      <div class="ppCats">
        <button type="button" class="ppCat" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部（{{ versions.length }}）</button>
        <button type="button" class="ppCat" :class="{ active: filter === 'star' }" @click="filter = 'star'">⭐ 已收藏（{{ starCount }}）</button>
        <button type="button" class="ppCat" :class="{ active: filter === 'manual' }" @click="filter = 'manual'">📌 手动保存（{{ manualCount }}）</button>
      </div>
      <p class="hint">每次规划/调整/拆分自动存档；看中的版本点 ☆ 收藏；恢复前会自动存档当前，可再 undo。点「查看对比图」逐节点看改动。</p>
    </div>
    <div class="sec">
      <div v-if="filtered.length" class="vpGrid">
        <div v-for="v in filtered" :key="v.id" class="vpItem">
          <div class="vpTop"><button class="vpStar" :class="{ on: Number(v.starred) }" type="button" :title="Number(v.starred) ? '已收藏（再点取消）' : '收藏这一版'" @click="toggleStar(v)">{{ Number(v.starred) ? '★' : '☆' }}</button><span v-if="Number(v.manual)" class="chip ok">📌 手动保存</span><span class="chip gray">{{ v.reason || '变更' }}</span><span class="hint">{{ fmtDate(v.created_at) }}</span></div>
          <div v-if="v.summary" class="vpSummary">{{ oneLine(v.summary) }}</div><div v-else class="vpSummary muted">（无汇报）</div>
          <div class="vpOps"><a class="btn small" :href="'#/g/' + goalId + '/diff/' + v.id">查看对比图</a><button class="btn small danger" type="button" :disabled="busy" title="先自动存档当前，再整体回到这一版（含任务进度状态）" @click="restore(v)">恢复到此版</button></div>
        </div>
      </div>
      <div v-else class="muted" style="padding:12px 2px;">这里还没有版本。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, goalId: { type: Number, default: 0 }, goalTitle: { type: String, default: '' } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 10));
const oneLine = (s) => String(s || '').replace(/[#*>\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const goalId = Number(props.goalId) || 0;
const goalTitle = ref(props.goalTitle || '');
const versions = ref([]);
const filter = ref('all');
const busy = ref(false);
const starCount = computed(() => versions.value.filter(v => Number(v.starred)).length);
const manualCount = computed(() => versions.value.filter(v => Number(v.manual)).length);
const filtered = computed(() => versions.value.filter(v => filter.value === 'star' ? Number(v.starred) : filter.value === 'manual' ? Number(v.manual) : true));
async function load() { try { const r = await api('/api/goals/' + goalId + '/versions'); versions.value = r.versions || []; } catch (e) { toast('加载版本历史失败：' + e.message); } try { const g = await api('/api/goals/' + goalId); if (g && g.goal && g.goal.title) goalTitle.value = g.goal.title; } catch (e) {} }
function backGoal() { location.hash = '#/g/' + goalId; }
async function saveVersion() { if (busy.value) return; const name = (window.prompt('给这版方案起个名（例如：偏实战版 / 保守版）：', '') || '').trim(); if (!name) return; busy.value = true; try { await api('/api/goals/' + goalId + '/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); await load(); toast('已保存方案「' + name + '」'); } catch (e) { toast(e.message); } busy.value = false; }
async function toggleStar(v) { if (busy.value) return; busy.value = true; try { const on = !Number(v.starred); await api('/api/versions/' + v.id + '/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: on }) }); await load(); toast(on ? '已收藏' : '已取消收藏'); } catch (e) { toast(e.message); } busy.value = false; }
async function restore(v) { if (busy.value) return; if (!window.confirm('恢复到这一版？\n\n当前方案会先自动存档（还可再 undo），然后节点（含任务进度状态）整体替换。\n教程按原节点关联，恢复后旧教程可能对不上新节点 id。')) return; busy.value = true; try { await api('/api/versions/' + v.id + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await load(); toast('已恢复到该版本'); } catch (e) { toast(e.message); } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1180px; }
.vpGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
</style>
