"""
CLEANYTICS — Data Quality Engine
Scans a DataFrame against a semantic profile and produces quality suggestions.
Each suggestion has a risk tier (A/B/C) based on confidence + potential impact.
"""

import pandas as pd
import numpy as np
import re
from typing import Dict, Any, List


def detect_quality_issues(
    df: pd.DataFrame,
    profile: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Analyze the dataset for quality issues.
    Returns a list of quality suggestions, each with:
      - id, type, severity, affected_rows, description, recommendation,
        confidence, risk_tier, column (optional), preview
    """
    suggestions: List[Dict[str, Any]] = []
    idx = 0

    # ── 1. Duplicate rows ──────────────────────────────────────────────
    dup_count = int(df.duplicated().sum())
    if dup_count > 0:
        pct = round(dup_count / max(len(df), 1) * 100, 1)
        suggestions.append({
            'id': f'qs-{idx:03d}',
            'type': 'duplicate_rows',
            'severity': 'medium' if pct < 5 else 'high',
            'affected_rows': dup_count,
            'column': None,
            'description': f'{dup_count} exact duplicate rows detected ({pct}% of dataset)',
            'recommendation': 'Remove duplicate rows',
            'why': 'Duplicate rows can skew aggregations and produce misleading analytics results.',
            'confidence': 0.95,
            'risk_tier': 'A' if dup_count < 50 else 'B',  # small count = safe auto
        })
        idx += 1

    # ── 2. Per-column issues ───────────────────────────────────────────
    column_profiles = {cp['name']: cp for cp in profile.get('columns', [])}

    for col in df.columns:
        col_profile = column_profiles.get(col, {})
        series = df[col]
        non_null = series.dropna()

        # 2a. Missing values
        null_count = int(series.isnull().sum())
        if null_count > 0:
            pct = round(null_count / max(len(df), 1) * 100, 1)
            semantic_role = col_profile.get('semantic_role', 'unknown')
            severity = 'low' if pct < 5 else ('medium' if pct < 20 else 'high')

            if semantic_role in ('id',):
                recommendation = f'Review missing IDs in "{col}" — these rows may be incomplete records'
                risk_tier = 'C'
            elif semantic_role == 'measure' and pct < 10:
                recommendation = f'Consider imputing missing values in "{col}" with median'
                risk_tier = 'B'
            elif pct < 2:
                recommendation = f'Drop {null_count} rows with missing "{col}" values'
                risk_tier = 'B'
            else:
                recommendation = f'Review {null_count} missing values in "{col}"'
                risk_tier = 'C' if pct > 20 else 'B'

            suggestions.append({
                'id': f'qs-{idx:03d}',
                'type': 'missing_values',
                'severity': severity,
                'affected_rows': null_count,
                'column': col,
                'description': f'"{col}" has {null_count} missing values ({pct}%)',
                'recommendation': recommendation,
                'why': f'Missing values in a {semantic_role} column can cause calculation errors or bias in analytics.',
                'confidence': 0.90,
                'risk_tier': risk_tier,
            })
            idx += 1

        # 2b. Inconsistent capitalization (string columns)
        if col_profile.get('detected_type') == 'text' and len(non_null) > 0:
            str_vals = non_null.astype(str).str.strip()
            lower_vals = str_vals.str.lower()

            # Group by lowercase, find groups with mixed casing
            groups = str_vals.groupby(lower_vals).nunique()
            inconsistent_groups = groups[groups > 1]

            if len(inconsistent_groups) > 0:
                total_affected = 0
                examples = []
                for lower_key in inconsistent_groups.index[:3]:
                    variants = str_vals[lower_vals == lower_key].unique().tolist()
                    total_affected += int((lower_vals == lower_key).sum())
                    examples.append(', '.join(f'"{v}"' for v in variants[:4]))

                suggestions.append({
                    'id': f'qs-{idx:03d}',
                    'type': 'inconsistent_case',
                    'severity': 'medium',
                    'affected_rows': total_affected,
                    'column': col,
                    'description': f'"{col}" has inconsistent capitalization: {"; ".join(examples[:2])}',
                    'recommendation': f'Standardize "{col}" to Title Case',
                    'why': 'Inconsistent casing causes the same value to appear as separate categories in charts and aggregations.',
                    'confidence': 0.88,
                    'risk_tier': 'B',
                })
                idx += 1

        # 2c. Leading/trailing whitespace
        if col_profile.get('detected_type') == 'text' and len(non_null) > 0:
            str_vals = non_null.astype(str)
            whitespace_count = int((str_vals != str_vals.str.strip()).sum())
            if whitespace_count > 0:
                suggestions.append({
                    'id': f'qs-{idx:03d}',
                    'type': 'whitespace',
                    'severity': 'low',
                    'affected_rows': whitespace_count,
                    'column': col,
                    'description': f'"{col}" has {whitespace_count} values with leading/trailing whitespace',
                    'recommendation': f'Trim whitespace in "{col}"',
                    'why': 'Whitespace can cause duplicate categories and failed lookups.',
                    'confidence': 0.95,
                    'risk_tier': 'A',  # Very safe to auto-apply
                })
                idx += 1

        # 2d. Suspicious outliers (numeric measures only)
        if col_profile.get('semantic_role') == 'measure' and col_profile.get('detected_type') in ('integer', 'decimal', 'currency'):
            numeric_vals = pd.to_numeric(non_null, errors='coerce').dropna()
            if len(numeric_vals) > 20:
                Q1 = float(numeric_vals.quantile(0.25))
                Q3 = float(numeric_vals.quantile(0.75))
                IQR = Q3 - Q1
                if IQR > 0:
                    lower = Q1 - 1.5 * IQR
                    upper = Q3 + 1.5 * IQR
                    outlier_count = int(((numeric_vals < lower) | (numeric_vals > upper)).sum())
                    if outlier_count > 0:
                        pct = round(outlier_count / len(numeric_vals) * 100, 1)
                        suggestions.append({
                            'id': f'qs-{idx:03d}',
                            'type': 'outliers',
                            'severity': 'low' if pct < 2 else 'medium',
                            'affected_rows': outlier_count,
                            'column': col,
                            'description': f'"{col}" has {outlier_count} statistical outliers ({pct}%) outside IQR range [{round(lower, 1)}, {round(upper, 1)}]',
                            'recommendation': f'Review outliers in "{col}" — they may be valid extreme values or data errors',
                            'why': 'Outliers can significantly affect averages and trend calculations. Review before removing.',
                            'confidence': 0.75,
                            'risk_tier': 'C',  # Always review — outliers might be valid
                        })
                        idx += 1

        # 2e. Constant columns
        if col_profile.get('cardinality', 0) == 1 and len(non_null) > 5:
            suggestions.append({
                'id': f'qs-{idx:03d}',
                'type': 'constant_column',
                'severity': 'low',
                'affected_rows': len(df),
                'column': col,
                'description': f'"{col}" contains only one unique value and provides no analytical value',
                'recommendation': f'Consider removing "{col}" from analysis',
                'why': 'Constant columns add noise without contributing to analysis or visualization.',
                'confidence': 0.90,
                'risk_tier': 'B',
            })
            idx += 1

    # Sort by severity (high first), then by affected_rows
    severity_order = {'high': 0, 'medium': 1, 'low': 2}
    suggestions.sort(key=lambda s: (severity_order.get(s['severity'], 3), -s['affected_rows']))

    return suggestions
