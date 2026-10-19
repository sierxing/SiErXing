<template>
  <div class="jdPage exPage">
    <div class="jdHead">
      <a class="back" :href="backHash">← 返回{{ tid ? '教程' : '目标' }}</a>
      <span class="mapTitle">🔍 看懂代码</span>
      <span v-if="tutTitle" class="chip gray">{{ String(tutTitle).slice(0, 40) }}</span>
      <div class="spacer"></div>
      <span v-if="busy" class="muted" style="font-size:12px;">{{ busyMsg }}</span>
    </div>

    <template v-if="view === 'setup'">
      <div class="exIntro"><p>把你看不太懂的代码整段贴进来：AI 会把它<b>逐行讲明白</b> —— <b>左边是代码，右边是讲解</b>，点哪一行就看哪一行。<br>开讲前它会先跟你确认<b>前置知识</b>：不知道的，先带你过一遍再逐行讲。</p></div>
      <div class="exSec"><div class="exSecT">1. 要讲哪段代码</div><textarea v-model="code" class="exInput exCodeIn" spellcheck="false" placeholder="把代码整段粘进来（Ctrl+V）——从教程里复制的、报错时贴的那种都行"></textarea><div class="exHint">{{ lineCount }} 行 · 一次最多 400 行<template v-if="lineCount"> · 大约 {{ calls }} 次 AI 调用，{{ calls * 40 }} 秒上下讲完</template></div></div>
      <div class="exSec"><div class="exSecT">2. 一句说明（可选，能帮它讲得更准）</div><input v-model="note" class="exInput" placeholder="例：mcp-min-server.js 的主循环；或者：这个函数我完全看不懂"></div>
      <div class="exSec"><div class="exSecT">3. 讲解风格<span class="exSecTip">可留空。贴一段你喜欢的讲解，以后每段讲解都照它的语气、详略、排版写</span></div><textarea v-model="styleSample" class="exInput" rows="4" placeholder="贴一段你喜欢的讲解风格（可留空）…"></textarea><div class="toolbarRow" style="margin-top:6px;"><label class="btn" style="cursor:pointer;">⬆ 上传 .txt / .md<input type="file" accept=".txt,.md,text/plain,text/markdown" hidden @change="uploadStyle"></label><button class="btn" type="button" :disabled="busy" @click="saveStyle">保存风格</button><span class="muted" style="font-size:12px;">{{ styleCustom ? '当前：自定义' : '当前：默认' }}</span></div></div>
      <div class="exStart"><button class="btn primary" type="button" :disabled="busy" @click="startExplain">{{ busy ? '正在安排讲解…' : '开始讲解' }}</button><button v-if="sessions.length" class="btn" type="button" @click="view = 'list'">之前的讲解（{{ sessions.length }}）</button></div>
      <p class="hint">讲解运行界面（代码栏 + 逐行讲解）仍由旧版接管，下一步迁；本页负责贴代码、风格、记录入口。</p>
    </template>

    <template v-else-if="view === 'run' && session">
      <div class="exBar"><div class="exProg"><i :style="{ width: progressPct + '%' }"></i></div><span class="exProgTxt">{{ progressText }}</span><span class="exStat">{{ statusText }}</span><span class="spacer"></span><button v-if="canContinue" class="btn small primary" type="button" :disabled="busy" @click="continueJob">▶ 继续讲</button><button class="btn small" type="button" title="贴/上传一段你喜欢的讲解，以后的讲解都照它的风格写" @click="styleOpen = true">🎨 风格：{{ styleCustom ? '自定义' : '默认' }}</button><button class="btn small" type="button" @click="renameRun">✎ 改名</button><button class="btn small" type="button" @click="backList">☰ 讲解记录</button><button class="btn small danger" type="button" @click="delRun">删除</button></div>
      <div ref="wrapEl" class="exWrap" :style="wrapStyle" @mousedown="onWrapDown" @dblclick="onWrapDbl">
        <aside class="exSide">
          <div class="exSideHead"><span class="chip gray">{{ session.lang || '代码' }}</span><span class="exSideNote">{{ String(session.note || '').slice(0, 50) }}</span><span class="spacer"></span><span class="exSideCnt">共 {{ session.lines }} 行<template v-if="modules.length"> · {{ modules.length }} 个模块</template></span></div>
          <div v-if="preItems.length" class="exPre">
            <div class="exPreBar"><button class="exPreToggle" type="button" @click="preOpen = !preOpen">{{ preOpen ? '▾' : '▸' }} 🧩 前置知识（{{ preItems.length }}）</button><span class="exPreSum">{{ preSummary }}</span></div>
            <div v-if="preOpen" class="exPreRows"><div v-for="p in preItems" :key="p.id" class="exPreRow" :class="{ know: p.state === 'known', done: p.lesson, doing: p.state === 'unknown', on: selPre === p.id }" :title="p.why || ''" @click="selPre = p.id"><i class="exPreIco">{{ p.state === 'known' ? '✅' : (p.lesson ? '📖' : (p.state === 'unknown' ? '⏳' : '·')) }}</i><span class="exPreName">{{ p.title }}</span><span v-if="session.status === 'prereq'" class="exPreBtns" @click.stop><button class="exPreSeg" :class="{ on: !preUnknown.includes(p.id) }" type="button" @click="markPre(p.id, false)">知道</button><button class="exPreSeg" :class="{ on: preUnknown.includes(p.id) }" type="button" @click="markPre(p.id, true)">不知道</button></span></div></div>
            <div v-if="session.status === 'prereq'" class="exPreFoot"><button class="btn primary" type="button" :disabled="busy" @click="submitPre(false)">{{ preUnknown.length ? '先补 ' + preUnknown.length + ' 个，再讲代码' : '都知道了，开始讲代码' }}</button><button class="btn" type="button" :disabled="busy" @click="submitPre(true)">跳过，直接讲</button></div>
          </div>
          <div class="exCode">
            <div v-if="hasOverview" class="exLine exOv" :class="{ exOn: selLine === 0 && !selPre }" @click="selectLine(0)"><i class="exNo">📄</i><span class="exSrc">概览 · 这段代码整体在做什么</span></div>
            <div v-for="(line, i) in codeLines" :key="i" class="exLine" :class="{ exDone: coveredLines[i + 1], exOn: selLine === i + 1 && !selPre, exRng: inRange(i + 1), exRef: refLines.includes(i + 1), exModStart: moduleStarts.includes(i + 1) }" @click="selectLine(i + 1)"><i class="exNo">{{ i + 1 }}</i><span class="exSrc">{{ line }}</span></div>
          </div>
        </aside>
        <div class="exSplit"></div>
        <section class="exMain">
          <div class="exThreadHead"><div class="exThTitle">{{ threadTitle }}</div></div>
          <div class="exMsgs">
            <div v-if="selPreObj">
              <div class="exMsg ai" v-if="selPreObj.lesson"><div class="exAiHead">📖 前置知识 · {{ selPreObj.title }}</div><div class="exAiBody mdBody" v-html="md(selPreObj.lesson)"></div></div>
              <div v-else-if="selPreObj.state === 'known'" class="exMsg ai"><div class="exAiBody">这一条你标了<b>知道</b>，所以没讲。</div></div>
              <div v-else-if="selPreObj.state === 'unknown'" class="exEmpty">AI 正在给你写这一课…</div>
              <div v-else class="exEmpty">还没有开始讲这个知识点。</div>
              <div v-for="(c, i) in (selPreObj.chat || [])" :key="i"><div v-if="c.role === 'me'" class="exMsg me"><div class="exMe">{{ c.content }}</div></div><div v-else class="exMsg ai"><div class="exAiHead">💬 回答</div><div class="exAiBody mdBody" v-html="md(c.content)"></div></div></div>
            </div>
            <template v-else>
              <div v-for="(t, i) in threadMessages" :key="t.id || i" :class="t.role === 'me' ? 'exMsg me' : 'exMsg ai'"><div v-if="t.role === 'me'" class="exMe">{{ t.content }}</div><template v-else><div class="exAiHead">{{ msgTitle(t) }}</div><div class="exAiBody mdBody" v-html="md(t.content)"></div></template></div>
              <div v-if="!threadMessages.length" class="exEmpty">{{ emptyThreadText }}</div>
            </template>
          </div>
          <div class="exAsk">
            <div v-if="busy" class="exBusyWrap"><span class="spinner"></span> {{ busyMsg }}</div>
            <div v-else-if="session.status === 'prereq'" class="exPreWait">🧩 先确认上面的前置知识（点「✅ 知道」或「❓ 不知道」）—— 之后每一行都可以在这里追问。</div>
            <template v-else>
              <div class="exQuick">
                <button v-if="selPreObj && selPreObj.state === 'known' && !selPreObj.lesson" class="btn small" type="button" @click="teachPre">📖 还是讲一下这个</button>
                <button class="btn small" type="button" :disabled="!canAsk" @click="quickAsk('redo')">🔁 没看懂，换个说法</button>
                <button class="btn small" type="button" :disabled="!canAsk" @click="quickAsk('example')">🧩 举个例子</button>
                <button class="btn small" type="button" :disabled="!canAsk" @click="quickAsk('why')">❓ 为什么必须这么写</button>
              </div>
              <div class="exInputRow"><textarea v-model="askText" class="exInput exTa" rows="2" spellcheck="false" :placeholder="canAsk ? askPlaceholder : '这一行还没讲到，先点「继续讲」'"></textarea><button class="btn primary" type="button" :disabled="!canAsk || !askText.trim()" @click="doAsk(askText.trim(), 'ask')">发送</button></div>
            </template>
          </div>
        </section>
      </div>
      <div class="exSplitH" title="按住上下拖动，调整代码 / 讲解区的高度（双击恢复默认）" @mousedown="onSplitHDown" @dblclick="resetHeight"><i></i></div>
    </template>
    <template v-else-if="view === 'list'">
      <div class="exIntro"><p v-if="tid">这里只显示<b>这一份教程</b>的代码讲解记录。</p><p v-else>这是<b>整个目标</b>的讲解记录，按任务节点分组。</p></div>
      <div class="exStart"><button class="btn primary" type="button" @click="view = 'setup'">＋ 贴一段新代码</button><span class="exHint">共 {{ sessions.length }} 条记录</span></div>
      <div v-if="sessions.length" class="exList"><div v-for="s in sessions" :key="s.id" class="exItemWrap"><button class="exItem" type="button" @click="openSession(s)"><span class="exItemIco">{{ statusOf(s).ico }}</span><span class="exItemBody"><b>{{ s.title || '一段代码' }}</b><span class="exItemMeta">{{ statusOf(s).txt }} · {{ moduleMeta(s) }} · {{ fmtDate(s.updated_at) }}</span><span v-if="s.note" class="exItemNote">{{ String(s.note).slice(0, 70) }}</span></span></button><button class="btn tiny" type="button" title="改个名字" @click="renameSession(s)">✎ 改名</button><button class="btn tiny danger" type="button" title="删掉这条讲解" @click="delSession(s)">🗑</button></div></div>
      <p v-else class="muted">还没有记录。点上面的按钮贴一段代码，AI 会逐行讲明白。</p>
    </template>
    <div v-if="styleOpen" class="exMask" @click.self="styleOpen = false">
      <div class="exDialog">
        <div class="exDlgHead"><span>🎨 讲解风格示例</span><button class="btn tiny" type="button" title="关闭" @click="styleOpen = false">✕</button></div>
        <div class="exDlgBody">
          <textarea v-model="styleSample" class="exInput exStyleIn" spellcheck="false" placeholder="把你喜欢的一段讲解贴进来 —— 一对一辅导记录、收藏的博客、你自己写的都行。贴完之后，这里的每一段讲解都会照它的语气、详略和排版来写（只学风格，不抄内容）。"></textarea>
          <div class="toolbarRow" style="margin-top:8px;flex-wrap:wrap;"><label class="btn small" style="cursor:pointer;">📄 上传文件<input type="file" accept=".txt,.md,.markdown,.log,text/plain,text/markdown" hidden @change="uploadStyle"></label><button class="btn small primary" type="button" :disabled="busy" @click="saveStyle">保存风格</button><button class="btn small" type="button" :disabled="busy" @click="redoStyle">♻️ 保存并按新风格重讲这一段</button><button class="btn small" type="button" :disabled="busy" @click="resetStyle">恢复默认风格</button><span class="exHint">{{ styleCustom ? '当前：自定义风格' : '当前：默认风格' }}</span></div>
          <div class="exHint">风格示例只影响<b>之后</b>生成的讲解（已经在的讲解不会自己变）。示例写得短，讲解就跟着短。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) }, tutorialId: { type: Number, default: 0 }, goalId: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || '')) : String(s || ''); } catch (e) { return String(s || ''); } };
