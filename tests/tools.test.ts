import { beforeEach, describe, expect, test } from "bun:test";
import { TOOL_NAMES, createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetSecTickerCache } from "../src/adapters/secEdgar.js";
import { resetOpenDartCorpCodeCache } from "../src/adapters/openDart.js";
import { resetRateLimiters, secRateLimiter } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env, ToolResult } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";
import { makeStoredZip } from "./helpers/zipFixture.js";
import { edinetCodeListRoute, edinetDay } from "./helpers/edinetFixture.js";
import { resetEdinetCodeCache } from "../src/adapters/edinet.js";

const ENV: Env = { DISCLOSURES_USER_AGENT: "Test test@example.com" };
const GB_ENV: Env = {
  ...ENV,
  COMPANIES_HOUSE_API_KEY: "test-companies-house-key",
};

const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
};

const tickersRoute: Route = { pattern: "company_tickers.json", body: TICKERS };

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

function gleifRecord(lei: string, legalName: string, jurisdiction = "US"): Record<string, unknown> {
  return {
    type: "lei-records",
    id: lei,
    attributes: {
      lei,
      entity: {
        legalName: { name: legalName },
        otherNames: [],
        jurisdiction,
        status: "ACTIVE",
      },
      registration: { status: "ISSUED" },
    },
    relationships: {},
    links: { self: `https://api.gleif.org/api/v1/lei-records/${lei}` },
  };
}

function gleifCollection(data: Array<Record<string, unknown>>): Record<string, unknown> {
  return { meta: { pagination: { total: data.length } }, links: {}, data };
}

function submissionsFixture(
  rows: Array<{ form: string; filed: string; accession: string; primaryDocument?: string }>,
): unknown {
  return {
    name: "Apple Inc.",
    filings: {
      recent: {
        accessionNumber: rows.map((row) => row.accession),
        filingDate: rows.map((row) => row.filed),
        reportDate: rows.map(() => ""),
        form: rows.map((row) => row.form),
        primaryDocument: rows.map((row) => row.primaryDocument ?? ""),
        primaryDocDescription: rows.map(() => ""),
      },
    },
  };
}

const KR_ENV: Env = { ...ENV, OPENDART_API_KEY: "test-opendart-key" };

const KR_CORP_CODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>00126380</corp_code>
    <corp_name>삼성전자</corp_name>
    <corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name>
    <stock_code>005930</stock_code>
    <modify_date>20230101</modify_date>
  </list>
