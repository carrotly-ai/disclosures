import { readCachedJson, writeCachedJson } from "../core/cache.js";
import { rankEntities } from "../core/entityMatching.js";
import {
  AdapterConfigurationError,
  AdapterError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { getBinary, getJson } from "../core/http.js";
import {
  asArray,
  asRecord,
  asString,
  escapeRegExp,
  type JsonRecord,
} from "../core/parsing.js";
import { openDartRateLimiter } from "../core/rateLimiter.js";
import { readSingleZipEntry } from "../core/zip.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  FinancialBasis,
  FinancialFact,
  Insider,
  LatestReportMetadata,
  OwnerRecord,
} from "../core/types.js";

export const OPEN_DART_BASE_URL = "https://opendart.fss.or.kr/api";
export const OPEN_DART_VIEWER_URL = "https://dart.fss.or.kr/dsaf001/main.do";
export const OPEN_DART_COMPANY_URL = "https://dart.fss.or.kr/dsae001/selectPopup.do";
export const OPEN_DART_REQUEST_TIMEOUT_MS = 20_000;
export const OPEN_DART_PAGE_SIZE = 100;
export const OPEN_DART_MAX_PAGES = 10;
export const OPEN_DART_MAX_RESULTS = OPEN_DART_PAGE_SIZE * OPEN_DART_MAX_PAGES;
export const OPEN_DART_DEFAULT_FINANCIAL_PERIODS = 5;
export const OPEN_DART_FIRST_DATA_YEAR = 2015;

export const OPEN_DART_REPORT_CODES = {
  annual: "11011",
  half: "11012",
  q1: "11013",
  q3: "11014",
} as const;

export const OPEN_DART_5_PERCENT_THRESHOLD_REGIME =
  "Korea 5% rule — mass-holding report under the Financial Investment Services " +
  "and Capital Markets Act (report on holdings of 5% or more, or a change of 1% or more)";

export const OPEN_DART_INSIDER_REGIME =
  "Korea executive/major-shareholder ownership report (특정증권등 소유상황보고)";

export const OPEN_DART_NO_CONFIG_MESSAGE =
  "OpenDART requires an API key. Set OPENDART_API_KEY.";
export const OPEN_DART_MISSING_API_KEY_MESSAGE = OPEN_DART_NO_CONFIG_MESSAGE;
export const NO_OPEN_DART_CONFIG_MESSAGE = OPEN_DART_NO_CONFIG_MESSAGE;
export const OPEN_DART_RATE_LIMIT_MESSAGE =
  "OpenDART request limit reached (20,000 requests per day). Please retry later.";

export class OpenDartConfigurationError extends AdapterConfigurationError {
  constructor(message = OPEN_DART_NO_CONFIG_MESSAGE) {
    super(message, "OpenDART");
    this.name = "OpenDartConfigurationError";
  }
}

export class OpenDartRateLimitError extends AdapterRateLimitError {
  constructor(message = OPEN_DART_RATE_LIMIT_MESSAGE) {
    super(message, 20_000, 24 * 60 * 60_000, "OpenDART");
    this.name = "OpenDartRateLimitError";
  }
}

/** OpenDART returns a documented `status` code with every request. */
export class OpenDartApiError extends AdapterError {
  constructor(
    readonly status: string,
    message: string,
  ) {
    super(message, "OpenDART");
    this.name = "OpenDartApiError";
  }
}

const OPEN_DART_STATUS_MESSAGES: Record<string, string> = {
  "010": "OpenDART rejected the API key (not registered).",
  "011": "OpenDART rejected the API key (temporarily suspended).",
  "012": "OpenDART rejected the request (IP address not permitted).",
  "013": "OpenDART returned no data for this query.",
  "014": "OpenDART reported the requested file does not exist.",
  "020": OPEN_DART_RATE_LIMIT_MESSAGE,
  "021": "OpenDART query exceeded the maximum number of companies (100).",
  "100": "OpenDART rejected a request field value.",
  "101": "OpenDART rejected the request (improper access).",
  "800": "OpenDART is temporarily unavailable for maintenance.",
  "900": "OpenDART returned an undefined error.",
  "901": "OpenDART rejected the API key (account retention period expired).",
};

export interface OpenDartCorpCode {
  corpCode: string;
  corpName: string;
  corpEngName?: string;
  stockCode?: string;
  modifyDate?: string;
}

