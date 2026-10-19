'use strict';
/**
 * 内置 UI 插件 · 使用引导（#/guide/:step）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/guide/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

/* 引导内容里的行内 Markdown（**粗体** / `代码`）→ HTML，保证排版正常 */
function gdInline(html) {
  return String(html == null ? '' : html)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function guideDone() { try { return localStorage.getItem('sierxing-guide-done') === '1'; } catch (e) { return false; } }

function closeGuide(remember) {
  if (remember) { try { localStorage.setItem('sierxing-guide-done', '1'); } catch (e) {} }
  const m = document.getElementById('guideMask');
  if (m) m.remove();
}

function showGuide(step) {
  H.state.guideStep = typeof step === 'number' ? step : 0;
  document.querySelectorAll('#guideMask').forEach(x => x.remove());
  const mask = document.createElement('div');
  mask.id = 'guideMask';
  mask.className = 'guideMask';
  document.body.appendChild(mask);
  drawGuide();
}

function drawGuide() {
  const mask = document.getElementById('guideMask');
  if (!mask) return;
  const i = H.state.guideStep || 0;
  const s = H.GUIDE_STEPS[i];
  const last = i === H.GUIDE_STEPS.length - 1;
  const aiReady = !!(H.state.aiStatus && H.state.aiStatus.configured);
  mask.innerHTML = `<div class="guideCard">
    <div class="guideHead">
      <span class="gdIcon">${s.icon}</span>
      <span class="gdTitle">${H.esc(s.title)}</span>
      <div class="spacer"></div>
      <span class="gdCount">${i + 1} / ${H.GUIDE_STEPS.length}</span>
      <button class="guideX" id="gdClose" title="关闭">×</button>
    </div>
    ${s.visual ? `<div class="guideVisual">${s.visual}</div>` : ''}
    <div class="guideBody mdBody">${gdInline(s.html)}</div>
    <div class="guideFoot">
      <label class="gdNoShow"><input type="checkbox" id="gdNoShow" ${guideDone() ? 'checked' : ''}> 以后不再显示</label>
      <div class="spacer"></div>
      <div class="guideDots">${H.GUIDE_STEPS.map((_, k) => `<span class="gdDot ${k === i ? 'on' : ''}" data-gd="${k}"></span>`).join('')}</div>
      ${i > 0 ? '<button class="btn" id="gdPrev">上一步</button>' : ''}
      ${last
        ? (aiReady ? '<button class="btn primary" id="gdStart">开始使用</button>'
                   : '<button class="btn primary" id="gdSetup">去配置模型</button><button class="btn" id="gdStart">先逛逛</button>')
        : '<button class="btn primary" id="gdNext">下一步</button>'}
    </div>
  </div>`;
  mask.querySelector('#gdClose').addEventListener('click', () => closeGuide(mask.querySelector('#gdNoShow').checked));
  const next = mask.querySelector('#gdNext');
  if (next) next.addEventListener('click', () => { H.state.guideStep = i + 1; drawGuide(); });
  const prev = mask.querySelector('#gdPrev');
  if (prev) prev.addEventListener('click', () => { H.state.guideStep = i - 1; drawGuide(); });
  const start = mask.querySelector('#gdStart');
  if (start) start.addEventListener('click', () => closeGuide(mask.querySelector('#gdNoShow').checked));
  const setup = mask.querySelector('#gdSetup');
  if (setup) setup.addEventListener('click', () => { closeGuide(true); H.go('#/settings'); });
  mask.querySelectorAll('[data-gd]').forEach(d => d.addEventListener('click', () => { H.state.guideStep = Number(d.getAttribute('data-gd')); drawGuide(); }));
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
      const p = H.AI_PRESETS[Number(b.getAttribute('data-gdpre'))];
      mask.querySelector('#gdAiBase').value = p.base;
      mask.querySelector('#gdAiModel').value = p.model;
      if (p.key) mask.querySelector('#gdAiKey').value = p.key;
      H.toast('已填入「' + p.name + '」配置，接着填 API 密钥即可');
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
        await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guideBody) });
        const t = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (t.ok) { msg.textContent = '✅ 连接正常，可以开始用了'; msg.style.color = 'var(--ok)'; H.toast('AI 已配置好'); }
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
        const r = await H.api('/api/components');
        const base = (r.components || []).filter(c => c.scope === 'base');
        compList.innerHTML = base.map(c => `<label class="gdCompRow">
            <span class="gdCompIcon">${c.icon}</span><span class="gdCompName">${H.esc(c.name)}</span>
            <label class="cmpSwitch"><input type="checkbox" data-gdcomp="${H.esc(c.id)}" ${r.enabled[c.id] !== false ? 'checked' : ''}><span class="cmpSlider"></span></label>
          </label>`).join('');
        compList.querySelectorAll('[data-gdcomp]').forEach(inp => inp.addEventListener('change', async () => {
          const id = inp.getAttribute('data-gdcomp');
          try {
            await H.api('/api/components/' + encodeURIComponent(id) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: inp.checked }) });
            await H.loadComponents();
            H.toast(inp.checked ? '已开启' : '已关闭');
          } catch (e) { H.toast(e.message); inp.checked = !inp.checked; }
        }));
      } catch (e) { compList.innerHTML = '<span class="muted" style="font-size:12.5px;">加载失败：' + H.esc(e.message) + '</span>'; }
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
      await H.api('/api/sync/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, repo, user, token, auto_push: true, auto_pull: true, images: true }) });
      const t = await H.api('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!t.ok) throw new Error(t.message || '仓库无法访问');
      const r = await H.api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const c = r.counts || {};
      msg.textContent = '✅ 同步已开启并上传成功（' + (c.goals || 0) + ' 个目标）';
      msg.style.color = 'var(--ok)';
      H.toast('多端同步已开启');
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
      msg.style.color = 'var(--danger)';
    } finally {
      gdBtn.disabled = false; gdBtn.textContent = '启用同步并上传当前数据';
    }
  });
  mask.addEventListener('click', e => { if (e.target === mask) closeGuide(mask.querySelector('#gdNoShow').checked); });
}

  function mountGuide(host) {
    H = host || {};
    return {
      render: function () { return showGuide(Number(H.__step) || 0); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['guide'] = { id: 'guide', mount: mountGuide };
})();
