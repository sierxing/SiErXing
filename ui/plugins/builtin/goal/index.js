'use strict';
/**
 * 内置 UI 插件 · 目标执行页（#/g/:id）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/goal/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

/* 目标页组件入口按钮：全部交给收藏栏排布（溢出由栏内 ⋯ 收纳，不再单独发一个 ⋯ 按钮） */
function pluginButtonsHTML(goal) {
  const { visible } = pluginEntriesVisible(goal);
  return visible.map(e =>
    `<button class="btn small" data-tbtn id="goalComp_${H.esc(e.id)}" data-plugin-go="${H.esc(e.hash(goal.id))}" title="${H.esc(e.label)}">${e.icon} ${H.esc(e.label)}</button>`).join('');
}

/* 目标页：按目标开关组件（只改本目标，其它目标不受影响） */
function goalPluginsHTML(g) {
  if (!window.SiErXing) return '';
  return `<button class="btn small" data-tbtn id="goalPluginsBtn" title="为本目标开关组件（只改本目标）">🧩 组件</button>`;
}

function foldBtn(key, closed) { return `<button class="btn tiny cardFold" data-fold="${key}" title="折叠/展开">${closed ? '▸' : '▾'}</button>`; }

/* defaultOpen: 从没动过时的默认状态 */
function foldClosed(gid, key, defaultOpen) {
  const v = cardFoldState(gid)[key];
  return v == null ? !defaultOpen : !!v;
}

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

function constraintsCardHTML(g) {
  const list = constraintsList(g);
  const closed = foldClosed(g.id, 'constraints', list.length > 0 || !!H.state.showConstraints);
  return `<div class="consCard">
    <div class="consHead">
      ${foldBtn('constraints', closed)}
      <span>⛓ 规划约束</span><span class="chip gray">${list.length}</span>
      <span class="consHint">这些是硬性要求，AI 在规划 / 拆分 / 教程 / 对话中都会严格遵守</span>
      <div class="spacer"></div>
    </div>
    <div class="consBody" data-foldbody="constraints"${closed ? ' hidden' : ''}>
      ${list.length ? `<div class="consList">${list.map((c, i) => `<div class="consItem"><span class="consText">${H.esc(String(c.text))}</span><div class="spacer"></div><button class="btn tiny" data-consedit="${i}">改</button><button class="btn tiny danger" data-consdel="${i}">×</button></div>`).join('')}</div>` : '<div class="muted" style="font-size:12.5px;padding:4px 2px;">还没有约束。例如：只能周末学（每周≤6h）／预算 0 元，只用免费资源／必须用 Python／不要安排视频课／3 个月内必须投递</div>'}
      <div class="consAdd">
        <input type="text" id="consInput" placeholder="添加一条约束，例如：不要安排付费课程">
        <button class="btn small primary" id="consAddBtn">添加约束</button>
      </div>
    </div>
  </div>`;
}

