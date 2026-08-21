import { beforeEach, describe, expect, test } from "bun:test";
import {
  CNINFO_FINANCIALS_MAX_BYTES,
  countCjkChars,
  getCninfoFinancials,
  normalizeCninfoText,
  parseCninfoFinancials,
} from "../src/adapters/cninfo.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, FetchFn } from "../src/core/types.js";
import {
  buildCninfoReportPdf,
  buildImagePdf,
  buildTextLayoutPdf,
} from "./helpers/pdfFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: FetchFn): AdapterOptions {
  return { fetchFn };
}

const M = 1_000_000;
const K = 1_000;

// cninfo resolution + annual-report announcement fixtures (Kweichow Moutai).
const searchRoute: Route = {
  pattern: "topSearch/query",
  body: [
    { code: "600519", zwjc: "贵州茅台", pinyin: "GZMT", category: "A股", orgId: "gssh0600519", delisted: false },
  ],
};

function annualRoute(title = "2025年年度报告", id = "1220000001"): Route {
  return {
    pattern: "hisAnnouncement/query",
    body: {
      totalAnnouncement: 1,
      announcements: [
        {
          secCode: "600519",
          secName: "贵州茅台",
          orgId: "gssh0600519",
          announcementId: id,
          announcementTitle: title,
          announcementTime: 1_744_000_000_000,
          adjunctUrl: `finalpage/2026-04-17/${id}.PDF`,
          announcementTypeName: "年度报告",
        },
      ],
    },
  };
}

const noAnnualRoute: Route = {
  pattern: "hisAnnouncement/query",
  body: { totalAnnouncement: 0, announcements: [] },
};

function pdfRoute(bytes: Uint8Array, headers?: Record<string, string>): Route {
  return { pattern: ".PDF", body: bytes, ...(headers ? { headers } : {}) };
}

beforeEach(() => {
  resetRateLimiters();
});

// --- normalizer + CJK counter ---------------------------------------------

describe("normalizeCninfoText", () => {
  test("joins adjacent CJK glyphs separated by a single space", () => {
    expect(normalizeCninfoText("营 业 收 入")).toBe("营业收入");
    expect(normalizeCninfoText("归 属 于 上 市 公 司 股 东 的 净 利 润")).toBe(
      "归属于上市公司股东的净利润",
    );
  });

  test("strips single spaces inside a number run", () => {
    expect(normalizeCninfoText("1 6 8 , 8 3 8 , 1 0 2 , 5 1 4 . 7 9")).toBe(
      "168,838,102,514.79",
    );
    expect(normalizeCninfoText("- 5 4 . 5 5 %")).toBe("-54.55%");
  });

  test("preserves a 2+-space run so adjacent figure columns stay separate", () => {
    // Single space between two figures would wrongly fuse them; a wider gap must survive.
    expect(normalizeCninfoText("514.79  276.34")).toBe("514.79  276.34");
  });

  test("leaves a label with an inline unit qualifier contiguous", () => {
    expect(normalizeCninfoText("营 业 收 入 （ 千 元 ）")).toBe("营业收入（千元）");
  });
});

describe("countCjkChars", () => {
  test("counts Han ideographs and is zero for Latin/mojibake soup", () => {
    expect(countCjkChars("营业收入 168,838")).toBe(4);
    expect(countCjkChars("iYÒ\twZU'K")).toBe(0);
  });
});

// --- parseCninfoFinancials (realistic line-per-cell extracted text) --------
//
// The shipped extractor emits each positioned cell on its own line, so the
// key-data table reads: label line, then each period's figure on its own line
// (current period first). Fixtures mirror the verified corpus shapes.

