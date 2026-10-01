"""业务服务层：所有库存/版本/授权规则集中在此，HTTP 层与测试共用。

规则摘要：
1. 库存全局共享：可用 = 已验收到货(usable_stems) - 已领料。同一枝数不能被
   两个区域重复占用——领料在 IMMEDIATE 事务内即时扣减校验。
2. 清单按区域做版本管理；客户确认必须落在该区域的最新版本上，旧版本确认报 STALE。
3. 替换必须客户确认（确认关联具体版本）；主视觉区域在未确认前绝不允许用替代花领料。
4. 多组人员的重复领料不抹除，全部按小组留痕；跨小组重复会标记 duplicate 预警。
"""
import sqlite3

from . import db


class ServiceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- 通知适配器

class MockNotifier:
    """模拟适配器：不真正外发，写入 notification 表，页面上可查看。"""

    def send(self, conn, subject, body, to_role="client", ref_type="", ref_id=None):
        cur = conn.execute(
            "INSERT INTO notification(channel,to_role,subject,body,ref_type,ref_id)"
            " VALUES('mock',?,?,?,?,?)",
            (to_role, subject, body, ref_type, ref_id),
        )
        return cur.lastrowid


notifier = MockNotifier()


# ---------------------------------------------------------------- 基础查询

def get_zone(conn, zone_id):
    row = conn.execute("SELECT * FROM zone WHERE id=?", (zone_id,)).fetchone()
    if not row:
        raise ServiceError("ZONE_NOT_FOUND", f"区域 {zone_id} 不存在")
    return row


def latest_manifest(conn, zone_id):
    return conn.execute(
        "SELECT * FROM manifest WHERE zone_id=? ORDER BY version DESC LIMIT 1",
        (zone_id,),
    ).fetchone()


def latest_confirmed_manifest(conn, zone_id):
    """领料与需求口径只认最新的【已确认】版本；未确认草稿不阻断履约。"""
    return conn.execute(
        "SELECT * FROM manifest WHERE zone_id=? AND status='confirmed'"
        " ORDER BY version DESC LIMIT 1",
        (zone_id,),
    ).fetchone()


def quota_rows(conn, manifest_id):
    return conn.execute(
        "SELECT q.*, f.name AS flower_name, f.unit_price"
        " FROM quota q JOIN flower f ON f.id=q.flower_id"
        " WHERE q.manifest_id=? ORDER BY f.name",
        (manifest_id,),
    ).fetchall()


def stock_supply(conn, flower_id):
    """已质检批次的可用枝数（萎蔫/开花/折损批次中保留的好枝同样可入库使用）。"""
    row = conn.execute(
        "SELECT COALESCE(SUM(usable_stems),0) AS n FROM arrival"
        " WHERE flower_id=? AND qc_status!='pending'",
        (flower_id,),
    ).fetchone()
    return row["n"]


def stock_picked(conn, flower_id, zone_id=None):
    sql = "SELECT COALESCE(SUM(stems),0) AS n FROM pick WHERE flower_id=?"
    args = [flower_id]
    if zone_id is not None:
        sql += " AND zone_id=?"
        args.append(zone_id)
    return conn.execute(sql, args).fetchone()["n"]


def stock_available(conn, flower_id):
    return stock_supply(conn, flower_id) - stock_picked(conn, flower_id)


def stock_snapshot(conn):
    """每枝花材的 到货/已领/可用，供配额页与结算页使用。"""
    rows = conn.execute(
        "SELECT f.id, f.name, f.unit_price,"
        " COALESCE((SELECT SUM(usable_stems) FROM arrival a"
        "   WHERE a.flower_id=f.id AND a.qc_status!='pending'),0) AS supply,"
        " COALESCE((SELECT SUM(stems) FROM pick p WHERE p.flower_id=f.id),0) AS picked"
        " FROM flower f ORDER BY f.name"
    ).fetchall()
    return [dict(r, available=r["supply"] - r["picked"]) for r in rows]


# ---------------------------------------------------------------- 清单版本

