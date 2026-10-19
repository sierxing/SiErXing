<template>
  <div class="page">
    <div v-if="loading" class="muted">加载产出库…</div>
    <template v-else>
      <div class="pageHead">
        <a class="back" href="#/">← 返回</a>
        <span class="mapTitle">📦 产出库</span>
        <span class="chip gray">目录化管理 · 每个目标独立</span>
        <div class="spacer"></div>
        <select v-model.number="currentGoalId" class="sxi-sel sxi-sel-sm" @change="switchGoal">
          <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title || ('目标 ' + g.id) }}</option>
        </select>
        <button class="btn small" type="button" :disabled="working" @click="mkdir">＋ 新建文件夹</button>
        <label class="btn small">⬆ 添加文件<input type="file" multiple hidden @change="onPickFiles"></label>
        <label class="btn small">📁 添加文件夹<input type="file" webkitdirectory hidden @change="onPickDir"></label>
        <a class="btn small" :href="'/api/outlib/zip/goal/' + currentGoalId" title="打包下载当前目标的整个产出库">⬇ 打包整库</a>
        <a class="btn small" :href="'?ui=legacy#/outlib'" title="旧版产出库（写操作已迁到本页，旧版仅作回退）">旧版</a>
      </div>

      <div v-if="!goals.length" class="olEmpty" style="margin-top:30px;"><div class="ebIcon">📦</div><div>还没有目标：先建一个目标，这里的产出库会自动按目标隔离。</div></div>
      <template v-else>
        <div class="olCrumb"><span>产出库</span><template v-for="(p, i) in path" :key="p.id"><span class="olSep">›</span><span v-if="i === path.length - 1" class="olCur">{{ p.name }}</span><a v-else href="javascript:void 0" @click="curDir = p.id">{{ p.name }}</a></template></div>
        <div class="olWrap">
          <div class="olSide">
            <div class="olSideTitle">目录</div>
            <div class="olTree">
              <div class="olNode" :class="{ sel: curDir === 0 }" @click="curDir = 0" @dragover.prevent @drop="onDropFolder(0, $event)"><span class="olIc">🏠</span><span class="olNm">全部产出</span></div>
              <div v-for="n in folderRows" :key="n.id" class="olNode" :class="{ sel: curDir === n.id }" :style="{ marginLeft: ((n.depth - 1) * 12) + 'px' }" @click="curDir = n.id" @dragover.prevent @drop="onDropFolder(n.id, $event)">
                <span class="olIc">📁</span><span class="olNm">{{ n.name }}</span><span class="olCt">{{ n.files || '' }}</span>
              </div>
            </div>
          </div>
          <div class="olMain" @dragover.prevent @drop="onDropRoot($event)">
            <div v-if="!rows.length" class="olEmpty"><div class="ebIcon">🗂</div><div>这里还没有产出。点上方「添加文件/添加文件夹」，或把文件和文件夹拖进来。</div></div>
            <div v-for="n in rows" :key="n.id" class="olRow" draggable="true"
              :class="{ picked: preview && preview.id === n.id, lost: isLost(n), dragging: dragId === n.id, dropInto: dropHint && dropHint.id === n.id && dropHint.pos === 'into', dropBefore: dropHint && dropHint.id === n.id && dropHint.pos === 'before', dropAfter: dropHint && dropHint.id === n.id && dropHint.pos === 'after' }"
              @dragstart="onDragStart(n, $event)" @dragover="onDragOver(n, $event)" @drop.stop="onDropRow(n, $event)" @dragend="onDragEnd">
              <span class="olIc">{{ isDir(n) ? '📁' : (isLost(n) ? '⚠️' : '📄') }}</span>
              <span class="olNm" @click="openNode(n)">{{ n.name }}</span>
              <span class="olMeta"><span>{{ sizeText(n) }}</span><span>{{ String(n.updated_at || '').slice(0, 10) }}</span></span>
              <span class="olOps">
                <a v-if="!isDir(n) && !isLost(n)" :href="'/api/outlib/dl/' + n.id" title="下载">⬇</a>
                <button v-if="!isDir(n) && canPreview(n)" title="预览" type="button" @click="preview = n">👁</button>
                <a v-if="isDir(n)" :href="'/api/outlib/zip/' + n.id" title="打包下载">🧩</a>
                <button title="改名" type="button" @click="rename(n)">✏️</button>
                <button title="移动到…" type="button" @click="openMove(n)">↔️</button>
                <button title="删除" class="danger" type="button" @click="remove(n)">🗑</button>
              </span>
            </div>
          </div>
        </div>

        <div v-if="preview" class="olPreview">
          <div class="olPvHead">👁 {{ preview.name }}<div class="spacer"></div><a class="btn tiny" :href="'/api/outlib/dl/' + preview.id" download>⬇ 下载</a><button class="btn tiny" type="button" @click="preview = null">关闭</button></div>
          <div class="olPvBody">
            <img v-if="/^image\//.test(preview.mime || '')" :src="inlineUrl(preview)" alt="">
            <video v-else-if="/^video\//.test(preview.mime || '')" :src="inlineUrl(preview)" controls style="max-width:100%"></video>
            <audio v-else-if="/^audio\//.test(preview.mime || '')" :src="inlineUrl(preview)" controls></audio>
            <iframe v-else-if="/pdf/.test(preview.mime || '')" :src="inlineUrl(preview)" style="width:100%;height:60vh;border:0;"></iframe>
            <div v-else class="muted">此类型暂不支持内嵌预览，点「⬇ 下载」用本地程序打开。</div>
          </div>
        </div>

        <div v-if="moveNode" class="olModal">
          <div class="olModalCard" style="width:min(420px,94vw)">
            <h4>移动「{{ moveNode.name }}」</h4>
            <div class="olModalTip">选一个目标文件夹</div>
            <select v-model.number="moveTarget" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font-size:13px;margin-bottom:4px;">
              <option :value="0">📦 产出库根目录</option>
              <option v-for="f in moveFolders" :key="f.id" :value="f.id">{{ '　'.repeat(f.depth) }}{{ '📁 ' + f.name }}</option>
            </select>
            <div class="olModalOps"><div class="spacer"></div><button class="btn small" type="button" @click="moveNode = null">取消</button><button class="btn small primary" type="button" @click="confirmMove">移动到这里</button></div>
          </div>
        </div>

        <div v-if="job.open" class="libCleanMask">
          <div class="libCleanBox">
            <button class="libCleanX" type="button" title="关掉这个框（上传在后台继续）" @click="job.open = false">×</button>
            <div class="libCleanT">{{ job.title }}</div>
            <div class="libCleanBig">{{ job.big || '准备中…' }}</div>
            <div class="taskProg" style="margin-top:8px;"><i :style="{ width: job.pct + '%' }"></i></div>
            <div class="libCleanSub">{{ job.now }}</div>
            <div class="libCleanS">{{ job.status }}</div>
            <div class="libCleanBtns"><button class="btn primary" type="button" @click="job.open = false">关掉，后台继续</button></div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

