import { beforeEach, describe, expect, test } from "bun:test";
import {
  collectJuristicIds,
  DBD_GDX_NAME_SEARCH_URL,
  DBD_OPENAPI_BASE_URL,
  DbdApiError,
  DbdConfigurationError,
  formatDbdCapital,
  formatDbdDate,
  isThaiJuristicId,
  resolveDbdCompany,
  searchDbdCompanies,
} from "../src/adapters/dbdThailand.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";

// Verbatim DBD responses recorded live from openapi.dbd.go.th (2026-08-29):
// PTT and CP All (both listed), plus the two documented empty envelopes.
const PTT = JSON.parse(loadFixture("dbd", "juristic-0107544000108.json"));
const CP_ALL = JSON.parse(loadFixture("dbd", "juristic-0107542000011.json"));
const NO_DATA = JSON.parse(loadFixture("dbd", "juristic-no-data.json"));
const BAD_FORMAT = JSON.parse(loadFixture("dbd", "juristic-bad-format.json"));

const KEYED: AdapterOptions["env"] = { DBD_API_KEY: "test-gdx-key" };

function options(
  fetchFn: ReturnType<typeof routedFetch>,
  env: AdapterOptions["env"] = {},
): AdapterOptions {
  return { fetchFn, env };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("dbdThailand helpers", () => {
  test("recognises 13-digit juristic numbers only", () => {
    expect(isThaiJuristicId("0107544000108")).toBe(true);
    expect(isThaiJuristicId("0107-544-000108")).toBe(true); // separators tolerated
    expect(isThaiJuristicId("010754400010")).toBe(false); // 12 digits
    expect(isThaiJuristicId("01075440001081")).toBe(false); // 14 digits
    expect(isThaiJuristicId("PTT PUBLIC COMPANY LIMITED")).toBe(false);
    expect(isThaiJuristicId("บริษัท ปตท. จำกัด (มหาชน)")).toBe(false);
  });

  test("formats YYYYMMDD register dates, folding Buddhist-era years", () => {
    expect(formatDbdDate("20011001")).toBe("2001-10-01");
    // Sibling DBD surfaces publish BE years; 2544 BE == 2001 CE.
    expect(formatDbdDate("25441001")).toBe("2001-10-01");
    expect(formatDbdDate("2001100")).toBeUndefined();
    expect(formatDbdDate("20010000")).toBeUndefined();
    expect(formatDbdDate(undefined)).toBeUndefined();
  });

  test("formats capital strings into grouped amounts", () => {
    expect(formatDbdCapital("28562996250.0")).toBe("28,562,996,250");
    expect(formatDbdCapital("1758223567.2")).toBe("1,758,223,567.2");
    expect(formatDbdCapital("not-a-number")).toBeUndefined();
    expect(formatDbdCapital(undefined)).toBeUndefined();
  });

  test("collects juristic ids from an arbitrarily-shaped GDX payload", () => {
    expect(
      collectJuristicIds({
        ResultList: [
          { JuristicID: "0107544000108", JuristicNameTH: "บริษัท ปตท." },
          { JuristicID: "0107542000011" },
        ],
      }),
    ).toEqual(["0107544000108", "0107542000011"]);
    // Non-id keys and malformed ids are ignored; duplicates collapse.
    expect(
      collectJuristicIds({
        ResultList: [
          { JuristicID: "0107544000108" },
          { JuristicID: "0107544000108" },
          { Capital: "9999999999999" },
          { JuristicID: "123" },
        ],
      }),
    ).toEqual(["0107544000108"]);
    expect(collectJuristicIds({ Message: "no results" })).toEqual([]);
  });
});

describe("searchDbdCompanies by juristic number (keyless)", () => {
  test("resolves a listed company with names, capital, TSIC and status", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000108", body: PTT },
    ]);
    const entity = await resolveDbdCompany("0107544000108", options(fetchFn));
    expect(entity?.juristicId).toBe("0107544000108");
    // English name leads; the Thai name is kept as an alias.
    expect(entity?.legalName).toBe("PTT PUBLIC COMPANY LIMITED");
    expect(entity?.legalNameTh).toBe("บริษัท ปตท. จำกัด (มหาชน)");
    expect(entity?.legalNameEn).toBe("PTT PUBLIC COMPANY LIMITED");
    expect(entity?.aliases).toEqual(["บริษัท ปตท. จำกัด (มหาชน)"]);
    expect(entity?.jurisdiction).toBe("TH");
    expect(entity?.source).toBe("DBD");
    expect(entity?.status).toBe("ยังดำเนินกิจการอยู่");
    expect(entity?.entityType).toBe("บริษัทมหาชนจำกัด");
    expect(entity?.incorporationDate).toBe("2001-10-01");
    expect(entity?.registeredCapital).toBe("28,562,996,250");
    expect(entity?.paidUpCapital).toBe("28,562,996,250");
    expect(entity?.tsicCode).toBe("71209");
    expect(entity?.tsicDescription).toContain("Other technical testing");
    expect(entity?.address).toContain("กรุงเทพมหานคร");
    expect(entity?.matchReason).toBe("Exact juristic-number match");
    expect(entity?.sourceIdentifiers?.juristicId).toBe("0107544000108");
    expect(entity?.sourceUrl).toBe(`${DBD_OPENAPI_BASE_URL}/0107544000108`);
  });

  test("does not need a key for a by-number lookup", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107542000011", body: CP_ALL },
    ]);
    const entity = await resolveDbdCompany("0107542000011", options(fetchFn));
    expect(entity?.legalName).toBe("CP ALL PUBLIC COMPANY LIMITED");
    expect(entity?.incorporationDate).toBe("1999-03-12");
    expect(entity?.tsicCode).toBe("56101");
    // No Consumer-Key header was sent on the keyless path.
    const headers = fetchFn.requests[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["Consumer-Key"]).toBeUndefined();
  });

  test("returns nothing on the documented no-data envelope", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000999", body: NO_DATA },
    ]);
    expect(await resolveDbdCompany("0107544000999", options(fetchFn))).toBeNull();
  });

  test("returns nothing on the documented bad-id-format envelope", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0000000000000", body: BAD_FORMAT },
    ]);
    expect(await resolveDbdCompany("0000000000000", options(fetchFn))).toBeNull();
  });

  test("does not hit the network for a blank query", async () => {
    const fetchFn = routedFetch([]);
    expect(await searchDbdCompanies("   ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("searchDbdCompanies by name (key-gated)", () => {
  // A representative GDX envelope. The gateway is key-gated, so ids extracted
  // from it are always re-resolved through the proven keyless by-id endpoint.
  const gdxResult = {
    ResultList: [
      { JuristicID: "0107544000108", JuristicStatus: "ยังดำเนินกิจการอยู่" },
      { JuristicID: "0107542000011", JuristicStatus: "ยังดำเนินกิจการอยู่" },
    ],
  };

  test("resolves an English name search through the keyless by-id endpoint", async () => {
    const fetchFn = routedFetch([
      { pattern: DBD_GDX_NAME_SEARCH_URL, body: gdxResult },
      { pattern: "juristic_person/0107544000108", body: PTT },
      { pattern: "juristic_person/0107542000011", body: CP_ALL },
    ]);
    const results = await searchDbdCompanies(
      "PTT PUBLIC COMPANY LIMITED",
      options(fetchFn, KEYED),
    );
    expect(results).toHaveLength(2);
    // Exact-name match ranks first, ahead of the other GDX hit.
    expect(results[0]?.legalName).toBe("PTT PUBLIC COMPANY LIMITED");
    expect(results[0]?.matchReason).toBe("Exact normalized legal-name match");
    expect(results[0]?.registeredCapital).toBe("28,562,996,250");
    // The key travels as the GDX Consumer-Key header on the search request.
    const headers = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    expect(headers["Consumer-Key"]).toBe("test-gdx-key");
    expect(fetchFn.requests[0]?.url).toContain("Name=PTT+PUBLIC+COMPANY+LIMITED");
  });

  test("ranks a Thai-script name search via the alias", async () => {
    const fetchFn = routedFetch([
      { pattern: DBD_GDX_NAME_SEARCH_URL, body: gdxResult },
      { pattern: "juristic_person/0107544000108", body: PTT },
      { pattern: "juristic_person/0107542000011", body: CP_ALL },
    ]);
    const results = await searchDbdCompanies(
      "บริษัท ปตท. จำกัด (มหาชน)",
      options(fetchFn, KEYED),
    );
    expect(results[0]?.legalNameTh).toBe("บริษัท ปตท. จำกัด (มหาชน)");
    expect(results[0]?.matchReason).toBe("Exact normalized alias match");
    // The Thai query is percent-encoded and round-trips as UTF-8 (spaces
    // travel as "+" per application/x-www-form-urlencoded).
    const sent = new URL(fetchFn.requests[0]?.url ?? "");
    expect(sent.searchParams.get("Name")).toBe("บริษัท ปตท. จำกัด (มหาชน)");
  });

  test("returns empty when the name search yields no juristic ids", async () => {
    const fetchFn = routedFetch([
      { pattern: DBD_GDX_NAME_SEARCH_URL, body: { ResultList: [] } },
    ]);
    expect(
      await searchDbdCompanies("Nonexistent Co", options(fetchFn, KEYED)),
    ).toHaveLength(0);
  });

  test("drops a candidate whose re-resolve fails without sinking the list", async () => {
    const fetchFn = routedFetch([
      { pattern: DBD_GDX_NAME_SEARCH_URL, body: gdxResult },
      { pattern: "juristic_person/0107544000108", body: PTT },
      { pattern: "juristic_person/0107542000011", body: "boom", status: 500 },
    ]);
    const results = await searchDbdCompanies("PTT", options(fetchFn, KEYED));
    expect(results).toHaveLength(1);
    expect(results[0]?.juristicId).toBe("0107544000108");
  });
});

describe("key gating", () => {
  test("a name search without DBD_API_KEY names the variable and never calls out", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      searchDbdCompanies("PTT PUBLIC COMPANY LIMITED", options(fetchFn)),
    ).rejects.toBeInstanceOf(DbdConfigurationError);
    await expect(
      searchDbdCompanies("PTT PUBLIC COMPANY LIMITED", options(fetchFn)),
    ).rejects.toThrow(/DBD_API_KEY/);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("a rejected key is reported as a configuration problem", async () => {
    const fetchFn = routedFetch([
      {
        pattern: DBD_GDX_NAME_SEARCH_URL,
        body: { Message: "UnauthorizedException: token not found" },
        status: 401,
      },
    ]);
    await expect(
      searchDbdCompanies("PTT", options(fetchFn, KEYED)),
    ).rejects.toBeInstanceOf(DbdConfigurationError);
  });
});

describe("failures", () => {
  test("raises on an undocumented failure envelope", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "juristic_person/0107544000108",
        body: { status: { code: "9999", description: "Service unavailable" }, data: [] },
      },
    ]);
    await expect(
      resolveDbdCompany("0107544000108", options(fetchFn)),
    ).rejects.toBeInstanceOf(DbdApiError);
  });

  test("propagates an upstream HTTP error", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000108", body: "boom", status: 500 },
    ]);
    await expect(
      resolveDbdCompany("0107544000108", options(fetchFn)),
    ).rejects.toThrow();
  });

  test("treats a 404 on the by-id path as no such juristic person", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000108", body: "nope", status: 404 },
    ]);
    expect(await resolveDbdCompany("0107544000108", options(fetchFn))).toBeNull();
  });
});
