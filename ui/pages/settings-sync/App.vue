<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回设置</button>
      <h2 class="title" style="margin-left:10px;">🔄 多端同步</h2>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="busy" @click="load">↻ 刷新状态</button>
    </div>
    <p class="hint" style="margin:-4px 0 12px;">把数据快照提交到<b>你自己的 Git 仓库</b>（建议私有），实现多台设备同步：改动后自动上传、启动时自动拉取。密钥类信息（AI API Key、同步令牌、LeetCode 登录态）不会被同步。</p>

    <div v-if="conflict" class="secCard" style="border-color:var(--warn);">
      <div class="secHead"><span>⚠️ 检测到同步冲突</span><div class="spacer"></div></div>
      <p class="hint" style="margin:8px 0;">本地和云端都有新改动，自动同步已暂停，不会覆盖任何一边。请二选一：</p>
      <div class="cfCols"><div class="cfSide"><b>💻 本地</b><div class="ovSub">最后改动：{{ fmtDate(conflict.local && conflict.local.changeAt) }}</div><div class="ovSub">目标 {{ counts(conflict.local) }} 个 · 节点 {{ (conflict.local && conflict.local.counts && conflict.local.counts.nodes) || 0 }} 个</div></div><div class="cfSide"><b>☁️ 云端</b><div class="ovSub">来自 {{ (conflict.remote && conflict.remote.device) || '其它设备' }} · {{ fmtDate(conflict.remote && conflict.remote.savedAt) }}</div><div class="ovSub">目标 {{ counts(conflict.remote) }} 个 · 节点 {{ (conflict.remote && conflict.remote.counts && conflict.remote.counts.nodes) || 0 }} 个</div></div></div>
      <div class="toolbarRow" style="margin-top:10px;"><button class="btn" type="button" :disabled="busy" @click="resolveConflict('local')">💻 保留本地并上传</button><button class="btn primary" type="button" :disabled="busy" @click="resolveConflict('remote')">☁️ 用云端覆盖本地</button></div>
      <p class="hint" style="margin-top:8px;">选「用云端」会先自动备份本地（data/backups），选错还能找回。</p>
    </div>

    <div class="secCard">
      <div class="secHead"><span>同步设置</span><div class="spacer"></div><span class="chip" :class="st.enabled ? 'ok' : 'gray'">{{ st.enabled ? '已启用' : '未启用' }}</span><span class="chip gray">{{ st.hasGit ? '✓ 检测到 git' : '⚠ 未检测到 git' }}</span></div>
      <label class="syncRow"><span>启用同步</span><input v-model="form.enabled" type="checkbox"><span class="muted">开启后才会自动上传/拉取</span></label>
      <label class="syncFull">仓库地址<input v-model="form.repo" placeholder="https://atomgit.com/你的用户名/sierxing-data.git"></label>
      <div class="syncGrid"><label>分支<input v-model="form.branch" placeholder="main"></label><label>用户名（可选）<input v-model="form.user" placeholder="oauth2 或你的账号"></label></div>
      <label class="syncFull">密码 / 访问令牌<input v-model="form.token" type="password" :placeholder="st.hasToken ? '已保存（留空则不修改）' : '粘贴访问令牌'"></label>
      <p class="hint">AtomGit 已关闭密码登录：令牌去网页端头像 → 设置 → 访问令牌生成，填到这里（不是登录密码）。</p>
      <label class="syncRow"><span>自动上传</span><input v-model="form.auto_push" type="checkbox"><span class="muted">数据变化后约 20 秒自动提交并推送</span></label>
      <label class="syncRow"><span>启动时拉取</span><input v-model="form.auto_pull" type="checkbox"><span class="muted">每次打开程序时从仓库拉取最新数据</span></label>
      <label class="syncRow"><span>同步图片</span><input v-model="form.images" type="checkbox"><span class="muted">把上传的图片也一起同步</span></label>
      <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="busy" @click="saveTest">{{ busy ? '处理中…' : '保存并测试连接' }}</button><button class="btn" type="button" :disabled="busy" @click="push">⬆ 立即上传</button><button class="btn" type="button" :disabled="busy" @click="pull">⬇ 立即拉取</button></div>
      <div v-if="msg" class="hint" style="margin-top:10px;">{{ msg }}</div>
    </div>

    <div class="secCard" style="margin-top:14px;">
      <div class="secHead"><span>仓库与本地状态</span></div>
      <div class="ovGrid" style="margin-top:10px;"><div class="ovItem"><span class="ovLabel">仓库里最新快照</span><b>{{ st.snapshot ? fmtDate(st.snapshot.savedAt) : '—' }}</b><span class="ovSub">{{ st.snapshot ? ('来自 ' + (st.snapshot.device || '') + ' · ' + ((st.snapshot.counts && st.snapshot.counts.goals) || 0) + ' 个目标') : '还没有快照' }}</span></div><div class="ovItem"><span class="ovLabel">上次同步</span><b>{{ st.lastAt ? fmtDate(st.lastAt) : '还没有同步记录' }}</b><span class="ovSub">{{ st.lastStatus || '' }}</span></div><div class="ovItem"><span class="ovLabel">本地工作副本</span><b>{{ st.commit || '—' }}</b><span class="ovSub">{{ st.workState || '' }}</span></div></div>
      <div v-if="st.outlibWarn" class="hint" style="margin-top:10px;color:var(--danger);">⚠ 产出库：{{ st.outlibWarn }}<span v-if="st.outlibDangling && st.outlibDangling.length"><br>缺文件的有：{{ st.outlibDangling.map(x => x.name).join('、') }}{{ st.outlibDangling.length >= 8 ? ' 等' : '' }}。这些条目只有名字、没有文件本体，到哪台设备上都点不开；要恢复只能重新上传一次。</span></div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 16).replace('T', ' '));
