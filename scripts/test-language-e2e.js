#!/usr/bin/env node
'use strict';
/**
 * 界面语言「AI 生成新语言」端到端验收 —— 不花钱、不联网
 * ============================================================================
 *   node --no-warnings scripts/test-language-e2e.js
 *
 * 用假 AI（本地 HTTP，OpenAI 兼容 /chat/completions）跑通整条链路：
 *   POST /api/language/generate → 后台任务（识别语言/分批翻译/校验/落盘）
 *   → GET /api/tasks 轮询到完成 → /api/language/state 出现新语言
 *   → 切换 → 入口 HTML 的 lang / 标题 / 字典都变 → 删除 → 恢复
 *
 * 端口：APP_PORT(3396) / FAKE_AI_PORT(3397)；数据在 .tmp-dev 下，跑完清理。
 * 不碰真实数据、不调真实 AI。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3396);
const AI_PORT = Number(process.env.FAKE_AI_PORT || 3397);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const WORK = path.join(APP_DIR, '.tmp-dev', 'lang-e2e-' + process.pid);
const DATA_DIR = path.join(WORK, 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let server = null;
let fakeAi = null;
let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function bad(name, detail) { failed++; console.error('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 300) : '')); }
function cleanDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function cjkToX(s) { return String(s).replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, 'x'); }
function jsonOf(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; } } }
  }
  return null;
}

/** 假 AI：按提示词类型返回不同 JSON（OpenAI 兼容非流式） */
function startFakeAi() {
  const ai = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let prompt = '';
      try {
        const j = JSON.parse(body);
        const msg = (j.messages || []).map(m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : m.content).join('\n');
        prompt = msg;
      } catch (e) {}
      let content = '{}';
      if (/BCP-47/.test(prompt)) {
        content = JSON.stringify({ code: 'eo', nativeName: 'Esperanto', englishName: 'Esperanto', rtl: false });
      } else if (/documentTitle/.test(prompt)) {
        content = JSON.stringify({ documentTitle: 'SiErXing: Your goal-planning assistant', documentDescription: 'Local-first goal planning.' });
      } else {
        const idx = prompt.lastIndexOf('输入：');
        if (idx >= 0) {
          try {
            const input = JSON.parse(prompt.slice(idx + 3).trim());
            const out = {};
            for (const k of input) out[k] = cjkToX(k);
            content = JSON.stringify(out);
          } catch (e) {
            content = '{}';
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((resolve, reject) => {
    ai.once('error', reject);
    ai.listen(AI_PORT, '127.0.0.1', () => resolve(ai));
  });
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json: json, text: text };
}
async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) {}
    await sleep(250);
  }
  throw new Error('沙箱服务没起来（端口 ' + APP_PORT + '）');
}

