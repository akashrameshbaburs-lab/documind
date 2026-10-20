import { createHash } from "node:crypto";
import { answerMode, config } from "../config";
import { pool } from "../db/pool";
import { getEmbeddingProvider } from "../embeddings";
import { HttpError } from "../httpError";
import { normalizeQuestion } from "../text";
import { buildExtractiveAnswer, type Citation } from "../answer/extractive";
import { buildLlmAnswer } from "../answer/llm";
import { buildLocalLlmAnswer } from "../answer/llmLocal";
import { hybridSearch } from "../retrieval/search";

export interface ChatResult {
  id: string;
  answer: string;
  citations: Citation[];
  answerMode: "extractive" | "llm" | "gpu";
  latencyMs: number;
  cached: boolean;
  cacheHits?: number;
}

const TOP_K = 8;

function qhash(question: string): string {
  return createHash("sha256").update(normalizeQuestion(question)).digest("hex");
}

/** Atomic per-user daily usage gate. Returns the new count, or throws 429 when exhausted. */
async function bumpUsage(userId: string): Promise<number> {
  const res = await pool.query<{ queries: number }>(
    `INSERT INTO usage_counters (user_id, day, queries)
     VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (user_id, day)
       DO UPDATE SET queries = usage_counters.queries + 1
     WHERE usage_counters.queries < $2
     RETURNING queries`,
    [userId, config.MAX_QUERIES_PER_DAY]
  );
  if (res.rows.length === 0) {
    throw new HttpError(
      429,
      `daily query limit reached (${config.MAX_QUERIES_PER_DAY} queries/day). Try again tomorrow or contact your admin.`,
      "daily_limit_exceeded"
    );
  }
  return res.rows[0].queries;
}

export async function getUsage(userId: string): Promise<{ day: string; queries: number; limit: number; remaining: number }> {
  const res = await pool.query<{ day: string; queries: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, queries
       FROM usage_counters
      WHERE user_id = $1 AND day = (now() AT TIME ZONE 'utc')::date`,
    [userId]
  );
  const queries = res.rows[0]?.queries ?? 0;
  return {
    day: res.rows[0]?.day ?? new Date().toISOString().slice(0, 10),
    queries,
    limit: config.MAX_QUERIES_PER_DAY,
    remaining: Math.max(config.MAX_QUERIES_PER_DAY - queries, 0),
  };
}

/**
 * End-to-end question answering:
 *   ownership check -> usage gate -> answer cache -> hybrid retrieval ->
 *   answer construction (extractive or LLM) -> cache + chat-log write.
 */
export async function answerQuestion(userId: string, setId: string, question: string): Promise<ChatResult> {
  const started = performance.now();

  // 1. Owner-scoped access: only the set owner may query it.
  const setRes = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM doc_sets WHERE id = $1`, [setId]);
  if (setRes.rows.length === 0) throw new HttpError(404, "document set not found");
  if (setRes.rows[0].owner_id !== userId) throw new HttpError(403, "you do not own this document set");

  // 2. Daily usage gate (counts every chat request, cached or not).
  await bumpUsage(userId);

  // 3. Answer cache: identical normalized question within the same set.
  const hash = qhash(question);
  const cachedRes = await pool.query<{ answer: string; citations: Citation[]; answer_mode: string; hits: number }>(
    `UPDATE answer_cache SET hits = hits + 1
      WHERE set_id = $1 AND qhash = $2
      RETURNING answer, citations, answer_mode, hits`,
    [setId, hash]
  );

  const mode = answerMode();

  if (cachedRes.rows.length > 0) {
    const row = cachedRes.rows[0];
    const latencyMs = Math.round(performance.now() - started);
    const id = await logChat(userId, setId, question, row.answer, mode, latencyMs, true);
    return { id, answer: row.answer, citations: row.citations, answerMode: row.answer_mode as "extractive" | "llm" | "gpu", latencyMs, cached: true, cacheHits: row.hits };
  }

  // 4. Retrieval: embed the question, then hybrid (vector + full-text) search inside the set.
  const provider = getEmbeddingProvider();
  const [queryVector] = await provider.embedTexts([question]);
  const hits = await hybridSearch(setId, queryVector, question, TOP_K);

  // 5. Answer construction.
  const extractive = buildExtractiveAnswer(question, hits);
  const citations = extractive.citations;
  let answer: string;
  if (mode === "gpu") {
    try {
      answer = await buildLocalLlmAnswer(question, hits);
    } catch {
      // Graceful degradation: local model unavailable -> quoted extractive answer.
      answer = `${extractive.answer}\n\n(Local GPU model was unavailable, so this answer was assembled extractively.)`;
    }
  } else if (mode === "llm") {
    try {
      answer = await buildLlmAnswer(question, hits);
    } catch {
      // Graceful degradation: if the LLM call fails, fall back to extractive quoting.
      answer = `${extractive.answer}\n\n(Generative mode was unavailable, so this answer was assembled extractively.)`;
    }
  } else {
    answer = extractive.answer;
  }

  const latencyMs = Math.round(performance.now() - started);

  // 6. Persist cache entry + chat log.
  await pool.query(
    `INSERT INTO answer_cache (set_id, qhash, question, answer, citations, answer_mode, hits)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 0)
     ON CONFLICT (set_id, qhash) DO UPDATE SET hits = answer_cache.hits + 1`,
    [setId, hash, question, answer, JSON.stringify(citations), mode]
  );
  const id = await logChat(userId, setId, question, answer, mode, latencyMs, false);

  return { id, answer, citations, answerMode: mode, latencyMs, cached: false };
}

async function logChat(
  userId: string,
  setId: string,
  question: string,
  answer: string,
  mode: string,
  latencyMs: number,
  cached: boolean
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO chat_logs (user_id, set_id, question, answer, answer_mode, latency_ms, cached)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, setId, question, answer, mode, latencyMs, cached]
  );
  return res.rows[0].id;
}
