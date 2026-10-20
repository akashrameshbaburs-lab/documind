import type { PoolClient } from "pg";
import { getEmbeddingProvider } from "../embeddings";
import { toPgVectorLiteral } from "../embeddings/provider";
import { pool, withTransaction } from "../db/pool";
import { HttpError } from "../httpError";
import { chunkDocument } from "./chunk";
import { extractDocument, kindFromExt } from "./extract";

export interface IngestedFile {
  fileId: string;
  name: string;
  pages: number;
  chunks: number;
}

const EMBED_BATCH = 64;

/**
 * Full ingestion pipeline for one uploaded file:
 *   extract -> chunk (page-attributed) -> embed -> store (transactional).
 * All chunks are inserted inside a single transaction together with the
 * document row, so a failed file never leaves partial data behind.
 */
export async function ingestFile(
  ownerId: string,
  setId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string }
): Promise<IngestedFile> {
  const name = file.originalname;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const kind = kindFromExt(ext);
  if (!kind) throw new HttpError(400, `unsupported file type ".${ext}" for ${name} (allowed: pdf, docx, txt, md)`);
  if (file.buffer.length === 0) throw new HttpError(400, `file ${name} is empty`);

  const pages = await extractDocument(file.buffer, kind);
  const rawChunks = chunkDocument(pages);
  if (rawChunks.length === 0) throw new HttpError(400, `no extractable text found in ${name}`);

  return withTransaction(async (client: PoolClient) => {
    const docRes = await client.query<{ id: string }>(
      `INSERT INTO documents (set_id, file_name, ext, mime, pages)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [setId, name, kind, file.mimetype || "application/octet-stream", pages.length]
    );
    const docId = docRes.rows[0].id;

    // Batch-embed all chunks of this file.
    const provider = getEmbeddingProvider();
    const vectors: number[][] = [];
    for (let i = 0; i < rawChunks.length; i += EMBED_BATCH) {
      const batch = rawChunks.slice(i, i + EMBED_BATCH);
      const embedded = await provider.embedTexts(batch.map((c) => c.content));
      vectors.push(...embedded);
    }

    for (let i = 0; i < rawChunks.length; i++) {
      const c = rawChunks[i];
      await client.query(
        `INSERT INTO chunks (doc_id, set_id, idx, page, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [docId, setId, c.idx, c.page, c.content, toPgVectorLiteral(vectors[i])]
      );
    }

    return { fileId: docId, name, pages: pages.length, chunks: rawChunks.length };
  });
}

/** Count chunks of a set (used by admin/stats paths). */
export async function countChunks(setId: string): Promise<number> {
  const res = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks WHERE set_id = $1`, [setId]);
  return res.rows[0].n;
}
