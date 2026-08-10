"""
CLEANYTICS — Relationship Detection Engine
Detects candidate FK→PK relationships between DataTables using:
  - Column name matching (30%)
  - Uniqueness analysis (25%)
  - Value overlap / Jaccard similarity (20%)
  - Type compatibility (15%)
  - Cardinality ratio (10%)
"""

import pandas as pd
import numpy as np
import re
from typing import Dict, Any, List, Tuple, Optional


# ─── Column-name similarity patterns ────────────────────────────────────────

# Patterns that indicate an ID/key column
ID_SUFFIX = re.compile(r'([-_]?id|[-_]?key|[-_]?code|[-_]?pk|[-_]?fk)$', re.IGNORECASE)


def _normalize_col_name(name: str) -> str:
    """Normalize a column name for fuzzy matching."""
    return re.sub(r'[\s_\-]+', '_', name.strip()).lower()


def _name_similarity(col_a: str, col_b: str) -> float:
    """Score how similar two column names are (0..1)."""
    norm_a = _normalize_col_name(col_a)
    norm_b = _normalize_col_name(col_b)

    # Exact match
    if norm_a == norm_b:
        return 1.0

    # One contains the other (e.g. "customer_id" vs "cust_id")
    if norm_a in norm_b or norm_b in norm_a:
        return 0.7

    # Strip ID suffix and compare base (e.g. "Customer_ID" base = "customer")
    base_a = ID_SUFFIX.sub('', norm_a).rstrip('_')
    base_b = ID_SUFFIX.sub('', norm_b).rstrip('_')

    if base_a and base_b and base_a == base_b:
        return 0.85

    # Check if base of one matches the table-context of the other
    if base_a and base_b:
        if base_a in base_b or base_b in base_a:
            return 0.5

    return 0.0


def _type_compatible(type_a: str, type_b: str) -> float:
    """Check type compatibility between two columns (0..1)."""
    if type_a == type_b:
        return 1.0

    # Numeric types are compatible with each other
    numeric_types = {'integer', 'decimal', 'currency', 'number'}
    if type_a in numeric_types and type_b in numeric_types:
        return 0.9

    # Text types are compatible
    text_types = {'text', 'string'}
    if type_a in text_types and type_b in text_types:
        return 1.0

    return 0.0


def _value_overlap(values_a: set, values_b: set) -> float:
    """Compute Jaccard-like overlap between two value sets (0..1)."""
    if not values_a or not values_b:
        return 0.0

    # Sample if large
    if len(values_a) > 1000:
        values_a = set(list(values_a)[:1000])
    if len(values_b) > 1000:
        values_b = set(list(values_b)[:1000])

    intersection = values_a & values_b
    if not intersection:
        return 0.0

    # Directional: what fraction of the FK values exist in the PK column?
    # Use the smaller set's coverage against the larger
    smaller = min(len(values_a), len(values_b))
    coverage = len(intersection) / smaller if smaller > 0 else 0.0

    return min(coverage, 1.0)


def _infer_cardinality(
    unique_ratio_a: float,
    unique_ratio_b: float,
    card_a: int,
    card_b: int,
) -> str:
    """Infer relationship cardinality."""
    a_is_unique = unique_ratio_a > 0.95
    b_is_unique = unique_ratio_b > 0.95

    if a_is_unique and b_is_unique:
        return '1:1'
    elif a_is_unique and not b_is_unique:
        # A is PK side, B has duplicates → B references A
        return '1:N'  # from A's perspective: one A has many B
    elif not a_is_unique and b_is_unique:
        return 'N:1'
    else:
        return 'N:M'


