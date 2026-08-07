import { beforeEach, describe, expect, test } from "bun:test";
import { TOOL_NAMES, createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetSecTickerCache } from "../src/adapters/secEdgar.js";
import { resetOpenDartCorpCodeCache } from "../src/adapters/openDart.js";
import { resetRateLimiters, secRateLimiter } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env, ToolResult } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";
import { latin1Bytes, makeStoredZip, makeStoredZipMulti } from "./helpers/zipFixture.js";
import { edinetCodeListRoute, edinetDay } from "./helpers/edinetFixture.js";
import {
  EDINET_5_PERCENT_THRESHOLD_REGIME,
  resetEdinetCodeCache,
} from "../src/adapters/edinet.js";
import { resetTwseDatasetCache } from "../src/adapters/twseOpenApi.js";
import { resetCvmDatasetCache } from "../src/adapters/cvmOpenData.js";

const ENV: Env = { DISCLOSURES_USER_AGENT: "Test test@example.com" };
const GB_ENV: Env = {
  ...ENV,
  COMPANIES_HOUSE_API_KEY: "test-companies-house-key",
};

const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";

// A minimal filings.xbrl.org (ESEF) fixture: one UK filing linking one xBRL-JSON
// report with a single annual Revenue fact. OIM encodes the FY-ended-31-March
// period as a duration ending at the following midnight (2025-04-01T00:00:00).
const ESEF_LEI = "213800H2PQMIF3OVZY47";
const esefRoutes: Route[] = [
  {
    pattern: `filter%5Bentity.identifier%5D=${ESEF_LEI}`,
    body: {
      data: [
        {
          type: "filing",
          id: "1",
          attributes: {
            fxo_id: `${ESEF_LEI}-2025-03-31`,
            country: "GB",
            period_end: "2025-03-31",
            json_url: "/esef-report.json",
            viewer_url: "/esef-view/",
            date_added: "2025-08-21T00:00:00Z",
          },
          relationships: { entity: { data: { type: "entity", id: "ent-1" } } },
        },
      ],
      included: [
        { type: "entity", id: "ent-1", attributes: { identifier: ESEF_LEI, name: "KAINOS GROUP PLC" } },
      ],
    },
  },
  {
    pattern: "/esef-report.json",
    body: {
      documentInfo: { documentType: "xbrl-json" },
      facts: {
        f0: {
          value: 367_246_000,
          dimensions: {
            concept: "ifrs-full:Revenue",
            entity: `lei:${ESEF_LEI}`,
            period: "2024-04-01T00:00:00/2025-04-01T00:00:00",
            unit: "iso4217:GBP",
            language: "en",
          },
        },
      },
    },
  },
];

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
};

const tickersRoute: Route = { pattern: "company_tickers.json", body: TICKERS };

/**
 * True when a request URL's host is, or is a subdomain of, `suffix`. Parses
 * the host rather than substring-matching the whole URL, so a query string
 * containing the domain can never masquerade as a call to it (and CodeQL is
 * satisfied it is a real host check).
 */
function hitsHost(url: string, suffix: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === suffix || host.endsWith(`.${suffix}`);
}

function hitsSec(url: string): boolean {
  return hitsHost(url, "sec.gov");
}

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

// A day of large-volume holding reports whose subject issuer is Toyota (E02144).
const JP_HOLDERS_DAY = [
  {
    docID: "S100LVH1",
    edinetCode: "E12345",
    filerName: "野村アセットマネジメント株式会社",
    issuerEdinetCode: "E02144",
    docTypeCode: "350",
    docDescription: "大量保有報告書",
    currentReportReason: "新規保有",
    submitDateTime: "2026-08-05 09:00",
  },
];

const jpHoldersRoute: Route = {
  pattern: "documents.json",
  body: edinetDay(JP_HOLDERS_DAY),
};

