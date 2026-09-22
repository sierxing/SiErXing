/**
 * 思而行 · 前端插件：图片资料（JD / 大纲截图 → 资料源）
 * ------------------------------------------------------------------
 * 演示「粘帖/拖拽上传 + 视觉模型提炼 + 写入资料源」的前端插件写法。
 */
'use strict';
(function () {
  const { api, esc, toast, go, state, mdToHTML, fmtDate, safeParse } = SiErXing;

async function renderJDPage() {
  const g = state.goal;
  app.innerHTML = '<p class="muted">加载 JD 资料…</p>';
  const r = await api('/api/goals/' + g.id + '/jd-images');
  state.jdImages = r.images || [];
  drawJDPage();
}
function jdCardHTML(jd) {
  let ex = null;
  try { ex = JSON.parse(jd.extracted || 'null'); } catch (e) {}
  const sec = (title, arr) => (Array.isArray(arr) && arr.length) ? `<div class="jdSec"><div class="jdSecT">${esc(title)}</div><ul>${arr.map(x => `<li>${esc(String(x))}</li>`).join('')}</ul></div>` : '';
  return `<div class="jdCard" data-jdid="${jd.id}">
    <a class="jdThumb" href="/uploads/${encodeURIComponent(jd.file)}" target="_blank"><img src="/uploads/${encodeURIComponent(jd.file)}" alt="JD"></a>
    <div class="jdMain">
      <div class="jdTop"><span class="jdTitle">${esc(jd.title || 'JD 图片')}</span><span class="chip gray">${esc(fmtDate(jd.created_at))}</span><div class="spacer"></div><button class="btn tiny danger jdDel" data-jdid="${jd.id}">删除</button></div>
      ${ex ? `<div class="jdSum">${esc(ex.summary || '')}</div>` : ''}
      ${ex ? `<details class="jdDet"><summary>查看提炼内容（职责 / 要求 / 技能 / 优先项）</summary>
        ${sec('岗位职责', ex.duties)}${sec('任职要求', ex.requirements)}${sec('技能关键词', ex.skills)}${sec('硬性条件', ex.hard_conditions)}${sec('招聘方最看重', ex.priority)}
        ${ex.raw_text ? `<div class="jdSec"><div class="jdSecT">原文摘录</div><pre class="jdRaw">${esc(String(ex.raw_text).slice(0, 1500))}</pre></div>` : ''}
      </details>` : ''}
      <div class="jdSrc">已作为资料源加入规划（${jd.source_id ? '#' + jd.source_id : '—'}），AI 规划与对话时会优先参考</div>
    </div>
  </div>`;
}
function drawJDPage() {
  const g = state.goal;
  const list = state.jdImages || [];
  app.innerHTML = `<div class="jdPage">
    <div class="jdHead">
      <a class="back" href="#/g/${g.id}">← 返回目标</a>
      <span class="mapTitle">📷 JD 图片资料</span>
      <span class="chip gray">${esc(g.title)}</span>
      <div class="spacer"></div>
      <button class="btn small" id="jdChatBtn">💬 对话改规划</button>
    </div>
    <div class="jdPaste" id="jdPaste">
      <div class="jpIcon">📋</div>
      <div class="jpTitle">点击这里，按 Ctrl+V 粘贴 JD 截图</div>
      <div class="jpText">也可以把图片拖进来，或 <label class="jpFile">选择文件<input type="file" id="jdFile" accept="image/*" multiple hidden></label></div>
      <div class="jpNote">AI 会识别并提炼岗位职责、要求、技能关键词，作为资料源辅助规划决策</div>
      ${state.jdBusy ? `<div class="jpBusy"><span class="spinner"></span> ${esc(state.jdStatus || '正在识别…')}</div>` : ''}
    </div>
    <div class="jdList">${list.length ? list.map(jdCardHTML).join('') : '<div class="muted" style="padding:20px 4px;">还没有 JD 图片。粘贴一份目标岗位的 JD 截图试试。</div>'}</div>
  </div>`;
  const paste = document.getElementById('jdPaste');
  paste.addEventListener('click', () => paste.focus());
  paste.setAttribute('tabindex', '0');
  paste.addEventListener('paste', e => {
    const items = (e.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); uploadJDFile(f); return; }
      }
    }
    toast('剪贴板里没有图片，请先截图/复制 JD 图片');
  });
  paste.addEventListener('dragover', e => { e.preventDefault(); paste.classList.add('over'); });
  paste.addEventListener('dragleave', () => paste.classList.remove('over'));
  paste.addEventListener('drop', e => {
    e.preventDefault(); paste.classList.remove('over');
    const f = (e.dataTransfer.files || [])[0];
    if (f) uploadJDFile(f);
  });
  const fi = document.getElementById('jdFile');
  fi.addEventListener('change', () => { for (const f of Array.from(fi.files || [])) uploadJDFile(f); fi.value = ''; });
  const jc = document.getElementById('jdChatBtn');
  if (jc) jc.addEventListener('click', () => aiToggle(true));
  app.querySelectorAll('.jdDel').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('删除这张 JD 图片及其资料源？')) return;
    try {
      await api('/api/jd-images/' + b.getAttribute('data-jdid'), { method: 'DELETE' });
      state.jdImages = state.jdImages.filter(x => String(x.id) !== String(b.getAttribute('data-jdid')));
      try { await loadGoal(g.id); } catch (e) {}
      drawJDPage();
      toast('已删除');
    } catch (e) { toast(e.message); }
  }));
}
async function uploadJDFile(file) {
  if (state.jdBusy) return toast('正在识别上一张，请稍候');
  if (!file.type || !file.type.startsWith('image/')) return toast('请粘贴图片文件');
  if (file.size > 8 * 1024 * 1024) return toast('图片过大（8MB 以内）');
  state.jdBusy = true;
  state.jdStatus = '正在读取图片…';
  drawJDPage();
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  try {
    const resp = await fetch('/api/goals/' + state.goal.id + '/jd-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接识别服务');
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
        if (d.status) { state.jdStatus = d.status; const el = document.querySelector('.jpBusy'); if (el) el.innerHTML = '<span class="spinner"></span> ' + esc(d.status); }
        if (d.done) { finished = true; state.goal = d.goal; toast('JD 已提炼并加入资料源'); }
        if (d.error) { finished = true; toast(d.error); }
      }
    }
    if (!finished) toast('识别中断，可重试');
  } catch (e) {
    toast(e.message);
  } finally {
    state.jdBusy = false;
    state.jdStatus = '';
    try { const r = await api('/api/goals/' + state.goal.id + '/jd-images'); state.jdImages = r.images || []; } catch (e) {}
    drawJDPage();
  }
}


  SiErXing.registerPlugin({
    id: 'jdfile',
    goalEntry: {
      label: '图片资料',
      icon: '📷',
      order: 30,
      hash: gid => '#/g/' + gid + '/jd',
      show: goal => SiErXing.pluginEnabled(goal, 'jdfile')
    },
    routes: [
      {
        match: h => h.match(/^#\/g\/(\d+)\/jd$/),
        render: async m => { await SiErXing.loadGoal(Number(m[1])); await renderJDPage(); }
      }
    ]
  });
})();
