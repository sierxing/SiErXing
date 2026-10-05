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
  const [list, daily] = await Promise.all([
    api('/api/problems'),
    api('/api/goals/' + g.id + '/daily')
  ]);
  state.problems = list.problems || [];
  state.problemGroups = list.groups || [];
  state.daily = daily;
  drawDailyPage();
}
function drawDailyPage() {
  const g = state.goal;
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
      ${(state.problemGroups || []).map(gr => `<details class="probGroup">
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
      drawDailyPage();
      toast(done ? '已标记完成 ✓' : '已取消完成');
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
    toast('已用 VSCode 打开：' + r.file.split('/').pop() + (r.created ? '（已生成模板）' : '') + '　题名已复制');
  } catch (e) { toast('打开失败：' + e.message); }
}
async function renderProblemPage(pid) {
  app.innerHTML = '<p class="muted">加载题目…</p>';
  const d = await api('/api/problems/' + pid);
  state.problem = d;
  drawProblemPage(pid);
}
function drawProblemPage(pid) {
  const d = state.problem || {};
  const p = d.problem || {};
  const recs = d.records || [];
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
      ${d.notice ? `<span class="chip danger">题面获取提示：${esc(d.notice)}</span>` : ''}
    </div>
    <div class="probCols">
      <div class="secCard probStmtCard">
        <div class="secHead"><span>📄 题目描述</span><div class="spacer"></div>${p.statement_at ? `<span class="muted" style="font-size:11.5px;">缓存于 ${esc(fmtDate(p.statement_at))}</span>` : ''}</div>
        <div class="lcStatement">${statementHTML(p.statement)}</div>
      </div>
      <div class="secCard probRecCard">
        <div class="secHead"><span>📝 我的作答记录（${recs.length}）</span><div class="spacer"></div><button class="btn tiny primary" id="addRecBtn">＋ 记录一次作答</button></div>
        <div id="recFormBox"></div>
        <div class="recList">
          ${recs.length ? recs.map(r => `<div class="recItem">
            <div class="recTop">
              <span class="chip ${r.passed ? 'ok' : 'warn'}">${r.passed ? '通过' : '未通过'}</span>
              <span class="recDate">${esc(r.date)}</span>
              ${r.language ? `<span class="chip gray">${esc(r.language)}</span>` : ''}
              ${r.minutes ? `<span class="muted">${r.minutes} 分钟</span>` : ''}
              <div class="spacer"></div>
              <button class="btn tiny" data-editrec="${r.id}">编辑</button>
              <button class="btn tiny danger" data-delrec="${r.id}">删除</button>
            </div>
            ${r.notes ? `<div class="recNotes">${esc(r.notes)}</div>` : ''}
            ${r.code ? `<details class="recCode"><summary>查看代码（${r.code.split('\\n').length} 行）</summary><pre class="mdCode"><code>${esc(r.code)}</code></pre></details>` : ''}
          </div>`).join('') : '<div class="muted" style="padding:10px 2px;font-size:13px;">还没有记录。每次作答后记录：是否通过、用时、代码和笔记，方便复盘。</div>'}
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
