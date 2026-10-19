<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">💾 数据备份</h2>
      <div class="spacer"></div>
      <button class="btn small primary" type="button" :disabled="busy" @click="createBackup">📌 立即备份</button>
      <a class="btn small" href="/api/export/json">⬇ 导出 JSON</a>
      <label class="btn small">⬆ 导入 JSON<input type="file" accept=".json,application/json" hidden @change="importJson"></label>
    </div>
    <p class="hint" style="margin:-4px 0 12px;">共 {{ items.length }} 份 · 占用 {{ fmtBytes(totalBytes) }} · 当前数据库 {{ fmtBytes(dbSize) }}。恢复会先把现在的数据另存一份再覆盖，确认后需重启应用。</p>

    <div class="secCard">
      <div class="secHead"><span>保留份数</span><div class="spacer"></div><span class="muted" style="font-size:12px;">超出后自动清理最旧的</span></div>
      <div class="toolbarRow" style="margin-top:8px;"><select class="sxi-sel" :value="keep" @change="setKeep($event.target.value)"><option v-for="n in keepOptions" :key="n" :value="n">{{ n }} 份</option></select><span class="muted" style="font-size:12px;">当前保留最近 {{ keep }} 份</span></div>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>备份历史</span><div class="spacer"></div><button v-if="selected.length" class="btn tiny danger" type="button" :disabled="busy" @click="delSelected">删除选中（{{ selected.length }}）</button></div>
      <div v-if="items.length" class="bkList">
        <div class="bkRow bkRowHead"><span class="bkCk"><input type="checkbox" :checked="allChecked" @change="toggleAll"></span><span>备份时间</span><span style="text-align:right;">大小</span><span></span><span style="text-align:right;">操作</span></div>
        <template v-for="(it, i) in visible" :key="it.name">
          <div class="bkRow" :class="{ hasSel: selected.includes(it.name) }">
            <span class="bkCk"><input type="checkbox" :checked="selected.includes(it.name)" @change="toggleSel(it.name)"></span>
            <span class="bkTime">{{ fmtTime(it.name) }}</span>
            <span class="bkSize">{{ fmtBytes(it.size) }}</span>
            <span><span v-if="i === 0" class="bkBadge">最新</span></span>
            <span class="bkActs"><button class="btn tiny" type="button" @click="toggleDiff(it)">变化</button><button class="btn tiny" type="button" :disabled="busy" @click="restore(it)">恢复</button><button class="btn tiny danger" type="button" :disabled="busy" @click="delOne(it)">删除</button></span>
          </div>
          <div v-if="diffFor === it.name" class="bkDiffRow">
            <div class="bkDiffTop"><b>{{ diffLoading ? '正在对比…' : diffTitle }}</b><span class="spacer"></span><button class="btn tiny" type="button" @click="diffFor = ''">收起</button></div>
            <div v-if="!diffLoading" class="bkDiffItems"><div v-for="(d, k) in diffItems" :key="k" class="bkDiffItem"><b>{{ d.label }}</b><span v-if="d.added" class="bkNum add">+{{ d.added }}</span><span v-if="d.removed" class="bkNum del">−{{ d.removed }}</span><span v-if="d.changed" class="bkNum mod">~{{ d.changed }} 处改动</span><span class="bkSamples">{{ (d.samples || []).map(s => (s.type === 'add' ? '＋' : s.type === 'del' ? '－' : '·') + s.text).join('　') }}</span></div><div v-if="!diffItems.length" class="bkSamples">两次备份内容一致，没有变化。</div></div>
          </div>
        </template>
      </div>
      <div v-else class="bkEmpty">还没有备份。改点东西就会自动备份，或点上面「立即备份」。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const items = ref([]);