const st = ref({});
const conflict = ref(null);
const busy = ref(false);
const msg = ref('');
const form = reactive({ enabled: false, repo: '', branch: 'main', user: '', token: '', auto_push: false, auto_pull: false, images: false });
function back() { location.hash = '#/settings'; }
function counts(side) { return (side && side.counts && side.counts.goals) || 0; }
function fill(s) { st.value = s || {}; form.enabled = !!s.enabled; form.repo = s.repo || ''; form.branch = s.branch || 'main'; form.user = s.user || ''; form.token = ''; form.auto_push = !!s.autoPush; form.auto_pull = !!s.autoPull; form.images = !!s.images; conflict.value = s.conflict || null; }
async function load() { try { fill(await api('/api/sync/status')); } catch (e) { toast('读取同步状态失败：' + e.message); } }
async function save() { const r = await api('/api/sync/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: form.enabled, repo: form.repo, branch: form.branch, user: form.user, token: form.token, auto_push: form.auto_push, auto_pull: form.auto_pull, images: form.images }) }); fill(r.status || st.value); form.token = ''; return r; }
async function saveTest() { if (busy.value) return; busy.value = true; msg.value = '保存中…'; try { await save(); const t = await api('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); msg.value = t.ok ? ('✅ 已保存，仓库可访问' + (t.branches && t.branches.length ? '（分支：' + t.branches.join('、') + '）' : '（仓库还是空的，点「立即上传」创建首个快照）')) : ('❌ 已保存，但仓库连不上：' + (t.message || '')); toast(t.ok ? '同步已保存，仓库可访问' : '已保存，但仓库连不上'); await load(); } catch (e) { msg.value = '❌ ' + e.message; toast(e.message); } busy.value = false; }
async function push() { if (busy.value) return; busy.value = true; msg.value = '正在导出并推送到仓库…'; try { await save(); const r = await api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.conflict) { conflict.value = r.conflict; msg.value = '⚠️ 云端也有新改动，已暂停上传，请二选一。'; } else { const c = r.counts || {}; msg.value = '✅ 上传成功 · ' + (c.goals || 0) + ' 个目标 / ' + (c.nodes || 0) + ' 个节点'; toast('已上传到同步仓库'); } } catch (e) { msg.value = '❌ 上传失败：' + e.message; toast('上传失败：' + e.message); } busy.value = false; }
async function pull() { if (busy.value) return; busy.value = true; msg.value = '正在从仓库拉取…'; try { await save(); const r = await api('/api/sync/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.conflict) { conflict.value = r.conflict; msg.value = '⚠️ 本地和云端都有新改动，已暂停同步，请二选一。'; } else if (r.imported) { msg.value = '✅ 已导入来自 ' + (r.device || '其它设备') + ' 的数据，页面即将刷新…'; toast('已导入最新数据'); setTimeout(() => location.reload(), 1200); } else { msg.value = 'ℹ ' + (r.message || '已是最新'); toast(r.message || '已是最新'); } } catch (e) { msg.value = '❌ 拉取失败：' + e.message; toast('拉取失败：' + e.message); } busy.value = false; }
async function resolveConflict(choice) { if (busy.value) return; if (!window.confirm(choice === 'remote' ? '确定用云端覆盖本地？本地的新改动会被替换（已自动备份，可回滚）。' : '确定保留本地并上传？云端的新改动会被本地覆盖（云端设备下次同步时会看到冲突提示，可再选回来）。')) return; busy.value = true; try { const r = await api('/api/sync/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) }); if (r.conflict) { conflict.value = r.conflict; toast('对方又有新改动，请重新选择'); } else if (choice === 'remote' && r.imported) { toast('已用云端数据覆盖本地'); setTimeout(() => location.reload(), 1200); } else { toast('已保留本地并上传'); conflict.value = null; await load(); } } catch (e) { toast(e.message); } busy.value = false; }
onMounted(load);
</script>

<style scoped>
.page { max-width: 1080px; }
.syncRow { display: flex; align-items: center; gap: 10px; margin: 9px 0; font-size: 13px; }
.syncRow input[type=checkbox] { width: 16px; height: 16px; }
.syncFull { display: block; margin-top: 10px; font-size: 13px; }
.syncFull input { width: 100%; box-sizing: border-box; margin-top: 4px; }
.syncGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.syncGrid input { width: 100%; box-sizing: border-box; margin-top: 4px; }
.cfCols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
.cfSide { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.ovGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.ovItem { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.ovLabel { font-size: 12px; color: var(--muted); }
.ovSub { font-size: 12px; color: var(--muted); word-break: break-all; }
</style>
