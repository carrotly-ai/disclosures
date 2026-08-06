import { beforeEach, describe, expect, test } from "bun:test";
import {
  getIsinsForLei,
  getOwnershipChain,
  isIsin,
  isLei,
  resolveGleifEntity,
  resolveLeiByIsin,
  searchGleifEntities,
} from "../src/adapters/gleif.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { routedFetch } from "./helpers/routedFetch.js";

const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";
const APPLE_INDIA_LEI = "335800FVH4MOKZS9VH40";
const PARENT_LEI = "HWUPKR0MPOU8FGXBT394";

function leiRecord(
  lei: string,
  legalName: string,
  extras: {
    jurisdiction?: string;
    status?: string;
    otherNames?: string[];
    relationships?: Record<string, { links: Record<string, string> }>;
  } = {},
): Record<string, unknown> {
  return {
    type: "lei-records",
    id: lei,
    attributes: {
      lei,
      entity: {
        legalName: { name: legalName, language: "en" },
        otherNames: (extras.otherNames ?? []).map((name) => ({ name, type: "TRADING_OR_OPERATING_NAME" })),
        transliteratedOtherNames: [],
        jurisdiction: extras.jurisdiction ?? "US",
        status: extras.status ?? "ACTIVE",
      },
      registration: { status: "ISSUED" },
    },
    relationships: extras.relationships ?? {},
    links: { self: `https://api.gleif.org/api/v1/lei-records/${lei}` },
  };
}

