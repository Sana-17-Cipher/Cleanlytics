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

import re
from collections import deque
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import duckdb

from store import connect, describe, fetch_dicts, q, lit, table_exists
from analysis import semantics
from analysis.profiler import NUMERIC_RE, CURRENCY_RE, PERCENT_RE

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
    "week": "strftime({expr}, '%G-W%V')",
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
                "fans_out": rel.get("cardinality") not in {"one_to_one", "many_to_one"},
            }
            reverse = {
                **forward,
                "from_table_id": rel["to_table_id"],
                "from_column": rel["to_column"],
                "to_table_id": rel["from_table_id"],
                "to_column": rel["from_column"],
                # Travelling from the parent down to the children does multiply.
                "fans_out": rel.get("cardinality") not in {"one_to_one", "one_to_many"},
            }
            self.edges.setdefault(forward["from_table_id"], []).append(forward)
            self.edges.setdefault(reverse["from_table_id"], []).append(reverse)

    def path(self, start: int, goal: int) -> Optional[List[Dict[str, Any]]]:
        """Return the sole simple path; reject competing active paths."""
        if start == goal:
            return []
        found = []
        stack = [(start, [], {start})]
        while stack:
            current, route, visited = stack.pop()
            for edge in self.edges.get(current, []):
                target = edge["to_table_id"]
                if target in visited:
                    continue
                extended = route + [edge]
                if target == goal:
                    found.append(extended)
                    if len(found) > 1:
                        raise ModelError(
                            "Multiple approved join paths connect the selected tables. "
                            "Keep one active relationship path before querying them."
                        )
                else:
                    stack.append((target, extended, visited | {target}))
        return found[0] if found else None

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


def _table_id(value: Any) -> int:
    try:
        if isinstance(value, bool):
            raise ValueError
        result = int(value)
        if result <= 0 or str(result) != str(value):
            raise ValueError
        return result
    except (ValueError, TypeError, OverflowError) as exc:
        raise ModelError("A field must specify a valid table ID.") from exc


def _value_expression(table_id: int, profile: Dict[str, Any]) -> str:
    """Read supported logical values without changing the source column."""
    raw = _column_reference(table_id, profile["name"])
    physical = profile.get("physical_type", "")
    logical = profile.get("logical_type")
    if semantics.is_numeric_type(physical):
        return f"CASE WHEN isfinite(TRY_CAST({raw} AS DOUBLE)) THEN {raw} END"
    if semantics.base_duck_type(physical) in {"VARCHAR", "TEXT", "STRING", "CHAR", "BPCHAR"}:
        text = f"trim(CAST({raw} AS VARCHAR), {lit(' ' + chr(9) + chr(10) + chr(13) + chr(12) + chr(11) + chr(160))})"
        if logical in semantics.NUMERIC_LOGICAL:
            pattern = {"currency": CURRENCY_RE, "percentage": PERCENT_RE}.get(logical, NUMERIC_RE)
            clean = f"regexp_replace({text}, '[,$€£¥₹₩% ]', '', 'g')"
            number = f"TRY_CAST({clean} AS DOUBLE)"
            scale = " / 100.0" if logical == "percentage" else ""
            return f"CASE WHEN regexp_matches({text}, {lit(pattern)}) AND isfinite({number}) THEN {number}{scale} END"
        if logical in {"date", "datetime"}:
            target = "DATE" if logical == "date" else "TIMESTAMP"
            return f"TRY_CAST({text} AS {target})"
    return raw


