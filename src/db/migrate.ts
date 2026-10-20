import { pool } from "./pool";
import { logger } from "../logger";

/**
 * Idempotent schema migration, executed at application startup.
 * Postgres 16 + pgvector. All vector columns are vector(1536) and are
 * compared with the cosine distance operator `<=>`.
 */
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doc_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id     uuid NOT NULL REFERENCES doc_sets(id) ON DELETE CASCADE,
  file_name  text NOT NULL,
  ext        text NOT NULL,
  mime       text NOT NULL,
  pages      int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id        bigserial PRIMARY KEY,
  doc_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  set_id    uuid NOT NULL REFERENCES doc_sets(id) ON DELETE CASCADE,
  idx       int NOT NULL,
  page      int NOT NULL,
  content   text NOT NULL,
  tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS idx_chunks_set   ON chunks(set_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc   ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv   ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_emb   ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS answer_cache (
  set_id      uuid NOT NULL REFERENCES doc_sets(id) ON DELETE CASCADE,
  qhash       text NOT NULL,
  question    text NOT NULL,
  answer      text NOT NULL,
  citations   jsonb NOT NULL DEFAULT '[]',
  answer_mode text NOT NULL,
  hits        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, qhash)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  queries int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS chat_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id      uuid NOT NULL REFERENCES doc_sets(id) ON DELETE CASCADE,
  question    text NOT NULL,
  answer      text NOT NULL,
  answer_mode text NOT NULL,
  latency_ms  int NOT NULL,
  cached      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_logs_user ON chat_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  chat_id    uuid PRIMARY KEY REFERENCES chat_logs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thumbs     int NOT NULL CHECK (thumbs IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Wait for Postgres to accept connections (compose already gates on healthcheck; this covers host runs). */
export async function migrateWithRetry(attempts = 20, delayMs = 1500): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(SCHEMA_SQL);
      logger.info("database schema ready");
      return;
    } catch (err) {
      lastError = err;
      logger.warn({ attempt: i, err: (err as Error).message }, "database not ready, retrying");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