def detect_relationships(
    tables: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Detect candidate relationships across a list of profiled tables.

    Each table dict must contain:
      - id: int (DataTable ID)
      - table_name: str
      - profile: dict (from profiler.profile_dataset)
      - rows_data: list[dict] (actual row data)

    Returns a list of relationship candidates sorted by confidence desc.
    """
    candidates: List[Dict[str, Any]] = []

    # Build column metadata lookup per table
    table_meta = []
    for t in tables:
        profile = t.get('profile') or {}
        col_profiles = {cp['name']: cp for cp in profile.get('columns', [])}

        # Get actual values for overlap checking
        rows = t.get('rows_data', [])
        df = pd.DataFrame(rows) if rows else pd.DataFrame()

        col_values = {}
        for col in col_profiles:
            if col in df.columns:
                non_null = df[col].dropna()
                col_values[col] = set(non_null.astype(str).unique()[:2000])
            else:
                col_values[col] = set()

        table_meta.append({
            'id': t['id'],
            'table_name': t['table_name'],
            'col_profiles': col_profiles,
            'col_values': col_values,
        })

    # Compare every pair of tables
    for i in range(len(table_meta)):
        for j in range(i + 1, len(table_meta)):
            t_a = table_meta[i]
            t_b = table_meta[j]

            # Compare every column pair between the two tables
            for col_a_name, col_a_prof in t_a['col_profiles'].items():
                for col_b_name, col_b_prof in t_b['col_profiles'].items():
                    candidate = _score_column_pair(
                        t_a, col_a_name, col_a_prof,
                        t_b, col_b_name, col_b_prof,
                    )
                    if candidate and candidate['confidence'] >= 0.60:
                        candidates.append(candidate)

    # Sort by confidence descending
    candidates.sort(key=lambda c: -c['confidence'])

    # Deduplicate: keep only the best match per column pair
    seen_pairs = set()
    deduped = []
    for c in candidates:
        pair_key = frozenset([
            (c['from_table_id'], c['from_column']),
            (c['to_table_id'], c['to_column']),
        ])
        if pair_key not in seen_pairs:
            seen_pairs.add(pair_key)
            deduped.append(c)

    return deduped


def _score_column_pair(
    t_a: Dict, col_a_name: str, col_a_prof: Dict,
    t_b: Dict, col_b_name: str, col_b_prof: Dict,
) -> Optional[Dict[str, Any]]:
    """
    Score a single column pair as a relationship candidate.
    Returns None if clearly not a match.
    """
    # ─── Signal 1: Name similarity (weight 0.30) ───
    name_score = _name_similarity(col_a_name, col_b_name)
    if name_score < 0.3:
        return None  # Names are too different, skip early

    # At least one should look like an ID column
    a_is_id = col_a_prof.get('semantic_role') == 'id' or bool(ID_SUFFIX.search(col_a_name))
    b_is_id = col_b_prof.get('semantic_role') == 'id' or bool(ID_SUFFIX.search(col_b_name))
    if not a_is_id and not b_is_id:
        # If neither looks like an ID and name similarity is weak, skip
        if name_score < 0.85:
            return None

    # ─── Signal 2: Uniqueness analysis (weight 0.25) ───
    ur_a = col_a_prof.get('unique_ratio', 0)
    ur_b = col_b_prof.get('unique_ratio', 0)

    # At least one side should have high uniqueness (PK candidate)
    uniqueness_score = 0.0
    if ur_a > 0.95 or ur_b > 0.95:
        uniqueness_score = 1.0
    elif ur_a > 0.8 or ur_b > 0.8:
        uniqueness_score = 0.7
    elif ur_a > 0.5 or ur_b > 0.5:
        uniqueness_score = 0.4
    else:
        uniqueness_score = 0.1

    # ─── Signal 3: Type compatibility (weight 0.15) ───
    type_a = col_a_prof.get('detected_type', 'text')
    type_b = col_b_prof.get('detected_type', 'text')
    type_score = _type_compatible(type_a, type_b)

    if type_score == 0.0:
        return None  # Incompatible types, not a join candidate

    # ─── Signal 4: Value overlap (weight 0.20) ───
    vals_a = t_a['col_values'].get(col_a_name, set())
    vals_b = t_b['col_values'].get(col_b_name, set())
    overlap_score = _value_overlap(vals_a, vals_b)

    if overlap_score < 0.1 and name_score < 0.85:
        return None  # Very low value overlap and names don't match well

    # ─── Signal 5: Cardinality ratio (weight 0.10) ───
    card_a = col_a_prof.get('cardinality', 0)
    card_b = col_b_prof.get('cardinality', 0)

    cardinality_score = 0.5  # default neutral
    if card_a > 0 and card_b > 0:
        ratio = min(card_a, card_b) / max(card_a, card_b)
        # In a FK→PK relationship, FK cardinality ≤ PK cardinality
        # But PK cardinality is typically close to row count
        cardinality_score = min(ratio + 0.3, 1.0)

    # ─── Composite score ───
    confidence = (
        name_score * 0.30 +
        uniqueness_score * 0.25 +
        overlap_score * 0.20 +
        type_score * 0.15 +
        cardinality_score * 0.10
    )
    confidence = round(confidence, 3)

    # ─── Determine direction (from FK → to PK) ───
    # The side with higher unique_ratio is the PK side
    if ur_a >= ur_b:
        pk_table = t_a
        pk_col = col_a_name
        fk_table = t_b
        fk_col = col_b_name
        pk_ur = ur_a
        fk_ur = ur_b
    else:
        pk_table = t_b
        pk_col = col_b_name
        fk_table = t_a
        fk_col = col_a_name
        pk_ur = ur_b
        fk_ur = ur_a

    cardinality = _infer_cardinality(pk_ur, fk_ur, card_a, card_b)

    # ─── Determine auto-approve status ───
    status = 'suggested'
    if confidence >= 0.85:
        status = 'approved'

    return {
        'from_table_id': fk_table['id'],
        'from_table_name': fk_table['table_name'],
        'from_column': fk_col,
        'to_table_id': pk_table['id'],
        'to_table_name': pk_table['table_name'],
        'to_column': pk_col,
        'cardinality': cardinality,
        'confidence': confidence,
        'status': status,
    }
