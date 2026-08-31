import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { InMemoryCache } from "../src/core/cache.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import {
  ASX_ANNOUNCEMENT_CAP,
  parseAsicCompanyCsv,
  parseAsxFileSize,
  resetAsxDirectoryCache,
  resolveAsxDocumentUrl,
} from "../src/adapters/asxAsic.js";
import { JURISDICTION_REFERENCE } from "../src/core/jurisdictionReference.js";
import type { AdapterOptions, ToolResult } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import {
  buildEncryptedPdf,
  buildImagePdf,
  buildTextLayoutPdf,
} from "./helpers/pdfFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import type { Route } from "./helpers/routedFetch.js";

const DIRECTORY = loadFixture("asx", "directory.json");
const DIRECTORY_EMPTY = loadFixture("asx", "directory-empty.json");
const KEY_STATISTICS = loadFixture("asx", "key-statistics-bhp.json");
const ANNOUNCEMENTS_BHP = loadFixture("asx", "announcements-bhp.json");
const ANNOUNCEMENTS_CSL = loadFixture("asx", "announcements-csl.json");
const ANNOUNCEMENTS_EMPTY = loadFixture("asx", "announcements-empty.json");

const COMPANY_ACN_BHP = loadFixture("asic", "company-acn-bhp.json");
const COMPANY_NAME_ATLASSIAN = loadFixture("asic", "company-name-atlassian.json");
const COMPANY_EMPTY = loadFixture("asic", "company-empty.json");
const DATASTORE_FAILURE = loadFixture("asic", "datastore-failure.json");
const BANNED_SMITH = loadFixture("asic", "banned-smith.json");
const COMPANY_CSV = loadFixture("asic", "company-dataset-sample.csv");

/** A real documentKey from the recorded BHP announcements fixture. */
const BHP_DOCUMENT_KEY = "2924-03128337-3A700321";

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

const ASX_ACKNOWLEDGED_ENV = {
  DISCLOSURES_ACKNOWLEDGE_ASX_TERMS: "1",
};

function tools(
  fetchFn: AdapterOptions["fetchFn"],
  cache?: AdapterOptions["cache"],
  env: AdapterOptions["env"] = ASX_ACKNOWLEDGED_ENV,
) {
  return createTools({ fetchFn, env, ...(cache ? { cache } : {}) });
}

const DIRECTORY_ROUTE: Route = { pattern: "companies/directory", body: DIRECTORY };
const KEY_STATISTICS_ROUTE: Route = { pattern: "key-statistics", body: KEY_STATISTICS };
/** GLEIF enrichment is best-effort; most tests stub it empty. */
const GLEIF_EMPTY: Route = { pattern: "api.gleif.org", body: { data: [] } };

const ASIC_COMPANY_ROUTE: Route = {
  pattern: "resource_id=5c3914e6",
  body: COMPANY_EMPTY,
};

/** Baseline AU routes: ASX directory + ISIN, an empty ASIC register, no LEI. */
function auRoutes(extra: Route[] = []): Route[] {
  return [...extra, DIRECTORY_ROUTE, KEY_STATISTICS_ROUTE, ASIC_COMPANY_ROUTE, GLEIF_EMPTY];
}

beforeEach(() => {
  resetRateLimiters();
  resetAsxDirectoryCache();
});

