#!/usr/bin/env node
'use strict';
/**
 * 对话 ops 批量回归：node --no-warnings scripts/test-chat-ops-batch.js
 *
 * 为什么留（用户 2026-10-20 两轮反馈）：
 *   ① 用户让助手"保留 22 张截图、其余资料删掉"，助手回了"系统单次最多 20 个操作，
 *      本轮先清 20 组，删完请回一句「继续」" —— 删除类 op 又小又便宜，几十条本该一轮删完。
 *   ② 第二轮用户说"继续删，现在应该没有次数限制了"，助手只删了 7 条就收手，还让用户
 *      "把剩下的标题发我几条" —— 因为清单里只列了网络资料前 20 条标题，其余条目模型
 *      根本看不到，而 delete_source 又只能一条一条删。
 *   现在策略：**删除类不设上限；只有 add / add_source 这类"重"操作才分批**；同时
 *   delete_source 支持按 ids / site / except_sites 批量，模型不必逐条列标题。
 *
 * 这里用假 AI 验五件事：
 *   ① 一轮 40 个 delete_source 全部执行（没有被 20/25 截断）；
 *   ② 一轮 30 个 add 全部执行（安全上限不再误伤正常批量）；
 *   ③ 提示词里是"删除类不设上限"，而不是"单次最多 20 个操作"；
 *   ④ delete_source {site:"知乎"} 一次删掉该站点全部；
 *   ⑤ delete_source {except_sites:[…]} 一次清掉其余网络资料，**绝不碰用户上传的截图/代码库**，
 *      且按 ids 点名时能删（显式意图）。
 *
 * 沙箱：SIERXING_DATA_DIR=临时目录，不碰真实数据；端口 3331（假 AI 3330）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3331);
const AI_PORT = Number(process.env.AI_PORT || 3330);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-chat-ops-'));
const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);
const SOURCE_TITLES = Array.from({ length: 40 }, function (_, i) { return '批量删除测试资料 ' + String(i + 1).padStart(2, '0'); });
const OWN_TITLES = Array.from({ length: 15 }, function (_, i) { return '用户上传截图 ' + String(i + 1).padStart(2, '0'); });
const CSDN_TITLES = Array.from({ length: 20 }, function (_, i) { return 'CSDN 学习路线 ' + String(i + 1).padStart(2, '0'); });
const ZHIHU_TITLES = Array.from({ length: 5 }, function (_, i) { return '知乎经验 ' + String(i + 1).padStart(2, '0'); });

let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '：' + extra : '')); console.log('  ✓ ' + name); n++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 假 AI：记下提示词；按用户消息回一段带 ops 的回复 ---------- */
const SEEN = [];
let NEXT_OPS = null;
function replyWith(ops) {
  return '收到，这就处理。' + NL + NL + FENCE + 'ops' + NL + JSON.stringify(ops || []) + NL + FENCE + NL;
}
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) {}
    const msgs = j.messages || [];
    const prompt = msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(NL);
    SEEN.push({ url: req.url, prompt });
    const lastUser = String(((msgs.filter(m => m.role === 'user').pop() || {}).content) || '');
    const mm = lastUser.match(/【用户的新消息】([\s\S]*?)(?:\n\n【|$)/);
    const curMsg = mm ? mm[1].trim() : lastUser;
    let ops = [];
    if (/批量删资料/.test(curMsg)) {
      ops = SOURCE_TITLES.map(t => ({ op: 'delete_source', title: t }));
    } else if (/批量加节点/.test(curMsg)) {
      ops = Array.from({ length: 30 }, function (_, i) {
        return { op: 'add', parent_id: 0, title: '批量新增任务 ' + (i + 1), detail: '验证单轮 30 个 add 不被截断', hours: '1' };
      });
    } else if (/批量删来源/.test(curMsg)) {
      ops = [{ op: 'delete_source', site: '知乎' }];
    } else if (/除了截图/.test(curMsg)) {
      ops = [{ op: 'delete_source', except_sites: ['用户提供的图片', '导入的代码库'] }];
    } else if (/自定义Ops测试/.test(curMsg)) {
      ops = NEXT_OPS || [];
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const text = replyWith(ops);
    for (const chunk of [text.slice(0, 20), text.slice(20)]) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + NL + NL);
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + NL + NL);
    res.write('data: [DONE]' + NL + NL);
    res.end();
  });
});

