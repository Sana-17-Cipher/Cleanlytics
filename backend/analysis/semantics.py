"""
CLEANYTICS - logical type and semantic role inference.

Two separate questions get answered here, and keeping them apart is what makes
the output trustworthy:

  1. What *is* this column physically?   -> logical_type  (integer, currency, date...)
  2. What does it *mean* for analysis?   -> semantic_role (measure, dimension, id...)

A column typed DOUBLE can be revenue (a measure you sum), a latitude (a
coordinate you never sum) or a store number (an identifier you count). Physical
type alone cannot separate those, so role inference weighs several independent
signals and keeps the reasons it used. Every field carries `reasons`, so the UI
can explain a classification instead of asking the user to trust it.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# ─── Name vocabularies ───────────────────────────────────────────────────────
#
# Word-boundary matching throughout. Substring matching is what makes naive
# profilers classify "Candidate_Name" as a measure because it contains "id",
# or "Discount_Code" as a measure because it contains "count".

def _vocab(*words: str) -> re.Pattern:
    joined = "|".join(words)
    return re.compile(rf"(?:^|[\s_\-.]){joined}(?:$|[\s_\-.])", re.IGNORECASE)


IDENTIFIER_WORDS = _vocab(
    "id", "ids", "key", "keys", "code", "codes", "no", "num", "number",
    "uuid", "guid", "sku", "isbn", "ean", "upc", "pk", "fk", "ref",
    "reference", "identifier", "account", "invoice", "order", "ticket",
)
IDENTIFIER_SUFFIX = re.compile(r"(_id|_key|_code|_no|_num|_uuid|_guid|_pk|_fk|id)$", re.IGNORECASE)

TIME_WORDS = _vocab(
    "date", "datetime", "timestamp", "time", "day", "week", "month",
    "quarter", "year", "period", "created", "updated", "modified",
    "ordered", "shipped", "delivered", "birth", "dob", "expiry", "expires",
    "start", "end", "since", "until",
)
TIME_SUFFIX = re.compile(r"(_at|_on|_date|_dt|_time|_ts)$", re.IGNORECASE)

GEO_WORDS = _vocab(
    "city", "cities", "state", "province", "country", "region", "district",
    "county", "territory", "zip", "zipcode", "postal", "postcode",
    "latitude", "lat", "longitude", "lon", "lng", "address", "street",
    "location", "site", "branch", "warehouse", "store",
)

MEASURE_WORDS = _vocab(
    "revenue", "sales", "amount", "total", "sum", "cost", "costs", "price",
    "profit", "margin", "quantity", "qty", "units", "volume", "count",
    "budget", "spend", "expense", "expenses", "income", "salary", "wage",
    "payment", "charge", "fee", "tax", "discount", "balance", "value",
    "weight", "height", "width", "length", "duration", "distance",
    "score", "rating", "rate", "ratio", "percent", "percentage", "pct",
    "hours", "minutes", "sessions", "clicks", "impressions", "views",
)

CATEGORY_WORDS = _vocab(
    "category", "categories", "type", "types", "status", "state", "segment",
    "group", "class", "tier", "level", "channel", "source", "medium",
    "method", "mode", "gender", "plan", "brand", "department", "team",
    "role", "stage", "priority", "severity", "flag", "label", "kind",
)

BOOLEAN_WORDS = re.compile(
    r"^(is|has|can|should|was|did|will|are|does)[_\s]", re.IGNORECASE
)

# Measures that must not be summed across rows. Summing a unit price or a
# percentage produces a number with no meaning, which is the single most common
# way an auto-generated dashboard lies to somebody.
NON_ADDITIVE_WORDS = _vocab(
    "price", "rate", "ratio", "percent", "percentage", "pct", "margin",
    "average", "avg", "mean", "median", "score", "rating", "index",
    "temperature", "latitude", "longitude", "lat", "lon", "lng",
    "age", "share", "weightage", "probability", "likelihood",
)

# Measures that sum across most dimensions but not across time (a stock level on
# Monday plus the same stock on Tuesday is not a meaningful figure).
SEMI_ADDITIVE_WORDS = _vocab(
    "balance", "inventory", "stock", "headcount", "capacity", "onhand",
    "backlog", "outstanding", "level", "position",
)

BOOLEAN_VALUES = {
    frozenset({"true", "false"}),
    frozenset({"t", "f"}),
    frozenset({"yes", "no"}),
    frozenset({"y", "n"}),
    frozenset({"1", "0"}),
    frozenset({"on", "off"}),
    frozenset({"active", "inactive"}),
    frozenset({"enabled", "disabled"}),
}

# ─── Logical types ───────────────────────────────────────────────────────────

NUMERIC_DUCK_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
    "FLOAT", "DOUBLE", "REAL",
}
INTEGER_DUCK_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
}
TEMPORAL_DUCK_TYPES = {"DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIME", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS"}

LogicalType = str  # integer | decimal | currency | percentage | date | datetime | time | boolean | text


def base_duck_type(duck_type: str) -> str:
    """Strip DECIMAL(x,y) and similar parameters down to the base type name."""
    return re.sub(r"\(.*\)$", "", (duck_type or "").upper()).strip()


def is_numeric_type(duck_type: str) -> bool:
    base = base_duck_type(duck_type)
    return base in NUMERIC_DUCK_TYPES or base.startswith("DECIMAL")


def is_temporal_type(duck_type: str) -> bool:
    return base_duck_type(duck_type) in TEMPORAL_DUCK_TYPES


def is_integer_type(duck_type: str) -> bool:
    return base_duck_type(duck_type) in INTEGER_DUCK_TYPES


def logical_type_for(
    duck_type: str,
    *,
    text_probe: Optional[Dict[str, Any]] = None,
    has_decimals: Optional[bool] = None,
) -> LogicalType:
    """
    Map a physical DuckDB type to the logical type used for analysis.

    `text_probe` carries the results of the profiler's pattern pass over a
    VARCHAR column (what fraction parses as a date, as currency, and so on), so
    text that is really a number or a date gets recognised as such.
    """
    base = base_duck_type(duck_type)

    if base == "BOOLEAN":
        return "boolean"
    if base == "DATE":
        return "date"
    if base == "TIME":
        return "time"
    if base in TEMPORAL_DUCK_TYPES:
        return "datetime"
    if base.startswith("DECIMAL"):
        return "decimal"
    if base in INTEGER_DUCK_TYPES:
        return "integer"
    if base in {"FLOAT", "DOUBLE", "REAL"}:
        return "decimal" if has_decimals is not False else "integer"

    probe = text_probe or {}
    # Thresholds are deliberately high: mislabelling a text column as a date
    # corrupts every downstream chart, whereas leaving it as text is merely
    # unhelpful. Better to under-claim and let the quality engine report the
    # column as a mixed-format problem instead.
    if probe.get("boolean_ratio", 0) >= 0.99:
        return "boolean"
    if probe.get("currency_ratio", 0) >= 0.90:
        return "currency"
    if probe.get("percentage_ratio", 0) >= 0.90:
        return "percentage"
    if probe.get("datetime_ratio", 0) >= 0.90:
        return "datetime"
    if probe.get("date_ratio", 0) >= 0.90:
        return "date"
    if probe.get("numeric_ratio", 0) >= 0.90:
        return "decimal" if probe.get("decimal_ratio", 0) > 0.05 else "integer"
    return "text"


# ─── Content subtypes ────────────────────────────────────────────────────────
#
# Independent of logical type. An email column is text, but knowing it holds
# email addresses changes both how it should be treated (never a grouping
# dimension) and what counts as an invalid value in it.

SUBTYPE_THRESHOLD = 0.60

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def detect_subtype(name: str, probe: Optional[Dict[str, Any]], sample_values: List[str]) -> Optional[str]:
    """
    Identify what a text column actually contains, when it is recognisable.

    Returns one of email, phone, url, uuid, postal_code, currency, percentage,
    or None. Used both for validity checks and to keep contact fields out of
    the dimension list.
    """
    probe = probe or {}
    ranked = [
        ("email", probe.get("email_ratio", 0.0)),
        ("phone", probe.get("phone_ratio", 0.0)),
        ("currency", probe.get("currency_ratio", 0.0)),
        ("percentage", probe.get("percentage_ratio", 0.0)),
    ]
    best, best_ratio = max(ranked, key=lambda kv: kv[1])
    if best_ratio >= SUBTYPE_THRESHOLD:
        return best

    if sample_values:
        checked = [v for v in sample_values if v]
        if checked and all(UUID_RE.match(v) for v in checked):
            return "uuid"
        if checked and all(v.lower().startswith(("http://", "https://", "www.")) for v in checked):
            return "url"

    if re.search(r"(?:^|[\s_\-.])(zip|zipcode|postal|postcode|pincode|pin)(?:$|[\s_\-.])", name or "", re.IGNORECASE):
        return "postal_code"
    return None


SUBTYPE_PROBE_KEY = {
    "email": "email_ratio",
    "phone": "phone_ratio",
    "currency": "currency_ratio",
    "percentage": "percentage_ratio",
}


NUMERIC_LOGICAL = {"integer", "decimal", "currency", "percentage"}
TEMPORAL_LOGICAL = {"date", "datetime", "time"}


# ─── Role inference ──────────────────────────────────────────────────────────


class RoleEvidence:
    """Accumulates weighted votes for each candidate role, with explanations."""

    def __init__(self) -> None:
        self.scores: Dict[str, float] = {}
        self.reasons: Dict[str, List[str]] = {}

    def vote(self, role: str, weight: float, reason: str) -> None:
        self.scores[role] = self.scores.get(role, 0.0) + weight
        self.reasons.setdefault(role, []).append(reason)

    def decide(self, fallback: str = "dimension") -> Tuple[str, float, List[str]]:
        if not self.scores:
            return fallback, 0.4, ["No strong signal; treated as a descriptive field."]

        ranked = sorted(self.scores.items(), key=lambda kv: -kv[1])
        winner, top = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0

        # Confidence reflects both how much evidence the winner has and how
        # clearly it beat the alternative. A column with two equally plausible
        # readings should report low confidence rather than a fake 0.9.
        strength = min(top / 3.0, 1.0)
        separation = 1.0 if top <= 0 else min(max((top - runner_up) / top, 0.0), 1.0)
        confidence = round(0.45 + 0.35 * strength + 0.20 * separation, 2)
        return winner, min(confidence, 0.99), self.reasons.get(winner, [])


def infer_role(
    name: str,
    logical_type: LogicalType,
    stats: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Decide what a column means for analysis.

    `stats` is the profiler's per-column output. Expected keys: row_count,
    non_null_count, distinct_count, null_count, is_unique, unique_ratio,
    avg_length, min_value, max_value, distinct_values (small samples only),
    has_decimals, has_negatives.
    """
    rows = max(int(stats.get("row_count") or 0), 1)
    non_null = int(stats.get("non_null_count") or 0)
    ndv = int(stats.get("distinct_count") or 0)
    unique_ratio = float(stats.get("unique_ratio") or 0.0)
    avg_length = float(stats.get("avg_length") or 0.0)
    has_decimals = bool(stats.get("has_decimals"))
    has_negatives = bool(stats.get("has_negatives"))
    sample_values = [str(v).strip().lower() for v in (stats.get("distinct_values") or [])]
    subtype = stats.get("subtype")

    ev = RoleEvidence()
    name_clean = (name or "").strip()

    name_is_id = bool(IDENTIFIER_WORDS.search(name_clean) or IDENTIFIER_SUFFIX.search(name_clean))
    name_is_time = bool(TIME_WORDS.search(name_clean) or TIME_SUFFIX.search(name_clean))
    name_is_geo = bool(GEO_WORDS.search(name_clean))
    name_is_measure = bool(MEASURE_WORDS.search(name_clean))
    name_is_category = bool(CATEGORY_WORDS.search(name_clean))
    name_is_boolean = bool(BOOLEAN_WORDS.search(name_clean))

    # ── Boolean ──────────────────────────────────────────────────────────────
    if logical_type == "boolean":
        ev.vote("boolean", 3.0, "Stored as a true/false type.")
    elif ndv <= 2 and non_null > 0:
        if frozenset(sample_values) in BOOLEAN_VALUES or (
            len(sample_values) <= 2 and set(sample_values) <= {"true", "false", "yes", "no", "y", "n", "1", "0"}
        ):
            ev.vote("boolean", 2.4, f"Only two values, both true/false style: {', '.join(sample_values) or 'n/a'}.")
    if name_is_boolean:
        ev.vote("boolean", 1.2, "Name starts with is/has/can, which normally marks a flag.")

    # ── Time ─────────────────────────────────────────────────────────────────
    if logical_type in TEMPORAL_LOGICAL:
        ev.vote("time", 3.0, f"Values parse as {logical_type} values.")
    if name_is_time:
        ev.vote("time", 1.4, "Name refers to a date or time.")
    # A four-digit integer column called "Year" is a time field, not a measure.
    if logical_type == "integer" and re.search(r"(?:^|[\s_\-.])(year|yr)(?:$|[\s_\-.])", name_clean, re.IGNORECASE):
        lo, hi = stats.get("min_value"), stats.get("max_value")
        try:
            if lo is not None and hi is not None and 1800 <= float(lo) and float(hi) <= 2200:
                ev.vote("time", 2.2, "Whole numbers in a plausible calendar-year range.")
        except (TypeError, ValueError):
            pass

    # ── Identifier ───────────────────────────────────────────────────────────
    # Uniqueness alone is not enough: in a 12-row lookup table every column is
    # unique. Require either a key-like name or enough distinct values that
    # uniqueness is actually informative.
    if name_is_id:
        ev.vote("identifier", 2.0, "Name follows a key naming convention.")
    if unique_ratio >= 0.99 and ndv >= 20:
        ev.vote("identifier", 2.0, f"Every row holds a distinct value across {ndv:,} rows.")
    elif unique_ratio >= 0.99 and ndv >= 5 and name_is_id:
        ev.vote("identifier", 1.2, "Values are distinct and the name looks like a key.")
    if logical_type == "text" and 0 < avg_length <= 24 and unique_ratio > 0.5 and not name_is_measure:
        ev.vote("identifier", 0.7, "Short, mostly distinct codes rather than prose.")
    # Sequence-like integers (1, 2, 3...) are row numbers, never measures.
    if logical_type == "integer" and unique_ratio >= 0.99 and not has_negatives and not name_is_measure:
        lo, hi = stats.get("min_value"), stats.get("max_value")
        try:
            if lo is not None and hi is not None and non_null > 1:
                spread = float(hi) - float(lo) + 1
                if 0 < spread <= non_null * 1.05:
                    ev.vote("identifier", 1.6, "Values form a dense running sequence, typical of a row key.")
        except (TypeError, ValueError):
            pass

    # ── Geographic ───────────────────────────────────────────────────────────
    if name_is_geo:
        weight = 2.2 if logical_type == "text" else 1.5
        ev.vote("geographic", weight, "Name refers to a place.")

    # ── Contact and reference subtypes ───────────────────────────────────────
    # An email or phone column identifies a person. Grouping a chart by it
    # produces one bar per row, so it must never land in the dimension list.
    if subtype in {"email", "phone", "uuid", "url"}:
        ev.vote("identifier", 2.6, f"Values are {subtype} values, which identify a record rather than group it.")
    elif subtype == "postal_code":
        ev.vote("geographic", 2.4, "Values look like postal codes.")
    elif subtype in {"currency", "percentage"}:
        ev.vote("measure", 2.4, f"Values are written as {subtype} amounts.")

    # ── Measure ──────────────────────────────────────────────────────────────
    if logical_type in NUMERIC_LOGICAL:
        if logical_type in {"currency", "percentage"}:
            ev.vote("measure", 2.6, f"Values are formatted as {logical_type}.")
        if name_is_measure:
            ev.vote("measure", 2.2, "Name matches a quantity that is normally aggregated.")
        if has_decimals:
            ev.vote("measure", 1.4, "Values carry decimals, so they are amounts rather than codes.")
        if has_negatives:
            ev.vote("measure", 0.8, "Negative values appear, which codes and keys do not have.")
        # A numeric column that is neither unique nor low-cardinality is most
        # usefully read as a quantity.
        if 0.02 < unique_ratio < 0.98 and ndv > 20:
            ev.vote("measure", 1.0, "Many repeated numeric values spread across a range.")
        if not name_is_id and not name_is_time:
            ev.vote("measure", 0.6, "Numeric column with no key or date naming.")

    # ── Category vs free text ────────────────────────────────────────────────
    if non_null > 0:
        density = ndv / non_null
        if name_is_category:
            ev.vote("category", 2.2, "Name describes a classification.")
        if ndv <= 1:
            ev.vote("constant", 3.0, "Every row holds the same value.")
        elif ndv <= 50 and density <= 0.5:
            ev.vote("category", 1.8, f"Only {ndv} distinct values repeat across {non_null:,} rows.")
        elif density <= 0.05:
            ev.vote("category", 1.5, f"Low variety: {ndv:,} distinct values in {non_null:,} rows.")
        elif logical_type == "text" and avg_length > 60:
            ev.vote("text", 2.0, f"Long free-form values, averaging {int(avg_length)} characters.")
        elif logical_type == "text" and density > 0.9 and avg_length > 24:
            ev.vote("text", 1.4, "Nearly every value is different and fairly long.")
        elif logical_type == "text":
            ev.vote("dimension", 1.2, "Text values with moderate variety, useful for grouping.")

    role, confidence, reasons = ev.decide()

    # A constant column is a data quality finding, not an analytical role.
    if role == "constant":
        role = "dimension"
        reasons = ["Only one distinct value, so this column cannot separate anything."]
        confidence = 0.9

    return {
        "semantic_role": role,
        "confidence": confidence,
        "reasons": reasons,
        "role_scores": {k: round(v, 2) for k, v in sorted(ev.scores.items(), key=lambda kv: -kv[1])},
    }


