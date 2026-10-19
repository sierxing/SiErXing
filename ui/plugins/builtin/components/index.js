'use strict';
/**
 * 内置 UI 插件 · 组件管理页（#/components）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/components/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

/** 组件页显示偏好：折叠状态 + 搜索词（本机） */
function cmpPrefs() {
  const d = { collapsed: {}, q: '', goalCollapsed: {}, goalQ: '' };
  try {
    const raw = localStorage.getItem('sierxing-cmp-prefs');
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        if (o.collapsed && typeof o.collapsed === 'object') d.collapsed = o.collapsed;
        if (o.goalCollapsed && typeof o.goalCollapsed === 'object') d.goalCollapsed = o.goalCollapsed;
        d.q = typeof o.q === 'string' ? o.q : '';
        d.goalQ = typeof o.goalQ === 'string' ? o.goalQ : '';
      }
    }
  } catch (e) {}
  return d;
}

function applyComponentStyles(styles) {
  /* 主题皮肤不走这条通道：由 applyThemeStyles() 按亮 / 暗模式单独挂载。
     这里把主题组件的 CSS 过滤掉 —— 否则「组件管理页里开着主题开关」会绕过分模式选择。 */
  const themeIds = new Set(((H.state.componentList || []).filter(c => c.kind === 'theme' || c.scope === 'theme')).map(c => c.id));
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

function goalManageableEntries(pg) {
  const out = [];
  const seen = new Set();
  for (const c of (H.state.componentList || [])) {
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
    const c = (H.state.componentList || []).find(x => x.id === id);
    return c && c.order != null ? c.order : 100;
  };
  out.sort((a, b) => orderOf(a.id) - orderOf(b.id));
  const metaOf = id => ((SiErXing.serverPlugins() || []).find(p => p.id === id) || {});
  return out.map(e => ({ ...e, desc: metaOf(e.id).desc || '' }));
}

/**
 * 把组件按分类分组，并按当前搜索词过滤。
 * @returns [{ key, items, total, empty }]  （搜索时没命中的分类整个不返回；空分类只在无搜索时返回）
 */
function cmpGroupComponents(items, cats, q) {
  const groups = {};
  for (const c of items) {
    const k = c.category || '其它';
    (groups[k] = groups[k] || []).push(c);
  }
  const customOrder = (cats && cats.categories) || [];
  const keys = cmpSortCats(Object.keys(groups).concat(customOrder), cats);
  const out = [];
  for (const key of keys) {
    const all = groups[key] || [];
    const hit = q ? all.filter(function (c) { return cmpMatchComponent(c, q); }) : all;
    if (q && !hit.length) continue;
    out.push({ key: key, items: hit, total: all.length, empty: all.length === 0 });
  }
  return out;
}

/** 全局组件卡片 */
function cmpCardHTML(c, catOptions, enabled) {
  const on = enabled[c.id] !== false;
  const isTheme = (c.kind === 'theme' || c.scope === 'theme');
  const chips = [];
  if (c.scope === 'core') chips.push('<span class="chip gray">核心 · 不可关闭</span>');
  if (isTheme) chips.push('<span class="chip gray">主题皮肤</span>');
  if (!c.builtin) chips.push('<span class="chip">第三方组件</span>');
  if (c.goalToggle && c.scope !== 'core' && !isTheme) chips.push('<span class="chip gray" title="可在新建目标时勾选；各目标也可单独开关">按目标启用</span>');
  if (c.version) chips.push('<span class="cmpVer">v' + H.esc(c.version) + '</span>');
  if (c.author) chips.push('<span class="cmpAuthor">' + H.esc(tr('by {0}', tr(c.author))) + '</span>');
  return '<div class="cmpCard' + (c.scope === 'core' ? ' isCore' : '') + (on ? '' : ' isOff') + '">' +
    '<div class="cmpCardTop">' +
      '<span class="cmpIcon">' + (c.icon || '✨') + '</span>' +
      '<div class="cmpName">' + H.esc(tr(c.name)) + chips.join('') + '</div>' +
      '<div class="cmpOps">' + (isTheme
        ? '<a class="btn tiny" href="#/settings/theme">去设置里选</a>'
        : '<label class="cmpSwitch" title="' + H.esc(tr(c.scope === 'core' ? '核心组件不可关闭' : '开启 / 关闭')) + '">' +
            '<input type="checkbox" data-cmp="' + H.esc(c.id) + '"' + (on ? ' checked' : '') + (c.scope === 'core' ? ' disabled' : '') + '>' +
            '<span class="cmpSlider"></span>' +
          '</label>') +
      '</div>' +
    '</div>' +
    (c.desc ? '<div class="cmpDesc">' + H.esc(tr(c.desc)) + '</div>' : '') +
    '<div class="cmpCatRow">' +
      '<span class="cmpCatLabel">分类</span>' +
      '<select class="cmpCatSel sxi-sel sxi-sel-sm" data-comp-cat="' + H.esc(c.id) + '" title="选择其它分类，卡片会立刻搬过去">' +
        catOptions.map(function (k) { return '<option value="' + H.esc(k) + '"' + (k === (c.category || '其它') ? ' selected' : '') + '>' + H.esc(tr(k)) + '</option>'; }).join('') +
      '</select>' +
      (!c.builtin ? '<span class="cmpCardLinks">' +
        '<a class="btn tiny" href="/api/components/' + H.esc(c.id) + '/export">导出</a>' +
        '<button class="btn tiny danger" data-cmp-del="' + H.esc(c.id) + '">卸载</button>' +
      '</span>' : '') +
    '</div>' +
    (!c.builtin ? '<div class="cmpFiles">' + H.esc(tr('服务端')) + ' server/plugins/' + H.esc(c.id) + '.js' +
      (c.client ? ' · ' + H.esc(tr('前端')) + ' public/plugins/' + H.esc(c.id) + '.js' : '') +
      (c.hasStyle ? ' · ' + H.esc(tr('样式')) + ' public/plugins/' + H.esc(c.id) + '.css' : '') + '</div>' : '') +
  '</div>';
}

/** 一个可折叠的分类模块（标题行整行可点） */
function cmpCatSectionHTML(o) {
  // o: key, total, hit, collapsed, bodyHTML, hint
  const folded = !!o.collapsed;
  const cnt = o.hit != null && o.hit !== o.total ? tr('{0} 个 · 命中 {1}', o.total, o.hit) : tr('{0} 个', o.total);
  return '<section class="cmpCatMod' + (folded ? ' isFolded' : '') + '" data-cmp-cat="' + H.esc(o.key) + '">' +
    '<button type="button" class="cmpCatHead" data-cmp-fold="' + H.esc(o.key) + '" aria-expanded="' + (folded ? 'false' : 'true') + '">' +
      '<span class="cmpCatFold" aria-hidden="true">' + (folded ? '▸' : '▾') + '</span>' +
      '<span class="cmpCatIcon" aria-hidden="true">' + cmpCatIcon(o.key) + '</span>' +
      '<span class="cmpCatName">' + H.esc(tr(o.key)) + '</span>' +
      '<span class="cmpCatBadge">' + cnt + '</span>' +
      '<span class="spacer"></span>' +
      '<span class="cmpCatAct">' + H.esc(folded ? tr('展开') : tr('收起')) + '</span>' +
    '</button>' +
    '<div class="cmpCatBody"' + (folded ? ' hidden' : '') + '>' +
      (o.hint ? '<p class="hint cmpCatHint">' + o.hint + '</p>' : '') +
      (o.bodyHTML || '<div class="cmpEmpty">（这个分类里还没有组件 —— 把某个组件的「分类」改成它，就会搬过来）</div>') +
    '</div>' +
  '</section>';
}

/** 分类模块的说明文字（按分类给不同提示，保留原有语义） */
function cmpCatHint(key, list) {
  const hints = [];
  if (key === '核心组件') hints.push(tr('应用的基础能力，无法关闭。'));
  if ((list || []).some(function (c) { return c.kind === 'theme' || c.scope === 'theme'; })) {
    hints.push(tr('主题皮肤在「设置 → 外观主题」里分别为亮色 / 暗色模式选择；这里的开关对它不生效。'));
  }
  if ((list || []).some(function (c) { return !c.builtin; })) {
    hints.push(tr('独立文件组件可以导出分享或卸载；带「按目标启用」的组件可在新建目标时勾选。'));
  }
  return hints.join('');
}

/** 按目标组件卡片（只改本目标） */
function cmpGoalCardHTML(e, on) {
  return '<div class="cmpCard' + (on ? '' : ' isOff') + '">' +
    '<div class="cmpCardTop">' +
      '<span class="cmpIcon">' + (e.icon || '🧩') + '</span>' +
      '<div class="cmpName">' + H.esc(e.name) + (e.desc ? '<div class="cmpDesc">' + H.esc(e.desc) + '</div>' : '') + '</div>' +
      '<div class="cmpOps"><label class="cmpSwitch" title="只改本目标（其它目标不受影响）">' +
        '<input type="checkbox" data-gcmp="' + H.esc(e.id) + '"' + (on ? ' checked' : '') + '><span class="cmpSlider"></span>' +
      '</label></div>' +
    '</div>' +
  '</div>';
}

function cmpPrefsSave(p) {
  try { localStorage.setItem('sierxing-cmp-prefs', JSON.stringify(p || {})); } catch (e) {}
}

/** 顶部搜索框 */
function cmpSearchHTML(o) {
  const q = String(o.value || '');
  return '<div class="cmpSearch">' +
    '<span class="cmpSearchIcon" aria-hidden="true">🔍</span>' +
    '<input type="search" id="' + H.esc(o.id) + '" class="cmpSearchInput" value="' + H.esc(q) + '" placeholder="' + H.esc(tr(o.placeholder || '搜索组件：名字 / 说明 / id / 分类')) + '" autocomplete="off" spellcheck="false" aria-label="' + H.esc(tr('搜索组件')) + '">' +
    (q ? '<button type="button" class="cmpSearchClear" data-cmp-search-clear="' + H.esc(o.id) + '" title="清空搜索">×</button>' : '') +
    '<span class="cmpSearchCount">' + (q ? tr('命中 {0} / {1}', o.hit, o.total) : tr('共 {0} 个组件', o.total)) + '</span>' +
  '</div>';
}

/** 组件是否命中搜索词（名字 / 说明 / id / 分类 / 作者 / 版本，空格分隔多个关键词） */
function cmpMatchComponent(c, q) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return true;
  const hay = [c.name, c.desc, c.id, c.category, c.author, c.version].filter(Boolean).join(' ').toLowerCase();
  return kw.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
}

