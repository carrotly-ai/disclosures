import { beforeEach, describe, expect, test } from "bun:test";
import {
  getCninfoInsiders,
  getCninfoOwners,
  parseCninfoBoardRoster,
  parseCninfoTopShareholders,
} from "../src/adapters/cninfo.js";
import { getSzseInsiderChanges } from "../src/adapters/szse.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, FetchFn } from "../src/core/types.js";
import { buildCninfoReportPdf, buildTextLayoutPdf } from "./helpers/pdfFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

function options(fetchFn: FetchFn): AdapterOptions {
  return { fetchFn };
}

// SSE-listed issuer (Moutai) — routes to the annual-report roster path.
const sseSearchRoute: Route = {
  pattern: "topSearch/query",
  body: [
    { code: "600519", zwjc: "贵州茅台", pinyin: "GZMT", orgId: "gssh0600519", delisted: false },
  ],
};

// SZSE-listed issuer (Wuliangye) — routes to the structured 董监高 feed.
const szseSearchRoute: Route = {
  pattern: "topSearch/query",
  body: [
    { code: "000858", zwjc: "五粮液", pinyin: "WLY", orgId: "gssz0000858", delisted: false },
  ],
};

const annualRoute: Route = {
  pattern: "hisAnnouncement/query",
  body: {
    totalAnnouncement: 1,
    announcements: [
      {
        secCode: "600519",
        secName: "贵州茅台",
        orgId: "gssh0600519",
        announcementId: "1225114741",
        announcementTitle: "2025年年度报告",
        announcementTime: 1_744_000_000_000,
        adjunctUrl: "finalpage/2026-04-17/1225114741.PDF",
        announcementTypeName: "年度报告",
      },
    ],
  },
};

const noReportRoute: Route = {
  pattern: "hisAnnouncement/query",
  body: { totalAnnouncement: 0, announcements: [] },
};

function pdfRoute(bytes: Uint8Array, headers?: Record<string, string>): Route {
  return { pattern: ".PDF", body: bytes, ...(headers ? { headers } : {}) };
}

beforeEach(() => {
  resetRateLimiters();
});

// --- parseCninfoTopShareholders -------------------------------------------
//
// Corpus shapes: the extractor emits each positioned cell on its own line, and
// column ORDER varies by issuer — Moutai is name → 增减 → 期末持股数量 → 比例 →
// 性质, CATL is name → 性质 → 比例 → 期末持股数量 → 增减. The parser must key on
// cell shape, not position, so both parse to the same fields.

const MOUTAI_TOP10 = [
  "前十名股东持股情况",
  "股东名称",
  "报告期内增减",
  "期末持股数量",
  "比例(%)",
  "股东性质",
  "中国贵州茅台酒厂（集团）有限责任公司",
  "2,071,359",
  "681,282,935",
  "54.40",
  "国有法人",
  "贵州省国有资本运营有限责任公司",
  "0",
  "56,996,777",
  "4.55",
  "国有法人",
  "香港中央结算有限公司",
  "-22,462,778",
  "55,048,844",
  "4.40",
  "境外法人",
].join("\n");

// CATL's issuer-specific ordering: nature and percentage precede the count.
const CATL_TOP10 = [
  "前十名股东持股情况",
  "厦门瑞庭投资有限公司",
  "境内一般法人",
  "22.45%",
  "1,024,704,949",
  "香港中央结算有限公司",
  "境外法人",
  "8.12%",
  "370,585,432",
].join("\n");

