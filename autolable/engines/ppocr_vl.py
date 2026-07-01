"""PPOCR-VL multimodal recognition backend (llama-cpp-python).

Reuses the existing GGUF model + mmproj projector that the C# LLamaSharp build
used (D:\\C#code\\ConsoleApp1\\ConsoleApp1\\Program.cs):
  model   = F:\\OCRprojrct\\Models\\PaddleOCR-VL-1.5-GGUF.gguf
  mmproj  = F:\\OCRprojrct\\Models\\PaddleOCR-VL-1.5-GGUF-mmproj.gguf
  prompt  = "<|begin_of_sentence|>User: <image>OCR:Assistant:\\n"
  temp=0, max_tokens=1024, stop="</s>", gpu_layers=32

Image handling: llama-cpp-python's MTMDChatHandler (mtmd) loads the mmproj
clip and injects the <image> embed into the model's chat template. Passing
chat_handler is mandatory -- without it the Llama class silently drops image
content and the model hallucinates.

Prompt template: the primary path relies on the PaddleOCR-VL GGUF's baked-in
chat template (produces the "User: <image>OCR:Assistant:" form). If a future
GGUF lacks the right template, flip MANUAL_PROMPT_PATH on to bypass templating
and feed the exact C# prompt string with the image embed injected by the
handler's load_image().
"""
from __future__ import annotations

import base64
import mimetypes

from .base import OCREngine

# Toggle to force the exact C# prompt instead of the model's chat template.
MANUAL_PROMPT_PATH = False
_STOP_TOKEN = "</s>"
_OCR_PROMPT = "<|begin_of_sentence|>User: <image>OCR:Assistant:\n"


def _image_data_url(image_path: str) -> str:
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    mime = mimetypes.guess_type(image_path)[0] or "image/png"
    return f"data:{mime};base64,{b64}"


class PaddleOCRVLBackend(OCREngine):
    name = "ppocr_vl"

    def __init__(self, cfg):
        self.cfg = cfg
        self._llm = None
        self._handler = None

    def init(self) -> None:
        from llama_cpp import Llama
        from llama_cpp.llama_chat_format import MTMDChatHandler

        self._handler = MTMDChatHandler(
            clip_model_path=self.cfg.vl_mmproj,
            verbose=False,
            use_gpu=self.cfg.use_gpu,
        )
        self._llm = Llama(
            model_path=self.cfg.vl_gguf,
            chat_handler=self._handler,
            n_gpu_layers=self.cfg.n_gpu_layers,
            n_ctx=self.cfg.n_ctx,
            verbose=False,
        )

    def recognize(self, image_path: str) -> str:
        if MANUAL_PROMPT_PATH:
            return self._recognize_manual(image_path)
        return self._recognize_chat(image_path)

    # ---- primary: model chat template (image via MTMDChatHandler) -----------
    def _recognize_chat(self, image_path: str) -> str:
        url = _image_data_url(image_path)
        resp = self._llm.create_chat_completion(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": url}},
                        {"type": "text", "text": "OCR"},
                    ],
                }
            ],
            max_tokens=self.cfg.max_tokens,
            temperature=self.cfg.temperature,
            stop=[_STOP_TOKEN],
        )
        return (resp["choices"][0]["message"]["content"] or "").strip()

    # ---- fallback: exact C# prompt with handler-injected image embed --------
    def _recognize_manual(self, image_path: str) -> str:
        url = _image_data_url(image_path)
        # load_image returns the embed(s) the handler would substitute for <image>.
        embeds = self._handler.load_image(url)
        resp = self._llm.create_completion(
            prompt=_OCR_PROMPT,
            embedding=embeds,
            max_tokens=self.cfg.max_tokens,
            temperature=self.cfg.temperature,
            stop=[_STOP_TOKEN],
        )
        return (resp["choices"][0]["text"] or "").strip()
