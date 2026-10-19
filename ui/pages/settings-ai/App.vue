<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">🤖 AI 连接</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="load">↻ 重新加载</button>
      <button class="btn small primary" type="button" :disabled="busy" @click="save">💾 保存全部</button>
    </div>
    <p class="hint" style="margin:-4px 0 14px;">{{ status.configured ? '当前已配置：' + (status.connName || '') + ' · ' + (status.model || '') : '还没有可用的 AI 连接。' }} <span v-if="status.hint" class="warnText">· {{ status.hint }}</span></p>

    <div v-for="(c, i) in conns" :key="c.id || i" class="secCard connCard">
      <div class="secHead"><label class="connEnable"><input v-model="c.enabled" type="checkbox"> <span>启用</span></label><span class="connKind">{{ c.kind === 'agent' ? 'Agent' : 'API' }} · {{ c.purpose === 'vision' ? '识图专用' : '对话' }}</span><div class="spacer"></div><span class="chip gray">{{ c.providerId || '自定义' }}</span><button class="btn tiny danger" type="button" :disabled="busy" @click="del(i)">删除</button></div>
      <div class="connGrid">
        <label class="ccWide">类型<select v-model="c.kind" class="sxi-sel"><option value="api">OpenAI 兼容 API</option><option value="agent">本机 Agent（opencode）</option></select></label>
        <label class="ccWide">服务商<select v-model="c.providerId" class="sxi-sel" @change="onProvider(c)"><option value="">自定义</option><option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
        <label class="ccWide">用途<select v-model="c.purpose" class="sxi-sel"><option value="chat">对话 / 规划 / 教程</option><option value="vision">识图专用</option></select></label>
        <label class="ccWide">连接名<input v-model="c.name" placeholder="留空按服务商自动命名"></label>
      </div>
      <template v-if="c.kind === 'agent'">
        <label class="connFull">Agent 参数<input v-model="c.agent" placeholder="默认 NoTools（用到时自动创建）"></label>
      </template>
      <template v-else>
        <label class="connFull">API 地址<input v-model="c.baseUrl" class="mono" placeholder="如 https://api.deepseek.com"></label>
        <div class="connGrid2">
          <label class="ccWide">API 密钥<input v-model="c.apiKey" type="password" :placeholder="c.hasKey ? '已保存（留空则不修改）' : 'sk-…'"></label>
          <label class="ccWide">超时（毫秒）<input v-model.number="c.timeoutMs" type="number" min="0" placeholder="0 = 跟全局"></label>
        </div>
        <label class="connFull">模型（逗号分隔）<input v-model="c.modelsText" placeholder="如 deepseek-flash, deepseek-v4-pro"></label>
        <div class="toolbarRow" style="margin-top:8px;flex-wrap:wrap;"><button class="btn small" type="button" :disabled="busy" @click="fetchModels(c)">🔄 取可用模型</button><button class="btn small" type="button" :disabled="busy" @click="test(c)">🧪 测试第一个模型</button><span class="hint">{{ c.msg || '' }}</span></div>
      </template>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>＋ 添加连接</span><div class="spacer"></div><button class="btn small primary" type="button" @click="add('api')">＋ API 连接</button><button class="btn small" type="button" @click="add('agent')" :disabled="!agents.length">＋ Agent 连接</button></div>
      <p class="hint" style="margin:8px 0 0;">API 连接 = 任意 OpenAI 兼容服务（DeepSeek / 通义 / Kimi / Ollama…）；Agent 连接 = 复用本机已登录的 opencode CLI。密钥只存本机，不会显示。</p>
    </div>

    <div class="secCard" style="margin-top:14px;"><div class="secHead"><span>🧭 快速提示</span></div><p class="hint" style="margin:8px 0 0;">1. 选服务商会自动填地址；2. 填密钥后点「取可用模型」；3. 勾选/保留要用的模型；4. 保存。保留旧密钥时密钥框留空即可。测试会真实发一次很小请求。</p></div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const conns = ref([]);
