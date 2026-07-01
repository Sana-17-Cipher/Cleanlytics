import pandas as pd
import numpy as np
from scipy import stats
from typing import Dict, Any

def generate_insights(df: pd.DataFrame) -> Dict[str, Any]:
    insights = {
        "summary": {},
        "descriptive_stats": {},
        "correlation_matrix": {},
        "missing_values": {},
        "data_quality_score": 0,
        "recommendations": [],
        "outliers": {}
    }
    
    if df.empty:
        return insights
        
    num_rows = len(df)
    num_cols = len(df.columns)
    
    insights["summary"] = {
        "num_rows": num_rows,
        "num_columns": num_cols
    }
    
    # Missing values
    missing = df.isnull().sum().to_dict()
    insights["missing_values"] = missing
    total_missing = sum(missing.values())
    total_cells = num_rows * num_cols
    
    # Data quality score
    quality_score = 100
    if total_cells > 0:
        quality_score -= (total_missing / total_cells) * 30  # Max 30 points deduction for missing
        
    # Descriptive stats per column & Distribution/Outliers
    numeric_df = df.select_dtypes(include=[np.number])
    
    for col in df.columns:
        col_stats = {
            "type": str(df[col].dtype),
            "unique_count": df[col].nunique()
        }
        
        if pd.api.types.is_numeric_dtype(df[col]):
            col_stats.update({
                "mean": float(df[col].mean()) if not pd.isnull(df[col].mean()) else None,
                "median": float(df[col].median()) if not pd.isnull(df[col].median()) else None,
                "std": float(df[col].std()) if not pd.isnull(df[col].std()) else None,
                "min": float(df[col].min()) if not pd.isnull(df[col].min()) else None,
                "max": float(df[col].max()) if not pd.isnull(df[col].max()) else None
            })
            
            # Outlier detection (Z-score based)
            valid_data = df[col].dropna()
            if len(valid_data) > 3:
                z_scores = np.abs(stats.zscore(valid_data))
                outlier_count = len(np.where(z_scores > 3)[0])
                insights["outliers"][col] = outlier_count
                if outlier_count > 0:
                    quality_score -= min(5, (outlier_count / len(valid_data)) * 20)
        else:
            # Categorical value counts
            top_values = df[col].value_counts().head(5).to_dict()
            col_stats["top_values"] = top_values
            
        insights["descriptive_stats"][col] = col_stats

    # Correlation matrix
    if not numeric_df.empty and len(numeric_df.columns) > 1:
        corr_matrix = numeric_df.corr().replace({np.nan: None}).to_dict()
        insights["correlation_matrix"] = corr_matrix

    # Quality score clamping
    insights["data_quality_score"] = max(0, min(100, round(quality_score, 2)))
    
    # Auto-generated recommendations
    recommendations = []
    if total_missing > 0:
        recommendations.append(f"There are {total_missing} missing values in the dataset. Consider imputing or dropping them.")
        
    for col, count in insights.get("outliers", {}).items():
        if count > 0:
            recommendations.append(f"Column '{col}' has {count} outliers. Consider removing or transforming them.")
            
    duplicate_count = df.duplicated().sum()
    if duplicate_count > 0:
        recommendations.append(f"There are {duplicate_count} duplicate rows. Consider removing them.")
        
    insights["recommendations"] = recommendations

    return insights
