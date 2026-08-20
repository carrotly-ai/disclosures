import { readCachedJson, writeCachedJson } from "../core/cache.js";
import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString, type JsonRecord } from "../core/parsing.js";
import { twseRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  FinancialFact,
  OwnerRecord,
} from "../core/types.js";

// The Taiwan Stock Exchange (TWSE) publishes a keyless, official OpenAPI over
// its market open data (openapi.twse.com.tw), licensed under the Open Government
// Data License. Each endpoint returns the whole-market snapshot for a dataset as
// a flat JSON array with no server-side company filter, so this adapter resolves
// a company to its 4-digit listing code from the basic-data table and then
// filters each intent dataset client-side by that code.
export const TWSE_OPENAPI_BASE_URL = "https://openapi.twse.com.tw/v1";
// isin.twse.com.tw single_main.jsp is the official TWSE per-company profile page
// and is GET-addressable by listing code; the TWSE open-data feeds carry no
// per-row permalink, so every row anchors to this stable company profile.
export const TWSE_COMPANY_PROFILE_URL =
  "https://isin.twse.com.tw/isin/single_main.jsp";
export const TWSE_REQUEST_TIMEOUT_MS = 30_000;
// t187ap11_L (every listed director/supervisor's holdings) is ~10 MB, so it
// needs a longer ceiling than the small basic/announcement/major-holder feeds.
export const TWSE_LARGE_REQUEST_TIMEOUT_MS = 60_000;

/** 上市公司基本資料 — listed-company basic data (used for resolution). */
export const TWSE_BASIC_ENDPOINT = "t187ap03_L";
/** 每日重大訊息 — daily material-information announcements. */
export const TWSE_ANNOUNCEMENTS_ENDPOINT = "t187ap04_L";
/** 持股逾 10% 大股東名單 — list of shareholders holding over 10%. */
export const TWSE_MAJOR_SHAREHOLDERS_ENDPOINT = "t187ap02_L";
/** 董監事持股餘額明細資料 — director/supervisor shareholding balances. */
export const TWSE_DIRECTOR_HOLDINGS_ENDPOINT = "t187ap11_L";
/** 綜合損益表（一般業）— comprehensive income statement, general-industry variant. */
export const TWSE_COMPREHENSIVE_INCOME_ENDPOINT = "t187ap06_L_ci";
/** 資產負債表（一般業）— balance sheet, general-industry variant. */
export const TWSE_BALANCE_SHEET_ENDPOINT = "t187ap07_L_ci";

/**
 * 產業別 code 17 = 金融保險業 (finance & insurance). Its issuers — banks (銀行業),
 * securities firms (證券業), insurers (保險業) and financial-holding companies
 * (金控業) — file the sector statement variants (…_basi / _bd / _ins / _fh),
 * whose income statement has no 營業收入 / 營業利益 lines at all (they report
 * 淨收益 net revenue instead). This release parses only the general-industry
 * (_ci) statements, so a finance/insurance issuer is degraded honestly rather
 * than force-fit onto a concept set its statements do not carry.
 */
export const TWSE_FINANCE_INSURANCE_INDUSTRY_CODE = "17";

/**
 * TWSE reports financial-statement values in New Taiwan Dollar thousands
 * (新臺幣仟元), so each parsed figure is multiplied by this scale to canonical
 * whole-NT$ units before it is surfaced.
 */
export const TWSE_STATEMENT_SCALE = 1000;

export const TWSE_MAJOR_SHAREHOLDER_THRESHOLD_REGIME =
  "Taiwan Securities and Exchange Act — shareholders holding more than 10% of a " +
  "listed company's shares (持股逾 10% 大股東)";

export const TWSE_RATE_LIMIT_MESSAGE =
  "TWSE OpenAPI request limit reached. Please retry later.";

export class TwseRateLimitError extends AdapterRateLimitError {
  constructor(message = TWSE_RATE_LIMIT_MESSAGE) {
    super(message, 90, 60_000, "TWSE");
    this.name = "TwseRateLimitError";
  }
}