const providers = ref([]);
const agents = ref([]);
const status = ref({});
const busy = ref(false);
function back() { location.hash = '#/settings'; }
function convert(c) { return Object.assign({}, c, { modelsText: (c.models || []).join(', '), apiKey: '', msg: '' }); }
async function load() {
  try {
    const [cRes, pRes, aRes, st] = await Promise.all([api('/api/ai/connections'), api('/api/ai/providers').catch(() => ({ providers: [] })), api('/api/ai/agents').catch(() => ({ agents: [] })), api('/api/ai/status').catch(() => ({}))]);
    conns.value = (cRes.connections || []).map(convert); providers.value = pRes.providers || []; agents.value = aRes.agents || []; status.value = st || {};
  } catch (e) { toast('加载 AI 连接失败：' + e.message); }
}
function onProvider(c) { const p = providers.value.find(x => x.id === c.providerId); if (p && !String(c.baseUrl || '').trim()) c.baseUrl = p.baseUrl || ''; }
function add(kind) { conns.value.push({ id: '', name: '', provider: kind === 'agent' ? 'opencode' : 'openai', kind: kind, purpose: 'chat', providerId: kind === 'agent' ? 'opencode' : 'deepseek', baseUrl: '', apiKey: '', hasKey: false, modelsText: '', defaultModel: '', visionModel: '', agent: kind === 'agent' ? 'NoTools' : '', timeoutMs: 0, enabled: true, msg: '' }); }
function del(i) { if (!window.confirm('删除这条 AI 连接？保存后生效。')) return; conns.value.splice(i, 1); }
function payload() { return conns.value.map(c => { const out = { id: c.id, name: c.name, provider: c.kind === 'agent' ? 'opencode' : 'openai', kind: c.kind, purpose: c.purpose, providerId: c.providerId, baseUrl: c.baseUrl, models: String(c.modelsText || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean), defaultModel: c.defaultModel || '', visionModel: c.visionModel || '', agent: c.agent || '', timeoutMs: Number(c.timeoutMs) || 0, enabled: c.enabled !== false }; if (String(c.apiKey || '').trim()) out.apiKey = String(c.apiKey).trim(); return out; }); }
async function save() { if (busy.value) return; busy.value = true; try { const r = await api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: payload() }) }); conns.value = (r.connections || []).map(convert); busy.value = false; try { status.value = await api('/api/ai/status'); } catch (e) {} toast('已保存 AI 连接'); } catch (e) { toast('保存失败：' + e.message); busy.value = false; } }
async function fetchModels(c) { if (busy.value) return; busy.value = true; c.msg = '取模型中…'; try { const body = { baseUrl: String(c.baseUrl || '').trim(), apiKey: String(c.apiKey || '').trim(), connId: c.id || undefined, useVisKey: !String(c.apiKey || '').trim() }; const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (r.models && r.models.length) { c.modelsText = r.models.join(', '); c.msg = '取到 ' + r.models.length + ' 个模型'; } else c.msg = '没取到：' + (r.error || r.detail || '请先保存密钥再试'); } catch (e) { c.msg = e.message; } busy.value = false; }
async function test(c) { if (busy.value) return; busy.value = true; c.msg = '测试中…'; try { if (!c.id) { c.msg = '请先保存连接再测试'; busy.value = false; return; } const model = String(c.modelsText || '').split(/[,，]/)[0].trim(); const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: c.id, modelName: model }) }); c.msg = (r.ok ? '✅ ' : '❌ ') + (r.message || (r.ok ? '连接正常' : '失败')) + (r.sample ? ' · ' + String(r.sample).slice(0, 60) : ''); } catch (e) { c.msg = '测试失败：' + e.message; } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1120px; }
.connCard { margin-bottom: 12px; }
.connGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 10px; }
.connGrid2 { display: grid; grid-template-columns: 1fr 160px; gap: 10px; margin-top: 8px; }
.connFull { display: block; margin-top: 8px; font-size: 13px; }
.connFull input { width: 100%; box-sizing: border-box; margin-top: 4px; }
.connEnable { display: flex; align-items: center; gap: 5px; font-size: 13px; }
.connKind { margin-left: 8px; font-size: 12px; color: var(--muted); }
.warnText { color: var(--warn); }
.mono { font-family: ui-monospace, monospace; }
</style>
