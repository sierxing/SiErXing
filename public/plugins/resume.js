'use strict';
/**
 * 思而行 · 前端扩展组件：简历工坊（resume）—— 一步一步的向导
 * ==================================================================
 * 和「🎯 达成条件」同一套形态：
 *   · 入口在**目标页顶栏**（`goalEntry` → 收藏栏按钮「📄 简历工坊」）；
 *   · 点开是**整页** `#/g/:id/resume`（不是右下角浮窗 / 右侧抽屉）；
 *   · **每个目标可以单独打开 / 关闭**（`goalToggle:true`，写 goals.plugins.resume）。
 *
 * 关掉只是「这个目标不显示入口」，数据不动。简历库**全目标共享**：
 * `GET /api/resume/docs` 不带 goalId 就返回所有简历，换目标看到的是同一份。
 *
 * 六步流水线（每步只让用户做一件事）：
 *   1 上传简历（支持拖文件进来）→ 2 AI 审查问题 → 3 AI 追问补充信息
 *   → 4 选岗位（直接用资料库里的 JD）→ 5 匹配与改写 → 6 生成终版（可导出 docx）
 *
 * 参考的开源工作流（用户指定 4 个链接，含 1 个重复）：
 *   https://github.com/Elowwwen/resume-evidence-workflow
 *   https://github.com/zclllyybb/lofisu-identity-engine
 *   https://github.com/Claycui828/ASu-resume-skills
 *   https://github.com/Elowwwen/resume-evidence-workflow
 */
