"""SAM3 segmentation service (runs in sam3 conda env, :8001).

Start with:
    D:\\miniconda\\envs\\sam3\\python.exe run_sam3.py

Provides interactive point/box segmentation and text-grounding via HTTP.
The Flask main app (:8000) proxies requests here through web/sam3_proxy.py.
"""
from __future__ import annotations

import base64
import io
import os
import sys
import traceback

import numpy as np
import torch
from PIL import Image
from flask import Flask, jsonify, request

CKPT_PATH = r"F:\SAM3\sam3-main\sam3.pt"
PORT = 8001

# ---- model setup (loaded once at import) ---------------------------------
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if device.type == "cuda":
    torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
    if torch.cuda.get_device_properties(0).major >= 8:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

print("Loading SAM3 model ...", flush=True)
from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor

model = build_sam3_image_model(
    checkpoint_path=CKPT_PATH,
    load_from_HF=False,
    enable_inst_interactivity=True,
    device=device.type,
)
processor = Sam3Processor(model, confidence_threshold=0.5, device=device.type)
print("SAM3 ready.", flush=True)

app = Flask(__name__)
_session: dict = {"state": None}


# ---- helpers --------------------------------------------------------------
def _mask_to_overlay_png(mask, color=(30, 144, 255, 160)):
    """Convert a mask (bool or float) to a base64-encoded RGBA PNG overlay."""
    mask_bool = np.asarray(mask, dtype=bool)
    h, w = mask_bool.shape[-2:]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[mask_bool] = color
    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---- routes ---------------------------------------------------------------
@app.route("/health")
def health():
    gpu_name = ""
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
    return jsonify({
        "ok": True,
        "online": True,
        "gpu": gpu_name,
        "device": device.type,
    })


@app.route("/set_image", methods=["POST"])
def set_image():
    p = (request.get_json(force=True, silent=True) or {}).get("image_path", "")
    if not p or not os.path.isfile(p):
        return jsonify({"ok": False, "error": f"image not found: {p}"}), 400
    try:
        image = Image.open(p).convert("RGB")
        _session["state"] = processor.set_image(image)
        return jsonify({"ok": True, "width": image.size[0], "height": image.size[1]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/predict", methods=["POST"])
def predict():
    if not _session["state"]:
        return jsonify({"ok": False, "error": "no image set"}), 400
    d = request.get_json(force=True, silent=True) or {}
    kwargs = {"multimask_output": bool(d.get("multimask", True))}
    pts = d.get("points")
    if pts:
        kwargs["point_coords"] = np.array(pts, dtype=np.float32)
        kwargs["point_labels"] = np.array(d.get("labels", []), dtype=np.int32)
    bx = d.get("box")
    if bx and len(bx) == 4:
        kwargs["box"] = np.array(bx, dtype=np.float32)
    try:
        masks, scores, _ = model.predict_inst(_session["state"], **kwargs)
        out = []
        for i in range(masks.shape[0]):
            out.append({
                "overlay": _mask_to_overlay_png(masks[i]),
                "score": float(scores[i]),
            })
        return jsonify({
            "ok": True,
            "masks": out,
            "best_index": int(np.argmax(scores)),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/ground", methods=["POST"])
def ground():
    if not _session["state"]:
        return jsonify({"ok": False, "error": "no image set"}), 400
    d = request.get_json(force=True, silent=True) or {}
    st = _session["state"]
    try:
        processor.reset_all_prompts(st)
        text = (d.get("text") or "").strip()
        if text:
            st = processor.set_text_prompt(text, st)
        for b in d.get("boxes", []):
            st = processor.add_geometric_prompt(
                [b["cx"], b["cy"], b["w"], b["h"]], bool(b["label"]), st
            )
        objs = []
        if "masks" in st and "scores" in st:
            for i in range(len(st["scores"])):
                m = st["masks"][i]
                if m.ndim == 3:
                    m = m[0]
                objs.append({
                    "overlay": _mask_to_overlay_png(m.cpu().numpy()),
                    "score": float(st["scores"][i]),
                    "box": st["boxes"][i].cpu().numpy().tolist(),
                })
        return jsonify({"ok": True, "objects": objs})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/reset", methods=["POST"])
def reset():
    if _session["state"]:
        processor.reset_all_prompts(_session["state"])
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=False)
