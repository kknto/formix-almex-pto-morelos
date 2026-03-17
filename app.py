import argparse
import csv
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import unicodedata
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from threading import Lock, RLock
from uuid import uuid4

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from psycopg2.pool import ThreadedConnectionPool
    POSTGRES_AVAILABLE = True
except ImportError:
    POSTGRES_AVAILABLE = False

from dotenv import load_dotenv
import pytz

load_dotenv()

PUERTO_MORELOS_TZ = pytz.timezone("America/Cancun")

def get_now() -> datetime:
    """Retorna datetime.now() en la zona horaria de Puerto Morelos."""
    return datetime.now(PUERTO_MORELOS_TZ)


MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 400
STAGING_TTL_MIN = 30
MODES = {"new", "replace", "merge"}
MAX_DB_SNAPSHOTS = 40
QC_AGGREGATES = ("Fino 1", "Fino 2", "Grueso 1", "Grueso 2")
QC_FIELDS = ("pvs", "pvc", "densidad", "absorcion", "humedad")
DOSER_PARAM_FIELDS = (
    "cemento_pesp",
    "aire_pct",
    "pasa_malla_200_pct",
    "pxl_pond_pct",
    "densidad_agregado_fallback",
)
ROLE_ALLOWED_VIEWS = {
    "administrador": {"editor", "consulta", "dosificador", "flotilla", "inventario", "laboratorio", "usuarios"},
    "jefe-de-planta": {"editor", "consulta", "dosificador", "flotilla", "inventario", "laboratorio"},
    "dosificador": {"dosificador", "flotilla", "inventario"},
    "presupuestador": {"consulta"},
    "laboratorista": {"laboratorio"},
}
EDITOR_ROLES = {"administrador", "jefe-de-planta"}
QC_HUMIDITY_ROLES = {"dosificador"}
DOSIFICADOR_ROLES = tuple(sorted(role for role, views in ROLE_ALLOWED_VIEWS.items() if "dosificador" in views))
FLEET_ROLES = tuple(sorted(role for role, views in ROLE_ALLOWED_VIEWS.items() if "flotilla" in views))
INVENTORY_ROLES = tuple(sorted(role for role, views in ROLE_ALLOWED_VIEWS.items() if "inventario" in views))
LAB_ROLES = tuple(sorted(role for role, views in ROLE_ALLOWED_VIEWS.items() if "laboratorio" in views))
DEFAULT_USERS = (
    {"username": "admin", "role": "administrador", "password": "Admin#2026!"},
    {"username": "jefe_planta", "role": "jefe-de-planta", "password": "Planta#2026!"},
    {"username": "dosificador", "role": "dosificador", "password": "Dosi#2026!"},
    {"username": "presupuestador", "role": "presupuestador", "password": "Presu#2026!"},
    {"username": "laboratorista", "role": "laboratorista", "password": "Lab#2026!"},
)
AUTH_MAX_FAILED = 5
AUTH_LOCK_MINUTES = 15

CANONICAL_HEADER_ALIASES = {
    "no": ("no", "numero", "num", "n"),
    "formula": ("formula", "formulacion", "mix", "diseno", "diseÃ±o"),
    "cod": ("cod", "codigo", "clave"),
    "fc": ("fc", "fcr", "resistencia", "resistenciadiseno", "resistenciadiseÃ±o"),
    "edad": ("edad", "dias", "dia"),
    "tipo": ("tipo", "coloc", "colocacion", "colocaciÃ³n"),
    "tma": ("tma", "tmamax", "tamanoagregado", "tamanomaximoagregado", "tamaÃ±omaximoagregado"),
    "rev": ("rev", "revenimiento", "slump"),
    "comp": ("comp", "complemento", "var", "aditivo"),
    "family": ("familia", "family", "familia_mix", "fam"),
    "fecha_modif": ("fechamodif", "fechamodificacion", "ultimafecha", "modificado"),
}

CANONICAL_HEADER_DISPLAY = {
    "no": "No",
    "formula": "Formula",
    "cod": "COD",
    "fc": "f'c",
    "edad": "Edad",
    "tipo": "Tipo",
    "tma": "T.M.A.",
    "rev": "Rev",
    "comp": "Comp",
    "family": "Familia",
    "fecha_modif": "FECHA_MODIF",
}
DEFAULT_USER_PASSWORD = {(item["username"] or "").strip().lower(): item["password"] for item in DEFAULT_USERS}


class ConcurrencyError(Exception):
    pass


def now_str() -> str:
    return get_now().strftime("%Y-%m-%d %H:%M:%S")


def norm_header(text: str) -> str:
    base = re.sub(r"\s*\([^)]*\)\s*$", "", (text or "").strip())
    decomp = unicodedata.normalize("NFD", base)
    no_acc = "".join(ch for ch in decomp if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-zA-Z0-9]", "", no_acc).lower()


def sanitize_cell(value: str) -> str:
    text = str(value).replace("\x00", "").strip()
    if not text:
        return ""
    if text[0] in ("=", "@"):
        return "'" + text
    if text[0] in ("+", "-"):
        if re.fullmatch(r"[+-]?\d+([.,]\d+)?", text):
            return text
        return "'" + text
    return text


def detect_encoding(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            raw.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return "latin-1"


def detect_delim(text: str) -> str:
    try:
        return csv.Sniffer().sniff(text[:8192], delimiters=";,|\t").delimiter
    except csv.Error:
        return ";"


def parse_csv_bytes(raw: bytes) -> tuple[list[str], list[list[str]], str, str]:
    encoding = detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delim = detect_delim(text)
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    if not rows:
        return [], [], encoding, delim
    headers = [sanitize_cell(h) for h in rows[0]]
    width = len(headers)
    body = []
    for row in rows[1:]:
        norm = (row + [""] * width)[:width]
        body.append([sanitize_cell(v) for v in norm])
    return headers, body, encoding, delim


def decode_json_payload(body: bytes) -> dict:
    last = None
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return json.loads(body.decode(enc))
        except Exception as exc:
            last = exc
    raise ValueError(f"Invalid JSON payload: {last}")


def content_hash(headers: list[str], rows: list[list[str]]) -> str:
    s = json.dumps({"headers": headers, "rows": rows}, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def normalize_family_code(value: str | None, allow_empty: bool = False) -> str:
    text = (value or "").strip().upper()
    if not text:
        if allow_empty:
            return ""
        raise ValueError("La familia es requerida.")
    if not re.fullmatch(r"[A-Z0-9]{1,12}", text):
        raise ValueError("Formato de familia invalido. Usa solo letras/numeros (max 12).")
    return text


def guess_family_from_filename(filename: str | None) -> str:
    stem = Path((filename or "").strip()).stem.upper()
    if not stem:
        return ""
    explicit = re.search(r"(?:^|[_-])FAM(?:ILIA)?[_-]?([A-Z0-9]{1,12})(?:[_-]|$)", stem)
    if explicit:
        try:
            return normalize_family_code(explicit.group(1), allow_empty=False)
        except ValueError:
            pass
    lead_digits = re.match(r"^\s*(\d{2,6})", stem)
    if lead_digits:
        digits = lead_digits.group(1)
        if len(digits) >= 4:
            # Common naming pattern: family + TMA (e.g. 7020 -> family 70).
            return digits[:2]
        return digits
    token = re.search(r"(?:^|[_-])([A-Z]?\d{2,3})(?:[_-]|$)", stem)
    if token:
        candidate = token.group(1)
        try:
            return normalize_family_code(candidate, allow_empty=False)
        except ValueError:
            return ""
    return ""


def normalize_remision_no(value: str | None) -> str:
    text = (value or "").strip().upper()
    if not text:
        raise ValueError("El numero de remision es requerido.")
    if not re.fullmatch(r"[A-Z0-9/_-]{1,40}", text):
        raise ValueError("Formato de remision invalido. Usa letras/numeros y - _ / (max 40).")
    return text


def normalize_remision_field(
    value: str | None,
    field_name: str,
    *,
    required: bool = False,
    max_len: int = 180,
) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"El campo {field_name} es requerido.")
    if len(text) > max_len:
        raise ValueError(f"El campo {field_name} excede el maximo de {max_len} caracteres.")
    return text


def canonical_key_for_header(header: str) -> str | None:
    n = norm_header(header)
    if not n:
        return None
    for canonical, aliases in CANONICAL_HEADER_ALIASES.items():
        if n in {norm_header(alias) for alias in aliases}:
            return canonical
    return None


def apply_header_mapping(headers: list[str]) -> tuple[list[str], list[dict[str, str]]]:
    mapped = []
    changes = []
    used = set()
    for raw in headers:
        source = sanitize_cell(raw)
        canonical = canonical_key_for_header(source)
        target = source
        if canonical:
            candidate = CANONICAL_HEADER_DISPLAY.get(canonical, source)
            if candidate not in used:
                target = candidate
        if target in used:
            base = target or "Columna"
            i = 2
            while f"{base}_{i}" in used:
                i += 1
            target = f"{base}_{i}"
        used.add(target)
        mapped.append(target)
        if source != target:
            changes.append({"from": source, "to": target})
    return mapped, changes


def validate_password_policy(password: str) -> str | None:
    text = (password or "").strip()
    if len(text) < 10:
        return "La contrasena debe tener al menos 10 caracteres."
    if not re.search(r"[A-Z]", text):
        return "La contrasena debe incluir al menos una letra mayuscula."
    if not re.search(r"[a-z]", text):
        return "La contrasena debe incluir al menos una letra minuscula."
    if not re.search(r"\d", text):
        return "La contrasena debe incluir al menos un numero."
    if not re.search(r"[^A-Za-z0-9]", text):
        return "La contrasena debe incluir al menos un simbolo."
    return None


def validate_dataset(headers: list[str], rows: list[list[str]]) -> dict:
    errors, warnings = [], []
    hnorm = [norm_header(h) for h in headers]
    hset = set(hnorm)
    if len(headers) == 0:
        errors.append("El CSV no contiene encabezados.")
    if len(headers) > MAX_COLUMNS:
        errors.append(f"El CSV excede el maximo de columnas ({MAX_COLUMNS}).")
    if len(rows) > MAX_ROWS:
        errors.append(f"El CSV excede el maximo de filas ({MAX_ROWS}).")
    req_groups = {
        "formula": {"formula"},
        "cod": {"cod"},
        "fc": {"fc"},
        "edad": {"edad"},
        "coloc": {"coloc", "tipo"},
        "tma": {"tma"},
        "rev": {"rev"},
        "comp": {"var", "comp", "complemento"},
    }
    missing = [name for name, keys in req_groups.items() if not (hset & keys)]
    if missing:
        errors.append(f"Faltan columnas requeridas: {', '.join(missing)}")
    dupes = sorted({h for h in headers if headers.count(h) > 1})
    if dupes:
        warnings.append("Encabezados duplicados: " + ", ".join(dupes))
    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "stats": {"rows": len(rows), "columns": len(headers)},
    }


def default_qc_values() -> dict:
    return {
        agg: {"pvs": 0.0, "pvc": 0.0, "densidad": 0.0, "absorcion": 0.0, "humedad": 0.0}
        for agg in QC_AGGREGATES
    }


def _to_qc_number(value) -> float:
    text = str(value if value is not None else "").strip().replace(",", ".")
    if text == "":
        return 0.0
    num = float(text)
    if num < 0:
        raise ValueError("Los valores de control de calidad no pueden ser negativos.")
    if num > 1_000_000:
        raise ValueError("Un valor de control de calidad excede el limite permitido.")
    return num


def sanitize_qc_values(values: dict | None) -> dict:
    src = values if isinstance(values, dict) else {}
    clean = default_qc_values()
    for agg in QC_AGGREGATES:
        row = src.get(agg) if isinstance(src.get(agg), dict) else {}
        for field in QC_FIELDS:
            clean[agg][field] = _to_qc_number(row.get(field, 0))
    return clean


def default_doser_params() -> dict:
    return {
        "cemento_pesp": 3.10,
        "aire_pct": 2.0,
        "pasa_malla_200_pct": 19.0,
        "pxl_pond_pct": 6.4,
        "densidad_agregado_fallback": 2.20,
    }


def sanitize_doser_params(values: dict | None) -> dict:
    src = values if isinstance(values, dict) else {}
    base = default_doser_params()
    clean = {}
    for field in DOSER_PARAM_FIELDS:
        raw = src.get(field, base[field])
        text = str(raw if raw is not None else "").strip().replace(",", ".")
        num = float(text) if text else float(base[field])
        if num < 0:
            raise ValueError(f"Parametro invalido ({field}): no puede ser negativo.")
        if num > 1_000_000:
            raise ValueError(f"Parametro invalido ({field}): excede el limite permitido.")
        clean[field] = num
    return clean


def normalize_username(text: str) -> str:
    return (text or "").strip().lower()


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
        # Stored timestamps are naive text; localize back to Puerto Morelos timezone for safe comparisons.
        return PUERTO_MORELOS_TZ.localize(parsed)
    except ValueError:
        return None


def load_or_create_secret(base_dir: Path) -> str:
    env_secret = os.getenv("APP_SECRET_KEY", "").strip()
    if env_secret:
        return env_secret
    path = base_dir / ".app_secret_key"
    if path.exists():
        text = path.read_text(encoding="utf-8").strip()
        if text:
            return text
    key = secrets.token_hex(32)
    path.write_text(key, encoding="utf-8")
    return key


from fleet_store import FleetStoreMixin
from inventory_store import InventoryStoreMixin
from qc_store import QCLabStoreMixin
from user_store import UserStoreMixin

