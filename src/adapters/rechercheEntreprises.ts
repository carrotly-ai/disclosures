import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { rankEntities } from "../core/entityMatching.js";
import { rechercheEntreprisesRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, Entity } from "../core/types.js";

// DINUM's keyless national company + officer search over the merged
// RNE / Sirene / RCS data (annuaire-entreprises). It backs the FR paths for
// CompanyResolve (non-listed + listed, SIREN-keyed) and PersonAppointments
// (officers per company, and person→companies). Licence Open Licence 2.0
// (Etalab); documented ceiling 7 requests/second.
export const RECHERCHE_ENTREPRISES_SEARCH_URL =
  "https://recherche-entreprises.api.gouv.fr/search";
export const ANNUAIRE_ENTREPRISES_BASE_URL =
  "https://annuaire-entreprises.data.gouv.fr/entreprise";

export const RECHERCHE_ENTREPRISES_REQUEST_TIMEOUT_MS = 20_000;
export const RECHERCHE_ENTREPRISES_MAX_RESULTS = 50;

export const RECHERCHE_ENTREPRISES_PERSON_CAVEAT =
  "Officers (dirigeants) from the French RNE/RCS via recherche-entreprises. The " +
  "registry keys people by name, not by a stable person id, so a person is " +
  "matched by name (optionally first name and birth year). French homonyms are " +
  "common — disambiguate by first name, birth year, and company, never by name " +
  "alone. This is the statutory appointment record, not a managers'-transaction " +
  "feed.";

export const RECHERCHE_ENTREPRISES_NO_DISQUALIFICATION_MESSAGE =
  "France publishes no free per-individual disqualified-directors register " +
  "queryable by name (a faillite personnelle / interdiction de gérer is ordered " +
  "by a court and recorded per case, not exposed as a searchable open dataset). " +
  "There is no FR equivalent to surface here; recherche-entreprises returns " +
  "current appointments only.";

export const RECHERCHE_ENTREPRISES_RATE_LIMIT_MESSAGE =
  "recherche-entreprises.api.gouv.fr request limit reached (7 req/s). Please retry later.";

export class RechercheEntreprisesRateLimitError extends AdapterRateLimitError {
  constructor(message = RECHERCHE_ENTREPRISES_RATE_LIMIT_MESSAGE) {
    super(message, 7, 1_000, "recherche-entreprises");
    this.name = "RechercheEntreprisesRateLimitError";
  }
}

export class RechercheEntreprisesApiError extends AdapterError {
  constructor(message: string) {
    super(message, "recherche-entreprises");
    this.name = "RechercheEntreprisesApiError";
  }
}

function acquireRequest(): void {
  if (!rechercheEntreprisesRateLimiter.tryAcquire()) {
    throw new RechercheEntreprisesRateLimitError();
  }
}

function mapHttpError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 429) {
    return new RechercheEntreprisesRateLimitError();
  }
  return error;
}

function isSiren(value: string): boolean {
  return /^\d{9}$/.test(value.trim());
}

function searchUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${RECHERCHE_ENTREPRISES_SEARCH_URL}?${search.toString()}`;
}

async function fetchResults(
  url: string,
  options: AdapterOptions,
): Promise<Record<string, unknown>[]> {
  acquireRequest();
  let payload: unknown;
  try {
    payload = await getJson(
      url,
      { Accept: "application/json" },
      RECHERCHE_ENTREPRISES_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    throw mapHttpError(error);
  }
  const root = asRecord(payload);
  if (!root) return [];
  return asArray(root.results)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

// --- CompanyResolve ---------------------------------------------------------

function companyUrl(siren: string): string {
  return `${ANNUAIRE_ENTREPRISES_BASE_URL}/${siren}`;
}

function resultToEntity(result: Record<string, unknown>, matchReason: string): Entity | undefined {
  const legalName = asString(result.nom_complet) ?? asString(result.nom_raison_sociale);
  const siren = asString(result.siren);
  if (!legalName || !siren) return undefined;
  const activity = asRecord(result.siege) && asString(asRecord(result.siege)?.libelle_commune);
  return {
    legalName,
    jurisdiction: "FR",
    siren,
    ...(activity ? { status: activity } : {}),
    sourceUrl: companyUrl(siren),
    source: "recherche-entreprises",
    matchReason,
    sourceIdentifiers: { jurisdiction: "FR", siren },
  };
}

/**
 * Resolve a French company by name or SIREN via recherche-entreprises. Returns
 * SIREN-keyed candidates covering the millions of companies with no ISIN/LEI.
 */
export async function searchRechercheEntreprises(
  company: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const query = company.trim();
  if (!query) return [];
  const results = await fetchResults(
    searchUrl({ q: query, per_page: "10", page: "1" }),
    options,
  );
  const entities = results
    .map((result) => resultToEntity(result, isSiren(query) ? "SIREN match" : "recherche-entreprises name search"))
    .filter((entity): entity is Entity => entity !== undefined);
  if (isSiren(query)) return entities.slice(0, RECHERCHE_ENTREPRISES_MAX_RESULTS);
  return rankEntities(query, entities, {
    fallbackReason: "recherche-entreprises name search",
  }).slice(0, RECHERCHE_ENTREPRISES_MAX_RESULTS);
}

// --- PersonAppointments -----------------------------------------------------

/** Normalise a dirigeant name for matching: uppercase, strip the "(usage)"
 *  parenthetical the RNE sometimes appends, fold diacritics, collapse space. */
function normalizePersonName(value: string): string {
  return value
    .replace(/\(.*?\)/g, " ")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Human display form of a surname: drop the "(usage)" parenthetical the RNE
 *  sometimes appends and collapse whitespace, keeping the original case. */
function cleanSurname(value: string): string {
  return value.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

interface Dirigeant {
  nom: string;
  prenoms?: string;
  qualite?: string;
  birthYear?: string;
}

function parseDirigeant(entry: Record<string, unknown> | undefined): Dirigeant | undefined {
  if (!entry) return undefined;
  const type = asString(entry.type_dirigeant);
  if (type && type.toLowerCase().includes("morale")) return undefined;
  const nom = asString(entry.nom);
  if (!nom) return undefined;
  const prenoms = asString(entry.prenoms);
  const qualite = asString(entry.qualite);
  const birthYear = asString(entry.annee_de_naissance);
  return {
    nom,
    ...(prenoms ? { prenoms } : {}),
    ...(qualite ? { qualite } : {}),
    ...(birthYear ? { birthYear } : {}),
  };
}

export interface RecherchePersonMatch {
  officerId: string;
  name: string;
  surname: string;
  firstNames?: string;
  birthYear?: string;
  role?: string;
  companyCount: number;
  sampleCompany?: string;
  sourceUrl: string;
}

/** Encode a person id from surname + first names (the registry has no stable
 *  person id). Decoded by `getRecherchePersonAppointments`. */
function personId(surname: string, firstNames?: string): string {
  return firstNames ? `${surname}|${firstNames}` : surname;
}

/**
 * Search French officers (dirigeants) by name. recherche-entreprises returns
 * the companies where the person is a dirigeant; this collapses them to one
 * entry per distinct (surname, first names) with a company count and a sample.
 */
export async function searchRecherchePeople(
  name: string,
  options: AdapterOptions = {},
): Promise<RecherchePersonMatch[]> {
  const query = name.trim();
  if (!query) return [];
  const results = await fetchResults(
    searchUrl({ nom_personne: query, per_page: "25", page: "1" }),
    options,
  );
  const target = normalizePersonName(query);
  const byPerson = new Map<string, RecherchePersonMatch>();
  for (const result of results) {
    const companyName = asString(result.nom_complet);
    const siren = asString(result.siren);
    for (const raw of asArray(result.dirigeants)) {
      const dirigeant = parseDirigeant(asRecord(raw));
      if (!dirigeant) continue;
      const surnameNorm = normalizePersonName(dirigeant.nom);
      if (!surnameNorm.includes(target) && !target.includes(surnameNorm)) continue;
      const firstNames = dirigeant.prenoms;
      const surnameDisplay = cleanSurname(dirigeant.nom);
      const key = `${surnameNorm}|${(firstNames ?? "").toUpperCase()}`;
      const existing = byPerson.get(key);
      if (existing) {
        existing.companyCount += 1;
        continue;
      }
      byPerson.set(key, {
        officerId: personId(surnameDisplay, firstNames),
        name: [firstNames, surnameDisplay].filter(Boolean).join(" "),
        surname: surnameDisplay,
        ...(firstNames ? { firstNames } : {}),
        ...(dirigeant.birthYear ? { birthYear: dirigeant.birthYear } : {}),
        ...(dirigeant.qualite ? { role: dirigeant.qualite } : {}),
        companyCount: 1,
        ...(companyName ? { sampleCompany: companyName } : {}),
        sourceUrl: siren
          ? companyUrl(siren)
          : searchUrl({ nom_personne: query }),
      });
    }
  }
  return [...byPerson.values()]
    .sort((left, right) => right.companyCount - left.companyCount)
    .slice(0, RECHERCHE_ENTREPRISES_MAX_RESULTS);
}

export interface RecherchePersonAppointment {
  companyName: string;
  siren?: string;
  role?: string;
  sourceUrl: string;
}

export interface RecherchePersonAppointments {
  officerId: string;
  personName?: string;
  appointments: RecherchePersonAppointment[];
}

/**
 * Resolve one person's cross-company appointments. The officer_id is the
 * person's name (surname, optionally "surname|first names") produced by
 * `searchRecherchePeople`; homonyms are possible, hence the caveat.
 */
export async function getRecherchePersonAppointments(
  officerId: string,
  options: AdapterOptions = {},
): Promise<RecherchePersonAppointments> {
  const id = officerId.trim();
  if (!id) {
    throw new RechercheEntreprisesApiError(
      "A person id (surname, or \"surname|first names\", from mode=search) is required.",
    );
  }
  const [surname, firstNames] = id.split("|");
  const params: Record<string, string> = { nom_personne: surname ?? id, per_page: "25", page: "1" };
  if (firstNames) params.prenoms_personne = firstNames;
  const results = await fetchResults(searchUrl(params), options);
  const targetSurname = normalizePersonName(surname ?? id);
  const targetFirst = firstNames ? normalizePersonName(firstNames) : undefined;
  const appointments: RecherchePersonAppointment[] = [];
  let personName: string | undefined;
  for (const result of results) {
    const companyName = asString(result.nom_complet);
    const siren = asString(result.siren);
    if (!companyName) continue;
    for (const raw of asArray(result.dirigeants)) {
      const dirigeant = parseDirigeant(asRecord(raw));
      if (!dirigeant) continue;
      const surnameNorm = normalizePersonName(dirigeant.nom);
      if (!surnameNorm.includes(targetSurname) && !targetSurname.includes(surnameNorm)) {
        continue;
      }
      if (targetFirst && dirigeant.prenoms) {
        const firstNorm = normalizePersonName(dirigeant.prenoms);
        if (!firstNorm.includes(targetFirst) && !targetFirst.includes(firstNorm)) continue;
      }
      if (!personName) {
        personName = [dirigeant.prenoms, cleanSurname(dirigeant.nom)].filter(Boolean).join(" ");
      }
      appointments.push({
        companyName,
        ...(siren ? { siren } : {}),
        ...(dirigeant.qualite ? { role: dirigeant.qualite } : {}),
        sourceUrl: siren ? companyUrl(siren) : searchUrl(params),
      });
      break;
    }
  }
  return {
    officerId: id,
    ...(personName ? { personName } : {}),
    appointments,
  };
}

export function createRechercheEntreprisesAdapter(options: AdapterOptions = {}) {
  return {
    search: (company: string) => searchRechercheEntreprises(company, options),
    searchPeople: (name: string) => searchRecherchePeople(name, options),
    getPersonAppointments: (officerId: string) =>
      getRecherchePersonAppointments(officerId, options),
  };
}
