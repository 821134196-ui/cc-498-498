'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const D = require('../src/domain');

test('基于旧版本的替代单不能再被客户确认，自动标记版本过期', () => {
  const db = H.build();
  H.v1(db);
  const subId = H.sub(db, { version: 'v1', area: 'arch', to: 'carn', stems: 40 });

  // 发布 V2（花门白玫瑰从 100 调到 80）
  D.publishVersion(db, {
    id: 'v2', label: 'V2',
    lines: [
      { areaId: 'arch', flowerId: 'rose', stems: 80 },
      { areaId: 'table', flowerId: 'rose', stems: 100 },
    ],
  });
  assert.equal(D.currentVersion(db).id, 'v2');

  // 旧单确认 → 过期，不生效
  const r = D.decideSubstitution(db, subId, 'confirm', '客户');
  assert.equal(r.ok, false);
  assert.equal(r.status, '版本过期');
  assert.equal(
    db.prepare('SELECT status FROM substitutions WHERE id=?').get(subId).status,
    '版本过期');

  // 配额按 V2，未因"确认"发生任何变化
  assert.equal(D.areaQuota(db, 'arch', 'rose').quota, 80);
  assert.equal(D.areaQuota(db, 'arch', 'carn').quota, 0);
});

test('当前版本上的替代单确认后才开放配额，拒绝不开放', () => {
  const db = H.build();
  H.v1(db);
  const rejectId = H.sub(db, { version: 'v1', area: 'table', from: 'rose', to: 'carn', stems: 20 });
  const okId = H.sub(db, { version: 'v1', area: 'arch', from: 'rose', to: 'carn', stems: 40 });

  const rejected = D.decideSubstitution(db, rejectId, 'reject', '客户');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, '已拒绝');
  assert.equal(D.areaQuota(db, 'table', 'rose').quota, 100);
  assert.equal(D.areaQuota(db, 'table', 'carn').quota, 0);

  // 已审结不能重复确认
  assert.throws(() => D.decideSubstitution(db, rejectId, 'confirm', '客户'), /已审结/);

  const confirmed = D.decideSubstitution(db, okId, 'confirm', '客户');
  assert.equal(confirmed.ok, true);
  assert.equal(D.areaQuota(db, 'arch', 'rose').quota, 60);
  assert.equal(D.areaQuota(db, 'arch', 'carn').quota, 40);
});
