import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { config } from "../config";
import { pool, withTransaction } from "../db/pool";
import { HttpError } from "../httpError";
import { ingestFile } from "../ingest/ingest";

export const docsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024, files: 10 },
});

const uuidSchema = z.string().uuid();

/**
 * POST /api/docs  (multipart/form-data, field name: `files`, up to 10 files)
 * Optional text field `name` sets the document set name.
 * Returns { setId, files: [{ fileId, name, pages }] }.
 */
docsRouter.post("/docs", requireAuth, upload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) throw new HttpError(400, "no files uploaded (multipart field name must be 'files')");
    const setName = typeof req.body?.name === "string" && req.body.name.trim().length > 0
      ? req.body.name.trim().slice(0, 120)
      : `Untitled set (${new Date().toISOString().slice(0, 19).replace("T", " ")})`;

    const userId = req.user!.id;

    // Create the private set first, then ingest each file in its own transaction.
    const setRes = await pool.query<{ id: string }>(
      `INSERT INTO doc_sets (owner_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, setName]
    );
    const setId = setRes.rows[0].id;

    try {
      const ingested = [];
      for (const f of files) {
        ingested.push(await ingestFile(userId, setId, f));
      }
      res.status(201).json({
        setId,
        name: setName,
        files: ingested.map((f) => ({ fileId: f.fileId, name: f.name, pages: f.pages, chunks: f.chunks })),
      });
    } catch (err) {
      // Roll the whole set back if any file failed, so sets are all-or-nothing.
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM doc_sets WHERE id = $1`, [setId]);
      }).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** GET /api/sets - list the caller's own document sets (never other users'). */
docsRouter.get("/sets", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.created_at,
              count(DISTINCT d.id)::int                     AS files,
              COALESCE(sum(doc_chunks.n), 0)::int            AS chunks
         FROM doc_sets s
         LEFT JOIN documents d ON d.set_id = s.id
         LEFT JOIN (
           SELECT doc_id, set_id, count(*)::int AS n FROM chunks GROUP BY doc_id, set_id
         ) doc_chunks ON doc_chunks.doc_id = d.id
        WHERE s.owner_id = $1
        GROUP BY s.id, s.name, s.created_at
        ORDER BY s.created_at DESC`,
      [req.user!.id]
    );
    res.json({ sets: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/docs/:setId - owner-scoped view of one set and its files. */
docsRouter.get("/docs/:setId", requireAuth, async (req, res, next) => {
  try {
    const setId = uuidSchema.parse(req.params.setId);
    const setRes = await pool.query<{ id: string; name: string; owner_id: string }>(
      `SELECT id, name, owner_id FROM doc_sets WHERE id = $1`,
      [setId]
    );
    if (setRes.rows.length === 0) throw new HttpError(404, "document set not found");
    if (setRes.rows[0].owner_id !== req.user!.id) throw new HttpError(403, "you do not own this document set");

    const files = await pool.query(
      `SELECT d.id AS "fileId", d.file_name AS name, d.ext, d.pages,
              (SELECT count(*)::int FROM chunks c WHERE c.doc_id = d.id) AS chunks
         FROM documents d WHERE d.set_id = $1 ORDER BY d.created_at`,
      [setId]
    );
    res.json({ setId, name: setRes.rows[0].name, files: files.rows });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/docs/:setId - owner-scoped deletion (cascades to chunks + cache). */
docsRouter.delete("/docs/:setId", requireAuth, async (req, res, next) => {
  try {
    const setId = uuidSchema.parse(req.params.setId);
    const setRes = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM doc_sets WHERE id = $1`, [setId]);
    if (setRes.rows.length === 0) throw new HttpError(404, "document set not found");
    if (setRes.rows[0].owner_id !== req.user!.id) throw new HttpError(403, "you do not own this document set");
    await pool.query(`DELETE FROM doc_sets WHERE id = $1`, [setId]);
    res.json({ deleted: true, setId });
  } catch (err) {
    next(err);
  }
});