describe("parseCninfoTopShareholders", () => {
  test("parses the Moutai column order (name, change, count, pct, nature)", () => {
    const rows = parseCninfoTopShareholders(MOUTAI_TOP10);
    expect(rows).toHaveLength(3);
    const largest = rows[0]!;
    expect(largest.holderName).toBe("中国贵州茅台酒厂（集团）有限责任公司");
    expect(largest.pct).toBe(54.4);
    expect(largest.shareCount).toBe(681_282_935);
    expect(largest.nature).toBe("国有法人");
    // The nominee/custodian holder appears as printed, with its negative change
    // never mistaken for the holding count.
    expect(rows[2]!.holderName).toBe("香港中央结算有限公司");
    expect(rows[2]!.shareCount).toBe(55_048_844);
    expect(rows[2]!.pct).toBe(4.4);
  });

  test("parses CATL's different column order to the same fields", () => {
    const rows = parseCninfoTopShareholders(CATL_TOP10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      holderName: "厦门瑞庭投资有限公司",
      pct: 22.45,
      shareCount: 1_024_704_949,
      nature: "境内一般法人",
    });
  });

  test("tolerates a ragged row (no change cell) and a wrapped holder name", () => {
    const text = [
      "前十名股东持股情况",
      "中国证券金融股份",
      "有限公司",
      "12,345,678",
      "1.23",
      "国有法人",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.holderName).toBe("中国证券金融股份有限公司");
    expect(rows[0]!.shareCount).toBe(12_345_678);
    expect(rows[0]!.pct).toBe(1.23);
  });

  test("degrades honestly: a row with no matchable count/pct is dropped", () => {
    // A name with no numeric cells at all cannot be emitted confidently.
    const text = ["前十名股东持股情况", "某某投资有限公司", "未知"].join("\n");
    expect(parseCninfoTopShareholders(text)).toHaveLength(0);
  });

  test("returns nothing when the 前十名股东 table is absent", () => {
    const text = ["主要会计数据", "营业收入", "168,838,102,514.79"].join("\n");
    expect(parseCninfoTopShareholders(text)).toHaveLength(0);
  });

  test("caps at ten rows even when more names follow", () => {
    const lines = ["前十名股东持股情况"];
    for (let i = 0; i < 14; i += 1) {
      lines.push(`第${i}号投资有限公司`, `${1_000_000 + i}`, `${(i + 1) / 10}`);
    }
    expect(parseCninfoTopShareholders(lines.join("\n")).length).toBeLessThanOrEqual(10);
  });

  test("works through the per-glyph space-separated extractor output", () => {
    // The real extractor space-separates every glyph; the normalizer runs first.
    const spaced = MOUTAI_TOP10.split("\n")
      .map((line) => [...line].join(" "))
      .join("\n");
    const rows = parseCninfoTopShareholders(spaced);
    expect(rows[0]!.holderName).toBe("中国贵州茅台酒厂（集团）有限责任公司");
    expect(rows[0]!.pct).toBe(54.4);
  });

  // --- Regressions caught by live verification, not by the synthetic fixtures.
  // Each of these shapes was found running the built server against real
  // cninfo PDFs (Moutai 600519 half-year, CATL 300750 half-year) and silently
  // corrupted the output before the fix.

  test("the wrapped header block never swallows the largest shareholder", () => {
    // Moutai's real header wraps into ~20 one-per-line fragments before the
    // first data row. Left in the stream they accumulated into the first
    // holder's name buffer and pushed it past the length guard, DROPPING the
    // 54.5%控股股东 entirely while every smaller holder still parsed.
    const text = [
      "单位：",
      "股",
      "前十名股东持股情况",
      "（不含通过转融通出借股份）",
      "股东名称",
      "（全称）",
      "报告期内增",
      "减",
      "期末持股数",
      "量",
      "比例",
      "( % )",
      "持有有限",
      "售条件股",
      "份数量",
      "质押",
      "、标记",
      "或冻",
      "结情况",
      "股东",
      "性质",
      "股份状态",
      "数量",
      "中国贵州茅台酒厂（集",
      "团）有限责任公司",
      "681,282,935",
      "54.50",
      "无",
      "国有",
      "法人",
      "贵州省国有资本运营有限",
      "责任公司",
      "56,996,777",
      "4.56",
      "未知",
      "国有",
      "法人",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows[0]).toMatchObject({
      holderName: "中国贵州茅台酒厂（集团）有限责任公司",
      shareCount: 681_282_935,
      pct: 54.5,
      // 国有 + 法人 arrive as two cells and must re-join.
      nature: "国有法人",
    });
    expect(rows[1]!.holderName).toBe("贵州省国有资本运营有限责任公司");
  });

  test("page furniture is never emitted as a shareholder row", () => {
    // A footer ("…2026 年半年度报告" + a page number) sat inside the region and
    // parsed as two junk rows ("贵州茅台酒股份有限公司 | 202 | 6%").
    // Requiring a comma-grouped count and an explicit/fractional percentage
    // rejects it.
    const text = [
      "前十名股东持股情况",
      "股东名称",
      "中国贵州茅台酒厂（集团）有限责任公司",
      "681,282,935",
      "54.50",
      "国有法人",
      "贵州茅台酒股份有限公司",
      "202",
      "6",
      "年半年度报告",
      "110",
      "24",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.holderName).toBe("中国贵州茅台酒厂（集团）有限责任公司");
  });

  test("finds the heading when the count is an Arabic numeral split across lines", () => {
    // CATL words it "持股5%以上的股东或前" / "10" / "名股东持股情况（不含…）" —
    // no 前十 substring at all, and split over three lines, so a fixed
    // 前十名股东持股情况 match found nothing and the whole table was lost.
    const text = [
      "持股",
      "5%",
      "以上的股东或前",
      "10",
      "名股东持股情况（不含通过转融通出借股份）",
      "股东名称",
      "厦门瑞庭投资有限公司",
      "境内一般",
      "法人",
      "22.04%",
      "1,019,704,949",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      holderName: "厦门瑞庭投资有限公司",
      shareCount: 1_019_704_949,
      pct: 22.04,
      nature: "境内一般法人",
    });
  });

  test("splits a nature that shares one cell with a short personal name", () => {
    // Narrow columns emit no gap, so "黄世霖境内自然人" arrives as ONE cell and
    // was reported verbatim as the holder name.
    const text = [
      "前十名股东持股情况",
      "黄世霖境内自然人",
      "9.09%",
      "420,388,947",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows[0]).toMatchObject({
      holderName: "黄世霖",
      nature: "境内自然人",
      shareCount: 420_388_947,
      pct: 9.09,
    });
  });

  test("skips the separate 无限售条件股东 follow-on table", () => {
    // That sub-table shares the 名股东持股情况 tail; anchoring on the tail alone
    // would land on it instead of the main top-10 table.
    const text = [
      "前十名股东持股情况",
      "中国贵州茅台酒厂（集团）有限责任公司",
      "681,282,935",
      "54.50",
      "国有法人",
      "前十名无限售条件股东持股情况",
      "某某无限售股东",
      "1,111,111",
      "1.11",
    ].join("\n");
    const rows = parseCninfoTopShareholders(text);
    expect(rows[0]!.holderName).toBe("中国贵州茅台酒厂（集团）有限责任公司");
  });
});

