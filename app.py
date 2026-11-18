"""TrustVendor AI - local, explainable supplier verification MVP.

Run with: python app.py
The demo stores data in trustvendor.db next to this file and listens on localhost.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "trustvendor.db"
PORT = int(os.environ.get("PORT", "8000"))
LOCK = threading.Lock()

CHECKS = {
    "registration": ("Business registration", 25),
    "tax": ("Tax identity", 20),
    "bank": ("Bank account ownership", 25),
    "sanctions": ("Sanctions screening", 20),
    "address": ("Business address", 10),
}
ALLOWED_STATES = {"pending", "verified", "missing", "flagged"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db() -> None:
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS vendors (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
                country TEXT NOT NULL, registration_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'in_review', created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS checks (
                vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                check_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
                PRIMARY KEY (vendor_id, check_key)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
            );
        """)
        if db.execute("SELECT COUNT(*) FROM vendors").fetchone()[0] == 0:
            seed_demo(db)


def seed_demo(db: sqlite3.Connection) -> None:
    examples = [
        ("Northstar Components", "Electronics", "India", "GST-29AABCN4821Q1Z5",
         {"registration": ("verified", "Certificate reviewed; matches the submitted legal name."),
          "tax": ("verified", "Tax identity checked against the submitted record."),
          "bank": ("pending", "Awaiting a bank letter or cancelled cheque."),
          "sanctions": ("pending", "Screening not yet recorded."),
          "address": ("verified", "Address proof received; review recorded." )}),
        ("Aster Office Supply", "Office supplies", "India", "GST-27AACFA9012P1Z2",
         {"registration": ("verified", "Company record reviewed."),
          "tax": ("verified", "Tax identity reviewed."),
          "bank": ("verified", "Account holder matches the supplier name."),
          "sanctions": ("verified", "No match in the screening source used; source/date should be recorded by reviewer."),
          "address": ("pending", "Proof of operating address requested.")}),
        ("Bluepeak Logistics", "Logistics", "Singapore", "UEN-202410284K",
         {"registration": ("pending", "Registration evidence requested."),
          "tax": ("pending", "Tax identity evidence requested."),
          "bank": ("missing", "No bank ownership evidence provided."),
          "sanctions": ("pending", "Screening not yet recorded."),
          "address": ("flagged", "Submitted address differs from the registration record; follow up required.")}),
    ]
    for name, category, country, reg_id, states in examples:
        vendor_id = str(uuid.uuid4())
        stamp = now()
        db.execute("INSERT INTO vendors VALUES (?, ?, ?, ?, ?, 'in_review', ?, ?)",
                   (vendor_id, name, category, country, reg_id, stamp, stamp))
        for key, (state, note) in states.items():
            db.execute("INSERT INTO checks VALUES (?, ?, ?, ?, ?)",
                       (vendor_id, key, state, note, stamp))
        db.execute("INSERT INTO audit_log(vendor_id, action, detail, created_at) VALUES (?, 'created', ?, ?)",
                   (vendor_id, "Demo supplier record created", stamp))


def risk_for(check_rows: list[sqlite3.Row]) -> dict:
    by_key = {row["check_key"]: row["state"] for row in check_rows}
    score = sum(weight for key, (_, weight) in CHECKS.items()
                if by_key.get(key) != "verified")
    verified_count = sum(by_key.get(key) == "verified" for key in CHECKS)
    flags = [CHECKS[k][0] for k in CHECKS if by_key.get(k) == "flagged"]
    if flags:
        level = "High"
    elif score >= 60:
        level = "High"
    elif score >= 30:
        level = "Medium"
    else:
        level = "Low"
    return {"score": score, "level": level, "verified_count": verified_count,
            "total_checks": len(CHECKS), "flagged_checks": flags}


def vendor_data(db: sqlite3.Connection, vendor: sqlite3.Row) -> dict:
    check_rows = db.execute("SELECT * FROM checks WHERE vendor_id = ? ORDER BY check_key",
                            (vendor["id"],)).fetchall()
    checks = {row["check_key"]: {"label": CHECKS[row["check_key"]][0],
                                  "weight": CHECKS[row["check_key"]][1],
                                  "state": row["state"], "note": row["note"],
                                  "updated_at": row["updated_at"]}
              for row in check_rows}
    audit = db.execute("SELECT action, detail, created_at FROM audit_log WHERE vendor_id = ? ORDER BY id DESC LIMIT 30",
                       (vendor["id"],)).fetchall()
    risk = risk_for(check_rows)
    status = "Needs attention" if risk["flagged_checks"] else (
        "Verified" if risk["verified_count"] == risk["total_checks"] else "In review")
    return {**dict(vendor), "checks": checks, "risk": risk, "status": status,
            "audit": [dict(row) for row in audit]}


