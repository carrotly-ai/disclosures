import { readCachedJson, writeCachedJson } from "../core/cache.js";
import { rankEntities } from "../core/entityMatching.js";
import {
  AdapterConfigurationError,
  AdapterError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { getBinary, getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString, type JsonRecord } from "../core/parsing.js";
import { edinetRateLimiter } from "../core/rateLimiter.js";
import { readSingleZipEntry } from "../core/zip.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  LatestReportMetadata,
  OwnerRecord,
} from "../core/types.js";

export const EDINET_API_BASE_URL = "https://api.edinet-fsa.go.jp/api/v2";
export const EDINET_CODE_LIST_URL =
  "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
export const EDINET_VIEWER_URL = "https://disclosure2.edinet-fsa.go.jp/WEEK0020.aspx";
export const EDINET_REQUEST_TIMEOUT_MS = 20_000;

// EDINET's documents.json returns a whole calendar day per request with no
// server-side company filter, so every filings query scans day by day. These
// caps bound the request count (and wall-clock) of a single scan.
export const EDINET_DEFAULT_SEARCH_DAYS = 90;
export const EDINET_MAX_SCAN_DAYS = 365;

// Large-volume holding report (350, 大量保有報告書) and its change report
// (360, 変更報告書) — the two filing types that carry a ≥5%-rule holder.
export const EDINET_LARGE_HOLDING_DOC_TYPES: ReadonlySet<string> = new Set([
  "350",
  "360",
]);

// Large-holding events are sparse per issuer and EDINET has no server-side
// subject filter, so the CompanyOwners reverse lookup scans the full retained
// window (one request per calendar day) to keep recall meaningful.
export const EDINET_OWNERS_SCAN_DAYS = EDINET_MAX_SCAN_DAYS;
export const EDINET_OWNERS_DEFAULT_LIMIT = 50;

/** docTypeCode → English label (EDINET API specification, appendix). */
export const EDINET_DOC_TYPE_LABELS: Record<string, string> = {
  "120": "Annual securities report (有価証券報告書)",
  "130": "Amended annual securities report (訂正有価証券報告書)",
  "140": "Quarterly report (四半期報告書)",
  "150": "Amended quarterly report (訂正四半期報告書)",
  "160": "Semi-annual report (半期報告書)",
  "170": "Amended semi-annual report (訂正半期報告書)",
  "180": "Extraordinary report (臨時報告書)",
  "350": "Large-volume holding report (大量保有報告書)",
  "360": "Change report — large-volume holding (変更報告書)",
};

export const EDINET_ANNUAL_DOC_TYPES = ["120"] as const;
export const EDINET_QUARTERLY_DOC_TYPES = ["140", "160"] as const;

export const EDINET_5_PERCENT_THRESHOLD_REGIME =
  "Japan 5% rule — large-shareholding report (大量保有報告書) under the " +
  "Financial Instruments and Exchange Act (holdings of 5% or more)";

export const EDINET_NO_CONFIG_MESSAGE =
  "EDINET document search requires an API key. Set EDINET_API_KEY.";
export const EDINET_RATE_LIMIT_MESSAGE =
  "EDINET request limit reached. Please retry later.";

export class EdinetConfigurationError extends AdapterConfigurationError {
  constructor(message = EDINET_NO_CONFIG_MESSAGE) {
    super(message, "EDINET");
    this.name = "EdinetConfigurationError";
  }
}

export class EdinetRateLimitError extends AdapterRateLimitError {
  constructor(message = EDINET_RATE_LIMIT_MESSAGE) {
    super(message, 600, 60_000, "EDINET");
    this.name = "EdinetRateLimitError";
  }
}

export class EdinetApiError extends AdapterError {
  constructor(
    readonly status: string,
    message: string,
  ) {
    super(message, "EDINET");
    this.name = "EdinetApiError";
  }
}

export function getEdinetApiKeyOrUndefined(
  options: AdapterOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  return env.EDINET_API_KEY?.trim() || undefined;
}

export function getEdinetApiKey(options: AdapterOptions = {}): string {
  const apiKey = getEdinetApiKeyOrUndefined(options);
  if (!apiKey) throw new EdinetConfigurationError();
  return apiKey;
}

