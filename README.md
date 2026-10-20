# DocuMind AI — Document Q&A Platform (RAG)

Upload documents, ask questions in natural language, get **grounded answers with citations**
(page numbers, snippet, score) — running **fully offline** out of the box.

DocuMind is a retrieval-augmented generation (RAG) service with a REST API and a browser UI.
It extracts text from PDF/DOCX/TXT/Markdown, chunks it, embeds it into Postgres + pgvector,
and answers questions by fusing **vector similarity** with **keyword (BM25-style) search**.

When no LLM API key is configured it runs in **extractive mode** — answers are built from the
most relevant sentences of your own documents. When `OPENAI_API_KEY` is set, the same retrieval
pipeline feeds an LLM for generative answers. The response always reports which mode produced it
(`answerMode: "extractive" | "llm"`), so nothing is ever presented as "AI-generated" when it is not.

---

## Pipeline at a time

```
INGEST
  PDF/DOCX/TXT/MD ──► extract text (pdfjs-dist / mammoth, per-page)
        │
        ▼
   chunk ~1200 chars / 200 overlap, sentence-aware, page tracked
        │
        ▼
   embed 1536-d ──► pgvector (cosine) + tsvector (lexeme)   [one row per chunk]

QUERY
  question ──► embed 1536-d
        │
        ▼
   HYBRID RETRIEVE  (top 40 each, Reciprocal Rank Fusion k=60)
   ┌─────────────────────────────┬──────────────────────────────────┐
   │ pgvector cosine similarity  │ tsvector keyword rank (BM25-ish) │
   └──────────────┬──────────────┴────────────────┬─────────────────┘
                  └──────────► fused ranking ◄────┘
        │
        ▼
   ANSWER (extractive sentences  ──or──  LLM over top chunks)
        │
        ▼
   citations: [{ document, page, snippet, score }]  +  answerMode
```

```
DEPLOY (Docker Compose)
  app (:3200, non-root, multi-stage)  ──depends_on──►  postgres+pgvector (:5434, healthcheck)
```

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22, TypeScript (strict, ESM) |
| API | Express 4, zod validation, pino logging, jsonwebtoken (JWT auth) |
| Storage | PostgreSQL 16 + **pgvector** (1536-d vectors, cosine), one container |
| Search | pgvector cosine + `tsvector` rank, fused with **Reciprocal Rank Fusion** (k=60) |
| PDF / DOCX | `pdfjs-dist` (legacy build) / `mammoth`; TXT + Markdown built in |
| Embeddings | Offline signed FNV-1a feature hashing (1536-d) — no API key needed |
| Answers | Extractive sentence scoring (offline) · optional OpenAI chat (`OPENAI_API_KEY`) |
| UI | Static SPA served by Express (`/`): login/register, upload, chat, feedback |
| Testing | `demo.ps1` end-to-end suite (34 assertions), `evaluate.ts` retrieval benchmark (50 questions) |
| Ops | Docker multi-stage, non-root user, healthchecks, `depends_on: service_healthy` |

**Ports:** app `3200`, postgres `5434` (host) → `5432` (container). Nothing else is used.

---

## Quick start

### Option A — Docker (recommended)

```powershell
docker compose up --build -d
# wait for healthy, then:
.\scripts\demo.ps1            # end-to-end proof: 34 assertions
```

Open **http://localhost:3200**, register, upload documents, ask questions.

### Option B — local dev (Postgres in Docker, app on Node)

```powershell
docker compose up -d postgres
npm ci
Copy-Item .env.example .env   # adjust if needed
npm run build
npm run migrate
npm run dev                   # http://localhost:3200
```

### Seed sample documents (optional)

```powershell
npm run generate:samples      # writes eval/docs/world-facts.pdf (PDFKit)
```

### Environment

Copy `.env.example` to `.env`. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `DATABASE_URL` | `3200` / local socket | Service + database |
| `JWT_SECRET` | dev fallback | **Set this in production** |
| `OPENAI_API_KEY` | *(unset)* | Enables `answerMode: "llm"`; unset = offline extractive |
| `EMBEDDING_PROVIDER` | `hashing` | `hashing` (offline) or `openai` (1536-d, needs key) |
| `MAX_QUERIES_PER_DAY` | `100` | Per-user daily question limit → HTTP 429 |

---

## API

All routes except `GET /healthz`, `GET /readyz`, `POST /auth/register`, `POST /auth/login`
require `Authorization: Bearer <JWT>`.

| Method & path | Purpose |
| --- | --- |
| `GET /healthz` / `GET /readyz` | Liveness / database readiness |
| `POST /auth/register` · `POST /auth/login` | Create account (role `user`/`admin`), get JWT (12 h) |
| `GET /me` | Current user + remaining quota |
| `POST /documents` | Multipart upload (`files`), extract → chunk → embed → store |
| `GET /documents` · `GET /documents/:id` · `DELETE /documents/:id` | List / inspect / delete own documents |
| `POST /chat` | `{ question, documentIds?, topK? }` → answer + citations + `answerMode` |
| `GET /chats` · `GET /chats/:id` | Chat history with cached answers |
| `POST /chats/:id/feedback` | Thumbs up/down on an answer |
| `GET /admin/feedback` | Admin-only aggregation (counts, rates, top failing docs) |
| `GET /admin/usage` · `GET /admin/usage/summary` | Admin-only per-user usage and daily trend |

