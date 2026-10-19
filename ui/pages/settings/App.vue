<template>
  <div class="page settingsPage">
    <div class="pageHead">
      <button class="back" type="button" @click="home">← 返回</button>
      <h2 class="title" style="margin-left:10px;">⚙ 设置</h2>
      
      <div class="spacer"></div>
    </div>
    <div class="setTabs" role="tablist">
      <a class="setTab" href="#/settings/ai">🔌 AI 接入方式</a>
      <a class="setTab" href="#/settings/rag">🔍 检索增强</a>
      <a class="setTab" href="#/settings/theme">🎨 外观主题</a>
      <a class="setTab" href="#/settings/sync">🔄 多端同步</a>
      <a class="setTab" href="#/settings/service">🖥 服务与启动</a>
      <a class="setTab" href="#/settings/update">⬆ 版本与更新</a>
      <a class="setTab" href="#/settings/data">💾 数据备份</a>
      <a class="setTab" href="#/settings/system">📁 数据存储路径</a>
    </div>

    <div class="secCard">
      <div class="secHead"><span>🤖 AI 连接</span><div class="spacer"></div><span class="chip" :class="ai.configured ? 'ok' : 'warn'">{{ ai.configured ? '已配置' : '未配置' }}</span></div>
      <div v-if="ai.configured" class="ovGrid">
        <div class="ovItem"><span class="ovLabel">当前连接</span><b>{{ ai.connName || '—' }}</b><span class="ovSub">{{ ai.baseUrl || '' }}</span></div>
        <div class="ovItem"><span class="ovLabel">模型</span><b>{{ ai.model || '—' }}</b><span class="ovSub">识图：{{ ai.visionModel || '—' }}</span></div>
        <div class="ovItem"><span class="ovLabel">可用</span><b>{{ ai.connCount || 0 }} 条连接 · {{ ai.modelCount || 0 }} 个模型</b><span class="ovSub">{{ ai.provider === 'opencode' ? 'opencode CLI' : 'OpenAI 兼容接口' }}</span></div>
      </div>
      <div v-else class="muted" style="padding:8px 2px;">还没有可用的 AI 连接。配置后问卷、规划、教程、对话才能工作。</div>
      <div class="toolbarRow" style="margin-top:10px;"><a class="btn small primary" href="#/settings/ai">配置 AI 连接 / 模型 →</a></div>
    </div>

    <div class="secCard">
      <div class="secHead"><span>🎨 外观</span><div class="spacer"></div><a class="btn tiny" href="#/settings/theme">打开外观主题 →</a></div>
      <div class="ovGrid"><div class="ovItem"><span class="ovLabel">显示模式</span><b>{{ mode === 'auto' ? '跟随系统' : (mode === 'dark' ? '暗色' : '亮色') }}</b><span class="ovSub">当前实际：{{ eff === 'dark' ? '暗色' : '亮色' }}</span></div><div class="ovItem"><span class="ovLabel">主题皮肤</span><b>亮色：{{ nameOf(lightId) }}</b><span class="ovSub">暗色：{{ nameOf(darkId) }}</span></div></div>
    </div>

    <div class="secCard">
      <div class="secHead"><span>💾 数据备份</span><div class="spacer"></div><span class="chip gray">{{ backups.length }} 份</span></div>
      <div v-if="backups.length" class="ovGrid"><div class="ovItem"><span class="ovLabel">最近备份</span><b>{{ fmtDate(backups[0].time) }}</b><span class="ovSub">{{ backups[0].name }}</span></div><div class="ovItem"><span class="ovLabel">占用</span><b>{{ (Number(backups[0].size || 0) / 1024 / 1024).toFixed(1) }} MB</b><span class="ovSub">自动备份在 data/backups/</span></div></div>
      <div v-else class="muted" style="padding:8px 2px;">还没有备份。</div>
      <div class="toolbarRow" style="margin-top:10px;"><a class="btn small primary" href="#/settings/data">备份 / 恢复 / 对比 / 导入导出 →</a></div>
    </div>

    <div class="secCard">
      <div class="secHead"><span>🔄 多端同步</span><div class="spacer"></div><span class="chip" :class="sync.enabled ? 'ok' : 'gray'">{{ sync.enabled ? '已启用' : '未启用' }}</span></div>
      <div v-if="sync.enabled" class="ovGrid"><div class="ovItem"><span class="ovLabel">仓库</span><b style="font-size:12.5px;word-break:break-all;">{{ sync.repo || '—' }}</b><span class="ovSub">分支 {{ sync.branch || 'main' }} · 自动上传 {{ sync.auto_push ? '开' : '关' }} · 自动拉取 {{ sync.auto_pull ? '开' : '关' }}</span></div><div class="ovItem"><span class="ovLabel">令牌</span><b>{{ sync.token_set ? '已保存' : '未保存' }}</b><span class="ovSub">同步令牌只存本机</span></div></div>
      <div v-else class="muted" style="padding:8px 2px;">未启用同步。想多台设备共用数据，可在旧版设置里填自己的 Git 仓库。</div>
      <div class="toolbarRow" style="margin-top:10px;"><a class="btn small primary" href="#/settings/sync">配置同步 / 上传拉取 →</a></div>
    </div>

    <div class="secCard">
      <div class="secHead"><span>🧩 其他入口</span></div>
      <div class="toolbarRow" style="margin-top:8px;flex-wrap:wrap;"><a class="btn small" href="#/settings/system">系统信息（存储/帮助/关于）</a><a class="btn small" href="#/settings/update">版本与更新</a><a class="btn small" href="#/settings/service">服务与启动</a><a class="btn small" href="#/settings/rag">检索增强</a><a class="btn small" href="#/components">组件管理</a><a class="btn small" href="#/aitasks">AI 任务中心</a><a class="btn small" href="#/library">资源库</a><a class="btn small" href="#/studystats">学习统计</a><a class="btn small" href="#/settings/theme">外观主题</a></div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 16).replace('T', ' '));
const ai = ref({});
const backups = ref([]);
const sync = ref({});
const mode = ref('auto');
const eff = ref('light');
const lightId = ref('');
const darkId = ref('');
const themeComps = ref([]);
function nameOf(id) { if (!id) return '默认配色'; const c = themeComps.value.find(x => x.id === id); return c ? c.name : id; }
function refreshTheme() { try { mode.value = localStorage.getItem('sierxing-theme') || 'auto'; eff.value = props.host.currentThemeEff ? props.host.currentThemeEff() : 'light'; lightId.value = props.host.themeFor ? props.host.themeFor('light') : ''; darkId.value = props.host.themeFor ? props.host.themeFor('dark') : ''; } catch (e) {} }
function home() { location.hash = '#/'; }
onMounted(async () => {
  refreshTheme();
  try { const [a, b, s, c] = await Promise.all([api('/api/ai/status').catch(() => ({})), api('/api/backup/list').catch(() => ({ items: [] })), api('/api/settings').catch(() => ({})), api('/api/components').catch(() => ({ components: [] }))]); ai.value = a || {}; backups.value = (b.items || []); sync.value = (s.sync || {}); themeComps.value = (c.components || []).filter(x => x.kind === 'theme' || x.scope === 'theme'); refreshTheme(); } catch (e) { toast(e.message); }
});
</script>

<style scoped>
.page { max-width: 1100px; }
.ovGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-top: 10px; }
.ovItem { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.ovLabel { font-size: 12px; color: var(--muted); }
.ovSub { font-size: 12px; color: var(--muted); }
</style>