<template>
  <div v-if="t" class="tutPage">
    <div class="tutSticky">
      <div class="tutHead">
        <button class="back" type="button" @click="back">← 返回目标</button>
        <button class="btn small primary" type="button" id="tutSaveBtn" hidden>💾 保存</button>
        <button class="btn small" type="button" id="tutCancelBtn" hidden>取消</button>
        <span class="mapTitle" id="tutTitle">📘 {{ t.title }}</span>
        <span class="chip gray">{{ isHtml ? 'HTML' : 'Markdown' }}</span>
        <span class="chip gray">约 {{ sizeK }}k 字</span>
        <div class="spacer"></div>
        <button class="btn small" type="button" @click="download">下载</button>
        <button class="btn small danger" type="button" @click="del">删除</button>
      </div>
      <div class="favBar tutFavBarVue">
        <template v-for="it in visibleFavs" :key="it.id">
          <button class="btn small" :class="it.cls" type="button" :id="it.elId || undefined" :title="it.title || it.label" :draggable="true" :data-fav-id="it.id" @dragstart="favDragStart(it)" @dragover.prevent @drop.prevent="favDrop(it)" @click="it.fn && it.fn()">{{ it.label }}</button>
          <button v-if="favEdit" class="favPin" type="button" title="从收藏栏隐藏这个按钮" @click.stop="favHide(it.id)">✕</button>
        </template>
        <button class="btn small favMore" type="button" @click="favMenu = !favMenu" :title="favEdit ? '完成编辑' : '收藏栏设置 / 显示隐藏按钮'">⋯</button>
        <div v-if="favMenu" class="favMenu" @click.stop>
          <div class="favMenuHead"><b>教程工具栏</b><span class="spacer"></span><button class="btn tiny" type="button" @click="favEdit = !favEdit">{{ favEdit ? '完成' : '编辑' }}</button></div>
          <div v-if="hoverFavs.length" class="favMenuSec">已隐藏<div v-for="it in hoverFavs" :key="it.id" class="favMenuItem"><span class="favMenuLabel">{{ it.label }}</span><button class="btn tiny" type="button" @click="favShow(it.id)">显示</button></div></div>
          <div v-else class="muted" style="padding:4px 2px;font-size:12px;">没有隐藏的按钮</div>
          <div class="favMenuSec"><button class="btn tiny" type="button" @click="favAll(true)">全部显示</button><button class="btn tiny" type="button" @click="favReset">恢复默认</button></div>
          <p class="hint" style="margin:6px 0 0;font-size:11.5px;">拖动按钮可排序；设置只保存在本机。</p>
        </div>
      </div>
      <div class="favHiddenPool" aria-hidden="true">
        <button v-for="it in hoverFavs" :key="'h' + it.id" class="btn small" :id="it.elId || undefined" type="button" :data-fav-id="it.id" @click="it.fn && it.fn()">{{ it.label }}</button>
      </div>
    </div>
    <div class="tutMeta">{{ node ? '对应任务：' + node.title : '' }}{{ goal ? '　·　所属目标：' + goal.title : '' }}　·　生成于 {{ fmt(t.created_at) }}<span v-if="hasWorkspace">　·　<span class="wsHint" id="wsHint"></span></span></div>
    <div v-if="!isHtml" ref="bodyEl" class="tutBody mdBody" v-html="bodyHtml" @dblclick="onBodyDblclick"></div>
    <iframe v-else ref="frameEl" class="tutFrame" id="tutFrame" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>

    <div v-if="versOpen" class="modalMask" @click.self="closeVersions">
      <div class="modalBox">
        <div class="modalHead"><b>🕘 历史版本</b><span class="muted" style="font-size:11.5px;margin-left:8px;">最近 10 版；恢复前会自动存当前版，可撤销</span><div class="spacer"></div><button class="btn tiny" type="button" @click="closeVersions">×</button></div>
        <div v-if="versView === 'list'">
          <div v-if="versBusy" class="muted" style="padding:10px;">加载中…</div>
          <div v-else-if="!versRows.length" class="muted" style="padding:10px;">还没有历史版本：改一次（AI 修改或手动保存）就会留一版。</div>
          <div v-else class="verList"><div v-for="(ver, i) in versRows" :key="ver.id" class="verRow"><div class="verInfo"><div class="verT"><span v-if="i === 0" class="chip ok">最新</span> {{ ver.reason || '（无说明）' }}</div><div class="verM">{{ fmt(ver.created_at) }} · {{ Number(ver.chars) >= 1000 ? (Number(ver.chars) / 1000).toFixed(1) + 'k 字' : ver.chars + ' 字' }}</div></div><div class="spacer"></div><button class="btn tiny" type="button" @click="diffVersion(ver)">🔍 对比</button><button class="btn tiny" type="button" @click="previewVersion(ver)">预览</button><button class="btn tiny primary" type="button" :disabled="restoring" @click="restoreVersion(ver)">恢复到这版</button></div></div>
        </div>
        <div v-else-if="versView === 'preview'">
          <div class="toolbarRow"><button class="btn tiny" type="button" @click="versView = 'list'">← 返回列表</button><span class="muted" style="font-size:12px;">{{ versCur.reason || '' }} · {{ fmt(versCur.created_at) }}</span></div>
          <iframe v-if="isHtml" class="tutFrame" style="height:60vh;margin-top:8px;" :srcdoc="h.frameHtml(versCur.content || '')"></iframe>
          <div v-else class="tutBody mdBody verPreview" v-html="h.mdToHTML(versCur.content || '', { viz: true })"></div>
        </div>
        <div v-else>
          <div class="toolbarRow"><button class="btn tiny" type="button" @click="versView = 'list'">← 返回列表</button><span class="muted" style="font-size:12px;">{{ versCur.reason || '' }} → 当前版</span><div class="spacer"></div><span class="diffSum"><b class="add">+{{ diffAdd }}</b> <b class="del">−{{ diffDel }}</b> 行</span></div>
          <div v-if="!versDiffRows.length" class="muted" style="padding:12px;">这版和当前正文完全一样。</div>
          <div v-else class="diffBody"><div v-for="(row, i) in versDiffRows" :key="i" class="diffRow" :class="row.t"><span class="diffSign">{{ row.t === 'add' ? '+' : (row.t === 'del' ? '−' : ' ') }}</span><span class="diffText">{{ row.text }}</span></div></div>
        </div>
      </div>
    </div>

    <div v-if="edOpen" class="modalMask" @click.self="closeEdit">
      <div class="modalBox edBox">
        <div class="modalHead"><b>{{ edScope === 'block' ? '✎ 编辑这一块（Markdown 源码）' : '✎ 手动编辑整篇' }}</b><span class="muted" style="font-size:11.5px;margin-left:8px;">{{ edScope === 'block' ? '只改这一块，保存后其余正文不动' : '直接改 Markdown / HTML 源码；保存会留一版历史' }}</span><div class="spacer"></div><button class="btn tiny" type="button" @click="closeEdit">×</button></div>
        <textarea v-model="edText" class="edArea" spellcheck="false"></textarea>
        <div class="toolbarRow" style="margin-top:10px;"><button class="btn primary" type="button" :disabled="edSaving || !edDirty" @click="saveEdit">{{ edSaving ? '保存中…' : (edDirty ? '💾 保存' : '没有改动') }}</button><button class="btn" type="button" @click="closeEdit">取消</button><span class="muted" style="font-size:11.5px;margin-left:auto;">{{ edText.length }} 字</span></div>
      </div>
    </div>
  </div>
  <p v-else class="muted" style="padding:40px;text-align:center;">加载教程…</p>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const h = props.host;
