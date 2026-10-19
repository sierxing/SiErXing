<template>
  <div class="lab-page">
    <header class="lab-head">
      <div>
        <div class="lab-kicker">UI Lab · 插件宿主 PoC</div>
        <h1>非核心 UI 插件化</h1>
        <p class="lab-sub">这一页只验证三件事：Vue SFC 能构建、用户插件能覆盖内置插件、加载失败能回退。</p>
      </div>
      <button class="lab-btn" type="button" @click="reload">重新加载插件</button>
    </header>

    <div v-if="loading" class="lab-card lab-loading">正在解析 UI 插件…</div>
    <template v-else>
      <div class="lab-status" :data-source="plugin.source">
        当前渲染：{{ plugin.source === 'user' ? '用户插件' : '内置插件（回退）' }}
        <span v-if="plugin.reason"> · {{ plugin.reason }}</span>
      </div>
      <component :is="plugin.component" :host="hostInfo" />
    </template>

    <footer class="lab-foot">
      <p>插件目录约定：内置 <code>ui/plugins/builtin/</code>，用户 <code>DATA_DIR/ui-plugins/</code>；服务端 API：<code>/api/ui/plugins</code>。</p>
      <p>宿主 API：<code>{{ hostInfo.api }}</code> · 插件 id：<code>demo-card</code></p>
    </footer>
  </div>
</template>

<script setup>
import { onErrorCaptured, onMounted, ref } from 'vue';
import BuiltinDemoCard from '../plugins/builtin/DemoCard.vue';
import { resolveUiPlugin } from '../sdk/loader.js';
import { UI_HOST_API } from '../sdk/host.js';

const loading = ref(true);
const plugin = ref({ component: BuiltinDemoCard, source: 'builtin', reason: '' });
const hostInfo = { api: UI_HOST_API, goal: '示例目标 · 找到 AI 产品经理实习', source: 'ui-lab' };
let renderingUser = false;

async function load() {
  loading.value = true;
  const forceBuiltin = new URLSearchParams(location.search).get('builtin') === '1';
  const r = await resolveUiPlugin({ id: 'demo-card', builtin: BuiltinDemoCard, forceBuiltin: forceBuiltin });
  plugin.value = r;
  renderingUser = r.source === 'user';
  loading.value = false;
}

function reload() { load(); }

onMounted(load);

onErrorCaptured(function (err) {
  if (!renderingUser) return false;
  renderingUser = false;
  plugin.value = { component: BuiltinDemoCard, source: 'builtin', reason: '用户插件渲染失败，已回退：' + (err && err.message ? err.message : err) };
  return false;
});
</script>

<style scoped>
.lab-page { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text, #222); }
.lab-head { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 22px; }
.lab-kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent, #2b5bd7); font-weight: 700; }
h1 { margin: 6px 0 8px; font-size: 30px; }
.lab-sub { margin: 0; color: var(--muted, #666); line-height: 1.6; max-width: 560px; }
.lab-btn { border: 1px solid var(--line, #d8d8d8); background: var(--surface, #fff); border-radius: 8px; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
.lab-btn:hover { border-color: var(--accent, #2b5bd7); color: var(--accent, #2b5bd7); }
.lab-card { border: 1px solid var(--line, #d8d8d8); border-radius: 12px; padding: 18px; background: var(--surface, #fff); }
.lab-loading { color: var(--muted, #666); }
.lab-status { margin: 0 0 12px; font-size: 13px; color: var(--muted, #666); }
.lab-status[data-source="user"] { color: #1f8b4c; }
.lab-foot { margin-top: 24px; font-size: 13px; color: var(--muted, #666); line-height: 1.7; }
code { font-size: .92em; background: var(--bg-soft, #f3f4f6); padding: 1px 5px; border-radius: 4px; }
</style>