/* ============================================================================
 * 组件管理页「管理范围」：一个按钮 + 可搜索弹层
 * ========================================================================== */
/** 管理范围按钮的 HTML（全局默认是 value=0 的那一项） */
function cmpScopePickHTML(scope, goals) {
  const gid = String(scope || '').startsWith('goal:') ? Number(String(scope).slice(5)) : 0;
  return H.sxiGoalPickHTML('cmpScopePick', {
    value: gid,
    goals: goals || [],
    allLabel: tr('🌍 全局默认（新目标的默认值）'),
    label: '管理范围',
    cls: 'cmpScopePick',
  });
}

/** 分类管理块（新建 / 重命名 / 删除） */
function cmpCatManageHTML(catsInfo) {
  const cats = (catsInfo && catsInfo.categories) || [];
  const used = (catsInfo && catsInfo.used) || {};
  return '<div class="sec cmpCatManage">' +
    '<p class="hint" style="margin:0 0 10px;">分类用于整理组件，也可以在「新建目标」时<b>按分类批量选择</b>组件。</p>' +
    '<div class="catList" id="catList">' + (cats.length
      ? cats.map(function (c) {
          return '<span class="catItem">' +
            '<span class="catName">' + H.esc(c) + '</span>' +
            '<span class="catCount">' + (used[c] || 0) + '</span>' +
            '<button class="catOp" data-cat-rename="' + H.esc(c) + '" title="重命名">✎</button>' +
            '<button class="catOp danger" data-cat-del="' + H.esc(c) + '" title="删除（组件回到「其它」）">×</button>' +
          '</span>';
        }).join('')
      : '<span class="muted" style="font-size:12.5px;">还没有自定义分类（组件使用插件自带的分类）</span>') +
    '</div>' +
    '<div class="consAdd" style="margin-top:10px;">' +
      '<input type="text" id="catNewName" placeholder="新建分类，例如：学习成长 / 效率工具 / 我的收藏">' +
      '<button class="btn small primary" id="catAddBtn">新建分类</button>' +
    '</div>' +
  '</div>';
}

