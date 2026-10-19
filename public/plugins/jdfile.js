/**
 * 思而行 · 前端插件：信息源导入（图片 / 电子书 → 资料库）
 * ------------------------------------------------------------------
 * 截图粘贴 / 批量多选 / 整个文件夹 / 拖拽（含子目录）→ 图片走视觉模型识别、
 * 电子书本地解析后提炼 → 逐个显示进度，自动跳过已在库的电子书 → 写入资料源。
 */
'use strict';
(function () {
  const { api, esc, toast, go, state, mdToHTML, fmtDate, safeParse } = SiErXing;

  /* ---------- Vue 版页面（渐进迁移；加载失败自动回退旧页面） ---------- */
  let jdfileVueUnmount = null;
  function jdfileVueEnabled() {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q === 'legacy') return false;
      if (q === 'vue') return true;
      const saved = localStorage.getItem('sierxing-ui-jdfile');
      if (saved === 'legacy') return false;
      if (saved === 'vue') return true;
    } catch (e) {}
    return false;   /* 默认原版界面（Vue 版仍在，?ui=vue 可体验）*/
  }
  function ensureJdfileVueCss() {
    if (document.querySelector('link[data-ui-page="jdfile"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui-dist/jdfile.css'; l.setAttribute('data-ui-page', 'jdfile');
    document.head.appendChild(l);
  }
  async function renderJDFilePageVue(goalId) {
    const root = document.getElementById('app');
    if (!root) throw new Error('页面容器不存在');
    if (jdfileVueUnmount) { try { jdfileVueUnmount(); } catch (e) {} jdfileVueUnmount = null; }
    ensureJdfileVueCss();
    const mod = await import('/ui-dist/jdfile.js?v=' + Date.now());
    if (!mod || typeof mod.mountJdFilePage !== 'function') throw new Error('UI 插件没有导出 mountJdFilePage');
    jdfileVueUnmount = mod.mountJdFilePage(root, { api: api, toast: toast, fmtDate: fmtDate, aiToggle: SiErXing.aiToggle, goalId: Number(goalId) || 0 });
    return true;
  }
  window.addEventListener('hashchange', function () {
    if (jdfileVueUnmount && !/^#\/g\/\d+\/jd/.test(location.hash)) {
      try { jdfileVueUnmount(); } catch (e) {}
      jdfileVueUnmount = null;
    }
  });

async function renderJDPage() {
  const g = state.goal;
  app.innerHTML = '<p class="muted">加载资料…</p>';
  const r = await api('/api/goals/' + g.id + '/jd-images');
  state.jdImages = r.images || [];
  drawJDPage();
}
const EBOOK_EXTS = ['txt', 'md', 'markdown', 'text', 'log', 'pdf', 'epub', 'mobi', 'azw', 'azw3'];
function jdFileExt(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
function isEbookJD(jd) {
  if (!jd) return false;
  if (jd.mime && !String(jd.mime).startsWith('image/')) return true;
  return EBOOK_EXTS.includes(jdFileExt(jd.file));
}
/* 电子书卡片：文件入口 + 章节目录 + 提炼内容（与图片卡片同结构，便于统一删/重试） */
function ebookCardHTML(jd, ex) {
  const sec = (title, arr) => (Array.isArray(arr) && arr.length) ? `<div class="jdSec"><div class="jdSecT">${esc(title)}</div><ul>${arr.map(x => `<li>${esc(String(x))}</li>`).join('')}</ul></div>` : '';
  const meta = (ex && ex._ebook) || {};
  const ext = (jdFileExt(jd.file) || (meta.kind || '')).toLowerCase();
  const from = (ex && (ex.source || ex.company)) || meta.author || '';
  const chaps = Array.isArray(meta.chapters) ? meta.chapters : [];
  const infoBits = [meta.kind || ext, meta.chars ? '约 ' + meta.chars + ' 字' : '', meta.truncated ? '超长截断' : ''].filter(Boolean).join(' · ');
  return `<div class="jdCard" data-jdid="${jd.id}">
    <a class="jdThumb jdFile" href="/uploads/${encodeURIComponent(jd.file)}" target="_blank" title="打开 / 下载原文件"><span class="jdFileIcon">📚</span><span class="jdFileExt">${esc(ext || 'ebook')}</span></a>
    <div class="jdMain">
      <div class="jdTop"><span class="jdTitle">${esc(jd.title || meta.filename || '电子书')}</span><span class="chip">书籍</span>${infoBits ? `<span class="chip gray">${esc(infoBits)}</span>` : ''}<span class="chip gray">${esc(fmtDate(jd.created_at))}</span><div class="spacer"></div><button class="btn tiny danger jdDel" data-jdid="${jd.id}">删除</button></div>
      ${ex ? `<div class="jdSum">${esc(ex.summary || '')}</div>` : ''}
      ${ex ? `<details class="jdDet"><summary>查看提炼内容（章节 / 要点 / 关键词 / 关键项）</summary>
        ${sec('章节目录', chaps.slice(0, 60))}${sec('关键要点', ex.points)}${sec('结构化内容', ex.sections || ex.duties || ex.requirements)}${sec('关键词', ex.keywords || ex.skills)}${sec('硬性条件 / 前置知识', ex.hard_conditions)}${sec('最关键内容', ex.priority)}${sec('建议行动', ex.actions)}
        ${from ? `<div class="jdSec"><div class="jdSecT">其他信息</div><ul><li>来源：${esc(from)}</li></ul></div>` : ''}
        ${ex.raw_text ? `<div class="jdSec"><div class="jdSecT">原文摘录</div><pre class="jdRaw">${esc(String(ex.raw_text).slice(0, 1500))}</pre></div>` : ''}
      </details>` : ''}
      ${(jd.status === 'failed' || (jd.source_id && jd.source_exists === false)) ? `<div class="jdFail">${jd.status === 'failed' ? '⚠️ 提炼失败：' + esc(jd.error || '未知原因') : '⚠️ 这条资料源已在「信息源」里被删除，点「重试识别」可重新导入'}</div>
        <div class="jdOps"><button class="btn tiny primary jdRetry" data-jdid="${jd.id}">🔄 重试识别</button><span class="muted" style="font-size:11.5px;">重新提炼并更新信息源，不用重新上传</span></div>` : ''}
      <div class="jdSrc">${jd.status === 'failed' ? '尚未导入资料库' : '已导入资料库（' + (jd.source_id ? '#' + jd.source_id : '—') + '），AI 规划与对话时会优先参考'} · <a href="/uploads/${encodeURIComponent(jd.file)}" target="_blank">下载原文件</a></div>
    </div>
  </div>`;
}
function jdCardHTML(jd) {
  let ex = null;
  try { ex = JSON.parse(jd.extracted || 'null'); } catch (e) {}
  if (isEbookJD(jd)) return ebookCardHTML(jd, ex);
  const sec = (title, arr) => (Array.isArray(arr) && arr.length) ? `<div class="jdSec"><div class="jdSecT">${esc(title)}</div><ul>${arr.map(x => `<li>${esc(String(x))}</li>`).join('')}</ul></div>` : '';
  const type = ex && ex.type ? String(ex.type) : '';
  const from = ex ? (ex.source || ex.company || '') : '';
  const other = (from || (ex && ex.location) || (ex && ex.salary)) ? `<div class="jdSec"><div class="jdSecT">其他信息</div><ul>${from ? `<li>来源：${esc(from)}</li>` : ''}${ex.location ? `<li>地点：${esc(ex.location)}</li>` : ''}${ex.salary ? `<li>薪资：${esc(ex.salary)}</li>` : ''}</ul></div>` : '';
  return `<div class="jdCard" data-jdid="${jd.id}">
    <a class="jdThumb" href="/uploads/${encodeURIComponent(jd.file)}" target="_blank"><img src="/uploads/${encodeURIComponent(jd.file)}" alt="图片资料"></a>
    <div class="jdMain">
      <div class="jdTop"><span class="jdTitle">${esc(jd.title || '图片资料')}</span>${type ? `<span class="chip">${esc(type)}</span>` : ''}<span class="chip gray">${esc(fmtDate(jd.created_at))}</span><div class="spacer"></div><button class="btn tiny danger jdDel" data-jdid="${jd.id}">删除</button></div>
      ${ex ? `<div class="jdSum">${esc(ex.summary || '')}</div>` : ''}
      ${ex ? `<details class="jdDet"><summary>查看提炼内容（要点 / 关键词 / 硬性条件 / 关键项）</summary>
        ${sec('关键要点', ex.points)}${sec('结构化内容', ex.sections || ex.duties || ex.requirements)}${sec('关键词', ex.keywords || ex.skills)}${sec('硬性条件 / 前置知识', ex.hard_conditions)}${sec('最关键内容', ex.priority)}${sec('建议行动', ex.actions)}${other}
        ${ex.raw_text ? `<div class="jdSec"><div class="jdSecT">原文摘录</div><pre class="jdRaw">${esc(String(ex.raw_text).slice(0, 1500))}</pre></div>` : ''}
      </details>` : ''}
      ${(jd.status === 'failed' || (jd.source_id && jd.source_exists === false)) ? `<div class="jdFail">${jd.status === 'failed' ? '⚠️ 识别失败：' + esc(jd.error || '未知原因') : '⚠️ 这条资料源已在「信息源」里被删除，点「重试识别」可重新导入'}</div>
        <div class="jdOps"><button class="btn tiny primary jdRetry" data-jdid="${jd.id}">🔄 重试识别</button><span class="muted" style="font-size:11.5px;">重新识别并更新信息源，不用重新上传</span></div>` : ''}
      <div class="jdSrc">${jd.status === 'failed' ? '尚未导入资料库' : '已导入资料库（' + (jd.source_id ? '#' + jd.source_id : '—') + '），AI 规划与对话时会优先参考'}</div>
    </div>
  </div>`;
}
function drawJDPage() {
  const g = state.goal;
  const list = state.jdImages || [];
  if (state.jdJobGoal !== g.id) { state.jdJobs = []; state.jdJobGoal = g.id; }
  const jobs = state.jdJobs || [];
  app.innerHTML = `<div class="jdPage">
    <div class="jdHead">
      <a class="back" href="#/g/${g.id}">← 返回目标</a>
      <span class="mapTitle">📥 信息源导入</span>
      <span class="chip gray">${esc(g.title)}</span>
      <div class="spacer"></div>

      <a class="btn small" id="jdExportBtn" href="/api/goals/${g.id}/jd-images/export" download>⬇ 导出全部（文字）</a>

      <label class="btn small">⬆ 导入资料<input type="file" id="jdImportFile" accept=".json,application/json" hidden></label>

      <button class="btn small" id="jdChatBtn">💬 对话改规划</button>
    </div>
    <div class="jdPaste" id="jdPaste">
      <div class="jpIcon">📥</div>
      <div class="jpTitle">点击这里，按 Ctrl+V 粘贴图片</div>
      <div class="jpText">把图片 / 电子书文件或文件夹拖进来，或 <label class="jpFile">选择文件<input type="file" id="jdFile" accept="image/*,.txt,.md,.pdf,.epub,.mobi,.azw,.azw3" multiple hidden></label> <label class="btn small">选择文件夹<input type="file" id="jdDir" hidden></label></div>
      <div class="jpNote">截图粘贴、批量多选、整个文件夹都行；图片走视觉模型识别，txt / pdf / epub / mobi 本地解析后提炼；已在库的电子书自动跳过；全部进入资料库、规划时优先参考</div>
      ${state.jdBusy ? `<div class="jpBusy"><span class="spinner"></span> ${esc(state.jdStatus || '正在处理…')}</div>` : ''}
    </div>
    ${jobs.length ? jdJobsHTML(jobs) : ''}
    <div class="jdRepo" id="jdRepo">
      <div class="jdRepoHd"><span>📦 导入代码库</span>
        <span class="muted">目标是「搞懂某个项目的源码」时，唯一的一手资料就是这个代码库本身 —— 不用再去网上搜</span></div>
      <div class="jdRepoRow">
        <input id="jdRepoPath" placeholder="本机路径，例如 /home/you/my-project 或 ~/code/app" spellcheck="false">
        <button class="btn small primary" id="jdRepoBtn">读取并导入</button>
      </div>
      <div class="jpNote">只读读取：.env / 密钥 / node_modules / .git 一律不读，路径不会离开这台机器。AI 会整理出「要掌握哪些概念、按什么顺序读」的摘要；同时把完整代码（已脱敏）存进资料库 —— 之后在对话里直接问具体逻辑（如「看 server/ai.js」）就能查阅。</div>
      <div id="jdRepoMsg" class="muted" style="margin-top:6px;"></div>
    </div>
    <div class="jdList">${list.length ? list.map(jdCardHTML).join('') : '<div class="muted" style="padding:20px 4px;">还没有资料。粘贴一张截图，或拖入文件 / 文件夹试试。</div>'}</div>
  </div>`;
  const paste = document.getElementById('jdPaste');
  paste.addEventListener('click', () => paste.focus());
  paste.setAttribute('tabindex', '0');
  paste.addEventListener('paste', e => {
    const items = (e.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); jdEnqueue([f]); return; }
      }
    }
    toast('剪贴板里没有图片，请先截图/复制图片');
  });
  paste.addEventListener('dragover', e => { e.preventDefault(); paste.classList.add('over'); });
  paste.addEventListener('dragleave', () => paste.classList.remove('over'));
  paste.addEventListener('drop', async e => {
    e.preventDefault(); paste.classList.remove('over');
    const items = await filesFromDrop(e.dataTransfer);
    if (items.length) jdRouteFiles(items);
    else toast('没取到文件，请用「选择文件/文件夹」按钮');
  });
  const fi = document.getElementById('jdFile');
  fi.addEventListener('change', () => { const arr = Array.from(fi.files || []).map(f => ({ file: f, rel: f.name })); if (arr.length) jdRouteFiles(arr); fi.value = ''; });
  const di = document.getElementById('jdDir');
  di.setAttribute('webkitdirectory', '');
  di.addEventListener('change', () => { const arr = Array.from(di.files || []).map(f => ({ file: f, rel: f.webkitRelativePath || f.name })); di.value = ''; if (arr.length) jdRouteFiles(arr); });
  /* 导入代码库：给一个本机路径，AI 读完出「怎么读懂它」的摘要，进资料库 */
  const repoBtn = document.getElementById('jdRepoBtn');
  if (repoBtn) {
    const msg = document.getElementById('jdRepoMsg');
    repoBtn.addEventListener('click', async () => {
      const pth = String((document.getElementById('jdRepoPath') || {}).value || '').trim();
      if (!pth) return toast('先填代码库路径');
      repoBtn.disabled = true;
      const oldTxt = repoBtn.textContent;
      repoBtn.textContent = 'AI 正在读…';
      if (msg) msg.textContent = '正在读取并整理（几十秒，别关页面）…';
      try {
        const r = await api('/api/goals/' + state.goal.id + '/code-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pth }) });
        if (r.already) {
          if (r.sources) state.goal.sources = r.sources;
          if (r.stored && r.stored.files) toast('已补存完整代码快照：' + r.stored.files + ' 个文件');
          else toast('这个代码库已经导过了（删掉旧的可以重导）');
          if (msg) msg.textContent = '';
        } else {
          if (r.sources) state.goal.sources = r.sources;
          const st = r.stored || {};
          toast('已导入：' + (st.files || r.read || 0) + ' 个文件' + (st.files ? '（含完整代码快照）' : ''));
          if (msg) {
            const d = r.digest || {};
            msg.innerHTML = '<b>读完了</b>（完整快照 ' + (st.files || 0) + ' 个文件'
              + (st.redacted ? '，脱敏 ' + st.redacted + ' 处' : '') + '）—— ' + esc(String(d.what || '').slice(0, 120))
              + (st.files ? '<br><span class="muted">AI 助手对话时可按你的问题查阅这些代码' + ((st.total || 0) > (st.files || 0) ? '；超出上限的 ' + ((st.total || 0) - (st.files || 0)) + ' 个文件未存' : '') + '。</span>' : '')
              + '　<a href="#/g/' + state.goal.id + '">回目标页看资料与规划 →</a>';
          }
        }
      } catch (e) { toast(e.message); if (msg) msg.textContent = ''; }
      repoBtn.disabled = false;
      repoBtn.textContent = oldTxt;
    });
  }
  const imp = document.getElementById('jdImportFile');

  if (imp) imp.addEventListener('change', async () => {

    const file = (imp.files || [])[0];

    imp.value = '';

    if (!file) return;

    try {

      const text = await file.text();

      let data;

      try { data = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的 JSON（需要 *.sources.json）'); }

      const r = await api('/api/goals/' + g.id + '/sources/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

      state.goal = r.goal;

      if (r.sources) state.goal.sources = r.sources;

      toast('已导入 ' + r.added + ' 条资料' + (r.skipped ? '（' + r.skipped + ' 条已存在，已跳过）' : ''));

    } catch (e) { toast(e.message); }

  });

  const exp = document.getElementById('jdExportBtn');

  if (exp) exp.addEventListener('click', e => {

    if (!(state.jdImages || []).length) { e.preventDefault(); toast('还没有资料可以导出'); }

  });

  const jc = document.getElementById('jdChatBtn');
  if (jc) jc.addEventListener('click', () => aiToggle(true));
  app.querySelectorAll('.jdRetry').forEach(b => b.addEventListener('click', () => retryJDImage(b.getAttribute('data-jdid'))));
  app.querySelectorAll('.jdJobRetry').forEach(b => b.addEventListener('click', () => {
    const job = (state.jdJobs || []).find(x => String(x.key) === b.getAttribute('data-key'));
    if (job && job.status === 'fail') {
      job.status = 'wait'; job.detail = '';
      (job.kind === 'ebook' ? state.ebQueue : state.jdQueue).push(job);
      drawJDPage();
      jdPump(); ebookPump();
    }
  }));
  const jrAll = document.getElementById('jdJobRetryAll');
  if (jrAll) jrAll.addEventListener('click', () => {
    let n = 0;
    for (const job of (state.jdJobs || [])) {
      if (job.status !== 'fail') continue;
      job.status = 'wait'; job.detail = '';
      (job.kind === 'ebook' ? state.ebQueue : state.jdQueue).push(job);
      n++;
    }
    toast(n ? '重新加入 ' + n + ' 个失败的' : '没有失败的');
    drawJDPage(); jdPump(); ebookPump();
  });
  const jClear = document.getElementById('jdJobClear');
  if (jClear) jClear.addEventListener('click', () => {
    state.jdJobs = (state.jdJobs || []).filter(r => r.status !== 'done' && r.status !== 'skip' && r.status !== 'dup');
    drawJDPage();
  });
  app.querySelectorAll('.jdRetry').forEach(b => b.addEventListener('click', () => retryJDImage(b.getAttribute('data-jdid'))));
    app.querySelectorAll('.jdDel').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这条资料及其资料源？')) return;
    try {
      await api('/api/jd-images/' + b.getAttribute('data-jdid'), { method: 'DELETE' });
      state.jdImages = state.jdImages.filter(x => String(x.id) !== String(b.getAttribute('data-jdid')));
      try { await loadGoal(g.id); } catch (e) {}
      drawJDPage();
      toast('已删除');
    } catch (e) { toast(e.message); }
  }));
}
  /* 读取提炼过程的 SSE 事件（上传与重试共用；传 cb 则把事件交给调用方，否则走全局提示） */
  async function readJDStream(resp, cb) {
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
        if (cb) { cb(d); continue; }
        if (d.status) { state.jdStatus = d.status; const el = document.querySelector('.jpBusy'); if (el) el.innerHTML = '<span class="spinner"></span> ' + esc(d.status); }
        if (d.done) { finished = true; state.goal = d.goal; toast(d.notice || '已提炼并加入资料库'); }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    return finished;
  }
  async function retryJDImage(id) {
    if (state.jdBusy) return toast('正在处理，请稍候');
    state.jdBusy = true;
    state.jdStatus = '正在用当前模型重新提炼…';
    drawJDPage();
    try {
      const resp = await fetch('/api/jd-images/' + id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!resp.ok || !resp.body) throw new Error('无法连接识别服务');
      const finished = await readJDStream(resp);
      if (!finished) toast('处理中断，可重试');
    } catch (e) {
      toast(e.message);
    } finally {
      try { const r = await api('/api/goals/' + state.goal.id + '/jd-images'); state.jdImages = r.images || []; } catch (e) {}
      drawJDPage();
    }
  }
  /* 批量任务：图片与电子书共用一套任务列表，每项独立显示进度 */
