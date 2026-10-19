'use strict';
/**
 * 「达成条件能被 AI 助手直接改」端到端回归：node --no-warnings scripts/test-chat-conditions.js
 *
 * 为什么留：用户反馈"条件生成一版就定死了、改不了"，而项目定调 AI 问答只有助手那一套。
 * 所以条件是靠助手的一条对话 + condition_* ops 改的，不是组件里再写一套对话。
 * 这条链路横跨 提示词上下文 / 服务端 ops / 领域落库 三层，断任何一层用户都只会看到
 * "AI 说改了、页面没变"。这里用假 AI 抓真实提示词并回一段带 ops 的回复来验：
 *   ① 提示词里带了【当前达成条件】（含 id / 优先级 / 达成标准）与未归属节点；
 *   ② Agent 模式下的 condition_add/update/assign/delete/unassign 真的落库；
 *   ③ ASK 模式下同样的 ops 一律不执行（状态不变）；
 *   ④ 不存在的条件 id 只报错、不破坏其它数据。
 *
 * 沙箱：SIERXING_DATA_DIR=临时目录，不碰真实数据；端口 3321（假 AI 3320）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3321);
const AI_PORT = Number(process.env.AI_PORT || 3320);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-chat-cond-'));

let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '：' + extra : '')); console.log('  ✓ ' + name); n++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 假 AI：记下提示词；回复正文里带 ops（解析规则与真模型一样是 ```ops 块） ---------- */
const seen = [];
function replyWith(ops) {
  return '收到，我已经按你说的调整了达成条件。\n\n```ops\n' + JSON.stringify(ops || []) + '\n```\n';
}
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) {}
    const msgs = j.messages || [];
    const prompt = msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    seen.push({ url: req.url, prompt });
    const lastUser = String(((msgs.filter(m => m.role === 'user').pop() || {}).content) || '');
    /* ⚠️ lastUser 是整段提示词（含【最近的对话】）。必须只拿「这一轮用户真正说的话」来判定，
       否则历史里出现过的旧指令会盖住这一轮的新指令（范围测试踩过）。 */
    const curMsg = (function () {
      const m = String(lastUser).match(/【用户的新消息】([\s\S]*?)(?:\n\n【|$)/);
      return m ? m[1].trim() : String(lastUser);
    })();
    const ops = /范围条件测试/.test(curMsg) ? [
      /* 混合 ops：用户说"只改条件"，模型却想顺手改节点 —— 服务端必须只放行条件那条 */
      { op: 'condition_update', id: 1, acceptance: '范围条件测试标准' },
      { op: 'update', id: 11, title: '不该被改的节点标题' }
    ] : /范围节点测试/.test(curMsg) ? [
      { op: 'update', id: 11, title: '范围节点测试改的节点' },
      { op: 'condition_update', id: 1, acceptance: '范围节点测试不该生效' }
    ] : /整批换成 JD/.test(curMsg) ? [
      { op: 'condition_replace', conditions: [
        { key: 'c1', title: '硬门槛与到岗资格达标', detail: 'JD 硬性门槛', acceptance: '简历与沟通写明学历/届别/城市/到岗天数/实习时长', jd: 'JD 原文：本科及以上、2027 届、北京、每周到岗 ≥3 天、连续 3 个月', priority: 'must', nodes: [11] },
        { key: 'c2', title: 'AIPM 技术理解达标', detail: 'JD 要求的技术面', acceptance: '能回答 RAG / Agent / Prompt / 评测 / 成本', jd: 'JD 原文：熟悉 RAG / Agent / Prompt / 模型评测 / 推理成本', priority: 'must', nodes: [14] }
      ] }
    ] : /节点 16 从条件里摘出来/.test(curMsg) ? [
      { op: 'condition_unassign', node_ids: [16] }
    ] : [
      { op: 'condition_update', id: 2, acceptance: '能不看模板讲清 AIPM 三件事', jd: '公共 AIPM JD：RAG / Agent / Prompt / 评测 / 成本都能被追问', priority: 'must' },
      { op: 'condition_add', title: '面试表达过关', detail: '面试时要能讲清项目取舍', acceptance: '能完成 3 次模拟面试并拿到反馈', jd: '公共 AIPM JD：场景+任务+动作+指标的讲述', priority: 'should' },
      { op: 'condition_assign', condition_id: 1, node_ids: [16], cascade: true },
      { op: 'condition_delete', id: 3 },
      { op: 'condition_update', id: 999999, acceptance: '这条应该失败' }
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const text = replyWith(ops);
    for (const chunk of [text.slice(0, 20), text.slice(20)]) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
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
  for (const part of text.split('\n\n')) {
    const line = part.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; }
    if (d.done) done = d;
  }
  return done;
}