/** 「分享与开发组件」的说明（两侧视图共用） */
function cmpShareHTML() {
  return '<p class="hint" style="line-height:1.9;margin:8px 0 0;">' +
    '· 导出：点组件的「导出」得到 <code>*.component.json</code> 文件（含服务端代码、前端代码与样式），发给别人即可<br>' +
    '· 导入：点右上「导入组件」选择该文件，组件会立刻装好并可开关<br>' +
    '· 自己写一个：把 <code>server/plugins/xxx.js</code>（声明元数据 + 接口 + 建表）和 <code>public/plugins/xxx.js</code>（界面）、<code>public/plugins/xxx.css</code>（样式）放进去即可，详见 README「插件开发」' +
  '</p>';
}

/** 绑管理范围的弹层：选中就切 state.compScope 再整页重画 */
function cmpScopePickBind() {
  if (!document.getElementById('cmpScopePick')) return;
  H.sxiGoalPickBind('cmpScopePick', {
    onPick: async function (gid) {
      H.state.compScope = gid ? ('goal:' + gid) : 'global';
      await renderComponentsPage();
      try { H.renderRail(); } catch (e) {}
    }
  });
}

function showImportDialog(parsed) {
  const cats = ((H.state.componentCats || {}).categories) || [];
  const installed = new Set(((H.state.componentList || []).filter(c => !c.builtin)).map(c => c.id));
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
          <b>${H.esc(x.name)}</b>
          <span class="muted">${H.esc(x.id || x.file)}${x.version ? ' · v' + H.esc(x.version) : ''}${x.author ? ' · ' + H.esc(x.author) : ''}</span>
          ${x.error ? `<span class="impErr">${H.esc(x.error)}</span>` : ''}
        </div>`).join('')}
      </div>
      ${valid.length ? `<div class="field" style="margin-top:12px;"><label>导入到分类（可统一归类，也可用组件自带分类）</label>
        <select id="impCat">
          <option value="__auto__">使用组件自带分类（${H.esc(Array.from(new Set(valid.map(v => v.autoCat))).join(' / '))}）</option>
          ${cats.map(c => `<option value="${H.esc(c)}">${H.esc(c)}</option>`).join('')}
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
      if (!name) return H.toast('请填写新分类名称');
      category = name;
    }
    okBtn.disabled = true; okBtn.textContent = '导入中…';
    try {
      const r = await H.api('/api/components/install-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundles: valid.map(v => v.bundle), category }) });
      const fails = (r.results || []).filter(x => !x.ok);
      H.toast('已导入 ' + r.okCount + ' 个组件' + (r.category ? '（分类：' + r.category + '）' : '') + (fails.length ? '；失败 ' + fails.length + ' 个' : ''));
      close();
      await H.loadComponents();
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      H.toast('导入失败：' + err.message);
      okBtn.disabled = false; okBtn.textContent = '重试导入';
    }
  });
}

