<template>
  <div class="jdPage ivPage">
    <div class="jdHead">
      <a class="back" :href="'#/g/' + gid">← 返回目标</a>
      <span class="mapTitle">🎤 模拟面试</span>
      <span v-if="session" class="chip rsChipConv">{{ sessName(session) }}</span>
      <span v-if="view === 'run' && session" class="chip rsChipConv">🎤 第 {{ Math.min(askedCount, maxRounds) }}/{{ maxRounds }} 问</span>
    </div>

    <div v-if="busy" class="rsBusy" style="margin-bottom:12px;">{{ busyMsg }}（已等 {{ elapsed }} 秒）</div>

    <div v-if="view === 'list'">
      <div class="rsSec"><div class="rsSecT">做过 {{ sessions.length }} 场</div>
        <div class="toolbarRow" style="margin-top:8px;"><button class="btn primary" type="button" :disabled="busy" @click="newSession">＋ 新面试</button></div>
      </div>
      <div class="rsConvs">
        <div v-for="s in sessions" :key="s.id" class="rsConv" :class="{ live: statusOf(s) === 'run' }">
          <div class="rsConvHd">
            <span class="rsConvName">{{ sessName(s) }}</span>
            <span class="rsTag" :class="statusOf(s) === 'done' ? 'ok' : statusOf(s) === 'run' ? 'act' : ''">{{ statusOf(s) === 'done' ? '已结束' : statusOf(s) === 'run' ? '面试中' : '准备中' }}</span>
            <span class="rsConvMeta">{{ Number(s.rounds) || 0 }} 轮<template v-if="Number(s.score) >= 0"> · {{ s.score }} 分</template> · {{ fmtTime(s.updated_at || s.created_at, true) }}<template v-if="s.has_jd"> · 有JD</template><template v-if="s.has_project"> · 有项目</template><template v-if="Number(s.remedied)"> · 📖补救 {{ s.remedied }} 题</template></span>
            <span class="rsConvActs">
              <button class="btn tiny primary" type="button" :disabled="busy" @click="openSession(s.id)">{{ statusOf(s) === 'run' ? '继续' : '打开' }}</button>
              <button class="btn tiny" type="button" title="重命名" @click="renameSession(s)">✏️</button>
              <button class="btn tiny" type="button" title="删除" @click="delSession(s)">🗑</button>
            </span>
          </div>
        </div>
        <p v-if="!sessions.length" class="muted">还没有面试。点上面的「新面试」开始 —— 把 JD 截图粘进去就行。</p>
      </div>
    </div>

    <div v-else-if="view === 'setup' && session">
      <div class="ivCard">
        <div class="ivCardHd"><span class="ivCardT">① 岗位 JD</span><span v-if="jdText" class="ivOk">已识别</span><span v-else class="ivNeed">还没给</span><button v-if="jdText" class="btn tiny" type="button" :disabled="busy" @click="clearJd">重贴</button></div>
        <div class="ivCardBody">
          <div v-if="jdText" class="ivJdText mdBody" v-html="md(jdText)"></div>
          <div v-else class="ivPaste" tabindex="0" @paste.prevent="onPaste" @dragover.prevent @drop.prevent="onDrop">
            <div class="ivPasteI">📋</div>
            <div><b>点这里，然后 Ctrl/⌘+V 粘贴招聘截图</b></div>
            <div class="muted">也支持直接粘贴文字；可拖入图片。截图由 AI 识别成文字，图片本身不保存。</div>
            <div class="muted">截图识别不了时，去「设置 → AI 接入 → 识图模型」换个支持看图的模型；或者直接贴文字，效果一样。</div>
          </div>
        </div>
      </div>

      <div class="ivCard">
        <div class="ivCardHd"><span class="ivCardT">② 你的项目<span class="muted">（可选，但强烈建议 —— 面试官会深挖这里）</span></span><span v-if="projectPath" class="ivOk">已读 {{ projectFiles.length }} 个文件</span></div>
        <div class="ivCardBody">
          <div class="ivPathRow"><input v-model="pathInput" class="ivInput" placeholder="项目路径，例如 /home/you/my-project 或 ~/code/app"><button class="btn" type="button" :disabled="busy" @click="readProject">{{ projectPath ? '重新读取' : '读取' }}</button></div>
          <div v-if="projectPath" class="ivDigest">
            <p v-if="digest.what" class="ivDigestWhat">{{ digest.what }}</p>
            <div v-if="(digest.stack || []).length" class="ivChips"><span v-for="x in digest.stack" :key="x" class="chip gray">{{ x }}</span></div>
            <div v-if="(digest.modules || []).length" class="ivMods"><div v-for="m in digest.modules" :key="m.name" class="ivMod"><b>{{ m.name }}</b><span>{{ m.what }}</span></div></div>
            <div v-if="(digest.highlights || []).length" class="ivBlock"><div class="ivBlockT">💡 最值得聊的点</div><ul><li v-for="x in digest.highlights" :key="x">{{ x }}</li></ul></div>
            <div v-if="(digest.risks || []).length" class="ivBlock warn"><div class="ivBlockT">⚠️ 容易被问穿的地方</div><ul><li v-for="x in digest.risks" :key="x">{{ x }}</li></ul></div>
          </div>
          <p v-else class="muted" style="margin:8px 0 0;">只读读取：.env / 密钥 / node_modules 一律不读，路径不会离开这台机器。</p>
        </div>
      </div>

      <div class="ivCard">
        <div class="ivCardHd"><span class="ivCardT">③ 开始</span><label class="ivMax">问几轮 <input v-model.number="maxRounds" type="number" min="3" max="15"></label></div>
        <div class="ivCardBody">
          <template v-if="plan.length">
            <div class="ivPlanBox"><div class="ivBlockT">这次要覆盖的考点</div><div class="rsDimsRow"><span v-for="p in plan" :key="p.key || p.name" class="rsDim" :title="p.why || ''">{{ p.name }}</span></div><p v-if="session.focus" class="muted" style="margin:8px 0 0;">{{ session.focus }}</p></div>
            <div class="toolbarRow"><button class="btn primary" type="button" :disabled="busy" @click="startInterview">开始面试 →</button><button class="btn" type="button" :disabled="busy" @click="makePlan">重列考点</button></div>
          </template>
          <template v-else>
            <div class="toolbarRow"><button class="btn primary" type="button" :disabled="busy" @click="makePlan">定考点</button><span class="muted">AI 会根据 JD 和项目列出这次面试要问什么</span></div>
          </template>
        </div>
      </div>
      <div class="toolbarRow"><button class="btn" type="button" @click="view = 'list'">历史面试（{{ sessions.length }}）</button></div>
    </div>

    <div v-else-if="view === 'run' && session" class="ivRunPage">
      <div class="ivPanes">
        <aside class="ivPaneQ">
          <div class="rsPaneT">🧭 进度</div>
          <div class="ivPaneBody">
            <div v-if="plan.length" class="rsDims"><div class="rsDimsHd"><span>考点清单</span><span class="rsSub">{{ covered.length }}/{{ plan.length }} 问过</span></div><div class="rsDimsRow"><span v-for="p in plan" :key="p.key || p.name" class="rsDim" :class="{ on: covered.includes(p.key) }" :title="p.why || ''">{{ covered.includes(p.key) ? '✓ ' : '' }}{{ p.name }}</span></div></div>
            <p v-if="session.focus" class="ivFocus">{{ session.focus }}</p>
            <details v-if="String(digest.what || '').trim()" class="ivDigestFold"><summary>📦 你的项目（面试官已读过）</summary><p>{{ digest.what }}</p><ul v-if="(digest.highlights || []).length"><li v-for="x in digest.highlights" :key="x">{{ x }}</li></ul><div v-if="(digest.risks || []).length" class="ivBlock warn"><div class="ivBlockT">⚠️ 容易被问穿</div><ul><li v-for="x in digest.risks" :key="x">{{ x }}</li></ul></div></details>
          </div>
          <div class="rsNav"><button class="btn tiny" type="button" :disabled="busy || !answeredCount" @click="makeReport">📊 给总评</button><button class="btn tiny" type="button" :disabled="busy" @click="view = 'setup'">⚙ 设置</button></div>
          <div class="rsNavFoot"><button class="rsLink" type="button" @click="view = 'list'">← 历史面试（{{ sessions.length }}）</button></div>
        </aside>
        <section class="ivPaneC">
          <div class="rsThread">
            <div v-if="!turns.length" class="rsEmpty">面试还没开始</div>
            <template v-for="(t, idx) in turns" :key="t.id || idx">
              <div v-if="t.role === 'answer'" class="rsTurn">
                <div class="rsSay"><span class="rsWho">我</span><div class="rsBubble">{{ t.text }}</div></div>
                <div v-if="hasVerdict(t)" class="ivFb">
                  <div v-if="verdictOf(t).note" class="ivFbNote">{{ verdictOf(t).note }}</div>
                  <div class="ivFbRow">
                    <span v-if="Number(verdictOf(t).score) >= 0" class="pfChip risk" :class="Number(verdictOf(t).score) >= 80 ? 'low' : Number(verdictOf(t).score) >= 60 ? 'mid' : 'high'">{{ verdictOf(t).score }} 分</span>
                    <span v-if="verdictOf(t).level" class="rsTag">{{ verdictOf(t).level }}</span>
                    <span v-for="x in (verdictOf(t).good || [])" :key="'g' + x" class="pfChip hit">✓ {{ x }}</span>
                    <span v-for="x in (verdictOf(t).missing || [])" :key="'m' + x" class="pfChip miss">缺 {{ x }}</span>
                  </div>
                  <div v-if="(verdictOf(t).wrong || []).length" class="ivFbWrong"><div v-for="(w, i) in verdictOf(t).wrong" :key="i"><b>你说的</b>{{ w.said || '—' }} <b>→ 正确</b>{{ w.right || '—' }}</div></div>
                </div>
              </div>
              <div v-else-if="t.role === 'explain'" class="rsTurn ivExplainTurn">
                <div class="rsTurnHd"><span class="rsTurnTag explain">📖 现场讲解</span><span class="rsTurnTime">{{ fmtTime(t.created_at) }}</span></div>
                <div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody ivExplainBubble" v-html="md(t.text)"></div></div>
                <div v-if="isLast(t) && !busy" class="ivExplainActs"><button class="btn tiny" type="button" @click="retryAsk">🔁 换个问法再问一遍</button><span class="muted">或者直接用刚讲的思路，在下面回答这道题</span></div>
              </div>
              <div v-else class="rsTurn">
                <div class="rsTurnHd"><span class="rsTurnTag ai">面试官</span><span class="rsTurnTime">{{ fmtTime(t.created_at) }}</span><button v-if="canExplain && lastAsk && Number(t.id) === Number(lastAsk.id)" class="ivAskWhy" type="button" :disabled="busy" @click="explainAsk(t.id)">🤔 不会，讲一下</button></div>
                <div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody" v-html="md(t.text)"></div></div>
              </div>
            </template>
          </div>
          <div class="rsInput">
            <textarea v-model="sayText" rows="3" :placeholder="lastTurn && lastTurn.role === 'explain' ? '用刚讲的思路回答这道题（也可以点上面「换个问法再问一遍」）' : '像真的面试一样回答（Ctrl/⌘+Enter 发送）。也可以反问面试官。'" :disabled="!waiting || busy" @keydown.meta.enter.prevent="sendAnswer" @keydown.ctrl.enter.prevent="sendAnswer"></textarea>
            <div class="rsInputBtns"><button class="btn primary" type="button" :disabled="!waiting || busy" @click="sendAnswer">{{ busy ? '面试官在听…' : (waiting ? '回答' : '等面试官提问…') }}</button><span class="muted">{{ waiting ? '答完它当场点评，再问下一题' : '' }}</span></div>
          </div>
        </section>
      </div>
    </div>

    <div v-else-if="view === 'done' && session" class="ivReportPage">
      <div class="rsSec">
        <div class="ivScoreTop">
          <div class="ivScoreBig" :class="report.score >= 80 ? 'good' : report.score >= 60 ? 'mid' : 'bad'">{{ report.score >= 0 ? report.score : '—' }}<span>分</span></div>
          <div><div class="ivScoreLv">{{ report.level || '' }}</div><div v-if="report.verdict" class="ivScoreVd">{{ report.verdict }}</div></div>
        </div>
        <p v-if="report.summary" class="ivSummary">{{ report.summary }}</p>
      </div>
      <div v-if="(report.strengths || []).length" class="rsSec"><div class="rsSecT">✅ 长处</div><div class="ivChips"><span v-for="x in report.strengths" :key="x" class="pfChip hit">{{ x }}</span></div></div>
      <div v-if="(report.weak || []).length" class="rsSec"><div class="rsSecT">⚠️ 最该补的</div><div class="ivWeak"><div v-for="(x, i) in report.weak" :key="i" class="ivWeakI"><b>{{ i + 1 }}</b><span>{{ x }}</span></div></div></div>
      <div v-if="(report.advice || []).length" class="rsSec"><div class="rsSecT">🧭 下一步怎么补</div><ul class="ivAdvice"><li v-for="x in report.advice" :key="x">{{ x }}</li></ul></div>
      <div v-if="remedied.length" class="rsSec"><div class="rsSecT">📖 现场补救过的（{{ remedied.length }} 题）</div><p class="muted" style="margin:0 0 8px;">这几道当场说不会、靠讲解才接住的 —— 不算真会，建议隔天自己再答一遍。</p><div class="ivWeak"><div v-for="(x, i) in remedied" :key="i" class="ivWeakI"><b>{{ i + 1 }}</b><span>{{ x.asked || '（题目）' }}</span></div></div></div>
      <div class="rsSec"><div class="rsSecT">整场问答（{{ askedCount }} 问）</div><div class="rsThread"><template v-for="(t, idx) in turns" :key="t.id || idx"><div v-if="t.role === 'answer'" class="rsTurn"><div class="rsSay"><span class="rsWho">我</span><div class="rsBubble">{{ t.text }}</div></div></div><div v-else-if="t.role === 'explain'" class="rsTurn"><div class="rsTurnHd"><span class="rsTurnTag explain">📖 现场讲解</span></div><div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody" v-html="md(t.text)"></div></div></div><div v-else class="rsTurn"><div class="rsTurnHd"><span class="rsTurnTag ai">面试官</span></div><div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody" v-html="md(t.text)"></div></div></div></template></div></div>
      <div class="toolbarRow"><button class="btn primary" type="button" :disabled="busy" @click="newSession">再来一场</button><button class="btn" type="button" @click="view = 'list'">历史面试（{{ sessions.length }}）</button><button class="btn" type="button" @click="view = 'setup'">回到设置</button></div>
    </div>

    <p v-else-if="!busy" class="muted">还没有面试。点上方「新面试」开始。</p>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({
  host: { type: Object, default: () => ({}) },
  goalId: { type: Number, default: 0 }
});
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || '')) : String(s || ''); } catch (e) { return String(s || ''); } };
const gid = Number(props.goalId) || 0;

