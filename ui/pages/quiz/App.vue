<template>
  <div class="jdPage quizPage">
    <div class="jdHead">
      <a class="back" :href="'#/t/' + tid">← 返回教程</a>
      <span class="mapTitle">📝 随堂测验</span>
      <span class="chip gray">一次一题 · 无计时</span>
    </div>

    <div v-if="view === 'setup'" class="quizSetup">
      <div class="quizSec">
        <div class="quizSecT">一、知识点大纲（可取消勾选跳过）</div>
        <div v-if="outline.length" class="quizTree">
          <label v-for="(p, i) in outline" :key="i" class="quizPt">
            <input type="checkbox" :checked="!skipped.includes(i)" @change="toggleSkip(i)">
            <span class="quizPtDot">{{ i + 1 }}</span>
            <span class="quizPtBody"><b>{{ p.title }}</b><span>{{ p.summary || '' }}</span></span>
          </label>
        </div>
        <p v-else class="muted">还没提炼大纲，点下面按钮让 AI 从教程里提（约半分钟）。</p>
      </div>
      <div class="quizSec">
        <div class="quizSecT">二、考察题型（可多选，出题时轮换）</div>
        <div class="ppCats"><button v-for="q in QTYPES" :key="q.v" type="button" class="ppCat" :class="{ active: qtypes.includes(q.v) }" @click="toggleQtype(q.v)">{{ q.label }}</button></div>
      </div>
      <div class="toolbarRow">
        <button v-if="!outline.length" class="btn primary" type="button" :disabled="busy" @click="makeOutline">{{ busy ? '提炼中…' : '提炼大纲' }}</button>
        <button v-if="outline.length" class="btn primary" type="button" :disabled="busy" @click="startSession">开始考察</button>
        <button v-if="session" class="btn" type="button" @click="resume">继续上次（{{ answeredCount }} 题已答）</button>
      </div>
      <p class="hint">一次只出一题，答完立刻讲；答错可以追问、再来一道，全程你说了算，没有倒计时。</p>
    </div>

    <div v-else-if="view === 'card'" class="quizCardWrap">
      <div class="quizDots"><span v-for="p in livePoints" :key="p.i" class="quizDot" :class="{ cur: p.i === curPoint, ok: pointMark(p.i) === 'done', bad: pointMark(p.i) === 'weak', fix: pointMark(p.i) === 'fixed' }" :title="p.title + '（' + MARK_TXT[pointMark(p.i)] + '）'" @click="gotoPoint(p.i)"></span></div>
      <div class="quizCard">
        <div class="quizCardTop">
          <span class="chip">{{ curRec ? qtypeLabel(curRec.qtype) : '出题中' }}</span>
          <span class="quizPtName">知识点 {{ curPoint + 1 }}/{{ outline.length }}：{{ (outline[curPoint] || {}).title }}</span>
          <span class="chip" :class="pointMark(curPoint) === 'done' ? 'ok' : pointMark(curPoint) === 'weak' ? 'danger' : ''">{{ MARK_TXT[pointMark(curPoint)] }}</span>
        </div>
        <div class="quizQBody">
          <p v-if="asking" class="muted">正在出题…</p>
          <p v-else-if="askError" class="muted">出题失败：{{ askError }} <button class="btn tiny" type="button" @click="askQuestion(curPoint)">重试</button></p>
          <template v-else-if="curRec">
            <div class="quizQ mdBody" v-html="md(curRec.question)"></div>
            <div v-if="curRec.qtype === 'single'" class="quizOpts">
              <button v-for="o in curOptions" :key="o.v" class="quizOpt" :class="optionClass(o.v)" :disabled="!!curRec.user_text" type="button" @click="submitAnswer(o.v)"><b>{{ o.v }}</b> {{ o.label }}</button>
            </div>
            <div v-else-if="curRec.qtype === 'judge'" class="quizOpts">
              <button v-for="v in ['对', '错']" :key="v" class="quizOpt" :class="optionClass(v)" :disabled="!!curRec.user_text" type="button" @click="submitAnswer(v)">{{ v }}</button>
            </div>
            <div v-else>
              <div v-if="curRec.user_text" class="quizMine">你的作答：{{ curRec.user_text }}</div>
              <textarea v-else v-model="textAnswer" rows="3" placeholder="写下你的理解，一两句话就行…" @keydown.ctrl.enter="submitAnswer(textAnswer)"></textarea>
            </div>
          </template>
        </div>
        <div v-if="curRec && !curRec.user_text" class="toolbarRow" style="margin-top:10px;">
          <button v-if="curRec.qtype === 'text'" class="btn primary" type="button" :disabled="busy" @click="submitAnswer(textAnswer)">提交答案</button>
        </div>
        <div v-if="curRec && curRec.user_text" class="quizFbWrap">
          <div class="quizFb mdBody" :class="curRec.correct ? 'ok' : 'bad'"><template v-if="curRec.correct">✓ 答对了</template><template v-else>✗ 还差一点</template><template v-if="curRec.explain"><br><span v-html="md(curRec.explain)"></span></template></div>
          <div class="toolbarRow" style="margin-top:10px;">
            <template v-if="curRec.correct"><button class="btn primary" type="button" @click="nextPoint">✅ 掌握了，下一个</button><button class="btn" type="button" @click="again">🔁 再来一道</button></template>
            <template v-else><button class="btn primary" type="button" @click="again">🔁 再来一道（同知识点）</button><button class="btn" type="button" @click="nextPoint">下一个知识点 →</button></template>
          </div>
          <p v-if="!curRec.correct && tries >= 3" class="hint">已经练了 {{ tries }} 道啦，要不要先回教程重看这一节？继续练也可以，听你的。</p>
        </div>
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn" type="button" @click="prevPoint">← 上一个点</button>
        <button class="btn" type="button" @click="nextPoint">下一个点 →</button>
        <div class="spacer"></div>
        <button class="btn" type="button" @click="view = 'report'">看报告</button>
        <button class="btn danger" type="button" @click="finishRound">结束本轮</button>
      </div>
      <p class="quizAskHint">💬 这个点有疑问？点右下角 <b>AI 助手</b> 直接问 —— 它读得到这一页的题目、选项和你的作答，不用再把题目贴一遍。</p>
    </div>

    <div v-else class="quizReport">
      <div class="quizScore">掌握 {{ reportDone }}/{{ reportRows.length }} 个知识点<template v-if="reportRows.length">（{{ Math.round(reportDone / reportRows.length * 100) }}%）</template></div>
      <div class="quizRepList">
        <div v-for="r in reportRows" :key="r.i" class="quizRepRow" :class="r.mk">
          <span class="quizDot" :class="{ ok: r.mk === 'done', bad: r.mk === 'weak', fix: r.mk === 'fixed' }"></span>
          <span class="quizRepName">{{ r.title }}<span class="muted">（练过 {{ r.n }} 道）</span></span>
          <span class="chip" :class="r.mk === 'done' || r.mk === 'fixed' ? 'ok' : r.mk === 'weak' ? 'danger' : ''">{{ MARK_TXT[r.mk] }}</span>
          <button class="btn tiny" type="button" @click="retryPoint(r.i)">练这个点</button>
        </div>
      </div>
      <div class="toolbarRow" style="margin-top:14px;">
        <button class="btn" type="button" @click="view = 'setup'">← 回大纲重选</button>
        <button v-if="hasWeak" class="btn primary" type="button" :disabled="busy" @click="weakRound">薄弱点再练一轮</button>
        <div class="spacer"></div>
        <a class="btn" :href="'#/t/' + tid">回教程重看</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({
  host: { type: Object, default: () => ({}) },
  tid: { type: Number, default: 0 }
});
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || '')) : String(s || ''); } catch (e) { return String(s || ''); } };
const tid = ref(Number(props.tid) || 0);