function srcPanelHTML() {
  const list = H.state.sources || [];
  const digests = H.state.digests || [];
  const gid = (H.state.goal && H.state.goal.id) || 0;
  const srcClosed = foldClosed(gid, 'sources', true);
  let h = `<div class="srcPanel">
    <div class="spHead">
      ${foldBtn('sources', srcClosed)}
      <span class="spTitle">信息源</span><span class="spCount">${list.length}</span>
      <span class="spHint">${collectPrefHint()}</span>
      <div class="spacer"></div>
        <button class="btn small" id="collectBtn">${list.length ? '重新收集' : '收集信息源'}</button>
        <button class="btn small" id="collectPlanBtn" title="说明/选择这次搜什么：AI 按目标推荐搜集方案，可逐条勾选、改写、加自己的">⚙ 搜集方案</button>
        <span class="muted" id="cpSummary" style="font-size:12px;">${H.esc(collectPlanSummary())}</span>
        <button class="btn small primary" <button class="btn small" id="srcAddBtn" title="粘贴文本、或填写标题与链接，手动添加一条资料（可标为优质信息源）">＋ 添加资料</button>
        <button class="btn small primary" id="digestBtn" title="让 AI 通读全部资料（含你上传的图片资料），提炼成多篇主题汇总，规划时优先依据">🧠 ${digests.length ? '重新提炼' : '信息提炼'}</button>
        ${list.length ? `<button class="btn small danger" id="srcClearBtn" title="删除本目标全部信息源（含已导入的图片/电子书原件），不可恢复">🗑 清空</button>` : ''}
      </div>
    <div data-foldbody="sources"${srcClosed ? ' hidden' : ''}>`;
  if (H.state.collecting) {
      h += `<div class="spProgress"><span class="spinner"></span><span id="spStatus">${H.esc(H.state.collectStatus || '正在检索…')}</span><div class="spacer"></div><button class="btn tiny" id="collectStop" title="停止本次收集（已收集到的会保留）">⏹ 停止</button></div>`;
  }
    const starCount = list.filter(x => Number(x.quality) === 1).length;
    if (starCount) h += `<div class="spStarTip">★ 优质信息源 ${starCount} 条 —— 规划时会重点依据这些资料（可在资料左侧点 ★ 标注/取消）</div>`;
    if (H.state.srcFormOpen) {
      h += `<div class="srcForm">
        <div class="sfRow"><input id="sfTitle" placeholder="标题（如：Agent 面试知识库 / 某厂 JD）" value="${H.esc(H.state.srcFormTitle || '')}"></div>
        <div class="sfRow">
          <select id="sfKind">${['资料', 'JD', '面经', '学习路线', '大纲', '笔记', '课程', '资源'].map(k => `<option ${H.state.srcFormKind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <input id="sfSite" placeholder="来源（如 GitHub / 某厂官网）" value="${H.esc(H.state.srcFormSite || '')}">
          <label class="sfStar"><input type="checkbox" id="sfQuality" ${H.state.srcFormQuality ? 'checked' : ''}> 标为优质信息源</label>
        </div>
        <div class="sfRow"><input id="sfUrl" placeholder="链接（可选）" value="${H.esc(H.state.srcFormUrl || '')}"></div>
        <div class="sfRow"><textarea id="sfContent" placeholder="把文本粘贴到这里（Ctrl+V 直接粘贴，越完整越好）">${H.esc(H.state.srcFormContent || '')}</textarea></div>
        <div class="sfOps">
          <button class="btn small primary" id="sfSave">保存为资料</button>
          <button class="btn small" id="sfPaste">从剪贴板粘贴</button>
          <button class="btn small" id="sfCancel">取消</button>
        </div>
      </div>`;
    }
    if (H.state.digesting) {
      const dp = H.state.digestProgress || {};
      h += `<div class="spProgress"><span class="spinner"></span><span id="spStatus">${H.esc(H.state.digestStatus || '正在通读资料…')}</span>${dp.total ? `<span class="muted" style="font-size:11.5px;">（${dp.done || 0}/${dp.total} 批）</span>` : ''}<div class="spacer"></div><button class="btn tiny" id="digestStop" title="停止提炼">⏹ 停止</button></div>`;
    }
    if (digests.length) {
      h += `<div class="spDigests"><div class="spDigestsHead">📄 提炼汇总（${digests.length} 篇 · 规划优先依据）<div class="spacer"></div><a class="btn tiny" href="/api/goals/${(H.state.goal || {}).id}/digests/export" download>⬇ 下载全部 MD</a></div>`
        + digests.map(d => `<details class="spDigest"><summary>${H.esc(d.title || d.topic)}</summary><div class="spDigestBody mdBody">${H.mdToHTML(d.content || '')}</div><div class="spDigestOps"><span class="muted" style="font-size:11.5px;">依据 ${d.sources_count || 0} 条资料 · ${H.esc(H.fmtDate(d.created_at))}</span><div class="spacer"></div><button class="btn tiny danger" data-digest-del="${d.id}">删除</button></div></details>`).join('')
        + `</div>`;
    }
  if (list.length) {
    const gid2 = (H.state.goal && H.state.goal.id) || 0;
    const selIds = H.state.srcSel && H.state.srcSel.gid === gid2 ? H.state.srcSel.ids : new Set();
    const selN = list.filter(s => selIds.has(String(s.id))).length;
    h += `<details class="spDetails" id="spDetails"${H.state.srcListOpen ? ' open' : ''}><summary>查看来源列表（${list.length} 条）</summary>
      <div class="spListBar"><label class="spSelAll"><input type="checkbox" id="srcSelAll" ${selN && selN === list.length ? 'checked' : ''}> 全选</label>
      ${selN ? `<button class="btn tiny danger" id="srcDelSel">删除选中（${selN}）</button>` : '<span class="muted" style="font-size:12px;">勾选可批量删除；每条右侧 × 可单独删除</span>'}
      </div><div class="spList">${list.map(sourceItemHTML).join('')}</div></details>`;
  } else if (!H.state.collecting) {
    h += '<div class="spEmpty">还没有信息源。建议先「收集信息源」，AI 规划会依据真实 JD 与面经，质量更高。</div>';
  }
  h += '</div></div>';
  return h;
}

function planPanelHTML() {
  const g = H.state.goal;
  if (!g) return '';
  if (H.state.planning) {
    return `<div class="planPanel" id="planPanel">
      <div class="ppHead"><span class="spinner"></span><span id="ppStatus">${H.esc(H.state.planStatus || 'AI 正在规划…')}${H.state.planTaskCount ? '（已生成 ' + H.state.planTaskCount + ' 个任务，中断后可继续）' : ''}</span><span class="ppTime" id="ppTime">0s</span><div class="spacer"></div><button class="btn tiny" id="planStop" title="停止这次生成（已生成的内容不会丢，可随时重新开始或继续）">⏹ 停止</button></div>
      <div class="ppTrack"><div class="ppTrackIn"></div></div>
      <div class="ppLive" id="ppLive" hidden></div>
      <details class="ppRaw"><summary>查看 AI 原始输出</summary><pre class="ppText" id="ppText"></pre></details>
      <div class="hint">${H.esc(H.state.planHint || '规划约需 1-3 分钟，请保持页面打开。')}</div>
    </div>`;
  }
  const pend = H.state.pendingAsk || goalPendingAsk(g);
  if (pend && pend.data && Array.isArray(pend.data.questions) && pend.data.questions.length) return askPanelHTML(pend);
  if (g.status === 'review') {
    const stages = (H.state.goal.nodes || []).filter(n => n.level === 0).length;
    const subs = (H.state.goal.nodes || []).filter(n => n.level === 1).length;
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
  if (g.status === 'planned' && (H.state.goal.nodes || []).length) {
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

function editGoalHTML(g) {
  return `<form class="newForm" id="editGoalForm">
    <div class="field"><label>职业目标 *</label><input id="egTitle" value="${H.esc(g.title)}"></div>
    <div class="grid2">
      <div class="field"><label>当前起点</label><textarea id="egProfile">${H.esc(g.profile)}</textarea></div>
      <div class="field"><label>目标岗位 JD / 参考资料</label><textarea id="egMaterials">${H.esc(g.materials)}</textarea></div>
    </div>
    <div class="grid2">
      <div class="field"><label>每周可投入</label><input id="egHours" value="${H.esc(g.weekly_hours)}"></div>
      <div class="field"><label>期望期限</label><input id="egDeadline" value="${H.esc(g.deadline)}"></div>
    </div>
    <div class="toolbarRow">
      <button class="btn primary" type="submit">保存</button>
      <button class="btn" type="button" id="egCancel">取消</button>
    </div>
  </form>`;
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
      <div class="ncTitle">${H.esc(g.next_task)}</div>
      ${g.next_path ? `<div class="ncPath">${H.esc(g.next_path)}</div>` : ''}
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
  const f = H.state.filter;
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
  if (!H.state.filter) return stages;
  const out = [];
  for (const st of stages) {
    const subs = [];
    for (const g of st.children) {
      const tasks = g.children.filter(t => t.status === H.state.filter);
      if (tasks.length) subs.push({ ...g, children: tasks });
    }
    if (subs.length) out.push({ ...st, children: subs });
  }
  return out;
}

function listViewHTML(stages) {
  if (!stages.length) return '<div class="empty">没有匹配的任务</div>';
  const gid = (H.state.goal && H.state.goal.id) || 0;
  let h = '<div class="taskListView">';
  stages.forEach((st, si) => {
    const p = subtreeProgress(st);
    const sst = H.ST_LABEL[st.status] ? st.status : 'todo';
    const sKey = 'tl-s' + st.id, sClosed = foldClosed(gid, sKey, true);
    h += `<div class="tlStage">
      <div class="tlStageHead ${sst}" data-node-id="${st.id}" data-detail="${st.id}" title="点击查看详情">
        ${foldBtn(sKey, sClosed)}
        <span class="stageIdx">${String(si + 1).padStart(2, '0')}</span>
        <span class="tlStageTitle">${H.esc(st.title)}</span>
        <span class="mtProg">${p.done}/${p.total}</span>
      </div>
      <div data-foldbody="${sKey}"${sClosed ? ' hidden' : ''}>`;
    for (const g of st.children) {
      const gp = subtreeProgress(g);
      const gst = H.ST_LABEL[g.status] ? g.status : 'todo';
      const gKey = 'tl-g' + g.id, gClosed = foldClosed(gid, gKey, true);
      h += `<div class="tlSub">
        <div class="tlSubHead ${gst}" data-node-id="${g.id}" data-detail="${g.id}" title="点击查看详情">${foldBtn(gKey, gClosed)}<span class="tlSubTitle">${H.esc(g.title)}</span><span class="mtProg">${gp.done}/${gp.total}</span></div>
        <div data-foldbody="${gKey}"${gClosed ? ' hidden' : ''}>${g.children.map(listTaskHTML).join('')}</div>
      </div>`;
    }
    h += '</div></div>';
  });
  return h + '</div>';
}

/* “继续学习”卡片：上次看到的教程 + 看到哪，一键跳回去 */
async function renderContinueCard(gid) {
  const box = document.getElementById('continueCard');
  if (!box) return;
  if (!H.goalCompOn(goalCtx(), 'tutorial')) { box.remove(); return; }
  let d = null;
  try { d = await H.api('/api/goals/' + gid + '/last-tutorial'); } catch (e) { box.remove(); return; }
  const t = d && d.tutorial;
  if (!t) { box.remove(); return; }
  const total = Math.max(0, Number(t.sections_total) || 0);
  const at = total ? Math.min(Number(t.section_idx) + 1, total) : 0;
  const pct = total ? Math.min(100, Math.round(at / total * 100)) : 0;
  box.innerHTML = `<div class="continueCard">
    <div class="ccIcon">${sxi('book', 18)}</div>
    <div class="ccMain">
      <div class="ccLabel">继续学习${total ? `<span class="ccSep">·</span>第 <b>${at}</b>/${total} 节<b class="ccPct">${pct}%</b>` : ''}</div>
      <div class="ccTitle">${H.esc(t.title)}</div>
      ${t.node_title ? `<div class="ccNode">${sxi('target', 14)}${H.esc(t.node_title)}</div>` : ''}
      ${total ? `<div class="bar"><div class="barFill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <a class="btn primary" href="#/t/${t.id}">${sxi('play', 14)}继续阅读</a>
  </div>`;
}

function pluginGoButtonsBind() {
  document.querySelectorAll('[data-plugin-go]').forEach(b => b.addEventListener('click', () => H.go(b.getAttribute('data-plugin-go'))));
}

function bindConstraints(g) {
  const addBtn = document.getElementById('consAddBtn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const inp = document.getElementById('consInput');
    const text = (inp.value || '').trim();
    if (!text) return H.toast('请输入约束内容');
    try {
      const r = await H.api('/api/goals/' + g.id + '/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      H.state.goal = r.goal; H.state.showConstraints = true;
      try { const fm = cardFoldState(g.id); delete fm.constraints; cardFoldSave(g.id, fm); } catch (e) {}
      renderGoal(); H.toast('约束已添加，规划会严格遵守');
    } catch (e) { H.toast(e.message); }
  });
  const inp = document.getElementById('consInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  document.querySelectorAll('[data-consdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这条约束？')) return;
    try {
      const r = await H.api('/api/goals/' + g.id + '/constraints/' + b.getAttribute('data-consdel'), { method: 'DELETE' });
      H.state.goal = r.goal; renderGoal(); H.toast('已删除');
    } catch (e) { H.toast(e.message); }
  }));
  document.querySelectorAll('[data-consedit]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.getAttribute('data-consedit'));
    const list = constraintsList(H.state.goal);
    const cur = list[i] ? String(list[i].text) : '';
    const text = prompt('修改约束：', cur);
    if (text == null) return;
    if (!text.trim()) return;
    try {
      const r = await H.api('/api/goals/' + g.id + '/constraints', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: i, text: text.trim() }) });
      H.state.goal = r.goal; renderGoal(); H.toast('已更新');
    } catch (e) { H.toast(e.message); }
  }));
}

