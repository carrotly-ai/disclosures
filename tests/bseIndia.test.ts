import { beforeEach, describe, expect, test } from "bun:test";
import {
  BSE_ATTACHMENT_HIS_BASE_URL,
  BSE_ATTACHMENT_LIVE_BASE_URL,
  BSE_DOCUMENT_MAX_BYTES,
  BSE_SITE_URL,
  BseApiError,
  BseDocumentTooLargeError,
  BseRateLimitError,
  createBseAdapter,
  getBseDocumentMetadata,
  getBseDocumentPdf,
  getBseFilings,
  isBseScripCode,
  parseBsePeerSearch,
  resolveBseCompany,
  resolveBseDocumentReference,
  searchBseCompanies,
  searchBseFilings,
} from "../src/adapters/bseIndia.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { buildSimplePdf } from "./helpers/pdfFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn };
}

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

function announcement(
  newsId: string,
  attachmentName: string,
  headline: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NEWSID: newsId,
    SCRIP_CD: "500325",
    HEADLINE: headline,
    NEWSSUB: "Reliance Industries Ltd",
    CATEGORYNAME: "Result",
    SUBCATNAME: "Financial Results",
    NEWS_DT: "2026-04-21T18:30:00",
    ATTACHMENTNAME: attachmentName,
    ...overrides,
  };
}

function page(
  rows: Array<Record<string, unknown>>,
  total: number | string = rows.length,
): Record<string, unknown> {
  return { Table: rows, Table1: [{ ROWCNT: total }] };
}

const RESULT_NEWS_ID = "news-abc123";
const RESULT_ATTACHMENT = "attachment-def456.pdf";
const AGM_NEWS_ID = "news-no-attachment";

const ANNOUNCEMENTS = page([
  announcement(RESULT_NEWS_ID, RESULT_ATTACHMENT, "Board Meeting Outcome &amp; Results"),
  announcement(AGM_NEWS_ID, "", "Notice of AGM", {
    CATEGORYNAME: "AGM/EGM",
    SUBCATNAME: null,
    NEWS_DT: "2026-03-10T11:00:00",
  }),
]);

const announcementRoute: Route = {
  pattern: "AnnSubCategoryGetData",
  body: ANNOUNCEMENTS,
};

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

