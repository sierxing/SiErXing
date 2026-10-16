/* ===== 教程生成：外层 Plan-and-Execute + 内层 ReAct + 关键节点 Reflection =====
 *
 * 为什么不再"一次调用写完整篇"：
 *   单次生成上万字的教程，撞上模型输出上限时会被拦腰截断。而截断往往发生在
 *   围栏/可视化块**内部** —— 实测 MCP 那篇停在 viz 块中间一句
 *   `arguments: {role:"AI产品经理", count:`，只写出 2 个章节、8294 字，
 *   而围栏数是 3（奇数）。单看"长度够了、开头正常"完全看不出来。
 *
 * 拆成三步之后：
 *   1) 规划（1 次调用）：先定"这篇要讲哪几节、每节讲什么、哪节该配可视化"，
 *      拿到一份**可核对的大纲** —— 缺哪节是确定的，不用等正文截断才发现。
 *   2) 逐节生成（每节 1 次调用）：一节体量远小于整篇，几乎撞不到上限；
 *      每节独立体检，坏的只重写那节。模型在这层自己判断要不要配 ```viz。
 *   3) Reflection（1 次调用 + 定向补写）：对着大纲逐条核对成品。
 *
 * 规划或逐节生成失败时，调用方退回"单次生成"老路，所以最坏情况和以前一样，
 * 不会比以前更差。
 *
 * 本模块用工厂导出而不是直接 require —— 大纲/资料库那些提示词块都在
 * server.js 里是模块私有的，注入进来比把它们搬出去安全。
 */
