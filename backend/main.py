from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import pandas as pd
import io
import math
import numpy as np

from dotenv import load_dotenv
import os
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import jwt
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from database import engine, get_db, Base
from models import User, Project, Dashboard

from services.cleaner import clean_data
from services.transformer import transform_data
from services.insights import generate_insights

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

@app.post("/api/insights")
async def insights_endpoint(payload: DataPayload):
    try:
        df = pd.DataFrame(payload.data)
        insights = generate_insights(df)
        
        def replace_nan(obj):
            if isinstance(obj, dict):
                return {k: replace_nan(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [replace_nan(v) for v in obj]
            elif isinstance(obj, float) and math.isnan(obj):
                return None
            return obj
        
        return {"insights": replace_nan(insights)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/export")
async def export_endpoint(payload: DataPayload):
    try:
        df = pd.DataFrame(payload.data)
        format_type = (payload.config or {}).get("format", "csv")
        
        if format_type == "csv":
            csv_data = df.to_csv(index=False)
            return {"file_content": csv_data, "filename": "export.csv", "mime_type": "text/csv"}
        elif format_type == "json":
            json_data = df.to_json(orient="records")
            return {"file_content": json_data, "filename": "export.json", "mime_type": "application/json"}
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
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.split(" ")[1]
    try:
        payload_data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload_data.get("sub")
        user = db.query(User).filter(User.id == int(user_id)).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        return {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "picture": user.profile_picture,
            "registered_at": user.registered_at.isoformat() if user.registered_at else None,
            "last_login": user.last_login.isoformat() if user.last_login else None
        }
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# --- Database Storage Schemas ---

class ProjectCreate(BaseModel):
    name: str
    file_name: str
    rows_data: List[Dict[str, Any]]
    headers: List[str]
    types: Dict[str, str]

class DashboardSave(BaseModel):
    widgets: List[Dict[str, Any]]
    layouts: Dict[str, Any]


def get_current_user_obj(authorization: str = Header(None), db: Session = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    token = authorization.split(" ")[1]
    try:
        payload_data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload_data.get("sub")
        user = db.query(User).filter(User.id == int(user_id)).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return user
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# --- Project REST API ---

@app.post("/api/projects")
async def create_project(payload: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = Project(
            user_id=current_user.id,
            name=payload.name,
            file_name=payload.file_name,
            rows_data=payload.rows_data,
            headers=payload.headers,
            types=payload.types
        )
        db.add(project)
        db.commit()
        db.refresh(project)
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
        return [
            {
                "id": p.id,
                "name": p.name,
                "file_name": p.file_name,
                "created_at": p.created_at.isoformat()
            } for p in projects
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_id}")
async def get_project(project_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        return {
            "id": project.id,
            "name": project.name,
            "file_name": project.file_name,
            "rows_data": project.rows_data,
            "headers": project.headers,
            "types": project.types,
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


# --- Dashboard REST API ---

@app.post("/api/projects/{project_id}/dashboard")
async def save_dashboard(project_id: int, payload: DashboardSave, db: Session = Depends(get_db), current_user: User = Depends(get_current_user_obj)):
    try:
        # Verify project ownership
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
        # Verify project ownership
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

