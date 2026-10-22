'use strict';
/**
 * 「AI 助手能读到当前页面」的提示词块回归：node --no-warnings scripts/test-page-context.js
 *
 * 为什么留：这是「一百个组件各写一套 AI 问答」收敿成一个助手的**唯一前提** ——
 * 助手得知道用户此刻在看什么。三件事最容易坏：
 *   ① 页面文字不做预算就塞进提示词（资料库页几万字，把路线图和历史对话挤没）；
 *   ② 客户端伪造/超长输入没被服务端挡住；
 *   ③ 「用户说'这个'指的就是这一页」这句约束丢了，模型又开始反问"哪道题"。
 *
 * 纯函数、零依赖、秒级，不需要服务。
 */
const assert = require('node:assert');
const pc = require('../server/prompts/page-context.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

T('没有页面内容时返回 null（不占篇幅）', () => {
  assert.strictEqual(pc.pageContextBlockFrom(null), null);
  assert.strictEqual(pc.pageContextBlockFrom({}), null);
  assert.strictEqual(pc.pageContextBlockFrom({ label: '随堂测验', text: '' }), null);
  assert.strictEqual(pc.pageContextBlockFrom({ text: '   \n\n  ' }), null);
});

T('短到没信息量的页面不占篇幅', () => {
  assert.strictEqual(pc.pageContextBlockFrom({ text: '加载中' }), null);
  // 有标题就算有内容（页面刚渲染完、正文还没出来时也有意义）
  assert.ok(pc.pageContextBlockFrom({ label: '随堂测验', title: '知识点 3/8' }));
});

T('正常页面：带上页面名、标题、路由与正文', () => {
  const text = '第 3 题：下面哪个是 HTTP 状态码？\nA 200\nB 404\nC 500';
  const r = pc.pageContextBlockFrom({ label: '随堂测验', title: '知识点 3/8', route: '#/t/142/quiz', text });
  assert.ok(r, '应当生成块');
  assert.strictEqual(r.label, '随堂测验');
  assert.ok(r.text.includes('【用户当前正在看的页面】'));
  assert.ok(r.text.includes('随堂测验'));
  assert.ok(r.text.includes('知识点 3/8'));
  assert.ok(r.text.includes('#/t/142/quiz'));
  assert.ok(r.text.includes('B 404'), '正文必须在');
  assert.strictEqual(r.cut, 0);
});

T('提示词里写清「这个 / 这里」指的是这一页，并禁止编造', () => {
  const r = pc.pageContextBlockFrom({ label: '随堂测验', text: 'x'.repeat(100) });
  assert.ok(r.text.includes('这个'), r.text);
  assert.ok(r.text.includes('当前页面') || r.text.includes('这一页'), r.text);
  assert.ok(r.text.includes('不要凭空补') || r.text.includes('没看到'), r.text);
});

T('超长页面按预算掐中间、保留头尾，并说明省略了多少字', () => {
  /* 注意：body 要小于服务端输入硬上限（PAGE_TEXT_INPUT_MAX），否则尾部的 -TAIL
     会先被输入截断掉 —— 那验的就不是"预算掐中间"了。 */
  const body = 'HEAD-' + 'a'.repeat(12000) + '-TAIL';
  const r = pc.pageContextBlockFrom({ label: '资源库', text: body });
  assert.ok(r, '应当生成块');
  assert.ok(r.chars > pc.PAGE_TEXT_BUDGET, '原始字数要如实报');
  assert.ok(r.cut > 0, '应当记录掐掉的字数');
  assert.ok(r.text.includes('中间省略'), r.text.slice(0, 200));
  assert.ok(r.text.includes('HEAD-'), '头要留');
  assert.ok(r.text.includes('-TAIL'), '尾要留');
  /* 真正塞进提示词的正文不能超过预算太多（另加标题行等固定文字） */
  assert.ok(r.text.length < pc.PAGE_TEXT_BUDGET + 800, '块体积失控：' + r.text.length);
});

T('服务端硬上限：超长输入被截断（客户端不可信）', () => {
  const huge = 'b'.repeat(pc.PAGE_TEXT_INPUT_MAX + 5000);
  const s = pc.sanitizePageContext({ text: huge });
  assert.strictEqual(s.text.length, pc.PAGE_TEXT_INPUT_MAX);
});

T('字段清洗：去零宽字符 / 折行 / 压空白 / 各字段限长', () => {
  const s = pc.sanitizePageContext({
    label: '  随堂\n测验  ', title: ' 知识点  3/8 ', route: '#/t/1/quiz',
    text: 'a\u200b b\r\n\r\n\r\n\r\nc   \n'
  });
  assert.strictEqual(s.label, '随堂 测验');
  assert.strictEqual(s.title, '知识点 3/8');
  assert.ok(!s.text.includes('\u200b'));
  assert.ok(!/\n{3,}/.test(s.text));
  const long = pc.sanitizePageContext({ label: 'x'.repeat(300), title: 'y'.repeat(400), route: 'z'.repeat(400), text: 'hi' });
  assert.ok(long.label.length <= 60 && long.title.length <= 160 && long.route.length <= 200);
});

T('非对象输入一律安全返回 null（不抛）', () => {
  for (const v of [undefined, null, 0, '', 'page', [], true]) {
    assert.strictEqual(pc.sanitizePageContext(v), null, '输入：' + JSON.stringify(v));
  }
});

T('tidyPageText 去掉纯分隔符行与行尾空白', () => {
  const s = pc.tidyPageText('标题   \n---\n\n\n\n正文');
  assert.ok(!/^---$/m.test(s), s);
  assert.ok(!/ +\n/.test(s), s);
  assert.ok(s.includes('正文'));
});

T('DOM 骨架：正文为空也能用（创造模式靠它拿真实选择器），服务端限量', () => {
  const dom = Array.from({ length: 500 }, function (_, i) { return '<div class="row"><span id="n' + i + '">'; }).join('');
  const s = pc.sanitizePageContext({ label: '目标页', dom: dom });
  assert.ok(s && s.dom, '有 DOM 就不该返回 null');
  assert.ok(s.dom.length <= pc.PAGE_DOM_INPUT_MAX, 'DOM 必须限量：' + s.dom.length);
  assert.ok(s.dom.indexOf('<div') >= 0);
  const blk = pc.pageContextBlockFrom({ label: '目标页', dom: '<main id="app"><button data-act="go">x</button></main>' });
  assert.ok(blk && blk.dom, '只有 DOM 也应产生上下文块');
  assert.ok(blk.text.indexOf('目标页') >= 0);
});
console.log('\n' + n + ' 项全部通过');
