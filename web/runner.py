"""Background job runner.

Wraps DualEngineAnnotator in a worker thread and exposes a live progress state
that the Flask layer polls. Single job at a time (singleton).
"""
from __future__ import annotations

import threading
from typing import Optional

from autolable.annotator import DualEngineAnnotator
from autolable.config import Config
from autolable.engines.ppocr_v6 import make_v6_backend
from autolable.engines.ppocr_vl import PaddleOCRVLBackend


class JobRunner:
    _instance: Optional["JobRunner"] = None

    @classmethod
    def instance(cls) -> "JobRunner":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._reset_state()

    def _reset_state(self) -> None:
        self._state: dict = {
            "status": "idle",        # idle | running | done | error
            "message": "",
            "total": 0,
            "done": 0,
            "current": "",
            "pre_count": 0,
            "review_count": 0,
            "recent": [],            # last 50 progress packets
            "summary": {},
            "input_dir": "",
            "output_dir": "",
            "v6_backend": "",
            "vl_enabled": True,
        }

    def progress(self) -> dict:
        with self._lock:
            snap = dict(self._state)
            snap["recent"] = list(self._state["recent"])
            return snap

    def is_running(self) -> bool:
        with self._lock:
            return self._state["status"] == "running"

    def start(
        self,
        input_dir: str,
        output_dir: str,
        v6_backend: str = "paddleocr",
        no_vl: bool = False,
        limit: Optional[int] = None,
        use_gpu: bool = True,
    ) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                return {"ok": False, "error": "已有任务正在运行，请等待完成"}
            self._reset_state()
            self._state["status"] = "running"
            self._state["message"] = "正在初始化引擎（首次加载模型较慢）..."
            self._state["input_dir"] = input_dir
            self._state["output_dir"] = output_dir
            self._state["v6_backend"] = v6_backend
            self._state["vl_enabled"] = not no_vl

        self._thread = threading.Thread(
            target=self._run,
            args=(input_dir, output_dir, v6_backend, no_vl, limit, use_gpu),
            daemon=True,
        )
        self._thread.start()
        return {"ok": True}

    def _run(
        self,
        input_dir: str,
        output_dir: str,
        v6_backend: str,
        no_vl: bool,
        limit: Optional[int],
        use_gpu: bool,
    ) -> None:
        try:
            cfg = Config(v6_backend=v6_backend, use_gpu=use_gpu)
            v6 = make_v6_backend(cfg)
            v6.init()
            vl = None
            if not no_vl:
                vl = PaddleOCRVLBackend(cfg)
                vl.init()

            with self._lock:
                self._state["message"] = "引擎就绪，开始识别..."

            ann = DualEngineAnnotator(
                v6=v6, vl=vl, input_dir=input_dir, output_dir=output_dir, limit=limit
            )
            ann.run(progress_cb=self._on_progress)

            with self._lock:
                if self._state["status"] == "running":
                    self._state["status"] = "done"
                    self._state["message"] = "完成"
                    self._state["current"] = ""
        except Exception as e:
            with self._lock:
                self._state["status"] = "error"
                self._state["message"] = f"{type(e).__name__}: {e}"

    def _on_progress(self, pkt: dict) -> None:
        with self._lock:
            if pkt.get("done"):
                self._state["summary"] = pkt.get("summary", {})
                self._state["status"] = "done"
                self._state["message"] = "完成"
                self._state["current"] = ""
                return
            self._state["done"] = pkt.get("idx", self._state["done"])
            self._state["total"] = pkt.get("total", self._state["total"])
            self._state["current"] = pkt.get("rel", "")
            tag = pkt.get("tag")
            if tag == "PRE":
                self._state["pre_count"] += 1
            elif tag == "REVIEW":
                self._state["review_count"] += 1
            self._state["recent"].append(pkt)
            if len(self._state["recent"]) > 50:
                self._state["recent"] = self._state["recent"][-50:]
