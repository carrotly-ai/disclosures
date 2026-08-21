import { describe, expect, test } from "bun:test";
import {
  detectHkexUnit,
  parseHkexResultsText,
} from "../src/adapters/hkexNews.js";

const M = 1_000_000;
const K = 1_000;

// Corpus-driven fixtures — the label/figure layouts are verbatim shapes from the
// real extracted samples in HKSG-DEEPDIVE.md (China Mobile, Tencent, a REIT).

// China Mobile: same-line label + both-year columns, RMB million, total revenue
// unlabeled, and both a "Total equity attributable..." subtotal and a standalone
// "Total equity" total (the parser must pick the total, not the subtotal).
const STANDARD_RMB = [
  "CONSOLIDATED STATEMENT OF COMPREHENSIVE INCOME",
  "For the year ended 31 December 2025",
  "(Expressed in RMB million)",
  "2025 2024",
  "Revenue from principal businesses 895,530 889,468",
  "Revenue from other businesses 154,657 151,291",
  "1,050,187 1,040,759",
  "Profit from operations 148,900 145,000",
  "Profit before taxation 175,608 178,389",
  "Taxation 10 (38,344) (39,863)",
  "PROFIT FOR THE YEAR 137,264 138,526",
  "CONSOLIDATED STATEMENT OF FINANCIAL POSITION",
  "Total assets 2,128,182 2,108,127",
  "Total liabilities 695,331 711,588",
  "Total equity attributable to equity shareholders of the Company 1,428,475 1,392,032",
  "Total equity 1,432,851 1,396,539",
].join("\n");

// Tencent: label-only rows with one figure per following line, RMB million, and
// a labelled "Revenue" total.
const ONE_FIGURE_PER_LINE_RMB = [
  "For the year ended 31 December 2025",
  "(All amounts in RMB million)",
  "Revenue",
  "660,257",
  "609,015",
  "Total assets",
  "2,038,986",
  "1,780,995",
  "Total equity",
  "1,241,065",
  "1,053,896",
].join("\n");

// REIT variant: HK$'000, "Net assets attributable to unitholders" instead of
// "Total equity".
const REIT_HKD = [
  "For the year ended 31 December 2025",
  "(Expressed in HK$'000)",
  "Revenue 12,000,000 11,500,000",
  "Total assets 95,000,000 94,000,000",
  "Net assets attributable to unitholders 70,000,000 69,000,000",
].join("\n");

function byConcept(text: string): Map<string, number> {
  const parsed = parseHkexResultsText(text);
  if (!parsed) throw new Error("expected a parse");
  return new Map(parsed.values.map((v) => [v.concept, v.value]));
}

describe("detectHkexUnit", () => {
  test("reads the currency and scale from the filing declaration", () => {
    expect(detectHkexUnit("(Expressed in RMB million)")).toEqual({ currency: "CNY", scale: M });
    expect(detectHkexUnit("in HK$ million")).toEqual({ currency: "HKD", scale: M });
    expect(detectHkexUnit("HK$'000")).toEqual({ currency: "HKD", scale: K });
    expect(detectHkexUnit("RMB'000")).toEqual({ currency: "CNY", scale: K });
    expect(detectHkexUnit("Total assets ($m) and US$m columns")).toEqual({ currency: "USD", scale: M });
  });

  test("returns undefined when no unit is declared (never guess a scale)", () => {
    expect(detectHkexUnit("Total assets 2,128,182 2,108,127")).toBeUndefined();
  });
});

describe("parseHkexResultsText", () => {
  test("parses a standard RMB issuer, preferring the total-equity total", () => {
    const parsed = parseHkexResultsText(STANDARD_RMB);
    expect(parsed?.currency).toBe("CNY");
    expect(parsed?.periodEnd).toBe("2025-12-31");
    const values = byConcept(STANDARD_RMB);
    expect(values.get("operating_profit")).toBe(148_900 * M);
    expect(values.get("profit_before_tax")).toBe(175_608 * M);
    expect(values.get("net_profit")).toBe(137_264 * M);
    expect(values.get("total_assets")).toBe(2_128_182 * M);
    // The standalone total, NOT the "attributable to..." subtotal (1,428,475).
    expect(values.get("total_equity")).toBe(1_432_851 * M);
    // Total revenue is unlabelled here, so revenue is honestly not emitted.
    expect(values.has("revenue")).toBe(false);
  });

  test("parses one-figure-per-line layout, taking the first (current) column", () => {
    const values = byConcept(ONE_FIGURE_PER_LINE_RMB);
    expect(values.get("revenue")).toBe(660_257 * M);
    expect(values.get("total_assets")).toBe(2_038_986 * M);
    expect(values.get("total_equity")).toBe(1_241_065 * M);
  });

  test("parses a REIT via the unitholder-equity label, in HK$'000", () => {
    const parsed = parseHkexResultsText(REIT_HKD);
    expect(parsed?.currency).toBe("HKD");
    const values = byConcept(REIT_HKD);
    expect(values.get("total_assets")).toBe(95_000_000 * K);
    expect(values.get("total_equity")).toBe(70_000_000 * K);
    // The total_equity concept honestly labels the REIT line item it matched.
    const equity = parsed?.values.find((v) => v.concept === "total_equity");
    expect(equity?.concept).toBe("total_equity");
    expect(equity?.label).toBe("Net assets attributable to unitholders");
  });

  test("returns undefined when the unit cannot be determined", () => {
    expect(parseHkexResultsText("Total assets 2,128,182\nTotal equity 1,432,851")).toBeUndefined();
  });
});