/** 分类排序：核心、基础、用户自定义顺序、其它垫底 */
function cmpSortCats(keys, cats) {
  const customOrder = (cats && cats.categories) || [];
  const rank = function (k) { return k === '核心组件' ? 0 : (k === '基础功能组件' ? 1 : 99); };
  return keys.filter(function (k, i, a) { return a.indexOf(k) === i; }).sort(function (a, b) {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ia = customOrder.indexOf(a), ib = customOrder.indexOf(b);
    const na = ia < 0 ? 999 : ia, nb = ib < 0 ? 999 : ib;
    if (na !== nb) return na - nb;
    if (a === '其它') return 1;
    if (b === '其它') return -1;
    return String(a).localeCompare(String(b), 'zh');
  });
}

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

/** 分类标题的小图标（纯观感：不同类别给个能认的图标，别让一坨字糊在一起） */
function cmpCatIcon(key) {
  const map = {
    '核心组件': '🧭', '基础功能组件': '🧩', '主题与样式': '🎨', '外观主题': '🎨',
    '学习与练习': '📚', '界面插件': '🖥', '效率工具': '⚡', '其它': '📦'
  };
  return map[key] || '🏷';
}

async function renderComponentsPage() {
  const scrollY = window.scrollY || 0;          // 记住滚动位置，重渲染后恢复
  const prefs = cmpPrefs();
  H.app.innerHTML = '<p class="muted">加载组件…</p>';
  const [r, catsRes, goalsRes] = await Promise.all([
    H.api('/api/components'),
    H.api('/api/component-categories').catch(function () { return { categories: [], used: {}, map: {} }; }),
    H.api('/api/goals').catch(function () { return { goals: [] }; })
  ]);
  const scopeGoals = (goalsRes.goals || []).map(function (g) { return { id: g.id, title: g.title }; });
  if (!H.state.compScope) H.state.compScope = 'global';
  const scope = H.state.compScope;
  const scopeGid = String(scope).startsWith('goal:') ? Number(String(scope).slice(5)) : 0;
  const scopeGoal = scopeGoals.find(function (g) { return g.id === scopeGid; }) || null;
  if (scopeGid && !scopeGoal) H.state.compScope = 'global';
  // 目标范围内的各组件开关（只读本目标、不写别处）
  let scopeConfig = null;
  if (scopeGoal) {
    try {
      const pr = await H.api('/api/goals/' + scopeGoal.id + '/plugins');
      scopeConfig = pr.config || {};
    } catch (e) { scopeConfig = {}; }
  }
  H.state.components = r.enabled || {};
  H.state.componentList = r.components || [];
  H.state.componentPins = r.pins || H.state.componentPins || [];
  H.state.componentCats = catsRes;                 // 分类实时刷新（新建后立即出现）
  applyComponentStyles(r.styles || []);
  const comps = r.components || [];
  const catsInfo = H.state.componentCats || { categories: [], used: {} };
  // 分类下拉的可选项：自定义分类 + 现有分类 + 兜底「其它」
  const catOptions = [];
  for (const k of [].concat((catsInfo.categories || []), comps.map(function (c) { return c.category || '其它'; }), ['其它'])) {
    if (catOptions.indexOf(k) < 0) catOptions.push(k);
  }
  // 目标视图的条目（只读本目标 + 附带分类/图标/说明）
  const goalItems = scopeGoal ? goalManageableEntries({ id: scopeGoal.id, plugins: JSON.stringify(scopeConfig || {}) }).map(function (e) {
    const meta = comps.find(function (c) { return c.id === e.id; }) || {};
    return {
      id: e.id,
      name: e.name || e.id,
      icon: e.icon || meta.icon || '🧩',
      desc: e.desc || meta.desc || '',
      category: meta.category || '其它'
    };
  }) : [];
  const goalOn = function (id) { return SiErXing.pluginEnabled({ id: scopeGoal.id, plugins: JSON.stringify(scopeConfig || {}) }, id); };

  /* ---------- 局部重绘：只重画分类列表，保住搜索框焦点与折叠状态 ---------- */
  function paintGlobalList() {
    const box = document.getElementById('cmpCatList');
    if (!box) return;
    const groups = cmpGroupComponents(comps, catsInfo, prefs.q);
    box.innerHTML = groups.length ? groups.map(function (g) {
      const body = g.items.length ? '<div class="cmpGrid">' + g.items.map(function (c) { return cmpCardHTML(c, catOptions, H.state.components); }).join('') + '</div>' : '';
      return cmpCatSectionHTML({ key: g.key, total: g.total, hit: g.items.length, collapsed: cmpFolded('collapsed', g.key), bodyHTML: body, hint: cmpCatHint(g.key, g.items) });
    }).join('') : '<div class="cmpEmpty">' + (prefs.q ? ('没有匹配「' + H.esc(prefs.q) + '」的组件') : '还没有组件') + '</div>';
    bindCatFold(box, 'collapsed');
    bindCardOps(box);
    try { H.sxiSelify(box); } catch (e) {}
    paintSearchCount('cmpSearch', groups);
  }
  function paintGoalList() {
    const box = document.getElementById('cmpGoalCatList');
    if (!box) return;
    const groups = cmpGroupComponents(goalItems, catsInfo, prefs.goalQ);
    box.innerHTML = groups.length ? groups.map(function (g) {
      const body = g.items.length ? '<div class="cmpGrid">' + g.items.map(function (e) { return cmpGoalCardHTML(e, goalOn(e.id)); }).join('') + '</div>' : '';
      return cmpCatSectionHTML({ key: g.key, total: g.total, hit: g.items.length, collapsed: cmpFolded('goalCollapsed', g.key), bodyHTML: body, hint: cmpCatHint(g.key, g.items) });
    }).join('') : '<div class="cmpEmpty">' + (prefs.goalQ ? ('没有匹配「' + H.esc(prefs.goalQ) + '」的组件') : '这个目标还没有可单独开关的组件') + '</div>';
    bindCatFold(box, 'goalCollapsed');
    bindGoalToggles(box);
    paintSearchCount('cmpGoalSearch', groups);
  }
  /** 折叠状态：默认全收起；用户在本次会话/本机展开过就按记录来 */
  function cmpFolded(key, cat) {
    const o = prefs[key] || {};
    return o[cat] === undefined ? true : !!o[cat];
  }
  function paintSearchCount(id, groups) {
    const input = document.getElementById(id);
    const wrap = input && input.closest('.cmpSearch');
    const cnt = wrap && wrap.querySelector('.cmpSearchCount');
    if (!cnt) return;
    const isGoal = id === 'cmpGoalSearch';
    const q = isGoal ? prefs.goalQ : prefs.q;
    const total = isGoal ? goalItems.length : comps.length;
    const hit = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    cnt.textContent = q ? ('命中 ' + hit + ' / ' + total) : ('共 ' + total + ' 个组件');
  }

  /* ---------- 事件绑定 ---------- */
  /** 分类标题：展开 / 收起（记住状态） */
  function bindCatFold(root, prefKey) {
    root.querySelectorAll('[data-cmp-fold]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-cmp-fold');
        const mod = btn.closest('.cmpCatMod');
        if (!mod) return;
        const folded = !mod.classList.contains('isFolded');
        mod.classList.toggle('isFolded', folded);
        btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
        const body = mod.querySelector('.cmpCatBody');
        if (body) body.hidden = folded;
        const icon = btn.querySelector('.cmpCatFold');
        if (icon) icon.textContent = folded ? '▸' : '▾';
        const act = btn.querySelector('.cmpCatAct');
        if (act) act.textContent = folded ? '展开' : '收起';
        if (!prefs[prefKey] || typeof prefs[prefKey] !== 'object') prefs[prefKey] = {};
        prefs[prefKey][key] = folded;
        cmpPrefsSave(prefs);
      });
    });
  }
  /** 全局卡片上的开关 / 卸载 / 分类下拉 */
  function bindCardOps(root) {
    root.querySelectorAll('[data-cmp]').forEach(function (inp) {
      inp.addEventListener('change', async function () {
        const id = inp.getAttribute('data-cmp');
        const enabled = inp.checked;
        try {
          const res = await H.api('/api/components/' + encodeURIComponent(id) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
          H.state.components = res.enabled || H.state.components;
          H.toast(enabled ? '已开启组件' : '已关闭组件');
          const card = inp.closest('.cmpCard');
          if (card) card.classList.toggle('isOff', !enabled);
          H.renderRail();
        } catch (e) { H.toast(e.message); inp.checked = !enabled; }
      });
    });
    root.querySelectorAll('[data-cmp-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const id = b.getAttribute('data-cmp-del');
        if (!confirm('卸载组件「' + id + '」？相关文件会被删除（数据表保留）。')) return;
        try {
          await H.api('/api/components/' + encodeURIComponent(id), { method: 'DELETE' });
          H.toast('已卸载');
          await H.loadComponents();
          location.reload();
        } catch (e) { H.toast(e.message); }
      });
    });
    /* 分类下拉：接口成功后就地重画分类列表（卡片真正搬过去，且不丢搜索 / 滚动位置） */
    root.querySelectorAll('[data-comp-cat]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        const id = sel.getAttribute('data-comp-cat');
        const to = sel.value;
        try {
          await H.api('/api/components/' + encodeURIComponent(id) + '/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: to }) });
          const item = comps.find(function (c) { return c.id === id; });
          if (item) item.category = to;
          H.toast('已移动到「' + to + '」');
          paintGlobalList();
          H.renderRail();
        } catch (e) {
          H.toast(e.message);
          const item = comps.find(function (c) { return c.id === id; });
          if (item) sel.value = item.category || '其它';
        }
      });
    });
  }
  /** 目标卡片上的开关（只写本目标） */
  function bindGoalToggles(root) {
    root.querySelectorAll('[data-gcmp]').forEach(function (inp) {
      inp.addEventListener('change', async function () {
        const pid = inp.getAttribute('data-gcmp');
        const gid = scopeGoal ? scopeGoal.id : 0;
        if (!gid) return;
        try {
          await H.api('/api/goals/' + gid + '/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: pid, enabled: inp.checked }) });
          scopeConfig = scopeConfig || {};
          scopeConfig[pid] = inp.checked;
          H.toast(inp.checked ? '已为本目标启用（别的不受影响）' : '已为本目标关闭（别的不受影响）');
          const card = inp.closest('.cmpCard');
          if (card) card.classList.toggle('isOff', !inp.checked);
          if (H.state.goal && H.state.goal.id === gid) { try { await H.loadGoal(gid); } catch (e) {} }
        } catch (e) { H.toast(e.message); inp.checked = !inp.checked; }
      });
    });
  }
  /** 搜索框：输入即过滤（120ms 防抖）；Esc / × 一键清空 */
  function bindSearch(id, prefKey, paint) {
    const input = document.getElementById(id);
    if (!input) return;
    let timer = null;
    let wrap = input.closest('.cmpSearch');
    function syncClearBtn() {
      wrap = input.closest('.cmpSearch');
      if (!wrap) return;
      let btn = wrap.querySelector('.cmpSearchClear');
      const has = !!input.value;
      if (has && !btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cmpSearchClear';
        btn.title = '清空搜索';
        btn.textContent = '×';
        btn.addEventListener('click', function () { input.value = ''; input.dispatchEvent(new Event('input')); input.focus(); });
        wrap.insertBefore(btn, wrap.querySelector('.cmpSearchCount'));
      } else if (!has && btn) { btn.remove(); }
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        prefs[prefKey] = input.value || '';
        cmpPrefsSave(prefs);
        syncClearBtn();
        paint();
      }, 120);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; input.dispatchEvent(new Event('input')); }
    });
  }
  /** 全部展开 / 全部收起 */
  function bindExpandAll(btnId, prefKey, paint) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      const wantFold = btn.getAttribute('data-act') === 'fold';
      const groups = prefKey === 'goalCollapsed' ? cmpGroupComponents(goalItems, catsInfo, prefs.goalQ) : cmpGroupComponents(comps, catsInfo, prefs.q);
      prefs[prefKey] = {};
      groups.forEach(function (g) { prefs[prefKey][g.key] = wantFold; });
      cmpPrefsSave(prefs);
      paint();
    });
  }

  /* ---------- 页面骨架 ---------- */
  const globalPanelHTML =
    cmpSearchHTML({ id: 'cmpSearch', value: prefs.q, hit: comps.filter(function (c) { return cmpMatchComponent(c, prefs.q); }).length, total: comps.length }) +
    '<div class="cmpCatToolbar">' +
      '<button type="button" class="btn tiny" id="cmpExpandAll" data-act="expand">▾ 全部展开</button>' +
      '<button type="button" class="btn tiny" id="cmpFoldAll" data-act="fold">▸ 全部收起</button>' +
      '<span class="hint" style="margin-left:auto;">点分类标题可单独展开 / 收起</span>' +
    '</div>' +
    '<div class="cmpCatList" id="cmpCatList"></div>';
  const goalPanelHTML =
    cmpSearchHTML({ id: 'cmpGoalSearch', value: prefs.goalQ, hit: goalItems.filter(function (e) { return cmpMatchComponent(e, prefs.goalQ); }).length, total: goalItems.length }) +
    '<div class="cmpCatToolbar">' +
      '<button type="button" class="btn tiny" id="cmpGoalExpandAll" data-act="expand">▾ 全部展开</button>' +
      '<button type="button" class="btn tiny" id="cmpGoalFoldAll" data-act="fold">▸ 全部收起</button>' +
      '<span class="hint" style="margin-left:auto;">只改本目标；没设置过的仍按全局默认</span>' +
    '</div>' +
    '<div class="cmpCatList" id="cmpGoalCatList"></div>';

  let html = '<div class="page wide cmpPage">' +
    '<div class="pageHead cmpPageHead">' +
      '<button class="back js-back" data-back="#/">← 返回</button>' +
      '<div class="cmpHeadText">' +
        '<h2 class="title" style="margin-left:10px;">🧩 组件</h2>' +
        '<span class="hint cmpHeadHint">功能与界面样式都由组件提供，可自由开关、导入分享</span>' +
      '</div>' +
      '<div class="spacer"></div>' +
      '<button class="btn small" id="cmpReload">↻ 重新加载</button>' +
      '<label class="btn small primary">⬆ 导入组件（可多选）<input type="file" id="cmpImport" accept=".json,application/json" multiple hidden></label>' +
    '</div>' +
    '<div class="cmpPanel cmpPanelScope">' +
      '<div class="cmpScopeRow">' +
        cmpScopePickHTML(scope, scopeGoals) +
      '</div>' +
      '<p class="hint cmpScopeHint">' + (scopeGoal
        ? '正在管理「' + H.esc(scopeGoal.title) + '」：本页的开关只改这个目标，别的目标不受影响。'
        : '全局开关 = 新目标的默认值，也管应用级组件（番茄钟浮窗、笔记面板等）；已经单独设置过的目标不受影响。') + '</p>' +
    '</div>' +
    (scopeGoal
      ? '<div class="cmpPanel">' +
          '<div class="cmpPanelHead">' +
            '<h3 class="cmpPanelTitle">🎯 ' + H.esc(scopeGoal.title) + ' 的组件</h3>' +
            '<span class="chip gray">只改本目标</span>' +
            '<span class="hint cmpPanelHint">这里的开关<b>只写这一个目标</b>，其它目标完全不受影响。</span>' +
          '</div>' +
          goalPanelHTML +
        '</div>'
      : '') +
    (scopeGoal
      ? '<details class="cmpGlobalFold"><summary>🌍 全局组件与分类（下面的开关影响<b>所有</b>目标，别在这里改单个目标）</summary>' +
          '<details class="cmpCatManageFold"><summary>🏷 分类管理（新建 / 重命名 / 删除分类）</summary>' + cmpCatManageHTML(catsInfo) + '</details>' +
          '<div class="cmpPanel"><div class="cmpPanelHead"><h3 class="cmpPanelTitle">🌍 全局组件</h3><span class="chip warn">开关影响所有目标</span></div>' + globalPanelHTML + '</div>' +
          '<details class="cmpShareFold"><summary>📦 分享与开发组件</summary>' + cmpShareHTML() + '</details>' +
        '</details>'
      : '<details class="cmpCatManageFold"><summary>🏷 分类管理（新建 / 重命名 / 删除分类）</summary>' + cmpCatManageHTML(catsInfo) + '</details>' +
        '<div class="cmpPanel"><div class="cmpPanelHead"><h3 class="cmpPanelTitle">🧩 全部组件</h3><span class="hint cmpPanelHint">按分类收起 / 展开，顶部可搜索</span></div>' + globalPanelHTML + '</div>' +
        '<details class="cmpShareFold"><summary>📦 分享与开发组件</summary>' + cmpShareHTML() + '</details>') +
  '</div>';
  H.app.innerHTML = html;

  /* ---------- 首屏与事件 ---------- */
  paintGlobalList();
  if (scopeGoal) paintGoalList();
  if (scopeGoal) {
    bindGoalToggles(document);
    bindSearch('cmpGoalSearch', 'goalQ', paintGoalList);
    bindExpandAll('cmpGoalExpandAll', 'goalCollapsed', paintGoalList);
    bindExpandAll('cmpGoalFoldAll', 'goalCollapsed', paintGoalList);
  }
  bindSearch('cmpSearch', 'q', paintGlobalList);
  bindExpandAll('cmpExpandAll', 'collapsed', paintGlobalList);
  bindExpandAll('cmpFoldAll', 'collapsed', paintGlobalList);

  /* 管理范围：一个按钮 + 可搜索弹层（目标多的时候不用在几十个按钮里找） */
  cmpScopePickBind();

  /* 分类管理：新建 / 重命名 / 删除 */
  const catListEl = document.getElementById('catList');
  if (catListEl) {
    catListEl.querySelectorAll('[data-cat-rename]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const from = b.getAttribute('data-cat-rename');
        const name = prompt('重命名分类：', from);
        if (name == null || !name.trim() || name.trim() === from) return;
        try {
          await H.api('/api/component-categories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: from, name: name.trim() }) });
          H.toast('已重命名');
          await renderComponentsPage();
          H.renderRail();
        } catch (e) { H.toast(e.message); }
      });
    });
    catListEl.querySelectorAll('[data-cat-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const name = b.getAttribute('data-cat-del');
        if (!confirm('删除分类「' + name + '」？该分类下的组件会回到「其它」。')) return;
        try {
          await H.api('/api/component-categories/' + encodeURIComponent(name), { method: 'DELETE' });
          H.toast('已删除分类');
          await renderComponentsPage();
          H.renderRail();
        } catch (e) { H.toast(e.message); }
      });
    });
  }
  const catAddBtn = document.getElementById('catAddBtn');
  if (catAddBtn) catAddBtn.addEventListener('click', async function () {
    const inp = document.getElementById('catNewName');
    const name = (inp && inp.value || '').trim();
    if (!name) return H.toast('请输入分类名');
    try {
      await H.api('/api/component-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
      H.toast('已新建分类「' + name + '」');
      await renderComponentsPage();
      H.renderRail();
      await H.loadComponents();
    } catch (e) { H.toast(e.message); }
  });

  /* 重新加载 / 导入 */
  const reloadBtn = document.getElementById('cmpReload');
  if (reloadBtn) reloadBtn.addEventListener('click', async function () {
    try {
      const res = await H.api('/api/components/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      H.toast('已重新加载 ' + res.loaded + ' 个文件组件');
      await H.loadComponents();
      location.reload();
    } catch (e) { H.toast(e.message); }
  });
  const impInput = document.getElementById('cmpImport');
  if (impInput) impInput.addEventListener('change', async function (e) {
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

  window.scrollTo(0, scrollY);                   // 恢复滚动位置
}

  function mountComponents(host) {
    H = host || {};
    return {
      render: function () { return renderComponentsPage(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['components'] = { id: 'components', mount: mountComponents };
})();
