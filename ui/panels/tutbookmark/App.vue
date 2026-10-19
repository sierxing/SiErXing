<template>
  <div class="tutBmVue">
    <div class="tutBmPanelHead"><span>🔖 阅读标签</span><button class="btn tiny" type="button" title="关闭" @click="close">×</button></div>
    <div class="tutBmCur">当前章节：<b>{{ currentTitle }}</b><button class="btn tiny" type="button" style="margin-left:6px;" @click="refreshCur">刷新</button></div>
    <div class="tutBmForm">
      <input v-model="label" placeholder="标签（如：已读 / 重点 / 待复习）" maxlength="40">
      <input v-model="note" placeholder="备注（可选）" maxlength="120">
    </div>
    <button class="btn tiny primary" type="button" style="width:100%;" :disabled="busy" @click="add">{{ busy ? '标记中…' : '＋ 标记当前章节' }}</button>
    <div class="tutBmList" style="margin-top:8px;">
      <div v-if="loading" class="muted" style="font-size:12.5px;">加载中…</div>
      <div v-else-if="!items.length" class="muted" style="font-size:12.5px;">还没有标签：填个标签点「标记当前章节」</div>
      <div v-for="b in items" :key="b.id" class="tutBmRow">
        <span class="chip">{{ b.label || '标签' }}</span>
        <span class="tutBmSec">{{ b.section_title || ('第 ' + (Number(b.section_idx) + 1) + ' 节') }}</span>
        <span v-if="b.note" class="muted" style="font-size:11.5px;">{{ b.note }}</span>
        <div class="spacer"></div>
        <button class="btn tiny" type="button" @click="jumpTo(b)">跳转</button>
        <button class="btn tiny danger" type="button" @click="remove(b)">删除</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const tid = Number(props.host.tid) || 0;
const items = ref([]);
const label = ref('');
const note = ref('');
const loading = ref(true);
const busy = ref(false);
const currentTitle = ref('…');

function cur() { try { return props.host.getCurrent ? props.host.getCurrent() : { idx: 0, title: '' }; } catch (e) { return { idx: 0, title: '' }; } }
function refreshCur() { const c = cur(); currentTitle.value = c.title || ('第 ' + ((c.idx || 0) + 1) + ' 节'); }
async function load() {
  try { items.value = (await api('/api/tutorials/' + tid + '/bookmarks')).bookmarks || []; }
  catch (e) { items.value = []; toast(e.message); }
  loading.value = false;
  if (props.host.onCount) props.host.onCount(items.value.length);
}
async function add() {
  if (busy.value) return;
  const c = cur();
  busy.value = true;
  try {
    await api('/api/tutorials/' + tid + '/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section_idx: c.idx || 0, section_title: c.title || '', label: String(label.value || '').trim(), note: String(note.value || '').trim() }) });
    label.value = ''; note.value = '';
    toast('已标记：' + (cur().title || '当前章节'));
    await load(); refreshCur();
  } catch (e) { toast(e.message); }
  busy.value = false;
}
async function remove(b) {
  if (!window.confirm('删除这个标签？')) return;
  try { await api('/api/bookmarks/' + b.id, { method: 'DELETE' }); await load(); }
  catch (e) { toast(e.message); }
}
function jumpTo(b) { try { if (props.host.jump) props.host.jump(Number(b.section_idx) || 0); } catch (e) {} }
function close() { try { if (props.host.onClose) props.host.onClose(); } catch (e) {} }
onMounted(() => { refreshCur(); load(); });
</script>

<style scoped>
.tutBmVue { display: flex; flex-direction: column; gap: 8px; }
</style>