// --- parseCninfoBoardRoster ------------------------------------------------

const MOUTAI_ROSTER = [
  "董事、监事、高级管理人员情况",
  "姓名",
  "职务",
  "性别",
  "年龄",
  "任期起始日期",
  "陈华",
  "党委书记、董事长",
  "男",
  "54",
  "2025年10月",
  "王莉",
  "董事、总经理",
  "女",
  "50",
  "邹涛",
  "董事",
  "男",
  "51",
].join("\n");

describe("parseCninfoBoardRoster", () => {
  test("extracts names with their positions, skipping header cells", () => {
    const roster = parseCninfoBoardRoster(MOUTAI_ROSTER);
    expect(roster).toContainEqual({ name: "陈华", position: "党委书记、董事长" });
    expect(roster).toContainEqual({ name: "王莉", position: "董事、总经理" });
    expect(roster).toContainEqual({ name: "邹涛", position: "董事" });
    // Header labels are never emitted as people.
    expect(roster.some((m) => m.name === "姓名")).toBe(false);
  });

  test("does not emit a name whose next cell carries no governance role", () => {
    const text = [
      "董事、监事、高级管理人员情况",
      "张三",
      "男",
      "45",
    ].join("\n");
    expect(parseCninfoBoardRoster(text)).toHaveLength(0);
  });

  test("returns nothing when the roster section is absent", () => {
    expect(parseCninfoBoardRoster("主要会计数据\n营业收入\n1,000,000")).toHaveLength(0);
  });

  test("works through the per-glyph space-separated extractor output", () => {
    const spaced = MOUTAI_ROSTER.split("\n")
      .map((line) => [...line].join(" "))
      .join("\n");
    expect(parseCninfoBoardRoster(spaced)).toContainEqual({
      name: "陈华",
      position: "党委书记、董事长",
    });
  });
});

