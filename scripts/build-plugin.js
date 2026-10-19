'use strict';
/**
 * 把「Agent 插件形态」打包成一个可分发目录：
 *   manifest.json + mcp/sierxing-mcp.js + skills/ + mcp.json + README.md + package.json
 *
 * 只打适配层，不打整个 Web 应用；插件通过 HTTP 连到正在运行的思而行。
 *
 * 用法：
 *   node scripts/build-plugin.js
 *   node scripts/build-plugin.js --out dist/sierxing-agent-plugin --url http://127.0.0.1:3213
 *   node scripts/build-plugin.js --manifest /tmp/manifest.json --out /tmp/plugin
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_URL = process.env.SIERXING_URL || ('http://127.0.0.1:' + (process.env.PORT || 3213));

async function fetchManifest(url) {
  const base = String(url || DEFAULT_URL).replace(/\/+$/, '');
  const r = await fetch(base + '/api/manifest');
  if (!r.ok) throw new Error('读取 manifest 失败：HTTP ' + r.status + '（先启动思而行）');
  const m = await r.json();
  if (!m || m.schema !== 'sierxing.plugin/1') throw new Error('manifest schema 不对：' + (m && m.schema));
  return m;
}

function renderReadme(m, url) {
  const caps = m.capabilities || {};
  const commands = caps.commands != null ? caps.commands : (m.commands || []).length;
  const prompts = caps.promptPacks != null ? caps.promptPacks : (m.prompts || []).length;
  return [
    '# 思而行 · Agent 插件包',
    '',
    '这是思而行的 **Agent 插件形态**：MCP 适配器 + 技能 + 自描述 manifest。',
    '它通过 HTTP 连到正在运行的思而行，不包含整个 Web 应用。',
    '',
    '## 1. 先启动思而行',
    '',
    '~~~bash',
    'node server/server.js          # 或在思而行目录 npm start',
    '~~~',
    '',
    '默认地址：' + url,
    '',
    '## 2. 接入 MCP',
    '',
    '把 mcp.json 里的 mcpServers 合并进宿主的 MCP 配置（Claude / Cursor / 其它支持 MCP 的客户端）。',
    '如果插件目录换了位置，把 args[0] 改成新的绝对路径。',
    '',
    '## 3. 装技能（可选）',
    '',
    '把 skills/goal-coach 和 skills/fix-friction 复制到宿主的技能目录；',
    '具体路径见宿主文档或仓库里的 docs/agent-plugin/mcp.md。',
    '',
    '## 4. 它能做什么',
    '',
    '- 命令：' + commands + ' 个（read/write/admin/destructive 分级）',
    '- 可编辑提示词包：' + prompts + ' 个',
    '- 能力：读目标与进度、改路线图、管理资料、改目标信息、编辑提示词、自改非核心 file 插件、审批/审计',
    '- 安全：admin/destructive 必须用户在审批页确认，一次性令牌',
    '',
    '开局让 Agent 调 sierxing_manifest 或 brief_user。',
    ''
  ].join('\n');
}

function buildPlugin(opts) {
  const outDir = path.resolve((opts && opts.outDir) || path.join(APP_ROOT, 'dist', 'sierxing-agent-plugin'));
  const manifest = opts && opts.manifest;
  const url = String((opts && opts.url) || DEFAULT_URL).replace(/\/+$/, '');
  if (!manifest || manifest.schema !== 'sierxing.plugin/1') throw new Error('需要 sierxing.plugin/1 manifest');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'mcp'), { recursive: true });

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(APP_ROOT, 'scripts', 'sierxing-mcp.js'), path.join(outDir, 'mcp', 'sierxing-mcp.js'));

  const skillsSrc = path.join(APP_ROOT, 'docs', 'agent-plugin', 'skills');
  if (fs.existsSync(skillsSrc)) fs.cpSync(skillsSrc, path.join(outDir, 'skills'), { recursive: true });

  const version = (manifest.app && manifest.app.version) || '0.0.0';
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'sierxing-agent-plugin',
    version: version,
    private: true,
    description: '思而行 Agent 插件：MCP 适配器 + 技能 + manifest',
    bin: { 'sierxing-mcp': 'mcp/sierxing-mcp.js' }
  }, null, 2) + '\n');

  const mcpConfig = {
    mcpServers: {
      sierxing: {
        command: 'node',
        args: [path.join(outDir, 'mcp', 'sierxing-mcp.js')],
        env: { SIERXING_URL: url }
      }
    }
  };
  fs.writeFileSync(path.join(outDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), renderReadme(manifest, url));
  return { outDir: outDir, manifest: manifest, mcpConfig: mcpConfig };
}

if (require.main === module) {
  (async function () {
    const args = process.argv.slice(2);
    function arg(name, def) {
      const i = args.indexOf('--' + name);
      return i >= 0 && args[i + 1] ? args[i + 1] : def;
    }
    const out = arg('out', path.join(APP_ROOT, 'dist', 'sierxing-agent-plugin'));
    const url = arg('url', DEFAULT_URL);
    let manifest = null;
    const mf = arg('manifest', '');
    if (mf) manifest = JSON.parse(fs.readFileSync(path.resolve(mf), 'utf8'));
    else manifest = await fetchManifest(url);
    const r = buildPlugin({ outDir: out, manifest: manifest, url: url });
    const caps = manifest.capabilities || {};
    console.log('✓ 插件包已生成：' + r.outDir);
    console.log('  commands=' + (caps.commands != null ? caps.commands : (manifest.commands || []).length)
      + ' prompts=' + (caps.promptPacks != null ? caps.promptPacks : (manifest.prompts || []).length)
      + ' skills=' + (fs.existsSync(path.join(r.outDir, 'skills')) ? fs.readdirSync(path.join(r.outDir, 'skills')).length : 0));
    console.log('  MCP 配置：' + path.join(r.outDir, 'mcp.json'));
  })().catch(function (e) { console.error('✗ ' + (e && e.message || e)); process.exit(1); });
}

module.exports = { fetchManifest: fetchManifest, buildPlugin: buildPlugin };
