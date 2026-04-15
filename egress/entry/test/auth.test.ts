import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { validateAuth } from "../src/auth.js";
import { computeHmac } from "../src/hmac.js";

const SECRET = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const USERS: Record<string, string> = { alice: SECRET };

function makeAuthHeader(
  secret: string,
  timestamp?: number,
  nonce?: string,
): string {
  const ts = (timestamp ?? Math.floor(Date.now() / 1000)).toString();
  const n = nonce ?? "test-nonce";
  const digest = computeHmac(secret, `${ts}:${n}`);
  return `HMAC ${ts}:${n}:${digest}`;
}

describe("validateAuth", () => {
  it("accepts a valid HMAC auth header and identifies user", () => {
    const header = makeAuthHeader(SECRET);
    const result = validateAuth(header, USERS);
    assert.equal(result.valid, true);
    assert.equal(result.userId, "alice");
  });

  it("rejects missing header", () => {
    const result = validateAuth(undefined, USERS);
    assert.equal(result.valid, false);
  });

  it("rejects when no secret matches", () => {
    const wrongSecret = "0".repeat(64);
    const header = makeAuthHeader(wrongSecret);
    const result = validateAuth(header, USERS);
    assert.equal(result.valid, false);
    assert.match(result.error!, /signature/);
  });

  it("rejects expired timestamp", () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 120;
    const header = makeAuthHeader(SECRET, oldTimestamp);
    const result = validateAuth(header, USERS);
    assert.equal(result.valid, false);
    assert.match(result.error!, /timestamp/);
  });

  it("rejects wrong signature", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const header = `HMAC ${ts}:nonce:${"0".repeat(64)}`;
    const result = validateAuth(header, USERS);
    assert.equal(result.valid, false);
    assert.match(result.error!, /signature/);
  });

  it("rejects non-HMAC scheme", () => {
    const result = validateAuth("Basic dXNlcjpwYXNz", USERS);
    assert.equal(result.valid, false);
  });

  it("accepts timestamps within 60s tolerance", () => {
    const ts = Math.floor(Date.now() / 1000) - 50;
    const header = makeAuthHeader(SECRET, ts);
    const result = validateAuth(header, USERS);
    assert.equal(result.valid, true);
  });
});
