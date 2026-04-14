import { verifyHmac } from "./hmac.js";

export interface AuthResult {
  valid: boolean;
  userId?: string;
  error?: string;
}

export function validateAuth(
  authHeader: string | undefined,
  users: Record<string, string>,
  nowSeconds?: number,
): AuthResult {
  if (!authHeader) {
    return { valid: false, error: "missing Proxy-Authorization" };
  }

  const schemeMatch = authHeader.match(/^HMAC\s+(.+)$/);
  if (!schemeMatch) {
    return { valid: false, error: "invalid auth scheme" };
  }

  const parts = schemeMatch[1].split(":");
  if (parts.length !== 4) {
    return { valid: false, error: "malformed HMAC token" };
  }

  const [userId, timestamp, nonce, digest] = parts;

  const secret = users[userId];
  if (!secret) {
    return { valid: false, error: "unknown user" };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 60) {
    return { valid: false, error: "timestamp out of range" };
  }

  const message = `${timestamp}:${nonce}`;
  if (!verifyHmac(secret, message, digest)) {
    return { valid: false, error: "invalid signature" };
  }

  return { valid: true, userId };
}
