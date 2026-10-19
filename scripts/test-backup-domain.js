'use strict';
/**
 * 备份领域回归：node --no-warnings scripts/test-backup-domain.js
 * 临时目录 + 临时 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createBackupDomain } = require('../server/domains/backups.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-backup-test-'));
const dbPath = path.join(dir, 'db.sqlite');
const backupDir = path.join(dir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

let keep = 2;
const stamps = ['20261018-000001', '20261018-000002', '20261018-000003'];
let stampIdx = 0;
let changes = 0;
const domain = createBackupDomain({
  dbPath: dbPath,
  backupDir: backupDir,
  getSetting: function (k, d) { return k === 'backup_keep' ? String(keep) : d; },
  nowStamp: function () { return stamps[stampIdx++] || '20261018-000009'; },
  onDataChange: function () { changes++; }
});

function makeDb(title) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO goals (id,title) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(title);
  db.close();
}

let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

makeDb('第一版');
domain.backup();
ok('backup 创建文件并触发 onDataChange', domain.backupList().length === 1 && changes === 1);

makeDb('第二版');
domain.backup();
const list2 = domain.backupList();
ok('第二次备份后列表 2 份（新的在前）', list2.length === 2 && list2[0].name === 'sierxing-20261018-000002.db');

const diff = domain.backupDiff(list2[1].name, list2[0].name);
const goals = diff.items.find(function (x) { return x.table === 'goals'; });
ok('backupDiff 能看到目标标题变化', !!goals && goals.changed === 1 && goals.samples.some(function (s) { return s.text.indexOf('第一版') >= 0 && s.text.indexOf('第二版') >= 0; }));

keep = 1;
domain.pruneBackups();
ok('pruneBackups 按 backup_keep 只留 1 份', domain.backupList().length === 1);

fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'x');
ok('backupList 忽略非备份文件', domain.backupList().length === 1);

let bad = null;
try { domain.backupDiff('../evil.db', domain.backupList()[0].name); } catch (e) { bad = e; }
ok('backupDiff 拒绝非法备份名', !!bad && bad.message.indexOf('不合法') >= 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n6 项全部通过');
