'use strict';
/**
 * 搜索 API 抽象层回归（纯本地、不联网、不花钱）：
 *   node --no-warnings scripts/test-search-api.js
 * 覆盖：结果归一化 / 地址拼装 / 配置读取 / DeepSeek 真实请求格式 /
 *       调用失败回落内置搜索 / 设置页「测试搜索」成功与失败。
 */
const assert = require('node:assert');
const http = require('node:http');
const api = require('../server/search-api.js');

let n = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra ? ' => ' + JSON.stringify(extra) : ''));
  console.log('  ✓ ' + name);
  n++;
}

/* ---------- 1. 结果归一化 ---------- */
{
  const items = api.normalizeItems({
    results: [
      {
        rerank_score: 2.4, title: 'DeepSeek V4 发布', url: 'https://example.com/a',
        snippet: '短摘要', summary: '长摘要', content: '正文内容', site_name: 'Example',
        date: '2026-06-01T00:00:00+00:00', authority: 3
      },
      { title: '重复地址', url: 'https://example.com/a' },
      { title: '不是网页', url: 'javascript:alert(1)' },
      { name: 'OpenAI 风格', link: 'https://example.org/b', description: '描述', published_at: '2026-05-02' }
    ]
  });
  ok('归一化：只保留合法 http(s) 且按 url 去重', items.length === 2, items.map(x => x.url));
  ok('归一化：标题/摘要/正文/站点/时间都取到', items[0].title === 'DeepSeek V4 发布' && items[0].snippet === '短摘要'
    && items[0].content === '正文内容' && items[0].site === 'Example' && items[0].date > 0);
  ok('归一化：兼容 name/link/description/published_at', items[1].title === 'OpenAI 风格' && items[1].url === 'https://example.org/b'
    && items[1].snippet === '描述' && items[1].date > 0);
  const arr = api.normalizeItems([{ title: 'A', url: 'https://a.com/x' }]);
  ok('归一化：裸数组也认', arr.length === 1);
  const organic = api.normalizeItems({ organic_results: [{ title: 'B', link: 'https://b.com/y', snippet: 's' }] });
  ok('归一化：Serper 风格 organic_results 也认', organic.length === 1 && organic[0].title === 'B');
  const nested = api.normalizeItems({ data: { results: [{ title: 'C', url: 'https://c.com/z' }] } });
  ok('归一化：data.results 嵌一层也认', nested.length === 1);
}

/* ---------- 2. 地址拼装 ---------- */
{
  ok('地址：DeepSeek 默认补 /v1/tools/search', api.endpointOf('deepseek', '') === 'https://api.deepseek.com/v1/tools/search');
  ok('地址：DeepSeek 自定义 base 也补路径', api.endpointOf('deepseek', 'https://proxy.local/') === 'https://proxy.local/v1/tools/search');
  ok('地址：完整接口地址原样使用', api.endpointOf('deepseek', 'https://proxy.local/v1/tools/search') === 'https://proxy.local/v1/tools/search');
  ok('地址：自定义完整地址不补路径', api.endpointOf('custom', 'https://search.local/api/search') === 'https://search.local/api/search');
  ok('地址：自定义只给域名才补默认路径', api.endpointOf('custom', 'search.local') === 'https://search.local/v1/tools/search');
}

/* ---------- 3. 配置读取（默认内置 / 指定 API / 条数夹紧） ---------- */
function withSettings(map) {
  api.init({
    getSetting: function (k, d) { return map[k] != null ? map[k] : d; },
    builtin: map.__builtin,
    log: function () {}
  });
}
{
  withSettings({});
  let c = api.config();
  ok('配置：没指定时走内置搜索', c.provider === 'builtin' && c.ready === true && c.endpoint === '');
  ok('配置：没指定时不读密钥', c.key === '' && c.keySource === '');
  ok('配置：默认条数 20', c.count === 20 && c.content === true);
  withSettings({ search_provider: 'deepseek', search_api_count: '999', search_api_content: '0' });
  c = api.config();
  ok('配置：指定 DeepSeek 后 endpoint/条数夹紧/正文开关生效',
    c.provider === 'deepseek' && c.endpoint === 'https://api.deepseek.com/v1/tools/search'
    && c.count === 50 && c.content === false && c.ready === true);
  withSettings({ search_provider: 'custom' });
  c = api.config();
  ok('配置：自定义但没填地址 → 未就绪', c.provider === 'custom' && c.ready === false);
  withSettings({ search_provider: '乱写' });
  ok('配置：未知 provider 按内置处理', api.config().provider === 'builtin');
  withSettings({ search_provider: 'deepseek', search_api_key: 'sk-test' });
  c = api.config();
  ok('配置：已存密钥被读到且来源为 setting', c.key === 'sk-test' && c.keySource === 'setting' && api.status().has_key === true);
  ok('状态回显：has_key=true 但不回传密钥明文', api.status().key === undefined
    && api.status().provider === 'deepseek' && JSON.stringify(api.status()).indexOf('sk-test') < 0);
}

