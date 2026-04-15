/**
 * Cross-environment HMAC compatibility test.
 *
 * Verifies that the Web Crypto HMAC (src/hmac.ts, used in CF Workers)
 * produces the same output as the Node.js crypto HMAC (egress/entry/src/hmac.ts).
 *
 * Run: node --import tsx/esm --test test/hmac-compat.test.ts
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Inline the Web Crypto implementation (since we're in Node.js, crypto.subtle is available)
async function computeHmacWebCrypto(
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
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function computeHmacNodeCrypto(hexSecret: string, message: string): string {
  return createHmac("sha256", Buffer.from(hexSecret, "hex"))
    .update(message)
    .digest("hex");
}

const TEST_VECTORS = [
  {
    secret: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    message: "1713000000:550e8400-e29b-41d4-a716-446655440000",
  },
  {
    secret: "0000000000000000000000000000000000000000000000000000000000000000",
    message: "0:",
  },
  {
    secret: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    message: "9999999999:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  },
];

describe("HMAC cross-environment compatibility", () => {
  for (const { secret, message } of TEST_VECTORS) {
    it(`matches for message "${message.substring(0, 30)}..."`, async () => {
      const webCrypto = await computeHmacWebCrypto(secret, message);
      const nodeCrypto = computeHmacNodeCrypto(secret, message);
      assert.equal(webCrypto, nodeCrypto);
    });
  }
});
