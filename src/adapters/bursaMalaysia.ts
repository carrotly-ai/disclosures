import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getText, HttpError } from "../core/http.js";
import {
  asArray,
  asIndexedStringArray,
  asRecord,
  decodeXmlEntities,
} from "../core/parsing.js";
import { bursaRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  Insider,
  OwnerRecord,
} from "../core/types.js";

// Bursa Malaysia's company-announcements search
// (www.bursamalaysia.com/api/v1/announcements/search) is a single keyless JSON
// feed of ~2.09 million rows that covers the whole Malaysian listed market. It
// is the one Malaysian source that clears this package's bar, and it is unusual
// in carrying FIRST-CLASS structured categories for both insiders and owners:
//
//   "Changes in Director's Interest (Section 219 of CA 2016)"   → CompanyInsiders
//   "Changes in Sub. S-hldr's Int (Section 138 of CA 2016)"     → CompanyOwners
//
// Both share the announcements category `SH,CHSH` ("Changes in Shareholdings"),
// so the two intents filter the same category feed by announcement-title prefix.
//
// The feed rows are positional arrays whose cells are HTML fragments (a date
// wrapped in responsive <div>s, an issuer <a> carrying stock_code, and a title
// <a> carrying ann_id), so parsing means unwrapping small anchors rather than
// reading named JSON fields. Per-transaction detail lives in the linked
// announcement document on disclosure.bursamalaysia.com, which this adapter
// parses when asked for detail (see fetchBursaAnnouncementDetail).
//
// Cloudflare posture: BOTH hosts sit behind a Cloudflare managed challenge and
// answer a plain request with a 403 "Just a moment..." interstitial — verified
// live on 2026-08-29 from this box, including with full browser headers and the
// exact XHR header set the site's own page uses. The clearance is cookie-bound
// to a solved challenge, so no static header set can substitute for it. Rather
// than fabricate or silently return empty, every path here detects the
// interstitial and throws the honest BURSA_CHALLENGE_MESSAGE naming the
// AdapterOptions.fetchFn escape hatch — exactly the BSE India precedent.
export const BURSA_SITE_URL = "https://www.bursamalaysia.com";
export const BURSA_API_BASE_URL = `${BURSA_SITE_URL}/api/v1`;
export const BURSA_ANNOUNCEMENT_SEARCH_URL =
  `${BURSA_API_BASE_URL}/announcements/search`;
export const BURSA_ANNOUNCEMENTS_PAGE_URL =
  `${BURSA_SITE_URL}/market_information/announcements/company_announcement`;
export const BURSA_ANNOUNCEMENT_DETAILS_URL =
  `${BURSA_ANNOUNCEMENTS_PAGE_URL}/announcement_details`;
export const BURSA_COMPANY_PROFILE_URL =
  `${BURSA_SITE_URL}/trade/trading_resources/listing_directory/company-profile`;
/** The disclosure host that serves the announcement document body itself. */
export const BURSA_DISCLOSURE_DOCUMENT_URL =
  "https://disclosure.bursamalaysia.com/FileAccess/viewHtml";

export const BURSA_REQUEST_TIMEOUT_MS = 25_000;
export const BURSA_DEFAULT_LIMIT = 20;
export const BURSA_MAX_LIMIT = 50;
/** How many linked announcements one insiders/owners call will open for detail. */
export const BURSA_MAX_DETAIL_FETCHES = 10;

/**
 * Bursa's own "Changes in Shareholdings" category value, as the announcements
 * search form emits it. Both the s.219 director-interest and s.138 substantial-
 * shareholder announcements live under it.
 */
export const BURSA_SHAREHOLDING_CATEGORY = "SH,CHSH";

/** Announcement-title prefixes that identify the two structured categories. */
export const BURSA_DIRECTOR_INTEREST_PREFIX = "Changes in Director's Interest";
export const BURSA_SUBSTANTIAL_HOLDER_PREFIX = "Changes in Sub. S-hldr's Int";

export const BURSA_INSIDER_FORM =
  "Changes in Director's Interest (S219 of CA 2016)";
export const BURSA_OWNER_FORM =
  "Changes in Sub. S-hldr's Int. (29B/S138 of CA 2016)";

export const BURSA_THRESHOLD_REGIME =
  "MY Companies Act 2016 s.137/138 substantial shareholding";

/**
 * Category taxonomy as published by the announcements search form's own
 * `cat` <select> (read live on 2026-08-29). Exposed so CompanyFilings can offer
 * a real category filter instead of a free-text guess.
 */
export const BURSA_ANNOUNCEMENT_CATEGORIES: ReadonlyArray<
  { value: string; label: string }
