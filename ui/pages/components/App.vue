<template>
  <div class="page wide cmpPage">
    <div class="pageHead">
      <button class="back" type="button" @click="goHome">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🧩 组件</h2>
      <span class="hint" style="margin-left:10px;">功能与界面样式都由组件提供，可自由开关、导入分享</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="load">↻ 重新加载</button>
      <label class="btn small primary" title="导入 *.component.json 组件包（可多选）">⬆ 导入组件<input type="file" accept=".json,application/json" multiple hidden @change="pickImport"></label>
    </div>
    <div class="sec">
      <div class="secTitle">管理范围</div>
      <div class="ppCats">
        <button type="button" class="ppCat" :class="{ active: scope === 'global' }" @click="setScope('global')">🌍 全局默认</button>
        <button v-for="g in goals" :key="g.id" type="button" class="ppCat" :class="{ active: scope === 'goal:' + g.id }" @click="setScope('goal:' + g.id)">🎯 {{ g.title }}</button>
      </div>
      <p class="hint" style="margin:8px 0 0;">{{ scopeGoal ? '正在管理「' + scopeGoal.title + '」：这里的开关只改这个目标，别的目标不受影响。' : '全局开关 = 新目标的默认值，也管应用级组件（番茄钟浮窗、笔记面板等）；已经单独设置过的目标不受影响。' }}</p>
    </div>
    <div v-if="scopeGoal" class="sec">
      <div class="secTitle">🎯 {{ scopeGoal.title }} 的组件（只改本目标）</div>
      <p class="hint" style="margin:0 0 10px;">这里的开关<b>只写这一个目标</b>，其它目标完全不受影响。没单独设置过的组件，仍按 🌍 全局默认走。</p>
      <div class="cmpGrid"><div v-for="e in goalEntries" :key="e.id" class="cmpCard"><div class="cmpCardTop"><span class="cmpIcon">{{ e.icon || '🧩' }}</span><div class="cmpName">{{ e.name }}<div v-if="e.desc" class="cmpDesc" style="margin-top:4px;">{{ e.desc }}</div></div><div class="cmpOps"><label class="cmpSwitch" title="只改本目标"><input type="checkbox" :checked="goalOn[e.id]" @change="toggleGoal(e.id, $event.target.checked)"><span class="cmpSlider"></span></label></div></div></div></div>
    </div>
    <details v-if="scopeGoal" class="cmpGlobalFold" open>
      <summary>🌍 全局组件与分类（下面的开关影响<b>所有</b>目标，别在这里改单个目标）</summary>
      <div class="sec"><div class="secTitle">分类管理</div><p class="hint" style="margin:0 0 10px;">分类用于整理组件，也可以在「新建目标」时按分类批量选择组件。</p><div class="catList"><span v-for="c in cats.categories || []" :key="c" class="catItem"><span class="catName">{{ c }}</span><span class="catCount">{{ (cats.used || {})[c] || 0 }}</span><button class="catOp" type="button" title="重命名" @click="renameCat(c)">✎</button><button class="catOp danger" type="button" title="删除" @click="delCat(c)">×</button></span><span v-if="!(cats.categories || []).length" class="muted" style="font-size:12.5px;">还没有自定义分类</span></div><div class="consAdd" style="margin-top:10px;"><input v-model="newCat" type="text" placeholder="新建分类，例如：学习成长 / 效率工具"><button class="btn small primary" type="button" :disabled="busy" @click="addCat">新建分类</button></div></div>
      <component-cards :groups="groups" :cat-options="catOptions" :enabled="enabled" :busy="busy" @toggle="toggleGlobal" @move="moveCategory" @uninstall="uninstall" />
    </details>
    <template v-if="!scopeGoal">
      <div class="sec"><div class="secTitle">分类管理</div><p class="hint" style="margin:0 0 10px;">分类用于整理组件，也可以在「新建目标」时按分类批量选择组件。</p><div class="catList"><span v-for="c in cats.categories || []" :key="c" class="catItem"><span class="catName">{{ c }}</span><span class="catCount">{{ (cats.used || {})[c] || 0 }}</span><button class="catOp" type="button" title="重命名" @click="renameCat(c)">✎</button><button class="catOp danger" type="button" title="删除" @click="delCat(c)">×</button></span><span v-if="!(cats.categories || []).length" class="muted" style="font-size:12.5px;">还没有自定义分类</span></div><div class="consAdd" style="margin-top:10px;"><input v-model="newCat" type="text" placeholder="新建分类，例如：学习成长 / 效率工具"><button class="btn small primary" type="button" :disabled="busy" @click="addCat">新建分类</button></div></div>
      <component-cards :groups="groups" :cat-options="catOptions" :enabled="enabled" :busy="busy" @toggle="toggleGlobal" @move="moveCategory" @uninstall="uninstall" />
      <div class="sec"><div class="secTitle">分享组件</div><p class="hint" style="line-height:1.9;">· 导出：点组件的「导出」得到 <code>*.component.json</code> 文件<br>· 导入：右上角「⬆ 导入组件」（可多选，先预览校验再安装）<br>· 卸载：点组件卡片上的「卸载」<br>· 自己写一个：把 <code>server/plugins/xxx.js</code>、<code>public/plugins/xxx.js</code>、<code>public/plugins/xxx.css</code> 放进对应目录即可</p></div>
    </template>
    <div v-if="impOpen" class="modalMask" @click.self="impOpen = false">
      <div class="modalBox impBox">
        <div class="modalHead"><b>📦 导入组件（选中 {{ impItems.length }} 个）</b><div class="spacer"></div><button class="btn tiny" type="button" @click="impOpen = false">×</button></div>
        <div class="impList"><div v-for="(x, i) in impItems" :key="i" class="impItem"><span class="chip" :class="x.error ? 'danger' : (x.replaced ? 'warn' : 'ok')">{{ x.error ? '无法导入' : (x.replaced ? '覆盖' : '新装') }}</span><b>{{ x.name }}</b><span class="muted">{{ x.id || x.file }}{{ x.version ? ' · v' + x.version : '' }}</span><span v-if="x.error" class="impErr">{{ x.error }}</span></div></div>
        <div v-if="impValid.length" class="field" style="margin-top:12px;"><label>导入到分类</label><select v-model="impCat" class="sxi-sel"><option value="__auto__">使用组件自带分类（{{ Array.from(new Set(impValid.map(v => v.autoCat))).join(' / ') }}）</option><option v-for="c in cats.categories || []" :key="c" :value="c">{{ c }}</option><option value="__new__">＋ 新建分类…</option></select><input v-if="impCat === '__new__'" v-model="impNewCat" placeholder="新分类名称，例如：效率工具" style="margin-top:8px;"></div>
        <p class="hint" style="margin-top:10px;">组件包含可执行代码（服务端会加载、前端会注入页面），请只导入你信任来源的组件。</p>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="impBusy || !impValid.length" @click="doImport">{{ impBusy ? '导入中…' : ('导入 ' + impValid.length + ' 个组件') }}</button><button class="btn" type="button" @click="impOpen = false">取消</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const busy = ref(false);
