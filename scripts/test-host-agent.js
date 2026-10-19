#!/usr/bin/env node
'use strict';
/**
 * 宿主 Agent 自动接入（server/ai.js 的 hostAgent*）回归：
 * 宿主插件把 DATA_DIR/host-agent.json 或环境变量注入后，
 *   · 设置 → AI 的「服务商列表」里出现当前宿主 Agent
 *   · 连接列表里出现一条普通连接，模型进对话模型池
 *   · 重复刷新不重复添加；用户手动关掉的不被强行打开
 * 纯本地、不联网、不碰真实数据（临时目录 + 内存 settings）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = new Map();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-host-agent-'));
const ai = require('../server/ai');
ai.init({
  getSetting: (k, d) => (settings.has(k) ? settings.get(k) : d),
  setSetting: (k, v) => settings.set(k, v),
  appDir: path.resolve(__dirname, '..'),
  dataDir
});

const cfgFile = path.join(dataDir, 'host-agent.json');
const writeCfg = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj, null, 2));
const hostConns = () => ai.connections().filter(c => c.id === 'host-agent');
const hostPool = () => ai.modelPool().filter(m => m.connId === 'host-agent');
const savedEnv = {};
const ENV_KEYS = ['SIERXING_HOST_AGENT_NAME', 'SIERXING_HOST_AGENT_URL', 'SIERXING_HOST_AGENT_KEY',
  'SIERXING_HOST_MODELS', 'SIERXING_HOST_AGENT_VISION', 'SIERXING_HOST_AGENT_CONFIG'];
for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); throw e; }
}

try {
  ok('没有宿主配置：不注册、不改设置', () => {
    const r = ai.mountHostAgent();
    assert.strictEqual(r.mounted, false);
    assert.strictEqual(r.reason, 'no_host_config');
    assert.strictEqual(ai.PROVIDERS.some(p => p.id === 'host'), false);
    assert.strictEqual(hostConns().length, 0);
    const st = ai.hostAgentStatus();
    assert.strictEqual(st.available, false);
    assert.strictEqual(st.configured, false);
  });

  ok('写入 host-agent.json：自动登记连接 + 模型进模型池', () => {
    writeCfg({ name: 'DSH', url: 'http://127.0.0.1:8091/v1', models: ['deepseek-v4.1-flash-1017', 'deepseek-v4-pro'], vision: 'deepseek-v4-pro' });
    const r = ai.mountHostAgent();
    assert.strictEqual(r.mounted, true);
    assert.strictEqual(r.name, 'DSH');
    assert.deepStrictEqual(r.models, ['deepseek-v4.1-flash-1017', 'deepseek-v4-pro']);
    const prov = ai.PROVIDERS.find(p => p.id === 'host');
    assert.ok(prov, '服务商列表里应有 host 项');
    assert.strictEqual(prov.name, 'DSH');
    assert.strictEqual(prov.baseUrl, 'http://127.0.0.1:8091/v1');
    assert.strictEqual(prov.hostAuto, true);
    const cs = hostConns();
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].providerId, 'host');
    assert.strictEqual(cs[0].kind, 'api');
    assert.strictEqual(cs[0].enabled, true);
    assert.deepStrictEqual(cs[0].models, ['deepseek-v4.1-flash-1017', 'deepseek-v4-pro']);
    assert.strictEqual(cs[0].defaultModel, 'deepseek-v4.1-flash-1017');
    assert.strictEqual(cs[0].visionModel, 'deepseek-v4-pro');
    const pool = hostPool();
    assert.strictEqual(pool.length, 2);
    assert.ok(pool.some(m => m.label === 'DSH · deepseek-v4-pro'));
    const st = ai.hostAgentStatus();
    assert.strictEqual(st.available, true);
    assert.strictEqual(st.configured, true);
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.file, cfgFile);
  });

  ok('重复刷新不重复添加（同一 id 更新）', () => {
    ai.mountHostAgent();
    ai.mountHostAgent();
    assert.strictEqual(hostConns().length, 1);
    assert.strictEqual(ai.modelPool().filter(m => m.connId === 'host-agent').length, 2);
  });

  ok('宿主换模型/换地址：刷新后跟着变，不残留旧模型', () => {
    writeCfg({ name: 'DSH', url: 'http://127.0.0.1:8092/v1', models: ['new-model-1'] });
    const r = ai.mountHostAgent();
    assert.deepStrictEqual(r.models, ['new-model-1']);
    const c = hostConns()[0];
    assert.deepStrictEqual(c.models, ['new-model-1']);
    assert.strictEqual(c.baseUrl, 'http://127.0.0.1:8092/v1');
    assert.strictEqual(c.defaultModel, 'new-model-1');
  });

  ok('环境变量注入（没写配置文件也能接）', () => {
    process.env.SIERXING_HOST_AGENT_NAME = 'Claude Code';
    process.env.SIERXING_HOST_AGENT_URL = 'http://127.0.0.1:8093/v1';
    process.env.SIERXING_HOST_MODELS = 'claude-opus-4.6,claude-sonnet-4.6';
    const r = ai.mountHostAgent();
    assert.strictEqual(r.mounted, true);
    assert.strictEqual(r.name, 'Claude Code');
    assert.deepStrictEqual(r.models, ['claude-opus-4.6', 'claude-sonnet-4.6']);
    assert.strictEqual(hostConns().length, 1);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  ok('用户手动关掉宿主连接：刷新不会强行打开', () => {
    ai.saveConnections(ai.connections().map(c => c.id === 'host-agent' ? { ...c, enabled: false } : c));
    const r = ai.mountHostAgent();
    assert.strictEqual(r.mounted, true);
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(ai.hostAgentStatus().enabled, false);
    assert.strictEqual(hostPool().length, 0, '关掉的连接不应进对话模型池');
    ai.saveConnections(ai.connections().map(c => c.id === 'host-agent' ? { ...c, enabled: true } : c));
  });

  ok('配置不完整（缺 url 或 models）：视为没接', () => {
    writeCfg({ name: 'DSH', url: '', models: ['m'] });
    assert.strictEqual(ai.mountHostAgent().mounted, false);
    writeCfg({ name: 'DSH', url: 'http://127.0.0.1:8091/v1', models: [] });
    assert.strictEqual(ai.mountHostAgent().mounted, false);
  });

  ok('宿主插件卸载（配置文件被删）：撤掉自动连接与服务商', () => {
    writeCfg({ name: 'DSH', url: 'http://127.0.0.1:8091/v1', models: ['m1'] });
    assert.strictEqual(ai.mountHostAgent().mounted, true);
    assert.strictEqual(hostConns().length, 1);
    fs.unlinkSync(cfgFile);
    const r = ai.mountHostAgent();
    assert.strictEqual(r.mounted, false);
    assert.strictEqual(r.reason, 'no_host_config');
    assert.strictEqual(r.pruned, true);
    assert.strictEqual(hostConns().length, 0, '自动创建的 host-agent 连接应被撤掉');
    assert.strictEqual(ai.PROVIDERS.some(p => p.id === 'host'), false, '服务商也应撤掉');
    assert.strictEqual(ai.hostAgentStatus().configured, false);
    assert.strictEqual(ai.hostAgentStatus().available, false);
  });

  console.log('\n' + pass + ' 项全部通过');
} finally {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
}
