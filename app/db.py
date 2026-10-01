"""SQLite schema and connection helpers.

库存（某一花材品种的同一批枝数）是全局共享资源，区域配额与领料记录
占用同一库存，绝不允许两个区域重复占用——占用量在事务内即时校验。
所有客户确认都关联具体的清单版本号。
"""
import os
import sqlite3
import threading
from contextlib import contextmanager

DB_PATH = os.environ.get("FLORAL_DB", os.path.join(os.path.dirname(__file__), "..", "data", "floral.db"))
DB_PATH = os.path.abspath(DB_PATH)

_lock = threading.Lock()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 婚礼区域
CREATE TABLE IF NOT EXISTS zone (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,          -- 主舞台 / 迎宾区 ...
    is_hero     INTEGER NOT NULL DEFAULT 0,    -- 主视觉区域：未经确认不能替换
    floor_x     REAL NOT NULL DEFAULT 0,       -- 平面图坐标（百分比）
    floor_y     REAL NOT NULL DEFAULT 0,
    floor_w     REAL NOT NULL DEFAULT 0,
    floor_h     REAL NOT NULL DEFAULT 0,
    verified_at TEXT,                          -- 现场核对完成时间
    verifier    TEXT DEFAULT '',
    note        TEXT DEFAULT ''
);

-- 花材品种（库存全局共享）
CREATE TABLE IF NOT EXISTS flower (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,          -- 白玫瑰
    unit_price  REAL NOT NULL DEFAULT 0        -- 单价/枝
);

-- 花材清单 = 版本头。客户确认关联具体版本。
CREATE TABLE IF NOT EXISTS manifest (
    id          INTEGER PRIMARY KEY,
    zone_id     INTEGER NOT NULL REFERENCES zone(id),
    version     INTEGER NOT NULL,              -- 从 1 递增
    status      TEXT NOT NULL DEFAULT 'draft', -- draft / confirmed / superseded
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    confirmed_at TEXT,
    note        TEXT DEFAULT '',
    UNIQUE(zone_id, version)
);

-- 清单明细（版本化配额）：某区域某版本对某花材的计划枝数
CREATE TABLE IF NOT EXISTS quota (
    id          INTEGER PRIMARY KEY,
    manifest_id INTEGER NOT NULL REFERENCES manifest(id) ON DELETE CASCADE,
    flower_id   INTEGER NOT NULL REFERENCES flower(id),
    stems       INTEGER NOT NULL CHECK(stems >= 0),
    UNIQUE(manifest_id, flower_id)
);

-- 到货批次（收货 + 质检状态）
CREATE TABLE IF NOT EXISTS arrival (
    id          INTEGER PRIMARY KEY,
    flower_id   INTEGER NOT NULL REFERENCES flower(id),
    stems       INTEGER NOT NULL,              -- 到货枝数
    arrival_date TEXT NOT NULL,                -- 到货日
    cold_location TEXT DEFAULT '',             -- 冷藏位置 A1/B2 ...
    qc_status   TEXT NOT NULL DEFAULT 'pending', -- pending / accepted / wilt / bloom / damage
    qc_note     TEXT DEFAULT '',
    checked_at  TEXT,
    usable_stems INTEGER NOT NULL DEFAULT 0    -- 验收后可用枝数（折损后）
);

-- 现场临时追加（同样占用库存）
CREATE TABLE IF NOT EXISTS ad_hoc_addition (
    id          INTEGER PRIMARY KEY,
    zone_id     INTEGER NOT NULL REFERENCES zone(id),
    flower_id   INTEGER NOT NULL REFERENCES flower(id),
    stems       INTEGER NOT NULL,
    reason      TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 缺货 / 替换提案：列出替代花材、价差、视觉差异供客户确认
CREATE TABLE IF NOT EXISTS substitution (
    id            INTEGER PRIMARY KEY,
    zone_id       INTEGER NOT NULL REFERENCES zone(id),
    version       INTEGER NOT NULL,             -- 发起时的清单版本
    original_id   INTEGER NOT NULL REFERENCES flower(id),
    original_stems INTEGER NOT NULL,
    substitute_id INTEGER NOT NULL REFERENCES flower(id),
    substitute_stems INTEGER NOT NULL,
    price_diff    REAL NOT NULL,                -- (替代单价-原单价)*替代枝数
    visual_diff   TEXT DEFAULT '',              -- 视觉差异说明
    status        TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / rejected
    hero_blocked  INTEGER NOT NULL DEFAULT 0,   -- 主视觉区域锁定标记
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    decided_at    TEXT,
    decided_version INTEGER,                    -- 客户确认时锁定的版本（版本过期检测）
    decided_note  TEXT DEFAULT ''
);

-- 领料：布置人员按区域领料；多组人员重复领料全部留痕
CREATE TABLE IF NOT EXISTS pick (
    id          INTEGER PRIMARY KEY,
    zone_id     INTEGER NOT NULL REFERENCES zone(id),
    flower_id   INTEGER NOT NULL REFERENCES flower(id),
    stems       INTEGER NOT NULL,
    crew        TEXT DEFAULT '未署名小组',
    reason      TEXT DEFAULT 'quota',           -- quota / substitution / adhoc
    ref_id      INTEGER,                        -- substitution.id 或 ad_hoc_addition.id
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 现场异常：萎蔫 / 提前开花 / 运输折损 / 追加 / 回收（均可记录）
CREATE TABLE IF NOT EXISTS incident (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,                  -- wilt/bloom/damage/addition/recycle/duplicate
    zone_id     INTEGER REFERENCES zone(id),
    flower_id   INTEGER REFERENCES flower(id),
    stems       INTEGER NOT NULL DEFAULT 0,
    note        TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 撤场回收
CREATE TABLE IF NOT EXISTS recycle (
    id          INTEGER PRIMARY KEY,
    zone_id     INTEGER NOT NULL REFERENCES zone(id),
    flower_id   INTEGER NOT NULL REFERENCES flower(id),
    stems       INTEGER NOT NULL,
    note        TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 本地照片（效果图 / 完工照 / 替换前后 / 质检照）
CREATE TABLE IF NOT EXISTS photo (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,                  -- reference/completion/before/after/qc
    zone_id     INTEGER REFERENCES zone(id),
    ref_id      INTEGER,                        -- arrival / substitution / zone
    path        TEXT NOT NULL,                  -- uploads 下相对路径
    label       TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 模拟通知适配器：不真正外发，只落库
CREATE TABLE IF NOT EXISTS notification (
    id          INTEGER PRIMARY KEY,
    channel     TEXT NOT NULL DEFAULT 'mock',
    to_role     TEXT DEFAULT 'client',          -- client / team
    subject     TEXT DEFAULT '',
    body        TEXT DEFAULT '',
    ref_type    TEXT DEFAULT '',                -- substitution / arrival ...
    ref_id      INTEGER,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    read_flag   INTEGER NOT NULL DEFAULT 0
);
"""


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


@contextmanager
def tx(conn):
    """串行化事务：应用级锁 + IMMEDIATE，保证并发领料下库存占用一致。"""
    _lock.acquire()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        _lock.release()


def init_db():
    conn = connect()
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
    print("db initialized:", DB_PATH)
