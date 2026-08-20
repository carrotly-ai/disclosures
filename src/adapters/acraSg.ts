import { rankEntities } from "../core/entityMatching.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { acraRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity } from "../core/types.js";

// Singapore's Accounting and Corporate Regulatory Authority (ACRA) publishes
// "ACRA Information on Corporate Entities" on data.gov.sg — a keyless,
// full-text-searchable registry over the legacy CKAN `datastore_search` API,
// under the Singapore Open Data Licence v1.0 (cleanly redistributable). This is
// the SG analogue of the GB Companies House resolver, including previous-name
// history. It is a registry snapshot only: no officer names (a count only), no
// shareholders, no financials, no charges — so it underwrites CompanyResolve and
// nothing else (SGX/SGXNet is Akamai + auth walled; BizFile extracts are paid).
export const ACRA_DATASTORE_URL =
  "https://data.gov.sg/api/action/datastore_search";
export const ACRA_REQUEST_TIMEOUT_MS = 20_000;
export const ACRA_DEFAULT_LIMIT = 10;
export const ACRA_FETCH_LIMIT = 100;

// The alphabet-split datasets (26 letters + "Others"), keyed by the first letter
// of the entity name, carry the rich field set (former names, auditors, SSIC).
// Enumerated live from the data.gov.sg collection "ACRA Information on Corporate
// Entities" (collection 2) on 2026-08-21.
export const ACRA_LETTER_RESOURCES: Record<string, string> = {
  A: "d_8575e84912df3c28995b8e6e0e05205a",
  B: "d_3a3807c023c61ddfba947dc069eb53f2",
  C: "d_c0650f23e94c42e7a20921f4c5b75c24",
  D: "d_acbc938ec77af18f94cecc4a7c9ec720",
  E: "d_124a9bd407c7a25f8335b93b86e50fdd",
  F: "d_4526d47d6714d3b052eed4a30b8b1ed6",
  G: "d_b58303c68e9cf0d2ae93b73ffdbfbfa1",
  H: "d_fa2ed456cf2b8597bb7e064b08fc3c7c",
  I: "d_85518d970b8178975850457f60f1e738",
  J: "d_478f45a9c541cbe679ca55d1cd2b970b",
  K: "d_5573b0db0575db32190a2ad27919a7aa",
  L: "d_a2141adf93ec2a3c2ec2837b78d6d46e",
  M: "d_9af9317c646a1c881bb5591c91817cc6",
  N: "d_67e99e6eabc4aad9b5d48663b579746a",
  O: "d_5c4ef48b025fdfbc80056401f06e3df9",
  P: "d_181005ca270b45408b4cdfc954980ca2",
  Q: "d_4130f1d9d365d9f1633536e959f62bb7",
  R: "d_2b8c54b2a490d2fa36b925289e5d9572",
  S: "d_df7d2d661c0c11a7c367c9ee4bf896c1",
  T: "d_72f37e5c5d192951ddc5513c2b134482",
  U: "d_0cc5f52a1f298b916f317800251057f3",
  V: "d_e97e8e7fc55b85a38babf66b0fa46b73",
  W: "d_af2042c77ffaf0db5d75561ce9ef5688",
  X: "d_1cd970d8351b42be4a308d628a6dd9d3",
  Y: "d_31af23fdb79119ed185c256f03cb5773",
  Z: "d_4e3db8955fdcda6f9944097bef3d2724",
};

// Entities whose name starts with a non-letter live in the "Others" split.
export const ACRA_OTHERS_RESOURCE = "d_300ddc8da4e8f7bdc1bfc62d0d99e2e7";

// The consolidated dataset (thinner: uen, name, status, type, issue date, street,
// postal) spans every letter, so it routes a UEN-only lookup (which carries no
// name letter) to the right split before the rich record is fetched.
export const ACRA_CONSOLIDATED_RESOURCE = "d_3f960c10fed6145404ca7b821f263b87";

export const ACRA_DATASET_PAGE = "https://data.gov.sg/datasets";

export const ACRA_CAVEAT =
  "ACRA on data.gov.sg is a registry snapshot under the Singapore Open Data " +
  "Licence, not a filing/disclosure feed. It exposes no officer names (only a " +
  "count), no shareholders, no financial figures, and no charges — those live in " +
  "ACRA BizFile paid extracts. SGX/SGXNet listed filings, insider dealings and " +
  "financials are separately Akamai + auth walled to datacenter IPs, so SG " +
  "supports CompanyResolve only.";

export const ACRA_RATE_LIMIT_MESSAGE =
  "ACRA (data.gov.sg) request limit reached. Please retry later.";

export class AcraRateLimitError extends AdapterRateLimitError {
  constructor(message = ACRA_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "ACRA");
    this.name = "AcraRateLimitError";
  }
}

export class AcraApiError extends AdapterError {
  constructor(message: string) {
    super(message, "ACRA");
    this.name = "AcraApiError";
  }
}

function acquireRequest(): void {
  if (!acraRateLimiter.tryAcquire()) throw new AcraRateLimitError();
}

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
};

/**
 * Singapore UEN formats accepted for an exact-identifier lookup:
 *  - Businesses (ROB): 8 digits + 1 letter, e.g. 53312345A
 *  - Local companies (ROC): 4-digit year + 5 digits + 1 letter, e.g. 197200078R
 *  - New UEN (others): [TSR] + 2-digit year + 2 letters + 4 digits + 1 letter
 */