describe("BSE announcement discovery", () => {
  test("uses the current endpoint and exposes attachment filenames as transaction ids", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchBseFilings(
      { company: "500325", startDate: "2026-01-01", endDate: "2026-05-01" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(2);
    const result = filings.find((filing) => filing.accession === RESULT_ATTACHMENT);
    expect(result?.description).toBe("Board Meeting Outcome & Results");
    expect(result?.form).toBe("Result");
    expect(result?.category).toBe("Financial Results");
    expect(result?.filedDate).toBe("2026-04-21");
    expect(result?.source).toBe("BSE India");
    expect(result?.sourceIdentifiers?.bseNewsId).toBe(RESULT_NEWS_ID);
    expect(result?.sourceUrl).toBe(
      `${BSE_ATTACHMENT_HIS_BASE_URL}/${RESULT_ATTACHMENT}`,
    );

    const agm = filings.find(
      (filing) => filing.sourceIdentifiers?.bseNewsId === AGM_NEWS_ID,
    );
    expect(agm?.accession).toBeUndefined();
    expect(agm?.sourceUrl).toBe(`${BSE_SITE_URL}/corporates/ann.html`);

    const request = fetchFn.requests.find(({ url }) =>
      url.includes("AnnSubCategoryGetData")
    );
    expect(request?.url).toContain("pageno=1");
    expect(request?.url).toContain("subcategory=-1");
    expect(request?.url).toContain("strScrip=500325");
    expect(request?.url).toContain("strPrevDate=20260101");
    expect(request?.url).toContain("strToDate=20260501");
  });

  test("paginates until a selective match appears and deduplicates NEWSID", async () => {
    const firstRows = Array.from({ length: 50 }, (_, index) =>
      announcement(
        index === 49 ? "duplicate-news" : `page1-${index}`,
        `page1-${index}.pdf`,
        `Routine announcement ${index}`,
      )
    );
    const secondRows = [
      announcement("duplicate-news", "duplicate.pdf", "Duplicate row"),
      announcement("annual-news", "annual-report.pdf", "Integrated Annual Report", {
        CATEGORYNAME: "Annual Report",
      }),
    ];
    const fetchFn = routedFetch([
      searchRoute,
      { pattern: /pageno=1(?:&|$)/, body: page(firstRows, "52") },
      { pattern: /pageno=2(?:&|$)/, body: page(secondRows, 52) },
    ]);
    const result = await getBseFilings(
      { company: "500325", forms: ["annual report"], limit: 5 },
      options(fetchFn),
    );
    expect(result.filings).toHaveLength(1);
    expect(result.filings[0]?.accession).toBe("annual-report.pdf");
    expect(result.totalRows).toBe(52);
    expect(result.pagesScanned).toBe(2);
    expect(result.scanTruncated).toBe(false);
  });

  test("reports scan truncation when the 1,000-row ceiling is reached", async () => {
    const routes: Route[] = [searchRoute];
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      routes.push({
        pattern: new RegExp(`pageno=${pageNumber}(?:&|$)`),
        body: page(
          Array.from({ length: 50 }, (_, index) =>
            announcement(
              `p${pageNumber}-${index}`,
              `p${pageNumber}-${index}.pdf`,
              `Routine ${pageNumber}-${index}`,
            )
          ),
          1_100,
        ),
      });
    }
    const result = await getBseFilings(
      { company: "500325", forms: ["never matches"], limit: 5 },
      options(routedFetch(routes)),
    );
    expect(result.filings).toHaveLength(0);
    expect(result.pagesScanned).toBe(20);
    expect(result.scanTruncated).toBe(true);
  });

  test("accepts the exact no-record envelope as an honest empty result", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      { pattern: "AnnSubCategoryGetData", body: "No Record Found!" },
    ]);
    const result = await getBseFilings("500325", options(fetchFn));
    expect(result).toEqual({
      filings: [],
      totalRows: 0,
      pagesScanned: 1,
      scanTruncated: false,
    });
  });

  for (const [label, body] of [
    ["HTML anti-bot shell", "<!doctype html><title>Access Denied</title>"],
    ["JSON false", "false"],
    ["missing Table1", { Table: [] }],
    ["negative ROWCNT", { Table: [], Table1: [{ ROWCNT: -1 }] }],
    ["fractional ROWCNT", { Table: [], Table1: [{ ROWCNT: 1.5 }] }],
    ["nonnumeric ROWCNT", { Table: [], Table1: [{ ROWCNT: "many" }] }],
  ] as const) {
    test(`rejects ${label} instead of returning a false empty result`, async () => {
      const fetchFn = routedFetch([
        searchRoute,
        { pattern: "AnnSubCategoryGetData", body },
      ]);
      await expect(getBseFilings("500325", options(fetchFn))).rejects.toBeInstanceOf(
        BseApiError,
      );
    });
  }

  test("applies a case-insensitive form filter", async () => {
    const fetchFn = routedFetch([searchRoute, announcementRoute]);
    const filings = await searchBseFilings(
      { company: "500325", forms: ["agm"] },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.sourceIdentifiers?.bseNewsId).toBe(AGM_NEWS_ID);
  });
});

