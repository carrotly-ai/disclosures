import { beforeEach, describe, expect, test } from "bun:test";
import {
  CNINFO_ANNUAL_CATEGORY,
  CNINFO_STATIC_BASE_URL,
  CninfoRateLimitError,
  exchangeColumnForOrgId,
  exchangeLabel,
  getLatestCninfoReport,
  isChineseStockCode,
  resolveCninfoCompany,
  searchCninfoCompanies,
  searchCninfoFilings,
} from "../src/adapters/cninfo.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// topSearch returns a bare JSON array. Kweichow Moutai (SSE 600519) plus a
// Shenzhen company that must be filtered out on an exact stock-code query.
const SEARCH_ROWS = [
  {
    code: "600519",
    zwjc: "贵州茅台",
    pinyin: "GZMT",
    category: "A股",
    orgId: "gssh0600519",
    delisted: false,
  },
  {
    code: "000858",
    zwjc: "五粮液",
    pinyin: "WLY",
    category: "A股",
    orgId: "gssz0000858",
    delisted: false,
  },
];

const searchRoute: Route = { pattern: "topSearch/query", body: SEARCH_ROWS };

// One page of hisAnnouncement results: an annual report plus an interim notice.
const ANNOUNCEMENTS = {
  totalAnnouncement: 2,
  announcements: [
    {
      secCode: "600519",
      secName: "贵州茅台",
      orgId: "gssh0600519",
      announcementId: "1220000001",
      announcementTitle: "2025年年度报告",
      // Beijing midnight 2026-04-17; +8h stays on the 17th after the ISO slice.
      announcementTime: Date.UTC(2026, 3, 17, 0, 0, 0),
      adjunctUrl: "finalpage/2026-04-17/1220000001.PDF",
      announcementTypeName: "年度报告",
    },
    {
      secCode: "600519",
      secName: "贵州茅台",
      orgId: "gssh0600519",
      announcementId: "1220000002",
      announcementTitle: "关于召开股东大会的通知",
      announcementTime: Date.UTC(2026, 3, 5, 0, 0, 0),
      adjunctUrl: "/finalpage/2026-04-05/1220000002.PDF",
      announcementTypeName: "公司治理",
    },
  ],
};

const announcementRoute: Route = {
  pattern: "hisAnnouncement/query",
  body: ANNOUNCEMENTS,
};

beforeEach(() => {
  resetRateLimiters();
});

describe("cninfo helpers", () => {
  test("maps org-id prefixes to the announcement column", () => {
    expect(exchangeColumnForOrgId("gssh0600519")).toBe("sse");
    expect(exchangeColumnForOrgId("gssz0000858")).toBe("szse");
    expect(exchangeColumnForOrgId("gshk09988")).toBe("hke");
    expect(exchangeLabel("sse")).toContain("Shanghai");
    expect(exchangeLabel("hke")).toContain("Hong Kong");
  });

  test("recognises 5-6 digit Chinese stock codes", () => {
    expect(isChineseStockCode("600519")).toBe(true);
    expect(isChineseStockCode("09988")).toBe(true);
    expect(isChineseStockCode("AAPL")).toBe(false);
    expect(isChineseStockCode("1234")).toBe(false);
  });
});