const totalBytes = ref(0);
const dbSize = ref(0);
const keep = ref(20);
const busy = ref(false);
const selected = ref([]);
const diffFor = ref('');
const diffLoading = ref(false);
const diffTitle = ref('');
const diffItems = ref([]);
const keepOptions = computed(() => [...new Set([5, 10, 20, 30, 50, 100, Number(keep.value) || 20])].sort((a, b) => a - b));
const visible = computed(() => items.value.slice(0, 40));
const allChecked = computed(() => visible.value.length > 0 && visible.value.every(it => selected.value.includes(it.name)));
function back() { location.hash = '#/settings'; }
function fmtBytes(n) { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'; return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'; }
function fmtTime(name) { const m = String(name || '').match(/sierxing-(\d{8})-(\d{6})/); if (m) return m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8) + ' ' + m[2].slice(0, 2) + ':' + m[2].slice(2, 4) + ':' + m[2].slice(4, 6); return name; }
async function load() { try { const r = await api('/api/backup/list'); items.value = r.items || []; totalBytes.value = r.totalBytes || 0; dbSize.value = r.dbSize || 0; keep.value = Number(r.keep) || 20; } catch (e) { toast('读取备份失败：' + e.message); } }
async function createBackup() { if (busy.value) return; busy.value = true; try { const r = await api('/api/backup', { method: 'POST' }); toast('已备份，共 ' + r.count + ' 份'); await load(); } catch (e) { toast(e.message); } busy.value = false; }
async function setKeep(v) { try { const r = await api('/api/backup/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: Number(v) }) }); toast('改为保留最近 ' + r.keep + ' 份，现有 ' + r.count + ' 份'); await load(); } catch (e) { toast(e.message); } }
function toggleSel(name) { const i = selected.value.indexOf(name); if (i >= 0) selected.value = selected.value.filter(x => x !== name); else selected.value = selected.value.concat([name]); }
function toggleAll() { selected.value = allChecked.value ? [] : visible.value.map(it => it.name); }
async function toggleDiff(it) { if (diffFor.value === it.name) { diffFor.value = ''; return; } diffFor.value = it.name; diffLoading.value = true; diffTitle.value = ''; diffItems.value = []; try { const d = await api('/api/backup/diff?name=' + encodeURIComponent(it.name)); if (d.first) { diffTitle.value = '这是最早的一份备份'; } else { diffTitle.value = '相比上一份（' + fmtTime(d.prev) + '）的变化'; diffItems.value = d.items || []; } } catch (e) { diffTitle.value = '对比失败：' + e.message; } diffLoading.value = false; }
async function restore(it) { if (busy.value) return; if (!window.confirm('确定用 ' + fmtTime(it.name) + ' 这份备份覆盖当前数据吗？\n\n当前数据会先自动另存为一份备份，仍可恢复。\n恢复后需要重启应用。')) return; busy.value = true; try { await api('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: it.name }) }); toast('已恢复，请重启应用'); setTimeout(() => location.reload(), 1200); } catch (e) { toast('恢复失败：' + e.message); } busy.value = false; }
async function delOne(it) { if (busy.value) return; if (!window.confirm('删除备份 ' + fmtTime(it.name) + '？此操作不可撤销。')) return; busy.value = true; try { await api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: it.name }) }); selected.value = selected.value.filter(x => x !== it.name); await load(); toast('已删除'); } catch (e) { toast('删除失败：' + e.message); } busy.value = false; }
async function delSelected() { if (!selected.value.length || busy.value) return; if (!window.confirm('删除选中的 ' + selected.value.length + ' 份备份？此操作不可撤销。')) return; busy.value = true; let ok = 0, fail = 0; for (const nm of selected.value) { try { await api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) }); ok++; } catch (e) { fail++; } } selected.value = []; await load(); toast(fail ? ('已删除 ' + ok + ' 份，' + fail + ' 份失败') : ('已删除 ' + ok + ' 份')); busy.value = false; }
async function importJson(ev) { const f = (ev.target.files || [])[0]; ev.target.value = ''; if (!f) return; if (!window.confirm('导入会覆盖现有全部目标与路径（会先自动备份）。继续？')) return; try { const data = JSON.parse(await f.text()); const r = await api('/api/import/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); toast('已导入 ' + r.goals + ' 个目标'); setTimeout(() => { location.hash = '#/'; location.reload(); }, 600); } catch (e) { toast('导入失败：' + e.message); } }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1100px; }
.bkList { margin-top: 10px; }
.bkRow { display: grid; grid-template-columns: 34px 1fr 110px 70px 210px; gap: 8px; align-items: center; padding: 9px 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
.bkRowHead { color: var(--muted); font-size: 12px; }
.bkRow.hasSel { background: var(--soft); }
.bkActs { display: flex; gap: 5px; justify-content: flex-end; flex-wrap: wrap; }
.bkDiffRow { padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--soft); }
.bkDiffTop { display: flex; align-items: center; margin-bottom: 6px; }
.bkDiffItem { margin: 6px 0; font-size: 12.5px; }
.bkNum { margin-left: 6px; }
.bkNum.add { color: var(--ok); }
.bkNum.del { color: var(--danger); }
.bkNum.mod { color: var(--warn); }
.bkSamples { display: block; color: var(--muted); margin-top: 3px; word-break: break-all; }
</style>