/* ---------- 4. 假搜索 API 服务 ---------- */
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body: parsed });
    if (req.url === '/v1/tools/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        results: [
          { title: '结果一', url: 'https://example.com/1', snippet: '摘要一', summary: '长摘要一', content: '正文一', date: '2026-06-01T00:00:00+00:00' },
          { title: '结果二', url: 'https://example.com/2', summary: '长摘要二' }
        ]
      }));
    }
    if (req.url === '/custom/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ name: '自定义结果', link: 'https://example.org/c', description: '来自自定义接口' }]));
    }
    if (req.url === '/boom') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '额度不足', type: 'invalid_request_error' } }));
    }
    res.writeHead(404); res.end('{}');
  });
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
  const port = await listen(fake);
  const base = 'http://127.0.0.1:' + port;

  /* 5. DeepSeek 请求格式 + 结果归一化 */
  {
    calls.length = 0;
    let builtinCalled = 0;
    withSettings({
      search_provider: 'deepseek', search_api_base: base, search_api_key: 'sk-x',
      search_api_count: '12', search_api_content: '1',
      __builtin: async () => { builtinCalled++; return []; }
    });
    const r = await api.search('DeepSeek V4', { days: 30 });
    ok('DeepSeek：返回体归一化成 2 条', r.provider === 'deepseek' && r.items.length === 2 && r.fallback === false, r);
    ok('DeepSeek：请求打到 /v1/tools/search（POST + Bearer）', calls.length === 1 && calls[0].url === '/v1/tools/search'
      && calls[0].method === 'POST' && calls[0].auth === 'Bearer sk-x', calls[0]);
    ok('DeepSeek：请求体 query/count/need_content 正确', calls[0].body.query === 'DeepSeek V4'
      && calls[0].body.count === 12 && calls[0].body.need_content === true, calls[0].body);
    ok('DeepSeek：内容字段带回来（可省一次抓取）', r.items[0].content === '正文一' && r.items[0].snippet === '摘要一');
    ok('DeepSeek：成功时不调用内置搜索', builtinCalled === 0);
  }

  /* 6. 自定义兼容接口（完整 URL，裸数组响应） */
  {
    calls.length = 0;
    withSettings({
      search_provider: 'custom', search_api_base: base + '/custom/search', search_api_key: 'k',
      __builtin: async () => []
    });
    const r = await api.search('随便搜');
    ok('自定义接口：裸数组也能归一化', r.provider === 'custom' && r.items.length === 1 && r.items[0].title === '自定义结果');
    ok('自定义接口：地址就是用户填的完整 URL', calls[0].url === '/custom/search');
  }

  /* 7. 调用失败 → 回落内置搜索 */
  {
    let builtinArgs = null;
    withSettings({
      search_provider: 'custom', search_api_base: base + '/boom', search_api_key: 'k',
      __builtin: async (q, count, days) => { builtinArgs = { q, count, days }; return [{ title: '内置结果', url: 'https://builtin.example/1', snippet: '内置' }]; }
    });
    const r = await api.search('失败回退', { count: 9, days: 60 });
    ok('回落：失败后 provider=builtin 且 fallback=true', r.provider === 'builtin' && r.fallback === true, r);
    ok('回落：错误码是 http，detail 带接口原文', r.fallbackCode === 'http' && /额度不足/.test(r.fallbackDetail), r);
    ok('回落：内置搜索拿到了结果', r.items.length === 1 && r.items[0].title === '内置结果');
    ok('回落：把搜索词/条数/时效透传给内置搜索', builtinArgs.q === '失败回退' && builtinArgs.count === 9 && builtinArgs.days === 60, builtinArgs);
  }

  /* 8. 指定了 provider 但没填地址 → 回落内置 */
  {
    withSettings({ search_provider: 'custom', __builtin: async () => [{ title: '兜底', url: 'https://x.example/1' }] });
    const r = await api.search('没有地址');
    ok('地址为空：回落内置且错误码为 no_endpoint', r.provider === 'builtin' && r.fallback === true && r.fallbackCode === 'no_endpoint', r);
  }

  /* 9. 内置搜索路径（没配 API）不产生 HTTP 请求 */
  {
    calls.length = 0;
    withSettings({ __builtin: async () => [{ title: '内置', url: 'https://y.example/1' }] });
    const r = await api.search('内置搜索');
    ok('内置：provider=builtin、不回落、不请求外部', r.provider === 'builtin' && r.fallback === false && r.items.length === 1 && calls.length === 0);
  }

  /* 10. 设置页「测试搜索」 */
  {
    withSettings({ __builtin: async () => [{ title: '内置样例', url: 'https://z.example/1' }] });
    const good = await api.test({ provider: 'deepseek', base: base, apiKey: 'sk-t', count: 3 });
    ok('测试：成功返回 ok + 样例', good.ok === true && good.provider === 'deepseek' && good.items.length > 0, good);
    const bad = await api.test({ provider: 'custom', base: base + '/boom', apiKey: 'k' });
    ok('测试：失败返回 ok=false + code/detail（不回落）', bad.ok === false && bad.code === 'http'
      && /额度不足/.test(bad.detail) && bad.status === 500, bad);
    const builtinTest = await api.test({ provider: 'builtin' });
    ok('测试：内置搜索也测得出样例', builtinTest.ok === true && builtinTest.items[0].title === '内置样例');
  }

  fake.close();
  console.log('\n' + n + ' 项全部通过');
})().catch(e => { try { fake.close(); } catch (x) {} console.error(e); process.exit(1); });
