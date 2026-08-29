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

// SZSE's disclosure ShowReport JSON API (董监高股份变动 feed) has no published
// limit. One CompanyInsiders call pages through a few requests; keep the window
// generous enough that a single bounded scan never self-trips while cross-call
// abuse still does.
export const szseRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

// BSE India's api host is aggressively anti-bot; keep our own budget modest so
// we never contribute to the throttling that plain-fetch callers already hit.
export const bseRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

// FCA National Storage Mechanism (UK TR-1 major holdings). Access is inject-only
// (an explicitly supplied browser-backed fetchFn), and a single major-holdings
// lookup issues one search plus a capped set of artefact fetches, so keep a
// modest budget that never self-trips on one bounded lookup.
export const fcaNsmRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// filings.xbrl.org (EU/UK ESEF). The operator publishes no hard limit but asks
// clients to be gentle. One CompanyFinancials lookup issues a single filings
// query plus a small capped set of xBRL-JSON report fetches, so keep a modest
// budget that never self-trips on one bounded lookup while cross-call abuse does.
export const xbrlFilingsRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

// TWSE OpenAPI (openapi.twse.com.tw). The operator publishes no hard limit but
// the feeds are whole-market snapshots, so one company lookup issues at most a
// few dataset downloads. Keep a modest budget that never self-trips on one
// bounded lookup while cross-call abuse still trips it.
export const twseRateLimiter = new SlidingWindowRateLimiter(90, 60_000);

// Brazil CVM open data (dados.cvm.gov.br). The portal publishes no documented
// rate limit but each intent pulls one large whole-market CSV/ZIP snapshot
// (registration ~1.5 MB, an IPE year ~1-12 MB, a DFP year ~13 MB), so one
// company lookup is a small number of heavy downloads. Keep a modest budget
// that never self-trips on one bounded lookup while cross-call abuse still trips.
export const cvmRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// Germany BaFin portal (portal.mvp.bafin.de). The AnteileInfo (major-holding
// voting rights) and DealingsInfo (directors' dealings) databases are HTML
// search pages with no documented limit; one intent issues at most a search
// plus one issuer-holdings fetch, so keep a modest budget that never self-trips
// on one bounded lookup while cross-call abuse still trips it.
export const bafinRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// France info-financiere.gouv.fr (OpenDataSoft Explore v2 JSON). No documented
// hard limit beyond ODS anonymous quotas; one intent issues at most a records
// query plus a single document fetch, so keep a modest budget that never
// self-trips on one bounded lookup while cross-call abuse still trips it.
export const infoFinanciereRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// France recherche-entreprises.api.gouv.fr (DINUM). The operator documents a
// 7-requests-per-second ceiling; each intent issues a single search request, so
// a 1-second sliding window at that ceiling never self-trips on one lookup while
// bursty cross-call abuse still trips it.
export const rechercheEntreprisesRateLimiter = new SlidingWindowRateLimiter(7, 1_000);
// HKEXnews (www1.hkexnews.hk). Keyless JSON reference files + title-search
// servlet + direct PDFs, no documented limit. One intent issues a cached
// stock-list load plus a single search request (or one document fetch), so keep
// a modest budget that never self-trips on one bounded lookup while cross-call
// abuse still trips it.
export const hkexNewsRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

// HKEXnews CCASS Shareholding Search (www3.hkexnews.hk/sdw). A keyless ASP.NET
// WebForms page: one lookup issues a GET (for the viewstate) plus a single POST.
// It is a stateful form endpoint, so keep a deliberately modest budget — be
// polite to the form host — that never self-trips on one bounded lookup while
// cross-call abuse still trips it.
export const ccassRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

// Singapore ACRA on data.gov.sg (datastore_search). Keyless CKAN API, no
// documented limit. One resolve issues at most a consolidated UEN lookup plus a
// letter-split fetch, so keep a modest budget that never self-trips on one
// bounded lookup while cross-call abuse still trips it.
export const acraRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// Thailand DBD OpenAPI (openapi.dbd.go.th) keyless by-id resolver + optional
// DGA GDX name search (api.egov.go.th). One resolve is a single by-id GET; one
// name search is a GDX query plus a small capped set of by-id re-resolves, so
// keep a modest budget that never self-trips on one bounded lookup while
// cross-call abuse still trips it. Be polite to a government open-data host.
export const dbdRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// Netherlands AFM register exports (www.afm.nl/export.aspx). Keyless whole-file
// exports with no documented limit, but each request is a multi-MB (up to
// ~108 MB) download, so the budget is deliberately small: a normal session
// fetches each of the three registers at most once and then serves everything
// from the 24h digest cache. A tight budget makes an accidental refetch loop
// trip immediately rather than repeatedly pulling 100 MB from AFM.
export const afmRateLimiter = new SlidingWindowRateLimiter(12, 60_000);

export function resetRateLimiters(): void {
  secRateLimiter.reset();
  gleifRateLimiter.reset();
  companiesHouseRateLimiter.reset();
  openDartRateLimiter.reset();
  edinetRateLimiter.reset();
  cninfoRateLimiter.reset();
  szseRateLimiter.reset();
  bseRateLimiter.reset();
  fcaNsmRateLimiter.reset();
  xbrlFilingsRateLimiter.reset();
  twseRateLimiter.reset();
  cvmRateLimiter.reset();
  bafinRateLimiter.reset();
  infoFinanciereRateLimiter.reset();
  rechercheEntreprisesRateLimiter.reset();
  hkexNewsRateLimiter.reset();
  ccassRateLimiter.reset();
  acraRateLimiter.reset();
  dbdRateLimiter.reset();
  afmRateLimiter.reset();
}
