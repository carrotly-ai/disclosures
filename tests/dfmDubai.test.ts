import { beforeEach, describe, expect, test } from "bun:test";
import {
  DFM_DOCUMENT_BASE_URL,
  DFM_EFSAH_URL,
  DFM_WIDGETS_URL,
  DfmApiError,
  DfmRateLimitError,
  dfmDocumentUrl,
  getDfmDocumentMetadata,
  getDfmDocumentPdf,
  getDfmFilings,
  isDfmDisclosureType,
  isDfmSymbol,
  isWeakDfmMatch,
  parseDfmDisclosureRow,
  parseDfmDisclosures,
  parseDfmJson,
  parseDfmRoster,
  resetDfmSecuritiesCache,
  resolveDfmCompany,
  resolveDfmDocumentUrl,
  searchDfmCompanies,
  searchDfmFilings,
} from "../src/adapters/dfmDubai.js";
import { dfmRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { buildSimplePdf, buildImagePdf } from "./helpers/pdfFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import type { Route } from "./helpers/routedFetch.js";

// Verbatim api2.dfm.ae responses recorded live on 2026-08-29: the widget
// gateway's LiteSecuritiesLists roster (English + Arabic, subset to the issuers
// under test) and the efsah disclosure feed for EMAAR and Emirates NBD. The
// efsah fixtures keep the upstream's UTF-8 BOM and CRLF line endings, because
// stripping the BOM is part of what the parser is being tested on.
const ROSTER_EN = loadFixture("dfm", "securities-en.json");
const ROSTER_AR = loadFixture("dfm", "securities-ar.json");
const EMAAR = loadFixture("dfm", "efsah-emaar.json");
const EMAAR_PAGE2 = loadFixture("dfm", "efsah-emaar-page2.json");
const EMAAR_Q1 = loadFixture("dfm", "efsah-emaar-q1-2026.json");
const EMAAR_FINANCIALS = loadFixture("dfm", "efsah-emaar-financial-reports.json");
const ENBD = loadFixture("dfm", "efsah-emiratesnbd.json");
const EMPTY = loadFixture("dfm", "efsah-empty.json");

/** The efsah `r_path` of Emaar's H1 2026 English press release. */
const EMAAR_PRESS_RELEASE_PATH =
  "/2026/Aug/7/52433569-0887-4100-ba14-58ee448166f1/" +
  "Emaar Properties H1 2026 Press Release   English.P.pdf";

/**
 * The roster is one POST endpoint serving two languages off the request body,
 * which the routed stub keys by URL only — so language is disambiguated with a
 * small custom fetch wrapper around it.
 */
function dfmFetch(routes: Route[]): ReturnType<typeof routedFetch> {
  const inner = routedFetch(routes);
  const stub = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(DFM_WIDGETS_URL)) {
      const body = String(init?.body ?? "");
      const arabic = /Language=ar/.test(body);
      stub.requests.push(init === undefined ? { url } : { url, init });
      return new Response(arabic ? ROSTER_AR : ROSTER_EN, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const response = await inner(url, init);
    stub.requests.push(...inner.requests.splice(0));
    return response;
  }) as ReturnType<typeof routedFetch>;
  stub.requests = [];
  return stub;
}

function options(fetchFn: ReturnType<typeof routedFetch>): AdapterOptions {
  return { fetchFn, env: {} };
}

beforeEach(() => {
  resetRateLimiters();
  resetDfmSecuritiesCache();
});

