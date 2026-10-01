'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const D = require('../src/domain');

function setup() {
  const db = H.build();
  H.v1(db);
  H.stock(db);
  db.prepare(
    `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
      accepted_stems,rejected_stems,reject_reason,inspected_at)
     VALUES('carn','2026-09-30',60,'C', '合格',60,0,NULL,'2026-09-30T00:00:00Z')`).run();
  return db;
}

test('主视觉区域：未确认替代单前，布置端不能领替代花材', () => {
  const db = setup();
  const subId = H.sub(db, { area: 'arch', from: 'rose', to: 'carn', stems: 40 });

  // 花门是主视觉，康乃馨替代单待确认 → 领料被拒且原因标明主视觉
  const r = D.pickup(db, { areaId: 'arch', flowerId: 'carn', stems: 40, crew: '二组' });
  assert.equal(r.ok, false);
  assert.equal(r.result, '未授权替换');
  assert.match(r.detail, /主视觉区域未经客户确认不得替换/);

  // 客户确认后可以领
  const decided = D.decideSubstitution(db, subId, 'confirm', '客户（林小姐）');
  assert.equal(decided.ok, true);
  const ok = D.pickup(db, { areaId: 'arch', flowerId: 'carn', stems: 40, crew: '二组' });
  assert.equal(ok.ok, true);

  // 留痕里先有未授权、后有成功
  const log = db.prepare('SELECT result FROM pickup_attempts WHERE flower_id=?').all('carn');
  assert.deepEqual(log.map(l => l.result), ['未授权替换', '成功']);
});

test('客户拒绝的替代单不能领料；普通区域同样受授权约束', () => {
  const db = setup();
  const id = H.sub(db, { area: 'table', from: 'rose', to: 'carn', stems: 20 });
  D.decideSubstitution(db, id, 'reject', '客户');

  const r = D.pickup(db, { areaId: 'table', flowerId: 'carn', stems: 20, crew: '三组' });
  assert.equal(r.ok, false);
  // 已拒绝的替代单状态不是待确认——匹配到的最新替代单仍在，给出未授权替换
  assert.equal(r.result, '未授权替换');
});

test('与任何替代单无关的花材出现在错误区域，按超配额拦截', () => {
  const db = setup();
  // 康乃馨在任何区域都没有已确认配额，且该区域无替代单（euca 区域）
  const r = D.pickup(db, { areaId: 'table', flowerId: 'carn', stems: 5, crew: '三组' });
  // 主桌存在 carn 待确认替代单（上一条测试用例是独立库；这里没有）→ 本库无替代单
  assert.equal(r.result, '超配额');
});
