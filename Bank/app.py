import os

from durian_bank.server import run


if __name__ == "__main__":
    host = (os.getenv("HOST") or os.getenv("DURIAN_BANK_HOST") or "0.0.0.0").strip() or "0.0.0.0"
    port = int((os.getenv("PORT") or os.getenv("DURIAN_BANK_PORT") or "8000").strip() or "8000")
    run(host=host, port=port)
