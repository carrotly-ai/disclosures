import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getText, HttpError } from "../core/http.js";
import { asArray, asRecord, asString, decodeXmlEntities } from "../core/parsing.js";
import { bseRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity, Filing } from "../core/types.js";

// BSE (Bombay Stock Exchange) is India's primary machine-readable disclosure
// source here. Its API host is Akamai-protected, while direct filing attachments
// can remain reachable. All requests stay injectable through AdapterOptions.
export const BSE_SITE_URL = "https://www.bseindia.com";
export const BSE_API_BASE_URL = "https://api.bseindia.com/BseIndiaAPI/api";
export const BSE_SEARCH_URL = `${BSE_API_BASE_URL}/PeerSmartSearch/w`;
export const BSE_ANNOUNCEMENTS_URL =
  `${BSE_API_BASE_URL}/AnnSubCategoryGetData/w`;
export const BSE_ATTACHMENT_LIVE_BASE_URL =
  `${BSE_SITE_URL}/xml-data/corpfiling/AttachLive`;
export const BSE_ATTACHMENT_HIS_BASE_URL =
  `${BSE_SITE_URL}/xml-data/corpfiling/AttachHis`;
/** @deprecated Use the explicit AttachLive/AttachHis constants. */
export const BSE_ATTACHMENT_BASE_URL = BSE_ATTACHMENT_LIVE_BASE_URL;
export const BSE_REQUEST_TIMEOUT_MS = 20_000;
export const BSE_DEFAULT_SEARCH_LIMIT = 20;
export const BSE_MAX_SEARCH_LIMIT = 100;
export const BSE_DEFAULT_LOOKBACK_DAYS = 365;
export const BSE_ANNOUNCEMENT_PAGE_SIZE = 50;
export const BSE_MAX_ANNOUNCEMENT_PAGES = 20;

export const BSE_ANTIBOT_NOTE =
  "BSE's api.bseindia.com host is anti-bot protected (Akamai); the default " +
  "fetch may be throttled or blocked. For reliable access, inject a " +
  "browser-backed fetchFn via AdapterOptions.";

export const BSE_RATE_LIMIT_MESSAGE =
  "BSE India request limit reached. Please retry later.";

export class BseRateLimitError extends AdapterRateLimitError {
  constructor(message = BSE_RATE_LIMIT_MESSAGE) {
    super(message, 120, 60_000, "BSE India");
    this.name = "BseRateLimitError";
  }
}

export class BseApiError extends AdapterError {
  constructor(message: string) {
    super(message, "BSE India");
    this.name = "BseApiError";
  }
}

function acquireRequest(): void {
  if (!bseRateLimiter.tryAcquire()) throw new BseRateLimitError();
}

// PeerSmartSearch and AnnSubCategoryGetData require browser-issued headers.
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Origin: BSE_SITE_URL,
  Referer: `${BSE_SITE_URL}/`,
};

function mapHttpError(error: unknown, operation: string): unknown {
  if (error instanceof HttpError && error.status === 429) {
    return new BseRateLimitError();
  }
  if (error instanceof HttpError) {
    const blocked = error.status === 401 || error.status === 403 || error.status === 503;
    return new BseApiError(
      blocked
        ? `${operation} was blocked by BSE's anti-bot edge (HTTP ${error.status}). ` +
          "This is not an empty result. " + BSE_ANTIBOT_NOTE
        : `${operation} failed: ${error.message}`,
    );
  }
  return error;
}

// --- Resolution ------------------------------------------------------------

export function isBseScripCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

function isinFrom(chunk: string): string | undefined {
  const match = chunk.match(/\bIN[A-Z][0-9A-Z]{9}\b/);
  return match ? match[0] : undefined;
}

interface BseSearchRow {
  scripCode: string;
  name: string;
  isin?: string;
}

/** Parse PeerSmartSearch's HTML-fragment result rows. */
export function parseBsePeerSearch(html: string): BseSearchRow[] {
  const rows: BseSearchRow[] = [];
  const pattern = /liclick\('(\d+)'\s*,\s*'([^']*)'\)/g;
  const matches = Array.from(html.matchAll(pattern));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const scripCode = match[1];
    const name = decodeXmlEntities(match[2] ?? "").trim();
    if (!scripCode || !name) continue;
    const start = match.index ?? 0;
    const end = index + 1 < matches.length
      ? matches[index + 1]?.index ?? html.length
      : html.length;
    const isin = isinFrom(html.slice(start, end));
    rows.push({ scripCode, name, ...(isin ? { isin } : {}) });
  }
  return rows;
}