class AppStore(FleetStoreMixin, InventoryStoreMixin, QCLabStoreMixin, UserStoreMixin):
    def __init__(self, base_dir: Path, csv_file: str | None = None, db_url: str | None = None):
        self.base_dir = base_dir.resolve()
        self.db_url = db_url
        self.db_path = self.base_dir / "mix_data.sqlite3"
        self.snapshot_dir = self.base_dir / "backups" / "db_snapshots"
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.is_postgres = bool(db_url and POSTGRES_AVAILABLE)
        self.pg_pool = None
        if self.is_postgres:
            # Revert keepalives since setsockopt might fail in Render sandboxed containers
            self.pg_pool = ThreadedConnectionPool(1, 20, self.db_url)
        self._init_db()
        self._bootstrap(csv_file)

    def _conn(self):
        if self.is_postgres:
            return self._wrap_pg_conn(self.pg_pool.getconn())
        else:
            conn = sqlite3.connect(self.db_path, timeout=30.0)
            conn.row_factory = sqlite3.Row
            return conn

    def _wrap_pg_conn(self, pg_conn):
        pool = getattr(self, "pg_pool", None)
        # Un pequeÃ±o wrapper para que las llamadas .execute(?) de SQLite funcionen en PG
        class PGWrapper:
            def __init__(self, conn): 
                self.conn = conn
            def __enter__(self): return self
            def __exit__(self, exc_type, exc_val, exc_tb): 
                try:
                    if exc_type: 
                        try:
                            self.conn.rollback()
                        except Exception:
                            pass
                    else: 
                        try:
                            self.conn.commit()
                        except Exception:
                            pass
                finally:
                    if pool: 
                        try:
                            # Discard broken connection instead of returning it to the pool
                            if getattr(self.conn, "closed", 0) != 0:
                                pool.putconn(self.conn, close=True)
                            else:
                                pool.putconn(self.conn)
                        except Exception:
                            pass
                    else: 
                        try:
                            self.conn.close()
                        except Exception:
                            pass
            def execute(self, sql, params=()):
                cur = self.conn.cursor(cursor_factory=RealDictCursor)
                # Traducir placeholders ? -> %s
                query = sql.replace("?", "%s")
                
                # Manejar INSERT OR IGNORE de forma genÃ©rica para PostgreSQL
                if "INSERT OR IGNORE" in query.upper():
                    query = query.replace("INSERT OR IGNORE", "INSERT")
                    m = re.search(r"INTO\s+(\w+)", query, re.IGNORECASE)
                    if m:
                        table = m.group(1).lower()
                        keys = {"users": "username", "datasets": "name", "app_state": "key", "remisiones": "remision_no"}
                        if table in keys:
                            query += f" ON CONFLICT ({keys[table]}) DO NOTHING"
                
                # Traducir tipos de datos si se colÃ³ alguno manual
                if "INTEGER PRIMARY KEY AUTOINCREMENT" in query.upper():
                    query = query.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
                if "REAL" in query.upper() and "DOUBLE PRECISION" not in query.upper():
                    query = query.replace("REAL", "DOUBLE PRECISION")
                
                cur.execute(query, params)
                return cur
            def executescript(self, sql):
                with self.conn.cursor() as cur:
                    # Dividir por ; y ejecutar
                    for statement in sql.split(";"):
                        if statement.strip():
                            self.execute(statement)
            def commit(self): self.conn.commit()
            def rollback(self): self.conn.rollback()
            def close(self): self.conn.close()
        return PGWrapper(pg_conn)

    def _columns(self, conn, table_name: str) -> set[str]:
        if self.is_postgres:
            with conn.conn.cursor() as cur:
                cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = %s", (table_name.lower(),))
                return {r[0] for r in cur.fetchall()}
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return {r["name"] for r in rows}

    def _ensure_column(self, conn, table_name: str, column_name: str, ddl: str):
        if column_name in self._columns(conn, table_name):
            return
        if self.is_postgres:
            ddl = ddl.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY").replace("REAL", "DOUBLE PRECISION")
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl}")

    def _init_db(self):
        id_type = "SERIAL PRIMARY KEY" if self.is_postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"
        real_type = "DOUBLE PRECISION" if self.is_postgres else "REAL"
        
        with self._conn() as conn:
            conn.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS datasets(
                  id {id_type},
                  name TEXT NOT NULL UNIQUE,
                  family_code TEXT NOT NULL DEFAULT '',
                  headers_json TEXT NOT NULL,
                  rows_json TEXT NOT NULL,
                  encoding TEXT NOT NULL,
                  delimiter TEXT NOT NULL,
                  content_hash TEXT NOT NULL,
                  row_count INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1,
                  deleted_at TEXT
                );
                CREATE TABLE IF NOT EXISTS dataset_revisions(
                  id {id_type},
                  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
                  headers_json TEXT NOT NULL,
                  rows_json TEXT NOT NULL,
                  content_hash TEXT NOT NULL,
                  row_count INTEGER NOT NULL DEFAULT 0,
                  note TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_state(
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS upload_staging(
                  token TEXT PRIMARY KEY,
                  original_name TEXT NOT NULL,
                  headers_json TEXT NOT NULL,
                  rows_json TEXT NOT NULL,
                  encoding TEXT NOT NULL,
                  delimiter TEXT NOT NULL,
                  content_hash TEXT NOT NULL,
                  validation_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS qc_profiles(
                  dataset_id INTEGER PRIMARY KEY REFERENCES datasets(id),
                  values_json TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS doser_profiles(
                  dataset_id INTEGER PRIMARY KEY REFERENCES datasets(id),
                  params_json TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users(
                  id {id_type},
                  username TEXT NOT NULL UNIQUE,
                  role TEXT NOT NULL,
                  password_hash TEXT NOT NULL,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  must_change_password INTEGER NOT NULL DEFAULT 0,
                  password_updated_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  last_login_at TEXT
                );
                CREATE TABLE IF NOT EXISTS auth_locks(
                  username TEXT PRIMARY KEY,
                  failed_count INTEGER NOT NULL DEFAULT 0,
                  locked_until TEXT,
                  last_failed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS remisiones(
                  id {id_type},
                  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
                  remision_no TEXT NOT NULL UNIQUE,
                  formula TEXT NOT NULL DEFAULT '',
                  fc TEXT NOT NULL DEFAULT '',
                  edad TEXT NOT NULL DEFAULT '',
                  tipo TEXT NOT NULL DEFAULT '',
                  tma TEXT NOT NULL DEFAULT '',
                  rev TEXT NOT NULL DEFAULT '',
                  comp TEXT NOT NULL DEFAULT '',
                  cliente TEXT NOT NULL DEFAULT '',
                  ubicacion TEXT NOT NULL DEFAULT '',
                  dosificacion_m3 {real_type} NOT NULL DEFAULT 0,
                  peso_receta {real_type} NOT NULL DEFAULT 0,
                  peso_teorico_total {real_type} NOT NULL DEFAULT 0,
                  peso_real_total {real_type} NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'abierta',
                  snapshot_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  created_by TEXT NOT NULL DEFAULT '',
                  updated_at TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_remisiones_dataset_created ON remisiones(dataset_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_remisiones_created ON remisiones(created_at DESC);
                CREATE TABLE IF NOT EXISTS audit_log(
                  id {id_type},
                  created_at TEXT NOT NULL,
                  username TEXT NOT NULL DEFAULT '',
                  action TEXT NOT NULL,
                  entity TEXT NOT NULL DEFAULT '',
                  entity_id TEXT NOT NULL DEFAULT '',
                  dataset_id INTEGER,
                  details_json TEXT NOT NULL DEFAULT '{{}}'
                );
                CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_audit_dataset_created ON audit_log(dataset_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS materials(
                  id {id_type},
                  name TEXT NOT NULL UNIQUE,
                  doser_alias TEXT NOT NULL DEFAULT '',
                  unit TEXT NOT NULL DEFAULT 'kg',
                  current_stock {real_type} NOT NULL DEFAULT 0,
                  min_stock {real_type} NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'activo',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS inventory_transactions(
                  id {id_type},
                  material_id INTEGER NOT NULL REFERENCES materials(id),
                  transaction_type TEXT NOT NULL,
                  amount {real_type} NOT NULL DEFAULT 0,
                  reference TEXT NOT NULL DEFAULT '',
                  actor TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_inv_trx_created ON inventory_transactions(created_at DESC);
                CREATE TABLE IF NOT EXISTS qc_samples(
                  id {id_type},
                  sample_code TEXT NOT NULL UNIQUE,
                  cast_date TEXT NOT NULL,
                  remision_id TEXT NOT NULL DEFAULT '',
                  fc_expected {real_type} NOT NULL DEFAULT 0,
                  slump_cm {real_type} NOT NULL DEFAULT 0,
                  temperature_c {real_type} NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  actor TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_qc_samples_cast_date ON qc_samples(cast_date DESC);
                CREATE TABLE IF NOT EXISTS qc_cylinders(
                  id {id_type},
                  sample_id INTEGER NOT NULL REFERENCES qc_samples(id),
                  target_age_days INTEGER NOT NULL DEFAULT 28,
                  expected_test_date TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'pendiente',
                  strength_kgcm2 {real_type} NOT NULL DEFAULT 0,
                  break_date TEXT,
                  image_path TEXT NOT NULL DEFAULT '',
                  notes TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_qc_cyl_expected_date ON qc_cylinders(expected_test_date ASC);
                CREATE INDEX IF NOT EXISTS idx_qc_cyl_sample_id ON qc_cylinders(sample_id);
                CREATE TABLE IF NOT EXISTS vehicles(
                  id {id_type},
                  unit_number TEXT NOT NULL UNIQUE,
                  phone TEXT NOT NULL DEFAULT '',
                  year_model TEXT NOT NULL DEFAULT '',
                  serial_number TEXT NOT NULL DEFAULT '',
                  plate TEXT NOT NULL DEFAULT '',
                  driver TEXT NOT NULL DEFAULT '',
                  tank_capacity {real_type} NOT NULL DEFAULT 0,
                  expected_kml {real_type} NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'activo',
                  notes TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fuel_records(
                  id {id_type},
                  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
                  record_date TEXT NOT NULL,
                  odometer_km {real_type} NOT NULL DEFAULT 0,
                  liters {real_type} NOT NULL DEFAULT 0,
                  total_cost {real_type} NOT NULL DEFAULT 0,
                  price_per_liter {real_type} NOT NULL DEFAULT 0,
                  driver TEXT NOT NULL DEFAULT '',
                  station TEXT NOT NULL DEFAULT '',
                  km_traveled {real_type} NOT NULL DEFAULT 0,
                  kml_real {real_type} NOT NULL DEFAULT 0,
                  cost_per_km {real_type} NOT NULL DEFAULT 0,
                  notes TEXT NOT NULL DEFAULT '',
                  created_by TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_date ON fuel_records(vehicle_id, record_date DESC);
                CREATE TABLE IF NOT EXISTS maintenance_records(
                  id {id_type},
                  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
                  maintenance_type TEXT NOT NULL DEFAULT '',
                  description TEXT NOT NULL DEFAULT '',
                  cost {real_type} NOT NULL DEFAULT 0,
                  odometer_km {real_type} NOT NULL DEFAULT 0,
                  next_km {real_type} NOT NULL DEFAULT 0,
                  record_date TEXT NOT NULL,
                  provider TEXT NOT NULL DEFAULT '',
                  notes TEXT NOT NULL DEFAULT '',
                  created_by TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_maint_vehicle_date ON maintenance_records(vehicle_id, record_date DESC);
                """
            )
            # Re-implement bootstrap and migration logic for both engines...
            # Note: SERIAL and DOUBLE PRECISION are PG specific, sqlite3 handles them via fallback or wrapper translations.
            # Schema migration for older databases.
            self._ensure_column(conn, "datasets", "family_code", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "datasets", "content_hash", "TEXT")
            self._ensure_column(conn, "datasets", "row_count", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "datasets", "version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(conn, "datasets", "deleted_at", "TEXT")
            self._ensure_column(conn, "dataset_revisions", "content_hash", "TEXT")
            self._ensure_column(conn, "dataset_revisions", "row_count", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "dataset_revisions", "note", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "qc_profiles", "values_json", "TEXT NOT NULL DEFAULT '{}'")
            self._ensure_column(conn, "qc_profiles", "version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(conn, "qc_profiles", "updated_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "doser_profiles", "params_json", "TEXT NOT NULL DEFAULT '{}'")
            self._ensure_column(conn, "doser_profiles", "version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(conn, "doser_profiles", "updated_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "role", "TEXT NOT NULL DEFAULT 'presupuestador'")
            self._ensure_column(conn, "users", "password_hash", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "is_active", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(conn, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "users", "password_updated_at", "TEXT")
            self._ensure_column(conn, "users", "created_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "updated_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "users", "last_login_at", "TEXT")
            self._ensure_column(conn, "qc_cylinders", "load_total", f"{real_type} NOT NULL DEFAULT 0")
            self._ensure_column(conn, "qc_cylinders", "diameter_cm", f"{real_type} NOT NULL DEFAULT 0")
            self._ensure_column(conn, "qc_cylinders", "area_cm2", f"{real_type} NOT NULL DEFAULT 0")
            self._ensure_column(conn, "qc_cylinders", "correction_factor", f"{real_type} NOT NULL DEFAULT 1")
            self._ensure_column(conn, "remisiones", "status", "TEXT NOT NULL DEFAULT 'abierta'")
            self._ensure_column(conn, "remisiones", "created_by", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "remisiones", "updated_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "remisiones", "version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(conn, "remisiones", "cliente", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "remisiones", "ubicacion", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "created_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "username", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "action", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "entity", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "entity_id", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(conn, "audit_log", "dataset_id", "INTEGER")
            self._ensure_column(conn, "audit_log", "details_json", "TEXT NOT NULL DEFAULT '{}'")

            now = now_str()
            for item in DEFAULT_USERS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO users(username,role,password_hash,is_active,must_change_password,password_updated_at,created_at,updated_at,last_login_at)
                    VALUES(?,?,?,?,?,?,?, ?,NULL)
                    """,
                    (
                        normalize_username(item["username"]),
                        item["role"],
                        generate_password_hash(item["password"]),
                        1,
                        1,
                        "",
                        now,
                        now,
                    ),
                )

            # Force password change if a default credential hash is still active.
            for uname, plain in DEFAULT_USER_PASSWORD.items():
                row = conn.execute(
                    "SELECT id,password_hash FROM users WHERE username=? LIMIT 1",
                    (uname,),
                ).fetchone()
                if not row:
                    continue
                if check_password_hash(row["password_hash"] or "", plain):
                    conn.execute(
                        "UPDATE users SET must_change_password=1, updated_at=? WHERE id=?",
                        (now, int(row["id"])),
                    )

            missing_hash_rows = conn.execute(
                "SELECT id, headers_json, rows_json FROM datasets WHERE content_hash IS NULL OR row_count=0"
            ).fetchall()
            for row in missing_hash_rows:
                headers = json.loads(row["headers_json"])
                rows = json.loads(row["rows_json"])
                conn.execute(
                    "UPDATE datasets SET content_hash=?, row_count=? WHERE id=?",
                    (content_hash(headers, rows), len(rows), int(row["id"])),
                )

            missing_family_rows = conn.execute(
                "SELECT id,name FROM datasets WHERE family_code IS NULL OR TRIM(family_code)=''"
            ).fetchall()
            for row in missing_family_rows:
                fam = guess_family_from_filename(row["name"])
                conn.execute(
                    "UPDATE datasets SET family_code=? WHERE id=?",
                    (fam, int(row["id"])),
                )

    def _active_id(self, conn) -> int | None:
        row = conn.execute("SELECT value FROM app_state WHERE key='active_dataset_id'").fetchone()
        if row:
            try:
                did = int(row["value"])
                ok = conn.execute("SELECT 1 FROM datasets WHERE id=? AND deleted_at IS NULL", (did,)).fetchone()
                if ok:
                    return did
            except ValueError:
                pass
        row = conn.execute("SELECT id FROM datasets WHERE deleted_at IS NULL ORDER BY id LIMIT 1").fetchone()
        return int(row["id"]) if row else None

    def _set_active(self, conn, did: int):
        conn.execute(
            """
            INSERT INTO app_state(key,value) VALUES('active_dataset_id',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (str(did),),
        )

    def _audit(
        self,
        conn,
        action: str,
        username: str = "",
        entity: str = "",
        entity_id: str = "",
        dataset_id: int | None = None,
        details: dict | None = None,
    ):
        payload = details if isinstance(details, dict) else {}
        conn.execute(
            """
            INSERT INTO audit_log(created_at,username,action,entity,entity_id,dataset_id,details_json)
            VALUES(?,?,?,?,?,?,?)
            """,
            (
                now_str(),
                normalize_username(username),
                (action or "").strip()[:80],
                (entity or "").strip()[:40],
                (entity_id or "").strip()[:80],
                int(dataset_id) if dataset_id is not None else None,
                json.dumps(payload, ensure_ascii=False),
            ),
        )

    def _load_by_id(self, conn, did: int) -> dict:
        row = conn.execute("SELECT * FROM datasets WHERE id=? AND deleted_at IS NULL", (did,)).fetchone()
        if not row:
            raise FileNotFoundError("Dataset not found.")
        headers = json.loads(row["headers_json"])
        rows = json.loads(row["rows_json"])
        w = len(headers)
        rows = [(r + [""] * w)[:w] for r in rows]
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "family_code": (row["family_code"] or "").strip(),
            "headers": headers,
            "rows": rows,
            "encoding": row["encoding"],
            "delimiter": row["delimiter"],
            "content_hash": row["content_hash"],
            "row_count": int(row["row_count"]),
            "updated_at": row["updated_at"],
            "version": int(row["version"]),
        }

    def _insert_dataset(
        self,
        conn,
        name: str,
        headers: list[str],
        rows: list[list[str]],
        encoding: str,
        delimiter: str,
        family_code: str | None = None,
    ) -> int:
        base = name.strip() or "dataset.csv"
        candidate = base
        idx = 1
        while True:
            # Primero buscamos si el nombre exacto ya existe (activo o borrado)
            row = conn.execute("SELECT id, deleted_at FROM datasets WHERE name=?", (candidate,)).fetchone()
            if not row:
                break # Nombre libre
            
            if row["deleted_at"] is not None:
                # El nombre esta ocupado por un archivo borrado (Soft Delete antiguo).
                # Lo renombranos para liberarlo.
                old_id = int(row["id"])
                unique_suffix = f"__deleted__{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
                conn.execute("UPDATE datasets SET name=name || ? WHERE id=?", (unique_suffix, old_id))
                break # Ahora candidate esta libre
            else:
                # El nombre esta ocupado por un archivo ACTIVO. Generamos nuevo candidato.
                candidate = f"{Path(base).stem}_{idx}{Path(base).suffix or '.csv'}"
                idx += 1
        h = content_hash(headers, rows)
        created = now_str()
        fam = normalize_family_code(family_code, allow_empty=True) if family_code is not None else guess_family_from_filename(candidate)
        cur = conn.execute(
            """
            INSERT INTO datasets(name,family_code,headers_json,rows_json,encoding,delimiter,content_hash,row_count,created_at,updated_at,version,deleted_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL)
            """,
            (
                candidate,
                fam,
                json.dumps(headers, ensure_ascii=False),
                json.dumps(rows, ensure_ascii=False),
                encoding,
                delimiter,
                h,
                len(rows),
                created,
                created,
            ),
        )
        if self.is_postgres:
            row = conn.execute(
                "SELECT id FROM datasets WHERE name=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
                (candidate,),
            ).fetchone()
            return int(row["id"])
        return int(cur.lastrowid)

    def get_now(self) -> datetime:
        return get_now()

    def _bootstrap(self, csv_file: str | None):
        with self.lock:
            with self._conn() as conn:
                count = conn.execute("SELECT COUNT(*) c FROM datasets WHERE deleted_at IS NULL").fetchone()["c"]
                if count > 0:
                    if self._active_id(conn) is None:
                        first = conn.execute("SELECT id FROM datasets WHERE deleted_at IS NULL ORDER BY id LIMIT 1").fetchone()
                        if first:
                            self._set_active(conn, int(first["id"]))
                    return
                path = (self.base_dir / csv_file).resolve() if csv_file else None
                if not path or not path.exists():
                    cands = sorted(self.base_dir.glob("*.csv"))
                    path = cands[0] if cands else None
                if path and path.exists():
                    headers, rows, enc, delim = parse_csv_bytes(path.read_bytes())
                    headers, _ = apply_header_mapping(headers)
                    v = validate_dataset(headers, rows)
                    if not v["ok"]:
                        raise ValueError("CSV inicial invalido: " + "; ".join(v["errors"]))
                    did = self._insert_dataset(conn, path.name, headers, rows, enc, delim)
                else:
                    did = self._insert_dataset(conn, "dataset_principal.csv", [], [], "utf-8", ";")
                self._set_active(conn, did)

    def list_file_infos(self) -> list[dict[str, str]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT name,family_code FROM datasets WHERE deleted_at IS NULL ORDER BY name"
            ).fetchall()
            return [{"name": r["name"], "family": (r["family_code"] or "").strip()} for r in rows]

    def get_all_recipes_global(self) -> list[dict]:
        """Consolida todas las recetas de todos los archivos CSV activos para el buscador global del dosificador."""
        global_list = []
        with self._conn() as conn:
            datasets = conn.execute(
                "SELECT id, name, family_code, headers_json, rows_json, updated_at FROM datasets WHERE deleted_at IS NULL"
            ).fetchall()
            
            for ds in datasets:
                try:
                    headers = json.loads(ds["headers_json"])
                    rows = json.loads(ds["rows_json"])
                    name = ds["name"]
                    family_ds = (ds["family_code"] or "").strip()
                    updated = ds["updated_at"]
                    
                    # Convertir filas de lista a dict usando headers normalizados
                    norm_headers = [norm_header(h) for h in headers]
                    
                    for row in rows:
                        entry = {"_source": name, "_updated": updated}
                        for i, h in enumerate(norm_headers):
                            if i < len(row):
                                entry[h] = row[i]
                        
                        # Asegurar familia
                        if not entry.get("family") and family_ds:
                            entry["family"] = family_ds
                        
                        global_list.append(entry)
                except Exception:
                    continue
        return global_list

    def get_all_families_summary(self) -> list[dict]:
        """Extrae combinaciones únicas de Familia y T.M.A. de todos los archivos CSV activos."""
        summary = {}
        with self._conn() as conn:
            datasets = conn.execute(
                "SELECT id, name, family_code, headers_json, rows_json FROM datasets WHERE deleted_at IS NULL"
            ).fetchall()
            
            for ds in datasets:
                try:
                    headers = json.loads(ds["headers_json"])
                    rows = json.loads(ds["rows_json"])
                    
                    # Identificar indices TMA y Familia
                    tma_idx = -1
                    fam_idx = -1
                    for i, h in enumerate(headers):
                        h_norm = norm_header(h)
                        if any(a in h_norm for a in CANONICAL_HEADER_ALIASES["tma"]):
                            tma_idx = i
                        if any(a in h_norm for a in CANONICAL_HEADER_ALIASES["family"]):
                            fam_idx = i
                    
                    for row in rows:
                        tma = str(row[tma_idx]).strip() if tma_idx >= 0 and tma_idx < len(row) else "Sin TMA"
                        # Priorizar familia del dataset si existe, sino intentar extraer de la fila
                        row_fam = str(row[fam_idx]).strip() if fam_idx >= 0 and fam_idx < len(row) else ""
                        family = (ds["family_code"] or row_fam or "Sin Familia").strip()
                        
                        key = (tma, family)
                        if key not in summary:
                            summary[key] = {
                                "tma": tma,
                                "family": family,
                                "file": ds["name"],
                                "count": 0
                            }
                        summary[key]["count"] += 1
                except Exception:
                    continue
        
        # Convertir a lista y ordenar por TMA y Familia
        result = list(summary.values())
        result.sort(key=lambda x: (x["tma"], x["family"]))
        return result

    def list_files(self) -> list[str]:
        infos = self.list_file_infos()
        return [item["name"] for item in infos]

    def set_dataset_family(self, family_code: str, dataset_name: str | None = None, actor: str = "") -> dict[str, str]:
        fam = normalize_family_code(family_code, allow_empty=False)
        with self.lock:
            self._snapshot_db("before_family_update")
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                conn.execute(
                    "UPDATE datasets SET family_code=?, updated_at=?, version=version+1 WHERE id=?",
                    (fam, now_str(), ds["id"]),
                )
                self._audit(
                    conn,
                    action="dataset.family.update",
                    username=actor,
                    entity="dataset",
                    entity_id=str(ds["id"]),
                    dataset_id=ds["id"],
                    details={"file": ds["name"], "family": fam},
                )
                return {"file": ds["name"], "family": fam}

    def load_active(self) -> dict:
        with self.lock:
            with self._conn() as conn:
                did = self._active_id(conn)
                if did is None:
                    raise FileNotFoundError("No active dataset.")
                return self._load_by_id(conn, did)

    def set_active_file(self, dataset_name: str) -> str:
        clean = (dataset_name or "").strip()
        if not clean:
            raise ValueError("Dataset name is required.")
        with self.lock:
            with self._conn() as conn:
                row = conn.execute("SELECT id FROM datasets WHERE name=? AND deleted_at IS NULL", (clean,)).fetchone()
                if not row:
                    raise FileNotFoundError(f"Dataset not found: {clean}")
                self._set_active(conn, int(row["id"]))
                return clean

    def _resolve_dataset(self, conn: sqlite3.Connection, dataset_name: str | None = None) -> dict:
        if dataset_name:
            return self._get_by_name(conn, dataset_name.strip())
        did = self._active_id(conn)
        if did is None:
            raise FileNotFoundError("No active dataset.")
        return self._load_by_id(conn, did)

    def load_qc(self, dataset_name: str | None = None) -> dict:
        with self.lock:
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                # First try to load the profile specifically for this dataset
                row = conn.execute(
                    "SELECT values_json,version,updated_at FROM qc_profiles WHERE dataset_id=?",
                    (ds["id"],),
                ).fetchone()
                
                # If no profile exists for this dataset, find the most recently updated profile in the database
                if not row:
                    row = conn.execute(
                        "SELECT values_json,version,updated_at FROM qc_profiles ORDER BY updated_at DESC LIMIT 1"
                    ).fetchone()
                
                if not row:
                    return {
                        "file": ds["name"],
                        "version": 0,
                        "updated_at": "",
                        "values": default_qc_values(),
                    }
                raw = json.loads(row["values_json"] or "{}")
                try:
                    values = sanitize_qc_values(raw)
                except Exception:
                    values = default_qc_values()
                return {
                    "file": ds["name"],
                    "version": int(row["version"] or 0),
                    "updated_at": row["updated_at"] or "",
                    "values": values,
                }

    def save_qc(
        self,
        values: dict,
        expected_version: int | None = None,
        dataset_name: str | None = None,
        actor: str = "",
    ) -> dict:
        clean_values = sanitize_qc_values(values)
        with self.lock:
            self._snapshot_db("before_qc_save")
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                row = conn.execute(
                    "SELECT version FROM qc_profiles WHERE dataset_id=?",
                    (ds["id"],),
                ).fetchone()
                ts = now_str()
                if row:
                    curr_ver = int(row["version"] or 0)
                    if expected_version is not None and curr_ver != expected_version:
                        raise ConcurrencyError(
                            f"Version conflict. Current QC version is {curr_ver}, expected {expected_version}."
                        )
                    new_ver = curr_ver + 1
                    conn.execute(
                        """
                        UPDATE qc_profiles
                        SET values_json=?, version=?, updated_at=?
                        WHERE dataset_id=?
                        """,
                        (json.dumps(clean_values, ensure_ascii=False), new_ver, ts, ds["id"]),
                    )
                else:
                    if expected_version not in (None, 0):
                        raise ConcurrencyError(
                            f"Version conflict. Current QC version is 0, expected {expected_version}."
                        )
                    new_ver = 1
                    conn.execute(
                        """
                        INSERT INTO qc_profiles(dataset_id,values_json,version,updated_at)
                        VALUES(?,?,?,?)
                        """,
                        (ds["id"], json.dumps(clean_values, ensure_ascii=False), new_ver, ts),
                    )
                self._audit(
                    conn,
                    action="qc.save",
                    username=actor,
                    entity="qc_profile",
                    entity_id=str(ds["id"]),
                    dataset_id=ds["id"],
                    details={"file": ds["name"], "version": new_ver},
                )
                return {"file": ds["name"], "version": new_ver, "updated_at": ts, "values": clean_values}

    def save_qc_humidity(
        self,
        values: dict,
        expected_version: int | None = None,
        dataset_name: str | None = None,
        actor: str = "",
    ) -> dict:
        src = values if isinstance(values, dict) else {}
        humidity_by_agg = {}
        for agg in QC_AGGREGATES:
            row = src.get(agg) if isinstance(src.get(agg), dict) else {}
            humidity_by_agg[agg] = _to_qc_number(row.get("humedad", 0))

        with self.lock:
            self._snapshot_db("before_qc_humidity_save")
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                row = conn.execute(
                    "SELECT values_json,version FROM qc_profiles WHERE dataset_id=?",
                    (ds["id"],),
                ).fetchone()
                ts = now_str()
                if row:
                    curr_ver = int(row["version"] or 0)
                    if expected_version is not None and curr_ver != expected_version:
                        raise ConcurrencyError(
                            f"Version conflict. Current QC version is {curr_ver}, expected {expected_version}."
                        )
                    raw = json.loads(row["values_json"] or "{}")
                    try:
                        clean_values = sanitize_qc_values(raw)
                    except Exception:
                        clean_values = default_qc_values()
                    for agg in QC_AGGREGATES:
                        clean_values[agg]["humedad"] = humidity_by_agg[agg]
                    new_ver = curr_ver + 1
                    conn.execute(
                        """
                        UPDATE qc_profiles
                        SET values_json=?, version=?, updated_at=?
                        WHERE dataset_id=?
                        """,
                        (json.dumps(clean_values, ensure_ascii=False), new_ver, ts, ds["id"]),
                    )
                else:
                    if expected_version not in (None, 0):
                        raise ConcurrencyError(
                            f"Version conflict. Current QC version is 0, expected {expected_version}."
                        )
                    clean_values = default_qc_values()
                    for agg in QC_AGGREGATES:
                        clean_values[agg]["humedad"] = humidity_by_agg[agg]
                    new_ver = 1
                    conn.execute(
                        """
                        INSERT INTO qc_profiles(dataset_id,values_json,version,updated_at)
                        VALUES(?,?,?,?)
                        """,
                        (ds["id"], json.dumps(clean_values, ensure_ascii=False), new_ver, ts),
                    )
                self._audit(
                    conn,
                    action="qc.humidity.save",
                    username=actor,
                    entity="qc_profile",
                    entity_id=str(ds["id"]),
                    dataset_id=ds["id"],
                    details={"file": ds["name"], "version": new_ver},
                )
                return {"file": ds["name"], "version": new_ver, "updated_at": ts, "values": clean_values}

    def load_doser_params(self, dataset_name: str | None = None) -> dict:
        with self.lock:
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                row = conn.execute(
                    "SELECT params_json,version,updated_at FROM doser_profiles WHERE dataset_id=?",
                    (ds["id"],),
                ).fetchone()
                if not row:
                    return {
                        "file": ds["name"],
                        "version": 0,
                        "updated_at": "",
                        "values": default_doser_params(),
                    }
                raw = json.loads(row["params_json"] or "{}")
                try:
                    values = sanitize_doser_params(raw)
                except Exception:
                    values = default_doser_params()
                return {
                    "file": ds["name"],
                    "version": int(row["version"] or 0),
                    "updated_at": row["updated_at"] or "",
                    "values": values,
                }

    def save_doser_params(
        self,
        values: dict,
        expected_version: int | None = None,
        dataset_name: str | None = None,
        actor: str = "",
    ) -> dict:
        clean_values = sanitize_doser_params(values)
        with self.lock:
            self._snapshot_db("before_doser_params_save")
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                row = conn.execute(
                    "SELECT version FROM doser_profiles WHERE dataset_id=?",
                    (ds["id"],),
                ).fetchone()
                ts = now_str()
                if row:
                    curr_ver = int(row["version"] or 0)
                    if expected_version is not None and curr_ver != expected_version:
                        raise ConcurrencyError(
                            f"Version conflict. Current doser params version is {curr_ver}, expected {expected_version}."
                        )
                    new_ver = curr_ver + 1
                    conn.execute(
                        """
                        UPDATE doser_profiles
                        SET params_json=?, version=?, updated_at=?
                        WHERE dataset_id=?
                        """,
                        (json.dumps(clean_values, ensure_ascii=False), new_ver, ts, ds["id"]),
                    )
                else:
                    if expected_version not in (None, 0):
                        raise ConcurrencyError(
                            f"Version conflict. Current doser params version is 0, expected {expected_version}."
                        )
                    new_ver = 1
                    conn.execute(
                        """
                        INSERT INTO doser_profiles(dataset_id,params_json,version,updated_at)
                        VALUES(?,?,?,?)
                        """,
                        (ds["id"], json.dumps(clean_values, ensure_ascii=False), new_ver, ts),
                    )
                self._audit(
                    conn,
                    action="doser.params.save",
                    username=actor,
                    entity="doser_profile",
                    entity_id=str(ds["id"]),
                    dataset_id=ds["id"],
                    details={"file": ds["name"], "version": new_ver},
                )
                return {"file": ds["name"], "version": new_ver, "updated_at": ts, "values": clean_values}

    def save_remision(
        self,
        remision_no: str,
        snapshot: dict,
        cliente: str,
        ubicacion: str,
        dataset_name: str | None = None,
        created_by: str = "",
    ) -> dict:
        remision = normalize_remision_no(remision_no)
        snap = snapshot if isinstance(snapshot, dict) else {}
        cliente_norm = normalize_remision_field(cliente, "cliente", required=True)
        ubicacion_norm = normalize_remision_field(ubicacion, "ubicacion", required=True)
        snap["cliente"] = cliente_norm
        snap["ubicacion"] = ubicacion_norm

        def text(key: str) -> str:
            return str(snap.get(key, "")).strip()

        def number(key: str) -> float:
            try:
                return float(snap.get(key, 0) or 0)
            except (TypeError, ValueError):
                return 0.0

        with self.lock:
            self._snapshot_db("before_remision_save")
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                exists = conn.execute("SELECT 1 FROM remisiones WHERE remision_no=?", (remision,)).fetchone()
                if exists:
                    raise ValueError(f"La remision '{remision}' ya existe.")
                ts = now_str()
                conn.execute(
                    """
                    INSERT INTO remisiones(
                      dataset_id,remision_no,formula,fc,edad,tipo,tma,rev,comp,cliente,ubicacion,
                      dosificacion_m3,peso_receta,peso_teorico_total,peso_real_total,
                      status,snapshot_json,created_at,created_by,updated_at,version
                    )
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
                    """,
                    (
                        ds["id"],
                        remision,
                        text("formula"),
                        text("fc"),
                        text("edad"),
                        text("tipo"),
                        text("tma"),
                        text("rev"),
                        text("comp"),
                        cliente_norm,
                        ubicacion_norm,
                        number("dose"),
                        number("recipeWeight"),
                        number("theoreticalWeight"),
                        number("realWeight"),
                        "abierta",
                        json.dumps(snap, ensure_ascii=False),
                        ts,
                        normalize_username(created_by),
                        ts,
                    ),
                )
                row = conn.execute(
                    """
                    SELECT id,remision_no,formula,fc,edad,tipo,tma,rev,comp,cliente,ubicacion,dosificacion_m3,
                           peso_receta,peso_teorico_total,peso_real_total,status,created_at,created_by
                    FROM remisiones
                    WHERE remision_no=?
                    LIMIT 1
                    """,
                    (remision,),
                ).fetchone()
                self._audit(
                    conn,
                    action="remision.create",
                    username=created_by,
                    entity="remision",
                    entity_id=str(int(row["id"])),
                    dataset_id=ds["id"],
                    details={
                        "file": ds["name"],
                        "remision_no": remision,
                        "cliente": cliente_norm,
                        "ubicacion": ubicacion_norm,
                    },
                )

                # Auto-deduct inventory
                qc_data = self.load_qc(dataset_name=dataset_name)
                qc_values = qc_data.get("values", {})

                for rr in snap.get("realRows", []):
                    alias = str(rr.get("name", "")).strip()
                    mat_id_snap = rr.get("material_id")
                    peso_kg = float(rr.get("real", 0))
                    
                    if peso_kg > 0:
                        mat_row = None
                        if mat_id_snap:
                            mat_row = conn.execute(
                                "SELECT id, current_stock, unit FROM materials WHERE id=? AND status='activo'", 
                                (mat_id_snap,)
                            ).fetchone()
                        
                        if not mat_row and alias:
                            mat_row = conn.execute(
                                "SELECT id, current_stock, unit FROM materials WHERE doser_alias=? AND status='activo' LIMIT 1", 
                                (alias,)
                            ).fetchone()

                        if mat_row:
                            mat_id = int(mat_row["id"])
                            current_stock = float(mat_row["current_stock"])
                            unit = str(mat_row["unit"] or "kg").lower()
                            
                            # Conversion logic for aggregates if inventory is in m3
                            final_deduction = peso_kg
                            is_agg = alias in QC_AGGREGATES
                            
                            if is_agg and (unit == "m3" or unit == "m³"):
                                # Internal conversion kg -> m3
                                q = qc_values.get(alias, {})
                                pvs = float(q.get("pvs", 0))
                                pvc = float(q.get("pvc", 0))
                                
                                avg_pv = 0.0
                                if pvs > 0 and pvc > 0:
                                    avg_pv = (pvs + pvc) / 2
                                elif pvs > 0:
                                    avg_pv = pvs
                                elif pvc > 0:
                                    avg_pv = pvc
                                
                                if avg_pv > 0:
                                    # Convert to kg/L (standard for calculations in app.js as well)
                                    pv_kg_l = avg_pv / 1000.0 if avg_pv > 50 else avg_pv
                                    # result = (kg / (kg/L)) / 1000 = L / 1000 = m3
                                    final_deduction = (peso_kg / pv_kg_l) / 1000.0
                                else:
                                    # Fallback to density_agregado_fallback if no QC value
                                    params_data = self.load_doser_params(dataset_name=dataset_name)
                                    fallback = float(params_data.get("values", {}).get("densidad_agregado_fallback", 2.20))
                                    final_deduction = (peso_kg / fallback) / 1000.0

                            new_stock = current_stock - final_deduction
                            conn.execute(
                                """INSERT INTO inventory_transactions (material_id, transaction_type, amount, reference, actor, created_at)
                                   VALUES (?, 'SALIDA', ?, ?, ?, ?)""",
                                (mat_id, final_deduction, f"Remision #{remision}", "Auto", ts)
                            )
                            conn.execute(
                                "UPDATE materials SET current_stock=?, updated_at=? WHERE id=?",
                                (new_stock, ts, mat_id)
                            )

                return {
                    "id": int(row["id"]),
                    "remision_no": row["remision_no"],
                    "formula": row["formula"] or "",
                    "fc": row["fc"] or "",
                    "edad": row["edad"] or "",
                    "tipo": row["tipo"] or "",
                    "tma": row["tma"] or "",
                    "rev": row["rev"] or "",
                    "comp": row["comp"] or "",
                    "cliente": row["cliente"] or "",
                    "ubicacion": row["ubicacion"] or "",
                    "dosificacion_m3": float(row["dosificacion_m3"] or 0),
                    "peso_receta": float(row["peso_receta"] or 0),
                    "peso_teorico_total": float(row["peso_teorico_total"] or 0),
                    "peso_real_total": float(row["peso_real_total"] or 0),
                    "status": row["status"] or "abierta",
                    "created_at": row["created_at"] or "",
                    "created_by": row["created_by"] or "",
                    "file": ds["name"],
                }

    def list_remisiones(
        self,
        dataset_name: str | None = None,
        query: str = "",
        limit: int = 80,
        date_filter: str | None = None,
    ) -> dict:
        max_limit = max(1, min(int(limit or 80), 500))
        q = (query or "").strip().upper()
        
        # Si no hay filtro de fecha y es una consulta global (o incluso especifica),
        # podriamos querer por defecto el dia de hoy para no saturar.
        # Pero si el usuario borra el filtro de fecha explicitamente, tal vez quiera ver todo.
        # Por ahora, si date_filter es None, usaremos el dia de hoy como sugiere el usuario.
        final_date = date_filter
        if final_date is None:
             final_date = get_now().strftime("%Y-%m-%d")

        with self.lock:
            with self._conn() as conn:
                sql_where = []
                params = []

                if dataset_name and dataset_name.strip():
                    target_name = dataset_name.strip()
                    pattern = f"{target_name}__deleted__%"
                    ds_rows = conn.execute(
                        "SELECT id FROM datasets WHERE name = ? OR name LIKE ?",
                        (target_name, pattern)
                    ).fetchall()
                    ds_ids = [int(r["id"]) for r in ds_rows]
                    if ds_ids:
                        placeholders = ",".join(["?"] * len(ds_ids))
                        sql_where.append(f"r.dataset_id IN ({placeholders})")
                        params.extend(ds_ids)
                    else:
                        # Si se pidio un archivo que no existe
                        return {"file": target_name, "items": [], "global": False}

                if q:
                    sql_where.append("(r.remision_no LIKE ? OR r.formula LIKE ?)")
                    params.extend([f"%{q}%", f"%{q}%"])

                if final_date:
                    sql_where.append("r.created_at LIKE ?")
                    params.append(f"{final_date}%")

                where_clause = ""
                if sql_where:
                    where_clause = "WHERE " + " AND ".join(sql_where)

                sql = f"""
                    SELECT r.id, r.remision_no, r.formula, r.fc, r.edad, r.tipo, r.tma, r.rev, r.comp, r.dosificacion_m3,
                           r.cliente, r.ubicacion, r.peso_receta, r.peso_teorico_total, r.peso_real_total, r.status, r.created_at, r.created_by,
                           d.name as source_file
                    FROM remisiones r
                    JOIN datasets d ON r.dataset_id = d.id
                    {where_clause}
                    ORDER BY r.id DESC LIMIT ?
                """
                params.append(max_limit)

                rows = conn.execute(sql, params).fetchall()
                
                return {
                    "file": dataset_name or "Global",
                    "date_filter": final_date,
                    "is_global": not bool(dataset_name),
                    "items": [
                        {
                            "id": int(r["id"]),
                            "remision_no": r["remision_no"] or "",
                            "formula": r["formula"] or "",
                            "fc": r["fc"] or "",
                            "edad": r["edad"] or "",
                            "tipo": r["tipo"] or "",
                            "tma": r["tma"] or "",
                            "rev": r["rev"] or "",
                            "comp": r["comp"] or "",
                            "cliente": r["cliente"] or "",
                            "ubicacion": r["ubicacion"] or "",
                            "dosificacion_m3": float(r["dosificacion_m3"] or 0),
                            "peso_receta": float(r["peso_receta"] or 0),
                            "peso_teorico_total": float(r["peso_teorico_total"] or 0),
                            "peso_real_total": float(r["peso_real_total"] or 0),
                            "status": r["status"] or "abierta",
                            "created_at": r["created_at"] or "",
                            "created_by": r["created_by"] or "",
                            "source_file": r["source_file"] or "",
                        }
                        for r in rows
                    ],
                }

    def get_remision(self, remision_id: int, dataset_name: str | None = None) -> dict:
        rid = int(remision_id)
        if rid <= 0:
            raise ValueError("ID de remision invalido.")
        with self.lock:
            with self._conn() as conn:
                # Consulta global por ID, obteniendo el nombre del archivo mediante JOIN
                row = conn.execute(
                    """
                    SELECT r.id, r.remision_no, r.formula, r.fc, r.edad, r.tipo, r.tma, r.rev, r.comp, r.dosificacion_m3,
                           r.cliente, r.ubicacion, r.peso_receta, r.peso_teorico_total, r.peso_real_total, r.status, r.snapshot_json,
                           r.created_at, r.created_by, r.updated_at, r.version, r.dataset_id,
                           d.name as source_file
                    FROM remisiones r
                    JOIN datasets d ON r.dataset_id = d.id
                    WHERE r.id = ?
                    LIMIT 1
                    """,
                    (rid,),
                ).fetchone()
                
                if not row:
                    raise FileNotFoundError(f"Remision {rid} no encontrada.")

                target_name = row["source_file"]
                raw = json.loads(row["snapshot_json"] or "{}")
                snapshot = raw if isinstance(raw, dict) else {}
                if not snapshot.get("remisionNo"):
                    snapshot["remisionNo"] = row["remision_no"] or "-"
                if not snapshot.get("file"):
                    snapshot["file"] = target_name
                if not snapshot.get("cliente"):
                    snapshot["cliente"] = row["cliente"] or "-"
                if not snapshot.get("ubicacion"):
                    snapshot["ubicacion"] = row["ubicacion"] or "-"

                return {
                    "id": int(row["id"]),
                    "remision_no": row["remision_no"] or "",
                    "formula": row["formula"] or "",
                    "fc": row["fc"] or "",
                    "edad": row["edad"] or "",
                    "tipo": row["tipo"] or "",
                    "tma": row["tma"] or "",
                    "rev": row["rev"] or "",
                    "comp": row["comp"] or "",
                    "cliente": row["cliente"] or "",
                    "ubicacion": row["ubicacion"] or "",
                    "dosificacion_m3": float(row["dosificacion_m3"] or 0),
                    "peso_receta": float(row["peso_receta"] or 0),
                    "peso_teorico_total": float(row["peso_teorico_total"] or 0),
                    "peso_real_total": float(row["peso_real_total"] or 0),
                    "status": row["status"] or "abierta",
                    "created_at": row["created_at"] or "",
                    "created_by": row["created_by"] or "",
                    "updated_at": row["updated_at"] or "",
                    "version": int(row["version"] or 1),
                    "file": target_name,
                    "snapshot": snapshot,
                }

    def delete_remision(self, remision_id: int, dataset_name: str | None = None, actor: str = "") -> dict:
        rid = int(remision_id)
        if rid <= 0:
            raise ValueError("ID de remision invalido.")
        with self.lock:
            self._snapshot_db("before_remision_delete")
            with self._conn() as conn:
                # Consulta global por ID para identificar el origen y validar existencia
                row = conn.execute(
                    """
                    SELECT r.id, r.remision_no, r.dataset_id, d.name as source_file
                    FROM remisiones r
                    JOIN datasets d ON r.dataset_id = d.id
                    WHERE r.id = ?
                    LIMIT 1
                    """,
                    (rid,),
                ).fetchone()
                
                if not row:
                    raise FileNotFoundError(f"Remision {rid} no encontrada.")

                target_name = row["source_file"]
                did = row["dataset_id"]
                ts = now_str()
                ref = f"Remision #{row['remision_no'] or ''}"

                # Revert inventory impact generated when this remision was saved.
                reverse_rows = conn.execute(
                    """
                    SELECT material_id,
                           COALESCE(
                               SUM(
                                   CASE
                                       WHEN transaction_type='SALIDA' THEN amount
                                       WHEN transaction_type='ENTRADA' THEN -amount
                                       ELSE 0
                                   END
                               ),
                               0
                           ) AS revert_delta
                    FROM inventory_transactions
                    WHERE reference=?
                    GROUP BY material_id
                    """,
                    (ref,),
                ).fetchall()
                for rev in reverse_rows:
                    delta = float(rev["revert_delta"] or 0)
                    if abs(delta) <= 1e-12:
                        continue
                    conn.execute(
                        "UPDATE materials SET current_stock=current_stock + ?, updated_at=? WHERE id=?",
                        (delta, ts, int(rev["material_id"])),
                    )
                conn.execute("DELETE FROM inventory_transactions WHERE reference=?", (ref,))

                conn.execute("DELETE FROM remisiones WHERE id=?", (rid,))
                self._audit(
                    conn,
                    action="remision.delete",
                    username=actor,
                    entity="remision",
                    entity_id=str(int(row["id"])),
                    dataset_id=did,
                    details={
                        "file": target_name,
                        "remision_no": row["remision_no"] or "",
                        "inventory_reversed": len(reverse_rows),
                    },
                )
                return {
                    "id": int(row["id"]),
                    "remision_no": row["remision_no"] or "",
                    "file": target_name,
                }

    def _user_row(self, conn: sqlite3.Connection, username: str):
        return conn.execute(
            "SELECT id,username,role,password_hash,is_active,must_change_password,password_updated_at,last_login_at FROM users WHERE username=? LIMIT 1",
            (normalize_username(username),),
        ).fetchone()

    def auth_get_user(self, username: str) -> dict | None:
        with self._conn() as conn:
            row = self._user_row(conn, username)
            if not row or int(row["is_active"] or 0) != 1:
                return None
            role = (row["role"] or "").strip()
            if role not in ROLE_ALLOWED_VIEWS:
                return None
            return {
                "id": int(row["id"]),
                "username": row["username"],
                "role": role,
                "must_change_password": bool(int(row["must_change_password"] or 0)),
                "password_updated_at": row["password_updated_at"] or "",
                "last_login_at": row["last_login_at"] or "",
            }

    def _clear_auth_lock(self, conn: sqlite3.Connection, username: str):
        conn.execute("DELETE FROM auth_locks WHERE username=?", (normalize_username(username),))

    def _register_auth_fail(self, conn: sqlite3.Connection, username: str):
        uname = normalize_username(username)
        now = now_str()
        row = conn.execute("SELECT failed_count FROM auth_locks WHERE username=?", (uname,)).fetchone()
        failed = int(row["failed_count"]) + 1 if row else 1
        lock_until = None
        if failed >= AUTH_MAX_FAILED:
            lock_until = (get_now() + timedelta(minutes=AUTH_LOCK_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
            failed = 0
        conn.execute(
            """
            INSERT INTO auth_locks(username,failed_count,locked_until,last_failed_at)
            VALUES(?,?,?,?)
            ON CONFLICT(username) DO UPDATE SET
              failed_count=excluded.failed_count,
              locked_until=excluded.locked_until,
              last_failed_at=excluded.last_failed_at
            """,
            (uname, failed, lock_until, now),
        )
        return lock_until

    def auth_authenticate(self, username: str, password: str) -> dict:
        uname = normalize_username(username)
        if not uname or not password:
            raise ValueError("Usuario y contrasena son requeridos.")
        with self.lock:
            with self._conn() as conn:
                lock_row = conn.execute(
                    "SELECT failed_count,locked_until FROM auth_locks WHERE username=?",
                    (uname,),
                ).fetchone()
                if lock_row:
                    locked_until = parse_dt(lock_row["locked_until"])
                    if locked_until and locked_until > get_now():
                        mins = max(1, int((locked_until - get_now()).total_seconds() // 60))
                        msg = f"Cuenta bloqueada temporalmente. Intente en {mins} minutos."
                        raise PermissionError(msg)
                    if locked_until and locked_until <= get_now():
                        self._clear_auth_lock(conn, uname)

                row = self._user_row(conn, uname)
                ok = bool(
                    row
                    and int(row["is_active"] or 0) == 1
                    and (row["role"] or "") in ROLE_ALLOWED_VIEWS
                    and check_password_hash(row["password_hash"] or "", password)
                )
                if not ok:
                    lock_until = self._register_auth_fail(conn, uname)
                    conn.commit()
                    if lock_until:
                        raise PermissionError("Demasiados intentos fallidos. Cuenta bloqueada 15 min.")
                    raise ValueError("Credenciales invalidas.")

                self._clear_auth_lock(conn, uname)
                now = now_str()
                conn.execute(
                    "UPDATE users SET last_login_at=?, updated_at=? WHERE id=?",
                    (now, now, int(row["id"])),
                )
                return {
                    "id": int(row["id"]),
                    "username": row["username"],
                    "role": row["role"],
                    "must_change_password": bool(int(row["must_change_password"] or 0)),
                    "last_login_at": now,
                }

    def auth_change_password(self, username: str, current_password: str, new_password: str) -> dict:
        uname = normalize_username(username)
        if not uname:
            raise ValueError("Usuario invalido.")
        if not current_password:
            raise ValueError("La contrasena actual es requerida.")
        policy_error = validate_password_policy(new_password)
        if policy_error:
            raise ValueError(policy_error)

        with self.lock:
            with self._conn() as conn:
                row = self._user_row(conn, uname)
                if not row or int(row["is_active"] or 0) != 1:
                    raise PermissionError("Usuario no valido o inactivo.")
                if not check_password_hash(row["password_hash"] or "", current_password):
                    raise PermissionError("La contrasena actual no es correcta.")
                if check_password_hash(row["password_hash"] or "", new_password):
                    raise ValueError("La nueva contrasena debe ser distinta a la actual.")

                ts = now_str()
                conn.execute(
                    """
                    UPDATE users
                    SET password_hash=?, must_change_password=0, password_updated_at=?, updated_at=?
                    WHERE id=?
                    """,
                    (generate_password_hash(new_password), ts, ts, int(row["id"])),
                )
                self._clear_auth_lock(conn, uname)
                self._audit(
                    conn,
                    action="auth.password.change",
                    username=uname,
                    entity="user",
                    entity_id=str(int(row["id"])),
                    details={"username": uname},
                )
                return {
                    "id": int(row["id"]),
                    "username": row["username"],
                    "role": row["role"],
                    "must_change_password": False,
                    "password_updated_at": ts,
                }

    def _save_revision(self, conn: sqlite3.Connection, ds: dict, note: str):
        conn.execute(
            """
            INSERT INTO dataset_revisions(dataset_id,headers_json,rows_json,content_hash,row_count,note,created_at)
            VALUES(?,?,?,?,?,?,?)
            """,
            (ds["id"], json.dumps(ds["headers"], ensure_ascii=False), json.dumps(ds["rows"], ensure_ascii=False), ds["content_hash"], len(ds["rows"]), note, now_str()),
        )

    def save_active(
        self,
        headers: list[str],
        rows: list[list[str]],
        expected_version: int | None = None,
        actor: str = "",
    ) -> int:
        v = validate_dataset(headers, rows)
        if not v["ok"]:
            raise ValueError("; ".join(v["errors"]))
        w = len(headers)
        clean_rows = [[sanitize_cell(x) for x in (r + [""] * w)[:w]] for r in rows]
        with self.lock:
            self._snapshot_db("before_save")
            with self._conn() as conn:
                did = self._active_id(conn)
                if did is None:
                    raise FileNotFoundError("No active dataset.")
                ds = self._load_by_id(conn, did)
                if expected_version is not None and ds["version"] != expected_version:
                    raise ConcurrencyError(f"Version conflict. Current version is {ds['version']}, expected {expected_version}.")
                self._save_revision(conn, ds, "before save from editor")
                new_ver = ds["version"] + 1
                conn.execute(
                    """
                    UPDATE datasets
                    SET headers_json=?, rows_json=?, content_hash=?, row_count=?, updated_at=?, version=?
                    WHERE id=?
                    """,
                    (json.dumps(headers, ensure_ascii=False), json.dumps(clean_rows, ensure_ascii=False), content_hash(headers, clean_rows), len(clean_rows), now_str(), new_ver, did),
                )
                self._audit(
                    conn,
                    action="dataset.save",
                    username=actor,
                    entity="dataset",
                    entity_id=str(did),
                    dataset_id=did,
                    details={"file": ds["name"], "rows": len(clean_rows), "version": new_ver},
                )
                return new_ver

    def delete_file(self, dataset_name: str, actor: str = "") -> dict[str, str]:
        clean = (dataset_name or "").strip()
        if not clean:
            raise ValueError("Dataset name is required.")
        with self.lock:
            self._snapshot_db("before_delete")
            with self._conn() as conn:
                row = conn.execute("SELECT id FROM datasets WHERE name=? AND deleted_at IS NULL", (clean,)).fetchone()
                if not row:
                    raise FileNotFoundError(f"Dataset not found: {clean}")
                count = conn.execute("SELECT COUNT(*) c FROM datasets WHERE deleted_at IS NULL").fetchone()["c"]
                if count <= 1:
                    raise ValueError("No puedes eliminar el unico dataset disponible.")
                did = int(row["id"])
                # Renombrar para liberar el nombre original inmediatamente
                ts = now_str()
                unique_suffix = f"__deleted__{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
                new_name = f"{clean}{unique_suffix}"
                conn.execute(
                    "UPDATE datasets SET name=?, deleted_at=? WHERE id=?", 
                    (new_name, ts, did)
                )
                self._audit(
                    conn,
                    action="dataset.delete",
                    username=actor,
                    entity="dataset",
                    entity_id=str(did),
                    dataset_id=did,
                    details={"file": clean, "renamed_to": new_name},
                )
                aid = self._active_id(conn)
                if aid == did or aid is None:
                    nxt = conn.execute("SELECT id,name FROM datasets WHERE deleted_at IS NULL ORDER BY id LIMIT 1").fetchone()
                    self._set_active(conn, int(nxt["id"]))
                    active_name = nxt["name"]
                else:
                    active_name = self._load_by_id(conn, aid)["name"]
                return {"deleted": clean, "active": active_name}

    def purge_deleted_datasets(self, actor: str = "") -> dict:
        """Elimina fisicamente los datasets marcados como borrados."""
        with self.lock:
            self._snapshot_db("before_purge")
            with self._conn() as conn:
                # 1. Obtener IDs de los datasets borrados
                rows = conn.execute("SELECT id, name FROM datasets WHERE deleted_at IS NOT NULL").fetchall()
                if not rows:
                    return {"purged_count": 0, "message": "No hay datasets borrados para purgar."}
                
                deleted_ids = [int(r["id"]) for r in rows]
                deleted_names = [r["name"] for r in rows]
                
                placeholders = ",".join("?" * len(deleted_ids))
                
                # 2. Obtener remisiones vinculadas para limpiar inventario
                rem_rows = conn.execute(f"SELECT remision_no FROM remisiones WHERE dataset_id IN ({placeholders})", tuple(deleted_ids)).fetchall()
                remision_nos = [r["remision_no"] for r in rem_rows]
                
                # 3. Eliminar transacciones de inventario vinculadas
                if remision_nos:
                    # En SQLite/Postgres usamos LIKE o IN para las referencias
                    for rno in remision_nos:
                        ref = f"Remision #{rno}"
                        conn.execute("DELETE FROM inventory_transactions WHERE reference=?", (ref,))
                
                # 4. Eliminar remisiones
                conn.execute(f"DELETE FROM remisiones WHERE dataset_id IN ({placeholders})", tuple(deleted_ids))
                
                # 5. Eliminar revisiones asociadas
                conn.execute(f"DELETE FROM dataset_revisions WHERE dataset_id IN ({placeholders})", tuple(deleted_ids))
                
                # 6. Eliminar perfiles asociados (QC y Dosificador)
                conn.execute(f"DELETE FROM qc_profiles WHERE dataset_id IN ({placeholders})", tuple(deleted_ids))
                conn.execute(f"DELETE FROM doser_profiles WHERE dataset_id IN ({placeholders})", tuple(deleted_ids))
                
                # 7. Limpiar logs de auditoría (opcional, ponemos a NULL para no perder el log pero quitar la referencia)
                conn.execute(f"UPDATE audit_log SET dataset_id = NULL WHERE dataset_id IN ({placeholders})", tuple(deleted_ids))

                # 8. Eliminar registros de la tabla datasets
                conn.execute(f"DELETE FROM datasets WHERE id IN ({placeholders})", tuple(deleted_ids))
                
                self._audit(
                    conn,
                    action="datasets.purge",
                    username=actor,
                    entity="system",
                    entity_id="bulk_purge",
                    details={"files_purged": deleted_names},
                )
                return {"purged_count": len(deleted_ids), "files": deleted_names}

    def _cleanup_staging(self, conn: sqlite3.Connection):
        conn.execute("DELETE FROM upload_staging WHERE expires_at < ?", (now_str(),))

    def _dup_by_hash(self, conn: sqlite3.Connection, hash_value: str):
        return conn.execute(
            "SELECT id,name FROM datasets WHERE content_hash=? AND deleted_at IS NULL LIMIT 1",
            (hash_value,),
        ).fetchone()

    def _snapshot_db(self, reason: str):
        if self.is_postgres:
            return None
        safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "_", (reason or "op")).strip("_") or "op"
        stamp = get_now().strftime("%Y%m%d_%H%M%S")
        target = self.snapshot_dir / f"{stamp}_{safe_reason}.sqlite3"
        with sqlite3.connect(self.db_path, timeout=30.0) as src, sqlite3.connect(target, timeout=30.0) as out:
            src.backup(out)

        snapshots = sorted(self.snapshot_dir.glob("*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in snapshots[MAX_DB_SNAPSHOTS:]:
            try:
                old.unlink()
            except OSError:
                pass
        return target

    def _backup_meta(self, path: Path) -> dict:
        name = path.name
        stamp_text = ""
        reason = ""
        match = re.match(r"^(\d{8}_\d{6})_(.+)\.sqlite3$", name)
        if match:
            stamp_text = match.group(1)
            reason = match.group(2)
        created = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        if stamp_text:
            try:
                created = datetime.strptime(stamp_text, "%Y%m%d_%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass
        return {
            "file": name,
            "reason": reason or "manual",
            "size_bytes": int(path.stat().st_size),
            "created_at": created,
        }

    def list_backups(self, limit: int = 80) -> list[dict]:
        if self.is_postgres:
            return []
        max_limit = max(1, min(int(limit or 80), 300))
        items = sorted(self.snapshot_dir.glob("*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)
        return [self._backup_meta(p) for p in items[:max_limit]]

    def create_manual_backup(self, reason: str = "", actor: str = "") -> dict:
        if self.is_postgres:
            raise ValueError("La creacion de respaldos manuales no esta disponible en modo PostgreSQL. Use las herramientas del proveedor (Render).")
        note = re.sub(r"[^a-zA-Z0-9_-]+", "_", (reason or "manual")).strip("_")[:60] or "manual"
        with self.lock:
            target = self._snapshot_db(f"manual_{note}")
            with self._conn() as conn:
                self._audit(
                    conn,
                    action="backup.create",
                    username=actor,
                    entity="backup",
                    entity_id=target.name,
                    details={"reason": note},
                )
            return self._backup_meta(target)

    def restore_backup(self, backup_file: str, actor: str = "") -> dict:
        if self.is_postgres:
            raise ValueError("La restauracion de respaldos no esta disponible en modo PostgreSQL. Use las herramientas del proveedor (Render).")
        file_name = Path((backup_file or "").strip()).name
        if not file_name or "/" in file_name or "\\" in file_name or not file_name.lower().endswith(".sqlite3"):
            raise ValueError("Nombre de respaldo invalido.")
        source = (self.snapshot_dir / file_name).resolve()
        if source.parent != self.snapshot_dir.resolve() or not source.exists():
            raise FileNotFoundError("Respaldo no encontrado.")

        with self.lock:
            self._snapshot_db("before_backup_restore")
            with sqlite3.connect(source, timeout=30.0) as src, sqlite3.connect(self.db_path, timeout=30.0) as dst:
                src.backup(dst)
            self._init_db()
            with self._conn() as conn:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                aid = self._active_id(conn)
                active_file = self._load_by_id(conn, aid)["name"] if aid is not None else ""
                self._audit(
                    conn,
                    action="backup.restore",
                    username=actor,
                    entity="backup",
                    entity_id=file_name,
                    dataset_id=aid,
                    details={"active_file": active_file},
                )
            return {"backup": file_name, "active_file": active_file}

    def list_audit(self, dataset_name: str | None = None, limit: int = 120) -> dict:
        max_limit = max(1, min(int(limit or 120), 500))
        with self.lock:
            with self._conn() as conn:
                ds = None
                params: list = []
                where = []
                if dataset_name:
                    ds = self._resolve_dataset(conn, dataset_name)
                    where.append("dataset_id=?")
                    params.append(ds["id"])
                sql = "SELECT id,created_at,username,action,entity,entity_id,dataset_id,details_json FROM audit_log"
                if where:
                    sql += " WHERE " + " AND ".join(where)
                sql += " ORDER BY id DESC LIMIT ?"
                params.append(max_limit)
                rows = conn.execute(sql, tuple(params)).fetchall()
                out = []
                for row in rows:
                    try:
                        details = json.loads(row["details_json"] or "{}")
                    except Exception:
                        details = {}
                    out.append(
                        {
                            "id": int(row["id"]),
                            "created_at": row["created_at"] or "",
                            "username": row["username"] or "",
                            "action": row["action"] or "",
                            "entity": row["entity"] or "",
                            "entity_id": row["entity_id"] or "",
                            "dataset_id": int(row["dataset_id"]) if row["dataset_id"] is not None else None,
                            "details": details if isinstance(details, dict) else {},
                        }
                    )
                return {"file": ds["name"] if ds else "", "items": out}

    def stage_upload_preview(self, uploaded) -> dict:
        if not uploaded or not uploaded.filename:
            raise ValueError("No file selected.")
        fname = secure_filename(uploaded.filename or "")
        if not fname:
            fname = f"uploaded_{get_now().strftime('%Y%m%d_%H%M%S')}.csv"
        if not fname.lower().endswith(".csv"):
            raise ValueError("Only .csv files are allowed.")
        raw = uploaded.stream.read(MAX_UPLOAD_BYTES + 1)
        if len(raw) > MAX_UPLOAD_BYTES:
            raise ValueError(f"File too large. Max allowed: {MAX_UPLOAD_BYTES} bytes.")
        if not raw:
            raise ValueError("Uploaded file is empty.")

        headers, rows, enc, delim = parse_csv_bytes(raw)
        headers, header_mapping = apply_header_mapping(headers)
        val = validate_dataset(headers, rows)
        h = content_hash(headers, rows)
        token = uuid4().hex
        created = now_str()
        expires = (get_now() + timedelta(minutes=STAGING_TTL_MIN)).strftime("%Y-%m-%d %H:%M:%S")

        with self.lock:
            with self._conn() as conn:
                self._cleanup_staging(conn)
                dup = self._dup_by_hash(conn, h)
                conn.execute(
                    """
                    INSERT INTO upload_staging(token,original_name,headers_json,rows_json,encoding,delimiter,content_hash,validation_json,created_at,expires_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        token,
                        fname,
                        json.dumps(headers, ensure_ascii=False),
                        json.dumps(rows, ensure_ascii=False),
                        enc,
                        delim,
                        h,
                        json.dumps(val, ensure_ascii=False),
                        created,
                        expires,
                    ),
                )
        return {
            "ok": val["ok"],
            "token": token,
            "file": fname,
            "family_guess": guess_family_from_filename(fname),
            "hash": h,
            "duplicate_of": dup["name"] if dup else None,
            "header_mapping": header_mapping,
            "validation": val,
            "allowed_modes": ["new", "replace", "merge"],
            "suggested_mode": "merge" if dup else "new",
        }

    def _get_by_name(self, conn: sqlite3.Connection, name: str) -> dict:
        row = conn.execute("SELECT id FROM datasets WHERE name=? AND deleted_at IS NULL", (name,)).fetchone()
        if not row:
            raise FileNotFoundError(f"Dataset not found: {name}")
        return self._load_by_id(conn, int(row["id"]))

    def _merge_rows(
        self,
        target_headers: list[str],
        target_rows: list[list[str]],
        incoming_headers: list[str],
        incoming_rows: list[list[str]],
    ) -> tuple[list[list[str]], int, int]:
        tnorm = [norm_header(h) for h in target_headers]
        inorm = [norm_header(h) for h in incoming_headers]
        if set(tnorm) != set(inorm):
            miss = sorted(set(tnorm) - set(inorm))
            extra = sorted(set(inorm) - set(tnorm))
            raise ValueError(f"Headers mismatch for merge. Missing: {miss}. Extra: {extra}.")

        i_map = {h: i for i, h in enumerate(inorm)}
        aligned = [[row[i_map[key]] for key in tnorm] for row in incoming_rows]
        # Prefer canonical keys after header mapping, while keeping legacy aliases for old datasets.
        key_preference_groups = [
            ("formula",),
            ("fc",),
            ("edad",),
            ("tipo", "coloc"),
            ("tma",),
            ("rev",),
            ("comp", "var", "complemento"),
            ("cod",),
        ]
        key_order = []
        for options in key_preference_groups:
            selected = next((k for k in options if k in tnorm), None)
            if selected:
                key_order.append(selected)
        idxs = [tnorm.index(k) for k in key_order] or list(range(len(target_headers)))

        def key_of(row: list[str]) -> tuple:
            k = tuple((row[i] or "").strip().lower() for i in idxs)
            if any(k):
                return k
            return tuple((c or "").strip().lower() for c in row)

        merged = [list(r) for r in target_rows]
        pos = {key_of(r): i for i, r in enumerate(merged)}
        inserted, updated = 0, 0
        for row in aligned:
            k = key_of(row)
            if k in pos:
                merged[pos[k]] = row
                updated += 1
            else:
                merged.append(row)
                pos[k] = len(merged) - 1
                inserted += 1
        return merged, inserted, updated

    def commit_staged_upload(
        self,
        token: str,
        mode: str,
        target_name: str | None = None,
        family_code: str | None = None,
        actor: str = "",
    ) -> dict:
        if mode not in MODES:
            raise ValueError("Mode must be new|replace|merge.")
        fam_override = normalize_family_code(family_code, allow_empty=True) if family_code is not None else None
        with self.lock:
            self._snapshot_db(f"before_upload_{mode}")
            with self._conn() as conn:
                self._cleanup_staging(conn)
                st = conn.execute("SELECT * FROM upload_staging WHERE token=?", (token,)).fetchone()
                if not st:
                    raise FileNotFoundError("Upload token not found or expired.")
                val = json.loads(st["validation_json"])
                if not val.get("ok", False):
                    raise ValueError("Cannot commit invalid upload.")
                headers = json.loads(st["headers_json"])
                rows = json.loads(st["rows_json"])
                h = st["content_hash"]
                dup = self._dup_by_hash(conn, h)
                result = {"mode": mode, "inserted": 0, "updated": 0, "replaced": 0, "rows": len(rows)}

                if mode == "new":
                    if dup:
                        raise ValueError(
                            f"Duplicate content detected with dataset '{dup['name']}'. Use replace or merge."
                        )
                    fam_to_use = fam_override if fam_override else guess_family_from_filename(st["original_name"])
                    did = self._insert_dataset(
                        conn,
                        st["original_name"],
                        headers,
                        rows,
                        st["encoding"],
                        st["delimiter"],
                        family_code=fam_to_use,
                    )
                    self._set_active(conn, did)
                    loaded = self._load_by_id(conn, did)
                    result["file"] = loaded["name"]
                    result["family"] = loaded["family_code"]
                elif mode == "replace":
                    if target_name:
                        ds = self._get_by_name(conn, target_name)
                    else:
                        aid = self._active_id(conn)
                        if aid is None:
                            raise FileNotFoundError("No active dataset.")
                        ds = self._load_by_id(conn, aid)
                    self._save_revision(conn, ds, f"before replace by upload token {token}")
                    conn.execute(
                        """
                        UPDATE datasets
                        SET headers_json=?, rows_json=?, encoding=?, delimiter=?, content_hash=?, row_count=?, family_code=COALESCE(NULLIF(?,''),family_code), updated_at=?, version=version+1
                        WHERE id=?
                        """,
                        (
                            json.dumps(headers, ensure_ascii=False),
                            json.dumps(rows, ensure_ascii=False),
                            st["encoding"],
                            st["delimiter"],
                            h,
                            len(rows),
                            fam_override or "",
                            now_str(),
                            ds["id"],
                        ),
                    )
                    self._set_active(conn, ds["id"])
                    result["file"] = ds["name"]
                    result["replaced"] = len(rows)
                    refreshed = self._load_by_id(conn, ds["id"])
                    result["family"] = refreshed["family_code"]
                else:
                    if target_name:
                        ds = self._get_by_name(conn, target_name)
                    else:
                        aid = self._active_id(conn)
                        if aid is None:
                            raise FileNotFoundError("No active dataset.")
                        ds = self._load_by_id(conn, aid)
                    merged, ins, upd = self._merge_rows(ds["headers"], ds["rows"], headers, rows)
                    self._save_revision(conn, ds, f"before merge by upload token {token}")
                    mh = content_hash(ds["headers"], merged)
                    conn.execute(
                        """
                        UPDATE datasets
                        SET rows_json=?, content_hash=?, row_count=?, family_code=COALESCE(NULLIF(?,''),family_code), updated_at=?, version=version+1
                        WHERE id=?
                        """,
                        (json.dumps(merged, ensure_ascii=False), mh, len(merged), fam_override or "", now_str(), ds["id"]),
                    )
                    self._set_active(conn, ds["id"])
                    result["file"] = ds["name"]
                    result["inserted"] = ins
                    result["updated"] = upd
                    refreshed = self._load_by_id(conn, ds["id"])
                    result["family"] = refreshed["family_code"]

                conn.execute("DELETE FROM upload_staging WHERE token=?", (token,))
                dataset_id = None
                if result.get("file"):
                    try:
                        dataset_id = self._get_by_name(conn, result["file"])["id"]
                    except Exception:
                        dataset_id = None
                self._audit(
                    conn,
                    action="dataset.upload.commit",
                    username=actor,
                    entity="dataset",
                    entity_id=str(dataset_id or ""),
                    dataset_id=dataset_id,
                    details={
                        "mode": mode,
                        "file": result.get("file", ""),
                        "inserted": int(result.get("inserted", 0) or 0),
                        "updated": int(result.get("updated", 0) or 0),
                        "replaced": int(result.get("replaced", 0) or 0),
                        "rows": int(result.get("rows", 0) or 0),
                    },
                )
                return result

    def get_history(self, dataset_name: str | None = None, limit: int = 50) -> dict:
        with self.lock:
            with self._conn() as conn:
                if dataset_name:
                    ds = self._get_by_name(conn, dataset_name)
                else:
                    aid = self._active_id(conn)
                    if aid is None:
                        raise FileNotFoundError("No active dataset.")
                    ds = self._load_by_id(conn, aid)
                rows = conn.execute(
                    """
                    SELECT id,created_at,row_count,note
                    FROM dataset_revisions
                    WHERE dataset_id=?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (ds["id"], limit),
                ).fetchall()
                return {
                    "file": ds["name"],
                    "version": ds["version"],
                    "updated_at": ds["updated_at"],
                    "revisions": [
                        {
                            "id": int(r["id"]),
                            "created_at": r["created_at"],
                            "row_count": int(r["row_count"] or 0),
                            "note": r["note"] or "",
                        }
                        for r in rows
                    ],
                }

    def restore_revision(
        self,
        revision_id: int,
        dataset_name: str | None = None,
        expected_version: int | None = None,
        actor: str = "",
    ) -> int:
        with self.lock:
            self._snapshot_db("before_restore")
            with self._conn() as conn:
                if dataset_name:
                    ds = self._get_by_name(conn, dataset_name)
                else:
                    aid = self._active_id(conn)
                    if aid is None:
                        raise FileNotFoundError("No active dataset.")
                    ds = self._load_by_id(conn, aid)
                if expected_version is not None and ds["version"] != expected_version:
                    raise ConcurrencyError(f"Version conflict. Current version is {ds['version']}, expected {expected_version}.")
                rev = conn.execute(
                    "SELECT headers_json,rows_json,content_hash,row_count FROM dataset_revisions WHERE id=? AND dataset_id=?",
                    (revision_id, ds["id"]),
                ).fetchone()
                if not rev:
                    raise FileNotFoundError("Revision not found for selected dataset.")
                self._save_revision(conn, ds, f"before restore revision {revision_id}")
                headers = json.loads(rev["headers_json"])
                rows = json.loads(rev["rows_json"])
                rh = rev["content_hash"] or content_hash(headers, rows)
                new_ver = ds["version"] + 1
                conn.execute(
                    """
                    UPDATE datasets
                    SET headers_json=?, rows_json=?, content_hash=?, row_count=?, updated_at=?, version=?
                    WHERE id=?
                    """,
                    (
                        json.dumps(headers, ensure_ascii=False),
                        json.dumps(rows, ensure_ascii=False),
                        rh,
                        int(rev["row_count"] or len(rows)),
                        now_str(),
                        new_ver,
                        ds["id"],
                    ),
                )
                self._audit(
                    conn,
                    action="dataset.revision.restore",
                    username=actor,
                    entity="dataset",
                    entity_id=str(ds["id"]),
                    dataset_id=ds["id"],
                    details={"file": ds["name"], "revision_id": revision_id, "version": new_ver},
                )
                return new_ver

    def update_remision(self, remision_id: int, data: dict, dataset_name: str | None = None, actor: str = "") -> dict:
        rid = int(remision_id)
        if rid <= 0:
            raise ValueError("ID de remision invalido.")
        with self.lock:
            ts = now_str()
            with self._conn() as conn:
                ds = self._resolve_dataset(conn, dataset_name)
                exists = conn.execute(
                    "SELECT snapshot_json, cliente, ubicacion FROM remisiones WHERE id=? AND dataset_id=?", (rid, ds["id"])
                ).fetchone()
                if not exists:
                    raise FileNotFoundError("Remision no encontrada.")

                formula = str(data.get("formula", "")).strip()
                m3 = float(data.get("dosificacion_m3", 0))
                peso_real = float(data.get("peso_real_total", 0))
                remision_no = str(data.get("remision_no", "")).strip()
                created_at = data.get("created_at")
                cliente = normalize_remision_field(data.get("cliente", exists["cliente"]), "cliente")
                ubicacion = normalize_remision_field(data.get("ubicacion", exists["ubicacion"]), "ubicacion")

                # Actualizar campos denormalizados
                sql = "UPDATE remisiones SET formula=?, dosificacion_m3=?, peso_real_total=?, remision_no=?, cliente=?, ubicacion=?, updated_at=?"
                params = [formula, m3, peso_real, remision_no, cliente, ubicacion, ts]
                if created_at:
                    sql += ", created_at=?"
                    params.append(created_at)
                
                sql += " WHERE id=? AND dataset_id=?"
                params.extend([rid, ds["id"]])
                
                conn.execute(sql, params)

                # --- SINCRONIZACION DE INVENTARIO ---
                # Si se cambió la fecha de la remisión, movemos las transacciones de inventario asociadas
                if created_at:
                    conn.execute(
                        "UPDATE inventory_transactions SET created_at=? WHERE reference=?",
                        (created_at, f"Remision #{remision_no}")
                    )

                # Tambien actualizamos el snapshot_json para que el reporte refleje los cambios
                try:
                    snap = json.loads(exists["snapshot_json"] or "{}")
                    snap["formula"] = formula
                    snap["dose"] = m3
                    snap["realWeight"] = peso_real
                    snap["remisionNo"] = remision_no
                    snap["cliente"] = cliente or "-"
                    snap["ubicacion"] = ubicacion or "-"
                    if created_at:
                        snap["timestamp"] = created_at
                    conn.execute("UPDATE remisiones SET snapshot_json=? WHERE id=?", (json.dumps(snap, ensure_ascii=False), rid))
                except:
                    pass

                self._audit(
                    conn,
                    action="remision.update",
                    username=actor,
                    entity="remision",
                    entity_id=str(rid),
                    dataset_id=ds["id"],
                    details={
                        "file": ds["name"],
                        "remision_no": remision_no,
                        "formula": formula,
                        "m3": m3,
                        "peso_real": peso_real,
                        "cliente": cliente,
                        "ubicacion": ubicacion,
                        "created_at": created_at
                    },
                )
                return {"id": rid, "ok": True}
    # -- Fleet methods provided by FleetStoreMixin (fleet_store.py) --



def create_app(base_dir: Path, csv_file: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config["JSON_AS_ASCII"] = False
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.config["SECRET_KEY"] = load_or_create_secret(base_dir.resolve())
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = bool(int(os.getenv("SESSION_COOKIE_SECURE", "0")))
    app.config["BASE_DIR"] = str(base_dir.resolve())
    db_url = os.getenv("DATABASE_URL")
    store = AppStore(base_dir=base_dir, csv_file=csv_file, db_url=db_url)

    def _api_unauthorized(msg: str, status: int):
        return jsonify({"ok": False, "error": msg}), status

    def ensure_csrf_token() -> str:
        token = session.get("_csrf_token")
        if not token:
            token = secrets.token_urlsafe(32)
            session["_csrf_token"] = token
        return token

    def is_valid_csrf() -> bool:
        expected = str(session.get("_csrf_token") or "")
        if not expected:
            return False
        provided = (
            request.headers.get("X-CSRF-Token")
            or request.form.get("_csrf_token")
            or (
                ((request.get_json(silent=True) or {}).get("_csrf_token"))
                if request.is_json
                else ""
            )
            or ""
        )
        return secrets.compare_digest(str(provided), expected)

    def current_auth() -> dict | None:
        username = normalize_username(session.get("username", ""))
        role = (session.get("role") or "").strip()
        if not username or role not in ROLE_ALLOWED_VIEWS:
            return None
        user = store.auth_get_user(username)
        if not user:
            return None
        if user["role"] != role:
            session.clear()
            return None
        return user

    def allowed_views(role: str) -> list[str]:
        return sorted(ROLE_ALLOWED_VIEWS.get(role, set()))

    @app.context_processor
    def inject_common_template_vars():
        return {"csrf_token": ensure_csrf_token()}

    @app.before_request
    def csrf_protect():
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return None
        if request.path.startswith("/static/"):
            return None
        if is_valid_csrf():
            return None
        msg = "Solicitud invalida (CSRF). Recarga la pagina e intenta de nuevo."
        if request.path.startswith("/api/"):
            return _api_unauthorized(msg, 403)
        if request.endpoint == "login_submit":
            return render_template("login.html", error=msg, cache_bust=int(get_now().timestamp())), 403
        if request.endpoint == "change_password_submit":
            user = current_auth()
            if user:
                return render_template(
                    "change_password.html",
                    error=msg,
                    username=user["username"],
                    role=user["role"],
                    cache_bust=int(get_now().timestamp()),
                ), 403
        return msg, 403

    def login_required(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_auth()
            if user:
                if user.get("must_change_password"):
                    allowed_paths = {"/change-password", "/logout"}
                    if request.path.startswith("/api/") and request.path != "/api/session":
                        return _api_unauthorized("Debes cambiar tu contrasena antes de continuar.", 423)
                    if request.path not in allowed_paths:
                        return redirect(url_for("change_password"))
                request.current_user = user
                return fn(*args, **kwargs)
            if request.path.startswith("/api/"):
                return _api_unauthorized("Sesion expirada o no autenticada.", 401)
            return redirect(url_for("login"))

        return wrapper

    def require_roles(*roles):
        allowed = set(roles)

        def deco(fn):
            @wraps(fn)
            @login_required
            def wrapper(*args, **kwargs):
                user = request.current_user
                if user["role"] not in allowed:
                    if request.path.startswith("/api/"):
                        return _api_unauthorized("No autorizado para esta accion.", 403)
                    return redirect(url_for("index"))
                return fn(*args, **kwargs)

            return wrapper

        return deco

    @app.after_request
    def no_cache(resp):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    @app.get("/login")
    def login():
        user = current_auth()
        if user:
            if user.get("must_change_password"):
                return redirect(url_for("change_password"))
            return redirect(url_for("index"))
        return render_template("login.html", error="", cache_bust=int(get_now().timestamp()))

    @app.post("/login")
    def login_submit():
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        try:
            user = store.auth_authenticate(username, password)
            session.clear()
            session["username"] = user["username"]
            session["role"] = user["role"]
            session["login_at"] = now_str()
            if user.get("must_change_password"):
                return redirect(url_for("change_password"))
            return redirect(url_for("index"))
        except PermissionError as exc:
            return render_template("login.html", error=str(exc), cache_bust=int(get_now().timestamp())), 429
        except Exception as exc:
            return render_template("login.html", error=str(exc), cache_bust=int(get_now().timestamp())), 401

    @app.get("/change-password")
    @login_required
    def change_password():
        user = request.current_user
        if not user.get("must_change_password"):
            return redirect(url_for("index"))
        return render_template(
            "change_password.html",
            error="",
            username=user["username"],
            role=user["role"],
            cache_bust=int(get_now().timestamp()),
        )

    @app.post("/change-password")
    @login_required
    def change_password_submit():
        user = request.current_user
        if not user.get("must_change_password"):
            return redirect(url_for("index"))
        current_password = request.form.get("current_password") or ""
        new_password = request.form.get("new_password") or ""
        confirm_password = request.form.get("confirm_password") or ""
        if new_password != confirm_password:
            return render_template(
                "change_password.html",
                error="La confirmacion de contrasena no coincide.",
                username=user["username"],
                role=user["role"],
                cache_bust=int(get_now().timestamp()),
            ), 400
        try:
            store.auth_change_password(user["username"], current_password, new_password)
            session["login_at"] = now_str()
            return redirect(url_for("index"))
        except PermissionError as exc:
            code = 403
            msg = str(exc)
        except Exception as exc:
            code = 400
            msg = str(exc)
        return render_template(
            "change_password.html",
            error=msg,
            username=user["username"],
            role=user["role"],
            cache_bust=int(get_now().timestamp()),
        ), code

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/")
    @login_required
    def index():
        user = request.current_user
        auth_boot = {
            "username": user["username"],
            "role": user["role"],
            "must_change_password": bool(user.get("must_change_password")),
            "allowed_views": allowed_views(user["role"]),
            "can_edit": user["role"] in EDITOR_ROLES,
            "can_edit_qc_humidity": user["role"] in QC_HUMIDITY_ROLES,
            "csrf_token": ensure_csrf_token(),
        }
        return render_template("index.html", cache_bust=int(get_now().timestamp()), auth_boot=auth_boot)

    @app.get("/api/session")
    @login_required
    def api_session():
        user = request.current_user
        return jsonify(
            {
                "ok": True,
                "username": user["username"],
                "role": user["role"],
                "must_change_password": bool(user.get("must_change_password")),
                "allowed_views": allowed_views(user["role"]),
                "can_edit": user["role"] in EDITOR_ROLES,
                "can_edit_qc_humidity": user["role"] in QC_HUMIDITY_ROLES,
                "csrf_token": ensure_csrf_token(),
            }
        )

    @app.get("/api/data")
    @require_roles(*ROLE_ALLOWED_VIEWS.keys())
    def api_data():
        ds = store.load_active()
        return jsonify(
            {
                "file": ds["name"],
                "family": ds["family_code"],
                "encoding": ds["encoding"],
                "delimiter": ds["delimiter"],
                "headers": ds["headers"],
                "rows": ds["rows"],
                "files": store.list_files(),
                "file_infos": store.list_file_infos(),
                "updated_at": ds["updated_at"],
                "version": ds["version"],
                "row_count": ds["row_count"],
            }
        )

    @app.get("/api/families/summary")
    @require_roles(*ROLE_ALLOWED_VIEWS.keys())
    def api_families_summary():
        try:
            return jsonify({"ok": True, "summary": store.get_all_families_summary()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/qc")
    @require_roles(*ROLE_ALLOWED_VIEWS.keys())
    def api_qc():
        file_name = request.args.get("file")
        try:
            data = store.load_qc(dataset_name=file_name)
            return jsonify({"ok": True, **data})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/qc/save")
    @require_roles(*EDITOR_ROLES)
    def api_qc_save():
        try:
            payload = decode_json_payload(request.get_data(cache=False))
            values = payload.get("values", {})
            file_name = payload.get("file")
            version = payload.get("version")
            if file_name is not None and not isinstance(file_name, str):
                return jsonify({"ok": False, "error": "file must be string."}), 400
            if version is not None:
                version = int(version)
            current = store.load_qc(dataset_name=file_name)
            current_values = current.get("values", default_qc_values())
            merged_values = values if isinstance(values, dict) else {}
            for agg in QC_AGGREGATES:
                row = merged_values.get(agg) if isinstance(merged_values.get(agg), dict) else {}
                row["humedad"] = current_values.get(agg, {}).get("humedad", 0)
                merged_values[agg] = row
            out = store.save_qc(
                values=merged_values,
                expected_version=version,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **out})
        except ConcurrencyError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 409
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/qc/humidity/save")
    @require_roles(*QC_HUMIDITY_ROLES)
    def api_qc_humidity_save():
        try:
            payload = decode_json_payload(request.get_data(cache=False))
            values = payload.get("values", {})
            file_name = payload.get("file")
            version = payload.get("version")
            if file_name is not None and not isinstance(file_name, str):
                return jsonify({"ok": False, "error": "file must be string."}), 400
            if version is not None:
                version = int(version)
            out = store.save_qc_humidity(
                values=values,
                expected_version=version,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **out})
        except ConcurrencyError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 409
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/doser/recipes_global")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_doser_recipes_global():
        try:
            return jsonify({"ok": True, "recipes": store.get_all_recipes_global()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/doser/params")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_doser_params():
        file_name = request.args.get("file")
        try:
            data = store.load_doser_params(dataset_name=file_name)
            return jsonify({"ok": True, **data})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/doser/params/save")
    @require_roles(*EDITOR_ROLES)
    def api_doser_params_save():
        try:
            payload = decode_json_payload(request.get_data(cache=False))
            values = payload.get("values", {})
            file_name = payload.get("file")
            version = payload.get("version")
            if file_name is not None and not isinstance(file_name, str):
                return jsonify({"ok": False, "error": "file must be string."}), 400
            if version is not None:
                version = int(version)
            out = store.save_doser_params(
                values=values,
                expected_version=version,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **out})
        except ConcurrencyError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 409
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/remisiones")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_remisiones_list():
        file_name = request.args.get("file")
        query = request.args.get("q", "")
        limit = request.args.get("limit", "80")
        date_filter = request.args.get("date")
        try:
            out = store.list_remisiones(
                dataset_name=file_name, 
                query=query, 
                limit=int(limit),
                date_filter=date_filter
            )
            return jsonify({"ok": True, **out})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/remisiones/save")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_remisiones_save():
        try:
            payload = decode_json_payload(request.get_data(cache=False))
            remision_no = payload.get("remision_no", "")
            snapshot = payload.get("snapshot", {})
            cliente = payload.get("cliente", "")
            ubicacion = payload.get("ubicacion", "")
            file_name = payload.get("file")
            if file_name is not None and not isinstance(file_name, str):
                return jsonify({"ok": False, "error": "file must be string."}), 400
            if not isinstance(cliente, str) or not isinstance(ubicacion, str):
                return jsonify({"ok": False, "error": "cliente y ubicacion deben ser texto."}), 400
            out = store.save_remision(
                remision_no=remision_no,
                snapshot=snapshot,
                cliente=cliente,
                ubicacion=ubicacion,
                dataset_name=file_name,
                created_by=request.current_user["username"],
            )
            return jsonify({"ok": True, **out})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/remisiones/<int:remision_id>")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_remisiones_get(remision_id: int):
        file_name = request.args.get("file")
        try:
            out = store.get_remision(remision_id=remision_id, dataset_name=file_name)
            return jsonify({"ok": True, **out})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.delete("/api/remisiones/<int:remision_id>")
    @require_roles(*DOSIFICADOR_ROLES)
    def api_remisiones_delete(remision_id: int):
        file_name = request.args.get("file")
        try:
            out = store.delete_remision(
                remision_id=remision_id,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **out})
        except FileNotFoundError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 404
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.put("/api/remisiones/<int:remision_id>")
    @require_roles("administrador")
    def api_remisiones_update(remision_id: int):
        file_name = request.args.get("file")
        payload = request.get_json(silent=True) or {}
        try:
            out = store.update_remision(
                remision_id=remision_id,
                data=payload,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify(out)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/select")
    @require_roles(*ROLE_ALLOWED_VIEWS.keys())
    def api_select():
        payload = request.get_json(silent=True) or {}
        file_name = payload.get("file", "")
        if not isinstance(file_name, str):
            return jsonify({"ok": False, "error": "Invalid file name."}), 400
        try:
            active = store.set_active_file(file_name)
            return jsonify({"ok": True, "file": active, "files": store.list_files(), "file_infos": store.list_file_infos()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/upload/preview")
    @require_roles(*EDITOR_ROLES)
    def api_upload_preview():
        try:
            if "file" not in request.files:
                return jsonify({"ok": False, "error": "Missing file field."}), 400
            out = store.stage_upload_preview(request.files["file"])
            return jsonify(out), (200 if out["ok"] else 400)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/upload/commit")
    @require_roles(*EDITOR_ROLES)
    def api_upload_commit():
        payload = request.get_json(silent=True) or {}
        token = (payload.get("token") or "").strip()
        mode = (payload.get("mode") or "new").strip().lower()
        target_file = payload.get("target_file")
        family_code = payload.get("family_code")
        if not token:
            return jsonify({"ok": False, "error": "Upload token is required."}), 400
        if mode not in MODES:
            return jsonify({"ok": False, "error": "Mode must be new|replace|merge."}), 400
        if target_file is not None and not isinstance(target_file, str):
            return jsonify({"ok": False, "error": "target_file must be string."}), 400
        if family_code is not None and not isinstance(family_code, str):
            return jsonify({"ok": False, "error": "family_code must be string."}), 400
        try:
            res = store.commit_staged_upload(
                token=token,
                mode=mode,
                target_name=target_file,
                family_code=family_code,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **res, "files": store.list_files(), "file_infos": store.list_file_infos()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/upload")
    @require_roles(*EDITOR_ROLES)
    def api_upload_legacy():
        try:
            if "file" not in request.files:
                return jsonify({"ok": False, "error": "Missing file field."}), 400
            preview = store.stage_upload_preview(request.files["file"])
            if not preview["ok"]:
                return jsonify(preview), 400
            res = store.commit_staged_upload(
                token=preview["token"],
                mode="new",
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, "file": res["file"], "files": store.list_files(), "file_infos": store.list_file_infos()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/purge_deleted")
    @require_roles("administrador")
    def api_purge_deleted():
        try:
            res = store.purge_deleted_datasets(actor=request.current_user["username"])
            return jsonify({"ok": True, **res})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/delete")
    @require_roles(*EDITOR_ROLES)
    def api_delete():
        payload = request.get_json(silent=True) or {}
        file_name = payload.get("file", "")
        if not isinstance(file_name, str):
            return jsonify({"ok": False, "error": "Invalid file name."}), 400
        try:
            res = store.delete_file(file_name, actor=request.current_user["username"])
            return jsonify(
                {
                    "ok": True,
                    "deleted": res["deleted"],
                    "file": res["active"],
                    "files": store.list_files(),
                    "file_infos": store.list_file_infos(),
                }
            )
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/family")
    @require_roles(*EDITOR_ROLES)
    def api_family_save():
        payload = request.get_json(silent=True) or {}
        family_code = payload.get("family_code", "")
        file_name = payload.get("file")
        if not isinstance(family_code, str):
            return jsonify({"ok": False, "error": "family_code must be string."}), 400
        if file_name is not None and not isinstance(file_name, str):
            return jsonify({"ok": False, "error": "file must be string."}), 400
        try:
            out = store.set_dataset_family(
                family_code=family_code,
                dataset_name=file_name,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, **out, "file_infos": store.list_file_infos()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/save")
    @require_roles(*EDITOR_ROLES)
    def api_save():
        try:
            payload = decode_json_payload(request.get_data(cache=False))
            headers = payload.get("headers", [])
            rows = payload.get("rows", [])
            version = payload.get("version")
            if version is not None:
                version = int(version)
            if not isinstance(headers, list) or not isinstance(rows, list):
                return jsonify({"ok": False, "error": "Invalid payload format."}), 400
            h = [sanitize_cell("" if x is None else str(x)) for x in headers]
            rr = []
            for row in rows:
                if not isinstance(row, list):
                    return jsonify({"ok": False, "error": "Each row must be a list."}), 400
                rr.append([sanitize_cell("" if x is None else str(x)) for x in row])
            new_ver = store.save_active(
                h,
                rr,
                expected_version=version,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, "version": new_ver})
        except ConcurrencyError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 409
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/history")
    @require_roles(*EDITOR_ROLES)
    def api_history():
        file_name = request.args.get("file")
        try:
            return jsonify({"ok": True, **store.get_history(dataset_name=file_name, limit=50)})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/history/restore")
    @require_roles(*EDITOR_ROLES)
    def api_history_restore():
        payload = request.get_json(silent=True) or {}
        revision_id = payload.get("revision_id")
        file_name = payload.get("file")
        version = payload.get("version")
        if revision_id is None:
            return jsonify({"ok": False, "error": "revision_id is required."}), 400
        try:
            revision_id = int(revision_id)
            if version is not None:
                version = int(version)
            new_ver = store.restore_revision(
                revision_id,
                dataset_name=file_name,
                expected_version=version,
                actor=request.current_user["username"],
            )
            return jsonify({"ok": True, "version": new_ver})
        except ConcurrencyError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 409
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/audit")
    @require_roles(*EDITOR_ROLES)
    def api_audit():
        file_name = request.args.get("file")
        limit = request.args.get("limit", "120")
        try:
            out = store.list_audit(dataset_name=file_name, limit=int(limit))
            return jsonify({"ok": True, **out})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.get("/api/backups")
    @require_roles(*EDITOR_ROLES)
    def api_backups():
        limit = request.args.get("limit", "80")
        try:
            items = store.list_backups(limit=int(limit))
            return jsonify({"ok": True, "items": items})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/backups/create")
    @require_roles(*EDITOR_ROLES)
    def api_backups_create():
        payload = request.get_json(silent=True) or {}
        reason = payload.get("reason", "")
        if reason is not None and not isinstance(reason, str):
            return jsonify({"ok": False, "error": "reason must be string."}), 400
        try:
            item = store.create_manual_backup(reason=reason or "manual", actor=request.current_user["username"])
            return jsonify({"ok": True, "backup": item, "items": store.list_backups(limit=80)})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/api/backups/restore")
    @require_roles("administrador")
    def api_backups_restore():
        payload = request.get_json(silent=True) or {}
        backup_file = payload.get("file", "")
        if not isinstance(backup_file, str):
            return jsonify({"ok": False, "error": "file must be string."}), 400
        try:
            out = store.restore_backup(backup_file=backup_file, actor=request.current_user["username"])
            return jsonify(
                {
                    "ok": True,
                    **out,
                    "files": store.list_files(),
                    "file_infos": store.list_file_infos(),
                }
            )
        except FileNotFoundError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 404
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    # ── Fleet API ──────────────────────────────────────────────────────────
    from fleet_routes import register_fleet_routes
    register_fleet_routes(app, store, login_required, require_roles, FLEET_ROLES)

    # ── Inventory API ──────────────────────────────────────────────────────
    from inventory_routes import register_inventory_routes
    register_inventory_routes(app, store, login_required, require_roles, INVENTORY_ROLES)

    # ── QC Lab API ─────────────────────────────────────────────────────────
    from qc_lab_routes import register_qc_lab_routes
    register_qc_lab_routes(app, store, login_required, require_roles, LAB_ROLES)

    # ── Users API ─────────────────────────────────────────────────────────
    from user_routes import register_user_routes
    users_bp = register_user_routes(store, require_roles)
    app.register_blueprint(users_bp)

    return app

# Exponer instancia global para Gunicorn y otros servidores WSGI
app = create_app(base_dir=Path.cwd())

def main() -> None:
    parser = argparse.ArgumentParser(description="Concrete mix design editor with SQLite persistence.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    parser.add_argument("--csv", default=None, help="CSV used only for first bootstrap")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=False)

if __name__ == "__main__":
    main()