export function hasEdinetConfiguration(options: AdapterOptions = {}): boolean {
  return getEdinetApiKeyOrUndefined(options) !== undefined;
}

export function getEdinetConfigurationError(
  options: AdapterOptions = {},
): EdinetConfigurationError | undefined {
  return hasEdinetConfiguration(options) ? undefined : new EdinetConfigurationError();
}

function acquireRequest(): void {
  if (!edinetRateLimiter.tryAcquire()) throw new EdinetRateLimitError();
}

// --- EDINET code list (name → codes) ---------------------------------------

export interface EdinetCodeEntry {
  edinetCode: string;
  filerName: string;
  filerNameEn?: string;
  secCode?: string;
  jcn?: string;
  listed?: boolean;
}

/**
 * Parse one CSV record, honouring double-quoted fields that may contain commas.
 * EdinetcodeDlInfo.csv fully quotes every field.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

interface ColumnIndex {
  edinetCode: number;
  filerName: number;
  filerNameEn: number;
  secCode: number;
  jcn: number;
  listed: number;
}

function locateColumns(header: string[]): ColumnIndex | undefined {
  const find = (predicate: (cell: string) => boolean): number =>
    header.findIndex((cell) => predicate(cell.trim()));
  const edinetCode = find((cell) => /EDINET|ＥＤＩＮＥＴ/.test(cell) && /コード/.test(cell));
  // The real header is "提出者名（英字）" for English and "提出者名（ヨミ）" for the
  // kana reading; the plain "提出者名" column is the Japanese legal name.
  const filerNameEn = find((cell) => cell.includes("提出者名") && cell.includes("英字"));
  const filerName = find(
    (cell) =>
      cell.includes("提出者名") && !cell.includes("英字") && !cell.includes("ヨミ"),
  );
  const secCode = find((cell) => cell.includes("証券コード"));
  const jcn = find((cell) => cell.includes("法人番号"));
  const listed = find((cell) => cell.includes("上場区分"));
  if (edinetCode < 0 || filerName < 0) return undefined;
  return { edinetCode, filerName, filerNameEn, secCode, jcn, listed };
}

export function parseEdinetCodeCsv(csv: string): EdinetCodeEntry[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let columns: ColumnIndex | undefined;
  let headerIndex = -1;
  for (let index = 0; index < Math.min(lines.length, 5); index += 1) {
    const candidate = locateColumns(parseCsvLine(lines[index] ?? ""));
    if (candidate) {
      columns = candidate;
      headerIndex = index;
      break;
    }
  }
  if (!columns || headerIndex < 0) return [];

  const cell = (row: string[], position: number): string | undefined => {
    if (position < 0) return undefined;
    return asString(row[position]);
  };

  const entries: EdinetCodeEntry[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const row = parseCsvLine(lines[index] ?? "");
    const edinetCode = cell(row, columns.edinetCode);
    const filerName = cell(row, columns.filerName);
    if (!edinetCode || !filerName) continue;
    const filerNameEn = cell(row, columns.filerNameEn);
    const secCode = cell(row, columns.secCode);
    const jcn = cell(row, columns.jcn);
    const listedRaw = cell(row, columns.listed);
    entries.push({
      edinetCode,
      filerName,
      ...(filerNameEn ? { filerNameEn } : {}),
      ...(secCode ? { secCode } : {}),
      ...(jcn ? { jcn } : {}),
      // The column is "上場" / "非上場" / empty; "非上場" contains "上場" as a
      // substring, so match exactly and leave the flag unset when unknown.
      ...(listedRaw ? { listed: listedRaw.trim() === "上場" } : {}),
    });
  }
  return entries;
}

let codeListPromise: Promise<EdinetCodeEntry[]> | undefined;

/** Cross-call cache key + TTL for the EDINET code list (regenerated daily). */
export const EDINET_CODE_LIST_CACHE_KEY = "edinet:code-list:v1";
export const EDINET_CODE_LIST_CACHE_TTL_MS = 24 * 60 * 60_000;

export function resetEdinetCodeCache(): void {
  codeListPromise = undefined;
}

