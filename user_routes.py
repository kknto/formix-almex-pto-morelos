from flask import Blueprint, request, jsonify, session
from user_store import UserStoreMixin

def register_user_routes(app_store, require_roles):
    users_bp = Blueprint("users_api", __name__, url_prefix="/api/users")

    @users_bp.route("", methods=["GET"])
    @require_roles(["administrador"])
    def api_users_list():
        try:
            users = app_store.list_users()
            return jsonify({"ok": True, "users": users})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @users_bp.route("", methods=["POST"])
    @require_roles(["administrador"])
    def api_users_save():
        try:
            payload = request.get_json() or {}
            user = app_store.save_user(payload)
            return jsonify({"ok": True, "user": user})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    @users_bp.route("/<int:user_id>", methods=["DELETE"])
    @require_roles(["administrador"])
    def api_users_delete(user_id):
        try:
            success = app_store.delete_user(user_id)
            if success:
                return jsonify({"ok": True, "message": "Usuario eliminado"})
            return jsonify({"ok": False, "error": "No se encontró el usuario"}), 404
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @users_bp.route("/<int:user_id>/reset_password", methods=["POST"])
    @require_roles(["administrador"])
    def api_users_reset_password(user_id):
        try:
            payload = request.get_json() or {}
            new_password = payload.get("new_password")
            success = app_store.admin_reset_password(user_id, new_password)
            if success:
                return jsonify({"ok": True, "message": "Contraseña actualizada"})
            return jsonify({"ok": False, "error": "No se encontró el usuario"}), 404
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    return users_bp
