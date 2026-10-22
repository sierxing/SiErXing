'use strict';
/**
 * 内置 UI 插件 · 主页（#/）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/home/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

function setupCardHTML() {
  const st = H.state.aiStatus || {};
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

function homeLauncherLoad(goals) {
  const byId = {};
  for (const g of (goals || [])) byId[g.id] = g;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved || !Array.isArray(saved.items)) {
    return { items: (goals || []).map(g => ({ type: 'goal', id: g.id, size: HOME_TILE_DEFAULT_SIZE })) };
  }
  const seen = {};
  const items = [];
  for (const raw of saved.items) {
    if (!raw || (raw.type !== 'goal' && raw.type !== 'folder')) continue;
    if (raw.type === 'goal') {
      const gid = Number(raw.id);
      if (!byId[gid] || seen[gid]) continue;
      seen[gid] = 1;
      items.push({ type: 'goal', id: gid, size: homeLauncherSize(raw.size) });
      continue;
    }
    const ids = [];
    for (const rawId of (Array.isArray(raw.goals) ? raw.goals : [])) {
      const gid = Number(rawId);
      if (!byId[gid] || seen[gid] || ids.indexOf(gid) >= 0) continue;
      seen[gid] = 1;
      ids.push(gid);
    }
    if (!ids.length) continue;
    items.push({
      type: 'folder', id: String(raw.id || homeLauncherNewFolderId()),
      name: String(raw.name || '收藏夹').slice(0, 24), size: homeLauncherSize(raw.size), goals: ids
    });
  }
  /* 新增的目标一律排到**最后**：这个页面的顺序完全由用户拖动决定，
     不能因为新建/更新了一个目标就把用户排好的版式冲乱。 */
  const fresh = [];
  for (const g of (goals || [])) if (!seen[g.id]) { seen[g.id] = 1; fresh.push({ type: 'goal', id: g.id, size: HOME_TILE_DEFAULT_SIZE }); }
  const merged = items.concat(fresh);
  /* 只剩一个目标的收藏夹没有存在意义，摊回普通卡片 */
  const flat = [];
  for (const it of merged) {
    if (it.type === 'folder' && it.goals.length === 1) flat.push({ type: 'goal', id: it.goals[0], size: it.size });
    else flat.push(it);
  }
  return { items: flat };
}

function homeLauncherRecentHTML(goals) {
  const byId = {};
  for (const g of (goals || [])) byId[g.id] = g;
  const ids = homeRecentRead().filter(id => byId[id]).slice(0, HOME_RECENT_SHOW);
  if (!ids.length) return '';
  const cards = ids.map(gid => {
    const g = byId[gid];
    const st = homeLauncherStatus(g);
    const pct = g.tasks_total ? Math.round((g.tasks_done || 0) / g.tasks_total * 100) : 0;
    return `<button type="button" class="hrCard" data-go="#/g/${g.id}" title="继续「${H.esc(g.title)}」">
      <span class="hrTop"><span class="hrIcon">🎯</span><span class="hrTitle">${H.esc(g.title)}</span></span>
      <span class="hrBarRow"><span class="bar"><span class="barFill" style="width:${pct}%"></span></span><span class="hrPct">${pct}%</span></span>
      <span class="hrFoot"><span class="chip ${st[1]}">${st[0]}</span><span class="hrMeta">${g.tasks_done || 0}/${g.tasks_total || 0} 任务</span></span>
    </button>`;
  }).join('');
  return `<div class="homeRecent" id="homeRecent">
    <div class="homeSectionHead">
      <span class="hsTitle">🕘 最近目标</span>
      <span class="hsSub">最近打开过的，点一下直接继续</span>
    </div>
    <div class="homeRecentRow">${cards}</div>
  </div>`;
}

/* 整块桌面：标题（所有目标）+ 工具栏（批量大小 / 恢复默认）+ 网格 */
function homeLauncherDeskHTML(goals, layout) {
  const byId = {};
  for (const g of goals) byId[g.id] = g;
  const folderCount = layout.items.filter(it => it.type === 'folder').length;
  return `<div class="homeDesk" id="homeDesk">
    <div class="homeSectionHead">
      <span class="hsTitle">🎯 所有目标</span>
      <span class="hsSub">顺序由你决定：拖到哪，它就是第几个</span>
    </div>
    <div class="homeDeskBar">
      <div class="hdHint">🖐 <b>拖住卡片</b>：拖到想放的位置松手 = 排序；拖到另一张卡片上会出现「📁 收进收藏夹」，松在它上面 = 融合</div>
      <div class="spacer"></div>
      <span class="hdSegLabel" title="批量设置所有卡片的大小；单张卡片在右上角 ⋯ 里单独调">全部大小</span>
      <div class="hdSeg" id="homeSizeSeg" role="group" aria-label="全部卡片大小">
        ${HOME_TILE_SIZES.map(s => `<button type="button" class="hdSegBtn" data-home-size-all="${s}" title="${HOME_SIZE_DESC[s]}">${HOME_SIZE_NAME[s]}</button>`).join('')}
      </div>
      <button class="btn tiny" type="button" id="homeLayoutReset" title="清空收藏夹与大小设置，恢复默认卡片列表">${folderCount ? '恢复默认' : '重置布局'}</button>
    </div>
    <div class="homeDeskGrid" id="homeDeskGrid">
      ${layout.items.map(it => it.type === 'folder' ? homeLauncherFolderHTML(it, byId) : homeLauncherGoalHTML(byId[it.id], it.size)).join('')}
    </div>
  </div>`;
}

/* ---------- 桌面交互：点击 / 菜单 / 长按拖拽 ---------- */
function bindHomeLauncher(layout, byId) {
  const grid = document.getElementById('homeDeskGrid');
  if (!grid) return;
  const seg = document.getElementById('homeSizeSeg');
  if (seg) seg.querySelectorAll('[data-home-size-all]').forEach(btn => btn.addEventListener('click', () => {
    const size = btn.getAttribute('data-home-size-all');
    if (HOME_TILE_SIZES.indexOf(size) < 0) return;
    layout.items.forEach(it => { it.size = size; });
    homeLauncherSave(layout);
    H.toast('已把所有卡片设为「' + HOME_SIZE_NAME[size] + '」');
    renderHome();
  }));
  const reset = document.getElementById('homeLayoutReset');
  if (reset) reset.addEventListener('click', () => {
    if (!confirm('恢复默认布局？收藏夹会解散，所有卡片回到默认大小。')) return;
    try { localStorage.removeItem(HOME_LAYOUT_KEY); } catch (e) {}
    H.toast('已恢复默认布局');
    renderHome();
  });

  /* 点卡片：目标 → 进入执行页；收藏夹 → 打开弹层 */
  grid.addEventListener('click', e => {
    const more = e.target.closest('[data-tile-more]');
    if (more) { e.preventDefault(); e.stopPropagation(); homeLauncherOpenMenu(more, layout, byId); return; }
    if (Date.now() < homeLauncherNoClickUntil) return;
    const tile = e.target.closest('[data-tile-key]');
    if (!tile || !grid.contains(tile)) return;
    const it = homeLauncherFind(layout, tile.getAttribute('data-tile-key'));
    if (!it) return;
    if (it.type === 'folder') { homeLauncherOpenFolder(layout, it, byId); return; }
    H.go('#/g/' + it.id);
  });
  grid.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tile = e.target.closest('[data-tile-key]');
    if (!tile) return;
    e.preventDefault();
    tile.click();
  });
  /* 右键 / 手机长按（contextmenu）也打开卡片设置；正在拖动时不弹（手机长按会先触发拖拽） */
  grid.addEventListener('contextmenu', e => {
    if (homeLauncherDrag) { e.preventDefault(); return; }
    const tile = e.target.closest('[data-tile-key]');
    if (!tile) return;
    e.preventDefault();
    const more = tile.querySelector('[data-tile-more]');
    if (more) homeLauncherOpenMenu(more, layout, byId);
  });
  /* 长按 300ms 才进入拖拽（普通点击 / 滚动不受影响） */
  grid.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!e.isPrimary) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    const tile = e.target.closest('[data-tile-key]');
    if (!tile || !grid.contains(tile)) return;
    homeLauncherBeginPress(e, tile, grid, layout);
  });
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
    H.toast('已批量选择「' + cat + '」下的 ' + n + ' 个组件');
  });
  const clearBtn = document.getElementById('ppClear');
  if (clearBtn) clearBtn.addEventListener('click', () => { chips.forEach(c => c.querySelector('input').checked = false); paint(); });
  paint();
  applyFilter();
}

