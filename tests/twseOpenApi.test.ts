import { beforeEach, describe, expect, test } from "bun:test";
import {
  getTwseDirectorHoldings,
  getTwseMajorShareholders,
  isTwseStockCode,
  resetTwseDatasetCache,
  resolveTwseCompany,
  rocDateToIso,
  rocYearMonthToIso,
  searchTwseCompanies,
  searchTwseFilings,
  TWSE_ANNOUNCEMENTS_ENDPOINT,
  TWSE_BASIC_ENDPOINT,
  TWSE_DIRECTOR_HOLDINGS_ENDPOINT,
  TWSE_MAJOR_SHAREHOLDERS_ENDPOINT,
  TwseRateLimitError,
} from "../src/adapters/twseOpenApi.js";
import { InMemoryCache } from "../src/core/cache.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// Listed-company basic data (t187ap03_L). TSMC (2330) plus a second row that a
// numeric-code query must filter out. Field names are the live TWSE keys.
const BASIC_ROWS = [
  {
    公司代號: "2330",
    公司名稱: "台灣積體電路製造股份有限公司",
    公司簡稱: "台積電",
    英文簡稱: "TSMC",
    上市日期: "19940905",
  },
  {
    公司代號: "2317",
    公司名稱: "鴻海精密工業股份有限公司",
    公司簡稱: "鴻海",
    英文簡稱: "HON HAI",
    上市日期: "19910606",
  },
];

const basicRoute: Route = { pattern: TWSE_BASIC_ENDPOINT, body: BASIC_ROWS };

// Material-information announcements (t187ap04_L). Note the trailing space in the
// 主旨 key, which the live feed carries.
const ANNOUNCEMENT_ROWS = [
  {
    公司代號: "2330",
    公司名稱: "台積電",
    發言日期: "1150805",
    發言時間: "083000",
    符合條款: "第 4 款",
    事實發生日: "1150805",
    "主旨 ": "本公司受邀參加法人說明會",
  },
  {
    公司代號: "2317",
    公司名稱: "鴻海",
    發言日期: "1150804",
    符合條款: "第 51 款",
    "主旨 ": "代子公司公告",
  },
];

const announcementRoute: Route = {
  pattern: TWSE_ANNOUNCEMENTS_ENDPOINT,
  body: ANNOUNCEMENT_ROWS,
};

// >10% major shareholders (t187ap02_L). TSMC has none in reality; this fixture
// gives 2317 a holder so the empty-vs-present branches are both covered.
const MAJOR_ROWS = [
  {
    公司代號: "2317",
    公司名稱: "鴻海",
    出表日期: "1150731",
    大股東名稱: "鴻海精密工業股份有限公司之投資控股",
  },
];

const majorRoute: Route = {
  pattern: TWSE_MAJOR_SHAREHOLDERS_ENDPOINT,
  body: MAJOR_ROWS,
};

// Director/supervisor holdings (t187ap11_L). Trailing space in 選任時持股.
const DIRECTOR_ROWS = [
  {
    公司代號: "2330",
    公司名稱: "台積電",
    出表日期: "1150731",
    資料年月: "11506",
    職稱: "董事長",
    姓名: "魏哲家",
    目前持股: "1,234,567",
    "選任時持股 ": "1,000,000",
    設質股數: "0",
    設質股數佔持股比例: "0.00",
  },
  {
    公司代號: "2317",
    公司名稱: "鴻海",
    出表日期: "1150731",
    資料年月: "11506",
    職稱: "董事",
    姓名: "劉揚偉",
    目前持股: "2,000,000",
    "選任時持股 ": "1,800,000",
    設質股數: "500,000",
    設質股數佔持股比例: "25.00",
  },
];

const directorRoute: Route = {
  pattern: TWSE_DIRECTOR_HOLDINGS_ENDPOINT,
  body: DIRECTOR_ROWS,
};

beforeEach(() => {
  resetRateLimiters();
  resetTwseDatasetCache();
});

describe("TWSE date helpers", () => {
  test("rocDateToIso handles ROC 7-digit and Gregorian 8-digit dates", () => {
    expect(rocDateToIso("1150805")).toBe("2026-08-05");
    expect(rocDateToIso("19940905")).toBe("1994-09-05");
    expect(rocDateToIso("")).toBeUndefined();
    expect(rocDateToIso("abc")).toBeUndefined();
  });

  test("rocYearMonthToIso converts a 5-digit ROC year-month", () => {
    expect(rocYearMonthToIso("11506")).toBe("2026-06");
    expect(rocYearMonthToIso("1150805")).toBeUndefined();
  });

  test("isTwseStockCode accepts 4-6 digit codes only", () => {
    expect(isTwseStockCode("2330")).toBe(true);
    expect(isTwseStockCode("00878")).toBe(true);
    expect(isTwseStockCode("233")).toBe(false);
    expect(isTwseStockCode("TSMC")).toBe(false);
  });
});

