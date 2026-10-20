import { Router } from "express";
import { answerMode, config, embeddingProviderName } from "../config";
import { pool } from "../db/pool";

export const healthRouter = Router();

/** Liveness: process is up and serving HTTP. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/** Readiness: database reachable. Returns 503 when not ready (used by docker healthcheck). */
healthRouter.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready", db: true });
  } catch {
    res.status(503).json({ status: "unavailable", db: false });
  }
});

/** Public runtime configuration for the UI (no secrets). */
healthRouter.get("/api/config", (_req, res) => {
  res.json({
    answerMode: answerMode(),
    embeddingProvider: embeddingProviderName(),
    maxQueriesPerDay: config.MAX_QUERIES_PER_DAY,
    llmModel: answerMode() === "llm" ? config.OPENAI_CHAT_MODEL : null,
  });
});
