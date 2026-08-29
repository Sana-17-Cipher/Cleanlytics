"""
CLEANYTICS - data operations.

Every change to a table goes through this module. That is deliberate: in the
previous build the label on a button and the code that ran when you pressed it
lived in different files, which is how "impute missing values with the median"
came to silently delete rows instead.

Here each operation is one function that returns the exact description of what
it did, measured after the fact. The UI renders that description. There is no
second copy of the wording to drift out of sync.

Two other guarantees:

  * Anything that can remove rows or columns is marked `destructive` and
    snapshots the table first, so undo restores real data rather than replaying
    client-side state.
  * Row counts before and after are always reported, so "nothing happened" is
    visible instead of being dressed up as success.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import duckdb

from store import connect, describe, q, lit, table_exists
from analysis import semantics

# Keep this many undo snapshots per table. Snapshots are full copies, but
# DuckDB writes them column-wise and they are cheap relative to the safety.
MAX_SNAPSHOTS = 5

SNAPSHOT_RE = re.compile(r"^(?P<base>t_\d+)__undo(?P<seq>\d+)$")


class OperationError(ValueError):
    """A problem the user can understand and act on."""


@dataclass
class OperationResult:
    description: str
    rows_before: int
    rows_after: int
    cells_changed: int = 0
    columns_added: List[str] = field(default_factory=list)
    columns_removed: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "description": self.description,
            "rows_before": self.rows_before,
            "rows_after": self.rows_after,
            "rows_removed": max(self.rows_before - self.rows_after, 0),
            "cells_changed": self.cells_changed,
            "columns_added": self.columns_added,
            "columns_removed": self.columns_removed,
            "warnings": self.warnings,
        }


# ─── Snapshots and undo ──────────────────────────────────────────────────────


def _snapshot_names(con: duckdb.DuckDBPyConnection, table: str) -> List[str]:
    rows = con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE ? ORDER BY table_name",
        [f"{table}__undo%"],
    ).fetchall()
    names = [r[0] for r in rows]
    return sorted(names, key=lambda n: int(SNAPSHOT_RE.match(n).group("seq")) if SNAPSHOT_RE.match(n) else 0)


def take_snapshot(con: duckdb.DuckDBPyConnection, table: str) -> str:
    """Copy the table aside so the next operation can be undone."""
    existing = _snapshot_names(con, table)
    next_seq = 1
    if existing:
        last = SNAPSHOT_RE.match(existing[-1])
        next_seq = (int(last.group("seq")) + 1) if last else len(existing) + 1

    name = f"{table}__undo{next_seq}"
    con.execute(f"CREATE OR REPLACE TABLE {q(name)} AS SELECT * FROM {q(table)}")

    # Drop the oldest snapshots beyond the retention limit.
    for stale in _snapshot_names(con, table)[:-MAX_SNAPSHOTS]:
        con.execute(f"DROP TABLE IF EXISTS {q(stale)}")
    return name


def undo_last(project_id: int, table: str) -> Dict[str, Any]:
    """Restore the most recent snapshot. Returns the resulting row count."""
    with connect(project_id) as con:
        snapshots = _snapshot_names(con, table)
        if not snapshots:
            raise OperationError("There is nothing left to undo for this table.")

        latest = snapshots[-1]
        con.execute(f"CREATE OR REPLACE TABLE {q(table)} AS SELECT * FROM {q(latest)}")
        con.execute(f"DROP TABLE IF EXISTS {q(latest)}")
        rows = con.execute(f"SELECT count(*) FROM {q(table)}").fetchone()[0]
        remaining = len(snapshots) - 1
    return {"rows": int(rows), "undo_steps_remaining": remaining}


def undo_depth(con: duckdb.DuckDBPyConnection, table: str) -> int:
    return len(_snapshot_names(con, table))


def drop_snapshots(con: duckdb.DuckDBPyConnection, table: str) -> None:
    for name in _snapshot_names(con, table):
        con.execute(f"DROP TABLE IF EXISTS {q(name)}")


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> Dict[str, str]:
    return {c["name"]: c["type"] for c in describe(con, table)}


def _require_column(con: duckdb.DuckDBPyConnection, table: str, name: Optional[str]) -> str:
    columns = _columns(con, table)
    if not name or name not in columns:
        raise OperationError(f"Column '{name}' is not in this table.")
    return name


def _rows(con: duckdb.DuckDBPyConnection, table: str) -> int:
    return int(con.execute(f"SELECT count(*) FROM {q(table)}").fetchone()[0])


def _unique_column_name(existing: Dict[str, str], preferred: str) -> str:
    """Pick a free column name, appending a counter only if needed."""
    taken = {name.casefold() for name in existing}
    candidate = (preferred or "new_column").strip() or "new_column"
    if candidate.casefold() not in taken:
        return candidate
    index = 2
    while f"{candidate}_{index}".casefold() in taken:
        index += 1
    return f"{candidate}_{index}"


def _text(col: str) -> str:
    return f"CAST({q(col)} AS VARCHAR)"


def _fmt(value: Any) -> str:
    """Format a number for a human-readable description."""
    if value is None:
        return "nothing"
    if isinstance(value, float):
        return f"{value:,.2f}".rstrip("0").rstrip(".")
    return f"{value:,}"


def _count(n: int, singular: str, plural: Optional[str] = None) -> str:
    """Format a count with the right noun, so results never read '1 values'."""
    return f"{n:,} {singular if n == 1 else (plural or singular + 's')}"


# ─── Date order detection ────────────────────────────────────────────────────

DATE_FORMATS_DAY_FIRST = [
    "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y",
    "%d %b %Y", "%d %B %Y", "%d %b, %Y", "%d %B, %Y",
    "%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S",
]
DATE_FORMATS_MONTH_FIRST = [
    "%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y", "%m/%d/%y", "%m-%d-%y",
    "%b %d %Y", "%B %d %Y", "%b %d, %Y", "%B %d, %Y",
    "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S",
]
DATE_FORMATS_COMMON = [
    "%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%Y.%m.%d",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
    "%d-%b-%Y", "%d-%b-%y", "%b-%d-%Y", "%Y-%b-%d",
    "%Y-%m", "%b %Y", "%B %Y",
]


def detect_date_order(con: duckdb.DuckDBPyConnection, table: str, column: str) -> str:
    """
    Work out whether ambiguous dates are day-first or month-first.

    01/02/2023 is either 1 February or 2 January and no amount of staring at
    that one value settles it. But if any value in the column has a first
    component above 12, the whole column must be day-first. That single
    observation resolves the format for every other row, which is what a person
    would do by hand.
    """
    text = _text(column)
    row = con.execute(
        f"""
        SELECT
          count(*) FILTER (
            WHERE regexp_matches({text}, '^[0-9]{{1,2}}[/.-][0-9]{{1,2}}[/.-][0-9]{{2,4}}')
              AND TRY_CAST(regexp_extract({text}, '^([0-9]{{1,2}})', 1) AS INTEGER) > 12
          ) AS day_first,
          count(*) FILTER (
            WHERE regexp_matches({text}, '^[0-9]{{1,2}}[/.-][0-9]{{1,2}}[/.-][0-9]{{2,4}}')
              AND TRY_CAST(regexp_extract({text}, '^[0-9]{{1,2}}[/.-]([0-9]{{1,2}})', 1) AS INTEGER) > 12
          ) AS month_first
        FROM {q(table)} WHERE {q(column)} IS NOT NULL
        """
    ).fetchone()

    day_first, month_first = int(row[0] or 0), int(row[1] or 0)
    if day_first and not month_first:
        return "day_first"
    if month_first and not day_first:
        return "month_first"
    if day_first and month_first:
        # Both appear, so the column mixes conventions and no single order is
        # correct. Reported by the caller rather than silently guessed.
        return "ambiguous"
    return "unknown"


def _date_parse_expression(column: str, order: str) -> str:
    """Build a COALESCE chain that parses the formats we can identify."""
    text = f"trim({_text(column)})"
    formats = list(DATE_FORMATS_COMMON)
    if order == "day_first":
        formats += DATE_FORMATS_DAY_FIRST + DATE_FORMATS_MONTH_FIRST
    else:
        formats += DATE_FORMATS_MONTH_FIRST + DATE_FORMATS_DAY_FIRST

    parts = [f"TRY_CAST({text} AS DATE)"]
    parts += [f"CAST(try_strptime({text}, {lit(f)}) AS DATE)" for f in formats]
    return f"COALESCE({', '.join(parts)})"


# ─── Operations ──────────────────────────────────────────────────────────────


def op_trim_whitespace(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    text = _text(column)
    before = _rows(con, table)
    changed = int(
        con.execute(
            f"SELECT count(*) FROM {q(table)} WHERE {q(column)} IS NOT NULL AND {text} <> trim({text})"
        ).fetchone()[0]
    )
    con.execute(f"UPDATE {q(table)} SET {q(column)} = trim({text}) WHERE {q(column)} IS NOT NULL AND {text} <> trim({text})")
    return OperationResult(
        description=f"Trimmed leading and trailing spaces from {_count(changed, 'value')} in \"{column}\".",
        rows_before=before,
        rows_after=before,
        cells_changed=changed,
    )


def op_normalize_case(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """
    Collapse spellings that differ only by case or padding.

    Deliberately does not force Title Case. Doing so turns "USA" into "Usa" and
    "iPhone" into "Iphone". Instead each group of variants adopts whichever
    spelling appears most often in the data, which preserves real acronyms and
    brand casing.
    """
    column = _require_column(con, table, params.get("column"))
    text = _text(column)
    before = _rows(con, table)

    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE _canonical AS
        WITH counts AS (
            SELECT {text} AS spelling, count(*) AS n
            FROM {q(table)} WHERE {q(column)} IS NOT NULL GROUP BY 1
        ), ranked AS (
            SELECT lower(trim(spelling)) AS folded, spelling, n,
                   row_number() OVER (
                       PARTITION BY lower(trim(spelling))
                       ORDER BY n DESC,
                                -- Prefer a spelling that carries real casing
                                -- (USA, iPhone) over all-lower or all-upper.
                                CASE WHEN spelling <> lower(spelling) AND spelling <> upper(spelling) THEN 0 ELSE 1 END,
                                spelling
                   ) AS rn
            FROM counts
        )
        SELECT folded, spelling AS canonical FROM ranked WHERE rn = 1
        """
    )

    changed = int(
        con.execute(
            f"""SELECT count(*) FROM {q(table)} t JOIN _canonical c
                ON lower(trim({text})) = c.folded
                WHERE {q(column)} IS NOT NULL AND {text} <> c.canonical"""
        ).fetchone()[0]
    )
    variants = int(
        con.execute(
            f"""SELECT count(*) FROM (
                    SELECT folded FROM _canonical c
                    WHERE (SELECT count(DISTINCT {text}) FROM {q(table)} WHERE lower(trim({text})) = c.folded) > 1
                )"""
        ).fetchone()[0]
    )

    con.execute(
        f"""UPDATE {q(table)} SET {q(column)} = c.canonical FROM _canonical c
            WHERE lower(trim({_text(column)})) = c.folded AND {q(column)} IS NOT NULL AND {_text(column)} <> c.canonical"""
    )
    con.execute("DROP TABLE IF EXISTS _canonical")

    return OperationResult(
        description=(
            f"Merged {_count(variants, 'group')} of differently-spelled values in \"{column}\", "
            f"updating {_count(changed, 'row')} to the most common spelling of each."
        ),
        rows_before=before,
        rows_after=before,
        cells_changed=changed,
    )


