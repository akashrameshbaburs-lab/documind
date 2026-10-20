"""Model loading and inference for the local GPU inference sidecar.

Two models are served behind one lock-protected manager:
  - embeddings : sentence-transformers/all-MiniLM-L6-v2 (384-dim, ~90 MB)
  - chat       : Qwen/Qwen2.5-1.5B-Instruct (fp16 on CUDA, fp32 on CPU)

Both use plain HuggingFace transformers; no framework lock-in, and the
service degrades to CPU automatically when CUDA is unavailable.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import List

import torch

log = logging.getLogger("inference.models")

EMBED_MODEL_ID = os.getenv("EMBED_MODEL_ID", "sentence-transformers/all-MiniLM-L6-v2")
LLM_MODEL_ID = os.getenv("LLM_MODEL_ID", "Qwen/Qwen2.5-1.5B-Instruct")
MAX_NEW_TOKENS_DEFAULT = int(os.getenv("MAX_NEW_TOKENS", "256"))


def pick_device() -> str:
    requested = os.getenv("DEVICE", "auto").lower()
    if requested == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


DEVICE = pick_device()
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


class ModelManager:
    """Lazy-loads both models once, thread-safe around generation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ready = False
        self._error: str | None = None
        self._load_seconds: float | None = None
        self.embedder = None
        self.tokenizer = None
        self.llm = None

    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def load_seconds(self) -> float | None:
        return self._load_seconds

    def load(self) -> None:
        started = time.perf_counter()
        try:
            from sentence_transformers import SentenceTransformer
            from transformers import AutoModelForCausalLM, AutoTokenizer

            log.info("loading embedding model %s on %s", EMBED_MODEL_ID, DEVICE)
            self.embedder = SentenceTransformer(EMBED_MODEL_ID, device=DEVICE)

            log.info("loading chat model %s (%s) on %s", LLM_MODEL_ID, DTYPE, DEVICE)
            self.tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID)
            self.llm = AutoModelForCausalLM.from_pretrained(
                LLM_MODEL_ID,
                torch_dtype=DTYPE,
                device_map=DEVICE if DEVICE == "cuda" else None,
            )
            self.llm.eval()

            self._load_seconds = round(time.perf_counter() - started, 2)
            self._ready = True
            log.info("models ready in %.2fs", self._load_seconds)
        except Exception as exc:  # surfaced via /healthz/ready
            self._error = f"{type(exc).__name__}: {exc}"
            log.exception("model loading failed")

    def embed(self, texts: List[str]) -> List[List[float]]:
        if not self._ready:
            raise RuntimeError(self._error or "models not loaded yet")
        with self._lock:
            vectors = self.embedder.encode(
                texts,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
        return vectors.tolist()

    def chat(
        self,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
    ) -> dict:
        """Single-turn HF generation; returns content + token accounting."""
        if not self._ready:
            raise RuntimeError(self._error or "models not loaded yet")
        max_tokens = max(1, min(max_tokens, MAX_NEW_TOKENS_DEFAULT * 4))

        with self._lock:
            prompt = self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            inputs = self.tokenizer(prompt, return_tensors="pt").to(self.llm.device)
            prompt_len = inputs["input_ids"].shape[1]

            gen_kwargs = {
                "max_new_tokens": max_tokens,
                "do_sample": temperature > 0,
                "pad_token_id": self.tokenizer.eos_token_id,
            }
            if temperature > 0:
                gen_kwargs["temperature"] = temperature
                gen_kwargs["top_p"] = 0.95

            started = time.perf_counter()
            with torch.inference_mode():
                output = self.llm.generate(**inputs, **gen_kwargs)
            latency_ms = (time.perf_counter() - started) * 1000

        completion_ids = output[0][prompt_len:]
        content = self.tokenizer.decode(completion_ids, skip_special_tokens=True)
        completion_tokens = int(completion_ids.shape[0])
        return {
            "content": content,
            "prompt_tokens": prompt_len,
            "completion_tokens": completion_tokens,
            "latency_ms": round(latency_ms, 1),
            "tokens_per_second": round(
                completion_tokens / (latency_ms / 1000), 2
            )
            if latency_ms > 0
            else 0.0,
        }


manager = ModelManager()
