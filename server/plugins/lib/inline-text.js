'use strict';
/**
 * 「要点 / 差距」这类短文本的行内清洗（纯函数，零依赖）
 * ------------------------------------------------------------------
 * 背景（用户真实反馈）：用自己的话的收尾页「和关键要点的差距」，AI 把标识符包成
 *   ```js\ninterview.js\n```  或  `interview.js`
 * 以前直接 esc() 后塞进 <b>/<span>，页面上把反引号和换行原样显示出来
 * （用户看到「`\ninterview.js\n` 后端插件作为执行入口」）。
 *
 * 这里只做**纯文本归一**：
 *   ① 三反引号/波浪线围栏 → 取里面的内容，压成一行；
 *   ② 不成对的围栏标记 → 删掉（模型经常只写一半）；
 *   ③ 换行/制表符 → 空格，连续空格压成一个；
 *   ④ 只剩标点（「，」「，。」这种）→ 当空，别把它当一条差距摆出来；
 *   ⑤ 成对的单反引号**保留**——前端会把它渲染成 <code>（见 public/plugins/restate.js
 *      的 inlineCode；Vue 版在 ui/pages/restate/App.vue 的 fmtInline，两边语义保持一致）。
 *
 * 为什么放服务端：库里已经存着的旧记录不重跑 AI，刷新就干净（roundOut 统一清洗）。
 */
function cleanInline(v, max) {
  let t = String(v == null ? '' : v)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u0000/g, '');
  /* ①② 围栏 → 内容（允许语言标记、前后空白、不闭合的半个围栏） */
  t = t.replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*[ \t]*\r?\n?([\s\S]*?)(?:`{3,}|~{3,})/g, function (m, body) {
    return String(body || '');
  });
  t = t.replace(/(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+#.\-]*/g, '');
  t = t.replace(/`{3,}/g, '');
  /* ③ 压成一行 */
  t = t.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  /* 落单的反引号（数量为奇数时最后一个）不成对，删掉，别留一个 ` 在界面上 */
  if ((t.match(/`/g) || []).length % 2 === 1) t = t.replace(/`([^`]*)$/, '$1');
  /* ④ 只剩标点 / 空白 */
  if (!t.replace(/[，,。.；;：:、！!?？—\-·…"'“”‘’()（）[\]【】<>《》\s]/g, '')) t = '';
  return max ? t.slice(0, max) : t;
}

module.exports = { cleanInline: cleanInline };