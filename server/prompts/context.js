'use strict';
/**
 * 思而行 · 提示词上下文块（纯函数）
 * ------------------------------------------------------------------
 * 这些块以前散在 server/server.js 里，被各个提示词直接调用。
 * 抽到这里后必须保持纯函数：只依赖入参，不查 DB、不读 settings、不 require server.js。
 * 依赖数据的块（digestsBlock / nodeSourcesBlock / sourcesIndexBlock / libraryBlock）
 * 暂不在这里；下一阶段改成“调用方查好数据再传进来”。
 */

function goalHeader(goal) {
  const lines = [];
  lines.push('【职业目标】' + goal.title);
  lines.push('【用户现状】' + (goal.profile || '（未填写）'));
  lines.push('【每周可投入】' + (goal.weekly_hours || '（未填写）') + '　【期望期限】' + (goal.deadline || '（未填写）'));
  if (goal.materials) lines.push('【用户提供的参考资料（优先采用）】' + goal.materials);
  return lines.join('\n');
}

/* ===== Markdown 教程的「少量内联 HTML」规范 =====
   渲染端（public/app.js 的 mdTags / mdDetails）只放行这几个标签 —— 提示词必须跟渲染能力
   对齐：**说了能写却没渲染**，用户看到的是一堆裸标签；**没说能写**，模型就自己发明
   （2026-10-15 真实反馈：教程里到处是 <span style="color:#dc2626;font-weight:700">）。
   生成、整篇改写、分节改写三处共用这一份。 */
function richMdSpecLines() {
  const lines = [];
  lines.push('');
  lines.push('【强调与折叠：可以用一点点内联 HTML（只有下面这几样会被渲染）】');
  lines.push('· 标重点（最要命的那种）用红色加粗：'
    + '`<span style="color:#dc2626;font-weight:700">空结果不设分支，模型会直接编答案</span>`；');
  lines.push('  颜色只认这三种：#dc2626（红·坑/危险）、#c9701f（黄·注意）、#16a34a（绿·正确做法），'
    + '可以再加 `font-weight:700` 或 `text-decoration:underline`。'
    + '**每节最多 3 处** —— 满屏红字等于没有重点；');
  lines.push('· 折叠答案（练习/自测的参考答案）写成：');
  lines.push('<details>');
  lines.push('<summary>参考答案</summary>');
  lines.push('');
  lines.push('（这里正常写 Markdown：文字、列表、代码块都行）');
  lines.push('');
  lines.push('</details>');
  lines.push('  即 `<details>` 与 `</details>` 各占一行，`<summary>` 写标题，三段之间不要夹别的内容；');
  lines.push('· 表格单元格里要换行用 `<br>`；行内小强调也可以用 `<mark>高亮</mark>`、`<kbd>Ctrl+S</kbd>`；');
  lines.push('· **除这几样以外，一个 HTML 标签都不要写**：div / table / a / img / style / script / ul 之类一律不要 ——'
    + ' 表格用 Markdown 语法、链接用 `[文字](网址)`，图示用下面的 ```viz 可视化块；');
  lines.push('· 正文里讲别的语言时出现的 `<tag>`、`<Object>`、`<stdin>` 这类，务必用反引号包起来'
    + '（`<stdin>`），否则会被当成真的标签。');
  return lines;
}

/* ===== Markdown 教程的「可视化块」规范 =====
   生成（buildTutorialPrompt）与修改（buildTutorialEditPrompt）共用同一份。
   两处各写一遍必然走样：曾经修改提示词只说「别弄坏已有的 viz」，既没说「可以新增」
   也没给画图规范，于是 AI 改教程时只会删不会加。 */
