<template>
  <div class="jdPage rsPage">
    <div class="jdHead">
      <a class="back" :href="'#/t/' + tid">← 返回教程</a>
      <span class="mapTitle">🧠 用自己的话</span>
      <span v-if="cur" class="chip rsChipConv">🗨 {{ convName(cur.round) }}</span>
      <div class="spacer"></div>
      <span v-if="busy" class="muted" style="font-size:12px;">{{ busyMsg || 'AI 在想…' }}</span>
    </div>

    <div v-if="view === 'pick'">
      <div v-if="hasArc" class="rsArc">
        <div v-if="arc.thesis" class="rsArcThesis"><b>这篇教程想让你理解的是</b><br>{{ arc.thesis }}</div>
        <div v-if="(arc.spine || []).length" class="rsArcBlock"><div class="rsArcT">主线怎么推进</div><ol class="rsSpine"><li v-for="(s, i) in arc.spine" :key="i">{{ s }}</li></ol></div>
        <div v-if="(arc.branches || []).length" class="rsArcBlock"><div class="rsArcT">分成这几块</div><div class="rsBranches"><div v-for="b in arc.branches" :key="b.id" class="rsBranch" :class="{ off: branchCount(b.id) === 0 }"><div class="rsBranchN">{{ b.name }} <span class="muted">{{ branchCount(b.id) }} 个点</span></div><div v-if="b.gist" class="rsBranchG">{{ b.gist }}</div></div></div></div>
      </div>
      <div v-if="weave" class="rsSec"><div class="rsSecT">🧩 你自己串起来的整篇</div><div class="rsMine"><div class="rsMineB mdBody" v-html="md(weave.narrative || '')"></div></div><div class="toolbarRow"><button class="btn" type="button" @click="view = 'weave'">看完整串联</button></div></div>
      <div class="rsIntro"><p>看懂却说不出来，是最常见的假掌握。这里 AI <b>不会先甩答案给你</b>，而是读你写的、自己判断还缺哪一块。全程你说了算：可反复答、可追问、可跳过。</p></div>
      <div v-if="points.length" class="rsSec">
        <div class="rsSecT">知识点（{{ doneCount ? '已有 ' + doneCount + ' 个沉淀出「我的话」' : '共 ' + points.length + ' 个' }}）</div>
        <div class="rsList">
          <div v-for="(p, i) in points" :key="i" class="rsPt" :class="{ done: progressOf(i).done }">
            <div class="rsPtL"><span class="rsPtDot">{{ i + 1 }}</span><span class="rsPtBody"><b>{{ p.title }}</b><span>{{ p.summary || '' }}</span><span class="rsPtSteps">覆盖清单：{{ dimsName(p) }}</span><span v-if="liveOf(i)" class="rsPtLive">✍️ 没做完，已说 {{ liveOf(i).turns || 0 }} 条 —— 点「继续」接着来</span><span v-if="roundsOf(i).length" class="rsPtHist">🗨 {{ roundsOf(i).length }} 个对话 · 共 {{ roundsOf(i).reduce((a, r) => a + (Number(r.turns) || 0), 0) }} 条 <button class="btn tiny" type="button" @click="openConvs(i)">对话历史</button></span></span></div>
            <div class="rsPtR"><span v-if="progressOf(i).done" class="rsTag ok">已沉淀 {{ progressOf(i).done }} 版</span><span v-if="liveOf(i)" class="rsTag act">进行中</span><button class="btn small primary" type="button" @click="goPoint(i)">{{ liveOf(i) ? '继续' : (roundsOf(i).length ? '新对话' : '开始') }}</button><button v-if="!liveOf(i) && roundsOf(i).length" class="btn small" type="button" @click="openConvs(i)">历史 {{ roundsOf(i).length }}</button></div>
          </div>
        </div>
      </div>
      <div v-else class="rsSec"><div class="rsSecT">知识点大纲</div><p class="muted">还没提炼。先让 AI 从这篇教程里拆出知识点，并为每个点生成一份覆盖清单。</p></div>
      <div class="toolbarRow">
        <button v-if="!points.length" class="btn primary" type="button" :disabled="busy" @click="outline(false)">{{ busy ? '提炼中…' : '提炼架构' }}</button>
        <template v-else><button class="btn primary" type="button" :disabled="busy || doneCount < 1" @click="makeWeave">🧩 串起整篇</button><button class="btn" type="button" :disabled="busy" @click="outline(true)">重新提炼架构</button><button v-if="doneCount" class="btn" type="button" @click="loadNotes">看我沉淀的话（{{ doneCount }}）</button></template>
      </div>
    </div>

    <div v-else-if="view === 'convs'">
      <div class="rsSec"><div class="rsSecT">{{ (points[histIdx] || {}).title || '' }}</div><p class="hint" style="margin:0;">共 {{ roundsOf(histIdx).length }} 个对话。退出页面、刷新、关掉浏览器都不会丢；点「继续」就能接着上次聊。</p><div class="toolbarRow" style="margin-top:10px;"><button class="btn primary" type="button" @click="newConv(histIdx)">＋ 新建对话</button><button class="btn" type="button" @click="view = 'pick'">← 返回知识点</button></div></div>
      <div class="rsConvs">
        <div v-for="r in roundsOf(histIdx)" :key="r.id" class="rsConv" :class="{ live: isActive(r) }">
          <div class="rsConvHd"><span class="rsConvName">{{ convName(r) }}</span><span class="rsTag" :class="isActive(r) ? 'act' : (hasMine(r) ? 'ok' : '')">{{ isActive(r) ? '进行中' : (hasMine(r) ? '已沉淀' : '已归档') }}</span><span class="rsConvMeta">{{ Number(r.turns) || 0 }} 条 · {{ fmtTime(r.updated_at || r.created_at, true) }}</span><span class="rsConvActs"><button class="btn tiny primary" type="button" @click="continueConv(histIdx, r.id)">{{ isActive(r) ? '继续' : '接着聊' }}</button><button v-if="hasMine(r)" class="btn tiny" type="button" @click="viewResult(r.id)">看结果</button><button v-if="Number(r.turns)" class="btn tiny" type="button" @click="toggleTurns(r.id)">看对话</button><button class="btn tiny" type="button" title="重命名" @click="renameConv(r)">✏️</button><button class="btn tiny" type="button" title="删除" @click="delConv(r)">🗑</button></span></div>
          <div v-if="expanded[r.id]" class="rsConvBody"><div class="rsThread"><div v-for="(t, i) in (loadedTurns[r.id] || [])" :key="i" class="rsTurn"><div v-if="t.user_text" class="rsSay"><span class="rsWho">我</span><div class="rsBubble">{{ t.user_text }}</div></div><div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody" v-html="md(t.ai_text)"></div></div></div></div><div v-if="hasMine(r)" class="rsMine"><div class="rsMineT">🗣 这个对话沉淀的「我的话」</div><div class="rsMineB mdBody" v-html="md(r.mine)"></div></div></div>
        </div>
        <p v-if="!roundsOf(histIdx).length" class="muted">还没有对话。点上面的「新建对话」开始。</p>
      </div>
    </div>

    <div v-else-if="view === 'talk' && cur">
      <div ref="panesEl" class="rsPanes" :style="{ '--rs-col-q': colQ + 'px' }">
        <aside class="rsPane rsPaneQ">
          <div class="rsPaneT">🧭 上下文</div>
          <div class="rsPaneBody">
            <div class="rsPaneTopic">{{ (cur.point || {}).title }}</div>
            <div class="rsLevel"><div class="rsLevelHd"><span>AI 判断你的掌握</span><span class="rsSub">{{ levelTxt(coach.level) }}</span></div><div class="rsLevelBar"><span v-for="i in [0,1,2,3]" :key="i" class="rsLevelStep" :class="{ on: i <= coach.level }">{{ ['关键词','说得清','讲得透','讲成段'][i] }}</span></div><div v-if="coach.verdict" class="rsLevelV">{{ coach.verdict }}</div></div>
            <div class="rsDims"><div class="rsDimsHd"><span>覆盖清单</span><span class="rsSub">{{ coach.hit.length }}/{{ coach.dims.length }} 已讲到</span></div><div class="rsDimsRow"><span v-for="d in coach.dims" :key="d.key" class="rsDim" :class="{ on: coach.hit.includes(d.key), cur: d.key === coach.focus }" :title="d.ask || d.name">{{ coach.hit.includes(d.key) ? '✓ ' : '' }}{{ d.name }}</span><span v-if="coach.dims.length && coach.hit.length === coach.dims.length" class="rsDim cur refine">✦ 打磨</span></div></div>
            <div v-if="pending && pending.hint" class="rsQ"><details class="rsKey" open><summary>刚才的提示（只给方向，不是答案）</summary><p>{{ pending.hint.probe || pending.hint.say || '' }}</p></details></div>
            <p v-else-if="!pending" class="rsQQ muted">{{ hasSpoke ? '覆盖清单上的点都讲到了 —— 点「下一问」让它继续追问，或直接收尾。' : '点下面「下一问」，AI 会挑最该先弄清的那一条问你。' }}</p>
          </div>
          <div class="rsNav"><button class="btn tiny" type="button" :disabled="busy" @click="send(false, true)">💡 卡住了</button><button class="btn tiny primary" type="button" :disabled="busy" @click="send(true, false)">{{ pending ? '换一个问法 →' : '下一问 →' }}</button><button class="btn tiny" type="button" @click="openConvs(Number(cur.round.point_idx || 0))">🗨 历史</button></div>
          <div class="rsNavFoot"><button class="rsLink" type="button" @click="cur = null; view = 'pick'">← 换个知识点</button></div>
        </aside>
        <div class="rsSplit" role="separator" aria-orientation="vertical" @pointerdown="startSplit" @dblclick="resetSplit" title="拖动可调宽度，双击复位"><span class="rsGrip" aria-hidden="true"></span></div>
        <section class="rsPane rsPaneC">
          <div class="rsPaneT">💬 对话 <span class="rsPaneN">{{ cur.turns.length ? cur.turns.length + ' 轮' : '还没开口' }}</span></div>
          <div ref="threadEl" class="rsThread">
            <div v-if="!cur.turns.length" class="rsEmpty"><span class="rsEmptyI">🤔</span><p>AI 会读你写的，<b>自己判断还缺哪一块</b>，然后只补那一块。<br>如果第一句还没出来，点左下「下一问」。</p></div>
            <div v-for="(t, i) in cur.turns" :key="t.id || i" class="rsTurn" :class="{ chat: verdictOf(t).kind === 'chat', hint: verdictOf(t).kind === 'hint', refine: verdictOf(t).focus === 'refine' }">
              <div class="rsTurnHd"><span v-if="verdictOf(t).kind === 'chat'" class="rsTurnTag chat">问了一句</span><span v-else-if="verdictOf(t).kind === 'hint'" class="rsTurnTag hint">💡 提示</span><span v-else-if="verdictOf(t).focus" class="rsTurnTag ai">AI 关注「{{ dimName(verdictOf(t).focus) }}」</span><span class="rsTurnTime">{{ String(t.created_at || '').slice(11, 16) }}</span></div>
              <div v-if="t.user_text" class="rsSay"><span class="rsWho">我</span><div class="rsBubble">{{ t.user_text }}</div></div>
              <div class="rsAi"><span class="rsWho ai">AI</span><div class="rsBubble ai mdBody" v-html="md(t.ai_text)"></div></div>
            </div>
          </div>
          <div class="rsInput"><textarea v-model="say" rows="2" placeholder="你怎么想就怎么说，不用组织语言（Ctrl/⌘+Enter 发送）" @keydown.ctrl.enter.prevent="send(false, false)" @keydown.meta.enter.prevent="send(false, false)"></textarea><div class="rsInputBtns"><button class="btn primary" type="button" :disabled="busy || !pending" @click="send(false, false)">{{ busy ? 'AI 在读…' : '我说完了' }}</button><button class="btn" type="button" :disabled="busy" @click="ask">不明白，问一句</button><button v-if="hasSpoke" class="btn" type="button" :disabled="busy" @click="startFinish">整理成我的话</button></div></div>
        </section>
      </div>
    </div>

    <div v-else-if="view === 'draft'">
      <div class="rsDraftBox"><div class="rsDraftT">🗣 现在轮到你写</div><p class="rsDraftLead">不看左边 AI 的原话，按<b>你刚才自己说的那些</b>，把这个知识点从头到尾讲一遍。</p><p class="muted">用你的话、你的类比，写多写少都行 —— 写出来才知道哪块其实还没真懂。</p><textarea v-model="draftText" rows="9" placeholder="例：我一直以为 base 就是个公共配置片段，后来才明白它还得配合 profiles 才不至于重复写……"></textarea><div class="rsDraftBtns"><button class="btn primary" type="button" :disabled="busy" @click="doFinish">写好了，让 AI 帮我顺一遍</button><button class="btn" type="button" @click="view = 'talk'">← 回去接着聊</button></div></div>
    </div>

    <div v-else-if="view === 'done' && cur">
      <div v-if="String(cur.round.draft || '').trim()" class="rsSec rsOwnSec"><div class="rsSecT">✍️ 你自己写的原版</div><div class="rsOwnRaw">{{ cur.round.draft }}</div></div>
      <div class="rsSec"><div class="rsSecT">{{ cur.round.point_title || '' }}</div><div class="rsMine"><div class="rsMineT">🗣 我的话 <button class="btn tiny" type="button" @click="copyMine">复制</button></div><div class="rsMineB mdBody" v-html="md(cur.round.mine)"></div></div><p v-if="cur.round.line" class="rsLine" v-html="fmtInline(cur.round.line)"></p></div>
      <div v-if="doneKept.length" class="rsSec"><div class="rsSecT">AI 认定你真讲对了的地方（{{ doneKept.length }}）</div><div class="rsKept"><div v-for="(k, i) in doneKept" :key="i" class="rsKeptI">✓ <span v-html="fmtInline(k)"></span></div></div></div>
      <div class="rsSec"><div class="rsSecT">{{ doneGaps.length ? '和关键要点的差距（' + doneGaps.length + '）' : '要点都覆盖了 ✓' }}</div><div v-if="doneGaps.length" class="rsGaps"><div v-for="(g, i) in doneGaps" :key="i" class="rsGap"><b v-html="fmtInline(g.key)"></b><span v-html="fmtInline(g.why || '')"></span></div></div><p v-else class="muted">这一轮你已经用自己的话讲全了。</p></div>
      <div class="toolbarRow"><button class="btn" type="button" @click="openConvs(Number(cur.round.point_idx || 0))">🗨 看这段对话（{{ cur.turns.length }} 条）</button><button class="btn primary" type="button" @click="nextPoint">下一个知识点 →</button><button class="btn" type="button" @click="loadNotes">看我沉淀的话</button><a class="btn" :href="'#/t/' + tid">← 返回教程</a></div>
    </div>

    <div v-else-if="view === 'weave' && weave">
      <div class="rsSec"><div class="rsSecT">用你自己的话，把这篇教程讲了一遍</div><div class="rsWeaveBody mdBody" v-html="md(weave.narrative || '')"></div><div class="toolbarRow"><button class="btn tiny" type="button" @click="copyWeave">复制</button><button class="btn tiny" type="button" @click="makeWeave">用最新的话重串一次</button></div></div>
      <div v-if="(weave.links || []).length" class="rsSec"><div class="rsSecT">你可能还没连起来的关系</div><div class="rsLinks"><div v-for="(l, i) in weave.links" :key="i" class="rsLink"><div class="rsLinkP"><span>{{ l.a }}</span><i>↔</i><span>{{ l.b }}</span></div><div class="rsLinkH">{{ l.how || '' }}</div></div></div></div>
      <div v-if="(weave.missing || []).length" class="rsSec"><div class="rsSecT">还没走到的块</div><div class="rsChips"><span v-for="x in weave.missing" :key="x" class="rsChip miss">{{ x }}</span></div></div>
      <div class="toolbarRow"><button class="btn" type="button" @click="view = 'pick'">← 回到知识点列表</button><a class="btn" :href="'#/t/' + tid">← 返回教程</a></div>
    </div>
    <div v-else-if="view === 'notes'">
      <div v-if="notes.length" class="rsNotes"><div v-for="(n, i) in notes" :key="i" class="rsNote"><div class="rsNoteT">{{ n.point_title }}<span class="muted">{{ String(n.created_at || '').slice(0, 10) }}</span></div><div class="rsNoteB mdBody" v-html="md(n.mine)"></div></div></div>
      <p v-else class="muted">还没有沉淀。先挑一个知识点和 AI 聊几轮吧。</p>
      <div class="toolbarRow"><button class="btn" type="button" @click="view = 'pick'">← 返回</button></div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) }, tid: { type: Number, default: 0 } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const md = (s) => { try { return props.host.mdToHTML ? props.host.mdToHTML(String(s || '')) : String(s || ''); } catch (e) { return String(s || ''); } };
