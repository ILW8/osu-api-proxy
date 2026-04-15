/**
 * HMAC-SHA256 computation via Web Crypto API (compatible with CF Workers).
 *
 * The shared secret is a hex-encoded string (from `openssl rand -hex 32`).
 * This must produce identical output to Node.js:
 *   crypto.createHmac("sha256", Buffer.from(hexSecret, "hex")).update(message).digest("hex")
 */

export async function computeHmac(
  hexSecret: string,
  message: string,
): Promise<string> {
  const keyData = hexToBytes(hexSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