// --- getCninfoOwners (fetch + extract + gate) ------------------------------

const OWNERS_REPORT_LINES = MOUTAI_TOP10.split("\n");

describe("getCninfoOwners", () => {
  test("returns the top-10 rows from the freshest periodic report", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildCninfoReportPdf(OWNERS_REPORT_LINES)),
    ]);
    const result = await getCninfoOwners("600519", options(fetchFn));
    expect(result.reason).toBeUndefined();
    expect(result.owners).toHaveLength(3);
    expect(result.owners[0]!.holderName).toBe("中国贵州茅台酒厂（集团）有限责任公司");
    expect(result.owners[0]!.pct).toBe(54.4);
    expect(result.periodEnd).toBe("2025-12-31");
    expect(result.report?.sourceUrl).toContain("static.cninfo.com.cn");
  });

  test("degrades to link-only on a mojibake (cjk === 0) report", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildTextLayoutPdf(["前十名股东持股情况", "中国贵州茅台酒厂"])),
    ]);
    const result = await getCninfoOwners("600519", options(fetchFn));
    expect(result.reason).toBe("mojibake");
    expect(result.owners).toHaveLength(0);
    expect(result.cjkChars).toBe(0);
    expect(result.report?.sourceUrl).toContain(".PDF");
  });

  test("degrades to link-only when the table cannot be located", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildCninfoReportPdf(["主要会计数据", "营业收入", "168,838,102,514.79"])),
    ]);
    const result = await getCninfoOwners("600519", options(fetchFn));
    expect(result.reason).toBe("no-table");
    expect(result.owners).toHaveLength(0);
  });

  test("reports no-report when the issuer has no periodic report on file", async () => {
    const fetchFn = routedFetch([sseSearchRoute, noReportRoute]);
    const result = await getCninfoOwners("600519", options(fetchFn));
    expect(result.reason).toBe("no-report");
    expect(result.report).toBeNull();
  });
});

// --- SZSE structured insider feed -----------------------------------------

function szseRoute(rows: Array<Record<string, string>>, recordcount = rows.length): Route {
  return {
    pattern: "ShowReport/data",
    body: [{ metadata: { recordcount, pagesize: 20, pageno: 1 }, data: rows }],
  };
}

const SZSE_ROWS = [
  {
    zqdm: "000858",
    zqjc: "五粮液",
    ggxm: "李四",
    jyrq: "2026-08-27",
    bdgs: "-40.00",
    bdjj: "10.74",
    bdyy: "竞价交易",
    cgbdbl: "0.4969",
    cgzs: "7,091.75",
    gdxm: "李四",
    zw: "董事、高管",
    gxlb: "本人",
  },
  {
    zqdm: "000858",
    zqjc: "五粮液",
    ggxm: "王五",
    jyrq: "2026-08-26",
    bdgs: "1.03",
    bdjj: "30.67",
    bdyy: "大宗交易",
    cgbdbl: "0.0086",
    cgzs: "56.00",
    gdxm: "王五配偶",
    zw: "董秘",
    gxlb: "配偶",
  },
];