const sessions = ref([]);
const session = ref(null);
const turns = ref([]);
const view = ref('list');
const busy = ref(false);
const busyMsg = ref('');
const elapsed = ref(0);
const sayText = ref('');
const pathInput = ref('');
const maxRounds = ref(8);
let timer = null;

const listOf = v => { if (Array.isArray(v)) return v; try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const objOf = v => { if (v && typeof v === 'object') return v; try { const o = JSON.parse(String(v || '{}')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } };
const jdText = computed(() => String((session.value && session.value.jd_text) || '').trim());
const projectPath = computed(() => String((session.value && session.value.project_path) || '').trim());
const projectFiles = computed(() => listOf(session.value && session.value.project_files));
const digest = computed(() => objOf(session.value && session.value.project_digest));
const plan = computed(() => listOf(session.value && session.value.plan));
const covered = computed(() => listOf(session.value && session.value.covered));
const report = computed(() => objOf(session.value && session.value.report));
const remedied = computed(() => Array.isArray(session.value && session.value.remedied) ? session.value.remedied : listOf(session.value && session.value.remedied));
const askedCount = computed(() => turns.value.filter(t => t.role === 'ask').length);
const answeredCount = computed(() => turns.value.filter(t => t.role === 'answer').length);
const lastTurn = computed(() => turns.value.length ? turns.value[turns.value.length - 1] : null);
const waiting = computed(() => !!lastTurn.value && (lastTurn.value.role === 'ask' || lastTurn.value.role === 'explain'));
const lastAsk = computed(() => { for (let i = turns.value.length - 1; i >= 0; i--) if (turns.value[i].role === 'ask') return turns.value[i]; return null; });
const canExplain = computed(() => !!lastAsk.value && waiting.value && lastTurn.value && lastTurn.value.role === 'ask' && !busy.value);

function statusOf(s) {
  if (!s) return 'setup';
  if (s.status === 'done' || (s.report && Number(s.report.score) >= 0)) return 'done';
  if (Number(s.rounds) > 0 || s.status === 'running') return 'run';
  return 'setup';
}
function sessName(s) { return String((s && s.title) || '').trim() || (fmtTime(s && s.created_at, true) || '未命名面试'); }
function fmtTime(iso, withDate) {
  const d = new Date(String(iso || ''));
  if (isNaN(d.getTime())) return '';
  const p2 = n => String(n).padStart(2, '0');
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (!withDate) return hm;
  const t = new Date();
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()) return '今天 ' + hm;
  return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
}
function isLast(t) { return turns.value.length && turns.value[turns.value.length - 1] === t; }
function verdictOf(t) { return objOf(t.verdict); }
function hasVerdict(t) { const v = verdictOf(t); return Number(v.score) >= 0 || (v.good || []).length || (v.missing || []).length || (v.wrong || []).length || !!v.note; }
function beginBusy(msg) { busy.value = true; busyMsg.value = msg || ''; elapsed.value = 0; if (timer) clearInterval(timer); timer = setInterval(() => { elapsed.value++; }, 1000); }
function endBusy() { busy.value = false; if (timer) { clearInterval(timer); timer = null; } }

async function reload() { try { sessions.value = (await api('/api/interviews?goal_id=' + gid)).sessions || []; } catch (e) { sessions.value = []; } }
async function openSession(id) {
  beginBusy('加载…');
  try {
    const r = await api('/api/interviews/' + id);
    session.value = r.session; turns.value = r.turns || [];
    const st = statusOf(r.session);
    view.value = st;
    maxRounds.value = Number(r.session.max_rounds) || 8;
    pathInput.value = String(r.session.project_path || '');
  } catch (e) { toast(e.message); }
  endBusy();
}
async function newSession() {
  beginBusy('正在新建…');
  try {
    const r = await api('/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: gid, max_rounds: 8 }) });
    session.value = r.session; turns.value = []; view.value = 'setup'; maxRounds.value = 8; pathInput.value = '';
    await reload();
  } catch (e) { toast(e.message); }
  endBusy();
}
async function renameSession(s) {
  const v = window.prompt('给这场面试起个名字（留空 = 用时间当名字）', String(s.title || ''));
  if (v === null) return;
  try { await api('/api/interviews/' + s.id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v }) }); await reload(); if (session.value && Number(session.value.id) === Number(s.id)) session.value.title = String(v || '').trim(); }
  catch (e) { toast(e.message); }
}
async function delSession(s) {
  if (!window.confirm('删掉这场面试？\n\n「' + sessName(s) + '」' + (Number(s.rounds) ? '（' + s.rounds + ' 轮问答）' : '') + '\n删了就找不回来了。')) return;
  try { await api('/api/interviews/' + s.id, { method: 'DELETE' }); if (session.value && Number(session.value.id) === Number(s.id)) session.value = null; await reload(); view.value = sessions.value.length ? 'list' : 'list'; toast('已删除'); }
  catch (e) { toast(e.message); }
}
async function runAct(msg, fn) {
  if (busy.value) return;
  beginBusy(msg);
  try { await fn(); await reload(); } catch (e) { toast(e.message); }
  endBusy();
}
async function clearJd() { await runAct('正在清空 JD…', async () => { const r = await api('/api/interviews/' + session.value.id + '/jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }); session.value = r.session; turns.value = r.turns || []; }); }
async function makePlan() { await runAct('AI 正在定考点…', async () => { const r = await api('/api/interviews/' + session.value.id + '/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); session.value = r.session; turns.value = r.turns || []; }); }
async function readProject() {
  const p = String(pathInput.value || '').trim();
  if (!p) return toast('先填项目路径');
  await runAct('AI 正在读这个项目（几十秒）…', async () => {
    const r = await api('/api/interviews/' + session.value.id + '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    session.value = r.session; turns.value = r.turns || [];
    toast('读完了：' + (r.read || 0) + ' 个文件');
  });
}
async function startInterview() {
  await runAct('面试官正在问第一个问题…', async () => {
    const r = await api('/api/interviews/' + session.value.id + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_rounds: Number(maxRounds.value) || 8 }) });
    session.value = r.session; turns.value = r.turns || []; view.value = 'run';
  });
}
async function sendAnswer() {
  const text = String(sayText.value || '').trim();
  if (!text) return toast('先写下你的回答');
  if (busy.value) return;
  turns.value.push({ id: 0, role: 'answer', text, verdict: '{}', created_at: new Date().toISOString() });
  sayText.value = '';
  beginBusy('面试官正在听，然后点评并追问…');
  try {
    const r = await api('/api/interviews/' + session.value.id + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    session.value = r.session; turns.value = r.turns || [];
    if (r.done) toast('问完了 —— 点「给总评」看整场评价');
    await reload();
  } catch (e) { toast(e.message); turns.value = turns.value.filter(t => t.id !== 0); }
  endBusy();
}
async function explainAsk(id) { await runAct('面试官切到教学，正在把这道题讲明白…', async () => { const r = await api('/api/interviews/' + session.value.id + '/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: id }) }); session.value = r.session; turns.value = r.turns || []; }); }
async function retryAsk() { await runAct('正在换个问法…', async () => { const r = await api('/api/interviews/' + session.value.id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); session.value = r.session; turns.value = r.turns || []; }); }
async function makeReport() { await runAct('面试官正在写总评…', async () => { const r = await api('/api/interviews/' + session.value.id + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); session.value = r.session; turns.value = r.turns || []; view.value = 'done'; }); }

function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = rej; r.readAsDataURL(file); }); }
async function fileToDataURL(file) {
  if (file.size < 1.2 * 1024 * 1024) return readAsDataURL(file);
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch (e) { return readAsDataURL(file); }
}
async function sendJdImages(files) {
  const arr = [];
  for (const f of files.slice(0, 4)) { try { arr.push(await fileToDataURL(f)); } catch (e) {} }
  if (!arr.length) return toast('图片读不出来，换一张试试');
  await runAct('AI 正在识别 JD 截图（' + arr.length + ' 张）…', async () => {
    const r = await api('/api/interviews/' + session.value.id + '/jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: arr }) });
    session.value = r.session; turns.value = r.turns || [];
  });
}
async function sendJdText(text) {
  await runAct('正在保存 JD…', async () => {
    const r = await api('/api/interviews/' + session.value.id + '/jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    session.value = r.session; turns.value = r.turns || [];
  });
}
function onPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const files = [];
  for (const it of items) if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
  if (files.length) { sendJdImages(files); return; }
  const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
  if (t.trim()) sendJdText(t); else toast('剪贴板里没有图片或文字');
}
function onDrop(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^image\//.test(f.type));
  if (files.length) sendJdImages(files); else toast('请拖入图片文件');
}

onMounted(async () => {
  await reload();
  const live = sessions.value.find(s => statusOf(s) === 'run') || sessions.value[0] || null;
  if (live) { try { await openSession(live.id); } catch (e) { session.value = null; view.value = 'list'; } }
  else view.value = 'list';
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.ivPage { max-width: 1200px; }
</style>
