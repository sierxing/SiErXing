/* 思而行 · 前端逻辑（原生 JS，零依赖） */

const app = document.getElementById('app');
const AI_PRESETS = [
  { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: '' },
  { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: 'qwen-vl-max' },
  { name: 'Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vision: '' },
  { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', vision: 'glm-4v-plus' },
  { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', vision: '' },
  { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: 'gpt-4o' },
  { name: '本地 Ollama', base: 'http://localhost:11434/v1', model: 'qwen2.5:14b', vision: '', key: 'ollama' }
];

const state = { goals: [], goal: null, sources: [], planning: false, collecting: false, collectStatus: '', expanded: {}, filter: '', models: [], model: '', showNew: false, showEdit: false, mapScale: 1, mapTx: 40, mapTy: 40, _drag: null, _suppressClick: false };

/* ============ 主题（白天/黑夜） ============ */
function currentThemeEff() {
  const t = localStorage.getItem('sierxing-theme') || 'auto';
  if (t !== 'auto') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  const t = localStorage.getItem('sierxing-theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeBtn') || document.getElementById('railTheme');
  if (btn) btn.textContent = currentThemeEff() === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  localStorage.setItem('sierxing-theme', currentThemeEff() === 'dark' ? 'light' : 'dark');
  applyTheme();
}
/* 教程页跟随主题：切换后重新渲染 */
try { const rr0 = parseRoute(); if (rr0.view === 'tutorial') renderTutorialPage(rr0.id); } catch (e) {}
applyTheme();

/* 单段文本的行内 Markdown（**粗体** / `代码` / 链接 / *斜体*）→ HTML（先转义，安全） */
function mdOneLine(text) {
  return mdInline(mdEscape(String(text == null ? '' : text)));
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function safeParse(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } }
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ============ 路由 ============ */
function parseRoute() {
  const h = location.hash || '#/';
  const tm = h.match(/^#\/t\/(\d+)$/);
  if (tm) return { view: 'tutorial', id: Number(tm[1]) };
  const cm = h.match(/^#\/g\/(\d+)\/chat$/);
  if (cm) return { view: 'goal', id: Number(cm[1]), openAI: true };

  const dm = h.match(/^#\/g\/(\d+)\/diff\/(\d+)$/);
  if (dm) return { view: 'diff', id: Number(dm[1]), vid: Number(dm[2]) };
  const m = h.match(/^#\/g\/(\d+)(\/map)?$/);
  if (m) return { view: m[2] ? 'map' : 'goal', id: Number(m[1]) };
  const gd = h.match(/^#\/guide\/(\d+)$/);
  if (gd) return { view: 'guide', step: Math.max(1, Math.min(9, Number(gd[1]))) };
  if (h.startsWith('#/settings')) return { view: 'settings' };
  if (h.startsWith('#/components')) return { view: 'components' };
  if (h.startsWith('#/library')) return { view: 'library' };
  // 插件页面路由（由前端插件声明）
  const pr = window.SiErXing ? SiErXing.matchRoute(h) : null;
  if (pr) return { view: 'plugin', pluginId: pr.plugin.id, route: pr.route, match: pr.match };
  return { view: 'home' };
}
window.addEventListener('hashchange', route);
app.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); go(g.getAttribute('data-go')); }
});
/* 进入组件管理页的入口在左侧栏中渲染 */
(function initAI() {
  let savedW = 0, savedH = 0;
  try {
    state.aiOpen = localStorage.getItem('sierxing-ai-open') === '1';
    savedW = Number(localStorage.getItem('sierxing-ai-width')) || 0;
    savedH = Number(localStorage.getItem('sierxing-ai-input-h')) || 0;
  } catch (e) {}
  aiEnsureDOM();
  aiApplyWidth(savedW || 440, false);
  aiApplyInputH(savedH || 60, false);
  const fab = document.getElementById('aiFab');
  if (fab) fab.classList.add('hidden');
})();
document.addEventListener('click', e => {
  const panel = document.getElementById('nodePanel');
  if (!panel) return;
  if (e.target.closest('.nodePanel') || e.target.closest('.ctxMenu') || e.target.closest('[data-detail]') || e.target.closest('[data-cycle]') || e.target.closest('#nextOpen')) return;
  panel.remove();
  const npMask = document.getElementById('nodePanelMask'); if (npMask) npMask.remove();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const panel = document.getElementById('nodePanel');
    if (panel) { panel.remove(); const m = document.getElementById('nodePanelMask'); if (m) m.remove(); }
    document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  }
});
document.addEventListener('contextmenu', e => {
  const el = e.target.closest('[data-node-id]');
  if (!el || !state.goal) return;
  const r = parseRoute();
  if (r.view !== 'goal' && r.view !== 'map') return;
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, Number(el.getAttribute('data-node-id')));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.ctxMenu')) document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
});
window.addEventListener('scroll', () => document.querySelectorAll('.ctxMenu').forEach(m => m.remove()), true);
window.addEventListener('mousemove', e => {
  const d = state._drag;
  if (!d) return;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
  if (!d.moved) return;
  state.mapTx = d.ox + dx;
  state.mapTy = d.oy + dy;
  applyCanvasTransform();
});
window.addEventListener('mouseup', () => {
  const d = state._drag;
  if (!d) return;
  const vp = document.getElementById('mapViewport');
  if (vp) vp.classList.remove('dragging');
  if (d.moved) {
    state._suppressClick = true;
    setTimeout(() => { state._suppressClick = false; }, 300);
  }
  state._drag = null;
});

function setHeader(r) {
  // 顶栏已移除（只保留左侧栏）：标签页标题固定为应用名
  document.title = '思而行:您的目标规划助手';
}

async function route() {
  document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  const r = parseRoute();
  document.body.classList.toggle('mapMode', r.view === 'map');
  try {
    aiEnsureDOM();
    const hasGoalCtx = (r.view === 'goal' || r.view === 'map');
    const fab = document.getElementById('aiFab');
    const drw = document.getElementById('aiDrawer');
    if (!hasGoalCtx) {
      if (fab) fab.classList.add('hidden');
      if (drw) drw.classList.remove('open');
    }
    if (r.view === 'home') { setHeader(r); await renderHome(); }
    else if (r.view === 'settings') { setHeader(r); await renderSettings(); }
    else if (r.view === 'guide') { setHeader(r); await renderHome(); showGuide(r.step - 1); }
    else if (r.view === 'components') { setHeader(r); await renderComponentsPage(); }
    else if (r.view === 'library') { setHeader(r); await renderLibraryPage(); }
    else if (r.view === 'map') { await loadGoal(r.id); setHeader(r); renderMapPage(); }
    else if (r.view === 'diff') { await loadGoal(r.id); setHeader(r); await renderDiffPage(r.vid); }
    else if (r.view === 'tutorial') { setHeader(r); await renderTutorialPage(r.id); }
    else if (r.view === 'chat') { await loadGoal(r.id); setHeader(r); renderGoal(); }

    else if (r.view === 'plugin') { setHeader(r); await r.route.render(r.match, window.SiErXing); }
    else { await loadGoal(r.id); setHeader(r); if (!state.components) await loadComponents(); renderGoal(); }
    renderRail();
    if (r.view === 'goal' || r.view === 'map') {
      if (state.aiGoalId !== r.id) { state.aiGoalId = r.id; state.aiSessionId = 0; state.aiMsgs = []; await aiLoadModels(); await aiLoadSessions(r.id); }
      else aiRender();
      if (r.openAI) aiToggle(true);
      else {
        const open = state.aiOpen != null ? state.aiOpen : (localStorage.getItem('sierxing-ai-open') === '1');
        if (open) aiToggle(true);
        else {
          const fab2 = document.getElementById('aiFab');
          if (fab2) fab2.classList.remove('hidden');
          const d2 = document.getElementById('aiDrawer');
          if (d2) d2.classList.remove('open');
        }
      }
    }
  } catch (e) {
    app.innerHTML = '<p class="muted">页面出错：' + esc(e.message) + '</p>';
  }
}

/* ============ 首页 ============ */
async function renderHome() {
  app.innerHTML = '<p class="muted">加载中…</p>';
  const [{ goals }, st] = await Promise.all([
    api('/api/goals'),
    api('/api/ai/status').catch(() => ({}))
  ]);
  state.goals = goals;
  state.aiStatus = st;
  let html = `<div class="page">
    <div class="pageHead">
      <div class="phText">
        <h2 class="title">我的目标</h2>
        <p class="phSub">说清你的目标与现状 → AI 先做问卷确认 → 拆成 阶段 · 小目标 · 任务，可随时调整</p>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="guideBtn">📖 使用引导</button>
      <button class="btn primary" id="newBtn">＋ 新建目标</button>
      <label class="btn" title="导入别人分享的 *.share.json（含规划与资料库）">⬆ 导入分享<input type="file" id="shareImportFile" accept=".json,application/json" hidden></label>
    </div>
    ${setupCardHTML()}
    ${disabledComponentsHTML()}`;
  if (state.showNew) html += newGoalHTML();
  if (!goals.length && !state.showNew) {
    html += `<div class="emptyBox">
      <div class="ebIcon">🎯</div>
      <div class="ebTitle">还没有目标</div>
      <div class="ebText">任何想达成的目标（转行就业、学一门技能、考研考证、做出作品…），AI 会先与你反复确认，再拆成可执行的路径。</div>
      <button class="btn primary" id="emptyNewBtn">＋ 新建目标</button>
      <label class="btn" style="margin-left:8px;">⬆ 导入分享<input type="file" id="shareImportFile2" accept=".json,application/json" hidden></label>
    </div>`;
  }
  if (goals.length) {
    html += '<div class="goalGrid">';
    for (const g of goals) {
      const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
      const st = { draft: ['待规划', 'warn'], planning: ['规划中', ''], planned: ['已规划', 'ok'], failed: ['规划失败', 'danger'] }[g.status] || ['未知', 'gray'];
      const updated = g.updated_at ? String(g.updated_at).slice(0, 10) : '';
      html += `<div class="goalCard" data-go="#/g/${g.id}">
        <div class="gcHead"><span class="gcTitle">${esc(g.title)}</span><span class="chip ${st[1]}">${st[0]}</span></div>
        ${g.summary ? `<div class="gcSummary">${mdOneLine(g.summary)}</div>` : '<div class="gcSummary muted">尚未生成规划</div>'}
        ${g.next_task ? `<div class="gcNext">▸ 下一步：${esc(g.next_task)}</div>` : ''}
        <div class="gcProgress">
          <div class="bar"><div class="barFill" style="width:${pct}%"></div></div>
          <span class="gcPct">${pct}%</span>
        </div>
        <div class="gcMeta">
          ${g.weekly_hours ? `<span class="chip gray">每周 ${esc(g.weekly_hours)}</span>` : ''}
          ${g.deadline ? `<span class="chip gray">期限 ${esc(g.deadline)}</span>` : ''}
          <span class="chip gray">${g.tasks_done}/${g.tasks_total} 任务</span>
          ${updated ? `<span class="gcDate">更新于 ${updated}</span>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  app.innerHTML = html;

  const gb = document.getElementById('guideBtn');
  if (gb) gb.addEventListener('click', () => showGuide(0));
  app.querySelectorAll('#shareImportFile, #shareImportFile2').forEach(inp => inp.addEventListener('change', async () => {
    const file = (inp.files || [])[0];
    inp.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/api/share/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      toast('已导入分享：' + r.counts.nodes + ' 个节点 · ' + r.counts.sources + ' 条资料 · ' + r.counts.digests + ' 篇汇总');
      state.goals = (await api('/api/goals')).goals || [];
      go('#/g/' + r.goalId);
    } catch (e) { toast(e.message); }
  }));
  const nb = document.getElementById('newBtn');
  if (nb) nb.addEventListener('click', () => { state.showNew = !state.showNew; renderHome(); });
  const eb = document.getElementById('emptyNewBtn');
  if (eb) eb.addEventListener('click', () => { state.showNew = true; renderHome(); });
  bindPluginPicker();
  const form = document.getElementById('newGoalForm');
  if (form) {
    document.getElementById('ngCancel').addEventListener('click', () => { state.showNew = false; renderHome(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('ngTitle').value.trim();
      if (!title) return toast('请填写你的目标');
      const pluginSel = {};
      document.querySelectorAll('[data-plugin-check]').forEach(c => { pluginSel[c.getAttribute('data-plugin-check')] = c.checked; });
      try {
        const { goal } = await api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          title,
          plugins: pluginSel,
          profile: document.getElementById('ngProfile').value,
          materials: document.getElementById('ngMaterials').value,
          weekly_hours: document.getElementById('ngHours').value,
          deadline: document.getElementById('ngDeadline').value
        }) });
        state.showNew = false;
        go('#/g/' + goal.id);
        setTimeout(() => startCollect(goal.id), 400);
      } catch (err) { toast(err.message); }
    });
  }
}
function newGoalHTML() {
  return `<form class="newForm" id="newGoalForm">
    <div class="field"><label>你的目标 *</label><input id="ngTitle" placeholder="如：转行成为数据分析师 / 3 个月学会前端并做出作品 / 考研上岸 / 掌握摄影后期"></div>
    <div class="grid2">
      <div class="field"><label>当前起点（基础 / 经验 / 背景）</label><textarea id="ngProfile" placeholder="如：零基础 / 计算机专业大三，会一点 Python，没做过项目，每周能学 10 小时"></textarea></div>
      <div class="field"><label>参考资料（可选，粘贴越多规划越准）</label><textarea id="ngMaterials" placeholder="粘贴招聘 JD、课程大纲、别人总结的路线、考试大纲等，AI 会优先依据这些信息"></textarea></div>
    </div>
    <div class="grid2">
      <div class="field"><label>每周可投入</label><input id="ngHours" placeholder="如 10 小时"></div>
      <div class="field"><label>期望期限</label><input id="ngDeadline" placeholder="如 3 个月"></div>
    </div>
    ${pluginPickerHTML()}
    <div class="toolbarRow">
      <button class="btn primary" type="submit">创建并开始 AI 规划</button>
      <button class="btn" type="button" id="ngCancel">取消</button>
    </div>
  </form>`;
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

/* ============ 目标详情 ============ */
async function loadGoal(id) {
  const [{ goal }, { sources }, digestsRes] = await Promise.all([
    api('/api/goals/' + id),
    api('/api/goals/' + id + '/sources'),
    api('/api/goals/' + id + '/digests').catch(() => ({ digests: [] }))
  ]);
  state.goal = goal;
  state.sources = sources || [];
  state.digests = (digestsRes && digestsRes.digests) || [];
}
function buildTree(nodes) {
  const byId = {};
  for (const n of nodes) byId[n.id] = { ...n, sourcesArr: safeParse(n.sources, []), children: [] };
  const roots = [];
  for (const n of Object.values(byId)) {
    if (n.parent_id && byId[n.parent_id]) byId[n.parent_id].children.push(n);
    else roots.push(n);
  }
  return roots;
}
function subtreeProgress(node) {
  let total = 0, done = 0, doing = 0;
  const walk = n => {
    if (!n.children || !n.children.length) { total++; if (n.status === 'done') done++; else if (n.status === 'doing') doing++; return; }
    n.children.forEach(walk);
  };
  walk(node);
  return { total, done, doing };
}
function sourcesHTML(sources) {
  if (!sources || !sources.length) return '<span class="srcEmpty">未标注信息源</span>';
  return sources.map(s => {
    const name = String(s.name || '').trim();
    const note = String(s.note || '').trim();
    const label = name.length > 34 ? name.slice(0, 34) + '…' : name;
    return `<span class="srcWrap"><button class="src" type="button" ${note ? '' : 'disabled'}>📎 ${esc(label)}</button>${note ? `<span class="srcNote" hidden>${esc(note)}</span>` : ''}</span>`;
  }).join('');
}
const ST_LABEL = { todo: ['未开始', 'todo'], doing: ['进行中', 'doing'], done: ['已完成', 'done'] };
const ST_NEXT = { todo: 'doing', doing: 'done', done: 'todo' };

function nodeProgressHTML(n) {
  const p = subtreeProgress(n);
  const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
  return `<span class="np">${p.done}/${p.total}</span><span class="bar npBar"><span class="barFill" style="width:${pct}%"></span></span>`;
}
/* ===== 思维导图渲染 ===== */
const LEVEL_NAME = { 0: '阶段', 1: '小目标', 2: '任务' };
function nodeOpen(key, def) {
  return state.expanded[key] != null ? state.expanded[key] : def;
}
function taskNodeHTML(t) {
  const st = ST_LABEL[t.status] ? t.status : 'todo';
  const srcN = (t.sourcesArr || []).length;
  const hasKids = !!(t.children && t.children.length);
  const key = 't' + t.id;
  const open = nodeOpen(key, false);
  return `<div class="mtitem" data-id="${t.id}">
    <div class="mtnode mttask ${st}${hasKids ? ' hasKids' : ''}" data-node-id="${t.id}" data-detail="${t.id}" title="点击查看详情 · 右键打开菜单">
      ${hasKids ? `<span class="arrow ${open ? 'open' : ''}" data-childtoggle="${key}" title="${open ? '收起' : '展开'}子节点">${open ? '▾' : '▸'}</span>` : ''}
      <button class="stDot ${st}" data-cycle="${t.id}" title="点击切换：未开始 → 进行中 → 已完成">${st === 'done' ? '✓' : ''}</button>
      <span class="mtTaskTitle">${esc(t.title)}</span>
      ${t.hours ? `<span class="mtHours">${esc(t.hours)}</span>` : ''}
      <span class="srcBadge ${srcN ? '' : 'warn'}" title="${srcN ? '已标注信息源' : '未标注信息源'}">📎${srcN}</span>
      <span class="nodeOps">${t.aiBusy ? '<span class="aiTag">AI</span>' : ''}</span>
    </div>
    ${hasKids ? `<div class="mtbranch" style="display:${open ? 'flex' : 'none'}; flex-direction:column; align-items:stretch;">
      ${t.children.map(c => taskNodeHTML(c)).join('')}
      ${t.level < 5 ? `<button class="btn small addChild" data-parent="${t.id}" data-level="3">＋ 子任务</button>` : ''}
    </div>` : ''}
  </div>`;
}
function subgoalNodeHTML(g) {
  const key = 'g' + g.id;
  const open = nodeOpen(key, false);
  const p = subtreeProgress(g);
  const srcN = (g.sourcesArr || []).length;
  return `<div class="mtitem" data-id="${g.id}">
    <div class="mtnode mtsub ${open ? 'open' : ''}" data-node-id="${g.id}" data-toggle="${key}" title="点击展开/收起 · 右键打开菜单">
      <span class="arrow">${open ? '▾' : '▸'}</span>
      <span class="mtTitle">${esc(g.title)}</span>
      <span class="mtProg">${p.done}/${p.total}</span>
      ${srcN ? `<span class="srcBadge" data-detail="${g.id}" title="查看信息源">📎${srcN}</span>` : ''}
      <span class="nodeOps">
        <button class="btn tiny" data-expand="${g.id}" title="AI 深度拆分（先搜集资料再细化出任务）">✨</button>
        <button class="btn tiny" data-edit="${g.id}" title="编辑">✎</button>
        <button class="btn tiny danger" data-del="${g.id}" title="删除">×</button>
      </span>
    </div>
    <div class="mtbranch" style="display:${open ? 'flex' : 'none'}; flex-direction:column; align-items:stretch;">
      ${g.children.map(taskNodeHTML).join('')}
      <button class="btn small addChild" data-parent="${g.id}" data-level="2">＋ 任务</button>
    </div>
  </div>`;
}
function stageNodeHTML(st, si, activeStageId) {
  const key = 's' + st.id;
  const open = nodeOpen(key, st.id === activeStageId);
  const p = subtreeProgress(st);
  const srcN = (st.sourcesArr || []).length;
  return `<div class="mtitem" data-id="${st.id}">
    <div class="mtnode mtstage ${open ? 'open' : ''}" data-node-id="${st.id}" data-toggle="${key}" title="点击展开/收起 · 右键打开菜单">
      <span class="stageIdx">${String(si + 1).padStart(2, '0')}</span>
      <span class="mtTitle">${esc(st.title)}</span>
      <span class="mtProg">${p.done}/${p.total}</span>
      ${srcN ? `<span class="srcBadge" data-detail="${st.id}" title="查看信息源">📎${srcN}</span>` : ''}
      <span class="nodeOps">
        <button class="btn tiny" data-expand="${st.id}" title="AI 深度拆分（先搜集资料再细化出小目标）">✨</button>
        <button class="btn tiny" data-edit="${st.id}" title="编辑">✎</button>
        <button class="btn tiny danger" data-del="${st.id}" title="删除">×</button>
      </span>
    </div>
    <div class="mtbranch" style="display:${open ? 'flex' : 'none'}; flex-direction:column; align-items:stretch;">
      ${st.children.map(subgoalNodeHTML).join('')}
      <button class="btn small addChild" data-parent="${st.id}" data-level="1">＋ 小目标</button>
    </div>
  </div>`;
}
function drawMapLines() {
  const tree = document.querySelector('.mtree');
  if (!tree) return;
  const old = tree.querySelector('.mtlines');
  if (old) old.remove();
  const scale = state.mapScale || 1;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mtlines');
  svg.setAttribute('width', String(tree.scrollWidth));
  svg.setAttribute('height', String(tree.scrollHeight));
  const tr = tree.getBoundingClientRect();
  const addPath = (parentNode, childEl) => {
    if (!parentNode || !childEl) return;
    const pr = parentNode.getBoundingClientRect();
    const cr = childEl.getBoundingClientRect();
    const x1 = (pr.right - tr.left) / scale;
    const y1 = (pr.top + pr.height / 2 - tr.top) / scale;
    const x2 = (cr.left - tr.left) / scale;
    const y2 = (cr.top + cr.height / 2 - tr.top) / scale;
    if (x2 <= x1) return;
    const dx = Math.max(24, (x2 - x1) * 0.55);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    svg.appendChild(path);
  };
  const root = tree.querySelector('.mtnode-root');
  const pageBranch = tree.querySelector(':scope > .mtbranch');
  if (root && pageBranch) pageBranch.querySelectorAll(':scope > .mtitem > .mtnode').forEach(n => addPath(root, n));
  tree.querySelectorAll('.mtitem').forEach(item => {
    const branch = item.querySelector(':scope > .mtbranch');
    if (!branch || branch.style.display === 'none') return;
    const node = item.querySelector(':scope > .mtnode');
    if (!node) return;
    branch.querySelectorAll(':scope > .mtitem > .mtnode').forEach(child => addPath(node, child));
  });
  tree.appendChild(svg);
}
/* ===== 全屏导图页交互（拖拽 / 缩放） ===== */
function applyCanvasTransform() {
  const canvas = document.getElementById('mapCanvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${state.mapTx}px, ${state.mapTy}px) scale(${state.mapScale})`;
  const z = document.getElementById('zoomPct');
  if (z) z.textContent = Math.round(state.mapScale * 100) + '%';
}
function zoomBy(f) {
  const vp = document.getElementById('mapViewport');
  if (!vp) return;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  const old = state.mapScale;
  const next = Math.max(0.25, Math.min(2.5, old * f));
  state.mapTx = cx - (cx - state.mapTx) * (next / old);
  state.mapTy = cy - (cy - state.mapTy) * (next / old);
  state.mapScale = next;
  applyCanvasTransform();
  drawMapLines();
}
function mapFit() {
  const vp = document.getElementById('mapViewport');
  const tree = document.querySelector('.mtree');
  if (!vp || !tree) return;
  const vw = vp.clientWidth, vh = vp.clientHeight;
  const tw = Math.max(tree.scrollWidth, 1), th = Math.max(tree.scrollHeight, 1);
  const s = Math.min(1.1, (vw - 90) / tw, (vh - 90) / th);
  state.mapScale = Math.max(0.25, Math.min(1.6, s));
  state.mapTx = (vw - tw * state.mapScale) / 2;
  state.mapTy = (vh - th * state.mapScale) / 2;
  applyCanvasTransform();
  drawMapLines();
}
function bindMapTools() {
  const vp = document.getElementById('mapViewport');
  if (!vp) return;
  vp.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    state._drag = { sx: e.clientX, sy: e.clientY, ox: state.mapTx, oy: state.mapTy, moved: false };
    vp.classList.add('dragging');
  });
  vp.addEventListener('click', e => {
    if (state._suppressClick) { e.stopPropagation(); e.preventDefault(); state._suppressClick = false; }
  }, true);
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const old = state.mapScale;
    const next = Math.max(0.25, Math.min(2.5, old * (e.deltaY < 0 ? 1.12 : 0.9)));
    state.mapTx = px - (px - state.mapTx) * (next / old);
    state.mapTy = py - (py - state.mapTy) * (next / old);
    state.mapScale = next;
    applyCanvasTransform();
    drawMapLines();
  }, { passive: false });
  const zo = document.getElementById('zoomOut');
  if (zo) zo.addEventListener('click', () => zoomBy(0.85));
  const zi = document.getElementById('zoomIn');
  if (zi) zi.addEventListener('click', () => zoomBy(1.18));
  const zf = document.getElementById('zoomFit');
  if (zf) zf.addEventListener('click', () => mapFit());
  const fa = document.getElementById('foldAll');
  if (fa) fa.addEventListener('click', () => {
    state.goal.nodes.forEach(n => {
      if (n.level === 0) state.expanded['s' + n.id] = false;
      if (n.level === 1) state.expanded['g' + n.id] = false;
    });
    renderMapPage();
  });
  const ea = document.getElementById('expandAll');
  if (ea) ea.addEventListener('click', () => {
    state.goal.nodes.forEach(n => {
      if (n.level === 0) state.expanded['s' + n.id] = true;
      if (n.level === 1) state.expanded['g' + n.id] = true;
    });
    renderMapPage();
  });
  const mv = document.getElementById('mapVerBtn');
  if (mv) mv.addEventListener('click', () => showVersionsPanel(state.goal.id));
  const mc = document.getElementById('mapChatBtn');
  if (mc) mc.addEventListener('click', () => aiToggle(true));
  bindReportCard();
  bindTutorialCard();
}
function renderMapPage() {
  const g = state.goal;
  if (!g) { app.innerHTML = '<p class="muted">目标不存在</p>'; return; }
  const stages = buildTree(g.nodes);
  const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
  if (!stages.length) {
    app.innerHTML = `<div class="mapPage"><div class="mapToolbar"><a class="back" href="#/g/${g.id}">← 返回</a><span class="mapTitle">${esc(g.title)}</span></div>
      <div class="mapViewport" id="mapViewport"><div class="emptyBox" style="margin:90px auto; max-width:440px;">
        <div class="ebIcon">🧭</div><div class="ebTitle">还没有路径</div><div class="ebText">回到执行页开始 AI 规划，生成路径后再来看图。</div>
        <a class="btn primary" href="#/g/${g.id}">返回执行页</a>
      </div></div></div>`;
    return;
  }
  const activeStageId = (() => {
    for (const s of stages) { const p = subtreeProgress(s); if (p.done < p.total) return s.id; }
    return stages[0] ? stages[0].id : null;
  })();
  app.innerHTML = `<div class="mapPage">
    <div class="mapToolbar">
      <a class="back" href="#/g/${g.id}">← 返回执行页</a>
      <span class="mapTitle">${esc(g.title)}</span>
      <span class="chip gray">${g.tasks_done}/${g.tasks_total} · ${pct}%</span>
      <div class="spacer"></div>
      <span class="hint mapHint">左键拖拽平移 · 滚轮缩放 · 点击节点展开/详情</span>
      <button class="btn small" id="zoomOut" title="缩小">－</button>
      <span class="zoomPct" id="zoomPct">100%</span>
      <button class="btn small" id="zoomIn" title="放大">＋</button>
      <button class="btn small" id="zoomFit" title="适应屏幕">适应</button>
      <button class="btn small" id="foldAll">全部折叠</button>
      <button class="btn small" id="expandAll">全部展开</button>
      ${compOn('chat') ? '<button class="btn small" id="mapChatBtn">💬 AI 助手</button>' : ''}
      ${compOn('versions') ? '<button class="btn small" id="mapVerBtn">📜 版本对比</button>' : ''}
    </div>
    ${reportCardHTML()}
    ${tutorialCardHTML()}
    ${expandPanelHTML()}
    ${tutProgressHTML()}
    <div class="mapViewport" id="mapViewport">
      <div class="mapCanvas" id="mapCanvas">
        <div class="mtree">
          <div class="mtnode mtnode-root">
            <div class="mtRootName">${esc(g.title)}</div>
            <div class="mtRootStat">${g.tasks_done}/${g.tasks_total} 任务 · ${pct}%</div>
          </div>
          <div class="mtbranch" style="display:flex; flex-direction:column; align-items:stretch;">
            ${stages.map((s, i) => stageNodeHTML(s, i, activeStageId)).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
  bindTreeEvents(renderMapPage);
  bindMapTools();
  requestAnimationFrame(() => mapFit());
}
/* 把节点里 AI 写的依据名匹配到资料库真实条目（与服务端同策略：去前缀、去类型、逐级放宽） */
function findLibSource(ref) {
  const list = state.sources || [];
  const sid = Number((ref && (ref.source_id || ref.id)) || 0);
  if (sid) { const hit = list.find(x => Number(x.id) === sid); if (hit) return hit; }
  const raw = String((ref && (ref.name || ref.title)) || '').trim();
  if (!raw) return null;
  const strip = t => String(t || '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^(用户自己提供的资料|用户提供的资料|用户资料|导入的资料)[｜|:：]?\s*/, '')
    .trim();
  const cands = [];
  const push = t => { const v = String(t || '').trim(); if (v.length >= 4 && !cands.includes(v)) cands.push(v); };
  push(raw); push(strip(raw));
  for (const c of cands.slice()) {
    const m = c.match(/^(JD|大纲|教材|笔记|表格|文章|资料)[：:]\s*(.+)$/);
    if (m) push(m[2]);
  }
  for (const c of cands) for (const len of [24, 16, 12, 8]) {
    const key = c.slice(0, len);
    if (key.length < 4) continue;
    const hit = list.find(x => String(x.title || '').includes(key));
    if (hit) return hit;
  }
  return null;
}
function showNodePanel(id, rerender) {
  const rerenderFn = rerender || renderGoal;
  const n = state.goal.nodes.find(x => x.id === id);
  if (!n) return;
  const srcs = safeParse(n.sources, []);
  const tuts = tutorialsOfNode(id);   // 修复：原来漏了这行，节点面板一打开就报 tuts is not defined
  const old = document.getElementById('nodePanel');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'nodePanel';
  div.className = 'nodePanel';
  div.setAttribute('data-node', String(id));
  try { if (localStorage.getItem('sierxing-node-full') === '1') div.classList.add('full'); } catch (e) {}
  // 不再使用灰色遮罩（点击空白处仍会关闭面板）
  div.innerHTML = `
    <div class="npHead">
      <span class="chip">${LEVEL_NAME[n.level] || ''}</span>
      <span class="npTitle">${esc(n.title)}</span>
      <button class="btn tiny" id="npFull" title="全屏 / 退出全屏">${(() => { try { return localStorage.getItem('sierxing-node-full') === '1' ? '⛶ 退出全屏' : '⛶ 全屏'; } catch (e) { return '⛶ 全屏'; } })()}</button>
      <button class="btn tiny" id="npClose">×</button>
    </div>
    <div class="npStatus">
      ${['todo', 'doing', 'done'].map(s => `<button class="btn small ${n.status === s ? 'primary' : ''}" data-np-status="${s}">${ST_LABEL[s][0]}</button>`).join('')}
    </div>
    ${(n.hours || n.artifact || n.acceptance) ? `<div class="npFacts">
      ${n.hours ? `<div class="npFact"><span class="npFactLabel">预计投入</span><span>${esc(n.hours)}</span></div>` : ''}
      ${n.artifact ? `<div class="npFact"><span class="npFactLabel">产出物</span><span>${esc(n.artifact)}</span></div>` : ''}
      ${n.acceptance ? `<div class="npFact"><span class="npFactLabel">验收标准</span><span>${esc(n.acceptance)}</span></div>` : ''}
    </div>` : ''}
    ${n.detail ? `<div class="npDetail">${esc(n.detail)}</div>` : ''}
    <div class="npSrcTitle">依据信息源（${srcs.length}）</div>
    <div class="npSrcList">${srcs.length ? srcs.map((s, i) => {
      const lib = findLibSource(s);
      const body = lib ? String(lib.content || lib.snippet || '') : '';
      const isStar = !!(lib && Number(lib.quality) === 1);
      return `<div class="npSrc ${isStar ? 'isStar' : ''}"><div class="npSrcName">${isStar ? '★' : (s.source_id ? '🔗' : '📎')} ${esc(s.name || s.title || '')}${isStar ? '<span class="chip ok" style="margin-left:6px;">优质</span>' : ''}</div>${s.note ? `<div class="npSrcNote">${esc(s.note)}</div>` : ''}${body ? `<details class="npSrcBody"><summary>查看资料库正文（${body.length} 字）</summary><div class="mdBody">${mdToHTML(body.slice(0, 4000))}</div></details>` : ''}<button class="btn tiny danger npsrcDel" data-npsrc-del="${i}">移除</button></div>`;
    }).join('') : '<div class="muted" style="font-size:12.5px;">未标注资料（本节点只依据提炼汇总与资料索引）</div>'}</div>
    <div class="npSrcAdd">
      <select id="npSrcPick">${(state.sources || []).map(x => `<option value="${x.id}">${esc('[' + x.kind + '] ' + String(x.title).slice(0, 40))}</option>`).join('')}</select>
      <button class="btn tiny" id="npSrcAdd">＋ 关联资料库</button>
      <button class="btn tiny" id="npSrcNew">＋ 手动写一条</button>
    </div>
    ${(() => {
      const txt = (n.title || '') + ' ' + (n.detail || '');
      const rel = (state.digests || []).map(d => ({ d, score: kwScore(txt, (d.title || '') + ' ' + String(d.content || '').slice(0, 1500)) }))
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
      return rel.length ? `<div class="npSrcTitle">📄 相关提炼汇总</div>` + rel.map(({ d }) => `<details class="npSrcBody"><summary>${esc(d.title || d.topic)}</summary><div class="mdBody">${mdToHTML(d.content || '')}</div></details>`).join('') : '';
    })()}
    <div class="npTut">
      <div class="npSrcTitle">📘 学习教程（${tuts.length}）</div>
      ${tuts.length ? tuts.map(t => `<a class="npTutItem" href="#/t/${t.id}"><span class="npTutName">${esc(t.title)}</span><span class="chip gray">${t.format === 'html' ? 'HTML' : 'MD'}</span></a>`).join('') : '<div class="muted" style="font-size:12.5px;">还没有教程：生成一份「掌握该任务知识点」的完整教程</div>'}
      <button class="btn small primary" id="npTutBtn" style="margin-top:8px;">📘 生成完整教程（HTML / Markdown）</button>
    </div>
    <div class="npAdjust">
      <div class="npSrcTitle">💬 对当前划分有意见？直接告诉 AI，它会按你的意见调整</div>
      <textarea id="npFeedback" placeholder="例如：划分太粗了，再拆细一点 / 跳过「X」（我已经会了）/ 顺序改成先 A 后 B / 删掉「Y」/ 增加关于 Z 的任务…"></textarea>
      <button class="btn small primary" id="npAdjustBtn">提交给 AI 调整</button>
    </div>
    <div class="npOps">
      <button class="btn small" id="npEdit">编辑</button>
      <button class="btn small danger" id="npDel">删除</button>
    </div>`;
  document.body.appendChild(div);
  const closePanel = () => { div.remove(); const m = document.getElementById('nodePanelMask'); if (m) m.remove(); };
  const fsBtn = document.getElementById('npFull');
  if (fsBtn) fsBtn.addEventListener('click', () => {
    const on = div.classList.toggle('full');
    try { localStorage.setItem('sierxing-node-full', on ? '1' : '0'); } catch (e) {}
    fsBtn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
  });
  const saveNodeSources = async list => {
    try {
      const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: list }) });
      state.goal = r.goal;
      toast('已更新本节点资料');
      showNodePanel(id, rerenderFn);
    } catch (e) { toast(e.message); }
  };
  div.querySelectorAll('[data-npsrc-del]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.getAttribute('data-npsrc-del'));
    saveNodeSources(safeParse(n.sources, []).filter((x, k) => k !== i));
  }));
  const npAdd = div.querySelector('#npSrcAdd');
  if (npAdd) npAdd.addEventListener('click', () => {
    const sel = div.querySelector('#npSrcPick');
    const sid = sel && sel.value ? Number(sel.value) : 0;
    if (!sid) return toast('资料库还是空的：先收集信息源或上传图片资料');
    const src = (state.sources || []).find(x => Number(x.id) === sid);
    if (!src) return toast('没找到这条资料');
    const list = safeParse(n.sources, []).slice();
    if (list.some(x => Number(x.source_id) === sid)) return toast('这条资料已经在本节点了');
    list.push({ source_id: sid, name: String(src.title).slice(0, 120) });
    saveNodeSources(list);
  });
  const npNew = div.querySelector('#npSrcNew');
  if (npNew) npNew.addEventListener('click', () => {
    const name = prompt('资料名称（例如：某厂 JD / 某课程大纲）');
    if (!name || !name.trim()) return;
    const note = prompt('补充说明（可选）：这条资料里有什么要求或结论？') || '';
    const list = safeParse(n.sources, []).slice();
    list.push({ name: name.trim().slice(0, 120), note: note.trim().slice(0, 300) });
    saveNodeSources(list);
  });
  document.getElementById('npClose').addEventListener('click', closePanel);
  const tutBtn = document.getElementById('npTutBtn');
  if (tutBtn) tutBtn.addEventListener('click', () => { div.remove(); showTutorialDialog(id); });
  const adjBtn = document.getElementById('npAdjustBtn');
  if (adjBtn) adjBtn.addEventListener('click', () => {
    const fb = (document.getElementById('npFeedback').value || '').trim();
    if (!fb) return toast('先写下你的调整意见');
    div.remove();
    startExpand(id, fb);
  });
  div.querySelectorAll('[data-np-status]').forEach(btn => btn.addEventListener('click', async () => {
    const status = btn.getAttribute('data-np-status');
    if (status === n.status) return;
    try {
      const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      state.goal = r.goal;
      rerenderFn();
      showNodePanel(id, rerenderFn);
      toast(status === 'done' ? '已完成 ✓' : '已更新');
    } catch (e) { toast(e.message); }
  }));
  document.getElementById('npEdit').addEventListener('click', async () => {
    const title = (prompt('标题：', n.title) || '').trim();
    if (!title) return;
    const d = window.prompt('说明（可留空）：', n.detail);
    if (d === null) return;
    try {
      const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, detail: d }) });
      state.goal = r.goal;
      rerenderFn();
      showNodePanel(id, rerenderFn);
      toast('已保存');
    } catch (e) { toast(e.message); }
  });
  document.getElementById('npDel').addEventListener('click', async () => {
    if (!confirm('删除「' + n.title + '」' + (n.level < 2 ? '（含其下全部内容）' : '') + '？')) return;
    try {
      const r = await api('/api/nodes/' + id, { method: 'DELETE' });
      state.goal = r.goal;
      div.remove();
      rerenderFn();
      toast('已删除');
    } catch (e) { toast(e.message); }
  });
}

function reportCardHTML() {
  const r = state.lastReport;
  if (!r || !r.text) return '';
  return `<div class="reportCard">
    <div class="rcHead"><span>📋</span><span>AI 变更汇报</span>
      <div class="spacer"></div>
      ${r.versionId ? `<a class="btn small" href="#/g/${r.goalId}/diff/${r.versionId}">查看对比图</a>` : ''}
      <button class="btn tiny" id="rcClose" title="关闭">×</button>
    </div>
    <div class="rcText mdBody">${mdToHTML(r.text)}</div>
  </div>`;
}
function bindReportCard() {
  const b = document.getElementById('rcClose');
  if (b) b.addEventListener('click', () => { state.lastReport = null; rerenderCurrent(); });
}
function keyOfNode(nodes, n) {
  const byId = {};
  for (const x of nodes) byId[x.id] = x;
  let k = String(n.title || '');
  let p = n.parent_id ? byId[n.parent_id] : null;
  while (p) { k = String(p.title || '') + ' / ' + k; p = p.parent_id ? byId[p.parent_id] : null; }
  return k;
}
function nodeChanged(a, b) {
  return ['detail', 'artifact', 'acceptance', 'hours', 'sources', 'status'].some(f => String(a[f] || '') !== String(b[f] || ''));
}
function diffColumnHTML(nodes, side, otherKeyMap) {
  const tree = buildTree(nodes);
  let count = 0;
  const rows = [];
  const walk = (n, depth) => {
    count++;
    const key = keyOfNode(nodes, n);
    const other = otherKeyMap[key];
    let cls = '';
    if (side === 'old') {
      if (!other) cls = 'removed';
      else if (nodeChanged(n, other)) cls = 'changed';
    } else {
      if (!other) cls = 'added';
      else if (nodeChanged(other, n)) cls = 'changed';
    }
    rows.push(`<div class="diffRow ${cls}" style="padding-left:${8 + depth * 14}px" title="${esc(key)}">
      <span class="diffDot"></span><span class="diffTitle">${esc(n.title)}</span>
      ${n.hours ? `<span class="mtHours">${esc(n.hours)}</span>` : ''}
    </div>`);
    for (const c of (n.children || [])) walk(c, depth + 1);
  };
  for (const r of tree) walk(r, 0);
  const label = side === 'old' ? '修改前' : '当前';
  return `<div class="diffCol">
    <div class="diffColHead">${label}（${count} 节点）</div>
    <div class="diffBody">${rows.join('') || '<div class="empty">（无内容）</div>'}</div>
  </div>`;
}
/* ===== 规划约束 ===== */
function constraintsList(g) {
  let list = [];
  try { list = JSON.parse((g && g.constraints) || '[]'); } catch (e) { list = []; }
  return (Array.isArray(list) ? list : []).filter(c => c && String(c.text || '').trim());
}
function constraintsCardHTML(g) {
  const list = constraintsList(g);
  const open = state.showConstraints || list.length > 0;
  return `<div class="consCard">
    <div class="consHead">
      <span>⛓ 规划约束</span><span class="chip gray">${list.length}</span>
      <span class="consHint">这些是硬性要求，AI 在规划 / 拆分 / 教程 / 对话中都会严格遵守</span>
      <div class="spacer"></div>
      <button class="btn tiny" id="consToggle">${open ? '收起' : '展开'}</button>
    </div>
    ${open ? `<div class="consBody">
      ${list.length ? `<div class="consList">${list.map((c, i) => `<div class="consItem"><span class="consText">${esc(String(c.text))}</span><div class="spacer"></div><button class="btn tiny" data-consedit="${i}">改</button><button class="btn tiny danger" data-consdel="${i}">×</button></div>`).join('')}</div>` : '<div class="muted" style="font-size:12.5px;padding:4px 2px;">还没有约束。例如：只能周末学（每周≤6h）／预算 0 元，只用免费资源／必须用 Python／不要安排视频课／3 个月内必须投递</div>'}
      <div class="consAdd">
        <input type="text" id="consInput" placeholder="添加一条约束，例如：不要安排付费课程">
        <button class="btn small primary" id="consAddBtn">添加约束</button>
      </div>
    </div>` : ''}
  </div>`;
}
function bindConstraints(g) {
  const tg = document.getElementById('consToggle');
  if (tg) tg.addEventListener('click', () => { state.showConstraints = !state.showConstraints; renderGoal(); });
  const addBtn = document.getElementById('consAddBtn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const inp = document.getElementById('consInput');
    const text = (inp.value || '').trim();
    if (!text) return toast('请输入约束内容');
    try {
      const r = await api('/api/goals/' + g.id + '/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      state.goal = r.goal; state.showConstraints = true; renderGoal(); toast('约束已添加，规划会严格遵守');
    } catch (e) { toast(e.message); }
  });
  const inp = document.getElementById('consInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  document.querySelectorAll('[data-consdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这条约束？')) return;
    try {
      const r = await api('/api/goals/' + g.id + '/constraints/' + b.getAttribute('data-consdel'), { method: 'DELETE' });
      state.goal = r.goal; renderGoal(); toast('已删除');
    } catch (e) { toast(e.message); }
  }));
  document.querySelectorAll('[data-consedit]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.getAttribute('data-consedit'));
    const list = constraintsList(state.goal);
    const cur = list[i] ? String(list[i].text) : '';
    const text = prompt('修改约束：', cur);
    if (text == null) return;
    if (!text.trim()) return;
    try {
      const r = await api('/api/goals/' + g.id + '/constraints', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: i, text: text.trim() }) });
      state.goal = r.goal; renderGoal(); toast('已更新');
    } catch (e) { toast(e.message); }
  }));
}

/* ============ 后台 AI 任务中心（切换页面不影响，任意页面可见） ============ */
const TASK_META = {
  expand: { icon: '✨', label: 'AI 拆分' },
  tutorial: { icon: '📘', label: '生成教程' },
  digest: { icon: '🧠', label: '信息提炼' },
  collect: { icon: '🔍', label: '收集资料' },
  image: { icon: '📷', label: '识别图片' }
};
function taskActive(t) { return t && (t.status === 'running' || t.status === 'queued'); }
function taskBarEnsure() {
  let el = document.getElementById('taskBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'taskBar';
    el.className = 'taskBar';
    document.body.appendChild(el);
  }
  return el;
}
function taskBarRender() {
  const all = state.tasks || [];
  const active = all.filter(taskActive);
  const recent = all.filter(t => !taskActive(t)).slice(-3);
  const el = taskBarEnsure();
  if (!active.length && !recent.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const open = state.taskOpen;
  el.innerHTML = `<button class="taskPill ${active.length ? 'busy' : ''}" id="taskPill">
      ${active.length ? `<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> ${active.length} 个 AI 任务进行中` : `🤖 AI 任务（${recent.length}）`}
      <span class="taskCaret">${open ? '▾' : '▸'}</span>
    </button>
    ${open ? `<div class="taskList">
      ${all.length ? all.slice(-8).map(t => {
        const m = TASK_META[t.type] || { icon: '🤖', label: t.type };
        return `<div class="taskItem ${t.status}">
          <span class="taskIcon">${m.icon}</span>
          <div class="taskMain">
            <div class="taskTitle">${esc(t.title || m.label)}</div>
            <div class="taskMsg">${esc(t.message || '')}${t.nodeId ? ' · 节点 #' + t.nodeId : ''}${t.note ? ' · 备注：' + esc(String(t.note).slice(0, 40)) : ''}</div>
            ${t.status === 'running' ? `<div class="taskProg"><i style="width:${t.progress || 0}%"></i></div>` : ''}
          </div>
          ${taskActive(t) ? `<button class="btn tiny" data-task-cancel="${t.id}">停止</button>` : `<span class="taskState">${t.status === 'done' ? '✓ 完成' : t.status === 'failed' ? '✗ 失败' : '已停止'}</span>`}
        </div>`;
      }).join('') : '<div class="muted" style="font-size:12px;padding:6px;">暂无任务</div>'}
      ${recent.length ? `<button class="btn tiny" id="taskClear" style="margin:6px 0 2px;">清除已完成</button>` : ''}
    </div>` : ''}`;
  const pill = el.querySelector('#taskPill');
  if (pill) pill.addEventListener('click', () => { state.taskOpen = !state.taskOpen; taskBarRender(); });
  el.querySelectorAll('[data-task-cancel]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/tasks/' + b.getAttribute('data-task-cancel') + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已请求停止'); await taskPoll(); } catch (e) { toast(e.message); }
  }));
  const clr = el.querySelector('#taskClear');
  if (clr) clr.addEventListener('click', async () => {
    try { await api('/api/tasks/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goalId: state.goal ? state.goal.id : 0 }) }); await taskPoll(); } catch (e) {}
  });
}
/* 给正在被 AI 处理的节点加动画标记 */
function taskMarkNodes() {
  const busy = (state.tasks || []).filter(t => t.status === 'running' && t.nodeId);
  const map = {};
  for (const t of busy) map[String(t.nodeId)] = t.message || 'AI 处理中…';
  document.querySelectorAll('[data-node-id]').forEach(el => {
    const id = el.getAttribute('data-node-id');
    const msg = map[id];
    if (msg) {
      el.classList.add('aiBusy');
      el.setAttribute('data-ai-msg', msg);
    } else {
      el.classList.remove('aiBusy');
      el.removeAttribute('data-ai-msg');
    }
  });
}
let taskTimer = null;
async function taskPoll() {
  try {
    const gid = state.goal ? state.goal.id : 0;
    const r = await api('/api/tasks' + (gid ? '?goalId=' + gid : ''));
    const list = r.tasks || [];
    // 新任务出现时给个小提示（动画 toast），替代原来的灰色遮罩
    const known = state.taskKnownIds || (state.taskKnownIds = {});
    const fresh = list.filter(t => !known[t.id] && (t.status === 'queued' || t.status === 'running'));
    for (const t of list) known[t.id] = 1;
    if (fresh.length) {
      const first = fresh[0];
      toast('🤖 ' + (TASK_META[first.type] ? TASK_META[first.type].label : 'AI 任务') + '已加入执行列表' + (fresh.length > 1 ? '（共 ' + fresh.length + ' 个）' : '') + ' · 左下角可看进度');
    }
    state.tasks = list;
  } catch (e) { return; }
  taskBarRender();
  taskMarkNodes();
}
function taskStart() {
  if (taskTimer) return;
  taskPoll();
  taskTimer = setInterval(taskPoll, 2000);
}

/* 让生成的 HTML 教程跟随应用主题（黑夜/白天） */
function tutThemedHTML(html) {
  const dark = (typeof currentThemeEff === 'function' && currentThemeEff() === 'dark');
  const v = dark
    ? { bg: '#14131c', fg: '#e8e7f2', card: '#1c1b26', border: '#2e2c3d', muted: '#9c9ab0', code: '#191822', accent: '#8b9cff' }
    : { bg: '#ffffff', fg: '#1f2430', card: '#f8f9fb', border: '#e5e7eb', muted: '#6b7280', code: '#f3f4f6', accent: '#4f46e5' };
  const css = `<style id="sx-theme">
  html,body{background:${v.bg} !important;color:${v.fg} !important;}
  body{--bg:${v.bg};--fg:${v.fg};--card:${v.card};--border:${v.border};--muted:${v.muted};}
  a{color:${v.accent} !important;}
  pre,code,pre code{background:${v.code} !important;color:${v.fg} !important;border-color:${v.border} !important;}
  blockquote{border-left-color:${v.border} !important;color:${v.muted} !important;background:${v.card} !important;}
  table,th,td{border-color:${v.border} !important;}
  th{background:${v.card} !important;}
  hr{border-color:${v.border} !important;}
  .tip,.note,.warn,.card,.box,section>div{background:${v.card} !important;border-color:${v.border} !important;color:${v.fg} !important;}
  </style>`;
  const t = String(html || '');
  if (/<\/head>/i.test(t)) return t.replace(/<\/head>/i, css + '</head>');
  if (/<body[^>]*>/i.test(t)) return t.replace(/<body[^>]*>/i, m => m + css);
  return css + t;
}

/* ============ Ctrl + 左键拖拽：框选节点批量操作 ============ */
function selNodesList() { return (state.selNodes || []).filter(id => (state.goal.nodes || []).some(n => Number(n.id) === Number(id))); }
function selBarRender() {
  let el = document.getElementById('selBar');
  const ids = selNodesList();
  if (!ids.length) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'selBar'; el.className = 'selBar'; document.body.appendChild(el); }
  el.innerHTML = `<span class="selCount">已选 ${ids.length} 个节点</span>
    <button class="btn tiny primary" data-sel="done">✓ 标记完成</button>
    <button class="btn tiny" data-sel="todo">○ 标记未开始</button>
    <button class="btn tiny" data-sel="expand">✨ AI 拆分</button>
    <button class="btn tiny" data-sel="tut">📘 生成教程</button>
    <button class="btn tiny danger" data-sel="del">× 删除</button>
    <button class="btn tiny" data-sel="clear">取消选择</button>`;
  el.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => selAct(b.getAttribute('data-sel'))));
}
async function selAct(act) {
  const ids = selNodesList();
  if (!ids.length) return;
  if (act === 'clear') { state.selNodes = []; selBarRender(); return; }
  if (act === 'del') {
    if (!confirm('删除选中的 ' + ids.length + ' 个节点？\\n\\n它们下面的子节点也会一并删除（会进版本历史，可回滚）。')) return;
    for (const id of ids) { try { await api('/api/nodes/' + id, { method: 'DELETE' }); } catch (e) {} }
    state.selNodes = [];
    toast('已删除 ' + ids.length + ' 个节点');
  } else if (act === 'done' || act === 'todo') {
    for (const id of ids) { try { await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: act }) }); } catch (e) {} }
    toast('已更新 ' + ids.length + ' 个节点的状态');
  } else if (act === 'expand' || act === 'tut') {
    for (const id of ids) {
      try {
        await fetch('/api/nodes/' + id + '/' + (act === 'expand' ? 'expand' : 'tutorial'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(act === 'expand' ? { feedback: '' } : { format: 'md', note: '为这个节点写一份完整可执行的教程' })
        });
      } catch (e) {}
    }
    toast('已提交 ' + ids.length + ' 个' + (act === 'expand' ? '拆分' : '教程') + '任务（左下角任务中心可看进度）');
  }
  try { await loadGoal(state.goal.id); } catch (e) {}
  rerenderCurrent();
  selBarRender();
}
function selBoxInit() {
  if (selBoxInit._done) return;
  selBoxInit._done = true;
  document.addEventListener('mousedown', e => {
    if (!e.ctrlKey || e.button !== 0) return;
    if (!e.target.closest || !e.target.closest('#mapViewport')) return;
    e.preventDefault(); e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const box = document.createElement('div');
    box.className = 'selBox';
    document.body.appendChild(box);
    const onMove = ev => {
      const x1 = Math.min(start.x, ev.clientX), y1 = Math.min(start.y, ev.clientY);
      const x2 = Math.max(start.x, ev.clientX), y2 = Math.max(start.y, ev.clientY);
      box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
      box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
      document.querySelectorAll('[data-node-id]').forEach(el => {
        const r = el.getBoundingClientRect();
        const hit = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
        el.classList.toggle('selHit', hit);
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.remove();
      const hits = [...document.querySelectorAll('[data-node-id].selHit')];
      document.querySelectorAll('.selHit').forEach(x => x.classList.remove('selHit'));
      if (hits.length) { state.selNodes = hits.map(x => Number(x.getAttribute('data-node-id'))); selBarRender(); toast('已选中 ' + hits.length + ' 个节点（可批量删除 / 标记 / AI 处理）'); }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, true);
}
selBoxInit();   // 文档级监听：导图页 Ctrl+拖拽框选

/* ===== AI 助手（右侧侧边栏） ===== */
function opChipHTML(o) {
  const t = String(o.title || '').slice(0, 40);
  if (o.op === 'add') return `<div class="chOp opAdd"><span class="opTag">新增</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'delete') return `<div class="chOp opDel"><span class="opTag">删除</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'move') return `<div class="chOp opMove"><span class="opTag">移动</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'constraint') return `<div class="chOp opCons"><span class="opTag">约束</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'status') return `<div class="chOp opStatus"><span class="opTag">状态</span><span class="opTitle">${esc(t)}</span><span class="opNote">→ ${esc(o.status === 'done' ? '已完成' : o.status === 'doing' ? '进行中' : '未开始')}</span></div>`;
  if (o.op === 'add_source') return `<div class="chOp opAdd"><span class="opTag">资料</span><span class="opTitle">${esc(t)}</span><span class="opNote">已存入资料库</span></div>`;
  if (o.op === 'delete_source') return `<div class="chOp opDel"><span class="opTag">删资料</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'update_goal') return `<div class="chOp opEdit"><span class="opTag">目标</span><span class="opTitle">${esc(t)}</span></div>`;
  if (o.op === 'start') return `<div class="chOp opAdd"><span class="opTag">启动</span><span class="opTitle">${esc(t)}</span></div>`;
  return `<div class="chOp opEdit"><span class="opTag">修改</span><span class="opTitle">${esc(t)}</span></div>`;
}
function chatBubbleHTML(m, goalId) {
  const isUser = m.role === 'user';
  let ops = [];
  try { ops = JSON.parse(m.ops || '[]'); } catch (e) {}
  const opsLine = (!isUser && ops.length)
    ? `<div class="chOps">
        <div class="chOpsHead">✏️ 本次修改了 ${ops.length} 处<span class="spacer"></span>${m.version_id ? `<button class="chDiffBtn" data-vid="${m.version_id}">查看变更详情 ▾</button>` : ''}</div>
        <div class="chOpList">${ops.slice(0, 12).map(opChipHTML).join('')}${ops.length > 12 ? `<div class="chOp"><span class="opTag">等</span><span class="opTitle">共 ${ops.length} 处</span></div>` : ''}</div>
        ${m.version_id ? `<div class="chDiffBox" data-vid="${m.version_id}" hidden></div>` : ''}
      </div>`
    : '';
  return `<div class="chMsg ${isUser ? 'chUser' : 'chAI'}">
    <div class="chAvatar">${isUser ? '我' : 'AI'}</div>
    <div class="chBody">
      <div class="chText mdBody">${isUser ? esc(m.content).replace(/\n/g, '<br>') : mdToHTML(m.content)}</div>
      ${opsLine}
      <div class="chTime">${esc(fmtDate(m.created_at))}</div>
    </div>
  </div>`;
}
function trimOpsForStream(t) {
  const s = String(t || '');
  const i = s.indexOf('```ops');
  return i >= 0 ? s.slice(0, i) : s;
}
function chatStreamHTML() {
  const st = state.aiStream;
  if (!st) return '';
  const secs = Math.floor((Date.now() - st.t0) / 1000);
  const think = st.thinking
    ? `<div class="chThink"><span class="chDot"></span><span class="chThinkText">${esc(st.thinking)}…${secs > 0 ? '（' + secs + 's）' : ''}</span></div>`
    : '';
  const vis = trimOpsForStream(st.text);
  const preparing = String(st.text).indexOf('```ops') >= 0;
  return `<div class="chMsg chAI chStreaming">
    <div class="chAvatar">AI</div>
    <div class="chBody">
      ${think}
      <div class="chText mdBody">${vis ? mdToHTML(vis) : '<span class="muted" style="font-size:12.5px;">正在准备回复…</span>'}</div>
      ${preparing ? '<div class="chPrep">正在整理要执行的修改…</div>' : ''}
    </div>
  </div>`;
}
function chatRenderStream() {
  const el = document.querySelector('.chStreaming');
  const st = state.aiStream;
  if (!el) { if (st) aiRenderMsgs(); return; }
  if (!st) return;
  const secs = Math.floor((Date.now() - st.t0) / 1000);
  const think = el.querySelector('.chThink');
  if (think) {
    const txt = think.querySelector('.chThinkText');
    if (st.thinking) { think.style.display = ''; if (txt) txt.textContent = st.thinking + '…' + (secs > 0 ? '（' + secs + 's）' : ''); }
    else think.style.display = 'none';
  }
  const body = el.querySelector('.chText');
  const vis = trimOpsForStream(st.text);
  if (body && vis) body.innerHTML = mdToHTML(vis);
  const prep = el.querySelector('.chPrep');
  if (prep) prep.style.display = String(st.text).indexOf('```ops') >= 0 ? '' : 'none';
  const box = document.getElementById('adMsgs');
  if (box) box.scrollTop = box.scrollHeight;
}
async function toggleChatDiff(btn) {
  const box = btn.closest('.chOps').querySelector('.chDiffBox');
  if (!box) return;
  if (!box.hidden) { box.hidden = true; btn.textContent = '查看变更详情 ▾'; return; }
  btn.textContent = '收起变更详情 ▴';
  if (box.getAttribute('data-loaded')) { box.hidden = false; return; }
  box.hidden = false;
  box.innerHTML = '<div class="muted" style="font-size:12.5px;padding:8px 2px;">加载变更对比…</div>';
  try {
    const vid = box.getAttribute('data-vid');
    const data = await api('/api/versions/' + vid + '?mode=exact');
    const oldNodes = data.old_nodes || [];
    const newNodes = data.new_nodes || [];
    const oldK = {};
    for (const n of oldNodes) oldK[keyOfNode(oldNodes, n)] = n;
    const newK = {};
    for (const n of newNodes) newK[keyOfNode(newNodes, n)] = n;
    const d = data.diff || {};
    box.innerHTML = `<div class="chDiffHead">
        <span class="diffLegend"><span class="lgdot added"></span>新增 ${(d.added || []).length}
        <span class="lgdot removed"></span>移除 ${(d.removed || []).length}
        <span class="lgdot changed"></span>修改 ${(d.changed || []).length}</span>
        <div class="spacer"></div>
        <a class="chDiff" href="#/g/${data.version.goal_id}/diff/${vid}">在版本对比页打开 →</a>
      </div>
      <div class="diffCols chDiffCols">
        ${diffColumnHTML(oldNodes, 'old', newK)}
        ${diffColumnHTML(newNodes, 'new', oldK)}
      </div>`;
    box.setAttribute('data-loaded', '1');
  } catch (e) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px;padding:8px 2px;">加载失败：' + esc(e.message) + '</div>';
  }
}

