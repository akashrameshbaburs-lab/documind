"""Benchmark the inference sidecar and print reproducible numbers.

Usage (from repo root, service running on :8100):
  python scripts/bench.py                       # GPU instance
  python scripts/bench.py --url http://localhost:8101   # CPU instance

Measures, with the values actually observed:
  - embeddings: mean/p95 per-chunk latency, chunks/sec (single + batched)
  - chat: total latency, output tokens, tokens/sec across N prompts
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request

TEXTS = [
    "The Eiffel Tower was completed in 1889 as the entrance arch for the World's Fair in Paris.",
    "PostgreSQL supports partial indexes, which let you index a subset of rows with a WHERE clause.",
    "Isolation Forest isolates observations by randomly selecting a feature and split value.",
    "The Amazon rain forest produces roughly 6 percent of the world's oxygen output.",
    "Redis pub/sub delivers messages to subscribers in at-most-once fashion with no persistence.",
    "Mitochondria convert nutrients into ATP through oxidative phosphorylation.",
    "The Rust borrow checker enforces memory safety without a garbage collector.",
    "Coral reefs support about 25 percent of all marine species despite covering under 1 percent of the ocean floor.",
]

PROMPTS = [
    "Answer in one sentence: What is database indexing and why does it speed up reads?",
    "Answer in one sentence: Why does caching reduce backend load?",
    "Summarize in one sentence how a reverse proxy improves scalability.",
]


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as resp:
        body = json.loads(resp.read())
    total_ms = (time.perf_counter() - started) * 1000
    body["_roundtrip_ms"] = round(total_ms, 1)
    return body


def bench_embeddings(base: str) -> dict:
    # single-chunk latency x 32
    singles = []
    for i in range(32):
        r = post(f"{base}/v1/embeddings", {"input": TEXTS[i % len(TEXTS)]})
        singles.append(r["latency_ms"])

    # batched throughput x 4 batches of 32
    batch_texts = TEXTS * 4
    batches = []
    for _ in range(4):
        r = post(f"{base}/v1/embeddings", {"input": batch_texts})
        batches.append(r["latency_ms"])

    return {
        "single_chunk_ms": {
            "mean": round(statistics.mean(singles), 1),
            "p95": round(sorted(singles)[int(len(singles) * 0.95) - 1], 1),
        },
        "batch_32_chunks_ms": {
            "mean": round(statistics.mean(batches), 1),
            "chunks_per_sec": round(32 / (statistics.mean(batches) / 1000), 1),
        },
        "vector_dims": len(r["data"][0]["embedding"]),
    }


def bench_chat(base: str) -> list:
    results = []
    for p in PROMPTS:
        r = post(
            f"{base}/v1/chat/completions",
            {"messages": [{"role": "user", "content": p}], "max_tokens": 96},
        )
        results.append(
            {
                "prompt": p,
                "latency_ms": r["latency_ms"],
                "completion_tokens": r["usage"]["completion_tokens"],
                "tokens_per_second": r["tokens_per_second"],
                "answer": r["choices"][0]["message"]["content"][:140],
            }
        )
    return results


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8100")
    args = ap.parse_args()

    info = json.loads(urllib.request.urlopen(f"{args.url}/v1/info", timeout=10).read())
    print("=== device ===")
    print(json.dumps(info, indent=2))

    print("\n=== embeddings ===")
    emb = bench_embeddings(args.url)
    print(json.dumps(emb, indent=2))

    print("\n=== chat ===")
    chat = bench_chat(args.url)
    print(json.dumps(chat, indent=2))

    mean_tps = statistics.mean(c["tokens_per_second"] for c in chat)
    print(f"\nmean chat throughput: {mean_tps:.2f} tokens/sec (batch=1)")


if __name__ == "__main__":
    main()
