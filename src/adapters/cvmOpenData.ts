import { readCachedJson, writeCachedJson } from "../core/cache.js";
import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getBinary, HttpError } from "../core/http.js";
import { cvmRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  FinancialBasis,
  FinancialFact,
} from "../core/types.js";
import { readZipEntries } from "../core/zip.js";

// Brazil's securities regulator, the Comissão de Valores Mobiliários (CVM),
// publishes keyless open data over every listed company (companhia aberta) at
// dados.cvm.gov.br under the Open Data License. The feeds are whole-market
// snapshots — a semicolon-delimited, Latin-1 (ISO-8859-1) registration CSV plus
// per-year IPE (disclosure index) and DFP (annual standardized financial
// statements) ZIP bundles — with no server-side company filter. This adapter
// resolves a company to its numeric CVM code from the registration file and
// then filters each intent dataset client-side by that code.
export const CVM_BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA";
export const CVM_REGISTRATION_URL = `${CVM_BASE_URL}/CAD/DADOS/cad_cia_aberta.csv`;
/** Human-facing CKAN dataset landing pages used as stable source links. */
export const CVM_REGISTRATION_DATASET_URL =
  "https://dados.cvm.gov.br/dataset/cia_aberta-cad";
export const CVM_IPE_DATASET_URL =
  "https://dados.cvm.gov.br/dataset/cia_aberta-doc-ipe";
export const CVM_DFP_DATASET_URL =
  "https://dados.cvm.gov.br/dataset/cia_aberta-doc-dfp";

export const CVM_REQUEST_TIMEOUT_MS = 30_000;
// The DFP year bundle is ~13 MB compressed and inflates to ~130 MB across its
// statement CSVs, so its download needs a longer ceiling than the small
// registration and IPE feeds.
export const CVM_LARGE_REQUEST_TIMEOUT_MS = 90_000;

export const CVM_REGISTRATION_CACHE_TTL_MS = 24 * 60 * 60_000;
export const CVM_YEARLY_CACHE_TTL_MS = 12 * 60 * 60_000;

export const CVM_RATE_LIMIT_MESSAGE =
  "CVM open-data request limit reached. Please retry later.";

export class CvmRateLimitError extends AdapterRateLimitError {
  constructor(message = CVM_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "CVM");
    this.name = "CvmRateLimitError";
  }
}

export class CvmApiError extends AdapterError {
  constructor(message: string) {
    super(message, "CVM");
    this.name = "CvmApiError";
  }
}

function acquireRequest(): void {
  if (!cvmRateLimiter.tryAcquire()) throw new CvmRateLimitError();
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "text/csv, application/zip, application/octet-stream, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
};

// --- CSV parsing -----------------------------------------------------------

/**
 * Parse one CVM CSV line. The feeds are semicolon-delimited and, in practice,
 * unquoted, but a defensive double-quote handler is kept so an embedded `;`
 * inside a quoted field can never shift every downstream column.
 */
export function parseCvmCsvLine(line: string): string[] {
  const fields: string[] = [];
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
    } else if (char === ";") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

export type CvmRow = Record<string, string>;

