'use strict';
/**
 * 改教程的「结构守卫」——判断这次改动是不是把不该动的章节改没了。
 *
 * 为什么要有它：用户只说"这一段讲得不清楚"，AI 却把大半本教程重写了
 * （实测一次编辑掉了 22 节里的 14 节：分步实践、验收标准、面试追问全没了），
 * 而长度校验只看总长、完全看不出来。
 *
 * 为什么从"一律拒收"改成"分范围"（2026-10-14 的真实误判）：
 *   用户明确要求「从『把 interview 工具包成 MCP Server 的三步实践』这一节起，直到全篇结束」
 *   重写（37 节里要改 25 节，还要合并去重、统一编号），AI 照做 →
 *   掉了 12+ 个标题 → 被自己人拒收，点重试又原样失败一次，每次白写 3 分钟。
 *   守卫必须能区分「范围外被删」（真问题）和「范围内按用户要求重组」（该放行）。
 *
 * 于是：
 *   · 意见里点名了范围（"从「X」往后 / 直到全篇结束 / 第 7 节之后"）→ 只要求 X **之前**的章节保留；
 *   · 意见里明说允许整篇重写（"允许重写结构 / 整篇重写 / 推倒重来"）→ 不做结构判定；
 *   · 都不是 → 按老规矩整篇都要求保留（阈值也照旧，不误伤）。
 *   · 无论哪种，范围内的内容都不许被删成空壳（字数下限兜底）。
 *
 * 本模块只做纯文本处理（不碰 db / AI），方便单独验证。
 */

/* ---------- 标题 ---------- */

/** Markdown 里的 ## / ### 标题，按出现顺序（带字符下标与层级：用来算"从哪一节开始"、"这一节到哪结束"）。 */
function headings(md) {
  const out = [];
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(String(md || '')))) {
    const lvl = m[1].length;
    if (lvl < 2 || lvl > 3) continue;                 // 只看 ## / ###（一级标题是文档标题，不算章节）
    out.push({ title: m[2].trim(), offset: m.index, level: lvl });
  }
  return out;
}

/** 标题归一化：剥掉编号（"七、" "3." "第一步："）与标点空白，只留能认出这一节的词。
 *  逐字比对太脆 —— 重写时最爱干的就是重新编号、换标点，那不该算"章节消失"。 */