const api = h.api;
const toast = (m) => { try { h.toast ? h.toast(m) : console.log(m); } catch (e) {} };
const tid = h.tid;
const t = ref(null);
const node = ref(null);
const goal = ref(null);
const bodyEl = ref(null);
const frameEl = ref(null);
const isHtml = computed(() => t.value && t.value.format === 'html');
const sizeK = computed(() => Math.max(1, Math.round(String((t.value && t.value.content) || '').length / 1000)));
const bodyHtml = computed(() => (isHtml.value || !t.value) ? '' : h.mdToHTML(t.value.content, { viz: true, srcLines: true }));
const legacyHref = '?ui=legacy#/t/' + tid;
const hasNotes = computed(() => typeof window !== 'undefined' && !!window.NodeNotes && (compEnabled('notes') || compEnabled('tutnotes')));
const hasBookmark = computed(() => typeof window !== 'undefined' && !!window.TutBookmark && compEnabled('tutbookmark'));
const hasWorkspace = computed(() => typeof window !== 'undefined' && !!window.Workspace && compEnabled('workspace'));
function compEnabled(id) { try { return !!h.goalCompOn(id); } catch (e) { return true; } }
function fmt(v) { try { return h.fmtDate(v); } catch (e) { return String(v || '').slice(0, 10); } }
function back() { location.hash = '#/g/' + (t.value ? t.value.goal_id : 0); }
function goSub(sub) { location.hash = '#/t/' + tid + '/' + sub; }
function toggleToc() { try { const open = localStorage.getItem('sierxing-toc-open') !== '0'; localStorage.setItem('sierxing-toc-open', open ? '0' : '1'); } catch (e) {} try { h.tutTocBuild(tid); } catch (e) {} }
function toggleNotes() { try { window.NodeNotes.toggle(tid, node.value ? node.value.id : 0, node.value ? node.value.title : ''); } catch (e) { toast(e.message); } }
function toggleBookmark() { try { window.TutBookmark.toggle(tid); } catch (e) { toast(e.message); } }

