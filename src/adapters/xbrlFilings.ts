// filings.xbrl.org (EU/UK ESEF) adapter for normalized annual financials.
//
// filings.xbrl.org is the public XBRL International index of ESEF (EU),
// UKSEF (UK), and Ukraine FRS annual financial reports, FY2020+. Its JSON:API
// (`/api/filings`) is free, keyless, and LEI-indexed; each filing links a
// machine-readable xBRL-JSON report (OIM format) we parse into FinancialFact
// rows. Coverage is not comprehensive — some OAMs hamper collection, and
// alternative-market issuers (e.g. First North) are exempt from ESEF and absent
// here — so a miss never proves a company did not report.
import { rankEntities } from "../core/entityMatching.js";
import { AdapterRateLimitError } from "../core/errors.js";
import { getJson } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { xbrlFilingsRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity, FetchFn, FinancialFact } from "../core/types.js";
import { isLei, resolveGleifEntity } from "./gleif.js";

export const XBRL_FILINGS_BASE_URL = "https://filings.xbrl.org";

export const XBRL_FILINGS_RATE_LIMIT_MESSAGE =
  "filings.xbrl.org rate limit exceeded. Please wait before retrying.";

export class XbrlFilingsRateLimitError extends AdapterRateLimitError {
  constructor(message = XBRL_FILINGS_RATE_LIMIT_MESSAGE) {
    super(message, 120, 60_000, "filings.xbrl.org");
  }
}

/**
 * Normalized concept names shared with the SEC adapter, mapped to their IFRS
 * (ESEF/UKSEF) taxonomy element local names. The report's concept QNames are
 * `ifrs-full:<local name>`; tags are listed most-authoritative first so a
 * consolidated total is preferred over an attributable-to-owners breakdown.
 */
export const ESEF_FINANCIAL_CONCEPTS: Record<
  string,
  { label: string; tags: readonly string[] }
> = {
  revenue: { label: "Revenue", tags: ["Revenue", "RevenueFromContractsWithCustomers"] },
  net_income: {
    label: "Net income",
    tags: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"],
  },
  gross_profit: { label: "Gross profit", tags: ["GrossProfit"] },
  operating_income: {
    label: "Operating income",
    tags: ["ProfitLossFromOperatingActivities"],
  },
  total_assets: { label: "Total assets", tags: ["Assets"] },
  total_liabilities: { label: "Total liabilities", tags: ["Liabilities"] },
  stockholders_equity: {
    label: "Equity",
    tags: ["Equity", "EquityAttributableToOwnersOfParent"],
  },
  cash: { label: "Cash & equivalents", tags: ["CashAndCashEquivalents"] },
  eps_basic: { label: "EPS (basic)", tags: ["BasicEarningsLossPerShare"] },
  eps_diluted: { label: "EPS (diluted)", tags: ["DilutedEarningsLossPerShare"] },
  operating_cash_flow: {
    label: "Operating cash flow",
    tags: ["CashFlowsFromUsedInOperatingActivities"],
  },
  rnd_expense: {
    label: "R&D expense",
    tags: ["ResearchAndDevelopmentExpense"],
  },
};

export const ESEF_FINANCIAL_CONCEPT_NAMES = Object.keys(ESEF_FINANCIAL_CONCEPTS);

export interface EsefFiling {
  fxoId: string;
  lei: string;
  entityName?: string;
  country: string;
  periodEnd: string;
  jsonUrl?: string;
  viewerUrl?: string;
  packageUrl?: string;
  reportUrl?: string;
  dateAdded?: string;
}

export interface EsefIssuer {
  lei: string;
  name?: string;
}

// The OIM "core" dimensions. A fact carrying any other dimension is a
// dimensional breakdown (segment, product, geography, ...) rather than the
// reported total, so we skip it and keep only the undimensioned figure.
const CORE_DIMENSIONS = new Set(["concept", "entity", "period", "unit", "language"]);

// Annual reporting periods only: an income/cash-flow duration must span roughly
// a full year (52/53-week retailers reach ~371 days) to exclude interim figures.
const MIN_ANNUAL_DURATION_DAYS = 300;
const MAX_ANNUAL_DURATION_DAYS = 400;
const MS_PER_DAY = 24 * 60 * 60_000;

// One xBRL-JSON report carries the current year plus a comparative, so a handful
// of the newest reports covers many distinct period-ends. Cap fetches so one
// lookup never pulls an unbounded pile of multi-megabyte reports.
const MAX_REPORT_FETCHES = 6;

function fetchFor(options: AdapterOptions): FetchFn {
  return options.fetchFn ?? fetch;
}

function absoluteUrl(path: string): string {
  return new URL(path, XBRL_FILINGS_BASE_URL).toString();
}