const NL = String.fromCharCode(10);
const tid = ref(Number(props.tutorialId) || 0);
const gid = ref(Number(props.goalId) || 0);
const tutTitle = ref('');
const sessions = ref([]);
const view = ref('setup');
const code = ref('');
const note = ref('');
const styleSample = ref('');
const styleCustom = ref(false);
const busy = ref(false);
const busyMsg = ref('');
const session = ref(null);
const turns = ref([]);
const selLine = ref(0);
const selPre = ref('');
const preOpen = ref(true);
const preUnknown = ref([]);
const askText = ref('');
const styleOpen = ref(false);
const wrapEl = ref(null);
const splitPct = ref(0);
const exHeight = ref(0);
const exW = ref(0);
let poll = null;
let dragState = null;
const fmtDate = props.host.fmtDate || (s => String(s || '').slice(0, 10));

const backHash = computed(() => tid.value ? '#/t/' + tid.value : '#/g/' + gid.value);
const lineCount = computed(() => { const s = String(code.value || '').trimEnd(); return s ? s.split(NL).length : 0; });
const calls = computed(() => lineCount.value ? Math.max(1, Math.ceil(lineCount.value / 30)) : 0);
const codeLines = computed(() => String((session.value && session.value.code) || '').split(NL));
const modules = computed(() => (session.value && session.value.modules) || []);
const hasOverview = computed(() => turns.value.some(t => t.kind === 'overview'));
const coveredLines = computed(() => { const m = {}; for (const t of turns.value) if (t.role === 'ai' && t.kind === 'explain') for (let i = Number(t.line_from); i <= Number(t.line_to); i++) m[i] = true; return m; });
const moduleStarts = computed(() => modules.value.map(m => Number(m.from)).filter(n => n > 1));
const selCover = computed(() => turns.value.find(t => t.role === 'ai' && t.kind === 'explain' && Number(t.line_from) <= selLine.value && selLine.value <= Number(t.line_to)) || null);
const inRange = n => !!(selCover.value && !selPre.value && n >= Number(selCover.value.line_from) && n <= Number(selCover.value.line_to));
const refLines = computed(() => []);
const preItems = computed(() => (session.value && session.value.prereqs) || []);
const selPreObj = computed(() => preItems.value.find(p => p.id === selPre.value) || null);
const preSummary = computed(() => { const known = preItems.value.filter(p => p.state === 'known').length; const taught = preItems.value.filter(p => p.lesson).length; const pending = preItems.value.filter(p => p.state === 'unknown' && !p.lesson).length; const bits = []; if (known) bits.push(known + ' 个知道'); if (taught) bits.push(taught + ' 个补过课'); if (pending) bits.push(pending + ' 个正在补'); return bits.join(' · '); });
const threadMessages = computed(() => { if (!session.value) return []; if (selLine.value === 0) return turns.value.filter(t => t.kind === 'overview'); return turns.value.filter(t => t.kind !== 'overview' && Number(t.line_from) <= selLine.value && selLine.value <= Number(t.line_to)); });
const threadTitle = computed(() => { if (selPreObj.value) return '🧩 ' + selPreObj.value.title + (selPreObj.value.why ? ' · ' + selPreObj.value.why : ''); if (selLine.value === 0) return '📄 概览 · 这段代码整体在做什么'; const cover = selCover.value; const from = cover ? Number(cover.line_from) : selLine.value; const to = cover ? Number(cover.line_to) : selLine.value; const mt = (cover && cover.title) || (modules.value.find(m => Number(m.from) <= from && to <= Number(m.to)) || {}).title || ''; return '第 ' + (from === to ? from : from + '-' + to) + ' 行' + (mt ? ' · ' + mt : '') + (cover ? '' : ' · 还没讲到'); });
const emptyThreadText = computed(() => { if (!session.value) return ''; if (session.value.status === 'working') return modules.value.length ? '⏳ 这一块还没讲完（AI 正在并行写 ' + modules.value.length + ' 个模块，已经讲到第 ' + Number(session.value.explained || 0) + ' 行）' : '📖 AI 正在读整段代码、划分讲解模块…'; if (session.value.status === 'done') return '这一段还没有讲解。'; return '这块还没讲到（上次停在第 ' + Number(session.value.explained || 0) + ' 行）。'; });
const canAsk = computed(() => !!selPreObj.value || (selLine.value === 0 ? hasOverview.value : !!selCover.value));
const askPlaceholder = computed(() => selPreObj.value ? '针对「' + selPreObj.value.title + '」追问…' : (selLine.value === 0 ? '针对整段代码追问…' : '针对第 ' + selLine.value + ' 行追问…'));
const modulesDone = computed(() => { if (!modules.value.length) return 0; let n = 0; for (const m of modules.value) { let ok = true; for (let i = m.from; i <= m.to; i++) if (!coveredLines.value[i]) { ok = false; break; } if (ok) n++; } return n; });
const progressPct = computed(() => modules.value.length ? Math.round(100 * modulesDone.value / modules.value.length) : (Number(session.value && session.value.lines) ? Math.round(100 * Number(session.value.explained || 0) / Number(session.value.lines)) : 0));
const progressText = computed(() => modules.value.length ? ('已讲 ' + modulesDone.value + '/' + modules.value.length + ' 个模块 · ' + Number(session.value.explained || 0) + '/' + Number(session.value.lines) + ' 行') : ('已讲 ' + Number(session.value.explained || 0) + '/' + Number(session.value.lines) + ' 行'));
const statusText = computed(() => { const s = session.value; if (!s) return ''; if (s.status === 'prereq') return '🧩 先确认上面的前置知识，再开始逐行讲'; if (s.status === 'working') return (modules.value.length ? 'AI 正在讲第 ' + Math.min(Number(s.lines), Number(s.explained || 0) + 1) + ' 行起（' + modules.value.length + ' 个模块并行在写）' : 'AI 正在读整段、划分讲解模块…'); if (s.status === 'done') return '✅ 整段讲完了'; return '⏸ ' + String(s.last_error || '停下了').slice(0, 40); });
const canContinue = computed(() => !!session.value && session.value.status !== 'working' && session.value.status !== 'prereq' && (modules.value.length ? modulesDone.value < modules.value.length : Number(session.value.explained || 0) < Number(session.value.lines)));
const wrapStyle = computed(() => { const o = {}; if (splitPct.value > 0) o['--exSide'] = splitPct.value + '%'; if (exHeight.value > 0) o['--exH'] = exHeight.value + 'px'; if (exW.value > 0) o['--exW'] = exW.value + 'px'; return o; });
function statusOf(s) {
  if (s.status === 'prereq') return { ico: '🧩', txt: '先确认前置知识' };
  if (s.status === 'done') return { ico: '✅', txt: '已讲完' };
  if (s.status === 'working') return { ico: '⏳', txt: '正在讲…' };
  if (Number(s.explained) > 0) return { ico: '⏸', txt: '停在第 ' + (Number(s.explained) + 1) + ' 行，可继续' };
  return { ico: '📄', txt: '还没开讲' };
}
function moduleMeta(s) { return Number(s.modules_n) ? '已讲 ' + Number(s.modules_done || 0) + '/' + Number(s.modules_n) + ' 个模块' : '已讲 ' + Number(s.explained) + '/' + Number(s.lines) + ' 行'; }
async function loadList() { try { sessions.value = (await api('/api/explain/sessions' + (tid.value ? '?tutorial_id=' + tid.value : '?goal_id=' + gid.value))).sessions || []; } catch (e) { sessions.value = []; } }
async function loadStyle() { try { const r = await api('/api/explain/style'); styleSample.value = r.sample || ''; styleCustom.value = !!r.sample; } catch (e) {} }
async function loadTut() { if (!tid.value) return; try { const r = await api('/api/tutorials/' + tid.value); tutTitle.value = (r.tutorial && r.tutorial.title) || ''; if (r.goal) gid.value = Number(r.goal.id || 0); } catch (e) {} }
async function load() { loadDims(); await loadStyle(); await loadTut(); await loadList(); const live = sessions.value.find(s => s.status === 'working'); if (live) { await loadSession(live.id); return; } view.value = sessions.value.length ? 'list' : 'setup'; }
function uploadStyle(ev) { const f = (ev.target.files || [])[0]; ev.target.value = ''; if (!f) return; f.text().then(t => { styleSample.value = String(t || '').slice(0, 6000); toast('已读入，点「保存风格」才生效'); }).catch(e => toast(e.message)); }
async function saveStyle() { if (busy.value) return; busy.value = true; busyMsg.value = '保存风格…'; try { const r = await api('/api/explain/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: styleSample.value }) }); styleSample.value = r.sample || ''; styleCustom.value = !!r.sample; toast('风格已保存'); } catch (e) { toast(e.message); } busy.value = false; busyMsg.value = ''; }
/* ---------- 三处拖拽边界：左右比例 / 上下高度 / 整体宽度 ---------- */
const SPLIT_HIT = 12;
function loadDims() { try { splitPct.value = Math.max(0, Math.min(78, Number(localStorage.getItem('sierxing-explain-split')) || 0)); exHeight.value = Math.max(0, Number(localStorage.getItem('sierxing-explain-height')) || 0); exW.value = Math.max(0, Number(localStorage.getItem('sierxing-explain-totalw')) || 0); } catch (e) {} }
function clearDrag() { if (!dragState) return; window.removeEventListener('mousemove', dragState.move); window.removeEventListener('mouseup', dragState.up); document.body.classList.remove('exResizing', 'exResizingV'); dragState = null; }
function bindDrag(move, up) { clearDrag(); dragState = { move, up }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
function onWrapDown(e) {
  if (e.button !== 0) return;
  const el = wrapEl.value; if (!el) return;
  const r = el.getBoundingClientRect(); if (!r.width) return;
  const nearL = Math.abs(e.clientX - r.left) <= SPLIT_HIT;
  const nearR = Math.abs(e.clientX - r.right) <= SPLIT_HIT;
  if (nearL || nearR) {
    const startX = e.clientX, startW = r.width, side = nearL ? 'L' : 'R';
    document.body.classList.add('exResizing'); e.preventDefault();
    const move = ev => { const next = Math.round(startW + (side === 'L' ? -2 : 2) * (ev.clientX - startX)); exW.value = Math.max(560, Math.min(Math.max(560, window.innerWidth - 110), next)); };
    const up = () => { clearDrag(); try { localStorage.setItem('sierxing-explain-totalw', String(exW.value)); } catch (err) {} };
    bindDrag(move, up); return;
  }
  const sp = el.querySelector('.exSplit'); const sr = sp ? sp.getBoundingClientRect() : null;
  if (sr && sr.width && Math.abs(e.clientX - (sr.left + sr.width / 2)) <= SPLIT_HIT) {
    e.preventDefault(); document.body.classList.add('exResizing');
    const move = ev => { const rr = el.getBoundingClientRect(); if (rr.width) splitPct.value = Math.max(22, Math.min(78, Math.round((ev.clientX - rr.left) / rr.width * 100))); };
    const up = () => { clearDrag(); try { localStorage.setItem('sierxing-explain-split', String(splitPct.value)); } catch (err) {} };
    bindDrag(move, up);
  }
}
function onWrapDbl(e) {
  const el = wrapEl.value; if (!el) return; const r = el.getBoundingClientRect();
  const nearEdge = Math.abs(e.clientX - r.left) <= SPLIT_HIT || Math.abs(e.clientX - r.right) <= SPLIT_HIT;
  if (nearEdge) { exW.value = 0; try { localStorage.removeItem('sierxing-explain-totalw'); } catch (err) {} return; }
  const sp = el.querySelector('.exSplit'); const sr = sp ? sp.getBoundingClientRect() : null;
  if (sr && Math.abs(e.clientX - (sr.left + sr.width / 2)) <= SPLIT_HIT) { splitPct.value = 0; try { localStorage.removeItem('sierxing-explain-split'); } catch (err) {} }
}
function onSplitHDown(e) {
  if (e.button !== 0) return;
  const el = wrapEl.value; if (!el) return;
  const startY = e.clientY, startH = el.getBoundingClientRect().height;
  e.preventDefault(); document.body.classList.add('exResizingV');
  const move = ev => { exHeight.value = Math.max(280, Math.min(window.innerHeight - 140, Math.round(startH + (ev.clientY - startY)))); };
  const up = () => { clearDrag(); try { localStorage.setItem('sierxing-explain-height', String(exHeight.value)); } catch (err) {} };
  bindDrag(move, up);
}
function resetHeight() { exHeight.value = 0; try { localStorage.removeItem('sierxing-explain-height'); } catch (e) {} }
async function redoStyle() { if (!session.value) return; if (!window.confirm('把这一条已经讲好的讲解丢掉、按新风格重讲一遍？（会重新花 AI 调用，追问记录保留）')) return; busy.value = true; try { await api('/api/explain/sessions/' + session.value.id + '/redo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); styleOpen.value = false; await refreshSession(); startPoll(); toast('开始按新风格重讲…'); } catch (e) { toast('重讲失败：' + e.message); } busy.value = false; }
async function resetStyle() { if (busy.value) return; busy.value = true; try { const r = await api('/api/explain/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: '' }) }); styleSample.value = ''; styleCustom.value = false; toast('已恢复默认风格'); } catch (e) { toast(e.message); } busy.value = false; }
async function loadSession(sid) { stopPoll(); busy.value = true; busyMsg.value = '加载这次讲解…'; try { const r = await api('/api/explain/sessions/' + sid); session.value = r.session; turns.value = r.turns || []; view.value = 'run'; selPre.value = ''; const ov = turns.value.some(t => t.kind === 'overview'); selLine.value = ov ? 0 : 1; if (session.value.status === 'working') startPoll(); } catch (e) { toast('打开失败：' + e.message); view.value = 'list'; } busy.value = false; busyMsg.value = ''; }
async function startExplain() {
  if (!String(code.value || '').trim()) return toast('先把要讲的代码贴进来');
  if (busy.value) return;
  busy.value = true; busyMsg.value = '正在安排讲解…';
  try { const r = await api('/api/explain/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid.value, tutorial_id: tid.value || 0, code: String(code.value || '').trimEnd(), note: String(note.value || '').trim() }) }); if (r.session && r.session.id) { session.value = r.session; turns.value = []; view.value = 'run'; selLine.value = 1; startPoll(); } else toast('创建讲解失败'); }
  catch (e) { toast('开始失败：' + e.message); }
  busy.value = false; busyMsg.value = '';
}
function openSession(s) { loadSession(s.id); }
function msgTitle(t) { if (t.kind === 'overview') return '📄 概览'; if (t.kind === 'answer') return '💬 回答'; const from = Number(t.line_from); const to = Number(t.line_to); return '🔍 第 ' + from + (to > from ? '-' + to : '') + ' 行' + (t.title ? ' · ' + t.title : ''); }
function selectLine(n) { selPre.value = ''; selLine.value = n; }
function markPre(id, unk) { const arr = preUnknown.value.filter(x => x !== id); if (unk) arr.push(id); preUnknown.value = arr; }
async function submitPre(skip) { if (busy.value || !session.value) return; busy.value = true; busyMsg.value = skip ? '跳过前置知识…' : '提交前置知识…'; try { const r = await api('/api/explain/sessions/' + session.value.id + '/prereqs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unknown: skip ? [] : preUnknown.value, skip }) }); if (r.session) session.value = r.session; preUnknown.value = []; startPoll(); } catch (e) { toast('提交失败：' + e.message); } busy.value = false; busyMsg.value = ''; }
function startPoll() { stopPoll(); poll = setInterval(async () => { if (!session.value || view.value !== 'run') return; try { const r = await api('/api/explain/sessions/' + session.value.id); session.value = r.session; turns.value = r.turns || []; if (session.value.status !== 'working' && session.value.status !== 'prereq') stopPoll(); } catch (e) {} }, 2600); }
function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
async function refreshSession() { try { const r = await api('/api/explain/sessions/' + session.value.id); session.value = r.session; turns.value = r.turns || []; } catch (e) {} }
async function quickAsk(kind) { const TXT = { redo: '没看懂，换个更小的说法再讲一遍', example: '举个例子', why: '为什么必须这么写？不这么写会怎样？' }; await doAsk(TXT[kind], kind); }
async function doAsk(text, kind) { if (busy.value || !session.value || !text) return; busy.value = true; busyMsg.value = 'AI 正在看这一行…'; try { if (selPre.value) { await api('/api/explain/sessions/' + session.value.id + '/prereq/' + encodeURIComponent(selPre.value) + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, kind: kind || 'ask' }) }); } else { await api('/api/explain/sessions/' + session.value.id + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: selLine.value, text, kind: kind || 'ask' }) }); } askText.value = ''; await refreshSession(); } catch (e) { toast('追问失败：' + e.message); } busy.value = false; busyMsg.value = ''; }
async function teachPre() { if (!session.value || !selPre.value) return; busy.value = true; try { await api('/api/explain/sessions/' + session.value.id + '/prereq/' + encodeURIComponent(selPre.value) + '/teach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refreshSession(); startPoll(); } catch (e) { toast(e.message); } busy.value = false; }
async function continueJob() { if (!session.value) return; busy.value = true; try { await api('/api/explain/sessions/' + session.value.id + '/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); startPoll(); } catch (e) { toast('继续失败：' + e.message); } busy.value = false; }
async function backList() { stopPoll(); await loadList(); view.value = 'list'; }
async function renameRun() { if (!session.value) return; const v = window.prompt('这段代码叫什么？（AI 起的名字，随时可改）', String(session.value.title || '')); if (v == null) return; const title = String(v).trim(); if (!title) return; try { await api('/api/explain/sessions/' + session.value.id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); session.value.title = title; } catch (e) { toast(e.message); } }
async function delRun() { if (!session.value) return; if (!window.confirm('删掉这条讲解（含所有讲解与追问）？')) return; try { await api('/api/explain/sessions/' + session.value.id, { method: 'DELETE' }); stopPoll(); await loadList(); view.value = 'list'; } catch (e) { toast(e.message); } }
async function renameSession(s) { const v = window.prompt('这段代码叫什么？（AI 起的名字，随时可改）', String(s.title || '')); if (v == null) return; const title = String(v).trim(); if (!title || title === s.title) return; try { await api('/api/explain/sessions/' + s.id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); await loadList(); toast('已改名'); } catch (e) { toast('改名失败：' + e.message); } }
async function delSession(s) { if (!window.confirm('删掉这条讲解（含所有讲解与追问）？')) return; try { await api('/api/explain/sessions/' + s.id, { method: 'DELETE' }); sessions.value = sessions.value.filter(x => Number(x.id) !== Number(s.id)); toast('已删除'); } catch (e) { toast(e.message); } }
onMounted(load);
onUnmounted(() => { stopPoll(); clearDrag(); });
</script>

<style scoped>
.exPage { max-width: 1120px; }
</style>