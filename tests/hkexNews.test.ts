import { beforeEach, describe, expect, test } from "bun:test";
import {
  getHkexDocumentMetadata,
  getHkexDocumentPdf,
  getLatestHkexAnnualReport,
  HKEXNEWS_DOCUMENT_MAX_BYTES,
  HkexNewsApiError,
  HkexNewsRateLimitError,
  isHkStockCode,
  normalizeHkStockCode,
  resetHkexStockListCache,
  resolveHkexCompany,
  searchHkexCompanies,
  searchHkexFilings,
} from "../src/adapters/hkexNews.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

// activestock_sehk_e.json rows: {i:stockId, c:code, n:name, s:seq}. Tencent's
// internal stockId is 7609 (NOT the s=15375 field, NOT the public code 00700).
const STOCK_LIST = [
  { i: 1, c: "00001", n: "CKH HOLDINGS", s: 3790 },
  { i: 5, c: "00005", n: "HSBC HOLDINGS", s: 7282 },
  { i: 7609, c: "00700", n: "TENCENT", s: 15375 },
];

const stockListRoute: Route = {
  pattern: "activestock_sehk_e.json",
  body: STOCK_LIST,
};

// titleSearchServlet returns { result: "<stringified array>" }. Two Tencent rows.
function servletBody(rows: unknown[]): Record<string, unknown> {
  return { result: JSON.stringify(rows), hasNextRow: false, rowRange: rows.length, lang: "E" };
}

const FILING_ROWS = [
  {
    NEWS_ID: "12292377",
    TITLE: "Next Day Disclosure Return",
    LONG_TEXT: "Next Day Disclosure Returns - [Share Buyback]",
    STOCK_CODE: "00700<br/>80700",
    STOCK_NAME: "TENCENT<br/>TENCENT-R",
    DATE_TIME: "20/08/2026 17:35",
    FILE_TYPE: "PDF",
    FILE_INFO: "88KB",
    FILE_LINK: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
  },
  {
    NEWS_ID: "12290295",
    TITLE: "Announcement",
    LONG_TEXT: "Poll Results of the AGM",
    STOCK_CODE: "00700",
    STOCK_NAME: "TENCENT",
    DATE_TIME: "19/08/2026 12:01",
    FILE_TYPE: "PDF",
    FILE_INFO: "120KB",
    FILE_LINK: "/listedco/listconews/sehk/2026/0819/2026081900123.pdf",
  },
];

const searchRoute: Route = {
  pattern: "titleSearchServlet.do",
  body: servletBody(FILING_ROWS),
};

beforeEach(() => {
  resetRateLimiters();
  resetHkexStockListCache();
});

describe("hkexNews helpers", () => {
  test("recognises and normalises HK stock codes", () => {
    expect(isHkStockCode("700")).toBe(true);
    expect(isHkStockCode("00700")).toBe(true);
    expect(isHkStockCode("AAPL")).toBe(false);
    expect(normalizeHkStockCode("700")).toBe("00700");
    expect(normalizeHkStockCode("00005")).toBe("00005");
  });
});

