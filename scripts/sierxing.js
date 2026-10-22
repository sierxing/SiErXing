#!/usr/bin/env node
'use strict';
/**
 * 思而行 CLI
 * ------------------------------------------------------------------
 * 读：manifest / commands / goal / node / tutorial / source / brief / audit
 * 写：goal.create / goal.update / node.create / node.update / node.complete
 * 危险操作：返回 approval_required + approveUrl，用户批准后再跑
 *
 * 用法：
 *   node scripts/sierxing.js manifest --json
 *   node scripts/sierxing.js brief goal --id 166 --json
 *   node scripts/sierxing.js commands run goal.create '{"title":"..."}' --json
 *   node scripts/sierxing.js approvals get <id> --json
 *   node scripts/sierxing.js approve <id>
 *   node scripts/sierxing.js audit list --json
 *
 * 这是主 Agent 最通用的入口：任何能执行命令的宿主都能用。
 * 默认连 http://127.0.0.1:3213；可用 SIERXING_URL 覆盖。
 */

const readline = require('node:readline/promises');
const BASE = process.env.SIERXING_URL || ('http://127.0.0.1:' + (process.env.PORT || 3213));
const argv = process.argv.slice(2);

function usage() {
  console.log([
    '思而行 CLI',
    '',
    '  manifest [--json]',
    '  commands list [--json] [--q 关键词] [--category 分类]',
    '  commands describe <name> [--json]',
    '  commands run <name> [json] [--json] [--actor 名字] [--approval <id>]',
    '  goal list [--json]',
    '  goal get --id <goalId> [--json]',
    '  node list --goal <goalId> [--json]',
    '  tutorial get --id <tutorialId> [--offset N] [--limit N] [--json]',
    '  source list --goal <goalId> [--limit N] [--json]',
    '  source get --id <sourceId> [--offset N] [--limit N] [--json]',
    '  brief user [--json]',
    '  brief goal --id <goalId> [--json]',
    '  insight list [--goal <goalId>] [--json]',
    '  approvals list [--status pending] [--json]',
    '  approvals get <approvalId> [--json]',
    '  approve <approvalId> [--json] [--yes]',
    '  reject <approvalId> [--json] [--yes]',
    '  audit list [--limit N] [--json]',
    '',
    '环境变量：SIERXING_URL（默认 http://127.0.0.1:3213）'
  ].join('\n'));
}

function parseFlags(list) {
  const flags = { json: false, yes: false, _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') { flags.json = true; continue; }
    if (a === '--yes' || a === '-y') { flags.yes = true; continue; }
    if (a === '--id' || a === '--goal' || a === '--tutorial' || a === '--offset' || a === '--limit' || a === '--actor' || a === '--q' || a === '--category' || a === '--approval' || a === '--status') {
      flags[a.slice(2)] = list[++i];
      continue;
    }
    if (a.indexOf('--') === 0) { flags[a.slice(2)] = true; continue; }
    flags._.push(a);
  }
  return flags;
}

function out(value, pretty) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) ? body.error.message : ('HTTP ' + res.status);
    const err = new Error(msg);
    err.code = (body && body.error && body.error.code) || 'http_error';
    err.status = res.status;
    err.details = (body && body.error && body.error.details) || null;
    throw err;
  }
  return body;
}

function run(name, input, actor, approvalId) {
  return api('/api/commands/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, input: input || {}, actor: actor || 'agent:cli', approvalId: approvalId || '' })
  });
}

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('当前不是交互终端；请在浏览器打开审批页，或加 --yes');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(question + ' (y/N) ');
    return /^y(es)?$/i.test(String(a || '').trim());
  } finally { rl.close(); }
}

function briefGoalText(r) {
  const g = r.goal || {};
  const p = r.progress || {};
  const lines = [
    '目标：' + (g.title || '') + '（#' + g.id + '，' + (g.status || '') + '）',
    '进度：' + (p.tasks_done || 0) + '/' + (p.tasks_total || 0) + ' 个任务；下一任务：' + (p.next_task || '无'),
    '资料：' + (p.sources || 0) + ' 条；提炼：' + (p.digests || 0) + ' 篇；教程：' + (p.tutorials || 0) + ' 篇',
    '健康度：' + (r.health || '未知') + (r.idleDays == null ? '' : '；最近活动 ' + r.idleDays + ' 天前') + '；动量：' + ((r.momentum && r.momentum.trend) || '未知')
  ];
  const first = (r.insights || [])[0];
  if (first) lines.push('洞察：' + first.interpretation);
  lines.push('打开：' + (r.uiUrl || ''));
  return lines.join('\n');
}

