export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    const current = this.now();
    this.timestamps = this.timestamps.filter(
      (timestamp) => current - timestamp < this.windowMs,
    );
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(current);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }

  get size(): number {
    const current = this.now();
    this.timestamps = this.timestamps.filter(
      (timestamp) => current - timestamp < this.windowMs,
    );
    return this.timestamps.length;
  }
}

export const secRateLimiter = new SlidingWindowRateLimiter(30, 60_000);
export const gleifRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

export function resetRateLimiters(): void {
  secRateLimiter.reset();
  gleifRateLimiter.reset();
}