const QTYPES = [{ v: 'single', label: '单选' }, { v: 'judge', label: '判断' }, { v: 'text', label: '简答' }];
const QTN = { single: '单选', judge: '判断', text: '简答' };
const MARK_TXT = { todo: '未练', done: '已掌握', fixed: '已补上', weak: '薄弱' };

const book = ref(null);
const outline = ref([]);
const session = ref(null);
const records = ref([]);
const view = ref('setup');
const curPoint = ref(0);
const curRec = ref(null);
const busy = ref(false);
const asking = ref(false);
const askError = ref('');
const textAnswer = ref('');
const skipped = ref([]);
const qtypes = ref(QTYPES.map(q => q.v));

const livePoints = computed(() => {
  const sk = session.value ? safeArr(session.value.skip_idx) : [];
  return outline.value.map((p, i) => Object.assign({}, p, { i })).filter(p => !sk.includes(p.i));
});
const answeredCount = computed(() => records.value.filter(r => r.user_text).length);
const curOptions = computed(() => curRec.value ? (safeArr(curRec.value.options) || []) : []);
const tries = computed(() => curRec.value ? records.value.filter(r => r.kind === 'qa' && Number(r.point_idx) === Number(curRec.value.point_idx) && r.user_text).length : 0);
const reportRows = computed(() => livePoints.value.map(p => ({ ...p, mk: pointMark(p.i), n: records.value.filter(r => r.kind === 'qa' && Number(r.point_idx) === Number(p.i) && r.user_text).length })));
const reportDone = computed(() => reportRows.value.filter(r => r.mk === 'done' || r.mk === 'fixed').length);
const hasWeak = computed(() => reportRows.value.some(r => r.mk === 'weak'));

