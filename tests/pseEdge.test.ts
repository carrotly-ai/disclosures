import { beforeEach, describe, expect, test } from "bun:test";
import {
  assertPseUrl,
  getPseDocument,
  getPseDocumentPdf,
  getPseDocumentShell,
  getPseFinancials,
  getPseInsiders,
  getPseOwners,
  isPseCompanyId,
  isPseHost,
  isPseSymbol,
  parsePseAutocomplete,
  parsePseDate,
  parsePseDirectory,
  parsePseDisclosureRows,
  parsePseDocumentBody,
  parsePseDocumentShell,
  parsePseFinancialFacts,
  parsePseInsiderDetail,
  parsePsePublicOwnershipDetail,
  parsePseTotal,
  parsePseTransactionId,
  PSE_AUTOCOMPLETE_URL,
  PSE_DIRECTORY_URL,
  PSE_DISCLOSURES_URL,
  PSE_FINANCIAL_REPORTS_URL,
  pseDefaultFinancialsWindow,
  pseViewerUrl,
  PseApiError,
  PseRateLimitError,
  resolvePseCompany,
  searchPseCompanies,
  searchPseDisclosures,
  searchPseFilings,
  toPseDateParam,
} from "../src/adapters/pseEdge.js";
import { pseRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import type { Route } from "./helpers/routedFetch.js";

// Verbatim edge.pse.com.ph responses recorded live on 2026-08-29 for SM
// Investments (cmpyId 599, symbol SM) and Manila Electric (the 17-7 case).
const AUTOCOMPLETE = loadFixture("pse", "autocomplete-sm.json");
const DIRECTORY = loadFixture("pse", "directory-sm.html");
const DISCLOSURES = loadFixture("pse", "disclosures-sm-page1.html");
const DISCLOSURES_13_1 = loadFixture("pse", "disclosures-sm-13-1.html");
const DISCLOSURES_POR = loadFixture("pse", "disclosures-sm-por.html");
const FINANCIAL_REPORTS = loadFixture("pse", "financial-reports-sm.html");
const VIEWER_13_1 = loadFixture("pse", "viewer-13-1.html");
const VIEWER_17_A = loadFixture("pse", "viewer-17-a-attachments.html");
const BODY_13_1 = loadFixture("pse", "body-13-1.html");
const BODY_POR_1 = loadFixture("pse", "body-por-1.html");
const BODY_17_A = loadFixture("pse", "body-17-a.html");
const BODY_17_7 = loadFixture("pse", "body-17-7-attachment-only.html");

/** The edge_no of SM's most recent form 13-1 in the fixtures. */
const EDGE_13_1 = "7ef3ad16b2ae40daec6e1601ccee8f59";
const HTML = { "Content-Type": "text/html; charset=UTF-8" };

/** Routes covering the resolve pair (autocomplete + directory). */
const RESOLVE_ROUTES: Route[] = [
  { pattern: PSE_AUTOCOMPLETE_URL, body: AUTOCOMPLETE, headers: { "Content-Type": "application/json" } },
  { pattern: PSE_DIRECTORY_URL, body: DIRECTORY, headers: HTML },
];

function options(routes: Route[]): AdapterOptions & {
  fetchFn: ReturnType<typeof routedFetch>;
} {
  const fetchFn = routedFetch(routes);
  return { fetchFn };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("PSE EDGE parsing primitives", () => {
  test("parses the autocomplete JSON into company rows", () => {
    const rows = parsePseAutocomplete(JSON.parse(AUTOCOMPLETE));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.symbol).sort()).toEqual(["SM", "SMC", "SMPH"]);
    const sm = rows.find((row) => row.symbol === "SM");
    expect(sm?.cmpyId).toBe("599");
    expect(sm?.cmpyNm).toBe("SM Investments Corporation");
  });

  test("ignores malformed autocomplete payloads rather than inventing rows", () => {
    expect(parsePseAutocomplete(null)).toEqual([]);
    expect(parsePseAutocomplete({ cmpyId: "1" })).toEqual([]);
    // Rows missing the two required fields are dropped, not defaulted.
    expect(parsePseAutocomplete([{ cmpyId: "1" }, { cmpyNm: "X" }])).toEqual([]);
  });

  test("reads company AND security ids out of the directory's cmDetail handler", () => {
    const rows = parsePseDirectory(DIRECTORY);
    expect(rows).toHaveLength(4);
    const sm = rows.find((row) => row.symbol === "SM");
    expect(sm).toMatchObject({
      companyId: "599",
      securityId: "520",
      legalName: "SM Investments Corporation",
      sector: "Holding Firms",
      subsector: "Holding Firms",
      listingDate: "2005-03-22",
    });
    // The ampersand in "Food, Beverage & Tobacco" must survive decoding.
    const gsmi = rows.find((row) => row.symbol === "GSMI");
    expect(gsmi?.subsector).toBe("Food, Beverage & Tobacco");
  });

  test("parses the disclosure table's rows, dates, form and report numbers", () => {
    const rows = parsePseDisclosureRows(DISCLOSURES);
    expect(rows.length).toBeGreaterThan(10);
    const first = rows[0]!;
    expect(first.edgeNo).toMatch(/^[0-9a-f]{32}$/);
    expect(first.filedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.formNumber).toBeTruthy();
    expect(first.reportNumber).toMatch(/^C[R]?\d+-\d{4}$/);
    // Every row must carry an edge_no — a row without one is skipped, never
    // emitted with a placeholder.
    expect(rows.every((row) => /^[0-9a-f]+$/.test(row.edgeNo))).toBe(true);
  });

  test("parses the financial-reports table, which has an extra leading column", () => {
    const rows = parsePseDisclosureRows(FINANCIAL_REPORTS);
    expect(rows.length).toBeGreaterThan(0);
    const annual = rows[0]!;
    // The company-name column precedes the template anchor in this table only;
    // the parser classifies by content, so the form number must not absorb it.
    expect(annual.companyName).toContain("SM Investments");
    expect(annual.template).toContain("Annual Report");
    // PSE labels these with its OWN disclosure form number (17-1 annual / 17-2
    // quarterly); the SEC form named inside the document is 17-A.
    expect(annual.formNumber).toBe("17-1");
  });

  test("reads the [Total N] marker with thousands separators", () => {
    expect(parsePseTotal(DISCLOSURES)).toBeGreaterThan(100);
    expect(parsePseTotal('<span class="count">[Total 35,658]</span>')).toBe(35658);
    expect(parsePseTotal("no marker here")).toBeUndefined();
  });

  test("converts PSE timestamps to ISO dates and back to its filter format", () => {
    expect(parsePseDate("Aug 28, 2026 05:32 PM")).toBe("2026-08-28");
    expect(parsePseDate("Jan 05, 2020")).toBe("2020-01-05");
    expect(parsePseDate("not a date")).toBeUndefined();
    expect(toPseDateParam("2026-08-28")).toBe("08-28-2026");
    expect(toPseDateParam("28/08/2026")).toBeUndefined();
  });

  test("the default financials window spans six years and ends today", () => {
    const window = pseDefaultFinancialsWindow(new Date("2026-08-29T00:00:00Z"));
    expect(window).toEqual({ startDate: "2020-08-29", endDate: "2026-08-29" });
  });

  test("recognises PSE company ids and ticker symbols", () => {
    expect(isPseCompanyId("599")).toBe(true);
    expect(isPseCompanyId("SM")).toBe(false);
    expect(isPseSymbol("SMPH")).toBe(true);
    expect(isPseSymbol("SM")).toBe(true);
    expect(isPseSymbol("TOOLONGSYM")).toBe(false);
  });
});

