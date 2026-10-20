import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with Node's built-in scrypt (no native addon required).
 * Stored format: scrypt$<salt-hex>$<hash-hex>
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [scheme, salt, hashHex] = parts;
  if (scheme !== "scrypt" || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== 64) return false;
  const computed = scryptSync(password, salt, 64);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
