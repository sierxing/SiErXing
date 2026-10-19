<template>
  <aside id="nodeNotes" class="nodeNotes" :style="{ width: width + 'px' }" :title="nodeTitle">
    <div class="nnHead">
      <div class="nnTabs">
        <button v-if="mdOk" class="nnTb" :class="{ on: tab === 'md' }" type="button" title="跟着这个节点的 Markdown 笔记" @click="switchTab('md')">🗒 Markdown 笔记</button>
        <button v-if="tutOn" class="nnTb" :class="{ on: tab === 'tut' }" type="button" title="这篇教程里划的重点 / 批注" @click="switchTab('tut')">📌 划线笔记<span class="nnTbN">{{ tutCount }}</span></button>
      </div>
      <div class="spacer"></div>
      <template v-if="tab === 'md'">
        <button v-if="!editing" class="btn tiny" type="button" @click="startEdit">✎ 编辑</button>
        <template v-else><button class="btn tiny primary" type="button" :disabled="saving" @click="save">💾 保存</button><button class="btn tiny" type="button" :disabled="saving" @click="cancel">取消</button></template>
      </template>
      <button class="btn tiny" type="button" title="收起（边缘小标签可再打开）" @click="hide">收起 »</button>
    </div>
    <div class="nnMeta"><span>{{ status }}</span><span class="spacer"></span><span class="nnSub" :title="nodeTitle">{{ String(nodeTitle).slice(0, 14) }}</span><span>{{ countLabel }}</span></div>
    <div v-show="tab === 'md'">
      <textarea v-if="editing" ref="taEl" v-model="draft" class="nnEditor" spellcheck="false" placeholder="Markdown 笔记，Ctrl+S 保存"></textarea>
      <div v-else class="nnViewWrap" title="点一下开始编辑" @click="startEdit"><div v-if="current.trim()" class="mdBody" v-html="md(current)"></div><div v-else class="nnEmpty">还没有笔记，点右上「编辑」开始记<br><span class="muted">支持 Markdown（标题/列表/代码/加粗）</span></div></div>
    </div>
    <div v-show="tab === 'tut'" ref="tutEl" class="nnTutBody"></div>
    <div class="nnResize" title="拖动调宽" @mousedown="startResize"></div>
  </aside>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, tutorialId: { type: Number, default: 0 }, nodeId: { type: Number, default: 0 }, nodeTitle: { type: String, default: '' } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || ''), { srcLines: true }) : String(s || ''); } catch (e) { return String(s || ''); } };
const tab = ref('md');
const current = ref('');
const draft = ref('');
const editing = ref(false);
const saving = ref(false);
const status = ref('加载中…');
const tutCount = ref(0);
const width = ref(340);
const taEl = ref(null);
const tutEl = ref(null);
const mdOk = computed(() => !!props.nodeId);
const tutOn = true;
const countLabel = computed(() => editing.value ? (draft.value.length + ' 字') : (current.value.trim() ? (current.value.length + ' 字') : ''));
const metaTitle = computed(() => props.nodeTitle);
function loadWidth() { try { width.value = Math.max(280, Math.min(560, Number(localStorage.getItem('sierxing-notes-w')) || 340)); } catch (e) {} }
function setWidth(w) { width.value = Math.max(280, Math.min(560, Math.round(w))); try { localStorage.setItem('sierxing-notes-w', String(width.value)); } catch (e) {} }
function startResize(e) {
  e.preventDefault();
  const move = ev => setWidth(window.innerWidth - 22 - ev.clientX);
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}
async function loadNote() {
  if (!props.nodeId) { status.value = '这个教程对应的任务已不存在，只看划线笔记'; return; }
  status.value = '加载中…';
  try { const r = await api('/api/nodes/' + props.nodeId + '/note'); current.value = r.content || ''; status.value = current.value ? ('已保存 ' + String(r.updated_at || '').slice(0, 16).replace('T', ' ')) : '空笔记：点「编辑」开始记'; }
  catch (e) { status.value = '加载失败'; }
}
function startEdit() { if (!mdOk.value) return; draft.value = current.value; editing.value = true; nextTick(() => { const ta = taEl.value; if (ta) { ta.focus(); try { ta.setSelectionRange(draft.value.length, draft.value.length); } catch (e) {} } }); }
async function save() {
  if (saving.value || !props.nodeId) return; saving.value = true;
  try { const r = await api('/api/nodes/' + props.nodeId + '/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: draft.value }) }); current.value = draft.value; editing.value = false; status.value = '已保存 ' + String(r.updated_at || '').slice(0, 16).replace('T', ' '); toast('笔记已保存'); }
  catch (e) { toast(e.message); } saving.value = false;
}
function cancel() { editing.value = false; draft.value = ''; }
function flush() { if (!editing.value || !props.nodeId || draft.value === current.value) return; try { fetch('/api/nodes/' + props.nodeId + '/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: draft.value }), keepalive: true }).catch(() => {}); } catch (e) {} }
function hide() { flush(); if (props.host.hide) props.host.hide(); }
async function switchTab(t) {
  if (t === tab.value) return;
  hideTut();
  tab.value = t;
  try { localStorage.setItem('sierxing-notes-tab', t); } catch (e) {}
  if (t === 'tut') { await nextTick(); mountTut(); }
}
function mountTut() { try { if (window.TutNotes && typeof window.TutNotes.renderInto === 'function' && tutEl.value) window.TutNotes.renderInto(tutEl.value, { onChange: n => { tutCount.value = Number(n) || 0; } }); } catch (e) {} }
function hideTut() { try { if (window.TutNotes && typeof window.TutNotes.detach === 'function') window.TutNotes.detach(); } catch (e) {} }
function onKey(ev) { if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 's' && editing.value) { ev.preventDefault(); save(); } }
onMounted(async () => { loadWidth(); try { tab.value = localStorage.getItem('sierxing-notes-tab') === 'tut' ? 'tut' : 'md'; } catch (e) {} if (tab.value === 'tut') { await nextTick(); mountTut(); } await loadNote(); if (tab.value === 'md' && !mdOk.value && tutOn) { tab.value = 'tut'; await nextTick(); mountTut(); } document.addEventListener('keydown', onKey); });
onUnmounted(() => { flush(); hideTut(); document.removeEventListener('keydown', onKey); });
</script>

<style scoped>
.nnViewWrap { cursor: text; min-height: 80px; }
.nnEditor { width: 100%; min-height: 220px; box-sizing: border-box; }
</style>