async function startPlanResume(id) {
  if (H.state.planning || H.state.collecting || H.state.expanding) return;
  H.state.planning = true;
  H.state.planAbort = new AbortController();
  H.state.planProgress = null;
  H.state.planStage = 'skeleton';
  H.state.planStatus = '正在接着上次的构思继续…';
  H.state.planHint = '把上次保留的原始构思整理成标准格式，约需 30-90 秒。';
  H.state.showEdit = false;
  if (!H.state.goal || H.state.goal.id !== id) await H.loadGoal(id);
  H.state.goal.status = 'planning';
  H.rerenderCurrent();
  bindPlanningPanel();
  const r = await streamSSE('/api/goals/' + id + '/plan/resume', {}, d => {
    if (d.status) { H.state.planStatus = d.status; const el = document.getElementById('ppStatus'); if (el) el.textContent = d.status; }
    if (d.progress) { H.state.planProgress = d.progress; renderPlanLive(); }
  }, H.state.planAbort.signal).catch(e => ({ done: true, error: e.message }));
  clearInterval(planTimer);
  H.state.planning = false;
  if (r.error || !r.done) {
    H.toast(r.error || '继续构思中断，可重试');
    try { await H.loadGoal(id); } catch (e) {}
    await planResumeCheck(id);
  } else {
    H.state.planResumeInfo = null;
    H.state.goal = r.data.goal;
    if (r.data.report) H.state.lastReport = { text: r.data.report, versionId: r.data.versionId, goalId: id };
    H.toast('已接着上次的构思生成骨架，请确认或提意见');
  }
  const rr = H.parseRoute();
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) H.renderMapPage();
}

async function startCollect(id) {
  if (!H.goalCompOn(goalCtx(), 'sources')) { H.toast('「信息源检索」组件在本目标已关闭：目标页 🧩 可单独开启'); return; }
  if (H.state.collecting) return;
  if (!(await ensureCollectSetup(id))) return;   // 搜集前确认搜什么+要不要电子书（取消则不搜集）
  H.state.collecting = true;
  H.state.collectStatus = '正在检索…';
  renderGoal();
  try {
    H.state.collectAbort = new AbortController();
      const resp = await fetch('/api/goals/' + id + '/collect', { method: 'POST', signal: H.state.collectAbort.signal });
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
          H.state.collectStatus = d.status;
          const el = document.getElementById('spStatus');
          if (el) el.textContent = d.status;
        }
        if (d.done) {
          done = true; H.state.sources = d.sources || [];
          const st = d.stats || null;
          const fun = st
            ? '（搜到 ' + st.searched + ' 条 → 进审 ' + st.toReview + ' 条 → 入库 ' + st.saved + ' 条'
              + (st.aiDrop ? '，AI 判为不合格 ' + st.aiDrop + ' 条' : '')
              + (st.fullGot ? '，补抓全文 ' + st.fullGot + ' 条' : '') + '）'
            : '';
          H.toast('信息源收集完成：' + d.count + ' 条' + fun + (d.ebooks ? '；' + d.ebooks : '') + (d.blocked ? '（百度限流，本次用备用搜索，可稍后重新收集以获取更多）' : ''));
        }
        if (d.error) { done = true; H.toast(d.error); }
      }
    }
    if (!done) H.toast('信息源收集中断，可重试');
  } catch (e) {
    H.toast(e.message);
  } finally {
    H.state.collecting = false;
    H.state.collectStatus = '';
    try { await H.loadGoal(id); } catch (e) {}
    renderGoal();
    // 收集完成后若还没有路径，自动开始规划
    if (H.state.goal && !H.state.goal.nodes.length && !H.state.planning) {
      startPlanning(id);
    }
  }
}

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
  let queries = (plan && plan.queries) || [];
  let books = [];
  try {
    const rs = await Promise.all([
      (plan && plan.asked) ? {} : H.api('/api/goals/' + id + '/collect-plan/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(e => ({})),
      (pref && pref.asked) ? {} : H.api('/api/goals/' + id + '/ebooks/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(e => ({}))
    ]);
    if (!(plan && plan.asked)) {
      queries = rs[0].queries || [];
      if (rs[0].error && !queries.length) H.toast('搜集方案推荐失败：' + rs[0].error + '（可用默认模板或手动填写）');
      if (!queries.length) queries = [];
    }
    if (!(pref && pref.asked)) {
      books = rs[1].books || [];
      if (rs[1].error && !books.length) H.toast('书单推荐失败：' + rs[1].error + '（可手动填写）');
    }
  } catch (e) { H.toast('推荐失败，可手动填写：' + e.message); }
  return showCollectSetupDialog(id, { queries, books, pref, editOnly: !!editOnly });
}

/* 信息提炼：让 AI 通读全部资料（含图片资料）→ 提炼成多篇主题 MD 汇总 → 规划优先依据 */
async function startDigest(id) {
  if (H.state.digesting) return;
  if (!(await ensureAIConfigured())) return;
  if (!(H.state.sources || []).length) { H.toast('还没有资料：先「收集信息源」或上传图片资料'); return; }
  if (!confirm('让 AI 通读全部 ' + (H.state.sources || []).length + ' 条资料并提炼成多篇主题汇总？\n\n你的资料越多耗时越长（100 条以上大约 10-20 分钟，期间可随时点「⏹ 停止」，已提炼的部分会保留），提炼结果会用于后续规划。')) return;
  H.state.digesting = true;
  H.state.digestStatus = '正在通读资料…';
  H.state.digestProgress = null;
  H.state.digestAbort = new AbortController();
  renderGoal();
  try {
    const resp = await fetch('/api/goals/' + id + '/sources/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: H.state.digestAbort.signal });
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
        if (d.status) { H.state.digestStatus = d.status; const el = document.getElementById('spStatus'); if (el) el.textContent = d.status; }
        if (d.progress) { H.state.digestProgress = d.progress; }
        if (d.done) { done = true; H.state.digests = d.digests || []; H.toast('提炼完成：' + d.count + ' 篇主题汇总（规划会优先依据）'); }
        if (d.cancelled) { done = true; H.toast(d.status || '已停止提炼'); }
        if (d.error) { done = true; H.toast(d.error); }
      }
    }
    if (!done) H.toast('提炼中断，可重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') H.toast(e.message);
  } finally {
    H.state.digesting = false;
    H.state.digestStatus = '';
    H.state.digestProgress = null;
    H.state.digestAbort = null;
    try { await H.loadGoal(id); } catch (e) {}
    renderGoal();
  }
}