function searchRowToEntity(row: BseSearchRow, matchReason: string): Entity {
  return {
    legalName: row.name,
    scripCode: row.scripCode,
    ...(row.isin ? { isin: row.isin } : {}),
    jurisdiction: "IN",
    source: "BSE India",
    sourceIdentifiers: {
      scripCode: row.scripCode,
      ...(row.isin ? { isin: row.isin } : {}),
      jurisdiction: "IN",
    },
    sourceUrl: `${BSE_SITE_URL}/stock-share-price/x/x/${row.scripCode}/`,
    matchReason,
  };
}

export async function searchBseCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  acquireRequest();
  const url = `${BSE_SEARCH_URL}?Type=SS&text=${encodeURIComponent(trimmed)}`;
  let html: string;
  try {
    html = await getText(
      url,
      BROWSER_HEADERS,
      BSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    throw mapHttpError(error, "BSE company search");
  }
  const rows = parseBsePeerSearch(html);

  if (isBseScripCode(trimmed)) {
    const exact = rows.filter((row) => row.scripCode === trimmed);
    if (exact.length) {
      return exact.map((row) => searchRowToEntity(row, "Exact scrip-code match"));
    }
  }
  const entities = rows.map((row) =>
    searchRowToEntity(row, "BSE PeerSmartSearch result")
  );
  return rankEntities(trimmed, entities, {
    fallbackReason: "BSE PeerSmartSearch result",
  });
}

export async function resolveBseCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchBseCompanies(query, options))[0] ?? null;
}

async function resolveBseEntity(
  query: string,
  options: AdapterOptions,
): Promise<Entity & { scripCode: string }> {
  const entity = await resolveBseCompany(query, options);
  if (!entity?.scripCode) throw new BseApiError(`No BSE company found for ${query}.`);
  return { ...entity, scripCode: entity.scripCode };
}

// --- Announcement feed -----------------------------------------------------

function parseBseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatBseDate(value: unknown, fallback: string): string {
  const text = asString(value);
  if (!text) return fallback;
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : fallback;
}

function toBseDateParam(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

export function normalizeBseAttachmentName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return undefined;
  }
  if (
    decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0") ||
    decoded === "." || decoded === ".." || !/\.pdf$/i.test(decoded)
  ) {
    return undefined;
  }
  return decoded;
}

function announcementToFiling(
  row: Record<string, unknown>,
  fallbackDate: string,
): Filing | undefined {
  const headline = asString(row.HEADLINE) ?? asString(row.NEWSSUB);
  if (!headline) return undefined;
  const attachmentName = normalizeBseAttachmentName(asString(row.ATTACHMENTNAME) ?? "");
  const category = asString(row.CATEGORYNAME) ?? asString(row.News_submission_type);
  const subCategory = asString(row.SUBCATNAME);
  const newsId = asString(row.NEWSID);
  const scripCode = asString(row.SCRIP_CD);
  return {
    filedDate: formatBseDate(row.NEWS_DT ?? row.DissemDT, fallbackDate),
    form: category ?? "Announcement",
    ...(subCategory ? { category: subCategory } : {}),
    description: decodeXmlEntities(headline).trim(),
    ...(attachmentName ? { accession: attachmentName } : {}),
    sourceUrl: attachmentName
      ? `${BSE_ATTACHMENT_HIS_BASE_URL}/${encodeURIComponent(attachmentName)}`
      : `${BSE_SITE_URL}/corporates/ann.html`,
    source: "BSE India",
    sourceIdentifiers: {
      ...(scripCode ? { scripCode } : {}),
      ...(newsId ? { bseNewsId: newsId } : {}),
      jurisdiction: "IN",
    },
  };
}

export interface BseFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface BseFilingsResult {
  filings: Filing[];
  totalRows: number;
  pagesScanned: number;
  scanTruncated: boolean;
}

interface BseAnnouncementPage {
  rows: Array<Record<string, unknown>>;
  totalRows: number;
}

