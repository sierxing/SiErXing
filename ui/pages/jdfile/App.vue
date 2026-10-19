<template>
  <div class="jdPage">
    <div class="jdHead">
      <a class="back" :href="'#/g/' + gid">← 返回目标</a>
      <span class="mapTitle">📥 信息源导入</span>
      <span class="chip gray">{{ goalTitle }}</span>
      <div class="spacer"></div>
      <a class="btn small" :href="'/api/goals/' + gid + '/jd-images/export'" download>⬇ 导出全部（文字）</a>
      <label class="btn small">⬆ 导入资料<input ref="jsonInput" type="file" accept=".json,application/json" hidden @change="importJson"></label>
      <button class="btn small" type="button" @click="openChat">💬 对话改规划</button>
    </div>

    <div ref="pasteBox" class="jdPaste" tabindex="0" @paste.prevent="onPaste" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
      <div class="jpIcon">📥</div>
      <div class="jpTitle">点击这里，按 Ctrl+V 粘贴图片</div>
      <div class="jpText">把图片 / 电子书文件或文件夹拖进来，或 <label class="jpFile">选择文件<input ref="fileInput" type="file" accept="image/*,.txt,.md,.pdf,.epub,.mobi,.azw,.azw3" multiple hidden @change="onPickFiles"></label> <label class="btn small">选择文件夹<input ref="dirInput" type="file" webkitdirectory hidden @change="onPickDir"></label></div>
      <div class="jpNote">截图粘贴、批量多选、整个文件夹都行；图片走视觉模型识别，txt / pdf / epub / mobi 本地解析后提炼；已在库的电子书自动跳过；全部进入资料库、规划时优先参考</div>
      <div v-if="busyText" class="jpBusy"><span class="spinner"></span> {{ busyText }}</div>
    </div>

    <div v-if="jobs.length" class="ebBar">
      <span class="jdJobTxt">批量导入：共 <b>{{ jobSummary.total }}</b> · ✅ <b>{{ jobSummary.ok }}</b> · ❌ <b>{{ jobSummary.fail }}</b> · ⏭ 跳过 <b>{{ jobSummary.skip }}</b><template v-if="jobSummary.active"> · ⏳ 进行中 <b>{{ jobSummary.active }}</b></template></span>
      <div class="spacer"></div>
      <button v-if="jobSummary.fail" class="btn small" type="button" @click="retryAll">🔄 重试全部失败</button>
      <button v-if="(jobSummary.ok || jobSummary.skip) && !jobSummary.active" class="btn small" type="button" @click="clearDone">🧹 清空已完成/跳过</button>
    </div>
    <div v-if="jobs.length" class="ebList">
      <div v-for="j in jobs" :key="j.key" class="ebRow jdJob">
        <span class="ebFileIcon">{{ j.kind === 'ebook' ? '📖' : '🖼' }}</span>
        <div class="ebMain">
          <div class="ebName" :title="j.rel">{{ j.rel }} <span class="muted">({{ sizeText(j.size) }})</span></div>
          <div class="ebStatus"><span class="ebSt" :class="jobCls(j)">{{ jobStatusText(j) }}</span><button v-if="j.status === 'fail'" class="btn tiny primary" type="button" @click="retryJob(j)">重试</button></div>
        </div>
      </div>
    </div>

    <div class="jdRepo">
      <div class="jdRepoHd"><span>📦 导入代码库</span><span class="muted">目标是「搞懂某个项目的源码」时，唯一的一手资料就是这个代码库本身 —— 不用再去网上搜</span></div>
      <div class="jdRepoRow"><input v-model="repoPath" placeholder="本机路径，例如 /home/you/my-project 或 ~/code/app" spellcheck="false"><button class="btn small primary" type="button" :disabled="repoBusy" @click="importRepo">{{ repoBusy ? 'AI 正在读…' : '读取并导入' }}</button></div>
      <div class="jpNote">只读读取：.env / 密钥 / node_modules / .git 一律不读，路径不会离开这台机器。AI 会整理出「要掌握哪些概念、按什么顺序读」的摘要；同时把完整代码（已脱敏）存进资料库 —— 之后在对话里直接问具体逻辑（如「看 server/ai.js」）就能查阅。</div>
      <div v-if="repoMsg" class="muted" style="margin-top:6px;" v-html="repoMsg"></div>
    </div>

    <div class="jdList">
      <div v-for="jd in list" :key="jd.id" class="jdCard">
        <a v-if="isEbook(jd)" class="jdThumb jdFile" :href="'/uploads/' + encodeURIComponent(jd.file)" target="_blank" title="打开 / 下载原文件"><span class="jdFileIcon">📚</span><span class="jdFileExt">{{ fileExt(jd.file) || 'ebook' }}</span></a>
        <a v-else class="jdThumb" :href="'/uploads/' + encodeURIComponent(jd.file)" target="_blank"><img :src="'/uploads/' + encodeURIComponent(jd.file)" alt="图片资料"></a>
        <div class="jdMain">
          <div class="jdTop"><span class="jdTitle">{{ jd.title || (isEbook(jd) ? '电子书' : '图片资料') }}</span><span class="chip">{{ isEbook(jd) ? '书籍' : (exOf(jd).type || '资料') }}</span><span v-if="isEbook(jd) && ebookMeta(jd).chars" class="chip gray">{{ ebookMeta(jd).kind || fileExt(jd.file) }} · 约 {{ ebookMeta(jd).chars }} 字{{ ebookMeta(jd).truncated ? ' · 超长截断' : '' }}</span><span class="chip gray">{{ fmtDate(jd.created_at) }}</span><div class="spacer"></div><button class="btn tiny danger" type="button" @click="remove(jd)">删除</button></div>
          <div v-if="exOf(jd).summary" class="jdSum">{{ exOf(jd).summary }}</div>
          <details v-if="hasEx(jd)" class="jdDet">
            <summary>查看提炼内容（章节 / 要点 / 关键词 / 关键项）</summary>
            <div v-for="sec in sectionsOf(jd)" :key="sec.title" class="jdSec"><div class="jdSecT">{{ sec.title }}</div><ul><li v-for="(x, i) in sec.items" :key="i">{{ x }}</li></ul></div>
            <div v-if="exOf(jd).raw_text" class="jdSec"><div class="jdSecT">原文摘录</div><pre class="jdRaw">{{ String(exOf(jd).raw_text).slice(0, 1500) }}</pre></div>
          </details>
          <div v-if="jd.status === 'failed' || (jd.source_id && jd.source_exists === false)" class="jdFail">
            {{ jd.status === 'failed' ? ('⚠️ 提炼失败：' + (jd.error || '未知原因')) : '⚠️ 这条资料源已在「信息源」里被删除，点「重试识别」可重新导入' }}
            <div class="jdOps"><button class="btn tiny primary" type="button" :disabled="busyText" @click="retryImage(jd)">🔄 重试识别</button><span class="muted" style="font-size:11.5px;">重新提炼并更新信息源，不用重新上传</span></div>
          </div>
          <div class="jdSrc">{{ jd.status === 'failed' ? '尚未导入资料库' : '已导入资料库（' + (jd.source_id ? '#' + jd.source_id : '—') + '），AI 规划与对话时会优先参考' }} · <a :href="'/uploads/' + encodeURIComponent(jd.file)" target="_blank">下载原文件</a></div>
        </div>
      </div>
      <div v-if="!list.length" class="muted" style="padding:20px 4px;">还没有资料。粘贴一张截图，或拖入文件 / 文件夹试试。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) }, goalId: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 10));
