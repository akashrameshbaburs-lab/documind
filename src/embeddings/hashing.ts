import { EMBEDDING_DIM } from "../config";
import { features } from "../text";
import type { EmbeddingProvider } from "./provider";

/** 32-bit FNV-1a - small, fast, deterministic across platforms. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Offline feature-hashing embedding.
 *
 * The bag of features = unigrams + bigrams of normalized content tokens.
 * Each feature is signed-hashed into one of 1536 buckets:
 *   bucket = fnv1a(feature) mod 1536
 *   sign   = +1 / -1 taken from an independent hash (reduces systematic bias)
 *   weight = 1.0 for unigrams, 0.7 for bigrams (bigrams carry phrase signal)
 * The final vector is L2-normalized, so cosine similarity reduces to the dot
 * product. Deterministic: the same text always maps to the same vector with
 * no network calls, which makes offline mode fully reproducible.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashing" as const;

  embedOne(text: string): number[] {
    const vec: number[] = Array.from({ length: EMBEDDING_DIM }, () => 0);
    const { unigrams, bigrams } = features(text);

    for (const tok of unigrams) {
      const h1 = fnv1a(`u:${tok}`);
      const bucket = h1 % EMBEDDING_DIM;
      const sign = fnv1a(`s:${tok}`) & 1 ? 1 : -1;
      vec[bucket] += sign * 1.0;
    }
    for (const bg of bigrams) {
      const h1 = fnv1a(`b:${bg}`);
      const bucket = h1 % EMBEDDING_DIM;
      const sign = fnv1a(`s:${bg}`) & 1 ? 1 : -1;
      vec[bucket] += sign * 0.7;
    }

    // Fall back to the raw (lowercased) text if everything was filtered out,
    // so we never divide by zero below.
    if (vec.every((v) => v === 0)) {
      const h1 = fnv1a(`u:${text.toLowerCase().trim()}`);
      vec[h1 % EMBEDDING_DIM] += 1;
    }

    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}
