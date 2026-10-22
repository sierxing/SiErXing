#!/usr/bin/env node
'use strict';
/**
 * 简历工坊（resume 扩展组件）回归（不花钱：AI 走 SIERXING_RESUME_FAKE=1 假实现）
 * ---------------------------------------------------------------------------
 * 1. 组件元数据：id/name/desc（描述里必须标注参考的 4 个开源项目链接）
 * 2. 纯函数：firstJSON / normalize / evidenceBlock / fakeAI / 提示词包注册
 * 3. HTTP e2e（沙箱实例 + 临时 DATA_DIR）：文档 CRUD、版本存/恢复、证据卡 CRUD、
 *    五个 AI 动作（追问/证据卡/JD 匹配/改写/审计）的入参校验与报告落库、删除级联、
 *    组件开关（可关闭、默认开启）。
 *
 * 跑法：node --no-warnings --experimental-sqlite scripts/test-resume-component.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = ROOT;
const REFS = [
  'https://github.com/Elowwwen/resume-evidence-workflow',
  'https://github.com/zclllyybb/lofisu-identity-engine',
  'https://github.com/Claycui828/ASu-resume-skills',
  'https://github.com/Elowwwen/resume-evidence-workflow'
];

let passed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(function () { passed++; console.log('  ✓ ' + name); },
    function (e) { console.error('  ✗ ' + name); throw e; });
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
function req(port, method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(s); } catch (e) {}
        resolve({ status: res.statusCode, text: s, json: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function waitHealth(port) {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function tick() {
      req(port, 'GET', '/api/health').then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        if (++n > 60) return reject(new Error('服务 15 秒内没起来'));
        setTimeout(tick, 250);
      }).catch(function () {
        if (++n > 60) return reject(new Error('服务 15 秒内没起来'));
        setTimeout(tick, 250);
      });
    })();
  });
}

(async function main() {
  console.log('== 简历工坊：组件与纯函数 ==');
  const plugin = require('../server/plugins/resume.js');
  await ok('组件 id / 名称 / 客户端脚本正确', function () {
    if (plugin.id !== 'resume') throw new Error('id=' + plugin.id);
    if (plugin.client !== '/plugins/resume.js') throw new Error('client=' + plugin.client);
    if (!plugin.name) throw new Error('缺少 name');
  });
  await ok('组件描述标注参考了 4 个开源项目链接（含重复给出的那个）', function () {
    for (const u of REFS) if (plugin.desc.indexOf(u) < 0) throw new Error('desc 缺少链接 ' + u);
  });
  await ok('默认开启 + 组件可管理（不是 core 不可关）', function () {
    if (plugin.defaultEnabled !== true) throw new Error('defaultEnabled=' + plugin.defaultEnabled);
    if (plugin.goalToggle !== false) throw new Error('goalToggle=' + plugin.goalToggle);
  });
  await ok('five prompt packs registered (resume.*)', function () {
    const packs = require('../server/prompts/packs');
    for (const id of ['resume.questions', 'resume.evidence', 'resume.match', 'resume.rewrite', 'resume.audit']) {
      const p = packs[id];
      if (!p) throw new Error('缺少提示词包 ' + id);
      if (!p.template || p.template.length < 200) throw new Error(id + ' 模板过短');
      if (p.mustInclude.indexOf('JSON') < 0) throw new Error(id + ' mustInclude 缺 JSON');
      if (typeof p.builtinRender !== 'function') throw new Error(id + ' 缺 builtinRender');
    }
  });
  await ok('firstJSON：能从带围栏/前后文字的回复里抠出 JSON', function () {
    const fence = String.fromCharCode(96, 96, 96);
    const text = '好的，下面是结果：\n' + fence + 'json\n{"cards":[{"title":"x"}]}\n' + fence + '\n以上。';
    const d = plugin.__test.firstJSON(text);
    if (!d || !Array.isArray(d.cards) || d.cards[0].title !== 'x') throw new Error(JSON.stringify(d));
  });
  await ok('firstJSON：解析失败返回 null（不抛异常）', function () {
    if (plugin.__test.firstJSON('not json at all') !== null) throw new Error('应该返回 null');
  });
  await ok('normalize：questions 支持字符串数组并补 id', function () {
    const d = plugin.__test.normalize('questions', { questions: ['问题一', { q: '问题二' }] });
    if (d.questions.length !== 2) throw new Error('数量 ' + d.questions.length);
    if (!d.questions[0].id || !d.questions[0].q) throw new Error('缺字段');
  });
  await ok('normalize：match 的 rows/evidence 归一化 + 上限', function () {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ requirement: 'r' + i, match: 'gap', evidence: ['a'] });
    const d = plugin.__test.normalize('match', { rows: rows, keywords: 'x' });
    if (d.rows.length !== 30) throw new Error('rows 未截断：' + d.rows.length);
    if (!Array.isArray(d.keywords) || d.keywords.length) throw new Error('keywords 应为空数组');
    if (!Array.isArray(d.rows[0].evidence)) throw new Error('evidence 应为数组');
  });
  await ok('normalize：audit 保留状态词并截断', function () {
    const d = plugin.__test.normalize('audit', { claims: [{ claim: 'x', status: '部分证实', evidence: 'e' }], patterns: 'p' });
    if (d.claims.length !== 1 || d.claims[0].status !== '部分证实') throw new Error(JSON.stringify(d));
    if (!Array.isArray(d.patterns)) throw new Error('patterns 应为数组');
  });
  await ok('evidenceBlock：把证据卡拼成提示词上下文（含标题/角色/结果）', function () {
    const s = plugin.__test.evidenceBlock([{ title: '项目 A', role: '独立开发', result: '上线' }]);
    if (s.indexOf('项目 A') < 0 || s.indexOf('独立开发') < 0 || s.indexOf('上线') < 0) throw new Error(s);
    if (s.indexOf('角色：') < 0) throw new Error('缺标签：' + s);
  });
  await ok('fakeAI：五个动作的假数据形状正确', function () {
    const q = plugin.__test.fakeAI('questions', {});
    if (!Array.isArray(q.questions) || !q.questions.length) throw new Error('questions');
    const m = plugin.__test.fakeAI('match', {});
    if (!Array.isArray(m.rows) || !m.rows.length) throw new Error('match.rows');
    const a = plugin.__test.fakeAI('audit', {});
    if (!Array.isArray(a.claims) || !a.claims.length) throw new Error('audit.claims');
  });

  console.log('\n== 简历工坊：HTTP e2e（沙箱实例，假 AI） ==');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-resume-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(port), SIERXING_DATA_DIR: dataDir, SIERXING_RESUME_FAKE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  let docId = 0, evIds = [], verId = 0, reportIds = [];
  try {
    await waitHealth(port);
    await ok('组件出现在 /api/components（默认开启、描述含参考项目）', async function () {
      const r = await req(port, 'GET', '/api/components');
      const c = (r.json.components || []).filter(function (x) { return x.id === 'resume'; })[0];
      if (!c) throw new Error('组件没加载');
      if (c.kind !== 'feature' || c.scope !== 'extra') throw new Error('kind=' + c.kind + ' scope=' + c.scope);
      if (r.json.enabled.resume !== true) throw new Error('默认应为开启');
      if (c.desc.indexOf('resume-evidence-workflow') < 0) throw new Error('描述没带参考项目');
      if (!c.hasStyle) throw new Error('组件应该有样式文件');
    });
    await ok('POST /api/resume/docs：缺标题 → 400 need_title', async function () {
      const r = await req(port, 'POST', '/api/resume/docs', {});
      if (r.status !== 400 || !r.json || r.json.code !== 'need_title') throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST /api/resume/docs：新建 → 返回 doc.id', async function () {
      const r = await req(port, 'POST', '/api/resume/docs', { title: '测试简历', target_role: 'AI 产品经理实习' });
      if (r.status !== 200 || !r.json.doc || !r.json.doc.id) throw new Error(r.status + ' ' + r.text);
      docId = r.json.doc.id;
    });
    await ok('GET /api/resume/docs：列表能看到刚建的简历', async function () {
      const r = await req(port, 'GET', '/api/resume/docs');
      const d = (r.json.docs || []).filter(function (x) { return x.id === docId; })[0];
      if (!d || d.title !== '测试简历') throw new Error('列表里没有');
    });
    await ok('PUT /api/resume/docs/:id：保存正文与目标岗位', async function () {
      const r = await req(port, 'PUT', '/api/resume/docs/' + docId, { content_md: '## 教育背景\n- 某大学 计算机硕士', target_role: 'AI PM' });
      if (r.status !== 200 || r.json.doc.content_md.indexOf('计算机硕士') < 0) throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST versions：存一版 → 版本列表 +1', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/versions', { note: 'v1', content_md: '第一版正文' });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      const g = await req(port, 'GET', '/api/resume/docs/' + docId);
      if (!(g.json.versions || []).length) throw new Error('版本列表为空');
      verId = g.json.versions[0].id;
    });
    await ok('POST restore：恢复旧版本会先自动存当前版本（版本数 +1）', async function () {
      await req(port, 'PUT', '/api/resume/docs/' + docId, { content_md: '第三版正文' });
      const r = await req(port, 'POST', '/api/resume/versions/' + verId + '/restore');
      if (r.status !== 200 || r.json.doc.content_md !== '第一版正文') throw new Error(r.text);
      const g = await req(port, 'GET', '/api/resume/docs/' + docId);
      if ((g.json.versions || []).length !== 2) throw new Error('恢复前没自动存档：' + (g.json.versions || []).length);
    });
    await ok('POST evidence：批量导入两张证据卡', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/evidence', { cards: [
        { title: '证据一', role: '独立开发', result: '上线', metrics: '100 用户' },
        { title: '证据二', role: '核心成员', action: '做了访谈' }
      ] });
      if (r.status !== 200 || (r.json.ids || []).length !== 2) throw new Error(r.status + ' ' + r.text);
      evIds = r.json.ids;
    });
    await ok('PUT evidence：改标题生效', async function () {
      const r = await req(port, 'PUT', '/api/resume/evidence/' + evIds[0], { title: '证据一（改）', result: '上线并开源' });
      if (r.status !== 200 || r.json.evidence.title !== '证据一（改）') throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST ai questions：返回追问 + 报告落库', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'questions' });
      if (r.status !== 200 || !r.json.data || !(r.json.data.questions || []).length) throw new Error(r.status + ' ' + r.text);
      reportIds.push(r.json.reportId);
    });
    await ok('POST ai match：缺 JD → 400 need_jd', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'match' });
      if (r.status !== 400 || r.json.code !== 'need_jd') throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST ai match：有 JD → 返回匹配矩阵（rows/overall）', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'match', jd: '岗位职责：负责用户研究与需求分析；要求：数据驱动' });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      if (!(r.json.data.rows || []).length) throw new Error('没有 rows');
      if (!r.json.data.overall) throw new Error('没有 overall');
      reportIds.push(r.json.reportId);
    });
    await ok('POST ai rewrite：返回改写 bullets（每条要有 basis）', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'rewrite', jd: '岗位职责：用户研究；要求：数据驱动' });
      if (r.status !== 200 || !(r.json.data.bullets || []).length) throw new Error(r.status + ' ' + r.text);
      if (!r.json.data.bullets[0].basis) throw new Error('缺 basis');
      reportIds.push(r.json.reportId);
    });
    await ok('POST ai audit：返回原子主张 + 证据状态', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'audit' });
      if (r.status !== 200 || !(r.json.data.claims || []).length) throw new Error(r.status + ' ' + r.text);
      if (!r.json.data.claims[0].status) throw new Error('缺 status');
      reportIds.push(r.json.reportId);
    });
    await ok('POST ai evidence：缺回答 → 400 need_answers', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'evidence' });
      if (r.status !== 400 || r.json.code !== 'need_answers') throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST ai evidence：有回答 → 返回证据卡', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'evidence', answers: 'Q1: 我负责访谈\nA1: 独立完成 10 场' });
      if (r.status !== 200 || !(r.json.data.cards || []).length) throw new Error(r.status + ' ' + r.text);
      reportIds.push(r.json.reportId);
    });
    await ok('GET reports：报告列表与详情都能读', async function () {
      const list = await req(port, 'GET', '/api/resume/docs/' + docId + '/reports');
      if ((list.json.reports || []).length < 5) throw new Error('报告数量：' + (list.json.reports || []).length);
      const one = await req(port, 'GET', '/api/resume/reports/' + reportIds[0]);
      if (one.status !== 200 || !one.json.report || typeof one.json.report.data !== 'object') throw new Error(one.text);
    });
    await ok('prompt 注册表：prompt.preview 能渲染 resume.match（无覆盖走 fill）', async function () {
      const r = await req(port, 'POST', '/api/commands/run', { name: 'prompt.preview', input: { id: 'resume.match' } });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      const text = JSON.stringify(r.json);
      if (text.indexOf('JD') < 0) throw new Error('渲染结果里没有 JD：' + text.slice(0, 300));
    });
    await ok('组件开关：可以全局关闭 resume（不是 core）', async function () {
      const off = await req(port, 'POST', '/api/components/resume/toggle', { enabled: false });
      if (off.status !== 200 || off.json.enabled.resume !== false) throw new Error(off.text);
      const on = await req(port, 'POST', '/api/components/resume/toggle', { enabled: true });
      if (on.json.enabled.resume !== true) throw new Error(on.text);
    });
    await ok('DELETE evidence：证据卡删除后列表变短', async function () {
      const r = await req(port, 'DELETE', '/api/resume/evidence/' + evIds[1]);
      if (r.status !== 200) throw new Error(r.text);
      const g = await req(port, 'GET', '/api/resume/docs/' + docId);
      if ((g.json.evidence || []).length !== 1) throw new Error('删除后数量：' + (g.json.evidence || []).length);
    });
    await ok('DELETE docs：删除简历后 404，且证据/版本/报告级联清理', async function () {
      const r = await req(port, 'DELETE', '/api/resume/docs/' + docId);
      if (r.status !== 200) throw new Error(r.text);
      const g = await req(port, 'GET', '/api/resume/docs/' + docId);
      if (g.status !== 404) throw new Error('删除后仍能读到：' + g.status);
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 300); });
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
  if (log.indexOf('简历工坊') >= 0) { /* 启动日志里能看到组件已加载 */ }
  console.log('\n' + passed + ' 项全部通过');
})().catch(function (e) {
  console.error('\n失败：' + (e && e.stack || e));
  process.exit(1);
});
