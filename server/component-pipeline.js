'use strict';
/**
 * 思而行 · 组件包校验（纯函数）
 * ------------------------------------------------------------------
 * 安装前先把关：format / id / 体积 / 服务端入口 / JS 语法。
 * 不写文件、不查 DB、不 require server.js —— 供命令与测试共用。
 *
 * ⚠️ 校验只防手滑，不是安全沙箱：组件 JS 在应用进程内运行，
 * 能拿到的权限和宿主一样。所以安装必须用户批准，并在审批页展示代码。
 */

const crypto = require('node:crypto');

const LIMITS = {
  server: 200000,
  client: 500000,
  style: 200000,
  name: 80,
  desc: 300,
  version: 30
};

function bad(message) {
  const e = new Error(message);
  e.code = 'bad_input';
  return e;
}
function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}
function checkSyntax(code, label) {
  try {
    new Function(String(code));   // 只编译，不执行
  } catch (e) {
    throw bad(label + '语法错误：' + (e && e.message ? e.message : e));
  }
}
function hashBundle(server, client, style) {
  return crypto.createHash('sha256').update(String(server || '') + '\n' + String(client || '') + '\n' + String(style || '')).digest('hex').slice(0, 16);
}

function validateBundle(bundle, opts) {
  const builtinIds = (opts && opts.builtinIds) || [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw bad('组件包必须是 JSON 对象');
  if (bundle.format !== 'sierxing-component') throw bad('不是有效的组件文件（缺少 format 标记）');
  const id = String(bundle.id || '').trim();
  if (!/^[a-z][a-z0-9_-]{1,30}$/i.test(id)) throw bad('组件 id 不合法（只允许字母开头、字母数字与 - _，2-31 字符）');
  if (builtinIds.includes(id)) throw bad('不能覆盖内置组件 id：' + id);
  const server = String(bundle.server || '');
  if (!server.includes('module.exports')) throw bad('组件缺少服务端入口（server 里必须有 module.exports）');
  if (server.length > LIMITS.server) throw bad('服务端代码太大（上限 ' + LIMITS.server + ' 字符）');
  if (server.trim().length < 20) throw bad('服务端代码太短，不像一个组件');
  const client = bundle.client == null ? '' : String(bundle.client);
  const style = bundle.style == null ? '' : String(bundle.style);
  if (client.length > LIMITS.client) throw bad('前端代码太大（上限 ' + LIMITS.client + ' 字符）');
  if (style.length > LIMITS.style) throw bad('样式太大（上限 ' + LIMITS.style + ' 字符）');
  checkSyntax(server, '服务端代码');
  if (client.trim()) checkSyntax(client, '前端代码');
  const summary = {
    format: 'sierxing-component',
    id: id,
    name: str(bundle.name || id, LIMITS.name),
    icon: str(bundle.icon || '✨', 8),
    desc: str(bundle.desc || '', LIMITS.desc),
    version: str(bundle.version || '1.0.0', LIMITS.version),
    author: str(bundle.author || '', LIMITS.name),
    kind: bundle.kind === 'theme' ? 'theme' : 'feature',
    goalToggle: bundle.goalToggle !== false,
    defaultEnabled: !!bundle.defaultEnabled,
    sizes: { server: server.length, client: client.length, style: style.length },
    hash: hashBundle(server, client, style)
  };
  return summary;
}

module.exports = { validateBundle: validateBundle, LIMITS: LIMITS, hashBundle: hashBundle };