function collection(
  data: Array<Record<string, unknown>>,
  extras: { next?: string; goldenCopy?: string } = {},
): Record<string, unknown> {
  return {
    meta: {
      ...(extras.goldenCopy ? { goldenCopy: { publishDate: extras.goldenCopy } } : {}),
      pagination: { currentPage: 1, perPage: 100, total: data.length },
    },
    links: extras.next ? { next: extras.next } : {},
    data,
  };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("isLei", () => {
  test("accepts well-formed 20-character LEIs and rejects everything else", () => {
    expect(isLei(APPLE_LEI)).toBe(true);
    expect(isLei(`  ${APPLE_LEI.toLowerCase()}  `)).toBe(true);
    expect(isLei("AAPL")).toBe(false);
    expect(isLei("HWUPKR0MPOU8FGXBT39")).toBe(false); // 19 chars
    expect(isLei("HWUPKR0MPOU8FGXBT39XX")).toBe(false); // 21 chars
    expect(isLei("HWUPKR0MPOU8FGXBT3AA")).toBe(false); // non-digit checksum chars
  });
});

describe("isIsin", () => {
  test("accepts valid ISINs (check digit included) and rejects the rest", () => {
    expect(isIsin("US0378331005")).toBe(true); // Apple
    expect(isIsin("US5949181045")).toBe(true); // Microsoft
    expect(isIsin("GB0002634946")).toBe(true); // BAE Systems
    expect(isIsin("  us0378331005  ")).toBe(true); // trimmed + upcased
    expect(isIsin("US0378331004")).toBe(false); // wrong check digit
    expect(isIsin("0378331005US")).toBe(false); // wrong shape
    expect(isIsin("US037833100")).toBe(false); // too short
    expect(isIsin("AAPL")).toBe(false); // ticker
    expect(isIsin("HWUPKR0MPOU8FGXBT394")).toBe(false); // an LEI, not an ISIN
  });
});

describe("resolveLeiByIsin", () => {
  test("resolves an ISIN to its issuer's LEI record via filter[isin]", async () => {
    const fetchFn = routedFetch([
      { pattern: "filter%5Bisin%5D=US0378331005", body: collection([leiRecord(APPLE_LEI, "APPLE INC.")]) },
    ]);
    const entity = await resolveLeiByIsin("US0378331005", { fetchFn });
    expect(entity?.lei).toBe(APPLE_LEI);
    expect(entity?.isin).toBe("US0378331005");
    expect(entity?.matchReason).toContain("ISIN US0378331005");
    expect(fetchFn.requests[0]?.url).toContain("filter%5Bisin%5D=");
  });

  test("returns null when GLEIF maps no LEI to the ISIN", async () => {
    const fetchFn = routedFetch([{ pattern: "filter%5Bisin%5D", body: collection([]) }]);
    expect(await resolveLeiByIsin("US0378331005", { fetchFn })).toBeNull();
  });

  test("rejects a non-ISIN without any network call", async () => {
    const fetchFn = routedFetch([]);
    expect(await resolveLeiByIsin("not-an-isin", { fetchFn })).toBeNull();
    expect(fetchFn.requests.length).toBe(0);
  });
});

describe("getIsinsForLei", () => {
  function isinPage(isins: string[], next?: string): Record<string, unknown> {
    return {
      meta: { pagination: { currentPage: 1, perPage: isins.length, total: isins.length } },
      links: next ? { next } : {},
      data: isins.map((isin) => ({ type: "isins", id: isin, attributes: { lei: APPLE_LEI, isin } })),
    };
  }

  test("collects ISINs across paginated /isins responses", async () => {
    const page2 = `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/isins?page%5Bnumber%5D=2`;
    const fetchFn = routedFetch([
      { pattern: "isins?page%5Bnumber%5D=2", body: isinPage(["US03785C7G70"]) },
      { pattern: "/isins", body: isinPage(["US0378331005"], page2) },
    ]);
    const isins = await getIsinsForLei(APPLE_LEI, { fetchFn });
    expect(isins).toEqual(["US0378331005", "US03785C7G70"]);
  });

  test("respects the page cap", async () => {
    const loop = `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/isins?page%5Bnumber%5D=9`;
    const fetchFn = routedFetch([{ pattern: "/isins", body: isinPage(["US0378331005"], loop) }]);
    const isins = await getIsinsForLei(APPLE_LEI, { fetchFn }, { maxPages: 2 });
    expect(isins).toEqual(["US0378331005"]);
    expect(fetchFn.requests.length).toBe(2);
  });

  test("returns an empty list on a 404 and never calls out for a non-LEI", async () => {
    const notFound = routedFetch([{ pattern: "/isins", body: { errors: [] }, status: 404 }]);
    expect(await getIsinsForLei(APPLE_LEI, { fetchFn: notFound })).toEqual([]);
    const idle = routedFetch([]);
    expect(await getIsinsForLei("AAPL", { fetchFn: idle })).toEqual([]);
    expect(idle.requests.length).toBe(0);
  });
});

describe("resolveGleifEntity", () => {
  test("resolves an LEI via filter[lei] and marks the exact match", async () => {
    const fetchFn = routedFetch([
      { pattern: `filter%5Blei%5D=${APPLE_LEI}`, body: collection([leiRecord(APPLE_LEI, "APPLE INC.")]) },
    ]);
    const entity = await resolveGleifEntity(APPLE_LEI, { fetchFn });
    expect(entity?.legalName).toBe("APPLE INC.");
    expect(entity?.lei).toBe(APPLE_LEI);
    expect(entity?.matchReason).toBe("Exact LEI match");
    expect(fetchFn.requests[0]?.url).toContain("filter%5Blei%5D=");
  });

  test("returns null when the LEI filter comes back empty", async () => {
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: collection([]) },
    ]);
    expect(await resolveGleifEntity(APPLE_LEI, { fetchFn })).toBeNull();
  });
});

