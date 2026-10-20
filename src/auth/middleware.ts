import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../httpError";
import { verifyToken, type TokenPayload } from "./jwt";

export interface AuthUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Requires a valid `Authorization: Bearer <jwt>` header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new HttpError(401, "missing bearer token"));
  }
  try {
    const payload: TokenPayload = verifyToken(header.slice("Bearer ".length).trim());
    req.user = { id: payload.sub, email: payload.email, isAdmin: payload.isAdmin };
    next();
  } catch {
    next(new HttpError(401, "invalid or expired token"));
  }
}

/** Requires a valid token AND admin rights (email matches ADMIN_EMAIL). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user?.isAdmin) return next(new HttpError(403, "admin access required"));
    next();
  });
}
