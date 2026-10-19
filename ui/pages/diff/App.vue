<template>
  <div class="diffPage">
    <div class="diffHead">
      <button class="back" type="button" @click="backVersions">← 返回版本管理</button>
      <span class="mapTitle">{{ goalTitle }} · 路线变更对比</span>
      <span class="chip">{{ version.reason || '变更' }}</span>
      <span class="hint">{{ fmtDate(version.created_at) }} 的版本 ↔ 当前</span>
      <div class="spacer"></div>
      <span class="diffLegend"><span class="lgdot added"></span>新增 <span class="lgdot removed"></span>移除 <span class="lgdot changed"></span>修改 <span class="lgdot"></span>未变</span>
    </div>
    <div v-if="version.summary" class="reportCard" style="margin-bottom:14px;"><div class="rcHead"><span>📋</span><span>AI 变更汇报</span></div><div class="rcText mdBody" v-html="md(version.summary)"></div></div>
    <div class="diffCols">
      <div class="diffCol"><div class="diffColHead">修改前（{{ oldCount }} 节点）</div><div class="diffBody"><div v-for="row in oldRows" :key="row.id" class="diffRow" :class="row.cls" :style="{ paddingLeft: (8 + row.depth * 14) + 'px' }" :title="row.key"><span class="diffDot"></span><span class="diffTitle">{{ row.title }}</span><span v-if="row.hours" class="mtHours">{{ row.hours }}</span></div><div v-if="!oldRows.length" class="empty">（无内容）</div></div></div>
      <div class="diffCol"><div class="diffColHead">当前（{{ newCount }} 节点）</div><div class="diffBody"><div v-for="row in newRows" :key="row.id" class="diffRow" :class="row.cls" :style="{ paddingLeft: (8 + row.depth * 14) + 'px' }" :title="row.key"><span class="diffDot"></span><span class="diffTitle">{{ row.title }}</span><span v-if="row.hours" class="mtHours">{{ row.hours }}</span></div><div v-if="!newRows.length" class="empty">（无内容）</div></div></div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, goalId: { type: Number, default: 0 }, versionId: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 10));
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || '')) : String(s || ''); } catch (e) { return String(s || ''); } };
const gid = Number(props.goalId) || 0;
const vid = Number(props.versionId) || 0;
const data = ref({});
const version = computed(() => data.value.version || {});
const goalTitle = computed(() => (data.value.goal && data.value.goal.title) || '');
function buildTree(nodes) { const list = Array.isArray(nodes) ? nodes : []; const byId = {}; for (const n of list) byId[n.id] = Object.assign({}, n, { children: [] }); const roots = []; for (const n of list) { const x = byId[n.id]; if (x.parent_id && byId[x.parent_id]) byId[x.parent_id].children.push(x); else roots.push(x); } const byOrder = (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)); roots.sort(byOrder); for (const n of list) byId[n.id].children.sort(byOrder); return roots; }
function keyOfNode(nodes, n) { const byId = {}; for (const x of nodes) byId[x.id] = x; let k = String(n.title || ''); let p = n.parent_id ? byId[n.parent_id] : null; while (p) { k = String(p.title || '') + ' / ' + k; p = p.parent_id ? byId[p.parent_id] : null; } return k; }
function nodeChanged(a, b) { return ['detail', 'artifact', 'acceptance', 'hours', 'sources', 'status'].some(f => String(a[f] || '') !== String(b[f] || '')); }
function rowsFor(side) {
  const nodes = side === 'old' ? (data.value.old_nodes || []) : (data.value.new_nodes || []);
  const other = side === 'old' ? (data.value.new_nodes || []) : (data.value.old_nodes || []);
  const otherKeyMap = {};
  for (const n of other) otherKeyMap[keyOfNode(other, n)] = n;
  const rows = [];
  const walk = (n, depth) => {
    const key = keyOfNode(nodes, n); const o = otherKeyMap[key]; let cls = '';
    if (side === 'old') { if (!o) cls = 'removed'; else if (nodeChanged(n, o)) cls = 'changed'; }
    else { if (!o) cls = 'added'; else if (nodeChanged(o, n)) cls = 'changed'; }
    rows.push({ id: side + '-' + n.id, depth: depth, cls: cls, key: key, title: n.title, hours: n.hours });
    for (const c of (n.children || [])) walk(c, depth + 1);
  };
  for (const r of buildTree(nodes)) walk(r, 0);
  return rows;
}
const oldRows = computed(() => rowsFor('old'));
const newRows = computed(() => rowsFor('new'));
const oldCount = computed(() => oldRows.value.length);
const newCount = computed(() => newRows.value.length);
function backVersions() { location.hash = '#/g/' + gid + '/versions'; }
onMounted(async () => {
  try { data.value = await api('/api/versions/' + vid); } catch (e) { toast('加载对比失败：' + e.message); }
});
</script>

<style scoped>
.diffPage { max-width: 1280px; }
</style>