# ─── Aggregation behaviour ───────────────────────────────────────────────────


def additivity_for(name: str, logical_type: LogicalType, role: str) -> str:
    """
    Whether a measure can be summed.

    additive      - summing across any dimension is meaningful (revenue, units)
    semi_additive - summing across dimensions but not across time (stock levels)
    non_additive  - summing is never meaningful (unit price, rate, percentage)
    """
    if role != "measure":
        return "non_additive"
    name_clean = (name or "").strip()
    if logical_type == "percentage" or NON_ADDITIVE_WORDS.search(name_clean):
        return "non_additive"
    if SEMI_ADDITIVE_WORDS.search(name_clean):
        return "semi_additive"
    return "additive"


def default_aggregation(role: str, logical_type: LogicalType, additivity: str) -> str:
    """
    The aggregation the app should apply when nobody has chosen one.

    Defaulting every numeric column to SUM is the classic auto-BI mistake: it
    turns a column of unit prices into a meaningless six-figure total. Anything
    that cannot be summed defaults to AVG instead.
    """
    if role == "measure":
        return "sum" if additivity in {"additive", "semi_additive"} else "avg"
    if role == "identifier":
        return "count_distinct"
    return "count"


def suggested_chart(x_role: str, y_role: str, x_cardinality: int) -> Dict[str, Any]:
    """Pick a sensible chart for an (x, y) pairing, with the reason."""
    if x_role == "time" and y_role == "measure":
        return {"chart": "line", "reason": "A measure tracked over time reads best as a line."}
    if x_role in {"category", "dimension", "geographic"} and y_role == "measure":
        if x_cardinality <= 6:
            return {"chart": "bar", "reason": f"Comparing a measure across {x_cardinality} groups."}
        if x_cardinality <= 30:
            return {"chart": "bar", "reason": "Ranked bars handle this many groups clearly."}
        return {"chart": "bar", "reason": "Too many groups to show at once, so only the top ones are charted."}
    if x_role == "measure" and y_role == "measure":
        return {"chart": "scatter", "reason": "Two measures together show their relationship."}
    if x_role == "boolean":
        return {"chart": "bar", "reason": "A two-way split compares clearly as bars."}
    return {"chart": "bar", "reason": "Bars are a safe default for comparing values."}
