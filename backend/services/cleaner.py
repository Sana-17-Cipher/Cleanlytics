import pandas as pd
import numpy as np
import re
from typing import Dict, Any

def clean_data(df: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """
    Cleans data based on configuration.
    """
    df_clean = df.copy()

    # Remove duplicates
    if config.get("remove_duplicates"):
        df_clean = df_clean.drop_duplicates()
        
    if config.get("fuzzy_dedup"):
        # Simple fuzzy dedup mock: drop duplicates on lowercase versions of string columns
        string_cols = df_clean.select_dtypes(include=['object', 'string']).columns
        if len(string_cols) > 0:
            df_lower = df_clean.copy()
            for col in string_cols:
                df_lower[col] = df_lower[col].astype(str).str.lower().str.strip()
            # drop duplicates based on these standardized string columns
            df_clean = df_clean.loc[~df_lower.duplicated(subset=string_cols)]

    # Handle missing values (support list of configs)
    mv_configs = config.get("missing_values", [])
    if isinstance(mv_configs, dict):
        mv_configs = [mv_configs]
        
    for mv_config in mv_configs:
        strategy = mv_config.get("strategy")
        cols = mv_config.get("columns", df_clean.columns.tolist())
        
        if strategy == "drop":
            df_clean = df_clean.dropna(subset=cols)
        elif strategy == "fill_custom":
            fill_val = mv_config.get("fill_value")
            df_clean[cols] = df_clean[cols].fillna(fill_val)
        elif strategy in ["fill_mean", "fill_median", "fill_mode"]:
            for col in cols:
                if pd.api.types.is_numeric_dtype(df_clean[col]):
                    if strategy == "fill_mean":
                        val = df_clean[col].mean()
                    elif strategy == "fill_median":
                        val = df_clean[col].median()
                    elif strategy == "fill_mode":
                        mode_s = df_clean[col].mode()
                        val = mode_s.iloc[0] if not mode_s.empty else np.nan
                    df_clean[col] = df_clean[col].fillna(val)
        elif strategy == "forward_fill":
            df_clean[cols] = df_clean[cols].ffill()
        elif strategy == "backward_fill":
            df_clean[cols] = df_clean[cols].bfill()

    # Text sanitization
    trim_cols = config.get("trim_whitespace", [])
    for col in trim_cols:
        if col in df_clean.columns:
            df_clean[col] = df_clean[col].astype(str).str.strip()
            
    case_configs = config.get("standardize_case", [])
    for case_config in case_configs:
        case_format = case_config.get("format")
        cols = case_config.get("columns", [])
        for col in cols:
            if col in df_clean.columns:
                if case_format == "lower":
                    df_clean[col] = df_clean[col].astype(str).str.lower()
                elif case_format == "upper":
                    df_clean[col] = df_clean[col].astype(str).str.upper()
                elif case_format == "title":
                    df_clean[col] = df_clean[col].astype(str).str.title()
                
    spec_chars_cols = config.get("remove_special_characters", [])
    for col in spec_chars_cols:
        if col in df_clean.columns:
            df_clean[col] = df_clean[col].astype(str).apply(lambda x: re.sub(r'[^a-zA-Z0-9\s]', '', x) if pd.notnull(x) else x)

    # Fix dates
    date_cols = config.get("fix_dates", [])
    for col in date_cols:
        if col in df_clean.columns:
            df_clean[col] = pd.to_datetime(df_clean[col], errors='coerce').dt.strftime('%Y-%m-%d')

    # Remove outliers
    outlier_config = config.get("remove_outliers")
    if outlier_config:
        method = outlier_config.get("method", "iqr")
        outlier_cols = outlier_config.get("columns", df_clean.select_dtypes(include=[np.number]).columns.tolist())
        
        for col in outlier_cols:
            if col in df_clean.columns and pd.api.types.is_numeric_dtype(df_clean[col]):
                if method == "iqr":
                    Q1 = df_clean[col].quantile(0.25)
                    Q3 = df_clean[col].quantile(0.75)
                    IQR = Q3 - Q1
                    lower_bound = Q1 - 1.5 * IQR
                    upper_bound = Q3 + 1.5 * IQR
                    df_clean = df_clean[(df_clean[col] >= lower_bound) & (df_clean[col] <= upper_bound) | df_clean[col].isna()]
                elif method == "zscore":
                    mean = df_clean[col].mean()
                    std = df_clean[col].std()
                    if std > 0:
                        z_scores = (df_clean[col] - mean) / std
                        df_clean = df_clean[(z_scores.abs() <= 3) | df_clean[col].isna()]

    # Standardize numeric formats
    num_cols = config.get("standardize_numeric", [])
    for col in num_cols:
        if col in df_clean.columns:
            df_clean[col] = pd.to_numeric(df_clean[col], errors='coerce')

    # Validate email patterns
    email_cols = config.get("validate_email", [])
    email_pattern = r'^[\w\.-]+@[\w\.-]+\.\w+$'
    for col in email_cols:
        if col in df_clean.columns:
            df_clean[col] = df_clean[col].apply(lambda x: x if pd.isnull(x) or re.match(email_pattern, str(x)) else None)

    # Validate phone patterns
    phone_cols = config.get("validate_phone", [])
    phone_pattern = r'^\+?[\d\s\-\(\)]+$'
    for col in phone_cols:
        if col in df_clean.columns:
            df_clean[col] = df_clean[col].apply(lambda x: x if pd.isnull(x) or re.match(phone_pattern, str(x)) else None)

    return df_clean
