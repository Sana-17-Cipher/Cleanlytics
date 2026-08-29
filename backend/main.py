"""
CLEANYTICS API.

Rows never travel through this layer in bulk. Uploads stream to disk and go
straight into DuckDB; everything the client receives afterwards is either a
bounded page of rows or an aggregate. That is what keeps a 100 MB file workable
end to end.
"""

from __future__ import annotations

import os
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

import store
from analysis import model as model_engine
from analysis import operations, quality, relationships
from analysis.profiler import profile_table
from database import Base, SessionLocal, engine, get_db
from models import DataTable, Dashboard, OperationLog, Project, TableRelationship, User

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
JWT_SECRET = os.getenv("JWT_SECRET", "").strip()
JWT_ALGORITHM = "HS256"
TOKEN_TTL = timedelta(days=7)



ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if origin.strip()
]

# Sign-in is enforced when EITHER Supabase JWT secret OR Google+JWT are configured.
# Supabase auth is preferred when its secret is set.
AUTH_ENABLED = bool(
    SUPABASE_URL or (GOOGLE_CLIENT_ID and JWT_SECRET)
)

GUEST_GOOGLE_ID = "local-workspace"


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    if not AUTH_ENABLED:
        db = SessionLocal()
        try:
            _ensure_guest(db)
        finally:
            db.close()
    yield


app = FastAPI(title="CLEANYTICS API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# ─── Authentication ──────────────────────────────────────────────────────────


def _ensure_guest(db: Session) -> User:
    guest = db.query(User).filter(User.google_id == GUEST_GOOGLE_ID).first()
    if not guest:
        guest = User(
            google_id=GUEST_GOOGLE_ID,
            email="local@cleanytics.app",
            name="Local Workspace",
            is_guest=True,
        )
        db.add(guest)
        db.commit()
        db.refresh(guest)
    return guest


def create_access_token(user: User) -> str:
    from jose import jwt

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "exp": datetime.now(timezone.utc) + TOKEN_TTL,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def current_user(
    authorization: Optional[str] = Header(None), db: Session = Depends(get_db)
) -> User:
    """
    Resolve the caller.

    Supports two auth modes:
    1. Supabase JWT (preferred): verified via SUPABASE_JWT_SECRET using PyJWT.
       The Supabase `sub` (user UUID) is mapped to a local User row, creating
       one on first contact.
    2. Legacy internal JWT: verified via JWT_SECRET using python-jose.
       Kept for backward compatibility.

    When neither is configured, a shared local workspace is used openly.
    """
    if not AUTH_ENABLED:
        return _ensure_guest(db)

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.")

    token = authorization.split(" ", 1)[1].strip()

     # ── Supabase JWT path ────────────────────────────────────────────────
    if SUPABASE_URL:
        import jwt as pyjwt
        from jwt import PyJWKClient

        try:
            # Supabase publishes the public signing keys for JWT verification.
            jwks_url = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"

            jwk_client = PyJWKClient(jwks_url)
            signing_key = jwk_client.get_signing_key_from_jwt(token)

            payload = pyjwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                audience="authenticated",
                issuer=f"{SUPABASE_URL}/auth/v1",
            )

        except pyjwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=401,
                detail="Your session has expired. Sign in again.",
            )

        except pyjwt.InvalidTokenError as exc:
            print(
                f"[AUTH DEBUG] Supabase JWT verification failed: "
                f"{type(exc).__name__}: {exc}"
            )
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication token.",
            )

        except Exception as exc:
            print(
                f"[AUTH DEBUG] Supabase JWKS verification failed: "
                f"{type(exc).__name__}: {exc}"
            )
            raise HTTPException(
                status_code=401,
                detail="Unable to verify authentication token.",
            )

        supabase_uid = payload.get("sub", "")
        email = payload.get("email", "")

        if not supabase_uid:
            raise HTTPException(
                status_code=401,
                detail="Malformed token: missing subject.",
            )

        # Find or create the local user record keyed on the Supabase user ID.
        user = db.query(User).filter(User.google_id == supabase_uid).first()

        if user:
            user.last_login = datetime.now(timezone.utc)
            db.commit()
        else:
            user = User(
                google_id=supabase_uid,
                email=email,
                name=email.split("@")[0] if email else "User",
                is_guest=False,
            )
            db.add(user)
            db.commit()
            db.refresh(user)

        return user
    # ── Legacy internal JWT path ─────────────────────────────────────────
    from jose import JWTError, jwt

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")

    user = db.query(User).filter(User.id == int(payload.get("sub", 0))).first()
    if not user:
        raise HTTPException(status_code=401, detail="This account no longer exists.")
    return user