</result>`;

const krCorpCodeRoute: Route = {
  pattern: "corpCode.xml",
  body: makeStoredZip("CORPCODE.xml", KR_CORP_CODE_XML),
};

const JP_ENV: Env = { ...ENV, EDINET_API_KEY: "test-edinet-key" };

const JP_DAY = [
  {
    docID: "S100ANNUAL",
    edinetCode: "E02144",
    secCode: "72030",
    filerName: "トヨタ自動車株式会社",
    docTypeCode: "120",
    docDescription: "有価証券報告書－第120期",
    submitDateTime: "2026-06-25 09:00",
  },
  {
    docID: "S100QTR",
    edinetCode: "E02144",
    secCode: "72030",
    filerName: "トヨタ自動車株式会社",
    docTypeCode: "140",
    docDescription: "四半期報告書",
    submitDateTime: "2026-08-05 10:00",
  },
];

const jpDocumentsRoute: Route = { pattern: "documents.json", body: edinetDay(JP_DAY) };

beforeEach(() => {
  resetRateLimiters();
  resetSecTickerCache();
  resetOpenDartCorpCodeCache();
  resetEdinetCodeCache();
});

describe("createTools", () => {
  test("returns exactly the seven tools in TOOL_NAMES order", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toHaveLength(7);
  });

  test("company jurisdiction accepts US/GB/KR/JP and descriptions cover KR and JP", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: GB_ENV });
    for (const tool of tools.filter((candidate) => candidate.name !== "OwnershipChain")) {
      const jurisdiction = tool.inputSchema.jurisdiction;
      expect(jurisdiction?.safeParse("US").success).toBe(true);
      expect(jurisdiction?.safeParse("GB").success).toBe(true);
      expect(jurisdiction?.safeParse("KR").success).toBe(true);
      expect(jurisdiction?.safeParse("JP").success).toBe(true);
      expect(tool.description).toMatch(/KR|OpenDART/);
      expect(tool.description).toMatch(/JP|EDINET/);
    }
  });
});

describe("missing SEC configuration", () => {
  const SEC_BACKED = [
    "CompanyFilings",
    "CompanyInsiders",
    "CompanyOwners",
    "CompanyFinancials",
    "PrivateRaises",
  ] as const;

  for (const name of SEC_BACKED) {
    test(`${name} returns isError mentioning DISCLOSURES_USER_AGENT`, async () => {
      const fetchFn = routedFetch([]); // any request would throw
      const tools = createTools({ fetchFn, env: {} });
      const result = await toolByName(tools, name).handler({ company: "AAPL" } as never);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("DISCLOSURES_USER_AGENT");
      expect(fetchFn.requests).toHaveLength(0);
    });
  }
});

describe("OwnershipChain", () => {
  test("works without SEC configuration (GLEIF-only path)", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Blei%5D",
        body: gleifCollection([
          {
            ...gleifRecord(APPLE_LEI, "APPLE INC."),
            relationships: {
              "direct-parent": {
                links: {
                  "reporting-exception": `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-parent-reporting-exception`,
                },
              },
              "direct-children": {
                links: {
                  related: `https://api.gleif.org/api/v1/lei-records/${APPLE_LEI}/direct-children`,
                },
              },
            },
          },
        ]),
      },
      {
        pattern: "direct-parent-reporting-exception",
        body: {
          data: {
            type: "reporting-exceptions",
            attributes: { category: "DIRECT_ACCOUNTING_CONSOLIDATION_PARENT", reason: "NATURAL_PERSONS" },
          },
        },
      },
      {
        pattern: "direct-children",
        body: gleifCollection([
          gleifRecord("549300GT3HHPZ7TS8V70", "Apple Sales International", "IE"),
        ]),
      },
    ]);
    const tools = createTools({ fetchFn, env: {} }); // no SEC env at all
    const result = await toolByName(tools, "OwnershipChain").handler({ company: APPLE_LEI } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("APPLE INC.");
    expect(text).toContain("NATURAL_PERSONS");
    expect(text).toContain("Apple Sales International");
    expect(text).toContain("Known direct children (1)");
  });
});

