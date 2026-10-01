'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./db');
const D = require('./domain');
const { createNotifier } = require('./notify');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.FLORAL_DB || path.join(DATA_DIR, 'floral.db');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(PHOTO_DIR, { recursive: true });
const db = open(DB_PATH);
const notify = createNotifier(db, path.join(DATA_DIR, 'notifications.log'));

// ---------- 查询聚合 ----------
function dashboard() {
  const v = D.currentVersion(db);
  const areas = db.prepare('SELECT * FROM areas ORDER BY id').all();
  const flowers = db.prepare('SELECT * FROM flowers ORDER BY id').all();
  const rows = areas.map(a => {
    const lines = db.prepare(
      `SELECT pl.*, f.name flower_name, f.color, f.unit_price
       FROM plan_lines pl JOIN flowers f ON f.id=pl.flower_id
       WHERE pl.version_id=? AND pl.area_id=? ORDER BY f.id`).all(v.id, a.id);
    const items = lines.map(l => {
      const q = D.areaQuota(db, a.id, l.flower_id);
      const picked = D.areaPicked(db, a.id, l.flower_id);
      const stock = D.flowerStock(db, l.flower_id);
      const sub = db.prepare(
        `SELECT s.*, f.name sub_name FROM substitutions s JOIN flowers f ON f.id=s.substitute_flower_id
         WHERE s.version_id=? AND s.area_id=? AND s.original_flower_id=?
         ORDER BY s.id DESC LIMIT 1`).get(v.id, a.id, l.flower_id);
      return { ...l, flower_name: l.flower_name, color: l.color, unit_price: l.unit_price,
        quota: q.quota, planStems: q.plan, additions: q.additions,
        subIn: q.subIn, subOut: q.subOut,
        picked, available: stock.available,
        sub: sub ? { id: sub.id, subName: sub.sub_name, shortfall: sub.shortfall_stems,
          priceDelta: sub.price_delta, visualDiff: sub.visual_diff, status: sub.status,
          beforePhoto: sub.before_photo, afterPhoto: sub.after_photo } : null };
    });
    return { ...a, items };
  });
  return appendSubstituteIns(rows);
}

