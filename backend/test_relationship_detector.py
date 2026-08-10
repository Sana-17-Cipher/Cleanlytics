import pandas as pd
from services.profiler import profile_dataset
from services.relationship_detector import detect_relationships

# Load sample tables
sales_df = pd.read_csv("sample_data/Sales.csv")
cust_df = pd.read_csv("sample_data/Customers.csv")
prod_df = pd.read_csv("sample_data/Products.csv")

tables = [
    {
        "id": 1,
        "table_name": "Sales",
        "profile": profile_dataset(sales_df),
        "rows_data": sales_df.replace({float('nan'): None}).to_dict(orient="records"),
    },
    {
        "id": 2,
        "table_name": "Customers",
        "profile": profile_dataset(cust_df),
        "rows_data": cust_df.replace({float('nan'): None}).to_dict(orient="records"),
    },
    {
        "id": 3,
        "table_name": "Products",
        "profile": profile_dataset(prod_df),
        "rows_data": prod_df.replace({float('nan'): None}).to_dict(orient="records"),
    },
]

# Run relationship detection
detected = detect_relationships(tables)

print("--- DETECTED RELATIONSHIPS ---")
for r in detected:
    print(f"{r['from_table_name']}.{r['from_column']} -> {r['to_table_name']}.{r['to_column']} | Card: {r['cardinality']} | Conf: {r['confidence']} | Status: {r['status']}")
