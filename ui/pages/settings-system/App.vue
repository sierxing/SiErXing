<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">ℹ 系统信息</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="load">↻ 刷新</button>
    </div>

    <div class="secCard">
      <div class="secHead"><span>💾 数据存储路径</span><div class="spacer"></div><span class="chip" :class="loc.custom ? 'ok' : 'gray'">{{ loc.custom ? '已改过位置' : '默认位置（程序目录下）' }}</span><span class="chip" :class="loc.writable ? 'gray' : 'danger'">{{ loc.writable ? '可写' : '不可写！' }}</span></div>
      <div v-if="loc.dir" class="pathLine" :title="loc.dir">📂 <code>{{ loc.dir }}</code></div>
      <div class="hint" style="margin-top:6px;"><template v-if="loc.bytes">{{ fmtBytes(loc.bytes) }} · {{ loc.files }} 个文件<template v-if="loc.at"> · {{ String(loc.at).slice(0,10) }} 改的</template></template><template v-else>正在读取…</template></div>
      <p v-if="loc.lost" class="hint" style="color:var(--danger);margin-top:8px;">⚠️ 之前指定的目录找不到了（{{ loc.lost }}），已临时回落到默认目录 —— 可能是移动硬盘没插。</p>
      <p class="hint" style="margin-top:10px;line-height:1.8;">迁移分四步：复制 → 校验行数 → 切换指针 → 删除原目录；任何一步不通过就不切，数据留在原地。切换后需要重启一次才生效。</p>
      <div class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;">
        <button class="btn small primary" type="button" @click="openMoveDlg('move')">📁 更改 / 迁移数据存储路径</button>
        <button v-if="loc.custom" class="btn small" type="button" :disabled="busy" @click="resetToDefault">搬回程序目录</button>
        <button v-if="loc.custom" class="btn small" type="button" @click="openMoveDlg('use')">用别的目录里已有的数据</button>
        <span v-if="!loc.canPick" class="hint" style="align-self:center;">这个系统没有图形目录选择器，请把路径粘进输入框</span>
      </div>
      <p v-if="!loc.custom && loc.inHome === false && loc.bytes > 1024 * 1024 * 1024" class="hint" style="margin-top:8px;">数据已经在系统盘（用户目录）下并超过 1 GB，建议搬到空间更大的盘。</p>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>📖 帮助</span></div>
      <p class="hint" style="margin:8px 0;">使用引导会介绍：如何接入模型、组件是什么、一条目标的完整使用流程。</p>
      <button class="btn small" type="button" @click="showGuide">📖 重新查看使用引导</button>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>关于</span></div>
      <p class="muted" style="font-size:13px;line-height:1.9;margin:8px 0;">思而行 · 你的目标规划助手 · 本地运行 · 零依赖<br>数据文件：data/sierxing.db，所有数据只保存在你自己的电脑上。<br>版本：{{ version }}</p>
    </div>

    <div v-if="dlg" class="modalMask" @click.self="closeDlg">
      <div class="modalBox">
        <div class="modalHead"><b>{{ dlgMode === 'use' ? '🔗 用别的目录里已有的数据' : '📦 把数据搬到别处' }}</b><div class="spacer"></div><button class="btn tiny" type="button" @click="closeDlg">×</button></div>
        <p class="hint" style="margin:2px 0 10px;">{{ dlgMode === 'use' ? '只改「数据在哪」，不复制任何东西。目标目录里要有 sierxing.db。' : '数据库、上传的资料、作答记录、备份会一起搬过去；校验通过才删原来的，中途出岔子就停在原地。' }}</p>
        <div class="pathLine" style="margin-bottom:6px;">从：<code>{{ loc.dir || '…' }}</code> <span class="muted">（{{ fmtBytes(loc.bytes) }} · {{ loc.files }} 个文件）</span></div>
        <label class="efRow">到<span class="muted">（填绝对路径，或点下面打开系统目录选择器）</span><input v-model="dlgPath" @input="onPathInput" :placeholder="loc.platform === 'win32' ? 'D:\\思而行数据' : '/mnt/d/sierxing 或 ~/Documents/思而行'" spellcheck="false" autocomplete="off"></label>
        <div class="toolbarRow" style="margin-top:6px;">
          <button v-if="loc.canPick" class="btn small" type="button" :disabled="picking" @click="pickDir">{{ picking ? '等待选择…' : '📂 打开系统目录选择器' }}</button>
          <span v-if="pickMsg" class="hint">{{ pickMsg }}</span>
        </div>
        <div class="storeCheck" :class="checkState.kind">{{ checkState.text || '填个路径，这里会先帮你看看能不能放' }}<span v-if="checkState.tip" class="muted"> {{ checkState.tip }}</span></div>
        <div v-if="dlgMode !== 'use'" class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;">
          <label class="modeOpt"><input v-model="dlgModeTo" type="radio" value="move"><span><b>搬过去，删掉原目录</b><br><span class="muted">腾出 C 盘空间（推荐）</span></span></label>
          <label class="modeOpt"><input v-model="dlgModeTo" type="radio" value="copy"><span><b>只复制一份，原目录保留</b><br><span class="muted">不放心时选这个：会占双份空间</span></span></label>
        </div>
        <details class="hint" style="margin-top:10px;"><summary>迁移分四步，失败会停在哪一步？</summary><ol style="line-height:1.9;margin:6px 0 0;"><li><b>复制</b> —— 先复制到「目标.迁移中」临时目录，中途断电也不会被当成搬好了</li><li><b>校验</b> —— 打开目标里的库，核对 goals / nodes / sources / problems 等表行数跟原来一致</li><li><b>切指针</b> —— 写 data-location.json（放在程序目录，不会跟着数据挪走）</li><li><b>删原目录</b> —— 只在第 1~3 步全过、且原目录本来就是默认目录时才删</li></ol><p style="margin:6px 0 0;">任何一步不通过就不切指针，程序继续用原目录。切换完成后需要重启一次。</p></details>
        <div v-if="applyErr" class="storeResult bad">✗ 没搬成功<br>{{ applyErr }}<br><span class="muted">原数据没动，程序还在用原来的位置。可以修好路径再试，或点「取消」。</span></div>
        <div v-if="applyOk" class="storeResult ok">✓ {{ dlgMode === 'use' ? '已指向新目录' : (dlgModeTo === 'move' ? '数据已搬过去' : '已复制一份到新目录') }}<br>原位置：{{ loc.dir || '' }}<br>新位置：{{ applyOk.dir }}<span v-if="applyOk.skipped && applyOk.skipped.length"><br>有 {{ applyOk.skipped.length }} 个文件读不了，已跳过（数据库和你的数据不受影响）。</span></div>
        <div v-if="progressText" class="storeProg"><div class="storeProgHd"><span class="spinner"></span><b>{{ progressText }}</b><span class="spacer"></span><span>{{ progressPct }}%</span></div><div class="bar"><div class="barFill" :style="{ width: progressPct + '%' }"></div></div><div class="muted" style="font-size:11.5px;margin-top:4px;">{{ progressDetail }}</div></div>
        <div class="toolbarRow" style="margin-top:12px;flex-wrap:wrap;">
          <button v-if="!applyOk" class="btn primary" type="button" :disabled="applyBusy || picking || !dlgPath.trim()" @click="doApply">{{ applyBusy ? '进行中…' : (dlgMode === 'use' ? '指过去' : '开始迁移') }}</button>
          <button v-if="applyOk" class="btn primary" type="button" :disabled="restarting" @click="doRestart">{{ restarting ? '正在重启…' : '现在重启' }}</button>
          <button class="btn" type="button" @click="closeDlg">取消</button>
        </div>
        <p v-if="applyOk" class="hint" style="margin-top:8px;"><b>需要重启一次才会真正生效。</b></p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const loc = ref({});
