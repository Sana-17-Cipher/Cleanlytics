"""
CLEANYTICS — relationship discovery.

Candidate selection uses column profiles. Cardinality and overlap are
verified against current data using exact, read-only queries.

Scores are heuristics, not probabilities.
Composite keys are not inferred by this module.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from store import connect, describe, q, table_exists
from analysis import semantics


SUGGEST_THRESHOLD = 0.55
AUTO_APPROVE_CONTAINMENT = 1.0
AUTO_APPROVE_SCORE = 0.90
MIN_AUTO_SHARED_VALUES = 3

EXCLUDED_ROLES = {"measure", "text", "boolean"}

KEY_TOKENS = {
    "id", "key", "code", "no", "num", "number",
    "pk", "fk", "ref", "uuid", "guid",
}

TEXT_TYPES = {"VARCHAR", "TEXT", "CHAR", "BPCHAR", "STRING"}

CARDINALITY_LABEL = {
    "one_to_one": "1:1",
    "many_to_one": "N:1",
    "one_to_many": "1:N",
    "many_to_many": "N:M",
}


# ─── Name affinity ───────────────────────────────────────────────────────────


def _tokenise(name: str) -> List[str]:
    text = re.sub(
        r"([A-Z]+)([A-Z][a-z])",
        r"\1_\2",
        str(name or ""),
    )
    text = re.sub(
        r"([a-z0-9])([A-Z])",
        r"\1_\2",
        text,
    )
    tokens = re.findall(
        r"[^\W_]+",
        text.lower(),
        re.UNICODE,
    )

    result = []

    for token in tokens:
        if len(token) > 4 and token.endswith("ies"):
            token = token[:-3] + "y"
        elif (
            len(token) > 3
            and token.endswith("s")
            and not token.endswith(("ss", "us", "is"))
        ):
            token = token[:-1]

        result.append(token)

    return result


def name_affinity(
    fk_table: str,
    fk_column: str,
    pk_table: str,
    pk_column: str,
) -> float:
    fk_tokens = _tokenise(fk_column)
    pk_tokens = _tokenise(pk_column)

    if not fk_tokens or not pk_tokens:
        return 0.0

    fk_core = set(fk_tokens) - KEY_TOKENS
    pk_core = set(pk_tokens) - KEY_TOKENS

    # Two columns called "id" provide no entity-level evidence.
    if not fk_core and not pk_core:
        return 0.15

    if fk_tokens == pk_tokens:
        return 1.0

    if fk_core and fk_core == pk_core:
        return 0.95

    # Orders.customer_id -> Customers.id
    if not pk_core and fk_core:
        parent = set(_tokenise(pk_table)) - {
            "dim", "dimension", "table", "tbl",
        }

        if fk_core & parent:
            return 0.90 if fk_core <= parent else 0.75

    if not fk_core and pk_core:
        if pk_core & set(_tokenise(fk_table)):
            return 0.70

    if fk_core and pk_core and fk_core & pk_core:
        return round(
            0.5
            + 0.3 * len(fk_core & pk_core) / len(fk_core | pk_core),
            3,
        )

    return 0.0


# ─── Type compatibility ──────────────────────────────────────────────────────


def type_compatibility(a_type: str, b_type: str) -> float:
    a = semantics.base_duck_type(a_type)
    b = semantics.base_duck_type(b_type)

    supported = (
        TEXT_TYPES
        | semantics.NUMERIC_DUCK_TYPES
        | semantics.TEMPORAL_DUCK_TYPES
        | {"DECIMAL", "NUMERIC", "UUID", "BOOLEAN"}
    )

    if a not in supported or b not in supported:
        return 0.0

    if a == b:
        return 1.0

    if semantics.is_numeric_type(a) and semantics.is_numeric_type(b):
        return 0.95

    if semantics.is_temporal_type(a) and semantics.is_temporal_type(b):
        return 0.90

    if (
        (a in TEXT_TYPES and b in supported)
        or (b in TEXT_TYPES and a in supported)
    ):
        return 0.70

    return 0.0


# ─── Candidate selection ─────────────────────────────────────────────────────


def _key_candidates(
    table: Dict[str, Any],
) -> List[Dict[str, Any]]:
    return [
        column
        for column in (table.get("profile") or {}).get("columns", [])
        if column.get("semantic_role") not in EXCLUDED_ROLES
        and not column.get("is_constant")
        and not column.get("is_empty")
        and column.get("logical_type") != "boolean"
        and column.get("subtype") not in {"email", "phone", "url"}
        and int(column.get("distinct_count") or 0) >= 2
    ]


def domain_distinctiveness(column: Dict[str, Any]) -> float:
    if column.get("subtype") == "uuid":
        return 1.0

    logical = column.get("logical_type")
    stats = column.get("statistics") or {}
    ndv = int(column.get("distinct_count") or 0)

    if logical in semantics.TEMPORAL_LOGICAL:
        return 0.2

    if logical == "text":
        # Numeric strings can be unrelated row counters.
        if (
            (column.get("patterns") or {}).get("numeric_ratio", 0)
            >= 0.9
        ):
            return 0.25

        if column.get("semantic_role") != "identifier":
            return 0.4

        length = float(stats.get("avg_length") or 0)
        return 0.85 if length >= 6 else 0.5

    if logical in semantics.NUMERIC_LOGICAL:
        try:
            lo = float(stats["min"])
            hi = float(stats["max"])
            span = hi - lo + 1

            if ndv and 0 < span <= ndv * 1.2:
                return (
                    0.1
                    if lo <= 10 and hi < 100_000
                    else 0.35
                )

            if ndv and span > ndv * 50:
                return 0.8

        except (KeyError, TypeError, ValueError):
            pass

        return 0.45

    return 0.4


def _worth_testing(
    left: Dict[str, Any],
    left_column: Dict[str, Any],
    right: Dict[str, Any],
    right_column: Dict[str, Any],
) -> Optional[Tuple[float, float]]:
    compatibility = type_compatibility(
        left_column.get("physical_type", ""),
        right_column.get("physical_type", ""),
    )

    if not compatibility:
        return None

    affinity = max(
        name_affinity(
            left["table_name"],
            left_column["name"],
            right["table_name"],
            right_column["name"],
        ),
        name_affinity(
            right["table_name"],
            right_column["name"],
            left["table_name"],
            left_column["name"],
        ),
    )

    distinctive = min(
        domain_distinctiveness(left_column),
        domain_distinctiveness(right_column),
    )

    if affinity >= 0.5 or distinctive >= 0.8:
        return compatibility, affinity

    return None


# ─── Exact measurements ──────────────────────────────────────────────────────


def _measure_overlap(
    con,
    left_table: str,
    left_column: str,
    right_table: str,
    right_column: str,
) -> Dict[str, Any]:
    """
    Measure complete domains without truncation.

    Match the existing query engine: native equality for equal base types,
    otherwise text equality. Leading zeros and case are not normalised.
    Null/blank keys are excluded from coverage.
    """
    left_schema = {
        column["name"]: column["type"]
        for column in describe(con, left_table)
    }
    right_schema = {
        column["name"]: column["type"]
        for column in describe(con, right_table)
    }

    same = (
        semantics.base_duck_type(left_schema[left_column])
        == semantics.base_duck_type(right_schema[right_column])
    )

    left_expr = q(left_column)
    right_expr = q(right_column)

    if not same:
        left_expr = f"CAST({left_expr} AS VARCHAR)"
        right_expr = f"CAST({right_expr} AS VARCHAR)"

    whitespace = "' \t\r\n\f\v\u00a0'"
    valid = f"trim(CAST(v AS VARCHAR), {whitespace}) <> ''"

    row = con.execute(
        f"""
        WITH l AS (
            SELECT {left_expr} AS v, count(*) AS n
            FROM {q(left_table)}
            WHERE {q(left_column)} IS NOT NULL
            GROUP BY 1
        ), r AS (
            SELECT {right_expr} AS v, count(*) AS n
            FROM {q(right_table)}
            WHERE {q(right_column)} IS NOT NULL
            GROUP BY 1
        ), lv AS (
            SELECT * FROM l WHERE {valid}
        ), rv AS (
            SELECT * FROM r WHERE {valid}
        ), matched AS (
            SELECT lv.n AS ln, rv.n AS rn
            FROM lv
            JOIN rv ON lv.v = rv.v
        )
        SELECT
            (SELECT count(*) FROM lv),
            (SELECT count(*) FROM rv),
            (SELECT count(*) FROM matched),
            (SELECT coalesce(sum(n), 0) FROM lv),
            (SELECT coalesce(sum(n), 0) FROM rv),
            (SELECT coalesce(sum(ln), 0) FROM matched),
            (SELECT coalesce(sum(rn), 0) FROM matched),
            (SELECT count(*) FROM {q(left_table)}),
            (SELECT count(*) FROM {q(right_table)}),
            (SELECT coalesce(max(n), 0) FROM l),
            (SELECT coalesce(max(n), 0) FROM r)
        """
    ).fetchone()

    (
        left_distinct,
        right_distinct,
        shared,
        left_rows,
        right_rows,
        left_matched,
        right_matched,
        left_total,
        right_total,
        left_max_count,
        right_max_count,
    ) = map(int, row)

    return {
        "left_distinct": left_distinct,
        "right_distinct": right_distinct,
        "shared": shared,
        "left_in_right": (
            shared / left_distinct if left_distinct else 0.0
        ),
        "right_in_left": (
            shared / right_distinct if right_distinct else 0.0
        ),
        "left_rows": left_rows,
        "right_rows": right_rows,
        "left_matched_rows": left_matched,
        "right_matched_rows": right_matched,
        "left_total": left_total,
        "right_total": right_total,
        "left_missing": left_total - left_rows,
        "right_missing": right_total - right_rows,
        "left_unique": bool(
            left_distinct and left_max_count == 1
        ),
        "right_unique": bool(
            right_distinct and right_max_count == 1
        ),
        "exact": True,
    }


def _cardinality(fk_unique: bool, pk_unique: bool) -> str:
    if fk_unique and pk_unique:
        return "one_to_one"
    if pk_unique:
        return "many_to_one"
    if fk_unique:
        return "one_to_many"
    return "many_to_many"


# ─── Evidence and scoring ────────────────────────────────────────────────────


def _describe_pair(
    fk_table,
    fk_column,
    pk_table,
    pk_column,
    overlap,
    fk_left=True,
) -> Dict[str, Any]:
    fk, pk = (
        ("left", "right")
        if fk_left
        else ("right", "left")
    )

    coverage = overlap[f"{fk}_in_{pk}"]
    distinct = overlap[f"{fk}_distinct"]
    rows = overlap[f"{fk}_rows"]
    matched_rows = overlap[f"{fk}_matched_rows"]
    pk_unique = overlap[f"{pk}_unique"]

    affinity = name_affinity(
        fk_table["table_name"],
        fk_column["name"],
        pk_table["table_name"],
        pk_column["name"],
    )
    compatibility = type_compatibility(
        fk_column.get("physical_type", ""),
        pk_column.get("physical_type", ""),
    )

    confidence = min(
        0.99,
        0.45 * coverage
        + 0.25 * (1.0 if pk_unique else 0.1)
        + 0.20 * affinity
        + 0.10 * compatibility,
    )

    notes = []
    unmatched = distinct - overlap["shared"]

    if unmatched:
        notes.append(
            f"{unmatched:,} distinct nonblank child keys have "
            f"no match, affecting {rows - matched_rows:,} rows. "
            "A left join retains them with missing parent fields."
        )

    if overlap[f"{fk}_missing"]:
        notes.append(
            f"{overlap[f'{fk}_missing']:,} child rows have null "
            "or blank keys; these are excluded from key coverage."
        )

    if overlap[f"{pk}_missing"]:
        notes.append(
            f"{overlap[f'{pk}_missing']:,} parent rows have null "
            "or blank keys; clean these before treating the column "
            "as a primary key."
        )

    if not pk_unique:
        notes.append(
            "The parent column contains repeated non-null keys. "
            "Matching repeated keys can multiply rows and inflate "
            "aggregates."
        )

    if compatibility < 1:
        notes.append(
            "Physical types differ. The current query engine "
            "compares these keys as text; leading zeros, decimal "
            "formatting and case are not normalised."
        )

    if not overlap["shared"]:
        notes.append(
            "No nonblank keys match. An inner join yields no "
            "matching rows; a left join retains child rows with "
            "missing parent fields."
        )

    return {
        "cardinality": _cardinality(
            overlap[f"{fk}_unique"],
            pk_unique,
        ),
        "confidence": round(confidence, 3),
        "coverage": round(coverage, 4),
        "orphan_ratio": round(1 - coverage, 4),
        "row_coverage": (
            round(matched_rows / rows, 4) if rows else 0.0
        ),
        "matched_values": overlap["shared"],
        "matched_rows": matched_rows,
        "name_affinity": affinity,
        "type_compatibility": compatibility,
        "measurement_exact": True,
        "notes": notes,
        "evidence": (
            f"{overlap['shared']:,} of {distinct:,} distinct "
            f"nonblank keys ({coverage:.1%}) in "
            f"{fk_table['table_name']}.{fk_column['name']} match "
            f"{pk_table['table_name']}.{pk_column['name']}; "
            f"{matched_rows:,} of {rows:,} nonblank child rows "
            "match. Counts are exact."
        ),
    }


def _score(
    left,
    left_column,
    right,
    right_column,
    overlap,
    compatibility,
    affinity,
) -> Optional[Dict[str, Any]]:
    if not overlap["shared"]:
        return None

    left_unique = overlap["left_unique"]
    right_unique = overlap["right_unique"]

    forward = name_affinity(
        left["table_name"],
        left_column["name"],
        right["table_name"],
        right_column["name"],
    )
    reverse = name_affinity(
        right["table_name"],
        right_column["name"],
        left["table_name"],
        left_column["name"],
    )

    ambiguous = False

    if left_unique != right_unique:
        fk_left = right_unique

    elif abs(forward - reverse) >= 0.15:
        fk_left = forward > reverse

    elif (
        abs(
            overlap["left_in_right"]
            - overlap["right_in_left"]
        ) > 0.05
    ):
        fk_left = (
            overlap["left_in_right"]
            > overlap["right_in_left"]
        )

    else:
        fk_left = (
            overlap["left_total"]
            >= overlap["right_total"]
        )
        ambiguous = True

    if fk_left:
        fk_table, fk_column = left, left_column
        pk_table, pk_column = right, right_column
        parent = "right"
        child = "left"
    else:
        fk_table, fk_column = right, right_column
        pk_table, pk_column = left, left_column
        parent = "left"
        child = "right"

    result = _describe_pair(
        fk_table,
        fk_column,
        pk_table,
        pk_column,
        overlap,
        fk_left,
    )

    if result["confidence"] < SUGGEST_THRESHOLD:
        return None

    # Approval uses exact counts, not rounded display percentages.
    auto = (
        overlap["shared"] == overlap[f"{child}_distinct"]
        and overlap["shared"] >= MIN_AUTO_SHARED_VALUES
        and overlap[f"{parent}_unique"]
        and overlap[f"{parent}_missing"] == 0
        and result["name_affinity"] >= 0.8
        and result["confidence"] >= AUTO_APPROVE_SCORE
        and compatibility >= 0.95
        and fk_column.get("semantic_role") == "identifier"
        and pk_column.get("semantic_role") == "identifier"
        and not ambiguous
    )

    if ambiguous:
        result["notes"].append(
            "Both directions are plausible. The displayed "
            "direction is provisional; confirm the business "
            "relationship."
        )

    result.update({
        "from_table_id": fk_table["id"],
        "from_table_name": fk_table["table_name"],
        "from_column": fk_column["name"],
        "to_table_id": pk_table["id"],
        "to_table_name": pk_table["table_name"],
        "to_column": pk_column["name"],
        "cardinality_label": CARDINALITY_LABEL[
            result["cardinality"]
        ],
        "status": "approved" if auto else "suggested",
        "auto_approved": auto,
    })

    return result


# ─── Competing links and paths ────────────────────────────────────────────────


def _deduplicate(
    candidates: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Remove identical links while retaining alternative parent choices."""
    result = []
    seen = set()

    for candidate in candidates:
        pair = frozenset((
            (
                candidate["from_table_id"],
                candidate["from_column"],
            ),
            (
                candidate["to_table_id"],
                candidate["to_column"],
            ),
        ))

        if pair not in seen:
            seen.add(pair)
            result.append(candidate)

    return result