export interface OpenDartFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface OpenDartFinancialParams {
  concepts?: readonly string[];
  years?: readonly number[];
  periods?: number;
}

/**
 * Map the standard DART major-account names to the shared canonical concepts
 * used by the SEC adapter, so cross-jurisdiction financial output lines up.
 * OpenDART's major-accounts endpoint exposes the headline balance-sheet and
 * income-statement lines only; concepts without a major-account equivalent
 * (EPS, cash flow, R&D) are intentionally absent for KR.
 */
export const OPEN_DART_ACCOUNT_CONCEPTS: Record<
  string,
  { concept: string; label: string; aliases: readonly string[] }
> = {
  total_assets: { concept: "total_assets", label: "Total assets", aliases: ["자산총계"] },
  total_liabilities: {
    concept: "total_liabilities",
    label: "Total liabilities",
    aliases: ["부채총계"],
  },
  stockholders_equity: {
    concept: "stockholders_equity",
    label: "Total equity",
    aliases: ["자본총계"],
  },
  revenue: { concept: "revenue", label: "Revenue", aliases: ["매출액", "영업수익", "수익"] },
  operating_income: {
    concept: "operating_income",
    label: "Operating income",
    aliases: ["영업이익"],
  },
  net_income: {
    concept: "net_income",
    label: "Net income",
    aliases: ["당기순이익", "당기순이익손실"],
  },
};

export const OPEN_DART_FINANCIAL_CONCEPT_NAMES = Object.keys(OPEN_DART_ACCOUNT_CONCEPTS);

function normalizeAccountName(value: string): string {
  return value.replace(/\s+/g, "").replace(/[()[\]]/g, "");
}

const ACCOUNT_LOOKUP = new Map<string, { concept: string; label: string }>();
for (const spec of Object.values(OPEN_DART_ACCOUNT_CONCEPTS)) {
  for (const alias of spec.aliases) {
    ACCOUNT_LOOKUP.set(normalizeAccountName(alias), {
      concept: spec.concept,
      label: spec.label,
    });
  }
}

export function getOpenDartApiKeyOrUndefined(
  options: AdapterOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  return env.OPENDART_API_KEY?.trim() || undefined;
}

export function getOpenDartApiKey(options: AdapterOptions = {}): string {
  const apiKey = getOpenDartApiKeyOrUndefined(options);
  if (!apiKey) throw new OpenDartConfigurationError();
  return apiKey;
}

export function hasOpenDartConfiguration(options: AdapterOptions = {}): boolean {
  return getOpenDartApiKeyOrUndefined(options) !== undefined;
}

export function getOpenDartConfigurationError(
  options: AdapterOptions = {},
): OpenDartConfigurationError | undefined {
  return hasOpenDartConfiguration(options)
    ? undefined
    : new OpenDartConfigurationError();
}

function acquireRequest(): void {
  if (!openDartRateLimiter.tryAcquire()) throw new OpenDartRateLimitError();
}