/** Validate a cached code-list payload; a bad shape returns undefined (miss). */
function parseCodeListCache(value: unknown): EdinetCodeEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: EdinetCodeEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const edinetCode = asString(record?.edinetCode);
    const filerName = asString(record?.filerName);
    if (!edinetCode || !filerName) return undefined;
    const filerNameEn = asString(record?.filerNameEn);
    const secCode = asString(record?.secCode);
    const jcn = asString(record?.jcn);
    const listed = record?.listed;
    entries.push({
      edinetCode,
      filerName,
      ...(filerNameEn ? { filerNameEn } : {}),
      ...(secCode ? { secCode } : {}),
      ...(jcn ? { jcn } : {}),
      ...(typeof listed === "boolean" ? { listed } : {}),
    });
  }
  return entries.length ? entries : undefined;
}

async function fetchCodeList(options: AdapterOptions): Promise<EdinetCodeEntry[]> {
  // The code list download is public and does not require the API key, so JP
  // company resolution works even without EDINET_API_KEY.
  acquireRequest();
  const archive = await getBinary(
    EDINET_CODE_LIST_URL,
    { Accept: "application/zip, application/octet-stream, */*" },
    EDINET_REQUEST_TIMEOUT_MS,
    options.fetchFn ?? fetch,
  );
  const entry = readSingleZipEntry(archive, { maxEntrySize: 256 * 1024 * 1024 });
  // EdinetcodeDlInfo.csv is Shift_JIS encoded; decode natively (zero-dependency).
  const csv = new TextDecoder("shift_jis").decode(entry.data);
  const entries = parseEdinetCodeCsv(csv);
  if (!entries.length) {
    throw new EdinetApiError("", "EDINET code list contained no entries.");
  }
  return entries;
}

async function loadCodeList(options: AdapterOptions): Promise<EdinetCodeEntry[]> {
  // Prefer an injected cross-call cache (survives process restarts) so the
  // code-list archive is not re-downloaded on every cold start.
  if (options.cache) {
    const cached = await readCachedJson(
      options.cache,
      EDINET_CODE_LIST_CACHE_KEY,
      parseCodeListCache,
    );
    if (cached) return cached;
  }
  codeListPromise ??= fetchCodeList(options);
  let entries: EdinetCodeEntry[];
  try {
    entries = await codeListPromise;
  } catch (error) {
    codeListPromise = undefined;
    throw error;
  }
  if (options.cache) {
    await writeCachedJson(
      options.cache,
      EDINET_CODE_LIST_CACHE_KEY,
      entries,
      EDINET_CODE_LIST_CACHE_TTL_MS,
    );
  }
  return entries;
}

function viewerUrl(): string {
  return EDINET_VIEWER_URL;
}

function codeEntity(entry: EdinetCodeEntry, matchReason?: string): Entity {
  return {
    legalName: entry.filerName,
    edinetCode: entry.edinetCode,
    ...(entry.secCode ? { secCode: entry.secCode } : {}),
    ...(entry.jcn ? { jcn: entry.jcn } : {}),
    jurisdiction: "JP",
    source: "EDINET",
    sourceIdentifiers: {
      edinetCode: entry.edinetCode,
      ...(entry.secCode ? { secCode: entry.secCode } : {}),
      ...(entry.jcn ? { jcn: entry.jcn } : {}),
      jurisdiction: "JP",
    },
    sourceUrl: viewerUrl(),
    ...(entry.filerNameEn ? { aliases: [entry.filerNameEn] } : {}),
    ...(entry.listed !== undefined
      ? { status: entry.listed ? "Listed" : "Unlisted" }
      : {}),
    ...(matchReason ? { matchReason } : {}),
  };
}

export function isEdinetCode(value: string): boolean {
  return /^E\d{5}$/i.test(value.trim());
}

export function isEdinetSecCode(value: string): boolean {
  return /^\d{4,5}$/.test(value.trim());
}

export function isJapaneseCorporateNumber(value: string): boolean {
  return /^\d{13}$/.test(value.trim());
}

