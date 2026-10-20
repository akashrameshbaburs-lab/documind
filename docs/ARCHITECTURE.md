# DocuMind AI — Architecture

How the system actually works: data flow, storage schema, retrieval math, and the
reasoning behind each decision. Everything described here exists in the repository;
the *Roadmap* section at the end lists the things that deliberately do not.

---

## 1. Components

```
                 ┌──────────────────────────────────────────────────────┐
                 │                 Express app (:3200)                  │
                 │                                                      │
  browser ──────►│  public/  (offline SPA: login, upload, chat, ratings)│
   client        │      │                                               │
                 │      ▼                                               │
                 │  routes/  auth · docs · chat · admin · health        │
                 │      │        (zod validation, multer, JWT guards)   │
                 │      ▼                                               │
                 │  services/chat.ts  ── usage gate · cache · logging   │
                 │      │                                               │
                 │      ├──► ingest/  extract → chunk → embed → SQL     │
                 │      └──► retrieval/search.ts  hybrid + RRF          │
                 │              │                                       │
                 │              ▼                                       │
                 │        answer/ extractive.ts | llm.ts                │
                 └───────────────┬──────────────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────────────┐
                 │        PostgreSQL 16 + pgvector  (:5434 → :5432)     │
                 │  users · doc_sets · documents · chunks               │
                 │  (embedding vector(1536), tsv tsvector)              │
                 │  answer_cache · usage_counters · chat_logs · feedback│
                 └──────────────────────────────────────────────────────┘
```

Two containers (`app`, `postgres`) with a health-gated start order. No runtime
dependency on any external service. Embeddings and answers are produced locally
unless configuration says otherwise; an **optional** self-hosted GPU inference
sidecar (nested in `gpu-inference/`, started via the compose profiles `gpu` /
`gpu-cpu`) can serve both embeddings and generative answers, and
`OPENAI_API_KEY` can serve both from the cloud. Priority at runtime:
**GPU → OpenAI → offline extractive**.

---

## 2. Ingest path

```
POST /api/docs   (multipart, field "files", ≤10 files, ≤ UPLOAD_MAX_MB each)
   │
   ├─ multer memory storage; extension check → pdf | docx | txt | md
   ├─ INSERT doc_sets (owner_id = caller)              ← set is created first
   │
   │  for each file (each in its own transaction):
   ▼
extract.ts
   pdf   → pdfjs-dist legacy build; getTextContent() per page  → [{page, text}]
   docx  → mammoth raw text, blank-line separated            → [{page: 1, text}]
   txt/md→ utf-8 text                                        → [{page: 1, text}]
   │
   ▼
chunk.ts
   PDF: sliding window per real page (exact page numbers)
   single-blob files: window over the whole text, page = line/50 + 1 (approximate)
     • window 1200 chars, step 1000 (200 overlap)
     • right edge snaps back to "\n\n" (≤120 chars), else sentence end,
       else forward ≤120 chars to a sentence end, else word boundary
     • overlap start snapped forward to a word boundary
     • chunks < 20 chars dropped
   │
   ▼
embeddings/  (provider chosen at runtime: GPU > OpenAI > hashing)
   hashing  → signed FNV-1a feature hashing, unigram 1.0 / bigram 0.7,
              stopwords removed, suffix-normalized, L2-normalized, 1536-d
   gpu      → POST {GPU_INFERENCE_URL}/v1/embeddings (all-MiniLM-L6-v2, 384-d),
              mapped to 1536-d by a deterministic signed random projection
              (seeded PRNG, re-normalized) so ingest and query spaces match
   openai   → text-embedding-3-small (1536-d) — only when OPENAI_API_KEY is set
   │
   ▼
INSERT INTO documents (...); INSERT INTO chunks (...)   in one transaction
   ▼
201 { setId, name, files: [{ fileId, name, pages, chunks }] }
```

Failure handling: if any file in the request fails to ingest, the whole set is
deleted so clients never see a partially populated set.

### Why chunking is sentence-aware

The extractive answer stage quotes **whole sentences** from chunk text. A naive
fixed-width window slices sentences in half, producing answers that start
mid-clause. The end-of-window search therefore prefers a paragraph break, then a
sentence terminator, and is allowed to look *forward* up to 120 characters to
close a sentence rather than cut it.

### Why pages are approximate for txt/md/docx