function vizSpecLines() {
  const lines = [];
  lines.push('');
  lines.push('【可视化块：图文结合（重要）】纯靠文字讲不清的地方，用可视化块嵌一个**能跑起来的小页面**；');
  lines.push('其余讲解仍然全部用 Markdown —— 文字讲透、该动图的地方动图，两者别互相替代。');
  lines.push('写法（三个反引号 + viz，单独一行，里面放完整的 HTML）：');
  lines.push('```viz');
  lines.push('<!DOCTYPE html><html><head><meta charset="utf-8"><style>…</style></head>');
  lines.push('<body>…<script>…<\/script></body></html>');
  lines.push('```');
  lines.push('什么时候该用：数据结构与内存布局、算法/流程的分步执行、协议交互时序、前后对比、');
  lines.push('参数变化带来的影响、坐标系/几何关系、有状态迁移的过程 —— 看图比看字快的地方。');
  lines.push('');
  lines.push('【凡是需要"看/点/动"的地方，都要做成 HTML 可视化，而不是用文字描述】');
  lines.push('判断口径：**这件事如果只能读，不能点、不能换参数、不能一步步看下去，就算讲得再细也不合格。**');
  lines.push('以下情形必须做成可视化块，不许只写一段话概括：');
  lines.push('· 流程 / 调用链 / 状态机 / 决策分支（如"什么条件走哪条路"）→ 画成节点和箭头，');
  lines.push('  分支条件标在箭头上；关键路径可高亮，点节点看它做什么；');
  lines.push('· 时序与交互（谁调谁、先先后后、传什么）→ 画成泳道时序或步骤时间轴；');
  lines.push('· 算法执行过程 → 给「下一步 / 上一步 / 重置 / 换一组数据」按钮，让人自己跑一遍看每步状态；');
  lines.push('· 数据结构 / 内存布局 / 索引结构 → 画出真实结构和指针/下标关系，节点可点开看字段含义；');
  lines.push('· 并发、异步、事件循环、连接池这类"时间上怎么交错"的 → 画时间轴或甘特式条带，能暂停/单步；');
  lines.push('· 同一对象的多个状态 / 多方案对比 → 给切换按钮或滑块，让参数变化的后果看得见；');
  lines.push('· 配置项、命令行参数、环境变量的作用范围 → 做成能填能点的对照面板。');
  lines.push('');
  lines.push('【禁止用字符画代替图示】绝对不要用 -> v ^ | ─ │ ┌ ┐ └ ┘ ▼ 这类符号在 ```viz 里画流程图，');
  lines.push('也不要画 ASCII 表格当布局。这类字符画在网页里会被字体和缩进弄乱、箭头对不齐，');
  lines.push('用户根本读不出流程 —— 这是不合格输出。图示一律用 HTML 元素 + CSS 画：');
  lines.push('· 流程图：div 盒子（圆角、边框、背景色做区分）+ CSS 箭头或 SVG <line>/<path> + <marker> 画箭头；');
  lines.push('· 真实连线优先用内联 <svg>（viewBox + preserveAspectRatio），缩放不糊、箭头方向可控；');
  lines.push('· 布局用 flex/grid 定位，别靠空格和换行对齐。');
  lines.push('');
  lines.push('要求：');
  lines.push('· 每个块必须**自包含**：样式和脚本全写在块里，禁止引用任何外部 CSS/JS/图片/字体');
  lines.push('· **块里第一行必须是 <!DOCTYPE html>**；如果你打算在 ```viz 里写的东西不是 HTML，那就写错了 ——');
  lines.push('  改成真正的 HTML 页面，或者退回普通 Markdown 文字，不要写字符画');
  lines.push('· 要能交互就加按钮（如「下一步」「重置」「切换参数」「播放」），让用户自己动手看变化');
  lines.push('· 块的高度会按内容自动适配，不用自己算高度；宽度按容器宽（可用 width:100%）');
  lines.push('· 沙箱限制（同 HTML 教程的约法三章）：只许操作本块 DOM；禁止 fetch/XHR、localStorage、');
  lines.push('  Cookie、跳转、弹窗、外部请求。违反即不合格');
  lines.push('· 节制使用：只在确实"一图胜千言"处放；不要为了炫技堆可视化，也不要给纯概念硬造动画');
  lines.push('· 视觉上做干净：留白、对齐、配色克制，别用满屏艳色；深浅色都要能看清');
  return lines;
}

function digestsBlockFrom(list) {
  if (!list || !list.length) return '';
  const lines = ['', '【资料提炼汇总（已通读用户全部资料后整理，规划必须以此为主要依据，优先级高于下面的原始资料）】'];
  for (const d of list) {
    lines.push('');
    lines.push('### ' + (d.title || d.topic));
    lines.push(String(d.content || '').slice(0, 4000));
  }
  return lines.join('\n');
}

function nodeSourcesBlockFrom(items, maxLen) {
  if (!items || !items.length) return '';
  const lines = ['', '【本节点对应的资料（只依据这些做本节点的规划/拆分/教程，不要去读其它节点的资料）】'];
  for (const it of items.slice(0, 12)) {
    const body = String(it.body || '').replace(/\s+/g, ' ').slice(0, maxLen || 900);
    lines.push('- ' + it.label + (body ? '：' + body : ''));
  }
  return lines.join('\n');
}