// 已确认替代转入、但不在版本清单行里的花材，补成合成行（配额页/领料页可见）
function appendSubstituteIns(areasRows) {
  const v = D.currentVersion(db);
  for (const a of areasRows) {
    const known = new Set(a.items.map(i => i.flower_id));
    const ins = db.prepare(
      `SELECT s.substitute_flower_id fid, f.name flower_name, f.color, f.unit_price,
              s.shortfall_stems stems, s.id sub_id
       FROM substitutions s JOIN flowers f ON f.id=s.substitute_flower_id
       WHERE s.version_id=? AND s.area_id=? AND s.status='已确认'`).all(v.id, a.id);
    for (const s of ins) {
      if (known.has(s.fid)) continue;
      const q = D.areaQuota(db, a.id, s.fid);
      const stock = D.flowerStock(db, s.fid);
      a.items.push({
        flower_id: s.fid, flower_name: s.flower_name, color: s.color, unit_price: s.unit_price,
        stems: 0, ref_photo: null, quota: q.quota, planStems: 0, additions: q.additions,
        subIn: q.subIn, subOut: 0, picked: D.areaPicked(db, a.id, s.fid),
        available: stock.available, substituteIn: true,
        sub: { id: s.sub_id, subName: s.flower_name, shortfall: s.stems,
          priceDelta: null, visualDiff: '', status: '已确认', beforePhoto: null, afterPhoto: null },
      });
    }
  }
  return areasRows;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) reject(new Error('请求过大')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

function savePhoto(fileBuf, originalName) {
  const ext = (path.extname(originalName) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const p = path.join(PHOTO_DIR, name);
  fs.writeFileSync(p, fileBuf);
  return `/photos/${name}`;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // 静态：页面与照片
    if (p === '/' || p === '/index.html') return serveFile(res, 'index.html', 'text/html');
    if (p === '/app.js') return serveFile(res, 'app.js', 'application/javascript');
    if (p.startsWith('/photos/')) {
      const name = path.basename(p);
      return serveFile(res, path.join('photos', name),
        name.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg', true);
    }
    if (p.startsWith('/api/') && req.method === 'GET') return getApi(res, p, url);
    if (p.startsWith('/api/') && req.method === 'POST') return await postApi(req, res, p);
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

function serveFile(res, rel, type, isData) {
  const full = isData ? path.join(DATA_DIR, rel) : path.join(PUBLIC_DIR, rel);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  });
}

function getApi(res, p, url) {
  if (p === '/api/summary') {
    const v = D.currentVersion(db);
    const flowers = db.prepare('SELECT * FROM flowers ORDER BY id').all()
      .map(f => ({ ...f, stock: D.flowerStock(db, f.id) }));
    const areas = dashboard();
    const attempts = db.prepare('SELECT * FROM pickup_attempts ORDER BY id DESC LIMIT 20').all();
    const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 10').all();
    return json(res, 200, { version: v, flowers, areas, attempts, notifications });
  }
  if (p === '/api/batches') {
    const rows = db.prepare(
      `SELECT b.*, f.name flower_name, f.color FROM arrival_batches b
       JOIN flowers f ON f.id=b.flower_id ORDER BY b.arrive_date, b.id`).all();
    return json(res, 200, rows);
  }
  if (p === '/api/substitutions') {
    const rows = db.prepare(
      `SELECT s.*, pv.label version_label, pv.is_current, a.name area_name, a.is_hero,
              fo.name original_name, fo.color original_color,
              fs.name substitute_name, fs.color substitute_color, fs.unit_price sub_price,
              fo.unit_price orig_price
       FROM substitutions s
       JOIN plan_versions pv ON pv.id=s.version_id
       JOIN areas a ON a.id=s.area_id
       JOIN flowers fo ON fo.id=s.original_flower_id
       JOIN flowers fs ON fs.id=s.substitute_flower_id
       ORDER BY s.id`).all();
    return json(res, 200, rows);
  }
  if (p === '/api/onsite') {
    const areas = dashboard();
    const attempts = db.prepare(
      `SELECT pa.*, a.name area_name, f.name flower_name FROM pickup_attempts pa
       JOIN areas a ON a.id=pa.area_id JOIN flowers f ON f.id=pa.flower_id
       ORDER BY pa.id DESC LIMIT 30`).all();
    const photos = db.prepare(
      `SELECT c.*, a.name area_name FROM completion_photos c
       JOIN areas a ON a.id=c.area_id ORDER BY c.id DESC`).all();
    const additions = db.prepare(
      `SELECT sa.*, a.name area_name, f.name flower_name FROM site_additions sa
       JOIN areas a ON a.id=sa.area_id JOIN flowers f ON f.id=sa.flower_id ORDER BY sa.id`).all();
    const teardowns = db.prepare(
      `SELECT t.*, a.name area_name, f.name flower_name FROM teardowns t
       JOIN areas a ON a.id=t.area_id JOIN flowers f ON f.id=t.flower_id ORDER BY t.id`).all();
    return json(res, 200, { areas, attempts, photos, additions, teardowns });
  }
  if (p === '/api/settlement') return json(res, 200, D.settlement(db));
  if (p === '/api/notifications') {
    return json(res, 200, db.prepare('SELECT * FROM notifications ORDER BY id DESC').all());
  }
  json(res, 404, { error: '未知接口' });
}

async function postApi(req, res, p) {
  const body = await readJson(req);

  if (p === '/api/pickup') {
    const r = D.pickup(db, body);
    if (!r.ok) return json(res, 409, r);
    return json(res, 200, r);
  }
  if (p === '/api/inspect') {
    const b = D.inspectBatch(db, Number(body.batchId), body);
    if (b.qc_status !== '合格') {
      notify({ target: '采购+花艺主管', title: `质检异常 #${b.id}`,
        body: `${db.prepare('SELECT name FROM flowers WHERE id=?').get(b.flower_id).name} 不合格 ${b.rejected_stems} 枝（${b.reject_reason || '未填原因'}）` });
    }
    return json(res, 200, b);
  }
  if (p === '/api/substitution/decide') {
    const r = D.decideSubstitution(db, Number(body.id), body.decision, body.confirmer);
    if (r.status === '已确认') {
      notify({ target: '客户', title: '替代花材已确认',
        body: `替代单#${body.id} 已确认，区域领料已按新配额开放（${r.detail}）` });
    }
    return json(res, r.ok ? 200 : 409, r);
  }
  if (p === '/api/addition') {
    D.addAddition(db, body);
    notify({ target: '花艺主管', title: '现场临时追加',
      body: `${body.crew || '现场组'} 追加 ${body.stems} 枝，已计入区域配额与结算` });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/teardown') {
    D.addTeardown(db, body);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/photo') {
    // body: { areaId, kind, imageBase64, name } 或 { areaId, kind, svg }
    let relPath;
    if (body.svg) {
      relPath = savePhoto(Buffer.from(body.svg, 'utf8'), 'drawing.svg');
    } else if (body.imageBase64) {
      relPath = savePhoto(Buffer.from(body.imageBase64, 'base64'), body.name || 'photo.jpg');
    } else throw new Error('缺少照片内容');
    const id = D.addPhoto(db, { areaId: body.areaId, kind: body.kind, path: relPath });
    return json(res, 200, { ok: true, id, path: relPath });
  }
  if (p === '/api/notify-test') {
    const n = notify({ target: body.target || '测试', title: body.title || '测试通知', body: body.body || 'mock' });
    return json(res, 200, n);
  }
  json(res, 404, { error: '未知接口' });
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`花艺现场系统已启动: http://localhost:${PORT}（数据库 ${DB_PATH}）`);
  });
}

module.exports = { server, db, notify };