const comps = ref([]);
const enabled = ref({});
const cats = ref({ categories: [], used: {}, map: {} });
const goals = ref([]);
const scope = ref('global');
const scopeGoal = computed(() => goals.value.find(g => 'goal:' + g.id === scope.value) || null);
const goalEntries = ref([]);
const goalOn = ref({});
const newCat = ref('');
const impOpen = ref(false);
const impItems = ref([]);
const impCat = ref('__auto__');
const impNewCat = ref('');
const impBusy = ref(false);
const impValid = computed(() => impItems.value.filter(x => !x.error));
async function pickImport(ev) {
  const files = Array.from((ev.target && ev.target.files) || []);
  ev.target.value = '';
  if (!files.length) return;
  const installed = new Set(comps.value.filter(c => !c.builtin).map(c => c.id));
  const items = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const id = String((bundle && bundle.id) || '');
      const okFmt = bundle && bundle.format === 'sierxing-component' && id && typeof bundle.server === 'string' && bundle.server.includes('module.exports');
      items.push({ file: file.name, bundle, id, name: (bundle && bundle.name) || id || file.name, version: (bundle && bundle.version) || '', author: (bundle && bundle.author) || '', autoCat: (bundle && bundle.category) || '其它', error: okFmt ? '' : '不是有效的组件文件', replaced: okFmt && installed.has(id) });
    } catch (e) { items.push({ file: file.name, bundle: null, id: '', name: file.name, error: '不是合法 JSON' }); }
  }
  impItems.value = items; impCat.value = '__auto__'; impNewCat.value = ''; impOpen.value = true;
}
async function doImport() {
  if (impBusy.value || !impValid.value.length) return;
  let category = impCat.value;
  if (category === '__new__') {
    const name = String(impNewCat.value || '').trim();
    if (!name) return toast('请填写新分类名称');
    category = name;
  }
  impBusy.value = true;
  try {
    const r = await api('/api/components/install-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundles: impValid.value.map(x => x.bundle), category }) });
    const results = r.results || [];
    const okN = results.filter(x => x.ok).length;
    toast(okN ? ('已导入 ' + okN + ' 个组件' + (results.length > okN ? '，' + (results.length - okN) + ' 个失败' : '')) : '导入失败：' + ((results[0] && results[0].error) || '未知错误'));
    impOpen.value = false;
    await load();
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast('导入失败：' + e.message); }
  impBusy.value = false;
}
const catOptions = computed(() => [...new Set([...(cats.value.categories || []), ...Object.keys(groups.value), '其它'])]);
const groups = computed(() => { const m = {}; for (const c of comps.value) { const k = c.category || '其它'; (m[k] = m[k] || []).push(c); } return m; });
function goHome() { location.hash = '#/'; }
async function load() {
  try {
    const [r, cr, gr] = await Promise.all([api('/api/components'), api('/api/component-categories').catch(() => ({ categories: [], used: {}, map: {} })), api('/api/goals').catch(() => ({ goals: [] }))]);
    comps.value = r.components || []; enabled.value = r.enabled || {}; cats.value = cr || { categories: [] }; goals.value = gr.goals || [];
    if (scope.value !== 'global' && !scopeGoal.value) scope.value = 'global';
  } catch (e) { toast('组件加载失败：' + e.message); }
}
async function loadGoalPlugins() {
  if (!scopeGoal.value) { goalEntries.value = []; goalOn.value = {}; return; }
  try {
    const r = await api('/api/goals/' + scopeGoal.value.id + '/plugins');
    const cfg = r.config || {};
    goalEntries.value = comps.value.filter(c => c.goalToggle && c.scope !== 'core');
    const on = {};
    for (const c of goalEntries.value) on[c.id] = (cfg[c.id] !== undefined) ? !!cfg[c.id] : (enabled.value[c.id] !== false && (c.defaultEnabled !== false));
    goalOn.value = on;
  } catch (e) { goalEntries.value = []; goalOn.value = {}; }
}
async function setScope(s) { scope.value = s; await loadGoalPlugins(); }
async function toggleGlobal(c, checked) {
  if (busy.value) return; busy.value = true;
  try { const r = await api('/api/components/' + encodeURIComponent(c.id) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: checked }) }); enabled.value = r.enabled || enabled.value; toast(checked ? '已开启组件' : '已关闭组件'); setTimeout(() => location.reload(), 400); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function toggleGoal(id, checked) {
  if (busy.value || !scopeGoal.value) return; busy.value = true;
  try { await api('/api/goals/' + scopeGoal.value.id + '/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: id, enabled: checked }) }); goalOn.value = Object.assign({}, goalOn.value, { [id]: checked }); toast(checked ? '已为本目标启用（别的不受影响）' : '已为本目标关闭（别的不受影响）'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function moveCategory(c, category) {
  if (busy.value) return; busy.value = true;
  try { await api('/api/components/' + encodeURIComponent(c.id) + '/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }) }); await load(); toast('已移动到「' + category + '」'); setTimeout(() => location.reload(), 500); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function addCat() {
  const name = String(newCat.value || '').trim(); if (!name) return toast('请输入分类名');
  if (busy.value) return; busy.value = true;
  try { await api('/api/component-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); newCat.value = ''; await load(); toast('已新建分类「' + name + '」'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function renameCat(from) {
  const name = window.prompt('重命名分类：', from); if (name == null || !name.trim() || name.trim() === from) return;
  if (busy.value) return; busy.value = true;
  try { await api('/api/component-categories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, name: name.trim() }) }); await load(); toast('已重命名'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function delCat(name) {
  if (!window.confirm('删除分类「' + name + '」？该分类下的组件会回到它们原本的分类。')) return;
  if (busy.value) return; busy.value = true;
  try { await api('/api/component-categories/' + encodeURIComponent(name), { method: 'DELETE' }); await load(); toast('已删除分类'); }
  catch (e) { toast(e.message); } busy.value = false;
}
async function uninstall(c) {
  if (!window.confirm('卸载组件「' + c.id + '」？相关文件会被删除（数据表保留）。')) return;
  if (busy.value) return; busy.value = true;
  try { await api('/api/components/' + encodeURIComponent(c.id), { method: 'DELETE' }); await load(); toast('已卸载'); }
  catch (e) { toast(e.message); } busy.value = false;
}
onMounted(async () => { await load(); await loadGoalPlugins(); });
const ComponentCards = {
  name: 'ComponentCards',
  props: { groups: Object, catOptions: Array, enabled: Object, busy: Boolean },
  emits: ['toggle', 'move', 'uninstall'],
  setup(props, { emit }) {
    const card = (c) => h('div', { class: ['cmpCard', c.scope === 'core' ? 'isCore' : ''] }, [
      h('div', { class: 'cmpCardTop' }, [
        h('span', { class: 'cmpIcon' }, c.icon || '✨'),
        h('div', { class: 'cmpName' }, [
          c.name,
          c.scope === 'core' ? h('span', { class: 'chip gray' }, '核心 · 不可关闭') : null,
          c.kind === 'theme' ? h('span', { class: 'chip gray' }, '主题皮肤') : null,
          c.builtin ? null : h('span', { class: 'chip' }, '第三方组件'),
          c.goalToggle && c.scope !== 'core' ? h('span', { class: 'chip gray' }, '按目标启用') : null,
        ]),
        h('div', { class: 'cmpOps' }, (c.kind === 'theme' || c.scope === 'theme')
          ? h('a', { class: 'btn tiny', href: '#/settings/theme' }, '去设置里选')
          : h('label', { class: 'cmpSwitch', title: c.scope === 'core' ? '核心组件不可关闭' : '开启 / 关闭' }, [
              h('input', { type: 'checkbox', checked: props.enabled[c.id] !== false, disabled: c.scope === 'core', onChange: e => emit('toggle', c, e.target.checked) }),
              h('span', { class: 'cmpSlider' })
            ]))
      ]),
      h('div', { class: 'cmpDesc' }, c.desc || ''),
      h('div', { class: 'cmpCatRow' }, [
        h('span', { class: 'cmpCatLabel' }, '分类'),
        h('select', { class: 'cmpCatSel', value: c.category || '其它', onChange: e => emit('move', c, e.target.value) }, props.catOptions.map(k => h('option', { value: k, selected: k === (c.category || '其它') }, k)))
      ]),
      c.builtin ? null : h('div', { class: 'cmpCardOps' }, [
        h('a', { class: 'btn tiny', href: '/api/components/' + encodeURIComponent(c.id) + '/export' }, '导出'),
        h('button', { class: 'btn tiny danger', onClick: () => emit('uninstall', c) }, '卸载')
      ]),
      h('div', { class: 'cmpFiles' }, '服务端 server/plugins/' + c.id + '.js' + (c.client ? ' · 前端 public/plugins/' + c.id + '.js' : '') + (c.hasStyle ? ' · 样式 public/plugins/' + c.id + '.css' : ''))
    ]);
    return () => h('div', { class: 'cmpCols' }, Object.keys(props.groups).sort().map(k => h('div', { class: 'sec' }, [
      h('div', { class: 'secTitle' }, k + '（' + (props.groups[k] || []).length + '）'),
      (props.groups[k] || []).length ? h('div', { class: 'cmpGrid' }, props.groups[k].map(card)) : h('div', { class: 'muted', style: 'font-size:13px;' }, '（空分类）')
    ])));
  }
};
</script>

<style scoped>
.impBox { width: min(680px, 96vw); }
.impList { display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow: auto; }
.impItem { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-bottom: 1px dashed var(--line); padding: 6px 2px; flex-wrap: wrap; }
.impErr { color: var(--danger); font-size: 11.5px; }
.cmpPage { max-width: 1280px; }
</style>