async function startCollect(id) {
  if (!H.goalCompOn(goalCtx(), 'sources')) { H.toast('「信息源检索」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
  if (collectingAt(id)) return;
  if (!(await ensureCollectSetup(id))) return;   // 搜集前确认搜什么+要不要电子书（取消则不搜集）
  const job = { status: '正在检索…', abort: new AbortController() };
  H.state.collectJobs[id] = job;
  if (isGoalCurrent(id)) H.renderGoal();
  try {
    const resp = await fetch('/api/goals/' + id + '/collect', { method: 'POST', signal: job.abort.signal });
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
        if (d.status_code) {
          const t = searchFallbackStatusText(d.status_detail);
          job.status = t;
          /* 只有用户正在看这个目标时才改 DOM：否则会把另一个目标的进度条内容改掉 */
          if (isGoalCurrent(id)) { const el = document.getElementById('spStatus'); if (el) el.textContent = t; }
        } else if (d.status) {
          job.status = d.status;
          if (isGoalCurrent(id)) { const el = document.getElementById('spStatus'); if (el) el.textContent = d.status; }
        }
        if (d.done) {
          done = true;
          if (isGoalCurrent(id)) H.state.sources = d.sources || [];
          const st = d.stats || null;
          const fun = st
            ? '（搜到 ' + st.searched + ' 条 → 进审 ' + st.toReview + ' 条 → 入库 ' + st.saved + ' 条'
              + (st.aiDrop ? '，AI 判为不合格 ' + st.aiDrop + ' 条' : '')
              + (st.fullGot ? '，补抓全文 ' + st.fullGot + ' 条' : '') + '）'
            : '';
          const fbNote = st && st.searchFallback ? tr('（搜索 API 不可用，本次用内置搜索）') : '';
          H.toast('信息源收集完成：' + d.count + ' 条' + fun + fbNote + (d.ebooks ? '；' + d.ebooks : '') + (d.blocked ? '（百度限流，本次用备用搜索，可稍后重新收集以获取更多）' : ''));
        }
        if (d.error) { done = true; H.toast(d.error); }
      }
    }
    if (!done) H.toast('信息源收集中断，可重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') H.toast(e.message);
  } finally {
    if (H.state.collectJobs && H.state.collectJobs[id] === job) delete H.state.collectJobs[id];
    if (isGoalCurrent(id) && onGoalPage(id)) {
      try { await H.loadGoal(id); } catch (e) {}
      if (onGoalPage(id)) H.renderGoal();
      // 收集完成后若这个目标还没有路径，自动开始规划（只在这个目标页上做，别在别的页面突然开始规划）
      if (onGoalPage(id) && H.state.goal && Number(H.state.goal.id) === Number(id) && !H.state.goal.nodes.length && !H.state.planning) {
        startPlanning(id);
      }
    }
  }
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
        <div class="ppCats">${cats.map((c, i) => `<button type="button" class="ppCat ${i === 0 ? 'active' : ''}" data-cat="${H.esc(c)}">${H.esc(c)}<span class="ppCatN">${c === '全部' ? list.length : (catCount[c] || 0)}</span></button>`).join('')}</div>
        <div class="spacer"></div>
        <span class="ppCount" id="ppCount"></span>
        <button type="button" class="btn tiny" id="ppAllFiltered">全选当前结果</button>
        <button type="button" class="btn tiny primary" id="ppAllCat" title="把当前分类下的组件全部勾选（批量选择）">批量选择本类</button>
        <button type="button" class="btn tiny" id="ppClear">清空</button>
      </div>
      <div class="ppGrid" id="ppGrid">
        ${list.map(p => `<label class="ppChip" data-id="${H.esc(p.id)}" data-cat="${H.esc(p.category || '其它')}"
            data-key="${H.esc((p.name + ' ' + (p.desc || '') + ' ' + (p.category || '')).toLowerCase())}"
            data-desc="${H.esc(p.desc || '')}" title="${H.esc(p.desc || '')}">
          <input type="checkbox" data-plugin-check="${H.esc(p.id)}" ${p.defaultEnabled ? 'checked' : ''}>
          <span class="ppcIcon">${p.icon}</span>
          <span class="ppcName">${H.esc(p.name)}</span>
          <span class="ppcTick">✓</span>
        </label>`).join('')}
      </div>
      <div class="ppTip" id="ppTip">把鼠标移到组件上可以看到说明；没有需要的？去左侧栏「🧩 组件」页导入或自己写一个。</div>
    </div>
  </div>`;
}

const HOME_LAYOUT_KEY = 'sierxing-home-layout-v1';

const HOME_TILE_DEFAULT_SIZE = 'm';

function homeLauncherSize(v) {
  return HOME_TILE_SIZES.indexOf(v) >= 0 ? v : HOME_TILE_DEFAULT_SIZE;
}

function homeLauncherNewFolderId() {
  return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function homeRecentRead() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem(HOME_RECENT_KEY) || '[]'); } catch (e) { ids = []; }
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!id || !isFinite(id) || out.indexOf(id) >= 0) continue;
    out.push(id);
  }
  return out.slice(0, HOME_RECENT_MAX);
}

const HOME_RECENT_SHOW = 8;

function homeLauncherStatus(g) {
  const statusMap = {
    draft: ['待规划', 'warn'], planning: ['规划中', ''], review: ['骨架待确认', 'warn'],
    planned: ['已规划', 'ok'], failed: ['规划失败', 'danger']
  };
  return statusMap[g.status] || ['未知', 'gray'];
}

const HOME_TILE_SIZES = ['s', 'm', 'l'];

const HOME_SIZE_DESC = { s: '只显示标题与进度', m: '简介 + 进度 + 关键信息', l: '全部信息（下一步 / 更新时间等）' };

const HOME_SIZE_NAME = { s: '小', m: '中', l: '大' };

function homeLauncherFolderHTML(f, byId) {
  const ids = f.goals || [];
  return `<div class="homeTile homeTile-folder homeTile-${f.size}" data-tile-key="folder:${H.esc(f.id)}" data-tile-type="folder" data-size="${f.size}" tabindex="0" role="button" aria-label="收藏夹 ${H.esc(f.name)}">
    <div class="htHead">
      <span class="htIcon htFolderIcon">📁</span>
      <span class="htTitle">${H.esc(f.name)}</span>
      <span class="htCount">${ids.length}</span>
      <button class="htMore" type="button" data-tile-more="folder:${H.esc(f.id)}" data-morebtn="homeTile" title="收藏夹设置">⋯</button>
    </div>
    <div class="htFolderMini">${homeLauncherFolderMiniHTML(f, byId)}</div>
    ${f.size === 'l' ? `<div class="htFolderFoot">点开查看全部 ${ids.length} 个目标</div>` : ''}
  </div>`;
}

/* ---------- 卡片渲染（小 / 中 / 大三档，信息量递增） ---------- */
function homeLauncherGoalHTML(g, size) {
  if (!g) return '';
  const st = homeLauncherStatus(g);
  const pct = g.tasks_total ? Math.round((g.tasks_done || 0) / g.tasks_total * 100) : 0;
  const updated = g.updated_at ? String(g.updated_at).slice(0, 10) : '';
  const head = `<div class="htHead">
      <span class="htIcon">🎯</span>
      <span class="htTitle">${H.esc(g.title)}</span>
      ${size === 's' ? `<span class="htDot ${st[1]}" title="${st[0]}"></span>` : `<span class="chip ${st[1]}">${st[0]}</span>`}
      <button class="htMore" type="button" data-tile-more="goal:${g.id}" data-morebtn="homeTile" title="卡片设置：大小 / 组件">⋯</button>
    </div>`;
  let body = '';
  if (size === 's') {
    body = `<div class="htSmallFoot"><span class="htMiniBar"><i style="width:${pct}%"></i></span><span class="htPct">${pct}%</span></div>`;
  } else if (size === 'm') {
    body = `${g.summary ? `<div class="htSummary">${H.mdOneLine(g.summary)}</div>` : '<div class="htSummary muted">尚未生成规划</div>'}
      <div class="htProgress"><div class="bar"><div class="barFill" style="width:${pct}%"></div></div><span class="htPct">${pct}%</span></div>
      <div class="htMeta">
        ${g.weekly_hours ? `<span class="chip gray">每周 ${H.esc(g.weekly_hours)}</span>` : ''}
        ${g.deadline ? `<span class="chip gray">期限 ${H.esc(g.deadline)}</span>` : ''}
        <span class="chip gray">${g.tasks_done || 0}/${g.tasks_total || 0} 任务</span>
      </div>`;
  } else {
    body = `${g.summary ? `<div class="htSummary">${H.mdOneLine(g.summary)}</div>` : '<div class="htSummary muted">尚未生成规划</div>'}
      ${g.next_task ? `<div class="gcNext">▸ 下一步：${H.esc(g.next_task)}</div>` : ''}
      <div class="htProgress"><div class="bar"><div class="barFill" style="width:${pct}%"></div></div><span class="htPct">${pct}%</span></div>
      <div class="htMeta">
        ${g.weekly_hours ? `<span class="chip gray">每周 ${H.esc(g.weekly_hours)}</span>` : ''}
        ${g.deadline ? `<span class="chip gray">期限 ${H.esc(g.deadline)}</span>` : ''}
        <span class="chip gray">${g.tasks_done || 0}/${g.tasks_total || 0} 任务</span>
        ${updated ? `<span class="gcDate">更新于 ${updated}</span>` : ''}
      </div>`;
  }
  return `<div class="homeTile homeTile-${size}" data-tile-key="goal:${g.id}" data-tile-type="goal" data-size="${size}" tabindex="0" role="button" aria-label="${H.esc(g.title)}">${head}${body}</div>`;
}

function homeLauncherSave(layout) {
  try {
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify({
      v: 1,
      items: layout.items.map(it => it.type === 'folder'
        ? { type: 'folder', id: it.id, name: it.name, size: it.size, goals: it.goals.slice() }
        : { type: 'goal', id: it.id, size: it.size })
    }));
  } catch (e) { /* 隐私模式写不进去也不影响本次使用 */ }
}

function homeLauncherOpenMenu(anchor, layout, byId) {
  document.querySelectorAll('.homeTileMenu').forEach(m => m.remove());
  const it = homeLauncherFind(layout, anchor.getAttribute('data-tile-more'));
  if (!it) return;
  const goal = it.type === 'goal' ? byId[it.id] : null;
  const title = it.type === 'folder' ? it.name : ((goal && goal.title) || '目标');
  const m = document.createElement('div');
  m.className = 'ctxMenu homeTileMenu';
  m.innerHTML = `<div class="ctxTitle">${H.esc(title)}</div>
    <div class="htMenuLabel">卡片大小</div>
    ${HOME_TILE_SIZES.map(s => `<button type="button" class="htMenuSize${it.size === s ? ' on' : ''}" data-hm-size="${s}"><span class="htMenuSizeName">${HOME_SIZE_NAME[s]}</span><em>${HOME_SIZE_DESC[s]}</em>${it.size === s ? '<span class="htMenuTick">✓</span>' : ''}</button>`).join('')}
    <div class="ctxSep"></div>
    ${it.type === 'folder'
      ? `<button type="button" data-hm-open>📂 打开收藏夹</button><button type="button" data-hm-rename>✏ 重命名收藏夹</button><button type="button" class="danger" data-hm-dissolve>↩ 解散收藏夹（目标回到桌面）</button>`
      : `<button type="button" data-hm-comps>🧩 管理本目标的组件</button>`}
  `;
  const r = anchor.getBoundingClientRect();
  m.style.left = '0px'; m.style.top = '0px'; m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const mw = m.offsetWidth || 250, mh = m.offsetHeight || 260;
  let left = r.left + r.width - mw;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.visibility = '';
  const closeMenu = () => { try { m.remove(); } catch (e) {} };
  m.querySelectorAll('[data-hm-size]').forEach(btn => btn.addEventListener('click', () => {
    it.size = homeLauncherSize(btn.getAttribute('data-hm-size'));
    homeLauncherSave(layout);
    closeMenu();
    H.toast('已设为「' + HOME_SIZE_NAME[it.size] + '」');
    renderHome();
  }));
  const openBtn = m.querySelector('[data-hm-open]');
  if (openBtn) openBtn.addEventListener('click', () => { closeMenu(); homeLauncherOpenFolder(layout, it, byId); });
  const renameBtn = m.querySelector('[data-hm-rename]');
  if (renameBtn) renameBtn.addEventListener('click', () => {
    closeMenu();
    const name = prompt('收藏夹名称（最多 24 字）', it.name);
    if (name == null) return;
    it.name = String(name).trim().slice(0, 24) || '收藏夹';
    homeLauncherSave(layout);
    renderHome();
  });
  const dissolveBtn = m.querySelector('[data-hm-dissolve]');
  if (dissolveBtn) dissolveBtn.addEventListener('click', () => { closeMenu(); homeLauncherDissolveFolder(layout, it); });
  const compsBtn = m.querySelector('[data-hm-comps]');
  if (compsBtn) compsBtn.addEventListener('click', () => { closeMenu(); showGoalPluginsMenu(it.id, anchor); });
}

/* 拖拽刚结束时浏览器还会补一个 click，用它压掉（避免一松手就跳进目标页） */
let homeLauncherNoClickUntil = 0;

function homeLauncherFind(layout, key) {
  if (!layout || !key) return null;
  for (const it of layout.items) {
    if (it.type + ':' + it.id === key) return it;
  }
  return null;
}

function homeLauncherOpenFolder(layout, folder, byId) {
  homeLauncherCloseFolder();
  homeFolderDirty = false;
  const mask = document.createElement('div');
  mask.className = 'homeFolderMask';
  mask.innerHTML = `<div class="homeFolderPanel" role="dialog" aria-label="收藏夹 ${H.esc(folder.name)}">
    <div class="homeFolderHead">
      <span class="hfIcon">📁</span>
      <span class="hfTitle">${H.esc(folder.name)}</span>
      <span class="chip gray hfCount">${folder.goals.length} 个目标</span>
      <div class="spacer"></div>
      <button class="btn tiny" type="button" data-hf-rename>重命名</button>
      <button class="btn tiny danger" type="button" data-hf-dissolve>解散收藏夹</button>
      <button class="btn tiny" type="button" data-hf-close title="关闭（Esc）">✕</button>
    </div>
    <div class="homeFolderBody"><div class="homeFolderGrid" id="homeFolderGrid"></div></div>
    <div class="homeFolderTip">拖住卡片可调整顺序 · 右键卡片可移出收藏夹 · 单击卡片进入执行页</div>
  </div>`;
  document.body.appendChild(mask);
  homeFolderDialog = mask;
  const grid = mask.querySelector('#homeFolderGrid');

  /* keepHome=true 时（点卡片进目标页 / 路由变化）不重画首页 —— 路由自己会渲染。 */
  const close = opts => {
    const dirty = homeFolderDirty;
    homeFolderDirty = false;
    homeLauncherCloseFolder();
    if (dirty && !(opts && opts.keepHome)) renderHome();
  };
  const openGoal = gid => { close({ keepHome: true }); H.go('#/g/' + gid); };

  /* 移出收藏夹：目标回到桌面（紧挨着收藏夹的位置）。
     只剩 1 个目标的收藏夹没有存在意义（渲染时也会被摊平），所以直接连剩下的目标一起摊回桌面。 */
  const eject = gid => {
    const idx = folder.goals.indexOf(gid);
    if (idx < 0) return;
    const pos = layout.items.indexOf(folder);
    folder.goals.splice(idx, 1);
    homeFolderDirty = true;
    if (folder.goals.length <= 1) {
      const back = [{ type: 'goal', id: gid, size: HOME_TILE_DEFAULT_SIZE }]
        .concat(folder.goals.map(x => ({ type: 'goal', id: x, size: HOME_TILE_DEFAULT_SIZE })));
      if (pos >= 0) layout.items.splice.apply(layout.items, [pos, 1].concat(back));
      homeLauncherSave(layout);
      H.toast('已移出收藏夹');
      close();
      return;
    }
    if (pos >= 0) layout.items.splice(pos + 1, 0, { type: 'goal', id: gid, size: HOME_TILE_DEFAULT_SIZE });
    homeLauncherSave(layout);
    H.toast('已移出收藏夹');
    paint();
  };

  let drag = null;   // 弹层内拖拽状态

  function paint() {
    grid.innerHTML = folder.goals.length
      ? folder.goals.map(gid => homeLauncherFolderCardHTML(byId[gid])).join('')
      : '<div class="muted">收藏夹是空的</div>';
    const cnt = mask.querySelector('.hfCount');
    if (cnt) cnt.textContent = folder.goals.length + ' 个目标';
    bindCards();
  }

  function bindCards() {
    grid.querySelectorAll('[data-hf-goal]').forEach(card => {
      card.addEventListener('click', e => {
        if (Date.now() < homeLauncherNoClickUntil) return;
        if (e.target.closest('button')) return;
        const gid = Number(card.getAttribute('data-hf-goal'));
        if (gid) openGoal(gid);
      });
      card.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const gid = Number(card.getAttribute('data-hf-goal'));
        if (gid) openGoal(gid);
      });
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        const gid = Number(card.getAttribute('data-hf-goal'));
        if (!gid) return;
        homeLauncherFolderMenu(e, byId[gid],
          () => openGoal(gid),
          () => eject(gid));
      });
      card.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!e.isPrimary) return;
        if (e.target.closest('button, a, input, select, textarea')) return;
        beginPress(e, card);
      });
    });
    grid.querySelectorAll('[data-hf-remove]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      eject(Number(btn.getAttribute('data-hf-remove')));
    }));
  }

  /* ---- 弹层内的拖动排序（鼠标一动就拖；触摸先长按 300ms） ---- */
  function beginPress(e, card) {
    abortDrag();
    const isMouse = (e.pointerType || 'mouse') === 'mouse';
    const d = {
      phase: 'pending', card: card, isMouse: isMouse,
      startX: e.clientX, startY: e.clientY, offsetX: 0, offsetY: 0,
      ghost: null, timer: null, insert: -1
    };
    d.onMove = ev => {
      if (d.phase === 'pending') {
        const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY;
        const dist2 = dx * dx + dy * dy;
        if (d.isMouse) { if (dist2 > 25) startDrag(d); return; }
        if (dist2 > 100) abortDrag();
        return;
      }
      moveDrag(d, ev);
    };
    d.onUp = () => { if (d.phase === 'dragging') dropDrag(d); else abortDrag(); };
    d.onCancel = () => abortDrag();
    d.onKey = ev => { if (ev.key === 'Escape') abortDrag(); };
    d.onTouch = ev => { if (d.phase === 'dragging' && ev.cancelable) ev.preventDefault(); };
    drag = d;
    document.addEventListener('pointermove', d.onMove, { passive: true });
    document.addEventListener('pointerup', d.onUp);
    document.addEventListener('pointercancel', d.onCancel);
    document.addEventListener('keydown', d.onKey);
    if (!isMouse) d.timer = setTimeout(() => startDrag(d), 300);
  }

  function startDrag(d) {
    if (!d || d.phase !== 'pending' || !d.card || !d.card.isConnected) { abortDrag(); return; }
    d.phase = 'dragging';
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    const rect = d.card.getBoundingClientRect();
    d.offsetX = Math.max(0, Math.min(rect.width, d.startX - rect.left));
    d.offsetY = Math.max(0, Math.min(rect.height, d.startY - rect.top));
    const ghost = d.card.cloneNode(true);
    ghost.className = d.card.className + ' hfcGhost';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = (d.startX - d.offsetX) + 'px';
    ghost.style.top = (d.startY - d.offsetY) + 'px';
    ghost.removeAttribute('tabindex');
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.card.classList.add('hfcDragging');
    grid.classList.add('hfDragGrid');
    document.body.classList.add('htDraggingBody');
    document.addEventListener('touchmove', d.onTouch, { passive: false });
    homeLauncherNoClickUntil = Date.now() + 400;
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
  }

  function moveDrag(d, ev) {
    if (!d.ghost) return;
    d.ghost.style.left = (ev.clientX - d.offsetX) + 'px';
    d.ghost.style.top = (ev.clientY - d.offsetY) + 'px';
    hitTest(d, ev.clientX, ev.clientY);
  }

  /* 插入位置：优先按“指针压在哪张卡上 + 左半/右半”，否则按行扫描空隙 */
  function hitTest(d, x, y) {
    const cards = Array.prototype.slice.call(grid.querySelectorAll('[data-hf-goal]'));
    cards.forEach(c => c.classList.remove('hfcDropBefore', 'hfcDropAfter'));
    const rest = cards.filter(c => c !== d.card);
    const hit = document.elementFromPoint(x, y);
    const over = hit && hit.closest ? hit.closest('[data-hf-goal]') : null;
    const pick = over && over !== d.card && grid.contains(over) ? over : null;
    let idx = rest.length;
    if (pick) {
      const r = pick.getBoundingClientRect();
      const i = rest.indexOf(pick);
      idx = x < r.left + r.width / 2 ? i : i + 1;
    } else {
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i].getBoundingClientRect();
        const pad = Math.min(8, r.height / 4);
        if (y > r.bottom - pad) continue;
        if (y < r.top + pad) { idx = i; break; }
        if (x > r.left + r.width / 2) continue;
        idx = i; break;
      }
    }
    d.insert = idx;
    if (idx < rest.length) rest[idx].classList.add('hfcDropBefore');
    else if (rest.length) rest[rest.length - 1].classList.add('hfcDropAfter');
  }

  function dropDrag(d) {
    const insert = d.insert;
    const card = d.card;
    abortDrag();
    const gid = Number(card && card.getAttribute('data-hf-goal'));
    const from = folder.goals.indexOf(gid);
    if (from < 0) { paint(); return; }
    if (insert >= 0) {
      const rest = folder.goals.filter(x => x !== gid);
      const idx = Math.max(0, Math.min(insert, rest.length));
      if (idx !== from) {
        rest.splice(idx, 0, gid);
        folder.goals = rest;
        homeFolderDirty = true;
        homeLauncherSave(layout);
      }
    }
    paint();
    H.toast('顺序已保存');
  }

  function abortDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.timer) { try { clearTimeout(d.timer); } catch (e) {} d.timer = null; }
    document.removeEventListener('pointermove', d.onMove, { passive: true });
    document.removeEventListener('pointerup', d.onUp);
    document.removeEventListener('pointercancel', d.onCancel);
    document.removeEventListener('keydown', d.onKey);
    document.removeEventListener('touchmove', d.onTouch, { passive: false });
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.card) d.card.classList.remove('hfcDragging');
    if (grid) {
      grid.classList.remove('hfDragGrid');
      grid.querySelectorAll('.hfcDropBefore, .hfcDropAfter').forEach(c => c.classList.remove('hfcDropBefore', 'hfcDropAfter'));
    }
    document.body.classList.remove('htDraggingBody');
    if (d.phase === 'dragging') homeLauncherNoClickUntil = Date.now() + 350;
  }
  homeFolderCancelDrag = abortDrag;

  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  mask.querySelector('[data-hf-close]').addEventListener('click', () => close());
  mask.querySelector('[data-hf-rename]').addEventListener('click', () => {
    const name = prompt('收藏夹名称（最多 24 字）', folder.name);
    if (name == null) return;
    folder.name = String(name).trim().slice(0, 24) || '收藏夹';
    homeLauncherSave(layout);
    homeFolderDirty = true;
    const titleEl = mask.querySelector('.hfTitle');
    if (titleEl) titleEl.textContent = folder.name;
    H.toast('已重命名');
  });
  mask.querySelector('[data-hf-dissolve]').addEventListener('click', () => {
    close({ keepHome: true });
    homeLauncherDissolveFolder(layout, folder);
  });
  homeFolderDialogOnKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', homeFolderDialogOnKey);
  homeFolderDialogOnHash = () => close({ keepHome: true });
  window.addEventListener('hashchange', homeFolderDialogOnHash);
  paint();
}

let homeLauncherDrag = null;

/* ---------- 拖拽：拖到哪就是第几个；松在「📁 收进收藏夹」上 = 收进收藏夹 ---------- */
function homeLauncherBeginPress(e, tile, grid, layout) {
  homeLauncherAbortDrag();
  /* 鼠标（精确指针）：按下后**一动就拖**，不需要先按住 —— 桌面用户习惯「拖住就走」。
     触摸 / 手写笔：先等 300ms 长按，否则会和「上下滑动页面」抢手势（手机上手指一滑
     就起拖会让页面根本滚不动）。这两种设备语义不同，别合并成一套。 */
  const isMouse = (e.pointerType || 'mouse') === 'mouse';
  const d = {
    phase: 'pending', tile: tile, grid: grid, layout: layout, isMouse: isMouse,
    key: tile.getAttribute('data-tile-key'),
    startX: e.clientX, startY: e.clientY,
    offsetX: 0, offsetY: 0, ghost: null, timer: null,
    overKey: '', insert: -1, chipText: ''
  };
  d.onMove = ev => {
    if (d.phase === 'pending') {
      const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY;
      const dist2 = dx * dx + dy * dy;
      if (d.isMouse) {
        /* 5px 以内算「点击时的轻微抖动」，超过就进入拖拽（不用长按） */
        if (dist2 > 25) homeLauncherStartDrag(d);
        return;
      }
      if (dist2 > 100) homeLauncherAbortDrag();
      return;
    }
    homeLauncherDragMove(d, ev);
  };
  d.onUp = ev => {
    if (d.phase === 'dragging') homeLauncherDragDrop(d, ev);
    else homeLauncherAbortDrag();
  };
  d.onCancel = () => homeLauncherAbortDrag();
  d.onKey = ev => { if (ev.key === 'Escape') homeLauncherAbortDrag(); };
  d.onTouch = ev => { if (d.phase === 'dragging' && ev.cancelable) ev.preventDefault(); };
  d.onHash = () => homeLauncherAbortDrag();
  homeLauncherDrag = d;
  document.addEventListener('pointermove', d.onMove, { passive: true });
  document.addEventListener('pointerup', d.onUp);
  document.addEventListener('pointercancel', d.onCancel);
  document.addEventListener('keydown', d.onKey);
  window.addEventListener('hashchange', d.onHash);
  if (!isMouse) d.timer = setTimeout(() => homeLauncherStartDrag(d), 300);
}

/* 当前语境目标：教程页用教程所属目标（state.tutGoal），其它用 state.goal */
function goalCtx() {
  try {
    if (H.parseRoute().view === 'tutorial' && H.state.tutGoal && H.state.tutGoal.id) return H.state.tutGoal;
  } catch (e) {}
  return H.state.goal;
}

function collectingAt(gid) { return !!collectJobOf(gid); }

async function ensureCollectSetup(id, editOnly) {
  let plan = null, pref = null;
  let csGate = { review: true, min: 3, cap: 220, perSite: 12, full: true, fullMax: 60000 };
  try {
    const [a, b, cfg] = await Promise.all([
      H.api('/api/goals/' + id + '/collect-plan').catch(() => ({})),
      H.api('/api/goals/' + id + '/ebooks/pref').catch(() => ({})),
      H.api('/api/settings').catch(() => ({}))
    ]);
    plan = a.plan || null; pref = b.pref || null;
    csGate = {
      review: String(cfg.collect_review == null ? '1' : cfg.collect_review) !== '0',
      min: Number(cfg.collect_min_score == null ? 3 : cfg.collect_min_score) || 3,
      cap: Number(cfg.collect_candidates || 220) || 220,
      perSite: Number(cfg.collect_per_site || 12) || 12,
      full: String(cfg.collect_full == null ? '1' : cfg.collect_full) !== '0',
      fullMax: Number(cfg.collect_full_max || 60000) || 60000
    };
  } catch (e) { return true; }
  if (!editOnly && plan && plan.asked && pref && pref.asked) return true;
  H.toast('AI 正在按目标制定搜集方案…');
  /* 弹窗先出来，AI 推荐在后台补进去：以前是"等两个 AI 请求（10~30 秒）都回来才弹窗"，
     中间只有一个 3 秒就消失的 toast，用户看到的就是"点了没反应"。 */
  return showCollectSetupDialog(id, {
    queries: (plan && plan.queries) || [],
    books: (pref && pref.books) || [],
    pref,
    editOnly: !!editOnly,
    csGate,
    auto: { plan: !(plan && plan.asked), books: !(pref && pref.asked) }
  });
}

/* 当前 state.goal 是不是这个目标（决定能不能改 state / DOM，防止后台任务把别的目标页改花） */
function isGoalCurrent(gid) { return !!(H.state.goal && Number(H.state.goal.id) === Number(gid)); }

/* 搜集进度里「搜索 API 失败回落」的进度文案（服务端只回 code） */
function searchFallbackStatusText(code) {
  if (code === 'no_endpoint') return tr('搜索 API 地址为空，本次回落到内置搜索…');
  if (code === 'timeout') return tr('搜索 API 超时，本次回落到内置搜索…');
  if (code === 'network') return tr('连不上搜索 API，本次回落到内置搜索…');
  if (code === 'builtin_error') return tr('内置搜索失败，本次没有关键字结果…');
  return tr('搜索 API 调用失败（{0}），本次回落到内置搜索…', code || 'error');
}

/* 路由是不是正停在这个目标的目标页（长任务收尾只重画它自己那一页） */
function onGoalPage(gid) {
  try { const rr = H.parseRoute(); return rr.view === 'goal' && Number(rr.id) === Number(gid); } catch (e) { return false; }
}

async function startPlanning(id, answers) {
  /* 只看「这个目标」自己的长任务；别的目标在跑不该拦住这里的规划（用户反馈：搜集/AI 任务串目标） */
  if (planBusyFor(id) || collectingAt(id) || digestingAt(id) || expandBusyFor(id)) return;
  if (H.state.planning) { H.taskBusyElsewhereToast(); return; }
  H.state.planning = true;
  H.state.planGoalId = id;
  H.state.planAbort = new AbortController();
  H.state.planProgress = null;
  H.state.planStage = 'skeleton';
  H.state.planStatus = answers ? '正在结合你的回答生成路径骨架…' : '正在生成路径骨架（阶段与小目标）…';
  H.state.planHint = '骨架生成约需 30-90 秒，生成后可确认或提意见。';
  H.state.showEdit = false;
  if (!H.state.goal || H.state.goal.id !== id) await H.loadGoal(id);
  H.state.goal.status = 'planning';
  H.rerenderCurrent();
  bindPlanningPanel();
  let asked = null;
  const r = await streamSSE('/api/goals/' + id + '/plan', answers ? { answers } : {}, d => {
    if (d.status) { H.state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { H.state.planProgress = d.progress; renderPlanLive(); }
    if (d.questions) asked = { stage: d.stage || 'plan', feedback: d.feedback || '', data: d.questions };
  }, H.state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  H.state.planning = false;
  H.state.planGoalId = 0;
  if (asked) {
    H.state.pendingAsk = Object.assign({ goalId: id }, asked);
    H.toast('AI 想先确认几个问题，回答后继续规划');
    try { await H.loadGoal(id); } catch (e) {}
  } else if (r.error || !r.done) {
    H.toast(r.error || '骨架生成中断，可重试');
    try { await H.loadGoal(id); } catch (e) {}
    await planResumeCheck(id);
  } else {
    H.state.planResumeInfo = null;
    H.state.goal = r.data.goal;
    if (r.data.report) H.state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id };
    H.toast('骨架已生成，请确认或提意见');
  }
  const rr = H.parseRoute();
  if (rr.view === 'goal' && rr.id === id) H.renderGoal();
  else if (rr.view === 'map' && rr.id === id) H.renderMapPage();
}

const HOME_RECENT_KEY = 'sierxing-home-recent-v1';

const HOME_RECENT_MAX = 12;          // 最多记 12 条，顶部只展示最近 8 个

/* 收藏夹卡片里的小图标网格（s 露 4 个 / m 露 6 个 / l 露 9 个并带进度） */
function homeLauncherFolderMiniHTML(f, byId) {
  const ids = f.goals || [];
  const max = f.size === 's' ? 4 : (f.size === 'm' ? 6 : 9);
  const showName = f.size !== 's';
  const mini = ids.slice(0, max).map(gid => {
    const g = byId[gid];
    if (!g) return '';
    if (!showName) return `<div class="htMini htMiniIconOnly" title="${H.esc(g.title)}"><span class="htMiniIcon">🎯</span></div>`;
    const pct = g.tasks_total ? Math.round((g.tasks_done || 0) / g.tasks_total * 100) : 0;
    return `<div class="htMini" title="${H.esc(g.title)}"><span class="htMiniIcon">🎯</span><span class="htMiniName">${H.esc(g.title)}</span>${f.size === 'l' ? `<span class="htMiniBar"><i style="width:${pct}%"></i></span>` : ''}</div>`;
  }).join('');
  const restCount = ids.length - Math.min(ids.length, max);
  return mini + (restCount > 0 ? `<div class="htMini htMiniMore">+${restCount}</div>` : '');
}

function homeLauncherDissolveFolder(layout, folder) {
  if (!confirm('解散「' + folder.name + '」？里面的 ' + folder.goals.length + ' 个目标会回到桌面。')) return;
  const idx = layout.items.indexOf(folder);
  if (idx < 0) return;
  const back = folder.goals.map(gid => ({ type: 'goal', id: gid, size: HOME_TILE_DEFAULT_SIZE }));
  layout.items.splice.apply(layout.items, [idx, 1].concat(back));
  homeLauncherSave(layout);
  H.toast('已解散收藏夹');
  renderHome();
}

async function showGoalPluginsMenu(gid, anchor) {
  document.querySelectorAll('#goalPluginMenu').forEach(x => x.remove());
  let pg = { id: gid, plugins: '{}' };
  try { const r = await H.api('/api/goals/' + gid + '/plugins'); pg = { id: gid, plugins: JSON.stringify((r && r.config) || {}) }; }
  catch (e) { H.toast(e.message); return; }
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
      <span class="gpName">${H.esc(p.name || p.id)}${p.desc ? `<span class="gpDesc">${H.esc(p.desc)}</span>` : ''}</span>
      <span class="cmpSwitch"><input type="checkbox" data-gp="${H.esc(p.id)}" ${on ? 'checked' : ''}><span class="cmpSlider"></span></span>
    </label>`; }).join('');
  document.body.appendChild(m);
  m.querySelectorAll('[data-gp]').forEach(inp => inp.addEventListener('change', async () => {
    const pid = inp.getAttribute('data-gp');
    try {
      await H.api('/api/goals/' + gid + '/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: pid, enabled: inp.checked }) });
      H.toast(inp.checked ? '已为本目标启用' : '已为本目标关闭');
      await H.loadGoal(gid);
      H.renderGoal();
      H.renderRail();
      const fresh = document.getElementById('goalPluginsBtn');
      if (fresh) showGoalPluginsMenu(gid, fresh);
    } catch (e) { H.toast(e.message); inp.checked = !inp.checked; }
  }));
}