export function isSingaporeUen(value: string): boolean {
  const v = value.trim().toUpperCase();
  return (
    /^\d{8,9}[A-Z]$/.test(v) ||
    /^[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]$/.test(v)
  );
}

/** Route a name to its alphabet-split resource by its first letter. */
export function resourceForName(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return ACRA_LETTER_RESOURCES[first] ?? ACRA_OTHERS_RESOURCE;
}

async function datastoreSearch(
  resourceId: string,
  query: string,
  limit: number,
  options: AdapterOptions,
): Promise<Record<string, unknown>[]> {
  const url = new URL(ACRA_DATASTORE_URL);
  url.searchParams.set("resource_id", resourceId);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      url.toString(),
      HEADERS,
      ACRA_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new AcraRateLimitError();
    }
    throw error;
  }
  const record = asRecord(payload);
  if (record?.success === false) {
    throw new AcraApiError("ACRA datastore_search reported failure.");
  }
  const result = asRecord(record?.result);
  return asArray(result?.records).flatMap((item) => {
    const row = asRecord(item);
    return row ? [row] : [];
  });
}

export interface AcraEntity extends Entity {
  uen: string;
  formerNames: string[];
  incorporationDate?: string;
  entityType?: string;
  companyType?: string;
  ssicCode?: string;
  ssicDescription?: string;
  auditFirms: string[];
  officerCount?: string;
}

function collectIndexed(row: Record<string, unknown>, prefix: string): string[] {
  const values: string[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const value = asString(row[`${prefix}${index}`]);
    // "na"/"NA" placeholders and blanks are dropped.
    if (value && value.toLowerCase() !== "na") values.push(value);
  }
  return values;
}

function rowToEntity(
  row: Record<string, unknown>,
  matchReason: string,
): AcraEntity | undefined {
  const uen = asString(row.uen);
  const legalName = asString(row.entity_name);
  if (!uen || !legalName) return undefined;
  const formerNames = collectIndexed(row, "former_entity_name");
  const auditFirms = collectIndexed(row, "name_of_audit_firm");
  const status = asString(row.entity_status_description) ??
    asString(row.uen_status_desc);
  const incorporationDate = asString(row.registration_incorporation_date);
  const entityType = asString(row.entity_type_description) ??
    asString(row.entity_type_desc);
  const companyType = asString(row.company_type_description);
  const ssicCode = asString(row.primary_ssic_code);
  const ssicDescription = asString(row.primary_ssic_description);
  const officerCount = asString(row.no_of_officers);
  return {
    legalName,
    uen,
    jurisdiction: "SG",
    source: "ACRA",
    sourceIdentifiers: { uen, jurisdiction: "SG" },
    sourceUrl: `${ACRA_DATASET_PAGE}/${resourceForName(legalName)}/view`,
    formerNames,
    auditFirms,
    // Former names surface as aliases so a search by a previous name still ranks.
    ...(formerNames.length ? { aliases: formerNames } : {}),
    ...(status ? { status } : {}),
    ...(incorporationDate ? { incorporationDate } : {}),
    ...(entityType ? { entityType } : {}),
    ...(companyType ? { companyType } : {}),
    ...(ssicCode ? { ssicCode } : {}),
    ...(ssicDescription ? { ssicDescription } : {}),
    ...(officerCount ? { officerCount } : {}),
    matchReason,
  };
}

async function resolveByUen(
  uen: string,
  options: AdapterOptions,
): Promise<AcraEntity[]> {
  const wanted = uen.trim().toUpperCase();
  // The consolidated dataset spans every letter, so it locates the name first.
  const consolidated = await datastoreSearch(
    ACRA_CONSOLIDATED_RESOURCE,
    wanted,
    ACRA_DEFAULT_LIMIT,
    options,
  );
  const match = consolidated.find(
    (row) => asString(row.uen)?.toUpperCase() === wanted,
  );
  if (!match) return [];
  const name = asString(match.entity_name);
  if (!name) {
    const basic = rowToEntity(match, "Exact UEN match");
    return basic ? [basic] : [];
  }
  // Re-query the letter-split dataset for the rich record (former names, etc.).
  const rich = await datastoreSearch(
    resourceForName(name),
    wanted,
    ACRA_DEFAULT_LIMIT,
    options,
  );
  const richMatch = rich.find(
    (row) => asString(row.uen)?.toUpperCase() === wanted,
  );
  const entity = richMatch
    ? rowToEntity(richMatch, "Exact UEN match")
    : rowToEntity(match, "Exact UEN match");
  return entity ? [entity] : [];
}

async function resolveByName(
  query: string,
  options: AdapterOptions,
): Promise<AcraEntity[]> {
  const rows = await datastoreSearch(
    resourceForName(query),
    query,
    ACRA_FETCH_LIMIT,
    options,
  );
  const entities = rows.flatMap((row) => {
    const entity = rowToEntity(row, "ACRA name search result");
    return entity ? [entity] : [];
  });
  return rankEntities(query, entities, {
    fallbackReason: "ACRA name search result",
  }) as AcraEntity[];
}

export async function searchAcraCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<AcraEntity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (isSingaporeUen(trimmed)) return resolveByUen(trimmed, options);
  return resolveByName(trimmed, options);
}

export async function resolveAcraCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<AcraEntity | null> {
  return (await searchAcraCompanies(query, options))[0] ?? null;
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveAcraCompany;
export const searchCompanies = searchAcraCompanies;

export function createAcraSgAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveAcraCompany(query, options),
    searchEntities: (query: string) => searchAcraCompanies(query, options),
  };
}