describe("searchHkexCompanies", () => {
  test("resolves a short code to the internal stockId (700 → 7609/00700)", async () => {
    const fetchFn = routedFetch([stockListRoute]);
    const results = await searchHkexCompanies("700", options(fetchFn));
    expect(results).toHaveLength(1);
    const tencent = results[0];
    expect(tencent?.legalName).toBe("TENCENT");
    expect(tencent?.stockCode).toBe("00700");
    expect(tencent?.hkexStockId).toBe("7609");
    expect(tencent?.jurisdiction).toBe("HK");
    expect(tencent?.source).toBe("HKEXnews");
    expect(tencent?.matchReason).toBe("Exact stock-code match");
    expect(tencent?.sourceIdentifiers?.hkexStockId).toBe("7609");
  });

  test("ranks a name query and carries the stockId", async () => {
    const fetchFn = routedFetch([stockListRoute]);
    const results = await searchHkexCompanies("tencent", options(fetchFn));
    expect(results[0]?.hkexStockId).toBe("7609");
    expect(results[0]?.matchReason).toContain("match");
  });

  test("returns empty for a blank query without a network call", async () => {
    const fetchFn = routedFetch([stockListRoute]);
    expect(await searchHkexCompanies("  ", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("resolveHkexCompany returns the top hit or null", async () => {
    const fetchFn = routedFetch([stockListRoute]);
    expect((await resolveHkexCompany("00700", options(fetchFn)))?.hkexStockId).toBe("7609");
    expect(await resolveHkexCompany("99999", options(fetchFn))).toBeNull();
  });
});

describe("searchHkexFilings", () => {
  test("resolves the stockId, maps rows and builds absolute PDF links", async () => {
    const fetchFn = routedFetch([stockListRoute, searchRoute]);
    const filings = await searchHkexFilings(
      { company: "700", startDate: "2026-07-01", endDate: "2026-08-21" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(2);
    const ndr = filings.find((f) => f.accession === "/listedco/listconews/sehk/2026/0820/2026082000673.pdf");
    expect(ndr?.form).toBe("Next Day Disclosure Return");
    expect(ndr?.description).toBe("Next Day Disclosure Returns - [Share Buyback]");
    expect(ndr?.filedDate).toBe("2026-08-20");
    expect(ndr?.source).toBe("HKEXnews");
    expect(ndr?.sourceUrl).toBe(
      "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
    );
    // The servlet request carried the internal stockId and the date window.
    const req = fetchFn.requests.find((r) => r.url.includes("titleSearchServlet.do"));
    expect(req?.url).toContain("stockId=7609");
    expect(req?.url).toContain("fromDate=20260701");
    expect(req?.url).toContain("toDate=20260821");
    expect(req?.url).toContain("market=SEHK");
  });

  test("applies a case-insensitive form filter and respects limit", async () => {
    const fetchFn = routedFetch([stockListRoute, searchRoute]);
    const filings = await searchHkexFilings(
      { company: "700", forms: ["poll results"] },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.description).toBe("Poll Results of the AGM");

    const limited = await searchHkexFilings({ company: "700", limit: 1 }, options(routedFetch([stockListRoute, searchRoute])));
    expect(limited).toHaveLength(1);
  });

  test("getLatestHkexAnnualReport queries the annual category codes", async () => {
    const annualRow = {
      NEWS_ID: "12000001",
      TITLE: "Annual Report 2025",
      LONG_TEXT: "Annual Report 2025",
      STOCK_NAME: "TENCENT",
      DATE_TIME: "15/04/2026 08:00",
      FILE_TYPE: "PDF",
      FILE_LINK: "/listedco/listconews/sehk/2026/0415/2026041500001.pdf",
    };
    const fetchFn = routedFetch([
      stockListRoute,
      { pattern: "titleSearchServlet.do", body: servletBody([annualRow]) },
    ]);
    const report = await getLatestHkexAnnualReport("700", options(fetchFn));
    expect(report?.form).toBe("Annual Report 2025");
    expect(report?.accession).toBe("/listedco/listconews/sehk/2026/0415/2026041500001.pdf");
    const req = fetchFn.requests.find((r) => r.url.includes("titleSearchServlet.do"));
    expect(req?.url).toContain("t1code=40000");
    expect(req?.url).toContain("t2code=40100");
  });

  test("returns empty when the servlet yields no rows", async () => {
    const fetchFn = routedFetch([
      stockListRoute,
      { pattern: "titleSearchServlet.do", body: servletBody([]) },
    ]);
    expect(await searchHkexFilings("700", options(fetchFn))).toHaveLength(0);
  });
});

describe("HKEXnews documents", () => {
  const DOC_PATH = "/listedco/listconews/sehk/2026/0820/2026082000673.pdf";

  test("metadata reads content-type and length via a HEAD request", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "2026082000673.pdf",
        body: "",
        headers: { "content-type": "application/pdf", "content-length": "90568" },
      },
    ]);
    const meta = await getHkexDocumentMetadata(DOC_PATH, options(fetchFn));
    expect(meta.filename).toBe("2026082000673.pdf");
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.byteLength).toBe(90568);
    expect(meta.sourceUrl).toBe(`https://www1.hkexnews.hk${DOC_PATH}`);
    expect(fetchFn.requests[0]?.init?.method).toBe("HEAD");
  });

  test("pdf downloads bytes, counts pages and reports the source url", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\n/Type /Page\n/Type /Page\n%%EOF");
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: pdfBytes }]);
    const pdf = await getHkexDocumentPdf(DOC_PATH, options(fetchFn));
    expect(pdf.byteLength).toBe(pdfBytes.byteLength);
    expect(pdf.pageCount).toBe(2);
    expect(pdf.suggestedFilename).toBe("2026082000673.pdf");
    expect(pdf.sourceUrl).toBe(`https://www1.hkexnews.hk${DOC_PATH}`);
  });

  test("pdf rejects a response above the 25 MB cap", async () => {
    const big = new Uint8Array(HKEXNEWS_DOCUMENT_MAX_BYTES + 1);
    big.set(new TextEncoder().encode("%PDF-"), 0);
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: big }]);
    await expect(getHkexDocumentPdf(DOC_PATH, options(fetchFn))).rejects.toBeInstanceOf(
      HkexNewsApiError,
    );
  });

  test("pdf rejects a non-PDF body", async () => {
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: new TextEncoder().encode("<html>nope</html>") }]);
    await expect(getHkexDocumentPdf(DOC_PATH, options(fetchFn))).rejects.toBeInstanceOf(
      HkexNewsApiError,
    );
  });

  test("rejects a transaction_id that leaves the hkexnews host (no SSRF)", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      getHkexDocumentMetadata("https://evil.example.com/x.pdf", options(fetchFn)),
    ).rejects.toBeInstanceOf(HkexNewsApiError);
    // Validation happens before any network call.
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("rate limiting + failures", () => {
  test("maps an HTTP 429 on the stock list to a rate-limit error", async () => {
    const fetchFn = routedFetch([
      { pattern: "activestock_sehk_e.json", body: "rate limited", status: 429 },
    ]);
    await expect(searchHkexCompanies("700", options(fetchFn))).rejects.toBeInstanceOf(
      HkexNewsRateLimitError,
    );
  });

  test("throws a not-found error when the company does not resolve for filings", async () => {
    const fetchFn = routedFetch([stockListRoute]);
    await expect(searchHkexFilings("99999", options(fetchFn))).rejects.toThrow(
      /No HKEXnews company found/,
    );
  });
});
