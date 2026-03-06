import sqlite3
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

load_dotenv()

SQLITE_DB = "mix_data.sqlite3"
POSTGRES_URL = os.getenv("DATABASE_URL")

def migrate():
    if not POSTGRES_URL:
        print("Error: DATABASE_URL not found in environment.")
        return

    lite_conn = sqlite3.connect(SQLITE_DB)
    lite_conn.row_factory = sqlite3.Row
    pg_conn = psycopg2.connect(POSTGRES_URL)
    pg_conn.autocommit = True

    tables = [
        "app_state", "datasets", "dataset_revisions", "upload_staging",
        "qc_profiles", "doser_profiles", "users", "auth_locks",
        "remisiones", "audit_log"
    ]

    for table in tables:
        print(f"Migrating table: {table}...")
        try:
            cursor = lite_conn.execute(f"SELECT * FROM {table}")
            rows = cursor.fetchall()
            if not rows:
                print(f"  Table {table} is empty. Skipping.")
                continue

            columns = rows[0].keys()
            col_names = ",".join(columns)
            placeholders = ",".join(["%s"] * len(columns))
            
            # Simple insert, assumes PG table exists (init_db should have run)
            with pg_conn.cursor() as pg_cur:
                pg_cur.execute(f"TRUNCATE TABLE {table} CASCADE")
                data = [tuple(row) for row in rows]
                execute_values(pg_cur, f"INSERT INTO {table} ({col_names}) VALUES %s", data)
            print(f"  Successfully migrated {len(rows)} records.")
        except Exception as e:
            print(f"  Error migrating {table}: {e}")

    lite_conn.close()
    pg_conn.close()
    print("Migration finished.")

if __name__ == "__main__":
    migrate()