> = [
  { value: "AL,ALCO", label: "Additional Listing Announcement /Subdivision of Shares" },
  { value: "AA,AACO", label: "Annual Audited Account" },
  { value: "AR,ARCO", label: "Annual Report" },
  { value: "CI,COCI", label: "Change of Corporate Information" },
  { value: "SH,CHSH", label: "Changes in Shareholdings" },
  { value: "CS,CSCO", label: "Circular/Notice to Shareholders" },
  { value: "DRCO", label: "Dealings in Listed Securities (Chapter 14 of Listing Requirements)" },
  { value: "DLCO", label: "Delisting of Securities" },
  { value: "DMCO", label: "Disclosure On Quarterly Production" },
  { value: "EA,ENCO", label: "Entitlements" },
  { value: "ES,EMCO", label: "Expiry / Maturity / Termination of Securities" },
  { value: "FA,FRCO", label: "Financial Results" },
  { value: "GA,GACO", label: "General Announcement" },
  { value: "GM,MECO", label: "General Meetings" },
  { value: "IO,IPOA", label: "IPO Announcement/Admission to LEAP Market Announcement" },
  { value: "TR", label: "Important Relevant Dates for Renounceable Rights" },
  { value: "IA,IACO", label: "Investor Alert" },
  { value: "LC,LCCO", label: "Listing Circulars" },
  { value: "IP,LICO", label: "Listing Information and Profile" },
  { value: "PP,PPCO", label: "Prospectus" },
  { value: "RQ,RQCO", label: "Reply to Query" },
  { value: "SB,SBBA", label: "Shares Buy Back" },
  { value: "SA,SACO", label: "Special Announcements" },
  { value: "TECO", label: "Take-over Offer" },
  { value: "TL,TRFL", label: "Transfer of Listing" },
  { value: "UMA,UMCO", label: "Unusual Market Activity" },
];

export const BURSA_CHALLENGE_MESSAGE =
  "Bursa Malaysia (www.bursamalaysia.com / disclosure.bursamalaysia.com) is " +
  "behind a Cloudflare managed challenge and answered this request with the " +
  '"Just a moment..." interstitial instead of data. The clearance is bound to ' +
  "a cookie issued only after the challenge is solved in a real browser, so no " +
  "static header set can substitute for it. To use the MY route, inject a " +
  "browser-backed fetchFn via AdapterOptions.fetchFn (a headless browser that " +
  "solves the challenge and then issues the request with its cleared session). " +
  "This adapter will not fabricate or silently return an empty result.";

export const BURSA_CAVEAT =
  "Bursa's announcements search is the single MY source: filings, plus the " +
  "s.219 director-interest and s.138 substantial-shareholder categories that " +
  "serve CompanyInsiders and CompanyOwners. It is Cloudflare-challenged, so " +
  "the MY route needs a browser-backed AdapterOptions.fetchFn. SSM (the " +
  "Companies Commission e-Info registry) is a paid product, so private-company " +
  "resolution, documents and charges are honest unsupported for MY.";

export const BURSA_RATE_LIMIT_MESSAGE =
  "Bursa Malaysia request limit reached. Please retry later.";

export class BursaRateLimitError extends AdapterRateLimitError {
  constructor(message = BURSA_RATE_LIMIT_MESSAGE) {
    super(message, 90, 60_000, "Bursa Malaysia");
    this.name = "BursaRateLimitError";
  }
}

export class BursaApiError extends AdapterError {
  constructor(message: string) {
    super(message, "Bursa Malaysia");
    this.name = "BursaApiError";
  }
}

/** Thrown when Cloudflare answers with the challenge interstitial. */
export class BursaChallengeError extends AdapterError {
  constructor(message = BURSA_CHALLENGE_MESSAGE) {
    super(message, "Bursa Malaysia");
    this.name = "BursaChallengeError";
  }
}

function acquireRequest(): void {
  if (!bursaRateLimiter.tryAcquire()) throw new BursaRateLimitError();
}

// The site's own page issues these; they are necessary but (as verified live)
// not sufficient — the cookie from a solved challenge is what actually clears.
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  Referer: BURSA_ANNOUNCEMENTS_PAGE_URL,
};

const DOCUMENT_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": BROWSER_HEADERS["User-Agent"] as string,
  Referer: `${BURSA_SITE_URL}/`,
};

/**
 * Detect Cloudflare's managed-challenge interstitial. It is served with a 403
 * (caught as an HttpError) but can also arrive 200 on some edges, so both the
 * error path and the body path check for it.
 */
export function isCloudflareChallenge(body: string): boolean {
  return (
    /Just a moment\.\.\./i.test(body) ||
    /_cf_chl_opt/.test(body) ||
    /cf-browser-verification|challenges\.cloudflare\.com/i.test(body) ||
    /Enable JavaScript and cookies to continue/i.test(body)
  );
}