function secCodeMatches(entrySecCode: string | undefined, query: string): boolean {
  if (!entrySecCode) return false;
  const normalized = entrySecCode.trim();
  if (query.length === 5) return normalized === query;
  // 4-digit tickers map to a 5-digit EDINET security code (ticker + trailing 0).
  return normalized.slice(0, 4) === query;
}

export async function searchEdinetCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const entries = await loadCodeList(options);

  if (isEdinetCode(trimmed)) {
    const upper = trimmed.toUpperCase();
    const entry = entries.find((candidate) => candidate.edinetCode.toUpperCase() === upper);
    return entry ? [codeEntity(entry, "Exact EDINET-code match")] : [];
  }
  if (isJapaneseCorporateNumber(trimmed)) {
    const matches = entries.filter((candidate) => candidate.jcn === trimmed);
    return matches.map((entry) => codeEntity(entry, "Exact corporate-number (法人番号) match"));
  }
  if (isEdinetSecCode(trimmed)) {
    const matches = entries.filter((candidate) => secCodeMatches(candidate.secCode, trimmed));
    return matches.map((entry) => codeEntity(entry, "Exact securities-code match"));
  }

  const needle = trimmed.toLowerCase();
  const candidates = entries
    .filter((entry) =>
      entry.filerName.toLowerCase().includes(needle) ||
      (entry.filerNameEn?.toLowerCase().includes(needle) ?? false)
    )
    .slice(0, 200)
    .map((entry) => codeEntity(entry));
  return rankEntities(trimmed, candidates, {
    fallbackReason: "EDINET legal-name search result",
  }).slice(0, 25);
}

export async function resolveEdinetCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchEdinetCompanies(query, options))[0] ?? null;
}

export async function resolveEdinetCode(
  query: string,
  options: AdapterOptions = {},
): Promise<string> {
  const entity = await resolveEdinetCompany(query, options);
  if (!entity?.edinetCode) {
    throw new Error(`No EDINET company found for ${query}.`);
  }
  return entity.edinetCode;
}

// --- Date-indexed document scanning ----------------------------------------

function toUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function documentsUrl(date: string, apiKey: string): string {
  const url = new URL(`${EDINET_API_BASE_URL}/documents.json`);
  url.searchParams.set("date", date);
  url.searchParams.set("type", "2");
  url.searchParams.set("Subscription-Key", apiKey);
  return url.toString();
}

async function fetchEdinetDay(
  date: string,
  apiKey: string,
  options: AdapterOptions,
): Promise<JsonRecord[]> {
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      documentsUrl(date, apiKey),
      { Accept: "application/json" },
      EDINET_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 429) throw new EdinetRateLimitError();
      // A day outside EDINET's retained range answers 400/404; treat as empty.
      if (error.status === 400 || error.status === 404) return [];
    }
    throw error;
  }
  const record = asRecord(payload);
  const metadata = asRecord(record?.metadata);
  const status = asString(metadata?.status);
  if (status && status !== "200") {
    if (status === "404") return [];
    if (status === "429") throw new EdinetRateLimitError();
    throw new EdinetApiError(
      status,
      asString(metadata?.message) ?? `EDINET returned status ${status}.`,
    );
  }
  return asArray(record?.results).flatMap((item) => {
    const row = asRecord(item);
    return row ? [row] : [];
  });
}

function formatSubmitDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : fallback;
}

function documentToFiling(row: JsonRecord, scanDate: string): Filing | undefined {
  const docId = asString(row.docID);
  const edinetCode = asString(row.edinetCode);
  if (!docId || !edinetCode) return undefined;
  const docTypeCode = asString(row.docTypeCode);
  const description = asString(row.docDescription) ?? "EDINET filing";
  const label = (docTypeCode ? EDINET_DOC_TYPE_LABELS[docTypeCode] : undefined) ??
    docTypeCode ?? "Filing";
  const filerName = asString(row.filerName);
  const secCode = asString(row.secCode);
  const jcn = asString(row.JCN);
  return {
    filedDate: formatSubmitDate(asString(row.submitDateTime), scanDate),
    form: label,
    ...(filerName ? { category: filerName } : {}),
    description,
    accession: docId,
    sourceUrl: viewerUrl(),
    source: "EDINET",
    sourceIdentifiers: {
      edinetCode,
      ...(secCode ? { secCode } : {}),
      ...(jcn ? { jcn } : {}),
      jurisdiction: "JP",
    },
  };
}

