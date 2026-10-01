'use strict';
// 测试夹具：内存库 + 最小婚礼数据
const { open } = require('../src/db');
const D = require('../src/domain');

function build() {
  const db = open(':memory:');
  const insF = db.prepare('INSERT INTO flowers(id,name,color,unit_price) VALUES(?,?,?,?)');
  insF.run('rose', '白玫瑰', '纯白', 12);
  insF.run('euca', '尤加利叶', '叶绿', 4);
  insF.run('carn', '白康乃馨', '米白', 8);
  const insA = db.prepare('INSERT INTO areas(id,name,is_hero,x,y,w,h,note) VALUES(?,?,?,?,?,?,?,?)');
  insA.run('arch', '花门', 1, 0, 0, 10, 10, '主视觉');
  insA.run('table', '主桌', 0, 0, 0, 10, 10, null);
  return db;
}

// v1：花门白玫瑰 100；主桌白玫瑰 100；主桌尤加利 50
function v1(db) {
  D.publishVersion(db, {
    id: 'v1', label: 'V1',
    lines: [
      { areaId: 'arch', flowerId: 'rose', stems: 100 },
      { areaId: 'table', flowerId: 'rose', stems: 100 },
      { areaId: 'table', flowerId: 'euca', stems: 50 },
    ],
  });
}

// 合格到货：白玫瑰共 150（小于总计划 200，制造跨区争抢）
function stock(db) {
  const t = '2026-09-30T00:00:00.000Z';
  const insB = db.prepare(
    `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
      accepted_stems,rejected_stems,reject_reason,inspected_at)
     VALUES(?,?,?,?, '合格', ?, 0, NULL, ?)`);
  insB.run('rose', '2026-09-30', 150, 'A-1', 150, t);
  insB.run('euca', '2026-09-30', 80, 'B-1', 80, t);
}

function sub(db, { version = 'v1', area = 'arch', from = 'rose', to = 'carn', stems = 40, delta = -4 }) {
  return db.prepare(
    `INSERT INTO substitutions(version_id,area_id,original_flower_id,substitute_flower_id,
      shortfall_stems,price_delta,visual_diff,status,created_at)
     VALUES(?,?,?,?,?,?,?, '待客户确认', '2026-09-30T00:00:00.000Z')`)
    .run(version, area, from, to, stems, delta, '色调接近，花径略小').lastInsertRowid;
}

module.exports = { build, v1, stock, sub };
