"""
CLEANYTICS — Semantic Profiling Engine
Analyzes a DataFrame and produces a rich semantic profile for each column.
"""

import pandas as pd
import numpy as np
import re
from typing import Dict, Any, List, Optional


# ─── Name-based heuristic patterns ───────────────────────────────────────────

ID_PATTERNS = re.compile(
    r'(^id$|_id$|^pk$|_pk$|_key$|_code$|^key$|^code$|^index$'
    r'|^customer_?id|^order_?id|^product_?id|^employee_?id'
    r'|^transaction_?id|^invoice_?id|^user_?id|^account_?id)',
    re.IGNORECASE
)

DATE_PATTERNS = re.compile(
    r'(date|_date$|_dt$|^dt_|datetime|timestamp|^time$'
    r'|^created|^updated|^modified|_at$|_on$'
    r'|^year$|^month$|^quarter$|^week$|^day$)',
    re.IGNORECASE
)

GEO_PATTERNS = re.compile(
    r'(^city$|^state$|^country$|^region$|^province$|^district$'
    r'|^zip$|^zipcode$|^zip_code$|^postal$|^postal_code$'
    r'|^latitude$|^lat$|^longitude$|^lon$|^lng$|^address$|^location$)',
    re.IGNORECASE
)

MEASURE_PATTERNS = re.compile(
    r'(revenue|sales|cost|price|amount|total|profit|margin'
    r'|quantity|qty|count|budget|target|actual|discount'
    r'|fee|tax|salary|wage|rate|score|rating|value'
    r'|income|expense|spend|balance|payment|charge)',
    re.IGNORECASE
)

CATEGORY_PATTERNS = re.compile(
    r'(category|type|status|segment|group|class|tier|level'
    r'|channel|source|medium|method|mode|gender|plan|brand)',
    re.IGNORECASE
)

BOOLEAN_PATTERNS = re.compile(
    r'(^is_|^has_|^can_|^should_|^was_|^did_|^flag|^active$'
    r'|^enabled$|^verified$|^approved$|^deleted$)',
    re.IGNORECASE
)

# Aggregation defaults per semantic role
AGG_DEFAULTS = {
    'measure': 'SUM',
    'dimension': 'NONE',
    'time': 'NONE',
    'id': 'NONE',
    'geographic': 'NONE',
    'category': 'NONE',
    'boolean': 'COUNT',
    'text': 'NONE',
}


def profile_dataset(df: pd.DataFrame) -> Dict[str, Any]:
    """
    Profile the entire dataset.
    Returns a dict with:
      - columns: list of per-column semantic profiles
      - summary: overall dataset summary
    """
    column_profiles = []
    for col in df.columns:
        profile = _profile_column(df, col)
        column_profiles.append(profile)

    # Compute overall summary
    total_cells = df.shape[0] * df.shape[1]
    total_missing = int(df.isnull().sum().sum())
    quality_score = round((1 - total_missing / max(total_cells, 1)) * 100, 1)

    measures = [p for p in column_profiles if p['semantic_role'] == 'measure']
    dimensions = [p for p in column_profiles if p['semantic_role'] in ('dimension', 'category', 'geographic')]
    time_fields = [p for p in column_profiles if p['semantic_role'] == 'time']
    ids = [p for p in column_profiles if p['semantic_role'] == 'id']

    summary = {
        'rows': int(df.shape[0]),
        'columns': int(df.shape[1]),
        'total_missing': total_missing,
        'quality_score': quality_score,
        'duplicate_rows': int(df.duplicated().sum()),
        'measure_count': len(measures),
        'dimension_count': len(dimensions),
        'time_count': len(time_fields),
        'id_count': len(ids),
    }

    return {
        'columns': column_profiles,
        'summary': summary,
    }