def owned_project(project_id: int, db: Session, user: User) -> Project:
    """
    Fetch a project the caller owns.

    Every project-scoped route goes through this. Previously only a handful of
    endpoints checked ownership at all, so table and relationship routes would
    happily serve another user's data as soon as sign-in started working.
    """
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.user_id == user.id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


def owned_table(project: Project, table_id: int, db: Session) -> DataTable:
    table = (
        db.query(DataTable)
        .filter(DataTable.id == table_id, DataTable.project_id == project.id)
        .first()
    )
    if not table:
        raise HTTPException(status_code=404, detail="Table not found.")
    return table


# ─── Serialisation ───────────────────────────────────────────────────────────


def table_summary(table: DataTable) -> Dict[str, Any]:
    profile = table.profile or {}
    return {
        "id": table.id,
        "table_name": table.table_name,
        "source_file": table.source_file,
        "source_sheet": table.source_sheet,
        "row_count": table.row_count,
        "column_count": table.column_count,
        "columns": [
            {
                "name": c["name"],
                "logical_type": c["logical_type"],
                "semantic_role": c["semantic_role"],
                "subtype": c.get("subtype"),
                "default_aggregation": c.get("default_aggregation"),
                "additivity": c.get("additivity"),
                "null_ratio": c.get("null_ratio"),
                "distinct_count": c.get("distinct_count"),
                "is_unique": c.get("is_unique"),
            }
            for c in profile.get("columns", [])
        ],
        "summary": profile.get("summary"),
        "quality": table.quality,
        "created_at": table.created_at.isoformat() if table.created_at else None,
        "updated_at": table.updated_at.isoformat() if table.updated_at else None,
    }


def relationship_payload(rel: TableRelationship, names: Dict[int, str]) -> Dict[str, Any]:
    return {
        "id": rel.id,
        "from_table_id": rel.from_table_id,
        "from_table_name": names.get(rel.from_table_id, f"Table {rel.from_table_id}"),
        "from_column": rel.from_column,
        "to_table_id": rel.to_table_id,
        "to_table_name": names.get(rel.to_table_id, f"Table {rel.to_table_id}"),
        "to_column": rel.to_column,
        "cardinality": rel.cardinality,
        "cardinality_label": relationships.CARDINALITY_LABEL.get(rel.cardinality, rel.cardinality),
        "confidence": rel.confidence,
        "coverage": rel.coverage,
        "status": rel.status,
        "origin": rel.origin,
        "evidence": rel.evidence,
        "notes": rel.notes or [],
    }


def model_tables(project: Project, db: Session) -> List[Dict[str, Any]]:
    """Shape a project's tables the way the analysis engine expects."""
    rows = db.query(DataTable).filter(DataTable.project_id == project.id).order_by(DataTable.id).all()
    return [
        {
            "id": t.id,
            "table_name": t.table_name,
            "physical_name": t.physical_name,
            "row_count": t.row_count,
            "profile": t.profile or {},
        }
        for t in rows
    ]


def refresh_analysis(table: DataTable, db: Session) -> None:
    """Recompute and store the profile and quality findings for one table."""
    profile = profile_table(table.project_id, table.physical_name)
    table.profile = profile
    findings = quality.detect(profile)
    table.quality = {"findings": findings, "summary": quality.summarise(findings)}
    table.row_count = int(profile["summary"]["rows"])
    table.column_count = int(profile["summary"]["columns"])
    table.profiled_at = datetime.now(timezone.utc)
    db.commit()


