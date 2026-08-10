"""
CLEANYTICS — Smart Suggestion Engine
Generates transformation suggestions and measure recommendations
based on the semantic profile of a dataset.
"""

import pandas as pd
import numpy as np
from typing import Dict, Any, List


# ─── Transformation Suggestions ─────────────────────────────────────────────

def generate_transformation_suggestions(
    df: pd.DataFrame,
    profile: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Generate context-aware transformation suggestions.
    Each suggestion includes: id, type, target_column, parameters,
    name, description, reason, confidence, risk_tier
    """
    suggestions: List[Dict[str, Any]] = []
    idx = 0
    columns = {cp['name']: cp for cp in profile.get('columns', [])}

    # ── 1. Date decomposition ────────────────────────────────────────
    for col_name, cp in columns.items():
        if cp.get('semantic_role') == 'time' and cp.get('detected_type') in ('date', 'datetime'):
            date_parts = [
                ('Year', 'Extract the year component for annual trend analysis'),
                ('Quarter', 'Extract the quarter for quarterly comparisons'),
                ('Month', 'Extract the month for monthly trend analysis'),
                ('Month_Name', 'Extract month name for readable labels'),
                ('Day_of_Week', 'Extract day of week for weekly pattern analysis'),
            ]
            for part_name, reason in date_parts:
                target = f'{col_name}_{part_name}'
                if target not in df.columns:
                    suggestions.append({
                        'id': f'ts-{idx:03d}',
                        'type': 'date_decomposition',
                        'target_column': col_name,
                        'new_column': target,
                        'parameters': {'part': part_name.lower()},
                        'name': f'Create {part_name} from {col_name}',
                        'description': f'Extract {part_name} from "{col_name}" into a new column',
                        'reason': reason,
                        'confidence': 0.92,
                        'risk_tier': 'B',
                    })
                    idx += 1

    # ── 2. Derived calculations ──────────────────────────────────────
    measure_cols = {
        cp['name']: cp for cp in profile.get('columns', [])
        if cp.get('semantic_role') == 'measure'
    }
    measure_names_lower = {name.lower().replace(' ', '_').replace('-', '_'): name for name in measure_cols}

    # Revenue + Cost → Profit
    revenue_col = _find_col(measure_names_lower, ['revenue', 'sales', 'total_revenue', 'total_sales', 'income', 'gross_revenue'])
    cost_col = _find_col(measure_names_lower, ['cost', 'total_cost', 'expense', 'expenses', 'cogs', 'cost_of_goods'])

    if revenue_col and cost_col and 'Profit' not in df.columns and 'profit' not in [c.lower() for c in df.columns]:
        suggestions.append({
            'id': f'ts-{idx:03d}',
            'type': 'derived_calculation',
            'target_column': None,
            'new_column': 'Profit',
            'parameters': {'formula': f'{revenue_col} - {cost_col}', 'col_a': revenue_col, 'col_b': cost_col, 'operator': '-'},
            'name': 'Create Profit',
            'description': f'Profit = {revenue_col} − {cost_col}',
            'reason': f'Both "{revenue_col}" and "{cost_col}" are available as monetary measures. Profit is a commonly useful derived measure for financial analysis.',
            'confidence': 0.95,
            'risk_tier': 'B',
        })
        idx += 1

    # Revenue + Cost → Profit Margin
    if revenue_col and cost_col and 'Profit_Margin' not in df.columns:
        suggestions.append({
            'id': f'ts-{idx:03d}',
            'type': 'derived_calculation',
            'target_column': None,
            'new_column': 'Profit_Margin',
            'parameters': {'formula': f'({revenue_col} - {cost_col}) / {revenue_col}', 'col_a': revenue_col, 'col_b': cost_col, 'operator': 'margin'},
            'name': 'Create Profit Margin',
            'description': f'Profit Margin = ({revenue_col} − {cost_col}) / {revenue_col}',
            'reason': 'Profit Margin shows profitability as a percentage, useful for comparing efficiency across categories or time periods.',
            'confidence': 0.90,
            'risk_tier': 'B',
        })
        idx += 1

    # Revenue + Orders → Average Order Value
    orders_col = _find_col(measure_names_lower, ['orders', 'order_count', 'num_orders', 'total_orders', 'transactions', 'count'])
    if revenue_col and orders_col and 'Avg_Order_Value' not in df.columns:
        suggestions.append({
            'id': f'ts-{idx:03d}',
            'type': 'derived_calculation',
            'target_column': None,
            'new_column': 'Avg_Order_Value',
            'parameters': {'formula': f'{revenue_col} / {orders_col}', 'col_a': revenue_col, 'col_b': orders_col, 'operator': '/'},
            'name': 'Create Average Order Value',
            'description': f'AOV = {revenue_col} / {orders_col}',
            'reason': 'Average Order Value is a key metric for understanding customer purchasing behavior.',
            'confidence': 0.88,
            'risk_tier': 'B',
        })
        idx += 1

    # Revenue + Customers → Revenue per Customer
    customer_col = _find_col(measure_names_lower, ['customers', 'customer_count', 'num_customers', 'total_customers', 'users', 'user_count'])
    if revenue_col and customer_col and 'Revenue_per_Customer' not in df.columns:
        suggestions.append({
            'id': f'ts-{idx:03d}',
            'type': 'derived_calculation',
            'target_column': None,
            'new_column': 'Revenue_per_Customer',
            'parameters': {'formula': f'{revenue_col} / {customer_col}', 'col_a': revenue_col, 'col_b': customer_col, 'operator': '/'},
            'name': 'Create Revenue per Customer',
            'description': f'Revenue per Customer = {revenue_col} / {customer_col}',
            'reason': 'Revenue per Customer helps evaluate customer value and lifetime worth.',
            'confidence': 0.85,
            'risk_tier': 'B',
        })
        idx += 1

    # Price + Quantity → Calculated Sales (if no Revenue)
    price_col = _find_col(measure_names_lower, ['price', 'unit_price', 'selling_price', 'rate'])
    qty_col = _find_col(measure_names_lower, ['quantity', 'qty', 'units', 'volume', 'count'])
    if price_col and qty_col and not revenue_col and 'Calculated_Sales' not in df.columns:
        suggestions.append({
            'id': f'ts-{idx:03d}',
            'type': 'derived_calculation',
            'target_column': None,
            'new_column': 'Calculated_Sales',
            'parameters': {'formula': f'{price_col} * {qty_col}', 'col_a': price_col, 'col_b': qty_col, 'operator': '*'},
            'name': 'Create Calculated Sales',
            'description': f'Calculated Sales = {price_col} × {qty_col}',
            'reason': f'"{price_col}" and "{qty_col}" are available. Their product gives the total sales value per record.',
            'confidence': 0.88,
            'risk_tier': 'B',
        })
        idx += 1

    return suggestions


# ─── Measure Recommendations ────────────────────────────────────────────────

def generate_measure_recommendations(
    df: pd.DataFrame,
    profile: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Generate recommended measures based on available columns.
    Each measure has: id, name, formula, description, source_columns,
    aggregation, reason, confidence
    """
    recommendations: List[Dict[str, Any]] = []
    idx = 0
    columns = {cp['name']: cp for cp in profile.get('columns', [])}

    measure_cols = [
        cp for cp in profile.get('columns', [])
        if cp.get('semantic_role') == 'measure'
    ]

    dimension_cols = [
        cp for cp in profile.get('columns', [])
        if cp.get('semantic_role') in ('dimension', 'category', 'geographic')
    ]

    # ── Basic aggregations for each measure ──────────────────────────
    for mc in measure_cols:
        col_name = mc['name']
        detected_type = mc.get('detected_type', 'decimal')

        # SUM
        recommendations.append({
            'id': f'mr-{idx:03d}',
            'name': f'Total {col_name}',
            'formula': f'SUM({col_name})',
            'description': f'Sum of all {col_name} values',
            'source_columns': [col_name],
            'aggregation': 'SUM',
            'reason': f'"{col_name}" is a numeric measure. Total is the most fundamental aggregation.',
            'confidence': 0.95,
        })
        idx += 1

        # AVERAGE
        recommendations.append({
            'id': f'mr-{idx:03d}',
            'name': f'Average {col_name}',
            'formula': f'AVG({col_name})',
            'description': f'Average of {col_name} values',
            'source_columns': [col_name],
            'aggregation': 'AVG',
            'reason': f'Average "{col_name}" shows the typical value per record, useful for comparison.',
            'confidence': 0.90,
        })
        idx += 1

        # MIN / MAX (only for the primary measure)
        if mc == measure_cols[0]:
            recommendations.append({
                'id': f'mr-{idx:03d}',
                'name': f'Min {col_name}',
                'formula': f'MIN({col_name})',
                'description': f'Minimum {col_name} value',
                'source_columns': [col_name],
                'aggregation': 'MIN',
                'reason': f'Useful for identifying the lowest {col_name} record.',
                'confidence': 0.80,
            })
            idx += 1

            recommendations.append({
                'id': f'mr-{idx:03d}',
                'name': f'Max {col_name}',
                'formula': f'MAX({col_name})',
                'description': f'Maximum {col_name} value',
                'source_columns': [col_name],
                'aggregation': 'MAX',
                'reason': f'Useful for identifying the highest {col_name} record.',
                'confidence': 0.80,
            })
            idx += 1

    # ── Record Count ─────────────────────────────────────────────────
    recommendations.append({
        'id': f'mr-{idx:03d}',
        'name': 'Record Count',
        'formula': 'COUNT(*)',
        'description': 'Total number of records',
        'source_columns': [],
        'aggregation': 'COUNT',
        'reason': 'Record count is fundamental for understanding data volume per dimension.',
        'confidence': 0.95,
    })
    idx += 1

    # ── Distinct count for ID columns ────────────────────────────────
    id_cols = [
        cp for cp in profile.get('columns', [])
        if cp.get('semantic_role') == 'id'
    ]
    for ic in id_cols[:2]:  # Limit to 2 most relevant
        col_name = ic['name']
        recommendations.append({
            'id': f'mr-{idx:03d}',
            'name': f'Unique {col_name}s',
            'formula': f'DISTINCT_COUNT({col_name})',
            'description': f'Number of distinct {col_name} values',
            'source_columns': [col_name],
            'aggregation': 'DISTINCT_COUNT',
            'reason': f'Counting unique "{col_name}" values reveals how many distinct entities exist.',
            'confidence': 0.88,
        })
        idx += 1

    # ── Contribution % for primary measure × top dimension ───────────
    if len(measure_cols) > 0 and len(dimension_cols) > 0:
        primary = measure_cols[0]['name']
        dim = dimension_cols[0]['name']
        recommendations.append({
            'id': f'mr-{idx:03d}',
            'name': f'{primary} Contribution %',
            'formula': f'SUM({primary}) / TOTAL(SUM({primary})) × 100',
            'description': f'Percentage contribution of each {dim} to total {primary}',
            'source_columns': [primary, dim],
            'aggregation': 'PERCENTAGE',
            'reason': f'Shows how much each "{dim}" contributes to total "{primary}". Essential for identifying top performers.',
            'confidence': 0.85,
        })
        idx += 1

    return recommendations


# ─── Dashboard Visualization Recommendations ────────────────────────────────

def recommend_visualization(
    x_col_profile: Dict[str, Any],
    y_col_profile: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Given two column profiles (x and y), recommend chart type + aggregation.
    """
    x_role = x_col_profile.get('semantic_role', 'dimension')
    y_role = y_col_profile.get('semantic_role', 'measure')
    x_type = x_col_profile.get('detected_type', 'text')
    y_type = y_col_profile.get('detected_type', 'decimal')
    x_card = x_col_profile.get('cardinality', 10)

    recommended_agg = y_col_profile.get('aggregation_behavior', 'SUM')

    # Time + Measure → Line chart
    if x_role == 'time' and y_role == 'measure':
        return {
            'chart_type': 'line',
            'aggregation': recommended_agg,
            'reason': f'Line chart is best for showing {y_col_profile["name"]} trends over time.',
            'confidence': 0.95,
        }

    # Category/Dimension + Measure → Bar chart
    if x_role in ('category', 'dimension', 'geographic') and y_role == 'measure':
        if x_card <= 8:
            return {
                'chart_type': 'bar',
                'aggregation': recommended_agg,
                'reason': f'Bar chart is ideal for comparing {y_col_profile["name"]} across {x_card} {x_col_profile["name"]} categories.',
                'confidence': 0.92,
            }
        else:
            return {
                'chart_type': 'bar',
                'aggregation': recommended_agg,
                'reason': f'Bar chart for comparing {y_col_profile["name"]} by {x_col_profile["name"]}. Consider filtering to top categories.',
                'confidence': 0.85,
            }

    # Two measures → Scatter
    if x_role == 'measure' and y_role == 'measure':
        return {
            'chart_type': 'scatter',
            'aggregation': 'none',
            'reason': f'Scatter plot reveals the relationship between {x_col_profile["name"]} and {y_col_profile["name"]}.',
            'confidence': 0.88,
        }

    # Category with low cardinality + Measure → Pie/donut
    if x_role in ('category',) and y_role == 'measure' and x_card <= 6:
        return {
            'chart_type': 'pie',
            'aggregation': recommended_agg,
            'reason': f'Donut chart shows the composition of {y_col_profile["name"]} across {x_col_profile["name"]}.',
            'confidence': 0.80,
        }

    # Default
    return {
        'chart_type': 'bar',
        'aggregation': recommended_agg,
        'reason': 'Bar chart is a safe default for comparing values.',
        'confidence': 0.60,
    }


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _find_col(name_map: Dict[str, str], candidates: List[str]) -> str | None:
    """Find the first matching column from a list of candidate names."""
    for candidate in candidates:
        if candidate in name_map:
            return name_map[candidate]
    return None