function mapTransportError(error: unknown): unknown {
  if (error instanceof HttpError) {
    if (error.status === 429) return new BursaRateLimitError();
    // Cloudflare's managed challenge is served as a 403 interstitial. A 403
    // from either Bursa host is the challenge in practice, so name the escape
    // hatch rather than surfacing a bare "HTTP 403".
    if (error.status === 403) return new BursaChallengeError();
  }
  return error;
}

async function fetchBursaText(
  url: string,
  headers: Record<string, string>,
  options: AdapterOptions,
): Promise<string> {
  acquireRequest();
  let body: string;
  try {
    body = await getText(
      url,
      headers,
      BURSA_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    throw mapTransportError(error);
  }
  if (isCloudflareChallenge(body)) throw new BursaChallengeError();
  return body;
}

// --- Row parsing -----------------------------------------------------------

function stripTags(html: string): string {
  return decodeXmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Bursa stock codes are 4 digits, optionally with a 1-2 char instrument suffix. */
export function isBursaStockCode(value: string): boolean {
  return /^\d{4}[A-Z]{0,2}$/.test(value.trim().toUpperCase());
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Bursa dates come in two shapes: the feed cell renders "28 Aug 2026" (twice,
 * once per responsive breakpoint) and the announcement documents mix
 * "28 Aug 2026" with "28/08/2026". Normalise both to ISO.
 */
export function parseBursaDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  const named = text.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\b/);
  if (named) {
    const month = MONTHS[(named[2] ?? "").toLowerCase()];
    if (month) {
      return `${named[3]}-${month}-${(named[1] ?? "").padStart(2, "0")}`;
    }
  }
  const slashed = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (slashed) return `${slashed[3]}-${slashed[2]}-${slashed[1]}`;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

/** Render an ISO date as the DD/MM/YYYY the search form's date params want. */
export function toBursaDateParam(isoDate: string): string {
  const match = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate.trim();
}

export interface BursaAnnouncementRow {
  /** ISO announcement date. */
  date: string;
  companyName: string;
  stockCode?: string;
  title: string;
  /** Sub-headline Bursa renders in a trailing <p> under some titles. */
  subtitle?: string;
  announcementId?: string;
  detailsUrl: string;
}

/**
 * Parse one positional row of the announcements feed. Cells are
 * `[index, dateHtml, companyAnchorHtml, titleAnchorHtml]`; the last cell may
 * carry a trailing `<p>` sub-headline after the title anchor.
 */
export function parseBursaAnnouncementRow(
  cells: readonly string[],
): BursaAnnouncementRow | undefined {
  const [, dateCell, companyCell, titleCell] = cells;
  if (!titleCell) return undefined;
  const date = parseBursaDate(stripTags(dateCell ?? ""));
  const companyName = stripTags(companyCell ?? "");
  const stockCode = companyCell?.match(/stock_code=([A-Za-z0-9]+)/)?.[1];
  const announcementId = titleCell.match(/ann_id=(\d+)/)?.[1];
  const anchor = titleCell.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  const title = stripTags(anchor?.[1] ?? titleCell);
  if (!title) return undefined;
  const trailing = titleCell.slice(
    anchor ? (anchor.index ?? 0) + anchor[0].length : 0,
  );
  const subtitle = stripTags(trailing);
  return {
    date: date ?? "",
    companyName,
    ...(stockCode ? { stockCode } : {}),
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(announcementId ? { announcementId } : {}),
    detailsUrl: announcementId
      ? `${BURSA_ANNOUNCEMENT_DETAILS_URL}?ann_id=${announcementId}`
      : BURSA_ANNOUNCEMENTS_PAGE_URL,
  };
}

export interface BursaSearchResult {
  recordsTotal: number;
  rows: BursaAnnouncementRow[];
}

/** Parse the announcements-search envelope `{recordsTotal, data:[[...]]}`. */
export function parseBursaSearchResponse(body: string): BursaSearchResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BursaApiError(
      "Bursa Malaysia returned a non-JSON announcements response.",
    );
  }
  const envelope = asRecord(payload);
  if (!envelope) {
    throw new BursaApiError(
      "Bursa Malaysia returned an unexpected announcements payload.",
    );
  }
  const recordsTotal = typeof envelope.recordsTotal === "number"
    ? envelope.recordsTotal
    : 0;
  const rows = asArray(envelope.data).flatMap((entry) => {
    const row = parseBursaAnnouncementRow(asIndexedStringArray(entry));
    return row ? [row] : [];
  });
  return { recordsTotal, rows };
}

// --- Announcement search ---------------------------------------------------

