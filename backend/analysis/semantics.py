"""
CLEANYTICS — logical type and semantic role inference.

Classification is heuristic. Scores describe evidence, not calibrated
probabilities. This module labels values; it never converts or deletes them.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple


# ─── Name matching ───────────────────────────────────────────────────────────


def _normalise_name(name: str) -> str:
    """Normalise snake_case, camelCase, spaces and punctuation."""
    value = re.sub(
        r"([A-Z]+)([A-Z][a-z])",
        r"\1_\2",
        name or "",
    )
    value = re.sub(
        r"([a-z0-9])([A-Z])",
        r"\1_\2",
        value,
    )
    return re.sub(
        r"[\W_]+",
        "_",
        value,
        flags=re.UNICODE,
    ).strip("_").lower()


def _vocab(*words: str) -> re.Pattern:
    """Match complete words rather than substrings."""
    alternatives = "|".join(re.escape(word) for word in words)
    return re.compile(
        rf"(?:^|[\s_.-])(?:{alternatives})(?=$|[\s_.-])",
        re.IGNORECASE,
    )


IDENTIFIER_WORDS = _vocab(
    "id", "ids", "key", "keys", "code", "codes", "uuid", "guid",
    "sku", "isbn", "ean", "upc", "pk", "fk", "ref", "reference",
    "identifier",
)

IDENTIFIER_SUFFIX = re.compile(
    r"(?:^|_)(?:id|key|code|no|num|number|uuid|guid|pk|fk)$",
    re.IGNORECASE,
)

TIME_WORDS = _vocab(
    "date", "datetime", "timestamp", "time", "day", "week", "month",
    "quarter", "year", "yr", "period", "dob", "expiry", "expires",
)

TIME_SUFFIX = re.compile(
    r"_(?:at|on|date|dt|time|ts)$",
    re.IGNORECASE,
)

GEO_WORDS = _vocab(
    "city", "cities", "state", "province", "country", "region",
    "district", "county", "territory", "zip", "zipcode", "postal",
    "postcode", "pincode", "latitude", "lat", "longitude", "lon",
    "lng", "address", "street", "location", "branch", "warehouse",
    "store",
)

MEASURE_WORDS = _vocab(
    "revenue", "sales", "amount", "total", "sum", "cost", "costs",
    "price", "profit", "margin", "quantity", "qty", "units",
    "volume", "count", "budget", "spend", "expense", "expenses",
    "income", "salary", "wage", "payment", "charge", "fee", "tax",
    "discount", "balance", "value", "weight", "height", "width",
    "length", "duration", "distance", "age", "score", "rating",
    "rate", "ratio", "percent", "percentage", "pct", "hours",
    "minutes", "seconds", "sessions", "clicks", "impressions",
    "views", "inventory", "stock", "headcount", "capacity",
    "backlog", "temperature", "average", "avg", "mean", "median",
)

CATEGORY_WORDS = _vocab(
    "category", "categories", "type", "types", "status", "state",
    "segment", "group", "class", "tier", "level", "channel",
    "source", "medium", "method", "mode", "gender", "plan",
    "brand", "department", "team", "role", "stage", "priority",
    "severity", "flag", "label", "kind",
)

BOOLEAN_WORDS = re.compile(
    r"^(?:is|has|can|should|was|did|will|are|does)_",
    re.IGNORECASE,
)

NON_ADDITIVE_WORDS = _vocab(
    "price", "rate", "ratio", "percent", "percentage", "pct",
    "margin", "average", "avg", "mean", "median", "score",
    "rating", "index", "temperature", "latitude", "longitude",
    "lat", "lon", "lng", "age", "share", "weightage",
    "probability", "likelihood", "height", "width", "length",
    "weight", "duration", "distance",
)

SEMI_ADDITIVE_WORDS = _vocab(
    "balance", "inventory", "stock", "headcount", "capacity",
    "onhand", "backlog", "outstanding", "position",
)

BOOLEAN_VALUES = {
    frozenset(pair)
    for pair in (
        ("true", "false"),
        ("t", "f"),
        ("yes", "no"),
        ("y", "n"),
        ("1", "0"),
        ("on", "off"),
        ("active", "inactive"),
        ("enabled", "disabled"),
    )
}


# ─── Logical types ───────────────────────────────────────────────────────────


INTEGER_DUCK_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
}

NUMERIC_DUCK_TYPES = INTEGER_DUCK_TYPES | {
    "FLOAT", "DOUBLE", "REAL",
}

TEMPORAL_DUCK_TYPES = {
    "DATE",
    "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE",
    "TIMESTAMPTZ",
    "TIME",
    "TIME WITH TIME ZONE",
    "TIMETZ",
    "TIMESTAMP_S",
    "TIMESTAMP_MS",
    "TIMESTAMP_NS",
}

NUMERIC_LOGICAL = {
    "integer", "decimal", "currency", "percentage",
}

TEMPORAL_LOGICAL = {
    "date", "datetime", "time",
}

LogicalType = str


def base_duck_type(duck_type: str) -> str:
    """Remove type parameters while preserving array/type suffixes."""
    return re.sub(
        r"\([^()]*\)",
        "",
        (duck_type or "").upper(),
    ).strip()


def is_numeric_type(duck_type: str) -> bool:
    return base_duck_type(duck_type) in (
        NUMERIC_DUCK_TYPES | {"DECIMAL", "NUMERIC"}
    )


def is_temporal_type(duck_type: str) -> bool:
    return base_duck_type(duck_type) in TEMPORAL_DUCK_TYPES


def is_integer_type(duck_type: str) -> bool:
    return base_duck_type(duck_type) in INTEGER_DUCK_TYPES


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError, OverflowError):
        return default


def _ratio(probe: Dict[str, Any], key: str) -> float:
    return min(
        1.0,
        max(0.0, _number(probe.get(key))),
    )


def logical_type_for(
    duck_type: str,
    *,
    text_probe: Optional[Dict[str, Any]] = None,
    has_decimals: Optional[bool] = None,
) -> LogicalType:
    """Infer a logical type without changing the stored values."""
    base = base_duck_type(duck_type)

    if base == "BOOLEAN":
        return "boolean"

    if base == "DATE":
        return "date"

    if base in {"TIME", "TIME WITH TIME ZONE", "TIMETZ"}:
        return "time"

    if base in TEMPORAL_DUCK_TYPES:
        return "datetime"

    if base in {"DECIMAL", "NUMERIC"}:
        return "decimal"

    if base in INTEGER_DUCK_TYPES:
        return "integer"

    if base in {"FLOAT", "DOUBLE", "REAL"}:
        return "integer" if has_decimals is False else "decimal"

    if base not in {"VARCHAR", "TEXT", "CHAR", "BPCHAR", "STRING"}:
        return "text"

    probe = text_probe or {}

    # Require strong evidence before labelling stored text as another type.
    for key, logical in (
        ("boolean_ratio", "boolean"),
        ("currency_ratio", "currency"),
        ("percentage_ratio", "percentage"),
        ("datetime_ratio", "datetime"),
        ("date_ratio", "date"),
    ):
        if _ratio(probe, key) >= 0.98:
            return logical

    if _ratio(probe, "numeric_ratio") >= 0.98:
        return (
            "decimal"
            if _ratio(probe, "decimal_ratio") > 0
            else "integer"
        )

    return "text"


# ─── Content subtypes ─────────────────────────────────────────────────────────


SUBTYPE_THRESHOLD = 0.90

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

SUBTYPE_PROBE_KEY = {
    "email": "email_ratio",
    "phone": "phone_ratio",
    "currency": "currency_ratio",
    "percentage": "percentage_ratio",
}


def detect_subtype(
    name: str,
    probe: Optional[Dict[str, Any]],
    sample_values: List[str],
) -> Optional[str]:
    name = _normalise_name(name)
    probe = probe or {}

    checked = [
        str(value).strip()
        for value in (sample_values or [])
        if value is not None and str(value).strip()
    ]

    if (
        _vocab(
            "zip", "zipcode", "postal", "postcode", "pincode",
        ).search(name)
        or name == "pin_code"
    ):
        return "postal_code"

    if checked and all(UUID_RE.fullmatch(value) for value in checked):
        return "uuid"

    if checked and all(
        re.match(
            r"^(?:https?://|www\.)\S+$",
            value,
            re.IGNORECASE,
        )
        for value in checked
    ):
        return "url"

    if _ratio(probe, "email_ratio") >= SUBTYPE_THRESHOLD:
        return "email"

    # Long account numbers can also match phone patterns.
    # Require a contact-related name before assigning this subtype.
    if _vocab(
        "phone", "telephone", "mobile", "tel", "fax",
    ).search(name):
        if _ratio(probe, "phone_ratio") >= SUBTYPE_THRESHOLD:
            return "phone"

    for subtype in ("currency", "percentage"):
        if _ratio(probe, f"{subtype}_ratio") >= SUBTYPE_THRESHOLD:
            return subtype

    return None


# ─── Role evidence ───────────────────────────────────────────────────────────


class RoleEvidence:
    """Accumulate evidence and retain human-readable reasons."""

    def __init__(self) -> None:
        self.scores: Dict[str, float] = {}
        self.reasons: Dict[str, List[str]] = {}

    def vote(self, role: str, weight: float, reason: str) -> None:
        self.scores[role] = self.scores.get(role, 0.0) + weight
        self.reasons.setdefault(role, []).append(reason)

    def decide(
        self,
        fallback: str = "dimension",
    ) -> Tuple[str, float, List[str]]:
        if not self.scores:
            return (
                fallback,
                0.30,
                ["Insufficient evidence; review this classification."],
            )

        ranked = sorted(
            self.scores.items(),
            key=lambda item: -item[1],
        )
        winner, top = ranked[0]
        runner = ranked[1][1] if len(ranked) > 1 else 0.0

        strength = min(top / 5.0, 1.0)
        separation = (
            max(0.0, (top - runner) / top)
            if top > 0 else 0.0
        )
        confidence = round(
            min(
                0.95,
                0.30 + 0.30 * strength + 0.35 * separation,
            ),
            2,
        )

        reasons = list(self.reasons[winner])

        if runner and separation < 0.25:
            reasons.append(
                f"Also resembles {ranked[1][0]}; "
                "review before using automatically."
            )

        return winner, confidence, reasons


# ─── Role inference ──────────────────────────────────────────────────────────


def infer_role(
    name: str,
    logical_type: LogicalType,
    stats: Dict[str, Any],
) -> Dict[str, Any]:
    name = _normalise_name(name)

    non_null = max(
        0,
        int(_number(stats.get("non_null_count"))),
    )
    ndv = max(
        0,
        int(_number(stats.get("distinct_count"))),
    )
    unique = min(
        1.0,
        max(
            0.0,
            _number(
                stats.get("unique_ratio"),
                ndv / non_null if non_null else 0,
            ),
        ),
    )
    avg_length = _number(stats.get("avg_length"))

    samples = {
        str(value).strip().lower()
        for value in (stats.get("distinct_values") or [])
        if value is not None and str(value).strip()
    }

    subtype = stats.get("subtype")
    numeric = logical_type in NUMERIC_LOGICAL
    ev = RoleEvidence()

    key = bool(
        IDENTIFIER_SUFFIX.search(name)
        or IDENTIFIER_WORDS.search(name)
    )
    key = key or name in {
        "id", "order", "invoice", "ticket", "account",
    }

    measure = bool(MEASURE_WORDS.search(name))
    category = bool(CATEGORY_WORDS.search(name))
    geo = bool(GEO_WORDS.search(name))

    # OrderState represents workflow rather than a geographic state.
    if (
        name.endswith("_state")
        and _vocab(
            "order", "payment", "process", "workflow", "job", "task",
        ).search(name)
    ):
        geo = False

    # StoreSales is a quantity associated with a place.
    if measure:
        geo = False

    time = bool(
        TIME_WORDS.search(name)
        or TIME_SUFFIX.search(name)
    )
    flag = bool(BOOLEAN_WORDS.search(name))

    if non_null == 0:
        return {
            "semantic_role": "dimension",
            "confidence": 0.20,
            "reasons": [
                "No non-null values are available; "
                "classification needs data."
            ],
            "role_scores": {},
        }

    contact = bool(
        _vocab(
            "email", "phone", "telephone", "mobile",
            "fax", "url", "website",
        ).search(name)
    )

    if contact and not measure:
        ev.vote(
            "identifier",
            6.0,
            "Name describes a contact or web reference; "
            "avoid numeric aggregation.",
        )

    if key:
        ev.vote(
            "identifier",
            6.0,
            "Name contains an explicit key or reference marker.",
        )

    if subtype in {"email", "phone", "uuid", "url"}:
        ev.vote(
            "identifier",
            6.0,
            f"Content resembles {subtype}; "
            "avoid using it as a chart grouping.",
        )

    if subtype == "postal_code":
        geo = True
        ev.vote(
            "geographic",
            7.0,
            "Postal codes describe locations and must not be summed.",
        )
    elif geo and not key:
        ev.vote(
            "geographic",
            5.0,
            "Name describes a place or coordinate.",
        )

    # Empty samples must never count as evidence of a boolean column.
    if logical_type == "boolean" and not key:
        ev.vote(
            "boolean",
            6.0,
            "Logical type is true/false.",
        )
    elif (
        0 < ndv <= 2
        and samples
        and len(samples) == ndv
        and not key
        and not measure
    ):
        if any(samples <= pair for pair in BOOLEAN_VALUES):
            ev.vote(
                "boolean",
                5.5,
                "Observed distinct values use a true/false convention.",
            )

    if flag:
        ev.vote(
            "boolean",
            1.5,
            "Name uses a flag prefix such as is, has or can.",
        )

    if logical_type in TEMPORAL_LOGICAL:
        ev.vote(
            "time",
            5.0,
            "Logical type represents dates or times.",
        )
    elif time and not key and not measure:
        ev.vote(
            "time",
            2.2,
            "Name describes a calendar field or timestamp.",
        )

        if logical_type == "integer":
            lo = _number(
                stats.get("min_value"),
                float("nan"),
            )
            hi = _number(
                stats.get("max_value"),
                float("nan"),
            )

            bounds = None

            if _vocab("year", "yr").search(name):
                bounds = (1800, 2200)
            elif _vocab("month").search(name):
                bounds = (1, 12)
            elif _vocab("quarter").search(name):
                bounds = (1, 4)
            elif _vocab("day").search(name):
                bounds = (1, 31)
            elif _vocab("week").search(name):
                bounds = (1, 53)

            if bounds and bounds[0] <= lo <= hi <= bounds[1]:
                ev.vote(
                    "time",
                    2.5,
                    "Whole numbers fall within the named calendar range.",
                )

    if numeric and not key and not geo:
        if measure:
            ev.vote(
                "measure",
                3.8,
                "Name describes a quantity or measurement.",
            )

        if logical_type in {"currency", "percentage"}:
            ev.vote(
                "measure",
                4.0,
                f"Values are formatted as {logical_type}.",
            )

        if not time and not category:
            ev.vote(
                "measure",
                0.7,
                "Numeric values may represent a quantity.",
            )

            if stats.get("has_decimals"):
                ev.vote(
                    "measure",
                    1.0,
                    "Fractional values support a measurement interpretation.",
                )

            if stats.get("has_negatives"):
                ev.vote(
                    "measure",
                    0.5,
                    "Signed values support a measurement interpretation.",
                )

        # Uniqueness alone does not make a measurement an identifier.
        if (
            logical_type == "integer"
            and not (measure or time or category)
        ):
            lo = _number(
                stats.get("min_value"),
                float("nan"),
            )
            hi = _number(
                stats.get("max_value"),
                float("nan"),
            )

            if (
                non_null >= 20
                and unique >= 0.99
                and lo >= 0
                and 0 < hi - lo + 1 <= non_null * 1.05
            ):
                ev.vote(
                    "identifier",
                    2.5,
                    "Distinct integers form a dense sequence, "
                    "suggesting a row key.",
                )

    if category and not (key or geo):
        ev.vote(
            "category",
            3.2,
            "Name describes a classification or group.",
        )

    if not (key or geo or measure or time):
        if 1 < ndv <= 50 and ndv / non_null <= 0.5:
            ev.vote(
                "category",
                1.8,
                "A small set of values repeats across rows.",
            )
        elif logical_type == "text" and avg_length > 60:
            ev.vote(
                "text",
                3.0,
                "Long values suggest free-form descriptions.",
            )
        elif logical_type == "text":
            ev.vote(
                "dimension",
                1.5,
                "Descriptive text can label or group records.",
            )

    role, confidence, reasons = ev.decide()

    # Keep the inferred role, but explain the current lack of variation.
    if ndv == 1:
        reasons.append(
            "Only one distinct value is present; "
            "this field cannot currently split a chart."
        )
        confidence = min(confidence, 0.70)

    return {
        "semantic_role": role,
        "confidence": confidence,
        "reasons": reasons,
        "role_scores": {
            role_name: round(score, 2)
            for role_name, score in sorted(
                ev.scores.items(),
                key=lambda item: -item[1],
            )
        },
    }


# ─── Aggregation behaviour ───────────────────────────────────────────────────


def additivity_for(
    name: str,
    logical_type: LogicalType,
    role: str,
) -> str:
    if role != "measure":
        return "non_additive"

    name = _normalise_name(name)

    if (
        logical_type == "percentage"
        or NON_ADDITIVE_WORDS.search(name)
    ):
        return "non_additive"

    if (
        SEMI_ADDITIVE_WORDS.search(name)
        or "on_hand" in name
    ):
        return "semi_additive"

    return "additive"


def default_aggregation(
    role: str,
    logical_type: LogicalType,
    additivity: str,
) -> str:
    if role == "measure":
        # AVG is a provisional summary for snapshots.
        # Closing balances and weighted rates need queries that account
        # for time, grain and denominators.
        return "sum" if additivity == "additive" else "avg"

    if role == "identifier":
        return "count_distinct"

    return "count"


# ─── Chart suggestions ───────────────────────────────────────────────────────


def suggested_chart(
    x_role: str,
    y_role: str,
    x_cardinality: int,
) -> Dict[str, Any]:
    if x_role == "time" and y_role == "measure":
        return {
            "chart": "line",
            "reason": (
                "A measure over time can show a trend; "
                "sort by time first."
            ),
        }

    if x_role == "measure" and y_role == "measure":
        return {
            "chart": "scatter",
            "reason": "Compare paired observations of two measures.",
        }

    if x_role == "boolean":
        return {
            "chart": "bar",
            "reason": "Compare the observed flag values as bars.",
        }

    if x_cardinality > 30:
        return {
            "chart": "bar",
            "reason": (
                "Many groups: apply a top-N limit "
                "and disclose omitted groups."
            ),
        }

    return {
        "chart": "bar",
        "reason": "Bars compare values across the available groups.",
    }