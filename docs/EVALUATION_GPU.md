# Evaluation Results — DocuMind AI

> **These numbers were produced by running `npm run evaluate` against the live
> service.** No values are estimated or hand-written. Reproduce with the commands
> in the section *How to reproduce*.

| Field | Value |
| --- | --- |
| Run timestamp (UTC) | 2026-10-20T07:34:27.504Z |
| Answer mode | `gpu` |
| Embedding provider | `gpu` |
| Retrieval | hybrid: pgvector cosine + Postgres `ts_rank`, reciprocal-rank fusion (k=60) |
| Questions | 50 of 50 (0 failed to run) |
| Document set | world-facts.pdf (6p, 12 chunks), field-notes.md (1p, 3 chunks) |

## Headline metrics

| Metric | Result |
| --- | --- |
| **Retrieval Hit@3** (expected file among top-3 citations) | **100.0%** (50/50) |
| **Page accuracy** (expected file **and** page cited) | **100.0%** (50/50) |
| **Answer Hit@3** (top-3 citation points at the gold source+page) | **100.0%** (50/50) |
| **Keyword coverage** (mean share of gold keywords present) | **91.3%** |
| Questions with ≥50% keyword coverage | **96.0%** (48/50) |
| Mean latency (uncached, single question) | **1585 ms** |
| p50 / p95 latency | **1451 ms / 2786 ms** |
| Cache hit rate (uncached by design) | 0.0% |
| Cache verified on repeat question | yes — second identical question returned `cached:true` |
| Average answer length | 178 characters |
| Estimated cost | **$0.00** — self-hosted GPU inference on this machine's RTX 3070; no paid API calls |

## Metric definitions

- **Retrieval Hit@3** — the expected source *file* appears in one of the first three
  citations returned by `POST /api/chat`. Measures whether the right document was
  surfaced at all.
- **Page accuracy** — a citation matches both the expected file **and** the expected
  page number. For the PDF these are real PDF page numbers; for the Markdown file
  pages come from the documented 50-lines-per-page approximation.
- **Answer Hit@3** — as Page accuracy, but restricted to the top three citations;
  this is the metric that matters for the citations actually shown to a user.
- **Keyword coverage** — share of `expectedKeywords` from `eval/questions.json` that
  appear in the generated answer (case-insensitive substring match, with a
  token-overlap fallback for morphological variants such as *tributaries* →
  *tributar*). In extractive mode this is objectively quotable because the answer is
  assembled from document sentences.

## Failure detail

- q02: pageHit=true coverage=33% | "How deep is the Challenger Deep in the Mariana Trench?"
- q15: pageHit=true coverage=33% | "What is the second largest country in the world by total are"

## Reading these numbers honestly

- Retrieval and citation accuracy are high because the corpus is small (2 files,
  15 chunks), the gold answers are literal facts, and the answer sits close to
  the retrieved passages. This is the *intended* strength on a closed corpus and
  **not** evidence of general-purpose semantic understanding.
- Embeddings came from `all-MiniLM-L6-v2` on the local GPU (384-d, deterministic
  signed random projection to 1536-d): genuinely semantic, unlike the default
  lexical hasher — but a 1.5B instruct model wrote the answers, so phrasing quality
  is bounded by that model, not by retrieval.
- Latency is single-request wall clock on a local Docker Desktop instance with an
  empty cache and includes the database round trip, the GPU embedding call and local generation.

## How to reproduce

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d   # sidecar on :8100 (RTX 3070)
npm run evaluate          # writes this file
```

Environment override for the target URL: `$env:DOCUMIND_URL = "http://localhost:3200"`.
