import os
import uuid
from flask import Blueprint, jsonify, request, current_app

def register_qc_lab_routes(app, store, login_required):
    """
    Registers QC Lab-related API routes to the given Flask app via a Blueprint.
    """
    qc_bp = Blueprint("qc_lab", __name__, url_prefix="/api/qclab")

    @qc_bp.route("/samples", methods=["GET"])
    @login_required
    def api_list_samples():
        limit = request.args.get("limit", 100, type=int)
        try:
            return jsonify({"ok": True, "samples": store.list_qc_samples(limit=limit)})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples/<int:sample_id>", methods=["GET"])
    @login_required
    def api_get_sample(sample_id):
        try:
            sample = store.get_qc_sample(sample_id)
            if not sample:
                return jsonify({"ok": False, "error": "Muestra no encontrada"}), 404
            return jsonify({"ok": True, "sample": sample})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples/<int:sample_id>", methods=["DELETE"])
    @login_required
    def api_delete_sample(sample_id):
        try:
            success = store.delete_qc_sample(sample_id)
            if not success:
                return jsonify({"ok": False, "error": "Muestra no encontrada"}), 404
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/samples", methods=["POST"])
    @login_required
    def api_save_sample():
        payload = request.json
        try:
            saved = store.save_qc_sample(payload, request.current_user["username"])
            return jsonify({"ok": True, "sample": saved})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/cylinders", methods=["GET"])
    @login_required
    def api_get_all_cylinders():
        limit = request.args.get("limit", 500, type=int)
        pending_only = request.args.get("pending_only", "false") == "true"
        try:
            cylinders = store.list_qc_cylinders(pending_only=pending_only, limit=limit)
            return jsonify({"ok": True, "cylinders": cylinders})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @qc_bp.route("/cylinders/<int:cylinder_id>/test", methods=["POST"])
    @login_required
    def api_save_cylinder_test(cylinder_id):
        file = request.files.get("image")
        image_path = ""
        
        if file and file.filename:
            uploads_dir = os.path.join(app.config.get("BASE_DIR", "."), "static", "uploads", "qc_images")
            os.makedirs(uploads_dir, exist_ok=True)
            
            ext = os.path.splitext(file.filename)[1]
            unique_name = f"{uuid.uuid4().hex}{ext}"
            full_path = os.path.join(uploads_dir, unique_name)
            file.save(full_path)
            image_path = f"/static/uploads/qc_images/{unique_name}"
        
        try:
            payload = request.form.to_dict()
            updated_sample = store.test_qc_cylinder(cylinder_id, payload, image_path)
            return jsonify({"ok": True, "sample": updated_sample})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    app.register_blueprint(qc_bp)