def _profile_column(df: pd.DataFrame, col: str) -> Dict[str, Any]:
    """Produce a semantic profile for a single column."""
    series = df[col]
    non_null = series.dropna()
    total = len(series)
    null_count = int(series.isnull().sum())
    non_null_count = len(non_null)

    # Detect syntactic type
    detected_type = _detect_syntactic_type(series, non_null)

    # Compute basic stats
    cardinality = int(non_null.nunique()) if non_null_count > 0 else 0
    unique_ratio = round(cardinality / max(non_null_count, 1), 4)

    # Examples
    examples = _get_examples(non_null)

    # Numeric stats
    stats: Dict[str, Any] = {}
    if detected_type in ('integer', 'decimal', 'currency', 'percentage'):
        numeric_vals = pd.to_numeric(non_null, errors='coerce').dropna()
        if len(numeric_vals) > 0:
            stats['min'] = float(numeric_vals.min())
            stats['max'] = float(numeric_vals.max())
            stats['mean'] = round(float(numeric_vals.mean()), 2)
            stats['median'] = round(float(numeric_vals.median()), 2)
            stats['std_dev'] = round(float(numeric_vals.std()), 2)

    # Infer semantic role
    semantic_role, confidence = _infer_semantic_role(
        col, detected_type, cardinality, unique_ratio, non_null_count, total, non_null
    )

    # Determine aggregation behavior
    agg_behavior = _determine_aggregation(semantic_role, detected_type)

    # Key candidate flags
    is_id_like = semantic_role == 'id' or bool(ID_PATTERNS.search(col.strip()))
    is_pk_candidate = is_id_like and unique_ratio >= 0.95 and null_count == 0
    is_fk_candidate = is_id_like and not is_pk_candidate

    # Detected format
    detected_format = _detect_format(detected_type, non_null)

    return {
        'name': col,
        'detected_type': detected_type,
        'semantic_role': semantic_role,
        'aggregation_behavior': agg_behavior,
        'confidence': confidence,
        'is_nullable': null_count > 0,
        'null_count': null_count,
        'unique_ratio': unique_ratio,
        'cardinality': cardinality,
        'is_primary_key_candidate': is_pk_candidate,
        'is_foreign_key_candidate': is_fk_candidate,
        'examples': examples,
        'detected_format': detected_format,
        'source': 'auto',
        **stats,
    }


def _detect_syntactic_type(series: pd.Series, non_null: pd.Series) -> str:
    """Detect the syntactic data type of a column."""
    if len(non_null) == 0:
        return 'text'

    # Check pandas dtype first
    dtype = series.dtype

    if pd.api.types.is_bool_dtype(dtype):
        return 'boolean'

    if pd.api.types.is_datetime64_any_dtype(dtype):
        return 'datetime'

    if pd.api.types.is_integer_dtype(dtype):
        return 'integer'

    if pd.api.types.is_float_dtype(dtype):
        return 'decimal'

    # For object/string columns, sample values
    sample = non_null.head(100).astype(str)

    # Try date detection
    date_count = 0
    date_regex = re.compile(
        r'^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}'
    )
    for val in sample:
        if date_regex.match(val.strip()):
            date_count += 1
    if date_count / max(len(sample), 1) > 0.7:
        return 'date'

    # Try numeric detection
    numeric_count = 0
    for val in sample:
        cleaned = val.strip().replace(',', '').replace('$', '').replace('€', '').replace('£', '').replace('₹', '').replace('%', '')
        try:
            float(cleaned)
            numeric_count += 1
        except ValueError:
            pass

    if numeric_count / max(len(sample), 1) > 0.8:
        # Check for currency/percentage symbols
        currency_count = sum(1 for v in sample if any(c in str(v) for c in '$€£₹'))
        pct_count = sum(1 for v in sample if '%' in str(v))

        if currency_count / max(len(sample), 1) > 0.5:
            return 'currency'
        if pct_count / max(len(sample), 1) > 0.5:
            return 'percentage'
        # Check integer vs decimal
        int_count = sum(1 for v in sample if '.' not in v.strip().replace(',', ''))
        if int_count / max(len(sample), 1) > 0.8:
            return 'integer'
        return 'decimal'

    # Boolean check
    unique_lower = set(non_null.astype(str).str.strip().str.lower().unique())
    if unique_lower.issubset({'true', 'false', '1', '0', 'yes', 'no', 'y', 'n'}):
        return 'boolean'

    return 'text'


