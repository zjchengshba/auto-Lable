"""Default configuration: model paths and runtime parameters.

Paths are relative to the project root so the package is fully self-contained
and distributable. Override via Config fields from CLI.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
_MODELS_DIR = os.path.join(_PROJECT_ROOT, "models")

# PPOCR-V6 recognition model (Paddle inference format, rec-only)
V6_REC_MODEL_DIR = os.path.join(_MODELS_DIR, "ppocr-v6-rec")

# PPOCR-VL GGUF model + multimodal projector (llama.cpp format)
VL_GGUF = os.path.join(_MODELS_DIR, "ppocr-vl", "PaddleOCR-VL-1.5-GGUF.gguf")
VL_MMPROJ = os.path.join(_MODELS_DIR, "ppocr-vl", "PaddleOCR-VL-1.5-GGUF-mmproj.gguf")


@dataclass
class Config:
    # PPOCR-V6 backend selector: "paddleocr" | "rapidocr"
    v6_backend: str = "paddleocr"

    # V6 rec model dir (Paddle inference format) – used by paddleocr backend.
    v6_rec_model_dir: str = V6_REC_MODEL_DIR

    # PPOCR-VL
    vl_gguf: str = VL_GGUF
    vl_mmproj: str = VL_MMPROJ
    n_gpu_layers: int = 32  # matches C# GpuLayerCount = 32
    n_ctx: int = 4096
    max_tokens: int = 1024  # matches C# MaxTokens
    temperature: float = 0.0  # matches C# Temperature = 0f

    use_gpu: bool = True