describe("searchGleifEntities", () => {
  test("ranks the exact normalized legal-name match first", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Bentity.legalName%5D",
        body: collection([
          leiRecord("529900T8BM49AURSDO55", "Apple Bank for Savings"),
          leiRecord(APPLE_LEI, "APPLE INC."),
          leiRecord("254900L4FBJGZLTQPI53", "Apple Hospitality REIT, Inc."),
        ]),
      },
    ]);
    const entities = await searchGleifEntities("Apple Inc", { fetchFn });
    expect(entities).toHaveLength(3);
    expect(entities[0]?.lei).toBe(APPLE_LEI);
    expect(entities[0]?.matchReason).toBe("Exact normalized legal-name match");
  });

  test("empty collection yields an empty array", async () => {
    const fetchFn = routedFetch([
      { pattern: "filter%5Bentity.legalName%5D", body: collection([]) },
    ]);
    expect(await searchGleifEntities("Nonexistent Widgets GmbH", { fetchFn })).toEqual([]);
  });
});

describe("getOwnershipChain", () => {
  test("surfaces NATURAL_PERSONS reporting exceptions and parses children", async () => {
    const record = leiRecord(APPLE_LEI, "APPLE INC.", {
      relationships: {
        "direct-parent": {
          links: {
            "reporting-exception": `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-parent-reporting-exception`,
          },
        },
        "ultimate-parent": {
          links: {
            "reporting-exception": `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/ultimate-parent-reporting-exception`,
          },
        },
        "direct-children": {
          links: {
            related: `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-children`,
          },
        },
      },
    });
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Blei%5D",
        body: collection([record], { goldenCopy: "2026-08-01T00:00:00Z" }),
      },
      {
        pattern: "direct-parent-reporting-exception",
        body: {
          data: {
            type: "reporting-exceptions",
            id: `${APPLE_LEI}.direct`,
            attributes: {
              lei: APPLE_LEI,
              category: "DIRECT_ACCOUNTING_CONSOLIDATION_PARENT",
              reason: "NATURAL_PERSONS",
            },
          },
        },
      },
      {
        pattern: "ultimate-parent-reporting-exception",
        body: {
          data: {
            type: "reporting-exceptions",
            id: `${APPLE_LEI}.ultimate`,
            attributes: {
              lei: APPLE_LEI,
              category: "ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT",
              reason: "NATURAL_PERSONS",
            },
          },
        },
      },
      {
        pattern: "direct-children",
        body: collection([
          leiRecord("549300GT3HHPZ7TS8V70", "Apple Sales International", { jurisdiction: "IE" }),
          leiRecord(APPLE_INDIA_LEI, "APPLE INDIA PRIVATE LIMITED", { jurisdiction: "IN" }),
        ]),
      },
    ]);

    const chain = await getOwnershipChain(APPLE_LEI, { fetchFn });
    expect(chain.entity.legalName).toBe("APPLE INC.");
    expect(chain.goldenCopyPublishedAt).toBe("2026-08-01T00:00:00Z");
    expect(chain.directParent?.entity).toBeUndefined();
    expect(chain.directParent?.exceptionReason).toBe("NATURAL_PERSONS");
    expect(chain.directParent?.exceptionCategory).toBe("DIRECT_ACCOUNTING_CONSOLIDATION_PARENT");
    expect(chain.ultimateParent?.exceptionReason).toBe("NATURAL_PERSONS");
    expect(chain.children.map((child) => child.legalName)).toEqual([
      "Apple Sales International",
      "APPLE INDIA PRIVATE LIMITED",
    ]);
    expect(chain.children[1]?.jurisdiction).toBe("IN");
  });

  test("subsidiary chain: full parent record, empty children collection", async () => {
    const record = leiRecord(APPLE_INDIA_LEI, "APPLE INDIA PRIVATE LIMITED", {
      jurisdiction: "IN",
      relationships: {
        "direct-parent": {
          links: {
            "lei-record": `https://api.gleif.org/api/v1/lei-records/${APPLE_INDIA_LEI}/direct-parent`,
          },
        },
        "ultimate-parent": {
          links: {
            "lei-record": `https://api.gleif.org/api/v1/lei-records/${APPLE_INDIA_LEI}/ultimate-parent`,
          },
        },
        "direct-children": {
          links: {
            related: `https://api.gleif.org/api/v1/lei-records/${APPLE_INDIA_LEI}/direct-children`,
          },
        },
      },
    });
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: collection([record]) },
      {
        pattern: `${APPLE_INDIA_LEI}/direct-parent`,
        body: { data: leiRecord(PARENT_LEI, "APPLE INC.") },
      },
      {
        pattern: `${APPLE_INDIA_LEI}/ultimate-parent`,
        body: { data: leiRecord(PARENT_LEI, "APPLE INC.") },
      },
      {
        pattern: `${APPLE_INDIA_LEI}/direct-children`,
        body: collection([]),
      },
    ]);

    const chain = await getOwnershipChain(APPLE_INDIA_LEI, { fetchFn });
    expect(chain.directParent?.entity?.legalName).toBe("APPLE INC.");
    expect(chain.directParent?.entity?.lei).toBe(PARENT_LEI);
    expect(chain.directParent?.exceptionReason).toBeUndefined();
    expect(chain.ultimateParent?.entity?.lei).toBe(PARENT_LEI);
    expect(chain.children).toEqual([]);
  });

  test("a 404 parent endpoint leaves the parent absent rather than failing", async () => {
    const record = leiRecord(APPLE_INDIA_LEI, "APPLE INDIA PRIVATE LIMITED", {
      relationships: {
        "direct-parent": {
          links: {
            "lei-record": `https://api.gleif.org/api/v1/lei-records/${APPLE_INDIA_LEI}/direct-parent`,
          },
        },
        "direct-children": {
          links: {
            related: `https://api.gleif.org/api/v1/lei-records/${APPLE_INDIA_LEI}/direct-children`,
          },
        },
      },
    });
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: collection([record]) },
      { pattern: `${APPLE_INDIA_LEI}/direct-parent`, body: { errors: [] }, status: 404 },
      { pattern: `${APPLE_INDIA_LEI}/direct-children`, body: collection([]) },
    ]);

    const chain = await getOwnershipChain(APPLE_INDIA_LEI, { fetchFn });
    expect(chain.directParent).toBeUndefined();
    expect(chain.ultimateParent).toBeUndefined();
    expect(chain.children).toEqual([]);
  });

  test("follows children pagination and dedupes entities by LEI", async () => {
    const record = leiRecord(APPLE_LEI, "APPLE INC.", {
      relationships: {
        "direct-children": {
          links: {
            related: `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-children`,
          },
        },
      },
    });
    const page2Url =
      `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-children?page%5Bnumber%5D=2`;
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: collection([record]) },
      {
        pattern: "page%5Bnumber%5D=2",
        body: collection([
          leiRecord(APPLE_INDIA_LEI, "APPLE INDIA PRIVATE LIMITED", { jurisdiction: "IN" }),
          // Duplicate of a page-1 child; must be deduped.
          leiRecord("549300GT3HHPZ7TS8V70", "Apple Sales International", { jurisdiction: "IE" }),
        ]),
      },
      {
        pattern: `${APPLE_LEI}/direct-children`,
        body: collection(
          [
            leiRecord("549300GT3HHPZ7TS8V70", "Apple Sales International", { jurisdiction: "IE" }),
            leiRecord("5493000MLC81QVSK1D46", "Apple Operations Europe", { jurisdiction: "IE" }),
          ],
          { next: page2Url },
        ),
      },
    ]);

    const chain = await getOwnershipChain(APPLE_LEI, { fetchFn });
    const pageRequests = fetchFn.requests.filter(({ url }) => url.includes("direct-children"));
    expect(pageRequests).toHaveLength(2);
    expect(pageRequests[1]?.url).toBe(page2Url);
    expect(chain.children.map((child) => child.lei)).toEqual([
      "549300GT3HHPZ7TS8V70",
      "5493000MLC81QVSK1D46",
      APPLE_INDIA_LEI,
    ]);
  });
});