(async () => {
  try {
    cleanDir(WORK);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    /* 1) 假 AI + 沙箱服务 */
    fakeAi = await startFakeAi();
    console.log('▶ 假 AI 已启动：http://127.0.0.1:' + AI_PORT);
    server = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(APP_DIR, 'server/server.js')], {
      cwd: APP_DIR,
      env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(APP_PORT), SIERXING_DATA_DIR: DATA_DIR }),
      stdio: 'ignore'
    });
    await waitServer();
    console.log('▶ 沙箱实例已启动（端口 ' + APP_PORT + '）');

    /* 2) 配一条指向假 AI 的连接 */
    const conn = await api('POST', '/api/ai/connections', {
      connections: [{
        id: 'fake', name: 'Fake AI', provider: 'openai', kind: 'api', purpose: 'chat',
        providerId: 'custom', baseUrl: 'http://127.0.0.1:' + AI_PORT + '/v1', apiKey: 'test',
        models: ['fake-model'], defaultModel: 'fake-model', visionModel: '', enabled: true
      }]
    });
    if (!conn.json || !conn.json.ok) throw new Error('配置假 AI 连接失败：' + conn.text);
    await fetch(BASE + '/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(j => { if (j && j.ok) console.log('▶ 假 AI 连接测试通过'); }).catch(() => {});

    /* 3) 发起「AI 生成新语言」 */
    const gen = await api('POST', '/api/language/generate', { name: 'Esperanto' });
    if (!gen.json || !gen.json.ok || !gen.json.taskId) throw new Error('发起生成失败：' + gen.text);
    console.log('▶ 已发起生成任务 #' + gen.json.taskId + '（语言：Esperanto）');

    let task = null;
    for (let i = 0; i < 200; i++) {
      await sleep(500);
      const list = await api('GET', '/api/tasks');
      const tasks = (list.json && list.json.tasks) || [];
      task = tasks.find(t => Number(t.id) === Number(gen.json.taskId));
      if (task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) break;
    }
    if (!task) throw new Error('任务列表里找不到生成任务');
    if (task.status !== 'done') throw new Error('生成任务没成功：' + task.status + ' ' + (task.error || task.message));
    ok('后台任务完成（type=' + task.type + '，进度 ' + task.progress + '%）');
    const code = task.result && task.result.code;
    if (!code) throw new Error('任务结果里没有语言代码：' + JSON.stringify(task.result));
    ok('语言代码识别：' + code + '（' + (task.result.name || '') + '，' + task.result.entries + ' 条译文）');

    /* 4) 语言列表 / 切换 / 入口 HTML */
    const st1 = await api('GET', '/api/language/state');
    const genLoc = ((st1.json && st1.json.locales) || []).find(l => l.code === code);
    if (!genLoc || !genLoc.generated) bad('语言列表里没有生成的语言'); else ok('语言列表里出现生成语言：' + code + '（' + genLoc.translated + ' 条已译）');
    if (genLoc && genLoc.translated < 4000) bad('生成语言包词条太少：' + genLoc.translated);

    const act = await api('POST', '/api/language/active', { code: code });
    if (!act.json || !act.json.ok) bad('切换到生成语言失败', act.text); else ok('切换到生成语言');
    const home = await fetch(BASE + '/').then(r => r.text());
    if (!/lang="' + code + '"/.test(home) && home.indexOf('lang="' + code + '"') < 0) bad('入口 HTML 的 lang 不是生成语言', home.slice(0, 200));
    else ok('入口 HTML lang="' + code + '"');
    if (home.indexOf('/api/language/pack.js?code=' + code) < 0) bad('入口 HTML 没注入语言包脚本');
    else ok('入口 HTML 注入了语言包脚本');
    const packJs = await fetch(BASE + '/api/language/pack.js?code=' + code).then(r => r.text());
    if (packJs.indexOf('window.__SX_I18N_DATA__=') !== 0) bad('语言包脚本格式不对');
    else {
      const json = packJs.slice(packJs.indexOf('=') + 1).replace(/;\s*$/, '');
      const data = JSON.parse(json);
      const n = Object.keys(data.entries || {}).length;
      if (n < 4000) bad('语言包条目太少：' + n); else ok('语言包条目 ' + n + ' 条');
    }

    /* 5) 删除 → 恢复跟随浏览器 */
    const del = await api('POST', '/api/language/delete', { code: code });
    if (!del.json || !del.json.ok) bad('删除生成语言包失败', del.text); else ok('删除生成语言包');
    const st2 = await api('GET', '/api/language/state');
    if (((st2.json && st2.json.locales) || []).some(l => l.code === code)) bad('删除后语言列表里还有它');
    else ok('删除后语言列表同步移除');
    const home2 = await fetch(BASE + '/').then(r => r.text());
    if (home2.indexOf('lang="' + code + '"') >= 0) bad('删除后仍在用被删的语言'); else ok('删除后自动恢复默认语言');
  } catch (e) {
    bad('测试异常', (e && e.stack) || e);
  } finally {
    /* 清理：先杀服务，再清目录 */
    try { if (server && !server.killed) server.kill('SIGKILL'); } catch (e) {}
    try {
      const out = execFileSync('bash', ['-lc', "ss -ltnp 2>/dev/null | grep ':" + APP_PORT + " ' | grep -oP 'pid=\\K[0-9]+' | head -1"], { encoding: 'utf8' }).trim();
      if (out) execFileSync('kill', ['-9', out], { stdio: 'ignore' });
    } catch (e) {}
    try { if (fakeAi) fakeAi.close(); } catch (e) {}
    await sleep(300);
    cleanDir(WORK);
    console.log('\n' + (failed ? '✗ i18n AI 生成端到端失败：' + failed + ' 项（通过 ' + passed + '）' : '✓ i18n AI 生成端到端通过：' + passed + ' 项'));
    process.exitCode = failed ? 1 : 0;
  }
})();
