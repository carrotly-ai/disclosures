import { beforeEach, describe, expect, test } from "bun:test";
import {
  FCA_NSM_ARTEFACT_BASE_URL,
  FcaNsmRateLimitError,
  getFcaNsmMajorHoldings,
  hasFcaNsmAccess,
  normalizeTr1Date,
  parseNsmSearchResponse,
  parseTr1Artefact,
} from "../src/adapters/fcaNsm.js";
import { fcaNsmRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

const TR1_HTML = loadFixture("fca", "tr1-rws.html");

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// The NSM search proxy answers in Elasticsearch shape: { hits: { hits: [...] } }
// where each hit's _source carries the classification and a RELATIVE download
// link. TR-1 "Holding(s) in Company" artefacts carry type_code "HOL".
function searchResponse(hits: Array<Record<string, unknown>>) {
  return { hits: { hits: hits.map((source) => ({ _source: source })) } };
}

const HOL_HIT = {
  type_code: "HOL",
  company: "RWS HOLDINGS PLC",
  lei: "213800CVU6WHF3RN2R76",
  headline: "Holding(s) in Company",
  download_link: "NSM/RNS/abc.html",
  publication_date: "2025-11-06",
  disclosure_id: "RNS-5915G",
};

const searchRoute = (hits: Array<Record<string, unknown>>): Route => ({
  pattern: "search?index=nsm-search",
  body: searchResponse(hits),
});

const artefactRoute = (link: string, html = TR1_HTML): Route => ({
  pattern: `artefacts/${link}`,
  body: html,
  headers: { "content-type": "text/html" },
});

beforeEach(() => {
  resetRateLimiters();
});

describe("hasFcaNsmAccess", () => {
  test("is false by default (inject-only)", () => {
    expect(hasFcaNsmAccess()).toBe(false);
    expect(hasFcaNsmAccess({})).toBe(false);
    expect(hasFcaNsmAccess({ env: {} })).toBe(false);
  });

  test("is true only when a fetchFn is supplied", () => {
    expect(hasFcaNsmAccess({ fetchFn: routedFetch([]) })).toBe(true);
  });
});

describe("parseTr1Artefact", () => {
  const notification = parseTr1Artefact(
    TR1_HTML,
    "https://data.fca.org.uk/artefacts/NSM/RNS/abc.html",
  );

  test("extracts issuer, filer, percentages, dates and chain", () => {
    expect(notification).not.toBeNull();
    expect(notification?.issuerName).toBe("RWS HOLDINGS PLC");
    expect(notification?.issuerIsin).toBe("GB00BVFCZV34");
    expect(notification?.ukIssuer).toBe("UK");
    expect(notification?.personSubject).toBe("Octopus Investments Limited");
    expect(notification?.thresholdCrossedDate).toBe("2025-11-05");
    expect(notification?.issuerNotifiedDate).toBe("2025-11-06");
    expect(notification?.resultingPctTotal).toBe(6.99);
    expect(notification?.resultingVotingRights).toBe(25853307);
    expect(notification?.previousPctTotal).toBe(7.41);
  });

  test("extracts the controlled-undertaking chain", () => {
    expect(notification?.chain).toEqual([
      {
        ultimateControllingPerson: "Octopus Capital Limited",
        controlledUndertaking: "Octopus Investments Limited",
        pct: 6.99,
      },
    ]);
  });

  test("returns null for HTML that is not a TR-1 form", () => {
    expect(parseTr1Artefact("<html><p>Board meeting outcome</p></html>", "u")).toBeNull();
    expect(parseTr1Artefact("", "u")).toBeNull();
  });
});

describe("normalizeTr1Date", () => {
  test("normalises the TR-1 date formats to ISO", () => {
    expect(normalizeTr1Date("05-Nov-2025")).toBe("2025-11-05");
    expect(normalizeTr1Date("5 November 2025")).toBe("2025-11-05");
    expect(normalizeTr1Date("06/11/2025")).toBe("2025-11-06");
    expect(normalizeTr1Date("2025-11-06")).toBe("2025-11-06");
  });

  test("returns undefined for unparseable input", () => {
    expect(normalizeTr1Date(undefined)).toBeUndefined();
    expect(normalizeTr1Date("not a date")).toBeUndefined();
  });
});

describe("parseNsmSearchResponse", () => {
  test("reads the Elasticsearch { hits: { hits } } shape", () => {
    const hits = parseNsmSearchResponse(searchResponse([HOL_HIT]));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.typeCode).toBe("HOL");
    expect(hits[0]?.downloadLink).toBe("NSM/RNS/abc.html");
  });

  test("tolerates a flat { hits: [...] } shape", () => {
    const flat = { hits: [{ _source: HOL_HIT }] };
    expect(parseNsmSearchResponse(flat)).toHaveLength(1);
  });

  test("drops hits without a download link", () => {
    const response = searchResponse([{ type_code: "HOL" }]);
    expect(parseNsmSearchResponse(response)).toEqual([]);
  });
});

