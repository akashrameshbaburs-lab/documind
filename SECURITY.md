# Security Policy

## Scope

DocuMind AI is a portfolio RAG platform intended to run **locally via Docker**.
Its defining property is that it works **fully offline**: documents, embeddings,
and (in GPU mode) LLM inference never leave your machine.

## Supported versions

Only the latest commit on `main` receives fixes.

## Data-handling model

- **Extractive/GPU mode**: no external network calls at all. Documents, vectors,
  and answers stay inside the local Postgres + app containers.
- **OpenAI mode (opt-in)**: setting `OPENAI_API_KEY` sends chunk text and
  questions to OpenAI. Leave the key unset to keep everything local — the app
  refuses to start if no provider is configured.
- The GPU sidecar publishes `http://localhost:8100` on the host for
  benchmarking; inside the stack it is only reachable at `gpu:8100` on the
  internal compose network. Do not publish it further.

## Production-hardening checklist

The `.env.example` values are development defaults. Before using any of this
outside a local demo, change at least:

| Variable | Why |
| --- | --- |
| `JWT_SECRET` | Dev default is public in this repo; token forgery otherwise |
| `ADMIN_EMAIL` / admin bootstrap password | Change the first-login admin credentials |
| `UPLOAD_MAX_MB` / `MAX_QUERIES_PER_DAY` | Abuse limits — tune for your users |
| `DATABASE_URL` | Dev credentials are public in this repo |

Additional notes:

- Uploaded documents are PII-adjacent: `DELETE /api/docs/:id` removes the
  document, its chunks, and its vectors.
- PDF extraction runs inside the container with size limits; no document
  content is ever logged (logs record names, page/chunk counts, latencies).

## Reporting a vulnerability

Please open a GitHub issue describing the issue and steps to reproduce. Issues
labeled `security` take priority.
