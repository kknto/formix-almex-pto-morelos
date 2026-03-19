import uuid
import datetime
import sqlite3

class QCLabStoreMixin:
    def list_qc_samples(self, limit: int = 100) -> list[dict]:
        with self._conn() as conn:
            query = """
                SELECT s.*, r.formula, r.fc, r.tma, r.tipo, r.rev, r.comp
                FROM qc_samples s
                LEFT JOIN remisiones r ON s.remision_id = r.remision_no
                ORDER BY s.cast_date DESC, s.created_at DESC LIMIT ?
            """
            cur = conn.execute(query, (limit,))
            return [dict(r) for r in cur.fetchall()]

    def list_qc_cylinders(self, sample_id: int | None = None, pending_only: bool = False, limit: int = 500) -> list[dict]:
        with self._conn() as conn:
            query = """
                SELECT c.id, c.sample_id, c.target_age_days, c.expected_test_date, c.status,
                       c.strength_kgcm2, c.break_date, c.image_path, c.notes, c.failure_type,
                       c.load_total, c.diameter_cm, c.area_cm2, c.correction_factor,
                       (CASE WHEN c.image_data IS NOT NULL THEN 1 ELSE 0 END) as has_image_data,
                       s.sample_code, s.fc_expected, s.remision_id, s.cast_date, s.slump_cm,
                       r.formula, r.fc, r.tma, r.tipo, r.rev, r.comp
                FROM qc_cylinders c
                JOIN qc_samples s ON c.sample_id = s.id
                LEFT JOIN remisiones r ON s.remision_id = r.remision_no
                WHERE 1=1
            """
            params = []
            if sample_id is not None:
                query += " AND c.sample_id = ?"
                params.append(sample_id)
            if pending_only:
                query += " AND c.status = 'pendiente'"
            query += " ORDER BY s.sample_code ASC, c.target_age_days ASC LIMIT ?"
            params.append(limit)
            
            cur = conn.execute(query, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    def save_qc_sample(self, payload: dict, username: str) -> dict:
        with self.lock:
            with self._conn() as conn:
                sample_id = payload.get("id")
                now_dt = self.get_now()
                now = now_dt.strftime("%Y-%m-%d %H:%M:%S")
                
                if not sample_id:
                    code = payload.get("sample_code")
                    if not code or str(code).strip() == "":
                        code = f"M-{now[:10]}-{uuid.uuid4().hex[:4]}"
                    cur = conn.execute(
                        """
                        INSERT INTO qc_samples (
                            sample_code, cast_date, remision_id, fc_expected, 
                            slump_cm, temperature_c, created_at, actor
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                        """,
                        (
                            code,
                            payload.get("cast_date", now[:10]),
                            payload.get("remision_id", ""),
                            float(payload.get("fc_expected", 250)),
                            float(payload.get("slump_cm", 0)),
                            float(payload.get("temperature_c", 0)),
                            now,
                            username
                        )
                    )
                    row = cur.fetchone()
                    if row:
                        sample_id = row["id"] if isinstance(row, dict) else row[0]
                    else:
                        raise Exception("No se pudo crear la muestra.")
                    
                    # Create baseline cylinders
                    cast_date_dt = datetime.datetime.strptime(payload.get("cast_date", now[:10]), "%Y-%m-%d")
                    ages = payload.get("cylinder_ages", []) # array of ints
                    for age in ages:
                        exp_date = (cast_date_dt + datetime.timedelta(days=int(age))).strftime("%Y-%m-%d")
                        conn.execute(
                            """
                            INSERT INTO qc_cylinders (
                                sample_id, target_age_days, expected_test_date
                            ) VALUES (?, ?, ?)
                            """,
                            (sample_id, int(age), exp_date)
                        )
                else:
                    conn.execute(
                        """
                        UPDATE qc_samples SET 
                            sample_code = ?, cast_date = ?, remision_id = ?, 
                            fc_expected = ?, slump_cm = ?, temperature_c = ?
                        WHERE id = ?
                        """,
                        (
                            payload.get("sample_code", ""),
                            payload.get("cast_date", ""),
                            payload.get("remision_id", ""),
                            float(payload.get("fc_expected", 250)),
                            float(payload.get("slump_cm", 0)),
                            float(payload.get("temperature_c", 0)),
                            sample_id
                        )
                    )
                
            return self.get_qc_sample(sample_id)

    def get_qc_sample(self, sample_id: int) -> dict | None:
        with self._conn() as conn:
            query = """
                SELECT s.*, r.formula, r.fc, r.tma, r.tipo, r.rev, r.comp
                FROM qc_samples s
                LEFT JOIN remisiones r ON s.remision_id = r.remision_no
                WHERE s.id = ?
            """
            cur = conn.execute(query, (sample_id,))
            row = cur.fetchone()
            if not row:
                return None
            sample = dict(row)
            sample["cylinders"] = self.list_qc_cylinders(sample_id=sample_id)
            return sample

    def get_remision_by_no(self, remision_no: str) -> dict | None:
        with self._conn() as conn:
            cur = conn.execute("SELECT * FROM remisiones WHERE remision_no = ?", (remision_no,))
            row = cur.fetchone()
            return dict(row) if row else None

    def delete_qc_sample(self, sample_id: int) -> bool:
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM qc_cylinders WHERE sample_id = ?", (sample_id,))
                cur = conn.execute("DELETE FROM qc_samples WHERE id = ?", (sample_id,))
                return cur.rowcount > 0

    def test_qc_cylinder(self, cylinder_id: int, payload: dict, image_path: str = "", image_data: bytes | None = None) -> dict:
        with self.lock:
            with self._conn() as conn:
                now = self.get_now().strftime("%Y-%m-%d %H:%M:%S")
                status = payload.get("status", "ensayado")
                try:
                    strength_val = payload.get("strength_kgcm2", "0")
                    strength = float(strength_val) if str(strength_val).strip() else 0.0
                except (TypeError, ValueError):
                    strength = 0.0
                try:
                    load_total = float(payload.get("load_total", 0) or 0)
                except (TypeError, ValueError):
                    load_total = 0.0
                try:
                    diameter_cm = float(payload.get("diameter_cm", 0) or 0)
                except (TypeError, ValueError):
                    diameter_cm = 0.0
                try:
                    area_cm2 = float(payload.get("area_cm2", 0) or 0)
                except (TypeError, ValueError):
                    area_cm2 = 0.0
                try:
                    correction_factor = float(payload.get("correction_factor", 1) or 1)
                except (TypeError, ValueError):
                    correction_factor = 1.0
                notes = payload.get("notes", "")
                failure_type = str(payload.get("failure_type", "") or "").strip()

                update_fields = [
                    "status = ?",
                    "strength_kgcm2 = ?",
                    "load_total = ?",
                    "diameter_cm = ?",
                    "area_cm2 = ?",
                    "correction_factor = ?",
                    "break_date = ?",
                    "notes = ?",
                    "failure_type = ?",
                ]
                params = [
                    status,
                    strength,
                    load_total,
                    diameter_cm,
                    area_cm2,
                    correction_factor,
                    payload.get("break_date") or now,
                    notes,
                    failure_type,
                ]

                if image_path:
                    update_fields.append("image_path = ?")
                    params.append(image_path)

                if image_data is not None:
                    update_fields.append("image_data = ?")
                    params.append(sqlite3.Binary(image_data) if not self.is_postgres else image_data)

                params.append(cylinder_id)
                query = f"UPDATE qc_cylinders SET {', '.join(update_fields)} WHERE id = ?"
                
                conn.execute(query, tuple(params))
                
                # Fetch updated
                cur = conn.execute("SELECT sample_id FROM qc_cylinders WHERE id = ?", (cylinder_id,))
                r = cur.fetchone()
                if not r:
                    return {}
                s_id = r["sample_id"] if isinstance(r, dict) else r[0]
            return self.get_qc_sample(s_id)
