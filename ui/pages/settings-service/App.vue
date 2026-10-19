<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">🚀 服务与启动</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="load">↻ 刷新</button>
    </div>
    <p class="hint" style="margin:-4px 0 12px;">所有操作只写入当前用户目录，不需要管理员权限。端口 {{ st.port || '—' }}。</p>

    <div class="secCard">
      <div class="secHead"><span>访问地址</span><div class="spacer"></div><button class="btn tiny" type="button" :disabled="busy" @click="openBrowser">在浏览器打开</button></div>
      <div style="margin-top:8px;"><a :href="st.url || '#'" target="_blank" rel="noopener">{{ st.url || '未知' }}</a></div>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>桌面图标</span><div class="spacer"></div><span class="chip" :class="desktopOk ? 'ok' : 'gray'">{{ desktopOk ? '✅ 已创建' : '尚未创建' }}</span></div>
      <p class="hint" style="margin:8px 0;">双击启动并在浏览器打开（Windows 为桌面快捷方式，Linux/macOS 为桌面启动器）。</p>
      <button class="btn small primary" type="button" :disabled="busy" @click="createShortcuts">{{ desktopOk ? '重新创建' : '创建桌面图标与终端命令' }}</button>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>终端命令</span><div class="spacer"></div><span class="chip" :class="launcherOk ? 'ok' : 'gray'">{{ launcherOk ? 'sierxing 已可用' : '尚未创建' }}</span></div>
      <p class="hint" style="margin:8px 0;">安装后在终端输入 <code>sierxing</code> 即可启动（Linux/macOS 在 <code>~/.local/bin</code>）；Windows 会加入 PATH。</p>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>开机自启</span><div class="spacer"></div><span class="hint">{{ autoText }}</span></div>
      <label class="svcToggle"><input type="checkbox" :checked="autoEnabled" :disabled="busy" @change="toggleAuto($event.target.checked)"><span>{{ autoEnabled ? '已开启' : '未开启' }}</span></label>
      <p class="hint" style="margin:8px 0 0;">机制：{{ auto.mechanism || '按平台自动选择' }}<template v-if="auto.hint"> · {{ auto.hint }}</template></p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const st = ref({});
const busy = ref(false);
const auto = computed(() => st.value.autostart || {});
const autoEnabled = computed(() => !!auto.value.enabled);
const desktopOk = computed(() => !!(st.value.desktop && st.value.desktop.exists));
const launcherOk = computed(() => !!(st.value.launcher && st.value.launcher.exists));
const autoText = computed(() => autoEnabled.value ? ('已开启 · ' + (auto.value.mechanism || '')) : '未开启');
function back() { location.hash = '#/settings'; }
async function load() { try { st.value = await api('/api/service/status'); } catch (e) { toast('读取服务状态失败：' + e.message); } }
async function openBrowser() { try { await api('/api/service/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { toast(e.message); } }
async function createShortcuts() { if (busy.value) return; busy.value = true; try { const r = await api('/api/service/shortcuts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const notes = (r.notes || []).join('；'); toast((r.desktop ? '桌面图标已创建' : '未创建桌面图标') + (r.launcher ? '，终端命令 sierxing 可用' : '') + (notes ? ' · ' + notes : '')); await load(); } catch (e) { toast(e.message); } busy.value = false; }
async function toggleAuto(on) { if (busy.value) return; busy.value = true; try { const r = await api('/api/service/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }); toast(on ? ('已开启开机自启' + (r.hint ? '（' + r.hint + '）' : '')) : '已关闭开机自启'); await load(); } catch (e) { toast(e.message); } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 920px; }
.svcToggle { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 10px; }
.svcToggle input { width: 16px; height: 16px; }
</style>
