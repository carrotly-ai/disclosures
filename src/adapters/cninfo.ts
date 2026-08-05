import {
  AdapterError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { HttpError, postForm } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { cninfoRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  LatestReportMetadata,
} from "../core/types.js";

// cninfo (巨潮资讯网) is the CSRC-designated disclosure portal for the Shanghai
// (SSE) and Shenzhen (SZSE) exchanges, and also mirrors many Hong Kong (HKEX)
// filings. It exposes a keyless company search plus a date-filterable
// announcement feed; both are POST form endpoints returning JSON.
export const CNINFO_BASE_URL = "https://www.cninfo.com.cn";
export const CNINFO_SEARCH_URL =
  "https://www.cninfo.com.cn/new/information/topSearch/query";
export const CNINFO_ANNOUNCEMENT_URL =
  "https://www.cninfo.com.cn/new/hisAnnouncement/query";
// Announcement PDFs live on the static host, keyed by the row's adjunctUrl.
export const CNINFO_STATIC_BASE_URL = "https://static.cninfo.com.cn";
export const CNINFO_REQUEST_TIMEOUT_MS = 20_000;

export const CNINFO_DEFAULT_SEARCH_LIMIT = 20;
export const CNINFO_MAX_PAGE_SIZE = 30;
export const CNINFO_MAX_PAGES = 10;

// Periodic-report category codes (verified live 2026-08-05). cninfo shares one
// code space across SSE/SZSE; the exchange is selected by the `column` field.
export const CNINFO_ANNUAL_CATEGORY = "category_ndbg_szsh";
export const CNINFO_HALF_YEAR_CATEGORY = "category_bndbg_szsh";
export const CNINFO_Q1_CATEGORY = "category_yjdbg_szsh";
export const CNINFO_Q3_CATEGORY = "category_sjdbg_szsh";
/** The interim (non-annual) periodic reports, newest-of used for "quarterly". */
export const CNINFO_QUARTERLY_CATEGORIES = [
  CNINFO_Q1_CATEGORY,
  CNINFO_Q3_CATEGORY,
  CNINFO_HALF_YEAR_CATEGORY,
] as const;

// Beijing is UTC+8; cninfo announcementTime epochs are local wall-clock, so we
// shift before slicing to recover the intended calendar date.
const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

export const CNINFO_RATE_LIMIT_MESSAGE =
  "cninfo request limit reached. Please retry later.";

export class CninfoRateLimitError extends AdapterRateLimitError {
  constructor(message = CNINFO_RATE_LIMIT_MESSAGE) {
    super(message, 300, 60_000, "cninfo");
    this.name = "CninfoRateLimitError";
  }
}

export class CninfoApiError extends AdapterError {
  constructor(message: string) {
    super(message, "cninfo");
    this.name = "CninfoApiError";
  }
}

function acquireRequest(): void {
  if (!cninfoRateLimiter.tryAcquire()) throw new CninfoRateLimitError();
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Referer: "https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
};

async function cninfoPost(
  url: string,
  form: Record<string, string | number | undefined>,
  options: AdapterOptions,
): Promise<unknown> {
  acquireRequest();
  try {
    return await postForm(
      url,
      form,
      BROWSER_HEADERS,
      CNINFO_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CninfoRateLimitError();
    }
    throw error;
  }
}

// --- Resolution ------------------------------------------------------------

/** cninfo organisation-id prefixes map to the announcement-feed `column`. */
export function exchangeColumnForOrgId(orgId: string): "sse" | "szse" | "hke" {
  const prefix = orgId.slice(0, 4).toLowerCase();
  if (prefix === "gssh") return "sse";
  if (prefix === "gshk") return "hke";
  return "szse";
}

export function exchangeLabel(column: "sse" | "szse" | "hke"): string {
  if (column === "sse") return "Shanghai Stock Exchange";
  if (column === "hke") return "Hong Kong (via cninfo)";
  return "Shenzhen Stock Exchange";
}

export function isChineseStockCode(value: string): boolean {
  // A-shares are 6 digits; HKEX equities are commonly shown as 5 digits.
  return /^\d{5,6}$/.test(value.trim());
}

function disclosureUrl(stockCode: string, orgId: string): string {
  const params = new URLSearchParams({ stockCode, orgId });
  return `${CNINFO_BASE_URL}/new/disclosure/stock?${params.toString()}`;
}

interface CninfoSearchRow {
  code: string;
  orgId: string;
  shortName: string;
  pinyin?: string;
  category?: string;
  delisted: boolean;
}

function parseSearchRow(value: unknown): CninfoSearchRow | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const code = asString(row.code);
  const orgId = asString(row.orgId);
  const shortName = asString(row.zwjc);
  if (!code || !orgId || !shortName) return undefined;
  const delistedRaw = row.delisted;
  const delisted = delistedRaw === true || delistedRaw === "true" ||
    delistedRaw === 1 || delistedRaw === "1";
  const pinyin = asString(row.pinyin);
  const category = asString(row.category);
  return {
    code,
    orgId,
    shortName,
    ...(pinyin ? { pinyin } : {}),
    ...(category ? { category } : {}),
    delisted,
  };
}