/** Parse a full CVM CSV document into header-keyed rows. */
export function parseCvmCsv(text: string): CvmRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const header = parseCvmCsvLine(lines[0] ?? "");
  const rows: CvmRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCvmCsvLine(lines[index] ?? "");
    const row: CvmRow = {};
    for (let column = 0; column < header.length; column += 1) {
      const key = header[column];
      if (key) row[key] = values[column] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Decode CVM bytes as Latin-1 (ISO-8859-1). The feeds are not UTF-8, so a naive
 * `response.text()` mangles every accented character (e.g. `SÃO PAULO`); decode
 * the raw bytes with the declared charset instead.
 */
function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

// --- Numeric / code helpers ------------------------------------------------

/** Canonicalise a CVM code by stripping leading zeros (DFP zero-pads to 6). */
export function normalizeCvmCode(value: string | undefined): string | undefined {
  const digits = (value ?? "").trim().replace(/^0+/, "");
  return /^\d+$/.test(digits) ? digits : undefined;
}

export function isCvmCode(value: string): boolean {
  return /^\d{1,6}$/.test(value.trim());
}

function parseCvmNumber(value: string | undefined): number | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  // Values are dot-decimal with no thousands separators (e.g. 476094000.0000).
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Multiply a reported value by its money scale (ESCALA_MOEDA). */
function scaleFactor(escala: string | undefined): number {
  return (escala ?? "").trim().toUpperCase() === "MIL" ? 1000 : 1;
}

function isoDate(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

// --- Dataset loading -------------------------------------------------------

const csvPromises = new Map<string, Promise<CvmRow[]>>();

/** Reset the process-local dataset memo (used by tests for isolation). */
export function resetCvmDatasetCache(): void {
  csvPromises.clear();
}

function validateRows(value: unknown): CvmRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter(
    (row): row is CvmRow =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
  return rows.length ? rows : undefined;
}

async function fetchCsvBytes(
  url: string,
  options: AdapterOptions,
  timeoutMs: number,
): Promise<Uint8Array> {
  acquireRequest();
  try {
    return await getBinary(url, BROWSER_HEADERS, timeoutMs, options.fetchFn ?? fetch);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CvmRateLimitError();
    }
    throw error;
  }
}

/**
 * Load a memoized, optionally cross-call-cached list of CSV rows. `parse` turns
 * the fetched bytes into rows; it also selects the right member of a ZIP bundle
 * and decodes Latin-1. On a fetch/parse error the memo entry is dropped so a
 * later call can retry rather than replaying a rejected promise.
 */
async function loadRows(
  cacheKey: string,
  url: string,
  parse: (bytes: Uint8Array) => CvmRow[],
  options: AdapterOptions,
  timeoutMs: number,
): Promise<CvmRow[]> {
  if (options.cache) {
    const cached = await readCachedJson(options.cache, cacheKey, validateRows);
    if (cached) return cached;
  }
  let promise = csvPromises.get(cacheKey);
  if (!promise) {
    promise = fetchCsvBytes(url, options, timeoutMs).then(parse);
    csvPromises.set(cacheKey, promise);
  }
  let rows: CvmRow[];
  try {
    rows = await promise;
  } catch (error) {
    csvPromises.delete(cacheKey);
    throw error;
  }
  if (options.cache) {
    const ttl = cacheKey.startsWith("cvm:cad")
      ? CVM_REGISTRATION_CACHE_TTL_MS
      : CVM_YEARLY_CACHE_TTL_MS;
    await writeCachedJson(options.cache, cacheKey, rows, ttl);
  }
  return rows;
}

async function loadRegistration(options: AdapterOptions): Promise<CvmRow[]> {
  return loadRows(
    "cvm:cad:v1",
    CVM_REGISTRATION_URL,
    (bytes) => parseCvmCsv(decodeLatin1(bytes)),
    options,
    CVM_REQUEST_TIMEOUT_MS,
  );
}

function ipeUrl(year: number): string {
  return `${CVM_BASE_URL}/DOC/IPE/DADOS/ipe_cia_aberta_${year}.zip`;
}

function dfpUrl(year: number): string {
  return `${CVM_BASE_URL}/DOC/DFP/DADOS/dfp_cia_aberta_${year}.zip`;
}

/** Decode the single CSV member of an IPE/DFP-style year ZIP. */
function decodeZipCsv(bytes: Uint8Array, memberSuffix: string): CvmRow[] {
  const entries = readZipEntries(bytes, {
    filter: (name) => name.toLowerCase().endsWith(memberSuffix.toLowerCase()),
  });
  const entry = entries[0];
  if (!entry) return [];
  return parseCvmCsv(decodeLatin1(entry.data));
}

async function loadIpeYear(
  year: number,
  options: AdapterOptions,
): Promise<CvmRow[]> {
  return loadRows(
    `cvm:ipe:${year}:v1`,
    ipeUrl(year),
    (bytes) => decodeZipCsv(bytes, `ipe_cia_aberta_${year}.csv`),
    options,
    CVM_REQUEST_TIMEOUT_MS,
  );
}

/**
 * Load the three headline DFP statements for a fiscal year, preferring the
 * consolidated (`con`) variant and stamping each row's basis. Only the members
 * needed for the normalized concept set are inflated from the ~130 MB bundle.
 */
async function loadDfpYear(
  year: number,
  options: AdapterOptions,
): Promise<CvmRow[]> {
  return loadRows(
    `cvm:dfp:${year}:v1`,
    dfpUrl(year),
    (bytes) => {
      const wanted = new Set(
        DFP_STATEMENTS.flatMap((statement) => [
          `dfp_cia_aberta_${statement.member}_con_${year}.csv`,
          `dfp_cia_aberta_${statement.member}_ind_${year}.csv`,
        ].map((name) => name.toLowerCase())),
      );
      const entries = readZipEntries(bytes, {
        filter: (name) => wanted.has(name.toLowerCase()),
      });
      const rows: CvmRow[] = [];
      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        const basis: FinancialBasis = lower.includes("_con_")
          ? "consolidated"
          : "separate";
        const statement = DFP_STATEMENTS.find((candidate) =>
          lower.includes(`_${candidate.member.toLowerCase()}_`),
        );
        if (!statement) continue;
        for (const row of parseCvmCsv(decodeLatin1(entry.data))) {
          row.__statement = statement.member;
          row.__basis = basis;
          rows.push(row);
        }
      }
      return rows;
    },
    options,
    CVM_LARGE_REQUEST_TIMEOUT_MS,
  );
}

