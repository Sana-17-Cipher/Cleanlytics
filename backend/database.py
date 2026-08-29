"""
CLEANYTICS - metadata database connection.

Holds project and table metadata only. Uploaded rows live in per-project DuckDB
files managed by `store.py`.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_SQLITE = f"sqlite:///{(BACKEND_DIR / 'data' / 'cleanytics.db').as_posix()}"

DATABASE_URL = os.getenv("DATABASE_URL") or DEFAULT_SQLITE
if os.getenv("USE_SQLITE", "").lower() == "true":
    DATABASE_URL = DEFAULT_SQLITE

if DATABASE_URL.startswith("sqlite"):
    (BACKEND_DIR / "data").mkdir(parents=True, exist_ok=True)
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    """
    Turn on foreign key enforcement for SQLite.

    SQLite ignores ON DELETE CASCADE unless this pragma is set for the
    connection. Without it, deleting a table left its relationships behind
    pointing at a row that no longer existed, and they reappeared on reload.
    """
    if DATABASE_URL.startswith("sqlite"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