export interface EdinetScanParams {
  edinetCode: string;
  startDate?: string;
  endDate?: string;
  docTypeCodes?: ReadonlySet<string>;
  limit?: number;
  maxDays?: number;
}

/**
 * Walk backwards one calendar day at a time — EDINET's only query axis —
 * invoking `onRow` for every document in each day's index. The walk stops when
 * the day budget is exhausted, the start bound is crossed, or `shouldStop`
 * returns true after a day has been processed, so a single call issues a
 * predictable number of requests. The subscription key is resolved up front so
 * a missing key fails fast (and consistently) before any request is made.
 */
async function walkEdinetDays(
  params: { startDate?: string; endDate?: string; maxDays?: number },
  options: AdapterOptions,
  onRow: (row: JsonRecord, scanDate: string) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const apiKey = getEdinetApiKey(options);
  const end = params.endDate ? toUtcDate(params.endDate) : toUtcDate(toIsoDate(new Date()));
  const maxDays = Math.min(params.maxDays ?? EDINET_MAX_SCAN_DAYS, EDINET_MAX_SCAN_DAYS);
  const startBound = params.startDate ? toUtcDate(params.startDate) : undefined;

  const cursor = new Date(end);
  for (let day = 0; day < maxDays; day += 1) {
    if (startBound && cursor.getTime() < startBound.getTime()) break;
    const date = toIsoDate(cursor);
    const rows = await fetchEdinetDay(date, apiKey, options);
    for (const row of rows) onRow(row, date);
    if (shouldStop()) break;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
}

/**
 * Walk backwards one calendar day at a time, collecting this filer's documents.
 * Bounded by maxDays and by limit so a single call issues a predictable number
 * of requests.
 */
async function scanEdinetDocuments(
  params: EdinetScanParams,
  options: AdapterOptions,
): Promise<Filing[]> {
  const limit = params.limit ?? Number.POSITIVE_INFINITY;
  const filings: Filing[] = [];
  await walkEdinetDays(
    params,
    options,
    (row, date) => {
      if (asString(row.edinetCode) !== params.edinetCode) return;
      if (params.docTypeCodes) {
        const code = asString(row.docTypeCode);
        if (!code || !params.docTypeCodes.has(code)) return;
      }
      const filing = documentToFiling(row, date);
      if (filing) filings.push(filing);
    },
    () => filings.length >= limit,
  );
  return filings;
}

export interface EdinetFilingSearchParams {
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

export async function searchEdinetFilings(
  input: string | EdinetFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const edinetCode = await resolveEdinetCode(params.company, options);
  const endDate = params.endDate ?? toIsoDate(new Date());
  const startDate = params.startDate ??
    toIsoDate(new Date(toUtcDate(endDate).getTime() - EDINET_DEFAULT_SEARCH_DAYS * 86_400_000));
  const limit = Math.max(1, params.limit ?? 20);
  const filings = await scanEdinetDocuments(
    { edinetCode, startDate, endDate },
    options,
  );
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

export async function getLatestEdinetReport(
  company: string,
  reportKind: "annual" | "quarterly",
  options: AdapterOptions = {},
): Promise<LatestReportMetadata | null> {
  const edinetCode = await resolveEdinetCode(company, options);
  const docTypeCodes = new Set<string>(
    reportKind === "annual" ? EDINET_ANNUAL_DOC_TYPES : EDINET_QUARTERLY_DOC_TYPES,
  );
  const filings = await scanEdinetDocuments(
    { edinetCode, docTypeCodes, limit: 1 },
    options,
  );
  const match = filings
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))[0];
  if (!match) return null;
  return {
    ...match,
    reportKind,
    sectionLinks: [
      {
        section: "edinet-viewer",
        description: `EDINET viewer — search docID ${match.accession ?? ""}`.trim(),
        url: match.sourceUrl,
      },
    ],
  };
}

// --- Large-volume holding reports (大量保有報告書 — the 5% rule) --------------

/**
 * Map one large-volume holding document to an owner record for a given subject
 * issuer. The filer (`filerName`) is the ≥5% holder; the subject issuer is
 * identified upstream by `issuerEdinetCode`. EDINET's day index does not carry
 * the holding ratio, so `pct` is intentionally omitted — parity with the SEC
 * 13D/G owners path, which likewise reports the filing, not the exact stake.
 */
function documentToOwner(
  row: JsonRecord,
  subjectEdinetCode: string,
  scanDate: string,
): OwnerRecord | undefined {
  const docId = asString(row.docID);
  const holderName = asString(row.filerName);
  if (!docId || !holderName) return undefined;
  const docTypeCode = asString(row.docTypeCode);
  const label = (docTypeCode ? EDINET_DOC_TYPE_LABELS[docTypeCode] : undefined) ??
    "Large-volume holding report (大量保有報告書)";
  const filedDate = formatSubmitDate(asString(row.submitDateTime), scanDate);
  const reason = asString(row.currentReportReason);
  return {
    holderName,
    holderType: docTypeCode === "360"
      ? "Large-volume holding change report filer (変更報告書)"
      : "Large-volume holding report filer (大量保有報告書)",
    thresholdRegime: EDINET_5_PERCENT_THRESHOLD_REGIME,
    form: label,
    filedDate,
    notifiedDate: filedDate,
    ...(reason ? { naturesOfControl: [reason] } : {}),
    accession: docId,
    sourceUrl: viewerUrl(),
    source: "EDINET",
    // sourceIdentifiers scope the *subject* issuer (whose shares are held); the
    // ≥5% holder itself is carried in holderName.
    sourceIdentifiers: {
      edinetCode: subjectEdinetCode,
      jurisdiction: "JP",
    },
  };
}

export interface EdinetOwnersParams {
  startDate?: string;
  endDate?: string;
  maxDays?: number;
  limit?: number;
}

/**
 * Reverse-map EDINET's filer-indexed large-holding reports onto a subject
 * issuer: scan the date index for 大量保有報告書 (docType 350) and its change
 * reports (360) whose `issuerEdinetCode` is the resolved company, so each row's
 * filer is a ≥5% holder of that company. EDINET's metadata does not carry the
 * holding ratio, so exact percentages require opening the linked report.
 */
export async function getEdinetLargeHolders(
  company: string,
  params: EdinetOwnersParams = {},
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const subjectEdinetCode = await resolveEdinetCode(company, options);
  const endDate = params.endDate ?? toIsoDate(new Date());
  const startDate = params.startDate ??
    toIsoDate(new Date(toUtcDate(endDate).getTime() - EDINET_OWNERS_SCAN_DAYS * 86_400_000));
  const limit = Math.max(1, params.limit ?? EDINET_OWNERS_DEFAULT_LIMIT);

  const owners: OwnerRecord[] = [];
  await walkEdinetDays(
    {
      startDate,
      endDate,
      ...(params.maxDays !== undefined ? { maxDays: params.maxDays } : {}),
    },
    options,
    (row, date) => {
      if (asString(row.issuerEdinetCode) !== subjectEdinetCode) return;
      const code = asString(row.docTypeCode);
      if (!code || !EDINET_LARGE_HOLDING_DOC_TYPES.has(code)) return;
      const owner = documentToOwner(row, subjectEdinetCode, date);
      if (owner) owners.push(owner);
    },
    () => owners.length >= limit,
  );
  return owners
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveEdinetCompany;
export const searchCompanies = searchEdinetCompanies;
export const searchFilings = searchEdinetFilings;
export const getLatestReport = getLatestEdinetReport;
export const getOwners = getEdinetLargeHolders;

export function createEdinetAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveEdinetCompany(query, options),
    searchEntities: (query: string) => searchEdinetCompanies(query, options),
    searchFilings: (input: string | EdinetFilingSearchParams) =>
      searchEdinetFilings(input, options),
    getLatestReport: (company: string, reportKind: "annual" | "quarterly") =>
      getLatestEdinetReport(company, reportKind, options),
    getOwners: (company: string, params?: EdinetOwnersParams) =>
      getEdinetLargeHolders(company, params, options),
  };
}
