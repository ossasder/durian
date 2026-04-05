from __future__ import annotations

import base64
import html
import json
import mimetypes
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from .db import (
    DEFAULT_BUSINESS_PROFILE,
    DEFAULT_GRADE_LABELS,
    DEFAULT_VARIETIES,
    PROJECT_ROOT,
    TIMEZONE,
    UPLOADS_DIR,
    bangkok_now,
    connect_db,
    init_db,
    now_iso,
    upsert_setting,
)
from .security import hash_password, hash_token, make_token, verify_password


STATIC_DIR = PROJECT_ROOT / "static"
SESSION_COOKIE = "durian_session"
REMEMBER_COOKIE = "durian_remember"
PUBLIC_BASE_URL = (os.getenv("DURIAN_BANK_PUBLIC_BASE_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
FORCE_SECURE_COOKIES = (os.getenv("DURIAN_BANK_FORCE_SECURE_COOKIES") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ROLES = {"owner", "admin", "employee"}
CATEGORY_LABELS = {
    "buy_durian": "ซื้อทุเรียน",
    "sell_durian": "ขายทุเรียน",
    "labor": "ค่าแรง",
    "fuel": "น้ำมัน",
    "other": "อื่นๆ",
}
TYPE_LABELS = {"income": "รายรับ", "expense": "รายจ่าย"}
ACTION_LABELS = {
    "create_transaction": "สร้างรายการ",
    "update_transaction": "แก้ไขรายการ",
    "delete_transaction": "ลบรายการ",
    "create_employee": "เพิ่มพนักงาน",
    "update_employee": "แก้ไขพนักงาน",
    "delete_employee": "ลบพนักงาน",
    "suspend_employee": "ระงับพนักงาน",
    "reactivate_employee": "เปิดใช้งานพนักงาน",
    "update_settings": "แก้ไขการตั้งค่า",
}


@dataclass
class ApiError(Exception):
    status: int
    message: str


def run(host: str = "0.0.0.0", port: int = 8000) -> None:
    init_db()
    httpd = ThreadingHTTPServer((host, port), DurianBankHandler)
    print(f"Durian Bank running at http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")


class DurianBankHandler(BaseHTTPRequestHandler):
    server_version = "DurianBank/1.0"

    def do_GET(self) -> None:
        self.dispatch_request()

    def do_POST(self) -> None:
        self.dispatch_request()

    def do_PUT(self) -> None:
        self.dispatch_request()

    def do_DELETE(self) -> None:
        self.dispatch_request()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def dispatch_request(self) -> None:
        self.pending_cookies: list[str] = []
        self.current_user_cache: dict[str, Any] | None = None
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        conn = connect_db()
        try:
            if path.startswith("/api/"):
                self.handle_api(conn, path, query)
                return

            if path == "/health":
                self.send_json({"ok": True, "time": now_iso()})
                return

            if path.startswith("/uploads/"):
                self.serve_uploaded_file(path)
                return

            if path == "/manifest.webmanifest":
                self.serve_file(STATIC_DIR / "manifest.webmanifest", cache_control="no-cache")
                return

            if path == "/service-worker.js":
                self.serve_file(STATIC_DIR / "service-worker.js", cache_control="no-cache")
                return

            if path.startswith("/receipts/"):
                self.handle_receipt_html(conn, path)
                return

            if path.startswith("/static/"):
                relative = path.removeprefix("/static/")
                self.serve_file(STATIC_DIR / relative)
                return

            self.serve_file(STATIC_DIR / "index.html", cache_control="no-cache")
        except ApiError as error:
            self.send_json({"error": error.message}, status=error.status)
        except Exception as error:  # pragma: no cover
            self.send_json({"error": f"Internal server error: {error}"}, status=500)
        finally:
            conn.close()

    def handle_api(self, conn: sqlite3.Connection, path: str, query: dict[str, list[str]]) -> None:
        method = self.command
        if path == "/api/auth/login" and method == "POST":
            self.handle_login(conn)
            return
        if path == "/api/auth/logout" and method == "POST":
            user = self.require_auth(conn)
            self.handle_logout(conn, user)
            return
        if path == "/api/auth/me" and method == "GET":
            user = self.require_auth(conn)
            self.send_json(self.build_bootstrap(conn, user))
            return

        user = self.require_auth(conn)

        if path == "/api/bootstrap" and method == "GET":
            self.send_json(self.build_bootstrap(conn, user))
            return
        if path == "/api/dashboard" and method == "GET":
            self.send_json(self.build_dashboard(conn, query.get("range", ["7d"])[0]))
            return
        if path == "/api/settings" and method == "GET":
            self.send_json({"settings": self.load_settings(conn)})
            return
        if path == "/api/settings" and method == "PUT":
            self.require_roles(user, {"owner", "admin"})
            payload = self.read_json()
            self.update_settings(conn, user, payload)
            self.send_json({"settings": self.load_settings(conn)})
            return

        if path == "/api/employees" and method == "GET":
            self.send_json({"employees": self.list_employees(conn, user)})
            return
        if path == "/api/employees" and method == "POST":
            self.require_roles(user, {"owner", "admin"})
            employee = self.create_employee(conn, user, self.read_json())
            self.send_json({"employee": employee}, status=201)
            return

        if path.startswith("/api/employees/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) >= 3:
                employee_id = self.parse_int(parts[2], "employee id")
                if len(parts) == 4 and parts[3] == "suspend" and method == "POST":
                    self.require_roles(user, {"owner", "admin"})
                    payload = self.read_json(optional=True) or {}
                    self.send_json({"employee": self.suspend_employee(conn, user, employee_id, payload)})
                    return
                if len(parts) == 3 and method == "GET":
                    self.send_json({"employee": self.get_employee(conn, employee_id, user)})
                    return
                if len(parts) == 3 and method == "PUT":
                    self.require_roles(user, {"owner", "admin"})
                    self.send_json({"employee": self.update_employee(conn, user, employee_id, self.read_json())})
                    return
                if len(parts) == 3 and method == "DELETE":
                    self.require_roles(user, {"owner", "admin"})
                    payload = self.read_json(optional=True) or {}
                    self.send_json({"employee": self.delete_employee(conn, user, employee_id, payload)})
                    return

        if path == "/api/transactions" and method == "GET":
            self.send_json({"transactions": self.list_transactions(conn, query)})
            return
        if path == "/api/transactions" and method == "POST":
            transaction = self.create_transaction(conn, user, self.read_json())
            self.send_json({"transaction": transaction}, status=201)
            return

        if path.startswith("/api/transactions/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) >= 3:
                transaction_id = self.parse_int(parts[2], "transaction id")
                if len(parts) == 4 and parts[3] == "receipt" and method == "GET":
                    transaction = self.get_transaction(conn, transaction_id, include_deleted=True)
                    self.send_json({"bill_number": transaction["bill_number"], "html": transaction["receipt_snapshot"]})
                    return
                if len(parts) == 3 and method == "GET":
                    self.send_json({"transaction": self.get_transaction(conn, transaction_id, include_deleted=True)})
                    return
                if len(parts) == 3 and method == "PUT":
                    self.require_roles(user, {"owner", "admin"})
                    transaction = self.update_transaction(conn, user, transaction_id, self.read_json())
                    self.send_json({"transaction": transaction})
                    return
                if len(parts) == 3 and method == "DELETE":
                    self.require_roles(user, {"owner", "admin"})
                    payload = self.read_json(optional=True) or {}
                    self.send_json({"transaction": self.delete_transaction(conn, user, transaction_id, payload)})
                    return

        if path == "/api/logs" and method == "GET":
            self.require_roles(user, {"owner", "admin"})
            limit = self.parse_int(query.get("limit", ["100"])[0], "limit")
            self.send_json({"logs": self.list_logs(conn, limit=min(limit, 300))})
            return

        raise ApiError(404, "Route not found")

    def handle_login(self, conn: sqlite3.Connection) -> None:
        payload = self.read_json()
        username = (payload.get("username") or "").strip()
        password = payload.get("password") or ""
        auto_login = bool(payload.get("auto_login"))
        if not username or not password:
            raise ApiError(400, "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน")

        row = conn.execute(
            "SELECT * FROM users WHERE lower(username) = lower(?)",
            (username,),
        ).fetchone()
        if not row or row["status"] != "active" or not verify_password(password, row["password_hash"]):
            raise ApiError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")

        now = bangkok_now()
        session_token = make_token()
        conn.execute(
            """
            INSERT INTO sessions (session_token, user_id, expires_at, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                session_token,
                row["id"],
                (now + timedelta(days=7)).isoformat(timespec="seconds"),
                now_iso(),
                now_iso(),
            ),
        )
        self.queue_cookie(self.make_cookie(SESSION_COOKIE, session_token, max_age=7 * 24 * 60 * 60, httponly=True))

        if auto_login:
            selector = make_token(10)
            validator = make_token(20)
            remember_value = f"{selector}:{validator}"
            conn.execute(
                """
                INSERT INTO remember_tokens (
                    selector, validator_hash, user_id, auto_login, expires_at, created_at, last_used_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    selector,
                    hash_token(validator),
                    row["id"],
                    1,
                    (now + timedelta(days=30)).isoformat(timespec="seconds"),
                    now_iso(),
                    now_iso(),
                ),
            )
            self.queue_cookie(self.make_cookie(REMEMBER_COOKIE, remember_value, max_age=30 * 24 * 60 * 60, httponly=True))
        else:
            self.queue_cookie(self.make_cookie(REMEMBER_COOKIE, "", max_age=0, httponly=True))

        conn.commit()
        self.send_json(self.build_bootstrap(conn, self.serialize_user(row)))

    def handle_logout(self, conn: sqlite3.Connection, user: dict[str, Any]) -> None:
        cookies = self.parse_cookies()
        session_token = cookies.get(SESSION_COOKIE)
        remember_value = cookies.get(REMEMBER_COOKIE)
        if session_token:
            conn.execute("DELETE FROM sessions WHERE session_token = ?", (session_token,))
        if remember_value and ":" in remember_value:
            selector, _ = remember_value.split(":", 1)
            conn.execute("DELETE FROM remember_tokens WHERE selector = ?", (selector,))
        conn.commit()
        self.queue_cookie(self.make_cookie(SESSION_COOKIE, "", max_age=0, httponly=True))
        self.queue_cookie(self.make_cookie(REMEMBER_COOKIE, "", max_age=0, httponly=True))
        self.send_json({"ok": True, "user": user})

    def handle_receipt_html(self, conn: sqlite3.Connection, path: str) -> None:
        parts = [part for part in path.split("/") if part]
        if len(parts) != 2:
            raise ApiError(404, "Receipt not found")
        transaction_id = self.parse_int(parts[1], "receipt id")
        transaction = self.get_transaction(conn, transaction_id, include_deleted=True)
        content = transaction["receipt_snapshot"].encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        for cookie in self.pending_cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(content)

    def current_user(self, conn: sqlite3.Connection) -> dict[str, Any] | None:
        if self.current_user_cache is not None:
            return self.current_user_cache

        cookies = self.parse_cookies()
        session_token = cookies.get(SESSION_COOKIE)
        if session_token:
            row = conn.execute(
                """
                SELECT s.session_token, s.expires_at, u.*
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.session_token = ?
                """,
                (session_token,),
            ).fetchone()
            if row and row["status"] == "active":
                if datetime.fromisoformat(row["expires_at"]) > bangkok_now():
                    conn.execute(
                        "UPDATE sessions SET last_seen_at = ? WHERE session_token = ?",
                        (now_iso(), session_token),
                    )
                    conn.commit()
                    self.current_user_cache = self.serialize_user(row)
                    return self.current_user_cache
                conn.execute("DELETE FROM sessions WHERE session_token = ?", (session_token,))
                conn.commit()

        remember_value = cookies.get(REMEMBER_COOKIE)
        if remember_value and ":" in remember_value:
            selector, validator = remember_value.split(":", 1)
            row = conn.execute(
                """
                SELECT rt.selector, rt.validator_hash, rt.expires_at, u.*
                FROM remember_tokens rt
                JOIN users u ON u.id = rt.user_id
                WHERE rt.selector = ?
                """,
                (selector,),
            ).fetchone()
            if row and row["status"] == "active":
                valid = datetime.fromisoformat(row["expires_at"]) > bangkok_now()
                if valid and hash_token(validator) == row["validator_hash"]:
                    new_session = make_token()
                    conn.execute(
                        """
                        INSERT INTO sessions (session_token, user_id, expires_at, created_at, last_seen_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            new_session,
                            row["id"],
                            (bangkok_now() + timedelta(days=7)).isoformat(timespec="seconds"),
                            now_iso(),
                            now_iso(),
                        ),
                    )
                    conn.execute(
                        "UPDATE remember_tokens SET last_used_at = ? WHERE selector = ?",
                        (now_iso(), selector),
                    )
                    conn.commit()
                    self.queue_cookie(self.make_cookie(SESSION_COOKIE, new_session, max_age=7 * 24 * 60 * 60, httponly=True))
                    self.current_user_cache = self.serialize_user(row)
                    return self.current_user_cache
            conn.execute("DELETE FROM remember_tokens WHERE selector = ?", (selector,))
            conn.commit()
            self.queue_cookie(self.make_cookie(REMEMBER_COOKIE, "", max_age=0, httponly=True))

        self.current_user_cache = None
        return None

    def require_auth(self, conn: sqlite3.Connection) -> dict[str, Any]:
        user = self.current_user(conn)
        if not user:
            raise ApiError(401, "กรุณาเข้าสู่ระบบ")
        return user

    def require_roles(self, user: dict[str, Any], allowed_roles: set[str]) -> None:
        if user["role"] not in allowed_roles:
            raise ApiError(403, "คุณไม่มีสิทธิ์ดำเนินการนี้")

    def build_bootstrap(self, conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
        return {
            "user": user,
            "settings": self.load_settings(conn),
            "employees": self.list_employees(conn, user),
            "transactions": self.list_transactions(conn, {}),
            "dashboard": self.build_dashboard(conn, "7d"),
            "logs": self.list_logs(conn, 60) if user["role"] in {"owner", "admin"} else [],
            "server_time": now_iso(),
            "version": "1.0.0",
        }

    def load_settings(self, conn: sqlite3.Connection) -> dict[str, Any]:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings = {
            "durian_varieties": DEFAULT_VARIETIES,
            "grade_labels": DEFAULT_GRADE_LABELS,
            "business_profile": DEFAULT_BUSINESS_PROFILE,
        }
        for row in rows:
            settings[row["key"]] = json.loads(row["value"])
        return settings

    def update_settings(self, conn: sqlite3.Connection, user: dict[str, Any], payload: dict[str, Any]) -> None:
        before = self.load_settings(conn)
        updated = dict(before)
        if "durian_varieties" in payload:
            varieties = [str(item).strip() for item in payload["durian_varieties"] if str(item).strip()]
            updated["durian_varieties"] = varieties[:30] or DEFAULT_VARIETIES
        if "grade_labels" in payload:
            grade_labels = [str(item).strip() for item in payload["grade_labels"] if str(item).strip()]
            while len(grade_labels) < 6:
                grade_labels.append(f"เกรด {len(grade_labels) + 1}")
            updated["grade_labels"] = grade_labels[:6]
        if "business_profile" in payload:
            base_profile = dict(before["business_profile"])
            base_profile.update(
                {
                    "booth_name": (payload["business_profile"].get("booth_name") or "").strip()[:120],
                    "owner_name": (payload["business_profile"].get("owner_name") or "").strip()[:120],
                    "phone": (payload["business_profile"].get("phone") or "").strip()[:60],
                    "address": (payload["business_profile"].get("address") or "").strip()[:255],
                    "receipt_note": (payload["business_profile"].get("receipt_note") or "").strip()[:255],
                }
            )
            updated["business_profile"] = base_profile

        for key, value in updated.items():
            upsert_setting(conn, key, value)

        self.insert_audit_log(
            conn,
            actor=user,
            action="update_settings",
            target_type="settings",
            target_id="system",
            before=before,
            after=updated,
        )
        conn.commit()

    def list_employees(self, conn: sqlite3.Connection, user: dict[str, Any]) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT id, username, full_name, nickname, role, id_number, phone, line_id,
                   card_image_path, photo_path, status, created_at, updated_at
            FROM users
            ORDER BY
                CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                full_name COLLATE NOCASE
            """
        ).fetchall()
        employees = [self.serialize_employee(row) for row in rows]
        if user["role"] == "employee":
            return [employee for employee in employees if employee["status"] == "active"]
        return employees

    def get_employee(self, conn: sqlite3.Connection, employee_id: int, user: dict[str, Any]) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (employee_id,)).fetchone()
        if not row:
            raise ApiError(404, "ไม่พบพนักงาน")
        employee = self.serialize_employee(row)
        if user["role"] == "employee" and employee["status"] != "active":
            raise ApiError(403, "คุณไม่มีสิทธิ์ดูข้อมูลนี้")
        return employee

    def create_employee(self, conn: sqlite3.Connection, actor: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        username = (payload.get("username") or "").strip()
        password = payload.get("password") or ""
        full_name = (payload.get("full_name") or "").strip()
        role = (payload.get("role") or "employee").strip().lower()
        if not username or not password or not full_name:
            raise ApiError(400, "กรุณากรอกชื่อผู้ใช้ รหัสผ่าน และชื่อ-นามสกุล")
        if role not in ROLES:
            raise ApiError(400, "บทบาทไม่ถูกต้อง")
        if actor["role"] != "owner" and role == "owner":
            raise ApiError(403, "เฉพาะ Owner เท่านั้นที่สร้างบัญชี Owner ได้")

        now = now_iso()
        card_image_path = self.save_data_url(payload.get("card_image_data_url"), "card")
        photo_path = self.save_data_url(payload.get("photo_image_data_url"), "photo")
        try:
            cursor = conn.execute(
                """
                INSERT INTO users (
                    username, password_hash, full_name, nickname, role, id_number,
                    phone, line_id, card_image_path, photo_path, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                """,
                (
                    username,
                    hash_password(password),
                    full_name,
                    (payload.get("nickname") or "").strip(),
                    role,
                    (payload.get("id_number") or "").strip(),
                    (payload.get("phone") or "").strip(),
                    (payload.get("line_id") or "").strip(),
                    card_image_path,
                    photo_path,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError:
            raise ApiError(409, "ชื่อผู้ใช้นี้ถูกใช้งานแล้ว") from None

        employee = self.get_employee(conn, cursor.lastrowid, actor)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="create_employee",
            target_type="employee",
            target_id=str(employee["id"]),
            before=None,
            after=employee,
        )
        conn.commit()
        return employee

    def update_employee(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        employee_id: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (employee_id,)).fetchone()
        if not row:
            raise ApiError(404, "ไม่พบพนักงาน")
        before = self.serialize_employee(row)
        role = (payload.get("role") or row["role"]).strip().lower()
        if role not in ROLES:
            raise ApiError(400, "บทบาทไม่ถูกต้อง")
        if actor["role"] != "owner" and row["role"] == "owner":
            raise ApiError(403, "เฉพาะ Owner เท่านั้นที่แก้ไข Owner ได้")
        if actor["role"] != "owner" and role == "owner":
            raise ApiError(403, "เฉพาะ Owner เท่านั้นที่เปลี่ยนเป็น Owner ได้")

        card_image_path = row["card_image_path"]
        photo_path = row["photo_path"]
        if payload.get("card_image_data_url"):
            card_image_path = self.save_data_url(payload.get("card_image_data_url"), "card")
        if payload.get("photo_image_data_url"):
            photo_path = self.save_data_url(payload.get("photo_image_data_url"), "photo")
        if actor["id"] == employee_id and payload.get("status") == "suspended":
            raise ApiError(400, "ไม่สามารถระงับตัวเองได้")

        conn.execute(
            """
            UPDATE users
            SET full_name = ?, nickname = ?, role = ?, id_number = ?, phone = ?, line_id = ?,
                card_image_path = ?, photo_path = ?, status = ?, password_hash = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                (payload.get("full_name") or row["full_name"]).strip(),
                (payload.get("nickname") or row["nickname"] or "").strip(),
                role,
                (payload.get("id_number") or row["id_number"] or "").strip(),
                (payload.get("phone") or row["phone"] or "").strip(),
                (payload.get("line_id") or row["line_id"] or "").strip(),
                card_image_path,
                photo_path,
                (payload.get("status") or row["status"]).strip(),
                hash_password(payload["password"]) if payload.get("password") else row["password_hash"],
                now_iso(),
                employee_id,
            ),
        )
        employee = self.get_employee(conn, employee_id, actor)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="update_employee",
            target_type="employee",
            target_id=str(employee_id),
            before=before,
            after=employee,
        )
        conn.commit()
        return employee

    def suspend_employee(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        employee_id: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (employee_id,)).fetchone()
        if not row:
            raise ApiError(404, "ไม่พบพนักงาน")
        if actor["role"] != "owner" and row["role"] == "owner":
            raise ApiError(403, "เฉพาะ Owner เท่านั้นที่ระงับ Owner ได้")
        if actor["id"] == employee_id:
            raise ApiError(400, "ไม่สามารถระงับตัวเองได้")
        before = self.serialize_employee(row)
        next_status = payload.get("status")
        if next_status not in {"active", "suspended"}:
            next_status = "active" if row["status"] == "suspended" else "suspended"
        conn.execute("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", (next_status, now_iso(), employee_id))
        employee = self.get_employee(conn, employee_id, actor)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="suspend_employee" if next_status == "suspended" else "reactivate_employee",
            target_type="employee",
            target_id=str(employee_id),
            before=before,
            after=employee,
        )
        conn.commit()
        return employee

    def delete_employee(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        employee_id: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (employee_id,)).fetchone()
        if not row:
            raise ApiError(404, "ไม่พบพนักงาน")
        if actor["id"] == employee_id:
            raise ApiError(400, "ไม่สามารถลบบัญชีที่กำลังใช้งานอยู่ได้")
        if actor["role"] != "owner" and row["role"] == "owner":
            raise ApiError(403, "เฉพาะ Owner เท่านั้นที่ลบ Owner ได้")
        before = self.serialize_employee(row)
        conn.execute("UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?", (now_iso(), employee_id))
        employee = self.get_employee(conn, employee_id, actor)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="delete_employee",
            target_type="employee",
            target_id=str(employee_id),
            before=before,
            after=employee,
            reason=(payload.get("reason") or "").strip(),
        )
        conn.commit()
        return employee

    def list_transactions(self, conn: sqlite3.Connection, query: dict[str, list[str]] | dict[str, Any]) -> list[dict[str, Any]]:
        from_date = query.get("from", [None])[0] if isinstance(query, dict) else None
        to_date = query.get("to", [None])[0] if isinstance(query, dict) else None
        status = query.get("status", ["active"])[0] if isinstance(query, dict) else "active"
        filters: list[str] = []
        params: list[Any] = []
        if status != "all":
            filters.append("status = ?")
            params.append(status)
        if from_date:
            filters.append("transaction_at >= ?")
            params.append(from_date)
        if to_date:
            filters.append("transaction_at <= ?")
            params.append(to_date)
        where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
        rows = conn.execute(
            f"""
            SELECT *
            FROM transactions
            {where_clause}
            ORDER BY transaction_at DESC, id DESC
            LIMIT 500
            """,
            params,
        ).fetchall()
        return [self.serialize_transaction(conn, row) for row in rows]

    def get_transaction(
        self,
        conn: sqlite3.Connection,
        transaction_id: int,
        include_deleted: bool = False,
    ) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
        if not row:
            raise ApiError(404, "ไม่พบรายการ")
        if not include_deleted and row["status"] != "active":
            raise ApiError(404, "ไม่พบรายการ")
        return self.serialize_transaction(conn, row)

    def create_transaction(self, conn: sqlite3.Connection, actor: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        normalized = self.normalize_transaction_payload(payload, use_current_time=not bool(payload.get("offline_ref")))
        bill_number = self.generate_bill_number(conn, normalized["transaction_at"])
        now = now_iso()
        cursor = conn.execute(
            """
            INSERT INTO transactions (
                bill_number, transaction_at, type, category, subcategory, sale_mode, amount, fruit_count,
                note, status, recorded_by_user_id, recorded_by_name, created_at, updated_at, receipt_snapshot,
                offline_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, '', ?)
            """,
            (
                bill_number,
                normalized["transaction_at"],
                normalized["type"],
                normalized["category"],
                normalized["subcategory"],
                normalized["sale_mode"],
                normalized["amount"],
                normalized["fruit_count"],
                normalized["note"],
                actor["id"],
                actor["display_name"],
                now,
                now,
                (payload.get("offline_ref") or "").strip(),
            ),
        )
        transaction_id = cursor.lastrowid
        self.replace_transaction_items(conn, transaction_id, normalized["items"])
        transaction = self.get_transaction(conn, transaction_id, include_deleted=True)
        conn.execute(
            "UPDATE transactions SET receipt_snapshot = ? WHERE id = ?",
            (self.render_receipt_html(transaction, self.load_settings(conn)), transaction_id),
        )
        transaction = self.get_transaction(conn, transaction_id, include_deleted=True)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="create_transaction",
            target_type="transaction",
            target_id=str(transaction_id),
            before=None,
            after=transaction,
        )
        conn.commit()
        return transaction

    def update_transaction(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        transaction_id: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        existing = self.get_transaction(conn, transaction_id, include_deleted=True)
        if existing["status"] == "deleted":
            raise ApiError(400, "รายการนี้ถูกลบแล้ว")
        normalized = self.normalize_transaction_payload(payload)
        conn.execute(
            """
            UPDATE transactions
            SET transaction_at = ?, type = ?, category = ?, subcategory = ?, sale_mode = ?, amount = ?,
                fruit_count = ?, note = ?, updated_by_user_id = ?, updated_by_name = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                normalized["transaction_at"],
                normalized["type"],
                normalized["category"],
                normalized["subcategory"],
                normalized["sale_mode"],
                normalized["amount"],
                normalized["fruit_count"],
                normalized["note"],
                actor["id"],
                actor["display_name"],
                now_iso(),
                transaction_id,
            ),
        )
        self.replace_transaction_items(conn, transaction_id, normalized["items"])
        updated = self.get_transaction(conn, transaction_id, include_deleted=True)
        conn.execute(
            "UPDATE transactions SET receipt_snapshot = ? WHERE id = ?",
            (self.render_receipt_html(updated, self.load_settings(conn)), transaction_id),
        )
        updated = self.get_transaction(conn, transaction_id, include_deleted=True)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="update_transaction",
            target_type="transaction",
            target_id=str(transaction_id),
            before=existing,
            after=updated,
            reason=(payload.get("reason") or "").strip(),
        )
        conn.commit()
        return updated

    def delete_transaction(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        transaction_id: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        existing = self.get_transaction(conn, transaction_id, include_deleted=True)
        if existing["status"] == "deleted":
            return existing
        conn.execute(
            """
            UPDATE transactions
            SET status = 'deleted', deleted_by_user_id = ?, deleted_by_name = ?, deleted_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (actor["id"], actor["display_name"], now_iso(), now_iso(), transaction_id),
        )
        deleted = self.get_transaction(conn, transaction_id, include_deleted=True)
        self.insert_audit_log(
            conn,
            actor=actor,
            action="delete_transaction",
            target_type="transaction",
            target_id=str(transaction_id),
            before=existing,
            after=deleted,
            reason=(payload.get("reason") or "").strip(),
        )
        conn.commit()
        return deleted

    def replace_transaction_items(
        self,
        conn: sqlite3.Connection,
        transaction_id: int,
        items: list[dict[str, Any]],
    ) -> None:
        conn.execute("DELETE FROM transaction_items WHERE transaction_id = ?", (transaction_id,))
        for index, item in enumerate(items):
            conn.execute(
                """
                INSERT INTO transaction_items (
                    transaction_id, durian_variety, sale_mode, grade_name, weight_kg, price_per_kg,
                    total_price, fruit_count, note, sort_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    item.get("durian_variety"),
                    item.get("sale_mode"),
                    item.get("grade_name"),
                    item.get("weight_kg"),
                    item.get("price_per_kg"),
                    item.get("total_price"),
                    item.get("fruit_count"),
                    item.get("note"),
                    index,
                ),
            )

    def normalize_transaction_payload(
        self,
        payload: dict[str, Any],
        *,
        use_current_time: bool = False,
    ) -> dict[str, Any]:
        transaction_at = now_iso() if use_current_time else self.parse_datetime(payload.get("transaction_at") or now_iso())
        category = (payload.get("category") or "").strip()
        sale_mode = (payload.get("sale_mode") or "").strip() or None
        subcategory = (payload.get("subcategory") or "").strip() or None
        note = (payload.get("note") or "").strip()
        if category not in CATEGORY_LABELS:
            raise ApiError(400, "หมวดหมู่ไม่ถูกต้อง")
        tx_type = "income" if category == "sell_durian" else "expense"

        items: list[dict[str, Any]] = []
        if category in {"buy_durian", "sell_durian"}:
            raw_items = payload.get("items") or []
            if not isinstance(raw_items, list) or not raw_items:
                raise ApiError(400, "กรุณาเพิ่มรายการทุเรียนอย่างน้อย 1 รายการ")
            for item in raw_items:
                items.append(self.normalize_transaction_item(item, category, sale_mode))
        elif payload.get("items"):
            for item in payload.get("items", []):
                items.append(self.normalize_transaction_item(item, category, sale_mode))

        if items:
            amount = round(sum(float(item["total_price"] or 0) for item in items), 2)
            fruit_count = sum(int(item.get("fruit_count") or 0) for item in items) or None
        else:
            amount = round(float(payload.get("amount") or 0), 2)
            fruit_count = int(payload.get("fruit_count") or 0) or None
        if amount <= 0:
            raise ApiError(400, "จำนวนเงินต้องมากกว่า 0")

        return {
            "transaction_at": transaction_at,
            "type": tx_type,
            "category": category,
            "subcategory": subcategory,
            "sale_mode": sale_mode,
            "amount": amount,
            "fruit_count": fruit_count,
            "note": note,
            "items": items,
        }

    def normalize_transaction_item(
        self,
        item: dict[str, Any],
        category: str,
        sale_mode: str | None,
    ) -> dict[str, Any]:
        weight_kg = self.to_float(item.get("weight_kg"))
        price_per_kg = self.to_float(item.get("price_per_kg"))
        total_price = self.to_float(item.get("total_price"))
        filled = [value is not None and value > 0 for value in (weight_kg, price_per_kg, total_price)]
        if sum(filled) < 2:
            raise ApiError(400, "รายการทุเรียนต้องกรอกอย่างน้อย 2 ช่องจาก น้ำหนัก, ราคาต่อกก., ราคารวม")
        if total_price is None and weight_kg is not None and price_per_kg is not None:
            total_price = round(weight_kg * price_per_kg, 2)
        if price_per_kg is None and total_price is not None and weight_kg:
            price_per_kg = round(total_price / weight_kg, 2)
        if weight_kg is None and total_price is not None and price_per_kg:
            weight_kg = round(total_price / price_per_kg, 2)
        durian_variety = (item.get("durian_variety") or "").strip()
        if category in {"buy_durian", "sell_durian"} and not durian_variety:
            raise ApiError(400, "กรุณาเลือกพันธุ์ทุเรียน")
        grade_name = (item.get("grade_name") or "").strip() or None
        if category == "sell_durian" and sale_mode == "graded" and not grade_name:
            raise ApiError(400, "กรุณาเลือกเกรดสำหรับรายการขายแบบคัดเกรด")
        return {
            "durian_variety": durian_variety,
            "sale_mode": sale_mode,
            "grade_name": grade_name,
            "weight_kg": round(weight_kg or 0, 2),
            "price_per_kg": round(price_per_kg or 0, 2),
            "total_price": round(total_price or 0, 2),
            "fruit_count": int(item.get("fruit_count") or 0) or None,
            "note": (item.get("note") or "").strip() or None,
        }

    def build_dashboard(self, conn: sqlite3.Connection, date_range: str) -> dict[str, Any]:
        now = bangkok_now()
        days = 30 if date_range == "30d" else now.day if date_range == "month" else 7
        start_date = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
        rows = conn.execute(
            """
            SELECT *
            FROM transactions
            WHERE status = 'active' AND transaction_at >= ?
            ORDER BY transaction_at DESC
            """,
            (start_date.isoformat(timespec="seconds"),),
        ).fetchall()

        income = expense = purchase_cost = sale_income = 0.0
        category_totals: dict[str, float] = {key: 0.0 for key in CATEGORY_LABELS}
        daily: dict[str, dict[str, float]] = {}
        entry_by_user: dict[str, int] = {}
        for row in rows:
            amount = float(row["amount"] or 0)
            day_key = row["transaction_at"][:10]
            daily.setdefault(day_key, {"income": 0.0, "expense": 0.0})
            entry_by_user[row["recorded_by_name"]] = entry_by_user.get(row["recorded_by_name"], 0) + 1
            category_totals[row["category"]] = category_totals.get(row["category"], 0) + amount
            if row["type"] == "income":
                income += amount
                daily[day_key]["income"] += amount
            else:
                expense += amount
                daily[day_key]["expense"] += amount
            if row["category"] == "buy_durian":
                purchase_cost += amount
            if row["category"] == "sell_durian":
                sale_income += amount

        items = conn.execute(
            """
            SELECT ti.*, t.category
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            WHERE t.status = 'active' AND t.transaction_at >= ?
            """,
            (start_date.isoformat(timespec="seconds"),),
        ).fetchall()
        variety_rollups: dict[str, dict[str, float]] = {}
        for item in items:
            variety = item["durian_variety"] or "ไม่ระบุ"
            bucket = variety_rollups.setdefault(
                variety,
                {"purchase_weight": 0.0, "purchase_amount": 0.0, "sale_weight": 0.0, "sale_amount": 0.0},
            )
            if item["category"] == "buy_durian":
                bucket["purchase_weight"] += float(item["weight_kg"] or 0)
                bucket["purchase_amount"] += float(item["total_price"] or 0)
            if item["category"] == "sell_durian":
                bucket["sale_weight"] += float(item["weight_kg"] or 0)
                bucket["sale_amount"] += float(item["total_price"] or 0)

        top_varieties = sorted(
            (
                {
                    "name": name,
                    "purchase_weight": round(data["purchase_weight"], 2),
                    "purchase_amount": round(data["purchase_amount"], 2),
                    "sale_weight": round(data["sale_weight"], 2),
                    "sale_amount": round(data["sale_amount"], 2),
                    "avg_sale_price_per_kg": round(data["sale_amount"] / data["sale_weight"], 2)
                    if data["sale_weight"]
                    else 0,
                }
                for name, data in variety_rollups.items()
            ),
            key=lambda value: value["sale_amount"] + value["purchase_amount"],
            reverse=True,
        )[:6]

        cashflow = []
        for day_offset in range(days):
            date_key = (start_date + timedelta(days=day_offset)).date().isoformat()
            bucket = daily.get(date_key, {"income": 0.0, "expense": 0.0})
            cashflow.append(
                {
                    "date": date_key,
                    "income": round(bucket["income"], 2),
                    "expense": round(bucket["expense"], 2),
                    "net": round(bucket["income"] - bucket["expense"], 2),
                }
            )

        return {
            "range": date_range,
            "summary": {
                "income": round(income, 2),
                "expense": round(expense, 2),
                "net_profit": round(income - expense, 2),
                "sale_income": round(sale_income, 2),
                "purchase_cost": round(purchase_cost, 2),
                "gross_margin": round(sale_income - purchase_cost, 2),
                "transaction_count": len(rows),
            },
            "cashflow": cashflow,
            "category_breakdown": [
                {"key": key, "label": CATEGORY_LABELS[key], "amount": round(amount, 2)}
                for key, amount in sorted(category_totals.items(), key=lambda item: item[1], reverse=True)
                if amount > 0
            ],
            "top_varieties": top_varieties,
            "entry_by_user": [
                {"name": name, "count": count}
                for name, count in sorted(entry_by_user.items(), key=lambda item: item[1], reverse=True)
            ],
        }

    def list_logs(self, conn: sqlite3.Connection, limit: int) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT *
            FROM audit_logs
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        logs: list[dict[str, Any]] = []
        for row in rows:
            before = json.loads(row["before_json"]) if row["before_json"] else None
            after = json.loads(row["after_json"]) if row["after_json"] else None
            logs.append(
                {
                    "id": row["id"],
                    "actor_name": row["actor_name"],
                    "action": row["action"],
                    "action_label": ACTION_LABELS.get(row["action"], row["action"]),
                    "target_type": row["target_type"],
                    "target_id": row["target_id"],
                    "before": before,
                    "after": after,
                    "summary": self.summarize_audit_target(row["target_type"], after or before),
                    "before_summary": self.summarize_audit_target(row["target_type"], before),
                    "after_summary": self.summarize_audit_target(row["target_type"], after),
                    "reason": row["reason"],
                    "created_at": row["created_at"],
                }
            )
        return logs

    def summarize_audit_target(self, target_type: str, payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None
        if target_type == "transaction":
            return self.summarize_transaction_for_log(payload)
        if target_type == "employee":
            return self.summarize_employee_for_log(payload)
        if target_type == "settings":
            return self.summarize_settings_for_log(payload)
        return {
            "headline": f"{target_type} #{payload.get('id') or payload.get('target_id') or '-'}",
            "meta": [],
            "details": [],
        }

    def summarize_transaction_for_log(self, payload: dict[str, Any]) -> dict[str, Any]:
        category_label = payload.get("category_label") or CATEGORY_LABELS.get(payload.get("category"), "รายการ")
        bill_number = payload.get("bill_number") or f"รายการ #{payload.get('id', '-')}"
        amount = float(payload.get("amount") or 0)
        meta: list[str] = []
        if payload.get("transaction_at"):
            meta.append(f"เวลา {self.format_display_datetime(payload['transaction_at'])}")
        if payload.get("recorded_by_name"):
            meta.append(f"ผู้บันทึก {payload['recorded_by_name']}")
        details = [
            self.describe_transaction_item_for_log(item, category_label)
            for item in payload.get("items") or []
        ]
        if not details:
            details = [f"{category_label} รวม {amount:,.2f} บาท"]
        if payload.get("note"):
            details.append(f"หมายเหตุ: {payload['note']}")
        return {
            "headline": f"{bill_number} • {category_label} • {amount:,.2f} บาท",
            "meta": meta,
            "details": details,
        }

    def describe_transaction_item_for_log(self, item: dict[str, Any], fallback_label: str) -> str:
        description = item.get("durian_variety") or fallback_label
        if item.get("grade_name"):
            description = f"{description} / {item['grade_name']}"
        info_parts: list[str] = []
        if item.get("fruit_count"):
            info_parts.append(f"{int(item['fruit_count'])} ลูก")
        if item.get("weight_kg"):
            info_parts.append(f"{float(item['weight_kg']):,.2f} กก.")
        if item.get("price_per_kg"):
            info_parts.append(f"{float(item['price_per_kg']):,.2f} บาท/กก.")
        info_parts.append(f"รวม {float(item.get('total_price') or 0):,.2f} บาท")
        if item.get("note"):
            info_parts.append(f"โน้ต {item['note']}")
        return f"{description} • {' • '.join(info_parts)}"

    def summarize_employee_for_log(self, payload: dict[str, Any]) -> dict[str, Any]:
        headline = f"{payload.get('full_name') or payload.get('username') or 'พนักงาน'} • {payload.get('role', '-')}"
        details = [
            f"username {payload.get('username') or '-'}",
            f"สถานะ {payload.get('status') or '-'}",
        ]
        if payload.get("phone"):
            details.append(f"โทร {payload['phone']}")
        if payload.get("line_id"):
            details.append(f"Line {payload['line_id']}")
        if payload.get("id_number"):
            details.append(f"เลขบัตร/พาสปอร์ต {payload['id_number']}")
        return {"headline": headline, "meta": [], "details": details}

    def summarize_settings_for_log(self, payload: dict[str, Any]) -> dict[str, Any]:
        profile = payload.get("business_profile") or {}
        varieties = payload.get("durian_varieties") or []
        return {
            "headline": profile.get("booth_name") or "ตั้งค่าระบบ",
            "meta": [],
            "details": [
                f"เจ้าของ {profile.get('owner_name') or '-'}",
                f"พันธุ์ทุเรียน {', '.join(varieties[:6]) or '-'}",
            ],
        }

    def insert_audit_log(
        self,
        conn: sqlite3.Connection,
        actor: dict[str, Any],
        action: str,
        target_type: str,
        target_id: str,
        before: Any,
        after: Any,
        reason: str | None = None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO audit_logs (
                actor_user_id, actor_name, action, target_type, target_id,
                before_json, after_json, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                actor["id"],
                actor["display_name"],
                action,
                target_type,
                target_id,
                json.dumps(before, ensure_ascii=False) if before is not None else None,
                json.dumps(after, ensure_ascii=False) if after is not None else None,
                reason,
                now_iso(),
            ),
        )

    def mapping_get(self, row: sqlite3.Row | dict[str, Any], key: str, default: Any = None) -> Any:
        if isinstance(row, sqlite3.Row):
            return row[key] if key in row.keys() else default
        return row.get(key, default)

    def serialize_user(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        nickname = (self.mapping_get(row, "nickname", "") or "").strip()
        full_name = (self.mapping_get(row, "full_name", "") or "").strip()
        return {
            "id": self.mapping_get(row, "id"),
            "username": self.mapping_get(row, "username"),
            "full_name": full_name,
            "nickname": nickname,
            "display_name": nickname or full_name or self.mapping_get(row, "username"),
            "role": self.mapping_get(row, "role"),
            "status": self.mapping_get(row, "status"),
        }

    def serialize_employee(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        employee = self.serialize_user(row)
        employee.update(
            {
                "id_number": self.mapping_get(row, "id_number"),
                "phone": self.mapping_get(row, "phone"),
                "line_id": self.mapping_get(row, "line_id"),
                "card_image_url": self.as_public_url(self.mapping_get(row, "card_image_path")),
                "photo_image_url": self.as_public_url(self.mapping_get(row, "photo_image_path")),
                "created_at": self.mapping_get(row, "created_at"),
                "updated_at": self.mapping_get(row, "updated_at"),
            }
        )
        return employee

    def serialize_transaction(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        items = conn.execute(
            """
            SELECT *
            FROM transaction_items
            WHERE transaction_id = ?
            ORDER BY sort_order ASC, id ASC
            """,
            (row["id"],),
        ).fetchall()
        return {
            "id": row["id"],
            "bill_number": row["bill_number"],
            "transaction_at": row["transaction_at"],
            "type": row["type"],
            "type_label": TYPE_LABELS[row["type"]],
            "category": row["category"],
            "category_label": CATEGORY_LABELS[row["category"]],
            "subcategory": row["subcategory"],
            "sale_mode": row["sale_mode"],
            "amount": round(float(row["amount"] or 0), 2),
            "fruit_count": row["fruit_count"],
            "note": row["note"],
            "status": row["status"],
            "recorded_by_user_id": row["recorded_by_user_id"],
            "recorded_by_name": row["recorded_by_name"],
            "updated_by_name": row["updated_by_name"],
            "deleted_by_name": row["deleted_by_name"],
            "deleted_at": row["deleted_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "receipt_snapshot": row["receipt_snapshot"],
            "offline_source": row["offline_source"],
            "items": [
                {
                    "id": item["id"],
                    "durian_variety": item["durian_variety"],
                    "sale_mode": item["sale_mode"],
                    "grade_name": item["grade_name"],
                    "weight_kg": round(float(item["weight_kg"] or 0), 2),
                    "price_per_kg": round(float(item["price_per_kg"] or 0), 2),
                    "total_price": round(float(item["total_price"] or 0), 2),
                    "fruit_count": item["fruit_count"],
                    "note": item["note"],
                }
                for item in items
            ],
        }

    def render_receipt_html(self, transaction: dict[str, Any], settings: dict[str, Any]) -> str:
        profile = settings.get("business_profile") or DEFAULT_BUSINESS_PROFILE
        type_badge = "รายรับ" if transaction["type"] == "income" else "รายจ่าย"
        item_rows: list[str] = []
        for index, item in enumerate(transaction["items"], start=1):
            description = item["durian_variety"] or transaction["category_label"]
            if item.get("grade_name"):
                description = f"{description} / {item['grade_name']}"
            item_rows.append(
                f"""
                <tr>
                    <td>{index}</td>
                    <td>{html.escape(description)}</td>
                    <td>{item.get('fruit_count') or '-'}</td>
                    <td>{item.get('weight_kg') or 0:.2f}</td>
                    <td>{item.get('price_per_kg') or 0:.2f}</td>
                    <td>{item.get('total_price') or 0:.2f}</td>
                </tr>
                """
            )
        if not item_rows:
            item_rows.append(
                f"""
                <tr>
                    <td>1</td>
                    <td>{html.escape(transaction["category_label"])}</td>
                    <td>{transaction.get("fruit_count") or '-'}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>{transaction["amount"]:.2f}</td>
                </tr>
                """
            )
        note = html.escape(transaction.get("note") or "-")
        return f"""<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>บิล {html.escape(transaction['bill_number'])}</title>
    <style>
        body {{
            margin: 0;
            background: linear-gradient(180deg, #f4f8ec 0%, #fffdf8 100%);
            color: #17311f;
            font-family: "Leelawadee UI", "Segoe UI", "Noto Sans Thai", sans-serif;
            padding: 24px;
        }}
        .sheet {{
            max-width: 840px;
            margin: 0 auto;
            background: #ffffff;
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 24px 60px rgba(15, 56, 28, 0.12);
        }}
        .hero {{
            display: flex;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 24px;
        }}
        .title {{
            font-size: 28px;
            font-weight: 800;
            margin: 0 0 6px;
        }}
        .subtitle {{
            margin: 0;
            color: #55715f;
        }}
        .pill {{
            display: inline-flex;
            padding: 8px 14px;
            border-radius: 999px;
            background: #eaf6c8;
            color: #31520f;
            font-weight: 700;
        }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 14px;
            margin-bottom: 24px;
        }}
        .card {{
            background: #f7faf1;
            border: 1px solid #e3ebd3;
            border-radius: 18px;
            padding: 14px 16px;
        }}
        .label {{
            color: #55715f;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }}
        .value {{
            margin-top: 8px;
            font-size: 16px;
            font-weight: 700;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
        }}
        th, td {{
            padding: 12px 10px;
            border-bottom: 1px solid #edf2e2;
            text-align: left;
            font-size: 14px;
        }}
        th {{
            color: #55715f;
        }}
        .total {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 22px;
            padding: 18px 20px;
            border-radius: 18px;
            background: linear-gradient(135deg, #1f6a37 0%, #2f8f46 100%);
            color: white;
            font-size: 18px;
            font-weight: 800;
        }}
        .note {{
            margin-top: 18px;
            padding: 16px;
            border-radius: 16px;
            background: #fff8e7;
            color: #77591f;
        }}
        @media print {{
            body {{
                background: white;
                padding: 0;
            }}
            .sheet {{
                box-shadow: none;
                border-radius: 0;
            }}
        }}
    </style>
</head>
<body>
    <div class="sheet">
        <div class="hero">
            <div>
                <h1 class="title">{html.escape(profile.get('booth_name') or 'แผงขายทุเรียน')}</h1>
                <p class="subtitle">บิลเลขที่ {html.escape(transaction['bill_number'])}</p>
                <p class="subtitle">{html.escape(profile.get('address') or 'พร้อมใช้งานทั้งหน้าร้านและหน้างาน')}</p>
            </div>
            <div class="pill">{type_badge}</div>
        </div>
        <div class="grid">
            <div class="card"><div class="label">วันที่บันทึก</div><div class="value">{html.escape(self.format_display_datetime(transaction['transaction_at']))}</div></div>
            <div class="card"><div class="label">หมวดหมู่</div><div class="value">{html.escape(transaction['category_label'])}</div></div>
            <div class="card"><div class="label">ผู้บันทึก</div><div class="value">{html.escape(transaction['recorded_by_name'])}</div></div>
            <div class="card"><div class="label">ติดต่อ</div><div class="value">{html.escape(profile.get('phone') or '-')}</div></div>
        </div>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>รายการ</th>
                    <th>จำนวนลูก</th>
                    <th>น้ำหนัก (กก.)</th>
                    <th>ราคาต่อกก.</th>
                    <th>รวม</th>
                </tr>
            </thead>
            <tbody>{''.join(item_rows)}</tbody>
        </table>
        <div class="total"><span>ยอดรวมสุทธิ</span><span>{transaction['amount']:.2f} บาท</span></div>
        <div class="note"><strong>หมายเหตุ:</strong> {note}<br><span>{html.escape(profile.get('receipt_note') or '')}</span></div>
    </div>
</body>
</html>"""

    def generate_bill_number(self, conn: sqlite3.Connection, transaction_at: str) -> str:
        date_key = transaction_at[:10].replace("-", "")
        prefix = f"DR-{date_key}"
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM transactions WHERE bill_number LIKE ?",
            (f"{prefix}-%",),
        ).fetchone()["count"]
        return f"{prefix}-{count + 1:04d}"

    def send_json(self, payload: Any, status: int = 200) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        for cookie in self.pending_cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(content)

    def serve_uploaded_file(self, path: str) -> None:
        safe_name = os.path.basename(path.removeprefix("/uploads/"))
        self.serve_file(UPLOADS_DIR / safe_name)

    def serve_file(self, file_path: Path, cache_control: str | None = "public, max-age=86400") -> None:
        if not file_path.exists() or not file_path.is_file():
            raise ApiError(404, "ไม่พบไฟล์")
        content = file_path.read_bytes()
        mime_type, _ = mimetypes.guess_type(str(file_path))
        self.send_response(200)
        self.send_header("Content-Type", mime_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        for cookie in self.pending_cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(content)

    def queue_cookie(self, cookie_value: str) -> None:
        self.pending_cookies.append(cookie_value)

    def request_scheme(self) -> str:
        forwarded_proto = (self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
        if forwarded_proto in {"http", "https"}:
            return forwarded_proto
        if PUBLIC_BASE_URL.startswith("https://"):
            return "https"
        return "http"

    def public_origin(self) -> str | None:
        if PUBLIC_BASE_URL:
            return PUBLIC_BASE_URL
        host = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",", 1)[0].strip()
        if not host:
            return None
        return f"{self.request_scheme()}://{host}"

    def build_public_url(self, path: str) -> str:
        normalized = path if path.startswith("/") else f"/{path}"
        origin = self.public_origin()
        return f"{origin}{normalized}" if origin else normalized

    def should_use_secure_cookies(self) -> bool:
        return FORCE_SECURE_COOKIES or self.request_scheme() == "https"

    def make_cookie(
        self,
        name: str,
        value: str,
        *,
        max_age: int,
        httponly: bool,
        path: str = "/",
    ) -> str:
        cookie = SimpleCookie()
        cookie[name] = value
        cookie[name]["path"] = path
        cookie[name]["max-age"] = max_age
        cookie[name]["samesite"] = "Lax"
        if httponly:
            cookie[name]["httponly"] = True
        if self.should_use_secure_cookies():
            cookie[name]["secure"] = True
        return cookie.output(header="", sep="").strip()

    def parse_cookies(self) -> dict[str, str]:
        raw = self.headers.get("Cookie") or ""
        cookie = SimpleCookie()
        cookie.load(raw)
        return {key: morsel.value for key, morsel in cookie.items()}

    def read_json(self, optional: bool = False) -> dict[str, Any] | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            if optional:
                return None
            raise ApiError(400, "ไม่พบข้อมูลคำขอ")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ApiError(400, f"รูปแบบ JSON ไม่ถูกต้อง: {error}") from None

    def parse_int(self, value: str, field_name: str) -> int:
        try:
            return int(value)
        except ValueError:
            raise ApiError(400, f"{field_name} ไม่ถูกต้อง") from None

    def to_float(self, value: Any) -> float | None:
        if value in (None, "", False):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            raise ApiError(400, "ตัวเลขไม่ถูกต้อง") from None

    def parse_datetime(self, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            raise ApiError(400, "วันที่เวลาไม่ถูกต้อง") from None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=TIMEZONE)
        return parsed.astimezone(TIMEZONE).isoformat(timespec="seconds")

    def format_display_datetime(self, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=TIMEZONE)
        localized = parsed.astimezone(TIMEZONE)
        return localized.strftime("%d/%m/%Y %H:%M")

    def save_data_url(self, data_url: str | None, prefix: str) -> str | None:
        if not data_url:
            return None
        if not data_url.startswith("data:") or "," not in data_url:
            raise ApiError(400, "รูปภาพไม่ถูกต้อง")
        header, encoded = data_url.split(",", 1)
        try:
            binary = base64.b64decode(encoded)
        except ValueError:
            raise ApiError(400, "รูปภาพไม่ถูกต้อง") from None
        extension = "png"
        if "jpeg" in header:
            extension = "jpg"
        elif "webp" in header:
            extension = "webp"
        filename = f"{prefix}-{uuid4().hex}.{extension}"
        (UPLOADS_DIR / filename).write_bytes(binary)
        return filename

    def as_public_url(self, file_name: str | None) -> str | None:
        return self.build_public_url(f"/uploads/{file_name}") if file_name else None
