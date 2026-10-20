import { pool } from "../db/pool";
import { toPgVectorLiteral } from "../embeddings/provider";

export interface RetrievalHit {
  chunkId: number;
  docId: string;
  fileName: string;
  page: number;
  content: string;
  cos: number; // raw cosine similarity from pgvector (0..1)
  tsRank: number; // raw ts_rank from Postgres full-text search
  fused: number; // fused score in (0..1], 1.0 = ranked #1 in both channels
  rank: number; // final 1-based rank
}

/**
 * Hybrid retrieval.
 *
 * Two candidate channels are queried independently inside the *target document
 * set only* (set scoping is the SQL WHERE clause - cross-set leakage is
 * impossible at this layer):
 *
 *   A) vector channel: pgvector cosine distance (`<=>`) over vector(1536)
 *   B) full-text channel: `tsv @@ plainto_tsquery('english', q)` ranked by ts_rank
 *
 * Fusion (Reciprocal Rank Fusion, RRF, k=60):
 *   fused(c) = 1/(k + rankA(c)) + 1/(k + rankB(c))        (missing list => 0)
 *   normalized so the theoretical max 2/(k+1) maps to 1.0
 *
 * RRF is scale-free: it does not need to normalize incomparable raw scores
 * (cosine similarity vs ts_rank), only the ranks, which makes it robust when
 * one channel has no matches at all.
 */
export async function hybridSearch(
  setId: string,
  queryVector: number[],
  queryText: string,
  topK = 8,
  candidateLimit = 100,
  rrfK = 60
): Promise<RetrievalHit[]> {
  const vecLiteral = toPgVectorLiteral(queryVector);

  const vecRes = await pool.query<{ id: string; doc_id: string; file_name: string; page: number; content: string; cos: number }>(
    `SELECT c.id, c.doc_id, d.file_name, c.page, c.content,
            1 - (c.embedding <=> $1::vector) AS cos
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id
      WHERE c.set_id = $2 AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    [vecLiteral, setId, candidateLimit]
  );

  const ftsRes = await pool.query<{ id: string; tr: number }>(
    `SELECT c.id, ts_rank(c.tsv, q) AS tr
       FROM chunks c, plainto_tsquery('english', $1) q
      WHERE c.set_id = $2 AND c.tsv @@ q
      ORDER BY tr DESC
      LIMIT $3`,
    [queryText, setId, candidateLimit]
  );

  // Reciprocal rank fusion.
  const fused = new Map<number, number>();
  vecRes.rows.forEach((r, i) => fused.set(Number(r.id), 1 / (rrfK + (i + 1))));
  ftsRes.rows.forEach((r, i) => {
    const id = Number(r.id);
    fused.set(id, (fused.get(id) ?? 0) + 1 / (rrfK + (i + 1)));
  });

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  if (ranked.length === 0) return [];

  const details = await pool.query<{
    id: string;
    doc_id: string;
    file_name: string;
    page: number;
    content: string;
    cos: number | null;
  }>(
    `SELECT c.id, c.doc_id, d.file_name, c.page, c.content,
            1 - (c.embedding <=> $2::vector) AS cos
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id
      WHERE c.id = ANY($1::bigint[])`,
    [ranked.map(([id]) => id), vecLiteral]
  );
  const byId = new Map(details.rows.map((r) => [Number(r.id), r]));

  const tsById = new Map<number, number>(ftsRes.rows.map((r) => [Number(r.id), r.tr]));
  const maxFused = 2 / (rrfK + 1);

  return ranked.map(([id, score], i) => {
    const d = byId.get(id);
    if (!d) throw new Error(`chunk ${id} vanished between retrieval and detail fetch`);
    return {
      chunkId: id,
      docId: d.doc_id,
      fileName: d.file_name,
      page: d.page,
      content: d.content,
      cos: d.cos ?? 0,
      tsRank: tsById.get(id) ?? 0,
      fused: Math.min(score / maxFused, 1),
      rank: i + 1,
    };
  });
}