# ─── Health ──────────────────────────────────────────────────────────────────


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "auth_enabled": AUTH_ENABLED,
        "auth_note": (
            "Sign-in is active."
            if AUTH_ENABLED
            else "Sign-in is not configured, so everything runs in one shared local workspace. "
                 "Set GOOGLE_CLIENT_ID and JWT_SECRET to enable accounts."
        ),
        "max_upload_mb": store.MAX_UPLOAD_BYTES // (1024 * 1024),
    }


# ─── Auth routes ─────────────────────────────────────────────────────────────


class GoogleToken(BaseModel):
    token: str


@app.post("/api/auth/google")
def google_auth(payload: GoogleToken, db: Session = Depends(get_db)) -> Dict[str, Any]:
    if not AUTH_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and JWT_SECRET.",
        )

    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    try:
        info = id_token.verify_oauth2_token(payload.token, google_requests.Request(), GOOGLE_CLIENT_ID)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"Google rejected that sign-in: {exc}") from exc

    user = db.query(User).filter(User.google_id == info["sub"]).first()
    if user:
        user.name = info.get("name", user.name)
        user.picture = info.get("picture", user.picture)
        user.last_login = datetime.now(timezone.utc)
    else:
        user = User(
            google_id=info["sub"],
            email=info.get("email", ""),
            name=info.get("name", "User"),
            picture=info.get("picture"),
        )
        db.add(user)
    db.commit()
    db.refresh(user)

    return {
        "access_token": create_access_token(user),
        "user": {"id": user.id, "name": user.name, "email": user.email, "picture": user.picture},
    }


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)) -> Dict[str, Any]:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "picture": user.picture,
        "is_guest": bool(user.is_guest),
    }


# ─── Projects ────────────────────────────────────────────────────────────────


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None


@app.post("/api/projects")
def create_project(
    payload: ProjectCreate, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = Project(user_id=user.id, name=payload.name.strip(), description=payload.description)
    db.add(project)
    db.commit()
    db.refresh(project)
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "table_count": 0,
        "row_count": 0,
        "created_at": project.created_at.isoformat(),
    }


@app.get("/api/projects")
def list_projects(db: Session = Depends(get_db), user: User = Depends(current_user)) -> List[Dict[str, Any]]:
    projects = (
        db.query(Project).filter(Project.user_id == user.id).order_by(Project.updated_at.desc()).all()
    )
    stats = dict(
        db.query(DataTable.project_id, func.count(DataTable.id))
        .filter(DataTable.project_id.in_([p.id for p in projects] or [0]))
        .group_by(DataTable.project_id)
        .all()
    )
    rows = dict(
        db.query(DataTable.project_id, func.sum(DataTable.row_count))
        .filter(DataTable.project_id.in_([p.id for p in projects] or [0]))
        .group_by(DataTable.project_id)
        .all()
    )
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "table_count": int(stats.get(p.id, 0)),
            "row_count": int(rows.get(p.id, 0) or 0),
            "created_at": p.created_at.isoformat(),
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in projects
    ]


@app.get("/api/projects/{project_id}")
def get_project(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    tables = db.query(DataTable).filter(DataTable.project_id == project.id).order_by(DataTable.id).all()
    names = {t.id: t.table_name for t in tables}
    rels = db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "created_at": project.created_at.isoformat(),
        "tables": [table_summary(t) for t in tables],
        "relationships": [relationship_payload(r, names) for r in rels],
    }


