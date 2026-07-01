"""Command-line entry for the dual-engine auto-annotator.

Examples:
  python run.py --input C:\\Users\\BTW\\Desktop\\20260328new --output out
  python run.py --input ...\\crops --output out --v6-backend rapidocr --limit 20
  python run.py --input ...\\crops --output out --no-vl          # debug: V6 only
"""
from __future__ import annotations

import argparse
import sys

from .config import Config
from .engines.ppocr_v6 import make_v6_backend
from .engines.ppocr_vl import PaddleOCRVLBackend
from .annotator import DualEngineAnnotator


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PPOCR-V6 + PPOCR-VL dual-engine auto-annotator")
    p.add_argument("--input", required=True, help="图片目录（递归遍历）。filename 相对该目录")
    p.add_argument("--output", required=True, help="输出目录（生成 pre_annotated/needs_review/summary）")
    p.add_argument("--v6-backend", choices=["paddleocr", "rapidocr"], default="paddleocr",
                   help="PPOCR-V6 后端（默认 paddleocr）")
    p.add_argument("--no-vl", action="store_true", help="仅跑 V6（调试，输出 v6_only.jsonl）")
    p.add_argument("--limit", type=int, default=None, help="只处理前 N 张图片")
    p.add_argument("--cpu", action="store_true", help="强制 CPU（默认用 GPU）")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    cfg = Config(v6_backend=args.v6_backend, use_gpu=not args.cpu)

    print(f"[init] PPOCR-V6 backend = {cfg.v6_backend}")
    v6 = make_v6_backend(cfg)
    v6.init()

    vl = None
    if not args.no_vl:
        print("[init] PPOCR-VL (llama-cpp-python, GPU offload)")
        vl = PaddleOCRVLBackend(cfg)
        vl.init()

    annotator = DualEngineAnnotator(
        v6=v6, vl=vl, input_dir=args.input, output_dir=args.output, limit=args.limit
    )
    annotator.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
