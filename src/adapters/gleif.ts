import {
  normalizeEntityName as normalizeSharedEntityName,
  rankEntities as rankSharedEntities,
} from "../core/entityMatching.js";
import { AdapterRateLimitError } from "../core/errors.js";
import { getJson, getOptionalJson } from "../core/http.js";
import {
  asArray,
  asRecord,
  asString,
  nestedRecord,
  type JsonRecord,
} from "../core/parsing.js";
import { gleifRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  FetchFn,
  OwnershipChainResult,
  OwnershipParent,
} from "../core/types.js";

export const GLEIF_BASE_URL = "https://api.gleif.org/api/v1";

export const GLEIF_RATE_LIMIT_MESSAGE =
  "GLEIF rate limit exceeded (60 requests per minute). Please wait before retrying.";

export class GleifRateLimitError extends AdapterRateLimitError {
  constructor(message = GLEIF_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "GLEIF");
    this.name = "GleifRateLimitError";
  }
}

const LEI_PATTERN = /^[A-Z0-9]{18}[0-9]{2}$/;
const REQUEST_HEADERS = { Accept: "application/vnd.api+json" };

type JsonObject = JsonRecord;
type RelationshipMap = Record<string, Record<string, string>>;

export interface ParsedLeiRecord {
  entity: Entity;
  relationships: RelationshipMap;
  type?: string;
}

export interface ParsedLeiCollection {
  records: ParsedLeiRecord[];
  entities: Entity[];
  goldenCopyPublishedAt?: string;
  nextUrl?: string;
}

export interface ParsedReportingException {
  category?: string;
  reason?: string;
  reference?: string;
}

interface ResolvedRecord {
  record: ParsedLeiRecord;
  goldenCopyPublishedAt?: string;
}

function unwrapSingleResource(value: unknown): JsonObject {
  const object = asRecord(value);
  if (!object) throw new Error("Invalid GLEIF response: expected an object");
  const data = object.data;
  if (data !== undefined) {
    const resource = asRecord(data);
    if (!resource) {
      throw new Error("Invalid GLEIF response: expected a single resource");
    }
    return resource;
  }
  return object;
}

function parseRelationships(value: unknown): RelationshipMap {
  const relationships = asRecord(value);
  const result: RelationshipMap = {};
  if (!relationships) return result;

  for (const [name, relationshipValue] of Object.entries(relationships)) {
    const links = asRecord(asRecord(relationshipValue)?.links);
    if (!links) continue;

    const parsedLinks: Record<string, string> = {};
    for (const [linkName, linkValue] of Object.entries(links)) {
      const link = asString(linkValue);
      if (link) parsedLinks[linkName] = link;
    }
    if (Object.keys(parsedLinks).length > 0) result[name] = parsedLinks;
  }

  return result;
}

function parseNames(value: unknown): string[] {
  const names: string[] = [];
  for (const item of asArray(value)) {
    const name = asString(asRecord(item)?.name);
    if (name) names.push(name);
  }
  return names;
}

