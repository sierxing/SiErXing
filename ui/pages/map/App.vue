<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回执行页</button>
      <h2 class="title" style="margin-left:8px;">🗺 {{ goal.title }}</h2>
      <span class="chip gray">{{ goal.tasks_done || 0 }}/{{ goal.tasks_total || 0 }} · {{ pct }}%</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" @click="openAll">全部展开</button>
      <button class="btn small" type="button" @click="closeAll">全部折叠</button>
      <a v-if="nodes.length" class="btn small" :href="'#/g/' + gid + '/versions'">📜 版本对比</a>
    </div>
    <div v-if="!nodes.length" class="emptyCard"><div style="font-size:38px;">🧭</div><b>还没有路径</b><div class="muted">回到执行页开始 AI 规划，生成路径后再来看图。</div><a class="btn primary" :href="'#/g/' + gid">返回执行页</a></div>
    <div v-else class="mapWrap">
      <div class="outline">
        <div class="outlineHead"><span>路线图</span><div class="spacer"></div><span class="muted">{{ nodes.length }} 个节点</span></div>
        <div class="rows">
          <button v-for="row in visibleRows" :key="row.id" type="button" class="row" :class="{ sel: selected && selected.id === row.id, done: row.status === 'done', busy: busyId === row.id }" :style="{ paddingLeft: (10 + row.depth * 20) + 'px' }" @click="pick(row)">
            <span class="fold" :class="{ blank: !row.hasKids }" @click.stop="toggle(row)">{{ row.hasKids ? (isCollapsed(row.id) ? '▸' : '▾') : '' }}</span>
            <span v-if="!row.hasKids" class="taskCk" @click.stop><input type="checkbox" :checked="row.status === 'done'" :disabled="!!busyId" @change="setDone(row, $event)"></span>
            <span class="ico">{{ row.depth === 0 ? '🎯' : (row.depth === 1 ? '🧩' : '✅') }}</span>
            <span class="rTitle">{{ row.title }}</span>
            <span class="chip" :class="row.status === 'done' ? 'ok' : (row.status === 'doing' ? 'warn' : 'gray')">{{ statusText(row.status) }}</span>
          </button>
        </div>
      </div>
      <div class="detail">
        <div v-if="selected" class="detailCard">
          <div class="dTitle">{{ selected.title }}</div>
          <div class="dMeta"><span class="chip" :class="selected.status === 'done' ? 'ok' : 'gray'">{{ statusText(selected.status) }}</span><span class="muted">层级 {{ selected.level }}</span><span v-if="selected.hours" class="muted">预计 {{ selected.hours }}</span></div>
          <div v-if="selected.detail" class="dSec"><b>说明</b><p>{{ selected.detail }}</p></div>
          <div v-if="selected.acceptance" class="dSec"><b>验收标准</b><p>{{ selected.acceptance }}</p></div>
          <div v-if="selected.artifact" class="dSec"><b>产出物</b><p>{{ selected.artifact }}</p></div>
          <div class="dSec"><b>子节点</b><p>{{ childrenOf(selected.id).length }} 个</p></div>
          <div class="dSec">
            <b>📁 关联文件夹</b>
            <p class="muted" style="font-size:11.5px;margin:2px 0;">挂到这一级，本节点和子节点在规划 / 教程里能读它；只读不写。</p>
            <div v-if="foldersLoading" class="muted" style="font-size:12px;">读取中…</div>
            <div v-for="fd in folders" :key="fd.path" class="npFolder">
              <div class="npFolderHead"><span>📁 {{ fd.name }}</span><span v-if="fd.inherited" class="chip gray">继承自上级</span><span v-if="fd.missing" class="chip warn">目录不存在</span><span class="spacer"></span><button v-if="!fd.inherited" class="btn tiny" type="button" @click="delFolder(fd)">取消挂载</button></div>
              <div class="npFolderPath">{{ fd.path }}</div>
              <div v-if="fd.note" class="muted" style="font-size:11.5px;">说明：{{ fd.note }}</div>
            </div>
            <div v-if="!folders.length && !foldersLoading" class="muted" style="font-size:12px;">没挂文件夹。挂上源码目录后，生成教程 / 拆分时会自动读它。</div>
            <button class="btn tiny" style="margin-top:8px;" type="button" @click="openFolderAdd">＋ 关联文件夹</button>
          </div>
          <div class="toolbarRow" style="margin-top:12px;flex-wrap:wrap;">
            <button v-if="!childrenOf(selected.id)" class="btn small primary" type="button" :disabled="!!busyId" @click="toggleSelectedDone">{{ selected.status === 'done' ? '↩ 取消完成' : '✅ 标记完成' }}</button>
            <button class="btn small" type="button" :disabled="!!busyId" @click="openEditNode">✎ 编辑节点</button>
            <button class="btn small" type="button" :disabled="!!busyId" @click="addChild">＋ 添加子任务</button>
            <button class="btn small danger" type="button" :disabled="!!busyId" @click="delNode">🗑 删除节点</button>
            <button class="btn small" type="button" :disabled="!!busyId" @click="fnOpen = !fnOpen">✨ AI 功能</button>
          </div>
          <div v-if="fnOpen" class="fnPop" @click.stop>
            <div class="fnPopT">针对：<b>{{ selected.title }}</b></div>
            <button class="fnItem" type="button" @click="fnGo('tut')"><span class="ci">📘</span><span class="cl">生成学习教程<em>掌握这个任务</em></span></button>
            <button v-if="childrenOf(selected.id)" class="fnItem" type="button" @click="fnTutKids"><span class="ci">📗</span><span class="cl">为全部子节点生成教程<em>{{ childrenOf(selected.id) }} 个，并行</em></span></button>
            <button class="fnItem" type="button" @click="fnGo('split')"><span class="ci">✨</span><span class="cl">AI 深度拆分<em>先搜集资料，再细化出子任务</em></span></button>
            <button class="fnItem" type="button" @click="openSources"><span class="ci">📚</span><span class="cl">资料与提炼汇总<em>本节点挂了 {{ nodeSources.length }} 条 · {{ nodeTutorials.length }} 份教程</em></span></button>
          </div>
          <p class="hint" style="margin-top:10px;">Vue 路线图可勾选叶子任务完成/取消、编辑节点、关联文件夹、生成教程与深度拆分（经「✨ AI 功能」）。</p>
        </div>
        <div v-else class="detailEmpty">点左侧节点查看详情。</div>
      </div>
    </div>

    <div v-if="srcOpen" class="modalMask" @click.self="srcOpen = false">
      <div class="modalBox">
        <div class="modalHead"><b>📚 资料与提炼汇总</b><div class="spacer"></div><button class="btn tiny" type="button" @click="srcOpen = false">×</button></div>
        <div class="srcNodeTitle">{{ selected && selected.title }}</div>
        <div class="dSec" style="margin-top:12px;"><b>本节点资料（{{ nodeSources.length }} 条）</b>
          <div v-if="!nodeSources.length" class="muted" style="font-size:12.5px;">本节点还没挂资料；挂的资料会作为规划 / 教程的依据。</div>
          <div v-for="(s, i) in nodeSources" :key="i" class="srcRow"><span class="chip gray">{{ s.kind === 'folder' ? '📁 文件夹' : (s.source_id ? '🔗 资料' : '📝 笔记') }}</span> <span>{{ s.name || s.path || ('资料 #' + (s.source_id || '')) }}</span><div v-if="s.note" class="muted" style="font-size:11.5px;">{{ s.note }}</div></div>
        </div>
        <div class="dSec"><b>本节点文件夹（{{ folders.length }} 个）</b><div v-if="!folders.length" class="muted" style="font-size:12.5px;">没挂文件夹。</div><div v-for="fd in folders" :key="fd.path" class="srcRow">📁 {{ fd.name }}<span v-if="fd.inherited" class="chip gray">继承</span><div class="muted" style="font-size:11.5px;word-break:break-all;">{{ fd.path }}</div></div></div>
        <div class="dSec"><b>本节点教程（{{ nodeTutorials.length }} 份）</b><div v-if="!nodeTutorials.length" class="muted" style="font-size:12.5px;">还没生成教程。</div><div v-for="tt in nodeTutorials" :key="tt.id" class="srcRow"><a :href="'#/t/' + tt.id">📘 {{ tt.title }}</a> <span class="muted" style="font-size:11.5px;">{{ fmt(tt.created_at) }}</span></div></div>
        <div class="toolbarRow" style="margin-top:12px;"><a class="btn small" :href="'#/g/' + gid + '/library'">去资源库看全部资料 →</a><button class="btn" type="button" @click="srcOpen = false">关闭</button></div>
      </div>
    </div>

    <div v-if="folderOpen" class="modalMask" @click.self="folderOpen = false">
      <div class="modalBox">
        <div class="modalHead"><b>📁 关联文件夹到本节点</b><div class="spacer"></div><button class="btn tiny" type="button" @click="folderOpen = false">×</button></div>
        <p class="hint" style="margin:0 0 10px;">挂上后，本节点和子节点在规划 / 拆分 / 生成教程时会自动读这个文件夹（文件清单 + README，按需读代码）。只读不写，磁盘文件不会动。</p>
        <label class="efRow">文件夹绝对路径<input v-model="folderPath" placeholder="例如 /home/me/projects/ragflow（以 / 开头）" @input="folderPreview = null"></label>
        <div class="toolbarRow" style="margin-bottom:8px;"><button class="btn small" type="button" :disabled="folderChecking" @click="checkFolder">{{ folderChecking ? '检查中…' : '🔍 检查这个文件夹' }}</button></div>
        <div v-if="folderPreview" class="folderPrev">
          <div>✓ 可以挂：<b>{{ folderPreview.dir }}</b></div>
          <div class="muted">可读文件 {{ folderPreview.total }} 个{{ folderPreview.hasReadme ? '，含 README' : '，没找到 README' }}</div>
          <div v-if="folderPreview.top && folderPreview.top.length" class="muted" style="font-size:11.5px;word-break:break-all;">例如：{{ folderPreview.top.slice(0, 6).map(function (x) { return x.path; }).join('、') }}</div>
        </div>
        <label class="efRow">名称（可选）<input v-model="folderName" placeholder="默认用文件夹名，例如 RAGFlow 源码"></label>
        <label class="efRow">说明（可选）<input v-model="folderNote" placeholder="这个文件夹是干什么的"></label>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="folderSaving || !folderPreview" @click="saveFolder">{{ folderSaving ? '挂载中…' : '挂到这个节点' }}</button><button class="btn" type="button" @click="folderOpen = false">取消</button></div>
      </div>
    </div>

    <div v-if="editOpen" class="modalMask" @click.self="editOpen = false">
      <div class="modalBox">
        <div class="modalHead"><b>✎ 编辑节点</b><div class="spacer"></div><button class="btn tiny" type="button" @click="editOpen = false">×</button></div>
        <label class="efRow">标题<input v-model="form.title" maxlength="200"></label>
        <div class="efGrid"><label class="efRow">状态<select v-model="form.status" class="sxi-sel"><option value="todo">待办</option><option value="doing">进行中</option><option value="done">已完成</option></select></label><label class="efRow">预计时长<input v-model="form.hours" maxlength="50" placeholder="如 0.5h"></label></div>
        <label class="efRow">说明<textarea v-model="form.detail" rows="3" maxlength="2000"></textarea></label>
        <label class="efRow">产出物<textarea v-model="form.artifact" rows="2" maxlength="500"></textarea></label>
        <label class="efRow">验收标准<textarea v-model="form.acceptance" rows="2" maxlength="500"></textarea></label>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="savingNode" @click="saveNode">{{ savingNode ? '保存中…' : '保存' }}</button><button class="btn" type="button" @click="editOpen = false">取消</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const gid = props.host.gid;
