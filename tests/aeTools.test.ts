import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import {
  DFM_EFSAH_URL,
  DFM_WIDGETS_URL,
  resetDfmSecuritiesCache,
} from "../src/adapters/dfmDubai.js";
import { JURISDICTION_REFERENCE } from "../src/core/jurisdictionReference.js";
import type { AdapterOptions, ToolResult } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { buildImagePdf, buildTextLayoutPdf } from "./helpers/pdfFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import type { Route } from "./helpers/routedFetch.js";

const ROSTER_EN = loadFixture("dfm", "securities-en.json");
const ROSTER_AR = loadFixture("dfm", "securities-ar.json");
const EMAAR = loadFixture("dfm", "efsah-emaar.json");
const EMAAR_Q1 = loadFixture("dfm", "efsah-emaar-q1-2026.json");
const EMAAR_FINANCIALS = loadFixture("dfm", "efsah-emaar-financial-reports.json");
const EMPTY = loadFixture("dfm", "efsah-empty.json");

const EMAAR_PRESS_RELEASE_PATH =
  "/2026/Aug/7/52433569-0887-4100-ba14-58ee448166f1/" +
  "Emaar Properties H1 2026 Press Release   English.P.pdf";

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

/** Serve the roster POST by request-body language; everything else routed. */
function dfmFetch(routes: Route[]): ReturnType<typeof routedFetch> {
  const inner = routedFetch(routes);
  const stub = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(DFM_WIDGETS_URL)) {
      stub.requests.push({ url });
      return new Response(/Language=ar/.test(String(init?.body ?? "")) ? ROSTER_AR : ROSTER_EN, {
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

// GLEIF enrichment is best-effort on the AE resolve path; most tests stub it to
// an empty collection so a resolve exercises DFM alone.
const GLEIF_EMPTY: Route = { pattern: "api.gleif.org", body: { data: [] } };

function tools(fetchFn: AdapterOptions["fetchFn"]) {
  return createTools({ fetchFn, env: {} });
}

beforeEach(() => {
  resetRateLimiters();
  resetDfmSecuritiesCache();
});

describe("AE CompanyResolve", () => {
  test("resolves a DFM symbol with English and Arabic names", async () => {
    const fetchFn = dfmFetch([GLEIF_EMPTY]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Dubai Financial Market");
    expect(text).toContain("Emaar Properties PJSC");
    // Arabic survives the Markdown table rendering intact.
    expect(text).toContain("إعمار العقارية ش.م.ع");
    expect(text).toContain("DFM EMAAR");
    expect(text).toContain("Real Estate");
    // The Dubai-only scope limit is stated on every AE resolve.
    expect(text).toContain("DUBAI ONLY");
    expect(text).toContain("ADX");
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      candidates: Array<{ dfmSymbol?: string; jurisdiction?: string }>;
    };
    expect(structured.candidates[0]?.dfmSymbol).toBe("EMAAR");
    expect(structured.candidates[0]?.jurisdiction).toBe("AE");
  });

  test("resolves by issuer name and by Arabic name", async () => {
    const fetchFn = dfmFetch([GLEIF_EMPTY]);
    const byName = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "Emirates NBD PJSC",
      jurisdiction: "AE",
    } as never);
    expect(resultText(byName)).toContain("DFM EMIRATESNBD");

    resetDfmSecuritiesCache();
    const arabic = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "إعمار العقارية ش.م.ع",
      jurisdiction: "AE",
    } as never);
    expect(resultText(arabic)).toContain("DFM EMAAR");
  });

  test("enriches the top match with a UAE LEI from GLEIF", async () => {
    // GLEIF's real record for Emaar carries jurisdiction "AE-DU" (the Dubai
    // ISO 3166-2 subdivision), not a bare "AE" — an equality test would reject
    // nearly every genuine UAE match, so the prefix form is what is asserted.
    const fetchFn = dfmFetch([{
      pattern: "api.gleif.org",
      body: {
        data: [{
          type: "lei-records",
          id: "254900YWYEXYXK1BMP81",
          attributes: {
            lei: "254900YWYEXYXK1BMP81",
            entity: {
              legalName: { name: "Emaar Properties (P.J.S.C.)", language: "en" },
              jurisdiction: "AE-DU",
              status: "ACTIVE",
            },
          },
        }],
      },
    }]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).toContain("254900YWYEXYXK1BMP81");
    expect(text).toContain("LEI via GLEIF");
  });

  test("ignores a same-named non-UAE GLEIF record", async () => {
    const fetchFn = dfmFetch([{
      pattern: "api.gleif.org",
      body: {
        data: [{
          type: "lei-records",
          id: "213800AAAAAAAAAAAA11",
          attributes: {
            lei: "213800AAAAAAAAAAAA11",
            entity: {
              legalName: { name: "Emaar Properties PJSC" },
              jurisdiction: "GB",
              status: "ACTIVE",
            },
          },
        }],
      },
    }]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).not.toContain("213800AAAAAAAAAAAA11");
    expect(text).toContain("Emaar Properties PJSC");
  });

  test("a GLEIF failure never fails the DFM resolve", async () => {
    const fetchFn = dfmFetch([
      { pattern: "api.gleif.org", body: "boom", status: 500 },
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    expect(resultText(result)).toContain("Emaar Properties PJSC");
    expect(result.isError).toBeUndefined();
  });

  test("warns loudly when only shared generic words matched (an ADX issuer)", async () => {
    const fetchFn = dfmFetch([GLEIF_EMPTY]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "Aldar Properties",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    // Aldar is on ADX, so the only hits share the word "Properties". Without
    // this warning the table would read as an answer to the query.
    expect(text).toContain("No confident match");
    expect(text).toContain("ADX in Abu Dhabi");
    expect(text).toContain("Do not read these rows as the issuer you searched for");
    expect(text).not.toContain("Aldar Properties PJSC");
  });

  test("does not warn on a confident symbol match", async () => {
    const fetchFn = dfmFetch([GLEIF_EMPTY]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    expect(resultText(result)).not.toContain("No confident match");
  });

  test("reports an unmatched query honestly, naming the Dubai-only gap", async () => {
    const fetchFn = dfmFetch([GLEIF_EMPTY]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "   ",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Could not find");
    expect(text).toContain("DUBAI ONLY");
    expect(text).toContain("ADGM");
    expect(result.isError).toBeUndefined();
  });

  test("surfaces an upstream roster failure as an error", async () => {
    const fetchFn = (async () =>
      new Response("boom", { status: 500 })) as AdapterOptions["fetchFn"];
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    expect(result.isError).toBe(true);
  });
});

describe("AE CompanyFilings", () => {
  test("lists an issuer's efsah disclosures with a transaction id per document", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMAAR }]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      limit: 5,
    } as never);
    const text = resultText(result);
    expect(text).toContain("DFM disclosures");
    expect(text).toContain("2026-08-07");
    expect(text).toContain("Press Release regarding financial results");
    expect(text).toContain(EMAAR_PRESS_RELEASE_PATH);
    expect(text).toContain("feeds.dfm.ae");
    expect(text).toContain("DUBAI ONLY");
    const structured = result.structuredContent as {
      filings: Array<{ transactionId?: string; sourceUrl?: string }>;
    };
    expect(structured.filings).toHaveLength(5);
    expect(structured.filings[0]?.transactionId).toBeDefined();
  });

  test("passes a date window to the feed and stays inside it", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMAAR_Q1 }]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      start_date: "2026-01-01",
      end_date: "2026-03-31",
    } as never);
    const text = resultText(result);
    expect(text).toContain("2026-03-25");
    expect(text).not.toContain("2026-08-07");
    expect(
      fetchFn.requests.some(({ url }) => url.includes("from=2026-01-01")),
    ).toBe(true);
  });

  test("routes a financial_reports form through the feed's own type filter", async () => {
    const fetchFn = dfmFetch([
      { pattern: DFM_EFSAH_URL, body: EMAAR_FINANCIALS },
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      forms: ["financial_reports"],
      limit: 3,
    } as never);
    expect(resultText(result)).toContain("Financial report");
    expect(
      fetchFn.requests.some(({ url }) => url.includes("types=financial_reports")),
    ).toBe(true);
  });

  test("reports an empty window without an error flag", async () => {
    const fetchFn = dfmFetch([{ pattern: DFM_EFSAH_URL, body: EMPTY }]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).toContain("No DFM disclosures found");
    expect(text).toContain("DUBAI ONLY");
    expect(result.isError).toBeUndefined();
  });

  test("explains that latest_annual has no DFM equivalent", async () => {
    const fetchFn = dfmFetch([]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      mode: "latest_annual",
    } as never);
    const text = resultText(result);
    expect(text).toContain("unsupported for AE");
    expect(text).toContain("financial_reports");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("surfaces an upstream feed failure as an error", async () => {
    const fetchFn = dfmFetch([
      { pattern: DFM_EFSAH_URL, body: "boom", status: 500 },
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    expect(result.isError).toBe(true);
  });
});

describe("AE CompanyDocument", () => {
  const PRESS_RELEASE_TEXT = [
    "FOR IMMEDIATE RELEASE",
    "Emaar's Net Profit before Tax increased by 23% to AED 12.8 billion",
    "Revenue increased by 21% to AED 23.9 billion (US$ 6.5 billion)",
  ];

  test("metadata reports content type, size and the source link", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "554089",
          "Last-Modified": "Fri, 07 Aug 2026 03:57:29 GMT",
        },
      })) as AdapterOptions["fetchFn"];
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      transaction_id: EMAAR_PRESS_RELEASE_PATH,
    } as never);
    const text = resultText(result);
    expect(text).toContain("DFM document");
    expect(text).toContain("application/pdf");
    expect(text).toContain("554089");
    expect(text).toContain("feeds.dfm.ae");
    expect(text).toContain("issuer-authored");
  });

  test("xhtml returns fenced, untrusted extracted text", async () => {
    const pdf = buildTextLayoutPdf(PRESS_RELEASE_TEXT);
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: pdf }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      transaction_id: EMAAR_PRESS_RELEASE_PATH,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Extracted text (from PDF)");
    expect(text).toContain("<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>");
    expect(text).toContain("AED 12.8 billion");
    expect(text).toContain("Arabic");
  });

  test("xhtml reports a scanned filing as having no text layer", async () => {
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: buildImagePdf() }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      transaction_id: EMAAR_PRESS_RELEASE_PATH,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("no reliable extractable text layer");
    expect(text).toContain("scanned/image");
    // The official link is still handed back rather than a bare failure.
    expect(text).toContain("feeds.dfm.ae");
    expect(result.isError).toBeUndefined();
  });

  test("pdf saves the file to disk and never inlines its bytes", async () => {
    const pdf = buildTextLayoutPdf(PRESS_RELEASE_TEXT);
    const fetchFn = routedFetch([{ pattern: "feeds.dfm.ae", body: pdf }]);
    const dir = await mkdtemp(join(tmpdir(), "dfm-doc-"));
    const target = join(dir, "emaar.pdf");
    try {
      const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
        company: "EMAAR",
        jurisdiction: "AE",
        transaction_id: EMAAR_PRESS_RELEASE_PATH,
        mode: "pdf",
        output_path: target,
      } as never);
      const text = resultText(result);
      expect(text).toContain("Downloaded PDF");
      expect(text).toContain(target);
      expect(text).toContain("not inlined here");
      expect(new Uint8Array(await readFile(target))).toEqual(pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses an off-host transaction id without issuing a request", async () => {
    const fetchFn = routedFetch([]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      transaction_id: "https://evil.example.com/documents/efsah/x.pdf",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Refusing to fetch");
    expect(text).toContain("dfm.ae");
    expect(result.isError).toBe(true);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("asks for a transaction id when none is supplied", async () => {
    const fetchFn = routedFetch([]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
    } as never);
    const text = resultText(result);
    expect(text).toContain("r_path");
    expect(text).toContain("DUBAI ONLY");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("reports a missing document honestly", async () => {
    const fetchFn = (async () =>
      new Response("not found", { status: 404 })) as AdapterOptions["fetchFn"];
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "EMAAR",
      jurisdiction: "AE",
      transaction_id: "/2026/Aug/7/nope/missing.pdf",
    } as never);
    expect(resultText(result)).toContain("has no document at");
    expect(result.isError).toBe(true);
  });
});

