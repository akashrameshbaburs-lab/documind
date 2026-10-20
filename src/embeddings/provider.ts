/**
 * Embedding provider interface.
 *
 * Two implementations exist behind this interface:
 *   1. HashingEmbeddingProvider - deterministic feature hashing, fully offline.
 *   2. OpenAIEmbeddingProvider  - text-embedding-3-small via the OpenAI REST API.
 *
 * Both emit exactly 1536-dimension, L2-normalized vectors so they are
 * interchangeable in the vector(1536) pgvector columns.
 */
export interface EmbeddingProvider {
  readonly name: "hashing" | "openai";
  embedTexts(texts: string[]): Promise<number[][]>;
}

/** Serialize a vector into the pgvector text literal form: [0.1,0.2,...] */
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v : 0).toFixed(6)).join(",")}]`;
}
