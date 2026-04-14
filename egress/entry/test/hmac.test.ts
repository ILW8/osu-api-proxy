import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { computeHmac, verifyHmac } from "../src/hmac.js";

const TEST_SECRET_HEX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("computeHmac", () => {
  it("produces a 64-character hex digest", () => {
    const digest = computeHmac(TEST_SECRET_HEX, "1713000000:some-nonce");
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("produces different digests for different messages", () => {
    const a = computeHmac(TEST_SECRET_HEX, "1713000000:nonce-a");
    const b = computeHmac(TEST_SECRET_HEX, "1713000000:nonce-b");
    assert.notEqual(a, b);
  });

  it("produces different digests for different secrets", () => {
    const a = computeHmac(TEST_SECRET_HEX, "msg");
    const b = computeHmac("0".repeat(64), "msg");
    assert.notEqual(a, b);
  });
});

describe("verifyHmac", () => {
  it("returns true for a valid digest", () => {
    const digest = computeHmac(TEST_SECRET_HEX, "test-message");
    assert.equal(verifyHmac(TEST_SECRET_HEX, "test-message", digest), true);
  });

  it("returns false for a tampered digest", () => {
    const digest = computeHmac(TEST_SECRET_HEX, "test-message");
    // Flip the first hex character to guarantee the tampered string differs
    const flipped = digest[0] === "0" ? "1" : "0";
    const tampered = flipped + digest.slice(1);
    assert.equal(verifyHmac(TEST_SECRET_HEX, "test-message", tampered), false);
  });

  it("returns false for wrong-length digest", () => {
    assert.equal(verifyHmac(TEST_SECRET_HEX, "msg", "tooshort"), false);
  });
});
