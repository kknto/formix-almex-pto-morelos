import uuid
import datetime

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
                SELECT c.*, s.sample_code, s.fc_expected, 
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
            query += " ORDER BY c.expected_test_date ASC LIMIT ?"
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
                            cast_date = ?, remision_id = ?, fc_expected = ?, 
                            slump_cm = ?, temperature_c = ?
                        WHERE id = ?
                        """,
                        (
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

    def test_qc_cylinder(self, cylinder_id: int, payload: dict, image_path: str = "") -> dict:
        with self.lock:
            with self._conn() as conn:
                now = self.get_now().strftime("%Y-%m-%d %H:%M:%S")
                status = payload.get("status", "ensayado")
                strength = float(payload.get("strength_kgcm2", 0))
                notes = payload.get("notes", "")

                update_fields = [
                    "status = ?",
                    "strength_kgcm2 = ?",
                    "break_date = ?",
                    "notes = ?"
                ]
                params = [status, strength, payload.get("break_date") or now, notes]

                if image_path:
                    update_fields.append("image_path = ?")
                    params.append(image_path)

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
