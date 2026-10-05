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
  /* 易错卡片按「是哪一次提交栽的」分组：record_id 是服务端精确记下的
     practice_records.id（不是靠时间猜的），所以一次提交对应一组卡，不同提交不会串。
     没有 record_id 的老卡片归到「未归属」组，弹窗里单独一栏。 */
  const pitByRec = {};
  for (const c of allPits) {
    const rid = Number(c.record_id) || 0;
    if (!rid) continue;
    (pitByRec[rid] = pitByRec[rid] || []).push(c);
  }
  for (const k of Object.keys(pitByRec)) pitByRec[k].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const orphanPits = allPits.filter(c => !Number(c.record_id));
  const pitCount = (rid) => (pitByRec[rid] || []).filter(c => c.status === 'open').length;
  app.innerHTML = `<div class="probPage">
    <div class="probSticky">
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
        <button class="btn small" id="probMoreBtn" data-morebtn-of="prob" hidden>⋯</button>
        <button class="btn small" data-tbtn id="probPitBtn" title="易错卡片：AI 从每次盲写的差距里提炼出来的老毛病，按「是哪一次提交栽的」分组，可攻克/删">⚠️ 易错卡片${allPits.length ? ' ' + allPits.length : ''}</button>
        <button class="btn small" data-tbtn id="probMindBtn" title="思路卡：用你自己的话说清楚这道题，AI 帮你整理">🧭 思路卡</button>
        <button class="btn small" data-tbtn id="probRevBtn" title="复习状态：遗忘风险、上次判定、AI 排期">🔁 复习状态</button>
        <button class="btn small" data-tbtn id="probRecallBtn" title="历次盲写考核的判定与当时的记忆钩子">📈 盲写考核记录${(mind.recallTests || []).length ? ' ' + mind.recallTests.length : ''}</button>
        <button class="btn small" data-tbtn id="probCoachBtn" title="AI 读你写的，自己判断还缺哪一块，只补那一块">🎓 引导提炼思路</button>
        ${rev ? '<button class="btn small danger" data-tbtn id="probOutBtn" title="移出复习流（思路卡、易错卡片、盲写记录都保留）">移出复习流</button>'
          : '<button class="btn small" data-tbtn id="probEnqBtn" title="加入复习流，做对时会自动进来">＋ 加入复习流</button>'}
      </div>
      <div class="tutFavBar" id="probFavBar" hidden></div>
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
          <button class="btn tiny primary" id="addRecBtn">＋ 记录一次作答</button></div>
        <div class="pfSub" style="padding:9px 2px 0;">每条记录上方可以「看这次的易错点」，也可以「尝试重做」：遮住代码凭记忆重敲一遍，AI 对照后把这次的跟脚做成易错卡片。</div>
        <div id="recFormBox"></div>
        <div class="recList">
          ${recs.length ? recs.map(r => {
            /* 每条作答记录各自的易错点（recallTests 带 problem_id，这里按时间就近配）——
               不同题目的错点不通用，所以按记录归属而不是混成一个大列表 */
            const mine = pitByRec[r.id] || [];
            return `<div class="recItem">
            ${mine.length ? `<div class="recPitTop">
              <span class="recPitLbl">这次栽的 ${mine.length}</span>
              ${mine.map(c => `<button class="pfPitTag t-${esc(c.tag || '其它')}" data-openpit="${c.id}" title="${esc(c.title)}（点开看全文）">${esc(c.tag || '其它')}·${esc(c.title)}</button>`).join('')}
            </div>` : ''}
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
          </div>`;
          }).join('') : '<div class="muted" style="padding:10px 2px;font-size:13px;">还没有记录。做完一道就记一条：是否通过、用时、代码和笔记 —— 有了代码才能「尝试重做」。</div>'}
        </div>
      </div>
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
  /* ---- 顶栏（吸顶收藏栏）上的功能键：三个模块都是弹窗，不占正文 ---- */
  const onTop = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  onTop('probPitBtn', () => openPitView(pid));
  onTop('probRecallBtn', () => openRecallView(pid));
  onTop('probMindBtn', () => openMindView(pid));
  onTop('probRevBtn', () => openRevView(pid));
  onTop('probCoachBtn', () => openCoach(pid, !!(mind.approach)));
  onTop('probEnqBtn', async () => {
    try { await api('/api/reviews/' + pid + '/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: state.goal ? state.goal.id : 0 }) }); await refreshMind(); toast('已加入复习流 ✓'); }
    catch (e) { toast(e.message); }
  });
  onTop('probOutBtn', async () => {
    if (!confirm('移出复习流？思路卡、易错卡片、盲写记录都保留，只是以后不再被排进今天的清单。')) return;
    try { await api('/api/reviews/' + pid, { method: 'DELETE' }); await refreshMind(); toast('已移出复习'); } catch (e) { toast(e.message); }
  });
  /* 收藏栏：钉选 + 收藏夹 + 拖拽排序，用宿主那套现成实现（ns='prob'） */
  if (typeof applyBarOverflow === 'function') { try { applyBarOverflow('prob'); } catch (e) { console.warn('题目页收藏栏：' + e.message); } }
  /* 每条作答记录上的「尝试重做」 */
  app.querySelectorAll('[data-redo]').forEach(b => b.addEventListener('click', () => {
    const rec = recs.find(r => r.id === Number(b.getAttribute('data-redo')));
    if (!rec) return;
    if (!String(rec.code || '').trim()) return toast('这条记录没存代码 —— 点「编辑」把代码补上才能当重做基准');
    openRecall(pid, rec);
  }));
  /* 每条作答记录上方那枚易错点小片：点开只看这一张（不同题目的错点不通用，不跳走上下文） */
  app.querySelectorAll('[data-openpit]').forEach(b => b.addEventListener('click', () => openPitView(pid, b.getAttribute('data-openpit'))));
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
/* ===== 代码框增强：Tab 缩进、换行自动续行、括号引号补全 =====
   敲代码时 Tab 默认会把焦点跳走，一个字都敲不下去 —— 这在盲写重做里尤其致命，
   因为你正闭着眼回忆代码，一按 Tab 就丢了焦点。 */
function bindCodeEditor(ta, opts) {
  if (!ta || ta.dataset.codeEd === '1') return;
  ta.dataset.codeEd = '1';
  const o = opts || {};
  const INDENT = o.indent || '    ';
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  const insert = (text, sel) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
    if (sel) ta.setSelectionRange(s + sel[0], s + sel[1]);
    else ta.setSelectionRange(s + text.length, s + text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const lineBounds = pos => {
    const v = ta.value;
    let a2 = v.lastIndexOf('\n', pos - 1) + 1;
    let b2 = v.indexOf('\n', pos); if (b2 < 0) b2 = v.length;
    return [a2, b2];
  };
  ta.addEventListener('keydown', ev => {
    const s = ta.selectionStart, e2 = ta.selectionEnd;
    if (ev.key === 'Tab') {
      ev.preventDefault();                       // 不让焦点跑掉
      if (s === e2 && !ev.shiftKey) {
        /* 没选中东西 = 插一级缩进。
           ⚠️ 别去判断「这一行有没有缩进」再决定插多少 —— 行尾没缩进时会算出 0，
           于是 Tab 什么都不插，敲代码时最难排查的那种「按了没反应」。 */
        insert(INDENT);
        return;
      }
      /* 选中了多行：整块缩进 / 反缩进 */
      const [ls, le] = lineBounds(s);
      const block = ta.value.slice(ls, le);
      const next = ev.shiftKey
        ? block.replace(new RegExp('^ {1,' + INDENT.length + '}', 'gm'), '')
        : block.replace(/^/gm, INDENT);
      ta.setRangeText(next, ls, le, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      /* 回车自动带上当前缩进；若行尾是 { [ ( 就再多一级 */
      const [ls, le] = lineBounds(s);
      const cur = ta.value.slice(ls, s);
      const ind = (cur.match(/^[ \t]*/) || [''])[0];
      /* 行尾是 { [ ( 就多缩进一级 —— 敲代码时最烦的就是自己敲缩进。
         用 endsWith 逐个判，不写正则：字符类里嵌方括号容易把正则写坏。 */
      const tail = cur.replace(/\s+$/, '');
      const opens = tail.endsWith('{') || tail.endsWith('[') || tail.endsWith('(');
      const pad = opens ? ind + INDENT : ind;
      ev.preventDefault();
      insert('\n' + pad);
      return;
    }
    if (PAIRS[ev.key] && o.brackets !== false && s === e2) {
      const nx = ta.value[s] || '';
      /* 右边已经是对应的闭合符就别再补一遍 */
      if (nx === PAIRS[ev.key] || nx === ')' && ev.key === '(') { ev.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return; }
      ev.preventDefault();
      insert(ev.key + PAIRS[ev.key], [1, 1]);
    }
  });
}

/* ================= 掌握闭环：AI 引导提炼 / 盲写重做 / 易错卡片 ================= */
function riskClass(r) { const n = Number(r) || 0; return n >= 60 ? '' : n >= 35 ? 'mid' : 'low'; }
/* ---- 三个模块都做成弹窗：卡片一多（一百条易错卡？）页面会被撑爆，
       而弹窗里能滚动、能排序、还能顺手操作，页面只留题目和作答记录。 ---- */
/** 思路卡弹窗：成品 + 参考代码基准 */
function openMindView(pid) {
  const mind = state.mind || {};
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('🧭 思路卡', esc((prob.fid || '') + '. ' + (prob.title || '')), { narrow: true });
  const paint = () => {
    const m = state.mind || {};
    L.body.innerHTML = m.approach
      ? `<div class="pfCardBox"><div class="pfCt">说出来才算会</div>${esc(m.approach)}</div>
         <div class="pfSub" style="margin-top:9px;">更新于 ${esc(fmtDate(m.updated_at || ''))}</div>`
      : '<div class="pfEmpty"><span class="pfEi">🧭</span>还没有思路卡。<br>做出来之后点下面的「AI 引导提炼思路」，<br>它一次问你一个问题，帮你把思路说清楚。</div>';
    const ref = (m.reference_code || '').trim();
    /* 参考代码不再单设按钮：点「尝试重做」时用的就是那次提交的代码当基准，
       再摆一个「设基准」只会让人以为要先配置才能用。 */
    L.foot.innerHTML = `${m.approach ? '<span class="pfSub">更新于 ' + esc(fmtDate(m.updated_at || '')) + '</span>'
      : '<span class="pfSub">盲写基准直接取那次提交的代码，不用单独设</span>'}
      <div class="spacer"></div>
      ${m.approach ? '<button class="pfBtn sm" data-edit>编辑</button><button class="pfBtn sm" data-coach>重新提炼</button>' : ''}
      <button class="pfBtn sm go" data-coach>🎓 AI 引导提炼思路</button>`;
    L.foot.querySelectorAll('[data-coach]').forEach(b => b.addEventListener('click', () => { L.close(); openCoach(pid, !!m.approach); }));
    const eb = L.foot.querySelector('[data-edit]');
    if (eb) eb.addEventListener('click', () => { L.close(); openMindEditor(pid); });
    void ref;
  };
  paint();
}
/** 重画题目页（思路卡 / 易错卡 / 复习状态都跟着变） */
async function refreshMindView(pid) {
  state.problem = await api('/api/problems/' + pid);
  state.mind = await api('/api/problems/' + pid + '/mind').catch(() => state.mind);
  drawProblemPage(pid);
}
/** 易错卡片弹窗：按权重排序，可攻克/放回/删 */
function openPitView(pid, only) {
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('⚠️ 易错卡片', esc((prob.fid || '') + '. ' + (prob.title || '')));
  const paint = () => {
    const all = (state.mind && state.mind.pitfalls) || [];
    /* only: 从某条作答记录点进来的 → 只看那张卡的全文（不跳走上下文） */
    if (only) {
      const one = all.find(c => c.id === Number(only));
      L.body.innerHTML = one ? pitCardHTML(one)
        : '<div class="pfEmpty"><span class="pfEi">🔍</span>这张卡已经不在了。</div>';
      L.foot.innerHTML = '<span class="pfSub">从某次作答记录点进来的，只看这一张</span><div class="spacer"></div><button class="pfBtn sm" data-all>看全部卡片</button>';
      L.foot.querySelector('[data-all]').addEventListener('click', () => { L.close(); openPitView(pid); });
    } else {
      /* 按「是哪一次提交栽的」分组 —— 不同提交的错点不通用，混在一起看不出改进了没有 */
      const recs = (state.problem && state.problem.records) || [];
      const byRec = {};
      for (const c of all) { const k = Number(c.record_id) || 0; (byRec[k] = byRec[k] || []).push(c); }
      const order = { 边界: 0, 下标: 1, 逻辑: 2, 复杂度: 3, 算法选择: 4, 状态定义: 5, 语法: 6, 其它: 7 };
      const byWeight = (a, b) => (order[a.tag] ?? 8) - (order[b.tag] ?? 8) || (b.weight || 0) - (a.weight || 0);
      /* 分组按作答记录的时间顺序排（新的在上面），每组内按权重 */
      const keys = Object.keys(byRec).map(Number).sort((a, b) => {
        const ra = recs.find(r => r.id === a), rb = recs.find(r => r.id === b);
        return String(rb ? rb.created_at || rb.date : '').localeCompare(String(ra ? ra.created_at || ra.date : '')) || (b - a);
      });
      const groupHTML = k => {
        const list = byRec[k].slice().sort(byWeight);
        const rec = k ? recs.find(r => r.id === k) : null;
        const openN = list.filter(c => c.status === 'open').length;
        const head = k
          ? `<div class="pfGrpHd"><span class="pfChip ${rec && rec.passed ? 'ok' : 'warn'}">${esc(rec ? rec.date : '第 ' + k + ' 次提交')}</span>
             ${rec && rec.language ? `<span class="pfChip tag">${esc(rec.language)}</span>` : ''}
             <span class="pfSub">${openN ? openN + ' 张待攻克' : '都攻克了'} · 共 ${list.length} 张</span></div>`
          : '<div class="pfGrpHd"><span class="pfSub">早期做的盲写（没记归属）</span></div>';
        const open = list.filter(c => c.status === 'open');
        const rest = list.filter(c => c.status !== 'open');
        return `<section class="pfGrp">${head}
            ${open.length ? `<div class="pfPits">${open.map(pitCardHTML).join('')}</div>` : ''}
            ${rest.length ? `<details class="pfFold"><summary>已攻克 / 已忽略 · ${rest.length} 张</summary><div class="pfPits">${rest.map(pitCardHTML).join('')}</div></details>` : ''}
          </section>`;
      };
      const totalOpen = all.filter(c => c.status === 'open').length;
      L.body.innerHTML = all.length
        ? `${totalOpen ? '' : '<div class="pfEmpty" style="padding:16px 8px;"><span class="pfEi">🎉</span>这道题的坑你都攻克了。</div>'}
           ${keys.map(groupHTML).join('')}`
        : '<div class="pfEmpty"><span class="pfEi">⚠️</span>还没有易错卡片。<br>在下面任意一条作答记录上点「↻ 尝试重做」，<br>AI 会把你这次栽的跟脚提炼成卡片。</div>';
      L.foot.innerHTML = `<span class="pfSub">按提交分组 · 组内按「类别 → 犯过几次 × 严重度」排</span><div class="spacer"></div>
        <button class="pfBtn sm go" data-redo>↻ 去做一次盲写考核</button>`;
      const rb = L.foot.querySelector('[data-redo]');
      if (rb) rb.addEventListener('click', () => {
        const rec = ((state.problem && state.problem.records) || []).filter(r => String(r.code || '').trim())[0];
        if (!rec) return toast('还没有存代码的作答记录 —— 先记录一次并把代码贴进去');
        L.close(); openRecall(pid, rec);
      });
    }
    L.foot.insertAdjacentHTML('afterend', '');
    /* 易错卡按钮在弹窗里也要能用 */
    L.body.querySelectorAll('[data-pitfix]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-pitfix'));
      const card = ((state.mind || {}).pitfalls || []).find(x => x.id === id) || {};
      b.disabled = true;
      try {
        await api('/api/pitfalls/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: card.status === 'fixed' ? 'open' : 'fixed' }) });
        state.mind = await api('/api/problems/' + pid + '/mind').catch(() => state.mind);
        paint();
        if (state.problem) { const l = await api('/api/problems/' + pid); state.problem = l; }
        drawProblemPage(pid);
        toast(card.status === 'fixed' ? '放回待攻克' : '标为已攻克 ✓');
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
    L.body.querySelectorAll('[data-pitdel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('删掉这张易错卡片？')) return;
      try { await api('/api/pitfalls/' + b.getAttribute('data-pitdel'), { method: 'DELETE' }); state.mind = await api('/api/problems/' + pid + '/mind').catch(() => state.mind); paint(); toast('已删除'); }
      catch (e) { toast(e.message); }
    }));
  };
  paint();
}
/** 盲写考核记录弹窗：历次判定 + 当时的记忆钩子，按时间倒序 */
function openRecallView(pid) {
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('📈 盲写考核记录', esc((prob.fid || '') + '. ' + (prob.title || '')), { narrow: true });
  const paint = () => {
    const tests = ((state.mind || {}).recallTests) || [];
    const recs = (state.problem && state.problem.records) || [];
    const verb = s => ({ pass: '思路完整，细节没漏', fuzzy: '思路在，细节漏了', forgotten: '没想出核心思路' }[s] || s || '');
    L.body.innerHTML = tests.length
      ? '<div class="pfPits">' + tests.map(t => {
        const rec = t.record_id ? recs.find(r => r.id === Number(t.record_id)) : null;
        const rep = safeParse(t.report, {}) || {};
        const cls = t.score >= 85 ? 'fixed' : t.score >= 55 ? 'hit mid' : 'hit';
        return '<div class="pfPit" style="border-style:dashed;">'
          + '<div class="pfPitTop">'
          + '<span class="pfChip ' + cls + '">一致度 ' + t.score + '%</span>'
          + '<span class="pfPitTitle" style="font-weight:600;">' + esc(verb(t.verdict)) + '</span>'
          + '<div class="spacer"></div>'
          + '<span class="pfSub">' + esc(String(t.created_at || '').slice(0, 10)) + '</span></div>'
          + (rec ? '<div class="pfPitDetail">对照基准：' + esc(rec.date) + ' 那次提交的代码' + (rec.language ? '（' + esc(rec.language) + '）' : '') + '</div>' : '')
          + ((rep.got || []).length ? '<div class="pfPitAdv"><b>想起来了：</b>' + esc((rep.got || []).join('；')) + '</div>' : '')
          + ((rep.missed || []).length ? '<div class="pfPitAdv"><b>漏了：</b>' + esc((rep.missed || []).map(m => m.what).join('；')) + '</div>' : '')
          + (rep.hint ? '<div class="pfPitAdv"><b>当时的钩子：</b>' + esc(rep.hint) + '</div>' : '')
          + '</div>';
      }).join('') + '</div>'
      : '<div class="pfEmpty"><span class="pfEi">📈</span>还没做过盲写考核。<br>在「作答记录」里任意一条上点「↻ 尝试重做」。<br><br>遮住代码凭记忆重敲一遍，AI 对照后告诉你漏了什么。</div>';
    const withCode = recs.filter(r => String(r.code || '').trim());
    L.foot.innerHTML = '<span class="pfSub">共 ' + tests.length + ' 次 · 与「易错卡片」按提交一一对应</span><div class="spacer"></div>'
      + '<button class="pfBtn sm" data-cancel>关闭</button>'
      + (withCode.length ? '<button class="pfBtn sm go" data-redo>↻ 再做一次</button>' : '');
    const c = L.foot.querySelector('[data-cancel]'); if (c) c.addEventListener('click', L.close);
    const r = L.foot.querySelector('[data-redo]');
    if (r) r.addEventListener('click', () => { const rec = withCode[0]; L.close(); openRecall(pid, rec); });
  };
  paint();
}
/** 一次题目的所有提炼对话：切换 / 重命名 / 删除。默认按日期命名。 */
function openSessionList(pid) {
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('💬 提炼对话', esc((prob.fid || '') + '. ' + (prob.title || '')), { narrow: true });
  const paint = () => {
    const sesss = ((state.mind || {}).sessions) || [];
    L.body.innerHTML = sesss.length
      ? '<div class="pfSessList">' + sesss.map(s => '<div class="pfSessItem' + (s.isCurrent ? ' cur' : '') + '" data-sid="' + s.id + '">'
        + '<div class="pfSessInfo">'
        + '<div class="pfSessT">' + esc(s.title) + (s.named ? '' : ' <span class="pfChip gray">默认名</span>') + '</div>'
        + '<div class="pfSessM">已聊 ' + s.turns + ' 轮' + (s.hasSummary ? ' · 已整理成思路卡' : '') + (s.hasPending ? ' · 有一问等你答' : '')
        + ' · ' + esc(String(s.created_at || '').slice(5, 16).replace('T', ' ')) + '</div></div>'
        + '<div class="pfSessBtns">'
        + (s.isCurrent ? '<span class="pfChip tag">正在聊</span>'
          : '<button class="pfBtn sm" data-go="' + s.id + '">继续聊</button>')
        + '<button class="pfBtn sm" data-rename="' + s.id + '">重命名</button>'
        + '<button class="pfBtn sm ghost danger" data-del="' + s.id + '">删除</button>'
        + '</div></div>').join('') + '</div>'
      : '<div class="pfEmpty"><span class="pfEi">💬</span>还没有提炼过。<br>点下面「开一次新的」开始。</div>';
    L.foot.innerHTML = '<span class="pfSub">默认按日期命名；重命名后不会再被自动覆盖</span><div class="spacer"></div>'
      + '<button class="pfBtn sm" data-close>关闭</button>'
      + '<button class="pfBtn sm go" data-new2>＋ 开一次新的</button>';
    L.body.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('/api/problems/' + pid + '/mind/sessions/' + b.getAttribute('data-go'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        L.close();
        openCoach(pid);
      } catch (e) { toast(e.message); }
    }));
    L.body.querySelectorAll('[data-rename]').forEach(b => b.addEventListener('click', async () => {
      const sid = Number(b.getAttribute('data-rename'));
      const cur = sesss.find(x => x.id === sid) || {};
      const name = (prompt('这次对话叫什么？（留空=恢复默认日期名）', cur.title || '') || '').trim().slice(0, 40);
      if (name === (cur.title || '')) return;
      try {
        await api('/api/problems/' + pid + '/mind/sessions/' + sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name }) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        paint();
        toast(name ? '已改名' : '已恢复默认日期名');
      } catch (e) { toast(e.message); }
    }));
    L.body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const sid = Number(b.getAttribute('data-del'));
      const cur = sesss.find(x => x.id === sid) || {};
      if (!confirm('删掉「' + cur.title + '」这次对话？\\n\\n这里的问答记录会没掉，收不回来。思路卡、易错卡片不受影响。')) return;
      try {
        await api('/api/problems/' + pid + '/mind/sessions/' + sid, { method: 'DELETE' });
        state.mind = await api('/api/problems/' + pid + '/mind');
        paint();
        toast('已删除');
      } catch (e) { toast(e.message); }
    }));
    const c = L.foot.querySelector('[data-close]'); if (c) c.addEventListener('click', L.close);
    const n2 = L.foot.querySelector('[data-new2]');
    if (n2) n2.addEventListener('click', async () => {
      try {
        await api('/api/problems/' + pid + '/mind/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        L.close();
        openCoach(pid);
        setTimeout(() => toast('开了一次新对话，之前的都留着'), 200);
      } catch (e) { toast(e.message); }
    });
  };
  paint();
}
/** 复习状态弹窗：风险、进度、进入/移出复习流 */
function openRevView(pid) {
  const prob = (state.problem && state.problem.problem) || {};
  const L = openLayer('🔁 复习状态', esc((prob.fid || '') + '. ' + (prob.title || '')), { narrow: true });
  const paint = () => {
    const rev = (state.mind || {}).review;
    if (!rev) {
      L.body.innerHTML = '<div class="pfEmpty"><span class="pfEi">🔁</span>这道题不在复习流里。<br>加入之后 AI 会按遗忘风险，帮你排「今天该练哪几道」。</div>';
      L.foot.innerHTML = '<div class="spacer"></div><button class="pfBtn sm" data-cancel>关闭</button><button class="pfBtn sm go" data-enq>＋ 加入复习流</button>';
    } else {
      L.body.innerHTML = `
        <div style="display:flex; align-items:center; gap:11px; flex-wrap:wrap;">
          <span class="pfChip risk ${riskClass(rev.risk)}">遗忘风险 ${rev.risk}/100</span>
          <div class="pfBar ${riskClass(rev.risk)}" style="max-width:180px;"><i style="width:${Math.max(4, Math.min(100, Number(rev.risk) || 0))}%"></i></div>
        </div>
        ${(rev.why || []).length ? `<div class="pfPitAdv" style="margin-top:11px;"><b>风险来自：</b>${esc(rev.why.join('、'))}</div>` : ''}
        <ul class="pfLst good" style="margin-top:13px;">
          <li>复习过 <b>${rev.reviews || 0}</b> 次</li>
          <li>上次复习：<b>${rev.last_review_at ? esc(String(rev.last_review_at).slice(0, 10)) : '还没复习过'}</b>${rev.last_verdict ? '（' + verdictName(rev.last_verdict) + '）' : ''}</li>
          <li>最近盲写：<b>${rev.last_score >= 0 ? rev.last_score + '%' : '还没盲写验证过'}</b></li>
        </ul>
        <div class="pfSub" style="margin-top:12px;">复习进度由「盲写重做」的 AI 判定自动更新，不需要手动打分。</div>`;
      L.foot.innerHTML = '<div class="spacer"></div><button class="pfBtn sm" data-cancel>关闭</button><button class="pfBtn sm danger" data-out>移出复习流</button>';
    }
    const c = L.foot.querySelector('[data-cancel]'); if (c) c.addEventListener('click', L.close);
    const e = L.foot.querySelector('[data-enq]');
    if (e) e.addEventListener('click', async () => {
      try { await api('/api/reviews/' + pid + '/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal_id: state.goal ? state.goal.id : 0 }) }); await refreshMindView(pid); L.close(); toast('已加入复习流 ✓'); }
      catch (err) { toast(err.message); }
    });
    const o = L.foot.querySelector('[data-out]');
    if (o) o.addEventListener('click', async () => {
      if (!confirm('移出复习流？思路卡、易错卡片、盲写记录都保留，只是以后不再被排进今天的清单。')) return;
      try { await api('/api/reviews/' + pid, { method: 'DELETE' }); await refreshMindView(pid); L.close(); toast('已移出复习'); }
      catch (err) { toast(err.message); }
    });
  };
  paint();
}
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
  /* 维度 key → 中文名。检查表、打标、提示词三处都要用，集中在这一处免得各写一份。 */
  const dimName = k => { const d = ((state.mind || {}).dims || []).find(x => x.key === k); return d ? d.name : ''; };
  /* render 会整块重建 #pfSay，不保住的话用户在输入框里写了一半的内容会被清空
     （点一次「下一问」或收到 AI 回包都会触发重绘）。
     keepDraft：null = 沿用输入框现值；'' = 提交过了，主动清空。 */
  let keepDraft = null;
  const render = () => {
    const prev = L.body.querySelector('#pfSay');
    if (keepDraft === null) keepDraft = prev ? prev.value : '';
    const sess = (state.mind && state.mind.session) || null;
    const steps = sess ? (sess.steps || []) : [];
    const dims = (state.mind && state.mind.dims) || [];
    const hitAll = (state.mind && state.mind.hit) || [];
    /* pending = 当前正在等回答的那一问（还没配对成一步，所以要单独画出来） */
    const pend = sess && sess.pending ? sess.pending : null;
    const focusKey = pend ? String(pend.focus || 'refine') : 'refine';
    const talked = steps.filter(s => String(s.a || '').trim() && s.probe).length;
    const allDone = !!(pend && pend.done) || talked >= 10;
    L.body.innerHTML = '<div class="pfSessBar" id="pfSessBar"></div>'
      + '<div class="pfRail" id="pfRail"></div>'
      + '<div class="pfThread" id="pfThread"></div>'
      + '<div class="pfStepLbl"><b>你</b><span>'
      + (allDone ? '聊得差不多了，可以整理成思路卡'
        : (pend && pend.read ? 'AI 判断你<i>' + esc(pend.read) + '</i>，现在补这一块' : '我怎么想就怎么说，不用组织语言'))
      + '</span></div>'
      + '<textarea class="pfSay" id="pfSay" placeholder="比如：我就是觉得两层循环太慢，想能不能只走一遍…"></textarea>';
    /* 覆盖清单：不是顺序剧本，是「值得覆盖到」的检查表 ——
       ✓ = AI 判断你已经讲到；高亮 = AI 这一轮选中的关注点。 */
    const rail = L.body.querySelector('#pfRail');
    rail.innerHTML = '<div class="pfRailHd"><span>覆盖清单</span><span class="pfSub">' + hitAll.length + '/' + dims.length
      + ' 已讲到 · AI 自己挑下一个问什么</span></div>'
      + '<div class="pfDims">' + dims.map(d => {
        const on = hitAll.indexOf(d.key) >= 0;
        return '<span class="pfDim' + (on ? ' on' : '') + (d.key === focusKey ? ' cur' : '')
          + '" title="' + esc(d.ask || d.name) + '">' + (on ? '✓ ' : '') + esc(d.name) + '</span>';
      }).join('')
      /* 「打磨」不是清单里的一格（它不是维度，是状态），但 AI 选它时也得有东西可高亮，
         否则用户看不到「它现在要干什么」 */
      + (focusKey === 'refine' ? '<span class="pfDim cur refine" title="他已经把核心思路讲成型了 —— 这一轮改问能让思路更扎实的东西，而不是继续走清单">✦ 打磨</span>' : '')
      + '</div>';
    /* ⚠️ 气泡不能一边 pre-wrap 一边在模板里为了排版留换行缩进 ——
       那些空白会被原样渲染成一大片空隙（用户报过的「输出上方有巨大空白」）。
       所以 pre-wrap 只作用在 .pfTxt 这一层，气泡本身按普通块排版（跟 restate 组件一致）。 */
    const hintHTML = s => (s.hintText
      ? '<div class="pfTurn"><div class="pfAv">💡</div><div class="pfBubble hint">'
        + '<div class="pfLabel">只给方向，不给答案</div>'
        + (s.hintSay ? '<div class="pfTxt">' + esc(s.hintSay) + '</div>' : '')
        + '<div class="pfTxt">' + esc(s.hintText) + '</div></div></div>' : '');
    const turnHTML = s => {
      const d = dimName(s.focus) || '打磨';
      const hitTxt = (s.hit || []).map(k => dimName(k) || k).join('、');
      return '<div class="pfTurn"><div class="pfAv">🎓</div><div class="pfBubble">'
        + '<div class="pfLabel">关注「' + esc(d) + '」' + (hitTxt ? '　·　你已讲到：' + esc(hitTxt) : '') + '</div>'
        + (s.say ? '<div class="pfTxt">' + esc(s.say) + '</div>' : '')
        + '<div class="pfQ">' + esc(s.probe || '') + '</div>'
        + hintHTML(s)
        + '</div></div>';
    };
    /* 用户气泡不写「我说」那行：它会在气泡上方多撑出一条空白横杠，看着像多了个空行 */
    const meHTML = s => '<div class="pfTurn me"><div class="pfAv">我</div><div class="pfBubble">'
      + '<div class="pfTxt">' + esc(s.a) + '</div></div></div>';
    let th = '';
    if (sess && sess.summary) {
      th = '<div class="pfCardBox"><div class="pfCt">整理好的思路卡（还没存进存档）</div>' + esc(sess.summary) + '</div>';
    } else if (!steps.length && !pend) {
      th = '<div class="pfEmpty" style="padding:18px 10px;"><span class="pfEi">🎓</span>'
        + 'AI 会读你写的，自己判断还缺哪一块，然后<b>只补那一块</b>。<br>'
        + '你已经说清楚的地方，它不会再让你重说一遍。<br><br>如果第一句还没出来，点「下一问」。</div>';
    } else {
      th = steps.map(s => (s.probe ? turnHTML(s) : '') + meHTML(s)).join('')
        + (pend && pend.probe ? turnHTML(pend) : '');
    }
    if (allDone && sess && !sess.summary) {
      th += '<div class="pfEmpty" style="padding:14px 10px;"><span class="pfEi">🎉</span>聊得差不多了。<br>'
        + '点下面「整理成思路卡」，AI 会把你说的整理成一张能背下来的卡。</div>';
    }
    L.body.querySelector('#pfThread').innerHTML = th;
    /* 会话栏：默认按日期命名，可切到历史继续聊 / 重命名 / 删 / 清空当前 */
    const sesss = (state.mind && state.mind.sessions) || [];
    const cur = sesss[0];
    const bar = L.body.querySelector('#pfSessBar');
    bar.innerHTML = sesss.length > 1 || (cur && cur.turns)
      ? '<button class="pfSessCur" data-switch title="查看这次题目的所有提炼对话">💬 '
        + esc(cur ? cur.title : '') + (cur && cur.turns ? '　·　已聊 ' + cur.turns + ' 轮' : '')
        + (sesss.length > 1 ? '　（共 ' + sesss.length + ' 次）' : '') + '</button>'
      : '<span class="pfSessCur none">💬 新的一次提炼　·　默认按日期命名</span>';
    const sw = bar.querySelector('[data-switch]');
    if (sw) sw.addEventListener('click', () => openSessionList(pid));
    const sayEl = L.body.querySelector('#pfSay');
    if (sayEl) { sayEl.value = keepDraft == null ? '' : keepDraft; keepDraft = null; }
    L.body.scrollTop = L.body.scrollHeight;
    L.foot.innerHTML = '<span class="pfSub" id="pfStep">聊了 ' + talked + ' 轮'
      + (dimName(focusKey) ? ' · 当前关注「' + esc(dimName(focusKey)) + '」' : '') + '</span><div class="spacer"></div>'
      + '<button class="pfBtn sm" data-new title="另开一次提炼，这次的问答留着（默认按日期命名）">＋ 新对话</button>'
      + '<button class="pfBtn sm ghost" data-clear title="清空这次对话的问答（历史不动，思路卡与易错卡也不受影响）">清空</button>'
      + ((allDone && !(sess && sess.summary)) ? '' : '<button class="pfBtn sm" data-hint title="不给答案，只把方向指出来">💡 卡住了，提示我</button>')
      + ((allDone && !(sess && sess.summary)) ? '' : '<button class="pfBtn sm" data-ask>下一问 →</button>')
      + '<button class="pfBtn sm go" data-finish title="把聊出来的内容整理成一张思路卡">整理成思路卡</button>'
      + ((sess && sess.summary) ? '<button class="pfBtn sm go" data-save>💾 存进思路卡</button>' : '');
    const ab = L.foot.querySelector('[data-ask]');
    if (ab) ab.addEventListener('click', () => askNext(false, false));
    const hb2 = L.foot.querySelector('[data-hint]');
    if (hb2) hb2.addEventListener('click', () => askNext(false, true));
    const fin = L.foot.querySelector('[data-finish]');
    fin.addEventListener('click', () => finishCoach(L, pid));
    const sv = L.foot.querySelector('[data-save]');
    if (sv) sv.addEventListener('click', async () => {
      const un2 = busyBtn(sv, '保存中');
      try {
        await api('/api/problems/' + pid + '/mind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approach: state.mind.session.summary }) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        L.close(); drawProblemPage(pid); toast('思路卡已存好 ✓');
      } catch (e) { un2(); toast(e.message); }
    });
    const clr = L.foot.querySelector('[data-clear]');
    if (clr) clr.addEventListener('click', async () => {
      const cur = ((state.mind || {}).sessions || [])[0];
      if (!cur) return toast('当前没有对话');
      if (!confirm('清空「' + cur.title + '」这次对话的问答？\n\n思路卡、易错卡片都不受影响。想保留问答就别清，用「＋ 新对话」另开一次。')) return;
      try {
        await api('/api/problems/' + pid + '/mind/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: cur.id }) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        render();
        toast(cur.turns ? '已清空 ' + cur.turns + ' 轮问答' : '这次对话本来就是空的');
      } catch (e) { toast(e.message); }
    });
    const nw = L.foot.querySelector('[data-new]');
    if (nw) nw.addEventListener('click', async () => {
      nw.disabled = true;
      try {
        await api('/api/problems/' + pid + '/mind/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        state.mind = await api('/api/problems/' + pid + '/mind');
        keepDraft = '';
        render();
        setTimeout(() => askNext(true, false), 0);
        toast('开了一次新对话，之前的都留着');
      } catch (e) { toast(e.message); nw.disabled = false; }
    });
  };
  const setAsk = (on, hint) => {
    const b = L.foot.querySelector('[data-ask]');
    const hb = L.foot.querySelector('[data-hint]');
    if (b) { b.disabled = on; b.textContent = on && hint ? '给提示中…' : on ? 'AI 想问题中…' : '下一问 →'; }
    if (hb) hb.disabled = on;
    const t = L.foot.querySelector('#pfStep');
    if (t && on) t.textContent = hint ? '💡 只给方向，不给答案…' : '';
    const th = L.body.querySelector('#pfThread');
    if (on && th) th.insertAdjacentHTML('beforeend', '<div class="pfTurn" id="pfWait"><div class="pfAv">🎓</div><div class="pfBubble pfTyping"><i></i><i></i><i></i></div></div>');
    if (!on && th) { const w = th.querySelector('#pfWait'); if (w) w.remove(); }
    const say = L.body.querySelector('#pfSay');
    if (say) say.disabled = on;
    L.body.scrollTop = L.body.scrollHeight;
  };
  /* 乐观上屏：点「下一问」的瞬间就把用户这句话显示出来（AI 还在想，它的话随后补上）。
     等 AI 回完再一起渲染的话，用户会以为自己没点上 —— 十几秒的空白期体验很差。 */
  const showOwnNow = txt => {
    const th = L.body.querySelector('#pfThread');
    if (!th) return;
    th.querySelectorAll('.pfPending').forEach(n => n.remove());
    th.insertAdjacentHTML('beforeend', '<div class="pfTurn me pfPending"><div class="pfAv">我</div><div class="pfBubble">'
      + '<div class="pfTxt">' + esc(txt) + '</div></div></div>');
    L.body.scrollTop = L.body.scrollHeight;
  };
  const dropOwnNow = () => {
    const th = L.body.querySelector('#pfThread');
    if (th) th.querySelectorAll('.pfPending').forEach(n => n.remove());
  };
  const askNext = async (forceNew, hint) => {
    const say = L.body.querySelector('#pfSay');
    const ans = say ? say.value.trim() : '';
    const sessNow = state.mind && state.mind.session;
    const hasSteps = !!(sessNow && (sessNow.steps || []).length) || !!(sessNow && sessNow.pending);
    /* 提示不用先回答（他可能就是卡在回答之前）；提问要有话可说，或已经有那一问等着 */
    if (!forceNew && !hint && !ans && !hasSteps) return toast('先说说你怎么想的');
    /* 只有真的提交了回答才先上屏；点「提示我」不消费输入框里的字，它还要留着 */
    if (!hint && !forceNew && ans) { showOwnNow(ans); keepDraft = ''; if (say) say.value = ''; }
    setAsk(true, hint);
    try {
      /* 点「提示我」时把输入框里已写的那半句也发过去 —— 他多半就是卡在这句上 */
      const body = forceNew ? { hint: false } : (hint ? { hint: true, draft: ans } : { answer: ans });
      await api('/api/problems/' + pid + '/mind/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.mind = await api('/api/problems/' + pid + '/mind');
      setAsk(false);
      dropOwnNow();
      render();
      const s = L.body.querySelector('#pfSay'); if (s && !hint) s.focus();
    } catch (e) { setAsk(false); dropOwnNow(); toast(e.message); }
  };
  /* 整理思路卡是个 10~30 秒的长任务。不给任何反馈的话，整个浮层看着就像卡死了 ——
     所以：顶部插一条带转圈的横幅、按钮自己转圈、其它按钮照常能用、
     再加个超时兜底，绝不让它无声无息地挂着。 */
  const busyBar = (title, tip, onCancel) => {
    const el = document.createElement('div');
    el.className = 'pfBusy';
    el.id = 'pfBusyBox';
    el.innerHTML = '<div class="pfSpin"></div><div style="flex:1;min-width:0;"><b>' + esc(title) + '</b><br>' + tip + '</div>';
    if (onCancel) {
      const c = document.createElement('button');
      c.className = 'pfBusyCancel'; c.textContent = '知道了';
      c.addEventListener('click', () => el.remove());
      el.appendChild(c);
    }
    const th = L.body.querySelector('#pfThread');
    if (th) th.parentElement.insertBefore(el, th); else L.body.insertBefore(el, L.body.firstChild);
    return el;
  };
  const busyBtn = (b, text) => {
    if (!b) return () => {};
    const old = b.innerHTML;
    b.disabled = true;
    b.innerHTML = '<span class="pfSpin"></span>' + esc(text);
    return () => { b.disabled = false; b.innerHTML = old; };
  };
  const finishCoach = async (ly, xpid) => {
    const b = ly.foot.querySelector('[data-finish]');
    if (b && b.disabled) return;
    const unbusy = busyBtn(b, 'AI 正在整理');
    const bar = busyBar('AI 正在把你说的整理成思路卡…',
      '要把这几次对话压成「关键洞察 / 解题步骤 / 复杂度 / 记忆钩子」，通常十几到三十秒。<br>这一步会调模型，慢是正常的 —— 不是卡住了。', true);
    /* 超时兜底：120 秒还没回来就明说，别让用户对着一个不动的界面猜 */
    const to = setTimeout(() => { if (bar && bar.isConnected) bar.innerHTML = '<div>⏳ 已经 2 分钟了，模型可能比较慢。你可以先关掉窗口，等一会儿再点「整理成思路卡」重试。</div>'; }, 120000);
    try {
      const r = await api('/api/problems/' + xpid + '/mind/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      clearTimeout(to);
      if (bar) bar.remove();
      unbusy();
      state.mind = await api('/api/problems/' + xpid + '/mind');
      render();
      toast('整理好了，检查一下再点「存进思路卡」');
    } catch (e) {
      clearTimeout(to);
      if (bar) bar.remove();
      unbusy();
      toast(e.message);
    }
  };
  /* 开场就问第一句 —— 打开浮层只看到一个空盒子，正是「看不出引导在哪」的最直接原因。
   已经有会话在聊的就不重问（重开会把上次的话冲掉）。 */
  const fresh = !((state.mind && state.mind.session && (state.mind.session.steps || []).length)
    || (state.mind && state.mind.session && state.mind.session.summary));
  render();
  if (restart || fresh) setTimeout(() => askNext(true, false), 0);
  const say = L.body.querySelector('#pfSay');
  if (say) {
    say.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askNext(false, false); });
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
    <div class="pfSub" style="margin-top:6px;">Tab 缩进 · Shift+Tab 反缩进 · 回车自动续行 · 括号引号自动配对</div>
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
        /* record_id 让 AI 提炼出的易错卡片能精确挂到「是哪一次提交」上 */
        body: JSON.stringify({ my_code: code, ref_code: ref, record_id: Number(rec.id) || 0, goal_id: state.goal ? state.goal.id : 0 })
      });
      state.mind = await api('/api/problems/' + pid + '/mind');
      clearInterval(timer);
      btn.disabled = false; btn.textContent = '再写一次';
      msg.textContent = '这次结果已存进易错卡片和复习进度';
      out.innerHTML = recallResultHTML(r);
      const gp = out.querySelector('[data-gopit]');
      if (gp) gp.addEventListener('click', () => { L.close(); openPitView(pid); });
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
  setTimeout(() => { const t = L.body.querySelector('#pfMy'); if (t) { bindCodeEditor(t); t.focus(); } }, 60);
}
/** 盲写对照结论。分「判定 / 想起来了 / 漏了什么 / 钩子 / 易错卡」五块，
    每块有小标题和分隔，别把判定、清单、结论、卡片堆成一大坨看不出层次。 */
function recallResultHTML(r) {
  const rep = (r && r.report) || {};
  const v = rep.verdict || 'fuzzy';
  const sc = Number(rep.score) || 0;
  const cls = sc >= 85 ? 'good' : sc >= 55 ? 'mid' : 'bad';
  const vname = { pass: '这次真写出来了', fuzzy: '思路在，细节漏了', forgotten: '核心思路没想起来' }[v] || v;
  const vtip = {
    pass: '关键决策点都对上了',
    fuzzy: '大方向没跑偏，但有该写没写的',
    forgotten: '连核心结构都没想起来，回去先看思路卡'
  }[v] || '';
  const got = (rep.got || []).filter(Boolean);
  const missed = (rep.missed || []).filter(m => m && m.what);
  const open = ((r && r.cards) || []).filter(c => c.status === 'open');
  const sec = (label, tone, inner) => inner ? '<div class="pfRSec ' + tone + '"><div class="pfRSecL">' + esc(label) + '</div>' + inner + '</div>' : '';
  const ul = (items, cls2) => '<ul class="pfLst ' + cls2 + '">' + items.map(x => '<li>' + x + '</li>').join('') + '</ul>';
  const added = [];
  if (r.newCards) added.push('新增 ' + r.newCards + ' 张');
  if (r.mergedCards) added.push(r.mergedCards + ' 张并进了你以前栽过的同一个坑');
  const addedTxt = added.length ? added.join('，')
    : ((r.cards || []).length ? '这次没发现新的坑 —— 说明确实记住了' : '这次没提炼出错点');
  return '<div class="pfRCard">'
    + '<div class="pfRHead"><span class="pfRHeadT">③ AI 对照结果</span>'
    + '<span class="pfScore2 ' + cls + '"><b>' + sc + '</b><i>一致度</i></span></div>'
    + '<div class="pfRVerdict ' + v + '"><b>' + esc(vname) + '</b><span>' + esc(vtip) + '</span></div>'
    + '<div class="pfRNote">一致度看的是「关键决策点」对不对，不是代码写法像不像。</div>'
    + sec('你想起来了', 'good', got.length ? ul(got.map(esc)) : '')
    + sec('漏了什么', 'miss', missed.length ? ul(missed.map(m => '<b>' + esc(m.what) + '</b>'
      + (m.why ? '<span class="pfWhy">' + esc(m.why) + '</span>' : '')
      + (m.fix ? '<span class="pfFix">→ ' + esc(m.fix) + '</span>' : ''))) : '')
    + (rep.hint ? '<div class="pfHint"><span>💡</span><div>' + esc(rep.hint) + '</div></div>' : '')
    + '<div class="pfRFoot"><span>' + esc(addedTxt) + '</span>'
    + (open.length ? '<button class="pfBtn sm" data-gopit>看看易错卡片（' + open.length + '）→</button>' : '')
    + '</div>'
    + (open.length ? '<div class="pfPits pfRNew">' + open.map(pitCardHTML).join('') + '</div>' : '')
    + '</div>';
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
  bindCodeEditor(document.getElementById('rfCode'));
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
