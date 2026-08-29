import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getBinary, getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { idxRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  FinancialBasis,
  FinancialFact,
  Filing,
} from "../core/types.js";
import { readZipEntries } from "../core/zip.js";

// IDX (Bursa Efek Indonesia) fronts its listed-company data with keyless
// ASP.NET JSON endpoints under `/primary/…`. The canonical host,
// `www.idx.co.id`, sits behind an anti-bot edge (Cloudflare / Imperva) that
// answers a plain request with a `403` challenge shell — but the same paths
// render full JSON through a real browser from a regional IP.
//
// So this adapter follows the BSE India precedent exactly: it is INJECT-FRIENDLY.
// It issues the request with realistic browser headers on the default fetch and
// works outright wherever the edge lets that through; where the edge blocks it,
// the typed `IdxBlockedError` carries an honest "inject a browser-backed
// fetchFn via AdapterOptions" note rather than an empty or fabricated result.
export const IDX_SITE_URL = "https://www.idx.co.id";
export const IDX_API_BASE_URL = `${IDX_SITE_URL}/primary`;
export const IDX_PROFILES_URL =
  `${IDX_API_BASE_URL}/ListedCompany/GetCompanyProfiles`;
export const IDX_ANNOUNCEMENT_URL =
  `${IDX_API_BASE_URL}/ListedCompany/GetAnnouncement`;
export const IDX_FINANCIAL_REPORT_URL =
  `${IDX_API_BASE_URL}/ListedCompany/GetFinancialReport`;

export const IDX_REQUEST_TIMEOUT_MS = 25_000;
export const IDX_DOWNLOAD_TIMEOUT_MS = 45_000;
export const IDX_DEFAULT_SEARCH_LIMIT = 20;
export const IDX_DEFAULT_LOOKBACK_DAYS = 365;
/** The whole listed-issuer roster is ~965 rows; one page covers it. */
export const IDX_PROFILE_PAGE_SIZE = 1200;
/** Instance archives are tens-to-hundreds of KB; cap well clear of that. */
export const IDX_INSTANCE_MAX_BYTES = 24 * 1024 * 1024;

export const IDX_ANTIBOT_NOTE =
  "IDX's www.idx.co.id host is anti-bot protected (edge challenge); the " +
  "default fetch may be blocked from some networks. For reliable access, " +
  "inject a browser-backed fetchFn via AdapterOptions — the same escape " +
  "hatch this library uses for BSE India.";

export const IDX_RATE_LIMIT_MESSAGE =
  "IDX request limit reached. Please retry later.";

export class IdxRateLimitError extends AdapterRateLimitError {
  constructor(message = IDX_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "IDX");
    this.name = "IdxRateLimitError";
  }
}

export class IdxApiError extends AdapterError {
  constructor(message: string) {
    super(message, "IDX");
    this.name = "IdxApiError";
  }
}

/**
 * The anti-bot edge refused the request. Distinct from a generic API error so
 * the tool layer can render the honest inject-a-fetchFn guidance instead of a
 * bare HTTP status — and never an empty "no results" that would read as though
 * the issuer genuinely has nothing on file.
 */
export class IdxBlockedError extends AdapterError {
  constructor(readonly status: number, message = IDX_ANTIBOT_NOTE) {
    super(
      `IDX returned HTTP ${status} for this request — the host's anti-bot ` +
        `edge blocked it, so no data could be read (this is NOT an empty ` +
        `result for the issuer). ${message}`,
      "IDX",
    );
    this.name = "IdxBlockedError";
  }
}

function acquireRequest(): void {
  if (!idxRateLimiter.tryAcquire()) throw new IdxRateLimitError();
}

// The `/primary/…` endpoints reject requests that do not look browser-issued.
// These are the headers a real browser sends for the site's own XHRs.
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36",
  Referer: `${IDX_SITE_URL}/en/listed-companies/company-profiles/`,
  "X-Requested-With": "XMLHttpRequest",
};

const DOWNLOAD_HEADERS: Record<string, string> = {
  Accept: "application/zip, application/octet-stream, */*",
  "User-Agent": BROWSER_HEADERS["User-Agent"] ?? "",
  Referer: `${IDX_SITE_URL}/en/listed-companies/financial-statements-and-annual-report/`,
};

