import { llmEnabled } from "../config";
import { HashingEmbeddingProvider } from "./hashing";
import { OpenAIEmbeddingProvider } from "./openai";
import type { EmbeddingProvider } from "./provider";

let instance: EmbeddingProvider | null = null;

/** Returns the active embedding provider (switches on OPENAI_API_KEY at runtime). */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!instance) {
    instance = llmEnabled() ? new OpenAIEmbeddingProvider() : new HashingEmbeddingProvider();
  }
  return instance;
}

export type { EmbeddingProvider } from "./provider";
export { toPgVectorLiteral } from "./provider";
