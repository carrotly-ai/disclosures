import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getText, HttpError, postJson } from "../core/http.js";
import {
  asArray,
  asRecord,
  asString,
  plainXmlText,
  xmlBlocks,
} from "../core/parsing.js";
import { fcaNsmRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, OwnerRecord } from "../core/types.js";

// The FCA National Storage Mechanism (NSM) is where UK-listed issuers' DTR5
// "notification of major holdings" (TR-1) artefacts live — the ~3%+ equity /
// voting-rights signal that Companies House's PSC register (a >25% statutory
// control register) does not carry. The FCA states the NSM is UI-only; there is
// no public read API. A single-page app is backed by an undocumented
// Elasticsearch proxy and serves each artefact as static HTML.
//
// This adapter is therefore INJECT-ONLY: the default (no fetchFn) path never
// touches data.fca.org.uk and returns an honest "supply NSM access" result. A
// consumer who has their own NSM access wires a fetchFn via AdapterOptions, and
// only then does the search + artefact fetch run. The TR-1 HTML parser is
// always available and exercised offline against recorded artefact fixtures.
export const FCA_NSM_SEARCH_URL =
  "https://api.data.fca.org.uk/search?index=nsm-search";
export const FCA_NSM_ARTEFACT_BASE_URL =
  "https://data.fca.org.uk/artefacts/";
export const FCA_NSM_REQUEST_TIMEOUT_MS = 20_000;
export const FCA_NSM_MAX_ARTEFACTS = 10;
export const FCA_NSM_SEARCH_PAGE_SIZE = 100;

/** TR-1 "Holding(s) in Company" artefacts carry the NSM type_code "HOL". */
export const FCA_NSM_HOLDING_TYPE_CODE = "HOL";

export const FCA_NSM_TR1_THRESHOLD_REGIME =
  "UK DTR5 major holdings (TR-1): notifiable at 3% of voting rights, then each " +
  "whole percentage point crossed above 3% (5% for certain investment " +
  "managers), reported as resulting % of voting rights";

export const FCA_NSM_INJECT_NOTE =
  "UK major-holdings (DTR5/TR-1) data lives in the FCA National Storage " +
  "Mechanism, which the FCA provides for interactive (UI-only) access with no " +
  "public read API. This release does not scrape it by default: supply your " +
  "own NSM access by injecting a fetchFn via AdapterOptions to enable TR-1 " +
  "major-holding lookups. Companies House PSC records (statutory >25% control) " +
  "are shown below where available and are a different, non-equity signal.";

export const FCA_NSM_TR1_CAVEAT =
  "TR-1 notifications are self-reported DTR5 major-holding disclosures parsed " +
  "from FCA NSM artefacts. Each row is a point-in-time notification, not a live " +
  "share register: a holder who has since crossed back below the threshold, or " +
  "who reported before the search window, may not reflect the current position. " +
  "Not UBO tracing.";

export const FCA_NSM_RATE_LIMIT_MESSAGE =
  "FCA NSM request limit reached. Please retry later.";

export class FcaNsmRateLimitError extends AdapterRateLimitError {
  constructor(message = FCA_NSM_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "FCA NSM");
    this.name = "FcaNsmRateLimitError";
  }
}

export class FcaNsmApiError extends AdapterError {
  constructor(message: string) {
    super(message, "FCA NSM");
    this.name = "FcaNsmApiError";
  }
}

function acquireRequest(): void {
  if (!fcaNsmRateLimiter.tryAcquire()) throw new FcaNsmRateLimitError();
}

function mapHttpError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 429) {
    return new FcaNsmRateLimitError();
  }
  return error;
}

/** True when NSM access has been explicitly supplied (inject-only). */
export function hasFcaNsmAccess(options: AdapterOptions = {}): boolean {
  return options.fetchFn !== undefined;
}

// --- TR-1 artefact parsing -------------------------------------------------

export interface Tr1ChainLink {
  ultimateControllingPerson?: string;
  controlledUndertaking?: string;
  pct?: number;
}

