'use strict';
// 领域规则：配额占用、版本过期、替换授权、领料并发安全、结算
const now = () => new Date().toISOString();

function currentVersion(db) {
  return db.prepare('SELECT * FROM plan_versions WHERE is_current = 1').get();
}

function getArea(db, id) {
  return db.prepare('SELECT * FROM areas WHERE id = ?').get(id);
}

function getFlower(db, id) {
  return db.prepare('SELECT * FROM flowers WHERE id = ?').get(id);
}

// 某区域对某花材的有效配额（只按当前版本计算）
// 配额 = 当前版本计划枝数 + 已批追加 + 已确认替代转入 - 已确认替代转出
function areaQuota(db, areaId, flowerId) {
  const v = currentVersion(db);
  const plan = db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM plan_lines
     WHERE version_id=? AND area_id=? AND flower_id=?`).get(v.id, areaId, flowerId).n;
  const additions = db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM site_additions
     WHERE area_id=? AND flower_id=? AND approved=1`).get(areaId, flowerId).n;
  const subIn = db.prepare(
    `SELECT COALESCE(SUM(shortfall_stems),0) n FROM substitutions
     WHERE version_id=? AND area_id=? AND substitute_flower_id=? AND status='已确认'`)
    .get(v.id, areaId, flowerId).n;
  const subOut = db.prepare(
    `SELECT COALESCE(SUM(shortfall_stems),0) n FROM substitutions
     WHERE version_id=? AND area_id=? AND original_flower_id=? AND status='已确认'`)
    .get(v.id, areaId, flowerId).n;
  return { plan, additions, subIn, subOut, quota: plan + additions + subIn - subOut };
}

function areaPicked(db, areaId, flowerId) {
  return db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM pickup_records WHERE area_id=? AND flower_id=?`)
    .get(areaId, flowerId).n;
}

// 全场合计：合格库存、已领、计划、追加
function flowerStock(db, flowerId) {
  const accepted = db.prepare(
    `SELECT COALESCE(SUM(accepted_stems),0) n FROM arrival_batches
     WHERE flower_id=? AND qc_status IN ('合格','部分合格')`).get(flowerId).n;
  const picked = db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM pickup_records WHERE flower_id=?`).get(flowerId).n;
  const v = currentVersion(db);
  const planned = v ? db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM plan_lines
     WHERE version_id=? AND flower_id=?`).get(v.id, flowerId).n : 0;
  const additions = db.prepare(
    `SELECT COALESCE(SUM(stems),0) n FROM site_additions
     WHERE flower_id=? AND approved=1`).get(flowerId).n;
  const recovered = db.prepare(
    `SELECT COALESCE(SUM(stems_recovered),0) n FROM teardowns WHERE flower_id=?`).get(flowerId).n;
  return { accepted, picked, planned, additions, recovered, available: accepted - picked };
}

function logAttempt(db, r) {
  db.prepare(
    `INSERT INTO pickup_attempts(area_id,flower_id,stems,crew,result,detail,created_at)
     VALUES(?,?,?,?,?,?,?)`)
    .run(r.areaId, r.flowerId, r.stems, r.crew, r.result, r.detail || null, now());
}

/**
 * 领料（同步事务，node:sqlite 单连接内原子执行，杜绝并发超卖）
 * 返回 { ok, result, detail }
 */
function pickup(db, { areaId, flowerId, stems, crew }) {
  if (!Number.isInteger(stems) || stems <= 0) {
    return { ok: false, result: '超配额', detail: '枝数必须为正整数' };
  }
  const area = getArea(db, areaId);
  const flower = getFlower(db, flowerId);
  if (!area || !flower) return { ok: false, result: '超配额', detail: '区域或花材不存在' };

  db.exec('BEGIN IMMEDIATE');
  try {
    const v = currentVersion(db);
    const q = areaQuota(db, areaId, flowerId);
    const picked = areaPicked(db, areaId, flowerId);
    const stock = flowerStock(db, flowerId);
    let result, detail, ok = false;

    // 1) 该花材对本区域没有配额：区分"未授权替换"与普通超配额
    if (q.quota === 0) {
      const pendingSub = db.prepare(
        `SELECT s.*, f.name sub_name FROM substitutions s JOIN flowers f ON f.id=s.substitute_flower_id
         WHERE s.area_id=? AND s.substitute_flower_id=? AND s.version_id=?
         ORDER BY s.id DESC LIMIT 1`).get(areaId, flowerId, v.id);
      if (pendingSub) {
        result = '未授权替换';
        detail = `替代花材「${flower.name}」替换单#${pendingSub.id}状态为${pendingSub.status}` +
          (area.is_hero ? '；主视觉区域未经客户确认不得替换' : '');
      } else {
        result = '超配额';
        detail = `「${flower.name}」不在当前版本的 ${area.name} 清单中`;
      }
    } else if (picked >= q.quota) {
      // 2) 配额已领满：多组人员重复领料
      result = '重复领料';
      detail = `${area.name} 的「${flower.name}」配额 ${q.quota} 枝已全部领走（已领 ${picked}）`;
    } else if (picked + stems > q.quota) {
      result = '超配额';
      detail = `申请 ${stems} 枝，本区域剩余配额仅 ${q.quota - picked} 枝（总配额 ${q.quota}）`;
    } else if (stock.available < stems) {
      result = '库存不足';
      detail = `全场「${flower.name}」合格库存 ${stock.accepted} 枝、已领 ${stock.picked} 枝，可用 ${stock.available} 枝`;
    } else {
      db.prepare(
        `INSERT INTO pickup_records(area_id,flower_id,stems,crew,created_at)
         VALUES(?,?,?,?,?)`).run(areaId, flowerId, stems, crew, now());
      result = '成功';
      detail = `${area.name} 领取「${flower.name}」${stems} 枝`;
      ok = true;
    }
    logAttempt(db, { areaId, flowerId, stems, crew, result, detail });
    db.exec('COMMIT');
    return { ok, result, detail };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 到货质检