describe("BSE filing documents", () => {
  const filename = "document-123.pdf";
  const pdf = buildSimplePdf("BT /F1 12 Tf (BSE filing text) Tj ET");
  const pdfHeaders = {
    "Content-Type": "application/pdf",
    "Content-Length": String(pdf.byteLength),
    "Last-Modified": "Tue, 01 Sep 2026 01:02:03 GMT",
  };

  test("normalizes a bare filename and either official attachment URL", () => {
    expect(resolveBseDocumentReference(filename)).toEqual({
      transactionId: filename,
      filename,
    });
    expect(
      resolveBseDocumentReference(`${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`),
    ).toEqual({ transactionId: filename, filename });
    expect(
      resolveBseDocumentReference(`${BSE_ATTACHMENT_LIVE_BASE_URL}/${filename}`),
    ).toEqual({ transactionId: filename, filename });
  });

  for (const invalid of [
    "http://www.bseindia.com/xml-data/corpfiling/AttachHis/document.pdf",
    "https://evil.example/xml-data/corpfiling/AttachHis/document.pdf",
    "https://www.bseindia.com.evil.example/xml-data/corpfiling/AttachHis/document.pdf",
    "https://www.bseindia.com:8443/xml-data/corpfiling/AttachHis/document.pdf",
    "https://user:pass@www.bseindia.com/xml-data/corpfiling/AttachHis/document.pdf",
    "https://www.bseindia.com/other/document.pdf",
    "https://www.bseindia.com/xml-data/corpfiling/AttachHis/nested/document.pdf",
    "https://www.bseindia.com/xml-data/corpfiling/AttachHis/document.pdf?x=1",
    "https://www.bseindia.com/xml-data/corpfiling/AttachHis/document.pdf#x",
    "%2e%2e%2fdocument.pdf",
    "document.txt",
  ]) {
    test(`rejects unsafe reference ${invalid}`, () => {
      expect(() => resolveBseDocumentReference(invalid)).toThrow(BseApiError);
    });
  }

  test("probes metadata with HEAD plus a PDF range request", async () => {
    const fetchFn = routedFetch([{
      pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
      body: pdf,
      headers: pdfHeaders,
    }]);
    const metadata = await getBseDocumentMetadata(filename, options(fetchFn));
    expect(metadata.transactionId).toBe(filename);
    expect(metadata.sourceUrl).toBe(`${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`);
    expect(metadata.contentType).toBe("application/pdf");
    expect(metadata.byteLength).toBe(pdf.byteLength);
    expect(metadata.lastModified).toBe("Tue, 01 Sep 2026 01:02:03 GMT");
    expect(metadata.overLimit).toBe(false);
    expect(fetchFn.requests.map(({ init }) => init?.method)).toEqual(["HEAD", "GET"]);
    expect(
      (fetchFn.requests[1]?.init?.headers as Record<string, string>)?.Range,
    ).toBe("bytes=0-4");
  });

  test("prefers AttachHis and falls back to AttachLive only after a 404", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
        body: "missing",
        status: 404,
      },
      {
        pattern: `${BSE_ATTACHMENT_LIVE_BASE_URL}/${filename}`,
        body: pdf,
        headers: pdfHeaders,
      },
    ]);
    const result = await getBseDocumentPdf(filename, options(fetchFn));
    expect(result.sourceUrl).toBe(`${BSE_ATTACHMENT_LIVE_BASE_URL}/${filename}`);
    expect(result.bytes).toEqual(pdf);
    expect(fetchFn.requests).toHaveLength(2);
  });

  test("downloads a valid PDF with exact bytes and page count", async () => {
    const fetchFn = routedFetch([{
      pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
      body: pdf,
      headers: pdfHeaders,
    }]);
    const result = await getBseDocumentPdf(filename, options(fetchFn));
    expect(result.bytes).toEqual(pdf);
    expect(result.byteLength).toBe(pdf.byteLength);
    expect(result.pageCount).toBe(1);
    expect(result.suggestedFilename).toBe(filename);
    expect(result.lastModified).toBe("Tue, 01 Sep 2026 01:02:03 GMT");
  });

  test("refuses an off-host redirect before requesting the target", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
        body: "",
        status: 302,
        headers: { location: "https://evil.example/document.pdf" },
      },
      { pattern: "evil.example", body: pdf },
    ]);
    await expect(getBseDocumentPdf(filename, options(fetchFn))).rejects.toBeInstanceOf(
      BseApiError,
    );
    expect(fetchFn.requests).toHaveLength(1);
  });

  test("rejects a non-PDF 200 response", async () => {
    const fetchFn = routedFetch([{
      pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
      body: "<!doctype html><title>Access Denied</title>",
      headers: { "Content-Type": "text/html" },
    }]);
    await expect(getBseDocumentPdf(filename, options(fetchFn))).rejects.toBeInstanceOf(
      BseApiError,
    );
  });

  test("maps document HTTP 429 to BseRateLimitError", async () => {
    const fetchFn = routedFetch([{
      pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
      body: "blocked",
      status: 429,
    }]);
    await expect(getBseDocumentPdf(filename, options(fetchFn))).rejects.toBeInstanceOf(
      BseRateLimitError,
    );
  });

  test("reports a declared over-cap document without reading it", async () => {
    const fetchFn = routedFetch([{
      pattern: `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`,
      body: pdf,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(BSE_DOCUMENT_MAX_BYTES + 1),
      },
    }]);
    const error = await getBseDocumentPdf(filename, options(fetchFn)).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(BseDocumentTooLargeError);
    expect((error as BseDocumentTooLargeError).metadata.byteLength).toBe(
      BSE_DOCUMENT_MAX_BYTES + 1,
    );
    expect((error as BseDocumentTooLargeError).metadata.overLimit).toBe(true);
  });

  test("adapter factory exposes document methods", () => {
    const adapter = createBseAdapter(options(routedFetch([])));
    expect(typeof adapter.getDocumentMetadata).toBe("function");
    expect(typeof adapter.getDocumentPdf).toBe("function");
  });
});

describe("BSE HTTP errors", () => {
  test("maps an HTTP 429 on search to BseRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: "PeerSmartSearch", body: "blocked", status: 429 },
    ]);
    await expect(searchBseCompanies("500325", options(fetchFn))).rejects.toBeInstanceOf(
      BseRateLimitError,
    );
  });

  test("maps an HTTP 403 announcement block to BseApiError", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      { pattern: "AnnSubCategoryGetData", body: "blocked", status: 403 },
    ]);
    await expect(getBseFilings("500325", options(fetchFn))).rejects.toBeInstanceOf(
      BseApiError,
    );
  });
});
