'use strict';
/**
 * 正文清洗（text-clean）回归：`node scripts/test-text-clean.js`
 *
 * 为什么留：清洗最容易出两类事故 —— ①清不干净（垃圾照样进检索）；②清太狠
 * （把正文也删了，用户看到的资料是空的）。这里两类都验：垃圾必须走、真内容必须留。
 * 纯文本、零依赖、秒级。
 */
const assert = require('node:assert');
const tc = require('../server/text-clean.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

/* 一个典型的"内容页"HTML：导航 + 面包屑 + 正文 + 相关阅读 + 公众号 + 页脚 */
const PAGE = `<!DOCTYPE html><html><head><title>AI 产品经理实习面经</title>
<meta property="article:published_time" content="2026-10-01"></head><body>
<header class="site-header"><div class="nav"><a href="/">首页</a><a href="/jobs">岗位</a><a href="/about">关于我们</a></div></header>
<nav class="breadcrumb">首页 &gt; 面经 &gt; AI 产品经理</nav>
<div class="ad-banner">广告：AI 产品经理就业班，包就业，免费试听，报名咨询加微信</div>
<div class="article-content">
  <h1>AI 产品经理实习面经（一面到 HR 面）</h1>
  <p>先说结论：一轮技术面 + 一轮业务面 + 一轮 HR 面。技术面问 RAG 的召回与重排。</p>
  <p>面试官让我把 MCP 和 Function Calling 的区别讲清楚，我按"边界/角色/复用"三段回答。</p>
  <pre>npm run dev
curl -X POST http://localhost:3000/api/mcp</pre>
  <p>HR 面主要问实习时长与到岗时间，如实回答即可。</p>
</div>
<div class="related-posts"><h3>相关阅读</h3><ul>
  <li><a href="/a">AI 产品经理简历怎么写</a></li><li><a href="/b">产品经理面试题库</a></li><li><a href="/c">2026 秋招时间表</a></li>
</ul></div>
<div class="comment-box"><p>网友评论</p><p>沙发</p><p>作者写得真好，收藏了</p></div>
<div class="side-tags"><span>标签</span><span>面经</span><span>实习</span><span>秋招</span><span>简历</span><span>求职</span></div>
<footer class="site-footer"><p>© 2026 某某网 版权所有 | 京ICP备12345678号-1</p><p>关注公众号"AI 求职指南"，回复"资料"领取礼包</p><p>商务合作：bd@example.com</p></footer>
</body></html>`;

console.log('提取与清洗：');
T('正文留下（三段正文 + 代码块都在）', () => {
  const r = tc.extractText(PAGE);
  assert.ok(r.text.includes('先说结论：一轮技术面'));
  assert.ok(r.text.includes('MCP 和 Function Calling 的区别'));
  assert.ok(r.text.includes('npm run dev'));
  assert.ok(r.text.includes('HR 面主要问实习时长'));
});
T('导航/面包屑/广告/相关阅读/评论/页脚/ICP 全被去掉', () => {
  const r = tc.extractText(PAGE);
  for (const bad of ['关于我们', '首页 > 面经', '包就业', '相关阅读', '简历怎么写', '沙发', '版权所有', 'ICP备', '关注公众号', '商务合作']) {
    assert.ok(!r.text.includes(bad), '不该出现：' + bad);
  }
});
T('代码块里的空行与缩进不动', () => {
  const r = tc.extractText('<div class="content"><pre>npm run dev\n\ncurl -X POST http://x</pre></div>');
  assert.ok(r.text.includes('npm run dev\n\ncurl -X POST'));
});
T('输出比输入短，且给出"去掉多少"', () => {
  const r = tc.extractText(PAGE);
  assert.ok(r.after < r.before, r.before + ' → ' + r.after);
  assert.ok(/去掉 \d+ 字/.test(tc.deltaText('x'.repeat(100), 'x'.repeat(60))));
});

console.log('行级清洗：');
T('纯链接行 / 只有一条网址的行 → 丢', () => {
  const r = tc.cleanLines('正文一句话，讲清是怎么回事。\nhttps://example.com/a\n阅读原文 https://example.com/b');
  assert.ok(!/example\.com/.test(r.text));
  assert.ok(r.text.includes('正文一句话'));
});
T('连续三行以上的短菜单行 → 丢（标签云/菜单）', () => {
  const r = tc.cleanLines('正文段落，这里讲的是关键机制与判断标准。\n标签\n面经\n实习\n秋招\n后面这段是正文，继续讲边界条件与注意事项。');
  assert.ok(!/面经/.test(r.text) || r.text.includes('正文段落'));
  assert.ok(r.text.includes('后面这段是正文'));
});
T('重复出现 3 次以上的同一行 → 只留前两次', () => {
  const r = tc.cleanLines('正文开头的句子，说明这条资料的结构。\n本文地址：http://x.com/1\n正文中段，讲方法。\n本文地址：http://x.com/1\n正文末段，讲结论。\n本文地址：http://x.com/1\n本文地址：http://x.com/1');
  const cnt = (r.text.match(/本文地址/g) || []).length;
  assert.ok(cnt <= 2, '出现了 ' + cnt + ' 次');
});
T('页码行（第 3 页 / 共 5 页 / Page 2 of 5）→ 丢', () => {
  const r = tc.cleanLines('正文第一段，内容有效。\n第 3 页 / 共 5 页\n继续正文第二段，仍然有效。');
  assert.ok(!/共 5 页/.test(r.text));
});
T('英文页脚（Copyright / All Rights Reserved / Follow us）→ 丢', () => {
  const r = tc.cleanLines('This section explains the retry policy in detail.\nCopyright 2026 Example Inc. All Rights Reserved.\nFollow us on Twitter\nRead more about it at example.com');
  assert.ok(!/All Rights Reserved/.test(r.text) && !/Follow us/.test(r.text));
  assert.ok(r.text.includes('retry policy'));
});
T('清得太狠（正文几乎没了）→ 退回基本清洗，不交空壳', () => {
  const onlyJunk = '关注公众号\n扫码\n广告\n报名咨询\n联系我们\n版权所有\nICP备1号\n客服\n登录\n注册';
  const r = tc.cleanLines(onlyJunk, { minChars: 40 });
  assert.equal(r.fallback, true);
  assert.ok(r.text.length > 0);
});

console.log('实体解码（网页标点/符号）：');
T('十六进制实体必须解（CSDN 的全角标点就是 &#xff0c;）', () => {
  const r = tc.htmlToText('<p>随着AI技术迭代&#xff0c;Agent产品成为行业新热点&#xff1a;真香&#x3002;</p>');
  assert.ok(r.includes('迭代，Agent'), r);
  assert.ok(r.includes('新热点：真香。'), r);
  assert.ok(!/&#x/i.test(r), '不该残留十六进制实体：' + r);
});
T('十进制实体照旧解（&#39; / &#12290;）', () => {
  const r = tc.htmlToText('<p>it&#39;s ok&#12290;下一句。</p>');
  assert.ok(r.includes("it's ok。"), r);
});
T('常用命名实体解掉（nbsp / mdash / hellip / middot / copy）', () => {
  const r = tc.htmlToText('<p>A&nbsp;B&mdash;C&hellip;D&middot;E&copy;2026</p>');
  assert.ok(r.includes('A B'), r);
  assert.ok(r.includes('—') && r.includes('…') && r.includes('·') && r.includes('©'), r);
});
T('认不出的实体原样保留，不许吃掉读者正文', () => {
  const r = tc.htmlToText('<p>公式 &foobar; 与 & 符号都要在。</p>');
  assert.ok(r.includes('&foobar;'), r);
  assert.ok(r.includes('& 符号'), r);
});
T('`&amp;lt;` 只解一层（讲 HTML 转义的教程不能被改坏）', () => {
  const r = tc.htmlToText('<p>写 &amp;lt;div&amp;gt; 就会渲染成一个 div 标签。</p>');
  assert.ok(r.includes('&lt;div&gt;'), r);
  assert.ok(!r.includes('<div>'), '不该连解两层：' + r);
});
T('代码块里的实体也解（与浏览器所见一致）', () => {
  const r = tc.extractText('<div class="content"><pre>print("a&#xff0c;b")</pre></div>');
  assert.ok(r.text.includes('print("a，b")'), r.text);
});
T('畸形/越界的实体不许抛异常', () => {
  for (const bad of ['&#x110000;', '&#0;', '&#99999999999;', '&#x;', '&#;', '&#xg;']) {
    const r = tc.htmlToText('<p>x' + bad + 'y</p>');
    assert.ok(r.includes('x') && r.includes('y'), bad + ' → ' + r);
  }
});

console.log('反爬挑战页（"正文"其实是脚本）：');
T('整块丢掉 <script>，不让脚本正文漏进资料（含"看着不像 HTML"那条路）', () => {
  /* 真实翻车：51CTO 给非浏览器请求回 988 字节的纯 <script> 挑战页，
     正文只有一个 script —— 只删标签的话，它就成了"正文"进库。 */
  const challenge = '<script>function a(a){function n(){for(var a={wQzOV:_0x649a("0x4")};}return n}</script>';
  assert.equal(tc.htmlToText(challenge).trim(), '', '标签删了、脚本内容却留下了');
  assert.equal(tc.extractText(challenge).text.trim(), '');
  const withNav = '<div class="nav">首页</div><script>var x=1;alert(1)</script><p>正文一句话，讲得很清楚。</p>';
  const r = tc.extractText(withNav);
  assert.ok(r.text.includes('正文一句话'), r.text);
  assert.ok(!r.text.includes('alert'), '脚本内容漏进正文：' + r.text);
});
T('讲 HTML 的教程里 `&lt;script&gt;` 是文字，不许被当成脚本删掉', () => {
  const r = tc.htmlToText('<div class="content"><p>写 &lt;script&gt; 标签时要注意闭合。</p></div>');
  assert.ok(r.includes('<script> 标签'), r);
});
T('looksLikeChallenge：成片 _0x 混淆代码 → 命中', () => {
  assert.equal(tc.looksLikeChallenge('var a=_0x649a("0x4");var b=_0x1f2e("0x5");function n(){return _0x30ab;}'), true);
  assert.equal(tc.looksLikeChallenge('<script>function a(a){_0x649a("0x4")}</script>'), false, '只出现一次不该判');
});
T('looksLikeChallenge：正常资料（哪怕在讲 JS/变量名）不许误判', () => {
  assert.equal(tc.looksLikeChallenge('本文讲 JavaScript 的变量提升：var a = 1 会提升到作用域顶部。'), false);
  const page = tc.extractText(PAGE).text;
  assert.equal(tc.looksLikeChallenge(page), false);
});

console.log('AI 清洗的契约（只删不改）：');
T('提示词写清"只删不改 + 代码原样 + 不许新增"，并要求整段废话回 EMPTY', () => {
  const p = tc.buildCleanPrompt('某资料', '找到 AI 产品经理实习', '正文……');
  assert.ok(/一个字都不许改写/.test(p));
  assert.ok(/代码块/.test(p) && /原样保留/.test(p));
  assert.ok(/EMPTY/.test(p));
  assert.ok(p.includes('<<<TEXT_START>>>'));
});
T('模型把整篇用 ``` 包起来 → 剥掉', () => {
  const r = tc.parseCleanOutput('```markdown\n这是清洗后的正文，内容是原文里的句子。\n```', '这是清洗后的正文，内容是原文里的句子。\n还有别的');
  assert.ok(r.ok && r.text.includes('清洗后的正文'));
});
T('模型回 EMPTY（整段都是废话）→ 认', () => {
  const r = tc.parseCleanOutput('EMPTY\n', '导航 广告 推荐');
  assert.ok(r.empty && r.ok);
});
T('保险①：输出不是原文里的句子（疑似改写/编造）→ 拒收，保留本地清洗版', () => {
  const r = tc.parseCleanOutput('这是一段模型自己编的内容，原文里根本没有这句话，长度也够长。\n第二句同样是自己编的，原文里也找不到哦。', '原文只有这一句话。');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'output-not-from-source');
});
T('保险②：输出比输入还长 → 拒收', () => {
  const src = '短原文一句话。';
  const r = tc.parseCleanOutput('这是一段比原文长很多的输出。'.repeat(20), src);
  assert.equal(r.ok, false);
});
T('切块：长文按段落切成 ≤4 块，短文不折腾', () => {
  assert.equal(tc.aiChunks('很短的一句话').length, 0);
  const long = Array.from({ length: 40 }, (_, i) => '第' + i + '段：' + '内容'.repeat(200)).join('\n\n');
  const cs = tc.aiChunks(long);
  assert.ok(cs.length >= 2 && cs.length <= tc.AI_MAX_CALLS, cs.length + ' 块');
  assert.ok(cs.every(c => c.length <= tc.AI_CHUNK * 1.2));
});

console.log('\n全部通过（' + n + ' 项）');
