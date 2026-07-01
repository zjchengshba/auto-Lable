"""Dual-engine annotation logic.

For each image: run PPOCR-V6 and PPOCR-VL, normalize-compare the two outputs.
  * equal & non-empty  -> pre_annotated.jsonl  {"filename","text"}
  * otherwise           -> needs_review.jsonl   {"filename","text_v6","text_vl"}

When VL is disabled (debug), every result is dumped to v6_only.jsonl instead.
Output filenames are relative to input_dir with forward slashes, matching the
existing recog_labels.txt format so pre_annotated.jsonl doubles as a label file.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Optional

from .engines.base import OCREngine
from .text_utils import clean_text, normalize_for_compare

ProgressCb = Callable[[dict], None]

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".webp")


class DualEngineAnnotator:
    def __init__(
        self,
        v6: OCREngine,
        vl: Optional[OCREngine],
        input_dir: str,
        output_dir: str,
        limit: Optional[int] = None,
    ):
        self.v6 = v6
        self.vl = vl
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.limit = limit

    def run(self, progress_cb: Optional[ProgressCb] = None) -> dict:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        images = self._collect_images()
        if self.limit:
            images = images[: self.limit]
        total_count = len(images)

        pre_count = review_count = total = 0
        pre_path = self.output_dir / "pre_annotated.jsonl"
        review_path = self.output_dir / "needs_review.jsonl"
        v6only_path = self.output_dir / "v6_only.jsonl"

        # Truncate output files at start so re-runs don't append stale rows.
        for p in (pre_path, review_path, v6only_path):
            p.write_text("", encoding="utf-8")

        with open(pre_path, "a", encoding="utf-8") as f_pre, \
             open(review_path, "a", encoding="utf-8") as f_rev, \
             open(v6only_path, "a", encoding="utf-8") as f_v6:
            for idx, img_path in enumerate(images, 1):
                rel = img_path.relative_to(self.input_dir).as_posix()
                t6 = self._safe_recognize(self.v6, img_path)
                if self.vl is None:
                    row = {"filename": rel, "text_v6": t6}
                    f_v6.write(json.dumps(row, ensure_ascii=False) + "\n")
                    total += 1
                    print(f"[{idx}/{total_count}] (v6-only) {rel}: {t6!r}")
                    if progress_cb:
                        progress_cb({"idx": idx, "total": total_count, "rel": rel,
                                     "tag": "V6_ONLY", "text_v6": t6, "text_vl": None, "text": None})
                    continue

                tvl = self._safe_recognize(self.vl, img_path)
                total += 1
                if normalize_for_compare(t6) == normalize_for_compare(tvl) and normalize_for_compare(t6):
                    f_pre.write(
                        json.dumps({"filename": rel, "text": clean_text(t6)}, ensure_ascii=False) + "\n"
                    )
                    pre_count += 1
                    tag = "PRE"
                else:
                    f_rev.write(
                        json.dumps({"filename": rel, "text_v6": t6, "text_vl": tvl}, ensure_ascii=False) + "\n"
                    )
                    review_count += 1
                    tag = "REVIEW"
                print(f"[{idx}/{total_count}] {tag} {rel}: v6={t6!r} vl={tvl!r}")
                if progress_cb:
                    progress_cb({"idx": idx, "total": total_count, "rel": rel, "tag": tag,
                                 "text_v6": t6, "text_vl": tvl,
                                 "text": clean_text(t6) if tag == "PRE" else None})

        summary = {
            "total": total,
            "pre_annotated": pre_count,
            "needs_review": review_count,
            "v6_backend": self.v6.name,
            "vl_enabled": self.vl is not None,
            "input_dir": str(self.input_dir),
            "output_dir": str(self.output_dir),
        }
        (self.output_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("\n========== 汇总 ==========")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if progress_cb:
            progress_cb({"done": True, "summary": summary})
        return summary

    def _collect_images(self) -> list[Path]:
        results: list[Path] = []
        for root, _dirs, files in os.walk(self.input_dir):
            for name in files:
                if name.lower().endswith(_IMAGE_EXTS):
                    results.append(Path(root) / name)
        results.sort()
        return results

    @staticmethod
    def _safe_recognize(engine: OCREngine, img_path: Path) -> str:
        try:
            return engine.recognize(str(img_path))
        except Exception as e:
            print(f"  ! {engine.name} 识别失败 {img_path.name}: {e}")
            return ""
