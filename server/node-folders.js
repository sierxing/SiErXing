'use strict';
/**
 * 思而行 · 节点文件夹资料源
 * ------------------------------------------------------------------
 * 需求：把一个本地文件夹挂到某个节点上当资料源，该节点和它的子孙节点
 * 可见、可用于规划与教程，其它分支的节点看不到。
 *
 * 实现方式（不动表结构）：
 *  - 存：复用 nodes.sources 这个 JSON 列，条目形状
 *      { kind:'folder', path:'/abs/dir', name:'RAGFlow 源码', note:'...' }
 *    普通条目保持原样 {name, note} / {source_id, name}。
 *  - 可见性：读的时候沿 parent_id 链向上收敛（自己 + 所有祖先），
 *    同级/其它分支自然看不到。不需要新表、不需要 backfill。
 *  - 读文件：复用 code-read.js（白名单扩展名、黑名单目录、密钥脱敏、
 *    单文件 24KB/总量 60KB 封顶），root 就是被挂的文件夹本身。
 *
 * 安全（默认拒绝）：
 *  1. 路径必须是绝对路径，realpath 后必须仍是目录，软链指向敏感区会被拦。
 *  2. 硬性拒绝：思而行自己的程序目录与数据目录（读了会把用户数据库和
 *     密钥配置喂给 AI）、home 下的 .ssh/.gnupg/.aws 等敏感目录。
 *  3. 模块只读不写；AI 在本应用内没有写文件通道。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listCodeFiles, readCodeFiles } = require('./code-read');

/* home 下这些目录名一律不可挂（大小写不敏感） */
const DENY_HOME_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.config', '.pki', '.docker']);

/** 校验用户要挂的文件夹。返回 {ok, dir} 或 {ok:false, error} */
function validateAttachFolder(p, opts) {
  const o = opts || {};
  const appDir = o.appDir ? path.resolve(o.appDir) : null;
  const dataDir = o.dataDir ? path.resolve(o.dataDir) : null;
  const raw = String(p || '').trim();
  if (!raw) return { ok: false, error: '先填一个文件夹路径' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '必须是绝对路径（以 / 开头）' };
  let real = '';
  try {
    real = fs.realpathSync(raw);
  } catch (e) {
    return { ok: false, error: '这个目录不存在或进不去：' + (e.message || e) };
  }
  let st = null;
  try { st = fs.statSync(real); } catch (e) {
    return { ok: false, error: '读不到这个目录：' + (e.message || e) };
  }
  if (!st.isDirectory()) return { ok: false, error: '这是一个文件，不是文件夹' };
  const under = (root) => (root && (real === root || real.startsWith(root + path.sep)));
  /* 思而行自己的程序目录和数据目录不能挂：读了会把用户数据库、
     data-location.json 指针、.env 密钥喂给 AI */
  if (under(appDir)) return { ok: false, error: '不能挂思而行自己的程序目录' };
  if (dataDir && under(dataDir)) return { ok: false, error: '不能挂思而行的数据目录（里面有你的数据库）' };
  /* home 下的敏感目录不能挂 */
  const home = os.homedir();
  if (home && (real === home || real.startsWith(home + path.sep))) {
    const rel = path.relative(home, real).split(path.sep)[0] || '';
    if (DENY_HOME_NAMES.has(rel.toLowerCase())) return { ok: false, error: '不能挂 ' + rel + '（敏感目录）' };
    if (rel.startsWith('.') && real !== home) {
      /* home 下其它 dotdir 默认也拦 —— 用户真要挂点文件里的配置，让他指到具体子目录时再说 */
      return { ok: false, error: '不能挂 home 下的隐藏目录 ' + rel };
    }
  }
  /* 根目录 / 本身没有意义 */
  if (real === path.parse(real).root) return { ok: false, error: '不能挂磁盘根目录' };
  try { fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK); }
  catch (e) { return { ok: false, error: '这个目录不可读（权限不足）：' + (e.message || e) }; }
  return { ok: true, dir: real };
}

/** 读节点行（兼容 JSON 字符串或数组的 sources 列） */
function parseNodeSources(n) {
  let list = n && n.sources;
  if (typeof list === 'string') { try { list = JSON.parse(list) || []; } catch (e) { list = []; } }
  return Array.isArray(list) ? list : [];
}

/**
 * 收敛某节点的有效文件夹条目：自己 + 所有祖先（parent_id 链向上）。
 * 返回 [{nodeId, nodeTitle, inherited, path, name, note, missing}]
 * missing=true 表示目录已经不在了（删了/移动了/U盘拔了），调用方只展示不读。
 */
