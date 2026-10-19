'use strict';
/**
 * 内置 UI 插件 · 设置页（#/settings）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/settings/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

function languageSectionHTML(st) {
  return `<div class="sec" id="set-lang">
      <div class="secTitle">🌐 ${H.esc(tr('语言 Language'))} <span class="secSub">${H.esc(tr('界面上的所有文字都可以切换语言'))}</span></div>
      <div id="langBody">${languageBodyHTML(st)}</div>
    </div>`;
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

  return `<div class="connCard" data-conn="${H.esc(c.id)}" data-kind="api" data-purpose="${isVis ? 'vision' : 'chat'}" data-prov="${H.esc(pid)}">
    <div class="ccHead">
      <button type="button" class="foldBtn" data-act="fold" title="折叠 / 展开">${connFolded(c.id) ? '▸' : '▾'}</button>
      <span class="ccBrand" data-role="brand">${H.esc((p && p.brand) || '···')}</span>
      <span class="ccTitle" data-role="title">${H.esc(dispName)}</span>
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
          <span class="inWrap"><i>🔗</i><input class="mono" data-f="baseUrl" value="${H.esc(c.baseUrl || '')}" placeholder="选服务商会自动填好" spellcheck="false"></span>
        </label>
        <label class="ccWide">API 密钥
          <span class="inWrap"><i>🔑</i><input type="password" data-f="apiKey" value="" placeholder="${c.hasKey ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"><button type="button" class="peekBtn" data-act="peek" title="显示 / 隐藏">👁</button></span>
        </label>
      </div>
      ${p && p.docs ? `<div class="ccDoc">没密钥？<a href="${H.esc(p.docs)}" target="_blank" rel="noopener">去 ${H.esc(p.name)} 控制台申请 →</a></div>` : ''}
    </div>

    <div class="ccBlock">
      <div class="ccLabel"><span class="step">3</span>选择模型
        <span class="q" data-tip="${avail.length ? '绿=刚测过能通，红=不通（悬停看原因）；列表里没有就下面手填' : '点右侧获取：先取该地址支持的模型，再逐个测能否联通；列表里没有就下面手填'}">?</span>
        <div class="spacer"></div>
        <button class="btn tiny cbtn" data-act="test">✓ 测试连通</button>
        <button class="btn tiny cbtn primary" data-act="models">🔄 获取并测试</button>
      </div>
      <div class="mSearchRow">
        <span class="inWrap"><i>🔍</i><input data-role="mSearch" placeholder="${tr('搜索模型（输入关键字过滤）')}" spellcheck="false" autocomplete="off"></span>
        <label class="mAll" title="${tr('全选所有模型')}"><input type="checkbox" data-role="mAll"${avail.length && avail.every(m => sel.indexOf(m) >= 0) ? ' checked' : ''}><span>${tr('全选')}</span></label>
        <span class="hint mCount" data-role="mCount">${tr('共 {0} 个可选', avail.length)}</span>
        <button type="button" class="btn tiny cbtn" data-act="madd" hidden title="${tr('把输入的名字加入候选（官方出新模型时用）')}">${tr('＋ 添加')}</button>
      </div>
      <div data-role="availBox">${modelButtonsHTML(avail, sel, ((window.__aiTested || {})[c.id] || {}))}</div>
      <div class="ccLabel" style="margin-top:10px;"><span data-role="selCount">已选模型（${sel.length}）</span><span class="hint">保存后才会出现在对话栏</span></div>
      <div data-role="chosenBox">${chosenChipsHTML(avail, sel)}</div>
      <div class="ccHint" data-role="msghint"></div>
      <details class="ccAdv"><summary>更多选项（超时）</summary>
        <div class="ccRow" style="margin-top:8px;">
          <label>单次请求超时（毫秒）
            <span class="inWrap"><i>⏱️</i><input data-f="timeoutMs" value="${H.esc(c.timeoutMs || '')}" placeholder="默认 300000"></span>
          </label>
        </div>
      </details>
    </div>
    </div>
  </div>`;
}

/* ---- 设置页：检索增强（RAG） ---- */
function ragSettingsHTML(s) {
  const gopts = (H.state.goals || []).map(g => `<option value="${g.id}">${H.esc(g.title)}</option>`).join('')
    || '<option value="">（还没有目标）</option>';
  return `<p class="hint" style="margin:-4px 0 12px;">资料一多，把整包资料塞给模型既贵又抓不住重点。开启后：<b>规划、拆任务、对话</b>会先从资料库里检索与当前问题最相关的片段再作答。不配向量模型也能用（关键词检索）；配上「向量模型」即升级为语义检索（问“用户登录怎么做”也能找到 auth 相关段落，哪怕正文没出现“登录”二字）。</p>
  <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;">
    <input type="checkbox" id="ragEnabled" ${s.rag_enabled !== false ? 'checked' : ''}> <b>启用检索增强</b>（推荐；关闭则回到「前 N 条资料整段注入」）
  </label>
  <div class="field visPickField">
    <label>向量模型 <span class="muted" style="font-weight:400;">（可选 —— 用于语义检索；不是所有服务商都提供，如 DeepSeek 暂无）</span></label>
    <div class="ccRow" style="margin-bottom:9px;">
      <label class="ccWide">API 地址
        <span class="inWrap"><i>🔗</i><input class="mono" id="embBase" value="${H.esc(s.emb_base_url || '')}" placeholder="本地 Ollama：http://localhost:11434/v1" spellcheck="false"></span>
      </label>
      <label class="ccWide">API 密钥
        <span class="inWrap"><i>🔑</i><input type="password" id="embKey" value="" placeholder="${s.emb_has_key ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"></span>
      </label>
    </div>
    <div class="ccRow">
      <label class="ccWide">向量模型名
        <span class="inWrap"><i>⌨️</i><input id="embModel" value="${H.esc(s.emb_model || '')}" placeholder="如 bge-m3:latest / BAAI/bge-m3 / text-embedding-v3" spellcheck="false"></span>
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

/* ---- 设置页：外观主题（亮 / 暗各选一个皮肤，只改颜色） ---- */
function themeSettingsHTML() {
  const comps = (H.state.componentList || []).filter(c => c.kind === 'theme' || c.scope === 'theme');
  const optsFor = mode => {
    const cur = H.themeFor(mode);
    /* tr() 组合：主题名/亮暗标签是界面文字，皮肤名来自组件元数据，
       中文用源语言显示，其它语言走语言包（没有译文的用户自定义皮肤原样保留）。 */
    const head = `<option value="" ${cur ? '' : 'selected'}>${H.esc(tr('默认（内置{0}）', tr(mode === 'light' ? '亮色' : '暗色')))}</option>`;
    return head + comps.map(c => {
      const tag = c.mode === 'dark' ? tr('深色') : c.mode === 'light' ? tr('浅色') : '';
      const nm = tr(c.name);
      const label = tag ? tr('{0} {1}（{2}）', c.icon || '🎨', nm, tag) : ((c.icon || '🎨') + ' ' + nm);
      return `<option value="${H.esc(c.id)}" ${cur === c.id ? 'selected' : ''}>${H.esc(label)}</option>`;
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

/* ============ 设置页：服务与启动 ============ */
async function serviceSectionHTML() {
  let st = {};
  try { st = await H.api('/api/service/status'); } catch (e) { st = {}; }
  H.state.serviceStatus = st;
  const a = st.autostart || {};
  return `<div class="sec" id="set-service">
      <div class="secTitle">服务与启动</div>
      <div class="svcRow">
        <span class="svcLabel">访问地址</span>
        <a class="svcVal" href="${H.esc(st.url || '#')}" target="_blank" rel="noopener">${H.esc(st.url || '')}</a>
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
        <span class="svcVal" id="svcAutoText">${a.enabled ? '已开启 · ' + H.esc(a.mechanism || '') : '未开启'}</span>
      </div>
      <p class="hint" style="margin-top:8px; line-height:1.8;">
        · 桌面图标：双击启动并在浏览器打开（Windows 为桌面快捷方式，Linux/macOS 为桌面启动器）<br>
        · 终端命令：安装后在终端输入 <code>sierxing</code> 即可启动（Linux/macOS 在 <code>~/.local/bin</code>）<br>
        · ${H.esc(tr('开机自启：{0}', tr(a.mechanism || '按平台自动选择机制')))}${a.hint ? ' · ' + H.esc(tr(a.hint)) : ''}<br>
        · 所有操作只写入当前用户目录，不需要管理员权限；端口 ${st.port || ''}
      </p>
    </div>`;
}

/* ---- 设置页：版本与更新 ---- */
async function updateSectionHTML() {
  let u = H.state.update;
  if (!u) { try { u = await H.api('/api/update/status'); H.state.update = u; } catch (e) { u = {}; } }
  const isPay = u.mode === 'payload';
  const cur = isPay
    ? (u.localVersion ? '<code>v' + H.esc(u.localVersion) + '</code>' : '（未检测）')
    : (u.currentShort ? `<code>${H.esc(u.currentShort)}</code> ${H.esc(fmtUpdTime(u.currentDate))}` : '（未检测）');
  const supported = u.supported !== false;
  const has = updHasUpdate();
  const status = !supported
    ? '<span style="color:var(--warn)">当前安装方式不支持自动更新（可重新用 git clone 安装，数据不会丢）</span>'
    : (u.reason === 'fetch-failed'
      ? '<span style="color:var(--warn)">检查失败：' + H.esc(u.error || '网络或权限问题') + '</span>'
      : (has
        ? (isPay
          ? '<b style="color:var(--accent)">有新版本 v' + H.esc(u.latestShort || '') + '</b> · 只下载程序文件 ' + (updSizeText() || '') + '，不会重下整个 exe · ' + H.esc(u.latestSubject || '')
            + (u.exeRequired ? '<br><span style="color:var(--warn)">本次含启动器修复：功能照常更新，但之后请去发布页下载完整 exe 替换一次，否则自动重启仍需手动重开。</span>' + (u.releasesUrl ? ` <a href="${H.esc(u.releasesUrl)}" target="_blank" rel="noopener">去发布页 →</a>` : '') : '')
          : '<b style="color:var(--accent)">有 ' + u.behind + ' 个新提交</b> · 最新：' + H.esc(u.latestSubject || ''))
        : (isPay ? tr('已是最新版本') : tr('已是最新版本') + (u.dirty ? ' · ' + tr('本地有 {0} 个改动文件（更新时会自动暂存）', u.dirty) : ''))));
  return `<div class="sec" id="set-update">
      <div class="secTitle">版本与更新</div>
      <div class="svcRow">
        <span class="svcLabel">当前版本</span>
        <span class="svcVal">${cur}</span>
        <div class="spacer"></div>
        <button class="btn tiny" id="updCheck">检查更新</button>
        ${has ? '<button class="btn tiny primary" id="updApply">立即更新</button>' : ''}
      </div>
      <p class="hint" id="updStatus" style="margin-top:8px; line-height:1.8;">${status}${u.checkedAt ? ' · 上次检查：' + H.esc(fmtUpdTime(new Date(u.checkedAt).toISOString())) : ''}</p>
      ${(u.commits && u.commits.length) ? `<div class="updList" style="margin-top:6px;">${u.commits.map(c => `<div class="updItem"><code>${H.esc(c.hash)}</code><span>${H.esc(c.subject)}</span><i>${H.esc(fmtUpdTime(c.date))}</i></div>`).join('')}</div>` : ''}
      <p class="hint" style="margin-top:8px;">· 启动时会自动检查一次；也可以随时点「检查更新」<br>· 更新只替换程序文件，本地数据（目标 / 组件设置 / 密钥）不受影响；更新后会自动重启应用${isPay ? '<br>· 你是单文件 exe 版本：更新只下载程序文件（几百 KB），<b>不用重下 89MB 的 exe</b>' : ''}</p>
    </div>`;
}

async function syncSectionHTML() {
  let st = {};
  try { st = await H.api('/api/sync/status'); } catch (e) { st = {}; }
  H.state.syncStatus = st;
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
        <input id="syncRepo" value="${H.esc(st.repo || '')}" placeholder="https://atomgit.com/your-username/sierxing-data.git">
      </div>
      <div class="grid2">
        <div class="field"><label>分支</label><input id="syncBranch" value="${H.esc(st.branch || 'main')}" placeholder="main"></div>
        <div class="field"><label>用户名（可选）</label><input id="syncUser" value="${H.esc(st.user || '')}" placeholder="oauth2 或你的账号"></div>
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
        ${snap ? `仓库里最新快照：${H.esc(H.fmtDate(snap.savedAt))} · 来自 ${H.esc(snap.device || '')} · ${snap.counts && snap.counts.goals || 0} 个目标<br>` : ''}
        ${st.lastAt ? `上次同步：${H.esc(H.fmtDate(st.lastAt))} · ${H.esc(st.lastStatus || '')}` : '还没有同步记录'}
        ${st.cloned ? `<br>本地副本：${H.esc(st.commit || '')} · ${H.esc(st.workState || '')}` : ''}
        ${st.outlibWarn ? `<br><span style="color:var(--danger,#ef4444); font-weight:600;">⚠ 产出库：${H.esc(st.outlibWarn)}</span>`
          + (st.outlibDangling && st.outlibDangling.length ? `<br><span style="opacity:.85;">缺文件的有：${st.outlibDangling.map(x => H.esc(x.name)).join('、')}${st.outlibDangling.length >= 8 ? ' 等' : ''}</span>` : '')
          + `<br><span style="opacity:.85;">这些条目只有名字、没有文件本体，到哪台设备上都点不开。要恢复只能重新上传一次。</span>` : ''}
      </div>
    </div>`;
}