Those formats carry no page geometry. Splitting them into 50-line pseudo-pages
keeps the citation shape uniform (`file + page`) while being honest about the
approximation, which is stated in `docs/EVALUATION.md` metric definitions and
visible in the API responses. PDFs — the format that matters for real documents —
use real page numbers because chunking runs per page.

---

## 3. Database schema

Created idempotently at startup by `src/db/migrate.ts` (all statements
`IF NOT EXISTS`, plus `CREATE EXTENSION IF NOT EXISTS vector`).

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | `id uuid PK`, `email text UNIQUE`, `password_hash`, `created_at` | scrypt hashes; email lowercased on write |
| `doc_sets` | `id uuid PK`, `owner_id → users`, `name` | the privacy boundary; every query is scoped by it |
| `documents` | `id uuid PK`, `set_id → doc_sets`, `file_name`, `ext`, `mime`, `pages` | one row per uploaded file |
| `chunks` | `id bigserial PK`, `doc_id`, `set_id`, `idx`, `page`, `content`, `tsv`, `embedding vector(1536)` | `tsv` is `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` |
| `answer_cache` | `PK (set_id, qhash)`, `question`, `answer`, `citations jsonb`, `answer_mode`, `hits`, `created_at` | one row per distinct question per set; `answer_mode` ∈ extractive \| llm \| gpu |
| `usage_counters` | `PK (user_id, day)`, `queries` | the composite key makes the quota check atomic |
| `chat_logs` | `id uuid PK`, `user_id`, `set_id`, `question`, `answer`, `answer_mode`, `latency_ms`, `cached`, `created_at` | history + feedback target |
| `feedback` | `chat_id PK → chat_logs`, `user_id`, `thumbs CHECK (thumbs IN (-1, 1))`, `created_at` | one rating per chat row |

Indexes:

```sql
idx_chunks_set  ON chunks(set_id)                             -- set scoping
idx_chunks_doc  ON chunks(doc_id)                             -- per-file queries
idx_chunks_tsv  ON chunks USING gin(tsv)                      -- full-text channel
idx_chunks_emb  ON chunks USING hnsw (embedding vector_cosine_ops)  -- vector channel
idx_chat_logs_user ON chat_logs(user_id, created_at DESC)     -- history
```

**HNSW rather than IVFFlat:** HNSW has no training step and degrades gracefully
when rows are inserted after index creation — the normal case here, since a set
is populated by the upload that immediately precedes the first query.

**Generated `tsvector` rather than a trigger:** `to_tsvector('english', content)`
can never drift out of sync with `content`, and `'english'` also gives stemming
plus a stopword list for free.

---

## 4. Query path

`POST /api/chat { setId, question }` → `services/chat.ts:answerQuestion()`

```
1. Ownership check      SELECT owner_id FROM doc_sets WHERE id = $1
                        not found → 404 ; owner_id ≠ caller → 403
2. Usage gate           atomic INSERT … ON CONFLICT DO UPDATE
                        WHERE usage_counters.queries < limit RETURNING queries
                        no row updated → 429 daily_limit_exceeded
3. Cache probe          UPDATE answer_cache SET hits = hits + 1
                        WHERE set_id = $1 AND qhash = $2 RETURNING …
                        hit → return cached:true (+hit count), log chat row, done
4. Embed question       one vector, 1536-d
5. Hybrid search        vector channel + full-text channel → RRF → top 8
6. Answer               extractive always available; generative branch when
                        `answerMode()` is `"llm"` (OpenAI) or `"gpu"` (sidecar)
7. Persist              INSERT … ON CONFLICT (set_id, qhash) DO UPDATE hits+1
                        INSERT chat_logs RETURNING id
```

Ordering matters: the usage counter increments for **every** request including
cache hits, so caching cannot be used to bypass the daily quota, and the quota
check happens before any embedding or search work.

### Reciprocal Rank Fusion

```
vecTop   = 100 chunks ORDER BY embedding <=> qvec          (cosine distance asc)
ftsTop   = 100 chunks WHERE tsv @@ query ORDER BY ts_rank DESC

fused(c) =  1/(k + rankA(c))  +  1/(k + rankB(c))          k = 60, missing ⇒ 0
fused    =  min(fused / (2/(k+1)), 1)                      normalized to (0, 1]
```

