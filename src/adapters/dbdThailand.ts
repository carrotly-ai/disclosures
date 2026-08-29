import { rankEntities } from "../core/entityMatching.js";
import {
  AdapterConfigurationError,
  AdapterError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { dbdRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity } from "../core/types.js";

// Thailand's Department of Business Development (DBD) publishes the national
// juristic-person register at openapi.dbd.go.th. The `/api/v1/juristic_person/
// {13-digit id}` lookup answers keyless, structured JSON for BOTH listed and
// private companies — TH/EN legal name, juristic type, register date, status,
// registered/paid-up capital, TSIC objective code, and head-office address.
// That makes it the TH analogue of SG ACRA and GB Companies House, and richer
// than either (it carries capital).
//
// It is a REGISTER, not a disclosure feed: no filings, no officers, no
// shareholders, no financial statements. Those live behind walls this package
// cannot cross keyless — SET (www.set.or.th) is Incapsula-walled, and the SEC
// `market.sec.or.th/public/idisc` filings Web API is reachable keyless but
// brittle (its methods throw NullReferenceException on every parameter shape
// probed). So TH supports CompanyResolve and nothing else.
export const DBD_OPENAPI_BASE_URL =
  "https://openapi.dbd.go.th/api/v1/juristic_person";
export const DBD_REQUEST_TIMEOUT_MS = 20_000;

// The keyless by-id endpoint takes an exact 13-digit registration number and
// has NO name-search sibling: every name-search path shape probed on
// openapi.dbd.go.th returns 404 or the Incapsula shell. Name search is served
// only by the DGA Government Data Exchange (GDX) gateway, which requires a
// free registration key sent as `Consumer-Key`. Without a key it answers
// `403 ForbiddenException: consumer not found`; with a bad one,
// `401 UnauthorizedException: token not found`.
export const DBD_GDX_NAME_SEARCH_URL =
  "https://api.egov.go.th/ws/dbd/juristic/v4/profile/infobyname";

/** Public documentation page for the DBD juristic-person open API. */
export const DBD_DATASET_PAGE =
  "https://opendata.dbd.go.th/dataset/dataset_11_03";

export const DBD_CAVEAT =
  "DBD is Thailand's national juristic-person register (listed and private " +
  "companies) — legal name in Thai and English, juristic type, status, " +
  "registered/paid-up capital, TSIC objective code, register date and head " +
  "office. It is a register snapshot, not a disclosure feed: no filings, " +
  "officers, shareholders or financial statements. The keyless endpoint is " +
  "keyed by exact 13-digit juristic number; company-name search needs a free " +
  "DBD_API_KEY (DGA GDX). SET is Incapsula-walled and the SEC idisc filings " +
  "API is brittle, so TH supports CompanyResolve only.";

export const DBD_MISSING_API_KEY_MESSAGE =
  "DBD name search requires a free DGA Government Data Exchange (GDX) key. " +
  "Set DBD_API_KEY, or pass an exact 13-digit juristic-person registration " +
  "number (e.g. 0107544000108), which resolves keyless.";

export const DBD_RATE_LIMIT_MESSAGE =
  "DBD (openapi.dbd.go.th) request limit reached. Please retry later.";

export class DbdConfigurationError extends AdapterConfigurationError {
  constructor(message = DBD_MISSING_API_KEY_MESSAGE) {
    super(message, "DBD");
    this.name = "DbdConfigurationError";
  }
}

export class DbdRateLimitError extends AdapterRateLimitError {
  constructor(message = DBD_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "DBD");
    this.name = "DbdRateLimitError";
  }
}

export class DbdApiError extends AdapterError {
  constructor(message: string) {
    super(message, "DBD");
    this.name = "DbdApiError";
  }
}

// Documented DBD status envelope codes. "1000" is success; everything else is
// either an empty result (not an error) or a real rejection worth surfacing.
export const DBD_STATUS_SUCCESS = "1000";
export const DBD_STATUS_NO_DATA = "1004";
export const DBD_STATUS_BAD_ID_FORMAT = "1051";

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
};

export function getDbdApiKeyOrUndefined(
  options: AdapterOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  return env.DBD_API_KEY?.trim() || undefined;
}

export function hasDbdConfiguration(options: AdapterOptions = {}): boolean {
  return getDbdApiKeyOrUndefined(options) !== undefined;
}

function acquireRequest(): void {
  if (!dbdRateLimiter.tryAcquire()) throw new DbdRateLimitError();
}

/** A Thai juristic-person registration number is exactly 13 digits. */
export function isThaiJuristicId(value: string): boolean {
  return /^\d{13}$/.test(value.replace(/[\s-]/g, ""));
}