function collectFolderEntries(db, nodeId) {
  const out = [];
  const seenPath = new Set();
  const seenNode = new Set();
  let cur = Number(nodeId) || 0;
  let depth = 0;
  const selfId = cur;
  while (cur && depth < 25 && !seenNode.has(cur)) {
    seenNode.add(cur);
    depth++;
    let n = null;
    try { n = db.prepare('SELECT id, parent_id, title, sources FROM nodes WHERE id = ?').get(cur); }
    catch (e) { break; }
    if (!n) break;
    for (const it of parseNodeSources(n)) {
      if (!it || it.kind !== 'folder') continue;
      const p = String(it.path || '').trim();
      if (!p) continue;
      const key = path.resolve(p);
      if (seenPath.has(key)) continue;   // 离得近的说了算：子节点同路径覆盖祖先
      seenPath.add(key);
      let missing = false;
      try {
        const st = fs.statSync(fs.realpathSync(p));
        missing = !st.isDirectory();
      } catch (e) { missing = true; }
      out.push({
        nodeId: n.id, nodeTitle: n.title || '', inherited: n.id !== selfId,
        path: p, name: String(it.name || path.basename(p)).slice(0, 120),
        note: String(it.note || '').slice(0, 300), missing
      });
    }
    cur = Number(n.parent_id) || 0;
  }
  return out;
}

/**
 * 文件夹在提示词里的摘要：文件清单 + README 头部。
 * 保持短小（规划提示词里每节点只给约 900 字，超了调用方自己截）。
 */
function folderBodyForPrompt(root, maxChars) {
  const max = Math.max(200, Math.min(2000, Number(maxChars) || 900));
  try {
    const st = fs.statSync(fs.realpathSync(root));
    if (!st.isDirectory()) return '';
  } catch (e) { return ''; }   // 目录已经不在了：调用方标 missing，这里不再凑一句正文
  let files = [];
  try { files = listCodeFiles(root); } catch (e) { return ''; }
  if (!files.length) return '（空目录或没有可读的代码/文本文件）';
  const lines = ['共 ' + files.length + ' 个可读文件：'];
  for (const f of files.slice(0, 40)) lines.push('- ' + f.path);
  if (files.length > 40) lines.push('…等共 ' + files.length + ' 个');
  /* README 优先读一点正文，其它文件不读（规划阶段只给目录感，细读留给教程阶段） */
  const readme = files.find(f => /(^|\/)readme(\.md)?$/i.test(f.path))
    || files.find(f => /(^|\/)readme[^/]*$/i.test(f.path));
  if (readme) {
    try {
      const got = readCodeFiles(root, [readme.path], { perFile: 1500, total: 1500 });
      if (got.length && got[0].text) lines.push('', '【' + readme.path + ' 开头】', got[0].text.slice(0, 1200));
    } catch (e) {}
  }
  return lines.join('\n').slice(0, max);
}

/**
 * 给教程生成攒代码块：README + 按体积从小到大拿，直到预算用完。
 * 返回 { block, list:[{root, path}] }，list 直接存 tutorials.code_files。
 */
function gatherFolderCode(entries, budget) {
  let room = Math.max(1000, Math.min(60000, Number(budget) || 30000));
  const parts = [];
  const list = [];
  for (const e of (entries || [])) {
    if (!e || e.missing) continue;
    let files = [];
    try { files = listCodeFiles(e.path); } catch (err) { continue; }
    if (!files.length) continue;
    const ordered = files.slice().sort((a, b) => {
      const ra = /(^|\/)readme/i.test(a.path) ? 0 : 1;
      const rb = /(^|\/)readme/i.test(b.path) ? 0 : 1;
      return (ra - rb) || (a.size - b.size);
    });
    /* README 只取前 3 个讲大局，剩下的名额留给真正的代码文件 ——
       不然 12 个名额全被各子目录的 README 占满，一行代码都进不去 */
    const picked = [...ordered.filter(f => /(^|\/)readme/i.test(f.path)).slice(0, 3),
      ...ordered.filter(f => !/(^|\/)readme/i.test(f.path))].slice(0, 12);
    let got = [];
    try { got = readCodeFiles(e.path, picked.map(f => f.path), { perFile: 12000, total: room }); }
    catch (err) { continue; }
    if (!got.length) continue;
    const block = ['【文件夹资料：' + e.name + '（' + e.path + '）】'];
    for (const f of got) {
      block.push('--- ' + f.path + (f.truncated ? '（过长已截断）' : '') + ' ---', f.text);
      list.push({ root: e.path, path: f.path });
      room -= f.text.length;
    }
    parts.push(block.join('\n'));
    if (room <= 1000) break;
  }
  if (!parts.length) return { block: '', list: [] };
  return { block: parts.join('\n\n').slice(0, 60000), list };
}

