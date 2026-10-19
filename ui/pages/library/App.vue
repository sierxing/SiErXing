<template>
  <div class="page">
    <div v-if="loading" class="muted">加载资源库…</div>

    <div v-else-if="!goal" class="page">
      <div class="pageHead"><h2 class="title">📚 资源库</h2></div>
      <div class="emptyBox" style="margin-top:30px;">
        <div class="ebIcon">📚</div>
        <div class="ebTitle">还没有目标</div>
        <div class="ebText">先建一个目标，收集信息源或上传图片资料后，这里会汇总整理好的资料。</div>
      </div>
    </div>

    <template v-else>
      <div class="pageHead">
        <h2 class="title">📚 资源库</h2>
        <div class="libStats">
          <span class="libStat own">📌 自己提供 <b>{{ own.length }}</b></span>
          <span class="libStat">📄 网络资料 <b>{{ net.length }}</b></span>
          <span class="libStat">📘 提炼汇总 <b>{{ digests.length }}</b></span>
        </div>
        <div class="spacer"></div>
        <select v-model.number="currentGoalId" class="libGoalSel sxi-sel" @change="loadGoalData">
          <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
        <button class="btn small" type="button" :disabled="working" @click="runRag">✨ 检索索引</button>
        <button class="btn small" type="button" :disabled="working" @click="runDigest">🧠 信息提炼</button>
        <button class="btn small" type="button" :disabled="working" @click="runClean">🧹 清洗资料</button>
        <button class="btn small" type="button" :disabled="working" @click="runRefetch">🔄 补抓正文</button>
        <label class="btn small">⬆ 导入资料<input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onImport"></label>
        <a class="btn small" :href="'/api/goals/' + currentGoalId + '/library/export'" download>⬇ 导出 MD</a>
      </div>

      <div class="libSecHd">🗂 <span class="libSecHdT">按规划归类</span><span class="libSecHdS">资料和汇总按阶段自动归堆（只读）</span></div>
      <p v-if="!stages.length" class="hint">还没有规划骨架：生成规划后，这里的资料会自动按阶段归类。</p>
      <details v-for="st in stages" :key="st.id" class="libStage">
        <summary>🎯 <span class="libStageT">{{ st.title }}</span></summary>
        <div class="libStageM">
          <span v-if="st.nodeSrc.length" class="chip">节点依据 {{ st.nodeSrc.length }}</span>
          <span v-if="st.relDigests.length" class="chip gray">汇总 {{ st.relDigests.length }}</span>
          <span v-if="st.relSrc.length" class="chip gray">相关资料 {{ st.relSrc.length }}</span>
          <span v-if="!st.nodeSrc.length && !st.relDigests.length && !st.relSrc.length" class="chip gray">暂无匹配</span>
        </div>
        <div class="libStageBody">
          <template v-if="st.nodeSrc.length">
            <div class="libSecT">📌 节点自标依据</div>
            <div v-for="(x, i) in st.nodeSrc" :key="i" class="libRef">🔗<span>{{ x.name || x.title || '' }}<div v-if="x.note" class="libSrcMeta">{{ x.note }}</div></span></div>
          </template>
          <template v-if="st.relDigests.length">
            <div class="libSecT">📄 相关汇总</div>
            <details v-for="d in st.relDigests" :key="d.id" class="libSrc">
              <summary>📄 {{ d.title || d.topic }}</summary>
              <div class="libSrcBody mdBody" v-html="md(d.content)"></div>
            </details>
          </template>
          <template v-if="st.relSrc.length">
            <div class="libSecT">🔗 相关资料</div>
            <details v-for="x in st.relSrc" :key="x.id" class="libSrc">
              <summary><span class="chip gray">{{ x.kind || '资料' }}</span> {{ x.title }} <span class="muted" style="font-size:11px;">· {{ srcText(x).length }} 字</span></summary>
              <div class="libSrcBody">
                <div class="libAiRow"><template v-if="Number(x.quality_score) > 0"><span class="chip ai">AI {{ x.quality_score }}/5</span></template><template v-if="x.topic"><span class="chip gray">{{ x.topic }}</span></template><template v-if="Number(x.content_full) === 1"><span class="chip ok">全文</span></template><span v-if="x.ai_summary" class="libAiSum">{{ x.ai_summary }}</span></div>
                <div v-if="x.url" class="libSrcMeta">来源：<a :href="x.url" target="_blank" rel="noopener">{{ x.site || x.url }}</a></div>
                <div v-else class="libSrcMeta">来源：{{ x.site || '—' }}</div>
                <div class="mdBody libFullText" v-html="md(srcText(x))"></div>
              </div>
            </details>
          </template>
          <div v-if="!st.nodeSrc.length && !st.relDigests.length && !st.relSrc.length" class="muted" style="font-size:12.5px;">这个阶段暂时没有匹配到资料</div>
        </div>
      </details>

      <div class="libSecHd">📄 <span class="libSecHdT">主题汇总</span><span class="libSecHdS">AI 通读全部资料后按主题整理的 MD，规划时的优先依据</span></div>
      <div v-if="digests.length">
        <div class="libDigestHead"><a class="btn tiny" :href="'/api/goals/' + currentGoalId + '/digests/export'" download>⬇ 下载全部 MD</a></div>
        <details v-for="d in digests" :key="d.id" class="libSrc">
          <summary>📄 {{ d.title || d.topic }} <span class="muted" style="font-size:11.5px;">· 依据 {{ d.sources_count || 0 }} 条</span></summary>
          <div class="libSrcBody mdBody" v-html="md(d.content)"></div>
          <div class="spDigestOps"><span class="muted" style="font-size:11.5px;">{{ fmtDate(d.created_at) }}</span><div class="spacer"></div><button class="btn tiny danger" type="button" :disabled="working" @click="delDigest(d.id)">删除</button></div>
        </details>
      </div>
      <p v-else class="hint">还没有提炼汇总：点右上「🧠 信息提炼」，AI 会通读全部资料并按主题整理成多篇 MD。</p>

      <div class="libSecHd">🧱 <span class="libSecHdT">全部资料</span><span class="libSecHdS">共 {{ sources.length }} 条</span></div>
      <template v-if="own.length">
        <div class="libSecT">📌 你自己提供的（最高优先级）</div>
        <details v-for="x in own" :key="x.id" class="libSrc">
          <summary><span class="chip gray">{{ x.kind || '资料' }}</span> {{ x.title }} <span class="muted" style="font-size:11px;">· {{ srcText(x).length }} 字</span></summary>
          <div class="libSrcBody">
            <div class="libAiRow"><template v-if="Number(x.quality_score) > 0"><span class="chip ai">AI {{ x.quality_score }}/5</span></template><template v-if="x.topic"><span class="chip gray">{{ x.topic }}</span></template><template v-if="Number(x.content_full) === 1"><span class="chip ok">全文</span></template><span v-if="x.ai_summary" class="libAiSum">{{ x.ai_summary }}</span></div>
            <div v-if="x.url" class="libSrcMeta">来源：<a :href="x.url" target="_blank" rel="noopener">{{ x.site || x.url }}</a></div>
            <div v-else class="libSrcMeta">来源：{{ x.site || '—' }}</div>
            <div class="mdBody libFullText" v-html="md(srcText(x))"></div>
          </div>
        </details>
      </template>
      <template v-for="grp in kindGroups" :key="grp.kind">
        <div class="libSecT">{{ grp.kind }}（{{ grp.list.length }}）</div>
        <details v-for="x in grp.list" :key="x.id" class="libSrc">
          <summary><span class="chip gray">{{ x.kind || '资料' }}</span> {{ x.title }} <span class="muted" style="font-size:11px;">· {{ srcText(x).length }} 字</span></summary>
          <div class="libSrcBody">
            <div class="libAiRow"><template v-if="Number(x.quality_score) > 0"><span class="chip ai">AI {{ x.quality_score }}/5</span></template><template v-if="x.topic"><span class="chip gray">{{ x.topic }}</span></template><template v-if="Number(x.content_full) === 1"><span class="chip ok">全文</span></template><span v-if="x.ai_summary" class="libAiSum">{{ x.ai_summary }}</span></div>
            <div v-if="x.url" class="libSrcMeta">来源：<a :href="x.url" target="_blank" rel="noopener">{{ x.site || x.url }}</a></div>
            <div v-else class="libSrcMeta">来源：{{ x.site || '—' }}</div>
            <div class="mdBody libFullText" v-html="md(srcText(x))"></div>
          </div>
        </details>
      </template>
      <div v-if="!sources.length" class="hint">还没有资料。可以从右上「导入资料」开始，或到「信息源导入」页搜集。</div>
    </template>

    <div v-if="job.open" class="libCleanMask">
      <div class="libCleanBox">
        <button class="libCleanX" type="button" title="关掉这个框（动作在后台继续，左下角「AI 任务」可看进度或停止）" @click="job.open = false">×</button>
        <div class="libCleanT">{{ job.title }}</div>
        <div class="libCleanBig">{{ job.big || '准备中…' }}</div>
        <div class="taskProg" style="margin-top:8px;"><i :style="{ width: job.pct + '%' }"></i></div>
        <div class="libCleanSub">{{ job.now }}</div>
        <div class="libCleanS">{{ job.status }}</div>
        <div class="libCleanWarn">关掉这个框不会停：动作在后台继续跑，要停请到左下角「AI 任务」里点停止。</div>
        <div class="libCleanBtns"><button class="btn primary" type="button" @click="job.open = false">关掉，后台继续</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

