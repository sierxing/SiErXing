'use strict';
/**
 * 思而行 · 组件安装预览页（本机、无外链、无依赖）
 * 给用户在看审批前一个可读的「将要安装的组件代码」页面。
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function section(title, code) {
  const body = code && String(code).trim() ? '<pre>' + esc(code) + '</pre>' : '<p class="muted">（空）</p>';
  return '<details open><summary>' + esc(title) + '</summary>' + body + '</details>';
}
function sectionClosed(title, code) {
  const body = code && String(code).trim() ? '<pre>' + esc(code) + '</pre>' : '<p class="muted">（空）</p>';
  return '<details><summary>' + esc(title) + '</summary>' + body + '</details>';
}
module.exports = function renderComponentPreviewPage(stage, current) {
  const summary = (stage && stage.summary) || {};
  const bundle = (stage && stage.bundle) || {};
  const sizes = summary.sizes || {};
  const rows = [
    ['组件 id', summary.id || bundle.id || ''],
    ['名称', summary.name || bundle.name || ''],
    ['版本', summary.version || bundle.version || ''],
    ['类型', summary.kind || bundle.kind || 'feature'],
    ['服务端代码', String(sizes.server != null ? sizes.server : String(bundle.server || '').length) + ' 字符'],
    ['前端代码', String(sizes.client != null ? sizes.client : String(bundle.client || '').length) + ' 字符'],
    ['样式', String(sizes.style != null ? sizes.style : String(bundle.style || '').length) + ' 字符'],
    ['内容哈希', summary.hash || ''],
    ['状态', stage.status || 'staged']
  ].map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  const oldBlock = current
    ? '<h2>当前版本（会被替换）</h2>' + sectionClosed('当前 · 服务端', current.server) + sectionClosed('当前 · 前端', current.client) + sectionClosed('当前 · 样式', current.style)
    : '<p class="muted">当前没有同名组件，这是新安装。</p>';
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>思而行 · 组件预览</title>' +
    '<style>' +
    'body{margin:0;background:#f6f5f1;color:#222;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.wrap{max-width:1040px;margin:36px auto;padding:0 20px}' +
    '.card{background:#fff;border:1px solid #e4e0d8;border-radius:14px;padding:22px 24px;box-shadow:0 8px 30px rgba(0,0,0,.06)}' +
    'h1{font-size:20px;margin:0 0 6px}h2{font-size:16px;margin:22px 0 8px}p.sub{color:#777;margin:0 0 14px}' +
    '.warn{background:#fff7e6;border:1px solid #f0d49a;color:#8a5a00;border-radius:10px;padding:10px 14px;margin:12px 0}' +
    'table{border-collapse:collapse;width:100%;margin:8px 0 16px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #f0ede7;vertical-align:top}th{width:120px;color:#777;font-weight:500}' +
    'pre{background:#f8f7f3;border:1px solid #ece8df;border-radius:10px;padding:12px;overflow:auto;max-height:420px;font-size:12.5px;white-space:pre-wrap;word-break:break-word}' +
    'details{margin:8px 0}summary{cursor:pointer;font-weight:600;padding:4px 0}.muted{color:#999}' +
    '</style></head><body><div class="wrap"><div class="card">' +
    '<h1>组件安装预览</h1>' +
    '<p class="sub">这是 Agent 准备安装的非核心组件。请先看清楚代码再决定是否批准。</p>' +
    '<div class="warn">⚠️ 组件 JS 会在思而行进程内运行，权限和宿主一致。只安装你信任的代码。核心/内置组件不会被覆盖。</div>' +
    '<table>' + rows + '</table>' +
    '<h2>新版本（批准后写入）</h2>' +
    section('新 · 服务端', bundle.server) + section('新 · 前端', bundle.client) + section('新 · 样式', bundle.style) +
    oldBlock +
    '<p class="sub" style="margin-top:18px">回到审批页点「批准并执行」；安装前会备份，文件加载失败会自动回滚旧文件。</p>' +
    '</div></div></body></html>';
};
