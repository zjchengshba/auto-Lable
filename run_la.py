"""LocateAnything detection service (runs in locateanything conda env, :8002).

Start with:
    D:\\miniconda\\envs\\locateanything\\python.exe run_la.py

Provides object detection, phrase grounding, text detection, and pointing
via HTTP. The Flask main app (:8000) proxies requests here.

Model: F:\\eagle\\Embodied\\LocateAnything-3B
Code:  F:\\eagle\\Embodied (locateanything_worker.py)
"""
from __future__ import annotations

import base64
import io
import os
import sys
import re
import traceback

# Reduce GPU memory fragmentation before torch is imported
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# Add LocateAnything source to path
EAGLE_EMBODIED = r"F:\eagle\Embodied"
if EAGLE_EMBODIED not in sys.path:
    sys.path.insert(0, EAGLE_EMBODIED)
# Also add model dir (for batch_utils/kernel_utils if needed)
MODEL_DIR = r"F:\eagle\Embodied\LocateAnything-3B"
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)

from PIL import Image, ImageDraw
from flask import Flask, jsonify, request

PORT = 8002
MAX_IMG_SIDE = 1280   # cap longest side to avoid OOM on 12GB GPUs
MAX_NEW_TOKENS = 1024  # reduce from default 2048

app = Flask(__name__)
_worker = None


def _resize_for_inference(img: Image.Image):
    """Return (resized_image, orig_w, orig_h).

    The model outputs normalized [0,1000] coordinates, so we only need the
    original dimensions to scale boxes back. Resizing caps the longest side
    at MAX_IMG_SIDE to keep vision-encoder feature maps small.
    """
    orig_w, orig_h = img.size
    longest = max(orig_w, orig_h)
    if longest <= MAX_IMG_SIDE:
        return img, orig_w, orig_h
    scale = MAX_IMG_SIDE / longest
    new_w = max(1, round(orig_w * scale))
    new_h = max(1, round(orig_h * scale))
    return img.resize((new_w, new_h), Image.LANCZOS), orig_w, orig_h


def get_worker():
    global _worker
    if _worker is None:
        import torch
        from locateanything_worker import LocateAnythingWorker
        print("Loading LocateAnything-3B model ...", flush=True)
        _worker = LocateAnythingWorker(
            MODEL_DIR,
            device="cuda" if torch.cuda.is_available() else "cpu",
            dtype=torch.bfloat16,
            use_batch_runtime=False,
        )
        print("LocateAnything ready.", flush=True)
    return _worker


def parse_boxes(answer: str, image_width: int, image_height: int):
    """Parse <ref>label</ref><box><x1><y1><x2><y2></box> from model output."""
    boxes = []
    # Pattern: <ref>label</ref><box><x1><y1><x2><y2></box>
    for m in re.finditer(r"<ref>(.*?)</ref><box><(\d+)><(\d+)><(\d+)><(\d+)></box>", answer):
        label = m.group(1)
        x1, y1, x2, y2 = [int(g) for g in m.groups()[1:]]
        # Normalize: model may output inverted coordinates
        x1, x2 = min(x1, x2), max(x1, x2)
        y1, y2 = min(y1, y2), max(y1, y2)
        boxes.append({
            "label": label,
            "x1": round(x1 / 1000 * image_width, 1),
            "y1": round(y1 / 1000 * image_height, 1),
            "x2": round(x2 / 1000 * image_width, 1),
            "y2": round(y2 / 1000 * image_height, 1),
        })
    # Also handle boxes without ref label
    for m in re.finditer(r"(?<!<ref>)<box><(\d+)><(\d+)><(\d+)><(\d+)></box>", answer):
        x1, y1, x2, y2 = [int(g) for g in m.groups()]
        x1, x2 = min(x1, x2), max(x1, x2)
        y1, y2 = min(y1, y2), max(y1, y2)
        # Skip if already captured by ref pattern
        if not any(b["x1"] == round(x1 / 1000 * image_width, 1) for b in boxes):
            boxes.append({
                "label": "object",
                "x1": round(x1 / 1000 * image_width, 1),
                "y1": round(y1 / 1000 * image_height, 1),
                "x2": round(x2 / 1000 * image_width, 1),
                "y2": round(y2 / 1000 * image_height, 1),
            })
    # Handle point format: <box><x><y></box>
    points = []
    for m in re.finditer(r"<box><(\d+)><(\d+)></box>", answer):
        x, y = int(m.group(1)), int(m.group(2))
        points.append({
            "x": round(x / 1000 * image_width, 1),
            "y": round(y / 1000 * image_height, 1),
        })
    return boxes, points