/**
 * Classify a transport failure. A 403/503 challenge from the edge is the
 * documented blocked path (403 is the Imperva/Cloudflare shell; the same edge
 * also answers 503 from its Varnish tier for a request it will not proxy), and
 * a 429 is a genuine rate limit.
 */
function mapHttpError(error: unknown): unknown {
  if (error instanceof HttpError) {
    if (error.status === 429) return new IdxRateLimitError();
    if (error.status === 403 || error.status === 503 || error.status === 401) {
      return new IdxBlockedError(error.status);
    }
  }
  return error;
}

async function idxGetJson(
  url: string,
  options: AdapterOptions,
): Promise<unknown> {
  acquireRequest();
  try {
    return await getJson(
      url,
      BROWSER_HEADERS,
      IDX_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    // A challenge page is HTML: the edge sometimes answers 200-with-HTML rather
    // than a 4xx, which surfaces here as a JSON parse failure. Treat that as
    // blocked too rather than leaking a SyntaxError.
    if (error instanceof SyntaxError) throw new IdxBlockedError(200);
    throw mapHttpError(error);
  }
}

// --- Resolution ------------------------------------------------------------

/** IDX tickers ("kode emiten") are exactly four uppercase letters, e.g. BBCA. */
export function isIdxTicker(value: string): boolean {
  return /^[A-Za-z]{4}$/.test(value.trim());
}

export interface IdxProfile {
  kodeEmiten: string;
  namaEmiten: string;
  sektor?: string;
  subSektor?: string;
  industri?: string;
  papanPencatatan?: string;
  tanggalPencatatan?: string;
  website?: string;
  alamat?: string;
}

/** IDX dates arrive as ".NET" ISO-ish stamps ("1997-12-09T00:00:00"). */
function toIsoDate(value: unknown): string | undefined {
  const text = asString(value);
  const match = text?.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

/**
 * `Kode_Emiten` arrives space-padded to a fixed column width in the
 * announcement feed; the profile feed does not pad it. Trim either shape.
 */
function cleanCode(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text.toUpperCase() : undefined;
}

export function parseIdxProfiles(payload: unknown): IdxProfile[] {
  const rows = asArray(asRecord(payload)?.data);
  const profiles: IdxProfile[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const kodeEmiten = cleanCode(row.KodeEmiten);
    const namaEmiten = asString(row.NamaEmiten)?.trim();
    if (!kodeEmiten || !namaEmiten) continue;
    const listingDate = toIsoDate(row.TanggalPencatatan);
    profiles.push({
      kodeEmiten,
      namaEmiten,
      ...(asString(row.Sektor)?.trim() ? { sektor: asString(row.Sektor)!.trim() } : {}),
      ...(asString(row.SubSektor)?.trim()
        ? { subSektor: asString(row.SubSektor)!.trim() }
        : {}),
      ...(asString(row.Industri)?.trim()
        ? { industri: asString(row.Industri)!.trim() }
        : {}),
      ...(asString(row.PapanPencatatan)?.trim()
        ? { papanPencatatan: asString(row.PapanPencatatan)!.trim() }
        : {}),
      ...(listingDate ? { tanggalPencatatan: listingDate } : {}),
      ...(asString(row.Website)?.trim() ? { website: asString(row.Website)!.trim() } : {}),
      ...(asString(row.Alamat)?.trim() ? { alamat: asString(row.Alamat)!.trim() } : {}),
    });
  }
  return profiles;
}

function profileToEntity(profile: IdxProfile, matchReason: string): Entity {
  const sector = [profile.sektor, profile.subSektor].filter(Boolean).join(" / ");
  return {
    legalName: profile.namaEmiten,
    ticker: profile.kodeEmiten,
    jurisdiction: "ID",
    source: "IDX",
    ...(profile.papanPencatatan ? { status: `Board: ${profile.papanPencatatan}` } : {}),
    sourceIdentifiers: {
      // KodeEmiten is IDX's own issuer key and the id every other IDX intent
      // takes, so it is surfaced under its native name as well as `ticker`.
      kodeEmiten: profile.kodeEmiten,
      ticker: profile.kodeEmiten,
      jurisdiction: "ID",
      ...(sector ? { sector } : {}),
      ...(profile.tanggalPencatatan ? { listingDate: profile.tanggalPencatatan } : {}),
    },
    sourceUrl:
      `${IDX_SITE_URL}/en/listed-companies/company-profiles/` +
      `?kodeEmiten=${encodeURIComponent(profile.kodeEmiten)}`,
    matchReason,
  };
}

/**
 * Fetch the listed-issuer roster. IDX's `code` filter is a server-side prefix
 * match on the ticker, so an exact 4-letter ticker is asked for directly and
 * anything else pulls the (single-page, ~965-row) roster for local ranking.
 */
async function fetchIdxProfiles(
  query: string,
  options: AdapterOptions,
): Promise<IdxProfile[]> {
  const trimmed = query.trim();
  const code = isIdxTicker(trimmed) ? trimmed.toUpperCase() : "";
  const url =
    `${IDX_PROFILES_URL}?start=0&length=${IDX_PROFILE_PAGE_SIZE}` +
    `&code=${encodeURIComponent(code)}`;
  return parseIdxProfiles(await idxGetJson(url, options));
}

export async function searchIdxCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const profiles = await fetchIdxProfiles(trimmed, options);

  if (isIdxTicker(trimmed)) {
    const upper = trimmed.toUpperCase();
    const exact = profiles.filter((profile) => profile.kodeEmiten === upper);
    if (exact.length) {
      return exact.map((profile) =>
        profileToEntity(profile, "Exact IDX ticker (kode emiten) match"),
      );
    }
  }
  const entities = profiles.map((profile) =>
    profileToEntity(profile, "IDX listed-company profile match"),
  );
  return rankEntities(trimmed, entities, {
    fallbackReason: "IDX listed-company profile match",
  });
}

export async function resolveIdxCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchIdxCompanies(query, options))[0] ?? null;
}