export interface BursaSearchParams {
  /** Bursa stock code, passed through as the feed's `company` filter. */
  stockCode?: string;
  /** Announcement category value, e.g. "SH,CHSH". */
  category?: string;
  /** Free-text title keyword. */
  keyword?: string;
  /** ISO start date (inclusive). */
  startDate?: string;
  /** ISO end date (inclusive). */
  endDate?: string;
  perPage?: number;
  page?: number;
}

export function buildBursaSearchUrl(params: BursaSearchParams): string {
  const query = new URLSearchParams({ ann_type: "company" });
  if (params.stockCode) query.set("company", params.stockCode);
  if (params.category) query.set("cat", params.category);
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.startDate) query.set("dt_ht", toBursaDateParam(params.startDate));
  if (params.endDate) query.set("dt_lt", toBursaDateParam(params.endDate));
  query.set(
    "per_page",
    String(Math.min(BURSA_MAX_LIMIT, Math.max(1, params.perPage ?? BURSA_DEFAULT_LIMIT))),
  );
  query.set("page", String(Math.max(1, params.page ?? 1)));
  return `${BURSA_ANNOUNCEMENT_SEARCH_URL}?${query.toString()}`;
}

export async function searchBursaAnnouncements(
  params: BursaSearchParams,
  options: AdapterOptions = {},
): Promise<BursaSearchResult> {
  const body = await fetchBursaText(
    buildBursaSearchUrl(params),
    BROWSER_HEADERS,
    options,
  );
  return parseBursaSearchResponse(body);
}

// --- Resolution ------------------------------------------------------------

function rowToEntity(
  row: BursaAnnouncementRow,
  matchReason: string,
): Entity {
  return {
    legalName: row.companyName,
    ...(row.stockCode ? { stockCode: row.stockCode } : {}),
    jurisdiction: "MY",
    source: "Bursa Malaysia",
    sourceIdentifiers: {
      ...(row.stockCode ? { stockCode: row.stockCode } : {}),
      jurisdiction: "MY",
    },
    sourceUrl: row.stockCode
      ? `${BURSA_COMPANY_PROFILE_URL}?stock_code=${row.stockCode}`
      : BURSA_ANNOUNCEMENTS_PAGE_URL,
    matchReason,
  };
}

/**
 * Resolve a Malaysian issuer from the announcements surface. A 4-digit stock
 * code is looked up directly (the feed's `company` filter); anything else is a
 * title/issuer keyword search whose distinct issuers become the candidates.
 * Bursa publishes no keyless company-directory JSON endpoint — the listing
 * directory's company list is server-rendered into the announcements page's
 * <select> — so the announcements feed is the resolution surface.
 */
export async function searchBursaCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (isBursaStockCode(trimmed)) {
    const code = trimmed.toUpperCase();
    const { rows } = await searchBursaAnnouncements(
      { stockCode: code, perPage: 5 },
      options,
    );
    const named = rows.find((row) => row.companyName);
    if (!named) return [];
    return [rowToEntity(named, `Exact Bursa stock-code match (${code})`)];
  }

  const { rows } = await searchBursaAnnouncements(
    { keyword: trimmed, perPage: BURSA_MAX_LIMIT },
    options,
  );
  const seen = new Set<string>();
  const entities: Entity[] = [];
  for (const row of rows) {
    const key = row.stockCode ?? row.companyName;
    if (!row.companyName || seen.has(key)) continue;
    seen.add(key);
    entities.push(rowToEntity(row, "Bursa announcements issuer match"));
  }
  return rankEntities(trimmed, entities, {
    fallbackReason: "Bursa announcements issuer match",
  });
}

export async function resolveBursaCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchBursaCompanies(query, options))[0] ?? null;
}

async function resolveStockCode(
  company: string,
  options: AdapterOptions,
): Promise<Entity> {
  const trimmed = company.trim();
  if (isBursaStockCode(trimmed)) {
    const resolved = await resolveBursaCompany(trimmed, options);
    if (resolved?.stockCode) return resolved;
    throw new BursaApiError(`No Bursa company found for ${company}.`);
  }
  const entity = await resolveBursaCompany(trimmed, options);
  if (!entity?.stockCode) {
    throw new BursaApiError(`No Bursa company found for ${company}.`);
  }
  return entity;
}

// --- Filings ---------------------------------------------------------------

