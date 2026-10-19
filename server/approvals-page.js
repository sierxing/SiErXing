'use strict';
/**
 * 思而行 · 审批页（本机、无外链、无依赖）
 * 只负责把待批准的命令/入参展示给用户，并调用两个本机接口：
 *   POST /api/approvals/:id/approve
 *   POST /api/approvals/:id/reject
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

module.exports = function renderApprovalPage(a) {
  const id = esc(a.id);
  const inputText = JSON.stringify(a.input || {}, null, 2);
  const pending = a.status === 'pending';
  const stageId = a.command === 'component.install' && a.input && a.input.changeId ? String(a.input.changeId) : '';
  const stageLink = stageId
    ? '<p class="warn">⚠️ 组件代码会在应用进程内运行。 <a href="/api/component-staging/' + esc(stageId) + '/preview" target="_blank" rel="noopener">查看将要安装的组件代码</a></p>'
    : '';
  const rows = [
    ['命令', a.command || ''],
    ['风险', a.risk || ''],
    ['发起者', a.actor || ''],
    ['原因', a.reason || '（未填写）'],
    ['创建时间', a.createdAt || ''],
    ['过期时间', a.expiresAt || ''],
    ['当前状态', a.status || '']
  ].map(function (r) {
    return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>';
  }).join('');

  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>思而行 · 审批</title>' +
    '<style>' +
    'body{margin:0;background:#f6f5f1;color:#222;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.wrap{max-width:760px;margin:48px auto;padding:0 20px}' +
    '.card{background:#fff;border:1px solid #e4e0d8;border-radius:14px;padding:24px 26px;box-shadow:0 8px 30px rgba(0,0,0,.06)}' +
    'h1{font-size:20px;margin:0 0 6px}p.sub{color:#777;margin:0 0 18px}' +
    'table{border-collapse:collapse;width:100%;margin:10px 0 18px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f0ede7;vertical-align:top}' +
    'th{width:92px;color:#777;font-weight:500}pre{background:#f8f7f3;border:1px solid #ece8df;border-radius:10px;padding:14px;overflow:auto;max-height:340px;font-size:13px;white-space:pre-wrap;word-break:break-word}' +
    '.btns{display:flex;gap:10px;margin-top:18px}button{border:0;border-radius:9px;padding:10px 18px;font-size:14px;cursor:pointer}' +
    '.ok{background:#1f8a4c;color:#fff}.no{background:#eee9df;color:#333}' +
    '#msg{margin-top:14px;color:#555}.warn{color:#b45309}' +
    '</style></head><body><div class="wrap"><div class="card">' +
    '<h1>思而行 · 等用户批准</h1>' +
    '<p class="sub">Agent 想执行一个需要你确认的操作。看清楚命令和入参后再决定。</p>' +
    stageLink +
    '<table>' + rows + '</table>' +
    '<div><strong>入参</strong></div><pre>' + esc(inputText) + '</pre>' +
    (pending
      ? '<div class="btns" id="btns"><button class="ok" onclick="act(\'approve\')">批准并执行</button><button class="no" onclick="act(\'reject\')">拒绝</button></div>'
      : '<p class="warn">这条审批已经不是待批准状态，不能在这里操作。</p>') +
    '<div id="msg"></div>' +
    '</div></div>' +
    '<script>' +
    'var ID=' + JSON.stringify(a.id || '') + ';' +
    'async function act(kind){' +
    '  var msg=document.getElementById("msg");var btns=document.getElementById("btns");' +
    '  try{var r=await fetch("/api/approvals/"+encodeURIComponent(ID)+"/"+kind,{method:"POST"});var j=await r.json().catch(function(){return {}});' +
    '  if(r.ok){msg.textContent=kind==="approve"?"已批准。回到 Agent 继续。":"已拒绝。";if(btns)btns.hidden=true;}' +
    '  else{msg.textContent="失败："+((j.error&&j.error.message)||r.status);}}' +
    '  catch(e){msg.textContent="请求失败："+e.message;}' +
    '}' +
    '</script></body></html>';
};
