from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .security import hash_password


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path((os.getenv("DURIAN_BANK_DATA_DIR") or "").strip() or (PROJECT_ROOT / "data"))
UPLOADS_DIR = DATA_DIR / "uploads"
DATABASE_PATH = DATA_DIR / "durian_bank.sqlite3"
DB_TIMEOUT_SECONDS = int((os.getenv("DURIAN_BANK_DB_TIMEOUT_SECONDS") or "30").strip() or "30")
DB_BUSY_TIMEOUT_MS = int((os.getenv("DURIAN_BANK_DB_BUSY_TIMEOUT_MS") or "5000").strip() or "5000")
try:
    TIMEZONE = ZoneInfo("Asia/Bangkok")
except ZoneInfoNotFoundError:
    TIMEZONE = timezone(timedelta(hours=7))

DEFAULT_VARIETIES = [
    "หมอนทอง",
    "ชะนี",
    "ก้านยาว",
    "พวงมณี",
    "กระดุมทอง",
    "หลงลับแล",
    "หลินลับแล",
    "นวลทองจันทร์",
]

DEFAULT_GRADE_LABELS = ["เกรด A", "เกรด B", "เกรด C", "เกรด D", "ตกไซซ์", "คละ"]

DEFAULT_BUSINESS_PROFILE = {
    "booth_name": "แผงขายทุเรียน",
    "owner_name": "เจ้าของแผง",
    "phone": "",
    "address": "",
    "receipt_note": "ขอบคุณที่อุดหนุน ทุกรายการถูกบันทึกเข้าระบบเรียบร้อยแล้ว",
}


def bangkok_now() -> datetime:
    return datetime.now(TIMEZONE)


def now_iso() -> str:
    return bangkok_now().isoformat(timespec="seconds")


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def connect_db() -> sqlite3.Connection:
    ensure_storage()
    conn = sqlite3.connect(DATABASE_PATH, timeout=DB_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute(f"PRAGMA busy_timeout = {DB_BUSY_TIMEOUT_MS}")
    return conn


def init_db() -> None:
    ensure_storage()
    conn = connect_db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                nickname TEXT,
                role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'employee')),
                id_number TEXT,
                phone TEXT,
                line_id TEXT,
                card_image_path TEXT,
                photo_path TEXT,
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_token TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS remember_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                selector TEXT NOT NULL UNIQUE,
                validator_hash TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                auto_login INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bill_number TEXT NOT NULL UNIQUE,
                transaction_at TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
                category TEXT NOT NULL,
                subcategory TEXT,
                sale_mode TEXT,
                amount REAL NOT NULL DEFAULT 0,
                fruit_count INTEGER,
                note TEXT,
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
                recorded_by_user_id INTEGER NOT NULL,
                recorded_by_name TEXT NOT NULL,
                updated_by_user_id INTEGER,
                updated_by_name TEXT,
                deleted_by_user_id INTEGER,
                deleted_by_name TEXT,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                receipt_snapshot TEXT,
                offline_source TEXT,
                FOREIGN KEY(recorded_by_user_id) REFERENCES users(id),
                FOREIGN KEY(updated_by_user_id) REFERENCES users(id),
                FOREIGN KEY(deleted_by_user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS transaction_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id INTEGER NOT NULL,
                durian_variety TEXT,
                sale_mode TEXT,
                grade_name TEXT,
                weight_kg REAL,
                price_per_kg REAL,
                total_price REAL NOT NULL DEFAULT 0,
                fruit_count INTEGER,
                note TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER NOT NULL,
                actor_name TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                reason TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(actor_user_id) REFERENCES users(id)
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_transaction_at ON transactions(transaction_at);
            CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
            """
        )
        seed_defaults(conn)
        conn.commit()
    finally:
        conn.close()


def seed_defaults(conn: sqlite3.Connection) -> None:
    now = now_iso()
    existing = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
    if existing == 0:
        bootstrap_owner = get_bootstrap_owner()
        if bootstrap_owner:
            conn.executemany(
                """
                INSERT INTO users (
                    username, password_hash, full_name, nickname, role, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        username,
                        password_hash,
                        full_name,
                        nickname,
                        role,
                        status,
                        now,
                        now,
                    )
                    for username, password_hash, full_name, nickname, role, status in [bootstrap_owner]
                ],
            )

    ensure_setting(conn, "durian_varieties", DEFAULT_VARIETIES)
    ensure_setting(conn, "grade_labels", DEFAULT_GRADE_LABELS)
    ensure_setting(conn, "business_profile", DEFAULT_BUSINESS_PROFILE)


def upsert_setting(conn: sqlite3.Connection, key: str, value: object) -> None:
    conn.execute(
        """
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (key, json.dumps(value, ensure_ascii=False), now_iso()),
    )


def ensure_setting(conn: sqlite3.Connection, key: str, value: object) -> None:
    conn.execute(
        """
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
        """,
        (key, json.dumps(value, ensure_ascii=False), now_iso()),
    )


def get_bootstrap_owner() -> tuple[str, str, str, str, str, str] | None:
    username = (os.getenv("DURIAN_BANK_OWNER_USERNAME") or "").strip()
    password = os.getenv("DURIAN_BANK_OWNER_PASSWORD") or ""
    if not username and not password:
        return None
    if not username or not password:
        raise RuntimeError(
            "Set both DURIAN_BANK_OWNER_USERNAME and DURIAN_BANK_OWNER_PASSWORD before the first run."
        )
    full_name = (os.getenv("DURIAN_BANK_OWNER_NAME") or "เจ้าของระบบ").strip() or "เจ้าของระบบ"
    nickname = (os.getenv("DURIAN_BANK_OWNER_NICKNAME") or "Owner").strip() or "Owner"
    return (username, hash_password(password), full_name, nickname, "owner", "active")