const goal = ref({});
const nodes = ref([]);
const selected = ref(null);
const collapsed = reactive({});
const byParent = computed(() => { const m = {}; nodes.value.forEach(n => { const p = n.parent_id == null ? 0 : Number(n.parent_id); (m[p] = m[p] || []).push(n); }); Object.keys(m).forEach(k => m[k].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id)); return m; });
function kids(id) { return byParent.value[id] || []; }
function childrenOf(id) { return nodes.value.filter(n => Number(n.parent_id) === Number(id)).length; }
const pct = computed(() => goal.value.tasks_total ? Math.round((goal.value.tasks_done || 0) / goal.value.tasks_total * 100) : 0);
function isCollapsed(id) { return !!collapsed[id]; }
function toggle(row) { if (!row.hasKids) return; collapsed[row.id] = !collapsed[row.id]; }
function closeAll() { nodes.value.forEach(n => { if (kids(n.id).length) collapsed[n.id] = true; }); }
function openAll() { nodes.value.forEach(n => { collapsed[n.id] = false; }); }
function statusText(s) { return s === 'done' ? '已完成' : (s === 'doing' ? '进行中' : '待办'); }
const visibleRows = computed(() => { const out = []; const walk = (pid, depth) => { kids(pid).forEach(n => { const ch = kids(n.id); out.push({ id: n.id, title: n.title, status: n.status, level: n.level, depth, hasKids: ch.length > 0, raw: n }); if (ch.length && !collapsed[n.id]) walk(n.id, depth + 1); }); }; walk(0, 0); return out; });
const busyId = ref(0);
function pick(row) { selected.value = row.raw; loadFolders(); fnOpen.value = false; }
const fnOpen = ref(false);
const srcOpen = ref(false);
const nodeSources = computed(() => { const s = selected.value && selected.value.sources; if (!s) return []; if (Array.isArray(s)) return s; try { return JSON.parse(s) || []; } catch (e) { return []; } });
const nodeTutorials = computed(() => ((goal.value && goal.value.tutorials) || []).filter(t => Number(t.node_id) === Number(selected.value && selected.value.id)));
function fmt(iso) { try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso || ''; } }
function openSources() { fnOpen.value = false; srcOpen.value = true; }
function fnGo(kind) {
  fnOpen.value = false;
  const n = selected.value; if (!n) return;
  location.hash = '#/g/' + gid + '?open=' + kind + '&node=' + n.id;
}
async function fnTutKids() {
  const n = selected.value; if (!n || busyId.value) return;
  fnOpen.value = false;
  const kids = kidsOf(n.id);
  if (!kids.length) return toast('这个节点还没有子节点');
  if (!window.confirm('为全部 ' + kids.length + ' 个子节点生成教程？\n\n会并行处理（最多 3 个同时），可在任务中心看进度，切页面也不影响。')) return;
  let sent = 0;
  for (const k of kids) {
    try {
      await fetch('/api/nodes/' + k.id + '/tutorial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'md', note: '按父节点「' + String(n.title).slice(0, 30) + '」的学习要求，为这个子节点写一份完整、可执行的教程' }) });
      sent++;
    } catch (e) {}
  }
  toast('已提交 ' + sent + '/' + kids.length + ' 个教程任务（见任务中心）');
}
function kidsOf(id) { return nodes.value.filter(n => Number(n.parent_id) === Number(id)); }
const folders = ref([]);
const foldersLoading = ref(false);
const folderOpen = ref(false);
const folderPath = ref('');
const folderName = ref('');
const folderNote = ref('');
const folderChecking = ref(false);
const folderSaving = ref(false);
const folderPreview = ref(null);
async function loadFolders() {
  const n = selected.value;
  if (!n) { folders.value = []; return; }
  foldersLoading.value = true;
  try { const r = await api('/api/nodes/' + n.id + '/folders'); folders.value = r.folders || []; }
  catch (e) { folders.value = []; }
  foldersLoading.value = false;
}
function openFolderAdd() { folderPath.value = ''; folderName.value = ''; folderNote.value = ''; folderPreview.value = null; folderOpen.value = true; }
async function checkFolder() {
  const p = String(folderPath.value || '').trim();
  if (!p) return toast('先填一个文件夹路径');
  folderChecking.value = true;
  try {
    const r = await api('/api/node-folders/preview?path=' + encodeURIComponent(p));
    folderPreview.value = r;
  } catch (e) { folderPreview.value = null; toast('检查失败：' + e.message); }
  folderChecking.value = false;
}
async function saveFolder() {
  const n = selected.value;
  if (!n || folderSaving.value || !folderPreview.value) return;
  folderSaving.value = true;
  try {
    const r = await api('/api/nodes/' + n.id + '/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folderPreview.value.dir, name: folderName.value.trim(), note: folderNote.value.trim() }) });
    folders.value = r.folders || folders.value;
    folderOpen.value = false; toast('已关联文件夹');
  } catch (e) { toast('关联失败：' + e.message); }
  folderSaving.value = false;
}
async function delFolder(fd) {
  const n = selected.value;
  if (!n) return;
  if (!window.confirm('取消挂载「' + fd.name + '」？\n\n只删挂载关系，磁盘上的文件不动。')) return;
  try {
    const r = await api('/api/nodes/' + n.id + '/folder', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: fd.path }) });
    folders.value = r.folders || folders.value; toast('已取消挂载');
  } catch (e) { toast('取消失败：' + e.message); }
}
const editOpen = ref(false);
const savingNode = ref(false);
const form = ref({ title: '', detail: '', artifact: '', acceptance: '', hours: '', status: 'todo' });
function openEditNode() {
  const n = selected.value;
  if (!n) return;
  form.value = { title: n.title || '', detail: n.detail || '', artifact: n.artifact || '', acceptance: n.acceptance || '', hours: n.hours || '', status: n.status || 'todo' };
  editOpen.value = true;
}
async function saveNode() {
  const n = selected.value;
  if (!n || savingNode.value) return;
  if (!String(form.value.title || '').trim()) return toast('标题不能为空');
  savingNode.value = true;
  try {
    const r = await api('/api/nodes/' + n.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form.value) });
    const g = r.goal || r; goal.value = g; nodes.value = g.nodes || nodes.value;
    const fresh = nodes.value.find(x => Number(x.id) === Number(n.id));
    if (fresh) selected.value = fresh;
    editOpen.value = false; toast('节点已保存');
  } catch (e) { toast('保存失败：' + e.message); }
  savingNode.value = false;
}
async function addChild() {
  const n = selected.value;
  if (!n || busyId.value) return;
  const title = window.prompt('新子任务标题', '');
  if (title == null) return;
  const t = String(title).trim();
  if (!t) return toast('标题不能为空');
  busyId.value = n.id;
  try {
    const r = await api('/api/goals/' + gid + '/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, parent_id: n.id }) });
    const g = r.goal || r; goal.value = g; nodes.value = g.nodes || nodes.value;
    const fresh = nodes.value.find(x => Number(x.id) === Number(n.id));
    if (fresh) selected.value = fresh;
    toast('已添加子任务');
  } catch (e) { toast('添加失败：' + e.message); }
  busyId.value = 0;
}
async function delNode() {
  const n = selected.value;
  if (!n || busyId.value) return;
  if (!window.confirm('删除节点「' + String(n.title).slice(0, 30) + '」？\n\n' + (childrenOf(n.id) ? '它还有 ' + childrenOf(n.id) + ' 个子节点，会一起删除。\n\n' : '') + '删除前会自动存一版快照，可在版本管理恢复。')) return;
  if (!window.confirm('再确认一次：确定删除这个节点及其子节点？')) return;
  busyId.value = n.id;
  try {
    const r = await api('/api/nodes/' + n.id, { method: 'DELETE' });
    const g = r.goal || r; goal.value = g; nodes.value = g.nodes || nodes.value;
    selected.value = null; toast('已删除节点');
  } catch (e) { toast('删除失败：' + e.message); }
  busyId.value = 0;
}
async function setDone(row, ev) { const want = ev.target.checked; await saveStatus(row.raw, want, (ok) => { if (!ok) ev.target.checked = !want; }); }
async function toggleSelectedDone() { if (!selected.value) return; await saveStatus(selected.value, selected.value.status !== 'done'); }
async function saveStatus(node, want, onFail) { if (busyId.value) return; busyId.value = node.id; try { const r = await api('/api/nodes/' + node.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: want ? 'done' : 'todo' }) }); const g = r.goal || r; goal.value = g; nodes.value = g.nodes || nodes.value; const fresh = nodes.value.find(n => Number(n.id) === Number(node.id)); if (fresh) selected.value = fresh; toast(want ? '已完成 ✓' : '已取消完成'); } catch (e) { toast('保存失败：' + e.message); if (onFail) onFail(false); } busyId.value = 0; }
function back() { location.hash = '#/g/' + gid; }
onMounted(async () => {
  try { const r = await api('/api/goals/' + gid); const g = r.goal || r; goal.value = g; nodes.value = g.nodes || []; if (nodes.value.length) openAll(); } catch (e) { toast('路线图加载失败：' + e.message); }
});
</script>