def build_query(tables, relationships, spec: Dict[str, Any]) -> Dict[str, Any]:
    lookup = _table_lookup(tables)
    graph = JoinGraph(relationships)
    classification = classify_tables(tables, relationships)
    dimensions = list(spec.get("dimensions") or [])
    measures = list(spec.get("measures") or [])
    filters = list(spec.get("filters") or [])
    if not dimensions and not measures:
        raise ModelError("Choose at least one field to group by or summarise.")
    involved = []
    for field in dimensions + measures + filters:
        if not isinstance(field, dict):
            raise ModelError("Fields must be objects.")
        table_id = _table_id(field.get("table_id"))
        if table_id not in lookup:
            raise ModelError("A selected table is no longer in this project.")
        if table_id not in involved:
            involved.append(table_id)
    measure_tables = {_table_id(field.get("table_id")) for field in measures}
    if spec.get("base_table_id") is not None:
        base_id = _table_id(spec["base_table_id"])
    elif len(measure_tables) == 1:
        base_id = next(iter(measure_tables))
    else:
        base_id = choose_base_table(involved, tables, classification, graph)
    if base_id not in lookup:
        raise ModelError("The starting table is not part of this project.")

    warnings, joins, used_edges = [], [], []
    joined = {base_id}
    for table_id in involved:
        if table_id in joined:
            continue
        path = graph.path(base_id, table_id)
        if path is None:
            raise ModelError(f"{lookup[table_id]['table_name']} is not linked to {lookup[base_id]['table_name']}. Approve a relationship first.")
        for edge in path:
            target = edge["to_table_id"]
            if target in joined:
                continue
            if target not in lookup or edge["from_table_id"] not in lookup:
                raise ModelError("An approved relationship references a missing table.")
            lp = _column_profile(lookup[edge["from_table_id"]], edge["from_column"])
            rp = _column_profile(lookup[target], edge["to_column"])
            left = _column_reference(edge["from_table_id"], edge["from_column"])
            right = _column_reference(target, edge["to_column"])
            if semantics.base_duck_type(lp.get("physical_type", "")) != semantics.base_duck_type(rp.get("physical_type", "")):
                left, right = f"CAST({left} AS VARCHAR)", f"CAST({right} AS VARCHAR)"
            joins.append(f"LEFT JOIN {q(lookup[target]['physical_name'])} AS {_alias(target)} ON {left} = {right}")
            used_edges.append(edge)
            joined.add(target)
    fans_out = any(edge["fans_out"] for edge in used_edges)
    if fans_out:
        warnings.append("This join can repeat source rows. Only duplicate-insensitive aggregates are permitted.")

    select_parts, group_parts, fields = [], [], []
    labels = set()
    for dimension in dimensions:
        table_id = _table_id(dimension["table_id"])
        column = dimension.get("column")
        profile = _column_profile(lookup[table_id], column)
        expression = _value_expression(table_id, profile)
        part = dimension.get("date_part")
        if part:
            if part not in DATE_PARTS:
                raise ModelError(f"Cannot group by {part}.")
            if profile.get("logical_type") not in {"date", "datetime"}:
                raise ModelError(f"{column} is not a calendar date. Year/month numbers should be grouped directly.")
            expression = DATE_PARTS[part].format(expr=expression)
        label = _safe_label(dimension.get("label") or (f"{column} ({part.replace('_', ' ')})" if part else column), labels)
        select_parts.append(f"{expression} AS {q(label)}")
        group_parts.append(expression)
        fields.append({"key": label, "kind": "dimension", "table_id": table_id, "table_name": lookup[table_id]["table_name"], "column": column, "date_part": part})

    sensitive = False
    for measure in measures:
        table_id = _table_id(measure["table_id"])
        column = measure.get("column")
        profile = _column_profile(lookup[table_id], column) if column else None
        aggregation = str(measure.get("aggregation") or (profile or {}).get("default_aggregation") or "count").lower()
        if aggregation not in AGGREGATIONS:
            raise ModelError(f"Unknown aggregation {aggregation}.")
        duplicate_sensitive = aggregation in {"sum", "avg", "median", "count"}
        sensitive = sensitive or duplicate_sensitive
        if duplicate_sensitive and (fans_out or table_id != base_id):
            raise ModelError("This aggregate would count or weight records repeatedly after the join. Start from the measure's table and join only to unique parent keys, or summarise the tables separately.")
        if profile is None:
            if aggregation != "count":
                raise ModelError("Choose a column for this aggregation.")
            expression = "*"
            default_label = f"{lookup[table_id]['table_name']} rows"
        else:
            expression = _value_expression(table_id, profile)
            if aggregation in {"sum", "avg", "median"} and profile.get("logical_type") not in semantics.NUMERIC_LOGICAL:
                raise ModelError(f"{column} is not a numeric measure.")
            if aggregation == "sum" and profile.get("additivity") in {"non_additive", "semi_additive"}:
                raise ModelError(f"{column} is a rate, measurement, or snapshot. A sum is not a safe default; choose a suitable summary.")
            if profile.get("additivity") == "semi_additive" and aggregation in {"avg", "median"}:
                warnings.append(f"{column}: this is a summary of recorded snapshots, not a closing balance.")
            if profile.get("logical_type") == "percentage" and aggregation == "avg":
                warnings.append(f"{column}: an unweighted average of recorded rates; a weighted rate needs numerator and denominator fields.")
            if not semantics.is_numeric_type(profile.get("physical_type", "")) and profile.get("logical_type") in semantics.NUMERIC_LOGICAL:
                warnings.append(f"{column}: recognised text amounts are parsed; unparseable values are excluded from numeric aggregates.")
            default_label = f"{aggregation.replace('_', ' ')} of {column}"
        label = _safe_label(measure.get("label") or default_label, labels)
        select_parts.append(f"{AGGREGATIONS[aggregation].format(expr=expression)} AS {q(label)}")
        fields.append({"key": label, "kind": "measure", "table_id": table_id, "table_name": lookup[table_id]["table_name"], "column": column, "aggregation": aggregation})

    where_parts, parameters = [], []
    for condition in filters:
        table_id = _table_id(condition["table_id"])
        column = condition.get("column")
        profile = _column_profile(lookup[table_id], column)
        reference = _value_expression(table_id, profile)
        operator = str(condition.get("operator") or "=")
        value = condition.get("value")
        if operator in {"is_null", "not_null"}:
            where_parts.append(f"({reference}) IS {'NOT ' if operator == 'not_null' else ''}NULL")
        elif operator == "in":
            if not isinstance(value, list) or not value or len(value) > 1000:
                raise ModelError("An IN filter needs between 1 and 1,000 values.")
            where_parts.append(f"CAST(({reference}) AS VARCHAR) IN ({', '.join('?' for _ in value)})")
            parameters.extend(str(v) for v in value)
        elif operator == "contains":
            if value is None:
                raise ModelError("Provide text for the contains filter.")
            # Literal substring: %, _ and backslashes are not wildcards.
            where_parts.append(f"contains(lower(CAST(({reference}) AS VARCHAR)), lower(?))")
            parameters.append(str(value))
        elif operator in FILTER_OPERATORS:
            if value is None:
                raise ModelError("Use is_null or not_null to filter missing values.")
            where_parts.append(f"({reference}) {FILTER_OPERATORS[operator]} ?")
            parameters.append(value)
        else:
            raise ModelError(f"Unknown filter {operator}.")
    try:
        limit = max(1, min(int(spec.get("limit") or DEFAULT_QUERY_ROWS), MAX_QUERY_ROWS))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ModelError("The row limit must be an integer.") from exc
    order = spec.get("order_by") or {}
    order_parts = []
    if order.get("field"):
        if order["field"] not in {field["key"] for field in fields}:
            raise ModelError("The sort field is not in the query output.")
        direction = str(order.get("direction") or "desc").lower()
        if direction not in {"asc", "desc"}:
            raise ModelError("Sort direction must be asc or desc.")
        order_parts.append(f"{q(order['field'])} {direction.upper()} NULLS LAST")
    elif dimensions:
        time_field = next((field for field in fields if field["kind"] == "dimension" and _column_profile(lookup[field["table_id"]], field["column"]).get("semantic_role") == "time"), None)
        if time_field:
            order_parts.append(f"{q(time_field['key'])} ASC NULLS LAST")
        elif measures:
            first = next(field for field in fields if field["kind"] == "measure")
            order_parts.append(f"{q(first['key'])} DESC NULLS LAST")
        else:
            order_parts.extend(f"{q(field['key'])} ASC NULLS LAST" for field in fields)
    sql = (
        f"SELECT {', '.join(select_parts)}\nFROM {q(lookup[base_id]['physical_name'])} AS {_alias(base_id)}\n"
        + ("\n".join(joins) + "\n" if joins else "")
        + ("WHERE " + " AND ".join(where_parts) + "\n" if where_parts else "")
        + ("GROUP BY " + ", ".join(group_parts) + "\n" if group_parts else "")
        + ("ORDER BY " + ", ".join(order_parts) + "\n" if order_parts else "")
        + f"LIMIT {limit}"
    )
    return {"sql": sql, "parameters": parameters, "fields": fields, "base_table_id": base_id, "base_table_name": lookup[base_id]["table_name"], "joined_tables": [lookup[t]["table_name"] for t in sorted(joined) if t != base_id], "warnings": list(dict.fromkeys(warnings)), "limit": limit, "used_edges": used_edges, "sensitive": sensitive, "used_table_ids": sorted(joined)}


