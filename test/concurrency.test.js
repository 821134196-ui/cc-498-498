'use strict';
// 并发领料：worker_threads 各持独立 SQLite 连接，BEGIN IMMEDIATE + busy_timeout 串行化写事务
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { open } = require('../src/db');
const D = require('../src/domain');

const WORKER = `
const { workerData } = require('node:worker_threads');
const { open } = require(${JSON.stringify(require.resolve('../src/db'))});
const D = require(${JSON.stringify(require.resolve('../src/domain'))});
const db = open(workerData.dbPath);
let ok = 0, blocked = 0;
for (let i = 0; i < workerData.tries; i++) {
  const r = D.pickup(db, {
    areaId: workerData.areaId, flowerId: 'rose', stems: 1, crew: workerData.crew + i,
  });
  if (r.ok) ok++; else blocked++;
}
require('node:worker_threads').parentPort.postMessage({ ok, blocked });
`;

function runWorkers(dbPath, specs) {
  return Promise.all(specs.map(w => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true, workerData: w, execArgv: ['--experimental-sqlite'],
    });
    worker.on('message', resolve);
    worker.on('error', reject);
  })));
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floral-'));
  return path.join(dir, 'c.db');
}

test('并发领料不超卖：多组同时抢同一区域，成功总数严格等于配额/库存', async () => {
  const dbPath = tmpDb();
  {
    const db = open(dbPath);
    const insF = db.prepare('INSERT INTO flowers(id,name,color,unit_price) VALUES(?,?,?,?)');
    insF.run('rose', '白玫瑰', '纯白', 12);
    const insA = db.prepare('INSERT INTO areas(id,name,is_hero,x,y,w,h,note) VALUES(?,?,?,?,?,?,?,?)');
    insA.run('arch', '花门', 1, 0, 0, 1, 1, null);
    D.publishVersion(db, {
      id: 'v1', label: 'V1',
      lines: [{ areaId: 'arch', flowerId: 'rose', stems: 100 }],
    });
    db.prepare(
      `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
        accepted_stems,rejected_stems,reject_reason,inspected_at)
       VALUES('rose','2026-09-30',100,'A', '合格',100,0,NULL,'2026-09-30T00:00:00Z')`).run();
    db.close();
  }

  const results = await runWorkers(dbPath, [
    { dbPath, areaId: 'arch', tries: 60, crew: '一组-' },
    { dbPath, areaId: 'arch', tries: 60, crew: '二组-' },
    { dbPath, areaId: 'arch', tries: 60, crew: '三组-' },
  ]);
  const totalOk = results.reduce((s, r) => s + r.ok, 0);
  const totalBlocked = results.reduce((s, r) => s + r.blocked, 0);
  assert.equal(totalOk, 100, '成功领料必须恰好 100 枝');
  assert.equal(totalOk + totalBlocked, 180, '180 次尝试全部留痕');

  const db = open(dbPath);
  const picked = db.prepare('SELECT COALESCE(SUM(stems),0) n FROM pickup_records').get().n;
  const attempts = db.prepare('SELECT COUNT(*) n FROM pickup_attempts').get().n;
  assert.equal(picked, 100);
  assert.equal(attempts, 180);
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('跨区并发：同一花材库存 150，两区配额各 100，总成功不超过库存', async () => {
  const dbPath = tmpDb();
  {
    const db = open(dbPath);
    const insF = db.prepare('INSERT INTO flowers(id,name,color,unit_price) VALUES(?,?,?,?)');
    insF.run('rose', '白玫瑰', '纯白', 12);
    const insA = db.prepare('INSERT INTO areas(id,name,is_hero,x,y,w,h,note) VALUES(?,?,?,?,?,?,?,?)');
    insA.run('arch', '花门', 1, 0, 0, 1, 1, null);
    insA.run('table', '主桌', 0, 0, 0, 1, 1, null);
    D.publishVersion(db, {
      id: 'v1', label: 'V1',
      lines: [
        { areaId: 'arch', flowerId: 'rose', stems: 100 },
        { areaId: 'table', flowerId: 'rose', stems: 100 },
      ],
    });
    db.prepare(
      `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
        accepted_stems,rejected_stems,reject_reason,inspected_at)
       VALUES('rose','2026-09-30',150,'A', '合格',150,0,NULL,'2026-09-30T00:00:00Z')`).run();
    db.close();
  }

  const results = await runWorkers(dbPath, [
    { dbPath, areaId: 'arch', tries: 100, crew: '花门组-' },
    { dbPath, areaId: 'table', tries: 100, crew: '主桌组-' },
  ]);
  const totalOk = results.reduce((s, r) => s + r.ok, 0);
  assert.equal(totalOk, 150, '库存只有 150 枝，不能被两个区域领到 200');

  const db = open(dbPath);
  const picked = db.prepare('SELECT COALESCE(SUM(stems),0) n FROM pickup_records').get().n;
  assert.equal(picked, 150);
  const stock = D.flowerStock(db, 'rose');
  assert.equal(stock.available, 0);
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