module.exports = function initTutPlan(B) {
  const {
    goalHeader, goalQaBlock, constraintsBlock, siblingScopeBlock,
    digestsBlock, nodeSourcesBlock, sourcesIndexBlock, vizSpecLines
  } = B;

  /* 节数上限直接决定耗时（每节一次调用）。原来给到 9 节，实测光逐节生成
     就要 10 分钟以上，用户体感是卡死。7 节封顶 + 并发 3 路 ≈ 2~3 分钟。 */
  const PLAN_MIN = 4, PLAN_MAX = 7;

  /* ---------- 1) 外层：规划大纲 ---------- */
  function buildPlanPrompt(goal, node, note, codeBlock, budget) {
    const levelName = { 0: '阶段', 1: '小目标', 2: '任务', 3: '子任务', 4: '步骤', 5: '步骤' }[node.level] || '任务';
    const lines = [];
    lines.push('你是资深技术教程架构师。给下面这个任务**规划一份学习教程的大纲**，这一步只出计划、不写正文。');
    lines.push('');
    lines.push(goalHeader(goal));
    lines.push(goalQaBlock(goal));
    lines.push(constraintsBlock(goal));
    lines.push('');
    lines.push('【教程主题（' + levelName + '）】' + node.title);
    if (node.detail) lines.push('任务说明：' + node.detail);
    if (node.artifact) lines.push('应产出的成果：' + node.artifact);
    if (node.acceptance) lines.push('验收标准：' + node.acceptance);
    if (node.hours) lines.push('预计投入：' + node.hours);
    lines.push(siblingScopeBlock(goal, node));
    lines.push(digestsBlock(goal));
    lines.push(nodeSourcesBlock(goal, node, 1100));
    lines.push(sourcesIndexBlock(goal, 12, '【资料库其它条目（仅索引；与本节无关的一律不读不用）】'));
    if (codeBlock) { lines.push(''); lines.push(codeBlock); }
    if (note) { lines.push(''); lines.push('【用户的额外要求（必须满足）】' + note); }

    lines.push('');
    lines.push('【这一节教程必须包含的结构（每一项都要单独成节，不许合并、不许省略）】');
    lines.push('1. 开头：这份教程能让你掌握什么（能力清单）、需要的前置知识、预计时间分配。');
    lines.push('2. 知识点讲解：核心概念/原理——为什么需要它、解决什么问题、关键术语解释，要有类比或例子。');
    lines.push('3. 分步实践：每步写清「做什么 → 为什么这样做 → 具体怎么做（可复制的命令/代码/操作）→ 预期结果与自检 → 常见错误与排查」。');
    lines.push('4. 动手练习：2-3 个由浅入深的练习，附参考答案或思路提示。');
    lines.push('5. 自测清单：用可勾选的问题帮用户确认「我真的掌握了」（理解层面 + 操作层面）。');
    lines.push('6. 与验收标准对应：做完哪些事、达到什么状态算完成本任务。');
    lines.push('7. 延伸学习：想更深入可以看什么。');

    lines.push('');
    lines.push('【节点划分规则】');
    const lo = (budget && budget.sections ? Math.max(4, budget.sections - 1) : PLAN_MIN);
    const hi = (budget && budget.sections ? Math.min(PLAN_MAX, budget.sections + 1) : PLAN_MAX);
    lines.push('- 上面 7 项是**下限**，可以按知识点密度适当合并同类项（本次定 ' + lo + '~' + hi + ' 节）；');
    lines.push('  ⚠️ 节数直接决定用户等待时间（每节要生成一次），**宁少勿多**：能合并的合，不要为了看起来全而拆细；');
    if (budget && budget.target) {
      lines.push('  ⚠️ 整篇篇幅目标约 ' + budget.target + ' 字（这是给一个' + (budget.hours ? budget.hours + ' 小时' : '') + '的任务写的，'
        + '写长了用户看不完）：每节约 ' + budget.perSection + ' 字，**不要超**。'
        + '宁可讲透、不要灌水 —— 不要为凑篇幅重复解释、不要堆无关背景。');
    }
    lines.push('- 一节只讲一件事，标题要具体（不要"概述""介绍"这种空标题）；');
    lines.push('- 涉及流程 / 调用链 / 状态流转 / 时序先后 / 数据结构 / 并发交错 / 多方案对比的节，标 viz，');
    lines.push('  并在 vizIdea 里用一句话说清**画什么、怎么交互**');
    lines.push('  （例："泳道时序图，三条泳道，节点可点开看每一步发了什么报文"）；');
    lines.push('- 纯概念定义、清单、表格类不需要 viz。宁可少标，不要为了标而标。');

    lines.push('');
    lines.push('【输出格式】只输出一个 JSON 对象，不要代码块标记、不要任何解释文字：');
    lines.push('{"sections":[{"title":"本节标题（不含 # 号）","goal":"这一节要讲到什么程度、必须覆盖哪些点（80-150字）","viz":"flow|chart|sequence|sim|compare|panel 或空字符串","vizIdea":"viz 非空时必填：一句话说清画什么、怎么交互；viz 为空则填空字符串"}]}');
    return lines.join('\n');
  }

  function parsePlan(raw) {
    let s = String(raw || '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
    let j = null;
    try { j = JSON.parse(s); } catch (e) {}
    if (!j || !Array.isArray(j.sections)) return null;
    const out = [];
    for (const x of j.sections) {
      if (!x || !x.title) continue;
      const title = String(x.title).replace(/^#+\s*/, '').trim().slice(0, 60);
      if (!title) continue;
      out.push({
        title,
        goal: String(x.goal || '').trim().slice(0, 400),
        viz: x.viz ? String(x.viz).slice(0, 12) : '',
        vizIdea: String(x.vizIdea || '').trim().slice(0, 300)
      });
    }
    return out.length >= 2 ? out : null;
  }

  /* ---------- 2) 内层：逐节生成 ---------- */
  function buildSectionPrompt(sec, idx, total, plan, prevTail, tutorialTitle, codeBlock, neighbors, budget) {
    const lines = [];
    lines.push('你是耐心、严谨的技术导师。现在写一篇学习教程里的**其中一节**，只写这一节，不要写别的章节，也不要写全文的总结。');
    lines.push('');
    lines.push('【整篇教程的主题】' + tutorialTitle);
    lines.push('');
    lines.push('【全文大纲（已定稿，你这次只写第 ' + idx + ' 节）】');
    plan.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + s.title + (i === idx - 1 ? '   ←← 本次只写这一节' : '')));
    lines.push('');
    lines.push('【本节任务】');
    lines.push('标题：' + sec.title);
    lines.push('必须讲到什么程度：' + (sec.goal || '把这个标题该讲的内容讲透'));
    lines.push(sec.viz && sec.vizIdea
      ? '本节要配可视化（' + sec.viz + '）：' + sec.vizIdea
      : '本节没有配可视化，就用 Markdown 讲清楚，别硬塞图。');
    /* 并行生成时拿不到"上一节的结尾"，改用它俩的标题做衔接锚点 ——
       大纲本身已经限定了每节的范围，有边界就不会写重或写漏。 */
    const nb = neighbors || {};
    if (nb.prevSec || nb.nextSec) {
      lines.push('');
      const bits = [];
      if (nb.prevSec) bits.push('上一节是《' + nb.prevSec.title + '》');
      if (nb.nextSec) bits.push('下一节是《' + nb.nextSec.title + '》');
      lines.push('【上下文】' + bits.join('；') + '。开头别重复上一节已经讲过的东西，结尾也别提前把下一节的内容讲掉。');
    }
    lines.push('');
    if (prevTail) {
      lines.push('【上一节的结尾（照着它的语气和详略接着写，不要重复它的内容）】');
      lines.push(prevTail);
      lines.push('');
    }
    lines.push('【写作要求】');
    lines.push('1. 第一个字符就是二级标题「## ' + sec.title + '」，**不要**再写一级标题，也不要写总结段。');
    const per = (budget && budget.perSection) ? budget.perSection : 0;
    lines.push('2. 只写这一节，篇幅控制在 ' + (per
      ? Math.round(per * 0.6) + '~' + Math.round(per * 1.25) + ' 字（整篇预算 ' + (budget.target || '') + ' 字，写长了用户看不完）'
      : (idx === 0 ? '600~1200' : '900~2200') + ' 字') + '，写完就停；不要为凑篇幅重复或灌水。');
    lines.push('3. 讲原理和思路，不要只给结论；对关键步骤解释原因，让用户能举一反三。');
    lines.push('4. 使用中文；专业术语首次出现时给出英文与解释。');
    lines.push('5. 内容具体可执行：真实命令、真实代码（用带语言标注的围栏代码块）。');
    lines.push('6. 所有围栏代码块必须有收尾 ```。宁可少写一段，也绝不停在句子中间。');
    lines.push('7. 只写本节内容：不许提前写后面的章节，也不许回头补前面的章节。');
    lines.push('');
    for (const L of vizSpecLines()) lines.push(L);
    if (codeBlock) { lines.push(''); lines.push(codeBlock); }
    return lines.join('\n');
  }

  /* 单节体检：只看这一节自己的围栏和收尾。整篇体检会被上一节的噪声干扰。 */
  function sectionTruncated(txt) {
    const s = String(txt || '');
    if (s.length < 150) return '这一节几乎没有内容（' + s.length + ' 字）';
    const lines = s.split('\n');
    /* 以裸 ``` 开头的节：它的第一个围栏是**上一节那个块的收尾**，
       拿它当开围栏数必然得到奇数 → 误判成截断，白白重写一整节。
       真实翻过：线上教程里模型把代码块跨着章节拆开了。 */
    const startsMidBlock = /^\s*(`{3,}|~{3,})\s*$/.test(lines[0] || '');
    if (!startsMidBlock) {
      let open = null;
      for (const line of lines) {
        const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/);
        if (!m) continue;
        if (!open) { open = { mark: m[1][0], len: m[1].length }; continue; }
        if (m[1][0] === open.mark && m[1].length >= open.len && !m[2]) open = null;
      }
      if (open) return '代码块/可视化块没有闭合';
    }
    const tail = s.replace(/\s+$/, '');
    if (!tail || /```$/.test(tail)) return '';
    const lastLine = tail.split('\n').pop();
    /* 结尾落在半句话上：以未闭合的括号、冒号、或一个孤零零的字母数字结尾 */
    if (/[:：]\s*$/.test(tail)) return '结尾停在冒号上：「' + lastLine.slice(-30) + '」';
    if (/[(（[{[]\s*$/.test(tail)) return '结尾停在未闭合的括号上：「' + lastLine.slice(-30) + '」';
    if (/[A-Za-z0-9"']$/.test(tail) && lastLine.length > 6 && !/[.。!！?？)\]}）】:：;；]$/.test(tail)
        && !/`[^`]*$/.test(tail) && !/^\s*[-*+]\s/.test(tail) && !/\|/.test(tail)) {
      return '结尾停在半句话上：「' + lastLine.slice(-30) + '」';
    }
    return '';
  }

  /* ---------- 3) Reflection：对着大纲核对成品 ---------- */
  function buildReviewPrompt(tutorialTitle, plan, txt) {
    const lines = [];
    lines.push('你是严格的质量检查员。下面是一篇学习教程的**大纲**和**成品正文**。你只做检查、指出问题，不要重写正文。');
    lines.push('');
    lines.push('【主题】' + tutorialTitle);
    lines.push('');
    lines.push('【大纲（成品必须逐节对上）】');
    plan.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + s.title + (s.viz ? '（本节应有可视化）' : '')));
    lines.push('');
    lines.push('【成品正文】');
    lines.push(String(txt || '').slice(0, 60000));
    lines.push('');
    lines.push('【逐条检查，每项回答结果】');
    lines.push('a) 大纲里每一节，正文里是不是都能找到对应内容？列出**完全缺失**的节标题。');
    lines.push('b) 有没有哪一节明显没写完（停在半句话、代码块没闭合、该有的"预期结果/自检"缺失）？给出该节标题。');
    lines.push('c) 大纲标了 viz 的节，正文里对应的 ```viz 块在不在？列出没有的节标题。');
    lines.push('d) ```viz 块里是不是真正的 HTML（不是 -> v ^ | ─ │ ┌ ┐ 这类字符画）？列出不合格的节标题。');
    lines.push('e) 全文有没有代码块/可视化块没闭合？');
    lines.push('f) 正文有没有混进不属于本主题的其它章节内容？');
    lines.push('');
    lines.push('【输出格式】只输出一个 JSON 对象，不要代码块标记、不要解释：');
    lines.push('{"missing":[],"unfinished":[],"vizMissing":[],"vizNotHtml":[],"fenceOpen":false,"offTopic":false,"note":"其它问题的简短说明"}');
    lines.push('（上面每个数组填节标题字符串；fenceOpen / offTopic 填 true 或 false）');
    return lines.join('\n');
  }

  function parseReview(raw) {
    let s = String(raw || '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
    try {
      const j = JSON.parse(s);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      const arr = v => (Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
      return {
        missing: arr(j.missing), unfinished: arr(j.unfinished),
        vizMissing: arr(j.vizMissing), vizNotHtml: arr(j.vizNotHtml),
        fenceOpen: !!j.fenceOpen, offTopic: !!j.offTopic,
        note: String(j.note || '').slice(0, 300)
      };
    } catch (e) { return null; }
  }

  /* 成品里有没有这个标题对应的节（宽松匹配：模型常把标题微调） */
  function sectionPresent(txt, title) {
    const norm = s => String(s || '').replace(/[\s、，。：:（）()【】\[\]#*`]/g, '');
    const body = norm(txt), t = norm(title);
    if (!t || t.length < 2) return false;
    if (body.includes(t)) return true;
    const core = t.length > 8 ? t.slice(0, 8) : t;
    return core.length >= 4 && body.includes(core);
  }

  /* 补写缺失/未完成的某一节 */
  function buildFillPrompt(plan, titles, tutorialTitle, existingHead) {
    const lines = [];
    lines.push('你是耐心、严谨的技术导师。下面是一篇学习教程的大纲和**已经写好的部分**，其中有几节缺失或没写完，请把缺的补上。');
    lines.push('');
    lines.push('【主题】' + tutorialTitle);
    lines.push('');
    lines.push('【大纲】');
    plan.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + s.title + (s.viz ? '（应有可视化）' : '')));
    lines.push('');
    lines.push('【需要补写的节】' + titles.map(t => '「' + t + '」').join('、'));
    lines.push('');
    lines.push('【已写好的部分（只作风格参考，不要重复它的内容，也不要重写它）】');
    lines.push(String(existingHead || '').slice(0, 18000));
    lines.push('');
    lines.push('【要求】');
    lines.push('- 只输出要补的那几节，按大纲顺序，每节以二级标题「## 标题」开头；');
    lines.push('- 不要输出已有的内容，不要写全文总结；');
    lines.push('- 围栏代码块必须闭合，绝不停在句子中间；');
    lines.push('- 大纲标了可视化的节要配 ```viz 块，里面必须是真正的 HTML。');
    lines.push('');
    for (const L of vizSpecLines()) lines.push(L);
    return lines.join('\n');
  }

  /* 把没闭合的围栏补上收尾。
     宁可补一个收尾围栏，也不要因为"最后少个 ```"把整篇教程判废退回重写 ——
     实测线上教程里模型会把代码块跨着章节拆开（某一节以孤立的 ``` 开头），
     机械判断会误判成截断。补上收尾后文档结构是合法的，内容缺的部分
     交给 Reflection 阶段定向补写。 */
  function closeFences(txt) {
    const lines = String(txt || '').split('\n');
    let open = null, need = '';
    for (const line of lines) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/);
      if (!m) continue;
      if (!open) { open = { mark: m[1][0], len: m[1].length }; continue; }
      if (m[1][0] === open.mark && m[1].length >= open.len && !m[2]) open = null;
    }
    if (!open) return String(txt || '');
    need = open.mark.repeat(open.len);
    return String(txt || '').replace(/\s+$/, '') + '\n' + need + '\n';
  }

  /* 重试时告诉模型上一版具体哪里不对 —— 盲重试大概率再犯同一个毛病。 */
  function retryHint(why) {
    if (/没有闭合/.test(why)) return '\n\n【⚠ 上一版这一节没写完】' + why + '。请重新写这一节：'
      + '如果写了代码块或 ```viz 可视化块，**必须在最后补上收尾的 ```**；写不完就少写一段，绝不停在半个文件上。';
    if (/半句话|冒号|括号/.test(why)) return '\n\n【⚠ 上一版这一节停在半句话上】' + why
      + '。请重新写这一节：结尾要落在完整的一句话上（以 。！？ 或代码块收尾 ``` 结束），不要停在句子中间。';
    if (/几乎没有内容/.test(why)) return '\n\n【⚠ 上一版这一节几乎是空的】请把这一节**认真写完整**，不要只给一句话或一个小标题就交差。';
    return '\n\n【⚠ 上一版这一节有问题】' + why + '。请重新写这一节，写完整。';
  }

  /* 按二级标题把一篇 Markdown 切成节。补写内容要先切片，才能逐节判断"这节是不是已经有了"。 */
  function splitSections(md) {
    const lines = String(md || '').split('\n');
    const out = []; let cur = null;
    for (const l of lines) {
      if (/^##[^#]/.test(l)) {
        if (cur) out.push(cur);
        cur = { title: l.replace(/^#+\s*/, '').trim(), lines: [l] };
      } else if (cur) cur.lines.push(l);
    }
    if (cur) out.push(cur);
    return out.map(s => ({ title: s.title, text: s.lines.join('\n') }));
  }

  /* 机械复核 AI 自检的结论：它说"这节缺/没写完"未必是真的。
     真实翻过：正文里明明有《延伸学习》那一节（1 万字），自检却说缺失，
     于是补写又插了一份，整篇多出一万字重复内容，还白花了 80 秒。
     这里逐条用文本本身核对，只保留**确实有问题**的。 */
  function verifyReviewClaims(txt, plan, review) {
    const body = String(txt || '');
    const secs = splitSections(body);
    const hasViz = title => {
      const s = secs.find(x => x.title === title) || secs.find(x => x.title.includes(title) || title.includes(x.title));
      return !!s && /```\s*(?:viz|demo|htmlviz)/i.test(s.text);
    };
    const reallyMissing = [], reallyViz = [];
    for (const t of [].concat(review ? review.missing : [], review ? review.unfinished : [])) {
      if (!sectionPresent(body, t)) reallyMissing.push(t);
      else {
        /* 标题在、但可能真没写完：抽这一节自身的文本做单节体检 */
        const s = secs.find(x => x.title === t) || secs.find(x => x.title.includes(t) || t.includes(x.title));
        const why = s ? sectionTruncated(s.text) : '找不到对应章节';
        if (why && !/几乎没有内容/.test(why)) reallyMissing.push(t + '（' + why + '）');
      }
    }
    for (const t of (review ? review.vizMissing : [])) if (!hasViz(t)) reallyViz.push(t);
    /* "viz 不是 HTML" 这类判断交给 AI（机械判断容易误伤），但对已经是 HTML 的不再重复报 */
    const notHtml = (review ? review.vizNotHtml : []).filter(t => {
      const s = secs.find(x => x.title === t) || secs.find(x => x.title.includes(t) || t.includes(x.title));
      if (!s) return false;
      const m = s.text.match(/```\s*(?:viz|demo|htmlviz)\s*\n([\s\S]*?)\n```/);
      return m ? !/<[a-zA-Z][\w-]*[\s\S]*>/.test(m[1]) : false;
    });
    return {
      missing: reallyMissing,
      vizBad: reallyViz.concat(notHtml),
      fenceOpen: !!(review && review.fenceOpen) && !!unclosedIn(body)
    };
  }
  /* 全文最后一个没闭合的围栏（有才返回非空） */
  function unclosedIn(txt) {
    let open = null;
    for (const line of String(txt || '').split('\n')) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/);
      if (!m) continue;
      if (!open) { open = { mark: m[1][0], len: m[1].length }; continue; }
      if (m[1][0] === open.mark && m[1].length >= open.len && !m[2]) open = null;
    }
    return open ? '有' : '';
  }

  /* 规范一节正文的标题层级：这一节只能有一个二级标题（就是它自己的标题），
     节内再要分小结构一律降成三级。真实翻过：模型写「分步实践」时把
     `## 何时使用` `## 步骤` `## 前置条件` 也写成了二级 —— 拼起来后
     大纲从 7 节变成 13 节，还出现两个都叫「步骤」的章节。 */
  function normalizeSectionBody(body, title) {
    let s = String(body || '').trim();
    if (!s) return '## ' + title + '\n\n（本节内容缺失）';
    const lines = s.split('\n');
    const head = '## ' + title;
    /* 第一个标题行：**标题文字换成大纲里的那个** —— 模型常把它自己写的子标题
       （"## 何时使用"）放在最前面当节标题，照抄的话整篇大纲就散了。
       但它的原文也不能丢，降成三级标题留着。 */
    const first = lines.findIndex(l => /^#{1,6}\s+\S/.test(l));
    if (first < 0) {
      /* 整段没有标题（模型直接开始写正文）：标题补到最前面 */
      lines.unshift(head, '');
    } else {
      const raw = lines[first].replace(/^#+\s*/, '').trim();
      const same = raw.replace(/[\s：:、，,。]/g, '') === String(title).replace(/[\s：:、，,。]/g, '');
      /* 标题前面可能还有一段正文（模型爱先铺垫一句），它必须挪到标题下面，
         否则会漂在大纲外面 —— 渲染出来就是"没有归属的一段话"。 */
      const lead = lines.slice(0, first).filter(l => l.trim());
      lines.splice(0, first + 1, head, '');            // 用节标题替换掉原来那一行
      if (!same && raw) lines.splice(2, 0, '### ' + raw, '');   // 原第一标题降级保留
      if (lead.length) lines.splice(2 + (same || !raw ? 0 : 2), 0, lead.join('\n'), '');
      /* 其余二级标题一律降为三级 */
      for (let i = 1; i < lines.length; i++) {
        if (/^##[^#]/.test(lines[i])) lines[i] = '#' + lines[i];
      }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  return {
    PLAN_MIN, PLAN_MAX,
    buildPlanPrompt, parsePlan,
    buildSectionPrompt, sectionTruncated, closeFences, retryHint, normalizeSectionBody,
    buildReviewPrompt, parseReview, sectionPresent, splitSections, verifyReviewClaims,
    buildFillPrompt
  };
};