describe("getSzseInsiderChanges", () => {
  test("maps the SZSE JSON rows and converts 万股 to whole shares", async () => {
    const fetchFn = routedFetch([szseRoute(SZSE_ROWS)]);
    const changes = await getSzseInsiderChanges("000858", options(fetchFn));
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      insiderName: "李四",
      position: "董事、高管",
      changeDate: "2026-08-27",
      reason: "竞价交易",
      relationship: "本人",
    });
    // -40.00 万股 = -400,000 shares; 7,091.75 万股 = 70,917,500 shares.
    expect(changes[0]!.sharesChanged).toBe(-400_000);
    expect(changes[0]!.balanceShares).toBe(70_917_500);
    expect(changes[0]!.avgPrice).toBe(10.74);
    expect(changes[0]!.changeRatioPermille).toBe(0.4969);
    // A relative's holding is reported under the insider with the relationship.
    expect(changes[1]!.holderName).toBe("王五配偶");
    expect(changes[1]!.relationship).toBe("配偶");
  });

  test("sends the stock code as the query filter with a szse.cn Referer", async () => {
    const fetchFn = routedFetch([szseRoute(SZSE_ROWS)]);
    await getSzseInsiderChanges("000858", options(fetchFn));
    const request = fetchFn.requests[0]!;
    expect(request.url).toContain("txtDMorJC=000858");
    expect(request.url).toContain("CATALOGID=1801_cxda");
    const headers = request.init?.headers as Record<string, string>;
    expect(headers.Referer).toContain("szse.cn");
  });

  test("returns nothing for a non-6-digit code without a network call", async () => {
    const fetchFn = routedFetch([]);
    expect(await getSzseInsiderChanges("MOUTAI", options(fetchFn))).toHaveLength(0);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("stops paging once the server's recordcount is exhausted", async () => {
    const fetchFn = routedFetch([szseRoute(SZSE_ROWS, 2)]);
    await getSzseInsiderChanges("000858", options(fetchFn));
    expect(fetchFn.requests).toHaveLength(1);
  });
});

// --- getCninfoInsiders (per-exchange routing) ------------------------------

describe("getCninfoInsiders", () => {
  test("routes a SZSE issuer (0xxxxx) to the structured share-change feed", async () => {
    const fetchFn = routedFetch([szseSearchRoute, szseRoute(SZSE_ROWS)]);
    const result = await getCninfoInsiders("000858", options(fetchFn));
    expect(result.exchange).toBe("SZSE");
    expect(result.mode).toBe("szse-structured");
    expect(result.changes).toHaveLength(2);
    // The PDF path is never touched for a SZSE issuer.
    expect(fetchFn.requests.some(({ url }) => url.includes(".PDF"))).toBe(false);
  });

  test("routes an SSE issuer (6xxxxx) to the annual-report 董监高 roster", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildCninfoReportPdf(MOUTAI_ROSTER.split("\n"))),
    ]);
    const result = await getCninfoInsiders("600519", options(fetchFn));
    expect(result.exchange).toBe("SSE");
    expect(result.mode).toBe("pdf-roster");
    expect(result.roster).toContainEqual({ name: "陈华", position: "党委书记、董事长" });
    // The SZSE feed is never queried for an SSE issuer.
    expect(fetchFn.requests.some(({ url }) => url.includes("ShowReport"))).toBe(false);
  });

  test("SZSE issuer with no reported changes degrades honestly", async () => {
    const fetchFn = routedFetch([szseSearchRoute, szseRoute([], 0)]);
    const result = await getCninfoInsiders("000858", options(fetchFn));
    expect(result.reason).toBe("no-records");
    expect(result.changes).toHaveLength(0);
  });

  test("SSE roster degrades to link-only on a mojibake report", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildTextLayoutPdf(["董事、监事、高级管理人员情况", "陈华"])),
    ]);
    const result = await getCninfoInsiders("600519", options(fetchFn));
    expect(result.reason).toBe("mojibake");
    expect(result.roster).toBeUndefined();
  });

  test("SSE roster degrades to link-only when the table is absent", async () => {
    const fetchFn = routedFetch([
      sseSearchRoute,
      annualRoute,
      pdfRoute(buildCninfoReportPdf(["主要会计数据", "营业收入", "1,000,000"])),
    ]);
    const result = await getCninfoInsiders("600519", options(fetchFn));
    expect(result.reason).toBe("no-table");
  });
});