// --- Resolution ------------------------------------------------------------

function registrationRowToEntity(row: CvmRow, matchReason: string): Entity | undefined {
  const legalName = (row.DENOM_SOCIAL ?? "").trim();
  const code = normalizeCvmCode(row.CD_CVM);
  if (!legalName || !code) return undefined;
  const tradeName = (row.DENOM_COMERC ?? "").trim();
  const cnpj = (row.CNPJ_CIA ?? "").trim();
  const situation = (row.SIT ?? "").trim();
  const sector = (row.SETOR_ATIV ?? "").trim();
  const category = (row.CATEG_REG ?? "").trim();
  const aliases = tradeName && tradeName !== legalName ? [tradeName] : [];
  const status = [situation, category && `Registration ${category}`, sector]
    .filter((part) => part.length > 0)
    .join(" · ");
  return {
    legalName,
    cvmCode: code,
    jurisdiction: "BR",
    source: "CVM",
    sourceIdentifiers: {
      cvmCode: code,
      jurisdiction: "BR",
      ...(cnpj ? { companyNumber: cnpj } : {}),
    },
    sourceUrl: CVM_REGISTRATION_DATASET_URL,
    ...(status ? { status } : {}),
    ...(aliases.length ? { aliases } : {}),
    matchReason,
  };
}

// The registration feed carries one row per market segment (TP_MERC: BOLSA vs
// BALCÃO ORGANIZADO), so a single company can appear two or three times with
// identical CD_CVM, name, and CNPJ. That is one legal entity, not several —
// collapse to the first row per CVM code so resolution never implies duplicates.
function dedupeByCvmCode(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  const unique: Entity[] = [];
  for (const entity of entities) {
    const key = entity.cvmCode ?? entity.legalName;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entity);
  }
  return unique;
}

export async function searchCvmCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const rows = await loadRegistration(options);

  if (isCvmCode(trimmed)) {
    const target = normalizeCvmCode(trimmed);
    const matches = rows
      .filter((row) => normalizeCvmCode(row.CD_CVM) === target)
      .map((row) => registrationRowToEntity(row, "Exact CVM-code match"))
      .filter((entity): entity is Entity => entity !== undefined);
    if (matches.length) return dedupeByCvmCode(matches);
    // Fall through to a name search when the numeric query is not a known code.
  }

  // The registration feed is the whole listed market (~2500 rows), so — as with
  // the TWSE basic feed — rankEntities tags genuine hits and stamps everything
  // else with the fallback reason at score 0. Keep only genuine hits so a query
  // with no real match honestly returns nothing rather than 25 arbitrary names.
  const fallbackReason = "CVM registration search result";
  const entities = rows
    .map((row) => registrationRowToEntity(row, fallbackReason))
    .filter((entity): entity is Entity => entity !== undefined);
  const ranked = rankEntities(trimmed, entities, { fallbackReason })
    .filter((entity) => entity.matchReason !== fallbackReason);
  return dedupeByCvmCode(ranked).slice(0, 25);
}

export async function resolveCvmCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await searchCvmCompanies(query, options))[0] ?? null;
}

async function resolveCvmEntity(
  query: string,
  options: AdapterOptions,
): Promise<Entity> {
  const entity = await resolveCvmCompany(query, options);
  if (!entity || !entity.cvmCode) {
    throw new CvmApiError(`No CVM company found for ${query}.`);
  }
  return entity;
}

