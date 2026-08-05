import { rankEntities } from "../core/entityMatching.js";
import {
  AdapterConfigurationError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { getJson, getOptionalJson, HttpError } from "../core/http.js";
import {
  asArray,
  asRecord,
  asString,
  asStringArray,
  type JsonRecord,
} from "../core/parsing.js";
import { companiesHouseRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  Insider,
  LatestReportMetadata,
  OwnerRecord,
} from "../core/types.js";

export const COMPANIES_HOUSE_BASE_URL =
  "https://api.company-information.service.gov.uk";
export const COMPANIES_HOUSE_API_BASE_URL = COMPANIES_HOUSE_BASE_URL;
export const COMPANIES_HOUSE_PUBLIC_BASE_URL =
  "https://find-and-update.company-information.service.gov.uk";
export const COMPANIES_HOUSE_REQUEST_TIMEOUT_MS = 15_000;
export const COMPANIES_HOUSE_PAGE_SIZE = 100;
export const COMPANIES_HOUSE_MAX_PAGES = 10;
export const COMPANIES_HOUSE_MAX_RESULTS =
  COMPANIES_HOUSE_PAGE_SIZE * COMPANIES_HOUSE_MAX_PAGES;

export const COMPANIES_HOUSE_NO_CONFIG_MESSAGE =
  "Companies House requires an API key. Set COMPANIES_HOUSE_API_KEY.";
export const COMPANIES_HOUSE_MISSING_API_KEY_MESSAGE =
  COMPANIES_HOUSE_NO_CONFIG_MESSAGE;
export const NO_COMPANIES_HOUSE_CONFIG_MESSAGE =
  COMPANIES_HOUSE_NO_CONFIG_MESSAGE;
export const COMPANIES_HOUSE_RATE_LIMIT_MESSAGE =
  "Companies House rate limit reached (600 requests per 5 minutes). Please retry shortly.";

export const COMPANIES_HOUSE_PSC_THRESHOLD_REGIME =
  "UK PSC register (>25% shares/voting rights or other statutory control tests)";

export class CompaniesHouseConfigurationError extends AdapterConfigurationError {
  constructor(message = COMPANIES_HOUSE_NO_CONFIG_MESSAGE) {
    super(message, "Companies House");
    this.name = "CompaniesHouseConfigurationError";
  }
}

export class CompaniesHouseRateLimitError extends AdapterRateLimitError {
  constructor(message = COMPANIES_HOUSE_RATE_LIMIT_MESSAGE) {
    super(message, 600, 5 * 60_000, "Companies House");
    this.name = "CompaniesHouseRateLimitError";
  }
}

export interface CompaniesHouseFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface CompaniesHousePscStatement {
  statement: string;
  description: string;
  linkedPscName?: string;
  notifiedDate: string;
  ceasedDate?: string;
  sourceUrl: string;
}

interface OffsetPage<T> {
  items: T[];
  startIndex?: number;
  itemsPerPage?: number;
  totalResults?: number;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function humanize(value: string): string {
  const text = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text[0]?.toUpperCase() + text.slice(1) : value;
}

function publicCompanyUrl(companyNumber: string): string {
  return `${COMPANIES_HOUSE_PUBLIC_BASE_URL}/company/${encodeURIComponent(companyNumber)}`;
}

function publicFilingHistoryUrl(companyNumber: string): string {
  return `${publicCompanyUrl(companyNumber)}/filing-history`;
}

function publicFilingDocumentUrl(
  companyNumber: string,
  transactionId: string,
): string {
  return `${publicFilingHistoryUrl(companyNumber)}/${encodeURIComponent(transactionId)}/document?format=pdf&download=0`;
}

function publicOfficersUrl(companyNumber: string): string {
  return `${publicCompanyUrl(companyNumber)}/officers`;
}

function publicPscUrl(companyNumber: string): string {
  return `${publicCompanyUrl(companyNumber)}/persons-with-significant-control`;
}

function sourceIdentifiers(companyNumber: string) {
  return { companyNumber, jurisdiction: "GB" };
}

function companyNumberCandidate(value: string): string {
  return value
    .trim()
    .replace(/^company\s*(?:number|no\.?|#)?\s*/i, "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

export function normalizeCompanyNumber(value: string): string {
  const candidate = companyNumberCandidate(value);
  if (/^\d{1,8}$/.test(candidate)) return candidate.padStart(8, "0");
  const prefixed = candidate.match(/^([A-Z]{1,2})(\d{1,6})$/);
  if (prefixed) {
    const prefix = prefixed[1];
    const digits = prefixed[2];
    if (prefix && digits) return `${prefix}${digits.padStart(8 - prefix.length, "0")}`;
  }
  if (/^[A-Z0-9]{8}$/.test(candidate) && /\d/.test(candidate)) return candidate;
  throw new Error(`Invalid Companies House company number: ${value}`);
}

export function isCompaniesHouseCompanyNumber(value: string): boolean {
  try {
    normalizeCompanyNumber(value);
    return true;
  } catch {
    return false;
  }
}

export const isLikelyCompanyNumber = isCompaniesHouseCompanyNumber;

export function getCompaniesHouseApiKeyOrUndefined(
  options: AdapterOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  return env.COMPANIES_HOUSE_API_KEY?.trim() || undefined;
}

export function getCompaniesHouseApiKey(
  options: AdapterOptions = {},
): string {
  const apiKey = getCompaniesHouseApiKeyOrUndefined(options);
  if (!apiKey) throw new CompaniesHouseConfigurationError();
  return apiKey;
}

export function hasCompaniesHouseConfiguration(
  options: AdapterOptions = {},
): boolean {
  return getCompaniesHouseApiKeyOrUndefined(options) !== undefined;
}

export function getCompaniesHouseConfigurationError(
  options: AdapterOptions = {},
): CompaniesHouseConfigurationError | undefined {
  return hasCompaniesHouseConfiguration(options)
    ? undefined
    : new CompaniesHouseConfigurationError();
}

function requestHeaders(options: AdapterOptions): Record<string, string> {
  const apiKey = getCompaniesHouseApiKey(options);
  return {
    Accept: "application/json",
    Authorization: `Basic ${btoa(`${apiKey}:`)}`,
  };
}

function acquireRequest(): void {
  if (!companiesHouseRateLimiter.tryAcquire()) {
    throw new CompaniesHouseRateLimitError();
  }
}

function translateRateLimit(error: unknown): never {
  if (error instanceof HttpError && error.status === 429) {
    throw new CompaniesHouseRateLimitError();
  }
  throw error;
}

async function requestJson(
  url: string,
  options: AdapterOptions,
): Promise<unknown> {
  const headers = requestHeaders(options);
  acquireRequest();
  try {
    return await getJson(
      url,
      headers,
      COMPANIES_HOUSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    translateRateLimit(error);
  }
}

async function requestOptionalJson(
  url: string,
  options: AdapterOptions,
): Promise<unknown | null> {
  const headers = requestHeaders(options);
  acquireRequest();
  try {
    return await getOptionalJson(
      url,
      headers,
      COMPANIES_HOUSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    translateRateLimit(error);
  }
}

function companyProfileApiUrl(companyNumber: string): string {
  return `${COMPANIES_HOUSE_BASE_URL}/company/${encodeURIComponent(companyNumber)}`;
}

function previousNames(value: unknown): string[] {
  return unique(asArray(value).flatMap((item) => {
    const name = asString(asRecord(item)?.name);
    return name ? [name] : [];
  }));
}

function companyEntity(
  companyNumber: string,
  legalName: string,
  values: {
    status?: string;
    registerJurisdiction?: string;
    aliases?: string[];
    matchReason?: string;
  } = {},
): Entity {
  return {
    legalName,
    companyNumber,
    jurisdiction: "GB",
    source: "Companies House",
    sourceIdentifiers: {
      companyNumber,
      jurisdiction: values.registerJurisdiction ?? "GB",
    },
    sourceUrl: publicCompanyUrl(companyNumber),
    ...(values.aliases?.length ? { aliases: values.aliases } : {}),
    ...(values.status ? { status: values.status } : {}),
    ...(values.matchReason ? { matchReason: values.matchReason } : {}),
  };
}

export function parseCompaniesHouseProfile(value: unknown): Entity {
  const profile = asRecord(value);
  const rawNumber = asString(profile?.company_number);
  const legalName = asString(profile?.company_name);
  if (!rawNumber || !legalName) {
    throw new Error(
      "Invalid Companies House company profile: missing company number or company name",
    );
  }
  const companyNumber = normalizeCompanyNumber(rawNumber);
  const status = asString(profile?.company_status);
  const registerJurisdiction = asString(profile?.jurisdiction);
  return companyEntity(companyNumber, legalName, {
    ...(status ? { status } : {}),
    ...(registerJurisdiction ? { registerJurisdiction } : {}),
    aliases: previousNames(profile?.previous_company_names),
    matchReason: "Exact Companies House company-number match",
  });
}

function parseSearchEntity(value: unknown): Entity | undefined {
  const item = asRecord(value);
  const rawNumber = asString(item?.company_number);
  const legalName = asString(item?.title) ?? asString(item?.company_name);
  if (!rawNumber || !legalName) return undefined;
  let companyNumber: string;
  try {
    companyNumber = normalizeCompanyNumber(rawNumber);
  } catch {
    return undefined;
  }
  const status = asString(item?.company_status);
  const registerJurisdiction = asString(item?.jurisdiction);
  return companyEntity(companyNumber, legalName, {
    ...(status ? { status } : {}),
    ...(registerJurisdiction ? { registerJurisdiction } : {}),
    aliases: previousNames(item?.previous_company_names),
  });
}

export function parseCompaniesHouseSearch(value: unknown): Entity[] {
  const document = asRecord(value);
  if (!document) return [];
  return asArray(document.items).flatMap((item) => {
    const entity = parseSearchEntity(item);
    return entity ? [entity] : [];
  });
}

export async function getCompaniesHouseCompanyProfile(
  companyNumber: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  const normalized = normalizeCompanyNumber(companyNumber);
  const payload = await requestOptionalJson(companyProfileApiUrl(normalized), options);
  return payload === null ? null : parseCompaniesHouseProfile(payload);
}

export async function searchCompaniesHouseCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (isCompaniesHouseCompanyNumber(trimmed)) {
    const profile = await getCompaniesHouseCompanyProfile(trimmed, options);
    return profile ? [profile] : [];
  }
  const url = new URL(`${COMPANIES_HOUSE_BASE_URL}/search/companies`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("items_per_page", String(COMPANIES_HOUSE_PAGE_SIZE));
  url.searchParams.set("start_index", "0");
  const entities = parseCompaniesHouseSearch(await requestJson(url.toString(), options));
  return rankEntities(trimmed, entities, {
    fallbackReason: "Companies House legal-name search result",
  });
}

export async function resolveCompaniesHouseCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchCompaniesHouseCompanies(query, options))[0] ?? null;
}

export async function resolveCompaniesHouseCompanyNumber(
  query: string,
  options: AdapterOptions = {},
): Promise<string> {
  if (isCompaniesHouseCompanyNumber(query)) return normalizeCompanyNumber(query);
  const entity = await resolveCompaniesHouseCompany(query, options);
  if (!entity?.companyNumber) {
    throw new Error(`No Companies House company found for ${query}.`);
  }
  return entity.companyNumber;
}

function pageNumbers(document: JsonRecord, itemCount: number): Omit<OffsetPage<never>, "items"> {
  const startIndex = typeof document.start_index === "number"
    ? document.start_index
    : undefined;
  const itemsPerPage = typeof document.items_per_page === "number"
    ? document.items_per_page
    : itemCount;
  const totalValue = document.total_results ?? document.total_count;
  const totalResults = typeof totalValue === "number" ? totalValue : undefined;
  return {
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(itemsPerPage !== undefined ? { itemsPerPage } : {}),
    ...(totalResults !== undefined ? { totalResults } : {}),
  };
}

async function loadOffsetPages<T>(
  path: string,
  parseItems: (payload: unknown) => T[],
  options: AdapterOptions,
  optional404 = false,
  stopAfter = COMPANIES_HOUSE_MAX_RESULTS,
): Promise<T[]> {
  const results: T[] = [];
  let startIndex = 0;

  for (let page = 0; page < COMPANIES_HOUSE_MAX_PAGES; page += 1) {
    if (results.length >= stopAfter) break;
    const url = new URL(`${COMPANIES_HOUSE_BASE_URL}${path}`);
    url.searchParams.set("items_per_page", String(COMPANIES_HOUSE_PAGE_SIZE));
    url.searchParams.set("start_index", String(startIndex));
    const payload = optional404
      ? await requestOptionalJson(url.toString(), options)
      : await requestJson(url.toString(), options);
    if (payload === null) break;
    const document = asRecord(payload);
    if (!document) break;
    const items = parseItems(payload);
    results.push(...items);
    const rawItemCount = asArray(document.items).length;
    if (rawItemCount === 0) break;
    const pagination = pageNumbers(document, rawItemCount);
    const pageStart = pagination.startIndex ?? startIndex;
    const pageSize = pagination.itemsPerPage && pagination.itemsPerPage > 0
      ? pagination.itemsPerPage
      : rawItemCount;
    const nextStart = pageStart + pageSize;
    if (
      nextStart <= startIndex ||
      (pagination.totalResults !== undefined && nextStart >= pagination.totalResults)
    ) {
      break;
    }
    startIndex = nextStart;
  }
  return results.slice(0, COMPANIES_HOUSE_MAX_RESULTS);
}

function filingSourceUrl(
  companyNumber: string,
  transactionId: string | undefined,
  hasDocument: boolean,
): string {
  if (transactionId && hasDocument) {
    return publicFilingDocumentUrl(companyNumber, transactionId);
  }
  return publicFilingHistoryUrl(companyNumber);
}

function parseFiling(
  value: unknown,
  companyNumber: string,
): Filing | undefined {
  const item = asRecord(value);
  const filedDate = asString(item?.date);
  const form = asString(item?.type);
  const descriptionCode = asString(item?.description);
  if (!filedDate || !form || !descriptionCode) return undefined;
  const category = asString(item?.category);
  const transactionId = asString(item?.transaction_id);
  const links = asRecord(item?.links);
  const hasDocument = Boolean(asString(links?.document_metadata));
  return {
    filedDate,
    form,
    ...(category ? { category } : {}),
    description: humanize(descriptionCode),
    ...(transactionId ? { accession: transactionId } : {}),
    sourceUrl: filingSourceUrl(companyNumber, transactionId, hasDocument),
    source: "Companies House",
    sourceIdentifiers: sourceIdentifiers(companyNumber),
  };
}

export function parseCompaniesHouseFilingPage(
  value: unknown,
  companyNumber: string,
): Filing[] {
  const normalized = normalizeCompanyNumber(companyNumber);
  return asArray(asRecord(value)?.items).flatMap((item) => {
    const filing = parseFiling(item, normalized);
    return filing ? [filing] : [];
  });
}

function filingFilterText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function filingMatches(filing: Filing, filters: readonly string[]): boolean {
  if (!filters.length) return true;
  const values = [filing.form, filing.category ?? "", filing.description]
    .map(filingFilterText);
  return filters.some((filter) => {
    const normalized = filingFilterText(filter);
    return normalized.length > 0 && values.some((value) => value.includes(normalized));
  });
}

export async function searchCompaniesHouseFilings(
  input: string | CompaniesHouseFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const companyNumber = await resolveCompaniesHouseCompanyNumber(params.company, options);
  const filters = params.forms ?? [];
  const limit = Math.min(
    COMPANIES_HOUSE_MAX_RESULTS,
    Math.max(1, params.limit ?? COMPANIES_HOUSE_MAX_RESULTS),
  );
  // Companies House returns filing history newest-first, so an unfiltered
  // request can stop paging as soon as it holds enough rows. Any filter or
  // date window may match older pages, so those still page to the cap.
  const unfiltered = filters.length === 0 && !params.startDate && !params.endDate;
  const filings = await loadOffsetPages(
    `/company/${encodeURIComponent(companyNumber)}/filing-history`,
    (payload) => parseCompaniesHouseFilingPage(payload, companyNumber),
    options,
    false,
    unfiltered ? limit : COMPANIES_HOUSE_MAX_RESULTS,
  );
  return filings
    .filter((filing) => filingMatches(filing, filters))
    .filter((filing) => !params.startDate || filing.filedDate >= params.startDate)
    .filter((filing) => !params.endDate || filing.filedDate <= params.endDate)
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

export async function getLatestCompaniesHouseReport(
  company: string,
  reportKind: "annual" | "quarterly",
  options: AdapterOptions = {},
): Promise<LatestReportMetadata | null> {
  if (reportKind === "quarterly") return null;
  const filing = (await searchCompaniesHouseFilings({
    company,
    forms: ["accounts"],
    limit: 1,
  }, options))[0];
  if (!filing) return null;
  const companyNumber = filing.sourceIdentifiers?.companyNumber;
  const sectionLinks: LatestReportMetadata["sectionLinks"] = [
    {
      section: "accounts-document",
      description: "Latest accounts filing or public filing-history page",
      url: filing.sourceUrl,
    },
  ];
  if (companyNumber) {
    sectionLinks.push({
      section: "filing-history",
      description: "Companies House filing history",
      url: publicFilingHistoryUrl(companyNumber),
    });
  }
  return {
    ...filing,
    reportKind: "annual",
    sectionLinks,
  };
}

function parseOfficer(
  value: unknown,
  companyNumber: string,
): Insider | undefined {
  const item = asRecord(value);
  const name = asString(item?.name);
  const officerRole = asString(item?.officer_role);
  if (!name || !officerRole) return undefined;
  const occupation = asString(item?.occupation);
  const appointedDate = asString(item?.appointed_on);
  const ceasedDate = asString(item?.resigned_on);
  const status = ceasedDate ? "Former" : "Active";
  const roles = unique([
    humanize(officerRole),
    ...(occupation ? [`Occupation: ${occupation}`] : []),
  ]);
  return {
    name,
    roles,
    officerRole,
    ...(occupation ? { occupation } : {}),
    status,
    form: officerRole,
    filedDate: ceasedDate ?? appointedDate ?? "Not stated",
    ...(appointedDate ? { appointedDate } : {}),
    ...(ceasedDate ? { ceasedDate } : {}),
    sourceUrl: publicOfficersUrl(companyNumber),
    source: "Companies House",
    sourceIdentifiers: sourceIdentifiers(companyNumber),
  };
}

export function parseCompaniesHouseOfficerPage(
  value: unknown,
  companyNumber: string,
): Insider[] {
  const normalized = normalizeCompanyNumber(companyNumber);
  return asArray(asRecord(value)?.items).flatMap((item) => {
    const officer = parseOfficer(item, normalized);
    return officer ? [officer] : [];
  });
}

export async function getCompaniesHouseOfficers(
  company: string,
  options: AdapterOptions = {},
): Promise<Insider[]> {
  const companyNumber = await resolveCompaniesHouseCompanyNumber(company, options);
  return (await loadOffsetPages(
    `/company/${encodeURIComponent(companyNumber)}/officers`,
    (payload) => parseCompaniesHouseOfficerPage(payload, companyNumber),
    options,
  )).sort((left, right) =>
    (right.appointedDate ?? right.filedDate).localeCompare(
      left.appointedDate ?? left.filedDate,
    )
  );
}

function pscKind(kind: string | undefined): string {
  if (!kind) return "Unknown PSC kind";
  if (kind.includes("super-secure")) return "Super-secure person";
  if (kind.includes("corporate-entity")) return "Corporate entity";
  if (kind.includes("legal-person")) return "Legal person";
  if (kind.includes("individual")) return "Individual";
  return humanize(kind);
}

export function deriveCompaniesHousePercentageBand(
  naturesOfControl: readonly string[],
): string | undefined {
  const bands = new Set<string>();
  for (const nature of naturesOfControl) {
    if (nature.includes("25-to-50-percent")) bands.add(">25% up to 50%");
    if (nature.includes("50-to-75-percent")) bands.add(">50% up to 75%");
    if (nature.includes("75-to-100-percent")) bands.add(">75% up to 100%");
  }
  return bands.size ? [...bands].join("; ") : undefined;
}

function parsePsc(
  value: unknown,
  companyNumber: string,
): OwnerRecord | undefined {
  const item = asRecord(value);
  const kind = asString(item?.kind);
  const superSecure = kind?.includes("super-secure") ?? false;
  const name = asString(item?.name) ?? (superSecure
    ? "Protected details (super-secure PSC)"
    : undefined);
  if (!name) return undefined;
  const naturesOfControl = asStringArray(item?.natures_of_control);
  const notifiedDate = asString(item?.notified_on);
  const ceasedDate = asString(item?.ceased_on);
  const percentageBand = deriveCompaniesHousePercentageBand(naturesOfControl);
  return {
    holderName: name,
    holderType: pscKind(kind),
    ...(percentageBand ? { percentageBand } : {}),
    thresholdRegime: COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
    form: kind ?? "person-with-significant-control",
    filedDate: notifiedDate ?? ceasedDate ?? "Not stated",
    ...(notifiedDate ? { notifiedDate } : {}),
    ...(ceasedDate ? { ceasedDate } : {}),
    ...(naturesOfControl.length ? { naturesOfControl } : {}),
    sourceUrl: publicPscUrl(companyNumber),
    source: "Companies House",
    sourceIdentifiers: sourceIdentifiers(companyNumber),
  };
}

export function parseCompaniesHousePscPage(
  value: unknown,
  companyNumber: string,
): OwnerRecord[] {
  const normalized = normalizeCompanyNumber(companyNumber);
  return asArray(asRecord(value)?.items).flatMap((item) => {
    const psc = parsePsc(item, normalized);
    return psc ? [psc] : [];
  });
}

export async function getCompaniesHousePscs(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const companyNumber = await resolveCompaniesHouseCompanyNumber(company, options);
  return loadOffsetPages(
    `/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`,
    (payload) => parseCompaniesHousePscPage(payload, companyNumber),
    options,
    true,
  );
}

function parsePscStatement(
  value: unknown,
  companyNumber: string,
): CompaniesHousePscStatement | undefined {
  const item = asRecord(value);
  const statement = asString(item?.statement);
  const notifiedDate = asString(item?.notified_on);
  if (!statement || !notifiedDate) return undefined;
  const linkedPscName = asString(item?.linked_psc_name);
  const ceasedDate = asString(item?.ceased_on);
  return {
    statement,
    description: humanize(statement),
    ...(linkedPscName ? { linkedPscName } : {}),
    notifiedDate,
    ...(ceasedDate ? { ceasedDate } : {}),
    sourceUrl: publicPscUrl(companyNumber),
  };
}

export function parseCompaniesHousePscStatementPage(
  value: unknown,
  companyNumber: string,
): CompaniesHousePscStatement[] {
  const normalized = normalizeCompanyNumber(companyNumber);
  return asArray(asRecord(value)?.items).flatMap((item) => {
    const statement = parsePscStatement(item, normalized);
    return statement ? [statement] : [];
  });
}

async function loadCompaniesHousePscStatements(
  companyNumber: string,
  options: AdapterOptions,
): Promise<CompaniesHousePscStatement[]> {
  return loadOffsetPages(
    `/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control-statements`,
    (payload) => parseCompaniesHousePscStatementPage(payload, companyNumber),
    options,
    true,
  );
}

export async function getCompaniesHousePscStatements(
  company: string,
  options: AdapterOptions = {},
): Promise<CompaniesHousePscStatement[]> {
  const companyNumber = await resolveCompaniesHouseCompanyNumber(company, options);
  return loadCompaniesHousePscStatements(companyNumber, options);
}

function statementOwner(
  statement: CompaniesHousePscStatement,
  companyNumber: string,
): OwnerRecord {
  return {
    holderName: statement.linkedPscName ?? statement.description,
    holderType: "PSC statement",
    thresholdRegime: COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
    form: statement.statement,
    filedDate: statement.notifiedDate,
    notifiedDate: statement.notifiedDate,
    ...(statement.ceasedDate ? { ceasedDate: statement.ceasedDate } : {}),
    naturesOfControl: [statement.statement],
    sourceUrl: statement.sourceUrl,
    source: "Companies House",
    sourceIdentifiers: sourceIdentifiers(companyNumber),
  };
}

export async function getCompaniesHouseOwners(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const companyNumber = await resolveCompaniesHouseCompanyNumber(company, options);
  const pscs = await loadOffsetPages(
    `/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`,
    (payload) => parseCompaniesHousePscPage(payload, companyNumber),
    options,
    true,
  );
  if (pscs.length) return pscs;
  return (await loadCompaniesHousePscStatements(companyNumber, options))
    .map((statement) => statementOwner(statement, companyNumber));
}

export const resolveCompany = resolveCompaniesHouseCompany;
export const resolveCompanyNumber = resolveCompaniesHouseCompanyNumber;
export const searchCompanies = searchCompaniesHouseCompanies;
export const searchCompaniesHouseEntities = searchCompaniesHouseCompanies;
export const searchFilings = searchCompaniesHouseFilings;
export const getCompaniesHouseFilings = searchCompaniesHouseFilings;
export const getLatestReport = getLatestCompaniesHouseReport;
export const getOfficers = getCompaniesHouseOfficers;
export const getCompaniesHouseInsiders = getCompaniesHouseOfficers;
export const getPscs = getCompaniesHousePscs;
export const getPscStatements = getCompaniesHousePscStatements;
export const getOwners = getCompaniesHouseOwners;

export function createCompaniesHouseAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveCompaniesHouseCompany(query, options),
    searchEntities: (query: string) => searchCompaniesHouseCompanies(query, options),
    searchFilings: (input: string | CompaniesHouseFilingSearchParams) =>
      searchCompaniesHouseFilings(input, options),
    getLatestReport: (company: string, reportKind: "annual" | "quarterly") =>
      getLatestCompaniesHouseReport(company, reportKind, options),
    getOfficers: (company: string) => getCompaniesHouseOfficers(company, options),
    getPscs: (company: string) => getCompaniesHousePscs(company, options),
    getPscStatements: (company: string) =>
      getCompaniesHousePscStatements(company, options),
    getOwners: (company: string) => getCompaniesHouseOwners(company, options),
  };
}
