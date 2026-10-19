/* 示例用户页面插件：整页接管「首页」。
   安装：把本目录复制到 <数据目录>/ui-plugins/home/，刷新页面即可。
   只依赖宿主注入的 window.SiErXingUI（Vue），不要 import 'vue'，也不需要构建。
   删掉这个目录（或在「界面管理」页停用）就恢复内置首页。 */
export default {
  name: 'MyHomePage',
  props: {
    host: { type: Object, default: function () { return {}; } },
    page: { type: String, default: 'home' }
  },
  setup(props) {
    const { h, ref, onMounted } = window.SiErXingUI.vue;
    const count = ref(0);
    const goalCount = ref(null);
    const box = {
      maxWidth: '780px', margin: '36px auto', padding: '26px',
      background: '#fff', border: '1px solid #e6e9ef', borderRadius: '16px',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    };
    const btn = {
      padding: '8px 14px', borderRadius: '8px', border: '1px solid #cfd8e6',
      background: '#fff', cursor: 'pointer', fontSize: '14px'
    };
    onMounted(async function () {
      try {
        const r = await props.host.api('/api/goals');
        goalCount.value = (r && r.goals ? r.goals.length : 0);
      } catch (e) { goalCount.value = -1; }
    });
    return function () {
      return h('section', { class: 'page', style: box }, [
        h('div', {
          style: 'display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#e8f3ff;color:#1a6dd6;margin-bottom:10px'
        }, '用户插件 · home'),
        h('h1', { style: 'margin:0 0 8px;font-size:26px' }, '我的主页'),
        h('p', { style: 'color:#5b6472;line-height:1.7;margin:0 0 18px' },
          '这个页面完全由 DATA_DIR/ui-plugins/home/index.js 渲染。思而行升级只替换内置层，不会动它；删掉就恢复内置首页。'),
        h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
          h('button', { style: btn, onClick: function () { count.value++; } }, '点我：' + count.value),
          h('button', { style: btn, onClick: function () { props.host.go('#/settings'); } }, '去设置页'),
          h('span', { style: 'color:#8a93a3;font-size:13px' },
            goalCount.value === null ? '正在读目标…'
              : (goalCount.value >= 0 ? '目标数：' + goalCount.value : '读目标失败（接口可能还没好）'))
        ])
      ]);
    };
  }
};
