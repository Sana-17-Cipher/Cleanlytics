"""
CLEANYTICS - the semantic model and cross-table query engine.

This is the part the previous build was missing entirely. It detected
relationships, drew them on a diagram, let the user approve them, and then
never used them for anything: the dashboard component accepted `tables` and
`relationships` as props and read neither.

Here an approved relationship is a real join. The model classifies tables into
facts and dimensions, works out how to get from any table to any other, and
compiles a request for "revenue by customer city" into one SQL statement that
DuckDB runs against the whole dataset.

It also refuses to compute silently wrong answers. Joining a fact table to a
dimension and then summing a dimension's own column double counts it; joining
one fact to two different detail tables multiplies rows. Both are detected and
reported rather than quietly returning an inflated number.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import duckdb

from store import connect, fetch_dicts, q, lit, table_exists
from analysis import semantics

MAX_QUERY_ROWS = 5000
DEFAULT_QUERY_ROWS = 500

AGGREGATIONS = {
    "sum": "sum({expr})",
    "avg": "avg({expr})",
    "min": "min({expr})",
    "max": "max({expr})",
    "count": "count({expr})",
    "count_distinct": "count(DISTINCT {expr})",
    "median": "median({expr})",
}

DATE_PARTS = {
    "year": "CAST(year({expr}) AS VARCHAR)",
    "quarter": "(CAST(year({expr}) AS VARCHAR) || '-Q' || CAST(quarter({expr}) AS VARCHAR))",
    "month": "strftime({expr}, '%Y-%m')",
    "month_name": "monthname({expr})",
    "week": "(CAST(year({expr}) AS VARCHAR) || '-W' || lpad(CAST(week({expr}) AS VARCHAR), 2, '0'))",
    "day": "CAST(CAST({expr} AS DATE) AS VARCHAR)",
    "day_of_week": "dayname({expr})",
}

FILTER_OPERATORS = {
    "=": "=", "!=": "<>", ">": ">", "<": "<", ">=": ">=", "<=": "<=",
}


class ModelError(ValueError):
    """A query or model problem the user can act on."""


# ─── Join graph ──────────────────────────────────────────────────────────────


class JoinGraph:
    """
    The approved relationships, as a navigable graph.

    Edges are stored in both directions so a path can be found from any table to
    any other, but each edge remembers which way the foreign key actually points.
    That orientation is what decides whether a join fans rows out or not.
    """

    def __init__(self, relationships: Sequence[Dict[str, Any]]):
        self.edges: Dict[int, List[Dict[str, Any]]] = {}
        self.relationships = [r for r in relationships if r.get("status") == "approved"]

        for rel in self.relationships:
            forward = {
                "relationship_id": rel.get("id"),
                "from_table_id": rel["from_table_id"],
                "from_column": rel["from_column"],
                "to_table_id": rel["to_table_id"],
                "to_column": rel["to_column"],
                "cardinality": rel.get("cardinality", "many_to_one"),
                # Travelling along the foreign key toward the parent collapses
                # many rows onto one; it never multiplies them.
                "fans_out": rel.get("cardinality") in {"one_to_many", "many_to_many"},
            }
            reverse = {
                **forward,
                "from_table_id": rel["to_table_id"],
                "from_column": rel["to_column"],
                "to_table_id": rel["from_table_id"],
                "to_column": rel["from_column"],
                # Travelling from the parent down to the children does multiply.
                "fans_out": rel.get("cardinality") in {"many_to_one", "many_to_many"},
            }
            self.edges.setdefault(forward["from_table_id"], []).append(forward)
            self.edges.setdefault(reverse["from_table_id"], []).append(reverse)

    def path(self, start: int, goal: int) -> Optional[List[Dict[str, Any]]]:
        """Shortest join path from one table to another, or None."""
        if start == goal:
            return []
        seen = {start}
        queue: deque = deque([(start, [])])
        while queue:
            current, route = queue.popleft()
            for edge in self.edges.get(current, []):
                nxt = edge["to_table_id"]
                if nxt in seen:
                    continue
                extended = route + [edge]
                if nxt == goal:
                    return extended
                seen.add(nxt)
                queue.append((nxt, extended))
        return None

    def connected_to(self, start: int) -> Set[int]:
        seen = {start}
        queue: deque = deque([start])
        while queue:
            current = queue.popleft()
            for edge in self.edges.get(current, []):
                if edge["to_table_id"] not in seen:
                    seen.add(edge["to_table_id"])
                    queue.append(edge["to_table_id"])
        return seen


# ─── Table classification ────────────────────────────────────────────────────


def classify_tables(
    tables: Sequence[Dict[str, Any]], relationships: Sequence[Dict[str, Any]]
) -> Dict[int, Dict[str, Any]]:
    """
    Label each table as a fact, a dimension, or standalone.

    A fact table records events and points outward at the things involved:
    plenty of measures, several foreign keys leaving it. A dimension describes
    one kind of thing and is pointed at. Knowing which is which is what lets the
    app pick a sensible starting table for a query instead of asking the user.
    """
    approved = [r for r in relationships if r.get("status") == "approved"]
    outgoing: Dict[int, int] = {}
    incoming: Dict[int, int] = {}
    for rel in approved:
        outgoing[rel["from_table_id"]] = outgoing.get(rel["from_table_id"], 0) + 1
        incoming[rel["to_table_id"]] = incoming.get(rel["to_table_id"], 0) + 1

    result: Dict[int, Dict[str, Any]] = {}
    for table in tables:
        profile = table.get("profile") or {}
        summary = profile.get("summary") or {}
        measures = int(summary.get("measure_count") or 0)
        out = outgoing.get(table["id"], 0)
        inn = incoming.get(table["id"], 0)

        if out >= 2 or (out >= 1 and measures >= 1 and inn == 0):
            kind, reason = "fact", f"Records events: {measures} measure(s) and {out} link(s) out to other tables."
        elif inn >= 1 and out == 0:
            kind, reason = "dimension", f"Describes one kind of thing; {inn} table(s) refer to it."
        elif out >= 1 and inn >= 1:
            kind, reason = "bridge", "Sits between two other tables."
        elif measures >= 1 and out == 0 and inn == 0:
            kind, reason = "standalone", "Has measures but is not linked to anything yet."
        else:
            kind, reason = "standalone", "Not linked to any other table yet."

        result[table["id"]] = {
            "kind": kind,
            "reason": reason,
            "measure_count": measures,
            "outgoing": out,
            "incoming": inn,
        }
    return result


def choose_base_table(
    table_ids: Sequence[int],
    tables: Sequence[Dict[str, Any]],
    classification: Dict[int, Dict[str, Any]],
    graph: JoinGraph,
) -> int:
    """
    Pick the table a query should start from.

    Starting at the fact table keeps every event row and attaches descriptions
    to it. Starting at a dimension instead would drop the events that have no
    matching description, which quietly changes the answer.
    """
    if not table_ids:
        raise ModelError("Choose at least one field.")

    if len(table_ids) == 1:
        return table_ids[0]

    # Prefer a table that can actually reach all the others.
    reachable = [tid for tid in table_ids if all(graph.path(tid, other) is not None for other in table_ids)]
    pool = reachable or list(table_ids)

    def rank(table_id: int) -> tuple:
        info = classification.get(table_id, {})
        kind_rank = {"fact": 0, "bridge": 1, "standalone": 2, "dimension": 3}.get(info.get("kind"), 4)
        return (kind_rank, -int(info.get("outgoing") or 0), -int(info.get("measure_count") or 0))

    return sorted(pool, key=rank)[0]


# ─── Query compilation ───────────────────────────────────────────────────────


def _table_lookup(tables: Sequence[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    return {t["id"]: t for t in tables}


def _alias(table_id: int) -> str:
    return f"tbl{table_id}"


def _column_reference(table_id: int, column: str) -> str:
    return f"{_alias(table_id)}.{q(column)}"


def _column_profile(table: Dict[str, Any], column: str) -> Dict[str, Any]:
    for candidate in ((table.get("profile") or {}).get("columns") or []):
        if candidate["name"] == column:
            return candidate
    raise ModelError(f'"{column}" is not a column of {table["table_name"]}.')


def _safe_label(raw: str, taken: Set[str]) -> str:
    label = (raw or "value").strip() or "value"
    candidate, index = label, 2
    while candidate.casefold() in taken:
        candidate = f"{label} {index}"
        index += 1
    taken.add(candidate.casefold())
    return candidate


def build_query(
    tables: Sequence[Dict[str, Any]],
    relationships: Sequence[Dict[str, Any]],
    spec: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Compile a field selection into a single SQL statement.

    Returns the SQL, the output field descriptions and any warnings about the
    shape of the join. The SQL is handed back to the caller so the exact query
    behind a number can always be shown.
    """
    lookup = _table_lookup(tables)
    graph = JoinGraph(relationships)
    classification = classify_tables(tables, relationships)

    dimensions = list(spec.get("dimensions") or [])
    measures = list(spec.get("measures") or [])
    filters = list(spec.get("filters") or [])

    if not dimensions and not measures:
        raise ModelError("Choose at least one field to group by or summarise.")

    involved: List[int] = []
    for field in dimensions + measures + filters:
        table_id = int(field.get("table_id"))
        if table_id not in lookup:
            raise ModelError("One of the selected fields belongs to a table that is no longer in this project.")
        if table_id not in involved:
            involved.append(table_id)

    base_id = spec.get("base_table_id")
    base_id = int(base_id) if base_id else choose_base_table(involved, tables, classification, graph)
    if base_id not in lookup:
        raise ModelError("The starting table is not part of this project.")

    warnings: List[str] = []
    joins: List[str] = []
    joined: Set[int] = {base_id}
    fan_out_tables: List[str] = []
    edge_by_table: Dict[int, Dict[str, Any]] = {}

    for table_id in involved:
        if table_id in joined:
            continue
        path = graph.path(base_id, table_id)
        if path is None:
            raise ModelError(
                f'"{lookup[table_id]["table_name"]}" is not linked to "{lookup[base_id]["table_name"]}". '
                f"Approve a relationship between them on the Model screen first."
            )
        for edge in path:
            target = edge["to_table_id"]
            if target in joined:
                continue
            left = _column_reference(edge["from_table_id"], edge["from_column"])
            right = _column_reference(target, edge["to_column"])
            left_profile = _column_profile(lookup[edge["from_table_id"]], edge["from_column"])
            right_profile = _column_profile(lookup[target], edge["to_column"])

            # Keys stored as different types still join, by comparing as text.
            # This is extremely common in exported data and silently returning
            # zero matches would be worse than the cast.
            if semantics.base_duck_type(left_profile.get("physical_type", "")) != semantics.base_duck_type(
                right_profile.get("physical_type", "")
            ):
                left, right = f"CAST({left} AS VARCHAR)", f"CAST({right} AS VARCHAR)"

            joins.append(
                f"LEFT JOIN {q(lookup[target]['physical_name'])} AS {_alias(target)} ON {left} = {right}"
            )
            joined.add(target)
            edge_by_table[target] = edge
            if edge["fans_out"]:
                fan_out_tables.append(lookup[target]["table_name"])

    # ── Correctness warnings ─────────────────────────────────────────────────
    if len(fan_out_tables) >= 2:
        warnings.append(
            f"Joining {lookup[base_id]['table_name']} to both "
            f"{' and '.join(fan_out_tables)} multiplies rows, so totals will be overstated. "
            f"Summarise one of them separately."
        )
    elif fan_out_tables:
        warnings.append(
            f"Each {lookup[base_id]['table_name']} row can match several rows in "
            f"{fan_out_tables[0]}, so counts here are of the combined rows."
        )

    select_parts: List[str] = []
    group_parts: List[str] = []
    fields: List[Dict[str, Any]] = []
    taken_labels: Set[str] = set()

    for dimension in dimensions:
        table_id = int(dimension["table_id"])
        column = dimension["column"]
        profile = _column_profile(lookup[table_id], column)
        expression = _column_reference(table_id, column)

        part = dimension.get("date_part")
        if part:
            if part not in DATE_PARTS:
                raise ModelError(f"Cannot group by '{part}'.")
            if not semantics.is_temporal_type(profile.get("physical_type", "")):
                raise ModelError(f'"{column}" is not a date, so it cannot be grouped by {part}.')
            expression = DATE_PARTS[part].format(expr=expression)
            default_label = f"{column} ({part.replace('_', ' ')})"
        else:
            default_label = column

        label = _safe_label(dimension.get("label") or default_label, taken_labels)
        select_parts.append(f"{expression} AS {q(label)}")
        group_parts.append(expression)
        fields.append(
            {
                "key": label,
                "kind": "dimension",
                "table_id": table_id,
                "table_name": lookup[table_id]["table_name"],
                "column": column,
                "date_part": part,
            }
        )

    for measure in measures:
        table_id = int(measure["table_id"])
        column = measure.get("column")
        aggregation = str(measure.get("aggregation") or "sum").lower()
        if aggregation not in AGGREGATIONS:
            raise ModelError(f"Unknown aggregation '{aggregation}'.")

        if aggregation == "count" and not column:
            expression = "*"
            profile = None
            default_label = f"{lookup[table_id]['table_name']} rows"
        else:
            profile = _column_profile(lookup[table_id], column)
            expression = _column_reference(table_id, column)
            default_label = f"{aggregation.replace('_', ' ')} of {column}"

        # Summing a dimension's own column after joining it to a fact counts it
        # once per fact row. This is the classic double-count and it is the main
        # reason auto-generated dashboards report impossible totals.
        if (
            profile
            and aggregation in {"sum", "avg"}
            and table_id != base_id
            and not edge_by_table.get(table_id, {}).get("fans_out", True)
        ):
            warnings.append(
                f'"{column}" belongs to {lookup[table_id]["table_name"]}, which has one row per '
                f"{lookup[table_id]['table_name'].rstrip('s')}. Taking the {aggregation} of it across "
                f"{lookup[base_id]['table_name']} counts each one repeatedly."
            )

        if profile and profile.get("additivity") == "non_additive" and aggregation == "sum":
            warnings.append(
                f'"{column}" is a rate or price, so adding it up does not produce a meaningful figure. '
                f"An average is usually what is wanted."
            )

        label = _safe_label(measure.get("label") or default_label, taken_labels)
        select_parts.append(f"{AGGREGATIONS[aggregation].format(expr=expression)} AS {q(label)}")
        fields.append(
            {
                "key": label,
                "kind": "measure",
                "table_id": table_id,
                "table_name": lookup[table_id]["table_name"],
                "column": column,
                "aggregation": aggregation,
            }
        )

    where_parts: List[str] = []
    parameters: List[Any] = []
    for condition in filters:
        table_id = int(condition["table_id"])
        column = condition["column"]
        _column_profile(lookup[table_id], column)
        operator = str(condition.get("operator") or "=")
        reference = _column_reference(table_id, column)

        if operator == "is_null":
            where_parts.append(f"{reference} IS NULL")
        elif operator == "not_null":
            where_parts.append(f"{reference} IS NOT NULL")
        elif operator == "in":
            values = condition.get("value") or []
            if not isinstance(values, list) or not values:
                raise ModelError(f'Provide at least one value to filter "{column}" by.')
            placeholders = ", ".join(["?"] * len(values))
            where_parts.append(f"CAST({reference} AS VARCHAR) IN ({placeholders})")
            parameters.extend([str(v) for v in values])
        elif operator == "contains":
            where_parts.append(f"CAST({reference} AS VARCHAR) ILIKE ?")
            parameters.append(f"%{condition.get('value')}%")
        elif operator in FILTER_OPERATORS:
            where_parts.append(f"{reference} {FILTER_OPERATORS[operator]} ?")
            parameters.append(condition.get("value"))
        else:
            raise ModelError(f"Unknown filter '{operator}'.")

    limit = max(1, min(int(spec.get("limit") or DEFAULT_QUERY_ROWS), MAX_QUERY_ROWS))

    order_clause = ""
    order = spec.get("order_by") or {}
    order_key = order.get("field")
    if order_key and any(f["key"] == order_key for f in fields):
        direction = "DESC" if str(order.get("direction", "desc")).lower() == "desc" else "ASC"
        order_clause = f" ORDER BY {q(order_key)} {direction} NULLS LAST"
    elif any(f["kind"] == "measure" for f in fields) and group_parts:
        first_measure = next(f["key"] for f in fields if f["kind"] == "measure")
        order_clause = f" ORDER BY {q(first_measure)} DESC NULLS LAST"

    sql = (
        f"SELECT {', '.join(select_parts)}\n"
        f"FROM {q(lookup[base_id]['physical_name'])} AS {_alias(base_id)}\n"
        + ("\n".join(joins) + "\n" if joins else "")
        + (f"WHERE {' AND '.join(where_parts)}\n" if where_parts else "")
        + (f"GROUP BY {', '.join(group_parts)}\n" if group_parts else "")
        + (order_clause.strip() + "\n" if order_clause else "")
        + f"LIMIT {limit}"
    )

    return {
        "sql": sql,
        "parameters": parameters,
        "fields": fields,
        "base_table_id": base_id,
        "base_table_name": lookup[base_id]["table_name"],
        "joined_tables": [lookup[t]["table_name"] for t in joined if t != base_id],
        "warnings": warnings,
        "limit": limit,
    }