describe("PSE EDGE SSRF guard", () => {
  test("accepts only https edge.pse.com.ph", () => {
    expect(isPseHost("edge.pse.com.ph")).toBe(true);
    expect(isPseHost("EDGE.PSE.COM.PH")).toBe(true);
    // Deliberately exact-host: a sibling or look-alike host is refused.
    expect(isPseHost("www.pse.com.ph")).toBe(false);
    expect(isPseHost("edge.pse.com.ph.evil.test")).toBe(false);
    expect(isPseHost("evil-edge.pse.com.ph")).toBe(false);
  });

  test("refuses off-host and non-https rebuilt URLs before any fetch", () => {
    expect(assertPseUrl("https://edge.pse.com.ph/downloadHtml.do?file_id=1"))
      .toBe("https://edge.pse.com.ph/downloadHtml.do?file_id=1");
    expect(() => assertPseUrl("https://evil.example.com/downloadHtml.do"))
      .toThrow(PseApiError);
    expect(() => assertPseUrl("http://edge.pse.com.ph/downloadHtml.do"))
      .toThrow(/must be https/);
    expect(() => assertPseUrl("file:///etc/passwd")).toThrow(PseApiError);
    expect(() => assertPseUrl("not a url")).toThrow(PseApiError);
  });

  test("a transaction_id that is an off-host URL is refused, not fetched", async () => {
    const runtime = options([]);
    await expect(
      getPseDocumentShell("https://evil.example.com/openDiscViewer.do?edge_no=abc", runtime),
    ).rejects.toThrow(/edge\.pse\.com\.ph/);
    // The guard runs before the network, so nothing was requested at all.
    expect(runtime.fetchFn.requests).toHaveLength(0);
  });

  test("accepts a bare hash or a genuine EDGE viewer URL", () => {
    expect(parsePseTransactionId(EDGE_13_1)).toBe(EDGE_13_1);
    expect(parsePseTransactionId(` ${EDGE_13_1.toUpperCase()} `)).toBe(EDGE_13_1);
    expect(parsePseTransactionId(pseViewerUrl(EDGE_13_1))).toBe(EDGE_13_1);
    expect(() => parsePseTransactionId("")).toThrow(PseApiError);
    expect(() => parsePseTransactionId("../../etc/passwd")).toThrow(PseApiError);
  });
});

