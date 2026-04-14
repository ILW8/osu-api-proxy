import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SlidingWindowCounter } from "../src/rate-limit.js";

describe("SlidingWindowCounter", () => {
  it("allows requests up to the limit", () => {
    const rl = new SlidingWindowCounter(3, 60_000);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), false);
  });

  it("resets after the window expires", () => {
    const rl = new SlidingWindowCounter(2, 100);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), false);

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 120) { /* spin */ }

    assert.equal(rl.tryAcquire(), true);
  });

  it("reset() clears the counter", () => {
    const rl = new SlidingWindowCounter(1, 60_000);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), false);
    rl.reset();
    assert.equal(rl.tryAcquire(), true);
  });
});