def run_query(project_id: int, tables, relationships, spec: Dict[str, Any]) -> Dict[str, Any]:
    compiled = build_query(tables, relationships, spec)
    lookup = _table_lookup(tables)
    with connect(project_id, read_only=True) as con:
        con.execute("BEGIN TRANSACTION")
        try:
            # Validate in the same read snapshot used by the query.
            for table_id in compiled["used_table_ids"]:
                table = lookup[table_id]
                if not table_exists(con, table["physical_name"]):
                    raise ModelError(f"{table['table_name']} is missing from project data.")
                schema = {c["name"]: c["type"] for c in describe(con, table["physical_name"])}
                for field in (table.get("profile") or {}).get("columns", []):
                    if field["name"] not in schema or schema[field["name"]] != field.get("physical_type"):
                        raise ModelError("A table schema changed after profiling. Re-profile it before querying.")
            if compiled["sensitive"]:
                for edge in compiled["used_edges"]:
                    parent = lookup[edge["to_table_id"]]
                    lp = _column_profile(lookup[edge["from_table_id"]], edge["from_column"])
                    rp = _column_profile(parent, edge["to_column"])
                    key = q(edge["to_column"])
                    if semantics.base_duck_type(lp.get("physical_type", "")) != semantics.base_duck_type(rp.get("physical_type", "")):
                        key = f"CAST({key} AS VARCHAR)"
                    duplicate = con.execute(f"SELECT 1 FROM {q(parent['physical_name'])} WHERE {q(edge['to_column'])} IS NOT NULL GROUP BY {key} HAVING count(*) > 1 LIMIT 1").fetchone()
                    if duplicate:
                        raise ModelError(f"{parent['table_name']}.{edge['to_column']} now contains duplicate keys. Refresh its relationships before aggregating across this join.")
            sql = compiled["sql"].rsplit("LIMIT ", 1)[0] + f"LIMIT {compiled['limit'] + 1}"
            rows = fetch_dicts(con, sql, compiled["parameters"])
            con.execute("COMMIT")
        except Exception as exc:
            con.execute("ROLLBACK")
            if isinstance(exc, duckdb.Error):
                raise ModelError(f"That query could not be run: {exc}") from exc
            raise
    truncated = len(rows) > compiled["limit"]
    return {"rows": rows[:compiled["limit"]], "row_count": min(len(rows), compiled["limit"]), "truncated": truncated, "fields": compiled["fields"], "sql": compiled["sql"], "warnings": compiled["warnings"], "base_table_name": compiled["base_table_name"], "joined_tables": compiled["joined_tables"]}


