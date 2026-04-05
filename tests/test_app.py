import json
import os
import threading
import tempfile
import time
import unittest
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib import request

import durian_bank.db as db_module
from durian_bank.db import init_db
from durian_bank.server import DurianBankHandler


class DurianBankSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        temp_root = Path(cls.temp_dir.name)
        cls.original_paths = {
            "data_dir": db_module.DATA_DIR,
            "uploads_dir": db_module.UPLOADS_DIR,
            "database_path": db_module.DATABASE_PATH,
        }
        cls.original_env = {
            "DURIAN_BANK_OWNER_USERNAME": os.environ.get("DURIAN_BANK_OWNER_USERNAME"),
            "DURIAN_BANK_OWNER_PASSWORD": os.environ.get("DURIAN_BANK_OWNER_PASSWORD"),
            "DURIAN_BANK_OWNER_NAME": os.environ.get("DURIAN_BANK_OWNER_NAME"),
            "DURIAN_BANK_OWNER_NICKNAME": os.environ.get("DURIAN_BANK_OWNER_NICKNAME"),
        }
        db_module.DATA_DIR = temp_root / "data"
        db_module.UPLOADS_DIR = db_module.DATA_DIR / "uploads"
        db_module.DATABASE_PATH = db_module.DATA_DIR / "durian_bank-test.sqlite3"
        os.environ["DURIAN_BANK_OWNER_USERNAME"] = "owner_test"
        os.environ["DURIAN_BANK_OWNER_PASSWORD"] = "pass-test-9876"
        os.environ["DURIAN_BANK_OWNER_NAME"] = "เจ้าของทดสอบ"
        os.environ["DURIAN_BANK_OWNER_NICKNAME"] = "ทดสอบ"
        init_db()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 8877), DurianBankHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        db_module.DATA_DIR = cls.original_paths["data_dir"]
        db_module.UPLOADS_DIR = cls.original_paths["uploads_dir"]
        db_module.DATABASE_PATH = cls.original_paths["database_path"]
        for key, value in cls.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.temp_dir.cleanup()

    def setUp(self):
        self.cookies = {}

    def api(self, method, path, payload=None):
        body = None
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in self.cookies.items())
        req = request.Request(f"http://127.0.0.1:8877{path}", method=method, data=body, headers=headers)
        with request.urlopen(req) as response:
            for raw_cookie in response.headers.get_all("Set-Cookie") or []:
                cookie = SimpleCookie()
                cookie.load(raw_cookie)
                for key, morsel in cookie.items():
                    self.cookies[key] = morsel.value
            return json.loads(response.read().decode("utf-8"))

    def test_login_and_create_transaction(self):
        login = self.api("POST", "/api/auth/login", {"username": "owner_test", "password": "pass-test-9876"})
        self.assertEqual(login["user"]["username"], "owner_test")

        transaction = self.api(
            "POST",
            "/api/transactions",
            {
                "category": "sell_durian",
                "sale_mode": "graded",
                "note": "ทดสอบระบบ",
                "items": [
                    {
                        "durian_variety": "หมอนทอง",
                        "grade_name": "เกรด A",
                        "weight_kg": 10,
                        "price_per_kg": 220,
                        "fruit_count": 4,
                    }
                ],
            },
        )["transaction"]

        self.assertEqual(transaction["amount"], 2200.0)
        self.assertEqual(transaction["type"], "income")
        self.assertIn("receipt_snapshot", transaction)
        self.assertIn("แผงขายทุเรียน", transaction["receipt_snapshot"])

        logs = self.api("GET", "/api/logs?limit=5")["logs"]
        self.assertEqual(logs[0]["action"], "create_transaction")
        self.assertIn("2,200.00", logs[0]["summary"]["headline"])
        self.assertTrue(logs[0]["summary"]["details"])


if __name__ == "__main__":
    unittest.main()