function homeLauncherCloseFolder() {
  if (homeFolderCancelDrag) { try { homeFolderCancelDrag(); } catch (e) {} homeFolderCancelDrag = null; }
  if (homeFolderDialogOnKey) { document.removeEventListener('keydown', homeFolderDialogOnKey); homeFolderDialogOnKey = null; }
  if (homeFolderDialogOnHash) { window.removeEventListener('hashchange', homeFolderDialogOnHash); homeFolderDialogOnHash = null; }
  if (homeFolderDialog) { try { homeFolderDialog.remove(); } catch (e) {} homeFolderDialog = null; }
}

/* ---------- 收藏夹弹层（类似 iOS 文件夹展开） ---------- */
let homeFolderDirty = false;       // 弹层里改过内容（排序 / 移出 / 改名）：关闭后要重画首页

/* 收藏夹弹层（挂在 body 下，关闭时连同监听一起收掉） */
let homeFolderDialog = null;

/* 弹层里的一张目标卡（单击进执行页 / 右键或「移出」放回桌面） */
function homeLauncherFolderCardHTML(g) {
  if (!g) return '';
  const st = homeLauncherStatus(g);
  const pct = g.tasks_total ? Math.round((g.tasks_done || 0) / g.tasks_total * 100) : 0;
  return `<div class="homeFolderCard" data-hf-goal="${g.id}" role="button" tabindex="0">
    <div class="hfcHead"><span class="htIcon">🎯</span><span class="hfcTitle">${H.esc(g.title)}</span><span class="chip ${st[1]}">${st[0]}</span></div>
    <div class="htProgress"><div class="bar"><div class="barFill" style="width:${pct}%"></div></div><span class="htPct">${pct}%</span></div>
    <div class="hfcFoot"><span class="hfcMeta">${g.tasks_done || 0}/${g.tasks_total || 0} 任务${g.deadline ? ' · 期限 ' + H.esc(g.deadline) : ''}</span>
      <button class="btn tiny" type="button" data-hf-remove="${g.id}" title="移出收藏夹，放回桌面">↩ 移出</button></div>
  </div>`;
}

