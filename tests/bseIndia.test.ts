import { beforeEach, describe, expect, test } from "bun:test";
import {
  BSE_ATTACHMENT_BASE_URL,
  BSE_SITE_URL,
  BseRateLimitError,
  isBseScripCode,
  parseBsePeerSearch,
  resolveBseCompany,
  searchBseCompanies,
  searchBseFilings,
} from "../src/adapters/bseIndia.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// PeerSmartSearch answers with an HTML fragment: one <li> per hit whose onclick
// carries liclick('<scripCode>','<name>'), with the ISIN in the row text.
const SEARCH_HTML = `
<ul>
  <li onclick="liclick('500325','Reliance Industries Ltd')">
    Reliance Industries Ltd <span>INE002A01018</span>
  </li>
  <li onclick="liclick('532540','Tata Consultancy Services Ltd')">
    Tata Consultancy Services Ltd <span>INE467B01029</span>
  </li>
</ul>`;

const searchRoute: Route = { pattern: "PeerSmartSearch", body: SEARCH_HTML };

const ANNOUNCEMENTS = {
  Table: [
    {
      NEWSID: "abc123",
      SCRIP_CD: "500325",
      HEADLINE: "Board Meeting Outcome &amp; Results",
      NEWSSUB: "Reliance Industries Ltd",
      CATEGORYNAME: "Result",
      SUBCATNAME: "Financial Results",
      NEWS_DT: "2026-04-21T18:30:00",
      ATTACHMENTNAME: "abc123.pdf",
    },
    {
      NEWSID: "def456",
      SCRIP_CD: "500325",
      HEADLINE: "Notice of AGM",
      CATEGORYNAME: "AGM/EGM",
      NEWS_DT: "2026-03-10T11:00:00",
      ATTACHMENTNAME: "",
    },
  ],
};

const announcementRoute: Route = { pattern: "AnnGetData", body: ANNOUNCEMENTS };

beforeEach(() => {
  resetRateLimiters();
});

describe("BSE helpers", () => {
  test("recognises 6-digit scrip codes", () => {
    expect(isBseScripCode("500325")).toBe(true);
    expect(isBseScripCode("50032")).toBe(false);
    expect(isBseScripCode("RELIANCE")).toBe(false);
  });

  test("parseBsePeerSearch extracts scrip code, name, and ISIN per row", () => {
    const rows = parseBsePeerSearch(SEARCH_HTML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      scripCode: "500325",
      name: "Reliance Industries Ltd",
      isin: "INE002A01018",
    });
    expect(rows[1]?.isin).toBe("INE467B01029");
  });
});

describe("searchBseCompanies", () => {
  test("filters to an exact scrip-code match", async () => {
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchBseCompanies("500325", options(fetchFn));
    expect(results).toHaveLength(1);
    const reliance = results[0];
    expect(reliance?.legalName).toBe("Reliance Industries Ltd");
    expect(reliance?.scripCode).toBe("500325");
    expect(reliance?.isin).toBe("INE002A01018");
    expect(reliance?.jurisdiction).toBe("IN");
    expect(reliance?.source).toBe("BSE India");
    expect(reliance?.matchReason).toBe("Exact scrip-code match");
    expect(reliance?.sourceUrl).toBe(
      `${BSE_SITE_URL}/stock-share-price/x/x/500325/`,
    );
  });

  test("ranks name matches for a text query", async () => {
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchBseCompanies("Tata Consultancy", options(fetchFn));
    expect(results[0]?.scripCode).toBe("532540");
  });

  test("returns an empty array for a blank query without a network call", async () => {
    const fetchFn = routedFetch([searchRoute]);
    expect(await searchBseCompanies("  ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("resolveBseCompany returns the top hit or null", async () => {
    const fetchFn = routedFetch([searchRoute]);
    expect((await resolveBseCompany("500325", options(fetchFn)))?.scripCode).toBe(
      "500325",
    );
    const empty = routedFetch([{ pattern: "PeerSmartSearch", body: "<ul></ul>" }]);
    expect(await resolveBseCompany("nothing", options(empty))).toBeNull();
  });
});

describe("searchBseFilings", () => {
  test("resolves a company then builds attachment PDF links", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchBseFilings(
      { company: "500325", startDate: "2026-01-01", endDate: "2026-05-01" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(2);
    const result = filings.find((filing) => filing.accession === "abc123");
    expect(result?.description).toBe("Board Meeting Outcome & Results");
    expect(result?.form).toBe("Result");
    expect(result?.category).toBe("Financial Results");
    expect(result?.filedDate).toBe("2026-04-21");
    expect(result?.source).toBe("BSE India");
    expect(result?.sourceUrl).toBe(`${BSE_ATTACHMENT_BASE_URL}/abc123.pdf`);
    // A row with no attachment falls back to the corporate-announcements page.
    const agm = filings.find((filing) => filing.accession === "def456");
    expect(agm?.sourceUrl).toBe(`${BSE_SITE_URL}/corporates/ann.html`);
    // The feed URL carried the resolved scrip code and the date window.
    const annReq = fetchFn.requests.find((request) =>
      request.url.includes("AnnGetData"),
    );
    expect(annReq?.url).toContain("strScrip=500325");
    expect(annReq?.url).toContain("strPrevDate=20260101");
    expect(annReq?.url).toContain("strToDate=20260501");
  });

  test("degrades to an empty list when the feed returns 'No Record Found!'", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      { pattern: "AnnGetData", body: "No Record Found!" },
    ]);
    const filings = await searchBseFilings("500325", options(fetchFn));
    expect(filings).toHaveLength(0);
  });

  test("applies a case-insensitive form filter", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchBseFilings(
      { company: "500325", forms: ["agm"] },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.accession).toBe("def456");
  });
});

describe("rate limiting", () => {
  test("maps an HTTP 429 on search to BseRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: "PeerSmartSearch", body: "blocked", status: 429 },
    ]);
    await expect(searchBseCompanies("500325", options(fetchFn))).rejects.toBeInstanceOf(
      BseRateLimitError,
    );
  });
});