describe("AE honest-unsupported intents", () => {
  const cases: Array<[string, string[]]> = [
    ["CompanyInsiders", ["free-text disclosure PDFs", "ADX"]],
    ["CompanyOwners", ["SCA", "Absence of a result"]],
    ["CompanyFinancials", ["no structured financial figures", "financial_reports"]],
    ["PrivateRaises", ["DFM (Dubai)"]],
  ];

  for (const [tool, fragments] of cases) {
    test(`${tool} AE explains the actual gap, without an error flag`, async () => {
      const fetchFn = routedFetch([]);
      const result = await toolByName(tools(fetchFn), tool).handler({
        company: "EMAAR",
        jurisdiction: "AE",
      } as never);
      const text = resultText(result);
      expect(text).toContain('unsupported for jurisdiction "AE"');
      for (const fragment of fragments) expect(text).toContain(fragment);
      expect(result.isError).toBeUndefined();
      // An unsupported intent must never reach the network.
      expect(fetchFn.requests).toHaveLength(0);
    });
  }
});

describe("AE jurisdiction reference card", () => {
  test("names DFM, the keyless path, and the walled emirates", () => {
    const card = JURISDICTION_REFERENCE.find((entry) => entry.code === "AE");
    expect(card?.name).toContain("Dubai only");
    expect(card?.source).toContain("api2.dfm.ae");
    expect(card?.credential).toBe("None.");
    expect(card?.identifiers).toContain("EMAAR");
    expect(card?.intents).toContain("CompanyFilings");
    expect(card?.intents).toContain("CompanyDocument");
    expect(card?.caveat).toContain("DUBAI ONLY");
    expect(card?.caveat).toContain("ADX");
    expect(card?.caveat).toContain("DIFC");
    expect(card?.caveat).toContain("ADGM");
  });
});
