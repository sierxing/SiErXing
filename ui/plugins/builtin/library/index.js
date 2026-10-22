'use strict';
/**
 * 内置 UI 插件 · 资源库（#/library）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/library/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

/* ============ 资源库（汇总 MD + 全部资料，按规划归类，可一键导出） ============ */
/* 关键词打分：用于把资料/汇总归到相关阶段 */
function kwScore(text, hay) {
  const words = String(text || '').match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9+.#_-]{2,}/g) || [];
  const set = new Set(words.map(x => x.toLowerCase()));
  const h = String(hay || '').toLowerCase();
  let n = 0;
  for (const w of set) if (w.length >= 2 && h.includes(w)) n++;
  return n;
}

async function startDigest(id) {
  if (digestingAt(id)) return;
  if (!(await ensureAIConfigured())) return;
  if (!(H.state.sources || []).length) { H.toast('还没有资料：先「收集信息源」或上传图片资料'); return; }
  if (!confirm('让 AI 通读全部 ' + (H.state.sources || []).length + ' 条资料并提炼成多篇主题汇总？\n\n你的资料越多耗时越长（100 条以上大约 10-20 分钟，期间可随时点「⏹ 停止」，已提炼的部分会保留），提炼结果会用于后续规划。')) return;
  const job = { status: '正在通读资料…', progress: null, abort: new AbortController() };
  H.state.digestJobs[id] = job;
  if (isGoalCurrent(id)) H.renderGoal();
  try {
    const resp = await fetch('/api/goals/' + id + '/sources/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: job.abort.signal });
    if (!resp.ok || !resp.body) throw new Error('无法连接提炼服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', done = false;
    while (true) {
      const { done: d0, value } = await reader.read();
      if (d0) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.status) {
          job.status = d.status;
          if (isGoalCurrent(id)) { const el = document.getElementById('spStatus'); if (el) el.textContent = d.status; }
        }
        if (d.progress) { job.progress = d.progress; }
        if (d.done) { done = true; if (isGoalCurrent(id)) H.state.digests = d.digests || []; H.toast('提炼完成：' + d.count + ' 篇主题汇总（规划会优先依据）'); }
        if (d.cancelled) { done = true; H.toast(d.status || '已停止提炼'); }
        if (d.error) { done = true; H.toast(d.error); }
      }
    }
    if (!done) H.toast('提炼中断，可重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') H.toast(e.message);
  } finally {
    if (H.state.digestJobs && H.state.digestJobs[id] === job) delete H.state.digestJobs[id];
    if (isGoalCurrent(id) && onGoalPage(id)) {
      try { await H.loadGoal(id); } catch (e) {}
      if (onGoalPage(id)) H.renderGoal();
    }
  }
}

function digestingAt(gid) { return !!digestJobOf(gid); }

async function ensureAIConfigured() {
  try { H.state.aiStatus = await H.api('/api/ai/status'); } catch (e) { return true; }
  if (H.state.aiStatus && H.state.aiStatus.configured) return true;
  H.toast('请先配置 AI 接入方式');
  H.go('#/settings');
  return false;
}

/* 当前 state.goal 是不是这个目标（决定能不能改 state / DOM，防止后台任务把别的目标页改花） */
function isGoalCurrent(gid) { return !!(H.state.goal && Number(H.state.goal.id) === Number(gid)); }

/* 路由是不是正停在这个目标的目标页（长任务收尾只重画它自己那一页） */
function onGoalPage(gid) {
  try { const rr = H.parseRoute(); return rr.view === 'goal' && Number(rr.id) === Number(gid); } catch (e) { return false; }
}

function digestJobOf(gid) { const id = Number(gid) || 0; return (H.state.digestJobs && H.state.digestJobs[id]) || null; }

