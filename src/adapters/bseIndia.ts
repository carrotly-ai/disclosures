import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getText, HttpError } from "../core/http.js";
import { asArray, asRecord, asString, decodeXmlEntities } from "../core/parsing.js";
import { bseRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity, Filing } from "../core/types.js";

// BSE (Bombay Stock Exchange) is India's primary machine-readable disclosure
// source here. Its `api.bseindia.com` host is aggressively anti-bot (Akamai):
// the company search and announcement feed answer plain requests with browser
// headers, but the shareholding-pattern endpoints redirect to a WAF error page.
// So this "BSE-lite" adapter ships resolution + a filings feed on the default
// fetch, and documents that promoter / 1%+ shareholding data needs an injected
// browser-backed fetchFn via AdapterOptions.
export const BSE_SITE_URL = "https://www.bseindia.com";
export const BSE_API_BASE_URL = "https://api.bseindia.com/BseIndiaAPI/api";
export const BSE_SEARCH_URL = `${BSE_API_BASE_URL}/PeerSmartSearch/w`;
export const BSE_ANNOUNCEMENTS_URL = `${BSE_API_BASE_URL}/AnnGetData/w`;
export const BSE_ATTACHMENT_BASE_URL =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive";
export const BSE_REQUEST_TIMEOUT_MS = 20_000;
export const BSE_DEFAULT_SEARCH_LIMIT = 20;
export const BSE_DEFAULT_LOOKBACK_DAYS = 365;

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

// PeerSmartSearch / AnnGetData reject requests that do not look browser-issued.
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
};

function mapHttpError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 429) {
    return new BseRateLimitError();
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

/**
 * PeerSmartSearch returns an HTML fragment: one <li> per hit carrying an
 * onclick `liclick('<scripCode>','<company name>')` plus the ISIN in the row
 * text. Parse those two anchors rather than assuming full markup structure.
 */
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
    throw mapHttpError(error);
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
): Promise<Entity> {
  const entity = await resolveBseCompany(query, options);
  if (!entity?.scripCode) throw new Error(`No BSE company found for ${query}.`);
  return entity;
}

// --- Announcement feed -----------------------------------------------------

/** BSE's AnnGetData answers with JSON on a hit and a bare string when empty. */
function parseBseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
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

function announcementToFiling(
  row: Record<string, unknown>,
  fallbackDate: string,
): Filing | undefined {
  const headline = asString(row.HEADLINE) ?? asString(row.NEWSSUB);
  if (!headline) return undefined;
  const attachment = asString(row.ATTACHMENTNAME);
  const category = asString(row.CATEGORYNAME) ?? asString(row.News_submission_type);
  const subCategory = asString(row.SUBCATNAME);
  const newsId = asString(row.NEWSID) ?? asString(row.SCRIP_CD);
  return {
    filedDate: formatBseDate(row.NEWS_DT ?? row.DissemDT, fallbackDate),
    form: category ?? "Announcement",
    ...(subCategory ? { category: subCategory } : {}),
    description: decodeXmlEntities(headline).trim(),
    ...(newsId ? { accession: newsId } : {}),
    sourceUrl: attachment
      ? `${BSE_ATTACHMENT_BASE_URL}/${attachment}`
      : `${BSE_SITE_URL}/corporates/ann.html`,
    source: "BSE India",
    sourceIdentifiers: { jurisdiction: "IN" },
  };
}

export interface BseFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
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

export async function searchBseFilings(
  input: string | BseFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveBseEntity(params.company, options);
  const limit = Math.max(1, params.limit ?? BSE_DEFAULT_SEARCH_LIMIT);
  const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);
  const startDate = params.startDate ??
    new Date(Date.now() - BSE_DEFAULT_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

  const url = `${BSE_ANNOUNCEMENTS_URL}?pageno=1&strCat=-1&strPrevDate=${
    toBseDateParam(startDate)
  }&strScrip=${entity.scripCode}&strSearch=P&strToDate=${
    toBseDateParam(endDate)
  }&strType=C`;

  acquireRequest();
  let text: string;
  try {
    text = await getText(
      url,
      BROWSER_HEADERS,
      BSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    throw mapHttpError(error);
  }
  // A populated feed answers with JSON `{ "Table": [...] }`; an empty or
  // blocked feed answers with the bare (sometimes unquoted) string
  // "No Record Found!". Parse defensively so either shape degrades to [].
  const table = asArray(asRecord(parseBseJson(text))?.Table);
  const filings = table.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const filing = announcementToFiling(row, endDate);
    return filing ? [filing] : [];
  });
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
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