(function () {
  var SX = window.SiErXing;
  if (!SX) return;
  if (SX.__resumeWorkshop) return;
  SX.__resumeWorkshop = true;

  var api = SX.api;
  var esc = SX.esc;
  var toast = SX.toast;
  var mdToHTML = SX.mdToHTML || function (s) { return esc(s); };

  /* 文案一律走 tr()。注意：字面量必须直接出现在 tr(...) 里才会被 i18n 提取器认作已管理。 */
  function tr() { return SX.tr.apply(null, arguments); }

  var STEPS = [
    { key: 'upload', icon: '📥', label: tr('上传简历'), hint: tr('把已有简历拖进来，或粘贴正文') },
    { key: 'review', icon: '🔎', label: tr('AI 审查'), hint: tr('先看问题清单，再决定改什么') },
    { key: 'supplement', icon: '💬', label: tr('补充信息'), hint: tr('回答 AI 追问，补齐证据') },
    { key: 'jd', icon: '🎯', label: tr('选岗位'), hint: tr('从资料库里选 JD，不用重贴') },
    { key: 'match', icon: '📊', label: tr('匹配改写'), hint: tr('看要求-证据矩阵与改写建议') },
    { key: 'finalize', icon: '✅', label: tr('生成终版'), hint: tr('拿到改好并排版的简历') }
  ];
  var ERR = {
    need_title: tr('先给简历起个名字'),
    need_file: tr('先选一个简历文件，或者粘贴正文'),
    unsupported_format: tr('不支持这个格式：目前支持 .docx / .pdf / .txt / .md'),
    bad_docx: tr('这个 .docx 打不开，可能不是标准 Word 文件'),
    no_text_layer: tr('这个 PDF 没有文字层（可能是扫描件）：请截图后用图片识别，或粘贴文字'),
    empty_document: tr('文件里没读到文字'),
    file_too_large: tr('文件太大（上限 20MB）'),
    bad_base64: tr('文件内容读取失败，请重新选择'),
    need_resume: tr('先上传简历正文，再做这一步'),
    need_jd: tr('先选一个 JD，或者粘贴 JD 文本'),
    need_answers: tr('先写一点回答，再让 AI 整理'),
    need_final: tr('还没有终版简历：先点「生成终版」'),
    ai_failed: tr('AI 调用失败，先到「设置 → AI 接入」确认模型可用'),
    ai_unavailable: tr('AI 未配置'),
    not_found: tr('数据不存在，可能已被删除'),
    resume_unavailable: tr('简历工坊组件未启用'),
    bad_kind: tr('未知的 AI 动作')
  };
  function errText(e) {
    var code = String((e && e.message) || '');
    return ERR[code] ? ERR[code] : code;
  }

  var UI = {
    docs: [], doc: null, pipeline: null, evidence: [], versions: [], reports: [],
    step: 'upload', busy: '', err: '', notice: '',
    review: null, questions: null, jdText: '', jdSources: [], jdSourceId: 0,
    match: null, finalMd: '', finalData: null, answers: {}, cards: null, exportName: ''
  };
  var gid = 0;                         /* 当前页的目标 id：只用于「返回目标」+ 目标级开关 */
  var goal = null;

  function $(id) { return document.getElementById(id); }
  function pageRoot() { return $('rsPage'); }
  function bodyEl() { return $('rsBody'); }
  function has(v) { return v != null && String(v).length > 0; }
  function shortTime(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : ''; }
  /* 组件开关：按目标（写 goals.plugins.resume）。没有目标上下文时退回全局开关。 */
  function componentOn(g) {
    var gg = g || goal;
    try {
      if (gg && gg.id) return !!SX.pluginEnabled(gg, 'resume');
      var c = SX.state && SX.state.components;
      return !(c && c.resume === false);
    } catch (e) { return true; }
  }

  /* ---------------- 整页骨架 ---------------- */
  function pageHTML(enabled) {
    var title = (goal && goal.title) || '';
    var head =
      '<div class="pageHead">' +
        '<button class="back" data-back="#/g/' + gid + '">' + tr('← 返回目标') + '</button>' +
        '<span class="mapTitle">📄 ' + tr('简历工坊') + '</span>' +
        (title ? '<span class="chip gray">' + esc(title) + '</span>' : '') +
        '<div class="spacer"></div>' +
        '<button class="btn small" id="rsPickDoc" title="' + esc(tr('切换到别的简历')) + '">' + tr('🗂 简历库') + '</button>' +
        '<button class="btn small primary" id="rsNewDoc" title="' + esc(tr('新建一份简历')) + '">' + tr('＋ 新建简历') + '</button>' +
      '</div>';
    if (!enabled) {
      return '<div class="page rsPage" id="rsPage">' + head +
        '<div class="emptyBox"><div class="ebIcon">📄</div>' +
          '<div class="ebTitle">' + tr('这个目标已关闭「简历工坊」') + '</div>' +
          '<div class="ebText">' + tr('组件开关按目标隔离：到目标页顶栏「🧩 组件」里勾上就能打开。关掉只是隐藏入口，简历数据不受影响（全目标共享一份）。') + '</div>' +
          '<a class="btn primary" href="#/g/' + gid + '">' + tr('回目标页打开') + '</a>' +
        '</div>' +
      '</div>';
    }
    return '<div class="page rsPage" id="rsPage">' + head +
      '<div class="rsIntro">' + tr('简历与经历证据工作流：先盘点经历攒证据，再按 JD 做「要求 → 证据」匹配与定向改写，最后过一遍证据审计；每一步只做一件事。') +
        '<br><span class="rsIntroTip">' + tr('简历库是全目标共享的：换目标、换设备（多端同步）看到的都是同一份；这个目标的开关只决定要不要在顶栏露出入口。') + '</span></div>' +
      '<div class="rsSteps" id="rsSteps"></div>' +
      '<div class="rsBody" id="rsBody"></div>' +
      '<div class="rsFoot">' +
        '<span>' + tr('本地存储 · 参考开源项目：') + '</span>' +
        '<a href="https://github.com/Elowwwen/resume-evidence-workflow" target="_blank" rel="noopener">resume-evidence-workflow</a>' +
        '<a href="https://github.com/zclllyybb/lofisu-identity-engine" target="_blank" rel="noopener">lofisu-identity-engine</a>' +
        '<a href="https://github.com/Claycui828/ASu-resume-skills" target="_blank" rel="noopener">ASu-resume-skills</a>' +
        '<a href="https://github.com/Elowwwen/resume-evidence-workflow" target="_blank" rel="noopener">' + tr('resume-evidence-workflow（重复引用）') + '</a>' +
      '</div>' +
    '</div>';
  }

  /* 整页重画（进路由 / 开关变化时）：骨架 + 步骤条 + 正文 */
  function draw() {
    var app = SX.app;
    if (!app) return;
    var enabled = componentOn();
    app.innerHTML = pageHTML(enabled);
    if (!enabled) return;
    bindPage();
    render();
  }

  function bindPage() {
    var add = $('rsNewDoc');
    if (add) add.addEventListener('click', newDoc);
    var pick = $('rsPickDoc');
    if (pick) pick.addEventListener('click', pickDoc);
    var steps = $('rsSteps');
    if (steps) steps.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rs-jump]');
      if (!b) return;
      captureEdits();
      UI.err = ''; UI.notice = '';
      UI.step = b.getAttribute('data-rs-jump');
      render();
    });
    /* Ctrl/⌘+Enter 只挂一次：draw() 每次进页都会跑，重复挂会执行多遍 */
    if (!bindPage._keys) {
      bindPage._keys = true;
      document.addEventListener('keydown', function (e) {
        if (!pageRoot()) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          var go = $('rsPasteSave') || $('rsSaveJd');
          if (go) { e.preventDefault(); go.click(); }
        }
      });
    }
  }

  /* 只重画「步骤条 + 当前这一步」，不重画页头（页面按钮/滚动不丢） */
  function render() {
    /* 已经离开这一页（异步回调晚到）就什么都不做 —— 绝不能把简历页画回 #app */
    if (!pageRoot()) return;
    if (!componentOn()) { draw(); return; }
    var nameEl = $('rsDocName');
    if (nameEl) nameEl.textContent = UI.doc ? (UI.doc.title || '') : '';
    var stepsEl = $('rsSteps');
    if (stepsEl) stepsEl.innerHTML = stepsHTML();
    var body = bodyEl();
    if (!body) return;
    if (UI.busy) { body.innerHTML = busyHTML(); return; }
    var html = '';
    if (!UI.doc) {
      html = '<div class="rsEmpty">' + tr('简历库里还没有简历。点右上角「＋ 新建简历」，或直接把简历文件拖进来。') + '</div>'
        + '<div class="rsDrop" id="rsDrop0"><div class="rsDropIcon">📄</div><div class="rsDropTitle">' + tr('把简历文件拖到这里') + '</div>'
        + '<div class="rsDropHint">' + tr('支持 docx / pdf / txt / md') + '</div><input type="file" id="rsFile0" accept=".docx,.pdf,.txt,.md,.markdown" hidden></div>';
      body.innerHTML = html;
      bindDrop($('rsDrop0'), $('rsFile0'));
      return;
    }
    if (UI.step === 'review') html = stepReviewHTML();
    else if (UI.step === 'supplement') html = stepSupplementHTML();
    else if (UI.step === 'jd') html = stepJdHTML();
    else if (UI.step === 'match') html = stepMatchHTML();
    else if (UI.step === 'finalize') html = stepFinalHTML();
    else html = stepUploadHTML();
    body.innerHTML = stepNavHTML() + html;
    bindAll();
    if (UI.step === 'jd' && !UI.jdSources.length) loadJdSources();
  }

  /* ---------------- 数据 ---------------- */
  /* 进页面：先拿目标（标题 + 目标级开关），再取简历库（全目标共享，不带 goalId） */
  async function loadAll() {
    await SX.loadGoal(gid).catch(function () { return null; });
    goal = (SX.state && SX.state.goal) || null;
    if (!componentOn()) { draw(); return; }
    UI.busy = tr('加载中…'); draw();
    try {
      var r = await api('/api/resume/docs');
      UI.docs = r.docs || [];
      if (!UI.docs.length) UI.doc = null;
      else if (!UI.doc || !UI.docs.some(function (d) { return Number(d.id) === Number(UI.doc.id); })) UI.doc = UI.docs[0];
      if (UI.doc) await loadDoc(UI.doc.id);
      else { UI.busy = ''; render(); return; }
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function loadDoc(id) {
    var r = await api('/api/resume/docs/' + id + '/pipeline');
    UI.pipeline = r;
    UI.doc = r.doc;
    UI.step = r.stage || 'upload';
    UI.review = (r.doc.issues && r.doc.issues.length) ? { summary: '', issues: r.doc.issues, missing: [] } : null;
    UI.questions = null;
    UI.cards = null;
    UI.jdText = r.doc.jd_text || '';
    UI.jdSourceId = r.doc.jd_source_id || 0;
    UI.match = (r.doc.match && Object.keys(r.doc.match).length) ? r.doc.match : null;
    UI.finalMd = r.doc.final_md || '';
    UI.finalData = r.doc.final_data || null;
    UI.jdSources = r.jd_sources || [];
    UI.answers = {};
    var g = await api('/api/resume/docs/' + id);
    UI.evidence = g.evidence || [];
    UI.versions = g.versions || [];
    UI.reports = g.reports || [];
  }

  async function reload(silent) {
    if (!UI.doc) return;
    try { await loadDoc(UI.doc.id); if (!silent) { UI.notice = tr('已更新'); render(); } }
    catch (e) { if (!silent) { UI.err = errText(e); render(); } }
  }

  function captureEdits() {
    var ta = $('rsContent');
    if (ta && UI.doc) UI.doc.content_md = ta.value;
    var jd = $('rsJdText');
    if (jd) UI.jdText = jd.value;
  }

  async function newDoc() {
    var title = window.prompt(tr('给简历起个名字（例如：张思为-AIPM）'), tr('我的简历'));
    if (title == null) return;
    title = String(title).trim();
    if (!title) return;
    UI.busy = tr('创建中…'); render();
    try {
      var r = await api('/api/resume/docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, target_role: (UI.doc && UI.doc.target_role) || '' })
      });
      UI.doc = r.doc;
      await loadDoc(r.doc.id);
      var list = await api('/api/resume/docs');
      UI.docs = list.docs || [];
      UI.step = 'upload';
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  /* 简历库切换：一个简单弹层（标题 + 当前第几步），点哪份切哪份 */
  function pickDoc() {
    if (!UI.docs.length) { toast(tr('还没有简历')); return; }
    var lines = UI.docs.map(function (d, i) { return (i + 1) + '. ' + d.title + '（' + tr('第 {0} 步', stepIndex(d.stage) + 1) + '）'; }).join('\n');
    var ans = window.prompt(tr('切换到哪一份？输入序号：') + '\n' + lines, '1');
    if (ans == null) return;
    var idx = Number(String(ans).trim()) - 1;
    if (!(idx >= 0 && idx < UI.docs.length)) return;
    UI.doc = UI.docs[idx];
    UI.err = ''; UI.notice = '';
    loadDoc(UI.doc.id).then(function () { render(); }).catch(function (e) { UI.err = errText(e); render(); });
  }

  function stepIndex(key) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].key === key) return i;
    return 0;
  }
  function goalIdOf() {
    try {
      if (gid) return gid;
      if (SX.state && SX.state.goal && SX.state.goal.id) return SX.state.goal.id;
      var m = String(location.hash || '').match(/^#\/g\/(\d+)/);
      if (m) return Number(m[1]);
    } catch (e) {}
    return 0;
  }

  /* ---------------- 第一步：拖文件 / 粘贴 ---------------- */
  async function uploadFile(file) {
    if (!UI.doc) { await newDoc(); if (!UI.doc) return; }
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { UI.err = tr('文件太大（上限 20MB）'); render(); return; }
    UI.busy = tr('正在解析文件…'); UI.err = ''; UI.notice = ''; render();
    try {
      var b64 = await readFileBase64(file);
      var r = await api('/api/resume/docs/' + UI.doc.id + '/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, base64: b64 })
      });
      UI.notice = tr('已读入 {0} 字', r.imported.chars);
      await loadDoc(UI.doc.id);
      UI.step = 'review';
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }
  function readFileBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s);
      };
      fr.onerror = function () { reject(new Error('read fail')); };
      fr.readAsDataURL(file);
    });
  }
  async function savePasted() {
    captureEdits();
    if (!UI.doc) { await newDoc(); if (!UI.doc) return; }
    var text = UI.doc.content_md || '';
    if (!String(text).trim()) { UI.err = ERR.empty_document; render(); return; }
    UI.busy = tr('保存中…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, filename: '' })
      });
      await loadDoc(UI.doc.id);
      UI.step = 'review';
      UI.notice = tr('已保存正文');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  /* ---------------- 通用：跑 AI ---------------- */
  async function runStep(kind, extra, busyText, nextStep) {
    if (!UI.doc) return;
    captureEdits();
    var payload = { kind: kind };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    UI.busy = busyText || tr('AI 正在处理…'); UI.err = ''; UI.notice = '';
    render();
    try {
      var r = await api('/api/resume/docs/' + UI.doc.id + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await reload(true);
      if (kind === 'review') UI.review = r.data;
      else if (kind === 'questions') UI.questions = r.data.questions || [];
      else if (kind === 'match') UI.match = r.data;
      else if (kind === 'finalize') { UI.finalMd = (r.data && r.data.markdown) || ''; UI.finalData = (r.data && r.data.data) || null; }
      if (nextStep) UI.step = nextStep;
      UI.notice = tr('这一步完成了');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  /* ---------------- 第三步：回答 → 证据卡 ---------------- */
  async function makeCards() {
    var qs = UI.questions || [];
    var answers = [];
    var root = bodyEl() || document;
    for (var i = 0; i < qs.length; i++) {
      var ta = root.querySelector('[data-rs-a="' + qs[i].id + '"]');
      var a = ta ? String(ta.value || '').trim() : '';
      if (a) answers.push({ id: qs[i].id, q: qs[i].q, a: a });
    }
    if (!answers.length) { UI.err = ERR.need_answers; render(); return; }
    UI.busy = tr('AI 正在把你的回答整理成证据卡…'); UI.err = ''; render();
    try {
      var r = await api('/api/resume/docs/' + UI.doc.id + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'answers', answers: answers.map(function (x) { return 'Q：' + x.q + '\nA：' + x.a; }).join('\n\n') })
      });
      UI.cards = r.data.cards || [];
      await reload(true);
      UI.notice = '';
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }
  async function importCards() {
    if (!UI.cards || !UI.cards.length) return;
    UI.busy = tr('导入证据卡中…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/evidence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: UI.cards })
      });
      UI.cards = null;
      await reload(true);
      UI.step = 'jd';
      UI.notice = tr('已补进证据库');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  /* ---------------- 第四步：选 JD ---------------- */
  async function pickJdSource(sid) {
    UI.busy = tr('读取 JD…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/jd', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: sid })
      });
      await reload(true);
      UI.jdSourceId = sid;
      UI.step = 'match';
      UI.notice = tr('已选好岗位');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }
  async function saveJdText() {
    captureEdits();
    if (!String(UI.jdText || '').trim()) { UI.err = ERR.need_jd; render(); return; }
    UI.busy = tr('保存 JD…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/jd', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jd: UI.jdText })
      });
      await reload(true);
      UI.step = 'match';
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }
  async function loadJdSources() {
    try {
      var gid2 = (UI.doc && UI.doc.goal_id) || goalIdOf();
      var r = await api('/api/resume/jd-sources?goalId=' + gid2);
      UI.jdSources = r.sources || [];
    } catch (e) { UI.jdSources = []; }
    render();
  }

  /* ---------------- 第六步：终版 ---------------- */
  async function exportDocx() {
    if (!UI.doc) return;
    UI.busy = tr('正在生成 .docx…'); render();
    try {
      var res = await fetch('/api/resume/docs/' + UI.doc.id + '/export');
      if (!res.ok) throw new Error('export_failed');
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ((UI.doc.title || 'resume') + '.docx').replace(/[\\/:*?"<>|]/g, '');
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      UI.notice = tr('已下载 {0}', a.download);
    } catch (e) { UI.err = ERR.need_final; }
    UI.busy = ''; render();
  }
  function copyText(t) {
    var s = String(t || '');
    if (!s) { toast(tr('没有可复制的内容')); return; }
    var done = function () { toast(tr('已复制')); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(done, function () { fbCopy(s, done); });
    else fbCopy(s, done);
  }
  function fbCopy(s, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
    } catch (e) { toast(tr('复制失败，请手动选择')); }
  }

  /* ---------------- 渲染 ---------------- */
  function stepsHTML() {
    var cur = stepIndex(UI.step);
    return STEPS.map(function (s, i) {
      var st = i < cur ? 'done' : (i === cur ? 'cur' : 'todo');
      return '<div class="rsStep ' + st + '" data-rs-jump="' + s.key + '" title="' + esc(s.hint) + '">'
        + '<span class="rsStepIcon">' + (i < cur ? '✓' : s.icon) + '</span>'
        + '<span class="rsStepLabel">' + esc(s.label) + '</span></div>';
    }).join('<span class="rsStepLine"></span>');
  }
  function head(title, sub) {
    return '<div class="rsSecHead"><div class="rsSecTitle">' + title + '</div>' + (sub ? '<div class="rsSecSub">' + sub + '</div>' : '') + '</div>';
  }
  function msgHTML() {
    var out = '';
    if (UI.err) out += '<div class="rsMsg bad">' + esc(UI.err) + '</div>';
    if (UI.notice) out += '<div class="rsMsg ok">' + esc(UI.notice) + '</div>';
    return out;
  }
  function busyHTML() { return UI.busy ? '<div class="rsBusy"><span class="rsSpin"></span>' + esc(UI.busy) + '</div>' : ''; }

  /* 第 1 步 */
  function stepUploadHTML() {
    var h = msgHTML();
    h += head(tr('📥 第 1 步：把你的简历给我'), tr('直接把这一个文件拖进虚线框里（.docx / .pdf / .txt / .md），或者把正文粘到下面。'));
    h += '<div class="rsDrop" id="rsDrop"><div class="rsDropIcon">📄</div>'
      + '<div class="rsDropTitle">' + tr('把简历文件拖到这里') + '</div>'
      + '<div class="rsDropHint">' + tr('也可以点这里选择文件 · 支持 docx / pdf / txt / md') + '</div>'
      + '<input type="file" id="rsFile" accept=".docx,.pdf,.txt,.md,.markdown" hidden></div>';
    h += '<details class="rsFold"' + (UI.doc && UI.doc.content_md ? '' : '') + '><summary>' + tr('或者：直接粘贴 / 编辑正文') + '</summary>'
      + '<textarea id="rsContent" class="rsTextarea" spellcheck="false" placeholder="' + esc(tr('把简历正文粘进来…')) + '">' + esc((UI.doc && UI.doc.content_md) || '') + '</textarea>'
      + '<div class="rsBtns"><button class="btn small primary" id="rsPasteSave">' + tr('用这份正文') + '</button></div></details>';
    if (UI.doc && UI.doc.content_md) {
      h += '<div class="rsBtns"><button class="btn small primary" id="rsGoReview">' + tr('下一步：让 AI 审查') + ' →</button></div>';
    }
    return h;
  }

  /* 第 2 步 */
  function stepReviewHTML() {
    var h = msgHTML();
    h += head(tr('🔎 第 2 步：AI 审查这份简历'), tr('先看清问题在哪，再决定改什么。审查不会改你的简历。'));
    var r = UI.review;
    if (!r) {
      h += '<div class="rsEmpty">' + tr('点下面的按钮，AI 会通读简历并列出问题清单（定位 / 证据 / 指标 / 关键词 / 结构 / 时态）。') + '</div>';
      h += '<div class="rsBtns"><button class="btn primary" id="rsDoReview">' + tr('开始审查') + '</button></div>';
      return h;
    }
    if (r.summary) h += '<div class="rsSummary">' + esc(r.summary) + '</div>';
    var issues = r.issues || [];
    var sevName = { high: tr('严重'), medium: tr('中等'), low: tr('轻微') };
    h += issues.length ? '<div class="rsList">' + issues.map(function (x) {
      return '<div class="rsIssue ' + esc(x.severity || 'medium') + '">'
        + '<div class="rsIssueH"><span class="rsBadge ' + (x.severity === 'high' ? 'bad' : x.severity === 'low' ? 'mute' : 'warn') + '">' + esc(sevName[x.severity] || x.severity || '') + '</span>'
        + '<span class="rsMuted">' + esc(x.type || '') + '</span></div>'
        + (x.where ? '<div class="rsIssueWhere">' + esc(x.where) + '</div>' : '')
        + '<div class="rsIssueT">' + esc(x.detail || '') + '</div>'
        + (x.fix ? '<div class="rsIssueFix">→ ' + esc(x.fix) + '</div>' : '')
        + '</div>';
    }).join('') + '</div>' : '<div class="rsEmpty">' + tr('没发现明显问题。') + '</div>';
    if (r.missing && r.missing.length) {
      h += '<div class="rsSub">' + tr('需要你补充的信息') + '</div><ul class="rsUl">' + r.missing.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    }
    h += '<div class="rsBtns">'
      + '<button class="btn small primary" id="rsGoSupplement">' + tr('下一步：回答问题补信息') + ' →</button>'
      + '<button class="btn small" id="rsReReview">' + tr('重新审查') + '</button></div>';
    return h;
  }

  /* 第 3 步 */
  function stepSupplementHTML() {
    var h = msgHTML();
    h += head(tr('💬 第 3 步：回答 AI 的追问'), tr('只答你答得出来的；答完 AI 会把它们整理成「证据卡」，后面改写只能用证据卡里的事实。'));
    if (!UI.questions || !UI.questions.length) {
      h += '<div class="rsEmpty">' + tr('点下面的按钮，AI 会根据审查结果问你 6-8 个问题（一次答一两题就行）。') + '</div>';
      h += '<div class="rsBtns"><button class="btn primary" id="rsDoQuestions">' + tr('让 AI 问我') + '</button>'
        + '<button class="btn small" id="rsSkipSupplement">' + tr('跳过这一步') + ' →</button></div>';
      if (UI.evidence.length) {
        h += '<div class="rsSub">' + tr('已有 {0} 张证据卡', UI.evidence.length) + '</div>';
      }
      return h;
    }
    h += UI.questions.map(function (q, i) {
      return '<div class="rsQ"><div class="rsQT">' + (i + 1) + '. ' + esc(q.q) + '</div>'
        + (q.why ? '<div class="rsQWhy">' + tr('为什么问：') + esc(q.why) + '</div>' : '')
        + (q.example ? '<div class="rsQWhy">' + tr('可以这样答：') + esc(q.example) + '</div>' : '')
        + '<textarea class="rsTextarea sm" data-rs-a="' + esc(q.id) + '" rows="2" placeholder="' + esc(tr('在这里回答…')) + '"></textarea></div>';
    }).join('');
    if (UI.cards && UI.cards.length) {
      h += '<div class="rsCard ai"><div class="rsCardTitle">' + tr('AI 整理出的证据卡（确认后导入）') + '</div>';
      h += UI.cards.map(function (c) {
        return '<div class="rsEvCard"><b>' + esc(c.title || tr('未命名')) + '</b>' + (c.result ? '<div class="rsMuted">' + esc(c.result) + '</div>' : '') + '</div>';
      }).join('');
      h += '<div class="rsBtns"><button class="btn small primary" id="rsImportCards">' + tr('全部导入（{0} 张）', UI.cards.length) + '</button>'
        + '<button class="btn small" id="rsDropCards">' + tr('不要了') + '</button></div></div>';
    } else {
      h += '<div class="rsBtns"><button class="btn small primary" id="rsMakeCards">' + tr('整理成证据卡') + '</button>'
        + '<button class="btn small" id="rsSkipSupplement">' + tr('跳过这一步') + ' →</button></div>';
    }
    if (UI.evidence.length) {
      h += '<div class="rsDivider"></div><div class="rsSub">' + tr('已入库的证据卡（{0} 张）', UI.evidence.length) + '</div>';
      h += '<div class="rsList">' + UI.evidence.map(function (e) {
        return '<div class="rsEvCard"><b>' + esc(e.title || tr('未命名')) + '</b>'
          + (e.result ? '<div class="rsMuted">' + esc(e.result) + '</div>' : '')
          + '<button class="btn small" data-rs-del-ev="' + e.id + '">' + tr('删除') + '</button></div>';
      }).join('') + '</div>';
    }
    return h;
  }

  /* 第 4 步 */
  function stepJdHTML() {
    var h = msgHTML();
    h += head(tr('🎯 第 4 步：选一个目标岗位'), tr('你的资料库里已经有 JD 了，直接从下面挑一个；没有的话再粘贴。'));
    if (!UI.jdSources.length) {
      h += '<div class="rsEmpty" id="rsJdEmpty">' + tr('加载资料库里的 JD…') + '</div>';
    } else {
      h += '<div class="rsList">' + UI.jdSources.map(function (s) {
        return '<div class="rsItem"><div class="rsItemMain"><b>' + esc(s.title || tr('未命名 JD')) + '</b> '
          + '<span class="rsMuted">' + esc(s.site || '') + ' · ' + tr('{0} 字', s.chars || 0) + (s.quality ? ' · ⭐' : '') + '</span>'
          + (s.snippet ? '<div class="rsMuted">' + esc(s.snippet) + '</div>' : '') + '</div>'
          + '<div class="rsItemOps"><button class="btn small primary" data-rs-jd="' + s.id + '">' + tr('选这个') + '</button></div></div>';
      }).join('') + '</div>';
    }
    h += '<details class="rsFold"><summary>' + tr('或者：粘贴 JD 原文') + '</summary>'
      + '<textarea id="rsJdText" class="rsTextarea" spellcheck="false" placeholder="' + esc(tr('把岗位 JD 贴进来（职责 + 要求）')) + '">' + esc(UI.jdText || '') + '</textarea>'
      + '<div class="rsBtns"><button class="btn small primary" id="rsSaveJd">' + tr('用这份 JD') + '</button></div></details>';
    if (has(UI.doc && UI.doc.jd_text)) h += '<div class="rsBtns"><button class="btn small primary" id="rsGoMatch">' + tr('下一步：看匹配结果') + ' →</button></div>';
    return h;
  }

  /* 第 5 步 */
  var MATCH_LABEL = { direct: tr('直接证据'), adjacent: tr('相邻可迁移'), weak: tr('证据薄弱'), gap: tr('证据空白') };
  function stepMatchHTML() {
    var h = msgHTML();
    h += head(tr('📊 第 5 步：匹配与改写'), tr('先看「JD 要求 → 你的证据」矩阵，再决定改写方向。没证据的要求不会编，只列成待补。'));
    var m = UI.match;
    if (!m) {
      h += '<div class="rsEmpty">' + tr('点下面的按钮，AI 会拆解 JD 并逐条对上你的证据。') + '</div>';
      h += '<div class="rsBtns"><button class="btn primary" id="rsDoMatch">' + tr('分析匹配') + '</button></div>';
      return h;
    }
    if (m.summary) h += '<div class="rsSummary">' + esc(m.summary) + '</div>';
    if (m.keywords && m.keywords.length) h += '<div class="rsChips">' + m.keywords.map(function (k) { return '<span class="rsChip">' + esc(k) + '</span>'; }).join('') + '</div>';
    if (m.rows && m.rows.length) {
      h += '<div class="rsTableWrap"><table class="rsTable"><thead><tr><th>' + tr('JD 要求') + '</th><th>' + tr('优先级') + '</th><th>' + tr('匹配') + '</th><th>' + tr('依据') + '</th></tr></thead><tbody>';
      h += m.rows.map(function (r) {
        var ev = (r.evidence || []).filter(has).join('；');
        return '<tr><td>' + esc(r.requirement || '') + '</td><td>' + esc(r.priority || '') + '</td>'
          + '<td><span class="rsBadge ' + esc(r.match || 'gap') + '">' + esc(MATCH_LABEL[r.match] || r.match || '') + '</span></td>'
          + '<td>' + esc([ev, r.note].filter(has).join(' · ') || tr('—')) + '</td></tr>';
      }).join('');
      h += '</tbody></table></div>';
    }
    if (m.gaps && m.gaps.length) h += '<div class="rsSub">' + tr('证据空白（需要补）') + '</div><ul class="rsUl">' + m.gaps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (m.actions && m.actions.length) h += '<div class="rsSub">' + tr('可以怎么补') + '</div><ul class="rsUl">' + m.actions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    h += '<div class="rsBtns"><button class="btn small primary" id="rsGoFinal">' + tr('下一步：生成终版') + ' →</button>'
      + '<button class="btn small" id="rsReMatch">' + tr('重新分析') + '</button></div>';
    return h;
  }

  /* 第 6 步 */
  function stepFinalHTML() {
    var h = msgHTML();
    h += head(tr('✅ 第 6 步：拿到改好的简历'), tr('AI 会按 JD 重写并排版成一页；只重组已有证据，不新增事实。'));
    if (!UI.finalMd) {
      h += '<div class="rsEmpty">' + tr('点下面的按钮生成终版（会改写 + 排版）。') + '</div>';
      h += '<div class="rsBtns"><button class="btn primary" id="rsDoFinal">' + tr('生成终版简历') + '</button></div>';
      return h;
    }
    h += '<div class="rsBtns">'
      + '<button class="btn small primary" id="rsExport">' + tr('下载 .docx') + '</button>'
      + '<button class="btn small primary" id="rsExportHtml">' + tr('打开可编辑网页版') + '</button>'
      + '<button class="btn small" id="rsCopyFinal">' + tr('复制正文') + '</button>'
      + '<button class="btn small" id="rsSaveVer">' + tr('存一版') + '</button>'
      + '<button class="btn small" id="rsReFinal">' + tr('重新生成') + '</button></div>'
      + '<div class="rsHint">' + tr('网页版可直接改字、按「打印 / 存 PDF」导出 A4；docx 用 Word 打开后也能改。') + '</div>';
    h += '<div class="rsMd rsPreview">' + (mdToHTML ? mdToHTML(esc(UI.finalMd)) : '<pre>' + esc(UI.finalMd) + '</pre>') + '</div>';
    if (UI.versions && UI.versions.length) {
      h += '<div class="rsDivider"></div><div class="rsSub">' + tr('版本历史') + '</div><div class="rsList">'
        + UI.versions.slice(0, 8).map(function (v) {
          return '<div class="rsItem"><div class="rsItemMain"><b>#' + v.id + '</b> ' + esc(v.note || tr('未命名版本'))
            + ' <span class="rsMuted">' + esc(shortTime(v.created_at)) + '</span></div>'
            + '<div class="rsItemOps"><button class="btn small" data-rs-restore="' + v.id + '">' + tr('恢复') + '</button></div></div>';
        }).join('') + '</div>';
    }
    return h;
  }

  /* 上一步 / 下一步（只给导航，避免用户被"一定要按顺序"卡住） */
  function stepNavHTML() {
    var cur = stepIndex(UI.step);
    var prev = STEPS[cur - 1], next = STEPS[cur + 1];
    var out = '<div class="rsNav">';
    out += prev ? '<button class="btn small" data-rs-jump="' + prev.key + '">← ' + esc(prev.label) + '</button>' : '<span></span>';
    out += next ? '<button class="btn small" data-rs-jump="' + next.key + '">' + esc(next.label) + ' →</button>' : '<span></span>';
    out += '</div>';
    return out;
  }

  function bindDrop(dropEl, inputEl) {
    if (!dropEl) return;
    dropEl.addEventListener('click', function () { if (inputEl) inputEl.click(); });
    dropEl.addEventListener('dragover', function (e) { e.preventDefault(); dropEl.classList.add('on'); });
    dropEl.addEventListener('dragleave', function () { dropEl.classList.remove('on'); });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault(); dropEl.classList.remove('on');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadFile(f);
    });
    if (inputEl) inputEl.addEventListener('change', function () {
      var f = inputEl.files && inputEl.files[0];
      if (f) uploadFile(f);
    });
  }

  function bindAll() {
    bindDrop($('rsDrop'), $('rsFile'));
    var paste = $('rsPasteSave'); if (paste) paste.addEventListener('click', savePasted);
    var goReview = $('rsGoReview'); if (goReview) goReview.addEventListener('click', function () { captureEdits(); UI.step = 'review'; render(); });
    var doReview = $('rsDoReview'); if (doReview) doReview.addEventListener('click', function () { runStep('review', null, tr('AI 正在通读简历、找问题…'), 'review'); });
    var reReview = $('rsReReview'); if (reReview) reReview.addEventListener('click', function () { runStep('review', null, tr('AI 正在重新审查…'), 'review'); });
    var goSup = $('rsGoSupplement'); if (goSup) goSup.addEventListener('click', function () { UI.step = 'supplement'; render(); });
    var doQ = $('rsDoQuestions'); if (doQ) doQ.addEventListener('click', function () { runStep('questions', null, tr('AI 正在找信息缺口…'), 'supplement'); });
    var mk = $('rsMakeCards'); if (mk) mk.addEventListener('click', makeCards);
    var imp = $('rsImportCards'); if (imp) imp.addEventListener('click', importCards);
    var drop = $('rsDropCards'); if (drop) drop.addEventListener('click', function () { UI.cards = null; render(); });
    var skip = $('rsSkipSupplement'); if (skip) skip.addEventListener('click', function () { UI.step = 'jd'; render(); });
    var saveJd = $('rsSaveJd'); if (saveJd) saveJd.addEventListener('click', saveJdText);
    var goMatch = $('rsGoMatch'); if (goMatch) goMatch.addEventListener('click', function () { UI.step = 'match'; render(); });
    var doMatch = $('rsDoMatch'); if (doMatch) doMatch.addEventListener('click', function () { runStep('match', null, tr('AI 正在拆解 JD 并匹配证据…'), 'match'); });
    var reMatch = $('rsReMatch'); if (reMatch) reMatch.addEventListener('click', function () { runStep('match', null, tr('AI 正在重新匹配…'), 'match'); });
    var goFinal = $('rsGoFinal'); if (goFinal) goFinal.addEventListener('click', function () { UI.step = 'finalize'; render(); });
    var doFinal = $('rsDoFinal'); if (doFinal) doFinal.addEventListener('click', function () { runStep('finalize', null, tr('AI 正在改写并排版…'), 'finalize'); });
    var reFinal = $('rsReFinal'); if (reFinal) reFinal.addEventListener('click', function () { runStep('finalize', null, tr('AI 正在重新生成…'), 'finalize'); });
    var exp = $('rsExport'); if (exp) exp.addEventListener('click', exportDocx);
    var expH = $('rsExportHtml'); if (expH) expH.addEventListener('click', function () { window.open('/api/resume/docs/' + UI.doc.id + '/export-html', '_blank'); });
    var cp = $('rsCopyFinal'); if (cp) cp.addEventListener('click', function () { copyText(UI.finalMd); });
    var sv = $('rsSaveVer'); if (sv) sv.addEventListener('click', async function () {
      try {
        var note = window.prompt(tr('给这一版起个名字（可留空）'), '');
        if (note == null) return;
        await api('/api/resume/docs/' + UI.doc.id + '/versions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: String(note || '').trim(), content_md: UI.finalMd })
        });
        await reload(true);
        UI.notice = tr('已存一版');
      } catch (e) { UI.err = errText(e); }
      render();
    });
    var root = bodyEl() || document;
    root.querySelectorAll('[data-rs-jd]').forEach(function (b) {
      b.addEventListener('click', function () { pickJdSource(Number(b.getAttribute('data-rs-jd'))); });
    });
    root.querySelectorAll('[data-rs-del-ev]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/api/resume/evidence/' + b.getAttribute('data-rs-del-ev'), { method: 'DELETE' });
          await reload(true); render();
        } catch (e) { UI.err = errText(e); render(); }
      });
    });
    root.querySelectorAll('[data-rs-restore]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!window.confirm(tr('恢复到这一版？'))) return;
        try {
          await api('/api/resume/versions/' + b.getAttribute('data-rs-restore') + '/restore', { method: 'POST' });
          await reload(true); render();
        } catch (e) { UI.err = errText(e); render(); }
      });
    });
  }

  /* ---------------- 路由 / 入口（和达成条件同一套） ---------------- */
  SX.registerPlugin({
    id: 'resume',
    goalEntry: {
      label: tr('简历工坊'), icon: '📄', order: 20, header: true,
      hash: function (g) { return '#/g/' + g + '/resume'; },
      show: function (g) { return SX.pluginEnabled(g, 'resume'); }
    },
    routes: [
      {
        match: function (h) { return h.match(/^#\/g\/(\d+)\/resume$/); },
        render: async function (m) {
          gid = Number(m[1]);
          UI.err = ''; UI.notice = ''; UI.busy = '';
          await loadAll();
        }
      },
      /* 老深链接：`#/resume`（以前是抽屉，没有目标上下文）→ 转成最近目标的整页 */
      {
        match: function (h) { return h === '#/resume' || h === '#/resume/'; },
        render: async function () { await redirectLegacyLink(); }
      }
    ]
  });

  /* 老链接没有目标上下文：跳到「最近打开过的目标」的简历页；没有目标就回首页。 */
  async function redirectLegacyLink() {
    var target = 0;
    try {
      var gm = (location.hash || '').match(/^#\/g\/(\d+)(?:\/|$)/);
      if (gm) target = Number(gm[1]);
    } catch (e) {}
    if (!target) {
      try {
        var lr = JSON.parse(localStorage.getItem('sierxing-home-recent-v1') || '[]');
        var first0 = Array.isArray(lr) ? lr[0] : null;
        var id0 = Number((first0 && first0.id) || first0 || 0);
        if (id0 > 0) target = id0;
      } catch (e) {}
    }
    if (!target) {
      try {
        var r = await api('/api/goals');
        var g0 = (r.goals || [])[0];
        if (g0) target = Number(g0.id);
      } catch (e) {}
    }
    location.hash = target ? ('#/g/' + target + '/resume') : '#/';
  }

  /* 老代码兼容：以前目标页/路线图页按钮调 SiErXing.openResumeWorkshop() 打开抽屉。
     现在改成「跳到当前目标的简历整页」，旧调用点不用改也不会破。 */
  try {
    SX.openResumeWorkshop = function () {
      var g = 0;
      try {
        var m = String(location.hash || '').match(/^#\/g\/(\d+)/);
        if (m) g = Number(m[1]);
        else if (SX.state && SX.state.goal && SX.state.goal.id) g = Number(SX.state.goal.id);
      } catch (e) {}
      if (!g) { toast(tr('先打开一个目标，再用「简历工坊」')); return false; }
      location.hash = '#/g/' + g + '/resume';
      return true;
    };
    window.ResumeWorkshop = { open: SX.openResumeWorkshop, close: function () {} };
  } catch (e) {}

  /* 老浮窗的深链接 `?resume=1`：以前直接弹抽屉，现在转成整页（带上当前目标）。 */
  try {
    var legacyQ = new URLSearchParams(location.search || '').get('resume');
    if ((legacyQ === '1' || legacyQ === 'true') && !/^#\/g\/\d+\/resume$/.test(location.hash || '')) {
      var gm1 = (location.hash || '').match(/^#\/g\/(\d+)(?:\/|$)/);
      if (gm1) location.hash = '#/g/' + Number(gm1[1]) + '/resume';
      else redirectLegacyLink();
    }
  } catch (e) {}
})();
