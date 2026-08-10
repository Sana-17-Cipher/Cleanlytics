from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import pandas as pd
import io
import math
import base64
import numpy as np

from dotenv import load_dotenv
import os
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import jwt
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from database import engine, get_db, Base, SessionLocal
from models import User, Project, Dashboard, DataTable, TableRelationship

from services.cleaner import clean_data
from services.transformer import transform_data
from services.profiler import profile_dataset
from services.quality_engine import detect_quality_issues
from services.relationship_detector import detect_relationships
from services.suggestion_engine import (
    generate_transformation_suggestions,
    generate_measure_recommendations,
    recommend_visualization,
)

load_dotenv()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
JWT_SECRET = os.getenv("JWT_SECRET", "fallback_secret")
JWT_ALGORITHM = "HS256"

app = FastAPI(title="CLEANYTICS API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == 1).first()
        if not user:
            guest = User(
                id=1,
                google_id="guest_user",
                email="guest@cleanlytics.local",
                name="Guest User",
                profile_picture=""
            )
            db.add(guest)
            db.commit()
    except Exception as e:
        print(f"Startup user creation note: {e}")
        db.rollback()
    finally:
        db.close()


class GoogleTokenPayload(BaseModel):
    token: str


def create_access_token(data: dict, expires_delta: timedelta = timedelta(days=7)):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


class DataPayload(BaseModel):
    data: List[Dict[str, Any]]
    config: Optional[Dict[str, Any]] = None

def clean_nans(df: pd.DataFrame) -> List[Dict[str, Any]]:
    return df.replace({np.nan: None}).to_dict(orient="records")

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = await file.read()
        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(content))
        elif file.filename.endswith(('.xls', '.xlsx')):
            df = pd.read_excel(io.BytesIO(content))
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format")
        
        return {"filename": file.filename, "data": clean_nans(df)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/clean")
async def clean_endpoint(payload: DataPayload):
    try:
        df = pd.DataFrame(payload.data)
        config = payload.config or {}
        cleaned_df = clean_data(df, config)
        return {"data": clean_nans(cleaned_df)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/transform")
async def transform_endpoint(payload: DataPayload):
    try:
        df = pd.DataFrame(payload.data)
        config = payload.config or {}
        transformed_df = transform_data(df, config)
        return {"data": clean_nans(transformed_df)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Intelligence Layer Endpoints ───────────────────────────────────────────

@app.post("/api/profile")
async def profile_endpoint(payload: DataPayload):
    """Run semantic profiling on uploaded data."""
    try:
        df = pd.DataFrame(payload.data)
        profile = profile_dataset(df)
        return profile
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/quality-suggestions")
async def quality_suggestions_endpoint(payload: DataPayload):
    """Detect quality issues in the dataset."""
    try:
        df = pd.DataFrame(payload.data)
        # Profile first, then detect issues
        profile = profile_dataset(df)
        suggestions = detect_quality_issues(df, profile)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/transformation-suggestions")
async def transformation_suggestions_endpoint(payload: DataPayload):
    """Generate smart transformation suggestions."""
    try:
        df = pd.DataFrame(payload.data)
        profile = profile_dataset(df)
        suggestions = generate_transformation_suggestions(df, profile)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/measure-recommendations")
async def measure_recommendations_endpoint(payload: DataPayload):
    """Generate measure recommendations based on semantic profile."""
    try:
        df = pd.DataFrame(payload.data)
        profile = profile_dataset(df)
        recommendations = generate_measure_recommendations(df, profile)
        return {"recommendations": recommendations}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ApplySuggestionPayload(BaseModel):
    data: List[Dict[str, Any]]
    suggestion_id: str
    suggestion_type: str
    parameters: Optional[Dict[str, Any]] = None
    column: Optional[str] = None


@app.post("/api/apply-suggestion")
async def apply_suggestion_endpoint(payload: ApplySuggestionPayload):
    """Apply a single quality or transformation suggestion."""
    try:
        df = pd.DataFrame(payload.data)
        stype = payload.suggestion_type
        col = payload.column
        params = payload.parameters or {}

        description = ""

        if stype == 'duplicate_rows':
            before = len(df)
            df = df.drop_duplicates()
            description = f"Removed {before - len(df)} duplicate rows"

        elif stype == 'missing_values':
            if col and col in df.columns:
                strategy = params.get('strategy', 'drop')
                if strategy == 'drop':
                    before = len(df)
                    df = df.dropna(subset=[col])
                    description = f"Dropped {before - len(df)} rows with missing {col}"
                elif strategy == 'median':
                    if pd.api.types.is_numeric_dtype(df[col]):
                        val = df[col].median()
                        count = int(df[col].isnull().sum())
                        df[col] = df[col].fillna(val)
                        description = f"Filled {count} missing {col} values with median ({val:.2f})"
                elif strategy == 'mean':
                    if pd.api.types.is_numeric_dtype(df[col]):
                        val = df[col].mean()
                        count = int(df[col].isnull().sum())
                        df[col] = df[col].fillna(val)
                        description = f"Filled {count} missing {col} values with mean ({val:.2f})"
                elif strategy == 'mode':
                    mode_s = df[col].mode()
                    if not mode_s.empty:
                        val = mode_s.iloc[0]
                        count = int(df[col].isnull().sum())
                        df[col] = df[col].fillna(val)
                        description = f"Filled {count} missing {col} values with mode ({val})"

        elif stype == 'inconsistent_case':
            if col and col in df.columns:
                before_uniq = df[col].nunique()
                df[col] = df[col].astype(str).str.strip().str.title()
                after_uniq = df[col].nunique()
                description = f"Standardized {col} capitalization (Title Case). Reduced from {before_uniq} to {after_uniq} unique values."

        elif stype == 'whitespace':
            if col and col in df.columns:
                count = int((df[col].astype(str) != df[col].astype(str).str.strip()).sum())
                df[col] = df[col].astype(str).str.strip()
                description = f"Trimmed whitespace from {count} values in {col}"

        elif stype == 'constant_column':
            if col and col in df.columns:
                df = df.drop(columns=[col])
                description = f"Removed constant column {col}"

        elif stype == 'date_decomposition':
            target_col = params.get('target_column', col)
            new_col = params.get('new_column', f'{target_col}_Part')
            part = params.get('part', 'year')
            if target_col and target_col in df.columns:
                dt = pd.to_datetime(df[target_col], errors='coerce')
                if part == 'year':
                    df[new_col] = dt.dt.year
                elif part == 'quarter':
                    df[new_col] = dt.dt.quarter
                elif part == 'month':
                    df[new_col] = dt.dt.month
                elif part == 'month_name':
                    df[new_col] = dt.dt.month_name()
                elif part == 'day_of_week':
                    df[new_col] = dt.dt.day_name()
                description = f"Created {new_col} from {target_col}"

        elif stype == 'derived_calculation':
            col_a = params.get('col_a')
            col_b = params.get('col_b')
            operator = params.get('operator')
            new_col = params.get('new_column', 'Calculated')
            if col_a and col_b and col_a in df.columns and col_b in df.columns:
                a = pd.to_numeric(df[col_a], errors='coerce')
                b = pd.to_numeric(df[col_b], errors='coerce')
                if operator == '+':
                    df[new_col] = a + b
                elif operator == '-':
                    df[new_col] = a - b
                elif operator == '*':
                    df[new_col] = a * b
                elif operator == '/':
                    df[new_col] = a / b.replace(0, np.nan)
                elif operator == 'margin':
                    df[new_col] = ((a - b) / a.replace(0, np.nan)).round(4)
                description = f"Created {new_col}"

        return {
            "data": clean_nans(df),
            "description": description,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/export")
async def export_endpoint(payload: DataPayload):
    try:
        df = pd.DataFrame(payload.data)
        format_type = (payload.config or {}).get("format", "csv")
        
        if format_type == "csv":
            csv_data = df.to_csv(index=False)
            return {"file_content": csv_data, "filename": "export.csv", "mime_type": "text/csv", "encoding": "text"}
        elif format_type == "json":
            json_data = df.to_json(orient="records")
            return {"file_content": json_data, "filename": "export.json", "mime_type": "application/json", "encoding": "text"}
        elif format_type == "xlsx":
            buffer = io.BytesIO()
            df.to_excel(buffer, index=False, engine='openpyxl')
            buffer.seek(0)
            b64_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
            return {
                "file_content": b64_data,
                "filename": "export.xlsx",
                "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "encoding": "base64"
            }
        else:
            raise HTTPException(status_code=400, detail="Unsupported export format")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/auth/google")
async def google_auth(payload: GoogleTokenPayload, db: Session = Depends(get_db)):
    try:
        idinfo = id_token.verify_oauth2_token(
            payload.token, google_requests.Request(), GOOGLE_CLIENT_ID
        )

        google_id = idinfo["sub"]
        email = idinfo.get("email", "")
        name = idinfo.get("name", "")
        picture = idinfo.get("picture", "")

        # Find or create user
        user = db.query(User).filter(User.google_id == google_id).first()
        if user:
            user.last_login = datetime.now(timezone.utc)
            user.name = name
            user.profile_picture = picture
        else:
            user = User(
                google_id=google_id,
                email=email,
                name=name,
                profile_picture=picture
            )
            db.add(user)

        db.commit()
        db.refresh(user)

        access_token = create_access_token({
            "sub": str(user.id),
            "email": user.email,
            "name": user.name,
            "picture": user.profile_picture or ""
        })

        return {
            "access_token": access_token,
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "picture": user.profile_picture,
                "registered_at": user.registered_at.isoformat() if user.registered_at else None,
                "last_login": user.last_login.isoformat() if user.last_login else None
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {str(e)}")
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/auth/me")
async def get_current_user(authorization: str = Header(None), db: Session = Depends(get_db)):
    user = get_current_user_obj(authorization, db)
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "picture": user.profile_picture or "",
        "registered_at": user.registered_at.isoformat() if user.registered_at else None,
        "last_login": user.last_login.isoformat() if user.last_login else None
    }


# --- Database Storage Schemas ---

# --- Database Storage Schemas ---

class ProjectCreate(BaseModel):
    name: str
    file_name: Optional[str] = "Untitled"
    rows_data: Optional[List[Dict[str, Any]]] = None
    headers: Optional[List[str]] = None
    types: Optional[Dict[str, str]] = None

class TableCreate(BaseModel):
    table_name: str
    file_name: str
    rows_data: List[Dict[str, Any]]
    headers: List[str]
    types: Dict[str, str]

class RelationshipUpdate(BaseModel):
    status: str  # "approved" | "rejected" | "suggested"

class DashboardSave(BaseModel):
    widgets: List[Dict[str, Any]]
    layouts: Dict[str, Any]


def get_current_user_obj(authorization: str = Header(None), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == 1).first()
    if not user:
        user = User(
            id=1,
            google_id="guest_user",
            email="guest@cleanlytics.local",
            name="Guest User",
            profile_picture=""
        )
        db.add(user)
        try:
            db.commit()
            db.refresh(user)
        except Exception:
            db.rollback()
    return user


# --- Project REST API ---

@app.post("/api/projects")
async def create_project(payload: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = Project(
            user_id=current_user.id,
            name=payload.name,
            file_name=payload.file_name or "Untitled",
            rows_data=payload.rows_data,
            headers=payload.headers,
            types=payload.types
        )
        db.add(project)
        db.commit()
        db.refresh(project)

        # If raw rows/headers/types were provided directly, auto-create initial DataTable
        if payload.rows_data and payload.headers and payload.types:
            df = pd.DataFrame(payload.rows_data)
            prof = profile_dataset(df)
            table_name = payload.name.split('.')[0] if payload.name else "Dataset"
            dt = DataTable(
                project_id=project.id,
                table_name=table_name,
                file_name=payload.file_name or f"{table_name}.csv",
                rows_data=payload.rows_data,
                headers=payload.headers,
                types=payload.types,
                profile=prof,
                row_count=len(payload.rows_data),
            )
            db.add(dt)
            db.commit()

        return {
            "id": project.id,
            "name": project.name,
            "file_name": project.file_name,
            "created_at": project.created_at.isoformat()
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects")
async def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        projects = db.query(Project).filter(Project.user_id == current_user.id).order_by(Project.created_at.desc()).all()
        result = []
        for p in projects:
            table_count = db.query(DataTable).filter(DataTable.project_id == p.id).count()
            result.append({
                "id": p.id,
                "name": p.name,
                "file_name": p.file_name,
                "table_count": table_count,
                "created_at": p.created_at.isoformat()
            })
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}")
async def get_project(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        tables = db.query(DataTable).filter(DataTable.project_id == project_id).all()
        relationships = db.query(TableRelationship).filter(TableRelationship.project_id == project_id).all()

        return {
            "id": project.id,
            "name": project.name,
            "file_name": project.file_name,
            "rows_data": project.rows_data,  # legacy support
            "headers": project.headers,      # legacy support
            "types": project.types,          # legacy support
            "tables": [
                {
                    "id": t.id,
                    "table_name": t.table_name,
                    "file_name": t.file_name,
                    "row_count": t.row_count,
                    "headers": t.headers,
                    "types": t.types,
                    "profile": t.profile,
                    "created_at": t.created_at.isoformat()
                } for t in tables
            ],
            "relationships": [
                {
                    "id": r.id,
                    "from_table_id": r.from_table_id,
                    "from_column": r.from_column,
                    "to_table_id": r.to_table_id,
                    "to_column": r.to_column,
                    "cardinality": r.cardinality,
                    "confidence": r.confidence,
                    "status": r.status,
                } for r in relationships
            ],
            "created_at": project.created_at.isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        db.delete(project)
        db.commit()
        return {"message": "Project deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# --- DataTables Multi-Table API ---

@app.post("/api/projects/{project_id}/tables")
async def add_table_to_project(project_id: int, payload: TableCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        df = pd.DataFrame(payload.rows_data)
        prof = profile_dataset(df)

        table = DataTable(
            project_id=project_id,
            table_name=payload.table_name,
            file_name=payload.file_name,
            rows_data=payload.rows_data,
            headers=payload.headers,
            types=payload.types,
            profile=prof,
            row_count=len(payload.rows_data)
        )
        db.add(table)
        db.commit()
        db.refresh(table)

        return {
            "id": table.id,
            "table_name": table.table_name,
            "file_name": table.file_name,
            "row_count": table.row_count,
            "headers": table.headers,
            "types": table.types,
            "profile": table.profile,
            "created_at": table.created_at.isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}/tables")
async def list_project_tables(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        tables = db.query(DataTable).filter(DataTable.project_id == project_id).all()
        return [
            {
                "id": t.id,
                "table_name": t.table_name,
                "file_name": t.file_name,
                "row_count": t.row_count,
                "headers": t.headers,
                "types": t.types,
                "profile": t.profile,
                "created_at": t.created_at.isoformat()
            } for t in tables
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}/tables/{table_id}")
async def get_table_data(project_id: int, table_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        table = db.query(DataTable).filter(DataTable.id == table_id, DataTable.project_id == project_id).first()
        if not table:
            raise HTTPException(status_code=404, detail="Table not found")
        return {
            "id": table.id,
            "table_name": table.table_name,
            "file_name": table.file_name,
            "rows_data": table.rows_data,
            "headers": table.headers,
            "types": table.types,
            "profile": table.profile,
            "row_count": table.row_count,
            "created_at": table.created_at.isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/projects/{project_id}/tables/{table_id}")
async def delete_table(project_id: int, table_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        table = db.query(DataTable).filter(DataTable.id == table_id, DataTable.project_id == project_id).first()
        if not table:
            raise HTTPException(status_code=404, detail="Table not found")
        db.delete(table)
        db.commit()
        return {"message": "Table deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# --- Relationship Detection & Management API ---

@app.post("/api/projects/{project_id}/detect-relationships")
async def trigger_detect_relationships(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        tables = db.query(DataTable).filter(DataTable.project_id == project_id).all()
        if len(tables) < 2:
            return {"relationships": [], "message": "At least 2 tables are required for relationship detection."}

        table_payloads = [
            {
                "id": t.id,
                "table_name": t.table_name,
                "profile": t.profile,
                "rows_data": t.rows_data,
            } for t in tables
        ]

        detected = detect_relationships(table_payloads)

        # Merge with existing relationships in DB
        existing = db.query(TableRelationship).filter(TableRelationship.project_id == project_id).all()
        existing_keys = {(r.from_table_id, r.from_column, r.to_table_id, r.to_column): r for r in existing}

        saved_rels = []
        for cand in detected:
            key = (cand['from_table_id'], cand['from_column'], cand['to_table_id'], cand['to_column'])
            if key in existing_keys:
                rel = existing_keys[key]
            else:
                rel = TableRelationship(
                    project_id=project_id,
                    from_table_id=cand['from_table_id'],
                    to_table_id=cand['to_table_id'],
                    from_column=cand['from_column'],
                    to_column=cand['to_column'],
                    cardinality=cand['cardinality'],
                    confidence=cand['confidence'],
                    status=cand['status'],
                )
                db.add(rel)
                db.commit()
                db.refresh(rel)

            saved_rels.append({
                "id": rel.id,
                "from_table_id": rel.from_table_id,
                "from_column": rel.from_column,
                "to_table_id": rel.to_table_id,
                "to_column": rel.to_column,
                "cardinality": rel.cardinality,
                "confidence": rel.confidence,
                "status": rel.status,
            })

        return {"relationships": saved_rels}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}/relationships")
async def get_relationships(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        rels = db.query(TableRelationship).filter(TableRelationship.project_id == project_id).all()
        return [
            {
                "id": r.id,
                "from_table_id": r.from_table_id,
                "from_column": r.from_column,
                "to_table_id": r.to_table_id,
                "to_column": r.to_column,
                "cardinality": r.cardinality,
                "confidence": r.confidence,
                "status": r.status,
            } for r in rels
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/projects/{project_id}/relationships/{rel_id}")
async def update_relationship(project_id: int, rel_id: int, payload: RelationshipUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        rel = db.query(TableRelationship).filter(TableRelationship.id == rel_id, TableRelationship.project_id == project_id).first()
        if not rel:
            raise HTTPException(status_code=404, detail="Relationship not found")

        rel.status = payload.status
        db.commit()
        db.refresh(rel)

        return {
            "id": rel.id,
            "from_table_id": rel.from_table_id,
            "from_column": rel.from_column,
            "to_table_id": rel.to_table_id,
            "to_column": rel.to_column,
            "cardinality": rel.cardinality,
            "confidence": rel.confidence,
            "status": rel.status,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}/semantic-model")
async def get_semantic_model(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        tables = db.query(DataTable).filter(DataTable.project_id == project_id).all()
        rels = db.query(TableRelationship).filter(TableRelationship.project_id == project_id).all()

        table_dict = {t.id: t.table_name for t in tables}

        tables_data = [
            {
                "id": t.id,
                "table_name": t.table_name,
                "file_name": t.file_name,
                "row_count": t.row_count,
                "column_count": len(t.headers),
                "headers": t.headers,
                "types": t.types,
                "profile": t.profile,
            } for t in tables
        ]

        rels_data = [
            {
                "id": r.id,
                "from_table_id": r.from_table_id,
                "from_table_name": table_dict.get(r.from_table_id, f"Table {r.from_table_id}"),
                "from_column": r.from_column,
                "to_table_id": r.to_table_id,
                "to_table_name": table_dict.get(r.to_table_id, f"Table {r.to_table_id}"),
                "to_column": r.to_column,
                "cardinality": r.cardinality,
                "confidence": r.confidence,
                "status": r.status,
            } for r in rels
        ]

        return {
            "project_id": project_id,
            "tables": tables_data,
            "relationships": rels_data,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Dashboard REST API ---

@app.post("/api/projects/{project_id}/dashboard")
async def save_dashboard(project_id: int, payload: DashboardSave, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        dashboard = db.query(Dashboard).filter(Dashboard.project_id == project_id).first()
        if dashboard:
            dashboard.widgets = payload.widgets
            dashboard.layouts = payload.layouts
        else:
            dashboard = Dashboard(
                project_id=project_id,
                widgets=payload.widgets,
                layouts=payload.layouts
            )
            db.add(dashboard)
        
        db.commit()
        return {"message": "Dashboard saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}/dashboard")
async def get_dashboard(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        dashboard = db.query(Dashboard).filter(Dashboard.project_id == project_id).first()
        if not dashboard:
            return {"widgets": [], "layouts": {}}
        
        return {
            "widgets": dashboard.widgets,
            "layouts": dashboard.layouts
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8005, reload=True)