function uniqueAliases(legalName: string, aliases: string[]): string[] {
  const legalNameKey = normalizeEntityName(legalName);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const alias of aliases) {
    const key = normalizeEntityName(alias);
    if (!key || key === legalNameKey || seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

function parseGoldenCopyPublishedAt(value: unknown): string | undefined {
  return asString(nestedRecord(nestedRecord(value, "meta"), "goldenCopy")?.publishDate);
}

function documentNextUrl(value: unknown): string | undefined {
  return asString(nestedRecord(value, "links")?.next);
}

function sourceUrlForResource(resource: JsonObject, lei: string): string {
  return (
    asString(asRecord(resource.links)?.self) ??
    `${GLEIF_BASE_URL}/lei-records/${encodeURIComponent(lei)}`
  );
}

export function isLei(value: string): boolean {
  return LEI_PATTERN.test(value.trim().toUpperCase());
}

export const isLikelyLei = isLei;

export const normalizeEntityName = normalizeSharedEntityName;

export function parseLeiRecordResource(value: unknown): ParsedLeiRecord {
  const resource = unwrapSingleResource(value);
  const attributes = asRecord(resource.attributes);
  const entityAttributes = asRecord(attributes?.entity);
  const lei =
    asString(attributes?.lei) ??
    asString(resource.id);
  const legalName = asString(asRecord(entityAttributes?.legalName)?.name);

  if (!lei || !legalName) {
    throw new Error("Invalid GLEIF LEI record: missing LEI or legal name");
  }

  const aliases = uniqueAliases(legalName, [
    ...parseNames(entityAttributes?.otherNames),
    ...parseNames(entityAttributes?.transliteratedOtherNames),
  ]);
  const status =
    asString(entityAttributes?.status) ??
    asString(asRecord(attributes?.registration)?.status);
  const jurisdiction = asString(entityAttributes?.jurisdiction);

  const entity: Entity = {
    legalName,
    lei,
    source: "GLEIF",
    sourceUrl: sourceUrlForResource(resource, lei),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(status ? { status } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
  };

  const type = asString(resource.type);
  return {
    entity,
    relationships: parseRelationships(resource.relationships),
    ...(type ? { type } : {}),
  };
}

export function parseLeiRecord(value: unknown): Entity {
  return parseLeiRecordResource(value).entity;
}

export function parseLeiCollection(value: unknown): ParsedLeiCollection {
  const document = asRecord(value);
  if (!document || !Array.isArray(document.data)) {
    throw new Error("Invalid GLEIF response: expected a collection");
  }

  const records = document.data.map((item) => parseLeiRecordResource(item));
  const goldenCopyPublishedAt = parseGoldenCopyPublishedAt(document);
  const nextUrl = documentNextUrl(document);

  return {
    records,
    entities: records.map((record) => record.entity),
    ...(goldenCopyPublishedAt ? { goldenCopyPublishedAt } : {}),
    ...(nextUrl ? { nextUrl } : {}),
  };
}

export function parseReportingException(value: unknown): ParsedReportingException {
  const resource = unwrapSingleResource(value);
  const attributes = asRecord(resource.attributes);
  if (!attributes) {
    throw new Error("Invalid GLEIF reporting exception: missing attributes");
  }

  const category = asString(attributes.category);
  const reason = asString(attributes.reason);
  const reference = asString(attributes.reference);
  return {
    ...(category ? { category } : {}),
    ...(reason ? { reason } : {}),
    ...(reference ? { reference } : {}),
  };
}

export function rankEntities(query: string, entities: Entity[]): Entity[] {
  return rankSharedEntities(query, entities, {
    fallbackReason: "GLEIF legal-name search result",
  });
}

export function rankLeiRecords(query: string, records: ParsedLeiRecord[]): ParsedLeiRecord[] {
  const rankedEntities = rankEntities(
    query,
    records.map((record) => record.entity),
  );
  const byLei = new Map(records.map((record) => [record.entity.lei, record]));

  return rankedEntities.map((entity) => {
    const original = byLei.get(entity.lei);
    if (!original) throw new Error("Unable to rank GLEIF record without an LEI");
    return { ...original, entity };
  });
}

function fetchFor(options: AdapterOptions): FetchFn {
  return options.fetchFn ?? fetch;
}

async function requestJson(url: string, options: AdapterOptions): Promise<unknown> {
  if (!gleifRateLimiter.tryAcquire()) {
    throw new GleifRateLimitError();
  }
  return getJson(url, REQUEST_HEADERS, 15_000, fetchFor(options));
}

async function requestOptionalJson(
  url: string,
  options: AdapterOptions,
): Promise<unknown | null> {
  if (!gleifRateLimiter.tryAcquire()) {
    throw new GleifRateLimitError();
  }
  return getOptionalJson(url, REQUEST_HEADERS, 15_000, fetchFor(options));
}

function absoluteLink(link: string, relativeTo = GLEIF_BASE_URL): string {
  return new URL(link, relativeTo).toString();
}

function collectionUrl(filterName: string, value: string, pageSize: number): string {
  const url = new URL(`${GLEIF_BASE_URL}/lei-records`);
  url.searchParams.set(`filter[${filterName}]`, value);
  url.searchParams.set("page[size]", String(pageSize));
  return url.toString();
}

async function resolveRecord(
  query: string,
  options: AdapterOptions,
): Promise<ResolvedRecord | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (isLei(trimmed)) {
    const lei = trimmed.toUpperCase();
    const payload = await requestJson(collectionUrl("lei", lei, 1), options);
    const collection = parseLeiCollection(payload);
    const record = collection.records.find(
      (candidate) => candidate.entity.lei?.toUpperCase() === lei,
    );
    if (!record) return null;
    return {
      record: {
        ...record,
        entity: { ...record.entity, matchReason: "Exact LEI match" },
      },
      ...(collection.goldenCopyPublishedAt
        ? { goldenCopyPublishedAt: collection.goldenCopyPublishedAt }
        : {}),
    };
  }

  const payload = await requestJson(
    collectionUrl("entity.legalName", trimmed, 100),
    options,
  );
  const collection = parseLeiCollection(payload);
  const record = rankLeiRecords(trimmed, collection.records)[0];
  if (!record) return null;
  return {
    record,
    ...(collection.goldenCopyPublishedAt
      ? { goldenCopyPublishedAt: collection.goldenCopyPublishedAt }
      : {}),
  };
}

export async function searchGleifEntities(
  legalName: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const query = legalName.trim();
  if (!query) return [];
  if (isLei(query)) {
    const resolved = await resolveRecord(query, options);
    return resolved ? [resolved.record.entity] : [];
  }

  const payload = await requestJson(
    collectionUrl("entity.legalName", query, 100),
    options,
  );
  return rankEntities(query, parseLeiCollection(payload).entities);
}

export async function resolveGleifEntity(
  query: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  return (await resolveRecord(query, options))?.record.entity ?? null;
}

export const resolveEntity = resolveGleifEntity;

// --- ISIN <-> LEI cross-walk -------------------------------------------------
//
// GLEIF publishes the ISIN-to-LEI mapping through the same public API: the
// `filter[isin]` collection query resolves an ISIN to its issuer's LEI record,
// and `/lei-records/{lei}/isins` lists every ISIN mapped to an LEI. Both use the
// standard injectable, rate-limited request path — no bulk golden-copy download.

/** Default paging bounds for the (potentially large) LEI -> ISIN listing. */
export const GLEIF_ISIN_PAGE_SIZE = 200;
export const GLEIF_MAX_ISIN_PAGES = 5;

/**
 * True only for a syntactically valid ISIN, check digit included: two letters,
 * nine alphanumerics, one digit, passing the Luhn check over the letter-expanded
 * digit string. The check digit keeps this from firing a GLEIF call on an
 * arbitrary 12-character token.
 */
export function isIsin(value: string): boolean {
  const isin = value.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  let digits = "";
  for (const ch of isin) {
    digits += ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Resolve an ISIN to its issuer's LEI entity, or null if GLEIF maps none. */
export async function resolveLeiByIsin(
  isin: string,
  options: AdapterOptions = {},
): Promise<Entity | null> {
  const trimmed = isin.trim().toUpperCase();
  if (!isIsin(trimmed)) return null;
  const payload = await requestJson(collectionUrl("isin", trimmed, 1), options);
  const entity = parseLeiCollection(payload).entities[0];
  if (!entity) return null;
  return { ...entity, isin: trimmed, matchReason: `Resolved from ISIN ${trimmed}` };
}

/** Extract the ISIN strings and the next-page link from an `/isins` payload. */
export function parseIsinList(payload: unknown): { isins: string[]; nextUrl?: string } {
  const record = asRecord(payload);
  const isins: string[] = [];
  for (const item of asArray(record?.data)) {
    const isin = asString(nestedRecord(item, "attributes")?.isin);
    if (isin) isins.push(isin.toUpperCase());
  }
  const nextUrl = asString(nestedRecord(record, "links")?.next);
  return nextUrl ? { isins, nextUrl } : { isins };
}

/**
 * List the ISINs GLEIF maps to an LEI. Paginated and capped
 * ({@link GLEIF_MAX_ISIN_PAGES}); a heavily-mapped issuer can exceed the cap, so
 * the result is "the first N pages", not necessarily exhaustive.
 */
export async function getIsinsForLei(
  lei: string,
  options: AdapterOptions = {},
  paging: { maxPages?: number } = {},
): Promise<string[]> {
  const trimmed = lei.trim().toUpperCase();
  if (!isLei(trimmed)) return [];
  const maxPages = paging.maxPages ?? GLEIF_MAX_ISIN_PAGES;
  const first = new URL(`${GLEIF_BASE_URL}/lei-records/${encodeURIComponent(trimmed)}/isins`);
  first.searchParams.set("page[size]", String(GLEIF_ISIN_PAGE_SIZE));
  let url: string | undefined = first.toString();
  const seen = new Set<string>();
  const all: string[] = [];
  for (let page = 0; page < maxPages && url; page += 1) {
    const payload = await requestOptionalJson(url, options);
    if (payload === null) break;
    const { isins, nextUrl } = parseIsinList(payload);
    for (const isin of isins) {
      if (!seen.has(isin)) {
        seen.add(isin);
        all.push(isin);
      }
    }
    url = nextUrl ? absoluteLink(nextUrl) : undefined;
  }
  return all;
}

function withReference(exception: ParsedReportingException): string | undefined {
  if (!exception.reason) return exception.reference;
  return exception.reference
    ? `${exception.reason} (${exception.reference})`
    : exception.reason;
}

function ownershipParent(
  kind: "direct" | "ultimate",
  sourceUrl: string,
  entity?: Entity,
  exception?: ParsedReportingException,
): OwnershipParent {
  const exceptionReason = exception ? withReference(exception) : undefined;
  return {
    kind,
    sourceUrl,
    ...(entity ? { entity } : {}),
    ...(exception?.category ? { exceptionCategory: exception.category } : {}),
    ...(exceptionReason ? { exceptionReason } : {}),
  };
}

async function entityFromRelationshipRecord(
  payload: unknown,
  subjectLei: string,
  relationshipUrl: string,
  options: AdapterOptions,
): Promise<{ entity: Entity; sourceUrl: string } | undefined> {
  const resource = unwrapSingleResource(payload);
  const relationships = parseRelationships(resource.relationships);
  const candidateLinks: string[] = [];

  for (const links of Object.values(relationships)) {
    const related = links.related;
    if (related) candidateLinks.push(absoluteLink(related, relationshipUrl));
  }

  for (const candidateUrl of candidateLinks) {
    const candidatePayload = await requestOptionalJson(candidateUrl, options);
    if (candidatePayload === null) continue;
    try {
      const entity = parseLeiRecord(candidatePayload);
      if (entity.lei?.toUpperCase() !== subjectLei.toUpperCase()) {
        return { entity, sourceUrl: candidateUrl };
      }
    } catch {
      // A relationship resource can advertise non-LEI related resources; skip them.
    }
  }
  return undefined;
}

async function loadParent(
  kind: "direct" | "ultimate",
  record: ParsedLeiRecord,
  options: AdapterOptions,
): Promise<OwnershipParent | undefined> {
  const links = record.relationships[`${kind}-parent`];
  const subjectLei = record.entity.lei;
  if (!links || !subjectLei) return undefined;

  for (const linkName of ["lei-record", "related", "relationship-record"] as const) {
    const advertised = links[linkName];
    if (!advertised) continue;
    const url = absoluteLink(advertised, record.entity.sourceUrl);
    const payload = await requestOptionalJson(url, options);
    if (payload === null) continue;

    const type = asString(unwrapSingleResource(payload).type);
    if (type === "reporting-exceptions") {
      return ownershipParent(kind, url, undefined, parseReportingException(payload));
    }
    if (type === "relationship-records") {
      const related = await entityFromRelationshipRecord(
        payload,
        subjectLei,
        url,
        options,
      );
      if (related) return ownershipParent(kind, related.sourceUrl, related.entity);
      continue;
    }

    try {
      return ownershipParent(kind, url, parseLeiRecord(payload));
    } catch {
      // Try any other advertised representation before concluding no parent exists.
    }
  }

  const exceptionLink = links["reporting-exception"];
  if (exceptionLink) {
    const url = absoluteLink(exceptionLink, record.entity.sourceUrl);
    const payload = await requestOptionalJson(url, options);
    if (payload !== null) {
      return ownershipParent(kind, url, undefined, parseReportingException(payload));
    }
  }

  return undefined;
}

async function loadLeiCollectionPages(
  firstUrl: string,
  options: AdapterOptions,
): Promise<Entity[]> {
  const entities: Entity[] = [];
  const seenPages = new Set<string>();
  let nextUrl: string | undefined = firstUrl;

  while (nextUrl && !seenPages.has(nextUrl)) {
    seenPages.add(nextUrl);
    const payload = await requestJson(nextUrl, options);
    const collection = parseLeiCollection(payload);
    entities.push(...collection.entities);
    nextUrl = collection.nextUrl
      ? absoluteLink(collection.nextUrl, nextUrl)
      : undefined;
  }

  const unique = new Map<string, Entity>();
  for (const entity of entities) {
    if (entity.lei && !unique.has(entity.lei)) unique.set(entity.lei, entity);
  }
  return [...unique.values()];
}

async function loadChildren(
  record: ParsedLeiRecord,
  options: AdapterOptions,
): Promise<Entity[]> {
  const links = record.relationships["direct-children"];
  if (!links) return [];

  const advertised = links.related ?? links["lei-records"];
  if (!advertised) return [];
  return loadLeiCollectionPages(
    absoluteLink(advertised, record.entity.sourceUrl),
    options,
  );
}

export async function getOwnershipChain(
  query: string,
  options: AdapterOptions = {},
): Promise<OwnershipChainResult> {
  const resolved = await resolveRecord(query, options);
  if (!resolved) throw new Error(`GLEIF entity not found: ${query}`);

  const [directParent, ultimateParent, children] = await Promise.all([
    loadParent("direct", resolved.record, options),
    loadParent("ultimate", resolved.record, options),
    loadChildren(resolved.record, options),
  ]);

  return {
    entity: resolved.record.entity,
    children,
    ...(directParent ? { directParent } : {}),
    ...(ultimateParent ? { ultimateParent } : {}),
    ...(resolved.goldenCopyPublishedAt
      ? { goldenCopyPublishedAt: resolved.goldenCopyPublishedAt }
      : {}),
  };
}

export const getGleifOwnershipChain = getOwnershipChain;

export function createGleifAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveGleifEntity(query, options),
    searchEntities: (query: string) => searchGleifEntities(query, options),
    getOwnershipChain: (query: string) => getOwnershipChain(query, options),
  };
}