def run_query(
    project_id: int,
    tables: Sequence[Dict[str, Any]],
    relationships: Sequence[Dict[str, Any]],
    spec: Dict[str, Any],
) -> Dict[str, Any]:
    """Compile and execute a cross-table query."""
    compiled = build_query(tables, relationships, spec)
    with connect(project_id, read_only=True) as con:
        for table in tables:
            if not table_exists(con, table["physical_name"]):
                raise ModelError(f'"{table["table_name"]}" is missing from the project data.')
        try:
            rows = fetch_dicts(con, compiled["sql"], compiled["parameters"])
        except duckdb.Error as exc:
            raise ModelError(f"That query could not be run: {exc}") from exc

    return {
        "rows": rows,
        "row_count": len(rows),
        "truncated": len(rows) >= compiled["limit"],
        "fields": compiled["fields"],
        "sql": compiled["sql"],
        "warnings": compiled["warnings"],
        "base_table_name": compiled["base_table_name"],
        "joined_tables": compiled["joined_tables"],
    }


# ─── Suggested cross-table analyses ──────────────────────────────────────────


MONEY_WORDS = semantics._vocab(
    "revenue", "sales", "amount", "total", "profit", "cost", "price",
    "spend", "income", "expense", "payment", "value", "margin", "budget",
    "turnover", "gmv", "arr", "mrr",
)