const gid = Number(props.goalId) || 0;

const EBOOK_EXTS = ['txt', 'md', 'markdown', 'text', 'log', 'pdf', 'epub', 'mobi', 'azw', 'azw3'];
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MAX_IMG = 8 * 1024 * 1024, MAX_EB = 12 * 1024 * 1024;
const list = ref([]);
const goalTitle = ref('');
const repoPath = ref('');
const repoBusy = ref(false);
const repoMsg = ref('');
const dragOver = ref(false);
const pasteBox = ref(null);
const jsonInput = ref(null);
const fileInput = ref(null);
const dirInput = ref(null);
const jobs = ref([]);
const jdQueue = ref([]);
const ebQueue = ref([]);
const jdRunning = ref(0);
const ebRunning = ref(0);
let seq = 0;
const busyText = computed(() => {
  const parts = [];
  if (jdRunning.value || jdQueue.value.length) parts.push((jdRunning.value ? '正在识别 ' + jdRunning.value + ' 张' : '') + (jdQueue.value.length ? '（排队 ' + jdQueue.value.length + ' 张）' : ''));
  if (ebRunning.value || ebQueue.value.length) parts.push((ebRunning.value ? '正在提炼 ' + ebRunning.value + ' 本' : '') + (ebQueue.value.length ? '（排队 ' + ebQueue.value.length + ' 本）' : ''));
  return parts.join('；');
});
const jobSummary = computed(() => {
  const s = { total: 0, ok: 0, fail: 0, skip: 0, active: 0 };
  for (const r of jobs.value) {
    if (r.status === 'skip' || r.status === 'dup') { s.skip++; continue; }
    s.total++;
    if (r.status === 'done') s.ok++;
    else if (r.status === 'fail') s.fail++;
    else s.active++;
  }
  return s;
});

