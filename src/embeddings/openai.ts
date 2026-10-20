import { config } from "../config";
import { HttpError } from "../httpError";
import type { EmbeddingProvider } from "./provider";

/**
 * OpenAI embedding provider (used only when OPENAI_API_KEY is set at runtime).
 * Calls the REST API directly with global fetch - no SDK dependency needed.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: config.OPENAI_EMBEDDING_MODEL, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(502, `openai embedding request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
