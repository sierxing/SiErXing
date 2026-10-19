/* 示例用户插件：运行时 ESM，不需要构建。
   它只依赖宿主注入的 window.SiErXingUI（Vue h/render），不 import 裸模块。 */
export default {
  name: 'DemoCardUser',
  props: { host: { type: Object, default: () => ({}) } },
  setup(props) {
    /* 宿主安装好 window.SiErXingUI 之后这里才执行，避免模块顶层就去取值 */
    const { h } = window.SiErXingUI.vue;
    return () => h('section', { style: 'border:1px solid #b7e1c4;border-radius:12px;padding:18px;background:#f5fff8;' }, [
      h('div', { style: 'display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#d9f7e3;color:#1f8b4c;margin-bottom:8px;' }, '用户插件'),
      h('h2', { style: 'margin:4px 0 8px;font-size:20px;' }, '用户覆盖版 · 目标节奏卡片'),
      h('p', { style: 'color:#52605a;line-height:1.6;' }, '这个卡片来自用户插件目录，加载失败会回退到内置 .vue 版本。'),
      h('dl', { style: 'display:grid;gap:6px;margin:12px 0 0;font-size:14px;color:#334;' }, [
        h('div', null, [h('dt', { style: 'display:inline;color:#777;' }, '来源'), h('dd', { style: 'display:inline;margin-left:8px;' }, 'public/ui-plugins/demo-card/index.js')]),
        h('div', null, [h('dt', { style: 'display:inline;color:#777;' }, '宿主 API'), h('dd', { style: 'display:inline;margin-left:8px;' }, props.host.api)])
      ])
    ]);
  }
};
