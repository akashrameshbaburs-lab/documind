# DocuMind AI — Document Q&A Platform (RAG)

Upload documents into a private **document set**, ask questions in natural language,
and get **answers with citations** (file, page, snippet, fused score) —
running **fully offline** out of the box, with no API key and no network calls.

DocuMind is a retrieval-augmented generation (RAG) service with a REST API and a
browser UI. It extracts text from PDF/DOCX/TXT/Markdown, chunks it, embeds it into
Postgres + pgvector, and answers questions by **fusing vector similarity with
Postgres full-text search**. Every answer reports the mode that produced it
(`answerMode`), so a quoted extractive answer is never presented as "AI-generated".
Three answer modes exist, selected by configuration at runtime, in priority order:

1. **`gpu`** — when `GPU_INFERENCE_URL` is set: embeddings and answers come from a
   self-hosted inference sidecar (see [`gpu-inference/`](gpu-inference/)); data
   stays on the machine, no API cost. If the sidecar is unreachable the request
   fails loudly (`502 gpu_unreachable`) instead of silently mixing embedding
   spaces; only a failed *generation* call falls back to quoted extraction, with
   a visible note.
2. **`llm`** — when `OPENAI_API_KEY` is set: OpenAI `text-embedding-3-small` +
   `gpt-4o-mini` over the same fused chunks; falls back to quoting on failure.
3. **`extractive`** (default, fully offline): sentences quoted verbatim from the
   retrieved documents.

Whichever mode ran is always reported in `answerMode`.

---

## Pipeline at a glance

```
INGEST                                        QUERY
  upload (pdf/docx/txt/md)                      question
      │                                             │
      ▼                                             ▼
  extract text per page                        embed question (1536-d)
  (pdfjs-dist / mammoth / plain)                    │
      │                                             ▼
      ▼                                    HYBRID RETRIEVAL (inside the set)
  chunk: 1200 chars, 200 overlap,          ┌──────────────────────────────┐
  sentence/paragraph-snapped,              │ A) pgvector cosine (`<=>`)   │  100 candidates
  page attributed                          │ B) ts_rank over tsvector     │  100 candidates
      │                                    └───────────────┬──────────────┘
      ▼                                                    ▼
  embed 1536-d (hashing / OpenAI / GPU sidecar)
                                       Reciprocal Rank Fusion (k=60)
      │                                          fused(c) = Σ 1/(k+rank)
      ▼                                                    │
  chunks + tsvector + vector  ──►  Postgres ◄──────────────┤
   (HNSW cosine index, GIN on tsv)                         ▼
                                              ANSWER (extractive quotes / OpenAI
                                              / local GPU model — all grounded
                                              in the same fused chunks)
                                                           │
                                                           ▼
                                              { answer, citations[], answerMode,
                                                cached, latencyMs }
```