export interface Tr1Notification {
  issuerName?: string;
  issuerIsin?: string;
  ukIssuer?: string;
  reason?: string;
  personSubject?: string;
  personCity?: string;
  personCountry?: string;
  thresholdCrossedDate?: string;
  issuerNotifiedDate?: string;
  resultingPctTotal?: number;
  resultingVotingRights?: number;
  previousPctTotal?: number;
  chain: Tr1ChainLink[];
  dateOfCompletion?: string;
  placeOfCompletion?: string;
  rnsNumber?: string;
  sourceUrl: string;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Normalise "05-Nov-2025" or "06/11/2025" (dd/mm/yyyy) to ISO "YYYY-MM-DD". */
export function normalizeTr1Date(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const named = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
  if (named) {
    const day = named[1]?.padStart(2, "0");
    const month = MONTHS[named[2]?.toLowerCase() ?? ""];
    const year = named[3];
    if (day && month && year) return `${year}-${month}-${day}`;
  }
  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numeric) {
    const day = numeric[1]?.padStart(2, "0");
    const month = numeric[2]?.padStart(2, "0");
    const year = numeric[3];
    if (day && month && year) return `${year}-${month}-${day}`;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

function parsePct(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[%,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return undefined;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidIsin(value: string | undefined): boolean {
  return value !== undefined && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value);
}

/** A numbered section header like "10. In case of proxy voting". */
function isSectionHeader(token: string): boolean {
  return /^\d{1,2}\.\s/.test(token);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Index of the first token equal (case-insensitive) to `label`, at/after `from`. */
function indexOfExact(tokens: string[], label: string, from = 0): number {
  const needle = normalizeToken(label);
  for (let index = Math.max(0, from); index < tokens.length; index += 1) {
    if (normalizeToken(tokens[index] ?? "") === needle) return index;
  }
  return -1;
}

/** Index of the first token that starts with `prefix`, at/after `from`. */
function indexOfPrefix(tokens: string[], prefix: string, from = 0): number {
  const needle = normalizeToken(prefix);
  for (let index = Math.max(0, from); index < tokens.length; index += 1) {
    if (normalizeToken(tokens[index] ?? "").startsWith(needle)) return index;
  }
  return -1;
}

/** First non-empty token after the first exact match of `label`. */
function valueAfterExact(tokens: string[], label: string, from = 0): string | undefined {
  const at = indexOfExact(tokens, label, from);
  if (at === -1) return undefined;
  for (let index = at + 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.trim();
    if (token) return token;
  }
  return undefined;
}

/** First non-empty token after the first prefix match of `prefix`. */
function valueAfterPrefix(tokens: string[], prefix: string, from = 0): string | undefined {
  const at = indexOfPrefix(tokens, prefix, from);
  if (at === -1) return undefined;
  for (let index = at + 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.trim();
    if (token) return token;
  }
  return undefined;
}

function parseChain(tokens: string[], sectionNineIndex: number): Tr1ChainLink[] {
  if (sectionNineIndex === -1) return [];
  const headerIndex = indexOfExact(tokens, "Ultimate controlling person", sectionNineIndex);
  if (headerIndex === -1) return [];
  const links: Tr1ChainLink[] = [];
  // Skip the five header cells, then read data rows in groups of five until the
  // next numbered section header ("10. ...").
  const cells: string[] = [];
  for (let index = headerIndex + 5; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (isSectionHeader(token)) break;
    cells.push(token);
  }
  for (let offset = 0; offset + 1 < cells.length; offset += 5) {
    const ultimate = cells[offset]?.trim();
    const controlled = cells[offset + 1]?.trim();
    const pct = parsePct(cells[offset + 2]);
    if (!ultimate && !controlled) continue;
    links.push({
      ...(ultimate ? { ultimateControllingPerson: ultimate } : {}),
      ...(controlled ? { controlledUndertaking: controlled } : {}),
      ...(pct !== undefined ? { pct } : {}),
    });
  }
  return links;
}

/**
 * Parse a TR-1 "notification of major holdings" artefact into a structured
 * record. Returns null when the HTML is not a recognisable TR-1 form. The parse
 * is anchored on the standard TR-1 section labels rather than the exact div/CSS
 * nesting (which RNS templates vary), reading each `<p>` cell as one token.
 */
export function parseTr1Artefact(
  html: string,
  sourceUrl: string,
): Tr1Notification | null {
  const tokens = xmlBlocks(html, "p").map(plainXmlText);
  if (!tokens.length) return null;
  const isTr1 = tokens.some((token) =>
    normalizeToken(token).includes("notification of major holdings"),
  );
  if (!isTr1) return null;

  const issuerIsinRaw = valueAfterExact(tokens, "ISIN");
  const issuerIsin = isValidIsin(issuerIsinRaw) ? issuerIsinRaw : undefined;
  const issuerName = valueAfterExact(tokens, "Issuer Name");
  const ukIssuer = valueAfterExact(tokens, "UK or Non-UK Issuer");
  const reason = valueAfterPrefix(tokens, "2. Reason for Notification");

  const sectionThree = indexOfPrefix(tokens, "3. Details of person subject");
  const personSubject = valueAfterExact(tokens, "Name", sectionThree);
  const personCity = valueAfterExact(
    tokens,
    "City of registered office (if applicable)",
    sectionThree,
  );
  const personCountry = valueAfterExact(
    tokens,
    "Country of registered office (if applicable)",
    sectionThree,
  );

  const thresholdCrossedDate = normalizeTr1Date(
    valueAfterPrefix(tokens, "5. Date on which the threshold"),
  );
  const issuerNotifiedDate = normalizeTr1Date(
    valueAfterPrefix(tokens, "6. Date on which Issuer notified"),
  );

  const resultingIndex = indexOfPrefix(tokens, "Resulting situation on the date");
  const resultingPctTotal = resultingIndex === -1
    ? undefined
    : parsePct(tokens[resultingIndex + 3]);
  const resultingVotingRights = resultingIndex === -1
    ? undefined
    : parseCount(tokens[resultingIndex + 4]);

  const previousIndex = indexOfPrefix(tokens, "Position of previous notification");
  const previousPctTotal = previousIndex === -1
    ? undefined
    : parsePct(tokens[previousIndex + 3]);

  const sectionNine = indexOfPrefix(tokens, "9. Information in relation to");
  const chain = parseChain(tokens, sectionNine);

  const dateOfCompletion = normalizeTr1Date(
    valueAfterPrefix(tokens, "12. Date of Completion"),
  );
  const placeOfCompletion = valueAfterPrefix(tokens, "13. Place Of Completion");

  const rnsNumber = plainXmlText(html).match(/RNS Number\s*:?\s*([A-Za-z0-9]+)/i)?.[1];

  return {
    ...(issuerName ? { issuerName } : {}),
    ...(issuerIsin ? { issuerIsin } : {}),
    ...(ukIssuer ? { ukIssuer } : {}),
    ...(reason ? { reason } : {}),
    ...(personSubject ? { personSubject } : {}),
    ...(personCity ? { personCity } : {}),
    ...(personCountry ? { personCountry } : {}),
    ...(thresholdCrossedDate ? { thresholdCrossedDate } : {}),
    ...(issuerNotifiedDate ? { issuerNotifiedDate } : {}),
    ...(resultingPctTotal !== undefined ? { resultingPctTotal } : {}),
    ...(resultingVotingRights !== undefined ? { resultingVotingRights } : {}),
    ...(previousPctTotal !== undefined ? { previousPctTotal } : {}),
    chain,
    ...(dateOfCompletion ? { dateOfCompletion } : {}),
    ...(placeOfCompletion ? { placeOfCompletion } : {}),
    ...(rnsNumber ? { rnsNumber } : {}),
    sourceUrl,
  };
}

// --- NSM search ------------------------------------------------------------

interface NsmHit {
  downloadLink: string;
  typeCode?: string;
  company?: string;
  lei?: string;
  headline?: string;
  publicationDate?: string;
  disclosureId?: string;
}

function parseNsmHit(value: unknown): NsmHit | undefined {
  const source = asRecord(asRecord(value)?._source);
  const downloadLink = asString(source?.download_link);
  if (!downloadLink) return undefined;
  const typeCode = asString(source?.type_code);
  const company = asString(source?.company);
  const lei = asString(source?.lei);
  const headline = asString(source?.headline);
  const publicationDate = asString(source?.publication_date);
  const disclosureId = asString(source?.disclosure_id);
  return {
    downloadLink,
    ...(typeCode ? { typeCode } : {}),
    ...(company ? { company } : {}),
    ...(lei ? { lei } : {}),
    ...(headline ? { headline } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(disclosureId ? { disclosureId } : {}),
  };
}

export function parseNsmSearchResponse(value: unknown): NsmHit[] {
  // Elasticsearch shape is { hits: { hits: [...] } }; tolerate a flatter
  // { hits: [...] } in case the proxy response shape drifts.
  const outer = asRecord(asRecord(value)?.hits);
  const rows = outer ? asArray(outer.hits) : asArray(asRecord(value)?.hits);
  return rows.flatMap((row) => {
    const hit = parseNsmHit(row);
    return hit ? [hit] : [];
  });
}

function artefactUrl(downloadLink: string): string {
  const trimmed = downloadLink.replace(/^\/+/, "");
  return `${FCA_NSM_ARTEFACT_BASE_URL}${trimmed}`;
}

function searchBody(keyword: string) {
  return {
    from: 0,
    size: FCA_NSM_SEARCH_PAGE_SIZE,
    sort: "publication_date",
    sortorder: "desc",
    keyword,
    criteriaObj: { criteria: [], dateCriteria: [] },
  };
}

async function searchNsm(
  keyword: string,
  options: AdapterOptions,
): Promise<NsmHit[]> {
  const fetchFn = options.fetchFn;
  if (!fetchFn) return [];
  acquireRequest();
  let payload: unknown;
  try {
    payload = await postJson(
      FCA_NSM_SEARCH_URL,
      searchBody(keyword),
      { Accept: "application/json" },
      FCA_NSM_REQUEST_TIMEOUT_MS,
      fetchFn,
    );
  } catch (error) {
    throw mapHttpError(error);
  }
  return parseNsmSearchResponse(payload);
}

function chainSummary(notification: Tr1Notification): string | undefined {
  const names = notification.chain
    .map((link) => link.ultimateControllingPerson)
    .filter((name): name is string => Boolean(name));
  return names.length ? `Ultimate controller: ${[...new Set(names)].join("; ")}` : undefined;
}

function notificationToOwner(notification: Tr1Notification): OwnerRecord {
  const filedDate = notification.issuerNotifiedDate ??
    notification.thresholdCrossedDate ??
    notification.dateOfCompletion ??
    "Not stated";
  const summary = chainSummary(notification);
  return {
    holderName: notification.personSubject ?? "(unnamed TR-1 filer)",
    holderType: "TR-1 major holding",
    ...(notification.resultingPctTotal !== undefined
      ? { pct: notification.resultingPctTotal }
      : {}),
    ...(notification.previousPctTotal !== undefined &&
      notification.resultingPctTotal !== undefined
      ? { change: Number((notification.resultingPctTotal - notification.previousPctTotal).toFixed(6)) }
      : {}),
    thresholdRegime: FCA_NSM_TR1_THRESHOLD_REGIME,
    form: "TR-1",
    filedDate,
    ...(notification.issuerNotifiedDate
      ? { notifiedDate: notification.issuerNotifiedDate }
      : {}),
    ...(summary ? { naturesOfControl: [summary] } : {}),
    sourceUrl: notification.sourceUrl,
    source: "FCA NSM",
    sourceIdentifiers: {
      jurisdiction: "GB",
      ...(notification.issuerIsin ? { isin: notification.issuerIsin } : {}),
    },
  };
}

/**
 * Fetch and parse recent UK TR-1 major-holding notifications for a company.
 * Inject-only: with no fetchFn supplied this returns an empty list (callers
 * should check {@link hasFcaNsmAccess} first to render the honest access note).
 * With a fetchFn, it keyword-searches the NSM, client-filters to TR-1
 * ("HOL") artefacts, and parses each into a normalized owner record.
 */
export async function getFcaNsmMajorHoldings(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  if (!hasFcaNsmAccess(options)) return [];
  const trimmed = company.trim();
  if (!trimmed) return [];
  const hits = (await searchNsm(trimmed, options))
    .filter((hit) => (hit.typeCode ?? "").toUpperCase() === FCA_NSM_HOLDING_TYPE_CODE)
    .slice(0, FCA_NSM_MAX_ARTEFACTS);

  const owners: OwnerRecord[] = [];
  for (const hit of hits) {
    const url = artefactUrl(hit.downloadLink);
    let html: string;
    try {
      html = await getText(url, {}, FCA_NSM_REQUEST_TIMEOUT_MS, options.fetchFn ?? fetch);
    } catch (error) {
      throw mapHttpError(error);
    }
    const notification = parseTr1Artefact(html, url);
    if (notification) owners.push(notificationToOwner(notification));
  }
  return owners.sort((left, right) => right.filedDate.localeCompare(left.filedDate));
}

export function createFcaNsmAdapter(options: AdapterOptions = {}) {
  return {
    hasAccess: () => hasFcaNsmAccess(options),
    getMajorHoldings: (company: string) => getFcaNsmMajorHoldings(company, options),
  };
}