describe("CompanyResolve", () => {
  test("combines SEC and GLEIF rows when both are configured", async () => {
    const fetchFn = routedFetch([
      tickersRoute,
      {
        pattern: "filter%5Bentity.legalName%5D",
        body: gleifCollection([gleifRecord(APPLE_LEI, "APPLE INC.")]),
      },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({ company: "AAPL" } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("| Legal name |");
    expect(text).toContain("0000320193");
    expect(text).toContain("Exact ticker");
    expect(text).toContain(APPLE_LEI);
    expect(text).toContain("GLEIF");
    expect(fetchFn.requests.every(({ url }) =>
      !url.includes("company-information.service.gov.uk")
    )).toBe(true);
  });

  test("LEI input goes GLEIF-only", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Blei%5D",
        body: gleifCollection([gleifRecord(APPLE_LEI, "APPLE INC.")]),
      },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({ company: APPLE_LEI } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("Exact LEI match");
    // Only the GLEIF lookup ran — no SEC endpoints touched.
    expect(fetchFn.requests).toHaveLength(1);
    expect(fetchFn.requests[0]?.url).toContain("api.gleif.org");
  });

  test("unresolvable input returns Could not find without isError", async () => {
    const fetchFn = routedFetch([
      tickersRoute,
      { pattern: "browse-edgar", body: "<feed></feed>" },
      { pattern: "filter%5Bentity.legalName%5D", body: gleifCollection([]) },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "Zzyzx Widgets",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('Could not find a company matching "Zzyzx Widgets"');
  });
});

describe("explicit GB routing", () => {
  test("CompanyResolve uses Companies House only and shows the foreign identifier compactly", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/search/companies",
        body: {
          items: [
            {
              title: "EXAMPLE LIMITED",
              company_number: "01234567",
              company_status: "active",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "Example Limited",
      jurisdiction: "GB",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Companies House");
    expect(text).toContain("CH 01234567");
    expect(text).toContain("Exact normalized legal-name match");
    expect(fetchFn.requests).toHaveLength(1);
    expect(fetchFn.requests[0]?.url).toContain("api.company-information.service.gov.uk");
  });

  test("an explicit GB number is never sent to SEC", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/company/01234567",
        body: {
          company_number: "01234567",
          company_name: "EXAMPLE LIMITED",
          company_status: "active",
          jurisdiction: "england-wales",
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(fetchFn.requests).toHaveLength(1);
    expect(fetchFn.requests[0]?.url).not.toContain("sec.gov");
  });

  test("CompanyFilings renders type/category/description and states it returns links, not text", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/filing-history",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_count: 1,
          items: [
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-small",
              date: "2024-09-30",
              transaction_id: "accounts-tx",
              links: { document_metadata: "/document/accounts" },
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "01234567",
      jurisdiction: "GB",
      forms: ["accounts"],
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("| Filed | Type | Category | Description | Link |");
    expect(text).toContain("Accounts with accounts type small");
    expect(text).toContain("does not return document text");
    expect(text).toContain("find-and-update.company-information.service.gov.uk");
  });

  test("latest quarterly is a successful plain unsupported explanation", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "01234567",
      jurisdiction: "GB",
      mode: "latest_quarterly",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("unsupported for GB");
    expect(resultText(result)).toContain("not a normalized quarterly-report equivalent");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyInsiders omits address, nationality, and partial birth date", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/officers",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 1,
          items: [
            {
              name: "DOE, Jane",
              officer_role: "director",
              occupation: "Engineer",
              appointed_on: "2020-01-01",
              address: { address_line_1: "Private output" },
              nationality: "British",
              date_of_birth: { month: 1, year: 1980 },
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    const text = resultText(result);
    expect(text).toContain("| Name | Role | Occupation | Appointed | Resigned | Status | Link |");
    expect(text).toContain("DOE, Jane");
    expect(text).toContain("Active");
    expect(text).not.toContain("Private output");
    expect(text).not.toContain("British");
    expect(text).not.toContain("1980");
  });

  test("CompanyOwners renders PSC percentage bands, regime, and all required caveats", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "persons-with-significant-control?",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 1,
          items: [
            {
              kind: "corporate-entity-person-with-significant-control",
              name: "EXAMPLE PARENT LIMITED",
              notified_on: "2020-01-01",
              natures_of_control: ["ownership-of-shares-75-to-100-percent"],
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain(">75% up to 100%");
    expect(text).toContain("UK PSC register (>25% shares/voting rights or other statutory control tests)");
    expect(text).toContain("statutory control register");
    expect(text).toContain("not guaranteed-complete");
    expect(text).toContain("corporate entities and legal persons");
    expect(text).toContain("ECCTA identity-verification transition");
  });

  test("GB financials and private raises return successful capability explanations", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const financials = await toolByName(tools, "CompanyFinancials").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(financials.isError).toBeUndefined();
    expect(resultText(financials)).toContain("does not parse them into normalized financial facts");
    expect(resultText(financials)).toContain("CompanyFilings");
    expect(resultText(financials)).toContain("accounts filter");

    const raises = await toolByName(tools, "PrivateRaises").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(raises.isError).toBeUndefined();
    expect(resultText(raises)).toContain('unsupported for jurisdiction "GB"');
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit KR routing", () => {
  test("CompanyResolve uses OpenDART only and shows the DART/stock identifiers", async () => {
    const fetchFn = routedFetch([krCorpCodeRoute]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "삼성전자",
      jurisdiction: "KR",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("OpenDART");
    expect(text).toContain("DART 00126380");
    expect(text).toContain("stock 005930");
    expect(fetchFn.requests.every(({ url }) => !url.includes("sec.gov"))).toBe(true);
  });

  test("CompanyFilings renders DART reports and states it returns links, not text", async () => {
    const fetchFn = routedFetch([
      krCorpCodeRoute,
      {
        pattern: "list.json",
        body: {
          status: "000",
          total_page: 1,
          list: [
            {
              corp_code: "00126380",
              report_nm: "사업보고서 (2022.12)",
              rcept_no: "20230307000542",
              flr_nm: "삼성전자",
              rcept_dt: "20230307",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "삼성전자",
      jurisdiction: "KR",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("| Filed | Report | Filer | Link |");
    expect(text).toContain("사업보고서");
    expect(text).toContain("does not return document text");
    expect(text).toContain("dart.fss.or.kr");
  });

  test("CompanyInsiders parses executive ownership reports", async () => {
    const fetchFn = routedFetch([
      krCorpCodeRoute,
      {
        pattern: "elestock.json",
        body: {
          status: "000",
          list: [
            {
              rcept_no: "20230512000777",
              rcept_dt: "2023-05-12",
              corp_code: "00126380",
              repror: "홍길동",
              isu_exctv_rgist_at: "등기임원",
              isu_exctv_ofcps: "대표이사",
              sp_stock_lmp_rate: "0.02",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({
      company: "삼성전자",
      jurisdiction: "KR",
    } as never);
    const text = resultText(result);
    expect(text).toContain("홍길동");
    expect(text).toContain("대표이사");
    expect(text).toContain("특정증권등 소유상황보고");
  });

  test("CompanyOwners renders 5% reports and the Korea threshold regime", async () => {
    const fetchFn = routedFetch([
      krCorpCodeRoute,
      {
        pattern: "majorstock.json",
        body: {
          status: "000",
          list: [
            {
              rcept_no: "20230101000111",
              rcept_dt: "20230101",
              corp_code: "00126380",
              repror: "국민연금공단",
              report_tp: "변동",
              stkrt: "8.51",
              stkrt_irds: "1.02",
              report_resn: "장내매수",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "삼성전자",
      jurisdiction: "KR",
    } as never);
    const text = resultText(result);
    expect(text).toContain("국민연금공단");
    expect(text).toContain("8.51%");
    expect(text).toContain("Korea 5% rule");
    expect(text).toContain("not UBO tracing");
  });

  test("CompanyFinancials shows CFS/OFS basis for Korean major accounts", async () => {
    const fetchFn = routedFetch([
      krCorpCodeRoute,
      {
        pattern: "fnlttSinglAcnt.json",
        body: {
          status: "000",
          list: [
            {
              rcept_no: "20230307000542",
              corp_code: "00126380",
              fs_div: "CFS",
              account_nm: "매출액",
              thstrm_dt: "2022.01.01 ~ 2022.12.31",
              thstrm_amount: "302,231,360",
              currency: "KRW",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      periods: 1,
    } as never);
    const text = resultText(result);
    expect(text).toContain("Revenue");
    expect(text).toContain("consolidated");
    expect(text).toContain("2022-12-31");
  });

  test("PrivateRaises returns a successful unsupported explanation for KR", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "PrivateRaises").handler({
      company: "삼성전자",
      jurisdiction: "KR",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('unsupported for jurisdiction "KR"');
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit JP routing", () => {
  test("CompanyResolve uses EDINET only and shows the EDINET/security identifiers", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "7203",
      jurisdiction: "JP",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("EDINET");
    expect(text).toContain("EDINET E02144");
    expect(text).toContain("security 72030");
    expect(fetchFn.requests.every(({ url }) => !url.includes("sec.gov"))).toBe(true);
  });

  test("CompanyFilings scans EDINET, shows docIDs, and warns about the date index", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, jpDocumentsRoute]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "E02144",
      jurisdiction: "JP",
      start_date: "2026-08-05",
      end_date: "2026-08-05",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("| Filed | Type | docID | Filer | Description |");
    expect(text).toContain("S100ANNUAL");
    expect(text).toContain("date-indexed");
    expect(text).toContain("never returns document text");
  });

  test("CompanyFilings latest_annual returns the annual securities report docID", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, jpDocumentsRoute]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "E02144",
      jurisdiction: "JP",
      mode: "latest_annual",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Latest annual report (EDINET)");
    expect(text).toContain("S100ANNUAL");
    expect(text).toContain("有価証券報告書");
  });

  test("CompanyInsiders returns an honest unsupported explanation for JP", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({
      company: "E02144",
      jurisdiction: "JP",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('unsupported for jurisdiction "JP"');
    expect(resultText(result)).toContain("有価証券報告書");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyOwners explains the filer-indexed large-holding limitation for JP", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "E02144",
      jurisdiction: "JP",
    } as never);
    const text = resultText(result);
    expect(text).toContain('unsupported for jurisdiction "JP"');
    expect(text).toContain("大量保有報告書");
    expect(text).toContain("not evidence");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyFinancials directs JP callers to the EDINET annual report", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "E02144",
      jurisdiction: "JP",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("有価証券報告書");
    expect(resultText(result)).toContain("latest_annual");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("PrivateRaises returns a successful unsupported explanation for JP", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "PrivateRaises").handler({
      company: "E02144",
      jurisdiction: "JP",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('unsupported for jurisdiction "JP"');
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("CompanyInsiders", () => {
  test("renders a markdown table with names and roles", async () => {
    const form4 =
      "<ownershipDocument><reportingOwner><reportingOwnerId>" +
      "<rptOwnerCik>0001214156</rptOwnerCik><rptOwnerName>COOK TIMOTHY D</rptOwnerName>" +
      "</reportingOwnerId><reportingOwnerRelationship>" +
      "<isDirector>1</isDirector><isOfficer>1</isOfficer>" +
      "<officerTitle>Chief Executive Officer</officerTitle>" +
      "</reportingOwnerRelationship></reportingOwner></ownershipDocument>";
    const fetchFn = routedFetch([
      {
        pattern: "data.sec.gov/submissions",
        body: submissionsFixture([
          {
            form: "4",
            filed: "2024-04-15",
            accession: "0000320193-24-000040",
            primaryDocument: "xslF345X06/wk-form4_1.xml",
          },
        ]),
      },
      { pattern: "wk-form4_1.xml", body: form4 },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({ company: "320193" } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("| Name | Role(s) |");
    expect(text).toContain("COOK TIMOTHY D");
    expect(text).toContain("Director, Officer: Chief Executive Officer");
  });
});

describe("CompanyOwners", () => {
  test("rows include the threshold regime and exclude the subject company", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "efts.sec.gov",
        body: {
          hits: {
            hits: [
              {
                _id: "0000102909-24-000020:filing13ga.htm",
                _source: {
                  form: "SC 13G/A",
                  file_date: "2024-02-12",
                  adsh: "0000102909-24-000020",
                  ciks: ["0000320193", "0000102909"],
                  display_names: [
                    "Apple Inc.  (AAPL)  (CIK 0000320193)",
                    "VANGUARD GROUP INC  (CIK 0000102909)",
                  ],
                },
              },
            ],
          },
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({ company: "320193" } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("VANGUARD GROUP INC");
    expect(text).toContain("US Schedule 13D/13G (5% beneficial-ownership threshold)");
    expect(text).not.toContain("| Apple Inc.");
  });
});

describe("CompanyFinancials", () => {
  test("renders labeled sections per concept", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "us-gaap/NetIncomeLoss.json",
        body: {
          tag: "NetIncomeLoss",
          label: "Net Income (Loss)",
          units: {
            USD: [
              {
                start: "2022-09-25",
                end: "2023-09-30",
                val: 96_995_000_000,
                fy: 2023,
                fp: "FY",
                form: "10-K",
                filed: "2023-11-03",
                accn: "0000320193-23-000106",
              },
            ],
          },
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "320193",
      concepts: ["net_income"],
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("# Annual financials: 320193");
    expect(text).toContain("## Net income (USD)");
    expect(text).toContain("| Fiscal period end | Value | Form | Filed |");
    expect(text).toContain("$96,995,000,000");
    expect(text).toContain("2023-09-30");
  });
});

describe("PrivateRaises", () => {
  test("renders Indefinite amounts and related persons", async () => {
    const formD = `<edgarSubmission>
      <primaryIssuer><entityName>Example Labs, Inc.</entityName></primaryIssuer>
      <relatedPersonsList>
        <relatedPersonInfo>
          <relatedPersonName><firstName>Jane</firstName><lastName>Doe</lastName></relatedPersonName>
          <relatedPersonRelationshipList>
            <relationship>Executive Officer</relationship>
            <relationship>Director</relationship>
          </relatedPersonRelationshipList>
        </relatedPersonInfo>
      </relatedPersonsList>
      <offeringData>
        <offeringSalesAmounts>
          <totalOfferingAmount>Indefinite</totalOfferingAmount>
          <totalAmountSold>25000000</totalAmountSold>
        </offeringSalesAmounts>
      </offeringData>
    </edgarSubmission>`;
    const fetchFn = routedFetch([
      {
        pattern: "data.sec.gov/submissions",
        body: submissionsFixture([
          {
            form: "D",
            filed: "2023-03-20",
            accession: "0001111111-23-000001",
            primaryDocument: "primary_doc.xml",
          },
        ]),
      },
      { pattern: "primary_doc.xml", body: formD },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PrivateRaises").handler({ company: "320193" } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("## D — filed 2023-03-20");
    expect(text).toContain("| Total offering | Indefinite |");
    expect(text).toContain("| Jane Doe | Executive Officer, Director |");
  });

  test("no-Form-D message includes the absence caveat", async () => {
    const fetchFn = routedFetch([
      { pattern: "data.sec.gov/submissions", body: submissionsFixture([]) },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PrivateRaises").handler({ company: "320193" } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain('No Form D filings found for "320193"');
    expect(text).toContain("absence here is not proof of no private raise");
  });
});

describe("handler robustness", () => {
  test("handlers never reject even when the network stub throws", async () => {
    const throwing = routedFetch([]); // every request is "unexpected" and throws
    const tools = createTools({ fetchFn: throwing, env: ENV });
    for (const tool of tools) {
      const result = await tool.handler({ company: "AAPL" } as never);
      expect(Array.isArray(result.content)).toBe(true);
      expect(typeof resultText(result)).toBe("string");
    }
  });

  test("explicit GB handlers never reject when the network stub throws", async () => {
    const throwing = routedFetch([]);
    const tools = createTools({ fetchFn: throwing, env: GB_ENV });
    for (const tool of tools.filter((candidate) => candidate.name !== "OwnershipChain")) {
      const result = await tool.handler({
        company: "Example Limited",
        jurisdiction: "GB",
      } as never);
      expect(Array.isArray(result.content)).toBe(true);
      expect(typeof resultText(result)).toBe("string");
    }
  });

  test("an exhausted SEC rate limiter surfaces as an isError result", async () => {
    while (secRateLimiter.tryAcquire()) {
      // Drain the shared limiter so the next SEC request is refused.
    }
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({ company: "AAPL" } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("SEC EDGAR rate limit reached (30 requests per minute)");
    expect(fetchFn.requests).toHaveLength(0);
  });
});