### Example

```powershell
$tok = (Invoke-RestMethod http://localhost:3200/auth/login `
  -Method Post -ContentType application/json `
  -Body '{"email":"demo@example.com","password":"password123"}').token

Invoke-RestMethod http://localhost:3200/chat -Method Post `
  -ContentType "application/json" -Headers @{ Authorization = "Bearer $tok" } `
  -Body '{"question":"What is the capital of France?","topK":4}'
```

```json
{
  "answer": "Paris is the capital and largest city of France. [source: world-facts.pdf, p.1]",
  "answerMode": "extractive",
  "citations": [
    { "document": "world-facts.pdf", "page": 1, "snippet": "Paris is the capital and largest city of France…", "score": 0.4521 }
  ],
  "cached": false,
  "latencyMs": 5
}
```

---

## Two answer modes — honest by design

| | **Extractive (default, offline)** | **LLM (`OPENAI_API_KEY` set)** |
| --- | --- | --- |
| How | Sentences from your documents scored by query-term coverage + retrieval rank; the best 3–5 are returned in order | OpenAI chat completion over the fused top chunks |
| Grounding | Every sentence is quoted verbatim from a source chunk → citations are exact | Citations come from retrieved chunk metadata |
| Needs network / key | **No** — runs 100 % offline | Yes |
| Reported as | `answerMode: "extractive"` | `answerMode: "llm"` |

The service never fabricates an "LLM answer" when no LLM ran.

### How hybrid retrieval works

Each query is executed twice against the *same* candidate set:

1. **Vector search** — cosine similarity between the query embedding and chunk embeddings (pgvector).
2. **Keyword search** — Postgres full-text ranking over the `tsvector` column (lexemes + frequencies).

Both lists are merged with **Reciprocal Rank Fusion** (RRF), the standard score-agnostic blend:

```
fused(chunk) = Σ  1 / (k + rank_list(chunk))       k = 60
```

Ranks come from each list's own ordering, so a chunk that ranks top-3 in *either* signal
survives fusion even if the other signal ranks it lower. The top `topK` (default 4) fused
chunks become the answer's context. This is why DocuMind finds both paraphrases
("population" ≈ "how many people") and exact terms ("treaty", "3.4%") in one pass.

---

## Evaluation

`npm run evaluate` runs a 50-question gold set (`eval/questions.json`) against two generated
sample documents (`eval/docs/world-facts.pdf`, `eval/docs/field-notes.md`) and writes real
numbers to [`docs/EVALUATION.md`](docs/EVALUATION.md).

Latest run (**extractive mode, offline hashing embeddings**):

| Metric | Result |
| --- | --- |
| Hit@3 (gold document in top 3) | **100.0 %** (50/50) |
| Page accuracy (correct page in top 3) | **100.0 %** (50/50) |
| Answer Hit@3 (answer text drawn from gold doc) | **100.0 %** |
| Keyword coverage (gold keywords present in answer) | **96.0 %** (100 % of questions ≥ 50 %) |
| Mean latency / p95 | **5 ms / 11 ms** |
| Cache verification | pass (repeat query served from `answer_cache`) |

The end-to-end suite `.\scripts\demo.ps1` asserts **34** behaviours: auth, upload, chunking,
chat + citations, answer caching (hit counter + faster second read), feedback + admin
aggregation, per-user isolation, cross-user 401/403, non-admin 403, and the daily query
limit (429).

```powershell
.\scripts\demo.ps1      # expected: ALL 34 CHECKS PASSED
```

---

## Not implemented on purpose (roadmap)

These are **planned, not present** — no stubs, no pretend features:

- **OCR for scanned PDFs / images** (tesseract) — extraction currently needs a text layer.
- **Redis** answer cache — the cache is Postgres-backed today (`answer_cache` table).
- OpenAI embeddings / LLM answers are implemented but **opt-in** and disabled by default
  so the whole system runs offline.

---

## Project layout

```
documind/
├─ src/
│  ├─ index.ts            # Express app + routes
│  ├─ db/                 # pool, migrations, schema
│  ├─ auth/               # scrypt hashing, JWT, roles, guards
│  ├─ ingest/             # extract.ts (pdf/docx/txt/md) + chunk.ts (sentence-aware)
│  ├─ embeddings/         # hashing.ts (offline 1536-d) + openai.ts (opt-in)
│  ├─ retrieval/search.ts # hybrid vector+keyword + RRF fusion
│  ├─ answer/extractive.ts# offline grounded answers
│  ├─ services/           # documents, chat (cache/limits/feedback)
│  └─ routes/             # auth, documents, chat, admin, health
├─ public/                # browser UI (index.html, app.js, styles.css)
├─ scripts/               # demo.ps1 (e2e), evaluate.ts (benchmark), generate-samples.js
├─ eval/                  # questions.json (50) + generated sample documents
├─ docs/                  # ARCHITECTURE.md, EVALUATION.md
├─ Dockerfile             # multi-stage, non-root
└─ docker-compose.yml     # app + pgvector, healthchecks, service_healthy
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Benchmark data: [`docs/EVALUATION.md`](docs/EVALUATION.md)

---

## License

MIT.