function safeArr(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function pointStats() {
  const st = {};
  for (const r of records.value) {
    if (r.kind !== 'qa' || !r.user_text) continue;
    const s = st[r.point_idx] || (st[r.point_idx] = { ok: 0, bad: 0 });
    if (r.correct) s.ok++; else s.bad++;
  }
  return st;
}
function pointMark(pi) {
  const s = pointStats()[pi];
  if (!s) return 'todo';
  if (s.ok > 0 && s.bad === 0) return 'done';
  if (s.ok > 0) return 'fixed';
  return 'weak';
}
function qtypeLabel(v) { return QTN[v] || ''; }
function optionClass(v) {
  if (!curRec.value || !curRec.value.user_text) return '';
  if (v === curRec.value.answer) return 'right';
  if (v === curRec.value.user_text) return 'wrong';
  return '';
}
function toggleSkip(i) { skipped.value = skipped.value.includes(i) ? skipped.value.filter(x => x !== i) : skipped.value.concat(i); }
function toggleQtype(v) { qtypes.value = qtypes.value.includes(v) ? qtypes.value.filter(x => x !== v) : qtypes.value.concat(v); }
function firstLive(from) {
  const sk = session.value ? safeArr(session.value.skip_idx) : [];
  for (let i = from; i < outline.value.length; i++) if (!sk.includes(i)) return i;
  for (let i = 0; i < from; i++) if (!sk.includes(i)) return i;
  return 0;
}
function stepPoint(dir) {
  const sk = session.value ? safeArr(session.value.skip_idx) : [];
  let i = curPoint.value;
  for (let k = 0; k < outline.value.length; k++) {
    i = (i + dir + outline.value.length) % outline.value.length;
    if (!sk.includes(i)) { curPoint.value = i; return true; }
  }
  return false;
}
async function load() {
  try { outline.value = (await api('/api/tutorials/' + tid.value + '/quiz/outline')).outline || []; } catch (e) { outline.value = []; }
  try {
    const s = await api('/api/tutorials/' + tid.value + '/quiz/session');
    session.value = s.session || null;
    records.value = s.records || [];
    if (session.value) { qtypes.value = safeArr(session.value.qtypes); if (!qtypes.value.length) qtypes.value = QTYPES.map(q => q.v); skipped.value = safeArr(session.value.skip_idx); }
  } catch (e) { session.value = null; records.value = []; }
  if (session.value && records.value.length) {
    curPoint.value = Math.min(session.value.point_idx || 0, Math.max(0, outline.value.length - 1));
    view.value = 'report';
  } else {
    view.value = 'setup';
  }
}
async function makeOutline() {
  if (busy.value) return toast('正在提炼，请稍候…');
  busy.value = true;
  try {
    const r = await api('/api/tutorials/' + tid.value + '/quiz/outline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    outline.value = r.outline || [];
    toast('大纲已提炼（' + outline.value.length + ' 个知识点）');
  } catch (e) { toast(e.message); }
  busy.value = false;
}
async function startSession() {
  if (!qtypes.value.length) return toast('至少选一种题型');
  const sk = outline.value.map((p, i) => skipped.value.includes(i) ? i : -1).filter(x => x >= 0);
  if (sk.length >= outline.value.length) return toast('全跳过就没得考了，至少留一个');
  busy.value = true;
  try {
    const r = await api('/api/tutorials/' + tid.value + '/quiz/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qtypes: qtypes.value, skip: sk }) });
    session.value = r.session; records.value = [];
    curPoint.value = firstLive(0); curRec.value = null; textAnswer.value = '';
    view.value = 'card';
    await askQuestion(curPoint.value);
  } catch (e) { toast(e.message); }
  busy.value = false;
}
async function resume() {
  view.value = 'card';
  curPoint.value = Math.min(session.value.point_idx || 0, Math.max(0, outline.value.length - 1));
  curRec.value = null;
  await askQuestion(curPoint.value);
}
async function movePoint() {
  try { const r = await api('/api/quiz-session/' + session.value.id + '/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: curPoint.value }) }); session.value = r.session; } catch (e) {}
}
async function askQuestion(pi, qtype) {
  if (asking.value) return;
  asking.value = true; askError.value = ''; curRec.value = null;
  try {
    const r = await api('/api/quiz-session/' + session.value.id + '/question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: pi, qtype: qtype || undefined }) });
    curRec.value = r.record || null;
  } catch (e) { askError.value = e.message; }
  asking.value = false;
}
async function submitAnswer(text) {
  if (!text) return toast('先写下你的答案');
  if (busy.value || !curRec.value) return;
  busy.value = true;
  try {
    const isText = curRec.value.qtype === 'text';
    const r = await api('/api/quiz-records/' + curRec.value.id + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isText ? { text } : { choice: text }) });
    const i = records.value.findIndex(x => x.id === r.record.id);
    if (i < 0) records.value.push(r.record); else records.value[i] = r.record;
    curRec.value = r.record;
    textAnswer.value = '';
  } catch (e) { toast(e.message); }
  busy.value = false;
}
function again() { curRec.value = null; askQuestion(curPoint.value); }
async function gotoPoint(i) { curPoint.value = Number(i); curRec.value = null; await movePoint(); await askQuestion(curPoint.value); }
async function nextPoint() {
  if (stepPoint(1)) { curRec.value = null; await movePoint(); await askQuestion(curPoint.value); }
  else { view.value = 'report'; }
}
async function prevPoint() {
  if (stepPoint(-1)) { curRec.value = null; await movePoint(); await askQuestion(curPoint.value); }
}
async function finishRound() {
  if (!window.confirm('结束本轮考察，去看报告？（答题记录保留，可随时再开一轮）')) return;
  try { await api('/api/quiz-session/' + session.value.id + '/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
  view.value = 'report';
}
/* ⚠️ 这里原来有「对这个点有疑问？直接问 AI」的输入框 + `POST /api/quiz-session/:id/chat`。
   已删除：每个组件各写一套 AI 问答，效果一定参差不齐（一百个组件 = 一百份提示词）。
   现在统一用常驻的 AI 助手 —— 它能读到当前页面的题目/选项/作答。 */
async function retryPoint(i) { curPoint.value = Number(i); curRec.value = null; view.value = 'card'; await movePoint(); await askQuestion(curPoint.value); }
async function weakRound() {
  busy.value = true;
  try {
    const r = await api('/api/tutorials/' + tid.value + '/quiz/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      qtypes: safeArr(session.value.qtypes),
      skip: outline.value.map((p, i) => i).filter(i => pointMark(i) !== 'weak')
    }) });
    session.value = r.session; records.value = [];
    curPoint.value = firstLive(0); curRec.value = null; view.value = 'card';
    await askQuestion(curPoint.value);
  } catch (e) { toast(e.message); }
  busy.value = false;
}
onMounted(load);
</script>

<style scoped>
.quizSetup { max-width: 920px; }
</style>
