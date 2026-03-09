import json
from datetime import datetime

def _row_to_dict(cursor) -> dict | None:
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, dict):
        return dict(row)
    if hasattr(cursor, "description") and cursor.description:
        cols = [col[0] for col in cursor.description]
        return dict(zip(cols, row))
    return None

def _rows_to_dicts(cursor) -> list[dict]:
    rows = cursor.fetchall()
    if not rows:
        return []
    if isinstance(rows[0], dict):
        return [dict(r) for r in rows]
    if hasattr(cursor, "description") and cursor.description:
        cols = [col[0] for col in cursor.description]
        return [dict(zip(cols, r)) for r in rows]
    return []

class InventoryStoreMixin:
    """
    Handles operations for the Inventory module.
    Expects self._conn() to be available from AppStore context.
    """

    # ── Materials (Catalog & Stock) ──────────────────────────────

    def list_materials(self, include_inactive: bool = False) -> list[dict]:
        with self._conn() as conn:
            if include_inactive:
                cur = conn.execute("SELECT * FROM materials ORDER BY name")
            else:
                cur = conn.execute("SELECT * FROM materials WHERE status='activo' ORDER BY name")
            return _rows_to_dicts(cur)

    def save_material(self, data: dict, actor: str = "") -> dict:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        name = (data.get("name") or "").strip()
        if not name:
            raise ValueError("El nombre del material es requerido.")
        
        doser_alias = (data.get("doser_alias") or "").strip()
        unit = (data.get("unit") or "kg").strip()
        min_stock = float(data.get("min_stock", 0))
        status = data.get("status", "activo")
        mat_id = data.get("id")

        with self._conn() as conn:
            if mat_id:
                # Update existing material (current_stock is handled via transactions, NOT here directly, 
                # but if an admin forces a manual correction it could be passed, tho better to do via adjustment)
                conn.execute(
                    """UPDATE materials SET name=?, doser_alias=?, unit=?, min_stock=?, status=?, updated_at=?
                       WHERE id=?""",
                    (name, doser_alias, unit, min_stock, status, now, int(mat_id))
                )
                conn.commit()
                return {"id": int(mat_id), "saved": True}
            else:
                # New material starts with 0 stock
                conn.execute(
                    """INSERT INTO materials (name, doser_alias, unit, current_stock, min_stock, status, created_at, updated_at)
                       VALUES (?, ?, ?, 0, ?, ?, ?, ?)""",
                    (name, doser_alias, unit, min_stock, status, now, now)
                )
                conn.commit()
                row = _row_to_dict(conn.execute("SELECT id FROM materials WHERE name=?", (name,)))
                return {"id": row["id"] if row else 0, "saved": True}

    def delete_material(self, material_id: int, actor: str = "") -> bool:
        """Soft delete material"""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._conn() as conn:
            conn.execute(
                "UPDATE materials SET name = name || '_del_' || id, status='inactivo', updated_at=? WHERE id=?", 
                (now, material_id)
            )
            conn.commit()
        return True

    # ── Inventory Transactions (The Kardex/Ledger) ───────────────

    def list_inventory_transactions(self, material_id: int | None = None, limit: int = 100) -> list[dict]:
        with self._conn() as conn:
            if material_id:
                cur = conn.execute(
                    """SELECT t.*, m.name as material_name, m.unit 
                       FROM inventory_transactions t 
                       JOIN materials m ON m.id = t.material_id 
                       WHERE t.material_id=? 
                       ORDER BY t.created_at DESC LIMIT ?""",
                    (material_id, limit)
                )
            else:
                cur = conn.execute(
                    """SELECT t.*, m.name as material_name, m.unit 
                       FROM inventory_transactions t 
                       JOIN materials m ON m.id = t.material_id 
                       ORDER BY t.created_at DESC LIMIT ?""",
                    (limit,)
                )
            return _rows_to_dicts(cur)

    def record_inventory_transaction(self, material_id: int, transaction_type: str, amount: float, reference: str = "", actor: str = "") -> dict:
        """
        Records an atomic movement (ENTRADA or SALIDA) and updates the material's current_stock.
        This must be called within a connection context ideally, but here we manage its own transaction to ensure stock consistency.
        """
        if transaction_type not in ("ENTRADA", "SALIDA"):
            raise ValueError("El tipo de transaccion debe ser ENTRADA o SALIDA.")
        
        if amount <= 0:
            raise ValueError("La cantidad debe ser mayor a 0.")

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with self.lock:  # Use the app's db lock
            with self._conn() as conn:
                # 1. Look up material
                mat_row = _row_to_dict(conn.execute("SELECT id, current_stock FROM materials WHERE id=?", (material_id,)))
                if not mat_row:
                    raise ValueError(f"Material {material_id} no encontrado.")
                
                current_stock = float(mat_row["current_stock"])
                
                # 2. Calculate new stock
                # For SALIDA we allow negative stock just in case they haven't recorded the entry ticket yet
                new_stock = current_stock + amount if transaction_type == "ENTRADA" else current_stock - amount

                # 3. Insert transaction log
                conn.execute(
                    """INSERT INTO inventory_transactions (material_id, transaction_type, amount, reference, actor, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (material_id, transaction_type, amount, reference, actor, now)
                )

                # 4. Update material stock
                conn.execute(
                    "UPDATE materials SET current_stock=?, updated_at=? WHERE id=?",
                    (new_stock, now, material_id)
                )

                conn.commit()

                return {
                    "ok": True,
                    "material_id": material_id,
                    "previous_stock": current_stock,
                    "new_stock": new_stock
                }

    def delete_inventory_transaction(self, transaction_id: int, actor: str = "") -> dict:
        """
        Deletes a specific inventory transaction and reverses its effect on the material stock.
        """
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with self.lock:
            with self._conn() as conn:
                # 1. Look up the transaction
                trx_row = conn.execute("SELECT * FROM inventory_transactions WHERE id=?", (transaction_id,)).fetchone()
                if not trx_row:
                    raise ValueError(f"Transacción {transaction_id} no encontrada.")
                
                trx = dict(trx_row)
                material_id = trx["material_id"]
                transaction_type = trx["transaction_type"]
                amount = float(trx["amount"])

                # 2. Look up the material
                mat_row = conn.execute("SELECT id, current_stock FROM materials WHERE id=?", (material_id,)).fetchone()
                if not mat_row:
                    raise ValueError(f"Material afectado {material_id} no encontrado.")
                
                current_stock = float(mat_row["current_stock"])

                # 3. Calculate reversed stock
                if transaction_type == "ENTRADA":
                    new_stock = current_stock - amount
                elif transaction_type == "SALIDA":
                    new_stock = current_stock + amount
                else:
                    raise ValueError(f"Tipo de transacción desconocido: {transaction_type}")

                # 4. Delete the transaction
                conn.execute("DELETE FROM inventory_transactions WHERE id=?", (transaction_id,))

                # 5. Reverse material stock
                conn.execute(
                    "UPDATE materials SET current_stock=?, updated_at=? WHERE id=?",
                    (new_stock, now, material_id)
                )

                conn.commit()

                return {
                    "ok": True,
                    "transaction_id": transaction_id,
                    "material_id": material_id,
                    "previous_stock": current_stock,
                    "new_stock": new_stock
                }

    def clear_inventory_transactions(self) -> bool:
        """
        Deletes all history from the inventory_transactions table.
        Does NOT resetting the current_stock balance on the materials.
        """
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM inventory_transactions")
                conn.commit()
                return True

    def get_daily_summary(self, date_str: str) -> dict:
        """
        Returns a summary of production and material consumption for a given date (YYYY-MM-DD).
        """
        with self._conn() as conn:
            # 1. Production Summary (from remisiones)
            # We filter by created_at starting with date_str
            cur = conn.execute(
                """SELECT 
                    COUNT(*) as total_remisiones,
                    SUM(dosificacion_m3) as total_m3,
                    SUM(peso_teorico_total) as total_teorico_kg,
                    SUM(peso_real_total) as total_real_kg
                   FROM remisiones 
                   WHERE created_at LIKE ?""",
                (f"{date_str}%",)
            )
            prod = _row_to_dict(cur) or {
                "total_remisiones": 0, "total_m3": 0, "total_teorico_kg": 0, "total_real_kg": 0
            }

            # 2. Material Consumption (from inventory_transactions)
            cur = conn.execute(
                """SELECT 
                    m.name, m.unit, m.doser_alias,
                    SUM(CASE WHEN t.transaction_type='SALIDA' THEN t.amount ELSE 0 END) as total_salida,
                    SUM(CASE WHEN t.transaction_type='ENTRADA' THEN t.amount ELSE 0 END) as total_entrada
                   FROM inventory_transactions t
                   JOIN materials m ON m.id = t.material_id
                   WHERE t.created_at LIKE ?
                   GROUP BY m.id, m.name, m.unit, m.doser_alias
                   ORDER BY m.name""",
                (f"{date_str}%",)
            )
            consumption = _rows_to_dicts(cur)

            # 3. Current Inventory
            cur = conn.execute(
                "SELECT name, current_stock, unit, min_stock FROM materials WHERE name NOT LIKE ? ORDER BY name",
                ('%_DEL_%',)
            )
            current_inv = _rows_to_dicts(cur)

            return {
                "date": date_str,
                "production": {
                    "total_remisiones": int(prod.get("total_remisiones") or 0),
                    "total_m3": float(prod.get("total_m3") or 0),
                    "total_teorico_kg": float(prod.get("total_teorico_kg") or 0),
                    "total_real_kg": float(prod.get("total_real_kg") or 0),
                },
                "consumption": consumption,
                "current_inventory": current_inv
            }
