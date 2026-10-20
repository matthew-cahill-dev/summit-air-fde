import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of "Authorization: Bearer <secret>". Both sides are
 * hashed first so the comparison length doesn't leak the secret's length.
 */
export function isAuthorizedBearer(authorizationHeader: string | null, secret: string): boolean {
  if (!authorizationHeader || !secret) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const presented = match ? match[1].trim() : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b) && presented.length > 0;
}
