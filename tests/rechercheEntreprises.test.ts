import { beforeEach, describe, expect, test } from "bun:test";
import {
  RechercheEntreprisesApiError,
  RechercheEntreprisesRateLimitError,
  getRecherchePersonAppointments,
  searchRechercheEntreprises,
  searchRecherchePeople,
} from "../src/adapters/rechercheEntreprises.js";
import {
  rechercheEntreprisesRateLimiter,
  resetRateLimiters,
} from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

const companyResult = {
  total_results: 632,
  results: [
    {
      nom_complet: "TOTALENERGIES MARKETING FRANCE",
      siren: "531680445",
      siege: { libelle_commune: "PUTEAUX" },
      dirigeants: [
        {
          nom: "LARROQUE",
          prenoms: "GUILLAUME",
          annee_de_naissance: "1971",
          qualite: "Président de SAS",
          type_dirigeant: "personne physique",
        },
      ],
    },
  ],
};

const sirenResult = {
  total_results: 1,
  results: [
    { nom_complet: "TOTALENERGIES SE", siren: "542051180", siege: { libelle_commune: "COURBEVOIE" } },
  ],
};

const personResult = {
  total_results: 189,
  results: [
    {
      nom_complet: "PR2",
      siren: "751343807",
      dirigeants: [
        {
          nom: "POUYANNE (POUYANNE)",
          prenoms: "CHRISTIAN GEORGES",
          annee_de_naissance: "1954",
          qualite: "Gérant",
          type_dirigeant: "personne physique",
        },
      ],
    },
    {
      nom_complet: "TOTALENERGIES SE",
      siren: "542051180",
      dirigeants: [
        {
          nom: "POUYANNE",
          prenoms: "PATRICK",
          annee_de_naissance: "1963",
          qualite: "Président",
          type_dirigeant: "personne physique",
        },
        {
          denomination: "KPMG SA",
          qualite: "Commissaire aux comptes titulaire",
          type_dirigeant: "personne morale",
        },
      ],
    },
  ],
};

const companyRoute: Route = { pattern: "q=", body: companyResult };
const personRoute: Route = { pattern: "nom_personne", body: personResult };

beforeEach(() => {
  resetRateLimiters();
});

describe("searchRechercheEntreprises", () => {
  test("resolves a company name to a SIREN-keyed entity", async () => {
    const fetchFn = routedFetch([companyRoute]);
    const results = await searchRechercheEntreprises("TotalEnergies", options(fetchFn));
    expect(results.length).toBe(1);
    expect(results[0]?.legalName).toBe("TOTALENERGIES MARKETING FRANCE");
    expect(results[0]?.siren).toBe("531680445");
    expect(results[0]?.jurisdiction).toBe("FR");
    expect(results[0]?.source).toBe("recherche-entreprises");
    expect(results[0]?.sourceIdentifiers?.siren).toBe("531680445");
    expect(results[0]?.sourceUrl).toContain("531680445");
  });

  test("a bare 9-digit SIREN resolves via the q parameter", async () => {
    const fetchFn = routedFetch([{ pattern: "q=542051180", body: sirenResult }]);
    const results = await searchRechercheEntreprises("542051180", options(fetchFn));
    expect(results[0]?.siren).toBe("542051180");
    expect(results[0]?.matchReason).toBe("SIREN match");
  });

  test("empty upstream returns no candidates", async () => {
    const fetchFn = routedFetch([{ pattern: "q=", body: { total_results: 0, results: [] } }]);
    expect(await searchRechercheEntreprises("Nonexistent SA", options(fetchFn))).toEqual([]);
  });
});

describe("searchRecherchePeople", () => {
  test("collapses dirigeant hits to distinct persons and excludes personne morale", async () => {
    const fetchFn = routedFetch([personRoute]);
    const matches = await searchRecherchePeople("Pouyanne", options(fetchFn));
    // Two distinct natural persons named Pouyanne; the corporate auditor (KPMG)
    // is excluded.
    expect(matches.length).toBe(2);
    const patrick = matches.find((m) => m.firstNames === "PATRICK");
    expect(patrick?.officerId).toBe("POUYANNE|PATRICK");
    expect(patrick?.surname).toBe("POUYANNE");
    expect(patrick?.birthYear).toBe("1963");
    expect(patrick?.role).toBe("Président");
    expect(patrick?.sampleCompany).toBe("TOTALENERGIES SE");
    expect(matches.some((m) => m.name.includes("KPMG"))).toBe(false);
    // The name query hit nom_personne, not q.
    expect(fetchFn.requests[0]?.url).toContain("nom_personne=Pouyanne");
  });

  test("empty upstream returns no matches", async () => {
    const fetchFn = routedFetch([{ pattern: "nom_personne", body: { total_results: 0, results: [] } }]);
    expect(await searchRecherchePeople("Nobody", options(fetchFn))).toEqual([]);
  });
});

describe("getRecherchePersonAppointments", () => {
  test("lists companies for a person id, narrowing by first names (homonym-aware)", async () => {
    const fetchFn = routedFetch([personRoute]);
    const record = await getRecherchePersonAppointments("POUYANNE|PATRICK", options(fetchFn));
    expect(record.personName).toBe("PATRICK POUYANNE");
    // Only the company where the Patrick homonym is a dirigeant, not the
    // Christian Georges one.
    expect(record.appointments.length).toBe(1);
    expect(record.appointments[0]?.companyName).toBe("TOTALENERGIES SE");
    expect(record.appointments[0]?.siren).toBe("542051180");
    expect(record.appointments[0]?.role).toBe("Président");
    // The first-name filter is pushed to the API.
    const url = fetchFn.requests[0]?.url ?? "";
    expect(url).toContain("nom_personne=POUYANNE");
    expect(url).toContain("prenoms_personne=PATRICK");
  });

  test("a surname-only id lists every homonym's company", async () => {
    const fetchFn = routedFetch([personRoute]);
    const record = await getRecherchePersonAppointments("POUYANNE", options(fetchFn));
    expect(record.appointments.length).toBe(2);
  });

  test("a blank id is rejected before any request", async () => {
    const fetchFn = routedFetch([]);
    await expect(getRecherchePersonAppointments("  ", options(fetchFn))).rejects.toThrow(
      RechercheEntreprisesApiError,
    );
    expect(fetchFn.requests.length).toBe(0);
  });
});

describe("failure and rate limiting", () => {
  test("an upstream 503 propagates", async () => {
    const fetchFn = routedFetch([{ pattern: "q=", body: "down", status: 503 }]);
    await expect(searchRechercheEntreprises("Total", options(fetchFn))).rejects.toThrow();
  });

  test("a saturated 7-req/s window raises the rate-limit error", async () => {
    for (let i = 0; i < 7; i += 1) rechercheEntreprisesRateLimiter.tryAcquire();
    const fetchFn = routedFetch([companyRoute]);
    await expect(searchRechercheEntreprises("Total", options(fetchFn))).rejects.toThrow(
      RechercheEntreprisesRateLimitError,
    );
  });
});
