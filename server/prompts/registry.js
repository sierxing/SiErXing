'use strict';
/**
 * 思而行 · 提示词包注册表
 * ------------------------------------------------------------------
 * - 内置包来自 server/prompts/packs.js；
 * - 用户覆盖存本机 SQLite（prompt_packs），历史存 prompt_pack_versions；
 * - 没有覆盖时 render 走 builtinRender（行为与重构前完全一致）；
 * - 有覆盖时 render 走模板；prompt.update 必须用户批准（admin）。
 */

const packs = require('./packs');

/* 动态注册的包（如 plan.clarify / plan.skeleton）：builtinRender 可以是 async，
   默认仍走 builtinRender；有覆盖时走模板。 */
const dynamicPacks = {};
function allPacks() { return Object.assign({}, packs, dynamicPacks); }

function createPromptRegistry(ctx) {
  const db = ctx && ctx.db;
  const nowISO = (ctx && ctx.nowISO) || function () { return new Date().toISOString(); };
  if (!db) throw new Error('prompt registry: db required');

  db.exec([
    'CREATE TABLE IF NOT EXISTS prompt_packs (',
    '  id TEXT PRIMARY KEY,',
    '  version INTEGER NOT NULL DEFAULT 1,',
    '  template TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL,',
    '  updated_by TEXT NOT NULL DEFAULT \'\'',
    ');',
    'CREATE TABLE IF NOT EXISTS prompt_pack_versions (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  prompt_id TEXT NOT NULL,',
    '  version INTEGER NOT NULL,',
    '  template TEXT NOT NULL,',
    '  created_at TEXT NOT NULL,',
    '  actor TEXT NOT NULL DEFAULT \'\'',
    ');'
  ].join('\n'));

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  function getOverride(id) {
    return db.prepare('SELECT * FROM prompt_packs WHERE id = ?').get(String(id || '')) || null;
  }
  function current(id) {
    const pack = allPacks()[id];
    if (!pack) return null;
    const ov = getOverride(id);
    return {
      id: id,
      title: pack.title,
      description: pack.description,
      editable: pack.editable !== false,
      placeholders: pack.placeholders.slice(),
      mustInclude: pack.mustInclude.slice(),
      template: ov ? ov.template : pack.template,
      source: ov ? 'override' : 'builtin',
      version: ov ? Number(ov.version) : 1,
      updatedAt: ov ? ov.updated_at : '',
      updatedBy: ov ? ov.updated_by : ''
    };
  }
  function list() {
    return Object.keys(allPacks()).map(function (id) {
      const c = current(id);
      return {
        id: id, title: c.title, description: c.description, editable: c.editable,
        source: c.source, version: c.version, updatedAt: c.updatedAt,
        placeholders: c.placeholders
      };
    });
  }
  function renderTemplate(template, data) {
    let out = String(template == null ? '' : template);
    const values = data && typeof data === 'object' ? data : {};
    for (const k of Object.keys(values)) {
      out = out.split('{{' + k + '}}').join(values[k] == null ? '' : String(values[k]));
    }
    return out;
  }
  function render(id, data) {
    const pack = allPacks()[id];
    if (!pack) fail('not_found', '未知提示词包：' + id);
    const ov = getOverride(id);
    if (ov) return renderTemplate(ov.template, data);
    return pack.builtinRender(data || {});
  }
  function preview(id, data) {
    const pack = allPacks()[id];
    if (!pack) return null;
    const c = current(id);
    const use = data && typeof data === 'object' && Object.keys(data).length ? data : pack.sampleCtx;
    return { id: id, source: c.source, version: c.version, template: c.template, rendered: renderTemplate(c.template, use) };
  }
  function validate(id, template) {
    const pack = allPacks()[id];
    if (!pack) fail('not_found', '未知提示词包：' + id);
    if (pack.editable === false) fail('forbidden', '这个提示词包不可编辑：' + id);
    const s = String(template == null ? '' : template);
    if (s.length < 50) fail('bad_input', '模板太短（至少 50 字）');
    if (s.length > 20000) fail('bad_input', '模板太长（上限 20000 字）');
    for (const ph of pack.placeholders) {
      if (s.indexOf('{{' + ph + '}}') < 0) fail('bad_input', '缺少占位符 {{' + ph + '}}');
    }
    for (const need of pack.mustInclude) {
      if (s.indexOf(need) < 0) fail('bad_input', '缺少关键内容：' + need);
    }
    return true;
  }
  function update(id, template, actor) {
    const pack = allPacks()[id];
    if (!pack) fail('not_found', '未知提示词包：' + id);
    validate(id, template);
    const ov = getOverride(id);
    const baseVersion = ov ? Number(ov.version) : 1;
    const nextVersion = baseVersion + 1;
    const prevTemplate = ov ? ov.template : pack.template;
    const at = nowISO();
    db.prepare('INSERT INTO prompt_pack_versions (prompt_id, version, template, created_at, actor) VALUES (?,?,?,?,?)')
      .run(id, baseVersion, prevTemplate, at, String(actor || ''));
    if (ov) {
      db.prepare('UPDATE prompt_packs SET version = ?, template = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(nextVersion, String(template), at, String(actor || ''), id);
    } else {
      db.prepare('INSERT INTO prompt_packs (id, version, template, updated_at, updated_by) VALUES (?,?,?,?,?)')
        .run(id, nextVersion, String(template), at, String(actor || ''));
    }
    return current(id);
  }
  function reset(id, actor) {
    const pack = allPacks()[id];
    if (!pack) fail('not_found', '未知提示词包：' + id);
    const ov = getOverride(id);
    if (ov) {
      db.prepare('INSERT INTO prompt_pack_versions (prompt_id, version, template, created_at, actor) VALUES (?,?,?,?,?)')
        .run(id, Number(ov.version), ov.template, nowISO(), String(actor || ''));
      db.prepare('DELETE FROM prompt_packs WHERE id = ?').run(id);
    }
    return current(id);
  }
  function history(id) {
    return db.prepare('SELECT id, prompt_id, version, created_at, actor FROM prompt_pack_versions WHERE prompt_id = ? ORDER BY id DESC LIMIT 20').all(String(id || ''));
  }
  function register(def) {
    if (!def || !def.id) fail('bad_input', '提示词包缺少 id');
    if (allPacks()[def.id]) fail('duplicate', '提示词包已存在：' + def.id);
    if (typeof def.builtinRender !== 'function') fail('bad_input', '提示词包缺少 builtinRender：' + def.id);
    dynamicPacks[def.id] = {
      id: def.id,
      title: def.title || def.id,
      description: def.description || '',
      editable: def.editable !== false,
      placeholders: Array.isArray(def.placeholders) ? def.placeholders.slice() : [],
      mustInclude: Array.isArray(def.mustInclude) ? def.mustInclude.slice() : [],
      template: String(def.template || ''),
      sampleCtx: def.sampleCtx && typeof def.sampleCtx === 'object' ? def.sampleCtx : {},
      builtinRender: def.builtinRender
    };
    return current(def.id);
  }
  /* 供 async builtinRender 的包用：有覆盖走模板，没覆盖 await builtinRender。 */
  async function renderAsync(id, data) {
    const pack = allPacks()[id];
    if (!pack) fail('not_found', '未知提示词包：' + id);
    const ov = getOverride(id);
    if (ov) return renderTemplate(ov.template, data);
    return await pack.builtinRender(data || {});
  }
  function hasOverride(id) {
    return !!getOverride(id);
  }
  return { list: list, get: current, render: render, renderAsync: renderAsync, hasOverride: hasOverride, register: register, preview: preview, validate: validate, update: update, reset: reset, history: history, packs: function () { return allPacks(); } };
}

module.exports = createPromptRegistry;
