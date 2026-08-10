from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(String(255), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    profile_picture = Column(String(500), nullable=True)
    registered_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_login = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<User(id={self.id}, email='{self.email}', name='{self.name}')>"


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    file_name = Column(String(255), nullable=True)  # Legacy: kept for backward compat
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Legacy single-table fields (nullable — new projects use DataTable instead)
    rows_data = Column(JSON, nullable=True)
    headers = Column(JSON, nullable=True)
    types = Column(JSON, nullable=True)

    user = relationship("User", back_populates="projects")
    dashboards = relationship("Dashboard", back_populates="project", cascade="all, delete-orphan")
    tables = relationship("DataTable", back_populates="project", cascade="all, delete-orphan")
    relationships_list = relationship("TableRelationship", back_populates="project", cascade="all, delete-orphan")


class DataTable(Base):
    """Individual table within a project (one file or one sheet = one DataTable)."""
    __tablename__ = "data_tables"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    table_name = Column(String(255), nullable=False)    # User-facing name (e.g. "Sales")
    file_name = Column(String(255), nullable=False)     # Source file name
    rows_data = Column(JSON, nullable=False)
    headers = Column(JSON, nullable=False)
    types = Column(JSON, nullable=False)
    profile = Column(JSON, nullable=True)               # Cached semantic profile
    row_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="tables")


class TableRelationship(Base):
    """A detected or user-defined relationship between two DataTables."""
    __tablename__ = "table_relationships"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    from_table_id = Column(Integer, ForeignKey("data_tables.id", ondelete="CASCADE"), nullable=False)
    to_table_id = Column(Integer, ForeignKey("data_tables.id", ondelete="CASCADE"), nullable=False)
    from_column = Column(String(255), nullable=False)
    to_column = Column(String(255), nullable=False)
    cardinality = Column(String(10), nullable=False, default="N:1")  # "1:1", "1:N", "N:1", "N:M"
    confidence = Column(Float, nullable=False, default=0.0)
    status = Column(String(20), nullable=False, default="suggested")  # "suggested" | "approved" | "rejected"
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="relationships_list")
    from_table = relationship("DataTable", foreign_keys=[from_table_id])
    to_table = relationship("DataTable", foreign_keys=[to_table_id])


class Dashboard(Base):
    __tablename__ = "dashboards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True)
    widgets = Column(JSON, nullable=False)
    layouts = Column(JSON, nullable=False)

    project = relationship("Project", back_populates="dashboards")
