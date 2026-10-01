"""
CLEANYTICS API.

Uploaded rows live in DuckDB. This API handles authentication, project
metadata, uploads, cleaning, relationships, queries, and dashboards.
"""

from __future__ import annotations

import logging
import os
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
)
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
from models import (
    DataTable,
    Dashboard,
    OperationLog,
    Project,
    TableRelationship,
    User,
)


load_dotenv()
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
JWT_SECRET = os.getenv("JWT_SECRET", "").strip()

JWT_ALGORITHM = "HS256"
TOKEN_TTL = timedelta(days=7)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

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


app = FastAPI(
    title="CLEANYTICS API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# ─── Authentication ──────────────────────────────────────────────────────────


def _ensure_guest(db: Session) -> User:
    guest = (
        db.query(User)
        .filter(User.google_id == GUEST_GOOGLE_ID)
        .first()
    )

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

    return jwt.encode(
        payload,
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user or the local guest workspace."""
    if not AUTH_ENABLED:
        return _ensure_guest(db)

    if (
        not authorization
        or not authorization.lower().startswith("bearer ")
    ):
        raise HTTPException(
            status_code=401,
            detail="Sign in to continue.",
        )

    token = authorization.split(" ", 1)[1].strip()

    if SUPABASE_URL:
        import jwt as pyjwt
        from jwt import PyJWKClient

        try:
            jwks_url = (
                f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
            )
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
                "[AUTH DEBUG] Supabase JWT verification failed: "
                f"{type(exc).__name__}: {exc}"
            )
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication token.",
            )

        except Exception as exc:
            print(
                "[AUTH DEBUG] Supabase JWKS verification failed: "
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

        user = (
            db.query(User)
            .filter(User.google_id == supabase_uid)
            .first()
        )

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

    from jose import JWTError, jwt

    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
        )
    except JWTError:
        raise HTTPException(
            status_code=401,
            detail="Your session has expired. Sign in again.",
        )

    user = (
        db.query(User)
        .filter(User.id == int(payload.get("sub", 0)))
        .first()
    )

    if not user:
        raise HTTPException(
            status_code=401,
            detail="This account no longer exists.",
        )

    return user


def owned_project(
    project_id: int,
    db: Session,
    user: User,
) -> Project:
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user.id,
        )
        .first()
    )

    if not project:
        raise HTTPException(
            status_code=404,
            detail="Project not found.",
        )

    return project


def owned_table(
    project: Project,
    table_id: int,
    db: Session,
) -> DataTable:
    table = (
        db.query(DataTable)
        .filter(
            DataTable.id == table_id,
            DataTable.project_id == project.id,
        )
        .first()
    )

    if not table:
        raise HTTPException(
            status_code=404,
            detail="Table not found.",
        )

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
                "name": column["name"],
                "logical_type": column["logical_type"],
                "semantic_role": column["semantic_role"],
                "subtype": column.get("subtype"),
                "default_aggregation": column.get("default_aggregation"),
                "additivity": column.get("additivity"),
                "null_ratio": column.get("null_ratio"),
                "distinct_count": column.get("distinct_count"),
                "is_unique": column.get("is_unique"),
            }
            for column in profile.get("columns", [])
        ],
        "summary": profile.get("summary"),
        "quality": table.quality,
        "created_at": (
            table.created_at.isoformat()
            if table.created_at else None
        ),
        "updated_at": (
            table.updated_at.isoformat()
            if table.updated_at else None
        ),
    }


def relationship_payload(
    rel: TableRelationship,
    names: Dict[int, str],
) -> Dict[str, Any]:
    return {
        "id": rel.id,
        "from_table_id": rel.from_table_id,
        "from_table_name": names.get(
            rel.from_table_id,
            f"Table {rel.from_table_id}",
        ),
        "from_column": rel.from_column,
        "to_table_id": rel.to_table_id,
        "to_table_name": names.get(
            rel.to_table_id,
            f"Table {rel.to_table_id}",
        ),
        "to_column": rel.to_column,
        "cardinality": rel.cardinality,
        "cardinality_label": relationships.CARDINALITY_LABEL.get(
            rel.cardinality,
            rel.cardinality,
        ),
        "confidence": rel.confidence,
        "coverage": rel.coverage,
        "status": rel.status,
        "origin": rel.origin,
        "evidence": rel.evidence,
        "notes": rel.notes or [],
    }


def model_tables(
    project: Project,
    db: Session,
) -> List[Dict[str, Any]]:
    rows = (
        db.query(DataTable)
        .filter(DataTable.project_id == project.id)
        .order_by(DataTable.id)
        .all()
    )

    return [
        {
            "id": table.id,
            "table_name": table.table_name,
            "physical_name": table.physical_name,
            "row_count": table.row_count,
            "profile": table.profile or {},
        }
        for table in rows
    ]


def refresh_analysis(
    table: DataTable,
    db: Session,
    *,
    commit: bool = True,
) -> None:
    """Recompute the profile and quality findings for one table."""
    profile = profile_table(
        table.project_id,
        table.physical_name,
    )
    findings = quality.detect(profile)

    table.profile = profile
    table.quality = {
        "findings": findings,
        "summary": quality.summarise(findings),
    }
    table.row_count = int(profile["summary"]["rows"])
    table.column_count = int(profile["summary"]["columns"])
    table.profiled_at = datetime.now(timezone.utc)

    if commit:
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
            else (
                "Sign-in is not configured, so everything runs "
                "in one shared local workspace. "
                "Set GOOGLE_CLIENT_ID and JWT_SECRET to enable accounts."
            )
        ),
        "max_upload_mb": store.MAX_UPLOAD_BYTES // (1024 * 1024),
    }


# ─── Auth routes ─────────────────────────────────────────────────────────────


class GoogleToken(BaseModel):
    token: str


@app.post("/api/auth/google")
def google_auth(
    payload: GoogleToken,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if not AUTH_ENABLED:
        raise HTTPException(
            status_code=503,
            detail=(
                "Sign-in is not configured on this server. "
                "Set GOOGLE_CLIENT_ID and JWT_SECRET."
            ),
        )

    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    try:
        info = id_token.verify_oauth2_token(
            payload.token,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Google rejected that sign-in: {exc}",
        ) from exc

    user = (
        db.query(User)
        .filter(User.google_id == info["sub"])
        .first()
    )

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
        "user": {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "picture": user.picture,
        },
    }


@app.get("/api/auth/me")
def me(
    user: User = Depends(current_user),
) -> Dict[str, Any]:
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
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = Project(
        user_id=user.id,
        name=payload.name.strip(),
        description=payload.description,
    )
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
def list_projects(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> List[Dict[str, Any]]:
    projects = (
        db.query(Project)
        .filter(Project.user_id == user.id)
        .order_by(Project.updated_at.desc())
        .all()
    )

    project_ids = [project.id for project in projects] or [0]

    stats = dict(
        db.query(
            DataTable.project_id,
            func.count(DataTable.id),
        )
        .filter(DataTable.project_id.in_(project_ids))
        .group_by(DataTable.project_id)
        .all()
    )

    rows = dict(
        db.query(
            DataTable.project_id,
            func.sum(DataTable.row_count),
        )
        .filter(DataTable.project_id.in_(project_ids))
        .group_by(DataTable.project_id)
        .all()
    )

    return [
        {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "table_count": int(stats.get(project.id, 0)),
            "row_count": int(rows.get(project.id, 0) or 0),
            "created_at": project.created_at.isoformat(),
            "updated_at": (
                project.updated_at.isoformat()
                if project.updated_at else None
            ),
        }
        for project in projects
    ]


@app.get("/api/projects/{project_id}")
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)

    tables = (
        db.query(DataTable)
        .filter(DataTable.project_id == project.id)
        .order_by(DataTable.id)
        .all()
    )
    names = {table.id: table.table_name for table in tables}

    rels = (
        db.query(TableRelationship)
        .filter(TableRelationship.project_id == project.id)
        .all()
    )

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "created_at": project.created_at.isoformat(),
        "tables": [table_summary(table) for table in tables],
        "relationships": [
            relationship_payload(rel, names)
            for rel in rels
        ],
    }


@app.delete("/api/projects/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    db.delete(project)
    db.commit()

    store.delete_project_data(project_id)

    return {"message": "Project deleted."}


# ─── Upload ──────────────────────────────────────────────────────────────────


def _remove_failed_import(
    project_id: int,
    physical_name: str,
) -> None:
    """Remove an unfinished import and any cleaning snapshots."""
    with store.connect(project_id) as con:
        con.execute("BEGIN TRANSACTION")

        try:
            operations.drop_snapshots(con, physical_name)
            con.execute(
                f"DROP TABLE IF EXISTS {store.q(physical_name)}"
            )
            con.execute("COMMIT")

        except Exception:
            con.execute("ROLLBACK")
            raise


@app.post("/api/projects/{project_id}/tables")
async def upload_tables(
    project_id: int,
    files: List[UploadFile] = File(...),
    table_names: Optional[str] = Form(None),
    auto_clean: bool = Form(True),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    """Import, optionally clean, profile, then detect relationships."""
    project = owned_project(project_id, db, user)

    requested_names = (
        [name.strip() for name in table_names.split("|")]
        if table_names else []
    )

    created: List[Dict[str, Any]] = []
    failed: List[Dict[str, str]] = []
    warnings: List[str] = []
    cleaned_cells = 0

    existing_names = {
        table.table_name.casefold()
        for table in db.query(DataTable).filter(
            DataTable.project_id == project.id
        ).all()
    }

    for index, upload in enumerate(files):
        filename = upload.filename or f"upload_{index + 1}"
        saved: Optional[Path] = None

        try:
            saved = store.save_upload(upload.file, filename)
            sources = store.list_sources(saved, filename)
            byte_size = saved.stat().st_size

            if not sources:
                failed.append({
                    "file": filename,
                    "error": "No non-empty worksheets were found.",
                })

            for source in sources:
                physical: Optional[str] = None

                try:
                    preferred = (
                        requested_names[index]
                        if len(sources) == 1
                        and index < len(requested_names)
                        and requested_names[index]
                        else source["label"]
                    )

                    name = _unique_table_name(
                        preferred,
                        existing_names,
                    )

                    record = DataTable(
                        project_id=project_id,
                        table_name=name,
                        source_file=filename,
                        source_sheet=source["sheet"],
                        physical_name="pending",
                        byte_size=byte_size,
                    )
                    db.add(record)
                    db.flush()

                    physical = store.physical_name(record.id)
                    record.physical_name = physical

                    info = store.ingest(
                        project_id,
                        record.id,
                        saved,
                        filename,
                        source["sheet"],
                    )
                    record.row_count = info["row_count"]
                    record.column_count = len(info["columns"])

                    cleaning = None

                    if auto_clean:
                        cleaning = operations.apply_operation(
                            project_id,
                            physical,
                            "auto_clean",
                            {},
                        )

                        db.add(
                            OperationLog(
                                table_id=record.id,
                                operation="auto_clean",
                                params={},
                                description=cleaning["description"],
                                rows_before=cleaning["rows_before"],
                                rows_after=cleaning["rows_after"],
                                destructive=cleaning["destructive"],
                            )
                        )

                    # Analyse the cleaned data before detecting relationships.
                    refresh_analysis(record, db, commit=False)
                    project.updated_at = datetime.now(timezone.utc)

                    db.flush()
                    summary = table_summary(record)
                    db.commit()

                    created.append(summary)
                    existing_names.add(name.casefold())

                    if cleaning:
                        cleaned_cells += cleaning["cells_changed"]

                except Exception as exc:
                    db.rollback()

                    if physical:
                        try:
                            _remove_failed_import(
                                project_id,
                                physical,
                            )
                        except Exception as cleanup_exc:
                            logger.exception(
                                "Could not remove an unfinished import"
                            )
                            raise HTTPException(
                                status_code=500,
                                detail=(
                                    "An import failed and its temporary "
                                    "data could not be removed. Some "
                                    "earlier tables may have loaded. "
                                    "Check the project before retrying."
                                ),
                            ) from cleanup_exc

                    label = (
                        f"{filename} [{source['sheet']}]"
                        if source["sheet"] else filename
                    )

                    if isinstance(
                        exc,
                        (store.StoreError, operations.OperationError),
                    ):
                        detail = str(exc)
                    else:
                        logger.exception(
                            "Import failed for %s",
                            label,
                        )
                        detail = (
                            "This table could not be imported or "
                            "analysed. Check the server log."
                        )

                    failed.append({
                        "file": label,
                        "error": detail,
                    })

        except HTTPException:
            raise

        except store.StoreError as exc:
            db.rollback()
            failed.append({
                "file": filename,
                "error": str(exc),
            })

        except Exception:
            db.rollback()
            logger.exception(
                "Could not read upload %s",
                filename,
            )
            failed.append({
                "file": filename,
                "error": (
                    "This file could not be read. "
                    "Check the server log."
                ),
            })

        finally:
            if saved:
                store.discard_upload(saved)

            await upload.close()

    detected: List[Dict[str, Any]] = []

    if created:
        try:
            detected = _detect_and_store(project, db)
        except Exception:
            db.rollback()
            logger.exception(
                "Relationship detection failed for project %s",
                project_id,
            )
            warnings.append(
                "Your tables were saved, but relationship detection "
                "failed. Retry detection from the data model; "
                "do not upload these files again."
            )

    message = _upload_message(created, failed, detected)

    if auto_clean and created:
        message += (
            f" Automatic cleaning updated {cleaned_cells:,} text cells."
            if cleaned_cells
            else " Automatic cleaning found no text changes to make."
        )

    if warnings:
        message += " " + " ".join(warnings)

    return {
        "tables": created,
        "failed": failed,
        "relationships": detected,
        "message": message,
        "warnings": warnings,
    }


def _unique_table_name(
    preferred: str,
    taken: set,
) -> str:
    base = (preferred or "Table").strip() or "Table"

    if base.casefold() not in taken:
        return base

    index = 2
    while f"{base} {index}".casefold() in taken:
        index += 1

    return f"{base} {index}"


def _upload_message(
    created: List,
    failed: List,
    detected: List,
) -> str:
    parts = []

    if created:
        suffix = "s" if len(created) != 1 else ""
        parts.append(f"Loaded {len(created)} table{suffix}.")

    if detected:
        auto = len([
            rel for rel in detected
            if rel["status"] == "approved"
        ])

        if auto:
            suffix = "s" if auto != 1 else ""
            parts.append(
                f"Linked {auto} relationship{suffix} automatically."
            )

        pending = len([
            rel for rel in detected
            if rel["status"] == "suggested"
        ])

        if pending:
            suffix = "s" if pending == 1 else ""
            parts.append(
                f"{pending} more need{suffix} your confirmation."
            )

    if failed:
        parts.append(
            f"{len(failed)} file or worksheet import(s) failed."
        )

    return " ".join(parts) or "Nothing was loaded."


# ─── Tables ──────────────────────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/tables")
def list_tables(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> List[Dict[str, Any]]:
    project = owned_project(project_id, db, user)

    tables = (
        db.query(DataTable)
        .filter(DataTable.project_id == project.id)
        .order_by(DataTable.id)
        .all()
    )

    return [table_summary(table) for table in tables]


@app.get("/api/projects/{project_id}/tables/{table_id}")
def get_table(
    project_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
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
        raise HTTPException(
            status_code=404,
            detail=str(exc),
        ) from exc


@app.delete("/api/projects/{project_id}/tables/{table_id}")
def delete_table(
    project_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)
    physical = table.physical_name

    db.query(TableRelationship).filter(
        (TableRelationship.from_table_id == table.id)
        | (TableRelationship.to_table_id == table.id)
    ).delete(synchronize_session=False)

    db.delete(table)
    db.commit()

    store.drop_table(project.id, physical)

    return {"message": "Table removed."}


@app.post("/api/projects/{project_id}/tables/{table_id}/reprofile")
def reprofile(
    project_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
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
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)

    try:
        result = operations.apply_operation(
            project.id,
            table.physical_name,
            payload.operation,
            payload.params,
        )
    except operations.OperationError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

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

    return {
        "result": result,
        "table": get_table(project_id, table_id, db, user),
    }


@app.post("/api/projects/{project_id}/tables/{table_id}/undo")
def undo_operation(
    project_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)

    try:
        outcome = operations.undo_last(
            project.id,
            table.physical_name,
        )
    except operations.OperationError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

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
    project_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
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
            "id": entry.id,
            "operation": entry.operation,
            "description": entry.description,
            "rows_before": entry.rows_before,
            "rows_after": entry.rows_after,
            "destructive": entry.destructive,
            "created_at": (
                entry.created_at.isoformat()
                if entry.created_at else None
            ),
        }
        for entry in entries
    ]


@app.get("/api/projects/{project_id}/tables/{table_id}/export")
def export_table(
    project_id: int,
    table_id: int,
    format: str = Query("csv"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    project = owned_project(project_id, db, user)
    table = owned_table(project, table_id, db)

    suffix = {
        "csv": ".csv",
        "xlsx": ".xlsx",
        "json": ".json",
        "parquet": ".parquet",
    }.get(format.lower())

    if not suffix:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot export as '{format}'.",
        )

    handle = tempfile.NamedTemporaryFile(
        delete=False,
        suffix=suffix,
    )
    handle.close()
    destination = Path(handle.name)

    try:
        store.export_query(
            project.id,
            table.physical_name,
            format.lower(),
            destination,
        )
    except store.StoreError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    safe = (
        "".join(
            char for char in table.table_name
            if char.isalnum() or char in " _-"
        ).strip()
        or "table"
    )

    return FileResponse(
        destination,
        filename=f"{safe}{suffix}",
        media_type="application/octet-stream",
        background=None,
    )


# ─── Relationships ───────────────────────────────────────────────────────────


def _detect_and_store(
    project: Project,
    db: Session,
) -> List[Dict[str, Any]]:
    """Detect relationships while preserving existing user decisions."""
    tables = model_tables(project, db)

    if len(tables) < 2:
        return []

    candidates = relationships.detect(project.id, tables)

    existing = {
        (
            rel.from_table_id,
            rel.from_column,
            rel.to_table_id,
            rel.to_column,
        ): rel
        for rel in db.query(TableRelationship).filter(
            TableRelationship.project_id == project.id
        ).all()
    }

    for candidate in candidates:
        key = (
            candidate["from_table_id"],
            candidate["from_column"],
            candidate["to_table_id"],
            candidate["to_column"],
        )
        record = existing.get(key)

        if record:
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

    names = {
        table["id"]: table["table_name"]
        for table in tables
    }

    rows = (
        db.query(TableRelationship)
        .filter(TableRelationship.project_id == project.id)
        .all()
    )

    return [
        relationship_payload(rel, names)
        for rel in rows
    ]


@app.post("/api/projects/{project_id}/relationships/detect")
def detect_relationships(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)

    if len(tables) < 2:
        return {
            "relationships": [],
            "message": (
                "Upload at least two tables before looking "
                "for relationships between them."
            ),
        }

    found = _detect_and_store(project, db)

    return {
        "relationships": found,
        "message": f"{len(found)} relationship(s) in this model.",
    }


@app.get("/api/projects/{project_id}/relationships")
def get_relationships(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> List[Dict[str, Any]]:
    project = owned_project(project_id, db, user)

    names = {
        table.id: table.table_name
        for table in db.query(DataTable).filter(
            DataTable.project_id == project.id
        ).all()
    }

    rows = (
        db.query(TableRelationship)
        .filter(TableRelationship.project_id == project.id)
        .all()
    )

    return [
        relationship_payload(rel, names)
        for rel in rows
    ]


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
        raise HTTPException(
            status_code=400,
            detail="Status must be approved, rejected or suggested.",
        )

    record = (
        db.query(TableRelationship)
        .filter(
            TableRelationship.id == relationship_id,
            TableRelationship.project_id == project.id,
        )
        .first()
    )

    if not record:
        raise HTTPException(
            status_code=404,
            detail="Relationship not found.",
        )

    record.status = payload.status
    db.commit()
    db.refresh(record)

    names = {
        table.id: table.table_name
        for table in db.query(DataTable).filter(
            DataTable.project_id == project.id
        ).all()
    }

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
    project = owned_project(project_id, db, user)

    tables = {
        table["id"]: table
        for table in model_tables(project, db)
    }

    for table_id in (
        payload.from_table_id,
        payload.to_table_id,
    ):
        if table_id not in tables:
            raise HTTPException(
                status_code=404,
                detail="One of those tables is not in this project.",
            )

    if payload.from_table_id == payload.to_table_id:
        raise HTTPException(
            status_code=400,
            detail="A relationship needs two different tables.",
        )

    measured = relationships.measure_pair(
        project.id,
        tables[payload.from_table_id],
        payload.from_column,
        tables[payload.to_table_id],
        payload.to_column,
    )

    if measured is None:
        raise HTTPException(
            status_code=400,
            detail="One of those columns does not exist.",
        )

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

    names = {
        table["id"]: table["table_name"]
        for table in tables.values()
    }

    return relationship_payload(record, names)


@app.delete("/api/projects/{project_id}/relationships/{relationship_id}")
def delete_relationship(
    project_id: int,
    relationship_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)

    record = (
        db.query(TableRelationship)
        .filter(
            TableRelationship.id == relationship_id,
            TableRelationship.project_id == project.id,
        )
        .first()
    )

    if not record:
        raise HTTPException(
            status_code=404,
            detail="Relationship not found.",
        )

    db.delete(record)
    db.commit()

    return {"message": "Relationship removed."}


# ─── Model and querying ──────────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/model")
def get_model(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)

    names = {
        table["id"]: table["table_name"]
        for table in tables
    }

    rels = (
        db.query(TableRelationship)
        .filter(TableRelationship.project_id == project.id)
        .all()
    )

    payloads = [
        relationship_payload(rel, names)
        for rel in rels
    ]

    described = model_engine.describe_model(tables, payloads)
    described["relationships"] = payloads

    described["fields"] = [
        {
            "table_id": table["id"],
            "table_name": table["table_name"],
            "columns": [
                {
                    "name": column["name"],
                    "logical_type": column["logical_type"],
                    "semantic_role": column["semantic_role"],
                    "default_aggregation": column.get(
                        "default_aggregation"
                    ),
                    "additivity": column.get("additivity"),
                    "distinct_count": column.get("distinct_count"),
                }
                for column in (
                    table["profile"] or {}
                ).get("columns", [])
            ],
        }
        for table in tables
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
    project = owned_project(project_id, db, user)
    tables = model_tables(project, db)

    names = {
        table["id"]: table["table_name"]
        for table in tables
    }

    rels = [
        relationship_payload(rel, names)
        for rel in db.query(TableRelationship).filter(
            TableRelationship.project_id == project.id
        ).all()
    ]

    try:
        return model_engine.run_query(
            project.id,
            tables,
            rels,
            spec.model_dump(),
        )
    except model_engine.ModelError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


# ─── Dashboards ──────────────────────────────────────────────────────────────


class DashboardPayload(BaseModel):
    widgets: List[Dict[str, Any]] = Field(default_factory=list)
    layouts: Dict[str, Any] = Field(default_factory=dict)


@app.get("/api/projects/{project_id}/dashboard")
def get_dashboard(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, Any]:
    project = owned_project(project_id, db, user)

    dashboard = (
        db.query(Dashboard)
        .filter(Dashboard.project_id == project.id)
        .first()
    )

    if not dashboard:
        return {
            "widgets": [],
            "layouts": {},
        }

    return {
        "widgets": dashboard.widgets or [],
        "layouts": dashboard.layouts or {},
    }


@app.post("/api/projects/{project_id}/dashboard")
def save_dashboard(
    project_id: int,
    payload: DashboardPayload,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> Dict[str, str]:
    project = owned_project(project_id, db, user)

    dashboard = (
        db.query(Dashboard)
        .filter(Dashboard.project_id == project.id)
        .first()
    )

    if dashboard:
        dashboard.widgets = payload.widgets
        dashboard.layouts = payload.layouts
    else:
        db.add(
            Dashboard(
                project_id=project.id,
                widgets=payload.widgets,
                layouts=payload.layouts,
            )
        )

    db.commit()

    return {"message": "Dashboard saved."}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("API_HOST", "127.0.0.1"),
        port=int(os.getenv("API_PORT", "8008")),
        reload=True,
    )