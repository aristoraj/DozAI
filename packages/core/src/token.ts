// Session tokens: the runtime adapter mints one per case session; the MCP gateway verifies it.
// A token binds a session to exactly one tenant + case, so a tool can never be pointed elsewhere.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ToolSession } from "./tools";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function mintSessionToken(secret: string, s: ToolSession, ttlSeconds = 3600, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...s, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySessionToken(secret: string, token: string, now = Date.now()): ToolSession | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as ToolSession & { exp: number };
    if (p.exp * 1000 < now) return null;
    const { exp: _exp, ...session } = p;
    return session;
  } catch {
    return null;
  }
}
