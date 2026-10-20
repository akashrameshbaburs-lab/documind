# DocuMind AI — Architecture

This document describes how the system works internally: data flow, storage schema,
retrieval math, and the decisions behind them.

---

## 1. High-level components

```
                 ┌────────────────────────────────────────────────┐
                 │                 Express app (:3200)            │
                 │                                                │
  browser  ──────►  public/ SPA        routes/  (zod-validated)   │
  client         │                        │                       │
                 │   auth/  scrypt + JWT  │                       │
                 │                        ▼                       │
                 │        services/  documents · chat             │
                 │            │                │                  │
                 │            ▼                ▼                  │
                 │      ingest/           retrieval/              │
                 │   extract → chunk      hybrid + RRF            │
                 │        │                    │                  │
                 │        ▼                    ▼                  │
                 │   embeddings/          answer/extractive       │
                 │  hashing (offline)          │                  │
                 └────────────┬────────────────┬──────────────────┘
                              ▼                ▼
                 ┌────────────────────────────────────────────────┐
                 │     PostgreSQL 16 + pgvector  (:5434→5432)     │
                 │  documents · chunks(embedding vector(1536))    │
                 │  answer_cache · usage_counters · feedback      │
                 └────────────────────────────────────────────────┘
```

Everything runs in two containers (`app`, `postgres`) with a health-gated startup order.
No external network dependency at runtime.

---

## 2. Ingest path

```
POST /documents (multipart)
   │  validate (zod): pdf|docx|txt|md, size ≤ 25 MB, ≤ 10 files
   ▼
extract.ts
   pdf  → pdfjs-dist legacy build, getTextContent() per page   → [{page, text}]
   docx → mammoth raw text, split every 50 lines               → [{page, text}]
   txt/md → split every 50 lines                               → [{page, text}]
   ▼
chunk.ts  — sliding window over the *page-joined* text
   window = 1200 chars, overlap = 200 chars
   window end snapped backward to a paragraph break (\n\n ≤ 120 chars away),
           else to a sentence end ( . ! ? : ; … " ), else to a word boundary
   window start snapped forward to a word boundary (never mid-word)
   → { content, page, startOffset } with page carried from the offset map
   ▼
embeddings/hashing.ts — 1536-d signed feature hashing
   tokens (lowercase, stopwords removed, light suffix normalization)
   features: unigram w=1.0, bigram w=0.7 → index → L2-normalize
   ▼
INSERT INTO chunks (document_id, org_id, user_id, content, page, embedding …)
```

Design notes:

- **Page tracking.** Text is concatenated across pages while recording character offsets,
  so every chunk knows the page it started on. For PDFs this is exact; for DOCX/TXT/MD
  pages are *approximate* (50 lines ≈ one page) — the extraction mode and whether pages
  are exact are stored on the document row and surfaced by `GET /documents/:id`.
- **Sentence-aware chunking** keeps answers quotable: no chunk begins mid-sentence, which
  matters because extractive answers quote whole sentences from chunk text.
- **Offline embeddings.** Without an API key we use signed FNV-1a feature hashing
  (`EMBEDDING_PROVIDER=hashing`): deterministic, dependency-free, 1536-d to match the
  production dimension. It captures lexical overlap (unigram + bigram weights), i.e. it is
  a *lexical* retriever, not a semantic one — honest limitation, quantified in
  `docs/EVALUATION.md`. `EMBEDDING_PROVIDER=openai` swaps in `text-embedding-3-small`
  when `OPENAI_API_KEY` is present; dimension must stay 1536 because the column is
  `vector(1536)`.

---

## 3. Storage schema (migration 001)

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `users` | accounts | `email UNIQUE`, `password_hash` (scrypt), `role` (`user`/`admin`) |
| `documents` | uploaded files (per-user private) | `owner_id`, `pages`, `chunk_count`, `extract_kind`, `pages_exact` |
| `chunks` | retrieval units | `content`, `page`, `embedding vector(1536)` + **HNSW** (cosine), `tsv tsvector` + GIN |
| `answer_cache` | normalized answers | `question_hash` (sha256, **unique per user**), `question`, `answer`, `answer_mode`, `citations jsonb`, `hit_count` |
| `usage_counters` | daily query quota | PK `(user_id, day)` — the uniqueness makes the limit check **atomic** |
| `answer_feedback` | thumbs | one row per user+answer, upserted |

`org_id` columns exist on `documents`/`chunks` for future multi-tenancy; today the
ownership filter is `user_id` (see §6).

Embedding index: **HNSW** (`vector_cosine_ops`) — better recall/latency trade-off than IVFFlat
for a dataset that grows after index creation. Keyword index: GIN over `tsv`.

---

## 4. Query path

```
POST /chat { question, documentIds?, topK=4 }
   │
   ├─ auth guard (JWT) → user id + role
   ├─ zod validation (question 3..1000 chars)
   ├─ atomic daily-limit check:  INSERT … ON CONFLICT DO UPDATE
   │      WHERE used < limit  RETURNING used   → 429 daily_limit_exceeded
   ├─ cache lookup: sha256(normalized question) unique per user
   │      found → return with cached:true, hit_count++   (no embedding work)
   ▼
retrieval/search.ts
   qVec = embed(question)                       (hashing or openai)
   A = top 40 BY embedding <=> qVec             (pgvector cosine)
   B = top 40 BY ts_rank(tsv, query)            (Postgres full-text)
   fused = RRF(A, B)  →  take topK
   ▼
answer
   extractive → score sentences of fused chunks (§5)
   llm        → OpenAI chat over fused chunks (only if OPENAI_API_KEY)
   ▼
upsert answer_cache (hit_count = 1), insert chat + chat_messages, return JSON
```