async function resolveIdxTicker(
  query: string,
  options: AdapterOptions,
): Promise<Entity> {
  const entity = await resolveIdxCompany(query, options);
  if (!entity?.ticker) throw new Error(`No IDX company found for ${query}.`);
  return entity;
}

// --- Announcements (CompanyFilings) ----------------------------------------

/** GetAnnouncement's date params are `YYYYMMDD`, not ISO. */
function toIdxDateParam(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One announcement row: `{ pengumuman: {...}, attachments: [...] }`. The first
 * non-`IsAttachment` file is the announcement letter itself; the rest are its
 * lampiran (annexes), so the letter is preferred as the row's link.
 */
export function parseIdxAnnouncements(
  payload: unknown,
  fallbackTicker: string,
): Filing[] {
  const replies = asArray(asRecord(payload)?.Replies);
  const filings: Filing[] = [];
  for (const item of replies) {
    const reply = asRecord(item);
    const announcement = asRecord(reply?.pengumuman);
    if (!announcement) continue;
    const title = asString(announcement.JudulPengumuman)?.trim();
    if (!title) continue;
    const filedDate = toIsoDate(announcement.TglPengumuman);
    if (!filedDate) continue;
    const ticker = cleanCode(announcement.Kode_Emiten) ?? fallbackTicker;
    const attachments = asArray(reply?.attachments).flatMap((entry) => {
      const attachment = asRecord(entry);
      const url = asString(attachment?.FullSavePath)?.trim();
      return url ? [{ url, isAnnex: attachment?.IsAttachment === true }] : [];
    });
    const primary =
      attachments.find((attachment) => !attachment.isAnnex) ?? attachments[0];
    const announcementNumber = asString(announcement.NoPengumuman)?.trim();
    const kind = asString(announcement.JenisPengumuman)?.trim();
    filings.push({
      filedDate,
      form: kind ? `Announcement (${kind})` : "Announcement",
      ...(ticker ? { category: ticker } : {}),
      description: title,
      ...(announcementNumber ? { accession: announcementNumber } : {}),
      sourceUrl:
        primary?.url ?? `${IDX_SITE_URL}/en/listed-companies/announcement/`,
      source: "IDX",
      sourceIdentifiers: {
        jurisdiction: "ID",
        ...(ticker ? { kodeEmiten: ticker, ticker } : {}),
      },
    });
  }
  return filings;
}

export interface IdxFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

function filingMatchesForms(filing: Filing, forms: readonly string[]): boolean {
  if (!forms.length) return true;
  const haystack = `${filing.form} ${filing.description}`.toLowerCase();
  return forms.some((form) => {
    const needle = form.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export async function searchIdxFilings(
  input: string | IdxFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveIdxTicker(params.company, options);
  const ticker = entity.ticker ?? params.company.trim().toUpperCase();
  const limit = Math.max(1, params.limit ?? IDX_DEFAULT_SEARCH_LIMIT);
  const endDate = params.endDate ?? isoToday();
  const startDate = params.startDate ?? isoDaysAgo(IDX_DEFAULT_LOOKBACK_DAYS);

  const url =
    `${IDX_ANNOUNCEMENT_URL}?indexFrom=0&pageSize=${limit}` +
    `&dateFrom=${toIdxDateParam(startDate)}&dateTo=${toIdxDateParam(endDate)}` +
    `&lang=en&keyword=&emitenType=s&kodeEmiten=${encodeURIComponent(ticker)}` +
    `&SortColumn=KodeEmiten&SortOrder=asc`;

  const filings = parseIdxAnnouncements(await idxGetJson(url, options), ticker);
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

// --- Financial reports + XBRL instances (CompanyFinancials) -----------------

export type IdxReportPeriod = "audit" | "tw1" | "tw2" | "tw3";

export interface IdxReportAttachment {
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
}

export interface IdxFinancialReport {
  kodeEmiten: string;
  namaEmiten: string;
  reportYear: string;
  reportPeriod: string;
  fileModified?: string;
  attachments: IdxReportAttachment[];
}

/**
 * Attachment paths are site-relative (`/Portals/0/StaticData/…`) and contain
 * spaces and a stray double slash as filed. Encode each segment rather than the
 * whole path so the separators survive.
 */
export function idxAttachmentUrl(filePath: string): string {
  const normalized = filePath.startsWith("/") ? filePath : `/${filePath}`;
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${IDX_SITE_URL}${encoded}`;
}

export function parseIdxFinancialReports(payload: unknown): IdxFinancialReport[] {
  const results = asArray(asRecord(payload)?.Results);
  const reports: IdxFinancialReport[] = [];
  for (const item of results) {
    const row = asRecord(item);
    if (!row) continue;
    const kodeEmiten = cleanCode(row.KodeEmiten);
    if (!kodeEmiten) continue;
    const attachments = asArray(row.Attachments).flatMap((entry) => {
      const attachment = asRecord(entry);
      const fileName = asString(attachment?.File_Name)?.trim();
      const filePath = asString(attachment?.File_Path)?.trim();
      if (!fileName || !filePath) return [];
      const size = attachment?.File_Size;
      return [{
        fileName,
        fileType: asString(attachment?.File_Type)?.trim() ?? "",
        fileSize: typeof size === "number" ? size : 0,
        url: idxAttachmentUrl(filePath),
      }];
    });
    reports.push({
      kodeEmiten,
      namaEmiten: asString(row.NamaEmiten)?.trim() ?? kodeEmiten,
      reportYear: asString(row.Report_Year)?.trim() ?? "",
      reportPeriod: asString(row.Report_Period)?.trim() ?? "",
      ...(toIsoDate(row.File_Modified) ? { fileModified: toIsoDate(row.File_Modified)! } : {}),
      attachments,
    });
  }
  return reports;
}

/** The machine-readable XBRL instance package, where the filer submitted one. */
export function findIdxInstanceAttachment(
  report: IdxFinancialReport,
): IdxReportAttachment | undefined {
  return report.attachments.find(
    (attachment) => attachment.fileName.toLowerCase() === "instance.zip",
  );
}

/** Best human-readable fallback link when no instance is present/parseable. */
export function findIdxReportFallback(
  report: IdxFinancialReport,
): IdxReportAttachment | undefined {
  const byExtension = (extension: string) =>
    report.attachments.find((attachment) =>
      attachment.fileName.toLowerCase().endsWith(extension),
    );
  return byExtension(".xlsx") ?? byExtension(".pdf") ?? report.attachments[0];
}

export async function getIdxFinancialReports(
  ticker: string,
  year: number,
  period: IdxReportPeriod,
  options: AdapterOptions = {},
): Promise<IdxFinancialReport[]> {
  const url =
    `${IDX_FINANCIAL_REPORT_URL}?indexFrom=0&pageSize=10&year=${year}` +
    `&reportType=rdf&EmitenType=s&periode=${period}` +
    `&kodeEmiten=${encodeURIComponent(ticker)}` +
    `&SortColumn=KodeEmiten&SortOrder=asc`;
  return parseIdxFinancialReports(await idxGetJson(url, options));
}

// --- IDX XBRL instance parsing ---------------------------------------------

// IDX filings use the Indonesian IFRS-derived taxonomy (idx-cor, 2020-01-01),
// which is namespaced but plain-XBRL — the same shape the JP EDINET path
// parses. Concepts are matched by LOCAL NAME so any taxonomy year/prefix
// variant (idx-cor:, idx_cor:, a future idx-cor-2024:) resolves identically.
//
// Element ORDER within each concept is the preference order: the first element
// a filer actually tags wins. Sector matters here — a bank (BBCA) files no
// `SalesAndRevenue` and reports interest income instead, so the revenue spec
// carries the banking/financing variants after the general-industry element.
interface IdxConceptSpec {
  concept: string;
  label: string;
  elements: readonly string[];
}

export const IDX_FINANCIAL_CONCEPTS: readonly IdxConceptSpec[] = [
  {
    concept: "revenues",
    label: "Revenue",
    elements: [
      "SalesAndRevenue",
      "Revenue",
      "RevenueFromContractsWithCustomers",
      // Financial-sector filers report interest/sharia income in place of sales.
      "TotalInterestAndShariaIncome",
      "TotalRevenues",
      "RevenueFromFinancingTransactions",
    ],
  },
  {
    concept: "operating_income",
    label: "Profit from operations",
    elements: ["ProfitFromOperation", "ProfitLossFromOperatingActivities"],
  },
  {
    concept: "net_income",
    label: "Profit for the period (attributable to owners of the parent)",
    elements: [
      "ProfitLossAttributableToParentEntity",
      "ProfitLoss",
      "ProfitLossFromContinuingOperations",
    ],
  },
  {
    concept: "total_assets",
    label: "Total assets",
    elements: ["Assets"],
  },
  {
    concept: "stockholders_equity",
    label: "Total equity",
    elements: ["EquityAttributableToEquityOwnersOfParentEntity", "Equity"],
  },
];

export const IDX_FINANCIAL_CONCEPT_NAMES = IDX_FINANCIAL_CONCEPTS.map(
  (spec) => spec.concept,
);

export const IDX_DEFAULT_PERIOD_COUNT = 2;
export const IDX_MAX_PERIOD_COUNT = 2;

export const IDX_FINANCIALS_CAVEAT =
  "As-filed figures parsed directly from the XBRL instance (instance.zip) of " +
  "the issuer's IDX financial-report submission, in Indonesian rupiah (IDR), " +
  "under the IDX 2020 taxonomy (idx-cor, IFRS/PSAK-derived). Only undimensioned " +
  "headline statement totals are extracted (revenue, profit from operations, " +
  "profit attributable to owners of the parent, total assets, total equity) — " +
  "no segment or note detail — and one instance carries the current period plus " +
  "the comparative prior year it restates. \"Basis\" reflects the filer's own " +
  "declaration of whether the statements are a group (consolidated) or " +
  "individual-entity (separate) submission. Financial-sector filers report " +
  "interest and sharia income rather than sales, so the revenue line follows " +
  "the concept the filer actually tagged.";

type IdxPeriodKey = "current" | "prior1";

const IDX_PERIOD_ORDER: readonly IdxPeriodKey[] = ["current", "prior1"];

interface IdxContext {
  periodKey: IdxPeriodKey;
  periodEnd: string;
}

export interface IdxParsedFact {
  concept: string;
  label: string;
  periodKey: IdxPeriodKey;
  periodEnd: string;
  basis?: FinancialBasis;
  value: number;
  unit: string;
}

// Only the four UNDIMENSIONED period contexts qualify. IDX's dimensioned
// contexts append a statement-role id and member name
// (`CurrentYearInstant_4410000_NonControllingInterestsMember`), so anchoring
// the pattern end-to-end means a per-component figure can never be surfaced as
// a company total.
const IDX_CONTEXT_ID_RE =
  /^(CurrentYear|PriorYear|PriorEndYear)(Duration|Instant)$/;

const IDX_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Parse an IDX instance's contexts into period metadata. IDX uses three
 * prefixes: `CurrentYear*` for the reporting period, and both `PriorYear*` and
 * `PriorEndYear*` for the comparative — duration facts hang off
 * `PriorYearDuration` while the comparative balance-sheet date is
 * `PriorEndYearInstant`, so both map to the same prior period.
 */
export function parseIdxContexts(xbrl: string): Map<string, IdxContext> {
  const contexts = new Map<string, IdxContext>();
  const contextRe =
    /<(?:[A-Za-z][\w.-]*:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?context>/g;
  let match: RegExpExecArray | null;
  while ((match = contextRe.exec(xbrl)) !== null) {
    const id = match[1] ?? "";
    const body = match[2] ?? "";
    const idMatch = IDX_CONTEXT_ID_RE.exec(id);
    if (!idMatch) continue;
    // Belt and braces: an undimensioned context carries no explicitMember.
    if (/explicitMember/i.test(body)) continue;
    const periodKey: IdxPeriodKey =
      idMatch[1] === "CurrentYear" ? "current" : "prior1";
    const endTag =
      /<(?:[A-Za-z][\w.-]*:)?endDate>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?endDate>/.exec(body) ??
      /<(?:[A-Za-z][\w.-]*:)?instant>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?instant>/.exec(body);
    const periodEnd = endTag ? IDX_DATE_RE.exec(endTag[1] ?? "")?.[1] : undefined;
    if (!periodEnd) continue;
    contexts.set(id, { periodKey, periodEnd });
  }
  return contexts;
}

interface ElementBinding {
  concept: string;
  label: string;
  priority: number;
}

function buildElementIndex(
  concepts: ReadonlySet<string>,
): Map<string, ElementBinding> {
  const index = new Map<string, ElementBinding>();
  for (const spec of IDX_FINANCIAL_CONCEPTS) {
    if (!concepts.has(spec.concept)) continue;
    spec.elements.forEach((element, priority) => {
      if (!index.has(element)) {
        index.set(element, { concept: spec.concept, label: spec.label, priority });
      }
    });
  }
  return index;
}

interface FactCandidate extends ElementBinding {
  periodKey: IdxPeriodKey;
  periodEnd: string;
  value: number;
}

function parseIdxFactValue(text: string): number | undefined {
  const trimmed = text.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The filer declares its own consolidation basis in the dei section
 * ("Entitas grup / Group entity" vs "Entitas individual / Individual entity"),
 * which is more reliable than inferring one from context ids — IDX, unlike
 * EDINET, does not file both bases side by side in one instance.
 */
export function parseIdxBasis(xbrl: string): FinancialBasis | undefined {
  const match =
    /<(?:[A-Za-z][\w.-]*:)?WhetherTheFinancialStatementsAreOfAnIndividualEntityOrAGroupOfEntities\b[^>]*>([^<]*)</
      .exec(xbrl);
  const text = match?.[1]?.toLowerCase();
  if (!text) return undefined;
  if (/group|grup/.test(text)) return "consolidated";
  if (/individual/.test(text)) return "separate";
  return undefined;
}

/**
 * Extract normalized headline financial facts from one IDX XBRL instance. Pure
 * and offline: it takes the decoded instance text, so context selection and
 * concept matching are testable without a network fixture.
 *
 * `unitRef` is honoured: only facts denominated in the IDR monetary unit are
 * accepted, so a per-share figure (unit `IDRPerShares`) can never be mistaken
 * for a statement total. Values are as-filed absolute rupiah — IDX's
 * "level of rounding" dei field describes the PDF's presentation, not the
 * instance, whose facts are already full-scale.
 */
export function parseIdxXbrlFinancials(
  xbrl: string,
  params: { concepts?: readonly string[]; periods?: number } = {},
): IdxParsedFact[] {
  const wanted = new Set(
    params.concepts && params.concepts.length
      ? params.concepts.filter((concept) =>
          IDX_FINANCIAL_CONCEPT_NAMES.includes(concept),
        )
      : IDX_FINANCIAL_CONCEPT_NAMES,
  );
  if (!wanted.size) return [];
  const contexts = parseIdxContexts(xbrl);
  if (!contexts.size) return [];
  const elementIndex = buildElementIndex(wanted);
  const basis = parseIdxBasis(xbrl);

  // Resolve the instance's monetary unit ids (measure iso4217:IDR alone —
  // a divide-based unit like IDR/shares deliberately does not match).
  const monetaryUnits = new Set<string>();
  const unitRe =
    /<(?:[A-Za-z][\w.-]*:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?unit>/g;
  let unitMatch: RegExpExecArray | null;
  while ((unitMatch = unitRe.exec(xbrl)) !== null) {
    const body = unitMatch[2] ?? "";
    if (/divide/i.test(body)) continue;
    if (/iso4217:IDR\s*</i.test(body)) monetaryUnits.add(unitMatch[1] ?? "");
  }

  const chosen = new Map<string, FactCandidate>();
  // IDX prefixes are HYPHENATED (idx-cor, idx-dei) — `\w` would not match them,
  // so the prefix class is spelled out. Backreferences keep open/close paired.
  const factRe = /<([A-Za-z][\w.-]*):([A-Za-z0-9_]+)\b([^>]*)>([^<]*)<\/\1:\2>/g;
  let match: RegExpExecArray | null;
  while ((match = factRe.exec(xbrl)) !== null) {
    const localName = match[2] ?? "";
    const binding = elementIndex.get(localName);
    if (!binding) continue;
    const attrs = match[3] ?? "";
    const contextRef = /\bcontextRef="([^"]+)"/.exec(attrs)?.[1];
    if (!contextRef) continue;
    const context = contexts.get(contextRef);
    if (!context) continue;
    const unitRef = /\bunitRef="([^"]+)"/.exec(attrs)?.[1];
    if (!unitRef || (monetaryUnits.size && !monetaryUnits.has(unitRef))) continue;
    const value = parseIdxFactValue(match[4] ?? "");
    if (value === undefined) continue;
    const candidate: FactCandidate = {
      ...binding,
      periodKey: context.periodKey,
      periodEnd: context.periodEnd,
      value,
    };
    const key = `${binding.concept}|${context.periodKey}`;
    const current = chosen.get(key);
    if (!current || candidate.priority < current.priority) {
      chosen.set(key, candidate);
    }
  }

  const periodLimit = Math.min(
    IDX_MAX_PERIOD_COUNT,
    Math.max(1, params.periods ?? IDX_DEFAULT_PERIOD_COUNT),
  );
  const allowedPeriods = new Set(
    IDX_PERIOD_ORDER.filter((key) =>
      [...chosen.values()].some((candidate) => candidate.periodKey === key),
    ).slice(0, periodLimit),
  );

  const conceptOrder = new Map(
    IDX_FINANCIAL_CONCEPTS.map((spec, index) => [spec.concept, index]),
  );
  return [...chosen.values()]
    .filter((candidate) => allowedPeriods.has(candidate.periodKey))
    .map((candidate) => ({
      concept: candidate.concept,
      label: candidate.label,
      periodKey: candidate.periodKey,
      periodEnd: candidate.periodEnd,
      ...(basis ? { basis } : {}),
      value: candidate.value,
      unit: "IDR",
    }))
    .sort((left, right) => {
      if (left.periodEnd !== right.periodEnd) {
        return right.periodEnd.localeCompare(left.periodEnd);
      }
      return (
        (conceptOrder.get(left.concept) ?? 0) - (conceptOrder.get(right.concept) ?? 0)
      );
    });
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Download an `instance.zip` and decode the XBRL instance inside it. The
 * archive is a flat two-file package (`instance.xbrl` + `Taxonomy.xsd`); only
 * the instance is inflated, the schema is skipped.
 */
export async function downloadIdxXbrlInstance(
  url: string,
  options: AdapterOptions = {},
): Promise<string> {
  acquireRequest();
  let bytes: Uint8Array;
  try {
    bytes = await getBinary(
      url,
      DOWNLOAD_HEADERS,
      IDX_DOWNLOAD_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    throw mapHttpError(error);
  }
  if (!isZipBytes(bytes)) {
    // A challenge shell served in place of the archive: honest block, not an
    // "unparseable filing".
    throw new IdxBlockedError(200);
  }
  const entries = readZipEntries(bytes, {
    maxEntries: 64,
    maxEntrySize: IDX_INSTANCE_MAX_BYTES,
    maxTotalSize: IDX_INSTANCE_MAX_BYTES,
    filter: (name) => /\.(xbrl|xml)$/i.test(name) && !/taxonomy/i.test(name),
  });
  const instance =
    entries.find((entry) => /instance/i.test(entry.name)) ?? entries[0];
  if (!instance) {
    throw new IdxApiError(
      `IDX instance archive at ${url} contains no XBRL instance document.`,
    );
  }
  return new TextDecoder("utf-8").decode(instance.data);
}

export interface IdxFinancialsParams {
  company: string;
  concepts?: readonly string[];
  periods?: number;
  /** Report year to fetch; defaults to a short walk back from the current year. */
  year?: number;
  period?: IdxReportPeriod;
}

export interface IdxFinancialsResult {
  entity: Entity;
  facts: FinancialFact[];
  report?: IdxFinancialReport;
  /** Set when a report exists but no XBRL facts could be produced from it. */
  fallbackUrl?: string;
  fallbackReason?: string;
}

/** How many years back to look for the most recent audited report. */
const IDX_YEAR_LOOKBACK = 3;

/**
 * Normalized annual financial facts for an ID issuer, XBRL-first: resolve the
 * ticker, find its most recent audited financial-report submission, download
 * that submission's XBRL instance and extract the headline totals.
 *
 * Falls back HONESTLY rather than silently: where a report exists but carries
 * no `instance.zip`, or the instance is present but yields no matchable facts,
 * the result carries an empty `facts` list plus the official report link and
 * the reason — never an invented figure and never a bare "not found".
 */
export async function getIdxFinancials(
  input: string | IdxFinancialsParams,
  options: AdapterOptions = {},
): Promise<IdxFinancialsResult> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveIdxTicker(params.company, options);
  const ticker = entity.ticker ?? params.company.trim().toUpperCase();
  const period: IdxReportPeriod = params.period ?? "audit";

  const years = params.year
    ? [params.year]
    : Array.from(
        { length: IDX_YEAR_LOOKBACK },
        (_unused, index) => new Date().getFullYear() - index,
      );

  let report: IdxFinancialReport | undefined;
  for (const year of years) {
    const reports = await getIdxFinancialReports(ticker, year, period, options);
    const hit = reports.find((candidate) => candidate.kodeEmiten === ticker);
    if (hit?.attachments.length) {
      report = hit;
      break;
    }
  }
  if (!report) return { entity, facts: [] };

  const instance = findIdxInstanceAttachment(report);
  const fallback = findIdxReportFallback(report);
  const reportUrl = fallback?.url ?? instance?.url;
  const filedDate = report.fileModified ?? "";
  const form = `Financial statements ${report.reportYear}` +
    (report.reportPeriod ? ` (${report.reportPeriod})` : "");

  if (!instance) {
    return {
      entity,
      facts: [],
      report,
      ...(reportUrl ? { fallbackUrl: reportUrl } : {}),
      fallbackReason:
        "This IDX submission carries no XBRL instance (instance.zip) — only " +
        "the spreadsheet/PDF renditions, which this release does not parse.",
    };
  }

  let xbrl: string;
  try {
    xbrl = await downloadIdxXbrlInstance(instance.url, options);
  } catch (error) {
    // A blocked or rate-limited host is a transport problem the caller must
    // see as such; only a genuinely unreadable archive degrades to the link.
    if (error instanceof IdxBlockedError || error instanceof IdxRateLimitError) {
      throw error;
    }
    return {
      entity,
      facts: [],
      report,
      ...(reportUrl ? { fallbackUrl: reportUrl } : {}),
      fallbackReason:
        `The XBRL instance for this submission could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  const parsed = parseIdxXbrlFinancials(xbrl, {
    ...(params.concepts ? { concepts: params.concepts } : {}),
    ...(params.periods !== undefined ? { periods: params.periods } : {}),
  });
  if (!parsed.length) {
    return {
      entity,
      facts: [],
      report,
      ...(reportUrl ? { fallbackUrl: reportUrl } : {}),
      fallbackReason:
        "The XBRL instance for this submission tags none of the headline " +
        "totals this release extracts.",
    };
  }

  return {
    entity,
    report,
    facts: parsed.map((fact) => ({
      concept: fact.concept,
      label: fact.label,
      periodEnd: fact.periodEnd,
      value: fact.value,
      unit: fact.unit,
      filedDate,
      form,
      ...(fact.basis ? { basis: fact.basis } : {}),
      sourceUrl: instance.url,
      source: "IDX" as const,
      sourceIdentifiers: { kodeEmiten: ticker, ticker, jurisdiction: "ID" },
    })),
  };
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveIdxCompany;
export const searchCompanies = searchIdxCompanies;
export const searchFilings = searchIdxFilings;
export const getFinancials = getIdxFinancials;

export function createIdxAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveIdxCompany(query, options),
    searchEntities: (query: string) => searchIdxCompanies(query, options),
    searchFilings: (input: string | IdxFilingSearchParams) =>
      searchIdxFilings(input, options),
    getFinancials: (input: string | IdxFinancialsParams) =>
      getIdxFinancials(input, options),
  };
}
