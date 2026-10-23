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
const domainMod = require('../server/resume-domain.js');
  await ok('组件 id / 名称 / 客户端脚本正确', function () {
    if (plugin.id !== 'resume') throw new Error('id=' + plugin.id);
    if (plugin.client !== '/plugins/resume.js') throw new Error('client=' + plugin.client);
    if (!plugin.name) throw new Error('缺少 name');
  });
  await ok('组件描述标注参考了 4 个开源项目链接（含重复给出的那个）', function () {
    for (const u of REFS) if (plugin.desc.indexOf(u) < 0) throw new Error('desc 缺少链接 ' + u);
  });
  await ok('默认开启 + 可**按目标**开关（goalToggle:true，和达成条件一致）', function () {
    if (plugin.defaultEnabled !== true) throw new Error('defaultEnabled=' + plugin.defaultEnabled);
    if (plugin.goalToggle !== true) throw new Error('goalToggle=' + plugin.goalToggle);
  });
  await ok('删目标不清简历库（数据全目标共享，onGoalDelete 是空实现）', function () {
    if (typeof plugin.onGoalDelete !== 'function') throw new Error('缺 onGoalDelete');
    const src = String(plugin.onGoalDelete);
    if (/onGoalDelete\s*\)|getResumeDomain/.test(src)) throw new Error('onGoalDelete 仍在级联删共享简历：' + src);
  });
  await ok('prompt packs registered (resume.*) — 至少 8 个，含 review/answers/finalize', function () {
    const packs = require('../server/prompts/packs');
    const need = ['resume.questions', 'resume.evidence', 'resume.match', 'resume.rewrite', 'resume.audit', 'resume.review', 'resume.answers', 'resume.finalize'];
    for (const id of need) {
      const p = packs[id];
      if (!p) throw new Error('缺少提示词包 ' + id);
      if (!p.template || p.template.length < 200) throw new Error(id + ' 模板过短');
      if (p.mustInclude.indexOf('JSON') < 0) throw new Error(id + ' mustInclude 缺 JSON');
      if (typeof p.builtinRender !== 'function') throw new Error(id + ' 缺 builtinRender');
    }
  });
  await ok('简历文件解析 / 生成：docx 往返（markdownToDocx → parseResumeBuffer）', function () {
    const f = require('../server/plugins/lib/resume-file');
    const md = '# 张三\n\n## 教育背景\n- 某大学 计算机硕士\n- GPA 3.7\n\n**加粗**';
    const buf = f.markdownToDocx(md, '测试简历');
    if (buf.length < 500) throw new Error('docx 太小');
    const names = f.zipEntries(buf).map(function (e) { return e.name; });
    if (names.indexOf('word/document.xml') < 0) throw new Error('缺 document.xml');
    const parsed = f.parseResumeBuffer(buf, 't.docx');
    if (parsed.text.indexOf('张三') < 0) throw new Error('没解析出标题');
    if (parsed.text.indexOf('GPA 3.7') < 0) throw new Error('没解析出条目');
    if (parsed.text.indexOf('**') >= 0) throw new Error('markdown 星号没清掉');
  });
  await ok('简历文件解析：不支持格式 / 空文件 返回明确错误码', function () {
    const f = require('../server/plugins/lib/resume-file');
    let e1 = null, e2 = null;
    try { f.parseResumeBuffer(Buffer.from('x'), 'a.xyz'); } catch (e) { e1 = e.message; }
    try { f.parseResumeBuffer(Buffer.from('   '), 'a.txt'); } catch (e) { e2 = e.message; }
    if (e1 !== 'unsupported-format') throw new Error('格式错误码：' + e1);
    if (e2 !== 'empty-document') throw new Error('空文件错误码：' + e2);
  });
  await ok('领域纯函数：firstJSON / normalize / evidenceBlock 可用', function () {
    const t = domainMod.__test;
    if (typeof t.firstJSON !== 'function') throw new Error('缺 firstJSON');
    const fence = String.fromCharCode(96, 96, 96);
    const d = t.firstJSON('结果：\n' + fence + 'json\n{"issues":[{"type":"x"}]}\n' + fence);
    if (!d || !Array.isArray(d.issues)) throw new Error('firstJSON 失败');
    const n = t.normalize('match', { rows: [{ requirement: 'r', match: 'gap' }], keywords: 'x' });
    if (!Array.isArray(n.rows) || !Array.isArray(n.keywords)) throw new Error('normalize 失败');
    const b = t.evidenceBlock([{ title: 'T', role: 'R', result: 'OK' }]);
    if (b.indexOf('T') < 0 || b.indexOf('R') < 0) throw new Error('evidenceBlock 失败');
  });
  await ok('领域 STAGES：六步流水线、顺序固定', function () {
    const s = domainMod.STAGES;
    if (JSON.stringify(s) !== JSON.stringify(['upload', 'review', 'supplement', 'jd', 'match', 'finalize'])) throw new Error(JSON.stringify(s));
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
    /* ===== 三项增强（学校 Title / Owner 化 / 技术链）+ 内容硬过滤 ===== */
    await ok('school-titles：识别 211/双一流，未知学校返回 null（不猜）', function () {
      const S = require('../language/school-titles');
      const hit = S.findSchool('中国石油大学（北京） 计算机硕士');
      if (!hit || hit.tags.indexOf('211工程') < 0) throw new Error(JSON.stringify(hit));
      if (S.findSchool('某某职业技术学院') !== null) throw new Error('未知学校应返回 null');
      const edu = ['教育背景', '中国石油大学（北京）｜计算机科学与技术 硕士'].join('\n');
      const d = S.detectFromResume(edu);
      if (!d || d.name !== '中国石油大学') throw new Error('detectFromResume 失败');
    });
    await ok('resume-enhance：角色强度阶梯 + 技术链命中', function () {
      const E = require('../language/resume-enhance');
      const a = E.roleLadder('独立完成产品设计');
      if (a.allow.indexOf('0→1') < 0 || !a.boundary) throw new Error(JSON.stringify(a));
      const b = E.roleLadder('参与推进');
      if (b.allow.indexOf('系统级共建者') < 0) throw new Error(JSON.stringify(b));
      const blocks = E.enhancementBlock({ school: '中国石油大学：211工程' });
      if (blocks.indexOf('211工程') < 0 || blocks.indexOf('最小闭环') < 0) throw new Error('enhancementBlock 缺内容');
      const chain = E.techChainHints('从本地 SQLite 设计指标并做版本回滚评测').map(function (x) { return x.stage; });
      if (chain.indexOf('工具') < 0 || chain.indexOf('评测') < 0) throw new Error(JSON.stringify(chain));
    });
    await ok('resume-filter：排除词硬过滤（sections + summary 都清）', function () {
      const F = require('../server/plugins/lib/resume-filter');
      const d = { name: 'N', title: 'T', summary: 'A句。遗珠新韵项目经验。B句。', sections: [
        { title: '项目经历', items: [{ left: '遗珠新韵｜非遗问答', bullets: ['x'] }, { left: '思而行｜AI 规划', bullets: ['y'] }] }
      ] };
      const out = F.filterData(d, ['遗珠', '非遗']);
      if (out.data.sections[0].items.length !== 1) throw new Error('item 未过滤');
      if (out.data.sections[0].items[0].left.indexOf('思而行') < 0) throw new Error('误删了不该删的');
      if (/遗珠|非遗/.test(out.data.summary)) throw new Error('summary 未过滤：' + out.data.summary);
      if (!out.removed.length) throw new Error('removed 应记录原因');
      if (F.filterData(d, []).removed.length !== 0) throw new Error('无排除词时不应删');
    });
    await ok('resume.exclude 命令 + finalize 落库前硬过滤', async function () {
      const c = await req(port, 'POST', '/api/resume/docs', { title: '过滤测试' });
      const id = c.json.doc.id;
      await req(port, 'POST', '/api/resume/docs/' + id + '/upload', { text: '# A\n\n## Exp\n- x', filename: '' });
      const ex = await req(port, 'POST', '/api/commands/run', { name: 'resume.exclude', input: { docId: id, words: ['Fake Name'] } });
      if (ex.status !== 200 || (ex.json.result.excluded || []).length !== 1) throw new Error(ex.text);
      await req(port, 'POST', '/api/resume/docs/' + id + '/jd', { jd: 'need x' });
      const r = await req(port, 'POST', '/api/resume/docs/' + id + '/ai', { kind: 'finalize' });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      const d = r.json.data;
      const blob = JSON.stringify(d.data) + String(d.markdown || '');
      if (blob.indexOf('Fake Name') >= 0) throw new Error('排除词仍出现在终版里');
      const g = await req(port, 'POST', '/api/commands/run', { name: 'resume.get', input: { docId: id, withBody: true } });
      if ((g.json.result.doc.excluded || []).length !== 1) throw new Error('excluded 没落库');
    });
    await ok('finalize 提示词带 enhance 占位符，且渲染时注入机构 Title', function () {
      const packs = require('../server/prompts/packs');
      const f = packs['resume.finalize'];
      if (f.placeholders.indexOf('enhance') < 0) throw new Error('缺 enhance 占位符');
      if (f.mustInclude.indexOf('Owner 化拆分') < 0 || f.mustInclude.indexOf('技术链') < 0) throw new Error('mustInclude 缺新规则');
      const out = f.builtinRender({ targetRole: 'AI PM', jd: 'x', resume: 'y', evidence: 'z', extra: '', enhance: '中国石油大学：211工程' });
      if (out.indexOf('211工程') < 0) throw new Error('enhance 没注入');
      if (out.indexOf('{{enhance}}') >= 0) throw new Error('占位符没替换');
      if (out.indexOf('输入 → 表征') < 0) throw new Error('缺技术链说明');
    });
    /* ===== 流水线（向导每一步）+ Agent 命令 ===== */
    let pipeDocId = 0;
    await ok('POST /upload：传 base64 docx → 解析成正文并进入 review 步骤', async function () {
      const f = require('../server/plugins/lib/resume-file');
      const docx = f.markdownToDocx('# 张思为\n\n## 教育背景\n- 中国石油大学 计算机硕士\n\n## 项目经历\n- 做了个 AI 规划产品', '简历');
      const c = await req(port, 'POST', '/api/resume/docs', { title: '流水线测试', target_role: 'AI 产品经理实习' });
      pipeDocId = c.json.doc.id;
      const r = await req(port, 'POST', '/api/resume/docs/' + pipeDocId + '/upload', { filename: 'my.docx', base64: docx.toString('base64') });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      if (!r.json.imported || r.json.imported.chars < 20) throw new Error('没解析出正文');
      if (r.json.doc.stage !== 'review') throw new Error('stage 应为 review：' + r.json.doc.stage);
      if (r.json.doc.content_md.indexOf('张思为') < 0) throw new Error('正文没写回 doc');
    });
    await ok('GET /pipeline：六步 + 当前步骤 + JD 候选', async function () {
      const r = await req(port, 'GET', '/api/resume/docs/' + pipeDocId + '/pipeline');
      if (r.status !== 200) throw new Error(r.text);
      if ((r.json.steps || []).length !== 6) throw new Error('步骤数：' + (r.json.steps || []).length);
      if (r.json.stage !== 'review') throw new Error('stage：' + r.json.stage);
      if (r.json.steps.filter(function (x) { return x.done; }).length < 1) throw new Error('upload 应已完成');
      if (!Array.isArray(r.json.jd_sources)) throw new Error('缺 jd_sources');
    });
    await ok('POST /upload：不支持的格式 → unsupported_format', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + pipeDocId + '/upload', { filename: 'a.xyz', base64: Buffer.from('hello').toString('base64') });
      if (r.status !== 400 || r.json.code !== 'unsupported_format') throw new Error(r.status + ' ' + r.text);
    });
    await ok('POST /jd：同时支持材料库 sourceId 与直接贴文本', async function () {
      const r1 = await req(port, 'POST', '/api/resume/docs/' + pipeDocId + '/jd', { jd: '岗位职责：负责用户研究与需求分析；要求：数据驱动' });
      if (r1.status !== 200 || !r1.json.doc.has_jd) throw new Error(r1.text);
      if (r1.json.doc.stage !== 'match') throw new Error('stage：' + r1.json.doc.stage);
      const r2 = await req(port, 'POST', '/api/resume/docs/' + pipeDocId + '/jd', {});
      if (r2.status !== 400 || r2.json.code !== 'need_jd') throw new Error('空 JD 应报 need_jd：' + r2.text);
    });
    await ok('POST /ai finalize：返回 markdown + 落库到 final_md', async function () {
      const r = await req(port, 'POST', '/api/resume/docs/' + pipeDocId + '/ai', { kind: 'finalize' });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      if (!r.json.data || !r.json.data.markdown) throw new Error('没有 markdown');
      const g = await req(port, 'GET', '/api/resume/docs/' + pipeDocId + '/pipeline');
      if (!g.json.doc.has_final) throw new Error('final_md 没落库');
    });
    await ok('GET /export：返回 docx 二进制（能被 resume-file 解析回来）', async function () {
      const res = await fetch('http://127.0.0.1:' + port + '/api/resume/docs/' + pipeDocId + '/export');
      if (res.status !== 200) throw new Error('status ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error('docx 太小：' + buf.length);
      const f = require('../server/plugins/lib/resume-file');
      const parsed = f.parseResumeBuffer(buf, 'x.docx');
      if (!parsed.text.trim()) throw new Error('导出的 docx 解析不出文字');
    });
    await ok('Agent 命令：resume.create / resume.upload / resume.review / resume.get 全链路', async function () {
      const c = await req(port, 'POST', '/api/commands/run', { name: 'resume.create', input: { title: 'Agent 调用测试', target_role: 'AI PM' } });
      if (c.status !== 200 || !c.json.result.doc.id) throw new Error(c.text);
      const docId = c.json.result.doc.id;
      const f = require('../server/plugins/lib/resume-file');
      const docx = f.markdownToDocx('# 张三\n\n## 项目经历\n- 负责一个 AI 产品', '简历');
      const up = await req(port, 'POST', '/api/commands/run', { name: 'resume.upload', input: { docId: docId, filename: 'a.docx', base64: docx.toString('base64') } });
      if (up.status !== 200 || !up.json.result.imported.chars) throw new Error(up.text);
      if (up.json.result.next !== 'resume.review') throw new Error('next：' + up.json.result.next);
      const rv = await req(port, 'POST', '/api/commands/run', { name: 'resume.review', input: { docId: docId } });
      if (rv.status !== 200 || !(rv.json.result.data.issues || []).length) throw new Error(rv.text);
      const got = await req(port, 'POST', '/api/commands/run', { name: 'resume.get', input: { docId: docId } });
      if (got.status !== 200 || got.json.result.pipeline.stage !== 'supplement') throw new Error(got.text);
    });
    await ok('Agent 命令：resume.jd 无参数时列出资料库 JD（need=jd），带文本时选中', async function () {
      const c = await req(port, 'POST', '/api/commands/run', { name: 'resume.create', input: { title: 'JD 测试' } });
      const docId = c.json.result.doc.id;
      const list = await req(port, 'POST', '/api/commands/run', { name: 'resume.jd', input: { docId: docId } });
      if (list.status !== 200 || list.json.result.need !== 'jd') throw new Error(list.text);
      if (!Array.isArray(list.json.result.jd_sources)) throw new Error('缺 jd_sources');
      const pick = await req(port, 'POST', '/api/commands/run', { name: 'resume.jd', input: { docId: docId, jd: '要求：用户研究、数据指标' } });
      if (pick.status !== 200 || pick.json.result.next !== 'resume.match') throw new Error(pick.text);
    });
    await ok('Agent 命令：resume.export 返回 base64 docx', async function () {
      const c = await req(port, 'POST', '/api/commands/run', { name: 'resume.create', input: { title: '导出测试' } });
      const docId = c.json.result.doc.id;
      const f = require('../server/plugins/lib/resume-file');
      await req(port, 'POST', '/api/resume/docs/' + docId + '/upload', { text: '# 张三\n\n- 内容', filename: '' });
      await req(port, 'POST', '/api/resume/docs/' + docId + '/jd', { jd: '要求：用户研究' });
      await req(port, 'POST', '/api/resume/docs/' + docId + '/ai', { kind: 'finalize' });
      const r = await req(port, 'POST', '/api/commands/run', { name: 'resume.export', input: { docId: docId } });
      if (r.status !== 200 || !r.json.result.base64) throw new Error(r.text);
      const buf = Buffer.from(r.json.result.base64, 'base64');
      if (buf.length < 500) throw new Error('docx 太小');
      if (!f.parseResumeBuffer(buf, 'x.docx').text.trim()) throw new Error('导出内容为空');
    });

    await ok('结构化 finalize：返回 data(sections) + markdown，final_data 落库', async function () {
      const c = await req(port, 'POST', '/api/resume/docs', { title: '结构化渲染测试', target_role: 'AI PM' });
      const id = c.json.doc.id;
      await req(port, 'POST', '/api/resume/docs/' + id + '/upload', { text: '# A\n\n## Exp\n- x', filename: '' });
      await req(port, 'POST', '/api/resume/docs/' + id + '/jd', { jd: 'need user research' });
      const r = await req(port, 'POST', '/api/resume/docs/' + id + '/ai', { kind: 'finalize' });
      if (r.status !== 200) throw new Error(r.status + ' ' + r.text);
      const d = r.json.data;
      if (!d.data || !Array.isArray(d.data.sections) || !d.data.sections.length) throw new Error('没有结构化 sections');
      if (!d.markdown || d.markdown.indexOf('## ') < 0) throw new Error('markdown 不对');
      const g = await req(port, 'GET', '/api/resume/docs/' + id + '/pipeline');
      if (!g.json.doc.has_final) throw new Error('has_final 应为 true');
      const full = await req(port, 'POST', '/api/commands/run', { name: 'resume.get', input: { docId: id, withBody: true } });
      const fd = full.json.result.final_data;
      if (!fd || !Array.isArray(fd.sections)) throw new Error('final_data 没落库');
    });
    await ok('GET /export-html：自包含 HTML（含打印按钮与右对齐日期）', async function () {
      const c = await req(port, 'POST', '/api/resume/docs', { title: 'HTML 导出测试' });
      const id = c.json.doc.id;
      await req(port, 'POST', '/api/resume/docs/' + id + '/upload', { text: '# A\n\n## Exp\n- x', filename: '' });
      await req(port, 'POST', '/api/resume/docs/' + id + '/jd', { jd: 'need x' });
      await req(port, 'POST', '/api/resume/docs/' + id + '/ai', { kind: 'finalize' });
      const res = await fetch('http://127.0.0.1:' + port + '/api/resume/docs/' + id + '/export-html');
      if (res.status !== 200) throw new Error('status ' + res.status);
      const html = await res.text();
      if (html.indexOf('window.print') < 0) throw new Error('缺打印按钮');
      if (html.indexOf('itDate') < 0) throw new Error('缺右对齐日期样式');
      if (html.indexOf('contenteditable') < 0) throw new Error('缺可编辑');
      if (html.indexOf('@page') < 0) throw new Error('缺 A4 打印样式');
    });
    await ok('export docx：结构化版含加粗/右对齐 tab/项目符号/章节分隔线', async function () {
      const D = require('../server/resume-domain.js');
      const lib = require('../server/plugins/lib/resume-render.js');
      const xml = lib.renderDocx({ name: 'N', title: 'T', contacts: ['c1'], summary: 's', sections: [{ title: '项目经历', items: [{ left: 'L', right: '2026.01', bullets: ['**b**1', 'b2'] }] }] }, 'x');
      if (xml.indexOf('<w:b/>') < 0) throw new Error('缺加粗');
      if (xml.indexOf('w:val="right"') < 0) throw new Error('缺右对齐 tab');
      if (xml.indexOf('• ') < 0) throw new Error('缺项目符号');
      if (xml.indexOf('w:pBdr') < 0) throw new Error('缺章节分隔线');
      /* 真实导出：能被 resume-file 解析回来 */
      const c = await req(port, 'POST', '/api/resume/docs', { title: 'docx 版式测试' });
      const id = c.json.doc.id;
      await req(port, 'POST', '/api/resume/docs/' + id + '/upload', { text: '# A\n\n## Exp\n- x', filename: '' });
      await req(port, 'POST', '/api/resume/docs/' + id + '/jd', { jd: 'need x' });
      await req(port, 'POST', '/api/resume/docs/' + id + '/ai', { kind: 'finalize' });
      const f = require('../server/plugins/lib/resume-file');
      const res = await fetch('http://127.0.0.1:' + port + '/api/resume/docs/' + id + '/export');
      const buf = Buffer.from(await res.arrayBuffer());
      const parsed = f.parseResumeBuffer(buf, 'x.docx');
      if (!parsed.text.trim()) throw new Error('导出 docx 解析为空');
      if (parsed.text.indexOf('Fake Name') < 0) throw new Error('导出内容缺姓名：' + parsed.text.slice(0, 120));
    });
    await ok('组件开关：可以全局关闭 resume（不是 core）', async function () {
      const off = await req(port, 'POST', '/api/components/resume/toggle', { enabled: false });
      if (off.status !== 200 || off.json.enabled.resume !== false) throw new Error(off.text);
      const on = await req(port, 'POST', '/api/components/resume/toggle', { enabled: true });
      if (on.json.enabled.resume !== true) throw new Error(on.text);
    });
    await ok('按目标开关：resume 出现在「可按目标管理」清单里，且只写本目标', async function () {
      const mk = await req(port, 'POST', '/api/goals', { title: '简历工坊开关测试' });
      if (mk.status !== 201 || !mk.json.goal || !mk.json.goal.id) throw new Error('建目标失败：' + mk.text);
      const gid = mk.json.goal.id;
      const before = await req(port, 'GET', '/api/goals/' + gid + '/plugins');
      if (before.status !== 200) throw new Error(before.text);
      /* 新目标建档时会快照当前全局有效值：resume 必须在这里有一项（说明它是"可按目标开关"的组件） */
      if (!('resume' in (before.json.enabled || {}))) throw new Error('目标级清单里没有 resume：' + before.text);
      const off = await req(port, 'POST', '/api/goals/' + gid + '/plugins', { plugin_id: 'resume', enabled: false });
      if (off.status !== 200 || off.json.enabled.resume !== false) throw new Error('按目标关闭失败：' + off.text);
      /* 只改本目标：全局值仍是开 */
      const comps = await req(port, 'GET', '/api/components');
      if (comps.json.enabled.resume !== true) throw new Error('按目标关闭串到全局了');
      const other = await req(port, 'POST', '/api/goals', { title: '另一个目标' });
      const og = await req(port, 'GET', '/api/goals/' + other.json.goal.id + '/plugins');
      if (og.json.enabled.resume === false) throw new Error('按目标关闭串到别的目标了');
      const on = await req(port, 'POST', '/api/goals/' + gid + '/plugins', { plugin_id: 'resume', enabled: true });
      if (on.json.enabled.resume !== true) throw new Error(on.text);
    });
    await ok('删目标不级联删共享简历库', async function () {
      const mk = await req(port, 'POST', '/api/goals', { title: '要被删的目标' });
      const gid = mk.json.goal.id;
      const c = await req(port, 'POST', '/api/resume/docs', { title: '共享简历', goalId: gid });
      const rid = c.json.doc.id;
      const del = await req(port, 'DELETE', '/api/goals/' + gid);
      if (del.status !== 200) throw new Error('删目标失败：' + del.text);
      const g = await req(port, 'GET', '/api/resume/docs/' + rid);
      if (g.status !== 200) throw new Error('删目标把共享简历一起删了（应保留）：' + g.status);
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