describe("searchTwseCompanies", () => {
  test("returns an exact listing-code match with identifiers and profile URL", async () => {
    const fetchFn = routedFetch([basicRoute]);
    const results = await searchTwseCompanies("2330", options(fetchFn));
    expect(results).toHaveLength(1);
    const tsmc = results[0];
    expect(tsmc?.legalName).toBe("台灣積體電路製造股份有限公司");
    expect(tsmc?.stockCode).toBe("2330");
    expect(tsmc?.jurisdiction).toBe("TW");
    expect(tsmc?.source).toBe("TWSE");
    expect(tsmc?.status).toBe("Listed 1994-09-05");
    expect(tsmc?.aliases).toEqual(["TSMC", "台積電"]);
    expect(tsmc?.matchReason).toBe("Exact listing-code match");
    expect(tsmc?.sourceUrl).toContain("owncode=2330");
  });

  test("ranks name and alias queries", async () => {
    const fetchFn = routedFetch([basicRoute]);
    const results = await searchTwseCompanies("TSMC", options(fetchFn));
    expect(results[0]?.stockCode).toBe("2330");
  });

  test("returns nothing for a blank query without a network call", async () => {
    const fetchFn = routedFetch([basicRoute]);
    expect(await searchTwseCompanies("  ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("resolveTwseCompany returns the top hit or null", async () => {
    const fetchFn = routedFetch([basicRoute]);
    expect((await resolveTwseCompany("2330", options(fetchFn)))?.stockCode).toBe("2330");
    resetTwseDatasetCache();
    const empty = routedFetch([{ pattern: TWSE_BASIC_ENDPOINT, body: [{ 公司代號: "2317", 公司名稱: "鴻海" }] }]);
    expect(await resolveTwseCompany("nonexistent-name", options(empty))).toBeNull();
  });
});

describe("searchTwseFilings", () => {
  test("filters to the resolved company and maps ROC dates", async () => {
    const fetchFn = routedFetch([basicRoute, announcementRoute]);
    const filings = await searchTwseFilings("2330", options(fetchFn));
    expect(filings).toHaveLength(1);
    const filing = filings[0];
    expect(filing?.filedDate).toBe("2026-08-05");
    expect(filing?.form).toBe("Material information (重大訊息)");
    expect(filing?.category).toBe("第 4 款");
    expect(filing?.description).toContain("本公司受邀參加法人說明會");
    expect(filing?.description).toContain("event 2026-08-05");
    expect(filing?.sourceUrl).toContain("owncode=2330");
    expect(filing?.source).toBe("TWSE");
  });

  test("applies a case-insensitive form/subject filter and a date window", async () => {
    const fetchFn = routedFetch([basicRoute, announcementRoute]);
    const none = await searchTwseFilings(
      { company: "2330", forms: ["nonexistent"] },
      options(fetchFn),
    );
    expect(none).toHaveLength(0);
    resetTwseDatasetCache();
    const fetch2 = routedFetch([basicRoute, announcementRoute]);
    const windowed = await searchTwseFilings(
      { company: "2330", startDate: "2026-09-01" },
      options(fetch2),
    );
    expect(windowed).toHaveLength(0);
  });
});

describe("getTwseMajorShareholders", () => {
  test("returns an empty list for a company with no >10% holder", async () => {
    const fetchFn = routedFetch([basicRoute, majorRoute]);
    const owners = await getTwseMajorShareholders("2330", options(fetchFn));
    expect(owners).toHaveLength(0);
  });

  test("maps a >10% holder with the Taiwan threshold regime", async () => {
    const fetchFn = routedFetch([basicRoute, majorRoute]);
    const owners = await getTwseMajorShareholders("2317", options(fetchFn));
    expect(owners).toHaveLength(1);
    const owner = owners[0];
    expect(owner?.holderName).toContain("投資控股");
    expect(owner?.holderType).toBe("Major shareholder (>10%)");
    expect(owner?.thresholdRegime).toContain("more than 10%");
    expect(owner?.filedDate).toBe("2026-07-31");
    expect(owner?.pct).toBeUndefined();
    expect(owner?.sourceUrl).toContain("owncode=2317");
  });
});

describe("getTwseDirectorHoldings", () => {
  test("maps director rows with parsed share counts and data month", async () => {
    const fetchFn = routedFetch([basicRoute, directorRoute]);
    const holdings = await getTwseDirectorHoldings("2330", options(fetchFn));
    expect(holdings).toHaveLength(1);
    const chair = holdings[0];
    expect(chair?.title).toBe("董事長");
    expect(chair?.name).toBe("魏哲家");
    expect(chair?.currentShares).toBe(1234567);
    expect(chair?.electedShares).toBe(1000000);
    expect(chair?.pledgedShares).toBe(0);
    expect(chair?.dataMonth).toBe("2026-06");
    expect(chair?.filedDate).toBe("2026-07-31");
    expect(chair?.sourceUrl).toContain("owncode=2330");
  });
});

describe("caching and rate limiting", () => {
  test("serves a second lookup from the injected cache without refetching", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([basicRoute]);
    await searchTwseCompanies("2330", { fetchFn, cache });
    const basicRequests = fetchFn.requests.filter((request) =>
      request.url.includes(TWSE_BASIC_ENDPOINT),
    ).length;
    expect(basicRequests).toBe(1);
    // A fresh process-local memo but a warm shared cache: no new network call.
    resetTwseDatasetCache();
    await searchTwseCompanies("2317", { fetchFn, cache });
    const after = fetchFn.requests.filter((request) =>
      request.url.includes(TWSE_BASIC_ENDPOINT),
    ).length;
    expect(after).toBe(1);
  });

  test("maps an HTTP 429 to TwseRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: TWSE_BASIC_ENDPOINT, body: "rate limited", status: 429 },
    ]);
    await expect(searchTwseCompanies("2330", options(fetchFn))).rejects.toBeInstanceOf(
      TwseRateLimitError,
    );
  });
});
