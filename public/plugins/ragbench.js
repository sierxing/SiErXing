'use strict';
/**
 * 思而行 · 前端组件：检索增强评测
 * ------------------------------------------------------------------
 * 回答一个问题：接上 RAG 之后，AI 答得有没有更准？
 * 同一批题、同一个模型、同一套提示词，只差「给不给资料」，
 * 按要点命中率对比两臂，并逐题展开看两边的原话。
 */
(function () {
  const H = () => (window.SiErXing ? SiErXing : {});
  const app = () => H().app;
  const api = (p, o) => H().api(p, o);
  const esc = s => (H().esc ? H().esc(s) : String(s == null ? '' : s));
  const toast = m => { try { H().toast(m); } catch (e) { console.log(m); } };

  let goal = null, questions = [], runs = [], detail = null, busy = false;

  (function injectCss() {
    if (document.getElementById('rb-style')) return;
    const l = document.createElement('link');
    l.id = 'rb-style'; l.rel = 'stylesheet';
    l.href = (typeof assetUrl === 'function' ? assetUrl('/plugins/ragbench.css') : '/plugins/ragbench.css');
    document.head.appendChild(l);
  })();

  const pct = x => (Number(x || 0) * 100).toFixed(0) + '%';
  function fmtTime(s) {
    const t = String(s || '').replace('T', ' ').replace('Z', '');
    return t.slice(0, 16);
  }

  /* ---------------- 数据 ---------------- */
  async function load() {
    if (!goal) return;
    try { questions = (await api('/api/goals/' + goal.id + '/bench/questions')).questions || []; } catch (e) { questions = []; }
    try { runs = (await api('/api/goals/' + goal.id + '/bench/runs')).runs || []; } catch (e) { runs = []; }
    const done = runs.find(r => r.status === 'done');
    if (done && (!detail || detail.run.id !== done.id)) {
      try { detail = await api('/api/bench/runs/' + done.id); } catch (e) { detail = null; }
    }
  }

  /* ---------------- 渲染 ---------------- */
  function barHTML(v, cls) {
    const p = Math.max(0, Math.min(100, Math.round(Number(v || 0) * 100)));
    return `<span class="rbBar"><i class="${cls || ''}" style="width:${p}%"></i></span>`;
  }
  function summaryHTML() {
    if (!runs.length) return '';
    const r = runs[0];
    if (r.status === 'running') return `<div class="rbCard"><div class="rbRunning">评测进行中…（已处理 ${r.done}/${r.total} 题，进度见左下角任务中心）</div></div>`;
    if (r.status !== 'done') return `<div class="rbCard"><div class="rbBad">上次评测未完成：${esc(r.error || r.status)}</div></div>`;
    const s = r.summary || {};
    const d = Number(s.delta || 0);
    const q = Number(s.questions || 0);
    const totalPts = (s.rag && s.rag.per ? s.rag.per : []).reduce((a, x) => a + (x.hits ? x.hits.length : 0), 0);
    return `<div class="rbCard">
      <div class="rbSumHead">
        <b>最近一次评测</b>
        <span class="muted">${esc(fmtTime(r.created_at))} · ${q} 道题 · 模型 ${esc(r.model || '—')}</span>
        <span class="spacer"></span>
        <span class="rbDelta ${d > 0 ? 'up' : (d < 0 ? 'down' : '')}">${d > 0 ? '▲' : (d < 0 ? '▼' : '·')} ${(d * 100).toFixed(0)} 个百分点</span>
      </div>
      <div class="rbArms">
        <div class="rbArm"><span class="rbArmT">有 RAG</span><b class="rbBig">${pct(s.rag && s.rag.avg)}</b>${barHTML(s.rag && s.rag.avg, 'ok')}<span class="muted">命中 ${s.ragHit || 0} 个要点</span></div>
        <div class="rbArm"><span class="rbArmT">无 RAG</span><b class="rbBig">${pct(s.norag && s.norag.avg)}</b>${barHTML(s.norag && s.norag.avg, 'warn')}<span class="muted">命中 ${s.noragHit || 0} 个要点</span></div>
        <div class="rbArm rbArmNote">
          <div class="muted" style="font-size:12px;line-height:1.7;">
            同一批题、同一个模型、同一套提示词，<b>唯一差别是有没有把资料检索出来喂给模型</b>。<br>
            得分 = 命中要点数 ÷ 要点总数（阅卷时不知道答案来自哪一臂）。<br>
            ${d > 0.05 ? '结论：RAG 有明显帮助，资料确实被用上了。' : (d < -0.05 ? '结论：这次没 RAG 反而更高，可能是题目不依赖资料，或检索没命中。' : '结论：两者接近，说明这些题的答案不太依赖你的资料（可换更贴合资料的题）。')}
          </div>
        </div>
      </div>
    </div>`;
  }
  function itemsHTML() {
    if (!detail || !detail.items) return '';
    return `<div class="rbCard"><div class="rbSumHead"><b>逐题对比</b><span class="muted">点题目展开两臂的原话</span></div>` +
      detail.items.map(it => {
        const rg = it.rag || { score: 0, hits: [], answer: '' };
        const no = it.norag || { score: 0, hits: [], answer: '' };
        const win = rg.score > no.score ? 'rag' : (no.score > rg.score ? 'norag' : 'tie');
        const pts = (it.question && it.question.points) || [];
        const mark = (hits) => pts.map((p, i) => `<li class="${(hits || []).indexOf(i) >= 0 ? 'hit' : 'miss'}">${esc(p)}</li>`).join('');
        return `<details class="rbItem">
          <summary>
            <span class="rbQ">${esc(it.question ? it.question.q : '')}</span>
            <span class="rbScores">
              <span class="rbTag ${win === 'rag' ? 'win' : ''}">有RAG ${pct(rg.score)}</span>
              <span class="rbTag ${win === 'norag' ? 'win' : ''}">无RAG ${pct(no.score)}</span>
            </span>
          </summary>
          <div class="rbAnsWrap">
            <div class="rbAns"><div class="rbAnsT">要点（✓ 为被判定命中）</div><ul class="rbPts">${mark(rg.hits)}</ul></div>
            <div class="rbAnsCols">
              <div class="rbAns"><div class="rbAnsT">有 RAG 的作答</div><div class="rbAnsBody">${esc(rg.answer)}</div></div>
              <div class="rbAns"><div class="rbAnsT">无 RAG 的作答</div><div class="rbAnsBody">${esc(no.answer)}</div></div>
            </div>
          </div>
        </details>`;
      }).join('') + '</div>';
  }
  function qlistHTML() {
    if (!questions.length) return `<div class="rbCard"><div class="rbEmpty">还没有题目。点上面「AI 出题」从资料里生成，或「手动加题」自己写。</div></div>`;
    return `<div class="rbCard"><div class="rbSumHead"><b>题库</b><span class="muted">共 ${questions.length} 道</span></div>
      <div class="rbQs">${questions.map((q, i) => `<div class="rbQRow">
        <span class="rbQIdx">${i + 1}</span>
        <div class="rbQMain"><div class="rbQText">${esc(q.q)}</div>
          <div class="rbQPts muted">要点 ${q.points.length} 个：${esc(q.points.join('；').slice(0, 80))}${q.points.join('；').length > 80 ? '…' : ''}</div></div>
        <button class="btn tiny danger" data-rb-del="${q.id}">删除</button>
      </div>`).join('')}</div></div>`;
  }
  function pageHTML() {
    return `<div class="page">
      <div class="pageHead">
        <button class="back" data-go="#/g/${goal.id}">← 返回</button>
        <span class="mapTitle">🧪 检索增强评测</span>
        <span class="chip gray">同一批题 · 只差给不给资料</span>
        <div class="spacer"></div>
        <button class="btn small" id="rbGen">✨ AI 出题</button>
        <button class="btn small" id="rbAdd">＋ 手动加题</button>
        <button class="btn small primary" id="rbRun" ${questions.length ? '' : 'disabled'}>▶ 开始评测</button>
      </div>
      <div class="rbTip">
        <span>🧪</span>
        <span>想验证「接上向量模型后 RAG 到底有没有用」，就看这里：<b>同一批题、同一个模型，唯一差别是提示词里有没有把资料检索出来</b>。得分按要点命中率算，阅卷时不知道答案来自哪一臂。</span>
      </div>
      ${summaryHTML()}
      ${itemsHTML()}
      ${qlistHTML()}
    </div>`;
  }

  async function draw() {
    await load();
    const box = app();
    if (!box) return;
    box.innerHTML = pageHTML();
    const gen = document.getElementById('rbGen');
    if (gen) gen.addEventListener('click', doGen);
    const add = document.getElementById('rbAdd');
    if (add) add.addEventListener('click', doAdd);
    const run = document.getElementById('rbRun');
    if (run) run.addEventListener('click', doRun);
    box.querySelectorAll('[data-rb-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('删除这道题？')) return;
      try { await api('/api/bench/questions/' + b.getAttribute('data-rb-del') + '/delete', { method: 'POST' }); await draw(); }
      catch (e) { toast('删除失败：' + e.message); }
    }));
  }

  /* ---------------- 动作 ---------------- */
  async function doGen() {
    if (busy) return;
    const n = prompt('生成几道题？（建议 8~12）', '8');
    if (n == null) return;
    busy = true;
    try {
      const r = await api('/api/goals/' + goal.id + '/bench/gen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: Number(n) || 8 }) });
      toast('已开始出题（采样 ' + r.sampled + ' 个资料片段），完成后会自动刷新');
      waitTask(r.taskId);
    } catch (e) { toast('出题失败：' + e.message); busy = false; }
  }
  async function doAdd() {
    const q = prompt('题目：');
    if (!q) return;
    const ps = prompt('要点（每行一个，用于判分）：');
    if (ps == null) return;
    try {
      await api('/api/goals/' + goal.id + '/bench/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, points: ps.split('\n') }) });
      await draw();
      toast('已添加');
    } catch (e) { toast('添加失败：' + e.message); }
  }
  async function doRun() {
    if (busy) return;
    const limit = prompt('跑几道题？（留空=全部 ' + questions.length + ' 道；每题要 4 次 AI 调用，越少越快）', '');
    if (limit == null) return;
    busy = true;
    try {
      const r = await api('/api/goals/' + goal.id + '/bench/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: Number(limit) || 0 }) });
      toast('评测已开始（' + r.total + ' 道题），进度见左下角任务中心');
      waitTask(r.taskId);
    } catch (e) { toast('启动失败：' + e.message); busy = false; }
  }
  /* 轮询任务，完成后自动刷新页面 */
  async function waitTask(taskId) {
    const tick = async () => {
      try {
        const r = await api('/api/tasks');
        const t = (r.tasks || []).find(x => Number(x.id) === Number(taskId));
        if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) {
          busy = false;
          if (t && t.status !== 'done' && t.error) toast('任务结束：' + t.error);
          await draw();
          return;
        }
      } catch (e) {}
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 2500);
  }

  async function render(id) {
    goal = (await H().loadGoal(id)) || { id };
    busy = false; detail = null;
    await draw();
  }

  SiErXing.registerPlugin({
    id: 'ragbench',
    goalEntry: {
      label: '检索评测', icon: '🧪', order: 48, header: true,
      hash: g => '#/g/' + g + '/ragbench',
      show: g => SiErXing.pluginEnabled(g, 'ragbench')
    },
    routes: [
      { match: h => h.match(/^#\/g\/(\d+)\/ragbench$/), render: async m => { await render(Number(m[1])); } }
    ]
  });
})();