async function requestJson(url: string, options: AdapterOptions): Promise<unknown> {
  if (!xbrlFilingsRateLimiter.tryAcquire()) {
    throw new XbrlFilingsRateLimitError();
  }
  return getJson(url, { Accept: "application/vnd.api+json" }, 20_000, fetchFor(options));
}

async function requestReport(url: string, options: AdapterOptions): Promise<unknown> {
  if (!xbrlFilingsRateLimiter.tryAcquire()) {
    throw new XbrlFilingsRateLimitError();
  }
  return getJson(url, { Accept: "application/json" }, 30_000, fetchFor(options));
}

function filingsUrl(lei: string): string {
  const url = new URL(`${XBRL_FILINGS_BASE_URL}/api/filings`);
  url.searchParams.set("filter[entity.identifier]", lei);
  url.searchParams.set("include", "entity");
  url.searchParams.set("page[size]", "100");
  return url.toString();
}

/** Resolve an issuer to its LEI: a bare LEI directly, else a GLEIF name lookup. */
export async function resolveEsefIssuer(
  company: string,
  options: AdapterOptions = {},
): Promise<EsefIssuer | null> {
  const trimmed = company.trim();
  if (!trimmed) return null;
  if (isLei(trimmed)) return { lei: trimmed.toUpperCase() };
  const entity = await resolveGleifEntity(trimmed, options);
  if (!entity?.lei) return null;
  return { lei: entity.lei, ...(entity.legalName ? { name: entity.legalName } : {}) };
}

// --- Entity resolution against the filings.xbrl.org register -----------------
//
// The `/api/entities` JSON:API indexes only issuers that have actually filed an
// ESEF/UKSEF/FRS report here, so a hit is a self-verifying "this is a real
// filer" signal — unlike a GLEIF name lookup, which resolves any legal entity
// whether or not it ever filed. `identifier` carries the LEI for ESEF filers.
// The endpoint speaks the flask-combo-jsonapi filter dialect, so a legal name is
// matched case-insensitively with the `ilike` operator; a bare LEI is matched
// exactly on `identifier`.

/** Build the `/api/entities` query for a legal-name (ilike) or LEI (exact) lookup. */
function entitiesUrl(query: string, byLei: boolean): string {
  const url = new URL(`${XBRL_FILINGS_BASE_URL}/api/entities`);
  if (byLei) {
    url.searchParams.set("filter[identifier]", query);
  } else {
    url.searchParams.set(
      "filter",
      JSON.stringify([{ name: "name", op: "ilike", val: `%${query}%` }]),
    );
  }
  url.searchParams.set("page[size]", "50");
  return url.toString();
}

function entityFromResource(item: unknown): Entity | undefined {
  const record = asRecord(item);
  if (!record || record.type !== "entity") return undefined;
  const attrs = asRecord(record.attributes);
  const lei = asString(attrs?.identifier);
  if (!lei) return undefined;
  const name = asString(attrs?.name);
  return {
    legalName: name ?? lei,
    lei,
    source: "filings.xbrl.org",
    sourceUrl: absoluteUrl(`/api/entities/${encodeURIComponent(lei)}`),
    jurisdiction: "EU",
  };
}

function parseEntities(payload: unknown): Entity[] {
  const out: Entity[] = [];
  for (const item of asArray(asRecord(payload)?.data)) {
    const entity = entityFromResource(item);
    if (entity) out.push(entity);
  }
  return out;
}

/**
 * Search the filings.xbrl.org register for issuers matching a legal name or LEI,
 * best match first. A legal name is ranked by normalized similarity; a bare LEI
 * resolves to at most the one exactly-matching filer. Every result is a
 * confirmed ESEF/UKSEF filer, so an empty list means "not an indexed filer here"
 * rather than "no such company anywhere".
 */
export async function searchEsefEntities(
  company: string,
  options: AdapterOptions = {},
  limit = 10,
): Promise<Entity[]> {
  const trimmed = company.trim();
  if (!trimmed) return [];
  const byLei = isLei(trimmed);
  const query = byLei ? trimmed.toUpperCase() : trimmed;
  const entities = parseEntities(await requestJson(entitiesUrl(query, byLei), options));
  if (byLei) {
    return entities
      .slice(0, limit)
      .map((entity) => ({ ...entity, matchReason: "Exact LEI match" }));
  }
  return rankEntities(trimmed, entities, {
    fallbackReason: "filings.xbrl.org register name match",
  }).slice(0, limit);
}