/* ---- 侧边栏骨架 ---- */
function aiEnsureDOM() {
  if (document.getElementById('aiDrawer')) return;
  const fab = document.createElement('button');
  fab.id = 'aiFab';
  fab.className = 'aiFab';
  fab.title = '打开 AI 助手（改规划 / 存资料 / 加约束…）';
  fab.textContent = '💬';
  fab.addEventListener('click', () => aiToggle(true));
  document.body.appendChild(fab);
  const d = document.createElement('aside');
  d.id = 'aiDrawer';
  d.className = 'aiDrawer';
  d.innerHTML = `
    <div class="adHead">
      <span class="adTitle">💬 AI 助手</span>
      <div class="spacer"></div>
      <button class="adIco" id="adNew" title="新建对话">＋</button>
      <button class="adIco" id="adRename" title="重命名当前对话">✎</button>
      <button class="adIco" id="adDel" title="删除当前对话">🗑</button>
      <button class="adIco" id="adClose" title="隐藏侧边栏">×</button>
    </div>
    <div class="adBar">
      <select id="adSession" class="adSelect" title="切换历史对话"></select>
      <select id="adModel" class="adSelect adModel" title="选择模型"></select>
    </div>
    <div class="adMsgs" id="adMsgs"></div>
    <div class="adResizeY" id="adResizeY" title="上下拖动调整输入框高度（双击复位）"></div>
    <div class="adInput">
      <textarea id="adText" rows="1" placeholder="可以让它：改路线图 / 把这段资料存进资料库 / 提炼全部资料 / 再收集些资料 / 加一条约束 / 改目标现状与时间（Enter 发送）"></textarea>
      <button class="adSendBtn" id="adSend" title="发送（Enter）">➤</button>
    </div>
    <div class="adResizeX" id="adResizeX" title="左右拖动调整侧边栏宽度（双击复位）"></div>`;
  document.body.appendChild(d);
  d.querySelector('#adClose').addEventListener('click', () => aiToggle(false));
  d.querySelector('#adNew').addEventListener('click', aiNewSession);
  d.querySelector('#adRename').addEventListener('click', aiRenameSession);
  d.querySelector('#adDel').addEventListener('click', aiDeleteSession);
  d.querySelector('#adSession').addEventListener('change', e => aiSwitchSession(Number(e.target.value)));
  d.querySelector('#adModel').addEventListener('change', e => aiSetModel(e.target.value));
  aiBindResize();
  const ta = d.querySelector('#adText');
  ta.addEventListener('input', () => { state.aiDraft = ta.value; aiAutoGrow(); });
  ta.addEventListener('paste', () => setTimeout(aiAutoGrow, 0));
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); } });
  d.querySelector('#adSend').addEventListener('click', () => {
    if (state.aiBusy) { if (state.aiAbort) { state.aiAbort.abort(); toast('正在停止…'); } }
    else aiSend();
  });
  d.querySelector('#adMsgs').addEventListener('click', e => {
    const b = e.target.closest('.chDiffBtn');
    if (b) toggleChatDiff(b);
  });
}
function aiToggle(open) {
  if (open && typeof compOn === 'function' && !compOn('chat')) { toast('「AI 助手」组件已关闭：左侧栏 → 🧩 组件 可开启'); return; }
  aiEnsureDOM();
  state.aiOpen = open;
  try { localStorage.setItem('sierxing-ai-open', open ? '1' : '0'); } catch (e) {}
  const d = document.getElementById('aiDrawer');
  const fab = document.getElementById('aiFab');
  if (d) d.classList.toggle('open', open);
  if (fab) fab.classList.toggle('hidden', open);
  document.body.classList.toggle('aiOpen', !!open);
  if (open) { aiApplyWidth(state.aiWidth || 440, false); aiApplyInputH(state.aiInputH || 60, false); aiFocusInput(); setTimeout(aiUpdateSendBtn, 0); }
}
function aiAutoGrow() {
  const ta = document.getElementById('adText');
  if (!ta) return;
  const minH = state.aiInputH || 44;
  const maxH = Math.max(minH, Math.round(window.innerHeight * 0.72));
  ta.style.height = 'auto';
  ta.style.height = Math.max(minH, Math.min(ta.scrollHeight + 2, maxH)) + 'px';
}
function aiApplyWidth(w, persist) {
  const maxW = Math.max(360, Math.min(window.innerWidth - 40, 1600));
  w = Math.round(Math.max(320, Math.min(w || 440, maxW)));
  state.aiWidth = w;
  document.documentElement.style.setProperty('--ai-w', w + 'px');
  if (persist !== false) { try { localStorage.setItem('sierxing-ai-width', String(w)); } catch (e) {} }
}
function aiApplyInputH(h, persist) {
  const maxH = Math.max(44, Math.round(window.innerHeight * 0.72));
  h = Math.round(Math.max(44, Math.min(h || 44, maxH)));
  state.aiInputH = h;
  document.documentElement.style.setProperty('--ai-input-h', h + 'px');
  const ta = document.getElementById('adText');
  if (ta) { ta.style.minHeight = h + 'px'; aiAutoGrow(); }
  if (persist !== false) { try { localStorage.setItem('sierxing-ai-input-h', String(h)); } catch (e) {} }
}
function aiBindResize() {
  const hx = document.getElementById('adResizeX');
  const hy = document.getElementById('adResizeY');
  if (!hx || !hy || hx.getAttribute('data-bound')) return;
  hx.setAttribute('data-bound', '1');
  let drag = null;
  const start = (type, e) => {
    e.preventDefault(); e.stopPropagation();
    drag = { type, x: e.clientX, y: e.clientY, w: state.aiWidth || 440, h: state.aiInputH || 44 };
    document.body.classList.add('aiResizing');
  };
  hx.addEventListener('mousedown', e => start('x', e));
  hy.addEventListener('mousedown', e => start('y', e));
  hx.addEventListener('dblclick', () => { aiApplyWidth(440); aiAutoGrow(); });
  hy.addEventListener('dblclick', () => { aiApplyInputH(60); });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    if (drag.type === 'x') aiApplyWidth(drag.w + (drag.x - e.clientX));
    else aiApplyInputH(drag.h + (drag.y - e.clientY));
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('aiResizing');
  });
  window.addEventListener('resize', () => {
    aiApplyWidth(state.aiWidth || 440, false);
    aiApplyInputH(state.aiInputH || 44, false);
  });
}
function aiFocusInput() {
  const ta = document.getElementById('adText');
  if (ta) setTimeout(() => ta.focus(), 60);
}
async function aiLoadSessions(goalId) {
  if (!goalId) return;
  state.aiSessions = state.aiSessions || [];
  try {
    const r = await api('/api/goals/' + goalId + '/chat-sessions');
    state.aiSessions = r.sessions || [];
    if (!state.aiSessions.length) {
      const c = await api('/api/goals/' + goalId + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      state.aiSessions = [c.session];
      state.aiSessionId = c.session.id;
      state.aiMsgs = [];
    } else if (!state.aiSessionId || !state.aiSessions.some(s => s.id === state.aiSessionId)) {
      state.aiSessionId = state.aiSessions[0].id;
    }
    await aiLoadMsgs();
  } catch (e) { toast('对话加载失败：' + e.message); }
}
async function aiLoadMsgs() {
  if (!state.aiSessionId) { state.aiMsgs = []; aiRender(); return; }
  try {
    const r = await api('/api/chat-sessions/' + state.aiSessionId + '/messages');
    state.aiMsgs = r.messages || [];
    state.aiModel = r.session.model || state.aiModel || '';
  } catch (e) { state.aiMsgs = []; }
  aiRender();
}
async function aiSwitchSession(sid) {
  if (state.aiBusy) return toast('AI 正在回复，请稍候');
  state.aiSessionId = sid;
  const s = (state.aiSessions || []).find(x => x.id === sid);
  state.aiModel = (s && s.model) || '';
  await aiLoadMsgs();
  aiFocusInput();
}
async function aiNewSession() {
  if (!state.goal) return toast('请先进入一个目标');
  if (state.aiBusy) return toast('AI 正在回复，请稍候');
  try {
    const r = await api('/api/goals/' + state.goal.id + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: state.aiModel || '' }) });
    state.aiSessions = [r.session].concat(state.aiSessions || []);
    state.aiSessionId = r.session.id;
    state.aiMsgs = [];
    aiRender();
    aiFocusInput();
    toast('已新建对话');
  } catch (e) { toast(e.message); }
}
async function aiRenameSession() {
  const s = (state.aiSessions || []).find(x => x.id === state.aiSessionId);
  if (!s) return;
  const name = prompt('重命名对话：', s.title || '新对话');
  if (name == null) return;
  const title = String(name).trim().slice(0, 60);
  if (!title) return;
  try {
    await api('/api/chat-sessions/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    s.title = title;
    aiRender();
    toast('已重命名');
  } catch (e) { toast(e.message); }
}
async function aiDeleteSession() {
  const s = (state.aiSessions || []).find(x => x.id === state.aiSessionId);
  if (!s) return;
  if (!confirm('删除对话「' + (s.title || '新对话') + '」及其全部消息？')) return;
  try {
    await api('/api/chat-sessions/' + s.id, { method: 'DELETE' });
    state.aiSessions = (state.aiSessions || []).filter(x => x.id !== s.id);
    state.aiSessionId = state.aiSessions.length ? state.aiSessions[0].id : 0;
    if (!state.aiSessions.length) await aiNewSession();
    else await aiLoadMsgs();
    toast('已删除');
  } catch (e) { toast(e.message); }
}
async function aiSetModel(model) {
  state.aiModel = model;
  const s = (state.aiSessions || []).find(x => x.id === state.aiSessionId);
  if (s) {
    s.model = model;
    try { await api('/api/chat-sessions/' + s.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }); } catch (e) {}
  }
  toast('已切换模型：' + model);
}
async function aiLoadModels() {
  if (state.aiModels) return;
  try {
    const r = await api('/api/ai/models');
    state.aiModels = r.models || [];
    state.aiDefaultModel = r.default || '';
  } catch (e) { state.aiModels = []; }
}
function aiRenderMsgs() {
  const box = document.getElementById('adMsgs');
  if (!box) return;
  const msgs = state.aiMsgs || [];
  if (!msgs.length && !state.aiStream) {
    box.innerHTML = `<div class="chatEmpty">
      <div class="ceIcon">💬</div>
      <div class="ceTitle">随时告诉我怎么改</div>
      <div class="ceText">路线图定稿后也能继续调整。例如：<br>「第二阶段太笼统了，帮我拆成更细的任务」<br>「我已经会 Python 基础了，把相关的入门任务删掉」<br>「加一个 Docker 部署的任务，放在项目阶段最后」</div>
    </div>`;
  } else {
    const gid = state.goal ? state.goal.id : 0;
    box.innerHTML = msgs.map(m => chatBubbleHTML(m, gid)).join('') + chatStreamHTML();
  }
  box.scrollTop = box.scrollHeight;
}
function aiRender() {
  aiEnsureDOM();
  const sess = document.getElementById('adSession');
  const modelSel = document.getElementById('adModel');
  if (sess) {
    const list = state.aiSessions || [];
    sess.innerHTML = list.length
      ? list.map(s => `<option value="${s.id}" ${s.id === state.aiSessionId ? 'selected' : ''}>${esc((s.title || '新对话') + (s.msg_count ? '（' + s.msg_count + '）' : ''))}</option>`).join('')
      : '<option value="">（还没有对话）</option>';
  }
  if (modelSel) {
    const models = state.aiModels || [];
    const cur = state.aiModel || '';
    modelSel.innerHTML = `<option value="">默认模型</option>` + models.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
  }
  aiRenderMsgs();
}
/* 发送键在工作时变成停止键 */
function aiUpdateSendBtn() {
  const b = document.getElementById('adSend');
  if (!b) return;
  if (state.aiBusy) { b.classList.add('stop'); b.textContent = '⏹'; b.title = '停止本轮对话（已生成的部分会保留）'; }
  else { b.classList.remove('stop'); b.textContent = '➤'; b.title = '发送（Enter）'; }
}
async function aiSend() {
  if (state.aiBusy) return;
  if (!(await ensureAIConfigured())) return;
  const ta = document.getElementById('adText');
  const msg = (ta.value || '').trim();
  if (!msg) return;
  if (!state.goal) return toast('请先进入一个目标');
  if (!state.aiSessionId) await aiNewSession();
  ta.value = '';
  state.aiDraft = '';
  ta.style.height = 'auto';
  state.aiMsgs = state.aiMsgs || [];
  state.aiMsgs.push({ id: 0, role: 'user', content: msg, ops: '[]', created_at: new Date().toISOString() });
  state.aiBusy = true;
  state.aiAbort = new AbortController();
  state.aiStream = { text: '', thinking: '正在理解你的要求…', t0: Date.now() };
  aiUpdateSendBtn();
  aiRenderMsgs();
  if (state.aiTick) clearInterval(state.aiTick);
  state.aiTick = setInterval(() => { if (state.aiStream) chatRenderStream(); }, 1000);
  try {
    const resp = await fetch('/api/chat-sessions/' + state.aiSessionId + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }), signal: state.aiAbort.signal });
    if (!resp.ok || !resp.body) throw new Error('无法连接对话服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.sessionTitle) {
          const s = (state.aiSessions || []).find(x => x.id === state.aiSessionId);
          if (s) s.title = d.sessionTitle;
        }
        if (d.thinking && state.aiStream) { state.aiStream.thinking = d.thinking; chatRenderStream(); }
        if (d.text && state.aiStream) { state.aiStream.text += d.text; state.aiStream.thinking = ''; chatRenderStream(); }
        if (d.status && state.aiStream) { state.aiStream.thinking = d.status; chatRenderStream(); }
        if (d.reply && state.aiStream) { state.aiStream.text = d.reply; state.aiStream.thinking = ''; chatRenderStream(); }
        if (d.done) {
          finished = true;
          state.goal = d.goal;
          state.aiMsgs.push({ id: d.id, role: 'assistant', content: d.reply, ops: JSON.stringify(d.applied || []), version_id: d.versionId || 0, created_at: new Date().toISOString() });
          if (d.applied && d.applied.length) {
            const starts = d.applied.filter(x => x && x.op === 'start');
            const others = d.applied.filter(x => x && x.op !== 'start');
            if (others.length) toast('已执行 ' + others.length + ' 项操作，可在目标页查看');
            for (const st of starts) {
              setTimeout(() => {
                if (st.action === 'digest') startDigest(state.goal.id);
                else if (st.action === 'collect') startCollect(state.goal.id);
              }, 300);
            }
          }
          if (d.errors && d.errors.length) toast('部分操作未生效：' + d.errors[0]);
        }
        if (d.cancelled) { finished = true; toast(d.status || '已停止本轮对话'); }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    if (!finished) toast('对话中断，可重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast(e.message);
  } finally {
    if (state.aiTick) { clearInterval(state.aiTick); state.aiTick = null; }
    state.aiBusy = false;
    state.aiAbort = null;
    state.aiStream = null;
    aiUpdateSendBtn();
    const s = (state.aiSessions || []).find(x => x.id === state.aiSessionId);
    if (s) s.msg_count = (s.msg_count || 0) + 2;
    aiRender();
    const rr = parseRoute();
    // 对话可能改了资料 / 约束 / 目标信息 / 节点：重新拉一次数据，保证界面同步
    if ((rr.view === 'goal' || rr.view === 'map' || rr.view === 'library') && state.goal) {
      try { await loadGoal(state.goal.id); } catch (e) {}
      if (rr.view === 'library') renderLibraryPage();
      else rerenderCurrent();
    }
  }
}