function buildUrl(path: string, params: Record<string, string>, apiKey: string): string {
  const url = new URL(`${OPEN_DART_BASE_URL}/${path}`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function interpretStatus(status: string, message: string | undefined): void {
  if (status === "020") throw new OpenDartRateLimitError();
  const detail = message ?? OPEN_DART_STATUS_MESSAGES[status] ??
    `OpenDART returned status ${status}.`;
  throw new OpenDartApiError(status, detail);
}

/**
 * Issue a JSON request. A documented "no data" status (013) resolves to null so
 * callers can degrade to an empty result rather than surfacing an error, while
 * every other non-success status raises a typed error.
 */
async function requestJson(
  path: string,
  params: Record<string, string>,
  options: AdapterOptions,
): Promise<JsonRecord | null> {
  const apiKey = getOpenDartApiKey(options);
  acquireRequest();
  const payload = await getJson(
    buildUrl(path, params, apiKey),
    { Accept: "application/json" },
    OPEN_DART_REQUEST_TIMEOUT_MS,
    options.fetchFn ?? fetch,
  );
  const record = asRecord(payload);
  if (!record) throw new OpenDartApiError("", "OpenDART returned a malformed response.");
  const status = asString(record.status) ?? "";
  if (status === "000") return record;
  if (status === "013") return null;
  interpretStatus(status, asString(record.message));
  return null;
}

// --- Corp-code resolution ---------------------------------------------------

let corpCodeListPromise: Promise<OpenDartCorpCode[]> | undefined;

/** Cross-call cache key + TTL for the corp-code archive (regenerated daily). */
export const OPEN_DART_CORP_CODE_CACHE_KEY = "opendart:corp-code:v1";
export const OPEN_DART_CORP_CODE_CACHE_TTL_MS = 24 * 60 * 60_000;

export function resetOpenDartCorpCodeCache(): void {
  corpCodeListPromise = undefined;
}

/** Validate a cached corp-code payload; a bad shape returns undefined (miss). */
function parseCorpCodeCache(value: unknown): OpenDartCorpCode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: OpenDartCorpCode[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const corpCode = asString(record?.corpCode);
    const corpName = asString(record?.corpName);
    if (!corpCode || !corpName) return undefined;
    const corpEngName = asString(record?.corpEngName);
    const stockCode = asString(record?.stockCode);
    const modifyDate = asString(record?.modifyDate);
    entries.push({
      corpCode,
      corpName,
      ...(corpEngName ? { corpEngName } : {}),
      ...(stockCode ? { stockCode } : {}),
      ...(modifyDate ? { modifyDate } : {}),
    });
  }
  return entries.length ? entries : undefined;
}

function fieldValue(block: string, field: string): string | undefined {
  const pattern = new RegExp(
    `<${escapeRegExp(field)}>([\\s\\S]*?)</${escapeRegExp(field)}>`,
    "i",
  );
  const match = block.match(pattern);
  if (!match) return undefined;
  const raw = (match[1] ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();
  return raw || undefined;
}

export function parseOpenDartCorpCodeXml(xml: string): OpenDartCorpCode[] {
  const blocks = xml.match(/<list>[\s\S]*?<\/list>/gi) ?? [];
  const entries: OpenDartCorpCode[] = [];
  for (const block of blocks) {
    const corpCode = fieldValue(block, "corp_code");
    const corpName = fieldValue(block, "corp_name");
    if (!corpCode || !corpName) continue;
    const corpEngName = fieldValue(block, "corp_eng_name");
    const stockCode = fieldValue(block, "stock_code");
    const modifyDate = fieldValue(block, "modify_date");
    entries.push({
      corpCode,
      corpName,
      ...(corpEngName ? { corpEngName } : {}),
      ...(stockCode ? { stockCode } : {}),
      ...(modifyDate ? { modifyDate } : {}),
    });
  }
  return entries;
}

async function fetchCorpCodes(options: AdapterOptions): Promise<OpenDartCorpCode[]> {
  const apiKey = getOpenDartApiKey(options);
  acquireRequest();
  const archive = await getBinary(
    buildUrl("corpCode.xml", {}, apiKey),
    { Accept: "application/zip, application/octet-stream, */*" },
    OPEN_DART_REQUEST_TIMEOUT_MS,
    options.fetchFn ?? fetch,
  );
  const entry = readSingleZipEntry(archive, { maxEntrySize: 256 * 1024 * 1024 });
  const xml = new TextDecoder("utf-8").decode(entry.data);
  const entries = parseOpenDartCorpCodeXml(xml);
  if (!entries.length) {
    throw new OpenDartApiError("", "OpenDART corp-code archive contained no entries.");
  }
  return entries;
}

async function loadCorpCodes(options: AdapterOptions): Promise<OpenDartCorpCode[]> {
  // Prefer an injected cross-call cache (survives process restarts) so the
  // multi-MB archive is not re-downloaded on every cold start.
  if (options.cache) {
    const cached = await readCachedJson(
      options.cache,
      OPEN_DART_CORP_CODE_CACHE_KEY,
      parseCorpCodeCache,
    );
    if (cached) return cached;
  }
  // The corp-code archive lists every filer; also memoize it per process. A
  // fresh AdapterOptions.fetchFn (e.g. per test) still shares this in-memory
  // cache, so tests reset it explicitly via resetOpenDartCorpCodeCache().
  corpCodeListPromise ??= fetchCorpCodes(options);
  let entries: OpenDartCorpCode[];
  try {
    entries = await corpCodeListPromise;
  } catch (error) {
    corpCodeListPromise = undefined;
    throw error;
  }
  if (options.cache) {
    await writeCachedJson(
      options.cache,
      OPEN_DART_CORP_CODE_CACHE_KEY,
      entries,
      OPEN_DART_CORP_CODE_CACHE_TTL_MS,
    );
  }
  return entries;
}

function companyViewerUrl(corpCode: string): string {
  return `${OPEN_DART_COMPANY_URL}?selectKey=${encodeURIComponent(corpCode)}`;
}

function filingViewerUrl(rceptNo: string): string {
  return `${OPEN_DART_VIEWER_URL}?rcpNo=${encodeURIComponent(rceptNo)}`;
}

function corpEntity(entry: OpenDartCorpCode, matchReason?: string): Entity {
  return {
    legalName: entry.corpName,
    corpCode: entry.corpCode,
    ...(entry.stockCode ? { stockCode: entry.stockCode } : {}),
    jurisdiction: "KR",
    source: "OpenDART",
    sourceIdentifiers: {
      corpCode: entry.corpCode,
      ...(entry.stockCode ? { stockCode: entry.stockCode } : {}),
      jurisdiction: "KR",
    },
    sourceUrl: companyViewerUrl(entry.corpCode),
    ...(entry.corpEngName ? { aliases: [entry.corpEngName] } : {}),
    ...(entry.stockCode ? { status: "Listed" } : {}),
    ...(matchReason ? { matchReason } : {}),
  };
}

export function isOpenDartCorpCode(value: string): boolean {
  return /^\d{8}$/.test(value.trim());
}

export function isOpenDartStockCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

export async function searchOpenDartCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const entries = await loadCorpCodes(options);

  if (isOpenDartCorpCode(trimmed)) {
    const entry = entries.find((candidate) => candidate.corpCode === trimmed);
    return entry ? [corpEntity(entry, "Exact OpenDART corp-code match")] : [];
  }
  if (isOpenDartStockCode(trimmed)) {
    const matches = entries.filter((candidate) => candidate.stockCode === trimmed);
    return matches.map((entry) => corpEntity(entry, "Exact stock-code match"));
  }

  // Name search: restrict candidates by a normalized substring before ranking,
  // because the corp-code list holds every filer and ranking all of them is
  // both slow and noisy.
  const needle = trimmed.toLowerCase();
  const candidates = entries
    .filter((entry) =>
      entry.corpName.toLowerCase().includes(needle) ||
      (entry.corpEngName?.toLowerCase().includes(needle) ?? false)
    )
    .slice(0, 200)
    .map((entry) => corpEntity(entry));
  return rankEntities(trimmed, candidates, {
    fallbackReason: "OpenDART legal-name search result",
  }).slice(0, 25);
}

export async function resolveOpenDartCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchOpenDartCompanies(query, options))[0] ?? null;
}