function parseBseTotal(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : Number(asString(value));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBseAnnouncementPage(text: string): BseAnnouncementPage {
  const trimmed = text.trim();
  if (/^"?No Record Found!"?$/i.test(trimmed)) {
    return { rows: [], totalRows: 0 };
  }
  const parsed = asRecord(parseBseJson(trimmed));
  const table = parsed?.Table;
  const totals = parsed?.Table1;
  if (!Array.isArray(table) || !Array.isArray(totals)) {
    const blocked = /<html|<!doctype|access denied|akamai|captcha/i.test(trimmed);
    throw new BseApiError(
      blocked
        ? "BSE announcements returned an anti-bot HTML page instead of data. " +
          "This is not an empty result. " + BSE_ANTIBOT_NOTE
        : "BSE announcements returned a malformed envelope (expected Table and Table1 arrays).",
    );
  }
  const totalRows = parseBseTotal(asRecord(totals[0])?.ROWCNT);
  if (totalRows === undefined) {
    throw new BseApiError("BSE announcements returned an invalid Table1[0].ROWCNT total.");
  }
  const rows = table.flatMap((value) => {
    const row = asRecord(value);
    return row ? [row] : [];
  });
  if (rows.length !== table.length) {
    throw new BseApiError("BSE announcements returned a non-object row in Table.");
  }
  return { rows, totalRows };
}

function filingMatchesForms(filing: Filing, forms: readonly string[]): boolean {
  if (!forms.length) return true;
  const haystack = `${filing.form} ${filing.description} ${filing.category ?? ""}`
    .toLowerCase();
  return forms.some((form) => {
    const needle = form.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

function filingDedupeKey(filing: Filing): string {
  const newsId = filing.sourceIdentifiers?.bseNewsId;
  if (newsId) return `news:${newsId}`;
  if (filing.accession) return `attachment:${filing.accession.toLowerCase()}`;
  return `row:${filing.filedDate}|${filing.form}|${filing.category ?? ""}|${filing.description}`;
}

function bseAnnouncementUrl(
  scripCode: string,
  pageNumber: number,
  startDate: string,
  endDate: string,
): string {
  const query = new URLSearchParams({
    pageno: String(pageNumber),
    strCat: "-1",
    subcategory: "-1",
    strPrevDate: toBseDateParam(startDate),
    strScrip: scripCode,
    strSearch: "P",
    strToDate: toBseDateParam(endDate),
    strType: "C",
  });
  return `${BSE_ANNOUNCEMENTS_URL}?${query}`;
}

async function fetchBseAnnouncementPage(
  url: string,
  options: AdapterOptions,
): Promise<BseAnnouncementPage> {
  acquireRequest();
  try {
    const text = await getText(
      url,
      BROWSER_HEADERS,
      BSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
    return parseBseAnnouncementPage(text);
  } catch (error) {
    if (error instanceof BseApiError) throw error;
    throw mapHttpError(error, "BSE announcement search");
  }
}

export async function getBseFilings(
  input: string | BseFilingSearchParams,
  options: AdapterOptions = {},
): Promise<BseFilingsResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveBseEntity(params.company, options);
  const limit = Math.min(
    BSE_MAX_SEARCH_LIMIT,
    Math.max(1, params.limit ?? BSE_DEFAULT_SEARCH_LIMIT),
  );
  const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);
  const startDate = params.startDate ??
    new Date(Date.now() - BSE_DEFAULT_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const forms = params.forms ?? [];
  const seen = new Set<string>();
  const filings: Filing[] = [];
  let totalRows = 0;
  let pagesScanned = 0;
  let totalPages = 1;

  for (let pageNumber = 1; pageNumber <= BSE_MAX_ANNOUNCEMENT_PAGES; pageNumber += 1) {
    const page = await fetchBseAnnouncementPage(
      bseAnnouncementUrl(entity.scripCode, pageNumber, startDate, endDate),
      options,
    );
    pagesScanned = pageNumber;
    if (pageNumber === 1) {
      totalRows = page.totalRows;
      totalPages = Math.max(1, Math.ceil(totalRows / BSE_ANNOUNCEMENT_PAGE_SIZE));
    } else if (page.totalRows !== totalRows) {
      throw new BseApiError(
        `BSE announcement total changed during pagination (${totalRows} to ${page.totalRows}).`,
      );
    }
    if (pageNumber > 1 && !page.rows.length && pageNumber <= totalPages) {
      throw new BseApiError(
        `BSE announcement page ${pageNumber} was empty before the declared total was exhausted.`,
      );
    }

    for (const row of page.rows) {
      const filing = announcementToFiling(row, endDate);
      if (!filing) continue;
      const key = filingDedupeKey(filing);
      if (seen.has(key)) continue;
      seen.add(key);
      if (filingMatchesForms(filing, forms)) filings.push(filing);
    }

    if (filings.length >= limit || pageNumber >= totalPages) break;
  }

  const scanTruncated =
    totalPages > BSE_MAX_ANNOUNCEMENT_PAGES &&
    pagesScanned === BSE_MAX_ANNOUNCEMENT_PAGES &&
    filings.length < limit;
  return {
    filings: filings
      .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
      .slice(0, limit),
    totalRows,
    pagesScanned,
    scanTruncated,
  };
}

export async function searchBseFilings(
  input: string | BseFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  return (await getBseFilings(input, options)).filings;
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveBseCompany;
export const searchCompanies = searchBseCompanies;
export const searchFilings = searchBseFilings;

export function createBseAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveBseCompany(query, options),
    searchEntities: (query: string) => searchBseCompanies(query, options),
    searchFilings: (input: string | BseFilingSearchParams) =>
      searchBseFilings(input, options),
  };
}