export interface CninfoEntity extends Entity {
  stockCode: string;
  orgId: string;
  column: "sse" | "szse" | "hke";
}

function searchRowToEntity(
  row: CninfoSearchRow,
  matchReason: string,
): CninfoEntity {
  const column = exchangeColumnForOrgId(row.orgId);
  const status = row.delisted ? "Delisted" : row.category ?? undefined;
  return {
    legalName: row.shortName,
    stockCode: row.code,
    orgId: row.orgId,
    column,
    jurisdiction: "CN",
    source: "cninfo",
    sourceIdentifiers: {
      stockCode: row.code,
      orgId: row.orgId,
      jurisdiction: "CN",
    },
    sourceUrl: disclosureUrl(row.code, row.orgId),
    ...(row.pinyin ? { aliases: [`${exchangeLabel(column)} · ${row.pinyin}`] } : {
      aliases: [exchangeLabel(column)],
    }),
    ...(status ? { status } : {}),
    matchReason,
  };
}

export async function searchCninfoCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<CninfoEntity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const payload = await cninfoPost(
    CNINFO_SEARCH_URL,
    { keyWord: trimmed, maxNum: 10 },
    options,
  );
  // topSearch returns a bare JSON array (occasionally wrapped in { records }).
  const rawRows = Array.isArray(payload)
    ? payload
    : asArray(asRecord(payload)?.records);
  const rows = rawRows
    .map(parseSearchRow)
    .filter((row): row is CninfoSearchRow => row !== undefined);

  if (isChineseStockCode(trimmed)) {
    const exact = rows.filter((row) => row.code === trimmed);
    const chosen = exact.length ? exact : rows;
    return chosen.map((row) => searchRowToEntity(row, "Exact stock-code match"));
  }
  // cninfo's search is already relevance-ordered; preserve its ranking.
  return rows.map((row) => searchRowToEntity(row, "cninfo search result"));
}

export async function resolveCninfoCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<CninfoEntity | null> {
  return (await searchCninfoCompanies(query, options))[0] ?? null;
}

async function resolveCninfoEntity(
  query: string,
  options: AdapterOptions,
): Promise<CninfoEntity> {
  const entity = await resolveCninfoCompany(query, options);
  if (!entity) throw new Error(`No cninfo company found for ${query}.`);
  return entity;
}

// --- Announcement feed -----------------------------------------------------

