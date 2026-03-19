import os
import mimetypes
import uuid
from flask import Blueprint, Response, current_app, jsonify, render_template, request

def register_qc_lab_routes(app, store, login_required, require_roles=None, allowed_roles=None):
    """
    Registers QC Lab-related API routes to the given Flask app via a Blueprint.
    """
    qc_bp = Blueprint("qc_lab", __name__, url_prefix="/api/qclab")
    allowed = tuple(allowed_roles or ())
    route_guard = require_roles(*allowed) if (require_roles and allowed) else login_required

    @qc_bp.route("/samples", methods=["GET"])
    @route_guard
    def api_list_samples():
        limit = request.args.get("limit", 100, type=int)
        try:
            return jsonify({"ok": True, "samples": store.list_qc_samples(limit=limit)})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples/<int:sample_id>", methods=["GET"])
    @route_guard
    def api_get_sample(sample_id):
        try:
            sample = store.get_qc_sample(sample_id)
            if not sample:
                return jsonify({"ok": False, "error": "Muestra no encontrada"}), 404
            return jsonify({"ok": True, "sample": sample})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples/<int:sample_id>", methods=["DELETE"])
    @route_guard
    def api_delete_sample(sample_id):
        try:
            success = store.delete_qc_sample(sample_id)
            if not success:
                return jsonify({"ok": False, "error": "Muestra no encontrada"}), 404
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/lookup_remision/<remision_no>", methods=["GET"])
    @route_guard
    def api_lookup_remision(remision_no):
        try:
            remision = store.get_remision_by_no(remision_no)
            if not remision:
                return jsonify({"ok": False, "error": "Remision no encontrada"}), 404
            return jsonify({"ok": True, "remision": remision})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples", methods=["POST"])
    @route_guard
    def api_save_sample():
        payload = request.json
        try:
            saved = store.save_qc_sample(payload, request.current_user["username"])
            return jsonify({"ok": True, "sample": saved})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/cylinders", methods=["GET"])
    @route_guard
    def api_get_all_cylinders():
        limit = request.args.get("limit", 500, type=int)
        pending_only = request.args.get("pending_only", "false") == "true"
        try:
            cylinders = store.list_qc_cylinders(pending_only=pending_only, limit=limit)
            return jsonify({"ok": True, "cylinders": cylinders})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/cylinders/<int:cylinder_id>/test", methods=["POST"])
    @route_guard
    def api_save_cylinder_test(cylinder_id):
        file = request.files.get("image")
        image_path = ""
        image_data = None
        
        if file and file.filename:
            uploads_dir = os.path.join(app.config.get("BASE_DIR", "."), "static", "uploads", "qc_images")
            os.makedirs(uploads_dir, exist_ok=True)
            
            ext = os.path.splitext(file.filename)[1]
            unique_name = f"{uuid.uuid4().hex}{ext}"
            full_path = os.path.join(uploads_dir, unique_name)
            image_data = file.read()
            file.seek(0)
            file.save(full_path)
            image_path = f"/static/uploads/qc_images/{unique_name}"
        
        try:
            payload = request.form.to_dict()
            updated_sample = store.test_qc_cylinder(cylinder_id, payload, image_path, image_data)
            return jsonify({"ok": True, "sample": updated_sample})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/cylinders/<int:cylinder_id>/image", methods=["GET"])
    @route_guard
    def api_get_cylinder_image(cylinder_id):
        try:
            with store._conn() as conn:
                row = conn.execute(
                    "SELECT image_data, image_path FROM qc_cylinders WHERE id = ? LIMIT 1",
                    (cylinder_id,),
                ).fetchone()
                if not row:
                    return jsonify({"ok": False, "error": "Cilindro no encontrado"}), 404

                image_path = row["image_path"] or ""
                mime_type = mimetypes.guess_type(image_path)[0] or "image/jpeg"
                image_data = row["image_data"]

                if image_data:
                    return Response(image_data, mimetype=mime_type)

                if image_path:
                    rel_path = image_path[1:] if image_path.startswith("/") else image_path
                    full_path = os.path.join(current_app.root_path, rel_path)
                    if os.path.exists(full_path):
                        with open(full_path, "rb") as fh:
                            return Response(fh.read(), mimetype=mime_type)

                return jsonify({"ok": False, "error": "Imagen no encontrada"}), 404
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/stats/trends", methods=["GET"])
    @route_guard
    def api_get_qc_trends():
        start_date = request.args.get("start_date", "").strip()
        end_date = request.args.get("end_date", "").strip()

        try:
            with store._conn() as conn:
                sql = """
                    SELECT c.id, c.sample_id, c.target_age_days, c.expected_test_date, c.status,
                           c.strength_kgcm2, c.break_date,
                           s.sample_code, s.fc_expected, s.remision_id, s.cast_date,
                           r.formula
                    FROM qc_cylinders c
                    JOIN qc_samples s ON c.sample_id = s.id
                    LEFT JOIN remisiones r ON s.remision_id = r.remision_no
                    WHERE c.status = 'ensayado'
                """
                params = []

                if start_date:
                    sql += " AND s.cast_date >= ?"
                    params.append(f"{start_date} 00:00:00")
                if end_date:
                    sql += " AND s.cast_date <= ?"
                    params.append(f"{end_date} 23:59:59")

                sql += " ORDER BY s.cast_date DESC, c.target_age_days ASC LIMIT 500"
                cur = conn.execute(sql, tuple(params))
                tested = [dict(row) for row in cur.fetchall()]

            return jsonify({"ok": True, "data": tested})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/reports/trends", methods=["GET"])
    @route_guard
    def api_get_qc_trends_page():
        return render_template("qc_trends_report.html")

    app.register_blueprint(qc_bp)