/* 收藏夹弹层里右键卡片：打开 / 移出（位置贴着鼠标，越界自动翻边） */
function homeLauncherFolderMenu(ev, goal, onOpen, onEject) {
  document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  const m = document.createElement('div');
  m.className = 'ctxMenu homeTileMenu';
  m.innerHTML = `<div class="ctxTitle">${H.esc((goal && goal.title) || '目标')}</div>
    <button type="button" data-hf-menu-open>🎯 打开目标</button>
    <button type="button" class="danger" data-hf-menu-eject>↩ 移出收藏夹</button>`;
  m.style.left = '0px'; m.style.top = '0px'; m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const mw = m.offsetWidth || 210, mh = m.offsetHeight || 120;
  let left = ev.clientX + 2, top = ev.clientY + 2;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, ev.clientX - mw - 6);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, ev.clientY - mh - 6);
  m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.visibility = '';
  const done = () => { try { m.remove(); } catch (e) {} };
  const openBtn = m.querySelector('[data-hf-menu-open]');
  if (openBtn) openBtn.addEventListener('click', () => { done(); if (onOpen) onOpen(); });
  const ejectBtn = m.querySelector('[data-hf-menu-eject]');
  if (ejectBtn) ejectBtn.addEventListener('click', () => { done(); if (onEject) onEject(); });
}

