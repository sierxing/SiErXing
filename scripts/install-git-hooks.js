#!/usr/bin/env node
'use strict';
/**
 * 安装/卸载 git 钩子（可选）：提交前自动跑「文案规范」守卫
 * ============================================================================
 *   npm run hooks:install          # 安装 pre-commit（追加，不覆盖已有钩子）
 *   npm run hooks:install -- --uninstall
 *
 * 钩子做的事：`node --no-warnings scripts/check-i18n.js`
 * 也就是检查：源语言目录是否与代码同步 / 语言包是否完整 / 占位符是否一致 /
 * 英文是否残留中文 / 新增硬编码文案是否超预算（见 AGENTS.md §0.1 / §8）。
 *
 * 为什么是可选：钩子存在 .git/hooks/ 里，不随仓库同步；而且有人用别的
 * 提交工具/CI。但**发版前必须手动跑** `npm run check:i18n`。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MARK = '# sierxing-i18n-guard';

function gitDir() {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

function main() {
  const uninstall = process.argv.indexOf('--uninstall') >= 0;
  const dir = gitDir();
  if (!dir) {
    console.error('[hooks] 这里不是 git 仓库（或没装 git），跳过。');
    process.exit(1);
  }
  const hooks = path.resolve(ROOT, dir, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, 'pre-commit');
  const exists = fs.existsSync(file);
  const old = exists ? fs.readFileSync(file, 'utf8') : '';

  if (uninstall) {
    if (!old.includes(MARK)) {
      console.log('[hooks] 当前 pre-commit 不是本脚本装的，不改动：' + file);
      return;
    }
    fs.writeFileSync(file, old.split('\n').filter(l => l.indexOf(MARK) < 0 && l.indexOf('scripts/check-i18n.js') < 0).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');
    console.log('[hooks] 已移除文案规范钩子：' + file);
    return;
  }

  const block = [
    MARK + '：提交前检查文案规范（新增硬编码 / 语言包完整 / 占位符 / 英文残留中文）',
    '# 临时跳过：git commit --no-verify；规则见 AGENTS.md §0.1 与 language/README.md',
    'if command -v node >/dev/null 2>&1; then',
    '  node --no-warnings "$(git rev-parse --show-toplevel)/scripts/check-i18n.js" || {',
    '    echo "[pre-commit] 文案检查没通过：先 npm run build:lang 收新文案、补齐语言包，再提交。" >&2',
    '    exit 1',
    '  }',
    'fi'
  ].join('\n');

  let content;
  if (!exists) {
    content = '#!/bin/sh\nset -e\n\n' + block + '\n';
  } else if (old.indexOf(MARK) >= 0) {
    console.log('[hooks] pre-commit 里已经有文案规范检查，无需重复安装。');
    return;
  } else {
    content = old.replace(/\s*$/, '') + '\n\n' + block + '\n';
  }
  fs.writeFileSync(file, content, 'utf8');
  try { fs.chmodSync(file, 0o755); } catch (e) {}
  console.log('[hooks] 已安装 pre-commit 文案规范检查：' + file);
  console.log('        临时跳过用：git commit --no-verify');
}

main();
