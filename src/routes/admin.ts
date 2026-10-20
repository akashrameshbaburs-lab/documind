import { Router } from "express";
import { requireAdmin } from "../auth/middleware";
import { pool } from "../db/pool";

export const adminRouter = Router();

/**
 * GET /api/admin/feedback - aggregated thumbs feedback across all chat logs.
 * Admin-only (JWT must belong to the user matching ADMIN_EMAIL).
 */
adminRouter.get("/admin/feedback", requireAdmin, async (_req, res, next) => {
  try {
    const totals = await pool.query<{ total: number; up: number; down: number }>(
      `SELECT count(*)::int                       AS total,
              count(*) FILTER (WHERE f.thumbs = 1)::int  AS up,
              count(*) FILTER (WHERE f.thumbs = -1)::int AS down
         FROM feedback f`
    );
    // A feedback row belongs to a chat, and a chat targets a document set,
    // so aggregation is done per set name (each set typically holds related files).
    const bySet = await pool.query(
      `SELECT s.name                                     AS "setName",
              count(DISTINCT f.chat_id)::int              AS total,
              count(DISTINCT f.chat_id) FILTER (WHERE f.thumbs = 1)::int  AS up,
              count(DISTINCT f.chat_id) FILTER (WHERE f.thumbs = -1)::int AS down
         FROM feedback f
         JOIN chat_logs cl ON cl.id = f.chat_id
         JOIN doc_sets s ON s.id = cl.set_id
        GROUP BY s.name
        ORDER BY total DESC
        LIMIT 20`
    );
    const recent = await pool.query(
      `SELECT f.chat_id AS "chatId", cl.question, f.thumbs, f.created_at AS "createdAt"
         FROM feedback f
         JOIN chat_logs cl ON cl.id = f.chat_id
        ORDER BY f.created_at DESC
        LIMIT 10`
    );
    const t = totals.rows[0];
    res.json({
      total: t.total,
      up: t.up,
      down: t.down,
      ratio: t.total > 0 ? Number((t.up / t.total).toFixed(3)) : null,
      bySet: bySet.rows,
      recent: recent.rows,
    });
  } catch (err) {
    next(err);
  }
});
