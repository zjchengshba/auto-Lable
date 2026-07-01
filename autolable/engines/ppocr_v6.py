"""PPOCR-V6 recognition backends.

Two interchangeable backends behind the OCREngine contract:
  * PaddleOCRBackend  -> official paddleocr (TextRecognition rec-only pipeline)
  * RapidOCRBackend   -> rapidocr on onnxruntime (rec-only)

Both run in rec-only mode: an input crop is treated as a single text line,
matching the C# PaddleOCRSharp setup (det=False, cls=False, rec=True) in
D:\\C#code\\ConsoleApp2\\ConsoleApp2\\Program.cs.

The paddleocr / rapidocr public APIs differ across major versions and are not
pinned here, so each backend tolerates the known API shapes and picks whichever
constructor / result shape works at runtime.
"""
from __future__ import annotations

from .base import OCREngine


def _join_texts(texts) -> str:
    return "".join(t for t in (texts or []) if t)


def _extract_rec_texts(obj) -> list[str]:
    """Pull recognized strings out of a paddleocr rec result.

    paddleocr 3.7 rec-only returns dict-like rows with key 'rec_text' (single str);
    earlier 3.x builds exposed 'rec_texts' (list[str]) / a .rec_texts attribute.
    Handle all shapes.
    """
    out: list[str] = []
    for res in (obj or []):
        getter = getattr(res, "get", None)  # dict-like
        if callable(getter):
            t = getter("rec_texts")
            if t:
                out.extend(t)
            else:
                single = getter("rec_text")
                if single:
                    out.append(single)
            continue
        t = getattr(res, "rec_texts", None)
        if t:
            out.extend(t)
        else:
            single = getattr(res, "rec_text", None)
            if single:
                out.append(single)
    return out


class PaddleOCRBackend(OCREngine):
    name = "ppocr_v6_paddleocr"

    def __init__(self, cfg):
        self.cfg = cfg
        self._engine = None

    def init(self) -> None:
        # paddleocr 3.7 rec-only pipeline. Load from local model_dir so the
        # package is fully self-contained and distributable.
        from paddleocr import TextRecognition

        model_dir = getattr(self.cfg, "v6_rec_model_dir", None)
        if model_dir:
            self._engine = TextRecognition(
                model_name="PP-OCRv6_small_rec",
                model_dir=model_dir,
            )
        else:
            self._engine = TextRecognition(model_name="PP-OCRv6_small_rec")

    def recognize(self, image_path: str) -> str:
        out = self._engine.predict(input=image_path)
        return _join_texts(_extract_rec_texts(out))


class RapidOCRBackend(OCREngine):
    name = "ppocr_v6_rapidocr"

    def __init__(self, cfg):
        self.cfg = cfg
        self._engine = None

    def init(self) -> None:
        from rapidocr import RapidOCR

        # rapidocr 3.x: enable CUDA EP via params when GPU requested. det/cls are
        # turned off per-call in recognize() rather than at construction time.
        params = None
        if self.cfg.use_gpu:
            params = {"EngineConfig.onnxruntime.use_cuda": True}
        try:
            self._engine = RapidOCR(params=params)
        except Exception:
            # GPU EP init can fail (missing CUDA libs); fall back to CPU.
            self._engine = RapidOCR()

    def recognize(self, image_path: str) -> str:
        # use_det/use_cls/use_rec are first-class call kwargs in rapidocr 3.x and
        # are also accepted by older 2.x builds, so this is version-robust.
        out = self._engine(image_path, use_det=False, use_cls=False, use_rec=True)
        txts = getattr(out, "txts", None)
        if not txts:
            # rapidocr 1.x returns (result_list, elapse); result rows are [box, text, score]
            try:
                result, _elapse = out
                txts = [row[1] for row in (result or []) if row and len(row) > 1]
            except Exception:
                txts = []
        return _join_texts(list(txts) if txts else [])


def make_v6_backend(cfg) -> OCREngine:
    """Factory: return the PPOCR-V6 backend selected by cfg.v6_backend."""
    if cfg.v6_backend == "rapidocr":
        return RapidOCRBackend(cfg)
    return PaddleOCRBackend(cfg)