```
DEPLOYMENT (Docker Compose)
  app :3200 (multi-stage, non-root `node`, healthcheck on /readyz)
     └─ depends_on: service_healthy ─► postgres+pgvector :5434→5432 (healthcheck pg_isready)
     └─ optional GPU sidecar :8100 via override file docker-compose.gpu.yml
        (RTX 3070, nvidia runtime; sets GPU_INFERENCE_URL automatically —
         one command turns GPU mode on, nothing to remember):
        docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22, TypeScript (strict, ESM), ts-node for scripts |
| API | Express 4, zod validation, multer uploads, pino logging, jsonwebtoken (JWT, 12 h) |
| Storage | PostgreSQL 16 + **pgvector** — one container, one connection pool |
| Vector index | **HNSW** (`vector_cosine_ops`) on `vector(1536)` |
| Keyword index | Generated `tsvector` column + **GIN** index, ranked by `ts_rank` |
| Fusion | **Reciprocal Rank Fusion**, k = 60 (scale-free rank fusion) |
| PDF / DOCX | `pdfjs-dist` 4.8 (legacy build, lazy import, bundled offline fonts) / `mammoth`; TXT + Markdown natively |
| Embeddings | Offline **signed FNV-1a feature hashing** (1536-d) · optional OpenAI `text-embedding-3-small` · optional self-hosted GPU sidecar (MiniLM 384-d → deterministic 1536-d projection) |
| Answers | Extractive sentence scoring (offline) · optional OpenAI `gpt-4o-mini` · optional local instruct model via the sidecar |
| Auth | `node:crypto` **scrypt** password hashing (no native deps) + JWT |
| UI | Vanilla HTML/CSS/JS served by Express — no CDN, works offline |
| Tests | `scripts/demo.ps1` e2e suite (34 assertions) · `scripts/evaluate.ts` 50-question benchmark |
| Ops | Multi-stage Dockerfile (non-root), compose healthchecks, startup migrations |

**Ports:** app `3200`, Postgres `5434` (host) → `5432` (container), plus the
optional sidecar `8100` (via `docker-compose.gpu.yml`; standalone CPU fallback
`8101` from `gpu-inference/`) — nothing else is ever bound.

---

## Quick start

### Docker (recommended)

```powershell
docker compose up --build -d
docker compose ps                      # wait until both are healthy
.\scripts\demo.ps1                     # end-to-end proof: 34 assertions
```

Then open **http://localhost:3200**, register, upload documents, ask questions.

Optional local-GPU mode (RTX-class nvidia GPU; model cache persists in the
pinned `gpu-inference_hf_models` volume). One flag flips the whole stack —
sidecar **and** `GPU_INFERENCE_URL` — so it can't start half-configured:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
#   -> app in GPU mode (answerMode:"gpu") + sidecar on port 8100 (cuda)
# verify:  Invoke-RestMethod http://localhost:8100/v1/info
# back to offline mode:  docker compose up -d app
```

CPU-only machines: run the sidecar standalone from `gpu-inference/` (compose
profile `cpu`, port 8101) and set `GPU_INFERENCE_URL=http://host.docker.internal:8101`.

### Local development

```powershell
docker compose up -d postgres
npm ci
Copy-Item .env.example .env
npm run generate-samples               # optional: writes eval/docs/world-facts.pdf
npm run build
npm run dev                            # http://localhost:3200 (migrations run at startup)
```

### Configuration

All variables are documented in [`.env.example`](.env.example). Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3200` | HTTP port |
| `DATABASE_URL` | `postgres://documind:documind@localhost:5434/documind` | Database (compose injects the `postgres` host) |
| `JWT_SECRET` | insecure dev value | **Set a long random value in production** |
| `ADMIN_EMAIL` | `admin@documind.local` | The account with this email is the admin |
| `MAX_QUERIES_PER_DAY` | `100` | Per-user daily chat quota → HTTP 429 when exceeded |
| `UPLOAD_MAX_MB` | `15` | Max size per uploaded file (max 10 files per request) |
| `OPENAI_API_KEY` | *(unset)* | Set it to switch to `answerMode: "llm"` + OpenAI embeddings |
| `GPU_INFERENCE_URL` | *(unset)* | Self-hosted sidecar URL (inside compose: `http://gpu:8000`) → `answerMode: "gpu"`; takes priority over the OpenAI key |
| `GPU_CHAT_MODEL` | `Qwen/Qwen2.5-1.5B-Instruct` | Model label used with the sidecar's chat endpoint |

---

## API

All `/api` routes except register/login require `Authorization: Bearer <JWT>`.
Documents live in a **private set**; every set is owned by exactly one user, and
access is enforced by ownership at the SQL level (not by request parameters).

