import { beforeEach, describe, expect, test } from "bun:test";
import { createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { JURISDICTION_REFERENCE } from "../src/core/jurisdictionReference.js";
import type { ToolResult } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import { makeIdxInstanceZip } from "./helpers/idxFixture.js";

const PROFILES = JSON.parse(loadFixture("idx", "company-profiles.json"));
const ANNOUNCEMENTS = JSON.parse(loadFixture("idx", "announcement-bbca.json"));
const REPORT_TLKM = JSON.parse(loadFixture("idx", "financial-report-tlkm.json"));
const REPORT_NO_INSTANCE = JSON.parse(
  loadFixture("idx", "financial-report-no-instance.json"),
);

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

beforeEach(() => {
  resetRateLimiters();
});

describe("ID tool dispatch", () => {
  test("CompanyResolve ID resolves a ticker with sector, board and listing date", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never);
    const text = resultText(result);
    expect(text).toContain("IDX");
    expect(text).toContain("PT Bank Central Asia Tbk.");
    expect(text).toContain("Keuangan / Bank");
    expect(text).toContain("Utama");
    expect(text).toContain("2000-05-31");
    // The anti-bot posture is stated up front, on the success path too.
    expect(text).toContain("browser-backed fetchFn");
    // The next step points at the intents ID actually serves.
    expect(text).toContain("CompanyFinancials");

    const structured = result.structuredContent as {
      candidates: Array<{ ticker?: string; jurisdiction?: string }>;
    };
    expect(structured.candidates[0]?.ticker).toBe("BBCA");
    expect(structured.candidates[0]?.jurisdiction).toBe("ID");
  });

  test("CompanyResolve ID resolves by issuer name", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const text = resultText(await toolByName(tools, "CompanyResolve").handler({
      company: "Telkom Indonesia",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("TLKM");
    expect(text).toContain("PT Telkom Indonesia (Persero) Tbk");
  });

  test("CompanyResolve ID reports a miss with a usable hint", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: { data: [] } },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const text = resultText(await toolByName(tools, "CompanyResolve").handler({
      company: "Nonexistent Issuer",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("Could not find");
    expect(text).toContain("kode emiten");
  });

  test("CompanyFilings ID lists announcements with attachment links", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "BBCA",
      jurisdiction: "ID",
      start_date: "2025-01-01",
      end_date: "2026-08-29",
    } as never);
    const text = resultText(result);
    expect(text).toContain("IDX announcements");
    expect(text).toContain("General Announcement Public Expose - Annual");
    expect(text).toContain("Changes of controlling shareholder");
    expect(text).toContain("2026-08-26");
    expect(text).toContain(".pdf");
    // ID has no CompanyDocument route; the next step must not imply one.
    expect(text).toContain("no CompanyDocument route");

    const structured = result.structuredContent as {
      filings: Array<{ filedDate: string; sourceUrl: string }>;
    };
    expect(structured.filings).toHaveLength(4);
    expect(structured.filings[0]?.filedDate).toBe("2026-08-26");
  });

  test("CompanyFilings ID honours the limit", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "BBCA",
      jurisdiction: "ID",
      limit: 2,
    } as never);
    const structured = result.structuredContent as { filings: unknown[] };
    expect(structured.filings).toHaveLength(2);
  });

  test("CompanyFilings ID rejects latest_annual honestly", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: {} });
    const text = resultText(await toolByName(tools, "CompanyFilings").handler({
      company: "BBCA",
      jurisdiction: "ID",
      mode: "latest_annual",
    } as never));
    expect(text).toContain("unsupported for ID");
    expect(text).toContain("CompanyFinancials");
  });

  test("CompanyFilings ID reports an empty window without inventing rows", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: { ResultCount: 0, Replies: [] } },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const text = resultText(await toolByName(tools, "CompanyFilings").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("No IDX announcements found");
  });

  test("CompanyFinancials ID renders XBRL facts in IDR", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: REPORT_TLKM },
      { pattern: "instance.zip", body: makeIdxInstanceZip() },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "TLKM",
      jurisdiction: "ID",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Financials (IDX XBRL)");
    expect(text).toContain("PT Telkom Indonesia (Persero) Tbk");
    expect(text).toContain("Total assets (IDR)");
    // IDR renders with its own currency prefix and no fractional digits.
    expect(text).toContain("Rp 299,675,000,000,000");
    expect(text).toContain("Rp 149,967,000,000,000");
    expect(text).toContain("consolidated");
    expect(text).toContain("2024-12-31");
    expect(text).toContain("2023-12-31");

    const structured = result.structuredContent as {
      concepts: Array<{ concept: string; unit?: string }>;
      sourceJurisdiction: string;
    };
    expect(structured.sourceJurisdiction).toBe("ID");
    expect(structured.concepts.map((concept) => concept.concept)).toContain(
      "total_assets",
    );
    expect(structured.concepts[0]?.unit).toBe("IDR");
  });

  test("CompanyFinancials ID narrows to requested concepts", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: REPORT_TLKM },
      { pattern: "instance.zip", body: makeIdxInstanceZip() },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "TLKM",
      jurisdiction: "ID",
      concepts: ["total_assets"],
    } as never);
    const structured = result.structuredContent as {
      concepts: Array<{ concept: string }>;
    };
    expect(structured.concepts.map((concept) => concept.concept)).toEqual([
      "total_assets",
    ]);
  });

  test("CompanyFinancials ID degrades to the report link when no instance exists", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: REPORT_NO_INSTANCE },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const text = resultText(await toolByName(tools, "CompanyFinancials").handler({
      company: "AALI",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("No XBRL facts could be extracted");
    expect(text).toContain("no XBRL instance");
    // An official link, not a fabricated figure.
    expect(text).toContain(".xlsx");
    expect(text).not.toContain("Rp ");
  });

  test("CompanyFinancials ID reports no submission honestly", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: { ResultCount: 0, Results: [] } },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const text = resultText(await toolByName(tools, "CompanyFinancials").handler({
      company: "TLKM",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("No IDX financial-report submission found");
    expect(text).toContain("legitimately returns nothing");
  });

  test("a blocked host surfaces the inject-a-fetchFn guidance, never an empty result", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "GetCompanyProfiles",
        status: 403,
        body: "<html><title>Attention Required!</title></html>",
      },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    for (const toolName of ["CompanyResolve", "CompanyFilings", "CompanyFinancials"]) {
      resetRateLimiters();
      const result = await toolByName(tools, toolName).handler({
        company: "BBCA",
        jurisdiction: "ID",
      } as never);
      const text = resultText(result);
      expect(text).toContain("browser-backed fetchFn");
      expect(text).toContain("NOT an empty result");
      // Never a bare "nothing found" that would be read as an absence of data.
      expect(text).not.toContain("No IDX announcements found");
    }
  });

  test("an upstream 500 surfaces as an error rather than silence", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", status: 500, body: "boom" },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("500");
  });

  test("CompanyInsiders and CompanyOwners are honest-unsupported for ID", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: {} });
    const insiders = resultText(await toolByName(tools, "CompanyInsiders").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never));
    expect(insiders).toContain("unsupported for jurisdiction \"ID\"");
    expect(insiders).toContain("KSEI");
    expect(insiders).toContain("AHU");

    const owners = resultText(await toolByName(tools, "CompanyOwners").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never));
    expect(owners).toContain("unsupported for jurisdiction \"ID\"");
    expect(owners).toContain("not evidence that no large holder exists");
  });

  test("PrivateRaises is honest-unsupported for ID", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: {} });
    const text = resultText(await toolByName(tools, "PrivateRaises").handler({
      company: "BBCA",
      jurisdiction: "ID",
    } as never));
    expect(text).toContain("unsupported for jurisdiction \"ID\"");
    expect(text).toContain("IDX (Indonesia)");
  });

  test("the ID jurisdiction card documents the browser-fetch posture", () => {
    const card = JURISDICTION_REFERENCE.find(
      (reference) => reference.code === "ID",
    );
    expect(card).toBeDefined();
    expect(card?.name).toBe("Indonesia");
    expect(card?.source).toContain("IDX");
    expect(card?.identifiers).toContain("kode emiten");
    expect(card?.intents).toContain("CompanyFinancials");
    // The wall and its escape hatch are stated in the card itself.
    expect(card?.credential).toContain("fetchFn");
    expect(card?.caveat).toContain("anti-bot");
    expect(card?.caveat).toContain("KSEI");
  });
});
