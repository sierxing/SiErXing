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

/* 挑"够具体"的词去正文里搜。
   ⚠️ tokensOf 对中文切的是**二字滑窗**（"下一步做什么" → 下一/一步/步做/做什/什么），
   这种词在本项目的中文注释里到处都是 —— 拿它搜正文，任何一句中文都会"命中"
   好几个文件，于是无关的问话也被判定为"要带源码"，白塞几万字进提示词。
   现在正文匹配只认：含 ASCII 的（标识符/路径/函数名）或 **三字以上**的中文词。
   路径匹配仍用全部词（路径是英文，二字词无害）。 */
function specificTokens(tokens, message) {
  const out = new Set();
  for (const t of tokens) if (/[a-z0-9]/i.test(t)) out.add(t);          // 标识符/路径：一定具体
  // 中文：不要二字滑窗（到处都匹配），改用「整段短语」+「三字以上滑窗」
  for (const run of String(message || '').toLowerCase().match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (run.length <= 6) out.add(run);                                  // 短短语整体保留（本身就是词）
    for (let n = 3; n <= Math.min(6, run.length); n++) {
      for (let i = 0; i + n <= run.length; i++) { out.add(run.slice(i, i + n)); if (out.size > 60) break; }
      if (out.size > 60) break;
    }
    if (out.size > 60) break;
  }
  return Array.from(out).slice(0, 60);
}

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
  /* 正文是否值得注入，只看一件事：**这句话里有没有"像文件名/路径"的词**。
     理由：中文注释里几乎任何三字词组都能搜到命中，靠词面匹配判断
     "这个问题与代码有关吗"是做不到的（试过二字滑窗、三字滑窗、去重计分，
     都会把"下一步做什么"判成"要看源码"）。而用户被要求（提示词里写明了）
     "要看别的文件时直接写文件路径或关键词"，所以"点名文件"这个信号最准。
     没点名时只给【文件清单】，AI 知道有哪些文件、可以反过来让用户指名。 */
  const pathLike = tokens.filter(t => /[a-z0-9]/i.test(t) && /[./_-]|[a-z]{3,}/i.test(t));
  let re = null;
  if (pathLike.length) {
    const ctoks = specificTokens(tokens, message);
    re = ctoks.length ? new RegExp(ctoks.map(escRe).join('|'), 'gi') : null;
  }
  /* ⚠️ 无信号就不注入正文（线上翻车修）：
     原来的规则是"零命中文件也在凑门面时补几个"（下方 out.length>=6 那句），
     于是**任何一句与代码无关的话**（如"下一步做什么"）也会被塞进
     6 × 10000 = 40000 字的无关源码。用户目标里一旦导入过代码库，
     每次对话的提示词就凭空多 4 万字 ≈ 27k tokens，模型要先把这些读完才开始回答
     —— 表现就是"发消息响应特别慢"。
     现在：完全没命中（score 全为 0）时**只给文件清单，不给正文**，
     让 AI 知道有哪些文件、需要时让用户点名；
     requireHits=true 时即便有命中也不再补零命中文件充数。 */
  const scored = [];
  for (const f of rows) {
    const p = String(f.path || '');
    const pl = p.toLowerCase();
    let hit = 0;
    if (pl && lowerMsg.includes(pl)) hit += 1000;                      // 消息里直接点名了这个文件
    else { for (const t of tokens) { if (pl.includes(t)) { hit += 100; break; } } }
    if (re && f.content) {
      const m = String(f.content).match(re);
      /* 内容命中：按**去重后的词数**给分（不是命中次数）。
         同一句注释里同一个词重复 40 次，不代表这个文件相关。 */
      if (m) {
        const uniq = new Set(m.map(x => String(x).toLowerCase()));
        hit += Math.min(uniq.size * 40, 240);
      }
    }
    scored.push({ path: p, root: f.root || '', content: String(f.content || ''), truncated: !!f.truncated, score: hit, facade: facadeScore(pl) });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.facade - a.facade) || a.path.localeCompare(b.path));
  const out = [];
  let used = 0;
  if (o.requireHits && !pathLike.length) return [];                    // 没点名文件 → 一个字正文都不给
  for (const f of scored) {
    if (out.length >= maxFiles || used >= maxChars) break;
    if (f.score <= 0) {
      if (o.requireHits) break;                                        // 只要真命中，不拿零命中文件充数
      if (out.length >= 6) break;                                      // 兼容旧行为：最多补几个门面文件
    }
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