| Method & path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness (process is up) |
| `GET /readyz` | Readiness — executes a real `SELECT 1` against the pool |
| `GET /api/config` | Public runtime info: answer mode, embedding provider, limits |
| `POST /api/register` | Create account → `201 { id, email }`; duplicate → `409` |
| `POST /api/login` | → `{ token, user: { id, email, isAdmin } }`; bad credentials → `401` |
| `GET /api/me` | Current user from the token |
| `POST /api/docs` | Multipart upload, field `files` (≤10, ≤15 MB each), optional `name` → `201 { setId, name, files[] }` |
| `GET /api/sets` | List **your** sets with file/chunk counts |
| `GET /api/docs/:setId` | Inspect one owned set and its files |
| `DELETE /api/docs/:setId` | Delete an owned set (cascades to chunks + cache) |
| `POST /api/chat` | `{ setId, question }` → `{ id, answer, citations[], answerMode, latencyMs, cached }` |
| `GET /api/usage` | Today's `{ day, queries, limit, remaining }` for the caller |
| `GET /api/chat/history/:setId` | Last 25 questions of the caller in that set |
| `POST /api/chat/:id/feedback` | `{ thumbs: 1 \| -1 }` upsert; invalid value → `400` |
| `GET /api/admin/feedback` | **Admin only** — totals, up/down ratio, per-set breakdown, recent feedback |

Errors are always `{ "error": "<code>", "message": "<human text>", "details"?: ... }`
(400 validation, 401 auth, 403 ownership/admin, 404 missing, 409 duplicate,
413 file too large, 429 daily limit).

### Worked example

```powershell
$login = Invoke-RestMethod http://localhost:3200/api/login -Method Post `
  -ContentType "application/json" `
  -Body '{"email":"you@example.com","password":"your-password"}'
$h = @{ Authorization = "Bearer $($login.token)" }

# upload one or more files into a new private set
# (PowerShell 5.1's Invoke-RestMethod has no -Form; use HttpClient for multipart)
Add-Type -AssemblyName System.Net.Http
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path .\eval\docs\world-facts.pdf))
$mp = New-Object System.Net.Http.MultipartFormDataContent
$mp.Add((New-Object System.Net.Http.ByteArrayContent($bytes, 0, $bytes.Length)), "files", "world-facts.pdf")
$cli = New-Object System.Net.Http.HttpClient
$cli.DefaultRequestHeaders.Authorization = "Bearer $($login.token)"
$json = $cli.PostAsync("http://localhost:3200/api/docs", $mp).Result.Content.ReadAsStringAsync().Result
$up = $json | ConvertFrom-Json
$cli.Dispose(); $mp.Dispose()

# ask a question
Invoke-RestMethod http://localhost:3200/api/chat -Method Post -Headers $h `
  -ContentType "application/json" `
  -Body (@{ setId = $up.setId; question = "Which mountain is the highest above sea level?" } | ConvertTo-Json)
```

```json
{
  "id": "0f5c…",
  "answer": "Based on the most relevant passages in your documents:\n\n- Mount Everest is Earth's highest mountain above sea level, rising to 8,849 metres (29,032 feet) on the border between Nepal and the Tibet Autonomous Region of China. [source: world-facts.pdf, p.1]",
  "citations": [
    {
      "fileId": "1c2e…",
      "fileName": "world-facts.pdf",
      "page": 1,
      "snippet": "World Facts Handbook - Chapter 1: Physical Geography…",
      "score": 0.5
    }
  ],
  "answerMode": "extractive",
  "latencyMs": 9,
  "cached": false
}
```

A second, byte-identical question against the same set returns `"cached": true`
with a `cacheHits` counter, and does **not** re-run retrieval.

---

## The three answer modes — honest by design