let homeFolderCancelDrag = null;   // 弹层内拖拽的清理函数（关闭时兜底调用）

let homeFolderDialogOnKey = null;

let homeFolderDialogOnHash = null;

function homeLauncherAbortDrag() {
  const d = homeLauncherDrag;
  if (!d) return;
  homeLauncherDrag = null;
  if (d.timer) { try { clearTimeout(d.timer); } catch (e) {} d.timer = null; }
  document.removeEventListener('pointermove', d.onMove, { passive: true });
  document.removeEventListener('pointerup', d.onUp);
  document.removeEventListener('pointercancel', d.onCancel);
  document.removeEventListener('keydown', d.onKey);
  document.removeEventListener('touchmove', d.onTouch, { passive: false });
  window.removeEventListener('hashchange', d.onHash);
  if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
  if (d.tile) d.tile.classList.remove('htDragging');
  const grid = d.grid || document.getElementById('homeDeskGrid');
  if (grid) {
    grid.classList.remove('htDragGrid', 'htChipHover');
    grid.querySelectorAll('.htMergeChip').forEach(c => { if (c.parentNode) c.parentNode.removeChild(c); });
    grid.querySelectorAll('.htDropBefore, .htDropAfter').forEach(t => t.classList.remove('htDropBefore', 'htDropAfter'));
  }
  document.body.classList.remove('htDraggingBody');
  if (d.phase === 'dragging') homeLauncherNoClickUntil = Date.now() + 350;
}

