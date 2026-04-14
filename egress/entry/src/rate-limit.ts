export class PerUserRateLimiter {
  private windows = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(userId: string): boolean {
    const now = Date.now();
    let entry = this.windows.get(userId);

    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.windows.set(userId, entry);
    }

    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}
