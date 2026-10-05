/**
 * 思而行 · 前端插件：每日刷题（LeetCode 热题 100）
 * ------------------------------------------------------------------
 * 这是「前端插件」示例：通过 SiErXing.registerPlugin 声明
 *   · goalEntry：左侧栏 / 目标页入口（按目标开关显示）
 *   · routes   ：页面路由与渲染
 * 页面实现所需的宿主能力（api/esc/toast/go/state/mdToHTML/fmtDate…）从 SiErXing 取用。
 */
'use strict';
(function () {
  const { api, esc, toast, go, state, mdToHTML, fmtDate, safeParse } = SiErXing;

  /* 「按知识点练习」里每个 <details> 的展开状态。
     整页重绘（改完成状态后要重拉数据）会把所有分组折叠掉 —— 用户正操作的那一组
     突然收起，点一下「标记完成」就得再展开一遍，很跳。
     用 data-grp 记住哪些组是开的，重绘后按名字还原。 */
  const openGroups = new Set();
  /** 重绘前从 DOM 里把当前展开的组名记下来（只在第一次进页面时为空，之后靠 toggle 事件增量维护） */
  function rememberOpenGroups() {
    const root = document.querySelector('#app .groupList');
    if (!root) return;
    root.querySelectorAll('details.probGroup').forEach(d => {
      const n = d.getAttribute('data-grp');
      if (!n) return;
      if (d.open) openGroups.add(n); else openGroups.delete(n);
    });
  }

/* 题面渲染：LeetCode 多数题目给 HTML，部分新题给 Markdown（含 ``` 代码围栏）——
   这里自动识别：Markdown 走 mdToHTML，HTML 直接渲染，混排时把围栏也转成 <pre>。 */
function escCode(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function looksLikeMarkdown(s) {
  const raw = String(s || '');
  if (!raw.trim()) return false;
  if (/<(p|div|ul|ol|li|pre|code|table|thead|tbody|h[1-6]|blockquote|strong|em|img|br|sup|sub|span|a|font|hr)\b/i.test(raw)) return false;
  return /```/.test(raw)
    || /(^|\n)\s*#{1,6}\s+\S/.test(raw)
    || /\*\*[^*\n]+\*\*/.test(raw)
    || /(^|\n)\s*[-*+]\s+\S/.test(raw)
    || /(^|\n)\s*\d+[.)]\s+\S/.test(raw)
    || /`[^`\n]+`/.test(raw);
}
function fencesToPre(html) {
  return String(html || '').replace(/```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) =>
    '<pre' + (lang ? ' data-lang="' + escCode(lang) + '"' : '') + '><code>' + escCode(code.replace(/^\n/, '').replace(/\n$/, '')) + '</code></pre>');
}
function statementHTML(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '<p class="muted">题面尚未缓存，点右上「刷新题面」从 leetcode.cn 获取。</p>';
  if (looksLikeMarkdown(s)) return mdToHTML(s);
  return fencesToPre(s);   // 已是 HTML：顺带把混在里面的 ``` 围栏也转成代码块
}
const DIFF_CHIP = { EASY: ['简单', 'ok'], MEDIUM: ['中等', 'warn'], HARD: ['困难', 'danger'] };
/* 本地今天（YYYY-MM-DD），复习到期判断用 */
function todayStr() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function diffChipHTML(d) {
  const c = DIFF_CHIP[d] || ['未知', 'gray'];
  return `<span class="chip ${c[1]}">${c[0]}</span>`;
}
function probStatusDot(p) {
  if (p.done) return `<span class="pdot done" title="已完成${p.done_manual >= 0 ? '（手动标记）' : ''}"></span>`;
  if (p.attempts) return `<span class="pdot trying" title="尝试过 ${p.attempts} 次"></span>`;
  return `<span class="pdot"></span>`;
}
/** 「完成状态」切换按钮。列表（按知识点练习）、今日任务、题目页三处共用，
    所以完成状态在哪都能改，而不是只有今日任务那一处。 */
function doneToggleHTML(p, cls) {
  const done = !!p.done;
  const manual = p.done_manual >= 0;
  const tip = done
    ? (manual ? '手动标记为已完成，点一下改回' : '已按作答记录判定为完成，点一下手动改为未完成')
    : (manual ? '手动标记为未完成，点一下改回自动判定' : '点一下标记为已完成');
  return `<button class="btn tiny ${done ? 'ok' : ''} ${cls || ''}" data-pdone="${p.id}" data-done="${done ? '1' : '0'}" data-manual="${p.done_manual >= 0 ? '1' : '0'}" title="${esc(tip)}">${done ? '✓ 已完成' : '标记完成'}</button>`;
}
function probRowHTML(p) {
  const tags = (p.groups || []).slice(0, 2).map(g => `<span class="chip gray">${esc(g)}</span>`).join('');
  const meta = p.passed
    ? `通过 ${p.passed} 次${p.last_date ? ' · ' + esc(p.last_date) : ''}`
    : (p.attempts ? `作答 ${p.attempts} 次 · 未通过` : '未作答');
  return `<div class="probRow ${p.done ? 'done' : ''}">
    ${probStatusDot(p)}
    <a class="prTitle" href="#/p/${p.id}"><b>${p.fid}.</b> ${esc(p.title)}</a>
    ${diffChipHTML(p.difficulty)}
    ${tags}
    <span class="prMeta">${esc(meta)}</span>
    <div class="spacer"></div>
    ${doneToggleHTML(p)}
    <button class="btn tiny" data-ide="${p.id}" title="在 VSCode 中打开作答文件">VSCode 作答</button>
    <a class="btn tiny" href="#/p/${p.id}">详情</a>
  </div>`;
}
async function renderDailyPage() {
  const g = state.goal;
  app.innerHTML = '<p class="muted">加载刷题数据…</p>';
  const [list, daily, rev] = await Promise.all([
    api('/api/problems'),
    api('/api/goals/' + g.id + '/daily'),
    api('/api/reviews/plan?goal_id=' + g.id).catch(() => ({ plan: null, pool: 0 }))
  ]);
  state.problems = list.problems || [];
  state.problemGroups = list.groups || [];
  state.daily = daily;
  state.review = rev;
  drawDailyPage();
}
function drawDailyPage() {
  /* 先记住当前哪些分组是展开的，再重绘 —— 否则改一次完成状态就把列表全收起了 */
  rememberOpenGroups();
  const g = state.goal;
  const rv = state.review || {};
  const plan = rv.plan || null;
  const planItems = (plan && plan.items) || [];
  const pool = rv.pool || 0;
  const d = state.daily || { items: [], stats: {}, hasProblems: false };
  const st = d.stats || {};
  const items = d.items || [];
  const todayDone = items.filter(i => i.done).length;
  const hasProblems = d.hasProblems || (state.problems || []).length > 0;
  let html = `<div class="dailyPage">
    <div class="dailyHead">
      <a class="back" href="#/g/${g.id}">← 返回目标</a>
      <span class="mapTitle">🧩 每日刷题</span>
      <span class="chip gray">LeetCode 热题 100</span>
      <div class="spacer"></div>
      <button class="btn small" id="practiceSetBtn">⚙ 设置</button>
      <button class="btn small" id="syncHotBtn">↻ 同步题单</button>
    </div>`;
  if (!hasProblems) {
    html += `<div class="emptyBox" style="margin-top:30px;">
      <div class="ebIcon">🧩</div>
      <div class="ebTitle">还没有题目数据</div>
      <div class="ebText">点击「同步题单」从 leetcode.cn 拉取「热题 100」并按知识点归类（需要已登录的 LeetCode 插件）。</div>
      <button class="btn primary" id="syncHotBtn2">立即同步热题 100</button>
    </div></div>`;
    app.innerHTML = html;
    const b1 = document.getElementById('syncHotBtn'); if (b1) b1.addEventListener('click', syncHot100UI);
    const b2 = document.getElementById('syncHotBtn2'); if (b2) b2.addEventListener('click', syncHot100UI);
    document.getElementById('practiceSetBtn').addEventListener('click', showPracticeSettings);
    return;
  }
  html += `<div class="statCards">
    <div class="statCard"><div class="scNum">${todayDone}<span class="scOf">/${items.length || 0}</span></div><div class="scLabel">今日完成</div></div>
    <div class="statCard"><div class="scNum">${st.solved || 0}<span class="scOf">/${st.total || 0}</span></div><div class="scLabel">累计通过</div></div>
    <div class="statCard"><div class="scNum">${st.streak || 0}<span class="scOf"> 天</span></div><div class="scLabel">连续打卡</div></div>
    <div class="statCard"><div class="scNum">${st.attempts || 0}</div><div class="scLabel">累计作答</div></div>
  </div>
  <div class="secCard">
    <div class="secHead"><span>🔁 今日复习</span><span class="chip gray">AI 按你的遗忘风险排</span><div class="spacer"></div>
      ${pool ? `<span class="muted" style="font-size:12px;">复习池 ${pool} 道${rv.overdue ? ' · ' + rv.overdue + ' 道该复习了' : ''}</span>` : ''}
      <button class="btn tiny" id="planBtn" ${pool ? '' : 'disabled'}>${plan ? '换个排法' : 'AI 排今天练哪几道'}</button></div>
    ${plan ? `
      <div class="pfPlan">
        <div class="pfPlanTop"><span class="pfChip risk mid">今天练 ${planItems.length} 道</span><div class="spacer"></div>
          <span class="pfSub">${esc(plan.date || d.date || '')}</span></div>
        ${plan.note ? `<div class="pfPlanNote">${esc(plan.note)}</div>` : ''}
        ${planItems.length ? `<div class="pfPlanGrid">${planItems.map(it => `
          <div class="pfTask ${it.done ? 'done' : ''}">
            <div class="pfTaskTop">
              ${diffChipHTML(it.difficulty)}
              <span class="pfTaskT"><b>#${it.fid}</b> ${esc(it.title || '')}</span>
            </div>
            <div class="pfTaskTop"><span class="pfSub">遗忘风险</span>
              <span class="pfChip risk ${riskClass(it.risk)}">${it.risk}</span>
              <div class="pfBar ${riskClass(it.risk)}"><i style="width:${Math.max(4, Math.min(100, Number(it.risk) || 0))}%"></i></div></div>
            <div class="pfTaskWhy">${esc(it.reason || '')}</div>
            ${it.pitfall_open ? `<div><span class="pfChip hit">⚠ ${it.pitfall_open} 张易错卡未攻克</span></div>` : ''}
            <div class="pfTaskFoot">
              ${it.done ? '<span class="pfChip fixed">✓ 今天练过了</span>'
                : `<span class="pfSub">${it.last_score >= 0 ? '上次盲写 ' + it.last_score + '%' : '没盲写验证过'}</span>`}
              <div class="spacer"></div>
              ${it.done
                ? `<button class="pfBtn sm ghost" data-plandone="${it.pid}" data-flag="0">撤销</button>`
                : `<button class="pfBtn sm" data-plandone="${it.pid}" data-flag="1" title="不用点开重做，直接标为练过了">标练过</button>`}
              <a class="pfBtn sm go" href="#/p/${it.pid}">去重做 →</a>
            </div>
          </div>`).join('')}</div>`
          : '<div class="pfEmpty" style="padding:18px 10px;">今天一道都没排上 —— 复习池里的题都还记着，不用练。</div>'}
      </div>`
      : `<div class="pfEmpty"><span class="pfEi">🔁</span>${pool
          ? '今天还没排复习。<br>点上面的「AI 排今天练哪几道」，它会看你最近哪几道快忘了、哪几道踩过的坑还没攻克，再排一份清单。'
          : '还没有题进复习池。<br>做对一道题就会自动进来（记一次「通过」即可）。'}</div>`}
  </div>
  <div class="secCard">
    <div class="secHead"><span>📌 今日任务</span><span class="chip gray">${esc(d.date || '')}</span><div class="spacer"></div>
      <button class="btn tiny" id="regenDaily">换一批</button></div>
    ${items.length ? `<div class="dailyItems">${items.map((it, i) => {
      const p = it.problem || {};
      /* 今日任务的勾与题目本身的状态取并集：当日勾了、或题目已被标记完成，都显示为已完成。
         早先这里只看 it.done，导致在题目页标记完成后回到列表又变回未完成（用户报的「不同步」）。 */
      const isDone = !!it.done || !!(p && p.done);
      return `<div class="dailyItem ${isDone ? 'done' : ''}">
        <span class="diIdx">${i + 1}</span>
        <div class="diMain">
          <a class="diTitle" href="#/p/${p.id}"><b>${p.fid}.</b> ${esc(p.title || '')}</a>
          <div class="diMeta">${diffChipHTML(p.difficulty)}${(p.groups || []).slice(0, 2).map(x => `<span class="chip gray">${esc(x)}</span>`).join('')}<span class="prMeta">${p.attempts ? '已作答 ' + p.attempts + ' 次' : '未作答'}</span></div>
        </div>
        <button class="btn tiny" data-ide="${p.id}">VSCode</button>
        <a class="btn tiny" href="#/p/${p.id}">作答/记录</a>
        <button class="btn tiny ${isDone ? '' : 'primary'}" data-toggle="${p.id}" data-done="${isDone ? '1' : '0'}">${isDone ? '✓ 已完成' : '标记完成'}</button>
      </div>`;
    }).join('')}</div>` : `<div class="muted" style="padding:12px 2px;">今天没有任务（可能已全部通过 🎉），点「换一批」重新生成。</div>`}
  </div>
  <div class="secCard">
    <div class="secHead"><span>📚 按知识点练习</span><div class="spacer"></div><span class="muted" style="font-size:12px;">共 ${(state.problems || []).length} 题</span></div>
    <div class="groupList">
      ${(state.problemGroups || []).map(gr => `<details class="probGroup" data-grp="${esc(gr.name)}"${openGroups.has(gr.name) ? ' open' : ''}>
        <summary><span class="pgName">${esc(gr.name)}</span><span class="pgProg">${gr.solved}/${gr.total}</span><span class="pgBar"><i style="width:${gr.total ? Math.round(gr.solved / gr.total * 100) : 0}%"></i></span></summary>
        <div class="pgList">${gr.problems.map(probRowHTML).join('')}</div>
      </details>`).join('')}
    </div>
  </div>
</div>`;
  app.innerHTML = html;
  const bs = document.getElementById('syncHotBtn'); if (bs) bs.addEventListener('click', syncHot100UI);
  document.getElementById('practiceSetBtn').addEventListener('click', showPracticeSettings);
  const rg = document.getElementById('regenDaily');
  if (rg) rg.addEventListener('click', async () => {
    try {
      state.daily = await api('/api/goals/' + g.id + '/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: (state.daily && state.daily.settings && state.daily.settings.daily_size) || 3 }) });
      const l = await api('/api/problems');
      state.problems = l.problems; state.problemGroups = l.groups;
      drawDailyPage();
      toast('已重新安排今日任务');
    } catch (e) { toast(e.message); }
  });
  app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const pid = Number(b.getAttribute('data-toggle'));
    const done = b.getAttribute('data-done') !== '1';
    try {
      await api('/api/goals/' + g.id + '/daily/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, done }) });
      /* 重新拉题库 + 今日任务两份数据：只刷其中一份会出现「圆点变了、任务没变」这种半同步 */
      const l = await api('/api/problems');
      state.problems = l.problems; state.problemGroups = l.groups;
      state.daily = await api('/api/goals/' + g.id + '/daily');
      state.review = await api('/api/reviews/plan?goal_id=' + g.id).catch(() => ({ plan: null }));
      drawDailyPage();
      toast(done ? '已完成 ✓' : '已取消');
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-pdone]').forEach(b => b.addEventListener('click', async () => {
    const pid = Number(b.getAttribute('data-pdone'));
    const done = b.getAttribute('data-done') !== '1';
    try {
      await api('/api/problems/' + pid + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done, goal_id: g.id }) });
      const l = await api('/api/problems');
      state.problems = l.problems; state.problemGroups = l.groups;
      state.daily = await api('/api/goals/' + g.id + '/daily');
      state.review = await api('/api/reviews/plan?goal_id=' + g.id).catch(() => ({ plan: null }));
      drawDailyPage();
      toast(done ? '已标记完成 ✓' : '已取消完成');
    } catch (e) { toast(e.message); }
  }));
  /* 排期：AI 现排一份（挑不出来按风险分兜底），已练完的不会被覆盖 */
  const planBtn = document.getElementById('planBtn');
  if (planBtn) planBtn.addEventListener('click', async () => {
    planBtn.disabled = true;
    const old = planBtn.textContent;
    planBtn.textContent = 'AI 正在想今天练哪几道…';
    try {
      const r = await api('/api/reviews/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: g.id, size: (state.daily && state.daily.settings && state.daily.settings.daily_size) || 3 }) });
      state.review = await api('/api/reviews/plan?goal_id=' + g.id);
      drawDailyPage();
      toast(r.source === 'rule' ? 'AI 没排出来，先按风险分排了' : '排好了，今天就练这几道');
    } catch (e) { toast(e.message); planBtn.disabled = false; planBtn.textContent = old; }
  });
  /* 清单里标练过 / 撤销 */
  app.querySelectorAll('[data-plandone]').forEach(b => b.addEventListener('click', async () => {
    const pid = Number(b.getAttribute('data-plandone'));
    const done = b.getAttribute('data-flag') === '1';
    try {
      await api('/api/reviews/plan/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: g.id, pid, done }) });
      state.review = await api('/api/reviews/plan?goal_id=' + g.id);
      drawDailyPage();
      toast(done ? '记下了 ✓' : '已撤销');
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-ide]').forEach(b => b.addEventListener('click', () => openProblemInIDE(Number(b.getAttribute('data-ide')))));
}
async function syncHot100UI() {
  toast('正在从 leetcode.cn 获取热题 100…');
  try {
    const r = await api('/api/problems/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('已同步 ' + r.total + ' 道题（' + r.groups.length + ' 个知识点）');
    await renderDailyPage();
  } catch (e) { toast('同步失败：' + e.message); }
}
async function showPracticeSettings() {
  let s = {};
  try { s = await api('/api/practice/settings'); } catch (e) {}
  const old = document.getElementById('pracSetDialog');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'pracSetDialog';
  div.className = 'tutDialog';
  div.innerHTML = `
    <div class="tdHead"><span>⚙</span><span>刷题设置</span><button class="btn tiny" id="psX">×</button></div>
    <div class="tdBody">
      <div class="field"><label>每日题量</label><input type="number" id="psSize" min="1" max="10" value="${s.daily_size || 3}"></div>
      <div class="field"><label>默认语言</label><select id="psLang">${(s.langs || []).map(l => `<option value="${l.id}" ${l.id === s.language ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label>VSCode 作答目录</label><input type="text" id="psDir" value="${esc(s.dir || '')}"></div>
      <p class="hint">${s.dirExists ? '目录已存在' : '目录不存在，将在首次作答时自动创建'}　·　LeetCode 账号：${esc(s.user || '未检测到登录')}</p>
      <div id="vsFixBox" class="vsFixBox"></div>
      <div class="toolbarRow" style="margin-top:10px;"><button class="btn primary" id="psSave">保存</button></div>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#psX').addEventListener('click', close);
  (async () => {
    try {
      const v = await api('/api/practice/vscode');
      const box = document.getElementById('vsFixBox');
      if (!box) return;
      if (v.ok) box.innerHTML = '<div class="hint" style="color:var(--ok);">✓ VSCode LeetCode 插件的工作目录已与作答目录一致</div>';
      else box.innerHTML = `<div class="vsFixWarn">⚠ VSCode 插件工作目录指向：<code>${esc(v.current || '未设置')}</code>，建议改为 <code>${esc(v.want)}</code>，否则插件「Show Problem」会保存到别处。<br>
        <button class="btn small primary" id="vsFixBtn" style="margin-top:7px;">一键修正插件设置</button></div>`;
      const fb = document.getElementById('vsFixBtn');
      if (fb) fb.addEventListener('click', async () => {
        try { await api('/api/practice/vscode/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已修正，重启 VSCode 生效'); box.innerHTML = '<div class="hint" style="color:var(--ok);">✓ 已修正，重启 VSCode 后生效</div>'; } catch (e) { toast(e.message); }
      });
    } catch (e) {}
  })();
  div.querySelector('#psSave').addEventListener('click', async () => {
    try {
      await api('/api/practice/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        daily_size: Number(document.getElementById('psSize').value) || 3,
        language: document.getElementById('psLang').value,
        dir: document.getElementById('psDir').value.trim()
      }) });
      close();
      toast('已保存设置');
      renderDailyPage();
    } catch (e) { toast(e.message); }
  });
}
async function openProblemInIDE(pid) {
  try {
    const prob = (state.problems || []).find(x => x.id === pid) || (state.problem && state.problem.problem && state.problem.problem.id === pid ? state.problem.problem : null);
    if (prob) { try { await navigator.clipboard.writeText(prob.fid + '. ' + prob.title); } catch (e) {} }
    const r = await api('/api/problems/' + pid + '/ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    toast('已用 VSCode 打开：' + r.file.split('/').pop()
      + (r.created ? '（已生成模板）' : (r.repaired ? '（模板还是旧的，已重写）' : ''))
      + '　题名已复制');
  } catch (e) { toast('打开失败：' + e.message); }
}
async function renderProblemPage(pid) {
  app.innerHTML = '<p class="muted">加载题目…</p>';
  const [d, mind] = await Promise.all([
    api('/api/problems/' + pid),
    api('/api/problems/' + pid + '/mind').catch(() => ({ approach: '', pitfalls: '', review: null }))
  ]);
  state.problem = d;
  state.mind = mind;
  drawProblemPage(pid);
}
function drawProblemPage(pid) {
  const d = state.problem || {};
  const p = d.problem || {};
  const recs = d.records || [];
  const mind = state.mind || {};
  const rev = mind.review || null;
  const allPits = mind.pitfalls || [];
  const openPits = allPits.filter(x => x.status === 'open').length;
  const rv0 = rev && rev.last_review_at;
  const passedCount = recs.filter(r => r.passed).length;
  app.innerHTML = `<div class="probPage">
    <div class="probHead">
      <a class="back" href="${state.goal ? '#/g/' + state.goal.id + '/hot100' : '#/'}">← 每日刷题</a>
      <h2 class="probTitle">${p.fid}. ${esc(p.title || '')}</h2>
      ${diffChipHTML(p.difficulty)}
      ${(p.tags || []).map(t => `<span class="chip gray">${esc(t)}</span>`).join('')}
      <div class="spacer"></div>
      ${doneToggleHTML({ id: p.id, done: d.done, done_manual: p.done_manual })}
      <button class="btn small primary" id="ideBtn">💻 在 VSCode 中作答</button>
      <a class="btn small" href="${esc(p.link || '#')}" target="_blank" rel="noopener">打开 LeetCode</a>
      <button class="btn small" id="refreshStmt">↻ 刷新题面</button>
    </div>
    <div class="probMeta">
      ${p.done
        ? `<span class="chip ok">${p.passed ? '已通过 ' + passedCount + ' 次' : '已完成'}${p.done_manual >= 0 && !p.passed ? '（手动标记）' : ''}</span>`
        : (recs.length ? '<span class="chip warn">未通过（已作答 ' + recs.length + ' 次）</span>' : '<span class="chip gray">未作答</span>')}
      <span class="muted">知识点：${(p.groups || []).join(' / ') || '—'}</span>
      ${p.done_manual >= 0 ? '<span class="chip gray" title="当前完成状态是手动指定的，不随作答记录变化">手动状态</span>' : ''}
      ${rev
        ? `<span class="pfChip risk ${riskClass(rev.risk)}" title="距上次复习越久、上次没写出来、易错卡没攻克，风险就越高；AI 按它排每天练哪几道">🔁 遗忘风险 ${rev.risk}${rv0 ? ' · 上次 ' + esc(String(rv0).slice(0, 10)) : ' · 还没复习过'}</span>`
        : '<span class="chip gray" title="做对一道题会自动进复习流">不在复习流</span>'}
      ${d.notice ? `<span class="chip danger">题面获取提示：${esc(d.notice)}</span>` : ''}
    </div>
    <div class="probCols">
      <div class="secCard probStmtCard">
        <div class="secHead"><span>📄 题目描述</span><div class="spacer"></div>${p.statement_at ? `<span class="muted" style="font-size:11.5px;">缓存于 ${esc(fmtDate(p.statement_at))}</span>` : ''}</div>
        <div class="lcStatement">${statementHTML(p.statement)}</div>
      </div>
      <div class="secCard probRecCard">
        <div class="secHead"><span>📝 我的作答记录（${recs.length}）</span><div class="spacer"></div>
          <button class="btn tiny" id="coachBtn" title="AI 一次问你一个问题，帮你把思路一步步说清楚">🧭 AI 引导提炼思路</button>
          <button class="btn tiny primary" id="addRecBtn">＋ 记录一次作答</button></div>
        <div class="pfSub" style="padding:9px 2px 0;">每条记录都可以点「尝试重做」：遮住代码凭记忆重敲一遍，AI 对照后帮你把老毛病做成易错卡片。</div>
        <div id="recFormBox"></div>
        <div class="recList">
          ${recs.length ? recs.map(r => `<div class="recItem">
            <div class="recTop">
              <span class="chip ${r.passed ? 'ok' : 'warn'}">${r.passed ? '通过' : '未通过'}</span>
              <span class="recDate">${esc(r.date)}</span>
              ${r.language ? `<span class="chip gray">${esc(r.language)}</span>` : ''}
              ${r.minutes ? `<span class="muted">${r.minutes} 分钟</span>` : ''}
              <div class="spacer"></div>
              <button class="btn tiny" data-redo="${r.id}" title="遮住这份代码，凭记忆重敲一遍，AI 对照后帮你提炼易错点">↻ 尝试重做</button>
              <button class="btn tiny" data-editrec="${r.id}">编辑</button>
              <button class="btn tiny danger" data-delrec="${r.id}">删除</button>
            </div>
            ${!r.code ? '<div class="pfRedoHint">这次没存代码 —— 想用它当重做基准的话，点「编辑」把代码补上。</div>' : ''}
            ${r.notes ? `<div class="recNotes">${esc(r.notes)}</div>` : ''}
            ${r.code ? `<details class="recCode"><summary>查看代码（${r.code.split('\\n').length} 行）</summary><pre class="mdCode"><code>${esc(r.code)}</code></pre></details>` : ''}
          </div>`).join('') : '<div class="muted" style="padding:10px 2px;font-size:13px;">还没有记录。做完一道就记一条：是否通过、用时、代码和笔记 —— 有了代码才能「尝试重做」。</div>'}
        </div>
      </div>
      <div class="secCard probRecCard">
        <div class="secHead"><span>🧭 思路卡</span><div class="spacer"></div>
          ${mind.approach ? `<button class="btn tiny" id="coachAgainBtn">重新提炼</button><button class="btn tiny" id="mindEditBtn">编辑</button>`
            : '<button class="btn tiny" id="coachStartBtn">🧭 和 AI 聊出思路</button>'}</div>
        ${mind.approach
          ? `<div class="pfPitWrap"><div class="pfCardBox"><div class="pfCt">说出来才算会</div>${esc(mind.approach)}</div>
             <div class="pfPitFoot"><span class="pfSub">更新于 ${esc(fmtDate(mind.updated_at || ''))}</span><div class="spacer"></div>
             ${!mind.reference_code ? '<button class="pfBtn sm" id="refSetBtn">用我做对的代码当重做基准</button>' : '<span class="pfChip tag">已存重做基准</span>'}</div></div>`
          : '<div class="pfEmpty"><span class="pfEi">🧭</span>还没有思路卡。<br>做出来之后点上面的「AI 引导提炼思路」，<br>AI 会一次问一个问题，帮你把思路说清楚。</div>'}
      </div>
      <div class="secCard probRecCard">
        <div class="secHead"><span>⚠️ 易错卡片（${openPits} 张待攻克）</span><div class="spacer"></div>
          ${allPits.length ? `<span class="pfSub" title="每次盲写栽的跟脚AI 都会算成同一个点，这里按「犯过几次 × 严重度」排">共 ${allPits.length} 张 · 已攻克 ${allPits.length - openPits}</span>` : ''}</div>
        ${allPits.length ? `<div class="pfPitWrap"><div class="pfPits">${allPits.map(pitCardHTML).join('')}</div></div>`
          : '<div class="pfEmpty"><span class="pfEi">⚠️</span>还没有易错卡片。<br>做一次「尝试重做」，AI 会把你这次栽的跟脚提炼成卡片。</div>'}
      </div>
      ${rev ? `<div class="secCard probRecCard">
        <div class="secHead"><span>🔁 复习状态</span><div class="spacer"></div><button class="btn tiny danger" id="unenqueueBtn">移出复习流</button></div>
        <div class="pfPitWrap">
          <div style="display:flex; align-items:center; gap:11px; flex-wrap:wrap;">
            <span class="pfChip risk ${riskClass(rev.risk)}">遗忘风险 ${rev.risk}/100</span>
            <span class="pfSub">复习过 ${rev.reviews || 0} 次${rev.last_review_at ? ' · 上次 ' + esc(String(rev.last_review_at).slice(0, 10)) : ''}${rev.last_verdict ? ' · 上次' + verdictName(rev.last_verdict) : ''}</span>
            <div class="spacer"></div>
            <span class="pfSub">AI 会按这个风险分排每天练哪几道</span>
          </div>
          ${(rev.why || []).length ? `<div class="pfTaskWhy" style="margin-top:8px;">风险来自：${esc(rev.why.join('、'))}</div>` : ''}
        </div>
      </div>` : `<div class="secCard probRecCard">
        <div class="secHead"><span>🔁 复习状态</span></div>
        <div class="pfPitWrap" style="display:flex; align-items:center; gap:11px; flex-wrap:wrap;">
          <span class="pfSub">这道题不在复习流里。</span><div class="spacer"></div>
          <button class="pfBtn sm" id="enqueueBtn">＋ 加入复习流</button>
        </div>
      </div>`}
    </div>
  </div>`;
  document.getElementById('ideBtn').addEventListener('click', () => openProblemInIDE(pid));
  document.getElementById('refreshStmt').addEventListener('click', async () => {
    app.innerHTML = '<p class="muted">正在从 leetcode.cn 获取题面…</p>';
    try { const nd = await api('/api/problems/' + pid + '?refresh=1'); state.problem = nd; drawProblemPage(pid); toast('题面已更新'); } catch (e) { toast(e.message); drawProblemPage(pid); }
  });
  document.getElementById('addRecBtn').addEventListener('click', () => showRecordForm(pid));
  /* 掌握闭环：状态变了就整页重画（思路卡 / 易错卡 / 复习状态都跟着变） */
  const refreshMind = async () => {
    state.problem = await api('/api/problems/' + pid);
    state.mind = await api('/api/problems/' + pid + '/mind').catch(() => state.mind);
    drawProblemPage(pid);
  };
  /* 引导提炼：作答记录栏的按钮 / 思路卡栏的两个按钮都走这里 */
  const coachBtn = document.getElementById('coachBtn');
  if (coachBtn) coachBtn.addEventListener('click', () => openCoach(pid));
  const csb = document.getElementById('coachStartBtn');
  if (csb) csb.addEventListener('click', () => openCoach(pid));
  const cag = document.getElementById('coachAgainBtn');
  if (cag) cag.addEventListener('click', () => openCoach(pid, true));
  /* 思路卡直接手改（用户可能想自己补几句，不必再过一遍 AI） */
  const meb = document.getElementById('mindEditBtn');
  if (meb) meb.addEventListener('click', () => openMindEditor(pid));
  /* 用最新一条通过的记录当重做基准，省得再粘一次 */
  const rsb = document.getElementById('refSetBtn');
  if (rsb) rsb.addEventListener('click', async () => {
    const withCode = recs.filter(r => r.passed && r.code);
    if (!withCode.length) return toast('没有带代码的通过记录 —— 先在某条记录上点「编辑」把代码补上');
    rsb.disabled = true;
    try {
      await api('/api/problems/' + pid + '/mind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference_code: withCode[0].code }) });
      await refreshMind();
      toast('已用 ' + withCode[0].date + ' 的代码当基准');
    } catch (e) { toast(e.message); rsb.disabled = false; }
  });
  /* 每条作答记录上的「尝试重做」 */
  app.querySelectorAll('[data-redo]').forEach(b => b.addEventListener('click', () => {
    const rec = recs.find(r => r.id === Number(b.getAttribute('data-redo')));
    if (!rec) return;
    if (!String(rec.code || '').trim()) return toast('这条记录没存代码 —— 点「编辑」把代码补上才能当重做基准');
    openRecall(pid, rec);
  }));
  /* 易错卡：攻克 / 删 */
  app.querySelectorAll('[data-pitfix]').forEach(b => b.addEventListener('click', async () => {
    const id = Number(b.getAttribute('data-pitfix'));
    try {
      const card = (state.mind.pitfalls || []).find(x => x.id === id) || {};
      await api('/api/pitfalls/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: card.status === 'fixed' ? 'open' : 'fixed' }) });
      await refreshMind();
      toast(card.status === 'fixed' ? '重新放回待攻克' : '标为已攻克 ✓ 以后优先练别的');
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-pitdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删掉这张易错卡片？')) return;
    try { await api('/api/pitfalls/' + b.getAttribute('data-pitdel'), { method: 'DELETE' }); await refreshMind(); toast('已删除'); } catch (e) { toast(e.message); }
  }));
  /* 复习流：加入 / 移出 */
  const eq = document.getElementById('enqueueBtn');
  if (eq) eq.addEventListener('click', async () => {
    try {
      await api('/api/reviews/' + pid + '/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: state.goal ? state.goal.id : 0 }) });
      await refreshMind();
      toast('已加入复习流 ✓');
    } catch (e) { toast(e.message); }
  });
  const uq = document.getElementById('unenqueueBtn');
  if (uq) uq.addEventListener('click', async () => {
    if (!confirm('移出复习流？思路卡、易错卡片、盲写记录都保留，只是以后不再被排进今天的清单。')) return;
    try { await api('/api/reviews/' + pid, { method: 'DELETE' }); await refreshMind(); toast('已移出复习'); } catch (e) { toast(e.message); }
  });
  app.querySelectorAll('[data-pdone]').forEach(b => b.addEventListener('click', async () => {
    const done = b.getAttribute('data-done') !== '1';
    try {
      await api('/api/problems/' + pid + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done, goal_id: state.goal ? state.goal.id : 0 }) });
      state.problem = await api('/api/problems/' + pid);
      if (state.goal) { try { state.daily = await api('/api/goals/' + state.goal.id + '/daily'); } catch (e) {} }
      drawProblemPage(pid);
      toast(done ? '已标记完成 ✓' : '已取消完成');
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-editrec]').forEach(b => b.addEventListener('click', () => {
    const rec = recs.find(r => r.id === Number(b.getAttribute('data-editrec')));
    if (rec) showRecordForm(pid, rec);
  }));
  app.querySelectorAll('[data-delrec]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这条作答记录？')) return;
    try { await api('/api/records/' + b.getAttribute('data-delrec'), { method: 'DELETE' }); state.problem = await api('/api/problems/' + pid); drawProblemPage(pid); toast('已删除'); } catch (e) { toast(e.message); }
  }));
}
/* ================= 掌握闭环：AI 引导提炼 / 盲写重做 / 易错卡片 ================= */
function riskClass(r) { const n = Number(r) || 0; return n >= 60 ? '' : n >= 35 ? 'mid' : 'low'; }
function verdictName(v) { return { pass: '通过', fuzzy: '写得不完整', forgotten: '没写出来' }[v] || v || ''; }
/** 易错卡片（一行/一张） */
function pitCardHTML(c) {
  const fixed = c.status === 'fixed';
  const dropped = c.status === 'dropped';
  return `<div class="pfPit t-${esc(c.tag || '其它')} ${fixed ? 'isFixed' : ''}" style="${dropped ? 'opacity:.5' : ''}">
    <div class="pfPitTop">
      <span class="pfChip tag">${esc(c.tag || '其它')}</span>
      <span class="pfPitTitle">${esc(c.title)}</span>
      <div class="spacer"></div>
      <span class="pfChip hit ${(c.hits || 1) >= 3 ? '' : 'mid'}" title="一共栽在这上面几次">栽过 ${c.hits || 1} 次</span>
      ${fixed ? '<span class="pfChip fixed">已攻克</span>' : ''}
    </div>
    ${c.detail ? `<div class="pfPitDetail">${esc(c.detail)}</div>` : ''}
    ${c.advice ? `<div class="pfPitAdv"><b>下次怎么避免：</b>${esc(c.advice)}</div>` : ''}
    <div class="pfPitFoot">
      ${c.updated_at ? `<span class="pfSub">${esc(String(c.updated_at).slice(0, 10))}</span>` : ''}
      <div class="spacer"></div>
      ${dropped ? '<span class="pfSub">已标记为不需要</span>'
        : `<button class="pfBtn sm" data-pitfix="${c.id}">${fixed ? '↺ 放回待攻克' : '✓ 标为已攻克'}</button>
           <button class="pfBtn sm ghost danger" data-pitdel="${c.id}" title="删掉这张卡">删除</button>`}
    </div>
  </div>`;
}
/** 通用浮层。返回 {mask, win, body, foot, close} */
function openLayer(title, sub, opts) {
  const o = opts || {};
  const mask = document.createElement('div');
  mask.className = 'pfMask';
  mask.innerHTML = `<div class="pfWin ${o.narrow ? 'narrow' : ''}">
    <div class="pfHead">
      <span class="pfHT">${title}</span>
      ${sub ? `<span class="pfHS">${sub}</span>` : ''}
      <div class="spacer"></div>
      ${o.headExtra || ''}
      <button class="pfX" data-close title="关闭">✕</button>
    </div>
    <div class="pfBody"></div>
    ${o.foot === false ? '' : '<div class="pfFoot"></div>'}
  </div>`;
  document.body.appendChild(mask);
  const win = mask.querySelector('.pfWin');
  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
    if (o.onClose) o.onClose();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  /* 点遮罩空白处关掉，点窗内不关 */
  mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
  mask.querySelector('[data-close]').addEventListener('click', close);
  return { mask, win, body: mask.querySelector('.pfBody'), foot: mask.querySelector('.pfFoot'), close };
}
/* ---- 引导提炼：AI 一次问一个问题 ---- */
async function openCoach(pid, restart) {
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('🧭 AI 引导提炼思路', esc(prob.fid + '. ' + (prob.title || '')), { narrow: true });
  const render = () => {
    const sess = (state.mind && state.mind.session) || null;
    const steps = sess ? (sess.steps || []) : [];
    L.body.innerHTML = `<div class="pfThread" id="pfThread"></div>
      <div class="pfStepLbl"><b>你</b><span>我怎么想就怎么说，不用组织语言 —— AI 会顺着往下问</span></div>
      <textarea class="pfSay" id="pfSay" placeholder="比如：我就是觉得两层循环太慢，想能不能只走一遍…"></textarea>
      <div class="pfSub" style="margin-top:8px;">回车换行，点「下一问」发给 AI</div>`;
    const th = L.body.querySelector('#pfThread');
    if (sess && sess.summary) {
      th.innerHTML = `<div class="pfCardBox"><div class="pfCt">整理好的思路卡（还没存进存档）</div>${esc(sess.summary)}</div>`;
    } else if (!steps.length) {
      th.innerHTML = '<div class="pfEmpty" style="padding:18px 10px;"><span class="pfEi">🎓</span>AI 一次只问你一个问题。<br>先从「这题要你做的事，用一句话怎么说」开始，<br>它会顺着你的回答一层层往下挖。</div>';
    } else {
      th.innerHTML = steps.map((s, i) => {
        const me = `<div class="pfTurn me"><div class="pfAv">我</div><div class="pfBubble"><span class="pfLabel">我说</span>${esc(s.a)}</div></div>`;
        if (!s.q) return me;
        return `<div class="pfTurn"><div class="pfAv">🎓</div><div class="pfBubble"><span class="pfLabel">AI 问</span>${esc(s.q)}</div></div>` + me;
      }).join('');
    }
    th.scrollIntoView ? L.body.scrollTo({ top: L.body.scrollHeight }) : 0;
    L.foot.innerHTML = `<span class="pfSub" id="pfStep"></span><div class="spacer"></div>
      ${(state.mind && state.mind.approach) ? '<button class="pfBtn sm" data-clear>从头再聊</button>' : ''}
      <button class="pfBtn sm" data-ask>下一问 →</button>
      <button class="pfBtn sm go" data-finish title="把聊出来的内容整理成一张思路卡">整理成思路卡</button>
      ${sess && sess.summary ? '<button class="pfBtn sm go" data-save>💾 存进思路卡</button>' : ''}`;
    L.foot.querySelector('[data-ask]').addEventListener('click', () => askNext(restart));
    const fin = L.foot.querySelector('[data-finish]');
    fin.addEventListener('click', () => finishCoach(L, pid));
    const sv = L.foot.querySelector('[data-save]');
    if (sv) sv.addEventListener('click', async () => {
      sv.disabled = true; sv.textContent = '保存中…';
      try {
        await api('/api/problems/' + pid + '/mind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approach: state.mind.session.summary }) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        L.close(); drawProblemPage(pid); toast('思路卡已存好 ✓');
      } catch (e) { toast(e.message); sv.disabled = false; sv.textContent = '💾 存进思路卡'; }
    });
    const clr = L.foot.querySelector('[data-clear]');
    if (clr) clr.addEventListener('click', async () => {
      try { await api('/api/problems/' + pid + '/mind/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); state.mind = await api('/api/problems/' + pid + '/mind'); render(); toast('已清空，重新开始'); }
      catch (e) { toast(e.message); }
    });
    if (restart) askNext(true);
  };
  const setAsk = on => {
    const b = L.foot.querySelector('[data-ask]');
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? 'AI 想问题中…' : '下一问 →';
    const t = L.foot.querySelector('#pfStep');
    if (t && on) t.textContent = '';
    const th = L.body.querySelector('#pfThread');
    const tip = th && th.lastElementChild && th.lastElementChild.classList.contains('pfTurn') ? null : null;
    if (on && th) th.insertAdjacentHTML('beforeend', '<div class="pfTurn" id="pfWait"><div class="pfAv">🎓</div><div class="pfBubble pfTyping"><i></i><i></i><i></i></div></div>');
    if (!on && th) { const w = th.querySelector('#pfWait'); if (w) w.remove(); }
    const say = L.body.querySelector('#pfSay');
    if (say) say.disabled = on;
  };
  const askNext = async (forceNew) => {
    const say = L.body.querySelector('#pfSay');
    const ans = say ? say.value.trim() : '';
    if (!forceNew && !ans && !(state.mind && state.mind.session && (state.mind.session.steps || []).length)) return toast('先说说你怎么想的');
    setAsk(true);
    L.body.scrollTo({ top: L.body.scrollHeight });
    try {
      const body = forceNew ? {} : { answer: ans };
      await api('/api/problems/' + pid + '/mind/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!forceNew && say) say.value = '';
      state.mind = await api('/api/problems/' + pid + '/mind');
      setAsk(false);
      render();
      const s = L.body.querySelector('#pfSay'); if (s) s.focus();
    } catch (e) { setAsk(false); toast(e.message); }
  };
  const finishCoach = async (ly, xpid) => {
    const b = ly.foot.querySelector('[data-finish]');
    b.disabled = true; b.textContent = '整理中…';
    try {
      const r = await api('/api/problems/' + xpid + '/mind/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.mind = await api('/api/problems/' + xpid + '/mind');
      render();
      toast('整理好了，确认后点「存进思路卡」');
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = '整理成思路卡'; }
  };
  render();
  if (restart) setTimeout(() => askNext(true), 0);
  const say = L.body.querySelector('#pfSay');
  if (say) {
    say.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askNext(false); });
    say.focus();
  }
}
/** 直接手改思路卡（不必再过一遍 AI） */
function openMindEditor(pid) {
  const cur = (state.mind && state.mind.approach) || '';
  const L = openLayer('🧭 编辑思路卡', '你自己补几句也行', { narrow: true, foot: false });
  L.body.innerHTML = `<textarea class="pfSay" id="pfMe" style="min-height:340px;">${esc(cur)}</textarea>
    <div class="pfSub" style="margin-top:8px;">建议照这个骨架写：一句话概括 / 关键洞察 / 解题步骤 / 复杂度 / 记忆钩子</div>`;
  L.foot ? L.foot.remove() : 0;
  const bar = document.createElement('div');
  bar.className = 'pfFoot';
  bar.innerHTML = '<div class="spacer"></div><button class="pfBtn sm" data-cancel>取消</button><button class="pfBtn sm go" data-save>保存</button>';
  L.win.appendChild(bar);
  bar.querySelector('[data-cancel]').addEventListener('click', L.close);
  bar.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      await api('/api/problems/' + pid + '/mind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approach: document.getElementById('pfMe').value }) });
      state.mind = await api('/api/problems/' + pid + '/mind');
      L.close(); drawProblemPage(pid); toast('已保存');
    } catch (e) { toast(e.message); }
  });
  L.body.querySelector('#pfMe').focus();
}
/* ---- 盲写重做：遮住参考代码，凭记忆重敲，AI 对照后出易错卡片 ---- */
function openRecall(pid, rec) {
  const prob = (state.problem && state.problem.problem) || {};
  const ref = String(rec.code || '');
  const L = openLayer('↻ 尝试重做', esc(prob.fid + '. ' + (prob.title || '') + ' · ' + (rec.date || '')), { narrow: false });
  let t0 = Date.now(), timer = null;
  const body = () => L.body.innerHTML = `<div class="pfWarn"><span>⚠️</span><div>下面这份是<b>你 ${esc(rec.date || '')} 交的代码，已经藏起来了</b>。别偷看 —— 盲写的意思就是凭记忆重敲一遍，抄一遍等于没练。<br>写完提交，AI 会对照两份代码，告诉你哪里漏了、哪里错了，并把这次的跟脚做成易错卡片。</div></div>
    <div class="pfStepLbl"><b>1</b><span>先看一眼题面（想不起来再看）</span><div class="spacer"></div><span class="pfTimer" id="pfT">00:00</span></div>
    <div class="pfRefBox"><div class="pfRefHd"><span>📄 我的参考代码</span>
      <span class="pfSub">${ref.split('\n').length} 行 · ${esc(rec.language || '')}</span><div class="spacer"></div>
      <button class="pfBtn sm" data-peek>偷看一眼（会扣分，慎用）</button>
      <span class="pfSub" id="pfPeeked" style="display:none;color:var(--danger);">已偷看</span></div>
      <pre id="pfRef" style="display:none;">${esc(ref)}</pre></div>
    <div class="pfStepLbl"><b>2</b><span>凭记忆重写一遍</span></div>
    <textarea class="pfCode" id="pfMy" placeholder="想到哪写到哪，写不出来的先跳过往下写 —— 空白和半成品也要提交，AI 才知道你卡在哪"></textarea>
    <div id="pfOut"></div>`;
  body();
  L.foot.innerHTML = `<span class="pfSub" id="pfFMsg">提交后 AI 会判定你的思路一致度，并把这次的跟脚做成卡片</span><div class="spacer"></div>
    <button class="pfBtn sm" data-close2>关闭</button>
    <button class="pfBtn sm go" data-check>提交给 AI 对照</button>`;
  L.foot.querySelector('[data-close2]').addEventListener('click', L.close);
  L.foot.querySelector('[data-peek]');
  const peekBtn = () => L.body.querySelector('[data-peek]');
  if (peekBtn()) peekBtn().addEventListener('click', () => {
    const pre = L.body.querySelector('#pfRef'), tag = L.body.querySelector('#pfPeeked');
    if (pre.style.display === 'none') { pre.style.display = ''; tag.style.display = ''; toast('偷看过了 —— 这次的一致度会偏低，但卡片照做'); }
  });
  /* 计时器：盲写限时更容易暴露「哪里卡住」 */
  timer = setInterval(() => {
    const el = L.body.querySelector('#pfT');
    if (!el) return clearInterval(timer);
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
  const doCheck = async () => {
    const code = (L.body.querySelector('#pfMy') || {}).value || '';
    if (!code.trim()) return toast('还没写呢 —— 盲写的意思是先凭记忆敲一遍');
    const btn = L.foot.querySelector('[data-check]');
    btn.disabled = true; btn.textContent = 'AI 对照中…';
    const msg = L.foot.querySelector('#pfFMsg');
    msg.textContent = 'AI 在逐行对照两份代码，可能要十几秒…';
    const out = L.body.querySelector('#pfOut');
    out.innerHTML = '<div class="pfTyping" style="padding:16px 4px;"><i></i><i></i><i></i></div>';
    try {
      const r = await api('/api/problems/' + pid + '/recall/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ my_code: code, ref_code: ref, goal_id: state.goal ? state.goal.id : 0 })
      });
      state.mind = await api('/api/problems/' + pid + '/mind');
      clearInterval(timer);
      btn.disabled = false; btn.textContent = '再写一次';
      msg.textContent = '这次结果已存进易错卡片和复习进度';
      out.innerHTML = recallResultHTML(r) + pitCardHTML({ id: 0, title: '', tag: '', hits: 0, detail: '' });
      out.lastElementChild.remove();
      L.body.scrollTo({ top: L.body.scrollHeight });
    } catch (e) {
      btn.disabled = false; btn.textContent = '提交给 AI 对照';
      msg.textContent = '对照失败：' + e.message;
      out.innerHTML = '';
    }
  };
  L.foot.querySelector('[data-check]').addEventListener('click', doCheck);
  L.mask._timer = timer;
  const origClose = L.close;
  L.close = () => { clearInterval(timer); origClose(); };
  setTimeout(() => { const t = L.body.querySelector('#pfMy'); if (t) t.focus(); }, 60);
}
/** 盲写对照结论 */
function recallResultHTML(r) {
  const rep = (r && r.report) || {};
  const v = rep.verdict || 'fuzzy';
  const sc = Number(rep.score) || 0;
  const cls = sc >= 85 ? 'good' : sc >= 55 ? 'mid' : 'bad';
  const vname = { pass: '这次真写出来了', fuzzy: '思路在，细节漏了', forgotten: '核心思路没想起来' }[v] || v;
  const mine = r.cards || [];
  const open = mine.filter(c => c.status === 'open');
  return `<div class="pfCardBox" style="margin-top:18px;border-color:var(--border);background:var(--bg);">
    <div class="pfCt">3 · AI 对照结果</div>
    <div class="pfScore">
      <div class="pfRing ${cls}"><b>${sc}</b><i>一致度</i></div>
      <div><div class="pfVerdict ${v}">${vname}</div>
        <div class="pfSub" style="margin-top:3px;">思路一致度看的是「关键决策点」对不对，不是代码写法像不像</div></div>
    </div>
    ${(rep.got || []).length ? `<ul class="pfLst good">${rep.got.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(rep.missed || []).length ? `<ul class="pfLst miss">${rep.missed.map(m => `<li><b>漏了：${esc(m.what)}</b>${m.why ? `<span class="pfWhy">${esc(m.why)}${m.fix ? ' → ' + esc(m.fix) : ''}</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${rep.hint ? `<div class="pfHint">💡 ${esc(rep.hint)}</div>` : ''}
    <div class="pfSub" style="margin-top:12px;">${r.newCards ? '新增 ' + r.newCards + ' 张易错卡片' : ''}${r.mergedCards ? '（把 ' + r.mergedCards + ' 张并进了你以前栽过的同一个坑）' : ''}${!r.newCards && !r.mergedCards ? '这次没发现新的坑 —— 说明确实记住了' : ''}</div>
    ${open.length ? `<div class="pfPits" style="margin-top:10px;">${open.map(pitCardHTML).join('')}</div>` : ''}
  </div>`;
}

/** 作答记录表单。传 rec 就是编辑那条记录（预填 + 走 PUT），不传是新增。 */
function showRecordForm(pid, rec) {
  const box = document.getElementById('recFormBox');
  if (!box) return;
  const editing = !!(rec && rec.id);
  const s = (state.problem && state.problem.settings) || {};
  const langs = (state.problem && state.problem.langs) || [];
  const today = new Date();
  const tstr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const curLang = editing && rec.language ? rec.language : s.language;
  const curDate = editing ? String(rec.date || tstr).slice(0, 10) : tstr;
  const curMin = editing ? Number(rec.minutes) || 0 : 30;
  box.innerHTML = `<div class="recForm">
    <div class="rfFormHead"><span>${editing ? '✏️ 编辑记录 #' + rec.id : '＋ 新增记录'}</span><div class="spacer"></div>${editing ? '<button class="btn tiny" id="rfToNew">改为新增一条</button>' : ''}</div>
    <div class="rfRow">
      <label>日期<input type="date" id="rfDate" value="${esc(curDate)}"></label>
      <label>语言<select id="rfLang">${langs.map(l => `<option value="${esc(l.id)}" ${l.id === curLang ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>用时(分)<input type="number" id="rfMin" min="0" max="600" value="${curMin}"></label>
      <label class="rfPass"><input type="checkbox" id="rfPass" ${editing && rec.passed ? 'checked' : ''}> 通过</label>
    </div>
    <div class="field"><div class="rfCodeHead"><span>代码</span><div class="spacer"></div><button class="btn tiny" id="rfRead">从 VSCode 文件读取</button></div>
      <textarea id="rfCode" placeholder="粘贴你在 VSCode / LeetCode 里提交的代码（可留空）">${esc(editing ? rec.code : '')}</textarea></div>
    <div class="field"><textarea id="rfNotes" placeholder="笔记：思路 / 卡在哪 / 学到什么（可留空）">${esc(editing ? rec.notes : '')}</textarea></div>
    <div class="toolbarRow"><button class="btn primary" id="rfSave">${editing ? '保存修改' : '保存记录'}</button><button class="btn" id="rfCancel">取消</button></div>
  </div>`;
  document.getElementById('rfCancel').addEventListener('click', () => { box.innerHTML = ''; });
  const toNew = document.getElementById('rfToNew');
  if (toNew) toNew.addEventListener('click', () => showRecordForm(pid));
  document.getElementById('rfRead').addEventListener('click', async () => {
    try {
      const r = await api('/api/problems/' + pid + '/solution?lang=' + encodeURIComponent(document.getElementById('rfLang').value));
      if (!r.exists) return toast('未找到文件：' + r.file + '（先点「在 VSCode 中作答」生成）');
      document.getElementById('rfCode').value = r.code;
      toast('已读取 ' + r.file.split('/').pop());
    } catch (e) { toast(e.message); }
  });
  document.getElementById('rfSave').addEventListener('click', async () => {
    const payload = {
      date: document.getElementById('rfDate').value,
      language: document.getElementById('rfLang').value,
      minutes: Number(document.getElementById('rfMin').value) || 0,
      passed: document.getElementById('rfPass').checked,
      code: document.getElementById('rfCode').value,
      notes: document.getElementById('rfNotes').value,
      goal_id: state.goal ? state.goal.id : 0
    };
    try {
      if (editing) await api('/api/records/' + rec.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      else await api('/api/problems/' + pid + '/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.problem = await api('/api/problems/' + pid);
      if (state.goal) { try { state.daily = await api('/api/goals/' + state.goal.id + '/daily'); } catch (e) {} }
      box.innerHTML = '';
      drawProblemPage(pid);
      toast(editing ? '记录已更新' : '记录已保存');
    } catch (e) { toast(e.message); }
  });
}


  SiErXing.registerPlugin({
    id: 'hot100',
    goalEntry: {
      label: '每日刷题',
      icon: '🧩',
      order: 20,
      header: true,           // 进目标页顶栏的标签栏（收藏栏）
      hash: gid => '#/g/' + gid + '/hot100',
      show: goal => SiErXing.pluginEnabled(goal, 'hot100')
    },
    routes: [
      {
        match: h => h.match(/^#\/g\/(\d+)\/hot100$/),
        render: async m => { await SiErXing.loadGoal(Number(m[1])); await renderDailyPage(); }
      },
      {
        match: h => h.match(/^#\/p\/(\d+)$/),
        render: async m => { await SiErXing.ensureGoal(); await renderProblemPage(Number(m[1])); }
      }
    ]
  });
})();