function homeLauncherStartDrag(d) {
  if (!d || d.phase !== 'pending' || !d.tile || !d.tile.isConnected) { homeLauncherAbortDrag(); return; }
  d.phase = 'dragging';
  if (d.timer) { clearTimeout(d.timer); d.timer = null; }
  const rect = d.tile.getBoundingClientRect();
  d.offsetX = Math.max(0, Math.min(rect.width, d.startX - rect.left));
  d.offsetY = Math.max(0, Math.min(rect.height, d.startY - rect.top));
  const ghost = d.tile.cloneNode(true);
  ghost.className = d.tile.className + ' homeTileGhost';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.left = (d.startX - d.offsetX) + 'px';
  ghost.style.top = (d.startY - d.offsetY) + 'px';
  ghost.removeAttribute('tabindex');
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.tile.classList.add('htDragging');
  d.grid.classList.add('htDragGrid');
  document.body.classList.add('htDraggingBody');
  document.addEventListener('touchmove', d.onTouch, { passive: false });
  homeLauncherNoClickUntil = Date.now() + 400;
  try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
}

function homeLauncherDragMove(d, ev) {
  if (!d.ghost) return;
  d.ghost.style.left = (ev.clientX - d.offsetX) + 'px';
  d.ghost.style.top = (ev.clientY - d.offsetY) + 'px';
  homeLauncherHitTest(d, ev.clientX, ev.clientY);
  homeLauncherPaintChipHover(d, ev.clientX, ev.clientY);
}

function homeLauncherDragDrop(d, ev) {
  homeLauncherHitTest(d, ev.clientX, ev.clientY);
  homeLauncherPaintChipHover(d, ev.clientX, ev.clientY);
  const src = homeLauncherFind(d.layout, d.key);
  const insert = d.insert;
  const chip = homeLauncherChipHit(d, ev.clientX, ev.clientY);
  const chipTargetKey = chip ? chip.getAttribute('data-chip-target') : '';
  homeLauncherAbortDrag();
  if (!src) { renderHome(); return; }
  if (chipTargetKey) {
    const target = homeLauncherFind(d.layout, chipTargetKey);
    if (target && target !== src && homeLauncherMerge(d.layout, src, target)) {
      homeLauncherSave(d.layout);
      H.toast('已收进收藏夹');
      renderHome();
      return;
    }
  }
  if (insert >= 0) {
    const before = d.layout.items.indexOf(src);
    const rest = d.layout.items.filter(it => it !== src);
    const idx = Math.max(0, Math.min(insert, rest.length));
    if (idx !== before) {
      rest.splice(idx, 0, src);
      d.layout.items = rest;
      homeLauncherSave(d.layout);
      renderHome();
    }
  }
}

function collectJobOf(gid) { const id = Number(gid) || 0; return (H.state.collectJobs && H.state.collectJobs[id]) || null; }