/* 树节点事件（执行页清单 & 导图页共用） */
function bindTreeEvents(rerender) {
  const onUpdate = goal => { H.state.goal = goal; rerender(); };
  H.app.querySelectorAll('[data-childtoggle]').forEach(el => el.addEventListener('click', e => {
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
    H.state.expanded[key] = open;
    drawMapLines();
    /* 展开/收起会改变树的可视尺寸（实测 1190 → 817），必须重新"适应屏幕"，
       否则树贴到左边、右侧留一大片灰底（用户反馈的"右侧多一坨灰色空白"）。
       延后一帧等布局完成再算，避免量到旧尺寸。 */
    requestAnimationFrame(function () { try { mapFit(); } catch (e) {} });
  }));
  H.app.querySelectorAll('[data-expand]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    H.startExpand(Number(btn.getAttribute('data-expand')));
  }));
  H.app.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', e => {
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
    H.state.expanded[key] = open;
    drawMapLines();
    /* 同上：折叠/展开后重新适应屏幕，保持树居中 */
    requestAnimationFrame(function () { try { mapFit(); } catch (e) {} });
  }));
  H.app.querySelectorAll('[data-detail]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('[data-cycle]') || e.target.closest('.nodeOps')) return;
    H.showNodePanel(Number(el.getAttribute('data-detail')), rerender);
  }));
  H.app.querySelectorAll('[data-cycle]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-cycle'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const next = H.ST_NEXT[n.status] || 'todo';
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      onUpdate(r.goal);
      H.toast(next === 'done' ? '已完成 ✓' : next === 'doing' ? '进行中' : '已回到未开始');
    } catch (e) { H.toast(e.message); }
  }));
  H.app.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-edit'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const title = (prompt('标题：', n.title) || '').trim();
    if (!title) return;
    const d = window.prompt('说明（可留空）：', n.detail);
    if (d === null) return;
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, detail: d }) });
      onUpdate(r.goal);
    } catch (err) { H.toast(err.message); }
  }));
  H.app.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-del'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    if (!confirm('删除「' + n.title + '」' + (n.level < 2 ? '（含其下全部内容）' : '') + '？')) return;
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'DELETE' });
      onUpdate(r.goal);
      H.toast('已删除');
    } catch (err) { H.toast(err.message); }
  }));
  H.app.querySelectorAll('.addChild').forEach(btn => btn.addEventListener('click', async () => {
    const parent = Number(btn.getAttribute('data-parent'));
    const title = (prompt('添加' + (btn.getAttribute('data-level') === '2' ? '任务' : '小目标') + '：') || '').trim();
    if (!title) return;
    try {
      const r = await H.api('/api/goals/' + H.state.goal.id + '/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: parent, title }) });
      H.state.expanded['g' + parent] = true;
      H.state.expanded['s' + parent] = true;
      onUpdate(r.goal);
    } catch (err) { H.toast(err.message); }
  }));
  drawMapLines();
  // 顶栏收藏栏：与教程页同一套（钉选 / 收藏夹 / 横向拖拽 / ⋯ 收纳）
  H.applyBarOverflow('goal');
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
        <span><b>${H.esc(m.label)}</b>${m.privacy ? ' <span class="chip warn" style="font-size:10px;">含隐私</span>' : ''}<br><span class="muted">${H.esc(m.note)}</span></span></label>`).join('')}
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
    if (!mods.length) return H.toast('至少勾选一项要分享的内容');
    const redact = !!(div.querySelector('#shareRedactBox') || {}).checked;
    const a = document.createElement('a');
    a.href = '/api/goals/' + goalId + '/share?parts=' + encodeURIComponent(mods.join(',')) + (redact ? '' : '&redact=0');
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    close();
    H.toast(redact ? '已导出分享文件（隐私已隐去）' : '已导出分享文件（原样，含个人现状）');
  });
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
      renderGoal();
      H.renderRail();
      const fresh = document.getElementById('goalPluginsBtn');
      if (fresh) showGoalPluginsMenu(gid, fresh);
    } catch (e) { H.toast(e.message); inp.checked = !inp.checked; }
  }));
}

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

function pluginEntriesVisible(goal) {
  if (!window.SiErXing) return { visible: [], overflow: [] };
  const all = SiErXing.goalEntries(goal)
    .filter(e => e.header !== false)
    .filter(e => H.goalCompOn(goal, e.id));
  // 顶栏已改成收藏栏，全部入口都渲染出来，溢出由栏内 ⋯ 收纳
  return { visible: all, overflow: [] };
}

/* ============ 路线图卡片折叠（按目标记住展开/折叠，下次还保持） ============ */
function cardFoldState(gid) { try { return JSON.parse(localStorage.getItem('sierxing-goal-folds-' + gid) || '{}') || {}; } catch (e) { return {}; } }

/* ===== 规划约束 ===== */
function constraintsList(g) {
  let list = [];
  try { list = JSON.parse((g && g.constraints) || '[]'); } catch (e) { list = []; }
  return (Array.isArray(list) ? list : []).filter(c => c && String(c.text || '').trim());
}

function collectPrefHint() {
  const p = String((H.state.goal && H.state.goal.collect_pref) || '');
  if (p === 'no') return '你说过这次不用搜集资料 —— 需要时随时可以在这里找，或导入代码库';
  if (p === 'later') return '你说过先不搜集 —— 想找的话点「收集信息源」';
  return '可选：按搜集方案找真实资料，规划会优先依据（不收集也能规划）';
}

/* 搜集前问电子书：没问过就让 AI 推荐书单，用户勾选+自填，然后再搜集 */
/* 当前搜集方案一句话摘要（面板上可见，不用点开也知道会搜什么） */
function collectPlanSummary() {
  try {
    const p = JSON.parse((H.state.goal && H.state.goal.collect_plan) || 'null');
    const qs = (p && p.queries || []).filter(q => q && q.q && q.on !== false);
    if (!qs.length) return '';
    const kinds = [...new Set(qs.map(q => q.kind || '资料'))].slice(0, 5).join('/');
    return `当前方案 ${qs.length} 条（${kinds}）`;
  } catch (e) { return ''; }
}

function sourceItemHTML(s) {
  const body = String(s.content || s.snippet || '').trim();
  const star = Number(s.quality) === 1;
  const sel = H.state.srcSel && H.state.srcSel.gid === ((H.state.goal || {}).id || 0) && H.state.srcSel.ids.has(String(s.id));
  return `<div class="srcItem ${star ? 'isStar' : ''}">
    <div class="siHead">
      <input type="checkbox" class="siCheck" data-src-check="${s.id}" ${sel ? 'checked' : ''} title="选中（可批量删除）">
      <button class="siStar ${star ? 'on' : ''}" data-src-star="${s.id}" title="${star ? '已标注为优质信息源（规划会优先参考）' : '标注为优质信息源（规划会优先参考）'}">${star ? '★' : '☆'}</button>
      <span class="chip gray">${H.esc(s.site || '未知来源')}</span>
      <span class="chip">${H.esc(s.kind || '资料')}</span>
      ${star ? '<span class="chip ok" title="规划时优先参考">优质</span>' : ''}
      ${s.published_at ? `<span class="chip ok siDate" title="发布时间">${H.esc(s.published_at)}</span>` : '<span class="chip warn siDate" title="未标注发布时间（招聘平台在招岗位默认当前有效）">近期</span>'}
      <a class="siTitle" href="${H.esc(s.url)}" target="_blank" rel="noreferrer">${H.esc(s.title)}</a>
      <button class="btn tiny danger siDel" data-src="${s.id}" title="删除这条来源">×</button>
    </div>
    ${body ? `<details class="siDet"><summary>${H.esc(body.replace(/\s+/g, ' ').slice(0, 120))}${body.length > 120 ? '…' : ''}（${body.length} 字）</summary><div class="siFull mdBody">${H.mdToHTML(body.slice(0, 20000))}</div></details>` : ''}
  </div>`;
}

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
    <div class="ppHead"><span>🧭</span><span>${H.esc(meta.title)}（共 ${qs.length} 题${quizCount ? '，含 ' + quizCount + ' 道水平自测' : ''}，约 3-5 分钟）</span></div>
    ${data.analysis ? `<div class="ghSummary" style="margin-top:10px;"><span style="font-size:11px;font-weight:700;color:var(--accent);">AI 的分析　</span><span class="mdBody" style="display:inline-block;vertical-align:top;">${H.mdMaybe(data.analysis)}</span></div>` : ''}
    <p class="hint" style="margin:10px 0 4px;">${H.esc(meta.hint)}问卷越如实，规划越贴合你的真实水平；对哪个问题想说得更清楚，点它下方的 <b>🔍 进一步探讨</b>，AI 会追加针对性的子问题把情况问透。有硬性要求请先在下方<b>「⛓ 规划约束」</b>里添加。</p>
    <div class="clarifyQs">`;
  let lastSection = '';
  let num = 0;
  const renderTop = q => {
    const sec = q.section || '';
    if (sec && sec !== lastSection) { h += `<div class="cqSection">${H.esc(sec)}</div>`; lastSection = sec; }
    num++;
    h += questionHTML(q, String(num));
  };
  for (const q of (byParent['__root__'] || [])) renderTop(q);
  h += `</div>
    <div class="toolbarRow" style="margin-top:14px;">
      <button class="btn primary" id="clarifySubmitBtn">${H.esc(meta.sub)}</button>
      <button class="btn" id="clarifySkipBtn">${H.esc(meta.skip)}</button>
    </div>
  </div>`;
  return h;
}

