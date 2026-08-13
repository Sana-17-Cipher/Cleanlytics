"""
CLEANYTICS - relationship discovery between tables.

The question "does Sales.Customer_ID point at Customers.Customer_ID?" is
answered by looking at the values, not by comparing names and hoping. For every
plausible pair of key columns this measures containment in both directions:

    how many of Sales' customer ids actually exist in Customers?   -> 100%
    how many of Customers' ids appear in Sales?                    ->  80%

The side whose values are fully contained in the other is the foreign key. That
single measurement fixes the bug in the previous build, where direction was
inferred from uniqueness alone and every relationship came out labelled
backwards (N:1 printed as 1:N).

Names still matter, but only as a tiebreaker and a confidence booster. Data
wins.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import duckdb

from store import connect, q, table_exists
from analysis import semantics

# Below this combined score a pair is not worth showing at all.
SUGGEST_THRESHOLD = 0.55

# A pair this strong is linked automatically. Deliberately strict: near-total
# containment, a genuinely unique key on the parent side, and a name that lines
# up. Anything less is offered as a suggestion for the user to confirm.
AUTO_APPROVE_CONTAINMENT = 0.99
AUTO_APPROVE_SCORE = 0.90

# Cap on distinct values pulled into a containment check, so one pathological
# column cannot stall the whole scan.
MAX_DISTINCT_FOR_OVERLAP = 2_000_000

# Roles that can never take part in a join.
EXCLUDED_ROLES = {"measure", "text"}


# ─── Name affinity ───────────────────────────────────────────────────────────


def _tokenise(name: str) -> List[str]:
    """Split a column or table name into comparable lowercase tokens."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(name or ""))
    parts = re.split(r"[^A-Za-z0-9]+", spaced)
    tokens = [p.lower() for p in parts if p]
    # Singularise the common plural table name so "Customers" matches
    # "customer_id".
    normalised = []
    for token in tokens:
        if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            normalised.append(token[:-1])
        else:
            normalised.append(token)
    return normalised


KEY_TOKENS = {"id", "key", "code", "no", "num", "number", "pk", "fk", "ref"}


def name_affinity(fk_table: str, fk_column: str, pk_table: str, pk_column: str) -> float:
    """
    Score how strongly two column names suggest a relationship, 0 to 1.

    Handles the case that trips up naive matching: a parent table whose key is
    just called "id". `Customers.id` and `Orders.customer_id` share no column
    tokens at all, but once the parent's table name is folded in they line up
    exactly.
    """
    fk_tokens = _tokenise(fk_column)
    pk_tokens = _tokenise(pk_column)

    if not fk_tokens or not pk_tokens:
        return 0.0

    if fk_tokens == pk_tokens:
        return 1.0

    fk_set, pk_set = set(fk_tokens), set(pk_tokens)

    # Compare the meaningful parts, ignoring the shared "id"/"key" suffix.
    fk_core = fk_set - KEY_TOKENS
    pk_core = pk_set - KEY_TOKENS

    if fk_core and pk_core and fk_core == pk_core:
        return 0.95

    # Parent key is bare ("id"): borrow the parent's table name.
    if not pk_core and fk_core:
        pk_table_tokens = set(_tokenise(pk_table))
        if fk_core & pk_table_tokens:
            return 0.9 if fk_core <= pk_table_tokens else 0.75

    # Child key is bare: same trick in reverse.
    if not fk_core and pk_core:
        fk_table_tokens = set(_tokenise(fk_table))
        if pk_core & fk_table_tokens:
            return 0.7

    if fk_core and pk_core:
        overlap = fk_core & pk_core
        if overlap:
            return round(0.5 + 0.3 * (len(overlap) / max(len(fk_core | pk_core), 1)), 3)

    # Both are bare keys ("id" to "id"): the names say nothing useful, so the
    # decision rests entirely on the values.
    if not fk_core and not pk_core:
        return 0.3

    return 0.0


# ─── Type compatibility ──────────────────────────────────────────────────────


