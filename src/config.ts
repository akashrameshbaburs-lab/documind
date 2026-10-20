import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3200),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://documind:documind@localhost:5434/documind"),
  JWT_SECRET: z.string().min(8).default("dev-insecure-jwt-secret-change-me"),
  ADMIN_EMAIL: z.string().email().default("admin@documind.local"),
  MAX_QUERIES_PER_DAY: z.coerce.number().int().positive().default(100),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(15),
  LOG_LEVEL: z.string().default("info"),
  // Optional LLM provider. When unset the app runs in offline extractive mode.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  // Self-hosted GPU inference sidecar (OpenAI-compatible). When set, DocuMind
  // uses local GPU embeddings + a local generative model instead of OpenAI.
  GPU_INFERENCE_URL: z.string().optional(),
  GPU_CHAT_MODEL: z.string().default("Qwen/Qwen2.5-1.5B-Instruct"),
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

/** Fixed vector width. The hashing provider and text-embedding-3-small both emit 1536 dims. */
export const EMBEDDING_DIM = 1536;

/** True when an OpenAI key is configured; drives embeddings + generative answers. */
export const llmEnabled = (): boolean => Boolean(config.OPENAI_API_KEY && config.OPENAI_API_KEY.length > 0);

/** True when the local GPU inference sidecar is configured. */
export const gpuEnabled = (): boolean => Boolean(config.GPU_INFERENCE_URL && config.GPU_INFERENCE_URL.length > 0);

export type AnswerMode = "llm" | "extractive" | "gpu";

/**
 * Provider selection, in priority order:
 *   1. GPU  - local self-hosted inference (no API cost, data stays on-machine)
 *   2. LLM  - OpenAI when an API key is present
 *   3. Extractive - fully offline deterministic fallback
 */
export const answerMode = (): AnswerMode => (gpuEnabled() ? "gpu" : llmEnabled() ? "llm" : "extractive");

export const embeddingProviderName = (): "openai" | "gpu" | "hashing" =>
  gpuEnabled() ? "gpu" : llmEnabled() ? "openai" : "hashing";