### Reciprocal Rank Fusion

```
score(chunk) = Σ_lists  1 / (k + rank_list(chunk))      k = 60
```

RRF ignores the absolute scale of each list (cosine ~0–1 vs ts_rank ~1e-4), so neither
signal dominates by magnitude — only by *rank*. A chunk retrieved at rank 1 by either
searcher scores `1/61 ≈ 0.0164`; a chunk ranked 40th by both scores `2/100 = 0.0200`,
so agreement across signals beats a single strong signal at low rank only when ranks are
close — in practice top hits from either list survive fusion, which is exactly the desired
recall behaviour for mixed paraphrase/exact-match questions.

`documentIds` narrows both searches to a subset (`ANY($3)`) before fusion — filtering
happens in SQL, not after, so topK remains meaningful.

---

## 5. Answer synthesis (extractive mode)

1. Take fused chunks in order; split into sentences (regex splitter aware of
   abbreviations, decimals, and quotes).
2. Score each sentence:
   `score = 0.65 · queryCoverage + 0.35 · (chunkRankBonus) (+0.05 if it contains a number)`
   where coverage = (matched query tokens, stopwords removed) / distinct query tokens,
   and `chunkRankBonus = (topK − chunkRank) / topK` — higher-ranked chunks win ties.
3. Keep sentences with **≥ 1 matched token** (a stricter ≥ 2 gate measurably hurt
   recall: answer Hit@3 fell 95.3% → 90.0% in evaluation, so it was rejected).
4. Order selected sentences by *chunk rank* (not by score) so the narrative follows the
   document's own ordering, take the top 4 by relevance first, dedupe by content.
5. Append `[source: file, p.N]` markers and map each contributing sentence back to a
   citation object `{ document, page, snippet, score }`.

Retrieval-level evaluation (Hit@3, page accuracy) counts a hit when a gold page appears in
the **first** retrieval results, independent of sentence selection — that separation is why
both numbers are reported in `docs/EVALUATION.md`.

---

## 6. Multi-tenancy, auth, limits

- **Registration** creates `role: 'user'`; the first registered account is promoted to
  `admin` (bootstrap, mirrors the demo flow). scrypt (N=16384) hashes passwords with
  per-user random salts; JWT (HS256, 12 h) carries `{ sub, role }`.
- Every documents/chats query filters by `owner_id` / `user_id` from the token — never
  from the request body. `documentIds` in a chat request are re-checked against ownership;
  foreign or unknown ids → `403 foreign_document`, so probing other users' ids is refused.
- **Rate limit**: `MAX_QUERIES_PER_DAY` (default 100). The gate runs *before* embedding
  work inside `withUsageSlot`, which wraps cache lookup + retrieval + cache insert —
  concurrent requests cannot slip past the quota. Exceeding → `429 daily_limit_exceeded`
  with the configured limit echoed in the message.
- **Admin aggregation**: `GET /admin/feedback` joins feedback → chats → documents to
  return totals, up/down rates, and the documents with the most negative feedback;
  `requireRole('admin')` guards both admin routes (403 for regular users).

---

## 7. Caching

`answer_cache` is keyed by `(user_id, sha256(normalize(question)))`:

- **Normalize**: lowercase + collapse whitespace → `"What  is the capital"`,
  `"what is the capital"`, and trailing whitespace share one entry.
- **Cross-request reuse**: a repeat returns `cached: true` with the original answer and
  increments `hit_count` (single-statement `UPDATE … RETURNING`), while a fresh answer
  inserts with `hit_count = 1`. Both code paths converge on one `INSERT … ON CONFLICT`.
- Cached answers keep their `answer_mode`, so an extractive answer is never relabelled.
- Redis is on the roadmap; today Postgres *is* the cache and it is measured in the demo
  (repeat read is faster and `hit_count` visibly increments).

---

## 8. Error model & observability

- Consistent JSON: `{ error: <machine_code>, message: <human text> }` with proper status
  codes (400 validation, 401 auth, 403 ownership/role, 404, 409 duplicate, 413 too large,
  415 bad type, 429 limit, 503 db down).
- `GET /healthz` — process liveness. `GET /readyz` — runs a real `SELECT 1` against the
  pool; Docker healthcheck and `depends_on: service_healthy` gate startup on it.
- pino JSON logs with request ids; every chat response carries `latencyMs`.

---

## 9. Deployment

Multi-stage `Dockerfile`:

1. `deps` — `npm ci`
2. `build` — `tsc` → `dist/`
3. `prod` — production deps only, `USER node` (non-root), `NODE_ENV=production`,
   `EXPOSE 3200`, `HEALTHCHECK` on `/healthz`

`docker-compose.yml` starts `postgres` (`pgvector/pgvector:pg16`, volume, healthcheck on
`pg_isready`) and `app` (`build: .`, `depends_on: service_healthy`, ports `3200:3200`,
`5434:5432`, env for `JWT_SECRET`, `MAX_QUERIES_PER_DAY`, optional `OPENAI_API_KEY`).
Migrations run automatically at startup (`runMigrations()` before `listen`), idempotently
guarded by `schema_migrations`.
