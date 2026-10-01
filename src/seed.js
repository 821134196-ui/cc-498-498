'use strict';
// 种子数据：一条命令重建本地库，写入缺货（萎蔫/提前开花/折损）、替代单、临时追加、重复领料拦截等样例
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const D = require('./domain');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PHOTO = path.join(DATA, 'photos');
const DB_PATH = process.env.FLORAL_DB || path.join(DATA, 'floral.db');

fs.rmSync(DB_PATH, { force: true });
fs.mkdirSync(PHOTO, { recursive: true });
for (const f of fs.readdirSync(PHOTO)) fs.rmSync(path.join(PHOTO, f), { force: true });

const db = open(DB_PATH);
const t = () => '2026-09-28T09:00:00.000Z';

// ---------- 本地 SVG 效果图 ----------
function svgBouquet(title, colors, subtitle = '') {
  const dots = colors.map((c, i) => {
    const a = (i / colors.length) * Math.PI * 2;
    const cx = 200 + Math.cos(a) * (55 + (i % 2) * 26);
    const cy = 150 + Math.sin(a) * (48 + (i % 3) * 14);
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${26 + (i % 3) * 5}"
      fill="${c}" stroke="#3f6b49" stroke-width="2"/>
      <circle cx="${(cx - 8).toFixed(0)}" cy="${(cy - 8).toFixed(0)}" r="6" fill="#ffffff" opacity="0.55"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#f7faf6"/>
  <path d="M200 150 C196 200 190 240 176 280 L224 280 C210 240 204 200 200 150Z" fill="#5a8f5e"/>
  <ellipse cx="170" cy="220" rx="26" ry="10" fill="#7caf78" transform="rotate(-28 170 220)"/>
  <ellipse cx="232" cy="234" rx="26" ry="10" fill="#7caf78" transform="rotate(26 232 234)"/>
  ${dots}
  <rect x="0" y="0" width="400" height="44" fill="#3f6b49"/>
  <text x="16" y="29" font-family="sans-serif" font-size="19" fill="#ffffff">${title}</text>
  <text x="384" y="29" text-anchor="end" font-family="sans-serif" font-size="13" fill="#d9ecdc">效果图</text>
  ${subtitle ? `<text x="16" y="280" font-family="sans-serif" font-size="13" fill="#5a6b5d">${subtitle}</text>` : ''}
</svg>`;
}
let photoSeq = 0;
function saveSvg(name, svg) {
  const rel = `/photos/${name}`;
  fs.writeFileSync(path.join(PHOTO, name), svg, 'utf8');
  return rel;
}
const refPhoto = (title, colors, sub) =>
  saveSvg(`ref-${++photoSeq}.svg`, svgBouquet(title, colors, sub));
const comparePhoto = (tag, title, colors, sub) =>
  saveSvg(`cmp-${tag}-${++photoSeq}.svg`, svgBouquet(title, colors, sub));

// ---------- 花材 ----------
const flowers = [
  ['rose-w', '白玫瑰', '纯白', 12],
  ['rose-c', '珊瑚玫瑰', '珊瑚粉', 15],
  ['euca', '尤加利叶', '叶绿', 4],
  ['hyd-w', '白绣球', '奶白', 10],
  ['tulip-w', '白郁金香', '象牙白', 9],
  ['peony', '白粉芍药', '白粉', 18],
  ['carn-w', '白康乃馨', '米白', 8],
  ['daisy-w', '白雏菊', '白心黄蕊', 5],
  ['carn-p', '粉康乃馨', '柔粉', 6],
];
const insF = db.prepare('INSERT INTO flowers(id,name,color,unit_price) VALUES(?,?,?,?)');
flowers.forEach(f => insF.run(...f));

// ---------- 区域（平面图坐标，viewBox 1000×520）----------
const areas = [
  ['arch', '仪式花门', 1, 30, 50, 230, 420, '主视觉：全场花量最密，替换必须客户确认'],
  ['aisle', '仪式通道', 0, 300, 50, 280, 420, '两侧路引 ×8'],
  ['reception', '签到区', 0, 620, 50, 350, 190, '签到台 + 迎宾牌花艺'],
  ['tables', '宴会主桌', 0, 620, 280, 350, 190, '主桌花 + 桌花点缀'],
];
const insA = db.prepare('INSERT INTO areas(id,name,is_hero,x,y,w,h,note) VALUES(?,?,?,?,?,?,?,?)');
areas.forEach(a => insA.run(...a));

// ---------- V1 清单（初稿）----------
D.publishVersion(db, {
  id: 'v1', label: 'V1 · 09-25 初稿', note: '初版花量，客户要求花门加密',
  lines: [
    { areaId: 'arch', flowerId: 'rose-w', stems: 260, refPhoto: refPhoto('花门·白玫瑰', ['#ffffff', '#f3e9e4']) },
    { areaId: 'arch', flowerId: 'rose-c', stems: 120, refPhoto: refPhoto('花门·珊瑚玫瑰', ['#ff8a76', '#f2705c']) },
    { areaId: 'arch', flowerId: 'euca', stems: 150, refPhoto: refPhoto('花门·尤加利', ['#7caf78', '#5a8f5e']) },
    { areaId: 'arch', flowerId: 'hyd-w', stems: 80, refPhoto: refPhoto('花门·白绣球', ['#fbfdf9', '#eef3ea']) },
    { areaId: 'aisle', flowerId: 'tulip-w', stems: 160, refPhoto: refPhoto('通道·白郁金香', ['#fffaf0', '#f6eedd']) },
    { areaId: 'aisle', flowerId: 'euca', stems: 60, refPhoto: refPhoto('通道·尤加利', ['#7caf78']) },
    { areaId: 'aisle', flowerId: 'rose-c', stems: 40, refPhoto: refPhoto('通道·珊瑚玫瑰', ['#ff8a76']) },
    { areaId: 'reception', flowerId: 'peony', stems: 60, refPhoto: refPhoto('签到·芍药', ['#f7d9e2', '#fff1f5']) },
    { areaId: 'reception', flowerId: 'rose-w', stems: 40, refPhoto: refPhoto('签到·白玫瑰', ['#ffffff']) },
    { areaId: 'reception', flowerId: 'hyd-w', stems: 30, refPhoto: refPhoto('签到·白绣球', ['#fbfdf9']) },
    { areaId: 'tables', flowerId: 'peony', stems: 80, refPhoto: refPhoto('主桌·芍药', ['#f7d9e2']) },
    { areaId: 'tables', flowerId: 'rose-w', stems: 80, refPhoto: refPhoto('主桌·白玫瑰', ['#ffffff']) },
    { areaId: 'tables', flowerId: 'rose-c', stems: 30, refPhoto: refPhoto('主桌·珊瑚玫瑰', ['#ff8a76']) },
  ],
});

// 挂在 V1 上的替代单：V2 发布后再确认即"版本过期"
db.prepare(
  `INSERT INTO substitutions(version_id,area_id,original_flower_id,substitute_flower_id,
    shortfall_stems,price_delta,visual_diff,before_photo,after_photo,status,created_at)
   VALUES('v1','arch','rose-w','carn-w',40,-4,
   '花型更小、花瓣更密，近看层次弱于玫瑰；米白色调与白玫瑰接近，花门远观饱满度约降一成。',
   ?,?, '待客户确认', ?)`)
  .run(
    comparePhoto('v1-before', '替换前：白玫瑰 ×40', ['#ffffff', '#f3e9e4'], '花门局部'),
    comparePhoto('v1-after', '替换后：白康乃馨 ×40', ['#f6efe4', '#fffdf6'], '花门局部'),
    t());

// ---------- V2 清单（当前版本，花门白玫瑰调减）----------
D.publishVersion(db, {
  id: 'v2', label: 'V2 · 09-28 修订', note: '花门白玫瑰 260→220，余枝补主桌；当前执行版本',
  lines: [
    { areaId: 'arch', flowerId: 'rose-w', stems: 220, refPhoto: refPhoto('花门·白玫瑰 V2', ['#ffffff', '#f3e9e4']) },
    { areaId: 'arch', flowerId: 'rose-c', stems: 120, refPhoto: refPhoto('花门·珊瑚玫瑰 V2', ['#ff8a76', '#f2705c']) },
    { areaId: 'arch', flowerId: 'euca', stems: 150, refPhoto: refPhoto('花门·尤加利 V2', ['#7caf78', '#5a8f5e']) },
    { areaId: 'arch', flowerId: 'hyd-w', stems: 80, refPhoto: refPhoto('花门·白绣球 V2', ['#fbfdf9', '#eef3ea']) },
    { areaId: 'aisle', flowerId: 'tulip-w', stems: 160, refPhoto: refPhoto('通道·白郁金香 V2', ['#fffaf0']) },
    { areaId: 'aisle', flowerId: 'euca', stems: 60, refPhoto: refPhoto('通道·尤加利 V2', ['#7caf78']) },
    { areaId: 'aisle', flowerId: 'rose-c', stems: 40, refPhoto: refPhoto('通道·珊瑚玫瑰 V2', ['#ff8a76']) },
    { areaId: 'reception', flowerId: 'peony', stems: 60, refPhoto: refPhoto('签到·芍药 V2', ['#f7d9e2', '#fff1f5']) },
    { areaId: 'reception', flowerId: 'rose-w', stems: 40, refPhoto: refPhoto('签到·白玫瑰 V2', ['#ffffff']) },
    { areaId: 'reception', flowerId: 'hyd-w', stems: 30, refPhoto: refPhoto('签到·白绣球 V2', ['#fbfdf9']) },
    { areaId: 'tables', flowerId: 'peony', stems: 80, refPhoto: refPhoto('主桌·芍药 V2', ['#f7d9e2']) },
    { areaId: 'tables', flowerId: 'rose-w', stems: 80, refPhoto: refPhoto('主桌·白玫瑰 V2', ['#ffffff']) },
    { areaId: 'tables', flowerId: 'rose-c', stems: 30, refPhoto: refPhoto('主桌·珊瑚玫瑰 V2', ['#ff8a76']) },
  ],
});

// ---------- 到货批次（到货日 / 冷藏 / 质检）----------
const batch = (flowerId, date, stems, loc, qc, acc, rej, reason) =>
  db.prepare(
    `INSERT INTO arrival_batches(flower_id,arrive_date,stems,cold_location,qc_status,
      accepted_stems,rejected_stems,reject_reason,inspected_at)
     VALUES(?,?,?,?,?,?,?,?,?)`)
  .run(flowerId, date, stems, loc, qc, acc, rej, reason, qc === '待检' ? null : t());

batch('rose-w', '2026-09-28', 340, '冷库 A-01', '部分合格', 300, 40, '到货萎蔫：下层箱闷捂，40 枝花瓣发软');
batch('rose-c', '2026-09-28', 190, '冷库 A-02', '部分合格', 170, 20, '运输折损：箱内挤压断枝 20 枝');
batch('euca', '2026-09-28', 210, '冷库 B-01', '合格', 210, 0, null);
batch('hyd-w', '2026-09-28', 110, '冷库 B-02', '部分合格', 70, 40, '运输折损：绣球脱水压伤 40 枝');
batch('tulip-w', '2026-09-29', 160, '冷库 C-01', '合格', 160, 0, null);
batch('peony', '2026-09-29', 140, '冷库 C-02', '部分合格', 110, 30, '提前开花：30 枝已绽开，撑不到正日');
// 替代花材备货 + 一批待检（留给质检页操作）
batch('carn-w', '2026-09-29', 60, '冷库 D-01', '合格', 60, 0, null);
batch('daisy-w', '2026-09-29', 60, '冷库 D-02', '合格', 60, 0, null);
batch('carn-p', '2026-09-30', 40, '冷库 D-03', '合格', 40, 0, null);
batch('peony', '2026-09-30', 50, '冷库 C-03', '待检', 0, 0, null);

// ---------- 当前版本上的替代单 ----------
// 花门（主视觉）白玫瑰缺 40 → 白康乃馨，待客户确认：未确认前领料会被拒
db.prepare(
  `INSERT INTO substitutions(version_id,area_id,original_flower_id,substitute_flower_id,
    shortfall_stems,price_delta,visual_diff,before_photo,after_photo,status,created_at)
   VALUES('v2','arch','rose-w','carn-w',40,-4,
   '康乃馨花径约小 2cm，花心更平；米白与纯白在花门绿植背景下差异很小，远观一致、近看少一点丝绒感。每枝省 4 元，合计省 160 元。',
   ?,?, '待客户确认', ?)`)
  .run(
    comparePhoto('before', '替换前 · 白玫瑰 40 枝', ['#ffffff', '#f3e9e4'], '主视觉花门 · 局部'),
    comparePhoto('after', '替换后 · 白康乃馨 40 枝', ['#f6efe4', '#fffdf6'], '主视觉花门 · 局部'),
    t());

// 花门（主视觉）白绣球缺 40 → 白雏菊，待客户确认
db.prepare(
  `INSERT INTO substitutions(version_id,area_id,original_flower_id,substitute_flower_id,
    shortfall_stems,price_delta,visual_diff,before_photo,after_photo,status,created_at)
   VALUES('v2','arch','hyd-w','daisy-w',40,-5,
   '雏菊体量明显小于绣球，需多簇成团才能补形；白绿调一致但蓬松感下降，建议只填花门下沿暗位。每枝省 5 元，合计省 200 元。',
   ?,?, '待客户确认', ?)`)
  .run(
    comparePhoto('before', '替换前 · 白绣球 40 枝', ['#fbfdf9', '#eef3ea'], '主视觉花门 · 下沿'),
    comparePhoto('after', '替换后 · 白雏菊 40 枝', ['#ffffff', '#f6e7b8'], '主视觉花门 · 下沿'),
    t());

// 签到区芍药缺 30 → 粉康乃馨，客户已确认（可直接领料）
db.prepare(
  `INSERT INTO substitutions(version_id,area_id,original_flower_id,substitute_flower_id,
    shortfall_stems,price_delta,visual_diff,before_photo,after_photo,status,confirmer,decided_at,created_at)
   VALUES('v2','reception','peony','carn-p',30,-12,
   '柔粉色调接近，花瓣更挺括；签到台为近距离观看，花径小一号但成团后饱满，客户已接受。每枝省 12 元，合计省 360 元。',
   ?,?, '已确认','客户（林小姐）',?, ?)`)
  .run(
    comparePhoto('before', '替换前 · 白粉芍药 30 枝', ['#f7d9e2', '#fff1f5'], '签到台'),
    comparePhoto('after', '替换后 · 粉康乃馨 30 枝', ['#f5c4d4', '#fdeef3'], '签到台'),
    t(), t());

// ---------- 现场临时追加 ----------
db.prepare(
  `INSERT INTO site_additions(area_id,flower_id,stems,reason,approved,created_at)
   VALUES('reception','rose-w',10,'迎宾牌新增一角花艺，现场主管批准',1,?)`).run(t());

// ---------- 已有领料 + 留痕（含被拦截的尝试）----------
const pick = (areaId, flowerId, stems, crew) =>
  D.pickup(db, { areaId, flowerId, stems, crew });

// 花艺一组：花门按配额领走白玫瑰（220 全部领满）
pick('arch', 'rose-w', 220, '花艺一组');
pick('arch', 'rose-c', 120, '花艺一组');
pick('arch', 'euca', 150, '花艺一组');
pick('arch', 'hyd-w', 60, '花艺一组'); // 绣球全场合格仅 70，先领 60
// 花艺二组不知花门已领满，再领 30 枝白玫瑰 → 重复领料拦截
pick('arch', 'rose-w', 30, '花艺二组');
// 二组想直接上未确认的替代花材（主视觉）→ 未授权替换拦截
pick('arch', 'carn-w', 40, '花艺二组');
pick('arch', 'daisy-w', 40, '花艺二组');

// 通道全部领齐
pick('aisle', 'tulip-w', 160, '花艺三组');
pick('aisle', 'euca', 60, '花艺三组');
pick('aisle', 'rose-c', 40, '花艺三组');

// 签到区：芍药配额经替代后 30，粉康乃馨 30（已确认替代），白玫瑰 40，绣球仅剩 10
pick('reception', 'peony', 30, '花艺二组');
pick('reception', 'carn-p', 30, '花艺二组');
pick('reception', 'rose-w', 40, '花艺二组');
pick('reception', 'hyd-w', 10, '花艺二组');
pick('reception', 'hyd-w', 20, '花艺二组'); // 全场绣球已空 → 库存不足

// 主桌：白玫瑰合格库存还剩 40（300-220-40），先领 40，再领被库存拦下
pick('tables', 'rose-w', 40, '花艺三组');
pick('tables', 'rose-w', 40, '花艺三组');
// 珊瑚玫瑰：合格 170，花门 120 + 通道 40 = 160，仅剩 10 → 主桌 30 枝领不出
pick('tables', 'rose-c', 30, '花艺三组');

// 通道完工照片（现场核对页样例）
const doneSvg = saveSvg(`done-${++photoSeq}.svg`,
  svgBouquet('仪式通道 · 完工照', ['#fffaf0', '#7caf78', '#ff8a76'], '花艺三组 上传'));
db.prepare(
  'INSERT INTO completion_photos(area_id,kind,path,uploaded_at) VALUES(?,?,?,?)')
  .run('aisle', '完工', doneSvg, t());

const blocked = db.prepare(
  `SELECT result, COUNT(*) n FROM pickup_attempts WHERE result!='成功' GROUP BY result`).all();
console.log('种子完成 →', DB_PATH);
console.log('被拦截领料:', blocked.map(b => `${b.result}×${b.n}`).join('，'));
console.log('启动: npm start  →  http://localhost:3000');
