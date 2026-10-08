'use strict';
/**
 * 思而行 · 代码库读取与摘要（给「信息源导入」和「模拟面试」共用）
 * ------------------------------------------------------------------
 * 用户在**本机**指定一个项目路径，我们：
 *   1. 把路径展开（支持 ~）、realpath 解软链，作为只读根；
 *   2. 按「门面优先」挑出最值得读的文件（README / 依赖清单 / 入口文件 / 顶层优先）；
 *   3. 交给 AI 产出结构化摘要。
 *
 * 真正的安全边界在 server/code-read.js：.env / 密钥 / node_modules / .git 一律不可见，
 * 路径不得逃出根，单文件与总量都有封顶。这里只负责"挑哪些文件"和"怎么问 AI"。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listCodeFiles, readCodeFiles } = require('../../code-read');

/** 把用户给的路径变成一个可用的只读根；不合法就抛带人话的错误 */
function resolveRoot(p) {
  let s = String(p || '').trim();
  if (!s) throw new Error('请填写项目路径');
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  s = path.resolve(s);
  let real = s;
  try { real = fs.realpathSync(s); } catch (e) { throw new Error('路径不存在：' + s); }
  let st = null;
  try { st = fs.statSync(real); } catch (e) { throw new Error('读不到这个路径：' + s); }
  if (!st.isDirectory()) throw new Error('这不是一个目录：' + s);
  return real;
}

/** 从文件列表里挑「最像门面」的几个：README/依赖清单/入口文件优先，顶层优先 */
function pickProjectFiles(root, limit) {
  const all = listCodeFiles(root).filter(f => f && f.path);
  const base = p => String(p).split('/').pop().toLowerCase();
  const score = f => {
    const pth = String(f.path), b = base(pth), depth = pth.split('/').length;
    let s = 0;
    if (/^readme(\.md|\.txt)?$/.test(b)) s += 140;
    /* 锚到「整个文件名」或后面跟点：不锚的话 `pom` 会把 pomodoro.js 也当成 pom.xml */
    if (/^(package|requirements|pyproject|composer|go|pom|build\.gradle)(\.|$)/.test(b)) s += 110;
    if (/^(app|index|main|server|manage|cli)\.(js|ts|mjs|cjs|py|go|java|rb)$/.test(b)) s += 90;
    if (/(^|\/)(src|server|app|lib|core|api)\//.test(pth)) s += 30;
    if (depth <= 2) s += 26;
    if (/\.(md|json|yml|yaml|toml|sql)$/.test(b)) s += 10;
    /* 大文件只轻微降权：真正的预算封顶在 readCodeFiles（单文件 12KB / 总 46KB） */
    s -= Math.min(12, Math.round((f.size || 0) / 20000));
    return s;
  };
  const sorted = all.slice().sort((a, b) => score(b) - score(a));
  return sorted.slice(0, limit || 22).map(f => f.path);
}

/** 读一份代码库：返回 { root, files, all }（all 是完整文件清单，用来给 AI 看结构） */
function readProject(root, opts) {
  const o = opts || {};
  const picked = pickProjectFiles(root, o.limit);
  const files = readCodeFiles(root, picked, { perFile: o.perFile || 12000, total: o.total || 46000 });
  const all = listCodeFiles(root);
  return { root, files, all, picked };
}

/** 供「规划学习某个代码库」用的摘要提示词 —— 重点是「要学什么」和「按什么顺序读」 */
function buildStudyDigestPrompt(root, files, all, goalTitle) {
  const L = [];
  L.push('你在帮一位学习者**读懂一个代码库**。先把它读明白，然后产出一份**能直接拿来规划学习路径**的摘要。');
  L.push('');
  L.push('【代码库路径】' + root);
  if (goalTitle) L.push('【他的目标】' + String(goalTitle).slice(0, 120));
  L.push('');
  L.push('【要输出什么】只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"what":"这个项目是做什么的（两三句，说人话）",');
  L.push(' "stack":["技术栈/框架/中间件，按重要性"],');
  L.push(' "layout":[{"path":"目录或文件","what":"它负责什么"}],');
  L.push(' "entry":["入口在哪、启动流程大致怎么走（按顺序）"],');
  L.push(' "concepts":["要读懂它**必须先掌握**的概念/机制（每条一句话说清为什么需要）"],');
  L.push(' "order":["建议的阅读顺序：先读什么、再读什么、每步要看懂什么（5-8 步）"],');
  L.push(' "gotchas":["这个库里最容易看懵的地方（设计上的拐弯、隐式约定、历史包袱）"]}');
  L.push('');
  L.push('要求：');
  L.push('1. 必须结合下面的真实代码，模块名/文件名/函数名要对得上，不要编造；');
  L.push('2. concepts 是**给学习路径用的**：只列读懂这个库真正绕不开的概念，别把通用八股都塞进来；');
  L.push('3. order 要具体到「读哪个文件/目录、看懂什么」，不要写"先学基础再深入"这种废话；');
  L.push('4. 信息不足就少写几条，别硬凑。');
  L.push('');
  L.push('=== 完整文件清单（相对路径，共 ' + all.length + ' 个可读文件）===');
  L.push(all.slice(0, 300).map(f => f.path).join('\n') || '（读不到文件）');
  L.push('');
  L.push('=== 关键文件内容 ===');
  L.push(files && files.length ? files.map(f => {
    L.push('--- ' + f.path + (f.truncated ? '（超长已截断）' : '') + ' ---');
    L.push('```' + (f.path.split('.').pop() || ''));
    L.push(f.text);
    L.push('```');
  }).join('\n') : '（没有可读的关键文件）');
  return L.join('\n');
}

/** 把摘要整理成一段**给规划看的文字**（存进 source_digests，规划时按 4000 字带进去） */
function digestToText(d) {
  const j = d || {};
  const L = [];
  if (j.what) L.push('【这是什么】' + j.what);
  if ((j.stack || []).length) L.push('【技术栈】' + j.stack.join('、'));
  if ((j.layout || []).length) {
    L.push('【模块划分】');
    for (const m of j.layout) L.push('- ' + (m.path || '') + '：' + (m.what || ''));
  }
  if ((j.entry || []).length) {
    L.push('【入口与启动流程】');
    j.entry.forEach((x, i) => L.push((i + 1) + '. ' + x));
  }
  if ((j.concepts || []).length) {
    L.push('【读懂它必须先掌握的概念】');
    j.concepts.forEach(x => L.push('- ' + x));
  }
  if ((j.order || []).length) {
    L.push('【建议的阅读顺序】');
    j.order.forEach((x, i) => L.push((i + 1) + '. ' + x));
  }
  if ((j.gotchas || []).length) {
    L.push('【最容易看懵的地方】');
    j.gotchas.forEach(x => L.push('- ' + x));
  }
  return L.join('\n');
}

module.exports = { resolveRoot, pickProjectFiles, readProject, buildStudyDigestPrompt, digestToText };