def rank_measures(columns: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Order a table's measures by how likely they are to be the headline number.

    Column order in the source file is meaningless, so picking the first
    numeric column produces suggestions about quantity when the user cares
    about revenue. Money beats counts, and anything summable beats a rate.
    """
    def score(column: Dict[str, Any]) -> tuple:
        name = column.get("name", "")
        is_money = column.get("logical_type") == "currency" or bool(MONEY_WORDS.search(name))
        additive = column.get("additivity") == "additive"
        magnitude = float((column.get("statistics") or {}).get("sum") or 0)
        return (0 if is_money else 1, 0 if additive else 1, -abs(magnitude))

    return sorted([c for c in columns if c.get("semantic_role") == "measure"], key=score)


def suggest_analyses(
    tables: Sequence[Dict[str, Any]], relationships: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Propose analyses that only become possible once tables are linked.

    Every suggestion is a runnable query specification, not a description. The
    previous version showed two hardcoded example cards that mentioned tables
    the user might not even have.
    """
    classification = classify_tables(tables, relationships)
    graph = JoinGraph(relationships)
    lookup = _table_lookup(tables)
    suggestions: List[Dict[str, Any]] = []

    facts = [t for t in tables if classification.get(t["id"], {}).get("kind") == "fact"]
    if not facts:
        facts = [
            t for t in tables
            if int((t.get("profile") or {}).get("summary", {}).get("measure_count") or 0) > 0
        ]

    for fact in facts[:2]:
        fact_columns = (fact.get("profile") or {}).get("columns") or []
        measures = rank_measures(fact_columns)
        times = [c for c in fact_columns if c["semantic_role"] == "time"]
        if not measures:
            continue
        primary = measures[0]

        reachable = graph.connected_to(fact["id"]) - {fact["id"]}
        for other_id in sorted(reachable):
            other = lookup.get(other_id)
            if not other:
                continue
            descriptors = [
                c for c in ((other.get("profile") or {}).get("columns") or [])
                if c["semantic_role"] in {"category", "dimension", "geographic"}
                and 1 < int(c.get("distinct_count") or 0) <= 60
            ]
            if not descriptors:
                continue
            descriptor = descriptors[0]
            aggregation = primary.get("default_aggregation") or "sum"
            suggestions.append(
                {
                    "id": f"x-{fact['id']}-{other_id}-{descriptor['name']}",
                    "title": f"{primary['name']} by {descriptor['name']}",
                    "description": (
                        f"Breaks {fact['table_name']}.{primary['name']} down by "
                        f"{other['table_name']}.{descriptor['name']}, which is only possible because the two "
                        f"tables are linked."
                    ),
                    "chart": semantics.suggested_chart(
                        descriptor["semantic_role"], "measure", int(descriptor.get("distinct_count") or 0)
                    )["chart"],
                    "spec": {
                        "base_table_id": fact["id"],
                        "dimensions": [{"table_id": other_id, "column": descriptor["name"]}],
                        "measures": [
                            {"table_id": fact["id"], "column": primary["name"], "aggregation": aggregation}
                        ],
                        "limit": 50,
                    },
                }
            )

        if times:
            time_column = times[0]
            suggestions.append(
                {
                    "id": f"t-{fact['id']}-{time_column['name']}",
                    "title": f"{primary['name']} over time",
                    "description": f"Monthly trend of {primary['name']} from {fact['table_name']}.",
                    "chart": "line",
                    "spec": {
                        "base_table_id": fact["id"],
                        "dimensions": [
                            {"table_id": fact["id"], "column": time_column["name"], "date_part": "month"}
                        ],
                        "measures": [
                            {
                                "table_id": fact["id"],
                                "column": primary["name"],
                                "aggregation": primary.get("default_aggregation") or "sum",
                            }
                        ],
                        "order_by": {"field": f"{time_column['name']} (month)", "direction": "asc"},
                        "limit": 200,
                    },
                }
            )

    return suggestions[:8]


def describe_model(
    tables: Sequence[Dict[str, Any]], relationships: Sequence[Dict[str, Any]]
) -> Dict[str, Any]:
    """The full model: table roles, links, connectivity and suggested analyses."""
    classification = classify_tables(tables, relationships)
    graph = JoinGraph(relationships)

    islands: List[List[str]] = []
    unassigned = {t["id"] for t in tables}
    lookup = _table_lookup(tables)
    while unassigned:
        seed = next(iter(unassigned))
        group = graph.connected_to(seed) & set(lookup)
        islands.append(sorted(lookup[i]["table_name"] for i in group))
        unassigned -= group

    approved = [r for r in relationships if r.get("status") == "approved"]
    return {
        "tables": [
            {
                "id": t["id"],
                "table_name": t["table_name"],
                "row_count": t.get("row_count"),
                **classification.get(t["id"], {}),
            }
            for t in tables
        ],
        "relationship_count": len(approved),
        "pending_count": len([r for r in relationships if r.get("status") == "suggested"]),
        "islands": islands,
        "is_connected": len(islands) <= 1,
        "suggestions": suggest_analyses(tables, relationships),
    }
