"""零依赖 HTTP 服务：JSON API + 静态前端 + 本地照片存取。

启动：python3 -m app.server  (或 ./run.sh)
"""
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import db, service

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "..", "web")
UPLOAD_DIR = os.path.abspath(os.path.join(BASE, "..", "data", "uploads"))
os.makedirs(UPLOAD_DIR, exist_ok=True)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
}


# ---------------------------------------------------------------- multipart 解析

def parse_multipart(body, boundary):
    """最小 multipart/form-data 解析：返回 fields dict 与 files[(name,filename,data)]。"""
    delim = b"--" + boundary.encode()
    fields, files = {}, []
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_blob, content = part.split(b"\r\n\r\n", 1)
        headers = {}
        for line in header_blob.decode("utf-8", "replace").split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        cd = headers.get("content-disposition", "")
        m_name = re.search(r'name="([^"]*)"', cd)
        m_file = re.search(r'filename="([^"]*)"', cd)
        if not m_name:
            continue
        name = m_name.group(1)
        if m_file:
            files.append((name, os.path.basename(m_file.group(1)) or "photo", content))
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files


# ---------------------------------------------------------------- 序列化辅助

def listdata(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


# ---------------------------------------------------------------- 请求处理器

class Handler(BaseHTTPRequestHandler):
    server_version = "FloralPlanner/1.0"

    # ---- 输出 ----
    def _json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _err(self, code, message, status=400):
        self._json({"ok": False, "error": {"code": code, "message": message}}, status)

    def _static(self, rel):
        path = os.path.normpath(os.path.join(WEB, rel))
        if not path.startswith(os.path.normpath(WEB)) or not os.path.isfile(path):
            return False
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)
        return True

    def _upload(self, rel):
        path = os.path.normpath(os.path.join(UPLOAD_DIR, rel))
        if not path.startswith(UPLOAD_DIR) or not os.path.isfile(path):
            return False
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    def log_message(self, fmt, *args):
        pass  # 测试环境静默

    # ---- 读取请求体 ----
    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def _json_body(self):
        raw = self._read_body()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            if path.startswith("/api/"):
                return self._api_get(path, qs)
            if path.startswith("/uploads/"):
                if self._upload(path[len("/uploads/"):]):
                    return
                self.send_error(404)
            if path == "/":
                path = "/index.html"
            if self._static(path.lstrip("/")):
                return
            self.send_error(404)
        except service.ServiceError as e:
            self._err(e.code, e.message)
        except Exception as e:  # noqa: BLE001
            self._err("INTERNAL", str(e), 500)

    def _api_get(self, path, qs):
        conn = db.connect()
        try:
            if path == "/api/zones":
                zones = listdata(conn, "SELECT * FROM zone ORDER BY id")
                stock = {s["id"]: s for s in service.stock_snapshot(conn)}
                for z in zones:
                    m = service.latest_manifest(conn, z["id"])
                    z["latest_version"] = m["version"] if m else None
                    z["manifest_status"] = m["status"] if m else None
                self._json({"ok": True, "zones": zones, "stock": list(stock.values())})
            elif path == "/api/zone":
                zid = int(qs["id"][0])
                zone = dict(service.get_zone(conn, zid))
                manifests = listdata(conn,
                    "SELECT * FROM manifest WHERE zone_id=? ORDER BY version DESC", (zid,))
                detail = {"zone": zone, "manifests": manifests, "versions": []}
                for m in manifests:
                    detail["versions"].append({
                        "manifest": dict(m),
                        "quota": [dict(r) for r in service.quota_rows(conn, m["id"])],
                    })
                detail["picks"] = [dict(r) for r in service.zone_pick_summary(conn, zid)]
                detail["picks_all"] = listdata(conn,
                    "SELECT p.*, f.name flower_name FROM pick p JOIN flower f ON f.id=p.flower_id"
                    " WHERE p.zone_id=? ORDER BY p.id", (zid,))
                detail["photos"] = listdata(conn,
                    "SELECT * FROM photo WHERE zone_id=? ORDER BY id DESC", (zid,))
                self._json({"ok": True, **detail})
            elif path == "/api/flowers":
                self._json({"ok": True, "flowers": service.stock_snapshot(conn)})
            elif path == "/api/arrivals":
                rows = listdata(conn,
                    "SELECT a.*, f.name flower_name FROM arrival a JOIN flower f ON f.id=a.flower_id"
                    " ORDER BY a.arrival_date, a.id")
                photos = {p["ref_id"]: p for p in conn.execute(
                    "SELECT * FROM photo WHERE kind='qc'").fetchall()}
                self._json({"ok": True, "arrivals": rows,
                            "qc_photos": {k: dict(v) for k, v in photos.items()}})
            elif path == "/api/substitutions":
                rows = listdata(conn,
                    "SELECT s.*, z.name zone_name, fo.name original_name,"
                    " fs.name substitute_name, fo.unit_price original_price,"
                    " fs.unit_price substitute_price, z.is_hero"
                    " FROM substitution s JOIN zone z ON z.id=s.zone_id"
                    " JOIN flower fo ON fo.id=s.original_id"
                    " JOIN flower fs ON fs.id=s.substitute_id ORDER BY s.id DESC")
                used = {}
                for s in conn.execute("SELECT ref_id, SUM(stems) n FROM pick"
                                      " WHERE reason='substitution' GROUP BY ref_id"):
                    used[s["ref_id"]] = s["n"]
                photos = {}
                for p in conn.execute(
                        "SELECT * FROM photo WHERE kind IN ('before','after')"):
                    photos.setdefault(p["ref_id"], []).append(dict(p))
                for r in rows:
                    r["picked_stems"] = used.get(r["id"], 0)
                    r["photos"] = photos.get(r["id"], [])
                self._json({"ok": True, "substitutions": rows})
            elif path == "/api/adhocs":
                self._json({"ok": True, "adhocs": listdata(conn,
                    "SELECT a.*, z.name zone_name, f.name flower_name, f.unit_price,"
                    " (SELECT COALESCE(SUM(stems),0) FROM pick p"
                    "  WHERE p.reason='adhoc' AND p.ref_id=a.id) picked"
                    " FROM ad_hoc_addition a JOIN zone z ON z.id=a.zone_id"
                    " JOIN flower f ON f.id=a.flower_id ORDER BY a.id DESC")})
            elif path == "/api/picks":
                self._json({"ok": True, "picks": listdata(conn,
                    "SELECT p.*, z.name zone_name, f.name flower_name, f.unit_price"
                    " FROM pick p JOIN zone z ON z.id=p.zone_id"
                    " JOIN flower f ON f.id=p.flower_id ORDER BY p.id DESC")})
            elif path == "/api/incidents":
                self._json({"ok": True, "incidents": listdata(conn,
                    "SELECT i.*, z.name zone_name, f.name flower_name FROM incident i"
                    " LEFT JOIN zone z ON z.id=i.zone_id"
                    " LEFT JOIN flower f ON f.id=i.flower_id ORDER BY i.id DESC")})
            elif path == "/api/recycles":
                self._json({"ok": True, "recycles": listdata(conn,
                    "SELECT r.*, z.name zone_name, f.name flower_name FROM recycle r"
                    " JOIN zone z ON z.id=r.zone_id JOIN flower f ON f.id=r.flower_id"
                    " ORDER BY r.id DESC")})
            elif path == "/api/notifications":
                self._json({"ok": True, "notifications": listdata(conn,
                    "SELECT * FROM notification ORDER BY id DESC LIMIT 100")})
            elif path == "/api/photos":
                sql = "SELECT * FROM photo WHERE 1=1"
                args = []
                if "kind" in qs:
                    sql += " AND kind=?"; args.append(qs["kind"][0])
                if "zone_id" in qs:
                    sql += " AND zone_id=?"; args.append(int(qs["zone_id"][0]))
                if "ref_id" in qs:
                    sql += " AND ref_id=?"; args.append(int(qs["ref_id"][0]))
                sql += " ORDER BY id DESC"
                self._json({"ok": True, "photos": listdata(conn, sql, args)})
            elif path == "/api/settlement":
                self._json({"ok": True, **service.settlement(conn)})
            else:
                self._err("NOT_FOUND", "未知接口", 404)
        finally:
            conn.close()

    # ---- POST ----
    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        try:
            if path == "/api/photo":
                return self._upload_photo()
            data = self._json_body()
            conn = db.connect()
            try:
                result = self._dispatch(conn, path, data)
                self._json({"ok": True, **(result or {})})
            finally:
                conn.close()
        except service.ServiceError as e:
            self._err(e.code, e.message, 409 if e.code in (
                "INSUFFICIENT_STOCK", "OVER_QUOTA", "VERSION_STALE",
                "HERO_NOT_AUTHORIZED", "NO_CONFIRMED_MANIFEST") else 400)
        except json.JSONDecodeError:
            self._err("BAD_JSON", "请求体不是合法 JSON")
        except Exception as e:  # noqa: BLE001
            self._err("INTERNAL", str(e), 500)

    def _dispatch(self, conn, path, d):
        if path == "/api/manifest/create":
            items = [(int(x["flower_id"]), int(x["stems"])) for x in d["items"]]
            v = service.create_version(conn, int(d["zone_id"]), items, d.get("note", ""))
            return {"version": v}
        if path == "/api/manifest/confirm":
            m = service.confirm_version(conn, int(d["zone_id"]), int(d["version"]))
            return {"version": m["version"], "status": m["status"]}
        if path == "/api/arrival/receive":
            aid = service.receive_arrival(
                conn, int(d["flower_id"]), int(d["stems"]),
                str(d["arrival_date"]), str(d.get("cold_location", "")))
            return {"arrival_id": aid}
        if path == "/api/arrival/qc":
            service.qc_arrival(conn, int(d["arrival_id"]), d["status"],
                               int(d["usable_stems"]), d.get("note", ""))
            return {}
        if path == "/api/substitution/propose":
            sid, diff = service.propose_substitution(
                conn, int(d["zone_id"]), int(d["original_id"]), int(d["original_stems"]),
                int(d["substitute_id"]), int(d["substitute_stems"]),
                d.get("visual_diff", ""))
            return {"substitution_id": sid, "price_diff": diff}
        if path == "/api/substitution/decide":
            s = service.confirm_substitution(conn, int(d["sub_id"]),
                                             d["decision"], d.get("note", ""))
            return {"status": s["status"], "decided_version": s["decided_version"]}
        if path == "/api/adhoc":
            aid = service.add_adhoc(conn, int(d["zone_id"]), int(d["flower_id"]),
                                    int(d["stems"]), d.get("reason", ""))
            return {"adhoc_id": aid}
        if path == "/api/recycle":
            rid = service.recycle_stems(conn, int(d["zone_id"]), int(d["flower_id"]),
                                        int(d["stems"]), d.get("note", ""))
            return {"recycle_id": rid}
        if path == "/api/incident":
            iid = service.log_incident(conn, d["kind"],
                                       d.get("zone_id"), d.get("flower_id"),
                                       int(d.get("stems", 0)), d.get("note", ""))
            return {"incident_id": iid}
        if path == "/api/pick":
            pid, warn = service.pick_stems(
                conn, int(d["zone_id"]), int(d["flower_id"]), int(d["stems"]),
                str(d.get("crew", "未署名小组")), d.get("reason", "quota"),
                d.get("ref_id"))
            return {"pick_id": pid, "duplicate_warning": warn}
        if path == "/api/verify":
            service.verify_zone(conn, int(d["zone_id"]), str(d.get("verifier", "")))
            return {}
        raise service.ServiceError("NOT_FOUND", "未知接口")

    def _upload_photo(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype or "boundary=" not in ctype:
            return self._err("BAD_UPLOAD", "需要 multipart/form-data")
        boundary = ctype.split("boundary=", 1)[1].strip()
        fields, files = parse_multipart(self._read_body(), boundary)
        if not files:
            return self._err("NO_FILE", "未收到照片文件")
        name, filename, data = files[0]
        ext = os.path.splitext(filename)[1].lower()
        if ext not in CONTENT_TYPES:
            ext = ".jpg"
        conn = db.connect()
        try:
            with db.tx(conn):
                cur = conn.execute(
                    "INSERT INTO photo(kind,zone_id,ref_id,path,label)"
                    " VALUES(?,?,?,?,?)",
                    (fields.get("kind", "completion"),
                     int(fields["zone_id"]) if fields.get("zone_id") else None,
                     int(fields["ref_id"]) if fields.get("ref_id") else None,
                     "", fields.get("label", "")))
                pid = cur.lastrowid
                rel = f"{pid}_{int(time.time())}{ext}"
                with open(os.path.join(UPLOAD_DIR, rel), "wb") as fh:
                    fh.write(data)
                conn.execute("UPDATE photo SET path=? WHERE id=?", (f"uploads/{rel}", pid))
        finally:
            conn.close()
        self._json({"ok": True, "photo_id": pid, "path": f"/uploads/{rel}"})


def serve(host="127.0.0.1", port=8000):
    db.init_db()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"花艺婚礼管理  http://{host}:{port}  (Ctrl+C 停止)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    import sys
    h = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    p = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    serve(h, p)
