from flask import Blueprint, jsonify, request

def register_inventory_routes(app, store, login_required, require_roles=None):
    """
    Registers all inventory-related API routes to the given Flask app via a Blueprint.
    """
    inv_bp = Blueprint('inventory', __name__, url_prefix='/api/inventory')

    @inv_bp.route("/materials", methods=["GET"])
    @login_required
    def api_inv_materials_list():
        return jsonify({"ok": True, "materials": store.list_materials()})

    @inv_bp.route("/materials", methods=["POST"])
    @login_required
    def api_inv_materials_save():
        data = request.get_json(silent=True) or {}
        try:
            result = store.save_material(data, actor=request.current_user["username"])
            return jsonify({"ok": True, **result, "materials": store.list_materials()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @inv_bp.route("/materials/<int:material_id>", methods=["DELETE"])
    @login_required
    def api_inv_materials_delete(material_id):
        store.delete_material(material_id, actor=request.current_user["username"])
        return jsonify({"ok": True, "materials": store.list_materials()})

    @inv_bp.route("/transactions", methods=["GET"])
    @login_required
    def api_inv_transactions_list():
        mat_id = request.args.get("material_id", type=int)
        limit = request.args.get("limit", 100, type=int)
        return jsonify({"ok": True, "transactions": store.list_inventory_transactions(material_id=mat_id, limit=limit)})

    @inv_bp.route("/transactions", methods=["POST"])
    @login_required
    def api_inv_transactions_save():
        data = request.get_json(silent=True) or {}
        try:
            mat_id = int(data.get("material_id", 0))
            t_type = data.get("transaction_type", "ENTRADA")
            amount = float(data.get("amount", 0))
            ref = data.get("reference", "")
            
            result = store.record_inventory_transaction(
                material_id=mat_id,
                transaction_type=t_type,
                amount=amount,
                reference=ref,
                actor=request.current_user["username"]
            )
            return jsonify({"ok": True, **result, "materials": store.list_materials()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @inv_bp.route("/transactions/<int:transaction_id>", methods=["DELETE"])
    @login_required
    def api_inv_transactions_delete(transaction_id):
        if request.current_user.get("role") != "administrador":
            return jsonify({"ok": False, "error": "Acceso denegado: se requiere rol de administrador"}), 403
            
        try:
            store.delete_inventory_transaction(transaction_id, actor=request.current_user["username"])
            return jsonify({
                "ok": True, 
                "materials": store.list_materials(),
                "transactions": store.list_inventory_transactions()
            })
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @inv_bp.route("/transactions", methods=["DELETE"])
    @login_required
    def api_inv_transactions_clear():
        if request.current_user.get("role") != "administrador":
            return jsonify({"ok": False, "error": "Acceso denegado: se requiere rol de administrador"}), 403
            
        try:
            store.clear_inventory_transactions()
            return jsonify({"ok": True, "transactions": store.list_inventory_transactions()})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @inv_bp.route("/daily_summary", methods=["GET"])
    @login_required
    def api_inv_daily_summary():
        date_str = request.args.get("date")
        if not date_str:
            return jsonify({"ok": False, "error": "Fecha requerida (YYYY-MM-DD)"}), 400
        try:
            summary = store.get_daily_summary(date_str)
            return jsonify({"ok": True, "summary": summary})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    app.register_blueprint(inv_bp)