export function normalizeJuristicId(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/**
 * DBD register dates arrive as `YYYYMMDD`. The keyless openapi endpoint uses
 * Common Era (PTT reads 20011001), but sibling DBD surfaces publish Buddhist-era
 * years, so a year at/above 2400 is folded back by the 543-year BE offset rather
 * than emitted as a nonsense date.
 */
export function formatDbdDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.trim();
  if (!/^\d{8}$/.test(digits)) return undefined;
  let year = Number.parseInt(digits.slice(0, 4), 10);
  if (year >= 2400) year -= 543;
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  if (month === "00" || day === "00") return undefined;
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

/** Normalize DBD's capital strings ("28562996250.0") to a plain numeric string. */
export function formatDbdCapital(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return undefined;
  return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export interface DbdEntity extends Entity {
  juristicId: string;
  legalNameTh?: string;
  legalNameEn?: string;
  entityType?: string;
  incorporationDate?: string;
  registeredCapital?: string;
  paidUpCapital?: string;
  tsicCode?: string;
  tsicDescription?: string;
  tsicDescriptionTh?: string;
  branchName?: string;
  address?: string;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  return asRecord(asArray(value)[0]);
}

/**
 * Compose the head-office address into one readable line. DBD splits Thai
 * addresses into a dozen optional parts (moo, soi, trok, village…) plus the
 * pre-joined `cd:Address`; the pre-joined form plus the administrative tail
 * (sub-district / district / province) reads best and avoids duplication.
 */
function composeAddress(value: unknown): string | undefined {
  const address = asRecord(asRecord(value)?.["cr:AddressType"]);
  if (!address) return undefined;
  const parts = [
    asString(address["cd:Address"]),
    asString(asRecord(address["cd:CitySubDivision"])?.["cr:CitySubDivisionTextTH"]),
    asString(asRecord(address["cd:City"])?.["cr:CityTextTH"]),
    asString(
      asRecord(address["cd:CountrySubDivision"])?.["cr:CountrySubDivisionTextTH"],
    ),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" ") : undefined;
}

/** The objective block carries one TSIC entry, or an array when several apply. */
function readObjective(value: unknown): {
  code?: string;
  textEn?: string;
  textTh?: string;
} {
  const objective = firstRecord(asRecord(value)?.["td:JuristicObjective"]);
  if (!objective) return {};
  const code = asString(objective["td:JuristicObjectiveCode"]);
  const textEn = asString(objective["td:JuristicObjectiveTextEN"]);
  const textTh = asString(objective["td:JuristicObjectiveTextTH"]);
  return {
    ...(code ? { code } : {}),
    ...(textEn ? { textEn } : {}),
    ...(textTh ? { textTh } : {}),
  };
}

/** Map one `cd:OrganizationJuristicPerson` block to an Entity. */
export function juristicPersonToEntity(
  person: Record<string, unknown>,
  matchReason: string,
): DbdEntity | undefined {
  const juristicId = asString(person["cd:OrganizationJuristicID"]);
  const legalNameTh = asString(person["cd:OrganizationJuristicNameTH"]);
  const legalNameEn = asString(person["cd:OrganizationJuristicNameEN"]);
  // The English name leads where the register carries one (it is the form a
  // caller is most likely to have), with the Thai name kept as an alias so a
  // Thai-script query still ranks. Thai-only entities lead with the Thai name.
  const legalName = legalNameEn ?? legalNameTh;
  if (!juristicId || !legalName) return undefined;
  const aliases = [legalNameEn ? legalNameTh : undefined].filter(
    (alias): alias is string => Boolean(alias),
  );
  const objective = readObjective(person["cd:OrganizationJuristicObjective"]);
  const status = asString(person["cd:OrganizationJuristicStatus"]);
  const entityType = asString(person["cd:OrganizationJuristicType"]);
  const incorporationDate = formatDbdDate(
    asString(person["cd:OrganizationJuristicRegisterDate"]),
  );
  const registeredCapital = formatDbdCapital(
    asString(person["cd:OrganizationJuristicRegisterCapital"]),
  );
  const paidUpCapital = formatDbdCapital(
    asString(person["cd:OrganizationJuristicPaidUpCapital"]),
  );
  const branchName = asString(person["cd:OrganizationJuristicBranchName"]);
  const address = composeAddress(person["cd:OrganizationJuristicAddress"]);
  return {
    legalName,
    juristicId,
    jurisdiction: "TH",
    source: "DBD",
    sourceIdentifiers: { juristicId, jurisdiction: "TH" },
    sourceUrl: `${DBD_OPENAPI_BASE_URL}/${juristicId}`,
    ...(aliases.length ? { aliases } : {}),
    ...(legalNameTh ? { legalNameTh } : {}),
    ...(legalNameEn ? { legalNameEn } : {}),
    ...(status ? { status } : {}),
    ...(entityType ? { entityType } : {}),
    ...(incorporationDate ? { incorporationDate } : {}),
    ...(registeredCapital ? { registeredCapital } : {}),
    ...(paidUpCapital ? { paidUpCapital } : {}),
    ...(objective.code ? { tsicCode: objective.code } : {}),
    ...(objective.textEn ? { tsicDescription: objective.textEn } : {}),
    ...(objective.textTh ? { tsicDescriptionTh: objective.textTh } : {}),
    ...(branchName ? { branchName } : {}),
    ...(address ? { address } : {}),
    matchReason,
  };
}

/**
 * Resolve one exact 13-digit juristic number through the keyless endpoint.
 * A documented "no data" / bad-format envelope is an empty result, not an
 * error — only an undocumented failure envelope raises.
 */
export async function resolveDbdJuristicId(
  juristicId: string,
  options: AdapterOptions = {},
  matchReason = "Exact juristic-number match",
): Promise<DbdEntity | undefined> {
  const wanted = normalizeJuristicId(juristicId);
  if (!isThaiJuristicId(wanted)) return undefined;
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      `${DBD_OPENAPI_BASE_URL}/${wanted}`,
      HEADERS,
      DBD_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new DbdRateLimitError();
    }
    // A 404 from the by-id path is "no such juristic person", not a fault.
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
  const envelope = asRecord(payload);
  const code = asString(asRecord(envelope?.status)?.code);
  if (code && code !== DBD_STATUS_SUCCESS) {
    if (code === DBD_STATUS_NO_DATA || code === DBD_STATUS_BAD_ID_FORMAT) {
      return undefined;
    }
    const description =
      asString(asRecord(envelope?.status)?.description) ?? "unknown error";
    throw new DbdApiError(`DBD rejected the request (${code}): ${description}`);
  }
  const person = asRecord(
    firstRecord(envelope?.data)?.["cd:OrganizationJuristicPerson"],
  );
  if (!person) return undefined;
  return juristicPersonToEntity(person, matchReason);
}

/** How many name-search hits are re-resolved against the keyless endpoint. */
export const DBD_NAME_SEARCH_LIMIT = 10;

/**
 * Collect 13-digit juristic ids from an arbitrarily-shaped GDX payload.
 *
 * The GDX gateway is key-gated, so its exact envelope could not be verified
 * live here (only its auth behaviour was). Rather than hard-code an unverified
 * shape, this walks the response for id-looking values under id-looking keys —
 * then every hit is re-resolved through the PROVEN keyless by-id endpoint, so
 * the facts served always come from the verified source.
 */
export function collectJuristicIds(payload: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 8 || found.length >= DBD_NAME_SEARCH_LIMIT) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (record) {
      for (const [childKey, child] of Object.entries(record)) {
        visit(child, childKey, depth + 1);
      }
      return;
    }
    const text = typeof value === "number" ? String(value) : asString(value);
    if (!text || !/juristic.*id|id.*juristic|^id$/i.test(key)) return;
    const candidate = normalizeJuristicId(text);
    if (!isThaiJuristicId(candidate) || seen.has(candidate)) return;
    seen.add(candidate);
    found.push(candidate);
  };
  visit(payload, "", 0);
  return found;
}