function sourcesIndexBlockFrom(all, maxTitles, scopeNote, charBudget) {
  if (!all || !all.length) return '';
  const budget = charBudget || 14000;
  const isOwn = x => /用户提供|导入的资料|导入的代码库|待找书单/.test(String(x.site || ''));
  const own = all.filter(isOwn), net = all.filter(x => !isOwn(x));
  const head = scopeNote || ('【资料库索引（共 ' + all.length + ' 条：自己提供 ' + own.length
    + ' / 网络检索 ' + net.length + '）—— 下面是全部条目的标题，规划时请从中挑与该节点最相关的多条作为依据，不要只挑 1 条】');
  const lines = ['', head];
  let used = head.length;
  const push = (x, tag) => {
    const line = '- ' + (Number(x.quality) === 1 ? '★' : '') + tag + '[' + x.site + '｜' + x.kind + '] ' + x.title;
    if (used + line.length > budget) return false;
    lines.push(line); used += line.length; return true;
  };
  let n = 0;
  const cap = maxTitles || 400;
  for (const x of own) { if (n++ >= cap || !push(x, '【自己提供】')) break; }
  if (own.length) { lines.push(''); used += 1; }
  const byKind = {};
  for (const x of net) (byKind[x.kind || '其它'] = byKind[x.kind || '其它'] || []).push(x);
  for (const k of Object.keys(byKind).sort((a, b) => byKind[b].length - byKind[a].length)) {
    if (used > budget) break;
    lines.push('▸ ' + k + '（' + byKind[k].length + '）'); used += k.length + 8;
    for (const x of byKind[k]) { if (n++ >= cap || !push(x, '')) break; }
  }
  if (used > budget) lines.push('…（索引已按体积截断；需要更多时用检索结果）');
  return lines.join('\n');
}

function siblingScopeBlockFrom(sibs) {
  const lines = [];
  lines.push('');
  lines.push('【本节范围（必须遵守，否则视为不合格）】');
  lines.push('1. 只写与上面【教程主题】直接相关的知识点；其它章节的内容一律不写、不展开、不举例——即使下面的背景资料里提到，也不行。');
  lines.push('2. 可以一句话点名前置知识（如“需要先懂变量”），但不展开讲解。');
  lines.push('3. 例外：只有【用户的额外要求】明确点名要加别的内容时，才允许超出本节范围。');
  if (sibs.length) {
    lines.push('4. 别的章节排除清单（出现以下任一主题的成段讲解即不合格）：' + sibs.map(t => '「' + t + '」').join('、'));
  }
  return lines.join('\n');
}

function sourcesBlockFrom(all, maxItems, maxLen, clean) {
  if (!all || !all.length) return '\n【注意】本次没有检索到网络信息源，请仅依据公开公认的岗位要求与学习路径规划，并在 sources 中注明依据，不确定处标注「待核实」。';
  clean = clean || (s => String(s || ''));
  // 用户自己提供的图片资料（JD / 大纲 / 笔记…）是最高优先级的一手信息
  const starred = all.filter(s => Number(s.quality) === 1);
  const own = all.filter(s => Number(s.quality) !== 1 && (s.site === '用户提供的图片' || s.site === '导入的资料'));
  const net = all.filter(s => Number(s.quality) !== 1 && !(s.site === '用户提供的图片' || s.site === '导入的资料'));
  const fmt = (s, len) => {
    const full = clean(s.content || s.snippet || '');
    const body = full.replace(/\n+/g, ' ').slice(0, len);
    return `- [${s.site}｜${s.kind}] ${s.title}${body ? '：' + body + (full.length > len ? '…' : '') : ''}`;
  };
  const lines = [''];
    lines.push(`（说明：本目标共收集 ${all.length} 条资料——其中优质信息源 ${starred.length} 条、用户自己提供 ${own.length} 条、网络检索 ${net.length} 条；下面是与你目标最相关的部分，其余资料的结论已由「提炼汇总」概括。）`);
  if (starred.length) {
    lines.push('【★优质信息源（用户亲自标注，最高优先级——规划必须重点依据）】');
    lines.push('要求：① 这些是用户认可的高质量参考，知识体系 / 技术栈 / 学习顺序要优先对齐它们；');
    lines.push('   ② 在 sources 中引用时写明「优质信息源：<标题>」；③ 与其它资料冲突时以优质信息源为准。');
    for (const s of starred.slice(0, 20)) lines.push('★ ' + fmt(s, Math.max(maxLen, 700)).replace(/^- /, ''));
  }
  if (own.length) {
    lines.push('【用户自己提供的资料（★最高优先级：用户真实场景的一手信息，必须严格依据）】');
    lines.push('要求：① 其中的硬性条件（学历 / 到岗天数 / 技能要求 / 时间节点 / 知识范围等）必须原样满足，不得忽略或改写；');
    lines.push('② 规划要与这些资料高度对齐：按真实 JD 的要求与优先级安排重点，按大纲/笔记的章节顺序组织学习路径；');
    lines.push('③ 若下面的网络信息源与用户资料冲突，一律以用户资料为准，并可在说明中指出差异；');
    lines.push('④ 在 sources 中标注这些资料时写明「用户提供的资料」；');
    lines.push('⑤ 用户有多份同类资料（如多份 JD）时，请横向归纳「共同要求」（出现频次高的技能/条件优先安排），再兼顾各自特殊点。');
    // 用户资料给足篇幅：每条最多 450 字（关键字段已在正文最前面），最多 24 条
    for (const s of own.slice(0, 30)) lines.push(fmt(s, Math.max(maxLen, 600)));
  }
  if (net.length) {
    lines.push('');
    lines.push(own.length
      ? '【网络检索到的信息源（参考用，优先级低于上面的用户资料）】'
      : '【已检索到的优质信息源（必须优先依据这些真实资料，并在 sources 中标注来源）】');
    for (const s of net.slice(0, Math.max(10, maxItems - own.length))) lines.push(fmt(s, maxLen));
  }
  return lines.join('\n');
}