const MOUTAI_KEYDATA = [
  "主要会计数据和财务指标",
  "主要会计数据",
  "单位：",
  "元",
  "币种：",
  "人民币",
  "营业收入",
  "168,838,102,514.79",
  "170,899,152,276.34",
  "利润总额",
  "114,755,261,605.08",
  "119,638,578,194.46",
  "归属于上市公司股东的净利润",
  "82,320,067,101.68",
  "86,228,146,421.62",
  "归属于上市公司股东的扣除非",
  "经常性损益的净利润",
  "82,293,107,655.25",
  "2025",
  "年末",
  "2024",
  "年末",
  "总资产",
  "303,834,844,021.44",
  "298,944,579,918.70",
  "归属于上市公司股东的净资产",
  "244,637,811,032.18",
  "233,105,984,399.47",
].join("\n");

function byConcept(text: string): Map<string, number> {
  return new Map(parseCninfoFinancials(text).values.map((v) => [v.concept, v.value]));
}

describe("parseCninfoFinancials", () => {
  test("anchors on 主要会计数据 and reads the current-period (first) column in 元", () => {
    const parsed = parseCninfoFinancials(MOUTAI_KEYDATA);
    expect(parsed.currency).toBe("CNY");
    const v = byConcept(MOUTAI_KEYDATA);
    expect(v.get("revenue")).toBe(168_838_102_514.79);
    expect(v.get("total_profit")).toBe(114_755_261_605.08);
    expect(v.get("net_profit")).toBe(82_320_067_101.68);
    expect(v.get("total_assets")).toBe(303_834_844_021.44);
    expect(v.get("total_equity")).toBe(244_637_811_032.18);
  });

  test("net profit prefers the listed-company-attributable line and labels it so", () => {
    const netProfit = parseCninfoFinancials(MOUTAI_KEYDATA).values.find(
      (row) => row.concept === "net_profit",
    );
    expect(netProfit?.label).toContain("归属于上市公司股东的净利润");
    expect(netProfit?.label).toContain("attributable");
    // The 扣除非经常性损益 (excluding-non-recurring) sibling must not be taken.
    expect(netProfit?.value).toBe(82_320_067_101.68);
  });

  test("scales a 千元 (thousands) table to whole yuan", () => {
    const text = ["主要会计数据", "单位：千元", "营业收入", "423,701,834"].join("\n");
    expect(byConcept(text).get("revenue")).toBe(423_701_834 * K);
  });

  test("scales a （人民币百万元）parenthetical unit (insurer/bank) to whole yuan", () => {
    const text = [
      "主要会计数据及财务指标",
      "（人民币百万元）",
      "营业收入",
      "1,050,506",
      "总资产",
      "13,898,471",
    ].join("\n");
    const v = byConcept(text);
    expect(v.get("revenue")).toBe(1_050_506 * M);
    expect(v.get("total_assets")).toBe(13_898_471 * M);
  });

  test("a per-share （元/股）header is NOT mistaken for the table unit (1,000x trap)", () => {
    // 单位：千元 governs; the nearer 基本每股收益（元/股） must not scale assets to 元.
    const text = [
      "主要会计数据",
      "单位：千元",
      "营业收入",
      "423,701,834",
      "基本每股收益（元/股）",
      "16.14",
      "总资产",
      "974,827,500",
    ].join("\n");
    expect(byConcept(text).get("total_assets")).toBe(974_827_500 * K);
  });

  test("tolerates a wrapped label and an inline （元）unit qualifier", () => {
    const text = [
      "主要会计数据",
      "归属于上市公司股东的",
      "净利润（元）",
      "8,954,257,202.51",
      "31,853,172,533.98",
    ].join("\n");
    const netProfit = parseCninfoFinancials(text).values.find(
      (row) => row.concept === "net_profit",
    );
    expect(netProfit?.value).toBe(8_954_257_202.51);
  });

  test("drops a figure whose scale cannot be determined (never guesses)", () => {
    // No 单位 declaration and no inline qualifier ⇒ the figure is omitted.
    const text = ["主要会计数据", "营业收入", "168,838,102,514.79"].join("\n");
    expect(parseCninfoFinancials(text).values).toHaveLength(0);
  });

  test("returns no values when the 主要会计数据 table is absent", () => {
    const text = ["合并资产负债表", "资产总计", "303,834,844,021.44"].join("\n");
    expect(parseCninfoFinancials(text).values).toHaveLength(0);
  });
});

