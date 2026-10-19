# 内核与插件契约（P0–P3 · 已实现）

> 目标不是「把所有代码塞进插件」，而是让 UI / 功能 / 内核能力都能被替换，
> 并且升级只替换下层、用户的改动永远留在覆盖层 —— 这就是「升级不冲突」的实现方式。
>
> 状态：P0（内核）、P1（服务化 + 自定义组件装载）、P2（用户 UI 插件 / 管理页）、
> P3（分层配置 + 版本与迁移 + 升级差异）已完成并纳入回归；
> P4（内核瘦身，把 server.js / app.js 逐步搬进插件）明确不做，
> 所以「内核本身」仍是容器 + 启动器。

---

## 1. 三层结构

    ┌──────────────────────────────────────────────────────────────┐
    │ 用户覆盖层（DATA_DIR，升级永不覆盖）                          │
    │   ui-plugins/<页面id>/manifest.json + entry + skin.css        │
    │   config/profile.json / config/user.json                      │
    ├──────────────────────────────────────────────────────────────┤
    │ 内核（server/kernel.js）                                      │
    │   provide / get / effect / plugin / 依赖优先装载 / 卸载清理    │
    │   缺依赖跳过 / 迁移 / 状态快照；server/kernel-services.js 装配 │
    ├──────────────────────────────────────────────────────────────┤
    │ 内置层（随程序升级，用户不改）                                │
    │   server/plugins/*.js（服务端组件）                            │
    │   ui/plugins/builtin/<page>/（内置页面插件，11 页 + 引导）     │
    │   public/plugins/*.js（前端组件：学习统计/随堂测验/看懂代码…） │
    │   config/kernel.schema.json（配置默认值 = builtin 层）         │
    └──────────────────────────────────────────────────────────────┘

---

## 2. 内核（server/kernel.js，零第三方依赖）

    const { createKernel } = require('./kernel.js');
    const k = createKernel({ apiVersion: 'sierxing.kernel/1', log });

    k.provide('db', db);                        // 声明能力（重复注册会抛错）
    k.get('db'); k.has('db'); k.require('db');  // 取用；require 缺了会抛错

    k.on('plugin', ({ action, id }) => {});     // service / plugin / reload / dispose

    k.loadPlugins([{
      id: 'my-feature',                         // 必填，^[a-z0-9][a-z0-9._-]{0,63}$
      name: '我的功能', version: '1.0.0',
      apiVersion: 'sierxing.kernel/1',           // 主版本不一致 → incompatible
      requires: ['db', 'ai'],                    // 服务名 / 插件 id / 插件 provides 的能力
      provides: ['cap:my-feature'],
      builtin: true,
      migrations: [{ version: 1, up(ctx) { ctx.db.exec('CREATE TABLE ...'); } }],
      apply(ctx, config) {
        ctx.effect(() => {                       // 返回清理函数，卸载时逆序执行
          const t = setInterval(() => {}, 1000);
          return () => clearInterval(t);
        });
      }
    }]);

    k.state();     // { apiVersion, services, plugins:[{id,status,reason}] }
    k.reload();    // 先清理再重装（服务不会重复注册）
    k.dispose();   // 全卸载

状态机：loaded / skipped（缺依赖）/ failed（apply 抛错）/ incompatible（apiVersion 主版本不一致）。
任何一种异常只影响该插件自身，不会让服务起不来（启动器保底）。

迁移：插件声明 migrations 后由内核统一执行（版本升序、幂等，记录在 kernel_migrations 表）。

server/plugins/index.js 是兼容层：老插件一个字符不用改（仍是 init(ctx)），
额外拿到 ctx.kernel / ctx.services / ctx.pluginId / ctx.config。

⚠️ ctx 保留字段：id / name / version / config / log / kernel / provide / get / has /
require / on / effect / emit / migrations。服务名与这些重名时（例如 log），
用 ctx.get('log') 取服务，ctx.log 仍是日志函数。

---

## 3. 服务（能力即服务）

/api/kernel 可实时看（services + 每个插件装载状态与跳过原因）。
核心服务：db、ai、tasks、conditions、promptPacks、backup、sync、rag、
getSetting/setSetting、getGoal、sourcesOf、aiText/aiTextFiles、currentModel/currentVisionModel、
fs/path/os/spawn、APP_DIR/DATA_DIR/UPLOAD_DIR/PUBLIC_DIR 等（当前 25 个）。

想替换某个能力：写插件 provides: ['cap:xxx'] 并 ctx.provide(...)；其它插件 requires 接入。
不要直接 require server.js。

---

## 4. 分层配置（P3）

| 层 | 位置 | 谁改 | 升级时 |
|---|---|---|---|
| builtin | config/kernel.schema.json 的 default | 我们 | 随程序更新 |
| profile | DATA_DIR/config/profile.json | 用户 / 组合包 | 不覆盖 |
| user | DATA_DIR/config/user.json | 用户 | 不覆盖 |

合并规则：后一层只写要改的键；写 null = 明确恢复内置默认；数组整组替换（不合并）；
嵌套写法 { "ui": { "pagePlugins": false } } 与扁平写法 { "ui.pagePlugins": false } 都支持。

容错（升级不崩的关键）：
- 未知键（新版本删掉的）→ 告警 + 忽略，并在 /api/kernel 的 upgrade.orphanUserKeys 里列出；
- 类型/枚举不对 → 告警 + 忽略，沿用下层值；
- 坏 JSON → 记录错误 + 用默认值，不让整站起不来；
- kernel.strictConfig=true 才会把坏配置当启动错误（默认关）。

现有配置项：

| 键 | 默认 | 作用 |
|---|---|---|
| ui.pagePlugins | true | 总开关：关掉 = 完全回到原版 render* 界面 |
| ui.userPlugins | true | 是否允许 DATA_DIR/ui-plugins 覆盖内置页面 |
| ui.skins | true | 是否加载用户皮肤 skin.css |
| kernel.logLevel | "normal" | quiet / normal / verbose |
| kernel.strictConfig | false | 配置校验失败是否拒绝启动 |

来源与升级差异：
- provenance：每个值最终来自哪一层（builtin/profile/user）；
- upgrade：与上次启动快照（DATA_DIR/kernel/builtin-snapshot.json）比较，列出
  新增/移除的配置键、新增/移除的服务端插件、用户配置里已失效的键。

CLI（测试沙箱加 SIERXING_DATA_DIR=/tmp/sandbox）：

    node scripts/kernel-config.js --dump                     # 最终值 + 来源 + 告警 + 差异
    node scripts/kernel-config.js --diff                     # 只看升级差异
    node scripts/kernel-config.js --explain ui.pagePlugins   # 某一项每层写了什么
    node scripts/kernel-config.js --init                     # 生成 user.json 模板

---

## 5. UI 页面插件（P2）

清单（DATA_DIR/ui-plugins/<id>/manifest.json）：

    {
      "id": "home",
      "name": "我的主页",
      "apiVersion": "sierxing.ui/1",
      "version": "1.0.0",
      "entry": "index.js",
      "format": "esm",
      "standalone": true,
      "route": "#/"
    }

- format：esm / classic / auto（默认 auto：先按 ESM 试，失败回退经典脚本）；
- standalone: true：用户完全接管内容区，宿主不再注入内置页面样式；
- 其余字段与内置 manifest 相同；id 必须与目录名一致，入口必须在目录内。

入口的三种契约（public/app.js 的 mountUserUiPage()）：

    // ① ESM + Vue 组件（推荐，免构建）
    export default {
      setup() {
        const { h, ref } = window.SiErXingUI.vue;   // ⚠️ 不要从 'vue' 裸导入
        const n = ref(0);
        return () => h('div', { class: 'page' }, [
          h('h1', null, '我的主页'),
          h('button', { class: 'btn', onClick: () => n.value++ }, '点我 ' + n.value)
        ]);
      }
    };

    // ② ESM + 自己接管 DOM
    export function mount(root, ctx) {
      root.innerHTML = '<h1>你好</h1>';
      return function unmount() { root.innerHTML = ''; };
    }

③ 老契约（继续支持）：window.SXUIPlugin[page] = { mount(host), render() }。

宿主桥（只有用户装了 Vue 插件才按需加载 /ui-dist/uihost.js）：

| 全局 | 内容 |
|---|---|
| window.SiErXingUI.api | 契约版本 sierxing.ui/1 |
| window.SiErXingUI.vue | h / ref / reactive / computed / watch / createApp / nextTick / onMounted… |
| window.SiErXingUI.toast | 宿主轻提示 |
| window.SiErXingUI.host | 当前页面宿主依赖（api / go / state / esc / fmtDate / mdToHTML …） |

ctx（mount 第二参）：{ page, manifest, host, api, toast, esc, go, state, fmtDate, mdToHTML, vue }。

行为与安全：
- 覆盖优先级：用户插件（且未停用）＞ 内置插件 ＞ 原版 render*；
- 用户插件任何异常 → console.warn + 静默回退内置界面（不白屏、不刷 toast）；
- 用户插件实例在离开该路由时自动卸载（不残留监听/定时器）；
- 停用 = POST /api/ui/plugins/<id>/state { enabled: false }（写 DATA_DIR/ui-plugins/.state.json，
  不删文件、随时恢复）；ui.userPlugins=false 可整体忽略用户插件；
- 管理页：#/ui-plugins（左栏「界面管理」）：内置/用户/已停用、启停、看内置版、打开目录、内核自检；
- 用户插件不参与 test:parity 像素回归（那是内置界面的验收）。

---

## 6. 升级不冲突的六条机制

1. 目录隔离：用户插件/配置只在 DATA_DIR，程序更新只替换 server/、public/、ui/、config/；
2. 只覆盖、不修改：用户层只写要改的键/页面，我们改内置实现，用户层不用跟着改；
3. apiVersion 主版本：不一致 → 插件 incompatible 不执行（不是崩溃）；
4. 依赖缺失 → 跳过：服务端插件缺依赖只记录原因；
5. 配置键移除 → 孤儿告警：旧 user.json 里被删的键只告警、不生效、也不阻断；
6. 失败回退：页面插件异常 → 内置界面；加载失败 → 内置；配置坏了 → 默认值。
   再加升级快照 diff（键/插件增删）+ strictConfig 显式开关。

边界（有意为之）：内核启动器 + 容器 + 数据目录约定不可替换（否则没有锚点）；
用户页面只拥有内容区 #app，左栏/页头/AI 抽屉/主题/toast/路由仍是宿主，
保证我们的更新能到达所有用户。

---

## 7. 验收

    npm run test:kernel          # 内核 22 项（服务/依赖/兼容/生命周期/迁移/事件）
    npm run test:kernel-config   # 分层配置 16 项（覆盖/容错/升级差异/来源）
    node scripts/test-user-vue-page.js  # 用户插件端到端 23 项（Vue/mount/停用回退/管理页）
    node scripts/test-kernel-live.js    # 分层配置端到端 16 项（总开关/皮肤/快照/第二次启动）
    npm run test:ui              # 204 + 7 项既有 UI 单测
    npm run test:mount           # 13 条路由「确由插件接管」
    npm run test:dom             # 12 条路由 DOM 骨架一致
    npm run test:parity          # 21 条路由像素一致

---

## 8. 没做的部分（P4 边界）

- 内核瘦身：server.js / app.js 仍是单体，服务只是「注册」而非「搬出」；
  「内核也能改」目前指能力可替换 + 配置可覆盖，不是内核代码本身可热插拔。
- 用户服务端插件仍是进程内全权限（能读密钥/删库）：本地应用按「自己装自己负责」处理，
  没有沙箱；服务端组件的安装/审批仍走 component pipeline。
- .vue 源码不能直接放进去跑：要么用免构建 ESM 组件（examples/ui-plugins/home），
  要么自己用 Vite 构建后放 index.js。