async function renderLibraryPage() {
  if (H.libraryVueEnabled()) {
    try { if (await H.renderLibraryPageVue()) return; }
    catch (e) { console.warn('[library] Vue 页加载失败，回退旧版：', e && e.message); }
  }
  H.app.innerHTML = '<p class="muted">加载资源库…</p>';
  if (!H.state.goals || !H.state.goals.length) { try { H.state.goals = (await H.api('/api/goals')).goals || []; } catch (e) {} }
  let g = H.state.goal && H.state.goal.nodes ? H.state.goal : null;
  if (!g && (H.state.goals || []).length) g = H.state.goals[0];
  if (!g) {
    H.app.innerHTML = `<div class="page"><div class="pageHead"><h2 class="title">📚 资源库</h2></div><div class="emptyBox" style="margin-top:30px;"><div class="ebIcon">📚</div><div class="ebTitle">还没有目标</div><div class="ebText">先建一个目标，收集信息源或上传图片资料后，这里会汇总整理好的资料。</div></div></div>`;
    return;
  }
  if (!H.state.goal || H.state.goal.id !== g.id || H.state.goal.nodes == null) { try { await H.loadGoal(g.id); } catch (e) {} g = H.state.goal || g; }
  const digests = H.state.digests || [];
  const sources = H.state.sources || [];
  const own = sources.filter(x => x.site === '用户提供的图片' || x.site === '导入的资料');
  const net = sources.filter(x => !(x.site === '用户提供的图片' || x.site === '导入的资料'));
  const stages = ((g.nodes || [])).filter(n => n.level === 0).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const byKind = {};
  for (const x of sources) (byKind[x.kind || '其它'] = byKind[x.kind || '其它'] || []).push(x);
  const goalOptions = (H.state.goals || []).map(x => `<option value="${x.id}" ${Number(x.id) === Number(g.id) ? 'selected' : ''}>${H.esc(x.title)}</option>`).join('');
  /* 一条资料。AI 判读结果（相关度/主题/一句话摘要）直接摆在标题下面 ——
     用户要一眼看出"这条是什么、值不值得点开"，而不是先看一堆标题再自己猜。 */
  const srcCard = (x, withBody) => {
    const full = String(x.content || x.snippet || '（无正文）');
    const sc = Number(x.quality_score || 0);
    const cleanChip = Number(x.clean_removed) > 0
      ? `<span class="chip gray" title="抓取时混进来的导航/推荐/页脚等垃圾文字已去掉这么多">🧹 洗掉 ${Number(x.clean_removed) >= 1000 ? (Number(x.clean_removed) / 1000).toFixed(1) + 'k' : x.clean_removed} 字</span>`
      : '';
    const aiChips = (sc > 0 || x.topic || x.ai_summary)
      ? `<div class="libAiRow">${sc > 0 ? `<span class="chip ai">AI ${sc}/5</span>` : ''}${x.topic ? `<span class="chip gray">${H.esc(x.topic)}</span>` : ''}${Number(x.content_full) === 1 ? '<span class="chip ok">全文</span>' : ''}${cleanChip}${x.ai_summary ? `<span class="libAiSum">${H.esc(x.ai_summary)}</span>` : ''}</div>`
      : '';
    return `<details class="libSrc"><summary><span class="chip gray">${H.esc(x.kind || '资料')}</span> ${H.esc(x.title)} <span class="muted" style="font-size:11px;">· ${full.length} 字</span></summary>
      <div class="libSrcBody">${aiChips}${x.url ? `<div class="libSrcMeta">来源：<a href="${H.esc(x.url)}" target="_blank" rel="noopener">${H.esc(x.site || x.url)}</a></div>` : `<div class="libSrcMeta">来源：${H.esc(x.site || '—')}</div>`}
      <div class="mdBody libFullText" style="margin-top:6px;">${H.mdToHTML(full)}</div></div></details>`;
  };
  /* 页头：标题 + 统计（独立指标块，不再糊成一串字）+ 一组图标按钮 */
  let h = `<div class="page">
    <div class="pageHead">
      <h2 class="title">${sxi('layers', 18)} 资源库</h2>
      <div class="libStats">
        <span class="libStat own">${sxi('pin', 14)} 自己提供 <b>${own.length}</b></span>
        <span class="libStat">${sxi('doc', 14)} 网络资料 <b>${net.length}</b></span>
        <span class="libStat">${sxi('book', 14)} 提炼汇总 <b>${digests.length}</b></span>
      </div>
      <div class="spacer"></div>
      ${H.sxiGoalPickHTML('libGoal', { value: g.id, goals: H.state.goals || [], compact: true, cls: 'libGoalPick' })}
      <button class="btn small" id="libRagBuild" title="把资料切片（配了向量模型则一并向量化）：规划/对话时按问题检索最相关片段">${sxi('spark')}检索索引</button>
      <button class="btn small" id="libDigest">${sxi('spark')}${digests.length ? '重新提炼' : '信息提炼'}</button>
      <button class="btn small" id="libClean" title="把抓网页时混进来的导航/推荐位/页脚/公众号引导这类垃圾文字从正文里去掉（原文会备份，可反复跑）">${sxi('sweep')}清洗资料</button>
      <button class="btn small" id="libRefetch" title="把「只有标题和搜索摘要、正文是空的」资料重抓一遍（全部目标）：换招重试抓到的写回正文，仍抓不到的直接删掉。实测一半以上的空壳只是当初抓失败、现在能抓回来">${sxi('refresh')}补抓正文</button>
      <label class="btn small">${sxi('up')}导入资料<input type="file" id="libImport" accept=".json,application/json" hidden></label>
      <a class="btn small" href="/api/goals/${g.id}/library/export" download>${sxi('down')}导出 MD</a>
    </div>
    <div id="libRagStatus" class="muted" style="font-size:12px;margin:-10px 0 14px;"></div>`;

  // 一、按规划归类
  h += `<div class="libSecHd">${sxi('grid')}<span class="libSecHdT">按规划归类</span><span class="libSecHdS">资料和汇总按阶段自动归堆</span></div>`;
  if (!stages.length) h += `<p class="hint">还没有规划骨架：生成规划后，这里的资料会自动按阶段归类。</p>`;
  for (const st of stages) {
    const nodeSrc = [];
    const walk = n => { nodeSrc.push(...libSourcesOfNode(n)); (n.children || []).forEach(walk); };
    walk(st);
    const text = (st.title || '') + ' ' + (st.detail || '');
    const relDigests = digests.map(d => ({ d, score: kwScore(text, (d.title || '') + ' ' + (d.topic || '') + ' ' + String(d.content || '').slice(0, 2000)) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    const relSrc = sources.map(x => ({ x, score: kwScore(text, (x.title || '') + ' ' + String(x.content || '').slice(0, 1500)) }))
      .filter(y => y.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    const stageChips = [];
    if (nodeSrc.length) stageChips.push(`<span class="chip">节点依据 ${nodeSrc.length}</span>`);
    if (relDigests.length) stageChips.push(`<span class="chip gray">汇总 ${relDigests.length}</span>`);
    if (relSrc.length) stageChips.push(`<span class="chip gray">相关资料 ${relSrc.length}</span>`);
    if (!stageChips.length) stageChips.push('<span class="chip gray">暂无匹配</span>');
    h += `<details class="libStage"><summary>${sxi('target', 14)}
        <span class="libStageT">${H.esc(st.title)}</span>
      </summary>
      <div class="libStageM">${stageChips.join('')}</div>
      <div class="libStageBody">
        ${nodeSrc.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('pin',14)}节点自标依据</div>${nodeSrc.map(x => `<div class="libRef">${sxi('link',14)}<span>${H.esc(x.name || x.title || '')}${x.note ? `<div class="libSrcMeta">${H.esc(x.note)}</div>` : ''}</div>`).join('')}` : ''}
        ${relDigests.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('doc',14)}相关汇总</div>${relDigests.map(({ d }) => `<details class="libSrc"><summary>📄 ${H.esc(d.title || d.topic)}</summary><div class="libSrcBody mdBody">${H.mdToHTML(d.content || '')}</div></details>`).join('')}` : ''}
        ${relSrc.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('link',14)}相关资料</div>${relSrc.map(({ x }) => srcCard(x, true)).join('')}` : ''}
        ${(!nodeSrc.length && !relDigests.length && !relSrc.length) ? '<div class="muted" style="font-size:12.5px;">这个阶段暂时没有匹配到资料</div>' : ''}
      </div></details>`;
  }
  h += `</div>`;

  // 二、主题汇总（MD）
  h += `<div class="libSecHd">${sxi('doc')}<span class="libSecHdT">主题汇总</span><span class="libSecHdS">AI 通读全部资料后按主题整理的 MD，规划时的优先依据</span></div>`;
  h += digests.length
    ? `<div class="libDigestHead"><a class="btn tiny" href="/api/goals/${g.id}/digests/export" download>⬇ 下载全部 MD</a></div>` + digests.map(d => `<details class="libSrc"><summary>📄 ${H.esc(d.title || d.topic)} <span class="muted" style="font-size:11.5px;">· 依据 ${d.sources_count || 0} 条</span></summary><div class="libSrcBody mdBody">${H.mdToHTML(d.content || '')}</div><div class="spDigestOps"><span class="muted" style="font-size:11.5px;">${H.esc(H.fmtDate(d.created_at))}</span><div class="spacer"></div><button class="btn tiny danger" data-digest-del="${d.id}">删除</button></div></details>`).join('')
    : `<p class="hint">还没有提炼汇总：点右上「🧠 信息提炼」，AI 会通读全部资料并按主题整理成多篇 MD。</p>`;
  h += `</div>`;

  // 三、全部资料（按类型）
  h += `<div class="libSecHd">${sxi('layers')}<span class="libSecHdT">全部资料</span><span class="libSecHdS">共 ${sources.length} 条</span></div>`;
  h += own.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('pin',14)}你自己提供的（最高优先级）</div>${own.map(x => srcCard(x, true)).join('')}` : '';
  for (const k of Object.keys(byKind)) {
    const list = byKind[k].filter(x => !own.includes(x));
    if (!list.length) continue;
    h += `<div class="libSecT">${H.esc(k)}（${list.length}）</div>${list.slice(0, 60).map(x => srcCard(x, false)).join('')}`;
    if (list.length > 60) h += `<div class="muted" style="font-size:12px;">…还有 ${list.length - 60} 条（导出 Markdown 可看全部）</div>`;
  }
  h += `</div></div>`;
  H.app.innerHTML = h;

  /* 选目标：可搜索（目标一多，原生 select 展开是系统菜单、没法搜） */
  H.sxiGoalPickBind('libGoal', { onPick: async function (gid) { if (!gid) return; try { await H.loadGoal(gid); } catch (e) {} renderLibraryPage(); } });
  /* 检索索引：状态 + 一键建立（切片/向量化，规划与对话会按问题检索它） */
  const lrb = document.getElementById('libRagBuild');
  if (lrb) lrb.addEventListener('click', async () => {
    try {
      const r = await H.api('/api/goals/' + g.id + '/rag/build', { method: 'POST' });
      H.toast(r.already ? '索引任务已在运行' : '已开始建立检索索引（左下角任务中心可看进度）');
    } catch (e) { H.toast(e.message); }
  });
  (async () => {
    const box = document.getElementById('libRagStatus');
    if (!box) return;
    try {
      const st = await H.api('/api/rag/status?goalId=' + g.id);
      box.textContent = st.enabled
        ? (tr('· 检索索引：{0}/{1} 段已向量化', st.embedded, st.chunks) + (st.embConfigured ? '' : tr('（未配向量模型，按关键词检索）')))
        : '· 检索增强已关闭（设置 → 检索增强）';
    } catch (e) {}
  })();
  const ld = document.getElementById('libDigest');
  if (ld) ld.addEventListener('click', async () => { await startDigest(g.id); renderLibraryPage(); });
  const lc = document.getElementById('libClean');
  if (lc) lc.addEventListener('click', async () => {
    let hasAI = !!(H.state.aiStatus && H.state.aiStatus.configured);
    if (!hasAI) { try { const st2 = await H.api('/api/ai/status'); hasAI = !!st2.configured; H.state.aiStatus = st2; } catch (e) {} }
    const useAI = hasAI ? confirm('清洗资料：去掉抓网页时混进来的导航/推荐位/页脚/公众号引导等垃圾文字。\n\n点「确定」= 本地清洗 + **AI 再删一遍**（更干净，会花几次调用）\n点「取消」= 只做本地清洗（免费、很快）') : false;
    /* ⚠️ 这个弹窗**必须能关掉**，而且**关掉 ≠ 停止**：
       停止统一归左下角「AI 任务」（那里本来就能停任何任务），弹窗只负责"看得见进度"。
       进度要能回答"已经清洗了多少篇"——只说"正在清洗"等于没说（真实反馈）。 */
    const ov = document.createElement('div');
    ov.className = 'libCleanMask';
    ov.innerHTML = `<div class="libCleanBox">
      <button class="libCleanX" id="lcX" title="关掉这个框（清洗在后台继续，左下角「AI 任务」可看进度或停止）">×</button>
      <div class="libCleanT">🧹 正在清洗资料</div>
      <div class="libCleanBig" id="lcBig">已清洗 0 篇</div>
      <div class="taskProg" style="margin-top:8px;"><i id="lcBar" style="width:0%"></i></div>
      <div class="libCleanSub" id="lcNow"></div>
      <div class="libCleanS" id="lcStatus">准备中…</div>
      <div class="libCleanWarn">原文会备份在库里，随时可以对照或重跑；清洗不会改写内容，只删掉与正文无关的站点文字。<br>
      <b>关掉这个框不会停</b>：清洗在后台继续跑，要停请到左下角「AI 任务」里点停止。</div>
      <div class="libCleanBtns">
        <button class="btn primary" id="lcBg">关掉，后台继续</button>
      </div></div>`;
    document.body.appendChild(ov);
    let closed = false;
    const closeBox = () => { if (closed) return; closed = true; ov.remove(); };
    const paint = d => {
      const big = document.getElementById('lcBig'), bar = document.getElementById('lcBar');
      const now = document.getElementById('lcNow'), st = document.getElementById('lcStatus');
      if (!big) return;
      if (d.total != null) big.textContent = '已清洗 ' + (d.done || 0) + ' / ' + d.total + ' 篇' + (d.pct ? '（' + d.pct + '%）' : '');
      if (bar && d.pct != null) bar.style.width = d.pct + '%';
      if (now) now.textContent = d.title ? '正在处理：《' + d.title + '》' : '';
      if (st) {
        const bits = [];
        if (d.removed) bits.push('已去掉 ' + (d.removed >= 1000 ? (d.removed / 1000).toFixed(1) + 'k' : d.removed) + ' 字');
        if (d.ai && d.aiCalls) bits.push('AI 调用 ' + d.aiCalls + ' 次');
        st.textContent = bits.join(' · ') || (d.status || '');
      }
    };
    document.getElementById('lcX').addEventListener('click', closeBox);
    document.getElementById('lcBg').addEventListener('click', () => { closeBox(); H.toast('清洗在后台继续，左下角「AI 任务」可看进度或停止'); });
    document.addEventListener('keydown', function escClose(ev) {
      if (ev.key === 'Escape') { closeBox(); document.removeEventListener('keydown', escClose); }
    });
    try {
      /* 不带 signal：这个框只负责「看得见进度」，关掉它不该掐断后台任务（停止归左下角 AI 任务）。
         ⚠️ 之前这里残留了 signal: ac.signal，而 ac 已经删掉了 —— 一进来就 ReferenceError，
         被 catch 吞掉后立刻 closeBox()，表现成「点了按钮什么都没发生」（实测踩到）。 */
      const resp = await fetch('/api/goals/' + g.id + '/sources/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: useAI }) });
      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let buf2 = '', doneMsg = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf2 += dec.decode(value, { stream: true });
        const parts = buf2.split('\n\n'); buf2 = parts.pop();
        for (const p2 of parts) {
          const line = p2.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let d = null; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (d.taskId) H.state.lastCleanTaskId = d.taskId;
          paint(d);
          if (d.status && d.total == null && !d.finish) { const el = document.getElementById('lcStatus'); if (el) el.textContent = d.status; }
          if (d.finish) doneMsg = d;
          if (d.error) doneMsg = { error: d.error };
        }
      }
      closeBox();
      if (doneMsg && doneMsg.error) { H.toast('清洗失败：' + doneMsg.error); return; }
      if (doneMsg) {
        H.toast('🧹 清洗完成：洗了 ' + doneMsg.cleaned + ' 条，共去掉 ' + Math.round((doneMsg.removed || 0) / 1000) + 'k 字'
          + (doneMsg.ai ? '（AI 调用 ' + doneMsg.aiCalls + ' 次' + (doneMsg.aiLeft ? '，还有 ' + doneMsg.aiLeft + ' 条没轮到 AI，可再跑一次' : '') + '）' : '')
          + (doneMsg.costMs ? ' · 用时 ' + Math.round(doneMsg.costMs / 1000) + ' 秒' : ''));
        H.state.sources = []; H.state.sourcesLoaded = 0;
        try { await H.loadGoal(g.id); } catch (e) {}
      }
    } catch (e) {
      closeBox();
      if (!(e && e.name === 'AbortError')) H.toast('清洗中断：' + e.message + '（任务可能还在后台跑，左下角可看）');
      else H.toast('已离开进度框（清洗若还在跑，左下角「AI 任务」可停止）');
    }
  });
  /* 补抓正文：空壳资料的救回/清退。
     跟「清洗资料」最大的区别是**它会删数据**（换招重试仍抓不到的直接删），所以：
     ① 先弹 confirm 把"会删"讲清楚；② 进度框里如实报"抓回几条 / 删掉几条"。 */
  const lrf = document.getElementById('libRefetch');
  if (lrf) lrf.addEventListener('click', async () => {
    const ok = confirm('补抓正文：把「只有标题和搜索摘要、正文是空的」资料重新抓一遍。\n\n'
      + '· 抓到的 → 正文写回资料库（顺手补上发布时间）\n'
      + '· 换成浏览器请求头 / 手机 UA 重试仍抓不到的 → 直接从资料库删掉\n'
      + '  （这类多半要登录态，例如知乎、BOSS 直聘）\n\n'
      + '范围：全部目标的资料。库里有自动备份，可以回滚。\n\n确定开始？');
    if (!ok) return;
    /* 弹窗只负责"看得见进度"，停止统一归左下角「AI 任务」（关掉弹窗 ≠ 停止，跟清洗那套一致）。 */
    const ov = document.createElement('div');
    ov.className = 'libCleanMask';
    ov.innerHTML = `<div class="libCleanBox">
      <button class="libCleanX" id="lrfX" title="关掉这个框（补抓在后台继续，左下角「AI 任务」可看进度或停止）">×</button>
      <div class="libCleanT">🔄 正在补抓正文</div>
      <div class="libCleanBig" id="lrfBig">已补抓 0 条</div>
      <div class="taskProg" style="margin-top:8px;"><i id="lrfBar" style="width:0%"></i></div>
      <div class="libCleanSub" id="lrfNow"></div>
      <div class="libCleanS" id="lrfStatus">准备中…</div>
      <div class="libCleanWarn">抓不到的会直接删掉，所以进度里把「抓回」和「删掉」分开记。<br>
      <b>关掉这个框不会停</b>：补抓在后台继续跑，要停请到左下角「AI 任务」里点停止。</div>
      <div class="libCleanBtns">
        <button class="btn primary" id="lrfBg">关掉，后台继续</button>
      </div></div>`;
    document.body.appendChild(ov);
    let closed = false;
    const closeBox = () => { if (closed) return; closed = true; ov.remove(); };
    const paint = d => {
      const big = document.getElementById('lrfBig'), bar = document.getElementById('lrfBar');
      const now = document.getElementById('lrfNow'), st = document.getElementById('lrfStatus');
      if (!big) return;
      if (d.total != null) big.textContent = '已补抓 ' + (d.done || 0) + ' / ' + d.total + ' 条' + (d.pct ? '（' + d.pct + '%）' : '');
      if (bar && d.pct != null) bar.style.width = d.pct + '%';
      if (now) now.textContent = d.title ? '正在处理：《' + d.title + '》' + (d.site ? '（' + d.site + '）' : '') : '';
      if (st) {
        const bits = [];
        if (d.got) bits.push('抓回 ' + d.got + ' 条');
        if (d.dropped) bits.push('删掉 ' + d.dropped + ' 条');
        if (d.chars) bits.push('+' + Math.round(d.chars / 1000) + 'k 字');
        st.textContent = bits.join(' · ') || (d.status || '');
      }
    };
    document.getElementById('lrfX').addEventListener('click', closeBox);
    document.getElementById('lrfBg').addEventListener('click', () => { closeBox(); H.toast('补抓在后台继续，左下角「AI 任务」可看进度或停止'); });
    document.addEventListener('keydown', function escClose2(ev) {
      if (ev.key === 'Escape') { closeBox(); document.removeEventListener('keydown', escClose2); }
    });
    try {
      const resp = await fetch('/api/sources/refetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let buf2 = '', doneMsg = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf2 += dec.decode(value, { stream: true });
        const parts = buf2.split('\n\n'); buf2 = parts.pop();
        for (const p2 of parts) {
          const line = p2.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let d = null; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
          paint(d);
          if (d.status && d.total == null && !d.finish) { const el = document.getElementById('lrfStatus'); if (el) el.textContent = d.status; }
          if (d.finish) doneMsg = d;
          if (d.error) doneMsg = { error: d.error };
        }
      }
      closeBox();
      if (doneMsg && doneMsg.error) { H.toast('补抓失败：' + doneMsg.error); return; }
      if (doneMsg) {
        H.toast('🔄 补抓完成：抓回 ' + (doneMsg.got || 0) + ' 条正文（+' + Math.round((doneMsg.chars || 0) / 1000) + 'k 字）'
          + '，删掉抓不到的 ' + (doneMsg.dropped || 0) + ' 条'
          + (doneMsg.costMs ? ' · 用时 ' + Math.round(doneMsg.costMs / 1000) + ' 秒' : ''));
        /* 补抓是跨目标的：目标列表与当前目标的资料都要重新拉 */
        H.state.sources = []; H.state.sourcesLoaded = 0;
        try { H.state.goals = (await H.api('/api/goals')).goals || []; } catch (e) {}
        try { await H.loadGoal(g.id); } catch (e) {}
        renderLibraryPage();
      }
    } catch (e) {
      closeBox();
      if (!(e && e.name === 'AbortError')) H.toast('补抓中断：' + e.message + '（任务可能还在后台跑，左下角可看）');
      else H.toast('已离开进度框（补抓若还在跑，左下角「AI 任务」可停止）');
    }
  });
  const li = document.getElementById('libImport');
  if (li) li.addEventListener('change', async () => {
    const file = (li.files || [])[0]; li.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await H.api('/api/goals/' + g.id + '/sources/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      H.toast('已导入 ' + r.added + ' 条资料' + (r.skipped ? '（' + r.skipped + ' 条已存在）' : ''));
      await H.loadGoal(g.id); renderLibraryPage();
    } catch (e) { H.toast(e.message); }
  });
  H.app.querySelectorAll('[data-digest-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这篇提炼汇总？')) return;
    try { await H.api('/api/digests/' + b.getAttribute('data-digest-del'), { method: 'DELETE' });
      H.state.digests = (H.state.digests || []).filter(x => String(x.id) !== String(b.getAttribute('data-digest-del')));
      H.toast('已删除'); renderLibraryPage();
    } catch (e) { H.toast(e.message); }
  }));
}

  function mountLibrary(host) {
    H = host || {};
    return {
      render: function () { return renderLibraryPage(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['library'] = { id: 'library', mount: mountLibrary };
})();