function qaRender(questions, answers, label) {
  const lines = [];
  let any = false;
  for (const q of (questions || [])) {
    const a = (answers || {})[q.id];
    if (a == null || (Array.isArray(a) && !a.length) || String(a).trim() === '') continue;
    any = true;
    const typeName = q.type === 'text' ? '简答' : q.type === 'multi' ? '多选' : q.type === 'quiz' ? '自测' : '单选';
    const pad = '　'.repeat(Math.min(Number(q.depth || 0), 3));
    if (q.note) lines.push(`${pad}【用户补充信息】${q.note}`);
    if (q.type === 'quiz') {
      const picked = (a && typeof a === 'object') ? a.picked : a;
      const ok = (a && typeof a === 'object') ? a.correct : null;
      const opt = (q.options || []).find(o => String(o.v) === String(picked));
      lines.push(`${pad}Q（${typeName}${q.depth ? '·追问' : ''}）：${q.title}`);
      lines.push(`${pad}A：选「${opt ? opt.label : picked}」${ok === true ? '（答对，该知识点已掌握）' : ok === false ? '（答错，规划需补齐该基础）' : ''}`);
    } else {
      const text = Array.isArray(a) ? a.join('、') : String(a);
      lines.push(`${pad}Q（${typeName}${q.depth ? '·追问' : ''}）：${q.title}`);
      lines.push(`${pad}A：${text}`);
    }
  }
  return { any, lines };
}

function constraintsBlockFrom(list) {
  if (!list || !list.length) return '';
  const lines = ['', '【用户设置的硬性约束（最高优先级，必须严格遵守；与常规做法冲突时以约束为准）】'];
  list.forEach((c, i) => lines.push(`${i + 1}. ${String(c.text).trim()}`));
  lines.push('规划、任务拆分与建议都必须满足以上约束；若某条约束导致取舍，请在说明中写清你是如何满足它的。');
  return lines.join('\n');
}

function goalQaBlockFrom(rounds) {
  rounds = Array.isArray(rounds) ? rounds : [];
  const lines = ['', '【与用户的澄清问答（必须严格遵守，视为用户明确的约束与偏好）】'];
  let any = false;
  for (const r of (Array.isArray(rounds) ? rounds : [])) {
    const rl = qaRender(r.questions, r.answers, r.stage);
    if (rl.any) { any = true; lines.push(`— 第 ${(r.round != null ? r.round : 0) + 1} 轮确认 —`); lines.push(...rl.lines); }
  }
  if (!any) return '';
  lines.push('规划必须严格贴合以上回答（时间安排、基础水平、偏好与限制）；不要重复询问已确认的内容。');
  return lines.join('\n');
}

module.exports = { goalHeader, richMdSpecLines, vizSpecLines, digestsBlockFrom, nodeSourcesBlockFrom, sourcesIndexBlockFrom, siblingScopeBlockFrom, sourcesBlockFrom, qaRender, constraintsBlockFrom, goalQaBlockFrom };