def op_blanks_to_null(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    text = _text(column)
    before = _rows(con, table)
    changed = int(
        con.execute(
            f"SELECT count(*) FROM {q(table)} WHERE {q(column)} IS NOT NULL AND trim({text}) = ''"
        ).fetchone()[0]
    )
    con.execute(f"UPDATE {q(table)} SET {q(column)} = NULL WHERE {q(column)} IS NOT NULL AND trim({_text(column)}) = ''")
    return OperationResult(
        description=f"Converted {_count(changed, 'empty text entry', 'empty text entries')} in \"{column}\" to proper missing values.",
        rows_before=before,
        rows_after=before,
        cells_changed=changed,
    )


def op_drop_duplicate_rows(con, table: str, params: Dict[str, Any]) -> OperationResult:
    subset = params.get("columns") or []
    known = _columns(con, table)
    subset = [c for c in subset if c in known]
    before = _rows(con, table)

    if subset:
        keys = ", ".join(q(c) for c in subset)
        con.execute(
            f"""CREATE OR REPLACE TABLE {q(table)} AS
                SELECT * EXCLUDE (_rn) FROM (
                    SELECT *, row_number() OVER (PARTITION BY {keys}) AS _rn FROM {q(table)}
                ) WHERE _rn = 1"""
        )
        scope = f"rows sharing the same {', '.join(subset)}"
    else:
        con.execute(f"CREATE OR REPLACE TABLE {q(table)} AS SELECT DISTINCT * FROM {q(table)}")
        scope = "rows identical across every column"

    after = _rows(con, table)
    return OperationResult(
        description=f"Removed {_count(before - after, 'duplicate row')} ({scope}).",
        rows_before=before,
        rows_after=after,
    )


def op_fill_missing(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """
    Replace missing values in place. Never removes a row.

    The strategy is chosen by the caller and named in the resulting description,
    so what the user was offered and what actually ran cannot diverge.
    """
    column = _require_column(con, table, params.get("column"))
    strategy = str(params.get("strategy") or "").lower()
    before = _rows(con, table)
    types = _columns(con, table)
    numeric = semantics.is_numeric_type(types[column])

    missing = int(con.execute(f"SELECT count(*) FROM {q(table)} WHERE {q(column)} IS NULL").fetchone()[0])
    if missing == 0:
        return OperationResult(
            description=f"\"{column}\" had no missing values, so nothing changed.",
            rows_before=before,
            rows_after=before,
        )

    if strategy in {"median", "mean"} and not numeric:
        raise OperationError(
            f"\"{column}\" is not numeric, so it cannot be filled with the {strategy}. Use the most common value instead."
        )

    if strategy == "median":
        value = con.execute(f"SELECT median({q(column)}) FROM {q(table)}").fetchone()[0]
        label = f"the median ({_fmt(value)})"
    elif strategy == "mean":
        value = con.execute(f"SELECT avg({q(column)}) FROM {q(table)}").fetchone()[0]
        label = f"the average ({_fmt(value)})"
    elif strategy == "mode":
        value = con.execute(
            f"SELECT {q(column)} FROM {q(table)} WHERE {q(column)} IS NOT NULL "
            f"GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"
        ).fetchone()
        value = value[0] if value else None
        label = f"the most common value ({value})"
    elif strategy == "constant":
        value = params.get("value")
        if value is None or value == "":
            raise OperationError("Provide the value to fill with.")
        label = f"\"{value}\""
    else:
        raise OperationError(f"Unknown fill strategy '{strategy}'.")

    if value is None:
        raise OperationError(f"Could not work out a fill value for \"{column}\".")

    con.execute(
        f"UPDATE {q(table)} SET {q(column)} = CAST(? AS {types[column]}) WHERE {q(column)} IS NULL",
        [value],
    )
    return OperationResult(
        description=f"Filled {_count(missing, 'missing value')} in \"{column}\" with {label}.",
        rows_before=before,
        rows_after=before,
        cells_changed=missing,
    )


def op_drop_missing_rows(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    before = _rows(con, table)
    con.execute(f"DELETE FROM {q(table)} WHERE {q(column)} IS NULL")
    after = _rows(con, table)
    result = OperationResult(
        description=f"Deleted {_count(before - after, 'row')} that had no value in \"{column}\".",
        rows_before=before,
        rows_after=after,
    )
    if before and (before - after) / before > 0.2:
        result.warnings.append(
            f"This removed {round((before - after) / before * 100)}% of the table. "
            f"Filling the gaps usually keeps more information than deleting the rows."
        )
    return result


def op_drop_column(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    before = _rows(con, table)
    if len(_columns(con, table)) <= 1:
        raise OperationError("A table needs at least one column.")
    con.execute(f"ALTER TABLE {q(table)} DROP COLUMN {q(column)}")
    return OperationResult(
        description=f"Removed the column \"{column}\".",
        rows_before=before,
        rows_after=before,
        columns_removed=[column],
    )


def op_convert_type(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """
    Change a column's type, reporting exactly how many values could not be read.

    Values that fail to convert become missing rather than taking the row with
    them. The count is always stated so a bad conversion is obvious immediately.
    """
    column = _require_column(con, table, params.get("column"))
    target = str(params.get("target") or "").lower()
    before = _rows(con, table)
    warnings: List[str] = []

    if target in {"date", "datetime", "timestamp"}:
        order = detect_date_order(con, table, column)
        if order == "ambiguous":
            warnings.append(
                "Some dates read as day-first and others as month-first. "
                "The day-first reading was used; check a few rows before relying on it."
            )
        expression = _date_parse_expression(column, "day_first" if order in {"day_first", "ambiguous"} else "month_first")
        if target != "date":
            expression = expression.replace("AS DATE)", "AS TIMESTAMP)")
        duck_type = "DATE" if target == "date" else "TIMESTAMP"
        if order == "unknown":
            warnings.append("No unambiguous dates were found, so a month-first reading was assumed.")
    elif target in {"number", "decimal", "double"}:
        cleaned = f"regexp_replace(trim({_text(column)}), '[^0-9eE.+-]', '', 'g')"
        expression = f"TRY_CAST({cleaned} AS DOUBLE)"
        duck_type = "DOUBLE"
    elif target in {"integer", "int", "bigint"}:
        cleaned = f"regexp_replace(trim({_text(column)}), '[^0-9+-]', '', 'g')"
        expression = f"TRY_CAST({cleaned} AS BIGINT)"
        duck_type = "BIGINT"
    elif target == "boolean":
        text = f"lower(trim({_text(column)}))"
        expression = (
            f"CASE WHEN {text} IN ('true','yes','y','t','1') THEN true "
            f"WHEN {text} IN ('false','no','n','f','0') THEN false ELSE NULL END"
        )
        duck_type = "BOOLEAN"
    elif target in {"text", "varchar", "string"}:
        expression = _text(column)
        duck_type = "VARCHAR"
    else:
        raise OperationError(f"Cannot convert to '{target}'.")

    lost = int(
        con.execute(
            f"SELECT count(*) FROM {q(table)} WHERE {q(column)} IS NOT NULL AND ({expression}) IS NULL"
        ).fetchone()[0]
    )
    con.execute(f"ALTER TABLE {q(table)} ALTER COLUMN {q(column)} SET DATA TYPE {duck_type} USING {expression}")

    detail = f"Converted \"{column}\" to {target}."
    if lost:
        detail += f" {_count(lost, 'value')} could not be read and are now blank."
    return OperationResult(
        description=detail,
        rows_before=before,
        rows_after=before,
        cells_changed=lost,
        warnings=warnings,
    )


def op_rename_column(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    new_name = str(params.get("new_name") or "").strip()
    if not new_name:
        raise OperationError("Provide a new column name.")
    existing = _columns(con, table)
    if new_name.casefold() in {c.casefold() for c in existing if c != column}:
        raise OperationError(f"There is already a column called \"{new_name}\".")
    before = _rows(con, table)
    con.execute(f"ALTER TABLE {q(table)} RENAME COLUMN {q(column)} TO {q(new_name)}")
    return OperationResult(
        description=f"Renamed \"{column}\" to \"{new_name}\".",
        rows_before=before,
        rows_after=before,
    )


DATE_PARTS = {
    "year": ("year({col})", "INTEGER"),
    "quarter": ("quarter({col})", "INTEGER"),
    "month": ("month({col})", "INTEGER"),
    "month_name": ("monthname({col})", "VARCHAR"),
    "day": ("day({col})", "INTEGER"),
    "day_of_week": ("dayname({col})", "VARCHAR"),
    "week": ("week({col})", "INTEGER"),
    "year_month": ("strftime({col}, '%Y-%m')", "VARCHAR"),
    "year_quarter": ("(CAST(year({col}) AS VARCHAR) || '-Q' || CAST(quarter({col}) AS VARCHAR))", "VARCHAR"),
}


def op_extract_date_part(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """Add a calendar attribute derived from a date column."""
    column = _require_column(con, table, params.get("column"))
    part = str(params.get("part") or "year").lower()
    if part not in DATE_PARTS:
        raise OperationError(f"Cannot extract '{part}'. Choose one of: {', '.join(DATE_PARTS)}.")

    existing = _columns(con, table)
    target = _unique_column_name(existing, params.get("new_column") or f"{column}_{part}")
    before = _rows(con, table)

    source = q(column)
    if not semantics.is_temporal_type(existing[column]):
        order = detect_date_order(con, table, column)
        source = _date_parse_expression(column, "day_first" if order == "day_first" else "month_first")

    template, duck_type = DATE_PARTS[part]
    expression = template.format(col=source)

    con.execute(f"ALTER TABLE {q(table)} ADD COLUMN {q(target)} {duck_type}")
    con.execute(f"UPDATE {q(table)} SET {q(target)} = {expression}")
    filled = int(con.execute(f"SELECT count({q(target)}) FROM {q(table)}").fetchone()[0])

    readable = part.replace("_", " ")
    return OperationResult(
        description=f"Added \"{target}\" holding the {readable} from \"{column}\" ({_count(filled, 'row')} filled).",
        rows_before=before,
        rows_after=before,
        columns_added=[target],
        cells_changed=filled,
    )


ARITHMETIC = {"+": "+", "-": "-", "*": "*", "/": "/"}


def op_calculate(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """Create a column from two existing ones."""
    left = _require_column(con, table, params.get("left"))
    right = _require_column(con, table, params.get("right"))
    operator = str(params.get("operator") or "+")
    existing = _columns(con, table)
    before = _rows(con, table)

    if operator == "concat":
        target = _unique_column_name(existing, params.get("new_column") or f"{left}_{right}")
        separator = str(params.get("separator", " "))
        expression = f"concat_ws({lit(separator)}, {_text(left)}, {_text(right)})"
        duck_type = "VARCHAR"
        label = f"\"{left}\" and \"{right}\" joined together"
    elif operator == "percent_of":
        target = _unique_column_name(existing, params.get("new_column") or f"{left}_pct_of_{right}")
        expression = f"CASE WHEN CAST({q(right)} AS DOUBLE) = 0 THEN NULL ELSE CAST({q(left)} AS DOUBLE) / CAST({q(right)} AS DOUBLE) END"
        duck_type = "DOUBLE"
        label = f"\"{left}\" as a share of \"{right}\""
    elif operator in ARITHMETIC:
        target = _unique_column_name(existing, params.get("new_column") or f"{left}_{operator}_{right}")
        lhs, rhs = f"CAST({q(left)} AS DOUBLE)", f"CAST({q(right)} AS DOUBLE)"
        if operator == "/":
            # Division by zero yields nothing rather than infinity, which would
            # poison every downstream average.
            expression = f"CASE WHEN {rhs} = 0 THEN NULL ELSE {lhs} / {rhs} END"
        else:
            expression = f"{lhs} {ARITHMETIC[operator]} {rhs}"
        duck_type = "DOUBLE"
        label = f"\"{left}\" {operator} \"{right}\""
    else:
        raise OperationError(f"Unknown operation '{operator}'.")

    con.execute(f"ALTER TABLE {q(table)} ADD COLUMN {q(target)} {duck_type}")
    con.execute(f"UPDATE {q(table)} SET {q(target)} = {expression}")
    filled = int(con.execute(f"SELECT count({q(target)}) FROM {q(table)}").fetchone()[0])

    result = OperationResult(
        description=f"Added \"{target}\" calculated as {label}.",
        rows_before=before,
        rows_after=before,
        columns_added=[target],
        cells_changed=filled,
    )
    if filled < before:
        result.warnings.append(
            f"{_count(before - filled, 'row')} in \"{target}\" are blank because the inputs were missing or the divisor was zero."
        )
    return result


def op_split_column(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    separator = str(params.get("separator") or ",")
    names = [str(n).strip() for n in (params.get("into") or []) if str(n).strip()]
    if not names:
        raise OperationError("Name at least one output column.")

    existing = _columns(con, table)
    before = _rows(con, table)
    created: List[str] = []
    for index, requested in enumerate(names):
        target = _unique_column_name(existing, requested)
        existing[target] = "VARCHAR"
        created.append(target)
        con.execute(f"ALTER TABLE {q(table)} ADD COLUMN {q(target)} VARCHAR")
        # str_split is literal, never a regex, so separators like "." or "|"
        # behave the way the user expects.
        con.execute(
            f"UPDATE {q(table)} SET {q(target)} = "
            f"nullif(trim(coalesce(str_split({_text(column)}, {lit(separator)})[{index + 1}], '')), '')"
        )

    return OperationResult(
        description=f"Split \"{column}\" on \"{separator}\" into {', '.join(created)}.",
        rows_before=before,
        rows_after=before,
        columns_added=created,
    )


def op_merge_columns(con, table: str, params: Dict[str, Any]) -> OperationResult:
    sources = [c for c in (params.get("columns") or []) if c in _columns(con, table)]
    if len(sources) < 2:
        raise OperationError("Pick at least two columns to combine.")
    existing = _columns(con, table)
    separator = str(params.get("separator", " "))
    target = _unique_column_name(existing, params.get("new_column") or "_".join(sources[:3]))
    before = _rows(con, table)

    # concat_ws skips nulls instead of turning them into the text "null".
    parts = ", ".join(_text(c) for c in sources)
    con.execute(f"ALTER TABLE {q(table)} ADD COLUMN {q(target)} VARCHAR")
    con.execute(f"UPDATE {q(table)} SET {q(target)} = nullif(concat_ws({lit(separator)}, {parts}), '')")

    return OperationResult(
        description=f"Combined {', '.join(sources)} into \"{target}\".",
        rows_before=before,
        rows_after=before,
        columns_added=[target],
    )


COMPARATORS = {"=": "=", "!=": "<>", ">": ">", "<": "<", ">=": ">=", "<=": "<="}


def op_filter_rows(con, table: str, params: Dict[str, Any]) -> OperationResult:
    column = _require_column(con, table, params.get("column"))
    operator = str(params.get("operator") or "=")
    value = params.get("value")
    before = _rows(con, table)

    if operator == "is_null":
        predicate, description = f"{q(column)} IS NOT NULL", f"kept only rows where \"{column}\" is blank"
    elif operator == "not_null":
        predicate, description = f"{q(column)} IS NULL", f"kept only rows where \"{column}\" has a value"
    elif operator == "contains":
        predicate = f"{_text(column)} NOT ILIKE {lit('%' + str(value) + '%')} OR {q(column)} IS NULL"
        description = f"kept only rows where \"{column}\" contains \"{value}\""
    elif operator in COMPARATORS:
        types = _columns(con, table)
        cast = f"CAST(? AS {types[column]})"
        predicate = f"NOT ({q(column)} {COMPARATORS[operator]} {cast}) OR {q(column)} IS NULL"
        description = f"kept only rows where \"{column}\" {operator} {value}"
        con.execute(f"DELETE FROM {q(table)} WHERE {predicate}", [value])
        after = _rows(con, table)
        return OperationResult(
            description=f"Filtered the table: {description}. {_count(before - after, 'row')} removed.",
            rows_before=before,
            rows_after=after,
        )
    else:
        raise OperationError(f"Unknown filter '{operator}'.")

    con.execute(f"DELETE FROM {q(table)} WHERE {predicate}")
    after = _rows(con, table)
    return OperationResult(
        description=f"Filtered the table: {description}. {_count(before - after, 'row')} removed.",
        rows_before=before,
        rows_after=after,
    )


AGGREGATIONS = {
    "sum": "sum({col})",
    "avg": "avg({col})",
    "mean": "avg({col})",
    "count": "count({col})",
    "count_distinct": "count(DISTINCT {col})",
    "min": "min({col})",
    "max": "max({col})",
    "median": "median({col})",
}


def op_aggregate(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """
    Replace the table with a grouped summary.

    Output column names are exactly what the caller asked for, so the preview
    the user approved and the table they end up with carry the same headings.
    """
    known = _columns(con, table)
    group_by = [c for c in (params.get("group_by") or []) if c in known]
    measures = params.get("measures") or []
    if not group_by:
        raise OperationError("Choose at least one column to group by.")
    if not measures:
        raise OperationError("Choose at least one value to summarise.")

    before = _rows(con, table)
    selects = [q(c) for c in group_by]
    labels: List[str] = []
    taken = {c.casefold() for c in group_by}

    for measure in measures:
        column = measure.get("column")
        function = str(measure.get("aggregation") or "sum").lower()
        if column not in known:
            raise OperationError(f"Column '{column}' is not in this table.")
        if function not in AGGREGATIONS:
            raise OperationError(f"Unknown aggregation '{function}'.")
        alias = str(measure.get("label") or f"{function}_of_{column}").strip()
        if alias.casefold() in taken:
            alias = f"{alias}_2"
        taken.add(alias.casefold())
        labels.append(alias)
        selects.append(f"{AGGREGATIONS[function].format(col=q(column))} AS {q(alias)}")

    con.execute(
        f"CREATE OR REPLACE TABLE {q(table)} AS SELECT {', '.join(selects)} "
        f"FROM {q(table)} GROUP BY {', '.join(q(c) for c in group_by)}"
    )
    after = _rows(con, table)

    removed = [c for c in known if c not in group_by]
    return OperationResult(
        description=(
            f"Grouped by {', '.join(group_by)} and summarised {', '.join(labels)}. "
            f"{_fmt(before)} rows became {_fmt(after)}."
        ),
        rows_before=before,
        rows_after=after,
        columns_added=labels,
        columns_removed=removed,
        warnings=["Grouping replaces the detailed rows with the summary. Undo restores them."],
    )


def op_remove_outliers(con, table: str, params: Dict[str, Any]) -> OperationResult:
    """Delete rows outside the IQR fence. Always a reviewed choice, never automatic."""
    column = _require_column(con, table, params.get("column"))
    types = _columns(con, table)
    if not semantics.is_numeric_type(types[column]):
        raise OperationError(f"\"{column}\" is not numeric, so it has no outlier range.")

    before = _rows(con, table)
    bounds = con.execute(
        f"SELECT quantile_cont({q(column)}, 0.25), quantile_cont({q(column)}, 0.75) FROM {q(table)}"
    ).fetchone()
    q1, q3 = bounds[0], bounds[1]
    if q1 is None or q3 is None:
        raise OperationError(f"Not enough values in \"{column}\" to work out an outlier range.")

    iqr = q3 - q1
    low, high = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    con.execute(
        f"DELETE FROM {q(table)} WHERE {q(column)} IS NOT NULL AND ({q(column)} < ? OR {q(column)} > ?)",
        [low, high],
    )
    after = _rows(con, table)
    return OperationResult(
        description=(
            f"Removed {_count(before - after, 'row')} where \"{column}\" fell outside "
            f"{_fmt(round(low, 2))} to {_fmt(round(high, 2))}."
        ),
        rows_before=before,
        rows_after=after,
        warnings=["Extreme values are often genuine. Check a few before keeping this change."],
    )


# ─── Registry ────────────────────────────────────────────────────────────────

Handler = Callable[[Any, str, Dict[str, Any]], OperationResult]

OPERATIONS: Dict[str, Dict[str, Any]] = {
    "trim_whitespace": {"handler": op_trim_whitespace, "destructive": False},
    "normalize_case": {"handler": op_normalize_case, "destructive": False},
    "blanks_to_null": {"handler": op_blanks_to_null, "destructive": False},
    "fill_missing": {"handler": op_fill_missing, "destructive": False},
    "convert_type": {"handler": op_convert_type, "destructive": False},
    "rename_column": {"handler": op_rename_column, "destructive": False},
    "extract_date_part": {"handler": op_extract_date_part, "destructive": False},
    "calculate": {"handler": op_calculate, "destructive": False},
    "split_column": {"handler": op_split_column, "destructive": False},
    "merge_columns": {"handler": op_merge_columns, "destructive": False},
    "drop_duplicate_rows": {"handler": op_drop_duplicate_rows, "destructive": True},
    "drop_missing_rows": {"handler": op_drop_missing_rows, "destructive": True},
    "drop_column": {"handler": op_drop_column, "destructive": True},
    "filter_rows": {"handler": op_filter_rows, "destructive": True},
    "aggregate": {"handler": op_aggregate, "destructive": True},
    "remove_outliers": {"handler": op_remove_outliers, "destructive": True},
}


def apply_operation(project_id: int, table: str, operation: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run one operation against a table.

    Every operation snapshots first. Non-destructive ones do too, because
    "non-destructive" means it does not drop rows, not that the user will
    always be happy with the result.
    """
    spec = OPERATIONS.get(operation)
    if not spec:
        raise OperationError(f"Unknown operation '{operation}'.")

    with connect(project_id) as con:
        if not table_exists(con, table):
            raise OperationError("This table no longer exists.")

        take_snapshot(con, table)
        try:
            result: OperationResult = spec["handler"](con, table, params or {})
        except OperationError:
            raise
        except duckdb.Error as exc:
            raise OperationError(f"That change could not be applied: {exc}") from exc

        payload = result.as_dict()
        payload["operation"] = operation
        payload["destructive"] = bool(spec["destructive"])
        payload["undo_steps_remaining"] = undo_depth(con, table)
    return payload