/** Resolve a company to a single best ESEF filer LEI, or null if none is indexed. */
export async function resolveEsefEntity(
  company: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  const trimmed = company.trim();
  if (!trimmed) return null;
  if (isLei(trimmed)) {
    const lei = trimmed.toUpperCase();
    return {
      legalName: lei,
      lei,
      source: "filings.xbrl.org",
      sourceUrl: absoluteUrl(`/api/entities/${encodeURIComponent(lei)}`),
      jurisdiction: "EU",
      matchReason: "Exact LEI match",
    };
  }
  return (await searchEsefEntities(trimmed, options, 1))[0] ?? null;
}

function parseFilings(payload: unknown): EsefFiling[] {
  const root = asRecord(payload);
  if (!root) return [];

  const entityNames = new Map<string, string>();
  for (const item of asArray(root.included)) {
    const record = asRecord(item);
    if (!record || record.type !== "entity") continue;
    const id = asString(record.id);
    const name = asString(asRecord(record.attributes)?.name);
    if (id && name) entityNames.set(id, name);
  }

  const filings: EsefFiling[] = [];
  for (const item of asArray(root.data)) {
    const record = asRecord(item);
    if (!record || record.type !== "filing") continue;
    const attrs = asRecord(record.attributes);
    if (!attrs) continue;

    const fxoId = asString(attrs.fxo_id) ?? asString(record.id) ?? "";
    const periodEnd = asString(attrs.period_end);
    if (!periodEnd) continue;

    // The LEI prefixes fxo_id (LEI-YYYY-MM-DD-...); prefer the included entity's
    // identifier when present, else recover it from that prefix.
    const entityId = asString(
      asRecord(asRecord(asRecord(record.relationships)?.entity)?.data)?.id,
    );
    const lei = (entityId && leiFromEntityId(root, entityId)) ?? fxoId.slice(0, 20);
    const entityName = entityId ? entityNames.get(entityId) : undefined;

    const country = asString(attrs.country) ?? "";
    filings.push({
      fxoId,
      lei,
      country,
      periodEnd,
      ...(entityName ? { entityName } : {}),
      ...pathAttr(attrs.json_url, "jsonUrl"),
      ...pathAttr(attrs.viewer_url, "viewerUrl"),
      ...pathAttr(attrs.package_url, "packageUrl"),
      ...pathAttr(attrs.report_url, "reportUrl"),
      ...(asString(attrs.date_added) ? { dateAdded: dateOnly(asString(attrs.date_added)) } : {}),
    });
  }
  return filings.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

function leiFromEntityId(root: Record<string, unknown>, entityId: string): string | undefined {
  for (const item of asArray(root.included)) {
    const record = asRecord(item);
    if (record?.type === "entity" && asString(record.id) === entityId) {
      return asString(asRecord(record.attributes)?.identifier);
    }
  }
  return undefined;
}

function pathAttr(value: unknown, key: string): Record<string, string> {
  const path = asString(value);
  return path ? { [key]: absoluteUrl(path) } : {};
}

function dateOnly(value: string | undefined): string {
  return (value ?? "").slice(0, 10);
}

/** List an issuer's ESEF/UKSEF filings, newest reporting period first. */
export async function getEsefFilings(
  lei: string,
  options: AdapterOptions = {},
): Promise<EsefFiling[]> {
  const trimmed = lei.trim().toUpperCase();
  if (!isLei(trimmed)) return [];
  const payload = await requestJson(filingsUrl(trimmed), options);
  return parseFilings(payload);
}

interface Candidate {
  concept: string;
  label: string;
  priority: number;
  periodEnd: string;
  value: number;
  unit: string;
}

// OIM canonicalizes a date-based period end as the *following* day at midnight:
// "as at 31 March 2025" and "year ended 31 March 2025" are both encoded as the
// instant 2025-04-01T00:00:00. Roll a midnight end instant back one day so the
// reported figure carries the human-meaningful date the filing metadata uses
// (2025-03-31), not the exclusive boundary. A non-midnight or date-only value is
// already the inclusive end and is kept as-is.
const MIDNIGHT = /^00:00(:00)?(\.0+)?(Z|[+-]00:?00)?$/;

function inclusivePeriodEnd(end: string): string {
  const tIndex = end.indexOf("T");
  const datePart = end.slice(0, 10);
  if (tIndex === -1 || !MIDNIGHT.test(end.slice(tIndex + 1))) return datePart;
  const rolled = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(rolled.getTime())) return datePart;
  rolled.setUTCDate(rolled.getUTCDate() - 1);
  return rolled.toISOString().slice(0, 10);
}

function annualPeriodEnd(period: string | undefined): string | undefined {
  if (!period) return undefined;
  const slash = period.indexOf("/");
  if (slash === -1) return inclusivePeriodEnd(period); // instant (balance-sheet date)
  const start = period.slice(0, slash);
  const end = period.slice(slash + 1);
  const days = (new Date(end).getTime() - new Date(start).getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days) || days < MIN_ANNUAL_DURATION_DAYS || days > MAX_ANNUAL_DURATION_DAYS) {
    return undefined; // interim duration (quarter/half-year) — skip
  }
  return inclusivePeriodEnd(end);
}

