# gpu-inference — Local GPU Inference Sidecar

**OpenAI-compatible embeddings + chat completions served from your own RTX 3070** — a self-hosted alternative to paid LLM APIs for RAG pipelines. Any OpenAI SDK consumer points at it by changing `base_url`; nothing else in the calling code changes.

| | |
|---|---|
| **Embeddings** | `sentence-transformers/all-MiniLM-L6-v2` (384-dim, ~90 MB) |
| **Chat** | `Qwen/Qwen2.5-1.5B-Instruct` (fp16 on CUDA) |
| **Runtime** | PyTorch 2.5 (CUDA 12.4) in Docker, nvidia container runtime |
| **Fallback** | Automatic CPU mode (`DEVICE=cpu` or no GPU visible) |

## Quick start

```powershell
docker compose up -d --build     # first boot downloads models into the hf_models volume
# verify:
Invoke-RestMethod http://localhost:8100/v1/info
# benchmark (stdlib-only script):
py scripts\bench.py --url http://localhost:8100
```

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/embeddings` | OpenAI-shaped: `{input: string \| string[], model?}` → `{data:[{embedding,index}], usage, latency_ms}` |
| `POST` | `/v1/chat/completions` | OpenAI-shaped: `{messages, max_tokens?, temperature?}` → `{choices[0].message.content, usage, tokens_per_second}` |
| `GET` | `/v1/info` | Device, GPU name, VRAM, torch version, model ids, load time |
| `GET` | `/healthz` / `/healthz/ready` | Liveness; readiness (models fully loaded) |

Example:

```powershell
Invoke-RestMethod -Post -ContentType application/json `
  -Body '{"messages":[{"role":"user","content":"Explain CAP theorem in one sentence."}]}' `
  http://localhost:8100/v1/chat/completions | Select-Object -Expand choices | Select-Object -ExpandProperty message
```

Non-OpenAI extension fields (`latency_ms`, `tokens_per_second`, `device`) ride along in responses; standard SDK clients ignore them.

## Architecture

```
any RAG app ── OpenAI SDK (base_url=http://localhost:8100/v1) ──┐
                                                               ▼
                                              ┌── fastapi app (uvicorn) ──┐
   POST /v1/embeddings  ──────────────────────►  MiniLM (SentenceTransformer)
   POST /v1/chat/completions ─────────────────►  Qwen2.5-1.5B-Instruct (fp16)
                                              └── single lock: VRAM-safe ──┘
                                                        │ CUDA 12.4
                                                  RTX 3070 (8 GB)
```

- **Model loading is asynchronous** — `/healthz` answers during the multi-minute first-boot download; `/healthz/ready` flips to 200 when models are in VRAM.
- **Models persist in the `hf_models` volume**, so restarts are instant and rebuilds never re-download.
- **One inference lock** serializes generation (a single 8 GB card; concurrent batches would just OOM-thrash) — throughput is tuned for a single-app RPA/RAG workload, not multi-tenant serving.
- **CPU fallback** is a compose profile: `docker compose --profile cpu up inference-cpu` on port 8101, same API, no code change.

## Why this exists (and its honest limits)

Local inference removes the per-query cost of hosted LLM APIs and keeps documents on-machine. The limits, stated plainly:

1. **1.5B parameters** — answers are good for summarization/extraction-grade RAG, not frontier reasoning. Swap `LLM_MODEL_ID` for a larger model if you have VRAM (Qwen2.5-7B-Instruct at fp16 ≈ 15 GB — too big for this 8 GB card; use a 4-bit GGUF/AWQ variant).
2. **Serial batching** — one request at a time by design; queue upstream if you need concurrency.
3. **No streaming** — plain request/response (`stream: true` is not implemented).
4. Downloads happen from the Hugging Face Hub on first boot (needs internet once).

## Roadmap

- OpenAI-style streaming (`text/event-stream`)
- Dynamic batching for parallel requests when VRAM headroom allows
- vLLM backend option for higher throughput
- Automatic quantization (AWQ/GPTQ) support for 7B-class models on the same card

## Benchmark

Measured on this machine with `scripts/bench.py` (RTX 3070 Laptop 8 GB, driver 610.78). See [docs/BENCHMARK.md](docs/BENCHMARK.md) for the full run output and methodology.

## License

MIT