// CN (cninfo) fixtures: keyless topSearch array + one announcement page.
const cnSearchRoute: Route = {
  pattern: "topSearch/query",
  body: [
    {
      code: "600519",
      zwjc: "贵州茅台",
      pinyin: "GZMT",
      category: "A股",
      orgId: "gssh0600519",
      delisted: false,
    },
  ],
};
const cnAnnouncementRoute: Route = {
  pattern: "hisAnnouncement/query",
  body: {
    totalAnnouncement: 1,
    announcements: [
      {
        secCode: "600519",
        secName: "贵州茅台",
        orgId: "gssh0600519",
        announcementId: "1220000001",
        announcementTitle: "2025年年度报告",
        announcementTime: 1_744_000_000_000,
        adjunctUrl: "finalpage/2026-04-17/1220000001.PDF",
        announcementTypeName: "年度报告",
      },
    ],
  },
};

// IN (BSE) fixtures: PeerSmartSearch HTML + one AnnGetData row.
const inSearchRoute: Route = {
  pattern: "PeerSmartSearch",
  body:
    `<li onclick="liclick('500325','Reliance Industries Ltd')">` +
    `Reliance Industries Ltd <span>INE002A01018</span></li>`,
};
const inAnnouncementRoute: Route = {
  pattern: "AnnGetData",
  body: {
    Table: [
      {
        NEWSID: "abc123",
        SCRIP_CD: "500325",
        HEADLINE: "Board Meeting Outcome",
        CATEGORYNAME: "Result",
        NEWS_DT: "2026-04-21T18:30:00",
        ATTACHMENTNAME: "abc123.pdf",
      },
    ],
  },
};

// TW (TWSE) fixtures: whole-market basic list + intent datasets, keyed by the
// live Chinese field names (note trailing spaces on 主旨 and 選任時持股).
const twBasicRoute: Route = {
  pattern: "t187ap03_L",
  body: [
    {
      公司代號: "2330",
      公司名稱: "台灣積體電路製造股份有限公司",
      公司簡稱: "台積電",
      英文簡稱: "TSMC",
      上市日期: "19940905",
    },
  ],
};
const twAnnouncementRoute: Route = {
  pattern: "t187ap04_L",
  body: [
    {
      公司代號: "2330",
      發言日期: "1150805",
      符合條款: "第 4 款",
      事實發生日: "1150805",
      "主旨 ": "本公司受邀參加法人說明會",
    },
  ],
};
const twMajorRoute: Route = {
  pattern: "t187ap02_L",
  body: [
    { 公司代號: "2317", 出表日期: "1150731", 大股東名稱: "某控股公司" },
  ],
};
const twDirectorRoute: Route = {
  pattern: "t187ap11_L",
  body: [
    {
      公司代號: "2330",
      出表日期: "1150731",
      資料年月: "11506",
      職稱: "董事長",
      姓名: "魏哲家",
      目前持股: "1,234,567",
      "選任時持股 ": "1,000,000",
      設質股數: "0",
      設質股數佔持股比例: "0.00",
    },
  ],
};

// BR (CVM open data) fixtures: Latin-1 registration CSV plus IPE and DFP ZIP
// bundles, keyed by the live column names. The tool handlers pick years from the
// real clock (IPE = current year, DFP = latest complete fiscal year = last
// year), so the fixture years are computed the same way to stay run-date-robust.
const BR_IPE_YEAR = new Date().getUTCFullYear();
const BR_DFP_YEAR = BR_IPE_YEAR - 1;
const brRegistrationRoute: Route = {
  pattern: "cad_cia_aberta.csv",
  body: latin1Bytes(
    "CNPJ_CIA;DENOM_SOCIAL;DENOM_COMERC;SIT;CD_CVM;SETOR_ATIV;CATEG_REG\n" +
      "33.592.510/0001-54;VALE S.A.;VALE;ATIVO;4170;Extração Mineral;Categoria A\n",
  ),
};
const brIpeRoute: Route = {
  pattern: `ipe_cia_aberta_${BR_IPE_YEAR}.zip`,
  body: makeStoredZipMulti([
    {
      name: `ipe_cia_aberta_${BR_IPE_YEAR}.csv`,
      content: latin1Bytes(
        "CNPJ_Companhia;Nome_Companhia;Codigo_CVM;Data_Referencia;Categoria;Tipo;Especie;Assunto;Data_Entrega;Link_Download\n" +
          `33.592.510/0001-54;VALE;004170;${BR_IPE_YEAR}-05-10;Fato Relevante;Comunicado;Fato Relevante;Aquisição de ativos;${BR_IPE_YEAR}-05-10;https://www.rad.cvm.gov.br/ENET/frmDownloadDocumento.aspx?doc=1\n`,
      ),
    },
  ]),
};
const BR_BPA_HEADER =
  "CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;GRUPO_DFP;MOEDA;ESCALA_MOEDA;ORDEM_EXERC;DT_FIM_EXERC;CD_CONTA;DS_CONTA;VL_CONTA;ST_CONTA_FIXA";