Ranking is done per channel and only **ranks** are combined. That is the point of
RRF: cosine similarity lives in `0..1` while `ts_rank` is a small float, so any
weighted sum of raw scores needs per-query normalization and still breaks when a
channel returns nothing. With RRF a chunk ranked #1 by either channel scores
`1/61 ≈ 0.0164`, and agreement across both channels is rewarded
(`2/61 ≈ 0.0328`). The returned `fused` value is normalized so 1.0 means "rank 1
in both channels", which is what shows up as `score` in citations.

Set scoping happens **inside both SQL queries** (`WHERE c.set_id = $2`) before any
ranking, so `topK` is meaningful and cross-set leakage is impossible at this layer.

Ties are effectively broken by the sort on the summed score: a chunk that only
appears in one channel carries a single smaller term and sorts below chunks that
appear in both.

---

## 5. Answer synthesis

### Extractive (default, offline) — `src/answer/extractive.ts`

1. Take the top 3 fused chunks. Split each into candidate sentences: paragraph
   breaks first (so headings separate from prose), then `(?<=[.!?])\s+`, keeping
   sentences of 30–500 characters, stripping markdown bullet/heading decoration.
2. Skip a chunk's first segment when it starts lowercase — that is an overlap
   fragment continuing the previous chunk, and it reads badly as an answer.
3. Score each sentence:

   ```
   coverage = |query tokens ∩ sentence tokens| / |query tokens|
   score    = coverage
            + (hits.length − hit.rank) × 0.03      -- prefer higher-ranked chunks
            − (len > 320 ? 0.08 : 0)               -- discourage over-long sentences
   ```

4. Keep sentences with `coverage > 0` (at least one shared token), deduplicate by
   the first 80 lowercase characters, sort by score and take the top 4.
5. Emit them as a bulleted list under a fixed lead-in, each with
   `[source: file, p.N]`. Citations are built from the chunk metadata
   (`fileId, fileName, page, snippet ≤240 chars, score = fused`), up to 5.
6. If nothing matched, quote the highest-ranked chunk's sentences anyway rather
   than returning an empty answer; if retrieval returned no chunks at all, return
   an explicit "no relevant passages" message with an empty citation list.

The ≥1-token gate is deliberate. A stricter "≥2 shared tokens" filter was tried and
**rejected**: it dropped Retrieval Hit@3 from 95.3 % to 90.0 % in evaluation, because
many gold facts are carried by a single distinctive term. Scoring — not gating —
handles precision, and the rank bonus orders what survives.

### LLM (opt-in) — `src/answer/llm.ts`

When `OPENAI_API_KEY` is set and no GPU URL is configured, `answerMode()`
returns `"llm"` and the fused chunks are passed to `gpt-4o-mini` as grounding
context. If the API call throws, the code catches it and returns the extractive
answer with an explicit note that generative mode was unavailable — the request
still succeeds and the user is told the truth about how the answer was produced.

### GPU (opt-in) — `src/answer/llmLocal.ts`

When `GPU_INFERENCE_URL` is set (highest priority), `answerMode()` returns
`"gpu"` and the same grounded prompt is sent to the self-hosted sidecar's
`/v1/chat/completions` (a local instruct model — see `gpu-inference/`). The
sidecar not being reachable degrades exactly like an OpenAI failure: quoted
extractive answer plus a visible note, never a fabricated "GPU answer".

`answer_mode` is recorded per cache row and per chat log in all three modes, so
a mixed history stays self-describing, and a cached row always returns the mode
it was generated with.

---

## 6. Auth, isolation and quotas

- **Passwords:** `node:crypto` `scrypt` with a random per-user salt, verified with
  `timingSafeEqual`. No native module, so the image stays small and portable.
- **Tokens:** HS256 JWT, `{ sub, email, isAdmin }`, 12-hour expiry, signed with
  `JWT_SECRET`. `requireAuth` attaches `req.user`; `requireAdmin` additionally
  requires the token's email to equal `ADMIN_EMAIL`.
- **Isolation:** ownership is resolved from the token's user id in SQL
  (`WHERE owner_id = $1`), never from a request parameter. Reading, deleting or
  querying someone else's set returns **403**; an unknown id returns 404. Sets are
  per-user by construction, so there is no listing route that can leak another
  user's data.