function inspectBatch(db, id, { accepted, rejected, reason }) {
  const b = db.prepare('SELECT * FROM arrival_batches WHERE id=?').get(id);
  if (!b) throw new Error('批次不存在');
  if (accepted < 0 || rejected < 0 || accepted + rejected !== b.stems) {
    throw new Error(`合格 ${accepted} + 不合格 ${rejected} 必须等于到货 ${b.stems} 枝`);
  }
  const status = rejected === 0 ? '合格' : accepted === 0 ? '不合格' : '部分合格';
  db.prepare(
    `UPDATE arrival_batches SET qc_status=?, accepted_stems=?, rejected_stems=?,
     reject_reason=?, inspected_at=? WHERE id=?`)
    .run(status, accepted, rejected, rejected > 0 ? reason : null, now(), id);
  return db.prepare('SELECT * FROM arrival_batches WHERE id=?').get(id);
}

// 创建新版本（旧版本自动失效）
function publishVersion(db, { id, label, note, lines }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE plan_versions SET is_current=0 WHERE is_current=1').run();
    db.prepare('INSERT INTO plan_versions(id,label,created_at,is_current,note) VALUES(?,?,?,1,?)')
      .run(id, label, now(), note || null);
    const ins = db.prepare(
      `INSERT INTO plan_lines(version_id,area_id,flower_id,stems,ref_photo) VALUES(?,?,?,?,?)`);
    for (const l of lines) ins.run(id, l.areaId, l.flowerId, l.stems, l.refPhoto || null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * 客户确认替代单——必须关联具体版本；版本过期则拒绝并打标
 */
function decideSubstitution(db, id, decision, confirmer) {
  const sub = db.prepare('SELECT * FROM substitutions WHERE id=?').get(id);
  if (!sub) throw new Error('替代单不存在');
  if (sub.status !== '待客户确认') throw new Error(`替代单#${id}已审结（${sub.status}）`);
  const v = db.prepare('SELECT * FROM plan_versions WHERE id=?').get(sub.version_id);
  if (!v.is_current) {
    db.prepare('UPDATE substitutions SET status=? WHERE id=?').run('版本过期', id);
    const fresh = db.prepare('SELECT * FROM substitutions WHERE id=?').get(id);
    return { ok: false, status: '版本过期', substitution: fresh,
      detail: `替代单基于版本「${v.label}」，当前已有新版本，确认无效，需按新版本重提` };
  }
  const status = decision === 'confirm' ? '已确认' : '已拒绝';
  db.prepare('UPDATE substitutions SET status=?, confirmer=?, decided_at=? WHERE id=?')
    .run(status, confirmer || '客户', now(), id);
  return { ok: decision === 'confirm', status,
    substitution: db.prepare('SELECT * FROM substitutions WHERE id=?').get(id),
    detail: `替代单#${id} ${status}（版本「${v.label}」，确认人 ${confirmer || '客户'}）` };
}

function addAddition(db, { areaId, flowerId, stems, reason }) {
  if (!Number.isInteger(stems) || stems <= 0) throw new Error('追加枝数必须为正整数');
  db.prepare(
    `INSERT INTO site_additions(area_id,flower_id,stems,reason,approved,created_at)
     VALUES(?,?,?,?,1,?)`).run(areaId, flowerId, stems, reason || null, now());
}

function addTeardown(db, { areaId, flowerId, stems, condition }) {
  db.prepare(
    `INSERT INTO teardowns(area_id,flower_id,stems_recovered,condition,created_at)
     VALUES(?,?,?,?,?)`).run(areaId, flowerId, stems, condition, now());
}

function addPhoto(db, { areaId, kind, path }) {
  const info = db.prepare(
    'INSERT INTO completion_photos(area_id,kind,path,uploaded_at) VALUES(?,?,?,?)')
    .run(areaId, kind, path, now());
  return info.lastInsertRowid;
}

// 结算：按区域×花材展开（计划 / 替代 / 追加），含价差与回收
function settlement(db) {
  const v = currentVersion(db);
  const rows = [];
  const lines = db.prepare(
    `SELECT pl.*, a.name area_name, a.is_hero, f.name flower_name, f.color, f.unit_price
     FROM plan_lines pl JOIN areas a ON a.id=pl.area_id JOIN flowers f ON f.id=pl.flower_id
     WHERE pl.version_id=? ORDER BY a.id, f.id`).all(v.id);

  for (const l of lines) {
    const pickedOrig = areaPicked(db, l.area_id, l.flower_id);
    const sub = db.prepare(
      `SELECT s.*, f.name sub_name, f.color sub_color, f.unit_price sub_price
       FROM substitutions s JOIN flowers f ON f.id=s.substitute_flower_id
       WHERE s.version_id=? AND s.area_id=? AND s.original_flower_id=? AND s.status='已确认'
       LIMIT 1`
      ).get(v.id, l.area_id, l.flower_id);
    const replacedStems = sub ? Math.min(sub.shortfall_stems, l.stems) : 0;
    const subPicked = sub ? areaPicked(db, l.area_id, sub.substitute_flower_id) : 0;
    const addStems = db.prepare(
      `SELECT COALESCE(SUM(stems),0) n FROM site_additions WHERE area_id=? AND flower_id=? AND approved=1`)
      .get(l.area_id, l.flower_id).n;
    rows.push({
      areaId: l.area_id, area: l.area_name, isHero: !!l.is_hero,
      kind: '计划', flower: l.flower_name, color: l.color,
      stems: l.stems - replacedStems, plannedStems: l.stems, replacedStems,
      unitPrice: l.unit_price, priceDelta: 0,
      amount: (l.stems - replacedStems) * l.unit_price,
      picked: pickedOrig,
    });
    if (sub) {
      rows.push({
        areaId: l.area_id, area: l.area_name, isHero: !!l.is_hero,
        kind: '替代', flower: sub.sub_name, color: sub.sub_color,
        stems: sub.shortfall_stems, unitPrice: sub.sub_price, priceDelta: sub.price_delta,
        amount: sub.shortfall_stems * sub.sub_price,
        deltaAmount: sub.shortfall_stems * sub.price_delta,
        picked: subPicked,
        original: l.flower_name, visualDiff: sub.visual_diff,
      });
    }
    if (addStems > 0) {
      rows.push({
        areaId: l.area_id, area: l.area_name, isHero: !!l.is_hero,
        kind: '追加', flower: l.flower_name, color: l.color,
        stems: addStems, unitPrice: l.unit_price, priceDelta: 0,
        amount: addStems * l.unit_price, picked: pickedOrig > l.stems ? pickedOrig - l.stems : 0,
      });
    }
  }
  // 追加花材不在计划行里的（如临时追加替代花材之外的品种）
  const extraAdds = db.prepare(
    `SELECT sa.area_id, a.name area_name, a.is_hero, f.name flower_name, f.color,
            f.unit_price, SUM(sa.stems) stems
     FROM site_additions sa JOIN areas a ON a.id=sa.area_id JOIN flowers f ON f.id=sa.flower_id
     WHERE sa.approved=1 AND NOT EXISTS(
       SELECT 1 FROM plan_lines pl WHERE pl.version_id=? AND pl.area_id=sa.area_id AND pl.flower_id=sa.flower_id)
     GROUP BY sa.area_id, sa.flower_id`).all(v.id);
  for (const e of extraAdds) {
    rows.push({
      areaId: e.area_id, area: e.area_name, isHero: !!e.is_hero,
      kind: '追加', flower: e.flower_name, color: e.color, stems: e.stems,
      unitPrice: e.unit_price, priceDelta: 0, amount: e.stems * e.unit_price,
      picked: areaPicked(db, e.area_id, e.flower_id),
    });
  }
  const plannedTotal = db.prepare(
    `SELECT COALESCE(SUM(pl.stems*f.unit_price),0) n FROM plan_lines pl
     JOIN flowers f ON f.id=pl.flower_id WHERE pl.version_id=?`).get(v.id).n;
  const actualTotal = rows.reduce((s, r) => s + r.amount, 0);
  const recoveredWorth = db.prepare(
    `SELECT COALESCE(SUM(t.stems_recovered*f.unit_price),0) n
     FROM teardowns t JOIN flowers f ON f.id=t.flower_id WHERE t.condition='完好可复用'`).get().n;
  return { version: v.label, rows, plannedTotal, actualTotal, recoveredWorth,
           netPayable: actualTotal - recoveredWorth };
}

module.exports = {
  now, currentVersion, getArea, getFlower, areaQuota, areaPicked, flowerStock,
  pickup, inspectBatch, publishVersion, decideSubstitution,
  addAddition, addTeardown, addPhoto, settlement,
};
