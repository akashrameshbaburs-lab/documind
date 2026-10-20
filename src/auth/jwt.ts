import jwt from "jsonwebtoken";
import { config } from "../config";

export interface TokenPayload {
  sub: string; // user id
  email: string;
  isAdmin: boolean;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
}