function unitCode(unit: string | undefined): string {
  if (!unit) return "";
  const colon = unit.indexOf(":");
  const code = colon === -1 ? unit : unit.slice(colon + 1);
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

function extractCandidates(
  report: unknown,
  tagIndex: Map<string, { concept: string; label: string; priority: number }>,
): Candidate[] {
  const facts = asRecord(asRecord(report)?.facts);
  if (!facts) return [];
  const out: Candidate[] = [];
  for (const raw of Object.values(facts)) {
    const fact = asRecord(raw);
    const dims = asRecord(fact?.dimensions);
    if (!fact || !dims) continue;
    if (Object.keys(dims).some((key) => !CORE_DIMENSIONS.has(key))) continue;

    const localName = asString(dims.concept)?.split(":").pop();
    const spec = localName ? tagIndex.get(localName) : undefined;
    if (!spec) continue;

    const periodEnd = annualPeriodEnd(asString(dims.period));
    if (!periodEnd) continue;

    const value = Number(fact.value);
    if (!Number.isFinite(value)) continue;

    out.push({
      concept: spec.concept,
      label: spec.label,
      priority: spec.priority,
      periodEnd,
      value,
      unit: unitCode(asString(dims.unit)),
    });
  }
  return out;
}

/**
 * Annual normalized financial facts for an issuer from its ESEF/UKSEF reports.
 * Resolves the issuer to an LEI, fetches its newest reports, and extracts the
 * requested concepts. Deduplicates by (concept, period end) keeping the value
 * from the newest report, so a later restatement supersedes an earlier figure.
 */
export async function getEsefFinancials(
  company: string,
  concepts: readonly string[] = ESEF_FINANCIAL_CONCEPT_NAMES,
  options: AdapterOptions = {},
  periods = 5,
): Promise<FinancialFact[]> {
  const requested = concepts.filter((concept) => ESEF_FINANCIAL_CONCEPTS[concept]);
  if (!requested.length) return [];

  const issuer = await resolveEsefIssuer(company, options);
  if (!issuer) return [];

  const filings = await getEsefFilings(issuer.lei, options);
  if (!filings.length) return [];

  const tagIndex = new Map<string, { concept: string; label: string; priority: number }>();
  for (const concept of requested) {
    const spec = ESEF_FINANCIAL_CONCEPTS[concept];
    if (!spec) continue;
    spec.tags.forEach((tag, priority) => {
      if (!tagIndex.has(tag)) tagIndex.set(tag, { concept, label: spec.label, priority });
    });
  }

  // Each report covers ~2 years; fetch enough newest reports to cover `periods`.
  const reportBudget = Math.max(
    1,
    Math.min(filings.length, Math.ceil(periods / 2) + 1, MAX_REPORT_FETCHES),
  );

  const chosen = new Map<string, { fact: FinancialFact; priority: number }>();
  for (const filing of filings.slice(0, reportBudget)) {
    if (!filing.jsonUrl) continue;
    let report: unknown;
    try {
      report = await requestReport(filing.jsonUrl, options);
    } catch (error) {
      if (error instanceof XbrlFilingsRateLimitError) throw error;
      continue; // a single unreadable report must not sink the whole lookup
    }
    // Resolve within-report ties first (prefer the higher-priority tag), then
    // merge, letting the already-seen (newer) report win on conflict.
    const local = new Map<string, Candidate>();
    for (const candidate of extractCandidates(report, tagIndex)) {
      const key = `${candidate.concept} ${candidate.periodEnd}`;
      const existing = local.get(key);
      if (!existing || candidate.priority < existing.priority) local.set(key, candidate);
    }
    for (const [key, candidate] of local) {
      if (chosen.has(key)) continue;
      chosen.set(key, {
        priority: candidate.priority,
        fact: {
          source: "filings.xbrl.org",
          concept: candidate.concept,
          label: candidate.label,
          periodEnd: candidate.periodEnd,
          value: candidate.value,
          unit: candidate.unit,
          filedDate: filing.dateAdded ?? "",
          form: filing.country ? `ESEF (${filing.country})` : "ESEF",
          ...(filing.viewerUrl ? { sourceUrl: filing.viewerUrl } : {}),
        },
      });
    }
  }

  const order = new Map(requested.map((concept, index) => [concept, index]));
  return [...chosen.values()]
    .map((entry) => entry.fact)
    .sort((a, b) => {
      const byConcept = (order.get(a.concept) ?? 0) - (order.get(b.concept) ?? 0);
      return byConcept !== 0 ? byConcept : b.periodEnd.localeCompare(a.periodEnd);
    });
}