def _infer_semantic_role(
    col: str,
    detected_type: str,
    cardinality: int,
    unique_ratio: float,
    non_null_count: int,
    total: int,
    non_null: pd.Series,
) -> tuple:
    """
    Infer the semantic role of a column using name patterns,
    data type, cardinality, and value analysis.
    Returns (role, confidence).
    """
    col_clean = col.strip()

    # 1. Name-based detection (highest priority)
    if ID_PATTERNS.search(col_clean):
        return ('id', 0.92)

    if BOOLEAN_PATTERNS.search(col_clean):
        return ('boolean', 0.90)

    if DATE_PATTERNS.search(col_clean):
        return ('time', 0.93)

    if GEO_PATTERNS.search(col_clean):
        return ('geographic', 0.88)

    # 2. Type + name based
    if detected_type in ('date', 'datetime'):
        return ('time', 0.95)

    if detected_type == 'boolean':
        return ('boolean', 0.90)

    # 3. Measure vs ID disambiguation for numeric columns
    if detected_type in ('integer', 'decimal', 'currency', 'percentage'):
        # If name matches measure patterns → measure
        if MEASURE_PATTERNS.search(col_clean):
            return ('measure', 0.95)

        # High uniqueness numeric → likely an ID
        if unique_ratio > 0.9 and cardinality > 20:
            return ('id', 0.80)

        # Low cardinality numeric → could be a category code
        if cardinality <= 10 and non_null_count > 20:
            return ('category', 0.70)

        # Default numeric → measure (but lower confidence)
        return ('measure', 0.75)

    # 4. Text columns
    if detected_type == 'text':
        if CATEGORY_PATTERNS.search(col_clean):
            return ('category', 0.90)

        if MEASURE_PATTERNS.search(col_clean):
            return ('dimension', 0.70)  # text but measure-like name → dimension

        # Cardinality heuristics for text
        if cardinality <= 2:
            return ('boolean', 0.70)

        if cardinality <= 30 or (non_null_count > 50 and unique_ratio < 0.1):
            return ('category', 0.82)

        if cardinality <= 100 and unique_ratio < 0.5:
            return ('dimension', 0.78)

        if unique_ratio > 0.9:
            # Very high cardinality text → could be ID or free text
            if cardinality > 100:
                return ('text', 0.65)
            return ('id', 0.60)

        return ('dimension', 0.70)

    return ('dimension', 0.60)


def _determine_aggregation(semantic_role: str, detected_type: str) -> str:
    """Determine the default aggregation behavior."""
    if semantic_role == 'measure':
        if detected_type in ('currency', 'decimal', 'integer'):
            return 'SUM'
        if detected_type == 'percentage':
            return 'AVG'
        return 'SUM'

    if semantic_role == 'id':
        return 'DISTINCT_COUNT'

    if semantic_role in ('category', 'dimension', 'geographic'):
        return 'COUNT'

    if semantic_role == 'boolean':
        return 'COUNT'

    return AGG_DEFAULTS.get(semantic_role, 'NONE')


def _get_examples(non_null: pd.Series, n: int = 5) -> List[str]:
    """Get sample values as strings."""
    if len(non_null) == 0:
        return []
    sample = non_null.head(min(n, len(non_null)))
    return [str(v) for v in sample.tolist()]


def _detect_format(detected_type: str, non_null: pd.Series) -> str:
    """Detect the format of values."""
    if detected_type in ('date', 'datetime'):
        sample = non_null.head(5).astype(str)
        for val in sample:
            if re.match(r'^\d{4}-\d{2}-\d{2}', val):
                return 'YYYY-MM-DD'
            if re.match(r'^\d{2}/\d{2}/\d{4}', val):
                return 'MM/DD/YYYY'
            if re.match(r'^\d{2}-\d{2}-\d{4}', val):
                return 'DD-MM-YYYY'
        return 'date'

    if detected_type == 'currency':
        return 'currency'

    if detected_type == 'percentage':
        return 'percentage'

    if detected_type in ('integer', 'decimal'):
        return 'numeric'

    if detected_type == 'boolean':
        return 'boolean'

    return 'text'
