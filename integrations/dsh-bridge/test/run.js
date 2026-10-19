#!/usr/bin/env node
/**
 * DSH 桥插件回归（不依赖 DSH 运行时）：
 *   · 假 ctx（webServer / llm）+ 真 http server，验证 OpenAI 兼容路由
 *   · 假思而行（只实现 /api/health 与 /api/host-agent/refresh），验证自动写入与刷新
 * 覆盖：模型目录、host-agent.json、鉴权、非流式、流式 SSE、dispose 清理。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { apply } from '../lib/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-dsh-bridge-'));
const TOKEN = 'test-token-123';

/* ---------- 假思而行：health + refresh ---------- */
let refreshCount = 0;
const fakeSierxing = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url === '/api/host-agent/refresh' && req.method === 'POST') {
    refreshCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mounted: true, models: ['x'] }));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => fakeSierxing.listen(0, '127.0.0.1', r));
const sxPort = fakeSierxing.address().port;

/* ---------- 假 DSH webServer：真 http server + 可注册路由 ---------- */
const routes = new Map();
const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const h = routes.get(pathname);
  if (!h) { res.writeHead(404); return res.end('not found'); }
  try { await h(req, res); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
const port = httpServer.address().port;
const webServer = {
  port,
  register(route) {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  }
};

/* ---------- 假 DSH llm ---------- */
const streamed = [];
const llm = {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: async (p) => (p === 'deepseek-official' ? [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text', 'image'] }
  ] : []),
  stream: async function* (opts) {
    streamed.push(opts);
    yield { type: 'text-delta', index: 0, text: '你好，' };
    yield { type: 'text-delta', index: 0, text: '我是假模型。' };
    yield { type: 'finish', reason: 'stop' };
  }
};

let dispose = null;
const ctx = {
  webServer,
  llm,
  effect(fn) { dispose = fn(); return { dispose }; }
};

apply(ctx, { sierxingUrl: 'http://127.0.0.1:' + sxPort, dataDir, token: TOKEN, name: 'DSH' });

const fp = path.join(dataDir, 'host-agent.json');
async function waitFile(ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('host-agent.json 没写出来');
}
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }
async function okAsync(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }
const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const url = 'http://127.0.0.1:' + port + '/sierxing/v1';

try {
  const file = await waitFile();
  ok('host-agent.json 写入正确（url/key/models/vision）', () => {
    assert.strictEqual(file.name, 'DSH');
    assert.strictEqual(file.url, 'http://127.0.0.1:' + port + '/sierxing/v1');
    assert.strictEqual(file.key, TOKEN);
    assert.deepStrictEqual(file.models, ['deepseek-official/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro']);
    assert.strictEqual(file.vision, 'deepseek-official/deepseek-v4-pro');
  });

  ok('已通知思而行 refresh', () => assert.ok(refreshCount >= 1, 'refresh 次数 ' + refreshCount));

  await okAsync('GET /models 返回模型目录', async () => {
    const r = await fetch(url + '/models', { headers: auth });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.deepStrictEqual(j.data.map(m => m.id), file.models);
    assert.strictEqual(j.data[0].owned_by, 'deepseek-official');
  });

  await okAsync('鉴权：无 token / 错 token 都 401', async () => {
    assert.strictEqual((await fetch(url + '/models')).status, 401);
    const bad = await fetch(url + '/models', { headers: { Authorization: 'Bearer nope' } });
    assert.strictEqual(bad.status, 401);
  });

  await okAsync('非流式 chat/completions 返回文本', async () => {
    const r = await fetch(url + '/chat/completions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'deepseek-official/deepseek-v4-flash', messages: [{ role: 'user', content: '在吗' }] })
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.object, 'chat.completion');
    assert.strictEqual(j.choices[0].message.content, '你好，我是假模型。');
    assert.strictEqual(streamed.at(-1).provider, 'deepseek-official');
    assert.strictEqual(streamed.at(-1).model, 'deepseek-v4-flash');
    assert.ok(streamed.at(-1).messages[0].content[0].text.includes('在吗'));
  });

  await okAsync('流式 chat/completions：SSE delta + [DONE]', async () => {
    const r = await fetch(url + '/chat/completions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'deepseek-official/deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: '在吗' }] })
    });
    assert.strictEqual(r.status, 200);
    assert.ok(String(r.headers.get('content-type')).includes('text/event-stream'));
    const text = await r.text();
    assert.ok(text.includes('你好，'), text.slice(0, 200));
    assert.ok(text.includes('data: [DONE]'), text.slice(-200));
    assert.ok(text.split('data:').length >= 3);
  });

  await okAsync('未知模型 404', async () => {
    const r = await fetch(url + '/chat/completions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'nope/nope', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.strictEqual(r.status, 404);
  });

  await okAsync('dispose：路由移除 + host-agent.json 删除', async () => {
    dispose();
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(fs.existsSync(fp), false);
    assert.strictEqual(routes.has('/sierxing/v1/models'), false);
    assert.strictEqual(routes.has('/sierxing/v1/chat/completions'), false);
  });

  console.log('\n' + pass + ' 项全部通过');
} finally {
  try { dispose && dispose(); } catch (e) {}
  await new Promise(r => httpServer.close(r));
  await new Promise(r => fakeSierxing.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
}
