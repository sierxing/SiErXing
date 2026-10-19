'use strict';
/**
 * 达成条件领域单测（内存库，不碰真实数据）
 * 跑：node --no-warnings --experimental-sqlite scripts/test-conditions-domain.js
 */
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { createConditionsDomain, normalizePlanConditions, firstJSON } = require('../server/conditions');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '→', e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '→', e.message); }
}

function mkdb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, profile TEXT DEFAULT \'\', materials TEXT DEFAULT \'\', summary TEXT DEFAULT \'\', deadline TEXT DEFAULT \'\', weekly_hours TEXT DEFAULT \'\', constraints TEXT DEFAULT \'[]\');');
  db.exec('CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER, parent_id INTEGER, level INTEGER, title TEXT, detail TEXT DEFAULT \'\', artifact TEXT DEFAULT \'\', acceptance TEXT DEFAULT \'\', hours TEXT DEFAULT \'\', sources TEXT DEFAULT \'[]\', status TEXT DEFAULT \'todo\', sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);');
  return db;
}
let NOW = 1000;
const nowISO = () => new Date(NOW++).toISOString();
const safeParse = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };

function mkDomain(db, ai) {
  return createConditionsDomain({ db, nowISO, safeParse, aiText: ai, currentModel: () => 'fake' });
}
function ins(db, goalId, parentId, level, title, condId, status) {
  const r = db.prepare('INSERT INTO nodes (goal_id,parent_id,level,title,status,condition_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, title, status || 'todo', condId || 0, 0, nowISO(), nowISO());
  return Number(r.lastInsertRowid);
}

console.log('\n[1] normalizePlanConditions');
ok('字符串 / 对象 / key 去重 / 序号兜底', () => {
  const list = normalizePlanConditions([
    '能独立产出 PRD',
    { key: 'c1', title: '掌握大模型能力边界', detail: 'x', acceptance: 'y', priority: 'should' },
    { title: '有可演示的作品', priority: 'nice' },
    { name: '面试表达过关' },
    { title: '' }, null
  ]);
  assert.strictEqual(list.length, 4);
  assert.strictEqual(list[0].key, 'c1');      // 第一条没给 key → c1
  assert.strictEqual(list[1].key, 'c2');      // 显式 c1 已占用 → c2
  assert.strictEqual(list[2].priority, 'nice');
  assert.strictEqual(list[3].title, '面试表达过关');
  assert.deepStrictEqual(list.map(x => x.sort_order), [0, 1, 2, 3]);
});
ok('JD 条款（jd/jd_ref）被保留', () => {
  const list = normalizePlanConditions([
    { title: '到岗资格', jd: '本科及以上、2027 届、北京、每周 ≥3 天' },
    { title: '技术理解', jd_ref: '能回答 RAG / Agent / Prompt / 评测 / 成本' },
    { title: '作品证明', jd_clause: '提供可演示 Demo 与评测数字' }
  ]);
  assert.strictEqual(list[0].jd_ref.indexOf('2027 届') >= 0, true);
  assert.strictEqual(list[1].jd_ref.indexOf('RAG') >= 0, true);
  assert.strictEqual(list[2].jd_ref.indexOf('Demo') >= 0, true);
});
ok('最多 16 条（JD 维度多时要能装下）', () => {
  const list = normalizePlanConditions(Array.from({ length: 30 }, (_, i) => '条件' + i));
  assert.strictEqual(list.length, 16);
});
ok('firstJSON 抠围栏 / 前后说明', () => {
  const o = firstJSON('好的：\n\`\`\`json\n{"conditions":[{"title":"A"}]}\n\`\`\`\n以上');
  assert.strictEqual(o.conditions[0].title, 'A');
});

console.log('\n[2] saveFromPlan / list 进度口径');
const db1 = mkdb();
const d1 = mkDomain(db1);
db1.prepare('INSERT INTO goals (id,title,profile) VALUES (?,?,?)').run(1, '转行 AI 产品经理', '有数据分析基础');
d1.ensureSchema();
ok('ensureSchema 给 nodes 补 condition_id', () => {
  const cols = db1.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  assert.ok(cols.includes('condition_id'));
});
const plan1 = {
  conditions: [
    { key: 'c1', title: '能独立产出合格 PRD', acceptance: '不看模板写出 1 份 PRD', jd: 'JD：能独立撰写 PRD、需求文档', priority: 'must' },
    { key: 'c2', title: '有可演示的 AI 产品作品', priority: 'should' }
  ],
  stages: [
    { title: '阶段一', condition: 'c1', goals: [ { title: '学需求分析', condition: 'c1' }, { title: '写第一份 PRD', condition: 'c1' } ] },
    { title: '阶段二', condition: 'c2', goals: [ { title: '做一个 AI 小工具', condition: 'c2' } ] }
  ]
};
const saved = d1.saveFromPlan(1, plan1);
ok('saveFromPlan 落库 JD 条款、list 带回来', () => {
  assert.strictEqual(saved.ids.length, 2);
  const c = d1.list(1).conditions[0];
  assert.ok(String(c.jd_ref || '').indexOf('PRD') >= 0, 'jd_ref=' + c.jd_ref);
});
ok('saveFromPlan 返回 defs/ids/resolve', () => {
  assert.strictEqual(saved.ids.length, 2);
  assert.strictEqual(saved.resolve('c1'), saved.ids[0]);
  assert.strictEqual(saved.resolve('c2'), saved.ids[1]);
  assert.strictEqual(saved.resolve('1'), saved.ids[0]);
  assert.strictEqual(saved.resolve('不存在的'), 0);
  assert.strictEqual(d1.countForGoal(1), 2);
});
const st1 = ins(db1, 1, 0, 0, '阶段一', saved.resolve('c1'));
const sg1 = ins(db1, 1, st1, 1, '学需求分析', saved.resolve('c1'));
const sg2 = ins(db1, 1, st1, 1, '写第一份 PRD', saved.resolve('c1'));
const t1 = ins(db1, 1, sg1, 2, '看 3 份真实 PRD', 0);
const t2 = ins(db1, 1, sg2, 2, '写出 PRD 初稿', 0);
const st2 = ins(db1, 1, 0, 0, '阶段二', saved.resolve('c2'));
const t3 = ins(db1, 1, st2, 1, '做一个 AI 小工具', saved.resolve('c2'));
db1.prepare('UPDATE nodes SET status = ? WHERE id = ?').run('done', t1);
db1.prepare('UPDATE nodes SET condition_id = ? WHERE id = ?').run(saved.resolve('c1'), t1);
db1.prepare('UPDATE nodes SET condition_id = ? WHERE id = ?').run(saved.resolve('c1'), t2);
ok('list：任务/小目标 / 未归属 / 总数', () => {
  const out = d1.list(1);
  assert.strictEqual(out.conditions.length, 2);
  const c1 = out.conditions[0], c2 = out.conditions[1];
  assert.strictEqual(c1.stats.total, 2);          // 两个任务（小目标有归属子节点 → 不计数）
  assert.strictEqual(c1.stats.done, 1);
  assert.strictEqual(c1.stats.percent, 50);
  assert.strictEqual(c1.stats.met, false);
  assert.strictEqual(c2.stats.total, 1);          // 小目标即末端
  assert.strictEqual(c2.stats.percent, 0);
  assert.strictEqual(out.summary.tasks_total, 3);
  assert.strictEqual(out.summary.nodes_unassigned, 0);
  assert.strictEqual(out.unassigned.length, 0);
});
ok('list：没有子节点时小目标本身算末端', () => {
  const empty = ins(db1, 1, null, 1, '孤立小目标', saved.resolve('c1'));
  ins(db1, 1, null, 2, '独立任务', 0);
  const out = d1.list(1);
  assert.strictEqual(out.unassigned.length, 1);
  assert.strictEqual(out.conditions[0].stats.total, 3);  // t1/t2 + 孤立小目标
  db1.prepare('DELETE FROM nodes WHERE id IN (?,?)').run(empty, db1.prepare("SELECT id FROM nodes WHERE title='独立任务'").get().id);
  assert.strictEqual(d1.list(1).unassigned.length, 0);
});
ok('条件没有任何节点时 percent=0 / met=false', () => {
  d1.saveManual(1, { title: '空条件' });
  const out = d1.list(1);
  const c = out.conditions.find(x => x.title === '空条件');
  assert.strictEqual(c.stats.total, 0);
  assert.strictEqual(c.stats.percent, 0);
  assert.strictEqual(c.stats.met, false);
});
ok('全部完成 → met=true / percent=100', () => {
  db1.prepare('UPDATE nodes SET status = ? WHERE id IN (?,?)').run('done', t1, t2);
  const c = d1.list(1).conditions[0];
  assert.strictEqual(c.stats.percent, 100);
  assert.strictEqual(c.stats.met, true);
});

console.log('\n[3] 手动条件 / 归属调整 / 删除');
ok('saveManual 新建 + 编辑 + 非法标题', () => {
  const a = d1.saveManual(1, { title: '手动条件 A', detail: 'd', acceptance: 'a', jd_ref: 'JD 原文：每周到岗 3 天', priority: 'should' });
  assert.strictEqual(d1.list(1).conditions.find(c => c.id === a.id).jd_ref, 'JD 原文：每周到岗 3 天');
  assert.ok(a.id);
  assert.strictEqual(d1.list(1).conditions.find(c => c.id === a.id).priority, 'should');
  d1.saveManual(1, { id: a.id, title: '手动条件 A 改' });
  assert.strictEqual(d1.list(1).conditions.find(c => c.id === a.id).title, '手动条件 A 改');
  assert.throws(() => d1.saveManual(1, { title: '  ' }), /标题/);
  d1.remove(a.id);
  assert.ok(!d1.list(1).conditions.some(c => c.id === a.id));
});
ok('saveFromPlan 只替换 plan 条件，手动条件保留', () => {
  d1.saveManual(1, { title: '手动保留条' });
  const before = d1.list(1).conditions.find(c => c.title === '手动保留条');
  d1.saveFromPlan(1, { conditions: [{ key: 'c1', title: '新条件' }] });
  const out = d1.list(1);
  assert.ok(out.conditions.some(c => c.id === before.id));
  assert.ok(out.conditions.some(c => c.title === '新条件'));
  const n = db1.prepare('SELECT COUNT(*) AS n FROM nodes WHERE condition_id = ?').get(before.id).n;
  assert.strictEqual(n, 0);
});
ok('assign map 精确改 + 非法条件报错', () => {
  const cs = d1.list(1).conditions;
  const target = cs[cs.length - 1];
  const out = d1.assign(1, { map: { [t1]: target.id } });
  assert.strictEqual(out.changed, 1);
  assert.strictEqual(db1.prepare('SELECT condition_id FROM nodes WHERE id=?').get(t1).condition_id, target.id);
  assert.throws(() => d1.assign(1, { map: { [t1]: 99999 } }), /条件不存在/);
});
ok('assign node_ids + cascade 整棵子树', () => {
  const c1 = d1.list(1).conditions.find(c => c.title === '新条件');
  d1.assign(1, { condition_id: c1.id, node_ids: [st1], cascade: true });
  for (const id of [st1, sg1, sg2, t1, t2]) {
    assert.strictEqual(db1.prepare('SELECT condition_id FROM nodes WHERE id=?').get(id).condition_id, c1.id, 'node ' + id);
  }
});
ok('remove 条件后节点回到未归属', () => {
  const c1 = d1.list(1).conditions.find(c => c.title === '新条件');
  d1.remove(c1.id);
  assert.strictEqual(db1.prepare('SELECT condition_id FROM nodes WHERE id=?').get(t1).condition_id, 0);
  assert.ok(!d1.list(1).conditions.some(c => c.id === c1.id));
});

console.log('\n[4] 多目标隔离 / 未归属统计');
const db3 = mkdb();
const d4 = mkDomain(db3);
d4.ensureSchema();
db3.prepare('INSERT INTO goals (id,title) VALUES (?,?),(?,?)').run(1, 'G1', 2, 'G2');
const s = d4.saveFromPlan(1, { conditions: [{ key: 'c1', title: 'G1 条件' }] });
ins(db3, 1, null, 0, 'G1 阶段', s.resolve('c1'));
ins(db3, 2, null, 0, 'G2 阶段', 0);
ok('list 只返回本目标的条件与未归属', () => {
  const a = d4.list(1), b = d4.list(2);
  assert.strictEqual(a.conditions.length, 1);
  assert.strictEqual(b.conditions.length, 0);
  assert.strictEqual(b.unassigned.length, 1);
  assert.strictEqual(a.unassigned.length, 0);
});
ok('countForGoal', () => {
  assert.strictEqual(d4.countForGoal(1), 1);
  assert.strictEqual(d4.countForGoal(2), 0);
  assert.strictEqual(d4.countForGoal(999), 0);
});

(async () => {
  console.log('\n[5] generateFromNodes（假 AI）');
  const db2 = mkdb();
  let capturedPrompt = '';
  const fakeAI = async (prompt) => {
    capturedPrompt = prompt;
    return '好的，结果如下：\n' + JSON.stringify({
      conditions: [
        { key: 'c1', title: '基础能力过关', acceptance: '能独立完成练习', jd: '公共 AIPM JD：产品基本功' },
        { key: 'c2', title: '有作品证明', acceptance: '有可演示作品', jd: '公共 AIPM JD：Demo 与指标' }
      ],
      map: [
        { node_id: 1, condition: 'c1' },
        { node_id: 2, condition: 'c1' },
        { node_id: 3, condition: 'c2' }
      ]
    });
  };
  const d2 = mkDomain(db2, fakeAI);
  db2.prepare('INSERT INTO goals (id,title,profile,materials) VALUES (?,?,?,?)').run(9, '转行 AI 产品经理', '零基础', '岗位 JD：本科及以上、2027 届、北京、每周到岗 ≥3 天；要求熟悉 RAG / Agent / Prompt / 评测 / 成本');
  d2.ensureSchema();
  ins(db2, 9, null, 0, '打基础', 0);
  ins(db2, 9, null, 0, '做作品', 0);
  await okAsync('generateFromNodes 写条件并按 map 级联归属', async () => {
    const out = await d2.generateFromNodes(9);
    assert.strictEqual(out.conditions, 2);
    const list = d2.list(9);
    assert.strictEqual(list.conditions.length, 2);
    assert.strictEqual(list.summary.nodes_unassigned, 0);
    assert.strictEqual(list.conditions[0].stats.total, 2); // 阶段下没有子节点 → 阶段本身是末端
    assert.ok(capturedPrompt.includes('条件 ≠ 阶段'));
    assert.ok(capturedPrompt.includes('只输出一个 JSON'));
    assert.ok(capturedPrompt.includes('JD 原文') && capturedPrompt.includes('公共 AIPM'), '提示词要求对齐 JD');
    assert.ok(capturedPrompt.includes('公共 AIPM'), '提示词带公共 AIPM JD 条款');
    assert.ok(capturedPrompt.includes('"jd"'), 'JSON 模板带 jd 字段');
    assert.ok(capturedPrompt.includes('2027 届') && capturedPrompt.includes('RAG'), '提示词带上了 JD 原文（目标材料）');
    assert.ok(capturedPrompt.includes('8-12 条') && capturedPrompt.includes('独立要求维度'), '提示词要求按 JD 维度给足条件数量');
    assert.strictEqual(out.jd_found, true, '返回 jd_found=true 让界面能说准');
    const listJd = d2.list(9).conditions;
    assert.ok(listJd.every(c => c.jd_ref), '每条条件都有 JD 条款');
  });
  await okAsync('没有节点时报错、目标不存在报错', async () => {
    db2.prepare('INSERT INTO goals (id,title) VALUES (?,?)').run(10, '空目标');
    await assert.rejects(() => d2.generateFromNodes(10), /还没有路线图/);
    const d3 = mkDomain(mkdb());
    d3.ensureSchema();
    await assert.rejects(() => d3.generateFromNodes(999), /目标不存在/);
  });
  await okAsync('非求职目标不硬套 JD，按目标依据写条件', async () => {
    const db5 = mkdb();
    let prompt5 = '';
    const d5 = createConditionsDomain({
      db: db5, nowISO, safeParse,
      aiText: async p => {
        prompt5 = p;
        return JSON.stringify({
          conditions: [
            { key: 'c1', title: '能独立完成几何体写生', detail: '课程要求', acceptance: '能画出透视正确的立方体', jd: '课程大纲：几何体与透视' },
            { key: 'c2', title: '掌握明暗过渡', detail: '课程要求', acceptance: '能画出自然的光影过渡', jd: '课程大纲：明暗关系' }
          ],
          map: [{ node_id: 1, condition: 'c1' }, { node_id: 2, condition: 'c2' }]
        });
      },
      currentModel: () => 'fake'
    });
    db5.prepare('INSERT INTO goals (id,title,profile,materials) VALUES (?,?,?,?)').run(11, '30 天学会素描', '零基础', '课程大纲：几何体、明暗、透视');
    d5.ensureSchema();
    ins(db5, 11, null, 0, '几何体练习', 0);
    ins(db5, 11, null, 0, '明暗练习', 0);
    const out = await d5.generateFromNodes(11);
    assert.ok(prompt5.includes('非求职类目标'), '提示词识别出非求职目标');
    assert.ok(!prompt5.includes('公共 AIPM JD 高频条款参考'), '非求职目标不应出现 AIPM JD 条款清单');
    assert.ok(prompt5.includes('考纲') && prompt5.includes('验收标准'), '提示词给出学习/项目的依据来源');
    assert.strictEqual(out.jd_found, false);
    const list = d5.list(11).conditions;
    assert.ok(list.length === 2 && list.every(c => c.jd_ref), '非求职条件也带对应依据');
  });

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
