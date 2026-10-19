'use strict';
/**
 * 多宿主 skill 安装器回归：node scripts/test-skills-install.js
 * 只写临时目录，不碰真实宿主配置。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install-skills.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sierxing-skills-'));
let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? ' -> ' + extra : '')); console.log('  ✓ ' + name); n++; }
function run(args) {
  return execFileSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
}
try {
  const list = JSON.parse(run(['list', '--json']));
  const names = (list.skills || []).map(function (s) { return s.name; });
  ok('list --json 返回两个 skill', names.indexOf('goal-coach') >= 0 && names.indexOf('fix-friction') >= 0, names.join(','));

  const generic = path.join(tmp, 'generic');
  const out1 = run(['install', '--all', '--target', generic, '--force']);
  ok('generic 安装全部成功', fs.existsSync(path.join(generic, 'goal-coach', 'SKILL.md')) && fs.existsSync(path.join(generic, 'fix-friction', 'SKILL.md')));
  const goalText = fs.readFileSync(path.join(generic, 'goal-coach', 'SKILL.md'), 'utf8');
  ok('安装内容就是 SKILL.md 原文', goalText.indexOf('# SKILL:') >= 0 && goalText.indexOf('思而行') >= 0);

  const cursor = path.join(tmp, 'cursor');
  run(['install', 'goal-coach', '--host', 'cursor', '--target', cursor, '--force']);
  const mdc = path.join(cursor, 'goal-coach.mdc');
  ok('cursor 安装为 .mdc 且带 frontmatter', fs.existsSync(mdc) && fs.readFileSync(mdc, 'utf8').indexOf('alwaysApply: false') >= 0);

  const dry = path.join(tmp, 'dry');
  const out2 = run(['install', '--all', '--target', dry, '--dry-run']);
  ok('--dry-run 不写文件', out2.indexOf('[dry-run]') >= 0 && !fs.existsSync(dry));

  const out3 = run(['install', '--all', '--target', generic]);
  ok('重复安装默认跳过', out3.indexOf('跳过') >= 0);

  const cfg = JSON.parse(run(['mcp-config', '--json']));
  const srv = cfg.mcpServers && cfg.mcpServers.sierxing;
  ok('mcp-config 指向 sierxing-mcp.js', !!(srv && srv.args && /sierxing-mcp\.js$/.test(srv.args[0])) && srv.command === 'node');

  console.log('\n7 项全部通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