/** 从 code_files（新老两种形状）读回文件，供教程修改时复用 */
function readStoredCodeFiles(stored) {
  const out = [];
  let arr = stored;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) || []; } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  /* 新形状 {root, path} 按各自 root 读；老形状字符串按 APP_DIR 读（调用方传 appDir） */
  const byRoot = new Map();
  for (const it of arr) {
    if (it && typeof it === 'object' && it.path) {
      const r = String(it.root || '');
      if (!r) continue;
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(String(it.path));
    }
  }
  for (const [root, rels] of byRoot) {
    try {
      for (const f of readCodeFiles(root, rels)) out.push({ root, path: f.path, text: f.text, truncated: f.truncated });
    } catch (e) {}
  }
  return out;
}

/* ============ 给 AI 准备节点文件夹代码（教程 / 拆分共用） ============
 * 流程：收敛有效文件夹 → AI 看清单挑文件 → 读挑中的。
 * 哪一步失败都回落到启发式（README + 小文件），再失败就返回空 ——
 * 调用方（教程/拆分）照常往下走，不卡死。send 可选，用来刷状态行。 */
async function prepareNodeCode(o) {
  const empty = { block: '', list: [] };
  const { aiText, model, db, nodeId, title, detail } = o || {};
  if (typeof aiText !== 'function' || !db || !nodeId) return empty;
  const send = typeof o.send === 'function' ? o.send : () => {};
  /* signal 可传可不传：教程/拆分取消时，让"AI 挑文件"这一步也能立刻停下，
     而不是白打一次调用再等下一个检查点。 */
  const signal = o.signal || null;
  const budget = Math.max(5000, Math.min(60000, Number(o.budget) || 30000));
  const skipRoots = o.skipRoots instanceof Set ? o.skipRoots : new Set();
  const realOf = p => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
  let entries = [];
  try {
    entries = collectFolderEntries(db, Number(nodeId))
      .filter(e => !e.missing && !skipRoots.has(realOf(e.path)));
  } catch (e) { return empty; }
  if (!entries.length) return empty;
  /* 先让 AI 挑；挑不出来（没给 JSON / 全不在清单里 / 超时）再启发式兜底 */
  try {
    send({ status: 'AI 正在看文件清单，挑这次要读的源码…' });
    const sel = buildSelectionList(entries, 1200);
    const picked = await selectFilesWithAI(aiText, model,
      { title, detail, listText: sel.text, allow: sel.allow, timeoutMs: 120000, signal });
    const g = readSelectedFiles(picked.picked, budget);
    if (g.list.length) {
      send({ status: `AI 挑了 ${g.list.length} 个文件：${picked.picked.slice(0, 3).map(x => String(x.path).split('/').pop()).join('、')}${g.list.length > 3 ? '…' : ''}` });
      return g;
    }
  } catch (err) {
    if (err && (err.cancelled || err.name === 'AbortError')) throw err;
    console.log('[node-folders] AI 选文件失败，回落启发式:', err.message);
  }
  try {
    return gatherFolderCode(entries, budget);
  } catch (e) { return empty; }
}

/* ================= AI 自动挑文件 =================
 * 用户不勾选时，教程生成前先让 AI 看一眼文件清单，自己挑最相关的读。
 * 比写死的「README + 小文件」准：比如学 RAG 架构，AI 会去挑
 * api/server.py、internal/engine 这类入口和核心实现，而不是子目录的 README。 */

/** 把各文件夹的文件清单压成 AI 能看的文本。太大就按目录截（每目录留前 12 个）。 */
function buildSelectionList(entries, maxEntries) {
  const max = Math.max(50, Math.min(3000, Number(maxEntries) || 1200));
  const lines = [];
  const allow = [];
  let total = 0, cut = false;
  const realOf = p => { try { return fs.realpathSync(p); } catch (err) { return path.resolve(p); } };
  for (const e of (entries || [])) {
    if (!e || e.missing) continue;
    let files = [];
    try { files = listCodeFiles(e.path); } catch (err) { continue; }
    if (!files.length) continue;
    const root = realOf(e.path);
    for (const f of files) allow.push({ name: e.name, root, path: f.path });
    lines.push('【' + e.name + '】共 ' + files.length + ' 个可读文件：');
    total++;
    /* 按目录分组，每目录最多 12 个，超了只记数（保证 AI 看到结构全貌） */
    const byDir = new Map();
    for (const f of files) {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(根)';
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(f);
    }
    for (const [d, fs2] of byDir) {
      for (const f of fs2.slice(0, 12)) {
        if (total >= max) { cut = true; break; }
        lines.push('- ' + e.name + '/' + f.path);
        total++;
      }
      if (cut) break;
      if (fs2.length > 12) { lines.push('  （' + d + ' 下还有 ' + (fs2.length - 12) + ' 个，略）'); total++; }
    }
    if (cut) break;
  }
  if (cut) lines.push('（清单太长已截断，优先看上面列出的入口、README 和核心目录）');
  return { text: lines.join('\n'), truncated: cut, allow };
}

