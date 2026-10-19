<template>
  <div class="page chatPage">
    <div class="pageHead">
      <button class="back" type="button" @click="gid ? back() : home()">← {{ gid ? '返回目标' : '返回首页' }}</button>
      <h2 class="title" style="margin-left:8px;">💬 {{ gid ? (goalTitle || 'AI 助手') : 'AI 助手 · 选择目标' }}</h2>
      <template v-if="gid">
        <span class="chip gray">{{ sessions.length }} 个对话</span>
        <div class="spacer"></div>
        <div class="seg"><button type="button" :class="{ on: mode === 'agent' }" @click="setMode('agent')">🛠 执行</button><button type="button" :class="{ on: mode === 'ask' }" @click="setMode('ask')">💡 问答</button></div>
        <button class="btn small" type="button" @click="newSession">＋ 新对话</button>
        <button class="btn small" type="button" @click="reload">⟳ 刷新</button>
      </template>
    </div>

    <div v-if="!gid" class="card goalPick">
      <div class="cardHead"><span>💬 先选一个目标</span></div>
      <p class="hint" style="margin:0 0 10px;">对话、节点附件、教程修改都挂在某个目标上；选一个目标再聊。</p>
      <div class="goalPickList">
        <button v-for="g in goals" :key="g.id" class="goalPickRow" type="button" @click="pickGoal(g.id)">
          <span class="goalPickTitle">{{ g.title }}</span>
          <span class="chip gray">{{ g.status === 'review' ? '骨架待确认' : (g.status === 'planned' ? '进行中' : (g.status || '—')) }}</span>
          <span class="muted" style="font-size:12px;">{{ g.tasks_done || 0 }}/{{ g.tasks_total || 0 }} 任务</span>
          <span class="spacer"></span><span class="muted">进入对话 →</span>
        </button>
        <div v-if="!goals.length" class="muted" style="padding:14px;">还没有目标。先回首页创建一个。</div>
      </div>
    </div>

    <template v-if="gid">
    <div v-if="tutorialId" class="tutBind">📘 正在针对教程《{{ tutTitle || ('#' + tutorialId) }}》对话 —— 你的修改意见会写回这篇教程。<a :href="'#/t/' + tutorialId">打开教程 →</a></div>
    <div class="chatGrid">
      <aside class="card sessCol">
        <div class="cardHead"><span>历史对话</span><div class="spacer"></div><span class="muted" style="font-size:11.5px;">{{ mode === 'agent' ? '执行模式' : '问答模式' }}</span></div>
        <div class="sessList">
          <div v-for="s in sessions" :key="s.id" class="sessItem" :class="{ on: s.id === sid }" @click="selectSession(s.id)">
            <div class="sessTitle">{{ s.title || '新对话' }}</div>
            <div class="sessMeta">{{ s.msg_count || 0 }} 条 · {{ fmt(s.updated_at) }}</div>
            <button class="btn tiny sessEdit" type="button" title="重命名" @click.stop="renameSession(s)">✎</button>
            <button class="btn tiny danger sessDel" type="button" title="删除这段对话" @click.stop="delSession(s)">×</button>
          </div>
          <div v-if="!sessions.length" class="muted" style="padding:12px;font-size:12.5px;">还没有对话。点右上「＋ 新对话」开始。</div>
        </div>
      </aside>

      <section class="card chatMain">
        <div ref="msgsEl" class="msgs">
          <div v-if="!messages.length && !busy" class="emptyChat">
            <div style="font-size:38px;">💬</div>
            <b>问点什么</b>
            <p class="muted" style="max-width:420px;margin:4px 0 0;line-height:1.7;">{{ tutorialId ? '直接说这篇教程哪里要改（比如“把第 3 节讲慢一点”），我会按意见修改。' : '可以让我解释规划、调整教程、整理资料；「执行」模式下我还能直接改目标里的内容，「问答」模式只回答不动手。' }}</p>
          </div>
          <div v-for="(m, mi) in messages" :key="m.id || ('t' + mi)" class="msg" :class="m.role">
            <div class="bubble">
              <div v-if="m.role === 'assistant'" class="md" v-html="md(m.content)"></div>
              <div v-else class="userText">{{ m.content }}</div>
              <div v-if="m.applied && m.applied.length" class="ops">已执行 {{ m.applied.length }} 项操作</div>
              <details v-if="m.trace && m.trace.length" class="trace"><summary>它做了什么（{{ m.trace.length }}）</summary><div v-for="(t, i) in m.trace" :key="i" class="traceItem">{{ sayStep(t) }}</div></details>
              <div v-if="m.role === 'assistant' && pendingOf(m)" class="pendCard">
                <div class="pendHead">📐 等你确认改动范围</div>
                <div class="pendScope">{{ pendScope(pendingOf(m)) }}</div>
                <div class="pendRow"><button class="btn tiny primary" type="button" data-pend-ok :disabled="busy || m.pendDone" @click="confirmPending(m)">{{ m.pendDone ? '已确认，正在开跑…' : '✅ 就按这个范围改' }}</button><button class="btn tiny" type="button" data-pend-no @click="pendNo(m)">✏️ 范围不对</button></div>
                <div v-if="m.pendTip" class="pendTip">{{ m.pendTip }}</div>
              </div>
            </div>
          </div>
          <div v-if="busy" class="msg assistant">
            <div class="bubble">
              <div v-if="streamText" class="md" v-html="md(streamText)"></div>
              <div v-else class="muted">{{ streamThinking || '正在思考…' }}</div>
              <details v-if="streamSteps.length" class="trace" open><summary>它做了什么（{{ streamSteps.length }}）</summary><div v-for="(t, i) in streamSteps" :key="i" class="traceItem">{{ sayStep(t) }}</div></details>
            </div>
          </div>
        </div>
        <div class="attachBar" v-if="goalNodes.length">
          <span class="attachLabel">📌 节点附件</span>
          <span v-for="a in attached" :key="a.id" class="attachChip" :title="a.title">{{ a.title }}<span v-if="a.withKids" class="muted">·含子</span><button type="button" class="attachX" title="移出附件" @click="removeAttach(a)">×</button></span>
          <span v-if="!attached.length" class="muted" style="font-size:12px;">不选则 AI 按整个目标理解</span>
          <button class="btn tiny" type="button" @click="openAttach">＋ 节点</button>
        </div>
        <div class="inputRow">
          <textarea v-model="draft" rows="3" :disabled="busy" placeholder="输入消息…（Enter 发送，Shift+Enter 换行）" @keydown.enter.exact.prevent="send"></textarea>
          <button v-if="busy" class="btn danger" type="button" @click="stop">⏹ 停止</button>
          <button v-else class="btn primary" type="button" :disabled="!draft.trim()" @click="send">发送</button>
        </div>
        <p class="hint" style="margin:8px 0 0;">历史对话与「它做了什么」都会保存；换设备可同步。</p>
      </section>
    </div>

    <div v-if="attachOpen" class="modalMask" @click.self="attachOpen = false">
      <div class="modalBox">
        <div class="modalHead"><b>📌 节点附件（{{ attached.length }}）</b><div class="spacer"></div><button class="btn tiny" type="button" @click="attachOpen = false">×</button></div>
        <p class="hint" style="margin:2px 0 10px;">选中的节点及其子任务会随消息发给 AI（它能看到这些节点的标题/状态/详情），适合"只改这一段""针对这个任务"的对话。会存到本段会话里。</p>
        <input v-model="attachSearch" placeholder="🔍 筛选节点标题" style="width:100%;box-sizing:border-box;margin-bottom:8px;">
        <label class="attachRow attachKids"><input v-model="attachWithKids" type="checkbox"><span>新选节点默认带上子任务</span></label>
        <div class="attachList">
          <label v-for="n in attachRows" :key="n.id" class="attachRow" :style="{ paddingLeft: (8 + n.depth * 16) + 'px' }"><input type="checkbox" :checked="isAttached(n.id)" @change="toggleAttach(n)"><span class="attachTitle">{{ n.title }}</span><span class="muted" style="font-size:11px;">{{ n.level === 0 ? '阶段' : n.level === 1 ? '小目标' : '任务' }}</span></label>
          <div v-if="!attachRows.length" class="muted" style="padding:8px;font-size:12.5px;">没有匹配的节点</div>
        </div>
        <div class="toolbarRow" style="margin-top:10px;"><button class="btn primary" type="button" @click="attachOpen = false">完成</button></div>
      </div>
    </div>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) }, gid: { type: Number, default: 0 } });
