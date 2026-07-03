"""Thin proxy client: Flask → SAM3 service (:8001)."""
from __future__ import annotations

import requests

SAM3_URL = "http://127.0.0.1:8001"


class Sam3Client:
    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def status(self):
        try:
            r = requests.get(f"{SAM3_URL}/health", timeout=1.0)
            return r.json() if r.ok else {"online": False}
        except Exception:
            return {"online": False}

    def _post(self, path, body):
        r = requests.post(f"{SAM3_URL}{path}", json=body, timeout=120)
        return r.json(), r.status_code

    def set_image(self, path):
        return self._post("/set_image", {"image_path": path})

    def predict(self, body):
        return self._post("/predict", body)

    def ground(self, body):
        return self._post("/ground", body)

    def reset(self):
        return self._post("/reset", {})
