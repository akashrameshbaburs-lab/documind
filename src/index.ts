import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { config } from "./config";
import { logger } from "./logger";
import { migrateWithRetry } from "./db/migrate";
import { HttpError } from "./httpError";
import { authRouter } from "./routes/auth";
import { docsRouter } from "./routes/docs";
import { chatRouter } from "./routes/chat";
import { adminRouter } from "./routes/admin";
import { healthRouter } from "./routes/health";

export function buildApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Request logging (method, path, status, duration).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info({ method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - started }, "request");
    });
    next();
  });

  app.use(healthRouter);
  app.use("/api", authRouter);
  app.use("/api", docsRouter);
  app.use("/api", chatRouter);
  app.use("/api", adminRouter);

  // Static chat UI (vanilla HTML/CSS/JS, no CDN - works fully offline).
  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  // 404 for unknown API routes.
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found", message: "unknown API route" }));

  // Central error handler -> consistent JSON error shape.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "validation_error",
        message: "request validation failed",
        details: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      return;
    }
    if (err instanceof MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: "upload_error", message: err.message });
      return;
    }
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal_error", message: "internal server error" });
  });

  return app;
}

async function main(): Promise<void> {
  await migrateWithRetry();
  const app = buildApp();
  app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, nodeEnv: config.NODE_ENV, maxQueriesPerDay: config.MAX_QUERIES_PER_DAY },
      "DocuMind AI listening"
    );
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, "failed to start");
    process.exit(1);
  });
}
