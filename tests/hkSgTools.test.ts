import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { resetHkexStockListCache } from "../src/adapters/hkexNews.js";
import {
  ACRA_CONSOLIDATED_RESOURCE,
  ACRA_LETTER_RESOURCES,
} from "../src/adapters/acraSg.js";
import type { ToolResult } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";
import { buildImagePdf, buildSimplePdf } from "./helpers/pdfFixture.js";

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

const STOCK_LIST = [{ i: 7609, c: "00700", n: "TENCENT", s: 15375 }];
const stockListRoute: Route = { pattern: "activestock_sehk_e.json", body: STOCK_LIST };

function servletBody(rows: unknown[]): Record<string, unknown> {
  return { result: JSON.stringify(rows), hasNextRow: false };
}

const FILING_ROW = {
  NEWS_ID: "12292377",
  TITLE: "Next Day Disclosure Return",
  LONG_TEXT: "Next Day Disclosure Returns - [Share Buyback]",
  STOCK_NAME: "TENCENT",
  DATE_TIME: "20/08/2026 17:35",
  FILE_TYPE: "PDF",
  FILE_LINK: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
};

function acraDatastore(records: Record<string, unknown>[]): Record<string, unknown> {
  return { success: true, result: { total: records.length, records } };
}

beforeEach(() => {
  resetRateLimiters();
  resetHkexStockListCache();
});

describe("HK tool dispatch", () => {
  test("CompanyResolve HK resolves via HKEXnews and emits structuredContent", async () => {
    const tools = createTools({ fetchFn: routedFetch([stockListRoute]), env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "700",
      jurisdiction: "HK",
    } as never);
    const text = resultText(result);
    expect(text).toContain("HKEXnews");
    expect(text).toContain("TENCENT");
    const structured = result.structuredContent as { candidates: Array<{ hkexStockId?: string }> };
    expect(structured.candidates[0]?.hkexStockId).toBe("7609");
  });

  test("CompanyFilings HK lists filings with the transaction-id trailer", async () => {
    const fetchFn = routedFetch([
      stockListRoute,
      { pattern: "titleSearchServlet.do", body: servletBody([FILING_ROW]) },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "700",
      jurisdiction: "HK",
    } as never);
    const text = resultText(result);
    expect(text).toContain("HKEXnews filings");
    expect(text).toContain("Next Day Disclosure Return");
    const structured = result.structuredContent as { filings: Array<{ transactionId?: string }> };
    expect(structured.filings[0]?.transactionId).toBe(
      "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
    );
  });

  test("CompanyDocument HK metadata reports content-type and size", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "2026082000673.pdf",
        body: "",
        headers: { "content-type": "application/pdf", "content-length": "90568" },
      },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "TENCENT",
      jurisdiction: "HK",
      transaction_id: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
      mode: "metadata",
    } as never);
    const text = resultText(result);
    expect(text).toContain("application/pdf");
    expect(text).toContain("90568");
  });

  test("CompanyDocument HK pdf saves to disk and never inlines bytes", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\n/Type /Page\n%%EOF");
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: pdfBytes }]);
    const tools = createTools({ fetchFn, env: {} });
    const target = join(tmpdir(), `hk-doc-${Date.now()}.pdf`);
    try {
      const result = await toolByName(tools, "CompanyDocument").handler({
        company: "TENCENT",
        jurisdiction: "HK",
        transaction_id: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
        mode: "pdf",
        output_path: target,
      } as never);
      const text = resultText(result);
      expect(text).toContain("Downloaded PDF");
      expect(text).toContain(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      if (existsSync(target)) rmSync(target);
    }
  });

  test("CompanyDocument HK xhtml extracts the filed PDF's text, fenced and paged", async () => {
    const textPdf = buildSimplePdf(
      "BT (Tencent Holdings interim results) Tj T* (Board announcement) Tj ET",
    );
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: textPdf }]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "TENCENT",
      jurisdiction: "HK",
      transaction_id: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Extracted text (from PDF)");
    expect(text).toContain("BEGIN UNTRUSTED DOCUMENT TEXT");
    expect(text).toContain("Tencent Holdings interim results");
  });

  test("CompanyDocument HK xhtml reports an image-only PDF honestly", async () => {
    const fetchFn = routedFetch([{ pattern: "2026082000673.pdf", body: buildImagePdf() }]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "TENCENT",
      jurisdiction: "HK",
      transaction_id: "/listedco/listconews/sehk/2026/0820/2026082000673.pdf",
      mode: "xhtml",
    } as never);
    expect(resultText(result)).toContain("no extractable text layer");
  });

  test("CompanyOwners HK explains the DI captcha wall honestly", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: {} });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "700",
      jurisdiction: "HK",
    } as never);
    const text = resultText(result);
    expect(text).toContain("unsupported for jurisdiction \"HK\"");
    expect(text.toLowerCase()).toContain("disclosure of interests");
    expect(result.isError).toBeUndefined();
  });
});

describe("SG tool dispatch", () => {
  test("CompanyResolve SG resolves via ACRA with a profile + former names", async () => {
    const record = {
      uen: "197200078R",
      entity_name: "SINGAPORE AIRLINES LIMITED",
      entity_status_description: "Live Company",
      registration_incorporation_date: "1972-01-28",
      former_entity_name1: "MALAYSIA-SINGAPORE AIRLINES",
    };
    const fetchFn = routedFetch([
      { pattern: ACRA_LETTER_RESOURCES.S, body: acraDatastore([record]) },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "SINGAPORE AIRLINES LIMITED",
      jurisdiction: "SG",
    } as never);
    const text = resultText(result);
    expect(text).toContain("ACRA");
    expect(text).toContain("Former names");
    expect(text).toContain("MALAYSIA-SINGAPORE AIRLINES");
    const structured = result.structuredContent as { candidates: Array<{ uen?: string }> };
    expect(structured.candidates[0]?.uen).toBe("197200078R");
  });

  test("CompanyResolve SG routes a UEN via the consolidated dataset", async () => {
    const consolidated = { uen: "197200078R", entity_name: "SINGAPORE AIRLINES LIMITED", uen_status_desc: "Registered" };
    const rich = { uen: "197200078R", entity_name: "SINGAPORE AIRLINES LIMITED", entity_status_description: "Live Company" };
    const fetchFn = routedFetch([
      { pattern: ACRA_CONSOLIDATED_RESOURCE, body: acraDatastore([consolidated]) },
      { pattern: ACRA_LETTER_RESOURCES.S, body: acraDatastore([rich]) },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "197200078R",
      jurisdiction: "SG",
    } as never);
    expect(resultText(result)).toContain("SINGAPORE AIRLINES LIMITED");
  });

  test("CompanyFilings SG explains the SGX Akamai wall honestly", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: {} });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "SINGAPORE AIRLINES",
      jurisdiction: "SG",
    } as never);
    const text = resultText(result);
    expect(text).toContain("unsupported for jurisdiction \"SG\"");
    expect(text).toContain("Akamai");
    expect(result.isError).toBeUndefined();
  });
});