def draw_boxes(image, boxes, points=None):
    """Draw detection boxes on a copy of the image and return PNG bytes."""
    img = image.copy()
    draw = ImageDraw.Draw(img)
    colors = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899"]
    for i, b in enumerate(boxes):
        color = colors[i % len(colors)]
        x1, y1, x2, y2 = b["x1"], b["y1"], b["x2"], b["y2"]
        # Ensure x1<=x2 and y1<=y2 (model may return inverted coords)
        x1, x2 = min(x1, x2), max(x1, x2)
        y1, y2 = min(y1, y2), max(y1, y2)
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        label = b.get("label", "object")
        # Draw label background (clamp to image bounds)
        ty = max(0, y1 - 16)
        bbox = draw.textbbox((x1, ty), label)
        draw.rectangle([bbox[0] - 2, bbox[1] - 2, bbox[2] + 2, bbox[3] + 2], fill=color)
        draw.text((x1, ty), label, fill="#fff")
    if points:
        for p in points:
            r = 8
            draw.ellipse([p["x"] - r, p["y"] - r, p["x"] + r, p["y"] + r], fill="#ef4444", outline="#fff", width=2)
    return img


@app.route("/health")
def health():
    try:
        import torch
        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""
    except:
        gpu = ""
    loaded = _worker is not None
    return jsonify({"ok": True, "online": True, "gpu": gpu, "loaded": loaded})


def _run_inference(predict_fn, image_path, **kwargs):
    """Shared inference pipeline: resize → predict → scale boxes → encode.

    Returns (boxes, points, orig_w, orig_h, annotated_image) or raises.
    """
    img = Image.open(image_path).convert("RGB")
    orig_w, orig_h = img.size
    inf_img, _, _ = _resize_for_inference(img)
    worker = get_worker()
    result = predict_fn(inf_img, **kwargs)
    # Coordinates are normalized [0,1000] — scale to ORIGINAL dimensions
    boxes, points = parse_boxes(result["answer"], orig_w, orig_h)
    annotated = draw_boxes(img, boxes, points)
    return boxes, points, orig_w, orig_h, annotated


def _encode_jpeg(annotated):
    buf = io.BytesIO()
    annotated.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _cleanup_gpu():
    """Free fragmented GPU memory after each request."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


@app.route("/detect", methods=["POST"])
def detect():
    d = request.get_json(force=True, silent=True) or {}
    image_path = d.get("image_path", "")
    categories = d.get("categories", [])
    if not image_path or not os.path.isfile(image_path):
        return jsonify({"ok": False, "error": f"image not found: {image_path}"}), 400
    if not categories:
        return jsonify({"ok": False, "error": "categories required"}), 400
    try:
        boxes, points, w, h, annotated = _run_inference(
            lambda img: get_worker().detect(img, categories, generation_mode="hybrid",
                                            max_new_tokens=MAX_NEW_TOKENS, verbose=False),
            image_path,
        )
        return jsonify({"ok": True, "boxes": boxes, "points": points,
                        "image": _encode_jpeg(annotated), "width": w, "height": h})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _cleanup_gpu()


@app.route("/ground", methods=["POST"])
def ground():
    d = request.get_json(force=True, silent=True) or {}
    image_path = d.get("image_path", "")
    phrase = d.get("phrase", "").strip()
    mode = d.get("mode", "multi")
    if not image_path or not os.path.isfile(image_path):
        return jsonify({"ok": False, "error": f"image not found: {image_path}"}), 400
    if not phrase:
        return jsonify({"ok": False, "error": "phrase required"}), 400
    try:
        def _predict(img):
            worker = get_worker()
            kw = dict(max_new_tokens=MAX_NEW_TOKENS, verbose=False)
            if mode == "single":
                return worker.ground_single(img, phrase, **kw)
            elif mode == "text":
                return worker.ground_text(img, phrase, **kw)
            return worker.ground_multi(img, phrase, **kw)

        boxes, points, w, h, annotated = _run_inference(_predict, image_path)
        return jsonify({"ok": True, "boxes": boxes, "points": points,
                        "image": _encode_jpeg(annotated), "width": w, "height": h})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _cleanup_gpu()


@app.route("/detect_text", methods=["POST"])
def detect_text():
    d = request.get_json(force=True, silent=True) or {}
    image_path = d.get("image_path", "")
    if not image_path or not os.path.isfile(image_path):
        return jsonify({"ok": False, "error": f"image not found: {image_path}"}), 400
    try:
        boxes, points, w, h, annotated = _run_inference(
            lambda img: get_worker().detect_text(img, max_new_tokens=MAX_NEW_TOKENS, verbose=False),
            image_path,
        )
        return jsonify({"ok": True, "boxes": boxes, "points": points,
                        "image": _encode_jpeg(annotated), "width": w, "height": h})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _cleanup_gpu()


@app.route("/point", methods=["POST"])
def point():
    d = request.get_json(force=True, silent=True) or {}
    image_path = d.get("image_path", "")
    phrase = d.get("phrase", "").strip()
    if not image_path or not os.path.isfile(image_path):
        return jsonify({"ok": False, "error": f"image not found: {image_path}"}), 400
    if not phrase:
        return jsonify({"ok": False, "error": "phrase required"}), 400
    try:
        boxes, points, w, h, annotated = _run_inference(
            lambda img: get_worker().point(img, phrase, max_new_tokens=MAX_NEW_TOKENS, verbose=False),
            image_path,
        )
        return jsonify({"ok": True, "boxes": boxes, "points": points,
                        "image": _encode_jpeg(annotated), "width": w, "height": h})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _cleanup_gpu()


if __name__ == "__main__":
    # Pre-load model at startup
    get_worker()
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=False)
