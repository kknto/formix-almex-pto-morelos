"""
Fleet Store Mixin — Vehicle, Fuel, and Maintenance data operations.

This module contains the FleetStoreMixin class that provides all fleet
management methods. AppStore inherits from this mixin to keep the main
app.py file smaller and more manageable.

Usage:
    from fleet_store import FleetStoreMixin

    class AppStore(FleetStoreMixin, ...):
        ...
"""
from __future__ import annotations
from datetime import datetime


class FleetStoreMixin:
    """Mixin providing fleet management methods. Expects `self._conn()` from host class."""

    # ── Vehicles ─────────────────────────────────────────────────

    def list_vehicles(self, include_inactive: bool = False) -> list[dict]:
        with self._conn() as conn:
            if include_inactive:
                rows = conn.execute("SELECT * FROM vehicles ORDER BY unit_number").fetchall()
            else:
                rows = conn.execute("SELECT * FROM vehicles WHERE status='activo' ORDER BY unit_number").fetchall()
            cols = [d[0] for d in conn.execute("SELECT * FROM vehicles LIMIT 0").description or []]
            return [dict(zip(cols, r)) for r in rows]

    def save_vehicle(self, data: dict, actor: str = "") -> dict:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        unit = (data.get("unit_number") or "").strip()
        if not unit:
            raise ValueError("Numero de unidad es requerido.")
        vid = data.get("id")
        with self._conn() as conn:
            if vid:
                conn.execute(
                    """UPDATE vehicles SET unit_number=?, phone=?, year_model=?, serial_number=?,
                       plate=?, driver=?, tank_capacity=?, expected_kml=?, status=?, notes=?, updated_at=?
                       WHERE id=?""",
                    (unit, data.get("phone",""), data.get("year_model",""), data.get("serial_number",""),
                     data.get("plate",""), data.get("driver",""), float(data.get("tank_capacity",0)),
                     float(data.get("expected_kml",0)), data.get("status","activo"),
                     data.get("notes",""), now, int(vid)))
                conn.commit()
                return {"id": int(vid), "saved": True}
            else:
                conn.execute(
                    """INSERT INTO vehicles (unit_number, phone, year_model, serial_number, plate,
                       driver, tank_capacity, expected_kml, status, notes, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (unit, data.get("phone",""), data.get("year_model",""), data.get("serial_number",""),
                     data.get("plate",""), data.get("driver",""), float(data.get("tank_capacity",0)),
                     float(data.get("expected_kml",0)), data.get("status","activo"),
                     data.get("notes",""), now, now))
                conn.commit()
                row = conn.execute("SELECT id FROM vehicles WHERE unit_number=?", (unit,)).fetchone()
                return {"id": row[0] if row else 0, "saved": True}

    def delete_vehicle(self, vehicle_id: int, actor: str = "") -> bool:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._conn() as conn:
            conn.execute("UPDATE vehicles SET status='inactivo', updated_at=? WHERE id=?", (now, vehicle_id))
            conn.commit()
            return True

    # ── Fuel Records ─────────────────────────────────────────────

    def list_fuel_records(self, vehicle_id: int | None = None, limit: int = 200,
                          date_from: str = "", date_to: str = "") -> list[dict]:
        with self._conn() as conn:
            where = []
            params: list = []
            if vehicle_id:
                where.append("f.vehicle_id=?")
                params.append(vehicle_id)
            if date_from:
                where.append("f.record_date>=?")
                params.append(date_from)
            if date_to:
                where.append("f.record_date<=?")
                params.append(date_to + " 23:59:59")
            where_sql = ("WHERE " + " AND ".join(where)) if where else ""
            params.append(limit)
            rows = conn.execute(
                f"SELECT f.*, v.unit_number FROM fuel_records f JOIN vehicles v ON v.id=f.vehicle_id "
                f"{where_sql} ORDER BY f.record_date DESC LIMIT ?", tuple(params)).fetchall()
            cols_raw = conn.execute(
                "SELECT f.*, v.unit_number FROM fuel_records f JOIN vehicles v ON v.id=f.vehicle_id LIMIT 0"
            ).description or []
            cols = [d[0] for d in cols_raw]
            return [dict(zip(cols, r)) for r in rows]

    def save_fuel_record(self, data: dict, actor: str = "") -> dict:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        vid = int(data.get("vehicle_id", 0))
        if not vid:
            raise ValueError("Vehiculo es requerido.")
        odometer = float(data.get("odometer_km", 0))
        liters = float(data.get("liters", 0))
        total_cost = float(data.get("total_cost", 0))
        if liters <= 0:
            raise ValueError("Litros debe ser mayor a 0.")
        price_per_liter = total_cost / liters if liters > 0 else 0
        record_date = data.get("record_date") or now
        driver = data.get("driver", "")
        station = data.get("station", "")
        notes = data.get("notes", "")

        km_traveled = 0.0
        kml_real = 0.0
        cost_per_km = 0.0
        with self._conn() as conn:
            prev = conn.execute(
                "SELECT odometer_km FROM fuel_records WHERE vehicle_id=? ORDER BY record_date DESC, id DESC LIMIT 1",
                (vid,)).fetchone()
            if prev and prev[0] and odometer > 0:
                km_traveled = max(0, odometer - float(prev[0]))
                if km_traveled > 0 and liters > 0:
                    kml_real = km_traveled / liters
                if km_traveled > 0:
                    cost_per_km = total_cost / km_traveled

            conn.execute(
                """INSERT INTO fuel_records (vehicle_id, record_date, odometer_km, liters, total_cost,
                   price_per_liter, driver, station, km_traveled, kml_real, cost_per_km, notes,
                   created_by, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (vid, record_date, odometer, liters, total_cost, price_per_liter,
                 driver, station, km_traveled, kml_real, cost_per_km, notes, actor, now))
            conn.commit()
            return {"saved": True, "km_traveled": km_traveled, "kml_real": round(kml_real, 2),
                    "cost_per_km": round(cost_per_km, 2)}

    def edit_fuel_record(self, record_id: int, data: dict) -> dict:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        liters = max(float(data.get("liters", 1)), 0.01)
        cost = float(data.get("total_cost", 0))
        with self._conn() as conn:
            conn.execute(
                """UPDATE fuel_records SET record_date=?, odometer_km=?, liters=?, total_cost=?,
                   price_per_liter=?, driver=?, station=?, notes=? WHERE id=?""",
                (data.get("record_date", now), float(data.get("odometer_km", 0)),
                 liters, cost, cost / liters,
                 data.get("driver", ""), data.get("station", ""), data.get("notes", ""), record_id))
            conn.commit()
            return {"saved": True}

    def delete_fuel_record(self, record_id: int) -> bool:
        with self._conn() as conn:
            conn.execute("DELETE FROM fuel_records WHERE id=?", (record_id,))
            conn.commit()
            return True

    # ── Fleet Summary ────────────────────────────────────────────

    def fleet_summary(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute("""
                SELECT v.id, v.unit_number, v.driver, v.expected_kml, v.plate,
                  COUNT(f.id) as total_records,
                  COALESCE(SUM(f.liters), 0) as total_liters,
                  COALESCE(SUM(f.total_cost), 0) as total_cost,
                  COALESCE(SUM(f.km_traveled), 0) as total_km,
                  CASE WHEN COALESCE(SUM(f.liters), 0) > 0
                       THEN COALESCE(SUM(f.km_traveled), 0) / SUM(f.liters)
                       ELSE 0 END as avg_kml,
                  CASE WHEN COALESCE(SUM(f.km_traveled), 0) > 0
                       THEN COALESCE(SUM(f.total_cost), 0) / SUM(f.km_traveled)
                       ELSE 0 END as avg_cost_per_km,
                  MAX(f.record_date) as last_record
                FROM vehicles v LEFT JOIN fuel_records f ON f.vehicle_id = v.id
                WHERE v.status = 'activo'
                GROUP BY v.id, v.unit_number, v.driver, v.expected_kml, v.plate
                ORDER BY v.unit_number
            """).fetchall()
            cols = [d[0] for d in conn.execute("""
                SELECT v.id, v.unit_number, v.driver, v.expected_kml, v.plate,
                  0 as total_records, 0 as total_liters, 0 as total_cost, 0 as total_km,
                  0 as avg_kml, 0 as avg_cost_per_km, '' as last_record
                FROM vehicles v LIMIT 0
            """).description or []]
            return [dict(zip(cols, r)) for r in rows]

    # ── Maintenance ──────────────────────────────────────────────

    def list_maintenance(self, vehicle_id: int | None = None, limit: int = 100) -> list[dict]:
        with self._conn() as conn:
            if vehicle_id:
                rows = conn.execute(
                    "SELECT m.*, v.unit_number FROM maintenance_records m JOIN vehicles v ON v.id=m.vehicle_id "
                    "WHERE m.vehicle_id=? ORDER BY m.record_date DESC LIMIT ?",
                    (vehicle_id, limit)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT m.*, v.unit_number FROM maintenance_records m JOIN vehicles v ON v.id=m.vehicle_id "
                    "ORDER BY m.record_date DESC LIMIT ?",
                    (limit,)).fetchall()
            cols = [d[0] for d in conn.execute(
                "SELECT m.*, v.unit_number FROM maintenance_records m JOIN vehicles v ON v.id=m.vehicle_id LIMIT 0"
            ).description or []]
            return [dict(zip(cols, r)) for r in rows]

    def save_maintenance(self, data: dict, actor: str = "") -> dict:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        vid = int(data.get("vehicle_id", 0))
        if not vid:
            raise ValueError("Vehiculo es requerido.")
        mid = data.get("id")
        with self._conn() as conn:
            if mid:
                conn.execute(
                    """UPDATE maintenance_records SET maintenance_type=?, description=?, cost=?,
                       odometer_km=?, next_km=?, record_date=?, provider=?, notes=? WHERE id=?""",
                    (data.get("maintenance_type", ""), data.get("description", ""),
                     float(data.get("cost", 0)), float(data.get("odometer_km", 0)),
                     float(data.get("next_km", 0)), data.get("record_date", now),
                     data.get("provider", ""), data.get("notes", ""), int(mid)))
            else:
                conn.execute(
                    """INSERT INTO maintenance_records (vehicle_id, maintenance_type, description, cost,
                       odometer_km, next_km, record_date, provider, notes, created_by, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (vid, data.get("maintenance_type", ""), data.get("description", ""),
                     float(data.get("cost", 0)), float(data.get("odometer_km", 0)),
                     float(data.get("next_km", 0)), data.get("record_date", now),
                     data.get("provider", ""), data.get("notes", ""), actor, now))
            conn.commit()
            return {"saved": True}

    def delete_maintenance(self, record_id: int) -> bool:
        with self._conn() as conn:
            conn.execute("DELETE FROM maintenance_records WHERE id=?", (record_id,))
            conn.commit()
            return True

    def maintenance_alerts(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute("""
                SELECT m.id, m.vehicle_id, v.unit_number, m.maintenance_type, m.next_km,
                  (SELECT MAX(f.odometer_km) FROM fuel_records f WHERE f.vehicle_id=m.vehicle_id) as current_km
                FROM maintenance_records m JOIN vehicles v ON v.id=m.vehicle_id
                WHERE m.next_km > 0 AND v.status='activo'
                ORDER BY m.next_km
            """).fetchall()
            alerts = []
            for r in rows:
                next_km = float(r[4] or 0)
                current = float(r[5] or 0)
                if current <= 0 or next_km <= 0:
                    continue
                remaining = next_km - current
                if remaining <= 1000:
                    alerts.append({
                        "vehicle_id": r[1], "unit_number": r[2],
                        "maintenance_type": r[3], "next_km": next_km,
                        "current_km": current, "remaining_km": remaining,
                        "overdue": remaining < 0
                    })
            return alerts

    # ── KPIs & Trends ────────────────────────────────────────────

    def fleet_kpi_stats(self) -> dict:
        now = datetime.now()
        month_start = now.strftime("%Y-%m-01")
        with self._conn() as conn:
            total_vehicles = conn.execute(
                "SELECT COUNT(*) FROM vehicles WHERE status='activo'").fetchone()[0] or 0
            month = conn.execute(
                "SELECT COALESCE(SUM(liters),0), COALESCE(SUM(total_cost),0), "
                "COALESCE(SUM(km_traveled),0), COUNT(*) "
                "FROM fuel_records WHERE record_date >= ?", (month_start,)).fetchone()
            avg_kml = conn.execute(
                "SELECT CASE WHEN SUM(liters)>0 THEN SUM(km_traveled)/SUM(liters) ELSE 0 END "
                "FROM fuel_records WHERE record_date >= ? AND km_traveled > 0",
                (month_start,)).fetchone()
            return {
                "total_vehicles": total_vehicles,
                "month_liters": float(month[0]) if month else 0,
                "month_cost": float(month[1]) if month else 0,
                "month_km": float(month[2]) if month else 0,
                "month_records": int(month[3]) if month else 0,
                "month_avg_kml": round(float(avg_kml[0]), 2) if avg_kml and avg_kml[0] else 0,
            }

    def fuel_trend(self, vehicle_id: int, limit: int = 30) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT record_date, kml_real, cost_per_km, liters, total_cost, odometer_km, driver "
                "FROM fuel_records WHERE vehicle_id=? AND kml_real > 0 "
                "ORDER BY record_date ASC LIMIT ?",
                (vehicle_id, limit)).fetchall()
            return [{"date": r[0], "kml": r[1], "cpk": r[2], "liters": r[3],
                     "cost": r[4], "km": r[5], "driver": r[6]} for r in rows]