export class TwseApiError extends AdapterError {
  constructor(message: string) {
    super(message, "TWSE");
    this.name = "TwseApiError";
  }
}

function acquireRequest(): void {
  if (!twseRateLimiter.tryAcquire()) throw new TwseRateLimitError();
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
};

// --- Date helpers ----------------------------------------------------------

/**
 * Convert a Taiwan government date to ISO `YYYY-MM-DD`. TWSE feeds mix two
 * encodings: Minguo (ROC) 7-digit `YYYMMDD` where the 3-digit year is the
 * Gregorian year minus 1911 (e.g. `1150805` → 2026-08-05), and plain Gregorian
 * 8-digit `YYYYMMDD` for a few fields (e.g. 上市日期 `19620209`). Anything else
 * returns undefined rather than a guessed date.
 */
export function rocDateToIso(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (/^\d{8}$/.test(text) && (text.startsWith("19") || text.startsWith("20"))) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (/^\d{7}$/.test(text)) {
    const year = Number.parseInt(text.slice(0, 3), 10) + 1911;
    return `${year}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
  }
  return undefined;
}

/** Convert a ROC 5-digit `YYYMM` data-month (e.g. `11506`) to `YYYY-MM`. */
export function rocYearMonthToIso(value: unknown): string | undefined {
  const text = asString(value);
  if (!text || !/^\d{5}$/.test(text)) return undefined;
  const year = Number.parseInt(text.slice(0, 3), 10) + 1911;
  return `${year}-${text.slice(3, 5)}`;
}

function parseTwNumber(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const cleaned = text.replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// --- Dataset loading -------------------------------------------------------

export const TWSE_DATASET_CACHE_TTL_MS = 6 * 60 * 60_000;

const datasetPromises = new Map<string, Promise<JsonRecord[]>>();

/** Reset the process-local dataset memo (used by tests for isolation). */
export function resetTwseDatasetCache(): void {
  datasetPromises.clear();
}

function datasetCacheKey(endpoint: string): string {
  return `twse:${endpoint}:v1`;
}

function validateDatasetCache(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .map(asRecord)
    .filter((row): row is JsonRecord => row !== undefined);
  return rows.length ? rows : undefined;
}

async function fetchDataset(
  endpoint: string,
  options: AdapterOptions,
  timeoutMs: number,
): Promise<JsonRecord[]> {
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      `${TWSE_OPENAPI_BASE_URL}/opendata/${endpoint}`,
      BROWSER_HEADERS,
      timeoutMs,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new TwseRateLimitError();
    }
    throw error;
  }
  const rows = asArray(payload)
    .map(asRecord)
    .filter((row): row is JsonRecord => row !== undefined);
  if (!rows.length) {
    throw new TwseApiError(`TWSE ${endpoint} returned no rows.`);
  }
  return rows;
}

async function loadDataset(
  endpoint: string,
  options: AdapterOptions,
  timeoutMs: number = TWSE_REQUEST_TIMEOUT_MS,
): Promise<JsonRecord[]> {
  const key = datasetCacheKey(endpoint);
  if (options.cache) {
    const cached = await readCachedJson(options.cache, key, validateDatasetCache);
    if (cached) return cached;
  }
  let promise = datasetPromises.get(endpoint);
  if (!promise) {
    promise = fetchDataset(endpoint, options, timeoutMs);
    datasetPromises.set(endpoint, promise);
  }
  let rows: JsonRecord[];
  try {
    rows = await promise;
  } catch (error) {
    datasetPromises.delete(endpoint);
    throw error;
  }
  if (options.cache) {
    await writeCachedJson(options.cache, key, rows, TWSE_DATASET_CACHE_TTL_MS);
  }
  return rows;
}

// --- Resolution ------------------------------------------------------------

export function isTwseStockCode(value: string): boolean {
  // Listed common-stock codes are 4 digits (e.g. 2330); a handful of listings
  // (ETFs, TDRs) run to 6, so accept 4–6 and match exactly against the feed.
  return /^\d{4,6}$/.test(value.trim());
}

function companyProfileUrl(code: string): string {
  const params = new URLSearchParams({ owncode: code });
  return `${TWSE_COMPANY_PROFILE_URL}?${params.toString()}`;
}

function basicRowToEntity(row: JsonRecord, matchReason: string): Entity | undefined {
  const code = asString(row["公司代號"]);
  const fullName = asString(row["公司名稱"]);
  if (!code || !fullName) return undefined;
  const englishName = asString(row["英文簡稱"]);
  const shortName = asString(row["公司簡稱"]);
  const listingDate = rocDateToIso(row["上市日期"]);
  const aliases = [englishName, shortName].filter(
    (value): value is string => Boolean(value),
  );
  return {
    legalName: fullName,
    stockCode: code,
    jurisdiction: "TW",
    source: "TWSE",
    sourceIdentifiers: { stockCode: code, jurisdiction: "TW" },
    sourceUrl: companyProfileUrl(code),
    status: listingDate ? `Listed ${listingDate}` : "Listed",
    ...(aliases.length ? { aliases } : {}),
    matchReason,
  };
}

export async function searchTwseCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const rows = await loadDataset(TWSE_BASIC_ENDPOINT, options);

  if (isTwseStockCode(trimmed)) {
    const matches = rows
      .filter((row) => asString(row["公司代號"]) === trimmed)
      .map((row) => basicRowToEntity(row, "Exact listing-code match"))
      .filter((entity): entity is Entity => entity !== undefined);
    if (matches.length) return matches;
    // Fall through to a name search if the numeric query is not a known code.
  }

  // The basic-data feed is the whole listed market (~1000 rows), so unlike a
  // server-side search endpoint every candidate is present locally. rankEntities
  // tags genuine hits with a descriptive reason and stamps everything else with
  // the fallback reason at score 0; keep only the genuine hits so a query with
  // no real match honestly returns nothing rather than 25 arbitrary companies.
  const fallbackReason = "TWSE basic-data search result";
  const entities = rows
    .map((row) => basicRowToEntity(row, fallbackReason))
    .filter((entity): entity is Entity => entity !== undefined);
  return rankEntities(trimmed, entities, { fallbackReason })
    .filter((entity) => entity.matchReason !== fallbackReason)
    .slice(0, 25);
}

export async function resolveTwseCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchTwseCompanies(query, options))[0] ?? null;
}

async function resolveTwseEntity(
  query: string,
  options: AdapterOptions,
): Promise<Entity> {
  const entity = await resolveTwseCompany(query, options);
  if (!entity || !entity.stockCode) {
    throw new TwseApiError(`No TWSE company found for ${query}.`);
  }
  return entity;
}

// --- Material-information announcements (CompanyFilings) --------------------

export interface TwseFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export const TWSE_DEFAULT_FILING_LIMIT = 20;

function announcementRowToFiling(
  row: JsonRecord,
  code: string,
): Filing | undefined {
  const subject = asString(row["主旨 "]) ?? asString(row["主旨"]);
  const filedDate = rocDateToIso(row["發言日期"]);
  if (!subject || !filedDate) return undefined;
  const clause = asString(row["符合條款"]);
  const factDate = rocDateToIso(row["事實發生日"]);
  return {
    filedDate,
    form: "Material information (重大訊息)",
    ...(clause ? { category: clause } : {}),
    description: factDate ? `${subject} (event ${factDate})` : subject,
    sourceUrl: companyProfileUrl(code),
    source: "TWSE",
    sourceIdentifiers: { stockCode: code, jurisdiction: "TW" },
  };
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

export async function searchTwseFilings(
  input: string | TwseFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveTwseEntity(params.company, options);
  const code = entity.stockCode!;
  const rows = await loadDataset(TWSE_ANNOUNCEMENTS_ENDPOINT, options);
  const limit = Math.max(1, params.limit ?? TWSE_DEFAULT_FILING_LIMIT);
  return rows
    .filter((row) => asString(row["公司代號"]) === code)
    .flatMap((row) => {
      const filing = announcementRowToFiling(row, code);
      return filing ? [filing] : [];
    })
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .filter((filing) => {
      if (params.startDate && filing.filedDate < params.startDate) return false;
      if (params.endDate && filing.filedDate > params.endDate) return false;
      return true;
    })
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

// --- Major shareholders (CompanyOwners) ------------------------------------

function majorShareholderRowToOwner(
  row: JsonRecord,
  code: string,
): OwnerRecord | undefined {
  const holderName = asString(row["大股東名稱"]);
  if (!holderName) return undefined;
  const filedDate = rocDateToIso(row["出表日期"]) ?? "";
  return {
    holderName,
    holderType: "Major shareholder (>10%)",
    thresholdRegime: TWSE_MAJOR_SHAREHOLDER_THRESHOLD_REGIME,
    form: "TWSE major-shareholder list (持股逾 10% 大股東名單)",
    filedDate,
    sourceUrl: companyProfileUrl(code),
    source: "TWSE",
    sourceIdentifiers: { stockCode: code, jurisdiction: "TW" },
  };
}

export async function getTwseMajorShareholders(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const entity = await resolveTwseEntity(company, options);
  const code = entity.stockCode!;
  const rows = await loadDataset(TWSE_MAJOR_SHAREHOLDERS_ENDPOINT, options);
  return rows
    .filter((row) => asString(row["公司代號"]) === code)
    .flatMap((row) => {
      const owner = majorShareholderRowToOwner(row, code);
      return owner ? [owner] : [];
    });
}

// --- Director/supervisor holdings (CompanyInsiders) ------------------------

export interface TwseDirectorHolding {
  title: string;
  name: string;
  currentShares?: number;
  electedShares?: number;
  pledgedShares?: number;
  pledgeRatio?: string;
  dataMonth?: string;
  filedDate: string;
  sourceUrl: string;
}

function directorRowToHolding(
  row: JsonRecord,
  code: string,
): TwseDirectorHolding | undefined {
  const title = asString(row["職稱"]);
  const name = asString(row["姓名"]);
  if (!title || !name) return undefined;
  const currentShares = parseTwNumber(row["目前持股"]);
  const electedShares = parseTwNumber(row["選任時持股 "] ?? row["選任時持股"]);
  const pledgedShares = parseTwNumber(row["設質股數"]);
  const pledgeRatio = asString(row["設質股數佔持股比例"]);
  const dataMonth = rocYearMonthToIso(row["資料年月"]);
  return {
    title,
    name,
    ...(currentShares !== undefined ? { currentShares } : {}),
    ...(electedShares !== undefined ? { electedShares } : {}),
    ...(pledgedShares !== undefined ? { pledgedShares } : {}),
    ...(pledgeRatio ? { pledgeRatio } : {}),
    ...(dataMonth ? { dataMonth } : {}),
    filedDate: rocDateToIso(row["出表日期"]) ?? "",
    sourceUrl: companyProfileUrl(code),
  };
}

export async function getTwseDirectorHoldings(
  company: string,
  options: AdapterOptions = {},
): Promise<TwseDirectorHolding[]> {
  const entity = await resolveTwseEntity(company, options);
  const code = entity.stockCode!;
  const rows = await loadDataset(
    TWSE_DIRECTOR_HOLDINGS_ENDPOINT,
    options,
    TWSE_LARGE_REQUEST_TIMEOUT_MS,
  );
  return rows
    .filter((row) => asString(row["公司代號"]) === code)
    .flatMap((row) => {
      const holding = directorRowToHolding(row, code);
      return holding ? [holding] : [];
    });
}

// --- Financial statements (CompanyFinancials) ------------------------------

interface TwseConceptSpec {
  concept: string;
  label: string;
  statement: "income" | "balance";
  /** Live Chinese column key on the general-industry (_ci) snapshot row. */
  field: string;
}

/**
 * Map the shared canonical concept set onto the general-industry (_ci) TWSE
 * statement columns. Revenue and operating income come from the comprehensive
 * income statement (綜合損益表); total assets and total equity from the balance
 * sheet (資產負債表). Net income uses 本期淨利（淨損） — the whole-entity figure,
 * not the parent-only 淨利歸屬於母公司業主 — to match the "net income" semantics
 * of the other adapters. Column keys carry full-width parentheses, exactly as
 * the live feed emits them.
 */
export const TWSE_FINANCIAL_CONCEPTS: readonly TwseConceptSpec[] = [
  { concept: "revenue", label: "Operating revenue (營業收入)", statement: "income", field: "營業收入" },
  { concept: "operating_income", label: "Operating income (營業利益)", statement: "income", field: "營業利益（損失）" },
  { concept: "net_income", label: "Net income (本期淨利／淨損)", statement: "income", field: "本期淨利（淨損）" },
  { concept: "total_assets", label: "Total assets (資產總計)", statement: "balance", field: "資產總計" },
  { concept: "stockholders_equity", label: "Total equity (權益總計)", statement: "balance", field: "權益總計" },
];

export const TWSE_FINANCIAL_CONCEPT_NAMES = TWSE_FINANCIAL_CONCEPTS.map(
  (spec) => spec.concept,
);

const TWSE_QUARTER_MONTH_DAY: Record<number, string> = {
  1: "03-31",
  2: "06-30",
  3: "09-30",
  4: "12-31",
};

/**
 * Resolve a TWSE snapshot's 年度 (ROC year) + 季別 (quarter) to the fiscal
 * period end it covers. The comprehensive-income figures are cumulative from
 * the fiscal-year start through this quarter (year-to-date); the balance-sheet
 * figures are as-of this date. Returns undefined for an unrecognized quarter
 * rather than guessing a period.
 */
export function twseQuarterPeriodEnd(
  rocYear: unknown,
  quarter: unknown,
): { periodEnd: string; year: number; quarter: number } | undefined {
  const yearText = asString(rocYear);
  if (!yearText || !/^\d{2,3}$/.test(yearText)) return undefined;
  const quarterNumber = Number.parseInt(asString(quarter) ?? "", 10);
  const monthDay = TWSE_QUARTER_MONTH_DAY[quarterNumber];
  if (!monthDay) return undefined;
  const gregorianYear = Number.parseInt(yearText, 10) + 1911;
  return {
    periodEnd: `${gregorianYear}-${monthDay}`,
    year: gregorianYear,
    quarter: quarterNumber,
  };
}

export interface TwseFinancialsParams {
  company: string;
  concepts?: readonly string[];
}

export interface TwseFinancialsResult {
  entity: Entity;
  facts: FinancialFact[];
  /**
   * True when no general-industry statement row exists for the issuer and its
   * 產業別 marks it a finance/insurance-sector filer using a variant statement
   * format this release does not parse. Lets the caller degrade honestly with
   * the right explanation instead of an ambiguous empty result.
   */
  financialSectorVariant: boolean;
}

const TWSE_INCOME_FORM = "TWSE comprehensive income statement (綜合損益表), general-industry";
const TWSE_BALANCE_FORM = "TWSE balance sheet (資產負債表), general-industry";

function twseRowToFacts(
  row: JsonRecord,
  specs: readonly TwseConceptSpec[],
  statement: "income" | "balance",
  code: string,
): FinancialFact[] {
  const period = twseQuarterPeriodEnd(row["年度"], row["季別"]);
  if (!period) return [];
  const filedDate = rocDateToIso(row["出表日期"]) ?? "";
  const form = statement === "income" ? TWSE_INCOME_FORM : TWSE_BALANCE_FORM;
  const facts: FinancialFact[] = [];
  for (const spec of specs) {
    if (spec.statement !== statement) continue;
    const value = parseTwNumber(row[spec.field]);
    if (value === undefined) continue;
    facts.push({
      concept: spec.concept,
      label: spec.label,
      periodEnd: period.periodEnd,
      value: value * TWSE_STATEMENT_SCALE,
      unit: "TWD",
      filedDate,
      form,
      sourceUrl: companyProfileUrl(code),
      source: "TWSE",
      sourceIdentifiers: { stockCode: code, jurisdiction: "TW" },
    });
  }
  return facts;
}

async function twseIndustryCode(
  code: string,
  options: AdapterOptions,
): Promise<string | undefined> {
  const rows = await loadDataset(TWSE_BASIC_ENDPOINT, options);
  const row = rows.find((candidate) => asString(candidate["公司代號"]) === code);
  return asString(row?.["產業別"]);
}

/**
 * Latest-period financial-statement figures for a listed company from the TWSE
 * general-industry (_ci) comprehensive-income and balance-sheet open-data
 * snapshots. Each dataset is the whole-market snapshot for its most recent
 * reported quarter with no per-company filter, so this filters client-side by
 * listing code and maps the row onto the canonical concept set (in whole NT$).
 * A finance/insurance-sector issuer, which files a variant statement format not
 * parsed here, returns no facts with financialSectorVariant set.
 */
export async function getTwseFinancials(
  input: string | TwseFinancialsParams,
  options: AdapterOptions = {},
): Promise<TwseFinancialsResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveTwseEntity(params.company, options);
  const code = entity.stockCode!;
  const wanted = new Set(
    params.concepts && params.concepts.length
      ? params.concepts
      : TWSE_FINANCIAL_CONCEPT_NAMES,
  );
  const specs = TWSE_FINANCIAL_CONCEPTS.filter((spec) => wanted.has(spec.concept));
  const needIncome = specs.some((spec) => spec.statement === "income");
  const needBalance = specs.some((spec) => spec.statement === "balance");

  const facts: FinancialFact[] = [];
  if (needIncome) {
    const rows = await loadDataset(TWSE_COMPREHENSIVE_INCOME_ENDPOINT, options);
    const row = rows.find((candidate) => asString(candidate["公司代號"]) === code);
    if (row) facts.push(...twseRowToFacts(row, specs, "income", code));
  }
  if (needBalance) {
    const rows = await loadDataset(TWSE_BALANCE_SHEET_ENDPOINT, options);
    const row = rows.find((candidate) => asString(candidate["公司代號"]) === code);
    if (row) facts.push(...twseRowToFacts(row, specs, "balance", code));
  }

  // Sort by the adapter's canonical concept order (all facts share the latest
  // period, so concept order alone gives a stable, statement-like sequence).
  const order = new Map(
    TWSE_FINANCIAL_CONCEPTS.map((spec, index) => [spec.concept, index]),
  );
  facts.sort((left, right) =>
    (order.get(left.concept) ?? 0) - (order.get(right.concept) ?? 0),
  );

  let financialSectorVariant = false;
  if (!facts.length) {
    financialSectorVariant =
      (await twseIndustryCode(code, options)) === TWSE_FINANCE_INSURANCE_INDUSTRY_CODE;
  }
  return { entity, facts, financialSectorVariant };
}

// --- Adapter factory -------------------------------------------------------

export function createTwseAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveTwseCompany(query, options),
    searchEntities: (query: string) => searchTwseCompanies(query, options),
    searchFilings: (input: string | TwseFilingSearchParams) =>
      searchTwseFilings(input, options),
    getMajorShareholders: (company: string) =>
      getTwseMajorShareholders(company, options),
    getDirectorHoldings: (company: string) =>
      getTwseDirectorHoldings(company, options),
    getFinancials: (input: string | TwseFinancialsParams) =>
      getTwseFinancials(input, options),
  };
}
