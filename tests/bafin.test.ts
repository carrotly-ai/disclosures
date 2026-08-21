import { beforeEach, describe, expect, test } from "bun:test";
import {
  BAFIN_ANTEILE_ISSUER_URL,
  BAFIN_ANTEILE_SEARCH_URL,
  BAFIN_DEALINGS_RESULT_URL,
  BAFIN_DEALINGS_SEARCH_URL,
  BafinRateLimitError,
  getBafinDirectorsDealings,
  getBafinOwners,
  getBafinPersonAppointments,
  parseDealings,
  parseGermanDate,
  parseGermanNumber,
  parseIssuerHoldings,
  parsePersonSearch,
  parseTableById,
  repairGermanText,
  searchBafinCompanies,
  searchBafinPeople,
} from "../src/adapters/bafin.js";
import { bafinRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

const anteileSearch = loadFixture("bafin", "anteile-search-sap.html");
const anteileIssuer = loadFixture("bafin", "anteile-issuer-sap.html");
const dealings = loadFixture("bafin", "dealings-sap.html");
const dealingsMojibake = loadFixture("bafin", "dealings-sap-mojibake.html");
const personSearch = loadFixture("bafin", "dealings-person-search.html");
const personAppointments = loadFixture("bafin", "dealings-person-appointments.html");

const searchRoute: Route = { pattern: BAFIN_ANTEILE_SEARCH_URL, body: anteileSearch };
const issuerRoute: Route = { pattern: BAFIN_ANTEILE_ISSUER_URL, body: anteileIssuer };
const dealingsRoute: Route = { pattern: BAFIN_DEALINGS_SEARCH_URL, body: dealings };

beforeEach(() => {
  resetRateLimiters();
});

describe("German text helpers", () => {
  test("repairGermanText fixes double-encoded UTF-8 only when marker present", () => {
    expect(repairGermanText("GeschÃ¤fts")).toBe("Geschäfts");
    expect(repairGermanText("JÃ¼rgen MÃ¼ller")).toBe("Jürgen Müller");
    expect(repairGermanText("auÃŸerhalb")).toBe("außerhalb");
    // Correct UTF-8 is a no-op.
    expect(repairGermanText("Jürgen Müller")).toBe("Jürgen Müller");
    expect(repairGermanText("BlackRock, Inc.")).toBe("BlackRock, Inc.");
  });

  test("parseGermanDate converts dd.mm.yyyy to ISO", () => {
    expect(parseGermanDate("15.05.2024")).toBe("2024-05-15");
    expect(parseGermanDate("2.3.2023")).toBe("2023-03-02");
    expect(parseGermanDate("2024-05-15")).toBe("2024-05-15");
    expect(parseGermanDate("")).toBeUndefined();
    expect(parseGermanDate(undefined)).toBeUndefined();
  });

  test("parseGermanNumber handles comma decimal and thousands dot", () => {
    expect(parseGermanNumber("5,0254")).toBeCloseTo(5.0254, 4);
    expect(parseGermanNumber("1.234,5")).toBeCloseTo(1234.5, 1);
    expect(parseGermanNumber("3,1002")).toBeCloseTo(3.1002, 4);
    expect(parseGermanNumber("-")).toBeUndefined();
    expect(parseGermanNumber("")).toBeUndefined();
  });
});

describe("displaytag table parser", () => {
  test("parseTableById finds a table by id and reads header-anchored cells", () => {
    const table = parseTableById(anteileIssuer, "geschaeft");
    expect(table).toBeDefined();
    expect(table?.rows.length).toBe(3);
    // The raw name cell still carries BaFin's "[+]" subsidiary expander token;
    // stripExpander removes it downstream in parseIssuerHoldings.
    expect(table?.rows[0]?.[1]?.text).toContain("BlackRock, Inc.");
    expect(table?.rows[0]?.[1]?.href).toContain("id=122404");
  });

  test("nested tables do not truncate extraction early", () => {
    const html =
      '<table id="outer"><tr><td><table id="inner"><tr><td>x</td></tr>' +
      "</table></td></tr><tr><td>after</td></tr></table>";
    const table = parseTableById(html, "outer");
    // Two body rows survive: the one wrapping the inner table, and "after".
    expect(table?.rows.some((row) => row.some((cell) => cell.text === "after")))
      .toBe(true);
  });
});

describe("searchBafinCompanies", () => {
  test("name search ranks the exact issuer first with its BaFin-Id", async () => {
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchBafinCompanies("SAP SE", options(fetchFn));
    expect(results[0]?.legalName).toBe("SAP SE");
    expect(results[0]?.bafinId).toBe("40001244");
    expect(results[0]?.jurisdiction).toBe("DE");
    expect(results[0]?.source).toBe("BaFin");
    expect(results[0]?.sourceUrl).toContain("id=40001244");
  });

  test("a bare BaFin-Id resolves directly without a search request", async () => {
    const fetchFn = routedFetch([]);
    const results = await searchBafinCompanies("40001244", options(fetchFn));
    expect(results.length).toBe(1);
    expect(results[0]?.bafinId).toBe("40001244");
    expect(fetchFn.requests.length).toBe(0);
  });

  test("unmatched requests never reach the network", async () => {
    const fetchFn = routedFetch([]);
    await expect(searchBafinCompanies("SAP SE", options(fetchFn))).rejects.toThrow(
      /Unexpected network request/,
    );
  });

  test("an injected fetchFn wins over the lenient node path (issue #42)", async () => {
    // BaFin reads through a lenient node:https path only when NO fetchFn is
    // injected (#42). With a stub supplied, every page fetch must go through
    // the stub — proved here by the stub receiving the request and the parse
    // succeeding without any real network access.
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchBafinCompanies("SAP SE", options(fetchFn));
    expect(results.length).toBeGreaterThan(0);
    expect(fetchFn.requests.length).toBe(1);
    expect(fetchFn.requests[0]?.url).toContain("suche.do");
  });
});

describe("getBafinOwners", () => {
  test("parses §§33/34, §38 and §39 holdings for a resolved issuer", async () => {
    const fetchFn = routedFetch([searchRoute, issuerRoute]);
    const owners = await getBafinOwners("SAP SE", options(fetchFn));
    expect(owners.length).toBe(3);
    const blackrock = owners[0];
    expect(blackrock?.holderName).toBe("BlackRock, Inc.");
    expect(blackrock?.pct).toBeCloseTo(5.0254, 4);
    expect(blackrock?.notifiedDate).toBe("2024-05-15");
    expect(blackrock?.naturesOfControl).toEqual([
      "§38 instruments: 0.8912%",
      "§39 aggregate: 5.9166%",
    ]);
    expect(blackrock?.thresholdRegime).toContain("WpHG");
    expect(blackrock?.sourceUrl).toContain("zeigeGeschaeft");
  });

  test("a bare BaFin-Id skips the search and reads holdings directly", async () => {
    const fetchFn = routedFetch([issuerRoute]);
    const owners = await getBafinOwners("40001244", options(fetchFn));
    expect(owners.length).toBe(3);
    expect(fetchFn.requests.every(({ url }) => url.includes("aktiengesellschaft.do")))
      .toBe(true);
  });

  test("a holder with no §38 instruments omits that breakdown line", async () => {
    const fetchFn = routedFetch([issuerRoute]);
    const owners = await getBafinOwners("40001244", options(fetchFn));
    const vanguard = owners.find((owner) => owner.holderName.includes("Vanguard"));
    expect(vanguard?.naturesOfControl).toEqual(["§39 aggregate: 3.1002%"]);
  });
});

describe("getBafinDirectorsDealings", () => {
  test("parses and translates directors' dealings, newest first", async () => {
    const fetchFn = routedFetch([dealingsRoute]);
    const insiders = await getBafinDirectorsDealings("SAP SE", options(fetchFn));
    expect(insiders.length).toBe(2);
    const first = insiders[0];
    expect(first?.name).toBe("Jürgen Müller");
    expect(first?.roles).toEqual(["Management board (Vorstand)"]);
    expect(first?.occupation).toBe("Share (Aktie)");
    expect(first?.form).toBe("Buy (Kauf)");
    expect(first?.notifiedDate).toBe("2024-06-12");
    expect(first?.filedDate).toBe("2024-06-14");
    expect(first?.sourceIdentifiers?.isin).toBe("DE0007164600");
    // Sorted newest-first by activation date.
    expect(insiders[1]?.name).toBe("Pekka Ala-Pietilä");
    expect(insiders[1]?.roles).toEqual(["Supervisory board (Aufsichtsrat)"]);
    expect(insiders[1]?.form).toBe("Sell (Verkauf)");
  });

  test("repairs double-encoded UTF-8 in scraped cells", async () => {
    const fetchFn = routedFetch([
      { pattern: BAFIN_DEALINGS_SEARCH_URL, body: dealingsMojibake },
    ]);
    const insiders = await getBafinDirectorsDealings("SAP SE", options(fetchFn));
    expect(insiders[0]?.name).toBe("Jürgen Müller");
    expect(insiders[0]?.status).toBe("außerhalb eines Handelsplatzes");
    expect(insiders[0]?.form).toBe("Buy (Kauf)");
  });
});

describe("parse helpers operate directly on fixture HTML", () => {
  test("parseIssuerHoldings reads the geschaeft table", () => {
    const holdings = parseIssuerHoldings(anteileIssuer, BAFIN_ANTEILE_ISSUER_URL);
    expect(holdings.length).toBe(3);
    expect(holdings[2]?.holderName).toBe("Deutsche Bank Aktiengesellschaft");
    expect(holdings[2]?.pctVotingRights).toBeCloseTo(2.9987, 4);
  });

  test("parseDealings reads the emittent table", () => {
    const rows = parseDealings(dealings, BAFIN_DEALINGS_SEARCH_URL);
    expect(rows.length).toBe(2);
    expect(rows[0]?.person).toBe("Jürgen Müller");
    expect(rows[0]?.isin).toBe("DE0007164600");
    expect(rows[0]?.bafinId).toBe("40001244");
  });

  test("parsePersonSearch reads the meldepflichtiger table", () => {
    const matches = parsePersonSearch(personSearch);
    expect(matches.length).toBe(2);
    expect(matches[0]?.surname).toBe("Klein");
    expect(matches[0]?.firstName).toBe("Christian Kurt");
    expect(matches[0]?.meldepflichtigerId).toBe("34505");
    expect(matches[0]?.position).toBe("Management board (Vorstand)");
    expect(matches[0]?.latestTransactionDate).toBe("2026-07-24");
    expect(matches[1]?.title).toBe("Dr.");
    expect(matches[1]?.position).toBe("Supervisory board (Aufsichtsrat)");
  });
});

describe("BaFin DealingsInfo person index", () => {
  test("searchBafinPeople returns candidates with a meldepflichtigerId", async () => {
    const fetchFn = routedFetch([
      { pattern: "meldepflichtigerName=", body: personSearch },
    ]);
    const matches = await searchBafinPeople("Klein", options(fetchFn));
    expect(matches.length).toBe(2);
    expect(matches[0]?.surname).toBe("Klein");
    expect(matches[0]?.sourceUrl).toContain("meldepflichtigerId=34505");
  });

  test("getBafinPersonAppointments collapses transactions to one row per issuer", async () => {
    const fetchFn = routedFetch([
      { pattern: BAFIN_DEALINGS_RESULT_URL, body: personAppointments },
    ]);
    const record = await getBafinPersonAppointments("34505", options(fetchFn));
    expect(record.meldepflichtigerId).toBe("34505");
    expect(record.personName).toBe("Klein, Christian Kurt");
    // Three transactions, two distinct issuers (SAP SE x2, SAP Fioneer x1).
    expect(record.appointments.length).toBe(2);
    const sap = record.appointments.find((a) => a.bafinId === "40001244");
    expect(sap?.issuerName).toBe("SAP SE");
    expect(sap?.transactionCount).toBe(2);
    expect(sap?.position).toBe("Management board (Vorstand)");
    // Latest of 2026-07-24 / 2025-03-15.
    expect(sap?.latestTransactionDate).toBe("2026-07-24");
    // Sorted newest-issuer first.
    expect(record.appointments[0]?.bafinId).toBe("40001244");
    expect(record.appointments[1]?.issuerName).toBe("SAP Fioneer GmbH");
    expect(record.appointments[1]?.position).toBe("Supervisory board (Aufsichtsrat)");
  });

  test("getBafinPersonAppointments rejects a non-numeric id before any request", async () => {
    const fetchFn = routedFetch([]);
    await expect(getBafinPersonAppointments("abc", options(fetchFn))).rejects.toThrow(
      /meldepflichtigerId/,
    );
    expect(fetchFn.requests.length).toBe(0);
  });
});

describe("rate limiting", () => {
  test("a saturated window raises BafinRateLimitError", async () => {
    for (let i = 0; i < 60; i += 1) bafinRateLimiter.tryAcquire();
    const fetchFn = routedFetch([searchRoute]);
    await expect(searchBafinCompanies("SAP SE", options(fetchFn))).rejects.toThrow(
      BafinRateLimitError,
    );
  });
});