const SEED = {
  goals: [{ id: 1, title: '达成条件对话回归目标', status: 'active' }],
  conditions: [
    { id: 1, goal_id: 1, title: '能独立产出合格的 PRD', detail: '岗位硬要求', acceptance: '不看模板写出 1 份 PRD', jd_ref: 'JD 原文：能独立撰写 PRD / 需求文档', priority: 'must', source: 'plan', sort_order: 1 },
    { id: 2, goal_id: 1, title: '完成 AIPM 基础认知扫盲', detail: '补齐基本功', acceptance: '能讲清概念', jd_ref: '公共 AIPM JD：产品基本功（需求/优先级/指标）', priority: 'should', source: 'plan', sort_order: 2 },
    { id: 3, goal_id: 1, title: '面试表达过关', detail: '要能讲清项目', acceptance: '完成 1 次模拟面试', priority: 'nice', source: 'plan', sort_order: 3 }
  ],
  nodes: [
    { id: 11, goal_id: 1, parent_id: null, level: 0, title: '第1阶段：基础扫盲', condition_id: 2, sort_order: 1 },
    { id: 12, goal_id: 1, parent_id: 11, level: 1, title: '读入门书', condition_id: 2, status: 'done', sort_order: 1 },
    { id: 13, goal_id: 1, parent_id: 11, level: 1, title: '做拆解练习', condition_id: 2, sort_order: 2 },
    { id: 14, goal_id: 1, parent_id: null, level: 0, title: '第2阶段：作品集', condition_id: 1, sort_order: 2 },
    { id: 15, goal_id: 1, parent_id: 14, level: 2, title: '写出第一份 PRD', condition_id: 1, sort_order: 1 },
    { id: 16, goal_id: 1, parent_id: 14, level: 2, title: '把 PRD 放进作品集', condition_id: 0, sort_order: 2 },
    { id: 17, goal_id: 1, parent_id: null, level: 0, title: '第3阶段：面试准备', condition_id: 3, sort_order: 3 }
  ],
  sources: [
    { id: 1, goal_id: 1, title: 'AIPM 岗位 JD 原文', kind: 'JD', site: '用户提供的资料', snippet: '', content: '本科及以上，2027 届，北京，每周到岗 ≥3 天，连续实习 3 个月以上；要求熟悉 RAG / Agent / Prompt / 模型评测 / 推理成本。' }
  ]
};

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
    const s = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/1/chat-sessions', {});
    const sid = Number(s.session && s.session.id);
    assert.ok(sid, '建对话失败：' + JSON.stringify(s).slice(0, 200));

    /* ① Agent 模式：提示词带条件上下文 + ops 真的落库 */
    seen.length = 0;
    const done1 = await chat(sid, { message: '把第 2 条条件改严格些，新增一条面试表达，把节点 16 归到第 1 条，删掉第 3 条', mode: 'agent' });
    assert.ok(done1, 'Agent 轮没收到 done 事件');
    assert.ok(seen.length === 1, '一轮对话只应发 1 次 AI 请求，实际 ' + seen.length);
    const p1 = seen[0].prompt;
    ok('提示词里有【当前达成条件】', p1.includes('【当前达成条件'), p1.slice(-500));
    ok('条件块带条件 id 与优先级', p1.includes('[1] 能独立产出合格的 PRD') && p1.includes('[2] 完成 AIPM 基础认知扫盲'), p1.slice(-500));
    ok('条件块带达成标准（AI 改条件有依据）', p1.includes('不看模板写出 1 份 PRD'));
    ok('条件块列出未归属节点', p1.includes('【还没有归属条件的节点】') && p1.includes('[16]'), p1.slice(-400));
    ok('条件块带 JD 条款（AI 按 JD 改条件有依据）', p1.includes('对应 JD：') && p1.includes('撰写 PRD'), p1.slice(-500));
    ok('提示词带资料库里的 JD 原文（能对到具体条款）', p1.includes('【资料库里的 JD / 招聘原文') && p1.includes('RAG / Agent / Prompt'));
    const applied = done1.applied || [];
    if (applied.length !== 4) console.log('    [debug] applied=', JSON.stringify(applied), 'errors=', JSON.stringify(done1.errors || []));
    ok('Agent 轮成功执行 4 条 ops', applied.length === 4, JSON.stringify(applied.map(x => x.op)));
    ok('condition_update 生效', applied.some(x => x.op === 'condition_update' && Number(x.id) === 2));
    ok('condition_add 生效', applied.some(x => x.op === 'condition_add' && x.title === '面试表达过关'));
    ok('condition_assign 生效', applied.some(x => x.op === 'condition_assign' && Number(x.id) === 1 && Number(x.nodes) === 1));
    ok('condition_delete 生效', applied.some(x => x.op === 'condition_delete' && Number(x.id) === 3));
    ok('不存在的条件 id 只报错不影响其它', (done1.errors || []).length === 1 && String(done1.errors[0]).includes('条件不存在'), JSON.stringify(done1.errors));

    const after = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    const list = after.conditions || [];
    ok('条件总数 3（删 1 添 1）', list.length === 3, '实际 ' + list.length + '：' + list.map(c => c.title).join(' / '));
    const c2 = list.find(c => Number(c.id) === 2);
    ok('第 2 条的达成标准已按对话改掉', c2 && c2.acceptance === '能不看模板讲清 AIPM 三件事', c2 && c2.acceptance);
    ok('第 2 条的 JD 条款已按对话改写', c2 && String(c2.jd_ref || '').includes('RAG / Agent'), c2 && c2.jd_ref);
    ok('第 3 条已删除', !list.some(c => Number(c.id) === 3));
    const newC = list.find(c => c.title === '面试表达过关');
    ok('新增条件带上 JD 条款', !!(newC && String(newC.jd_ref || '').includes('场景+任务+动作+指标')), newC && newC.jd_ref);
    ok('新增的条件已落库', !!newC, list.map(c => c.title).join(' / '));
    const c1 = list.find(c => Number(c.id) === 1);
    ok('节点 16 已归到第 1 条', !!(c1 && (c1.nodes || []).some(x => Number(x.id) === 16)), JSON.stringify((c1 && c1.nodes || []).map(x => x.id)));
    ok('删除条件后它原本的节点回到未归属（不是连节点一起删）', Number((after.summary || {}).nodes_unassigned) === 1, JSON.stringify(after.summary));

    /* ② condition_unassign：把节点从条件里摘出来 */
    seen.length = 0;
    const done1b = await chat(sid, { message: '把节点 16 从条件里摘出来，回到未归属', mode: 'agent' });
    const applied1b = done1b.applied || [];
    ok('condition_unassign 生效', applied1b.some(x => x.op === 'condition_unassign' && Number(x.nodes) === 1), JSON.stringify(applied1b));
    const afterUn = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    const c1b = (afterUn.conditions || []).find(c => Number(c.id) === 1);
    ok('节点 16 已从第 1 条摘出', !(c1b && (c1b.nodes || []).some(x => Number(x.id) === 16)));
    ok('未归属节点变成 2 个', Number((afterUn.summary || {}).nodes_unassigned) === 2, JSON.stringify(afterUn.summary));

    /* ③ ASK 模式：同一段回复里的 ops 一律不执行 */
    const beforeCount = (await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions')).conditions.length;
    seen.length = 0;
    const done2 = await chat(sid, { message: '再改一遍条件', mode: 'ask' });
    assert.ok(done2, 'ASK 轮没收到 done 事件');
    ok('ASK 模式下 ops 不执行', !(done2.applied && done2.applied.length), JSON.stringify(done2.applied || []));
    const afterAsk = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    ok('ASK 模式没有改动条件数据', afterAsk.conditions.length === beforeCount &&
      (afterAsk.conditions.find(c => Number(c.id) === 2) || {}).acceptance === '能不看模板讲清 AIPM 三件事');

    /* ④ 从「达成条件页」发消息（带页面上下文）也能改 */
    seen.length = 0;
    const done3 = await chat(sid, {
      message: '把第 1 条的达成标准再具体一点',
      mode: 'agent',
      page_context: { label: '达成条件', title: '达成条件', route: '#/g/1/conditions', text: '达成条件\n能独立产出合格的 PRD\n0/1 个节点完成' }
    });
    ok('达成条件页发消息也有条件上下文', seen[0].prompt.includes('【当前达成条件'));
    ok('达成条件页发消息也带页面内容', seen[0].prompt.includes('【用户当前正在看的页面】') && seen[0].prompt.includes('#/g/1/conditions'));

    /* ⑤ 「🎯 只改」范围：服务端硬拦越界 ops（用户反馈：在条件页说改条件，AI 却改路线图） */
    const goalNow = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1');
    const flat = [];
    (function walk(list) { for (const x of (list || [])) { flat.push(x); walk(x.children); } })((goalNow.goal || {}).nodes || []);
    const node11 = flat.find(x => Number(x.id) === 11);
    ok('范围测试前节点 11 标题是原始值', !!node11 && node11.title === '第1阶段：基础扫盲', node11 && node11.title);

    seen.length = 0;
    const doneScopeCond = await chat(sid, {
      message: '范围条件测试：把第 1 条达成标准改掉，顺手把节点 11 改个名',
      mode: 'agent', edit_scope: 'conditions'
    });
    ok('范围=达成条件：提示词里有硬约束块', seen[0].prompt.includes('【本轮改动范围 · 用户已在界面上锁定：只改「达成条件」】'), seen[0].prompt.slice(-900));
    ok('范围=达成条件：提示词只列条件类 op', seen[0].prompt.includes('condition_update') && /这次只允许输出这些 op：condition_add/.test(seen[0].prompt));
    const appliedCond = (doneScopeCond.applied || []).map(x => x.op);
    ok('范围=达成条件：条件改动生效', appliedCond.includes('condition_update'), JSON.stringify(appliedCond));
    ok('范围=达成条件：越界的节点改动被挡掉', !appliedCond.includes('update'), JSON.stringify(appliedCond));
    ok('范围=达成条件：回复里说明挡掉了什么', String(doneScopeCond.reply || '').includes('超出范围') && String(doneScopeCond.reply || '').includes('已被挡掉'), String(doneScopeCond.reply || '').slice(-200));
    const afterScopeCond = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1');
    const flatA = [];
    (function walk(list) { for (const x of (list || [])) { flatA.push(x); walk(x.children); } })((afterScopeCond.goal || {}).nodes || []);
    ok('范围=达成条件：节点 11 标题没被改', flatA.find(x => Number(x.id) === 11).title === '第1阶段：基础扫盲', flatA.find(x => Number(x.id) === 11).title);
    const condAfter1 = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    ok('范围=达成条件：第 1 条标准已改掉', (condAfter1.conditions || []).find(c => Number(c.id) === 1).acceptance === '范围条件测试标准',
      (condAfter1.conditions || []).map(c => c.acceptance).join(' | '));

    seen.length = 0;
    const doneScopeNode = await chat(sid, {
      message: '范围节点测试：把节点 11 改个名，顺手改第 1 条达成标准',
      mode: 'agent', edit_scope: 'nodes'
    });
    const appliedNode = (doneScopeNode.applied || []).map(x => x.op);
    ok('范围=路线图节点：节点改动生效', appliedNode.includes('update'), JSON.stringify(appliedNode));
    ok('范围=路线图节点：越界的条件改动被挡掉', !appliedNode.includes('condition_update'), JSON.stringify(appliedNode));
    ok('范围=路线图节点：回复里说明挡掉了什么', String(doneScopeNode.reply || '').includes('超出范围'));
    const afterScopeNode = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1');
    const flatB = [];
    (function walk(list) { for (const x of (list || [])) { flatB.push(x); walk(x.children); } })((afterScopeNode.goal || {}).nodes || []);
    ok('范围=路线图节点：节点标题已改', flatB.find(x => Number(x.id) === 11).title === '范围节点测试改的节点', flatB.find(x => Number(x.id) === 11).title);
    const condAfter2 = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    ok('范围=路线图节点：条件标准没被改', (condAfter2.conditions || []).find(c => Number(c.id) === 1).acceptance === '范围条件测试标准',
      (condAfter2.conditions || []).map(c => c.acceptance).join(' | '));

    /* ⑥ auto（默认）：不拦，混合 ops 都生效 —— 保证没把默认路径改坏 */
    const doneAuto = await chat(sid, {
      message: '范围节点测试：把节点 11 改个名，顺手改第 1 条达成标准',
      mode: 'agent'
    });
    const appliedAuto = (doneAuto.applied || []).map(x => x.op);
    ok('范围=自动：条件与节点改动都生效', appliedAuto.includes('update') && appliedAuto.includes('condition_update'), JSON.stringify(appliedAuto));
    ok('范围=自动：提示词里没有范围硬约束块', !seen[seen.length - 1].prompt.includes('本轮改动范围 · 用户已在界面上锁定'));

    /* ⑦ 整批替换：用户说"把现有条件换成 JD 要求" → condition_replace 一次换完（手动条件保留） */
    const beforeRep = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    const manualBefore = (beforeRep.conditions || []).filter(c => c.source === 'manual').map(c => c.title);
    ok('替换前有手动条件（用来验证不被误删）', manualBefore.length >= 1, JSON.stringify(manualBefore));
    seen.length = 0;
    const doneRep = await chat(sid, { message: '把现有条件整批换成 JD 要求', mode: 'agent', edit_scope: 'conditions' });
    const appliedRep = (doneRep.applied || []).map(x => x.op);
    ok('condition_replace 一次替换整批', appliedRep.includes('condition_replace'), JSON.stringify(appliedRep));
    const repOp = (doneRep.applied || []).find(x => x.op === 'condition_replace') || {};
    ok('替换后条件数 2、归属了 2 个阶段节点', Number(repOp.conditions) === 2 && Number(repOp.assigned) === 2, JSON.stringify(repOp));
    const afterRep = await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1/conditions');
    const repList = afterRep.conditions || [];
    ok('旧规划条件已被替换成 JD 条件', repList.some(c => c.title === '硬门槛与到岗资格达标') && repList.some(c => c.title === 'AIPM 技术理解达标'), JSON.stringify(repList.map(c => c.title)));
    ok('新条件的 JD 条款已落库', (repList.find(c => c.title === 'AIPM 技术理解达标') || {}).jd_ref === 'JD 原文：熟悉 RAG / Agent / Prompt / 模型评测 / 推理成本', (repList.find(c => c.title === 'AIPM 技术理解达标') || {}).jd_ref);
    ok('手动条件在整批替换后全部保留', manualBefore.every(t => repList.some(c => c.source === 'manual' && c.title === t)), JSON.stringify(repList.map(c => c.source + ':' + c.title)));
    ok('替换后两个阶段子树都归到新条件（只剩原本无人管的节点 17）', Number((afterRep.summary || {}).nodes_unassigned) === 1 &&
      (afterRep.unassigned || []).every(x => Number(x.id) === 17), JSON.stringify(afterRep.summary));

    console.log('\n' + n + ' 项全部通过');
  } finally {
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('\n失败：' + (e && e.message)); process.exit(1); });
