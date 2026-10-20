import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { pool } from "../db/pool";
import { HttpError } from "../httpError";
import { answerQuestion, getUsage } from "../services/chat";

export const chatRouter = Router();

const askSchema = z.object({
  setId: z.string().uuid(),
  question: z.string().min(3).max(2000),
});

const feedbackSchema = z.object({
  thumbs: z.union([z.literal(1), z.literal(-1)]),
});

/** POST /api/chat {setId, question} -> answer + citations + answerMode + latency + cached. */
chatRouter.post("/chat", requireAuth, async (req, res, next) => {
  try {
    const { setId, question } = askSchema.parse(req.body);
    const result = await answerQuestion(req.user!.id, setId, question.trim());
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/usage - today's query usage for the caller. */
chatRouter.get("/usage", requireAuth, async (req, res, next) => {
  try {
    res.json(await getUsage(req.user!.id));
  } catch (err) {
    next(err);
  }
});

/** GET /api/chat/history/:setId - recent questions of the caller in one set. */
chatRouter.get("/chat/history/:setId", requireAuth, async (req, res, next) => {
  try {
    const setId = z.string().uuid().parse(req.params.setId);
    const setRes = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM doc_sets WHERE id = $1`, [setId]);
    if (setRes.rows.length === 0) throw new HttpError(404, "document set not found");
    if (setRes.rows[0].owner_id !== req.user!.id) throw new HttpError(403, "you do not own this document set");
    const rows = await pool.query(
      `SELECT id, question, answer, answer_mode AS "answerMode", latency_ms AS "latencyMs",
              cached, created_at AS "createdAt"
         FROM chat_logs
        WHERE user_id = $1 AND set_id = $2
        ORDER BY created_at DESC
        LIMIT 25`,
      [req.user!.id, setId]
    );
    res.json({ history: rows.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/chat/:id/feedback {thumbs: 1 | -1} - upsert thumbs feedback. */
chatRouter.post("/chat/:id/feedback", requireAuth, async (req, res, next) => {
  try {
    const chatId = z.string().uuid().parse(req.params.id);
    const { thumbs } = feedbackSchema.parse(req.body);

    const chatRes = await pool.query<{ user_id: string }>(`SELECT user_id FROM chat_logs WHERE id = $1`, [chatId]);
    if (chatRes.rows.length === 0) throw new HttpError(404, "chat message not found");
    if (chatRes.rows[0].user_id !== req.user!.id) throw new HttpError(403, "not your chat message");

    await pool.query(
      `INSERT INTO feedback (chat_id, user_id, thumbs) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET thumbs = EXCLUDED.thumbs`,
      [chatId, req.user!.id, thumbs]
    );
    res.json({ ok: true, chatId, thumbs });
  } catch (err) {
    next(err);
  }
});