export async function resolveOpenDartCorpCode(
  query: string,
  options: AdapterOptions = {},
): Promise<string> {
  const entity = await resolveOpenDartCompany(query, options);
  if (!entity?.corpCode) {
    throw new Error(`No OpenDART company found for ${query}.`);
  }
  return entity.corpCode;
}

// --- Shared value parsing ---------------------------------------------------

function formatDartDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return value.trim() || undefined;
}

export function parseKoreanAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  let text = value.trim();
  if (!text || text === "-" || text === "△" || text === "-") return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/^[△▲-]/.test(text)) {
    negative = true;
    text = text.replace(/^[△▲-]/, "");
  }
  const cleaned = text.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -parsed : parsed;
}

function sourceIdentifiers(corpCode: string, stockCode?: string) {
  return {
    corpCode,
    ...(stockCode ? { stockCode } : {}),
    jurisdiction: "KR",
  };
}

// --- Filings ----------------------------------------------------------------

function toDartDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : undefined;
}

function parseFiling(value: unknown): Filing | undefined {
  const item = asRecord(value);
  const rceptNo = asString(item?.rcept_no);
  const reportName = asString(item?.report_nm);
  const rceptDt = asString(item?.rcept_dt);
  if (!rceptNo || !reportName || !rceptDt) return undefined;
  const corpCode = asString(item?.corp_code) ?? "";
  const stockCode = asString(item?.stock_code);
  const flrNm = asString(item?.flr_nm);
  return {
    filedDate: formatDartDate(rceptDt) ?? rceptDt,
    form: reportName,
    ...(flrNm ? { category: flrNm } : {}),
    description: reportName,
    accession: rceptNo,
    sourceUrl: filingViewerUrl(rceptNo),
    source: "OpenDART",
    sourceIdentifiers: sourceIdentifiers(corpCode, stockCode),
  };
}