def create_version(conn, zone_id, items, note=""):
    """items: [(flower_id, stems), ...] 生成新版本，旧版标记 superseded。"""
    get_zone(conn, zone_id)
    for fid, stems in items:
        if stems < 0:
            raise ServiceError("BAD_STEMS", "枝数不能为负")
        if not conn.execute("SELECT 1 FROM flower WHERE id=?", (fid,)).fetchone():
            raise ServiceError("FLOWER_NOT_FOUND", f"花材 {fid} 不存在")
    with db.tx(conn):
        m = latest_manifest(conn, zone_id)
        new_ver = (m["version"] + 1) if m else 1
        # 注意：不在这里作废旧版——已确认版本继续有效，直到新版本被确认。
        cur = conn.execute(
            "INSERT INTO manifest(zone_id,version,status,note) VALUES(?,?,'draft',?)",
            (zone_id, new_ver, note),
        )
        mid = cur.lastrowid
        conn.executemany(
            "INSERT INTO quota(manifest_id,flower_id,stems) VALUES(?,?,?)",
            [(mid, fid, stems) for fid, stems in items],
        )
    return new_ver


def confirm_version(conn, zone_id, version):
    """客户确认清单——只允许确认该区域最新版本，旧版本报 VERSION_STALE。"""
    get_zone(conn, zone_id)
    with db.tx(conn):
        m = conn.execute(
            "SELECT * FROM manifest WHERE zone_id=? AND version=?", (zone_id, version)
        ).fetchone()
        if not m:
            raise ServiceError("VERSION_NOT_FOUND", f"版本 v{version} 不存在")
        latest = latest_manifest(conn, zone_id)
        if latest["id"] != m["id"]:
            raise ServiceError(
                "VERSION_STALE",
                f"v{version} 已过期，当前最新为 v{latest['version']}，请确认最新版本",
            )
        if m["status"] == "confirmed":
            return m  # 幂等
        # 新版本确认时，该区域其余版本（含旧确认版与草稿）统一作废
        conn.execute(
            "UPDATE manifest SET status='superseded' WHERE zone_id=? AND id<>?",
            (zone_id, m["id"]),
        )
        conn.execute(
            "UPDATE manifest SET status='confirmed', confirmed_at=datetime('now','localtime')"
            " WHERE id=?",
            (m["id"],),
        )
        notifier.send(
            conn, f"花材清单 v{version} 已确认",
            f"区域「{get_zone(conn, zone_id)['name']}」清单 v{version} 经客户确认。",
            to_role="team", ref_type="manifest", ref_id=m["id"],
        )
    return conn.execute("SELECT * FROM manifest WHERE id=?", (m["id"],)).fetchone()


def quota_demand_by_flower(conn):
    """各区域【最新已确认】版本对每枝花材的配额需求（占用预算口径）。"""
    rows = conn.execute(
        "SELECT q.flower_id, z.id AS zone_id, z.name AS zone_name, q.stems"
        " FROM manifest m"
        " JOIN quota q ON q.manifest_id=m.id"
        " JOIN zone z ON z.id=m.zone_id"
        " WHERE m.status='confirmed'"
        " AND m.id=(SELECT id FROM manifest WHERE zone_id=z.id AND status='confirmed'"
        "   ORDER BY version DESC LIMIT 1)"
        " ORDER BY q.flower_id, z.id"
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 到货质检

def receive_arrival(conn, flower_id, stems, arrival_date, cold_location):
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO arrival(flower_id,stems,arrival_date,cold_location,qc_status)"
            " VALUES(?,?,?,?,'pending')",
            (flower_id, stems, arrival_date, cold_location),
        )
        return cur.lastrowid


