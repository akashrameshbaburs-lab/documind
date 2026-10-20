import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { HttpError } from "../httpError";
import { hashPassword, verifyPassword } from "../auth/password";
import { signToken } from "../auth/jwt";
import { requireAuth } from "../auth/middleware";
import { config } from "../config";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const { email, password } = credentialsSchema.parse(req.body);
    const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (existing.rows.length > 0) throw new HttpError(409, "email already registered");
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email.toLowerCase(), hashPassword(password)]
    );
    res.status(201).json({ id: result.rows[0].id, email: email.toLowerCase() });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid email or password");
    const { email, password } = parsed.data;
    const result = await pool.query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    const row = result.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, "invalid email or password");
    }
    const isAdmin = row.email === config.ADMIN_EMAIL;
    const token = signToken({ sub: row.id, email: row.email, isAdmin });
    res.json({ token, user: { id: row.id, email: row.email, isAdmin } });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