export function parseOpenDartFilingPage(value: unknown): Filing[] {
  return asArray(asRecord(value)?.list).flatMap((item) => {
    const filing = parseFiling(item);
    return filing ? [filing] : [];
  });
}

function filingMatches(filing: Filing, filters: readonly string[]): boolean {
  if (!filters.length) return true;
  const haystack = `${filing.form} ${filing.category ?? ""}`.toLowerCase();
  return filters.some((filter) => {
    const needle = filter.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

interface FilingLoadOptions {
  publicationType?: string;
}

async function loadOpenDartFilings(
  corpCode: string,
  params: OpenDartFilingSearchParams,
  loadOptions: FilingLoadOptions,
  options: AdapterOptions,
): Promise<Filing[]> {
  const filings: Filing[] = [];
  const begin = toDartDate(params.startDate);
  const end = toDartDate(params.endDate);

  for (let page = 1; page <= OPEN_DART_MAX_PAGES; page += 1) {
    const record = await requestJson("list.json", {
      corp_code: corpCode,
      ...(begin ? { bgn_de: begin } : {}),
      ...(end ? { end_de: end } : {}),
      ...(loadOptions.publicationType ? { pblntf_ty: loadOptions.publicationType } : {}),
      page_no: String(page),
      page_count: String(OPEN_DART_PAGE_SIZE),
    }, options);
    if (!record) break;
    filings.push(...parseOpenDartFilingPage(record));
    const totalPage = Number(asString(record.total_page) ?? "0");
    if (!Number.isFinite(totalPage) || page >= totalPage) break;
    if (filings.length >= OPEN_DART_MAX_RESULTS) break;
  }
  return filings.slice(0, OPEN_DART_MAX_RESULTS);
}

export async function searchOpenDartFilings(
  input: string | OpenDartFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const corpCode = await resolveOpenDartCorpCode(params.company, options);
  const filters = params.forms ?? [];
  const limit = Math.min(
    OPEN_DART_MAX_RESULTS,
    Math.max(1, params.limit ?? 20),
  );
  const filings = await loadOpenDartFilings(corpCode, params, {}, options);
  return filings
    .filter((filing) => filingMatches(filing, filters))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

export async function getLatestOpenDartReport(
  company: string,
  reportKind: "annual" | "quarterly",
  options: AdapterOptions = {},
): Promise<LatestReportMetadata | null> {
  const corpCode = await resolveOpenDartCorpCode(company, options);
  // 정기공시 (pblntf_ty=A) covers annual, half, and quarterly periodic reports.
  const filings = await loadOpenDartFilings(
    corpCode,
    { company },
    { publicationType: "A" },
    options,
  );
  const needles = reportKind === "annual"
    ? ["사업보고서"]
    : ["분기보고서", "반기보고서"];
  const match = filings
    .filter((filing) => needles.some((needle) => filing.form.includes(needle)))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))[0];
  if (!match) return null;
  return {
    ...match,
    reportKind,
    sectionLinks: [
      {
        section: "dart-viewer",
        description: "DART disclosure viewer (report document)",
        url: match.sourceUrl,
      },
    ],
  };
}

// --- Insiders (임원·주요주주 소유보고 / elestock) ---------------------------

function parseInsider(value: unknown): Insider | undefined {
  const item = asRecord(value);
  const name = asString(item?.repror);
  const rceptNo = asString(item?.rcept_no);
  if (!name || !rceptNo) return undefined;
  const corpCode = asString(item?.corp_code) ?? "";
  const registered = asString(item?.isu_exctv_rgist_at);
  const officerRole = asString(item?.isu_exctv_ofcps);
  const mainShareholder = asString(item?.isu_main_shrholdr);
  const heldCount = parseKoreanAmount(asString(item?.sp_stock_lmp_cnt));
  const heldChange = parseKoreanAmount(asString(item?.sp_stock_lmp_irds_cnt));
  const pct = parseKoreanAmount(asString(item?.sp_stock_lmp_rate));
  const filedDate = formatDartDate(asString(item?.rcept_dt)) ?? "Not stated";
  const roles = [
    officerRole,
    registered,
    mainShareholder,
    heldCount !== undefined ? `Holds ${heldCount.toLocaleString("en-US")} securities` : undefined,
  ].filter((role): role is string => Boolean(role));
  return {
    name,
    roles,
    ...(officerRole ? { officerRole } : {}),
    ...(registered ? { status: registered } : {}),
    form: "특정증권등 소유상황보고서",
    filedDate,
    ...(pct !== undefined ? { pct } : {}),
    ...(heldChange !== undefined ? { change: heldChange } : {}),
    accession: rceptNo,
    sourceUrl: filingViewerUrl(rceptNo),
    source: "OpenDART",
    sourceIdentifiers: sourceIdentifiers(corpCode),
  };
}

export function parseOpenDartInsiders(value: unknown): Insider[] {
  return asArray(asRecord(value)?.list).flatMap((item) => {
    const insider = parseInsider(item);
    return insider ? [insider] : [];
  });
}

export async function getOpenDartInsiders(
  company: string,
  options: AdapterOptions = {},
): Promise<Insider[]> {
  const corpCode = await resolveOpenDartCorpCode(company, options);
  const record = await requestJson("elestock.json", { corp_code: corpCode }, options);
  if (!record) return [];
  return parseOpenDartInsiders(record)
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate));
}

