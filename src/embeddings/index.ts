import { gpuEnabled, llmEnabled } from "../config";
import { GpuEmbeddingProvider } from "./gpu";
import { HashingEmbeddingProvider } from "./hashing";
import { OpenAIEmbeddingProvider } from "./openai";
import type { EmbeddingProvider } from "./provider";

let instance: EmbeddingProvider | null = null;

/** Returns the active embedding provider (GPU > OpenAI > offline hashing). */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!instance) {
    instance = gpuEnabled()
      ? new GpuEmbeddingProvider()
      : llmEnabled()
        ? new OpenAIEmbeddingProvider()
        : new HashingEmbeddingProvider();
  }
  return instance;
}

export type { EmbeddingProvider } from "./provider";
export { toPgVectorLiteral } from "./provider";