/* ===== 学习教程 ===== */
function tutorialsOfNode(nodeId) {
  return ((state.goal && state.goal.tutorials) || []).filter(t => Number(t.node_id) === Number(nodeId));
}
/* 分享弹窗（页面内，避免浏览器拦截 confirm） */
function showShareDialog(goalId) {
  const old = document.getElementById('shareDlg');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'shareDlg';
  div.className = 'shareMask';
  const MODULES = [
    { k: 'goal', label: '目标信息', note: '标题 / 每周投入 / 期限 / 总结' },
    { k: 'profile', label: '现状与背景', note: '可能含个人隐私（学校 / 专业 / 经历）', privacy: true },
    { k: 'materials', label: '参考资料', note: '目标里粘贴的 JD / 大纲等', privacy: true },
    { k: 'constraints', label: '规划约束', note: '硬性要求（时间 / 预算等）' },
    { k: 'nodes', label: '规划（阶段 / 小目标 / 任务）', note: '完整路线图与完成状态' },
    { k: 'sources', label: '资料库', note: '全部资料（含优质标记与正文）' },
    { k: 'digests', label: '提炼汇总 MD', note: 'AI 通读资料后的主题汇总' }
  ];
  div.innerHTML = `<div class="shareBox">
    <div class="shareTitle">🔗 分享这份规划与资料库</div>
    <p class="shareHint">选择要分享的内容（取消勾选即可排除）；对方在首页点「⬆ 导入分享」即可完整还原。</p>
    <div class="shareMods">
      ${MODULES.map(m => `<label class="shareMod"><input type="checkbox" data-mod="${m.k}" checked>
        <span><b>${esc(m.label)}</b>${m.privacy ? ' <span class="chip warn" style="font-size:10px;">含隐私</span>' : ''}<br><span class="muted">${esc(m.note)}</span></span></label>`).join('')}
    </div>
    <label class="shareOpt" style="margin-top:4px;"><input type="checkbox" id="shareRedactBox" checked>
      <span><b>隐去个人隐私（推荐）</b><br><span class="muted">把学校 / 单位 / 年级 / 姓名 / 手机号 / 邮箱 / 证件号替换成「已隐去」</span></span></label>
    <div class="shareOps">
      <button class="btn primary" id="shareOk">导出分享文件</button>
      <button class="btn" id="shareCancel">取消</button>
      <button class="btn tiny" id="shareAll">全选</button>
      <button class="btn tiny" id="shareNone">全不选</button>
    </div>
  </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.addEventListener('click', e => { if (e.target === div) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  div.querySelector('#shareCancel').addEventListener('click', close);
  const allBox = div.querySelector('#shareAll');
  if (allBox) allBox.addEventListener('click', () => div.querySelectorAll('[data-mod]').forEach(x => { x.checked = true; }));
  const noneBox = div.querySelector('#shareNone');
  if (noneBox) noneBox.addEventListener('click', () => div.querySelectorAll('[data-mod]').forEach(x => { x.checked = false; }));
  div.querySelector('#shareOk').addEventListener('click', () => {
    const mods = [...div.querySelectorAll('[data-mod]')].filter(x => x.checked).map(x => x.getAttribute('data-mod'));
    if (!mods.length) return toast('至少勾选一项要分享的内容');
    const redact = !!(div.querySelector('#shareRedactBox') || {}).checked;
    const a = document.createElement('a');
    a.href = '/api/goals/' + goalId + '/share?parts=' + encodeURIComponent(mods.join(',')) + (redact ? '' : '&redact=0');
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    close();
    toast(redact ? '已导出分享文件（隐私已隐去）' : '已导出分享文件（原样，含个人现状）');
  });
}
function showTutorialDialog(nodeId) {
  const n = state.goal.nodes.find(x => x.id === nodeId);
  if (!n) return;
  const old = document.getElementById('tutDialog');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'tutDialog';
  div.className = 'tutDialog';
  div.innerHTML = `
    <div class="tdHead"><span>📘</span><span>生成学习教程：${esc(String(n.title).slice(0, 26))}</span><button class="btn tiny" id="tdX">×</button></div>
    <div class="tdBody">
      <p class="hint" style="margin:2px 0 10px;">教程以「真正掌握知识点」为目标：讲原理 → 分步实践（含自检与排错）→ 练习 → 掌握自测清单。生成约需 1-3 分钟。</p>
      <div class="field"><textarea id="tdNote" placeholder="补充要求（可选）：例如 我完全零基础请讲慢一点 / 多给可复制的代码 / 侧重面试常问点…"></textarea></div>
      <div class="toolbarRow" style="margin-top:10px;">
        <button class="btn primary" id="tdHtml">生成 HTML 图文教程</button>
        <button class="btn" id="tdMd">生成 Markdown 教程</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  const note = () => (document.getElementById('tdNote').value || '').trim();
  div.querySelector('#tdHtml').addEventListener('click', () => { const v = note(); close(); startTutorial(nodeId, 'html', v); });
  div.querySelector('#tdMd').addEventListener('click', () => { const v = note(); close(); startTutorial(nodeId, 'md', v); });
  div.querySelector('#tdX').addEventListener('click', close);
}
async function startTutorial(nodeId, format, note) {
  if (typeof compOn === 'function' && !compOn('tutorial')) { toast('「学习教程」组件已关闭：左侧栏 → 🧩 组件 可开启'); return; }
  if (state.tutoring || state.planning || state.collecting || state.expanding) return;
  state.tutoring = true;
  state.tutStatus = '正在撰写教程（' + (format === 'html' ? 'HTML' : 'Markdown') + '）…';
  rerenderCurrent();
  try {
    const resp = await fetch('/api/nodes/' + nodeId + '/tutorial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, note: note || '' }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接教程服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finished = false, tut = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.status) { state.tutStatus = d.status; const el = document.getElementById('tutStatus'); if (el) el.textContent = d.status; }
        if (d.done) { finished = true; state.goal = d.goal; tut = d.tutorial; }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    if (tut) {
      state.lastTutorial = { id: tut.id, title: tut.title, nodeId, format: tut.format };
      toast('教程已生成，点击「查看教程」开始学习');
    } else if (!finished) toast('教程生成中断，可重试');
  } catch (e) {
    toast(e.message);
  } finally {
    state.tutoring = false;
    state.tutStatus = '';
    try { await loadGoal(state.goal.id); } catch (e) {}
    rerenderCurrent();
  }
}
function tutProgressHTML() {
  if (!state.tutoring) return '';
  return `<div class="expandPanel"><span class="spinner"></span><span id="tutStatus">${esc(state.tutStatus || '正在撰写教程…')}</span></div>`;
}
function tutorialCardHTML() {
  const t = state.lastTutorial;
  if (!t) return '';
  return `<div class="reportCard tutCard">
    <div class="rcHead"><span>📘</span><span>教程已生成：${esc(t.title)}</span>
      <div class="spacer"></div>
      <a class="btn small primary" href="#/t/${t.id}">点击查看教程</a>
      <button class="btn tiny" id="tcClose" title="关闭">×</button>
    </div>
    <div class="rcText">学习建议：先理解原理，再跟着分步实践（每步都有自检方法），最后做练习和自测清单；确认掌握后回到任务勾选完成。</div>
  </div>`;
}
function bindTutorialCard() {
  const b = document.getElementById('tcClose');
  if (b) b.addEventListener('click', () => { state.lastTutorial = null; rerenderCurrent(); });
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
/* 把与文字挤在一行的 ``` 围栏拆到独立行（题面/粘贴内容里常见） */
function normalizeFences(raw) {
  let t = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  t = t.replace(/(```+[ \t]*[\w+-]*)[ \t]*([^\n`])/g, '$1\n$2');   // 开围栏后面直接跟内容
  t = t.replace(/([^\n`])(```+)/g, '$1\n$2');                        // 围栏紧跟在文字后面
  return t;
}
function mdToHTML(text) {
  const lines = normalizeFences(text).split('\n');
  let html = '', i = 0;
  const mdRow = c => {
    let p = c.split('|');
    if (p.length && p[0].trim() === '') p.shift();
    if (p.length && p[p.length - 1].trim() === '') p.pop();
    return p.map(x => x.trim());
  };
  const isSep = s => /^[\s|:|-]+$/.test(s) && /-+/.test(s) && s.includes('|');
  const isBlock = l => /^\s*(#{1,6})\s/.test(l) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^\s*```/.test(l)
    || /^\s*>\s?/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += '<pre' + (fence[1] ? ' data-lang="' + mdEscape(fence[1]) + '"' : '') + '><code>' + mdEscape(buf.join('\n')) + '</code></pre>';
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; html += '<h' + n + '>' + mdInline(mdEscape(h[2])) + '</h' + n + '>'; i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += '<blockquote>' + mdToHTML(buf.join('\n')) + '</blockquote>';
      continue;
    }
    if (line.includes('|') && lines[i + 1] && isSep(lines[i + 1])) {
      const header = mdRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(mdRow(lines[i])); i++; }
      html += '<table><thead><tr>' + header.map(c => '<th>' + mdInline(mdEscape(c)) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(mdEscape(c)) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const ul = l.match(/^\s*[-*+]\s+(.*)$/);
        const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
          if (!!ol !== ordered) break;
          const txt = ul ? ul[1] : ol[1];
          const cb = txt.match(/^\[([ xX])\]\s*(.*)$/);
          if (cb) items.push('<input type="checkbox" disabled' + (cb[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' + mdInline(mdEscape(cb[2])));
          else items.push(mdInline(mdEscape(txt)));
          i++;
        } else if (!/^\s*$/.test(l) && !isBlock(l) && !(l.includes('|') && lines[i + 1] && isSep(lines[i + 1]))) {
          items[items.length - 1] += '<br>' + mdInline(mdEscape(l.trim()));
          i++;
        } else break;
      }
      html += '<' + (ordered ? 'ol' : 'ul') + '>' + items.map(x => '<li>' + x + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>';
      continue;
    }
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (isBlock(l) || (l.includes('|') && lines[i + 1] && isSep(lines[i + 1]))) break;
      buf.push(l); i++;
    }
    if (buf.length) html += '<p>' + buf.map(x => mdInline(mdEscape(x))).join('<br>') + '</p>';
  }
  return html;
}
async function renderTutorialPage(tid) {
  app.innerHTML = '<p class="muted">加载教程…</p>';
  const r = await api('/api/tutorials/' + tid);
  const t = r.tutorial, node = r.node, goal = r.goal;
  const isHtml = t.format === 'html';
  const sizeK = Math.max(1, Math.round((t.content || '').length / 1000));
  app.innerHTML = `<div class="tutPage">
    <div class="tutHead">
      <a class="back" href="#/g/${t.goal_id}">← 返回目标</a>
      <span class="mapTitle">📘 ${esc(t.title)}</span>
      <span class="chip gray">${isHtml ? 'HTML' : 'Markdown'}</span>
      <span class="chip gray">约 ${sizeK}k 字</span>
      <div class="spacer"></div>
      <button class="btn small" id="tutDl">下载</button>
      <button class="btn small danger" id="tutDel">删除</button>
    </div>
    <div class="tutMeta">${node ? '对应任务：' + esc(node.title) : ''}${goal ? '　·　所属目标：' + esc(goal.title) : ''}　·　生成于 ${esc(fmtDate(t.created_at))}</div>
    ${isHtml
      ? `<iframe class="tutFrame" id="tutFrame" sandbox="allow-same-origin allow-popups"></iframe>`
      : `<div class="tutBody mdBody">${mdToHTML(t.content)}</div>`}
  </div>`;
  if (isHtml) document.getElementById('tutFrame').setAttribute('srcdoc', tutThemedHTML(t.content));
  document.getElementById('tutDl').addEventListener('click', () => {
    const blob = new Blob([t.content], { type: isHtml ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(t.title || '教程').replace(/[\\/:*?"<>|]/g, '_') + (isHtml ? '.html' : '.md');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  });
  document.getElementById('tutDel').addEventListener('click', async () => {
    if (!confirm('删除这份教程？')) return;
    try { await api('/api/tutorials/' + tid, { method: 'DELETE' }); toast('已删除'); go('#/g/' + t.goal_id); } catch (e) { toast(e.message); }
  });
}

async function renderDiffPage(vid) {
  app.innerHTML = '<p class="muted">加载中…</p>';
  const data = await api('/api/versions/' + vid);
  const oldNodes = data.old_nodes || [];
  const newNodes = data.new_nodes || [];
  const oldK = {};
  for (const n of oldNodes) oldK[keyOfNode(oldNodes, n)] = n;
  const newK = {};
  for (const n of newNodes) newK[keyOfNode(newNodes, n)] = n;
  let html = `<div class="diffPage">
    <div class="diffHead">
      <a class="back" href="#/g/${data.version.goal_id}">← 返回</a>
      <span class="mapTitle">${esc((data.goal && data.goal.title) || '')} · 路线变更对比</span>
      <span class="chip">${esc(data.version.reason || '变更')}</span>
      <span class="hint">${fmtDate(data.version.created_at)} 的版本 ↔ 当前</span>
      <div class="spacer"></div>
      <span class="diffLegend"><span class="lgdot added"></span>新增 <span class="lgdot removed"></span>移除 <span class="lgdot changed"></span>修改 <span class="lgdot"></span>未变</span>
    </div>`;
  if (data.version.summary) {
    html += `<div class="reportCard" style="margin-bottom:14px;"><div class="rcHead"><span>📋</span><span>AI 变更汇报</span></div><div class="rcText mdBody">${mdToHTML(data.version.summary)}</div></div>`;
  }
  html += `<div class="diffCols">
      ${diffColumnHTML(oldNodes, 'old', newK)}
      ${diffColumnHTML(newNodes, 'new', oldK)}
    </div>
  </div>`;
  app.innerHTML = html;
}
async function showVersionsPanel(goalId) {
  if (typeof compOn === 'function' && !compOn('versions')) { toast('「版本对比与汇报」组件已关闭：左侧栏 → 🧩 组件 可开启'); return; }
  const { versions } = await api('/api/goals/' + goalId + '/versions');
  const old = document.getElementById('versionsPanel');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'versionsPanel';
  div.className = 'versionsPanel';
  let h = `<div class="vpHead"><span>📜 版本历史</span><div class="spacer"></div><button class="btn tiny" id="vpClose">×</button></div>`;
  if (!versions.length) h += '<div class="empty">还没有版本记录。每次规划/调整/拆分后会自动生成版本。</div>';
  for (const v of versions) {
    h += `<div class="vpItem">
      <div class="vpTop"><span class="chip gray">${esc(v.reason || '变更')}</span><span class="hint">${fmtDate(v.created_at)}</span></div>
      ${v.summary ? `<div class="vpSummary">${mdOneLine(v.summary)}</div>` : '<div class="vpSummary muted">（无汇报）</div>'}
      <div class="vpOps"><a class="btn small" href="#/g/${goalId}/diff/${v.id}">查看对比图</a></div>
    </div>`;
  }
  div.innerHTML = h;
  document.body.appendChild(div);
  document.getElementById('vpClose').addEventListener('click', () => div.remove());
}
function rerenderCurrent() {
  const r = parseRoute();
  if (r.view === 'map' && state.goal) renderMapPage();
  else if (r.view === 'goal' && state.goal) renderGoal();
}
async function setNodeStatus(id, status) {
  try {
    const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    state.goal = r.goal;
    rerenderCurrent();
    const np = document.getElementById('nodePanel');
    if (np && np.getAttribute('data-node') === String(id)) showNodePanel(id, rerenderCurrent);
    toast(status === 'done' ? '已完成 ✓' : status === 'doing' ? '进行中' : '已回到未开始');
  } catch (e) { toast(e.message); }
}
async function editNode(id) {
  const n = state.goal.nodes.find(x => x.id === id);
  if (!n) return;
  const title = (prompt('标题：', n.title) || '').trim();
  if (!title) return;
  const d = window.prompt('说明（可留空）：', n.detail);
  if (d === null) return;
  try {
    const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, detail: d }) });
    state.goal = r.goal;
    rerenderCurrent();
  } catch (e) { toast(e.message); }
}
async function delNode(id) {
  const n = state.goal.nodes.find(x => x.id === id);
  if (!n) return;
  const hasKids = state.goal.nodes.some(x => Number(x.parent_id) === id);
  if (!confirm('删除「' + n.title + '」' + (hasKids ? '（含其下全部内容）' : '') + '？')) return;
  try {
    const r = await api('/api/nodes/' + id, { method: 'DELETE' });
    state.goal = r.goal;
    rerenderCurrent();
    toast('已删除');
  } catch (e) { toast(e.message); }
}
/* 取某个节点的直接子节点 */
function db2Kids(id) {
  return ((state.goal && state.goal.nodes) || []).filter(x => Number(x.parent_id) === Number(id));
}
function showCtxMenu(x, y, id) {
  const n = state.goal.nodes.find(v => v.id === id);
  if (!n) return;
  const old = document.getElementById('ctxMenu');
  if (old) old.remove();
  const srcs = safeParse(n.sources, []);
  const tuts = tutorialsOfNode(id);
  const kids = db2Kids(id);   // 批量操作子节点用（之前漏了这行，导致右键菜单报错打不开）
  const div = document.createElement('div');
  div.id = 'ctxMenu';
  div.className = 'ctxMenu';
  const W = 268, H = 420;
  div.style.left = Math.min(x, window.innerWidth - W - 8) + 'px';
  div.style.top = Math.min(y, window.innerHeight - H - 8) + 'px';
  div.innerHTML = `
    <div class="ctxTitle" title="${esc(n.title)}">${LEVEL_NAME[n.level] || '节点'}｜${esc(n.title.slice(0, 20))}${n.title.length > 20 ? '…' : ''}</div>
    <button data-act="expand">✨ AI 深度拆分（搜集资料后细化）</button>
    <button data-act="discuss">💬 提意见调整划分（和 AI 讨论）</button>
    <button data-act="tut">📘 生成学习教程（掌握这个任务）</button>
    ${kids.length ? `<button data-act="tutkids">📚 为全部子节点生成教程（${kids.length} 个，并行）</button>` : ''}
    ${kids.length ? `<button data-act="expandkids">✨ 逐个拆分全部子节点（${kids.length} 个，并行）</button>` : ''}
    ${tuts.length ? `<button data-act="tutview">📖 查看教程（${tuts.length}）</button>` : ''}
    <button data-act="sources">📚 资料与提炼汇总（${srcs.length}）</button>
    <div class="ctxSep"></div>
    <button data-act="doing">▶ 标记进行中</button>
    <button data-act="done">✓ 标记已完成</button>
    <button data-act="todo">○ 标记未开始</button>
    <div class="ctxSep"></div>
    <button data-act="edit">✎ 编辑</button>
    <button data-act="del" class="danger">× 删除</button>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  const bind = (act, fn) => {
    const b = div.querySelector(`[data-act="${act}"]`);
    if (b) b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); close(); fn(); });
  };
  bind('expand', () => startExpand(id));
  bind('tut', () => showTutorialDialog(id));
  bind('tutkids', async () => {
    const list = db2Kids(id);
    if (!list.length) return toast('这个节点还没有子节点');
    if (!confirm('为全部 ' + list.length + ' 个子节点生成教程？\n\n会并行处理（最多 3 个同时），可在左下角任务中心看进度，切页面也不影响。')) return;
    for (const k of list) {
      try {
        await fetch('/api/nodes/' + k.id + '/tutorial', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'md', note: '按父节点「' + String(n.title).slice(0, 30) + '」的学习要求，为这个子节点写一份完整、可执行的教程' })
        });
      } catch (e) {}
    }
    toast('已提交 ' + list.length + ' 个教程任务（见左下角任务中心）');
  });
  bind('expandkids', async () => {
    const list = db2Kids(id);
    if (!list.length) return toast('这个节点还没有子节点');
    if (!confirm('逐个拆分全部 ' + list.length + ' 个子节点？\n\n会并行处理（最多 3 个同时），可在左下角任务中心查看进度。')) return;
    for (const k of list) {
      try {
        await fetch('/api/nodes/' + k.id + '/expand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: '' }) });
      } catch (e) {}
    }
    toast('已提交 ' + list.length + ' 个拆分任务（见左下角任务中心）');
  });
  bind('tutview', () => {
    const list = tutorialsOfNode(id);
    if (list.length === 1) go('#/t/' + list[0].id);
    else showNodePanel(id, rerenderCurrent);
  });
  bind('sources', () => showNodePanel(id, rerenderCurrent));
  bind('discuss', () => {
    showNodePanel(id, rerenderCurrent);
    setTimeout(() => { const ta = document.getElementById('npFeedback'); if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center' }); } }, 80);
  });
  bind('doing', () => setNodeStatus(id, 'doing'));
  bind('done', () => setNodeStatus(id, 'done'));
  bind('todo', () => setNodeStatus(id, 'todo'));
  bind('edit', () => editNode(id));
  bind('del', () => delNode(id));
}
function askMeta(stage) {
  const m = {
    clarify: { title: '规划前先了解你的情况', sub: '提交回答，生成骨架', skip: '跳过，直接生成骨架', hint: 'AI 会根据你的回答制定规划；不确定的题可以留空。' },
    plan: { title: '生成骨架前，AI 想再确认几点', sub: '提交回答，继续生成骨架', skip: '跳过，直接生成骨架', hint: '回答后 AI 会把这些信息纳入规划，路径会更贴合你。' },
    refine: { title: '调整骨架前，AI 想再确认几点', sub: '提交回答，继续调整', skip: '跳过，直接调整', hint: '回答后 AI 会结合你的意见和回答重新调整骨架。' },
    tasks: { title: '细化任务前，AI 想再确认几点', sub: '提交回答，继续细化任务', skip: '跳过，直接细化', hint: '回答后 AI 会据此细化本阶段任务。' },
    expand: { title: '拆分节点前，AI 想再确认几点', sub: '提交回答，继续拆分', skip: '跳过，直接拆分', hint: '回答后 AI 会据此调整拆分方案。' }
  };
  return m[stage] || m.plan;
}
/* 问卷/自测题里的文字可能是 Markdown（AI 出代码题很常见），识别后按 Markdown 渲染；
   mdToHTML 内部逐段转义，渲染 AI 内容安全 */
function looksLikeMd(s) {
  const raw = String(s == null ? '' : s);
  if (!raw.trim()) return false;
  return /```/.test(raw)
    || /\*\*[^*\n]+\*\*/.test(raw)
    || /`[^`\n]+`/.test(raw)
    || /(^|\n)\s*#{1,6}\s+\S/.test(raw)
    || /(^|\n)\s*[-*+]\s+\S/.test(raw)
    || /(^|\n)\s*\d+[.)]\s+\S/.test(raw)
    || /\n/.test(raw);
}
function mdMaybe(s) { return looksLikeMd(s) ? mdToHTML(s) : esc(String(s == null ? '' : s)); }
function questionHTML(q, numLabel) {
  const isQuiz = q.type === 'quiz';
  const depth = Number(q.depth || 0);
  let h = `<div class="clarifyQ${isQuiz ? ' quizQ' : ''}${depth ? ' subQ' : ''}" data-qid="${esc(String(q.id))}" style="margin-left:${Math.min(depth, 3) * 16}px"${isQuiz ? ` data-answer="${esc(String(q.answer || ''))}" data-explain="${esc(q.explain || '')}"` : ''}>
    <div class="cqTitle"><span class="qnum">${esc(numLabel)}</span><div class="cqTitleText mdBody">${mdMaybe(q.title)}</div>${isQuiz ? '<span class="cqQuizTag">自测</span>' : ''}${q.desc ? `<span class="cqWhy">${esc(q.desc)}</span>` : ''}</div>`;
  if (q.type === 'text') {
    h += `<textarea class="cqText" placeholder="${esc(q.placeholder || '写下你的情况…')}"></textarea>`;
  } else {
    h += '<div class="cqOptions">';
    for (const o of (q.options || [])) {
      const v = typeof o === 'string' ? o : (o.v != null ? o.v : o.label);
      const label = typeof o === 'string' ? o : (o.label || o.v || '');
      h += `<label class="cqOpt"><input type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="cq_${esc(String(q.id))}" value="${esc(String(v))}"><span class="cqOptText mdBody">${mdMaybe(label)}</span></label>`;
    }
    h += '</div>';
  }
  if (isQuiz) h += '<div class="cqFeedback" hidden></div>';
  if (q.note) h += `<div class="cqNoteSaved" data-noteof="${esc(String(q.id))}">📝 你的补充：${esc(q.note)}</div>`;
  h += `<div class="cqOps">${depth < 3 ? `<button class="cqDrill" data-drill="${esc(String(q.id))}">🔍 进一步探讨</button>` : '<span class="cqMaxDepth">已问到最细一层</span>'}</div>`;
  h += `<div class="cqDrillBox" data-drillbox="${esc(String(q.id))}" hidden>
    <textarea class="cqNoteInput" placeholder="补充信息（可选）：你已经做过什么、你的特殊情况、你的偏好或顾虑…AI 会围绕它继续追问">${esc(q.note || '')}</textarea>
    <div class="cqDrillOps">
      <button class="btn tiny primary" data-drillgo="${esc(String(q.id))}">生成追问</button>
      <button class="btn tiny" data-notesave="${esc(String(q.id))}">仅保存补充信息</button>
      <button class="btn tiny" data-drillcancel="${esc(String(q.id))}">取消</button>
    </div>
  </div>`;
  h += `<div class="cqChildren" data-children="${esc(String(q.id))}"></div>`;
  h += '</div>';
  return h;
}
function askPanelHTML(pend) {
  const data = pend.data || {};
  const qs = data.questions || [];
  const quizCount = qs.filter(q => q.type === 'quiz').length;
  const meta = askMeta(pend.stage);
  const ids = new Set(qs.map(q => String(q.id)));
  const byParent = {};
  for (const q of qs) {
    const key = (q.parent && ids.has(String(q.parent))) ? String(q.parent) : '__root__';
    (byParent[key] = byParent[key] || []).push(q);
  }
  let h = `<div class="planPanel clarify">
    <div class="ppHead"><span>🧭</span><span>${esc(meta.title)}（共 ${qs.length} 题${quizCount ? '，含 ' + quizCount + ' 道水平自测' : ''}，约 3-5 分钟）</span></div>
    ${data.analysis ? `<div class="ghSummary" style="margin-top:10px;"><span style="font-size:11px;font-weight:700;color:var(--accent);">AI 的分析　</span><span class="mdBody" style="display:inline-block;vertical-align:top;">${mdMaybe(data.analysis)}</span></div>` : ''}
    <p class="hint" style="margin:10px 0 4px;">${esc(meta.hint)}问卷越如实，规划越贴合你的真实水平；对哪个问题想说得更清楚，点它下方的 <b>🔍 进一步探讨</b>，AI 会追加针对性的子问题把情况问透。有硬性要求请先在下方<b>「⛓ 规划约束」</b>里添加。</p>
    <div class="clarifyQs">`;
  let lastSection = '';
  let num = 0;
  const renderTop = q => {
    const sec = q.section || '';
    if (sec && sec !== lastSection) { h += `<div class="cqSection">${esc(sec)}</div>`; lastSection = sec; }
    num++;
    h += questionHTML(q, String(num));
  };
  for (const q of (byParent['__root__'] || [])) renderTop(q);
  h += `</div>
    <div class="toolbarRow" style="margin-top:14px;">
      <button class="btn primary" id="clarifySubmitBtn">${esc(meta.sub)}</button>
      <button class="btn" id="clarifySkipBtn">${esc(meta.skip)}</button>
    </div>
  </div>`;
  return h;
}
function bindQuizFeedback(root) {
  (root || document).querySelectorAll('.quizQ').forEach(box => {
    if (box.getAttribute('data-bound')) return;
    box.setAttribute('data-bound', '1');
    const answer = box.getAttribute('data-answer');
    const explain = box.getAttribute('data-explain') || '';
    const fb = box.querySelector('.cqFeedback');
    box.querySelectorAll('input[type=radio]').forEach(inp => inp.addEventListener('change', () => {
      if (!fb) return;
      const ok = String(inp.value) === String(answer);
      fb.hidden = false;
      fb.className = 'cqFeedback ' + (ok ? 'ok' : 'bad');
      fb.innerHTML = (ok ? '✓ 答对了：该知识点已掌握，规划会跳过基础内容。' : '✗ 答错了：规划会补上这块基础，别担心。') + (explain ? `<div class="cqExplain mdBody">解析：${mdMaybe(explain)}</div>` : '');
    }));
  });
}
function bindDrillButtons(root) {
  const scope = root || document;
  scope.querySelectorAll('.cqDrill').forEach(btn => {
    if (btn.getAttribute('data-bound')) return;
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const qid = btn.getAttribute('data-drill');
      const box = scope.querySelector('.cqDrillBox[data-drillbox="' + qid + '"]') || document.querySelector('.cqDrillBox[data-drillbox="' + qid + '"]');
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) { const ta = box.querySelector('.cqNoteInput'); if (ta) setTimeout(() => ta.focus(), 30); }
    });
  });
  scope.querySelectorAll('[data-drillcancel]').forEach(btn => {
    if (btn.getAttribute('data-bound')) return;
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const box = btn.closest('.cqDrillBox');
      if (box) box.hidden = true;
    });
  });
  scope.querySelectorAll('[data-notesave]').forEach(btn => {
    if (btn.getAttribute('data-bound')) return;
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => saveQuestionNote(btn.getAttribute('data-notesave'), btn.closest('.cqDrillBox'), btn));
  });
  scope.querySelectorAll('[data-drillgo]').forEach(btn => {
    if (btn.getAttribute('data-bound')) return;
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const box = btn.closest('.cqDrillBox');
      const note = box ? (box.querySelector('.cqNoteInput').value || '').trim() : '';
      drillQuestion(btn.getAttribute('data-drillgo'), btn, note);
    });
  });
}
async function saveQuestionNote(qid, box, btn) {
  const note = box ? (box.querySelector('.cqNoteInput').value || '').trim() : '';
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/goals/' + state.goal.id + '/clarify/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: qid, note }) });
    const pend = state.pendingAsk || goalPendingAsk(state.goal);
    if (pend) pend.data = r.clarify;
    const wrap = document.querySelector('.clarifyQ[data-qid="' + qid + '"]');
    if (wrap) {
      let prev = wrap.querySelector('.cqNoteSaved');
      if (note) {
        if (!prev) { prev = document.createElement('div'); prev.className = 'cqNoteSaved'; prev.setAttribute('data-noteof', qid); const ops = wrap.querySelector('.cqOps'); if (ops) wrap.insertBefore(prev, ops); }
        prev.textContent = '📝 你的补充：' + note;
      } else if (prev) prev.remove();
    }
    toast(note ? '补充信息已保存，规划时会参考' : '已清除补充信息');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}
async function drillQuestion(qid, btn, note) {
  if (state.drilling) return toast('AI 正在生成子问题，请稍候');
  const pend = state.pendingAsk || goalPendingAsk(state.goal);
  if (!pend || !state.goal) return toast('当前没有进行中的问卷');
  state.drilling = true;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'AI 正在深挖…';
  const answers = collectClarifyAnswers();
  try {
    const resp = await fetch('/api/goals/' + state.goal.id + '/clarify/drill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: qid, answers, note: note || '' })
    });
    if (!resp.ok || !resp.body) throw new Error('无法连接服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.status) { btn.textContent = '⏳ ' + d.status.slice(0, 14) + '…'; }
        if (d.error) { finished = true; toast(d.error); }
        if (d.done) {
          finished = true;
          state.pendingAsk = { stage: pend.stage, feedback: pend.feedback, data: d.clarify };
          state.goal = d.goal;
          const wrap = document.querySelector('.clarifyQ[data-qid="' + qid + '"]');
          if (wrap && note) {
            let prev = wrap.querySelector('.cqNoteSaved');
            if (!prev) { prev = document.createElement('div'); prev.className = 'cqNoteSaved'; prev.setAttribute('data-noteof', qid); const ops = wrap.querySelector('.cqOps'); if (ops) wrap.insertBefore(prev, ops); }
            prev.textContent = '📝 你的补充：' + note;
          }
          const box = document.querySelector('.cqChildren[data-children="' + qid + '"]');
          if (box) {
            const added = (d.clarify.questions || []).filter(q => String(q.parent) === String(qid));
            let html = '';
            added.forEach((q, i) => { html += questionHTML(q, (i + 1) + ')'); });
            if (d.reason) html = `<div class="cqReason">💡 ${esc(d.reason)}</div>` + html;
            box.innerHTML = html;
            bindQuizFeedback(box);
            bindDrillButtons(box);
          }
          toast('已追加 ' + d.added + ' 个追问，答完再提交');
        }
      }
    }
    if (!finished) toast('追问生成中断，可重试');
  } catch (e) {
    toast(e.message);
  } finally {
    state.drilling = false;
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}
function clarifyPanelHTML(data) { return askPanelHTML({ stage: 'clarify', data }); }
function goalPendingAsk(g) {
  if (!g) return null;
  if (g.clarify_stage) {
    let data;
    try { data = JSON.parse(g.clarify); } catch (e) { data = null; }
    if (data && Array.isArray(data.questions) && data.questions.length) return { stage: g.clarify_stage, feedback: data.feedback || '', data };
  }
  for (const n of (g.nodes || [])) {
    if (!n.qa_pending) continue;
    let d;
    try { d = JSON.parse(n.qa_pending); } catch (e) { continue; }
    if (d && Array.isArray(d.questions) && d.questions.length) return { stage: 'expand', nodeId: n.id, nodeTitle: n.title, feedback: d.feedback || '', data: d };
  }
  return null;
}
function submitAsk(skip) {
  const pend = state.pendingAsk || goalPendingAsk(state.goal);
  if (!pend) return;
  const answers = skip ? {} : collectClarifyAnswers();
  state.pendingAsk = null;
  const gid = state.goal.id;
  if (pend.stage === 'expand') startExpand(pend.nodeId, pend.feedback, answers);
  else if (pend.stage === 'refine') startPlanRefine(gid, pend.feedback, answers);
  else if (pend.stage === 'tasks') startPlanTasks(gid, answers);
  else startPlanning(gid, answers);
}
function collectClarifyAnswers() {
  let data = (state.pendingAsk && state.pendingAsk.data) ? state.pendingAsk.data : null;
  if (!data) { try { data = JSON.parse(state.goal.clarify); } catch (e) { return {}; } }
  const ans = {};
  for (const q of (data.questions || [])) {
    const box = Array.from(document.querySelectorAll('.clarifyQ')).find(b => b.getAttribute('data-qid') === String(q.id));
    if (!box) continue;
    if (q.type === 'quiz') {
      const el = box.querySelector('input:checked');
      if (el) ans[q.id] = { picked: el.value, correct: String(el.value) === String(q.answer || '') };
      continue;
    }
    if (q.type === 'text') {
      const el = box.querySelector('.cqText');
      const v = el ? el.value.trim() : '';
      if (v) ans[q.id] = v;
    } else if (q.type === 'multi') {
      const vals = Array.from(box.querySelectorAll('input:checked')).map(x => x.value);
      if (vals.length) ans[q.id] = vals;
    } else {
      const el = box.querySelector('input:checked');
      if (el) ans[q.id] = el.value;
    }
  }
  return ans;
}
function planPanelHTML() {
  const g = state.goal;
  if (!g) return '';
  if (state.planning) {
    return `<div class="planPanel" id="planPanel">
      <div class="ppHead"><span class="spinner"></span><span id="ppStatus">${esc(state.planStatus || 'AI 正在规划…')}${state.planTaskCount ? '（已生成 ' + state.planTaskCount + ' 个任务，中断后可继续）' : ''}</span><span class="ppTime" id="ppTime">0s</span><div class="spacer"></div><button class="btn tiny" id="planStop" title="停止这次生成（已生成的内容不会丢，可随时重新开始或继续）">⏹ 停止</button></div>
      <div class="ppTrack"><div class="ppTrackIn"></div></div>
      <div class="ppLive" id="ppLive" hidden></div>
      <details class="ppRaw"><summary>查看 AI 原始输出</summary><pre class="ppText" id="ppText"></pre></details>
      <div class="hint">${esc(state.planHint || '规划约需 1-3 分钟，请保持页面打开。')}</div>
    </div>`;
  }
  const pend = state.pendingAsk || goalPendingAsk(g);
  if (pend && pend.data && Array.isArray(pend.data.questions) && pend.data.questions.length) return askPanelHTML(pend);
  if (g.status === 'review') {
    const stages = (state.goal.nodes || []).filter(n => n.level === 0).length;
    const subs = (state.goal.nodes || []).filter(n => n.level === 1).length;
    return `<div class="planPanel review">
      <div class="ppHead"><span>🧭</span><span>骨架已生成：<b>${stages} 个阶段 / ${subs} 个小目标</b>。请先确认，或告诉我哪里要调整</span></div>
      <p class="hint" style="margin:8px 0 10px;">确认后 AI 才会逐阶段细化任务；调整意见会立即重新生成骨架。</p>
      <div class="field"><textarea id="planFeedback" placeholder="对骨架有意见？比如：第一阶段太长 / 我已有 XX 基础，请跳过 / 需要加一个「XX」阶段 / 顺序调整成先 A 后 B…"></textarea></div>
      <div class="toolbarRow">
        <button class="btn primary" id="planConfirmBtn">✓ 确认，开始细化任务</button>
        <button class="btn" id="planAdjustBtn">按我的意见调整骨架</button>
      </div>
    </div>`;
  }
  if (g.status === 'planning') {
    return `<div class="planPanel">
      <div class="ppHead"><span>⏸</span><span>上次细化任务中断</span><div class="spacer"></div>
        <button class="btn small primary" id="planResumeBtn">继续细化任务</button></div>
    </div>`;
  }
  return '';
}
function bindPlanPanel() {
  bindQuizFeedback(document);
  bindDrillButtons(document);
  const clSubmit = document.getElementById('clarifySubmitBtn');
  if (clSubmit) clSubmit.addEventListener('click', () => submitAsk(false));
  const clSkip = document.getElementById('clarifySkipBtn');
  if (clSkip) clSkip.addEventListener('click', () => submitAsk(true));
  const confirmBtn = document.getElementById('planConfirmBtn');
  if (confirmBtn) confirmBtn.addEventListener('click', () => startPlanTasks(state.goal.id));
  const adjBtn = document.getElementById('planAdjustBtn');
  if (adjBtn) adjBtn.addEventListener('click', () => {
    const fb = (document.getElementById('planFeedback').value || '').trim();
    if (!fb) return toast('请先写下你的调整意见');
    startPlanRefine(state.goal.id, fb);
  });
  const resumeBtn = document.getElementById('planResumeBtn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => startPlanTasks(state.goal.id));
}
let planTimer = null;
/* 规划过程的实时反馈：已用时间 / 已生成几项 / 最近生成的标题（每 1.5-2.5 秒刷新一次） */
function renderPlanLive() {
  const el = document.getElementById('ppLive');
  if (!el) return;
  const p = state.planProgress;
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const unit = p.label ? ' 个' + esc(p.label) : ' 项';
  el.innerHTML = `<span class="ppLiveMeta">⏱ 已用 ${p.elapsed || 0}s${p.count ? ' · 已生成 ' + p.count + unit : ''}${p.thinking ? ' · 模型思考中…' : ''}</span>`
    + ((p.titles && p.titles.length) ? `<div class="ppLiveList">${p.titles.map(t => `<span class="ppLiveChip">${esc(t)}</span>`).join('')}</div>` : '');
}
function bindPlanningPanel() {
  const stopBtn = document.getElementById('planStop');
  if (stopBtn) stopBtn.addEventListener('click', () => {
    if (state.planAbort) { state.planAbort.abort(); stopBtn.disabled = true; stopBtn.textContent = '正在停止…'; }
  });
  const t0 = Date.now();
  clearInterval(planTimer);
  planTimer = setInterval(() => {
    const el = document.getElementById('ppTime');
    if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + 's';
  }, 1000);
  renderPlanLive();
}
async function streamSSE(url, body, onEvent, signal) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: signal || undefined });
  if (!resp.ok || !resp.body) throw new Error('无法连接服务');
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = { done: false };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let d;
      try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
      if (onEvent) onEvent(d);
      if (d.done) result = { done: true, data: d };
      if (d.error) result = { done: true, error: d.error };
    }
  }
  return result;
}
async function startClarify(id) {
  if (state.planning || state.collecting || state.expanding) return;
  if (!(await ensureAIConfigured())) return;
  if (typeof compOn === 'function' && !compOn('clarify')) { return startPlanning(id, null); }
  state.planning = true;
  state.planAbort = new AbortController();
  state.planStatus = 'AI 正在分析你的情况，准备澄清问题…';
  state.planHint = 'AI 会先问几个问题（选择/简答），充分了解你的情况后再制定规划。';
  state.showEdit = false;
  if (!state.goal || state.goal.id !== id) await loadGoal(id);
  renderGoal();
  bindPlanningPanel();
  const r = await streamSSE('/api/goals/' + id + '/plan/clarify', {}, d => {
    if (d.status) { state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { state.planProgress = d.progress; renderPlanLive(); }
  }, state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  state.planning = false;
  if (r.error || !r.done) {
    toast(r.error || '澄清问题生成中断，可重试');
    try { await loadGoal(id); } catch (e) {}
  } else {
    state.goal = r.data.goal;
    toast('请回答 AI 的澄清问题（约 2 分钟）');
  }
  const rr = parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) renderMapPage();
}
async function startPlanning(id, answers) {
  if (state.planning || state.collecting || state.expanding) return;
  state.planning = true;
  state.planAbort = new AbortController();
  state.planProgress = null;
  state.planStage = 'skeleton';
  state.planStatus = answers ? '正在结合你的回答生成路径骨架…' : '正在生成路径骨架（阶段与小目标）…';
  state.planHint = '骨架生成约需 30-90 秒，生成后可确认或提意见。';
  state.showEdit = false;
  if (!state.goal || state.goal.id !== id) await loadGoal(id);
  state.goal.status = 'planning';
  renderGoal();
  bindPlanningPanel();
  let asked = null;
  const r = await streamSSE('/api/goals/' + id + '/plan', answers ? { answers } : {}, d => {
    if (d.status) { state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { state.planProgress = d.progress; renderPlanLive(); }
    if (d.questions) asked = { stage: d.stage || 'plan', feedback: d.feedback || '', data: d.questions };
  }, state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  state.planning = false;
  if (asked) {
    state.pendingAsk = asked;
    toast('AI 想先确认几个问题，回答后继续规划');
    try { await loadGoal(id); } catch (e) {}
  } else if (r.error || !r.done) {
    toast(r.error || '骨架生成中断，可重试');
    try { await loadGoal(id); } catch (e) {}
  } else {
    state.goal = r.data.goal;
    if (r.data.report) state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id };
    toast('骨架已生成，请确认或提意见');
  }
  const rr = parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) renderMapPage();
}
async function startPlanTasks(id, answers) {
  if (state.planning || state.collecting || state.expanding) return;
  state.planning = true;
  state.planAbort = new AbortController();
  state.planProgress = null;
  state.planStage = 'tasks';
  state.planStatus = '开始逐阶段细化任务…';
  state.planHint = '按阶段逐个生成，中途可关闭页面，回来点「继续细化任务」接着跑。';
  renderGoal();
  bindPlanningPanel();
  let asked = null;
  const r = await streamSSE('/api/goals/' + id + '/plan/tasks', answers ? { answers } : {}, d => {
    if (d.status) { state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { state.planProgress = d.progress; renderPlanLive(); }
    if (d.questions) asked = { stage: 'tasks', feedback: '', data: d.questions };
    if (d.goal) {
      state.goal = d.goal;
      try { if (d.nodeId) nodeOpen('t' + d.nodeId, true); } catch (e) {}
      // 每完成一个阶段就立刻渲染：用户能马上看到新任务；即使中断，数据已保存，可继续
      state.planTaskCount = (state.goal.nodes || []).filter(n => Number(n.level) >= 2).length;
      const rr2 = parseRoute();
      if (rr2.view === 'map' && rr2.id === id) { renderMapPage(); bindPlanningPanel(); }
      else if (rr2.view === 'goal' && rr2.id === id) { renderGoal(); bindPlanningPanel(); }
    }
  }, state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  state.planning = false;
  if (asked) {
    state.pendingAsk = asked;
    toast('AI 想先确认几个问题，回答后继续细化');
    try { await loadGoal(id); } catch (e) {}
  } else if (r.error) { toast(r.error); } else { state.goal = r.data.goal; if (r.data.report) state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id }; toast('任务细化完成'); }
  try { await loadGoal(id); } catch (e) {}
  const rr = parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) renderMapPage();
}
async function startPlanRefine(id, feedback, answers) {
  if (state.planning || state.collecting || state.expanding) return;
  state.planning = true;
  state.planAbort = new AbortController();
  state.planProgress = null;
  state.planStatus = '正在根据你的意见调整骨架…';
  state.planHint = '调整后仍需你确认才会细化任务。';
  renderGoal();
  bindPlanningPanel();
  let asked = null;
  const r = await streamSSE('/api/goals/' + id + '/plan/refine', answers ? { feedback, answers } : { feedback }, d => {
    if (d.status) { state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { state.planProgress = d.progress; renderPlanLive(); }
    if (d.questions) asked = { stage: 'refine', feedback: d.feedback || feedback, data: d.questions };
  }, state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  state.planning = false;
  if (asked) {
    state.pendingAsk = asked;
    toast('AI 想先确认几个问题，回答后继续调整');
    try { await loadGoal(id); } catch (e) {}
  } else if (r.error) { toast(r.error); } else { state.goal = r.data.goal; if (r.data.report) state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id }; toast('骨架已按你的意见调整，请确认'); }
  try { await loadGoal(id); } catch (e) {}
  const rr = parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) renderMapPage();
}
function expandPanelHTML() {
  if (!state.expanding) return '';
  return `<div class="expandPanel"><span class="spinner"></span><span id="expandStatus">${esc(state.expandStatus || '准备中…')}</span></div>`;
}
async function startExpand(id, feedback, answers) {
  if (state.expanding || state.planning || state.collecting) return;
  const n = state.goal.nodes.find(x => x.id === id);
  if (!n) return;
  state.expanding = true;
  state.expandStatus = feedback ? `正在按你的意见调整「${String(n.title).slice(0, 14)}」的划分…` : `围绕「${String(n.title).slice(0, 18)}」搜集信息源…`;
  rerenderCurrent();
  let asked = null;
  try {
    const resp = await fetch('/api/nodes/' + id + '/expand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: feedback || '', answers: answers || null }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接拆分服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (d.status) {
          state.expandStatus = d.status;
          const el = document.getElementById('expandStatus');
          if (el) el.textContent = d.status;
        }
        if (d.sources) state.sources = d.sources;
        if (d.questions) {
          finished = true;
          asked = { stage: 'expand', nodeId: id, nodeTitle: d.nodeTitle || n.title, feedback: d.feedback || feedback || '', data: d.questions };
        }
        if (d.done) {
          finished = true;
          state.goal = d.goal;
          state.expanded['t' + id] = true;
          state.expanded['g' + id] = true;
          state.expanded['s' + id] = true;
          if (d.report) state.lastReport = { text: d.report, versionId: d.versionId, goalId: d.goal.id };
          toast('拆分完成：新增 ' + d.added + ' 个细任务');
        }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    if (asked) { state.pendingAsk = asked; toast('AI 想先确认几个问题，回答后继续拆分'); }
    else if (!finished) toast('拆分中断，可重试');
  } catch (e) {
    toast(e.message);
  } finally {
    state.expanding = false;
    state.expandStatus = '';
    try { await loadGoal(state.goal.id); } catch (e) {}
    rerenderCurrent();
  }
}
function sourceItemHTML(s) {
  const body = String(s.content || s.snippet || '').trim();
  const star = Number(s.quality) === 1;
  return `<div class="srcItem ${star ? 'isStar' : ''}">
    <div class="siHead">
      <button class="siStar ${star ? 'on' : ''}" data-src-star="${s.id}" title="${star ? '已标注为优质信息源（规划会优先参考）' : '标注为优质信息源（规划会优先参考）'}">${star ? '★' : '☆'}</button>
      <span class="chip gray">${esc(s.site || '未知来源')}</span>
      <span class="chip">${esc(s.kind || '资料')}</span>
      ${star ? '<span class="chip ok" title="规划时优先参考">优质</span>' : ''}
      ${s.published_at ? `<span class="chip ok siDate" title="发布时间">${esc(s.published_at)}</span>` : '<span class="chip warn siDate" title="未标注发布时间（招聘平台在招岗位默认当前有效）">近期</span>'}
      <a class="siTitle" href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a>
      <button class="btn tiny danger siDel" data-src="${s.id}" title="删除这条来源">×</button>
    </div>
    ${body ? `<details class="siDet"><summary>${esc(body.replace(/\s+/g, ' ').slice(0, 120))}${body.length > 120 ? '…' : ''}（${body.length} 字）</summary><div class="siFull mdBody">${mdToHTML(body.slice(0, 20000))}</div></details>` : ''}
  </div>`;
}
function srcPanelHTML() {
  const list = state.sources || [];
  const digests = state.digests || [];
  let h = `<div class="srcPanel">
    <div class="spHead">
      <span class="spTitle">信息源</span><span class="spCount">${list.length}</span>
      <span class="spHint">大厂 JD · 牛客 · BOSS直聘 · 知乎等真实资料，规划时优先依据</span>
      <div class="spacer"></div>
        <button class="btn small" id="collectBtn">${list.length ? '重新收集' : '收集信息源'}</button>
        <button class="btn small primary" <button class="btn small" id="srcAddBtn" title="粘贴文本、或填写标题与链接，手动添加一条资料（可标为优质信息源）">＋ 添加资料</button>
        <button class="btn small primary" id="digestBtn" title="让 AI 通读全部资料（含你上传的图片资料），提炼成多篇主题汇总，规划时优先依据">🧠 ${digests.length ? '重新提炼' : '信息提炼'}</button>
      </div>`;
  if (state.collecting) {
      h += `<div class="spProgress"><span class="spinner"></span><span id="spStatus">${esc(state.collectStatus || '正在检索…')}</span><div class="spacer"></div><button class="btn tiny" id="collectStop" title="停止本次收集（已收集到的会保留）">⏹ 停止</button></div>`;
  }
    const starCount = list.filter(x => Number(x.quality) === 1).length;
    if (starCount) h += `<div class="spStarTip">★ 优质信息源 ${starCount} 条 —— 规划时会重点依据这些资料（可在资料左侧点 ★ 标注/取消）</div>`;
    if (state.srcFormOpen) {
      h += `<div class="srcForm">
        <div class="sfRow"><input id="sfTitle" placeholder="标题（如：Agent 面试知识库 / 某厂 JD）" value="${esc(state.srcFormTitle || '')}"></div>
        <div class="sfRow">
          <select id="sfKind">${['资料', 'JD', '面经', '学习路线', '大纲', '笔记', '课程', '资源'].map(k => `<option ${state.srcFormKind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <input id="sfSite" placeholder="来源（如 GitHub / 某厂官网）" value="${esc(state.srcFormSite || '')}">
          <label class="sfStar"><input type="checkbox" id="sfQuality" ${state.srcFormQuality ? 'checked' : ''}> 标为优质信息源</label>
        </div>
        <div class="sfRow"><input id="sfUrl" placeholder="链接（可选）" value="${esc(state.srcFormUrl || '')}"></div>
        <div class="sfRow"><textarea id="sfContent" placeholder="把文本粘贴到这里（Ctrl+V 直接粘贴，越完整越好）">${esc(state.srcFormContent || '')}</textarea></div>
        <div class="sfOps">
          <button class="btn small primary" id="sfSave">保存为资料</button>
          <button class="btn small" id="sfPaste">从剪贴板粘贴</button>
          <button class="btn small" id="sfCancel">取消</button>
        </div>
      </div>`;
    }
    if (state.digesting) {
      const dp = state.digestProgress || {};
      h += `<div class="spProgress"><span class="spinner"></span><span id="spStatus">${esc(state.digestStatus || '正在通读资料…')}</span>${dp.total ? `<span class="muted" style="font-size:11.5px;">（${dp.done || 0}/${dp.total} 批）</span>` : ''}<div class="spacer"></div><button class="btn tiny" id="digestStop" title="停止提炼">⏹ 停止</button></div>`;
    }
    if (digests.length) {
      h += `<div class="spDigests"><div class="spDigestsHead">📄 提炼汇总（${digests.length} 篇 · 规划优先依据）<div class="spacer"></div><a class="btn tiny" href="/api/goals/${(state.goal || {}).id}/digests/export" download>⬇ 下载全部 MD</a></div>`
        + digests.map(d => `<details class="spDigest"><summary>${esc(d.title || d.topic)}</summary><div class="spDigestBody mdBody">${mdToHTML(d.content || '')}</div><div class="spDigestOps"><span class="muted" style="font-size:11.5px;">依据 ${d.sources_count || 0} 条资料 · ${esc(fmtDate(d.created_at))}</span><div class="spacer"></div><button class="btn tiny danger" data-digest-del="${d.id}">删除</button></div></details>`).join('')
        + `</div>`;
    }
  if (list.length) {
    h += `<details class="spDetails"><summary>查看来源列表（${list.length} 条）</summary><div class="spList">${list.map(sourceItemHTML).join('')}</div></details>`;
  } else if (!state.collecting) {
    h += '<div class="spEmpty">还没有信息源。建议先「收集信息源」，AI 规划会依据真实 JD 与面经，质量更高。</div>';
  }
  h += '</div>';
  return h;
}
/* 信息提炼：让 AI 通读全部资料（含图片资料）→ 提炼成多篇主题 MD 汇总 → 规划优先依据 */
async function startDigest(id) {
  if (state.digesting) return;
  if (!(await ensureAIConfigured())) return;
  if (!(state.sources || []).length) { toast('还没有资料：先「收集信息源」或上传图片资料'); return; }
  if (!confirm('让 AI 通读全部 ' + (state.sources || []).length + ' 条资料并提炼成多篇主题汇总？\n\n你的资料越多耗时越长（100 条以上大约 10-20 分钟，期间可随时点「⏹ 停止」，已提炼的部分会保留），提炼结果会用于后续规划。')) return;
  state.digesting = true;
  state.digestStatus = '正在通读资料…';
  state.digestProgress = null;
  state.digestAbort = new AbortController();
  renderGoal();
  try {
    const resp = await fetch('/api/goals/' + id + '/sources/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: state.digestAbort.signal });
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
        if (d.status) { state.digestStatus = d.status; const el = document.getElementById('spStatus'); if (el) el.textContent = d.status; }
        if (d.progress) { state.digestProgress = d.progress; }
        if (d.done) { done = true; state.digests = d.digests || []; toast('提炼完成：' + d.count + ' 篇主题汇总（规划会优先依据）'); }
        if (d.cancelled) { done = true; toast(d.status || '已停止提炼'); }
        if (d.error) { done = true; toast(d.error); }
      }
    }
    if (!done) toast('提炼中断，可重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast(e.message);
  } finally {
    state.digesting = false;
    state.digestStatus = '';
    state.digestProgress = null;
    state.digestAbort = null;
    try { await loadGoal(id); } catch (e) {}
    renderGoal();
  }
}
async function startCollect(id) {
  if (typeof compOn === 'function' && !compOn('sources')) { toast('「信息源检索」组件已关闭：左侧栏 → 🧩 组件 可开启'); return; }
  if (state.collecting) return;
  state.collecting = true;
  state.collectStatus = '正在检索…';
  renderGoal();
  try {
    state.collectAbort = new AbortController();
      const resp = await fetch('/api/goals/' + id + '/collect', { method: 'POST', signal: state.collectAbort.signal });
    if (!resp.ok || !resp.body) throw new Error('无法连接采集服务');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
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
          state.collectStatus = d.status;
          const el = document.getElementById('spStatus');
          if (el) el.textContent = d.status;
        }
        if (d.done) { done = true; state.sources = d.sources || []; toast('信息源收集完成：' + d.count + ' 条' + (d.blocked ? '（百度限流，本次用备用搜索，可稍后重新收集以获取更多）' : '')); }
        if (d.error) { done = true; toast(d.error); }
      }
    }
    if (!done) toast('信息源收集中断，可重试');
  } catch (e) {
    toast(e.message);
  } finally {
    state.collecting = false;
    state.collectStatus = '';
    try { await loadGoal(id); } catch (e) {}
    renderGoal();
    // 收集完成后若还没有路径，自动开始规划
    if (state.goal && !state.goal.nodes.length && !state.planning) {
      startPlanning(id);
    }
  }
}
function nextCardHTML(g) {
  if (!g.tasks_total) return '';
  if (!g.next_task) {
    return `<div class="nextCard allDone"><div class="ncLabel">全部完成</div><div class="ncBody"><div class="ncTitle">🎉 这条路径的任务已全部完成</div></div></div>`;
  }
  const doing = g.next_task_status === 'doing';
  return `<div class="nextCard">
    <div class="ncLabel">下一步</div>
    <div class="ncBody">
      <div class="ncTitle">${esc(g.next_task)}</div>
      ${g.next_path ? `<div class="ncPath">${esc(g.next_path)}</div>` : ''}
    </div>
    <div class="ncOps">
      ${doing
        ? '<button class="btn small primary" id="nextDone">完成</button><button class="btn small" id="nextPause">暂停</button>'
        : '<button class="btn small primary" id="nextStart">开始</button>'}
      <button class="btn small" id="nextOpen">详情</button>
    </div>
  </div>`;
}
function viewBarHTML(g) {
  const f = state.filter;
  const filters = [['', '全部'], ['todo', '未开始'], ['doing', '进行中'], ['done', '已完成']];
  return `<div class="viewBar">
    <a class="btn primary" href="#/g/${g.id}/map">🗺 打开路径图</a>
    <div class="vbFilters">
      ${filters.map(([v, l]) => `<button class="fchip ${f === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
    </div>
    <div class="spacer"></div>
    <span class="hint">路径图支持左键拖拽平移 · 滚轮缩放</span>
  </div>`;
}
function filterTree(stages) {
  if (!state.filter) return stages;
  const out = [];
  for (const st of stages) {
    const subs = [];
    for (const g of st.children) {
      const tasks = g.children.filter(t => t.status === state.filter);
      if (tasks.length) subs.push({ ...g, children: tasks });
    }
    if (subs.length) out.push({ ...st, children: subs });
  }
  return out;
}
function listTaskHTML(t) {
  const st = ST_LABEL[t.status] ? t.status : 'todo';
  const srcN = (t.sourcesArr || []).length;
  const kids = (t.children && t.children.length)
    ? `<div class="tlKids">${t.children.map(listTaskHTML).join('')}</div>`
    : '';
  return `<div class="tlTaskWrap">
    <div class="tlTask ${st}" data-node-id="${t.id}" data-detail="${t.id}" title="点击查看详情 · 右键打开菜单">
      <button class="stDot ${st}" data-cycle="${t.id}" title="点击切换状态">${st === 'done' ? '✓' : ''}</button>
      <span class="tlTaskTitle">${esc(t.title)}</span>
      ${t.artifact ? `<span class="tlArtifact" title="产出物：${esc(t.artifact)}">📦</span>` : ''}
      ${t.hours ? `<span class="chip gray tlHours">${esc(t.hours)}</span>` : ''}
      <span class="srcBadge ${srcN ? '' : 'warn'}">📎${srcN}</span>
      <span class="nodeOps">
        <button class="btn tiny" data-expand="${t.id}" title="AI 深度拆分">✨</button>
        <button class="btn tiny" data-edit="${t.id}" title="编辑">✎</button>
        <button class="btn tiny danger" data-del="${t.id}" title="删除">×</button>
      </span>
    </div>
    ${kids}
  </div>`;
}
function listViewHTML(stages) {
  if (!stages.length) return '<div class="empty">没有匹配的任务</div>';
  let h = '<div class="taskListView">';
  stages.forEach((st, si) => {
    const p = subtreeProgress(st);
    h += `<div class="tlStage">
      <div class="tlStageHead">
        <span class="stageIdx">${String(si + 1).padStart(2, '0')}</span>
        <span class="tlStageTitle">${esc(st.title)}</span>
        <span class="mtProg">${p.done}/${p.total}</span>
      </div>`;
    for (const g of st.children) {
      const gp = subtreeProgress(g);
      h += `<div class="tlSub">
        <div class="tlSubHead"><span class="tlSubTitle">${esc(g.title)}</span><span class="mtProg">${gp.done}/${gp.total}</span></div>
        ${g.children.map(listTaskHTML).join('')}
      </div>`;
    }
    h += '</div>';
  });
  return h + '</div>';
}
function renderGoal() {
  const g = state.goal;
  if (!g) { app.innerHTML = '<p class="muted">目标不存在</p>'; return; }
  if (!state.aiStatus) {
    api('/api/ai/status').then(st => { state.aiStatus = st; renderGoal(); }).catch(() => { state.aiStatus = {}; });
  }
  const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
  const stages = buildTree(g.nodes);
  const stMap = { draft: ['待规划', 'warn'], review: ['骨架待确认', 'warn'], planned: ['已规划', 'ok'], failed: ['规划失败', 'danger'] };
  const st = (g.status === 'planning' && !state.planning) ? ['上次规划中断', 'warn'] : (stMap[g.status] || (state.planning ? ['规划中…', ''] : ['待规划', 'warn']));
  let html = `<div class="page">
    <div class="pageHead">
      <a class="back js-back" href="#/">← 返回</a>
      <div class="spacer"></div>
      <button class="btn" id="editGoalBtn">编辑目标</button>
      <button class="btn" id="shareGoalBtn" title="把这份规划与资料库打包分享给别人（对方可一键导入）。默认隐去学校/公司/姓名/联系方式等隐私">🔗 分享</button>
      ${compOn('chat') ? '<button class="btn" id="chatBtn">💬 AI 助手</button>' : ''}
      ${pluginButtonsHTML(g)}
      ${g.nodes.length && compOn('versions') ? '<button class="btn" id="verBtn">📜 版本对比</button>' : ''}
      <button class="btn primary" id="planBtn">${g.nodes.length ? '重新规划（AI 先澄清）' : '开始 AI 规划（AI 先澄清）'}</button>
      <button class="btn danger" id="delGoalBtn">删除</button>
    </div>
    <div class="goalHead">
      <div class="ghTop"><h2 class="ghTitle">${esc(g.title)}</h2><span class="chip ${st[1]}">${st[0]}</span></div>
      ${g.summary ? `<div class="ghSummary">规划思路：${mdOneLine(g.summary)}</div>` : ''}
      <div class="ghMeta">
        ${g.profile ? `<div class="ghItem"><span class="ghLabel">现状</span>${esc(g.profile)}</div>` : ''}
        ${g.weekly_hours ? `<span class="chip gray">每周 ${esc(g.weekly_hours)}</span>` : ''}
        ${g.deadline ? `<span class="chip gray">期限 ${esc(g.deadline)}</span>` : ''}
        <span class="chip gray">任务完成 ${g.tasks_done}/${g.tasks_total}</span>
      </div>
      <div class="bar big"><div class="barFill" style="width:${pct}%"></div></div>
      ${g.error ? `<div class="goalError">⚠ ${esc(g.error)}</div>` : ''}
    </div>`;
  html += setupCardHTML();
  html += disabledComponentsHTML();
  html += reportCardHTML();
  if (compOn('tutorial')) html += tutorialCardHTML();
  if (compOn('constraints')) html += constraintsCardHTML(g);
  if (compOn('sources')) html += srcPanelHTML();
  html += expandPanelHTML();
  html += tutProgressHTML();
  html += planPanelHTML();
  if (state.showEdit) html += editGoalHTML(g);
  if (stages.length) {
    html += nextCardHTML(g);
    html += viewBarHTML(g);
    const fStages = filterTree(stages);
    html += listViewHTML(fStages);
  } else if (!state.planning) {
    html += `<div class="emptyBox" style="margin-top:8px;">
      <div class="ebIcon">🧭</div>
      <div class="ebTitle">还没有路径</div>
      <div class="ebText">${g.status === 'failed' ? '上次规划失败。' : ''}收集信息源后点「开始 AI 规划」，AI 会生成 阶段 → 小目标 → 任务 的可视化路径。</div>
      <button class="btn primary" id="emptyPlanBtn">开始 AI 规划</button>
    </div>`;
  }
  html += '</div>';
  app.innerHTML = html;

  bindReportCard();
  bindTutorialCard();
  pluginGoButtonsBind();     // 组件入口按钮（每日刷题 / 图片资料…）
  bindConstraints(g);
  const chatBtn = document.getElementById('chatBtn');
  if (chatBtn) chatBtn.addEventListener('click', () => aiToggle(true));
  const verBtn = document.getElementById('verBtn');
  if (verBtn) verBtn.addEventListener('click', () => showVersionsPanel(g.id));
  const planBtnEl = document.getElementById('planBtn');
  planBtnEl.addEventListener('click', () => startClarify(g.id));
  const emptyPlan = document.getElementById('emptyPlanBtn');
  if (emptyPlan) emptyPlan.addEventListener('click', () => startClarify(g.id));
  const starBtns = app.querySelectorAll('[data-src-star]');
  starBtns.forEach(b => b.addEventListener('click', async () => {
    const id = Number(b.getAttribute('data-src-star'));
    const cur = (state.sources || []).find(x => Number(x.id) === id);
    const next = !(cur && Number(cur.quality) === 1);
    try {
      const r = await api('/api/sources/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: next }) });
      state.sources = r.sources || state.sources;
      toast(next ? '已标为优质信息源：规划时会优先参考' : '已取消优质标记');
      renderGoal();
    } catch (e) { toast(e.message); }
  }));
  const addBtn = document.getElementById('srcAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => { state.srcFormOpen = !state.srcFormOpen; renderGoal(); });
  const sfCancel = document.getElementById('sfCancel');
  if (sfCancel) sfCancel.addEventListener('click', () => {
    state.srcFormOpen = false; state.srcFormTitle = ''; state.srcFormContent = ''; state.srcFormUrl = ''; state.srcFormSite = ''; state.srcFormQuality = false; renderGoal();
  });
  const sfPaste = document.getElementById('sfPaste');
  if (sfPaste) sfPaste.addEventListener('click', async () => {
    try { const t = await navigator.clipboard.readText(); const el = document.getElementById('sfContent'); if (el && t) { el.value = t; toast('已粘贴 ' + t.length + ' 字'); } }
    catch (e) { toast('读取剪贴板失败，请直接在文本框里按 Ctrl+V 粘贴'); }
  });
  const sfSave = document.getElementById('sfSave');
  if (sfSave) sfSave.addEventListener('click', async () => {
    const title = (document.getElementById('sfTitle') || {}).value || '';
    const content = (document.getElementById('sfContent') || {}).value || '';
    const kind = (document.getElementById('sfKind') || {}).value || '资料';
    const site = (document.getElementById('sfSite') || {}).value || '手动添加';
    const url = (document.getElementById('sfUrl') || {}).value || '';
    const quality = !!(document.getElementById('sfQuality') || {}).checked;
    if (!title.trim() && !content.trim()) return toast('请填写标题或粘贴正文');
    sfSave.disabled = true; sfSave.textContent = '保存中…';
    try {
      const r = await api('/api/goals/' + g.id + '/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, kind, site, url, quality }) });
      state.sources = r.sources || state.sources;
      state.goal = r.goal || state.goal;
      state.srcFormOpen = false; state.srcFormTitle = ''; state.srcFormContent = ''; state.srcFormUrl = ''; state.srcFormSite = ''; state.srcFormQuality = false;
      toast('已添加资料' + (quality ? '（优质信息源）' : ''));
      renderGoal();
    } catch (e) { toast(e.message); sfSave.disabled = false; sfSave.textContent = '保存为资料'; }
  });
  const cb = document.getElementById('collectBtn');
  if (cb) cb.addEventListener('click', () => startCollect(g.id));
  const cs = document.getElementById('collectStop');
  if (cs) cs.addEventListener('click', () => { if (state.collectAbort) state.collectAbort.abort(); });
  const db2 = document.getElementById('digestBtn');
  if (db2) db2.addEventListener('click', () => startDigest(g.id));
  const ds = document.getElementById('digestStop');
  if (ds) ds.addEventListener('click', () => { if (state.digestAbort) state.digestAbort.abort(); });
  app.querySelectorAll('[data-digest-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这篇提炼汇总？')) return;
    try { await api('/api/digests/' + b.getAttribute('data-digest-del'), { method: 'DELETE' });
      state.digests = (state.digests || []).filter(x => String(x.id) !== String(b.getAttribute('data-digest-del')));
      toast('已删除'); renderGoal();
    } catch (e) { toast(e.message); }
  }));
  if (state.planning || state.collecting) {
    planBtnEl.disabled = true;
    if (cb) cb.disabled = true;
    document.getElementById('delGoalBtn').disabled = true;
  }
  app.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => {
    state.filter = el.getAttribute('data-filter');
    renderGoal();
  }));
  const nid = g.next_task_id;
  if (nid) {
    [['nextStart', 'doing'], ['nextDone', 'done'], ['nextPause', 'todo']].forEach(([id, status]) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', async () => {
        try {
          const r = await api('/api/nodes/' + nid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
          state.goal = r.goal;
          renderGoal();
          toast(status === 'done' ? '已完成 ✓' : '已更新');
        } catch (e) { toast(e.message); }
      });
    });
    const no = document.getElementById('nextOpen');
    if (no) no.addEventListener('click', e => { e.stopPropagation(); showNodePanel(nid); });
  }
  app.querySelectorAll('.siDel').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-src');
    try {
      await api('/api/sources/' + sid, { method: 'DELETE' });
      state.sources = state.sources.filter(s => String(s.id) !== String(sid));
      renderGoal();
      toast('已删除该来源');
    } catch (err) { toast(err.message); }
  }));
  document.getElementById('delGoalBtn').addEventListener('click', async () => {
    if (!confirm('删除这个目标和它的全部路径？')) return;
    try { await api('/api/goals/' + g.id, { method: 'DELETE' }); toast('已删除'); go('#/'); } catch (e) { toast(e.message); }
  });
  document.getElementById('editGoalBtn').addEventListener('click', () => { state.showEdit = !state.showEdit; renderGoal(); });
  const shareBtn = document.getElementById('shareGoalBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => showShareDialog(g.id));
  const ef = document.getElementById('editGoalForm');
  if (ef) {
    document.getElementById('egCancel').addEventListener('click', () => { state.showEdit = false; renderGoal(); });
    ef.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const { goal } = await api('/api/goals/' + g.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          title: document.getElementById('egTitle').value,
          profile: document.getElementById('egProfile').value,
          materials: document.getElementById('egMaterials').value,
          weekly_hours: document.getElementById('egHours').value,
          deadline: document.getElementById('egDeadline').value
        }) });
        state.goal = goal; state.showEdit = false; renderGoal(); toast('已保存（可重新规划使新信息生效）');
      } catch (err) { toast(err.message); }
    });
  }
  if (state.planning) bindPlanningPanel();
  bindPlanPanel();
  bindTreeEvents(renderGoal);
}
/* 树节点事件（执行页清单 & 导图页共用） */
function bindTreeEvents(rerender) {
  const onUpdate = goal => { state.goal = goal; rerender(); };
  app.querySelectorAll('[data-childtoggle]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation();
    const key = el.getAttribute('data-childtoggle');
    const item = el.closest('.mtitem');
    const branch = item ? item.querySelector(':scope > .mtbranch') : null;
    if (!branch) return;
    const open = branch.style.display === 'none';
    branch.style.display = open ? 'flex' : 'none';
    el.textContent = open ? '▾' : '▸';
    state.expanded[key] = open;
    drawMapLines();
  }));
  app.querySelectorAll('[data-expand]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    startExpand(Number(btn.getAttribute('data-expand')));
  }));
  app.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.nodeOps') || e.target.closest('.srcBadge')) return;
    const key = el.getAttribute('data-toggle');
    const item = el.closest('.mtitem');
    const branch = item ? item.querySelector(':scope > .mtbranch') : null;
    if (!branch) return;
    const open = branch.style.display === 'none';
    branch.style.display = open ? 'flex' : 'none';
    el.classList.toggle('open', open);
    const arrow = el.querySelector('.arrow');
    if (arrow) arrow.textContent = open ? '▾' : '▸';
    state.expanded[key] = open;
    drawMapLines();
  }));
  app.querySelectorAll('[data-detail]').forEach(el => el.addEventListener('click', () => {
    showNodePanel(Number(el.getAttribute('data-detail')), rerender);
  }));
  app.querySelectorAll('[data-cycle]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-cycle'));
    const n = state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const next = ST_NEXT[n.status] || 'todo';
    try {
      const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      onUpdate(r.goal);
      toast(next === 'done' ? '已完成 ✓' : next === 'doing' ? '进行中' : '已回到未开始');
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-edit'));
    const n = state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const title = (prompt('标题：', n.title) || '').trim();
    if (!title) return;
    const d = window.prompt('说明（可留空）：', n.detail);
    if (d === null) return;
    try {
      const r = await api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, detail: d }) });
      onUpdate(r.goal);
    } catch (err) { toast(err.message); }
  }));
  app.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-del'));
    const n = state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    if (!confirm('删除「' + n.title + '」' + (n.level < 2 ? '（含其下全部内容）' : '') + '？')) return;
    try {
      const r = await api('/api/nodes/' + id, { method: 'DELETE' });
      onUpdate(r.goal);
      toast('已删除');
    } catch (err) { toast(err.message); }
  }));
  app.querySelectorAll('.addChild').forEach(btn => btn.addEventListener('click', async () => {
    const parent = Number(btn.getAttribute('data-parent'));
    const title = (prompt('添加' + (btn.getAttribute('data-level') === '2' ? '任务' : '小目标') + '：') || '').trim();
    if (!title) return;
    try {
      const r = await api('/api/goals/' + state.goal.id + '/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: parent, title }) });
      state.expanded['g' + parent] = true;
      state.expanded['s' + parent] = true;
      onUpdate(r.goal);
    } catch (err) { toast(err.message); }
  }));
  drawMapLines();
}
function editGoalHTML(g) {
  return `<form class="newForm" id="editGoalForm">
    <div class="field"><label>职业目标 *</label><input id="egTitle" value="${esc(g.title)}"></div>
    <div class="grid2">
      <div class="field"><label>当前起点</label><textarea id="egProfile">${esc(g.profile)}</textarea></div>
      <div class="field"><label>目标岗位 JD / 参考资料</label><textarea id="egMaterials">${esc(g.materials)}</textarea></div>
    </div>
    <div class="grid2">
      <div class="field"><label>每周可投入</label><input id="egHours" value="${esc(g.weekly_hours)}"></div>
      <div class="field"><label>期望期限</label><input id="egDeadline" value="${esc(g.deadline)}"></div>
    </div>
    <div class="toolbarRow">
      <button class="btn primary" type="submit">保存</button>
      <button class="btn" type="button" id="egCancel">取消</button>
    </div>
  </form>`;
}
/* ============ 首次使用引导（含界面演示动画 + 可直接配置） ============ */
const GUIDE_STEPS = [
  {
    icon: '👋', title: '欢迎使用「思而行」',
    visual: `<div class="gmWindow">
      <div class="gmRail">
        <span class="gmRailIcon gmLogoMini" style="--d:0s">思</span>
        <span class="gmRailIcon" style="--d:.15s">🏠</span>
        <span class="gmRailIcon" style="--d:.3s">🗺</span>
        <span class="gmRailIcon" style="--d:.45s">🧩</span>
        <span class="gmRailIcon" style="--d:.6s">📷</span>
        <span class="gmRailSpacer"></span>
        <span class="gmRailIcon gmPulse" style="--d:.9s">⚙</span>
        <span class="gmRailIcon" style="--d:1.05s">🧩</span>
        <span class="gmRailSpacer"></span>
        <span class="gmRailIcon" style="--d:1.2s">🌙</span>
      </div>
      <div class="gmBody">
        <div class="gmTitle" style="--d:.2s">我的目标</div>
        <div class="gmCardRow" style="--d:.4s"><span class="gmPill">🎯 转行数据分析师</span><span class="gmBar"><i style="width:42%"></i></span></div>
        <div class="gmCardRow" style="--d:.6s"><span class="gmPill">📈 3 个月学会摄影后期</span><span class="gmBar"><i style="width:68%"></i></span></div>
        <div class="gmCardRow" style="--d:.8s"><span class="gmPill">🧠 考研上岸</span><span class="gmBar"><i style="width:15%"></i></span></div>
      </div>
    </div>
    <div class="gmCaption">左侧栏导航 · 中间是目标与路线图 · 数据全在本机</div>`,
    html: `<p class="gdP">思而行是一个<b>目标规划助手</b>：说清目标与现状，它先和你反复确认，再拆成一条能执行的路径，且<b>随时可以改</b>。</p>
      <div class="gdChips"><span>🗣 先确认再规划</span><span>🧩 一切皆组件</span><span>🔒 本地运行</span></div>`
  },
  {
    icon: '🔌', title: '接入模型 / Agent（最重要）',
    visual: `<div class="gmSetting">
      <div class="gmSeg">
        <span class="gmSegHi"></span>
        <span class="gmSegBtn">OpenAI 兼容接口</span>
        <span class="gmSegBtn">opencode CLI（Agent）</span>
      </div>
      <div class="gmRow"><span class="gmLabel">服务商</span><span class="gmInput gmPicker">OpenAI 兼容接口 ▾　（也可选 opencode CLI）</span></div>
      <div class="gmRow"><span class="gmLabel">API 地址</span><span class="gmInput gmTypingBox"><span class="gmTyping">https://api.deepseek.com/v1</span></span></div>
      <div class="gmRow"><span class="gmLabel">API 密钥</span><span class="gmInput">••••••••••••<span class="gmCaret"></span></span></div>
      <div class="gmRow"><span class="gmLabel">模型</span><span class="gmInput">deepseek-chat</span></div>
      <div class="gmCliHint">选 <b>opencode CLI</b>：地址与密钥留空，模型填 <code>provider/model</code>（如 opencode-go/deepseek-v4-flash），由本机已登录的 CLI 提供能力</div>
      <div class="gmRowEnd">
        <span class="gmBtn gmBtnClick">测试连接</span>
        <span class="gmOk">✅ 连接正常</span>
      </div>
    </div>
    <div class="gmCaption">左侧栏 → ⚙ 设置：选服务商 → 填密钥 → 测试连接</div>`,
    html: `<p class="gdP">问卷、规划、教程、对话都由 AI 完成，<b>先接一个模型</b>。可以直接在下面配置（也能稍后在「设置」里改）：</p>
      <div class="gdForm" id="gdAiForm">
        <div class="gdSeg2" id="gdProvSeg">
          <button type="button" class="gdSegBtn active" data-prov="openai">OpenAI 兼容接口（推荐）</button>
          <button type="button" class="gdSegBtn" data-prov="opencode">opencode CLI（Agent）</button>
        </div>
        <div id="gdOpenaiBox">
          <div class="gdPresets">点一下自动填好：${AI_PRESETS.map((p, i) => `<button type="button" class="gdPreset" data-gdpre="${i}">${esc(p.name)}</button>`).join('')}</div>
          <input id="gdAiBase" placeholder="API 地址，如 https://api.deepseek.com/v1">
          <div class="gdSyncRow2">
            <input id="gdAiKey" type="password" placeholder="API 密钥（本地 Ollama 可随便填）">
            <input id="gdAiModel" placeholder="模型，如 deepseek-chat">
          </div>
        </div>
        <div id="gdOpencodeBox" hidden>
          <input id="gdAiModel2" placeholder="模型，如 opencode-go/deepseek-v4-flash">
          <input id="gdAiAgent" value="NoTools" placeholder="代理（默认 NoTools，用到时自动创建）">
          <p class="hint" style="margin:6px 0 0;">opencode 方式无需填地址与密钥（复用本机已登录的 CLI）</p>
        </div>
        <div class="toolbarRow" style="margin-top:10px;">
          <button class="btn primary" id="gdAiSave">保存并测试连接</button>
          <span class="hint" id="gdAiMsg"></span>
        </div>
      </div>
      <div class="gdNote">💡 没有密钥？装 <b>Ollama</b> 选「本地 Ollama」预设，离线免费。<br>
      💡 密钥只存本机（数据库或 <code>.env</code>），不会写进代码、不会显示在页面上。</div>`
  },
  {
    icon: '🧩', title: '组件是什么（最重要）',
    visual: `<div class="gmComp">
      <div class="gmCompRow" style="--d:.1s"><span class="gmCompIcon">📝</span><span class="gmCompName">规划前问卷</span><span class="gmSw gmSwOn"></span></div>
      <div class="gmCompRow" style="--d:.35s"><span class="gmCompIcon">⛓</span><span class="gmCompName">规划约束</span><span class="gmSw gmSwOn"></span></div>
      <div class="gmCompRow" style="--d:.6s"><span class="gmCompIcon">💬</span><span class="gmCompName">对话改规划</span><span class="gmSw gmSwOn"></span></div>
      <div class="gmCompRow" style="--d:.85s"><span class="gmCompIcon">🧩</span><span class="gmCompName">每日刷题</span><span class="gmSw gmSwOff"></span></div>
      <div class="gmCompRow gmThemeRow" style="--d:1.1s"><span class="gmCompIcon">🌑</span><span class="gmCompName">碳黑主题</span><span class="gmSw gmSwOff"></span></div>
      <div class="gmShareRow" style="--d:1.5s">
        <span class="gmChip">导出</span><span class="gmArrow">→</span><span class="gmPkg">📦 component.json</span><span class="gmArrow">→</span><span class="gmChip">导入</span>
      </div>
    </div>
    <div class="gmCaption">左侧栏 → 🧩 组件：开关功能 / 换肤 / 导入导出分享</div>`,
    html: `<p class="gdP">每个功能、甚至<b>界面样式</b>都是组件，可开关、可换肤、可分享：</p>
      <div class="gdGrid">
        <div class="gdCard"><b>🧭 核心</b><span>路线图与规划（不可关闭）</span></div>
        <div class="gdCard"><b>🎨 主题</b><span>碳黑、宣纸等皮肤，本质是覆盖设计变量的 CSS 组件</span></div>
        <div class="gdCard"><b>🧩 扩展</b><span>每日刷题、图片资料…可按目标启用，可导出给别人</span></div>
        <div class="gdCard"><b>📦 导入分享</b><span>组件页可导出 <code>*.component.json</code> 发给别人，也能一次导入多个</span></div>
      </div>
      <div class="gdForm" id="gdCompForm">
        <div class="hint" style="margin-bottom:8px;">基础功能组件（默认全开，不需要的可以直接关掉）：</div>
        <div class="gdCompList" id="gdCompList"><span class="muted" style="font-size:12.5px;">加载中…</span></div>
      </div>`
  },
  {
    icon: '🧭', title: '一条目标的完整流程',
    visual: `<div class="gmFlow">
      <span class="gmFlowTrack"><i class="gmFlowDot"></i></span>
      <span class="gmFlowStep" style="--i:0"><b>🎯</b><span>新建目标</span></span>
      <span class="gmFlowStep" style="--i:1"><b>📝</b><span>问卷+深挖</span></span>
      <span class="gmFlowStep" style="--i:2"><b>⛓</b><span>加约束</span></span>
      <span class="gmFlowStep" style="--i:3"><b>🧭</b><span>确认骨架</span></span>
      <span class="gmFlowStep" style="--i:4"><b>✅</b><span>细化任务</span></span>
      <span class="gmFlowStep" style="--i:5"><b>📘</b><span>执行/教程/对话</span></span>
    </div>
    <div class="gmCaption">每一步都能停下来改：提意见、深挖追问、随时调整</div>`,
    html: `<ol class="gdSteps">
      <li><b>新建目标</b>：写清目标与现状，可粘贴参考资料（JD / 大纲 / 笔记），也可直接上传图片资料，勾选需要的组件。</li>
      <li><b>回答问卷</b>：不确定的点 <b>🔍 进一步探讨</b> 让 AI 追问，也可自己补充信息。</li>
      <li><b>加约束</b>：硬性要求写进 <b>⛓ 规划约束</b>（如"只能周末学，每周 ≤6 小时"）。</li>
      <li><b>确认骨架 → 细化任务</b>：先给阶段+小目标（可提意见重排），确认后再拆任务（每阶段 ≤10 个）。</li>
      <li><b>执行与打磨</b>：右键节点可 <b>✨ 深度拆分</b> 或 <b>📘 生成学习教程</b>；点 <b>💬</b> 让 AI 直接改路线图；改动都有 <b>📜 版本对比</b>。</li>
    </ol>`
  },
  {
    icon: '🔄', title: '多端同步（可选，但很实用）',
    visual: `<div class="gmSync">
      <div class="gmSyncRow" style="--d:.05s"><span class="gmSyncIcon">💻</span><span class="gmSyncName">电脑 A</span><span class="gmSyncArrow">⬆</span><span class="gmSyncRepo">你的 Git 仓库</span><span class="gmSyncArrow">⬇</span><span class="gmSyncName">电脑 B</span></div>
      <div class="gmSyncFile" style="--d:.5s">📄 sierxing-sync.json（数据快照，不含密钥）</div>
      <div class="gmSyncFlow" style="--d:.9s"><span>改动后自动上传</span><span>·</span><span>打开时自动拉取</span><span>·</span><span>冲突以最后保存为准</span></div>
    </div>
    <div class="gmCaption">填一个你自己的 Git 仓库地址即可，多台设备自动同步</div>`,
    html: `<p class="gdP">想让家里/公司两台电脑的数据自动同步？把<b>你自己的 Git 仓库</b>填进来就行（建议用私有仓库）：</p>
      <div class="gdSyncForm" id="gdSyncForm">
        <input id="gdSyncRepo" placeholder="仓库地址，如 https://atomgit.com/你的用户名/sierxing-data.git">
        <div class="gdSyncRow2">
          <input id="gdSyncUser" placeholder="用户名（可选，默认 oauth2）">
          <input id="gdSyncToken" type="password" placeholder="密码 / 访问令牌（私有仓库需要）">
        </div>
        <div class="toolbarRow">
          <button class="btn primary" id="gdSyncBtn">启用同步并上传当前数据</button>
          <span class="hint" id="gdSyncMsg"></span>
        </div>
      </div>
      <div class="gdNote">· 只同步数据快照（目标/任务/来源/教程/作答记录…），<b>AI 密钥、同步令牌等敏感信息不会同步</b><br>
      · 同步令牌只保存在本机；也可稍后在「设置 → 多端同步」里修改或关闭</div>`
  },
  {
    icon: '⌨️', title: '界面导航与数据',
    visual: `<div class="gmNav">
      <div class="gmNavRail">
        <span class="gmNavHi"></span>
        <span class="gmNavItem">🏠</span><span class="gmNavItem">🗺</span><span class="gmNavItem">📷</span>
        <span class="gmNavItem">⚙</span><span class="gmNavItem">🧩</span>
        <span class="gmNavBottom">🌙</span>
      </div>
      <div class="gmNavBody">
        <div class="gmPage">路线图 / 执行清单</div>
        <div class="gmChatPanel">
          <div class="gmBubble user">把第二阶段拆细一点</div>
          <div class="gmBubble ai">已拆成 3 个任务 ✏️ <span class="gmMini">查看变更详情 ▾</span></div>
          <div class="gmChatInput">💬 随时和 AI 说怎么改…</div>
        </div>
      </div>
    </div>
    <div class="gmCaption">左侧栏是唯一导航 · 右下 💬 是对话侧边栏 · 设置里可开「开机自启」与桌面图标</div>`,
    html: `<div class="gdGrid">
        <div class="gdCard"><b>左侧栏</b><span>顶部品牌图标（回目标列表）· 🏠 目标 / 🗺 路线图 / 组件入口 / ⚙ 设置 / 🧩 组件 · 底部 🌙 昼夜切换</span></div>
        <div class="gdCard"><b>右侧 💬 对话</b><span>自然语言改路线图；宽度与输入框高度可拖拽调节，支持多会话</span></div>
        <div class="gdCard"><b>数据与备份</b><span>设置页可备份 / 导出 JSON / 导入；每次改动自动备份到 data/backups/</span></div>
        <div class="gdCard"><b>桌面图标 · 终端命令 · 开机自启</b><span>设置页「服务与启动」可一键创建<b>桌面图标</b>（双击即用）与<b>终端命令</b>（<code>sierxing</code>），并随时<b>开关开机自启</b>——想让它开机自动跑，就把开关打开；不想就关掉。</span></div>
        <div class="gdCard"><b>随时回看本引导</b><span>首页「📖 使用引导」或设置页「帮助」</span></div>
      </div>
      <p class="gdTip" style="margin-top:12px;">准备好了吗？先接入模型（若还没配），然后新建你的第一个目标吧。</p>`
  }
];

/* 引导内容里的行内 Markdown（**粗体** / `代码`）→ HTML，保证排版正常 */
function gdInline(html) {
  return String(html == null ? '' : html)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function guideDone() { try { return localStorage.getItem('sierxing-guide-done') === '1'; } catch (e) { return false; } }
function showGuide(step) {
  state.guideStep = typeof step === 'number' ? step : 0;
  document.querySelectorAll('#guideMask').forEach(x => x.remove());
  const mask = document.createElement('div');
  mask.id = 'guideMask';
  mask.className = 'guideMask';
  document.body.appendChild(mask);
  drawGuide();
}
function closeGuide(remember) {
  if (remember) { try { localStorage.setItem('sierxing-guide-done', '1'); } catch (e) {} }
  const m = document.getElementById('guideMask');
  if (m) m.remove();
}
function drawGuide() {
  const mask = document.getElementById('guideMask');
  if (!mask) return;
  const i = state.guideStep || 0;
  const s = GUIDE_STEPS[i];
  const last = i === GUIDE_STEPS.length - 1;
  const aiReady = !!(state.aiStatus && state.aiStatus.configured);
  mask.innerHTML = `<div class="guideCard">
    <div class="guideHead">
      <span class="gdIcon">${s.icon}</span>
      <span class="gdTitle">${esc(s.title)}</span>
      <div class="spacer"></div>
      <span class="gdCount">${i + 1} / ${GUIDE_STEPS.length}</span>
      <button class="guideX" id="gdClose" title="关闭">×</button>
    </div>
    ${s.visual ? `<div class="guideVisual">${s.visual}</div>` : ''}
    <div class="guideBody mdBody">${gdInline(s.html)}</div>
    <div class="guideFoot">
      <label class="gdNoShow"><input type="checkbox" id="gdNoShow" ${guideDone() ? 'checked' : ''}> 以后不再显示</label>
      <div class="spacer"></div>
      <div class="guideDots">${GUIDE_STEPS.map((_, k) => `<span class="gdDot ${k === i ? 'on' : ''}" data-gd="${k}"></span>`).join('')}</div>
      ${i > 0 ? '<button class="btn" id="gdPrev">上一步</button>' : ''}
      ${last
        ? (aiReady ? '<button class="btn primary" id="gdStart">开始使用</button>'
                   : '<button class="btn primary" id="gdSetup">去配置模型</button><button class="btn" id="gdStart">先逛逛</button>')
        : '<button class="btn primary" id="gdNext">下一步</button>'}
    </div>
  </div>`;
  mask.querySelector('#gdClose').addEventListener('click', () => closeGuide(mask.querySelector('#gdNoShow').checked));
  const next = mask.querySelector('#gdNext');
  if (next) next.addEventListener('click', () => { state.guideStep = i + 1; drawGuide(); });
  const prev = mask.querySelector('#gdPrev');
  if (prev) prev.addEventListener('click', () => { state.guideStep = i - 1; drawGuide(); });
  const start = mask.querySelector('#gdStart');
  if (start) start.addEventListener('click', () => closeGuide(mask.querySelector('#gdNoShow').checked));
  const setup = mask.querySelector('#gdSetup');
  if (setup) setup.addEventListener('click', () => { closeGuide(true); go('#/settings'); });
  mask.querySelectorAll('[data-gd]').forEach(d => d.addEventListener('click', () => { state.guideStep = Number(d.getAttribute('data-gd')); drawGuide(); }));
  /* ---- 引导第 2 步：直接配置 AI ---- */
  const aiForm = mask.querySelector('#gdAiForm');
  if (aiForm) {
    let prov = 'openai';
    const seg = mask.querySelector('#gdProvSeg');
    const boxOpenai = mask.querySelector('#gdOpenaiBox');
    const boxOc = mask.querySelector('#gdOpencodeBox');
    const msg = mask.querySelector('#gdAiMsg');
    seg.querySelectorAll('.gdSegBtn').forEach(b => b.addEventListener('click', () => {
      seg.querySelectorAll('.gdSegBtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      prov = b.getAttribute('data-prov');
      boxOpenai.hidden = prov !== 'openai';
      boxOc.hidden = prov === 'openai';
    }));
    aiForm.querySelectorAll('[data-gdpre]').forEach(b => b.addEventListener('click', () => {
      const p = AI_PRESETS[Number(b.getAttribute('data-gdpre'))];
      mask.querySelector('#gdAiBase').value = p.base;
      mask.querySelector('#gdAiModel').value = p.model;
      if (p.key) mask.querySelector('#gdAiKey').value = p.key;
      toast('已填入「' + p.name + '」配置，接着填 API 密钥即可');
      mask.querySelector('#gdAiKey').focus();
    }));
    const saveBtn = mask.querySelector('#gdAiSave');
    saveBtn.addEventListener('click', async () => {
      const base = (mask.querySelector('#gdAiBase').value || '').trim();
      const key = (mask.querySelector('#gdAiKey').value || '').trim();
      const model1 = (mask.querySelector('#gdAiModel').value || '').trim();
      const model2 = (mask.querySelector('#gdAiModel2').value || '').trim();
      const agent = (mask.querySelector('#gdAiAgent').value || '').trim() || 'NoTools';
      if (prov === 'openai' && !base) { msg.textContent = '请先填 API 地址（或点上面的预设）'; msg.style.color = 'var(--warn)'; return; }
      if (prov === 'openai' && !model1) { msg.textContent = '请填写模型名'; msg.style.color = 'var(--warn)'; return; }
      if (prov === 'opencode' && !model2) { msg.textContent = '请填写模型名（如 opencode-go/deepseek-v4-flash）'; msg.style.color = 'var(--warn)'; return; }
      saveBtn.disabled = true; saveBtn.textContent = '测试中…'; msg.textContent = '';
      try {
        await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          ai_provider: prov, ai_base_url: base, ai_api_key: key,
          model: prov === 'openai' ? model1 : model2, ai_opencode_agent: agent
        }) });
        const t = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (t.ok) { msg.textContent = '✅ 连接正常，可以开始用了'; msg.style.color = 'var(--ok)'; toast('AI 已配置好'); }
        else { msg.textContent = '❌ ' + (t.message || '连接失败'); msg.style.color = 'var(--danger)'; }
      } catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--danger)'; }
      finally { saveBtn.disabled = false; saveBtn.textContent = '保存并测试连接'; }
    });
  }
  /* ---- 引导第 3 步：组件真实开关 ---- */
  const compList = mask.querySelector('#gdCompList');
  if (compList) {
    (async () => {
      try {
        const r = await api('/api/components');
        const base = (r.components || []).filter(c => c.scope === 'base');
        compList.innerHTML = base.map(c => `<label class="gdCompRow">
            <span class="gdCompIcon">${c.icon}</span><span class="gdCompName">${esc(c.name)}</span>
            <label class="cmpSwitch"><input type="checkbox" data-gdcomp="${esc(c.id)}" ${r.enabled[c.id] !== false ? 'checked' : ''}><span class="cmpSlider"></span></label>
          </label>`).join('');
        compList.querySelectorAll('[data-gdcomp]').forEach(inp => inp.addEventListener('change', async () => {
          const id = inp.getAttribute('data-gdcomp');
          try {
            await api('/api/components/' + encodeURIComponent(id) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: inp.checked }) });
            await loadComponents();
            toast(inp.checked ? '已开启' : '已关闭');
          } catch (e) { toast(e.message); inp.checked = !inp.checked; }
        }));
      } catch (e) { compList.innerHTML = '<span class="muted" style="font-size:12.5px;">加载失败：' + esc(e.message) + '</span>'; }
    })();
  }
  const gdBtn = mask.querySelector('#gdSyncBtn');
  if (gdBtn) gdBtn.addEventListener('click', async () => {
    const repo = (mask.querySelector('#gdSyncRepo').value || '').trim();
    const user = (mask.querySelector('#gdSyncUser').value || '').trim();
    const token = (mask.querySelector('#gdSyncToken').value || '').trim();
    const msg = mask.querySelector('#gdSyncMsg');
    if (!repo) { msg.textContent = '请先填写仓库地址'; msg.style.color = 'var(--warn)'; return; }
    gdBtn.disabled = true; gdBtn.textContent = '配置中…'; msg.textContent = '';
    try {
      await api('/api/sync/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, repo, user, token, auto_push: true, auto_pull: true, images: true }) });
      const t = await api('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!t.ok) throw new Error(t.message || '仓库无法访问');
      const r = await api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const c = r.counts || {};
      msg.textContent = '✅ 同步已开启并上传成功（' + (c.goals || 0) + ' 个目标）';
      msg.style.color = 'var(--ok)';
      toast('多端同步已开启');
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
      msg.style.color = 'var(--danger)';
    } finally {
      gdBtn.disabled = false; gdBtn.textContent = '启用同步并上传当前数据';
    }
  });
  mask.addEventListener('click', e => { if (e.target === mask) closeGuide(mask.querySelector('#gdNoShow').checked); });
}

/* ============ 组件系统（含主题皮肤） ============ */
function compOn(id) {
  if (!state.components) return true;
  return state.components[id] !== false;
}
function applyComponentStyles(styles) {
  const want = new Set(styles || []);
  // 移除不再需要的
  document.querySelectorAll('link[data-component-style]').forEach(l => {
    if (!want.has(l.getAttribute('href'))) l.remove();
  });
  // 添加新增的（放在 style.css 之后，保证覆盖生效）
  for (const href of want) {
    if (document.querySelector(`link[data-component-style][href="${href}"]`)) continue;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-component-style', '1');
    document.head.appendChild(l);
  }
}
async function loadComponents() {
  try {
    state.componentCats = await api('/api/component-categories').catch(() => ({ categories: [], used: {}, map: {} }));
    const r = await api('/api/components');
    state.components = r.enabled || {};
    state.componentList = r.components || [];
    state.componentPins = r.pins || state.componentPins || [];
    SiErXing.setServerPlugins(r.components || []);
    applyComponentStyles(r.styles || []);
  } catch (e) { console.warn('组件加载失败：' + e.message); }
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
function libSourcesOfNode(n) {
  const list = safeParse(n.sources, []);
  return Array.isArray(list) ? list : [];
}
async function renderLibraryPage() {
  app.innerHTML = '<p class="muted">加载资源库…</p>';
  if (!state.goals || !state.goals.length) { try { state.goals = (await api('/api/goals')).goals || []; } catch (e) {} }
  let g = state.goal && state.goal.nodes ? state.goal : null;
  if (!g && (state.goals || []).length) g = state.goals[0];
  if (!g) {
    app.innerHTML = `<div class="page"><div class="pageHead"><h2 class="title">📚 资源库</h2></div><div class="emptyBox" style="margin-top:30px;"><div class="ebIcon">📚</div><div class="ebTitle">还没有目标</div><div class="ebText">先建一个目标，收集信息源或上传图片资料后，这里会汇总整理好的资料。</div></div></div>`;
    return;
  }
  if (!state.goal || state.goal.id !== g.id || state.goal.nodes == null) { try { await loadGoal(g.id); } catch (e) {} g = state.goal || g; }
  const digests = state.digests || [];
  const sources = state.sources || [];
  const own = sources.filter(x => x.site === '用户提供的图片' || x.site === '导入的资料');
  const net = sources.filter(x => !(x.site === '用户提供的图片' || x.site === '导入的资料'));
  const stages = ((g.nodes || [])).filter(n => n.level === 0).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const byKind = {};
  for (const x of sources) (byKind[x.kind || '其它'] = byKind[x.kind || '其它'] || []).push(x);
  const goalOptions = (state.goals || []).map(x => `<option value="${x.id}" ${Number(x.id) === Number(g.id) ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
  const srcCard = (x, withBody) => {
    const full = String(x.content || x.snippet || '（无正文）');
    return `<details class="libSrc"><summary><span class="chip gray">${esc(x.kind || '资料')}</span> ${esc(x.title)} <span class="muted" style="font-size:11px;">· ${full.length} 字</span></summary>
      <div class="libSrcBody">${x.url ? `<div class="libSrcMeta">来源：<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.site || x.url)}</a></div>` : `<div class="libSrcMeta">来源：${esc(x.site || '—')}</div>`}
      <div class="mdBody libFullText" style="margin-top:6px;">${mdToHTML(full)}</div></div></details>`;
  };
  let h = `<div class="page">
    <div class="pageHead">
      <a class="back js-back" href="#/g/${g.id}">← 返回目标</a>
      <h2 class="title">📚 资源库</h2>
      <span class="muted" style="font-size:12.5px;">资料 ${sources.length} 条（自己提供 ${own.length} / 网络 ${net.length}）· 汇总 ${digests.length} 篇</span>
      <div class="spacer"></div>
      <select id="libGoal" class="libGoalSel">${goalOptions}</select>
      <button class="btn small" id="libDigest">🧠 ${digests.length ? '重新提炼' : '信息提炼'}</button>
      <label class="btn small">⬆ 导入资料<input type="file" id="libImport" accept=".json,application/json" hidden></label>
      <a class="btn small primary" href="/api/goals/${g.id}/library/export" download>⬇ 一键导出（Markdown）</a>
    </div>`;

  // 一、按规划归类
  h += `<div class="sec"><div class="secTitle">🗂 按规划归类</div>`;
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
    h += `<details class="libStage"><summary>${esc(st.title)} <span class="muted" style="font-size:11.5px;">· 关联资料 ${nodeSrc.length} 条${relDigests.length ? ' · 相关汇总 ' + relDigests.length + ' 篇' : ''}${relSrc.length ? ' · 相关资料 ' + relSrc.length + ' 条' : ''}</span></summary>
      <div class="libStageBody">
        ${nodeSrc.length ? `<div class="libSecT">本阶段节点自己标注的依据</div>${nodeSrc.map(x => `<div class="libRef">📎 ${esc(x.name || x.title || '')}${x.note ? `<div class="libSrcMeta">${esc(x.note)}</div>` : ''}</div>`).join('')}` : ''}
        ${relDigests.length ? `<div class="libSecT">相关提炼汇总</div>${relDigests.map(({ d }) => `<details class="libSrc"><summary>📄 ${esc(d.title || d.topic)}</summary><div class="libSrcBody mdBody">${mdToHTML(d.content || '')}</div></details>`).join('')}` : ''}
        ${relSrc.length ? `<div class="libSecT">相关资料</div>${relSrc.map(({ x }) => srcCard(x, true)).join('')}` : ''}
        ${(!nodeSrc.length && !relDigests.length && !relSrc.length) ? '<div class="muted" style="font-size:12.5px;">这个阶段暂时没有匹配到资料</div>' : ''}
      </div></details>`;
  }
  h += `</div>`;

  // 二、主题汇总（MD）
  h += `<div class="sec"><div class="secTitle">📄 主题汇总（提炼出的 MD 文件，规划优先依据）</div>`;
  h += digests.length
    ? `<div class="libDigestHead"><a class="btn tiny" href="/api/goals/${g.id}/digests/export" download>⬇ 下载全部 MD</a></div>` + digests.map(d => `<details class="libSrc"><summary>📄 ${esc(d.title || d.topic)} <span class="muted" style="font-size:11.5px;">· 依据 ${d.sources_count || 0} 条</span></summary><div class="libSrcBody mdBody">${mdToHTML(d.content || '')}</div><div class="spDigestOps"><span class="muted" style="font-size:11.5px;">${esc(fmtDate(d.created_at))}</span><div class="spacer"></div><button class="btn tiny danger" data-digest-del="${d.id}">删除</button></div></details>`).join('')
    : `<p class="hint">还没有提炼汇总：点右上「🧠 信息提炼」，AI 会通读全部资料并按主题整理成多篇 MD。</p>`;
  h += `</div>`;

  // 三、全部资料（按类型）
  h += `<div class="sec"><div class="secTitle">📚 全部资料（${sources.length} 条）</div>`;
  h += own.length ? `<div class="libSecT">你自己提供的（最高优先级）</div>${own.map(x => srcCard(x, true)).join('')}` : '';
  for (const k of Object.keys(byKind)) {
    const list = byKind[k].filter(x => !own.includes(x));
    if (!list.length) continue;
    h += `<div class="libSecT">${esc(k)}（${list.length}）</div>${list.slice(0, 60).map(x => srcCard(x, false)).join('')}`;
    if (list.length > 60) h += `<div class="muted" style="font-size:12px;">…还有 ${list.length - 60} 条（导出 Markdown 可看全部）</div>`;
  }
  h += `</div></div>`;
  app.innerHTML = h;

  const gsel = document.getElementById('libGoal');
  if (gsel) gsel.addEventListener('change', async () => { try { await loadGoal(Number(gsel.value)); } catch (e) {} renderLibraryPage(); });
  const ld = document.getElementById('libDigest');
  if (ld) ld.addEventListener('click', async () => { await startDigest(g.id); renderLibraryPage(); });
  const li = document.getElementById('libImport');
  if (li) li.addEventListener('change', async () => {
    const file = (li.files || [])[0]; li.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/api/goals/' + g.id + '/sources/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      toast('已导入 ' + r.added + ' 条资料' + (r.skipped ? '（' + r.skipped + ' 条已存在）' : ''));
      await loadGoal(g.id); renderLibraryPage();
    } catch (e) { toast(e.message); }
  });
  app.querySelectorAll('[data-digest-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这篇提炼汇总？')) return;
    try { await api('/api/digests/' + b.getAttribute('data-digest-del'), { method: 'DELETE' });
      state.digests = (state.digests || []).filter(x => String(x.id) !== String(b.getAttribute('data-digest-del')));
      toast('已删除'); renderLibraryPage();
    } catch (e) { toast(e.message); }
  }));
}