export interface BursaFilingSearchParams {
  company: string;
  category?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

function rowToFiling(row: BursaAnnouncementRow): Filing {
  return {
    filedDate: row.date,
    form: row.title,
    ...(row.subtitle ? { category: row.subtitle } : {}),
    description: row.subtitle ? `${row.title} — ${row.subtitle}` : row.title,
    ...(row.announcementId ? { accession: row.announcementId } : {}),
    sourceUrl: row.detailsUrl,
    source: "Bursa Malaysia",
    sourceIdentifiers: {
      ...(row.stockCode ? { stockCode: row.stockCode } : {}),
      jurisdiction: "MY",
    },
  };
}

export interface BursaFilingsResult {
  entity: Entity;
  recordsTotal: number;
  filings: Filing[];
}

export async function searchBursaFilings(
  input: string | BursaFilingSearchParams,
  options: AdapterOptions = {},
): Promise<BursaFilingsResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveStockCode(params.company, options);
  const limit = Math.min(
    BURSA_MAX_LIMIT,
    Math.max(1, params.limit ?? BURSA_DEFAULT_LIMIT),
  );
  const { recordsTotal, rows } = await searchBursaAnnouncements(
    {
      stockCode: entity.stockCode as string,
      ...(params.category ? { category: params.category } : {}),
      ...(params.keyword ? { keyword: params.keyword } : {}),
      ...(params.startDate ? { startDate: params.startDate } : {}),
      ...(params.endDate ? { endDate: params.endDate } : {}),
      perPage: limit,
    },
    options,
  );
  return { entity, recordsTotal, filings: rows.map(rowToFiling).slice(0, limit) };
}

// --- Announcement document detail -----------------------------------------

/** Announcement document URL for an ann_id, on the disclosure host. */
export function bursaDocumentUrl(announcementId: string): string {
  return `${BURSA_DISCLOSURE_DOCUMENT_URL}?e=${encodeURIComponent(announcementId)}`;
}

export interface BursaDocumentTransaction {
  date?: string;
  securities?: number;
  transactionType?: string;
  natureOfInterest?: string;
  registeredHolder?: string;
  consideration?: string;
}