const api = props.host.api;
const toast = props.host.toast || function (m) { console.warn(m); };
const gid = Number(props.gid) || 0;
const tutorialId = Number(props.host.tutorialId || 0) || 0;
const nodeId = Number(props.host.nodeId || 0) || 0;
const goals = ref([]);
const tutTitle = ref('');
const goalTitle = ref(String(props.host.goalTitle || ''));
const sessions = ref([]);
const sid = ref(0);
const messages = ref([]);
const draft = ref('');
const busy = ref(false);
const streamText = ref('');
const streamThinking = ref('');
const streamSteps = ref([]);
const msgsEl = ref(null);
const goalNodes = ref([]);
const attached = ref([]);
const attachOpen = ref(false);
const attachSearch = ref('');
const attachWithKids = ref(true);
const mode = ref((function () { try { return localStorage.getItem('sierxing-chat-mode') === 'ask' ? 'ask' : 'agent'; } catch (e) { return 'agent'; } })());
function setMode(m) { mode.value = m; try { localStorage.setItem('sierxing-chat-mode', m); } catch (e) {} }
function back() { location.hash = '#/g/' + gid; }
function home() { location.hash = '#/'; }
function pickGoal(id) { location.hash = '#/g/' + Number(id) + '/chat'; }
async function loadGoals() { try { const r = await api('/api/goals'); goals.value = r.goals || []; } catch (e) { toast('目标列表加载失败：' + e.message); } }
function fmt(s) { try { const d = new Date(s); if (isNaN(d.getTime())) return String(s || '').slice(5, 16); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (e) { return ''; } }
function md(s) {
  try { if (props.host.mdToHTML) return props.host.mdToHTML(String(s || '')); } catch (e) {}
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}
function pendingOf(m) { try { return (m.applied || []).find(o => o && o.op === 'pending_edit') || null; } catch (e) { return null; } }
function pendScope(p) {
  if (!p) return '';
  const v = p.view || {};
  const inS = (v.inSample || []).map(x => '「' + x + '」').join('');
  const keepS = (v.keepSample || []).map(x => '「' + x + '」').join('');
  const nIn = Number(v.inCount || (Number(v.sections || 0) - Number(v.fromIdx || 0)) || 0);
  const nKeep = Number(v.keepCount || v.fromIdx || 0);
  if (v.mode === 'range') {
    let s = '从「' + String(v.fromTitle || v.from || '') + '」开始' + (v.toTitle ? '，到「' + v.toTitle + '」之前' : '，一直到全篇最后');
    s += '。这一段里的小节（共 ' + nIn + ' 节）：' + (inS || '—') + (nIn > (v.inSample || []).length ? ' 等 ' + nIn + ' 节' : '');
    s += '。保持不动（共 ' + nKeep + ' 节）：' + (keepS || '—') + (nKeep > (v.keepSample || []).length ? ' 等 ' + nKeep + ' 节' : '');
    return s;
  }
  return '整篇重排（共 ' + Number(v.sections || 0) + ' 节，章节可能被合并或改名）';
}
function pendNo(m) {
  const p = pendingOf(m) || {};
  const v = p.view || {};
  const eg = (v.inSample || []).filter(Boolean)[0] || v.fromTitle || '';
  m.pendTip = eg ? '✏️ 在下面的输入框里写清楚要改哪几节，发给我就行。比如：只改「' + eg + '」这一节，其余一个字别动。' : '✏️ 在下面的输入框里写清楚要改哪几节（直接写小节标题也行），发给我就行。';
  nextTick(() => { try { const ta = document.querySelector('.inputRow textarea'); if (ta) ta.focus(); } catch (e) {} });
}
async function confirmPending(m) {
  const p = pendingOf(m);
  if (!p || !p.feedback) return toast('这条待确认的改动找不到了，请重新说一次要改什么');
  if (busy.value || m.pendDone) return;
  m.pendDone = true;
  try {
    const r = await api('/api/tutorials/' + p.tutorial_id + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: String(p.feedback || ''), session_id: sid.value, quiet: true, confirmed: true }) });
    if (r && r.pending) { toast('📐 这次要改结构：先看一眼范围，确认后我再动手'); m.pendDone = false; await loadMessages(); }
    else { toast('🤖 已提交教程修改任务（完成后会写回对话）'); await loadMessages(); }
  } catch (e) { m.pendDone = false; toast('提交失败：' + e.message); }
}
function shortPath(x) { const s = String(x || ''); return s.length > 64 ? '…' + s.slice(-63) : s; }
function sayStep(s) {
  if (!s) return '';
  if (s.kind === 'ctx') return '带上了上下文' + (s.label ? '：' + String(s.label).slice(0, 60) : '');
  const inp = s.input || {};
  const tool = String(s.tool || '');
  const p = shortPath(inp.path || inp.filePath || '');
  const cnt = unit => (s.n != null ? ' · ' + s.n + unit : '');
  switch (tool) {
    case 'read': return s.dir ? '📂 看了目录里有什么' + (p ? '：' + p : '') + cnt(' 项') : '📖 ' + (p ? '读了 ' + p : '读了一个文件') + cnt(' 行');
    case 'list': return '📂 看了目录' + (p ? ' ' + p : '') + cnt(' 项');
    case 'glob': return '🔍 找文件' + (inp.pattern ? '「' + String(inp.pattern).slice(0, 50) + '」' : '') + cnt(' 个');
    case 'grep': return '🔎 搜了' + (inp.pattern ? '「' + String(inp.pattern).slice(0, 50) + '」' : '代码') + cnt(' 处');
    case 'shell': return '⌨️ 跑了命令' + (inp.command ? '：' + String(inp.command).slice(0, 70) : '');
    case 'edit': return '✏️ ' + (p ? '改了 ' + p : '改了一处内容');
    case 'write': return '📝 ' + (p ? '写了 ' + p : '写了一个文件');
    case 'webfetch': return '🌐 打开了网页' + (inp.url ? '：' + String(inp.url).slice(0, 60) : '');
    case 'websearch': return '🌐 搜了网络' + (inp.query ? '「' + String(inp.query).slice(0, 50) + '」' : '');
    case 'task': return '🧩 派了个子任务' + ((inp.description || inp.prompt) ? '：' + String(inp.description || inp.prompt).slice(0, 60) : '');
    case 'todowrite': return '📋 更新了待办清单';
    default: return '🛠 ' + (tool ? '用了「' + tool + '」' : '用了一次工具') + ((inp.command || inp.pattern || inp.query) ? '：' + String(inp.command || inp.pattern || inp.query).slice(0, 60) : '');
  }
}
const nodeRows = computed(() => { const out = []; const by = {}; goalNodes.value.forEach(n => { const p = n.parent_id == null ? 0 : Number(n.parent_id); (by[p] = by[p] || []).push(n); }); Object.keys(by).forEach(k => by[k].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id)); const walk = (pid, depth) => { (by[pid] || []).forEach(n => { out.push({ id: Number(n.id), title: n.title, level: Number(n.level) || 0, depth }); walk(n.id, depth + 1); }); }; walk(0, 0); return out; });
const attachRows = computed(() => { const q = String(attachSearch.value || '').trim().toLowerCase(); return nodeRows.value.filter(n => !q || String(n.title).toLowerCase().includes(q)); });
function isAttached(id) { return attached.value.some(a => Number(a.id) === Number(id)); }
function openAttach() { attachOpen.value = true; }
async function persistNodes() {
  if (!sid.value) return;
  try { await api('/api/chat-sessions/' + sid.value, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: attached.value.map(a => ({ id: a.id, withKids: !!a.withKids })) }) }); } catch (e) { toast('节点附件保存失败：' + e.message); }
}
function toggleAttach(n) {
  if (isAttached(n.id)) attached.value = attached.value.filter(a => Number(a.id) !== Number(n.id));
  else attached.value.push({ id: n.id, title: n.title, withKids: !!attachWithKids.value });
  persistNodes();
}
function removeAttach(a) { attached.value = attached.value.filter(x => Number(x.id) !== Number(a.id)); persistNodes(); }
function parseAttached(raw) {
  let list = [];
  try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []); } catch (e) { list = []; }
  const byId = {}; nodeRows.value.forEach(n => { byId[n.id] = n; });
  return (Array.isArray(list) ? list : []).map(a => { const id = Number(a && a.id); const hit = byId[id]; return id ? { id, withKids: !!(a && a.withKids), title: (hit && hit.title) || ('节点 #' + id) } : null; }).filter(Boolean);
}
async function loadTutTitle() {
  if (!tutorialId) return;
  try { const r = await api('/api/tutorials/' + tutorialId + '/content'); tutTitle.value = (r && r.title) || ''; } catch (e) {}
}
async function loadGoal() {
  try { const r = await api('/api/goals/' + gid); const g = r.goal || r; if (g && g.title) goalTitle.value = g.title; goalNodes.value = (g && (g.nodes || g.flat_nodes)) || []; } catch (e) {}
}
async function loadSessions() {
  try {
    const r = await api('/api/goals/' + gid + '/chat-sessions');
    sessions.value = r.sessions || [];
    if (!sessions.value.some(s => Number(s.id) === Number(sid.value))) sid.value = sessions.value.length ? Number(sessions.value[0].id) : 0;
    await loadMessages();
  } catch (e) { toast('对话列表加载失败：' + e.message); }
}
async function loadMessages() {
  if (!sid.value) { messages.value = []; return; }
  try {
    const r = await api('/api/chat-sessions/' + sid.value + '/messages');
    const rows = r.messages || [];
    messages.value = rows.map(m => { let ops = [], trace = []; try { ops = JSON.parse(m.ops || '[]'); } catch (e) {} try { trace = JSON.parse(m.trace || '[]'); } catch (e) {} return { id: m.id, role: m.role, content: m.content, applied: ops, trace }; });
    await nextTick(); scrollBottom();
  } catch (e) { toast('消息加载失败：' + e.message); }
}
async function selectSession(id) { if (busy.value) return; sid.value = Number(id); const s = sessions.value.find(x => Number(x.id) === Number(id)); attached.value = parseAttached(s && s.nodes); await loadMessages(); }
async function newSession() {
  if (busy.value) return;
  try { const r = await api('/api/goals/' + gid + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); sessions.value.unshift(r.session); sid.value = Number(r.session.id); messages.value = []; attached.value = []; } catch (e) { toast('新建对话失败：' + e.message); }
}
async function renameSession(s) {
  if (busy.value) return;
  const title = window.prompt('重命名这段对话', s.title || '新对话');
  if (title == null) return;
  const t = String(title).trim().slice(0, 60);
  if (!t || t === s.title) return;
  try { await api('/api/chat-sessions/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) }); s.title = t; toast('已重命名'); } catch (e) { toast('重命名失败：' + e.message); }
}
async function delSession(s) {
  if (busy.value) return;
  if (!window.confirm('删除这段对话？\n\n' + (s.title || '新对话'))) return;
  try { await api('/api/chat-sessions/' + s.id, { method: 'DELETE' }); toast('已删除对话'); await loadSessions(); } catch (e) { toast('删除失败：' + e.message); }
}
function scrollBottom() { try { const el = msgsEl.value; if (el) el.scrollTop = el.scrollHeight; } catch (e) {} }
async function ensureSession() {
  if (sid.value) return sid.value;
  const r = await api('/api/goals/' + gid + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: '', nodes: attached.value.map(a => ({ id: a.id, withKids: !!a.withKids })) }) });
  sessions.value.unshift(r.session);
  sid.value = Number(r.session.id);
  return sid.value;
}
let abortCtl = null;
function stop() { try { if (abortCtl) abortCtl.abort(); } catch (e) {} }
async function send() {
  const text = String(draft.value || '').trim();
  if (!text || busy.value) return;
  busy.value = true; streamText.value = ''; streamThinking.value = '正在理解你的要求…'; streamSteps.value = []; draft.value = '';
  try {
    const sessionId = await ensureSession();
    messages.value.push({ role: 'user', content: text, applied: [], trace: [] });
    await nextTick(); scrollBottom();
    abortCtl = new AbortController();
    const resp = await fetch('/api/chat-sessions/' + sessionId + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, mode: mode.value, tutorial_id: tutorialId, node_ids: attached.value.map(a => ({ id: a.id, withKids: !!a.withKids })) }), signal: abortCtl.signal });
    if (!resp.ok || !resp.body) throw new Error('无法连接对话服务');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let finished = false;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
        let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.text) { streamText.value += d.text; streamThinking.value = ''; }
        if (d.reply) { streamText.value = d.reply; streamThinking.value = ''; }
        if (d.thinking) streamThinking.value = d.thinking;
        if (d.status) streamThinking.value = d.status;
        if (d.step) streamSteps.value.push(d.step);
        if (d.sessionTitle) { const s = sessions.value.find(x => Number(x.id) === Number(sessionId)); if (s) s.title = d.sessionTitle; }
        if (d.done) {
          finished = true;
          messages.value.push({ id: d.id, role: 'assistant', content: d.reply || streamText.value, applied: d.applied || [], trace: Array.isArray(d.trace) ? d.trace : streamSteps.value.slice() });
          if (Array.isArray(d.applied) && d.applied.length) toast('已执行 ' + d.applied.filter(x => x && x.op !== 'start').length + ' 项操作');
          if (Array.isArray(d.errors) && d.errors.length) toast('部分操作未生效：' + d.errors[0]);
        }
        if (d.cancelled) { finished = true; toast(d.status || '已停止本轮对话'); }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    if (!finished) toast('对话中断，可重试');
    try { await loadSessions(); } catch (e) {}
  } catch (e) { if (e && e.name !== 'AbortError') toast('发送失败：' + e.message); }
  finally { busy.value = false; streamText.value = ''; streamThinking.value = ''; streamSteps.value = []; abortCtl = null; await nextTick(); scrollBottom(); }
}
async function reload() { await loadGoal(); await loadSessions(); toast('已刷新'); }
async function openNodeSession() {
  if (!gid || !nodeId) return;
  let s = sessions.value.find(x => Number(x.node_id) === Number(nodeId));
  if (!s) {
    try {
      const r = await api('/api/goals/' + gid + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId, nodes: [{ id: nodeId, withKids: false }], model: '' }) });
      s = r.session; sessions.value.unshift(s);
    } catch (e) { toast('打开节点对话失败：' + e.message); return; }
  }
  sid.value = Number(s.id);
  attached.value = parseAttached(s.nodes);
  await loadMessages();
}
onMounted(async () => {
  if (!gid) { await loadGoals(); return; }
  await Promise.all([loadGoal(), loadTutTitle()]);
  await loadSessions();
  if (nodeId) await openNodeSession();
});
</script>