async function renderComponentsPage() {
  const scrollY = window.scrollY || 0;          // 记住滚动位置，重渲染后恢复
  app.innerHTML = '<p class="muted">加载组件…</p>';
  const [r, catsRes] = await Promise.all([
    api('/api/components'),
    api('/api/component-categories').catch(() => ({ categories: [], used: {}, map: {} }))
  ]);
  state.components = r.enabled || {};
  state.componentList = r.components || [];
  state.componentPins = r.pins || state.componentPins || [];
  state.componentCats = catsRes;                 // 分类实时刷新（新建后立即出现）
  applyComponentStyles(r.styles || []);
  const comps = r.components || [];
  const core = comps.filter(c => c.scope === 'core');
  const base = comps.filter(c => c.scope === 'base');
  const themes = comps.filter(c => c.kind === 'theme');
  const extras = comps.filter(c => c.scope !== 'core' && c.scope !== 'base' && c.kind !== 'theme');
  const sw = (c) => `<label class="cmpSwitch" title="${c.scope === 'core' ? '核心组件不可关闭' : '开启 / 关闭'}">
      <input type="checkbox" data-cmp="${esc(c.id)}" ${state.components[c.id] !== false ? 'checked' : ''} ${c.scope === 'core' ? 'disabled' : ''}>
      <span class="cmpSlider"></span>
    </label>`;
  const row = (c, extraRight) => `<div class="cmpRow ${c.scope === 'core' ? 'isCore' : ''}">
      <span class="cmpIcon">${c.icon || '✨'}</span>
      <div class="cmpMain">
        <div class="cmpName">${esc(c.name)}
          ${c.scope === 'core' ? '<span class="chip gray">核心 · 不可关闭</span>' : ''}
          ${c.kind === 'theme' ? '<span class="chip gray">主题皮肤</span>' : ''}
          ${c.builtin ? '' : '<span class="chip">第三方组件</span>'}
          ${c.version ? `<span class="cmpVer">v${esc(c.version)}</span>` : ''}
          ${c.author ? `<span class="cmpAuthor">by ${esc(c.author)}</span>` : ''}
        </div>
        <div class="cmpDesc">${esc(c.desc || '')}</div>
        <div class="cmpCatRow">
          <span class="cmpCatLabel">分类</span>
          <select class="cmpCatSel" data-comp-cat="${esc(c.id)}">
            ${(state.componentCats && state.componentCats.categories || []).concat(['其它']).map(k => `<option value="${esc(k)}" ${k === (c.category || '其它') ? 'selected' : ''}>${esc(k)}</option>`).join('')}
          </select>
        </div>
        ${c.builtin ? '' : `<div class="cmpFiles">服务端 server/plugins/${esc(c.id)}.js${c.client ? ` · 前端 public/plugins/${esc(c.id)}.js` : ''}${c.hasStyle ? ` · 样式 public/plugins/${esc(c.id)}.css` : ''}</div>`}
      </div>
      <div class="cmpOps">${extraRight || ''}
        <button class="btn tiny cmpPin" data-cmp-pin="${esc(c.id)}" title="${(state.componentPins || []).includes(c.id) ? '移出常用' : '加入常用（侧边栏置顶）'}">${(state.componentPins || []).includes(c.id) ? '★' : '☆'}</button>
        ${sw(c)}</div>
    </div>`;
  let html = `<div class="page">
    <div class="pageHead">
      <a class="back js-back" href="#/">← 返回</a>
      <h2 class="title" style="margin-left:10px;">🧩 组件</h2>
      <span class="hint" style="margin-left:10px;">功能与界面样式都由组件提供，可自由开关、导入分享</span>
      <div class="spacer"></div>
      <button class="btn small" id="cmpReload">↻ 重新加载</button>
      <label class="btn small primary">⬆ 导入组件（可多选）<input type="file" id="cmpImport" accept=".json,application/json" multiple hidden></label>
    </div>
    <div class="sec">
      <div class="secTitle">分类管理</div>
      <p class="hint" style="margin:0 0 10px;">分类用于整理组件，也可以在「新建目标」时<b>按分类批量选择</b>组件。可以新建/重命名/删除分类，并把任意组件移动到别的分类。</p>
      <div class="catList" id="catList"></div>
      <div class="consAdd" style="margin-top:10px;">
        <input type="text" id="catNewName" placeholder="新建分类，例如：学习成长 / 效率工具 / 我的收藏">
        <button class="btn small primary" id="catAddBtn">新建分类</button>
      </div>
    </div>
    <div class="sec"><div class="secTitle">核心组件</div>
      <p class="hint" style="margin:0 0 8px;">应用的基础能力，无法关闭。</p>
      ${core.map(c => row(c)).join('')}
    </div>
    <div class="sec"><div class="secTitle">基础功能组件</div>
      <p class="hint" style="margin:0 0 8px;">默认全部开启；不需要的功能可以关掉，界面入口与接口会一并隐藏。</p>
      ${base.map(c => row(c)).join('')}
    </div>
    <div class="sec"><div class="secTitle">主题与界面样式</div>
      <p class="hint" style="margin:0 0 8px;">主题组件通过覆盖设计变量换肤（同时只生效一个）；开启即立即应用，关掉则回到默认外观。</p>
      ${themes.map(c => row(c)).join('') || '<div class="muted" style="font-size:13px;">还没有主题组件</div>'}
    </div>
    <div class="sec"><div class="secTitle">扩展组件</div>
      <p class="hint" style="margin:0 0 8px;">独立文件组件，可以导出分享给别人，也可以卸载。带「按目标启用」的组件可在新建目标时勾选。</p>
      ${extras.map(c => row(c, `${c.goalToggle ? '<span class="chip gray" title="可在新建目标时勾选、也可在目标页开关">按目标启用</span>' : ''}
        ${c.builtin ? '' : `<a class="btn tiny" href="/api/components/${esc(c.id)}/export">导出</a><button class="btn tiny danger" data-cmp-del="${esc(c.id)}">卸载</button>`}`)).join('') || '<div class="muted" style="font-size:13px;">还没有扩展组件</div>'}
    </div>
    <div class="sec"><div class="secTitle">分享组件</div>
      <p class="hint" style="line-height:1.9;">
        · 导出：点组件的「导出」得到 <code>*.component.json</code> 文件（含服务端代码、前端代码与样式），发给别人即可<br>
        · 导入：点右上「导入组件」选择该文件，组件会立刻装好并可开关<br>
        · 自己写一个：把 <code>server/plugins/xxx.js</code>（声明元数据 + 接口 + 建表）和 <code>public/plugins/xxx.js</code>（界面）、<code>public/plugins/xxx.css</code>（样式）放进去即可，详见 README「插件开发」
      </p>
    </div>
  </div>`;
  app.innerHTML = html;

  /* ---- 分类管理 ---- */
  const catsInfo = state.componentCats || { categories: [], used: {} };
  const cats = (catsInfo.categories || []);
  const catListEl = document.getElementById('catList');
  if (catListEl) {
    catListEl.innerHTML = cats.length ? cats.map(c => `<span class="catItem">
        <span class="catName">${esc(c)}</span><span class="catCount">${(catsInfo.used || {})[c] || 0}</span>
        <button class="catOp" data-cat-rename="${esc(c)}" title="重命名">✎</button>
        <button class="catOp danger" data-cat-del="${esc(c)}" title="删除（组件回到原分类）">×</button>
      </span>`).join('') : '<span class="muted" style="font-size:12.5px;">还没有自定义分类（组件使用插件自带的分类）</span>';
    catListEl.querySelectorAll('[data-cat-rename]').forEach(b => b.addEventListener('click', async () => {
      const from = b.getAttribute('data-cat-rename');
      const name = prompt('重命名分类：', from);
      if (name == null || !name.trim() || name.trim() === from) return;
      try {
        await api('/api/component-categories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, name: name.trim() }) });
        toast('已重命名');
        await renderComponentsPage();
      } catch (e) { toast(e.message); }
    }));
    catListEl.querySelectorAll('[data-cat-del]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-cat-del');
      if (!confirm('删除分类「' + name + '」？该分类下的组件会回到它们原本的分类。')) return;
      try {
        await api('/api/component-categories/' + encodeURIComponent(name), { method: 'DELETE' });
        toast('已删除分类');
        await renderComponentsPage();
      } catch (e) { toast(e.message); }
    }));
  }
  const catAddBtn = document.getElementById('catAddBtn');
  if (catAddBtn) catAddBtn.addEventListener('click', async () => {
    const inp = document.getElementById('catNewName');
    const name = (inp.value || '').trim();
    if (!name) return toast('请输入分类名');
    try {
      await api('/api/component-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      toast('已新建分类「' + name + '」');
await renderComponentsPage();
        await loadComponents();
    } catch (e) { toast(e.message); }
  });
  /* 组件移动分类 */
  app.querySelectorAll('[data-comp-cat]').forEach(sel => sel.addEventListener('change', async () => {
    const id = sel.getAttribute('data-comp-cat');
    try {
      await api('/api/components/' + encodeURIComponent(id) + '/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: sel.value }) });
      toast('已移动到「' + sel.value + '」');
      await renderComponentsPage();
    } catch (e) { toast(e.message); }
  }));

  app.querySelectorAll('[data-cmp-pin]').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-cmp-pin');
    const pins = (state.componentPins || []).slice();
    const has = pins.includes(id);
    try {
      const r = await api('/api/component-pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: has ? 'remove' : 'add' }) });
      state.componentPins = r.pins || pins;
      toast(has ? '已移出常用' : '已加入常用（侧边栏置顶）');
      renderRail();
      renderComponentsPage();
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-cmp]').forEach(inp => inp.addEventListener('change', async () => {
    const id = inp.getAttribute('data-cmp');
    const enabled = inp.checked;
    try {
      const r = await api('/api/components/' + encodeURIComponent(id) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      state.components = r.enabled || state.components;
      toast(enabled ? '已开启组件' : '已关闭组件');
      await renderComponentsPage();
    } catch (e) { toast(e.message); inp.checked = !enabled; }
  }));
  app.querySelectorAll('[data-cmp-del]').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-cmp-del');
    if (!confirm('卸载组件「' + id + '」？相关文件会被删除（数据表保留）。')) return;
    try {
      await api('/api/components/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已卸载');
      await loadComponents();
      location.reload();
    } catch (e) { toast(e.message); }
  }));
  document.getElementById('cmpReload').addEventListener('click', async () => {
    try {
      const r = await api('/api/components/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('已重新加载 ' + r.loaded + ' 个文件组件');
      await loadComponents();
      location.reload();
    } catch (e) { toast(e.message); }
  });
  window.scrollTo(0, scrollY);                   // 恢复滚动位置
  document.getElementById('cmpImport').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const parsed = [];
    for (const f of files) {
      try {
        const obj = JSON.parse(await f.text());
        parsed.push({ file: f.name, bundle: obj });
      } catch (err) {
        parsed.push({ file: f.name, bundle: null, error: '不是合法 JSON' });
      }
    }
    showImportDialog(parsed);
  });
}