// --- IPE disclosures (CompanyFilings) --------------------------------------

export interface CvmFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export const CVM_DEFAULT_FILING_LIMIT = 20;

/** Determine the calendar years an IPE search must cover for a date window. */
export function ipeYearsForWindow(
  startDate: string | undefined,
  endDate: string | undefined,
  currentYear: number,
): number[] {
  const end = isoDate(endDate) ? Number(endDate!.slice(0, 4)) : currentYear;
  const start = isoDate(startDate) ? Number(startDate!.slice(0, 4)) : end;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const years: number[] = [];
  // Cap the span so an open-ended request cannot fan out into decades of ZIPs.
  for (let year = hi; year >= lo && years.length < 3; year -= 1) {
    if (year >= 2003 && year <= currentYear) years.push(year);
  }
  return years.length ? years : [currentYear];
}

function ipeRowToFiling(row: CvmRow, code: string): Filing | undefined {
  const filedDate = isoDate(row.Data_Entrega);
  const subject = (row.Assunto ?? "").trim();
  const category = (row.Categoria ?? "").trim();
  const type = (row.Tipo ?? "").trim();
  const link = (row.Link_Download ?? "").trim();
  if (!filedDate || (!subject && !category)) return undefined;
  const species = (row.Especie ?? "").trim();
  const form = [category, type].filter((part) => part.length > 0).join(" — ") ||
    "CVM disclosure";
  return {
    filedDate,
    form,
    ...(species ? { category: species } : {}),
    description: subject || form,
    sourceUrl: link || CVM_IPE_DATASET_URL,
    source: "CVM",
    sourceIdentifiers: { cvmCode: code, jurisdiction: "BR" },
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

export async function searchCvmFilings(
  input: string | CvmFilingSearchParams,
  options: AdapterOptions = {},
  currentYear: number = new Date().getUTCFullYear(),
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveCvmEntity(params.company, options);
  const code = entity.cvmCode!;
  const years = ipeYearsForWindow(params.startDate, params.endDate, currentYear);
  const limit = Math.max(1, params.limit ?? CVM_DEFAULT_FILING_LIMIT);

  const filings: Filing[] = [];
  for (const year of years) {
    const rows = await loadIpeYear(year, options);
    for (const row of rows) {
      if (normalizeCvmCode(row.Codigo_CVM) !== code) continue;
      const filing = ipeRowToFiling(row, code);
      if (filing) filings.push(filing);
    }
  }
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .filter((filing) => {
      if (params.startDate && filing.filedDate < params.startDate) return false;
      if (params.endDate && filing.filedDate > params.endDate) return false;
      return true;
    })
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

// --- DFP financials (CompanyFinancials) ------------------------------------

interface DfpStatement {
  /** DFP member code, e.g. BPA (assets), BPP (liabilities+equity), DRE (P&L). */
  member: string;
}

const DFP_STATEMENTS: readonly DfpStatement[] = [
  { member: "BPA" },
  { member: "BPP" },
  { member: "DRE" },
];

interface ConceptSpec {
  concept: string;
  label: string;
  statement: string;
  /** Standardized CVM account code (CD_CONTA) for this line. */
  account: string;
}

/**
 * Map the standardized CVM account codes to the shared canonical concepts. The
 * CVM DFP taxonomy assigns the same top-level `CD_CONTA` across sectors (banks
 * included), so codes are a stabler key than the Portuguese descriptions; the
 * human label carried on each fact is still the row's own `DS_CONTA`, so the
 * surfaced text always matches exactly what the company reported.
 */
export const CVM_ACCOUNT_CONCEPTS: readonly ConceptSpec[] = [
  { concept: "total_assets", label: "Total assets", statement: "BPA", account: "1" },
  { concept: "stockholders_equity", label: "Total equity", statement: "BPP", account: "2.03" },
  { concept: "revenue", label: "Revenue", statement: "DRE", account: "3.01" },
  { concept: "operating_income", label: "Operating income", statement: "DRE", account: "3.05" },
  { concept: "net_income", label: "Net income", statement: "DRE", account: "3.11" },
];

export const CVM_FINANCIAL_CONCEPT_NAMES = CVM_ACCOUNT_CONCEPTS.map(
  (spec) => spec.concept,
);

export const CVM_DEFAULT_PERIOD_COUNT = 2;
export const CVM_MAX_PERIOD_COUNT = 5;

export interface CvmFinancialsParams {
  company: string;
  concepts?: readonly string[];
  periods?: number;
}

/** Recent fiscal years to try, newest first. DFP for FY Y ships in year Y+1. */
export function dfpYearsToScan(currentYear: number, count: number): number[] {
  const years: number[] = [];
  // The latest complete fiscal year's bundle is the prior calendar year's file.
  for (let year = currentYear - 1; year >= 2010 && years.length < count; year -= 1) {
    years.push(year);
  }
  return years;
}

function dfpRowToFact(
  row: CvmRow,
  spec: ConceptSpec,
  year: number,
): FinancialFact | undefined {
  const value = parseCvmNumber(row.VL_CONTA);
  if (value === undefined) return undefined;
  const periodEnd = isoDate(row.DT_FIM_EXERC) ?? isoDate(row.DT_REFER);
  if (!periodEnd) return undefined;
  const label = (row.DS_CONTA ?? "").trim() || spec.label;
  const basis = row.__basis === "consolidated" || row.__basis === "separate"
    ? (row.__basis as FinancialBasis)
    : undefined;
  const cvmCode = normalizeCvmCode(row.CD_CVM);
  return {
    concept: spec.concept,
    label,
    periodEnd,
    value: value * scaleFactor(row.ESCALA_MOEDA),
    unit: "BRL",
    filedDate: isoDate(row.DT_REFER) ?? periodEnd,
    form: "DFP (Demonstrações Financeiras Padronizadas)",
    ...(basis ? { basis } : {}),
    sourceUrl: dfpUrl(year),
    source: "CVM",
    sourceIdentifiers: {
      ...(cvmCode ? { cvmCode } : {}),
      jurisdiction: "BR",
    },
  };
}

export async function getCvmFinancials(
  input: string | CvmFinancialsParams,
  options: AdapterOptions = {},
  currentYear: number = new Date().getUTCFullYear(),
): Promise<FinancialFact[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveCvmEntity(params.company, options);
  const code = entity.cvmCode!;
  const wanted = new Set(
    (params.concepts && params.concepts.length
      ? params.concepts
      : CVM_FINANCIAL_CONCEPT_NAMES),
  );
  const specs = CVM_ACCOUNT_CONCEPTS.filter((spec) => wanted.has(spec.concept));
  const periods = Math.min(
    CVM_MAX_PERIOD_COUNT,
    Math.max(1, params.periods ?? CVM_DEFAULT_PERIOD_COUNT),
  );
  const years = dfpYearsToScan(currentYear, periods);

  const facts: FinancialFact[] = [];
  for (const year of years) {
    const rows = (await loadDfpYear(year, options)).filter(
      (row) =>
        normalizeCvmCode(row.CD_CVM) === code &&
        (row.ORDEM_EXERC ?? "").trim().toUpperCase() === "ÚLTIMO",
    );
    if (!rows.length) continue;
    // Prefer consolidated statements; fall back to individual only when the
    // company filed no consolidated bundle for the year.
    const hasConsolidated = rows.some((row) => row.__basis === "consolidated");
    for (const spec of specs) {
      const match = rows.find(
        (row) =>
          row.__statement === spec.statement &&
          (row.CD_CONTA ?? "").trim() === spec.account &&
          (hasConsolidated
            ? row.__basis === "consolidated"
            : row.__basis === "separate"),
      );
      if (!match) continue;
      const fact = dfpRowToFact(match, spec, year);
      if (fact) facts.push(fact);
    }
  }
  // Newest period first, then by the adapter's canonical concept order.
  const order = new Map(CVM_ACCOUNT_CONCEPTS.map((spec, index) => [spec.concept, index]));
  return facts.sort((left, right) => {
    if (left.periodEnd !== right.periodEnd) {
      return right.periodEnd.localeCompare(left.periodEnd);
    }
    return (order.get(left.concept) ?? 0) - (order.get(right.concept) ?? 0);
  });
}

// --- Adapter factory -------------------------------------------------------

export function createCvmAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveCvmCompany(query, options),
    searchEntities: (query: string) => searchCvmCompanies(query, options),
    searchFilings: (input: string | CvmFilingSearchParams) =>
      searchCvmFilings(input, options),
    getFinancials: (input: string | CvmFinancialsParams) =>
      getCvmFinancials(input, options),
  };
}
