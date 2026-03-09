from werkzeug.security import generate_password_hash
import datetime

class UserStoreMixin:
    def list_users(self) -> list:
        with self._conn() as conn:
            cur = conn.execute(
                "SELECT id, username, role, is_active, created_at, last_login_at FROM users ORDER BY username"
            )
            return [dict(row) for row in cur.fetchall()]

    def save_user(self, payload: dict) -> dict:
        username = payload.get("username", "").strip()
        role = payload.get("role", "operador")
        is_active = payload.get("is_active", 1)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with self.lock:
            with self._conn() as conn:
                # Check if it's an update (exists by id or username)
                user_id = payload.get("id")
                if user_id:
                    # Update existing
                    conn.execute(
                        """
                        UPDATE users SET role = ?, is_active = ?, updated_at = ? 
                        WHERE id = ?
                        """,
                        (role, is_active, now, user_id)
                    )
                else:
                    # Insert new
                    if not username:
                        raise ValueError("Username is required")
                    password = payload.get("password")
                    if not password:
                        raise ValueError("Password is required for new users")
                        
                    password_hash = generate_password_hash(password)
                    try:
                        conn.execute(
                            """
                            INSERT INTO users(username, role, password_hash, is_active, must_change_password, password_updated_at, created_at, updated_at) 
                            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (username, role, password_hash, is_active, 1, now, now, now)
                        )
                    except Exception as e:
                        if "UNIQUE" in str(e):
                            raise ValueError(f"El usuario '{username}' ya existe.")
                        raise e
                        
                # Fetch updated
                cur = conn.execute("SELECT id, username, role, is_active, created_at, last_login_at FROM users WHERE username = ?", (username,))
                return dict(cur.fetchone())

    def admin_reset_password(self, user_id: int, new_password: str) -> bool:
        if not new_password:
            raise ValueError("La nueva contraseña no puede estar vacía")
        password_hash = generate_password_hash(new_password)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute(
                    "UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = ?, updated_at = ? WHERE id = ?",
                    (password_hash, now, now, user_id)
                )
                return cur.rowcount > 0

    def delete_user(self, user_id: int) -> bool:
        # We can do soft delete by setting is_active = 0, or hard delete if permitted.
        # Hard deleting could break foreign keys (e.g. audit_log, although audit log uses username currently).
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
                return cur.rowcount > 0