function fileExt(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function isEbook(jd) { if (!jd) return false; if (jd.mime && !String(jd.mime).startsWith('image/')) return true; return EBOOK_EXTS.includes(fileExt(jd.file)); }
function exOf(jd) { try { const o = JSON.parse(jd.extracted || 'null'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
function ebookMeta(jd) { const ex = exOf(jd); return (ex && ex._ebook) || {}; }
function hasEx(jd) { const ex = exOf(jd); return !!(ex && Object.keys(ex).length); }
function sectionsOf(jd) {
  const ex = exOf(jd); const out = [];
  const add = (title, arr) => { if (Array.isArray(arr) && arr.length) out.push({ title, items: arr.map(x => String(x)) }); };
  if (isEbook(jd)) { const m = ebookMeta(jd); add('章节目录', m.chapters); }
  add('关键要点', ex.points);
  add('结构化内容', ex.sections || ex.duties || ex.requirements);
  add('关键词', ex.keywords || ex.skills);
  add('硬性条件 / 前置知识', ex.hard_conditions);
  add('最关键内容', ex.priority);
  add('建议行动', ex.actions);
  const other = [];
  if (ex.source || ex.company) other.push('来源：' + (ex.source || ex.company));
  if (ex.location) other.push('地点：' + ex.location);
  if (ex.salary) other.push('薪资：' + ex.salary);
  if (other.length) out.push({ title: '其他信息', items: other });
  return out;
}
function sizeText(n) { n = Number(n || 0); return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
function jobStatusText(j) {
  if (j.status === 'wait') return '⏳ 等待';
  if (j.status === 'up') return '⬆ 上传中…';
  if (j.status === 'work') return j.detail || '提炼中…';
  if (j.status === 'done') return '✅ 已完成';
  if (j.status === 'dup') return '⏭ 已在库，跳过';
  if (j.status === 'skip') return '⏭ 跳过：' + (j.detail || '');
  if (j.status === 'fail') return '❌ ' + (j.detail || '失败');
  return '';
}
function jobCls(j) { return j.status === 'done' ? 'ok' : j.status === 'fail' ? 'fail' : j.status === 'dup' || j.status === 'skip' ? 'dup' : j.status === 'work' ? 'work' : j.status === 'up' ? 'up' : 'wait'; }
function isImgFile(f) { if (!f) return false; if (f.type && f.type.startsWith('image/')) return true; return IMG_EXTS.includes(fileExt(f.name)); }
function isEbookFile(f) { if (!f) return false; if (f.type && f.type.startsWith('image/')) return false; const ext = fileExt(f.name); if (EBOOK_EXTS.includes(ext)) return true; if (!ext && f.type && (f.type.startsWith('text/') || f.type === 'application/pdf' || f.type === 'application/epub+zip')) return true; return false; }

async function load() {
  try { const r = await api('/api/goals/' + gid); goalTitle.value = (r.goal && r.goal.title) || ''; } catch (e) {}
  await refreshImages();
}
async function refreshImages() { try { list.value = (await api('/api/goals/' + gid + '/jd-images')).images || []; } catch (e) { list.value = []; } }

/* ---------- 批量队列（图片 3 并发 / 电子书 2 并发） ---------- */
function enqueueImages(files) {
  if (!files || !files.length) return;
  let n = 0;
  for (const it of files) {
    const f = it.file || it;
    const job = { key: ++seq, file: f, name: f.name, rel: it.rel || f.name, size: f.size || 0, kind: 'image', status: 'wait', detail: '' };
    if (!isImgFile(f)) { job.status = 'skip'; job.detail = '非图片/电子书格式'; }
    else if (!f.size) { job.status = 'skip'; job.detail = '空文件'; }
    else if (f.size > MAX_IMG) { job.status = 'skip'; job.detail = '超过 8MB'; }
    else { jdQueue.value.push(job); n++; }
    jobs.value.push(job);
  }
  if (n) toast('已加入 ' + n + ' 张图片（并行识别，最多 3 张同时处理）');
  pumpImages();
}
function enqueueEbooks(files) {
  if (!files || !files.length) return;
  const known = new Set();
  for (const jd of list.value) { try { const ex = JSON.parse(jd.extracted || 'null'); if (ex && ex._ebook && ex._ebook.filename) known.add(ex._ebook.filename); } catch (e) {} }
  let added = 0, dup = 0;
  for (const it of files) {
    const f = it.file || it;
    const job = { key: ++seq, file: f, name: f.name, rel: it.rel || f.name, size: f.size || 0, kind: 'ebook', status: 'wait', detail: '' };
    if (!isEbookFile(f)) { job.status = 'skip'; job.detail = '非图片/电子书格式'; }
    else if (!f.size) { job.status = 'skip'; job.detail = '空文件'; }
    else if (f.size > MAX_EB) { job.status = 'skip'; job.detail = '超过 12MB'; }
    else if (known.has(f.name)) { job.status = 'dup'; dup++; }
    else { ebQueue.value.push(job); known.add(f.name); added++; }
    jobs.value.push(job);
  }
  toast('已加入 ' + added + ' 本电子书' + (dup ? '（' + dup + ' 本已在库，跳过）' : ''));
  pumpEbooks();
}
function pumpImages() {
  while (jdRunning.value < 3 && jdQueue.value.length) {
    const job = jdQueue.value.shift();
    jdRunning.value++;
    uploadImageJob(job).finally(() => { jdRunning.value--; pumpImages(); });
  }
}
function pumpEbooks() {
  while (ebRunning.value < 2 && ebQueue.value.length) {
    const job = ebQueue.value.shift();
    ebRunning.value++;
    uploadEbookJob(job).finally(() => { ebRunning.value--; pumpEbooks(); });
  }
}
function readAsDataURL(file) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); }); }
async function readStream(resp, cb) {
  const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '', finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let d = null; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
      cb(d);
      if (d.done || d.error) finished = true;
    }
  }
  return finished;
}
async function uploadImageJob(job) {
  job.status = 'up'; job.detail = '正在读取…';
  try {
    const dataUrl = await readAsDataURL(job.file);
    job.status = 'work'; job.detail = 'AI 正在识别…';
    const resp = await fetch('/api/goals/' + gid + '/jd-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接识别服务');
    let ok = false;
    await readStream(resp, d => { if (d.status) job.detail = d.status; else if (d.done) { ok = true; job.status = 'done'; job.detail = ''; } else if (d.error) { job.status = 'fail'; job.detail = d.error; } });
    if (!ok && job.status !== 'fail') { job.status = 'fail'; job.detail = '识别中断，可重试'; }
  } catch (e) { job.status = 'fail'; job.detail = e.message || '上传失败'; }
  await refreshImages();
}
async function uploadEbookJob(job) {
  job.status = 'up'; job.detail = '正在读取…';
  try {
    const dataUrl = await readAsDataURL(job.file);
    job.status = 'work'; job.detail = '本地解析中…';
    const resp = await fetch('/api/goals/' + gid + '/ebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: job.name, dataUrl }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接提炼服务');
    let ok = false;
    await readStream(resp, d => { if (d.status) job.detail = d.status; else if (d.done) { ok = true; job.status = 'done'; job.detail = ''; } else if (d.error) { job.status = 'fail'; job.detail = d.error; } });
    if (!ok && job.status !== 'fail') { job.status = 'fail'; job.detail = '提炼中断，可重试'; }
  } catch (e) { job.status = 'fail'; job.detail = e.message || '上传失败'; }
  await refreshImages();
}
function routeFiles(items) {
  const books = [], imgs = [];
  for (const it of items) (isEbookFile(it.file || it) ? books : imgs).push(it);
  if (imgs.length) enqueueImages(imgs);
  if (books.length) enqueueEbooks(books);
  if (!imgs.length && !books.length) toast('请选择图片或电子书（txt / pdf / epub / mobi）');
}
function onPickFiles(ev) { const arr = Array.from(ev.target.files || []).map(f => ({ file: f, rel: f.name })); ev.target.value = ''; if (arr.length) routeFiles(arr); }
function onPickDir(ev) { const arr = Array.from(ev.target.files || []).map(f => ({ file: f, rel: f.webkitRelativePath || f.name })); ev.target.value = ''; if (arr.length) routeFiles(arr); }
async function filesFromDrop(dt) {
  try {
    const entries = [];
    for (const it of Array.from(dt.items || [])) { if (it.kind !== 'file') continue; const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
    if (!entries.length) return Array.from(dt.files || []).map(f => ({ file: f, rel: f.name }));
    const out = [];
    const readFile = e => new Promise(res => e.file(f => res(f), () => res(null)));
    const readDir = r => new Promise(res => r.readEntries(x => res(x || []), () => res([])));
    async function walk(e, prefix) {
      if (e.isFile) { const f = await readFile(e); if (f) out.push({ file: f, rel: (prefix || '') + f.name }); }
      else if (e.isDirectory) { const r = e.createReader(); let batch = []; do { batch = await readDir(r); for (const c of batch) await walk(c, (prefix || '') + e.name + '/'); } while (batch.length); }
    }
    for (const e of entries) await walk(e, '');
    return out.length ? out : Array.from(dt.files || []).map(f => ({ file: f, rel: f.name }));
  } catch (e) { return Array.from((dt && dt.files) || []).map(f => ({ file: f, rel: f.name })); }
}
function onDrop(ev) { dragOver.value = false; filesFromDrop(ev.dataTransfer).then(items => { if (items.length) routeFiles(items); else toast('没取到文件，请用「选择文件/文件夹」按钮'); }); }
function onPaste(ev) {
  for (const it of Array.from(ev.clipboardData && ev.clipboardData.items || [])) {
    if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { enqueueImages([{ file: f, rel: f.name }]); return; } }
  }
  toast('剪贴板里没有图片，请先截图/复制图片');
}