def type_compatibility(a_type: str, b_type: str) -> float:
    """
    How joinable two physical types are.

    Integer keys exported to CSV routinely come back as text in one file and as
    numbers in another, so that pairing is allowed but scored slightly lower and
    reported, since it needs a cast at query time.
    """
    a_num, b_num = semantics.is_numeric_type(a_type), semantics.is_numeric_type(b_type)
    a_time, b_time = semantics.is_temporal_type(a_type), semantics.is_temporal_type(b_type)
    a_base, b_base = semantics.base_duck_type(a_type), semantics.base_duck_type(b_type)

    if a_base == b_base:
        return 1.0
    if a_num and b_num:
        return 0.95
    if a_time and b_time:
        return 0.9
    if (a_num and b_base == "VARCHAR") or (b_num and a_base == "VARCHAR"):
        return 0.7
    if a_base == "VARCHAR" and b_base == "VARCHAR":
        return 1.0
    return 0.0


# ─── Candidate selection ─────────────────────────────────────────────────────


def _key_candidates(table: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Narrow a table's columns down to those that could take part in a join.

    Without this filter the scan is O(columns squared) across every pair of
    tables and produces nonsense matches between unrelated numeric columns.
    """
    profile = table.get("profile") or {}
    candidates = []
    for column in profile.get("columns", []):
        role = column.get("semantic_role")
        if role in EXCLUDED_ROLES:
            continue
        if column.get("is_constant") or column.get("is_empty"):
            continue
        if column.get("logical_type") == "boolean" or role == "boolean":
            continue
        if column.get("subtype") in {"email", "phone", "url"}:
            # These do identify a person, but joining two files on an email
            # column is a data-matching exercise, not a data model.
            continue
        if int(column.get("distinct_count") or 0) < 2:
            continue
        candidates.append(column)
    return candidates


def domain_distinctiveness(column: Dict[str, Any]) -> float:
    """
    How much a value match actually tells us, from 0 (nothing) to 1 (a lot).

    This is the guard against the most common false positive in key discovery.
    Two unrelated tables that both number their rows 1, 2, 3... will show 100%
    value containment, because every small integer sequence is contained in
    every longer one. Matching on "C4471-XZ" is strong evidence; matching on
    "7" is almost none.
    """
    logical = column.get("logical_type")
    stats = column.get("statistics") or {}
    ndv = int(column.get("distinct_count") or 0)

    if logical in {"date", "datetime", "time"}:
        # Calendars overlap by construction; two tables covering 2024 share
        # every date without being related at all.
        return 0.2

    if logical == "text":
        average = float(stats.get("avg_length") or 0)
        if average >= 6:
            return 0.95
        if average >= 4:
            return 0.85
        return 0.5

    if logical in {"integer", "decimal", "currency", "percentage"}:
        low, high = stats.get("min"), stats.get("max")
        try:
            if low is not None and high is not None and ndv > 0:
                span = float(high) - float(low) + 1
                # A dense run of small integers is a row counter, not a key
                # with meaning of its own.
                dense = span <= ndv * 1.2
                if dense and float(low) <= 10 and float(high) < 100_000:
                    return 0.1
                if dense:
                    return 0.35
                if span > ndv * 50:
                    # Sparse, widely spread numbers are hard to collide with.
                    return 0.8
        except (TypeError, ValueError):
            pass
        return 0.45

    return 0.4


def _worth_testing(
    fk_table: Dict[str, Any],
    fk_column: Dict[str, Any],
    pk_table: Dict[str, Any],
    pk_column: Dict[str, Any],
) -> Optional[Tuple[float, float]]:
    """Cheap pre-filter, so containment SQL only runs on plausible pairs."""
    compatibility = type_compatibility(fk_column.get("physical_type", ""), pk_column.get("physical_type", ""))
    if compatibility <= 0.0:
        return None

    affinity = name_affinity(
        fk_table["table_name"], fk_column["name"], pk_table["table_name"], pk_column["name"]
    )

    # Either the names line up, or the values themselves are distinctive enough
    # that a match cannot reasonably be coincidence. A pair with neither is not
    # worth the query.
    if affinity >= 0.5:
        return compatibility, affinity

    distinctiveness = max(domain_distinctiveness(fk_column), domain_distinctiveness(pk_column))
    if distinctiveness >= 0.6:
        return compatibility, affinity

    return None


# ─── Containment measurement ─────────────────────────────────────────────────


def _measure_overlap(
    con: duckdb.DuckDBPyConnection,
    left_table: str,
    left_column: str,
    right_table: str,
    right_column: str,
) -> Dict[str, Any]:
    """
    Count distinct values on each side and how many they share.

    Both sides are cast to text so an integer key in one file still matches the
    same key stored as text in another, which is the single most common shape of
    real-world export data.
    """
    sql = f"""
        WITH l AS (
            SELECT DISTINCT CAST({q(left_column)} AS VARCHAR) AS v
            FROM {q(left_table)} WHERE {q(left_column)} IS NOT NULL
            LIMIT {MAX_DISTINCT_FOR_OVERLAP}
        ), r AS (
            SELECT DISTINCT CAST({q(right_column)} AS VARCHAR) AS v
            FROM {q(right_table)} WHERE {q(right_column)} IS NOT NULL
            LIMIT {MAX_DISTINCT_FOR_OVERLAP}
        )
        SELECT
            (SELECT count(*) FROM l) AS left_distinct,
            (SELECT count(*) FROM r) AS right_distinct,
            (SELECT count(*) FROM l JOIN r ON l.v = r.v) AS shared
    """
    row = con.execute(sql).fetchone()
    left_n, right_n, shared = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
    return {
        "left_distinct": left_n,
        "right_distinct": right_n,
        "shared": shared,
        "left_in_right": (shared / left_n) if left_n else 0.0,
        "right_in_left": (shared / right_n) if right_n else 0.0,
    }


def _cardinality(fk_unique: bool, pk_unique: bool) -> str:
    """Cardinality written from the foreign key's side, which is how it reads."""
    if fk_unique and pk_unique:
        return "one_to_one"
    if pk_unique and not fk_unique:
        return "many_to_one"
    if fk_unique and not pk_unique:
        return "one_to_many"
    return "many_to_many"


CARDINALITY_LABEL = {
    "one_to_one": "1:1",
    "many_to_one": "N:1",
    "one_to_many": "1:N",
    "many_to_many": "N:M",
}


# ─── Main entry point ────────────────────────────────────────────────────────


def detect(project_id: int, tables: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Find relationships across a project's tables.

    `tables` needs `id`, `table_name`, `physical_name` and `profile` for each
    entry. Returns candidates sorted strongest first, each already oriented
    foreign key -> primary key.
    """
    usable = [t for t in tables if (t.get("profile") or {}).get("columns")]
    if len(usable) < 2:
        return []

    candidates: List[Dict[str, Any]] = []

    with connect(project_id, read_only=True) as con:
        present = {t["physical_name"] for t in usable if table_exists(con, t["physical_name"])}
        usable = [t for t in usable if t["physical_name"] in present]

        for i in range(len(usable)):
            for j in range(i + 1, len(usable)):
                left, right = usable[i], usable[j]
                for left_column in _key_candidates(left):
                    for right_column in _key_candidates(right):
                        pre = _worth_testing(left, left_column, right, right_column)
                        if pre is None:
                            pre = _worth_testing(right, right_column, left, left_column)
                            if pre is None:
                                continue
                        compatibility, affinity = pre

                        try:
                            overlap = _measure_overlap(
                                con,
                                left["physical_name"], left_column["name"],
                                right["physical_name"], right_column["name"],
                            )
                        except duckdb.Error:
                            # A pair that will not compare (incompatible casts)
                            # is simply not a relationship.
                            continue

                        candidate = _score(
                            left, left_column, right, right_column, overlap, compatibility, affinity
                        )
                        if candidate:
                            candidates.append(candidate)

    candidates.sort(key=lambda c: -c["confidence"])
    return _deduplicate(candidates)


def _score(
    left: Dict[str, Any],
    left_column: Dict[str, Any],
    right: Dict[str, Any],
    right_column: Dict[str, Any],
    overlap: Dict[str, Any],
    compatibility: float,
    affinity: float,
) -> Optional[Dict[str, Any]]:
    """Turn one measured pair into a directed, scored relationship candidate."""
    if overlap["shared"] == 0:
        return None

    left_unique = bool(left_column.get("is_unique"))
    right_unique = bool(right_column.get("is_unique"))

    # ── Direction ────────────────────────────────────────────────────────────
    # The foreign key is the side whose values all appear on the other side.
    # Uniqueness only breaks ties, because a small child table can look unique
    # by accident while the parent genuinely is unique by design.
    if right_unique and not left_unique:
        fk_is_left = True
    elif left_unique and not right_unique:
        fk_is_left = False
    elif overlap["left_in_right"] > overlap["right_in_left"] + 0.05:
        fk_is_left = True
    elif overlap["right_in_left"] > overlap["left_in_right"] + 0.05:
        fk_is_left = False
    else:
        # Equally contained both ways: treat the larger table as the child,
        # since a lookup table is normally the smaller of the two.
        fk_is_left = int(left_column.get("row_count") or 0) >= int(right_column.get("row_count") or 0)

    if fk_is_left:
        fk_table, fk_column, fk_unique = left, left_column, left_unique
        pk_table, pk_column, pk_unique = right, right_column, right_unique
        containment = overlap["left_in_right"]
        orphan_ratio = 1.0 - overlap["left_in_right"]
    else:
        fk_table, fk_column, fk_unique = right, right_column, right_unique
        pk_table, pk_column, pk_unique = left, left_column, left_unique
        containment = overlap["right_in_left"]
        orphan_ratio = 1.0 - overlap["right_in_left"]

    directed_affinity = name_affinity(
        fk_table["table_name"], fk_column["name"], pk_table["table_name"], pk_column["name"]
    )
    affinity = max(affinity, directed_affinity)

    uniqueness_score = 1.0 if pk_unique else (0.4 if float(pk_column.get("unique_ratio") or 0) > 0.9 else 0.1)
    distinctiveness = max(domain_distinctiveness(fk_column), domain_distinctiveness(pk_column))

    # Values alone are not enough when the values are unremarkable. A perfect
    # overlap between two columns of small sequential integers with unrelated
    # names is a coincidence, and reporting it as a relationship sends the user
    # off to build a data model on sand.
    if affinity < 0.5 and distinctiveness < 0.6:
        return None

    confidence = (
        0.45 * containment
        + 0.25 * uniqueness_score
        + 0.20 * affinity
        + 0.10 * compatibility
    )
    # Weak names plus unremarkable values means the evidence is thin however
    # cleanly the numbers line up, and the score should say so.
    if affinity < 0.5:
        confidence *= 0.6 + 0.4 * distinctiveness

    confidence = round(min(confidence, 0.99), 3)
    if confidence < SUGGEST_THRESHOLD:
        return None

    cardinality = _cardinality(fk_unique, pk_unique)

    notes: List[str] = []
    if orphan_ratio > 0.001:
        missing = round(orphan_ratio * 100, 1)
        notes.append(
            f"{missing}% of {fk_table['table_name']}.{fk_column['name']} values have no match in "
            f"{pk_table['table_name']}. Those rows disappear from an inner join."
        )
    if not pk_unique:
        notes.append(
            f"{pk_table['table_name']}.{pk_column['name']} is not unique, so joining on it multiplies rows "
            f"and will overstate any total."
        )
    if compatibility < 0.95:
        notes.append(
            f"The two columns are stored as different types "
            f"({fk_column.get('physical_type')} and {pk_column.get('physical_type')}), so the join casts both to text."
        )

    auto = (
        containment >= AUTO_APPROVE_CONTAINMENT
        and pk_unique
        and affinity >= 0.8
        and confidence >= AUTO_APPROVE_SCORE
    )

    return {
        "from_table_id": fk_table["id"],
        "from_table_name": fk_table["table_name"],
        "from_column": fk_column["name"],
        "to_table_id": pk_table["id"],
        "to_table_name": pk_table["table_name"],
        "to_column": pk_column["name"],
        "cardinality": cardinality,
        "cardinality_label": CARDINALITY_LABEL[cardinality],
        "confidence": confidence,
        "status": "approved" if auto else "suggested",
        "auto_approved": auto,
        "coverage": round(containment, 4),
        "orphan_ratio": round(orphan_ratio, 4),
        "matched_values": overlap["shared"],
        "name_affinity": round(affinity, 3),
        "type_compatibility": round(compatibility, 3),
        "notes": notes,
        "evidence": (
            f"{round(containment * 100, 1)}% of the {overlap['shared']:,} distinct "
            f"{fk_column['name']} values in {fk_table['table_name']} are present in "
            f"{pk_table['table_name']}.{pk_column['name']}."
        ),
    }


def measure_pair(
    project_id: int,
    fk_table: Dict[str, Any],
    fk_column: str,
    pk_table: Dict[str, Any],
    pk_column: str,
) -> Optional[Dict[str, Any]]:
    """
    Measure a relationship the user defined by hand.

    Their choice of direction is respected, but the values are still checked so
    they are told straight away if the columns do not line up. A manual link
    that quietly matches nothing is worse than no link at all.
    """
    def find(table: Dict[str, Any], column: str) -> Optional[Dict[str, Any]]:
        for candidate in ((table.get("profile") or {}).get("columns") or []):
            if candidate["name"] == column:
                return candidate
        return None

    fk_profile, pk_profile = find(fk_table, fk_column), find(pk_table, pk_column)
    if not fk_profile or not pk_profile:
        return None

    with connect(project_id, read_only=True) as con:
        overlap = _measure_overlap(
            con, fk_table["physical_name"], fk_column, pk_table["physical_name"], pk_column
        )

    containment = overlap["left_in_right"]
    pk_unique = bool(pk_profile.get("is_unique"))
    fk_unique = bool(fk_profile.get("is_unique"))
    compatibility = type_compatibility(
        fk_profile.get("physical_type", ""), pk_profile.get("physical_type", "")
    )
    affinity = name_affinity(fk_table["table_name"], fk_column, pk_table["table_name"], pk_column)

    notes: List[str] = []
    if overlap["shared"] == 0:
        notes.append(
            f"None of the values in {fk_table['table_name']}.{fk_column} appear in "
            f"{pk_table['table_name']}.{pk_column}. This join will return nothing."
        )
    elif containment < 0.999:
        notes.append(
            f"{round((1 - containment) * 100, 1)}% of {fk_table['table_name']}.{fk_column} values "
            f"have no match in {pk_table['table_name']}."
        )
    if not pk_unique:
        notes.append(
            f"{pk_table['table_name']}.{pk_column} is not unique, so this join multiplies rows "
            f"and will overstate any total built on it."
        )
    if compatibility < 0.95:
        notes.append(
            f"The columns are stored as different types "
            f"({fk_profile.get('physical_type')} and {pk_profile.get('physical_type')}), so the join compares them as text."
        )

    confidence = round(
        min(0.45 * containment + 0.25 * (1.0 if pk_unique else 0.1) + 0.20 * affinity + 0.10 * compatibility, 0.99),
        3,
    )

    return {
        "cardinality": _cardinality(fk_unique, pk_unique),
        "confidence": confidence,
        "coverage": round(containment, 4),
        "notes": notes,
        "evidence": (
            f"{round(containment * 100, 1)}% of the distinct {fk_column} values in "
            f"{fk_table['table_name']} are present in {pk_table['table_name']}.{pk_column}."
        ),
    }


def _deduplicate(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Keep the best relationship per table pair per column.

    A column should join to one parent, not three. Candidates arrive sorted by
    confidence, so the first sighting of each key wins.
    """
    seen_pairs: set = set()
    seen_fk: set = set()
    result: List[Dict[str, Any]] = []

    for candidate in candidates:
        pair = frozenset(
            [
                (candidate["from_table_id"], candidate["from_column"]),
                (candidate["to_table_id"], candidate["to_column"]),
            ]
        )
        fk_identity = (candidate["from_table_id"], candidate["from_column"], candidate["to_table_id"])
        if pair in seen_pairs or fk_identity in seen_fk:
            continue
        seen_pairs.add(pair)
        seen_fk.add(fk_identity)
        result.append(candidate)

    return result
