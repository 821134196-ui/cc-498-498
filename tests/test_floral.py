"""核心规则测试：库存占用、版本过期、替换授权、并发领料 + HTTP 冒烟。

运行：python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db, service  # noqa: E402


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        db.DB_PATH = os.path.join(self.tmp, "test.db")
        db.init_db()
        self.conn = db.connect()
        # 区域：1=主舞台(主视觉) 2=迎宾区(普通)
        self.hero = self._zone("主舞台", hero=1)
        self.normal = self._zone("迎宾区", hero=0)
        # 花材：A=白玫瑰(8元) B=香槟玫瑰(7.5元)
        self.A = self._flower("白玫瑰", 8.0)
        self.B = self._flower("香槟玫瑰", 7.5)

    def tearDown(self):
        self.conn.close()
        for suffix in ("", "-wal", "-shm"):
            p = db.DB_PATH + suffix
            if os.path.exists(p):
                os.remove(p)

    def _zone(self, name, hero=0):
        return self.conn.execute(
            "INSERT INTO zone(name,is_hero) VALUES(?,?)", (name, hero)).lastrowid

    def _flower(self, name, price):
        return self.conn.execute(
            "INSERT INTO flower(name,unit_price) VALUES(?,?)", (name, price)).lastrowid

    def _stock(self, fid, stems):
        """登记并验收一批到货，形成可用库存。"""
        aid = service.receive_arrival(self.conn, fid, stems, "2026-09-30", "A1")
        service.qc_arrival(self.conn, aid, "accepted", stems, "合格")
        return aid

    def _manifest(self, zid, items, confirm=True):
        v = service.create_version(self.conn, zid, items, "测试清单")
        if confirm:
            service.confirm_version(self.conn, zid, v)
        return v

    def expect_err(self, code, fn, *a, **kw):
        try:
            fn(*a, **kw)
        except service.ServiceError as e:
            self.assertEqual(e.code, code, f"期望 {code}，实际 {e.code}：{e.message}")
            return e
        self.fail(f"应当抛出 {code}，但未抛错")


class TestStockOccupancy(BaseCase):
    """同一枝数预算不能被两个区域重复占用。"""

    def test_cross_zone_double_occupy_blocked(self):
        self._stock(self.A, 100)
        self._manifest(self.hero, [(self.A, 80)])
        self._manifest(self.normal, [(self.A, 80)])

        service.pick_stems(self.conn, self.hero, self.A, 60, "A组")
        # 第二区域同样有 80 枝配额，但全局库存只剩 40
        self.expect_err("INSUFFICIENT_STOCK",
                        service.pick_stems, self.conn, self.normal, self.A, 60, "B组")
        # 40 枝仍可领，恰好占满，不许多占 1 枝
        service.pick_stems(self.conn, self.normal, self.A, 40, "B组")
        self.assertEqual(service.stock_available(self.conn, self.A), 0)
        self.expect_err("INSUFFICIENT_STOCK",
                        service.pick_stems, self.conn, self.normal, self.A, 1, "B组")

    def test_over_quota_in_same_zone(self):
        self._stock(self.A, 500)
        self._manifest(self.normal, [(self.A, 50)])
        service.pick_stems(self.conn, self.normal, self.A, 50, "A组")
        self.expect_err("OVER_QUOTA",
                        service.pick_stems, self.conn, self.normal, self.A, 1, "A组")

    def test_no_confirmed_manifest_blocks_pick(self):
        self._stock(self.A, 50)
        self._manifest(self.normal, [(self.A, 50)], confirm=False)  # 仅草稿
        self.expect_err("NO_CONFIRMED_MANIFEST",
                        service.pick_stems, self.conn, self.normal, self.A, 1, "A组")

    def test_duplicate_pick_logged(self):
        self._stock(self.A, 100)
        self._manifest(self.hero, [(self.A, 100)])
        _, w1 = service.pick_stems(self.conn, self.hero, self.A, 40, "A组")
        self.assertIsNone(w1)
        _, w2 = service.pick_stems(self.conn, self.hero, self.A, 20, "B组")
        self.assertIsNotNone(w2, "跨小组重复领料必须返回预警")
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM incident WHERE kind='duplicate'").fetchone()["c"]
        self.assertEqual(n, 1, "重复领料必须留痕到 incident")


class TestVersionStaleness(BaseCase):
    """客户确认关联具体版本；旧版本不能确认，旧提案随新版本过期。"""

    def test_confirm_old_version_rejected(self):
        self._stock(self.A, 100)
        self._manifest(self.hero, [(self.A, 30)])          # v1 已确认
        service.create_version(self.conn, self.hero, [(self.A, 40)], "调整")  # v2 草稿
        self.expect_err("VERSION_STALE",
                        service.confirm_version, self.conn, self.hero, 1)
        m = service.confirm_version(self.conn, self.hero, 2)
        self.assertEqual(m["status"], "confirmed")

    def test_new_draft_does_not_invalidate_confirmed_picking(self):
        self._stock(self.A, 100)
        self._manifest(self.hero, [(self.A, 30)])
        service.create_version(self.conn, self.hero, [(self.A, 40)], "调整草案")
        # 最新版虽为草稿，但已确认的 v1 仍可履约
        pid, _ = service.pick_stems(self.conn, self.hero, self.A, 30, "A组")
        self.assertTrue(pid)

    def test_substitution_stale_after_new_version(self):
        self._stock(self.A, 50)
        self._stock(self.B, 50)
        self._manifest(self.normal, [(self.A, 30)])
        sid, _ = service.propose_substitution(
            self.conn, self.normal, self.A, 30, self.B, 30, "色调偏暖")
        # 清单出了新版本 → 原提案版本过期
        service.create_version(self.conn, self.normal, [(self.A, 20)], "缩量")
        self.expect_err("VERSION_STALE",
                        service.confirm_substitution, self.conn, sid, "confirmed")
        # 确认最新版本后重新提案，才能确认
        service.confirm_version(self.conn, self.normal, 2)
        sid2, _ = service.propose_substitution(
            self.conn, self.normal, self.A, 20, self.B, 20, "色调偏暖")
        s = service.confirm_substitution(self.conn, sid2, "confirmed", "客户同意")
        self.assertEqual(s["decided_version"], 2, "确认必须锁定具体版本号")

    def test_decided_substitution_is_idempotent_state(self):
        self._stock(self.A, 30)
        self._stock(self.B, 30)
        self._manifest(self.normal, [(self.A, 30)])
        sid, _ = service.propose_substitution(
            self.conn, self.normal, self.A, 30, self.B, 30, "无差")
        service.confirm_substitution(self.conn, sid, "confirmed")
        self.expect_err("SUB_DECIDED",
                        service.confirm_substitution, self.conn, sid, "rejected")


class TestSubstitutionAuthorization(BaseCase):
    """未经客户确认不能替换主视觉区域；替代领料严格受授权枝数约束。"""

    def _proposal(self, zid):
        return service.propose_substitution(
            self.conn, zid, self.A, 30, self.B, 28, "花型相近，色温略暖")[0]

    def test_hero_zone_blocked_until_confirmed(self):
        self._stock(self.B, 100)
        self._manifest(self.hero, [(self.A, 30)])
        sid = self._proposal(self.hero)
        e = self.expect_err("HERO_NOT_AUTHORIZED",
                            service.pick_stems, self.conn, self.hero, self.B, 10,
                            "布置组", "substitution", sid)
        self.assertIn("主视觉", e.message)

    def test_normal_zone_also_requires_confirmation(self):
        self._stock(self.B, 100)
        self._manifest(self.normal, [(self.A, 30)])
        sid = self._proposal(self.normal)
        self.expect_err("SUB_NOT_CONFIRMED",
                        service.pick_stems, self.conn, self.normal, self.B, 10,
                        "迎宾组", "substitution", sid)

    def test_confirmed_substitution_pick_and_cap(self):
        self._stock(self.B, 100)
        self._manifest(self.hero, [(self.A, 30)])
        sid = self._proposal(self.hero)
        service.confirm_substitution(self.conn, sid, "confirmed", "客户微信确认")
        service.pick_stems(self.conn, self.hero, self.B, 28, "布置组",
                           "substitution", sid)
        self.expect_err("OVER_QUOTA",
                        service.pick_stems, self.conn, self.hero, self.B, 1,
                        "布置组", "substitution", sid)

    def test_rejected_substitution_still_blocked(self):
        self._stock(self.B, 100)
        self._manifest(self.hero, [(self.A, 30)])
        sid = self._proposal(self.hero)
        service.confirm_substitution(self.conn, sid, "rejected", "坚持白玫瑰")
        self.expect_err("SUB_DECIDED",
                        service.pick_stems, self.conn, self.hero, self.B, 10,
                        "布置组", "substitution", sid)

    def test_substitute_not_in_quota_direct_pick(self):
        self._stock(self.B, 100)
        self._manifest(self.normal, [(self.A, 30)])
        self.expect_err("NOT_IN_QUOTA",
                        service.pick_stems, self.conn, self.normal, self.B, 5, "迎宾组")


class TestQcAndAdhoc(BaseCase):

    def test_wilt_reduces_usable_supply(self):
        aid = service.receive_arrival(self.conn, self.A, 50, "2026-09-30", "A1")
        service.qc_arrival(self.conn, aid, "wilt", 42, "8 枝萎蔫")
        self.assertEqual(service.stock_supply(self.conn, self.A), 42)
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM incident WHERE kind='wilt' AND stems=8").fetchone()["c"]
        self.assertEqual(n, 1)

    def test_qc_usable_cannot_exceed_arrival(self):
        aid = service.receive_arrival(self.conn, self.A, 50, "2026-09-30", "A1")
        self.expect_err("BAD_STEMS",
                        service.qc_arrival, self.conn, aid, "accepted", 51)

    def test_adhoc_pick_requires_doc(self):
        self._stock(self.B, 50)
        self._manifest(self.normal, [(self.A, 10)])
        self.expect_err("ADHOC_NOT_FOUND",
                        service.pick_stems, self.conn, self.normal, self.B, 5,
                        "迎宾组", "adhoc", 999)
        aid = service.add_adhoc(self.conn, self.normal, self.B, 8, "客户现场要求")
        service.pick_stems(self.conn, self.normal, self.B, 8, "迎宾组", "adhoc", aid)
        self.assertEqual(service.stock_available(self.conn, self.B), 42)


class TestConcurrentPicks(BaseCase):
    """并发领料：库存绝不超卖，枝数占用精确。"""

    def test_concurrent_no_oversell_single_zone(self):
        self._stock(self.A, 100)
        self._manifest(self.normal, [(self.A, 100)])
        errors, successes = self._run(12, 10, self.normal)
        self.assertEqual(successes, 10, "100 枝库存只应成功 10 次 10 枝领料")
        picked = service.stock_picked(self.conn, self.A)
        self.assertEqual(picked, 100)
        self.assertEqual(service.stock_available(self.conn, self.A), 0)
        self.assertTrue(any(e.code == "OVER_QUOTA" for e in errors))

    def test_concurrent_no_oversell_cross_zone(self):
        self._stock(self.A, 100)
        self._manifest(self.hero, [(self.A, 100)])
        self._manifest(self.normal, [(self.A, 100)])
        errors, successes = self._run(20, 10, None)  # 两区域各 10 线程
        self.assertEqual(successes, 10, "两区域共享 100 枝，全局只能成功 10 笔")
        picked = service.stock_picked(self.conn, self.A)
        self.assertEqual(picked, 100, "不能把同一枝数发给两个区域")
        self.assertTrue(any(e.code == "INSUFFICIENT_STOCK" for e in errors))

    def _run(self, threads, stems, fixed_zone):
        barrier = threading.Barrier(threads)
        results = []

        def worker(i):
            conn = db.connect()
            zid = fixed_zone if fixed_zone else (self.hero if i % 2 else self.normal)
            try:
                barrier.wait()
                service.pick_stems(conn, zid, self.A, stems, f"{i%3}组")
                results.append(("ok", None))
            except service.ServiceError as e:
                results.append(("err", e))
            finally:
                conn.close()

        with ThreadPoolExecutor(max_workers=threads) as ex:
            list(ex.map(worker, range(threads)))
        errors = [e for _, e in results if e]
        successes = sum(1 for s, _ in results if s == "ok")
        return errors, successes


class TestHttpApi(unittest.TestCase):
    """HTTP 冒烟：静态页、JSON、409 冲突码与模拟通知。"""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        from app.server import Handler
        cls.tmp = tempfile.mkdtemp()
        db.DB_PATH = os.path.join(cls.tmp, "http.db")
        db.init_db()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def _url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def _post(self, path, payload):
        req = urllib.request.Request(
            self._url(path), data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def _get(self, path):
        with urllib.request.urlopen(self._url(path)) as r:
            return r.status, r.read()

    def test_full_flow_over_http(self):
        # 首页
        st, html = self._get("/")
        self.assertEqual(st, 200)
        self.assertIn("花艺".encode(), html)
        # 基础数据
        conn = db.connect()
        zid = conn.execute("INSERT INTO zone(name,is_hero) VALUES('仪式区',1)").lastrowid
        fid = conn.execute("INSERT INTO flower(name,unit_price) VALUES('白玫瑰',8)").lastrowid
        conn.close()
        st, r = self._post("/api/manifest/create",
                           {"zone_id": zid, "items": [{"flower_id": fid, "stems": 10}]})
        self.assertEqual(st, 200)
        st, r = self._post("/api/manifest/confirm",
                           {"zone_id": zid, "version": r["version"]})
        self.assertEqual(st, 200)
        # 无库存领料 → 409
        st, r = self._post("/api/pick",
                           {"zone_id": zid, "flower_id": fid, "stems": 5, "crew": "X组"})
        self.assertEqual(st, 409)
        self.assertEqual(r["error"]["code"], "INSUFFICIENT_STOCK")
        # 到货入库后再领 → 200
        st, r = self._post("/api/arrival/receive",
                           {"flower_id": fid, "stems": 10,
                            "arrival_date": "2026-09-30", "cold_location": "A1"})
        aid = r["arrival_id"]
        self.assertEqual(st, 200)
        st, _ = self._post("/api/arrival/qc",
                           {"arrival_id": aid, "status": "accepted", "usable_stems": 10})
        self.assertEqual(st, 200)
        st, r = self._post("/api/pick",
                           {"zone_id": zid, "flower_id": fid, "stems": 5, "crew": "X组"})
        self.assertEqual(st, 200)
        # 模拟通知已落库
        st, body = self._get("/api/notifications")
        self.assertEqual(st, 200)
        self.assertGreaterEqual(json.loads(body)["notifications"][0]["id"], 1)


if __name__ == "__main__":
    unittest.main()
