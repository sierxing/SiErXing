'use strict';
/**
 * 思而行 · 前端扩展组件：简历工坊（resume）
 * ==================================================================
 * 右下角「📄 简历」入口 → 抽屉式面板，四个页签：
 *   简历正文 / 经历证据库 / JD 匹配与改写 / 证据审计。
 * 数据全部走 /api/resume/*（本地 SQLite），AI 提示词由服务端从
 * language/prompts/zh-CN/packs.json 的 resume.* 五个包渲染，用户可在「提示词库」里覆盖。
 *
 * 参考的开源项目（工作流思想来源，详见 docs/resume-component.md）：
 *   1) https://github.com/Elowwwen/resume-evidence-workflow
 *   2) https://github.com/zclllyybb/lofisu-identity-engine
 *   3) https://github.com/Claycui828/ASu-resume-skills
 *   4) https://github.com/Elowwwen/resume-evidence-workflow （用户给出的四个链接中含一个重复项）
 */
(function () {
  var SX = window.SiErXing;
  if (!SX) return;
  if (SX.__resumeWorkshop) return;   /* 只挂一次（组件脚本可能被重新加载） */
  SX.__resumeWorkshop = true;

  var api = SX.api;
  var esc = SX.esc;
  var toast = SX.toast;
  var mdToHTML = SX.mdToHTML || function (s) { return esc(s); };

  /* 文案一律走 tr()（原文即 key，译文在 language/locales 各语言 ui.json）。
     注意：用本文件的局部 tr 函数包起来的字面量才会被 i18n 提取器认作「已管理」。 */
  function tr() { return SX.tr.apply(null, arguments); }

  var UI = {
    docs: [], doc: null, evidence: [], versions: [], reports: [],
    tab: 'doc', busy: '', err: '', notice: '',
    jd: '', questions: null, cards: null, cardForm: null, editing: 0,
    result: null, lastKind: ''
  };

  function $(id) { return document.getElementById(id); }
  function has(v) { return v != null && String(v).length > 0; }
  function shortTime(s) {
    if (!s) return '';
    var t = String(s).replace('T', ' ').slice(0, 16);
    return t;
  }
  var ERRS = {
    need_title: tr('请先填写简历名称'),
    need_jd: tr('先把 JD 原文贴进来'),
    need_answers: tr('先把回答写一下'),
    bad_kind: tr('未知的 AI 动作'),
    not_found: tr('数据不存在，可能已被删除'),
    ai_failed: tr('AI 调用失败：'),
    need_content: tr('简历正文还是空的')
  };
  function errText(e) {
    var m = String((e && e.message) || e || '');
    return ERRS[m] ? ERRS[m] : m;
  }

  /* ---------------- 组件开关 ---------------- */
  function componentOn() {
    try {
      var c = SX.state && SX.state.components;
      return !(c && c.resume === false);
    } catch (e) { return true; }
  }

  /* ---------------- 浮窗入口 ---------------- */
  var fab = null;
  function ensureFab() {
    if (!componentOn()) { if (fab) fab.style.display = 'none'; return; }
    if (fab) { fab.style.display = ''; return; }
    fab = document.createElement('button');
    fab.id = 'resumeFab';
    fab.className = 'resumeFab';
    fab.title = tr('简历工坊：经历证据库 / JD 匹配 / 定向改写 / 证据审计');
    fab.textContent = '📄';
    fab.addEventListener('click', function () { openPanel(); });
    document.body.appendChild(fab);
  }

  /* ---------------- 面板骨架 ---------------- */
  var mask = null, panel = null;
  function ensurePanel() {
    if (panel) return;
    mask = document.createElement('div');
    mask.id = 'resumeMask';
    mask.className = 'rsMask';
    mask.addEventListener('click', closePanel);
    document.body.appendChild(mask);

    panel = document.createElement('aside');
    panel.id = 'resumePanel';
    panel.className = 'resumePanel';
    panel.innerHTML = [
      '<div class="rsHead">',
      '<span class="rsLogo">📄</span>',
      '<span class="rsTitle">' + tr('简历工坊') + '</span>',
      '<span class="rsSub" id="rsDocName"></span>',
      '<span class="rsGrow"></span>',
      '<button class="btn small" id="rsNewDoc" title="' + esc(tr('新建一份简历')) + '">' + tr('＋ 新建') + '</button>',
      '<button class="btn small" id="rsClose" title="' + esc(tr('关闭')) + '">✕</button>',
      '</div>',
      '<div class="rsTabs" id="rsTabs">',
      '<button class="rsTab" data-rs-tab="doc">' + tr('📝 简历') + '</button>',
      '<button class="rsTab" data-rs-tab="evidence">' + tr('🧾 经历证据') + '</button>',
      '<button class="rsTab" data-rs-tab="match">' + tr('🎯 JD 匹配与改写') + '</button>',
      '<button class="rsTab" data-rs-tab="audit">' + tr('🔍 证据审计') + '</button>',
      '</div>',
      '<div class="rsBody" id="rsBody"></div>',
      '<div class="rsFoot">',
      '<span>' + tr('本地存储 · 参考开源项目：') + '</span>',
      '<a href="https://github.com/Elowwwen/resume-evidence-workflow" target="_blank" rel="noopener">resume-evidence-workflow</a>',
      '<a href="https://github.com/zclllyybb/lofisu-identity-engine" target="_blank" rel="noopener">lofisu-identity-engine</a>',
      '<a href="https://github.com/Claycui828/ASu-resume-skills" target="_blank" rel="noopener">ASu-resume-skills</a>',
      '<a href="https://github.com/Elowwwen/resume-evidence-workflow" target="_blank" rel="noopener">resume-evidence-workflow' + tr('（重复引用）') + '</a>',
      '</div>'
    ].join('');
    document.body.appendChild(panel);

    $('rsClose').addEventListener('click', closePanel);
    $('rsNewDoc').addEventListener('click', newDoc);
    $('rsTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-rs-tab]');
      if (!b) return;
      captureDocEdits();
      UI.tab = b.getAttribute('data-rs-tab');
      UI.err = ''; UI.notice = '';
      render();
    });
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        var save = $('rsSave');
        if (save) { e.preventDefault(); save.click(); }
      }
    });
  }

  function openPanel() {
    ensurePanel();
    if (panel.classList.contains('open')) return;
    mask.classList.add('open');
    panel.classList.add('open');
    document.body.classList.add('rsLock');
    open = true;
    loadAll();
  }
  function closePanel() {
    if (mask) mask.classList.remove('open');
    if (panel) panel.classList.remove('open');
    document.body.classList.remove('rsLock');
    open = false;
  }

  /* ---------------- 数据层 ---------------- */
  async function loadAll() {
    UI.busy = tr('加载中…');
    render();
    try {
      var r = await api('/api/resume/docs');
      UI.docs = r.docs || [];
      if (!UI.docs.length) {
        var c = await api('/api/resume/docs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: tr('我的简历'), target_role: '' })
        });
        UI.docs = [c.doc];
      }
      if (!UI.doc || !UI.docs.some(function (d) { return d.id === UI.doc.id; })) {
        UI.doc = UI.docs[0];
      }
      await loadDoc(UI.doc.id);
    } catch (e) {
      UI.err = errText(e);
    } finally {
      UI.busy = '';
      render();
    }
  }

  async function loadDoc(id) {
    var r = await api('/api/resume/docs/' + id);
    UI.doc = r.doc;
    UI.evidence = r.evidence || [];
    UI.versions = r.versions || [];
    UI.reports = r.reports || [];
    UI.questions = null;
    UI.cards = null;
    UI.cardForm = null;
    UI.result = null;
  }

  async function refreshDocData(silent) {
    if (!UI.doc) return;
    try {
      var r = await api('/api/resume/docs/' + UI.doc.id);
      UI.doc = r.doc; UI.evidence = r.evidence || [];
      UI.versions = r.versions || []; UI.reports = r.reports || [];
      if (!silent) { UI.notice = tr('已更新'); render(); }
    } catch (e) { if (!silent) { UI.err = errText(e); render(); } }
  }

  function captureDocEdits() {
    if (!UI.doc) return;
    var role = $('rsRole'), content = $('rsContent'), jd = $('rsJd');
    if (role) UI.doc.target_role = role.value;
    if (content) UI.doc.content_md = content.value;
    if (jd) UI.jd = jd.value;
  }

  async function saveDoc(showToast) {
    if (!UI.doc) return;
    captureDocEdits();
    UI.busy = tr('保存中…'); render();
    try {
      var r = await api('/api/resume/docs/' + UI.doc.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: UI.doc.title, target_role: UI.doc.target_role, content_md: UI.doc.content_md })
      });
      UI.doc = r.doc;
      UI.notice = showToast ? tr('已保存') : '';
      if (showToast) toast(tr('已保存'));
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function newDoc() {
    var title = window.prompt(tr('给新简历起个名字（例如：AI 产品经理-A 版）'), tr('新简历'));
    if (title == null) return;
    title = String(title).trim();
    if (!title) return;
    UI.busy = tr('创建中…'); render();
    try {
      var r = await api('/api/resume/docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, target_role: '' })
      });
      UI.doc = r.doc;
      await loadDoc(UI.doc.id);
      UI.docs.unshift(r.doc);
      UI.tab = 'doc'; UI.notice = tr('已创建');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function saveVersion() {
    if (!UI.doc) return;
    captureDocEdits();
    var note = window.prompt(tr('给这一版起个名字（可留空，例如：投 XX 公司前）'), '');
    if (note === null) return;
    UI.busy = tr('存版本中…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: String(note || '').trim(), content_md: UI.doc.content_md })
      });
      await saveDoc(false);
      UI.notice = tr('已存为一个版本');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function restoreVersion(vid) {
    if (!window.confirm(tr('恢复到这一版？当前正文会先自动存一份。'))) return;
    UI.busy = tr('恢复中…'); render();
    try {
      var r = await api('/api/resume/versions/' + vid + '/restore', { method: 'POST' });
      UI.doc = r.doc;
      await refreshDocData(true);
      UI.notice = tr('已恢复');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  function readErrCode(e) { return String((e && e.message) || e || ''); }

  /* ---------------- AI 调用 ---------------- */
  async function runAI(kind, extra) {
    if (!UI.doc) return;
    captureDocEdits();
    var payload = { kind: kind };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    var busyText = {
      questions: tr('AI 正在通读简历、找信息缺口…'),
      evidence: tr('AI 正在把你的回答整理成证据卡…'),
      match: tr('AI 正在拆解 JD 并做证据匹配…'),
      rewrite: tr('AI 正在按 JD 定向改写…'),
      audit: tr('AI 正在逐条审计简历主张…')
    }[kind] || tr('AI 正在处理…');
    UI.busy = busyText; UI.err = ''; UI.notice = ''; UI.questions = null; UI.cards = null; UI.result = null;
    render();
    try {
      var r = await api('/api/resume/docs/' + UI.doc.id + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      UI.lastKind = kind;
      if (kind === 'questions') UI.questions = r.data.questions || [];
      else if (kind === 'evidence') UI.cards = r.data.cards || [];
      else UI.result = { kind: kind, data: r.data, raw: !!r.raw, reportId: r.reportId };
      await refreshDocData(true);
      UI.notice = r.raw ? tr('AI 没按 JSON 返回，下面是原文；可重试或换模型。') : '';
    } catch (e) {
      var code = readErrCode(e);
      if (code === 'ai_failed') {
        UI.err = tr('AI 调用失败。先到「设置 → AI 接入」确认模型可用；或稍后重试。');
      } else UI.err = errText(e);
    }
    UI.busy = ''; render();
  }

  async function addEvidence(list) {
    if (!UI.doc) return;
    UI.busy = tr('导入证据卡中…'); render();
    try {
      await api('/api/resume/docs/' + UI.doc.id + '/evidence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: list })
      });
      UI.cards = null;
      await refreshDocData(true);
      UI.notice = tr('已导入 {0} 张证据卡', list.length);
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function saveEvidenceCard(card, id) {
    if (!UI.doc) return;
    UI.busy = tr('保存中…'); render();
    try {
      if (id) {
        await api('/api/resume/evidence/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
      } else {
        await api('/api/resume/docs/' + UI.doc.id + '/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: [card] }) });
      }
      UI.cardForm = null; UI.editing = 0;
      await refreshDocData(true);
      UI.notice = tr('证据卡已保存');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function delEvidence(id) {
    if (!window.confirm(tr('删除这张证据卡？'))) return;
    UI.busy = tr('删除中…'); render();
    try {
      await api('/api/resume/evidence/' + id, { method: 'DELETE' });
      await refreshDocData(true);
      UI.notice = tr('已删除');
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  async function showReport(rid) {
    UI.busy = tr('读取报告…'); render();
    try {
      var r = await api('/api/resume/reports/' + rid);
      UI.result = { kind: r.report.kind, data: r.report.data, raw: false, reportId: rid };
    } catch (e) { UI.err = errText(e); }
    UI.busy = ''; render();
  }

  function copyText(text) {
    var s = String(text || '');
    if (!s) { toast(tr('没有可复制的内容')); return; }
    var done = function () { toast(tr('已复制到剪贴板')); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, function () { fallbackCopy(s, done); });
    } else fallbackCopy(s, done);
  }
  function fallbackCopy(s, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      ta.remove(); done();
    } catch (e) { toast(tr('复制失败，请手动选择文本')); }
  }

  /* ---------------- 渲染：公共块 ---------------- */
  function head(title, sub) {
    return '<div class="rsSecHead"><div class="rsSecTitle">' + title + '</div>'
      + (sub ? '<div class="rsSecSub">' + sub + '</div>' : '') + '</div>';
  }
  function noticeHTML() {
    var out = '';
    if (UI.err) out += '<div class="rsMsg bad">' + esc(UI.err) + '</div>';
    if (UI.notice) out += '<div class="rsMsg ok">' + esc(UI.notice) + '</div>';
    return out;
  }
  function busyHTML() {
    return UI.busy ? '<div class="rsBusy"><span class="rsSpin"></span>' + esc(UI.busy) + '</div>' : '';
  }
  function badges(list) {
    if (!list || !list.length) return '';
    return '<div class="rsChips">' + list.map(function (x) { return '<span class="rsChip">' + esc(x) + '</span>'; }).join('') + '</div>';
  }

  var MATCH_LABEL = {
    direct: tr('直接证据'), adjacent: tr('相邻可迁移'), weak: tr('证据薄弱'), gap: tr('证据空白')
  };
  /* 状态映射用 tr() 取 key：中文环境等于 AI 返回的状态词，英文环境取不到就退化成灰色徽章 */
  var STATUS_CLASS = {};
  STATUS_CLASS[tr('已证实')] = 'ok';
  STATUS_CLASS[tr('部分证实')] = 'warn';
  STATUS_CLASS[tr('存在直接矛盾')] = 'bad';
  STATUS_CLASS[tr('缺乏支持')] = 'bad';
  STATUS_CLASS[tr('暂不可核验')] = 'mute';

  /* ---------------- 渲染：简历页签 ---------------- */
  function docTabHTML() {
    var d = UI.doc || {};
    var len = (d.content_md || '').length;
    var h = noticeHTML();
    h += head(tr('📝 简历正文'), tr('粘贴现有简历，后续所有 AI 分析都基于它 + 证据卡。'));
    h += '<div class="rsRow"><label class="rsLbl">' + tr('简历名称') + '</label>'
      + '<input id="rsTitle" class="rsInput" value="' + esc(d.title || '') + '" placeholder="' + esc(tr('例如：张思为-AIPM')) + '"></div>';
    h += '<div class="rsRow"><label class="rsLbl">' + tr('目标岗位') + '</label>'
      + '<input id="rsRole" class="rsInput" value="' + esc(d.target_role || '') + '" placeholder="' + esc(tr('例如：AI 产品经理实习')) + '"></div>';
    h += '<div class="rsRow rsRowTop"><label class="rsLbl">' + tr('正文（Markdown / 纯文本）') + '</label>'
      + '<span class="rsHint">' + tr('{0} 字', len) + '</span></div>';
    h += '<textarea id="rsContent" class="rsTextarea" spellcheck="false" placeholder="'
      + esc(tr('把现有简历粘贴进来；没有简历就先去「经历证据」用 AI 追问把经历挖出来。')) + '">' + esc(d.content_md || '') + '</textarea>';
    h += '<div class="rsBtns">'
      + '<button class="btn small primary" id="rsSave">' + tr('保存') + '</button>'
      + '<button class="btn small" id="rsVersion">' + tr('存版本') + '</button>'
      + '<button class="btn small" id="rsCopy">' + tr('复制正文') + '</button>'
      + '<span class="rsHint">' + tr('快捷键 Ctrl/⌘ + Enter 保存') + '</span></div>';

    h += '<div class="rsDivider"></div>';
    h += head(tr('🕘 版本历史'), tr('存版本后用「恢复」回到任意一版；恢复前会先自动存一份当前正文。'));
    if (!UI.versions.length) h += '<div class="rsEmpty">' + tr('还没有版本。点上面「存版本」把当前正文存下来。') + '</div>';
    else {
      h += '<div class="rsList">' + UI.versions.map(function (v) {
        return '<div class="rsItem"><div class="rsItemMain"><b>#' + v.id + '</b> ' + esc(v.note || tr('未命名版本'))
          + ' <span class="rsMuted">' + esc(shortTime(v.created_at)) + ' · ' + tr('{0} 字', v.chars || 0) + '</span></div>'
          + '<div class="rsItemOps"><button class="btn small" data-rs-act="restore-version" data-id="' + v.id + '">' + tr('恢复') + '</button></div></div>';
      }).join('') + '</div>';
    }
    return h;
  }

  function bindDocTab() {
    var save = $('rsSave');
    if (save) save.addEventListener('click', function () { saveDoc(true); });
    var ver = $('rsVersion');
    if (ver) ver.addEventListener('click', saveVersion);
    var cp = $('rsCopy');
    if (cp) cp.addEventListener('click', function () { captureDocEdits(); copyText(UI.doc && UI.doc.content_md); });
    var role = $('rsRole');
    if (role) role.addEventListener('input', function () { if (UI.doc) UI.doc.target_role = role.value; });
    var title = $('rsTitle');
    if (title) title.addEventListener('input', function () { if (UI.doc) UI.doc.title = title.value; });
    var content = $('rsContent');
    if (content) content.addEventListener('input', function () {
      if (UI.doc) UI.doc.content_md = content.value;
      var hint = $('rsCharHint');
      if (hint) hint.textContent = tr('{0} 字', content.value.length);
    });
  }

  /* ---------------- 渲染：经历证据页签 ---------------- */
  function evidenceCardHTML(e) {
    var meta = [e.org, e.role, e.period].filter(has).join(' · ');
    var body = [];
    if (e.situation) body.push('<div class="rsEvLine"><span>' + tr('情境') + '</span>' + esc(e.situation) + '</div>');
    if (e.task) body.push('<div class="rsEvLine"><span>' + tr('任务') + '</span>' + esc(e.task) + '</div>');
    if (e.action) body.push('<div class="rsEvLine"><span>' + tr('行动') + '</span>' + esc(e.action) + '</div>');
    if (e.result) body.push('<div class="rsEvLine"><span>' + tr('结果') + '</span>' + esc(e.result) + '</div>');
    if (e.scope) body.push('<div class="rsEvLine"><span>' + tr('范围') + '</span>' + esc(e.scope) + '</div>');
    if (e.metrics) body.push('<div class="rsEvLine"><span>' + tr('指标') + '</span>' + esc(e.metrics) + '</div>');
    if (e.source) body.push('<div class="rsEvLine"><span>' + tr('来源') + '</span>' + esc(e.source) + '</div>');
    return '<div class="rsEvCard">'
      + '<div class="rsEvHead"><b>' + esc(e.title || tr('未命名证据')) + '</b>'
      + (meta ? '<span class="rsMuted">' + esc(meta) + '</span>' : '') + '</div>'
      + (body.length ? '<div class="rsEvBody">' + body.join('') + '</div>' : '')
      + '<div class="rsItemOps">'
      + '<button class="btn small" data-rs-act="edit-evidence" data-id="' + e.id + '">' + tr('编辑') + '</button>'
      + '<button class="btn small" data-rs-act="del-evidence" data-id="' + e.id + '">' + tr('删除') + '</button>'
      + '</div></div>';
  }

  function evidenceFormHTML(card) {
    var c = card || {};
    var f = function (key, label, ph, rows) {
      var v = c[key] || '';
      return '<div class="rsRow rsRowTop"><label class="rsLbl">' + label + '</label>'
        + (rows ? '<textarea class="rsTextarea sm" data-rs-field="' + key + '" rows="' + rows + '" placeholder="' + esc(ph || '') + '">' + esc(v) + '</textarea>'
          : '<input class="rsInput" data-rs-field="' + key + '" value="' + esc(v) + '" placeholder="' + esc(ph || '') + '">')
        + '</div>';
    };
    return '<div class="rsForm">'
      + '<div class="rsFormTitle">' + (UI.editing ? tr('编辑证据卡') : tr('新增证据卡')) + '</div>'
      + f('title', tr('一句话标题'), tr('例如：独立完成 AI 规划产品的产品定义与上线'))
      + f('org', tr('组织 / 项目'), tr('例如：思而行 SiErXing'))
      + f('role', tr('角色（按原话写，别升级）'), tr('例如：独立开发 / 核心成员'))
      + f('period', tr('时间'), tr('例如：2026.09–2026.10'))
      + f('situation', tr('背景 / 情境'), tr('当时要解决什么问题？'), 2)
      + f('task', tr('任务 / 目标'), tr('你个人要达成什么？'), 2)
      + f('action', tr('行动'), tr('你具体做了什么、怎么做的？'), 3)
      + f('result', tr('结果'), tr('结果是什么？有口径就写口径。'), 2)
      + f('scope', tr('范围 / 边界'), tr('负责哪部分、几人协作、不负责什么'), 2)
      + f('metrics', tr('指标 / 数据'), tr('数字 + 口径；估计要标注「估计」'), 2)
      + f('source', tr('来源 / 可核验线索'), tr('仓库、文档、截图、看板链接…'), 1)
      + '<div class="rsBtns"><button class="btn small primary" id="rsEvSave">' + tr('保存证据卡') + '</button>'
      + '<button class="btn small" id="rsEvCancel">' + tr('取消') + '</button></div>'
      + '</div>';
  }

  function evidenceTabHTML() {
    var h = noticeHTML();
    h += head(tr('🧾 经历证据库'), tr('简历没东西写，多半是经历没被挖出来——不是真的没有。先建证据卡，再拿证据卡去对 JD。'));
    h += '<div class="rsBtns">'
      + '<button class="btn small primary" id="rsMine">' + tr('🤖 AI 追问挖经历') + '</button>'
      + '<button class="btn small" id="rsAddEv">' + tr('＋ 新增证据卡') + '</button>'
      + '<span class="rsHint">' + tr('已有 {0} 张证据卡', UI.evidence.length) + '</span></div>';

    if (UI.questions && UI.questions.length) {
      h += '<div class="rsCard ai"><div class="rsCardTitle">' + tr('AI 追问：一次答一两题就行，答完点「整理成证据卡」') + '</div>';
      h += UI.questions.map(function (q, i) {
        return '<div class="rsQ"><div class="rsQT">' + (i + 1) + '. ' + esc(q.q) + '</div>'
          + (q.why ? '<div class="rsQWhy">' + tr('为什么问：') + esc(q.why) + '</div>' : '')
          + (q.example ? '<div class="rsQWhy">' + tr('可以这样答：') + esc(q.example) + '</div>' : '')
          + '<textarea class="rsTextarea sm" data-rs-answer="' + esc(q.id) + '" rows="2" placeholder="'
          + esc(tr('在这里回答…')) + '"></textarea></div>';
      }).join('');
      h += '<div class="rsBtns"><button class="btn small primary" id="rsMakeCards">' + tr('整理成证据卡') + '</button>'
        + '<button class="btn small" id="rsCloseQ">' + tr('收起追问') + '</button></div></div>';
    }

    if (UI.cards && UI.cards.length) {
      h += '<div class="rsCard ai"><div class="rsCardTitle">' + tr('AI 整理出的证据卡（确认后再导入）') + '</div>';
      h += UI.cards.map(function (c) { return '<div class="rsEvCard"><div class="rsEvHead"><b>' + esc(c.title || tr('未命名证据')) + '</b>'
        + (c.result ? '<span class="rsMuted">' + esc(c.result) + '</span>' : '') + '</div></div>'; }).join('');
      h += '<div class="rsBtns"><button class="btn small primary" id="rsImportCards">' + tr('全部导入（{0} 张）', UI.cards.length) + '</button>'
        + '<button class="btn small" id="rsDropCards">' + tr('不要了') + '</button></div></div>';
    }

    if (UI.cardForm) h += evidenceFormHTML(UI.cardForm);
    else if (!UI.evidence.length && !UI.questions && !UI.cards) {
      h += '<div class="rsEmpty">' + tr('还没有证据卡。点「AI 追问挖经历」，从你做过的事里把证据挖出来。') + '</div>';
    }
    if (UI.evidence.length) {
      h += '<div class="rsList ev">' + UI.evidence.map(evidenceCardHTML).join('') + '</div>';
    }
    return h;
  }

  function bindEvidenceTab() {
    var mine = $('rsMine');
    if (mine) mine.addEventListener('click', function () { runAI('questions'); });
    var add = $('rsAddEv');
    if (add) add.addEventListener('click', function () { UI.cardForm = {}; UI.editing = 0; render(); });
    var save = $('rsEvSave');
    if (save) save.addEventListener('click', function () {
      var card = {};
      panel.querySelectorAll('[data-rs-field]').forEach(function (inp) { card[inp.getAttribute('data-rs-field')] = inp.value; });
      saveEvidenceCard(card, UI.editing);
    });
    var cancel = $('rsEvCancel');
    if (cancel) cancel.addEventListener('click', function () { UI.cardForm = null; UI.editing = 0; render(); });
    var make = $('rsMakeCards');
    if (make) make.addEventListener('click', function () {
      var lines = [];
      (UI.questions || []).forEach(function (q, i) {
        var ta = panel.querySelector('[data-rs-answer="' + q.id + '"]');
        var ans = ta ? String(ta.value || '').trim() : '';
        if (ans) lines.push('Q' + (i + 1) + '：' + q.q + '\nA' + (i + 1) + '：' + ans);
      });
      if (!lines.length) { UI.err = tr('至少回答一道题再整理'); render(); return; }
      runAI('evidence', { answers: lines.join('\n\n') });
    });
    var closeQ = $('rsCloseQ');
    if (closeQ) closeQ.addEventListener('click', function () { UI.questions = null; render(); });
    var imp = $('rsImportCards');
    if (imp) imp.addEventListener('click', function () { addEvidence(UI.cards || []); });
    var drop = $('rsDropCards');
    if (drop) drop.addEventListener('click', function () { UI.cards = null; render(); });
  }

  /* ---------------- 渲染：JD 匹配 / 改写 ---------------- */
  function matchRowsHTML(data) {
    var rows = data.rows || [];
    if (!rows.length) return '';
    var h = '<div class="rsTableWrap"><table class="rsTable"><thead><tr>'
      + '<th>' + tr('JD 要求') + '</th><th>' + tr('优先级') + '</th><th>' + tr('匹配') + '</th><th>' + tr('证据 / 说明') + '</th>'
      + '</tr></thead><tbody>';
    h += rows.map(function (r) {
      var ev = (r.evidence || []).filter(has).join('；');
      var note = [ev, r.note].filter(has).join(' · ');
      return '<tr><td>' + esc(r.requirement || '') + '</td>'
        + '<td>' + esc(r.priority || '') + '</td>'
        + '<td><span class="rsBadge ' + esc(r.match || 'gap') + '">' + esc(MATCH_LABEL[r.match] || r.match || '') + '</span></td>'
        + '<td>' + esc(note || tr('—')) + '</td></tr>';
    }).join('');
    return h + '</tbody></table></div>';
  }

  function resultHTML() {
    if (!UI.result) return '';
    var d = UI.result.data || {};
    var kind = UI.result.kind;
    var h = '<div class="rsCard ai"><div class="rsCardTitle">'
      + (kind === 'match' ? tr('JD 匹配矩阵') : kind === 'rewrite' ? tr('定向改写建议') : kind === 'audit' ? tr('证据审计报告') : tr('AI 结果'))
      + '<button class="btn small rsRight" id="rsCopyResult">' + tr('复制') + '</button></div>';
    if (d.raw) {
      h += '<div class="rsMd">' + (mdToHTML ? mdToHTML(esc(d.raw)) : '<pre>' + esc(d.raw) + '</pre>') + '</div>';
      return h + '</div>';
    }
    if (d.summary) h += '<div class="rsSummary">' + esc(d.summary) + '</div>';
    if (kind === 'match') {
      if (d.overall) h += '<div class="rsHint">' + tr('整体判断：') + esc(d.overall) + '</div>';
      if (d.keywords && d.keywords.length) h += badges(d.keywords);
      h += matchRowsHTML(d);
      if (d.gaps && d.gaps.length) h += '<div class="rsSub">' + tr('证据空白') + '</div><ul class="rsUl">' + d.gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>';
      if (d.actions && d.actions.length) h += '<div class="rsSub">' + tr('下一步动作') + '</div><ul class="rsUl">' + d.actions.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>';
    } else if (kind === 'rewrite') {
      h += (d.bullets || []).map(function (b) {
        return '<div class="rsBullet"><div class="rsBOrig">' + esc(b.original || '') + '</div>'
          + '<div class="rsBNew">' + esc(b.rewritten || '') + '</div>'
          + '<div class="rsBMeta">' + (b.basis ? tr('依据：') + esc(b.basis) : '') + (b.jd ? ' · ' + tr('对应 JD：') + esc(b.jd) : '') + '</div>'
          + (b.risk ? '<div class="rsBWarn">⚠ ' + esc(b.risk) + '</div>' : '')
          + '<button class="btn small" data-rs-act="copy-bullet" data-idx="' + (d.bullets || []).indexOf(b) + '">' + tr('复制改写结果') + '</button></div>';
      }).join('');
      if (d.warnings && d.warnings.length) h += '<div class="rsSub">' + tr('注意') + '</div><ul class="rsUl">' + d.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    } else if (kind === 'audit') {
      var claims = d.claims || [];
      h += '<div class="rsList">' + claims.map(function (c) {
        var cls = STATUS_CLASS[c.status] || 'mute';
        return '<div class="rsClaim"><div class="rsClaimH"><span class="rsBadge ' + cls + '">' + esc(c.status || '') + '</span>'
          + '<span class="rsMuted">' + esc(c.type || '') + (c.confidence ? ' · ' + esc(c.confidence) : '') + '</span></div>'
          + '<div class="rsClaimT">' + esc(c.claim || '') + '</div>'
          + (c.evidence ? '<div class="rsEvLine"><span>' + tr('证据') + '</span>' + esc(c.evidence) + '</div>' : '')
          + (c.risk ? '<div class="rsBWarn">⚠ ' + esc(c.risk) + '</div>' : '')
          + '</div>';
      }).join('') + '</div>';
      if (d.patterns && d.patterns.length) h += '<div class="rsSub">' + tr('夸大模式（只是调查信号，不等于造假）') + '</div><ul class="rsUl">' + d.patterns.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
      if (d.to_fill && d.to_fill.length) h += '<div class="rsSub">' + tr('补什么证据能提升可信度') + '</div><ul class="rsUl">' + d.to_fill.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
    }
    h += '</div>';
    return h;
  }

  function reportsHTML() {
    if (!UI.reports.length) return '';
    return '<div class="rsDivider"></div>' + head(tr('历史分析'))
      + '<div class="rsList">' + UI.reports.slice(0, 12).map(function (r) {
        return '<div class="rsItem"><div class="rsItemMain"><b>' + esc(kindName(r.kind)) + '</b> <span class="rsMuted">'
          + esc(shortTime(r.created_at)) + ' · ' + tr('{0} 字', r.chars || 0) + '</span></div>'
          + '<div class="rsItemOps"><button class="btn small" data-rs-act="open-report" data-id="' + r.id + '">' + tr('查看') + '</button></div></div>';
      }).join('') + '</div>';
  }
  function kindName(k) {
    return ({ match: tr('JD 匹配'), rewrite: tr('定向改写'), audit: tr('证据审计'), questions: tr('经历追问'), evidence: tr('证据卡') })[k] || k;
  }

  function matchTabHTML() {
    var h = noticeHTML();
    h += head(tr('🎯 JD 匹配与改写'), tr('先看「要求 → 证据」矩阵，再决定强调/压缩/改写；不要先改写再找理由。'));
    h += '<textarea id="rsJd" class="rsTextarea" spellcheck="false" placeholder="' + esc(tr('把目标岗位的 JD 原文完整贴进来（职责 + 要求 + 加分项）')) + '">' + esc(UI.jd || '') + '</textarea>';
    h += '<div class="rsBtns">'
      + '<button class="btn small primary" id="rsMatch">' + tr('分析匹配') + '</button>'
      + '<button class="btn small" id="rsRewrite">' + tr('按 JD 改写') + '</button>'
      + '<span class="rsHint">' + tr('改写只会重组证据，不新增事实') + '</span></div>';
    h += resultHTML();
    h += reportsHTML();
    return h;
  }

  function bindMatchTab() {
    var jd = $('rsJd');
    if (jd) jd.addEventListener('input', function () { UI.jd = jd.value; });
    var m = $('rsMatch');
    if (m) m.addEventListener('click', function () { if (!UI.jd.trim()) { UI.err = tr('先把 JD 原文贴进来'); render(); return; } runAI('match', { jd: UI.jd }); });
    var rw = $('rsRewrite');
    if (rw) rw.addEventListener('click', function () { if (!UI.jd.trim()) { UI.err = tr('先把 JD 原文贴进来'); render(); return; } runAI('rewrite', { jd: UI.jd }); });
  }

  function auditTabHTML() {
    var h = noticeHTML();
    h += head(tr('🔍 证据审计'), tr('把简历拆成原子主张，逐条给证据状态；它只描述证据支持到哪一步，不评价人格。'));
    h += '<div class="rsBtns"><button class="btn small primary" id="rsAudit">' + tr('审计当前简历') + '</button>'
      + '<span class="rsHint">' + tr('建议先补证据卡，再审计') + '</span></div>';
    h += resultHTML();
    h += reportsHTML();
    return h;
  }
  function bindAuditTab() {
    var a = $('rsAudit');
    if (a) a.addEventListener('click', function () { runAI('audit'); });
  }

  /* ---------------- 总渲染 ---------------- */
  function render() {
    if (!panel) return;
    var name = $('rsDocName');
    if (name) name.textContent = UI.doc ? (UI.doc.title || '') : '';
    var tabs = panel.querySelectorAll('[data-rs-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-rs-tab') === UI.tab);
    }
    var body = $('rsBody');
    var html = '';
    if (UI.busy) html = busyHTML();
    else if (!UI.doc) html = '<div class="rsEmpty">' + tr('还没有简历。点右上角「＋ 新建」开始。') + '</div>';
    else if (UI.tab === 'evidence') html = evidenceTabHTML();
    else if (UI.tab === 'match') html = matchTabHTML();
    else if (UI.tab === 'audit') html = auditTabHTML();
    else html = docTabHTML();
    body.innerHTML = html;
    if (UI.busy || !UI.doc) return;
    if (UI.tab === 'doc') bindDocTab();
    else if (UI.tab === 'evidence') bindEvidenceTab();
    else if (UI.tab === 'match') bindMatchTab();
    else if (UI.tab === 'audit') bindAuditTab();
    var copy = $('rsCopyResult');
    if (copy) copy.addEventListener('click', function () {
      if (!UI.result) return;
      var d = UI.result.data || {};
      if (UI.result.kind === 'rewrite') copyText((d.bullets || []).map(function (b) { return b.rewritten; }).join('\n'));
      else copyText(JSON.stringify(d, null, 2));
    });
    body.querySelectorAll('[data-rs-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-rs-act');
        var id = Number(btn.getAttribute('data-id') || 0);
        if (act === 'restore-version') restoreVersion(id);
        else if (act === 'edit-evidence') {
          var ev = UI.evidence.filter(function (x) { return x.id === id; })[0];
          if (ev) { UI.cardForm = ev; UI.editing = id; UI.tab = 'evidence'; render(); }
        } else if (act === 'del-evidence') delEvidence(id);
        else if (act === 'open-report') showReport(id);
        else if (act === 'copy-bullet') {
          var idx = Number(btn.getAttribute('data-idx') || 0);
          var b = (UI.result && UI.result.data && UI.result.data.bullets) || [];
          if (b[idx]) copyText(b[idx].rewritten);
        }
      });
    });
  }

  /* ---------------- 启动 ---------------- */
  function wantAutoOpen() {
    try {
      var q = new URLSearchParams(location.search || '').get('resume');
      if (q === '1' || q === 'true') return true;
      return (location.hash || '') === '#/resume';
    } catch (e) { return false; }
  }
  function boot() {
    if (!componentOn()) return;
    ensureFab();
    /* 深链接：?resume=1 或 #/resume 直接打开面板（方便从目标页/分享链接跳进来） */
    if (wantAutoOpen()) setTimeout(function () { openPanel(); }, 60);
  }
  var tries = 0;
  (function waitReady() {
    if (SX.state && SX.state.components != null) { boot(); return; }
    if (tries++ > 40) { boot(); return; }
    setTimeout(waitReady, 250);
  })();
})();
