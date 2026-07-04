"""Thin proxy client: Flask -> LocateAnything service (:x002)."""
from __future__ import annotations

import requests

LA_URL = "http://127.0.0.1:8002"


class LaClient:
    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def status(self):
        try:
            r = requests.get(f"{LA_URL}/health", timeout=1.0)
            return r.json() if r.ok else {"online": False}
        except Exception:
            return {"online": False}

    def _post(self, path, body):
        r = requests.post(f"{LA_URL}{path}", json=body, timeout=300)
        return r.json(), r.status_code

    def detect(self, image_path, categories):
        return self._post("/detect", {"image_path": image_path, "categories": categories})

    def ground(self, image_path, phrase, mode="multi"):
        return self._post("/ground", {"image_path": image_path, "phrase": phrase, "mode": mode})

    def detect_text(self, image_path):
        return self._post("/detect_text", {"image_path": image_path})

    def point(self, image_path, phrase):
        return self._post("/point", {"image_path": image_path, "phrase": phrase})
