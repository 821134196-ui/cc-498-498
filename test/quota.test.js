'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const D = require('../src/domain');

function setup() {
  const db = H.build();
  H.v1(db);
  H.stock(db); // 白玫瑰合格库存 150；两区配额各 100（总计划 200）
  return db;
}

test('同一批库存不能被两个区域重复占用：花门领满后主桌只能领到剩余库存', () => {
  const db = setup();
  let r = D.pickup(db, { areaId: 'arch', flowerId: 'rose', stems: 100, crew: '一组' });
  assert.equal(r.ok, true);

  // 主桌配额 100，但全场只剩 50 枝 → 领 100 被库存拦下
  r = D.pickup(db, { areaId: 'table', flowerId: 'rose', stems: 100, crew: '二组' });
  assert.equal(r.ok, false);
  assert.equal(r.result, '库存不足');

  // 只能领 50
  r = D.pickup(db, { areaId: 'table', flowerId: 'rose', stems: 50, crew: '二组' });
  assert.equal(r.ok, true);

  const stock = D.flowerStock(db, 'rose');
  assert.equal(stock.picked, 150);
  assert.equal(stock.available, 0);

  // 库存已空，再领任意数量都不行
  r = D.pickup(db, { areaId: 'table', flowerId: 'rose', stems: 1, crew: '二组' });
  assert.equal(r.result, '库存不足');
});

test('区域配额领满后多组重复领料被拦截并留痕', () => {
  const db = setup();
  assert.equal(D.pickup(db, { areaId: 'arch', flowerId: 'rose', stems: 60, crew: '一组' }).ok, true);
  assert.equal(D.pickup(db, { areaId: 'arch', flowerId: 'rose', stems: 40, crew: '一组' }).ok, true);

  // 二组再领 → 重复领料
  const r = D.pickup(db, { areaId: 'arch', flowerId: 'rose', stems: 10, crew: '二组' });
  assert.equal(r.ok, false);
  assert.equal(r.result, '重复领料');

  // 超领一笔也不允许（不能越过剩余配额）
  db.prepare('DELETE FROM pickup_records').run();
  const over = D.pickup(db, { areaId: 'arch', flowerId: 'rose', stems: 101, crew: '一组' });
  assert.equal(over.result, '超配额');

  // 成功记录之外，每次尝试都留痕
  const logs = db.prepare("SELECT result FROM pickup_attempts WHERE result!='成功'").all();
  assert.ok(logs.some(l => l.result === '重复领料'));
  assert.ok(logs.some(l => l.result === '超配额'));
});

test('临时追加与已确认替代会改变配额，但总库存占用不超过合格到货', () => {
  const db = setup();
  D.addAddition(db, { areaId: 'table', flowerId: 'euca', stems: 20, reason: '加角花' });
  assert.equal(D.areaQuota(db, 'table', 'euca').quota, 70);

  const subId = H.sub(db, { area: 'table', from: 'rose', to: 'carn', stems: 30, delta: -4 });
  // 康乃馨到货 30
  db.prepare(
    `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
      accepted_stems,rejected_stems,reject_reason,inspected_at)
     VALUES('carn','2026-09-30',30,'C', '合格',30,0,NULL,'2026-09-30T00:00:00Z')`).run();
  const decided = D.decideSubstitution(db, subId, 'confirm', '客户');
  assert.equal(decided.ok, true);

  // 原玫瑰配额下调 30，康乃馨配额转入 30
  assert.equal(D.areaQuota(db, 'table', 'rose').quota, 70);
  assert.equal(D.areaQuota(db, 'table', 'carn').quota, 30);

  D.pickup(db, { areaId: 'table', flowerId: 'carn', stems: 30, crew: '二组' });
  // 替代花材配额也不能重复领
  const again = D.pickup(db, { areaId: 'table', flowerId: 'carn', stems: 1, crew: '三组' });
  assert.equal(again.result, '重复领料');
});