class Handler(BaseHTTPRequestHandler):
    server_version = "TrustVendor/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status: int, value: dict | list) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 32_000:
                raise ValueError("Request body is too large")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object")
            return body
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(str(exc)) from exc

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json(200, {"ok": True})
        if parsed.path == "/api/vendors":
            params = parse_qs(parsed.query)
            search = (params.get("q", [""])[0]).strip().lower()
            with LOCK, connect() as db:
                rows = db.execute("SELECT * FROM vendors ORDER BY updated_at DESC").fetchall()
                result = [vendor_data(db, row) for row in rows]
            if search:
                result = [v for v in result if search in " ".join(
                    (v["name"], v["category"], v["country"], v["registration_id"])).lower()]
            return self.send_json(200, result)
        match = re.fullmatch(r"/api/vendors/([0-9a-f-]{36})", parsed.path)
        if match:
            with LOCK, connect() as db:
                row = db.execute("SELECT * FROM vendors WHERE id = ?", (match.group(1),)).fetchone()
                if not row:
                    return self.send_json(404, {"error": "Supplier not found"})
                return self.send_json(200, vendor_data(db, row))
        return self.static_file(parsed.path)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/vendors":
            return self.send_json(404, {"error": "Not found"})
        try:
            data = self.read_json()
            fields = {key: str(data.get(key, "")).strip() for key in
                      ("name", "category", "country", "registration_id")}
            if any(not value for value in fields.values()):
                return self.send_json(400, {"error": "Complete all supplier fields."})
            if any(len(fields[k]) > limit for k, limit in
                   (("name", 120), ("category", 80), ("country", 80), ("registration_id", 80))):
                return self.send_json(400, {"error": "One or more fields exceed the allowed length."})
            vendor_id, stamp = str(uuid.uuid4()), now()
            with LOCK, connect() as db:
                db.execute("INSERT INTO vendors VALUES (?, ?, ?, ?, ?, 'in_review', ?, ?)",
                           (vendor_id, fields["name"], fields["category"], fields["country"],
                            fields["registration_id"], stamp, stamp))
                for key in CHECKS:
                    db.execute("INSERT INTO checks VALUES (?, ?, 'pending', '', ?)",
                               (vendor_id, key, stamp))
                db.execute("INSERT INTO audit_log(vendor_id, action, detail, created_at) VALUES (?, 'created', ?, ?)",
                           (vendor_id, "Supplier added to verification queue", stamp))
                row = db.execute("SELECT * FROM vendors WHERE id = ?", (vendor_id,)).fetchone()
                result = vendor_data(db, row)
            return self.send_json(201, result)
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

    def do_PATCH(self) -> None:
        match = re.fullmatch(r"/api/vendors/([0-9a-f-]{36})/checks/([a-z]+)", urlparse(self.path).path)
        if not match:
            return self.send_json(404, {"error": "Not found"})
        vendor_id, key = match.groups()
        if key not in CHECKS:
            return self.send_json(400, {"error": "Unknown verification check"})
        try:
            data = self.read_json()
            state = str(data.get("state", ""))
            note = str(data.get("note", "")).strip()
            if state not in ALLOWED_STATES:
                return self.send_json(400, {"error": "Choose a valid check status."})
            if len(note) > 500:
                return self.send_json(400, {"error": "Notes must be 500 characters or fewer."})
            stamp = now()
            with LOCK, connect() as db:
                exists = db.execute("SELECT 1 FROM vendors WHERE id = ?", (vendor_id,)).fetchone()
                if not exists:
                    return self.send_json(404, {"error": "Supplier not found"})
                previous = db.execute("SELECT state, note FROM checks WHERE vendor_id = ? AND check_key = ?",
                                      (vendor_id, key)).fetchone()
                db.execute("UPDATE checks SET state = ?, note = ?, updated_at = ? WHERE vendor_id = ? AND check_key = ?",
                           (state, note, stamp, vendor_id, key))
                db.execute("UPDATE vendors SET updated_at = ? WHERE id = ?", (stamp, vendor_id))
                if previous["state"] != state or previous["note"] != note:
                    detail = f"{CHECKS[key][0]}: {previous['state']} → {state}"
                    if note:
                        detail += f" — {note}"
                    db.execute("INSERT INTO audit_log(vendor_id, action, detail, created_at) VALUES (?, 'check_updated', ?, ?)",
                               (vendor_id, detail, stamp))
                row = db.execute("SELECT * FROM vendors WHERE id = ?", (vendor_id,)).fetchone()
                result = vendor_data(db, row)
            return self.send_json(200, result)
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

    def static_file(self, path: str) -> None:
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (ROOT / "static" / relative).resolve()
        if not target.is_relative_to(ROOT / "static") or not target.is_file():
            self.send_error(404)
            return
        content_type = "text/html; charset=utf-8" if target.suffix == ".html" else "text/plain; charset=utf-8"
        payload = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PATCH, OPTIONS")
        self.end_headers()


if __name__ == "__main__":
    init_db()
    print(f"TrustVendor AI running at http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