function download() { const c = t.value.content || ''; const blob = new Blob([c], { type: isHtml.value ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = String(t.value.title || '教程').replace(/[\\/:*?"<>|]/g, '_') + (isHtml.value ? '.html' : '.md'); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000); }
async function rename() { const name = window.prompt('教程标题', t.value.title); if (!name || name === t.value.title) return; try { await api('/api/tutorials/' + tid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name }) }); t.value.title = name; toast('已重命名'); } catch (e) { toast(e.message); } }
async function del() { if (!window.confirm('删除这份教程？')) return; try { await api('/api/tutorials/' + tid, { method: 'DELETE' }); toast('已删除'); location.hash = '#/g/' + t.value.goal_id; } catch (e) { toast(e.message); } }
async function setupBody() {
  await nextTick();
  if (isHtml.value && frameEl.value) {
    const fr = frameEl.value;
    fr.addEventListener('load', () => { try { h.tutTocBuild(tid); } catch (e) {} }, { once: true });
    fr.setAttribute('srcdoc', h.frameHtml(t.value.content));
    setTimeout(() => { try { h.tutTocBuild(tid); } catch (e) {} }, 1500);
  } else {
    setTimeout(() => { try { h.tutTocBuild(tid); } catch (e) {} }, 200);
  }
  try { h.tutViewInit(); } catch (e) {}
  if (hasNotes.value) { try { const nid = node.value ? node.value.id : 0; window.NodeNotes.mount(tid, nid, node.value ? node.value.title : ''); } catch (e) {} }
  if (hasBookmark.value) { try { window.TutBookmark.badge(tid); } catch (e) {} }
  try { if (window.TutNotes) window.TutNotes.mount(tid); } catch (e) {}
  if (hasWorkspace.value) { try { window.Workspace.bindTutorial(tid, node.value, goal.value); } catch (e) {} }
}
function onHash() { if (!/^#\/t\/\d+$/.test(location.hash)) { try { h.unmount(); } catch (e) {} } }
/* ---- 手动编辑（整篇 / 双击就地改一块） ---- */
const edOpen = ref(false);
const edScope = ref('all');
const edText = ref('');
const edRange = ref(null);
const edSaving = ref(false);
const edDirty = computed(() => {
  if (!t.value) return false;
  if (edScope.value === 'all') return edText.value !== String(t.value.content || '');
  return edRange.value ? edText.value !== sliceLines(t.value.content, edRange.value[0], edRange.value[1]) : false;
});
function sliceLines(src, a, b) { const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n'); return lines.slice(Math.max(0, a), Math.max(a, b)).join('\n'); }
function spliceLines(src, a, b, text) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  const rep = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(0, a).concat(rep).concat(lines.slice(b)).join('\n');
}
function openManualAll() { edScope.value = 'all'; edRange.value = null; edText.value = String((t.value && t.value.content) || ''); edOpen.value = true; }
function onBodyDblclick(ev) {
  if (edOpen.value || isHtml.value) return;
  let el = ev.target;
  while (el && el !== ev.currentTarget && !(el.getAttribute && el.getAttribute('data-src') != null)) el = el.parentElement;
  if (!el || el === ev.currentTarget) { openManualAll(); return; }
  const a = Number(el.getAttribute('data-src'));
  const bRaw = el.getAttribute('data-srce');
  const b = bRaw != null && /^\d+$/.test(String(bRaw)) ? Number(bRaw) : a + 1;
  if (!Number.isFinite(a)) { openManualAll(); return; }
  edScope.value = 'block'; edRange.value = [a, b > a ? b : a + 1];
  edText.value = sliceLines(t.value.content, a, b > a ? b : a + 1);
  edOpen.value = true;
}
function closeEdit() { if (!edSaving.value) edOpen.value = false; }
async function saveEdit() {
  if (edSaving.value || !edDirty.value) return;
  edSaving.value = true;
  try {
    const cur = String((t.value && t.value.content) || '');
    const next = edScope.value === 'all' ? edText.value : spliceLines(cur, edRange.value[0], edRange.value[1], edText.value);
    await api('/api/tutorials/' + tid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: next }) });
    if (t.value) { t.value.content = next; t.value.chars = next.length; }
    edOpen.value = false;
    toast('✅ 已保存' + (edScope.value === 'block' ? '这一块' : '') + '（历史版本里可回退）');
  } catch (e) { toast('保存失败：' + e.message); }
  edSaving.value = false;
}
/* ---- Vue 原生教程收藏栏（拖拽排序 / 隐藏到 ⋯ / 本机持久化） ---- */
/* ---- 历史版本（Vue） ---- */
const versOpen = ref(false);
const versBusy = ref(false);
const versRows = ref([]);
const versView = ref('list');
const versCur = ref({});
const versDiffRows = ref([]);
const restoring = ref(false);
const diffAdd = computed(() => versDiffRows.value.filter(r => r.t === 'add').length);
const diffDel = computed(() => versDiffRows.value.filter(r => r.t === 'del').length);
async function loadVersions() {
  versBusy.value = true;
  try { const r = await api('/api/tutorials/' + tid + '/versions'); versRows.value = r.versions || []; }
  catch (e) { toast('版本列表加载失败：' + e.message); versRows.value = []; }
  versBusy.value = false;
}
async function openVersions() { versOpen.value = true; versView.value = 'list'; versCur.value = {}; versDiffRows.value = []; await loadVersions(); }
function closeVersions() { if (restoring.value) return; versOpen.value = false; }
async function previewVersion(ver) {
  try { const r = await api('/api/tutorials/versions/' + ver.id); versCur.value = Object.assign({}, ver, r.version || {}); versView.value = 'preview'; }
  catch (e) { toast('预览失败：' + e.message); }
}
async function diffVersion(ver) {
  try {
    const r = await api('/api/tutorials/versions/' + ver.id);
    const detail = r.version || {};
    let cur = '';
    try { cur = String((await api('/api/tutorials/' + tid + '/content')).content || ''); } catch (e) {}
    versCur.value = Object.assign({}, ver, detail);
    versDiffRows.value = lineDiff(detail.content || '', cur);
    versView.value = 'diff';
  } catch (e) { toast('对比失败：' + e.message); }
}
async function restoreVersion(ver) {
  if (restoring.value) return;
  if (!window.confirm('恢复到这版？当前版会自动存一份（“回滚前自动保存”），所以这步也可撤销。')) return;
  restoring.value = true;
  try {
    await api('/api/tutorials/' + tid + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version_id: Number(ver.id) }) });
    versOpen.value = false; toast('已恢复 ✓ 当前版已自动存档');
    await loadAll();
  } catch (e) { toast('恢复失败：' + e.message); }
  restoring.value = false;
}
function lineDiff(a, b) {
  const A = String(a || '').split('\n'); const B = String(b || '').split('\n');
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const am = A.slice(s, A.length - e); const bm = B.slice(s, B.length - e);
  const n = am.length, m = bm.length;
  if (!n && !m) return [];
  if (n * m > 1200000) return [{ t: 'del', text: '（差异太大，按整段变化显示；请用预览逐版查看）' }].concat(am.slice(0, 200).map(t => ({ t: 'del', text: t })), bm.slice(0, 200).map(t => ({ t: 'add', text: t })));
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) { rows.push({ t: 'same', text: am[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ t: 'del', text: am[i++] });
    else rows.push({ t: 'add', text: bm[j++] });
  }
  while (i < n) rows.push({ t: 'del', text: am[i++] });
  while (j < m) rows.push({ t: 'add', text: bm[j++] });
  const changes = rows.map((r, ix) => r.t !== 'same' ? ix : -1).filter(ix => ix >= 0);
  const keep = new Set(); changes.forEach(ix => { for (let k = Math.max(0, ix - 3); k <= Math.min(rows.length - 1, ix + 3); k++) keep.add(k); });
  const out = []; let skipped = false;
  rows.forEach((r, ix) => { if (keep.has(ix)) { out.push(r); skipped = false; } else if (!skipped) { out.push({ t: 'gap', text: '⋯' }); skipped = true; } });
  return out;
}
const TUT_FAV_KEY = 'sierxing-tutbar-vue-v1';
const favEdit = ref(false);
const favMenu = ref(false);
const favDragId = ref('');
const favCfg = ref({ order: [], hidden: [] });
function favLoad() {
  try { const raw = localStorage.getItem(TUT_FAV_KEY); if (raw) { const o = JSON.parse(raw); favCfg.value = { order: Array.isArray(o.order) ? o.order : [], hidden: Array.isArray(o.hidden) ? o.hidden : [] }; } } catch (e) {}
}
function favSave() { try { localStorage.setItem(TUT_FAV_KEY, JSON.stringify(favCfg.value)); } catch (e) {} }
function favHide(id) { if (!favCfg.value.hidden.includes(id)) favCfg.value.hidden.push(id); favSave(); }
function favShow(id) { favCfg.value.hidden = favCfg.value.hidden.filter(x => x !== id); favSave(); }
function favAll(on) { favCfg.value.hidden = on ? [] : favItems.value.map(i => i.id); favSave(); }
function favReset() { favCfg.value = { order: [], hidden: [] }; favSave(); toast('工具栏已恢复默认'); }
function favDragStart(it) { favDragId.value = it.id; }
function favDrop(target) {
  const from = favDragId.value; favDragId.value = '';
  if (!from || from === target.id) return;
  const arr = visibleFavs.value.map(i => i.id).concat(hoverFavs.value.map(i => i.id));
  const i = arr.indexOf(from); if (i >= 0) arr.splice(i, 1);
  const j = arr.indexOf(target.id);
  arr.splice(j < 0 ? arr.length : j, 0, from);
  favCfg.value.order = arr; favSave();
}
const favItems = computed(() => {
  const out = [];
  out.push({ id: 'tutEditBtn', elId: 'tutEditBtn', label: '💬 让 AI 修改', title: '在对话里说你想怎么改，AI 会按意见修改' });
  out.push({ id: 'tutVersBtn', elId: 'tutVersBtn', label: '🕘 历史版本', title: '每次修改/保存都留一版，改坏了从这里恢复', fn: openVersions });
  out.push({ id: 'tutManualBtn', elId: 'tutManualBtn', label: '✎ 手动编辑', title: '直接手动编辑并保存；Markdown 也可以双击正文某一段就地改', fn: openManualAll });
  out.push({ id: 'tutToc', label: '📑 目录', title: '显示 / 隐藏左侧目录', fn: toggleToc });
  if (hasNotes.value) out.push({ id: 'tutNotes', label: '🗒 笔记', title: '展开 / 收起右侧笔记栏', fn: toggleNotes });
  if (hasBookmark.value) out.push({ id: 'tutBm', label: '🔖 标签', title: '随时标记阅读位置', fn: toggleBookmark });
  if (compEnabled('restate')) out.push({ id: 'tutRestateBtn', label: '🧠 用自己的话', fn: () => goSub('restate') });
  if (compEnabled('explain')) out.push({ id: 'tutExplainBtn', label: '🔍 看懂代码', fn: () => goSub('explain') });
  if (compEnabled('quiz')) out.push({ id: 'tutQuizBtn', label: '📝 测验', fn: () => goSub('quiz') });
  if (hasWorkspace.value) out.push({ id: 'tutCodeBtn', elId: 'tutCodeBtn', label: '💻 写代码' });
  if (hasWorkspace.value) out.push({ id: 'tutPackBtn', elId: 'tutPackBtn', label: '📦 打包' });
  out.push({ id: 'tutRename', label: '✎ 重命名', fn: rename });
  out.push({ id: 'tutDl', label: '下载', fn: download });
  out.push({ id: 'tutDel', label: '删除', cls: 'danger', fn: del });
  return out;
});
const favOrdered = computed(() => {
  const byId = {}; favItems.value.forEach(i => { byId[i.id] = i; });
  const seen = new Set(); const out = [];
  for (const id of favCfg.value.order) { const it = byId[id]; if (it && !seen.has(id)) { out.push(it); seen.add(id); } }
  for (const it of favItems.value) if (!seen.has(it.id)) out.push(it);
  return out;
});
const visibleFavs = computed(() => favOrdered.value.filter(i => !favCfg.value.hidden.includes(i.id)));
const hoverFavs = computed(() => favOrdered.value.filter(i => favCfg.value.hidden.includes(i.id)));
async function loadAll() {
  try {
    const r = await api('/api/tutorials/' + tid);
    t.value = r.tutorial; node.value = r.node; goal.value = r.goal;
    h.setupContext(t.value, node.value, goal.value);
    await setupBody();
  } catch (e) { toast('教程加载失败：' + e.message); }
}
onMounted(async () => {
  favLoad();
  await loadAll();
  window.addEventListener('hashchange', onHash);
});
onBeforeUnmount(() => { try { window.removeEventListener('hashchange', onHash); } catch (e) {} try { h.unmount(); } catch (e) {} });
</script>

