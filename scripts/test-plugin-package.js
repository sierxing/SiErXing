'use strict';
/**
 * Agent 插件包构建回归：node --no-warnings scripts/test-plugin-package.js
 * 临时目录，不碰真实数据。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildPlugin } = require('../scripts/build-plugin.js');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-plugin-test-'));
const manifest = {
  schema: 'sierxing.plugin/1',
  id: 'sierxing',
  app: { name: 'SiErXing', version: '9.9.9' },
  capabilities: { commands: 2, promptPacks: 1 },
  commands: [{ name: 'goal.list', risk: 'read' }, { name: 'goal.update', risk: 'write' }],
  prompts: [{ id: 'plan.skeleton', editable: true }],
  surfaces: [{ id: 'app' }, { id: 'mcp' }]
};
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

const r = buildPlugin({ outDir: out, manifest: manifest, url: 'http://127.0.0.1:3999' });
ok('生成目录与 manifest.json', fs.existsSync(path.join(out, 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).schema === 'sierxing.plugin/1');

const mcpFile = path.join(out, 'mcp', 'sierxing-mcp.js');
ok('MCP 适配器已复制且可运行语法', fs.existsSync(mcpFile) && execFileSync(process.execPath, ['--check', mcpFile]).length === 0 && fs.readFileSync(mcpFile, 'utf8').indexOf('SIERXING_URL') >= 0);

ok('两个技能都已复制', fs.existsSync(path.join(out, 'skills', 'goal-coach', 'SKILL.md')) && fs.existsSync(path.join(out, 'skills', 'fix-friction', 'SKILL.md')));

const mcpCfg = JSON.parse(fs.readFileSync(path.join(out, 'mcp.json'), 'utf8'));
const srv = mcpCfg.mcpServers && mcpCfg.mcpServers.sierxing;
ok('mcp.json 指向真实适配器并带 URL', !!srv && srv.args[0] === mcpFile && srv.env.SIERXING_URL === 'http://127.0.0.1:3999');

const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
ok('README 含能力数量与使用说明', readme.indexOf('Agent 插件包') >= 0 && readme.indexOf('2 个') >= 0 && readme.indexOf('mcpServers') >= 0);

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
ok('package.json 版本跟随 manifest', pkg.version === '9.9.9' && pkg.bin['sierxing-mcp'] === 'mcp/sierxing-mcp.js');

let bad = null;
try { buildPlugin({ outDir: out, manifest: { schema: 'wrong' }, url: 'http://x' }); } catch (e) { bad = e; }
ok('错误 schema 被拒绝', !!bad && bad.message.indexOf('sierxing.plugin/1') >= 0);

fs.rmSync(out, { recursive: true, force: true });
console.log('\n7 项全部通过');