<style scoped>
.chatPage { max-width: 1420px; }
.goalPick { margin-top: 8px; }
.goalPickList { display: flex; flex-direction: column; gap: 6px; }
.goalPickRow { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; background: transparent; cursor: pointer; color: var(--text); font-size: 13.5px; }
.goalPickRow:hover { background: var(--soft); }
.goalPickTitle { font-weight: 700; }
.tutBind { margin: -2px 0 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--soft); font-size: 12.5px; line-height: 1.6; }
.chatGrid { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 14px; align-items: start; }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 14px; }
.cardHead { display: flex; align-items: center; font-weight: 700; font-size: 13.5px; margin-bottom: 8px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.seg button { border: 0; background: transparent; padding: 5px 10px; font-size: 12.5px; cursor: pointer; color: var(--muted); }
.seg button.on { background: var(--accent); color: #fff; }
.sessCol { position: sticky; top: 8px; }
.sessList { display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 180px); overflow: auto; }
.sessItem { position: relative; padding: 8px 26px 8px 8px; border-radius: 8px; cursor: pointer; }
.sessItem:hover { background: var(--soft); }
.sessItem.on { background: var(--soft); outline: 1px solid var(--accent); }
.sessTitle { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessMeta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.sessDel { position: absolute; right: 4px; top: 8px; opacity: .55; }
.sessEdit { position: absolute; right: 22px; top: 8px; opacity: .55; }
.sessItem:hover .sessDel, .sessItem:hover .sessEdit { opacity: 1; }
.chatMain { display: flex; flex-direction: column; min-height: calc(100vh - 170px); }
.msgs { flex: 1; overflow: auto; max-height: calc(100vh - 310px); padding: 4px 2px; }
.emptyChat { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 70px 20px; }
.msg { display: flex; margin: 10px 0; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 86%; border-radius: 12px; padding: 10px 12px; font-size: 13.5px; line-height: 1.8; border: 1px solid var(--line); background: var(--soft); }
.msg.user .bubble { background: var(--accent); color: #fff; border-color: transparent; }
.userText { white-space: pre-wrap; }
.md :deep(p) { margin: .45em 0; }
.md :deep(pre) { overflow: auto; background: rgba(0,0,0,.16); padding: 8px; border-radius: 8px; }
.pendCard { margin-top: 10px; border: 1px solid var(--warn); border-radius: 10px; padding: 10px; background: rgba(255,180,0,.05); }
.pendHead { font-weight: 700; font-size: 13px; margin-bottom: 5px; }
.pendScope { font-size: 12.5px; line-height: 1.75; color: var(--text); }
.pendRow { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.pendTip { margin-top: 8px; font-size: 12px; line-height: 1.7; color: var(--warn); }
.ops { margin-top: 6px; font-size: 11.5px; color: var(--muted); }
.trace { margin-top: 8px; font-size: 11.5px; color: var(--muted); }
.trace summary { cursor: pointer; }
.traceItem { padding: 2px 0 2px 10px; border-left: 2px solid var(--line); margin-top: 3px; }
.attachBar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.attachLabel { font-size: 12px; color: var(--muted); }
.attachChip { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--line); border-radius: 7px; padding: 2px 5px 2px 8px; font-size: 12px; background: var(--soft); }
.attachX { border: 0; background: transparent; cursor: pointer; color: var(--muted); font-size: 13px; line-height: 1; padding: 0 2px; }
.attachX:hover { color: var(--danger); }
.attachList { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 9px; padding: 4px; }
.attachRow { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 7px; font-size: 12.5px; cursor: pointer; }
.attachRow:hover { background: var(--soft); }
.attachRow input { width: 15px; height: 15px; flex: none; }
.attachKids { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.attachTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modalMask { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 90; padding: 20px; }
.modalBox { background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: min(620px, 96vw); max-height: 90vh; overflow: auto; padding: 18px; }
.modalHead { display: flex; align-items: center; margin-bottom: 10px; }
.inputRow { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
.inputRow textarea { flex: 1; resize: vertical; min-height: 64px; }
.copy { color: var(--muted); font-size: 11px; }
</style>