<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">🧲 检索增强（RAG）</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="refreshStatus">↻ 刷新状态</button>
    </div>
    <p class="hint" style="margin:-4px 0 12px;">资料一多，把整包资料塞给模型既贵又抓不住重点。开启后：<b>规划、拆任务、对话</b>会先从资料库里检索与当前问题最相关的片段再作答。不配向量模型也能用（关键词检索）；配上向量模型即升级为语义检索。</p>

    <div class="secCard">
      <div class="secHead"><span>开关</span><div class="spacer"></div><span class="chip" :class="form.rag_enabled !== false ? 'ok' : 'gray'">{{ form.rag_enabled !== false ? '已启用' : '已关闭' }}</span></div>
      <label class="ragCheck"><input v-model="form.rag_enabled" type="checkbox"><span>启用检索增强（推荐；关闭则回到「前 N 条资料整段注入」）</span></label>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>向量模型（可选）</span><div class="spacer"></div><span class="chip gray">{{ form.emb_has_key ? '密钥已保存' : '未配置密钥' }}</span></div>
      <p class="hint" style="margin:8px 0;">不是所有服务商都提供向量模型（如 DeepSeek 暂无）。本机 Ollama 免费且数据不出本机。</p>
      <div class="ragGrid">
        <label class="ragFull">API 地址<input v-model="form.emb_base_url" class="mono" placeholder="本地 Ollama：http://localhost:11434/v1"></label>
        <label class="ragFull">API 密钥<input v-model="form.emb_key" type="password" :placeholder="form.emb_has_key ? '已保存（留空则不修改）' : 'sk-…'"></label>
        <label class="ragFull">向量模型名<input v-model="form.emb_model" placeholder="如 bge-m3:latest / BAAI/bge-m3 / text-embedding-v3"></label>
      </div>
      <div class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;"><button class="btn small" type="button" :disabled="busy" @click="ollama">🦙 本地 Ollama</button><button class="btn small" type="button" :disabled="busy" @click="fetchModels">🔄 获取可用模型</button><button class="btn small" type="button" :disabled="busy" @click="testEmb">测试向量</button><button class="btn small primary" type="button" :disabled="busy" @click="save">💾 保存配置</button><span class="hint">{{ msg }}</span></div>
      <div v-if="models.length" class="ragModels"><button v-for="m in models" :key="m" type="button" class="btn tiny" :class="{ primary: form.emb_model === m }" @click="form.emb_model = m">{{ m }}</button></div>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>索引状态与检索预览</span><div class="spacer"></div><span class="chip gray">{{ statusText }}</span></div>
      <div class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;"><select v-model.number="goalId" class="sxi-sel"><option :value="0">（全部目标）</option><option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option></select><button class="btn small" type="button" :disabled="busy || !goalId" @click="buildIndex">🧲 建立本目标索引</button><span class="hint">{{ statusDetail }}</span></div>
      <div class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;"><input v-model="q" style="flex:1;min-width:240px;" placeholder="检索预览：输入一个具体问题，看会命中资料库里的哪些片段" @keydown.enter="search"><button class="btn small" type="button" :disabled="busy || !goalId || !q.trim()" @click="search">检索</button></div>
      <div v-if="searchMsg" class="hint" style="margin-top:8px;">{{ searchMsg }}</div>
      <div v-if="hits.length" style="margin-top:8px;"><div v-for="(h, i) in hits" :key="i" class="ragHit"><div class="ragHitMeta">{{ Number(h.quality) === 1 ? '★' : '' }}[{{ h.site }}｜{{ h.kind }}] {{ h.title }} · 相关度 {{ h.score }}</div><div class="ragHitText">{{ h.text }}</div></div></div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const form = reactive({ rag_enabled: true, emb_base_url: '', emb_key: '', emb_has_key: false, emb_model: '' });