function sxi(name, size) {
  const d = H.SXI_PATHS[name] || H.SXI_PATHS.doc;
  const cls = size === 14 ? 'sxi s14' : size === 18 ? 'sxi s18' : size === 22 ? 'sxi s22' : 'sxi';
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
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

/** 一排模型按钮。on = 已选；ok/bad = 批量测试过的结果（悬停看详情）；testing = 正在测。 */
function modelButtonsHTML(models, sel, tested) {
  const s = sel || [], t = tested || {};
  if (!models.length) return '<div class="hint" style="padding:8px 2px;">还没有可选模型 —— 先填好密钥，再点「获取并测试」。</div>';
  return `<div class="mBtnGrid">${models.map(m => {
    const st = t[m];
    const msg = t[m + '_msg'];
    return `<button type="button" class="mBtn${s.indexOf(m) >= 0 ? ' on' : ''}${st === true ? ' ok' : ''}${st === false ? ' bad' : ''}" data-mbtn="${H.esc(m)}"${msg ? ` title="${H.esc(msg)}"` : ''}>${H.esc(m)}</button>`;
  }).join('')}</div>`;
}

/** 某张卡的批量测试结果：aiCtx.tested[connId] = {模型名: true/false, 模型名_msg: '原因'} */
function testedOf(card) {
  const cid = card.getAttribute('data-conn');
  return (window.__aiTested && window.__aiTested[cid]) || {};
}

/** 已选模型区：从池子里把选中的挑出来排成小片，可单独移除 */
function chosenChipsHTML(models, sel) {
  const s = sel || [];
  if (!s.length) return '<div class="hint" style="padding:4px 2px;">还没选模型 —— 点上面的模型按钮加入。</div>';
  /* 每个小片自带「测」：点一下只测这一个模型，结果直接标在小片上（✅/❌ + 原因）。
     注意：data-chip 留在外层 span，data-mtest 在按钮上，点「测」不能触发移除。 */
  return `<div class="mChips">${s.map(m => `<span class="mChip" data-chip="${H.esc(m)}">${H.esc(m)}<button type="button" class="mT" data-mtest="${H.esc(m)}" title="只测试这个模型能否联通">测</button><i title="移除">×</i></span>`).join('')}</div>`;
}

/** 地址栏只留主机名当副标题：https://api.deepseek.com/v1 → api.deepseek.com */
function shortHost(base) {
  const s = String(base || '').trim();
  if (!s) return '';
  try { return new URL(s).hostname; } catch (e) { return s.replace(/^https?:\/\//, '').split('/')[0]; }
}

function bindServiceSection() {
  const st = H.state.serviceStatus || {};
  const open = document.getElementById('svcOpen');
  if (open) open.addEventListener('click', async () => {
    try { await H.api('/api/service/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { H.toast(e.message); }
  });
  const sc = document.getElementById('svcShortcuts');
  if (sc) sc.addEventListener('click', async () => {
    sc.disabled = true; sc.textContent = '创建中…';
    try {
      const r = await H.api('/api/service/shortcuts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const notes = (r.notes || []).join('；');
      H.toast((r.desktop ? '桌面图标已创建' : '未创建桌面图标') + (r.launcher ? '，终端命令 sierxing 可用' : '') + (notes ? ' · ' + notes : ''));
      renderSettings();
    } catch (e) { H.toast(e.message); sc.disabled = false; sc.textContent = '创建桌面图标'; }
  });
  const as = document.getElementById('svcAutostart');
  if (as) as.addEventListener('change', async () => {
    const on = as.checked;
    as.disabled = true;
    try {
      const r = await H.api('/api/service/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
      H.toast(on ? ('已开启开机自启' + (r.hint ? '（' + r.hint + '）' : '')) : '已关闭开机自启');
      renderSettings();
    } catch (e) { H.toast(e.message); as.checked = !on; as.disabled = false; }
  });
}

function bindUpdateSection() {
  const ck = document.getElementById('updCheck');
  if (ck) ck.addEventListener('click', async () => {
    ck.disabled = true; ck.textContent = '检查中…';
    try {
      const u = await H.api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      H.state.update = u;
      H.toast(u.supported === false ? '当前安装方式不支持自动更新'
        : (u.reason === 'fetch-failed' ? '检查失败：' + (u.error || '网络或权限问题')
          : (u.behind > 0
            ? (u.mode === 'payload' ? '发现新版本 v' + u.latestShort : '发现 ' + u.behind + ' 个新提交')
            : '已是最新版本')));
      H.renderRail();
      H.rerenderCurrent();
    } catch (e) { H.toast(e.message); }
    ck.disabled = false; ck.textContent = '检查更新';
  });
  const ap = document.getElementById('updApply');
  if (ap) ap.addEventListener('click', applyUpdate);
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
    const r = await H.api('/api/sync/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
    H.state.syncStatus = r.status;
    return r.status;
  };
  const sv = document.getElementById('syncSave');
  if (sv) sv.addEventListener('click', async () => {
    sv.disabled = true; sv.textContent = '保存中…';
    try {
      await save();
      const t = await H.api('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (box) box.innerHTML = t.ok
        ? '✅ <b>已保存，仓库可访问</b>' + (t.branches && t.branches.length ? '（分支：' + H.esc(t.branches.join('、')) + '）' : '（仓库还是空的，点「立即上传」创建首个快照）') + '<br>自动上传 / 拉取按上面的开关生效'
        : '❌ <b>已保存，但仓库连不上</b>：' + H.esc(t.message || '');
      H.toast(t.ok ? '同步已保存，仓库可访问' : '已保存，但仓库连不上');
      /* 原地刷新回显，不整页重绘 —— 以前调 renderSettings()，页面闪一下不说，
         刚显示的测试结果当场被清空，滚动位置也丢了。 */
      try {
        const fresh = await H.api('/api/sync/status');
        H.state.syncStatus = fresh;
        const tk = document.getElementById('syncToken');
        if (tk) { tk.value = ''; tk.placeholder = fresh.hasToken ? '已保存（留空则不修改）' : '粘贴访问令牌'; }
        const ur = document.getElementById('syncUser');
        if (ur && fresh.user) ur.value = fresh.user;
      } catch (e) {}
    } catch (e) { H.toast(e.message); if (box) box.innerHTML = '❌ ' + H.esc(e.message); }
    finally { sv.disabled = false; sv.textContent = '保存并测试连接'; }
  });
  const cf = document.getElementById('cfOpen');
  if (cf) cf.addEventListener('click', () => {
    const c = (H.state.syncStatus || {}).conflict;
    if (c) openSyncConflictDialog(c);
    else H.toast('冲突信息已过期，点「立即拉取」重新检查');
  });
  const sp = document.getElementById('syncPush');
  if (sp) sp.addEventListener('click', async () => {
    sp.disabled = true; sp.textContent = '上传中…';
    if (box) box.innerHTML = '正在导出并推送到仓库…';
    try {
      await save();
      const r = await H.api('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.conflict) {
        if (box) box.innerHTML = '⚠️ 云端也有新改动，已暂停上传，请二选一。';
        openSyncConflictDialog(r.conflict);
      } else {
        const c = r.counts || {};
        if (box) box.innerHTML = '✅ 上传成功 · ' + (c.goals || 0) + ' 个目标 / ' + (c.nodes || 0) + ' 个节点';
        H.toast('已上传到同步仓库');
      }
    } catch (e) { H.toast('上传失败：' + e.message); if (box) box.innerHTML = '❌ 上传失败：' + H.esc(e.message); }
    finally { sp.disabled = false; sp.textContent = '⬆ 立即上传'; }
  });
  const pl = document.getElementById('syncPull');
  if (pl) pl.addEventListener('click', async () => {
    pl.disabled = true; pl.textContent = '拉取中…';
    if (box) box.innerHTML = '正在从仓库拉取…';
    try {
      await save();
      const r = await H.api('/api/sync/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.conflict) {
        if (box) box.innerHTML = '⚠️ 本地和云端都有新改动，已暂停同步，请二选一（不会覆盖任何一边）。';
        openSyncConflictDialog(r.conflict);
      } else if (r.imported) {
        if (box) box.innerHTML = '✅ 已导入来自 ' + H.esc(r.device || '其它设备') + ' 的数据（' + ((r.counts || {}).goals || 0) + ' 个目标），页面即将刷新…';
        H.toast('已导入最新数据');
        setTimeout(() => location.reload(), 1200);
      } else {
        if (box) box.innerHTML = 'ℹ ' + H.esc(r.message || '已是最新');
        H.toast(r.message || '已是最新');
      }
    } catch (e) { H.toast('拉取失败：' + e.message); if (box) box.innerHTML = '❌ 拉取失败：' + H.esc(e.message); }
    finally { pl.disabled = false; pl.textContent = '⬇ 立即拉取'; }
  });
}

function bindLanguageSection(st) {
  const sec = document.getElementById('set-lang');
  if (!sec) return;
  bindLanguageBody();
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
        <div class="storePath" title="${H.esc(st.dir)}">📂 ${H.esc(st.dir)}</div>
        <div class="storeMeta">
          <span class="chip ${st.custom ? 'ok' : 'gray'}">${st.custom ? '已改过位置' : '默认位置（程序目录下）'}</span>
          <span class="chip ${st.writable ? 'gray' : 'danger'}">${st.writable ? '可写' : '不可写！'}</span>
          <span class="chip gray">${fmtBytes(st.bytes)} · ${st.files} 个文件</span>
          ${st.at ? `<span class="muted" style="font-size:12px;">${H.esc(String(st.at).slice(0, 10))} 改的</span>` : ''}
        </div>
      </div>
      ${st.lost ? `<p class="hint" style="color:var(--danger);">⚠️ 之前指定的目录找不到了（${H.esc(st.lost)}），已临时回落到默认目录 —— 可能是移动硬盘没插。</p>` : ''}
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
  try { _storeState = await H.api('/api/data-location'); } catch (e) { _storeState = { error: e.message }; }
  paint();
}

function themeMsgText() {
  const nameOf = id => {
    if (!id) return '默认配色';
    const c = (H.state.componentList || []).find(x => x.id === id);
    return c ? c.name : id;
  };
  return '当前 → 亮色：<b>' + H.esc(nameOf(H.themeFor('light'))) + '</b>　·　暗色：<b>' + H.esc(nameOf(H.themeFor('dark'))) + '</b>';
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function languageBodyHTML(st) {
  const { locales, source, saved, catalog } = langLocaleList(st);
  const active = (st && st.active) || (saved || source);
  const cards = locales.map(L => {
    const isOn = L.code === active;
    const badges = [];
    if (L.code === source) badges.push(tr('源语言'));
    else if (L.generated) badges.push(tr('AI 生成'));
    else badges.push(tr('内置'));
    if (L.code !== source && L.entries) badges.push(`${L.translated}/${L.entries}`);
    return `<div class="langCard ${isOn ? 'on' : ''}" data-lang="${H.esc(L.code)}" role="button" tabindex="0">
      <span class="langCodeBadge" data-i18n-skip>${H.esc(langCodeBadge(L.code))}</span>
      <span class="langCardBody">
        <b data-i18n-skip>${H.esc(L.nativeName || L.name)}</b>
        <span>${H.esc(L.englishName || L.name)} · ${H.esc(badges.join(' · '))}</span>
      </span>
      ${isOn ? `<span class="langCardTick">✓</span>` : ''}
      ${L.generated ? `<button type="button" class="langCardDel" data-lang-del="${H.esc(L.code)}" title="${H.esc(tr('删除这个 AI 生成的语言包'))}">✕</button>` : ''}
    </div>`;
  }).join('');
  /* 清单里"还没安装"的语言：点一下就直接生成 */
  const installed = {};
  for (const L of locales) installed[String(L.code).toLowerCase()] = 1;
  const todo = catalog.filter(c => !installed[String(c.code).toLowerCase()]);
  const chips = todo.map(c => `<button type="button" class="langChip" data-lang-gen="${H.esc(c.code)}" data-lang-name="${H.esc(c.nativeName)}">
      <span class="langChipBadge" data-i18n-skip>${H.esc(langCodeBadge(c.code))}</span>
      <b data-i18n-skip>${H.esc(c.nativeName)}</b>
      <span>${H.esc(c.englishName)}</span>
    </button>`).join('');
  return `<div class="langTop">
      <div class="langNow">
        <span class="langCodeBadge big" data-i18n-skip>${H.esc(langCodeBadge(active))}</span>
        <span class="langNowText">
          <span class="langNowSub">${H.esc(tr('当前界面语言'))}</span>
          <b data-i18n-skip>${H.esc(langCurrentLabel(st))}</b>
        </span>
      </div>
      <label class="langFollow" title="${H.esc(tr('按浏览器语言自动选择（中文浏览器用中文，其他用英文）'))}">
        <input type="checkbox" id="langFollowChk" ${saved ? '' : 'checked'}>
        <span>${H.esc(tr('跟随浏览器'))}</span>
      </label>
      <button class="btn tiny" id="langReloadBtn" type="button" title="${H.esc(tr('刷新语言列表'))}">↻</button>
    </div>
    <div class="langGrid" id="langList">${cards}</div>
    <div class="langAddSec">
      <div class="langAddHead">🪄 ${H.esc(tr('让 AI 生成一种新语言'))}</div>
      <p class="hint" style="margin:2px 0 10px;">${H.esc(tr('从下面挑一种语言，AI 会把全部界面文案翻译成它并保存下来，之后可以随时切回；生成会调用你配置的 AI 模型。'))}</p>
      <div class="langChips" id="langChips">${chips || `<span class="hint">${H.esc(tr('清单里的语言都已生成。'))}</span>`}</div>
      <details class="langCustomFold" style="margin:4px 0 0;">
        <summary class="hint" style="cursor:pointer;">${H.esc(tr('清单里没有？手动输入语言名称'))}</summary>
        <div class="langCustom" style="margin-top:8px;">
          <input id="langNewName" placeholder="${H.esc(tr('例如：日本語 / Français / Türkçe / 한국어 / العربية'))}">
          <button class="btn primary" id="langGenBtn" type="button">${H.esc(tr('AI 生成界面语言'))}</button>
        </div>
      </details>
      <div class="hint" id="langGenMsg" style="margin-top:8px;">${H.esc(tr('生成可能需要几分钟，进度可在左下角任务中心查看；生成完自动切过去。'))}</div>
    </div>
    <div class="langProgress" id="langProgress" hidden>
      <div class="langProgBar"><i id="langProgFill"></i></div>
      <div class="hint" id="langProgMsg"></div>
    </div>
    <details style="margin-top:16px;"><summary class="hint" style="cursor:pointer;">${H.esc(tr('语言包在哪里？怎么手动改文案？'))}</summary>
      <p class="hint" style="margin:8px 0 0;">${H.esc(tr('内置语言在 language/locales/ 下（中文是源语言，英文在 en-US）；AI 生成的语言在数据目录 language/ 下。改了 language/ 里的文字，刷新即生效，不用改代码。新增界面文字请用 tr() 包起来（见 language/README.md）。'))}</p>
    </details>`;
}

/** Agent 连接卡：没有地址密钥这两项，流程是 选Agent → 检测本机 → 列模型 → 选 → 测。 */
function agentCardHTML(c, ctx) {
  const aid = c.providerId || 'opencode';
  const a = H.AI_AGENTS.find(x => x.id === aid) || H.AI_AGENTS[0] || { id: aid, name: aid, brand: 'AG' };
  const sel = c.models || [];
  const avail = (ctx && ctx.avail && ctx.avail[c.id]) || [];
  const agentState = (ctx && ctx.agentState) || {};
  const probe = agentState[aid];
  const dispName = c.name || a.name;

  return `<div class="connCard" data-conn="${H.esc(c.id)}" data-kind="agent" data-purpose="chat" data-prov="${H.esc(aid)}">
    <div class="ccHead">
      <button type="button" class="foldBtn" data-act="fold" title="折叠 / 展开">${connFolded(c.id) ? '▸' : '▾'}</button>
      <span class="ccBrand" data-role="brand">${H.esc(a.brand || 'AG')}</span>
      <span class="ccTitle" data-role="title">${H.esc(dispName)}</span>
      <span class="ccKind">Agent</span>
      <div class="spacer"></div>
      <span class="dirtyDot" data-role="dirty" hidden>●未保存</span>
      <label class="sw" title="启用 / 停用这条连接"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? 'checked' : ''}><i></i></label>
      <button class="btn tiny cbtn primary" data-act="saveone">保存</button>
      <button class="btn tiny danger" data-act="del">删除</button>
    </div>
    <div class="ccBody" data-role="body"${connFolded(c.id) ? ' hidden' : ''}>
    <div class="ccBlock">
      <div class="ccLabel"><span class="step">1</span>选择 Agent <span class="q" data-tip="${H.esc(a.hint || '以后支持 codex 等其它 Agent 时，这里会自动多出来')}">?</span></div>
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
          ? `<span class="ok">✓ 已检测到 ${H.esc(a.name)}${H.esc(probe.version ? ' ' + probe.version : '')}</span>`
          : `<span class="bad">✗ ${H.esc(probe.hint || '未检测到')}</span>`)
        : '<span class="muted">点上面的按钮检测本机并列出可用模型</span>'}</div>
      <div class="mSearchRow">
        <span class="inWrap"><i>🔍</i><input data-role="mSearch" placeholder="${tr('搜索模型（输入关键字过滤）')}" spellcheck="false" autocomplete="off"></span>
        <label class="mAll" title="${tr('全选所有模型')}"><input type="checkbox" data-role="mAll"${avail.length && avail.every(m => sel.indexOf(m) >= 0) ? ' checked' : ''}><span>${tr('全选')}</span></label>
        <span class="hint mCount" data-role="mCount">${tr('共 {0} 个可选', avail.length)}</span>
        <button type="button" class="btn tiny cbtn" data-act="madd" hidden title="${tr('把输入的名字加入候选（官方出新模型时用）')}">${tr('＋ 添加')}</button>
      </div>
      <div data-role="availBox">${modelButtonsHTML(avail, sel, ((window.__aiTested || {})[c.id] || {}))}</div>
      <div class="ccLabel" style="margin-top:10px;"><span data-role="selCount">已选模型（${sel.length}）</span><span class="hint">保存后才会出现在对话栏</span></div>
      <div data-role="chosenBox">${chosenChipsHTML(avail, sel)}</div>
      <div class="ccHint" data-role="msghint"></div>
      <details class="ccAdv"><summary>更多选项（代理 / 超时）</summary>
        <div class="ccRow" style="margin-top:8px;">
          <label>Agent 代理
            <span class="inWrap"><i>🤖</i><input data-f="agent" value="${H.esc(c.agent || 'NoTools')}" placeholder="NoTools（禁用工具、只输出文本）"></span>
          </label>
          <label>单次请求超时（毫秒）
            <span class="inWrap"><i>⏱️</i><input data-f="timeoutMs" value="${H.esc(c.timeoutMs || '')}" placeholder="默认 300000"></span>
          </label>
        </div>
      </details>
    </div>
    </div>
  </div>`;
}

function foldBtn(key, closed) { return `<button class="btn tiny cardFold" data-fold="${key}" title="折叠/展开">${closed ? '▸' : '▾'}</button>`; }

/** 连接卡折叠状态（localStorage，只记折起来的 id；新卡默认展开） */
function connFolded(id) {
  try { return !!(JSON.parse(localStorage.getItem('sierxing-conn-fold') || '{}')[id]); } catch (e) { return false; }
}

/** 一排服务商按钮。点了就把 Base URL 等自动填好。
 *  opencode 不在这里（它走 Agent 连接，有自己单独的流程）。 */
function providerButtonsHTML(sel) {
  const list = H.AI_PROVIDERS.filter(p => !p.isOpencode);
  return `<div class="provGrid">${list.map(p => `
    <button type="button" class="provBtn${p.id === sel ? ' on' : ''}" data-prov="${H.esc(p.id)}" title="${H.esc(p.baseUrl || '自己填地址')}">
      <span class="pbBrand">${H.esc(p.brand)}</span>
      <span class="pbName">${H.esc(p.name)}</span>
    </button>`).join('')}</div>`;
}

function fmtUpdTime(t) { return t ? String(t).replace(' +0800', '').slice(0, 16) : ''; }

function updHasUpdate() {
  const u = H.state.update || {};
  return !!(u.supported && u.behind > 0 && u.latestShort && u.latestShort !== updSkipHash());
}

function updSizeText() {
  const m = (H.state.update || {}).manifest;
  if (!m || !m.size) return '';
  const kb = Math.round(m.size / 1024);
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}

/* ============ 设置页：多端同步 ============ */
function syncSwitch(id, on, title) {
  return `<label class="cmpSwitch" title="${H.esc(title || '')}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="cmpSlider"></span></label>`;
}

async function applyUpdate() {
  const u = H.state.update || {};
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
    const r = await H.api('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.updated) { updMaskShow('已经是最新版本'); setTimeout(() => { const m = document.getElementById('updMask'); if (m) m.remove(); }, 1200); return; }
    updMaskSub('已更新 ' + r.before + ' → ' + r.after
      + (r.mode === 'payload' ? '（' + (r.files || 0) + ' 个文件）' : '（' + r.commits + ' 个提交）')
      + (r.warning ? ' · ' + r.warning : ''));
    updMaskShow('更新完成，正在重启应用…');
    updMaskSub('重启后会自动刷新页面，请稍候');
    try { await H.api('/api/update/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
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
          <div class="cfMeta">最后改动：${H.esc(H.fmtDate(l.changeAt) || '—')}</div>
          <div class="cfMeta">目标 ${fmtN(lc.goals)} · 路线节点 ${fmtN(lc.nodes)} · 资料 ${fmtN(lc.sources)} · 教程 ${fmtN(lc.tutorials)}</div>
        </div>
        <div class="cfSide remote">
          <div class="cfSideT">☁️ 云端</div>
          <div class="cfMeta">来自 ${H.esc(r.device || '其它设备')} · ${H.esc(H.fmtDate(r.savedAt) || '—')}</div>
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
      const res = await H.api('/api/sync/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
      if (res.conflict) { msg.textContent = '对方又有新改动，冲突已更新，请重新看一眼再选。'; openSyncConflictDialog(res.conflict); return; }
      if (choice === 'remote' && res.imported) {
        msg.textContent = '✅ 已用云端覆盖本地，页面即将刷新…';
        H.toast('已用云端数据覆盖本地');
        setTimeout(() => location.reload(), 1200);
      } else {
        msg.textContent = '✅ 已保留本地并上传到云端';
        H.toast('已保留本地并上传');
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

function bindLanguageBody() {
  const box = document.getElementById('langBody');
  if (!box || box.dataset.langBound === '1') return;   /* 容器不销毁、只换 innerHTML：监听只绑一次 */
  box.dataset.langBound = '1';
  box.addEventListener('keydown', (e) => {
    const card = e.target.closest && e.target.closest('[data-lang]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
  });
  box.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-lang]');
    if (pick && !e.target.closest('[data-lang-del]')) {
      const code = pick.getAttribute('data-lang') || '';
      const st = await H.api('/api/language/state').catch(() => ({}));
      if (String(st.saved || '') === code) return;
      langSay(H.esc(tr('正在切换语言…')));
      try { await window.SXI18N.setLanguage(code); }
      catch (err) { langSay('❌ ' + H.esc(err.message || tr('切换失败'))); }
      return;
    }
    const del = e.target.closest('[data-lang-del]');
    if (del) {
      e.stopPropagation();
      const code = del.getAttribute('data-lang-del');
      if (!confirm(tr('删除这个 AI 生成的语言包？删除后界面上会回退到其它语言。'))) return;
      try {
        const r = await H.api('/api/language/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        if (!r.ok) throw new Error(r.error || tr('删除失败'));
        H.toast(tr('已删除语言包'));
        if (r.resetActive) { window.SXI18N.setLanguage(''); return; }
        langRefreshBody();
      } catch (err) { H.toast(err.message || tr('删除失败')); }
      return;
    }
    const chip = e.target.closest('[data-lang-gen]');
    if (chip) {
      const code = chip.getAttribute('data-lang-gen');
      const name = chip.getAttribute('data-lang-name') || code;
      chip.disabled = true;
      langSay(H.esc(tr('正在提交生成任务…')));
      try { await langStartGenerate({ name }); }
      catch (err) { chip.disabled = false; langSay('❌ ' + H.esc(err.message || tr('提交失败'))); }
      return;
    }
    if (e.target.closest('#langReloadBtn')) { langRefreshBody(); return; }
    if (e.target.closest('#langGenBtn')) {
      const input = document.getElementById('langNewName');
      const name = String((input && input.value) || '').trim();
      if (!name) { H.toast(tr('先输入语言名称，例如：日本語')); if (input) input.focus(); return; }
      const btn = document.getElementById('langGenBtn');
      if (btn) btn.disabled = true;
      langSay(H.esc(tr('正在提交生成任务…')));
      try {
        await langStartGenerate({ name });
      } catch (err) {
        langDisableGen(false);
        langSay('❌ ' + H.esc(err.message || tr('提交失败')));
      }
      return;
    }
  });
  box.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'langFollowChk') {
      if (!e.target.checked) return;   /* 取消勾选不代表选了哪个语言：让用户点下面的语言卡片 */
      try {
        langSay(H.esc(tr('正在切换语言…')));
        await window.SXI18N.setLanguage('');
      } catch (err) { langSay('❌ ' + H.esc(err.message || tr('切换失败'))); }
    }
  });
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
        <div class="stFrom"><span class="stMk">从</span><div class="stP" title="${H.esc(st0.dir || '')}">${H.esc(st0.dir || '…')}</div><div class="stM">${fmtBytes(st0.bytes)} · ${st0.files} 个文件</div></div>
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
  const busy = on => { H.go.disabled = on; H.go.textContent = on ? '进行中…' : (modeUse ? '指过去' : '开始迁移'); };
  /* 路径一改就体检：能不能写、空间够不够、是不是要搬进自己的子目录 */
  let chkTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(chkTimer);
    const dir = input.value.trim();
    if (!dir) { chk.innerHTML = '<span class="stCheckIdle">填个路径，这里会先帮你看看能不能放</span>'; return; }
    chkTimer = setTimeout(async () => {
      try {
        const r = await H.api('/api/data-location/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
        chk.innerHTML = r.ok
          ? '<span class="stCheckOk">✓ 可以放这里</span><span class="stCheckTip">要腾出约 ' + fmtBytes(r.need) + ' 的空间' + (r.free != null ? '，那边还有 ' + fmtBytes(r.free) : '') + '</span>'
          : '<span class="stCheckBad">✗ ' + H.esc(r.error) + '</span>';
      } catch (e) { chk.innerHTML = '<span class="stCheckBad">✗ ' + H.esc(e.message) + '</span>'; }
    }, 400);
  });
  const pick = document.getElementById('stPick');
  if (pick) pick.addEventListener('click', async () => {
    pick.disabled = true;
    const pm = document.getElementById('stPickMsg');
    pm.textContent = '在弹出的窗口里选文件夹（可以顺手新建一个）…';
    try { await H.api('/api/data-location/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch (e) { pm.textContent = '打不开：' + e.message; pick.disabled = false; return; }
    pollTimer = setInterval(async () => {
      try {
        const r = await H.api('/api/data-location/pick');
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
  H.go.addEventListener('click', async () => {
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
        const p = await H.api('/api/data-location/progress');
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
      r = await H.api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) {
      clearInterval(progTimer);
      busy(false);
      /* 失败就把横幅留在原地，让人看得见为什么停 —— 早先只弹个 toast，几秒后就没人记得了 */
      prog.innerHTML = '<div class="stProgBad"><b>✗ 没搬成功</b><br>' + H.esc(e.message)
        + (e.message.indexOf('一半') >= 0 ? '' : '') + '</div>';
      chk.innerHTML = '';
      msg.innerHTML = '<span style="color:var(--muted)">原数据没动，程序还在用原来的位置。可以修好路径再试，或点「取消」。</span>';
      return;
    }
    clearInterval(progTimer);
    busy(false);
    prog.innerHTML = '<div class="stProgOk"><b>✓ ' + H.esc(modeUse ? '已指向新目录' : (m === 'move' ? '数据已搬过去' : '已复制一份到新目录')) + '</b><br>'
      + '原位置：' + H.esc(st0.dir || '') + '<br>新位置：' + H.esc(r.dir || dir)
      + ((r.skipped && r.skipped.length) ? '<br><br>有 ' + r.skipped.length + ' 个文件读不了（多半是克隆来的项目里 root 权限的日志），已跳过：<br><span class="mono" style="font-size:11px;">'
        + r.skipped.slice(0, 5).map(s => H.esc(s.file)).join('<br>') + (r.skipped.length > 5 ? '<br>…等共 ' + r.skipped.length + ' 个' : '') + '</span><br>数据库和你的数据不受影响。' : '')
      + '</div>';
    try { _storeState = await H.api('/api/data-location'); } catch (e) {}
    storeSectionLoad();
    msg.innerHTML = '<b>需要重启一次才会真正生效。</b>';
    const rd = document.getElementById('stRestart');
    if (rd) rd.remove();
    const rb = document.createElement('button');
    rb.id = 'stRestart'; rb.className = 'btn primary'; rb.textContent = '现在重启';
    rb.addEventListener('click', async () => {
      rb.disabled = true; rb.textContent = '正在重启…';
      try { await H.api('/api/data-location/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      catch (e) { rb.disabled = false; rb.textContent = '重启失败，手动重开'; H.toast(e.message); }
    });
    H.go.replaceWith(rb);
  });
}

/** 真正执行迁移 / 切指针，成功后问要不要立刻重启 */
async function doStoreApply(payload, doneMsg) {
  let r;
  try { r = await H.api('/api/data-location/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  catch (e) { H.toast(e.message); return null; }
  if (r.keptAt) H.toast('没搬成功：' + r.error + '（原数据没动，' + r.keptAt + ' 里是搬了一半的，可以自己看看）');
  else H.toast(doneMsg + ' ✓');
  try { _storeState = await H.api('/api/data-location'); } catch (e) {}
  storeSectionLoad();
  if (r.restartRequired) {
    const go = confirm(doneMsg + '\n\n需要重启一次才会真正生效 —— 现在重启吗？');
    if (go) {
      try {
        await H.api('/api/data-location/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        H.toast('正在重启…');
      } catch (e) { H.toast('自动重启失败，手动重开一次就好：' + e.message); }
    }
  }
  return r;
}

function langLocaleList(st) {
  st = st || {};
  const list = (st.locales && st.locales.length) ? st.locales.slice() : LANG_FALLBACK_LOCALES.slice();
  return { locales: list, source: st.source || 'zh-CN', saved: st.saved || '', catalog: st.catalog || [] };
}

function langCodeBadge(code) {
  const parts = String(code || '').split('-');
  const region = (parts[1] || parts[0] || '').toUpperCase();
  if (region && region.length <= 3) return region;
  return String(code || '?').toUpperCase().slice(0, 2);
}

function langCurrentLabel(st) {
  const { locales } = langLocaleList(st);
  const cur = locales.find(L => L.code === (st && st.active)) || locales[0] || {};
  return cur.nativeName || cur.name || '';
}

/** Agent 选择按钮（以后加 codex 之类只改服务端 AGENTS，前端自动多出来） */
function agentButtonsHTML(sel) {
  const list = AI_AGENTS;
  return `<div class="provGrid">${list.map(a => `
    <button type="button" class="provBtn${a.id === sel ? ' on' : ''}" data-agent="${H.esc(a.id)}" title="${H.esc(a.hint || '')}">
      <span class="pbBrand">${H.esc(a.brand)}</span>
      <span class="pbName">${H.esc(a.name)}</span>
    </button>`).join('')}</div>`;
}

/* ============ 设置页（含 AI 配置引导） ============ */
/* ============ 更新检查（启动自动检测 + 一键更新） ============ */
function updSkipHash() { try { return localStorage.getItem('sierxing-update-skip') || ''; } catch (e) { return ''; } }

function updMaskShow(text) {
  let m = document.getElementById('updMask');
  if (!m) {
    m = document.createElement('div');
    m.id = 'updMask';
    m.className = 'updMask';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="updBox"><div class="updSpin"></div><div class="updMsg">${H.esc(text)}</div><div class="updSub" id="updSub"></div></div>`;
  return m;
}

function updMaskSub(text) { const s = document.getElementById('updSub'); if (s) s.textContent = text; }

function updIsPayload() { return (H.state.update || {}).mode === 'payload'; }

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

function langSay(text) {
  const el = document.getElementById('langGenMsg');
  if (el) el.innerHTML = text;
}

async function langRefreshBody() {
  const box = document.getElementById('langBody');
  if (!box) return;
  const st = await H.api('/api/language/state').catch(() => null);
  if (!st) return;
  box.innerHTML = languageBodyHTML(st);
  bindLanguageBody();
}

function langStartGenerate(body) {
  return H.api('/api/language/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => {
      if (!r.ok) throw new Error(r.error || tr('提交失败'));
      langSay(H.esc(tr('生成中…（进度见下方进度条与任务中心）')));
      langWatchTask(r.taskId);
      return r;
    });
}

function langDisableGen(disabled) {
  const box = document.getElementById('langBody');
  if (!box) return;
  box.querySelectorAll('[data-lang-gen], #langGenBtn').forEach(el => { el.disabled = !!disabled; });
}

/** 路径太长时只留尾巴，中间省略 */
function pathTail(p, n) {
  p = String(p || '');
  return p.length > n ? '…' + p.slice(-(n - 1)) : p;
}

const LANG_FALLBACK_LOCALES = [
  { code: 'zh-CN', name: '中文', nativeName: '中文', englishName: 'Chinese', builtin: true, generated: false, entries: 0, translated: 0 },
  { code: 'en-US', name: 'English', nativeName: 'English', englishName: 'English', builtin: true, generated: false, entries: 0, translated: 0 }
];

function langWatchTask(taskId) {
  if (window.__langPoll) { try { clearInterval(window.__langPoll); } catch (e) {} window.__langPoll = null; }
  const started = Date.now();
  langProgressShow(true);
  langDisableGen(true);
  window.__langPoll = setInterval(async () => {
    let list = [];
    try { list = (await H.api('/api/tasks')).tasks || []; } catch (e) { return; }
    const t = list.find(x => Number(x.id) === Number(taskId));
    if (!t) {
      if (Date.now() - started > 10 * 60 * 1000) {
        clearInterval(window.__langPoll); window.__langPoll = null;
        langProgressShow(false); langDisableGen(false);
        langSay(H.esc(tr('任务好像丢了，刷新页面重试。')));
      }
      return;
    }
    const pct = Number(t.progress || 0);
    const phase = t.phaseLabel ? H.esc(t.phaseLabel) + ' · ' : '';
    langProgressPaint(pct, H.esc(t.message || tr('生成中…')) + '　<span class="muted">' + phase + pct + '%</span>');
    if (t.status === 'done') {
      clearInterval(window.__langPoll); window.__langPoll = null;
      const r = t.result || {};
      langProgressPaint(100, '✅ ' + H.esc(tr('已生成')) + ' <b>' + H.esc(r.name || r.code || '') + '</b>（' + Number(r.entries || 0) + ' ' + H.esc(tr('条译文')) + '）' + H.esc(tr('，正在切换…')));
      if (r.code && window.SXI18N) {
        try { await window.SXI18N.setLanguage(r.code); return; } catch (e) {
          langSay(H.esc(tr('切换失败：')) + H.esc(e.message));
          langDisableGen(false);
        }
      }
      setTimeout(() => { langRefreshBody(); }, 600);
    } else if (t.status === 'failed' || t.status === 'cancelled') {
      clearInterval(window.__langPoll); window.__langPoll = null;
      const msg = t.error || t.message || '';
      langProgressPaint(0, '❌ ' + H.esc(t.status === 'cancelled' ? tr('已停止') : (tr('生成失败：') + msg)));
      langDisableGen(false);
    }
  }, 2000);
}

function langProgressShow(on) {
  const box = document.getElementById('langProgress');
  if (box) box.hidden = !on;
  if (!on) {
    const fill = document.getElementById('langProgFill');
    if (fill) fill.style.width = '0%';
  }
}

function langProgressPaint(pct, msg) {
  const fill = document.getElementById('langProgFill');
  const m = document.getElementById('langProgMsg');
  if (fill) fill.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
  if (m) m.innerHTML = msg || '';
}

async function renderSettings() {
  H.app.innerHTML = '<p class="muted">加载中…</p>';
  if (!H.state.componentList || !H.state.componentList.length) { try { await H.loadComponents(); } catch (e) {} }
  const [s, st] = await Promise.all([
    H.api('/api/settings'),
    H.api('/api/ai/status')
  ]);
  H.state.aiStatus = st;
  const provider = s.ai_provider || 'openai';
  const configured = !!st.configured;
  // 识图会用哪个模型：配置了就用配置的，否则显示自动选用的（opencode 有可读图的默认值）
  const visionHint = st.visionModel
    ? '识别图片会使用：' + st.visionModel + (st.visionModelSaved ? '' : '（未单独配置，自动选用）')
    : '识别图片需要支持视觉的模型（如 qwen-vl-max / gpt-4o / glm-4v-plus）；留空则用上面的文本模型，若它不支持读图，识图会提示失败。';

  const conns = (await H.api('/api/ai/connections').catch(() => ({ connections: [] }))).connections || [];
  const provRes = await H.api('/api/ai/providers').catch(() => ({ providers: [] }));
  const provs = (provRes.providers && provRes.providers.length) ? provRes.providers : AI_PROVIDERS_FALLBACK;
  H.AI_PROVIDERS = provs;
  const agentRes = await H.api('/api/ai/agents').catch(() => ({ agents: [] }));
  H.AI_AGENTS = (agentRes.agents && agentRes.agents.length) ? agentRes.agents : AI_AGENTS_FALLBACK;
  /* opencode 装没装，进设置页就先探一次 —— 用户点了 opencode 按钮就该立刻看到结论，
     不用等他自己去点「检测」。 */
  const ocState = await H.api('/api/ai/opencode-status').catch(() => null);
  const aiCtx = { ocState, avail: {}, agent: s.ai_opencode_agent || 'NoTools' };
  /* 界面语言：可用语言（内置 + AI 生成）+ 当前生效语言 */
  const langState = await H.api('/api/language/state').catch(() => ({ locales: [] }));

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
    ['set-lang', '🌐 语言 Language'],
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
  H.state._setTabs = SET_TABS.map(([id]) => id);
  html += languageSectionHTML(langState);
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
            <span class="inWrap"><i>🔗</i><input class="mono" id="visBase" value="${H.esc(s.vis_base_url || '')}" placeholder="如 https://dashscope.aliyuncs.com/compatible-mode/v1" spellcheck="false"></span>
          </label>
          <label class="ccWide">API 密钥
            <span class="inWrap"><i>🔑</i><input type="password" id="visKey" value="" placeholder="${s.vis_has_key ? '已保存（留空则不修改）' : 'sk-…'}" spellcheck="false"><button type="button" class="peekBtn" id="visPeek" title="显示 / 隐藏">👁</button></span>
          </label>
        </div>
        <div class="ccRow">
          <label class="ccWide">模型名
            <span class="inWrap"><i>⌨️</i><input id="visModel" value="${H.esc(s.vision_model || '')}" placeholder="点下面按钮选，或手动输入" spellcheck="false"></span>
          </label>
        </div>
        <div class="mBtnGrid" id="visOpts" style="margin-top:8px;"><div class="hint">点「获取可用模型」列出该地址支持的，点一下填入上面；列表里没有就直接手填。</div></div>
        <div class="toolbarRow" style="margin-top:9px;">
          <button class="btn tiny cbtn" id="visFetch">🔄 获取可用模型</button>
          <button class="btn tiny cbtn" id="visTest">测试连通</button>
          <button class="btn tiny cbtn primary" id="visSave">保存识图配置</button>
        </div>
        <div class="hint" id="visMsg" style="margin-top:6px;">${st.visionModel ? '当前识图用：<b>' + H.esc(st.visionModel) + '</b>' : '还没配识图模型（不配则自动跟对话走）'}</div>
      </div>
      <div class="toolbarRow" style="margin-top:12px;">
        <button class="btn primary" id="saveSettings">保存全部连接</button>
        <button class="btn" id="testAi">测试第一条连接</button>
      </div>
      <div id="aiStatusBox" class="hint" style="margin-top:10px; line-height:1.8;">
        ${H.aiStatusBoxHTML(st)}
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
  H.app.innerHTML = html;

  /* 模型搜索 / 全选要基于「完整列表」：先把每张卡初始渲染出来的按钮缓存下来。
     之后搜索只是过滤显示，不会把没显示的模型从候选里永久筛掉。 */
  Array.from(H.app.querySelectorAll('.connCard')).forEach(card => {
    const cid = card.getAttribute('data-conn');
    if (!cid || (aiCtx.avail[cid] && aiCtx.avail[cid].length)) return;
    const list = Array.from(card.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
    if (list.length) aiCtx.avail[cid] = list;
  });

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
      await H.api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
      const r = await H.api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: card.getAttribute('data-conn'),
        baseUrl: (g('baseUrl') || '').trim(),
        apiKey: (g('apiKey') || '').trim(),
        providerId: pid || '',
        provider: pid === 'opencode' ? 'opencode' : 'openai'
      }) });
      const list = r.models || [];
      if (!list.length) {
        if (hint) hint.innerHTML = '<span style="color:var(--warn)">没取到模型列表：' + H.esc(r.error || '接口未返回') + '</span>'
          + (r.detail ? '<br><button type="button" class="btn tiny" data-act="copydiag" style="margin-top:6px;">📋 复制诊断信息发来排查</button>' : '');
        if (r.detail) card.dataset.diag = r.detail;
        H.toast('没取到模型列表，见卡片内说明');
      } else {
        /* 记住这次取到的列表：保存后重绘时不再退回服务商自带的占位模型 */
        if (cid) aiCtx.avail[cid] = list;
        const sel = cardSel(card);
        paintCardModels(card, sel);
        if (hint) hint.innerHTML = (r.error ? '<span style="color:var(--warn)">' + H.esc(r.error) + '</span><br>' : '')
          + '取到 <b>' + list.length + '</b> 个模型，下面自动逐个测试连通。';
        H.toast('取到 ' + list.length + ' 个模型，开始批量测试');
        await batchTest(card, list);
      }
    } catch (err) {
      if (hint) hint.innerHTML = '<span style="color:var(--warn)">取列表失败：' + H.esc(err.message) + '</span>';
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
        if (hint) hint.innerHTML = `正在测 ${i + 1}/${list.length}：${H.esc(m)}…（点「停止」可中断）`;
        paintBtn(card, m, 'testing');
        try {
          const r = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
          T[m] = !!r.ok;
          T[m + '_msg'] = r.ok ? ('联通正常' + (r.sample ? ' · 回复：' + r.sample : '')) : (r.message || '连不通');
          if (r.ok) okN++;
        } catch (err) { T[m] = false; T[m + '_msg'] = err.message; }
        paintBtn(card, m, T[m], T[m + '_msg']);
      }
      if (hint) hint.innerHTML = (run.stop ? '已停止。' : '') + `测完：通 <b>${okN}</b>/${list.length}（绿=通，红=不通，悬停看原因；选中的才会进对话栏）`;
      H.toast(run.stop ? '已停止批量测试' : ('批量测试完：通 ' + okN + '/' + list.length));
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
  /* 一张卡的「完整可选模型」：搜索只改变显示，不能把过滤后的 DOM 当成新全集
     （否则搜第二次时上次没显示的模型就永久消失了）。 */
  const cardAvailModels = card => {
    const cid = card.getAttribute('data-conn');
    if (cid && aiCtx.avail && Array.isArray(aiCtx.avail[cid]) && aiCtx.avail[cid].length) return aiCtx.avail[cid].slice();
    return Array.from(card.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
  };
  const cardSearchQ = card => {
    const el = card.querySelector('[data-role="mSearch"]');
    return el ? el.value.trim() : '';
  };
  const filterModels = (list, q) => {
    const s = String(q || '').toLowerCase();
    return s ? list.filter(m => String(m).toLowerCase().indexOf(s) >= 0) : list.slice();
  };
  /* 刷新一张卡的模型区（搜索过滤 + 全选状态 + 已选小片 + 计数）。
     ⚠️ sel 必须由调用方传进来 —— 点模型按钮时要先改选中态再重绘，
     如果重绘里再从 DOM 反读，会把刚点的那一下丢掉（点不动的 bug 就是这么来的）。 */
  const paintCardModels = (card, sel) => {
    const avail = cardAvailModels(card);
    sel = sel || cardSel(card);
    const q = cardSearchQ(card);
    const shown = filterModels(avail, q);
    const box = card.querySelector('[data-role="availBox"]');
    if (box) {
      box.innerHTML = shown.length
        ? modelButtonsHTML(shown, sel, testedOf(card))
        : `<div class="hint" style="padding:8px 2px;">${tr('没有匹配「{0}」的模型；点右边「添加」可把它加进候选', q)}</div>`;
    }
    const chosen = card.querySelector('[data-role="chosenBox"]');
    if (chosen) chosen.innerHTML = chosenChipsHTML(avail, sel);
    const lbl = card.querySelector('[data-role="selCount"]');
    if (lbl) lbl.textContent = '已选模型（' + sel.length + '）';
    const cnt = card.querySelector('[data-role="mCount"]');
    if (cnt) cnt.textContent = q ? tr('显示 {0} / 共 {1} 个', shown.length, avail.length) : tr('共 {0} 个可选', avail.length);
    const all = card.querySelector('[data-role="mAll"]');
    if (all) {
      const allOn = shown.length > 0 && shown.every(m => sel.indexOf(m) >= 0);
      all.checked = allOn;
      all.indeterminate = !allOn && shown.some(m => sel.indexOf(m) >= 0);
      all.title = q ? tr('全选当前搜索到的模型') : tr('全选所有模型');
    }
    const add = card.querySelector('[data-act="madd"]');
    if (add) {
      const missing = !!q && avail.indexOf(q) < 0;
      add.hidden = !missing;
      add.title = missing ? tr('把「{0}」加入候选（官方出新模型时用）', q) : '';
    }
  };
  /* 把卡片上的输入读成连接对象。密钥框留空 = 没碰过，不发 apiKey，
     服务端会保留已存的密钥（否则每次保存都把密钥清成空）。
     连接名不让用户填：按服务商自动起名，重名的加序号（DeepSeek、DeepSeek 2）。
     顺序即 DOM 顺序，是稳定的，同一批卡片每次算出来的名字一致。 */
  const readConns = () => {
    const seen = {};
    return Array.from(H.app.querySelectorAll('.connCard')).map(card => {
      const g = f => { const el = card.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
      const en = card.querySelector('[data-f="enabled"]');
      const kind = card.getAttribute('data-kind') || 'api';
      const purpose = card.getAttribute('data-purpose') || 'chat';
      const pid = card.getAttribute('data-prov') || '';
      let base;
      if (kind === 'agent') {
        const ag = H.AI_AGENTS.find(x => x.id === pid);
        base = ag ? ag.name : 'Agent';
      } else {
        const p = H.AI_PROVIDERS.find(x => x.id === pid);
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
    H.state.aiModels = null;
    try { H.state.aiStatus = await H.api('/api/ai/status').catch(() => null); } catch (e) {}
    const box = document.getElementById('aiStatusBox');
    if (box && H.state.aiStatus) box.innerHTML = H.aiStatusBoxHTML(H.state.aiStatus);

  };
  const save = async () => {
    const r = await H.api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
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
    (only ? [only] : Array.from(H.app.querySelectorAll('.connCard'))).forEach(card => {
      card.classList.remove('dirty');
      const d = card.querySelector('[data-role="dirty"]');
      if (d) d.hidden = true;
    });
  };

  /* 点服务商按钮 → 自动填官方地址、视觉模型、连接名；并把该服务商的常用模型铺成按钮。
     opencode 单独一条（放最后），点了先把本机 opencode 探一遍。
     ⚠️ 必须先解绑上一轮的：renderSettings 每次保存都会重跑，直接 add 会越叠越多，
     点一次按钮触发 N 次请求。 */
  if (window.__aiSetClickH) H.app.removeEventListener('click', window.__aiSetClickH);
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
          const st = await H.api('/api/ai/agent-status?agent=opencode');
          aiCtx.agentState = aiCtx.agentState || {};
          aiCtx.agentState.opencode = st;
          if (probe) probe.innerHTML = st.installed
            ? `<span class="ok">✓ 已检测到 opencode${H.esc(st.version ? ' ' + st.version : '')}</span>`
            : `<span class="bad">✗ ${H.esc(st.hint || '未检测到')}</span>`;
          if (st.installed) await fetchModelsInto(card, 'opencode');
        } catch (err) {
          if (probe) probe.innerHTML = '<span class="bad">检测失败：' + H.esc(err.message) + '</span>';
        }
        return;
      }
      /* 换服务商后，之前那条连接选的模型多半在别家不存在，直接清掉免得误导 */
      const keep = cardSel(card).filter(m => !p || (p.models || []).indexOf(m) >= 0);
      if (p && (p.models || []).length) {
        aiCtx.avail[card.getAttribute('data-conn')] = p.models.slice();
        paintCardModels(card, keep);
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
      const a = H.AI_AGENTS.find(x => x.id === aid);
      const title = card.querySelector('[data-role="title"]');
      if (title) title.textContent = a ? a.name : aid;
      const brand = card.querySelector('[data-role="brand"]');
      if (brand) brand.textContent = a ? (a.brand || 'AG') : 'AG';
      const probe = card.querySelector('[data-role="ocprobe"]');
      if (probe) probe.innerHTML = '<span class="muted">正在检测本机…</span>';
      try {
        const st = await H.api('/api/ai/agent-status?agent=' + encodeURIComponent(aid));
        aiCtx.agentState = aiCtx.agentState || {};
        aiCtx.agentState[aid] = st;
        if (probe) probe.innerHTML = st.installed
          ? `<span class="ok">✓ 已检测到${H.esc((a && a.name) || aid)}${H.esc(st.version ? ' ' + st.version : '')}</span>`
          : `<span class="bad">✗ ${H.esc(st.hint || '未检测到')}</span>`;
        if (st.installed) await fetchModelsInto(card, aid);
        else H.toast(st.hint || '未检测到');
      } catch (err) {
        if (probe) probe.innerHTML = '<span class="bad">检测失败：' + H.esc(err.message) + '</span>';
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
      paintCardModels(card, sel);
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
        const r = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
        const chip = card.querySelector(`[data-chip="${CSS.escape(m)}"]`);
        mt.textContent = r.ok ? '✓' : '!';
        if (chip) {
          chip.classList.remove('ok', 'bad');
          chip.classList.add(r.ok ? 'ok' : 'bad');
          chip.title = r.ok ? ('联通正常' + (r.sample ? ' · 回复：' + r.sample : '')) : ('连不通：' + (r.message || ''));
        }
        H.toast(r.ok ? m + ' 联通正常' : m + ' 连不通');
      } catch (err) {
        mt.textContent = '!';
        H.toast('测试失败：' + err.message);
      } finally { mt.disabled = false; if (mt.textContent === '…') mt.textContent = '测'; }
      return;
    }
    /* 点已选小片的 × → 移除 */
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const card = chip.closest('.connCard');
      const m = chip.getAttribute('data-chip');
      const sel = cardSel(card).filter(x => x !== m);
      paintCardModels(card, sel);
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
      if (el) {
        const al = Array.from(el.querySelectorAll('[data-mbtn]')).map(x => x.getAttribute('data-mbtn'));
        if (al.length) aiCtx.avail[id] = al;
        el.scrollIntoView({ block: 'nearest' });
      }
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
      if (!txt) { H.toast('没有可复制的诊断信息'); return; }
      try {
        await navigator.clipboard.writeText(txt);
        H.toast('诊断信息已复制');
      } catch (e) {
        prompt('复制失败，请手动复制：', txt.slice(0, 2000));
      }
      return;
    }
    if (act === 'madd') {
      /* 搜索框里的名字不在候选里时，就是「手填」：加进候选并选中。
         已经在候选里时等价于点一下那个模型（回车快速选中）。 */
      const inp = card.querySelector('[data-role="mSearch"]');
      const m = ((inp && inp.value) || '').trim();
      if (!m) { H.toast(tr('先输入要搜索或添加的模型名')); if (inp) inp.focus(); return; }
      const cid = card.getAttribute('data-conn');
      const avail = cardAvailModels(card);
      if (avail.indexOf(m) < 0) { avail.push(m); aiCtx.avail[cid] = avail; }
      const sel = cardSel(card);
      if (sel.indexOf(m) < 0) sel.push(m);
      if (inp) inp.value = '';
      paintCardModels(card, sel);
      markDirty(card);
      H.toast(tr('已加入：{0}（记得点「保存设置」）', m));
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
        H.toast('先选一个模型再测');
        return;
      }
      const hint = card.querySelector('[data-role="msghint"]');
      const oldT = btn.textContent;
      btn.disabled = true; btn.textContent = '测试中…';
      try {
        await H.api('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connections: readConns() }) });
        const cid = card.getAttribute('data-conn');
        const models = cardSel(card);
        const queue = models.length ? models : [''];
        const rows = [];
        let okN = 0;
        for (let i = 0; i < queue.length; i++) {
          const m = queue[i];
          if (hint) hint.innerHTML = rows.join('<br>') + `<br>正在测 ${i + 1}/${queue.length}：${H.esc(m || '(默认模型)')}…`;
          try {
            const r = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connId: cid, modelName: m }) });
            if (r.ok) { okN++; rows.push(`✅ <b>${H.esc(m || '(默认模型)')}</b> · 回复：${H.esc(r.sample || '')}`); }
            else rows.push(`❌ <b>${H.esc(m || '(默认模型)')}</b>：${H.esc(r.message || '未知错误')}`);
          } catch (err) {
            rows.push(`❌ <b>${H.esc(m || '(默认模型)')}</b>：${H.esc(err.message)}`);
          }
        }
        if (hint) hint.innerHTML = rows.join('<br>');
        H.toast(okN === queue.length ? '全部 ' + queue.length + ' 个模型都通' : '通 ' + okN + '/' + queue.length + ' 个，见卡片内明细');
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
      if (!H.app.querySelector('.connCard')) document.getElementById('connEmpty').hidden = false;

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
        H.toast('已保存这条连接');
      } catch (e) { H.toast('保存失败：' + e.message); }
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
          const st = await H.api('/api/ai/opencode-status');
          aiCtx.ocState = st;
          if (probe) probe.innerHTML = st.installed
            ? `<span class="ok">✓ 已检测到 opencode${H.esc(st.version ? ' ' + st.version : '')}</span>`
            : `<span class="bad">✗ ${H.esc(st.hint || '未检测到 opencode')}</span>`;
          if (st.installed) await fetchModelsInto(card, 'opencode');
          else H.toast(st.hint || '未检测到 opencode');
        } catch (err) {
          if (probe) probe.innerHTML = '<span class="bad">检测失败：' + H.esc(err.message) + '</span>';
        } finally { btn.disabled = false; if (!window.__aiTesting || !window.__aiTesting[card.getAttribute('data-conn')]) btn.textContent = '🔄 检测并测试'; }
        return;
      }
      await fetchModelsInto(card, pid);
      return;
    }
  };
  H.app.addEventListener('click', window.__aiSetClickH);
  /* 手动输入框回车即添加（同上面的叠加监听问题，先解绑再绑定） */
  if (window.__aiSetKeyH) H.app.removeEventListener('keydown', window.__aiSetKeyH);
  window.__aiSetKeyH = e => {
    if (e.key !== 'Enter') return;
    const inp = e.target && e.target.closest ? e.target.closest('[data-role="mSearch"]') : null;
    if (!inp) return;
    e.preventDefault();
    const card = inp.closest('.connCard');
    const btn = card && card.querySelector('[data-act="madd"]');
    if (btn) btn.click();
  };
  H.app.addEventListener('keydown', window.__aiSetKeyH);
  /* 卡片里一改就标未保存（跟上面的叠加监听同理，先解绑再绑定） */
  if (window.__aiSetDirtyH) H.app.removeEventListener('input', window.__aiSetDirtyH);
  window.__aiSetDirtyH = e => {
    const card = e.target && e.target.closest ? e.target.closest('.connCard') : null;
    if (!card || !document.getElementById('connList') || !document.getElementById('connList').contains(card)) return;
    markDirty(card);
  };
  H.app.addEventListener('input', window.__aiSetDirtyH);
  /* 模型搜索框：输入即过滤（只重画模型按钮与小片，不碰输入框焦点） */
  if (window.__aiSearchH) H.app.removeEventListener('input', window.__aiSearchH);
  window.__aiSearchH = e => {
    const inp = e.target && e.target.closest ? e.target.closest('[data-role="mSearch"]') : null;
    if (!inp) return;
    const card = inp.closest('.connCard');
    if (card) paintCardModels(card);
  };
  H.app.addEventListener('input', window.__aiSearchH);
  /* 「全选」勾选：勾上 = 当前搜索结果全选，取消 = 当前搜索结果全不选 */
  if (window.__aiAllH) H.app.removeEventListener('change', window.__aiAllH);
  window.__aiAllH = e => {
    const all = e.target && e.target.closest ? e.target.closest('[data-role="mAll"]') : null;
    if (!all) return;
    const card = all.closest('.connCard');
    if (!card) return;
    const shown = filterModels(cardAvailModels(card), cardSearchQ(card));
    const sel = cardSel(card).slice();
    if (all.checked) { for (const m of shown) if (sel.indexOf(m) < 0) sel.push(m); }
    else { for (const m of shown) { const i = sel.indexOf(m); if (i >= 0) sel.splice(i, 1); } }
    paintCardModels(card, sel);
    markDirty(card);
  };
  H.app.addEventListener('change', window.__aiAllH);
  /* 独立识图配置：地址/密钥/模型名 + 取列表 + 单独测试。存到 vis_* 设置，
     与对话连接完全分开（有的服务商没有视觉模型，绑在一起讲不清楚）。 */
  const visMsg = document.getElementById('visMsg');
  const visSay = t => { if (visMsg) visMsg.innerHTML = t; };
  /* 识图模型按钮：点一下填入输入框（和连接卡的模型按钮同一套样式） */
  const renderVisOpts = list => {
    const box = document.getElementById('visOpts');
    if (!box) return;
    const cur = ((document.getElementById('visModel') || {}).value || '').trim();
    box.innerHTML = (list || []).map(m => `<button type="button" class="mBtn${m === cur ? ' on' : ''}" data-visopt="${H.esc(m)}">${H.esc(m)}</button>`).join('')
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
    if (!v.base.trim() || !v.model) { H.toast('先填地址和模型名'); return; }
    try {
      const body = { vis_base_url: v.base.trim(), vision_model: v.model };
      if (v.key.trim()) body.vis_api_key = v.key.trim();
      await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const k = document.getElementById('visKey');
      if (k) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
      H.state.aiStatus = await H.api('/api/ai/status').catch(() => null);
      visSay('已保存。当前识图用：<b>' + H.esc((H.state.aiStatus && H.state.aiStatus.visionModel) || v.model) + '</b>');
      H.toast('识图配置已保存');
    } catch (e) { H.toast('保存失败：' + e.message); }
  });
  const visFetch = document.getElementById('visFetch');
  if (visFetch) visFetch.addEventListener('click', async () => {
    const v = visVals();
    if (!v.base.trim()) { H.toast('先填 API 地址'); return; }
    visFetch.disabled = true; visFetch.textContent = '获取中…';
    visSay('正在向该地址请求模型列表…');
    try {
      /* 密钥框空着也行：已存过的用存过的（useVisKey），新填的直接用 */
      const r = await H.api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base.trim(), apiKey: v.key.trim(), useVisKey: !v.key.trim() }) });
      const list = r.models || [];
      if (!list.length) {
        visSay('<span style="color:var(--warn)">没取到：' + H.esc(r.error || '接口未返回') + '</span>');
      } else {
        renderVisOpts(list);
        visSay((r.error ? '<span style="color:var(--warn)">' + H.esc(r.error) + '</span><br>' : '') + '取到 <b>' + list.length + '</b> 个，点一下填入上面，选完点「保存识图配置」。');
        H.toast('取到 ' + list.length + ' 个模型');
      }
    } catch (e) { visSay('<span style="color:var(--warn)">取列表失败：' + H.esc(e.message) + '</span>'); }
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
      if (Object.keys(body).length) await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!v.model) { H.toast('先填模型名'); return; }
      visSay('正在用识图配置请求一次…');
      const r = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: v.model }) });
      visSay(r.ok ? `✅ <b>连通正常</b> · ${H.esc(r.model)}<br>回复：${H.esc(r.sample || '')}` : `❌ <b>连不通</b>：${H.esc(r.message || '')}`);
    } catch (e) { visSay('❌ 测试失败：' + H.esc(e.message)); }
  });
  /* 进设置页时如果识图地址已存，静默取一次模型列表供点选（失败不打扰） */
  (async () => {
    try {
      const vb = ((document.getElementById('visBase') || {}).value || '').trim();
      if (!vb) return;
      const r = await H.api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: vb, useVisKey: true }) });
      if (r.models && r.models.length) renderVisOpts(r.models);
    } catch (e) {}
  })();
  document.getElementById('saveSettings').addEventListener('click', async () => {    /* 保存全部：原地刷新，不整页重绘（重绘会丢滚动位置；各卡输入都在 DOM 里没丢） */
    try {
      const r = await save();
      const byId = {};
      for (const c of ((r && r.connections) || [])) byId[c.id] = c;
      H.app.querySelectorAll('.connCard').forEach(card => {
        const key = card.querySelector('[data-f="apiKey"]');
        const sv = byId[card.getAttribute('data-conn')];
        if (key) { key.value = ''; key.placeholder = (sv && sv.hasKey) ? '已保存（留空则不修改）' : 'sk-…'; }
      });
      H.toast('已保存全部连接');
    } catch (e) { H.toast(e.message); }
  });
  document.getElementById('testAi').addEventListener('click', async e => {
    const btn = e.target;
    const box = document.getElementById('aiStatusBox');
    btn.disabled = true; btn.textContent = '测试中…';
    box.innerHTML = '正在保存配置并测试第一条启用的连接…';
    try {
      await save();  // 先保存再测试，避免"改了没存"导致误报
      const r = await H.api('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) {
        box.innerHTML = `✅ <b>连接正常</b> · ${H.esc(r.connName ? r.connName + ' · ' : '')}${H.esc(r.provider === 'openai' ? 'OpenAI 兼容接口' : 'opencode CLI')} · 模型 ${H.esc(r.model)}<br>模型回复：${H.esc(r.sample || '')}`;
        H.toast('连接正常');
      } else {
        box.innerHTML = `❌ <b>连接失败</b>：${H.esc(r.message || '未知错误')}<br><span class="hint">检查：API 地址是否正确 · 密钥是否正确 · 模型名是否存在 · 网络/代理是否可用</span>`;
        H.toast('连接失败，见下方说明');
      }
    } catch (err) {
      box.innerHTML = '❌ 连接失败：' + H.esc(err.message);
    } finally { btn.disabled = false; btn.textContent = '测试第一条连接'; }
  });
  bindServiceSection();
  bindUpdateSection();
  bindSyncSection();
  bindLanguageSection(langState);

  /* 顶栏页签：一次只显示一块，整页切换，不再全挤在一起。
     切页签只做 hidden 显隐 —— 输入框里的未保存内容不会丢，各区块的监听也都在，
     比销毁重建稳。保存重绘后停在刚才看的那块。 */
  const tabsBox = document.getElementById('setTabs');
  const tabIds = H.state._setTabs || [];
  /* 组件页的「去设置里选」带着 /theme 进来，直接停在外观主题页签 */
  if (/^#\/settings\/theme/.test(location.hash || '')) H.state.settingsTab = 'set-theme';
  const markTab = id => tabsBox && tabsBox.querySelectorAll('.setTab').forEach(b =>
    b.classList.toggle('on', b.getAttribute('data-tab') === id));
  const applyTab = () => {
    const cur = (H.state.settingsTab && document.getElementById(H.state.settingsTab)) ? H.state.settingsTab : 'set-ai';
    H.state.settingsTab = cur;
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
      H.state.settingsTab = b.getAttribute('data-tab');
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
      H.setThemeFor(mode, el.value);
      const now = H.currentThemeEff() === mode;
      H.toast(now
        ? tr('已应用{0}主题', label)
        : tr('已设置{0}主题（切到{1}模式时生效）', label, tr(mode === 'dark' ? '暗色' : '亮色')));
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
      const st = await H.api('/api/rag/status' + (gid ? '?goalId=' + gid : ''));
      const emb = st.embConfigured ? '向量模型 <b>' + H.esc(st.embModel) + '</b>' : '未配置向量模型（当前按关键词检索）';
      ragSay('ragStatus', '资料 <b>' + st.sources + '</b> 条 · 分块 <b>' + st.chunks + '</b> · 已向量化 <b>' + st.embedded + '</b>'
        + (st.pending ? ' · 待处理 <b style="color:var(--warn)">' + st.pending + '</b>' : '')
        + '　·　' + emb + (st.building ? '　·　<span style="color:var(--warn)">正在建立索引…</span>' : ''));
    } catch (e) { ragSay('ragStatus', '状态读取失败：' + H.esc(e.message)); }
  };
  const ragToggle = ragEl('ragEnabled');
  if (ragToggle) ragToggle.addEventListener('change', async () => {
    try {
      await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rag_enabled: ragToggle.checked }) });
      H.toast(ragToggle.checked ? '已开启检索增强' : '已关闭检索增强');
    } catch (e) { H.toast('保存失败：' + e.message); }
  });
  const embVals = () => ({
    base: ((ragEl('embBase') || {}).value || '').trim(),
    key: ((ragEl('embKey') || {}).value || '').trim(),
    model: ((ragEl('embModel') || {}).value || '').trim()
  });
  const embSaveBtn = ragEl('embSave');
  if (embSaveBtn) embSaveBtn.addEventListener('click', async () => {
    const v = embVals();
    if (!v.base || !v.model) { H.toast('先填地址和向量模型名'); return; }
    try {
      const body = { emb_base_url: v.base, emb_model: v.model };
      if (v.key) body.emb_api_key = v.key;
      await H.api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const k = ragEl('embKey'); if (k) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
      ragSay('embMsg', '已保存。点「测试向量」验证是否可用。');
      H.toast('向量配置已保存');
    } catch (e) { H.toast('保存失败：' + e.message); }
  });
  const embFetchBtn = ragEl('embFetch');
  if (embFetchBtn) embFetchBtn.addEventListener('click', async () => {
    const v = embVals();
    if (!v.base) { H.toast('先填 API 地址'); return; }
    embFetchBtn.disabled = true; embFetchBtn.textContent = '获取中…';
    ragSay('embMsg', '正在向该地址请求模型列表…');
    try {
      const r = await H.api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base, apiKey: v.key, useEmbKey: !v.key }) });
      const box = ragEl('embOpts');
      const list = r.models || [];
      if (box) box.innerHTML = (list.map(m => `<button type="button" class="mBtn" data-embopt="${H.esc(m)}">${H.esc(m)}</button>`).join('')) || '<div class="hint">没有可选模型。</div>';
      ragSay('embMsg', list.length ? ('取到 <b>' + list.length + '</b> 个，点一下填入模型名。' + (r.error ? '（' + H.esc(r.error) + '）' : '')) : ('<span style="color:var(--warn)">没取到：' + H.esc(r.error || '接口未返回') + '</span>'));
    } catch (e) { ragSay('embMsg', '<span style="color:var(--warn)">取列表失败：' + H.esc(e.message) + '</span>'); }
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
      const r = await H.api('/api/ai/models-for', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: BASE, apiKey: '', useEmbKey: false }) });
      const list = r.models || [];
      const box = ragEl('embOpts');
      /* 常见向量模型名特征：bge / m3 / nomic / mxbai / gte / e5 / jina / embed */
      const isEmb = m => /(^|[-_/])(bge|m3|embed|embedding|nomic|mxbai|gte|e5|jina)/i.test(String(m).replace(/:.*$/, ''));
      if (box) {
        box.innerHTML = list.map(m => `<button type="button" class="mBtn" data-embopt="${H.esc(m)}">${H.esc(m)}${isEmb(m) ? ' <span style="color:var(--ok);font-size:11px;">· 向量</span>' : ''}</button>`).join('')
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
    if (!v.base || !v.model) { H.toast('先填地址和向量模型名'); return; }
    ragSay('embMsg', '正在真实调用向量接口…');
    try {
      const r = await H.api('/api/ai/emb-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: v.base, model: v.model, apiKey: v.key }) });
      if (r.ok) {
        const k = ragEl('embKey'); if (k && v.key) { k.value = ''; k.placeholder = '已保存（留空则不修改）'; }
        ragSay('embMsg', '✅ <b>向量接口正常</b> · ' + H.esc(r.model) + ' · 维度 ' + r.dim + '。点「建立本目标索引」开始向量化。');
      } else ragSay('embMsg', '❌ <b>不可用</b>：' + H.esc(r.message || ''));
    } catch (e) { ragSay('embMsg', '❌ 测试失败：' + H.esc(e.message)); }
  });
  const ragBuildBtn = ragEl('ragBuildBtn');
  if (ragBuildBtn) ragBuildBtn.addEventListener('click', async () => {
    const gid = Number((ragEl('ragGoalSel') || {}).value || 0);
    if (!gid) { H.toast('先选一个目标'); return; }
    try {
      const r = await H.api('/api/goals/' + gid + '/rag/build', { method: 'POST' });
      H.toast(r.already ? '索引任务已在运行' : '已开始建立索引（左下角任务中心可看进度）');
      refreshRagStatus();
    } catch (e) { H.toast('启动失败：' + e.message); }
  });
  const ragRefreshBtn = ragEl('ragRefresh');
  if (ragRefreshBtn) ragRefreshBtn.addEventListener('click', refreshRagStatus);
  const ragSearchBtn = ragEl('ragSearchBtn');
  if (ragSearchBtn) ragSearchBtn.addEventListener('click', async () => {
    const gid = Number((ragEl('ragGoalSel') || {}).value || 0);
    const q = ((ragEl('ragQ') || {}).value || '').trim();
    if (!gid || !q) { H.toast('先选目标、输入检索词'); return; }
    ragSay('ragHits', '检索中…');
    try {
      const r = await H.api('/api/goals/' + gid + '/rag/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
      const hits = r.hits || [];
      ragSay('ragHits', hits.length
        ? hits.map(h => `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;"><div style="font-size:12px;color:var(--muted);">${Number(h.quality) === 1 ? '★' : ''}[${H.esc(h.site)}｜${H.esc(h.kind)}] ${H.esc(h.title)} · 相关度 ${h.score}</div><div style="font-size:12.5px;margin-top:4px;">${H.esc(h.text)}</div></div>`).join('')
        : '<div class="hint">没有命中（可能资料还没入库，或换种说法再试）。</div>');
    } catch (e) { ragSay('ragHits', '<div class="hint">检索失败：' + H.esc(e.message) + '</div>'); }
  });
  if (ragEl('ragStatus')) refreshRagStatus();
  const sgb = document.getElementById('showGuideBtn');
  if (sgb) sgb.addEventListener('click', () => H.showGuide(0));
  document.getElementById('backupNow').addEventListener('click', async () => {
    try { const r = await H.api('/api/backup', { method: 'POST' }); H.toast('已备份，共 ' + r.count + ' 份'); await loadBackupList(); } catch (e) { H.toast(e.message); }
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
    try { r = await H.api('/api/backup/list'); } catch (e) { box.innerHTML = '<p class="muted" style="padding:6px 0;">读取失败：' + H.esc(e.message) + '</p>'; return; }
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
      vis.map((it, i) => `<div class="bkRow${bkSel.has(it.name) ? ' hasSel' : ''}" data-bk-row="${H.esc(it.name)}">
        <span class="bkCk"><input type="checkbox" data-bk-ck="${H.esc(it.name)}"${bkSel.has(it.name) ? ' checked' : ''}></span>
        <span class="bkTime">${H.esc(fmtBkTime(it.name))}</span>
        <span class="bkSize">${H.esc(fmtBytes(it.size))}</span>
        <span>${i === 0 ? '<span class="bkBadge">最新</span>' : ''}</span>
        <span class="bkActs">
          <button class="btn tiny" data-bk-diff="${H.esc(it.name)}">变化</button>
          <button class="btn tiny" data-bk-restore="${H.esc(it.name)}">恢复</button>
          <button class="btn tiny danger" data-bk-del="${H.esc(it.name)}">删除</button>
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
      const head = (title, cls) => `<div class="bkDiffTop"><b class="${cls || ''}">${H.esc(title)}</b><span class="spacer"></span><button class="btn tiny" data-bk-x>收起</button></div>`;
      try {
        const d = await H.api('/api/backup/diff?name=' + encodeURIComponent(name));
        if (d.first) {
          panel.innerHTML = head('这是最早的一份备份') + '<div class="bkSamples">没有可对比的上一版。</div>';
        } else {
          const rows = (d.items || []).map(it => `<div class="bkDiffItem">
              <b>${H.esc(it.label)}</b>
              ${it.added ? `<span class="bkNum add">+${it.added}</span>` : ''}
              ${it.removed ? `<span class="bkNum del">−${it.removed}</span>` : ''}
              ${it.changed ? `<span class="bkNum mod">~${it.changed} 处改动</span>` : ''}
              <span class="bkSamples">${H.esc((it.samples || []).map(x => (x.type === 'add' ? '＋' : x.type === 'del' ? '－' : '·') + x.text).join('　'))}</span>
            </div>`).join('');
          panel.innerHTML = head(`相比上一份（${fmtBkTime(d.prev)}）的变化`) +
            (rows || '<div class="bkSamples">两次备份内容一致，没有变化。</div>');
        }
      } catch (e) {
        panel.innerHTML = head('对比失败') + `<div class="bkSamples">${H.esc(e.message)}</div>`;
      }
      const x = panel.querySelector('[data-bk-x]');
      if (x) x.addEventListener('click', closeDiff);
    }));
    box.querySelectorAll('[data-bk-restore]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-bk-restore');
      if (!confirm(`确定用 ${fmtBkTime(name)} 这份备份覆盖当前数据吗？\n\n当前数据会先自动另存为一份备份，仍可恢复。\n恢复后需要重启应用。`)) return;
      try {
        await H.api('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        H.toast('已恢复，请重启应用');
        setTimeout(() => location.reload(), 1200);
      } catch (e) { H.toast('恢复失败：' + e.message); }
    }));
    box.querySelectorAll('[data-bk-del]').forEach(b => b.addEventListener('click', async () => {
      const name = b.getAttribute('data-bk-del');
      if (!confirm(`删除备份 ${fmtBkTime(name)}？此操作不可撤销。`)) return;
      try { await H.api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); bkSel.delete(name); await loadBackupList(); H.toast('已删除'); }
      catch (e) { H.toast('删除失败：' + e.message); }
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
      try { await H.api('/api/backup/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) }); ok++; }
      catch (e) { fail++; }
    }
    bkSel.clear();
    await loadBackupList();
    H.toast(fail ? `已删除 ${ok} 份，${fail} 份失败` : `已删除 ${ok} 份`);
  });
  syncDelSel();
  const bkKeep = document.getElementById('backupKeep');
  if (bkKeep) {
    bkKeep.addEventListener('change', async () => {
      bkKeep.dataset.touched = '1';
      try {
        const r = await H.api('/api/backup/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: Number(bkKeep.value) }) });
        H.toast(`改为保留最近 ${r.keep} 份，现有 ${r.count} 份`);
        bkKeep.dataset.touched = '';
        await loadBackupList();
      } catch (e) { H.toast(e.message); }
    });
  }
  loadBackupList();
  document.getElementById('importJson').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!confirm('导入会覆盖现有全部目标与路径（会先自动备份）。继续？')) { e.target.value = ''; return; }
    try {
      const data = JSON.parse(await file.text());
      const r = await H.api('/api/import/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      H.toast('已导入 ' + r.goals + ' 个目标');
      setTimeout(() => { location.hash = '#/'; location.reload(); }, 600);
    } catch (err) { H.toast('导入失败：' + err.message); }
    e.target.value = '';
  });
}

  function mountSettings(host) {
    H = host || {};
    return {
      render: function () { return renderSettings(); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['settings'] = { id: 'settings', mount: mountSettings };
})();