const props = defineProps({
  host: { type: Object, default: () => ({}) },
  goalId: { type: Number, default: 0 }
});
const api = props.host.api;
const mdToHTML = props.host.mdToHTML || (function (s) { return String(s || ''); });
const safeParse = props.host.safeParse || (function (s, d) { try { return JSON.parse(s || ''); } catch (e) { return d; } });
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const fmtDate = props.host.fmtDate || (function (s) { return String(s || ''); });
const fileInput = ref(null);
const working = ref(false);
const job = reactive({ open: false, title: '', big: '', pct: 0, now: '', status: '' });

const loading = ref(true);
const goals = ref([]);
const currentGoalId = ref(Number(props.goalId) || 0);
const goal = ref(null);
const sources = ref([]);
const digests = ref([]);

const own = computed(() => sources.value.filter(x => x.site === '用户提供的图片' || x.site === '导入的资料' || x.site === '用户提供的电子书' || x.site === '待找书单'));
const net = computed(() => sources.value.filter(x => !(x.site === '用户提供的图片' || x.site === '导入的资料' || x.site === '用户提供的电子书' || x.site === '待找书单')));
const kindGroups = computed(() => {
  const map = new Map();
  for (const x of net.value) {
    const k = x.kind || '其它';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return Array.from(map.entries()).map(([kind, list]) => ({ kind, list }));
});
function srcText(x) { return String(x.content || x.snippet || '（无正文）'); }
function md(s) { try { return mdToHTML(String(s || '')); } catch (e) { return String(s || ''); } }
function kwScore(text, hay) {
  const words = String(text || '').match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9+.#_-]{2,}/g) || [];
  const set = new Set(words.map(x => x.toLowerCase()));
  const h = String(hay || '').toLowerCase();
  let n = 0;
  for (const w of set) if (w.length >= 2 && h.includes(w)) n++;
  return n;
}
function nodeSources(n) {
  const list = safeParse(n.sources, []);
  return Array.isArray(list) ? list : [];
}
const stages = computed(() => {
  const g = goal.value;
  if (!g) return [];
  const list = (g.nodes || []).filter(n => n.level === 0).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return list.map(st => {
    const nodeSrc = [];
    const walk = n => { nodeSrc.push(...nodeSources(n)); (n.children || []).forEach(walk); };
    walk(st);
    const text = (st.title || '') + ' ' + (st.detail || '');
    const relDigests = digests.value
      .map(d => ({ ...d, score: kwScore(text, (d.title || '') + ' ' + (d.topic || '') + ' ' + String(d.content || '').slice(0, 2000)) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    const relSrc = sources.value
      .map(x => ({ ...x, score: kwScore(text, (x.title || '') + ' ' + String(x.content || '').slice(0, 1500)) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    return { id: st.id, title: st.title, nodeSrc, relDigests, relSrc };
  });
});

async function loadGoals() {
  try { goals.value = (await api('/api/goals')).goals || []; } catch (e) { goals.value = []; }
  if (!goals.value.some(g => Number(g.id) === Number(currentGoalId.value))) {
    currentGoalId.value = goals.value.length ? Number(goals.value[0].id) : 0;
  }
}
async function loadGoalData() {
  if (!currentGoalId.value) { goal.value = null; sources.value = []; digests.value = []; return; }
  try {
    const [gr, sr, dr] = await Promise.all([
      api('/api/goals/' + currentGoalId.value),
      api('/api/goals/' + currentGoalId.value + '/sources'),
      api('/api/goals/' + currentGoalId.value + '/digests')
    ]);
    goal.value = gr.goal || null;
    sources.value = sr.sources || [];
    digests.value = dr.digests || [];
  } catch (e) {
    goal.value = null; sources.value = []; digests.value = [];
    toast('资源库加载失败：' + e.message);
  }
}
async function boot() {
  loading.value = true;
  await loadGoals();
  await loadGoalData();
  loading.value = false;
}
function setJob(title, big) {
  job.open = true; job.title = title; job.big = big || '准备中…'; job.pct = 0; job.now = ''; job.status = '';
}
async function refreshAll() {
  try { await loadGoals(); await loadGoalData(); } catch (e) {}
}
async function streamRequest(url, body, onEvent) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!resp.ok || !resp.body) {
    let msg = '请求失败：HTTP ' + resp.status;
    try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let d = null; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
      onEvent(d);
    }
  }
}
async function runRag() {
  if (!currentGoalId.value || working.value) return;
  try {
    const r = await api('/api/goals/' + currentGoalId.value + '/rag/build', { method: 'POST' });
    toast(r.already ? '索引任务已在运行' : '已开始建立检索索引（左下角任务中心可看进度）');
  } catch (e) { toast(e.message); }
}
async function runDigest() {
  if (working.value) return;
  if (!sources.value.length) return toast('还没有资料：先导入或搜集资料');
  if (!window.confirm('让 AI 通读全部 ' + sources.value.length + ' 条资料并提炼成多篇主题汇总？\n\n资料越多耗时越长，期间可到左下角「AI 任务」停止。')) return;
  working.value = true; setJob('🧠 正在提炼资料', '正在通读资料…');
  let finished = false;
  try {
    await streamRequest('/api/goals/' + currentGoalId.value + '/sources/digest', {}, function (d) {
      if (d.status) { job.status = d.status; }
      if (d.progress && d.progress.total) {
        job.big = '已通读 ' + (d.progress.done || 0) + ' / ' + d.progress.total + ' 批';
        job.pct = Math.round(100 * (d.progress.done || 0) / d.progress.total);
      }
      if (d.done) { finished = true; toast('提炼完成：' + d.count + ' 篇主题汇总'); job.open = false; }
      if (d.cancelled) { finished = true; toast(d.status || '已停止提炼'); job.open = false; }
      if (d.error) { finished = true; toast(d.error); job.open = false; }
    });
    if (!finished) toast('提炼中断，可重试');
  } catch (e) { toast(e.message); job.open = false; }
  finally { working.value = false; await refreshAll(); }
}
async function runClean() {
  if (working.value) return;
  if (!sources.value.length) return toast('还没有资料可以清洗');
  let hasAI = false;
  try { const st = await api('/api/ai/status'); hasAI = !!(st && st.configured); } catch (e) {}
  const useAI = hasAI ? window.confirm('清洗资料：去掉抓网页时混进来的导航/推荐位/页脚等垃圾文字。\n\n点「确定」= 本地清洗 + AI 再删一遍（更干净，会花调用）\n点「取消」= 只做本地清洗（免费、很快）') : false;
  working.value = true; setJob('🧹 正在清洗资料', '准备中…');
  let finished = false;
  try {
    await streamRequest('/api/goals/' + currentGoalId.value + '/sources/clean', { ai: useAI }, function (d) {
      if (d.total != null) {
        job.big = '已清洗 ' + (d.done || 0) + ' / ' + d.total + ' 篇' + (d.pct ? '（' + d.pct + '%）' : '');
        job.pct = d.pct || Math.round(100 * (d.done || 0) / Math.max(1, d.total));
      }
      if (d.title) job.now = '正在处理：《' + d.title + '》';
      const bits = [];
      if (d.removed) bits.push('已去掉 ' + d.removed + ' 字');
      if (d.ai && d.aiCalls) bits.push('AI 调用 ' + d.aiCalls + ' 次');
      if (bits.length) job.status = bits.join(' · ');
      else if (d.status) job.status = d.status;
      if (d.finish) {
        finished = true;
        toast('🧹 清洗完成：洗了 ' + (d.cleaned || 0) + ' 条' + (d.removed ? '，共去掉 ' + Math.round(d.removed / 1000) + 'k 字' : ''));
        job.open = false;
      }
      if (d.error) { finished = true; toast('清洗失败：' + d.error); job.open = false; }
    });
    if (!finished) toast('清洗中断，可再试');
  } catch (e) { toast(e.message); job.open = false; }
  finally { working.value = false; await refreshAll(); }
}
async function runRefetch() {
  if (working.value) return;
  const ok = window.confirm('补抓正文：把「只有标题和搜索摘要、正文是空的」资料重新抓一遍。\n\n· 抓到的 → 正文写回资料库\n· 仍抓不到的 → 直接从资料库删掉\n\n范围：全部目标。确定开始？');
  if (!ok) return;
  working.value = true; setJob('🔄 正在补抓正文', '准备中…');
  let finished = false;
  try {
    await streamRequest('/api/sources/refetch', {}, function (d) {
      if (d.total != null) {
        job.big = '已补抓 ' + (d.done || 0) + ' / ' + d.total + ' 条' + (d.pct ? '（' + d.pct + '%）' : '');
        job.pct = d.pct || Math.round(100 * (d.done || 0) / Math.max(1, d.total));
      }
      if (d.title) job.now = '正在处理：《' + d.title + '》';
      const bits = [];
      if (d.got) bits.push('抓回 ' + d.got + ' 条');
      if (d.dropped) bits.push('删掉 ' + d.dropped + ' 条');
      if (d.chars) bits.push('+' + Math.round(d.chars / 1000) + 'k 字');
      if (bits.length) job.status = bits.join(' · ');
      else if (d.status) job.status = d.status;
      if (d.finish) {
        finished = true;
        toast('🔄 补抓完成：抓回 ' + (d.got || 0) + ' 条，删掉 ' + (d.dropped || 0) + ' 条');
        job.open = false;
      }
      if (d.error) { finished = true; toast('补抓失败：' + d.error); job.open = false; }
    });
    if (!finished) toast('补抓中断，可再试');
  } catch (e) { toast(e.message); job.open = false; }
  finally { working.value = false; await refreshAll(); }
}
async function onImport(ev) {
  const f = (ev.target.files || [])[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await api('/api/goals/' + currentGoalId.value + '/sources/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    toast('已导入 ' + (r.added || 0) + ' 条资料' + (r.skipped ? '（' + r.skipped + ' 条已存在）' : ''));
    await refreshAll();
  } catch (e) { toast('导入失败：' + e.message); }
}
async function delDigest(id) {
  if (!window.confirm('删除这篇提炼汇总？')) return;
  try { await api('/api/digests/' + id, { method: 'DELETE' }); toast('已删除'); await refreshAll(); }
  catch (e) { toast(e.message); }
}

onMounted(boot);
</script>

<style scoped>
.page { max-width: 1180px; }
</style>