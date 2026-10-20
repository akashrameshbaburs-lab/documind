import { config, EMBEDDING_DIM } from "../config";
import { HttpError } from "../httpError";
import type { EmbeddingProvider } from "./provider";

/**
 * Local GPU embedding provider.
 *
 * Talks to the self-hosted GPU sidecar (./gpu-inference inside this repo),
 * which serves sentence-transformers/all-MiniLM-L6-v2 on the machine's GPU via
 * an OpenAI-compatible /v1/embeddings endpoint.
 *
 * The model emits 384-dim vectors while the database columns are fixed at
 * vector(1536). We bridge the two with a deterministic signed random projection
 * (the same trick the hashing provider uses): each 384-dim source axis maps to
 * a fixed set of 1536 output axes with a stable +/- sign derived from a seeded
 * PRNG. Randomized projections approximately preserve cosine similarity
 * (Johnson-Lindenstrauss), and because the projection matrix is deterministic it
 * is consistent across ingestion and query time.
 */
export class GpuEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gpu" as const;

  private projection: Array<{ target: number; sign: number }>[] | null = null;

  /** Lazily build the deterministic 384 -> 1536 projection matrix. */
  private getProjection(sourceDim: number): Array<{ target: number; sign: number }>[] {
    if (this.projection && this.projection.length === sourceDim) return this.projection;

    // Deterministic PRNG (mulberry32) seeded by a constant so the projection is
    // reproducible across processes and restarts.
    let state = 0x9e3779b9;
    const rand = (): number => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const perSourceAxis = Math.max(1, Math.round(EMBEDDING_DIM / sourceDim));
    const matrix: Array<{ target: number; sign: number }>[] = [];
    for (let i = 0; i < sourceDim; i++) {
      const entries: Array<{ target: number; sign: number }> = [];
      for (let k = 0; k < perSourceAxis; k++) {
        entries.push({
          target: Math.floor(rand() * EMBEDDING_DIM),
          sign: rand() < 0.5 ? -1 : 1,
        });
      }
      matrix.push(entries);
    }
    this.projection = matrix;
    return matrix;
  }

  private project(vector: number[]): number[] {
    const matrix = this.getProjection(vector.length);
    const out = new Array<number>(EMBEDDING_DIM).fill(0);
    for (let i = 0; i < vector.length; i++) {
      const value = vector[i];
      if (!Number.isFinite(value)) continue;
      for (const { target, sign } of matrix[i]) {
        out[target] += sign * value;
      }
    }
    // Re-normalize so cosine distance stays meaningful in the projected space.
    let norm = 0;
    for (const v of out) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < out.length; i++) out[i] /= norm;
    }
    return out;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = config.GPU_INFERENCE_URL;
    if (!url) {
      throw new HttpError(503, "GPU_INFERENCE_URL is not configured", "gpu_not_configured");
    }
    const base = url.replace(/\/$/, "");
    let res: Response;
    try {
      res = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: texts }),
      });
    } catch {
      // Connection-level failure: surface it as a typed error instead of a
      // generic 500 (the sidecar may be stopped or the URL misconfigured).
      throw new HttpError(
        502,
        "gpu-inference sidecar unreachable - check GPU_INFERENCE_URL and that the sidecar stack is running",
        "gpu_unreachable"
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(
        502,
        `gpu-inference embedding request failed (${res.status}): ${body.slice(0, 300)}`
      );
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };
    if (!json.data?.length) {
      throw new HttpError(502, "gpu-inference returned no embeddings");
    }

    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => (d.embedding.length === EMBEDDING_DIM ? d.embedding : this.project(d.embedding)));
  }
}