async function main() {
  const f = parseFlags(argv);
  const a = f._;
  if (!a.length || a[0] === 'help' || a[0] === '--help' || a[0] === '-h') { usage(); return; }

  if (a[0] === 'manifest') {
    const r = await api('/api/commands/manifest');
    if (f.json) return out(r, false);
    console.log('思而行 v' + (r.app && r.app.version) + ' · ' + (r.commands ? r.commands.length : 0) + ' 个命令');
    for (const c of (r.commands || [])) console.log('  ' + c.name + ' — ' + (c.title || '') + ' [' + c.risk + ']');
    return;
  }

  if (a[0] === 'commands') {
    if (a[1] === 'list') {
      const q = [];
      if (f.q) q.push('q=' + encodeURIComponent(f.q));
      if (f.category) q.push('category=' + encodeURIComponent(f.category));
      const r = await api('/api/commands' + (q.length ? '?' + q.join('&') : ''));
      if (f.json) return out(r, false);
      for (const c of (r.commands || [])) console.log(c.name + ' — ' + (c.title || '') + ' [' + c.risk + ']');
      return;
    }
    if (a[1] === 'describe') {
      if (!a[2]) throw new Error('缺少命令名');
      const r = await api('/api/commands/' + encodeURIComponent(a[2]));
      return out(r, !f.json);
    }
    if (a[1] === 'run') {
      if (!a[2]) throw new Error('缺少命令名');
      let input = {};
      if (a[3]) { try { input = JSON.parse(a[3]); } catch (e) { throw new Error('第三个参数必须是 JSON'); } }
      const r = await run(a[2], input, f.actor, f.approval);
      return out(r, !f.json);
    }
    throw new Error('未知 commands 子命令：' + a[1]);
  }

  if (a[0] === 'insight') {
    if (a[1] === 'list') {
      const input = {};
      if (f.goal) input.goalId = Number(f.goal);
      const r = await run('insight.list', input);
      if (f.json) return out(r, false);
      const result = r.result || {};
      if (result.insights) {
        console.log('目标 #' + result.goalId + ' · ' + result.health + ' · ' + (result.idleDays == null ? '无活动记录' : result.idleDays + ' 天未动'));
        for (const i of (result.insights || [])) console.log('  [' + i.severity + '] ' + i.interpretation);
      } else {
        console.log('目标总数：' + (result.totalGoals || 0));
        for (const i of (result.topInsights || [])) console.log('  #' + i.goalId + ' [' + i.severity + '] ' + i.interpretation);
        for (const g of (result.goals || [])) console.log('  #' + g.goalId + ' ' + g.title + ' · ' + g.health);
      }
      return;
    }
    throw new Error('未知 insight 子命令：' + a[1]);
  }

  if (a[0] === 'approvals') {
    if (a[1] === 'list') {
      const q = [];
      if (f.status) q.push('status=' + encodeURIComponent(f.status));
      if (f.limit) q.push('limit=' + encodeURIComponent(f.limit));
      const r = await api('/api/approvals' + (q.length ? '?' + q.join('&') : ''));
      return out(r, !f.json);
    }
    if (a[1] === 'get') {
      if (!a[2]) throw new Error('缺少 approvalId');
      const r = await api('/api/approvals/' + encodeURIComponent(a[2]));
      return out(r, !f.json);
    }
    throw new Error('未知 approvals 子命令：' + a[1]);
  }

  if (a[0] === 'approve' || a[0] === 'reject') {
    if (!a[1]) throw new Error('缺少 approvalId');
    const kind = a[0] === 'approve' ? 'approve' : 'reject';
    if (!f.yes) {
      const ok = await confirm('确认' + (kind === 'approve' ? '批准' : '拒绝') + ' ' + a[1] + '？');
      if (!ok) { console.log('已取消'); return; }
    }
    const r = await api('/api/approvals/' + encodeURIComponent(a[1]) + '/' + kind, { method: 'POST' });
    return out(r, !f.json);
  }

  if (a[0] === 'audit') {
    if (a[1] === 'list') {
      const q = f.limit ? '?limit=' + encodeURIComponent(f.limit) : '';
      const r = await api('/api/audit' + q);
      return out(r, !f.json);
    }
    throw new Error('未知 audit 子命令：' + a[1]);
  }

  if (a[0] === 'brief') {
    if (a[1] === 'user') {
      const r = await run('brief.user', {});
      if (f.json) return out(r, false);
      const active = (r.result && r.result.activeGoal) || null;
      console.log('目标总数：' + ((r.result && r.result.totalGoals) || 0));
      console.log('当前活跃：' + (active ? (active.title + '（#' + active.id + ' · ' + (active.health || '') + '）') : '无'));
      const top = (r.result && r.result.topInsights) || [];
      if (top.length) console.log('最值得注意：' + top[0].interpretation + '（#' + top[0].goalId + '）');
      return;
    }
    if (a[1] === 'goal') {
      if (!f.id) throw new Error('缺少 --id');
      const r = await run('brief.goal', { goalId: Number(f.id) });
      if (f.json) return out(r, false);
      console.log(briefGoalText(r.result || {}));
      return;
    }
    throw new Error('未知 brief 子命令：' + a[1]);
  }

  if (a[0] === 'goal') {
    if (a[1] === 'list') {
      const r = await run('goal.list', {});
      if (f.json) return out(r, false);
      for (const g of ((r.result && r.result.goals) || [])) console.log('#' + g.id + ' ' + g.title + ' · ' + (g.health || '') + ' · ' + (g.tasks_done || 0) + '/' + (g.tasks_total || 0));
      return;
    }
    if (a[1] === 'get') {
      if (!f.id) throw new Error('缺少 --id');
      const r = await run('goal.get', { goalId: Number(f.id) });
      return out(r, !f.json);
    }
    throw new Error('未知 goal 子命令：' + a[1]);
  }

  if (a[0] === 'node') {
    if (a[1] === 'list') {
      if (!f.goal) throw new Error('缺少 --goal');
      const r = await run('node.list', { goalId: Number(f.goal) });
      return out(r, !f.json);
    }
    throw new Error('未知 node 子命令：' + a[1]);
  }

  if (a[0] === 'tutorial') {
    if (a[1] === 'get') {
      if (!f.id) throw new Error('缺少 --id');
      const input = { tutorialId: Number(f.id) };
      if (f.offset) input.offset = Number(f.offset);
      if (f.limit) input.limit = Number(f.limit);
      const r = await run('tutorial.get', input);
      return out(r, !f.json);
    }
    throw new Error('未知 tutorial 子命令：' + a[1]);
  }

  if (a[0] === 'source') {
    if (a[1] === 'list') {
      if (!f.goal) throw new Error('缺少 --goal');
      const input = { goalId: Number(f.goal) };
      if (f.limit) input.limit = Number(f.limit);
      const r = await run('source.list', input);
      return out(r, !f.json);
    }
    if (a[1] === 'get') {
      if (!f.id) throw new Error('缺少 --id');
      const input = { id: Number(f.id) };
      if (f.offset) input.offset = Number(f.offset);
      if (f.limit) input.limit = Number(f.limit);
      const r = await run('source.get', input);
      if (f.json) return out(r, false);
      const s = r.result || {};
      console.log('#' + s.id + ' ' + (s.title || '') + ' [' + (s.kind || '') + ' · ' + (s.chars || 0) + ' 字]');
      console.log(s.content || '');
      if (s.next_offset != null) console.log('\n…（还有内容，继续读：--offset ' + s.next_offset + '）');
      return;
    }
    throw new Error('未知 source 子命令：' + a[1]);
  }

  throw new Error('未知命令：' + a[0]);
}

main().catch(function (e) {
  const err = { code: e.code || 'error', message: e.message || String(e) };
  if (e.details) {
    err.details = e.details;
    if (e.details.approveUrl) err.hint = '请在浏览器打开 approveUrl，或运行 node scripts/sierxing.js approve <approvalId>，再用 --approval 重试';
  }
  process.stderr.write(JSON.stringify({ ok: false, error: err }) + '\n');
  process.exit(1);
});