/* ============ 设置页（含 AI 配置引导） ============ */
/* ============ 更新检查（启动自动检测 + 一键更新） ============ */
function updSkipHash() { try { return localStorage.getItem('sierxing-update-skip') || ''; } catch (e) { return ''; } }
function updLaterUntil() { try { return Number(localStorage.getItem('sierxing-update-later') || 0); } catch (e) { return 0; } }
function fmtUpdTime(t) { return t ? String(t).replace(' +0800', '').slice(0, 16) : ''; }
function updHasUpdate() {
  const u = state.update || {};
  return !!(u.supported && u.behind > 0 && u.latestShort && u.latestShort !== updSkipHash());
}
/* 启动时检查（服务端启动后已后台检测过一次，这里取缓存，没有就补一次） */
async function checkUpdateOnBoot() {
  try {
    let u = await api('/api/update/status');
    if (!u || u.supported == null) u = await api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.update = u;
    renderRail();
    if (!updHasUpdate()) return;
    if (Date.now() < updLaterUntil()) return;         // 选过「稍后」
    renderUpdateBanner();
  } catch (e) { /* 静默：检查更新失败不打扰用户 */ }
}
function renderUpdateBanner() {
  const u = state.update || {};
  if (!updHasUpdate()) { const b = document.getElementById('updBanner'); if (b) b.remove(); return; }
  let el = document.getElementById('updBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'updBanner';
    el.className = 'updBanner';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <span class="updIcon">🚀</span>
    <div class="updText">
      <b>发现新版本</b>
      <span>落后 ${u.behind} 个提交 · 最新：${esc(u.latestSubject || '')}</span>
    </div>
    <button class="btn tiny" id="updDetails">更新内容</button>
    <button class="btn tiny primary" id="updNow">立即更新</button>
    <button class="btn tiny" id="updLater">稍后</button>
    <button class="updClose" id="updSkip" title="跳过此版本（不再提示）">×</button>
    <div class="updList" id="updList" hidden>
      ${(u.commits || []).map(c => `<div class="updItem"><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span><i>${esc(fmtUpdTime(c.date))}</i></div>`).join('') || '<div class="muted">（没有更多详情）</div>'}
      <div class="updNote">更新只会替换程序文件，你的数据（目标 / 组件设置 / 密钥）都在本地，不会丢。</div>
    </div>`;
  const list = el.querySelector('#updList');
  el.querySelector('#updDetails').addEventListener('click', () => { list.hidden = !list.hidden; });
  el.querySelector('#updNow').addEventListener('click', applyUpdate);
  el.querySelector('#updLater').addEventListener('click', () => {
    try { localStorage.setItem('sierxing-update-later', String(Date.now() + 6 * 3600 * 1000)); } catch (e) {}
    el.remove();
    toast('已改为稍后提醒（6 小时内不再弹）');
  });
  el.querySelector('#updSkip').addEventListener('click', () => {
    try { localStorage.setItem('sierxing-update-skip', u.latestShort || ''); } catch (e) {}
    el.remove();
    toast('已跳过 ' + (u.latestShort || '') + '，有新版本时还会提醒');
  });
}
function updMaskShow(text) {
  let m = document.getElementById('updMask');
  if (!m) {
    m = document.createElement('div');
    m.id = 'updMask';
    m.className = 'updMask';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="updBox"><div class="updSpin"></div><div class="updMsg">${esc(text)}</div><div class="updSub" id="updSub"></div></div>`;
  return m;
}
function updMaskSub(text) { const s = document.getElementById('updSub'); if (s) s.textContent = text; }
/* 等服务端重启完成（旧进程退出、新进程起来） */
async function waitServerBack(maxMs = 40000) {
  const t0 = Date.now();
  let down = false;
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 900));
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { if (down) return true; down = false; }
    } catch (e) { down = true; }
  }
  return false;
}
async function applyUpdate() {
  const u = state.update || {};
  if (!confirm('更新到最新版本（' + (u.latestShort || '') + '）？\n更新完会自动重启应用，页面会自动刷新。\n你的数据都在本地，不会丢失。')) return;
  const b = document.getElementById('updBanner');
  if (b) b.remove();
  updMaskShow('正在更新…');
  updMaskSub('从远端拉取最新代码');
  try {
    const r = await api('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.updated) { updMaskShow('已经是最新版本'); setTimeout(() => { const m = document.getElementById('updMask'); if (m) m.remove(); }, 1200); return; }
    updMaskSub('已更新 ' + r.before + ' → ' + r.after + '（' + r.commits + ' 个提交）' + (r.warning ? ' · ' + r.warning : ''));
    updMaskShow('更新完成，正在重启应用…');
    updMaskSub('重启后会自动刷新页面，请稍候');
    try { await api('/api/update/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
    const ok = await waitServerBack();
    if (ok) {
      location.href = location.pathname + '?_=' + Date.now() + (location.hash || '');
    } else {
      updMaskShow('已更新，但自动重启没成功');
      updMaskSub('请手动关闭后重新启动（桌面图标 / 终端命令 sierxing），再刷新本页');
    }
  } catch (e) {
    updMaskShow('更新失败');
    updMaskSub(e.message + ' · 可在项目目录手动执行 git pull');
    setTimeout(() => { const m = document.getElementById('updMask'); if (m) m.remove(); }, 8000);
  }
}
/* ---- 设置页：版本与更新 ---- */
async function updateSectionHTML() {
  let u = state.update;
  if (!u) { try { u = await api('/api/update/status'); state.update = u; } catch (e) { u = {}; } }
  const cur = u.currentShort ? `<code>${esc(u.currentShort)}</code> ${esc(fmtUpdTime(u.currentDate))}` : '（未检测）';
  const supported = u.supported !== false;
  const has = updHasUpdate();
  const status = !supported
    ? '<span style="color:var(--warn)">当前不是 git 安装，无法自动更新（可重新用 git clone 安装，数据不会丢）</span>'
    : (u.reason === 'fetch-failed'
      ? '<span style="color:var(--warn)">检查失败：' + esc(u.error || '网络或权限问题') + '</span>'
      : (has
        ? '<b style="color:var(--accent)">有 ' + u.behind + ' 个新提交</b> · 最新：' + esc(u.latestSubject || '')
        : '已是最新版本' + (u.dirty ? ' · 本地有 ' + u.dirty + ' 个改动文件（更新时会自动暂存）' : '')));
  return `<div class="sec">
      <div class="secTitle">版本与更新</div>
      <div class="svcRow">
        <span class="svcLabel">当前版本</span>
        <span class="svcVal">${cur}</span>
        <div class="spacer"></div>
        <button class="btn tiny" id="updCheck">检查更新</button>
        ${has ? '<button class="btn tiny primary" id="updApply">立即更新</button>' : ''}
      </div>
      <p class="hint" id="updStatus" style="margin-top:8px; line-height:1.8;">${status}${u.checkedAt ? ' · 上次检查：' + esc(fmtUpdTime(new Date(u.checkedAt).toISOString())) : ''}</p>
      ${(u.commits && u.commits.length) ? `<div class="updList" style="margin-top:6px;">${u.commits.map(c => `<div class="updItem"><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span><i>${esc(fmtUpdTime(c.date))}</i></div>`).join('')}</div>` : ''}
      <p class="hint" style="margin-top:8px;">· 启动时会自动检查一次；也可以随时点「检查更新」<br>· 更新只替换程序文件，本地数据（目标 / 组件设置 / 密钥）不受影响；更新后会自动重启应用</p>
    </div>`;
}
function bindUpdateSection() {
  const ck = document.getElementById('updCheck');
  if (ck) ck.addEventListener('click', async () => {
    ck.disabled = true; ck.textContent = '检查中…';
    try {
      const u = await api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.update = u;
      toast(u.supported === false ? '当前不是 git 安装，无法自动更新'
        : (u.reason === 'fetch-failed' ? '检查失败：' + (u.error || '网络或权限问题')
          : (u.behind > 0 ? '发现 ' + u.behind + ' 个新提交' : '已是最新版本')));
      renderRail();
      rerenderCurrent();
    } catch (e) { toast(e.message); }
    ck.disabled = false; ck.textContent = '检查更新';
  });
  const ap = document.getElementById('updApply');
  if (ap) ap.addEventListener('click', applyUpdate);
}

/* ============ 设置页：服务与启动 ============ */
async function serviceSectionHTML() {
  let st = {};
  try { st = await api('/api/service/status'); } catch (e) { st = {}; }
  state.serviceStatus = st;
  const a = st.autostart || {};
  return `<div class="sec">
      <div class="secTitle">服务与启动</div>
      <div class="svcRow">
        <span class="svcLabel">访问地址</span>
        <a class="svcVal" href="${esc(st.url || '#')}" target="_blank" rel="noopener">${esc(st.url || '')}</a>
        <div class="spacer"></div>
        <button class="btn tiny" id="svcOpen">在浏览器打开</button>
      </div>
      <div class="svcRow">
        <span class="svcLabel">桌面图标</span>
        <span class="svcVal">${st.desktop && st.desktop.exists ? '✅ 已创建（双击即可使用）' : '尚未创建'}</span>
        <div class="spacer"></div>
        <button class="btn tiny primary" id="svcShortcuts">${st.desktop && st.desktop.exists ? '重新创建' : '创建桌面图标'}</button>
      </div>
      <div class="svcRow">
        <span class="svcLabel">终端命令</span>
        <span class="svcVal">${st.launcher && st.launcher.exists ? '<code>sierxing</code> 已可用' : '尚未创建（点上面按钮一并创建）'}</span>
      </div>
      <div class="svcRow">
        <span class="svcLabel">开机自启</span>
        <label class="cmpSwitch" title="开启/关闭开机自启">
          <input type="checkbox" id="svcAutostart" ${a.enabled ? 'checked' : ''}>
          <span class="cmpSlider"></span>
        </label>
        <span class="svcVal" id="svcAutoText">${a.enabled ? '已开启 · ' + esc(a.mechanism || '') : '未开启'}</span>
      </div>
      <p class="hint" style="margin-top:8px; line-height:1.8;">
        · 桌面图标：双击启动并在浏览器打开（Windows 为桌面快捷方式，Linux/macOS 为桌面启动器）<br>
        · 终端命令：安装后在终端输入 <code>sierxing</code> 即可启动（Linux/macOS 在 <code>~/.local/bin</code>）<br>
        · 开机自启：${esc(a.mechanism || '按平台自动选择机制')}${a.hint ? ' · ' + esc(a.hint) : ''}<br>
        · 所有操作只写入当前用户目录，不需要管理员权限；端口 ${st.port || ''}
      </p>
    </div>`;
}
function bindServiceSection() {
  const st = state.serviceStatus || {};
  const open = document.getElementById('svcOpen');
  if (open) open.addEventListener('click', async () => {
    try { await api('/api/service/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { toast(e.message); }
  });
  const sc = document.getElementById('svcShortcuts');
  if (sc) sc.addEventListener('click', async () => {
    sc.disabled = true; sc.textContent = '创建中…';
    try {
      const r = await api('/api/service/shortcuts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const notes = (r.notes || []).join('；');
      toast((r.desktop ? '桌面图标已创建' : '未创建桌面图标') + (r.launcher ? '，终端命令 sierxing 可用' : '') + (notes ? ' · ' + notes : ''));
      renderSettings();
    } catch (e) { toast(e.message); sc.disabled = false; sc.textContent = '创建桌面图标'; }
  });
  const as = document.getElementById('svcAutostart');
  if (as) as.addEventListener('change', async () => {
    const on = as.checked;
    as.disabled = true;
    try {
      const r = await api('/api/service/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
      toast(on ? ('已开启开机自启' + (r.hint ? '（' + r.hint + '）' : '')) : '已关闭开机自启');
      renderSettings();
    } catch (e) { toast(e.message); as.checked = !on; as.disabled = false; }
  });
}

/* ============ 设置页：多端同步 ============ */
function syncSwitch(id, on, title) {
  return `<label class="cmpSwitch" title="${esc(title || '')}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="cmpSlider"></span></label>`;
}
async function syncSectionHTML() {
  let st = {};
  try { st = await api('/api/sync/status'); } catch (e) { st = {}; }
  state.syncStatus = st;
  const snap = st.snapshot;
  return `<div class="sec">
      <div class="secTitle">多端同步（Git 仓库）</div>
      <p class="hint" style="line-height:1.85;">
        把数据快照提交到<b>你自己的 Git 仓库</b>（建议私有仓库），实现多台设备同步：<b>改动后自动上传</b>、<b>启动时自动拉取</b>。<br>
        · 密钥类信息（AI API Key、同步令牌、LeetCode 登录态）<b>不会</b>被同步<br>
        · 冲突策略：以最后保存的设备为准（个人多设备场景足够用）<br>
        · 本机工作副本：<code>data/sync/</code>（已在 .gitignore 中）
      </p>
      <div class="svcRow"><span class="svcLabel">启用同步</span>${syncSwitch('syncEnabled', st.enabled, '开启后才会自动上传/拉取')}
        <span class="svcVal">${st.enabled ? '已启用' : '未启用'}</span>
        <div class="spacer"></div>
        <span class="svcVal">${st.hasGit ? '✓ 检测到 git' : '⚠ 未检测到 git 命令'}</span>
      </div>
      <div class="field"><label>仓库地址</label>
        <input id="syncRepo" value="${esc(st.repo || '')}" placeholder="https://atomgit.com/你的用户名/sierxing-data.git">
      </div>
      <div class="grid2">
        <div class="field"><label>分支</label><input id="syncBranch" value="${esc(st.branch || 'main')}" placeholder="main"></div>
        <div class="field"><label>用户名（可选）</label><input id="syncUser" value="${esc((state.settingsSyncUser) || '')}" placeholder="oauth2 或你的账号"></div>
      </div>
      <div class="field"><label>密码 / 访问令牌（私有仓库需要）</label>
        <input type="password" id="syncToken" value="${st.hasToken ? '••••••••' : ''}" placeholder="${st.hasToken ? '已保存（留空则不修改）' : '粘贴访问令牌'}">
      </div>
      <div class="svcRow"><span class="svcLabel">自动上传</span>${syncSwitch('syncAutoPush', st.autoPush, '数据变化后 20 秒自动提交并推送')}</div>
      <div class="svcRow"><span class="svcLabel">启动时拉取</span>${syncSwitch('syncAutoPull', st.autoPull, '每次打开程序时从仓库拉取最新数据')}</div>
      <div class="svcRow"><span class="svcLabel">同步图片</span>${syncSwitch('syncImages', st.images, '把上传的图片也一起同步')}</div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn primary" id="syncSave">保存并测试连接</button>
        <button class="btn" id="syncPush">⬆ 立即上传</button>
        <button class="btn" id="syncPull">⬇ 立即拉取</button>
      </div>
      <div id="syncBox" class="hint" style="margin-top:10px; line-height:1.85;">
        ${snap ? `仓库里最新快照：${esc(fmtDate(snap.savedAt))} · 来自 ${esc(snap.device || '')} · ${snap.counts && snap.counts.goals || 0} 个目标<br>` : ''}
        ${st.lastAt ? `上次同步：${esc(fmtDate(st.lastAt))} · ${esc(st.lastStatus || '')}` : '还没有同步记录'}
        ${st.cloned ? `<br>本地副本：${esc(st.commit || '')} · ${esc(st.workState || '')}` : ''}
      </div>
    </div>`;
}
function bindSyncSection() {
  const box = document.getElementById('syncBox');
  const collect = () => ({
    enabled: (document.getElementById('syncEnabled') || {}).checked,
    repo: (document.getElementById('syncRepo') || {}).value || '',
    branch: (document.getElementById('syncBranch') || {}).value || 'main',
    user: (document.getElementById('syncUser') || {}).value || '',
    token: (document.getElementById('syncToken') || {}).value || '',
    auto_push: (document.getElementById('syncAutoPush') || {}).checked,
    auto_pull: (document.getElementById('syncAutoPull') || {}).checked,
    images: (document.getElementById('syncImages') || {}).checked
  });
  const save = async () => {
    const r = await api('/api/sync/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
    state.syncStatus = r.status;
    return r.status;
  };
  const sv = document.getElementById('syncSave');
  if (sv) sv.addEventListener('click', async () => {
    sv.disabled = true; sv.textContent = '保存中…';
    try {
      await save();
      const t = await api('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (box) box.innerHTML = t.ok
        ? '✅ 已保存，仓库可访问' + (t.branches && t.branches.length ? '（分支：' + esc(t.branches.join('、')) + '）' : '（仓库还是空的，点「立即上传」创建首个快照）')
        : '❌ 已保存，但连接失败：' + esc(t.message || '');
      toast(t.ok ? '同步已保存' : '已保存，但连接失败');
      renderSettings();
    } catch (e) { toast(e.message); if (box) box.innerHTML = '❌ ' + esc(e.message); }
    finally { sv.disabled = false; sv.textContent = '保存并测试连接'; }
  });
  const sp = document.getElementById('syncPush');
  if (sp) sp.addEventListener('click', async () => {
    sp.disabled = true; sp.textContent = '上传中…';
    if (box) box.innerHTML = '正在导出并推送到仓库…';
    try {
      await save();
      const r = await api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const c = r.counts || {};
      if (box) box.innerHTML = '✅ 上传成功 · ' + (c.goals || 0) + ' 个目标 / ' + (c.nodes || 0) + ' 个节点';
      toast('已上传到同步仓库');
    } catch (e) { toast('上传失败：' + e.message); if (box) box.innerHTML = '❌ 上传失败：' + esc(e.message); }
    finally { sp.disabled = false; sp.textContent = '⬆ 立即上传'; }
  });
  const pl = document.getElementById('syncPull');
  if (pl) pl.addEventListener('click', async () => {
    pl.disabled = true; pl.textContent = '拉取中…';
    if (box) box.innerHTML = '正在从仓库拉取…';
    try {
      await save();
      const r = await api('/api/sync/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (box) box.innerHTML = r.imported
        ? '✅ 已导入来自 ' + esc(r.device || '其它设备') + ' 的数据（' + ((r.counts || {}).goals || 0) + ' 个目标），页面即将刷新…'
        : 'ℹ ' + esc(r.message || '已是最新');
      toast(r.imported ? '已导入最新数据' : (r.message || '已是最新'));
      if (r.imported) setTimeout(() => location.reload(), 1200);
    } catch (e) { toast('拉取失败：' + e.message); if (box) box.innerHTML = '❌ 拉取失败：' + esc(e.message); }
    finally { pl.disabled = false; pl.textContent = '⬇ 立即拉取'; }
  });
}

async function renderSettings() {
  app.innerHTML = '<p class="muted">加载中…</p>';
  const [modelsRes, s, st] = await Promise.all([
    api('/api/ai/models').catch(e => ({ models: [], error: e.message })),
    api('/api/settings'),
    api('/api/ai/status')
  ]);
  const models = modelsRes.models || [];
  state.models = models;
  state.aiStatus = st;
  const provider = s.ai_provider || 'openai';
  const configured = !!st.configured;
  // 识图会用哪个模型：配置了就用配置的，否则显示自动选用的（opencode 有可读图的默认值）
  const visionHint = st.visionModel
    ? '识别图片会使用：' + st.visionModel + (st.visionModelSaved ? '' : '（未单独配置，自动选用）')
    : '识别图片需要支持视觉的模型（如 qwen-vl-max / gpt-4o / glm-4v-plus）；留空则用上面的文本模型，若它不支持读图，识图会提示失败。';

  let html = `<div class="page">
    <div class="pageHead"><a class="back js-back" href="#/">← 返回</a><h2 class="title" style="margin-left:10px;">设置</h2>
      <div class="spacer"></div>
      <span class="aiBadge ${configured ? 'ok' : 'bad'}">${configured ? '✓ AI 已配置' : '未配置 AI'}</span>
    </div>`;

  if (!configured) {
    html += `<div class="setupCard">
      <h3>⚙️ 先配置 AI 接入方式（3 步）</h3>
      <p class="hint" style="margin:0;">思而行的问卷、规划、教程、对话都由 AI 完成，所以需要先接入一个模型服务。推荐任意 <b>OpenAI 兼容接口</b>（DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenAI、本地 Ollama 都行）。</p>
      <ol class="setupSteps">
        <li>选一个服务商（下面有常用预设，点一下自动填好地址与模型）</li>
        <li>填上你的 <b>API 密钥</b>（本地 Ollama 可随便填）</li>
        <li>点 <b>测试连接</b>，显示「连接正常」就能用了</li>
      </ol>
      <p class="hint" style="margin:0;">没有密钥？也可以先用 <b>本地模型</b>：装好 <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> 后选「本地 Ollama」预设，无需密钥。</p>
    </div>`;
  }

  html += `<div class="sec">
      <div class="secTitle">AI 接入方式</div>
      <div class="field">
        <select id="aiProvider">
          <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI 兼容接口（推荐，无需安装其它软件）</option>
          <option value="opencode" ${provider === 'opencode' ? 'selected' : ''}>opencode CLI（本机已安装 opencode 时可选）</option>
        </select>
      </div>
      <div id="openaiCfg" ${provider === 'opencode' ? 'hidden' : ''}>
        <div class="presetRow" id="presetRow">
          ${AI_PRESETS.map((p, i) => `<button type="button" class="presetChip" data-preset="${i}">${esc(p.name)}</button>`).join('')}
        </div>
        <div class="field"><label>API 地址（Base URL）</label><input id="aiBase" value="${esc(s.ai_base_url || '')}" placeholder="如 https://api.deepseek.com/v1"></div>
        <div class="field"><label>API 密钥</label><input id="aiKey" type="password" value="${esc(s.ai_api_key || '')}" placeholder="${s.env_keys && s.env_keys.key ? '已通过环境变量提供（留空则用环境变量）' : 'sk-...'}"></div>
        <div class="field"><label>视觉模型（可选：用于识别图片资料）</label>
          <input id="aiVisionModel" list="modelList" value="${esc(s.ai_vision_model || '')}" placeholder="如 qwen-vl-max / gpt-4o / glm-4v-plus">
        </div>
        <p class="hint" id="aiVisionHint" style="margin:-4px 0 10px;">${esc(visionHint)}</p>
        <div class="field"><label>单次请求超时（毫秒）</label><input id="aiTimeout" value="${esc(s.ai_timeout_ms || '300000')}"></div>
      </div>
      <div id="opencodeCfg" ${provider === 'openai' ? 'hidden' : ''}>
        <div class="field"><label>opencode 代理（agent）</label><input id="aiAgent" value="${esc(s.ai_opencode_agent || 'NoTools')}" placeholder="NoTools（项目自带：禁用工具、只输出文本）"></div>
        <p class="hint" style="margin-top:8px;">使用 opencode 时：模型名填 <code>provider/model</code>（如 <code>opencode-go/deepseek-v4-flash</code>）；地址与密钥留空即可（由 opencode 自己管理登录）。</p>
      </div>
      <div class="field"><label>模型（Model）*</label>
        <input id="aiModel" list="modelList" value="${esc(s.model || '')}" placeholder="如 deepseek-chat / qwen-plus / opencode-go/deepseek-v4-flash">
        <datalist id="modelList">${models.map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn primary" id="saveSettings">保存设置</button>
        <button class="btn" id="testAi">测试连接</button>
        <button class="btn" id="reloadModels">刷新模型列表</button>
      </div>
      <div id="aiStatusBox" class="hint" style="margin-top:10px; line-height:1.8;">
        当前：<b>${provider === 'openai' ? 'OpenAI 兼容接口' : 'opencode CLI'}</b>
        ${st.baseUrl ? ' · ' + esc(st.baseUrl) : ''}
        ${st.model ? ' · 模型 ' + esc(st.model) : ' · <span style="color:var(--warn)">未设置模型</span>'}
        ${provider === 'opencode' ? '' : (st.hasKey ? ' · 已配置密钥' : ' · <span style="color:var(--warn)">未配置密钥</span>')}
      </div>
      ${modelsRes.error ? `<p class="hint" style="color:var(--warn); margin-top:6px;">模型列表：${esc(modelsRes.error)}（可手动填写模型名）</p>` : ''}
    </div>
    ${await serviceSectionHTML()}
    ${await updateSectionHTML()}
    ${await syncSectionHTML()}
    <div class="sec">
      <div class="secTitle">数据安全</div>
      <div class="toolbarRow">
        <button class="btn" id="backupNow">立即备份</button>
        <a class="btn" href="/api/export/json">导出全部 JSON</a>
        <label class="btn">导入 JSON<input type="file" accept=".json" id="importJson" hidden></label>
      </div>
      <p class="hint" style="margin-top:10px;">每次改动都会自动备份到 data/backups/（保留最近 30 份）。导入会覆盖现有全部数据（导入前会自动备份）。</p>
    </div>
    <div class="sec">
      <div class="secTitle">帮助</div>
      <div class="toolbarRow">
        <button class="btn" id="showGuideBtn">📖 重新查看使用引导</button>
        <a class="btn" href="https://github.com" target="_blank" rel="noopener" style="display:none">文档</a>
      </div>
      <p class="hint" style="margin-top:8px;">引导会介绍：如何接入模型、组件是什么、一条目标的完整使用流程。</p>
    </div>
    <div class="sec">
      <div class="secTitle">关于</div>
      <p class="muted" style="font-size:13px; line-height:1.8;">思而行 · 你的目标规划助手 · 本地运行 · 零依赖<br>数据文件：data/sierxing.db，所有数据只保存在你自己的电脑上。</p>
    </div>
  </div>`;
  app.innerHTML = html;

  const pv = document.getElementById('aiProvider');
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const collect = () => ({
    ai_provider: pv.value,
    ai_base_url: val('aiBase'),
    ai_api_key: val('aiKey'),
    model: val('aiModel'),
    ai_vision_model: val('aiVisionModel'),
    ai_timeout_ms: val('aiTimeout'),
    ai_opencode_agent: val('aiAgent')
  });
  const save = async () => {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
    state.aiStatus = await api('/api/ai/status').catch(() => null);
  };
  const toggleProvider = () => {
    document.getElementById('openaiCfg').hidden = pv.value !== 'openai';
    document.getElementById('opencodeCfg').hidden = pv.value === 'openai';
  };
  pv.addEventListener('change', async () => { toggleProvider(); try { await save(); toast('已保存接入方式'); } catch (e) { toast(e.message); } });
  document.getElementById('presetRow').addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = AI_PRESETS[Number(b.getAttribute('data-preset'))];
    document.getElementById('aiBase').value = p.base;
    document.getElementById('aiModel').value = p.model;
    document.getElementById('aiVisionModel').value = p.vision || '';
    if (p.key) document.getElementById('aiKey').value = p.key;
    toast('已填入「' + p.name + '」配置，接着填 API 密钥即可');
    document.getElementById('aiKey').focus();
  });
  document.getElementById('saveSettings').addEventListener('click', async () => {
    try { await save(); toast('已保存'); renderSettings(); } catch (e) { toast(e.message); }
  });
  document.getElementById('testAi').addEventListener('click', async e => {
    const btn = e.target;
    const box = document.getElementById('aiStatusBox');
    btn.disabled = true; btn.textContent = '测试中…';
    box.innerHTML = '正在保存配置并测试连接…';
    try {
      await save();  // 先保存再测试，避免"改了没存"导致误报
      const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) {
        box.innerHTML = `✅ <b>连接正常</b> · ${esc(r.provider === 'openai' ? 'OpenAI 兼容接口' : 'opencode CLI')} · 模型 ${esc(r.model)}<br>模型回复：${esc(r.sample || '')}`;
        toast('连接正常');
      } else {
        box.innerHTML = `❌ <b>连接失败</b>：${esc(r.message || '未知错误')}<br><span class="hint">检查：API 地址是否以 /v1 结尾 · 密钥是否正确 · 模型名是否存在 · 网络/代理是否可用</span>`;
        toast('连接失败，见下方说明');
      }
    } catch (err) {
      box.innerHTML = '❌ 连接失败：' + esc(err.message);
    } finally { btn.disabled = false; btn.textContent = '测试连接'; }
  });
  document.getElementById('reloadModels').addEventListener('click', async () => {
    try { await save(); } catch (e) {}
    renderSettings();
  });
  bindServiceSection();
  bindUpdateSection();
  bindSyncSection();
  const sgb = document.getElementById('showGuideBtn');
  if (sgb) sgb.addEventListener('click', () => showGuide(0));
  document.getElementById('backupNow').addEventListener('click', async () => {
    try { const r = await api('/api/backup', { method: 'POST' }); toast('已备份，共 ' + r.count + ' 份'); } catch (e) { toast(e.message); }
  });
  document.getElementById('importJson').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!confirm('导入会覆盖现有全部目标与路径（会先自动备份）。继续？')) { e.target.value = ''; return; }
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/api/import/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      toast('已导入 ' + r.goals + ' 个目标');
      setTimeout(() => { location.hash = '#/'; location.reload(); }, 600);
    } catch (err) { toast('导入失败：' + err.message); }
    e.target.value = '';
  });
}
function disabledComponentsHTML() {
  if (!state.componentList || !state.components) return '';
  const off = (state.componentList || []).filter(c => c.scope === 'base' && state.components[c.id] === false);
  if (!off.length) return '';
  return `<div class="offBar">
    <span>⚠ 已关闭的组件：${off.map(c => c.icon + ' ' + esc(c.name)).join(' · ')}</span>
    <div class="spacer"></div>
    <a class="btn tiny" href="#/components">去开启</a>
  </div>`;
}
function showImportDialog(parsed) {
  const cats = ((state.componentCats || {}).categories) || [];
  const installed = new Set(((state.componentList || []).filter(c => !c.builtin)).map(c => c.id));
  const items = parsed.map(p => {
    const b = p.bundle;
    const okFmt = b && b.format === 'sierxing-component' && b.id && typeof b.server === 'string' && b.server.includes('module.exports');
    const id = b ? String(b.id || '') : '';
    const exists = id && installed.has(id);
    return { file: p.file, bundle: b, id, name: (b && b.name) || id || p.file, version: (b && b.version) || '', author: (b && b.author) || '', autoCat: (b && b.category) || '其它', error: p.error || (okFmt ? '' : '不是有效的组件文件'), replaced: !!exists };
  });
  const valid = items.filter(x => !x.error);
  const old = document.getElementById('importDialog');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'importDialog';
  div.className = 'tutDialog';
  div.innerHTML = `<div class="tdHead"><span>📦</span><span>导入组件（选中 ${items.length} 个）</span><button class="btn tiny" id="impX">×</button></div>
    <div class="tdBody">
      <div class="impList">
        ${items.map(x => `<div class="impItem ${x.error ? 'bad' : ''}">
          <span class="chip ${x.error ? 'danger' : (x.replaced ? 'warn' : 'ok')}">${x.error ? '无法导入' : (x.replaced ? '覆盖' : '新装')}</span>
          <b>${esc(x.name)}</b>
          <span class="muted">${esc(x.id || x.file)}${x.version ? ' · v' + esc(x.version) : ''}${x.author ? ' · ' + esc(x.author) : ''}</span>
          ${x.error ? `<span class="impErr">${esc(x.error)}</span>` : ''}
        </div>`).join('')}
      </div>
      ${valid.length ? `<div class="field" style="margin-top:12px;"><label>导入到分类（可统一归类，也可用组件自带分类）</label>
        <select id="impCat">
          <option value="__auto__">使用组件自带分类（${esc(Array.from(new Set(valid.map(v => v.autoCat))).join(' / '))}）</option>
          ${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          <option value="__new__">＋ 新建分类…</option>
        </select>
        <input type="text" id="impNewCat" placeholder="新分类名称，例如：效率工具" style="margin-top:8px; display:none;">
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn primary" id="impOk">导入 ${valid.length} 个组件</button>
        <button class="btn" id="impCancel">取消</button>
      </div>` : `<div class="toolbarRow" style="margin-top:12px;"><button class="btn" id="impCancel">关闭</button></div>`}
      <p class="hint" style="margin-top:10px;">组件包含可执行代码（服务端会加载、前端会注入页面），请只导入你信任来源的组件。</p>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#impX').addEventListener('click', close);
  const cancel = div.querySelector('#impCancel');
  if (cancel) cancel.addEventListener('click', close);
  const sel = div.querySelector('#impCat');
  if (sel) sel.addEventListener('change', () => {
    const inp = div.querySelector('#impNewCat');
    if (inp) { inp.style.display = sel.value === '__new__' ? '' : 'none'; if (sel.value === '__new__') inp.focus(); }
  });
  const okBtn = div.querySelector('#impOk');
  if (okBtn) okBtn.addEventListener('click', async () => {
    let category = sel ? sel.value : '__auto__';
    if (category === '__new__') {
      const inp = div.querySelector('#impNewCat');
      const name = (inp.value || '').trim();
      if (!name) return toast('请填写新分类名称');
      category = name;
    }
    okBtn.disabled = true; okBtn.textContent = '导入中…';
    try {
      const r = await api('/api/components/install-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundles: valid.map(v => v.bundle), category }) });
      const fails = (r.results || []).filter(x => !x.ok);
      toast('已导入 ' + r.okCount + ' 个组件' + (r.category ? '（分类：' + r.category + '）' : '') + (fails.length ? '；失败 ' + fails.length + ' 个' : ''));
      close();
      await loadComponents();
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast('导入失败：' + err.message);
      okBtn.disabled = false; okBtn.textContent = '重试导入';
    }
  });
}
function setupCardHTML() {
  const st = state.aiStatus || {};
  if (st.configured) return '';
  return `<div class="setupCard">
    <h3>⚙️ 还差一步：配置 AI 接入方式</h3>
    <p class="hint" style="margin:0 0 4px;">问卷、规划、教程、对话都需要 AI。推荐使用任意 OpenAI 兼容接口（DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI…），也可以接本地 Ollama。</p>
    <ol class="setupSteps">
      <li>进入设置，选一个服务商（有常用预设，点一下自动填好）</li>
      <li>填上 API 密钥（本地模型可随便填）</li>
      <li>点「测试连接」看到「连接正常」即可</li>
    </ol>
    <a class="btn primary" href="#/settings">去配置 AI →</a>
  </div>`;
}
async function ensureAIConfigured() {
  try { state.aiStatus = await api('/api/ai/status'); } catch (e) { return true; }
  if (state.aiStatus && state.aiStatus.configured) return true;
  toast('请先配置 AI 接入方式');
  go('#/settings');
  return false;
}

/* ============ 插件宿主 ============ */
let BOOTED = false;
function pluginButtonsHTML(goal) {
  if (!window.SiErXing) return '';
  return SiErXing.goalEntries(goal)
    .filter(e => e.header !== false)
    .map(e => `<button class="btn" data-plugin-go="${esc(e.hash(goal.id))}">${e.icon} ${esc(e.label)}</button>`).join('');
}
function pluginPickerHTML() {
  const list = (window.SiErXing ? SiErXing.serverPlugins() : []).filter(p => p.goalToggle);
  if (!list.length) return '';
  const catCount = {};
  for (const p of list) { const k = p.category || '其它'; catCount[k] = (catCount[k] || 0) + 1; }
  const cats = ['全部', ...Array.from(new Set(list.map(p => p.category || '其它')))];
  return `<div class="field">
    <label>额外功能组件<span class="ppHint">　可随时在目标页或「组件」页开关；组件会越来越多，这里支持搜索与分类筛选</span></label>
    <div class="ppWrap" data-pp>
      <div class="ppBar">
        <input class="ppSearch" id="ppSearch" placeholder="🔍 搜索组件…" autocomplete="off">
        <div class="ppCats">${cats.map((c, i) => `<button type="button" class="ppCat ${i === 0 ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}<span class="ppCatN">${c === '全部' ? list.length : (catCount[c] || 0)}</span></button>`).join('')}</div>
        <div class="spacer"></div>
        <span class="ppCount" id="ppCount"></span>
        <button type="button" class="btn tiny" id="ppAllFiltered">全选当前结果</button>
        <button type="button" class="btn tiny primary" id="ppAllCat" title="把当前分类下的组件全部勾选（批量选择）">批量选择本类</button>
        <button type="button" class="btn tiny" id="ppClear">清空</button>
      </div>
      <div class="ppGrid" id="ppGrid">
        ${list.map(p => `<label class="ppChip" data-id="${esc(p.id)}" data-cat="${esc(p.category || '其它')}"
            data-key="${esc((p.name + ' ' + (p.desc || '') + ' ' + (p.category || '')).toLowerCase())}"
            data-desc="${esc(p.desc || '')}" title="${esc(p.desc || '')}">
          <input type="checkbox" data-plugin-check="${esc(p.id)}" ${p.defaultEnabled ? 'checked' : ''}>
          <span class="ppcIcon">${p.icon}</span>
          <span class="ppcName">${esc(p.name)}</span>
          <span class="ppcTick">✓</span>
        </label>`).join('')}
      </div>
      <div class="ppTip" id="ppTip">把鼠标移到组件上可以看到说明；没有需要的？去左侧栏「🧩 组件」页导入或自己写一个。</div>
    </div>
  </div>`;
}
function bindPluginPicker() {
  const wrap = document.querySelector('[data-pp]');
  if (!wrap) return;
  const grid = document.getElementById('ppGrid');
  const chips = Array.from(grid.querySelectorAll('.ppChip'));
  const countEl = document.getElementById('ppCount');
  const tipEl = document.getElementById('ppTip');
  const search = document.getElementById('ppSearch');
  const syncCount = () => {
    const n = chips.filter(c => c.querySelector('input').checked).length;
    countEl.textContent = n ? '已选 ' + n + ' 个' : '未选择额外组件';
  };
  const paint = () => {
    chips.forEach(c => c.classList.toggle('on', c.querySelector('input').checked));
    syncCount();
  };
  const applyFilter = () => {
    const kw = (search.value || '').trim().toLowerCase();
    const catBtn = wrap.querySelector('.ppCat.active');
    const cat = catBtn ? catBtn.getAttribute('data-cat') : '全部';
    let shown = 0;
    chips.forEach(c => {
      const okKw = !kw || (c.getAttribute('data-key') || '').includes(kw);
      const okCat = cat === '全部' || c.getAttribute('data-cat') === cat;
      const show = okKw && okCat;
      c.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    if (tipEl) tipEl.textContent = shown ? (kw || cat !== '全部' ? '筛选出 ' + shown + ' 个组件' : '把鼠标移到组件上可以看到说明') : '没有匹配的组件';
    const acb = document.getElementById('ppAllCat');
    if (acb) acb.textContent = cat === '全部' ? '批量选择本类' : '批量选择「' + cat + '」';
  };
  chips.forEach(c => {
    const inp = c.querySelector('input');
    inp.addEventListener('change', paint);
    c.addEventListener('mouseenter', () => { const d = c.getAttribute('data-desc'); if (d && tipEl) tipEl.textContent = c.querySelector('.ppcName').textContent + '：' + d; });
    c.addEventListener('mouseleave', () => applyFilter());
  });
  if (search) search.addEventListener('input', applyFilter);
  wrap.querySelectorAll('.ppCat').forEach(b => b.addEventListener('click', () => {
    wrap.querySelectorAll('.ppCat').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    applyFilter();
  }));
  const allBtn = document.getElementById('ppAllFiltered');
  if (allBtn) allBtn.addEventListener('click', () => {
    chips.forEach(c => { if (c.style.display !== 'none') c.querySelector('input').checked = true; });
    paint();
  });
  const allCatBtn = document.getElementById('ppAllCat');
  if (allCatBtn) allCatBtn.addEventListener('click', () => {
    const catBtn = wrap.querySelector('.ppCat.active');
    const cat = catBtn ? catBtn.getAttribute('data-cat') : '全部';
    let n = 0;
    chips.forEach(c => {
      if (cat === '全部' || c.getAttribute('data-cat') === cat) { c.querySelector('input').checked = true; n++; }
    });
    paint();
    toast('已批量选择「' + cat + '」下的 ' + n + ' 个组件');
  });
  const clearBtn = document.getElementById('ppClear');
  if (clearBtn) clearBtn.addEventListener('click', () => { chips.forEach(c => c.querySelector('input').checked = false); paint(); });
  paint();
  applyFilter();
}
/* ============ 左栏：可展开的组件模块（分组 + 常用置顶 + 拖拽/右键） ============ */
const RAIL_LOGO_SVG = `<svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true">
  <defs>
    <linearGradient id="railLogoBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6d5df6"/><stop offset="0.55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="railLogoGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#railLogoBg)"/>
  <rect width="64" height="34" rx="16" fill="url(#railLogoGloss)"/>
  <text x="32" y="43" text-anchor="middle" font-size="34" font-weight="700"
        font-family="Songti SC,Noto Serif SC,Source Han Serif SC,STSong,SimSun,Georgia,serif" fill="#ffffff">思</text>
  <path d="M21 51h22" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;
function railExpanded() {
  if (state.railExpanded == null) {
    try { state.railExpanded = localStorage.getItem('sierxing-rail-comps') === '1'; } catch (e) { state.railExpanded = false; }
  }
  return !!state.railExpanded;
}
function setRailExpanded(v) {
  state.railExpanded = !!v;
  try { localStorage.setItem('sierxing-rail-comps', v ? '1' : '0'); } catch (e) {}
  renderRail();
}
function railCompItemHTML(e, pinned, active) {
  return `<a class="railCompItem ${active ? 'active' : ''} ${pinned ? 'pinned' : ''}" href="${e.hash}" draggable="true"
      data-rail-comp="${esc(e.id)}" data-cat="${esc(e.category || '其它')}" title="${esc(e.label)}${pinned ? '（常用）' : ''}">
      <span class="rciIcon">${e.icon}</span>
      <span class="rciName">${esc(e.label)}</span>
      ${pinned ? '<span class="rciPin">⭐</span>' : ''}
    </a>`;
}
function railCompsHTML() {
  const r = parseRoute();
  const g = state.goal;
  // 左栏只放「扩展组件」：内置基础功能组件（问卷/约束/图片资料…）的入口在目标页里，不在这里重复
  const metaOf = id => (SiErXing.serverPlugins() || []).find(x => x.id === id) || {};
  const entries = ((window.SiErXing && g) ? SiErXing.goalEntries(g) : [])
    .filter(e => { const m = metaOf(e.id); return !(m.builtin && m.scope === 'base'); });
  if (!entries.length) {
    return `<button class="railItem railCompToggle" id="railCompToggle" title="本目标还没有扩展组件">
        <span class="railIcon">📦</span><span class="railLabel">组件</span>
      </button>`;
  }
  const pins = (state.componentPins || []).filter(id => entries.some(e => e.id === id));
  const groups = {};
  for (const e of entries) {
    if (pins.includes(e.id)) continue;
    const k = e.category || '其它';
    (groups[k] = groups[k] || []).push(e);
  }
  const isActive = e => r.view === 'plugin' && r.pluginId === e.id;
  let h = `<button class="railItem railCompToggle ${railExpanded() ? 'open' : ''}" id="railCompToggle" title="展开/收起组件列表">
      <span class="railIcon">📦</span><span class="railLabel">组件</span>
      <span class="railCaret">${railExpanded() ? '▾' : '▸'}</span>
    </button>`;
  if (railExpanded()) {
    h += `<div class="railComps" id="railComps">`;
    h += `<div class="railGroup" data-drop-group="pins">
        <div class="railGroupHead">⭐ 常用 <span class="rgHint">（拖到这里置顶）</span></div>
        <div class="railGroupBody" data-group="pins">
          ${pins.length ? pins.map(id => entries.find(e => e.id === id)).filter(Boolean).map(e => railCompItemHTML(e, true, isActive(e))).join('') : '<div class="railEmpty">把常用组件拖进来，或右键「加入常用」</div>'}
        </div>
      </div>`;
    if (!pins.length && !Object.keys(groups).length) h += '<div class="railEmpty">本目标还没有扩展组件</div>';
    for (const k of Object.keys(groups)) {
      h += `<div class="railGroup">
          <div class="railGroupHead">${esc(k)}</div>
          <div class="railGroupBody" data-group="${esc(k)}">${groups[k].map(e => railCompItemHTML(e, false, isActive(e))).join('')}</div>
        </div>`;
    }
    h += `</div>`;
  }
  return h;
}
function railItemsHTML() {
  const r = parseRoute();
  const g = state.goal;
  const themeIcon = currentThemeEff() === 'dark' ? '☀️' : '🌙';
  let items = [{ icon: '🏠', label: '目标', hash: '#/', active: r.view === 'home' }];
  if (g && (r.view === 'goal' || r.view === 'map' || r.view === 'plugin')) {
    items.push({ icon: '🗺', label: '路线图', hash: '#/g/' + g.id, active: r.view === 'goal' });
  }
  const hasUpd = !!(state.update && state.update.supported && state.update.behind > 0 && state.update.latestShort !== updSkipHash());
  items.push({ icon: '⚙', label: '设置', hash: '#/settings', active: r.view === 'settings', dot: hasUpd });
  items.push({ icon: '📚', label: '资源库', hash: '#/library', active: r.view === 'library' });
  items.push({ icon: '🧩', label: '组件管理', hash: '#/components', active: r.view === 'components' });
  const compsHTML = railCompsHTML();
  return `<a class="railLogo" href="#/" title="思而行 · 返回目标列表">${RAIL_LOGO_SVG}</a>
    <div class="railNav">
      ${items.slice(0, g && (r.view === 'goal' || r.view === 'map' || r.view === 'plugin') ? 2 : 1).map(i => `<a class="railItem ${i.active ? 'active' : ''}" href="${i.hash}" title="${esc(i.label)}${i.dot ? ' · 有新版本' : ''}">
        <span class="railIcon">${i.icon}${i.dot ? '<i class="railDot"></i>' : ''}</span><span class="railLabel">${esc(i.label)}</span></a>`).join('')}
      ${compsHTML}
      ${items.slice(g && (r.view === 'goal' || r.view === 'map' || r.view === 'plugin') ? 2 : 1).map(i => `<a class="railItem ${i.active ? 'active' : ''}" href="${i.hash}" title="${esc(i.label)}${i.dot ? ' · 有新版本' : ''}">
        <span class="railIcon">${i.icon}${i.dot ? '<i class="railDot"></i>' : ''}</span><span class="railLabel">${esc(i.label)}</span></a>`).join('')}
    </div>
    <div class="railBottom">
      <button class="railItem" id="railTheme" title="切换白天 / 黑夜模式">
        <span class="railIcon">${themeIcon}</span><span class="railLabel">主题</span>
      </button>
    </div>`;
}
/* ---- 常用组件：拖拽 / 右键 ---- */
async function savePins(list) {
  state.componentPins = list;
  renderRail();
  try {
    const r = await api('/api/component-pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: list }) });
    state.componentPins = r.pins || list;
    renderRail();
  } catch (e) { toast(e.message); }
}
function bindRailComps() {
  const tg = document.getElementById('railCompToggle');
  if (tg) tg.addEventListener('click', () => setRailExpanded(!railExpanded()));
  const box = document.getElementById('railComps');
  if (!box) return;
  // 右键菜单
  box.querySelectorAll('[data-rail-comp]').forEach(el => el.addEventListener('contextmenu', e => {
    e.preventDefault();
    const id = el.getAttribute('data-rail-comp');
    const pinned = (state.componentPins || []).includes(id);
    const label = (SiErXing.goalEntries(state.goal).find(x => x.id === id) || {}).label || id;
    document.querySelectorAll('.ctxMenu').forEach(x => x.remove());
    const m = document.createElement('div');
    m.id = 'ctxMenu';
    m.className = 'ctxMenu railCtx';
    m.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
    m.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px';
    m.innerHTML = `
      <div class="ctxTitle">${esc(label)}</div>
      <button data-act="open">打开</button>
      <button data-act="pin">${pinned ? '⭐ 移出常用' : '⭐ 加入常用（置顶）'}</button>
      ${pinned ? '<button data-act="pinTop">⬆ 移到常用最前</button>' : ''}`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('[data-act="open"]').addEventListener('click', () => { close(); go(el.getAttribute('href')); });
    m.querySelector('[data-act="pin"]').addEventListener('click', () => {
      close();
      const pins = (state.componentPins || []).slice();
      savePins(pinned ? pins.filter(x => x !== id) : pins.concat([id]));
    });
    const pt = m.querySelector('[data-act="pinTop"]');
    if (pt) pt.addEventListener('click', () => { close(); savePins([id].concat((state.componentPins || []).filter(x => x !== id))); });
  }));
  // 拖拽
  let dragId = '';
  box.querySelectorAll('[data-rail-comp]').forEach(el => {
    el.addEventListener('dragstart', e => {
      dragId = el.getAttribute('data-rail-comp');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => { dragId = ''; el.classList.remove('dragging'); box.querySelectorAll('.dropOn').forEach(x => x.classList.remove('dropOn')); });
    // 拖到某个已置顶项上 → 插到它前面（排序）
    el.addEventListener('dragover', e => {
      const targetPinned = el.classList.contains('pinned');
      if (!targetPinned || !dragId || dragId === el.getAttribute('data-rail-comp')) return;
      e.preventDefault();
      el.classList.add('dropOn');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dropOn'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('dropOn');
      const id = dragId || e.dataTransfer.getData('text/plain');
      const target = el.getAttribute('data-rail-comp');
      if (!id || !el.classList.contains('pinned') || id === target) return;
      const pins = (state.componentPins || []).filter(x => x !== id);
      pins.splice(Math.max(0, pins.indexOf(target)), 0, id);
      savePins(pins);
    });
  });
  // 拖到「常用」分组空白处 → 追加
  const pinsBody = box.querySelector('[data-group="pins"]');
  if (pinsBody) {
    pinsBody.addEventListener('dragover', e => { if (dragId) { e.preventDefault(); pinsBody.classList.add('dropOn'); } });
    pinsBody.addEventListener('dragleave', () => pinsBody.classList.remove('dropOn'));
    pinsBody.addEventListener('drop', e => {
      e.preventDefault();
      pinsBody.classList.remove('dropOn');
      const id = dragId || e.dataTransfer.getData('text/plain');
      if (!id) return;
      const pins = (state.componentPins || []).slice();
      if (!pins.includes(id)) pins.push(id);
      savePins(pins);
      toast('已加入常用（置顶）');
    });
  }
}

function renderRail() {
  let el = document.getElementById('rail');
  const r = parseRoute();
  const show = r.view !== 'map';
  if (!el) {
    el = document.createElement('nav');
    el.id = 'rail';
    el.className = 'rail';
    document.body.appendChild(el);
  }
  el.style.display = '';
  el.innerHTML = railItemsHTML();
  const th = document.getElementById('railTheme');
  if (th) th.addEventListener('click', toggleTheme);
  bindRailComps();
  const wide = railExpanded() && !!(state.goal && SiErXing.goalEntries(state.goal).length);
  el.classList.toggle('wide', wide);
  document.body.classList.toggle('railWide', wide);
  document.body.classList.add('hasRail');
}
async function loadFrontendPlugins() {
  try {
    const r = await api('/api/plugins');
    if (!(SiErXing.serverPlugins() || []).length) SiErXing.setServerPlugins(r.plugins || []);
    const list = (r.plugins || []).filter(p => p.client);
    await Promise.all(list.map(p => new Promise(resolve => {
      if (SiErXing.findPlugin(p.id)) return resolve();
      const s = document.createElement('script');
      s.src = p.client;
      s.onload = () => resolve();
      s.onerror = () => { console.warn('[plugin] 脚本加载失败:', p.client); resolve(); };
      document.head.appendChild(s);
    })));
  } catch (e) {
    console.warn('插件加载失败：' + e.message);
  }
}
function ensureGoal() {
  if (state.goal) return Promise.resolve(state.goal);
  return api('/api/goals').then(r => {
    if (r.goals && r.goals.length) state.goal = r.goals[0];
    return state.goal;
  }).catch(() => null);
}
function pluginGoButtonsBind() {
  document.querySelectorAll('[data-plugin-go]').forEach(b => b.addEventListener('click', () => go(b.getAttribute('data-plugin-go'))));
}

/* ============ 启动 ============ */
(async function boot() {
  SiErXing.provide({
    app, api, esc, toast, go, state, mdToHTML, fmtDate, safeParse, parseRoute,
    rerender: rerenderCurrent, loadGoal, ensureGoal, aiToggle,
    mount: () => { if (BOOTED) pluginGoButtonsBind(); },
    ready: false
  });
  await loadComponents();
  try { state.aiStatus = await api('/api/ai/status'); } catch (e) { state.aiStatus = {}; }
  await loadFrontendPlugins();
  SiErXing.provide({
    app, api, esc, toast, go, state, mdToHTML, fmtDate, safeParse, parseRoute,
    rerender: rerenderCurrent, loadGoal, ensureGoal, aiToggle,
    mount: () => { if (BOOTED) { route(); } },
    ready: true
  });
  BOOTED = true;
  route();
  taskStart();
  checkUpdateOnBoot();
  if (!guideDone()) {
    setTimeout(() => { if (!document.getElementById('guideMask')) showGuide(0); }, 500);
  }
})().catch(err => {
  console.error('启动失败：', err);
  try {
    const box = document.getElementById('app');
    if (box) box.innerHTML = '<div class="page"><div class="emptyBox" style="margin-top:40px;">'
      + '<div class="ebIcon">⚠️</div><div class="ebTitle">界面启动失败</div>'
      + '<div class="ebText">' + String((err && err.message) || err) + '<br>请按 Ctrl+Shift+R 强制刷新；若仍失败，请把此信息反馈给作者。</div></div></div>';
  } catch (e) {}
});