| | **Extractive** (default, offline) | **LLM** (`OPENAI_API_KEY` set) | **GPU** (`GPU_INFERENCE_URL` set) |
| --- | --- | --- | --- |
| Answer comes from | Sentences quoted **verbatim** from the top-ranked chunks | `gpt-4o-mini` chat completion over the same fused chunks | Local instruct model on the machine's GPU, same grounding contract |
| Selection | Query-token coverage + rank bonus; top sentences in document order | Full generative answer, still grounded in retrieved context | Full generative answer with `[source: …]` markers appended by prompt |
| Citations | Exact — each quoted sentence is tagged `[source: file, p.N]` | Derived from the chunks fed to the model | Derived from the chunks fed to the model |
| Network / key | **Not required** | OpenAI key required | Local sidecar required (no key, no cost) |
| Reported as | `answerMode: "extractive"` | `answerMode: "llm"` | `answerMode: "gpu"` |
| On failure | — | Falls back to the extractive answer with a visible note | Embedding failure fails the request with `502 gpu_unreachable` (vector spaces are never mixed); generation-only failure falls back to the extractive answer with a visible note |

The service never claims to have used a generative model when it has not.

### How hybrid retrieval works

Each question is searched twice, scoped to the one document set and capped at 100
candidates per channel:

1. **Vector channel** — `ORDER BY embedding <=> query_vector` (pgvector cosine
   distance, HNSW index).
2. **Full-text channel** — `tsv @@ plainto_tsquery('english', q)` ordered by
   `ts_rank` (GIN index). This catches exact terms, rare words and numbers that a
   lexical-hash embedding may under-rank.

The two ranked lists are merged with **Reciprocal Rank Fusion**:

```
fused(c) =  1/(k + rankA(c))  +  1/(k + rankB(c))          k = 60
```

then normalized by the theoretical maximum `2/(k+1)` so `fused ∈ (0, 1]`.
RRF is used because the raw scores are incommensurable — cosine similarity is
`0..1` while `ts_rank` is a tiny float; ranking each channel independently and
fusing *ranks only* makes the blend robust, including when one channel returns
no matches at all. Ties are broken by the channel that ranked the chunk higher.

### Chunking

- Window **1200 characters**, step **1000** (200-character overlap).
- The right edge snaps backward to a paragraph break, then a sentence end, then a
  word boundary (searching ≤120 chars); if none is available behind, it may snap
  *forward* ≤120 chars to finish the sentence. Sentences are never cut in half,
  which is what makes verbatim quoting possible.
- The overlap start is snapped forward to a word boundary so no chunk begins mid-word.
- **Page attribution:** PDFs are chunked per real page, so page numbers are exact.
  DOCX/TXT/MD have no page geometry, so pages are approximated as **50 lines per
  page** (documented, and stated in `GET /api/docs/:setId` results by extension).

### Embeddings

The provider is chosen at runtime, in priority order:

1. **gpu** (`GPU_INFERENCE_URL` set) — the sidecar serves
   `sentence-transformers/all-MiniLM-L6-v2` (384-d). Because the database column
   is fixed at `vector(1536)`, the vector is mapped through a **deterministic
   signed random projection** (seeded PRNG, then re-normalized) — the same
   matrix is rebuilt at query time, so ingest and query spaces always match
   (Johnson–Lindenstrauss preserves cosine similarity).
2. **openai** (`OPENAI_API_KEY` set) — `text-embedding-3-small`, native 1536-d.
3. **hashing** (default, offline) — signed FNV-1a feature hashing over unigrams
   (weight 1.0) and bigrams (0.7), stopwords removed, light suffix
   normalization, L2-normalized to 1536 dimensions. Deterministic,
   dependency-free, network-free — but **lexical, not semantic**.

Every provider emits 1536-d L2-normalized vectors, so the pgvector column type
never changes. The vectors themselves are **not** comparable across providers,
however: a set must be queried with the provider it was ingested under. If you
switch providers, re-upload the documents (embeddings are rebuilt at ingest
time) so document and query vectors always share one space — the service does
not silently re-embed old sets.

---

## Evaluation

`npm run evaluate` uploads the two generated sample documents as a set, runs the
50-question gold set from `eval/questions.json` against the live service, and
writes measured results to [`docs/EVALUATION.md`](docs/EVALUATION.md) — no
hand-written numbers.

Two measured runs of the same 50-question gold set, written by `npm run evaluate`
(`--out` picks the file) — no hand-written numbers:

**Extractive mode** — `hashing` embeddings (signed FNV-1a, 1536-d),
[`docs/EVALUATION.md`](docs/EVALUATION.md):

| Metric | Result |
| --- | --- |
| Retrieval Hit@3 (gold file in top-3 citations) | **100.0 %** (50/50) |
| Page accuracy (gold file **and** page cited) | **100.0 %** (50/50) |
| Answer Hit@3 (top-3 citations) | **100.0 %** (50/50) |
| Keyword coverage (mean share of gold keywords in the answer) | **96.0 %** |
| Questions with ≥ 50 % keyword coverage | **100.0 %** (50/50) |
| Mean latency / p50 / p95 | **5 ms / 4 ms / 6 ms** |
| Cache verified on repeat question | **yes** (`cached: true`) |
| Estimated API cost | **$0.00** (offline mode) |

**GPU mode** — `all-MiniLM-L6-v2` embeddings + `Qwen2.5-1.5B-Instruct` answers on
the RTX 3070 (override file `docker-compose.gpu.yml`), [`docs/EVALUATION_GPU.md`](docs/EVALUATION_GPU.md):

| Metric | Result |
| --- | --- |
| Retrieval Hit@3 (gold file in top-3 citations) | **100.0 %** (50/50) |
| Page accuracy (gold file **and** page cited) | **100.0 %** (50/50) |
| Answer Hit@3 (top-3 citations) | **100.0 %** (50/50) |
| Keyword coverage (mean share of gold keywords in the answer) | **91.3 %** |
| Questions with ≥ 50 % keyword coverage | **96.0 %** (48/50) |
| Mean latency / p50 / p95 | **1585 ms / 1451 ms / 2786 ms** |
| Cache verified on repeat question | **yes** (`cached: true`) |
| Estimated API cost | **$0.00** (self-hosted, no paid API calls) |

The honest trade-off between the two: retrieval quality is identical at this
corpus size, keyword coverage dips 4.7 points because a 1.5B model paraphrases
instead of quoting, and latency costs ~1.6 s per *uncached* question because
text is actually being generated. Repeat questions are served from the cache in
single-digit milliseconds in both modes.

`scripts/demo.ps1` is the behavioural proof — **34 assertions** covering health and
readiness, registration/login plus duplicate and bad-credential paths, token
rejection, multi-file upload (page and chunk counts reported per file), an empty
upload → 400, chat with citations and `answerMode`, cache hit on a repeat question
(faster second read + byte-identical answer), thumbs up/down with upsert and
invalid value → 400, the usage counter, cross-user isolation (403 on read, delete
and query; user B sees zero sets), non-admin admin route → 403, and admin feedback
aggregation. `scripts/probe-ratelimit.ts` separately drives asks past
`MAX_QUERIES_PER_DAY` and exits non-zero unless a real 429 with a JSON body
appears.

```powershell
.\scripts\demo.ps1        # expected last line: ALL CHECKS PASSED (34 assertions)
```

### Reading these numbers honestly

Retrieval scores are high because the corpus is small (2 documents, 15 chunks),
the gold answers are literal facts, and extractive mode quotes source sentences
instead of paraphrasing. That is the intended strength of the offline mode, **not
evidence of general-purpose semantic understanding**: the hashing embedder is
lexical, so a question phrased with entirely different vocabulary would reduce
Hit@3. More detail and per-question failure output lives in
[`docs/EVALUATION.md`](docs/EVALUATION.md).

---

## Roadmap — deliberately **not** implemented

These are planned work, called out so nothing is over-claimed. There are no
stubbed code paths for them in the repository:

- **OCR for scanned PDFs and images** (e.g. tesseract). Extraction requires a text
  layer today; a scanned document yields little or no text.
- **Redis-backed answer cache.** Caching exists and is verified, but it is
  Postgres-backed (`answer_cache`); Redis would be an additional tier, not a
  replacement for missing functionality.