const BR_DRE_HEADER =
  "CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;GRUPO_DFP;MOEDA;ESCALA_MOEDA;ORDEM_EXERC;DT_INI_EXERC;DT_FIM_EXERC;CD_CONTA;DS_CONTA;VL_CONTA;ST_CONTA_FIXA";
const brDfpRoute: Route = {
  pattern: `dfp_cia_aberta_${BR_DFP_YEAR}.zip`,
  body: makeStoredZipMulti([
    {
      name: `dfp_cia_aberta_BPA_con_${BR_DFP_YEAR}.csv`,
      content: latin1Bytes(
        BR_BPA_HEADER + "\n" +
          `33.592.510/0001-54;${BR_DFP_YEAR}-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;${BR_DFP_YEAR}-12-31;1;Ativo Total;496325000.00;S\n`,
      ),
    },
    {
      name: `dfp_cia_aberta_BPP_con_${BR_DFP_YEAR}.csv`,
      content: latin1Bytes(
        BR_BPA_HEADER + "\n" +
          `33.592.510/0001-54;${BR_DFP_YEAR}-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;${BR_DFP_YEAR}-12-31;2.03;Patrimônio Líquido Consolidado;250000000.00;S\n`,
      ),
    },
    {
      name: `dfp_cia_aberta_DRE_con_${BR_DFP_YEAR}.csv`,
      content: latin1Bytes(
        BR_DRE_HEADER + "\n" +
          `33.592.510/0001-54;${BR_DFP_YEAR}-12-31;1;VALE S.A.;004170;DF Consolidado;Real;MIL;ÚLTIMO;${BR_DFP_YEAR}-01-01;${BR_DFP_YEAR}-12-31;3.01;Receita de Venda de Bens e/ou Serviços;206005000.00;S\n`,
      ),
    },
  ]),
};

beforeEach(() => {
  resetRateLimiters();
  resetSecTickerCache();
  resetOpenDartCorpCodeCache();
  resetEdinetCodeCache();
  resetTwseDatasetCache();
  resetCvmDatasetCache();
});