describe("searchCninfoCompanies", () => {
  test("filters to an exact stock-code match and derives the SSE column", async () => {
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchCninfoCompanies("600519", options(fetchFn));
    expect(results).toHaveLength(1);
    const moutai = results[0];
    expect(moutai?.legalName).toBe("贵州茅台");
    expect(moutai?.stockCode).toBe("600519");
    expect(moutai?.orgId).toBe("gssh0600519");
    expect(moutai?.column).toBe("sse");
    expect(moutai?.jurisdiction).toBe("CN");
    expect(moutai?.source).toBe("cninfo");
    expect(moutai?.matchReason).toBe("Exact stock-code match");
    expect(moutai?.aliases?.[0]).toContain("Shanghai");
    expect(moutai?.sourceUrl).toContain("stockCode=600519");
  });

  test("preserves cninfo relevance order for a name query", async () => {
    const fetchFn = routedFetch([searchRoute]);
    const results = await searchCninfoCompanies("白酒", options(fetchFn));
    expect(results.map((entity) => entity.stockCode)).toEqual(["600519", "000858"]);
    expect(results[0]?.matchReason).toBe("cninfo search result");
  });

  test("returns an empty array for a blank query without calling the network", async () => {
    const fetchFn = routedFetch([searchRoute]);
    expect(await searchCninfoCompanies("   ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("resolveCninfoCompany returns the top hit or null", async () => {
    const fetchFn = routedFetch([searchRoute]);
    expect((await resolveCninfoCompany("600519", options(fetchFn)))?.stockCode).toBe(
      "600519",
    );
    const empty = routedFetch([{ pattern: "topSearch/query", body: [] }]);
    expect(await resolveCninfoCompany("nope", options(empty))).toBeNull();
  });
});

describe("searchCninfoFilings", () => {
  test("resolves a company then builds static-host PDF links", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchCninfoFilings(
      { company: "600519", startDate: "2026-01-01", endDate: "2026-05-01" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(2);
    const annual = filings.find((filing) => filing.accession === "1220000001");
    expect(annual?.form).toBe("年度报告");
    expect(annual?.description).toBe("2025年年度报告");
    expect(annual?.source).toBe("cninfo");
    expect(annual?.sourceUrl).toBe(
      `${CNINFO_STATIC_BASE_URL}/finalpage/2026-04-17/1220000001.PDF`,
    );
    // A leading slash in adjunctUrl must not double up against the base host.
    const notice = filings.find((filing) => filing.accession === "1220000002");
    expect(notice?.sourceUrl).toBe(
      `${CNINFO_STATIC_BASE_URL}/finalpage/2026-04-05/1220000002.PDF`,
    );
    // The announcement POST carried the resolved stock,orgId pair and SSE column.
    const annReq = fetchFn.requests.find((request) =>
      request.url.includes("hisAnnouncement/query"),
    );
    const sentBody = String(annReq?.init?.body ?? "");
    expect(sentBody).toContain("column=sse");
    expect(decodeURIComponent(sentBody)).toContain("stock=600519,gssh0600519");
    expect(decodeURIComponent(sentBody)).toContain("seDate=2026-01-01~2026-05-01");
  });

  test("labels filedDate from the Beijing wall-clock epoch", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchCninfoFilings("600519", options(fetchFn));
    const annual = filings.find((filing) => filing.accession === "1220000001");
    // 1_744_000_000_000 ms +8h → 2026-04-17.
    expect(annual?.filedDate).toBe("2026-04-17");
  });

  test("applies a case-insensitive form filter", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchCninfoFilings(
      { company: "600519", forms: ["年度报告"] },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.accession).toBe("1220000001");
  });
});

describe("getLatestCninfoReport", () => {
  test("queries the annual category and returns a PDF section link", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      {
        pattern: "hisAnnouncement/query",
        body: {
          totalAnnouncement: 1,
          announcements: [ANNOUNCEMENTS.announcements[0]],
        },
      },
    ]);
    const report = await getLatestCninfoReport("600519", "annual", options(fetchFn));
    expect(report?.reportKind).toBe("annual");
    expect(report?.accession).toBe("1220000001");
    expect(report?.sectionLinks[0]?.section).toBe("cninfo-pdf");
    expect(report?.sectionLinks[0]?.url).toBe(
      `${CNINFO_STATIC_BASE_URL}/finalpage/2026-04-17/1220000001.PDF`,
    );
    const annReq = fetchFn.requests.find((request) =>
      request.url.includes("hisAnnouncement/query"),
    );
    expect(String(annReq?.init?.body ?? "")).toContain(
      `category=${CNINFO_ANNUAL_CATEGORY}`,
    );
  });

  test("returns null when no periodic report is on file", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      { pattern: "hisAnnouncement/query", body: { totalAnnouncement: 0, announcements: [] } },
    ]);
    expect(await getLatestCninfoReport("600519", "quarterly", options(fetchFn))).toBeNull();
  });
});

describe("rate limiting", () => {
  test("maps an HTTP 429 to CninfoRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: "topSearch/query", body: "rate limited", status: 429 },
    ]);
    await expect(searchCninfoCompanies("600519", options(fetchFn))).rejects.toBeInstanceOf(
      CninfoRateLimitError,
    );
  });
});
