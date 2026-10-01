'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 花材主数据：品种、颜色、单价（元/枝）
CREATE TABLE IF NOT EXISTS flowers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  unit_price REAL NOT NULL CHECK (unit_price >= 0)
);

-- 婚礼区域（含平面图坐标，is_hero=1 为主视觉区域）
CREATE TABLE IF NOT EXISTS areas (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  is_hero INTEGER NOT NULL DEFAULT 0,
  x       REAL NOT NULL,
  y       REAL NOT NULL,
  w       REAL NOT NULL,
  h       REAL NOT NULL,
  note    TEXT
);

-- 清单版本（客户确认必须关联具体版本）
CREATE TABLE IF NOT EXISTS plan_versions (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);

-- 版本内的区域花材清单行 + 对应效果图
CREATE TABLE IF NOT EXISTS plan_lines (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES plan_versions(id),
  area_id   TEXT NOT NULL REFERENCES areas(id),
  flower_id TEXT NOT NULL REFERENCES flowers(id),
  stems     INTEGER NOT NULL CHECK (stems > 0),
  ref_photo TEXT,
  UNIQUE (version_id, area_id, flower_id)
);

-- 到货批次：到货日、枝数、冷藏位置；质检后拆分合格/不合格
CREATE TABLE IF NOT EXISTS arrival_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  flower_id      TEXT NOT NULL REFERENCES flowers(id),
  arrive_date    TEXT NOT NULL,
  stems          INTEGER NOT NULL CHECK (stems > 0),
  cold_location  TEXT,
  qc_status      TEXT NOT NULL DEFAULT '待检',   -- 待检/合格/部分合格/不合格
  accepted_stems INTEGER NOT NULL DEFAULT 0,
  rejected_stems INTEGER NOT NULL DEFAULT 0,
  reject_reason  TEXT,                            -- 到货萎蔫/提前开花/运输折损
  inspected_at   TEXT
);

-- 缺货替代单：替代花材、每枝价差、视觉差异、前后照片
CREATE TABLE IF NOT EXISTS substitutions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id           TEXT NOT NULL REFERENCES plan_versions(id),
  area_id              TEXT NOT NULL REFERENCES areas(id),
  original_flower_id   TEXT NOT NULL REFERENCES flowers(id),
  substitute_flower_id TEXT NOT NULL REFERENCES flowers(id),
  shortfall_stems      INTEGER NOT NULL CHECK (shortfall_stems > 0),
  price_delta          REAL NOT NULL,   -- 每枝价差（替代-原），正=加价，负=降价
  visual_diff          TEXT NOT NULL,
  before_photo         TEXT,
  after_photo          TEXT,
  status               TEXT NOT NULL DEFAULT '待客户确认',
  -- 待客户确认/已确认/已拒绝/版本过期
  confirmer            TEXT,            -- 客户 / 现场负责人
  decided_at           TEXT,
  created_at           TEXT NOT NULL
);

-- 现场临时追加（占用同一花材预算）
CREATE TABLE IF NOT EXISTS site_additions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id    TEXT NOT NULL REFERENCES areas(id),
  flower_id TEXT NOT NULL REFERENCES flowers(id),
  stems      INTEGER NOT NULL CHECK (stems > 0),
  reason     TEXT,
  approved   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 成功领料记录
CREATE TABLE IF NOT EXISTS pickup_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id    TEXT NOT NULL REFERENCES areas(id),
  flower_id  TEXT NOT NULL REFERENCES flowers(id),
  stems      INTEGER NOT NULL CHECK (stems > 0),
  crew       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 全部领料尝试：成功、超配额、多组重复领料、未授权替换等都留痕
CREATE TABLE IF NOT EXISTS pickup_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id    TEXT NOT NULL REFERENCES areas(id),
  flower_id  TEXT NOT NULL REFERENCES flowers(id),
  stems      INTEGER NOT NULL,
  crew       TEXT NOT NULL,
  result     TEXT NOT NULL, -- 成功/超配额/重复领料/未授权替换/版本过期/库存不足
  detail     TEXT,
  created_at TEXT NOT NULL
);

-- 完工 / 现场核对 / 撤场照片（本地保存）
CREATE TABLE IF NOT EXISTS completion_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id     TEXT NOT NULL REFERENCES areas(id),
  kind        TEXT NOT NULL,  -- 完工/核对/撤场
  path        TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

-- 撤场回收
CREATE TABLE IF NOT EXISTS teardowns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id        TEXT NOT NULL REFERENCES areas(id),
  flower_id      TEXT NOT NULL REFERENCES flowers(id),
  stems_recovered INTEGER NOT NULL CHECK (stems_recovered >= 0),
  condition      TEXT,        -- 完好可复用/折损报废
  created_at     TEXT NOT NULL
);

-- 模拟通知适配器落库
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL DEFAULT 'mock-sms',
  target     TEXT,
  title      TEXT,
  body       TEXT,
  status     TEXT NOT NULL DEFAULT '已发送',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_version ON plan_lines(version_id);
CREATE INDEX IF NOT EXISTS idx_batches_flower ON arrival_batches(flower_id);
CREATE INDEX IF NOT EXISTS idx_pickup_area ON pickup_records(area_id);
`;

function open(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { open, SCHEMA };