const goals = ref([]);
const goalId = ref(0);
const st = ref({});
const msg = ref('');
const models = ref([]);
const q = ref('');
const hits = ref([]);
const searchMsg = ref('');
const busy = ref(false);
const statusText = ref('');
const statusDetail = ref('');
function back() { location.hash = '#/settings'; }
function applySettings(s) { form.rag_enabled = s.rag_enabled !== false; form.emb_base_url = s.emb_base_url || ''; form.emb_has_key = !!s.emb_has_key; form.emb_model = s.emb_model || ''; form.emb_key = ''; }
async function load() { try { const [s, g] = await Promise.all([api('/api/settings'), api('/api/goals').catch(() => ({ goals: [] }))]); applySettings(s || {}); goals.value = g.goals || []; if (!goalId.value && goals.value.length) goalId.value = goals.value[0].id; await refreshStatus(); } catch (e) { toast('加载失败：' + e.message); } }
async function refreshStatus() { try { st.value = await api('/api/rag/status' + (goalId.value ? '?goalId=' + goalId.value : '')); statusText.value = '资料 ' + (st.value.sources || 0) + ' 条 · 分块 ' + (st.value.chunks || 0); statusDetail.value = '已向量化 ' + (st.value.embedded || 0) + (st.value.pending ? ' · 待处理 ' + st.value.pending : '') + '　·　' + (st.value.embConfigured ? ('向量模型 ' + (st.value.embModel || '')) : '未配置向量模型（当前按关键词检索）'); } catch (e) { statusText.value = '状态读取失败'; statusDetail.value = e.message; } }
async function save() { if (busy.value) return; busy.value = true; msg.value = '保存中…'; try { const body = { rag_enabled: !!form.rag_enabled, emb_base_url: form.emb_base_url, emb_model: form.emb_model }; if (String(form.emb_key || '').trim()) body.emb_api_key = String(form.emb_key).trim(); await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); form.emb_key = ''; form.emb_has_key = form.emb_has_key || !!body.emb_api_key; msg.value = '已保存配置'; toast('检索增强配置已保存'); await refreshStatus(); } catch (e) { msg.value = '保存失败：' + e.message; toast(e.message); } busy.value = false; }
async function fetchModels() { if (busy.value) return; if (!form.emb_base_url) return toast('先填 API 地址'); busy.value = true; msg.value = '获取模型中…'; try { const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: form.emb_base_url, apiKey: form.emb_key, useEmbKey: !form.emb_key }) }); models.value = r.models || []; msg.value = models.value.length ? ('取到 ' + models.value.length + ' 个模型，点一下填入') : ('没取到：' + (r.error || '接口未返回')); } catch (e) { msg.value = '取列表失败：' + e.message; } busy.value = false; }
async function ollama() { form.emb_base_url = 'http://localhost:11434/v1'; await fetchModels(); }
async function testEmb() { if (busy.value) return; if (!form.emb_base_url || !form.emb_model) return toast('先填地址和向量模型名'); busy.value = true; msg.value = '正在真实调用向量接口…'; try { const r = await api('/api/ai/emb-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: form.emb_base_url, model: form.emb_model, apiKey: form.emb_key }) }); msg.value = r.ok ? ('✅ 向量接口正常 · ' + r.model + ' · 维度 ' + r.dim) : ('❌ 不可用：' + (r.message || '')); if (r.ok && form.emb_key) { form.emb_has_key = true; form.emb_key = ''; } } catch (e) { msg.value = '❌ 测试失败：' + e.message; } busy.value = false; }
async function buildIndex() { if (!goalId.value || busy.value) return; busy.value = true; try { const r = await api('/api/goals/' + goalId.value + '/rag/build', { method: 'POST' }); toast(r.already ? '索引任务已在运行' : '已开始建立索引（任务中心可看进度）'); await refreshStatus(); } catch (e) { toast('启动失败：' + e.message); } busy.value = false; }
async function search() { if (!goalId.value || !q.value.trim() || busy.value) return; busy.value = true; searchMsg.value = '检索中…'; hits.value = []; try { const r = await api('/api/goals/' + goalId.value + '/rag/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q.value.trim() }) }); hits.value = r.hits || []; searchMsg.value = hits.value.length ? ('命中 ' + hits.value.length + ' 条') : '没有命中（可能资料还没入库，或换种说法再试）。'; } catch (e) { searchMsg.value = '检索失败：' + e.message; } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1100px; }
.ragCheck { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 10px; }
.ragGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
.ragFull { display: flex; flex-direction: column; font-size: 13px; gap: 4px; }
.ragFull input { width: 100%; box-sizing: border-box; }
.ragModels { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.ragHit { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
.ragHitMeta { font-size: 12px; color: var(--muted); }
.ragHitText { font-size: 12.5px; margin-top: 4px; }
.mono { font-family: ui-monospace, monospace; }
</style>
