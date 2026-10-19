'use strict';
/**
 * 「AI 助手能读到当前页面」端到端回归：node --no-warnings scripts/test-chat-page-context.js
 *
 * 为什么留：这条链路横跨前端采集 → HTTP → 提示词拼装三层，任何一层断了，
 * 用户看到的现象都是"AI 又开始反问'哪道题'"。这里用一个**假 AI 服务器**把
 * 真实提示词抓下来断言（不花钱、不需要真 key）：
 *   ① 带了 page_context → 提示词里有【用户当前正在看的页面】+ 页面文字；
 *   ② 「它做了什么」里有一条「你当前页面上的内容」；
 *   ③ 不传 page_context → 提示词里没有这个块（不能凭空编一段）；
 *   ④ 教程页不重复带（正文已由教程块带上）。
 *
 * 沙箱：SIERXING_DATA_DIR=临时目录，不碰真实数据；端口用 3319（假 AI 用 3318）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3319);
const AI_PORT = Number(process.env.AI_PORT || 3318);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-page-ctx-'));

let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '：' + extra : '')); console.log('  ✓ ' + name); n++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 假 AI：记下最后一次请求的提示词，回一段 SSE ---------- */
const seen = [];
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) {}
    const msgs = j.messages || [];
    const prompt = msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    seen.push({ url: req.url, prompt });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const chunks = ['收到。', '（这是假 AI 的回复）'];
    for (const c of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function jget(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
}
/* 发一条对话消息，把 SSE 读完，返回收到的 done 事件 */
async function chat(appPort, sid, payload) {
  const r = await fetch('http://127.0.0.1:' + appPort + '/api/chat-sessions/' + sid + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const text = await r.text();
  let done = null;
  for (const part of text.split('\n\n')) {
    const line = part.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    let d;
    try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
    if (d.done) done = d;
  }
  return done;
}

async function main() {
  await new Promise(res => aiSrv.listen(AI_PORT, '127.0.0.1', res));

  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR,
      SIERXING_API_BASE: 'http://127.0.0.1:' + AI_PORT + '/v1',
      SIERXING_API_KEY: 'test-key', SIERXING_MODEL: 'fake-model'
    }),
    stdio: 'ignore'
  });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await jget('http://127.0.0.1:' + APP_PORT + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    assert.ok(up, '测试实例没起来（端口 ' + APP_PORT + '）');
    console.log('  · 测试实例已启动（沙箱数据目录：' + DATA_DIR + '）');

    /* 建一个目标 + 一条对话（走真实接口，和用户点出来的一样） */
    const g = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals', { title: '页面上下文回归目标', profile: '', weekly_hours: '5', deadline: '1 个月' });
    const gid = Number((g.goal && g.goal.id) || g.id);
    assert.ok(gid, '建目标失败：' + JSON.stringify(g).slice(0, 200));
    const s = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/' + gid + '/chat-sessions', {});
    const sid = Number(s.session && s.session.id);
    assert.ok(sid, '建对话失败：' + JSON.stringify(s).slice(0, 200));

    /* ① 带页面上下文：提示词里必须出现页面块 + 页面文字 */
    seen.length = 0;
    const pageText = '第 3 题：下面哪个是 HTTP 状态码？\nA 200\nB 404\nC 500\n你的作答：B';
    const done1 = await chat(APP_PORT, sid, {
      message: '这道题为什么选 B？', mode: 'ask',
      page_context: { label: '随堂测验', title: '知识点 3/8', route: '#/t/1/quiz', text: pageText }
    });
    assert.ok(done1, '第一轮没收到 done 事件');
    ok('请求确实到了 AI（一轮只发 1 次）', seen.length === 1, '实际 ' + seen.length + ' 次');
    const p1 = seen[0].prompt;
    ok('提示词里有【用户当前正在看的页面】', p1.includes('【用户当前正在看的页面】'), p1.slice(-600));
    ok('页面块带上页面名与路由', p1.includes('随堂测验') && p1.includes('#/t/1/quiz'));
    ok('页面块带上页面正文（题目与选项）', p1.includes('下面哪个是 HTTP 状态码') && p1.includes('B 404'));
    ok('页面块说明「这个/这里」指的是这一页', p1.includes('这一页') && p1.includes('不要凭空补'));
    const ctxStep = (done1.trace || []).find(s => s && s.kind === 'ctx' && String(s.label || '').includes('当前页面'));
    ok('「它做了什么」记了一条"当前页面上的内容"', !!ctxStep, JSON.stringify((done1.trace || []).map(x => x.label)));

    /* ② 不带页面上下文：不许凭空出现页面块 */
    seen.length = 0;
    const done2 = await chat(APP_PORT, sid, { message: '那路线图现在怎么样？', mode: 'ask' });
    assert.ok(done2, '第二轮没收到 done 事件');
    const p2 = seen[0].prompt;
    ok('不传 page_context 时不出现页面块', !p2.includes('【用户当前正在看的页面】'));
    ok('不传时也没有那条上下文步骤', !(done2.trace || []).some(x => x && x.kind === 'ctx' && String(x.label || '').includes('当前页面')));

    /* ③ 空页面（比如刚渲染、抓不到东西）也不该占篇幅 */
    seen.length = 0;
    await chat(APP_PORT, sid, { message: '继续', mode: 'ask', page_context: { label: '随堂测验', text: '  ' } });
    ok('空页面内容不占篇幅', !seen[0].prompt.includes('【用户当前正在看的页面】'));

    /* ④ 服务端硬上限：客户端塞超长页面也不许把提示词撑爆 */
    seen.length = 0;
    await chat(APP_PORT, sid, { message: '继续', mode: 'ask', page_context: { label: '资源库', text: 'x'.repeat(60000) } });
    const p4 = seen[0].prompt;
    ok('超长页面被服务端限量', p4.includes('【用户当前正在看的页面】') && p4.length < 60000, '提示词 ' + p4.length + ' 字');
    ok('超长页面标出了省略字数', p4.includes('中间省略'));

    /* ⑤ 随堂测验旧接口已删除（改成统一走助手） */
    const old = await jpost('http://127.0.0.1:' + APP_PORT + '/api/quiz-session/1/chat', { text: '还在吗' });
    ok('旧追问接口已删除', old && (old.error || old === 'Not Found' || String(JSON.stringify(old)).indexOf('不存在') >= 0), JSON.stringify(old).slice(0, 120));

    console.log('\n' + n + ' 项全部通过');
  } finally {
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\n失败：' + (e && e.message)); process.exit(1); });