// --- Owners (주식등의 대량보유상황보고 / majorstock) --------------------------

function parseOwner(value: unknown): OwnerRecord | undefined {
  const item = asRecord(value);
  const holderName = asString(item?.repror);
  const rceptNo = asString(item?.rcept_no);
  if (!holderName || !rceptNo) return undefined;
  const corpCode = asString(item?.corp_code) ?? "";
  const reportType = asString(item?.report_tp);
  const reportReason = asString(item?.report_resn);
  const pct = parseKoreanAmount(asString(item?.stkrt));
  const change = parseKoreanAmount(asString(item?.stkrt_irds));
  const filedDate = formatDartDate(asString(item?.rcept_dt)) ?? "Not stated";
  return {
    holderName,
    holderType: reportType ?? "5% mass holder",
    ...(pct !== undefined ? { pct } : {}),
    ...(change !== undefined ? { change } : {}),
    thresholdRegime: OPEN_DART_5_PERCENT_THRESHOLD_REGIME,
    form: "주식등의 대량보유상황보고서",
    filedDate,
    notifiedDate: filedDate,
    ...(reportReason ? { naturesOfControl: [reportReason] } : {}),
    accession: rceptNo,
    sourceUrl: filingViewerUrl(rceptNo),
    source: "OpenDART",
    sourceIdentifiers: sourceIdentifiers(corpCode),
  };
}

export function parseOpenDartOwners(value: unknown): OwnerRecord[] {
  return asArray(asRecord(value)?.list).flatMap((item) => {
    const owner = parseOwner(item);
    return owner ? [owner] : [];
  });
}

export async function getOpenDartOwners(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const corpCode = await resolveOpenDartCorpCode(company, options);
  const record = await requestJson("majorstock.json", { corp_code: corpCode }, options);
  if (!record) return [];
  return parseOpenDartOwners(record)
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate));
}

// --- Financials (단일회사 주요계정 / fnlttSinglAcnt) -------------------------

function basisFromDiv(value: string | undefined): FinancialBasis | undefined {
  if (value === "CFS") return "consolidated";
  if (value === "OFS") return "separate";
  return undefined;
}

function periodEndFromDartDate(value: string | undefined, year: number): string {
  const matches = (value ?? "").match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/g) ?? [];
  const last = matches[matches.length - 1];
  if (last) {
    const parts = last.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (parts) {
      const [, y, m, d] = parts;
      return `${y}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}`;
    }
  }
  return String(year);
}