describe("dfmDubai helpers", () => {
  test("recognises DFM symbols but not names", () => {
    expect(isDfmSymbol("EMAAR")).toBe(true);
    expect(isDfmSymbol("emiratesnbd")).toBe(true);
    expect(isDfmSymbol("SALAM_BAH")).toBe(true);
    expect(isDfmSymbol("TAKAFUL-EM")).toBe(true);
    expect(isDfmSymbol("Emaar Properties PJSC")).toBe(false);
    expect(isDfmSymbol("إعمار العقارية ش.م.ع")).toBe(false);
    expect(isDfmSymbol("E")).toBe(false); // single character
  });

  test("recognises the feed's own disclosure-type filters", () => {
    expect(isDfmDisclosureType("financial_reports")).toBe(true);
    expect(isDfmDisclosureType("general_meetings")).toBe(true);
    expect(isDfmDisclosureType("10-K")).toBe(false);
  });

  test("strips the upstream BOM before parsing JSON", () => {
    expect(parseDfmJson('﻿{"root":[]}')).toEqual({ root: [] });
    expect(() => parseDfmJson("<html>challenge</html>")).toThrow(DfmApiError);
    expect(() => parseDfmJson("   ")).toThrow(DfmApiError);
  });

  test("percent-encodes each r_path segment onto the feeds host", () => {
    expect(dfmDocumentUrl("/2026/Aug/7/abc/Press Release   English.P.pdf")).toBe(
      `${DFM_DOCUMENT_BASE_URL}/2026/Aug/7/abc/` +
        "Press%20Release%20%20%20English.P.pdf",
    );
    // A path arriving without the leading slash resolves the same way.
    expect(dfmDocumentUrl("2026/Aug/7/abc/x.pdf")).toBe(
      `${DFM_DOCUMENT_BASE_URL}/2026/Aug/7/abc/x.pdf`,
    );
  });

  test("keeps only equity-class roster lists", () => {
    const rows = parseDfmRoster(JSON.parse(ROSTER_EN));
    const symbols = rows.map((row) => row.symbol);
    expect(symbols).toContain("EMAAR");
    expect(symbols).toContain("DUBAIRESI"); // REIT
    expect(symbols).toContain("CHAE"); // ETF
    expect(symbols).toContain("AMCUAE"); // fund
    // Matured sukuk tranches share an issuer with the equity line and would
    // otherwise swamp a name search, so debt lists are excluded outright.
    expect(symbols.some((symbol) => symbol.startsWith("EMAAR0"))).toBe(false);
    expect(parseDfmRoster({})).toEqual([]);
    expect(parseDfmRoster("not a record")).toEqual([]);
  });
});

