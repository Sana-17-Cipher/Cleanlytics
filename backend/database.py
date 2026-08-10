from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL or os.getenv("USE_SQLITE", "false").lower() == "true":
    DATABASE_URL = "sqlite:///./cleanytics.db"

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    try:
        engine = create_engine(DATABASE_URL)
        with engine.connect() as conn:
            pass
    except Exception as e:
        print(f"Warning: Remote database connection failed ({e}). Falling back to SQLite.")
        DATABASE_URL = "sqlite:///./cleanytics.db"
        engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

