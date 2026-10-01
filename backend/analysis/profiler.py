"""
CLEANYTICS — dataset profiling.

Statistics are computed in DuckDB. Large tables use sampled pattern checks
and approximate distinct counts, with those limitations recorded explicitly.
Profiling does not modify uploaded data.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import duckdb

from store import (
    LARGE_TABLE_ROWS,
    connect,
    describe,
    fetch_dicts,
    q,
    row_count,
    table_exists,
)
from analysis import semantics
from analysis.semantics import (
    additivity_for,
    default_aggregation,
    infer_role,
    is_integer_type,
    is_numeric_type,
    is_temporal_type,
    logical_type_for,
)


COLUMN_BATCH = 25
PATTERN_SAMPLE_ROWS = 250_000
CASE_VARIANT_CARDINALITY_LIMIT = 100_000
TOP_VALUE_CARDINALITY_LIMIT = 500
TOP_VALUE_COUNT = 12
DUPLICATE_CHECK_ROW_LIMIT = 20_000_000

TEXT_TYPES = {"VARCHAR", "TEXT", "CHAR", "BPCHAR", "STRING"}
TRIM_CHARS = " \t\r\n\f\v\u00a0"

# Ungrouped numbers, western thousands, and Indian thousands.
NUMBER_BODY = (
    r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+"
    r"|[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3})"
    r"(?:\.[0-9]+)?"
)
NUMERIC_RE = (
    rf"^[+-]?(?:{NUMBER_BODY}|\.[0-9]+)"
    r"(?:[eE][+-]?[0-9]+)?$"
)
CURRENCY_RE = (
    rf"^(?:[$€£¥₹₩][ ]*[+-]?{NUMBER_BODY}"
    rf"|[+-]?{NUMBER_BODY}[ ]*[$€£¥₹₩])$"
)
PERCENT_RE = r"^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ ]*%$"
EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"
PHONE_RE = r"^\+?[0-9(][0-9 ()\.-]{5,24}$"
DECIMAL_RE = r"\.[0-9]"
DATETIME_RE = r"[ T][0-9]{1,2}:[0-9]{2}"
URL_RE = r"(?i)^(https?://|www\.)[^[:space:]]+$"
UUID_RE = r"(?i)^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _trim(expression: str) -> str:
    return f"trim({expression}, {_sql_literal(TRIM_CHARS)})"


# ─── Column aggregates ───────────────────────────────────────────────────────


def _column_expressions(
    alias: str,
    col: str,
    duck_type: str,
    approximate: bool = False,
) -> List[str]:
    c = q(col)

    exprs = [
        f"count({c}) AS {alias}_nn",
        f"count(*) FILTER (WHERE {c} IS NULL) AS {alias}_null",
    ]

    if is_numeric_type(duck_type):
        original = c
        c = (
            f"(CASE WHEN isfinite(TRY_CAST({original} AS DOUBLE)) "
            f"THEN {original} END)"
        )
        quantile = "approx_quantile" if approximate else "quantile_cont"

        exprs.append(
            f"count(*) FILTER (WHERE {original} IS NOT NULL "
            f"AND NOT isfinite(TRY_CAST({original} AS DOUBLE))) "
            f"AS {alias}_nonfinite"
        )

        exprs += [
            f"min({c}) AS {alias}_min",
            f"max({c}) AS {alias}_max",
            f"avg({c}) AS {alias}_avg",
            f"sum({c}) AS {alias}_sum",
            f"stddev_samp({c}) AS {alias}_sd",
            f"{quantile}({c}, [0.05, 0.25, 0.5, 0.75, 0.95]) "
            f"AS {alias}_qs",
            f"count(*) FILTER (WHERE {c} < 0) AS {alias}_neg",
            f"count(*) FILTER (WHERE {c} = 0) AS {alias}_zero",
        ]

        if not is_integer_type(duck_type):
            exprs.append(
                f"count(*) FILTER "
                f"(WHERE {c} IS NOT NULL AND {c} <> trunc({c})) "
                f"AS {alias}_frac"
            )

    elif is_temporal_type(duck_type):
        exprs += [
            f"CAST(min({c}) AS VARCHAR) AS {alias}_min",
            f"CAST(max({c}) AS VARCHAR) AS {alias}_max",
        ]

    else:
        text = f"CAST({c} AS VARCHAR)"
        trimmed = _trim(text)

        exprs += [
            f"min(length({text})) AS {alias}_minlen",
            f"max(length({text})) AS {alias}_maxlen",
            f"avg(length({text})) AS {alias}_avglen",
            f"count(*) FILTER (WHERE {text} <> {trimmed}) "
            f"AS {alias}_ws",
            f"count(*) FILTER (WHERE {trimmed} = '') "
            f"AS {alias}_blank",
        ]

    return exprs


def _distinct_expression(
    alias: str,
    col: str,
    approximate: bool,
) -> str:
    if approximate:
        return f"approx_count_distinct({q(col)}) AS {alias}_ndv"

    return f"count(DISTINCT {q(col)}) AS {alias}_ndv"


def _run_column_batches(
    con: duckdb.DuckDBPyConnection,
    table: str,
    columns: Sequence[Dict[str, str]],
    approximate_distinct: bool,
) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}

    for start in range(0, len(columns), COLUMN_BATCH):
        batch = columns[start:start + COLUMN_BATCH]
        exprs: List[str] = []

        for offset, column in enumerate(batch):
            alias = f"c{start + offset}"

            exprs.extend(
                _column_expressions(
                    alias,
                    column["name"],
                    column["type"],
                    approximate_distinct,
                )
            )
            exprs.append(
                _distinct_expression(
                    alias,
                    column["name"],
                    approximate_distinct,
                )
            )

        rows = fetch_dicts(
            con,
            f"SELECT {', '.join(exprs)} FROM {q(table)}",
        )
        if rows:
            merged.update(rows[0])

    return merged


def _measure_case_variants(
    con: duckdb.DuckDBPyConnection,
    table: str,
    candidates: List[tuple[int, str]],
) -> Dict[int, int]:
    """Count distinct spellings that collapse after case/space folding."""
    results: Dict[int, int] = {}

    for start in range(0, len(candidates), COLUMN_BATCH):
        batch = candidates[start:start + COLUMN_BATCH]
        exprs: List[str] = []

        for index, name in batch:
            text = f"CAST({q(name)} AS VARCHAR)"
            exprs.append(
                f"count(DISTINCT {text}) AS c{index}_exact"
            )
            exprs.append(
                f"count(DISTINCT lower({_trim(text)})) "
                f"AS c{index}_fold"
            )

        rows = fetch_dicts(
            con,
            f"SELECT {', '.join(exprs)} FROM {q(table)}",
        )
        if not rows:
            continue

        for index, _ in batch:
            exact = int(rows[0].get(f"c{index}_exact") or 0)
            folded = int(rows[0].get(f"c{index}_fold") or 0)
            results[index] = max(exact - folded, 0)

    return results


# ─── Text pattern checks ─────────────────────────────────────────────────────


def _pattern_expressions(alias: str, col: str) -> List[str]:
    text = _trim(f"CAST({q(col)} AS VARCHAR)")
    present = f"{text} <> ''"
    number = f"TRY_CAST(replace({text}, ',', '') AS DOUBLE)"

    numeric = (
        f"regexp_matches({text}, {_sql_literal(NUMERIC_RE)}) "
        f"AND isfinite({number})"
    )
    clock = (
        f"regexp_matches({text}, {_sql_literal(DATETIME_RE)})"
    )

    checks = {
        "total": present,
        "num": numeric,
        "dec": (
            f"({numeric}) AND {number} <> trunc({number})"
        ),
        "date": (
            f"NOT ({clock}) "
            f"AND TRY_CAST({text} AS DATE) IS NOT NULL"
        ),
        "dt": (
            f"({clock}) "
            f"AND TRY_CAST({text} AS TIMESTAMP) IS NOT NULL"
        ),
        "cur": (
            f"regexp_matches({text}, {_sql_literal(CURRENCY_RE)})"
        ),
        "pct": (
            f"regexp_matches({text}, {_sql_literal(PERCENT_RE)})"
        ),
        "bool": (
            f"lower({text}) IN "
            "('true','false','yes','no','y','n','t','f','0','1')"
        ),
        "email": (
            f"regexp_matches({text}, {_sql_literal(EMAIL_RE)})"
        ),
        "phone": (
            f"regexp_matches({text}, {_sql_literal(PHONE_RE)}) "
            f"AND TRY_CAST({text} AS DATE) IS NULL "
            f"AND length(regexp_replace({text}, '[^0-9]', '', 'g')) "
            "BETWEEN 7 AND 15"
        ),
        "uuid": (
            f"regexp_matches({text}, {_sql_literal(UUID_RE)})"
        ),
        "url": (
            f"regexp_matches({text}, {_sql_literal(URL_RE)})"
        ),
    }

    return [
        f"count(*) FILTER (WHERE {present} AND ({condition})) "
        f"AS {alias}_p_{key}"
        for key, condition in checks.items()
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
        source = (
            f"(SELECT * FROM {q(table)} "
            f"USING SAMPLE reservoir({PATTERN_SAMPLE_ROWS} ROWS) "
            "REPEATABLE (42))"
        )

    merged: Dict[str, Any] = {}

    for start in range(0, len(text_columns), COLUMN_BATCH):
        batch = text_columns[start:start + COLUMN_BATCH]
        exprs: List[str] = []

        for index, name in batch:
            exprs.extend(_pattern_expressions(f"c{index}", name))

        rows = fetch_dicts(
            con,
            f"SELECT {', '.join(exprs)} FROM {source}",
        )

        if rows:
            merged.update(rows[0])

    return merged


# ─── Top values ──────────────────────────────────────────────────────────────


def _top_values(
    con: duckdb.DuckDBPyConnection,
    table: str,
    col: str,
    non_null: int,
) -> List[Dict[str, Any]]:
    rows = fetch_dicts(
        con,
        f"SELECT CAST({q(col)} AS VARCHAR) AS value, count(*) AS n "
        f"FROM {q(table)} WHERE {q(col)} IS NOT NULL "
        f"GROUP BY 1 ORDER BY n DESC, value ASC LIMIT {TOP_VALUE_COUNT}",
    )

    return [
        {
            "value": row["value"],
            "count": int(row["n"]),
            "share": (
                round(int(row["n"]) / non_null, 4)
                if non_null else 0.0
            ),
        }
        for row in rows
    ]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None

    try:
        result = float(value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(result):
        return None

    return round(result, 6)


def _ratio(numerator: Any, denominator: Any) -> float:
    try:
        denominator = float(denominator or 0)
        if denominator <= 0:
            return 0.0

        return max(
            0.0,
            min(float(numerator or 0) / denominator, 1.0),
        )
    except (TypeError, ValueError):
        return 0.0


# ─── Main profiling entry point ──────────────────────────────────────────────


def profile_table(project_id: int, table: str) -> Dict[str, Any]:
    with connect(project_id, read_only=True) as con:
        if not table_exists(con, table):
            raise ValueError(
                f"Table {table} does not exist in this project."
            )

        schema = describe(con, table)
        total_rows = row_count(con, table)
        column_count = len(schema)

        approximate_distinct = total_rows > LARGE_TABLE_ROWS
        aggregates = _run_column_batches(
            con,
            table,
            schema,
            approximate_distinct,
        )

        text_columns = [
            (index, column["name"])
            for index, column in enumerate(schema)
            if semantics.base_duck_type(column["type"]) in TEXT_TYPES
        ]

        patterns = _run_pattern_probe(
            con,
            table,
            text_columns,
            total_rows,
        )

        variant_candidates = [
            (index, name)
            for index, name in text_columns
            if (
                1 < int(aggregates.get(f"c{index}_ndv") or 0)
                <= CASE_VARIANT_CARDINALITY_LIMIT
            )
        ]

        case_variants = _measure_case_variants(
            con,
            table,
            variant_candidates,
        )
        measured_variants = {
            index for index, _ in variant_candidates
        }

        duplicate_rows: Optional[int] = None

        if total_rows <= DUPLICATE_CHECK_ROW_LIMIT:
            distinct_rows = con.execute(
                f"SELECT count(*) FROM "
                f"(SELECT DISTINCT * FROM {q(table)})"
            ).fetchone()[0]

            duplicate_rows = max(
                int(total_rows) - int(distinct_rows),
                0,
            )

        columns: List[Dict[str, Any]] = []

        for index, column in enumerate(schema):
            alias = f"c{index}"
            name = column["name"]
            duck_type = column["type"]

            non_null = int(aggregates.get(f"{alias}_nn") or 0)
            null_count = int(aggregates.get(f"{alias}_null") or 0)
            ndv = min(
                non_null,
                max(
                    0,
                    int(aggregates.get(f"{alias}_ndv") or 0),
                ),
            )

            probe: Dict[str, Any] = {}
            probe_total = int(
                patterns.get(f"{alias}_p_total") or 0
            )

            if probe_total:
                probe = {
                    "numeric_ratio": _ratio(
                        patterns.get(f"{alias}_p_num"), probe_total
                    ),
                    "decimal_ratio": _ratio(
                        patterns.get(f"{alias}_p_dec"), probe_total
                    ),
                    "date_ratio": _ratio(
                        patterns.get(f"{alias}_p_date"), probe_total
                    ),
                    "datetime_ratio": _ratio(
                        patterns.get(f"{alias}_p_dt"), probe_total
                    ),
                    "currency_ratio": _ratio(
                        patterns.get(f"{alias}_p_cur"), probe_total
                    ),
                    "percentage_ratio": _ratio(
                        patterns.get(f"{alias}_p_pct"), probe_total
                    ),
                    "boolean_ratio": _ratio(
                        patterns.get(f"{alias}_p_bool"), probe_total
                    ),
                    "email_ratio": _ratio(
                        patterns.get(f"{alias}_p_email"), probe_total
                    ),
                    "phone_ratio": _ratio(
                        patterns.get(f"{alias}_p_phone"), probe_total
                    ),
                    "uuid_ratio": _ratio(
                        patterns.get(f"{alias}_p_uuid"), probe_total
                    ),
                    "url_ratio": _ratio(
                        patterns.get(f"{alias}_p_url"), probe_total
                    ),
                }

            physical_numeric = is_numeric_type(duck_type)

            has_decimals = (
                bool(aggregates.get(f"{alias}_frac") or 0)
                if physical_numeric else False
            )

            logical = logical_type_for(
                duck_type,
                text_probe=probe,
                has_decimals=(
                    has_decimals if physical_numeric else None
                ),
            )

            stats: Dict[str, Any] = {
                "subtype": None,
                "row_count": total_rows,
                "non_null_count": non_null,
                "null_count": null_count,
                "distinct_count": ndv,
                "unique_ratio": round(_ratio(ndv, non_null), 4),
                "has_decimals": has_decimals,
                "has_negatives": bool(
                    aggregates.get(f"{alias}_neg") or 0
                ),
                "avg_length": (
                    _num(aggregates.get(f"{alias}_avglen")) or 0.0
                ),
                "min_value": aggregates.get(f"{alias}_min"),
                "max_value": aggregates.get(f"{alias}_max"),
                "distinct_values": [],
            }

            top_values: List[Dict[str, Any]] = []

            if (
                0 < ndv <= TOP_VALUE_CARDINALITY_LIMIT
                and non_null > 0
            ):
                top_values = _top_values(
                    con,
                    table,
                    name,
                    non_null,
                )
                stats["distinct_values"] = [
                    value["value"] for value in top_values[:4]
                ]

            subtype = semantics.detect_subtype(
                name,
                probe,
                stats["distinct_values"],
            )

            # Content probes also work when cardinality is too high
            # to retrieve top values.
            if probe.get("uuid_ratio", 0) >= 0.98:
                subtype = "uuid"
            elif probe.get("url_ratio", 0) >= 0.98:
                subtype = "url"

            stats["subtype"] = subtype

            role_info = infer_role(name, logical, stats)
            role = role_info["semantic_role"]

            # Text identifiers/postcodes retain their text interpretation.
            # This preserves leading-zero semantics for downstream consumers.
            if (
                semantics.base_duck_type(duck_type) in TEXT_TYPES
                and (
                    role == "identifier"
                    or subtype == "postal_code"
                )
            ):
                logical = "text"

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
                "role_scores": role_info.get("role_scores", {}),
                "needs_review": role_info["confidence"] < 0.65,
                "additivity": additivity,
                "default_aggregation": default_aggregation(
                    role,
                    logical,
                    additivity,
                ),
                "row_count": total_rows,
                "non_null_count": non_null,
                "null_count": null_count,
                "null_ratio": round(
                    _ratio(null_count, total_rows),
                    4,
                ),
                "distinct_count": ndv,
                "distinct_is_approximate": approximate_distinct,
                "unique_ratio": stats["unique_ratio"],
                "is_unique": bool(
                    not approximate_distinct
                    and non_null > 0
                    and ndv == non_null
                ),
                "uniqueness_verified": not approximate_distinct,
                "is_constant": bool(
                    not approximate_distinct
                    and ndv == 1
                    and non_null > 0
                ),
                "is_empty": non_null == 0,
                "pattern_sampled": bool(
                    probe and total_rows > LARGE_TABLE_ROWS
                ),
                "pattern_values_checked": probe_total,
                "top_values": top_values,
                "source": "auto",
            }

            if physical_numeric:
                quantiles = aggregates.get(f"{alias}_qs") or []
                quantiles = (
                    [_num(value) for value in quantiles]
                    if isinstance(quantiles, (list, tuple))
                    else []
                )

                q1 = quantiles[1] if len(quantiles) > 1 else None
                q3 = quantiles[3] if len(quantiles) > 3 else None

                profile["statistics"] = {
                    "min": _num(aggregates.get(f"{alias}_min")),
                    "max": _num(aggregates.get(f"{alias}_max")),
                    "mean": _num(aggregates.get(f"{alias}_avg")),
                    "sum": _num(aggregates.get(f"{alias}_sum")),
                    "std_dev": _num(aggregates.get(f"{alias}_sd")),
                    "p05": (
                        quantiles[0] if len(quantiles) > 0 else None
                    ),
                    "q1": q1,
                    "median": (
                        quantiles[2] if len(quantiles) > 2 else None
                    ),
                    "q3": q3,
                    "p95": (
                        quantiles[4] if len(quantiles) > 4 else None
                    ),
                    "zero_count": int(
                        aggregates.get(f"{alias}_zero") or 0
                    ),
                    "negative_count": int(
                        aggregates.get(f"{alias}_neg") or 0
                    ),
                    "non_finite_count": int(
                        aggregates.get(f"{alias}_nonfinite") or 0
                    ),
                    "quantiles_approximate": approximate_distinct,
                }

                if q1 is not None and q3 is not None:
                    iqr = q3 - q1
                    profile["statistics"].update({
                        "iqr": round(iqr, 6),
                        "outlier_low": round(q1 - 1.5 * iqr, 6),
                        "outlier_high": round(q3 + 1.5 * iqr, 6),
                    })

            elif is_temporal_type(duck_type):
                profile["statistics"] = {
                    "min": aggregates.get(f"{alias}_min"),
                    "max": aggregates.get(f"{alias}_max"),
                }

            else:
                profile["statistics"] = {
                    "min_length": int(
                        aggregates.get(f"{alias}_minlen") or 0
                    ),
                    "max_length": int(
                        aggregates.get(f"{alias}_maxlen") or 0
                    ),
                    "avg_length": _num(
                        aggregates.get(f"{alias}_avglen")
                    ),
                    "whitespace_count": int(
                        aggregates.get(f"{alias}_ws") or 0
                    ),
                    "blank_count": int(
                        aggregates.get(f"{alias}_blank") or 0
                    ),
                    "case_variant_count": int(
                        case_variants.get(index, 0)
                    ),
                    "case_variant_measured": (
                        index in measured_variants
                    ),
                }

                if probe:
                    profile["patterns"] = {
                        key: round(value, 4)
                        for key, value in probe.items()
                    }

            blank = int(
                aggregates.get(f"{alias}_blank") or 0
            )
            non_finite = int(
                aggregates.get(f"{alias}_nonfinite") or 0
            )

            profile["blank_count"] = blank
            profile["missing_count"] = null_count + blank
            profile["invalid_count"] = (
                _invalid_count(
                    role,
                    logical,
                    subtype,
                    probe,
                    max(non_null - blank, 0),
                )
                + non_finite
            )
            profile["invalid_count_is_estimate"] = (
                profile["pattern_sampled"]
            )

            validity_key = _validity_key(
                role,
                logical,
                subtype,
                probe,
            )
            profile["invalid_count_measured"] = (
                physical_numeric
                or bool(
                    validity_key
                    and probe.get(validity_key, 0) >= 0.25
                )
            )

            columns.append(profile)

    return {
        "columns": columns,
        "summary": _summarise(
            columns,
            total_rows,
            column_count,
            duplicate_rows,
        ),
    }


# ─── Pattern validity ────────────────────────────────────────────────────────


def _validity_key(
    role: str,
    logical: str,
    subtype: Optional[str],
    probe: Dict[str, Any],
) -> Optional[str]:
    key = {
        **semantics.SUBTYPE_PROBE_KEY,
        "uuid": "uuid_ratio",
        "url": "url_ratio",
    }.get(subtype or "")

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
        if role == "time":
            key = (
                "datetime_ratio"
                if probe.get("datetime_ratio", 0)
                >= probe.get("date_ratio", 0)
                else "date_ratio"
            )
        elif role == "measure":
            key = "numeric_ratio"

    return key


def _invalid_count(
    role: str,
    logical: str,
    subtype: Optional[str],
    probe: Dict[str, Any],
    non_null: int,
) -> int:
    """Count or estimate nonblank values failing the inferred pattern."""
    if not probe or non_null <= 0:
        return 0

    key = _validity_key(role, logical, subtype, probe)
    if not key:
        return 0

    conforming = probe.get(key, 0.0)

    # Very little evidence is not enough to impose an expected format.
    if conforming >= 1.0 or conforming < 0.25:
        return 0

    return int(round((1.0 - conforming) * non_null))


# ─── Dataset summary ─────────────────────────────────────────────────────────


def _summarise(
    columns: List[Dict[str, Any]],
    total_rows: int,
    column_count: int,
    duplicate_rows: Optional[int],
) -> Dict[str, Any]:
    """Build an indicative quality score with explicit coverage flags."""
    total_cells = total_rows * column_count
    total_missing = sum(column["null_count"] for column in columns)
    total_blank = sum(
        column.get("blank_count", 0)
        for column in columns
    )
    total_values = max(
        sum(column["non_null_count"] for column in columns),
        1,
    )

    # Case variants count spellings, not affected cells.
    # Keep that finding separate from this cell-based score.
    whitespace = sum(
        column.get("statistics", {}).get("whitespace_count", 0)
        for column in columns
    )
    invalid = sum(
        column.get("invalid_count", 0)
        for column in columns
    )

    measured = {
        "completeness": total_cells > 0,
        "uniqueness": (
            duplicate_rows is not None and total_rows > 0
        ),
        "consistency": any(
            column["non_null_count"]
            and "whitespace_count" in column.get("statistics", {})
            for column in columns
        ),
        "validity": any(
            column.get("invalid_count_measured")
            for column in columns
        ),
    }

    components = {
        "completeness": (
            1.0 - min(
                (total_missing + total_blank) / max(total_cells, 1),
                1.0,
            )
        ),
        "uniqueness": (
            1.0 - (duplicate_rows or 0) / max(total_rows, 1)
        ),
        "consistency": (
            1.0 - min(whitespace / total_values, 1.0)
        ),
        "validity": (
            1.0 - min(invalid / total_values, 1.0)
        ),
    }

    base_weights = {
        "completeness": 0.35,
        "uniqueness": 0.25,
        "consistency": 0.20,
        "validity": 0.20,
    }

    available = sum(
        weight
        for key, weight in base_weights.items()
        if measured[key]
    )

    weights = {
        key: (
            weight / available
            if measured[key] and available
            else 0.0
        )
        for key, weight in base_weights.items()
    }

    score = sum(
        components[key] * weights[key]
        for key in weights
    )

    by_role: Dict[str, int] = {}

    for column in columns:
        role = column["semantic_role"]
        by_role[role] = by_role.get(role, 0) + 1

    return {
        "rows": total_rows,
        "columns": column_count,
        "total_cells": total_cells,
        "total_missing": total_missing,
        "total_blank": total_blank,
        "total_missing_including_blanks": (
            total_missing + total_blank
        ),
        "duplicate_rows": duplicate_rows,
        "duplicate_rows_measured": duplicate_rows is not None,
        "quality_score": round(
            max(0.0, min(score, 1.0)) * 100,
            1,
        ),
        "quality_score_available": bool(available),
        "quality_components": {
            key: (
                round(value * 100, 1)
                if measured[key] else 0.0
            )
            for key, value in components.items()
        },
        "quality_components_measured": measured,
        "quality_weights": weights,
        "quality_note": (
            "Indicative score for measured checks; "
            "not a guarantee of business accuracy. "
            "Unmeasured components have zero weight."
        ),
        "patterns_sampled": any(
            column.get("pattern_sampled")
            for column in columns
        ),
        "distinct_counts_approximate": any(
            column["distinct_is_approximate"]
            for column in columns
        ),
        "role_counts": by_role,
        "measure_count": by_role.get("measure", 0),
        "dimension_count": sum(
            by_role.get(role, 0)
            for role in ("dimension", "category", "geographic")
        ),
        "time_count": by_role.get("time", 0),
        "identifier_count": by_role.get("identifier", 0),
        "primary_key_candidates": [
            column["name"]
            for column in columns
            if column["is_unique"]
            and column["null_count"] == 0
            and column.get("blank_count", 0) == 0
            and column["distinct_count"] > 1
            and column["semantic_role"] == "identifier"
        ],
    }