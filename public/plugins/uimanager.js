'use strict';
/**
 * 思而行 · 界面管理页（#/ui-plugins）
 * ------------------------------------------------------------------
 * 设计目的：让「万物皆插件」看得见、摸得着：
 *   - 每个页面：内置 / 用户覆盖 / 已停用 三种状态一眼看清；
 *   - 一键停用用户插件 → 立刻回退内置界面（不删文件，随时恢复）；
 *   - 「看内置版」带 ?ui=legacy 打开同一条路由，方便对照；
 *   - 底部折叠块展示内核自检：服务清单、插件装载状态、为什么被跳过。
 * 页面只用宿主组件体系已有的 api/esc/toast，不额外依赖。
 */
(function () {
  const { api, esc, toast } = SiErXing;
  const PID = 'uimanager';

  function badge(m) {
    if (!m) return '';
    if (m.source === 'user' && m.enabled === false) return '<span class="uipBadge off">已停用</span>';
    if (m.source === 'user') return '<span class="uipBadge user">用户覆盖</span>';
    return '<span class="uipBadge builtin">内置</span>';
  }
  function pageName(id) {
    const names = {
      home: '主页', guide: '引导', settings: '设置', components: '组件管理', library: '资源库',
      aitasks: 'AI 任务', versions: '版本对比', diff: '版本差异', roadmap: '路线图',
      tutorial: '学习教程', goal: '目标执行页', chat: '对话页'
    };
    return names[id] || id;
  }
  function routeWithId(route, goalId) {
    if (!route) return '';
    return String(route).replace(/:vid/g, '285').replace(/:id/g, String(goalId || 1)).replace(/:id\b/g, String(goalId || 1));
  }

  function render(host, data) {
    const root = document.getElementById('app');
    if (!root) return;
    const ui = data.ui || {};
    const list = (ui.plugins || []).slice();
    const userCount = list.filter(function (p) { return p.source === 'user'; }).length;
    const kernel = data.kernel || {};
    const services = kernel.services || [];
    const kplugins = kernel.plugins || [];
    const skipped = kplugins.filter(function (p) { return p.status !== 'loaded'; });
    const skins = (data.skins && data.skins.skins) || [];

    const cards = list.map(function (m) {
      const route = routeWithId(m.route, data.goalId);
      const isUser = m.source === 'user';
      const disabled = isUser && m.enabled === false;
      const openHref = route ? '#' + String(route).replace(/^#/, '') : '#/';
      const legacyHref = route ? ('/?ui=legacy#' + String(route).replace(/^#/, '')) : '/?ui=legacy#/';
      return '<div class="uipCard ' + (isUser ? (disabled ? 'off' : 'user') : '') + '">' +
        '<div class="uipCardHead"><b>' + esc(pageName(m.id)) + '</b>' + badge(m) + '</div>' +
        '<div class="uipMeta">id: <code>' + esc(m.id) + '</code> · v' + esc(m.version || '0.0.0') +
          ' · ' + esc(m.apiVersion || '') + (m.route ? ' · 路由 <code>' + esc(m.route) + '</code>' : '') + '</div>' +
        (m.description ? '<div class="uipDesc">' + esc(m.description) + '</div>' : '') +
        '<div class="uipActions">' +
          '<a class="btn small" href="' + esc(openHref) + '">打开页面</a>' +
          '<a class="btn small" href="' + esc(legacyHref) + '">看内置版</a>' +
          (isUser
            ? '<button class="btn small" data-uip-toggle="' + esc(m.id) + '" data-enabled="' + (disabled ? '0' : '1') + '">' + (disabled ? '启用用户插件' : '停用，回退内置') + '</button>'
            : '<span class="uipHint">无用户覆盖</span>') +
        '</div>' +
        '<div class="uipPath">目录：<code>' + esc(ui.userDir || '') + '/' + esc(m.id) + '</code></div>' +
      '</div>';
    }).join('');

    const kRows = kplugins.map(function (p) {
      const st = p.status === 'loaded' ? '<span class="uipOk">已装载</span>' : '<span class="uipBad">' + esc(p.status) + '</span>';
      return '<tr><td><code>' + esc(p.id) + '</code></td><td>' + st + '</td><td>' + esc(p.version || '') + '</td><td>' + esc(p.reason || '') + '</td></tr>';
    }).join('');

    root.innerHTML = '<div class="page uipPage">' +
      '<div class="pageHead"><h1>🧱 界面管理</h1>' +
        '<div class="pageHeadActions"><button class="btn small" data-uip-refresh>刷新</button>' +
        '<button class="btn small" data-uip-dir>打开插件目录</button></div></div>' +
      '<div class="uipNote">默认界面由内置页面插件渲染；把用户插件放进 <code>' + esc(ui.userDir || 'DATA_DIR/ui-plugins') + '/&lt;page-id&gt;/</code>, ' +
        '就会整页替换内置界面。用户插件支持 <b>ESM + Vue</b>（<code>export default</code> 组件）、<code>export function mount(root, ctx)</code>、以及老契约 <code>window.SXUIPlugin</code>。' +
        '插件出错会自动回退内置界面，不会白屏；停用只写状态文件，不删文件。</div>' +
      '<div class="uipStats">内置页面 <b>' + list.filter(function (p) { return p.source === 'builtin'; }).length + '</b> 个 · 用户插件 <b>' + userCount + '</b> 个 · 内核服务 <b>' + services.length + '</b> 个 · 插件异常 <b>' + skipped.length + '</b> 个</div>' +
      '<div class="uipGrid">' + (cards || '<div class="emptyBox">没有找到页面插件（检查 ui/plugins/builtin 是否存在）</div>') + '</div>' +
      '<details class="uipFold"><summary>' + esc(tr('🎨 用户皮肤（skin.css）')) + (skins.length ? ' · ' + esc(tr('{0} 个', skins.length)) : ' · ' + esc(tr('无'))) + '</summary>' +
        (skins.length
          ? '<ul class="uipSkinList">' + skins.map(function (s) { return '<li><code>' + esc(s.id) + '</code> — ' + esc(s.name || '') + '（优先级 ' + esc(String(s.priority || 0)) + '）</li>'; }).join('') + '</ul>'
          : '<div class="uipHint">把 <code>skin.css</code> 放进插件目录即可叠加样式（优先级低的先加载，后加载覆盖前面的）。</div>') +
      '</details>' +
      '<details class="uipFold"><summary>' + esc(tr('🧠 内核自检：{0} 个服务 / {1} 个服务端组件（异常 {2}）', services.length, kplugins.length, skipped.length)) + '</summary>' +
        '<div class="uipHint">内核版本 <code>' + esc(kernel.apiVersion || '') + '</code>。缺依赖的组件会被跳过并记录原因，其它组件照常运行。</div>' +
        '<table class="uipTable"><thead><tr><th>组件</th><th>状态</th><th>版本</th><th>原因</th></tr></thead><tbody>' + (kRows || '<tr><td colspan="4" class="uipHint">没有组件</td></tr>') + '</tbody></table>' +
      '</details>' +
      '<details class="uipFold"><summary>📄 最小示例（放进用户插件目录即可生效）</summary>' +
        '<pre class="uipCode">' + esc(
          '// DATA_DIR/ui-plugins/home/manifest.json\n' +
          '{ "id": "home", "name": "我的主页", "apiVersion": "sierxing.ui/1",\n  "entry": "index.js", "format": "esm", "standalone": true }\n\n' +
          '// DATA_DIR/ui-plugins/home/index.js\n' +
          'const { h } = window.SiErXingUI.vue;\n' +
          'export default {\n  setup() {\n    return () => h("div", { class: "page" }, "这是我自己的主页");\n  }\n};\n\n' +
          '// 想完全自己接管 DOM 也可以：\n' +
          'export function mount(root, ctx) {\n  root.innerHTML = "<h1>你好</h1>";\n  return function unmount() { root.innerHTML = ""; };\n}'
        ) + '</pre></details>' +
    '</div>';

    bind(host, root);
  }

  function bind(host, root) {
    root.querySelectorAll('[data-uip-toggle]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const id = b.getAttribute('data-uip-toggle');
        const currentlyEnabled = b.getAttribute('data-enabled') === '1';
        b.disabled = true;
        try {
          await api('/api/ui/plugins/' + encodeURIComponent(id) + '/state', { method: 'POST', body: { enabled: !currentlyEnabled } });
          toast(!currentlyEnabled ? '已启用用户插件：' + id : '已停用，回退内置界面：' + id);
          await load(host);
        } catch (e) {
          toast('操作失败：' + e.message);
          b.disabled = false;
        }
      });
    });
    const dirBtn = root.querySelector('[data-uip-dir]');
    if (dirBtn) dirBtn.addEventListener('click', async function () {
      try {
        const r = await api('/api/ui/plugins/open-dir', { method: 'POST', body: {} });
        toast(r && r.dir ? '插件目录：' + r.dir : '已打开插件目录');
      } catch (e) { toast('打开失败：' + e.message); }
    });
    const refresh = root.querySelector('[data-uip-refresh]');
    if (refresh) refresh.addEventListener('click', function () { load(host); });
  }

  async function load(host) {
    const data = {};
    try { data.ui = await api('/api/ui/plugins'); } catch (e) { data.ui = { plugins: [] }; }
    try { data.kernel = await api('/api/kernel'); } catch (e) { data.kernel = {}; }
    try { data.skins = await api('/api/ui/skins'); } catch (e) { data.skins = {}; }
    try {
      const g = await api('/api/goals');
      data.goalId = (g.goals && g.goals.length) ? g.goals[0].id : 0;
    } catch (e) { data.goalId = 0; }
    render(host, data);
  }

  SiErXing.registerPlugin({
    id: PID,
    routes: [{
      match: function (h) { return h === '#/ui-plugins' || h.indexOf('#/ui-plugins?') === 0; },
      render: async function () { await load(SiErXing); }
    }]
  });
})();