/** 从 AI 回复里抠 JSON（本模块自带，不依赖 server.js 的同名函数） */
function pickJSONObject(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { break; } } }
    }
  }
  return null;
}

/**
 * 让 AI 从清单里挑文件。返回 [{root, path}]（已逐一对清单校验过，
 * 编造的路径、..、超长的一律丢掉）。失败抛错，调用方回落到启发式。
 */
async function selectFilesWithAI(aiText, model, opts) {
  const o = opts || {};
  const listText = String(o.listText || '').trim();
  if (!listText) throw new Error('没有文件清单');
  const allow = o.allow || [];
  const allowSet = new Set(allow.map(a => a.root + '\n' + a.path));
  const prompt = [
    '你是代码导航员。用户正在学【' + String(o.title || '').slice(0, 80) + '】',
    o.detail ? '（' + String(o.detail).slice(0, 200) + '）' : '',
    '下面是他挂载的源码文件夹的文件清单。请挑出讲解这个知识点**最值得读的最多 12 个文件**。',
    '挑的原则：入口文件（main/server/router/index）、核心实现、配置文件各来一点；',
    'README 只留 1-2 个最相关的；测试文件、翻译版 README、纯数据/迁移脚本不要。',
    '严格只输出一个 JSON 对象，不要代码围栏、不要任何额外文字：',
    '{"files":["文件夹名/相对路径", ...], "why":"一句话说为什么挑这些（40字内）"}',
    '',
    '=== 文件清单 ===',
    listText
  ].filter(x => x !== '').join('\n');
  const raw = await aiText(prompt, model, o.timeoutMs || 120000, null, o.signal || null);
  const j = pickJSONObject(raw);
  if (!j || !Array.isArray(j.files)) throw new Error('AI 没给出文件清单');
  const out = [];
  const seen = new Set();
  for (const item of j.files.slice(0, 12)) {
    const s = String(item || '');
    const k = s.indexOf('/');
    if (k < 1) continue;
    const folderName = s.slice(0, k), rel = s.slice(k + 1).replace(/\\/g, '/').replace(/^\.\/+/, '').trim().slice(0, 160);
    if (!rel || rel.includes('..')) continue;
    /* 路径必须精确命中清单里的某一项（防编造） */
    const hit = allow.find(a => a.name === folderName && a.path === rel)
      || allow.find(a => a.path === rel || a.path.endsWith('/' + rel) || rel.endsWith('/' + a.path));
    if (!hit) continue;
    const key = hit.root + '\n' + hit.path;
    if (seen.has(key)) continue;
    seen.add(key);
    void allowSet;
    out.push({ root: hit.root, path: hit.path });
  }
  if (!out.length) throw new Error('AI 挑的文件都不在清单里');
  return { picked: out, why: String(j.why || '').slice(0, 100) };
}

/** 按挑中的清单读文件（预算内），返回 {block, list}，形状与 gatherFolderCode 一致 */
function readSelectedFiles(picks, budget) {
  let room = Math.max(1000, Math.min(60000, Number(budget) || 30000));
  const byRoot = new Map();
  for (const p of (picks || []).slice(0, 12)) {
    if (!p || !p.root || !p.path) continue;
    if (!byRoot.has(p.root)) byRoot.set(p.root, []);
    byRoot.get(p.root).push(p.path);
  }
  const parts = [];
  const list = [];
  for (const [root, rels] of byRoot) {
    let got = [];
    try { got = readCodeFiles(root, rels, { perFile: 15000, total: room }); }
    catch (e) { continue; }
    if (!got.length) continue;
    parts.push('【文件夹资料（AI 精选）：' + root + '】\n' + got.map(f =>
      '--- ' + f.path + (f.truncated ? '（过长已截断）' : '') + ' ---\n' + f.text).join('\n'));
    for (const f of got) { list.push({ root, path: f.path }); room -= f.text.length; }
    if (room <= 1000) break;
  }
  if (!parts.length) return { block: '', list: [] };
  return { block: parts.join('\n\n').slice(0, 60000), list };
}

module.exports = {
  validateAttachFolder, parseNodeSources, collectFolderEntries,
  folderBodyForPrompt, gatherFolderCode, readStoredCodeFiles,
  buildSelectionList, selectFilesWithAI, readSelectedFiles, prepareNodeCode, DENY_HOME_NAMES
};
