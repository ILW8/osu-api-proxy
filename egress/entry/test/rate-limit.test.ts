import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PerUserRateLimiter } from "../src/rate-limit.js";

describe("PerUserRateLimiter", () => {
  it("tracks limits independently per user", () => {
    const rl = new PerUserRateLimiter(2, 60_000);
    assert.equal(rl.tryAcquire("alice"), true);
    assert.equal(rl.tryAcquire("alice"), true);
    assert.equal(rl.tryAcquire("alice"), false);
    // bob is independent
    assert.equal(rl.tryAcquire("bob"), true);
    assert.equal(rl.tryAcquire("bob"), true);
    assert.equal(rl.tryAcquire("bob"), false);
  });

  it("resets after window expires", () => {
    const rl = new PerUserRateLimiter(1, 100);
    assert.equal(rl.tryAcquire("alice"), true);
    assert.equal(rl.tryAcquire("alice"), false);

    const start = Date.now();
    while (Date.now() - start < 120) { /* spin */ }

    assert.equal(rl.tryAcquire("alice"), true);
  });
});