const props = defineProps({
  host: { type: Object, default: () => ({}) },
  goalId: { type: Number, default: 0 }
});
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };

const loading = ref(true);
const goals = ref([]);
const currentGoalId = ref(Number(props.goalId) || 0);
const tree = ref([]);
const curDir = ref(0);
const preview = ref(null);
const dragId = ref(0);
const dropHint = ref(null);
const moveNode = ref(null);
const moveTarget = ref(0);
const working = ref(false);
const job = reactive({ open: false, title: '', big: '', pct: 0, now: '', status: '' });

const byId = (id) => tree.value.find(n => Number(n.id) === Number(id)) || null;
const isDir = (n) => n && n.kind === 'dir';
const isLost = (n) => !isDir(n) && n.has_file === false;
const kids = (id) => tree.value.filter(n => Number(n.parent_id || 0) === Number(id || 0)).sort((a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || (a.id - b.id));
const rows = computed(() => kids(curDir.value));
const path = computed(() => {
  const chain = [];
  let n = byId(curDir.value);
  while (n) { chain.unshift(n); n = n.parent_id ? byId(n.parent_id) : null; }
  return chain;
});
function walkFolders(id, depth, out) {
  for (const n of kids(id)) {
    if (isDir(n)) { out.push(Object.assign({}, n, { depth, files: dirFiles(n.id) })); walkFolders(n.id, depth + 1, out); }
  }
}
function dirFiles(id) {
  let files = 0;
  const walk = pid => kids(pid).forEach(c => { if (isDir(c)) walk(c.id); else files++; });
  walk(id);
  return files;
}
const folderRows = computed(() => { const out = []; walkFolders(0, 1, out); return out; });
function byteSize(id) {
  let bytes = 0;
  const walk = pid => kids(pid).forEach(c => { if (isDir(c)) walk(c.id); else bytes += Number(c.size || 0); });
  walk(id);
  return bytes;
}
function fmtSize(b) {
  b = Number(b || 0);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function sizeText(n) {
  if (isLost(n)) return '文件本体缺失';
  if (isDir(n)) return dirFiles(n.id) + ' 个文件 · ' + fmtSize(byteSize(n.id));
  return fmtSize(n.size);
}
function canPreview(n) { return !isLost(n) && n.mime && /^image\/|^video\/|^audio\/|application\/pdf/.test(n.mime); }
function inlineUrl(n) { return '/api/outlib/dl/' + n.id + '?inline=1'; }
function openNode(n) { if (isDir(n)) { curDir.value = n.id; preview.value = null; } else if (canPreview(n)) preview.value = n; else toast('此类型不支持预览，请下载查看'); }

function setJob(title, big) { job.open = true; job.title = title; job.big = big || '准备中…'; job.pct = 0; job.now = ''; job.status = ''; }
async function post(p, body) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function loadGoals() {
  try { goals.value = (await api('/api/goals')).goals || []; } catch (e) { goals.value = []; }
  if (!goals.value.some(g => Number(g.id) === Number(currentGoalId.value))) currentGoalId.value = goals.value.length ? Number(goals.value[0].id) : 0;
}
async function loadTree() {
  if (!currentGoalId.value) { tree.value = []; return; }
  try { tree.value = (await api('/api/outlib/nodes/' + currentGoalId.value)).nodes || []; }
  catch (e) { tree.value = []; toast('产出库加载失败：' + e.message); }
}
async function refresh() {
  await loadTree();
  if (curDir.value && !byId(curDir.value)) curDir.value = 0;
  if (preview.value && !byId(preview.value.id)) preview.value = null;
}
function switchGoal() { curDir.value = 0; preview.value = null; refresh(); }

async function mkdir() {
  const name = window.prompt('新建文件夹名字：', '新文件夹');
  if (name == null) return;
  try { await post('/api/outlib/dir', { goal_id: currentGoalId.value, parent_id: curDir.value, name }); await refresh(); }
  catch (e) { toast('新建失败：' + e.message); }
}
async function rename(n) {
  const name = window.prompt('改名为：', n.name);
  if (name == null || !name.trim() || name === n.name) return;
  try { await post('/api/outlib/rename', { id: n.id, name: name.trim() }); await refresh(); }
  catch (e) { toast('改名失败：' + e.message); }
}
async function remove(n) {
  const extra = isDir(n) ? '（里面的文件也会一起删掉）' : '';
  if (!window.confirm('删除「' + n.name + '」？' + extra)) return;
  try { await post('/api/outlib/delete', { id: n.id }); if (preview.value && preview.value.id === n.id) preview.value = null; await refresh(); }
  catch (e) { toast('删除失败：' + e.message); }
}
async function moveTo(id, parentId) {
  try { await post('/api/outlib/move', { id, parent_id: parentId }); await refresh(); }
  catch (e) { toast('移动失败：' + e.message); }
}
const moveFolders = computed(() => {
  if (!moveNode.value) return [];
  const bad = new Set([moveNode.value.id]);
  if (isDir(moveNode.value)) (function mark(pid) { kids(pid).forEach(c => { bad.add(c.id); if (isDir(c)) mark(c.id); }); })(moveNode.value.id);
  const out = [];
  (function walk(pid, depth) { kids(pid).forEach(c => { if (isDir(c) && !bad.has(c.id)) { out.push(Object.assign({}, c, { depth })); walk(c.id, depth + 1); } }); })(0, 1);
  return out;
});
function openMove(n) { moveNode.value = n; moveTarget.value = Number(n.parent_id || 0); }
async function confirmMove() {
  const n = moveNode.value;
  if (!n) return;
  const to = Number(moveTarget.value) || 0;
  moveNode.value = null;
  if (to === Number(n.parent_id || 0)) return toast('已经在那个文件夹里了');
  await moveTo(n.id, to);
}

/* ---------- 上传 ---------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}
async function addFiles(list) {
  const items = (list || []).map(x => (x && x.file instanceof Blob) ? x : { file: x, rel: '' }).filter(x => x.file instanceof Blob);
  if (!items.length) return toast('没有可添加的文件');
  working.value = true;
  setJob('📥 正在添加产出', '准备中…');
  const BATCH_MAX = 12;
  let ok = 0, fail = 0, lastErr = '';
  const batch = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    for (let s0 = 0; s0 < items.length; s0 += BATCH_MAX) {
      const chunk = items.slice(s0, s0 + BATCH_MAX);
      const payload = [];
      for (let k = 0; k < chunk.length; k++) {
        const it = chunk[k], f = it.file;
        job.big = '已处理 ' + (s0 + k) + ' / ' + items.length + ' 个文件';
        job.pct = Math.round(100 * (s0 + k) / items.length);
        job.now = f.name;
        try { payload.push({ name: f.name, mime: f.type || '', data: await fileToBase64(f), rel: it.rel || '' }); }
        catch (e) { fail++; lastErr = e.message; }
      }
      if (!payload.length) continue;
      try { const r = await post('/api/outlib/files', { goal_id: currentGoalId.value, parent_id: curDir.value, batch, files: payload }); ok += (r && r.added && r.added.length) || payload.length; }
      catch (e) {
        for (const p1 of payload) {
          try { await post('/api/outlib/files', { goal_id: currentGoalId.value, parent_id: curDir.value, batch, files: [p1] }); ok++; }
          catch (e2) { fail++; lastErr = e2.message; }
        }
      }
    }
    job.pct = 100;
    if (ok) toast('已添加 ' + ok + ' 个文件' + (fail ? '，' + fail + ' 个失败' : ''));
    if (fail) toast('最后一个错误：' + lastErr);
  } catch (e) { toast('添加失败：' + e.message); }
  finally { working.value = false; job.open = false; await refresh(); }
}
function onPickFiles(ev) {
  const files = Array.from((ev.target.files) || []); ev.target.value = '';
  if (files.length) addFiles(files);
}
function onPickDir(ev) {
  const files = Array.from((ev.target.files) || []).map(f => {
    const parts = String(f.webkitRelativePath || '').split('/').filter(Boolean);
    return { file: f, rel: parts.slice(1).join('/') };
  });
  ev.target.value = '';
  if (files.length) addFiles(files);
}
/* 外部文件/文件夹拖入（webkitGetAsEntry 递归） */
async function readEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    await new Promise(res => entry.file(f => { if (f instanceof Blob) out.push({ file: f, rel: prefix }); res(); }, () => res()));
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const base = prefix + entry.name + '/';
  for (;;) {
    const batch = await new Promise(res => { try { reader.readEntries(list => res(list || []), () => res([])); } catch (e) { res([]); } });
    if (!batch.length) break;
    for (const e of batch) await readEntry(e, base, out);
  }
}
async function collectDrop(dt) {
  const out = [];
  const entries = [];
  for (const it of Array.from((dt && dt.items) || [])) { if (it.kind && it.kind !== 'file') continue; entries.push(it.webkitGetAsEntry ? it.webkitGetAsEntry() : null); }
  for (const en of entries) if (en) await readEntry(en, '', out);
  if (!out.length) for (const f of Array.from((dt && dt.files) || [])) if (f instanceof Blob) out.push({ file: f, rel: '' });
  return out;
}
async function onDropRoot(e) {
  e.preventDefault();
  const files = e.dataTransfer && Array.from(e.dataTransfer.files || []);
  if (files && files.length) { const items = await collectDrop(e.dataTransfer); if (items.length) await addFiles(items); return; }
  if (dragId.value) await finishReorder(dragId.value, 0, 'end');
  dragId.value = 0; dropHint.value = null;
}
async function onDropFolder(folderId, e) {
  e.preventDefault(); e.stopPropagation();
  if (dragId.value && Number(dragId.value) !== Number(folderId)) { const id = dragId.value; dragId.value = 0; dropHint.value = null; await moveTo(id, folderId); return; }
  if (e.dataTransfer && Array.from(e.dataTransfer.files || []).length) { const items = await collectDrop(e.dataTransfer); if (items.length) { curDir.value = folderId; await addFiles(items); } }
  dragId.value = 0; dropHint.value = null;
}

/* ---------- 拖拽排序 ---------- */
function onDragStart(n, e) {
  dragId.value = n.id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(n.id)); } catch (err) {}
}
function onDragOver(n, e) {
  if (!dragId.value || dragId.value === n.id) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  if (isDir(n)) dropHint.value = { id: n.id, pos: 'into' };
  else { const r = e.currentTarget.getBoundingClientRect(); dropHint.value = { id: n.id, pos: (e.clientY - r.top) < r.height / 2 ? 'before' : 'after' }; }
}
async function onDropRow(n, e) {
  e.preventDefault(); e.stopPropagation();
  if (!dragId.value) {
    if (e.dataTransfer && Array.from(e.dataTransfer.files || []).length) { const items = await collectDrop(e.dataTransfer); if (items.length) await addFiles(items); }
    return;
  }
  const id = dragId.value; const hint = dropHint.value;
  dragId.value = 0; dropHint.value = null;
  if (!hint) return;
  if (hint.pos === 'into') await moveTo(id, n.id);
  else await finishReorder(id, hint.id, hint.pos);
}
function onDragEnd() { dragId.value = 0; dropHint.value = null; }
async function finishReorder(movingId, targetId, pos) {
  const sibs = kids(curDir.value).filter(n => Number(n.id) !== Number(movingId)).map(n => n.id);
  let idx = sibs.length;
  if (targetId && pos !== 'end') { const at = sibs.indexOf(targetId); if (at >= 0) idx = pos === 'before' ? at : at + 1; }
  sibs.splice(idx, 0, Number(movingId));
  try { await post('/api/outlib/order', { parent_id: curDir.value, ids: sibs }); }
  catch (e) { toast('排序失败：' + e.message); }
  await refresh();
}

async function boot() {
  loading.value = true;
  await loadGoals();
  await loadTree();
  loading.value = false;
}
onMounted(boot);
</script>

<style scoped>
.page { max-width: 1180px; }
</style>