describe("AU CompanyResolve", () => {
  test("resolves an ASX ticker with the exchange profile and its ISIN", async () => {
    const fetchFn = routedFetch(auRoutes());
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("BHP GROUP LIMITED");
    expect(text).toContain("ASX BHP");
    expect(text).toContain("Materials");
    // The ISIN comes from key-statistics, enriched onto the top match only.
    expect(text).toContain("AU000000BHP4");
    expect(text).toContain("ASX-listed companies");
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as {
      candidates: Array<{ asxCode?: string; jurisdiction?: string; isin?: string }>;
    };
    expect(structured.candidates[0]?.asxCode).toBe("BHP");
    expect(structured.candidates[0]?.jurisdiction).toBe("AU");
    expect(structured.candidates[0]?.isin).toBe("AU000000BHP4");
  });

  test("states the ASX terms conflict on every listed resolve", async () => {
    const fetchFn = routedFetch(auRoutes());
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyResolve").handler({
        company: "CBA",
        jurisdiction: "AU",
      } as never),
    );
    expect(text).toContain("personal, non-commercial use");
    expect(text).toContain("prohibit");
    expect(text).toContain("responsible for having the rights to use ASX data");
    expect(text).toContain("https://www.asx.com.au/legals/terms-of-use");
  });

  test("queries only ASIC when ASX terms are not acknowledged", async () => {
    const fetchFn = routedFetch([{
      pattern: "resource_id=5c3914e6",
      body: COMPANY_NAME_ATLASSIAN,
    }]);
    const result = await toolByName(tools(fetchFn, undefined, {}), "CompanyResolve").handler({
      company: "ATLASSIAN",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("ASIC company register (CC-BY open data)");
    expect(text).toContain("ASX access is disabled by default");
    expect(text).toContain("DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1");
    expect(fetchFn.requests.some(({ url }) => new URL(url).hostname === "asx.api.markitdigital.com")).toBe(false);
    expect(result.isError).toBeUndefined();
  });

  test("resolves by company name against the ASX directory", async () => {
    const fetchFn = routedFetch(auRoutes());
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyResolve").handler({
        company: "Commonwealth Bank of Australia",
        jurisdiction: "AU",
      } as never),
    );
    expect(text).toContain("ASX CBA");
  });

  test("resolves an unlisted company from the CC-BY ASIC dataset by name", async () => {
    // Atlassian's Australian entities are in the ASIC register and not on the
    // ASX, so this exercises the register half on its own.
    const fetchFn = routedFetch([
      { pattern: "resource_id=5c3914e6", body: COMPANY_NAME_ATLASSIAN },
      DIRECTORY_ROUTE,
      KEY_STATISTICS_ROUTE,
      GLEIF_EMPTY,
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "ATLASSIAN",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("ASIC company register (CC-BY open data)");
    expect(text).toContain("ATLASSIAN");
    expect(text).toContain("ACN 102443916");
    // Superseded names carry the register's current-name cross-reference.
    expect(text).toContain("ATLASSIAN PTY LTD");
    expect(text).toContain("Registered (REGD)");
    // The CC-BY licence is stated, and distinguished from the ASX terms.
    expect(text).toContain("Creative Commons Attribution 3.0 Australia");
    expect(text).toContain("Australian Securities and Investments Commission");
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as {
      candidates: Array<{ acn?: string; abn?: string }>;
    };
    expect(structured.candidates.some((c) => c.acn === "102443916")).toBe(true);
    expect(structured.candidates.some((c) => c.abn === "53102443916")).toBe(true);
  });

  test("resolves by exact ACN through the ASIC datastore filter", async () => {
    const fetchFn = routedFetch([
      { pattern: "resource_id=5c3914e6", body: COMPANY_ACN_BHP },
      DIRECTORY_ROUTE,
      KEY_STATISTICS_ROUTE,
      GLEIF_EMPTY,
    ]);
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyResolve").handler({
        company: "004 028 077",
        jurisdiction: "AU",
      } as never),
    );
    expect(text).toContain("ACN 004028077");
    expect(text).toContain("BHP GROUP LIMITED");
    // The exact-filter path, not a full-text search.
    expect(
      fetchFn.requests.some(({ url }) => url.includes("filters=") && url.includes("ACN")),
    ).toBe(true);
    expect(fetchFn.requests.some(({ url }) => new URL(url).hostname === "asx.api.markitdigital.com")).toBe(false);
    expect(text).toContain("Exact ACN/ABN lookups intentionally query only");
  });

  test("returns an honest miss when neither source has the company", async () => {
    const fetchFn = routedFetch(auRoutes());
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "Definitely Not An Australian Company Pty Ltd",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Could not find");
    expect(text).toContain("ACN");
    // A miss is not an error.
    expect(result.isError).toBeUndefined();
  });

  test("surfaces an ASIC upstream failure without losing the ASX half", async () => {
    const fetchFn = routedFetch([
      { pattern: "resource_id=5c3914e6", body: DATASTORE_FAILURE },
      DIRECTORY_ROUTE,
      KEY_STATISTICS_ROUTE,
      GLEIF_EMPTY,
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("BHP GROUP LIMITED");
    expect(text).toContain("ASIC (data.gov.au) register lookup was unavailable");
    expect(result.isError).toBeUndefined();
  });

  test("errors when BOTH sources fail rather than reporting an empty result", async () => {
    const fetchFn = routedFetch([
      { pattern: "resource_id=5c3914e6", body: DATASTORE_FAILURE },
      { pattern: "companies/directory", body: "upstream exploded", status: 503 },
      GLEIF_EMPTY,
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("ASX listed-directory lookup was unavailable");
    expect(text).toContain("ASIC (data.gov.au) register lookup was unavailable");
  });

  test("attaches an AU LEI from GLEIF only on a confident name match", async () => {
    // GLEIF's own results for "BHP GROUP LIMITED" include a GB and an NZ
    // near-match; only the AU record whose name matches is accepted.
    const fetchFn = routedFetch(auRoutes([{
      pattern: "api.gleif.org",
      body: {
        data: [
          {
            id: "894500OGEMX4F6STBR39",
            attributes: {
              lei: "894500OGEMX4F6STBR39",
              entity: {
                legalName: { name: "BHP Billiton Group Limited" },
                jurisdiction: "GB",
                legalAddress: { country: "GB" },
                status: "ACTIVE",
              },
              registration: { status: "ISSUED" },
            },
          },
          {
            id: "WZE1WSENV6JSZFK0JC28",
            attributes: {
              lei: "WZE1WSENV6JSZFK0JC28",
              entity: {
                legalName: { name: "BHP GROUP LIMITED" },
                jurisdiction: "AU",
                legalAddress: { country: "AU" },
                status: "ACTIVE",
              },
              registration: { status: "ISSUED" },
            },
          },
        ],
      },
    }]));
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyResolve").handler({
        company: "BHP",
        jurisdiction: "AU",
      } as never),
    );
    expect(text).toContain("LEI WZE1WSENV6JSZFK0JC28");
    expect(text).not.toContain("894500OGEMX4F6STBR39");
  });

  test("withholds an LEI when GLEIF offers only a foreign near-match", async () => {
    const fetchFn = routedFetch(auRoutes([{
      pattern: "api.gleif.org",
      body: {
        data: [{
          id: "254900IWYPAQ08L3OY97",
          attributes: {
            lei: "254900IWYPAQ08L3OY97",
            entity: {
              legalName: { name: "BHP Trading Group Limited" },
              jurisdiction: "NZ",
              legalAddress: { country: "NZ" },
              status: "ACTIVE",
            },
            registration: { status: "ISSUED" },
          },
        }],
      },
    }]));
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyResolve").handler({
        company: "BHP",
        jurisdiction: "AU",
      } as never),
    );
    expect(text).toContain("BHP GROUP LIMITED");
    expect(text).not.toContain("254900IWYPAQ08L3OY97");
  });

  test("reuses a cached ASX directory across calls", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch(auRoutes());
    await toolByName(tools(fetchFn, cache), "CompanyResolve").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    const firstDirectoryCalls = fetchFn.requests.filter(({ url }) =>
      url.includes("companies/directory")
    ).length;
    expect(firstDirectoryCalls).toBe(1);

    // A fresh process-local memo, so only the shared cache can serve the second
    // call — proving the digest, not the in-process promise, did the work.
    resetAsxDirectoryCache();
    await toolByName(tools(fetchFn, cache), "CompanyResolve").handler({
      company: "CSL",
      jurisdiction: "AU",
    } as never);
    expect(
      fetchFn.requests.filter(({ url }) => url.includes("companies/directory")).length,
    ).toBe(1);
  });

  test("reuses a cached ASIC query result across calls", async () => {
    const cache = new InMemoryCache();
    const fetchFn = routedFetch([
      { pattern: "resource_id=5c3914e6", body: COMPANY_NAME_ATLASSIAN },
      DIRECTORY_ROUTE,
      KEY_STATISTICS_ROUTE,
      GLEIF_EMPTY,
    ]);
    const resolve = () =>
      toolByName(tools(fetchFn, cache), "CompanyResolve").handler({
        company: "ATLASSIAN",
        jurisdiction: "AU",
      } as never);
    await resolve();
    const first = fetchFn.requests.filter(({ url }) =>
      url.includes("resource_id=5c3914e6")
    ).length;
    expect(first).toBe(1);
    resetAsxDirectoryCache();
    await resolve();
    expect(
      fetchFn.requests.filter(({ url }) => url.includes("resource_id=5c3914e6")).length,
    ).toBe(1);
  });
});