def _resolve_ambiguity(
    candidates: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    def suggest(candidate, reason):
        candidate["status"] = "suggested"
        candidate["auto_approved"] = False
        candidate["notes"].append(reason)

    by_child = {}
    by_pair = {}

    for candidate in candidates:
        child_key = (
            candidate["from_table_id"],
            candidate["from_column"],
        )
        table_pair = frozenset((
            candidate["from_table_id"],
            candidate["to_table_id"],
        ))

        by_child.setdefault(child_key, []).append(candidate)
        by_pair.setdefault(table_pair, []).append(candidate)

    for group in by_child.values():
        best = max(candidate["confidence"] for candidate in group)
        rivals = [
            candidate
            for candidate in group
            if candidate["confidence"] >= best - 0.08
        ]

        if len(rivals) > 1:
            for candidate in rivals:
                suggest(
                    candidate,
                    "This child key has competing parent candidates; "
                    "select the intended parent.",
                )

    for group in by_pair.values():
        approved = [
            candidate
            for candidate in group
            if candidate["auto_approved"]
        ]

        if len(approved) > 1:
            for candidate in approved:
                suggest(
                    candidate,
                    "Multiple links connect these tables; choose "
                    "which relationship should be used for queries.",
                )

    # Avoid cycles among newly auto-approved candidates.
    # Existing stored links also need API/query-layer validation.
    roots = {}

    def root(node):
        roots.setdefault(node, node)

        while roots[node] != node:
            node = roots[node]

        return node

    for candidate in candidates:
        if not candidate["auto_approved"]:
            continue

        left_root = root(candidate["from_table_id"])
        right_root = root(candidate["to_table_id"])

        if left_root == right_root:
            suggest(
                candidate,
                "This link would create another path in the "
                "detected model; review it before activation.",
            )
        else:
            roots[left_root] = right_root

    return candidates


# ─── Automatic detection ─────────────────────────────────────────────────────


def detect(
    project_id: int,
    tables: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    usable = sorted(
        [
            table
            for table in tables
            if (table.get("profile") or {}).get("columns")
        ],
        key=lambda table: table["id"],
    )

    if len(usable) < 2:
        return []

    candidates = []

    with connect(project_id, read_only=True) as con:
        usable = [
            table
            for table in usable
            if table_exists(con, table["physical_name"])
        ]

        choices = {}

        for table in usable:
            schema = {
                column["name"]: column["type"]
                for column in describe(con, table["physical_name"])
            }

            # Use current types and ignore removed columns.
            choices[table["id"]] = [
                dict(
                    column,
                    physical_type=schema[column["name"]],
                )
                for column in _key_candidates(table)
                if column["name"] in schema
            ]

        for index, left in enumerate(usable):
            for right in usable[index + 1:]:
                for left_column in choices[left["id"]]:
                    for right_column in choices[right["id"]]:
                        pre = _worth_testing(
                            left,
                            left_column,
                            right,
                            right_column,
                        )

                        if pre is None:
                            continue

                        # A resource/SQL failure should be reported,
                        # not silently presented as "no relationships".
                        overlap = _measure_overlap(
                            con,
                            left["physical_name"],
                            left_column["name"],
                            right["physical_name"],
                            right_column["name"],
                        )

                        candidate = _score(
                            left,
                            left_column,
                            right,
                            right_column,
                            overlap,
                            *pre,
                        )

                        if candidate:
                            candidates.append(candidate)

    candidates.sort(
        key=lambda candidate: (
            -candidate["confidence"],
            candidate["from_table_id"],
            candidate["from_column"],
            candidate["to_table_id"],
            candidate["to_column"],
        )
    )

    return _resolve_ambiguity(_deduplicate(candidates))


# ─── Manual relationships ────────────────────────────────────────────────────


def measure_pair(
    project_id: int,
    fk_table: Dict[str, Any],
    fk_column: str,
    pk_table: Dict[str, Any],
    pk_column: str,
) -> Optional[Dict[str, Any]]:
    """Measure a manual link in the direction selected by the user."""
    with connect(project_id, read_only=True) as con:
        for table, column_name in (
            (fk_table, fk_column),
            (pk_table, pk_column),
        ):
            if not table_exists(con, table["physical_name"]):
                return None

            names = {
                column["name"]
                for column in describe(con, table["physical_name"])
            }

            if column_name not in names:
                return None

        left_schema = {
            column["name"]: column["type"]
            for column in describe(con, fk_table["physical_name"])
        }
        right_schema = {
            column["name"]: column["type"]
            for column in describe(con, pk_table["physical_name"])
        }

        overlap = _measure_overlap(
            con,
            fk_table["physical_name"],
            fk_column,
            pk_table["physical_name"],
            pk_column,
        )

    return _describe_pair(
        fk_table,
        {
            "name": fk_column,
            "physical_type": left_schema[fk_column],
        },
        pk_table,
        {
            "name": pk_column,
            "physical_type": right_schema[pk_column],
        },
        overlap,
    )