# ─── Suggested cross-table analyses ──────────────────────────────────────────


MONEY_WORDS = semantics._vocab(
    "revenue", "sales", "amount", "total", "profit", "cost", "price",
    "spend", "income", "expense", "payment", "value", "margin", "budget",
    "turnover", "gmv", "arr", "mrr",
)


def rank_measures(columns) -> List[Dict[str, Any]]:
    def rank(column):
        name = re.sub(r"([a-z])([A-Z])", r"\1_\2", column.get("name", ""))
        money = column.get("logical_type") == "currency" or bool(MONEY_WORDS.search(name))
        return (column.get("additivity") != "additive", not money, -float(column.get("confidence") or 0), name)
    return sorted([c for c in columns if c.get("semantic_role") == "measure" and c.get("logical_type") in semantics.NUMERIC_LOGICAL and c.get("additivity") != "semi_additive" and not c.get("is_empty") and not c.get("needs_review")], key=rank)


def _trend_dimension(table_id, column):
    """Keep short time series visible instead of collapsing them to one month."""
    dimension = {"table_id": table_id, "column": column["name"], "label": "Period"}
    if column.get("logical_type") in {"date", "datetime"}:
        from datetime import datetime
        stats = column.get("statistics") or {}
        try:
            start = datetime.fromisoformat(str(stats["min"]).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(stats["max"]).replace("Z", "+00:00"))
            days = (end - start).days
        except (KeyError, ValueError, TypeError):
            days = 0
        dimension["date_part"] = "day" if days <= 90 else "week" if days <= 730 else "month"
    return dimension