describe("AU CompanyFilings", () => {
  test("refuses ASX access before fetching without acknowledgement", async () => {
    const fetchFn = routedFetch([]);
    const result = await toolByName(tools(fetchFn, undefined, {}), "CompanyFilings").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("maps the five most recent announcements and says so plainly", async () => {
    const fetchFn = routedFetch(auRoutes([
      { pattern: "companies/bhp/announcements", body: ANNOUNCEMENTS_BHP },
    ]));
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    const text = resultText(result);
    expect(text).toContain("ASX announcements: BHP GROUP LIMITED (BHP)");
    expect(text).toContain("Update - Dividend/Distribution - BHP");
    expect(text).toContain("DISTRIBUTION ANNOUNCEMENT");
    expect(text).toContain("2026-08-28");
    expect(text).toContain(BHP_DOCUMENT_KEY);
    // The five-item cap is stated, unmissably.
    expect(text).toContain("5 MOST RECENT ANNOUNCEMENTS ONLY");
    expect(text).toContain("NOT A COMPLETE FILING HISTORY");
    expect(text).toContain("not** a complete filing");
    // The terms conflict rides along on ASX-derived output.
    expect(text).toContain("personal, non-commercial use");
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as {
      filings: Array<{ transactionId?: string; filedDate?: string }>;
    };
    expect(structured.filings).toHaveLength(ASX_ANNOUNCEMENT_CAP);
    expect(structured.filings[0]?.transactionId).toBe(BHP_DOCUMENT_KEY);
  });

  test("says a limit above five cannot be honoured upstream", async () => {
    const fetchFn = routedFetch(auRoutes([
      { pattern: "companies/bhp/announcements", body: ANNOUNCEMENTS_BHP },
    ]));
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyFilings").handler({
        company: "BHP",
        jurisdiction: "AU",
        limit: 50,
      } as never),
    );
    expect(text).toContain("limit=50 CANNOT BE HONOURED UPSTREAM");
    expect(text).toContain("hard upstream limit, not a truncation this tool chose");
  });

  test("filters the five rows by form text without implying more exist", async () => {
    const fetchFn = routedFetch(auRoutes([
      { pattern: "companies/csl/announcements", body: ANNOUNCEMENTS_CSL },
    ]));
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyFilings").handler({
        company: "CSL",
        jurisdiction: "AU",
        forms: ["Appendix 3Y"],
      } as never),
    );
    // CSL's latest five are all Appendix 3Y director-interest notices.
    expect(text).toContain("Appendix 3Y - Alison Watkins AM");
    expect(text).toContain("SECURITY HOLDER DETAILS");
    expect(text).toContain("5 MOST RECENT ANNOUNCEMENTS ONLY");
  });

  test("reports an empty filtered result honestly, still stating the cap", async () => {
    const fetchFn = routedFetch(auRoutes([
      { pattern: "companies/bhp/announcements", body: ANNOUNCEMENTS_BHP },
    ]));
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "BHP",
      jurisdiction: "AU",
      forms: ["nothing-matches-this"],
    } as never);
    const text = resultText(result);
    expect(text).toContain("No ASX announcements matched");
    expect(text).toContain("5 most recent announcements");
    expect(text).toContain("NOT A COMPLETE FILING HISTORY");
    expect(result.isError).toBeUndefined();
  });

  test("reports an issuer with no announcements at all honestly", async () => {
    const fetchFn = routedFetch(auRoutes([
      { pattern: "companies/bhp/announcements", body: ANNOUNCEMENTS_EMPTY },
    ]));
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    expect(resultText(result)).toContain("No ASX announcements matched");
    expect(result.isError).toBeUndefined();
  });

  test("surfaces an upstream announcements failure as an error", async () => {
    const fetchFn = routedFetch(auRoutes([
      {
        pattern: "companies/bhp/announcements",
        body: { error: { code: 500, message: "Internal" } },
        status: 500,
      },
    ]));
    const result = await toolByName(tools(fetchFn), "CompanyFilings").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("500");
  });

  test("refuses latest_annual mode with the cap as the reason", async () => {
    const fetchFn = routedFetch(auRoutes());
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyFilings").handler({
        company: "BHP",
        jurisdiction: "AU",
        mode: "latest_annual",
      } as never),
    );
    expect(text).toContain("unsupported for AU");
    expect(text).toContain("capped at the five most recent");
  });
});

