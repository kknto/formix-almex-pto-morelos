from flask import Blueprint, jsonify, request

def register_fleet_routes(app, store, login_required, require_roles=None, allowed_roles=None):
    """
    Registers all fleet-related API routes to the given Flask app via a Blueprint.
    This was extracted from app.py to modularize the codebase.
    """
    fleet_bp = Blueprint('fleet', __name__, url_prefix='/api/fleet')
    allowed = tuple(allowed_roles or ())
    route_guard = require_roles(*allowed) if (require_roles and allowed) else login_required

    @fleet_bp.route("/vehicles", methods=["GET"])
    @route_guard
    def api_fleet_vehicles_list():
        return jsonify({"ok": True, "vehicles": store.list_vehicles()})

    @fleet_bp.route("/vehicles", methods=["POST"])
    @route_guard
    def api_fleet_vehicles_save():
        data = request.get_json(silent=True) or {}
        try:
            result = store.save_vehicle(data, actor=request.current_user["username"])
            return jsonify({"ok": True, **result, "vehicles": store.list_vehicles()})
        except Exception as exc:
            msg = str(exc)
            if "unique" in msg.lower() or "duplicate" in msg.lower():
                msg = f"Ya existe un vehiculo con ese numero de unidad."
            return jsonify({"ok": False, "error": msg}), 400

    @fleet_bp.route("/vehicles/<int:vehicle_id>", methods=["DELETE"])
    @route_guard
    def api_fleet_vehicles_delete(vehicle_id):
        store.delete_vehicle(vehicle_id, actor=request.current_user["username"])
        return jsonify({"ok": True, "vehicles": store.list_vehicles()})

    @fleet_bp.route("/fuel", methods=["GET"])
    @route_guard
    def api_fleet_fuel_list():
        vid = request.args.get("vehicle_id", type=int)
        limit = request.args.get("limit", 200, type=int)
        date_from = request.args.get("date_from", "")
        date_to = request.args.get("date_to", "")
        return jsonify({"ok": True, "records": store.list_fuel_records(
            vehicle_id=vid, limit=limit, date_from=date_from, date_to=date_to)})

    @fleet_bp.route("/fuel", methods=["POST"])
    @route_guard
    def api_fleet_fuel_save():
        data = request.get_json(silent=True) or {}
        try:
            result = store.save_fuel_record(data, actor=request.current_user["username"])
            return jsonify({"ok": True, **result})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @fleet_bp.route("/fuel/<int:record_id>", methods=["PUT"])
    @route_guard
    def api_fleet_fuel_edit(record_id):
        data = request.get_json(silent=True) or {}
        try:
            result = store.edit_fuel_record(record_id, data)
            return jsonify({"ok": True, **result})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @fleet_bp.route("/fuel/<int:record_id>", methods=["DELETE"])
    @route_guard
    def api_fleet_fuel_delete(record_id):
        store.delete_fuel_record(record_id)
        return jsonify({"ok": True})

    @fleet_bp.route("/summary", methods=["GET"])
    @route_guard
    def api_fleet_summary():
        return jsonify({"ok": True, "summary": store.fleet_summary()})

    @fleet_bp.route("/kpis", methods=["GET"])
    @route_guard
    def api_fleet_kpis():
        try:
            return jsonify({"ok": True, **store.fleet_kpi_stats()})
        except Exception as exc:
            return jsonify({"ok": True, "total_vehicles": 0, "month_liters": 0, "month_cost": 0, "month_avg_kml": 0})

    @fleet_bp.route("/trend/<int:vehicle_id>", methods=["GET"])
    @route_guard
    def api_fleet_trend(vehicle_id):
        return jsonify({"ok": True, "trend": store.fuel_trend(vehicle_id)})

    @fleet_bp.route("/maintenance", methods=["GET"])
    @route_guard
    def api_fleet_maintenance_list():
        vid = request.args.get("vehicle_id", type=int)
        return jsonify({"ok": True, "records": store.list_maintenance(vehicle_id=vid)})

    @fleet_bp.route("/maintenance", methods=["POST"])
    @route_guard
    def api_fleet_maintenance_save():
        data = request.get_json(silent=True) or {}
        try:
            result = store.save_maintenance(data, actor=request.current_user["username"])
            return jsonify({"ok": True, **result})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @fleet_bp.route("/maintenance/<int:record_id>", methods=["DELETE"])
    @route_guard
    def api_fleet_maintenance_delete(record_id):
        store.delete_maintenance(record_id)
        return jsonify({"ok": True})

    @fleet_bp.route("/alerts", methods=["GET"])
    @route_guard
    def api_fleet_alerts():
        try:
            return jsonify({"ok": True, "alerts": store.maintenance_alerts()})
        except Exception:
            return jsonify({"ok": True, "alerts": []})

    app.register_blueprint(fleet_bp)
