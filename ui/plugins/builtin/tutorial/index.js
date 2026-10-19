'use strict';
/**
 * 内置 UI 插件 · 教程阅读页（#/t/:id）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/tutorial/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

function rewriteCites(html) {
  let t = String(html || '');
  const pres = [];
  t = t.replace(/<pre[\s\S]*?<\/pre>/gi, m => { pres.push(m); return '\u0000CITE' + (pres.length - 1) + '\u0000'; });
  t = t.replace(/\[(\d{3,7})\]/g, (m, id) => '<sup class="cite" data-cite="' + id + '" title="点击查看引用了什么">⧉</sup>');
  t = t.replace(/\u0000CITE(\d+)\u0000/g, (m, i) => pres[Number(i)]);
  return t;
}

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

function openTutRename(tid, tut) {
  const old = document.getElementById('tutRenameDlg');
  if (old) old.remove();
  const span = document.getElementById('tutTitle');
  const cached = ((H.state.goal && H.state.goal.tutorials) || []).find(x => Number(x.id) === Number(tid));
  const cur = String((tut && tut.title) || (cached && cached.title) || (span ? span.textContent : '') || '').replace(/^📘\s*/, '');
  const D = document.createElement('div');
  D.className = 'bigDialog';
  D.id = 'tutRenameDlg';
  D.style.width = 'min(460px, 92vw)';
  D.style.maxHeight = 'none';
  D.innerHTML = `<div class="tdHead"><span class="bdTitle">✎ 重命名教程<div class="bdSub">只改标题，正文不动。最多 80 字，允许和别的教程重名。</div></span><div class="spacer" style="flex:1"></div><button class="btn tiny" data-rclose>✕</button></div>
    <div class="tdBody">
      <input id="tutRenameInput" type="text" maxlength="80" value="${H.esc(cur)}" style="width:100%; box-sizing:border-box; padding:9px 11px; font-size:14px; background:var(--bg); color:var(--text); border:1.5px solid var(--border); border-radius:10px;" />
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
    if (!title) { H.toast('标题不能为空'); input.focus(); return; }
    try {
      const r = await H.api('/api/tutorials/' + tid + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const nt = String((r && r.title) || title);
      if (tut) tut.title = nt;
      if (cached) cached.title = nt;
      if (span) span.textContent = '📘 ' + nt;
      try { if (r && r.tutorial) H.state.tutUpdatedAt = r.tutorial.updated_at || H.state.tutUpdatedAt; } catch (e) {}
      close();
      H.toast('已重命名为「' + nt.slice(0, 30) + '」');
    } catch (e) { H.toast(e.message); }
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

async function renderTutorialPage(tid, keepPos) {
  /* Vue 模式下（默认）所有 "改完重绘教程" 的旧流程（手动保存 / 历史版本恢复 / AI 改版）
     都统一重绘 Vue 阅读页；只有显式回退时才走旧渲染。 */
  if (H.tutorialVueEnabled() && !window.__sxTutForceLegacy) {
    try { if (await H.renderTutorialVue(tid)) return; } catch (e) { console.warn('[tutorial] Vue 重绘失败，回退旧版', e); }
  }
  window.__sxTutForceLegacy = false;
  if (H.mdInlineActive()) H.mdInlineClose(false);   // 换了页/重画整页：就地编辑框随之作废
  /* 同一个教程的**整页重画**（🕘 历史版本恢复、AI 改版、任务轮询）：先记下当前锚点，
     渲染完再对回去。否则正文被整段换掉时文档先变短，浏览器把滚动夹回顶部 ——
     用户看到的就是"位置又跳了"（实测 14061 → 0）。锚点 = 块行号 + 视口内偏移。
     ⚠️ 只认调用方显式要求（keepPos）：深链进来时 renderTutorialPage 会被调两次
     （模块加载时 + route()），第二次进来 DOM 里已经躺着刚渲染好的同一篇教程，
     照"DOM 是同名教程"去记锚点就会把"顶部"当成阅读位置，把 localStorage 里的真位置覆盖掉。 */
  let tutKeepAt = null;
  try {
    const rr0 = H.parseRoute();
    if (keepPos && rr0.view === 'tutorial' && Number(rr0.id) === Number(tid) && Number(window.__tutRenderedTid) === Number(tid) &&
        (document.getElementById('tutFrame') || document.querySelector('#app .tutBody'))) {
      tutKeepAt = H.tutAnchorNow(null, (window.__tutCur && window.__tutCur.idx) || 0);
    }
  } catch (e) {}
  H.app.innerHTML = '<p class="muted">加载教程…</p>';
  try { window.__tutCur = null; window.__tutTotal = 0; } catch (e) {}
  const r = await H.api('/api/tutorials/' + tid);
  const t = r.tutorial, node = r.node, goal = r.goal;
  H.state.tutGoalId = t ? t.goal_id : 0;   // 侧边栏绑定到该目标的会话（刷新也不丢记录）
  H.state.tutGoalTid = t ? t.id : 0;       // 当前教程 id（左栏「路线图」按它认目标）
  H.state.tutGoal = goal || null;          // 教程语境目标：组件开关按它判定，不串到别的目标
  H.state.tutUpdatedAt = t ? (t.updated_at || '') : '';   // 任务轮询用它判断内容是否真变了
  await H.ensureCiteCache(t ? t.goal_id : 0);   // 正文里的 [id] 引用要能解释成节点/资料
  const isHtml = t.format === 'html';
  try { H.state.tutFmt = t.format; H.state.tutNodeId = node ? node.id : 0; } catch (e) {}
  /* 记下**这份被渲染的源码**：就地编辑单块按 data-src/data-srce 切行要用它，
     必须与生成 DOM 的是同一份（重新 GET 一份万一不一致，行号就错位了）。 */
  H.tutRenderedSrc = isHtml ? '' : (t.content || '');
  const sizeK = Math.max(1, Math.round((t.content || '').length / 1000));
  H.app.innerHTML = `<div class="tutPage">
    <div class="tutSticky">
    <div class="tutHead">
      <button class="back" data-go="#/g/${t.goal_id}">← 返回目标</button>
      <button class="btn small" data-tbtn id="tutEditBtn" title="在右侧对话栏里说你想怎么改，AI 会按意见修改（保留原有内容，只改需要改的地方）">💬 让 AI 修改</button>
      <button class="btn small" data-tbtn id="tutVersBtn" title="每次 AI 修改/手动保存都会留一版，改坏了从这里恢复（恢复前会自动存当前版，所以恢复也可撤销）">🕘 历史版本</button>
      <button class="btn small" data-tbtn id="tutTocBtn" title="显示 / 隐藏左侧目录">📑 目录</button>
      ${((H.goalCompOn(goal, 'notes') || H.goalCompOn(goal, 'tutnotes')) && window.NodeNotes) ? `<button class="btn small" data-tbtn id="tutNoteBtn" title="展开 / 收起右侧笔记栏（🗒 Markdown 笔记 / 📌 划线笔记 两个页签）">🗒 笔记</button>` : ''}
      ${(H.goalCompOn(goal, 'tutbookmark') && window.TutBookmark) ? `<button class="btn small" data-tbtn id="tutBmBtn" title="随时标记阅读位置（不用翻到底部）">🔖 标签</button>` : ''}
      ${H.goalCompOn(goal, 'restate') ? `<button class="btn small" data-tbtn id="tutRestateBtn" title="循序渐进把知识点变成你自己的话：先搞懂前因后果，AI 一次只追问最关键的一个缺口、给方向不给答案">🧠 用自己的话</button>` : ''}
      ${H.goalCompOn(goal, 'explain') ? `<button class="btn small" data-tbtn id="tutExplainBtn" title="这段代码没看懂？贴进来让 AI 逐行讲明白：左边是代码、右边是讲解，点哪一行就看哪一行，哪行没看懂就在哪行下面追问">🔍 看懂代码</button>` : ''}
      ${H.goalCompOn(goal, 'quiz') ? `<button class="btn small" data-tbtn id="tutQuizBtn" title="按这篇教程逐点考察掌握情况（一次一题，答错可追问）">📝 测验</button>` : ''}
      ${(H.goalCompOn(goal, 'workspace') && window.Workspace) ? `<button class="btn small primary" data-tbtn id="tutCodeBtn" title="为当前节点建好代码目录并用 VSCode 打开，边看教程边写代码（子目录嵌在父目录下，无需手动管理）">💻 写代码</button>` : ''}
      ${(H.goalCompOn(goal, 'workspace') && window.Workspace) ? `<button class="btn small" data-tbtn id="tutPackBtn" title="把整个目标的代码目录一键打包成 zip 下载">📦 打包</button>` : ''}
      <button class="btn small" data-tbtn id="tutManualBtn" title="直接手动编辑并保存。也可以直接在正文里点某一段：会进编辑并定位到那一句（Markdown 教程）">✎ 手动编辑</button>
      <button class="btn small" data-tbtn id="tutRenameBtn" title="给这份教程改个名（只改标题，正文不动）。同一个任务生成的多份教程全靠标题区分">✎ 重命名</button>
      <button class="btn small primary" id="tutSaveBtn" hidden>💾 保存</button>
      <button class="btn small" id="tutCancelBtn" hidden>取消</button>
      <span class="mapTitle" id="tutTitle">📘 ${H.esc(t.title)}</span>
      <span class="chip gray">${isHtml ? 'HTML' : 'Markdown'}</span>
      <span class="chip gray">约 ${sizeK}k 字</span>
      <div class="spacer"></div>
      <button class="btn small" id="tutMoreBtn" data-morebtn-of="tut" hidden>⋯</button>
      <button class="btn small" data-tbtn id="tutDl">下载</button>
      <button class="btn small danger" data-tbtn id="tutDel">删除</button>
    </div>
    <div class="tutFavBar" id="tutFavBar" hidden></div>
    </div>
    <div class="tutMeta">${node ? '对应任务：' + H.esc(node.title) : ''}${goal ? '　·　所属目标：' + H.esc(goal.title) : ''}　·　生成于 ${H.esc(H.fmtDate(t.created_at))}${(H.goalCompOn(goal, 'workspace') && window.Workspace) ? '　·　<span class="wsHint" id="wsHint"></span>' : ''}</div>
    ${isHtml
      ? `<iframe class="tutFrame" id="tutFrame" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`
      : `<div class="tutBody mdBody">${H.mdToHTML(t.content, { viz: true, srcLines: true })}</div>`}
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
      try { H.tutTocBuild(tid); } catch (e) {}
      /* 体检正文自带目录：锚点不存在 = 教程被截断（点目录没反应的真正原因） */
      try {
        const dead = H.tutBodyAnchors().filter(x => x.dead);
        if (dead.length) H.tutTruncNotice(dead);
      } catch (e) { console.warn('[tutorial] 截断体检失败', e); }
    };
    fr.addEventListener('load', build, { once: true });
    fr.setAttribute('srcdoc', H.withCiteHook(H.tutThemedHTML(rewriteCites(cleanHtmlForFrame(t.content)))));
    setTimeout(build, 1500);   // 兜底：万一 load 没触发
  }
  setTimeout(() => { try { H.tutTocBuild(tid); } catch (e) {} }, 200);   // 侧边目录大纲
  const tutNoteBtn = document.getElementById('tutNoteBtn');
  if (tutNoteBtn && window.NodeNotes && (H.goalCompOn(goal, 'notes') || H.goalCompOn(goal, 'tutnotes'))) {
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
    try { H.tutTocBuild(tid); } catch (e) {}
  });
  if (window.TutBookmark && H.goalCompOn(goal, 'tutbookmark')) {
    window.TutBookmark.badge(tid);
    const tbb = document.getElementById('tutBmBtn');
    if (tbb) tbb.addEventListener('click', () => window.TutBookmark.toggle(tid));
  }
  /* 划线笔记：正文可能是主文档（Markdown），也可能是 iframe（HTML）—— 插件自己等正文就绪。
     入口已并进右侧「🗒 笔记」栏的「📌 划线笔记」页签（TutNotes.renderInto），工具条上不再单设按钮：
     两个按钮一个功能只会互相矛盾，这里只负责装载状态机 + 把监听挂到正文上。 */
  if (window.TutNotes && H.goalCompOn(goal, 'tutnotes')) {
    try { window.TutNotes.mount(tid); } catch (e) { console.warn('[tutnotes] mount 失败', e); }
  }
  if (H.goalCompOn(goal, 'restate')) {
    const trs = document.getElementById('tutRestateBtn');
    if (trs) trs.addEventListener('click', () => { location.hash = '#/t/' + tid + '/restate'; });
  }
  if (H.goalCompOn(goal, 'quiz')) {
    const tq = document.getElementById('tutQuizBtn');
    if (tq) tq.addEventListener('click', () => { location.hash = '#/t/' + tid + '/quiz'; });
  }
  if (H.goalCompOn(goal, 'explain')) {
    const te = document.getElementById('tutExplainBtn');
    if (te) te.addEventListener('click', () => { location.hash = '#/t/' + tid + '/explain'; });
  }
  H.applyBarOverflow('tut');

  if (window.Workspace && H.goalCompOn(goal, 'workspace')) {
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
    try { await H.api('/api/tutorials/' + tid, { method: 'DELETE' }); H.toast('已删除'); H.go('#/g/' + t.goal_id); } catch (e) { H.toast(e.message); }
  });
  /* 整页重画后把阅读位置对回去（见函数开头记下的 tutKeepAt）：
     等正文（含 iframe 的 HTML 教程）就绪，再按锚点跳 + 校正到高度稳定为止。 */
  if (tutKeepAt) setTimeout(() => { try { H.tutRestoreSettled(tutKeepAt, { noLock: true }); } catch (e) {} }, isHtml ? 300 : 150);
  try { window.__tutRenderedTid = Number(tid); } catch (e) {}
}

  function mountTutorial(host) {
    H = host || {};
    return {
      render: function () { return renderTutorialPage(H.__tid); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['tutorial'] = { id: 'tutorial', mount: mountTutorial };
})();
