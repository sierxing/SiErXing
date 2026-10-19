'use strict';
/**
 * 思而行 · 提示词模板加载器（服务端）
 * ============================================================================
 * 提示词的**正文**统一放在 `language/prompts/<locale>/packs.json`，这里只负责读取。
 * 约定（改代码前必读，详细说明见同目录 README.md）：
 *
 * 1. `packs.json` 是「模板 id → 模板字符串」的对象；模板里的 `{{占位符}}` 由调用方
 *    或 registry 的 renderTemplate 填。**正文只在这里改**，不要写回 server/prompts/*.js。
 * 2. `zh-CN` 是源语言：所有模板都必须先在 `zh-CN/packs.json` 里存在。
 *    其它语言目录（如 `en-US/packs.json`）只需写要覆盖的 id，缺失的 id 回退 zh-CN。
 * 3. 读取结果按语言缓存；改完 JSON 后重启进程生效（测试里可用 clearCache()）。
 *
 * 零依赖：只用 node 内置模块。
 */
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_DIR = __dirname;
const SOURCE_LOCALE = 'zh-CN';
const PACK_FILE = 'packs.json';
const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/** 语言目录名 → 规范写法；非法名字抛错，避免拼出目录外的路径 */
function normalizeLocale(locale) {
  const code = String(locale == null ? '' : locale).trim().replace(/_/g, '-');
  if (!code) return '';
  if (!LOCALE_RE.test(code)) throw new Error('非法的提示词语言代码：' + locale);
  return code;
}

function packFile(locale) {
  return path.join(PROMPT_DIR, locale, PACK_FILE);
}

const cache = new Map();

function readPack(locale) {
  if (cache.has(locale)) return cache.get(locale);
  const file = packFile(locale);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 源语言缺失是配置错误；其它语言缺失 = 没有该语言的模板，回退由 template() 处理
    if (locale === SOURCE_LOCALE) {
      throw new Error('缺少提示词模板文件：' + file + '（' + ((e && e.message) || e) + '）');
    }
    cache.set(locale, null);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('提示词模板 JSON 解析失败：' + file + '（' + ((e && e.message) || e) + '）');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('提示词模板格式错误（应为 JSON 对象）：' + file);
  }
  cache.set(locale, parsed);
  return parsed;
}

/**
 * 读取某个语言的模板表（读取并缓存 packs.json）。
 * - 不传 locale = 源语言（zh-CN）；
 * - 传了 locale 但该语言目录/文件不存在 → 返回空对象（单个 id 的回退在 template() 里做）；
 * - 源语言文件缺失或 JSON 损坏 → 抛错。
 */
function templates(locale) {
  const code = locale == null || locale === '' ? SOURCE_LOCALE : normalizeLocale(locale);
  const pack = readPack(code);
  if (pack) return pack;
  return {};
}

/**
 * 取一个模板字符串。
 * - template(id)：只从源语言（zh-CN）取；
 * - template(id, locale)：先取该语言，缺失的 id 回退 zh-CN。
 * 找不到时抛错，错误信息带 id。
 */
function template(id, locale) {
  const key = String(id == null ? '' : id).trim();
  if (!key) throw new Error('提示词模板 id 不能为空');
  const code = locale == null || locale === '' ? SOURCE_LOCALE : normalizeLocale(locale);
  const own = readPack(code);
  if (own && typeof own[key] === 'string') return own[key];
  if (code !== SOURCE_LOCALE) {
    const source = readPack(SOURCE_LOCALE);
    if (source && typeof source[key] === 'string') return source[key];
  }
  const where = code === SOURCE_LOCALE ? '' : '（语言 ' + code + '，已回退 ' + SOURCE_LOCALE + '）';
  throw new Error('未知提示词模板：' + key + where);
}

/** 列出 language/prompts/ 下的语言目录（排好序）。有 packs.json 的才真正可用。 */
function locales() {
  let entries;
  try {
    entries = fs.readdirSync(PROMPT_DIR, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter(function (d) { return d.isDirectory() && !d.name.startsWith('.'); })
    .map(function (d) { return d.name; })
    .sort();
}

/** 清掉读取缓存（改完 packs.json 想在本进程里重新读取时用；正常改文件重启即可） */
function clearCache() {
  cache.clear();
}

module.exports = {
  PROMPT_DIR,
  SOURCE_LOCALE,
  PACK_FILE,
  templates,
  template,
  locales,
  clearCache
};
