"""种子数据：一条启动命令即载入缺货、临时追加等样例。

用法：python3 -m app.seed            # 重建数据库并写入样例
     python3 -m app.seed --keep     # 仅在空库时写入
"""
import os
import shutil
import sys

from . import db, service

UPLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"))

# 配色：白 / 叶绿 / 珊瑚
PALETTE = {
    "white": "#FFFFFF",
    "leaf": "#5C8A4E",
    "coral": "#FF7F6B",
    "ink": "#33402F",
    "soft": "#EAF2E4",
    "sand": "#F6F2EC",
}


def _svg(path, title, primary, secondary, stems_note="", badge=""):
    """生成一张轻量 SVG 效果图/对比图，本地保存，避免二进制依赖。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cx, cy, r = 160, 105, 34
    flowers = ""
    pts = [(cx, cy), (cx - 46, cy + 18), (cx + 46, cy + 14),
           (cx - 20, cy - 42), (cx + 24, cy - 38), (cx, cy + 52)]
    for i, (x, y) in enumerate(pts):
        col = primary if i % 2 == 0 else secondary
        flowers += f'<circle cx="{x}" cy="{y}" r="{r-7}" fill="{col}" opacity="0.9"/>'
        flowers += f'<circle cx="{x}" cy="{y}" r="10" fill="{PALETTE["leaf"]}"/>'
    stems_svg = ""
    for x, y in pts:
        stems_svg += f'<path d="M{x} {y+20} Q{x-6} 200 {x} 230" stroke="{PALETTE["leaf"]}" stroke-width="4" fill="none"/>'
    badge_svg = f'<rect x="200" y="14" width="106" height="30" rx="15" fill="{PALETTE["coral"]}"/><text x="253" y="34" text-anchor="middle" font-size="15" fill="#fff" font-weight="700">{badge}</text>' if badge else ""
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="320" height="260" viewBox="0 0 320 260" font-family="sans-serif">
  <rect width="320" height="260" fill="{PALETTE["sand"]}"/>
  {badge_svg}
  <text x="18" y="34" font-size="17" font-weight="700" fill="{PALETTE["ink"]}">{title}</text>
  {stems_svg}{flowers}
  <text x="18" y="250" font-size="13" fill="{PALETTE["leaf"]}">{stems_note}</text>
</svg>'''
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(svg)


def _add_photo(conn, kind, zone_id, ref_id, rel, label):
    conn.execute(
        "INSERT INTO photo(kind,zone_id,ref_id,path,label) VALUES(?,?,?,?,?)",
        (kind, zone_id, ref_id, f"uploads/{rel}", label))


ZONES = [
    # name, is_hero, x,y,w,h
    ("主舞台",     1, 30, 12, 40, 40),
    ("迎宾签到区", 0, 6,  18, 20, 26),
    ("仪式拱门",   0, 74, 18, 20, 30),
    ("宴会主桌",   0, 20, 62, 30, 26),
    ("宾客通道",   0, 58, 60, 34, 14),
]

FLOWERS = [
    # name, price
    ("白玫瑰", 8.0),
    ("白牡丹", 12.0),
    ("尤加利叶", 3.5),
    ("珊瑚康乃馨", 6.0),
    ("粉芍药", 15.0),
    ("香槟玫瑰", 7.5),
    ("满天星", 2.0),
    ("龟背竹叶", 4.0),
]

# 各区域 v1 配额 flower_index: stems
MANIFESTS = {
    "主舞台":     {0: 120, 1: 40, 2: 60, 3: 30},
    "迎宾签到区": {0: 40, 2: 30, 6: 20},
    "仪式拱门":   {0: 80, 1: 20, 2: 50},
    "宴会主桌":   {6: 60, 5: 50, 2: 24, 3: 20},
    "宾客通道":   {2: 40, 6: 30},
}

ARRIVALS = [
    # flower_idx, stems, date, cold, qc, usable, note
    (0, 260, "2026-09-28", "A1-01", "accepted", 260, ""),
    (1, 50,  "2026-09-28", "A1-02", "wilt",     42, "到货萎蔫 8 枝，已剔除"),
    (2, 220, "2026-09-29", "B2-01", "accepted", 220, ""),
    (3, 40,  "2026-09-29", "B2-03", "accepted", 40, ""),
    (6, 120, "2026-09-29", "C1-01", "accepted", 120, ""),
    (5, 50,  "2026-09-30", "C1-02", "damage",   44, "运输折损 6 枝"),
    (1, 20,  "2026-09-30", "A1-03", "accepted", 20, "补发白牡丹，供仪式拱门"),
    (5, 10,  "2026-09-30", "C1-03", "accepted", 10, "补发香槟玫瑰，补足主桌需求"),
    (3, 30,  "2026-09-30", "B2-04", "accepted", 30, "补发珊瑚康乃馨，供主桌追加"),
]


def seed():
    if os.path.exists(db.DB_PATH):
        os.remove(db.DB_PATH)
    for suffix in ("-wal", "-shm"):
        p = db.DB_PATH + suffix
        if os.path.exists(p):
            os.remove(p)
    # 重建样例：清空本地上传目录中的旧照片
    if os.path.isdir(UPLOAD_DIR):
        shutil.rmtree(UPLOAD_DIR)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    db.init_db()
    conn = db.connect()
    try:
        # 区域
        zone_ids = {}
        for name, hero, x, y, w, h in ZONES:
            cur = conn.execute(
                "INSERT INTO zone(name,is_hero,floor_x,floor_y,floor_w,floor_h)"
                " VALUES(?,?,?,?,?,?)", (name, hero, x, y, w, h))
            zone_ids[name] = cur.lastrowid
        # 花材
        fids = []
        for name, price in FLOWERS:
            cur = conn.execute("INSERT INTO flower(name,unit_price) VALUES(?,?)",
                               (name, price))
            fids.append(cur.lastrowid)

        # 清单 v1 并确认
        for zname, need in MANIFESTS.items():
            zid = zone_ids[zname]
            items = [(fids[i], n) for i, n in need.items()]
            service.create_version(conn, zid, items, note="初版花艺方案")
            service.confirm_version(conn, zid, 1)

        # 到货 + 质检
        for fi, stems, date, cold, qc, usable, note in ARRIVALS:
            aid = service.receive_arrival(conn, fids[fi], stems, date, cold)
            service.qc_arrival(conn, aid, qc, usable, note)

        # —— 缺货样例 1：主舞台白牡丹缺货 → 粉芍药替代（主视觉，待客户确认，锁定）——
        sub1, diff1 = service.propose_substitution(
            conn, zone_ids["主舞台"], fids[1], 40, fids[4], 36,
            "粉芍药花头略大、色调偏暖粉，层次感更柔；体量相当，主视觉焦点不变。")
        # —— 缺货样例 2：迎宾区白玫瑰短缺 → 香槟玫瑰（非主视觉，同样需确认）——
        sub2, diff2 = service.propose_substitution(
            conn, zone_ids["迎宾签到区"], fids[0], 20, fids[5], 20,
            "香槟玫瑰偏暖米调，与白玫瑰同花型，远观几乎一致，近看色温略暖。")
        # 客户确认第 2 个（非主视觉），演示授权后可领料
        service.confirm_substitution(conn, sub2, "confirmed",
                                     "客户微信确认：迎宾区可用香槟玫瑰。")

        # —— 临时追加样例：宴会主桌客户现场追加珊瑚康乃馨 ——
        adhoc = service.add_adhoc(conn, zone_ids["宴会主桌"], fids[3], 10,
                                  "客户彩排后要求主桌加一圈珊瑚色点缀")

        # —— 已领料样例（演示多组重复领料留痕）——
        # 主舞台 A 组领白玫瑰，随后 B 组又领同一种 → duplicate 预警
        service.pick_stems(conn, zone_ids["主舞台"], fids[0], 60, "A组")
        service.pick_stems(conn, zone_ids["主舞台"], fids[2], 30, "A组")
        service.pick_stems(conn, zone_ids["主舞台"], fids[0], 40, "B组")
        # 迎宾区按已确认替换领香槟玫瑰
        service.pick_stems(conn, zone_ids["迎宾签到区"], fids[5], 20, "迎宾组",
                           reason="substitution", ref_id=sub2)
        # 主桌追加领料
        service.pick_stems(conn, zone_ids["宴会主桌"], fids[3], 10, "主桌组",
                           reason="adhoc", ref_id=adhoc)

        # 现场核对：迎宾区已核对
        service.verify_zone(conn, zone_ids["迎宾签到区"], "现场督导-小林")

        # 撤场回收样例
        service.recycle_stems(conn, zone_ids["迎宾签到区"], fids[2], 12,
                              "签到台尤加利状态尚好，回收二次利用")

        # —— 本地照片：效果图 / 完工照 / 质检照 / 替换前后对比 ——
        photos = []
        for zt in ZONES:
            name = zt[0]
            fn = f"ref_{zone_ids[name]}.svg"
            _svg(os.path.join(UPLOAD_DIR, fn), f"{name} · 效果图",
                 PALETTE["white"], PALETTE["coral"], "设计稿 · 待布置")
            _add_photo(conn, "reference", zone_ids[name], zone_ids[name], fn,
                       f"{name}效果图")
        # 迎宾区完工照
        fn = "done_zone2.svg"
        _svg(os.path.join(UPLOAD_DIR, fn), "迎宾签到区 · 完工照",
             PALETTE["coral"], PALETTE["white"], "实际布置 · 已核对")
        _add_photo(conn, "completion", zone_ids["迎宾签到区"], None, fn, "迎宾区完工照")
        # 替换前后：主舞台 白牡丹→粉芍药
        _svg(os.path.join(UPLOAD_DIR, "sub_before_1.svg"), "替换前 · 白牡丹 40枝",
             PALETTE["white"], "#F2EFEA", "原方案 ¥480")
        _add_photo(conn, "before", zone_ids["主舞台"], sub1, "sub_before_1.svg", "白牡丹")
        _svg(os.path.join(UPLOAD_DIR, "sub_after_1.svg"), "替换后 · 粉芍药 36枝",
             "#F3AFC4", PALETTE["coral"], "替代 ¥540 · 价差 +¥60", badge="待确认")
        _add_photo(conn, "after", zone_ids["主舞台"], sub1, "sub_after_1.svg", "粉芍药")
        # 替换前后：迎宾区 白玫瑰→香槟玫瑰（已确认）
        _svg(os.path.join(UPLOAD_DIR, "sub_before_2.svg"), "替换前 · 白玫瑰 20枝",
             PALETTE["white"], "#EFEFEF", "原方案 ¥160")
        _add_photo(conn, "before", zone_ids["迎宾签到区"], sub2, "sub_before_2.svg", "白玫瑰")
        _svg(os.path.join(UPLOAD_DIR, "sub_after_2.svg"), "替换后 · 香槟玫瑰 20枝",
             "#EAD9B8", PALETTE["coral"], "替代 ¥150 · 价差 -¥10", badge="已确认")
        _add_photo(conn, "after", zone_ids["迎宾签到区"], sub2, "sub_after_2.svg", "香槟玫瑰")
        # 质检照：白牡丹萎蔫
        _svg(os.path.join(UPLOAD_DIR, "qc_wilt.svg"), "白牡丹 · 到货萎蔫",
             "#CFD6C8", PALETTE["leaf"], "可用 42 / 50 枝")
        _add_photo(conn, "qc", None, 2, "qc_wilt.svg", "白牡丹质检照")

        print("种子数据已载入：")
        print(f"  区域 {len(ZONES)} 个（主舞台为主视觉）")
        print(f"  花材 {len(FLOWERS)} 种，到货批次 {len(ARRIVALS)}")
        print(f"  缺货替换提案 2 条：主舞台待确认（锁定）、迎宾区已确认")
        print("  临时追加 1 条；多组重复领料已留痕；回收/质检照/效果图齐备")
    finally:
        conn.close()


if __name__ == "__main__":
    if "--keep" in sys.argv:
        db.init_db()
        conn = db.connect()
        n = conn.execute("SELECT COUNT(*) c FROM zone").fetchone()["c"]
        conn.close()
        if n:
            print("数据库已有数据，跳过种子。")
            sys.exit(0)
    seed()