function retryJob(j) { j.status = 'wait'; j.detail = ''; (j.kind === 'ebook' ? ebQueue.value : jdQueue.value).push(j); j.kind === 'ebook' ? pumpEbooks() : pumpImages(); }
function retryAll() { let n = 0; for (const j of jobs.value) if (j.status === 'fail') { retryJob(j); n++; } toast(n ? '重新加入 ' + n + ' 个失败的' : '没有失败的'); }
function clearDone() { jobs.value = jobs.value.filter(r => r.status !== 'done' && r.status !== 'skip' && r.status !== 'dup'); }
async function remove(jd) {
  if (!window.confirm('删除这条资料及其资料源？')) return;
  try { await api('/api/jd-images/' + jd.id, { method: 'DELETE' }); list.value = list.value.filter(x => String(x.id) !== String(jd.id)); toast('已删除'); }
  catch (e) { toast(e.message); }
}
async function retryImage(jd) {
  try {
    const resp = await fetch('/api/jd-images/' + jd.id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!resp.ok || !resp.body) throw new Error('无法连接识别服务');
    await readStream(resp, () => {});
    await refreshImages();
    toast('已重试');
  } catch (e) { toast(e.message); }
}
async function importJson(ev) {
  const f = (ev.target.files || [])[0]; ev.target.value = '';
  if (!f) return;
  try {
    let data; try { data = JSON.parse(await f.text()); } catch (e) { throw new Error('文件不是有效的 JSON（需要 *.sources.json）'); }
    const r = await api('/api/goals/' + gid + '/sources/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    toast('已导入 ' + (r.added || 0) + ' 条资料' + (r.skipped ? '（' + r.skipped + ' 条已存在，已跳过）' : ''));
  } catch (e) { toast(e.message); }
}
async function importRepo() {
  const p = String(repoPath.value || '').trim();
  if (!p) return toast('先填代码库路径');
  repoBusy.value = true; repoMsg.value = '正在读取并整理（几十秒，别关页面）…';
  try {
    const r = await api('/api/goals/' + gid + '/code-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    if (r.already) {
      if (r.stored && r.stored.files) toast('已补存完整代码快照：' + r.stored.files + ' 个文件');
      else toast('这个代码库已经导过了（删掉旧的可以重导）');
      repoMsg.value = '';
    } else {
      const st = r.stored || {};
      toast('已导入：' + (st.files || r.read || 0) + ' 个文件' + (st.files ? '（含完整代码快照）' : ''));
      const d = r.digest || {};
      repoMsg.value = '<b>读完了</b>（完整快照 ' + (st.files || 0) + ' 个文件' + (st.redacted ? '，脱敏 ' + st.redacted + ' 处' : '') + '）—— ' + String(d.what || '').slice(0, 120) + '　<a href="#/g/' + gid + '">回目标页看资料与规划 →</a>';
    }
  } catch (e) { toast(e.message); repoMsg.value = ''; }
  repoBusy.value = false;
}
function openChat() { try { if (props.host.aiToggle) props.host.aiToggle(true); } catch (e) {} }
onMounted(load);
</script>

<style scoped>
.jdPage { max-width: 1120px; }
</style>