const JD_CONCURRENT = 3;
const EB_CONCURRENT = 2;
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MAX_IMG = 8 * 1024 * 1024, MAX_EB = 12 * 1024 * 1024;
state.jdQueue = state.jdQueue || [];
state.jdRunning = state.jdRunning || 0;
state.ebQueue = state.ebQueue || [];
state.ebRunning = state.ebRunning || 0;
state.jdJobs = state.jdJobs || [];
state.jdSeq = state.jdSeq || 0;
state.jdJobGoal = state.jdJobGoal || 0;
function jdNormItems(files) {
  return (files || []).map(x => (x && x.file) ? { file: x.file, rel: x.rel || x.file.name } : { file: x, rel: (x && x.name) || '文件' });
}
function jdKnownEbooks() {
  const s = new Set();
  for (const jd of (state.jdImages || [])) {
    try {
      const ex = JSON.parse(jd.extracted || 'null');
      if (ex && ex._ebook && ex._ebook.filename) s.add(ex._ebook.filename);
    } catch (e) {}
  }
  for (const r of (state.jdJobs || [])) {
    if (r.kind === 'ebook' && (r.status === 'done' || r.status === 'wait' || r.status === 'up' || r.status === 'work')) s.add(r.name);
  }
  return s;
}
function jdIsImgFile(f) {
  if (!f) return false;
  if (f.type && f.type.startsWith('image/')) return true;
  return IMG_EXTS.includes(jdFileExt(f.name));
}
/* 图片 / 电子书分流：图片走视觉识别，电子书走本地解析+提炼 */
function jdIsEbookFile(f) {
  if (!f) return false;
  if (f.type && f.type.startsWith('image/')) return false;
  const ext = jdFileExt(f.name);
  if (EBOOK_EXTS.includes(ext)) return true;
  // 无扩展名但不是图片：按文本尝试（服务端会二次校验）
  if (!ext && f.type && (f.type.startsWith('text/') || f.type === 'application/pdf' || f.type === 'application/epub+zip')) return true;
  return false;
}
function jdRouteFiles(files) {
  const items = jdNormItems(files);
  const books = [], imgs = [];
  for (const it of items) (jdIsEbookFile(it.file) ? books : imgs).push(it);
  if (imgs.length) jdEnqueue(imgs);
  if (books.length) ebookEnqueue(books);
  if (!imgs.length && !books.length) toast('请选择图片或电子书（txt / pdf / epub / mobi）');
}
/* 拖拽取文件：目录用 entry 递归（webkit 内核），取不到时退化为平面文件 */
async function filesFromDrop(dt) {
  try {
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (en) entries.push(en);
    }
    if (!entries.length) return Array.from(dt.files || []).map(f => ({ file: f, rel: f.name }));
    const out = [];
    const readFile = entry => new Promise(res => entry.file(f => res(f), () => res(null)));
    const readDir = reader => new Promise(res => reader.readEntries(r => res(r || []), () => res([])));
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const f = await readFile(entry);
        if (f) out.push({ file: f, rel: (prefix || '') + f.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch = [];
        do {
          batch = await readDir(reader);
          for (const c of batch) await walk(c, (prefix || '') + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const en of entries) await walk(en, '');
    return out.length ? out : Array.from(dt.files || []).map(f => ({ file: f, rel: f.name }));
  } catch (e) {
    return Array.from((dt && dt.files) || []).map(f => ({ file: f, rel: f.name }));
  }
}
function jdJobStatusHTML(r) {
  if (r.status === 'wait') return '<span class="ebSt wait">⏳ 等待</span>';
  if (r.status === 'up') return '<span class="ebSt up">⬆ 上传中…</span>';
  if (r.status === 'work') return '<span class="ebSt work"><span class="spinner"></span> ' + esc(r.detail || '提炼中…') + '</span>';
  if (r.status === 'done') return '<span class="ebSt ok">✅ 已完成</span>';
  if (r.status === 'dup') return '<span class="ebSt dup">⏭ 已在库，跳过</span>';
  if (r.status === 'skip') return '<span class="ebSt dup">⏭ 跳过：' + esc(r.detail || '') + '</span>';
  if (r.status === 'fail') return '<span class="ebSt fail">❌ ' + esc(r.detail || '失败') + '</span> <button class="btn tiny primary jdJobRetry" data-key="' + r.key + '">重试</button>';
  return '';
}
function jdJobSummary(jobs) {
  const s = { total: 0, ok: 0, fail: 0, skip: 0, active: 0 };
  for (const r of jobs) {
    if (r.status === 'skip' || r.status === 'dup') { s.skip++; continue; }
    s.total++;
    if (r.status === 'done') s.ok++;
    else if (r.status === 'fail') s.fail++;
    else s.active++;
  }
  return s;
}
function jdJobsHTML(jobs) {
  const s = jdJobSummary(jobs);
  return `<div class="ebBar"><span class="jdJobTxt">批量导入：共 <b>${s.total}</b> · ✅ <b>${s.ok}</b> · ❌ <b>${s.fail}</b> · ⏭ 跳过 <b>${s.skip}</b>${s.active ? ` · ⏳ 进行中 <b>${s.active}</b>` : ''}</span>
    <div class="spacer"></div>
    ${s.fail ? '<button class="btn small" id="jdJobRetryAll">🔄 重试全部失败</button>' : ''}
    ${(s.ok || s.skip) && !s.active ? '<button class="btn small" id="jdJobClear">🧹 清空已完成/跳过</button>' : ''}
  </div>
  <div class="ebList">${jobs.map(r => `
    <div class="ebRow jdJob" data-key="${r.key}">
      <span class="ebFileIcon">${r.kind === 'ebook' ? '📖' : '🖼'}</span>
      <div class="ebMain">
        <div class="ebName" title="${esc(r.rel)}">${esc(r.rel)} <span class="muted">(${(r.size > 1048576 ? (r.size / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(r.size / 1024)) + 'KB')})</span></div>
        <div class="ebStatus">${jdJobStatusHTML(r)}</div>
      </div>
    </div>`).join('')}</div>`;
}
/* 行内刷新（流式进度不整页重绘，按钮增减在任务结束时由整页重绘处理） */
function jdUpdateJobRow(job) {
  try {
    const el = app.querySelector('.jdJob[data-key="' + job.key + '"] .ebStatus');
    if (el) el.innerHTML = jdJobStatusHTML(job);
    const bar = app.querySelector('.ebBar .jdJobTxt');
    if (bar) {
      const s = jdJobSummary(state.jdJobs || []);
      bar.innerHTML = `批量导入：共 <b>${s.total}</b> · ✅ <b>${s.ok}</b> · ❌ <b>${s.fail}</b> · ⏭ 跳过 <b>${s.skip}</b>${s.active ? ` · ⏳ 进行中 <b>${s.active}</b>` : ''}`;
    }
  } catch (e) {}
}
function jdPump() {
  while (state.jdRunning < JD_CONCURRENT && state.jdQueue.length) {
    const job = state.jdQueue.shift();
    state.jdRunning++;
    uploadJDJob(job).finally(() => { state.jdRunning--; jdPump(); });
  }
  refreshJDStatus();
}
function ebookPump() {
  while (state.ebRunning < EB_CONCURRENT && state.ebQueue.length) {
    const job = state.ebQueue.shift();
    state.ebRunning++;
    uploadEbookJob(job).finally(() => { state.ebRunning--; ebookPump(); });
  }
  refreshJDStatus();
}
function refreshJDStatus() {
  const busy = state.jdQueue.length || state.jdRunning || state.ebQueue.length || state.ebRunning;
  if (busy) {
    state.jdBusy = true;
    const parts = [];
    if (state.jdRunning || state.jdQueue.length) parts.push((state.jdRunning ? '正在识别 ' + state.jdRunning + ' 张' : '') + (state.jdQueue.length ? '（排队 ' + state.jdQueue.length + ' 张）' : ''));
    if (state.ebRunning || state.ebQueue.length) parts.push((state.ebRunning ? '正在提炼 ' + state.ebRunning + ' 本' : '') + (state.ebQueue.length ? '（排队 ' + state.ebQueue.length + ' 本）' : ''));
    state.jdStatus = parts.filter(Boolean).join('；');
  } else { state.jdBusy = false; state.jdStatus = ''; }
  try { drawJDPage(); } catch (e) {}
}
/* 多图并行：最多 3 张同时识别，超出的自动排队（切页面不影响，服务端后台继续） */
function jdEnqueue(files) {
  const items = jdNormItems(files);
  let n = 0;
  for (const it of items) {
    const f = it.file;
    const job = { key: ++state.jdSeq, file: f, name: f.name, rel: it.rel, size: f.size || 0, kind: 'image', status: 'wait', detail: '' };
    if (!jdIsImgFile(f)) { job.status = 'skip'; job.detail = '非图片/电子书格式'; }
    else if (!f.size) { job.status = 'skip'; job.detail = '空文件'; }
    else if (f.size > MAX_IMG) { job.status = 'skip'; job.detail = '超过 8MB'; }
    else { state.jdQueue.push(job); n++; }
    state.jdJobs.push(job);
  }
  drawJDPage();
  if (n) toast('已加入 ' + n + ' 张图片（并行识别，最多 3 张同时处理）');
  jdPump();
}
/* 电子书并行：最多 2 本同时提炼（文本模型），已在库的直接跳过 */
function ebookEnqueue(files) {
  const items = jdNormItems(files);
  const known = jdKnownEbooks();
  let added = 0, dup = 0;
  for (const it of items) {
    const f = it.file;
    const job = { key: ++state.jdSeq, file: f, name: f.name, rel: it.rel, size: f.size || 0, kind: 'ebook', status: 'wait', detail: '' };
    if (!jdIsEbookFile(f)) { job.status = 'skip'; job.detail = '非图片/电子书格式'; }
    else if (!f.size) { job.status = 'skip'; job.detail = '空文件'; }
    else if (f.size > MAX_EB) { job.status = 'skip'; job.detail = '超过 12MB'; }
    else if (known.has(f.name)) { job.status = 'dup'; dup++; }
    else { state.ebQueue.push(job); known.add(f.name); added++; }
    state.jdJobs.push(job);
  }
  drawJDPage();
  toast('已加入 ' + added + ' 本电子书' + (dup ? '（' + dup + ' 本已在库，跳过）' : ''));
  ebookPump();
}
function jdSingleToast() {
  // 单个文件时保留原来的即时提示；批量时看汇总条即可，避免刷屏
  return (state.jdJobs || []).filter(r => r.status !== 'skip' && r.status !== 'dup').length <= 1;
}
async function uploadJDJob(job) {
  const file = job.file;
  job.status = 'up'; job.detail = '正在读取…'; jdUpdateJobRow(job);
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  job.status = 'work'; job.detail = 'AI 正在识别…'; jdUpdateJobRow(job);
  let ok = false;
  try {
    const resp = await fetch('/api/goals/' + state.goal.id + '/jd-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接识别服务');
    await readJDStream(resp, d => {
      if (d.status) { job.detail = d.status; jdUpdateJobRow(job); }
      else if (d.done) { ok = true; if (d.goal) state.goal = d.goal; job.status = 'done'; job.detail = ''; if (d.notice && jdSingleToast()) toast(d.notice); }
      else if (d.error) { job.status = 'fail'; job.detail = d.error; toast(d.error); }
    });
    if (!ok && job.status !== 'fail') { job.status = 'fail'; job.detail = '识别中断，可重试'; }
    else if (ok && jdSingleToast()) toast('已提炼并加入资料库');
  } catch (e) {
    job.status = 'fail'; job.detail = e.message || '上传失败'; toast(job.detail);
  } finally {
    try { const r = await api('/api/goals/' + state.goal.id + '/jd-images'); state.jdImages = r.images || []; } catch (e) {}
    drawJDPage();
  }
}
async function uploadEbookJob(job) {
  const file = job.file;
  job.status = 'up'; job.detail = '正在读取…'; jdUpdateJobRow(job);
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  job.status = 'work'; job.detail = '本地解析中…'; jdUpdateJobRow(job);
  let ok = false;
  try {
    const resp = await fetch('/api/goals/' + state.goal.id + '/ebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: job.name, dataUrl }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接提炼服务');
    await readJDStream(resp, d => {
      if (d.status) { job.detail = d.status; jdUpdateJobRow(job); }
      else if (d.done) { ok = true; if (d.goal) state.goal = d.goal; job.status = 'done'; job.detail = ''; if (d.notice && jdSingleToast()) toast(d.notice); }
      else if (d.error) { job.status = 'fail'; job.detail = d.error; toast(d.error); }
    });
    if (!ok && job.status !== 'fail') { job.status = 'fail'; job.detail = '提炼中断，可重试'; }
    else if (ok && jdSingleToast()) toast('已提炼并加入资料库');
  } catch (e) {
    job.status = 'fail'; job.detail = e.message || '上传失败'; toast(job.detail);
  } finally {
    try { const r = await api('/api/goals/' + state.goal.id + '/jd-images'); state.jdImages = r.images || []; } catch (e) {}
    drawJDPage();
  }
}


  SiErXing.registerPlugin({
    id: 'jdfile',
    goalEntry: {
      label: '信息源导入',
      icon: '📥',
      order: 30,
      hash: gid => '#/g/' + gid + '/jd',
      show: goal => SiErXing.pluginEnabled(goal, 'jdfile')
    },
    routes: [
      {
        match: h => h.match(/^#\/g\/(\d+)\/jd$/),
        render: async m => {
          const gid0 = Number(m[1]);
          if (jdfileVueEnabled()) {
            try { if (await renderJDFilePageVue(gid0)) return; }
            catch (e) { try { toast('信息源导入 Vue 页面加载失败，已回退旧页面'); } catch (e2) {} }
          }
          await SiErXing.loadGoal(gid0);
          await renderJDPage();
        }
      }
    ]
  });
})();
