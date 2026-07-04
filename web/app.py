"""Flask app: serves the SPA and the annotation REST API."""
from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

from .runner import JobRunner

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".webp")
# Allow all paths (local single-user tool); _path_allowed just validates is_file.
_ALLOWED_ROOTS = None


def _is_image(name: str) -> bool:
    return name.lower().endswith(_IMAGE_EXTS)


def _count_images_recursive(path: Path) -> int:
    n = 0
    for _root, _dirs, files in os.walk(path):
        n += sum(1 for f in files if f.lower().endswith(_IMAGE_EXTS))
    return n


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def _path_allowed(path: Path) -> bool:
    if _ALLOWED_ROOTS is None:
        return True
    try:
        resolved = str(path.resolve())
    except Exception:
        return False
    return any(resolved.startswith(root) for root in _ALLOWED_ROOTS)


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    runner = JobRunner.instance()

    @app.route("/")
    def index() -> Response:
        return app.send_static_file("index.html")

    # ---- dataset browser -------------------------------------------------
    @app.route("/api/browse")
    def browse():
        raw = request.args.get("path", r"C:\Users\BTW\Desktop")
        path = Path(raw)
        if not path.exists() or not path.is_dir():
            return jsonify({"error": "目录不存在", "path": raw}), 400
        subdirs = []
        try:
            for child in sorted(path.iterdir()):
                if child.is_dir():
                    direct = sum(1 for f in child.iterdir() if f.is_file() and _is_image(f.name))
                    subdirs.append({"name": child.name, "path": str(child), "image_count": direct})
        except PermissionError:
            pass
        return jsonify({
            "path": str(path),
            "subdirs": subdirs,
            "total_images": _count_images_recursive(path),
        })

    # ---- start a job -----------------------------------------------------
    @app.route("/api/run", methods=["POST"])
    def run_job():
        data = request.get_json(force=True, silent=True) or {}
        input_dir = data.get("input")
        output_dir = data.get("output")
        if not input_dir or not output_dir:
            return jsonify({"ok": False, "error": "需要 input 和 output"}), 400
        if not Path(input_dir).is_dir():
            return jsonify({"ok": False, "error": f"输入目录不存在: {input_dir}"}), 400
        result = runner.start(
            input_dir=input_dir,
            output_dir=output_dir,
            v6_backend=data.get("v6_backend", "paddleocr"),
            no_vl=bool(data.get("no_vl", False)),
            limit=data.get("limit") or None,
            use_gpu=not bool(data.get("cpu", False)),
        )
        if not result.get("ok"):
            return jsonify(result), 409
        return jsonify(result)

    # ---- poll progress ---------------------------------------------------
    @app.route("/api/progress")
    def progress():
        return jsonify(runner.progress())

    # ---- read results from an output dir ---------------------------------
    @app.route("/api/results")
    def results():
        output = request.args.get("output")
        if not output or not Path(output).is_dir():
            return jsonify({"error": "输出目录不存在"}), 400
        out_dir = Path(output)
        summary = {}
        sp = out_dir / "summary.json"
        if sp.exists():
            try:
                summary = json.loads(sp.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        pre = _read_jsonl(out_dir / "pre_annotated.jsonl")
        review = _read_jsonl(out_dir / "needs_review.jsonl")
        corrected = _read_jsonl(out_dir / "corrected.jsonl")
        corrected_files = {r.get("filename") for r in corrected}

        kind = request.args.get("type", "all")
        page = max(1, int(request.args.get("page", 1)))
        size = min(200, int(request.args.get("size", 50)))

        def paginate(rows: list[dict]) -> dict:
            total = len(rows)
            start = (page - 1) * size
            return {"items": rows[start:start + size], "total": total,
                    "page": page, "size": size, "pages": (total + size - 1) // size}

        resp = {
            "summary": summary,
            "counts": {
                "pre": len(pre), "review": len(review),
                "corrected": len(corrected),
                "review_remaining": sum(1 for r in review if r.get("filename") not in corrected_files),
            },
            "corrected_files": sorted(corrected_files),
        }
        if kind == "pre":
            resp["pre"] = paginate(pre)
        elif kind == "review":
            resp["review"] = paginate(review)
        elif kind == "corrected":
            resp["corrected"] = paginate(corrected)
        else:
            resp["pre"] = paginate(pre)
            resp["review"] = paginate(review)
        return jsonify(resp)

    # ---- serve an image (path-validated) ---------------------------------
    @app.route("/api/image")
    def image():
        raw = request.args.get("path", "")
        path = Path(raw)
        if not path.is_file() or not _is_image(path.name):
            return jsonify({"error": "图片不存在"}), 404
        if not _path_allowed(path):
            return jsonify({"error": "路径不在允许范围内"}), 403
        return send_file(str(path.resolve()))

    # ---- save a human correction -----------------------------------------
    @app.route("/api/correct", methods=["POST"])
    def correct():
        data = request.get_json(force=True, silent=True) or {}
        output = data.get("output")
        filename = data.get("filename")
        text = data.get("text")
        if not output or not filename or text is None:
            return jsonify({"ok": False, "error": "需要 output, filename, text"}), 400
        out_dir = Path(output)
        out_dir.mkdir(parents=True, exist_ok=True)
        corr_path = out_dir / "corrected.jsonl"
        with open(corr_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"filename": filename, "text": text}, ensure_ascii=False) + "\n")
        return jsonify({"ok": True})

    # ---- SAM3 proxy routes ------------------------------------------------
    from .sam3_proxy import Sam3Client
    sam3 = Sam3Client.instance()

    @app.route("/api/sam3/status")
    def sam3_status():
        return jsonify(sam3.status())

    @app.route("/api/sam3/set_image", methods=["POST"])
    def sam3_set_image():
        d = request.get_json(force=True, silent=True) or {}
        p = d.get("image_path", "")
        if not _path_allowed(Path(p)):
            return jsonify({"ok": False, "error": "路径不在允许范围内"}), 403
        res, code = sam3.set_image(p)
        return jsonify(res), code

    @app.route("/api/sam3/predict", methods=["POST"])
    def sam3_predict():
        res, code = sam3.predict(request.get_json(force=True, silent=True) or {})
        return jsonify(res), code

    @app.route("/api/sam3/ground", methods=["POST"])
    def sam3_ground():
        res, code = sam3.ground(request.get_json(force=True, silent=True) or {})
        return jsonify(res), code

    @app.route("/api/sam3/reset", methods=["POST"])
    def sam3_reset():
        res, code = sam3.reset()
        return jsonify(res), code

    # ---- LocateAnything proxy routes -------------------------------------
    from .la_proxy import LaClient
    la = LaClient.instance()

    @app.route("/api/la/status")
    def la_status():
        return jsonify(la.status())

    @app.route("/api/la/detect", methods=["POST"])
    def la_detect():
        d = request.get_json(force=True, silent=True) or {}
        p = d.get("image_path", "")
        if not _path_allowed(Path(p)):
            return jsonify({"ok": False, "error": "路径不在允许范围内"}), 403
        res, code = la.detect(p, d.get("categories", []))
        return jsonify(res), code

    @app.route("/api/la/ground", methods=["POST"])
    def la_ground():
        d = request.get_json(force=True, silent=True) or {}
        p = d.get("image_path", "")
        if not _path_allowed(Path(p)):
            return jsonify({"ok": False, "error": "路径不在允许范围内"}), 403
        res, code = la.ground(p, d.get("phrase", ""), d.get("mode", "multi"))
        return jsonify(res), code

    @app.route("/api/la/detect_text", methods=["POST"])
    def la_detect_text():
        d = request.get_json(force=True, silent=True) or {}
        p = d.get("image_path", "")
        if not _path_allowed(Path(p)):
            return jsonify({"ok": False, "error": "路径不在允许范围内"}), 403
        res, code = la.detect_text(p)
        return jsonify(res), code

    @app.route("/api/la/point", methods=["POST"])
    def la_point():
        d = request.get_json(force=True, silent=True) or {}
        p = d.get("image_path", "")
        if not _path_allowed(Path(p)):
            return jsonify({"ok": False, "error": "路径不在允许范围内"}), 403
        res, code = la.point(p, d.get("phrase", ""))
        return jsonify(res), code

    # ---- annotation save/load --------------------------------------------
    @app.route("/api/annotations/save", methods=["POST"])
    def ann_save():
        d = request.get_json(force=True, silent=True) or {}
        out_dir = d.get("output_dir", "")
        image_name = d.get("image_name", "")
        anns = d.get("annotations", [])
        if not out_dir or not image_name:
            return jsonify({"ok": False, "error": "需要 output_dir 和 image_name"}), 400
        ann_dir = Path(out_dir) / "annotations"
        ann_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(image_name).stem
        path = ann_dir / f"{stem}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"image_name": image_name, "annotations": anns}, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "path": str(path)})

    @app.route("/api/annotations/load")
    def ann_load():
        out_dir = request.args.get("output_dir", "")
        image_name = request.args.get("image_name", "")
        if not out_dir or not image_name:
            return jsonify({"ok": False, "error": "需要 output_dir 和 image_name"}), 400
        stem = Path(image_name).stem
        path = Path(out_dir) / "annotations" / f"{stem}.json"
        if not path.exists():
            return jsonify({"ok": True, "annotations": []})
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return jsonify({"ok": True, "annotations": data.get("annotations", [])})
        except json.JSONDecodeError:
            return jsonify({"ok": True, "annotations": []})

    # ---- export results ---------------------------------------------------
    @app.route("/api/export/results")
    def export_results():
        out_dir = request.args.get("output_dir", "")
        if not out_dir or not Path(out_dir).is_dir():
            return jsonify({"error": "输出目录不存在"}), 400
        results = []
        for jf in ("pre_annotated.jsonl", "corrected.jsonl", "v6_only.jsonl"):
            p = Path(out_dir) / jf
            if not p.exists():
                continue
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    obj["source"] = jf.replace(".jsonl", "")
                    results.append(obj)
                except json.JSONDecodeError:
                    pass
        return jsonify({"ok": True, "total": len(results), "data": results})

    # ---- file list (images in a folder) -----------------------------------
    @app.route("/api/files/list")
    def files_list():
        raw = request.args.get("path", "")
        if not raw or not Path(raw).is_dir():
            return jsonify({"error": "目录不存在"}), 400
        p = Path(raw)
        files = []
        for child in sorted(p.iterdir()):
            if child.is_file() and _is_image(child.name):
                files.append({"name": child.name, "path": str(child)})
        return jsonify({"ok": True, "path": str(p), "files": files})

    return app