const tid = ref(Number(props.tid) || 0);
const points = ref([]);
const rounds = ref([]);
const arc = ref(null);
const cur = ref(null);
const view = ref('pick');
const busy = ref(false);
const busyMsg = ref('');
const say = ref('');
const draftText = ref('');
const histIdx = ref(0);
const expanded = reactive({});
const loadedTurns = reactive({});
const notes = ref([]);
const threadEl = ref(null);
const panesEl = ref(null);
const colQ = ref(380);
let splitCleanup = null;

const listOf = v => { if (Array.isArray(v)) return v; try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const objOf = v => { if (v && typeof v === 'object') return v; try { const o = JSON.parse(String(v || '{}')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } };
const escText = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* 收尾对照的短文本：剥围栏 → 压一行 → esc → 成对反引号变 <code>（服务端已清洗一遍，这里兜旧数据） */
function fmtInline(v) {
  let t = String(v == null ? '' : v).replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*[ \t]*\r?\n?([\s\S]*?)(?:`{3,}|~{3,})/g, (m, body) => String(body || ''))
    .replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*/g, '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return escText(t).replace(/`([^`\n]{1,120})`/g, '<code>$1</code>').replace(/`/g, '');
}
const fmtTime = (iso, withDate) => { const d = new Date(String(iso || '')); if (isNaN(d.getTime())) return ''; const p2 = n => String(n).padStart(2, '0'); const hm = p2(d.getHours()) + ':' + p2(d.getMinutes()); if (!withDate) return hm; const t = new Date(); const same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate(); return (same ? '今天 ' : (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ') + hm; };
const convName = r => String((r && r.title) || '').trim() || (fmtTime(r && r.created_at, true) || '未命名对话');
const hasMine = r => !!(r && String(r.mine || '').trim());
const isActive = r => r && r.status === 'active';
const roundsOf = i => rounds.value.filter(r => Number(r.point_idx) === i).slice().reverse();
const liveOf = i => rounds.value.find(r => Number(r.point_idx) === i && r.status === 'active') || null;
const progressOf = i => ({ done: rounds.value.filter(r => Number(r.point_idx) === i && r.mine).length, active: !!liveOf(i) });
const doneCount = computed(() => rounds.value.filter(r => r.status === 'done' && r.mine).length);
const weave = computed(() => arc.value && arc.value.weave ? arc.value.weave : null);
const hasArc = computed(() => !!(arc.value && (arc.value.thesis || (arc.value.spine || []).length || (arc.value.branches || []).length)));
function branchCount(id) { return points.value.filter(p => p.branch === id).length; }
const dimsOfPoint = p => (p && p.dims && p.dims.length) ? p.dims : ((p && p.steps && p.steps.length) ? p.steps.map((s, i) => ({ key: 'k' + i, name: s.t || ('第' + (i + 1) + '项'), ask: s.q || '' })) : []);
const dimsName = p => dimsOfPoint(p).map(x => x.name).join(' · ');
const coach = computed(() => {
  const c = (cur.value && cur.value.coach) || {};
  const dims = (c.dims && c.dims.length) ? c.dims : dimsOfPoint(cur.value && cur.value.point);
  const out = [];
  for (const t of (cur.value && cur.value.turns) || []) { const v = objOf(t.verdict); for (const k of (v.hit || [])) if (!out.includes(k)) out.push(k); }
  const hit = (c.hit && c.hit.length) ? c.hit : out;
  let lv = Number(c.level);
  if (!Number.isFinite(lv)) lv = 0;
  return { dims, hit, focus: String(c.focus || ''), pending: c.pending || null, level: Math.max(0, Math.min(3, lv)), verdict: String(c.verdict || ''), weak: String(c.weak || ''), back: String(c.back || '') };
});
const pending = computed(() => (coach.value.pending && coach.value.pending.probe) ? coach.value.pending : null);
const hasSpoke = computed(() => !!(cur.value && cur.value.turns || []).some(t => t.user_text));
const doneGaps = computed(() => listOf(cur.value && cur.value.round && cur.value.round.gaps));
const doneKept = computed(() => listOf(cur.value && cur.value.round && cur.value.round.kept));
const levelTxt = n => ['还没开口', '能说出关键词', '能讲清机制', '能自己讲成一段'][Math.max(0, Math.min(3, Number(n) || 0))];
const dimName = k => { const d = coach.value.dims.find(x => x.key === k); return d ? d.name : (k === 'refine' ? '打磨' : k); };
const verdictOf = t => objOf(t && t.verdict);

async function reload() {
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/points'); points.value = r.points || []; rounds.value = r.rounds || []; arc.value = r.arc || null; }
  catch (e) { points.value = []; rounds.value = []; arc.value = null; }
}
async function loadRound(id) { const r = await api('/api/restate-round/' + id); cur.value = { round: r.round, point: r.point || { title: r.round.point_title }, turns: r.turns || [], coach: r.coach || null }; }
async function boot() {
  loadCols();
  await reload();
  const act = rounds.value.filter(r => r.status === 'active').pop();
  const lastDone = rounds.value.filter(r => r.status === 'done' && r.mine).pop();
  const target = act || lastDone;
  if (target) { try { await loadRound(target.id); view.value = act ? 'talk' : 'done'; if (view.value === 'talk' && !(cur.value.coach && cur.value.coach.pending)) askNext(true); } catch (e) { cur.value = null; view.value = 'pick'; } }
  else { cur.value = null; view.value = 'pick'; }
}
async function outline(force) {
  if (busy.value) return;
  if (force && !window.confirm('重新提炼会覆盖现有大纲（已沉淀的话不受影响）。继续？')) return;
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) }); points.value = r.points || []; rounds.value = r.rounds || []; toast('大纲已提炼（' + points.value.length + ' 个知识点）'); }
  catch (e) { toast(e.message); }
  busy.value = false;
}
async function goPoint(i) {
  if (busy.value) return;
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: i }) }); cur.value = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null }; await reload(); view.value = 'talk'; if (r.resumed) toast('接着上次那一轮继续'); }
  catch (e) { toast(e.message); }
  busy.value = false;
  if (view.value === 'talk' && cur.value && (!cur.value.coach || !cur.value.coach.pending)) askNext(true);
}
async function newConv(i) {
  if (busy.value) return;
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: i, fresh: true }) }); cur.value = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null }; await reload(); view.value = 'talk'; }
  catch (e) { toast(e.message); }
  busy.value = false;
  if (view.value === 'talk' && cur.value) askNext(true);
}
async function continueConv(i, id) {
  if (busy.value) return;
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: i, round_id: id }) }); cur.value = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null }; await reload(); view.value = 'talk'; }
  catch (e) { toast(e.message); }
  busy.value = false;
  if (view.value === 'talk' && cur.value && (!cur.value.coach || !cur.value.coach.pending)) askNext(true);
}
function openConvs(i) { histIdx.value = Number(i) || 0; view.value = 'convs'; }
async function viewResult(id) { try { await loadRound(id); view.value = 'done'; } catch (e) { toast(e.message); } }
async function toggleTurns(id) { if (expanded[id]) { expanded[id] = false; return; } if (!loadedTurns[id]) { try { loadedTurns[id] = (await api('/api/restate-round/' + id)).turns || []; } catch (e) { toast(e.message); return; } } expanded[id] = true; }
async function renameConv(r) { const v = window.prompt('对话名（留空 = 用时间当名字）', String(r.title || '')); if (v === null) return; try { await api('/api/restate-round/' + r.id + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v }) }); await reload(); if (cur.value && cur.value.round.id === r.id) cur.value.round.title = String(v || '').trim(); } catch (e) { toast(e.message); } }
async function delConv(r) { if (!window.confirm('删掉这个对话？\n\n「' + convName(r) + '」' + (Number(r.turns) ? '（' + r.turns + ' 条对话记录）' : '') + (hasMine(r) ? '，包括它沉淀的那版「我的话」' : '') + '\n\n删了就找不回来了。')) return; try { await api('/api/restate-round/' + r.id, { method: 'DELETE' }); rounds.value = rounds.value.filter(x => x.id !== r.id); if (cur.value && cur.value.round.id === r.id) cur.value = null; toast('已删除'); } catch (e) { toast(e.message); } }

async function scrollBottom() { await nextTick(); try { const el = threadEl.value; if (el) el.scrollTop = el.scrollHeight; } catch (e) {} }
async function send(force, hint) {
  if (busy.value || !cur.value) return;
  const text = String(say.value || '').trim();
  if (!force && !hint && !text) return toast('先写下你的理解');
  const draft = text;
  busy.value = true; busyMsg.value = hint ? '💡 只给方向，不给答案…' : 'AI 正在读你说的话、挑下一个缺口…';
  try {
    const r = await api('/api/restate-round/' + cur.value.round.id + '/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(force ? { force: true } : (hint ? { hint: true, draft } : { text })) });
    if (r.turns) cur.value.turns = r.turns; else if (r.turn) cur.value.turns.push(r.turn);
    if (r.coach) cur.value.coach = r.coach;
    if (!force && !hint) say.value = '';
    await scrollBottom();
  } catch (e) { toast(e.message); }
  busy.value = false; busyMsg.value = '';
}
function askNext(force) { if (busy.value || !cur.value) return; const p = cur.value.coach && cur.value.coach.pending; if (!force && p) return; send(true, false); }
async function ask() {
  if (busy.value || !cur.value) return;
  const text = String(say.value || '').trim();
  if (!text) return toast('先写下你的问题');
  busy.value = true; busyMsg.value = 'AI 正在答你的问题…';
  try { const r = await api('/api/restate-round/' + cur.value.round.id + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); cur.value.turns.push(r.turn); if (r.back) { cur.value.coach = cur.value.coach || { hit: [], focus: '', pending: null }; cur.value.coach.back = r.back; } say.value = ''; await scrollBottom(); }
  catch (e) { toast(e.message); }
  busy.value = false; busyMsg.value = '';
}
function startFinish() { view.value = 'draft'; draftText.value = String((cur.value && cur.value.round && cur.value.round.draft) || ''); }
async function doFinish() {
  if (busy.value || !cur.value) return;
  const text = String(draftText.value || '').trim();
  if (!text && !window.confirm('还没写整理稿。确定直接让 AI 从你说过的那些话里整理吗？\n（自己写一遍内化效果会好很多）')) return;
  busy.value = true; busyMsg.value = 'AI 正在帮你顺一遍，并对照原文找差距…';
  try { const r = await api('/api/restate-round/' + cur.value.round.id + '/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: text }) }); cur.value.round = r.round; await reload(); view.value = 'done'; }
  catch (e) { toast(e.message); }
  busy.value = false; busyMsg.value = '';
}
async function nextPoint() {
  const idx = points.value.findIndex((p, i) => !rounds.value.find(x => Number(x.point_idx) === i && x.mine));
  if (idx < 0) { cur.value = null; view.value = 'pick'; return; }
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point_idx: idx }) }); cur.value = { round: r.round, point: r.point, turns: r.turns || [], coach: r.coach || null }; view.value = 'talk'; }
  catch (e) { toast(e.message); }
  busy.value = false;
  if (view.value === 'talk' && cur.value) askNext(true);
}
async function makeWeave() {
  if (busy.value) return;
  if (weave.value && !window.confirm('用你最新沉淀的话重新串一次？')) return;
  busy.value = true;
  try { const r = await api('/api/tutorials/' + tid.value + '/restate/weave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); arc.value = arc.value || {}; arc.value.weave = r.weave; view.value = 'weave'; toast('已串起 ' + (r.used || 0) + ' 个点'); }
  catch (e) { toast(e.message); }
  busy.value = false;
}
async function loadNotes() { try { notes.value = (await api('/api/tutorials/' + tid.value + '/restate/notes')).notes || []; view.value = 'notes'; } catch (e) { toast(e.message); } }
/* ---------- 三栏宽度可拖（本机显示偏好） ---------- */
const COL_KEY = 'sierxing-restate-cols-v1';
function clampCol(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 230), 680) : 380; }
function loadCols() { try { const o = JSON.parse(localStorage.getItem(COL_KEY) || '{}') || {}; let q = clampCol(o.q); if (q === 320) q = 380; /* 老默认值当没调过 */ colQ.value = q; } catch (e) { colQ.value = 380; } }
function resetSplit() { try { localStorage.removeItem(COL_KEY); } catch (e) {} colQ.value = 380; }
function startSplit(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const box = panesEl.value && panesEl.value.getBoundingClientRect();
  if (!box) return;
  const startX = e.clientX, startW = colQ.value;
  const maxW = Math.max(230, box.width - 26 - 420);
  document.body.classList.add('rsResizing');
  const move = ev => { colQ.value = Math.min(Math.max(startW + (ev.clientX - startX), 230), maxW); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('rsResizing');
    try { localStorage.setItem(COL_KEY, JSON.stringify({ q: Math.round(colQ.value) })); } catch (err) {}
    splitCleanup = null;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  splitCleanup = () => { try { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); document.body.classList.remove('rsResizing'); } catch (err) {} };
}
async function copyWeave() { try { await navigator.clipboard.writeText((weave.value && weave.value.narrative) || ''); toast('已复制'); } catch (e) { toast('复制失败，可手动选中'); } }
async function copyMine() { try { await navigator.clipboard.writeText((cur.value && cur.value.round && cur.value.round.mine) || ''); toast('已复制'); } catch (e) { toast('复制失败，可手动选中'); } }
onMounted(boot);
onUnmounted(() => { if (splitCleanup) { try { splitCleanup(); } catch (e) {} } });
</script>

<style scoped>
.rsPage { max-width: 1200px; }
</style>