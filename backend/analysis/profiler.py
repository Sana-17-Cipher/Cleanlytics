"""
CLEANYTICS - dataset profiling.

All statistics are computed by DuckDB in SQL. No table is ever pulled into
Python, so profiling a 10-row lookup and a 20-million-row fact table follow the
same code path and cost roughly the same amount of memory.

Work is done in four passes:

  1. table shape and exact duplicate rows
  2. per-column aggregates, batched so wide tables stay in a few queries
  3. a pattern probe over text columns (is this really a date? currency? junk?)
  4. top values for anything low-cardinality enough to be worth listing

The quality score is defined once, here, and every screen reads it from the
profile. The previous build computed three different scores in three places and
showed them side by side.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import duckdb

from store import LARGE_TABLE_ROWS, connect, describe, fetch_dicts, q, row_count, table_exists
from analysis import semantics
from analysis.semantics import (
    NUMERIC_LOGICAL,
    TEMPORAL_LOGICAL,
    additivity_for,
    default_aggregation,
    infer_role,
    is_integer_type,
    is_numeric_type,
    is_temporal_type,
    logical_type_for,
)

# Columns per batched query. Keeps generated SQL to a sane size on wide tables.
COLUMN_BATCH = 25

# Rows sampled for the text pattern probe on very large tables. Ratios converge
# long before this, and it keeps the regex pass off the critical path.
PATTERN_SAMPLE_ROWS = 250_000

# Above this cardinality, inconsistent capitalisation stops being a practical
# concern and exact distinct counts stop being cheap, so the check is skipped
# and reported as unmeasured rather than estimated.
CASE_VARIANT_CARDINALITY_LIMIT = 100_000

# Never list top values for a column with more distinct values than this.
TOP_VALUE_CARDINALITY_LIMIT = 500
TOP_VALUE_COUNT = 12

# Exact duplicate detection compares whole rows; above this it is skipped and
# reported as not measured rather than guessed at.
DUPLICATE_CHECK_ROW_LIMIT = 20_000_000

CURRENCY_RE = r'^[\$€£¥₹₩¢]\s?-?[0-9][0-9,\s]*(\.[0-9]+)?$|^-?[0-9][0-9,\s]*(\.[0-9]+)?\s?[\$€£¥₹₩¢]$'
PERCENT_RE = r'^-?[0-9]+(\.[0-9]+)?\s?%$'
EMAIL_RE = r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$'
PHONE_RE = r'^\+?[0-9][0-9\s\-\(\)\.]{6,19}$'
DECIMAL_RE = r'\.[0-9]'


def _sql_literal(pattern: str) -> str:
    return "'" + pattern.replace("'", "''") + "'"


# ─── Pass 2: per-column aggregates ───────────────────────────────────────────


def _column_expressions(alias: str, col: str, duck_type: str) -> List[str]:
    """Aggregate expressions for one column, aliased `<alias>_<metric>`."""
    c = q(col)
    exprs = [
        f"count({c}) AS {alias}_nn",
        f"count(*) FILTER (WHERE {c} IS NULL) AS {alias}_null",
    ]

    if is_numeric_type(duck_type):
        exprs += [
            f"min({c}) AS {alias}_min",
            f"max({c}) AS {alias}_max",
            f"avg({c}) AS {alias}_avg",
            f"sum({c}) AS {alias}_sum",
            f"stddev_samp({c}) AS {alias}_sd",
            f"quantile_cont({c}, [0.05, 0.25, 0.5, 0.75, 0.95]) AS {alias}_qs",
            f"count(*) FILTER (WHERE {c} < 0) AS {alias}_neg",
            f"count(*) FILTER (WHERE {c} = 0) AS {alias}_zero",
        ]
        if not is_integer_type(duck_type):
            # Integers can never carry a fractional part, and calling trunc() on
            # them is wasted work.
            exprs.append(
                f"count(*) FILTER (WHERE {c} IS NOT NULL AND {c} <> trunc({c})) AS {alias}_frac"
            )
    elif is_temporal_type(duck_type):
        exprs += [
            f"CAST(min({c}) AS VARCHAR) AS {alias}_min",
            f"CAST(max({c}) AS VARCHAR) AS {alias}_max",
        ]
    else:
        text = f"CAST({c} AS VARCHAR)"
        exprs += [
            f"min(length({text})) AS {alias}_minlen",
            f"max(length({text})) AS {alias}_maxlen",
            f"avg(length({text})) AS {alias}_avglen",
            f"count(*) FILTER (WHERE {text} <> trim({text})) AS {alias}_ws",
            f"count(*) FILTER (WHERE trim({text}) = '') AS {alias}_blank",
        ]
    return exprs


def _measure_case_variants(
    con: duckdb.DuckDBPyConnection,
    table: str,
    candidates: List[tuple[int, str]],
) -> Dict[int, int]:
    """
    Count how many spellings collapse when case and padding are ignored.

    Measured exactly, never estimated. The first attempt at this subtracted an
    approximate distinct count from an exact folded one and reported the
    difference, which on a 2.2 million row table invented case variants in
    columns whose values were all identically cased. Subtracting two estimates
    was no better: the residual error still ran to dozens of phantom variants.

    Exact distinct counts on a handful of low-cardinality columns are cheap even
    over millions of rows, because DuckDB hashes into a small number of groups.
    Columns with too many distinct values to be worth grouping by are skipped
    and reported as unmeasured rather than guessed at.
    """
    if not candidates:
        return {}

    results: Dict[int, int] = {}
    for start in range(0, len(candidates), COLUMN_BATCH):
        batch = candidates[start : start + COLUMN_BATCH]
        exprs: List[str] = []
        for index, name in batch:
            text = f"CAST({q(name)} AS VARCHAR)"
            exprs.append(f"count(DISTINCT {text}) AS c{index}_exact")
            exprs.append(f"count(DISTINCT lower(trim({text}))) AS c{index}_fold")
        rows = fetch_dicts(con, f"SELECT {', '.join(exprs)} FROM {q(table)}")
        if not rows:
            continue
        for index, _ in batch:
            exact_ndv = int(rows[0].get(f"c{index}_exact") or 0)
            folded_ndv = int(rows[0].get(f"c{index}_fold") or 0)
            results[index] = max(exact_ndv - folded_ndv, 0)
    return results


def _distinct_expression(alias: str, col: str, approximate: bool) -> str:
    if approximate:
        return f"approx_count_distinct({q(col)}) AS {alias}_ndv"
    return f"count(DISTINCT {q(col)}) AS {alias}_ndv"


def _run_column_batches(
    con: duckdb.DuckDBPyConnection,
    table: str,
    columns: Sequence[Dict[str, str]],
    approximate_distinct: bool,
) -> Dict[str, Any]:
    """Execute the aggregate passes in batches and merge the results."""
    merged: Dict[str, Any] = {}
    for start in range(0, len(columns), COLUMN_BATCH):
        batch = columns[start : start + COLUMN_BATCH]
        exprs: List[str] = []
        for offset, column in enumerate(batch):
            alias = f"c{start + offset}"
            exprs.extend(_column_expressions(alias, column["name"], column["type"]))
            exprs.append(_distinct_expression(alias, column["name"], approximate_distinct))
        sql = f"SELECT {', '.join(exprs)} FROM {q(table)}"
        rows = fetch_dicts(con, sql)
        if rows:
            merged.update(rows[0])
    return merged


# ─── Pass 3: text pattern probe ──────────────────────────────────────────────


def _pattern_expressions(alias: str, col: str) -> List[str]:
    text = f"trim(CAST({q(col)} AS VARCHAR))"
    present = f"{text} <> ''"
    return [
        f"count(*) FILTER (WHERE {present}) AS {alias}_p_total",
        f"count(*) FILTER (WHERE {present} AND TRY_CAST(replace(replace({text}, ',', ''), ' ', '') AS DOUBLE) IS NOT NULL) AS {alias}_p_num",
        f"count(*) FILTER (WHERE {present} AND regexp_matches({text}, {_sql_literal(DECIMAL_RE)})) AS {alias}_p_dec",
        f"count(*) FILTER (WHERE {present} AND TRY_CAST({text} AS DATE) IS NOT NULL) AS {alias}_p_date",
        f"count(*) FILTER (WHERE {present} AND TRY_CAST({text} AS TIMESTAMP) IS NOT NULL) AS {alias}_p_dt",
        f"count(*) FILTER (WHERE {present} AND regexp_matches({text}, {_sql_literal(CURRENCY_RE)})) AS {alias}_p_cur",
        f"count(*) FILTER (WHERE {present} AND regexp_matches({text}, {_sql_literal(PERCENT_RE)})) AS {alias}_p_pct",
        f"count(*) FILTER (WHERE {present} AND lower({text}) IN ('true','false','yes','no','y','n','t','f','0','1')) AS {alias}_p_bool",
        f"count(*) FILTER (WHERE {present} AND regexp_matches({text}, {_sql_literal(EMAIL_RE)})) AS {alias}_p_email",
        # A date like 2023-01-01 satisfies any loose phone pattern, so anything
        # that parses as a date is excluded before counting it as a phone number.
        f"count(*) FILTER (WHERE {present} AND regexp_matches({text}, {_sql_literal(PHONE_RE)}) "
        f"AND TRY_CAST({text} AS DATE) IS NULL AND length(regexp_replace({text}, '[^0-9]', '', 'g')) BETWEEN 7 AND 15) AS {alias}_p_phone",
    ]


def _run_pattern_probe(
    con: duckdb.DuckDBPyConnection,
    table: str,
    text_columns: List[tuple[int, str]],
    total_rows: int,
) -> Dict[str, Any]:
    if not text_columns:
        return {}

    source = q(table)
    if total_rows > LARGE_TABLE_ROWS:
        source = f"(SELECT * FROM {q(table)} USING SAMPLE reservoir({PATTERN_SAMPLE_ROWS} ROWS))"

    merged: Dict[str, Any] = {}
    for start in range(0, len(text_columns), COLUMN_BATCH):
        batch = text_columns[start : start + COLUMN_BATCH]
        exprs: List[str] = []
        for index, name in batch:
            exprs.extend(_pattern_expressions(f"c{index}", name))
        rows = fetch_dicts(con, f"SELECT {', '.join(exprs)} FROM {source}")
        if rows:
            merged.update(rows[0])
    return merged


# ─── Pass 4: top values ──────────────────────────────────────────────────────


def _top_values(
    con: duckdb.DuckDBPyConnection, table: str, col: str, non_null: int
) -> List[Dict[str, Any]]:
    rows = fetch_dicts(
        con,
        f"SELECT CAST({q(col)} AS VARCHAR) AS value, count(*) AS n "
        f"FROM {q(table)} WHERE {q(col)} IS NOT NULL "
        f"GROUP BY 1 ORDER BY n DESC, value ASC LIMIT {TOP_VALUE_COUNT}",
    )
    return [
        {
            "value": r["value"],
            "count": int(r["n"]),
            "share": round(int(r["n"]) / non_null, 4) if non_null else 0.0,
        }
        for r in rows
    ]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _num(value: Any) -> Optional[float]:
    """Coerce a DuckDB aggregate result to a JSON-safe float."""
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(result) or math.isinf(result):
        return None
    return round(result, 6)


def _ratio(numerator: Any, denominator: Any) -> float:
    try:
        d = float(denominator or 0)
        if d <= 0:
            return 0.0
        return max(0.0, min(float(numerator or 0) / d, 1.0))
    except (TypeError, ValueError):
        return 0.0


# ─── Main entry point ────────────────────────────────────────────────────────


def profile_table(project_id: int, table: str) -> Dict[str, Any]:
    """
    Build the full profile for one physical table.

    Returns column profiles, a dataset summary and the quality score with its
    components broken out so the number can be explained rather than asserted.
    """
    with connect(project_id, read_only=True) as con:
        if not table_exists(con, table):
            raise ValueError(f"Table {table} does not exist in this project.")

        schema = describe(con, table)
        total_rows = row_count(con, table)
        column_count = len(schema)

        approximate_distinct = total_rows > LARGE_TABLE_ROWS
        aggregates = _run_column_batches(con, table, schema, approximate_distinct)

        text_columns = [
            (index, column["name"])
            for index, column in enumerate(schema)
            if not is_numeric_type(column["type"]) and not is_temporal_type(column["type"])
            and semantics.base_duck_type(column["type"]) != "BOOLEAN"
        ]
        patterns = _run_pattern_probe(con, table, text_columns, total_rows)

        # Case-variant detection, only for columns whose cardinality is low
        # enough that inconsistent spelling is a real concern and an exact count
        # is cheap.
        variant_candidates = [
            (index, name)
            for index, name in text_columns
            if 1 < int(aggregates.get(f"c{index}_ndv") or 0) <= CASE_VARIANT_CARDINALITY_LIMIT
        ]
        case_variants = _measure_case_variants(con, table, variant_candidates)
        measured_variants = {index for index, _ in variant_candidates}

        duplicate_rows: Optional[int] = None
        if total_rows <= DUPLICATE_CHECK_ROW_LIMIT:
            distinct_rows = con.execute(
                f"SELECT count(*) FROM (SELECT DISTINCT * FROM {q(table)})"
            ).fetchone()[0]
            duplicate_rows = max(int(total_rows) - int(distinct_rows), 0)

        columns: List[Dict[str, Any]] = []
        for index, column in enumerate(schema):
            alias = f"c{index}"
            name = column["name"]
            duck_type = column["type"]

            non_null = int(aggregates.get(f"{alias}_nn") or 0)
            null_count = int(aggregates.get(f"{alias}_null") or 0)
            ndv = int(aggregates.get(f"{alias}_ndv") or 0)

            probe: Dict[str, Any] = {}
            probe_total = int(patterns.get(f"{alias}_p_total") or 0)
            if probe_total:
                probe = {
                    "numeric_ratio": _ratio(patterns.get(f"{alias}_p_num"), probe_total),
                    "decimal_ratio": _ratio(patterns.get(f"{alias}_p_dec"), probe_total),
                    "date_ratio": _ratio(patterns.get(f"{alias}_p_date"), probe_total),
                    "datetime_ratio": _ratio(patterns.get(f"{alias}_p_dt"), probe_total),
                    "currency_ratio": _ratio(patterns.get(f"{alias}_p_cur"), probe_total),
                    "percentage_ratio": _ratio(patterns.get(f"{alias}_p_pct"), probe_total),
                    "boolean_ratio": _ratio(patterns.get(f"{alias}_p_bool"), probe_total),
                    "email_ratio": _ratio(patterns.get(f"{alias}_p_email"), probe_total),
                    "phone_ratio": _ratio(patterns.get(f"{alias}_p_phone"), probe_total),
                }

            has_decimals = bool(aggregates.get(f"{alias}_frac") or 0) if is_numeric_type(duck_type) else False
            logical = logical_type_for(duck_type, text_probe=probe, has_decimals=has_decimals or None)

            stats: Dict[str, Any] = {
                "subtype": None,
                "row_count": total_rows,
                "non_null_count": non_null,
                "null_count": null_count,
                "distinct_count": ndv,
                "unique_ratio": round(_ratio(ndv, non_null), 4),
                "has_decimals": has_decimals,
                "has_negatives": bool(aggregates.get(f"{alias}_neg") or 0),
                "avg_length": _num(aggregates.get(f"{alias}_avglen")) or 0.0,
                "min_value": aggregates.get(f"{alias}_min"),
                "max_value": aggregates.get(f"{alias}_max"),
                "distinct_values": [],
            }

            top_values: List[Dict[str, Any]] = []
            if 0 < ndv <= TOP_VALUE_CARDINALITY_LIMIT and non_null > 0:
                top_values = _top_values(con, table, name, non_null)
                stats["distinct_values"] = [t["value"] for t in top_values[:4]]

            subtype = semantics.detect_subtype(name, probe, stats["distinct_values"])
            stats["subtype"] = subtype

            role_info = infer_role(name, logical, stats)
            role = role_info["semantic_role"]
            additivity = additivity_for(name, logical, role)

            profile: Dict[str, Any] = {
                "name": name,
                "position": index,
                "physical_type": duck_type,
                "logical_type": logical,
                "subtype": subtype,
                "semantic_role": role,
                "confidence": role_info["confidence"],
                "reasons": role_info["reasons"],
                "additivity": additivity,
                "default_aggregation": default_aggregation(role, logical, additivity),
                "row_count": total_rows,
                "non_null_count": non_null,
                "null_count": null_count,
                "null_ratio": round(_ratio(null_count, total_rows), 4),
                "distinct_count": ndv,
                "distinct_is_approximate": approximate_distinct,
                "unique_ratio": stats["unique_ratio"],
                "is_unique": bool(non_null > 0 and ndv == non_null),
                "is_constant": bool(ndv <= 1 and non_null > 0),
                "is_empty": non_null == 0,
                "top_values": top_values,
                "source": "auto",
            }

            if is_numeric_type(duck_type):
                quantiles = aggregates.get(f"{alias}_qs") or []
                quantiles = [_num(v) for v in quantiles] if isinstance(quantiles, (list, tuple)) else []
                q1 = quantiles[1] if len(quantiles) > 1 else None
                q3 = quantiles[3] if len(quantiles) > 3 else None
                profile["statistics"] = {
                    "min": _num(aggregates.get(f"{alias}_min")),
                    "max": _num(aggregates.get(f"{alias}_max")),
                    "mean": _num(aggregates.get(f"{alias}_avg")),
                    "sum": _num(aggregates.get(f"{alias}_sum")),
                    "std_dev": _num(aggregates.get(f"{alias}_sd")),
                    "p05": quantiles[0] if len(quantiles) > 0 else None,
                    "q1": q1,
                    "median": quantiles[2] if len(quantiles) > 2 else None,
                    "q3": q3,
                    "p95": quantiles[4] if len(quantiles) > 4 else None,
                    "zero_count": int(aggregates.get(f"{alias}_zero") or 0),
                    "negative_count": int(aggregates.get(f"{alias}_neg") or 0),
                }
                if q1 is not None and q3 is not None:
                    iqr = q3 - q1
                    profile["statistics"]["iqr"] = round(iqr, 6)
                    profile["statistics"]["outlier_low"] = round(q1 - 1.5 * iqr, 6)
                    profile["statistics"]["outlier_high"] = round(q3 + 1.5 * iqr, 6)
            elif is_temporal_type(duck_type):
                profile["statistics"] = {
                    "min": aggregates.get(f"{alias}_min"),
                    "max": aggregates.get(f"{alias}_max"),
                }
            else:
                profile["statistics"] = {
                    "min_length": int(aggregates.get(f"{alias}_minlen") or 0),
                    "max_length": int(aggregates.get(f"{alias}_maxlen") or 0),
                    "avg_length": _num(aggregates.get(f"{alias}_avglen")),
                    "whitespace_count": int(aggregates.get(f"{alias}_ws") or 0),
                    "blank_count": int(aggregates.get(f"{alias}_blank") or 0),
                    # Measured exactly by a dedicated pass, or omitted entirely.
                    # Never derived from the approximate distinct count.
                    "case_variant_count": int(case_variants.get(index, 0)),
                    "case_variant_measured": index in measured_variants,
                }
                if probe:
                    profile["patterns"] = {k: round(v, 4) for k, v in probe.items()}

            profile["invalid_count"] = _invalid_count(role, logical, subtype, probe, non_null)
            columns.append(profile)

    summary = _summarise(columns, total_rows, column_count, duplicate_rows)
    return {"columns": columns, "summary": summary}


def _invalid_count(
    role: str,
    logical: str,
    subtype: Optional[str],
    probe: Dict[str, Any],
    non_null: int,
) -> int:
    """
    How many values do not conform to what the column is supposed to hold.

    The important case is a column that is *mostly* one thing: a date column
    where 3 rows out of 400 use a different format, an email column with two
    malformed addresses, a numeric column carrying "N/A". Judging conformity by
    the final logical type alone would miss all of these, because a column that
    is only 75% dates is classified as text, and text accepts anything.

    So the expected shape is taken from whichever is most specific: the detected
    subtype, then the logical type, then the semantic role.
    """
    if not probe or non_null <= 0:
        return 0

    key = semantics.SUBTYPE_PROBE_KEY.get(subtype or "")

    if not key:
        key = {
            "integer": "numeric_ratio",
            "decimal": "numeric_ratio",
            "currency": "currency_ratio",
            "percentage": "percentage_ratio",
            "date": "date_ratio",
            "datetime": "datetime_ratio",
            "boolean": "boolean_ratio",
        }.get(logical)

    if not key and logical == "text":
        # The column did not classify cleanly, but its role says what it was
        # meant to be. A time column that only half parses is a real problem
        # and this is the only place it gets counted.
        if role == "time":
            key = "datetime_ratio" if probe.get("datetime_ratio", 0) >= probe.get("date_ratio", 0) else "date_ratio"
        elif role == "measure":
            key = "numeric_ratio"

    if not key:
        return 0

    conforming = probe.get(key, 0.0)
    # A column with almost no matches was never that shape to begin with;
    # calling every value invalid would be noise, not a finding.
    if conforming >= 0.999 or conforming < 0.25:
        return 0
    # Ratios may come from a sample on very large tables, so scale back up.
    return int(round((1.0 - conforming) * non_null))


def _summarise(
    columns: List[Dict[str, Any]],
    total_rows: int,
    column_count: int,
    duplicate_rows: Optional[int],
) -> Dict[str, Any]:
    """
    Dataset-level summary and the one quality score used across the app.

    The score is a weighted blend of four measurable properties. Each component
    is returned alongside it so a low score always comes with the reason.
    """
    total_cells = max(total_rows * column_count, 1)
    total_missing = sum(c["null_count"] for c in columns)

    text_columns = [c for c in columns if c["logical_type"] == "text" or "patterns" in c]
    inconsistent = sum(
        int(c.get("statistics", {}).get("whitespace_count") or 0)
        + int(c.get("statistics", {}).get("case_variant_count") or 0)
        for c in columns
    )
    invalid = sum(int(c.get("invalid_count") or 0) for c in columns)
    total_values = max(sum(c["non_null_count"] for c in columns), 1)

    completeness = 1.0 - (total_missing / total_cells)
    uniqueness = 1.0 if duplicate_rows is None else 1.0 - (duplicate_rows / max(total_rows, 1))
    consistency = 1.0 - min(inconsistent / total_values, 1.0)
    validity = 1.0 - min(invalid / total_values, 1.0)

    score = (
        0.35 * completeness
        + 0.25 * uniqueness
        + 0.20 * consistency
        + 0.20 * validity
    )

    by_role: Dict[str, int] = {}
    for column in columns:
        by_role[column["semantic_role"]] = by_role.get(column["semantic_role"], 0) + 1

    return {
        "rows": total_rows,
        "columns": column_count,
        "total_cells": total_cells,
        "total_missing": total_missing,
        "duplicate_rows": duplicate_rows,
        "duplicate_rows_measured": duplicate_rows is not None,
        "quality_score": round(max(0.0, min(score, 1.0)) * 100, 1),
        "quality_components": {
            "completeness": round(completeness * 100, 1),
            "uniqueness": round(uniqueness * 100, 1),
            "consistency": round(consistency * 100, 1),
            "validity": round(validity * 100, 1),
        },
        "quality_weights": {
            "completeness": 0.35,
            "uniqueness": 0.25,
            "consistency": 0.20,
            "validity": 0.20,
        },
        "role_counts": by_role,
        "measure_count": by_role.get("measure", 0),
        "dimension_count": by_role.get("dimension", 0) + by_role.get("category", 0) + by_role.get("geographic", 0),
        "time_count": by_role.get("time", 0),
        "identifier_count": by_role.get("identifier", 0),
        # Uniqueness alone does not make a primary key. In a 10-row table the
        # revenue and date columns are usually unique too, and offering them as
        # keys sends the user straight into a wrong data model. Only columns
        # that identify or describe a record are eligible.
        "primary_key_candidates": [
            c["name"]
            for c in columns
            if c["is_unique"]
            and c["null_count"] == 0
            and c["distinct_count"] > 1
            and c["semantic_role"] in {"identifier", "dimension", "category", "geographic"}
        ],
    }
