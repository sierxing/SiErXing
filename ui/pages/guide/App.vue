<template>
  <div class="page">
    <div class="gdHead">
      <button class="back" type="button" @click="goHome">← 返回首页</button>
      <span class="gdTitle">📖 使用引导</span>
      <span class="chip gray">{{ step + 1 }} / {{ steps.length }}</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" @click="finish('跳过，不再显示')">跳过</button>
    </div>

    <div class="gdDots"><button v-for="(s, i) in steps" :key="i" type="button" class="gdDot" :class="{ on: i === step }" :title="s.title" @click="go(i)"></button></div>

    <div class="gdCard">
      <div class="gdHero"><span class="gdIcon">{{ cur.icon }}</span><div><div class="gdStepTitle">{{ cur.title }}</div><div class="gdStepSub">{{ step + 1 }} / {{ steps.length }}</div></div></div>
      <div class="gdBody">
        <p v-for="(p, i) in cur.paras" :key="'p' + i" class="gdP" v-html="p"></p>
        <ul v-if="cur.bullets" class="gdUl"><li v-for="(b, i) in cur.bullets" :key="'b' + i" v-html="b"></li></ul>
        <ol v-if="cur.ordered" class="gdOl"><li v-for="(b, i) in cur.ordered" :key="'o' + i" v-html="b"></li></ol>
        <div v-if="cur.cards" class="gdGrid"><div v-for="(c, i) in cur.cards" :key="'c' + i" class="gdCardIn"><b v-html="c.t"></b><span v-html="c.d"></span></div></div>

        <div v-if="cur.key === 'ai'" class="gdBox"><div class="gdBoxTitle">当前 AI 连接</div><div v-if="ai.configured"><b>{{ ai.connName }}</b> · {{ ai.model }}<div class="gdMuted">{{ ai.baseUrl || '' }}</div></div><div v-else class="gdWarn">还没有可用的 AI 连接</div><a class="btn small primary" href="#/settings/ai">去配置 AI 连接 →</a></div>

        <div v-if="cur.key === 'comp'" class="gdBox"><div class="gdBoxTitle">基础功能组件</div><div v-if="components.length" class="gdComps"><span v-for="c in components.slice(0, 10)" :key="c.id" class="chip" :class="c.enabled ? 'ok' : 'gray'">{{ c.icon || '🧩' }} {{ c.name }}</span><span v-if="components.length > 10" class="chip gray">…共 {{ components.length }} 个</span></div><div v-else class="gdMuted">加载中…</div><a class="btn small" href="#/components">打开组件管理 →</a></div>

        <div v-if="cur.key === 'sync'" class="gdBox"><div class="gdBoxTitle">多端同步</div><div v-if="sync.enabled">已启用 · {{ sync.repo || '' }}<div class="gdMuted">自动上传 {{ sync.auto_push ? '开' : '关' }} · 启动时拉取 {{ sync.auto_pull ? '开' : '关' }}</div></div><div v-else class="gdMuted">未启用（可选）</div><a class="btn small" href="#/settings/sync">打开多端同步 →</a></div>

        <div v-if="cur.tip" class="gdTip" v-html="cur.tip"></div>
      </div>
    </div>

    <div class="gdFoot">
      <button class="btn" type="button" :disabled="step === 0" @click="go(step - 1)">← 上一步</button>
      <div class="spacer"></div>
      <button v-if="step < steps.length - 1" class="btn primary" type="button" @click="go(step + 1)">下一步 →</button>
      <button v-else class="btn primary" type="button" @click="finish('已完成引导')">开始使用 →</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const steps = [
  { icon: '👋', title: '欢迎使用「思而行」', paras: ['思而行是一个<b>目标规划助手</b>：说清目标与现状，它先和你反复确认，再拆成一条能执行的路径，且<b>随时可以改</b>。'], bullets: ['🗣 先确认再规划：问卷、深挖、约束，确认后才出骨架', '🧩 一切皆组件：功能可开关、界面可换肤、可导入导出分享', '🔒 本地运行：数据只保存在你自己的电脑上'] },
  { key: 'ai', icon: '🔌', title: '接入模型 / Agent（最重要）', paras: ['问卷、规划、教程、对话都由 AI 完成，<b>先接一个模型</b>。'], bullets: ['选服务商 → 地址自动填好 → 填密钥 → 获取并测试', '可加多条连接；对话时在 💬 的模型下拉里选具体用哪个', '没有密钥？装 Ollama 选「本地 Ollama」预设，离线免费', '密钥只存本机，不会显示在页面上'] },
  { key: 'comp', icon: '🧩', title: '组件是什么（最重要）', paras: ['每个功能、甚至<b>界面样式</b>都是组件，可开关、可换肤、可分享：'], cards: [{ t: '🧭 核心', d: '路线图与规划（不可关闭）' }, { t: '🎨 主题', d: '碳黑、宣纸等皮肤，本质是覆盖设计变量的 CSS 组件' }, { t: '🧩 扩展', d: '每日刷题、图片资料…可按目标启用，可导出给别人' }, { t: '📦 导入分享', d: '组件页可导出 *.component.json 发给别人，也能一次导入多个' }] },
  { icon: '🧭', title: '一条目标的完整流程', paras: ['每一步都能停下来改：提意见、深挖追问、随时调整。'], ordered: ['<b>新建目标</b>：写清目标与现状，可粘贴参考资料（JD / 大纲 / 笔记），也可上传图片，勾选需要的组件。', '<b>回答问卷</b>：不确定的点 <b>🔍 进一步探讨</b> 让 AI 追问，也可自己补充信息。', '<b>加约束</b>：硬性要求写进 <b>⛓ 规划约束</b>（如“只能周末学，每周 ≤6 小时”）。', '<b>确认骨架 → 细化任务</b>：先给阶段+小目标（可提意见重排），确认后再拆任务（每阶段 ≤10 个）。', '<b>执行与打磨</b>：右键节点可 <b>✨ 深度拆分</b> 或 <b>📘 生成学习教程</b>；点 <b>💬</b> 让 AI 直接改路线图；改动都有 <b>📜 版本对比</b>。'] },
  { key: 'sync', icon: '🔄', title: '多端同步（可选，但很实用）', paras: ['想让家里/公司两台电脑的数据自动同步？把<b>你自己的 Git 仓库</b>填进来就行（建议用私有仓库）：'], bullets: ['改动后自动上传 · 打开时自动拉取', '只同步数据快照（目标/任务/来源/教程/作答记录…）', '<b>AI 密钥、同步令牌等敏感信息不会同步</b>，同步令牌只保存在本机', '两边都有新改动时不会直接覆盖，会停下来让你二选一'], tip: '也可稍后在「设置 → 多端同步」里修改或关闭。' },
  { icon: '⌨️', title: '界面导航与数据', paras: [], cards: [{ t: '左侧栏', d: '顶部品牌图标（回目标列表）· 🏠 目标 / 🗺 路线图 / 组件入口 / ⚙ 设置 / 🧩 组件 · 底部 🌙 昼夜切换' }, { t: '右侧 💬 对话', d: '自然语言改路线图；宽度与输入框高度可拖拽调节，支持多会话' }, { t: '数据与备份', d: '设置页可备份 / 导出 JSON / 导入；每次改动自动备份到 data/backups/' }, { t: '桌面图标 · 终端命令 · 开机自启', d: '设置页「服务与启动」可一键创建桌面图标与终端命令 sierxing，并随时开关开机自启' }, { t: '随时回看本引导', d: '首页「📖 使用引导」或设置「系统信息 → 帮助」' }], tip: '准备好了吗？先接入模型（若还没配），然后新建你的第一个目标吧。' }
];
const step = ref(0);
const ai = ref({});
const components = ref([]);
const sync = ref({});
const cur = computed(() => steps[step.value] || steps[0]);
function clamp(n) { return Math.max(0, Math.min(steps.length - 1, Number(n) || 0)); }
function go(i) { const n = clamp(i); if (n === step.value) return; location.hash = '#/guide/' + (n + 1); }
function goHome() { location.hash = '#/'; }
function finish(msg) { try { localStorage.setItem('sierxing-guide-done', '1'); } catch (e) {} toast(msg); location.hash = '#/'; }
function syncNav() { const m = String(location.hash || '').match(/^#\/guide\/(\d+)/); if (m) step.value = clamp(Number(m[1]) - 1); }
watch(step, (n) => { if (!String(location.hash).startsWith('#/guide/')) return; const want = '#/guide/' + (n + 1); if (location.hash !== want) location.hash = want; });
async function load() { try { const [a, c, s] = await Promise.all([api('/api/ai/status').catch(() => ({})), api('/api/components').catch(() => ({ components: [] })), api('/api/settings').catch(() => ({}))]); ai.value = a || {}; components.value = c.components || []; sync.value = (s.sync || {}); } catch (e) {} }
onMounted(() => { syncNav(); load(); window.addEventListener('hashchange', syncNav); });
</script>

<style scoped>
.page { max-width: 920px; margin: 0 auto; }
.gdHead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.gdTitle { font-size: 20px; font-weight: 700; }
.gdDots { display: flex; gap: 7px; margin: 4px 0 14px; }
.gdDot { width: 26px; height: 6px; border-radius: 3px; border: 0; background: var(--soft); cursor: pointer; padding: 0; }
.gdDot.on { background: var(--accent); }
.gdCard { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--card); }
.gdHero { display: flex; align-items: center; gap: 14px; padding: 18px 20px; background: linear-gradient(135deg, var(--soft), transparent); border-bottom: 1px solid var(--line); }
.gdIcon { font-size: 36px; }
.gdStepTitle { font-size: 19px; font-weight: 700; }
.gdStepSub { font-size: 12px; color: var(--muted); margin-top: 3px; }
.gdBody { padding: 18px 22px 22px; }
.gdP { font-size: 14px; line-height: 1.9; margin: 0 0 10px; }
.gdUl, .gdOl { font-size: 13.5px; line-height: 1.9; margin: 0 0 10px; padding-left: 22px; }
.gdGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 10px 0; }
.gdCardIn { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.gdCardIn b { font-size: 13.5px; }
.gdCardIn span { font-size: 12.5px; color: var(--muted); line-height: 1.7; }
.gdBox { margin-top: 14px; padding: 12px 14px; border: 1px dashed var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.gdBoxTitle { font-weight: 700; font-size: 13px; }
.gdMuted { font-size: 12px; color: var(--muted); margin-top: 3px; word-break: break-all; }
.gdWarn { color: var(--warn); }
.gdComps { display: flex; flex-wrap: wrap; gap: 5px; }
.gdTip { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--soft); font-size: 13px; line-height: 1.8; }
.gdFoot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
</style>
