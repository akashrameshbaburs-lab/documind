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
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

/** Fixed vector width. The hashing provider and text-embedding-3-small both emit 1536 dims. */
export const EMBEDDING_DIM = 1536;

/** True when an OpenAI key is configured; drives embeddings + generative answers. */
export const llmEnabled = (): boolean => Boolean(config.OPENAI_API_KEY && config.OPENAI_API_KEY.length > 0);

export type AnswerMode = "llm" | "extractive";

export const answerMode = (): AnswerMode => (llmEnabled() ? "llm" : "extractive");

export const embeddingProviderName = (): "openai" | "hashing" => (llmEnabled() ? "openai" : "hashing");
