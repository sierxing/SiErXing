/* 思而行 · 前端逻辑（原生 JS，零依赖） */

const app = document.getElementById('app');
/* ⚠️ 就地编辑单块的状态必须声明在**文件最前面**：第 82 行有个"教程页尽早渲染"的
   模块级调用（deep-link 到 #/t/<id> 时先画一遍），它会走到 renderTutorialPage →
   mdInlineActive()。声明放在后面的定义块里就是 TDZ，报了
   "Cannot access 'mdInlineSt' before initialization"（被那行的 try 吞掉，
   表现为"教程页第一次渲染静默失败"）。跟 AI_MODES 是同一类坑。 */
let mdInlineSt = null;                         // 同一时刻只允许一块在就地编辑（详见 mdInlineOpen）
/* 服务商预设：选一个就自动填好官方 Base URL，用户不用手打地址。
   模型列表不在这里写死 —— 填完地址与密钥后向该服务的 /models 现取，
   取不到时服务端会退回各服务商的常用模型（见 server/ai.js 的 PROVIDERS）。
   这里只保留「引导页快速填一份」的最小集合。 */
const AI_PRESETS = [
  { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-flash', vision: '' },
  { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: 'qwen-vl-max' },
  { name: 'Kimi', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3', vision: '' },
  { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', vision: 'glm-4.6v' },
  { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3.2', vision: '' },
  { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', vision: 'gpt-4o' },
  { name: '本地 Ollama', base: 'http://localhost:11434/v1', model: 'qwen3:8b', vision: '', key: 'ollama' }
];
/* ⚠️ 必须放在**文件顶部**：initAI() 在启动时就会调用 aiEnsureDOM()，
   把 const 放到文件后半会让它处于 TDZ，页面报
   "Cannot access AI_MODES before initialization"，整个 AI 助手打不开。 */
/* 执行模式表。**加新模式只往这里加一条** —— 按钮文案、菜单项、说明都由它生成，
   不用再改 HTML（顶栏那种两格开关放不下第三个模式）。 */
const AI_MODES = [
  { id: 'ask', icon: '💬', label: 'ASK', short: '只提问',
    desc: '只回答，不改动。AI 不会修改路线图 / 教程 / 资料库里的任何东西。' },
  { id: 'agent', icon: '⚙️', label: 'Agent', short: '能动手',
    desc: '先判断你的意图：只是提问就直接回答，需要改路线图 / 改教程时才动手。' }
];


const state = { goals: [], goal: null, sources: [], planning: false, collecting: false, collectStatus: '', expanded: {}, filter: '', models: [], model: '', showNew: false, showEdit: false, mapScale: 1, mapTx: 40, mapTy: 40, _drag: null, _suppressClick: false };

/* ============ 主题（白天/黑夜 + 亮暗各自的皮肤） ============ */
function currentThemeEff() {
  const t = localStorage.getItem('sierxing-theme') || 'auto';
  if (t !== 'auto') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
/* 亮 / 暗模式可以各指定一个主题组件（「设置 → 外观主题」里选）。
   主题是显示偏好：只存本机 localStorage（sierxing-theme-map），不做多端同步 ——
   不同设备屏幕不同，硬同步过去反而别扭。 */
function themeMap() {
  try { return JSON.parse(localStorage.getItem('sierxing-theme-map') || '{}') || {}; } catch (e) { return {}; }
}
function themeFor(mode) { const m = themeMap(); return String((mode === 'dark' ? m.dark : m.light) || ''); }
function setThemeFor(mode, id) {
  const m = themeMap();
  if (id) m[mode] = String(id); else delete m[mode];
  try { localStorage.setItem('sierxing-theme-map', JSON.stringify(m)); } catch (e) {}
  applyThemeStyles();
}
/* 按当前（亮/暗）模式挂对应的主题皮肤 CSS；另一模式的皮肤卸载掉，
   避免两套变量同时生效互相打架。 */
function applyThemeStyles() {
  try {
    const id = themeFor(currentThemeEff());
    const want = id ? assetUrl('/plugins/' + id + '.css') : '';
    document.querySelectorAll('link[data-theme-style]').forEach(l => { if (l.getAttribute('href') !== want) l.remove(); });
    if (want && !document.querySelector('link[data-theme-style][href="' + want + '"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = want;
      l.setAttribute('data-theme-style', '1');
      document.head.appendChild(l);
    }
  } catch (e) { console.warn('主题样式加载失败：' + e.message); }
}
function applyTheme() {
  const t = localStorage.getItem('sierxing-theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeBtn') || document.getElementById('railTheme');
  if (btn) btn.textContent = currentThemeEff() === 'dark' ? '☀️' : '🌙';
  applyThemeStyles();
}
function toggleTheme() {
  localStorage.setItem('sierxing-theme', currentThemeEff() === 'dark' ? 'light' : 'dark');
  applyTheme();
}
/* 系统深浅色变化时（auto 档）跟着换皮肤 */
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((localStorage.getItem('sierxing-theme') || 'auto') === 'auto') applyTheme(); }); } catch (e) {}
/* 教程页跟随主题：切换后重新渲染 */
try { const rr0 = parseRoute(); if (rr0.view === 'tutorial') renderTutorialPage(rr0.id); } catch (e) {}
applyTheme();

/* 单段文本的行内 Markdown（**粗体** / `代码` / 链接 / *斜体*）→ HTML（先转义，安全） */
function mdOneLine(text) {
  return mdInline(mdEscape(String(text == null ? '' : text)));
}

/* ===== 内联线性图标（UI 精细化层）=====
   统一 16px、1.6 描边、round 端点，颜色继承 currentColor。
   取代原来拿 emoji 当图标的做法（emoji 在不同平台字号/配色的观感不一致，
   而且无法跟着文字颜色走）。用法：sxi('folder') 或 sxi('folder', 18)。 */
const SXI_PATHS = {
  folder:  '<path d="M2.5 5.5h4l1.6 2h8.4v9.5H2.5z"/>',
  doc:     '<path d="M4 2.5h6.5L13 5v12.5H4z"/><path d="M10.2 2.6V5H13"/>',
  layers:  '<path d="M8 2.5 13.5 6 8 9.5 2.5 6z"/><path d="M2.5 10 8 13.5 13.5 10"/>',
  search:  '<circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.4 10.4 3.1 3.1"/>',
  spark:   '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"/><path d="M4.8 4.8 6.6 6.6M9.4 9.4l1.8 1.8M11.2 4.8 9.4 6.6M6.6 9.4l-1.8 1.8"/>',
  down:    '<path d="M8 3v9.5M4.6 8.8 8 12.2l3.4-3.4M3.5 15h9"/>',
  up:      '<path d="M8 13V3.5M4.6 7.2 8 3.8l3.4 3.4M3.5 15h9"/>',
  check:   '<path d="m3 8.4 3.2 3.2L13 4.8"/>',
  book:    '<path d="M3 4.2h4.2A1.8 1.8 0 0 1 9 6v8a2 2 0 0 0-1.8-1.2H3z"/><path d="M13 4.2H8.8A1.8 1.8 0 0 0 7 6v8a2 2 0 0 1 1.8-1.2H13z"/>',
  target:  '<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.9"/>',
  pin:     '<path d="M8 13.5s4.6-4.4 4.6-7.4A4.6 4.6 0 0 0 3.4 6.1c0 3 4.6 7.4 4.6 7.4z"/><circle cx="8" cy="6" r="1.6"/>',
  link:    '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.9.3l2.1-2.1a2.6 2.6 0 1 0-3.7-3.7l-.7.7"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.9-.3L3.4 8.4a2.6 2.6 0 1 0 3.7 3.7l.7-.7"/>',
  trash:   '<path d="M3.5 5h9M6.4 5V3.6h3.2V5M4.6 5l.5 9h5.8l.5-9"/>',
  play:    '<path d="M6 4.2 12 8l-6 3.8z"/>',
  clock:   '<circle cx="8" cy="8" r="5.2"/><path d="M8 5.2V8l2.2 1.4"/>',
  plus:    '<path d="M8 3.5v9M3.5 8h9"/>',
  grid:    '<path d="M3.2 3.2h3.8v3.8H3.2zM8.9 3.2h3.8v3.8H8.9zM3.2 8.9h3.8v3.8H3.2zM8.9 8.9h3.8v3.8H8.9z"/>'
};
function sxi(name, size) {
  const d = SXI_PATHS[name] || SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
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
  if (h.startsWith('#/aitasks')) return { view: 'aitasks' };
  const vm = h.match(/^#\/g\/(\d+)\/versions$/);
  if (vm) return { view: 'versions', id: Number(vm[1]) };
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
/* ============ 页面返回栈：回到上一个页面 + 当时的滚动位置 ============ */
const NavHist = { stack: [], lastHash: '', fromBack: false, pendingScroll: null };
function navCurHash() { return location.hash || '#/'; }
/* 每次进入 route() 调用：记下从哪来、离开时看到哪；返回导航则取出待恢复的滚动 */
function navTrack() {
  const to = navCurHash();
  const from = NavHist.lastHash;
  if (!NavHist.fromBack && from && from !== to) {
    const top = NavHist.stack[NavHist.stack.length - 1];
    if (top && top.hash === from) top.scroll = window.scrollY || 0;
    else NavHist.stack.push({ hash: from, scroll: window.scrollY || 0 });
    NavHist.stack.push({ hash: to, scroll: 0 });
    if (NavHist.stack.length > 60) NavHist.stack.splice(0, NavHist.stack.length - 60);
  } else if (!from) {
    NavHist.stack.push({ hash: to, scroll: 0 });
  }
  NavHist.lastHash = to;
  const ps = NavHist.pendingScroll;
  NavHist.fromBack = false;
  NavHist.pendingScroll = null;
  return ps;
}
/* 返回按钮统一入口：回到上一个页面（fallback 给深链接直达时用） */
function goBack(fallback) {
  const cur = navCurHash();
  let idx = -1;
  for (let i = NavHist.stack.length - 1; i >= 0; i--) {
    if (NavHist.stack[i].hash === cur) { idx = i; break; }
  }
  const prev = idx > 0 ? NavHist.stack[idx - 1] : null;
  if (!prev) {
    if (fallback) location.hash = fallback;
    else if (window.history.length > 1) window.history.back();
    return;
  }
  NavHist.fromBack = true;
  NavHist.pendingScroll = prev.scroll || 0;
  location.hash = prev.hash;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-back]');
  if (!b) return;
  e.preventDefault();
  goBack(b.getAttribute('data-back'));
});
/* “⋯ 更多”溢出菜单（顶栏按钮再多也不挤）：打开时定位到按钮下方，点选项直达/转发，点别处关闭 */
/* pt：可选的鼠标位置 {x,y}，右键菜单用它定位（否则按 anchor 元素定位）。
   注意 anchor 可能是 hidden 元素，getBoundingClientRect() 全为 0，菜单会跑到页面左上角——
   所以先判零宽高，再退回到 pt / 视口中心。 */
function openMoreMenu(anchor, items, pt) {
  document.querySelectorAll('.moreMenu').forEach(x => x.remove());
  const m = document.createElement('div');
  m.className = 'ctxMenu moreMenu';
  const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
  const usable = r && (r.width || r.height) && (r.left || r.top);
  let x = pt && typeof pt.x === 'number' ? pt.x : (usable ? r.left : Math.round(window.innerWidth / 2));
  let y = pt && typeof pt.y === 'number' ? pt.y : (usable ? r.bottom + 6 : Math.round(window.innerHeight / 3));
  m.style.width = '250px';
  // 先量高度再夹位置，避免菜单超出下边缘
  m.style.left = '0px';
  m.style.top = '0px';
  m.style.visibility = 'hidden';
  m.innerHTML = items.map((it, i) => it.href
    ? `<a class="moreLink" href="${esc(it.href)}"><span>${esc(it.icon || '')}</span> ${esc(it.label)}</a>`
    : it.cmd
    ? `<button data-cmd="${esc(it.cmd)}"><span>${esc(it.icon || '')}</span> ${esc(it.label)}</button>`
    : `<button data-fw="${esc(it.target)}"><span>${esc(it.icon || '')}</span> ${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const mw = m.offsetWidth || 250, mh = m.offsetHeight || 120;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  m.style.visibility = '';
  m.querySelectorAll('a.moreLink').forEach(a => a.addEventListener('click', () => m.remove()));
  m.querySelectorAll('[data-fw]').forEach(x => x.addEventListener('click', () => {
    const t = document.getElementById(x.getAttribute('data-fw'));
    m.remove();
    if (t) t.click();
  }));
  return m;
}
document.addEventListener('click', e => {
  if (e.target.closest && e.target.closest('.moreMenu')) return;
  // 豁免所有"点开式"按钮：组件入口的 ⋯，以及各条收藏栏自己的 ⋯（data-morebtn-of）
  if (e.target.closest && (e.target.closest('[data-morebtn]') || e.target.closest('[data-morebtn-of]'))) return;
  document.querySelectorAll('.moreMenu').forEach(x => x.remove());
});
/* 目标页 ⋯ 按钮：展开溢出的组件入口 */
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-morebtn]');
  if (!t) return;
  const wasOpen = !!document.querySelector('.moreMenu');
  document.querySelectorAll('.moreMenu').forEach(x => x.remove());
  if (wasOpen) return;
  if (t.getAttribute('data-morebtn') !== 'morePlugins') return;
  const gid = Number(t.getAttribute('data-gid'));
  const g = (state.goal && state.goal.id === gid) ? state.goal : null;
  if (!g) return;
  const { overflow } = pluginEntriesVisible(g);
  if (!overflow.length) return;
  openMoreMenu(t, overflow.map(x => ({ icon: x.icon, label: x.label, href: x.hash(g.id) })));
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
  /* .tutDialog 豁免：教程对话框和文件夹关联对话框都挂在 body 下（不在 .nodePanel 里），
     不豁免的话点对话框里的输入框会把底下的节点面板一起关掉 */
  if (e.target.closest('.nodePanel') || e.target.closest('.tutDialog') || e.target.closest('.ctxMenu') || e.target.closest('[data-detail]') || e.target.closest('[data-cycle]') || e.target.closest('#nextOpen')) return;
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
  if (!e.target.closest('.ctxMenu')) {
    /* 必须豁免所有"点开式"按钮（[data-morebtn] 组件入口 ⋯ 与各条收藏栏的 ⋯）。
       少豁免一个，它点开的菜单就会在同一个 click 里被这句收掉 ——
       表现为「菜单闪一下就没了」，点开式按钮看起来像坏的。 */
    if (e.target.closest && (e.target.closest('[data-morebtn]') || e.target.closest('[data-morebtn-of]'))) return;
    document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  }
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
  try { aiTasksStopPoll(); } catch (e) {}    // 离开 AI 任务页就停轮询
  document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  // 教程目录大纲只属于教程页：切到别的页面时移除（含滚动监听，避免残留）
  const oldToc = document.getElementById('tutToc');
  if (oldToc) oldToc.remove();
  const oldTocTab = document.getElementById('tutTocTab');
  if (oldTocTab) oldTocTab.remove();
  if (window.TutBookmark) { try { window.TutBookmark.unmount(); } catch (e) {} }
  if (window.NodeNotes) { try { window.NodeNotes.unmount(); } catch (e) {} }
  if (window.TutNotes) { try { window.TutNotes.unmount(); } catch (e) {} }
  // 监听挂在"正文所在的那个 window"上：Markdown 是主窗口，HTML 教程是 iframe 内的窗口。
  // 只摘主窗口的话，iframe 里那个监听会残留，离开后再回来会对着旧 DOM 反复跑。
  try {
    const tw = window.__tutTocWin || window;
    if (tw && tw.__tutTocScroll) { tw.removeEventListener('scroll', tw.__tutTocScroll); tw.__tutTocScroll = null; }
    if (window.__tutTocScroll) { window.removeEventListener('scroll', window.__tutTocScroll); window.__tutTocScroll = null; }
    window.__tutTocWin = null;
  } catch (e) {}
  // 换页要把"上次位置"的锁重置，否则新教程进来时不会重新读取它的书签
  try { window.__tutTocTid = null; window.__tutTocRestoring = false; } catch (e) {}
  const r = parseRoute();
  try { tutProgressFlush(); } catch (e) {}   // 离开教程页先把阅读位置记上（DOM 替换前）
  const backScroll = navTrack();   // 先记滚动（此时还是旧页面），返回导航则带回待恢复位置
  document.body.classList.toggle('mapMode', r.view === 'map');
  try {
    aiEnsureDOM();
    const hasGoalCtx = (r.view === 'goal' || r.view === 'map');
    const fab = document.getElementById('aiFab');
    const drw = document.getElementById('aiDrawer');
    if (!hasGoalCtx && r.view !== 'tutorial') {
      if (fab) fab.classList.add('hidden');
      if (drw) drw.classList.remove('open');
    }
    if (r.view === 'tutorial') { if (fab) fab.classList.remove('hidden'); }   // 教程页保留 AI 助手入口
    if (r.view === 'home') { setHeader(r); await renderHome(); }
    else if (r.view === 'settings') { setHeader(r); state.settingsTab = ''; await renderSettings(); }
    else if (r.view === 'guide') { setHeader(r); await renderHome(); showGuide(r.step - 1); }
    else if (r.view === 'components') { setHeader(r); await renderComponentsPage(); }
    else if (r.view === 'versions') { await loadGoal(r.id); setHeader(r); await renderVersionsPage(r.id); }
    else if (r.view === 'library') { setHeader(r); await renderLibraryPage(); }
    else if (r.view === 'aitasks') { setHeader(r); await renderAiTasksPage(); }
    else if (r.view === 'map') { await loadGoal(r.id); setHeader(r); renderMapPage(); }
    else if (r.view === 'diff') { await loadGoal(r.id); setHeader(r); await renderDiffPage(r.vid); }
    else if (r.view === 'tutorial') { setHeader(r); await renderTutorialPage(r.id); await aiBindGoal(state.tutGoalId); try { tutViewInit(); } catch (e) {} }
    else if (r.view === 'chat') { await loadGoal(r.id); setHeader(r); renderGoal(); }

    else if (r.view === 'plugin') { setHeader(r); await r.route.render(r.match, window.SiErXing); }
    else { await loadGoal(r.id); setHeader(r); if (!state.components) await loadComponents(); renderGoal(); }
    try { sxiSelify(document); } catch (e) {}   // 页面里所有 select.sxi-sel 统一换成自画下拉
    renderRail();
    if (r.view === 'goal' || r.view === 'map') {
      await aiBindGoal(r.id);
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
    if (backScroll != null) {
      // 返回导航：渲染完回到离开时的位置（内容可能是异步图片，补一次）
      requestAnimationFrame(() => { try { window.scrollTo(0, backScroll); } catch (e) {} });
      setTimeout(() => { try { window.scrollTo(0, backScroll); } catch (e) {} }, 150);
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
    ${setupCardHTML()}`;
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
        <div class="gcHead"><span class="gcTitle">${esc(g.title)}</span><span class="chip ${st[1]}">${st[0]}</span><button class="btn tiny gcComps" data-gc-comps="${g.id}" title="管理本目标的组件（只改这个目标）">🧩</button></div>
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
  // 主页各目标卡片：🧩 只管自己这个目标的组件
  app.querySelectorAll('[data-gc-comps]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); e.preventDefault();
    const gid = Number(b.getAttribute('data-gc-comps'));
    if (document.getElementById('goalPluginMenu')) document.querySelectorAll('#goalPluginMenu').forEach(x => x.remove());
    else showGoalPluginsMenu(gid, b);
  }));

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
  citeCacheUpdate(id);   // 正文里 [id] 引用解释用（目标页/对话页）
}
function buildTree(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = {};
  for (const n of list) byId[n.id] = { ...n, sourcesArr: safeParse(n.sources, []), children: [] };
  const roots = [];
  for (const n of list) {
    const x = byId[n.id];
    if (x.parent_id && byId[x.parent_id]) byId[x.parent_id].children.push(x);
    else roots.push(x);
  }
  /* ⚠️ 必须显式按 sort_order 排序。曾经直接遍历 Object.values(byId) 组装，
     而节点 id 是数字键 —— JS 对象对数字键按数值升序枚举，等于永远按 id
     排序、把 sort_order 整个丢掉：AI 对话里显示「移动」了节点、服务端也
     确实改了 sort_order，界面顺序却纹丝不动（看起来像没生效）。
     id 只用来给同序号的节点兜底。 */
  const byOrder = (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0));
  roots.sort(byOrder);
  for (const n of list) byId[n.id].children.sort(byOrder);
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
  const sst = ST_LABEL[g.status] ? g.status : 'todo';
  return `<div class="mtitem" data-id="${g.id}">
    <div class="mtnode mtsub ${sst} ${open ? 'open' : ''}" data-node-id="${g.id}" data-detail="${g.id}" title="点击查看详情 · 右键打开菜单">
      <span class="arrow" data-childtoggle="${key}" title="${open ? '收起' : '展开'}子节点">${open ? '▾' : '▸'}</span>
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
  const sst = ST_LABEL[st.status] ? st.status : 'todo';
  return `<div class="mtitem" data-id="${st.id}">
    <div class="mtnode mtstage ${sst} ${open ? 'open' : ''}" data-node-id="${st.id}" data-detail="${st.id}" title="点击查看详情 · 右键打开菜单">
      <span class="arrow" data-childtoggle="${key}" title="${open ? '收起' : '展开'}子节点">${open ? '▾' : '▸'}</span>
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
  const mp = document.getElementById('mapPlanBtn');
  if (mp) mp.addEventListener('click', () => {
    const g = state.goal;
    if ((g.nodes || []).length && !confirm('重新规划会清空现有路径（含任务进度）后从头生成。\n\n只想微调阶段/小目标？用下面的「调整规划骨架」，不用推倒重来。\n\n确定要全部推倒重来吗？')) return;
    startClarify(g.id);
  });
  bindPlanPanel();
  bindReportCard();
  bindTutorialCard();
}
function renderMapPage() {
  const g = state.goal;
  if (!g) { app.innerHTML = '<p class="muted">目标不存在</p>'; return; }
  const stages = buildTree(g.nodes);
  const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
  if (!stages.length) {
    app.innerHTML = `<div class="mapPage"><div class="mapToolbar"><button class="back" data-back="#/g/${g.id}">← 返回</button><span class="mapTitle">${esc(g.title)}</span></div>
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
      <button class="back" data-back="#/g/${g.id}">← 返回执行页</button>
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
      ${goalCompOn(state.goal, 'chat') ? '<button class="btn small" id="mapChatBtn">💬 AI 助手</button>' : ''}
      ${goalCompOn(state.goal, 'versions') ? '<button class="btn small" id="mapVerBtn">📜 版本对比</button>' : ''}
      <button class="btn small" id="mapPlanBtn" title="重新规划（会清空现有路径，请三思；微调骨架用下面的调整面板）">🧭 重新规划</button>
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
/* 把一段「怎么做」的文字拆成分步：优先按换行，其次按句号/分号。
   用户看一整段 80 字的话会直接跳过，拆成 3-4 条才看得进去。 */
function splitSteps(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  let parts = t.split(/\n+/).map(x => x.trim()).filter(Boolean);
  if (parts.length === 1) parts = t.split(/[。；;]/).map(x => x.trim()).filter(x => x.length >= 4);
  return parts.map(x => x.replace(/^[0-9]+[.、)]\s*/, '').trim()).filter(Boolean).slice(0, 8);
}
/* 模型写 detail 时，习惯把"为什么"用【】标记写在最前面：
     【为什么需要】server.js 是思而行唯一入口……
     【对找实习的作用】面试讲「0-1 做一个 Agent 应用」时这段就是架构开场……
     【是否必要】必要——加 rag 插件必须先懂启动与注册流程……
     【怎么做】读 server/server.js 与 server/data-dir.js，顺 7 步走……
   但面板只按"换行就当一个步骤"切，于是**这些理由全被当成"怎么做"的步骤显示**，
   "为什么有这一步"反而是空的 —— 用户的原话是"说不清楚为什么要存在，
   执行的时候心里很不安"。事实是模型写了，只是被摆错了位置。
   这里按【】里的关键词把它们摘出来分类：理由归"为什么"，做法归"怎么做"。
   ⚠️ 这是纯展示层归类，**不动数据库、不改存量数据**，所以对已有节点立刻生效。 */
const WHY_MARK = /^\s*【\s*(为什么[^】]*|理由|原因|背景|价值|作用|目的|必要性|是否必要|对[^】]{0,14}的作用|对[^】]{0,14}的价值|依据[^】]*)\s*】/;
const HOW_MARK = /^\s*【\s*(怎么做|做法|步骤|如何做|执行|操作|怎么学)\s*】/;
/* ⚠️ 模型常把多个标记写在**同一行**里：
     【为什么】……。【对找实习的作用】……。【是否必要】……
   只在行首找标记（第一版就是这么写的）会漏掉后面那几个 ——
   实测漏掉后它们仍留在"怎么做"的步骤里，用户看到的还是"说不清为什么"。
   所以按【…】的位置**切开**再逐段归类，而不是一行一段。 */
function splitDetailRationale(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return { why: [], how: [] };
  const why = [], how = [];
  // 按 "【标记】正文" 的边界切段；段内正文一直延伸到下一个标记或字符串末尾
  const re = /【([^】]{1,20})】/g;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ mark: m[0], start: m.index, end: m.index + m[0].length });
  if (!marks.length) return { why: [], how: splitPlain(t) };

  if (marks[0].start > 0) {                       // 标记之前的前言
    const pre = t.slice(0, marks[0].start).trim();
    if (pre) how.push(...splitPlain(pre));
  }
  for (let i = 0; i < marks.length; i++) {
    const body = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : t.length).trim();
    if (!body) continue;
    if (WHY_MARK.test(marks[i].mark)) why.push(...splitPlain(body));
    else if (HOW_MARK.test(marks[i].mark)) how.push(...splitPlain(body));
    else why.push(...splitPlain(body));           // 【其它标记】默认算理由（模型多用于解释用途）
  }
  return { why: why.slice(0, 6), how: how.slice(0, 8) };
}
/* 段内再按句号/分号切，避免一整段挤成一条 */
function splitPlain(txt) {
  const t = String(txt || '').trim();
  if (!t) return [];
  let parts = t.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 90) { out.push(p); continue; }
    out.push(...p.split(/[；;]/).map(x => x.trim()).filter(x => x.length >= 4));
  }
  return out;
}
function showNodePanel(id, rerender) {
  const rerenderFn = rerender || renderGoal;
  const n = state.goal.nodes.find(x => x.id === id);
  if (!n) return;
  const srcs = safeParse(n.sources, []);
  state.__npSrcs = srcs;   // 依据卡片的「正文」按钮按 index 回取（面板每次重绘）
  state.__npNodeId = id;   // 「查看全部依据」弹窗按节点 id 取完整清单
  const tuts = tutorialsOfNode(id);   // 修复：原来漏了这行，节点面板一打开就报 tuts is not defined
  const old = document.getElementById('nodePanel');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'nodePanel';
  div.className = 'nodePanel';
  div.setAttribute('data-node', String(id));
  try { if (localStorage.getItem('sierxing-node-full') === '1') div.classList.add('full'); } catch (e) {}
  // 不再使用灰色遮罩（点击空白处仍会关闭面板）
  /* 节点卡片：先让人一眼看懂「这是什么 / 怎么算做完 / 为什么有这一步 / 怎么做」，
     其余（依据、文件夹、汇总、教程、调整）收进折叠区。
     以前是 11 块平铺堆着，"为什么有这个任务"压根没显示，只能自己猜。 */
  const P = (state.goal.nodes || []).find(x => Number(x.id) === Number(n.parent_id)) || null;
  const GP = P ? ((state.goal.nodes || []).find(x => Number(x.id) === Number(P.parent_id)) || null) : null;
  const sibs = (state.goal.nodes || []).filter(x => Number(x.parent_id) === Number(n.parent_id) && Number(x.level) === Number(n.level))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.id - b.id));
  const pos = sibs.findIndex(x => Number(x.id) === Number(n.id)) + 1;
  const scope = GP || P;                       // 这一支属于哪个阶段（任务→小目标→阶段）
  /* 「为什么有这一步」= 用户点开最想知道的东西。
     ⚠️ 原来是"它是这一级里的第 N/M 步 + 它属于「父标题」" —— 全是**结构位置**，
     没有一句回答"凭什么做它"。用户的原话：「说不清楚为什么要存在，
     执行的时候心里很不安，完全不知为什么」。
     现在改成：**依据（哪条要求导致它存在）排最前**，结构位置降成一行元信息。 */
  const whyLines = [];
  const evid = srcs.map(x => String(x.note || '').trim()).filter(Boolean);
  const scopeD = scope && scope.detail ? String(scope.detail).replace(/\s+/g, ' ').trim() : '';
  if (pos && sibs.length > 1) whyLines.push('在第 ' + pos + '/' + sibs.length + ' 步' + (P ? '（' + P.title + '）' : ''));
  else if (P) whyLines.push('属于「' + P.title + '」');
  /* 把 detail 拆成"理由"和"做法"两半（见 splitDetailRationale 的说明） */
  const rd = splitDetailRationale(n.detail);
  const whyFromDetail = rd.why;
  /* ⚠️ 兜底不要回退成整段 detail：那样【为什么】那几行会被再当成步骤显示一遍
     （实测节点只有【为什么】没有【怎么做】时，"怎么做"里又原样出现同一段理由）。
     有理由可摘时就不再兜底，宁可不显示步骤，也不重复。 */
  const steps = rd.how.length ? splitSteps(rd.how.join('\n'))
    : (whyFromDetail.length ? [] : splitSteps(n.detail));
  /* 「这一支要达成的是」以前硬截 140 字 + "…"，用户看不到后半段（线上反馈）。
     现在整段放进 DOM，靠 CSS 折 2 行；确实超出才显示「展开」。 */
  requestAnimationFrame(() => {
    div.querySelectorAll('[data-clamp]').forEach(el => {
      const tg = el.parentNode.querySelector('[data-clamp-tg]');
      if (tg && el.scrollHeight > el.clientHeight + 2) tg.hidden = false;
    });
  });
  div.innerHTML = `
    <div class="npHead">
      <span class="chip">${LEVEL_NAME[n.level] || ''}</span>
      <span class="npTitle">${esc(n.title)}</span>
      <button class="btn tiny" id="npFull" title="全屏 / 退出全屏">${(() => { try { return localStorage.getItem('sierxing-node-full') === '1' ? '⛶ 退出全屏' : '⛶ 全屏'; } catch (e) { return '⛶ 全屏'; } })()}</button>
      <button class="btn tiny" id="npClose">×</button>
    </div>

    ${whyLines.length ? '' : ''}${(pos || P || scope) ? `<div class="npWhere">${esc([LEVEL_NAME[n.level] || '', P && P.title ? '属于「' + P.title + '」' : '', (pos && sibs.length > 1) ? '第 ' + pos + '/' + sibs.length + ' 步' : '', n.hours ? '预计 ' + n.hours : ''].filter(Boolean).join(' · '))}</div>` : ''}

    <div class="npTop">
      <div class="npStatus">
        ${['todo', 'doing', 'done'].map(x => `<button class="btn small ${n.status === x ? 'primary' : ''}" data-np-status="${x}">${ST_LABEL[x][0]}</button>`).join('')}
      </div>
    </div>

    ${(n.acceptance || n.artifact) ? `<div class="npDone">
      <div class="npDoneHd">✅ 做完的标志</div>
      ${n.acceptance ? `<div class="npDoneAcc">${rewriteCites(esc(n.acceptance))}</div>` : ''}
      ${n.artifact ? `<div class="npDoneArt"><span>产出物</span>${rewriteCites(esc(n.artifact))}</div>` : ''}
    </div>` : ''}

    ${(evid.length || whyLines.length || scopeD) ? `<div class="npWhy">
      <div class="npWhyHd">💡 为什么有这一步</div>
      ${whyFromDetail.length ? `<div class="npWhySelf">
        ${whyFromDetail.map(x => `<div class="npWhySelfLine">${rewriteCites(esc(x))}</div>`).join('')}
      </div>` : ''}
      ${!whyFromDetail.length ? `<div class="npWhyLine npWhyMiss">
        这个节点还没有写"为什么" —— 点下面的「让 AI 改」让它补上（会说清这个任务对你目标的作用）。
      </div>` : ''}
      ${srcs.length ? `<div class="npWhyCite">依据 ${srcs.length} 条资料${srcs.length ? '（来源列在下面的「依据信息源」里）' : ''}</div>` : ''}
      ${scopeD ? `<div class="npWhyLine"><span class="npWhyK">这一支要达成的是</span><span class="npWhyClamp" data-clamp="1">${rewriteCites(esc(scopeD))}</span><button class="npWhyTg" data-clamp-tg="1" hidden>展开</button></div>` : ''}
      ${whyLines.map(x => '<div class="npWhyLine">' + esc(x) + '</div>').join('')}
    </div>` : ''}

    ${steps.length ? `<div class="npHow">
      <div class="npWhyHd">🔧 怎么做</div>
      ${steps.length > 1
        ? '<ol class="npSteps">' + steps.map(x => '<li>' + rewriteCites(esc(x)) + '</li>').join('') + '</ol>'
        : '<p class="npHowP">' + esc(steps[0]) + '</p>'}
    </div>` : ''}

    <div class="npFold">
      <details class="npFD">
        <summary>${sxi('link',14)} 依据信息源<span class="npFDNum">${srcs.length}</span>${srcs.length ? '' : '<span class="npFDHint">未标注</span>'}</summary>
        ${(() => {
          /* 依据列表要能装下很多条还不把面板撑爆。
             原来是**一条一行**平铺（100 条就是 100 行）。
             分两层：前 3 条完整卡（批注才是"为什么"，必须看得见），
             其余收成紧凑 chips（一行放好几个，可展开、可点开看批注）。
             点 chip 把它的批注显示在下面一行 —— 不弹窗、不跳页，就地看。 */
          if (!srcs.length) return '<div class="npSrcList"><div class="muted" style="font-size:12.5px;">未标注资料（本节点只依据提炼汇总与资料索引）</div></div>';
          const items = srcs.map((x, i) => {
            const lib = findLibSource(x);
            const body = lib ? String(lib.content || lib.snippet || '') : '';
            const isStar = !!(lib && Number(lib.quality) === 1);
            return { x, i, body, isStar, name: String(x.name || x.title || '').trim() || '（未命名来源）', note: String(x.note || '').trim() };
          });
          const HEAD = 3;
          /* 每张卡：一行头（类型标签 + 名字 + 优质 + 操作），批注在下面。
             类型标签从来源名/站点里认出来，让用户一眼分类。 */
          const head = items.slice(0, HEAD).map(o => `<div class="npSrc ${o.isStar ? 'isStar' : ''}">
              <div class="npSrcHd">
                ${o.isStar ? sxi('check', 14) : sxi('link', 14)}
                <span class="npSrcName" title="${esc(o.name)}">${esc(o.name)}</span>
                <span class="npSrcKind">${esc(srcKind(o))}</span>
                ${o.isStar ? '<span class="npSrcStar">优质</span>' : ''}
                <div class="npSrcOps">
                  ${o.body ? `<button class="btn tiny" data-npsrc-body="${o.i}" title="展开 / 收起资料正文">正文 ${o.body.length}</button>` : ''}
                  <button class="btn tiny danger npsrcDel" data-npsrc-del="${o.i}" title="移除这条依据">×</button>
                </div>
              </div>
              ${o.note ? `<div class="npSrcNote">${esc(o.note)}</div>` : ''}
              <div class="npSrcBodyBox" hidden></div>
            </div>`).join('');
          /* 其余依据不再"就地展开成 chips"（chips 和上面的卡片长得完全不一样，
             用户说"展开后看不到类似的依据卡片"）。
             改成：一个按钮 → **弹窗里用同一套卡片列全部依据**，视觉一致、也不挤压面板。 */
          const more = items.length > HEAD
            ? `<button class="btn small" id="npSrcAll">查看全部 ${items.length} 条依据</button>`
            : '';
          return `<div class="npSrcList">${head}${more}</div>`;
        })()}
        <div class="npSrcAdd">
          <select id="npSrcPick">${(state.sources || []).map(x => `<option value="${x.id}">${esc('[' + x.kind + '] ' + String(x.title).slice(0, 40))}</option>`).join('')}</select>
          <button class="btn tiny" id="npSrcAdd">${sxi('plus',14)}关联资料库</button>
          <button class="btn tiny" id="npSrcNew">${sxi('plus',14)}手动写一条</button>
        </div>
      </details>

      <details class="npFD">
        <summary>${sxi('folder',14)} 关联文件夹<span class="npFDHint">挂在哪一级，哪一级和它的子节点可见</span></summary>
        <div id="npFolders"><span class="muted" style="font-size:12.5px;">加载中…</span></div>
        <div class="npSrcAdd"><button class="btn tiny" id="npFolderAdd">＋ 关联文件夹</button></div>
      </details>

      ${(() => {
        const txt = (n.title || '') + ' ' + (n.detail || '');
        const rel = (state.digests || []).map(d => ({ d, score: kwScore(txt, (d.title || '') + ' ' + String(d.content || '').slice(0, 1500)) }))
          .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
        return rel.length ? `<details class="npFD"><summary>${sxi('doc',14)}相关提炼汇总<span class="npFDNum">${rel.length}</span></summary>` + rel.map(({ d }) => `<details class="npSrcBody"><summary>${esc(d.title || d.topic)}</summary><div class="mdBody">${mdToHTML(d.content || '')}</div></details>`).join('') + '</details>' : '';
      })()}

      <details class="npFD"${tuts.length ? '' : ' open'}>
        <summary>${sxi('book',14)} 学习教程<span class="npFDNum">${tuts.length}</span>${tuts.length ? '' : '<span class="npFDHint">还没有教程</span>'}</summary>
        <div class="npTut">
          ${tuts.length ? tuts.map(t => `<div class="npTutRow"><a class="npTutItem" href="#/t/${t.id}"><span class="npTutName">${esc(t.title)}</span><span class="chip gray">${t.format === 'html' ? 'HTML' : 'MD'}</span></a><button class="btn tiny danger" data-tut-del="${t.id}" title="删除这份教程">×</button></div>`).join('') : ''}
          <button class="btn small primary" id="npTutBtn" style="margin-top:8px;">${sxi('book')}生成完整教程</button>
          ${(goalCompOn(goalCtx(), 'tutbookmark') && window.TutBookmark) ? window.TutBookmark.nodeImportHTML() : ''}
        </div>
      </details>

      <details class="npFD">
        <summary>${sxi('spark',14)} 对当前划分有意见？让 AI 改</summary>
        <div class="npAdjust">
          <textarea id="npFeedback" placeholder="例如：划分太粗了，再拆细一点 / 跳过「X」（我已经会了）/ 顺序改成先 A 后 B / 删掉「Y」/ 增加关于 Z 的任务…"></textarea>
          <button class="btn small primary" id="npAdjustBtn" style="margin-top:8px;">${sxi('spark')}提交给 AI 调整</button>
        </div>
      </details>
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
    if (!sid) return toast('资料库还是空的：可以先「收集信息源」「导入代码库」或上传图片资料');
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
  /* 文件夹资料：自己挂的可以删，继承来的只读（显示来自哪一级） */
  const paintFolders = async () => {
    const box = div.querySelector('#npFolders');
    if (!box) return;
    try {
      const r = await api('/api/nodes/' + id + '/folders');
      const fs2 = r.folders || [];
      box.innerHTML = fs2.length ? fs2.map((f, i) => `<div class="npSrc npFolder">
        <div class="npSrcName">📁 ${esc(f.name)}${f.inherited ? `<span class="chip gray" style="margin-left:6px;">来自「${esc(f.nodeTitle)}」</span>` : '<span class="chip ok" style="margin-left:6px;">本节点</span>'}</div>
        <div class="npSrcNote mono">${esc(f.path)}</div>
        ${f.note ? `<div class="npSrcNote">${esc(f.note)}</div>` : ''}
        ${f.missing ? '<div class="npSrcNote" style="color:var(--danger);">目录已不在（删了/移动了/U盘拔了），先不管它，恢复后自动生效</div>' : ''}
        ${f.inherited ? '' : `<button class="btn tiny danger npsrcDel" data-npf-del="${esc(f.path)}">移除</button>`}
      </div>`).join('') : '<div class="muted" style="font-size:12.5px;">没挂文件夹：点下面「关联文件夹」，把源码目录挂到这一级，规划和教程会自动读它</div>';
      box.querySelectorAll('[data-npf-del]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('取消挂载这个文件夹？\n\n只删挂载关系，磁盘上的文件不动。')) return;
        try {
          const rr = await api('/api/nodes/' + id + '/folder', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: b.getAttribute('data-npf-del') }) });
          state.goal = rr.goal;
          toast('已取消挂载');
          showNodePanel(id, rerenderFn);
        } catch (e) { toast(e.message); }
      }));
    } catch (e) { box.innerHTML = '<div class="muted" style="font-size:12.5px;">加载失败：' + esc(e.message) + '</div>'; }
  };
  paintFolders();
  const npFolderAdd = div.querySelector('#npFolderAdd');
  if (npFolderAdd) npFolderAdd.addEventListener('click', () => showFolderDialog(id, () => showNodePanel(id, rerenderFn)));
  document.getElementById('npClose').addEventListener('click', closePanel);
  if (window.TutBookmark && goalCompOn(goalCtx(), 'tutbookmark')) window.TutBookmark.bindNodeImport(div, id, (r) => { state.goal = r.goal; showNodePanel(id, rerenderFn); });
  const tutBtn = document.getElementById('npTutBtn');
  if (tutBtn) tutBtn.addEventListener('click', () => { div.remove(); showTutorialDialog(id); });
  div.querySelectorAll('[data-tut-del]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    const tid = Number(b.getAttribute('data-tut-del'));
    const t = (tutorialsOfNode(id) || []).find(x => Number(x.id) === tid);
    if (!confirm('删除教程「' + String((t && t.title) || tid).slice(0, 40) + '」？删除后不可恢复。')) return;
    try {
      await api('/api/tutorials/' + tid, { method: 'DELETE' });
      await loadGoal(state.goal.id);
      rerenderFn();
      showNodePanel(id, rerenderFn);
      toast('已删除');
    } catch (err) { toast(err.message); }
  }));
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
  const closed = foldClosed(g.id, 'constraints', list.length > 0 || !!state.showConstraints);
  return `<div class="consCard">
    <div class="consHead">
      ${foldBtn('constraints', closed)}
      <span>⛓ 规划约束</span><span class="chip gray">${list.length}</span>
      <span class="consHint">这些是硬性要求，AI 在规划 / 拆分 / 教程 / 对话中都会严格遵守</span>
      <div class="spacer"></div>
    </div>
    <div class="consBody" data-foldbody="constraints"${closed ? ' hidden' : ''}>
      ${list.length ? `<div class="consList">${list.map((c, i) => `<div class="consItem"><span class="consText">${esc(String(c.text))}</span><div class="spacer"></div><button class="btn tiny" data-consedit="${i}">改</button><button class="btn tiny danger" data-consdel="${i}">×</button></div>`).join('')}</div>` : '<div class="muted" style="font-size:12.5px;padding:4px 2px;">还没有约束。例如：只能周末学（每周≤6h）／预算 0 元，只用免费资源／必须用 Python／不要安排视频课／3 个月内必须投递</div>'}
      <div class="consAdd">
        <input type="text" id="consInput" placeholder="添加一条约束，例如：不要安排付费课程">
        <button class="btn small primary" id="consAddBtn">添加约束</button>
      </div>
    </div>
  </div>`;
}
function bindConstraints(g) {
  const addBtn = document.getElementById('consAddBtn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const inp = document.getElementById('consInput');
    const text = (inp.value || '').trim();
    if (!text) return toast('请输入约束内容');
    try {
      const r = await api('/api/goals/' + g.id + '/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      state.goal = r.goal; state.showConstraints = true;
      try { const fm = cardFoldState(g.id); delete fm.constraints; cardFoldSave(g.id, fm); } catch (e) {}
      renderGoal(); toast('约束已添加，规划会严格遵守');
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
  image: { icon: '📷', label: '识别图片' },
  restate: { icon: '🧠', label: '用自己的话' }
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
/* 进行中任务的进度条：百分比 + 阶段点 + 实时思考。
   为什么要"动效"而不是一根静态的条：AI 任务一次要跑好几分钟，中间有很长
   时间是"在写、但没换阶段"，静态条看着像卡死。所以：
     · 条本身带流动高光，即使百分比不动也在动；
     · 底部再垫一条不确定态的走马灯条，只在没有真实百分比时显示；
     · 阶段点标出走到哪一步，已完成的打勾、当前的转圈；
     · 模型此刻在写什么/想什么，实时打在下面一行。
   进度只在 taskPoll 拉回来时更新（默认 1.5s 一次），动画交给 CSS，不占主线程。 */
function taskProgressHTML(t) {
  const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
  const steps = Array.isArray(t.steps) ? t.steps : null;
  const hasPct = pct > 0;
  /* 阶段点：超过 6 个就折叠成「3/9」这种计数，否则一行放不下 */
  let stepsHTML = '';
  if (steps && steps.length) {
    if (steps.length <= 6) {
      stepsHTML = `<div class="taskSteps">${steps.map(s =>
        `<span class="taskStep ${esc(s.state || 'pending')}" title="${esc(s.label)}${s.detail ? ' · ' + esc(s.detail) : ''}">`
        + `<i>${s.state === 'done' ? '✓' : s.state === 'active' ? '' : ''}</i>${esc(s.label)}</span>`).join('')}</div>`;
    } else {
      const done = steps.filter(s => s.state === 'done').length;
      const cur = steps.find(s => s.state === 'active');
      const i = steps.indexOf(cur);
      stepsHTML = `<div class="taskSteps count"><span class="taskStep done"><i>✓</i>${done} 步已完成</span>`
        + (cur ? `<span class="taskStep active"><i></i>${esc(cur.label)}（第 ${i + 1}/${steps.length} 步）</span>` : '')
        + `</div>`;
    }
  }
  const think = String(t.thinking || '').trim();
  const eta = String(t.eta || '').trim();
  return `<div class="taskProgWrap">
    <div class="taskProgNum">
      <span>${hasPct ? pct + '%' : '进行中'}${eta ? ` · <span class="taskEta">${esc(eta)}</span>` : ''}</span>
      ${t.startedAt ? `<span class="taskElapsed" data-since="${t.startedAt}"></span>` : ''}
    </div>
    <div class="taskProg${hasPct ? '' : ' indet'}"><i style="width:${hasPct ? pct : 100}%"></i></div>
    ${stepsHTML}
    ${think ? `<div class="taskThink" title="${esc(think)}">💭 ${esc(think)}</div>` : ''}
  </div>`;
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
            ${t.status === 'failed' && t.error && t.error.length > 46 ? `<div class="taskErr" data-task-err="${t.id}" title="点开看完整原因">${esc(String(t.error).slice(0, 46))}… <span class="taskErrMore">看原因</span></div>` : ''}
            ${t.status === 'running' ? taskProgressHTML(t) : ''}
          </div>
          ${taskActive(t)
            ? `<button class="btn tiny" data-task-cancel="${t.id}">停止</button>`
            : `<span class="taskState">${t.status === 'done' ? '✓ 完成' : t.status === 'failed' ? '✗ 失败' : '已停止'}</span>`}
          ${!taskActive(t) && t.canRetry
            ? `<button class="btn tiny retry" data-task-retry="${t.id}" ${t.retrying ? 'disabled' : ''} title="${t.status === 'done' ? '再跑一次同样的任务' : '失败后一键重跑：入参照旧，不用重新打一遍那段话'}">${t.retrying ? '提交中…' : '🔄 重试'}</button>`
            : ''}
        </div>`;
      }).join('') : '<div class="muted" style="font-size:12px;padding:6px;">暂无任务</div>'}
      ${recent.length ? `<button class="btn tiny" id="taskClear" style="margin:6px 0 2px;">清除已完成</button>` : ''}
    </div>` : ''}`;
  const pill = el.querySelector('#taskPill');
  if (pill) pill.addEventListener('click', () => { state.taskOpen = !state.taskOpen; taskBarRender(); });
  el.querySelectorAll('[data-task-cancel]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/tasks/' + b.getAttribute('data-task-cancel') + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已请求停止'); await taskPoll(); } catch (e) { toast(e.message); }
  }));
  /* 失败原因可点开看全文：报错信息是黑盒时，用户至少该知道"到底为什么没成" */
  el.querySelectorAll('[data-task-err]').forEach(d => d.addEventListener('click', async () => {
    const id = d.getAttribute('data-task-err');
    const t = (state.tasks || []).find(x => String(x.id) === String(id));
    if (!t) return;
    const full = String(t.error || '（没有更多信息）');
    const tip = document.createElement('div');
    tip.className = 'taskErrTip';
    tip.textContent = full;
    d.appendChild(tip);
    d.classList.add('open');
    const off = ev => { if (!tip.contains(ev.target) && ev.target !== d) { d.classList.remove('open'); tip.remove(); document.removeEventListener('click', off, true); } };
    setTimeout(() => document.addEventListener('click', off, true), 0);
  }));
  /* 重试：不需要用户重新打一遍那段话/那条意见（意见往往很长，重打最容易出错） */
  el.querySelectorAll('[data-task-retry]').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-task-retry');
    b.disabled = true; b.textContent = '提交中…';
    try {
      const r = await api('/api/tasks/' + id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r && r.ok === false) { toast('⚠️ ' + (r.error || '重试失败')); }
      else toast('🔄 已重新提交（原样的入参），进度见左下角任务中心');
    } catch (e) { toast(e.message); }
    state.taskOpen = true;
    await taskPoll();
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
/* 教程页：刚结束的任务里有当前这份的更新 → 无感刷新（保滚动；手动编辑中不覆盖；失败给明确提示） */
async function refreshTutorialIfUpdated(tid, finished) {
  let detail = null;
  try { detail = await api('/api/tutorials/' + tid); } catch (e) { return { refreshed: false }; }
  const nodeId = detail && detail.node ? Number(detail.node.id) : 0;
  const rel = (finished || []).filter(t => t.type === 'tutorial' && (
    (t.result && Number(t.result.tutorialId) === Number(tid)) || (nodeId && Number(t.nodeId) === nodeId)));
  const done = rel.filter(t => t.status === 'done');
  const failed = rel.filter(t => t.status === 'failed');
  if (!done.length && !failed.length) return { refreshed: false };
  if (!done.length) {
    toast('❌ 教程更新失败：' + String((failed[0] && failed[0].error) || '未知错误').slice(0, 140));
    return { refreshed: false };
  }
  if (document.getElementById('tutEditor')) {
    toast('✅ AI 已生成新版教程（你正在手动编辑，已保留你的草稿：取消编辑后即看新版）');
    return { refreshed: false };
  }
  const serverUpdated = (detail.tutorial && detail.tutorial.updated_at) || '';
  if (state.tutUpdatedAt && serverUpdated && serverUpdated === state.tutUpdatedAt) return { refreshed: false };  // 同一目标别的教程的任务
  const y = window.scrollY;
  try { await renderTutorialPage(tid); } catch (e) { toast(e.message); return { refreshed: false }; }
  try { window.scrollTo(0, y); } catch (e) {}
  toast('✅ 教程已更新');
  return { refreshed: true };
}
let taskTimer = null;
async function taskPoll() {
  try {
    const rr0 = (typeof parseRoute === 'function') ? parseRoute() : {};
    // 教程页没有 state.goal：用教程所属目标过滤/刷新，否则任务完成不会自动刷教程
    const gid = (state.goal ? state.goal.id : 0) || (rr0.view === 'tutorial' ? (state.tutGoalId || 0) : 0);
    const r = await api('/api/tasks' + (gid ? '?goalId=' + gid : ''));
    const list = r.tasks || [];
    /* 左栏「AI 任务」的小红点靠这个数；变了才重画左栏，别每 2 秒重画一次 */
    const actN = list.filter(taskActive).length;
    if (state.taskRunning !== actN) { state.taskRunning = actN; try { renderRail(); } catch (e) {} }
    // 新任务出现时给个小提示（动画 toast），替代原来的灰色遮罩
    const known = state.taskKnownIds || (state.taskKnownIds = {});
    const fresh = list.filter(t => !known[t.id] && (t.status === 'queued' || t.status === 'running'));
    // 有任务刚刚完成 → 重新拉取目标数据（教程/节点），保证界面能看到结果
    const finishedNow = list.filter(t => known[t.id] && ['done', 'failed', 'cancelled'].includes(t.status) && !known['done_' + t.id]);
    for (const t of list) {
      known[t.id] = 1;
      if (['done', 'failed', 'cancelled'].includes(t.status)) known['done_' + t.id] = 1;
    }
    if (finishedNow.length && gid) {
      /* 任务结果会写回对话（改完了 / 为什么失败），这里把新消息拉出来 ——
         否则用户看到的永远停在"已把这条修改意见交给 AI"，不知道后来怎么样了。 */
      if (document.getElementById('aiDrawer')) { try { await aiLoadMsgs(); } catch (e) {} }
      const rr = parseRoute();
      if (rr.view === 'tutorial' && rr.id) {
        // 教程页：只刷当前这份（别家任务不打扰阅读），其它完成任务照常提示
        const res = await refreshTutorialIfUpdated(Number(rr.id), finishedNow);
        const others = finishedNow.filter(t => t.status === 'done' && t.type !== 'tutorial');
        if (others.length) toast('✅ ' + others.length + ' 个 AI 任务完成，界面已更新');
        if (!res.refreshed) { try { await loadGoal(gid); } catch (e) {} }
      } else {
        const okCount = finishedNow.filter(t => t.status === 'done').length;
        if (okCount) toast('✅ ' + okCount + ' 个 AI 任务完成，界面已更新');
        try { await loadGoal(gid); } catch (e) {}
        if (rr.view === 'goal' || rr.view === 'map' || rr.view === 'tutorial') rerenderCurrent();
      // 节点面板开着的话，刷新它的内容
      const np = document.getElementById('nodePanel');
      if (np) { const nid = Number(np.getAttribute('data-node')); if (nid) { try { showNodePanel(nid); } catch (e) {} } }
      }
    }
    if (fresh.length) {
      const first = fresh[0];
      toast('🤖 ' + (TASK_META[first.type] ? TASK_META[first.type].label : 'AI 任务') + '已加入执行列表' + (fresh.length > 1 ? '（共 ' + fresh.length + ' 个）' : '') + ' · 左下角可看进度');
    }
    state.tasks = list;
  } catch (e) { return; }
  taskBarRender();
  taskMarkNodes();
  taskElapsedTick();
}
/* 「已用时」每秒跳一格：进度本身 2 秒才拉一次，但秒数自己会走，
   肉眼就能确认"它还活着"。只改文本节点，不重绘整个任务列表。 */
let taskElapsedTimer = null;
function taskElapsedTick() {
  const paint = () => {
    document.querySelectorAll('.taskElapsed[data-since]').forEach(el => {
      const since = Number(el.getAttribute('data-since')) || 0;
      if (!since) return;
      const s = Math.max(0, Math.round((Date.now() - since) / 1000));
      el.textContent = s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + String(s % 60).padStart(2, '0') + ' 秒';
    });
  };
  paint();
  if (taskElapsedTimer) return;
  taskElapsedTimer = setInterval(() => {
    if (!document.querySelector('.taskElapsed[data-since]')) { clearInterval(taskElapsedTimer); taskElapsedTimer = null; return; }
    paint();
  }, 1000);
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
  /* 主题只给变量 + color-scheme；元素级兜底（a/pre/表格/引用/容器）只在深色模式生效。
     血泪原因有三（前两个修完第三个才冒出来，全是线上真实踩到的）：
     1) body 强刷会洗掉 AI 自带的深色设计；
     2) 更隐蔽：`.tip,.note,.warn,.card,.box,section>div` 这类宽选择器带 !important，
        会命中教程自己的布局 div（如 .s-inner），把里面的字色强制刷成主题色 ——
        无头实测抓到 h1 computed 就是这么变深的，而教程源码里根本没有这个颜色；
     3) 最隐蔽：连 body 上的 `--bg:#fff` 变量定义都会劫持教程 `var(--bg)` 的底色 ——
        教程 body 写的是“渐变 + var(--bg)”，变量被换成白色后渐变下面全是白。
     所以浅色模式只留 html 打底 + color-scheme + 链接色，body 一行都不碰；
     无样式内容回退浏览器默认（黑字白底，可读）；深色模式仍整体强制。 */
  const elFallback = dark ? `
  body{background:${v.bg} !important;color:${v.fg} !important;}
  a{color:${v.accent} !important;}
  pre,code,pre code{background:${v.code} !important;color:${v.fg} !important;border-color:${v.border} !important;}
  blockquote{border-left-color:${v.border} !important;color:${v.muted} !important;background:${v.card} !important;}
  table,th,td{border-color:${v.border} !important;}
  th{background:${v.card} !important;}
  hr{border-color:${v.border} !important;}
  .tip,.note,.warn,.card,.box,section>div{background:${v.card} !important;border-color:${v.border} !important;color:${v.fg} !important;}` : `
  a{color:${v.accent};}`;
  const css = `<style id="sx-theme">
  html{background:${v.bg} !important;color-scheme:${dark ? 'dark' : 'light'};}${elFallback}
  sup.cite{font-size:.68em;vertical-align:super;line-height:0;color:${v.accent};background:${v.card};
    border:1px solid ${v.border};border-radius:4px;padding:0 2.5px;margin:0 1px;cursor:pointer;}
  sup.cite:hover{color:#fff;background:${v.accent};}
  </style>`;
  const t = String(html || '');
  if (/<\/head>/i.test(t)) return t.replace(/<\/head>/i, css + '</head>');
  if (/<body[^>]*>/i.test(t)) return t.replace(/<body[^>]*>/i, m => m + css);
  return css + t;
}
/* 渲染兜底：库里可能躺着修改流程存下来的脏 HTML（顶部一段前言+围栏），
   显示前按标记抽一次。只动显示，不改库里的数据。 */
function cleanHtmlForFrame(html) {
  const s = String(html || '');
  const low = s.toLowerCase();
  const i = low.indexOf('<!doctype');
  const j = low.lastIndexOf('</html>');
  if (i >= 0 && j > i) return s.slice(i, j + 7);
  const i2 = low.indexOf('<html');
  const j2 = low.lastIndexOf('</html>');
  if (i2 >= 0 && j2 > i2) return '<!DOCTYPE html>\n' + s.slice(i2, j2 + 7);
  return s;
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

/* ===== 教程：手动编辑与保存 ===== */
const TUTMANUAL_BOUND = true;
let tutEditing = false;
/* 当前教程页**渲染时用的那份源码**（markdown）。就地编辑单块要拿它切行，
   所以 renderTutorialPage 渲染 md 教程时把它留下来 —— 用"渲染的这份"而不是重新拉取，
   保证 data-src 的行号跟它一定对得上。 */
let tutRenderedSrc = '';
let tutManualUnbind = null;
/* 进入手动编辑时算出源码偏移。优先级：
   ① 用户点中的那段文字（anchorOff，最准，"点哪儿改哪儿"）
   ② Markdown 且目录追踪到当前章节标题 → 找对应 # 行
   ③ 兜底按滚动比例映射（HTML 教程走这里） */
function tutEditPos(src, fmt, ratioFb, anchorOff) {
  if (typeof anchorOff === 'number' && anchorOff >= 0) return { off: anchorOff, sec: 0 };
  try {
    if (fmt === 'md' && window.__tutCur && window.__tutCur.title) {
      const norm = s => String(s || '').replace(/^[#\s>]+/, '').replace(/[*`_~\[\]()#-]/g, '').replace(/\s+/g, '').slice(0, 60);
      const want = norm(window.__tutCur.title);
      if (want) {
        const lines = String(src).split('\n');
        let off = 0;
        for (const ln of lines) {
          if (/^#{1,4}\s/.test(ln)) {
            const h = norm(ln);
            if (h && (h === want || h.startsWith(want) || want.startsWith(h))) return { off, sec: (window.__tutCur.idx || 0) + 1 };
          }
          off += ln.length + 1;
        }
      }
    }
  } catch (e) {}
  // 兜底：按正文滚动比例映射到源码位置（HTML 教程也走这里；ratioFb 是替换 DOM 前量好的）
  try {
    let ratio = (typeof ratioFb === 'number') ? ratioFb : -1;
    if (ratio < 0) ratio = tutScrollRatio();
    return { off: Math.floor(String(src).length * ratio), sec: 0 };
  } catch (e) { return { off: 0, sec: 0 }; }
}
/* ---- 「点哪儿改哪儿」：在教程正文里点一段 → 直接进入手动编辑，光标落到对应源码 ----
   只对 Markdown 教程生效（它的正文就在主文档的 .tutBody 里）。
   HTML 教程的正文在 iframe 里、源码是 HTML：零依赖没有可靠的 HTML→MD 转换，
   而保存接口又不改 format（改不了），转成 MD 后会被当成 HTML 渲染 = 显示源码，
   所以 HTML 教程维持原样（仍可用工具条「✎ 手动编辑」按阅读位置进入）。 */
function tutClickRoot() {
  try { return document.querySelector('#app .tutBody') || null; } catch (e) { return null; }
}
/* ===== 「点哪儿改哪儿」的唯一判据（教程正文 / 笔记渲染态共用）=====
   渲染时 mdToHTML 给每个块标了 data-src = 该块的**源码起始行号**（opts.srcLines）。
   这里从鼠标下的元素往上找最近的、带 data-src 的那块 —— **悬停描边**与**点下去定位**
   都走这个函数，所以"描出来的块"与"点下去会改的那块"必定是同一个（先渲染后定位，
   不可能出现描 A 块、光标落 B 处）。
   为什么不再按文字在源码里找（老办法）：标题带 `##`、列表带 `-`、表格带 `|`、
   代码块带围栏，渲染后的文字跟源码对不上；同一句话出现两次还会匹到更早那处 ——
   实测双击 h2 会掉回文档开头（`## 1.5 小时掌握 MCP` 那行）。 */
function mdPickTarget(el, root) {
  try {
    let d = el;
    while (d && d !== root && d.parentNode) {
      if (d.getAttribute) {
        const v = d.getAttribute('data-src');
        if (v != null && /^\d+$/.test(String(v))) return d;
      }
      d = d.parentNode;
    }
  } catch (e) {}
  return null;
}
/* 源码第 line 行（0 基）的字符偏移 */
function mdLineOff(src, line) {
  const s = String(src == null ? '' : src);
  let off = 0;
  for (let k = 0, n = Math.max(0, line | 0); k < n; k++) {
    const j = s.indexOf('\n', off);
    if (j < 0) return s.length;
    off = j + 1;
  }
  return Math.min(off, s.length);
}
/* 由 mdPickTarget 找到的那块算出它在 src 里的字符偏移；拿不到返回 -1（调用方自己兜底）。
   ⚠️ 落在围栏行（```lang）上时往后挪一行 —— 代码块双击该进代码里，不是停在围栏上。 */
function mdPickOffset(src, el, root) {
  const pick = mdPickTarget(el, root);
  if (!pick) return -1;
  const ln = parseInt(pick.getAttribute('data-src'), 10);
  if (!(ln >= 0)) return -1;
  const s = String(src == null ? '' : src);
  let off = mdLineOff(s, ln);
  if (String(pick.tagName || '').toUpperCase() === 'PRE') {
    const ls = s.lastIndexOf('\n', Math.max(0, off - 1)) + 1;
    let le = s.indexOf('\n', ls); if (le < 0) le = s.length;
    if (le < s.length && /^\s*`{3,}/.test(s.slice(ls, le))) off = le + 1;
  }
  return off;
}
/* 悬停反馈：鼠标滑到哪一块就把哪一块描出来（教程正文 + 笔记渲染态共用一套 .mdClickPick）。
   触发手势各自不变（教程双击、笔记单击），这里只负责"描哪一块"。 */
function mdPickHoverBind() {
  if (document.__mdPickHover) return;
  document.__mdPickHover = true;
  let cur = null;
  const clear = () => { if (cur) { try { cur.classList.remove('mdClickPick'); } catch (e) {} cur = null; } };
  document.addEventListener('mouseover', e => {
    const t = e.target;
    if (!t || !t.closest) { clear(); return; }
    const root = t.closest('.tutBody') || t.closest('#nnView');
    /* 链接 / 按钮 / 引用角标 / 划线段 / 图：点了不编辑，就别描（否则等于骗人） */
    if (!root || t.closest('a,button,input,textarea,select,svg,img,sup.cite,mark.tnm')) { clear(); return; }
    const pick = mdPickTarget(t, root);
    if (pick === cur) return;
    clear();
    if (pick) { cur = pick; pick.classList.add('mdClickPick'); }
  });
  document.addEventListener('mouseout', e => {
    if (!cur) return;
    const to = e.relatedTarget;
    if (to && cur.contains && cur.contains(to)) return;   // 还在同一块里，别闪
    clear();
  });
  document.addEventListener('scroll', clear, true);
  document.addEventListener('mouseleave', clear, true);
}
mdPickHoverBind();
/* ===================== 就地编辑单块（教程正文 / 笔记栏共用这一套） =====================
   老做法：点一块 → 弹出**整篇** markdown 的 textarea，用户还得自己滚到那一行。
   新做法（用户要求）：只把**被点到的那一块**就地换成编辑框，框里是这一块的源码
   markdown，其余内容照常渲染 —— 改哪显示哪。
   行范围从渲染时标的 data-src / data-srce 读（见 mdToHTML 的 srcAttr2），
   所以围栏代码块、表格、列表、引用、标题都能原样取出这一段源码。
   Ctrl+S / Esc 的处理统一走 editKeysBind()（**为什么见那里的注释**）。 */

/* 统一的「编辑框快捷键」：Ctrl/Cmd+S = 保存，Esc = 取消。
   ⚠️ 用户实测「按 Ctrl+S 不保存、点工具栏保存却可以」，根因就在这个键盘处理上：
   ① 原来监听挂在 **textarea 自己**身上 —— 用户点了别处（焦点漂走）、或编辑器被重绘
      替换掉之后，按键就再也到不了它，Ctrl+S 变成浏览器的「保存网页」，页面毫无反应。
      现在挂到 document 的**捕获阶段**，并且只在编辑框还在时才动作 → 焦点在哪都拦得住。
   ② key 判断太窄：CapsLock 开着时 Ctrl+S 给的是 key='S'，`e.key==='s'` 直接漏掉；
      再补 code==='KeyS'（不受大小写 / 键盘布局影响），两条命中其一即保存。
   ③ 必须 preventDefault 拦掉浏览器默认的「保存网页」。
   合成事件（dispatchEvent）能过不代表真按键能过，所以验收一律用 CDP Input.dispatchKeyEvent。 */
function editKeysBind(onSave, onCancel) {
  const h = e => {
    const k = String(e.key == null ? '' : e.key).toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 's' || e.code === 'KeyS')) { e.preventDefault(); e.stopPropagation(); onSave(); return; }
    if (k === 'escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  document.addEventListener('keydown', h, true);
  return () => { try { document.removeEventListener('keydown', h, true); } catch (e2) {} };
}
/* 从渲染块读出源码行范围 [a,b)；读不到（没标的块，如 HTML 教程里渲染出来的东西）返回 null */
function mdSrcRange(el) {
  try {
    if (!el || !el.getAttribute) return null;
    const a = el.getAttribute('data-src'), b = el.getAttribute('data-srce');
    if (a == null || !/^\d+$/.test(String(a))) return null;
    const s = parseInt(a, 10);
    let e = (b != null && /^\d+$/.test(String(b))) ? parseInt(b, 10) : -1;
    if (!(e > s)) e = s + 1;
    return [s, e];
  } catch (err) { return null; }
}
function mdSliceLines(src, a, b) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  a = Math.max(0, Math.min(lines.length, a | 0));
  b = Math.max(a, Math.min(lines.length, b | 0));
  return lines.slice(a, b).join('\n');
}
/* 用 text 替换 src 的第 [a,b) 行；末尾多余的换行吃掉一个，免得每保存一次就多空一行 */
function mdSpliceLines(src, a, b, text) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  a = Math.max(0, Math.min(lines.length, a | 0));
  b = Math.max(a, Math.min(lines.length, b | 0));
  const rep = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(0, a).concat(rep).concat(lines.slice(b)).join('\n');
}

function mdInlineActive() { return !!(mdInlineSt && mdInlineSt.editor && mdInlineSt.editor.isConnected); }
function mdInlineValue() {                     // 当前编辑框里的"整篇新源码"（未保存时给 flush 用）
  const st = mdInlineSt;
  if (!st || !st.ta) return null;
  const rg = mdSrcRange(st.pickEl);
  if (!rg) return null;
  let src = '';
  try { src = String(st.opts.getSrc ? st.opts.getSrc() : '') || ''; } catch (e) {}
  return mdSpliceLines(src, rg[0], rg[1], st.ta.value);
}
/* 就地打开一块：pickEl 是渲染时带 data-src/data-srce 的那块，opts：
     getSrc(): string            当前整篇源码
     save(newSrc): Promise<bool> 保存（PUT + 重渲染），返回 true = 成功
     tag / onCancel              可选 */
function mdInlineOpen(pickEl, opts) {
  opts = opts || {};
  if (!pickEl || !pickEl.parentNode) return false;
  const rg = mdSrcRange(pickEl);
  if (!rg) return false;
  if (mdInlineSt) mdInlineClose(true);         // 换一块编辑：先把上一块原样放回去（丢弃未保存的改动）
  let src = '';
  try { src = String(opts.getSrc ? opts.getSrc() : '') || ''; } catch (e) { src = ''; }
  const raw = mdSliceLines(src, rg[0], rg[1]);
  const editor = document.createElement('div');
  editor.className = 'mdInlineEdit';
  editor.innerHTML = '<div class="mieBar"><span class="mieTag">' + esc(opts.tag || '编辑这一块（Markdown 源码）') + '</span>'
    + '<span class="mieHint">改完 Ctrl+S 或点「💾 保存」· Esc 取消</span>'
    + '<div class="spacer"></div>'
    + '<button type="button" class="btn tiny primary" data-mie="save">💾 保存</button>'
    + '<button type="button" class="btn tiny" data-mie="cancel">取消</button></div>'
    + '<textarea class="mieTa" spellcheck="false" wrap="soft"></textarea>';
  const ta = editor.querySelector('.mieTa');
  ta.value = raw;
  try { ta.rows = Math.max(3, Math.min(28, raw.split('\n').length + 1)); } catch (e) {}
  pickEl.parentNode.replaceChild(editor, pickEl);
  const unbind = editKeysBind(() => mdInlineSave(), () => mdInlineClose(true));
  mdInlineSt = { editor, ta, pickEl, opts, rg, busy: false, unbind };
  editor.querySelector('[data-mie="save"]').addEventListener('click', mdInlineSave);
  editor.querySelector('[data-mie="cancel"]').addEventListener('click', () => mdInlineClose(true));
  try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
  return true;
}
/* restore=true：取消（把原来的渲染块放回去）；false：只把编辑框拿掉（保存成功/被别的操作收掉） */
function mdInlineClose(restore) {
  const st = mdInlineSt;
  if (!st) return;
  mdInlineSt = null;
  try { if (st.unbind) st.unbind(); } catch (e) {}
  try {
    if (restore && st.editor && st.editor.parentNode && st.pickEl) st.editor.parentNode.replaceChild(st.pickEl, st.editor);
    else if (st.editor && st.editor.parentNode) st.editor.parentNode.removeChild(st.editor);
  } catch (e) {}
  if (restore) { try { if (st.opts && st.opts.onCancel) st.opts.onCancel(); } catch (e) {} }
}
async function mdInlineSave() {
  const st = mdInlineSt;
  if (!st || st.busy) return;
  st.busy = true;
  const btn = st.editor && st.editor.querySelector('[data-mie="save"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const next = mdInlineValue();
  let ok = false;
  try { ok = next == null ? false : await (st.opts.save ? st.opts.save(next) : Promise.resolve(false)); }
  catch (e) { toast(e && e.message ? e.message : '保存失败'); ok = false; }
  if (mdInlineSt !== st) return;               // 保存期间被别的操作收掉了
  if (ok) mdInlineClose(false);
  else { st.busy = false; if (btn) { btn.disabled = false; btn.textContent = '💾 保存'; } }
}

/* 从点中的那段文字里挑几段"最可能在源码里逐字出现"的内容，去源码里找偏移。
   （只作为兜底：渲染没标 data-src 的场合，如 HTML 教程、教程版本预览）
   ⚠️ 渲染时有几处会往正文里塞东西：引用角标 [123456] → <sup class="cite">⧉</sup>，
   所以先去掉 ⧉ 再匹配（否则整段都找不着、只能退回滚动比例）。 */
function tutTextAnchor(src, txt) {
  const s = String(src || '');
  const norm = String(txt || '').replace(/⧉/g, '\n').replace(/\s+/g, ' ').trim();
  if (!s || !norm) return -1;
  const cands = [norm.slice(0, 40), norm.slice(0, 18)];
  const runs = (norm.match(/[^\s`*_#>\[\]()~|]+/g) || []).filter(r => r.length >= 6).sort((a, b) => b.length - a.length);
  for (const r of runs.slice(0, 3)) cands.push(r);
  /* 列表项被折成一行 / 中间夹了角标时，整段找不到，按标点切成短句再试 */
  const pieces = norm.split(/[\n，。；、,.;!?！？:：]/).map(x => x.trim()).filter(x => x.length >= 4).sort((a, b) => b.length - a.length);
  for (const p of pieces.slice(0, 4)) cands.push(p);
  for (const c of cands) { if (c && c.length >= 4) { const i = s.indexOf(c); if (i >= 0) return i; } }
  return -1;
}
function tutAnchorOff(el, root, src) {
  try {
    let d = el;
    while (d && d !== root && d.parentNode) {
      const tag = String(d.tagName || '').toLowerCase();
      if (/^(p|li|h[1-6]|pre|blockquote|td|th|dt|dd|figcaption)$/.test(tag)) break;
      d = d.parentNode;
    }
    if (!d || d === root) return -1;
    return tutTextAnchor(src, d.textContent);
  } catch (e) { return -1; }
}
/* 打开手动编辑：anchorEl 为空 = 点工具条进来的（按阅读位置定位） */
async function tutManualEnter(anchorEl) {
  if (tutEditing) return;
  const rr = parseRoute();
  if (rr.view !== 'tutorial') return;
  const tut = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(rr.id));
  const contentEl = document.getElementById('tutFrame') || tutRoot();
  tutEditing = true;
  // 先记下阅读位置（DOM 替换前量滚动比例，编辑框里直接跳过去）
  let editRatio = 0;
  try { editRatio = tutScrollRatio(); } catch (e) {}
  // 取最新内容：按教程 id 单独取（直接打开/刷新教程页时 state.goal 里没有它，也能编辑）
  let src = '', fmt = (tut && tut.format) || 'md';
  try {
    const r = await api('/api/tutorials/' + rr.id);
    const fresh = r.tutorial || r;
    if (fresh && fresh.content) src = fresh.content;
    if (fresh && fresh.format) fmt = fresh.format;
  } catch (e) {}
  if (!src) src = (tut && tut.content) || '';
  if (!src) { tutEditing = false; toast('教程内容加载失败，请刷新后重试'); return; }
  /* 定位：① mdToHTML 渲染时标的源码行号（最准，标题/列表/表格/代码块都准）
             ② 老办法按文字匹配（只在没标 data-src 时兜底，如 HTML 教程、版本预览）
            —— 两条都失败就交给 tutEditPos 按阅读位置兜底，**绝不跳回开头**。 */
  let anchorOff = -1;
  if (anchorEl) {
    const root = tutClickRoot();
    anchorOff = mdPickOffset(src, anchorEl, root);
    if (anchorOff < 0) anchorOff = tutAnchorOff(anchorEl, root, src);
  }
  const wrap = document.createElement('div');
  wrap.id = 'tutEditorWrap';
  wrap.className = 'tutEditorWrap';
  wrap.innerHTML = '<div class="tutEditorBar">正在编辑（' + (fmt === 'md' ? 'Markdown' : 'HTML') + '）· 改完点「💾 保存」（或 Ctrl+S），点「取消」放弃</div><textarea id="tutEditor" spellcheck="false"></textarea>';
  if (contentEl && contentEl.parentNode) {
    contentEl.style.display = 'none';
    contentEl.parentNode.insertBefore(wrap, contentEl);
  } else {
    const app = document.getElementById('app');
    if (app) app.appendChild(wrap);
  }
  const ta = document.getElementById('tutEditor');
  ta.value = src;
  /* Ctrl+S / Cmd+S 保存（Esc 取消）—— 走与工具条「💾 保存」完全相同的 tutManualSave()。
     ⚠️ 挂在 document 捕获阶段（不是 textarea 自己）：焦点漂走 / 编辑器被重绘后
     Ctrl+S 才算得住；key 判断也放宽到大写 S 与 code=KeyS。见 editKeysBind 的注释。 */
  if (tutManualUnbind) { try { tutManualUnbind(); } catch (e0) {} }
  tutManualUnbind = editKeysBind(() => tutManualSave(), () => tutManualCancel());
  // 跳到"要改的那一段"，而不是从头开始找
  let editJumpSec = 0;
  try {
    const ep = tutEditPos(src, fmt, editRatio, anchorOff);
    editJumpSec = ep.sec || 0;
    ta.focus();
    if (ep.off > 0) {
      ta.setSelectionRange(ep.off, ep.off);
      /* 两种估算取较大值：按行号×行高（源码换行准）、按字符比例×总高（长段落折行时更贴），
         总之把光标那一行滚进框内偏上，肉眼不会跳回开头。 */
      requestAnimationFrame(() => {
        try {
          const lh = parseFloat(window.getComputedStyle(ta).lineHeight) || 20;
          const line = (src.slice(0, ep.off).match(/\n/g) || []).length;
          const byLine = (line - 1) * lh - ta.clientHeight * 0.3;
          const byRatio = (ep.off / Math.max(1, src.length)) * ta.scrollHeight - ta.clientHeight * 0.35;
          ta.scrollTop = Math.max(0, Math.max(byLine, byRatio));
        } catch (e2) {}
      });
    }
  } catch (e2) { try { ta.focus(); } catch (e3) {} }
  const sv = document.getElementById('tutSaveBtn'); if (sv) sv.hidden = false;
  const mb = document.getElementById('tutManualBtn'); if (mb) mb.textContent = '✎ 编辑中…';
  const cb = document.getElementById('tutCancelBtn');
  if (cb) cb.hidden = false;
  toast(anchorOff >= 0 ? '已进入编辑并定位到你点的那一段（Ctrl+S 或「💾 保存」）'
    : '已进入编辑模式' + (editJumpSec ? '（已定位到第 ' + editJumpSec + ' 节附近）' : '（共 ' + src.length + ' 字）'));
}
/* 教程正文落库的**唯一**入口：工具条「💾 保存」、整篇编辑的 Ctrl+S、就地编辑单块，
   三处都走它 —— 不写第二份 PUT 逻辑（服务端会先存一版历史，可回滚）。 */
async function tutPutContent(tid, content) {
  return await api('/api/tutorials/' + tid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) });
}
/* 保存成功后同步内存里的两份缓存：当前渲染用的源码 + state.goal 里的教程对象。
   不做的话重新进入教程 / 版本对比会拿到旧正文。 */
function tutRawCachePut(tid, content) {
  try { if (parseRoute().view === 'tutorial') tutRenderedSrc = content; } catch (e) {}
  try {
    const t = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(tid));
    if (t) t.content = content;
  } catch (e) {}
}
/* 保存后刷新 state.tutUpdatedAt：任务轮询靠它判断"服务端内容变了"，不更新会立刻触发一次无感刷新 */
async function refreshTutUpdatedAt(tid) {
  try { const d = await api('/api/tutorials/' + tid); if (d && d.tutorial) state.tutUpdatedAt = d.tutorial.updated_at || ''; } catch (e) {}
}
/* 保存 / 取消：工具条按钮与编辑器里的 Ctrl+S / Esc 共用这两个函数（只有一份逻辑） */
async function tutManualSave() {
  const rr = parseRoute();
  if (rr.view !== 'tutorial') return;
  const ta = document.getElementById('tutEditor');
  if (!ta) return;
  const sb = document.getElementById('tutSaveBtn');
  if (sb && sb.disabled) return;                 // 保存中，别重复提交（Ctrl+S 连按）
  if (sb) { sb.disabled = true; sb.textContent = '保存中…'; }
  try {
    await tutPutContent(rr.id, ta.value);
    tutRawCachePut(rr.id, ta.value);
    toast('✅ 已保存（可在「📜 版本对比」回滚）');
    tutEditing = false;
    if (tutManualUnbind) { try { tutManualUnbind(); } catch (e0) {} tutManualUnbind = null; }
    try { const w = document.getElementById('tutEditorWrap'); if (w) w.remove(); } catch (e2) {}
    const sv3 = document.getElementById('tutSaveBtn'); if (sv3) sv3.hidden = true;
    const cb3 = document.getElementById('tutCancelBtn'); if (cb3) cb3.hidden = true;
    const mb3 = document.getElementById('tutManualBtn'); if (mb3) mb3.textContent = '✎ 手动编辑';
    if (state.goal) { try { await loadGoal(state.goal.id); } catch (e2) {} }
    await refreshTutUpdatedAt(rr.id);
    renderTutorialPage(rr.id);
  } catch (err) { toast(err.message); }
  if (sb) { sb.disabled = false; sb.textContent = '💾 保存'; }
}
async function tutManualCancel() {
  const rr = parseRoute();
  tutEditing = false;
  if (tutManualUnbind) { try { tutManualUnbind(); } catch (e0) {} tutManualUnbind = null; }
  try { const w = document.getElementById('tutEditorWrap'); if (w) w.remove(); } catch (e2) {}
  try {
    const ce = document.getElementById('tutFrame') || tutRoot();
    if (ce) ce.style.display = '';
  } catch (e2) {}
  const sv2 = document.getElementById('tutSaveBtn'); if (sv2) sv2.hidden = true;
  const cb2 = document.getElementById('tutCancelBtn'); if (cb2) cb2.hidden = true;
  const mb2 = document.getElementById('tutManualBtn'); if (mb2) mb2.textContent = '✎ 手动编辑';
  if (state.goal) { try { await loadGoal(state.goal.id); } catch (e2) {} }
  try { await renderTutorialPage(rr.id); } catch (e2) { location.reload(); }
  toast('已取消编辑');
}
/* ===== 教程正文：双击一块 → 只编辑这一块（就地）=====
   用户原话：「只把方框里的那一坨东西用 MD 显示，让用户能修改，其他地方都是正常渲染」。
   拿不到行范围（HTML 教程、没有 data-src 的块）就退回整篇编辑（tutManualEnter）。 */
function tutInlineEnter(pickEl) {
  const rr = parseRoute();
  if (rr.view !== 'tutorial' || !pickEl) return false;
  const beforeTop = (() => { try { return pickEl.getBoundingClientRect().top; } catch (e) { return 0; } })();
  return mdInlineOpen(pickEl, {
    tag: '编辑这一块（Markdown 源码）',
    getSrc: () => tutRenderedSrc,
    save: async (next) => {
      await tutPutContent(rr.id, next);
      tutRawCachePut(rr.id, next);
      toast('✅ 已保存这一块（想整篇改可点「✎ 手动编辑」）');
      await refreshTutUpdatedAt(rr.id);
      tutRerenderBody(next, pickEl.getAttribute('data-src'), beforeTop);
      return true;
    }
  });
}
/* 保存后只重画正文（不整页刷新），并把刚编辑的那一块拉回原来的视口位置 —— 阅读位置不跳。
   为什么不"只重画这一块"：改一次可能从一段变成标题+列表好几块，还可能牵动列表/引用的
   上下文，整块重排才跟服务端一致；保住滚动位置就足以做到"看不出页面动过"。 */
function tutRerenderBody(next, startLine, beforeTop) {
  const body = document.querySelector('#app .tutBody');
  if (!body) return;
  try { body.innerHTML = mdToHTML(next, { viz: true, srcLines: true }); } catch (e) { return; }
  try {
    const el = body.querySelector('[data-src="' + String(startLine) + '"]');
    if (el) { const d = el.getBoundingClientRect().top - (beforeTop || 0); if (Math.abs(d) > 2) window.scrollBy(0, d); }
  } catch (e) {}
}
/* 正文里**双击**一段 → 进编辑（单击太容易误触，用户反馈过）。链接/按钮/引用角标/划线段/图上都不抢；
   刚拖选过文字（要划线或复制）也不抢。 */
function tutBindClickEdit() {
  if (document.__tutClickEdit) return;
  document.__tutClickEdit = true;
  /* ⚠️ 用**双击**触发（单击太容易误触：选字、想滑轮滚动都可能点上一下）。
     但双击本身会让浏览器选中光标下的那个词，而下面原本有一条"有选中就不编辑"的
     判断（那是给单击写的）—— 直接改成 dblclick 会被它全部挡掉。
     所以这里把选区**折叠掉**再继续：既不误触，又能让编辑从双击的那个词开始。 */
  document.addEventListener('dblclick', e => {
    if (tutEditing) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('a,button,input,textarea,select,svg,img,sup.cite,mark.tnm,[data-toc]')) return;
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) sel.collapseToStart();   // 收掉双击自动选中的词
    } catch (err) {}
    const root = tutClickRoot();
    if (!root || !root.contains(t)) return;
    const rr = parseRoute();
    if (rr.view !== 'tutorial') return;
    /* 主路径：只把双击的这一块就地变成 markdown 编辑框（悬停描的就是它）。
       已经就地编辑着就别再开，免得越点越多。 */
    if (mdInlineActive()) return;
    const pick = mdPickTarget(t, root);
    if (pick && mdSrcRange(pick) && tutInlineEnter(pick)) return;
    tutManualEnter(t);   // 兜底：整篇编辑
  });
}
tutBindClickEdit();
document.addEventListener('click', async e => {
  const eb = e.target.closest && e.target.closest('#tutManualBtn');
  const sb = e.target.closest && e.target.closest('#tutSaveBtn');
  const cb0 = e.target.closest && e.target.closest('#tutCancelBtn');
  if (!eb && !sb && !cb0) return;
  if (parseRoute().view !== 'tutorial') return;
  if (eb) { await tutManualEnter(null); return; }
  if (cb0) { await tutManualCancel(); return; }
  if (sb) { await tutManualSave(); }
});
/* ===== 教程大纲（侧边栏）：点击跳转 + 当前章节高亮 + 阅读进度 ===== */
/* ⚠️ 教程正文**不一定在主文档里**：
     - Markdown 教程 → 主文档的 .tutBody
     - HTML 教程    → <iframe id="tutFrame">（srcdoc，同源可访问 contentDocument）
   而且 .tutFrame 是**固定高度**（height:calc(100vh - 170px)），滚动发生在 iframe 内部，
   主文档并不滚。
   目录 / 阅读位置 / 标签书签以前全都直接 document.querySelector('.tutBody') + window.scrollY，
   对 HTML 教程一律落空 —— 而且是**静默 return**，肉眼看就是"这三个组件坏了"。
   所以下面这四个函数是唯一的入口，目录/位置/书签都必须穿过它们。 */
function tutFrameEl() { return document.getElementById('tutFrame'); }
function tutDoc() { const f = tutFrameEl(); return (f && f.contentDocument) ? f.contentDocument : document; }
function tutWin() { const f = tutFrameEl(); return (f && f.contentWindow) ? f.contentWindow : window; }
/* 正文容器：找不到就用文档根，好过什么都拿不到 */
function tutRoot() {
  const d = tutDoc();
  try { return d.querySelector('.tutBody') || d.querySelector('.mdBody') || d.body || d.documentElement; }
  catch (e) { return null; }
}
function tutHeadEl(i) { try { return tutDoc().getElementById('tutsec-' + i); } catch (e) { return null; } }
/* HTML 教程的**正文自带**目录（AI 常写 <nav class="toc"><a href="#s1">…</a></nav>）跳转失效时，
   用户看到的就是"点了没反应"。真实原因：那份教程被截断了 —— 目录列 12 节，正文只写到第 3 节，
   #s4…#s12 这些锚点压根不存在（线上真事，教程 id=52）。
   这里在渲染时提前体检，发现残缺就插一段说明 + 指向"重新生成/换模型"的提示，
   并把失效的目录项标出来（点了会提示，而不是静默无反应）。 */
function tutBodyAnchors() {
  const d = tutDoc();
  try {
    const out = [];
    d.querySelectorAll('a[href^="#"]').forEach(a => {
      const id = String(a.getAttribute('href') || '').slice(1);
      if (!id) return;
      if (out.some(x => x.id === id)) return;
      out.push({ id, text: (a.textContent || '').trim().slice(0, 40), dead: !d.getElementById(id) });
    });
    return out;
  } catch (e) { return []; }
}
function tutTruncNotice(deadAnchors) {
  if (!deadAnchors || !deadAnchors.length) return;
  const old = document.getElementById('tutTruncBar'); if (old) old.remove();
  const bar = document.createElement('div');
  bar.id = 'tutTruncBar';
  bar.className = 'tutTruncBar';
  bar.innerHTML = `<span class="ttbIcon">⚠️</span>
    <span class="ttbText">这份教程<span class="ttbHi">没写完就断了</span>：正文自带目录里的
      <b>${deadAnchors.length}</b> 个章节（如 ${esc(deadAnchors.slice(0, 3).map(x => '#' + x.id).join('、'))}）在正文里根本不存在，点它们不会有反应。
      <span class="ttbDim">多半是模型单次输出到上限被截断。</span></span>
    <span class="spacer" style="flex:1"></span>
    ${state.tutNodeId ? `<button class="btn tiny" data-ttb-gen>🔄 重新生成一份完整的</button>` : ''}
    <button class="btn tiny" data-ttb-close title="知道了">✕</button>`;
  const host = document.getElementById('tutMeta');
  if (host && host.parentNode) host.parentNode.insertBefore(bar, host.nextSibling);
  else document.body.appendChild(bar);
  bar.querySelector('[data-ttb-close]').addEventListener('click', () => bar.remove());
  const gb = bar.querySelector('[data-ttb-gen]');
  if (gb) gb.addEventListener('click', () => {
    const nid = (state.tutNodeId || 0);
    if (!nid) { toast('这个教程没关联节点，没法一键重生成 —— 请回到目标页对节点重新生成'); return; }
    if (!confirm('重新生成会新增一份教程（当前这份保留，之后可以删）。要继续吗？')) return;
    gb.disabled = true; gb.textContent = '提交中…';
    fetch('/api/nodes/' + nid + '/tutorial', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: (tutFmtOf(Number(rr.id)) || 'md'),
        /* 截断提醒要按格式说话：对 HTML 教程是要收尾 </html>，
           对 Markdown 教程说「以 </html> 收尾」等于给了条它永远做不到的指令。 */
        note: (tutFmtOf(Number(rr.id)) === 'html')
          ? '重写一份完整的：上次输出被截断了，务必写完所有章节并以 </html> 收尾'
          : '重写一份完整的：上次输出被截断了，务必写完所有章节，所有 ``` 代码块（含 ```viz 可视化块）都要闭合收尾'
      })
    }).then(() => { toast('已提交（进度见左下角任务中心）'); gb.textContent = '已提交'; gb.disabled = true; })
      .catch(err => { toast(err.message); gb.disabled = false; gb.textContent = '🔄 重新生成一份完整的'; });
  });
  console.warn('[tutorial] 检测到教程被截断：' + deadAnchors.length + ' 个目录章节缺失 → ' + deadAnchors.map(x => '#' + x.id).join(' '));
}
function tutFmtOf(tid) {
  try { const t = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(tid)); return t && t.format; } catch (e) {}
  return state.tutFmt || 'md';
}
/* 正文滚了多少 / 能滚多远 —— Markdown 用主文档，HTML 用 iframe 内部 */
function tutScrollRatio() {
  try {
    const w = tutWin(), root = tutRoot();
    if (!root) return 0;
    const r = root.getBoundingClientRect();
    const total = r.height - w.innerHeight;
    if (total > 0) return Math.max(0, Math.min(1, (0 - r.top) / total));
    const d2 = tutDoc();
    const t2 = (d2.body ? d2.body.scrollHeight : 0) - w.innerHeight;
    return t2 > 0 ? Math.max(0, Math.min(1, w.scrollY / t2)) : 0;
  } catch (e) { return 0; }
}
function tutTocOpen() { try { return localStorage.getItem('sierxing-toc-open') !== '0'; } catch (e) { return true; } }
function tutTocWidth() {
  try { const w = Number(localStorage.getItem('sierxing-toc-w')) || 220; return Math.max(160, Math.min(360, w)); }
  catch (e) { return 220; }
}
function tutTocShowTab(tid) {
  if (document.getElementById('tutTocTab') || document.getElementById('tutToc')) return;
  const tab = document.createElement('button');
  tab.id = 'tutTocTab';
  tab.className = 'tutTocTab';
  tab.title = '展开目录';
  tab.textContent = '📑 目录';
  tab.addEventListener('click', () => {
    try { localStorage.setItem('sierxing-toc-open', '1'); } catch (e) {}
    try { tutTocBuild(tid); } catch (e) {}
  });
  document.body.appendChild(tab);
}
function tutTocBuild(tid) {
  const body = tutRoot();
  if (!body) return;
  const heads = [...body.querySelectorAll('h1,h2,h3,h4')].filter(h => (h.textContent || '').trim());
  try { window.__tutTotal = heads.length; } catch (e) {}
  if (heads.length < 2) return;   // 章节太少就不显示
  /* ⚠️ 这个函数一次打开会被调用多次（iframe 的 load、兜底定时器、顶栏「目录」切换…），
     而 onScroll 每次都会把 localStorage['sierxing-tut-pos-<id>'] 写成当前节号。
     所以"上次位置"必须在第一次进来时就锁住，恢复完成之前不许被 onScroll 覆盖 ——
     否则等于每次打开教程都把书签清成 0，下次自然回不去原来那一节。 */
  if (window.__tutTocTid !== Number(tid)) {
    window.__tutTocTid = Number(tid);
    let sv = 0;
    try { sv = Number(localStorage.getItem('sierxing-tut-pos-' + tid) || 0); } catch (e) {}
    window.__tutTocSaved = (sv > 0 && sv < heads.length) ? sv : 0;
    window.__tutTocRestoring = true;   // 恢复期间不要回写位置
  }
  heads.forEach((h, i) => { h.id = 'tutsec-' + i; });
  const w = tutWin();   // Markdown = window；HTML 教程 = iframe 内部那个 window
  // 面板只在展开时建；追踪常驻（书签要用）
  const old = document.getElementById('tutToc'); if (old) old.remove();
  const oldTab = document.getElementById('tutTocTab'); if (oldTab) oldTab.remove();
  if (!tutTocOpen()) tutTocShowTab(tid);
  const toc = document.createElement('div');
  toc.id = 'tutToc';
  toc.className = 'tutToc';
  toc.style.width = tutTocWidth() + 'px';
  /* 目录面板：顶栏和底部进度条**常驻**，只有中间的条目列表滚动。
   （以前标题也是滚动区里的普通内容，一翻就滚没了，想点「收起」得先滚回顶。） */
  toc.innerHTML = `<div class="tutTocTitle"><span>📑 目录（${heads.length}）</span><div class="spacer"></div><button class="btn tiny" id="tutTocHide" title="收起（顶栏「目录」可再打开）">« 收起</button></div>`
    + `<div class="tutTocScroll" id="tutTocScroll">`
    + heads.map((h, i) => {
      const lv = Number(h.tagName.slice(1));
      return `<a class="tutTocItem lv${Math.min(lv, 4)}" data-toc="${i}">${esc((h.textContent || '').trim().slice(0, 40))}</a>`;
    }).join('')
    + `</div>`
    + `<div class="tutTocProg" id="tutTocProg">阅读位置：—</div>
    <div class="tutTocResize" id="tutTocResize" title="拖动调宽"></div>`;
  if (tutTocOpen()) {
    document.body.appendChild(toc);
    const tb = document.getElementById('tutTocTab'); if (tb) tb.remove();
  }
  toc.querySelectorAll('[data-toc]').forEach(a => a.addEventListener('click', () => {
    const h = tutHeadEl(a.getAttribute('data-toc'));
    if (!h) return;
    const y = h.getBoundingClientRect().top + w.scrollY - 110;   // 给吸顶顶栏留位置
    try { w.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) {}
  }));
  const hideBtn = toc.querySelector('#tutTocHide');
  if (hideBtn) hideBtn.addEventListener('click', () => {
    try { localStorage.setItem('sierxing-toc-open', '0'); } catch (e) {}
    toc.remove();
    tutTocShowTab(tid);
  });
  const rz = toc.querySelector('#tutTocResize');
  if (rz) rz.addEventListener('mousedown', e => {
    e.preventDefault();
    const left0 = toc.getBoundingClientRect().left;
    const move = ev => {
      const w = Math.max(160, Math.min(360, Math.round(ev.clientX - left0)));
      toc.style.width = w + 'px';
      try { localStorage.setItem('sierxing-toc-w', String(w)); } catch (err) {}
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  // 滚动时高亮当前章节 + 显示阅读进度（面板收起时也跑，供书签定位）
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      let cur = 0;
      for (let i = 0; i < heads.length; i++) {
        const r = heads[i].getBoundingClientRect();
        if (r.top <= 140) cur = i; else break;
      }
      const items = toc.querySelectorAll('[data-toc]');
      if (items.length) items.forEach(a => a.classList.toggle('active', Number(a.getAttribute('data-toc')) === cur));
      /* 章节多的时候（比如 HTML 教程动辄四五十节），当前节往往在目录可视区之外，
         高亮了也看不见 = 看起来像没生效。变化时才滚一下，别每帧都动。 */
      if (cur !== toc.__active) {
        toc.__active = cur;
        const act = items[cur];
        if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      }
      try { window.__tutCur = { idx: cur, title: String((heads[cur] || {}).textContent || '').trim().slice(0, 80) }; } catch (e) {}
      try { tutProgressSave(tid, false); } catch (e) {}
      const prog = document.getElementById('tutTocProg');
      if (prog) {
        const dd = tutDoc();
        const h = w.scrollY + w.innerHeight;
        const tot = (dd.body ? dd.body.scrollHeight : 0) || 1;
        const pct = Math.min(100, Math.round(h / tot * 100));
        prog.textContent = '阅读位置：第 ' + (cur + 1) + '/' + heads.length + ' 节 · 全文 ' + pct + '%';
      }
      try { if (!window.__tutTocRestoring) localStorage.setItem('sierxing-tut-pos-' + tid, String(cur)); } catch (e) {}
    });
  };
  w.removeEventListener('scroll', w.__tutTocScroll || (() => {}));
  w.__tutTocScroll = onScroll;
  w.addEventListener('scroll', onScroll, { passive: true });
  try { window.__tutTocWin = w; } catch (e) {}   // 记下监听挂在哪，切页时要摘掉
  onScroll();
  // 回到上次阅读位置（直接跳过去，不要平滑滚动：一进来就动画一大段很晃）
  try {
    const saved = window.__tutTocSaved || 0;
    if (saved > 0 && saved < heads.length) {
      setTimeout(() => {
        const h = tutHeadEl(saved);
        if (h) {
          const y = Math.max(0, h.getBoundingClientRect().top + w.scrollY - 110);
          try { w.scrollTo(0, y); } catch (e) { try { w.scrollTo({ top: y, behavior: 'auto' }); } catch (e2) {} }
        }
        window.__tutTocRestoring = false;
      }, 350);
    } else {
      window.__tutTocRestoring = false;
    }
  } catch (e) { window.__tutTocRestoring = false; }
}


/* ===== 教程阅读进度：滚动节流 + 切页/关页时上报，供路线图“继续学习”卡片用 ===== */
let tutProgSent = { tid: 0, idx: -1, at: 0 };
async function tutProgressSave(tid, force) {
  tid = Number(tid) || 0;
  if (!tid) return;
  const idx = (window.__tutCur && window.__tutCur.idx) || 0;
  const total = window.__tutTotal || 0;
  const now = Date.now();
  const s = tutProgSent;
  if (!force && s.tid === tid && s.idx === idx && now - s.at < 15000) return;
  s.tid = tid; s.idx = idx; s.at = now;
  try {
    await api('/api/tutorials/' + tid + '/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_idx: idx, sections_total: total })
    });
  } catch (e) {}
}
function tutProgressFlush() {
  // 离开教程页时把当前位置记上（用 NavHist 找到正被离开的教程）
  try {
    const lm = (NavHist.lastHash || '').match(/^#\/t\/(\d+)$/);
    if (!lm || ('#/t/' + lm[1]) === navCurHash()) return;
    const tid = Number(lm[1]);
    const idx = (window.__tutCur && window.__tutCur.idx) || 0;
    fetch('/api/tutorials/' + tid + '/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section_idx: idx, sections_total: window.__tutTotal || 0 })
    }).catch(() => {});
  } catch (e) {}
}
if (!window.__tutProgBound) {
  window.__tutProgBound = true;
  window.addEventListener('pagehide', () => {
    try {
      const m = (location.hash || '').match(/^#\/t\/(\d+)$/);
      if (!m || !window.__tutCur) return;
      fetch('/api/tutorials/' + m[1] + '/progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_idx: window.__tutCur.idx || 0, sections_total: window.__tutTotal || 0 }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  });
}


/* ===== 教程书签：按章节打标签（记录位置/重点，可跳回） ===== */
/* ===== 教程：让 AI 修改（全局委托，避免绑定时机问题） ===== */
const TUTEDIT_BOUND = true;
document.addEventListener('click', async e => {
  const btn = e.target.closest && e.target.closest('#tutEditBtn');
  if (!btn) return;
  const rr = parseRoute();
  if (rr.view !== 'tutorial') return;
  const t = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(rr.id));
  aiToggle(true);
  setTimeout(() => {
    const ta = document.getElementById('adText');
    if (ta) { aiRenderMode(); ta.focus(); }   // 提示语随 ASK / Agent 变，别再写死"说出你想怎么改" 
  }, 200);
});
/* ===== 教程：历史版本（查看/预览/恢复，全局委托） ===== */
document.addEventListener('click', async e => {
  const btn = e.target.closest && e.target.closest('#tutVersBtn');
  if (!btn) return;
  const rr = parseRoute();
  if (rr.view !== 'tutorial') return;
  openTutVersions(Number(rr.id));
});
/* 教程版本对比：逐行差异（LCS）。
   为什么自己写：项目零依赖；而 node 侧没这需求，只在浏览器里用。
   性能注意：教程动辄几千行，直接 O(n*m) 的 DP 会吃掉几十 MB ——
   所以先裁掉**首尾完全相同的行**，只对中间那段跑 DP，超过 120 万格就退化成
   "整段列出"（诚实标出删/增，不假装逐行对齐）。 */
function lineDiff(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  const out = [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  for (let i = 0; i < s; i++) out.push({ t: 'same', x: A[i] });
  const M = A.slice(s, ea), N = B.slice(s, eb);
  if (M.length * N.length > 1200000) {
    for (const x of M) out.push({ t: 'del', x });
    for (const x of N) out.push({ t: 'add', x });
  } else {
    const dp = [];
    for (let i = 0; i <= M.length; i++) dp.push(new Uint32Array(N.length + 1));
    for (let i = M.length - 1; i >= 0; i--) {
      for (let j = N.length - 1; j >= 0; j--) {
        dp[i][j] = M[i] === N[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < M.length && j < N.length) {
      if (M[i] === N[j]) { out.push({ t: 'same', x: M[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', x: M[i] }); i++; }
      else { out.push({ t: 'add', x: N[j] }); j++; }
    }
    while (i < M.length) out.push({ t: 'del', x: M[i++] });
    while (j < N.length) out.push({ t: 'add', x: N[j++] });
  }
  for (let k = ea; k < A.length; k++) out.push({ t: 'same', x: A[k] });
  return out;
}
/* 差异视图：连续未改动的行折起来，只留首尾两行 —— 一篇 7 万字的教程改三处，
   全列出来用户还是找不到重点。 */
function diffHTML(rows) {
  const line = r => '<div class="tutDiffLine ' + r.t + '"><span class="tutDiffSign">'
    + (r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' ') + '</span><span class="tutDiffTxt">'
    + (esc(r.x) || '&nbsp;') + '</span></div>';
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== 'same') { out.push(line(rows[i])); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].t === 'same') j++;
    const n = j - i;
    if (n <= 8) { for (let k = i; k < j; k++) out.push(line(rows[k])); }
    else {
      out.push(line(rows[i]));
      out.push(line(rows[i + 1]));
      out.push('<div class="tutDiffSkip">⋯ 未改动 ' + (n - 4) + ' 行 ⋯</div>');
      out.push(line(rows[j - 2]));
      out.push(line(rows[j - 1]));
    }
    i = j;
  }
  return out.join('');
}
function openTutVersions(tid) {
  const old = document.getElementById('tutVersDlg');
  if (old) old.remove();
  const t = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(tid));
  const isHtml = t && t.format === 'html';
  const D = document.createElement('div');
  D.className = 'bigDialog';
  D.id = 'tutVersDlg';
  D.innerHTML = `<div class="tdHead"><span class="bdTitle">🕘 历史版本<div class="bdSub">每次 AI 修改 / 手动保存都会留一版（最近 10 版）。恢复前会自动存当前版，所以恢复也可撤销。</div></span><div class="spacer" style="flex:1"></div><button class="btn tiny" data-vclose>✕</button></div>
    <div class="tdBody"><div class="muted">加载中…</div></div>`;
  document.body.appendChild(D);
  const close = () => D.remove();
  D.querySelector('[data-vclose]').addEventListener('click', close);
  D.addEventListener('mousedown', ev => { if (ev.target === D) close(); });
  document.addEventListener('keydown', function onKey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  const body = D.querySelector('.tdBody');
  const paint = async () => {
    let rows = [];
    try {
      const r = await api('/api/tutorials/' + tid + '/versions');
      rows = r.versions || [];
    } catch (err) { body.innerHTML = '<div class="muted">加载失败：' + esc(err.message) + '</div>'; return; }
    if (!rows.length) { body.innerHTML = '<div class="muted">还没有历史版本：改一次（AI 修改或手动保存）就会留一版。</div>'; return; }
    body.innerHTML = rows.map((v, i) => `<div class="tutVerRow${i === 0 ? ' cur' : ''}">
      <div class="tutVerInfo"><div class="tutVerT">${i === 0 ? '<span class="chip ok">最新</span> ' : ''}${esc(v.reason || '（无说明）')}</div>
      <div class="tutVerM">${esc(fmtDate(v.created_at))} · ${Number(v.chars) >= 1000 ? (Number(v.chars) / 1000).toFixed(1) + 'k 字' : v.chars + ' 字'}</div></div>
      <div class="spacer" style="flex:1"></div>
      <button class="btn tiny" data-vdiff="${v.id}" title="和当前版本逐行对比，看这次改了哪里">🔍 对比</button>
      <button class="btn tiny" data-vprev="${v.id}">预览</button>
      <button class="btn tiny primary" data-vrestore="${v.id}">恢复到这版</button>
    </div>`).join('');
    /* 对比：这版 → 当前版。改了什么、在哪一行，一眼能看见（用户要的就是这个） */
    body.querySelectorAll('[data-vdiff]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/tutorials/versions/' + b.getAttribute('data-vdiff'));
        const v = r.version || {};
        /* 当前正文：优先用页面里的；教程页不加载整个 goal，取不到就现问接口 */
        let cur = String((t && t.content) || '');
        if (!cur && tid) { try { cur = String((await api('/api/tutorials/' + tid + '/content')).content || ''); } catch (e) {} }
        if (!cur) { toast('拿不到当前正文，稍后再试'); return; }
        const rows = lineDiff(v.content || '', cur);
        const add = rows.filter(x => x.t === 'add').length;
        const del = rows.filter(x => x.t === 'del').length;
        body.innerHTML = `<div class="tutDiffHead">
            <button class="btn tiny" data-vback2>← 返回列表</button>
            <span class="tutDiffWhich">${esc(v.reason || '（无说明）')} · ${esc(fmtDate(v.created_at))} → <b>当前版</b></span>
            <span class="spacer" style="flex:1"></span>
            <span class="tutDiffSum"><b class="add">+${add}</b> <b class="del">−${del}</b> 行</span>
          </div>
          ${(add || del) ? `<div class="tutDiffBody">${diffHTML(rows)}</div>`
            : '<div class="muted" style="padding:14px;">这版和当前正文完全一样（可能中间又被改回或没实际改动）。</div>'}`;
        body.querySelector('[data-vback2]').addEventListener('click', paint);
      } catch (err) { toast(err.message); }
    }));
    body.querySelectorAll('[data-vprev]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/tutorials/versions/' + b.getAttribute('data-vprev'));
        const v = r.version || {};
        await ensureCiteCache(state.tutGoalId || (state.goal && state.goal.id) || 0);   // 预览正文里的 [id] 引用也要能解释
        body.innerHTML = `<button class="btn tiny" data-vback>← 返回列表</button>
          <div class="tutVerPrevMeta">${esc(v.reason || '')} · ${esc(fmtDate(v.created_at))}</div>`
          + (isHtml
            ? `<iframe class="tutFrame tutVerFrame" sandbox="allow-scripts allow-same-origin allow-popups" srcdoc=""></iframe>`
            : `<div class="tutBody mdBody">${mdToHTML(v.content || '', { viz: true })}</div>`);
        if (isHtml) {
          const fr = body.querySelector('.tutVerFrame');
          if (fr) fr.srcdoc = withCiteHook(tutThemedHTML(rewriteCites(cleanHtmlForFrame(v.content || ''))));
        }
        body.querySelector('[data-vback]').addEventListener('click', paint);
      } catch (err) { toast(err.message); }
    }));
    body.querySelectorAll('[data-vrestore]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('恢复到这版？当前版会自动存一份（“回滚前自动保存”），所以这步也可撤销。')) return;
      try {
        await api('/api/tutorials/' + tid + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version_id: Number(b.getAttribute('data-vrestore')) }) });
        close();
        toast('已恢复 ✓ 当前版已自动存档');
        try { await renderTutorialPage(tid); } catch (err) { location.reload(); }
      } catch (err) { toast(err.message); }
    }));
  };
  paint();
}
/* 重命名教程标题：只改标题不动正文。用页面内小弹窗（复用 .bigDialog 的样式，收窄成一行输入），
   不用 prompt() —— 项目里其它弹窗都是页面内的，外观才一致。
   保存成功后标题要在三处立刻跟着变：工具条上的标题、state.goal.tutorials 缓存
   （节点面板的教程列表读它）、以及渲染时那份教程对象（下载文件名读它）。 */
function openTutRename(tid, tut) {
  const old = document.getElementById('tutRenameDlg');
  if (old) old.remove();
  const span = document.getElementById('tutTitle');
  const cached = ((state.goal && state.goal.tutorials) || []).find(x => Number(x.id) === Number(tid));
  const cur = String((tut && tut.title) || (cached && cached.title) || (span ? span.textContent : '') || '').replace(/^📘\s*/, '');
  const D = document.createElement('div');
  D.className = 'bigDialog';
  D.id = 'tutRenameDlg';
  D.style.width = 'min(460px, 92vw)';
  D.style.maxHeight = 'none';
  D.innerHTML = `<div class="tdHead"><span class="bdTitle">✎ 重命名教程<div class="bdSub">只改标题，正文不动。最多 80 字，允许和别的教程重名。</div></span><div class="spacer" style="flex:1"></div><button class="btn tiny" data-rclose>✕</button></div>
    <div class="tdBody">
      <input id="tutRenameInput" type="text" maxlength="80" value="${esc(cur)}" style="width:100%; box-sizing:border-box; padding:9px 11px; font-size:14px; background:var(--bg); color:var(--text); border:1.5px solid var(--border); border-radius:10px;" />
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
        <button class="btn small" data-rclose>取消</button>
        <button class="btn small primary" id="tutRenameSave">保存</button>
      </div>
    </div>`;
  document.body.appendChild(D);
  const input = D.querySelector('#tutRenameInput');
  const close = () => D.remove();
  D.querySelectorAll('[data-rclose]').forEach(b => b.addEventListener('click', close));
  D.addEventListener('mousedown', ev => { if (ev.target === D) close(); });
  const save = async () => {
    const title = String(input.value || '').trim();
    if (!title) { toast('标题不能为空'); input.focus(); return; }
    try {
      const r = await api('/api/tutorials/' + tid + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const nt = String((r && r.title) || title);
      if (tut) tut.title = nt;
      if (cached) cached.title = nt;
      if (span) span.textContent = '📘 ' + nt;
      try { if (r && r.tutorial) state.tutUpdatedAt = r.tutorial.updated_at || state.tutUpdatedAt; } catch (e) {}
      close();
      toast('已重命名为「' + nt.slice(0, 30) + '」');
    } catch (e) { toast(e.message); }
  };
  D.querySelector('#tutRenameSave').addEventListener('click', save);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  input.focus();
  try { input.select(); } catch (e) {}
}
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
  /* ① 思考文字：只动 textContent（最便宜），且**内容没变就不写**。
     以前每个事件都无条件赋值，浏览器要为此重算这一段的布局。 */
  const think = el.querySelector('.chThink');
  if (think) {
    const txt = think.querySelector('.chThinkText');
    const want = st.thinking ? '' : 'none';
    if (think.style.display !== want) think.style.display = want;
    if (st.thinking && txt) {
      const s = st.thinking + '…' + (secs > 0 ? '（' + secs + 's）' : '');
      if (txt.textContent !== s) txt.textContent = s;
    }
  }
  /* ② 正文：只在**可见文本真的变了**时重建。
     实测在真实聊天 DOM 里整段重建 + 强制回流要 6.6ms（离屏只要 0.2ms），
     而 SSE 每秒能推 30~80 次增量 —— 每次都重建的话光渲染就吃掉半秒/秒。 */
  const body = el.querySelector('.chText');
  const vis = trimOpsForStream(st.text);
  if (body && vis && body.__vis !== vis) {
    body.__vis = vis;
    body.innerHTML = mdToHTML(vis);
  }
  const prep = el.querySelector('.chPrep');
  if (prep) {
    const want = String(st.text).indexOf('```ops') >= 0 ? '' : 'none';
    if (prep.style.display !== want) prep.style.display = want;
  }
  /* ③ 自动滚动：先读后写，且**只在用户本来贴着底部时**才滚。
     原来无条件 scrollTop=scrollHeight，每个增量都强制一次同步布局；
     而且用户想往上翻时会被一直拽回底部。 */
  const box = document.getElementById('adMsgs');
  if (box) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (stick) box.scrollTop = box.scrollHeight;
  }
}

/* 流式渲染合并（节流）。
   SSE 增量最多每秒 80 次，单次真实渲染 6.6ms —— 不合并就是"页面卡住、
   看着像没在动"。这里最多每 80ms 画一次，并**保证最后一次一定画到**
   （否则文字会停在半截）。收尾（done）时调用方仍直接调 chatRenderStream。 */
let _streamLastDraw = 0, _streamTimer = 0;
function chatRenderStreamSoon() {
  const now = Date.now();
  if (now - _streamLastDraw >= 80) { _streamLastDraw = now; chatRenderStream(); return; }
  if (_streamTimer) return;
  _streamTimer = setTimeout(() => {
    _streamTimer = 0; _streamLastDraw = Date.now();
    if (state.aiStream) chatRenderStream();
  }, 80 - (now - _streamLastDraw));
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
    <div class="adTools" id="adTools">
      <button class="adToolBtn" id="adModeBtn" aria-haspopup="true" aria-expanded="false" title="选择执行模式">
        <span class="adModeIco" id="adModeIco">💬</span><span id="adModeLabel">ASK</span><span class="adCare">▾</span>
      </button>
      <div class="adModePop" id="adModePop" hidden role="menu">
        <div class="adModePopT">执行模式</div>
        ${AI_MODES.map(m => `<button class="adModeItem" role="menuitemradio" data-aimode="${m.id}" aria-checked="false">
          <span class="adModeItemIco">${m.icon}</span>
          <span class="adModeItemTxt"><b>${esc(m.label)}</b><span class="adModeItemSub">${esc(m.short)}</span>
            <span class="adModeItemDesc">${esc(m.desc)}</span></span>
        </button>`).join('')}
        <div class="adModePopN">ASK 里 AI 改不了任何东西；要让它动手就切 Agent。</div>
      </div>
      <!-- 📝 提示词 等插件工具按钮会追加到这里（见 plugins/aiprompts.js） -->
    </div>
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
  d.querySelector('#adModeBtn').addEventListener('click', ev => {
    ev.stopPropagation();
    const pop = document.getElementById('adModePop');
    aiModePopOpen(!!(pop && pop.hidden));
  });
  d.querySelector('#adModePop').addEventListener('click', ev => {
    const it = ev.target.closest && ev.target.closest('[data-aimode]');
    if (!it) return;
    aiModeSet(it.getAttribute('data-aimode'));
    aiModePopOpen(false);
  });
  /* 点别处 / Esc 关闭。用捕获阶段 —— 面板里有不少按钮会 stopPropagation。 */
  document.addEventListener('click', ev => {
    if (!document.getElementById('adModePop')) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('#adModePop') || t.closest('#adModeBtn'))) return;
    aiModePopOpen(false);
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') aiModePopOpen(false); });
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
  if (open && !goalCompOn(goalCtx(), 'chat')) { toast('「AI 助手」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
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
/* 侧边栏绑定到某目标的会话（目标页 / 导图页 / 教程页共用；同目标不重复加载） */
async function aiBindGoal(gid) {
  if (!gid) return;
  if (state.aiGoalId !== gid) { state.aiGoalId = gid; state.aiSessionId = 0; state.aiMsgs = []; await aiLoadModels(); await aiLoadSessions(gid); }
  else aiRender();
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
  const gid = (state.goal && state.goal.id) || state.tutGoalId;
  if (!gid) return toast('请先进入一个目标');
  if (state.aiBusy) return toast('AI 正在回复，请稍候');
  try {
    const r = await api('/api/goals/' + gid + '/chat-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: state.aiModel || '' }) });
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
/* 对话栏的模型下拉：读「连接 × 已勾选模型」摊平的模型池（/api/ai/pool）。
   模型 id 是 '连接id::模型名' —— 带上连接 id 才能区分两条连接里的同名模型。
   取不到就退回旧的 /api/ai/models（裸模型名），保证旧数据仍能对话。 */
async function aiLoadModels() {
  if (state.aiModels) return;
  try {
    const r = await api('/api/ai/pool');
    if (r.pool && r.pool.length) {
      state.aiModels = r.pool.map(x => x.id);
      state.aiModelLabels = {};
      for (const x of r.pool) state.aiModelLabels[x.id] = x.label;
      state.aiPoolLoaded = true;
      return;
    }
  } catch (e) {}
  try {
    const r = await api('/api/ai/models');
    state.aiModels = r.models || [];
    state.aiModelLabels = null;
    state.aiPoolLoaded = false;
    state.aiDefaultModel = r.default || '';
  } catch (e) { state.aiModels = []; state.aiModelLabels = null; state.aiPoolLoaded = false; }
}
function aiRenderMsgs() {
  const box = document.getElementById('adMsgs');
  if (!box) return;
  const msgs = state.aiMsgs || [];
  if (!msgs.length && !state.aiStream) {
    const isTut = (typeof parseRoute === 'function' && parseRoute().view === 'tutorial');
    box.innerHTML = isTut ? `<div class="chatEmpty">
      <div class="ceIcon">📘</div>
      <div class="ceTitle">告诉我这份教程怎么改</div>
      <div class="ceText">意见会记在当前对话里（刷新也不丢），AI 在后台重写，完成后教程自动刷新。例如：<br>「第三章再展开讲讲，多给一个完整代码示例」<br>「练习换成更简单的，加一节常见报错排查」</div>
    </div>` : `<div class="chatEmpty">
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
  aiRenderMode();
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
    const labels = state.aiModelLabels || null;
    const opt = m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(labels && labels[m] ? labels[m] : m)}</option>`;
    /* 池子里为空 = 用户还没在设置里勾模型。这时不该只显示一个没用的「默认模型」，
       直接说明去哪儿勾，比让人对着一个空下拉框猜好。 */
    const dflt = state.aiDefaultModel || '';
    modelSel.innerHTML = models.length
      ? `<option value="">默认（${esc(dflt || '第一条连接的第一个模型')}）</option>` + models.map(opt).join('')
      : `<option value="">${dflt ? esc(dflt) : '尚未选择模型'}</option>`;
    modelSel.title = models.length ? '这一轮对话用哪个模型（按连接区分，可随时切换）' : '到「设置 → AI 接入方式」里勾选要用的模型';
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
/* AI 助手的工作模式（工具栏上的 ASK / Agent）。
   ask   = 只提问：**服务端**会禁掉一切 ops，AI 改不了任何东西（前端也再拦一道）
   agent = 意图识别：AI 先判断你要干什么，需要改路线图 / 改教程时才动手
   存本机 localStorage —— 这是「我这次想怎么用」，跟目标无关，不需要多端同步。
   默认 ASK：出错的方向是"没帮上忙"，而不是"把你的教程改坏了"。 */
function aiModeGet() {
  try { return localStorage.getItem('sierxing-ai-mode') === 'agent' ? 'agent' : 'ask'; } catch (e) { return 'ask'; }
}
function aiModeSet(m) {
  const v = m === 'agent' ? 'agent' : 'ask';
  const changed = state.aiMode !== v;
  state.aiMode = v;
  try { localStorage.setItem('sierxing-ai-mode', v); } catch (e) {}
  aiRenderMode();
  if (!changed) return;   // 选的是当前模式：不弹提示、不啰嗦
  toast(v === 'agent'
    ? '已切到 Agent：AI 会先判断你的意图，需要改路线图 / 改教程时才动手'
    : '已切到 ASK：只回答、不改动，AI 不会修改任何东西');
}
/* 模式相关的界面：按钮选中态 + 输入框提示语（教程页与目标页的提示语不同） */
/* 菜单开合（按钮、菜单项、说明都由 AI_MODES 生成） */
function aiModePopOpen(on) {
  const pop = document.getElementById('adModePop');
  const btn = document.getElementById('adModeBtn');
  if (!pop || !btn) return;
  pop.hidden = !on;
  btn.classList.toggle('open', !!on);
  btn.setAttribute('aria-expanded', on ? 'true' : 'false');
}
function aiRenderMode() {
  if (state.aiMode !== 'ask' && state.aiMode !== 'agent') state.aiMode = aiModeGet();
  const m = state.aiMode === 'agent' ? 'agent' : 'ask';
  state.aiMode = m;
  const cur = AI_MODES.find(x => x.id === m) || AI_MODES[0];
  const ico = document.getElementById('adModeIco');
  if (ico) ico.textContent = cur.icon;
  const lab = document.getElementById('adModeLabel');
  if (lab) lab.textContent = cur.label;
  const btn = document.getElementById('adModeBtn');
  if (btn) btn.title = '执行模式：' + cur.label + ' —— ' + cur.desc + '（点击切换）';
  const pop = document.getElementById('adModePop');
  if (pop) {
    for (const it of pop.querySelectorAll('[data-aimode]')) {
      const on = it.getAttribute('data-aimode') === m;
      it.classList.toggle('on', on);
      it.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  const ta = document.getElementById('adText');
  if (!ta) return;
  let onTut = false;
  try { onTut = parseRoute().view === 'tutorial'; } catch (e) {}
  ta.placeholder = m === 'ask'
    ? (onTut ? 'ASK 模式 · 问这份教程的任何问题（不会修改它）。要改就切到 Agent。'
             : 'ASK 模式 · 问规划 / 资料 / 进度，AI 只回答、不改动。要改就切到 Agent。')
    : (onTut ? 'Agent 模式 · 说你想怎么改这份教程（也可以直接提问，它会先判断），例如：1.2 ReAct 那节再展开讲讲'
             : 'Agent 模式 · 可以让它：改路线图 / 把这段资料存进资料库 / 提炼全部资料 / 再收集些资料 / 加一条约束 / 改目标现状与时间');
}
/* 把一条修改意见交给教程修改任务。两条来源共用：
   ① Agent 模式下 AI 判断出「用户要改教程」→ ops 里的 tutorial_edit
   ② 之后别的入口要重跑 */
async function submitTutorialEdit(tid, feedback) {
  const id = Number(tid || 0), fb = String(feedback || '').trim();
  if (!id || !fb) { toast('修改意见为空，没有提交'); return; }
  try {
    await api('/api/tutorials/' + id + '/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      /* quiet：这句话与 AI 的回复已经记在对话里了，让服务端别再插一份
         「【教程修改 · …】」和那条固定回执，否则对话变成一叠重复。 */
      body: JSON.stringify({ feedback: fb, session_id: state.aiSessionId || 0, quiet: true })
    });
    await aiLoadMsgs();          // 把服务端刚落库的"已受理"回执读出来
    toast('🤖 已提交教程修改任务（完成后会自动刷新，结果也会写回对话）');
    taskPoll();
  } catch (e) { toast('提交失败：' + e.message); }
}
async function aiSend() {
  if (state.aiBusy) return;
  // 教程页：消息作为修改意见，交给后台任务重写教程（记录记入当前会话，刷新也不丢；完成后自动刷新渲染）
  /* ⚠️ 这里以前是「只要在教程页，任何消息都当修改意见发出去」—— 用户只是想问一句，
     教程却被重写了。现在两种模式都走**同一个对话接口**，靠 mode 分流：
       ASK   → 服务端丢掉一切 ops，纯回答
       Agent → AI 先判断意图，真要改教程时才回 tutorial_edit，前端再开后台任务
     教程页仍要把会话绑到教程所属目标，所以先做这一步。 */
  const rrTut = parseRoute();
  const onTut = rrTut.view === 'tutorial';
  if (onTut) {
    const gidT = state.tutGoalId || (state.goal && state.goal.id);
    if (!gidT) { toast('教程对应的目标不存在'); return; }
    if (state.aiGoalId !== gidT) { state.aiGoalId = gidT; state.aiSessionId = 0; state.aiMsgs = []; await aiLoadModels(); await aiLoadSessions(gidT); }
  }
  if (!(await ensureAIConfigured())) return;
  const ta = document.getElementById('adText');
  const msg = (ta && ta.value || '').trim();
  if (!msg) return;
  const gid = state.aiGoalId || (state.goal && state.goal.id) || state.tutGoalId || 0;
  if (!gid) return toast('请先进入一个目标');
  if (!state.aiSessionId) {
    if (onTut) { toast('对话初始化失败，请刷新后重试'); return; }
    await aiNewSession();
  }
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
    const resp = await fetch('/api/chat-sessions/' + state.aiSessionId + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, mode: state.aiMode === 'ask' ? 'ask' : 'agent', tutorial_id: onTut ? Number(rrTut.id) : 0 }), signal: state.aiAbort.signal });
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
        /* 走节流版：这些回调每秒可能触发 30~80 次 */
        if (d.thinking && state.aiStream) { state.aiStream.thinking = d.thinking; chatRenderStreamSoon(); }
        if (d.text && state.aiStream) { state.aiStream.text += d.text; state.aiStream.thinking = ''; chatRenderStreamSoon(); }
        if (d.status && state.aiStream) { state.aiStream.thinking = d.status; chatRenderStreamSoon(); }
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
                else if (st.action === 'tutorial_edit') submitTutorialEdit(st.tutorial_id, st.feedback);
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
/* 关联文件夹对话框：填绝对路径 → 预览确认 → 挂到本节点 */
function showFolderDialog(nodeId, onDone) {
  const old = document.getElementById('folderDialog');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'folderDialog';
  div.className = 'tutDialog';
  div.innerHTML = `
    <div class="tdHead"><span>📁</span><span>关联文件夹到本节点</span><button class="btn tiny" id="fdX">×</button></div>
    <div class="tdBody">
      <p class="hint" style="margin:2px 0 10px;">挂上去后，<b>本节点和它的子节点</b>在规划、拆分、生成教程时会自动读这个文件夹（文件清单 + README + 按需读代码）；其它分支的节点看不到。只读不写，磁盘文件不会动。</p>
      <div class="field"><input type="text" id="fdPath" placeholder="绝对路径，例如 /home/xxx/ragflow" autocomplete="off" spellcheck="false"></div>
      <div class="toolbarRow"><button class="btn small" id="fdPreview">👁 预览里面有什么</button><span class="muted" id="fdPrevMsg"></span></div>
      <div class="tdCodeList" id="fdPrevList" style="margin-top:8px;"></div>
      <div class="field" style="margin-top:10px;"><input type="text" id="fdName" placeholder="名称（可选，默认用文件夹名，例如 RAGFlow 源码）"></div>
      <div class="field"><input type="text" id="fdNote" placeholder="说明（可选，例如 结合这份源码讲整体架构）"></div>
      <div class="toolbarRow" style="margin-top:10px;">
        <button class="btn primary" id="fdOk">挂到本节点</button>
        <button class="btn" id="fdCancel">取消</button>
      </div>
      <div class="hint" id="fdMsg" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#fdX').addEventListener('click', close);
  div.querySelector('#fdCancel').addEventListener('click', close);
  const msg = m => { div.querySelector('#fdMsg').textContent = m || ''; };
  div.querySelector('#fdPreview').addEventListener('click', async () => {
    const p = div.querySelector('#fdPath').value.trim();
    if (!p) return toast('先填路径');
    div.querySelector('#fdPrevMsg').textContent = '读取中…';
    try {
      const r = await api('/api/node-folders/preview?path=' + encodeURIComponent(p));
      div.querySelector('#fdPrevMsg').textContent = '';
      div.querySelector('#fdPrevList').innerHTML = `<div class="muted" style="margin-bottom:6px;">共 ${r.total} 个可读文件${r.hasReadme ? '（有 README）' : ''}：</div>` +
        (r.top.length ? r.top.slice(0, 15).map(f => `<div class="tdCodeItem"><span class="tdCodeName">${esc(f.path)}</span></div>`).join('') : '<span class="muted">空目录或没有可读文件</span>');
      if (!div.querySelector('#fdName').value.trim()) div.querySelector('#fdName').value = p.split('/').filter(Boolean).pop() + ' 源码';
    } catch (e) {
      div.querySelector('#fdPrevMsg').textContent = '';
      msg('预览失败：' + e.message);
    }
  });
  div.querySelector('#fdOk').addEventListener('click', async () => {
    const p = div.querySelector('#fdPath').value.trim();
    if (!p) return toast('先填路径');
    msg('挂载中…');
    try {
      const r = await api('/api/nodes/' + nodeId + '/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, name: div.querySelector('#fdName').value.trim(), note: div.querySelector('#fdNote').value.trim() }) });
      state.goal = r.goal;
      close();
      toast('已挂到本节点 ✓ 本节点和子节点可用');
      if (onDone) onDone();
    } catch (e) { msg(e.message); }
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
      <p class="hint" style="margin:2px 0 10px;">教程以「真正掌握知识点」为目标：讲原理 → 分步实践（含自检与排错）→ 练习 → 掌握自测清单。<b>文字讲解用 Markdown，纯文字讲不清的地方（数据结构、流程分步、协议时序、前后对比等）AI 会自己嵌一段能点能动的演示页面。</b>生成约需 1-3 分钟。</p>
      <div class="field"><textarea id="tdNote" placeholder="补充要求（可选）：例如 我完全零基础请讲慢一点 / 多给可复制的代码 / 侧重面试常问点 / 流程部分要能一步步点着看…"></textarea></div>
      <div class="tdFolders muted" id="tdFolders">正在看本节点有没有挂文件夹（不勾则 AI 自动挑着读）…</div>
      <details class="tdCode" id="tdCodeBox">
        <summary>📂 结合项目源码讲解（可选，只读；data/.env/.git 等不会列出）</summary>
        <div class="tdCodeBody">
          <input id="tdCodeSearch" placeholder="🔍 筛选文件（敲文件名关键字，挂载的文件夹和本程序都筛）" autocomplete="off">
          <div class="tdCodeHint muted">勾选后教程会对照真实代码讲（类名/调用链要对得上）。单文件最多 24KB，共最多 60KB。<b>不勾也行：生成时 AI 会自己看文件清单挑要读的。</b></div>
          <div id="tdFolderFiles"></div>
          <div class="tdCodeList" id="tdCodeList"><span class="muted">展开后加载…</span></div>
          <div class="tdCodeSel muted" id="tdCodeSel"></div>
        </div>
      </details>
    </div>
    <div class="tdFoot">
      <button class="btn primary" id="tdGo">生成图文教程</button>
      <div class="muted tdFmtHint">正文用 Markdown 写，需要可视化演示的地方 AI 会自己嵌一段活的 HTML —— 按内容自行判断，不用你选。</div>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  const note = () => (document.getElementById('tdNote').value || '').trim();
  /* 收集器：本程序文件回传路径字符串；挂载文件夹的文件回传 {root, path}，
     服务端会校验 root 确实是本节点挂载过的文件夹（防客户端伪造 root 读任意目录） */
  const codeFiles = () => Array.from(div.querySelectorAll('[data-codefile]:checked')).map(x => {
    const root = x.getAttribute('data-coderoot') || '';
    const p = x.getAttribute('data-codefile') || '';
    return root ? { root, path: p } : p;
  });
  // 源码清单懒加载 + 本地筛选（只进过一次网络）
  let codeLoaded = false;
  const codeBox = div.querySelector('#tdCodeBox');
  const paintCodeList = files => {
    const q = ((div.querySelector('#tdCodeSearch') || {}).value || '').trim().toLowerCase();
    const show = files.filter(f => !q || f.path.toLowerCase().includes(q)).slice(0, 300);
    const fmtKB = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
    div.querySelector('#tdCodeList').innerHTML = show.length ? show.map(f =>
      `<label class="tdCodeItem"><input type="checkbox" data-codefile="${esc(f.path)}"><span class="tdCodeName">${esc(f.path)}</span><span class="muted">${fmtKB(f.size)}</span></label>`
    ).join('') : '<span class="muted">没有匹配的文件，换个关键字试试。</span>';
    div.querySelectorAll('[data-codefile]').forEach(c => c.addEventListener('change', () => {
      const n = codeFiles().length;
      div.querySelector('#tdCodeSel').textContent = n ? `已选 ${n} 个文件` : '';
    }));
  };
  /* 挂载文件夹的文件：按夹分组排在本程序清单前面，同样走 data-codefile 复选 */
  const fmtKB2 = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
  const paintFolderFiles = (groups) => {
    const host = div.querySelector('#tdFolderFiles');
    if (!host) return;
    const q = ((div.querySelector('#tdCodeSearch') || {}).value || '').trim().toLowerCase();
    host.innerHTML = groups.map(g => {
      const show = g.files.filter(f => !q || f.path.toLowerCase().includes(q)).slice(0, 300);
      return `<div class="tdFolderGrp"><div class="tdFolderHd">📁 ${esc(g.name)}<span class="muted">（${g.files.length} 个可读文件${g.files.length > 300 ? '，只列前 300，用上面搜索框筛' : ''}）</span></div>
        <div class="tdCodeList">${show.length ? show.map(f =>
          `<label class="tdCodeItem"><input type="checkbox" data-codefile="${esc(f.path)}" data-coderoot="${esc(g.root)}"><span class="tdCodeName">${esc(f.path)}</span><span class="muted">${fmtKB2(f.size)}</span></label>`
        ).join('') : '<span class="muted">没有匹配的文件，换个关键字试试。</span>'}</div></div>`;
    }).join('');
    host.querySelectorAll('[data-codefile]').forEach(c => c.addEventListener('change', () => {
      const n = codeFiles().length;
      div.querySelector('#tdCodeSel').textContent = n ? `已选 ${n} 个文件` : '';
    }));
  };
  const loadFolderFiles = async () => {
    let groups = [];
    try {
      const r = await api('/api/nodes/' + nodeId + '/folders');
      const fs2 = (r.folders || []).filter(f => !f.missing);
      groups = [];
      for (const f of fs2) {
        try {
          const fr = await api('/api/node-folders/files?path=' + encodeURIComponent(f.path));
          groups.push({ name: f.name + (f.inherited ? '‹继承›' : ''), root: fr.dir, files: fr.files || [] });
        } catch (e) { groups.push({ name: f.name + '（读不出来：' + e.message + '）', root: f.path, files: [] }); }
      }
      state.tdFolderFiles = groups;
    } catch (e) { state.tdFolderFiles = []; }
    paintFolderFiles(state.tdFolderFiles || []);
  };
  codeBox.addEventListener('toggle', async () => {
    if (!codeBox.open || codeLoaded) return;
    codeLoaded = true;
    loadFolderFiles();
    const box = div.querySelector('#tdCodeList');
    try {
      const r = await api('/api/code/files');
      state.tdCodeFiles = r.files || [];
      paintCodeList(state.tdCodeFiles);
    } catch (e) { box.innerHTML = '<span class="muted">清单加载失败：' + esc(e.message) + '</span>'; }
  });
  const codeSearch = div.querySelector('#tdCodeSearch');
  if (codeSearch) codeSearch.addEventListener('input', () => { paintCodeList(state.tdCodeFiles || []); paintFolderFiles(state.tdFolderFiles || []); });
  /* 只剩一个入口：以前分开「生成 HTML」「生成 Markdown」两个按钮，
     但 Markdown 教程现在能自己嵌可视化块（```viz → 沙箱里跑活的 HTML），
     两种诉求（文字讲透 / 生动演示）一份文档就能同时满足，
     格式选哪边交给 AI 按内容判断 —— 再让用户手选反而容易选错一边、牺牲另一边。 */
  div.querySelector('#tdGo').addEventListener('click', () => { const v = note(), cf = codeFiles(); close(); startTutorial(nodeId, 'md', v, cf, withFolders()); });
  div.querySelector('#tdX').addEventListener('click', close);
  /* 本节点（含祖先继承）挂的文件夹：默认一起带上讲，对 RAGFlow 这种源码学习节点最有用 */
  const withFolders = () => {
    const c = div.querySelector('#tdWithFolders');
    return !c || c.checked;
  };
  (async () => {
    const box = div.querySelector('#tdFolders');
    if (!box) return;
    try {
      const r = await api('/api/nodes/' + nodeId + '/folders');
      const fs2 = r.folders || [];
      box.innerHTML = fs2.length
        ? `<label class="tdFolderCheck"><input type="checkbox" id="tdWithFolders" checked> <span>📁 附带文件夹源码一起讲（${fs2.length} 个：${fs2.map(f => esc(f.name) + (f.inherited ? '‹继承›' : '')).join('、').slice(0, 90)}）</span></label>`
        : '<span>没挂文件夹：去节点面板「关联文件夹」把源码目录挂上，教程会自动对照代码讲</span>';
    } catch (e) { box.innerHTML = '<span>文件夹状态读取失败，不影响生成</span>'; }
  })();
}
async function startTutorial(nodeId, format, note, codeFiles, withFolders) {
  if (!goalCompOn(goalCtx(), 'tutorial')) { toast('「学习教程」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
  if (state.tutoring || state.planning || state.collecting || state.expanding) return;
  state.tutoring = true;
  state.tutStatus = '正在撰写图文教程（文字用 Markdown，需要演示的地方 AI 会自己嵌活的 HTML）…';
  rerenderCurrent();
  try {
    const resp = await fetch('/api/nodes/' + nodeId + '/tutorial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, note: note || '', codeFiles: codeFiles || [], withFolders: withFolders !== false }) });
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

/* ===================== 教程正文的「标签卡片」 =====================
   教程是按固定骨架生成的：做什么 → 为什么这样做 → 具体怎么做 → 预期结果/如何自检 →
   常见错误与排查 …。模型每次都会把这些标签写成 `**标签**` 单独一段。
   但它们渲染出来只是一行加粗字，跟正文没区别 —— 于是整篇看起来就是"一大坨文字，
   抓不到重点"（用户的原话）。
   这里把「标签段 + 它后面紧跟的内容」识别出来，包成带图标和颜色的卡片。
   纯渲染层处理：不用改提示词，**已有的老教程也能立刻受益**。 */
const CALL_LABELS = [
  { re: /^(做什么|怎么做|具体怎么做|操作步骤|动手做)$/, cls: 'step', icon: '🛠', name: '做什么' },
  { re: /^(为什么(这样做|这么做|要这样)?|原因|原理)$/, cls: 'why', icon: '💡', name: '为什么这样做' },
  { re: /^(预期结果|预期结果如何自检|如何自检|怎么自检|自检|自检方法|验证方法)$/, cls: 'check', icon: '✅', name: '预期结果 / 如何自检' },
  { re: /^(常见错误与排查|常见错误|常见问题|排错|排查|避坑|坑|踩坑|陷阱)$/, cls: 'warn', icon: '⚠️', name: '常见错误与排查' },
  { re: /^(重点|重点与坑|关键点|核心|要点|记住)$/, cls: 'key', icon: '⭐', name: '重点' },
  { re: /^(注意|提示|小技巧|技巧|经验|贴士|建议)$/, cls: 'tip', icon: '📌', name: '提示' },
  { re: /^(面试官会问|面试高频追问|面试高频|面试追问|可能会被问|面试怎么答)$/, cls: 'iv', icon: '🎤', name: '面试会问' },
  { re: /^(验收标准|完成标准|做到什么程度算完成)$/, cls: 'goal', icon: '🎯', name: '验收标准' }
];
const calloutNorm = s => String(s || '').replace(/[\s　]/g, '').replace(/[：:。，,、/／]+$/, '');
/* 主标签：再次出现就意味着"换了一组"（换了一步、换了一条错误清单）。
   辅助标签（为什么这样做 / 预期结果 / 提示）可以在同一组里重复。 */
const PRIMARY_KINDS = { step: 1, warn: 1, goal: 1, iv: 1 };
/* 一个段落片段是不是「**标签**：正文」这种形态。
   ⚠️ 实际语料里标签**九成和正文同段**（"**做什么**：找一个 Skill 目录…"），
   独占一段的反而是少数。只认独占形态的话卡片一个都出不来 —— 实测过。 */
function calloutOf(seg) {
  const m = String(seg || '').match(/^<strong>([\s\S]{1,26}?)<\/strong>\s*[：:]?\s*([\s\S]*)$/);
  if (!m) return null;
  const key = calloutNorm(m[1].replace(/[\/／]/g, ''));
  if (!key) return null;
  for (const L of CALL_LABELS) if (L.re.test(key)) return { kind: L, label: m[1].trim(), value: String(m[2] || '').trim() };
  return null;
}
/* 把 HTML 切成**顶层块**。不能拿正则偷懒（`<ul>` 里有嵌套 `<ul>`，
   惰性匹配会在内层 `</ul>` 就停住，把列表腰斩），所以按同名标签计数配对。 */
function tutSplitBlocks(html) {
  const out = [];
  const OPEN = /^<(h[1-6]|p|ul|ol|pre|table|blockquote|div|hr|figure)\b/i;
  let i = 0, guard = 0;
  while (i < html.length && guard++ < 20000) {
    const m = OPEN.exec(html.slice(i));
    if (!m) { const rest = html.slice(i); if (rest.trim()) out.push(rest); break; }
    if (m.index > 0) {
      const pre = html.slice(i, i + m.index);
      if (pre.trim()) out.push(pre);
      i += m.index;
    }
    const tag = m[1].toLowerCase();
    if (tag === 'hr') { const e = html.indexOf('>', i); out.push(html.slice(i, e + 1)); i = e + 1; continue; }
    const scan = new RegExp('<' + tag + '\\b|</' + tag + '\\s*>', 'gi');
    scan.lastIndex = i;
    let depth = 0, end = -1, mm;
    while ((mm = scan.exec(html))) {
      if (mm[0][1] === '/') { depth--; if (depth <= 0) { end = mm.index + mm[0].length; break; } }
      else depth++;
      if (depth > 300) break;
    }
    if (end < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, end));
    i = end;
  }
  return out;
}
/* 把标签包装成「行」：连续的标签行合成一张卡片，一行一个标签。
   读起来就是一张对照表 —— 做什么 / 为什么这样做 / 预期结果各占一行，
   比原来"整段加粗字混在正文里"清楚得多。 */
function tutGroupCallouts(html) {
  const blocks = tutSplitBlocks(html);
  const out = [];
  let card = null;
  const flush = () => {
    if (!card || !card.rows.length) { card = null; return; }
    /* ⚠️ 类名必须带 mdc- 前缀：直接叫 step / warn 会撞上项目里已有的全局类
       （.step 是 18×18 的步骤徽标：圆形 + 白字），于是卡片行被压成一个小圆点、
       内容变成白字白底彻底看不见 —— 实测翻过这个车。 */
    out.push('<div class="mdCall">' + card.rows.map(r =>
      '<div class="mdCallRow mdc-' + r.cls + '"' + (r.attr || '') + '>'
      + '<div class="mdCallK"><span class="mdCallIcon">' + r.icon + '</span>' + r.label + '</div>'
      + '<div class="mdCallV">' + (r.html || '') + '</div>'
      + '</div>').join('') + '</div>');
    card = null;
  };
  const lastOpen = () => card && card.rows.length && !card.rows[card.rows.length - 1].html;
  for (const b of blocks) {
    /* 标题和分隔线是硬边界：卡片不跨章节 */
    if (/^<h[1-6]\b/i.test(b) || /^<hr/i.test(b)) { flush(); out.push(b); continue; }
    if (/^<p\b/i.test(b)) {
      /* ⚠️ 这里原来写死 /^<p>/，段落一旦带上 data-src（`<p data-src="865">`）就剥不掉前缀，
         接着 calloutOf 认不出标签 → 卡片不再成形（渲染会变）。改成认「带任意属性的 <p …>」。
         并把段落的属性搬到卡片行上：内容进了卡片后 <p> 外壳就没了，不搬的话
         「点哪儿改哪儿」找不到这块对应哪段源码（见 mdPickTarget）。 */
      const pm = b.match(/^<p\b([^>]*)>/);
      const pAttr = pm ? pm[1] : '';
      const inner = b.replace(/^<p\b[^>]*>/, '').replace(/<\/p>$/, '');
      const segs = inner.split('<br>');
      if (calloutOf(segs[0])) {
        if (!card) card = { rows: [] };
        if (card.rows.length >= 10) flush();
        if (!card) card = { rows: [] };
        let cur = null;
        for (const seg of segs) {
          const c = calloutOf(seg);
          if (c) {
            if (cur) card.rows.push(cur);
            /* 「做什么」这类**主标签**再次出现 = 换了一步，另起一张卡。
               不然整节会并成一张十行的巨卡，反而看不出有几步（实测过）。 */
            if (PRIMARY_KINDS[c.kind.cls] && card.rows.some(r => r.cls === c.kind.cls)) {
              flush();
              card = { rows: [] };
            }
            cur = { label: c.label, cls: c.kind.cls, icon: c.kind.icon, html: c.value, attr: pAttr };
          } else if (cur) {
            cur.html = (cur.html ? cur.html + '<br>' : '') + seg;
          }
        }
        if (cur) card.rows.push(cur);
        continue;
      }
      /* 普通段落：卡片最后一行还没内容 → 当作它的内容（"**做什么**" 独占一段的写法） */
      if (lastOpen()) { card.rows[card.rows.length - 1].html = b; continue; }
      flush();
      out.push(b);
      continue;
    }
    /* 列表 / 代码块 / 表格：同样可以当上一行的内容 */
    if (lastOpen()) { card.rows[card.rows.length - 1].html = b; continue; }
    flush();
    out.push(b);
  }
  flush();
  return out.join('');
}

/* ===== 零依赖语法高亮 =====
   为什么自己写：本项目是零依赖 + 离线可用（本机 exe、内网也能跑），引 CDN 会让
   没网的机器白屏，引 npm 依赖又违反零依赖纪律。规模上也不需要通用引擎 ——
   实测线上 2349 个代码块里 99% 就是下面这十几种语言。
   做法：每种语言一条**合并正则**（注释|字符串|数字|关键字|内置|变量…），
   一次线性扫描，匹配之外的原样转义。没有回溯风险、不会死循环 ——
   mdToHTML 那条路被正则回溯坑过一次（AGENTS.md 第 13 条），这里不重蹈。
   ⚠️ 加新语言时：每个分支都必须至少吃掉 1 个字符，否则 exec 会原地打转。 */
const HL_LANGS = {
  python: () => /(?<cm>#[^\n]*)|(?<st>[rbfuRBFU]{0,2}(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"))|(?<nu>\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?\b)|(?<kw>\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b)|(?<bi>\b(?:print|len|range|str|int|float|list|dict|set|tuple|bool|open|sum|min|max|abs|enumerate|zip|sorted|reversed|isinstance|type|input|super|self|cls|Exception|ValueError|KeyError|TypeError|IndexError|AttributeError|RuntimeError|StopIteration|__init__|__name__|__main__)\b)/g,
  bash: () => /(?<cm>#[^\n]*)|(?<st>'(?:[^'\n])*'|"(?:\\.|[^"\\\n])*")|(?<va>\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])|(?<nu>\b\d+\b)|(?<kw>\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|export|local|source|set|unset|read|exit|shift|trap|eval|exec|declare|printf|echo|cd|ls|cat|grep|egrep|sed|awk|cut|sort|uniq|head|tail|wc|find|xargs|curl|wget|git|npm|npx|pnpm|yarn|pip|pip3|python|python3|node|docker|docker-compose|kubectl|make|mkdir|rm|rmdir|cp|mv|touch|chmod|chown|sudo|apt|apt-get|brew|systemctl|service|ssh|scp|tar|zip|unzip|jq|tee|tr|diff|which|env)\b)/g,
  json: () => /(?<st>"(?:\\.|[^"\\])*")|(?<nu>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<kw>\b(?:true|false|null)\b)/g,
  yaml: () => /(?<cm>#[^\n]*)|(?<st>'(?:[^'\n])*'|"(?:\\.|[^"\\\n])*")|(?<at>^[ \t]*-?[ \t]*[A-Za-z_][\w.-]*(?=\s*:))|(?<nu>\b-?\d+(?:\.\d+)?\b)|(?<kw>\b(?:true|false|null|yes|no|on|off|~)\b)/gm,
  sql: () => /(?<cm>--[^\n]*|\/\*[\s\S]*?\*\/)|(?<st>'(?:''|[^'\n])*')|(?<nu>\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|UNIQUE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|IN|LIKE|BETWEEN|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|UNION|ALL|EXISTS|IS|ASC|DESC|WITH|BEGIN|COMMIT|ROLLBACK|TRANSACTION|IF|EXPLAIN|ANALYZE|PRAGMA|INTEGER|TEXT|REAL|BLOB|NUMERIC|VARCHAR|BOOLEAN|TIMESTAMP|PRIMARY|AUTOINCREMENT)\b)/gi,
  js: () => /(?<cm>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<st>`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(?<nu>\b\d+(?:\.\d+)?(?:n)?\b|0[xX][0-9a-fA-F]+)|(?<kw>\b(?:await|async|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|yield|interface|type|enum|implements|readonly|public|private|declare|as|satisfies)\b)|(?<bi>\b(?:true|false|null|undefined|NaN|Infinity|console|window|document|JSON|Object|Array|String|Number|Boolean|Promise|Map|Set|Date|Math|RegExp|Error)\b)/g,
  markdown: () => /(?<cm>^\s*>.*$)|(?<st>`[^`\n]+`|```[\s\S]*?```)|(?<kw>^#{1,6}[^\n]*$)|(?<bi>\*\*[^*\n]+\*\*)|(?<nu>^\s*(?:[-*+]|\d+\.)\s)/gm,
  powershell: () => /(?<cm>#[^\n]*)|(?<st>'(?:''|[^'\n])*'|"(?:`"|[^"\n])*")|(?<va>\$[A-Za-z_][\w:]*|\$\{[^}\n]*\})|(?<nu>\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:function|param|if|else|elseif|foreach|for|while|do|until|switch|return|break|continue|try|catch|finally|throw|begin|process|end|filter|in|not|and|or|Write-Host|Write-Output|Get-ChildItem|Get-Content|Set-Content|New-Item|Remove-Item|Test-Path|Join-Path|Select-Object|Where-Object|ForEach-Object|\$true|\$false|\$null)\b)/gi,
  dockerfile: () => /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\\n])*"|'(?:[^'\n])*')|(?<kw>^\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|HEALTHCHECK|SHELL|AS)\b)|(?<va>\$\{?[\w]+\}?)/gim,
  nginx: () => /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\\n])*"|'(?:[^'\n])*')|(?<kw>^\s*(?:server|location|upstream|events|http|include|listen|server_name|root|index|proxy_pass|proxy_set_header|rewrite|return|add_header|try_files|gzip|ssl_certificate|ssl_certificate_key|client_max_body_size|access_log|error_log|worker_processes)\b)|(?<va>\$[\w]+)/gim,
  html: () => /(?<cm>&lt;!--[\s\S]*?--&gt;|<!--[\s\S]*?-->)|(?<st>"[^"]*"|'[^']*')|(?<kw><\/?[A-Za-z][\w:-]*|\/?>)|(?<at>\b[A-Za-z-]+(?==))/g,
  css: () => /(?<cm>\/\*[\s\S]*?\*\/)|(?<st>"[^"\n]*"|'[^'\n]*')|(?<nu>#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|fr|deg)?\b)|(?<at>^[ \t]*[.#][\w-]+|@[\w-]+|::?[\w-]+)|(?<kw>\b(?:var|calc|rgb|rgba|hsl|url|linear-gradient|radial-gradient|flex|grid|absolute|relative|fixed|sticky|none|block|inline)\b)/gm,
  cpp: () => /(?<cm>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<pp>^\s*#\s*\w+)|(?<st>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<nu>\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:auto|bool|break|case|catch|char|class|const|constexpr|continue|default|delete|do|double|else|enum|explicit|extern|false|float|for|friend|if|inline|int|long|namespace|new|nullptr|operator|private|protected|public|return|short|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|using|virtual|void|volatile|while|std|string|vector|map|set|cout|cin|endl|printf|size_t)\b)/g,
  toml: () => /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\\n])*"|'(?:[^'\n])*')|(?<kw>^[ \t]*\[+[^\]]+\]+)|(?<at>^[ \t]*[\w.-]+(?=\s*=))|(?<nu>\b\d+(?:\.\d+)?\b)|(?<bi>\b(?:true|false)\b)/gm,
  csv: () => /(?<st>^[^\n,]*)/gm
};
/* 类型别名 → 上面某一种 */
const HL_ALIAS = {
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', powershell: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js', mjs: 'js', cjs: 'js',
  yml: 'yaml', md: 'markdown', docker: 'dockerfile', 'docker-file': 'dockerfile',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  cxx: 'cpp', cc: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp', java: 'cpp', go: 'cpp', rust: 'cpp', rs: 'cpp', kotlin: 'cpp', swift: 'cpp', cs: 'cpp', csharp: 'cpp',
  ini: 'toml', conf: 'toml', cfg: 'toml',
  sqlite: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql'
};
/* 没标语言的块：只在**信号很强**时才猜，猜错比不猜更烦人。
   目录树（├──）、纯输出、列表这类一律不猜，原样显示。 */
function hlGuessLang(code) {
  const s = String(code || '');
  if (!s.trim()) return '';
  if (/^\s*[\{\[]/.test(s)) { try { JSON.parse(s); return 'json'; } catch (e) {} }
  if (/[├└]──|^\s*\.{1,2}\/\s*$/m.test(s)) return '';                 // 目录树/路径列表
  const py = (s.match(/\b(?:def|import|from|class|elif|lambda|print)\b/g) || []).length;
  const sh = (s.match(/^\s*(?:\$ |(?:npm|npx|pnpm|yarn|pip|pip3|python3?|git|docker|curl|wget|cd|ls|mkdir|cat|export|source|apt|brew|sudo|make|node)\b)/gm) || []).length;
  const yamlKv = (s.match(/^\s*[\w.-]+:\s*\S/gm) || []).length;
  if (sh >= 2 && sh >= py) return 'bash';
  if (py >= 2) return 'python';
  if (yamlKv >= 3) return 'yaml';
  return '';
}
function hlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 把一段源码变成带 <span class="tk-xx"> 的 HTML。
   ⚠️ 兜底：万一某个分支能匹配空串，exec 会原地打转 —— 用 m.index===lastIndex 时
   强制 lastIndex+1 顶出去，再配一个上限计数，绝不让它卡住标签页。 */
function hlCode(code, lang) {
  const raw = String(code == null ? '' : code);
  const key = HL_ALIAS[String(lang || '').toLowerCase()] || String(lang || '').toLowerCase();
  if (!HL_LANGS[key]) return hlEscape(raw);
  const re = HL_LANGS[key]();
  let out = '', last = 0, m, guard = 0;
  const LIMIT = raw.length + 1000;
  while ((m = re.exec(raw)) && guard++ < LIMIT) {
    if (re.lastIndex === m.index) { re.lastIndex = m.index + 1; continue; }   // 防原地打转
    if (m.index > last) out += hlEscape(raw.slice(last, m.index));
    const g = m.groups || {};
    const cls = g.cm ? 'tk-cm' : g.st ? 'tk-st' : g.nu ? 'tk-nu' : g.va ? 'tk-va'
      : g.kw ? 'tk-kw' : g.bi ? 'tk-bi' : g.pp ? 'tk-pp' : g.at ? 'tk-at' : '';
    out += cls ? '<span class="' + cls + '">' + hlEscape(m[0]) + '</span>' : hlEscape(m[0]);
    last = m.index + m[0].length;
  }
  if (last < raw.length) out += hlEscape(raw.slice(last));
  return out;
}
/* 放进 HTML 属性里的转义（srcdoc 要整段 HTML 塞进双引号属性） */
function mdEscapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 可视化块：给 AI 写的 HTML 补一段「上报自己多高」的脚本。
   沙箱 iframe 拿不到父页面，只能用 postMessage 把高度传出来；
   外层 mdVizResize 按 event.source 对上号再设高度 —— 于是图表/动画多高就显示多高，
   不会出现固定高度里被裁一刀。 */
function vizSrcdoc(code) {
  /* ⚠️ 不能拿 documentElement.offsetHeight / scrollHeight 当高度：它们至少等于 iframe
     视口高度，而视口高度又由外层设的那个值决定 —— 会锁死在一个值上（实测永远 338）。
     改成逐个量 body 直接子元素的底边，取最大值再加下内边距，才是内容真实高度。 */
  const report = '<script>(function(){function h(){try{var b=document.body;if(!b)return;var m=0;'
    + 'var cs=getComputedStyle(b);var pb=parseFloat(cs.paddingBottom)||0;var pt=parseFloat(cs.paddingTop)||0;'
    + 'var kids=b.children;for(var i=0;i<kids.length;i++){var r=kids[i].getBoundingClientRect();'
    + 'if(r.height||r.width){var bt=r.bottom+(window.scrollY||0);if(bt>m)m=bt;}}'
    + 'var y=Math.ceil(m+pb);if(!(y>0))y=Math.ceil(b.scrollHeight||0);'
    + 'if(y>0)parent.postMessage({__mdviz:1,h:y},"*");}catch(e){}}'
    + 'window.addEventListener("load",h);document.addEventListener("DOMContentLoaded",h);'
    + 'setTimeout(h,60);setTimeout(h,400);setInterval(h,900);'
    + 'window.addEventListener("resize",h);'
    + 'if(window.ResizeObserver){try{new ResizeObserver(h).observe(document.body);}catch(e){}}'
    + '})();<\/script>';
  const s0 = String(code == null ? '' : code);
  if (/<\/body>/i.test(s0)) return s0.replace(/<\/body>/i, report + '</body>');
  return s0 + report;
}
/* 可视化 iframe 自适应高度：只认自家可视化块发来的消息 */
window.addEventListener('message', e => {
  const d = e && e.data;
  if (!d || d.__mdviz !== 1) return;
  const frames = document.querySelectorAll('iframe.mdVizFrame');
  for (const f of frames) {
    if (f.contentWindow !== e.source) continue;
    const h = Math.max(140, Math.min(1600, Math.round(Number(d.h) || 0) || 320));
    if (Math.abs((parseInt(f.style.height, 10) || 0) - h) > 4) f.style.height = h + 'px';
    break;
  }
});
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
/* 把与文字挤在一行的 ``` 围栏拆到独立行（题面/粘贴内容里常见）
   mapOut（可选）：传数组进来时，逐行记下「输出行号 → 原始行号」。
   为什么需要它：下面会拆行（```python x=1 → 两行）、丢行（裸围栏笔误连收尾一起丢）、
   末尾补收尾，所以输出行号跟源码行号会整体漂移 —— mdToHTML 要给块标 data-src
   （教程「双击哪儿改哪儿」按行定位，见 tutManualEnter），必须能映射回原始行。
   不传就完全保持原来的行为。 */
function normalizeFences(raw, mapOut) {
  let t = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  /* 把正文里的围栏规范化成「每行一个」。做这几件事：
       1) 开围栏后面直接跟内容 → 拆成「开围栏行 + 内容行」（```python x=1 这种）
       2) 裸围栏后面跟中文散文 → 判为笔误，连它的收尾一起丢掉
       3) 结尾还开着 → 补一个收尾，免得渲染时把后面的内容一路吞进代码块

     ⚠️ 三个必须遵守的约束（每一条都是踩过的坑）：
     a. **围栏内部一律不改**。viz 块的 HTML、JS 模板串里的反引号、代码里的
        `<code>```json ... ```</code>` 都长着围栏的样子，改了就等于凭空造出/
        删掉围栏。实测：教程 1 正文里有一句 `<code>```json … ```</code>`，
        被"行内围栏拆行"那条规则拆出一个假围栏，整篇配对随之错位。
     b. **收尾围栏永远不该被删**。合法收尾就是一个裸 ``` 且后面跟着（中文）正文 ——
        "后面是中文就当笔误删"会批量删掉所有真正的收尾，块边界全部错位，
        表现就是"整个教程都以文字形式显示"。只能在**没有块开着**时考虑删。
     c. 删了开围栏就必须连它的裸收尾一起删，否则后面每个块都挪一格、级联错位。 */
  const src = t.split('\n');
  const out = [];
  const lmap = mapOut || null;
  if (lmap) lmap.length = 0;                       // 传进来的数组可能被复用过
  const put = (s, li) => { out.push(s); if (lmap) lmap.push(li); };
  let open = null;                                  // { mark, len }
  const fenceAt = s2 => {
    const m = String(s2).match(/^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[ \t]*$/);
    return m ? { mark: m[1][0], len: m[1].length, lang: m[2] || '' } : null;
  };
  const isProse = body => {
    if (!String(body).trim()) return true;          // 后面什么都没有 = 空代码块
    const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
    const dense = body.replace(/\s/g, '').length || 1;
    if (cjk / dense < 0.5) return false;
    /* 有代码特征就不算散文：中文注释的代码块也长这样 */
    return !/[{};]|\bdef\s|\bclass\s|\bconst\s|\bvar\s|\bfunction\s|\bimport\s|\bSELECT\s|\$\s|=>|<\/?[a-zA-Z]+[\s>]/.test(body);
  };
  for (let i = 0; i < src.length; i++) {
    const ln = src[i];
    if (open) {                                     // —— 围栏内部：只找收尾，内容原样 ——
      const f = fenceAt(ln);
      if (f && f.mark === open.mark && f.len >= open.len && !f.lang) open = null;
      put(ln, i);
      continue;
    }
    /* 开围栏后面直接跟内容：拆行（约束 a：只在这里、即围栏外面做） */
    const m = ln.match(/^[ \t]*(`{3,}|~{3,})([ \t]*[\w+-]+)?[ \t]+(\S.*)$/);
    if (m) {
      const mark = m[1], lang = (m[2] || '').trim(), rest = m[3];
      /* 没有语言标识、后面又是中文散文 → 这是夹在句子里的符号，不是代码块开头 */
      if (!lang && isProse(rest)) { put(rest, i); continue; }
      /* 拆成两行：两行都记同一原始行号（内容其实就在这一行上） */
      put(mark + lang, i);
      open = { mark: mark[0], len: mark.length };
      put(rest, i);
      continue;
    }
    const f = fenceAt(ln);
    if (f) {
      if (f.lang) { open = { mark: f.mark, len: f.len }; put(ln, i); continue; }
      /* 裸围栏 + 当前没有块开着 = 它会**新开**一块 → 才可能是笔误 */
      let j = i + 1;
      while (j < src.length && !fenceAt(src[j])) j++;
      const body = src.slice(i + 1, j).join('\n');
      if (isProse(body)) {
        const nf = fenceAt(src[j]);
        if (nf && !nf.lang) i = j;                  // 约束 c：连裸收尾一起丢
        continue;
      }
      open = { mark: f.mark, len: f.len };
      put(ln, i);
      continue;
    }
    put(ln, i);
  }
  t = out.join('\n');
  // 约束 3：补收尾（补出来的那行源码里其实没有，映射到末尾之后，好过缺一项）
  if (open) { t += '\n' + open.mark.repeat(open.len); if (lmap) lmap.push(src.length); }
  return t;
}

function mdToHTML(text, opts) {
  /* opts.viz：把 ```viz 围栏渲染成沙箱 iframe 里的活页面（教程专用，见下方说明）。
     默认关闭 —— 聊天/汇总里的 ```viz 仍按普通代码块显示，避免模型偶发写出时用户看到空白框。 */
  const vizOn = !!(opts && opts.viz);
  /* opts.srcLines：给每个块标 `data-src="源码起始行号"` —— 教程正文与笔记渲染态要它来
     做「点哪儿改哪儿」（见 mdPickTarget）。别的调用方不传：属性虽是惰性的，但既然没用，
     就别白塞（也会让聊天/汇总的 HTML 无谓变大）。
     opts.lineBase：块引用里递归渲染子块时，子块行号要加上父块在源码里的起始行。 */
  const srcOn = !!(opts && opts.srcLines);
  const lineBase = (opts && opts.lineBase) || 0;
  const lmap = srcOn ? [] : null;
  const lines = normalizeFences(text, lmap).split('\n');
  /* ⚠️ normalizeFences 会拆行（```python x=1 → 两行）/丢行/末尾补收尾，
     所以"归一化后的行号"并不等于源码行号，必须靠 lmap 映射回原始行。
     映射不到（补出来的收尾围栏）就退回自身行号，反正没人会点它。 */
  const mapLine = ln => (lmap && lmap[ln] != null) ? lmap[ln] : ln;
  /* 块的行范围 [a,b)（b 是"这一块吃掉的最后一行"的源码行号 + 1）—— 就地编辑单块
     （mdInlineOpen）靠它把这一块的源码 markdown 原样切出来。只加属性、不动渲染结构：
     把 data-src / data-srce 都剥掉后，输出跟不传 srcLines 时逐字节相同。
     结束行取**最后一行 + 1**（不是下一块的行号）：这样中间被 normalizeFences 丢掉的
     笔误行也一并落在范围内，替换时才不会残留半行。 */
  const srcAttr2 = (a, b) => {
    if (!srcOn) return '';
    const s = lineBase + mapLine(a);
    let e = lineBase + mapLine(b > a ? b - 1 : a) + 1;
    if (!(e > s)) e = s + 1;
    return ' data-src="' + s + '" data-srce="' + e + '"';
  };
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
    /* 围栏：`{3,}` 而不是恰好 ```。
       ⚠️ 原来只认恰好三个反引号，于是「````」这种四反引号行既不匹配围栏分支、
          又被 isBlock 判成块级 → 落到段落分支后一行都没吃掉 → while(i<lines) 死循环，
          整个标签页卡死。中文语境里 ``` 连着内容、#### 这种写法并不少见。 */
    const fence = line.match(/^\s*(`{3,})([\w-]*)\s*$/);
    if (fence) {
      const mark = fence[1], start = i, buf = []; let closed = false;
      i++;
      // 收尾围栏至少要跟开围栏一样长，否则 ``` 会把 ```` 开的块提前关掉
      while (i < lines.length) {
        const cl = lines[i].match(/^\s*(`{3,})\s*$/);
        if (cl && cl[1].length >= mark.length) { closed = true; break; }
        buf.push(lines[i]); i++;
      }
      // 没找到收尾围栏 → 这行其实不是围栏开头，当普通文本处理
      // （否则末尾会凭空多出一个空的 <pre>）
      // ⚠️ 这里只能 i = start + 1，不能退回 start：那会让同一行被反复重新判定，死循环。
      if (!closed) { i = start + 1; html += '<p' + srcAttr2(start, start + 1) + '>' + mdInline(mdEscape(line)) + '</p>'; continue; }
      i++;
      /* 可视化块：```viz ... ``` 里的 HTML 会被塞进一个沙箱 iframe 真跑起来。
         为什么要 iframe：教程正文里直接插 HTML 会和外层样式互相污染、脚本还可能
         摸到主页面 DOM。沙箱（只给 allow-scripts，不给 allow-same-origin）让它
         拿到的是独立源，既能画图/动画，又碰不到应用本身。
         高度靠块内脚本 postMessage 上报，外层监听后设置（见 mdVizResize）。 */
      if (vizOn && /^(?:viz|demo|htmlviz)$/i.test(fence[2] || '')) {
        const vcode = buf.join('\n');
        /* ⚠️ 模型偶尔会在 ```viz 里塞**字符画流程图**而不是 HTML（线上教程 127 就是：
           用 -> v ^ 画了三条执行轨迹）。塞进 iframe 会被当纯文本渲染，
           连续空格被吞掉、换行塌掉 —— 用户看到的就是一团挤在一起的乱码（正是这次报的）。
           所以先验一下：没有真 HTML 标签就退回 <pre>，至少等宽字体 + 保留缩进对齐，
           字符画还能看；真要图示应该由模型按提示词改写成 HTML/SVG。 */
        if (!/<[a-zA-Z][\w-]*[\s\S]*>/.test(vcode)) {
          /* 兜底渲染成代码块时，顺手认一下语言（JSON / python / bash…）并上高亮，
             比标一个没意义的 "viz" 强 —— 实测线上就有模型把一段 JSON 塞进 ```viz。 */
          const guess = hlGuessLang(vcode);
          html += '<pre class="mdVizText"' + srcAttr2(start, i)
            + (guess ? ' data-lang="' + mdEscape(guess) + '"' : '')
            + '><code>' + hlCode(vcode, guess) + '</code></pre>';
          continue;
        }
        html += '<div class="mdViz"><iframe class="mdVizFrame" sandbox="allow-scripts" loading="lazy" srcdoc="'
          + mdEscapeAttr(vizSrcdoc(vcode)) + '"></iframe></div>';
        continue;
      }
      /* data-src 指向**开围栏行**、data-srce 指向**收围栏之后**：这样就地编辑拿到的
         源码含首尾围栏（```lang … ```），改完原样写回。双击代码块仍进代码里 ——
         mdPickOffset 里有一条"落在围栏行上就往后挪一行"的兜底。 */
      html += '<pre' + srcAttr2(start, i)
        + (fence[2] ? ' data-lang="' + mdEscape(fence[2]) + '"' : '') + '><code>'
        + hlCode(buf.join('\n'), fence[2] || hlGuessLang(buf.join('\n'))) + '</code></pre>';
      continue;
    }
    // 标题：中文里 `##标题` 不加空格很常见，这里容忍没有空格的情况
    const h = line.match(/^\s*(#{1,6})\s*(.*)$/);
    if (h && h[2].trim()) { const n = h[1].length; html += '<h' + n + srcAttr2(i, i + 1) + '>' + mdInline(mdEscape(h[2])) + '</h' + n + '>'; i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const bqStart = i;
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      /* 引用里的内容要递归渲染。`>` 是一行对一个原始行，所以子块的 data-src 必须整体加上
         「引用首行在源码里的行号」当基准（lineBase）—— 否则子块行号从 0 开始，全指错地方。 */
      const bqBase = lineBase + ((lmap && lmap[bqStart] != null) ? lmap[bqStart] : bqStart);
      html += '<blockquote' + srcAttr2(bqStart, i) + '>'
        + mdToHTML(buf.join('\n'), srcOn ? { srcLines: true, lineBase: bqBase } : undefined)
        + '</blockquote>';
      continue;
    }
    if (line.includes('|') && lines[i + 1] && isSep(lines[i + 1])) {
      const hLine = i;
      const header = mdRow(line);
      i += 2;
      const rows = [], rLines = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rLines.push(i); rows.push(mdRow(lines[i])); i++; }
      /* 表头与每个 td 各标自己的起始行：双击某个单元格要落到那一行的源码，
         而不是整张表的第一行。 */
      html += '<table' + srcAttr2(hLine, i) + '><thead><tr>' + header.map(c => '<th' + srcAttr2(hLine, hLine + 1) + '>' + mdInline(mdEscape(c)) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map((r, ri) => '<tr>' + r.map(c => '<td' + srcAttr2(rLines[ri], rLines[ri] + 1) + '>' + mdInline(mdEscape(c)) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [], iLines = [];
      while (i < lines.length) {
        const l = lines[i];
        const ul = l.match(/^\s*[-*+]\s+(.*)$/);
        const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
          if (!!ol !== ordered) break;
          iLines.push(i);                            // 每个li自己的源码起始行
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
      const ulStart = iLines.length ? iLines[0] : i;
      const liEnd = k => (iLines[k + 1] != null ? iLines[k + 1] : i);
      html += '<' + (ordered ? 'ol' : 'ul') + srcAttr2(ulStart, i)
        + '>' + items.map((x, k) => '<li' + srcAttr2(iLines[k] != null ? iLines[k] : i, liEnd(k)) + '>' + x + '</li>').join('')
        + '</' + (ordered ? 'ol' : 'ul') + '>';
      continue;
    }
    const pStart = i;
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (isBlock(l) || (l.includes('|') && lines[i + 1] && isSep(lines[i + 1]))) break;
      buf.push(l); i++;
    }
    /* ⚠️ 死循环兜底：isBlock 认得、但上面任何一个分支都没接住的行（````、`#无空格标题` 等），
       会走到这里 buf 为空且 i 没前进 → 外层 while 无限转、标签页卡死。
       所以"什么都没吃掉"时必须强制前进一行。 */
    if (!buf.length) i++;
    if (buf.length) html += '<p' + srcAttr2(pStart, i) + '>' + buf.map(x => mdInline(mdEscape(x))).join('<br>') + '</p>';
  }
  /* 教程模式下把「**标签** + 后续内容」打包成卡片（见 tutGroupCallouts）。
     只在教程里做：对话/汇总要的是紧凑，卡片会把短回复撑得很松散。 */
  if (vizOn) html = tutGroupCallouts(html);
  return rewriteCites(html);
}
/* ============ AI 引用的上标标注（[节点id] → 点击查看引用了什么） ============
   AI 写规划/教程时会用 `[2410]` 这种格式交叉引用别的节点（路线图提示词就是 `[id] 标题`
   的形式，模型照着抄）。裸数字既看不出引用了什么、又影响观感。这里：
     1. 凡是 `[数字]` 且该 id 真实存在（当前目标的节点 / 资料 / 提炼汇总），渲染成上标 ⧉；
     2. 点一下弹出小卡片说明它到底是什么；教程正文在 iframe 里，由 withCiteHook 注入的
        转发脚本调到 window.__openCite（iframe 里点不到主文档的监听）；
     3. 只在 mdToHTML 统一出口 + 节点面板 + 教程 iframe 三处套 rewriteCites ——
        新增渲染入口时记得同样处理（AI 生成的内容都可能带这种引用）。 */
function citeCacheUpdate(gid) {
  state.citeCache = state.citeCache || {};
  if (state.goal && Number(state.goal.id) === Number(gid)) {
    state.citeCache[gid] = { nodes: state.goal.nodes || [], sources: state.sources || [], digests: state.digests || [], at: Date.now() };
  }
  return state.citeCache[gid] || null;
}
async function ensureCiteCache(gid) {
  state.citeCache = state.citeCache || {};
  if (!gid) return null;
  const cur = citeCacheUpdate(gid);
  if (cur && Date.now() - (cur.at || 0) < 5 * 60 * 1000) return cur;
  try {
    const [{ goal }, { sources }, dg] = await Promise.all([
      api('/api/goals/' + gid),
      api('/api/goals/' + gid + '/sources'),
      api('/api/goals/' + gid + '/digests').catch(() => ({ digests: [] }))
    ]);
    state.citeCache[gid] = { nodes: (goal && goal.nodes) || [], sources: sources || [], digests: (dg && dg.digests) || [], at: Date.now() };
    return state.citeCache[gid];
  } catch (e) { return cur || null; }
}

/* 把 `[数字]` 引用换成上标（点一下解释它是什么）。全部标注、不预筛 id ——
   引用了不存在的 id 时也能让用户点开看到"这条引用指向已删除/不存在的节点"，
   比留个裸数字好。**只有 <pre> 整段代码块跳过**（arr[1024] 这种不是引用）；
   AI 写教程时常把引用包进行内代码 `[2410]`，那种要转 —— 线上教程里 37 处
   引用全是行内代码样式，跳过就等于没转。 */
function rewriteCites(html) {
  let t = String(html || '');
  const pres = [];
  t = t.replace(/<pre[\s\S]*?<\/pre>/gi, m => { pres.push(m); return '\u0000CITE' + (pres.length - 1) + '\u0000'; });
  t = t.replace(/\[(\d{3,7})\]/g, (m, id) => '<sup class="cite" data-cite="' + id + '" title="点击查看引用了什么">⧉</sup>');
  t = t.replace(/\u0000CITE(\d+)\u0000/g, (m, i) => pres[Number(i)]);
  return t;
}
function citeChain(n, nodes) {
  const byId = {};
  for (const x of nodes) byId[x.id] = x;
  const parts = []; let cur = n;
  while (cur) { parts.unshift(String(cur.title || '').slice(0, 30)); cur = cur.parent_id ? byId[cur.parent_id] : null; }
  return parts.join(' › ');
}
function citeResolve(id) {
  const gid = (state.goal && state.goal.id) || state.tutGoalId || 0;
  const c = (state.citeCache || {})[gid];
  if (!c) return '';
  const n = c.nodes.find(x => String(x.id) === String(id));
  if (n) {
    const det = String(n.detail || '');
    const inCur = (state.goal && state.goal.nodes || []).some(x => Number(x.id) === Number(id));
    return `<div class="citePopHead"><span class="chip gray">节点</span><span>${esc(n.title)}</span></div>
      <div class="citePopMeta">${esc(citeChain(n, c.nodes))}${n.hours ? ' · ' + esc(n.hours) : ''} · ${ST_LABEL[n.status] ? ST_LABEL[n.status][0] : '未开始'}</div>
      ${det ? `<div class="citePopBody">${esc(det.slice(0, 500))}${det.length > 500 ? '…' : ''}</div>` : ''}
      <div class="citePopOps">${inCur ? `<button class="btn tiny primary" data-cite-node="${n.id}">打开节点详情</button>` : `<a class="btn tiny" href="#/g/${gid}">去所在目标查看</a>`}</div>`;
  }
  const s = c.sources.find(x => String(x.id) === String(id));
  if (s) {
    const body = String(s.content || s.snippet || '').replace(/\s+/g, ' ').slice(0, 600);
    return `<div class="citePopHead"><span class="chip gray">资料</span>${Number(s.quality) === 1 ? '<span class="chip ok">★ 优质</span>' : ''}<span>${esc(s.title)}</span></div>
      <div class="citePopMeta">${esc(s.site)}｜${esc(s.kind)}</div>
      <div class="citePopBody">${esc(body)}${body.length >= 600 ? '…' : ''}</div>
      <div class="citePopOps"><a class="btn tiny" href="#/library">到资源库查看全文</a></div>`;
  }
  const d = c.digests.find(x => String(x.id) === String(id));
  if (d) {
    const body = String(d.content || '').replace(/\s+/g, ' ').slice(0, 600);
    return `<div class="citePopHead"><span class="chip gray">提炼汇总</span><span>${esc(d.title || d.topic || '')}</span></div>
      <div class="citePopMeta">依据 ${d.sources_count || 0} 条资料 · ${esc(fmtDate(d.created_at))}</div>
      <div class="citePopBody">${esc(body)}${body.length >= 600 ? '…' : ''}</div>`;
  }
  return '';
}
/* 「查看全部依据」弹窗：用与面板内**完全相同的卡片**列出该节点的全部依据。
   起因：其余依据原来是展开成 chips（窄条、只有名字），与上面的卡片长得不一样，
   用户说"展开后看不到类似的依据卡片"。现在统一成一套卡片 + 一个弹窗。 */
/* 从来源名/站点/类型里认出它属于哪一类，给卡片一个标签（面板与弹窗共用） */
function srcKind(o) {
  const t = String((o && o.name) || '') + ' ' + String((o && o.x && o.x.site) || '') + ' ' + String((o && o.x && o.x.kind) || '');
  if (/代码库/.test(t)) return '代码库';
  if (/JD|招聘|岗位/.test(t)) return 'JD';
  if (/面经|面试|一面|二面/.test(t)) return '面经';
  if (/提炼汇总|汇总/.test(t)) return '汇总';
  if (/用户提供/.test(t)) return '自己提供';
  if (/电子书|书单/.test(t)) return '书';
  if (/路线|路径/.test(t)) return '路线';
  return String((o && o.x && o.x.kind) || '资料').slice(0, 6);
}
function srcCardHTML(o) {
  return `<div class="npSrc ${o.isStar ? 'isStar' : ''}">
    <div class="npSrcHd">
      ${o.isStar ? sxi('check', 14) : sxi('link', 14)}
      <span class="npSrcName" title="${esc(o.name)}">${esc(o.name)}</span>
      <span class="npSrcKind">${esc(srcKind(o))}</span>
      ${o.isStar ? '<span class="npSrcStar">优质</span>' : ''}
    </div>
    ${o.note ? `<div class="npSrcNote">${esc(o.note)}</div>` : ''}
    ${o.body ? `<details class="npSrcBody"><summary>查看资料库正文（${o.body.length} 字）</summary><div class="mdBody">${mdToHTML(o.body.slice(0, 4000))}</div></details>` : ''}
  </div>`;
}
function openAllSrcPop() {
  const node = state.goal && state.goal.nodes
    ? state.goal.nodes.find(x => Number(x.id) === Number(state.__npNodeId)) : null;
  const srcs = safeParse(node && node.sources, []);
  if (!srcs.length) return;
  const old = document.getElementById('srcAllPop');
  if (old) old.remove();
  const items = srcs.map(x => {
    const lib = findLibSource(x);
    const body = lib ? String(lib.content || lib.snippet || '') : '';
    return { x, body, isStar: !!(lib && Number(lib.quality) === 1), name: String(x.name || x.title || '').trim() || '（未命名来源）', note: String(x.note || '').trim() };
  });
  const d = document.createElement('div');
  d.id = 'srcAllPop';
  d.className = 'srcAllPop';
  d.innerHTML = `<div class="srcAllHd">
      <b>依据信息源</b><span class="srcAllCnt">${items.length} 条</span>
      <span class="spacer"></span>
      <button class="btn tiny" id="srcAllClose">关闭</button>
    </div>
    <div class="srcAllBody">${items.map(o => srcCardHTML(o)).join('')}</div>`;
  document.body.appendChild(d);
  d.querySelector('#srcAllClose').addEventListener('click', () => d.remove());
  d.addEventListener('click', ev => { if (ev.target === d) d.remove(); });
  return d;
}
window.__openAllSrc = openAllSrcPop;
function citePopClose() { const el = document.getElementById('citePop'); if (el) el.remove(); }
function citePopOpen(id, x, y) {
  citePopClose();
  const d = document.createElement('div');
  d.id = 'citePop';
  d.className = 'citePop';
  d.innerHTML = '<div class="citePopHead"><span class="chip gray">引用</span></div><div class="citePopEmpty">正在查这条引用是什么…</div>';
  d.style.visibility = 'hidden';   // 内容到位前不显示，避免占位尺寸乱跳/定位一抖一抖
  document.body.appendChild(d);
  const M = 10;
  const place = () => {
    const r = d.getBoundingClientRect();
    /* x/y 是上标左边缘/下边缘的视口坐标：默认在标记下方；
       下方放不下就翻到上方，再整体夹回视口内 —— 位置可预期，永远完整可见。 */
    const px = Math.max(M, Math.min(Number(x) || 40, Math.max(M, window.innerWidth - r.width - M)));
    const y0 = Number(y) || 40;
    const below = y0 + r.height + 8;
    let py = below;
    if (below > window.innerHeight - M) {
      const above = y0 - r.height - 8;
      py = above >= M ? above : Math.max(M, Math.min(below, window.innerHeight - r.height - M));
    }
    py = Math.max(M, Math.min(py, Math.max(M, window.innerHeight - r.height - M)));
    d.style.left = Math.round(px) + 'px';
    d.style.top = Math.round(py) + 'px';
  };
  place();
  (async () => {
    const gid = (state.goal && state.goal.id) || state.tutGoalId || 0;
    if (gid && !((state.citeCache || {})[gid])) await ensureCiteCache(gid);
    if (!document.getElementById('citePop')) return;   // 已经关掉了
    const body = citeResolve(id);
    d.innerHTML = body || '<div class="citePopHead"><span class="chip gray">引用</span></div><div class="citePopEmpty">没找到 id=' + esc(id) + ' 对应的内容：它可能引用了已被删除的节点或别的目标里的东西。</div>';
    place();
    d.style.visibility = 'visible';
  })();
}
document.addEventListener('click', e => {
  /* 「查看全部 N 条依据」→ 弹窗里用同一套卡片列全（视觉与面板内一致） */
  if (e.target.closest && e.target.closest('#npSrcAll')) { openAllSrcPop(); return; }
  const clampTg = e.target.closest && e.target.closest('[data-clamp-tg]');
  if (clampTg) {
    const box = clampTg.parentNode.querySelector('[data-clamp]');
    if (box) {
      const open = box.classList.toggle('isOpen');
      clampTg.textContent = open ? '收起' : '展开';
    }
    return;
  }
  const bodyBtn = e.target.closest && e.target.closest('[data-npsrc-body]');
  if (bodyBtn) {
    const card = bodyBtn.closest('.npSrc');
    const box = card && card.querySelector('.npSrcBodyBox');
    if (box) {
      if (!box.hidden) { box.hidden = true; bodyBtn.classList.remove('primary'); return; }
      if (!box.getAttribute('data-filled')) {
        const idx = Number(bodyBtn.getAttribute('data-npsrc-body'));
        const cur = (state.__npSrcs || [])[idx];
        const lib = cur ? findLibSource({ name: cur.name, title: cur.name }) : null;
        const body = lib ? String(lib.content || lib.snippet || '') : '';
        box.innerHTML = body
          ? '<div class="mdBody">' + mdToHTML(body.slice(0, 4000)) + '</div>'
          : '<div class="muted" style="font-size:12px;padding:6px 2px;">资料库里找不到这条的正文（可能已被删除或还没导入全文）。</div>';
        box.setAttribute('data-filled', '1');
      }
      box.hidden = false;
      bodyBtn.classList.add('primary');
    }
    return;
  }
  const nodeBtn = e.target.closest && e.target.closest('[data-cite-node]');
  if (nodeBtn) {
    const id = Number(nodeBtn.getAttribute('data-cite-node'));
    citePopClose();
    const n = (state.goal && state.goal.nodes || []).find(x => Number(x.id) === id);
    if (n) showNodePanel(id, typeof renderGoal === 'function' ? renderGoal : null);
    else toast('这个节点不在当前目标里');
    return;
  }
  const mark = e.target.closest && e.target.closest('.cite');
  if (mark) {
    const id = mark.getAttribute('data-cite');
    if (document.__citeOpenFor === id) { citePopClose(); document.__citeOpenFor = ''; return; }
    document.__citeOpenFor = id;
    const r = mark.getBoundingClientRect();
    citePopOpen(id, r.left, r.bottom);
    return;
  }
  if (document.__citeOpenFor) { document.__citeOpenFor = ''; citePopClose(); }
});
/* iframe（HTML 教程）里的引用上标：iframe 文档里点不到主文档的监听，由注入脚本转发到这里 */
window.__openCite = (id, x, y) => { document.__citeOpenFor = id; citePopOpen(id, x, y); };
/* 弹窗关闭：点别处 / Esc / 窗口尺寸变化。
   刻意**不**监听 scroll —— 固定定位的弹窗本就钉在原处，而教学页有"恢复上次
   阅读位置"这类延迟滚动，监听 scroll 会把刚点开的弹窗直接关掉（线上就这么闪没的）。 */
window.addEventListener('resize', citePopClose);
document.addEventListener('keydown', e => { if (e.key === 'Escape') citePopClose(); });
/* 教程 iframe：注入引用上标的点击转发脚本（沙箱已开 allow-scripts / allow-same-origin） */
function withCiteHook(html) {
  const js = `<script>document.addEventListener('click',function(e){var c=e.target&&e.target.closest&&e.target.closest('sup.cite');if(!c)return;e.preventDefault();` +
    `var r=c.getBoundingClientRect(),fr=window.frameElement;var x=r.left+(fr?fr.getBoundingClientRect().left:0),y=r.bottom+(fr?fr.getBoundingClientRect().top:0);` +
    `try{window.parent.__openCite(c.getAttribute('data-cite'),x,y);}catch(err){}});</script>`;
  const t = String(html || '');
  if (/<\/body>/i.test(t)) return t.replace(/<\/body>/i, js + '</body>');
  return t + js;
}
/* 顶栏收藏栏（教程页 / 路线图页共用一套实现）：钉选 + 收藏夹 + 横向拖拽排序，其余收进 ⋯
   每条栏按 ns（命名空间）分开存，互不干扰：
     ns='tut'  → 教程页，键 sierxing-tutbar-v5
     ns='goal' → 路线图（目标）页，键 sierxing-goalbar-v1
     ns='prob' → 单题页（刷题组件），键 sierxing-probbar-v1
   组件页面直接复用这一套：在自己页面里渲染 id=xxxFavBar 的容器 + 带 data-tbtn
   的按钮，渲染完调一次 applyBarOverflow(自己的 ns) 即可（拖拽/收藏夹/⋯ 收纳全都现成）。
   数据结构：
     seen    顶栏出现过的按钮 id。按钮受组件开关控制，可能这次不渲染；记下来才不会丢。
     off     用户明确"取消钉选"的按钮 id（收进 ⋯）
     order   栏内横向顺序，元素是 'b:按钮id'（散着的按钮）或 'f:收藏夹id'
              —— 按钮和文件夹共用一个序列，所以两者能互相穿插排序
     folders [{ id, name, buttons: [按钮id…] }]，buttons 的顺序即文件夹内顺序
   所有 [data-tbtn] 按钮始终留在 DOM 里（收进 ⋯ / 进文件夹的只是 display:none），
   否则 ⋯ 菜单点它会 getElementById 落空、点了没反应。 */
const BAR_NS = {
  tut:  { key: 'sierxing-tutbar-v5',  old: 'sierxing-tutbar-v4', bar: 'tutFavBar',  more: 'tutMoreBtn' },
  /* alwaysMore：目标页的 ⋯ 常驻。以前按钮全都摆得下时 ⋯ 会被藏掉，
     于是「自定义工具栏…」永远进不去（排布满了就再也改不了）。 */
  goal: { key: 'sierxing-goalbar-v1', old: '',                  bar: 'goalFavBar', more: 'goalMoreBtn', alwaysMore: true },
  prob: { key: 'sierxing-probbar-v1', old: '',                  bar: 'probFavBar', more: 'probMoreBtn', alwaysMore: true },
};
let BAR_DRAG = null;        // 当前拖的东西：{k:'b'|'f', id, ns}
let BAR_DROP_MARK = null;   // 横向排序的插入位置指示线
function barNs(ns) { return BAR_NS[ns] || BAR_NS.tut; }

function barStrs(a) { return (Array.isArray(a) ? a : []).filter(x => typeof x === 'string'); }
function barTok(k, id) { return k + ':' + id; }
function barFolderOf(st, btnId) { return (st.folders || []).find(f => (f.buttons || []).includes(btnId)) || null; }

function barState(ns) {
  const cfg = barNs(ns);
  const norm = v => {
    if (!v || typeof v !== 'object') return null;
    return {
      seen: barStrs(v.seen),
      off: barStrs(v.off),
      order: barStrs(v.order),
      folders: (Array.isArray(v.folders) ? v.folders : []).filter(f => f && typeof f.id === 'string')
        .map(f => ({ id: f.id, name: String(f.name || '收藏夹').slice(0, 20), buttons: barStrs(f.buttons) }))
    };
  };
  try { const v = norm(JSON.parse(localStorage.getItem(cfg.key) || 'null')); if (v) return v; } catch (e) {}
  // 迁移旧版（pinned + folders，没有 order / off）
  if (!cfg.old) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(cfg.old) || 'null');
    const v = norm(raw);
    if (v) {
      const pinned = barStrs(raw && raw.pinned);
      if (!v.seen.length) v.seen = pinned.slice();
      if (!v.order.length) {
        pinned.forEach(id => { if (!barFolderOf(v, id)) v.order.push(barTok('b', id)); });
        v.folders.forEach(f => v.order.push(barTok('f', f.id)));
      }
      return v;
    }
  } catch (e) {}
  return null;
}
function barSave(st, ns) {
  try {
    localStorage.setItem(barNs(ns).key, JSON.stringify({
      seen: st.seen || [], off: st.off || [], order: st.order || [], folders: st.folders || []
    }));
  } catch (e) {}
}
/* 归一化 order：去重、丢掉已删文件夹/已进文件夹的按钮、补上本页新出现的按钮 */
function barNorm(st, ids) {
  st.folders = st.folders || [];
  const fids = new Set(st.folders.map(f => f.id));
  const inFolder = new Set();
  st.folders.forEach(f => (f.buttons || []).forEach(id => inFolder.add(id)));
  const seenT = new Set();
  st.order = barStrs(st.order).filter(t => {
    const i = t.indexOf(':');
    if (i < 1 || seenT.has(t)) return false;
    const k = t.slice(0, i), id = t.slice(i + 1);
    if (!id) return false;
    if (k === 'f') return fids.has(id);
    if (k === 'b') return !st.off.includes(id) && !inFolder.has(id);
    return false;
    // 注意：组件关掉时按钮没渲染，它的 b: token 仍然保留，切回对应目标就回到原位
  });
  st.order.forEach(t => seenT.add(t));
  for (const id of ids) {
    if (st.seen.includes(id)) continue;
    st.seen.push(id);
    const t = barTok('b', id);
    if (!st.off.includes(id) && !inFolder.has(id) && !seenT.has(t)) { st.order.push(t); seenT.add(t); }
  }
  return st;
}
/* 横向排序：把 token 移到第 idx 位（idx 是"剔除自己之后"的可视项序号） */
function barOrderMove(order, tok, idx) {
  const at = order.indexOf(tok);
  if (at >= 0) order.splice(at, 1);
  order.splice(Math.max(0, Math.min(idx, order.length)), 0, tok);
}
function barVisibleItems(bar) {
  return Array.from(bar.children).filter(el => {
    if (!el.getAttribute) return false;
    if (el.getAttribute('data-folder')) return true;
    if (el.hasAttribute('data-tbtn')) return el.style.display !== 'none';
    return false;
  });
}
function barDropMarkShow(bar, idx) {
  if (!BAR_DROP_MARK) { BAR_DROP_MARK = document.createElement('span'); BAR_DROP_MARK.className = 'barDropMark'; }
  const items = barVisibleItems(bar);
  const ref = items[idx] || bar.querySelector('#tutMoreBtn');
  if (ref && ref.parentElement === bar && BAR_DROP_MARK.nextSibling !== ref) bar.insertBefore(BAR_DROP_MARK, ref);
}
function barDropMarkHide() {
  if (BAR_DROP_MARK && BAR_DROP_MARK.parentElement) BAR_DROP_MARK.remove();
}
/* 鼠标 x 落在第几个可视项之前（跳过自己） */
function barDropIndex(bar, x, skipEl) {
  const items = barVisibleItems(bar).filter(el => el !== skipEl);
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return items.length;
}
/* 收藏栏条目的显示名。
   收藏栏配置是**跨目标共享**的（sierxing-goalbar-v1），所以里面会留着「当前目标没启用」
   的组件按钮（如 goalComp_hot100）。这种按钮不在 DOM 里，labels 里就没有它，
   以前直接回落成按钮 id —— 界面上就会冒出 goalComp_hot100 这种鬼东西。
   这里从组件元数据把名字找回来 —— 任何路径都不会再露出按钮 id。
   （这类条目正常不会再被列出来：没启用就是没有。） */
function barItemLabel(id, labels) {
  if (labels && labels[id]) return labels[id];
  const m = String(id || '').match(/^goalComp_(.+)$/);
  if (m) {
    const meta = (window.SiErXing && SiErXing.serverPlugins ? SiErXing.serverPlugins() : []).find(x => x.id === m[1]);
    return meta ? ((meta.icon || '🧩') + ' ' + (meta.name || m[1])) : m[1];
  }
  return String(id || '');
}
/* n = 里面"当前目标真的可用"的按钮数（没启用的组件不算，点开也看不到它）。
   不传就退回配置里的总数（调用方拿不到可用集合时）。 */
function barFolderChip(f, n) {
  const chip = document.createElement('button');
  chip.className = 'btn small barFolder';
  const cnt = (typeof n === 'number') ? n : (f.buttons || []).length;
  chip.textContent = `📁 ${f.name} (${cnt})`;
  chip.setAttribute('data-folder', f.id);
  chip.draggable = true;
  chip.title = '点开可上下排序 / 移出按钮；可横向拖动换位置；右键重命名或删除';
  return chip;
}
/* 把 [data-tbtn] 按钮按用户排布渲染进收藏栏。scope 限定只认这条栏自己的按钮
   （教程页和目标页的按钮 id 不同，但都叫 data-tbtn，必须按所在栏区分）。 */
function applyBarOverflow(ns) {
  const cfg = barNs(ns);
  const bar = document.getElementById(cfg.bar);
  const more = document.getElementById(cfg.more);
  if (!more || !bar) return;
  const btns = Array.from(bar.parentElement.querySelectorAll('[data-tbtn]')).filter(b => !b.hidden);
  const ids = btns.map(b => b.id);
  const st0 = barState(ns);
  // 首次使用：默认全部摆出来，用户自己整理
  const st = st0 || { seen: ids.slice(), off: [], order: ids.map(id => barTok('b', id)), folders: [] };
  barNorm(st, ids);
  const byId = {};
  btns.forEach(b => { byId[b.id] = b; });
  // 重绘会替换掉所有子节点，正在拖拽的元素可能因此脱离文档、收不到 dragend。
  // 先把拖拽态清干净，避免虚线框/插入线残留。
  if (BAR_DRAG) { BAR_DRAG = null; barDropMarkHide(); }
  bar.classList.remove('dragging', 'dropOn');
  bar.innerHTML = '';
  const placed = new Set();
  st.order.forEach(t => {
    const i = t.indexOf(':');
    if (i < 1) return;
    const k = t.slice(0, i), id = t.slice(i + 1);
    if (k === 'b') {
      const b = byId[id];
      if (!b) return;
      placed.add(id);
      b.style.display = '';
      b.draggable = true;
      b.dataset.barRole = 'loose';
      bar.appendChild(b);
    } else if (k === 'f') {
      const f = st.folders.find(x => x.id === id);
      if (!f) return;
      bar.appendChild(barFolderChip(f, (f.buttons || []).filter(id => byId[id]).length));
    }
  });
  bar.appendChild(more);
  // 其余按钮（收进 ⋯ 的、归入文件夹的）必须留在 DOM 里，只是隐藏
  btns.forEach(b => {
    if (placed.has(b.id)) return;
    b.style.display = 'none';
    b.draggable = true;
    b.dataset.barRole = 'rest';
    bar.appendChild(b);
  });
  const rest = ids.filter(id => !placed.has(id) && !barFolderOf(st, id));
  bar.hidden = !(placed.size || st.folders.length || rest.length);
  /* alwaysMore 的栏（按钮少、默认全都摆得下）也要留 ⋯：
     「新建收藏夹 / 自定义工具栏」都从这个菜单进，全摆下时一并藏了就再也建不了夹子。 */
  if (cfg.alwaysMore) {
    more.hidden = false;
    more.textContent = rest.length ? `⋯ (${rest.length})` : (st.folders.length ? '⋯' : '⋯ ⚙');
    more.title = st.folders.length ? '打开收藏夹 / 自定义工具栏' : '新建收藏夹 / 自定义工具栏';
  } else if (!rest.length) { more.hidden = true; }
  else { more.hidden = false; more.textContent = `⋯ (${rest.length})`; }
  more.onclick = () => {
    if (document.querySelector('.moreMenu')) { document.querySelectorAll('.moreMenu').forEach(x => x.remove()); return; }
    const items = rest.map(id => ({ icon: '', label: byId[id].textContent.trim(), target: id }));
    if (st.folders.length) for (const f of st.folders) items.push({ icon: '📂', label: `打开「${f.name}」`, cmd: ns + ':folder-open:' + f.id });
    /* 没有可收纳的按钮时，「新建收藏夹」是这条菜单里唯一能起手的事，得放在最上面 */
    if (cfg.alwaysMore) items.unshift({ icon: '📂+', label: '新建收藏夹', cmd: ns + ':folder-new' });
    if (rest.length) items.push({ icon: '📌', label: '全部钉回收藏栏', cmd: ns + ':pin-all' });
    items.push({ icon: '⚙', label: '自定义工具栏…', cmd: ns + ':customize' });
    void openMoreMenu(more, items);
  };
  bindBarDnD(bar, ns);
  barSave(st, ns);
}
/* 收藏栏拖拽：按钮/文件夹横向排序、按钮拖进文件夹、拖出文件夹。
   注意：事件只在同一个 bar 元素上绑定一次，且每次都从 localStorage 重新读状态——
   否则每次重绘叠加一批监听器，旧闭包里的过期 st 会把收藏夹等数据覆盖掉。 */
function bindBarDnD(bar, ns) {
  const nsc = ns || 'tut';
  if (bar.dataset.barBound === '1') return;
  bar.dataset.barBound = '1';
  // 事件发生时才读最新状态，避免闭包持有过期对象
  const cur = () => barState(nsc) || { seen: [], off: [], order: [], folders: [] };
  const commit = st => { barSave(st, nsc); applyBarOverflow(nsc); };
  const elOf = d => {
    if (!d) return null;
    if (d.k === 'f') return bar.querySelector('[data-folder="' + d.id + '"]');
    return Array.from(bar.querySelectorAll('[data-tbtn]')).find(b => b.id === d.id) || null;
  };
  const mark = (el, on) => el.classList.toggle('barDragSrc', !!on);
  const startDrag = (e, d, el) => {
    BAR_DRAG = d;
    try { e.dataTransfer.setData('text/plain', JSON.stringify(d)); } catch (err) {}
    e.dataTransfer.effectAllowed = 'move';
    mark(el, true);
    bar.classList.add('dragging');
  };
  const endDrag = () => {
    BAR_DRAG = null;
    bar.classList.remove('dragging');
    // 注意：querySelectorAll 匹配不到 bar 自己，虚线框要单独清
    bar.classList.remove('dropOn');
    bar.querySelectorAll('.barDragSrc').forEach(x => x.classList.remove('barDragSrc'));
    bar.querySelectorAll('.dropOn').forEach(x => x.classList.remove('dropOn'));
    barDropMarkHide();
  };
  // 兜底：拖拽源若在拖动途中被重绘替换掉，dragend 不会再冒泡到 bar，
  // 状态就会永久卡住。所以在 document 上兜一层，任何情况下都收尾。
  document.addEventListener('dragend', e => {
    if (!BAR_DRAG) return;
    if (bar.contains(e.target)) return;   // bar 自己的 dragend 已经处理过
    endDrag();
  });
  document.addEventListener('drop', e => {
    if (BAR_DRAG && !bar.contains(e.target)) endDrag();
  });
  // 拖动中途按 Esc / 窗口失焦，也可能收不到 dragend
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && BAR_DRAG) endDrag(); }, true);
  window.addEventListener('blur', () => { if (BAR_DRAG) endDrag(); });
  bar.addEventListener('dragstart', e => {
    const b = e.target.closest && e.target.closest('[data-tbtn]');
    if (b) return startDrag(e, { k: 'b', id: b.id, ns: nsc }, b);
    const chip = e.target.closest && e.target.closest('[data-folder]');
    if (chip) return startDrag(e, { k: 'f', id: chip.getAttribute('data-folder'), ns: nsc }, chip);
  });
  bar.addEventListener('dragend', endDrag);
  bar.addEventListener('dragover', e => {
    if (!BAR_DRAG || BAR_DRAG.ns !== nsc) return;
    e.preventDefault();
    const chip = e.target.closest && e.target.closest('[data-folder]');
    if (chip && BAR_DRAG.k === 'b') {
      // 悬在文件夹上 = 收进去：高亮 chip，不画插入线
      bar.classList.remove('dropOn');
      bar.querySelectorAll('[data-folder]').forEach(x => { if (x !== chip) x.classList.remove('dropOn'); });
      chip.classList.add('dropOn');
      barDropMarkHide();
      return;
    }
    bar.classList.add('dropOn');
    bar.querySelectorAll('[data-folder].dropOn').forEach(x => x.classList.remove('dropOn'));
    barDropMarkShow(bar, barDropIndex(bar, e.clientX, elOf(BAR_DRAG)));
  });
  bar.addEventListener('dragleave', e => {
    // relatedTarget 是"移动到哪"：为空或不在 bar 内，才算真正拖出了收藏栏。
    // 用 e.target 判是错的——从按钮上拖出去时 target 是那个按钮，永远不等于 bar。
    const to = e.relatedTarget;
    if (to && bar.contains(to)) return;
    bar.classList.remove('dropOn');
    bar.querySelectorAll('[data-folder].dropOn').forEach(x => x.classList.remove('dropOn'));
    barDropMarkHide();
  });
  bar.addEventListener('drop', e => {
    e.preventDefault();
    const d = (BAR_DRAG && BAR_DRAG.ns === nsc) ? BAR_DRAG : null;
    const chip = e.target.closest && e.target.closest('[data-folder]');
    const idx = barDropIndex(bar, e.clientX, elOf(d));
    endDrag();
    if (!d) return;
    const st = cur();
    const liveIds = Array.from(bar.parentElement.querySelectorAll('[data-tbtn]')).filter(b => !b.hidden).map(b => b.id);
    if (chip && d.k === 'b') {
      // 落在文件夹上 = 收进去
      const f = st.folders.find(x => x.id === chip.getAttribute('data-folder'));
      if (!f) return;
      for (const g of st.folders) g.buttons = g.buttons.filter(x => x !== d.id);
      st.order = st.order.filter(t => t !== barTok('b', d.id));
      st.off = st.off.filter(x => x !== d.id);
      if (!st.seen.includes(d.id)) st.seen.push(d.id);
      if (!f.buttons.includes(d.id)) f.buttons.push(d.id);
      commit(st);
      toast(`已收到收藏夹「${f.name}」`);
      return;
    }
    if (d.k === 'f') {
      barOrderMove(st.order, barTok('f', d.id), idx);
      commit(st);
      return;
    }
    // 按钮落到栏上：从文件夹/⋯ 里拿出来，按落点排序
    const f = barFolderOf(st, d.id);
    if (f) f.buttons = f.buttons.filter(x => x !== d.id);
    st.off = st.off.filter(x => x !== d.id);
    if (!st.seen.includes(d.id)) st.seen.push(d.id);
    barNorm(st, liveIds);
    barOrderMove(st.order, barTok('b', d.id), idx);
    commit(st);
    if (f) toast(`「${f.name}」里的按钮已移回收藏栏`);
  });
  bar.addEventListener('click', e => {
    const chip = e.target.closest && e.target.closest('[data-folder]');
    if (!chip) return;
    /* 以前这里：如果 ⋯ 菜单开着就"只关菜单、不开文件夹"（还 stopPropagation 挡掉了
       document 那层的关菜单逻辑）—— 结果是文件夹第一次点没反应，得点两次。
       现在一次点击把两件事都做完：关掉菜单 + 打开文件夹。 */
    document.querySelectorAll('.moreMenu').forEach(x => x.remove());
    openBarFolderPanel(chip.getAttribute('data-folder'), nsc);
  });
  bar.addEventListener('contextmenu', e => {
    e.preventDefault();
    const chip = e.target.closest && e.target.closest('[data-folder]');
    const btn = e.target.closest && e.target.closest('[data-tbtn]');
    document.querySelectorAll('.moreMenu').forEach(x => x.remove());
    const pt = { x: e.clientX, y: e.clientY };
    const anchor = chip || btn || bar.querySelector('[data-morebtn-of="' + nsc + '"]') || bar;
    const st = cur();
    if (chip) {
      const f = st.folders.find(x => x.id === chip.getAttribute('data-folder'));
      if (!f) return;
      void openMoreMenu(anchor, [
        { icon: '📂', label: `打开「${f.name}」（排序 / 移出）`, cmd: nsc + ':folder-open:' + f.id },
        { icon: '✎', label: '重命名', cmd: nsc + ':folder-rename:' + f.id },
        { icon: '🗑', label: '删除收藏夹（按钮回到栏上）', cmd: nsc + ':folder-del:' + f.id },
      ], pt);
      return;
    }
    if (btn) {
      const items = [];
      if (btn.style.display === 'none') items.push({ icon: '📌', label: '钉回收藏栏', cmd: nsc + ':btn-pin:' + btn.id });
      else items.push({ icon: '➖', label: '取消钉选（收进 ⋯）', cmd: nsc + ':btn-unpin:' + btn.id });
      for (const f of st.folders) items.push({ icon: '📁', label: `收到「${f.name}」`, cmd: nsc + ':btn-tofolder:' + f.id + ':' + btn.id });
      void openMoreMenu(anchor, items, pt);
      return;
    }
    void openMoreMenu(anchor, [{ icon: '📁', label: '新建收藏夹…', cmd: nsc + ':folder-new' }], pt);
  });
}
/* 兜底：任何一次点击都清掉可能残留的拖拽高亮（虚线框 / 插入线 / 半透明源）。
   浏览器在某些拖拽取消路径下不会派发 dragend，残留的虚线框会一直挂着。 */
document.addEventListener('pointerdown', () => {
  const bars = Object.values(BAR_NS).map(c => document.getElementById(c.bar)).filter(Boolean);
  const dirty = !!BAR_DRAG || bars.some(b => b.classList.contains('dragging') || b.classList.contains('dropOn')
    || b.querySelector('.barDropMark') || b.querySelector('.dropOn'))
    || !!document.querySelector('#barFolderDlg .dropOn');
  if (!dirty) return;
  BAR_DRAG = null;
  bars.forEach(b => {
    b.classList.remove('dragging', 'dropOn');
    b.querySelectorAll('.barDragSrc, .dropOn').forEach(x => x.classList.remove('barDragSrc', 'dropOn'));
  });
  document.querySelectorAll('#barFolderDlg .barDragSrc, #barFolderDlg .dropOn').forEach(x => x.classList.remove('barDragSrc', 'dropOn'));
  barDropMarkHide();
}, true);
/* 文件夹面板：内部上下排序 + 移出收藏夹（按钮可直接点，也可拖回收藏栏） */
function openBarFolderPanel(fid, ns) {
  const nsc = ns || 'tut';
  document.querySelectorAll('#barFolderDlg').forEach(x => x.remove());
  const st = barState(nsc);
  const f = st && (st.folders || []).find(x => x.id === fid);
  if (!f) return toast('收藏夹不存在');
  const labels = {};
  const cfg = barNs(nsc);
  const scope = document.getElementById(cfg.bar);
  (scope && scope.parentElement ? scope.parentElement : document).querySelectorAll('[data-tbtn]')
    .forEach(b => { labels[b.id] = b.textContent.trim(); });
  document.querySelectorAll('[data-tbtn]').forEach(b => { if (!labels[b.id]) labels[b.id] = b.textContent.trim(); });
  /* 当前目标没启用的组件（按钮不在 DOM 里）：根本不列出来 —— 没开启就是没有 */
  const avail = new Set(Object.keys(labels));
  const m = document.createElement('div');
  m.id = 'barFolderDlg';
  m.dataset.barNs = nsc;
  m.className = 'barFolderPanel';
  const commit = () => {
    barSave(st, nsc);
    applyBarOverflow(nsc);
    paint();
  };
  /* 只列"当前目标真的可用"的按钮（没启用的组件不显示）。
     ⚠️ 这个必须能在外层（m.innerHTML 拼头部计数时）也调用 —— 之前把 availN 声明在
     paint() 里、外面却用它，一打开文件夹就 ReferenceError，表现是"文件夹点不动"。 */
  const shownList = () => (f.buttons || []).map((id, i) => ({ id, i })).filter(x => avail.has(x.id));
  const paint = () => {
    const shown = shownList();
    m.querySelector('#tfpList').innerHTML = shown.map(({ id, i }) =>
      `<div class="tfpRow" draggable="true" data-tfpid="${esc(id)}"><span class="tfpGrip" title="拖动排序">⠿</span>
       <span class="tfpName">${esc(barItemLabel(id, labels))}</span>
       <button class="btn tiny" data-tfp-up="${i}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
       <button class="btn tiny" data-tfp-down="${i}" ${i === f.buttons.length - 1 ? 'disabled' : ''} title="下移">↓</button>
       <button class="btn tiny" data-tfp-out="${esc(id)}" title="移出收藏夹，回到收藏栏">↩ 移出</button></div>`).join('')
      || '<p class="hint" style="margin:2px 0;">空文件夹 —— 把收藏栏上的按钮拖进来。</p>';
    m.querySelectorAll('[data-tfp-up]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const i = Number(b.getAttribute('data-tfp-up'));
      [f.buttons[i - 1], f.buttons[i]] = [f.buttons[i], f.buttons[i - 1]];
      commit();
    }));
    m.querySelectorAll('[data-tfp-down]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const i = Number(b.getAttribute('data-tfp-down'));
      [f.buttons[i + 1], f.buttons[i]] = [f.buttons[i], f.buttons[i + 1]];
      commit();
    }));
    m.querySelectorAll('[data-tfp-out]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = b.getAttribute('data-tfp-out');
      f.buttons = f.buttons.filter(x => x !== id);
      st.off = st.off.filter(x => x !== id);
      if (!st.order.includes(barTok('b', id))) st.order.push(barTok('b', id));
      commit();
      toast(`「${barItemLabel(id, labels)}」已移回收藏栏`);
    }));
    // 面板内横向拖动排序
    let from = -1;
    m.querySelectorAll('.tfpRow').forEach(row => {
      row.addEventListener('dragstart', e => {
        from = Array.prototype.indexOf.call(m.querySelectorAll('.tfpRow'), row);
        row.classList.add('barDragSrc');
        try { e.dataTransfer.setData('text/plain', 'tfp'); } catch (err) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('barDragSrc');
        m.querySelectorAll('.dropOn').forEach(x => x.classList.remove('dropOn'));
        from = -1;
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        m.querySelectorAll('.dropOn').forEach(x => { if (x !== row) x.classList.remove('dropOn'); });
        row.classList.add('dropOn');
      });
      // relatedTarget 才是"从哪来"；只判 e.target 会漏掉从行内子元素离开的情况
      row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('dropOn'); });
      row.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('dropOn');
        if (from < 0) return;
        const to = Array.prototype.indexOf.call(m.querySelectorAll('.tfpRow'), row);
        if (to < 0 || to === from) return;
        const id = f.buttons.splice(from, 1)[0];
        f.buttons.splice(to, 0, id);
        commit();
      });
    });
  };
  m.innerHTML = `<div class="tdHead"><span>📁 ${esc(f.name)}</span><span class="muted" style="font-weight:400">${shownList().length} 个</span>
    <button class="btn tiny" id="tfpRename">重命名</button><button class="btn tiny" id="tfpX">×</button></div>
    <div class="tdBody"><p class="hint" style="margin-top:0;">↑↓ 或直接拖动排序；「移出」把按钮放回收藏栏（也可直接把收藏栏按钮拖回这里）。</p>
    <div class="tfpList" id="tfpList"></div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('#tfpX').addEventListener('click', close);
  m.querySelector('#tfpRename').addEventListener('click', () => {
    const name = (prompt('重命名收藏夹：', f.name) || '').trim().slice(0, 20);
    if (!name) return;
    f.name = name;
    commit();
  });
  m.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('.tfpRow');
    if (!row || e.target.closest('button')) return;
    const id = row.getAttribute('data-tfpid');
    const t = document.getElementById(id);
    close();
    if (t) t.click();
  });
  const away = ev => {
    if (m.contains(ev.target)) return;
    if (ev.target.closest && ev.target.closest('[data-folder]')) return;
    close();
    document.removeEventListener('click', away, true);
  };
  paint();
  // 定位到文件夹 chip 附近
  const chip = document.querySelector('[data-folder="' + fid + '"]');
  if (chip) {
    const r = chip.getBoundingClientRect();
    if (r.width || r.height) {
      m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 356)) + 'px';
      m.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 12)) + 'px';
    }
  }
  setTimeout(() => document.addEventListener('click', away, true), 0);
}
/* 收藏夹 / 按钮命令分发 */
document.addEventListener('click', e => {
  const c = e.target.closest && e.target.closest('[data-cmd]');
  if (!c) return;
  let cmd = c.getAttribute('data-cmd');
  const closeMenus = () => document.querySelectorAll('.moreMenu').forEach(x => x.remove());
  // 命令统一带命名空间前缀 "<ns>:<动作>"，两条栏共用一套分发
  let ns = 'tut';
  const sep = cmd.indexOf(':');
  if (sep > 0 && BAR_NS[cmd.slice(0, sep)]) { ns = cmd.slice(0, sep); cmd = cmd.slice(sep + 1); }
  if (cmd === 'customize') { closeMenus(); openBarEditor(ns); return; }
  const st = barState(ns) || { seen: [], off: [], order: [], folders: [] };
  const save = () => { barSave(st, ns); applyBarOverflow(ns); };
  if (cmd === 'folder-new') {
    const name = (prompt('收藏夹名字：', '') || '').trim().slice(0, 20);
    closeMenus();
    if (!name) return;
    st.folders.push({ id: 'f' + Date.now().toString(36), name, buttons: [] });
    st.order.push(barTok('f', st.folders[st.folders.length - 1].id));
    save();
    return;
  }
  if (cmd === 'pin-all') {
    closeMenus();
    st.off = [];
    save();
    toast('已把全部按钮钉回收藏栏');
    return;
  }
  let m = cmd.match(/^folder-open:(.+)$/);
  if (m) {
    closeMenus();
    openBarFolderPanel(m[1], ns);
    return;
  }
  m = cmd.match(/^folder-rename:(.+)$/);
  if (m) {
    const f = st.folders.find(x => x.id === m[1]);
    closeMenus();
    if (!f) return;
    const name = (prompt('重命名收藏夹：', f.name) || '').trim().slice(0, 20);
    if (!name) return;
    f.name = name;
    save();
    return;
  }
  m = cmd.match(/^folder-del:(.+)$/);
  if (m) {
    const f = st.folders.find(x => x.id === m[1]);
    closeMenus();
    if (!f) return;
    if (!confirm(`删除收藏夹「${f.name}」？里面的按钮会回到收藏栏上。`)) return;
    for (const id of (f.buttons || [])) if (!st.order.includes(barTok('b', id))) st.order.push(barTok('b', id));
    st.folders = st.folders.filter(x => x.id !== f.id);
    save();
    return;
  }
  m = cmd.match(/^btn-unpin:(.+)$/);
  if (m) {
    closeMenus();
    st.order = st.order.filter(t => t !== barTok('b', m[1]));
    st.off.push(m[1]);
    save();
    return;
  }
  m = cmd.match(/^btn-pin:(.+)$/);
  if (m) {
    closeMenus();
    st.off = st.off.filter(x => x !== m[1]);
    if (!st.seen.includes(m[1])) st.seen.push(m[1]);
    if (!st.order.includes(barTok('b', m[1]))) st.order.push(barTok('b', m[1]));
    save();
    return;
  }
  m = cmd.match(/^btn-tofolder:(.+):(.+)$/);
  if (m) {
    const f = st.folders.find(x => x.id === m[1]);
    closeMenus();
    if (!f) return;
    if (f.buttons.includes(m[2])) return;
    for (const g of st.folders) g.buttons = g.buttons.filter(x => x !== m[2]);
    st.order = st.order.filter(t => t !== barTok('b', m[2]));
    st.off = st.off.filter(x => x !== m[2]);
    if (!st.seen.includes(m[2])) st.seen.push(m[2]);
    f.buttons.push(m[2]);
    save();
    toast(`已收到收藏夹「${f.name}」`);
  }
});
/* 收藏栏编辑器：勾选钉选 + 上下排序 + 收藏夹管理 */
function openBarEditor(ns) {
  const nsc = ns || 'tut';
  document.querySelectorAll('#barBarDlg').forEach(x => x.remove());
  const cfg = barNs(nsc);
  const scope = document.getElementById(cfg.bar);
  const btns = Array.from((scope && scope.parentElement ? scope.parentElement : document).querySelectorAll('[data-tbtn]')).filter(b => !b.hidden);
  const ids = btns.map(b => b.id);
  const labels = {};
  btns.forEach(b => { labels[b.id] = b.textContent.trim(); });
  const st = barState(nsc) || { seen: ids.slice(), off: [], order: ids.map(id => barTok('b', id)), folders: [] };
  barNorm(st, ids);
  const folderOf = id => barFolderOf(st, id);
  // 只在"散着的按钮"之间排序：文件夹 token 原样保留
  const looseOf = order => order.filter(t => t.startsWith('b:') && !folderOf(t.slice(2)));
  const m = document.createElement('div');
  m.id = 'barBarDlg';
  m.dataset.barNs = nsc;
  m.className = 'tutDialog';
  const commit = (repaint = true) => {
    barSave(st, nsc);
    applyBarOverflow(nsc);
    if (repaint) paint();
  };
  const swapLoose = (a, b) => {
    const loose = looseOf(st.order);
    const ta = st.order[st.order.indexOf(a)], tb = st.order[st.order.indexOf(b)];
    const ia = st.order.indexOf(a), ib = st.order.indexOf(b);
    st.order[ia] = tb;
    st.order[ib] = ta;
    void loose;
  };
  const paint = () => {
    const loose = looseOf(st.order);
    const inBar = loose.map(t => t.slice(2));
    /* 当前目标没启用的组件（按钮不在 DOM 里）：它其实不在工具栏上，
       不该以"钉着 #N"的样子出现在这里 —— 收进下面那条说明。
       注意 data-bar-up/down 用的仍是 loose 里的下标，所以这里只跳过渲染、不重排数组。 */
    const avail = new Set(ids);
    const notMine = inBar.filter(id => !avail.has(id));
    m.querySelector('#barBarList').innerHTML = loose.map((t, i) => {
      const id = t.slice(2);
      if (!avail.has(id)) return '';
      return `<div class="impItem"><input type="checkbox" data-bar-pick="${esc(id)}" checked>
       <b>${esc(barItemLabel(id, labels))}</b><span class="muted">#${i + 1}</span>
       <span style="flex:1"></span>
       <button class="btn tiny" data-bar-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
       <button class="btn tiny" data-bar-down="${i}" ${i === loose.length - 1 ? 'disabled' : ''}>↓</button>
       <button class="btn tiny danger" data-bar-del="${esc(id)}" title="取消钉选，收进 ⋯">×</button></div>`; }).join('')
      + ids.filter(id => !inBar.includes(id) && !folderOf(id)).map(id =>
      `<div class="impItem"><input type="checkbox" data-bar-pick="${esc(id)}">
       <b>${esc(barItemLabel(id, labels))}</b><span class="muted">在 ⋯ 里</span>
       <span style="flex:1"></span>
       ${(st.folders || []).map(f => `<button class="btn tiny" data-bar-tof="${esc(f.id)}:${esc(id)}" title="收到「${esc(f.name)}」">📁 ${esc(f.name)}</button>`).join('')}
      </div>`).join('')
    m.querySelector('#barFolderList').innerHTML = (st.folders || []).map(f =>
      `<div class="impItem"><span>📁</span><b>${esc(f.name)}</b>
       <span class="muted">${f.buttons.filter(id => avail.has(id)).length} 个：${esc(f.buttons.filter(id => avail.has(id)).map(id => barItemLabel(id, labels)).join('、') || '空')}</span>
       <span style="flex:1"></span>
       <button class="btn tiny" data-fdl-open="${esc(f.id)}">打开</button>
       <button class="btn tiny" data-fdl-rename="${esc(f.id)}">重命名</button>
       <button class="btn tiny danger" data-fdl-del="${esc(f.id)}">删除</button></div>`).join('')
      || '<p class="hint" style="margin:0;">还没有收藏夹。在收藏栏上右键即可新建。</p>';
    m.querySelectorAll('[data-bar-up]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-bar-up'));
      swapLoose(loose[i - 1], loose[i]);
      commit();
    }));
    m.querySelectorAll('[data-bar-down]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-bar-down'));
      swapLoose(loose[i], loose[i + 1]);
      commit();
    }));
    m.querySelectorAll('[data-bar-del]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-bar-del');
      st.order = st.order.filter(t => t !== barTok('b', id));
      if (!st.off.includes(id)) st.off.push(id);
      commit();
    }));
    m.querySelectorAll('[data-bar-pick]').forEach(c => c.addEventListener('change', () => {
      const id = c.getAttribute('data-bar-pick');
      if (c.checked) {
        st.off = st.off.filter(x => x !== id);
        if (!st.order.includes(barTok('b', id))) st.order.push(barTok('b', id));
      } else {
        st.order = st.order.filter(t => t !== barTok('b', id));
        if (!st.off.includes(id)) st.off.push(id);
      }
      commit();
    }));
    m.querySelectorAll('[data-bar-tof]').forEach(b => b.addEventListener('click', () => {
      const [fid, bid] = b.getAttribute('data-bar-tof').split(':');
      const f = st.folders.find(x => x.id === fid);
      if (!f) return;
      st.order = st.order.filter(t => t !== barTok('b', bid));
      st.off = st.off.filter(x => x !== bid);
      if (!f.buttons.includes(bid)) f.buttons.push(bid);
      commit();
    }));
    m.querySelectorAll('[data-fdl-open]').forEach(b => b.addEventListener('click', () => openBarFolderPanel(b.getAttribute('data-fdl-open'), nsc)));
    m.querySelectorAll('[data-fdl-rename]').forEach(b => b.addEventListener('click', () => {
      const f = st.folders.find(x => x.id === b.getAttribute('data-fdl-rename'));
      if (!f) return;
      const name = (prompt('重命名收藏夹：', f.name) || '').trim().slice(0, 20);
      if (!name) return;
      f.name = name;
      commit();
    }));
    m.querySelectorAll('[data-fdl-del]').forEach(b => b.addEventListener('click', () => {
      const f = st.folders.find(x => x.id === b.getAttribute('data-fdl-del'));
      if (!f) return;
      if (!confirm(`删除收藏夹「${f.name}」？里面的按钮会回到收藏栏上。`)) return;
      for (const id of (f.buttons || [])) if (!st.order.includes(barTok('b', id))) st.order.push(barTok('b', id));
      st.folders = st.folders.filter(x => x.id !== f.id);
      commit();
    }));
  };
  m.innerHTML = `<div class="tdHead"><span>⭐</span><span>自定义工具栏</span><button class="btn tiny" id="bbdX">×</button></div>
    <div class="tdBody"><p class="hint" style="margin-top:0;">勾选=钉到收藏栏，↑↓ 调顺序（收藏栏上直接横向拖动也一样）；文件夹在这里管理。只保存在这台设备。</p>
    <div class="impList" id="barBarList"></div>
    <div class="tdHead" style="border:0;padding-left:0;padding-right:0;"><span>📁 收藏夹</span></div>
    <div class="impList" id="barFolderList"></div></div>`;
  document.body.appendChild(m);
  m.querySelector('#bbdX').addEventListener('click', () => m.remove());
  paint();
}

/* ============ 教程阅读视图：宽度可拖 + Ctrl+滚轮只缩放正文 ============
   两个诉求（用户提的）：
     ① 正文宽度现在写死 100%，只有放大整个页面才能调整 → 拖右边缘改宽度
     ② Ctrl+滚轮希望只改**教程内**的字号；在教程外仍是浏览器整体缩放
   都存本机 localStorage（阅读偏好，不做多端同步）。 */
function tutView() {
  if (!state.tutView) {
    let v = { w: 0, z: 1 };
    try { v = Object.assign(v, JSON.parse(localStorage.getItem('sierxing-tut-view') || '{}') || {}); } catch (e) {}
    v.w = Math.max(0, Math.min(2400, Number(v.w) || 0));
    v.z = Math.max(0.7, Math.min(2.2, Number(v.z) || 1));
    state.tutView = v;
  }
  return state.tutView;
}
function tutViewSave() {
  try { localStorage.setItem('sierxing-tut-view', JSON.stringify(tutView())); } catch (e) {}
}
function tutViewApply() {
  const v = tutView();
  const rs = document.documentElement.style;
  rs.setProperty('--tut-w', v.w ? v.w + 'px' : '100%');   // 100% = 跟随容器（默认）
  rs.setProperty('--tut-zoom', String(v.z));
  /* HTML 教程在 iframe 里：用户看不到主文档的 CSS 变量，得写进它自己的文档。
     用 zoom（而不是只改根字号）—— 教程里的 px 字号也才会跟着变。 */
  try {
    const d = tutDoc();
    if (d && d !== document && d.documentElement) d.documentElement.style.zoom = String(v.z);
  } catch (e) {}
}
function tutZoomBy(delta) {
  const v = tutView();
  v.z = Math.max(0.7, Math.min(2.2, Math.round((v.z + delta) * 100) / 100));
  tutViewSave();
  tutViewApply();
  toast('正文字号 ' + Math.round(v.z * 100) + '%（Ctrl+滚轮调整；双击边缘线复位）');
}
/* 只在教程页生效；两侧都绑：主文档（Markdown 教程）+ iframe 内（HTML 教程） */
function tutWheelBind(win) {
  if (!win || win.__tutWheel) return;
  win.__tutWheel = ev => {
    if (!ev.ctrlKey) return;                 // 没按 Ctrl → 放行给浏览器（整页缩放）
    /* 主文档里要判"鼠标是否落在教程框内" —— 否则整页任何位置 Ctrl+滚轮都会改字号，
       浏览器自己的整页缩放反而没了（用户报的第二个问题）。
       iframe 里不用判：整个 iframe 就是教程。 */
    if (win === window) {
      const c = (document.getElementById('app') || document).querySelector('.tutFrame, .tutBody');
      if (!c) return;
      const r = c.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    }
    ev.preventDefault();                     // 框内 + 按了 Ctrl → 只改正文字号
    tutZoomBy(ev.deltaY < 0 ? 0.1 : -0.1);
  };
  win.addEventListener('wheel', win.__tutWheel, { passive: false });
}
function tutViewInit() {
  try { tutViewApply(); } catch (e) {}
  tutWheelBind(window);
  const f = document.getElementById('tutFrame');
  if (f) {
    const hook = () => { tutViewApply(); try { tutWheelBind(f.contentWindow); } catch (e) {} };
    f.addEventListener('load', hook);
    hook();
  }
  /* 拖右边缘改宽度：鼠标离正文列右边缘 14px 内出现 col-resize，按住横拖 */
  const host = document.getElementById('app');
  if (!host || host.__tutResize) return;
  host.__tutResize = true;
  const col = () => host.querySelector('.tutFrame') || host.querySelector('.tutBody');
  let dragging = false, startX = 0, startW = 0;
  host.addEventListener('mousemove', ev => {
    if (dragging) return;
    const c = col(); if (!c) return;
    const r = c.getBoundingClientRect();
    host.style.cursor = (ev.clientX > r.right - 14 && ev.clientX < r.right + 14) ? 'col-resize' : '';
  });
  host.addEventListener('mousedown', ev => {
    const c = col(); if (!c) return;
    const r = c.getBoundingClientRect();
    if (!(ev.clientX > r.right - 14 && ev.clientX < r.right + 14)) return;
    ev.preventDefault();
    dragging = true; startX = ev.clientX; startW = r.width;
    document.body.classList.add('tutResizing');
  });
  document.addEventListener('mousemove', ev => {
    if (!dragging) return;
    const v = tutView();
    v.w = Math.max(420, Math.min(2400, Math.round(startW + (ev.clientX - startX) * 2)));
    tutViewApply();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('tutResizing');
    tutViewSave();
    toast('正文宽度 ' + tutView().w + 'px（双击边缘线恢复自适应）');
  });
  /* 双击边缘线 → 恢复自适应宽度 + 100% 字号 */
  host.addEventListener('dblclick', ev => {
    const c = col(); if (!c) return;
    const r = c.getBoundingClientRect();
    if (!(ev.clientX > r.right - 14 && ev.clientX < r.right + 14)) return;
    state.tutView = { w: 0, z: 1 };
    tutViewSave(); tutViewApply();
    toast('已恢复默认宽度与字号');
  });
}
async function renderTutorialPage(tid) {
  app.innerHTML = '<p class="muted">加载教程…</p>';
  try { window.__tutCur = null; window.__tutTotal = 0; } catch (e) {}
  const r = await api('/api/tutorials/' + tid);
  const t = r.tutorial, node = r.node, goal = r.goal;
  state.tutGoalId = t ? t.goal_id : 0;   // 侧边栏绑定到该目标的会话（刷新也不丢记录）
  state.tutGoal = goal || null;          // 教程语境目标：组件开关按它判定，不串到别的目标
  state.tutUpdatedAt = t ? (t.updated_at || '') : '';   // 任务轮询用它判断内容是否真变了
  await ensureCiteCache(t ? t.goal_id : 0);   // 正文里的 [id] 引用要能解释成节点/资料
  const isHtml = t.format === 'html';
  try { state.tutFmt = t.format; state.tutNodeId = node ? node.id : 0; } catch (e) {}
  /* 记下**这份被渲染的源码**：就地编辑单块按 data-src/data-srce 切行要用它，
     必须与生成 DOM 的是同一份（重新 GET 一份万一不一致，行号就错位了）。 */
  tutRenderedSrc = isHtml ? '' : (t.content || '');
  const sizeK = Math.max(1, Math.round((t.content || '').length / 1000));
  app.innerHTML = `<div class="tutPage">
    <div class="tutSticky">
    <div class="tutHead">
      <button class="back" data-go="#/g/${t.goal_id}">← 返回目标</button>
      <button class="btn small" data-tbtn id="tutEditBtn" title="在右侧对话栏里说你想怎么改，AI 会按意见修改（保留原有内容，只改需要改的地方）">💬 让 AI 修改</button>
      <button class="btn small" data-tbtn id="tutVersBtn" title="每次 AI 修改/手动保存都会留一版，改坏了从这里恢复（恢复前会自动存当前版，所以恢复也可撤销）">🕘 历史版本</button>
      <button class="btn small" data-tbtn id="tutTocBtn" title="显示 / 隐藏左侧目录">📑 目录</button>
      ${((goalCompOn(goal, 'notes') || goalCompOn(goal, 'tutnotes')) && window.NodeNotes) ? `<button class="btn small" data-tbtn id="tutNoteBtn" title="展开 / 收起右侧笔记栏（🗒 Markdown 笔记 / 📌 划线笔记 两个页签）">🗒 笔记</button>` : ''}
      ${(goalCompOn(goal, 'tutbookmark') && window.TutBookmark) ? `<button class="btn small" data-tbtn id="tutBmBtn" title="随时标记阅读位置（不用翻到底部）">🔖 标签</button>` : ''}
      ${goalCompOn(goal, 'restate') ? `<button class="btn small" data-tbtn id="tutRestateBtn" title="循序渐进把知识点变成你自己的话：先搞懂前因后果，AI 一次只追问最关键的一个缺口、给方向不给答案">🧠 用自己的话</button>` : ''}
      ${goalCompOn(goal, 'quiz') ? `<button class="btn small" data-tbtn id="tutQuizBtn" title="按这篇教程逐点考察掌握情况（一次一题，答错可追问）">📝 测验</button>` : ''}
      ${(goalCompOn(goal, 'workspace') && window.Workspace) ? `<button class="btn small primary" data-tbtn id="tutCodeBtn" title="为当前节点建好代码目录并用 VSCode 打开，边看教程边写代码（子目录嵌在父目录下，无需手动管理）">💻 写代码</button>` : ''}
      ${(goalCompOn(goal, 'workspace') && window.Workspace) ? `<button class="btn small" data-tbtn id="tutPackBtn" title="把整个目标的代码目录一键打包成 zip 下载">📦 打包</button>` : ''}
      <button class="btn small" data-tbtn id="tutManualBtn" title="直接手动编辑并保存。也可以直接在正文里点某一段：会进编辑并定位到那一句（Markdown 教程）">✎ 手动编辑</button>
      <button class="btn small" data-tbtn id="tutRenameBtn" title="给这份教程改个名（只改标题，正文不动）。同一个任务生成的多份教程全靠标题区分">✎ 重命名</button>
      <button class="btn small primary" id="tutSaveBtn" hidden>💾 保存</button>
      <button class="btn small" id="tutCancelBtn" hidden>取消</button>
      <span class="mapTitle" id="tutTitle">📘 ${esc(t.title)}</span>
      <span class="chip gray">${isHtml ? 'HTML' : 'Markdown'}</span>
      <span class="chip gray">约 ${sizeK}k 字</span>
      <div class="spacer"></div>
      <button class="btn small" id="tutMoreBtn" data-morebtn-of="tut" hidden>⋯</button>
      <button class="btn small" data-tbtn id="tutDl">下载</button>
      <button class="btn small danger" data-tbtn id="tutDel">删除</button>
    </div>
    <div class="tutFavBar" id="tutFavBar" hidden></div>
    </div>
    <div class="tutMeta">${node ? '对应任务：' + esc(node.title) : ''}${goal ? '　·　所属目标：' + esc(goal.title) : ''}　·　生成于 ${esc(fmtDate(t.created_at))}${(goalCompOn(goal, 'workspace') && window.Workspace) ? '　·　<span class="wsHint" id="wsHint"></span>' : ''}</div>
    ${isHtml
      ? `<iframe class="tutFrame" id="tutFrame" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`
      : `<div class="tutBody mdBody">${mdToHTML(t.content, { viz: true, srcLines: true })}</div>`}
    <!-- 书签为浮动面板（顶栏按钮呼出），此处不占位 -->
  </div>`;
  if (isHtml) {
    const fr = document.getElementById('tutFrame');
    /* HTML 教程正文在 iframe 里，得等它 load 完才有 headings。
       以前统一 setTimeout(200) —— iframe 内容多的时候 200ms 还没解析完，
       tutTocBuild 拿到 0 个标题就静默 return，表现为"目录组件失效"。 */
    let built = false;
    const build = () => {
      if (built) return; built = true;
      try { tutTocBuild(tid); } catch (e) {}
      /* 体检正文自带目录：锚点不存在 = 教程被截断（点目录没反应的真正原因） */
      try {
        const dead = tutBodyAnchors().filter(x => x.dead);
        if (dead.length) tutTruncNotice(dead);
      } catch (e) { console.warn('[tutorial] 截断体检失败', e); }
    };
    fr.addEventListener('load', build, { once: true });
    fr.setAttribute('srcdoc', withCiteHook(tutThemedHTML(rewriteCites(cleanHtmlForFrame(t.content)))));
    setTimeout(build, 1500);   // 兜底：万一 load 没触发
  }
  setTimeout(() => { try { tutTocBuild(tid); } catch (e) {} }, 200);   // 侧边目录大纲
  const tutNoteBtn = document.getElementById('tutNoteBtn');
  if (tutNoteBtn && window.NodeNotes && (goalCompOn(goal, 'notes') || goalCompOn(goal, 'tutnotes'))) {
    const nid = node ? node.id : 0;
    tutNoteBtn.addEventListener('click', () => window.NodeNotes.toggle(tid, nid, node ? node.title : ''));
    if (nid) window.NodeNotes.mount(tid, nid, node.title);
  }
  const tutTocBtn = document.getElementById('tutTocBtn');
  if (tutTocBtn) tutTocBtn.addEventListener('click', () => {
    try {
      const v = localStorage.getItem('sierxing-toc-open') !== '0';
      localStorage.setItem('sierxing-toc-open', v ? '0' : '1');
    } catch (e) {}
    try { tutTocBuild(tid); } catch (e) {}
  });
  if (window.TutBookmark && goalCompOn(goal, 'tutbookmark')) {
    window.TutBookmark.badge(tid);
    const tbb = document.getElementById('tutBmBtn');
    if (tbb) tbb.addEventListener('click', () => window.TutBookmark.toggle(tid));
  }
  /* 划线笔记：正文可能是主文档（Markdown），也可能是 iframe（HTML）—— 插件自己等正文就绪。
     入口已并进右侧「🗒 笔记」栏的「📌 划线笔记」页签（TutNotes.renderInto），工具条上不再单设按钮：
     两个按钮一个功能只会互相矛盾，这里只负责装载状态机 + 把监听挂到正文上。 */
  if (window.TutNotes && goalCompOn(goal, 'tutnotes')) {
    try { window.TutNotes.mount(tid); } catch (e) { console.warn('[tutnotes] mount 失败', e); }
  }
  if (goalCompOn(goal, 'restate')) {
    const trs = document.getElementById('tutRestateBtn');
    if (trs) trs.addEventListener('click', () => { location.hash = '#/t/' + tid + '/restate'; });
  }
  if (goalCompOn(goal, 'quiz')) {
    const tq = document.getElementById('tutQuizBtn');
    if (tq) tq.addEventListener('click', () => { location.hash = '#/t/' + tid + '/quiz'; });
  }
  applyBarOverflow('tut');

  if (window.Workspace && goalCompOn(goal, 'workspace')) {
    try { window.Workspace.bindTutorial(tid, node, goal); } catch (e) {}
  }
  const tutRenameBtn = document.getElementById('tutRenameBtn');
  if (tutRenameBtn) tutRenameBtn.addEventListener('click', () => openTutRename(tid, t));
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
      <button class="back" data-back="#/g/${data.version.goal_id}">← 返回</button>
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
  if (!goalCompOn(goalCtx(), 'versions')) { toast('「版本对比与汇报」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
  const { versions } = await api('/api/goals/' + goalId + '/versions');
  const old = document.getElementById('versionsPanel');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'versionsPanel';
  div.className = 'versionsPanel';
  let h = `<div class="vpHead"><span>📜 版本历史</span><div class="spacer"></div><button class="btn tiny primary" id="vpSave">📌 保存当前方案</button><button class="btn tiny" id="vpClose">×</button></div>`;
  h += `<div class="vpBody">`;
  if (!versions.length) h += '<div class="empty">还没有版本记录。每次规划/调整/拆分后会自动生成版本，也可以点右上「📌 保存当前方案」手动存一版。</div>';
  for (const v of versions.slice(0, 8)) {
    h += versionItemHTML(v, goalId);
  }
  h += `</div>`;
  h += `<div class="vpFoot"><a class="btn small" href="#/g/${goalId}/versions">📂 打开版本管理页（全部 · 可收藏）</a></div>`;
  div.innerHTML = h;
  document.body.appendChild(div);
  document.getElementById('vpClose').addEventListener('click', () => div.remove());
  bindVersionItems(div, goalId, () => showVersionsPanel(goalId));
}
/* 版本条目（面板与管理页共用） */
function versionItemHTML(v, goalId) {
  return `<div class="vpItem" data-vid="${v.id}">
    <div class="vpTop"><button class="vpStar ${Number(v.starred) ? 'on' : ''}" data-vp-star="${v.id}" title="${Number(v.starred) ? '已收藏（再点取消）' : '收藏这一版，方便找回'}">${Number(v.starred) ? '★' : '☆'}</button>${Number(v.manual) ? '<span class="chip ok">📌 手动保存</span>' : ''}<span class="chip gray">${esc(v.reason || '变更')}</span><span class="hint">${fmtDate(v.created_at)}</span></div>
    ${v.summary ? `<div class="vpSummary">${mdOneLine(v.summary)}</div>` : '<div class="vpSummary muted">（无汇报）</div>'}
    <div class="vpOps"><a class="btn small" href="#/g/${goalId}/diff/${v.id}">查看对比图</a><button class="btn small danger" data-vp-restore="${v.id}" title="先自动存档当前，再整体回到这一版（含任务进度状态）">恢复到此版</button></div>
  </div>`;
}
/* 版本条目按钮绑定（面板/管理页共用；after 为操作成功后的刷新回调） */
function bindVersionItems(root, goalId, after) {
  const rerun = after || (() => {});
  const sv = root.querySelector('#vpSave');
  if (sv) sv.addEventListener('click', async () => {
    const name = (prompt('给这版方案起个名（例如：偏实战版 / 保守版）：', '') || '').trim();
    if (!name) return;
    sv.disabled = true;
    try {
      await api('/api/goals/' + goalId + '/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      toast('已保存方案「' + name + '」，重新规划弄丢了也能找回来');
      rerun();
    } catch (e) { toast(e.message); sv.disabled = false; }
  });
  root.querySelectorAll('[data-vp-star]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const vid = b.getAttribute('data-vp-star');
    const on = !b.classList.contains('on');
    try {
      await api('/api/versions/' + vid + '/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: on }) });
      toast(on ? '已收藏' : '已取消收藏');
      rerun();
    } catch (err) { toast(err.message); }
  }));
  root.querySelectorAll('[data-vp-restore]').forEach(b => b.addEventListener('click', async () => {
    const vid = b.getAttribute('data-vp-restore');
    if (!confirm('恢复到这一版？\n\n当前方案会先自动存档（还可再 undo），然后节点（含任务进度状态）整体替换。\n教程按原节点关联，恢复后旧教程可能对不上新节点 id。')) return;
    b.disabled = true;
    try {
      const r = await api('/api/versions/' + vid + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.goal = r.goal;
      try { await loadGoal(goalId); } catch (e) {}
      const pnl = document.getElementById('versionsPanel');
      if (pnl) pnl.remove();
      rerenderCurrent();
      renderRail();
      toast('已恢复到该版本');
    } catch (e) { toast(e.message); b.disabled = false; }
  }));
}
/* 版本管理独立页：全部版本 + 筛选（收藏/手动保存） */
async function renderVersionsPage(gid) {
  const g = state.goal;
  app.innerHTML = '<p class="muted">加载版本历史…</p>';
  const { versions } = await api('/api/goals/' + gid + '/versions');
  const f = state.verFilter || 'all';
  const counts = { all: versions.length, star: versions.filter(v => Number(v.starred)).length, manual: versions.filter(v => Number(v.manual)).length };
  const list = versions.filter(v => f === 'star' ? Number(v.starred) : f === 'manual' ? Number(v.manual) : true);
  app.innerHTML = `<div class="page"><div class="pageHead">
      <button class="back js-back" data-go="#/g/${gid}">← 返回目标</button>
      <h2 class="title" style="margin-left:10px;">📜 版本管理</h2>
      <span class="chip gray">${esc((g && g.title) || '')}</span>
      <div class="spacer"></div>
      <button class="btn small primary" id="vpSave">📌 保存当前方案</button>
    </div>
    <div class="sec"><div class="ppCats" id="verFilter">
      <button type="button" class="ppCat ${f === 'all' ? 'active' : ''}" data-vf="all">全部（${counts.all}）</button>
      <button type="button" class="ppCat ${f === 'star' ? 'active' : ''}" data-vf="star">⭐ 已收藏（${counts.star}）</button>
      <button type="button" class="ppCat ${f === 'manual' ? 'active' : ''}" data-vf="manual">📌 手动保存（${counts.manual}）</button>
    </div>
    <p class="hint">每次规划/调整/拆分自动存档；看中的版本点 ☆ 收藏；恢复前会自动存档当前，可再 undo。</p></div>
    <div class="sec"><div class="vpGrid">${list.length ? list.map(v => versionItemHTML(v, gid)).join('') : '<div class="muted">这里还没有版本。</div>'}</div></div>
  </div>`;
  app.querySelectorAll('#verFilter [data-vf]').forEach(b => b.addEventListener('click', () => { state.verFilter = b.getAttribute('data-vf'); renderVersionsPage(gid); }));
  bindVersionItems(app, gid, () => renderVersionsPage(gid));
}
function rerenderCurrent() {
  const r = parseRoute();
  if (r.view === 'map' && state.goal) renderMapPage();
  else if (r.view === 'goal' && state.goal) renderGoal();
  else if (r.view === 'tutorial' && r.id) {
    const y = window.scrollY;
    renderTutorialPage(r.id).then(() => { try { window.scrollTo(0, y); } catch (e) {} }).catch(e => toast(e.message));
  }
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
  if (g.status === 'planned' && (state.goal.nodes || []).length) {
    return adjustPanelHTML(g);
  }
  if (g.status === 'planning') {
    return `<div class="planPanel">
      <div class="ppHead"><span>⏸</span><span>上次细化任务中断</span><div class="spacer"></div>
        <button class="btn small primary" id="planResumeBtn">继续细化任务</button></div>
    </div>`;
  }
  return '';
}
/* 已有规划后的骨架调整：看大纲 → 写意见 → AI 按意见重排（回到待确认） */
function adjustPanelHTML(g) {
  const nodes = g.nodes || [];
  const stages = nodes.filter(n => n.level === 0);
  const outline = stages.map(s => {
    const subs = nodes.filter(n => n.parent_id === s.id).map(x => x.title);
    const subTxt = subs.length ? `（${subs.join(' / ')}）` : '（暂无小目标）';
    return `<div class="adjStage"><b>${esc(s.title)}</b><span class="muted">${esc(subTxt.slice(0, 140))}${subTxt.length > 140 ? '…' : ''}</span></div>`;
  }).join('') || '<div class="muted">暂无阶段</div>';
  return `<div class="planPanel adjust">
    <div class="ppHead">${foldBtn('adjust', foldClosed(g.id, 'adjust', true))}<span>🧭</span><span>调整规划骨架（当前 ${stages.length} 个阶段）</span></div>
    <div data-foldbody="adjust"${foldClosed(g.id, 'adjust', true) ? ' hidden' : ''}>
    <div class="adjOutline">${outline}</div>
    <p class="hint" style="margin:8px 0 10px;">告诉 AI 怎么改：增删阶段/小目标、调顺序、跳过已掌握的……会重新生成骨架并回到待确认（已细化的子任务将按新骨架重排）。不想推倒重来就用这个；要点「重新规划」会清空现有路径，请三思。</p>
    <div class="field"><textarea id="planFeedback" placeholder="例如：第二阶段太长，拆成两个 / 加一个「行为经济学」阶段 / 先学微观再学宏观…"></textarea></div>
    <div class="toolbarRow">
      <button class="btn primary" id="planAdjustBtn">按我的意见调整骨架</button>
    </div>
    </div>
  </div>`;
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
  if (!goalCompOn(goalCtx(), 'clarify')) { return startPlanning(id, null); }
  state.planning = true;
  state.planAbort = new AbortController();
  state.planStatus = 'AI 正在分析你的情况，准备澄清问题…';
  state.planHint = 'AI 会先问几个问题（选择/简答），充分了解你的情况后再制定规划。';
  state.showEdit = false;
  if (!state.goal || state.goal.id !== id) await loadGoal(id);
  rerenderCurrent();
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
  rerenderCurrent();
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
    await planResumeCheck(id);
  } else {
    state.planResumeInfo = null;
    state.goal = r.data.goal;
    if (r.data.report) state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id };
    toast('骨架已生成，请确认或提意见');
  }
  const rr = parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) renderMapPage();
}
async function planResumeCheck(id) {
  // 出错后查有没有可继续的草稿，有就记下来让界面出按钮
  try {
    const dr = await api('/api/goals/' + id + '/plan/draft');
    if (dr && dr.draft) state.planResumeInfo = Object.assign({ goalId: id }, dr.draft);
    else if (!state.planResumeInfo || state.planResumeInfo.goalId !== id) state.planResumeInfo = null;
  } catch (e) {}
}
async function startPlanResume(id) {
  if (state.planning || state.collecting || state.expanding) return;
  state.planning = true;
  state.planAbort = new AbortController();
  state.planProgress = null;
  state.planStage = 'skeleton';
  state.planStatus = '正在接着上次的构思继续…';
  state.planHint = '把上次保留的原始构思整理成标准格式，约需 30-90 秒。';
  state.showEdit = false;
  if (!state.goal || state.goal.id !== id) await loadGoal(id);
  state.goal.status = 'planning';
  rerenderCurrent();
  bindPlanningPanel();
  const r = await streamSSE('/api/goals/' + id + '/plan/resume', {}, d => {
    if (d.status) { state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { state.planProgress = d.progress; renderPlanLive(); }
  }, state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  state.planning = false;
  if (r.error || !r.done) {
    toast(r.error || '继续构思中断，可重试');
    try { await loadGoal(id); } catch (e) {}
    await planResumeCheck(id);
  } else {
    state.planResumeInfo = null;
    state.goal = r.data.goal;
    if (r.data.report) state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id };
    toast('已接着上次的构思生成骨架，请确认或提意见');
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
  rerenderCurrent();
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
  rerenderCurrent();
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
/* 资料搜集是**可选**的：用户在问卷里选过「不用」就别再催他。
   以前这里的文案默认"人人都要收集信息源"，对"搞懂自己项目源码"这类目标完全是误导。 */
function collectPrefHint() {
  const p = String((state.goal && state.goal.collect_pref) || '');
  if (p === 'no') return '你说过这次不用搜集资料 —— 需要时随时可以在这里找，或导入代码库';
  if (p === 'later') return '你说过先不搜集 —— 想找的话点「收集信息源」';
  return '可选：按搜集方案找真实资料，规划会优先依据（不收集也能规划）';
}
function sourceItemHTML(s) {
  const body = String(s.content || s.snippet || '').trim();
  const star = Number(s.quality) === 1;
  const sel = state.srcSel && state.srcSel.gid === ((state.goal || {}).id || 0) && state.srcSel.ids.has(String(s.id));
  return `<div class="srcItem ${star ? 'isStar' : ''}">
    <div class="siHead">
      <input type="checkbox" class="siCheck" data-src-check="${s.id}" ${sel ? 'checked' : ''} title="选中（可批量删除）">
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
  const gid = (state.goal && state.goal.id) || 0;
  const srcClosed = foldClosed(gid, 'sources', true);
  let h = `<div class="srcPanel">
    <div class="spHead">
      ${foldBtn('sources', srcClosed)}
      <span class="spTitle">信息源</span><span class="spCount">${list.length}</span>
      <span class="spHint">${collectPrefHint()}</span>
      <div class="spacer"></div>
        <button class="btn small" id="collectBtn">${list.length ? '重新收集' : '收集信息源'}</button>
        <button class="btn small" id="collectPlanBtn" title="说明/选择这次搜什么：AI 按目标推荐搜集方案，可逐条勾选、改写、加自己的">⚙ 搜集方案</button>
        <span class="muted" id="cpSummary" style="font-size:12px;">${esc(collectPlanSummary())}</span>
        <button class="btn small primary" <button class="btn small" id="srcAddBtn" title="粘贴文本、或填写标题与链接，手动添加一条资料（可标为优质信息源）">＋ 添加资料</button>
        <button class="btn small primary" id="digestBtn" title="让 AI 通读全部资料（含你上传的图片资料），提炼成多篇主题汇总，规划时优先依据">🧠 ${digests.length ? '重新提炼' : '信息提炼'}</button>
        ${list.length ? `<button class="btn small danger" id="srcClearBtn" title="删除本目标全部信息源（含已导入的图片/电子书原件），不可恢复">🗑 清空</button>` : ''}
      </div>
    <div data-foldbody="sources"${srcClosed ? ' hidden' : ''}>`;
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
    const gid2 = (state.goal && state.goal.id) || 0;
    const selIds = state.srcSel && state.srcSel.gid === gid2 ? state.srcSel.ids : new Set();
    const selN = list.filter(s => selIds.has(String(s.id))).length;
    h += `<details class="spDetails" id="spDetails"${state.srcListOpen ? ' open' : ''}><summary>查看来源列表（${list.length} 条）</summary>
      <div class="spListBar"><label class="spSelAll"><input type="checkbox" id="srcSelAll" ${selN && selN === list.length ? 'checked' : ''}> 全选</label>
      ${selN ? `<button class="btn tiny danger" id="srcDelSel">删除选中（${selN}）</button>` : '<span class="muted" style="font-size:12px;">勾选可批量删除；每条右侧 × 可单独删除</span>'}
      </div><div class="spList">${list.map(sourceItemHTML).join('')}</div></details>`;
  } else if (!state.collecting) {
    h += '<div class="spEmpty">还没有信息源。建议先「收集信息源」，AI 规划会依据真实 JD 与面经，质量更高。</div>';
  }
  h += '</div></div>';
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
  if (!goalCompOn(goalCtx(), 'sources')) { toast('「信息源检索」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
  if (state.collecting) return;
  if (!(await ensureCollectSetup(id))) return;   // 搜集前确认搜什么+要不要电子书（取消则不搜集）
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
        if (d.done) { done = true; state.sources = d.sources || []; toast('信息源收集完成：' + d.count + ' 条' + (d.ebooks ? '；' + d.ebooks : '') + (d.blocked ? '（百度限流，本次用备用搜索，可稍后重新收集以获取更多）' : '')); }
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
/* 搜集前问电子书：没问过就让 AI 推荐书单，用户勾选+自填，然后再搜集 */
/* 当前搜集方案一句话摘要（面板上可见，不用点开也知道会搜什么） */
function collectPlanSummary() {
  try {
    const p = JSON.parse((state.goal && state.goal.collect_plan) || 'null');
    const qs = (p && p.queries || []).filter(q => q && q.q && q.on !== false);
    if (!qs.length) return '';
    const kinds = [...new Set(qs.map(q => q.kind || '资料'))].slice(0, 5).join('/');
    return `当前方案 ${qs.length} 条（${kinds}）`;
  } catch (e) { return ''; }
}
async function ensureCollectSetup(id, editOnly) {
  let plan = null, pref = null;
  try {
    const [a, b] = await Promise.all([
      api('/api/goals/' + id + '/collect-plan').catch(() => ({})),
      api('/api/goals/' + id + '/ebooks/pref').catch(() => ({}))
    ]);
    plan = a.plan || null; pref = b.pref || null;
  } catch (e) { return true; }
  if (!editOnly && plan && plan.asked && pref && pref.asked) return true;
  toast('AI 正在按目标制定搜集方案…');
  let queries = (plan && plan.queries) || [];
  let books = [];
  try {
    const rs = await Promise.all([
      (plan && plan.asked) ? {} : api('/api/goals/' + id + '/collect-plan/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(e => ({})),
      (pref && pref.asked) ? {} : api('/api/goals/' + id + '/ebooks/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(e => ({}))
    ]);
    if (!(plan && plan.asked)) {
      queries = rs[0].queries || [];
      if (rs[0].error && !queries.length) toast('搜集方案推荐失败：' + rs[0].error + '（可用默认模板或手动填写）');
      if (!queries.length) queries = [];
    }
    if (!(pref && pref.asked)) {
      books = rs[1].books || [];
      if (rs[1].error && !books.length) toast('书单推荐失败：' + rs[1].error + '（可手动填写）');
    }
  } catch (e) { toast('推荐失败，可手动填写：' + e.message); }
  return showCollectSetupDialog(id, { queries, books, pref, editOnly: !!editOnly });
}
function showCollectSetupDialog(gid, opts) {
  const { queries, books, pref, editOnly } = opts;
  const prefAsked = !!(pref && pref.asked);
  const savedWant = (pref && pref.want) || 'auto';
  return new Promise(resolve => {
    document.querySelectorAll('#collectSetupDlg').forEach(x => x.remove());
    const m = document.createElement('div');
    m.id = 'collectSetupDlg';
    m.className = 'bigDialog';
    m.innerHTML = `<div class="tdHead"><span>🔍</span><div class="bdTitle"><div>搜集设置：这次搜什么${prefAsked ? '' : '、要不要电子书'}？</div><div class="bdSub">方案存到本目标上，重复搜集沿用，可随时回来改</div></div><button class="btn tiny" id="csX">×</button></div>
    <div class="tdBody">
      <div class="csSec">
        <div class="csSecHead"><span class="csSecT">📡 查什么</span><span class="csSecD">AI 按目标推荐，可取消勾选、直接改写、下方自加</span><div class="spacer"></div>
          <button class="btn tiny" id="csAll">全选</button><button class="btn tiny" id="csNone">全不选</button></div>
        <div class="csQList" id="csQList"></div>
        <textarea id="csCustom" rows="2" placeholder="自己加搜集方向（每行一条）：例如&#10;央行货币政策解读"></textarea>
      </div>
      <div class="csSec">
        <div class="csSecHead"><span class="csSecT">📚 电子书</span><span class="csSecD">公版老经典自动下载入库，有版权书进待找书单</span></div>
        <div class="ebModes">
          <label class="ebMode"><input type="radio" name="ebWant" value="auto" hidden ${savedWant !== 'list' && savedWant !== 'no' ? 'checked' : ''}><span class="ebModeIn"><b>⬇ 自动下载</b><span>公版书入库，找不到的记待找书单</span></span></label>
          <label class="ebMode"><input type="radio" name="ebWant" value="list" hidden ${savedWant === 'list' ? 'checked' : ''}><span class="ebModeIn"><b>📋 只要书单</b><span>我自己找书导入</span></span></label>
          <label class="ebMode"><input type="radio" name="ebWant" value="no" hidden ${savedWant === 'no' ? 'checked' : ''}><span class="ebModeIn"><b>🚫 不需要</b><span>这次不搞电子书</span></span></label>
        </div>
        <div class="ebBooks" id="ebBooks"></div>
        <textarea id="ebCustom" rows="2" placeholder="自己加书（每行一本，可写《书名》作者）：例如&#10;曼昆《经济学原理》"></textarea>
      </div>
    </div>
    <div class="csFoot">
      <button class="btn primary" id="csOk">${editOnly ? '保存方案' : '保存并开始搜集'}</button>
      ${editOnly ? '' : '<button class="btn" id="csSkip">跳过，直接搜集</button>'}
      <button class="btn" id="csCancel">取消</button>
    </div>`;
    const qList = m.querySelector('#csQList');
    const paintQueries = qs => {
      qList.innerHTML = qs.length ? qs.map((q, i) => `<div class="csQ">
          <input type="checkbox" data-cpq="${i}" ${q.on !== false && q.q ? 'checked' : ''}>
          <span class="chip">${esc(q.kind || '资料')}</span>
          <input class="cpQText" data-cpqtext="${i}" value="${esc(q.q || '')}" maxlength="120" placeholder="写一条完整可搜的问题/方向"></div>`).join('')
        : `<div class="csWarn">这次没推荐出来（AI 开小差了），可以点 <button class="btn tiny" id="csRetry">重新推荐</button>，或直接在下面写搜集方向。</div>`;
      const rt = m.querySelector('#csRetry');
      if (rt) rt.addEventListener('click', async () => {
        rt.disabled = true; rt.textContent = '推荐中…';
        try {
          const rr = await api('/api/goals/' + gid + '/collect-plan/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (rr.queries && rr.queries.length) { queries = rr.queries; paintQueries(queries); }
          else { rt.disabled = false; rt.textContent = '重新推荐'; toast((rr && rr.error) || '还是没推荐出来，手动写两条也行'); }
        } catch (e) { rt.disabled = false; rt.textContent = '重新推荐'; toast(e.message); }
      });
    };
    let liveQueries = queries && queries.length ? queries : [{ kind: '资料', q: '', days: 365, on: false }, { kind: '资料', q: '', days: 365, on: false }];
    paintQueries(liveQueries);
    const ebBox = m.querySelector('#ebBooks');
    ebBox.innerHTML = books.length ? books.map((b, i) => `<label class="ebBook"><input type="checkbox" data-ebbook="${i}" checked>
        <span class="ebCover">📖</span>
        <span class="ebInfo"><b>《${esc(b.title)}》${b.author ? `<span class="muted">　${esc(b.author)}</span>` : ''}</b>
        ${b.pitch ? `<span class="ebPitch">${esc(b.pitch)}</span>` : ''}
        <span class="ebWhere">${b.public_domain ? '<span class="chip ok">公版可直下</span>' : ''}${b.where ? `<span class="muted">去哪找：${esc(b.where)}</span>` : ''}</span></span></label>`).join('')
      : '<div class="muted">这次没推荐出来，直接在下面写书名也行。</div>';
    document.body.appendChild(m);
    const close = v => { m.remove(); resolve(v); };
    m.querySelector('#csX').addEventListener('click', () => close(editOnly ? true : false));
    m.querySelector('#csCancel').addEventListener('click', () => close(editOnly ? true : false));
    const all = m.querySelector('#csAll'), none = m.querySelector('#csNone');
    if (all) all.addEventListener('click', () => m.querySelectorAll('[data-cpq]').forEach(x => { x.checked = true; }));
    if (none) none.addEventListener('click', () => m.querySelectorAll('[data-cpq]').forEach(x => { x.checked = false; }));
    const skip = m.querySelector('#csSkip');
    if (skip) skip.addEventListener('click', async () => {
      try {
        await api('/api/goals/' + gid + '/collect-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: liveQueries }) });
        await api('/api/goals/' + gid + '/ebooks/pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ want: 'no', books: [] }) });
      } catch (e) {}
      close(true);
    });
    m.querySelector('#csOk').addEventListener('click', async () => {
      const qs = Array.from(m.querySelectorAll('[data-cpq]')).map(x => {
        const i = Number(x.getAttribute('data-cpq'));
        const t = m.querySelector(`[data-cpqtext="${i}"]`);
        return { kind: (liveQueries[i] && liveQueries[i].kind) || '资料', q: (t && t.value.trim()) || '', days: (liveQueries[i] && liveQueries[i].days) || 365, on: x.checked };
      }).filter(x => x.q);
      const custom = (m.querySelector('#csCustom').value || '').split(/[\n,，、；;]+/).map(x => x.trim()).filter(Boolean)
        .map(q => ({ kind: '资料', q: q.slice(0, 120), days: 365, on: true }));
      const wantEl = m.querySelector('input[name=ebWant]:checked');
      const want = wantEl ? wantEl.value : null;
      const picked = want == null ? null : Array.from(m.querySelectorAll('[data-ebbook]:checked')).map(x => books[Number(x.getAttribute('data-ebbook'))]).filter(Boolean);
      const ecustom = want == null ? null : (m.querySelector('#ebCustom').value || '').split(/[\n,，、；;]+/).map(x => x.trim()).filter(Boolean)
        .map(t => { const mm = t.match(/^(.*?)[《〈](.+?)[》〉]\s*$/); return mm ? { title: mm[2].trim(), author: mm[1].trim() } : { title: t }; });
      const btn = m.querySelector('#csOk');
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await api('/api/goals/' + gid + '/collect-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: qs.concat(custom) }) });
        if (want != null) {
          await api('/api/goals/' + gid + '/ebooks/pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ want, books: picked.concat(ecustom) }) });
        }
        close(true);
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = editOnly ? '保存方案' : '保存并开始搜集'; }
    });
  });
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
    ${foldBtn('map', foldClosed(g.id, 'map', true))}
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
  const gid = (state.goal && state.goal.id) || 0;
  let h = '<div class="taskListView">';
  stages.forEach((st, si) => {
    const p = subtreeProgress(st);
    const sst = ST_LABEL[st.status] ? st.status : 'todo';
    const sKey = 'tl-s' + st.id, sClosed = foldClosed(gid, sKey, true);
    h += `<div class="tlStage">
      <div class="tlStageHead ${sst}" data-node-id="${st.id}" data-detail="${st.id}" title="点击查看详情">
        ${foldBtn(sKey, sClosed)}
        <span class="stageIdx">${String(si + 1).padStart(2, '0')}</span>
        <span class="tlStageTitle">${esc(st.title)}</span>
        <span class="mtProg">${p.done}/${p.total}</span>
      </div>
      <div data-foldbody="${sKey}"${sClosed ? ' hidden' : ''}>`;
    for (const g of st.children) {
      const gp = subtreeProgress(g);
      const gst = ST_LABEL[g.status] ? g.status : 'todo';
      const gKey = 'tl-g' + g.id, gClosed = foldClosed(gid, gKey, true);
      h += `<div class="tlSub">
        <div class="tlSubHead ${gst}" data-node-id="${g.id}" data-detail="${g.id}" title="点击查看详情">${foldBtn(gKey, gClosed)}<span class="tlSubTitle">${esc(g.title)}</span><span class="mtProg">${gp.done}/${gp.total}</span></div>
        <div data-foldbody="${gKey}"${gClosed ? ' hidden' : ''}>${g.children.map(listTaskHTML).join('')}</div>
      </div>`;
    }
    h += '</div></div>';
  });
  return h + '</div>';
}
/* ============ 路线图卡片折叠（按目标记住展开/折叠，下次还保持） ============ */
function cardFoldState(gid) { try { return JSON.parse(localStorage.getItem('sierxing-goal-folds-' + gid) || '{}') || {}; } catch (e) { return {}; } }
function cardFoldSave(gid, map) { try { localStorage.setItem('sierxing-goal-folds-' + gid, JSON.stringify(map || {})); } catch (e) {} }
/* defaultOpen: 从没动过时的默认状态 */
function foldClosed(gid, key, defaultOpen) {
  const v = cardFoldState(gid)[key];
  return v == null ? !defaultOpen : !!v;
}
function foldBtn(key, closed) { return `<button class="btn tiny cardFold" data-fold="${key}" title="折叠/展开">${closed ? '▸' : '▾'}</button>`; }
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-fold]');
  if (!b || !b.getAttribute) return;
  const key = b.getAttribute('data-fold');
  const gid = state.goal && state.goal.id;
  if (!key || !gid) return;
  const body = document.querySelector(`[data-foldbody="${key}"]`);
  const willHide = body ? !body.hidden : true;
  const map = cardFoldState(gid);
  if (willHide) map[key] = true; else delete map[key];
  cardFoldSave(gid, map);
  if (body) body.hidden = willHide;
  document.querySelectorAll(`[data-fold="${key}"]`).forEach(x => { x.textContent = willHide ? '▸' : '▾'; });
});
/* “继续学习”卡片：上次看到的教程 + 看到哪，一键跳回去 */
async function renderContinueCard(gid) {
  const box = document.getElementById('continueCard');
  if (!box) return;
  if (!goalCompOn(goalCtx(), 'tutorial')) { box.remove(); return; }
  let d = null;
  try { d = await api('/api/goals/' + gid + '/last-tutorial'); } catch (e) { box.remove(); return; }
  const t = d && d.tutorial;
  if (!t) { box.remove(); return; }
  const total = Math.max(0, Number(t.sections_total) || 0);
  const at = total ? Math.min(Number(t.section_idx) + 1, total) : 0;
  const pct = total ? Math.min(100, Math.round(at / total * 100)) : 0;
  box.innerHTML = `<div class="continueCard">
    <div class="ccIcon">${sxi('book', 18)}</div>
    <div class="ccMain">
      <div class="ccLabel">继续学习${total ? `<span class="ccSep">·</span>第 <b>${at}</b>/${total} 节<b class="ccPct">${pct}%</b>` : ''}</div>
      <div class="ccTitle">${esc(t.title)}</div>
      ${t.node_title ? `<div class="ccNode">${sxi('target', 14)}${esc(t.node_title)}</div>` : ''}
      ${total ? `<div class="bar"><div class="barFill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <a class="btn primary" href="#/t/${t.id}">${sxi('play', 14)}继续阅读</a>
  </div>`;
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
    <div class="goalSticky">
    <div class="pageHead">
      <button class="back js-back" data-back="#/">← 返回</button>
      <div class="spacer"></div>
    </div>
    <div class="goalBar">
      <button class="btn small" data-tbtn id="editGoalBtn">编辑目标</button>
      <button class="btn small" data-tbtn id="shareGoalBtn" title="把这份规划与资料库打包分享给别人（对方可一键导入）。默认隐去学校/公司/姓名/联系方式等隐私">🔗 分享</button>
      ${goalCompOn(g, 'workspace') ? '<button class="btn small" data-tbtn id="wsPackBtn" title="把整个目标的代码目录一键打包成 zip 下载（一个节点对应一个文件夹，子目录嵌在父目录下）">📦 打包代码</button>' : ''}
      ${goalCompOn(g, 'chat') ? '<button class="btn small" data-tbtn id="chatBtn">💬 AI 助手</button>' : ''}
      ${pluginButtonsHTML(g)}
      ${goalPluginsHTML(g)}
      ${g.nodes.length && goalCompOn(g, 'versions') ? '<button class="btn small" data-tbtn id="verBtn">📜 版本对比</button>' : ''}
      <button class="btn small primary" data-tbtn id="planBtn" title="重新规划（会清空现有路径，请三思；微调骨架用下面的调整面板）">${g.nodes.length ? '重新规划（AI 先澄清）' : '开始 AI 规划（AI 先澄清）'}</button>
      <button class="btn small danger" data-tbtn id="delGoalBtn">删除</button>
      <button class="btn small" id="goalMoreBtn" data-morebtn-of="goal" hidden>⋯</button>
    </div>
    <div class="tutFavBar" id="goalFavBar" hidden></div>
    </div>
    <div class="goalHead">
      <div class="ghTop"><h2 class="ghTitle">${esc(g.title)}</h2><span class="chip ${st[1]}">${st[0]}</span>${foldBtn('head', foldClosed(g.id, 'head', true))}</div>
      <div data-foldbody="head"${foldClosed(g.id, 'head', true) ? ' hidden' : ''}>
      ${g.summary ? `<div class="ghSummary">规划思路：${mdOneLine(g.summary)}</div>` : ''}
      <div class="ghMeta">
        ${g.profile ? `<div class="ghItem"><span class="ghLabel">现状</span>${esc(g.profile)}</div>` : ''}
        ${g.weekly_hours ? `<span class="chip gray">每周 ${esc(g.weekly_hours)}</span>` : ''}
        ${g.deadline ? `<span class="chip gray">期限 ${esc(g.deadline)}</span>` : ''}
        <span class="chip gray">任务完成 ${g.tasks_done}/${g.tasks_total}</span>
      </div>
      <div class="bar big"><div class="barFill" style="width:${pct}%"></div></div>
      ${g.error ? `<div class="goalError">⚠ ${esc(g.error)}</div>` : ''}
      ${(g.error && state.planResumeInfo && state.planResumeInfo.goalId === g.id) ? `<div style="margin-top:8px;"><button class="btn small primary" id="planResumeDraftBtn" title="把上次失败保留的原始构思喂回去，让 AI 按正确格式整理，不用从头再想">🧭 继续构思${state.planResumeInfo.rawLen ? `（已保留约 ${(state.planResumeInfo.rawLen / 1000).toFixed(1)}k 字构思${state.planResumeInfo.attempts ? `，第 ${state.planResumeInfo.attempts + 1} 次整理` : ''}）` : ''}</button></div>` : ''}
      </div>
    </div>
    <div id="continueCard"></div>`;
  html += setupCardHTML();
  html += reportCardHTML();
  if (goalCompOn(g, 'tutorial')) html += tutorialCardHTML();
  if (goalCompOn(g, 'constraints')) html += constraintsCardHTML(g);
  if (goalCompOn(g, 'sources')) html += srcPanelHTML();
  html += expandPanelHTML();
  html += tutProgressHTML();
  html += planPanelHTML();
  if (state.showEdit) html += editGoalHTML(g);
  if (stages.length) {
    html += nextCardHTML(g);
    html += viewBarHTML(g);
    const fStages = filterTree(stages);
    html += `<div data-foldbody="map"${foldClosed(g.id, 'map', true) ? ' hidden' : ''}>` + listViewHTML(fStages) + '</div>';
  } else if (!state.planning) {
    html += `<div class="emptyBox" style="margin-top:8px;">
      <div class="ebIcon">🧭</div>
      <div class="ebTitle">还没有路径</div>
      <div class="ebText">${g.status === 'failed' ? '上次规划失败。' : ''}点「开始 AI 规划」：AI 会先问你几个问题摸清情况，再生成 阶段 → 小目标 → 任务 的路径。<br><span class="muted">想让它依据真实资料的话，可以先「收集信息源」或「导入代码库」（可选，不弄也能规划）。</span></div>
      <button class="btn primary" id="emptyPlanBtn">开始 AI 规划</button>
    </div>`;
  }
  html += '</div>';
  app.innerHTML = html;

  bindReportCard();
  bindTutorialCard();
  try { renderContinueCard(g.id); } catch (e) {}
  pluginGoButtonsBind();     // 组件入口按钮（每日刷题 / 图片资料…）
  bindConstraints(g);
  const chatBtn = document.getElementById('chatBtn');
  if (chatBtn) chatBtn.addEventListener('click', () => aiToggle(true));
  const verBtn = document.getElementById('verBtn');
  if (verBtn) verBtn.addEventListener('click', () => showVersionsPanel(g.id));
  if (window.Workspace && goalCompOn(g, 'workspace')) { try { window.Workspace.bindGoal(g); } catch (e) {} }
  const planBtnEl = document.getElementById('planBtn');
  planBtnEl.addEventListener('click', () => {
    if ((g.nodes || []).length && !confirm('重新规划会清空现有路径（含任务进度）后从头生成。\n\n只想微调阶段/小目标？用下面的「调整规划骨架」，不用推倒重来。\n\n确定要全部推倒重来吗？')) return;
    startClarify(g.id);
  });
  const resumeDraftBtn = document.getElementById('planResumeDraftBtn');
  if (resumeDraftBtn) resumeDraftBtn.addEventListener('click', () => startPlanResume(g.id));
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
  const cpb = document.getElementById('collectPlanBtn');
  if (cpb) cpb.addEventListener('click', async () => {
    if (await ensureCollectSetup(g.id, true)) toast('搜集方案已保存，下次搜集生效');
  });
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
      state.srcListOpen = true;
      renderGoal();
      toast('已删除该来源');
    } catch (err) { toast(err.message); }
  }));
  /* 执行页清单的行点击由共用的 bindTreeEvents 处理（含按钮守卫），这里不再重复绑定 */
  const gid0 = (state.goal && state.goal.id) || 0;
  const srcSelSet = () => {
    if (!state.srcSel || state.srcSel.gid !== gid0) state.srcSel = { gid: gid0, ids: new Set() };
    return state.srcSel.ids;
  };
  const refreshSrcBar = () => {
    const ids = srcSelSet();
    const bar = document.querySelector('.spListBar');
    if (bar) {
      const n = (state.sources || []).filter(s => ids.has(String(s.id))).length;
      const all = document.getElementById('srcSelAll');
      if (all) { all.checked = n > 0 && n === (state.sources || []).length; }
      let del = document.getElementById('srcDelSel');
      if (n > 0 && !del) {
        bar.insertAdjacentHTML('beforeend', `<button class="btn tiny danger" id="srcDelSel">删除选中（${n}）</button>`);
        del = document.getElementById('srcDelSel');
        if (del) del.addEventListener('click', delSelected);
      } else if (n > 0 && del) {
        del.textContent = `删除选中（${n}）`;
      } else if (n === 0 && del) {
        del.remove();
      }
    }
  };
  const delSelected = async () => {
    const ids = Array.from(srcSelSet());
    if (!ids.length) return;
    if (!confirm(`删除选中的 ${ids.length} 条信息源？不可恢复。`)) return;
    try {
      const r = await api('/api/goals/' + gid0 + '/sources/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      state.sources = r.sources || [];
      state.srcSel = { gid: gid0, ids: new Set() };
      state.srcListOpen = true;
      renderGoal();
      toast(`已删除 ${r.deleted} 条`);
    } catch (err) { toast(err.message); }
  };
  app.querySelectorAll('.siCheck').forEach(box => box.addEventListener('change', () => {
    const ids = srcSelSet();
    const sid = String(box.getAttribute('data-src-check'));
    if (box.checked) ids.add(sid); else ids.delete(sid);
    box.closest('.srcItem').classList.toggle('selected', box.checked);
    refreshSrcBar();
  }));
  const selAll = document.getElementById('srcSelAll');
  if (selAll) selAll.addEventListener('change', () => {
    const ids = srcSelSet();
    app.querySelectorAll('.siCheck').forEach(box => {
      box.checked = selAll.checked;
      const sid = String(box.getAttribute('data-src-check'));
      if (selAll.checked) ids.add(sid); else ids.delete(sid);
      box.closest('.srcItem').classList.toggle('selected', selAll.checked);
    });
    refreshSrcBar();
  });
  const det = document.getElementById('spDetails');
  if (det) det.addEventListener('toggle', () => { state.srcListOpen = det.open; });
  const clearBtn = document.getElementById('srcClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    const nS = (state.sources || []).length;
    if (!nS) return;
    if (!confirm(`确定清空本目标全部 ${nS} 条信息源？\n\n已导入的图片 / 电子书原件也会一并删除，不可恢复。\n（如需恢复，可从 data/backups 里找自动备份）`)) return;
    clearBtn.disabled = true;
    try {
      const r = await api('/api/goals/' + gid0 + '/sources/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.sources = [];
      state.srcSel = { gid: gid0, ids: new Set() };
      try { const jr = await api('/api/goals/' + gid0 + '/jd-images'); state.jdImages = jr.images || []; } catch (e) {}
      try { await loadGoal(gid0); } catch (e) {}
      renderGoal();
      toast(`已清空：信息源 ${r.deletedSources} 条${r.deletedFiles ? '、原件 ' + r.deletedFiles + ' 个' : ''}`);
    } catch (err) { toast(err.message); clearBtn.disabled = false; }
  });
  document.getElementById('delGoalBtn').addEventListener('click', async () => {
    if (!confirm('删除这个目标和它的全部路径？')) return;
    try { await api('/api/goals/' + g.id, { method: 'DELETE' }); toast('已删除'); go('#/'); } catch (e) { toast(e.message); }
  });
  document.getElementById('editGoalBtn').addEventListener('click', () => { state.showEdit = !state.showEdit; renderGoal(); });
  const shareBtn = document.getElementById('shareGoalBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => showShareDialog(g.id));
  const gpBtn = document.getElementById('goalPluginsBtn');
  if (gpBtn) gpBtn.addEventListener('click', () => {
    if (document.getElementById('goalPluginMenu')) document.getElementById('goalPluginMenu').remove();
    else showGoalPluginsMenu(g.id, gpBtn);
  });
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
    const nd = item ? item.querySelector(':scope > .mtnode') : null;
    if (nd) nd.classList.toggle('open', open);
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
  app.querySelectorAll('[data-detail]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('[data-cycle]') || e.target.closest('.nodeOps')) return;
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
  // 顶栏收藏栏：与教程页同一套（钉选 / 收藏夹 / 横向拖拽 / ⋯ 收纳）
  applyBarOverflow('goal');
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
/* ============ 设置 · 数据存储路径（可改 / 可迁移） ============
   为什么要有：默认 data/ 跟着程序走，Windows 上 exe 装在 C 盘，
   信息源图片、作答记录、备份全堆系统盘。搬到 D 盘/移动硬盘是自己能决定的事。
   切换一律要重启才生效（DATA_DIR 在启动时被插件、同步、上传按值捕获），
   所以每次成功迁移都给一个「立刻重启」按钮，别让人以为没生效。 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
let _storeState = null;
async function storeSectionLoad() {
  const box = document.getElementById('storeBox');
  if (!box) return;
  const paint = () => {
    const st = _storeState;
    if (!st) { box.innerHTML = '<p class="muted">正在读取…</p>'; return; }
    const gb = st.bytes >= 1024 * 1024 * 1024;
    box.innerHTML = `
      <div class="storeNow">
        <div class="storePath" title="${esc(st.dir)}">📂 ${esc(st.dir)}</div>
        <div class="storeMeta">
          <span class="chip ${st.custom ? 'ok' : 'gray'}">${st.custom ? '已改过位置' : '默认位置（程序目录下）'}</span>
          <span class="chip ${st.writable ? 'gray' : 'danger'}">${st.writable ? '可写' : '不可写！'}</span>
          <span class="chip gray">${fmtBytes(st.bytes)} · ${st.files} 个文件</span>
          ${st.at ? `<span class="muted" style="font-size:12px;">${esc(String(st.at).slice(0, 10))} 改的</span>` : ''}
        </div>
      </div>
      ${st.lost ? `<p class="hint" style="color:var(--danger);">⚠️ 之前指定的目录找不到了（${esc(st.lost)}），已临时回落到默认目录 —— 可能是移动硬盘没插。</p>` : ''}
      ${gb && !st.custom && st.inHome === false ? '<p class="hint">数据已经在系统盘（用户目录）下并超过 1 GB，建议搬到空间更大的盘。</p>' : ''}
      <div class="toolbarRow" style="margin-top:10px;">
        <button class="btn primary" id="stMove">📁 更改 / 迁移数据存储路径</button>
        ${st.canPick ? '' : '<span class="hint" style="align-self:center;">这个系统没有图形目录选择器，请把路径粘进输入框</span>'}
        ${st.custom ? '<button class="btn" id="stReset">搬回程序目录</button>' : ''}
        ${st.custom ? '<button class="btn" id="stUse">用别的目录里已有的数据</button>' : ''}
      </div>
      <p class="hint" style="margin-top:10px;">
        迁移分四步：<b>复制 → 校验行数 → 切换指针 → 删除原目录</b>。任何一步不通过就<b>不切</b>，数据留在原地。<br>
        切换后需要<b>重启一次</b>才生效（程序启动时就把数据位置读进去了）。<br>
        目标目录里已有思而行的数据时，用「用别的目录里已有的数据」直接指过去，不重复搬。
      </p>`;
    const mv = document.getElementById('stMove'); if (mv) mv.addEventListener('click', () => openStoreDialog('move'));
    const rs = document.getElementById('stReset'); if (rs) rs.addEventListener('click', () => doStoreApply({ reset: true }, '搬回程序目录下的 data/'));
    const ue = document.getElementById('stUse'); if (ue) ue.addEventListener('click', () => openStoreDialog('use'));
  };
  paint();
  try { _storeState = await api('/api/data-location'); } catch (e) { _storeState = { error: e.message }; }
  paint();
}
/** 迁移对话框：选目录（或粘路径）→ 实时体检 → 确认 → 带进度条执行 */
function openStoreDialog(mode) {
  const modeUse = mode === 'use';
  const st0 = _storeState || {};
  const D = document.createElement('div');
  D.className = 'bigDialog storeDlg';
  D.innerHTML = `
    <div class="stHd">
      <div class="stHdIc">${modeUse ? '🔗' : '📦'}</div>
      <div class="stHdTx">
        <h3>${modeUse ? '用别的目录里已有的数据' : '把数据搬到别处'}</h3>
        <p>${modeUse
          ? '只改「数据在哪」，不复制任何东西。目标目录里要有 <span class="mono">sierxing.db</span>。'
          : '数据库、上传的资料、作答记录、备份会一起搬过去；<b>校验通过才删原来的</b>，中途出岔子就停在原地。'}</p>
      </div>
      <button type="button" class="pfX" data-close1 title="关闭">✕</button>
    </div>
    <div class="stBody">
      <div class="stMove">
        <div class="stFrom"><span class="stMk">从</span><div class="stP" title="${esc(st0.dir || '')}">${esc(st0.dir || '…')}</div><div class="stM">${fmtBytes(st0.bytes)} · ${st0.files} 个文件</div></div>
        <div class="stArrow">↓</div>
        <div class="stTo"><span class="stMk">到</span>
          <div class="inWrap"><i>📁</i><input class="mono" id="stDir" placeholder="${st0.platform === 'win32' ? 'D:\\思而行数据' : '/mnt/d/sierxing 或 ~/Documents/思而行'}" spellcheck="false" autocomplete="off"></div>
          <div class="stPickRow">
            ${st0.canPick ? '<button type="button" class="btn small" id="stPick">📂 打开系统目录选择器</button>' : '<span class="hint">这个系统没有图形目录选择器，把路径粘进上面就行</span>'}
            <span class="hint" id="stPickMsg"></span>
          </div>
        </div>
      </div>
      <div class="stCheck" id="stCheck"><span class="stCheckIdle">填个路径，这里会先帮你看看能不能放</span></div>
      ${modeUse ? '' : `<div class="stModes">
        <label class="stMode"><input type="radio" name="stMode" value="move" checked>
          <div><b>搬过去，删掉原目录</b><span>腾出 C 盘空间（推荐）</span></div></label>
        <label class="stMode"><input type="radio" name="stMode" value="copy">
          <div><b>只复制一份，原目录保留</b><span>不放心时选这个：会占双份空间</span></div></label>
      </div>`}
      <details class="stSteps"><summary>迁移分四步，失败会停在哪一步？</summary>
        <ol><li><b>复制</b> —— 先复制到「目标.迁移中」临时目录，中途断电也不会被当成搬好了</li>
        <li><b>校验</b> —— 打开目标里的库，核对 goals / nodes / sources / problems 等表行数跟原来一致</li>
        <li><b>切指针</b> —— 写 <span class="mono">data-location.json</span>（放在程序目录，不会跟着数据挪走）</li>
        <li><b>删原目录</b> —— 只在第 1~3 步全过、且原目录本来就是默认目录时才删</li></ol>
        <p>任何一步不通过就<b>不切指针</b>，程序继续用原目录。切换完成后需要重启一次。</p>
      </details>
      <div class="stProg" id="stProg" hidden></div>
    </div>
    <div class="stFoot">
      <span class="hint" id="stMsg"></span><div class="spacer" style="flex:1"></div>
      <button type="button" class="btn" id="stCancel">取消</button>
      <button type="button" class="btn primary" id="stGo">${modeUse ? '指过去' : '开始迁移'}</button>
    </div>`;
  document.body.appendChild(D);
  let pollTimer = null, progTimer = null;
  const close = () => {
    clearInterval(pollTimer); clearInterval(progTimer);
    document.removeEventListener('keydown', onKey);
    D.remove();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  D.querySelector('[data-close1]').addEventListener('click', close);
  const msg = document.getElementById('stMsg');
  const chk = document.getElementById('stCheck');
  const input = document.getElementById('stDir');
  const prog = document.getElementById('stProg');
  const go = document.getElementById('stGo');
  const busy = on => { go.disabled = on; go.textContent = on ? '进行中…' : (modeUse ? '指过去' : '开始迁移'); };
  /* 路径一改就体检：能不能写、空间够不够、是不是要搬进自己的子目录 */
  let chkTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(chkTimer);
    const dir = input.value.trim();
    if (!dir) { chk.innerHTML = '<span class="stCheckIdle">填个路径，这里会先帮你看看能不能放</span>'; return; }
    chkTimer = setTimeout(async () => {
      try {
        const r = await api('/api/data-location/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
        chk.innerHTML = r.ok
          ? '<span class="stCheckOk">✓ 可以放这里</span><span class="stCheckTip">要腾出约 ' + fmtBytes(r.need) + ' 的空间' + (r.free != null ? '，那边还有 ' + fmtBytes(r.free) : '') + '</span>'
          : '<span class="stCheckBad">✗ ' + esc(r.error) + '</span>';
      } catch (e) { chk.innerHTML = '<span class="stCheckBad">✗ ' + esc(e.message) + '</span>'; }
    }, 400);
  });
  const pick = document.getElementById('stPick');
  if (pick) pick.addEventListener('click', async () => {
    pick.disabled = true;
    const pm = document.getElementById('stPickMsg');
    pm.textContent = '在弹出的窗口里选文件夹（可以顺手新建一个）…';
    try { await api('/api/data-location/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch (e) { pm.textContent = '打不开：' + e.message; pick.disabled = false; return; }
    pollTimer = setInterval(async () => {
      try {
        const r = await api('/api/data-location/pick');
        if (!r.done) return;
        clearInterval(pollTimer); pollTimer = null;
        pick.disabled = false;
        if (r.canceled) { pm.textContent = '已取消'; return; }
        input.value = r.chosen || '';
        input.dispatchEvent(new Event('input'));
        pm.textContent = '已选好';
      } catch (e) { clearInterval(pollTimer); pollTimer = null; pick.disabled = false; pm.textContent = '失败：' + e.message; }
    }, 800);
  });
  document.getElementById('stCancel').addEventListener('click', close);
  go.addEventListener('click', async () => {
    const dir = input.value.trim();
    if (!dir) { msg.innerHTML = '<span style="color:var(--danger)">先选一个文件夹</span>'; return; }
    const m = modeUse ? 'copy' : ((D.querySelector('input[name=stMode]:checked') || {}).value || 'move');
    const payload = modeUse ? { use_existing: true, dir } : { dir, mode: m };
    msg.textContent = '';
    chk.innerHTML = '';
    prog.hidden = false;
    prog.innerHTML = '<div class="stProgHd"><span class="pfSpinDark"></span><b id="stProgT">正在准备…</b><span class="spacer" style="flex:1"></span><span id="stProgN"></span></div>'
      + '<div class="stBar"><i id="stBarI" style="width:0%"></i></div>'
      + '<div class="stProgF" id="stProgF"></div>';
    busy(true);
    /* 进度条：几十秒的复制没有进度条就像死机了 */
    const phases = { scan: '正在统计要搬多少…', copy: '正在复制文件…', verify: '正在校验（打开库核对行数）…', cleanup: '校验通过，正在删掉原目录…', done: '完成', error: '已停止' };
    progTimer = setInterval(async () => {
      try {
        const p = await api('/api/data-location/progress');
        const t = document.getElementById('stProgT');
        const n = document.getElementById('stProgN');
        const f = document.getElementById('stProgF');
        const bar = document.getElementById('stBarI');
        if (!t) return;
        t.textContent = phases[p.phase] || '处理中…';
        bar.style.width = (p.phase === 'copy' ? p.pct : (p.phase === 'done' ? 100 : 0)) + '%';
        if (p.phase === 'copy') n.textContent = fmtBytes(p.copied) + ' / ' + fmtBytes(p.total) + '　' + p.pct + '%　' + p.elapsed + ' 秒';
        else if (p.elapsed) n.textContent = p.elapsed + ' 秒';
        f.textContent = p.cur ? pathTail(p.cur, 46) : '';
      } catch (e) { /* 轮询失败就忽略，等下面那次请求给最终结果 */ }
    }, 700);
    let r;
    try {
      r = await api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) {
      clearInterval(progTimer);
      busy(false);
      /* 失败就把横幅留在原地，让人看得见为什么停 —— 早先只弹个 toast，几秒后就没人记得了 */
      prog.innerHTML = '<div class="stProgBad"><b>✗ 没搬成功</b><br>' + esc(e.message)
        + (e.message.indexOf('一半') >= 0 ? '' : '') + '</div>';
      chk.innerHTML = '';
      msg.innerHTML = '<span style="color:var(--muted)">原数据没动，程序还在用原来的位置。可以修好路径再试，或点「取消」。</span>';
      return;
    }
    clearInterval(progTimer);
    busy(false);
    prog.innerHTML = '<div class="stProgOk"><b>✓ ' + esc(modeUse ? '已指向新目录' : (m === 'move' ? '数据已搬过去' : '已复制一份到新目录')) + '</b><br>'
      + '原位置：' + esc(st0.dir || '') + '<br>新位置：' + esc(r.dir || dir)
      + ((r.skipped && r.skipped.length) ? '<br><br>有 ' + r.skipped.length + ' 个文件读不了（多半是克隆来的项目里 root 权限的日志），已跳过：<br><span class="mono" style="font-size:11px;">'
        + r.skipped.slice(0, 5).map(s => esc(s.file)).join('<br>') + (r.skipped.length > 5 ? '<br>…等共 ' + r.skipped.length + ' 个' : '') + '</span><br>数据库和你的数据不受影响。' : '')
      + '</div>';
    try { _storeState = await api('/api/data-location'); } catch (e) {}
    storeSectionLoad();
    msg.innerHTML = '<b>需要重启一次才会真正生效。</b>';
    const rd = document.getElementById('stRestart');
    if (rd) rd.remove();
    const rb = document.createElement('button');
    rb.id = 'stRestart'; rb.className = 'btn primary'; rb.textContent = '现在重启';
    rb.addEventListener('click', async () => {
      rb.disabled = true; rb.textContent = '正在重启…';
      try { await api('/api/data-location/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      catch (e) { rb.disabled = false; rb.textContent = '重启失败，手动重开'; toast(e.message); }
    });
    go.replaceWith(rb);
  });
}
/** 路径太长时只留尾巴，中间省略 */
function pathTail(p, n) {
  p = String(p || '');
  return p.length > n ? '…' + p.slice(-(n - 1)) : p;
}

/** 首次运行：问一次「数据存哪」。
 *  触发条件刻意保守 —— 只在「从没问过 + 还在默认目录 + 数据还很小」时问一次。
 *  用 localStorage 记「问过」，包括用户主动关掉也算问过，免得每次启动都弹。 */
async function maybeAskDataDir() {
  const KEY = 'sierxing-datadir-asked';
  let asked = false;
  try { asked = localStorage.getItem(KEY) === '1'; } catch (e) {}
  if (asked) return;
  let st;
  try { st = await api('/api/data-location'); } catch (e) { return; }
  if (st.custom) { markAsked(); return; }                       // 已经搬过了，不问
  if (st.bytes > 200 * 1024 * 1024) { markAsked(); return; }  // 已经攒起来了，搬家不值当（去设置里搬）
  markAsked();
  const win = st.platform === 'win32';
  setTimeout(() => {
    if (document.getElementById('storeDlg')) return;
    const ask = confirm(
      '一句话确认：思而行的数据（目标、信息源、作答记录、备份）存在哪？\n\n'
      + '现在存在：\n' + st.dir + '\n\n'
      + (win
        ? '程序装在哪个盘，数据就跟着在哪个盘。如果装在 C 盘，建议改成 D 盘或移动硬盘 ——\n'
          + '信息源图片和备份最容易涨到几个 G。\n\n现在改位置？'
        : '一般不用改，程序目录下的 data/ 就够。\n\n要去设置里改吗？')
    );
    if (!ask) return;
    go('#/settings');
    setTimeout(() => {
      const tab = document.querySelector('.setTab[data-tab="set-store"]');
      if (tab) tab.click();
    }, 400);
  }, 2200);
}
function markAsked() { try { localStorage.setItem('sierxing-datadir-asked', '1'); } catch (e) {} }

/** 真正执行迁移 / 切指针，成功后问要不要立刻重启 */
async function doStoreApply(payload, doneMsg) {
  let r;
  try { r = await api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  catch (e) { toast(e.message); return null; }
  if (r.keptAt) toast('没搬成功：' + r.error + '（原数据没动，' + r.keptAt + ' 里是搬了一半的，可以自己看看）');
  else toast(doneMsg + ' ✓');
  try { _storeState = await api('/api/data-location'); } catch (e) {}
  storeSectionLoad();
  if (r.restartRequired) {
    const go = confirm(doneMsg + '\n\n需要重启一次才会真正生效 —— 现在重启吗？');
    if (go) {
      try {
        await api('/api/data-location/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast('正在重启…');
      } catch (e) { toast('自动重启失败，手动重开一次就好：' + e.message); }
    }
  }
  return r;
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
      <div class="gmRow"><span class="gmLabel">连接</span><span class="gmInput">＋ API 连接　＋ Agent 连接　＋ 识图专用</span></div>
      <div class="gmRow"><span class="gmLabel">服务商</span><span class="gmInput gmPicker">DeepSeek ▾　通义千问　Kimi　智谱…（点一下地址自动填好）</span></div>
      <div class="gmRow"><span class="gmLabel">模型</span><span class="gmInput">deepseek-flash　deepseek-v4-pro　（点按钮多选，也可手填）</span></div>
      <div class="gmCliHint">点「🔄 获取并测试」：取列表后<b>逐个测能否联通</b>，绿=通、红=不通</div>
      <div class="gmRowEnd">
        <span class="gmBtn gmBtnClick">保存</span>
        <span class="gmOk">对话时在 💬 的模型下拉里选具体用哪个</span>
      </div>
    </div>
    <div class="gmCaption">左侧栏 → ⚙ 设置 → 顶栏切到「AI 接入方式」：选服务商 → 填密钥 → 获取并测试</div>`,
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
            <input id="gdAiModel" placeholder="模型，如 deepseek-flash">
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
        const guideBody = {
          ai_provider: prov, ai_base_url: base,
          model: prov === 'openai' ? model1 : model2, ai_opencode_agent: agent
        };
        if (key) guideBody.ai_api_key = key;   // 留空就不发送，避免清空已保存的密钥
        await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guideBody) });
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
/* 当前语境目标：教程页用教程所属目标（state.tutGoal），其它用 state.goal */
function goalCtx() {
  try {
    if (parseRoute().view === 'tutorial' && state.tutGoal && state.tutGoal.id) return state.tutGoal;
  } catch (e) {}
  return state.goal;
}
/* 按目标的组件开关（目标之间彻底隔离）：目标显式值 > 全局开关 > 默认值 */
function goalCompOn(goal, id) {
  let obj = null;
  try { obj = JSON.parse((goal && goal.plugins) || '{}'); } catch (e) {}
  if (obj && obj[id] != null) return !!obj[id];
  return compOn(id);
}
/* 动态加载的插件脚本/样式同样带版本戳（与入口同版本） */
function assetUrl(u) {
  try {
    const v = (document.querySelector('meta[name="asset-v"]') || {}).content || '';
    if (!v) return u;
    return u + (u.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(v);
  } catch (e) { return u; }
}
function applyComponentStyles(styles) {
  /* 主题皮肤不走这条通道：由 applyThemeStyles() 按亮 / 暗模式单独挂载。
     这里把主题组件的 CSS 过滤掉 —— 否则「组件管理页里开着主题开关」会绕过分模式选择。 */
  const themeIds = new Set(((state.componentList || []).filter(c => c.kind === 'theme' || c.scope === 'theme')).map(c => c.id));
  const isThemeStyle = u => { const m = /\/plugins\/([^/?#]+)\.css/.exec(String(u)); return !!(m && themeIds.has(m[1])); };
  const want = new Set((styles || []).filter(u => !isThemeStyle(u)).map(assetUrl));
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
/* 老用户迁移：以前是「在组件页开一个主题」，现在改成按亮/暗模式分别选。
   升级后第一次读到组件列表时，把已开启的主题按其 mode 填进对应模式；之后不再自动改。 */
function seedThemeMapOnce(r) {
  try {
    if (localStorage.getItem('sierxing-theme-map') != null) return;
    const map = {};
    for (const c of (r.components || [])) {
      if (!(c.kind === 'theme' || c.scope === 'theme')) continue;
      if ((r.enabled || {})[c.id] !== true) continue;
      const mode = c.mode === 'dark' ? 'dark' : 'light';
      if (!map[mode]) map[mode] = c.id;
    }
    localStorage.setItem('sierxing-theme-map', JSON.stringify(map));
  } catch (e) {}
}
async function loadComponents() {
  try {
    state.componentCats = await api('/api/component-categories').catch(() => ({ categories: [], used: {}, map: {} }));
    const r = await api('/api/components');
    state.components = r.enabled || {};
    state.componentList = r.components || [];
    state.componentPins = r.pins || state.componentPins || [];
    SiErXing.setServerPlugins(r.components || []);
    seedThemeMapOnce(r);
    applyComponentStyles(r.styles || []);
    applyThemeStyles();
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
      <select id="libGoal" class="libGoalSel sxi-sel">${goalOptions}</select>
      <button class="btn small" id="libRagBuild" title="把资料切片（配了向量模型则一并向量化）：规划/对话时按问题检索最相关片段">${sxi('spark')}检索索引</button>
      <button class="btn small" id="libDigest">${sxi('spark')}${digests.length ? '重新提炼' : '信息提炼'}</button>
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
        <span class="libStageT">${esc(st.title)}</span>
      </summary>
      <div class="libStageM">${stageChips.join('')}</div>
      <div class="libStageBody">
        ${nodeSrc.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('pin',14)}节点自标依据</div>${nodeSrc.map(x => `<div class="libRef">${sxi('link',14)}<span>${esc(x.name || x.title || '')}${x.note ? `<div class="libSrcMeta">${esc(x.note)}</div>` : ''}</div>`).join('')}` : ''}
        ${relDigests.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('doc',14)}相关汇总</div>${relDigests.map(({ d }) => `<details class="libSrc"><summary>📄 ${esc(d.title || d.topic)}</summary><div class="libSrcBody mdBody">${mdToHTML(d.content || '')}</div></details>`).join('')}` : ''}
        ${relSrc.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('link',14)}相关资料</div>${relSrc.map(({ x }) => srcCard(x, true)).join('')}` : ''}
        ${(!nodeSrc.length && !relDigests.length && !relSrc.length) ? '<div class="muted" style="font-size:12.5px;">这个阶段暂时没有匹配到资料</div>' : ''}
      </div></details>`;
  }
  h += `</div>`;

  // 二、主题汇总（MD）
  h += `<div class="libSecHd">${sxi('doc')}<span class="libSecHdT">主题汇总</span><span class="libSecHdS">AI 通读全部资料后按主题整理的 MD，规划时的优先依据</span></div>`;
  h += digests.length
    ? `<div class="libDigestHead"><a class="btn tiny" href="/api/goals/${g.id}/digests/export" download>⬇ 下载全部 MD</a></div>` + digests.map(d => `<details class="libSrc"><summary>📄 ${esc(d.title || d.topic)} <span class="muted" style="font-size:11.5px;">· 依据 ${d.sources_count || 0} 条</span></summary><div class="libSrcBody mdBody">${mdToHTML(d.content || '')}</div><div class="spDigestOps"><span class="muted" style="font-size:11.5px;">${esc(fmtDate(d.created_at))}</span><div class="spacer"></div><button class="btn tiny danger" data-digest-del="${d.id}">删除</button></div></details>`).join('')
    : `<p class="hint">还没有提炼汇总：点右上「🧠 信息提炼」，AI 会通读全部资料并按主题整理成多篇 MD。</p>`;
  h += `</div>`;

  // 三、全部资料（按类型）
  h += `<div class="libSecHd">${sxi('layers')}<span class="libSecHdT">全部资料</span><span class="libSecHdS">共 ${sources.length} 条</span></div>`;
  h += own.length ? `<div class="libSecT" style="display:flex;align-items:center;gap:5px;">${sxi('pin',14)}你自己提供的（最高优先级）</div>${own.map(x => srcCard(x, true)).join('')}` : '';
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
  /* 检索索引：状态 + 一键建立（切片/向量化，规划与对话会按问题检索它） */
  const lrb = document.getElementById('libRagBuild');
  if (lrb) lrb.addEventListener('click', async () => {
    try {
      const r = await api('/api/goals/' + g.id + '/rag/build', { method: 'POST' });
      toast(r.already ? '索引任务已在运行' : '已开始建立检索索引（左下角任务中心可看进度）');
    } catch (e) { toast(e.message); }
  });
  (async () => {
    const box = document.getElementById('libRagStatus');
    if (!box) return;
    try {
      const st = await api('/api/rag/status?goalId=' + g.id);
      box.textContent = st.enabled
        ? ('· 检索索引：' + st.embedded + '/' + st.chunks + ' 段已向量化' + (st.embConfigured ? '' : '（未配向量模型，按关键词检索）'))
        : '· 检索增强已关闭（设置 → 检索增强）';
    } catch (e) {}
  })();
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
  const [r, catsRes, goalsRes] = await Promise.all([
    api('/api/components'),
    api('/api/component-categories').catch(() => ({ categories: [], used: {}, map: {} })),
    api('/api/goals').catch(() => ({ goals: [] }))
  ]);
  const scopeGoals = (goalsRes.goals || []).map(g => ({ id: g.id, title: g.title }));
  if (!state.compScope) state.compScope = 'global';
  const scope = state.compScope;
  const scopeGid = String(scope).startsWith('goal:') ? Number(String(scope).slice(5)) : 0;
  const scopeGoal = scopeGoals.find(g => g.id === scopeGid) || null;
  if (scopeGid && !scopeGoal) state.compScope = 'global';
  // 目标范围内的各组件开关（只读本目标、不写别处）
  let scopeEnabled = null, scopeConfig = null;
  if (scopeGoal) {
    try {
      const pr = await api('/api/goals/' + scopeGoal.id + '/plugins');
      scopeEnabled = pr.enabled || {}; scopeConfig = pr.config || {};
    } catch (e) { scopeEnabled = {}; scopeConfig = {}; }
  }
  state.components = r.enabled || {};
  state.componentList = r.components || [];
  state.componentPins = r.pins || state.componentPins || [];
  state.componentCats = catsRes;                 // 分类实时刷新（新建后立即出现）
  applyComponentStyles(r.styles || []);
  const comps = r.components || [];
  // 按分类分组：每个分类是一个模块，卡片放在所属模块里；改分类后卡片会真正搬过去
  const groups = {};
  for (const c of comps) { const k = c.category || '其它'; (groups[k] = groups[k] || []).push(c); }
  const customOrder = (state.componentCats && state.componentCats.categories) || [];
  const catRank = k => k === '核心组件' ? 0 : k === '基础功能组件' ? 1 : 99;
  const catOrder = Object.keys(groups).concat(customOrder.filter(k => !groups[k])).filter((k, i, a) => a.indexOf(k) === i).sort((a, b) => {
    const ra = catRank(a), rb = catRank(b);
    if (ra !== rb) return ra - rb;
    const ia = customOrder.indexOf(a), ib = customOrder.indexOf(b);
    const na = ia < 0 ? 999 : ia, nb = ib < 0 ? 999 : ib;
    if (na !== nb) return na - nb;
    if (a === '其它') return 1;
    if (b === '其它') return -1;
    return String(a).localeCompare(String(b), 'zh');
  });
  const sw = (c) => `<label class="cmpSwitch" title="${c.scope === 'core' ? '核心组件不可关闭' : '开启 / 关闭'}">
      <input type="checkbox" data-cmp="${esc(c.id)}" ${state.components[c.id] !== false ? 'checked' : ''} ${c.scope === 'core' ? 'disabled' : ''}>
      <span class="cmpSlider"></span>
    </label>`;
  const catOptions = [...new Set([...customOrder, ...Object.keys(groups), '其它'])];
const card = (c) => `<div class="cmpCard ${c.scope === 'core' ? 'isCore' : ''}">
    <div class="cmpCardTop">
      <span class="cmpIcon">${c.icon || '✨'}</span>
      <div class="cmpName">${esc(c.name)}
        ${c.scope === 'core' ? '<span class="chip gray">核心 · 不可关闭</span>' : ''}
        ${c.kind === 'theme' ? '<span class="chip gray">主题皮肤</span>' : ''}
        ${c.builtin ? '' : '<span class="chip">第三方组件</span>'}
        ${c.goalToggle && c.scope !== 'core' ? '<span class="chip gray" title="可在新建目标时勾选；各目标也可单独开关、互不干扰">按目标启用</span>' : ''}
        ${c.version ? `<span class="cmpVer">v${esc(c.version)}</span>` : ''}
        ${c.author ? `<span class="cmpAuthor">by ${esc(c.author)}</span>` : ''}
      </div>
      <div class="cmpOps">
        ${(c.kind === 'theme' || c.scope === 'theme') ? '<a class="btn tiny" href="#/settings/theme">去设置里选</a>' : sw(c)}</div>
    </div>
    <div class="cmpDesc">${esc(c.desc || '')}</div>
    <div class="cmpCatRow">
      <span class="cmpCatLabel">分类</span>
      <select class="cmpCatSel" data-comp-cat="${esc(c.id)}">
        ${catOptions.map(k => `<option value="${esc(k)}" ${k === (c.category || '其它') ? 'selected' : ''}>${esc(k)}</option>`).join('')}
      </select>
    </div>
    ${c.builtin ? '' : `<div class="cmpCardOps">
      <a class="btn tiny" href="/api/components/${esc(c.id)}/export">导出</a>
      <button class="btn tiny danger" data-cmp-del="${esc(c.id)}">卸载</button>
    </div>
    <div class="cmpFiles">服务端 server/plugins/${esc(c.id)}.js${c.client ? ` · 前端 public/plugins/${esc(c.id)}.js` : ''}${c.hasStyle ? ` · 样式 public/plugins/${esc(c.id)}.css` : ''}</div>`}
  </div>`;
const modHint = (k, list) => {
  const hints = [];
  if (k === '核心组件') hints.push('应用的基础能力，无法关闭。');
  if (list.some(c => c.kind === 'theme')) hints.push('主题皮肤在「设置 → 外观主题」里分别为亮色 / 暗色模式选择；这里的开关对它不再生效。');
  if (list.some(c => !c.builtin)) hints.push('独立文件组件，可以导出分享给别人，也可以卸载。带「按目标启用」的组件可在新建目标时勾选。');
  if (!hints.length) hints.push('全局开关 = 新目标的默认值；已在目标里单独设置过的，以目标自己的设置为准、互不干扰。');
  return `<p class="hint" style="margin:0 0 8px;">${hints.join('')}</p>`;
};
  let html = `<div class="page wide cmpPage">
    <div class="pageHead">
      <button class="back js-back" data-back="#/">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🧩 组件</h2>
      <span class="hint" style="margin-left:10px;">功能与界面样式都由组件提供，可自由开关、导入分享</span>
      <div class="spacer"></div>
      <button class="btn small" id="cmpReload">↻ 重新加载</button>
      <label class="btn small primary">⬆ 导入组件（可多选）<input type="file" id="cmpImport" accept=".json,application/json" multiple hidden></label>
    </div>
    <div class="sec">
      <div class="secTitle">管理范围</div>
      <div class="ppCats" id="cmpScopeBar">
        <button type="button" class="ppCat ${scope === 'global' ? 'active' : ''}" data-scope="global">🌍 全局默认</button>
        ${scopeGoals.map(g => `<button type="button" class="ppCat ${scope === 'goal:' + g.id ? 'active' : ''}" data-scope="goal:${g.id}">🎯 ${esc(g.title)}</button>`).join('')}
      </div>
      <p class="hint" style="margin:8px 0 0;">${scopeGoal
        ? `正在管理「${esc(scopeGoal.title)}」：这里的开关只改这个目标，别的目标不受影响。`
        : '全局开关 = 新目标的默认值，也管应用级组件（番茄钟浮窗、笔记面板等）；已经单独设置过的目标不受影响。'}</p>
    </div>
    ${scopeGoal ? `<div class="sec"><div class="secTitle">🎯 ${esc(scopeGoal.title)} 的组件（只改本目标）</div>
      <p class="hint" style="margin:0 0 10px;">这里的开关<b>只写这一个目标</b>，其它目标完全不受影响。没单独设置过的组件，仍按🌍 全局默认走。</p>
      <div class="cmpGrid">${goalManageableEntries({ id: scopeGoal.id, plugins: JSON.stringify(scopeConfig || {}) }).map(e => {
        const on = SiErXing.pluginEnabled({ id: scopeGoal.id, plugins: JSON.stringify(scopeConfig || {}) }, e.id);
        return `<div class="cmpCard"><div class="cmpCardTop">
          <span class="cmpIcon">${e.icon || '🧩'}</span>
          <div class="cmpName">${esc(e.name)}${e.desc ? `<div class="cmpDesc" style="margin-top:4px;">${esc(e.desc)}</div>` : ''}</div>
          <div class="cmpOps"><label class="cmpSwitch" title="只改本目标">
            <input type="checkbox" data-gcmp="${esc(e.id)}" ${on ? 'checked' : ''}><span class="cmpSlider"></span>
          </label></div>
        </div></div>`; }).join('')}</div>
    </div>` : ''}
    ${(() => {
      // 选了某个目标时，下面的全局开关会"看起来"也属于这个目标，很容易误改到所有目标。
      // 所以把它们整体折叠起来，并明确标注作用域。
      const inner = `
      <div class="sec">
        <div class="secTitle">分类管理</div>
        <p class="hint" style="margin:0 0 10px;">分类用于整理组件，也可以在「新建目标」时<b>按分类批量选择</b>组件。可以新建/重命名/删除分类，并把任意组件移动到别的分类。</p>
        <div class="catList" id="catList"></div>
        <div class="consAdd" style="margin-top:10px;">
          <input type="text" id="catNewName" placeholder="新建分类，例如：学习成长 / 效率工具 / 我的收藏">
          <button class="btn small primary" id="catAddBtn">新建分类</button>
        </div>
      </div>
      <div class="cmpCols">${catOrder.map(k => `<div class="sec" data-catmod="${esc(k)}"><div class="secTitle">${esc(k)}<span class="muted" style="font-weight:400;font-size:12px;">（${(groups[k] || []).length}）</span></div>
        ${modHint(k, groups[k] || [])}
        ${(groups[k] || []).length ? `<div class="cmpGrid">${groups[k].map(c => card(c)).join('')}</div>` : '<div class="muted" style="font-size:13px;">（空分类：把某个组件的分类改到这里，它就会搬过来）</div>'}
      </div>`).join('')}</div>
      <div class="sec"><div class="secTitle">分享组件</div>
        <p class="hint" style="line-height:1.9;">
          · 导出：点组件的「导出」得到 <code>*.component.json</code> 文件（含服务端代码、前端代码与样式），发给别人即可<br>
          · 导入：点右上「导入组件」选择该文件，组件会立刻装好并可开关<br>
          · 自己写一个：把 <code>server/plugins/xxx.js</code>（声明元数据 + 接口 + 建表）和 <code>public/plugins/xxx.js</code>（界面）、<code>public/plugins/xxx.css</code>（样式）放进去即可，详见 README「插件开发」
        </p>
      </div>`;
      if (!scopeGoal) return inner;
      return `<details class="cmpGlobalFold"><summary>🌍 全局组件与分类（下面的开关影响<b>所有</b>目标，别在这里改单个目标）</summary>${inner}</details>`;
    })()}
  </div>`;
  app.innerHTML = html;

  /* ---- 管理范围切换 ---- */
  app.querySelectorAll('#cmpScopeBar [data-scope]').forEach(b => b.addEventListener('click', async () => {
    state.compScope = b.getAttribute('data-scope');
    await renderComponentsPage();
  }));
  /* ---- 目标范围内的开关：只写本目标 ---- */
  app.querySelectorAll('[data-gcmp]').forEach(inp => inp.addEventListener('change', async () => {
    const pid = inp.getAttribute('data-gcmp');
    const gid = scopeGoal ? scopeGoal.id : 0;
    if (!gid) return;
    try {
      await api('/api/goals/' + gid + '/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: pid, enabled: inp.checked }) });
      toast(inp.checked ? '已为本目标启用（别的不受影响）' : '已为本目标关闭（别的不受影响）');
      if (state.goal && state.goal.id === gid) { try { await loadGoal(gid); } catch (e) {} }
      await renderComponentsPage();
      renderRail();
    } catch (e) { toast(e.message); inp.checked = !inp.checked; }
  }));

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
        renderRail();
      } catch (e) { toast(e.message); }
    }));
    catListEl.querySelectorAll('[data-cat-del]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-cat-del');
      if (!confirm('删除分类「' + name + '」？该分类下的组件会回到它们原本的分类。')) return;
      try {
        await api('/api/component-categories/' + encodeURIComponent(name), { method: 'DELETE' });
        toast('已删除分类');
        await renderComponentsPage();
        renderRail();
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
renderRail();
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
      renderRail();
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
      renderRail();
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
/* 打包版（单个 exe）走 payload 后端：没有提交概念，只比版本号。
   文案必须换掉，否则会出现「落后 1 个提交」这种对 exe 用户毫无意义的话。 */
function updIsPayload() { return (state.update || {}).mode === 'payload'; }
function updSizeText() {
  const m = (state.update || {}).manifest;
  if (!m || !m.size) return '';
  const kb = Math.round(m.size / 1024);
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}
function updWhereText() {
  const u = state.update || {};
  if (updIsPayload()) return '下载程序文件 ' + (updSizeText() || '') + '（不会重下整个 exe）';
  return '落后 ' + u.behind + ' 个提交';
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
      <b>发现新版本 ${updIsPayload() ? 'v' + esc(u.latestShort || '') : ''}</b>
      ${u.exeRequired ? '<span class="chip warn">需换整个 exe（启动器有修复）</span>' : ''}
      <span>${esc(updWhereText())} · ${esc(u.latestSubject || '')}</span>
    </div>
    <button class="btn tiny" id="updDetails">更新内容</button>
    <button class="btn tiny primary" id="updNow">立即更新</button>
    <button class="btn tiny" id="updLater">稍后</button>
    <button class="updClose" id="updSkip" title="跳过此版本（不再提示）">×</button>
    <div class="updList" id="updList" hidden>
      ${updIsPayload()
        ? `<div class="updItem"><span>${esc(u.latestSubject || '（暂无说明）')}</span></div>${u.releasesUrl ? `<div class="updItem"><a href="${esc(u.releasesUrl)}" target="_blank" rel="noopener">去发布页查看完整更新记录 →</a></div>` : ''}`
        : ((u.commits || []).map(c => `<div class="updItem"><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span><i>${esc(fmtUpdTime(c.date))}</i></div>`).join('') || '<div class="muted">（没有更多详情）</div>')}
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
  /* exeRequired：新功能在载荷里照样能更，但旧启动器交接重启必失败。
     直接告诉用户两种走法，别让他对着断开的页面发呆。 */
  if (u.exeRequired) {
    const go = confirm('新版本 v' + (u.latestShort || '') + ' 包含启动器修复，需要换整个 exe 文件。\n\n点"确定"：先下载新版 exe（发布页），再手动替换运行。\n点"取消"：只更新程序文件（新功能照样有），但更新后要手动关掉重开。');
    if (go && u.releasesUrl) { try { window.open(u.releasesUrl, '_blank', 'noopener'); } catch (e) {} return; }
    if (go) return;
  }
  if (!confirm('更新到最新版本（' + (u.latestShort || '') + '）？\n更新完会自动重启应用，页面会自动刷新。\n你的数据都在本地，不会丢失。')) return;
  const b = document.getElementById('updBanner');
  if (b) b.remove();
  updMaskShow('正在更新…');
  updMaskSub(updIsPayload() ? '下载并校验程序文件' : '从远端拉取最新代码');
  try {
    const r = await api('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.updated) { updMaskShow('已经是最新版本'); setTimeout(() => { const m = document.getElementById('updMask'); if (m) m.remove(); }, 1200); return; }
    updMaskSub('已更新 ' + r.before + ' → ' + r.after
      + (r.mode === 'payload' ? '（' + (r.files || 0) + ' 个文件）' : '（' + r.commits + ' 个提交）')
      + (r.warning ? ' · ' + r.warning : ''));
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
    updMaskSub(e.message + (updIsPayload() ? ' · 可稍后重试，或到项目仓库手动下载最新程序文件' : ' · 可在项目目录手动执行 git pull'));
    setTimeout(() => { const m = document.getElementById('updMask'); if (m) m.remove(); }, 8000);
  }
}
/* ---- 设置页：版本与更新 ---- */
async function updateSectionHTML() {
  let u = state.update;
  if (!u) { try { u = await api('/api/update/status'); state.update = u; } catch (e) { u = {}; } }
  const isPay = u.mode === 'payload';
  const cur = isPay
    ? (u.localVersion ? '<code>v' + esc(u.localVersion) + '</code>' : '（未检测）')
    : (u.currentShort ? `<code>${esc(u.currentShort)}</code> ${esc(fmtUpdTime(u.currentDate))}` : '（未检测）');
  const supported = u.supported !== false;
  const has = updHasUpdate();
  const status = !supported
    ? '<span style="color:var(--warn)">当前安装方式不支持自动更新（可重新用 git clone 安装，数据不会丢）</span>'
    : (u.reason === 'fetch-failed'
      ? '<span style="color:var(--warn)">检查失败：' + esc(u.error || '网络或权限问题') + '</span>'
      : (has
        ? (isPay
          ? '<b style="color:var(--accent)">有新版本 v' + esc(u.latestShort || '') + '</b> · 只下载程序文件 ' + (updSizeText() || '') + '，不会重下整个 exe · ' + esc(u.latestSubject || '')
            + (u.exeRequired ? '<br><span style="color:var(--warn)">本次含启动器修复：功能照常更新，但之后请去发布页下载完整 exe 替换一次，否则自动重启仍需手动重开。</span>' + (u.releasesUrl ? ` <a href="${esc(u.releasesUrl)}" target="_blank" rel="noopener">去发布页 →</a>` : '') : '')
          : '<b style="color:var(--accent)">有 ' + u.behind + ' 个新提交</b> · 最新：' + esc(u.latestSubject || ''))
        : (isPay ? '已是最新版本' : '已是最新版本' + (u.dirty ? ' · 本地有 ' + u.dirty + ' 个改动文件（更新时会自动暂存）' : ''))));
  return `<div class="sec" id="set-update">
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
      <p class="hint" style="margin-top:8px;">· 启动时会自动检查一次；也可以随时点「检查更新」<br>· 更新只替换程序文件，本地数据（目标 / 组件设置 / 密钥）不受影响；更新后会自动重启应用${isPay ? '<br>· 你是单文件 exe 版本：更新只下载程序文件（几百 KB），<b>不用重下 89MB 的 exe</b>' : ''}</p>
    </div>`;
}
function bindUpdateSection() {
  const ck = document.getElementById('updCheck');
  if (ck) ck.addEventListener('click', async () => {
    ck.disabled = true; ck.textContent = '检查中…';
    try {
      const u = await api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.update = u;
      toast(u.supported === false ? '当前安装方式不支持自动更新'
        : (u.reason === 'fetch-failed' ? '检查失败：' + (u.error || '网络或权限问题')
          : (u.behind > 0
            ? (u.mode === 'payload' ? '发现新版本 v' + u.latestShort : '发现 ' + u.behind + ' 个新提交')
            : '已是最新版本')));
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
  return `<div class="sec" id="set-service">
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
  return `<div class="sec" id="set-sync">
      <div class="secTitle">多端同步（Git 仓库）</div>
      <p class="hint" style="line-height:1.85;">
        把数据快照提交到<b>你自己的 Git 仓库</b>（建议私有仓库），实现多台设备同步：<b>改动后自动上传</b>、<b>启动时自动拉取</b>。<br>
        · 密钥类信息（AI API Key、同步令牌、LeetCode 登录态）<b>不会</b>被同步<br>
        · 两边都有新改动时<b>不会直接覆盖</b>，会停下来让你二选一（用本地 / 用云端）<br>
        · 本机工作副本：<code>data/sync/</code>（已在 .gitignore 中）
      </p>
      ${st.conflict ? `<div class="syncConflict">
        <div class="cfTitle">⚠️ 检测到冲突：本地和云端都有新改动</div>
        <div class="cfSub">为避免丢数据，这次没有自动同步，请二选一：</div>
        <div class="toolbarRow"><button class="btn primary" id="cfOpen">查看并选择</button></div>
      </div>` : ''}
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
        <div class="field"><label>用户名（可选）</label><input id="syncUser" value="${esc(st.user || '')}" placeholder="oauth2 或你的账号"></div>
      </div>
      <div class="field"><label>密码 / 访问令牌（私有仓库需要）</label>
        <input type="password" id="syncToken" value="${st.hasToken ? '••••••••' : ''}" placeholder="${st.hasToken ? '已保存（留空则不修改）' : '粘贴访问令牌'}">
        <div class="hint" style="margin-top:4px;">AtomGit 已关闭密码登录：令牌去网页端头像 → 设置 → 访问令牌生成，填到这里（不是登录密码）。</div>
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
        ${st.outlibWarn ? `<br><span style="color:var(--danger,#ef4444); font-weight:600;">⚠ 产出库：${esc(st.outlibWarn)}</span>`
          + (st.outlibDangling && st.outlibDangling.length ? `<br><span style="opacity:.85;">缺文件的有：${st.outlibDangling.map(x => esc(x.name)).join('、')}${st.outlibDangling.length >= 8 ? ' 等' : ''}</span>` : '')
          + `<br><span style="opacity:.85;">这些条目只有名字、没有文件本体，到哪台设备上都点不开。要恢复只能重新上传一次。</span>` : ''}
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
        ? '✅ <b>已保存，仓库可访问</b>' + (t.branches && t.branches.length ? '（分支：' + esc(t.branches.join('、')) + '）' : '（仓库还是空的，点「立即上传」创建首个快照）') + '<br>自动上传 / 拉取按上面的开关生效'
        : '❌ <b>已保存，但仓库连不上</b>：' + esc(t.message || '');
      toast(t.ok ? '同步已保存，仓库可访问' : '已保存，但仓库连不上');
      /* 原地刷新回显，不整页重绘 —— 以前调 renderSettings()，页面闪一下不说，
         刚显示的测试结果当场被清空，滚动位置也丢了。 */
      try {
        const fresh = await api('/api/sync/status');
        state.syncStatus = fresh;
        const tk = document.getElementById('syncToken');
        if (tk) { tk.value = ''; tk.placeholder = fresh.hasToken ? '已保存（留空则不修改）' : '粘贴访问令牌'; }
        const ur = document.getElementById('syncUser');
        if (ur && fresh.user) ur.value = fresh.user;
      } catch (e) {}
    } catch (e) { toast(e.message); if (box) box.innerHTML = '❌ ' + esc(e.message); }
    finally { sv.disabled = false; sv.textContent = '保存并测试连接'; }
  });
  const cf = document.getElementById('cfOpen');
  if (cf) cf.addEventListener('click', () => {
    const c = (state.syncStatus || {}).conflict;
    if (c) openSyncConflictDialog(c);
    else toast('冲突信息已过期，点「立即拉取」重新检查');
  });
  const sp = document.getElementById('syncPush');
  if (sp) sp.addEventListener('click', async () => {
    sp.disabled = true; sp.textContent = '上传中…';
    if (box) box.innerHTML = '正在导出并推送到仓库…';
    try {
      await save();
      const r = await api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.conflict) {
        if (box) box.innerHTML = '⚠️ 云端也有新改动，已暂停上传，请二选一。';
        openSyncConflictDialog(r.conflict);
      } else {
        const c = r.counts || {};
        if (box) box.innerHTML = '✅ 上传成功 · ' + (c.goals || 0) + ' 个目标 / ' + (c.nodes || 0) + ' 个节点';
        toast('已上传到同步仓库');
      }
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
      if (r.conflict) {
        if (box) box.innerHTML = '⚠️ 本地和云端都有新改动，已暂停同步，请二选一（不会覆盖任何一边）。';
        openSyncConflictDialog(r.conflict);
      } else if (r.imported) {
        if (box) box.innerHTML = '✅ 已导入来自 ' + esc(r.device || '其它设备') + ' 的数据（' + ((r.counts || {}).goals || 0) + ' 个目标），页面即将刷新…';
        toast('已导入最新数据');
        setTimeout(() => location.reload(), 1200);
      } else {
        if (box) box.innerHTML = 'ℹ ' + esc(r.message || '已是最新');
        toast(r.message || '已是最新');
      }
    } catch (e) { toast('拉取失败：' + e.message); if (box) box.innerHTML = '❌ 拉取失败：' + esc(e.message); }
    finally { pl.disabled = false; pl.textContent = '⬇ 立即拉取'; }
  });
}

/* 同步冲突二选一。对话框列出两边摘要（设备 / 时间 / 数量），用户点哪个走哪个。
   选云端 = 用云端覆盖本地（服务端导入前已自动 backup）；选本地 = 保留本地并上传。 */
function openSyncConflictDialog(c) {
  const old = document.getElementById('cfDialog');
  if (old) old.remove();
  const fmtN = n => (n == null ? '—' : n);
  const r = c.remote || {}, l = c.local || {};
  const rc = r.counts || {}, lc = l.counts || {};
  const div = document.createElement('div');
  div.id = 'cfDialog';
  div.className = 'tutDialog';
  div.innerHTML = `<div class="tdHead"><span>⚠️</span><span>同步冲突：用哪边的数据？</span><button class="btn tiny" id="cfX">×</button></div>
    <div class="tdBody">
      <p class="hint" style="margin:0 0 10px;">本地和云端<b>都有</b>对方没有的新改动，自动同步已暂停，不会覆盖任何一边。请看完再选：</p>
      <div class="cfCols">
        <div class="cfSide local">
          <div class="cfSideT">💻 本地这台设备</div>
          <div class="cfMeta">最后改动：${esc(fmtDate(l.changeAt) || '—')}</div>
          <div class="cfMeta">目标 ${fmtN(lc.goals)} · 路线节点 ${fmtN(lc.nodes)} · 资料 ${fmtN(lc.sources)} · 教程 ${fmtN(lc.tutorials)}</div>
        </div>
        <div class="cfSide remote">
          <div class="cfSideT">☁️ 云端</div>
          <div class="cfMeta">来自 ${esc(r.device || '其它设备')} · ${esc(fmtDate(r.savedAt) || '—')}</div>
          <div class="cfMeta">目标 ${fmtN(rc.goals)} · 路线节点 ${fmtN(rc.nodes)} · 资料 ${fmtN(rc.sources)} · 教程 ${fmtN(rc.tutorials)}</div>
        </div>
      </div>
      <p class="hint" style="margin:10px 0 0;">选「用云端」会先自动备份本地（data/backups），万一选错还能找回来。</p>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn" id="cfLocal">💻 保留本地并上传</button>
        <button class="btn primary" id="cfRemote">☁️ 用云端覆盖本地</button>
      </div>
      <div class="hint" id="cfMsg" style="margin-top:8px;"></div>
    </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#cfX').addEventListener('click', close);
  const msg = div.querySelector('#cfMsg');
  const run = async (choice, btn, label) => {
    btn.disabled = true;
    msg.textContent = label + '…';
    try {
      const res = await api('/api/sync/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
      if (res.conflict) { msg.textContent = '对方又有新改动，冲突已更新，请重新看一眼再选。'; openSyncConflictDialog(res.conflict); return; }
      if (choice === 'remote' && res.imported) {
        msg.textContent = '✅ 已用云端覆盖本地，页面即将刷新…';
        toast('已用云端数据覆盖本地');
        setTimeout(() => location.reload(), 1200);
      } else {
        msg.textContent = '✅ 已保留本地并上传到云端';
        toast('已保留本地并上传');
        close();
        renderSettings();
      }
    } catch (e) { msg.textContent = '❌ ' + e.message; btn.disabled = false; }
  };
  div.querySelector('#cfLocal').addEventListener('click', e => {
    if (!confirm('确定保留本地并上传？云端的新改动会被本地覆盖（云端设备下次同步时会看到冲突提示，可再选回来）。')) return;
    run('local', e.target, '正在上传本地数据');
  });
  div.querySelector('#cfRemote').addEventListener('click', e => {
    if (!confirm('确定用云端覆盖本地？本地的新改动会被替换（已自动备份，可回滚）。')) return;
    run('remote', e.target, '正在用云端覆盖本地');
  });
}
/* 服务商预设。优先用服务端 /api/ai/providers（那边是唯一来源，模型建议值会更新），
   取不到时退回这份内置表，保证设置页至少还能选服务商、填地址。
   模型建议值刻意保守 —— 真正的权威列表是「获取可用模型」向该地址现取的。 */
/* 兜底表：/api/ai/providers 取不到时才用，平时以服务端为准。
   内容与 server/ai.js 的 PROVIDERS 保持一致（2026-10 核对过官方文档）。 */
const AI_PROVIDERS_FALLBACK = [
  { id: 'deepseek', name: 'DeepSeek', brand: 'DS', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], vision: 'deepseek-flash' },
  { id: 'qwen', name: '通义千问', brand: 'QW', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-plus', 'qwen-turbo', 'qwen-max'], vision: 'qwen-vl-max' },
  { id: 'moonshot', name: 'Kimi', brand: 'KM', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'], vision: 'kimi-k3' },
  { id: 'zhipu', name: '智谱 GLM', brand: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5'], vision: 'glm-4.6v' },
  { id: 'siliconflow', name: '硅基流动', brand: 'SF', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/DeepSeek-V4-Flash'], vision: '' },
  { id: 'openai', name: 'OpenAI', brand: 'OA', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini'], vision: 'gpt-4o' },
  { id: 'openrouter', name: 'OpenRouter', brand: 'OR', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.6', 'google/gemini-3.8-flash'], vision: '' },
  { id: 'ollama', name: '本地 Ollama', brand: 'OL', baseUrl: 'http://localhost:11434/v1', models: ['qwen3:8b', 'llama3.1:8b', 'deepseek-r1:8b'], vision: 'gemma3:4b', noKey: true },
  { id: 'zen', name: 'OpenCode Zen', brand: 'ZEN', baseUrl: 'https://opencode.ai/zen/v1', models: ['space-bunny-free', 'big-pickle', 'mimo-v2.6-flash-free', 'ling-3.1-flash-free'], vision: '' },
  { id: 'custom', name: '其他 / 自填', brand: '···', baseUrl: '', models: [], vision: '' },
  { id: 'opencode', name: 'opencode CLI', brand: 'OC', baseUrl: '', models: [], vision: '', isOpencode: true }
];
let AI_PROVIDERS = AI_PROVIDERS_FALLBACK;
/* 可添加的 Agent 类型（服务端 /api/ai/agents 下发，以后加 codex 之类不用改前端） */
const AI_AGENTS_FALLBACK = [
  { id: 'opencode', name: 'opencode CLI', brand: 'OC', hint: '本机已安装 opencode 时可选' }
];
let AI_AGENTS = AI_AGENTS_FALLBACK;

/* ---------- AI 连接卡片 ----------
   交互按用户描述来：先点服务商按钮（地址自动填好）→ 填密钥 → 模型以按钮成排出现，
   点哪个加哪个。不给「下拉 + 勾选框 + 先保存才能取列表」那套绕路。 */

/** 一排服务商按钮。点了就把 Base URL 等自动填好。
 *  opencode 不在这里（它走 Agent 连接，有自己单独的流程）。 */
function providerButtonsHTML(sel) {
  const list = AI_PROVIDERS.filter(p => !p.isOpencode);
  return `<div class="provGrid">${list.map(p => `
    <button type="button" class="provBtn${p.id === sel ? ' on' : ''}" data-prov="${esc(p.id)}" title="${esc(p.baseUrl || '自己填地址')}">
      <span class="pbBrand">${esc(p.brand)}</span>
      <span class="pbName">${esc(p.name)}</span>
    </button>`).join('')}</div>`;
}
/** 一排模型按钮。on = 已选；ok/bad = 批量测试过的结果（悬停看详情）；testing = 正在测。 */
function modelButtonsHTML(models, sel, tested) {
  const s = sel || [], t = tested || {};
  if (!models.length) return '<div class="hint" style="padding:8px 2px;">还没有可选模型 —— 先填好密钥，再点「获取并测试」。</div>';
  return `<div class="mBtnGrid">${models.map(m => {
    const st = t[m];
    const msg = t[m + '_msg'];
    return `<button type="button" class="mBtn${s.indexOf(m) >= 0 ? ' on' : ''}${st === true ? ' ok' : ''}${st === false ? ' bad' : ''}" data-mbtn="${esc(m)}"${msg ? ` title="${esc(msg)}"` : ''}>${esc(m)}</button>`;
  }).join('')}</div>`;
}
/** 某张卡的批量测试结果：aiCtx.tested[connId] = {模型名: true/false, 模型名_msg: '原因'} */
function testedOf(card) {
  const cid = card.getAttribute('data-conn');
  return (window.__aiTested && window.__aiTested[cid]) || {};
}
/** 给单个模型按钮上测试态（不整区重绘，进度实时可见） */
function paintBtn(card, m, state, msg) {
  const b = Array.from(card.querySelectorAll('[data-mbtn]')).find(x => x.getAttribute('data-mbtn') === m);
  if (!b) return;
  b.classList.remove('ok', 'bad', 'testing');
  if (state === true) b.classList.add('ok');
  else if (state === false) b.classList.add('bad');
  else if (state === 'testing') b.classList.add('testing');
  if (msg != null) b.title = msg;
}
/** 已选模型区：从池子里把选中的挑出来排成小片，可单独移除 */
function chosenChipsHTML(models, sel) {
  const s = sel || [];
  if (!s.length) return '<div class="hint" style="padding:4px 2px;">还没选模型 —— 点上面的模型按钮加入。</div>';
  /* 每个小片自带「测」：点一下只测这一个模型，结果直接标在小片上（✅/❌ + 原因）。
     注意：data-chip 留在外层 span，data-mtest 在按钮上，点「测」不能触发移除。 */
  return `<div class="mChips">${s.map(m => `<span class="mChip" data-chip="${esc(m)}">${esc(m)}<button type="button" class="mT" data-mtest="${esc(m)}" title="只测试这个模型能否联通">测</button><i title="移除">×</i></span>`).join('')}</div>`;
}

/** 地址栏只留主机名当副标题：https://api.deepseek.com/v1 → api.deepseek.com */
function shortHost(base) {
  const s = String(base || '').trim();
  if (!s) return '';
  try { return new URL(s).hostname; } catch (e) { return s.replace(/^https?:\/\//, '').split('/')[0]; }
}
/** 连接卡折叠状态（localStorage，只记折起来的 id；新卡默认展开） */
function connFolded(id) {
  try { return !!(JSON.parse(localStorage.getItem('sierxing-conn-fold') || '{}')[id]); } catch (e) { return false; }
}
/** Agent 选择按钮（以后加 codex 之类只改服务端 AGENTS，前端自动多出来） */
function agentButtonsHTML(sel) {
  const list = AI_AGENTS;
  return `<div class="provGrid">${list.map(a => `
    <button type="button" class="provBtn${a.id === sel ? ' on' : ''}" data-agent="${esc(a.id)}" title="${esc(a.hint || '')}">
      <span class="pbBrand">${esc(a.brand)}</span>
      <span class="pbName">${esc(a.name)}</span>
    </button>`).join('')}</div>`;
}
function connCardHTML(c, provs, ctx) {
  const kind = (c.kind === 'agent' || c.provider === 'opencode') && c.purpose !== 'vision' ? 'agent' : 'api';
  if (kind === 'agent') return agentCardHTML(c, ctx);
  const pid = c.providerId || '';
  const p = (provs || []).find(x => x.id === pid);
  const isVis = c.purpose === 'vision';
  const sel = c.models || [];
  /* avail：已经取到的可选模型。取之前先用服务商自带的常用模型占位，
     这样「点了 DeepSeek」立刻就有模型按钮可选，不用先取一次。 */
  const avail = (ctx && ctx.avail && ctx.avail[c.id]) || (p ? (p.models || []) : []);
  /* 连接名不让用户填了：直接用服务商名（DeepSeek），重名的自动加序号。
     之前那个「连接名称」输入框用户根本不知道填什么 —— 它确实没有意义。 */
  const dispName = c.name || (p ? p.name : '自定义连接');

  return `<div class="connCard" data-conn="${esc(c.id)}" data-kind="api" data-purpose="${isVis ? 'vision' : 'chat'}" data-prov="${esc(pid)}">
    <div class="ccHead">
      <button type="button" class="foldBtn" data-act="fold" title="折叠 / 展开">${connFolded(c.id) ? '▸' : '▾'}</button>
      <span class="ccBrand" data-role="brand">${esc((p && p.brand) || '···')}</span>
      <span class="ccTitle" data-role="title">${esc(dispName)}</span>
      ${isVis ? '<span class="ccKind vis">识图</span>' : ''}
      <div class="spacer"></div>
      <span class="dirtyDot" data-role="dirty" hidden>●未保存</span>
      <label class="sw" title="启用 / 停用这条连接"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? 'checked' : ''}><i></i></label>
      <button class="btn tiny cbtn primary" data-act="saveone">保存</button>
      <button class="btn tiny danger" data-act="del">删除</button>
    </div>
    <div class="ccBody" data-role="body"${connFolded(c.id) ? ' hidden' : ''}>
    <div class="ccBlock">
      <div class="ccLabel"><span class="step">1</span>选择服务商 <span class="q" data-tip="点一下自动填好该服务商的官方地址和视觉模型">?</span></div>
      ${providerButtonsHTML(pid)}
    </div>

    <div class="ccBlock">
      <div class="ccLabel"><span class="step">2</span>填地址与密钥 <span class="q" data-tip="${(p && p.noKey) ? '本地服务，密钥可留空' : '填完密钥才能取到模型列表'}">?</span></div>
      <div class="ccRow">
        <label class="ccWide">API 地址
          <span class="inWrap"><i>🔗</i><input class="mono" data-f="baseUrl" value="${esc(c.baseUrl || '')}" placeholder="选服务商会自动填好" spellcheck="false"></span>
        </label>
        <label class="ccWide">API 密钥
          <span class="inWrap"><i>🔑</i><input type="password" data-f="apiKey" value="" placeholder="${c.hasKey ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"><button type="button" class="peekBtn" data-act="peek" title="显示 / 隐藏">👁</button></span>
        </label>
      </div>
      ${p && p.docs ? `<div class="ccDoc">没密钥？<a href="${esc(p.docs)}" target="_blank" rel="noopener">去 ${esc(p.name)} 控制台申请 →</a></div>` : ''}
    </div>

    <div class="ccBlock">
      <div class="ccLabel"><span class="step">3</span>选择模型
        <span class="q" data-tip="${avail.length ? '绿=刚测过能通，红=不通（悬停看原因）；列表里没有就下面手填' : '点右侧获取：先取该地址支持的模型，再逐个测能否联通；列表里没有就下面手填'}">?</span>
        <div class="spacer"></div>
        <button class="btn tiny cbtn" data-act="test">✓ 测试连通</button>
        <button class="btn tiny cbtn primary" data-act="models">🔄 获取并测试</button>
      </div>
      <div data-role="availBox">${modelButtonsHTML(avail, sel, ((window.__aiTested || {})[c.id] || {}))}</div>
      <div class="mAddRow">
        <span class="inWrap"><i>⌨️</i><input data-role="mCustom" placeholder="手动输入模型名，回车加入" spellcheck="false"></span>
        <span class="q" data-tip="官方出新模型、名单没更新时用这个">?</span>
        <button type="button" class="btn tiny cbtn" data-act="madd">添加</button>
      </div>
      <div class="ccLabel" style="margin-top:10px;"><span data-role="selCount">已选模型（${sel.length}）</span><span class="hint">保存后才会出现在对话栏</span></div>
      <div data-role="chosenBox">${chosenChipsHTML(avail, sel)}</div>
      <div class="ccHint" data-role="msghint"></div>
      <details class="ccAdv"><summary>更多选项（超时）</summary>
        <div class="ccRow" style="margin-top:8px;">
          <label>单次请求超时（毫秒）
            <span class="inWrap"><i>⏱️</i><input data-f="timeoutMs" value="${esc(c.timeoutMs || '')}" placeholder="默认 300000"></span>
          </label>
        </div>
      </details>
    </div>
    </div>
  </div>`;
}
/** Agent 连接卡：没有地址密钥这两项，流程是 选Agent → 检测本机 → 列模型 → 选 → 测。 */
function agentCardHTML(c, ctx) {
  const aid = c.providerId || 'opencode';
  const a = AI_AGENTS.find(x => x.id === aid) || AI_AGENTS[0] || { id: aid, name: aid, brand: 'AG' };
  const sel = c.models || [];
  const avail = (ctx && ctx.avail && ctx.avail[c.id]) || [];
  const agentState = (ctx && ctx.agentState) || {};
  const probe = agentState[aid];
  const dispName = c.name || a.name;

  return `<div class="connCard" data-conn="${esc(c.id)}" data-kind="agent" data-purpose="chat" data-prov="${esc(aid)}">
    <div class="ccHead">
      <button type="button" class="foldBtn" data-act="fold" title="折叠 / 展开">${connFolded(c.id) ? '▸' : '▾'}</button>
      <span class="ccBrand" data-role="brand">${esc(a.brand || 'AG')}</span>
      <span class="ccTitle" data-role="title">${esc(dispName)}</span>
      <span class="ccKind">Agent</span>
      <div class="spacer"></div>
      <span class="dirtyDot" data-role="dirty" hidden>●未保存</span>
      <label class="sw" title="启用 / 停用这条连接"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? 'checked' : ''}><i></i></label>
      <button class="btn tiny cbtn primary" data-act="saveone">保存</button>
      <button class="btn tiny danger" data-act="del">删除</button>
    </div>
    <div class="ccBody" data-role="body"${connFolded(c.id) ? ' hidden' : ''}>
    <div class="ccBlock">
      <div class="ccLabel"><span class="step">1</span>选择 Agent <span class="q" data-tip="${esc(a.hint || '以后支持 codex 等其它 Agent 时，这里会自动多出来')}">?</span></div>
      ${agentButtonsHTML(aid)}
    </div>
    <div class="ccBlock">
      <div class="ccLabel"><span class="step">2</span>检测本机并获取模型
        <span class="q" data-tip="先确认本机装了该 Agent，再列出它能用的模型；获取后自动逐个测试，绿=通">?</span>
        <div class="spacer"></div>
        <button class="btn tiny cbtn" data-act="test">✓ 测试连通</button>
        <button class="btn tiny cbtn primary" data-act="models">🔄 检测并测试</button>
      </div>
      <div class="ocProbe" data-role="ocprobe">${probe
        ? (probe.installed
          ? `<span class="ok">✓ 已检测到 ${esc(a.name)}${esc(probe.version ? ' ' + probe.version : '')}</span>`
          : `<span class="bad">✗ ${esc(probe.hint || '未检测到')}</span>`)
        : '<span class="muted">点上面的按钮检测本机并列出可用模型</span>'}</div>
      <div data-role="availBox">${modelButtonsHTML(avail, sel, ((window.__aiTested || {})[c.id] || {}))}</div>
      <div class="mAddRow">
        <span class="inWrap"><i>⌨️</i><input data-role="mCustom" placeholder="手动输入模型名，回车加入" spellcheck="false"></span>
        <span class="q" data-tip="官方出新模型、名单没更新时用这个">?</span>
        <button type="button" class="btn tiny cbtn" data-act="madd">添加</button>
      </div>
      <div class="ccLabel" style="margin-top:10px;"><span data-role="selCount">已选模型（${sel.length}）</span><span class="hint">保存后才会出现在对话栏</span></div>
      <div data-role="chosenBox">${chosenChipsHTML(avail, sel)}</div>
      <div class="ccHint" data-role="msghint"></div>
      <details class="ccAdv"><summary>更多选项（代理 / 超时）</summary>
        <div class="ccRow" style="margin-top:8px;">
          <label>Agent 代理
            <span class="inWrap"><i>🤖</i><input data-f="agent" value="${esc(c.agent || 'NoTools')}" placeholder="NoTools（禁用工具、只输出文本）"></span>
          </label>
          <label>单次请求超时（毫秒）
            <span class="inWrap"><i>⏱️</i><input data-f="timeoutMs" value="${esc(c.timeoutMs || '')}" placeholder="默认 300000"></span>
          </label>
        </div>
      </details>
    </div>
    </div>
  </div>`;
}
/* 设置页底部的状态行（初次渲染与保存后原地刷新共用，不整页重绘） */
function aiStatusBoxHTML(st) {
  st = st || {};
  return `${st.connCount
    ? `已启用 <b>${st.connCount}</b> 条连接 · 共 <b>${st.modelCount}</b> 个可选模型${st.modelCount ? '' : '（还没选模型，请到上面点模型按钮加入）'}`
    : `<span style="color:var(--warn)">还没有可用的 AI 连接</span>`}
  ${st.baseUrl ? '<br>默认连接：' + esc(st.baseUrl) : ''}
  ${st.model ? ' · 默认模型 ' + esc(st.model) : ''}
  ${st.hint ? '<br><span style="color:var(--warn)">' + esc(st.hint) + '</span>' : ''}`;
}
/* ---- 设置页：外观主题（亮 / 暗各选一个皮肤，只改颜色） ---- */
function themeSettingsHTML() {
  const comps = (state.componentList || []).filter(c => c.kind === 'theme' || c.scope === 'theme');
  const optsFor = mode => {
    const cur = themeFor(mode);
    const head = `<option value="" ${cur ? '' : 'selected'}>默认（内置${mode === 'light' ? '亮色' : '暗色'}）</option>`;
    return head + comps.map(c => {
      const tag = c.mode === 'dark' ? '深色' : c.mode === 'light' ? '浅色' : '';
      return `<option value="${esc(c.id)}" ${cur === c.id ? 'selected' : ''}>${esc((c.icon || '🎨') + ' ' + c.name + (tag ? '（' + tag + '）' : ''))}</option>`;
    }).join('');
  };
  return `<p class="hint" style="margin:-4px 0 12px;">只是换颜色（字体、布局不动）：白天挑一个柔和的浅色主题，晚上挑一个不那么黑的深色主题。选择立即生效，只影响这台设备。</p>
  <div class="ccRow">
    <label class="ccWide">☀️ 亮色模式用
      <span class="inWrap"><select id="themeLight" class="sxi-sel">${optsFor('light')}</select></span>
    </label>
    <label class="ccWide">🌙 暗色模式用
      <span class="inWrap"><select id="themeDark" class="sxi-sel">${optsFor('dark')}</select></span>
    </label>
  </div>
  <div class="hint" id="themeMsg" style="margin-top:8px;">${themeMsgText()}</div>`;
}
function themeMsgText() {
  const nameOf = id => {
    if (!id) return '默认配色';
    const c = (state.componentList || []).find(x => x.id === id);
    return c ? c.name : id;
  };
  return '当前 → 亮色：<b>' + esc(nameOf(themeFor('light'))) + '</b>　·　暗色：<b>' + esc(nameOf(themeFor('dark'))) + '</b>';
}
/* ---- 设置页：检索增强（RAG） ---- */
function ragSettingsHTML(s) {
  const gopts = (state.goals || []).map(g => `<option value="${g.id}">${esc(g.title)}</option>`).join('')
    || '<option value="">（还没有目标）</option>';
  return `<p class="hint" style="margin:-4px 0 12px;">资料一多，把整包资料塞给模型既贵又抓不住重点。开启后：<b>规划、拆任务、对话</b>会先从资料库里检索与当前问题最相关的片段再作答。不配向量模型也能用（关键词检索）；配上「向量模型」即升级为语义检索（问“用户登录怎么做”也能找到 auth 相关段落，哪怕正文没出现“登录”二字）。</p>
  <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;">
    <input type="checkbox" id="ragEnabled" ${s.rag_enabled !== false ? 'checked' : ''}> <b>启用检索增强</b>（推荐；关闭则回到「前 N 条资料整段注入」）
  </label>
  <div class="field visPickField">
    <label>向量模型 <span class="muted" style="font-weight:400;">（可选 —— 用于语义检索；不是所有服务商都提供，如 DeepSeek 暂无）</span></label>
    <div class="ccRow" style="margin-bottom:9px;">
      <label class="ccWide">API 地址
        <span class="inWrap"><i>🔗</i><input class="mono" id="embBase" value="${esc(s.emb_base_url || '')}" placeholder="本地 Ollama：http://localhost:11434/v1" spellcheck="false"></span>
      </label>
      <label class="ccWide">API 密钥
        <span class="inWrap"><i>🔑</i><input type="password" id="embKey" value="" placeholder="${s.emb_has_key ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"></span>
      </label>
    </div>
    <div class="ccRow">
      <label class="ccWide">向量模型名
        <span class="inWrap"><i>⌨️</i><input id="embModel" value="${esc(s.emb_model || '')}" placeholder="如 bge-m3:latest / BAAI/bge-m3 / text-embedding-v3" spellcheck="false"></span>
      </label>
    </div>
    <div class="mBtnGrid" id="embOpts" style="margin-top:8px;"><div class="hint">本机装了 Ollama 的话点下面「🦙 本地 Ollama」一键填好（免费、数据不出本机）；云端可用：硅基流动 BAAI/bge-m3、通义千问 text-embedding-v3、OpenAI text-embedding-3-small。</div></div>
    <div class="toolbarRow" style="margin-top:9px;">
      <button class="btn tiny cbtn" id="embOllama">🦙 本地 Ollama</button>
      <button class="btn tiny cbtn" id="embFetch">🔄 获取可用模型</button>
      <button class="btn tiny cbtn" id="embTest">测试向量</button>
      <button class="btn tiny cbtn primary" id="embSave">保存向量配置</button>
    </div>
    <div class="hint" id="embMsg" style="margin-top:6px;"></div>
  </div>
  <div class="field" style="margin-top:14px;">
    <label>索引状态与检索预览</label>
    <div class="toolbarRow" style="margin-top:6px;">
      <select id="ragGoalSel" class="libGoalSel sxi-sel">${gopts}</select>
      <button class="btn small" id="ragBuildBtn">🧲 建立本目标索引</button>
      <button class="btn small" id="ragRefresh">刷新状态</button>
    </div>
    <div class="hint" id="ragStatus" style="margin-top:8px;">加载中…</div>
    <div class="toolbarRow" style="margin-top:8px;">
      <input id="ragQ" style="flex:1;min-width:240px;" placeholder="检索预览：输入一个具体问题，看会命中资料库里的哪些片段" spellcheck="false">
      <button class="btn small" id="ragSearchBtn">检索</button>
    </div>
    <div id="ragHits" style="margin-top:8px;"></div>
  </div>`;
}
async function renderSettings() {
  app.innerHTML = '<p class="muted">加载中…</p>';
  if (!state.componentList || !state.componentList.length) { try { await loadComponents(); } catch (e) {} }
  const [s, st] = await Promise.all([
    api('/api/settings'),
    api('/api/ai/status')
  ]);
  state.aiStatus = st;
  const provider = s.ai_provider || 'openai';
  const configured = !!st.configured;
  // 识图会用哪个模型：配置了就用配置的，否则显示自动选用的（opencode 有可读图的默认值）
  const visionHint = st.visionModel
    ? '识别图片会使用：' + st.visionModel + (st.visionModelSaved ? '' : '（未单独配置，自动选用）')
    : '识别图片需要支持视觉的模型（如 qwen-vl-max / gpt-4o / glm-4v-plus）；留空则用上面的文本模型，若它不支持读图，识图会提示失败。';

  const conns = (await api('/api/ai/connections').catch(() => ({ connections: [] }))).connections || [];
  const provRes = await api('/api/ai/providers').catch(() => ({ providers: [] }));
  const provs = (provRes.providers && provRes.providers.length) ? provRes.providers : AI_PROVIDERS_FALLBACK;
  AI_PROVIDERS = provs;
  const agentRes = await api('/api/ai/agents').catch(() => ({ agents: [] }));
  AI_AGENTS = (agentRes.agents && agentRes.agents.length) ? agentRes.agents : AI_AGENTS_FALLBACK;
  /* opencode 装没装，进设置页就先探一次 —— 用户点了 opencode 按钮就该立刻看到结论，
     不用等他自己去点「检测」。 */
  const ocState = await api('/api/ai/opencode-status').catch(() => null);
  const aiCtx = { ocState, avail: {}, agent: s.ai_opencode_agent || 'NoTools' };

  let html = `<div class="page settingsPage">
    <div class="pageHead"><button class="back js-back" data-back="#/">← 返回</button><h2 class="title" style="margin-left:10px;">设置</h2>
      <div class="spacer"></div>
      <span class="aiBadge ${configured ? 'ok' : 'bad'}">${configured ? '✓ AI 已配置' : '未配置 AI'}</span>
    </div>`;

  if (!configured) {
    html += `<div class="setupCard">
      <h3>⚙️ 先配置 AI 接入方式（3 步）</h3>
      <p class="hint" style="margin:0;">思而行的问卷、规划、教程、对话都由 AI 完成，所以需要先接入模型服务。推荐任意 <b>OpenAI 兼容接口</b>（DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenAI、本地 Ollama 都行）。</p>
      <ol class="setupSteps">
        <li>点下面「添加连接」，选一个服务商 —— <b>地址会自动填好，不用手打</b></li>
        <li>填上 <b>API 密钥</b>（本地 Ollama 可随便填），点「获取可用模型」</li>
        <li>点<b>模型按钮</b>加入要用的模型（可以多选），保存即可</li>
      </ol>
      <p class="hint" style="margin:0;">没有密钥？也可以先用 <b>本地模型</b>：装好 <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> 后添加「本地 Ollama」连接，无需密钥。</p>
    </div>`;
  }

  /* AI 连接：一条连接 = 一个服务商 + 一套地址/密钥，下挂多个模型。
     可以加多个 Base URL（同一家不同线路、或不同家并存都行），
     每条连接里多选模型；具体用哪个模型由「AI 助手」对话栏的模型下拉决定。 */
  const SET_TABS = [
    ['set-ai', '🔌 AI 接入方式'],
    ['set-rag', '🔍 检索增强'],
    ['set-theme', '🎨 外观主题'],
    ['set-sync', '🔄 多端同步'],
    ['set-service', '🖥 服务与启动'],
    ['set-update', '⬆ 版本与更新'],
    ['set-data', '💾 数据备份'],
    ['set-store', '📁 数据存储路径'],
    ['set-help', '📖 帮助'],
    ['set-about', 'ℹ 关于']
  ];
  html += `<div class="setTabs" id="setTabs" role="tablist">${SET_TABS.map(([id, label]) =>
    `<button type="button" class="setTab" data-tab="${id}" role="tab">${label}</button>`).join('')}</div>`;
  state._setTabs = SET_TABS.map(([id]) => id);
  html += `<div class="sec aiSec" id="set-ai">
      <div class="secTitle">AI 接入方式 <span class="secSub">选服务商 → 填密钥 → 点模型按钮加入</span></div>
      <p class="hint" style="margin:-4px 0 10px;">对话时在 💬 AI 助手的模型下拉里选具体用哪个 —— 可以是不同服务商、不同模型。识图走下面单独配置，不用再加连接。</p>
      <div class="toolbarRow" style="margin-bottom:12px;">
        <button class="btn primary" id="addApi">＋ API 连接</button>
        <button class="btn" id="addAgent">＋ Agent 连接</button>
      </div>
      <div id="connList">${conns.map(c => connCardHTML(c, provs, aiCtx)).join('')}</div>
      <div id="connEmpty" ${conns.length ? 'hidden' : ''} class="emptyBox" style="margin:10px 0;">
        <div class="ebIcon">🔌</div>
        <div class="ebTitle">还没有 AI 连接</div>
        <div class="ebText">点上面「添加连接」，选一个服务商（地址自动填好）→ 填密钥 → 点模型按钮加入要用的模型。</div>
      </div>
      <div class="field visPickField"><label>识图模型（单独配置）</label>
        <div class="ccRow" style="margin-bottom:9px;">
          <label class="ccWide">API 地址
            <span class="inWrap"><i>🔗</i><input class="mono" id="visBase" value="${esc(s.vis_base_url || '')}" placeholder="如 https://dashscope.aliyuncs.com/compatible-mode/v1" spellcheck="false"></span>
          </label>
          <label class="ccWide">API 密钥
            <span class="inWrap"><i>🔑</i><input type="password" id="visKey" value="" placeholder="${s.vis_has_key ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"><button type="button" class="peekBtn" id="visPeek" title="显示 / 隐藏">👁</button></span>
          </label>
        </div>
        <div class="ccRow">
          <label class="ccWide">模型名
            <span class="inWrap"><i>⌨️</i><input id="visModel" value="${esc(s.vision_model || '')}" placeholder="点下面按钮选，或手动输入" spellcheck="false"></span>
          </label>
        </div>
        <div class="mBtnGrid" id="visOpts" style="margin-top:8px;"><div class="hint">点「获取可用模型」列出该地址支持的，点一下填入上面；列表里没有就直接手填。</div></div>
        <div class="toolbarRow" style="margin-top:9px;">
          <button class="btn tiny cbtn" id="visFetch">🔄 获取可用模型</button>
          <button class="btn tiny cbtn" id="visTest">测试连通</button>
          <button class="btn tiny cbtn primary" id="visSave">保存识图配置</button>
        </div>
        <div class="hint" id="visMsg" style="margin-top:6px;">${st.visionModel ? '当前识图用：<b>' + esc(st.visionModel) + '</b>' : '还没配识图模型（不配则自动跟对话走）'}</div>
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn primary" id="saveSettings">保存全部连接</button>
        <button class="btn" id="testAi">测试第一条连接</button>
      </div>
      <div id="aiStatusBox" class="hint" style="margin-top:10px; line-height:1.8;">
        ${aiStatusBoxHTML(st)}
      </div>
    </div>
    <div class="setGrid">
    <div class="sec" id="set-rag">
      <div class="secTitle">检索增强（RAG） <span class="secSub">把资料库当知识库：按问题检索片段，而不是整包塞给模型</span></div>
      ${ragSettingsHTML(s)}
    </div>
    <div class="sec" id="set-theme">
      <div class="secTitle">外观主题 <span class="secSub">亮色 / 暗色模式各选一个皮肤；只改颜色，不改字体</span></div>
      ${themeSettingsHTML()}
    </div>
    ${await serviceSectionHTML()}
    ${await updateSectionHTML()}
    ${await syncSectionHTML()}
    <div class="sec" id="set-data">
      <div class="secTitle">数据备份</div>
      <div class="bkTip">
        <span>🛡️</span>
        <span><b>每次改动都会自动备份</b>，不用手动点。备份存在数据目录的 <code>backups/</code>，导入会覆盖现有全部数据（导入前也会自动备份一份）。</span>
      </div>
      <div class="bkTool">
        <div class="bkGroup">
          <button class="btn" id="backupNow">立即备份</button>
          <a class="btn" href="/api/export/json">导出 JSON</a>
          <label class="btn">导入 JSON<input type="file" accept=".json" id="importJson" hidden></label>
        </div>
        <span class="bkToolSep"></span>
        <div class="bkGroup"><button class="btn danger" id="bkDelSel" disabled>删除选中</button></div>
        <span class="spacer"></span>
        <div class="bkGroup">
          <span class="bkLbl">保留最近</span>
          <select class="sxi-sel" id="backupKeep">
            ${[5, 10, 20, 30, 50, 100].map(n => `<option value="${n}"${n === 30 ? ' selected' : ''}>${n} 份</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="bkHead">最近备份<span class="spacer"></span><span class="bkLbl" id="backupStat"></span></div>
      <div id="backupList"><div class="bkEmpty">正在读取…</div></div>
      <div class="bkFoot" id="backupFoot"></div>
    </div>
    <div class="sec" id="set-store">
      <div class="secTitle">数据存储路径 <span class="secSub">默认在程序目录下；C 盘吃紧就搬到 D 盘 / 移动硬盘</span></div>
      <div id="storeBox"><p class="muted" style="padding:6px 0;">正在读取…</p></div>
    </div>
    <div class="sec" id="set-help">
      <div class="secTitle">帮助</div>
      <div class="toolbarRow">
        <button class="btn" id="showGuideBtn">📖 重新查看使用引导</button>
        <a class="btn" href="https://github.com" target="_blank" rel="noopener" style="display:none">文档</a>
      </div>
      <p class="hint" style="margin-top:8px;">引导会介绍：如何接入模型、组件是什么、一条目标的完整使用流程。</p>
    </div>
    <div class="sec" id="set-about">
      <div class="secTitle">关于</div>
      <p class="muted" style="font-size:13px; line-height:1.8;">思而行 · 你的目标规划助手 · 本地运行 · 零依赖<br>数据文件：data/sierxing.db，所有数据只保存在你自己的电脑上。</p>
    </div>
    </div>
  </div>`;
  app.innerHTML = html;

  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  /* 向某条连接取模型列表，成功后把返回的模型铺成可选按钮（保留已选）。
     密钥必须先存下去再取，否则 /models 会因没鉴权 401 —— 而密钥框是空的，
     只能靠这一次带 apiKey 的提交落库。 */
  const fetchModelsInto = async (card, pid) => {
    const hint = card.querySelector('[data-role="msghint"]');
    const g = f => { const el = card.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
    const btn = card.querySelector('[data-act="models"]');
    const cid = card.getAttribute('data-conn');
    if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }
    if (hint) hint.textContent = '正在向该地址请求模型列表…';
    try {
      await api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
      const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: card.getAttribute('data-conn'),
        baseUrl: (g('baseUrl') || '').trim(),
        apiKey: (g('apiKey') || '').trim(),
        providerId: pid || '',
        provider: pid === 'opencode' ? 'opencode' : 'openai'
      }) });
      const list = r.models || [];
      if (!list.length) {
        if (hint) hint.innerHTML = '<span style="color:var(--warn)">没取到模型列表：' + esc(r.error || '接口未返回') + '</span>'
          + (r.detail ? '<br><button type="button" class="btn tiny" data-act="copydiag" style="margin-top:6px;">📋 复制诊断信息发来排查</button>' : '');
        if (r.detail) card.dataset.diag = r.detail;
        toast('没取到模型列表，见卡片内说明');
      } else {
        /* 记住这次取到的列表：保存后重绘时不再退回服务商自带的占位模型 */
        if (cid) aiCtx.avail[cid] = list;
        const sel = cardSel(card);
        const box = card.querySelector('[data-role="availBox"]');
        if (box) box.innerHTML = modelButtonsHTML(list, sel, testedOf(card));
        const chosen = card.querySelector('[data-role="chosenBox"]');
        if (chosen) chosen.innerHTML = chosenChipsHTML(list, sel);
                const lbl = card.querySelector('[data-role="selCount"]');
        if (lbl) lbl.textContent = '已选模型（' + sel.length + '）';
        if (hint) hint.innerHTML = (r.error ? '<span style="color:var(--warn)">' + esc(r.error) + '</span><br>' : '')
          + '取到 <b>' + list.length + '</b> 个模型，下面自动逐个测试连通。';
        toast('取到 ' + list.length + ' 个模型，开始批量测试');
        await batchTest(card, list);
      }
    } catch (err) {
      if (hint) hint.innerHTML = '<span style="color:var(--warn)">取列表失败：' + esc(err.message) + '</span>';
    } finally { if (btn) { btn.disabled = false; btn.textContent = '🔄 获取并测试'; } }
  };
  /* 批量测试：把刚取到的模型逐个打一遍最短请求，绿=通、红=不通（悬停看原因）。
     跑的时候按钮变成「停止」，点一下跑完当前就停。结果记全局，重绘不丢。 */
  const batchTest = async (card, list) => {
    const cid = card.getAttribute('data-conn');
    window.__aiTesting = window.__aiTesting || {};
    if (window.__aiTesting[cid]) return;
    const run = window.__aiTesting[cid] = { stop: false };
    window.__aiTested = window.__aiTested || {};
    const T = window.__aiTested[cid] = window.__aiTested[cid] || {};
    const btn = card.querySelector('[data-act="models"]');
    const hint = card.querySelector('[data-role="msghint"]');
    const oldT = btn ? btn.textContent : '';
    if (btn) { btn.disabled = false; btn.textContent = '■ 停止'; }
    let okN = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        if (run.stop) break;
        const m = list[i];
        if (hint) hint.innerHTML = `正在测 ${i + 1}/${list.length}：${esc(m)}…（点「停止」可中断）`;
        paintBtn(card, m, 'testing');
        try {
          const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
          T[m] = !!r.ok;
          T[m + '_msg'] = r.ok ? ('联通正常' + (r.sample ? ' · 回复：' + r.sample : '')) : (r.message || '连不通');
          if (r.ok) okN++;
        } catch (err) { T[m] = false; T[m + '_msg'] = err.message; }
        paintBtn(card, m, T[m], T[m + '_msg']);
      }
      if (hint) hint.innerHTML = (run.stop ? '已停止。' : '') + `测完：通 <b>${okN}</b>/${list.length}（绿=通，红=不通，悬停看原因；选中的才会进对话栏）`;
      toast(run.stop ? '已停止批量测试' : ('批量测试完：通 ' + okN + '/' + list.length));
    } finally {
      delete window.__aiTesting[cid];
      if (btn) { btn.disabled = false; btn.textContent = oldT; }
    }
  };
  /* 取某张卡的「当前选中模型」：优先看已选区的小片，没有小片时从可选按钮的 on 状态反推。
     可选按钮才是真状态源，已选小片只是它的镜像 —— 这样「取列表后重新渲染」不会丢选择。 */
  const cardSel = card => {
    const chips = Array.from(card.querySelectorAll('[data-chip]')).map(x => x.getAttribute('data-chip'));
    if (chips.length) return chips;
    return Array.from(card.querySelectorAll('[data-mbtn].on')).map(x => x.getAttribute('data-mbtn'));
  };
  /* 刷新一张卡的按钮区：可选模型排成按钮，已选的排成小片。
     ⚠️ sel 必须由调用方传进来 —— 点模型按钮时要先改选中态再重绘，
     如果重绘里再从 DOM 反读，会把刚点的那一下丢掉（点不动的 bug 就是这么来的）。 */
  const redrawCardModels = (card, sel) => {
    const avail = Array.from(card.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
    sel = sel || cardSel(card);
    const box = card.querySelector('[data-role="availBox"]');
    const chosen = card.querySelector('[data-role="chosenBox"]');
    if (box) box.innerHTML = modelButtonsHTML(avail, sel, testedOf(card));
    if (chosen) chosen.innerHTML = chosenChipsHTML(avail, sel);
    const lbl = card.querySelector('[data-role="selCount"]');
    if (lbl) lbl.textContent = '已选模型（' + sel.length + '）';
      };
  /* 把卡片上的输入读成连接对象。密钥框留空 = 没碰过，不发 apiKey，
     服务端会保留已存的密钥（否则每次保存都把密钥清成空）。
     连接名不让用户填：按服务商自动起名，重名的加序号（DeepSeek、DeepSeek 2）。
     顺序即 DOM 顺序，是稳定的，同一批卡片每次算出来的名字一致。 */
  const readConns = () => {
    const seen = {};
    return Array.from(app.querySelectorAll('.connCard')).map(card => {
      const g = f => { const el = card.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
      const en = card.querySelector('[data-f="enabled"]');
      const kind = card.getAttribute('data-kind') || 'api';
      const purpose = card.getAttribute('data-purpose') || 'chat';
      const pid = card.getAttribute('data-prov') || '';
      let base;
      if (kind === 'agent') {
        const ag = AI_AGENTS.find(x => x.id === pid);
        base = ag ? ag.name : 'Agent';
      } else {
        const p = AI_PROVIDERS.find(x => x.id === pid);
        base = p ? p.name : '自定义连接';
        if (purpose === 'vision') base += ' · 识图';
      }
      seen[pid + '|' + kind + '|' + purpose] = (seen[pid + '|' + kind + '|' + purpose] || 0) + 1;
      const n = seen[pid + '|' + kind + '|' + purpose];
      return {
        id: card.getAttribute('data-conn'),
        name: n > 1 ? base + ' ' + n : base,
        kind, purpose,
        providerId: pid,
        provider: kind === 'agent' ? 'opencode' : 'openai',
        baseUrl: (g('baseUrl') || '').trim(),
        apiKey: (g('apiKey') || '').trim(),
        agent: (g('agent') || '').trim(),
        timeoutMs: Math.max(0, Number(g('timeoutMs')) || 0),
        enabled: en ? en.checked : true,
        models: cardSel(card)
      };
    });
  };
  /* 保存后原地刷新：状态行计数 + 识图下拉选项 + 对话池失效，不整页重绘 */
  const afterSave = async savedConns => {
    state.aiModels = null;
    try { state.aiStatus = await api('/api/ai/status').catch(() => null); } catch (e) {}
    const box = document.getElementById('aiStatusBox');
    if (box && state.aiStatus) box.innerHTML = aiStatusBoxHTML(state.aiStatus);

  };
  const save = async () => {
    const r = await api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
    clearDirty();
    await afterSave(r.connections);
    return r;
  };
  /* 标某张卡未保存（输入即标）；saveone 只清自己，保存全部清所有 */
  const markDirty = card => {
    if (!card) return;
    card.classList.add('dirty');
    const d = card.querySelector('[data-role="dirty"]');
    if (d) d.hidden = false;
  };
  const clearDirty = only => {
    (only ? [only] : Array.from(app.querySelectorAll('.connCard'))).forEach(card => {
      card.classList.remove('dirty');
      const d = card.querySelector('[data-role="dirty"]');
      if (d) d.hidden = true;
    });
  };

  /* 点服务商按钮 → 自动填官方地址、视觉模型、连接名；并把该服务商的常用模型铺成按钮。
     opencode 单独一条（放最后），点了先把本机 opencode 探一遍。
     ⚠️ 必须先解绑上一轮的：renderSettings 每次保存都会重跑，直接 add 会越叠越多，
     点一次按钮触发 N 次请求。 */
  if (window.__aiSetClickH) app.removeEventListener('click', window.__aiSetClickH);
  window.__aiSetClickH = async e => {
    /* ⚠️ 必须限定 button：卡片根节点自己也带 data-prov（存当前服务商），
       不限定会把卡片里删除/模型/获取列表等所有点击都当成"切换服务商"吞掉。 */
    const pb = e.target.closest('button[data-prov]');
    if (pb && pb.closest('.connCard')) {
      const card = pb.closest('.connCard');
      const pid = pb.getAttribute('data-prov');
      card.setAttribute('data-prov', pid);
      card.querySelectorAll('button[data-prov]').forEach(x => x.classList.toggle('on', x === pb));
      const p = (provs || []).find(x => x.id === pid);
      const g = f => card.querySelector('[data-f="' + f + '"]');
      if (p) {
        if (g('baseUrl') && p.baseUrl) {
          g('baseUrl').value = p.baseUrl;
          /* 地址变了，卡头副标题跟着变，不然标题和内容对不上 */
          const host = card.querySelector('[data-role="host"]');
          if (host) host.textContent = shortHost(p.baseUrl);
        }
        const title = card.querySelector('[data-role="title"]');
        if (title) title.textContent = p.name;
        const brand = card.querySelector('[data-role="brand"]');
        if (brand) brand.textContent = p.brand || '···';
      }
      /* opencode 不再走服务商按钮（它已搬到 Agent 连接），这里只剩兜底 */
      if (pid === 'opencode') {
        card.setAttribute('data-prov', 'opencode');
        card.querySelectorAll('button[data-prov]').forEach(x => x.classList.toggle('on', x === pb));
        const probe = card.querySelector('[data-role="ocprobe"]');
        if (probe) probe.innerHTML = '<span class="muted">正在检测本机…</span>';
        try {
          const st = await api('/api/ai/agent-status?agent=opencode');
          aiCtx.agentState = aiCtx.agentState || {};
          aiCtx.agentState.opencode = st;
          if (probe) probe.innerHTML = st.installed
            ? `<span class="ok">✓ 已检测到 opencode${esc(st.version ? ' ' + st.version : '')}</span>`
            : `<span class="bad">✗ ${esc(st.hint || '未检测到')}</span>`;
          if (st.installed) await fetchModelsInto(card, 'opencode');
        } catch (err) {
          if (probe) probe.innerHTML = '<span class="bad">检测失败：' + esc(err.message) + '</span>';
        }
        return;
      }
      /* 换服务商后，之前那条连接选的模型多半在别家不存在，直接清掉免得误导 */
      const keep = cardSel(card).filter(m => !p || (p.models || []).indexOf(m) >= 0);
      if (p && (p.models || []).length) {
        const box = card.querySelector('[data-role="availBox"]');
        if (box) box.innerHTML = modelButtonsHTML(p.models, keep, testedOf(card));
        const chosen = card.querySelector('[data-role="chosenBox"]');
        if (chosen) chosen.innerHTML = chosenChipsHTML(p.models, keep);
                const lbl = card.querySelector('[data-role="selCount"]');
        if (lbl) lbl.textContent = '已选模型（' + keep.length + '）';
      }
      return;
    }

    /* 点 Agent 按钮 → 切 Agent 类型，自动检测本机并列模型（以后加 codex 同走这里） */
    const ab = e.target.closest('button[data-agent]');
    if (ab && ab.closest('.connCard')) {
      const card = ab.closest('.connCard');
      const aid = ab.getAttribute('data-agent');
      card.setAttribute('data-prov', aid);
      card.querySelectorAll('button[data-agent]').forEach(x => x.classList.toggle('on', x === ab));
      const a = AI_AGENTS.find(x => x.id === aid);
      const title = card.querySelector('[data-role="title"]');
      if (title) title.textContent = a ? a.name : aid;
      const brand = card.querySelector('[data-role="brand"]');
      if (brand) brand.textContent = a ? (a.brand || 'AG') : 'AG';
      const probe = card.querySelector('[data-role="ocprobe"]');
      if (probe) probe.innerHTML = '<span class="muted">正在检测本机…</span>';
      try {
        const st = await api('/api/ai/agent-status?agent=' + encodeURIComponent(aid));
        aiCtx.agentState = aiCtx.agentState || {};
        aiCtx.agentState[aid] = st;
        if (probe) probe.innerHTML = st.installed
          ? `<span class="ok">✓ 已检测到${esc((a && a.name) || aid)}${esc(st.version ? ' ' + st.version : '')}</span>`
          : `<span class="bad">✗ ${esc(st.hint || '未检测到')}</span>`;
        if (st.installed) await fetchModelsInto(card, aid);
        else toast(st.hint || '未检测到');
      } catch (err) {
        if (probe) probe.innerHTML = '<span class="bad">检测失败：' + esc(err.message) + '</span>';
      }
      return;
    }

    /* 识图模型按钮：点一下填入输入框 */
    const vo = e.target.closest('[data-visopt]');
    if (vo) {
      const inp = document.getElementById('visModel');
      if (inp) {
        inp.value = vo.getAttribute('data-visopt');
        document.querySelectorAll('#visOpts [data-visopt]').forEach(x => x.classList.toggle('on', x === vo));
      }
      return;
    }
    /* 点模型按钮 → 加入 / 移出 */
    const mb = e.target.closest('[data-mbtn]');
    if (mb) {
      const card = mb.closest('.connCard');
      const m = mb.getAttribute('data-mbtn');
      const sel = cardSel(card);
      const i = sel.indexOf(m);
      if (i >= 0) sel.splice(i, 1); else sel.push(m);
      redrawCardModels(card, sel);
      return;
    }
    /* 只测这一个模型：结果标在小片上，不动其它。必须放移除分支前面，
       否则点「测」会被当成点小片而删掉模型。 */
    const mt = e.target.closest('[data-mtest]');
    if (mt) {
      const card = mt.closest('.connCard');
      const m = mt.getAttribute('data-mtest');
      const cid = card.getAttribute('data-conn');
      mt.disabled = true; mt.textContent = '…';
      try {
        const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
        const chip = card.querySelector(`[data-chip="${CSS.escape(m)}"]`);
        mt.textContent = r.ok ? '✓' : '!';
        if (chip) {
          chip.classList.remove('ok', 'bad');
          chip.classList.add(r.ok ? 'ok' : 'bad');
          chip.title = r.ok ? ('联通正常' + (r.sample ? ' · 回复：' + r.sample : '')) : ('连不通：' + (r.message || ''));
        }
        toast(r.ok ? m + ' 联通正常' : m + ' 连不通');
      } catch (err) {
        mt.textContent = '!';
        toast('测试失败：' + err.message);
      } finally { mt.disabled = false; if (mt.textContent === '…') mt.textContent = '测'; }
      return;
    }
    /* 点已选小片的 × → 移除 */
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const card = chip.closest('.connCard');
      const m = chip.getAttribute('data-chip');
      const sel = cardSel(card).filter(x => x !== m);
      const avail = Array.from(card.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
      const box = card.querySelector('[data-role="availBox"]');
      if (box) box.innerHTML = modelButtonsHTML(avail.length ? avail : (provs.find(x => x.id === card.getAttribute('data-prov')) || {}).models || [], sel, testedOf(card));
      const chosen = card.querySelector('[data-role="chosenBox"]');
      if (chosen) chosen.innerHTML = chosenChipsHTML(avail, sel);
      const lbl = card.querySelector('[data-role="selCount"]');
      if (lbl) lbl.textContent = '已选模型（' + sel.length + '）';
            return;
    }

    /* 三种添加：API 连接 / Agent 连接（识图走下面专区，不再新开卡） */
    const addApi = e.target.closest('#addApi');
    const addAgent = e.target.closest('#addAgent');
    if (addApi || addAgent) {
      const list = document.getElementById('connList');
      const id = 'c' + Date.now().toString(36);
      const draft = addAgent
        ? { id, name: '', kind: 'agent', purpose: 'chat', provider: 'opencode', providerId: 'opencode', baseUrl: '', apiKey: '', agent: 'NoTools', timeoutMs: 0, models: [], enabled: true, hasKey: false }
        : { id, name: '', kind: 'api', purpose: 'chat', provider: 'openai', providerId: '', baseUrl: '', apiKey: '', agent: '', timeoutMs: 0, models: [], enabled: true, hasKey: false };
      list.insertAdjacentHTML('beforeend', connCardHTML(draft, provs, aiCtx));
      document.getElementById('connEmpty').hidden = true;
      const el = list.lastElementChild;
      if (el) el.scrollIntoView({ block: 'nearest' });
      return;
    }
    const btn = e.target.closest('.connCard [data-act]');
    if (!btn) return;
    const card = btn.closest('.connCard');
    const act = btn.getAttribute('data-act');
    /* 密钥明文开关：只改输入框类型，不动值 */
    if (act === 'peek') {
      const inp = btn.closest('.inWrap').querySelector('input');
      if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; btn.textContent = inp.type === 'password' ? '👁' : '🙈'; }
      return;
    }
    /* 复制诊断信息：取列表失败时，把服务端带回的原始输出贴给开发者看 */
    if (act === 'copydiag') {
      const txt = card.dataset.diag || '';
      if (!txt) { toast('没有可复制的诊断信息'); return; }
      try {
        await navigator.clipboard.writeText(txt);
        toast('诊断信息已复制');
      } catch (e) {
        prompt('复制失败，请手动复制：', txt.slice(0, 2000));
      }
      return;
    }
    if (act === 'madd') {
      /* 手动加模型：名单更新不及时、官方出新模型时用户自己填。
         加进可选列表并选中；保存后进库，重绘也不丢（靠已选小片 + 服务端 models）。 */
      const inp = card.querySelector('[data-role="mCustom"]');
      const m = ((inp && inp.value) || '').trim();
      if (!m) { toast('先输入模型名'); if (inp) inp.focus(); return; }
      const cid = card.getAttribute('data-conn');
      let avail = Array.from(card.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
      if (avail.indexOf(m) < 0) avail.push(m);
      aiCtx.avail[cid] = avail;
      const sel = cardSel(card);
      if (sel.indexOf(m) < 0) sel.push(m);
      const box = card.querySelector('[data-role="availBox"]');
      if (box) box.innerHTML = modelButtonsHTML(avail, sel, testedOf(card));
      const chosen = card.querySelector('[data-role="chosenBox"]');
      if (chosen) chosen.innerHTML = chosenChipsHTML(avail, sel);
      const lbl = card.querySelector('[data-role="selCount"]');
      if (lbl) lbl.textContent = '已选模型（' + sel.length + '）';
            inp.value = '';
      toast('已加入：' + m + '（记得点「保存设置」）');
      return;
    }
    if (act === 'test') {
      /* 测这一条（不是第一条）：先存下去，把已选模型逐个打一遍最短请求，
         每个的结果都列出来 —— 免得第一个不通就停了，用户不知道第二个其实是通的。
         Agent 卡没选模型时不发请求：不带 -m 会命中 CLI 默认模型，
         而默认的免费款 403（只能在 OpenCode 内用），发了也是白白报错。 */
      const kind = card.getAttribute('data-kind') || 'api';
      const sel0 = cardSel(card);
      if (kind === 'agent' && !sel0.length) {
        const hint0 = card.querySelector('[data-role="msghint"]');
        if (hint0) hint0.innerHTML = '先选一个模型再测（当前实测 CLI 可通的是 <code>opencode/space-bunny-free</code>）。';
        toast('先选一个模型再测');
        return;
      }
      const hint = card.querySelector('[data-role="msghint"]');
      const oldT = btn.textContent;
      btn.disabled = true; btn.textContent = '测试中…';
      try {
        await api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
        const cid = card.getAttribute('data-conn');
        const models = cardSel(card);
        const queue = models.length ? models : [''];
        const rows = [];
        let okN = 0;
        for (let i = 0; i < queue.length; i++) {
          const m = queue[i];
          if (hint) hint.innerHTML = rows.join('<br>') + `<br>正在测 ${i + 1}/${queue.length}：${esc(m || '(默认模型)')}…`;
          try {
            const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
            if (r.ok) { okN++; rows.push(`✅ <b>${esc(m || '(默认模型)')}</b> · 回复：${esc(r.sample || '')}`); }
            else rows.push(`❌ <b>${esc(m || '(默认模型)')}</b>：${esc(r.message || '未知错误')}`);
          } catch (err) {
            rows.push(`❌ <b>${esc(m || '(默认模型)')}</b>：${esc(err.message)}`);
          }
        }
        if (hint) hint.innerHTML = rows.join('<br>');
        toast(okN === queue.length ? '全部 ' + queue.length + ' 个模型都通' : '通 ' + okN + '/' + queue.length + ' 个，见卡片内明细');
      } catch (err) {
        if (hint) hint.textContent = '❌ 测试失败：' + err.message;
      } finally { btn.disabled = false; btn.textContent = oldT; }
      return;
    }
    /* 卡片折叠：只做显隐 + 记住状态，不重绘（重绘会丢输入框里没保存的内容） */
    if (act === 'fold') {
      const body = card.querySelector('[data-role="body"]');
      const cid = card.getAttribute('data-conn');
      if (body) body.hidden = !body.hidden;
      btn.textContent = (body && body.hidden) ? '▸' : '▾';
      try {
        const k = 'sierxing-conn-fold';
        const m = JSON.parse(localStorage.getItem(k) || '{}');
        if (body && body.hidden) m[cid] = 1; else delete m[cid];
        localStorage.setItem(k, JSON.stringify(m));
      } catch (e) {}
      return;
    }
    if (act === 'del') {
      const n = (card.querySelector('[data-role="title"]') || {}).textContent || '这条连接';
      if (!confirm('删除「' + n + '」？对话栏里选它的模型也会一并失效。')) return;
      card.remove();
      if (!app.querySelector('.connCard')) document.getElementById('connEmpty').hidden = false;

      return;
    }
    /* 只保存这一条：整表提交（服务端本来就是整体覆盖），但只清这张卡的未保存标记 */
    if (act === 'saveone') {
      const oldT = btn.textContent;
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const r = await save();
        const cid = card.getAttribute('data-conn');
        const saved = ((r && r.connections) || []).find(x => x.id === cid);
        const key = card.querySelector('[data-f="apiKey"]');
        if (key) { key.value = ''; key.placeholder = (saved && saved.hasKey) ? '已保存（留空则不修改）' : 'sk-…'; }
        clearDirty(card);
        toast('已保存这条连接');
      } catch (e) { toast('保存失败：' + e.message); }
      finally { btn.disabled = false; btn.textContent = oldT; }
      return;
    }
    if (act === 'models') {
      /* 跑批量测试时这个按钮就是「停止」 */
      const cidM = card.getAttribute('data-conn');
      if (window.__aiTesting && window.__aiTesting[cidM]) { window.__aiTesting[cidM].stop = true; return; }
      const pid = card.getAttribute('data-prov');
      if (pid === 'opencode') {
        const probe = card.querySelector('[data-role="ocprobe"]');
        if (probe) probe.innerHTML = '<span class="muted">正在检测本机 opencode…</span>';
        btn.disabled = true; btn.textContent = '检测中…';
        try {
          const st = await api('/api/ai/opencode-status');
          aiCtx.ocState = st;
          if (probe) probe.innerHTML = st.installed
            ? `<span class="ok">✓ 已检测到 opencode${esc(st.version ? ' ' + st.version : '')}</span>`
            : `<span class="bad">✗ ${esc(st.hint || '未检测到 opencode')}</span>`;
          if (st.installed) await fetchModelsInto(card, 'opencode');
          else toast(st.hint || '未检测到 opencode');
        } catch (err) {
          if (probe) probe.innerHTML = '<span class="bad">检测失败：' + esc(err.message) + '</span>';
        } finally { btn.disabled = false; if (!window.__aiTesting || !window.__aiTesting[card.getAttribute('data-conn')]) btn.textContent = '🔄 检测并测试'; }
        return;
      }
      await fetchModelsInto(card, pid);
      return;
    }
  };
  app.addEventListener('click', window.__aiSetClickH);
  /* 手动输入框回车即添加（同上面的叠加监听问题，先解绑再绑定） */
  if (window.__aiSetKeyH) app.removeEventListener('keydown', window.__aiSetKeyH);
  window.__aiSetKeyH = e => {
    if (e.key !== 'Enter') return;
    const inp = e.target && e.target.closest ? e.target.closest('[data-role="mCustom"]') : null;
    if (!inp) return;
    e.preventDefault();
    const card = inp.closest('.connCard');
    const btn = card && card.querySelector('[data-act="madd"]');
    if (btn) btn.click();
  };
  app.addEventListener('keydown', window.__aiSetKeyH);
  /* 卡片里一改就标未保存（跟上面的叠加监听同理，先解绑再绑定） */
  if (window.__aiSetDirtyH) app.removeEventListener('input', window.__aiSetDirtyH);
  window.__aiSetDirtyH = e => {
    const card = e.target && e.target.closest ? e.target.closest('.connCard') : null;
    if (!card || !document.getElementById('connList') || !document.getElementById('connList').contains(card)) return;
    markDirty(card);
  };
  app.addEventListener('input', window.__aiSetDirtyH);
  /* 独立识图配置：地址/密钥/模型名 + 取列表 + 单独测试。存到 vis_* 设置，
     与对话连接完全分开（有的服务商没有视觉模型，绑在一起讲不清楚）。 */
  const visMsg = document.getElementById('visMsg');
  const visSay = t => { if (visMsg) visMsg.innerHTML = t; };
  /* 识图模型按钮：点一下填入输入框（和连接卡的模型按钮同一套样式） */
  const renderVisOpts = list => {
    const box = document.getElementById('visOpts');
    if (!box) return;
    const cur = ((document.getElementById('visModel') || {}).value || '').trim();
    box.innerHTML = (list || []).map(m => `<button type="button" class="mBtn${m === cur ? ' on' : ''}" data-visopt="${esc(m)}">${esc(m)}</button>`).join('')
      || '<div class="hint">没有可选模型。</div>';
  };
  const visVals = () => ({
    base: (document.getElementById('visBase') || {}).value || '',
    key: (document.getElementById('visKey') || {}).value || '',
    model: ((document.getElementById('visModel') || {}).value || '').trim()
  });
  const visPeek = document.getElementById('visPeek');
  if (visPeek) visPeek.addEventListener('click', () => {
    const inp = document.getElementById('visKey');
    if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; visPeek.textContent = inp.type === 'password' ? '👁' : '🙈'; }
  });
  const visSaveBtn = document.getElementById('visSave');
  if (visSaveBtn) visSaveBtn.addEventListener('click', async () => {
    const v = visVals();
    if (!v.base.trim() || !v.model) { toast('先填地址和模型名'); return; }
    try {
      const body = { vis_base_url: v.base.trim(), vision_model: v.model };
      if (v.key.trim()) body.vis_api_key = v.key.trim();
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const k = document.getElementById('visKey');
      if (k) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
      state.aiStatus = await api('/api/ai/status').catch(() => null);
      visSay('已保存。当前识图用：<b>' + esc((state.aiStatus && state.aiStatus.visionModel) || v.model) + '</b>');
      toast('识图配置已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  });
  const visFetch = document.getElementById('visFetch');
  if (visFetch) visFetch.addEventListener('click', async () => {
    const v = visVals();
    if (!v.base.trim()) { toast('先填 API 地址'); return; }
    visFetch.disabled = true; visFetch.textContent = '获取中…';
    visSay('正在向该地址请求模型列表…');
    try {
      /* 密钥框空着也行：已存过的用存过的（useVisKey），新填的直接用 */
      const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base.trim(), apiKey: v.key.trim(), useVisKey: !v.key.trim() }) });
      const list = r.models || [];
      if (!list.length) {
        visSay('<span style="color:var(--warn)">没取到：' + esc(r.error || '接口未返回') + '</span>');
      } else {
        renderVisOpts(list);
        visSay((r.error ? '<span style="color:var(--warn)">' + esc(r.error) + '</span><br>' : '') + '取到 <b>' + list.length + '</b> 个，点一下填入上面，选完点「保存识图配置」。');
        toast('取到 ' + list.length + ' 个模型');
      }
    } catch (e) { visSay('<span style="color:var(--warn)">取列表失败：' + esc(e.message) + '</span>'); }
    finally { visFetch.disabled = false; visFetch.textContent = '🔄 获取可用模型'; }
  });
  const visTest = document.getElementById('visTest');
  if (visTest) visTest.addEventListener('click', async () => {
    const v = visVals();
    /* 没保存也能测：先存（只存填了的项），再按模型名打 */
    try {
      const body = {};
      if (v.base.trim()) body.vis_base_url = v.base.trim();
      if (v.key.trim()) body.vis_api_key = v.key.trim();
      if (v.model) body.vision_model = v.model;
      if (Object.keys(body).length) await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!v.model) { toast('先填模型名'); return; }
      visSay('正在用识图配置请求一次…');
      const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: v.model }) });
      visSay(r.ok ? `✅ <b>连通正常</b> · ${esc(r.model)}<br>回复：${esc(r.sample || '')}` : `❌ <b>连不通</b>：${esc(r.message || '')}`);
    } catch (e) { visSay('❌ 测试失败：' + esc(e.message)); }
  });
  /* 进设置页时如果识图地址已存，静默取一次模型列表供点选（失败不打扰） */
  (async () => {
    try {
      const vb = ((document.getElementById('visBase') || {}).value || '').trim();
      if (!vb) return;
      const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: vb, useVisKey: true }) });
      if (r.models && r.models.length) renderVisOpts(r.models);
    } catch (e) {}
  })();
  document.getElementById('saveSettings').addEventListener('click', async () => {    /* 保存全部：原地刷新，不整页重绘（重绘会丢滚动位置；各卡输入都在 DOM 里没丢） */
    try {
      const r = await save();
      const byId = {};
      for (const c of ((r && r.connections) || [])) byId[c.id] = c;
      app.querySelectorAll('.connCard').forEach(card => {
        const key = card.querySelector('[data-f="apiKey"]');
        const sv = byId[card.getAttribute('data-conn')];
        if (key) { key.value = ''; key.placeholder = (sv && sv.hasKey) ? '已保存（留空则不修改）' : 'sk-…'; }
      });
      toast('已保存全部连接');
    } catch (e) { toast(e.message); }
  });
  document.getElementById('testAi').addEventListener('click', async e => {
    const btn = e.target;
    const box = document.getElementById('aiStatusBox');
    btn.disabled = true; btn.textContent = '测试中…';
    box.innerHTML = '正在保存配置并测试第一条启用的连接…';
    try {
      await save();  // 先保存再测试，避免"改了没存"导致误报
      const r = await api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) {
        box.innerHTML = `✅ <b>连接正常</b> · ${esc(r.connName ? r.connName + ' · ' : '')}${esc(r.provider === 'openai' ? 'OpenAI 兼容接口' : 'opencode CLI')} · 模型 ${esc(r.model)}<br>模型回复：${esc(r.sample || '')}`;
        toast('连接正常');
      } else {
        box.innerHTML = `❌ <b>连接失败</b>：${esc(r.message || '未知错误')}<br><span class="hint">检查：API 地址是否正确 · 密钥是否正确 · 模型名是否存在 · 网络/代理是否可用</span>`;
        toast('连接失败，见下方说明');
      }
    } catch (err) {
      box.innerHTML = '❌ 连接失败：' + esc(err.message);
    } finally { btn.disabled = false; btn.textContent = '测试第一条连接'; }
  });
  bindServiceSection();
  bindUpdateSection();
  bindSyncSection();

  /* 顶栏页签：一次只显示一块，整页切换，不再全挤在一起。
     切页签只做 hidden 显隐 —— 输入框里的未保存内容不会丢，各区块的监听也都在，
     比销毁重建稳。保存重绘后停在刚才看的那块。 */
  const tabsBox = document.getElementById('setTabs');
  const tabIds = state._setTabs || [];
  /* 组件页的「去设置里选」带着 /theme 进来，直接停在外观主题页签 */
  if (/^#\/settings\/theme/.test(location.hash || '')) state.settingsTab = 'set-theme';
  const markTab = id => tabsBox && tabsBox.querySelectorAll('.setTab').forEach(b =>
    b.classList.toggle('on', b.getAttribute('data-tab') === id));
  const applyTab = () => {
    const cur = (state.settingsTab && document.getElementById(state.settingsTab)) ? state.settingsTab : 'set-ai';
    state.settingsTab = cur;
    markTab(cur);
    tabIds.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = (id !== cur); });
    /* 「数据存储路径」要扫盘统计大小，切到它的时候才去读，别拖慢设置页打开 */
    if (cur === 'set-store' && !_storeState) storeSectionLoad();
  };
  if (tabsBox) {
    if (window.__setSpy) { try { window.__setSpy.disconnect(); } catch (e) {} window.__setSpy = null; }
    tabsBox.addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      state.settingsTab = b.getAttribute('data-tab');
      applyTab();
      window.scrollTo(0, 0);
    });
    applyTab();
    window.scrollTo(0, 0);
  }
  /* 外观主题：亮 / 暗各选一个皮肤（只存本机） */
  const bindThemeSel = (id, mode, label) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      setThemeFor(mode, el.value);
      const now = currentThemeEff() === mode;
      toast(now ? ('已应用' + label + '主题') : ('已设置' + label + '主题（切到' + (mode === 'dark' ? '暗色' : '亮色') + '模式时生效）'));
      const msg = document.getElementById('themeMsg');
      if (msg) msg.innerHTML = themeMsgText();
    });
  };
  bindThemeSel('themeLight', 'light', '亮色');
  bindThemeSel('themeDark', 'dark', '暗色');
  /* 检索增强（RAG）：开关 / 向量模型 / 索引状态 / 检索预览 */
  const ragEl = id => document.getElementById(id);
  const ragSay = (id, t) => { const el = ragEl(id); if (el) el.innerHTML = t; };
  const refreshRagStatus = async () => {
    if (!ragEl('ragStatus')) return;
    const gid = Number((ragEl('ragGoalSel') || {}).value || 0);
    try {
      const st = await api('/api/rag/status' + (gid ? '?goalId=' + gid : ''));
      const emb = st.embConfigured ? '向量模型 <b>' + esc(st.embModel) + '</b>' : '未配置向量模型（当前按关键词检索）';
      ragSay('ragStatus', '资料 <b>' + st.sources + '</b> 条 · 分块 <b>' + st.chunks + '</b> · 已向量化 <b>' + st.embedded + '</b>'
        + (st.pending ? ' · 待处理 <b style="color:var(--warn)">' + st.pending + '</b>' : '')
        + '　·　' + emb + (st.building ? '　·　<span style="color:var(--warn)">正在建立索引…</span>' : ''));
    } catch (e) { ragSay('ragStatus', '状态读取失败：' + esc(e.message)); }
  };
  const ragToggle = ragEl('ragEnabled');
  if (ragToggle) ragToggle.addEventListener('change', async () => {
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rag_enabled: ragToggle.checked }) });
      toast(ragToggle.checked ? '已开启检索增强' : '已关闭检索增强');
    } catch (e) { toast('保存失败：' + e.message); }
  });
  const embVals = () => ({
    base: ((ragEl('embBase') || {}).value || '').trim(),
    key: ((ragEl('embKey') || {}).value || '').trim(),
    model: ((ragEl('embModel') || {}).value || '').trim()
  });
  const embSaveBtn = ragEl('embSave');
  if (embSaveBtn) embSaveBtn.addEventListener('click', async () => {
    const v = embVals();
    if (!v.base || !v.model) { toast('先填地址和向量模型名'); return; }
    try {
      const body = { emb_base_url: v.base, emb_model: v.model };
      if (v.key) body.emb_api_key = v.key;
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const k = ragEl('embKey'); if (k) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
      ragSay('embMsg', '已保存。点「测试向量」验证是否可用。');
      toast('向量配置已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  });
  const embFetchBtn = ragEl('embFetch');
  if (embFetchBtn) embFetchBtn.addEventListener('click', async () => {
    const v = embVals();
    if (!v.base) { toast('先填 API 地址'); return; }
    embFetchBtn.disabled = true; embFetchBtn.textContent = '获取中…';
    ragSay('embMsg', '正在向该地址请求模型列表…');
    try {
      const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base, apiKey: v.key, useEmbKey: !v.key }) });
      const box = ragEl('embOpts');
      const list = r.models || [];
      if (box) box.innerHTML = (list.map(m => `<button type="button" class="mBtn" data-embopt="${esc(m)}">${esc(m)}</button>`).join('')) || '<div class="hint">没有可选模型。</div>';
      ragSay('embMsg', list.length ? ('取到 <b>' + list.length + '</b> 个，点一下填入模型名。' + (r.error ? '（' + esc(r.error) + '）' : '')) : ('<span style="color:var(--warn)">没取到：' + esc(r.error || '接口未返回') + '</span>'));
    } catch (e) { ragSay('embMsg', '<span style="color:var(--warn)">取列表失败：' + esc(e.message) + '</span>'); }
    finally { embFetchBtn.disabled = false; embFetchBtn.textContent = '🔄 获取可用模型'; }
  });
  const embOptsBox = ragEl('embOpts');
  if (embOptsBox) embOptsBox.addEventListener('click', e => {
    const b = e.target.closest('[data-embopt]');
    if (!b) return;
    const inp = ragEl('embModel');
    if (inp) inp.value = b.getAttribute('data-embopt');
    embOptsBox.querySelectorAll('[data-embopt]').forEach(x => x.classList.toggle('on', x === b));
  });
  /* 一键接入本机 Ollama：填好地址 + 列出本机模型（标出能做向量化的） */
  const embOllamaBtn = ragEl('embOllama');
  if (embOllamaBtn) embOllamaBtn.addEventListener('click', async () => {
    const base = ragEl('embBase');
    const BASE = 'http://localhost:11434/v1';
    if (base) base.value = BASE;
    ragSay('embMsg', '正在探测本机 Ollama…');
    try {
      const r = await api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: BASE, apiKey: '', useEmbKey: false }) });
      const list = r.models || [];
      const box = ragEl('embOpts');
      /* 常见向量模型名特征：bge / m3 / nomic / mxbai / gte / e5 / jina / embed */
      const isEmb = m => /(^|[-_/])(bge|m3|embed|embedding|nomic|mxbai|gte|e5|jina)/i.test(String(m).replace(/:.*$/, ''));
      if (box) {
        box.innerHTML = list.map(m => `<button type="button" class="mBtn" data-embopt="${esc(m)}">${esc(m)}${isEmb(m) ? ' <span style="color:var(--ok);font-size:11px;">· 向量</span>' : ''}</button>`).join('')
          || '<div class="hint">Ollama 里还没有模型。先在终端跑一次 <code>ollama pull bge-m3</code>（中文效果好、约 1.2GB）。</div>';
      }
      if (list.length) {
        ragSay('embMsg', `已连上本机 Ollama，共 <b>${list.length}</b> 个模型。带「· 向量」的能做向量化，点一下填入模型名，再点「测试向量」确认。`);
      } else {
        ragSay('embMsg', '<span style="color:var(--warn)">Ollama 在跑，但还没装模型。终端执行 <code>ollama pull bge-m3</code> 即可。</span>');
      }
    } catch (e) {
      ragSay('embMsg', '<span style="color:var(--warn)">连不上本机 Ollama。确认它已启动（终端执行 <code>ollama serve</code>），或地址填了别的端口。</span>');
    }
  });

  const embTestBtn = ragEl('embTest');
  if (embTestBtn) embTestBtn.addEventListener('click', async () => {
    const v = embVals();
    if (!v.base || !v.model) { toast('先填地址和向量模型名'); return; }
    ragSay('embMsg', '正在真实调用向量接口…');
    try {
      const r = await api('/api/ai/emb-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base, model: v.model, apiKey: v.key }) });
      if (r.ok) {
        const k = ragEl('embKey'); if (k && v.key) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
        ragSay('embMsg', '✅ <b>向量接口正常</b> · ' + esc(r.model) + ' · 维度 ' + r.dim + '。点「建立本目标索引」开始向量化。');
      } else ragSay('embMsg', '❌ <b>不可用</b>：' + esc(r.message || ''));
    } catch (e) { ragSay('embMsg', '❌ 测试失败：' + esc(e.message)); }
  });
  const ragBuildBtn = ragEl('ragBuildBtn');
  if (ragBuildBtn) ragBuildBtn.addEventListener('click', async () => {
    const gid = Number((ragEl('ragGoalSel') || {}).value || 0);
    if (!gid) { toast('先选一个目标'); return; }
    try {
      const r = await api('/api/goals/' + gid + '/rag/build', { method: 'POST' });
      toast(r.already ? '索引任务已在运行' : '已开始建立索引（左下角任务中心可看进度）');
      refreshRagStatus();
    } catch (e) { toast('启动失败：' + e.message); }
  });
  const ragRefreshBtn = ragEl('ragRefresh');
  if (ragRefreshBtn) ragRefreshBtn.addEventListener('click', refreshRagStatus);
  const ragSearchBtn = ragEl('ragSearchBtn');
  if (ragSearchBtn) ragSearchBtn.addEventListener('click', async () => {
    const gid = Number((ragEl('ragGoalSel') || {}).value || 0);
    const q = ((ragEl('ragQ') || {}).value || '').trim();
    if (!gid || !q) { toast('先选目标、输入检索词'); return; }
    ragSay('ragHits', '检索中…');
    try {
      const r = await api('/api/goals/' + gid + '/rag/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
      const hits = r.hits || [];
      ragSay('ragHits', hits.length
        ? hits.map(h => `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;"><div style="font-size:12px;color:var(--muted);">${Number(h.quality) === 1 ? '★' : ''}[${esc(h.site)}｜${esc(h.kind)}] ${esc(h.title)} · 相关度 ${h.score}</div><div style="font-size:12.5px;margin-top:4px;">${esc(h.text)}</div></div>`).join('')
        : '<div class="hint">没有命中（可能资料还没入库，或换种说法再试）。</div>');
    } catch (e) { ragSay('ragHits', '<div class="hint">检索失败：' + esc(e.message) + '</div>'); }
  });
  if (ragEl('ragStatus')) refreshRagStatus();
  const sgb = document.getElementById('showGuideBtn');
  if (sgb) sgb.addEventListener('click', () => showGuide(0));
  document.getElementById('backupNow').addEventListener('click', async () => {
    try { const r = await api('/api/backup', { method: 'POST' }); toast('已备份，共 ' + r.count + ' 份'); await loadBackupList(); } catch (e) { toast(e.message); }
  });

  /* ---- 最近备份：列表 + 保留份数 + 恢复/删除 ---- */
  function fmtBytes(b) {
    b = Number(b || 0);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtBkTime(name) {
    const m = String(name || '').match(/sierxing-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db/);
    if (!m) return name;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  let bkSel = new Set();                      // 勾选中的备份名
  function syncDelSel() {
    const b = document.getElementById('bkDelSel');
    if (!b) return;
    const n = bkSel.size;
    b.disabled = n === 0;
    b.textContent = n ? `删除选中（${n}）` : '删除选中';
  }
  async function loadBackupList() {
    const box = document.getElementById('backupList');
    if (!box) return;
    let r;
    try { r = await api('/api/backup/list'); } catch (e) { box.innerHTML = '<p class="muted" style="padding:6px 0;">读取失败：' + esc(e.message) + '</p>'; return; }
    const sel = document.getElementById('backupKeep');
    if (sel && !sel.dataset.touched) {
      sel.innerHTML = [...new Set([5, 10, 20, 30, 50, 100, r.keep])].sort((a, b) => a - b)
        .map(n => `<option value="${n}"${n === r.keep ? ' selected' : ''}>${n} 份</option>`).join('');
    }
    const stat = document.getElementById('backupStat');
    if (stat) stat.textContent = `共 ${r.items.length} 份 · 占用 ${fmtBytes(r.totalBytes)}`;
    const foot = document.getElementById('backupFoot');
    if (foot) foot.textContent = `当前数据库 ${fmtBytes(r.dbSize)} · 恢复会先把现在的数据另存一份再覆盖，确认后需重启应用`;
    if (!r.items.length) { box.innerHTML = '<div class="bkEmpty">还没有备份。改点东西就会自动备份，或点上面「立即备份」。</div>'; return; }
    const vis = r.items.slice(0, 40);
    const allOn = vis.length > 0 && vis.every(it => bkSel.has(it.name));
    box.innerHTML = '<div class="bkList">' +
      `<div class="bkRow bkRowHead">
        <span class="bkCk"><input type="checkbox" id="bkAll"${allOn ? ' checked' : ''}></span>
        <span>备份时间</span><span style="text-align:right;">大小</span><span></span><span style="text-align:right;">操作</span>
      </div>` +
      vis.map((it, i) => `<div class="bkRow${bkSel.has(it.name) ? ' hasSel' : ''}" data-bk-row="${esc(it.name)}">
        <span class="bkCk"><input type="checkbox" data-bk-ck="${esc(it.name)}"${bkSel.has(it.name) ? ' checked' : ''}></span>
        <span class="bkTime">${esc(fmtBkTime(it.name))}</span>
        <span class="bkSize">${esc(fmtBytes(it.size))}</span>
        <span>${i === 0 ? '<span class="bkBadge">最新</span>' : ''}</span>
        <span class="bkActs">
          <button class="btn tiny" data-bk-diff="${esc(it.name)}">变化</button>
          <button class="btn tiny" data-bk-restore="${esc(it.name)}">恢复</button>
          <button class="btn tiny danger" data-bk-del="${esc(it.name)}">删除</button>
        </span>
      </div>`).join('') +
      (r.items.length > 40 ? `<div class="bkEmpty" style="padding:10px;border-top:1px solid var(--border);">只显示最近 40 份，共 ${r.items.length} 份</div>` : '') +
      '</div>';

    /* 勾选联动 */
    box.querySelectorAll('[data-bk-ck]').forEach(c => c.addEventListener('change', () => {
      const nm = c.getAttribute('data-bk-ck');
      if (c.checked) bkSel.add(nm); else bkSel.delete(nm);
      const rw = c.closest('.bkRow'); if (rw) rw.classList.toggle('hasSel', c.checked);
      const all = document.getElementById('bkAll');
      if (all) {
        const vis2 = vis.map(x => x.name);
        all.checked = vis2.length > 0 && vis2.every(nm2 => bkSel.has(nm2));
      }
      syncDelSel();
    }));
    const allBox = document.getElementById('bkAll');
    if (allBox) allBox.addEventListener('change', () => {
      vis.forEach(it => { if (allBox.checked) bkSel.add(it.name); else bkSel.delete(it.name); });
      loadBackupList();
    });

    /* 变化预览：面板就插在被点的那一行下面，不用翻到列表最底 */
    const closeDiff = () => { const old = box.querySelector('.bkDiffRow'); if (old) old.remove(); };
    box.querySelectorAll('[data-bk-diff]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-bk-diff');
      const row = box.querySelector('[data-bk-row="' + name + '"]');
      if (!row) return;
      closeDiff();                                  // 同一时间只展开一个
      const panel = document.createElement('div');
      panel.className = 'bkDiffRow';
      panel.innerHTML = '<div class="bkSamples">正在对比…</div>';
      row.insertAdjacentElement('afterend', panel);
      panel.scrollIntoView({ block: 'nearest' });
      const head = (title, cls) => `<div class="bkDiffTop"><b class="${cls || ''}">${esc(title)}</b><span class="spacer"></span><button class="btn tiny" data-bk-x>收起</button></div>`;
      try {
        const d = await api('/api/backup/diff?name=' + encodeURIComponent(name));
        if (d.first) {
          panel.innerHTML = head('这是最早的一份备份') + '<div class="bkSamples">没有可对比的上一版。</div>';
        } else {
          const rows = (d.items || []).map(it => `<div class="bkDiffItem">
              <b>${esc(it.label)}</b>
              ${it.added ? `<span class="bkNum add">+${it.added}</span>` : ''}
              ${it.removed ? `<span class="bkNum del">−${it.removed}</span>` : ''}
              ${it.changed ? `<span class="bkNum mod">~${it.changed} 处改动</span>` : ''}
              <span class="bkSamples">${esc((it.samples || []).map(x => (x.type === 'add' ? '＋' : x.type === 'del' ? '－' : '·') + x.text).join('　'))}</span>
            </div>`).join('');
          panel.innerHTML = head(`相比上一份（${fmtBkTime(d.prev)}）的变化`) +
            (rows || '<div class="bkSamples">两次备份内容一致，没有变化。</div>');
        }
      } catch (e) {
        panel.innerHTML = head('对比失败') + `<div class="bkSamples">${esc(e.message)}</div>`;
      }
      const x = panel.querySelector('[data-bk-x]');
      if (x) x.addEventListener('click', closeDiff);
    }));
    box.querySelectorAll('[data-bk-restore]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-bk-restore');
      if (!confirm(`确定用 ${fmtBkTime(name)} 这份备份覆盖当前数据吗？\n\n当前数据会先自动另存为一份备份，仍可恢复。\n恢复后需要重启应用。`)) return;
      try {
        await api('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        toast('已恢复，请重启应用');
        setTimeout(() => location.reload(), 1200);
      } catch (e) { toast('恢复失败：' + e.message); }
    }));
    box.querySelectorAll('[data-bk-del]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-bk-del');
      if (!confirm(`删除备份 ${fmtBkTime(name)}？此操作不可撤销。`)) return;
      try { await api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); bkSel.delete(name); await loadBackupList(); toast('已删除'); }
      catch (e) { toast('删除失败：' + e.message); }
    }));
    /* 列表每次重绘都要把「删除选中」的计数/禁用态刷一遍，
       否则全选后重新渲染，按钮还停在「删除选中」像是没选中。 */
    syncDelSel();
  }
  const bkDelSel = document.getElementById('bkDelSel');
  if (bkDelSel) bkDelSel.addEventListener('click', async () => {
    const names = Array.from(bkSel);
    if (!names.length) return;
    if (!confirm(`删除选中的 ${names.length} 份备份？\n\n${names.slice(0,5).map(fmtBkTime).join('、')}${names.length > 5 ? ' 等' : ''}\n此操作不可撤销。`)) return;
    let ok = 0, fail = 0;
    for (const nm of names) {
      try { await api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) }); ok++; }
      catch (e) { fail++; }
    }
    bkSel.clear();
    await loadBackupList();
    toast(fail ? `已删除 ${ok} 份，${fail} 份失败` : `已删除 ${ok} 份`);
  });
  syncDelSel();
  const bkKeep = document.getElementById('backupKeep');
  if (bkKeep) {
    bkKeep.addEventListener('change', async () => {
      bkKeep.dataset.touched = '1';
      try {
        const r = await api('/api/backup/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: Number(bkKeep.value) }) });
        toast(`改为保留最近 ${r.keep} 份，现有 ${r.count} 份`);
        bkKeep.dataset.touched = '';
        await loadBackupList();
      } catch (e) { toast(e.message); }
    });
  }
  loadBackupList();
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
const PLUGIN_BTNS_VISIBLE = 4;
function pluginEntriesVisible(goal) {
  if (!window.SiErXing) return { visible: [], overflow: [] };
  const all = SiErXing.goalEntries(goal)
    .filter(e => e.header !== false)
    .filter(e => goalCompOn(goal, e.id));
  // 顶栏已改成收藏栏，全部入口都渲染出来，溢出由栏内 ⋯ 收纳
  return { visible: all, overflow: [] };
}
/* 目标页组件入口按钮：全部交给收藏栏排布（溢出由栏内 ⋯ 收纳，不再单独发一个 ⋯ 按钮） */
function pluginButtonsHTML(goal) {
  const { visible } = pluginEntriesVisible(goal);
  return visible.map(e =>
    `<button class="btn small" data-tbtn id="goalComp_${esc(e.id)}" data-plugin-go="${esc(e.hash(goal.id))}" title="${esc(e.label)}">${e.icon} ${esc(e.label)}</button>`).join('');
}
/* 目标页：按目标开关组件（只改本目标，其它目标不受影响） */
function goalPluginsHTML(g) {
  if (!window.SiErXing) return '';
  return `<button class="btn small" data-tbtn id="goalPluginsBtn" title="为本目标开关组件（只改本目标）">🧩 组件</button>`;
}
/* 「只改本目标」的组件清单。
   ⚠️ 必须**不看当前是否启用**：这里列的是"能开的组件"，不是"已经开着的组件"。
   以前第一段用的是 SiErXing.goalEntries(pg)，而那个函数已经按 goalEntry.show()
   （对多数组件就是 pluginEnabled）过滤过 —— 于是某个目标里**关掉的组件在这儿找不到**，
   既开不回来、也看不到，用户只能看到"没单独设置过的仍按全局默认走"这句提示发呆。
   真实反馈：AIPM 目标里找不到「每日刷题」，单独开/关都不行。
   所以改成：以服务端组件元数据为准，列出所有「可按目标开关」的组件。 */
function goalManageableEntries(pg) {
  const out = [];
  const seen = new Set();
  for (const c of (state.componentList || [])) {
    if (c.scope === 'core' || c.goalToggle === false) continue;   // 核心组件不可按目标开关
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name || c.id, icon: c.icon || '🧩' });
  }
  // 兜底：服务端元数据还没加载完时，至少把"当前已启用、有独立入口"的列出来
  for (const e of (SiErXing.goalEntries(pg) || [])) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, name: e.label || e.id, icon: e.icon || '🧩' });
  }
  const orderOf = id => {
    const c = (state.componentList || []).find(x => x.id === id);
    return c && c.order != null ? c.order : 100;
  };
  out.sort((a, b) => orderOf(a.id) - orderOf(b.id));
  const metaOf = id => ((SiErXing.serverPlugins() || []).find(p => p.id === id) || {});
  return out.map(e => ({ ...e, desc: metaOf(e.id).desc || '' }));
}
async function showGoalPluginsMenu(gid, anchor) {
  document.querySelectorAll('#goalPluginMenu').forEach(x => x.remove());
  let pg = { id: gid, plugins: '{}' };
  try { const r = await api('/api/goals/' + gid + '/plugins'); pg = { id: gid, plugins: JSON.stringify((r && r.config) || {}) }; }
  catch (e) { toast(e.message); return; }
  const list = goalManageableEntries(pg);
  const m = document.createElement('div');
  m.id = 'goalPluginMenu';
  m.className = 'ctxMenu';
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.style.width = '260px';
  m.innerHTML = `<div class="ctxTitle">本目标的组件（只改本目标）</div>` + list.map(p => {
    const on = SiErXing.pluginEnabled(pg, p.id);
    return `
    <label class="gpRow${on ? '' : ' off'}">
      <span class="rciIcon">${p.icon || '🧩'}</span>
      <span class="gpName">${esc(p.name || p.id)}${p.desc ? `<span class="gpDesc">${esc(p.desc)}</span>` : ''}</span>
      <span class="cmpSwitch"><input type="checkbox" data-gp="${esc(p.id)}" ${on ? 'checked' : ''}><span class="cmpSlider"></span></span>
    </label>`; }).join('');
  document.body.appendChild(m);
  m.querySelectorAll('[data-gp]').forEach(inp => inp.addEventListener('change', async () => {
    const pid = inp.getAttribute('data-gp');
    try {
      await api('/api/goals/' + gid + '/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: pid, enabled: inp.checked }) });
      toast(inp.checked ? '已为本目标启用' : '已为本目标关闭');
      await loadGoal(gid);
      renderGoal();
      renderRail();
      const fresh = document.getElementById('goalPluginsBtn');
      if (fresh) showGoalPluginsMenu(gid, fresh);
    } catch (e) { toast(e.message); inp.checked = !inp.checked; }
  }));
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
/* ============ AI 任务页（左栏入口） ============
   ⚠️ 这一页必须扛得住「10 个目标 × 每个 100 条任务」（把 1000 条平铺出来是没法用的）：
     · 正在执行 → 至多几条（队列并发上限 3），用紧凑卡片铺成自适应网格，
                  一眼看完进度 / 阶段 / 用时 —— 这才是你此刻要看的
     · 历史记录 → 上千条。**默认按目标折叠成一行汇总**（每个目标一行：成败计数 +
                  最近一次时间）；点开才拉那一组头 20 条，要更多点「再看 20 条」。
                  一次只渲染几十个 DOM 节点，1000 条和 10 条打开速度一样。
     · 目标 / 状态 / 时间 / 标题搜索四个筛选**全部走服务端** —— 前端过滤等于
                  迟早要把上千条全塞进浏览器。
   另外：只有「正在执行」那块每 3 秒重绘；历史那块只在用户操作时重绘 ——
   否则你展开的那一组每 3 秒就被折叠回去一次。 */
const AITASK_ST = {
  queued: { text: '排队中', cls: 'queued' },
  running: { text: '进行中', cls: 'running' },
  done: { text: '✓ 完成', cls: 'done' },
  failed: { text: '✗ 失败', cls: 'failed' },
  cancelled: { text: '已停止', cls: 'cancelled' }
};
const AIT_PAGE = 20;                 // 一组一次拉多少条
let aiTasksTimer = null;
function aiTasksStopPoll() { if (aiTasksTimer) { clearInterval(aiTasksTimer); aiTasksTimer = null; } }
function aitTypeMeta(type) { return TASK_META[type] || { icon: '🤖', label: String(type || '任务') }; }
/* 给人话，不给裸毫秒和 ISO 串 */
function aitDur(ms) {
  const t = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (t < 60) return t + ' 秒';
  const m = Math.floor(t / 60);
  return m + ' 分' + (t % 60 ? ' ' + (t % 60) + ' 秒' : '');
}
function aitWhen(v) {
  const t = Date.parse(String(v || '').replace(' ', 'T'));
  if (!t) return '';
  const d = new Date(t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (new Date().toDateString() === d.toDateString()) return '今天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}
/* 本页的全部可变状态：筛选条件、哪些目标展开了、每组已加载的记录 */
function aitS() {
  if (!state.ait) state.ait = {
    /* preset: '' | today | 7 | 30 | custom；fromDate/toDate 是本地日历上的起止日
       （给 <input type=date> 用），from/to 是按本地日边界换算好的 UTC 时刻（给服务端用）。 */
    filter: { goal: 0, status: '', q: '', preset: '', from: '', to: '', fromDate: '', toDate: '' },
    open: {}, rows: {}
  };
  return state.ait;
}
function aitQuery(extra) {
  const f = aitS().filter, p = [];
  if (f.goal) p.push('goal=' + f.goal);
  if (f.status) p.push('status=' + encodeURIComponent(f.status));
  if (f.from) p.push('from=' + encodeURIComponent(f.from));
  if (f.to) p.push('to=' + encodeURIComponent(f.to));
  if (f.q) p.push('q=' + encodeURIComponent(f.q));
  for (const k of Object.keys(extra || {})) p.push(k + '=' + encodeURIComponent(extra[k]));
  return p.length ? '?' + p.join('&') : '';
}
/* ============ 统一的下拉选择器（给 <select> 加 class="sxi-sel" 即可） ============
   原生 <select> 展开后是**操作系统的系统菜单**，跟 App 观感完全不搭；而且各页面
   各写各的样式（.libGoalSel / class="btn" / 内联 style）—— 用户要求"统一一下"。
   做法：**原生 select 保留为真值源**，只是视觉上藏起来（.sxiSelNative）。
   点选项时把值写回它并派发 change —— 于是原先读 `el.value`、监听 `change` 的代码
   **一行都不用改**，迁移只是给它加个 class + 调一次 sxiSelify()。
   规格：sxi-sel 普通；sxi-sel-sm 小号；sxi-sel-block 撑满一行。 */
function sxiSelText(sel) {
  const o = sel.options[sel.selectedIndex];
  return o ? String(o.textContent).trim() : '';
}
function sxiSelPaint(sel) {
  const btn = sel.nextElementSibling;
  if (!btn || !btn.classList || !btn.classList.contains('sxiSelBtn')) return;
  const lab = btn.querySelector('.sxiSelLabel');
  const txt = sxiSelText(sel) || sel.getAttribute('data-ph') || '请选择';
  if (lab) lab.textContent = txt;
  btn.title = sel.title || txt;
  btn.disabled = !!sel.disabled;
}
function sxiSelify(root) {
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  for (const sel of scope.querySelectorAll('select.sxi-sel:not([data-sxisel])')) {
    sel.setAttribute('data-sxisel', '1');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sxiSelBtn'
      + (sel.classList.contains('sxi-sel-sm') ? ' sm' : '')
      + (sel.classList.contains('sxi-sel-block') ? ' block' : '');
    btn.innerHTML = '<span class="sxiSelLabel"></span><i class="sxiSelCaret">▾</i>';
    sel.parentNode.insertBefore(btn, sel.nextSibling);
    sel.classList.add('sxiSelNative');
    sxiSelPaint(sel);
    /* 值被代码改动（不是用户点的）时，按钮文案也要跟上 */
    sel.addEventListener('change', () => sxiSelPaint(sel));
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const same = sxiPopEl && sxiPopEl.__for === sel;
      sxiPopClose();
      if (same) return;
      const d = document.createElement('div');
      d.className = 'sxiPop';
      d.__for = sel;
      d.innerHTML = [...sel.options].map((o, i) =>
        `<button class="sxiOpt ${i === sel.selectedIndex ? 'on' : ''}" data-sxi-sel-idx="${i}"${o.disabled ? ' disabled' : ''}>${esc(String(o.textContent).trim())}</button>`).join('');
      document.body.appendChild(d);
      const r = btn.getBoundingClientRect();
      d.style.minWidth = Math.max(150, r.width) + 'px';
      d.style.top = (r.bottom + 6) + 'px';
      d.style.left = Math.max(8, Math.min(r.left, window.innerWidth - d.offsetWidth - 8)) + 'px';
      sxiPopEl = d;
      d.addEventListener('click', e2 => {
        const b2 = e2.target.closest('[data-sxi-sel-idx]');
        if (!b2) return;
        sel.selectedIndex = Number(b2.getAttribute('data-sxi-sel-idx'));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sxiSelPaint(sel);
        sxiPopClose();
      });
    });
  }
}
window.sxiSelify = sxiSelify;   // 插件重画之后用得上
/* 点别处 / Esc / 滚动 关弹层：全 App 只绑一次，共用一个弹层 */
if (!window.__sxiPopBound) {
  window.__sxiPopBound = true;
  document.addEventListener('click', e => {
    if (!sxiPopEl) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.sxiPop') || t.closest('.sxiSelBtn') || t.closest('[data-ait-open]'))) return;
    sxiPopClose();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') sxiPopClose(); });
  window.addEventListener('scroll', () => sxiPopClose(), true);
}
/* ---- 筛选条：三个**自画**的下拉 + 时间区间 ----
   为什么不用原生 <select>：它展开后是操作系统的系统菜单，跟 App 风格完全不搭
   （用户原话"太丑陋了"），而且没法做"自定义起止日期"。
   时间粒度：保留 今天 / 最近 7 天 / 最近 30 天 三档快捷，另加**自定义起止日**
   —— 能精确到"10月1日到10月9日"这种某一段。 */
function aitGoalLabel() {
  const f = aitS().filter;
  if (!f.goal) return '全部目标';
  const g = ((state.aitData && state.aitData.goals) || []).find(x => Number(x.id) === Number(f.goal));
  return g ? g.title : '（目标已删除）';
}
function aitStatusLabel() {
  const v = aitS().filter.status;
  return v === 'done' ? '✓ 完成' : v === 'failed' ? '✗ 失败' : v === 'cancelled' ? '已停止' : '全部状态';
}
function aitShortDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (Number(m[2]) + '月' + Number(m[3]) + '日') : String(s || '');
}
function aitTimeLabel() {
  const f = aitS().filter;
  if (f.preset === 'today') return '今天';
  if (f.preset === '7') return '最近 7 天';
  if (f.preset === '30') return '最近 30 天';
  if (f.preset === 'custom' && f.fromDate && f.toDate) return aitShortDate(f.fromDate) + ' – ' + aitShortDate(f.toDate);
  return '全部时间';
}
function aitTimeOn() { return !!(aitS().filter.from || aitS().filter.to); }
/* 本地某一天的 0 点 → UTC ISO。数据是 nowISO()/toISOString() 存的 UTC，
   而"今天"必须按**本地**日历切（中国用户按 UTC 切会错 8 小时）。 */
function aitDayISO(base, addDays) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (addDays || 0), 0, 0, 0, 0);
  return d.toISOString();
}
function aitApplyPreset(preset) {
  const f = aitS().filter, today = new Date();
  f.preset = preset; f.fromDate = ''; f.toDate = '';
  if (preset === 'today') { f.from = aitDayISO(today, 0); f.to = aitDayISO(today, 1); }
  else if (preset === '7') { f.from = aitDayISO(today, -6); f.to = aitDayISO(today, 1); }
  else if (preset === '30') { f.from = aitDayISO(today, -29); f.to = aitDayISO(today, 1); }
  else { f.from = ''; f.to = ''; }
}
function aitApplyCustom() {
  const f = aitS().filter;
  const a = String((document.getElementById('aitFrom') || {}).value || '');
  const b = String((document.getElementById('aitTo') || {}).value || '');
  if (!a || !b) { toast('起止日期都要选上（也可以直接点上面的快捷档）'); return false; }
  if (a > b) { toast('开始日期不能晚于结束日期'); return false; }
  f.preset = 'custom'; f.fromDate = a; f.toDate = b;
  f.from = new Date(a + 'T00:00:00').toISOString();
  const e = new Date(b + 'T00:00:00'); e.setDate(e.getDate() + 1);
  f.to = e.toISOString();
  return true;
}
/* 筛选条里那三个按钮的文案（改动筛选后只更新文案，不重画整条 —— 重画会把
   搜索框里正在输入的内容和焦点一起弄丢） */
function aitPaintFilterBtns() {
  const bar = document.getElementById('aitFilters');
  if (!bar) return;
  const set = (kind, text, on) => {
    const b = bar.querySelector('[data-ait-open="' + kind + '"]');
    if (!b) return;
    b.querySelector('.aitFLabel').textContent = text;
    b.classList.toggle('on', !!on);
    if (text !== b.getAttribute('data-last')) { b.setAttribute('data-last', text); b.title = text; }
  };
  set('goal', aitGoalLabel(), !!aitS().filter.goal);
  set('status', aitStatusLabel(), !!aitS().filter.status);
  set('time', aitTimeLabel(), aitTimeOn());
}
let sxiPopEl = null;
function sxiPopClose() { if (sxiPopEl) { sxiPopEl.remove(); sxiPopEl = null; } }
function sxiPopShow(btn, kind) {
  const already = sxiPopEl && sxiPopEl.getAttribute('data-kind') === kind;
  sxiPopClose();
  if (already) return;
  const data = state.aitData || {}, f = aitS().filter;
  const d = document.createElement('div');
  d.className = 'sxiPop';
  d.setAttribute('data-kind', kind);
  const opt = (pick, label, on, title) =>
    `<button class="sxiOpt ${on ? 'on' : ''}" data-ait-pick="${pick}"${title ? ' title="' + esc(title) + '"' : ''}>${esc(label)}</button>`;
  if (kind === 'goal') {
    d.innerHTML = '<div class="sxiPopT">按目标筛选</div>'
      + opt('goal:0', '全部目标', !f.goal)
      + ((data.goals || []).map(g => opt('goal:' + g.id, g.title, Number(f.goal) === Number(g.id), g.title)).join(''));
  } else if (kind === 'status') {
    d.innerHTML = '<div class="sxiPopT">按状态筛选</div>'
      + opt('status:', '全部状态', !f.status)
      + opt('status:done', '✓ 完成', f.status === 'done')
      + opt('status:failed', '✗ 失败', f.status === 'failed')
      + opt('status:cancelled', '已停止', f.status === 'cancelled');
  } else {
    d.innerHTML = '<div class="sxiPopT">时间范围</div>'
      + `<button class="sxiOpt ${!aitTimeOn() ? 'on' : ''}" data-ait-time="all">全部时间</button>`
      + `<button class="sxiOpt ${f.preset === 'today' ? 'on' : ''}" data-ait-time="today">今天</button>`
      + `<button class="sxiOpt ${f.preset === '7' ? 'on' : ''}" data-ait-time="7">最近 7 天</button>`
      + `<button class="sxiOpt ${f.preset === '30' ? 'on' : ''}" data-ait-time="30">最近 30 天</button>`
      + '<div class="sxiPopSep"></div><div class="sxiPopT">自定义（精确到某几天）</div>'
      + `<div class="sxiRange">
           <input type="date" id="aitFrom" value="${esc(f.fromDate || '')}" aria-label="开始日期">
           <span class="sxiRangeSep">—</span>
           <input type="date" id="aitTo" value="${esc(f.toDate || '')}" aria-label="结束日期">
           <button class="btn small primary" id="sxiRangeGo">应用</button>
         </div>`;
  }
  document.body.appendChild(d);
  const r = btn.getBoundingClientRect();
  d.style.top = (r.bottom + 6) + 'px';
  d.style.left = Math.max(8, Math.min(r.left, window.innerWidth - d.offsetWidth - 8)) + 'px';
  sxiPopEl = d;
}
/* 改完筛选统一走的收尾：清掉展开状态（换筛选后旧的那一组就不作数了） */
async function aitAfterFilterChange() {
  const st = aitS();
  st.open = {}; st.rows = {};
  if (st.filter.goal) st.open[st.filter.goal] = true;
  /* 汇总与分组也吃同一套筛选，所以换筛选要重拉一次总览 —— 否则筛了"今天"，
     分组标题还写"共 30"（实测踩到过） */
  try { state.aitData = await api('/api/ai-tasks' + aitQuery()); } catch (e) {}
  aitPaintRun(state.aitData || {});
  aitPaintHist();
  aitPaintFilterBtns();
  if (st.filter.goal) { await aitLoadRows(st.filter.goal, false); aitPaintHist(); }
}
/* 「正在执行」的卡片。
   进度 / **所有阶段点** / 实时思考直接用任务中心那套 `taskProgressHTML` ——
   用户明确要求"能显示当前所处的阶段（所有阶段都能显示）"：那一套就是把每个阶段
   摆出来、已完成的打勾、当前那个转圈。之前这里只写"第 2/5 步 · 规划大纲"一行，
   信息比任务中心还少，属于白丢。两处长得一样也省得口径不一致。 */
function aitRunningCard(t) {
  const m = aitTypeMeta(t.type);
  const st = AITASK_ST[t.status] || AITASK_ST.running;
  const queued = t.status === 'queued';
  return `<div class="aitRun ${st.cls}">
    <div class="aitRunHd">
      <span class="aitRunIco">${m.icon}</span>
      <span class="aitRunTitle" title="${esc(t.title || m.label)}">${esc(t.title || m.label)}</span>
      <span class="aitSt ${st.cls}">${st.text}</span>
    </div>
    <div class="aitRunSub">${esc(t.goalTitle || '（无目标）')}${t.nodeId ? ' · 节点 #' + t.nodeId : ''}</div>
    ${queued ? '<div class="aitRunSub muted">排在队列里，等前面两个任务腾出并发位</div>' : taskProgressHTML(t)}
    <div class="aitRunFoot"><button class="btn tiny" data-ait-cancel="${t.id}">停止</button></div>
  </div>`;
}
function aitRunHTML(data) {
  const f = aitS().filter;
  let run = data.running || [];
  if (f.goal) run = run.filter(t => Number(t.goalId) === Number(f.goal));
  if (!run.length) return '';
  const running = run.filter(t => t.status === 'running').length;
  const queued = run.length - running;
  return `<div class="aitSec">
    <div class="aitSecT">正在执行<span class="aitSecN">${run.length}</span>
      <span class="aitSecSub">${running ? running + ' 个在跑' : ''}${running && queued ? ' · ' : ''}${queued ? queued + ' 个排队' : ''}</span></div>
    <div class="aitRunGrid">${run.map(aitRunningCard).join('')}</div>
  </div>`;
}
/* 一个目标的汇总行：折叠时只有这一行 —— 1000 条记录压成 10 行，靠的就是它 */
function aitGrpHTML(g) {
  const open = !!aitS().open[g.goalId];
  return `<div class="aitGrp ${open ? 'open' : ''}" data-ait-grpbox="${g.goalId}">
    <button class="aitGrpHd" data-ait-grp="${g.goalId}" aria-expanded="${open ? 'true' : 'false'}">
      <span class="aitGrpCaret">${open ? '▾' : '▸'}</span>
      <span class="aitGrpName" title="${esc(g.goalTitle)}">${esc(g.goalTitle)}</span>
      <span class="aitGrpNums">
        <span class="aitSt done">✓ ${g.done}</span>
        ${g.failed ? `<span class="aitSt failed">✗ ${g.failed}</span>` : ''}
        ${g.cancelled ? `<span class="aitSt cancelled">⏹ ${g.cancelled}</span>` : ''}
        <span class="aitGrpTotal">共 ${g.total}</span>
      </span>
      <span class="aitGrpLast">${g.lastAt ? '最近 ' + aitWhen(g.lastAt) : ''}</span>
    </button>
    <div class="aitGrpBody" ${open ? '' : 'hidden'}>${open ? aitRowsHTML(g.goalId) : ''}</div>
  </div>`;
}
function aitHistRowHTML(r) {
  const m = aitTypeMeta(r.type);
  const st = AITASK_ST[r.status] || { text: r.status, cls: 'done' };
  return `<div class="aitRowWrap">
    <div class="aitRow" data-ait-go="${r.goalId || 0}" title="点一下去这个目标">
      <span class="aitRowIcon">${m.icon}</span>
      <span class="aitRowTitle">${esc(r.title || m.label)}</span>
      <span class="aitSt ${st.cls}">${st.text}</span>
      <span class="aitRowMeta">${aitWhen(r.createdAt)}${r.costMs ? ' · ' + aitDur(r.costMs) : ''}</span>
      ${r.error ? '<button class="btn tiny" data-ait-err="1">看原因</button>' : ''}
    </div>
    ${r.error ? `<div class="aitErrBox" hidden>${esc(r.error)}</div>` : ''}
  </div>`;
}
/* 某一组已经加载出来的记录 + 「再看 N 条」 */
function aitRowsHTML(goalId) {
  const box = aitS().rows[goalId];
  if (!box) return '<div class="aitNone">正在读取…</div>';
  if (!box.rows.length) return '<div class="aitNone">这个目标下没有符合条件的记录。</div>';
  const rest = box.total - box.rows.length;
  return box.rows.map(aitHistRowHTML).join('')
    + (rest > 0 || box.hasMore
      ? `<div class="aitMore"><button class="btn tiny" data-ait-more="${goalId}">${box.loading ? '读取中…' : '再看 ' + Math.min(AIT_PAGE, Math.max(0, rest)) + ' 条'}${rest > 0 ? '（还有 ' + rest + ' 条）' : ''}</button></div>`
      : '');
}
function aitPaintRun(data) {
  const host = document.getElementById('aitRun');
  if (!host) return;
  const html = aitRunHTML(data);
  if (host.__html !== html) { host.__html = html; host.innerHTML = html; }
  const n = (data.running || []).length;
  const hint = document.getElementById('aitHint');
  if (hint) {
    const sm = data.summary || {};
    hint.textContent = (n ? n + ' 个正在执行 · ' : '')
      + `历史 ${sm.total || 0} 条（✓ ${sm.done || 0} · ✗ ${sm.failed || 0} · ⏹ ${sm.cancelled || 0}）`;
  }
}
function aitPaintHist() {
  const host = document.getElementById('aitHist');
  if (!host) return;
  const data = state.aitData || {};
  const f = aitS().filter;
  let groups = data.groups || [];
  if (f.goal) groups = groups.filter(g => Number(g.goalId) === Number(f.goal));
  const body = groups.length
    ? groups.map(aitGrpHTML).join('')
    : `<div class="aitNone">${(data.summary || {}).total ? '没有符合筛选条件的记录。' : '还没有跑完的 AI 任务记录。'}</div>`;
  host.innerHTML = body;
  const allBtn = document.getElementById('aitToggleAll');
  if (allBtn) {
    const anyClosed = groups.some(g => !aitS().open[g.goalId]);
    allBtn.textContent = anyClosed ? '展开全部' : '收起全部';
    allBtn.disabled = !groups.length;
  }
}
async function aitLoadRows(goalId, more) {
  const st = aitS();
  const cur = st.rows[goalId] || { rows: [], total: 0, hasMore: false, loading: false };
  if (cur.loading) return;
  cur.loading = true; st.rows[goalId] = cur;
  if (more) { const box = document.querySelector('[data-ait-grpbox="' + goalId + '"] .aitGrpBody'); if (box) box.innerHTML = aitRowsHTML(goalId); }
  try {
    const r = await api('/api/ai-tasks/history' + aitQuery({ goal: goalId, limit: AIT_PAGE, offset: more ? cur.rows.length : 0 }));
    cur.rows = more ? cur.rows.concat(r.rows || []) : (r.rows || []);
    cur.total = r.total || 0;
    cur.hasMore = !!r.hasMore;
  } catch (e) {
    cur.error = e.message;
  }
  cur.loading = false;
  const box = document.querySelector('[data-ait-grpbox="' + goalId + '"] .aitGrpBody');
  if (box) box.innerHTML = aitRowsHTML(goalId);
}
async function aitToggle(goalId, force) {
  const st = aitS();
  const open = force != null ? force : !st.open[goalId];
  st.open[goalId] = open;
  const box = document.querySelector('[data-ait-grpbox="' + goalId + '"]');
  if (!box) return;
  box.classList.toggle('open', open);
  const hd = box.querySelector('.aitGrpHd');
  if (hd) hd.setAttribute('aria-expanded', open ? 'true' : 'false');
  const caret = box.querySelector('.aitGrpCaret');
  if (caret) caret.textContent = open ? '▾' : '▸';
  const body = box.querySelector('.aitGrpBody');
  if (body) body.hidden = !open;
  if (open && !st.rows[goalId]) { if (body) body.innerHTML = '<div class="aitNone">正在读取…</div>'; await aitLoadRows(goalId, false); }
  else if (open && body) body.innerHTML = aitRowsHTML(goalId);
  const allBtn = document.getElementById('aitToggleAll');
  if (allBtn) {
    const gs = (state.aitData && state.aitData.groups) || [];
    allBtn.textContent = gs.some(g => !aitS().open[g.goalId]) ? '展开全部' : '收起全部';
  }
}
async function renderAiTasksPage() {
  aiTasksStopPoll();
  aitS();
  app.innerHTML = '<p class="muted">正在读取 AI 任务…</p>';
  let data;
  try { data = await api('/api/ai-tasks' + aitQuery()); } catch (e) {
    app.innerHTML = `<div class="page"><div class="pageHead"><button class="back" data-back="#/">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🤖 AI 任务</h2></div>
      <div class="emptyBox" style="margin-top:30px;"><div class="ebIcon">⚠️</div><div class="ebTitle">读取失败</div><div class="ebText">${esc(e.message)}</div></div></div>`;
    return;
  }
  state.aitData = data;
  const f = aitS().filter;
  app.innerHTML = `<div class="page">
    <div class="pageHead">
      <button class="back" data-back="#/">← 返回</button>
      <h2 class="title" style="margin-left:10px;">🤖 AI 任务</h2><span class="aitHeadHint" id="aitHint"></span>
    </div>
    <div id="aitRun"></div>
    <div class="aitSec">
      <div class="aitSecT">历史记录<span class="aitSecN">${(data.summary || {}).total || 0}</span></div>
      <div class="aitFilters" id="aitFilters">
        <input id="aitQ" class="aitQ" placeholder="搜任务标题…" value="${esc(f.q)}">
        <button class="aitFbtn" data-ait-open="goal"><span class="aitFLabel">${esc(aitGoalLabel())}</span><span class="aitFCaret">▾</span></button>
        <button class="aitFbtn" data-ait-open="status"><span class="aitFLabel">${esc(aitStatusLabel())}</span><span class="aitFCaret">▾</span></button>
        <button class="aitFbtn" data-ait-open="time"><span class="aitFLabel">${esc(aitTimeLabel())}</span><span class="aitFCaret">▾</span></button>
        <span class="spacer"></span>
        <button class="btn tiny" id="aitToggleAll">展开全部</button>
      </div>
    </div>
    <div id="aitHist"></div>
  </div>`;
  /* 选了某个目标 → 直接把它展开，省一次点击 */
  if (f.goal) aitS().open[f.goal] = true;
  aitPaintRun(data);
  aitPaintHist();
  bindAiTasks();
  if (f.goal) await aitLoadRows(f.goal, false).then(aitPaintHist);
  /* 常驻轻轮询：这一页就是看任务的，随时可能新起一个。历史那块只在总数变了才重画 */
  aiTasksTimer = setInterval(async () => {
    if (parseRoute().view !== 'aitasks') { aiTasksStopPoll(); return; }
    try {
      const d = await api('/api/ai-tasks' + aitQuery());
      const before = ((state.aitData || {}).summary || {}).total || 0;
      state.aitData = d;
      aitPaintRun(d);
      if (((d.summary || {}).total || 0) !== before) aitPaintHist();
    } catch (e) {}
  }, 3000);
}
function bindAiTasks() {
  const q = document.getElementById('aitQ');
  if (q) {
    let t = null;
    const run = () => {
      aitS().filter.q = q.value.trim();
      aitS().open = {}; aitS().rows = {};
      aitPaintHist();
      const g = aitS().filter.goal || ((state.aitData && state.aitData.groups || [])[0] || {}).goalId;
      if (aitS().filter.goal) { aitS().open[g] = true; aitLoadRows(g, false).then(aitPaintHist); }
    };
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); });
  }
  /* 三个下拉按钮 + 弹层里的选项。弹层是 body 下的浮动元素，所以选项和"应用"
     都走**文档级委托**，只绑一次（每次进页都绑会越积越多）。 */
  const bar = document.getElementById('aitFilters');
  if (bar) bar.addEventListener('click', e => {
    const b = e.target.closest('[data-ait-open]');
    if (b) { e.stopPropagation(); sxiPopShow(b, b.getAttribute('data-ait-open')); return; }
  });
  if (!window.__sxiSelBound) {
    window.__sxiSelBound = true;
    document.addEventListener('click', async e => {
      const pick = e.target.closest && e.target.closest('[data-ait-pick]');
      if (pick) {
        const v = pick.getAttribute('data-ait-pick');
        if (v.indexOf('goal:') === 0) aitS().filter.goal = Number(v.slice(5)) || 0;
        else aitS().filter.status = v.slice(7);
        sxiPopClose(); await aitAfterFilterChange();
        return;
      }
      const tm = e.target.closest && e.target.closest('[data-ait-time]');
      if (tm) { aitApplyPreset(tm.getAttribute('data-ait-time')); sxiPopClose(); await aitAfterFilterChange(); return; }
      if (e.target.closest && e.target.closest('#sxiRangeGo')) {
        if (aitApplyCustom()) { sxiPopClose(); await aitAfterFilterChange(); }
      }
    }, true);
  }
  const all = document.getElementById('aitToggleAll');
  if (all) all.addEventListener('click', async () => {
    const data = state.aitData || {};
    const f = aitS().filter;
    let gs = data.groups || [];
    if (f.goal) gs = gs.filter(g => Number(g.goalId) === Number(f.goal));
    const anyClosed = gs.some(g => !aitS().open[g.goalId]);
    for (const g of gs) {
      aitS().open[g.goalId] = anyClosed;
      if (anyClosed && !aitS().rows[g.goalId]) await aitLoadRows(g.goalId, false);
    }
    aitPaintHist();
  });
  const body = document.getElementById('aitHist');
  if (body) body.addEventListener('click', async e => {
    const hd = e.target.closest('[data-ait-grp]');
    if (hd) { await aitToggle(Number(hd.getAttribute('data-ait-grp'))); return; }
    const more = e.target.closest('[data-ait-more]');
    if (more) { await aitLoadRows(Number(more.getAttribute('data-ait-more')), true); return; }
    const eb = e.target.closest('[data-ait-err]');
    if (eb) {                       /* 要排在跳转前面：它就在可跳转的那一行里 */
      const box = eb.closest('.aitRowWrap') && eb.closest('.aitRowWrap').querySelector('.aitErrBox');
      if (box) box.hidden = !box.hidden;
      return;
    }
    const goEl = e.target.closest('[data-ait-go]');
    if (goEl) { const id = Number(goEl.getAttribute('data-ait-go')); if (id) go('#/g/' + id); }
  });
  const runBox = document.getElementById('aitRun');
  if (runBox) runBox.addEventListener('click', async e => {
    const c = e.target.closest('[data-ait-cancel]');
    if (!c) return;
    try { await api('/api/tasks/' + c.getAttribute('data-ait-cancel') + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已请求停止'); await taskPoll(); }
    catch (err) { toast(err.message); }
  });
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
/* 左栏主导航。左栏原有的「📦 组件」分组（含常用置顶、组件入口、教程书签）已下线：
   组件入口改为放进各页面顶栏的标签栏（收藏栏），组件管理保留下面这个 🧩 入口。 */
function railItemsHTML() {
  const r = parseRoute();
  const g = state.goal;
  const themeIcon = currentThemeEff() === 'dark' ? '☀️' : '🌙';
  const inGoal = !!(g && (r.view === 'goal' || r.view === 'map' || r.view === 'plugin'));
  /* 左栏「AI 任务」上的小红点 = 有任务正在跑（数字由 taskPoll 维护） */
  const runningN = Number(state.taskRunning || 0);
  const items = [{ icon: '🏠', label: '目标', hash: '#/', active: r.view === 'home' }];
  if (inGoal) items.push({ icon: '🗺', label: '路线图', hash: '#/g/' + g.id, active: r.view === 'goal' });
  const hasUpd = !!(state.update && state.update.supported && state.update.behind > 0 && state.update.latestShort !== updSkipHash());
  items.push({ icon: '⚙', label: '设置', hash: '#/settings', active: r.view === 'settings', dot: hasUpd });
  items.push({ icon: '📚', label: '资源库', hash: '#/library', active: r.view === 'library' });
  items.push({ icon: '📦', label: '产出库', hash: '#/outlib', active: r.pluginId === 'outlib' });
  items.push({ icon: '🧩', label: '组件管理', hash: '#/components', active: r.view === 'components' });
  items.push({ icon: '🤖', label: 'AI 任务', hash: '#/aitasks', active: r.view === 'aitasks',
    dot: runningN > 0, dotTitle: runningN + ' 个任务正在执行' });
  const head = items.slice(0, inGoal ? 2 : 1);
  const tail = items.slice(inGoal ? 2 : 1);
  const row = i => `<a class="railItem ${i.active ? 'active' : ''}" href="${i.hash}" title="${esc(i.label)}${i.dot ? ' · ' + esc(i.dotTitle || '有新版本') : ''}">
        <span class="railIcon">${i.icon}${i.dot ? '<i class="railDot"></i>' : ''}</span><span class="railLabel">${esc(i.label)}</span></a>`;
  return `<a class="railLogo" href="#/" title="思而行 · 返回目标列表">${RAIL_LOGO_SVG}</a>
    <div class="railNav">
      ${head.map(row).join('')}
      ${tail.map(row).join('')}
    </div>
    <div class="railBottom">
      <button class="railItem" id="railTheme" title="切换白天 / 黑夜模式">
        <span class="railIcon">${themeIcon}</span><span class="railLabel">主题</span>
      </button>
    </div>`;
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
      s.src = assetUrl(p.client);
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
    rerender: rerenderCurrent, loadGoal, ensureGoal, aiToggle, mdPickOffset,
    mdPickTarget, mdSrcRange, editKeysBind,
    mdInlineEdit: { open: mdInlineOpen, close: mdInlineClose, active: mdInlineActive, value: mdInlineValue, range: mdSrcRange, slice: mdSliceLines, splice: mdSpliceLines },
    mount: () => { if (BOOTED) pluginGoButtonsBind(); },
    ready: false
  });
  await loadComponents();
  try { state.aiStatus = await api('/api/ai/status'); } catch (e) { state.aiStatus = {}; }
  await loadFrontendPlugins();
  SiErXing.provide({
    app, api, esc, toast, go, state, mdToHTML, fmtDate, safeParse, parseRoute,
    rerender: rerenderCurrent, loadGoal, ensureGoal, aiToggle, mdPickOffset,
    mdPickTarget, mdSrcRange, editKeysBind,
    mdInlineEdit: { open: mdInlineOpen, close: mdInlineClose, active: mdInlineActive, value: mdInlineValue, range: mdSrcRange, slice: mdSliceLines, splice: mdSpliceLines },
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
  /* 首次运行时问一句「数据存哪」。
     Windows 上程序默认装在 C 盘，目标信息源、作答记录、备份都会堆进系统盘 ——
     趁数据还只有几 MB 的时候问一句，比攒到几个 G 再搬家省事。 */
  try { maybeAskDataDir(); } catch (e) {}
})().catch(err => {
  console.error('启动失败：', err);
  try {
    const box = document.getElementById('app');
    if (box) box.innerHTML = '<div class="page"><div class="emptyBox" style="margin-top:40px;">'
      + '<div class="ebIcon">⚠️</div><div class="ebTitle">界面启动失败</div>'
      + '<div class="ebText">' + String((err && err.message) || err) + '<br>请按 Ctrl+Shift+R 强制刷新；若仍失败，请把此信息反馈给作者。</div></div></div>';
  } catch (e) {}
});
