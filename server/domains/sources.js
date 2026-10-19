'use strict';
/**
 * 思而行 · 资料/提炼领域（从 server.js 抽出）
 * ------------------------------------------------------------------
 * 只负责：资料列表、提炼汇总列表、提炼分批、资源库 Markdown 导出。
 * 依赖注入：db / cleanText / nowISO。不 require server.js，不碰 HTTP/AI。
 */
function createSourceDomain(opts) {
  const db = opts.db;
  const cleanText = opts.cleanText;
  const nowISO = opts.nowISO;

  function digestsOf(goalId) {
    return db.prepare('SELECT * FROM source_digests WHERE goal_id = ? ORDER BY id').all(goalId);
  }

  function sourcesOf(goalId) {
    // 用户自己提供的资料（图片 / 电子书…）排在最前，其次才是检索到的网络信息源
    return db.prepare("SELECT * FROM sources WHERE goal_id = ? ORDER BY quality DESC, CASE WHEN site = '用户提供的图片' OR site = '用户提供的电子书' OR site = '待找书单' OR kind = 'JD' THEN 0 ELSE 1 END, id").all(goalId);
  }

  function digestBatches(goal) {
    const all = sourcesOf(goal.id);
    const own = all.filter(function (x) { return x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'; });
    const net = all.filter(function (x) { return !(x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'); });
    const ownCap = 6000, netCap = 3000;
    const starred = all.filter(function (x) { return Number(x.quality) === 1; });
    const items = starred.map(function (x) {
      const full = cleanText(x.content || x.snippet || '');
      return { label: '[★优质信息源｜' + x.kind + '] ' + x.title, body: full.slice(0, 8000) + (full.length > 8000 ? '\n（本条共 ' + full.length + ' 字，此处截取前 8000 字）' : '') };
    }).concat(own.map(function (x) {
      const full = cleanText(x.content || x.snippet || '');
      return { label: '[用户资料｜' + x.kind + '] ' + x.title, body: full.slice(0, ownCap) + (full.length > ownCap ? '\n（本条共 ' + full.length + ' 字，此处截取前 ' + ownCap + ' 字）' : '') };
    })).concat(net.map(function (x) {
      const full = cleanText(x.content || x.snippet || '');
      return { label: '[' + x.site + '｜' + x.kind + '] ' + x.title, body: full.slice(0, netCap) + (full.length > netCap ? '\n（本条共 ' + full.length + ' 字，此处截取前 ' + netCap + ' 字）' : '') };
    }));
    const batches = [];
    let cur = [], curLen = 0;
    const LIMIT = 16000;
    for (const it of items) {
      const len = it.label.length + it.body.length + 8;
      if (cur.length && curLen + len > LIMIT) { batches.push(cur); cur = []; curLen = 0; }
      cur.push(it); curLen += len;
    }
    if (cur.length) batches.push(cur);
    return { batches: batches, ownCount: own.length, netCount: net.length, total: items.length };
  }

  function buildLibraryMarkdown(goal) {
    const digests = digestsOf(goal.id);
    const all = sourcesOf(goal.id);
    const own = all.filter(function (x) { return x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'; });
    const net = all.filter(function (x) { return !(x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '待找书单' || x.site === '导入的资料'); });
    const L = [];
    L.push('# 资源库：' + goal.title);
    L.push('');
    L.push('> 导出时间：' + nowISO() + '　·　资料 ' + all.length + ' 条（自己提供 ' + own.length + ' / 网络检索 ' + net.length + '）　·　提炼汇总 ' + digests.length + ' 篇');
    L.push('');
    if (digests.length) {
      L.push('## 一、提炼汇总（规划的主要依据）');
      L.push('');
      for (const d of digests) {
        L.push('### ' + (d.title || d.topic));
        L.push('');
        L.push(String(d.content || ''));
        L.push('');
        L.push('---');
        L.push('');
      }
    }
    const section = function (title, list) {
      if (!list.length) return;
      L.push('## ' + title);
      L.push('');
      for (const x of list) {
        L.push('### [' + x.kind + '] ' + x.title);
        L.push('');
        const meta = [];
        if (x.site) meta.push('来源：' + x.site);
        if (x.url) meta.push('链接：' + x.url);
        if (x.published_at) meta.push('时间：' + x.published_at);
        if (meta.length) { L.push('*' + meta.join('　·　') + '*'); L.push(''); }
        const full = cleanText(x.content || x.snippet || '（无正文）');
        const cap = (x.site === '用户提供的图片' || x.site === '用户提供的电子书' || x.site === '导入的资料') ? 20000 : 4000;
        L.push(full.slice(0, cap) + (full.length > cap ? '\n\n> （本条共 ' + full.length + ' 字，此处截取前 ' + cap + ' 字）' : ''));
        L.push('');
        L.push('---');
        L.push('');
      }
    };
    section('二、你自己提供的资料（最高优先级）', own);
    section('三、网络检索资料', net);
    return L.join('\n');
  }

  return { digestsOf: digestsOf, sourcesOf: sourcesOf, digestBatches: digestBatches, buildLibraryMarkdown: buildLibraryMarkdown };
}
module.exports = { createSourceDomain: createSourceDomain };
