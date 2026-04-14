import { createHmac, timingSafeEqual } from "node:crypto";

export function computeHmac(hexSecret: string, message: string): string {
  return createHmac("sha256", Buffer.from(hexSecret, "hex"))
    .update(message)
    .digest("hex");
}

export function verifyHmac(
  hexSecret: string,
  message: string,
  providedDigest: string,
): boolean {
  const expected = computeHmac(hexSecret, message);
  if (expected.length !== providedDigest.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(providedDigest, "utf8"),
  );
}
