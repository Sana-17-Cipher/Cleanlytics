"""
CLEANYTICS - DuckDB storage layer.

Every project owns one DuckDB file under `backend/data/projects/`. Each uploaded
file (or Excel sheet) becomes one physical table `t_<table_id>` inside it.

Nothing in this module ever loads a full table into Python memory. Callers get
either aggregate results or an explicitly paged slice of rows, which is what
lets the app handle a 100 MB CSV without the browser or the API falling over.
"""

from __future__ import annotations

import os
import re
import shutil
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import duckdb

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
UPLOADS_DIR = DATA_DIR / "uploads"

# Read this many bytes at a time when saving an upload to disk. Keeps peak
# memory flat regardless of file size.
UPLOAD_CHUNK_BYTES = 1024 * 1024

# Above this row count the profiler switches to approximate distinct counts and
# samples for the expensive regex passes. Exact answers below it.
LARGE_TABLE_ROWS = 2_000_000

MAX_UPLOAD_BYTES = 200 * 1024 * 1024


class StoreError(RuntimeError):
    """Raised for user-facing storage problems (bad file, unreadable sheet...)."""


# ─── Identifier safety ───────────────────────────────────────────────────────
#
# Column names come from user files and can contain anything at all, including
# quotes and semicolons. Every identifier that reaches SQL goes through `q()`.


def q(identifier: str) -> str:
    """Quote an SQL identifier, escaping embedded double quotes."""
    return '"' + str(identifier).replace('"', '""') + '"'


def lit(value: str) -> str:
    """Quote a string literal, escaping embedded single quotes."""
    return "'" + str(value).replace("'", "''") + "'"


def physical_name(table_id: int) -> str:
    return f"t_{int(table_id)}"


_INVALID_COL = re.compile(r"[\x00-\x1f]")


def clean_column_name(name: Any, index: int, taken: set[str]) -> str:
    """
    Normalise one column name: strip control characters and surrounding space,
    fall back to a positional name when blank, and de-duplicate collisions.

    De-duplication is case-insensitive because DuckDB resolves identifiers
    case-insensitively; leaving `Region` and `region` both present would make
    every later reference to either one ambiguous.
    """
    text = "" if name is None else str(name)
    text = unicodedata.normalize("NFKC", text)
    text = _INVALID_COL.sub("", text).strip()
    if not text:
        text = f"column_{index + 1}"

    candidate = text
    suffix = 2
    while candidate.casefold() in taken:
        candidate = f"{text}_{suffix}"
        suffix += 1
    taken.add(candidate.casefold())
    return candidate


# ─── Connections ─────────────────────────────────────────────────────────────


def _ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def project_db_path(project_id: int) -> Path:
    _ensure_dirs()
    return PROJECTS_DIR / f"project_{int(project_id)}.duckdb"


