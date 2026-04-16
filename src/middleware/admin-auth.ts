import type { Context, Next } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe admin token verification.
 * Hashes both user input and the real token with SHA-256 to ensure a fixed length,
 * then uses Node's crypto.timingSafeEqual() to prevent timing attacks.
 */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function adminAuth(token: string) {
  return async (c: Context, next: Next) => {
    const provided = c.req.header("X-Admin-Token") ?? "";
    if (!provided || !safeEqual(provided, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
