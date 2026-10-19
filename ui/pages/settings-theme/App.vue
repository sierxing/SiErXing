<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="backSettings">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">🎨 外观主题</h2>
      <div class="spacer"></div>
      <a class="btn small" href="#/settings" title="AI 配置、数据管理、同步等仍在旧版设置页">⚙ 完整设置</a>
    </div>
    <div class="secCard">
      <div class="secHead"><span>🌗 显示模式</span><div class="spacer"></div><span class="muted" style="font-size:12px;">只影响这台设备</span></div>
      <div class="ppCats" style="margin:10px 0 4px;">
        <button type="button" class="ppCat" :class="{ active: mode === 'auto' }" @click="setMode('auto')">🌓 跟随系统</button>
        <button type="button" class="ppCat" :class="{ active: mode === 'light' }" @click="setMode('light')">☀️ 亮色</button>
        <button type="button" class="ppCat" :class="{ active: mode === 'dark' }" @click="setMode('dark')">🌙 暗色</button>
      </div>
      <p class="hint">当前实际显示：{{ eff === 'dark' ? '暗色' : '亮色' }}。只改颜色，不改字体和布局。</p>
    </div>
    <div class="secCard">
      <div class="secHead"><span>🎨 主题皮肤</span><div class="spacer"></div><span class="muted" style="font-size:12px;">亮色 / 暗色各选一个 · 立即生效</span></div>
      <p class="hint" style="margin:8px 0 12px;">白天挑一个柔和的浅色主题，晚上挑一个不那么黑的深色主题。主题是显示偏好，只存本机、不做多端同步。</p>
      <div class="ccRow">
        <label class="ccWide">☀️ 亮色模式用<select class="sxi-sel" :value="lightId" @change="pick('light', $event.target.value)"><option value="">默认（内置亮色）</option><option v-for="c in themeComps" :key="c.id" :value="c.id">{{ c.icon || '🎨' }} {{ c.name }}{{ c.mode === 'dark' ? '（深色）' : (c.mode === 'light' ? '（浅色）' : '') }}</option></select></label>
        <label class="ccWide">🌙 暗色模式用<select class="sxi-sel" :value="darkId" @change="pick('dark', $event.target.value)"><option value="">默认（内置暗色）</option><option v-for="c in themeComps" :key="c.id" :value="c.id">{{ c.icon || '🎨' }} {{ c.name }}{{ c.mode === 'dark' ? '（深色）' : (c.mode === 'light' ? '（浅色）' : '') }}</option></select></label>
      </div>
      <div class="hint" style="margin-top:8px;">当前 → 亮色：<b>{{ nameOf(lightId) }}</b>　·　暗色：<b>{{ nameOf(darkId) }}</b></div>
    </div>
    <div class="secCard">
      <div class="secHead"><span>🧩 主题皮肤来自组件</span><div class="spacer"></div><a class="btn tiny" href="#/components">管理组件 →</a></div>
      <p class="hint" style="margin:8px 0 0;">主题皮肤是普通组件（只声明元数据、CSS 在前端）。在「组件管理」里可查看 / 导入 / 卸载；开关对主题不生效，要在这里按亮暗模式分别选。</p>
      <div v-if="themeComps.length" class="themeChips"><span v-for="c in themeComps" :key="c.id" class="chip gray">{{ c.icon || '🎨' }} {{ c.name }}{{ c.mode ? ' · ' + (c.mode === 'dark' ? '深色' : '浅色') : '' }}</span></div>
      <div v-else class="muted" style="font-size:12.5px;padding:6px 2px;">还没有可用的主题皮肤组件。</div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const themeComps = ref([]);
const mode = ref('auto');
const eff = ref('light');
const lightId = ref('');
const darkId = ref('');
function refresh() { try { mode.value = localStorage.getItem('sierxing-theme') || 'auto'; eff.value = (props.host.currentThemeEff ? props.host.currentThemeEff() : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); lightId.value = props.host.themeFor ? props.host.themeFor('light') : ''; darkId.value = props.host.themeFor ? props.host.themeFor('dark') : ''; } catch (e) {} }
function nameOf(id) { if (!id) return '默认配色'; const c = themeComps.value.find(x => x.id === id); return c ? c.name : id; }
function pick(m, id) { try { props.host.setThemeFor ? props.host.setThemeFor(m, id) : null; } catch (e) { toast(e.message); } refresh(); toast('已设置' + (m === 'dark' ? '暗色' : '亮色') + '主题' + (eff.value === m ? '（已应用）' : '（切到该模式时生效）')); }
function setMode(m) { try { if (props.host.setThemeMode) props.host.setThemeMode(m); else localStorage.setItem('sierxing-theme', m); } catch (e) {} refresh(); toast(m === 'auto' ? '已跟随系统' : ('已切到' + (m === 'dark' ? '暗色' : '亮色') + '模式')); }
function backSettings() { location.hash = '#/settings'; }
onMounted(async () => { refresh(); try { const r = await api('/api/components'); themeComps.value = (r.components || []).filter(c => c.kind === 'theme' || c.scope === 'theme'); } catch (e) {} refresh(); });
</script>

<style scoped>
.page { max-width: 1080px; }
.themeChips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
</style>