describe("searchDfmCompanies", () => {
  test("resolves an exact DFM symbol with its Arabic name and sector", async () => {
    const fetchFn = dfmFetch([]);
    const entity = await resolveDfmCompany("EMAAR", options(fetchFn));
    expect(entity?.dfmSymbol).toBe("EMAAR");
    expect(entity?.ticker).toBe("EMAAR");
    expect(entity?.legalName).toBe("Emaar Properties PJSC");
    // Arabic round-trips through the roster merge intact.
    expect(entity?.aliases).toEqual(["إعمار العقارية ش.م.ع"]);
    expect(entity?.jurisdiction).toBe("AE");
    expect(entity?.source).toBe("DFM");
    expect(entity?.status).toBe("Listed (DFM)");
    expect(entity?.matchReason).toBe("Exact DFM symbol match");
    expect(entity?.sourceIdentifiers?.dfmSymbol).toBe("EMAAR");
    expect(entity?.sourceIdentifiers?.sector).toBe("Real Estate");
    expect(entity?.sourceUrl).toContain("id=EMAAR");
  });

  test("resolves a lowercase symbol and an English name", async () => {
    const fetchFn = dfmFetch([]);
    expect((await resolveDfmCompany("salik", options(fetchFn)))?.dfmSymbol)
      .toBe("SALIK");
    const byName = await resolveDfmCompany("Emirates NBD PJSC", options(fetchFn));
    expect(byName?.dfmSymbol).toBe("EMIRATESNBD");
    expect(byName?.matchReason).toBe("Exact normalized legal-name match");
  });

  test("resolves an issuer by its Arabic name", async () => {
    const fetchFn = dfmFetch([]);
    const entity = await resolveDfmCompany("إعمار العقارية ش.م.ع", options(fetchFn));
    expect(entity?.dfmSymbol).toBe("EMAAR");
    expect(entity?.legalName).toBe("Emaar Properties PJSC");
  });

  test("drops zero-overlap candidates instead of padding the result", async () => {
    const fetchFn = dfmFetch([]);
    // Nothing on DFM shares a token with this, so the honest answer is nothing.
    expect(await searchDfmCompanies("Zzyzx Widgets", options(fetchFn))).toEqual([]);
  });

  test("flags a shared-generic-token-only result as a weak match", async () => {
    const fetchFn = dfmFetch([]);
    // Aldar Properties is an ADX (Abu Dhabi) issuer: it is not on DFM, so the
    // only hits share the word "Properties" and must not read as an answer.
    const results = await searchDfmCompanies("Aldar Properties", options(fetchFn));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entity) => entity.legalName !== "Aldar Properties")).toBe(true);
    expect(isWeakDfmMatch(results)).toBe(true);
    // A genuine hit is never flagged weak.
    expect(isWeakDfmMatch(await searchDfmCompanies("EMAAR", options(fetchFn))))
      .toBe(false);
    expect(isWeakDfmMatch([])).toBe(false);
  });

  test("returns nothing for a blank query and never calls upstream", async () => {
    const fetchFn = dfmFetch([]);
    expect(await searchDfmCompanies("   ", options(fetchFn))).toEqual([]);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("surfaces an upstream failure rather than an empty roster", async () => {
    const fetchFn = (async () =>
      new Response("Service Unavailable", { status: 503 })) as AdapterOptions["fetchFn"];
    await expect(resolveDfmCompany("EMAAR", { fetchFn })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  test("maps a 429 to the typed rate-limit error", async () => {
    const fetchFn = (async () =>
      new Response("slow down", { status: 429 })) as AdapterOptions["fetchFn"];
    await expect(resolveDfmCompany("EMAAR", { fetchFn })).rejects.toThrow(
      DfmRateLimitError,
    );
  });

  test("trips its own rate limiter rather than hammering the gateway", async () => {
    while (dfmRateLimiter.tryAcquire()) {
      // drain
    }
    const fetchFn = dfmFetch([]);
    await expect(resolveDfmCompany("EMAAR", options(fetchFn))).rejects.toThrow(
      DfmRateLimitError,
    );
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("parseDfmDisclosureRow", () => {
  test("emits one filing per attached document, with the r_path as its id", () => {
    const filings = parseDfmDisclosures(parseDfmJson(EMAAR));
    const press = filings.find((filing) =>
      filing.accession === EMAAR_PRESS_RELEASE_PATH
    );
    expect(press).toBeDefined();
    expect(press?.filedDate).toBe("2026-08-07");
    expect(press?.form).toBe(
      "Press Release regarding financial results for the 2nd QTR of 2026",
    );
    expect(press?.source).toBe("DFM");
    expect(press?.sourceIdentifiers?.dfmSymbol).toBe("EMAAR");
    expect(press?.sourceIdentifiers?.jurisdiction).toBe("AE");
    expect(press?.sourceUrl).toBe(dfmDocumentUrl(EMAAR_PRESS_RELEASE_PATH));
    expect(press?.description).toContain("Emaar Properties PJSC");
  });

  test("labels a financial-report resource and carries the quarter", () => {
    const filings = parseDfmDisclosures(parseDfmJson(EMAAR_FINANCIALS));
    const q2 = filings.find((filing) =>
      filing.form === "Financial statements for the 2nd QTR of 2026"
    );
    expect(q2?.category).toContain("Financial report");
    expect(q2?.category).toContain("Q2");
    expect(q2?.category).toContain("EN");
  });

  test("splits a multi-document disclosure into separate fetchable rows", () => {
    const filings = parseDfmDisclosures(parseDfmJson(ENBD));
    const q2 = filings.filter((filing) =>
      filing.form === "Financial statements for the 2nd QTR of 2026"
    );
    // Emirates NBD filed statements plus a results presentation under one
    // disclosure; each needs its own transaction_id.
    expect(q2.length).toBeGreaterThan(1);
    expect(new Set(q2.map((filing) => filing.accession)).size).toBe(q2.length);
  });

  test("keeps a disclosure with no attachment as a link-only row", () => {
    const filings = parseDfmDisclosureRow({
      id: "row-1",
      publication_date: "2026-08-07 09:01:11",
      headline: "Board meeting outcome",
      issuer_symbol: "EMAAR",
      issuer: "EMAAR - Emaar Properties PJSC",
      announcement_type: "Disclosure",
      resources: [],
    });
    expect(filings).toHaveLength(1);
    expect(filings[0]?.accession).toBeUndefined();
    expect(filings[0]?.sourceUrl).toContain("id=EMAAR");
  });

  test("drops a row with no headline or no parseable date", () => {
    expect(parseDfmDisclosureRow({ publication_date: "2026-08-07 09:01:11" }))
      .toEqual([]);
    expect(parseDfmDisclosureRow({ headline: "x", publication_date: "not a date" }))
      .toEqual([]);
  });

  test("falls back to the feed's default 'MMM dd, yyyy' stamp", () => {
    const filings = parseDfmDisclosureRow({
      id: "row-2",
      publication_date: "Aug 07, 2026 09:01:11 AM",
      headline: "Press release",
      issuer_symbol: "EMAAR",
      resources: [],
    });
    expect(filings[0]?.filedDate).toBe("2026-08-07");
  });
});

describe("getDfmFilings", () => {
  test("returns an issuer's disclosures newest first, honouring limit", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMAAR }]);
    const { entity, filings } = await getDfmFilings(
      { company: "EMAAR", limit: 5 },
      options(fetchFn),
    );
    expect(entity.dfmSymbol).toBe("EMAAR");
    expect(filings).toHaveLength(5);
    const dates = filings.map((filing) => filing.filedDate);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(fetchFn.requests.some(({ url }) => url.includes("symbol=EMAAR")))
      .toBe(true);
  });

  test("passes a date window through as the feed's from/to params", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMAAR_Q1 }]);
    const { filings } = await getDfmFilings({
      company: "EMAAR",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    }, options(fetchFn));
    const feedRequest = fetchFn.requests.find(({ url }) =>
      url.includes("prototype_efsah")
    );
    expect(feedRequest?.url).toContain("from=2026-01-01");
    expect(feedRequest?.url).toContain("to=2026-03-31");
    expect(filings.length).toBe(9);
    for (const filing of filings) {
      expect(filing.filedDate >= "2026-01-01").toBe(true);
      expect(filing.filedDate <= "2026-03-31").toBe(true);
    }
  });

  test("sends the feed's own type filter for financial_reports", async () => {
    const fetchFn = dfmFetch([
      { pattern: DFM_EFSAH_URL, body: EMAAR_FINANCIALS },
    ]);
    await getDfmFilings(
      { company: "EMAAR", disclosureType: "financial_reports", limit: 5 },
      options(fetchFn),
    );
    expect(
      fetchFn.requests.some(({ url }) => url.includes("types=financial_reports")),
    ).toBe(true);
  });

  test("filters client-side on a free-text form term", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMAAR }]);
    const { filings } = await getDfmFilings(
      { company: "EMAAR", forms: ["press release"] },
      options(fetchFn),
    );
    expect(filings.length).toBeGreaterThan(0);
    for (const filing of filings) {
      expect(
        `${filing.form} ${filing.description}`.toLowerCase(),
      ).toContain("press release");
    }
  });

  test("pages on skip for a limit above the feed's 20-row clamp", async () => {
    let call = 0;
    const inner = dfmFetch([]);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.startsWith(DFM_EFSAH_URL)) {
        fetchFn.requests.push({ url });
        call += 1;
        return new Response(call === 1 ? EMAAR : EMAAR_PAGE2, { status: 200 });
      }
      return inner(url, init);
    }) as ReturnType<typeof routedFetch>;
    fetchFn.requests = [];
    const { filings, truncated } = await getDfmFilings(
      { company: "EMAAR", limit: 30 },
      options(fetchFn),
    );
    expect(filings.length).toBe(30);
    expect(truncated).toBe(true);
    expect(fetchFn.requests.some(({ url }) => url.includes("skip=20"))).toBe(true);
  });

  test("retries the gateway's intermittent empty 200 body", async () => {
    // Measured live: roughly 1 request in 20 answers 200 text/html with a
    // zero-length body. Treating that as {"root":[]} would report "no
    // disclosures" for an issuer that has hundreds, so it is retried once.
    let call = 0;
    const inner = dfmFetch([]);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.startsWith(DFM_EFSAH_URL)) {
        fetchFn.requests.push({ url });
        call += 1;
        return call === 1
          ? new Response("", { status: 200, headers: { "Content-Type": "text/html" } })
          : new Response(EMAAR, { status: 200 });
      }
      return inner(url, init);
    }) as ReturnType<typeof routedFetch>;
    fetchFn.requests = [];
    const { filings } = await getDfmFilings(
      { company: "EMAAR", limit: 3 },
      options(fetchFn),
    );
    expect(filings).toHaveLength(3);
    expect(call).toBe(2);
  });

  test("surfaces a persistent empty body as an upstream glitch, not no data", async () => {
    const inner = dfmFetch([]);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.startsWith(DFM_EFSAH_URL)) {
        return new Response("", { status: 200, headers: { "Content-Type": "text/html" } });
      }
      return inner(url, init);
    }) as ReturnType<typeof routedFetch>;
    fetchFn.requests = [];
    await expect(
      getDfmFilings({ company: "EMAAR" }, options(fetchFn)),
    ).rejects.toThrow(/NOT an empty result for the issuer/);
  });

  test("returns an empty list (not an error) when the feed has no rows", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMPTY }]);
    const filings = await searchDfmFilings("EMAAR", options(fetchFn));
    expect(filings).toEqual([]);
  });

  test("surfaces an unresolvable issuer as a not-found error", async () => {
    const fetchFn = dfmFetch([]);
    await expect(
      getDfmFilings({ company: "" }, options(fetchFn)),
    ).rejects.toThrow(/No DFM company found/);
  });

  test("propagates an upstream feed failure", async () => {
    const fetchFn = dfmFetch([
      { pattern: DFM_EFSAH_URL, body: "boom", status: 500 },
    ]);
    await expect(
      getDfmFilings({ company: "EMAAR" }, options(fetchFn)),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("resolveDfmDocumentUrl (SSRF guard)", () => {
  test("rebuilds a bare r_path onto the feeds host", () => {
    const reference = resolveDfmDocumentUrl(EMAAR_PRESS_RELEASE_PATH);
    expect(reference.url).toBe(dfmDocumentUrl(EMAAR_PRESS_RELEASE_PATH));
    expect(reference.filename).toBe(
      "Emaar Properties H1 2026 Press Release   English.P.pdf",
    );
    expect(reference.path).toContain("/documents/efsah/");
  });

  test("accepts a full feeds.dfm.ae URL round-tripped from CompanyFilings", () => {
    const url = dfmDocumentUrl(EMAAR_PRESS_RELEASE_PATH);
    expect(resolveDfmDocumentUrl(url).url).toBe(url);
  });

  test("accepts a path that already carries the /documents/efsah prefix", () => {
    const withPrefix = `/documents/efsah${EMAAR_PRESS_RELEASE_PATH}`;
    expect(resolveDfmDocumentUrl(withPrefix).url).toBe(
      dfmDocumentUrl(EMAAR_PRESS_RELEASE_PATH),
    );
  });

  test("refuses an off-host URL", () => {
    for (const hostile of [
      "https://evil.example.com/documents/efsah/x.pdf",
      "https://feeds.dfm.ae.evil.example.com/x.pdf",
      "http://feeds.dfm.ae/documents/efsah/x.pdf", // plain http
      "file:///etc/passwd",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      expect(() => resolveDfmDocumentUrl(hostile)).toThrow(DfmApiError);
      expect(() => resolveDfmDocumentUrl(hostile)).toThrow(/Refusing to fetch/);
    }
  });

  test("refuses an empty transaction id", () => {
    expect(() => resolveDfmDocumentUrl("   ")).toThrow(/transaction_id/);
  });

  test("never issues a request for a rejected host", async () => {
    const fetchFn = dfmFetch([]);
    await expect(
      getDfmDocumentPdf("https://evil.example.com/x.pdf", options(fetchFn)),
    ).rejects.toThrow(/Refusing to fetch/);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("getDfmDocumentMetadata / getDfmDocumentPdf", () => {
  test("reports content type, size and last-modified from a HEAD", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "554089",
          "Last-Modified": "Fri, 07 Aug 2026 03:57:29 GMT",
        },
      })) as AdapterOptions["fetchFn"];
    const metadata = await getDfmDocumentMetadata(EMAAR_PRESS_RELEASE_PATH, {
      fetchFn,
    });
    expect(metadata.contentType).toBe("application/pdf");
    expect(metadata.byteLength).toBe(554089);
    expect(metadata.lastModified).toBe("Fri, 07 Aug 2026 03:57:29 GMT");
    expect(metadata.filename).toBe(
      "Emaar Properties H1 2026 Press Release   English.P.pdf",
    );
  });

  test("reports a missing document honestly", async () => {
    const fetchFn = (async () =>
      new Response("not found", { status: 404 })) as AdapterOptions["fetchFn"];
    await expect(
      getDfmDocumentMetadata(EMAAR_PRESS_RELEASE_PATH, { fetchFn }),
    ).rejects.toThrow(/has no document at/);
  });

  test("downloads a PDF and counts its pages", async () => {
    const pdf = buildSimplePdf("BT (Emaar H1 2026 results) Tj ET");
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: pdf }]);
    const result = await getDfmDocumentPdf(EMAAR_PRESS_RELEASE_PATH, {
      fetchFn,
    });
    expect(result.byteLength).toBe(pdf.byteLength);
    expect(result.pageCount).toBe(1);
    expect(result.suggestedFilename).toMatch(/\.pdf$/i);
    expect(result.sourceUrl).toContain("feeds.dfm.ae");
  });

  test("refuses a body that is not a PDF", async () => {
    const fetchFn = routedFetch([
      { pattern: "feeds.dfm.ae", body: "<html>error</html>" },
    ]);
    await expect(
      getDfmDocumentPdf(EMAAR_PRESS_RELEASE_PATH, { fetchFn }),
    ).rejects.toThrow(/returned no PDF/);
  });

  test("says a ZIP archive filing is a ZIP, not a wrong transaction id", async () => {
    // Pre-2012 archive disclosures are sometimes filed zipped — verified live
    // on /Archive/Financial Reports/upp_2011_Q3_e.zip (application/x-zip-
    // compressed). Reporting that as "the transaction_id may be wrong" would
    // be false: the id is right, the filed document is simply not a PDF.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: zip }]);
    await expect(
      getDfmDocumentPdf("/Archive/Financial Reports/upp_2011_Q3_e.zip", { fetchFn }),
    ).rejects.toThrow(/filed this disclosure as a ZIP archive/);
    await expect(
      getDfmDocumentPdf("/Archive/Financial Reports/upp_2011_Q3_e.zip", { fetchFn }),
    ).rejects.toThrow(/transaction_id is correct/);
  });

  test("refuses a document above the 25 MB cap", async () => {
    const oversized = new Uint8Array(26 * 1024 * 1024);
    oversized.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: oversized }]);
    await expect(
      getDfmDocumentPdf(EMAAR_PRESS_RELEASE_PATH, { fetchFn }),
    ).rejects.toThrow(/download cap/);
  });

  test("still downloads a scanned, text-less PDF (the caller reports it)", async () => {
    const scanned = buildImagePdf();
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: scanned }]);
    const result = await getDfmDocumentPdf(EMAAR_PRESS_RELEASE_PATH, { fetchFn });
    expect(result.byteLength).toBe(scanned.byteLength);
  });
});
