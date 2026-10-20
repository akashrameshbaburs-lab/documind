# Evaluation Results — DocuMind AI

> **These numbers were produced by running `npm run evaluate` against the live
> service.** No values are estimated or hand-written. Reproduce with the commands
> in the section *How to reproduce*.

| Field | Value |
| --- | --- |
| Run timestamp (UTC) | 2026-10-20T07:12:12.636Z |
| Answer mode | `extractive` |
| Embedding provider | `hashing` |
| Retrieval | hybrid: pgvector cosine + Postgres `ts_rank`, reciprocal-rank fusion (k=60) |
| Questions | 50 of 50 (0 failed to run, none) |
| Document set | world-facts.pdf (6p, 12 chunks), field-notes.md (1p, 3 chunks) |

## Headline metrics

| Metric | Result |
| --- | --- |
| **Retrieval Hit@3** (expected file among top-3 citations) | **100.0%** (50/50) |
| **Page accuracy** (expected file **and** page cited) | **100.0%** (50/50) |
| **Answer Hit@3** (top-3 citation points at the gold source+page) | **100.0%** (50/50) |
| **Keyword coverage** (mean share of gold keywords present) | **96.0%** |
| Questions with ≥50% keyword coverage | **100.0%** (50/50) |
| Mean latency (uncached, single question) | **5 ms** |
| p50 / p95 latency | **4 ms / 6 ms** |
| Cache hit rate (uncached by design) | 0.0% |
| Cache verified on repeat question | yes — second identical question returned `cached:true` |
| Average answer length | 750 characters |
| Estimated cost | **$0.00** — offline extractive mode makes no paid API calls |

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

None — every question produced a citation pointing at the gold source and page.

## Reading these numbers honestly

- Retrieval and citation accuracy are high because the corpus is small (2 files,
  15 chunks), the gold answers are literal facts, and the answer sits close to
  the retrieved passages. This is the *intended* strength on a closed corpus and
  **not** evidence of general-purpose semantic understanding.
- The hashing embedder is lexical (unigrams + bigrams + full-text rank fusion), not
  semantic: a question phrased with entirely different vocabulary would degrade
  Hit@3. LLM mode (`OPENAI_API_KEY` set) or GPU mode (`GPU_INFERENCE_URL` set) use
  real semantic embeddings and are expected to be more robust to paraphrase.
- Latency is single-request wall clock on a local Docker Desktop instance with an
  empty cache and includes the database round trip.

## How to reproduce

```powershell
docker compose up --build -d
npm run evaluate          # writes this file
```

Environment override for the target URL: `$env:DOCUMIND_URL = "http://localhost:3200"`.
