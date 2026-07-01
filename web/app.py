"""Flask app: serves the SPA and the annotation REST API."""
from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

from .runner import JobRunner

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".webp")
# Allowed roots for image serving (prevents arbitrary file read via path traversal).
_ALLOWED_ROOTS = [
    r"C:\Users\BTW\Desktop",
    "D:\\",
    "F:\\"
]


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

    return app
