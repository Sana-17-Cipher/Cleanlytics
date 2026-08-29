"""
CLEANYTICS - metadata schema.

This database holds only metadata: who owns which project, what tables exist,
how they relate, and what has been done to them. The rows themselves live in
each project's DuckDB file.

That split is the point. The previous schema stored every uploaded row as a
JSON blob in a column, which put a hard ceiling on file size, made every query
a full deserialise, and left no way to write cleaned data back.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
)
from sqlalchemy.orm import relationship

from database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    google_id = Column(String(255), unique=True, nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    picture = Column(String(500), nullable=True)
    is_guest = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=_now)
    last_login = Column(DateTime, default=_now, onupdate=_now)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    user = relationship("User", back_populates="projects")
    tables = relationship("DataTable", back_populates="project", cascade="all, delete-orphan")
    relationships_list = relationship("TableRelationship", back_populates="project", cascade="all, delete-orphan")
    dashboards = relationship("Dashboard", back_populates="project", cascade="all, delete-orphan")


class DataTable(Base):
    """One uploaded file, or one sheet of a workbook."""

    __tablename__ = "data_tables"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)

    table_name = Column(String(255), nullable=False)
    source_file = Column(String(500), nullable=False)
    source_sheet = Column(String(255), nullable=True)

    # Physical DuckDB table inside the project's database file.
    physical_name = Column(String(64), nullable=False)

    row_count = Column(Integer, nullable=False, default=0)
    column_count = Column(Integer, nullable=False, default=0)
    byte_size = Column(Integer, nullable=True)

    # Cached analysis. Recomputed whenever the table is modified.
    profile = Column(JSON, nullable=True)
    quality = Column(JSON, nullable=True)
    profiled_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    project = relationship("Project", back_populates="tables")
    operations = relationship("OperationLog", back_populates="table", cascade="all, delete-orphan")


class TableRelationship(Base):
    """
    A link between two tables, always stored foreign key -> primary key.

    `from_*` is the child (many) side and `to_*` is the parent (one) side, so
    cardinality reads in the same direction as the arrow the user sees.
    """

    __tablename__ = "table_relationships"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "from_table_id", "from_column", "to_table_id", "to_column",
            name="uq_relationship_edge",
        ),
        Index("ix_relationship_project", "project_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    from_table_id = Column(Integer, ForeignKey("data_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    to_table_id = Column(Integer, ForeignKey("data_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    from_column = Column(String(255), nullable=False)
    to_column = Column(String(255), nullable=False)

    # one_to_one | one_to_many | many_to_one | many_to_many
    cardinality = Column(String(20), nullable=False, default="many_to_one")
    confidence = Column(Float, nullable=False, default=0.0)
    coverage = Column(Float, nullable=True)
    status = Column(String(20), nullable=False, default="suggested")
    origin = Column(String(20), nullable=False, default="detected")  # detected | manual
    evidence = Column(Text, nullable=True)
    notes = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=_now)

    project = relationship("Project", back_populates="relationships_list")
    from_table = relationship("DataTable", foreign_keys=[from_table_id])
    to_table = relationship("DataTable", foreign_keys=[to_table_id])


class OperationLog(Base):
    """
    What was done to a table, in order.

    Recorded so the user can see the provenance of the data they are looking at.
    The description is the one the operation itself produced after running, not
    a prediction made beforehand.
    """

    __tablename__ = "operation_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    table_id = Column(Integer, ForeignKey("data_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    operation = Column(String(64), nullable=False)
    params = Column(JSON, nullable=True)
    description = Column(Text, nullable=False)
    rows_before = Column(Integer, nullable=True)
    rows_after = Column(Integer, nullable=True)
    destructive = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=_now)

    table = relationship("DataTable", back_populates="operations")


class Dashboard(Base):
    __tablename__ = "dashboards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    widgets = Column(JSON, nullable=False, default=list)
    layouts = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    project = relationship("Project", back_populates="dashboards")