def qc_arrival(conn, arrival_id, status, usable_stems, note=""):
    """status: accepted / wilt / bloom / damage。usable_stems 不得超过到货量。"""
    if status not in ("accepted", "wilt", "bloom", "damage"):
        raise ServiceError("BAD_QC", "质检状态非法")
    with db.tx(conn):
        a = conn.execute("SELECT * FROM arrival WHERE id=?", (arrival_id,)).fetchone()
        if not a:
            raise ServiceError("ARRIVAL_NOT_FOUND", "到货批次不存在")
        if usable_stems < 0 or usable_stems > a["stems"]:
            raise ServiceError("BAD_STEMS",
                               f"可用枝数须在 0~{a['stems']} 之间（实际 {usable_stems}）")
        conn.execute(
            "UPDATE arrival SET qc_status=?, usable_stems=?, qc_note=?,"
            " checked_at=datetime('now','localtime') WHERE id=?",
            (status, usable_stems, note, arrival_id),
        )
        f = conn.execute("SELECT name FROM flower WHERE id=?", (a["flower_id"],)).fetchone()
        label = {"wilt": "到货萎蔫", "bloom": "提前开花",
                 "damage": "运输折损", "accepted": "质检合格"}[status]
        if status != "accepted" and usable_stems < a["stems"]:
            conn.execute(
                "INSERT INTO incident(kind,flower_id,stems,note) VALUES(?,?,?,?)",
                (status, a["flower_id"], a["stems"] - usable_stems,
                 f"批次#{arrival_id} {label}：{note}"),
            )
        notifier.send(
            conn, f"到货质检：{f['name']} {label}",
            f"到货 {a['stems']} 枝，可用 {usable_stems} 枝，冷藏位 {a['cold_location']}。{note}",
            to_role="team", ref_type="arrival", ref_id=arrival_id,
        )


# ---------------------------------------------------------------- 缺货与替换

def propose_substitution(conn, zone_id, original_id, original_stems,
                         substitute_id, substitute_stems, visual_diff):
    """缺货：列出替代花材、价差与视觉差异，等待客户确认。"""
    zone = get_zone(conn, zone_id)
    with db.tx(conn):
        m = latest_manifest(conn, zone_id)
        version = m["version"] if m else 0
        fo = conn.execute("SELECT * FROM flower WHERE id=?", (original_id,)).fetchone()
        fs = conn.execute("SELECT * FROM flower WHERE id=?", (substitute_id,)).fetchone()
        if not fo or not fs:
            raise ServiceError("FLOWER_NOT_FOUND", "花材不存在")
        if original_id == substitute_id:
            raise ServiceError("BAD_SUBSTITUTION", "替代花材不能与原花材相同")
        price_diff = round(
            (fs["unit_price"] * substitute_stems) - (fo["unit_price"] * original_stems), 2)
        cur = conn.execute(
            "INSERT INTO substitution(zone_id,version,original_id,original_stems,"
            "substitute_id,substitute_stems,price_diff,visual_diff,status,hero_blocked)"
            " VALUES(?,?,?,?,?,?,?,?,'pending',?)",
            (zone_id, version, original_id, original_stems,
             substitute_id, substitute_stems, price_diff, visual_diff,
             1 if zone["is_hero"] else 0),
        )
        sid = cur.lastrowid
        notifier.send(
            conn, f"【待客户确认】{zone['name']} 缺货替换提案 #{sid}",
            f"原：{fo['name']} {original_stems} 枝 → 替代：{fs['name']} "
            f"{substitute_stems} 枝；价差 ¥{price_diff:+.2f}；视觉差异：{visual_diff}。"
            f"{'（主视觉区域，未确认不可替换）' if zone['is_hero'] else ''}",
            ref_type="substitution", ref_id=sid,
        )
        return sid, price_diff


def confirm_substitution(conn, sub_id, decision, note=""):
    """客户确认/驳回。decision: confirmed / rejected。确认关联具体清单版本。

    若提案生成后清单又出了新版本，则本提案版本过期，必须重新提案。
    """
    if decision not in ("confirmed", "rejected"):
        raise ServiceError("BAD_DECISION", "决定必须是 confirmed/rejected")
    with db.tx(conn):
        s = conn.execute("SELECT * FROM substitution WHERE id=?", (sub_id,)).fetchone()
        if not s:
            raise ServiceError("SUB_NOT_FOUND", "替换提案不存在")
        if s["status"] != "pending":
            raise ServiceError("SUB_DECIDED", f"提案已有结论：{s['status']}")
        latest = latest_manifest(conn, s["zone_id"])
        latest_ver = latest["version"] if latest else 0
        if decision == "confirmed" and s["version"] != latest_ver:
            raise ServiceError(
                "VERSION_STALE",
                f"提案基于 v{s['version']}，清单已更新到 v{latest_ver}，请按新版本重新提案",
            )
        conn.execute(
            "UPDATE substitution SET status=?, decided_at=datetime('now','localtime'),"
            " decided_version=?, decided_note=? WHERE id=?",
            (decision, latest_ver if decision == "confirmed" else None, note, sub_id),
        )
        z = get_zone(conn, s["zone_id"])
        notifier.send(
            conn, f"替换提案 #{sub_id} 客户已{ '确认' if decision=='confirmed' else '驳回'}",
            f"区域「{z['name']}」（关联清单 v{latest_ver if decision=='confirmed' else s['version']}）。{note}",
            to_role="team", ref_type="substitution", ref_id=sub_id,
        )
        return conn.execute("SELECT * FROM substitution WHERE id=?", (sub_id,)).fetchone()


