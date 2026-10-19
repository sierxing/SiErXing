#!/usr/bin/env node
'use strict';
/**
 * 思而行 · 多宿主 skill 安装器 + MCP 配置生成（零依赖）
 * ------------------------------------------------------------------
 * 把 docs/agent-plugin/skills/<name>/SKILL.md 安装到不同 Agent 宿主的技能目录。
 *
 * 用法：
 *   node scripts/install-skills.js list [--json]
 *   node scripts/install-skills.js install <name|--all> --host claude
 *   node scripts/install-skills.js install <name|--all> --host cursor [--target <dir>]
 *   node scripts/install-skills.js install <name|--all> --target <dir> [--force] [--dry-run]
 *   node scripts/install-skills.js mcp-config [--json]
 *
 * 宿主：
 *   claude   ~/.claude/skills/<name>/SKILL.md（可用 --target 换根目录）
 *   cursor   .cursor/rules/<name>.mdc（带 frontmatter；可用 --target 换目录）
 *   generic  <target>/<name>/SKILL.md（必须给 --target）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'docs', 'agent-plugin', 'skills');
const MCP_SCRIPT = path.join(__dirname, 'sierxing-mcp.js');

function usage() {
  console.log([
    '思而行 · 多宿主 skill 安装器',
    '',
    '  node scripts/install-skills.js list [--json]',
    '  node scripts/install-skills.js install <name|--all> --host claude [--target <dir>] [--force] [--dry-run]',
    '  node scripts/install-skills.js install <name|--all> --host cursor [--target <dir>] [--force] [--dry-run]',
    '  node scripts/install-skills.js install <name|--all> --target <dir> [--force] [--dry-run]',
    '  node scripts/install-skills.js mcp-config [--json]',
    '',
    'host：claude（默认 ~/.claude/skills）、cursor（默认 ./.cursor/rules）、generic（必须 --target）',
    '命令：list / install / mcp-config'
  ].join('\n'));
}
function parseArgs(list) {
  const o = { _: [], json: false, force: false, dryRun: false, all: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') { o.json = true; continue; }
    if (a === '--force') { o.force = true; continue; }
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--all') { o.all = true; continue; }
    if (a === '--host' || a === '--target') { o[a.slice(2)] = list[++i]; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    o._.push(a);
  }
  return o;
}
function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory(); })
    .map(function (d) {
      const file = path.join(SKILLS_DIR, d.name, 'SKILL.md');
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      const heading = (text.match(/^#\s+(.+)$/m) || [])[1] || d.name;
      const quote = (text.match(/^>\s+(.+)$/m) || [])[1] || '';
      return { name: d.name, title: heading.replace(/^SKILL:\s*/, ''), description: quote.trim().slice(0, 180), path: file };
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}
function skillText(name) {
  const s = listSkills().find(function (x) { return x.name === name; });
  if (!s) throw new Error('没有这个 skill：' + name);
  return fs.readFileSync(s.path, 'utf8');
}
function cursorContent(name, text) {
  const s = listSkills().find(function (x) { return x.name === name; }) || {};
  const desc = String(s.description || ('思而行 Agent 技能：' + name)).replace(/\s+/g, ' ').slice(0, 200);
  return '---\ndescription: ' + JSON.stringify(desc) + '\nalwaysApply: false\n---\n\n' + text;
}
function destination(name, opts) {
  const host = opts.host || (opts.target ? 'generic' : 'claude');
  if (host === 'claude') {
    const base = opts.target ? path.resolve(opts.target) : path.join(os.homedir(), '.claude', 'skills');
    return { host: host, file: path.join(base, name, 'SKILL.md'), content: skillText(name) };
  }
  if (host === 'cursor') {
    const base = opts.target ? path.resolve(opts.target) : path.join(process.cwd(), '.cursor', 'rules');
    return { host: host, file: path.join(base, name + '.mdc'), content: cursorContent(name, skillText(name)) };
  }
  if (host === 'generic') {
    if (!opts.target) throw new Error('host=generic 必须给 --target <dir>');
    return { host: host, file: path.join(path.resolve(opts.target), name, 'SKILL.md'), content: skillText(name) };
  }
  throw new Error('未知 host：' + host + '（支持 claude / cursor / generic）');
}
function installOne(name, opts) {
  const d = destination(name, opts);
  const exists = fs.existsSync(d.file);
  if (exists && !opts.force) {
    return { name: name, file: d.file, skipped: true, reason: '已存在（--force 覆盖）' };
  }
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(d.file), { recursive: true });
    fs.writeFileSync(d.file, d.content, 'utf8');
  }
  return { name: name, file: d.file, skipped: false, dryRun: !!opts.dryRun, host: d.host };
}
function mcpConfig() {
  return {
    mcpServers: {
      sierxing: {
        command: 'node',
        args: [MCP_SCRIPT],
        env: { SIERXING_URL: 'http://127.0.0.1:3213' }
      }
    }
  };
}
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts._.length) { usage(); return; }
  const cmd = opts._[0];
  if (cmd === 'list') {
    const skills = listSkills();
    if (opts.json) { console.log(JSON.stringify({ skills: skills }, null, 2)); return; }
    console.log('可用 skill（' + skills.length + '）：');
    for (const s of skills) console.log('  ' + s.name + ' — ' + s.title + '\n    ' + s.description);
    return;
  }
  if (cmd === 'mcp-config') {
    const cfg = mcpConfig();
    if (opts.json) { console.log(JSON.stringify(cfg, null, 2)); return; }
    console.log(JSON.stringify(cfg, null, 2));
    console.log('\n把上面的 mcpServers.sierxing 放进宿主的 MCP 配置即可；路径已按当前目录解析。');
    return;
  }
  if (cmd === 'install') {
    let names;
    if (opts.all) names = listSkills().map(function (s) { return s.name; });
    else {
      const name = opts._[1];
      if (!name) throw new Error('缺少 skill 名，或加 --all');
      names = [name];
    }
    if (!names.length) throw new Error('没有可安装的 skill');
    for (const name of names) {
      const r = installOne(name, opts);
      if (r.skipped) console.log('跳过 ' + name + ' → ' + r.file + '（' + r.reason + '）');
      else if (r.dryRun) console.log('[dry-run] 将安装 ' + name + ' → ' + r.file);
      else console.log('已安装 ' + name + ' → ' + r.file);
    }
    return;
  }
  usage();
  throw new Error('未知命令：' + cmd);
}

try { main(); } catch (e) {
  process.stderr.write('错误：' + (e.message || e) + '\n');
  process.exit(1);
}