<style scoped>
.edBox { width: min(980px, 96vw); }
.edArea { width: 100%; box-sizing: border-box; min-height: 52vh; max-height: 62vh; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.65; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); color: var(--text); }
.favBar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; position: relative; padding: 8px 10px 2px; }
.favBar .btn { position: relative; }
.favPin { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: 50%; border: 0; background: var(--danger); color: #fff; font-size: 10px; line-height: 1; cursor: pointer; z-index: 2; padding: 0; }
.favMenu { position: absolute; z-index: 40; top: calc(100% + 6px); right: 0; width: 250px; max-height: 60vh; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); padding: 10px; }
.favMenuHead { display: flex; align-items: center; margin-bottom: 8px; font-size: 13px; }
.favMenuSec { border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 5px; }
.favMenuItem { display: flex; align-items: center; gap: 8px; }
.favMenuLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.favHiddenPool { display: none; }
.modalMask { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 90; padding: 20px; }
.modalBox { background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: min(820px, 96vw); max-height: 88vh; overflow: auto; padding: 16px; }
.modalHead { display: flex; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.verList { display: flex; flex-direction: column; gap: 2px; }
.verRow { display: flex; align-items: center; gap: 8px; padding: 9px 8px; border-radius: 8px; border-bottom: 1px solid var(--line); }
.verRow:hover { background: var(--soft); }
.verInfo { flex: 1; min-width: 0; }
.verT { font-size: 13px; }
.verM { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.verPreview { margin-top: 8px; }
.diffSum .add { color: var(--ok, #2e7d32); }
.diffSum .del { color: var(--danger); }
.diffBody { margin-top: 8px; border: 1px solid var(--line); border-radius: 9px; overflow: auto; max-height: 62vh; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; }
.diffRow { display: flex; gap: 8px; padding: 1px 8px; white-space: pre-wrap; word-break: break-all; }
.diffRow.add { background: rgba(46,125,50,.12); }
.diffRow.del { background: rgba(198,40,40,.12); }
.diffRow.gap { color: var(--muted); background: var(--soft); }
.diffSign { flex: none; width: 12px; color: var(--muted); }
.diffText { flex: 1; }
.tutPage { max-width: 1200px; margin: 0 auto; }
.tutHead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mapTitle { font-size: 18px; font-weight: 700; margin: 0 6px; }
.tutMeta { color: var(--muted); font-size: 12.5px; margin: 8px 0 12px; }
.tutBody { line-height: 1.85; font-size: 15px; }
.tutFrame { width: 100%; height: calc(100vh - 170px); border: 1px solid var(--line); border-radius: 10px; background: #fff; }
</style>