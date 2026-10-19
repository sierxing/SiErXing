<template>
  <section class="lab-card">
    <div class="lab-badge">内置插件</div>
    <h2>目标节奏卡片</h2>
    <p>这个卡片由 <code>.vue</code> 内置插件渲染。它不知道页面其他部分怎么实现，只通过 props 拿宿主数据。</p>
    <dl class="lab-kv">
      <div><dt>组件 id</dt><dd>demo-card</dd></div>
      <div><dt>宿主 API</dt><dd>{{ host && host.api }}</dd></div>
      <div><dt>目标</dt><dd>{{ host && host.goal }}</dd></div>
    </dl>
  </section>
</template>

<script setup>
defineProps({ host: { type: Object, default: function () { return {}; } } });
</script>

<style scoped>
.lab-card { border: 1px solid var(--line, #d8d8d8); border-radius: 12px; padding: 18px; background: var(--surface, #fff); }
.lab-badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--accent-weak, #e8f0ff); color: var(--accent, #2b5bd7); margin-bottom: 8px; }
h2 { margin: 4px 0 8px; font-size: 20px; }
p { color: var(--muted, #666); line-height: 1.6; }
.lab-kv { display: grid; gap: 6px; margin: 12px 0 0; font-size: 14px; }
.lab-kv div { display: flex; gap: 8px; }
.lab-kv dt { min-width: 72px; color: var(--muted, #666); }
.lab-kv dd { margin: 0; }
</style>
