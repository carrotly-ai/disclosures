export interface RateLimitWindow {
  readonly limit: number;
  readonly windowMs: number;
}

function validateWindow(window: RateLimitWindow): void {
  if (!Number.isInteger(window.limit) || window.limit <= 0) {
    throw new RangeError("Rate-limit window limit must be a positive integer");
  }
  if (!Number.isFinite(window.windowMs) || window.windowMs <= 0) {
    throw new RangeError("Rate-limit window duration must be positive");
  }
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    validateWindow({ limit, windowMs });
  }

  private prune(current: number): void {
    this.timestamps = this.timestamps.filter(
      (timestamp) => current - timestamp < this.windowMs,
    );
  }

  canAcquire(): boolean {
    this.prune(this.now());
    return this.timestamps.length < this.limit;
  }

  tryAcquire(): boolean {
    const current = this.now();
    this.prune(current);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(current);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }

  get size(): number {
    this.prune(this.now());
    return this.timestamps.length;
  }
}

export class MultiWindowRateLimiter {
  readonly windows: readonly RateLimitWindow[];
  private readonly timestamps: number[][];

  constructor(
    windows: readonly RateLimitWindow[],
    private readonly now: () => number = Date.now,
  ) {
    if (windows.length === 0) {
      throw new RangeError("At least one rate-limit window is required");
    }
    for (const window of windows) validateWindow(window);
    this.windows = windows.map(({ limit, windowMs }) => ({ limit, windowMs }));
    this.timestamps = this.windows.map(() => []);
  }

  private prune(current: number): void {
    for (let index = 0; index < this.windows.length; index += 1) {
      const window = this.windows[index];
      const timestamps = this.timestamps[index];
      if (!window || !timestamps) continue;
      this.timestamps[index] = timestamps.filter(
        (timestamp) => current - timestamp < window.windowMs,
      );
    }
  }

  canAcquire(): boolean {
    const current = this.now();
    this.prune(current);
    return this.windows.every((window, index) =>
      (this.timestamps[index]?.length ?? 0) < window.limit
    );
  }

  tryAcquire(): boolean {
    const current = this.now();
    this.prune(current);
    if (
      this.windows.some((window, index) =>
        (this.timestamps[index]?.length ?? 0) >= window.limit
      )
    ) {
      return false;
    }
    for (const timestamps of this.timestamps) timestamps.push(current);
    return true;
  }

  reset(): void {
    for (const timestamps of this.timestamps) timestamps.length = 0;
  }

  get sizes(): readonly number[] {
    this.prune(this.now());
    return this.timestamps.map((timestamps) => timestamps.length);
  }
}

export const secRateLimiter = new SlidingWindowRateLimiter(30, 60_000);
export const gleifRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
export const companiesHouseRateLimiter = new SlidingWindowRateLimiter(600, 5 * 60_000);
export const openDartRateLimiter = new MultiWindowRateLimiter([
  { limit: 1_000, windowMs: 60_000 },
  { limit: 20_000, windowMs: 24 * 60 * 60_000 },
]);

// EDINET's documents.json is date-indexed (one calendar day per request), so a
// single filings scan legitimately issues up to a year of day requests. The
// window must exceed EDINET_MAX_SCAN_DAYS so one bounded scan never self-trips;
// cross-call abuse still trips it.
export const edinetRateLimiter = new SlidingWindowRateLimiter(600, 60_000);

// cninfo (SSE/SZSE) has no published limit. A single filings query may page
// through several announcement requests, so keep the window generous enough
// that one bounded scan never self-trips while cross-call abuse still does.
export const cninfoRateLimiter = new SlidingWindowRateLimiter(300, 60_000);

// BSE India's api host is aggressively anti-bot; keep our own budget modest so
// we never contribute to the throttling that plain-fetch callers already hit.
export const bseRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

// FCA National Storage Mechanism (UK TR-1 major holdings). Access is inject-only
// (an explicitly supplied browser-backed fetchFn), and a single major-holdings
// lookup issues one search plus a capped set of artefact fetches, so keep a
// modest budget that never self-trips on one bounded lookup.
export const fcaNsmRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

export function resetRateLimiters(): void {
  secRateLimiter.reset();
  gleifRateLimiter.reset();
  companiesHouseRateLimiter.reset();
  openDartRateLimiter.reset();
  edinetRateLimiter.reset();
  cninfoRateLimiter.reset();
  bseRateLimiter.reset();
  fcaNsmRateLimiter.reset();
}
