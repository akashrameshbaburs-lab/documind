"""OpenAI-compatible local inference sidecar (embeddings + chat).

Endpoints mirror the two OpenAI shapes that matter for RAG pipelines, so any
OpenAI SDK consumer can point at this service by only changing `base_url`:

  POST /v1/embeddings         -> {data:[{embedding,index}], model, usage}
  POST /v1/chat/completions   -> {choices:[{message:{content}}], usage}

Plus operational endpoints:
  GET  /healthz               -> liveness (no model needed)
  GET  /healthz/ready         -> 200 only once models are loaded
  GET  /v1/info               -> device, VRAM, model ids, timings
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import List, Union

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.models import (
    DEVICE,
    EMBED_MODEL_ID,
    LLM_MODEL_ID,
    MAX_NEW_TOKENS_DEFAULT,
    manager,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("inference")

app = FastAPI(title="gpu-inference", version="1.0.0")

startup_started = time.perf_counter()


class EmbeddingsRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = EMBED_MODEL_ID


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    model: str = LLM_MODEL_ID
    max_tokens: int = Field(default=256, ge=1)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


@app.on_event("startup")
async def load_models_background() -> None:
    # Load asynchronously so /healthz answers immediately (model download can
    # take minutes on first boot).
    asyncio.get_event_loop().run_in_executor(None, manager.load)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/healthz/ready")
def ready() -> dict:
    if manager.ready:
        return {"status": "ready", "device": DEVICE}
    if manager.error:
        raise HTTPException(
            status_code=503, detail={"status": "failed", "error": manager.error}
        )
    raise HTTPException(status_code=503, detail={"status": "loading"})


@app.get("/v1/info")
def info() -> dict:
    gpu_name = None
    vram_mb = None
    if DEVICE == "cuda":
        props = torch.cuda.get_device_properties(0)
        gpu_name = props.name
        vram_mb = round(props.total_memory / 1024 / 1024)
    return {
        "device": DEVICE,
        "gpu": gpu_name,
        "vram_mb": vram_mb,
        "torch": torch.__version__,
        "models": {
            "embeddings": EMBED_MODEL_ID,
            "chat": LLM_MODEL_ID,
        },
        "ready": manager.ready,
        "model_load_seconds": manager.load_seconds,
        "service_uptime_seconds": round(time.perf_counter() - startup_started, 1),
        "max_new_tokens_default": MAX_NEW_TOKENS_DEFAULT,
    }


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingsRequest) -> dict:
    texts = [req.input] if isinstance(req.input, str) else req.input
    if not texts or not all(isinstance(t, str) and t.strip() for t in texts):
        raise HTTPException(status_code=400, detail="input must be a non-empty string or list of strings")

    started = time.perf_counter()
    try:
        vectors = manager.embed(texts)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    latency_ms = (time.perf_counter() - started) * 1000

    return {
        "object": "list",
        "model": req.model,
        "data": [
            {"object": "embedding", "index": i, "embedding": vec}
            for i, vec in enumerate(vectors)
        ],
        "usage": {
            "prompt_tokens": sum(len(t.split()) for t in texts),
            "total_tokens": sum(len(t.split()) for t in texts),
        },
        # non-OpenAI extension fields (harmless to SDK consumers)
        "latency_ms": round(latency_ms, 1),
        "device": DEVICE,
    }


@app.post("/v1/chat/completions")
def chat_completions(req: ChatRequest) -> dict:
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        result = manager.chat(messages, req.max_tokens, req.temperature)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "id": f"chatcmpl-local-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result["content"]},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": result["prompt_tokens"],
            "completion_tokens": result["completion_tokens"],
            "total_tokens": result["prompt_tokens"] + result["completion_tokens"],
        },
        # non-OpenAI extension fields
        "latency_ms": result["latency_ms"],
        "tokens_per_second": result["tokens_per_second"],
        "device": DEVICE,
    }