<style scoped>
.page { max-width: 1280px; }
.emptyCard { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 70px 20px; text-align: center; color: var(--muted); }
.mapWrap { display: grid; grid-template-columns: minmax(420px, 1fr) 380px; gap: 14px; align-items: start; }
.outline { border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; }
.outlineHead { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 700; font-size: 13px; }
.rows { max-height: calc(100vh - 190px); overflow: auto; }
.row { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: left; padding: 9px 10px; font-size: 13px; cursor: pointer; color: var(--text); }
.row:hover { background: var(--soft); }
.row.sel { background: var(--soft); box-shadow: inset 3px 0 0 var(--accent); }
.row.busy { opacity: .55; }
.taskCk { flex: none; display: flex; align-items: center; }
.taskCk input { width: 15px; height: 15px; cursor: pointer; }
.row.done .rTitle { color: var(--muted); text-decoration: line-through; }
.fold { width: 16px; flex: none; color: var(--muted); font-size: 11px; }
.fold.blank { visibility: hidden; }
.ico { flex: none; }
.rTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { position: sticky; top: 12px; }
.modalMask { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 90; padding: 20px; }
.modalBox { background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: min(620px, 96vw); max-height: 90vh; overflow: auto; padding: 18px; }
.modalHead { display: flex; align-items: center; margin-bottom: 12px; }
.efRow { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 10px; }
.efRow input, .efRow textarea, .efRow select { width: 100%; box-sizing: border-box; }
.efGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fnPop { position: absolute; z-index: 40; right: 0; bottom: calc(100% + 6px); width: 280px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); padding: 10px; }
.fnPopT { font-size: 12px; color: var(--muted); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnItem { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; border-radius: 8px; padding: 8px; cursor: pointer; color: var(--text); }
.fnItem:hover { background: var(--soft); }
.fnItem .ci { font-size: 16px; flex: none; }
.fnItem .cl { display: flex; flex-direction: column; font-size: 13px; }
.fnItem .cl em { font-style: normal; font-size: 11px; color: var(--muted); margin-top: 1px; }
.srcNodeTitle { font-weight: 700; font-size: 14px; margin-top: 2px; }
.srcRow { padding: 5px 2px; font-size: 12.5px; border-bottom: 1px dashed var(--line); }
.npFolder { border: 1px solid var(--line); border-radius: 8px; padding: 8px 9px; margin-top: 6px; font-size: 12.5px; }
.npFolderHead { display: flex; align-items: center; gap: 6px; }
.npFolderPath { color: var(--muted); font-size: 11.5px; word-break: break-all; margin-top: 2px; }
.folderPrev { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 12.5px; background: var(--soft); }
.detailCard { position: relative; border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 16px; }
.detailEmpty { border: 1px dashed var(--line); border-radius: 12px; padding: 40px 16px; text-align: center; color: var(--muted); }
.dTitle { font-size: 16px; font-weight: 700; line-height: 1.5; }
.dMeta { display: flex; align-items: center; gap: 8px; margin: 10px 0; font-size: 12px; flex-wrap: wrap; }
.dSec { margin-top: 10px; font-size: 13px; line-height: 1.75; }
.dSec b { display: block; font-size: 12.5px; margin-bottom: 2px; }
.dSec p { margin: 0; white-space: pre-wrap; }
</style>