# ---------------------------------------------------------------- 追加 / 回收 / 异常

def add_adhoc(conn, zone_id, flower_id, stems, reason):
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO ad_hoc_addition(zone_id,flower_id,stems,reason) VALUES(?,?,?,?)",
            (zone_id, flower_id, stems, reason),
        )
        aid = cur.lastrowid
        conn.execute(
            "INSERT INTO incident(kind,zone_id,flower_id,stems,note)"
            " VALUES('addition',?,?,?,?)",
            (zone_id, flower_id, stems, f"临时追加：{reason}"),
        )
        return aid


def recycle_stems(conn, zone_id, flower_id, stems, note):
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO recycle(zone_id,flower_id,stems,note) VALUES(?,?,?,?)",
            (zone_id, flower_id, stems, note),
        )
        conn.execute(
            "INSERT INTO incident(kind,zone_id,flower_id,stems,note)"
            " VALUES('recycle',?,?,?,?)",
            (zone_id, flower_id, stems, f"撤场回收：{note}"),
        )
        return cur.lastrowid


def log_incident(conn, kind, zone_id, flower_id, stems, note):
    with db.tx(conn):
        cur = conn.execute(
            "INSERT INTO incident(kind,zone_id,flower_id,stems,note) VALUES(?,?,?,?,?)",
            (kind, zone_id, flower_id, stems, note),
        )
        return cur.lastrowid


# ---------------------------------------------------------------- 领料（并发关键路径）

def _quota_picked(conn, zone_id, flower_id):
    return conn.execute(
        "SELECT COALESCE(SUM(stems),0) n FROM pick"
        " WHERE zone_id=? AND flower_id=? AND reason='quota'",
        (zone_id, flower_id),
    ).fetchone()["n"]