@app.delete("/api/projects/{project_id}")
def delete_project(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    db.delete(project)
    db.commit()
    store.delete_project_data(project_id)
    return {"message": "Project deleted."}


# ─── Upload ──────────────────────────────────────────────────────────────────


@app.post("/api/projects/{project_id}/tables")
async def upload_tables(
    project_id: int,
    files: List[UploadFile] = File(...),
    table_names: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """
    Ingest one or more files into a project.

    Each file becomes a table; each sheet of a workbook becomes its own table.
    A failure on one file is reported against that file and the rest still load,
    because losing four good uploads to one malformed CSV is needlessly hostile.
    """
    project = owned_project(project_id, db, user)
    requested_names = [n.strip() for n in (table_names or "").split("|")] if table_names else []

    created: List[Dict[str, Any]] = []
    failed: List[Dict[str, str]] = []

    existing_names = {
        t.table_name.casefold()
        for t in db.query(DataTable).filter(DataTable.project_id == project.id).all()
    }

    for index, upload in enumerate(files):
        filename = upload.filename or f"upload_{index + 1}"
        saved: Optional[Path] = None
        try:
            saved = store.save_upload(upload.file, filename)
            sources = store.list_sources(saved, filename)
            byte_size = saved.stat().st_size

            for source in sources:
                preferred = (
                    requested_names[index]
                    if len(sources) == 1 and index < len(requested_names) and requested_names[index]
                    else source["label"]
                )
                name = _unique_table_name(preferred, existing_names)
                existing_names.add(name.casefold())

                record = DataTable(
                    project_id=project.id,
                    table_name=name,
                    source_file=filename,
                    source_sheet=source["sheet"],
                    physical_name="pending",
                    byte_size=byte_size,
                )
                db.add(record)
                db.flush()  # assigns the id used for the physical table name
                record.physical_name = store.physical_name(record.id)

                info = store.ingest(project.id, record.id, saved, filename, source["sheet"])
                record.row_count = info["row_count"]
                record.column_count = len(info["columns"])
                db.commit()
                db.refresh(record)

                refresh_analysis(record, db)
                created.append(table_summary(record))
        except store.StoreError as exc:
            db.rollback()
            failed.append({"file": filename, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - surfaced to the user verbatim
            db.rollback()
            failed.append({"file": filename, "error": f"Unexpected problem reading this file: {exc}"})
        finally:
            if saved:
                store.discard_upload(saved)
            await upload.close()

    detected: List[Dict[str, Any]] = []
    if created:
        detected = _detect_and_store(project, db)

    return {
        "tables": created,
        "failed": failed,
        "relationships": detected,
        "message": _upload_message(created, failed, detected),
    }


def _unique_table_name(preferred: str, taken: set) -> str:
    base = (preferred or "Table").strip() or "Table"
    if base.casefold() not in taken:
        return base
    index = 2
    while f"{base} {index}".casefold() in taken:
        index += 1
    return f"{base} {index}"


def _upload_message(created: List, failed: List, detected: List) -> str:
    parts = []
    if created:
        parts.append(f"Loaded {len(created)} table{'s' if len(created) != 1 else ''}.")
    if detected:
        auto = len([r for r in detected if r["status"] == "approved"])
        if auto:
            parts.append(f"Linked {auto} relationship{'s' if auto != 1 else ''} automatically.")
        pending = len(detected) - auto
        if pending:
            parts.append(f"{pending} more need{'s' if pending == 1 else ''} your confirmation.")
    if failed:
        parts.append(f"{len(failed)} file{'s' if len(failed) != 1 else ''} could not be read.")
    return " ".join(parts) or "Nothing was loaded."


# ─── Tables ──────────────────────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/tables")
def list_tables(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> List[Dict[str, Any]]:
    project = owned_project(project_id, db, user)
    tables = db.query(DataTable).filter(DataTable.project_id == project.id).order_by(DataTable.id).all()
    return [table_summary(t) for t in tables]


@app.get("/api/projects/{project_id}/tables/{table_id}")
def get_table(
    project_id: int, table_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    payload = table_summary(table)
    payload["profile"] = table.profile
    return payload


@app.get("/api/projects/{project_id}/tables/{table_id}/rows")
def get_rows(
    project_id: int,
    table_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    order_by: Optional[str] = None,
    direction: str = Query("asc"),
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """A bounded page of rows. The only route that returns raw data."""
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    try:
        return store.page_rows(
            project.id,
            table.physical_name,
            offset=offset,
            limit=limit,
            order_by=order_by,
            descending=direction.lower() == "desc",
            search=search,
        )
    except store.StoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/api/projects/{project_id}/tables/{table_id}")
def delete_table(
    project_id: int, table_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    physical = table.physical_name

    # Relationships referencing this table go with it. The database cascade
    # handles it, but doing it explicitly keeps behaviour identical on backends
    # where cascades are not enforced.
    db.query(TableRelationship).filter(
        (TableRelationship.from_table_id == table.id) | (TableRelationship.to_table_id == table.id)
    ).delete(synchronize_session=False)
    db.delete(table)
    db.commit()
    store.drop_table(project.id, physical)
    return {"message": "Table removed."}


@app.post("/api/projects/{project_id}/tables/{table_id}/reprofile")
def reprofile(
    project_id: int, table_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    refresh_analysis(table, db)
    return get_table(project_id, table_id, db, user)


# ─── Operations ──────────────────────────────────────────────────────────────


class OperationRequest(BaseModel):
    operation: str
    params: Dict[str, Any] = Field(default_factory=dict)


@app.post("/api/projects/{project_id}/tables/{table_id}/operations")
def run_operation(
    project_id: int,
    table_id: int,
    payload: OperationRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """
    Apply one change to a table and re-analyse it.

    The description in the response is produced by the operation after it ran,
    so it reports what actually happened rather than what was intended.
    """
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)

    try:
        result = operations.apply_operation(project.id, table.physical_name, payload.operation, payload.params)
    except operations.OperationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db.add(
        OperationLog(
            table_id=table.id,
            operation=result["operation"],
            params=payload.params,
            description=result["description"],
            rows_before=result["rows_before"],
            rows_after=result["rows_after"],
            destructive=result["destructive"],
        )
    )
    db.commit()

    refresh_analysis(table, db)
    return {"result": result, "table": get_table(project_id, table_id, db, user)}


@app.post("/api/projects/{project_id}/tables/{table_id}/undo")
def undo_operation(
    project_id: int, table_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    try:
        outcome = operations.undo_last(project.id, table.physical_name)
    except operations.OperationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    last = (
        db.query(OperationLog)
        .filter(OperationLog.table_id == table.id)
        .order_by(OperationLog.id.desc())
        .first()
    )
    reverted = last.description if last else None
    if last:
        db.delete(last)
        db.commit()

    refresh_analysis(table, db)
    return {
        "reverted": reverted,
        "undo_steps_remaining": outcome["undo_steps_remaining"],
        "table": get_table(project_id, table_id, db, user),
    }


@app.get("/api/projects/{project_id}/tables/{table_id}/history")
def operation_history(
    project_id: int, table_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> List[Dict[str, Any]]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    entries = (
        db.query(OperationLog)
        .filter(OperationLog.table_id == table.id)
        .order_by(OperationLog.id.desc())
        .limit(100)
        .all()
    )
    return [
        {
            "id": e.id,
            "operation": e.operation,
            "description": e.description,
            "rows_before": e.rows_before,
            "rows_after": e.rows_after,
            "destructive": e.destructive,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in entries
    ]


@app.get("/api/projects/{project_id}/tables/{table_id}/export")
def export_table(
    project_id: int,
    table_id: int,
    format: str = Query("csv"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """Export a whole table. DuckDB streams it to disk so size is not a factor."""
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)

    suffix = {"csv": ".csv", "xlsx": ".xlsx", "json": ".json", "parquet": ".parquet"}.get(format.lower())
    if not suffix:
        raise HTTPException(status_code=400, detail=f"Cannot export as '{format}'.")

    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    handle.close()
    destination = Path(handle.name)
    try:
        store.export_query(project.id, table.physical_name, format.lower(), destination)
    except store.StoreError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    safe = "".join(ch for ch in table.table_name if ch.isalnum() or ch in " _-").strip() or "table"
    return FileResponse(
        destination,
        filename=f"{safe}{suffix}",
        media_type="application/octet-stream",
        background=None,
    )


# ─── Relationships ───────────────────────────────────────────────────────────


def _detect_and_store(project: Project, db: Session) -> List[Dict[str, Any]]:
    """
    Run detection and merge results with what is already recorded.

    A relationship the user has already judged keeps its status. Detection can
    add new candidates but never silently re-approves something that was
    rejected, or downgrades something that was approved.
    """
    tables = model_tables(project, db)
    if len(tables) < 2:
        return []

    candidates = relationships.detect(project.id, tables)
    existing = {
        (r.from_table_id, r.from_column, r.to_table_id, r.to_column): r
        for r in db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()
    }

    for candidate in candidates:
        key = (
            candidate["from_table_id"], candidate["from_column"],
            candidate["to_table_id"], candidate["to_column"],
        )
        record = existing.get(key)
        if record:
            # Refresh the measurements, preserve the user's decision.
            record.confidence = candidate["confidence"]
            record.coverage = candidate["coverage"]
            record.evidence = candidate["evidence"]
            record.notes = candidate["notes"]
            record.cardinality = candidate["cardinality"]
        else:
            db.add(
                TableRelationship(
                    project_id=project.id,
                    from_table_id=candidate["from_table_id"],
                    to_table_id=candidate["to_table_id"],
                    from_column=candidate["from_column"],
                    to_column=candidate["to_column"],
                    cardinality=candidate["cardinality"],
                    confidence=candidate["confidence"],
                    coverage=candidate["coverage"],
                    status=candidate["status"],
                    origin="detected",
                    evidence=candidate["evidence"],
                    notes=candidate["notes"],
                )
            )
    db.commit()

    names = {t["id"]: t["table_name"] for t in tables}
    rows = db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()
    return [relationship_payload(r, names) for r in rows]


@app.post("/api/projects/{project_id}/relationships/detect")
def detect_relationships(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)
    if len(tables) < 2:
        return {
            "relationships": [],
            "message": "Upload at least two tables before looking for relationships between them.",
        }
    found = _detect_and_store(project, db)
    return {"relationships": found, "message": f"{len(found)} relationship(s) in this model."}


@app.get("/api/projects/{project_id}/relationships")
def get_relationships(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> List[Dict[str, Any]]:
    project = owned_project(project_id, db, user)
    names = {t.id: t.table_name for t in db.query(DataTable).filter(DataTable.project_id == project.id).all()}
    rows = db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()
    return [relationship_payload(r, names) for r in rows]


class RelationshipStatus(BaseModel):
    status: str


@app.patch("/api/projects/{project_id}/relationships/{relationship_id}")
def update_relationship(
    project_id: int,
    relationship_id: int,
    payload: RelationshipStatus,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    if payload.status not in {"approved", "rejected", "suggested"}:
        raise HTTPException(status_code=400, detail="Status must be approved, rejected or suggested.")

    record = (
        db.query(TableRelationship)
        .filter(TableRelationship.id == relationship_id, TableRelationship.project_id == project.id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Relationship not found.")

    record.status = payload.status
    db.commit()
    db.refresh(record)
    names = {t.id: t.table_name for t in db.query(DataTable).filter(DataTable.project_id == project.id).all()}
    return relationship_payload(record, names)


class ManualRelationship(BaseModel):
    from_table_id: int
    from_column: str
    to_table_id: int
    to_column: str


@app.post("/api/projects/{project_id}/relationships")
def create_relationship(
    project_id: int,
    payload: ManualRelationship,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """
    Define a relationship by hand.

    The link is still measured before it is saved, so the user finds out
    immediately if the columns do not actually match up.
    """
    project = owned_project(project_id, db, user)
    tables = {t["id"]: t for t in model_tables(project, db)}
    for table_id in (payload.from_table_id, payload.to_table_id):
        if table_id not in tables:
            raise HTTPException(status_code=404, detail="One of those tables is not in this project.")
    if payload.from_table_id == payload.to_table_id:
        raise HTTPException(status_code=400, detail="A relationship needs two different tables.")

    measured = relationships.measure_pair(
        project.id,
        tables[payload.from_table_id], payload.from_column,
        tables[payload.to_table_id], payload.to_column,
    )
    if measured is None:
        raise HTTPException(status_code=400, detail="One of those columns does not exist.")

    record = TableRelationship(
        project_id=project.id,
        from_table_id=payload.from_table_id,
        to_table_id=payload.to_table_id,
        from_column=payload.from_column,
        to_column=payload.to_column,
        cardinality=measured["cardinality"],
        confidence=measured["confidence"],
        coverage=measured["coverage"],
        status="approved",
        origin="manual",
        evidence=measured["evidence"],
        notes=measured["notes"],
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    names = {t["id"]: t["table_name"] for t in tables.values()}
    return relationship_payload(record, names)


@app.delete("/api/projects/{project_id}/relationships/{relationship_id}")
def delete_relationship(
    project_id: int, relationship_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    record = (
        db.query(TableRelationship)
        .filter(TableRelationship.id == relationship_id, TableRelationship.project_id == project.id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Relationship not found.")
    db.delete(record)
    db.commit()
    return {"message": "Relationship removed."}


# ─── Model and querying ──────────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/model")
def get_model(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)
    names = {t["id"]: t["table_name"] for t in tables}
    rels = db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()
    payloads = [relationship_payload(r, names) for r in rels]

    described = model_engine.describe_model(tables, payloads)
    described["relationships"] = payloads
    described["fields"] = [
        {
            "table_id": t["id"],
            "table_name": t["table_name"],
            "columns": [
                {
                    "name": c["name"],
                    "logical_type": c["logical_type"],
                    "semantic_role": c["semantic_role"],
                    "default_aggregation": c.get("default_aggregation"),
                    "additivity": c.get("additivity"),
                    "distinct_count": c.get("distinct_count"),
                }
                for c in (t["profile"] or {}).get("columns", [])
            ],
        }
        for t in tables
    ]
    return described


class QuerySpec(BaseModel):
    base_table_id: Optional[int] = None
    dimensions: List[Dict[str, Any]] = Field(default_factory=list)
    measures: List[Dict[str, Any]] = Field(default_factory=list)
    filters: List[Dict[str, Any]] = Field(default_factory=list)
    order_by: Optional[Dict[str, Any]] = None
    limit: Optional[int] = None


@app.post("/api/projects/{project_id}/query")
def run_query(
    project_id: int,
    spec: QuerySpec,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """
    Run an aggregate query, joining across approved relationships as needed.

    Every chart and KPI in the app goes through here, which is why the numbers
    on different screens now agree: they are all the same query.
    """
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)
    names = {t["id"]: t["table_name"] for t in tables}
    rels = [
        relationship_payload(r, names)
        for r in db.query(TableRelationship).filter(TableRelationship.project_id == project.id).all()
    ]
    try:
        return model_engine.run_query(project.id, tables, rels, spec.model_dump())
    except model_engine.ModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ─── Dashboards ──────────────────────────────────────────────────────────────


class DashboardPayload(BaseModel):
    widgets: List[Dict[str, Any]] = Field(default_factory=list)
    layouts: Dict[str, Any] = Field(default_factory=dict)


@app.get("/api/projects/{project_id}/dashboard")
def get_dashboard(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    dashboard = db.query(Dashboard).filter(Dashboard.project_id == project.id).first()
    if not dashboard:
        return {"widgets": [], "layouts": {}}
    return {"widgets": dashboard.widgets or [], "layouts": dashboard.layouts or {}}


@app.post("/api/projects/{project_id}/dashboard")
def save_dashboard(
    project_id: int,
    payload: DashboardPayload,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    dashboard = db.query(Dashboard).filter(Dashboard.project_id == project.id).first()
    if dashboard:
        dashboard.widgets = payload.widgets
        dashboard.layouts = payload.layouts
    else:
        db.add(Dashboard(project_id=project.id, widgets=payload.widgets, layouts=payload.layouts))
    db.commit()
    return {"message": "Dashboard saved."}


if __name__ == "__main__":
    import uvicorn

    # 8005 is deliberately not the default: it is a commonly occupied port and
    # was already taken on the development machine by an unrelated service.
    uvicorn.run(
        "main:app",
        host=os.getenv("API_HOST", "127.0.0.1"),
        port=int(os.getenv("API_PORT", "8008")),
        reload=True,
    )
