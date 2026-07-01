import pandas as pd
from typing import Dict, Any

def transform_data(df: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """
    Transforms data based on configuration.
    """
    df_transformed = df.copy()

    # Merge columns
    merge_config = config.get("merge_columns")
    if merge_config:
        cols_to_merge = merge_config.get("columns", [])
        target_col = merge_config.get("target")
        separator = merge_config.get("separator", " ")
        if cols_to_merge and target_col:
            df_transformed[target_col] = df_transformed[cols_to_merge].astype(str).agg(separator.join, axis=1)

    # Split column
    split_config = config.get("split_column")
    if split_config:
        src_col = split_config.get("column")
        separator = split_config.get("separator", ",")
        targets = split_config.get("targets", [])
        if src_col and targets and src_col in df_transformed.columns:
            split_df = df_transformed[src_col].astype(str).str.split(separator, expand=True)
            for i, target in enumerate(targets):
                if i < len(split_df.columns):
                    df_transformed[target] = split_df[i]
                else:
                    df_transformed[target] = None

    # Rename columns
    rename_cols = config.get("rename_columns")
    if rename_cols:
        df_transformed = df_transformed.rename(columns=rename_cols)

    # Change types
    change_types = config.get("change_types")
    if change_types:
        for col, dtype in change_types.items():
            if col in df_transformed.columns:
                try:
                    df_transformed[col] = df_transformed[col].astype(dtype)
                except Exception:
                    pass

    # Create calculated columns
    calc_cols = config.get("create_calculated")
    if calc_cols:
        for new_col, expr in calc_cols.items():
            try:
                df_transformed[new_col] = df_transformed.eval(expr)
            except Exception:
                pass

    # Math Operation
    math_op_config = config.get("math_operation")
    if math_op_config:
        col_a = math_op_config.get("column_a")
        col_b = math_op_config.get("column_b")
        op = math_op_config.get("operation")
        target = math_op_config.get("target")
        if col_a and col_b and op and target and col_a in df_transformed.columns and col_b in df_transformed.columns:
            try:
                if op == "+":
                    df_transformed[target] = df_transformed[col_a] + df_transformed[col_b]
                elif op == "-":
                    df_transformed[target] = df_transformed[col_a] - df_transformed[col_b]
                elif op == "*":
                    df_transformed[target] = df_transformed[col_a] * df_transformed[col_b]
                elif op == "/":
                    df_transformed[target] = df_transformed[col_a] / df_transformed[col_b]
                elif op == "concat":
                    df_transformed[target] = df_transformed[col_a].astype(str) + df_transformed[col_b].astype(str)
            except Exception:
                pass

    # Filter
    filter_config = config.get("filter")
    if filter_config:
        for col, cond in filter_config.items():
            if col in df_transformed.columns:
                op = cond.get("operator", "==")
                val = cond.get("value")
                if op == "==":
                    df_transformed = df_transformed[df_transformed[col] == val]
                elif op == "!=":
                    df_transformed = df_transformed[df_transformed[col] != val]
                elif op == ">":
                    df_transformed = df_transformed[df_transformed[col] > val]
                elif op == "<":
                    df_transformed = df_transformed[df_transformed[col] < val]
                elif op == ">=":
                    df_transformed = df_transformed[df_transformed[col] >= val]
                elif op == "<=":
                    df_transformed = df_transformed[df_transformed[col] <= val]

    # Sort
    sort_config = config.get("sort")
    if sort_config:
        sort_cols = list(sort_config.keys())
        asc = list(sort_config.values())
        df_transformed = df_transformed.sort_values(by=sort_cols, ascending=asc)

    # Reorder columns
    reorder_cols = config.get("reorder_columns")
    if reorder_cols:
        existing_cols = [c for c in reorder_cols if c in df_transformed.columns]
        df_transformed = df_transformed[existing_cols]

    # Group by
    group_config = config.get("group_by")
    if group_config:
        group_cols = group_config.get("columns", [])
        aggs = group_config.get("aggregations", {})
        if group_cols and aggs:
            df_transformed = df_transformed.groupby(group_cols).agg(aggs).reset_index()
            if isinstance(df_transformed.columns, pd.MultiIndex):
                df_transformed.columns = ['_'.join(col).strip() if col[1] else col[0] for col in df_transformed.columns.values]

    return df_transformed
