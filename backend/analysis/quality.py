"""
CLEANYTICS - data quality findings.

Findings are derived from the profile, so detecting them costs no extra scans.

The important design rule: a finding never describes a fix in prose. It carries
the operation that would run, by name and parameters, and the UI renders its
label from that. This is what stops a card reading "fill the gaps with the
median" from quietly deleting rows, which is what the previous version did.

Where more than one repair is defensible - and for missing data it always is -
every option is offered with its consequence spelled out, and nothing is chosen
on the user's behalf.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Findings above this share of the table are treated as structural rather than
# incidental, and get escalated.
HIGH_SEVERITY_RATIO = 0.20
MEDIUM_SEVERITY_RATIO = 0.05


def _severity(ratio: float) -> str:
    if ratio >= HIGH_SEVERITY_RATIO:
        return "high"
    if ratio >= MEDIUM_SEVERITY_RATIO:
        return "medium"
    return "low"


def _count(n: int, singular: str, plural: Optional[str] = None) -> str:
    """Format a count with the right noun, so findings never read '1 values'."""
    return f"{n:,} {singular if n == 1 else (plural or singular + 's')}"


def _action(
    operation: str,
    params: Dict[str, Any],
    label: str,
    consequence: str,
    destructive: bool = False,
    recommended: bool = False,
) -> Dict[str, Any]:
    """
    One repair the user can choose.

    `consequence` states plainly what happens to the data. Every destructive
    action says how much it removes, because that is the thing a person needs
    to know before pressing the button.
    """
    return {
        "operation": operation,
        "params": params,
        "label": label,
        "consequence": consequence,
        "destructive": destructive,
        "recommended": recommended,
    }


def detect(profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Turn a profile into an ordered list of quality findings."""
    summary = profile.get("summary") or {}
    columns = profile.get("columns") or []
    rows = int(summary.get("rows") or 0)
    findings: List[Dict[str, Any]] = []
    counter = 0

    def add(finding: Dict[str, Any]) -> None:
        nonlocal counter
        finding["id"] = f"q{counter:03d}"
        counter += 1
        findings.append(finding)

    # ── Duplicate rows ───────────────────────────────────────────────────────
    duplicates = summary.get("duplicate_rows")
    if duplicates:
        ratio = duplicates / max(rows, 1)
        add(
            {
                "type": "duplicate_rows",
                "severity": _severity(ratio),
                "column": None,
                "affected_rows": duplicates,
                "title": "Duplicate rows",
                "detail": f"{_count(duplicates, 'row')} are exact copies of another row ({ratio:.1%} of the table).",
                "why": "Duplicates inflate every total and average computed from this table.",
                "confidence": 1.0,
                "actions": [
                    _action(
                        "drop_duplicate_rows",
                        {},
                        "Keep one copy of each row",
                        f"Deletes {_count(duplicates, 'row')} and keeps the first occurrence of each.",
                        destructive=True,
                        recommended=True,
                    )
                ],
            }
        )

    for column in columns:
        name = column["name"]
        role = column.get("semantic_role")
        logical = column.get("logical_type")
        stats = column.get("statistics") or {}
        non_null = int(column.get("non_null_count") or 0)

        # ── Entirely empty column ────────────────────────────────────────────
        if column.get("is_empty"):
            add(
                {
                    "type": "empty_column",
                    "severity": "medium",
                    "column": name,
                    "affected_rows": rows,
                    "title": f'"{name}" is empty',
                    "detail": "Every row in this column is blank.",
                    "why": "An empty column cannot contribute to any analysis and clutters every field picker.",
                    "confidence": 1.0,
                    "actions": [
                        _action(
                            "drop_column",
                            {"column": name},
                            "Remove this column",
                            "Deletes the column. Nothing else changes.",
                            destructive=True,
                            recommended=True,
                        )
                    ],
                }
            )
            continue

        # ── Constant column ──────────────────────────────────────────────────
        if column.get("is_constant") and rows > 5:
            only = (column.get("top_values") or [{}])[0].get("value")
            add(
                {
                    "type": "constant_column",
                    "severity": "low",
                    "column": name,
                    "affected_rows": rows,
                    "title": f'"{name}" never changes',
                    "detail": f'Every row holds the same value ({only}).',
                    "why": "A column with one value cannot group, filter or explain anything.",
                    "confidence": 1.0,
                    "actions": [
                        _action(
                            "drop_column",
                            {"column": name},
                            "Remove this column",
                            "Deletes the column. Nothing else changes.",
                            destructive=True,
                        )
                    ],
                }
            )

        # ── Missing values ───────────────────────────────────────────────────
        null_count = int(column.get("null_count") or 0)
        if null_count:
            ratio = float(column.get("null_ratio") or 0)
            actions: List[Dict[str, Any]] = []

            # For a numeric measure, filling preserves the row; the median is
            # the safer of the two averages because it is unmoved by outliers.
            if role == "measure" and logical in {"integer", "decimal", "currency", "percentage"}:
                median = stats.get("median")
                mean = stats.get("mean")
                actions.append(
                    _action(
                        "fill_missing",
                        {"column": name, "strategy": "median"},
                        "Fill with the median",
                        f"Sets {_count(null_count, 'blank value')} to {median}. No rows are removed.",
                        recommended=ratio < HIGH_SEVERITY_RATIO,
                    )
                )
                actions.append(
                    _action(
                        "fill_missing",
                        {"column": name, "strategy": "mean"},
                        "Fill with the average",
                        f"Sets {_count(null_count, 'blank value')} to {mean}. Outliers pull this figure around.",
                    )
                )
            elif role in {"category", "dimension", "geographic", "boolean"}:
                common = (column.get("top_values") or [{}])[0].get("value")
                actions.append(
                    _action(
                        "fill_missing",
                        {"column": name, "strategy": "constant", "value": "Unknown"},
                        'Label them "Unknown"',
                        f'Sets {_count(null_count, "blank value")} to "Unknown", keeping the rows in every count.',
                        recommended=True,
                    )
                )
                if common:
                    actions.append(
                        _action(
                            "fill_missing",
                            {"column": name, "strategy": "mode"},
                            "Fill with the most common value",
                            f'Sets {_count(null_count, "blank value")} to "{common}". This invents data, so use it only when that is genuinely the default.',
                        )
                    )

            actions.append(
                _action(
                    "drop_missing_rows",
                    {"column": name},
                    "Delete these rows",
                    f"Permanently removes {_count(null_count, 'row')} ({ratio:.1%} of the table), including whatever those rows held in every other column.",
                    destructive=True,
                    recommended=role == "identifier" and ratio < MEDIUM_SEVERITY_RATIO,
                )
            )

            why = "Missing values are silently skipped by most calculations, which quietly changes every total and average."
            if role == "identifier":
                why = "Rows without an identifier cannot be linked to any other table, so they drop out of every join."

            add(
                {
                    "type": "missing_values",
                    "severity": _severity(ratio),
                    "column": name,
                    "affected_rows": null_count,
                    "title": f'"{name}" has gaps',
                    "detail": f"{null_count:,} of {rows:,} rows ({ratio:.1%}) have no value.",
                    "why": why,
                    "confidence": 1.0,
                    "actions": actions,
                }
            )

        # ── Values that do not match the column's shape ──────────────────────
        invalid = int(column.get("invalid_count") or 0)
        if invalid:
            ratio = invalid / max(non_null, 1)
            subtype = column.get("subtype")
            if role == "time" and logical == "text":
                title = f'"{name}" mixes date formats'
                detail = f"{invalid:,} of {non_null:,} values are written differently from the rest, so the column is being treated as text."
                why = "While this stays text, every chart sorts these values alphabetically instead of chronologically."
                actions = [
                    _action(
                        "convert_type",
                        {"column": name, "target": "date"},
                        "Read them all as dates",
                        f"Converts the column to a real date. Values that still cannot be read become blank, and the count is reported.",
                        recommended=True,
                    )
                ]
            elif role == "measure" and logical == "text":
                title = f'"{name}" is stored as text'
                detail = f"{invalid:,} of {non_null:,} values are not valid numbers, which is why the whole column is text."
                why = "A numeric column stored as text cannot be summed, averaged or plotted on a value axis."
                actions = [
                    _action(
                        "convert_type",
                        {"column": name, "target": "number"},
                        "Read them all as numbers",
                        "Converts the column to a number. Anything unreadable becomes blank, and the count is reported.",
                        recommended=True,
                    )
                ]
            elif subtype:
                readable = {"email": "email addresses", "phone": "phone numbers", "currency": "currency amounts", "percentage": "percentages"}.get(subtype, subtype)
                title = f'"{name}" has malformed {readable}'
                detail = f"{invalid:,} of {non_null:,} values do not look like valid {readable}."
                why = "Malformed contact details fail silently at the point you try to use them."
                actions = []
            else:
                continue

            add(
                {
                    "type": "invalid_values",
                    "severity": _severity(ratio),
                    "column": name,
                    "affected_rows": invalid,
                    "title": title,
                    "detail": detail,
                    "why": why,
                    "confidence": 0.9,
                    "actions": actions,
                }
            )

        # ── Padding ──────────────────────────────────────────────────────────
        whitespace = int(stats.get("whitespace_count") or 0)
        if whitespace:
            add(
                {
                    "type": "whitespace",
                    "severity": "low",
                    "column": name,
                    "affected_rows": whitespace,
                    "title": f'"{name}" has padded values',
                    "detail": f"{_count(whitespace, 'value')} have spaces at the start or end.",
                    "why": '"Delhi" and "Delhi " count as two different groups in every chart and never match in a join.',
                    "confidence": 1.0,
                    "actions": [
                        _action(
                            "trim_whitespace",
                            {"column": name},
                            "Trim the spaces",
                            f"Removes surrounding spaces from {_count(whitespace, 'value')}. No rows are removed and no other text changes.",
                            recommended=True,
                        )
                    ],
                }
            )

        # ── Case variants ────────────────────────────────────────────────────
        variants = int(stats.get("case_variant_count") or 0)
        if variants:
            examples = _variant_examples(column)
            add(
                {
                    "type": "inconsistent_case",
                    "severity": "medium",
                    "column": name,
                    "affected_rows": variants,
                    "title": f'"{name}" spells the same value several ways',
                    "detail": (
                        (
                            f"{variants:,} value is written two ways that differ only by capitalisation or spacing"
                            if variants == 1
                            else f"{variants:,} values are written several ways that differ only by capitalisation or spacing"
                        )
                        + (f", for example {examples}." if examples else ".")
                    ),
                    "why": "Each spelling becomes its own bar, slice and group, splitting one real category into several.",
                    "confidence": 0.95,
                    "actions": [
                        _action(
                            "normalize_case",
                            {"column": name},
                            "Merge them to the most common spelling",
                            "Each set of variants adopts whichever spelling appears most often, so acronyms like USA are preserved. No rows are removed.",
                            recommended=True,
                        )
                    ],
                }
            )

        # ── Empty strings masquerading as values ─────────────────────────────
        blanks = int(stats.get("blank_count") or 0)
        if blanks:
            add(
                {
                    "type": "blank_strings",
                    "severity": "low",
                    "column": name,
                    "affected_rows": blanks,
                    "title": f'"{name}" has empty text',
                    "detail": f'{_count(blanks, "value")} are an empty string rather than a proper blank.',
                    "why": "Empty text counts as a real value, so completeness looks better than it is and an empty group appears in charts.",
                    "confidence": 1.0,
                    "actions": [
                        _action(
                            "blanks_to_null",
                            {"column": name},
                            "Treat them as missing",
                            f"Marks {_count(blanks, 'empty entry', 'empty entries')} as missing. No rows are removed.",
                            recommended=True,
                        )
                    ],
                }
            )

        # ── Outliers ─────────────────────────────────────────────────────────
        low, high = stats.get("outlier_low"), stats.get("outlier_high")
        if role == "measure" and low is not None and high is not None and non_null > 20:
            minimum, maximum = stats.get("min"), stats.get("max")
            if (minimum is not None and minimum < low) or (maximum is not None and maximum > high):
                add(
                    {
                        "type": "outliers",
                        "severity": "low",
                        "column": name,
                        "affected_rows": 0,
                        "title": f'"{name}" has extreme values',
                        "detail": (
                            f"Values range from {minimum} to {maximum}, while the middle half sits between "
                            f"{stats.get('q1')} and {stats.get('q3')}."
                        ),
                        "why": "Extreme values pull averages and trend lines toward themselves. They are often genuine, so this is worth a look rather than an automatic fix.",
                        "confidence": 0.7,
                        "actions": [
                            _action(
                                "remove_outliers",
                                {"column": name},
                                "Delete rows outside the normal range",
                                f"Permanently removes every row where {name} falls outside {round(low, 2)} to {round(high, 2)}. Only do this if you know the extremes are errors.",
                                destructive=True,
                            )
                        ],
                    }
                )

        # ── A key that was probably meant to be unique but is not ────────────
        #
        # Only near-unique columns are worth reporting. A customer id repeating
        # across a table of orders is the whole point of a foreign key, and an
        # email repeating across a customer's orders is equally normal. What
        # actually signals a problem is a column that is 90-99% unique: that
        # pattern says "this was intended as the key and a few rows slipped
        # through", which is exactly the thing that silently multiplies rows on
        # a join.
        if role == "identifier" and non_null > 0 and not column.get("distinct_is_approximate"):
            distinct = int(column.get("distinct_count") or 0)
            repeated = non_null - distinct
            unique_ratio = float(column.get("unique_ratio") or 0)
            contact_field = column.get("subtype") in {"email", "phone", "url"}

            if repeated > 0 and distinct > 1 and unique_ratio >= 0.90 and not contact_field:
                add(
                    {
                        "type": "duplicate_identifier",
                        "severity": "high",
                        "column": name,
                        "affected_rows": repeated,
                        "title": f'"{name}" is almost unique, but not quite',
                        "detail": (
                            f"{distinct:,} distinct values across {non_null:,} rows, so "
                            f"{_count(repeated, 'row')} share an identifier with another row."
                        ),
                        "why": "This column looks like it was meant to be the table's key. The repeats will multiply rows on any join built from it and inflate every total that comes out.",
                        "confidence": 0.85,
                        "actions": [
                            _action(
                                "drop_duplicate_rows",
                                {"columns": [name]},
                                f'Keep one row per "{name}"',
                                f"Deletes {_count(repeated, 'row')}, keeping the first row for each value.",
                                destructive=True,
                            )
                        ],
                    }
                )

    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order.get(f["severity"], 3), -int(f.get("affected_rows") or 0)))
    return findings


def _variant_examples(column: Dict[str, Any]) -> Optional[str]:
    """Find two top values that differ only by case or padding, to show the user."""
    values = [str(v.get("value")) for v in (column.get("top_values") or []) if v.get("value") is not None]
    seen: Dict[str, str] = {}
    for value in values:
        folded = value.strip().lower()
        if folded in seen and seen[folded] != value:
            return f'"{seen[folded]}" and "{value}"'
        seen[folded] = value
    return None


def summarise(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counts used for badges, so the UI never recounts and disagrees."""
    return {
        "total": len(findings),
        "high": sum(1 for f in findings if f["severity"] == "high"),
        "medium": sum(1 for f in findings if f["severity"] == "medium"),
        "low": sum(1 for f in findings if f["severity"] == "low"),
        "safe_fixes": sum(
            1 for f in findings if any(a["recommended"] and not a["destructive"] for a in f.get("actions", []))
        ),
    }
