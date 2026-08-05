import { getJson, getOptionalJson } from "../core/http.js";
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

export class GleifRateLimitError extends Error {
  readonly limit = 60;
  readonly windowMs = 60_000;

  constructor(message = GLEIF_RATE_LIMIT_MESSAGE) {
    super(message);
    this.name = "GleifRateLimitError";
  }
}

const LEI_PATTERN = /^[A-Z0-9]{18}[0-9]{2}$/;
const REQUEST_HEADERS = { Accept: "application/vnd.api+json" };

type JsonObject = Record<string, unknown>;
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

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedObject(value: unknown, key: string): JsonObject | undefined {
  return asObject(asObject(value)?.[key]);
}

function unwrapSingleResource(value: unknown): JsonObject {
  const object = asObject(value);
  if (!object) throw new Error("Invalid GLEIF response: expected an object");
  const data = object.data;
  if (data !== undefined) {
    const resource = asObject(data);
    if (!resource) {
      throw new Error("Invalid GLEIF response: expected a single resource");
    }
    return resource;
  }
  return object;
}

function parseRelationships(value: unknown): RelationshipMap {
  const relationships = asObject(value);
  const result: RelationshipMap = {};
  if (!relationships) return result;

  for (const [name, relationshipValue] of Object.entries(relationships)) {
    const links = asObject(asObject(relationshipValue)?.links);
    if (!links) continue;

    const parsedLinks: Record<string, string> = {};
    for (const [linkName, linkValue] of Object.entries(links)) {
      const link = stringValue(linkValue);
      if (link) parsedLinks[linkName] = link;
    }
    if (Object.keys(parsedLinks).length > 0) result[name] = parsedLinks;
  }

  return result;
}

function parseNames(value: unknown): string[] {
  const names: string[] = [];
  for (const item of asArray(value)) {
    const name = stringValue(asObject(item)?.name);
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
  return stringValue(nestedObject(nestedObject(value, "meta"), "goldenCopy")?.publishDate);
}

function documentNextUrl(value: unknown): string | undefined {
  return stringValue(nestedObject(value, "links")?.next);
}

function sourceUrlForResource(resource: JsonObject, lei: string): string {
  return (
    stringValue(asObject(resource.links)?.self) ??
    `${GLEIF_BASE_URL}/lei-records/${encodeURIComponent(lei)}`
  );
}

export function isLei(value: string): boolean {
  return LEI_PATTERN.test(value.trim().toUpperCase());
}

export const isLikelyLei = isLei;

export function normalizeEntityName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseLeiRecordResource(value: unknown): ParsedLeiRecord {
  const resource = unwrapSingleResource(value);
  const attributes = asObject(resource.attributes);
  const entityAttributes = asObject(attributes?.entity);
  const lei =
    stringValue(attributes?.lei) ??
    stringValue(resource.id);
  const legalName = stringValue(asObject(entityAttributes?.legalName)?.name);

  if (!lei || !legalName) {
    throw new Error("Invalid GLEIF LEI record: missing LEI or legal name");
  }

  const aliases = uniqueAliases(legalName, [
    ...parseNames(entityAttributes?.otherNames),
    ...parseNames(entityAttributes?.transliteratedOtherNames),
  ]);
  const status =
    stringValue(entityAttributes?.status) ??
    stringValue(asObject(attributes?.registration)?.status);
  const jurisdiction = stringValue(entityAttributes?.jurisdiction);

  const entity: Entity = {
    legalName,
    lei,
    source: "GLEIF",
    sourceUrl: sourceUrlForResource(resource, lei),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(status ? { status } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
  };

  const type = stringValue(resource.type);
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
  const document = asObject(value);
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
  const attributes = asObject(resource.attributes);
  if (!attributes) {
    throw new Error("Invalid GLEIF reporting exception: missing attributes");
  }

  const category = stringValue(attributes.category);
  const reason = stringValue(attributes.reason);
  const reference = stringValue(attributes.reference);
  return {
    ...(category ? { category } : {}),
    ...(reason ? { reason } : {}),
    ...(reference ? { reference } : {}),
  };
}

function matchScore(query: string, entity: Entity): { score: number; reason: string } {
  const normalizedQuery = normalizeEntityName(query);
  const legalName = normalizeEntityName(entity.legalName);
  const aliases = (entity.aliases ?? []).map(normalizeEntityName);

  if (legalName === normalizedQuery) {
    return { score: 10_000, reason: "Exact normalized legal-name match" };
  }
  if (aliases.includes(normalizedQuery)) {
    return { score: 9_500, reason: "Exact normalized alias match" };
  }
  if (legalName.startsWith(normalizedQuery)) {
    return { score: 8_000, reason: "Legal name starts with query" };
  }
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) {
    return { score: 7_500, reason: "Alias starts with query" };
  }
  if (legalName.includes(normalizedQuery)) {
    return { score: 7_000, reason: "Legal name contains query" };
  }
  if (aliases.some((alias) => alias.includes(normalizedQuery))) {
    return { score: 6_500, reason: "Alias contains query" };
  }

  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const candidateTokens = new Set(
    [legalName, ...aliases].flatMap((name) => name.split(" ").filter(Boolean)),
  );
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  const denominator = Math.max(queryTokens.size, candidateTokens.size, 1);
  return {
    score: Math.round((overlap / denominator) * 1_000),
    reason: overlap > 0 ? "Best normalized token match" : "GLEIF legal-name search result",
  };
}

export function rankEntities(query: string, entities: Entity[]): Entity[] {
  return entities
    .map((entity, index) => {
      const match = matchScore(query, entity);
      const lengthDistance = Math.abs(
        normalizeEntityName(entity.legalName).length - normalizeEntityName(query).length,
      );
      return {
        entity: { ...entity, matchReason: match.reason },
        index,
        score: match.score,
        lengthDistance,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.lengthDistance - right.lengthDistance ||
        left.index - right.index,
    )
    .map(({ entity }) => entity);
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

    const type = stringValue(unwrapSingleResource(payload).type);
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