def suggest_analyses(tables, relationships) -> List[Dict[str, Any]]:
    """Build distinct business views, not repeated slices of one money field.

    Every spec is checked by the same compiler as user queries. Each source
    receives a bounded set of views; the UI can scope and filter those views.
    """
    graph = JoinGraph(relationships)
    lookup = _table_lookup(tables)
    suggestions = []

    def add(table, ident, title, chart, dimensions, measures, description, order=None, limit=60):
        spec = {"base_table_id": table["id"], "dimensions": dimensions,
                "measures": measures, "limit": limit}
        if order:
            spec["order_by"] = order
        try:
            build_query(tables, relationships, spec)
        except ModelError:
            return
        suggestions.append({"id": ident, "title": title, "description": description,
                            "chart": chart, "spec": spec})

    ranked_tables = sorted(tables, key=lambda t: (-len(rank_measures((t.get("profile") or {}).get("columns", []))), t["id"]))
    for table in ranked_tables:
        tid = table["id"]
        columns = (table.get("profile") or {}).get("columns", [])
        measures = rank_measures(columns)[:8]
        records = {"table_id": tid, "aggregation": "count", "label": "Records"}
        add(table, f"records-{tid}", f"{table['table_name']} records", "kpi", [], [records],
            "Count of source records, independent of monetary values.")

        identifiers = [c for c in columns if c.get("semantic_role") == "identifier"
                       and not c.get("is_empty") and not c.get("needs_review")]
        descriptors = [c for c in columns if c.get("semantic_role") in {"category", "dimension", "geographic", "boolean"}
                       and 1 < int(c.get("distinct_count") or 0) <= 60
                       and not c.get("needs_review") and not c.get("is_empty")]
        # Status and type are useful operational views even when location came first in the CSV.
        descriptors.sort(key=lambda c: (not bool(re.search(r"status|state|type|mode|method|category", c["name"], re.I)), c["name"]))
        descriptors = descriptors[:6]
        for col in identifiers[:2]:
            add(table, f"unique-{tid}-{col['name']}", f"Distinct {col['name']}", "kpi", [],
                [{"table_id": tid, "column": col["name"], "aggregation": "count_distinct"}],
                "Exact distinct non-NULL values calculated from stored data.")

        metric_specs = []
        for col in measures:
            agg = col.get("default_aggregation") or semantics.default_aggregation(
                "measure", col["logical_type"], col.get("additivity", "non_additive"))
            metric = {"table_id": tid, "column": col["name"], "aggregation": agg,
                      "label": f"{agg.title()} {col['name']}"}
            metric_specs.append(metric)
            add(table, f"metric-{tid}-{col['name']}", metric["label"], "kpi", [], [metric],
                "Sum of additive values." if agg == "sum" else "Unweighted summary of recorded values.")
        if measures:
            add(table, f"statistics-{tid}", "Measure summary", "table", [],
                [m for c in measures for m in (
                    {"table_id": tid, "column": c["name"], "aggregation": "avg", "label": f"Mean {c['name']}"},
                    {"table_id": tid, "column": c["name"], "aggregation": "min", "label": f"Minimum {c['name']}"},
                    {"table_id": tid, "column": c["name"], "aggregation": "max", "label": f"Maximum {c['name']}"})],
                "Mean, minimum and maximum for each eligible numeric field; NULL and invalid numeric values are excluded.")

        for col in descriptors:
            dim = {"table_id": tid, "column": col["name"], "label": col["name"]}
            ndv = int(col.get("distinct_count") or 0)
            chart = "pie" if ndv <= 6 else "treemap" if ndv <= 20 else "horizontal_bar"
            add(table, f"distribution-{tid}-{col['name']}", f"Records by {col['name']}", chart,
                [dim], [records], "Distribution of record counts, including missing values.")
            if col.get("semantic_role") == "geographic" or re.search(r"origin|destination|location|city|country|port", col["name"], re.I):
                add(table, f"places-{tid}-{col['name']}", f"Distinct {col['name']}", "kpi", [],
                    [{"table_id": tid, "column": col["name"], "aggregation": "count_distinct"}],
                    "Number of distinct non-NULL locations in this source.")

        times = [c for c in columns if c.get("semantic_role") == "time"
                 and not c.get("is_constant") and not c.get("needs_review")
                 and (c.get("logical_type") in {"date", "datetime"} or semantics.is_numeric_type(c.get("physical_type", "")))]
        for time in times[:2]:
            dim = _trend_dimension(tid, time)
            grain = dim.get("date_part", "source calendar values")
            add(table, f"activity-{tid}-{time['name']}", f"Record activity over {time['name']}", "area",
                [dim], [records], f"Record counts grouped by {grain}; missing periods are not assumed to be zero.",
                {"field": "Period", "direction": "asc"}, 2000)
            for metric in metric_specs[:3]:
                add(table, f"trend-{tid}-{time['name']}-{metric['column']}", f"{metric['label']} over {time['name']}", "line",
                    [dim], [metric], f"Chronological {grain} summaries of {metric['column']}.",
                    {"field": "Period", "direction": "asc"}, 2000)

        for col in descriptors[:2]:
            for metric in metric_specs[:3]:
                add(table, f"comparison-{tid}-{col['name']}-{metric['column']}",
                    f"{metric['label']} by {col['name']}", "horizontal_bar",
                    [{"table_id": tid, "column": col["name"]}], [metric],
                    "Ranked comparison of a measure across categories.")

        geographic = [c for c in columns if c in descriptors and (c.get("semantic_role") == "geographic"
                      or re.search(r"origin|destination|location|city|country|port", c["name"], re.I))]
        if len(geographic) >= 2:
            add(table, f"routes-{tid}", f"{geographic[0]['name']} × {geographic[1]['name']}", "table",
                [{"table_id": tid, "column": c["name"]} for c in geographic[:2]],
                [records] + metric_specs[:3], "Ranked location pairs and their record counts and measures.", limit=50)
        if len(measures) >= 2:
            grouping = (identifiers or descriptors)[:1]
            if grouping:
                add(table, f"relationship-{tid}", f"{measures[0]['name']} vs {measures[1]['name']}", "scatter",
                    [{"table_id": tid, "column": grouping[0]["name"]}],
                    [{"table_id": tid, "column": c["name"], "aggregation": "avg", "label": c["name"]} for c in measures[:2]],
                    f"Paired unweighted means per {grouping[0]['name']}; association does not establish causation.", limit=500)

        for other_id in sorted(graph.connected_to(tid) - {tid})[:4]:
            other = lookup.get(other_id)
            if not other:
                continue
            descriptors = [c for c in (other.get("profile") or {}).get("columns", [])
                           if c.get("semantic_role") in {"category", "dimension", "geographic"}
                           and 1 < int(c.get("distinct_count") or 0) <= 60 and not c.get("needs_review")]
            for col in descriptors[:2]:
                add(table, f"joined-{tid}-{other_id}-{col['name']}", f"Records by {other['table_name']}.{col['name']}",
                    "horizontal_bar", [{"table_id": other_id, "column": col["name"]}], [records],
                    "Uses a non-multiplying approved join path; unsafe joins are excluded.")
    return suggestions


def describe_model(tables, relationships) -> Dict[str, Any]:
    classification = classify_tables(tables, relationships)
    graph = JoinGraph(relationships)
    lookup = _table_lookup(tables)
    islands, unassigned = [], set(lookup)
    while unassigned:
        seed = min(unassigned)
        group = graph.connected_to(seed) & set(lookup)
        islands.append(sorted(lookup[i]["table_name"] for i in group))
        unassigned -= group
    suggestions = suggest_analyses(tables, relationships)
    return {
        "tables": [{"id": table["id"], "table_name": table["table_name"], "row_count": table.get("row_count"), **classification.get(table["id"], {})} for table in tables],
        "relationship_count": sum(r.get("status") == "approved" for r in relationships),
        "pending_count": sum(r.get("status") == "suggested" for r in relationships),
        "islands": islands, "is_connected": len(islands) <= 1,
        "suggestions": suggestions,
        "dashboard_plan": {"version": 1, "widgets": suggestions, "notes": ["Views use inferred field meanings. Review classifications in Model. Automatic coverage per source: up to 8 measures, 6 categories, 2 time fields and 4 linked tables; build additional views below."]},
    }