describe("createTools", () => {
  test("returns exactly the tools in TOOL_NAMES order", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toHaveLength(10);
  });

  // OwnershipChain (GLEIF-global) and the Companies-House-specific tools
  // (CompanyDocument, CompanyCharges, PersonAppointments) have no jurisdiction
  // dispatch param; every other tool routes by jurisdiction.
  const JURISDICTION_AGNOSTIC = new Set([
    "OwnershipChain",
    "CompanyDocument",
    "CompanyCharges",
    "PersonAppointments",
  ]);

  test("company jurisdiction accepts US/GB/KR/JP/CN/IN/TW and descriptions cover KR and JP", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: GB_ENV });
    for (const tool of tools.filter((candidate) => !JURISDICTION_AGNOSTIC.has(candidate.name))) {
      const jurisdiction = tool.inputSchema.jurisdiction;
      expect(jurisdiction?.safeParse("US").success).toBe(true);
      expect(jurisdiction?.safeParse("GB").success).toBe(true);
      expect(jurisdiction?.safeParse("KR").success).toBe(true);
      expect(jurisdiction?.safeParse("JP").success).toBe(true);
      expect(jurisdiction?.safeParse("CN").success).toBe(true);
      expect(jurisdiction?.safeParse("IN").success).toBe(true);
      expect(jurisdiction?.safeParse("TW").success).toBe(true);
      expect(jurisdiction?.safeParse("BR").success).toBe(true);
      expect(jurisdiction?.safeParse("DE").success).toBe(true);
      expect(jurisdiction?.safeParse("ZZ").success).toBe(false);
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
    expect(fetchFn.requests.some(({ url }) =>
      hitsHost(url, "company-information.service.gov.uk")
    )).toBe(false);
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

  test("ISIN input resolves to the issuer's GLEIF record, GLEIF-only", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Bisin%5D=US0378331005",
        body: gleifCollection([gleifRecord(APPLE_LEI, "APPLE INC.")]),
      },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "US0378331005",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain(APPLE_LEI);
    expect(text).toContain("ISIN US0378331005");
    // Only the GLEIF ISIN lookup ran — no SEC endpoints touched.
    expect(fetchFn.requests).toHaveLength(1);
    expect(fetchFn.requests[0]?.url).toContain("filter%5Bisin%5D=");
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
      {
        // Enrichment fetches the top match's full profile (previous names etc.).
        pattern: "/company/01234567",
        body: {
          company_number: "01234567",
          company_name: "EXAMPLE LIMITED",
          company_status: "active",
          date_of_creation: "2010-01-01",
          previous_company_names: [
            { name: "OLD EXAMPLE LIMITED", effective_from: "2010-01-01", ceased_on: "2015-06-30" },
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
    // Enriched profile surfaces the previous name with its date range.
    expect(text).toContain("OLD EXAMPLE LIMITED");
    expect(text).toContain("2015-06-30");
    for (const request of fetchFn.requests) {
      expect(request.url).toContain("api.company-information.service.gov.uk");
    }
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
    for (const request of fetchFn.requests) {
      expect(request.url).not.toContain("sec.gov");
      expect(request.url).toContain("api.company-information.service.gov.uk");
    }
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
              identity_verification_details: {
                identity_verified_on: "2025-11-20",
                authorised_corporate_service_provider_name: "DE PINNA LLP",
              },
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
    expect(text).toContain(
      "| Name | Role | Occupation | Appointed | Resigned | Status | Identity (ECCTA) | Link |",
    );
    expect(text).toContain("DOE, Jane");
    expect(text).toContain("Active");
    expect(text).toContain("Verified 2025-11-20 (ACSP: DE PINNA LLP)");
    // Absence-is-not-proof caveat must accompany the column.
    expect(text).toContain("not** proof");
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
      // A fetchFn is present, so the supplementary FCA NSM TR-1 lookup fires.
      // Return zero hits so it deterministically renders the "no notifications"
      // line rather than hitting the graceful-degradation catch.
      { pattern: "nsm-search", body: { hits: { hits: [] } } },
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
    // The GB owners view now also carries the UK equity (DTR5/TR-1) section.
    expect(text).toContain("UK major holdings (DTR5/TR-1)");
    expect(text).toContain("No FCA NSM TR-1 major-holding notifications");
  });

  test("CompanyOwners GB renders TR-1 major holdings when NSM access is injected", async () => {
    const tr1Html = loadFixture("fca", "tr1-rws.html");
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
              natures_of_control: ["ownership-of-shares-25-to-50-percent"],
            },
          ],
        },
      },
      {
        pattern: "nsm-search",
        body: {
          hits: {
            hits: [
              {
                _source: {
                  type_code: "HOL",
                  company: "RWS HOLDINGS PLC",
                  download_link: "NSM/RNS/abc.html",
                  publication_date: "2025-11-06",
                },
              },
            ],
          },
        },
      },
      { pattern: "artefacts/NSM/RNS/abc.html", body: tr1Html, headers: { "content-type": "text/html" } },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    // Primary PSC section and the supplementary TR-1 equity section coexist.
    expect(text).toContain("Persons with significant control (Companies House)");
    expect(text).toContain("UK major holdings (DTR5/TR-1): 01234567");
    expect(text).toContain("Octopus Investments Limited");
    expect(text).toContain("6.99%");
    expect(text).toContain("Octopus Capital Limited");
    expect(text).toContain("self-reported DTR5 major-holding disclosures");
  });

  test("CompanyFinancials renders normalized ESEF/UKSEF annual figures", async () => {
    const fetchFn = routedFetch(esefRoutes);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const financials = await toolByName(tools, "CompanyFinancials").handler({
      company: ESEF_LEI,
      jurisdiction: "GB",
      concepts: ["revenue"],
      periods: 2,
    } as never);
    expect(financials.isError).toBeUndefined();
    const text = resultText(financials);
    expect(text).toContain("Annual financials (ESEF/UKSEF)");
    expect(text).toContain("£367,246,000");
    expect(text).toContain("2025-03-31"); // inclusive period end, not the OIM boundary
    expect(text).toContain("ESEF (GB)");
    expect(text).toContain("filings.xbrl.org");
    // The SEC path is never touched for a GB financials lookup.
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("PrivateRaises stays unsupported for GB", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const raises = await toolByName(tools, "PrivateRaises").handler({
      company: "01234567",
      jurisdiction: "GB",
    } as never);
    expect(raises.isError).toBeUndefined();
    expect(resultText(raises)).toContain('unsupported for jurisdiction "GB"');
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit EU routing", () => {
  test("CompanyFinancials renders pan-European ESEF figures by LEI", async () => {
    const fetchFn = routedFetch(esefRoutes);
    const tools = createTools({ fetchFn, env: ENV });
    const financials = await toolByName(tools, "CompanyFinancials").handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
      concepts: ["revenue"],
    } as never);
    expect(financials.isError).toBeUndefined();
    const text = resultText(financials);
    expect(text).toContain("Annual financials (ESEF/UKSEF)");
    expect(text).toContain("£367,246,000");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("every non-financials tool returns the honest EU-unsupported message without any network call", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of [
      "CompanyResolve",
      "CompanyFilings",
      "CompanyInsiders",
      "CompanyOwners",
      "PrivateRaises",
    ]) {
      const result = await toolByName(tools, name).handler({
        company: ESEF_LEI,
        jurisdiction: "EU",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "EU"');
      expect(resultText(result)).toContain("CompanyFinancials");
    }
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
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
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
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
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

  test("CompanyOwners reverse-maps EDINET large-holding reports for JP", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, jpHoldersRoute]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "E02144",
      jurisdiction: "JP",
      start_date: "2026-08-05",
      end_date: "2026-08-05",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Large-volume holders (≥5%, EDINET)");
    expect(text).toContain("野村アセットマネジメント株式会社");
    expect(text).toContain("大量保有報告書");
    expect(text).toContain("新規保有");
    expect(text).toContain("S100LVH1");
    // Honesty caveats: no exact percentage; absence is not proof.
    expect(text).toContain("no holding ratio");
    expect(text).toContain("not proof");
  });

  test("CompanyOwners reports an honest empty result for JP when no holder is named", async () => {
    const fetchFn = routedFetch([
      edinetCodeListRoute,
      { pattern: "documents.json", body: edinetDay([], "404") },
    ]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "E02144",
      jurisdiction: "JP",
      start_date: "2026-08-05",
      end_date: "2026-08-05",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("No EDINET large-volume holding reports");
    expect(text).toContain(EDINET_5_PERCENT_THRESHOLD_REGIME);
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

describe("explicit CN routing", () => {
  test("CompanyResolve uses cninfo only and shows the cninfo/stock identifiers", async () => {
    const fetchFn = routedFetch([cnSearchRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "600519",
      jurisdiction: "CN",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("cninfo");
    expect(text).toContain("cninfo gssh0600519");
    expect(text).toContain("贵州茅台");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings search renders cninfo PDF links with the honesty caveat", async () => {
    const fetchFn = routedFetch([cnSearchRoute, cnAnnouncementRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "600519",
      jurisdiction: "CN",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("cninfo announcements");
    expect(text).toContain("2025年年度报告");
    expect(text).toContain("static.cninfo.com.cn/finalpage/2026-04-17/1220000001.PDF");
    expect(text).toContain("never returns document text");
  });

  test("CompanyFilings latest_annual returns the cninfo annual report metadata", async () => {
    const fetchFn = routedFetch([cnSearchRoute, cnAnnouncementRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "600519",
      jurisdiction: "CN",
      mode: "latest_annual",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Latest annual report (cninfo)");
    expect(text).toContain("1220000001");
  });

  test("CompanyInsiders, CompanyOwners, CompanyFinancials, and PrivateRaises explain CN limits", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyInsiders", "CompanyOwners", "CompanyFinancials", "PrivateRaises"]) {
      const result = await toolByName(tools, name).handler({
        company: "600519",
        jurisdiction: "CN",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "CN"');
    }
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit IN routing", () => {
  test("CompanyResolve uses BSE only, shows the scrip/ISIN, and names the anti-bot caveat", async () => {
    const fetchFn = routedFetch([inSearchRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "500325",
      jurisdiction: "IN",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("BSE India");
    expect(text).toContain("BSE 500325");
    expect(text).toContain("ISIN INE002A01018");
    expect(text).toContain("anti-bot");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings search renders BSE attachment links with the anti-bot caveat", async () => {
    const fetchFn = routedFetch([inSearchRoute, inAnnouncementRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "500325",
      jurisdiction: "IN",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("BSE announcements");
    expect(text).toContain("Board Meeting Outcome");
    expect(text).toContain("AttachLive/abc123.pdf");
    expect(text).toContain("anti-bot");
  });

  test("CompanyFilings latest_annual is unsupported and points to search mode", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "500325",
      jurisdiction: "IN",
      mode: "latest_annual",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("unsupported for IN");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyInsiders, CompanyOwners, CompanyFinancials, and PrivateRaises explain IN limits", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyInsiders", "CompanyOwners", "CompanyFinancials", "PrivateRaises"]) {
      const result = await toolByName(tools, name).handler({
        company: "500325",
        jurisdiction: "IN",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "IN"');
    }
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit TW routing", () => {
  test("CompanyResolve uses TWSE only and shows the listing code and profile", async () => {
    const fetchFn = routedFetch([twBasicRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "2330",
      jurisdiction: "TW",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("TWSE");
    expect(text).toContain("stock 2330");
    expect(text).toContain("台灣積體電路製造股份有限公司");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings search renders TWSE material-information rows", async () => {
    const fetchFn = routedFetch([twBasicRoute, twAnnouncementRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "2330",
      jurisdiction: "TW",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("TWSE material-information announcements");
    expect(text).toContain("本公司受邀參加法人說明會");
    expect(text).toContain("2026-08-05");
  });

  test("CompanyFilings latest_annual is unsupported and points to search mode", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "2330",
      jurisdiction: "TW",
      mode: "latest_annual",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("unsupported for TW");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyInsiders renders the director/supervisor holdings table", async () => {
    const fetchFn = routedFetch([twBasicRoute, twDirectorRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({
      company: "2330",
      jurisdiction: "TW",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Directors & supervisors (TWSE)");
    expect(text).toContain("董事長");
    expect(text).toContain("魏哲家");
    expect(text).toContain("1,234,567");
  });

  test("CompanyOwners returns no >10% holders honestly for a company that has none", async () => {
    const fetchFn = routedFetch([twBasicRoute, twMajorRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "2330",
      jurisdiction: "TW",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("No >10% major shareholders");
    expect(text).toContain("more than 10%");
  });

  test("CompanyFinancials and PrivateRaises explain the TW limits", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyFinancials", "PrivateRaises"]) {
      const result = await toolByName(tools, name).handler({
        company: "2330",
        jurisdiction: "TW",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "TW"');
    }
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit BR routing", () => {
  test("CompanyResolve uses CVM only and shows the registered name", async () => {
    const fetchFn = routedFetch([brRegistrationRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "4170",
      jurisdiction: "BR",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Company resolution (CVM)");
    expect(text).toContain("VALE S.A.");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings search renders CVM IPE disclosure rows with the RAD link", async () => {
    const fetchFn = routedFetch([brRegistrationRoute, brIpeRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "4170",
      jurisdiction: "BR",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("CVM disclosures (IPE)");
    expect(text).toContain("Fato Relevante");
    expect(text).toContain("rad.cvm.gov.br");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings latest_annual is unsupported and points to search mode", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: "4170",
      jurisdiction: "BR",
      mode: "latest_annual",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("unsupported for BR");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyFinancials renders consolidated DFP facts scaled by ESCALA_MOEDA", async () => {
    const fetchFn = routedFetch([brRegistrationRoute, brDfpRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFinancials").handler({
      company: "4170",
      jurisdiction: "BR",
      periods: 1,
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Annual financials (CVM DFP)");
    expect(text).toContain("Ativo Total");
    expect(text).toContain("R$496,325,000,000");
    expect(text).toContain("consolidated");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyInsiders and CompanyOwners explain the BR limits without a network hit", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyInsiders", "CompanyOwners"]) {
      const result = await toolByName(tools, name).handler({
        company: "4170",
        jurisdiction: "BR",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "BR"');
    }
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("PrivateRaises explains the BR limit without a network hit", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PrivateRaises").handler({
      company: "4170",
      jurisdiction: "BR",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('unsupported for jurisdiction "BR"');
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("explicit DE routing", () => {
  const deSearchRoute: Route = {
    pattern: "AnteileInfo/suche.do",
    body: loadFixture("bafin", "anteile-search-sap.html"),
  };
  const deIssuerRoute: Route = {
    pattern: "AnteileInfo/aktiengesellschaft.do",
    body: loadFixture("bafin", "anteile-issuer-sap.html"),
  };
  const deDealingsRoute: Route = {
    pattern: "DealingsInfo/sucheForm.do",
    body: loadFixture("bafin", "dealings-sap.html"),
  };

  test("CompanyResolve uses BaFin only and shows the issuer BaFin-Id", async () => {
    const fetchFn = routedFetch([deSearchRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "SAP SE",
      jurisdiction: "DE",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Company resolution (BaFin)");
    expect(text).toContain("SAP SE");
    expect(text).toContain("40001244");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyOwners renders §§33 ff. WpHG holdings with percentages", async () => {
    const fetchFn = routedFetch([deSearchRoute, deIssuerRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyOwners").handler({
      company: "SAP SE",
      jurisdiction: "DE",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Major holdings (§§33 ff. WpHG, BaFin)");
    expect(text).toContain("BlackRock, Inc.");
    expect(text).toContain("5.0254%");
    expect(text).toContain("§39 aggregate");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyInsiders renders BaFin directors' dealings", async () => {
    const fetchFn = routedFetch([deDealingsRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyInsiders").handler({
      company: "SAP SE",
      jurisdiction: "DE",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Directors' dealings (BaFin)");
    expect(text).toContain("Jürgen Müller");
    expect(text).toContain("Buy (Kauf)");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings, CompanyFinancials and PrivateRaises explain DE limits with no network hit", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyFilings", "CompanyFinancials", "PrivateRaises"]) {
      const result = await toolByName(tools, name).handler({
        company: "SAP SE",
        jurisdiction: "DE",
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain('unsupported for jurisdiction "DE"');
    }
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