- **Semantic retrieval by default.** Semantic embedding paths exist (OpenAI and
  the local GPU sidecar) but both are opt-in; the default path is the offline
  lexical hasher, so a deployment without any sidecar or key still retrieves by
  vocabulary overlap only.

---

## Project layout

```
documind/
├─ src/
│  ├─ index.ts              # Express app, route mounting, error handler, startup migrations
│  ├─ config.ts             # zod-parsed env, EMBEDDING_DIM, answer-mode derivation
│  ├─ text.ts               # tokenizer, stopwords, light suffix normalization, question normalization
│  ├─ logger.ts  httpError.ts
│  ├─ db/pool.ts            # pg pool + withTransaction
│  ├─ db/migrate.ts         # idempotent schema (users, doc_sets, documents, chunks,
│  │                        #   answer_cache, usage_counters, chat_logs, feedback) + indexes
│  ├─ auth/                 # scrypt password.ts, jwt.ts, requireAuth/requireAdmin middleware
│  ├─ ingest/extract.ts     # pdfjs-dist / mammoth / plain text → page-attributed text
│  ├─ ingest/chunk.ts       # 1200/200 sliding window, sentence snapping, page attribution
│  ├─ ingest/ingest.ts      # file → chunks → embeddings → SQL (transactional)
│  ├─ embeddings/           # provider.ts, hashing.ts (offline), openai.ts,
│  │                        #   gpu.ts (sidecar + 384→1536 projection), index.ts
│  ├─ retrieval/search.ts   # hybrid vector + full-text search, RRF fusion
│  ├─ answer/extractive.ts  # grounded offline answers + citations
│  ├─ answer/llm.ts         # optional OpenAI answer synthesis
│  ├─ answer/llmLocal.ts    # optional self-hosted GPU answer synthesis
│  ├─ services/chat.ts      # ownership check, usage gate, cache, retrieval, logging
│  └─ routes/               # auth.ts, docs.ts, chat.ts, admin.ts, health.ts
├─ public/                  # offline browser UI: index.html, app.js, styles.css
├─ scripts/
│  ├─ demo.ps1              # 34-assertion end-to-end suite (PowerShell 5.1)
│  ├─ evaluate.ts           # 50-question benchmark → docs/EVALUATION{,_GPU}.md
│  ├─ generate-samples.js   # PDFKit fixture generator
│  └─ probe*.ts, inspect-extract.ts   # development verification helpers
├─ eval/
│  ├─ questions.json        # 50 gold questions with expected file/page/keywords
│  └─ docs/                 # world-facts.pdf (generated), field-notes.md
├─ docs/
│  ├─ ARCHITECTURE.md       # internals: schema, fusion math, caching, limits
│  ├─ EVALUATION.md         # 50-question run, extractive mode
│  └─ EVALUATION_GPU.md     # 50-question run, GPU mode (same gold set)
├─ gpu-inference/           # optional local GPU sidecar (own README + bench)
│  ├─ app/                  # FastAPI: OpenAI-compatible /v1 endpoints
│  ├─ scripts/bench.py      # stdlib benchmark → docs/BENCHMARK.md
│  ├─ Dockerfile            # pytorch/pytorch:2.5.1-cuda12.4 runtime
│  └─ docker-compose.yml    # standalone sidecar stack (own project, :8100)
├─ Dockerfile               # multi-stage, non-root, /readyz healthcheck
├─ docker-compose.yml       # base stack: app + pgvector/pgvector:pg16
├─ docker-compose.gpu.yml   # GPU override: sidecar + GPU_INFERENCE_URL together
├─ .env.example
└─ package.json             # build, start, dev, evaluate, generate-samples, typecheck
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Measured results: [`docs/EVALUATION.md`](docs/EVALUATION.md) (extractive) ·
[`docs/EVALUATION_GPU.md`](docs/EVALUATION_GPU.md) (GPU)

---

## License

MIT.