function parseFinancialRow(
  value: unknown,
  year: number,
  concepts: ReadonlySet<string>,
): FinancialFact | undefined {
  const item = asRecord(value);
  const accountName = asString(item?.account_nm);
  const rceptNo = asString(item?.rcept_no);
  if (!accountName || !rceptNo) return undefined;
  const mapped = ACCOUNT_LOOKUP.get(normalizeAccountName(accountName));
  if (!mapped || !concepts.has(mapped.concept)) return undefined;
  const amount = parseKoreanAmount(asString(item?.thstrm_amount));
  if (amount === undefined) return undefined;
  const basis = basisFromDiv(asString(item?.fs_div));
  const unit = asString(item?.currency) ?? "KRW";
  const corpCode = asString(item?.corp_code) ?? "";
  return {
    concept: mapped.concept,
    label: mapped.label,
    periodEnd: periodEndFromDartDate(asString(item?.thstrm_dt), year),
    value: amount,
    unit,
    filedDate: formatDartDate(rceptNo.slice(0, 8)) ?? String(year),
    form: "사업보고서",
    ...(basis ? { basis } : {}),
    sourceUrl: filingViewerUrl(rceptNo),
    source: "OpenDART",
    sourceIdentifiers: sourceIdentifiers(corpCode),
  };
}

export function parseOpenDartFinancialStatements(
  value: unknown,
  year: number,
  concepts: ReadonlySet<string> = new Set(OPEN_DART_FINANCIAL_CONCEPT_NAMES),
): FinancialFact[] {
  return asArray(asRecord(value)?.list).flatMap((item) => {
    const fact = parseFinancialRow(item, year, concepts);
    return fact ? [fact] : [];
  });
}

function defaultFinancialYears(periods: number): number[] {
  const latest = new Date().getUTCFullYear() - 1;
  const years: number[] = [];
  for (let offset = 0; offset < periods; offset += 1) {
    const year = latest - offset;
    if (year < OPEN_DART_FIRST_DATA_YEAR) break;
    years.push(year);
  }
  return years;
}

export async function getOpenDartFinancials(
  company: string,
  params: OpenDartFinancialParams = {},
  options: AdapterOptions = {},
): Promise<FinancialFact[]> {
  const requested = params.concepts?.length
    ? params.concepts.filter((concept) => OPEN_DART_ACCOUNT_CONCEPTS[concept])
    : OPEN_DART_FINANCIAL_CONCEPT_NAMES;
  const conceptSet = new Set(requested);
  const periods = Math.min(10, Math.max(1, params.periods ?? OPEN_DART_DEFAULT_FINANCIAL_PERIODS));
  const years = (params.years?.length ? [...params.years] : defaultFinancialYears(periods))
    .filter((year) => Number.isInteger(year) && year >= OPEN_DART_FIRST_DATA_YEAR)
    .sort((left, right) => right - left)
    .slice(0, periods);
  if (!conceptSet.size || !years.length) return [];

  const corpCode = await resolveOpenDartCorpCode(company, options);
  const facts: FinancialFact[] = [];
  for (const year of years) {
    const record = await requestJson("fnlttSinglAcnt.json", {
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code: OPEN_DART_REPORT_CODES.annual,
    }, options);
    if (!record) continue;
    facts.push(...parseOpenDartFinancialStatements(record, year, conceptSet));
  }

  // Prefer the latest filed value per concept + basis + period; consolidated
  // ranks ahead of separate when both exist for the same period.
  const seen = new Set<string>();
  return facts
    .sort((left, right) =>
      right.periodEnd.localeCompare(left.periodEnd) ||
      (left.basis === "consolidated" ? -1 : 1) - (right.basis === "consolidated" ? -1 : 1)
    )
    .filter((fact) => {
      const key = `${fact.concept}|${fact.basis ?? ""}|${fact.periodEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveOpenDartCompany;
export const resolveCorpCode = resolveOpenDartCorpCode;
export const searchCompanies = searchOpenDartCompanies;
export const searchFilings = searchOpenDartFilings;
export const getLatestReport = getLatestOpenDartReport;
export const getInsiders = getOpenDartInsiders;
export const getOwners = getOpenDartOwners;
export const getFinancials = getOpenDartFinancials;

export function createOpenDartAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveOpenDartCompany(query, options),
    searchEntities: (query: string) => searchOpenDartCompanies(query, options),
    searchFilings: (input: string | OpenDartFilingSearchParams) =>
      searchOpenDartFilings(input, options),
    getLatestReport: (company: string, reportKind: "annual" | "quarterly") =>
      getLatestOpenDartReport(company, reportKind, options),
    getInsiders: (company: string) => getOpenDartInsiders(company, options),
    getOwners: (company: string) => getOpenDartOwners(company, options),
    getFinancials: (company: string, params?: OpenDartFinancialParams) =>
      getOpenDartFinancials(company, params ?? {}, options),
  };
}
