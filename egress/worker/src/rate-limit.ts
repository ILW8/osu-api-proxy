export class SlidingWindowCounter {
  private windowStart = Date.now();
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  reset(): void {
    this.count = 0;
    this.windowStart = Date.now();
  }
}