/* 已有规划后的骨架调整：看大纲 → 写意见 → AI 按意见重排（回到待确认） */
function adjustPanelHTML(g) {
  const nodes = g.nodes || [];
  const stages = nodes.filter(n => n.level === 0);
  const outline = stages.map(s => {
    const subs = nodes.filter(n => n.parent_id === s.id).map(x => x.title);
    const subTxt = subs.length ? `（${subs.join(' / ')}）` : '（暂无小目标）';
    return `<div class="adjStage"><b>${H.esc(s.title)}</b><span class="muted">${H.esc(subTxt.slice(0, 140))}${subTxt.length > 140 ? '…' : ''}</span></div>`;
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

function subtreeProgress(node) {
  let total = 0, done = 0, doing = 0;
  const walk = n => {
    if (!n.children || !n.children.length) { total++; if (n.status === 'done') done++; else if (n.status === 'doing') doing++; return; }
    n.children.forEach(walk);
  };
  walk(node);
  return { total, done, doing };
}

function listTaskHTML(t) {
  const st = H.ST_LABEL[t.status] ? t.status : 'todo';
  const srcN = (t.sourcesArr || []).length;
  const gid = (H.state.goal && H.state.goal.id) || 0;
  const hasKids = !!(t.children && t.children.length);
  /* 折叠必须是**任意有子节点的任务**都能用，不能只有阶段/小目标能折。
     深度拆分出来的子任务经常一个父节点挂十几个，全摊开会把页面撑爆，
     所以任务层默认**收起**（点箭头才展开），状态跟其它折叠一起按目标记住。 */
  const tKey = 'tl-t' + t.id;
  const tClosed = hasKids ? foldClosed(gid, tKey, false) : false;
  const kids = hasKids
    ? `<div class="tlKids" data-foldbody="${tKey}"${tClosed ? ' hidden' : ''}>${t.children.map(listTaskHTML).join('')}</div>`
    : '';
  return `<div class="tlTaskWrap">
    <div class="tlTask ${st}${hasKids ? ' hasKids' : ''}" data-node-id="${t.id}" data-detail="${t.id}" title="点击查看详情 · 右键打开菜单">
      ${hasKids ? foldBtn(tKey, tClosed) : ''}
      <button class="stDot ${st}" data-cycle="${t.id}" title="点击切换状态">${st === 'done' ? '✓' : ''}</button>
      <span class="tlTaskTitle">${H.esc(t.title)}</span>
      ${t.artifact ? `<span class="tlArtifact" title="产出物：${H.esc(t.artifact)}">📦</span>` : ''}
      ${t.hours ? `<span class="chip gray tlHours">${H.esc(t.hours)}</span>` : ''}
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

/* 当前语境目标：教程页用教程所属目标（state.tutGoal），其它用 state.goal */
function goalCtx() {
  try {
    if (H.parseRoute().view === 'tutorial' && H.state.tutGoal && H.state.tutGoal.id) return H.state.tutGoal;
  } catch (e) {}
  return H.state.goal;
}

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

function cardFoldSave(gid, map) { try { localStorage.setItem('sierxing-goal-folds-' + gid, JSON.stringify(map || {})); } catch (e) {} }

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

async function startPlanning(id, answers) {
  if (H.state.planning || H.state.collecting || H.state.expanding) return;
  H.state.planning = true;
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
  if (asked) {
    H.state.pendingAsk = asked;
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
  if (rr.view === 'goal' && rr.id === id) renderGoal();
  else if (rr.view === 'map' && rr.id === id) H.renderMapPage();
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
    ebBox.innerHTML = books.length ? books.map((b, i) => `<label class="ebBook"><input type="checkbox" data-ebbook="${i}" checked>
        <span class="ebCover">📖</span>
        <span class="ebInfo"><b>《${H.esc(b.title)}》${b.author ? `<span class="muted">　${H.esc(b.author)}</span>` : ''}</b>
        ${b.pitch ? `<span class="ebPitch">${H.esc(b.pitch)}</span>` : ''}
        <span class="ebWhere">${b.public_domain ? '<span class="chip ok">公版可直下</span>' : ''}${b.where ? `<span class="muted">去哪找：${H.esc(b.where)}</span>` : ''}</span></span></label>`).join('')
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

async function ensureAIConfigured() {
  try { H.state.aiStatus = await H.api('/api/ai/status'); } catch (e) { return true; }
  if (H.state.aiStatus && H.state.aiStatus.configured) return true;
  H.toast('请先配置 AI 接入方式');
  H.go('#/settings');
  return false;
}

function drawMapLines() {
  const tree = document.querySelector('.mtree');
  if (!tree) return;
  const old = tree.querySelector('.mtlines');
  if (old) old.remove();
  const scale = H.state.mapScale || 1;
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

function mapFit() {
  const vp = document.getElementById('mapViewport');
  const tree = document.querySelector('.mtree');
  if (!vp || !tree) return;
  const vw = vp.clientWidth, vh = vp.clientHeight;
  const tw = Math.max(tree.scrollWidth, 1), th = Math.max(tree.scrollHeight, 1);
  /* 画布已按视口铺满（.mtree width:100%）：此时 tw≈vw，若再按 (vw - tw*s)/2 平移，
     画布会被右推、右侧露出底色（用户反馈的灰色框）。铺满时不再平移，只做缩放。 */
  const fillsW = tw >= vw - 2;
  const fillsH = th >= vh - 2;
  const s = Math.min(1.1, fillsW ? 1.1 : (vw - 90) / tw, fillsH ? 1.1 : (vh - 90) / th);
  H.state.mapScale = Math.max(0.25, Math.min(1.6, s));
  H.state.mapTx = fillsW ? 0 : (vw - tw * H.state.mapScale) / 2;
  H.state.mapTy = fillsH ? 0 : (vh - th * H.state.mapScale) / 2;
  applyCanvasTransform();
  drawMapLines();
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

function questionHTML(q, numLabel) {
  const isQuiz = q.type === 'quiz';
  const depth = Number(q.depth || 0);
  let h = `<div class="clarifyQ${isQuiz ? ' quizQ' : ''}${depth ? ' subQ' : ''}" data-qid="${H.esc(String(q.id))}" style="margin-left:${Math.min(depth, 3) * 16}px"${isQuiz ? ` data-answer="${H.esc(String(q.answer || ''))}" data-explain="${H.esc(q.explain || '')}"` : ''}>
    <div class="cqTitle"><span class="qnum">${H.esc(numLabel)}</span><div class="cqTitleText mdBody">${H.mdMaybe(q.title)}</div>${isQuiz ? '<span class="cqQuizTag">自测</span>' : ''}${q.desc ? `<span class="cqWhy">${H.esc(q.desc)}</span>` : ''}</div>`;
  if (q.type === 'text') {
    h += `<textarea class="cqText" placeholder="${H.esc(q.placeholder || '写下你的情况…')}"></textarea>`;
  } else {
    h += '<div class="cqOptions">';
    for (const o of (q.options || [])) {
      const v = typeof o === 'string' ? o : (o.v != null ? o.v : o.label);
      const label = typeof o === 'string' ? o : (o.label || o.v || '');
      h += `<label class="cqOpt"><input type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="cq_${H.esc(String(q.id))}" value="${H.esc(String(v))}"><span class="cqOptText mdBody">${H.mdMaybe(label)}</span></label>`;
    }
    h += '</div>';
  }
  if (isQuiz) h += '<div class="cqFeedback" hidden></div>';
  if (q.note) h += `<div class="cqNoteSaved" data-noteof="${H.esc(String(q.id))}">📝 你的补充：${H.esc(q.note)}</div>`;
  h += `<div class="cqOps">${depth < 3 ? `<button class="cqDrill" data-drill="${H.esc(String(q.id))}">🔍 进一步探讨</button>` : '<span class="cqMaxDepth">已问到最细一层</span>'}</div>`;
  h += `<div class="cqDrillBox" data-drillbox="${H.esc(String(q.id))}" hidden>
    <textarea class="cqNoteInput" placeholder="补充信息（可选）：你已经做过什么、你的特殊情况、你的偏好或顾虑…AI 会围绕它继续追问">${H.esc(q.note || '')}</textarea>
    <div class="cqDrillOps">
      <button class="btn tiny primary" data-drillgo="${H.esc(String(q.id))}">生成追问</button>
      <button class="btn tiny" data-notesave="${H.esc(String(q.id))}">仅保存补充信息</button>
      <button class="btn tiny" data-drillcancel="${H.esc(String(q.id))}">取消</button>
    </div>
  </div>`;
  h += `<div class="cqChildren" data-children="${H.esc(String(q.id))}"></div>`;
  h += '</div>';
  return h;
}

/* ===== 全屏导图页交互（拖拽 / 缩放） ===== */
function applyCanvasTransform() {
  const canvas = document.getElementById('mapCanvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${H.state.mapTx}px, ${H.state.mapTy}px) scale(${H.state.mapScale})`;
  const z = document.getElementById('zoomPct');
  if (z) z.textContent = Math.round(H.state.mapScale * 100) + '%';
}

function renderGoal() {
  /* Vue 模式下所有 "改完重绘目标页" 的旧流程都重绘 Vue 概览；显式回退才走旧渲染。 */
  try {
    const rr = H.parseRoute();
    if (rr.view === 'goal' && H.goalVueEnabled() && !window.__sxGoalForceLegacy) {
      H.renderGoalVue(rr.id);
      return;
    }
  } catch (e) {}
  window.__sxGoalForceLegacy = false;
  const g = H.state.goal;
  if (!g) { H.app.innerHTML = '<p class="muted">目标不存在</p>'; return; }
  if (!H.state.aiStatus) {
    H.api('/api/ai/status').then(st => { H.state.aiStatus = st; renderGoal(); }).catch(() => { H.state.aiStatus = {}; });
  }
  const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
  const stages = H.buildTree(g.nodes);
  const stMap = { draft: ['待规划', 'warn'], review: ['骨架待确认', 'warn'], planned: ['已规划', 'ok'], failed: ['规划失败', 'danger'] };
  const st = (g.status === 'planning' && !H.state.planning) ? ['上次规划中断', 'warn'] : (stMap[g.status] || (H.state.planning ? ['规划中…', ''] : ['待规划', 'warn']));
  let html = `<div class="page">
    <div class="goalSticky">
    <div class="pageHead">
      <button class="back js-back" data-back="#/">← 返回</button>
      <div class="spacer"></div>
    </div>
    <div class="goalBar">
      <button class="btn small" data-tbtn id="editGoalBtn">编辑目标</button>
      <button class="btn small" data-tbtn id="shareGoalBtn" title="把这份规划与资料库打包分享给别人（对方可一键导入）。默认隐去学校/公司/姓名/联系方式等隐私">🔗 分享</button>
      ${H.goalCompOn(g, 'workspace') ? '<button class="btn small" data-tbtn id="wsPackBtn" title="把整个目标的代码目录一键打包成 zip 下载（一个节点对应一个文件夹，子目录嵌在父目录下）">📦 打包代码</button>' : ''}
      ${H.goalCompOn(g, 'chat') ? '<button class="btn small" data-tbtn id="chatBtn">💬 AI 助手</button>' : ''}
      ${pluginButtonsHTML(g)}
      ${goalPluginsHTML(g)}
      ${g.nodes.length && H.goalCompOn(g, 'versions') ? '<button class="btn small" data-tbtn id="verBtn">📜 版本对比</button>' : ''}
      <button class="btn small primary" data-tbtn id="planBtn" title="重新规划（会清空现有路径，请三思；微调骨架用下面的调整面板）">${g.nodes.length ? '重新规划（AI 先澄清）' : '开始 AI 规划（AI 先澄清）'}</button>
      <button class="btn small danger" data-tbtn id="delGoalBtn">删除</button>
      <button class="btn small" id="goalMoreBtn" data-morebtn-of="goal" hidden>⋯</button>
    </div>
    <div class="tutFavBar" id="goalFavBar" hidden></div>
    </div>
    <div class="goalHead">
      <div class="ghTop"><h2 class="ghTitle">${H.esc(g.title)}</h2><span class="chip ${st[1]}">${st[0]}</span>${foldBtn('head', foldClosed(g.id, 'head', true))}</div>
      <div data-foldbody="head"${foldClosed(g.id, 'head', true) ? ' hidden' : ''}>
      ${g.summary ? `<div class="ghSummary">规划思路：${H.mdOneLine(g.summary)}</div>` : ''}
      <div class="ghMeta">
        ${g.profile ? `<div class="ghItem"><span class="ghLabel">现状</span>${H.esc(g.profile)}</div>` : ''}
        ${g.weekly_hours ? `<span class="chip gray">每周 ${H.esc(g.weekly_hours)}</span>` : ''}
        ${g.deadline ? `<span class="chip gray">期限 ${H.esc(g.deadline)}</span>` : ''}
        <span class="chip gray">任务完成 ${g.tasks_done}/${g.tasks_total}</span>
      </div>
      <div class="bar big"><div class="barFill" style="width:${pct}%"></div></div>
      ${g.error ? `<div class="goalError">⚠ ${H.esc(g.error)}</div>` : ''}
      ${(g.error && H.state.planResumeInfo && H.state.planResumeInfo.goalId === g.id) ? `<div style="margin-top:8px;"><button class="btn small primary" id="planResumeDraftBtn" title="把上次失败保留的原始构思喂回去，让 AI 按正确格式整理，不用从头再想">🧭 继续构思${H.state.planResumeInfo.rawLen ? `（已保留约 ${(H.state.planResumeInfo.rawLen / 1000).toFixed(1)}k 字构思${H.state.planResumeInfo.attempts ? `，第 ${H.state.planResumeInfo.attempts + 1} 次整理` : ''}）` : ''}</button></div>` : ''}
      </div>
    </div>
    <div id="continueCard"></div>`;
  html += setupCardHTML();
  html += H.reportCardHTML();
  if (H.goalCompOn(g, 'tutorial')) html += H.tutorialCardHTML();
  if (H.goalCompOn(g, 'constraints')) html += constraintsCardHTML(g);
  if (H.goalCompOn(g, 'sources')) html += srcPanelHTML();
  html += H.expandPanelHTML();
  html += H.tutProgressHTML();
  html += planPanelHTML();
  if (H.state.showEdit) html += editGoalHTML(g);
  if (stages.length) {
    html += nextCardHTML(g);
    html += viewBarHTML(g);
    const fStages = filterTree(stages);
    html += `<div data-foldbody="map"${foldClosed(g.id, 'map', true) ? ' hidden' : ''}>` + listViewHTML(fStages) + '</div>';
  } else if (!H.state.planning) {
    html += `<div class="emptyBox" style="margin-top:8px;">
      <div class="ebIcon">🧭</div>
      <div class="ebTitle">还没有路径</div>
      <div class="ebText">${g.status === 'failed' ? '上次规划失败。' : ''}点「开始 AI 规划」：AI 会先问你几个问题摸清情况，再生成 阶段 → 小目标 → 任务 的路径。<br><span class="muted">想让它依据真实资料的话，可以先「收集信息源」或「导入代码库」（可选，不弄也能规划）。</span></div>
      <button class="btn primary" id="emptyPlanBtn">开始 AI 规划</button>
    </div>`;
  }
  html += '</div>';
  H.app.innerHTML = html;

  H.bindReportCard();
  H.bindTutorialCard();
  try { renderContinueCard(g.id); } catch (e) {}
  pluginGoButtonsBind();     // 组件入口按钮（每日刷题 / 图片资料…）
  bindConstraints(g);
  const chatBtn = document.getElementById('chatBtn');
  if (chatBtn) chatBtn.addEventListener('click', () => H.aiToggle(true));
  const verBtn = document.getElementById('verBtn');
  if (verBtn) verBtn.addEventListener('click', () => H.showVersionsPanel(g.id));
  if (window.Workspace && H.goalCompOn(g, 'workspace')) { try { window.Workspace.bindGoal(g); } catch (e) {} }
  const planBtnEl = document.getElementById('planBtn');
  planBtnEl.addEventListener('click', () => {
    if ((g.nodes || []).length && !confirm('重新规划会清空现有路径（含任务进度）后从头生成。\n\n只想微调阶段/小目标？用下面的「调整规划骨架」，不用推倒重来。\n\n确定要全部推倒重来吗？')) return;
    H.startClarify(g.id);
  });
  const resumeDraftBtn = document.getElementById('planResumeDraftBtn');
  if (resumeDraftBtn) resumeDraftBtn.addEventListener('click', () => startPlanResume(g.id));
  const emptyPlan = document.getElementById('emptyPlanBtn');
  if (emptyPlan) emptyPlan.addEventListener('click', () => H.startClarify(g.id));
  const starBtns = H.app.querySelectorAll('[data-src-star]');
  starBtns.forEach(b => b.addEventListener('click', async () => {
    const id = Number(b.getAttribute('data-src-star'));
    const cur = (H.state.sources || []).find(x => Number(x.id) === id);
    const next = !(cur && Number(cur.quality) === 1);
    try {
      const r = await H.api('/api/sources/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: next }) });
      H.state.sources = r.sources || H.state.sources;
      H.toast(next ? '已标为优质信息源：规划时会优先参考' : '已取消优质标记');
      renderGoal();
    } catch (e) { H.toast(e.message); }
  }));
  const addBtn = document.getElementById('srcAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => { H.state.srcFormOpen = !H.state.srcFormOpen; renderGoal(); });
  const sfCancel = document.getElementById('sfCancel');
  if (sfCancel) sfCancel.addEventListener('click', () => {
    H.state.srcFormOpen = false; H.state.srcFormTitle = ''; H.state.srcFormContent = ''; H.state.srcFormUrl = ''; H.state.srcFormSite = ''; H.state.srcFormQuality = false; renderGoal();
  });
  const sfPaste = document.getElementById('sfPaste');
  if (sfPaste) sfPaste.addEventListener('click', async () => {
    try { const t = await navigator.clipboard.readText(); const el = document.getElementById('sfContent'); if (el && t) { el.value = t; H.toast('已粘贴 ' + t.length + ' 字'); } }
    catch (e) { H.toast('读取剪贴板失败，请直接在文本框里按 Ctrl+V 粘贴'); }
  });
  const sfSave = document.getElementById('sfSave');
  if (sfSave) sfSave.addEventListener('click', async () => {
    const title = (document.getElementById('sfTitle') || {}).value || '';
    const content = (document.getElementById('sfContent') || {}).value || '';
    const kind = (document.getElementById('sfKind') || {}).value || '资料';
    const site = (document.getElementById('sfSite') || {}).value || '手动添加';
    const url = (document.getElementById('sfUrl') || {}).value || '';
    const quality = !!(document.getElementById('sfQuality') || {}).checked;
    if (!title.trim() && !content.trim()) return H.toast('请填写标题或粘贴正文');
    sfSave.disabled = true; sfSave.textContent = '保存中…';
    try {
      const r = await H.api('/api/goals/' + g.id + '/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, kind, site, url, quality }) });
      H.state.sources = r.sources || H.state.sources;
      H.state.goal = r.goal || H.state.goal;
      H.state.srcFormOpen = false; H.state.srcFormTitle = ''; H.state.srcFormContent = ''; H.state.srcFormUrl = ''; H.state.srcFormSite = ''; H.state.srcFormQuality = false;
      H.toast('已添加资料' + (quality ? '（优质信息源）' : ''));
      renderGoal();
    } catch (e) { H.toast(e.message); sfSave.disabled = false; sfSave.textContent = '保存为资料'; }
  });
  const cb = document.getElementById('collectBtn');
  if (cb) cb.addEventListener('click', () => startCollect(g.id));
  const cpb = document.getElementById('collectPlanBtn');
  if (cpb) cpb.addEventListener('click', async () => {
    if (await ensureCollectSetup(g.id, true)) H.toast('搜集方案已保存，下次搜集生效');
  });
  const cs = document.getElementById('collectStop');
  if (cs) cs.addEventListener('click', () => { if (H.state.collectAbort) H.state.collectAbort.abort(); });
  const db2 = document.getElementById('digestBtn');
  if (db2) db2.addEventListener('click', () => startDigest(g.id));
  const ds = document.getElementById('digestStop');
  if (ds) ds.addEventListener('click', () => { if (H.state.digestAbort) H.state.digestAbort.abort(); });
  H.app.querySelectorAll('[data-digest-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这篇提炼汇总？')) return;
    try { await H.api('/api/digests/' + b.getAttribute('data-digest-del'), { method: 'DELETE' });
      H.state.digests = (H.state.digests || []).filter(x => String(x.id) !== String(b.getAttribute('data-digest-del')));
      H.toast('已删除'); renderGoal();
    } catch (e) { H.toast(e.message); }
  }));
  if (H.state.planning || H.state.collecting) {
    planBtnEl.disabled = true;
    if (cb) cb.disabled = true;
    document.getElementById('delGoalBtn').disabled = true;
  }
  H.app.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => {
    H.state.filter = el.getAttribute('data-filter');
    renderGoal();
  }));
  const nid = g.next_task_id;
  if (nid) {
    [['nextStart', 'doing'], ['nextDone', 'done'], ['nextPause', 'todo']].forEach(([id, status]) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', async () => {
        try {
          const r = await H.api('/api/nodes/' + nid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
          H.state.goal = r.goal;
          renderGoal();
          H.toast(status === 'done' ? '已完成 ✓' : '已更新');
        } catch (e) { H.toast(e.message); }
      });
    });
    const no = document.getElementById('nextOpen');
    if (no) no.addEventListener('click', e => { e.stopPropagation(); H.showNodePanel(nid); });
  }
  H.app.querySelectorAll('.siDel').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-src');
    try {
      await H.api('/api/sources/' + sid, { method: 'DELETE' });
      H.state.sources = H.state.sources.filter(s => String(s.id) !== String(sid));
      H.state.srcListOpen = true;
      renderGoal();
      H.toast('已删除该来源');
    } catch (err) { H.toast(err.message); }
  }));
  /* 执行页清单的行点击由共用的 bindTreeEvents 处理（含按钮守卫），这里不再重复绑定 */
  const gid0 = (H.state.goal && H.state.goal.id) || 0;
  const srcSelSet = () => {
    if (!H.state.srcSel || H.state.srcSel.gid !== gid0) H.state.srcSel = { gid: gid0, ids: new Set() };
    return H.state.srcSel.ids;
  };
  const refreshSrcBar = () => {
    const ids = srcSelSet();
    const bar = document.querySelector('.spListBar');
    if (bar) {
      const n = (H.state.sources || []).filter(s => ids.has(String(s.id))).length;
      const all = document.getElementById('srcSelAll');
      if (all) { all.checked = n > 0 && n === (H.state.sources || []).length; }
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
      const r = await H.api('/api/goals/' + gid0 + '/sources/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      H.state.sources = r.sources || [];
      H.state.srcSel = { gid: gid0, ids: new Set() };
      H.state.srcListOpen = true;
      renderGoal();
      H.toast(`已删除 ${r.deleted} 条`);
    } catch (err) { H.toast(err.message); }
  };
  H.app.querySelectorAll('.siCheck').forEach(box => box.addEventListener('change', () => {
    const ids = srcSelSet();
    const sid = String(box.getAttribute('data-src-check'));
    if (box.checked) ids.add(sid); else ids.delete(sid);
    box.closest('.srcItem').classList.toggle('selected', box.checked);
    refreshSrcBar();
  }));
  const selAll = document.getElementById('srcSelAll');
  if (selAll) selAll.addEventListener('change', () => {
    const ids = srcSelSet();
    H.app.querySelectorAll('.siCheck').forEach(box => {
      box.checked = selAll.checked;
      const sid = String(box.getAttribute('data-src-check'));
      if (selAll.checked) ids.add(sid); else ids.delete(sid);
      box.closest('.srcItem').classList.toggle('selected', selAll.checked);
    });
    refreshSrcBar();
  });
  const det = document.getElementById('spDetails');
  if (det) det.addEventListener('toggle', () => { H.state.srcListOpen = det.open; });
  const clearBtn = document.getElementById('srcClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    const nS = (H.state.sources || []).length;
    if (!nS) return;
    if (!confirm(`确定清空本目标全部 ${nS} 条信息源？\n\n已导入的图片 / 电子书原件也会一并删除，不可恢复。\n（如需恢复，可从 data/backups 里找自动备份）`)) return;
    clearBtn.disabled = true;
    try {
      const r = await H.api('/api/goals/' + gid0 + '/sources/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      H.state.sources = [];
      H.state.srcSel = { gid: gid0, ids: new Set() };
      try { const jr = await H.api('/api/goals/' + gid0 + '/jd-images'); H.state.jdImages = jr.images || []; } catch (e) {}
      try { await H.loadGoal(gid0); } catch (e) {}
      renderGoal();
      H.toast(`已清空：信息源 ${r.deletedSources} 条${r.deletedFiles ? '、原件 ' + r.deletedFiles + ' 个' : ''}`);
    } catch (err) { H.toast(err.message); clearBtn.disabled = false; }
  });
  document.getElementById('delGoalBtn').addEventListener('click', async () => {
    if (!confirm('删除这个目标和它的全部路径？')) return;
    try { await H.api('/api/goals/' + g.id, { method: 'DELETE' }); H.toast('已删除'); H.go('#/'); } catch (e) { H.toast(e.message); }
  });
  document.getElementById('editGoalBtn').addEventListener('click', () => { H.state.showEdit = !H.state.showEdit; renderGoal(); });
  const shareBtn = document.getElementById('shareGoalBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => showShareDialog(g.id));
  const gpBtn = document.getElementById('goalPluginsBtn');
  if (gpBtn) gpBtn.addEventListener('click', () => {
    if (document.getElementById('goalPluginMenu')) document.getElementById('goalPluginMenu').remove();
    else showGoalPluginsMenu(g.id, gpBtn);
  });
  const ef = document.getElementById('editGoalForm');
  if (ef) {
    document.getElementById('egCancel').addEventListener('click', () => { H.state.showEdit = false; renderGoal(); });
    ef.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const { goal } = await H.api('/api/goals/' + g.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          title: document.getElementById('egTitle').value,
          profile: document.getElementById('egProfile').value,
          materials: document.getElementById('egMaterials').value,
          weekly_hours: document.getElementById('egHours').value,
          deadline: document.getElementById('egDeadline').value
        }) });
        H.state.goal = goal; H.state.showEdit = false; renderGoal(); H.toast('已保存（可重新规划使新信息生效）');
      } catch (err) { H.toast(err.message); }
    });
  }
  if (H.state.planning) bindPlanningPanel();
  H.bindPlanPanel();
  bindTreeEvents(renderGoal);
}

  function mountGoal(host) {
    H = host || {};
    return {
      render: function () { return renderGoal(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['goal'] = { id: 'goal', mount: mountGoal };
})();