def pick_stems(conn, zone_id, flower_id, stems, crew, reason="quota", ref_id=None):
    """布置人员按区域领料。

    - quota：花材必须在最新【已确认】版本配额内，且累计不超配额枝数；
    - substitution：必须有客户已确认的替换提案，且不超替代枝数（主视觉区域同此硬性授权）；
    - adhoc：必须有现场追加单。
    最后统一做全局库存占用校验：不足直接回滚，杜绝两区域重复占用同一批枝数。
    多组重复领料不拦截（在配额内），但跨小组自动记 duplicate 预警。
    """
    if stems <= 0:
        raise ServiceError("BAD_STEMS", "领料枝数必须大于 0")
    with db.tx(conn):
        zone = get_zone(conn, zone_id)
        f = conn.execute("SELECT * FROM flower WHERE id=?", (flower_id,)).fetchone()
        if not f:
            raise ServiceError("FLOWER_NOT_FOUND", "花材不存在")

        if reason == "quota":
            m = latest_confirmed_manifest(conn, zone_id)
            if not m:
                raise ServiceError("NO_CONFIRMED_MANIFEST",
                                   f"区域「{zone['name']}」尚无客户确认的清单，不能按配额领料")
            q = conn.execute(
                "SELECT q.* FROM quota q WHERE q.manifest_id=? AND q.flower_id=?",
                (m["id"], flower_id),
            ).fetchone()
            if not q:
                raise ServiceError(
                    "NOT_IN_QUOTA",
                    f"「{f['name']}」不在「{zone['name']}」已确认清单 v{m['version']} 中；"
                    "如需使用请走替换确认或临时追加",
                )
            used = _quota_picked(conn, zone_id, flower_id)
            if used + stems > q["stems"]:
                raise ServiceError(
                    "OVER_QUOTA",
                    f"配额超限：{f['name']} 配额 {q['stems']}，已领 {used}，本次 {stems}",
                )

        elif reason == "substitution":
            s = conn.execute(
                "SELECT * FROM substitution WHERE id=?", (ref_id,)).fetchone()
            if not s:
                raise ServiceError("SUB_NOT_FOUND", "替换提案不存在")
            if s["zone_id"] != zone_id or s["substitute_id"] != flower_id:
                raise ServiceError("SUB_MISMATCH", "领料与替换提案不匹配")
            if s["status"] == "rejected":
                raise ServiceError("SUB_DECIDED", "客户已驳回该替换提案，不能据此领料")
            if s["status"] != "confirmed":
                if zone["is_hero"]:
                    raise ServiceError(
                        "HERO_NOT_AUTHORIZED",
                        "主视觉区域：替换未经客户确认，禁止使用替代花材领料",
                    )
                raise ServiceError("SUB_NOT_CONFIRMED", "替换提案未经客户确认")
            used = conn.execute(
                "SELECT COALESCE(SUM(stems),0) n FROM pick WHERE reason='substitution' AND ref_id=?",
                (ref_id,),
            ).fetchone()["n"]
            if used + stems > s["substitute_stems"]:
                raise ServiceError("OVER_QUOTA",
                                   f"替换授权枝数 {s['substitute_stems']}，已领 {used}")

        elif reason == "adhoc":
            a = conn.execute(
                "SELECT * FROM ad_hoc_addition WHERE id=?", (ref_id,)).fetchone()
            if not a or a["zone_id"] != zone_id or a["flower_id"] != flower_id:
                raise ServiceError("ADHOC_NOT_FOUND", "临时追加单不存在或不匹配")
            used = conn.execute(
                "SELECT COALESCE(SUM(stems),0) n FROM pick WHERE reason='adhoc' AND ref_id=?",
                (ref_id,),
            ).fetchone()["n"]
            if used + stems > a["stems"]:
                raise ServiceError("OVER_QUOTA",
                                   f"追加单枝数 {a['stems']}，已领 {used}")
        else:
            raise ServiceError("BAD_REASON", "领料原因非法")

        # 全局库存占用：同一枝数不能被两个区域重复占用
        if stock_available(conn, flower_id) < stems:
            raise ServiceError(
                "INSUFFICIENT_STOCK",
                f"库存不足：{f['name']} 当前可用 {stock_available(conn, flower_id)} 枝，"
                f"本次申请 {stems} 枝（已被其他区域/领料占用）",
            )

        # 多组人员重复领料留痕 + 预警
        prior = conn.execute(
            "SELECT DISTINCT crew FROM pick WHERE zone_id=? AND flower_id=?",
            (zone_id, flower_id),
        ).fetchall()
        duplicate_warning = None
        other_crews = [p["crew"] for p in prior if p["crew"] != crew]
        if other_crews:
            duplicate_warning = f"该区域此花材已有小组领料：{ '、'.join(other_crews)}"
            conn.execute(
                "INSERT INTO incident(kind,zone_id,flower_id,stems,note)"
                " VALUES('duplicate',?,?,?,?)",
                (zone_id, flower_id, stems,
                 f"小组「{crew}」在 {('、'.join(other_crews))} 之后重复领料"),
            )

        cur = conn.execute(
            "INSERT INTO pick(zone_id,flower_id,stems,crew,reason,ref_id)"
            " VALUES(?,?,?,?,?,?)",
            (zone_id, flower_id, stems, crew, reason, ref_id),
        )
        return cur.lastrowid, duplicate_warning


# ---------------------------------------------------------------- 现场核对

def verify_zone(conn, zone_id, verifier):
    with db.tx(conn):
        get_zone(conn, zone_id)
        conn.execute(
            "UPDATE zone SET verified_at=datetime('now','localtime'), verifier=? WHERE id=?",
            (verifier, zone_id),
        )