describe("AU CompanyDocument", () => {
  test("refuses ASX access before fetching without acknowledgement", async () => {
    const fetchFn = routedFetch([]);
    const result = await toolByName(tools(fetchFn, undefined, {}), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: BHP_DOCUMENT_KEY,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("returns metadata measured from a real fetch", async () => {
    const pdf = buildTextLayoutPdf(["Dividend/Distribution - BHP"]);
    const fetchFn = routedFetch([{ pattern: `file/${BHP_DOCUMENT_KEY}`, body: pdf }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: BHP_DOCUMENT_KEY,
    } as never);
    const text = resultText(result);
    expect(text).toContain(BHP_DOCUMENT_KEY);
    expect(text).toContain("application/pdf");
    expect(text).toContain(String(pdf.byteLength));
    // The HEAD-vs-GET asymmetry is explained, not hidden.
    expect(text).toContain("answers 404 to HEAD");
    // The terms conflict is repeated on every ASX document response.
    expect(text).toContain("personal, non-commercial use");
    expect(result.isError).toBeUndefined();
  });

  test("extracts announcement text in xhtml mode, fenced as untrusted", async () => {
    const pdf = buildTextLayoutPdf([
      "Change of Director's Interest Notice",
      "Direct interest: 12,345 ordinary shares",
    ]);
    const fetchFn = routedFetch([{ pattern: `file/${BHP_DOCUMENT_KEY}`, body: pdf }]);
    const text = resultText(
      await toolByName(tools(fetchFn), "CompanyDocument").handler({
        company: "BHP",
        jurisdiction: "AU",
        transaction_id: BHP_DOCUMENT_KEY,
        mode: "xhtml",
      } as never),
    );
    expect(text).toContain("Change of Director's Interest Notice");
    expect(text).toContain("12,345 ordinary shares");
    expect(text).toContain("BEGIN UNTRUSTED DOCUMENT TEXT");
    expect(text).toContain("issuer-authored");
  });

  test("extracts text from an encrypted announcement (ASX's real shape)", async () => {
    // EVERY ASX announcement PDF is AES-256 encrypted with an empty user
    // password (owner-password protection). Before the extractor learned to
    // open those, this path reported "no extractable text layer" for documents
    // that are full of text — verified against the live BHP/CSL/CBA PDFs.
    const pdf = buildEncryptedPdf(
      "BT (Form 603 Notice of initial substantial holder) Tj ET",
    );
    const fetchFn = routedFetch([{ pattern: `file/${BHP_DOCUMENT_KEY}`, body: pdf }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: BHP_DOCUMENT_KEY,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Form 603 Notice of initial substantial holder");
    expect(text).toContain("BEGIN UNTRUSTED DOCUMENT TEXT");
    expect(text).not.toContain("no extractable text layer");
    expect(result.isError).toBeUndefined();
  });

  test("reports a scanned announcement with no text layer honestly", async () => {
    const fetchFn = routedFetch([
      { pattern: `file/${BHP_DOCUMENT_KEY}`, body: buildImagePdf() },
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: BHP_DOCUMENT_KEY,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain(BHP_DOCUMENT_KEY);
    expect(text.toLowerCase()).toContain("text");
    // Nothing was invented in place of the missing text layer.
    expect(text).not.toContain("BEGIN UNTRUSTED DOCUMENT TEXT");
    expect(result.isError).toBeUndefined();
  });

  test("saves the PDF to disk in pdf mode and never inlines bytes", async () => {
    const pdf = buildTextLayoutPdf(["Appendix 3Y"]);
    const fetchFn = routedFetch([{ pattern: `file/${BHP_DOCUMENT_KEY}`, body: pdf }]);
    const dir = await mkdtemp(join(tmpdir(), "au-doc-"));
    try {
      const target = join(dir, "announcement.pdf");
      const text = resultText(
        await toolByName(tools(fetchFn), "CompanyDocument").handler({
          company: "BHP",
          jurisdiction: "AU",
          transaction_id: BHP_DOCUMENT_KEY,
          mode: "pdf",
          output_path: target,
        } as never),
      );
      expect(text).toContain(target);
      expect(text).toContain("written to disk");
      const written = await readFile(target);
      expect(new Uint8Array(written)).toEqual(pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an off-host document URL before any request (SSRF guard)", async () => {
    const fetchFn = routedFetch([{ pattern: "example.com", body: "should never be fetched" }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: "https://evil.example.com/asx-research/1.0/file/2924-1-A1",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Refusing to fetch");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("rejects a malformed transaction id before any request", () => {
    expect(() => resolveAsxDocumentUrl("not-a-document-key")).toThrow(/Refusing to fetch/);
    expect(() => resolveAsxDocumentUrl("http://asx.api.markitdigital.com/x/file/2924-1-A1"))
      .toThrow(/Refusing to fetch/);
  });

  test("accepts a full markitdigital URL and rebuilds it canonically", () => {
    const { url, documentKey } = resolveAsxDocumentUrl(
      `https://asx.api.markitdigital.com/asx-research/1.0/file/${BHP_DOCUMENT_KEY}`,
    );
    expect(documentKey).toBe(BHP_DOCUMENT_KEY);
    expect(url).toContain(`file/${BHP_DOCUMENT_KEY}`);
    expect(url).toContain("access_token=");
  });

  test("reports a missing announcement document honestly", async () => {
    const fetchFn = routedFetch([{
      pattern: `file/${BHP_DOCUMENT_KEY}`,
      body: { error: { code: 404, message: "File not found" } },
      status: 404,
    }]);
    const result = await toolByName(tools(fetchFn), "CompanyDocument").handler({
      company: "BHP",
      jurisdiction: "AU",
      transaction_id: BHP_DOCUMENT_KEY,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("aged out of the keyless feed");
  });
});

describe("AU PersonAppointments", () => {
  test("answers disqualifications from the CC-BY banned-persons register", async () => {
    const fetchFn = routedFetch([{ pattern: "resource_id=741da9e3", body: BANNED_SMITH }]);
    const result = await toolByName(tools(fetchFn), "PersonAppointments").handler({
      jurisdiction: "AU",
      mode: "disqualifications",
      query: "SMITH",
    } as never);
    const text = resultText(result);
    expect(text).toContain("ASIC banned & disqualified persons");
    expect(text).toContain("SMITH, LEONARD JOHN");
    expect(text).toContain("Banned Securities");
    // Dates are normalised out of the register's DD/MM/YYYY.
    expect(text).toContain("2001-11-28");
    // An open-ended ban says so rather than showing a blank cell.
    expect(text).toContain("no end date recorded");
    // The licence is CC-BY, not the ASX terms.
    expect(text).toContain("Creative Commons Attribution 3.0 Australia");
    expect(text).not.toContain("personal, non-commercial use");
    // It is a ban list, and says so.
    expect(text).toContain("not a directorships index");
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as {
      people: Array<{ name?: string; banType?: string }>;
    };
    expect(structured.people.some((p) => p.name === "SMITH, LEONARD JOHN")).toBe(true);
  });

  test("reports no banned-register match without implying innocence", async () => {
    const fetchFn = routedFetch([{
      pattern: "resource_id=741da9e3",
      body: { success: true, result: { records: [] } },
    }]);
    const result = await toolByName(tools(fetchFn), "PersonAppointments").handler({
      jurisdiction: "AU",
      mode: "disqualifications",
      query: "Nobody Here",
    } as never);
    const text = resultText(result);
    expect(text).toContain("No entries in ASIC's Banned and Disqualified Persons register");
    expect(text).toContain("Absence here is not proof");
    expect(result.isError).toBeUndefined();
  });

  test("returns honest unsupported for search and appointments, naming the paid extract", async () => {
    const fetchFn = routedFetch([]);
    for (const mode of ["search", "appointments"] as const) {
      const text = resultText(
        await toolByName(tools(fetchFn), "PersonAppointments").handler({
          jurisdiction: "AU",
          mode,
          query: "Jane Citizen",
        } as never),
      );
      expect(text).toContain("unsupported for jurisdiction \"AU\"");
      expect(text).toContain("PAID registry product");
      expect(text).toContain("disqualifications");
    }
    // No request was made for an intent that cannot be served.
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("surfaces an upstream banned-register failure as an error", async () => {
    const fetchFn = routedFetch([{
      pattern: "resource_id=741da9e3",
      body: DATASTORE_FAILURE,
    }]);
    const result = await toolByName(tools(fetchFn), "PersonAppointments").handler({
      jurisdiction: "AU",
      mode: "disqualifications",
      query: "SMITH",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("datastore_search");
  });
});

describe("AU unsupported intents", () => {
  const cases: Array<[string, string[]]> = [
    ["CompanyInsiders", ["Appendix 3Y", "five most recent", "PAID registry"]],
    ["CompanyOwners", ["603/604/605", "five most recent", "not evidence"]],
    ["CompanyFinancials", ["no", "20-F", "jurisdiction \"US\""]],
    ["PrivateRaises", ["Form D", "no"]],
  ];

  for (const [tool, expectations] of cases) {
    test(`${tool} explains why AU cannot be served`, async () => {
      const fetchFn = routedFetch([]);
      const result = await toolByName(tools(fetchFn), tool).handler({
        company: "BHP",
        jurisdiction: "AU",
      } as never);
      const text = resultText(result);
      expect(text).toContain("unsupported for jurisdiction \"AU\"");
      for (const expectation of expectations) {
        expect(text).toContain(expectation);
      }
      expect(result.isError).toBeUndefined();
      // Nothing is fetched for an intent that has no source.
      expect(fetchFn.requests).toHaveLength(0);
    });
  }
});

describe("AU adapter units", () => {
  test("parses the ASX file-size strings the feed publishes", () => {
    expect(parseAsxFileSize("20KB")).toBe(20 * 1024);
    expect(parseAsxFileSize("17790KB")).toBe(17790 * 1024);
    expect(parseAsxFileSize("1.5MB")).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseAsxFileSize("")).toBeUndefined();
    expect(parseAsxFileSize("unknown")).toBeUndefined();
  });

  test("maps the bulk tab-delimited Company Dataset to the same entities", () => {
    // The bulk export is never fetched on the live path (datastore_search
    // serves the same rows), but the mapping is kept equivalent and tested.
    const entities = parseAsicCompanyCsv(COMPANY_CSV);
    expect(entities).toHaveLength(4);
    const bhp = entities.find((entity) => entity.legalName === "BHP GROUP LIMITED");
    expect(bhp?.acn).toBe("004028077");
    expect(bhp?.abn).toBe("49004028077");
    expect(bhp?.status).toBe("Registered (REGD)");
    expect(bhp?.registrationDate).toBe("1885-08-13");
    const superseded = entities.find(
      (entity) => entity.legalName === "BHP BILLITON LIMITED",
    );
    expect(superseded?.currentName).toBe("BHP GROUP LIMITED");
  });

  test("reports an empty ASX directory as an upstream failure, not an empty market", async () => {
    const fetchFn = routedFetch([
      { pattern: "companies/directory", body: DIRECTORY_EMPTY },
      { pattern: "resource_id=5c3914e6", body: COMPANY_EMPTY },
      GLEIF_EMPTY,
    ]);
    const result = await toolByName(tools(fetchFn), "CompanyResolve").handler({
      company: "BHP",
      jurisdiction: "AU",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("no listed companies");
  });
});

describe("AU jurisdiction reference card", () => {
  test("states the ASX/ASIC licence split and the five-item cap", () => {
    const card = JURISDICTION_REFERENCE.find((entry) => entry.code === "AU");
    expect(card).toBeDefined();
    expect(card?.caveat).toContain("personal, non-commercial use");
    expect(card?.caveat).toContain("CC BY 3.0 AU");
    expect(card?.caveat).toContain("HARD-CAPPED");
    expect(card?.caveat).toContain("5 most recent");
    expect(card?.credential).toContain("DISCLOSURES_ACKNOWLEDGE_ASX_TERMS=1");
    expect(card?.caveat).toContain("disabled before network access");
    expect(card?.intents).toContain("disqualifications");
  });
});