function showCollectSetupDialog(gid, opts) {
  opts = opts || {};
  let queries = opts.queries || [];
  let books = opts.books || [];
  const pref = opts.pref || null;
  const editOnly = !!opts.editOnly;
  const csGate = opts.csGate || { review: true, min: 3, cap: 220, perSite: 12, full: true, fullMax: 60000 };
  const auto = opts.auto || { plan: false, books: false };
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
        <div class="csSecHead"><span class="csSecT">🛡 把关（决定什么能进资料库）</span><span class="csSecD">搜回来的一批候选先交给 AI 逐条判读：相关度、有没有实质内容、是不是营销水文</span></div>
        <div class="csGateRow">
          <label class="csGateLbl">严格度
            <select id="csMinScore" class="sxi-sel">
              <option value="4"${csGate.min >= 4 ? ' selected' : ''}>严格 · 只收相关度 4~5 的</option>
              <option value="3"${csGate.min === 3 ? ' selected' : ''}>标准 · 收 3 分以上（推荐）</option>
              <option value="2"${csGate.min === 2 ? ' selected' : ''}>宽松 · 相关就收（2 分以上）</option>
              <option value="0"${csGate.review ? '' : ' selected'}>关闭 AI 把关（回到"搜到就收"）</option>
            </select>
          </label>
          <label class="csGateLbl">候选上限
            <input id="csCandCap" type="number" min="40" max="600" step="20" value="${csGate.cap}"> 条
          </label>
          <label class="csGateLbl">单站上限
            <input id="csPerSite" type="number" min="2" max="40" step="1" value="${csGate.perSite}"> 条
          </label>
          <label class="csGateLbl csGateWide">
            <span><input type="checkbox" id="csFull" ${csGate.full ? 'checked' : ''}> 高质量资料被截断时，把**全文**抓回来再入库</span>
            <span class="muted" style="font-size:11.5px;">单条上限 <input id="csFullMax" type="number" min="4000" max="300000" step="2000" value="${csGate.fullMax}" style="width:88px"> 字（默认 6 万，够放下一份长报告）</span>
          </label>
        </div>
        <div class="csSecD" style="margin-top:4px;">把关是花 AI 的：每 ${18} 条一次调用，一次搜集通常多 3~8 次；这些设置存本机，下次沿用。</div>
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
          <span class="chip">${H.esc(q.kind || '资料')}</span>
          <input class="cpQText" data-cpqtext="${i}" value="${H.esc(q.q || '')}" maxlength="120" placeholder="写一条完整可搜的问题/方向"></div>`).join('')
        : `<div class="csWarn">这次没推荐出来（AI 开小差了），可以点 <button class="btn tiny" id="csRetry">重新推荐</button>，或直接在下面写搜集方向。</div>`;
      const rt = m.querySelector('#csRetry');
      if (rt) rt.addEventListener('click', async () => {
        rt.disabled = true; rt.textContent = '推荐中…';
        try {
          const rr = await H.api('/api/goals/' + gid + '/collect-plan/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (rr.queries && rr.queries.length) { queries = rr.queries; paintQueries(queries); }
          else { rt.disabled = false; rt.textContent = '重新推荐'; H.toast((rr && rr.error) || '还是没推荐出来，手动写两条也行'); }
        } catch (e) { rt.disabled = false; rt.textContent = '重新推荐'; H.toast(e.message); }
      });
    };
    let liveQueries = queries && queries.length ? queries : [{ kind: '资料', q: '', days: 365, on: false }, { kind: '资料', q: '', days: 365, on: false }];
    paintQueries(liveQueries);
    const ebBox = m.querySelector('#ebBooks');
    const paintBooks = () => {
      ebBox.innerHTML = books.length ? books.map((b, i) => `<label class="ebBook"><input type="checkbox" data-ebbook="${i}" checked>
        <span class="ebCover">📖</span>
        <span class="ebInfo"><b>《${H.esc(b.title)}》${b.author ? `<span class="muted">　${H.esc(b.author)}</span>` : ''}</b>
        ${b.pitch ? `<span class="ebPitch">${H.esc(b.pitch)}</span>` : ''}
        <span class="ebWhere">${b.public_domain ? '<span class="chip ok">公版可直下</span>' : ''}${b.where ? `<span class="muted">去哪找：${H.esc(b.where)}</span>` : ''}</span></span></label>`).join('')
      : '<div class="muted">这次没推荐出来，直接在下面写书名也行。</div>';
    };
    paintBooks();
    document.body.appendChild(m);
    const close = v => { m.remove(); resolve(v); };
    /* 方案/书单还没定过：弹窗立刻显示，AI 推荐在后台补进来（以前是等两个 AI 请求都回来才弹窗，用户以为点了没反应） */
    if (auto.plan) {
      qList.innerHTML = '<div class="spProgress"><span class="spinner"></span></div>';
      H.api('/api/goals/' + gid + '/collect-plan/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(rr => {
          if (rr && rr.queries && rr.queries.length) { queries = rr.queries; liveQueries = queries; }
          else if (rr && rr.error) H.toast(rr.error);
          paintQueries(liveQueries);
        })
        .catch(e => { H.toast(e.message); paintQueries(liveQueries); });
    }
    if (auto.books) {
      ebBox.innerHTML = '<div class="spProgress"><span class="spinner"></span></div>';
      H.api('/api/goals/' + gid + '/ebooks/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(rr => { books = (rr && rr.books) || []; paintBooks(); })
        .catch(() => paintBooks());
    }
    m.querySelector('#csX').addEventListener('click', () => close(editOnly ? true : false));
    m.querySelector('#csCancel').addEventListener('click', () => close(editOnly ? true : false));
    const all = m.querySelector('#csAll'), none = m.querySelector('#csNone');
    if (all) all.addEventListener('click', () => m.querySelectorAll('[data-cpq]').forEach(x => { x.checked = true; }));
    if (none) none.addEventListener('click', () => m.querySelectorAll('[data-cpq]').forEach(x => { x.checked = false; }));
    const skip = m.querySelector('#csSkip');
    if (skip) skip.addEventListener('click', async () => {
      try {
        await H.api('/api/goals/' + gid + '/collect-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: liveQueries }) });
        await H.api('/api/goals/' + gid + '/ebooks/pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ want: 'no', books: [] }) });
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
        await H.api('/api/goals/' + gid + '/collect-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: qs.concat(custom) }) });
        /* 把关设置（存本机、全局沿用） */
        try {
          const ms = m.querySelector('#csMinScore');
          const minV = Number(ms && ms.value);
          await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            collect_review: minV > 0 ? '1' : '0',
            collect_min_score: String(minV > 0 ? minV : 3),
            collect_candidates: String(Math.max(40, Number((m.querySelector('#csCandCap') || {}).value) || 220)),
            collect_per_site: String(Math.max(2, Number((m.querySelector('#csPerSite') || {}).value) || 12)),
            collect_full_max: String(Math.max(4000, Number((m.querySelector('#csFullMax') || {}).value) || 60000)),
            collect_full: (m.querySelector('#csFull') || {}).checked ? '1' : '0'
          }) });
        } catch (e) {}
        if (want != null) {
          await H.api('/api/goals/' + gid + '/ebooks/pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ want, books: picked.concat(ecustom) }) });
        }
        close(true);
      } catch (e) { H.toast(e.message); btn.disabled = false; btn.textContent = editOnly ? '保存方案' : '保存并开始搜集'; }
    });
  });
}

function planBusyFor(gid) { return !!H.state.planning && Number(H.state.planGoalId) === Number(gid); }

function digestingAt(gid) { return !!digestJobOf(gid); }

function expandBusyFor(gid) { return !!H.state.expanding && Number(H.state.expandGoalId) === Number(gid); }

function bindPlanningPanel() {
  const stopBtn = document.getElementById('planStop');
  if (stopBtn) stopBtn.addEventListener('click', () => {
    if (H.state.planAbort) { H.state.planAbort.abort(); stopBtn.disabled = true; stopBtn.textContent = '正在停止…'; }
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

/* 规划过程的实时反馈：已用时间 / 已生成几项 / 最近生成的标题（每 1.5-2.5 秒刷新一次） */
function renderPlanLive() {
  const el = document.getElementById('ppLive');
  if (!el) return;
  const p = H.state.planProgress;
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const unit = p.label ? ' 个' + H.esc(p.label) : ' 项';
  el.innerHTML = `<span class="ppLiveMeta">⏱ 已用 ${p.elapsed || 0}s${p.count ? ' · 已生成 ' + p.count + unit : ''}${p.thinking ? ' · 模型思考中…' : ''}</span>`
    + ((p.titles && p.titles.length) ? `<div class="ppLiveList">${p.titles.map(t => `<span class="ppLiveChip">${H.esc(t)}</span>`).join('')}</div>` : '');
}

let planTimer = null;

async function planResumeCheck(id) {
  // 出错后查有没有可继续的草稿，有就记下来让界面出按钮
  try {
    const dr = await H.api('/api/goals/' + id + '/plan/draft');
    if (dr && dr.draft) H.state.planResumeInfo = Object.assign({ goalId: id }, dr.draft);
    else if (!H.state.planResumeInfo || H.state.planResumeInfo.goalId !== id) H.state.planResumeInfo = null;
  } catch (e) {}
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

function homeLauncherHitTest(d, x, y) {
  const grid = d.grid;
  if (!grid) return;
  const tiles = Array.prototype.slice.call(grid.querySelectorAll('[data-tile-key]'));
  const hit = document.elementFromPoint(x, y);
  const hitTile = hit && hit.closest ? hit.closest('[data-tile-key]') : null;
  d.insert = -1;
  const rest = tiles.filter(t => t !== d.tile);
  if (hitTile && hitTile !== d.tile && grid.contains(hitTile)) {
    d.overKey = hitTile.getAttribute('data-tile-key');
    const r = hitTile.getBoundingClientRect();
    const i = rest.indexOf(hitTile);
    const base = i < 0 ? rest.length : i;
    d.insert = x < r.left + r.width / 2 ? base : base + 1;
    homeLauncherPaintDrop(d);
    return;
  }
  d.overKey = '';
  let idx = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i].getBoundingClientRect();
    const pad = Math.min(10, r.height / 4);
    if (y > r.bottom - pad) continue;
    if (y < r.top + pad) { idx = i; break; }
    if (x > r.left + r.width / 2) continue;
    idx = i; break;
  }
  d.insert = idx;
  homeLauncherPaintDrop(d);
}

function homeLauncherPaintChipHover(d, x, y) {
  const grid = d.grid;
  if (!grid) return;
  const hit = homeLauncherChipHit(d, x, y);
  const on = !!hit;
  grid.querySelectorAll('.htMergeChip').forEach(c => c.classList.toggle('on', c === hit));
  grid.classList.toggle('htChipHover', on);
  /* 压在按钮上时把插入竖线一起摘掉（不只是 CSS 隐藏 class）：此刻松手是融合，不是排序 */
  if (on) grid.querySelectorAll('.htDropBefore, .htDropAfter').forEach(t => t.classList.remove('htDropBefore', 'htDropAfter'));
}

function homeLauncherChipHit(d, x, y) {
  const grid = d.grid;
  if (!grid) return null;
  const chip = grid.querySelector('.htMergeChip');
  if (!chip) return null;
  const r = chip.getBoundingClientRect();
  const sx = HOME_CHIP_SLOP_X, sy = HOME_CHIP_SLOP_Y;
  return (x >= r.left - sx && x <= r.right + sx && y >= r.top - sy && y <= r.bottom + sy) ? chip : null;
}

function homeLauncherMerge(layout, src, target) {
  const items = layout.items;
  if (!src || !target || src === target) return false;
  if (src.type === 'folder' && target.type === 'folder') {
    target.goals = target.goals.concat(src.goals.filter(gid => target.goals.indexOf(gid) < 0));
    items.splice(items.indexOf(src), 1);
    return true;
  }
  if (src.type === 'goal' && target.type === 'goal') {
    const folder = { type: 'folder', id: homeLauncherNewFolderId(), name: homeLauncherFolderName(layout), size: target.size, goals: [target.id, src.id] };
    items.splice(items.indexOf(target), 1, folder);
    items.splice(items.indexOf(src), 1);
    return true;
  }
  if (src.type === 'goal' && target.type === 'folder') {
    if (target.goals.indexOf(src.id) < 0) target.goals.push(src.id);
    items.splice(items.indexOf(src), 1);
    return true;
  }
  if (src.type === 'folder' && target.type === 'goal') {
    if (src.goals.indexOf(target.id) < 0) src.goals.push(target.id);
    items.splice(items.indexOf(target), 1);
    return true;
  }
  return false;
}

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

function digestJobOf(gid) { const id = Number(gid) || 0; return (H.state.digestJobs && H.state.digestJobs[id]) || null; }

function homeLauncherPaintDrop(d) {
  const grid = d.grid;
  if (!grid) return;
  const tiles = Array.prototype.slice.call(grid.querySelectorAll('[data-tile-key]'));
  tiles.forEach(t => t.classList.remove('htDropBefore', 'htDropAfter'));
  /* 只在「压在另一张卡片上」时挂按钮；换目标就搬过去，离开卡片就摘掉 */
  const host = d.overKey ? grid.querySelector('[data-tile-key="' + d.overKey.replace(/"/g, '\\"') + '"]') : null;
  const chips = Array.prototype.slice.call(grid.querySelectorAll('.htMergeChip'));
  chips.forEach(c => { if (!host || c.parentNode !== host) c.parentNode.removeChild(c); });
  if (host) {
    let chip = host.querySelector('.htMergeChip');
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'htMergeChip';
      chip.setAttribute('data-merge-chip', '');
      host.appendChild(chip);
    }
    const text = homeLauncherMergeChipText(d, host);
    if (d.chipText !== text || chip.textContent !== text) {
      chip.textContent = text;
      d.chipText = text;
    }
    chip.setAttribute('data-chip-target', d.overKey);
  } else {
    d.chipText = '';
  }
  if (d.insert < 0) return;
  const rest = tiles.filter(t => t !== d.tile);
  if (d.insert < rest.length) rest[d.insert].classList.add('htDropBefore');
  else if (rest.length) rest[rest.length - 1].classList.add('htDropAfter');
}

const HOME_CHIP_SLOP_X = 12;

const HOME_CHIP_SLOP_Y = 2;

function homeLauncherFolderName(layout) {
  let count = 0;
  for (const it of layout.items) if (it.type === 'folder') count++;
  return '收藏夹 ' + (count + 1);
}

/* 「📁 收进收藏夹」按钮的文案：谁被收进谁，说清楚 */
function homeLauncherMergeChipText(d, host) {
  const src = homeLauncherFind(d.layout, d.key);
  const target = homeLauncherFind(d.layout, d.overKey);
  const name = it => (it && it.type === 'folder' && it.name) ? it.name : '收藏夹';
  if (src && src.type === 'folder') return '📁 并入「' + name(src) + '」';
  if (target && target.type === 'folder') return '📁 收进「' + name(target) + '」';
  return '📁 收进收藏夹';
}

async function renderHome() {
  H.app.innerHTML = '<p class="muted">加载中…</p>';
  const [{ goals }, st] = await Promise.all([
    H.api('/api/goals'),
    H.api('/api/ai/status').catch(() => ({}))
  ]);
  H.state.goals = goals;
  H.state.aiStatus = st;
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
  if (H.state.showNew) html += newGoalHTML();
  if (!goals.length && !H.state.showNew) {
    html += `<div class="emptyBox">
      <div class="ebIcon">🎯</div>
      <div class="ebTitle">还没有目标</div>
      <div class="ebText">任何想达成的目标（转行就业、学一门技能、考研考证、做出作品…），AI 会先与你反复确认，再拆成可执行的路径。</div>
      <button class="btn primary" id="emptyNewBtn">＋ 新建目标</button>
      <label class="btn" style="margin-left:8px;">⬆ 导入分享<input type="file" id="shareImportFile2" accept=".json,application/json" hidden></label>
    </div>`;
  }
  /* 目标桌面：卡片 / 收藏夹 / 三档大小（长按拖拽收纳），布局存本机（详见 homeLauncher* 一段） */
  let homeLayout = null;
  if (goals.length) {
    homeLayout = homeLauncherLoad(goals);
    html += homeLauncherRecentHTML(goals);      // 顶部「最近目标」（没有记录时整块不渲染）
    html += homeLauncherDeskHTML(goals, homeLayout);
  }
  html += '</div>';
  H.app.innerHTML = html;
  if (homeLayout) {
    const homeGoalsById = {};
    for (const g of goals) homeGoalsById[g.id] = g;
    bindHomeLauncher(homeLayout, homeGoalsById);
  }

  const gb = document.getElementById('guideBtn');
  if (gb) gb.addEventListener('click', () => H.showGuide(0));
  H.app.querySelectorAll('#shareImportFile, #shareImportFile2').forEach(inp => inp.addEventListener('change', async () => {
    const file = (inp.files || [])[0];
    inp.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await H.api('/api/share/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      H.toast('已导入分享：' + r.counts.nodes + ' 个节点 · ' + r.counts.sources + ' 条资料 · ' + r.counts.digests + ' 篇汇总');
      H.state.goals = (await H.api('/api/goals')).goals || [];
      H.go('#/g/' + r.goalId);
    } catch (e) { H.toast(e.message); }
  }));
  const nb = document.getElementById('newBtn');
  if (nb) nb.addEventListener('click', () => { H.state.showNew = !H.state.showNew; renderHome(); });
  const eb = document.getElementById('emptyNewBtn');
  if (eb) eb.addEventListener('click', () => { H.state.showNew = true; renderHome(); });
  bindPluginPicker();
  const form = document.getElementById('newGoalForm');
  if (form) {
    document.getElementById('ngCancel').addEventListener('click', () => { H.state.showNew = false; renderHome(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('ngTitle').value.trim();
      if (!title) return H.toast('请填写你的目标');
      const pluginSel = {};
      document.querySelectorAll('[data-plugin-check]').forEach(c => { pluginSel[c.getAttribute('data-plugin-check')] = c.checked; });
      try {
        const { goal } = await H.api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          title,
          plugins: pluginSel,
          profile: document.getElementById('ngProfile').value,
          materials: document.getElementById('ngMaterials').value,
          weekly_hours: document.getElementById('ngHours').value,
          deadline: document.getElementById('ngDeadline').value
        }) });
        H.state.showNew = false;
        H.go('#/g/' + goal.id);
        setTimeout(() => startCollect(goal.id), 400);
      } catch (err) { H.toast(err.message); }
    });
  }
}

  function mountHome(host) {
    H = host || {};
    return {
      render: function () { return renderHome(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['home'] = { id: 'home', mount: mountHome };
})();
