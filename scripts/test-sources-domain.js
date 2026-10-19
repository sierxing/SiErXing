'use strict';
/**
 * 资料/提炼领域回归：node --no-warnings scripts/test-sources-domain.js
 * 纯内存 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { createSourceDomain } = require('../server/domains/sources.js');

const db = new DatabaseSync(':memory:');
db.exec([
  "CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT '网页', site TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', quality INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE source_digests (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', sources_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);"
].join('\n'));
const ins = db.prepare('INSERT INTO sources (goal_id,kind,site,title,url,snippet,content,quality,published_at) VALUES (?,?,?,?,?,?,?,?,?)');
ins.run(1, '网页', 'csdn', '网络资料 A', 'https://a', '', '网络正文 A', 0, '2026-01-01');
ins.run(1, '图片', '用户提供的图片', '用户图片 B', '', '', '用户图片正文 B', 0, '');
ins.run(1, '文章', 'zhihu', '优质网络 C', 'https://c', '', '优质正文 C', 1, '');
ins.run(2, '网页', 'other', '别的目标', '', '', 'x', 0, '');
db.prepare('INSERT INTO source_digests (goal_id,topic,title,content,sources_count,created_at) VALUES (?,?,?,?,?,?)').run(1, '主题一', '汇总一', '汇总正文一', 3, '2026-10-18');

const d = createSourceDomain({ db: db, cleanText: function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); }, nowISO: function () { return '2026-10-18T00:00:00.000Z'; } });
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

const list = d.sourcesOf(1);
ok('sourcesOf 只取本目标并按优质/自提供优先', list.length === 3 && list[0].title === '优质网络 C' && list[1].site === '用户提供的图片');
ok('sourcesOf 不串目标', d.sourcesOf(2).length === 1 && d.sourcesOf(2)[0].title === '别的目标');

const info = d.digestBatches({ id: 1, title: '测试' });
ok('digestBatches 分批并区分自提供/网络（星标会额外置顶一条）', info.ownCount === 1 && info.netCount === 2 && info.total === 4 && info.batches.length === 1);
ok('优质信息源排在前面', info.batches[0][0].label.indexOf('★优质信息源') >= 0);

const md = d.buildLibraryMarkdown({ id: 1, title: '测试目标' });
ok('buildLibraryMarkdown 含汇总与三类分区', md.indexOf('# 资源库：测试目标') === 0 && md.indexOf('## 一、提炼汇总') >= 0 && md.indexOf('## 二、你自己提供的资料') >= 0 && md.indexOf('## 三、网络检索资料') >= 0);
ok('buildLibraryMarkdown 带来源/正文', md.indexOf('来源：csdn') >= 0 && md.indexOf('网络正文 A') >= 0);

db.close();
console.log('\n6 项全部通过');