describe("getFcaNsmMajorHoldings", () => {
  test("returns an empty list and makes NO request without a fetchFn", async () => {
    // The default path must never touch data.fca.org.uk. A throwing routedFetch
    // is not even supplied here — proving the code never reaches for one.
    expect(await getFcaNsmMajorHoldings("RWS Holdings", {})).toEqual([]);
  });

  test("searches, filters to TR-1 (HOL), and maps the artefact to an owner", async () => {
    const fetchFn = routedFetch([
      searchRoute([HOL_HIT, { type_code: "RNS", download_link: "NSM/RNS/other.html" }]),
      artefactRoute("NSM/RNS/abc.html"),
    ]);
    const owners = await getFcaNsmMajorHoldings("RWS Holdings", options(fetchFn));

    expect(owners).toHaveLength(1);
    const owner = owners[0];
    expect(owner?.holderName).toBe("Octopus Investments Limited");
    expect(owner?.form).toBe("TR-1");
    expect(owner?.pct).toBe(6.99);
    expect(owner?.change).toBe(-0.42);
    expect(owner?.source).toBe("FCA NSM");
    expect(owner?.sourceIdentifiers?.isin).toBe("GB00BVFCZV34");
    expect(owner?.sourceIdentifiers?.jurisdiction).toBe("GB");
    expect(owner?.thresholdRegime).toContain("DTR5");
    expect(owner?.sourceUrl).toBe(
      `${FCA_NSM_ARTEFACT_BASE_URL}NSM/RNS/abc.html`,
    );

    // The non-HOL hit's artefact must never be fetched.
    expect(fetchFn.requests.some((r) => r.url.includes("other.html"))).toBe(false);
    expect(fetchFn.requests.some((r) => r.url.includes("search?index=nsm-search"))).toBe(true);
  });

  test("sorts multiple TR-1 notifications newest-filed first", async () => {
    // filedDate derives from the artefact's "Issuer notified" date (section 6),
    // rendered "06-Nov-2025" in the fixture. Backdate a second artefact so the
    // two carry distinct filed dates and the sort is observable.
    const older = TR1_HTML.replace("06-Nov-2025", "06-Jan-2024");
    const fetchFn = routedFetch([
      searchRoute([
        { ...HOL_HIT, download_link: "NSM/RNS/old.html", publication_date: "2024-01-06" },
        { ...HOL_HIT, download_link: "NSM/RNS/new.html", publication_date: "2025-11-06" },
      ]),
      artefactRoute("NSM/RNS/new.html"),
      artefactRoute("NSM/RNS/old.html", older),
    ]);
    const owners = await getFcaNsmMajorHoldings("RWS Holdings", options(fetchFn));
    expect(owners).toHaveLength(2);
    expect(owners[0]?.filedDate).toBe("2025-11-06");
    expect(owners[1]?.filedDate).toBe("2024-01-06");
  });

  test("returns an empty list when the search yields no HOL artefacts", async () => {
    const fetchFn = routedFetch([
      searchRoute([{ type_code: "RNS", download_link: "NSM/RNS/other.html" }]),
    ]);
    expect(await getFcaNsmMajorHoldings("RWS Holdings", options(fetchFn))).toEqual([]);
  });

  test("raises FcaNsmRateLimitError when the local budget is exhausted", async () => {
    for (let i = 0; i < fcaNsmRateLimiter.limit; i += 1) {
      expect(fcaNsmRateLimiter.tryAcquire()).toBe(true);
    }
    const fetchFn = routedFetch([searchRoute([HOL_HIT]), artefactRoute("NSM/RNS/abc.html")]);
    await expect(
      getFcaNsmMajorHoldings("RWS Holdings", options(fetchFn)),
    ).rejects.toBeInstanceOf(FcaNsmRateLimitError);
  });

  test("maps an upstream 429 to FcaNsmRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: "search?index=nsm-search", body: "rate limited", status: 429 },
    ]);
    await expect(
      getFcaNsmMajorHoldings("RWS Holdings", options(fetchFn)),
    ).rejects.toBeInstanceOf(FcaNsmRateLimitError);
  });
});
