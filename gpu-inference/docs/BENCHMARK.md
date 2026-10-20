# GPU sidecar benchmark — measured run

Numbers below are the verbatim output of `scripts/bench.py` against the running
sidecar (profile `gpu`, host port **8100**). Nothing is rounded, estimated or
hand-edited.

## Environment

| | |
|---|---|
| Date | 2026-10-20 |
| GPU | NVIDIA GeForce RTX 3070 Laptop GPU, 8192 MB VRAM |
| Torch | 2.5.1+cu124 (image `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`) |
| Embeddings model | `sentence-transformers/all-MiniLM-L6-v2` (384-dim) |
| Chat model | `Qwen/Qwen2.5-1.5B-Instruct` (bf16 on CUDA) |
| Model load time | 10.23 s (from the pinned `hf_models` volume, no re-download) |
| Concurrency | 1 — the service holds a single inference lock by design |

## How to reproduce

```powershell
# from documind/gpu-inference, sidecar running on :8100
py scripts\bench.py --url http://localhost:8100
# or, without a local Python:
docker exec documind-gpu python scripts/bench.py --url http://127.0.0.1:8000
```

The script is stdlib-only (`urllib`, `json`, `statistics`, `time`) and posts
8 fixed texts (32 single embeddings + 4 batches of 32) and 3 fixed prompts
(`max_tokens: 96`).

## Raw output

```json
=== device ===
{
  "device": "cuda",
  "gpu": "NVIDIA GeForce RTX 3070 Laptop GPU",
  "vram_mb": 8192,
  "torch": "2.5.1+cu124",
  "models": {
    "embeddings": "sentence-transformers/all-MiniLM-L6-v2",
    "chat": "Qwen/Qwen2.5-1.5B-Instruct"
  },
  "ready": true,
  "model_load_seconds": 10.23,
  "service_uptime_seconds": 277.3,
  "max_new_tokens_default": 256
}

=== embeddings ===
{
  "single_chunk_ms": {
    "mean": 23.0,
    "p95": 12.8
  },
  "batch_32_chunks_ms": {
    "mean": 39.1,
    "chunks_per_sec": 818.4
  },
  "vector_dims": 384
}

=== chat ===
[
  {
    "prompt": "Answer in one sentence: What is database indexing and why does it speed up reads?",
    "latency_ms": 1838.1,
    "completion_tokens": 22,
    "tokens_per_second": 11.97,
    "answer": "Database indexing speeds up read operations by allowing the database to quickly locate specific data without scanning through all records."
  },
  {
    "prompt": "Answer in one sentence: Why does caching reduce backend load?",
    "latency_ms": 837.5,
    "completion_tokens": 31,
    "tokens_per_second": 37.01,
    "answer": "Caching reduces backend load by storing frequently accessed data locally, minimizing the need to retrieve it from the server and thus reduci"
  },
  {
    "prompt": "Summarize in one sentence how a reverse proxy improves scalability.",
    "latency_ms": 834.3,
    "completion_tokens": 32,
    "tokens_per_second": 38.35,
    "answer": "A reverse proxy improves scalability by distributing incoming network traffic across multiple servers, allowing for efficient load balancing"
  }
]

mean chat throughput: 29.11 tokens/sec (batch=1)
```

## Reading these numbers honestly

- **Embeddings (single):** the first request pays one-time CUDA kernel
  warm-up, which is why the *mean* (23.0 ms) sits above the *p95* (12.8 ms) —
  after warm-up a single chunk embeds in ~10–13 ms.
- **Embeddings (batch of 32):** 39.1 ms → **818 chunks/s**. Ingest is not the
  bottleneck; DocuMind's whole eval corpus embeds in well under a second.
- **Chat:** first token-heavy prompt includes prompt-processing cost
  (1838 ms / 11.97 tok/s); steady-state generation runs ~835 ms for ~30 tokens
  (**37–38 tok/s**). Mean 29.11 tok/s across the three prompts at batch=1.
- **End-to-end impact:** DocuMind's `answerMode: "gpu"` adds one chat call per
  *uncached* question (~0.8–1.9 s here); repeat questions are served from
  `answer_cache` in single-digit milliseconds regardless of mode.
- **Not measured here:** streaming (not implemented) and concurrent load
  (serialized by the single inference lock — see the README limits).