export interface BursaAnnouncementDetail {
  /** Announcement heading, e.g. "Changes in Director's Interest (Section 219...". */
  heading?: string;
  companyName?: string;
  /** The director or substantial shareholder the announcement is about. */
  holderName?: string;
  securitiesClass?: string;
  transactions: BursaDocumentTransaction[];
  circumstances?: string;
  natureOfInterest?: string;
  directUnits?: number;
  directPct?: number;
  indirectUnits?: number;
  indirectPct?: number;
  totalAfterChange?: number;
  noticeDate?: string;
  noticeReceivedDate?: string;
  announcedDate?: string;
  category?: string;
  referenceNumber?: string;
  stockName?: string;
  sourceUrl: string;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface LabelledCell {
  label: string;
  value: string;
}

/**
 * Bursa's announcement documents are a fixed set of two-column
 * label/value tables (`formContentLabel`/`formContentData` and
 * `formTableColumnHeader`/`formTableColumnLabel`). Flatten every `<tr>` into
 * label→value pairs rather than assuming a particular table order, because the
 * s.219 and s.138 templates differ in layout while sharing the labels.
 */
function labelledCells(html: string): LabelledCell[] {
  const pairs: LabelledCell[] = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(
      (rowMatch[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
    ).map((cell) => cell[1] ?? "");
    if (cells.length < 2) continue;
    // Some rows lead with a rowspan "No" counter cell whose content is a
    // <script>; drop leading cells that carry no text.
    const textual = cells.map((cell) =>
      stripTags(cell.replace(/<script[\s\S]*?<\/script>/gi, "")),
    );
    const start = textual[0] === "" && textual.length > 2 ? 1 : 0;
    const label = textual[start];
    const value = textual.slice(start + 1).filter(Boolean).join(" ");
    if (!label) continue;
    pairs.push({ label, value });
  }
  return pairs;
}

function findValue(
  cells: readonly LabelledCell[],
  label: string,
): string | undefined {
  const needle = label.toLowerCase();
  const hit = cells.find((cell) => cell.label.toLowerCase() === needle);
  return hit?.value || undefined;
}

/**
 * Parse the per-transaction "Details of changes" table. Each transaction is a
 * 5-column data row (No / date / securities / type / nature) optionally
 * followed by label rows carrying the registered holder and consideration.
 */
function parseTransactions(html: string): BursaDocumentTransaction[] {
  const transactions: BursaDocumentTransaction[] = [];
  const table = html.match(
    /<table[^>]*class=["'][^"']*ven_table[^"']*["'][\s\S]*?<\/table>/i,
  )?.[0];
  if (!table) return transactions;
  let current: BursaDocumentTransaction | undefined;
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const raw = rowMatch[1] ?? "";
    const cells = Array.from(raw.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (cell) => ({
        html: cell[0] ?? "",
        text: stripTags((cell[1] ?? "").replace(/<script[\s\S]*?<\/script>/gi, "")),
      }),
    );
    if (!cells.length) continue;
    // Header row (all cells are column headers with no data siblings).
    if (cells.every((cell) => /formTableColumnHeader/i.test(cell.html))) continue;

    const leadingCounter = cells[0] && cells[0].text === "" &&
      /rowspan/i.test(cells[0].html);
    const body = leadingCounter ? cells.slice(1) : cells;

    if (body.length >= 4 && !/formTableColumnHeader/i.test(body[0]?.html ?? "")) {
      if (current) transactions.push(current);
      current = {
        ...(parseBursaDate(body[0]?.text) ? { date: parseBursaDate(body[0]?.text) as string } : {}),
        ...(parseNumber(body[1]?.text) !== undefined
          ? { securities: parseNumber(body[1]?.text) as number }
          : {}),
        ...(body[2]?.text ? { transactionType: body[2].text } : {}),
        ...(body[3]?.text ? { natureOfInterest: body[3].text } : {}),
      };
      continue;
    }
    // Label/value continuation row for the transaction just read.
    const label = (body[0]?.text ?? "").toLowerCase();
    const value = body.slice(1).map((cell) => cell.text).filter(Boolean).join(" ");
    if (!current || !value) continue;
    if (label === "name of registered holder") current.registeredHolder = value;
    else if (label === "consideration (if any)") current.consideration = value;
  }
  if (current) transactions.push(current);
  return transactions;
}

/** Parse a Bursa announcement document (disclosure.bursamalaysia.com viewHtml). */
export function parseBursaAnnouncementDocument(
  html: string,
  sourceUrl: string,
): BursaAnnouncementDetail {
  const cells = labelledCells(html);
  const heading = stripTags(html.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "");
  const companyName = stripTags(
    html.match(
      /<td[^>]*class=["'][^"']*company_name[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
    )?.[1] ?? "",
  );
  const detail: BursaAnnouncementDetail = {
    ...(heading ? { heading } : {}),
    ...(companyName ? { companyName } : {}),
    transactions: parseTransactions(html),
    sourceUrl,
  };
  const name = findValue(cells, "Name");
  if (name) detail.holderName = name;
  const cls = findValue(cells, "Descriptions (Class)") ??
    findValue(cells, "Descriptions(Class)");
  if (cls) detail.securitiesClass = cls;
  const circumstances = findValue(
    cells,
    "Circumstances by reason of which change has occurred",
  );
  if (circumstances) detail.circumstances = circumstances;
  const nature = findValue(cells, "Nature of interest");
  if (nature) detail.natureOfInterest = nature;
  const directUnits = parseNumber(findValue(cells, "Direct (units)"));
  if (directUnits !== undefined) detail.directUnits = directUnits;
  const directPct = parseNumber(findValue(cells, "Direct (%)"));
  if (directPct !== undefined) detail.directPct = directPct;
  const indirectUnits = parseNumber(
    findValue(cells, "Indirect/deemed interest (units)"),
  );
  if (indirectUnits !== undefined) detail.indirectUnits = indirectUnits;
  const indirectPct = parseNumber(
    findValue(cells, "Indirect/deemed interest (%)"),
  );
  if (indirectPct !== undefined) detail.indirectPct = indirectPct;
  const total = parseNumber(findValue(cells, "Total no of securities after change"));
  if (total !== undefined) detail.totalAfterChange = total;
  const noticeDate = parseBursaDate(findValue(cells, "Date of notice"));
  if (noticeDate) detail.noticeDate = noticeDate;
  const received = parseBursaDate(
    findValue(cells, "Date notice received by Listed Issuer"),
  );
  if (received) detail.noticeReceivedDate = received;
  const announced = parseBursaDate(findValue(cells, "Date Announced"));
  if (announced) detail.announcedDate = announced;
  const category = findValue(cells, "Category");
  if (category) detail.category = category;
  const reference = findValue(cells, "Reference Number");
  if (reference) detail.referenceNumber = reference;
  const stockName = findValue(cells, "Stock Name");
  if (stockName) detail.stockName = stockName;
  return detail;
}

export async function fetchBursaAnnouncementDetail(
  announcementId: string,
  options: AdapterOptions = {},
): Promise<BursaAnnouncementDetail> {
  const url = bursaDocumentUrl(announcementId);
  const html = await fetchBursaText(url, DOCUMENT_HEADERS, options);
  return parseBursaAnnouncementDocument(html, url);
}

// --- Insiders (s.219 director interest) ------------------------------------

/**
 * Bursa puts the holder's name in the announcement title after an " - "
 * separator: "Changes in Director's Interest (Section 219 of CA 2016) -
 * MR WONG WAI FOO". Amended announcements append a parenthetical suffix.
 */
export function holderNameFromTitle(title: string): string | undefined {
  const separator = title.indexOf(" - ");
  if (separator < 0) return undefined;
  const tail = title.slice(separator + 3).trim();
  const cleaned = tail.replace(/\s*\(Amended Announcement\)\s*$/i, "").trim();
  return cleaned || undefined;
}

function isDirectorInterest(row: BursaAnnouncementRow): boolean {
  return row.title.startsWith(BURSA_DIRECTOR_INTEREST_PREFIX);
}

function isSubstantialHolder(row: BursaAnnouncementRow): boolean {
  return row.title.startsWith(BURSA_SUBSTANTIAL_HOLDER_PREFIX);
}

export interface BursaDetailedRow<T> {
  record: T;
  detail?: BursaAnnouncementDetail;
}

export interface BursaInsidersResult {
  entity: Entity;
  rows: Insider[];
  /** How many rows were enriched from the linked announcement document. */
  detailedCount: number;
  /** Set when detail fetching was skipped or failed, for an honest note. */
  detailNote?: string;
}

/**
 * Collect the announcement rows for one of the two structured categories,
 * newest first, bounded by `limit`. Both categories share `cat=SH,CHSH`, so a
 * title-prefix filter separates them; the feed is requested wider than `limit`
 * so the prefix filter still fills the page.
 */
async function collectCategoryRows(
  entity: Entity,
  predicate: (row: BursaAnnouncementRow) => boolean,
  limit: number,
  params: { startDate?: string; endDate?: string },
  options: AdapterOptions,
): Promise<BursaAnnouncementRow[]> {
  const { rows } = await searchBursaAnnouncements(
    {
      stockCode: entity.stockCode as string,
      category: BURSA_SHAREHOLDING_CATEGORY,
      ...(params.startDate ? { startDate: params.startDate } : {}),
      ...(params.endDate ? { endDate: params.endDate } : {}),
      perPage: BURSA_MAX_LIMIT,
    },
    options,
  );
  return rows.filter(predicate).slice(0, limit);
}

export interface BursaCategoryParams {
  company: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  /**
   * Whether to open each linked announcement for its structured per-transaction
   * detail. Defaults true; the fetch count is capped at
   * BURSA_MAX_DETAIL_FETCHES so one call never fans out unbounded.
   */
  withDetail?: boolean;
}

async function withDetails(
  rows: readonly BursaAnnouncementRow[],
  wanted: boolean,
  options: AdapterOptions,
): Promise<{ details: Map<string, BursaAnnouncementDetail>; note?: string }> {
  const details = new Map<string, BursaAnnouncementDetail>();
  if (!wanted) {
    return {
      details,
      note:
        "Per-transaction detail was not requested; each row links to the " +
        "official Bursa announcement, which carries the dated transactions and " +
        "the resulting direct/indirect holding.",
    };
  }
  const targets = rows
    .filter((row) => row.announcementId)
    .slice(0, BURSA_MAX_DETAIL_FETCHES);
  let failure: unknown;
  for (const row of targets) {
    try {
      details.set(
        row.announcementId as string,
        await fetchBursaAnnouncementDetail(row.announcementId as string, options),
      );
    } catch (error) {
      // A challenge on the disclosure host is the honest headline, so rethrow
      // it rather than silently degrading to link-only rows.
      if (error instanceof BursaChallengeError) throw error;
      if (error instanceof BursaRateLimitError) throw error;
      failure = error;
      break;
    }
  }
  const notes: string[] = [];
  if (rows.length > targets.length) {
    notes.push(
      `Per-transaction detail was read from the first ${targets.length} ` +
        `announcement${targets.length === 1 ? "" : "s"} (cap: ` +
        `${BURSA_MAX_DETAIL_FETCHES}); the remaining rows are link-only — open ` +
        "the linked announcement for their transactions.",
    );
  }
  if (failure) {
    notes.push(
      "Some announcement documents could not be read " +
        `(${failure instanceof Error ? failure.message : String(failure)}); ` +
        "those rows are link-only.",
    );
  }
  return { details, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

export async function getBursaInsiders(
  input: string | BursaCategoryParams,
  options: AdapterOptions = {},
): Promise<BursaInsidersResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveStockCode(params.company, options);
  const limit = Math.min(
    BURSA_MAX_LIMIT,
    Math.max(1, params.limit ?? BURSA_DEFAULT_LIMIT),
  );
  const rows = await collectCategoryRows(
    entity,
    isDirectorInterest,
    limit,
    params,
    options,
  );
  const { details, note } = await withDetails(
    rows,
    params.withDetail !== false,
    options,
  );

  const insiders: Insider[] = rows.map((row) => {
    const detail = row.announcementId ? details.get(row.announcementId) : undefined;
    const transaction = detail?.transactions[0];
    const name = detail?.holderName ?? holderNameFromTitle(row.title) ??
      row.companyName;
    const insider: Insider = {
      name,
      roles: ["Director"],
      form: BURSA_INSIDER_FORM,
      filedDate: row.date,
      sourceUrl: row.detailsUrl,
      source: "Bursa Malaysia",
      sourceIdentifiers: {
        ...(row.stockCode ? { stockCode: row.stockCode } : {}),
        jurisdiction: "MY",
      },
      ...(row.announcementId ? { accession: row.announcementId } : {}),
    };
    if (transaction?.transactionType) {
      insider.occupation = transaction.natureOfInterest
        ? `${transaction.transactionType} (${transaction.natureOfInterest})`
        : transaction.transactionType;
    }
    if (transaction?.date) insider.notifiedDate = transaction.date;
    if (transaction?.securities !== undefined) {
      insider.change = transaction.transactionType?.toLowerCase() === "disposed"
        ? -transaction.securities
        : transaction.securities;
    }
    if (detail?.directPct !== undefined) insider.pct = detail.directPct;
    if (detail?.circumstances) insider.status = detail.circumstances;
    return insider;
  });

  return {
    entity,
    rows: insiders,
    detailedCount: details.size,
    ...(note ? { detailNote: note } : {}),
  };
}

// --- Owners (s.138 substantial shareholder) --------------------------------

export interface BursaOwnersResult {
  entity: Entity;
  rows: OwnerRecord[];
  detailedCount: number;
  detailNote?: string;
}

export async function getBursaOwners(
  input: string | BursaCategoryParams,
  options: AdapterOptions = {},
): Promise<BursaOwnersResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveStockCode(params.company, options);
  const limit = Math.min(
    BURSA_MAX_LIMIT,
    Math.max(1, params.limit ?? BURSA_DEFAULT_LIMIT),
  );
  const rows = await collectCategoryRows(
    entity,
    isSubstantialHolder,
    limit,
    params,
    options,
  );
  const { details, note } = await withDetails(
    rows,
    params.withDetail !== false,
    options,
  );

  const owners: OwnerRecord[] = rows.map((row) => {
    const detail = row.announcementId ? details.get(row.announcementId) : undefined;
    const transaction = detail?.transactions[0];
    const holderName = detail?.holderName ?? holderNameFromTitle(row.title) ??
      row.companyName;
    const owner: OwnerRecord = {
      holderName,
      holderType: "Substantial shareholder",
      thresholdRegime: BURSA_THRESHOLD_REGIME,
      form: BURSA_OWNER_FORM,
      filedDate: row.date,
      sourceUrl: row.detailsUrl,
      source: "Bursa Malaysia",
      sourceIdentifiers: {
        ...(row.stockCode ? { stockCode: row.stockCode } : {}),
        jurisdiction: "MY",
      },
      ...(row.announcementId ? { accession: row.announcementId } : {}),
    };
    if (detail?.directPct !== undefined) owner.pct = detail.directPct;
    if (detail?.noticeDate) owner.notifiedDate = detail.noticeDate;
    if (transaction?.date) owner.crossingDate = transaction.date;
    if (transaction?.securities !== undefined) {
      const disposed = transaction.transactionType?.toLowerCase() === "disposed";
      owner.change = disposed ? -transaction.securities : transaction.securities;
      owner.crossingDirection = disposed ? "down" : "up";
    }
    const natures: string[] = [];
    if (transaction?.natureOfInterest) natures.push(transaction.natureOfInterest);
    else if (detail?.natureOfInterest) natures.push(detail.natureOfInterest);
    if (detail?.circumstances) natures.push(detail.circumstances);
    if (natures.length) owner.naturesOfControl = natures;
    if (detail) owner.machineReadable = true;
    return owner;
  });

  return {
    entity,
    rows: owners,
    detailedCount: details.size,
    ...(note ? { detailNote: note } : {}),
  };
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveBursaCompany;
export const searchCompanies = searchBursaCompanies;
export const searchFilings = searchBursaFilings;

export function createBursaAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveBursaCompany(query, options),
    searchEntities: (query: string) => searchBursaCompanies(query, options),
    searchFilings: (input: string | BursaFilingSearchParams) =>
      searchBursaFilings(input, options),
    getInsiders: (input: string | BursaCategoryParams) =>
      getBursaInsiders(input, options),
    getOwners: (input: string | BursaCategoryParams) =>
      getBursaOwners(input, options),
    getDocument: (announcementId: string) =>
      fetchBursaAnnouncementDetail(announcementId, options),
  };
}