async function searchDbdByName(
  query: string,
  options: AdapterOptions,
): Promise<DbdEntity[]> {
  const apiKey = getDbdApiKeyOrUndefined(options);
  if (!apiKey) throw new DbdConfigurationError();
  const url = new URL(DBD_GDX_NAME_SEARCH_URL);
  url.searchParams.set("Name", query);
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      url.toString(),
      { ...HEADERS, "Consumer-Key": apiKey },
      DBD_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new DbdRateLimitError();
    }
    if (
      error instanceof HttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new DbdConfigurationError(
        "DBD rejected DBD_API_KEY (DGA GDX returned " +
          `${error.status}). Check the key is registered and active, or pass ` +
          "an exact 13-digit juristic-person registration number, which " +
          "resolves keyless.",
      );
    }
    throw error;
  }
  const ids = collectJuristicIds(payload);
  const entities: DbdEntity[] = [];
  for (const id of ids) {
    // A single upstream hiccup on one candidate must not sink the whole
    // result list, so a failed re-resolve just drops that candidate.
    try {
      const entity = await resolveDbdJuristicId(
        id,
        options,
        "DBD name search result",
      );
      if (entity) entities.push(entity);
    } catch (error) {
      if (
        error instanceof DbdRateLimitError ||
        error instanceof DbdConfigurationError
      ) {
        throw error;
      }
    }
  }
  return rankEntities(query, entities, {
    fallbackReason: "DBD name search result",
  }) as DbdEntity[];
}

export async function searchDbdCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<DbdEntity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (isThaiJuristicId(trimmed)) {
    const entity = await resolveDbdJuristicId(trimmed, options);
    return entity ? [entity] : [];
  }
  return searchDbdByName(trimmed, options);
}

export async function resolveDbdCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<DbdEntity | null> {
  return (await searchDbdCompanies(query, options))[0] ?? null;
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveDbdCompany;
export const searchCompanies = searchDbdCompanies;

export function createDbdThailandAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveDbdCompany(query, options),
    searchEntities: (query: string) => searchDbdCompanies(query, options),
  };
}