- **Quota:** `MAX_QUERIES_PER_DAY` (default 100), enforced by
  `usage_counters (user_id, day)` with a single conditional upsert. Because the
  conflict target is the primary key and the `WHERE` clause guards the increment,
  concurrent requests cannot both consume the same slot; the loser gets zero rows
  back and becomes a 429. The counter is per UTC day.

---

## 7. Caching

Cache key: `(set_id, qhash)` where
`qhash = sha256(normalizeQuestion(question))` and normalization lowercases,
collapses whitespace and trims — so `"What  is Everest?"`, `"what is everest?"`
and trailing-space variants share an entry.

- Read path is an `UPDATE … RETURNING`: hit → `cached: true`, `hits` incremented,
  no embedding and no search performed (measurably faster — 3 ms vs 9 ms in the
  demo run).
- Write path is `INSERT … ON CONFLICT (set_id, qhash) DO UPDATE SET hits = hits + 1`,
  which both stores a new answer and tolerates a concurrent duplicate insert.
- Stored with the answer are its `citations` (jsonb) and `answer_mode`, so a cached
  extractive answer is never later returned as an LLM answer.
- Deleting a set cascades to its cache rows (FK `ON DELETE CASCADE`), so stale
  answers cannot outlive their documents.

Postgres *is* the cache today. A Redis tier is listed in the roadmap; it would add
a faster shared layer, not missing behaviour.

---

## 8. Error handling and observability

- Every failure funnels through one Express error handler and is rendered as
  `{ error, message, details? }`. `HttpError` carries an explicit code; zod errors
  become `validation_error` with per-field details; `MulterError`
  `LIMIT_FILE_SIZE` becomes **413**, other multer errors **400**.
- Status codes in use: 400, 401, 403, 404, 409, 413, 429, 500, 503.
- `GET /healthz` is pure liveness. `GET /readyz` runs `SELECT 1` and returns 503
  when the database is unreachable — this is what the container healthcheck calls,
  and what `depends_on: service_healthy` waits on.
- pino logs one JSON line per request (method, path, status, duration) and
  structured logs for startup/migration retries.
- `GET /api/config` exposes the active `answerMode`, embedding provider and limits
  so the UI (and a reviewer) can confirm which mode is live.

---

## 9. Deployment

**Dockerfile** (multi-stage):

1. `deps` — `npm ci` from the committed `package-lock.json`.
2. `build` — `npm run build` (`tsc`) → `dist/`.
3. `prod` — production dependencies only, `NODE_ENV=production`, **`USER node`**
   (non-root), `EXPOSE 3200`, and a `HEALTHCHECK` that fetches `/readyz`; the
   container command is `node dist/src/index.js`.

**docker-compose.yml:**

- `postgres`: image `pgvector/pgvector:pg16`, named volume for data,
  `pg_isready` healthcheck, host port **5434** → container 5432.
- `app`: built from the local Dockerfile, `depends_on: postgres: { condition:
  service_healthy }`, host port **3200** → container 3200, environment for
  `DATABASE_URL` (pointing at the `postgres` service), `JWT_SECRET`,
  `ADMIN_EMAIL`, `MAX_QUERIES_PER_DAY`, `UPLOAD_MAX_MB` and the optional
  `OPENAI_*` / `GPU_*` variables.
- `gpu` / `gpu-cpu`: optional profiles (see `gpu-inference/`) building the
  sidecar image; `gpu` reserves the NVIDIA device and publishes host port
  **8100**, `gpu-cpu` runs the same image without a device on **8101**. Both
  mount the pinned `gpu-inference_hf_models` volume holding the HuggingFace
  model cache, so neither profile re-downloads weights after the first boot.
  With no `GPU_INFERENCE_URL` set the app stays in offline extractive mode
  whether the profiles run or not.

Migrations run at process start (`migrateWithRetry`, 20 attempts × 1.5 s) so host
runs work even if Postgres is still starting; under compose the healthcheck
normally means the first attempt already succeeds.

---

## 10. Roadmap (not implemented)

Called out explicitly so the architecture is not over-read:

- **OCR (tesseract)** for scanned PDFs/images — extraction requires a text layer.
- **Redis answer cache** — the cache is Postgres-backed today.
- **Semantic retrieval by default** — the semantic paths (OpenAI, local GPU
  sidecar) are implemented but opt-in; the default path is offline and lexical
  by design.

No stubs, flags or dead code paths exist for these; they are future work.