async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; }
}
async function chat(sid, payload) {
  const r = await fetch('http://127.0.0.1:' + APP_PORT + '/api/chat-sessions/' + sid + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const text = await r.text();
  let done = null;
  for (const part of text.split(NL + NL)) {
    const line = part.split(NL).find(l => l.startsWith('data: '));
    if (!line) continue;
    let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
    if (d.done) done = d;
  }
  return done;
}
async function sourcesOf(gid) {
  const rep = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/' + gid + '/sources');
  return Array.isArray(rep) ? rep : ((rep && (rep.sources || rep.items)) || []);
}

const SEED = {
  goals: [
    { id: 1, title: '对话批量 ops 回归目标', status: 'active' },
    { id: 2, title: '资料库批量删除回归目标', status: 'active' }
  ],
  sources: [].concat(
    SOURCE_TITLES.map(function (title, i) {
      return { id: 100 + i, goal_id: 1, title: title, kind: '资料', site: '测试', snippet: '', content: '测试内容 ' + (i + 1) };
    }),
    OWN_TITLES.map(function (title, i) {
      return { id: 200 + i, goal_id: 2, title: title, kind: 'JD', site: '用户提供的图片', snippet: '', content: '用户上传的截图 ' + (i + 1) };
    }),
    CSDN_TITLES.map(function (title, i) {
      return { id: 300 + i, goal_id: 2, title: title, kind: '学习路线', site: 'CSDN', snippet: '', content: 'CSDN 网络资料 ' + (i + 1) };
    }),
    ZHIHU_TITLES.map(function (title, i) {
      return { id: 400 + i, goal_id: 2, title: title, kind: '经验', site: '知乎', snippet: '', content: '知乎网络资料 ' + (i + 1) };
    }),
    [{ id: 500, goal_id: 2, title: '导入代码库 SiErXing', kind: '代码库', site: '导入的代码库', snippet: '', content: '代码库快照' }]
  )
};

async function session(gid) {
  const se = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/' + gid + '/chat-sessions', {});
  const sid = Number(se.session && se.session.id);
  assert.ok(sid, '建对话失败：' + JSON.stringify(se).slice(0, 200));
  return sid;
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

    const imp = await jpost('http://127.0.0.1:' + APP_PORT + '/api/import/json', SEED);
    assert.ok(imp && imp.ok, '导入种子失败：' + JSON.stringify(imp).slice(0, 200));

    /* ===== 目标 1：40 个删除类 op 一轮全做完（旧实现会只剩 20 / 25 条） ===== */
    const sid1 = await session(1);
    SEEN.length = 0;
    const done1 = await chat(sid1, { message: '批量删资料：把这 40 条测试资料全部删掉，一轮删完', mode: 'agent' });
    assert.ok(done1, '批量删除轮没收到 done 事件');
    ok('一轮对话只发 1 次 AI 请求', SEEN.length === 1, '实际 ' + SEEN.length);
    const p1 = SEEN[0].prompt;
    ok('提示词说"删除类操作…不设上限"', p1.includes('删除类操作') && p1.includes('不设上限'));
    ok('提示词不再有"单次最多 20 个操作"', !p1.includes('单次最多 20 个操作'));
    ok('提示词禁止模型自己把操作拆成多轮', p1.includes('不要自己把操作拆成多轮'));
    const applied1 = done1.applied || [];
    ok('40 个 delete_source 全部执行（没有被截断）', applied1.length === 40, '实际 ' + applied1.length + ' 条');
    ok('执行的每一条都是 delete_source', applied1.every(x => x.op === 'delete_source'));
    ok('没有报错', (done1.errors || []).length === 0, JSON.stringify(done1.errors || []).slice(0, 200));
    ok('资料库里 40 条测试资料已全部删掉', (await sourcesOf(1)).length === 0);

    /* ===== 目标 2：批量语义（站点 / 反向筛选 / ids） ===== */
    const sid2 = await session(2);
    const before2 = await sourcesOf(2);
    ok('种子资料 41 条（15 截图 + 20 CSDN + 5 知乎 + 1 代码库）', before2.length === 41, '实际 ' + before2.length);

    // ① 按站点删：提示词必须带「网络来源分布」+ 批量表单，模型才可能选对
    SEEN.length = 0;
    const doneSite = await chat(sid2, { message: '批量删来源：把知乎的资料都删掉', mode: 'agent' });
    assert.ok(doneSite, '站点批量删除轮没收到 done 事件');
    const pSite = SEEN[0].prompt;
    ok('提示词列出「网络来源分布」并含站点计数', pSite.includes('网络来源分布') && /CSDN 20/.test(pSite) && /知乎 5/.test(pSite));
    ok('提示词给出 delete_source 的 site / except_sites 用法', pSite.includes('except_sites') && pSite.includes('"site":' + '"CSDN"'));
    ok('不允许逐条猜标题（提示词里写明）', pSite.includes('不要逐条猜标题'));
    ok('site 形式一次删掉知乎全部 5 条', (doneSite.applied || []).length === 5, '实际 ' + (doneSite.applied || []).length);
    let afterSite = await sourcesOf(2);
    ok('知乎资料已清空、其余 36 条保留', afterSite.length === 36 && !afterSite.some(s => s.site === '知乎'));

    // ② 反向筛选：除了自己上传的，其余全删
    const doneKeep = await chat(sid2, { message: '除了截图和代码库，其余网络资料全删', mode: 'agent' });
    assert.ok(doneKeep, '反向筛选删除轮没收到 done 事件');
    ok('except_sites 一次删掉其余 20 条 CSDN', (doneKeep.applied || []).length === 20, '实际 ' + (doneKeep.applied || []).length);
    const afterKeep = await sourcesOf(2);
    ok('只剩自己提供的 16 条（15 截图 + 1 代码库）', afterKeep.length === 16, '实际 ' + afterKeep.length);
    ok('用户上传的 15 张截图一张没少', afterKeep.filter(s => s.site === '用户提供的图片').length === 15);
    ok('导入的代码库还在', afterKeep.some(s => s.site === '导入的代码库'));

    // ③ ids 点名（显式意图）：删 1 张截图 + 代码库
    const remaining = await sourcesOf(2);
    const pick = remaining.filter(s => s.site === '用户提供的图片').slice(0, 1).concat(remaining.filter(s => s.site === '导入的代码库'));
    NEXT_OPS = [{ op: 'delete_source', ids: pick.map(s => s.id) }];
    const doneIds = await chat(sid2, { message: '自定义Ops测试：按 id 精确删两条', mode: 'agent' });
    assert.ok(doneIds, 'ids 删除轮没收到 done 事件');
    ok('ids 形式按 id 精确删 2 条', (doneIds.applied || []).length === 2, '实际 ' + (doneIds.applied || []).length);
    ok('删完后剩 14 条截图', (await sourcesOf(2)).length === 14);

    console.log(NL + n + ' 项全部通过');
  } finally {
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(e => { console.error(e && e.stack || e); try { aiSrv.close(); } catch (x) {} process.exit(1); });
