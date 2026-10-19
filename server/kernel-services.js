'use strict';
/**
 * 思而行 · 内核服务装配（P1）
 * ---------------------------------------------------------------------------
 * 为什么要有这一层：内核只认「服务」，而 server.js 里的能力（db / ai / tasks /
 * 提示词 / 达成条件 / 备份 / 同步 / RAG …）原先是一个个闭包变量，插件只能靠
 * 「宿主把 ctx 塞给我」被动接受。这里做两件事：
 *
 *   1. 把这些能力按名字注册进内核，插件可以写 requires: ['db','ai'] 声明依赖，
 *      缺了就被跳过（而不是运行时 ReferenceError）。
 *   2. 给每个服务挂上元数据（title / version / vendor），供 /api/kernel 自检页和
 *      用户排查「这个能力是谁提供的、能不能换」。
 *
 * 注意：这里不做任何业务逻辑，只做「命名 + 注册」。真正的实现仍在 server.js
 * 或 server/*.js 里 —— P4（内核瘦身）才会把实现逐步搬走，本轮不动，避免风险。
 */
const { createKernel, KERNEL_API } = require('./kernel.js');

/** 核心服务的元数据（用户可见的名字 / 版本 / 提供者） */
const CORE_SERVICE_META = {
  db:        { title: 'SQLite 数据库', vendor: 'builtin', version: '1.0.0' },
  ai:        { title: 'AI 接入（文本/流式/工具）', vendor: 'builtin', version: '1.0.0' },
  tasks:     { title: '后台长任务', vendor: 'builtin', version: '1.0.0' },
  conditions:{ title: '达成条件领域', vendor: 'builtin', version: '1.0.0' },
  backup:    { title: '备份与恢复', vendor: 'builtin', version: '1.0.0' },
  sync:      { title: '多端同步', vendor: 'builtin', version: '1.0.0' },
  rag:       { title: '检索增强（RAG）', vendor: 'builtin', version: '1.0.0' },
  prompts:   { title: '提示词包', vendor: 'builtin', version: '1.0.0' },
  settings:  { title: '设置读写', vendor: 'builtin', version: '1.0.0' },
  log:       { title: '日志', vendor: 'builtin', version: '1.0.0' },
  nowISO:    { title: '标准时间', vendor: 'builtin', version: '1.0.0' },
  safeParse: { title: 'JSON 安全解析', vendor: 'builtin', version: '1.0.0' },
  getGoal:   { title: '读取目标', vendor: 'builtin', version: '1.0.0' },
  sourcesOf: { title: '读取资料', vendor: 'builtin', version: '1.0.0' },
  aiText:    { title: 'AI 文本调用', vendor: 'builtin', version: '1.0.0' },
  aiTextFiles: { title: 'AI 文件调用', vendor: 'builtin', version: '1.0.0' },
  currentModel: { title: '当前对话模型', vendor: 'builtin', version: '1.0.0' },
  currentVisionModel: { title: '当前视觉模型', vendor: 'builtin', version: '1.0.0' }
};

/** 把宿主 ctx 的每个键注册成内核服务（值可以是对象/函数/字符串，undefined 也照常注册） */
function provideContext(kernel, ctx, meta) {
  const names = [];
  for (const name of Object.keys(ctx || {})) {
    try {
      kernel.provide(name, ctx[name], Object.assign({ plugin: 'core' }, CORE_SERVICE_META[name] || {}, (meta && meta[name]) || {}));
      names.push(name);
    } catch (e) {
      if (ctx && typeof ctx.log === 'function') ctx.log('[kernel] 服务注册失败：' + name + ' — ' + e.message);
    }
  }
  return names;
}

/** 创建「已装配好宿主服务」的内核 */
function createContextKernel(ctx, opts) {
  const k = createKernel(Object.assign({ apiVersion: KERNEL_API }, opts || {}));
  provideContext(k, ctx);
  return k;
}

module.exports = { createContextKernel, provideContext, CORE_SERVICE_META, KERNEL_API };
