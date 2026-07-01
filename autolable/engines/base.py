"""OCR engine abstract base.

Both PPOCR-V6 (either backend) and PPOCR-VL implement this contract so the
annotator can drive them uniformly. Engines are initialized once and reused
across all images (mirrors the C# global _ocrEngine cache).
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class OCREngine(ABC):
    name: str = "base"

    @abstractmethod
    def init(self) -> None:
        """Load model weights. Called once before any recognize() call."""

    @abstractmethod
    def recognize(self, image_path: str) -> str:
        """Recognize text in a single image. Returns concatenated plain text."""