function normHeading(raw) {
  return String(raw || '')
    .replace(/^[\s#>*\-—–]+/, '')
    .replace(/^第\s*[0-9一二三四五六七八九十百零]+\s*[步章节部分课讲]\s*[:：、.．]?\s*/, '')
    .replace(/^[0-9０-９]+\s*[、.．)）:：]\s*/, '')
    .replace(/^[一二三四五六七八九十百]+\s*[、.．)）:：]\s*/, '')
    .replace(/[\s，。、；;：:！？!?（）()【】\[\]「」『』《》〈〉"'“”‘’·—–\-_/\\|~～]+/g, '')
    .toLowerCase();
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
/* 最长公共子串（标题都很短，O(n·m) 足够）。用来认"换了说法的同一节"。 */
function longestCommon(a, b) {
  let best = 0;
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (row[j] > best) best = row[j];
      prev = cur;
    }
  }
  return best;
}

/** 两个标题像不像同一节：归一化后相等 / 一方包含另一方 / 开头一致 / 有够长的一段一样。
 *  ⚠️ 别用"二元字重叠率"来判 —— 实测把它判成同一节过：
 *  「二、三角色：Host / Client / Server」vs「七、映射到思而行：插件≈Server，路由≈Client」
 *  两节只共用了 Server/Client 几个词，重叠率却有 0.5，于是范围外的章节被删了也判"还在"。 */
function sameHeading(a, b) {
  const x = normHeading(a), y = normHeading(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  if (commonPrefix(x, y) >= 4) return true;
  return longestCommon(x, y) >= 8;
}

/** 一组标题里有没有"还在的"同一个标题 */
function keptIn(list, h) {
  for (const x of list) if (sameHeading(x.title, h.title)) return true;
  return false;
}

/* ---------- 这次意见允许动到哪 ---------- */

/* 明说允许整篇重写 / 允许改结构 */
const ALLOW_ALL_RE = /允许重写|允许改结构|允许改动章节结构|允许改章节结构|允许重排|可以改结构|结构可以改|不用保留原(有)?结构|不保留原(有)?结构|推倒重来|重写整篇|整篇重写|全篇重写|重写全篇|整本重写|重写整本|重新组织(整篇|全文|全篇|结构)|重构结构|重排结构|重新编排|全部推倒|统统重写|整篇都改|通篇重写|从头到尾|从头来|从头写起|从头重写/;
/* 出现这些词 = 这次说的是"从某处往后的范围" */
const RANGE_ANY_RE = /(开始|起)?[^。；;！!？?\n]{0,14}(往后|往后的|之后|以后|以下|直到全篇结束|到全篇结束|到最后|直到最后|到结尾|到末尾|直到结尾|剩余部分|剩下的部分|余下部分|后面所有|后面的内容|后面全部|后面的|后半部分|后半篇|后面几节|后面)/;
/* 出现这些词 = 这次确实在要求"改写"，不是只提意见 */
const REWRITE_RE = /重写|重做|改写|重构|重组|重新写|重排|重编|合并|精简|整理|梳|展开|扩写|补写|优化/;
/* 引号里的章节名（用户与 Agent 通常直接抄标题） */
const QUOTED_RE = /[「『《“"]([^」』》”"\n]{2,60})[」』》”"]/g;
/* "只重写「X」这一节" 这种写法：范围就是这一节本身（Agent 最常用的一种） */
const ONLY_SECTION_RE = /(?:只|仅|单独)?\s*(?:重写|改写|重做|改|补写|补全|展开|整理)\s*[「『《“"]/;
/* 范围说法后面紧跟这些词 → 那是在**钉边界**（"这一节之后的都不要动"），不是"从这儿往后重写" */
const BOUND_RE = /^[^。；;！!？?\n]{0,6}?(都不要动|不许动|不要动|都不要改|不许改|不要改|别动|原样保留|一字不动|一字不|保持原样|保持不变)/;
/* 范围有上界："从「A」开始，到「B」之前结束" —— 只改 A~B 之间，后面的目录也要原样保留 */
const UNTIL_RE = /(?:到|直到|至)\s*[「『《“"]([^」』》”"\n]{2,60})[」』》”"]\s*(?:之前|以前|为止|前)?/;

/* 「不要写『允许重写结构』」这类**否定**说法必须先摘掉，再判有没有真的授权。
   真实翻车（2026-10-14）：Agent 在意见里提醒模型"不要写「允许重写结构」"，
   而那四个字本身命中了豁免 → 结构守卫被这句话关掉 → AI 顺手删掉 12 节有用内容，一路放行。
   另一个真实翻车：Agent 写"允许重写该节内部的子标题与结构"（只授权某一节），
   也被当成"整篇都允许改"。 */
function permissionText(s) {
  return String(s || '')
    /* 先保住这几个"本来就是允许"的说法（它们自己就含"不"字） */
    .replace(/不(用|要)保留原(有)?结构/g, '【允许改结构】')
    /* 只授权"某一节内部"的说法不算整篇授权 */
    .replace(/允许(重写|改|改动|重排|重组|调整)[^。；;！!？?\n]{0,12}?(该|本|这|此)(一)?(节|章|部分|小节|段)[^。；;！!？?\n]{0,12}/g, ' ')
    .replace(/(?:不|别|勿|莫|无需|没必要|不要|不准|禁止|严禁|不许)[^。；;！!？?\n]{0,12}/g, ' ');
}

/** 中文数字 → 数字（够用就行：一节到九十九节） */
function cnNum(s) {
  const t = String(s || '').trim();
  if (/^[0-9]+$/.test(t)) return Number(t);
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[一二三四五六七八九十]+$/.test(t)) {
    const i = t.indexOf('十');
    if (i < 0) return D[t] || 0;
    const tens = i === 0 ? 1 : (D[t.slice(0, i)] || 0);
    const ones = D[t.slice(i + 1)] || 0;
    return tens * 10 + ones;
  }
  return 0;
}

/** 标题自带的编号（"七、" "12." "第 3 步："）→ 数字；没有编号返回 0 */
function headingNo(raw) {
  const s = String(raw || '');
  let m = s.match(/^第\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*[步章节部分课讲]/);
  if (m) return cnNum(m[1]);
  m = s.match(/^([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*[、.．)）]/);
  return m ? cnNum(m[1]) : 0;
}

/** 在原文里定位"用户点名的起点"：先按标题比对，再按正文里的原话定位。找不到返回 -1。 */
function locateAnchor(md, hs, name) {
  const raw = String(name || '').trim();
  if (!raw) return -1;
  const n = normHeading(raw);
  if (n) {
    let idx = hs.findIndex(h => normHeading(h.title) === n);
    if (idx >= 0) return idx;
    idx = hs.findIndex(h => sameHeading(h.title, raw));
    if (idx >= 0) return idx;
  }
  const at = raw.length >= 4 ? md.indexOf(raw) : -1;
  if (at >= 0) {
    let best = -1;
    for (let i = 0; i < hs.length; i++) if (hs[i].offset <= at) best = i;
    return best;
  }
  return -1;
}

/** 这次意见允许动到哪。返回 { mode:'all'|'range'|'doc', fromIdx?, fromTitle?, why } */
function parseEditScope(feedback, md, opts) {
  const o = opts || {};
  if (o.allowRestructure) return { mode: 'all', why: '调用方明确允许改结构' };
  const s = String(feedback || '');
  const hs = headings(md);
  /* 进这道分支的前提：意见里像是有"范围" —— 要么有范围说法（往后/之后/到全篇结束…），
     要么是"从「X」…"这种点名写法（含"从「A」到「B」之前"）。 */
  const looksScoped = RANGE_ANY_RE.test(s) || ONLY_SECTION_RE.test(s)
    || (/[「『《“"]/.test(s) && /(从|自)[^。；;！!？?\n]{0,12}[「『《“"]/.test(s));
  if (hs.length >= 5 && looksScoped) {
    /* ⓪ "只重写「X」这一节（含其下……）" → 范围就是**这一节本身**（含它的子节），前后都不许动。
       这是 Agent 最常用的写法（"重写范围：只重写「X」这一节"），
       以前会走 ①/③ 把它理解成"从某个地方往后"，锚点可能落到 X 里面的某个子节上 ——
       于是同一节的前半截被当成"范围外"，AI 照意见重排时反被拒收（真实翻车）。 */
    const onlyM = s.match(/(?:只|仅|单独)?\s*(?:重写|改写|重做|改|补写|补全|展开|整理)\s*[「『《“"]([^」』》”"\n]{2,60})[」』》”"]/);
    if (onlyM) {
      const idx0 = locateAnchor(md, hs, onlyM[1]);
      if (idx0 >= 0) {
        /* "重写「A」「B」两节" 这种连着点名的：范围一直包到最后一个（同一句里、且相隔不远） */
        let lastIdx = idx0;
        const seg0 = s.slice(onlyM.index, onlyM.index + 240).split(/[。；;\n]/)[0] || '';
        let extra = 0;
        for (const m2 of seg0.matchAll(QUOTED_RE)) {
          if (++extra > 4) break;
          const j = locateAnchor(md, hs, m2[1]);
          if (j > lastIdx && j - idx0 <= 12) lastIdx = j;
        }
        const lvl = hs[lastIdx].level || 2;
        let end0 = hs.length;
        for (let i = lastIdx + 1; i < hs.length; i++) if ((hs[i].level || 2) <= lvl) { end0 = i; break; }
        return {
          mode: 'range', fromIdx: idx0, toIdx: end0,
          fromTitle: hs[idx0].title, toTitle: end0 < hs.length ? hs[end0].title : '',
          why: '只重写「' + hs[idx0].title + '」' + (lastIdx > idx0 ? ' 等 ' + (lastIdx - idx0 + 1) + ' 节' : '这一节')
        };
      }
    }
    /* ① 引号里的章节名 + 范围说法（范围说法必须紧跟在这个名字后面，免得被别处的"之后"误带） */
    let miss = '';
    for (const m of s.matchAll(QUOTED_RE)) {
      const name = m[1].trim();
      if (name.length < 2) continue;
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 24);
      if (!RANGE_ANY_RE.test(after) && !/^[，,]?\s*(这|那)?(一)?(节|章|部分)?\s*(开始|起)/.test(after)) continue;
      if (BOUND_RE.test(after)) continue;      // "之后的都不要动"是在钉边界，不是重写范围
      const idx = locateAnchor(md, hs, name);
      if (idx < 0) { miss = miss || name; continue; }     // 引号里的也许不是章节名，换下一个
      /* "到「B」之前结束" → 上界，B 及其之后同样受保护（Agent 常这么钉边界） */
      let toIdx = hs.length, toTitle = '';
      const um = UNTIL_RE.exec(s.slice(m.index + m[0].length, m.index + m[0].length + 200));
      if (um) {
        const bi = locateAnchor(md, hs, um[1]);
        if (bi > idx) { toIdx = bi; toTitle = hs[bi].title; }
      }
      return {
        mode: 'range', fromIdx: idx, toIdx, fromTitle: hs[idx].title, toTitle,
        why: '从「' + hs[idx].title + '」' + (toTitle ? '到「' + toTitle + '」之前' : '往后') + '允许重组'
      };
    }
    /* ② "第 N 节之后"：先认标题自己的编号（"七、" / "7." / "第7节"），认不出再按第 N 个标题算 */
    const ord = s.match(/第\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*节/);
    if (ord && !BOUND_RE.test(s.slice(ord.index + ord[0].length, ord.index + ord[0].length + 30))) {
      const n = cnNum(ord[1]);
      if (n >= 1) {
        const numIdx = hs.findIndex(h => headingNo(h.title) === n);
        if (numIdx >= 0) return { mode: 'range', fromIdx: numIdx, fromTitle: hs[numIdx].title, why: '从「' + hs[numIdx].title + '」（第 ' + n + ' 节）往后允许重组' };
        if (n <= hs.length) return { mode: 'range', fromIdx: n - 1, fromTitle: hs[n - 1].title, why: '从第 ' + n + ' 个标题往后允许重组' };
      }
    }
    /* ③ 没引号、也没序号，但意见里整句抄了某一节的标题（用户常这么写）→ 拿最长的那个当起点。
       抄了标题不等于"从这里往后重写"：标题后面紧跟"都不要动/原样保留"的那种是在钉边界，跳过。 */
    const cands = hs.map((h, i) => ({ i, h }))
      .filter(x => {
        if (x.h.title.length < 6) return false;
        const at = s.indexOf(x.h.title);
        if (at < 0) return false;
        return !BOUND_RE.test(s.slice(at + x.h.title.length, at + x.h.title.length + 30));
      })
      .sort((a, b) => b.h.title.length - a.h.title.length);
    if (cands.length) {
      return { mode: 'range', fromIdx: cands[0].i, fromTitle: cands[0].h.title, why: '意见里照抄了标题「' + cands[0].h.title + '」+ 范围说法' };
    }
    /* ④ 有范围说法、也有明确的改写动作，但定位不到起点：宁可放行也不误拒
       （真改坏了还有「📜 版本对比」可回滚，而误拒一次要多等三分钟、还可能反复失败）。 */
    if (REWRITE_RE.test(s)) {
      return { mode: 'all', why: miss ? ('意见里有重写范围，但原文里定位不到「' + miss + '」→ 按允许改结构处理') : '意见里有范围说法与改写动作 → 按允许改结构处理' };
    }
  }
  if (ALLOW_ALL_RE.test(permissionText(s))) return { mode: 'all', why: '意见里明确允许整篇重写 / 改结构' };
  return { mode: 'doc', why: '没看出允许改结构 → 整篇标题都要求保留' };
}

/* ---------- 判定 ---------- */

/** 结构守卫。返回 null = 放行；否则返回一个描述（调用方据此报错/报警）。
 *  opts.allowRestructure = 调用方（接口参数 / 卡片上的「允许改结构再跑」）明确放行。 */
function structureLoss(before, after, feedback, opts) {
  const md = String(before || '');
  const out = String(after || '');
  const a = headings(md), b = headings(out);
  if (a.length < 5) return null;                 // 章节本来就不多，不做判断
  const sc = parseEditScope(feedback, md, opts);

  if (sc.mode === 'range') {
    const to = Number.isFinite(sc.toIdx) ? Math.max(sc.fromIdx + 1, Math.min(a.length, sc.toIdx)) : a.length;
    /* ① 范围外的章节：一章都不该少（有"到 B 之前"上界时，B 及其之后的目录同样受保护） */
    const outScope = a.filter((h, i) => i < sc.fromIdx || i >= to);
    if (outScope.length) {
      const lost = outScope.filter(h => !keptIn(b, h));
      if (lost.length) {
        return { kind: 'lost', scope: sc, had: a.length, outScope: outScope.length, inScope: to - sc.fromIdx, lost: lost.slice(0, 4) };
      }
    }
    /* ② 范围内允许重组，但不许删成空壳（头尾要原样保留的都算进下限里） */
    const anchorOffset = a[sc.fromIdx].offset;
    const tailOffset = to < a.length ? a[to].offset : md.length;
    const inScopeChars = Math.max(0, tailOffset - anchorOffset);
    if (inScopeChars > 4000) {
      const keepChars = anchorOffset + (md.length - tailOffset);
      const floor = Math.max(1500, Math.round(inScopeChars * 0.25));
      if (out.length < keepChars + floor) {
        return { kind: 'gutted', scope: sc, had: a.length, origLen: md.length, nowLen: out.length, inScopeChars, floor };
      }
    }
    return null;
  }

  if (sc.mode === 'all') return null;

  /* mode === 'doc'：老规矩 —— 整篇标题都要求保留，按比例判（≥4 个且 ≥30%） */
  const lost = a.filter(h => !keptIn(b, h));
  if (lost.length < 4 || lost.length / a.length < 0.3) return null;
  return { kind: 'lost', scope: sc, had: a.length, outScope: a.length, inScope: 0, lost: lost.slice(0, 4) };
}

/** 成功写入前的"结构变化说明"：让用户知道这次改了哪些章节（不再静默）。
 *  没有变化就返回空串。 */
function structureChangeNote(before, after) {
  const a = headings(before), b = headings(after);
  if (!a.length) return '';
  const lost = a.filter(h => !keptIn(b, h));
  const added = b.filter(h => !keptIn(a, h));
  if (!lost.length && !added.length) return '';
  const parts = [];
  if (lost.length) {
    parts.push('消失 ' + lost.length + ' 节（' + lost.slice(0, 3).map(x => x.title.slice(0, 18)).join('、')
      + (lost.length > 3 ? ' 等' : '') + '）');
  }
  if (added.length) parts.push('新增 ' + added.length + ' 节');
  return '章节结构有变化：' + parts.join('，') + '。';
}

module.exports = { headings, normHeading, sameHeading, parseEditScope, structureLoss, structureChangeNote };
