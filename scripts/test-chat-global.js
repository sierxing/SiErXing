'use strict';
/**
 * 「AI 助手 = 核心组件 + 全页面常驻 + 全局只读助手」端到端回归
 * 跑：node --no-warnings scripts/test-chat-global.js
 *
 * 验证：
 *   ① 组件元数据：chat 是 core / 核心组件 / 不可移除 / 永远 enabled；
 *   ② 无目标页面：可以创建 goal_id=0 的全局对话，提示词带【全局概览】+ 当前页面；
 *   ③ 全局对话不落任何 ops（只读），但会正常回复并落库；
 *   ④ 旧目标里存过 plugins.chat=false 也不能挡住核心组件（目标对话照样能用）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3325);
const AI_PORT = Number(process.env.AI_PORT || 3324);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-chat-global-'));
const FENCE = String.fromCharCode(96, 96, 96);
const NL = String.fromCharCode(10);

let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '：' + extra : '')); console.log('  ✓ ' + name); n++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const seen = [];
const seenImgs = [];   // 每次 AI 请求实际带了几张图片（多模态通道验证）
const seenModels = []; // 每次 AI 请求用的模型（验证识图模型回退链路）
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let prompt = '';
    let imgN = 0;
    let reqModel = '';
    let isStream = true;
    try {
      const j = JSON.parse(body);
      reqModel = String(j.model || '');
      isStream = j.stream !== false;
      for (const m of (j.messages || [])) {
        if (Array.isArray(m.content)) {
          for (const p of m.content) if (p && (p.type === 'image_url' || p.image_url)) imgN++;
        }
      }
      prompt = (j.messages || []).map(function (m) {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(function (p) { return p && (p.type === 'text' || typeof p.text === 'string'); }).map(function (p) { return p.text || ''; }).join('');
        return '';
      }).join(NL);
    } catch (e) {}
    seen.push(prompt);
    seenImgs.push(imgN);
    seenModels.push(reqModel);
    /* 模拟「模型不支持识图」的上游：带图请求直接 400（服务端应据此把模型标记为不支持） */
    if (reqModel === 'text-only-model' && imgN > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model does not support image input' } }));
      return;
    }
    /* 识图模型：看到图就返回一段"识别结果"（服务端应把它回填给对话模型） */
    if (reqModel === 'vision-1') {
      const vt = '识别结果：图片里写着 HELLO-123。';
      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: vt }, finish_reason: 'stop' }], usage: { total_tokens: 8 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      for (const chunk of [vt.slice(0, 10), vt.slice(10)]) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + NL + NL);
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + NL + NL);
      res.write('data: [DONE]' + NL + NL);
      res.end();
      return;
    }
    const um = (prompt.match(/【用户的新消息】([\s\S]*?)(?:\n\n【|$)/) || [])[1] || '';
    let text = '';
    if (prompt.indexOf('【图片识别结果') >= 0) {
      text = '已按识图结果回答：HELLO-123。';
    } else if (prompt.indexOf('【你刚才请求的站内数据】') >= 0) {
      /* 第二轮：基于服务端回填的真实数据回答（测试断言里会检查这些字样来自工具结果） */
      const bits = ['全局助手已按你的问题查了站内数据。'];
      if (prompt.indexOf('AIPM JD') >= 0) bits.push('资源库里搜到资料「AIPM JD」（kind=JD）。');
      if (prompt.indexOf('default_model') >= 0) bits.push('设置里当前默认模型是 fake-model。');
      if (prompt.indexOf('页面插件') >= 0 || prompt.indexOf('kernel') >= 0) bits.push('界面管理也能读到页面插件与内核状态。');
      bits.push('需要继续查别的（设置/资源库/产出库/组件/界面/AI 任务）可以直接说。');
      text = bits.join('');
    } else if (/资料库|设置里|资源库里|产出库|组件管理|界面插件|AI 任务/.test(um)) {
      /* 第一轮：先要数据（模拟模型发起查阅） */
      text = FENCE + 'tool' + NL + JSON.stringify([
        { tool: 'settings.get', args: {} },
        { tool: 'sources.list', args: { q: 'JD', limit: 5 } },
        { tool: 'components.list', args: {} },
        { tool: 'ui.list', args: {} },
        { tool: 'tasks.list', args: {} },
        { tool: 'outlib.list', args: {} }
      ]) + NL + FENCE;
    } else {
      text = '你好，我是全局助手。我能看到全站信息。' + NL + NL + FENCE + 'ops' + NL + '[{"op":"add","title":"不该被执行的节点"}]' + NL + FENCE + NL;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
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

const SEED = {
  goals: [
    { id: 1, title: '转行 AI 产品经理（旧目标）', status: 'active', plugins: JSON.stringify({ chat: false }) },
    { id: 2, title: '30 天学会素描', status: 'active', plugins: JSON.stringify({}) }
  ],
  conditions: [{ id: 1, goal_id: 1, title: '能独立产出 PRD', detail: '', acceptance: '写一份', jd_ref: 'JD 原文：PRD', priority: 'must', source: 'plan', sort_order: 1 }],
  nodes: [
    { id: 11, goal_id: 1, parent_id: null, level: 0, title: '阶段一', condition_id: 1, sort_order: 1 },
    { id: 21, goal_id: 2, parent_id: null, level: 0, title: '几何体练习', condition_id: 0, sort_order: 1 }
  ],
  sources: [{ id: 1, goal_id: 1, title: 'AIPM JD', kind: 'JD', content: '本科及以上，北京，每周到岗 3 天', site: '用户提供的资料' }]
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
    assert.ok(up, '测试实例没起来');
    const imp = await jpost('http://127.0.0.1:' + APP_PORT + '/api/import/json', SEED);
    assert.ok(imp && imp.ok, '导入种子失败：' + JSON.stringify(imp).slice(0, 200));

    /* ① 组件元数据：核心 / 不可关闭 / 不可移除 */
    const comps = await jget('http://127.0.0.1:' + APP_PORT + '/api/components');
    const chatComp = (comps.components || []).find(c => c.id === 'chat');
    ok('AI 助手是核心组件', !!chatComp && chatComp.scope === 'core', JSON.stringify(chatComp && { scope: chatComp.scope, category: chatComp.category }));
    ok('归在「核心组件」分类', chatComp.category === '核心组件', chatComp.category);
    ok('不可移除（不可关闭）', chatComp.removable === false, String(chatComp.removable));
    ok('默认启用且始终 enabled', (comps.enabled || {}).chat === true, JSON.stringify(comps.enabled && comps.enabled.chat));

    /* ② 全局对话：goal_id=0 可创建、可聊天、提示词带全站概览与页面内容 */
    const gs = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/0/chat-sessions', {});
    const gsid = Number(gs && gs.session && gs.session.id);
    ok('无目标页面能创建全局对话（goal_id=0）', !!gsid, JSON.stringify(gs).slice(0, 160));
    seen.length = 0;
    const gdone = await chat(gsid, {
      message: '我现在都有哪些目标？资料库有多少条？',
      mode: 'agent',
      page_context: { label: '目标列表', title: '首页', route: '#/', text: '所有目标：转行 AI 产品经理、30 天学会素描' }
    });
    assert.ok(gdone, '全局对话没收到 done');
    const gp = seen[0] || '';
    ok('全局对话提示词带【全局概览】', gp.includes('【全局概览 · 思而行全站】'));
    ok('全局概览列出所有目标（含 id 与标题）', gp.includes('#1 转行 AI 产品经理') && gp.includes('#2 30 天学会素描'), gp.slice(0, 300));
    ok('全局概览带资料库/条件/教程统计', gp.includes('资料库：') && gp.includes('达成条件：') && gp.includes('教程：'));
    ok('全局对话也读当前页面内容', gp.includes('【用户当前正在看的页面】') && gp.includes('目标列表') && gp.includes('30 天学会素描'));
    ok('全局对话的 ops 一律不执行（只读）', !(gdone.applied && gdone.applied.length), JSON.stringify(gdone.applied || []));
    ok('全局对话正常回复', String(gdone.reply || '').includes('全局助手'), String(gdone.reply || '').slice(0, 60));
    ok('查数据是一次 tool 轮 + 一次回答（两轮 AI 调用）', seen.length === 2, String(seen.length));
    const gp2 = seen[1] || '';
    ok('第二轮提示词带【你刚才请求的站内数据】', gp2.includes('【你刚才请求的站内数据】'));
    ok('工具结果含资源库命中（AIPM JD 标题）', gp2.includes('AIPM JD'), gp2.slice(0, 200));
    ok('工具结果含设置里的默认模型', gp2.includes('default_model') && gp2.includes('fake-model'), '');
    ok('工具结果含组件/界面/任务/产出库数据', gp2.includes('components') && gp2.includes('pages') && gp2.includes('running'), gp2.slice(0, 200));
    ok('回复引用了查到的数据', String(gdone.reply || '').includes('AIPM JD') && String(gdone.reply || '').includes('fake-model'), String(gdone.reply || '').slice(0, 120));
    ok('本轮 trace 里记了「查了…」步骤', (gdone.trace || []).some(s => String(s.label || '').indexOf('查了「') >= 0), JSON.stringify((gdone.trace || []).map(s => s.label)));

    /* ②b 不需要查数据时：只调一次 AI，直接回答 */
    seen.length = 0;
    const dHome = await chat(gsid, {
      message: '你好，介绍一下你能做什么',
      mode: 'ask',
      page_context: { label: '设置页', title: '设置', route: '#/settings', text: 'AI 接入方式：已启用 2 条连接；模型名 deepseek-flash' }
    });
    ok('无需查数据时直接回答（只 1 次 AI 调用）', seen.length === 1, String(seen.length));
    ok('设置页正文也能进上下文（不再说看不到页面）', (seen[0] || '').includes('【用户当前正在看的页面】') && (seen[0] || '').includes('deepseek-flash'));
    ok('设置页正文出现在提示词里', (seen[0] || '').includes('设置页'), (seen[0] || '').slice(0, 120));
    const gm = await jget('http://127.0.0.1:' + APP_PORT + '/api/chat-sessions/' + gsid + '/messages');
    ok('全局对话已落库（goal_id=0）', (gm.messages || []).length >= 2 && Number(gm.session.goal_id) === 0);
    ok('全局对话没有新增节点（只读验证）', (await jget('http://127.0.0.1:' + APP_PORT + '/api/goals/1')).goal.nodes.length === 1);

    /* ③ 旧目标存过 plugins.chat=false：核心组件照样可用 */
    const os1 = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/1/chat-sessions', {});
    const sid1 = Number(os1 && os1.session && os1.session.id);
    ok('目标曾关闭 AI 助手也能建对话（核心不可关）', !!sid1, JSON.stringify(os1).slice(0, 160));
    const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const cv1 = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=fake-model');
    const cvNo0 = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=text-only-model');
    const cv2 = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=gpt-4o');
    ok('默认当作能识图：没见过的模型 can-vision 也返回 ok', cv1 && cv1.ok === true, JSON.stringify(cv1));
    ok('还没被标记的模型也默认能识图（先试一次）', cvNo0 && cvNo0.ok === true && !cvNo0.learned_unsupported, JSON.stringify(cvNo0));
    ok('识图能力查询：gpt-4o 支持', cv2 && cv2.ok === true, JSON.stringify(cv2));

    /* ④a 先发过去：上游 400 说不能识图 → 友好回复 + 自动把这个模型标记为不支持 */
    const sNo = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/0/chat-sessions', { model: 'text-only-model' });
    const sidNo = Number(sNo && sNo.session && sNo.session.id);
    ok('可以建一条用「不支持识图」模型的对话', !!sidNo, JSON.stringify(sNo).slice(0, 120));
    seen.length = 0; seenImgs.length = 0;
    const dNo1 = await chat(sidNo, { message: '这张图里写了什么？', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('模型回应不能识图时明确回复不能识别', String(dNo1.reply || '').includes('不支持识别图片'), String(dNo1.reply || '').slice(0, 80));
    ok('默认先尝试：带图请求确实发给了 AI（1 次）', seen.length === 1, String(seen.length));
    ok('回复里说明已把模型标记为不支持识图', String(dNo1.reply || '').includes('已把它标记'), String(dNo1.reply || '').slice(0, 120));
    const cvNo1 = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=text-only-model');
    ok('模型已被标记：can-vision 变 false + learned_unsupported', cvNo1 && cvNo1.ok === false && cvNo1.learned_unsupported === true, JSON.stringify(cvNo1));

    /* ④b 标记之后：直接提示，不再发起 AI 请求 */
    seen.length = 0; seenImgs.length = 0;
    const dNo2 = await chat(sidNo, { message: '再看看这张图', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('已标记的模型发图直接提示不能识别', String(dNo2.reply || '').includes('不支持识别图片'), String(dNo2.reply || '').slice(0, 80));
    ok('已标记后不再调用 AI（省一次请求）', seen.length === 0, String(seen.length));
    const gmUn = await jget('http://127.0.0.1:' + APP_PORT + '/api/chat-sessions/' + sidNo + '/messages');
    const lastUser = (gmUn.messages || []).filter(m => m.role === 'user').slice(-1)[0] || {};
    let lastUserImgs = [];
    try { lastUserImgs = JSON.parse(lastUser.images || '[]'); } catch (e) {}
    ok('用户发的图在库里留了缩略图（刷新还能看到）', lastUserImgs.length === 1 && String(lastUserImgs[0]).indexOf('data:image/') === 0, JSON.stringify(lastUserImgs).slice(0, 80));

    /* ④c 重新保存 AI 连接 → 清掉标记（用户换配置后可再试一次） */
    const connsNow = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/connections');
    await jpost('http://127.0.0.1:' + APP_PORT + '/api/ai/connections', { connections: connsNow.connections || [] });
    const cvNo2 = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=text-only-model');
    ok('重新保存 AI 连接会清空「不支持识图」标记', cvNo2 && cvNo2.ok === true && cvNo2.learned_unsupported === false, JSON.stringify(cvNo2));

    /* ④d 支持多模态的模型：图片真的随请求发给了 AI */
    const sup = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/0/chat-sessions', { model: 'gpt-4o' });
    const sidSup = Number(sup && sup.session && sup.session.id);
    ok('可以建一条指定多模态模型的对话', !!sidSup, JSON.stringify(sup).slice(0, 120));
    seen.length = 0; seenImgs.length = 0;
    const dSup = await chat(sidSup, { message: '这张图里写了什么？', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('多模态模型正常回答', !!dSup && String(dSup.reply || '').includes('全局助手'), String((dSup && dSup.reply) || '').slice(0, 60));
    ok('图片确实作为图片输入发给了 AI', seenImgs[seenImgs.length - 1] === 1, JSON.stringify(seenImgs));
    ok('提示词里说明了这次带了 1 张图片', (seen[seen.length - 1] || '').includes('【用户这次还发了 1 张图片】'));

    /* ④e 目标对话（streamChat）同样会学习：先试一次 → 标记 → 第二次不再调用 */
    const og2 = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/1/chat-sessions', { model: 'text-only-model' });
    const sidG2 = Number(og2 && og2.session && og2.session.id);
    seen.length = 0;
    const dGoalImg = await chat(sidG2, { message: '这张图里写了什么？', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('目标对话：模型回应不能识图时明确回复', String(dGoalImg.reply || '').includes('不支持识别图片'), String(dGoalImg.reply || '').slice(0, 80));
    ok('目标对话：默认也先尝试一次 AI', seen.length === 1, String(seen.length));
    seen.length = 0;
    const dGoalImg2 = await chat(sidG2, { message: '再看一眼', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('目标对话：标记后第二次不再调用 AI', seen.length === 0 && String(dGoalImg2.reply || '').includes('不支持识别图片'), String(seen.length));

    /* ④f 设置里配了识图模型：当前模型不能识图时 → 自动用识图模型识别，再交给对话模型回答 */
    await jpost('http://127.0.0.1:' + APP_PORT + '/api/settings', { vis_base_url: 'http://127.0.0.1:' + AI_PORT + '/v1', vision_model: 'vision-1', vis_api_key: 'test-key' });
    const cvFb = await jget('http://127.0.0.1:' + APP_PORT + '/api/ai/can-vision?model=text-only-model');
    ok('can-vision 暴露配置的识图模型（fallback_model）', cvFb && cvFb.fallback_model === 'vision-1', JSON.stringify(cvFb));
    const sFb = await jpost('http://127.0.0.1:' + APP_PORT + '/api/goals/0/chat-sessions', { model: 'text-only-model' });
    const sidFb = Number(sFb && sFb.session && sFb.session.id);
    seen.length = 0; seenImgs.length = 0; seenModels.length = 0;
    const dFb = await chat(sidFb, { message: '这张图里写了什么？', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('配了识图模型后自动回退识别并回答', !!dFb && String(dFb.reply || '').includes('已按识图结果回答') && String(dFb.reply || '').includes('HELLO-123'), String((dFb && dFb.reply) || '').slice(0, 160));
    ok('先调识图模型、再用对话模型回答', seenModels.length === 2 && seenModels[0] === 'vision-1' && seenModels[1] === 'text-only-model', JSON.stringify(seenModels));
    ok('识图请求带图、对话请求不带图', seenImgs[0] === 1 && seenImgs[1] === 0, JSON.stringify(seenImgs));
    ok('对话模型提示词里带【图片识别结果】', (seen[1] || '').includes('【图片识别结果') && (seen[1] || '').includes('HELLO-123'), (seen[1] || '').slice(-200));
    ok('回退识别时 trace 里记了「用识图模型…」', (dFb.trace || []).some(s => String(s.label || '').indexOf('用识图模型') >= 0), JSON.stringify((dFb.trace || []).map(s => s.label)));

    /* ④g 明确能识图的模型：仍然直接把图发给它，不绕识图模型 */
    seen.length = 0; seenImgs.length = 0; seenModels.length = 0;
    const dSup2 = await chat(sidSup, { message: '这张图里写了什么？', mode: 'ask', images: [IMG], image_thumbs: [IMG] });
    ok('能识图的模型仍直接收到图片', !!dSup2 && String(dSup2.reply || '').includes('全局助手') && seenModels.length === 1 && seenModels[0] === 'gpt-4o' && seenImgs[0] === 1, JSON.stringify({ models: seenModels, imgs: seenImgs }));

    /* 收尾：清空识图模型配置 */
    await jpost('http://127.0.0.1:' + APP_PORT + '/api/settings', { vis_base_url: '', vision_model: '', vis_api_key: '' });

    console.log(NL + n + ' 项全部通过');
  } finally {
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(NL + '失败：' + (e && e.message)); process.exit(1); });