@contextmanager
def connect(project_id: int, read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
    """
    Open the project's DuckDB file.

    Opened per request rather than pooled: DuckDB allows a single writer, and a
    short-lived connection keeps concurrent requests from deadlocking on each
    other. `read_only=True` is safe to run concurrently with other readers.
    """
    path = project_db_path(project_id)
    if read_only and not path.exists():
        raise StoreError("This project has no data yet.")

    con = duckdb.connect(str(path), read_only=read_only)
    try:
        # Bound memory so one oversized query cannot take the API process down.
        con.execute("SET memory_limit='2GB'")
        con.execute("SET preserve_insertion_order=false")
        yield con
    finally:
        con.close()


def delete_project_data(project_id: int) -> None:
    """Remove a project's DuckDB file. Safe to call when it was never created."""
    path = project_db_path(project_id)
    for candidate in (path, Path(str(path) + ".wal")):
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            # Windows can hold the file briefly after close; leaving an orphan
            # file is better than failing the user's delete request.
            pass


# ─── Upload handling ─────────────────────────────────────────────────────────


def save_upload(file_obj, filename: str) -> Path:
    """
    Stream an incoming upload to disk in fixed-size chunks.

    Returns the path of the saved temp file. The caller owns it and is expected
    to call `discard_upload` when finished.
    """
    _ensure_dirs()
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(filename or "upload"))
    target = UPLOADS_DIR / f"{os.getpid()}_{id(file_obj)}_{safe}"

    written = 0
    with target.open("wb") as out:
        while True:
            chunk = file_obj.read(UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                out.close()
                discard_upload(target)
                raise StoreError(
                    f"File is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit."
                )
            out.write(chunk)

    if written == 0:
        discard_upload(target)
        raise StoreError("The uploaded file is empty.")
    return target


def discard_upload(path: Path) -> None:
    try:
        Path(path).unlink()
    except (FileNotFoundError, OSError):
        pass


# ─── Ingest ──────────────────────────────────────────────────────────────────

CSV_EXTENSIONS = {".csv", ".tsv", ".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm"}
PARQUET_EXTENSIONS = {".parquet"}
SUPPORTED_EXTENSIONS = CSV_EXTENSIONS | EXCEL_EXTENSIONS | PARQUET_EXTENSIONS


def list_sources(path: Path, filename: str) -> List[Dict[str, Any]]:
    """
    Describe the logical tables inside an uploaded file.

    A CSV or Parquet file is one table. An Excel workbook is one table per
    non-empty sheet, which is what lets a single upload populate a whole model.
    """
    ext = Path(filename).suffix.lower()
    if ext in CSV_EXTENSIONS or ext in PARQUET_EXTENSIONS:
        return [{"sheet": None, "label": Path(filename).stem}]

    if ext in EXCEL_EXTENSIONS:
        import openpyxl

        try:
            book = openpyxl.load_workbook(path, read_only=True, data_only=True)
        except Exception as exc:  # openpyxl raises a wide range of errors
            raise StoreError(f"Could not read the Excel file: {exc}") from exc

        sheets: List[Dict[str, Any]] = []
        try:
            for name in book.sheetnames:
                sheet = book[name]
                # `max_row` is None for some streamed sheets; treat as non-empty
                # and let the loader decide.
                if sheet.max_row is not None and sheet.max_row < 2:
                    continue
                sheets.append({"sheet": name, "label": name})
        finally:
            book.close()

        if not sheets:
            raise StoreError("This workbook has no sheets containing data.")
        return sheets

    raise StoreError(
        f"Unsupported file type '{ext}'. Upload a CSV, Excel or Parquet file."
    )


def _rename_columns(con: duckdb.DuckDBPyConnection, table: str) -> List[str]:
    """
    Normalise the column names of a freshly created table in place.

    DuckDB's CSV reader already de-duplicates exact repeats, but it preserves
    stray whitespace and lets names differing only by case coexist. Both break
    later SQL, so every table is normalised the same way on the way in.
    """
    current = [row[0] for row in con.execute(f"DESCRIBE {q(table)}").fetchall()]
    taken: set[str] = set()
    final: List[str] = []
    for index, name in enumerate(current):
        final.append(clean_column_name(name, index, taken))

    for old, new in zip(current, final):
        if old != new:
            con.execute(f"ALTER TABLE {q(table)} RENAME COLUMN {q(old)} TO {q(new)}")
    return final


def _create_from_csv(con, table: str, path: Path) -> None:
    """
    Load a delimited file.

    Two attempts: first with DuckDB's full type sniffer, then, if that trips on
    ragged or dirty rows, a permissive pass that keeps every column as text so
    the user still gets their data and can see the problem in the profile.
    """
    source = lit(str(path))
    strict = (
        f"CREATE OR REPLACE TABLE {q(table)} AS "
        f"SELECT * FROM read_csv({source}, auto_detect=true, sample_size=1048576, "
        f"header=true, null_padding=true, ignore_errors=false)"
    )
    try:
        con.execute(strict)
        return
    except duckdb.Error:
        pass

    permissive = (
        f"CREATE OR REPLACE TABLE {q(table)} AS "
        f"SELECT * FROM read_csv({source}, auto_detect=true, sample_size=1048576, "
        f"header=true, null_padding=true, ignore_errors=true, all_varchar=true)"
    )
    try:
        con.execute(permissive)
    except duckdb.Error as exc:
        raise StoreError(f"Could not parse this file as a table: {exc}") from exc


def _create_from_parquet(con, table: str, path: Path) -> None:
    try:
        con.execute(
            f"CREATE OR REPLACE TABLE {q(table)} AS "
            f"SELECT * FROM read_parquet({lit(str(path))})"
        )
    except duckdb.Error as exc:
        raise StoreError(f"Could not read the Parquet file: {exc}") from exc


def _create_from_excel(con, table: str, path: Path, sheet: Optional[str]) -> None:
    """
    Load one Excel sheet.

    Goes through pandas because it handles merged headers, mixed-type columns
    and date cells far more forgivingly than the DuckDB excel extension. Excel
    files are bounded by the format itself (about a million rows), so the
    in-memory hop is acceptable here in a way it would not be for CSV.
    """
    import pandas as pd

    try:
        frame = pd.read_excel(path, sheet_name=sheet or 0)
    except Exception as exc:
        raise StoreError(f"Could not read sheet '{sheet or 1}': {exc}") from exc

    if frame.empty and len(frame.columns) == 0:
        raise StoreError(f"Sheet '{sheet or 1}' is empty.")

    taken: set[str] = set()
    frame.columns = [
        clean_column_name(name, index, taken) for index, name in enumerate(frame.columns)
    ]

    con.register("_incoming_sheet", frame)
    try:
        con.execute(
            f"CREATE OR REPLACE TABLE {q(table)} AS SELECT * FROM _incoming_sheet"
        )
    finally:
        con.unregister("_incoming_sheet")


def ingest(
    project_id: int,
    table_id: int,
    path: Path,
    filename: str,
    sheet: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Load one file (or one sheet) into the project's DuckDB as `t_<table_id>`.

    Returns the resulting shape so the caller can persist metadata without a
    second round trip.
    """
    ext = Path(filename).suffix.lower()
    table = physical_name(table_id)

    with connect(project_id) as con:
        if ext in CSV_EXTENSIONS:
            _create_from_csv(con, table, path)
        elif ext in PARQUET_EXTENSIONS:
            _create_from_parquet(con, table, path)
        elif ext in EXCEL_EXTENSIONS:
            _create_from_excel(con, table, path, sheet)
        else:
            raise StoreError(f"Unsupported file type '{ext}'.")

        columns = _rename_columns(con, table)
        if not columns:
            con.execute(f"DROP TABLE IF EXISTS {q(table)}")
            raise StoreError("No columns were found in this file.")

        row_count = con.execute(f"SELECT count(*) FROM {q(table)}").fetchone()[0]
        if row_count == 0:
            con.execute(f"DROP TABLE IF EXISTS {q(table)}")
            raise StoreError("This file has headers but no data rows.")

        schema = describe(con, table)

    return {
        "physical_name": table,
        "row_count": int(row_count),
        "columns": columns,
        "schema": schema,
    }


# ─── Reading ─────────────────────────────────────────────────────────────────


def describe(con: duckdb.DuckDBPyConnection, table: str) -> List[Dict[str, str]]:
    """Column names and DuckDB types, in table order."""
    rows = con.execute(f"DESCRIBE {q(table)}").fetchall()
    return [{"name": r[0], "type": r[1]} for r in rows]


def table_exists(con: duckdb.DuckDBPyConnection, table: str) -> bool:
    found = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = ?",
        [table],
    ).fetchone()[0]
    return bool(found)


def row_count(con: duckdb.DuckDBPyConnection, table: str) -> int:
    return int(con.execute(f"SELECT count(*) FROM {q(table)}").fetchone()[0])


def fetch_dicts(
    con: duckdb.DuckDBPyConnection, sql: str, params: Optional[list] = None
) -> List[Dict[str, Any]]:
    """Run a query and return rows as dicts keyed by column name."""
    cursor = con.execute(sql, params or [])
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def page_rows(
    project_id: int,
    table: str,
    offset: int = 0,
    limit: int = 100,
    order_by: Optional[str] = None,
    descending: bool = False,
    search: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Return one page of rows plus the total matching count.

    This is the only path by which raw rows reach the client, and it is always
    bounded. `limit` is clamped so a hand-edited request cannot ask for a
    million rows.
    """
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    with connect(project_id, read_only=True) as con:
        if not table_exists(con, table):
            raise StoreError("This table no longer exists.")

        columns = [c["name"] for c in describe(con, table)]
        where = ""
        params: List[Any] = []

        if search:
            # Match the search term against every column cast to text. Cheap
            # enough for the preview grid and behaves predictably on any type.
            clauses = " OR ".join(
                f"CAST({q(name)} AS VARCHAR) ILIKE ?" for name in columns
            )
            where = f" WHERE {clauses}"
            params = [f"%{search}%"] * len(columns)

        total = con.execute(
            f"SELECT count(*) FROM {q(table)}{where}", params
        ).fetchone()[0]

        order = ""
        if order_by and order_by in columns:
            order = f" ORDER BY {q(order_by)} {'DESC' if descending else 'ASC'} NULLS LAST"

        rows = fetch_dicts(
            con,
            f"SELECT * FROM {q(table)}{where}{order} LIMIT {limit} OFFSET {offset}",
            params,
        )

    return {"rows": rows, "total": int(total), "offset": offset, "limit": limit}


def drop_table(project_id: int, table: str) -> None:
    with connect(project_id) as con:
        con.execute(f"DROP TABLE IF EXISTS {q(table)}")


def rename_columns_map(project_id: int, table: str, mapping: Dict[str, str]) -> List[str]:
    """Apply a {old: new} rename, skipping entries that would collide."""
    with connect(project_id) as con:
        existing = {c["name"].casefold() for c in describe(con, table)}
        for old, new in mapping.items():
            if old == new:
                continue
            if old.casefold() not in existing:
                continue
            if new.casefold() in existing:
                continue
            con.execute(f"ALTER TABLE {q(table)} RENAME COLUMN {q(old)} TO {q(new)}")
            existing.discard(old.casefold())
            existing.add(new.casefold())
        return [c["name"] for c in describe(con, table)]


def export_query(project_id: int, table: str, fmt: str, destination: Path) -> None:
    """Write a whole table to disk in the requested format, streamed by DuckDB."""
    fmt = fmt.lower()
    with connect(project_id, read_only=True) as con:
        if not table_exists(con, table):
            raise StoreError("This table no longer exists.")

        target = lit(str(destination))
        if fmt == "csv":
            con.execute(f"COPY {q(table)} TO {target} (FORMAT CSV, HEADER)")
        elif fmt == "parquet":
            con.execute(f"COPY {q(table)} TO {target} (FORMAT PARQUET)")
        elif fmt == "json":
            con.execute(f"COPY {q(table)} TO {target} (FORMAT JSON, ARRAY true)")
        elif fmt == "xlsx":
            con.execute("INSTALL excel; LOAD excel;")
            con.execute(f"COPY {q(table)} TO {target} (FORMAT XLSX, HEADER true)")
        else:
            raise StoreError(f"Unsupported export format '{fmt}'.")