// --- getCninfoFinancials (fetch + extract + gate) --------------------------

const CLEAN_REPORT_LINES = [
  "主要会计数据",
  "单位：元",
  "营业收入",
  "168,838,102,514.79",
  "170,899,152,276.34",
  "归属于上市公司股东的净利润",
  "82,320,067,101.68",
  "86,228,146,421.62",
  "总资产",
  "303,834,844,021.44",
  "298,944,579,918.70",
  "归属于上市公司股东的净资产",
  "244,637,811,032.18",
  "233,105,984,399.47",
];

describe("getCninfoFinancials", () => {
  test("extracts the key-data facts from the latest annual report PDF", async () => {
    const pdf = buildCninfoReportPdf(CLEAN_REPORT_LINES);
    const fetchFn = routedFetch([searchRoute, annualRoute(), pdfRoute(pdf)]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBeUndefined();
    expect(result.reportKind).toBe("annual");
    expect(result.periodEnd).toBe("2025-12-31");
    expect(result.currency).toBe("CNY");
    const v = new Map(result.facts.map((f) => [f.concept, f.value]));
    expect(v.get("revenue")).toBe(168_838_102_514.79);
    expect(v.get("net_profit")).toBe(82_320_067_101.68);
    expect(v.get("total_assets")).toBe(303_834_844_021.44);
    // Facts carry the CNY unit, the report form, and the source URL.
    const revenue = result.facts.find((f) => f.concept === "revenue");
    expect(revenue?.unit).toBe("CNY");
    expect(revenue?.form).toContain("Annual report");
    expect(revenue?.sourceUrl).toContain("static.cninfo.com.cn");
  });

  test("degrades to link-only on a mojibake (cjk === 0) report", async () => {
    // A simple-font PDF carrying CJK bytes decodes to Latin soup — the ObjStm class.
    const mojibake = buildTextLayoutPdf(["营业收入", "168,838,102,514.79"]);
    const fetchFn = routedFetch([searchRoute, annualRoute(), pdfRoute(mojibake)]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBe("mojibake");
    expect(result.facts).toHaveLength(0);
    expect(result.cjkChars).toBe(0);
    expect(result.report?.sourceUrl).toContain(".PDF");
  });

  test("degrades to link-only when the PDF exceeds the 40 MB cap (via HEAD)", async () => {
    const fetchFn = routedFetch([
      searchRoute,
      annualRoute(),
      pdfRoute(buildCninfoReportPdf(CLEAN_REPORT_LINES), {
        "Content-Length": String(CNINFO_FINANCIALS_MAX_BYTES + 1),
      }),
    ]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBe("over-cap");
    expect(result.facts).toHaveLength(0);
    // The GET is never issued once HEAD reports an over-cap size.
    expect(fetchFn.requests.filter((r) => r.url.includes(".PDF")).length).toBe(1);
  });

  test("degrades to link-only when no key-data table is found", async () => {
    // A readable (CJK) report with no 主要会计数据 anchor.
    const pdf = buildCninfoReportPdf(["合并资产负债表", "资产总计", "303,834,844,021.44"]);
    const fetchFn = routedFetch([searchRoute, annualRoute(), pdfRoute(pdf)]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBe("no-statements");
    expect(result.facts).toHaveLength(0);
  });

  test("degrades to link-only on a scanned image-only report (no text)", async () => {
    const fetchFn = routedFetch([searchRoute, annualRoute(), pdfRoute(buildImagePdf())]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBe("mojibake");
    expect(result.facts).toHaveLength(0);
  });

  test("reports no-report when the issuer has no periodic report on file", async () => {
    const fetchFn = routedFetch([searchRoute, noAnnualRoute]);
    const result = await getCninfoFinancials("600519", options(fetchFn));
    expect(result.reason).toBe("no-report");
    expect(result.report).toBeNull();
  });
});
