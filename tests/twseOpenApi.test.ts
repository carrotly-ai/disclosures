import { beforeEach, describe, expect, test } from "bun:test";
import {
  getTwseDirectorHoldings,
  getTwseFinancials,
  getTwseMajorShareholders,
  isTwseStockCode,
  resetTwseDatasetCache,
  resolveTwseCompany,
  rocDateToIso,
  rocYearMonthToIso,
  searchTwseCompanies,
  searchTwseFilings,
  twseQuarterPeriodEnd,
  TWSE_ANNOUNCEMENTS_ENDPOINT,
  TWSE_BALANCE_SHEET_ENDPOINT,
  TWSE_BASIC_ENDPOINT,
  TWSE_COMPREHENSIVE_INCOME_ENDPOINT,
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

// Financial-statement snapshots (t187ap06_L_ci comprehensive income,
// t187ap07_L_ci balance sheet). Values are NT$ thousands with full-width
// parentheses on the income keys, exactly as the live feed emits them. 2330 is
// general-industry; a second row (2317) that a code filter must exclude.
const INCOME_ROWS = [
  {
    出表日期: "1150821",
    年度: "115",
    季別: "2",
    公司代號: "2330",
    公司名稱: "台積電",
    營業收入: "2404483690.00",
    "營業利益（損失）": "1425568793.00",
    "本期淨利（淨損）": "1279582227.00",
  },
  {
    出表日期: "1150821",
    年度: "115",
    季別: "2",
    公司代號: "2317",
    公司名稱: "鴻海",
    營業收入: "3500000000.00",
    "營業利益（損失）": "90000000.00",
    "本期淨利（淨損）": "70000000.00",
  },
];
const balanceRows2330 = [
  {
    出表日期: "1150821",
    年度: "115",
    季別: "2",
    公司代號: "2330",
    公司名稱: "台積電",
    資產總計: "9375654727.00",
    權益總計: "6474470981.00",
  },
];
const incomeRoute: Route = {
  pattern: TWSE_COMPREHENSIVE_INCOME_ENDPOINT,
  body: INCOME_ROWS,
};
const balanceRoute: Route = {
  pattern: TWSE_BALANCE_SHEET_ENDPOINT,
  body: balanceRows2330,
};

describe("twseQuarterPeriodEnd", () => {
  test("maps ROC year + quarter to the period end", () => {
    expect(twseQuarterPeriodEnd("115", "2")?.periodEnd).toBe("2026-06-30");
    expect(twseQuarterPeriodEnd("114", "4")?.periodEnd).toBe("2025-12-31");
    expect(twseQuarterPeriodEnd("115", "1")?.periodEnd).toBe("2026-03-31");
    expect(twseQuarterPeriodEnd("115", "5")).toBeUndefined();
    expect(twseQuarterPeriodEnd("", "2")).toBeUndefined();
  });
});

describe("getTwseFinancials", () => {
  test("maps the canonical concepts, scales NT$ thousands, and labels the period", async () => {
    const fetchFn = routedFetch([basicRoute, incomeRoute, balanceRoute]);
    const { entity, facts, financialSectorVariant } = await getTwseFinancials(
      "2330",
      options(fetchFn),
    );
    expect(entity.stockCode).toBe("2330");
    expect(financialSectorVariant).toBe(false);
    const byConcept = new Map(facts.map((fact) => [fact.concept, fact]));
    // Concept order follows the adapter's canonical sequence.
    expect(facts.map((fact) => fact.concept)).toEqual([
      "revenue",
      "operating_income",
      "net_income",
      "total_assets",
      "stockholders_equity",
    ]);
    // Reported thousands are scaled to whole NT$.
    expect(byConcept.get("revenue")?.value).toBe(2404483690 * 1000);
    expect(byConcept.get("total_assets")?.value).toBe(9375654727 * 1000);
    for (const fact of facts) {
      expect(fact.unit).toBe("TWD");
      expect(fact.periodEnd).toBe("2026-06-30");
      expect(fact.filedDate).toBe("2026-08-21");
      expect(fact.source).toBe("TWSE");
      expect(fact.sourceUrl).toContain("owncode=2330");
    }
    expect(byConcept.get("revenue")?.form).toContain("綜合損益表");
    expect(byConcept.get("total_assets")?.form).toContain("資產負債表");
  });

  test("honours a concepts filter and fetches only the needed statement", async () => {
    const fetchFn = routedFetch([basicRoute, incomeRoute, balanceRoute]);
    const { facts } = await getTwseFinancials(
      { company: "2330", concepts: ["revenue"] },
      options(fetchFn),
    );
    expect(facts.map((fact) => fact.concept)).toEqual(["revenue"]);
    // Balance-sheet dataset is never fetched when only an income concept is asked.
    expect(
      fetchFn.requests.some((request) =>
        request.url.includes(TWSE_BALANCE_SHEET_ENDPOINT),
      ),
    ).toBe(false);
  });

  test("flags a finance/insurance-sector issuer that files a variant format", async () => {
    // 2882 resolves via the basic feed (產業別 17) but is absent from the
    // general-industry statement snapshots, which still carry other issuers.
    const basic: Route = {
      pattern: TWSE_BASIC_ENDPOINT,
      body: [
        { 公司代號: "2882", 公司名稱: "國泰金融控股股份有限公司", 產業別: "17" },
      ],
    };
    const fetchFn = routedFetch([basic, incomeRoute, balanceRoute]);
    const { facts, financialSectorVariant } = await getTwseFinancials(
      "2882",
      options(fetchFn),
    );
    expect(facts).toHaveLength(0);
    expect(financialSectorVariant).toBe(true);
  });

  test("returns an empty result without the sector flag for a general-industry miss", async () => {
    const basic: Route = {
      pattern: TWSE_BASIC_ENDPOINT,
      body: [{ 公司代號: "2454", 公司名稱: "聯發科技股份有限公司", 產業別: "24" }],
    };
    const fetchFn = routedFetch([basic, incomeRoute, balanceRoute]);
    const { facts, financialSectorVariant } = await getTwseFinancials(
      "2454",
      options(fetchFn),
    );
    expect(facts).toHaveLength(0);
    expect(financialSectorVariant).toBe(false);
  });

  test("serves a repeat lookup from the injected cache without refetching", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([basicRoute, incomeRoute, balanceRoute]);
    await getTwseFinancials("2330", { fetchFn, cache });
    const firstCount = fetchFn.requests.length;
    resetTwseDatasetCache();
    await getTwseFinancials("2330", { fetchFn, cache });
    expect(fetchFn.requests.length).toBe(firstCount);
  });

  test("maps an HTTP 429 on the income feed to TwseRateLimitError", async () => {
    const fetchFn = routedFetch([
      basicRoute,
      { pattern: TWSE_COMPREHENSIVE_INCOME_ENDPOINT, body: "rate limited", status: 429 },
    ]);
    await expect(getTwseFinancials("2330", options(fetchFn))).rejects.toBeInstanceOf(
      TwseRateLimitError,
    );
  });
});
