'use strict';
/**
 * 思而行 · 源码只读访问（给教程生成用的代码上下文）
 * ------------------------------------------------------------------
 * 权限模型（默认拒绝、显式允许）：
 *  1. 根范围：只读调用方传入的 root 目录（教程场景固定为项目根 APP_DIR），
 *     所有路径经 realpath 解析后必须落在 root 内，软链逃逸直接拒绝。
 *  2. 硬黑名单（防泄漏）：node_modules / .git / data / .opencode / dist /
 *     build / coverage 目录整体不可见；.env*（除 .env.example）、*.log、
 *     *.db/*.sqlite*、密钥文件名一律不可见、不可读。
 *  3. 只读文本：扩展名白名单 + 无 NUL 字节 + UTF-8 严格解码，失败即跳过。
 *  4. 量封顶：单文件 24KB、一次最多 60KB，避免提示词爆炸。
 *  5. 内容脱敏：高置信度密钥模式在入库提示词前掩码（见 redactSecrets）。
 * 注意：本模块只读不写；AI 在本应用内没有写文件通道。
 */
const fs = require('node:fs');
const path = require('node:path');

const DENY_DIRS = new Set(['node_modules', '.git', 'data', '.opencode', 'dist', 'build', 'coverage', '.idea', '.vscode']);
const ALLOW_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.css', '.html', '.md', '.json', '.py', '.txt', '.sh', '.yml', '.yaml', '.toml', '.ini', '.xml', '.vue', '.sql']);
const MAX_FILE_BYTES = 400 * 1024;   // 列表展示上限：超大文件不列
const MAX_LIST = 3000;
const PER_FILE_CHARS = 24000;
const TOTAL_CHARS = 60000;

function denyFile(base) {
  const b = String(base || '');
  if (b === '.env' || (b.startsWith('.env.') && b !== '.env.example')) return true;
  if (/\.log$/i.test(b)) return true;
  if (/\.(db|sqlite|sqlite3|db-wal|db-shm)$/i.test(b)) return true;
  if (/^(id_rsa|id_ed25519|.*\.pem|.*\.key|secrets?\.json|credentials\.json)$/i.test(b)) return true;
  if (/lock$/i.test(b) && /package-lock|yarn\.lock|pnpm-lock/i.test(b)) return true;
  return false;
}

/* 列出 root 下可读的代码文件（相对路径 + 大小），隐藏一切黑名单内容 */
function listCodeFiles(root) {
  const out = [];
  const walk = dir => {
    if (out.length >= MAX_LIST) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const e of ents) {
      if (out.length >= MAX_LIST) return;
      const name = String(e.name);
      if (name.startsWith('.') && name !== '.env.example') {
        // 隐藏 dotfile/dotdir（.git 等），但保留白名单内的可见性由扩展名决定
        if (e.isDirectory()) continue;
      }
      const p = path.join(dir, name);
      let st = null;
      try {
        if (e.isSymbolicLink()) continue;   // 软链一律不跟（防逃逸）
        st = fs.statSync(p);
      } catch (err) { continue; }
      if (st.isDirectory()) {
        if (DENY_DIRS.has(name)) continue;
        walk(p);
      } else if (st.isFile()) {
        if (denyFile(name)) continue;
        if (!ALLOW_EXT.has(path.extname(name).toLowerCase())) continue;
        if (st.size <= 0 || st.size > MAX_FILE_BYTES) continue;
        out.push({ path: path.relative(root, p).split(path.sep).join('/'), size: st.size });
      }
    }
  };
  const abs = path.resolve(root);
  walk(abs);
  return out;
}

/* 高置信度密钥掩码（漏网的低置信度模式宁可不误杀，只处理几乎不可能是正常代码的） */
const SECRET_RES = [
  /sk-[A-Za-z0-9\-_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  /xox[bpas]-[A-Za-z0-9\-_]+/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
];
const SECRET_KV_RE = /((?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd)\s*[:=]\s*['"]?)([^'"\s,}]{8,})(['"]?)/gi;
function redactSecrets(text) {
  let t = String(text || '');
  let n = 0;
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    t = t.replace(re, m => { n++; return '[已脱敏 ' + m.length + ' 字符]'; });
  }
  t = t.replace(SECRET_KV_RE, (m, k, v, q) => { n++; return k + '[已脱敏]' + (q || ''); });
  return { text: t, redacted: n };
}

/* 读取指定的相对路径（全部校验），返回 [{path, text, truncated}] */
function readCodeFiles(root, relPaths, opts) {
  const abs = path.resolve(root);
  const perFile = (opts && opts.perFile) || PER_FILE_CHARS;
  const total = (opts && opts.total) || TOTAL_CHARS;
  const out = [];
  let used = 0;
  const list = Array.isArray(relPaths) ? relPaths.slice(0, 24) : [];
  for (const rel of list) {
    if (used >= total) break;
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim().slice(0, 160);
    if (!clean || clean.includes('..')) continue;
    const base = clean.split('/').pop();
    if (denyFile(base)) continue;
    if (!ALLOW_EXT.has(path.extname(base).toLowerCase())) continue;
    let real = '';
    try {
      real = fs.realpathSync(path.join(abs, clean));
    } catch (e) { continue; }
    if (real !== abs && !real.startsWith(abs + path.sep)) continue;   // 逃逸拒绝
    let st = null;
    try { st = fs.statSync(real); } catch (e) { continue; }
    if (!st.isFile() || st.size <= 0 || st.size > MAX_FILE_BYTES) continue;
    let buf = null;
    try { buf = fs.readFileSync(real); } catch (e) { continue; }
    if (buf.includes(0)) continue;   // 二进制
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { continue; }
    const r = redactSecrets(text);
    let truncated = false;
    let t = r.text;
    const room = Math.min(perFile, total - used);
    if (t.length > room) { t = t.slice(0, Math.max(0, room)); truncated = true; }
    if (!t) continue;
    used += t.length;
    out.push({ path: clean, text: t, truncated, secrets: r.redacted });
  }
  return out;
}

function langOf(filename) {
  const e = path.extname(String(filename || '')).toLowerCase();
  return { '.js': 'javascript', '.ts': 'typescript', '.jsx': 'jsx', '.tsx': 'tsx', '.py': 'python', '.css': 'css', '.html': 'html', '.json': 'json', '.md': 'markdown', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql', '.xml': 'xml', '.vue': 'vue' }[e] || '';
}

/* 拼进提示词的代码块：只读讲解依据，要求模型不要复述无关代码、不准外传 */
function buildCodeBlock(files) {
  if (!files || !files.length) return '';
  const L = [];
  L.push('【项目源码参考（只读讲解依据）】');
  L.push('下面是用户勾选的项目源文件（已脱敏：密钥类内容已掩码）。写教程时：');
  L.push('1. 结合这些真实代码讲（类/函数名、调用链、关键逻辑要对得上，不要编造不存在的接口）；');
  L.push('2. 只讲与本节相关的部分，无关文件/代码不要复述，更不要整段贴出；');
  L.push('3. 引用代码时注明文件路径，方便用户对照自己的项目看。');
  for (const f of files) {
    L.push('');
    L.push(`--- 文件：${f.path}${f.truncated ? '（超长已截断，只给了前面的部分）' : ''} ---`);
    L.push('```' + langOf(f.path));
    L.push(f.text);
    L.push('```');
  }
  return L.join('\n');
}

module.exports = { listCodeFiles, readCodeFiles, redactSecrets, buildCodeBlock, DENY_DIRS, ALLOW_EXT, PER_FILE_CHARS, TOTAL_CHARS };