function formatAnnouncementDate(value: unknown, fallback: string): string {
  const ms = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : Number.NaN;
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms + CN_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function announcementToFiling(
  row: Record<string, unknown>,
  scanDate: string,
): Filing | undefined {
  const adjunctUrl = asString(row.adjunctUrl);
  const title = asString(row.announcementTitle);
  if (!adjunctUrl || !title) return undefined;
  const secName = asString(row.secName);
  const secCode = asString(row.secCode);
  const orgId = asString(row.orgId);
  const announcementId = asString(row.announcementId);
  const typeName = asString(row.announcementTypeName);
  return {
    filedDate: formatAnnouncementDate(row.announcementTime, scanDate),
    form: typeName ?? "Announcement (公告)",
    ...(secName ? { category: secName } : {}),
    description: title,
    ...(announcementId ? { accession: announcementId } : {}),
    // adjunctUrl is a site-relative path like finalpage/2026-04-17/….PDF
    sourceUrl: `${CNINFO_STATIC_BASE_URL}/${adjunctUrl.replace(/^\/+/, "")}`,
    source: "cninfo",
    sourceIdentifiers: {
      ...(secCode ? { stockCode: secCode } : {}),
      ...(orgId ? { orgId } : {}),
      jurisdiction: "CN",
    },
  };
}

interface CninfoQueryParams {
  entity: CninfoEntity;
  category?: string;
  startDate?: string;
  endDate?: string;
  pageSize: number;
  pageNum: number;
}

async function fetchAnnouncementPage(
  params: CninfoQueryParams,
  options: AdapterOptions,
): Promise<{ filings: Filing[]; hasMore: boolean }> {
  const { entity } = params;
  const seDate = params.startDate && params.endDate
    ? `${params.startDate}~${params.endDate}`
    : undefined;
  const payload = await cninfoPost(
    CNINFO_ANNOUNCEMENT_URL,
    {
      pageNum: params.pageNum,
      pageSize: params.pageSize,
      column: entity.column,
      tabName: "fulltext",
      stock: `${entity.stockCode},${entity.orgId}`,
      isHLtitle: "true",
      ...(params.category ? { category: params.category } : {}),
      ...(seDate ? { seDate } : {}),
    },
    options,
  );
  const record = asRecord(payload);
  if (!record) throw new CninfoApiError("cninfo returned an unexpected response.");
  const scanDate = params.endDate ?? new Date().toISOString().slice(0, 10);
  const filings = asArray(record.announcements).flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const filing = announcementToFiling(row, scanDate);
    return filing ? [filing] : [];
  });
  const total = typeof record.totalAnnouncement === "number"
    ? record.totalAnnouncement
    : 0;
  const hasMore = params.pageNum * params.pageSize < total && filings.length > 0;
  return { filings, hasMore };
}

async function collectAnnouncements(
  entity: CninfoEntity,
  category: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
  limit: number,
  options: AdapterOptions,
): Promise<Filing[]> {
  const pageSize = Math.min(Math.max(limit, 1), CNINFO_MAX_PAGE_SIZE);
  const filings: Filing[] = [];
  for (let page = 1; page <= CNINFO_MAX_PAGES; page += 1) {
    const { filings: pageFilings, hasMore } = await fetchAnnouncementPage(
      { entity, ...(category ? { category } : {}), ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), pageSize, pageNum: page },
      options,
    );
    filings.push(...pageFilings);
    if (filings.length >= limit || !hasMore) break;
  }
  return filings;
}

export interface CninfoFilingSearchParams {
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

export async function searchCninfoFilings(
  input: string | CninfoFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveCninfoEntity(params.company, options);
  const limit = Math.max(1, params.limit ?? CNINFO_DEFAULT_SEARCH_LIMIT);
  const filings = await collectAnnouncements(
    entity,
    undefined,
    params.startDate,
    params.endDate,
    limit,
    options,
  );
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

export async function getLatestCninfoReport(
  company: string,
  reportKind: "annual" | "quarterly",
  options: AdapterOptions = {},
): Promise<LatestReportMetadata | null> {
  const entity = await resolveCninfoEntity(company, options);
  const categories = reportKind === "annual"
    ? [CNINFO_ANNUAL_CATEGORY]
    : CNINFO_QUARTERLY_CATEGORIES;
  const collected: Filing[] = [];
  for (const category of categories) {
    const filings = await collectAnnouncements(
      entity,
      category,
      undefined,
      undefined,
      5,
      options,
    );
    collected.push(...filings);
  }
  const match = collected
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))[0];
  if (!match) return null;
  return {
    ...match,
    reportKind,
    sectionLinks: [
      {
        section: "cninfo-pdf",
        description: `cninfo full-text PDF — ${match.description}`,
        url: match.sourceUrl,
      },
    ],
  };
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveCninfoCompany;
export const searchCompanies = searchCninfoCompanies;
export const searchFilings = searchCninfoFilings;
export const getLatestReport = getLatestCninfoReport;

export function createCninfoAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveCninfoCompany(query, options),
    searchEntities: (query: string) => searchCninfoCompanies(query, options),
    searchFilings: (input: string | CninfoFilingSearchParams) =>
      searchCninfoFilings(input, options),
    getLatestReport: (company: string, reportKind: "annual" | "quarterly") =>
      getLatestCninfoReport(company, reportKind, options),
  };
}