describe("PSE EDGE CompanyResolve", () => {
  test("merges autocomplete and directory hits by company id", async () => {
    const runtime = options(RESOLVE_ROUTES);
    const results = await searchPseCompanies("SM", runtime);
    // 3 autocomplete + 4 directory rows dedupe to the 4 distinct companies.
    expect(results).toHaveLength(4);
    const sm = results.find((entity) => entity.ticker === "SM");
    expect(sm?.legalName).toBe("SM Investments Corporation");
    // The directory row is authoritative, so its richer fields must win.
    expect(sm?.sourceIdentifiers?.pseCompanyId).toBe("599");
    expect(sm?.sourceIdentifiers?.pseSecurityId).toBe("520");
    expect(sm?.listingDate).toBe("2005-03-22");
    expect(sm?.jurisdiction).toBe("PH");
    expect(sm?.source).toBe("PSE");
  });

  test("an exact ticker match outranks a name-prefix match", async () => {
    const results = await searchPseCompanies("SM", options(RESOLVE_ROUTES));
    // "SM Prime Holdings" starts with the query, but SM Investments IS ticker SM.
    expect(results[0]?.ticker).toBe("SM");
    expect(results[0]?.matchReason).toMatch(/Exact PSE ticker-symbol match/);
  });

  test("resolves a symbol to one company", async () => {
    const entity = await resolvePseCompany("SMPH", options(RESOLVE_ROUTES));
    expect(entity.legalName).toBe("SM Prime Holdings, Inc.");
    expect(entity.sourceIdentifiers?.pseCompanyId).toBe("112");
  });

  test("resolves a bare numeric company id to that company", async () => {
    const entity = await resolvePseCompany("154", options([
      { pattern: PSE_AUTOCOMPLETE_URL, body: AUTOCOMPLETE, headers: { "Content-Type": "application/json" } },
      { pattern: PSE_DIRECTORY_URL, body: DIRECTORY, headers: HTML },
    ]));
    expect(entity.legalName).toBe("San Miguel Corporation");
  });

  test("an empty result set throws a matchable not-found message", async () => {
    const empty = '<table class="list"><tbody></tbody></table>';
    await expect(
      resolvePseCompany("Nonexistent Holdings", options([
        { pattern: PSE_AUTOCOMPLETE_URL, body: "[]", headers: { "Content-Type": "application/json" } },
        { pattern: PSE_DIRECTORY_URL, body: empty, headers: HTML },
      ])),
    // The wording must match tools/shared.ts's not-found regex so a genuine
    // miss degrades to "Could not find" rather than an isError result.
    ).rejects.toThrow(/No PSE company found/i);
  });

  test("survives one of the two resolve paths failing", async () => {
    // The autocomplete 500s; the directory alone still answers.
    const results = await searchPseCompanies("SM", options([
      { pattern: PSE_AUTOCOMPLETE_URL, body: "boom", status: 500 },
      { pattern: PSE_DIRECTORY_URL, body: DIRECTORY, headers: HTML },
    ]));
    expect(results.length).toBe(4);
  });

  test("a total upstream failure propagates rather than returning empty", async () => {
    await expect(
      resolvePseCompany("SM", options([
        { pattern: PSE_AUTOCOMPLETE_URL, body: "down", status: 503 },
        { pattern: PSE_DIRECTORY_URL, body: "down", status: 503 },
      ])),
    ).rejects.toThrow(/No PSE company found/);
  });
});

