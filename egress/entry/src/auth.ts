import { verifyHmac } from "./hmac.js";

export interface AuthResult {
  valid: boolean;
  userId?: string;
  error?: string;
}

/**
 * Validate a Proxy-Authorization header of the form:
 *   HMAC <timestamp>:<nonce>:<hex_digest>
 *
 * The user is identified by trying each secret in the users map
 * until one produces a matching HMAC.
 */
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
  if (parts.length !== 3) {
    return { valid: false, error: "malformed HMAC token" };
  }

  const [timestamp, nonce, digest] = parts;

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 60) {
    return { valid: false, error: "timestamp out of range" };
  }

  const message = `${timestamp}:${nonce}`;
  for (const [userId, secret] of Object.entries(users)) {
    if (verifyHmac(secret, message, digest)) {
      return { valid: true, userId };
    }
  }

  return { valid: false, error: "invalid signature" };
}
