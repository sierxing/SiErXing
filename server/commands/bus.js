'use strict';
/**
 * 思而行 · 命令总线
 * ------------------------------------------------------------------
 * - read：直接执行
 * - write：直接执行，但必须写审计
 * - destructive / admin：必须带用户批准的 approvalId
 *
 * 审批由 commands/index.js 的 approvals 适配器落到 SQLite；
 * 总线本身不碰 DB、不 require server.js，方便单测。
 */

const crypto = require('node:crypto');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
}

function hashInput(input) {
  return crypto.createHash('sha256').update(stableStringify(input || {})).digest('hex');
}

function safeClone(v) {
  try { return JSON.parse(JSON.stringify(v == null ? {} : v)); } catch (e) { return {}; }
}

function createBus(options) {
  const opts = options || {};
  const audit = typeof opts.audit === 'function' ? opts.audit : function () {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
  const approvals = opts.approvals || null;
  const nowISO = typeof opts.nowISO === 'function' ? opts.nowISO : function () { return new Date().toISOString(); };
  const defs = new Map();
  const events = [];

  function summarize(def) {
    return {
      name: def.name,
      title: def.title || def.name,
      description: def.description || '',
      category: def.category || 'misc',
      layer: def.layer || 'feature',
      risk: def.risk || 'read',
      async: !!def.async
    };
  }

  function define(def) {
    if (!def || !/^[a-z][a-z0-9_.-]{1,60}$/i.test(String(def.name || ''))) {
      throw new Error('invalid command name: ' + (def && def.name));
    }
    if (defs.has(def.name)) throw new Error('duplicate command: ' + def.name);
    if (typeof def.handler !== 'function') throw new Error('missing handler: ' + def.name);
    defs.set(def.name, def);
    return def;
  }

  function list(filter) {
    const f = filter || {};
    let arr = Array.from(defs.values());
    if (f.category) arr = arr.filter(function (d) { return (d.category || 'misc') === f.category; });
    if (f.risk) arr = arr.filter(function (d) { return (d.risk || 'read') === f.risk; });
    if (f.query) {
      const q = String(f.query).toLowerCase();
      arr = arr.filter(function (d) {
        return (d.name + ' ' + (d.title || '') + ' ' + (d.description || '')).toLowerCase().indexOf(q) >= 0;
      });
    }
    return arr.map(summarize);
  }

  function describe(name) {
    const d = defs.get(String(name || ''));
    if (!d) return null;
    const out = summarize(d);
    out.inputSchema = d.inputSchema || { type: 'object', properties: {} };
    out.output = d.output || 'json';
    out.examples = d.examples || [];
    return out;
  }

  function needsApproval(risk) { return risk === 'destructive' || risk === 'admin'; }

  function approvalError(message, details) {
    const e = new Error(message);
    e.code = 'approval_required';
    e.details = details || {};
    return e;
  }

  async function run(name, input, runOpts) {
    const o = runOpts || {};
    const d = defs.get(String(name || ''));
    const actor = o.actor || 'agent:local';
    const inputSafe = safeClone(input);
    if (!d) {
      const e = new Error('unknown command: ' + name);
      e.code = 'not_found';
      throw e;
    }
    const risk = d.risk || 'read';
    const startedAt = Date.now();
    const at = nowISO();

    if (needsApproval(risk)) {
      const approvalId = String(o.approvalId || '').trim();
      if (!approvalId) {
        if (!approvals) throw approvalError('需要审批，但审批适配器未配置：' + d.name, { command: d.name });
        const ap = approvals.create({ command: d.name, input: inputSafe, actor: actor, risk: risk, reason: o.reason || '' });
        throw approvalError('需要用户批准：' + d.name, {
          command: d.name,
          approvalId: ap.id,
          approveUrl: ap.approveUrl,
          input: inputSafe,
          expiresAt: ap.expiresAt
        });
      }
      if (!approvals) throw approvalError('需要审批，但审批适配器未配置：' + d.name, { command: d.name });
      const ap = approvals.get(approvalId);
      if (!ap) throw approvalError('审批不存在或已过期', { approvalId: approvalId, command: d.name });
      if (ap.status === 'rejected') {
        const e = new Error('用户已拒绝这次审批');
        e.code = 'forbidden';
        e.details = { approvalId: approvalId, command: d.name };
        throw e;
      }
      if (ap.status === 'used') throw approvalError('这次审批已经用过，需要重新批准', { approvalId: approvalId, command: d.name });
      if (ap.status === 'expired') throw approvalError('审批已过期，需要重新批准', { approvalId: approvalId, command: d.name, approveUrl: ap.approveUrl });
      if (ap.status !== 'approved') {
        throw approvalError('审批还没通过（当前：' + ap.status + '）', { approvalId: approvalId, command: d.name, approveUrl: ap.approveUrl });
      }
      if (ap.command !== d.name) {
        const e = new Error('审批不匹配：批准的是 ' + ap.command + '，不是 ' + d.name);
        e.code = 'forbidden';
        e.details = { approvalId: approvalId };
        throw e;
      }
      if (ap.input_hash !== hashInput(inputSafe)) {
        const e = new Error('审批不匹配：这次入参和审批时的入参不一致');
        e.code = 'forbidden';
        e.details = { approvalId: approvalId };
        throw e;
      }
      approvals.markUsed(approvalId);
    }

    const eventBase = { command: d.name, actor: actor, risk: risk, at: at };
    function emit(type, extra) {
      try { onEvent(Object.assign({ type: type }, eventBase, extra || {})); } catch (e) {}
    }
    emit('command.started', { approvalId: o.approvalId || '' });
    events.push({ type: 'command.started', name: d.name, actor: actor, at: at, risk: risk });
    let result;
    let error = null;
    try {
      result = await d.handler(inputSafe, { actor: actor, approvalId: o.approvalId || '' });
      events.push({ type: 'command.succeeded', name: d.name, actor: actor, at: nowISO() });
      if (events.length > 500) events.splice(0, events.length - 500);
    } catch (e) {
      error = e;
      events.push({ type: 'command.failed', name: d.name, actor: actor, at: nowISO(), error: String(e && e.message || e) });
      if (events.length > 500) events.splice(0, events.length - 500);
    }
    const durationMs = Date.now() - startedAt;
    emit(error ? 'command.failed' : 'command.succeeded', { ok: !error, durationMs: durationMs, error: error ? String(error.message || error) : '' });
    try {
      audit({
        command: d.name,
        actor: actor,
        risk: risk,
        approvalId: o.approvalId || '',
        ok: !error,
        durationMs: durationMs,
        input: inputSafe,
        result: error ? null : result,
        error: error ? String(error.message || error) : '',
        at: nowISO()
      });
    } catch (e) {}
    if (error) throw error;
    return result;
  }

  function manifest(extra) {
    const out = Object.assign({}, extra || {});
    out.commands = list();
    return out;
  }

  return {
    define: define,
    list: list,
    describe: describe,
    run: run,
    manifest: manifest,
    events: function () { return events.slice(); },
    has: function (name) { return defs.has(String(name || '')); }
  };
}

module.exports = { createBus: createBus, hashInput: hashInput, stableStringify: stableStringify };