def zone_pick_summary(conn, zone_id):
    return conn.execute(
        "SELECT f.id AS flower_id, f.name AS flower_name, f.unit_price,"
        " p.crew, p.reason, COUNT(*) AS times, SUM(p.stems) AS stems"
        " FROM pick p JOIN flower f ON f.id=p.flower_id"
        " WHERE p.zone_id=? GROUP BY f.id, p.crew, p.reason ORDER BY f.name, p.crew",
        (zone_id,),
    ).fetchall()


# ---------------------------------------------------------------- 结算

def settlement(conn):
    zones = conn.execute("SELECT * FROM zone ORDER BY id").fetchall()
    out = []
    grand = {"planned": 0.0, "subs_diff": 0.0, "adhoc": 0.0,
             "picked": 0.0, "recycled": 0.0, "loss": 0}
    for z in zones:
        m = latest_manifest(conn, z["id"])
        planned = 0.0
        planned_rows = []
        if m:
            for q in quota_rows(conn, m["id"]):
                amt = round(q["stems"] * q["unit_price"], 2)
                planned += amt
                planned_rows.append(dict(q, amount=amt))
        subs = conn.execute(
            "SELECT s.*, fo.name AS original_name, fs.name AS substitute_name"
            " FROM substitution s JOIN flower fo ON fo.id=s.original_id"
            " JOIN flower fs ON fs.id=s.substitute_id"
            " WHERE s.zone_id=? AND s.status='confirmed'", (z["id"],),
        ).fetchall()
        subs_diff = round(sum(s["price_diff"] for s in subs), 2)
        adhoc = conn.execute(
            "SELECT a.*, f.name flower_name, f.unit_price,"
            " COALESCE((SELECT SUM(stems) FROM pick p WHERE p.reason='adhoc' AND p.ref_id=a.id),0) picked"
            " FROM ad_hoc_addition a JOIN flower f ON f.id=a.flower_id"
            " WHERE a.zone_id=?", (z["id"],),
        ).fetchall()
        adhoc_amt = round(sum(a["stems"] * a["unit_price"] for a in adhoc), 2)
        picked_rows = conn.execute(
            "SELECT f.name flower_name, f.unit_price, SUM(p.stems) stems"
            " FROM pick p JOIN flower f ON f.id=p.flower_id"
            " WHERE p.zone_id=? GROUP BY f.id", (z["id"],),
        ).fetchall()
        picked_amt = round(sum(r["stems"] * r["unit_price"] for r in picked_rows), 2)
        rec = conn.execute(
            "SELECT COALESCE(SUM(stems),0) n FROM recycle WHERE zone_id=?", (z["id"],),
        ).fetchone()["n"]
        loss = conn.execute(
            "SELECT COALESCE(SUM(stems),0) n FROM incident"
            " WHERE zone_id=? AND kind IN ('wilt','bloom','damage')", (z["id"],),
        ).fetchone()["n"]
        total = round(planned + subs_diff + adhoc_amt, 2)
        out.append(dict(zone=dict(z), version=m["version"] if m else None,
                        manifest_status=m["status"] if m else None,
                        planned_rows=planned_rows, planned=round(planned, 2),
                        substitutions=[dict(s) for s in subs], subs_diff=subs_diff,
                        adhoc=[dict(a) for a in adhoc], adhoc_amt=adhoc_amt,
                        picked_amt=picked_amt, recycled=rec, loss=loss, total=total))
        grand["planned"] += round(planned, 2)
        grand["subs_diff"] += subs_diff
        grand["adhoc"] += adhoc_amt
        grand["picked"] += picked_amt
        grand["recycled"] += rec
        grand["loss"] += loss
    grand["total"] = round(grand["planned"] + grand["subs_diff"] + grand["adhoc"], 2)
    grand["qc_loss"] = conn.execute(
        "SELECT COALESCE(SUM(stems-usable_stems),0) n FROM arrival"
        " WHERE qc_status IN ('wilt','bloom','damage')"
    ).fetchone()["n"]
    return {"zones": out, "grand": grand}