describe("PSE EDGE CompanyFilings", () => {
  test("filters by keyword=<cmpyId>, NOT companyId", async () => {
    const runtime = options([...RESOLVE_ROUTES, { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]);
    await searchPseFilings({ company: "SM", limit: 5 }, runtime);
    const post = runtime.fetchFn.requests.find(({ url }) =>
      url.includes(PSE_DISCLOSURES_URL)
    );
    const body = String(post?.init?.body ?? "");
    // This is the live-verified trap: `companyId` is silently ignored by this
    // endpoint and returns the whole market.
    expect(body).toContain("keyword=599");
    expect(body).not.toContain("companyId=");
  });

  test("maps rows to filings carrying the edge_no as the transaction id", async () => {
    const { entity, filings, recordsTotal } = await searchPseFilings(
      { company: "SM", limit: 5 },
      options([...RESOLVE_ROUTES, { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]),
    );
    expect(entity.ticker).toBe("SM");
    expect(filings).toHaveLength(5);
    expect(recordsTotal).toBeGreaterThan(5);
    const first = filings[0]!;
    expect(first.accession).toMatch(/^[0-9a-f]{32}$/);
    expect(first.sourceUrl).toBe(pseViewerUrl(first.accession!));
    expect(first.source).toBe("PSE");
    expect(first.sourceIdentifiers?.pseEdgeNo).toBe(first.accession);
    expect(first.sourceIdentifiers?.pseCompanyId).toBe("599");
  });

  test("passes a template filter through as tmplNm", async () => {
    const runtime = options([
      ...RESOLVE_ROUTES,
      { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES_13_1, headers: HTML },
    ]);
    const { filings } = await searchPseFilings(
      { company: "SM", template: "Change in Shareholdings" },
      runtime,
    );
    const body = String(
      runtime.fetchFn.requests.find(({ url }) => url.includes(PSE_DISCLOSURES_URL))?.init?.body ?? "",
    );
    expect(body).toContain("tmplNm=Change+in+Shareholdings");
    expect(filings.every((filing) => filing.category?.includes("Change in Shareholdings"))).toBe(true);
  });

  test("applies a date window client-side and stops at the window's start", async () => {
    const rows = parsePseDisclosureRows(DISCLOSURES);
    const cutoff = rows[3]!.filedDate!;
    const { rows: windowed } = await searchPseDisclosures(
      { companyId: "599", startDate: cutoff, limit: 50 },
      options([{ pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]),
    );
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((row) => (row.filedDate ?? "") >= cutoff)).toBe(true);
  });

  test("an end_date excludes newer rows without ending the walk", async () => {
    const rows = parsePseDisclosureRows(DISCLOSURES);
    const end = rows[2]!.filedDate!;
    const { rows: windowed } = await searchPseDisclosures(
      { companyId: "599", endDate: end, limit: 10 },
      options([{ pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]),
    );
    expect(windowed.every((row) => (row.filedDate ?? "") <= end)).toBe(true);
  });

  test("honours the limit and reports truncation", async () => {
    const { rows, truncated } = await searchPseDisclosures(
      { companyId: "599", limit: 3 },
      options([{ pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]),
    );
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  test("pages until the limit is met", async () => {
    const runtime = options([
      { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML },
    ]);
    await searchPseDisclosures({ companyId: "599", limit: 100, maxPages: 3 }, runtime);
    const pages = runtime.fetchFn.requests
      .filter(({ url }) => url.includes(PSE_DISCLOSURES_URL))
      .map(({ init }) => String(init?.body ?? "").match(/pageNo=(\d+)/)?.[1]);
    // The fixture page has fewer than PSE's 50 rows, so the walk stops after
    // page 1 rather than requesting pages that cannot exist.
    expect(pages[0]).toBe("1");
  });

  test("an empty index returns no rows rather than throwing", async () => {
    const empty = '<span class="count">[Total 0]</span><table class="list"><tbody>' +
      '<tr><td colspan="4" class="alignC">no data.</td></tr></tbody></table>';
    const { rows, recordsTotal } = await searchPseDisclosures(
      { companyId: "599" },
      options([{ pattern: PSE_DISCLOSURES_URL, body: empty, headers: HTML }]),
    );
    expect(rows).toEqual([]);
    expect(recordsTotal).toBe(0);
  });

  test("an upstream 500 surfaces as a PseApiError", async () => {
    await expect(
      searchPseDisclosures(
        { companyId: "599" },
        options([{ pattern: PSE_DISCLOSURES_URL, body: "boom", status: 500 }]),
      ),
    ).rejects.toThrow(PseApiError);
  });

  test("an upstream 429 surfaces as a rate-limit error", async () => {
    await expect(
      searchPseDisclosures(
        { companyId: "599" },
        options([{ pattern: PSE_DISCLOSURES_URL, body: "slow down", status: 429 }]),
      ),
    ).rejects.toThrow(PseRateLimitError);
  });

  test("the local rate limiter trips before hammering PSE", async () => {
    for (let i = 0; i < 90; i += 1) pseRateLimiter.tryAcquire();
    await expect(
      searchPseDisclosures(
        { companyId: "599" },
        options([{ pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES, headers: HTML }]),
      ),
    ).rejects.toThrow(PseRateLimitError);
  });
});

describe("PSE EDGE CompanyDocument (the three-hop viewer flow)", () => {
  test("resolves the viewer shell to the body file id and attachments", () => {
    const shell = parsePseDocumentShell(VIEWER_17_A, "abc");
    expect(shell.bodyFileId).toBe("1900966");
    expect(shell.bodyUrl).toContain("/downloadHtml.do?file_id=1900966");
    expect(shell.attachments).toHaveLength(3);
    expect(shell.attachments[0]).toMatchObject({
      fileId: "1900968",
      postedDate: "2026-04-16",
    });
    // The option label's leading date is stripped from the filename.
    expect(shell.attachments[0]?.filename).toMatch(/^01 SM Investments.*\.pdf$/);
    expect(shell.attachments[0]?.url).toContain("/downloadFile.do?file_id=1900968");
  });

  test("a viewer without an iframe fails honestly instead of guessing", () => {
    expect(() => parsePseDocumentShell("<html><body>gone</body></html>", "abc"))
      .toThrow(/carried no document iframe/);
  });

  test("walks all three hops and parses the document body", async () => {
    const runtime = options([
      { pattern: "openDiscViewer.do", body: VIEWER_13_1, headers: HTML },
      { pattern: "downloadHtml.do", body: BODY_13_1, headers: HTML },
    ]);
    const document = await getPseDocument(EDGE_13_1, runtime);
    expect(document.formNumber).toBe("13-1");
    expect(document.formTitle).toContain("Change in Shareholdings");
    expect(document.issuerName).toBe("SM Investments Corporation");
    expect(document.symbol).toBe("SM");
    expect(document.text).toContain("Henry T. Sy, Jr.");
    // Hop order matters: the viewer must be read before the body it names.
    expect(runtime.fetchFn.requests[0]?.url).toContain("openDiscViewer.do");
    expect(runtime.fetchFn.requests[1]?.url).toContain("downloadHtml.do?file_id=");
  });

  test("extracts label/value fields from the form layout", async () => {
    const shell = parsePseDocumentShell(VIEWER_13_1, EDGE_13_1);
    const body = parsePseDocumentBody(BODY_13_1, shell);
    const person = body.fields.find((field) => /^Name of Person/i.test(field.label));
    expect(person?.value).toBe("Henry T. Sy, Jr.");
    const position = body.fields.find((field) => /^Position/i.test(field.label));
    expect(position?.value).toBe("Vice Chairman");
  });

  test("downloads a PDF attachment and verifies its magic bytes", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33]);
    const result = await getPseDocumentPdf(EDGE_13_1, options([
      { pattern: "openDiscViewer.do", body: VIEWER_17_A, headers: HTML },
      { pattern: "downloadFile.do", body: pdf },
    ]));
    expect(result.byteLength).toBe(8);
    expect(result.suggestedFilename).toMatch(/\.pdf$/);
    expect(result.sourceUrl).toContain("edge.pse.com.ph/downloadFile.do");
  });

  test("refuses non-PDF bytes rather than saving them as a PDF", async () => {
    await expect(
      getPseDocumentPdf(EDGE_13_1, options([
        { pattern: "openDiscViewer.do", body: VIEWER_17_A, headers: HTML },
        { pattern: "downloadFile.do", body: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]) },
      ])),
    ).rejects.toThrow(/not a PDF/);
  });

  test("a disclosure with no attachments says so instead of inventing one", async () => {
    // The 13-1 viewer fixture's file_list is the empty "Select" option only.
    const noAttachments = VIEWER_13_1.replace(
      /<select[\s\S]*?<\/select>/i,
      '<select id="file_list"><option value="">Select</option></select>',
    );
    await expect(
      getPseDocumentPdf(EDGE_13_1, options([
        { pattern: "openDiscViewer.do", body: noAttachments, headers: HTML },
      ])),
    ).rejects.toThrow(/no file attachments/);
  });
});

describe("PSE EDGE CompanyInsiders (form 13-1)", () => {
  const INSIDER_ROUTES: Route[] = [
    ...RESOLVE_ROUTES,
    { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES_13_1, headers: HTML },
    { pattern: "openDiscViewer.do", body: VIEWER_13_1, headers: HTML },
    { pattern: "downloadHtml.do", body: BODY_13_1, headers: HTML },
  ];

  test("parses person, position, dated transaction and resulting holdings", () => {
    const shell = parsePseDocumentShell(VIEWER_13_1, EDGE_13_1);
    const body = parsePseDocumentBody(BODY_13_1, shell);
    const rows = parsePseInsiderDetail(
      body,
      { edgeNo: EDGE_13_1, template: "Change in Shareholdings", filedDate: "2025-08-19" },
      "599",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Henry T. Sy, Jr.",
      officerRole: "Vice Chairman",
      occupation: "Acquired",
      notifiedDate: "2025-08-12",
      change: 2_771_777,
      form: expect.stringContaining("13-1"),
    });
    // The resulting direct/indirect position is carried, not dropped.
    expect(rows[0]?.status).toContain("direct 1,861,182");
    expect(rows[0]?.status).toContain("indirect 77,788,965");
  });

  test("a body without a reporting person yields no fabricated row", () => {
    const shell = parsePseDocumentShell(VIEWER_13_1, EDGE_13_1);
    const body = parsePseDocumentBody(BODY_17_7, shell);
    expect(parsePseInsiderDetail(body, { edgeNo: "x", template: "t" }, "599")).toEqual([]);
  });

  test("lists every index row and parses detail for the opened ones", async () => {
    const { entity, rows, detailedCount } = await getPseInsiders(
      { company: "SM" },
      options(INSIDER_ROUTES),
    );
    expect(entity.ticker).toBe("SM");
    expect(rows.length).toBeGreaterThan(0);
    expect(detailedCount).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("Henry T. Sy, Jr.");
    expect(rows[0]?.sourceIdentifiers?.pseEdgeNo).toBeTruthy();
  });

  test("an unparseable document degrades to a link-only row, not a failure", async () => {
    const { rows, detailedCount, detailNote } = await getPseInsiders(
      { company: "SM" },
      options([
        ...RESOLVE_ROUTES,
        { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES_13_1, headers: HTML },
        { pattern: "openDiscViewer.do", body: "gone", status: 500 },
      ]),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(detailedCount).toBe(0);
    // The rows still exist and still link out — nothing is silently dropped.
    expect(rows.every((row) => row.name === "(see linked disclosure)")).toBe(true);
    expect(rows.every((row) => row.sourceUrl.includes("openDiscViewer.do"))).toBe(true);
    expect(detailNote).toMatch(/did not parse/);
  });

  test("no 13-1 disclosures returns an empty list, not an error", async () => {
    const empty = '<span class="count">[Total 0]</span><table class="list"><tbody></tbody></table>';
    const { rows } = await getPseInsiders({ company: "SM" }, options([
      ...RESOLVE_ROUTES,
      { pattern: PSE_DISCLOSURES_URL, body: empty, headers: HTML },
    ]));
    expect(rows).toEqual([]);
  });
});

describe("PSE EDGE CompanyOwners (POR-1 roster and 17-7 dealings)", () => {
  test("parses named holders with their category, totals and percentages", () => {
    const shell = parsePseDocumentShell(VIEWER_13_1, "por");
    const body = parsePseDocumentBody(BODY_POR_1, shell);
    const owners = parsePsePublicOwnershipDetail(
      body,
      { edgeNo: "por", template: "Public Ownership Report", filedDate: "2026-07-10" },
      "599",
    );
    expect(owners.length).toBeGreaterThan(10);
    const teresita = owners.find((owner) => owner.holderName === "Teresita T. Sy");
    expect(teresita).toMatchObject({
      holderType: "Directors",
      pct: 7.3,
      change: 88_719_462,
      machineReadable: true,
    });
    // The substantial-stockholder section must be recognised as its own group.
    const hans = owners.find((owner) => owner.holderName === "Hans T. Sy");
    expect(hans?.holderType).toBe("Principal/Substantial Stockholders");
    expect(hans?.pct).toBe(8.38);
    // The report date is carried from the body, not from the filing date.
    expect(teresita?.notifiedDate).toBe("2026-06-30");
    // Section subtotal rows are unnamed and must not become holders.
    expect(owners.some((owner) => /^\d/.test(owner.holderName))).toBe(false);
  });

  test("names the PH threshold regime the templates actually cite", () => {
    const shell = parsePseDocumentShell(VIEWER_13_1, "por");
    const body = parsePseDocumentBody(BODY_POR_1, shell);
    const owners = parsePsePublicOwnershipDetail(
      body, { edgeNo: "por", template: "t" }, "599",
    );
    // SRC Rule 23 + the Minimum Public Ownership rule — NOT SRC Rule 18.
    expect(owners[0]?.thresholdRegime).toContain("Rule 23");
    expect(owners[0]?.thresholdRegime).not.toContain("Rule 18");
  });

  test("returns the latest roster by default", async () => {
    const { rows, reportDate, detailedCount } = await getPseOwners(
      { company: "SM" },
      options([
        ...RESOLVE_ROUTES,
        { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES_POR, headers: HTML },
        { pattern: "openDiscViewer.do", body: VIEWER_13_1, headers: HTML },
        { pattern: "downloadHtml.do", body: BODY_POR_1, headers: HTML },
      ]),
    );
    expect(detailedCount).toBe(1);
    expect(reportDate).toBe("2026-06-30");
    expect(rows.length).toBeGreaterThan(10);
  });

  test("a 17-7 whose substance is in an attachment stays honestly thin", async () => {
    const { rows } = await getPseOwners(
      { company: "SM", mode: "dealings" },
      options([
        ...RESOLVE_ROUTES,
        { pattern: PSE_DISCLOSURES_URL, body: DISCLOSURES_POR, headers: HTML },
        { pattern: "openDiscViewer.do", body: VIEWER_13_1, headers: HTML },
        { pattern: "downloadHtml.do", body: BODY_17_7, headers: HTML },
      ]),
    );
    // The body names the reporting person but carries no figures — the row must
    // reflect exactly that, with no invented share counts.
    const named = rows.find((row) => row.holderName === "Erville D. Magtubo");
    expect(named).toBeDefined();
    expect(named?.pct).toBeUndefined();
    expect(named?.change).toBeUndefined();
    expect(named?.holderType).toContain("Vice President");
  });

  test("no ownership reports returns an empty list", async () => {
    const empty = '<span class="count">[Total 0]</span><table class="list"><tbody></tbody></table>';
    const { rows } = await getPseOwners({ company: "SM" }, options([
      ...RESOLVE_ROUTES,
      { pattern: PSE_DISCLOSURES_URL, body: empty, headers: HTML },
    ]));
    expect(rows).toEqual([]);
  });
});

describe("PSE EDGE CompanyFinancials (17-A / 17-Q)", () => {
  const FINANCIAL_ROUTES: Route[] = [
    ...RESOLVE_ROUTES,
    { pattern: PSE_FINANCIAL_REPORTS_URL, body: FINANCIAL_REPORTS, headers: HTML },
    { pattern: "openDiscViewer.do", body: VIEWER_17_A, headers: HTML },
    { pattern: "downloadHtml.do", body: BODY_17_A, headers: HTML },
  ];

  test("filters by companyId, NOT keyword, and always sends a window", async () => {
    const runtime = options(FINANCIAL_ROUTES);
    await getPseFinancials({ company: "SM" }, runtime);
    const body = String(
      runtime.fetchFn.requests.find(({ url }) =>
        url.includes(PSE_FINANCIAL_REPORTS_URL)
      )?.init?.body ?? "",
    );
    // The mirror image of the disclosures endpoint — verified live.
    expect(body).toContain("companyId=599");
    expect(body).not.toContain("keyword=");
    // A windowless call returns [Total 0] upstream, so a window is mandatory.
    expect(body).toMatch(/fromDate=\d{2}-\d{2}-\d{4}/);
    expect(body).toMatch(/toDate=\d{2}-\d{2}-\d{4}/);
  });

  test("extracts headline figures and scales the thousands multiplier", () => {
    const shell = parsePseDocumentShell(VIEWER_17_A, "annual");
    const body = parsePseDocumentBody(BODY_17_A, shell);
    const { facts, periodEnd } = parsePseFinancialFacts(
      body,
      { edgeNo: "annual", template: "Annual Report", formNumber: "17-A", filedDate: "2026-04-16" },
      "599",
    );
    expect(periodEnd).toBe("2025-12-31");
    const assets = facts.find((fact) => fact.concept === "Assets");
    // The form prints 1,811,801 "in thousands" → 1,811,801,000 pesos.
    expect(assets?.value).toBe(1_811_801_000);
    expect(assets?.unit).toBe("PHP");
    expect(assets?.basis).toBe("consolidated");
    // Per-share figures are NOT scaled by the thousands multiplier.
    const eps = facts.find((fact) => fact.concept === "EarningsPerShareBasic");
    expect(eps?.value).toBe(74.16);
  });

  test("takes only the current period, never the comparative column", () => {
    const shell = parsePseDocumentShell(VIEWER_17_A, "annual");
    const body = parsePseDocumentBody(BODY_17_A, shell);
    const { facts } = parsePseFinancialFacts(
      body, { edgeNo: "a", template: "Annual Report" }, "599",
    );
    // One fact per concept: emitting the prior-year column too would double-count.
    const concepts = facts.map((fact) => fact.concept);
    expect(new Set(concepts).size).toBe(concepts.length);
    const revenue = facts.find((fact) => fact.concept === "Revenue");
    expect(revenue?.value).toBe(681_733_000);
  });

  test("an exact label match does not absorb a ratio formula line", () => {
    const shell = parsePseDocumentShell(VIEWER_17_A, "annual");
    const body = parsePseDocumentBody(BODY_17_A, shell);
    const { facts } = parsePseFinancialFacts(
      body, { edgeNo: "a", template: "Annual Report" }, "599",
    );
    // "Total Assets / Total Liabilities" is the solvency-ratio formula; the
    // Assets fact must be the balance-sheet figure, not the ratio's 2.1.
    expect(facts.find((fact) => fact.concept === "Assets")?.value).toBe(1_811_801_000);
  });

  test("returns facts through the full call path", async () => {
    const result = await getPseFinancials({ company: "SM" }, options(FINANCIAL_ROUTES));
    expect(result.facts.length).toBeGreaterThan(10);
    expect(result.report?.formNumber).toBe("17-1");
    expect(result.report?.sourceUrl).toContain("openDiscViewer.do");
    expect(result.reason).toBeUndefined();
  });

  test("a report whose body will not parse degrades to a link, not a guess", async () => {
    const result = await getPseFinancials({ company: "SM" }, options([
      ...RESOLVE_ROUTES,
      { pattern: PSE_FINANCIAL_REPORTS_URL, body: FINANCIAL_REPORTS, headers: HTML },
      { pattern: "openDiscViewer.do", body: VIEWER_17_A, headers: HTML },
      { pattern: "downloadHtml.do", body: BODY_17_7, headers: HTML },
    ]));
    expect(result.facts).toEqual([]);
    expect(result.reason).toBe("unparsed");
    // The report link survives so the caller can still reach the document.
    expect(result.report?.sourceUrl).toContain("openDiscViewer.do");
  });

  test("no report in the window is reported honestly", async () => {
    const empty = '<span class="count">[Total 0]</span><table class="list"><tbody></tbody></table>';
    const result = await getPseFinancials({ company: "SM" }, options([
      ...RESOLVE_ROUTES,
      { pattern: PSE_FINANCIAL_REPORTS_URL, body: empty, headers: HTML },
    ]));
    expect(result.facts).toEqual([]);
    expect(result.reason).toBe("no-report");
    expect(result.report).toBeUndefined();
  });
});
