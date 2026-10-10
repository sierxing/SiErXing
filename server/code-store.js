'use strict';
/**
 * 思而行 · 代码库快照存取 + 对话检索挑选
 * ------------------------------------------------------------------
 * 「信息源 → 导入代码库」除了生成学习摘要，还把**可读文件整体**存一份快照
 * （code_repo_files 表，只读、已脱敏）。摘要回答"这个项目是什么、怎么读"，
 * 快照回答"某段逻辑到底怎么写的" —— AI 助手对话时按用户问题从快照里挑文件。
 *
 * 安全与边界：
 *   · 真正的读盘策略在 server/code-read.js（黑名单 / 扩展名白名单 / 尺寸封顶 /
 *     密钥脱敏），本模块只做「存」和「挑」，且只读不写用户目录；
 *   · 单仓库封顶 MAX_FILES 个文件 / MAX_TOTAL_CHARS 字符，超出部分不存；
 *   · 对话是单次提示词，装不下整库，所以按问题检索：点名文件 > 关键词命中 >
 *     门面文件（README / 依赖清单 / 入口）兜底，并附完整文件清单告诉模型有什么。
 */
const { listCodeFiles, readCodeFiles } = require('./code-read');

const MAX_FILES = 1500;
const MAX_TOTAL_CHARS = 6 * 1024 * 1024;
const PER_FILE = 48000;        // 单文件快照上限：覆盖绝大多数源码文件（code-read 层另有 400KB 硬上限）
const BATCH = 24;              // readCodeFiles 单次最多读 24 个路径

/** 把一份代码库读成快照存进 code_repo_files（同 root 旧快照先清掉，重导即覆盖） */
function storeCodeRepoFiles(db, goalId, sourceId, root, nowISO) {
  db.prepare('DELETE FROM code_repo_files WHERE goal_id = ? AND root = ?').run(goalId, root);
  const all = listCodeFiles(root);
  const sizeOf = {};
  for (const f of all) sizeOf[f.path] = f.size || 0;
  const ins = db.prepare('INSERT INTO code_repo_files (goal_id, source_id, root, path, size, content, truncated, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const now = typeof nowISO === 'function' ? nowISO() : new Date().toISOString();
  let files = 0, chars = 0, secrets = 0;
  for (let i = 0; i < all.length && files < MAX_FILES && chars < MAX_TOTAL_CHARS; i += BATCH) {
    const batch = all.slice(i, i + BATCH).map(f => f.path);
    const read = readCodeFiles(root, batch, { perFile: PER_FILE, total: PER_FILE * BATCH });
    for (const f of read) {
      if (files >= MAX_FILES || chars >= MAX_TOTAL_CHARS) break;
      ins.run(goalId, sourceId || 0, root, f.path, sizeOf[f.path] || 0, f.text, f.truncated ? 1 : 0, now);
      files++; chars += f.text.length; secrets += f.secrets || 0;
    }
  }
  return { files, chars, secrets, total: all.length };
}

/* 从消息里抽检索词：英文单词 / 路径片段 + 中文二元组（中文没有空格，二元组最省事又够用） */
function tokensOf(message) {
  const s = String(message || '').toLowerCase();
  const out = new Set();
  for (const m of s.match(/[a-z0-9][a-z0-9_.\/_-]{2,}/g) || []) out.add(m);
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    if (out.size > 80) break;
  }
  return Array.from(out).slice(0, 60);
}
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 「门面文件」加成：只在**没有任何命中**（泛问"这个项目是干什么的"）时才起作用，
   不能和命中分相加 —— 否则 README 里随便提一句文件名，就会把真正含关键词的源码挤下去。 */
function facadeScore(p) {
  const b = String(p).split('/').pop();
  let s = 0;
  if (/^readme(\.|$)/i.test(b)) s += 120;
  if (/^(package|requirements|pyproject|composer|pom|build\.gradle|go\.mod)(\.|$)/i.test(b)) s += 110;
  if (/^(app|index|main|server|manage|cli|run)\.(js|ts|mjs|cjs|py|go|java|rb)$/i.test(b)) s += 80;
  if (String(p).split('/').length <= 2) s += 18;
  return s;
}

/** 挑出与消息最相关的文件（rows = code_repo_files 的行，含 content） */
function pickCodeContext(rows, message, opts) {
  const o = opts || {};
  const maxFiles = o.maxFiles || 10;
  const maxChars = o.maxChars || 40000;
  const perFile = o.perFile || 10000;
  const lowerMsg = String(message || '').toLowerCase();
  const tokens = tokensOf(message);
  const re = tokens.length ? new RegExp(tokens.map(escRe).join('|'), 'gi') : null;
  const scored = [];
  for (const f of rows) {
    const p = String(f.path || '');
    const pl = p.toLowerCase();
    let hit = 0;
    if (pl && lowerMsg.includes(pl)) hit += 1000;                      // 消息里直接点名了这个文件
    else { for (const t of tokens) { if (pl.includes(t)) { hit += 100; break; } } }
    if (re && f.content) {
      const m = String(f.content).match(re);
      if (m) hit += Math.min(m.length * 10, 300);                      // 内容命中（封顶，防高频词淹没）
    }
    scored.push({ path: p, root: f.root || '', content: String(f.content || ''), truncated: !!f.truncated, score: hit, facade: facadeScore(pl) });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.facade - a.facade) || a.path.localeCompare(b.path));
  const out = [];
  let used = 0;
  for (const f of scored) {
    if (out.length >= maxFiles || used >= maxChars) break;
    if (f.score <= 0 && out.length >= 6) break;                        // 零命中文件只在凑门面时补几个
    const room = Math.min(perFile, maxChars - used);
    const full = String(f.content);
    let t = full, mid = false, cut = f.truncated;
    if (t.length > room) {
      /* 大文件不能只截开头 —— 命中点常在文件中部（如 ai.js 的 openaiText），
         而头部注释里可能先出现过一次同名词、把窗口锚到开头。规则：
         按「窗口内命中权重之和」选窗口（更长/更具体的词权重更高），
         同权重取更靠前的窗口。 */
      let start = 0;
      if (re) {
        try {
          const rx = new RegExp(re.source, 'gi');
          const pos = [];
          let m;
          while ((m = rx.exec(t)) !== null) { pos.push({ i: m.index, w: Math.min(String(m[0]).length, 16) }); if (pos.length >= 500) break; }
          let best = 0, bestW = -1;
          for (const p0 of pos) {
            const s = Math.max(0, Math.min(p0.i - Math.floor(room * 0.25), t.length - room));
            let w = 0;
            for (const q of pos) if (q.i >= s && q.i < s + room) w += q.w;
            if (w > bestW) { bestW = w; best = s; }
          }
          start = best;
        } catch (e) {}
      }
      t = t.slice(start, start + room);
      mid = start > 0;
      cut = true;
    }
    if (!t.trim()) continue;
    out.push({ path: f.path, root: f.root, text: t, truncated: cut, mid });
    used += t.length;
  }
  return out;
}

module.exports = { storeCodeRepoFiles, pickCodeContext, tokensOf, facadeScore };
