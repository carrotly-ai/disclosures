import { beforeEach, describe, expect, test } from "bun:test";
import {
  ACRA_CONSOLIDATED_RESOURCE,
  ACRA_LETTER_RESOURCES,
  ACRA_OTHERS_RESOURCE,
  AcraApiError,
  isSingaporeUen,
  resolveAcraCompany,
  resourceForName,
  searchAcraCompanies,
} from "../src/adapters/acraSg.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

function datastore(records: Record<string, unknown>[]): Record<string, unknown> {
  return { success: true, result: { total: records.length, records } };
}

const SIA_RICH = {
  uen: "197200078R",
  entity_name: "SINGAPORE AIRLINES LIMITED",
  entity_type_description: "Local Company",
  company_type_description: "Public Company Limited by Shares",
  entity_status_description: "Live Company",
  registration_incorporation_date: "1972-01-28",
  primary_ssic_code: "51000",
  primary_ssic_description: "PASSENGER AIR TRANSPORT",
  former_entity_name1: "MALAYSIA-SINGAPORE AIRLINES",
  former_entity_name2: "na",
  name_of_audit_firm1: "KPMG LLP",
  no_of_officers: "12",
};

const OTHER_S = {
  uen: "199900001A",
  entity_name: "SINGTEL VENTURES",
  entity_status_description: "Live Company",
  registration_incorporation_date: "1999-02-02",
};

beforeEach(() => {
  resetRateLimiters();
});

describe("acraSg helpers", () => {
  test("recognises Singapore UEN formats", () => {
    expect(isSingaporeUen("197200078R")).toBe(true); // ROC 10-char
    expect(isSingaporeUen("53312345A")).toBe(true); // ROB 9-char
    expect(isSingaporeUen("T05LL1103B")).toBe(true); // new UEN
    expect(isSingaporeUen("SINGAPORE AIRLINES")).toBe(false);
    expect(isSingaporeUen("700")).toBe(false);
  });

  test("routes a name to its alphabet-split resource by first letter", () => {
    expect(resourceForName("SINGAPORE AIRLINES")).toBe(ACRA_LETTER_RESOURCES.S);
    expect(resourceForName("apple")).toBe(ACRA_LETTER_RESOURCES.A);
    expect(resourceForName("3M SINGAPORE")).toBe(ACRA_OTHERS_RESOURCE);
    expect(Object.keys(ACRA_LETTER_RESOURCES)).toHaveLength(26);
  });
});

describe("searchAcraCompanies by name", () => {
  test("queries the first-letter dataset and ranks + surfaces former names", async () => {
    const fetchFn = routedFetch([
      { pattern: ACRA_LETTER_RESOURCES.S, body: datastore([OTHER_S, SIA_RICH]) },
    ]);
    const results = await searchAcraCompanies("SINGAPORE AIRLINES LIMITED", options(fetchFn));
    const sia = results.find((r) => r.uen === "197200078R");
    expect(sia?.legalName).toBe("SINGAPORE AIRLINES LIMITED");
    expect(sia?.jurisdiction).toBe("SG");
    expect(sia?.source).toBe("ACRA");
    expect(sia?.status).toBe("Live Company");
    expect(sia?.incorporationDate).toBe("1972-01-28");
    expect(sia?.formerNames).toEqual(["MALAYSIA-SINGAPORE AIRLINES"]); // "na" dropped
    expect(sia?.aliases).toContain("MALAYSIA-SINGAPORE AIRLINES");
    expect(sia?.auditFirms).toEqual(["KPMG LLP"]);
    expect(sia?.ssicDescription).toBe("PASSENGER AIR TRANSPORT");
    expect(sia?.sourceIdentifiers?.uen).toBe("197200078R");
    // Routed to the 'S' dataset only.
    expect(fetchFn.requests[0]?.url).toContain(ACRA_LETTER_RESOURCES.S);
  });

  test("returns empty when the dataset yields no records", async () => {
    const fetchFn = routedFetch([
      { pattern: ACRA_LETTER_RESOURCES.Q, body: datastore([]) },
    ]);
    expect(await searchAcraCompanies("Quux Holdings", options(fetchFn))).toHaveLength(0);
  });

  test("does not hit the network for a blank query", async () => {
    const fetchFn = routedFetch([]);
    expect(await searchAcraCompanies("   ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("searchAcraCompanies by UEN", () => {
  test("routes UEN via the consolidated dataset then fetches the rich record", async () => {
    const consolidated = {
      uen: "197200078R",
      entity_name: "SINGAPORE AIRLINES LIMITED",
      uen_status_desc: "Registered",
      entity_type_desc: "Local Company",
    };
    const fetchFn = routedFetch([
      { pattern: ACRA_CONSOLIDATED_RESOURCE, body: datastore([consolidated]) },
      { pattern: ACRA_LETTER_RESOURCES.S, body: datastore([SIA_RICH]) },
    ]);
    const result = await resolveAcraCompany("197200078R", options(fetchFn));
    expect(result?.legalName).toBe("SINGAPORE AIRLINES LIMITED");
    expect(result?.matchReason).toBe("Exact UEN match");
    // Rich record won: former names present.
    expect(result?.formerNames).toEqual(["MALAYSIA-SINGAPORE AIRLINES"]);
    // Two requests: consolidated first, then the 'S' letter dataset.
    expect(fetchFn.requests[0]?.url).toContain(ACRA_CONSOLIDATED_RESOURCE);
    expect(fetchFn.requests[1]?.url).toContain(ACRA_LETTER_RESOURCES.S);
  });

  test("falls back to the consolidated record when the letter dataset misses", async () => {
    const consolidated = {
      uen: "53312345A",
      entity_name: "ACME TRADING",
      uen_status_desc: "Registered",
    };
    const fetchFn = routedFetch([
      { pattern: ACRA_CONSOLIDATED_RESOURCE, body: datastore([consolidated]) },
      { pattern: ACRA_LETTER_RESOURCES.A, body: datastore([]) },
    ]);
    const result = await resolveAcraCompany("53312345A", options(fetchFn));
    expect(result?.legalName).toBe("ACME TRADING");
    expect(result?.status).toBe("Registered");
    expect(result?.formerNames).toEqual([]);
  });

  test("returns empty when the UEN is not found in the consolidated dataset", async () => {
    const fetchFn = routedFetch([
      { pattern: ACRA_CONSOLIDATED_RESOURCE, body: datastore([]) },
    ]);
    expect(await resolveAcraCompany("197200078R", options(fetchFn))).toBeNull();
  });
});

describe("failures", () => {
  test("throws on a datastore failure envelope", async () => {
    const fetchFn = routedFetch([
      { pattern: ACRA_LETTER_RESOURCES.A, body: { success: false, error: {} } },
    ]);
    await expect(searchAcraCompanies("Apple", options(fetchFn))).rejects.toBeInstanceOf(
      AcraApiError,
    );
  });

  test("propagates an upstream HTTP error", async () => {
    const fetchFn = routedFetch([
      { pattern: ACRA_LETTER_RESOURCES.A, body: "boom", status: 500 },
    ]);
    await expect(searchAcraCompanies("Apple", options(fetchFn))).rejects.toThrow();
  });
});
