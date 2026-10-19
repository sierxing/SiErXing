<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">⬆ 版本与更新</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="check">{{ busy ? '检查中…' : '检查更新' }}</button>
      <button v-if="hasUpdate" class="btn small primary" type="button" :disabled="busy" @click="apply">立即更新</button>
    </div>

    <div class="secCard">
      <div class="secHead"><span>当前版本</span><div class="spacer"></div><span class="chip gray">{{ modeText }}</span></div>
      <div class="tvRow"><b style="font-size:18px;">{{ currentText }}</b><span class="muted">{{ currentSub }}</span></div>
      <div class="tvStatus" :class="statusClass">{{ statusText }}</div>
      <div v-if="checkedAt" class="hint" style="margin-top:6px;">上次检查：{{ fmt(checkedAt) }}</div>
    </div>

    <div v-if="u.commits && u.commits.length" class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>新提交（{{ u.commits.length }}）</span></div>
      <div class="tvList"><div v-for="(c, i) in u.commits" :key="i" class="tvItem"><code>{{ c.hash }}</code><span>{{ c.subject }}</span><i>{{ fmt(c.date) }}</i></div></div>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>说明</span></div>
      <p class="hint" style="margin:8px 0;line-height:1.85;">· 启动时会自动检查一次；也可以随时点右上「检查更新」。<br>· 更新只替换程序文件，本地数据（目标 / 组件设置 / 密钥）不受影响；更新后会自动重启应用。<br>· 单文件 exe 版本只下载程序文件（几百 KB），不用重下整个 exe。<br>· 当前安装方式不支持自动更新时（如解压版丢失 git 信息），可重新用 git clone 安装，数据不会丢。</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmt = props.host.fmtDate || (s => String(s || '').slice(0, 16).replace('T', ' '));
const u = ref({});
const busy = ref(false);
const hasUpdate = computed(() => { const x = u.value; return x.supported !== false && (x.mode === 'payload' ? !!(x.latestShort && x.latestShort !== x.localVersion) : Number(x.behind) > 0); });
const isPayload = computed(() => u.value.mode === 'payload');
const modeText = computed(() => isPayload.value ? '单文件 exe' : (u.value.mode === 'git' ? 'git 安装' : '未知安装方式'));
const currentText = computed(() => isPayload.value ? (u.value.localVersion ? 'v' + u.value.localVersion : '（未检测）') : (u.value.currentShort || '（未检测）'));
const currentSub = computed(() => isPayload.value ? '' : (u.value.currentDate ? fmt(u.value.currentDate) : ''));
const checkedAt = computed(() => u.value.checkedAt ? new Date(u.value.checkedAt).toISOString() : '');
const statusClass = computed(() => { const x = u.value; if (x.supported === false) return 'warn'; if (x.reason === 'fetch-failed') return 'danger'; return hasUpdate.value ? 'ok' : ''; });
const statusText = computed(() => { const x = u.value; if (x.supported === false) return '当前安装方式不支持自动更新（可重新用 git clone 安装，数据不会丢）'; if (x.reason === 'fetch-failed') return '检查失败：' + (x.error || '网络或权限问题'); if (hasUpdate.value) { if (isPayload.value) return '有新版本 v' + (x.latestShort || '') + ' · 只下载程序文件' + (x.exeRequired ? '（本次含启动器修复，功能照常更新，但之后请去发布页下载完整 exe 替换一次）' : '') + ' · ' + (x.latestSubject || ''); return '有 ' + x.behind + ' 个新提交 · 最新：' + (x.latestSubject || ''); } return '已是最新版本' + (x.dirty ? ' · 本地有 ' + x.dirty + ' 个改动文件（更新时会自动暂存）' : ''); });
function back() { location.hash = '#/settings'; }
async function load() { try { u.value = await api('/api/update/status'); } catch (e) { toast('读取更新状态失败：' + e.message); } }
async function check() { if (busy.value) return; busy.value = true; try { u.value = await api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const x = u.value; toast(x.supported === false ? '当前安装方式不支持自动更新' : (x.reason === 'fetch-failed' ? '检查失败：' + (x.error || '网络或权限问题') : (hasUpdate.value ? (isPayload.value ? '发现新版本 v' + x.latestShort : '发现 ' + x.behind + ' 个新提交') : '已是最新版本'))); } catch (e) { toast(e.message); } busy.value = false; }
async function apply() { if (busy.value) return; const x = u.value; if (x.exeRequired) { const go = window.confirm('新版本 v' + (x.latestShort || '') + ' 包含启动器修复，需要换整个 exe 文件。\n\n点“确定”：先下载新版 exe（发布页），再手动替换运行。\n点“取消”：只更新程序文件（新功能照样有），但更新后要手动关掉重开。'); if (go && x.releasesUrl) { try { window.open(x.releasesUrl, '_blank', 'noopener'); } catch (e) {} return; } if (go) return; }
  if (!window.confirm('更新到最新版本（' + (x.latestShort || '') + '）？\n更新完会自动重启应用，页面会自动刷新。\n你的数据都在本地，不会丢失。')) return; busy.value = true; toast('正在更新…如果页面断开，重启后刷新即可'); try { const r = await api('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!r.updated) { toast('已经是最新版本'); busy.value = false; return; } toast('已更新 ' + r.before + ' → ' + r.after + '，正在重启应用…'); try { await api('/api/update/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {} for (let i = 0; i < 60; i++) { await new Promise(r2 => setTimeout(r2, 1500)); try { const h = await fetch('/api/health', { cache: 'no-store' }); if (h.ok) { location.href = location.pathname + '?_=' + Date.now() + '#/settings/update'; return; } } catch (e) {} } toast('已更新，但自动重启没成功：请手动关闭后重新启动应用'); } catch (e) { toast('更新失败：' + e.message + ' · 可在项目目录手动执行 git pull'); } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 960px; }
.tvRow { display: flex; align-items: baseline; gap: 10px; margin-top: 10px; }
.tvStatus { margin-top: 10px; font-size: 13px; line-height: 1.7; }
.tvStatus.ok { color: var(--ok); }
.tvStatus.warn { color: var(--warn); }
.tvStatus.danger { color: var(--danger); }
.tvList { margin-top: 8px; }
.tvItem { display: flex; gap: 10px; align-items: baseline; padding: 7px 4px; border-bottom: 1px solid var(--line); font-size: 13px; }
.tvItem code { font-size: 11px; color: var(--muted); }
.tvItem span { flex: 1; }
.tvItem i { font-style: normal; color: var(--muted); font-size: 12px; }
</style>
