<template>
  <div class="apVue" style="display:flex;flex-direction:column;height:100%;">
    <div class="apTabs">
      <button type="button" :class="{ active: tab === 'pick' }" @click="switchTab('pick')">选择</button>
      <button type="button" :class="{ active: tab === 'manage' }" @click="switchTab('manage')">管理</button>
      <div class="spacer"></div><button class="apX" type="button" title="关闭" @click="close">×</button>
    </div>
    <div class="apBody">
      <template v-if="tab === 'pick'">
        <input v-model="query" placeholder="🔍 搜索提示词…">
        <div class="apCats"><button type="button" :class="{ active: filterCat === '' }" @click="filterCat = ''">全部</button><button v-for="[c, n] in cats" :key="c" type="button" :class="{ active: filterCat === c }" @click="filterCat = c">{{ c }}({{ n }})</button></div>
        <div class="apList">
          <button v-for="p in filtered" :key="p.id" class="apItem" type="button" :title="String(p.content || '').slice(0, 200)" @click="insert(p)"><span class="apItemT">{{ p.title || String(p.content || '').slice(0, 30) }}</span><span class="apItemC">{{ catName(p.category) }}</span></button>
          <div v-if="!filtered.length" class="muted" style="padding:10px 2px;">没有匹配的提示词，去「管理」里加一条吧</div>
        </div>
      </template>
      <template v-else>
        <div class="apCats"><button type="button" :class="{ active: filterCat === '' }" @click="filterCat = ''">全部</button><button v-for="[c, n] in cats" :key="c" type="button" :class="{ active: filterCat === c }" @click="filterCat = c">{{ c }}({{ n }})</button></div>
        <div class="apList">
          <div v-for="(p, i) in filtered" :key="p.id" class="apRow">
            <div class="apRowMain"><div class="apRowT">{{ p.title || '(无标题)' }}</div><div class="apRowC">{{ catName(p.category) }}</div></div>
            <div class="apRowOps"><button type="button" title="上移" :disabled="i === 0" @click="move(p, -1)">↑</button><button type="button" title="下移" :disabled="i === filtered.length - 1" @click="move(p, 1)">↓</button><button type="button" title="编辑" @click="edit(p)">✎</button><button type="button" title="删除" @click="del(p)">×</button></div>
          </div>
          <div v-if="!filtered.length" class="muted" style="padding:10px 2px;">空空如也，点下面新建一条吧</div>
        </div>
        <button class="btn small primary" type="button" style="margin-top:8px;" @click="newPrompt">＋ 新建提示词</button>
        <div v-if="form.open" class="apForm" style="margin-top:8px;">
          <div class="apFTitle">{{ form.id ? '编辑' : '新建' }}提示词</div>
          <input v-model="form.title" placeholder="标题（列表里显示）">
          <input v-model="form.category" placeholder="分类（可新建，如：教程修改）">
          <textarea v-model="form.content" rows="4" placeholder="提示词正文…" style="margin-top:6px;"></textarea>
          <div class="apFOps"><button class="btn small primary" type="button" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button><button class="btn small" type="button" @click="form.open = false">取消</button></div>
        </div>
        <details class="apCatsMgr" style="margin-top:8px;"><summary>分类管理（重命名 / 删除）</summary>
          <div style="padding:6px 0;">
            <div v-for="[c, n] in cats" :key="c" class="apCatRow"><span>{{ c }}（{{ n }}）</span><div class="spacer"></div><button class="btn tiny" type="button" @click="renameCat(c)">改名</button><button class="btn tiny danger" type="button" @click="delCat(c)">删除</button></div>
            <div v-if="!cats.length" class="muted" style="font-size:12px;">还没有分类（未分类的不显示在这里）</div>
          </div>
        </details>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const cache = ref([]);
const tab = ref('pick');
const filterCat = ref('');
const query = ref('');
const form = reactive({ open: false, id: 0, title: '', category: '', content: '' });
const saving = ref(false);

const cats = computed(() => {
  const m = new Map();
  for (const p of cache.value) { const c = String(p.category || '').trim(); if (c) m.set(c, (m.get(c) || 0) + 1); }
  return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh'));
});
const filtered = computed(() => {
  const q = String(query.value || '').trim().toLowerCase();
  return cache.value.filter(p => {
    if (filterCat.value !== '' && String(p.category || '').trim() !== filterCat.value) return false;
    if (!q) return true;
    return (String(p.title || '') + '\n' + String(p.content || '')).toLowerCase().includes(q);
  });
});
function catName(c) { return String(c || '').trim() || '未分类'; }
async function load() {
  try { cache.value = ((await api('/api/prompts')).prompts) || []; } catch (e) { cache.value = []; }
  if (props.host.onCount) props.host.onCount(cache.value.length);
}
function switchTab(t) { tab.value = t; form.open = false; }
function insert(p) { try { if (props.host.insertText) props.host.insertText(p.content || ''); } catch (e) {} }
function close() { try { if (props.host.onClose) props.host.onClose(); } catch (e) {} }
function newPrompt() { form.open = true; form.id = 0; form.title = ''; form.category = filterCat.value; form.content = ''; }
function edit(p) { form.open = true; form.id = p.id; form.title = p.title || ''; form.category = p.category || ''; form.content = p.content || ''; }
async function save() {
  if (!String(form.content || '').trim()) return toast('内容不能为空');
  if (saving.value) return;
  saving.value = true;
  try {
    const body = JSON.stringify({ title: String(form.title || '').trim(), category: String(form.category || '').trim(), content: String(form.content || '').trim() });
    if (form.id) await api('/api/prompts/' + form.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    else await api('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    form.open = false;
    await load();
    toast('已保存');
  } catch (e) { toast(e.message); }
  saving.value = false;
}
async function del(p) {
  if (!window.confirm('删除「' + (p.title || '') + '」？')) return;
  try { await api('/api/prompts/' + p.id, { method: 'DELETE' }); await load(); } catch (e) { toast(e.message); }
}
async function move(p, dir) {
  const ids = filtered.value.map(x => Number(x.id));
  const i = ids.indexOf(Number(p.id)); const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const rest = cache.value.map(x => Number(x.id)).filter(x => !ids.includes(x));
  try { await api('/api/prompts/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.concat(rest) }) }); await load(); }
  catch (e) { toast(e.message); }
}
async function renameCat(c) {
  const v = window.prompt('分类改名：', c);
  if (v == null) return;
  const name = String(v).trim().slice(0, 40);
  if (!name || name === c) return;
  try { await api('/api/prompt-categories/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: c, new: name }) }); if (filterCat.value === c) filterCat.value = name; await load(); }
  catch (e) { toast(e.message); }
}
async function delCat(c) {
  if (!window.confirm('删除分类「' + c + '」？名下提示词会移到“未分类”，内容不删除。')) return;
  try { await api('/api/prompt-categories/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: c }) }); if (filterCat.value === c) filterCat.value = ''; await load(); }
  catch (e) { toast(e.message); }
}
onMounted(load);
</script>

<style scoped>
.apVue { min-height: 240px; }
</style>