const busy = ref(false);
const version = ref('—');
const legacyHref = '?ui=legacy#/settings';
function back() { location.hash = '#/settings'; }
function fmtBytes(n) { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'; if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'; return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'; }
async function load() { try { loc.value = await api('/api/data-location'); } catch (e) { loc.value = { error: e.message }; toast('读取数据位置失败：' + e.message); } try { const s = await api('/api/update/status'); version.value = s.localVersion ? ('v' + s.localVersion) : (s.currentShort || '—'); } catch (e) {} }
function showGuide() { try { if (typeof props.host.showGuide === 'function') { props.host.showGuide(0); return; } } catch (e) {} toast('请到主页点「重新查看使用引导」'); }
/* ---- 数据目录迁移 ---- */
const dlg = ref(false);
const dlgMode = ref('move');
const dlgModeTo = ref('move');
const dlgPath = ref('');
const checkState = ref({ kind: '', text: '', tip: '' });
const picking = ref(false);
const pickMsg = ref('');
const applyBusy = ref(false);
const applyErr = ref('');
const applyOk = ref(null);
const progressText = ref('');
const progressPct = ref(0);
const progressDetail = ref('');
const restarting = ref(false);
let checkTimer = null, pickTimer = null, progTimer = null;
function openMoveDlg(mode) {
  dlgMode.value = mode === 'use' ? 'use' : 'move';
  dlgModeTo.value = 'move';
  dlgPath.value = '';
  checkState.value = { kind: '', text: '', tip: '' };
  pickMsg.value = ''; applyErr.value = ''; applyOk.value = null;
  progressText.value = ''; progressPct.value = 0; progressDetail.value = '';
  dlg.value = true;
}
function closeDlg() {
  if (applyBusy.value) return;
  clearInterval(progTimer); clearInterval(pickTimer); clearTimeout(checkTimer); progTimer = pickTimer = null;
  dlg.value = false;
}
async function checkPath() {
  const dir = String(dlgPath.value || '').trim();
  if (!dir) { checkState.value = { kind: '', text: '', tip: '' }; return; }
  try {
    const r = await api('/api/data-location/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
    checkState.value = r.ok
      ? { kind: 'ok', text: '✓ 可以放这里', tip: '要腾出约 ' + fmtBytes(r.need) + ' 的空间' + (r.free != null ? '，那边还有 ' + fmtBytes(r.free) : '') }
      : { kind: 'bad', text: '✗ ' + r.error, tip: '' };
  } catch (e) { checkState.value = { kind: 'bad', text: '✗ ' + e.message, tip: '' }; }
}
function onPathInput() { clearTimeout(checkTimer); checkTimer = setTimeout(checkPath, 400); }
async function pickDir() {
  picking.value = true; pickMsg.value = '在弹出的窗口里选文件夹（可以顺手新建一个）…';
  try { await api('/api/data-location/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch (e) { pickMsg.value = '打不开：' + e.message; picking.value = false; return; }
  clearInterval(pickTimer);
  pickTimer = setInterval(async () => {
    try {
      const r = await api('/api/data-location/pick');
      if (!r.done) return;
      clearInterval(pickTimer); pickTimer = null; picking.value = false;
      if (r.canceled) { pickMsg.value = '已取消'; return; }
      dlgPath.value = r.chosen || ''; pickMsg.value = '已选好'; onPathInput();
    } catch (e) { clearInterval(pickTimer); pickTimer = null; picking.value = false; pickMsg.value = '失败：' + e.message; }
  }, 800);
}
const PHASES = { scan: '正在统计要搬多少…', copy: '正在复制文件…', verify: '正在校验（打开库核对行数）…', cleanup: '校验通过，正在删掉原目录…', done: '完成', error: '已停止' };
async function doApply() {
  const dir = String(dlgPath.value || '').trim();
  if (!dir) return toast('先选一个文件夹');
  applyBusy.value = true; applyErr.value = ''; applyOk.value = null;
  progressText.value = '正在准备…'; progressPct.value = 0; progressDetail.value = '';
  clearInterval(progTimer);
  progTimer = setInterval(async () => {
    try {
      const p = await api('/api/data-location/progress');
      progressText.value = PHASES[p.phase] || '处理中…';
      progressPct.value = p.phase === 'copy' ? Number(p.pct || 0) : (p.phase === 'done' ? 100 : 0);
      progressDetail.value = p.phase === 'copy' ? (fmtBytes(p.copied) + ' / ' + fmtBytes(p.total) + '　' + p.pct + '%　' + p.elapsed + ' 秒') : (p.elapsed ? p.elapsed + ' 秒' : '');
    } catch (e) {}
  }, 700);
  try {
    const payload = dlgMode.value === 'use' ? { use_existing: true, dir } : { dir, mode: dlgModeTo.value };
    const r = await api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    applyOk.value = r;
    progressText.value = '';
    await load();
  } catch (e) {
    applyErr.value = e.message;
    progressText.value = '';
  } finally { clearInterval(progTimer); progTimer = null; applyBusy.value = false; }
}
async function doRestart() {
  restarting.value = true;
  try { await api('/api/data-location/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch (e) { restarting.value = false; toast('重启失败，请手动重开：' + e.message); }
}
async function resetToDefault() {
  if (!window.confirm('把数据搬回程序目录下的 data/？\n\n会重新复制并校验，校验通过才切换。')) return;
  try { const r = await api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) }); toast('已切回默认目录，重启后生效'); await load(); }
  catch (e) { toast('搬回失败：' + e.message); }
}
onMounted(load);
</script>

<style scoped>
.page { max-width: 960px; }
.modalMask { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 90; padding: 20px; }
.modalBox { background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: min(680px, 96vw); max-height: 90vh; overflow: auto; padding: 18px; }
.modalHead { display: flex; align-items: center; margin-bottom: 10px; }
.efRow { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 8px; }
.efRow input { width: 100%; box-sizing: border-box; }
.storeCheck { margin-top: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); font-size: 12.5px; background: var(--soft); }
.storeCheck.ok { color: var(--ok, #2e7d32); border-color: var(--ok, #2e7d32); }
.storeCheck.bad { color: var(--danger); border-color: var(--danger); }
.modeOpt { display: flex; align-items: flex-start; gap: 7px; font-size: 12.5px; line-height: 1.6; padding: 8px; border: 1px solid var(--line); border-radius: 9px; cursor: pointer; flex: 1; min-width: 200px; }
.modeOpt input { margin-top: 3px; width: 15px; height: 15px; flex: none; }
.storeResult { margin-top: 10px; padding: 10px; border-radius: 9px; font-size: 12.5px; line-height: 1.8; }
.storeResult.ok { border: 1px solid var(--ok, #2e7d32); color: var(--ok, #2e7d32); }
.storeResult.bad { border: 1px solid var(--danger); color: var(--danger); }
.storeProg { margin-top: 10px; }
.storeProgHd { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin-bottom: 6px; }
.bar { height: 8px; border-radius: 4px; background: var(--soft); overflow: hidden; }
.barFill { height: 100%; background: var(--accent); border-radius: 4px; transition: width .2s; }
.pathLine { margin-top: 10px; font-size: 13px; word-break: break-all; }
.pathLine code { font-size: 12.5px; }
</style>