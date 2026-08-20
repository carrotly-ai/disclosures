import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// filings.xbrl.org /api/entities register lookups: an LEI resolves on exact
// identifier, a name resolves through the flask-combo-jsonapi ilike operator.
const esefEntityResource = {
  type: "entity",
  id: "2670",
  attributes: { name: "KAINOS GROUP PLC", identifier: ESEF_LEI },
};
const esefEntityByLeiRoute: Route = {
  pattern: `filter%5Bidentifier%5D=${ESEF_LEI}`,
  body: { data: [esefEntityResource], meta: { count: 1 } },
};
const esefEntityByNameRoute: Route = {
  pattern: "ilike",
  body: { data: [esefEntityResource], meta: { count: 1 } },
};

// A two-period filings list for the same issuer, newest reporting period first,
// each linking an iXBRL viewer plus package/json/xHTML documents.
function esefFilingResource(periodEnd: string, addedYear: string): Record<string, unknown> {
  return {
    type: "filing",
    id: periodEnd,
    attributes: {
      fxo_id: `${ESEF_LEI}-${periodEnd}`,
      country: "GB",
      period_end: periodEnd,
      json_url: `/report/${periodEnd}.json`,
      viewer_url: `/view/${periodEnd}/`,
      package_url: `/pkg/${periodEnd}.zip`,
      report_url: `/report/${periodEnd}/`,
      date_added: `${addedYear}-08-21T00:00:00Z`,
    },
    relationships: { entity: { data: { type: "entity", id: "ent-1" } } },
  };
}
const esefFilingsListRoute: Route = {
  pattern: `filter%5Bentity.identifier%5D=${ESEF_LEI}`,
  body: {
    data: [
      esefFilingResource("2025-03-31", "2025"),
      esefFilingResource("2024-03-31", "2024"),
    ],
    included: [
      { type: "entity", id: "ent-1", attributes: { identifier: ESEF_LEI, name: "KAINOS GROUP PLC" } },
    ],
  },
};

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

  // OwnershipChain (GLEIF-global) and CompanyCharges have no jurisdiction dispatch
  // param. CompanyDocument and PersonAppointments each have one, but restricted to
  // the jurisdictions that support that capability (US/GB), so they are excluded
  // from the full-set assertion below and checked separately. Every other tool
  // routes on the full jurisdiction enum.
  const JURISDICTION_AGNOSTIC = new Set([
    "OwnershipChain",
    "CompanyDocument",
    "CompanyCharges",
    "PersonAppointments",
  ]);

  test("CompanyDocument jurisdiction is restricted to GB/US/JP/KR", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: GB_ENV });
    const jurisdiction = toolByName(tools, "CompanyDocument").inputSchema.jurisdiction;
    expect(jurisdiction?.safeParse("US").success).toBe(true);
    expect(jurisdiction?.safeParse("GB").success).toBe(true);
    expect(jurisdiction?.safeParse("JP").success).toBe(true);
    expect(jurisdiction?.safeParse("KR").success).toBe(true);
    expect(jurisdiction?.safeParse("CN").success).toBe(false);
  });

  test("PersonAppointments jurisdiction is restricted to US, GB and DE", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: GB_ENV });
    const jurisdiction = toolByName(tools, "PersonAppointments").inputSchema.jurisdiction;
    expect(jurisdiction?.safeParse("US").success).toBe(true);
    expect(jurisdiction?.safeParse("GB").success).toBe(true);
    expect(jurisdiction?.safeParse("DE").success).toBe(true);
    expect(jurisdiction?.safeParse("JP").success).toBe(false);
  });

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

describe("CompanyDocument US (SEC EDGAR)", () => {
  const US_ACCESSION = "0000320193-25-000079";
  const US_NODASH = "000032019325000079";

  function usSubmissions(primaryDocument: string): unknown {
    return {
      cik: "320193",
      name: "Apple Inc.",
      filings: {
        recent: {
          accessionNumber: [US_ACCESSION],
          filingDate: ["2025-10-31"],
          reportDate: ["2025-09-27"],
          form: ["10-K"],
          primaryDocument: [primaryDocument],
          primaryDocDescription: ["Form 10-K"],
        },
      },
    };
  }

  function usManifest(names: string[]): unknown {
    return {
      directory: {
        name: `/Archives/edgar/data/320193/${US_NODASH}`,
        item: names.map((name) => ({ name, type: "text.gif", size: "1000", "last-modified": "2025-10-31 06:01:26" })),
      },
    };
  }

  test("metadata mode lists documents with the primary highlighted", async () => {
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: usSubmissions("aapl-20250927.htm") },
      { pattern: `${US_NODASH}/index.json`, body: usManifest([`${US_ACCESSION}-index.html`, "aapl-20250927.htm", "exhibit99.pdf"]) },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: US_ACCESSION,
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("SEC filing: 10-K 0000320193-25-000079");
    expect(text).toContain("**aapl-20250927.htm**");
    expect(text).toContain("exhibit99.pdf");
    expect(text).toContain("2025-09-27");
  });

  test("xhtml mode returns the primary document's extracted text with the content warning", async () => {
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: usSubmissions("aapl-20250927.htm") },
      { pattern: `${US_NODASH}/index.json`, body: usManifest(["aapl-20250927.htm"]) },
      { pattern: "aapl-20250927.htm", body: "<html><body><p>Net sales 391,035</p></body></html>" },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: US_ACCESSION,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Net sales 391,035");
    expect(text).toContain("filer-authored");
  });

  test("xhtml mode reports the image-only analog for a .txt-only submission", async () => {
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: usSubmissions(`${US_ACCESSION}.txt`) },
      { pattern: `${US_NODASH}/index.json`, body: usManifest([`${US_ACCESSION}.txt`]) },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: US_ACCESSION,
      mode: "xhtml",
    } as never);
    expect(resultText(result)).toContain("predates EDGAR's inline");
  });

  test("pdf mode reports honestly when the filing has no PDF rendition", async () => {
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: usSubmissions("aapl-20250927.htm") },
      { pattern: `${US_NODASH}/index.json`, body: usManifest(["aapl-20250927.htm"]) },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: US_ACCESSION,
      mode: "pdf",
    } as never);
    expect(resultText(result)).toContain("no PDF rendition");
  });

  test("without an accession it asks for the transaction_id", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
    } as never);
    expect(resultText(result)).toContain("SEC accession number");
  });

  test("missing SEC configuration is reported without hitting the network", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: US_ACCESSION,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("DISCLOSURES_USER_AGENT");
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("CompanyDocument JP (EDINET)", () => {
  const DOC_ID = "S100YRS6";
  const pdfBytes = latin1Bytes("%PDF-1.5\n/Type /Page\n/Type /Page\ntrailer\n%%EOF");
  const archiveBytes = makeStoredZipMulti([
    { name: "XBRL/PublicDoc/0000000_header_jpcrp.htm", content: "<html>header</html>" },
    { name: "XBRL/PublicDoc/jpcrp030000-asr.xml", content: "<xbrl/>" },
    { name: "XBRL/AuditDoc/jpaud-aai.xml", content: "<xbrl/>" },
  ]);

  test("metadata mode lists the XBRL archive members (type=1)", async () => {
    const fetchFn = routedFetch([{ pattern: "type=1", body: archiveBytes }]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "7203",
      jurisdiction: "JP",
      transaction_id: DOC_ID,
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain(`EDINET document: ${DOC_ID}`);
    expect(text).toContain("XBRL/PublicDoc/jpcrp030000-asr.xml");
    expect(text).toContain("XBRL archive members");
  });

  test("pdf mode downloads the PDF and reports the page count", async () => {
    const fetchFn = routedFetch([{ pattern: "type=2", body: pdfBytes }]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const outputPath = join(tmpdir(), `disclosures-jp-${DOC_ID}.pdf`);
    try {
      const result = await toolByName(tools, "CompanyDocument").handler({
        company: "7203",
        jurisdiction: "JP",
        transaction_id: DOC_ID,
        mode: "pdf",
        output_path: outputPath,
      } as never);
      expect(result.isError).toBeUndefined();
      const text = resultText(result);
      expect(text).toContain("Downloaded PDF");
      expect(text).toContain("| Pages | 2 |");
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  test("xhtml mode reports EDINET's XBRL-archive analog without a network call", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "7203",
      jurisdiction: "JP",
      transaction_id: DOC_ID,
      mode: "xhtml",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("bundled XBRL archive");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("a JSON error envelope for a bad docID is surfaced as a readable error", async () => {
    const fetchFn = routedFetch([
      { pattern: "type=2", body: { metadata: { status: "404", message: "No such document." } } },
    ]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "7203",
      jurisdiction: "JP",
      transaction_id: "S100XXXX",
      mode: "pdf",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("No such document.");
  });

  test("without a docID it asks for the transaction_id", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: JP_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "7203",
      jurisdiction: "JP",
    } as never);
    expect(resultText(result)).toContain("EDINET docID");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("missing EDINET configuration is reported without hitting the network", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "7203",
      jurisdiction: "JP",
      transaction_id: DOC_ID,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("EDINET_API_KEY");
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("CompanyDocument KR (OpenDART)", () => {
  const RCEPT = "20240312000736";
  const docArchive = makeStoredZipMulti([
    {
      name: `${RCEPT}.xml`,
      content:
        "<DOCUMENT><DOCUMENT-NAME>사업보고서</DOCUMENT-NAME><BODY><P>매출액 100</P></BODY></DOCUMENT>",
    },
    { name: `${RCEPT}_00001.xml`, content: "<TABLE><TR><TD>주석</TD></TR></TABLE>" },
  ]);

  test("metadata mode lists the DART documents with the main document highlighted", async () => {
    const fetchFn = routedFetch([{ pattern: "document.xml", body: docArchive }]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: RCEPT,
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain(`DART document: ${RCEPT}`);
    expect(text).toContain(`**${RCEPT}.xml**`);
    expect(text).toContain(`${RCEPT}_00001.xml`);
  });

  test("xhtml mode extracts the main document text with the content warning", async () => {
    const fetchFn = routedFetch([{ pattern: "document.xml", body: docArchive }]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: RCEPT,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(text).toContain("매출액 100");
    expect(text).toContain("filer-authored");
  });

  test("pdf mode reports honestly that DART serves XML, not PDF, without a network call", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: RCEPT,
      mode: "pdf",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("does not serve a PDF");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("a status envelope (file not yet available) is surfaced as a readable error", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "document.xml",
        body: "<result><status>014</status><message>파일이 존재하지 않습니다.</message></result>",
      },
    ]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: RCEPT,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("파일이 존재하지 않습니다.");
  });

  test("a malformed receipt number is rejected before any network call", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: "not-a-receipt",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("14-digit");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("missing OpenDART configuration is reported without hitting the network", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyDocument").handler({
      company: "삼성전자",
      jurisdiction: "KR",
      transaction_id: RCEPT,
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("OPENDART_API_KEY");
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("PersonAppointments US (SEC EDGAR)", () => {
  const PERSON_CIK = "1494730";
  const PERSON_NODASH = "0001494730";

  const SEARCH_ATOM = `<?xml version="1.0" encoding="ISO-8859-1"?>
<feed>
  <entry><company-info>
    <cik>0000320193</cik>
    <conformed-name>COOK TIMOTHY D</conformed-name>
    <last-date>2025-10-01</last-date>
    <addresses><address type="mailing"><street1>ONE APPLE PARK WAY</street1><city>CUPERTINO</city><state>CA</state></address></addresses>
  </company-info></entry>
  <entry><company-info>
    <cik>0001214128</cik>
    <last-date>2019-05-01</last-date>
    <addresses><address type="mailing"><street1>123 MAIN ST</street1><city>NEWARK</city><state>NJ</state></address></addresses>
  </company-info></entry>
</feed>`;

  const OWN_DISP_HTML = `<html><body>
  <b>MUSK ELON (<a href="/cgi-bin/browse-edgar?action=getcompany&CIK=0001494730">0001494730</a>)</b>
  <table border="1">
  <tr><th>Issuer</th><th>CIK</th><th>Date</th><th>Type</th></tr>
  <tr>
    <td><a href="/cgi-bin/browse-edgar?action=getissuer&CIK=0001318605">TESLA, INC.</a></td>
    <td>1318605</td>
    <td>2025-01-15</td>
    <td>director, 10 percent owner, officer: CEO</td>
  </tr>
  <tr>
    <td><a href="/cgi-bin/browse-edgar?action=getissuer&CIK=0001181412">SPACE EXPLORATION TECHNOLOGIES CORP</a></td>
    <td>1181412</td>
    <td>2024-08-01</td>
    <td>director, officer: CEO</td>
  </tr>
  </table>
  </body></html>`;

  function personSubmissions(): unknown {
    return {
      cik: PERSON_CIK,
      name: "Musk Elon",
      entityType: "other",
      filings: { recent: { form: ["4", "4", "4", "SC 13D/A"] } },
    };
  }

  test("search mode lists reporting-owner CIKs with names and address hints", async () => {
    const fetchFn = routedFetch([{ pattern: "output=atom", body: SEARCH_ATOM }]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "search",
      query: "cook timothy",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("US reporting-owner search: cook timothy");
    expect(text).toContain("COOK TIMOTHY D");
    expect(text).toContain("0000320193");
    expect(text).toContain("CUPERTINO, CA");
    expect(text).toContain("0001214128");
    expect(text).toContain("filer-authored");
  });

  test("appointments mode lists issuers a person has reported ownership to", async () => {
    const fetchFn = routedFetch([
      { pattern: "own-disp", body: OWN_DISP_HTML },
      { pattern: `submissions/CIK${PERSON_NODASH}.json`, body: personSubmissions() },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "appointments",
      officer_id: PERSON_CIK,
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("US reporting-owner roles: Musk Elon");
    expect(text).toContain("TESLA, INC.");
    expect(text).toContain("0001318605");
    expect(text).toContain("SPACE EXPLORATION TECHNOLOGIES CORP");
    expect(text).toContain("director, 10 percent owner, officer: CEO");
    expect(text).toContain("other");
    expect(text).toContain("4 (3)");
    expect(text).toContain("SALI lookup");
  });

  test("appointments mode still works when the submissions enrichment fails", async () => {
    const fetchFn = routedFetch([{ pattern: "own-disp", body: OWN_DISP_HTML }]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "appointments",
      officer_id: PERSON_CIK,
    } as never);
    // The submissions route is absent, so enrichment throws internally and degrades
    // to the own-disp header name; the roles table must still render.
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("MUSK ELON");
    expect(text).toContain("TESLA, INC.");
  });

  test("appointments mode requires an officer_id", async () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "appointments",
    } as never);
    expect(resultText(result)).toContain("person's SEC CIK");
  });

  test("disqualifications mode returns a safe SALI link without hitting the network", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "disqualifications",
      query: "Elon Musk",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("US enforcement lookup: Elon Musk");
    expect(text).toContain("sec-action-look-up");
    expect(text).toContain("no API");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("missing SEC configuration is reported without hitting the network", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "US",
      mode: "search",
      query: "cook timothy",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("DISCLOSURES_USER_AGENT");
    expect(fetchFn.requests).toHaveLength(0);
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

  test("the still-unsupported EU tools return the honest message without any network call", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    for (const name of ["CompanyInsiders", "CompanyOwners", "PrivateRaises"]) {
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

  test("CompanyResolve resolves an ESEF filer by LEI and lists the register match", async () => {
    const fetchFn = routedFetch([esefEntityByLeiRoute, ...esefRoutes]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("Company resolution (filings.xbrl.org)");
    expect(text).toContain("KAINOS GROUP PLC");
    expect(text).toContain(`LEI ${ESEF_LEI}`);
    // Top match enriched with country (GB) from its newest filing.
    expect(text).toContain("GB");
    expect(result.structuredContent).toMatchObject({
      candidates: [{ lei: ESEF_LEI, jurisdiction: "GB" }],
    });
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyResolve resolves an ESEF filer by name via the ilike register search", async () => {
    const fetchFn = routedFetch([esefEntityByNameRoute, ...esefRoutes]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "Kainos",
      jurisdiction: "EU",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("KAINOS GROUP PLC");
    expect(text).toContain(ESEF_LEI);
    // The register was queried with the flask-combo-jsonapi ilike operator.
    expect(fetchFn.requests.some(({ url }) => url.includes("ilike"))).toBe(true);
  });

  test("CompanyResolve returns an honest not-found for a name absent from the register", async () => {
    const fetchFn = routedFetch([
      { pattern: "api/entities", body: { data: [], meta: { count: 0 } } },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "No Such Issuer",
      jurisdiction: "EU",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('Could not find a company matching "No Such Issuer"');
    expect(resultText(result)).toContain("ESEF filers only");
  });

  test("CompanyFilings lists an ESEF filer's annual reports by LEI with viewer and document links", async () => {
    const fetchFn = routedFetch([esefFilingsListRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("ESEF/UKSEF annual reports");
    expect(text).toContain("2025-03-31");
    expect(text).toContain("2024-03-31");
    expect(text).toContain("ESEF (GB)");
    expect(text).toContain("https://filings.xbrl.org/view/2025-03-31/");
    expect(text).toContain("xBRL-JSON");
    // Newest reporting period first; fxo_id chains as the transaction id.
    expect(result.structuredContent).toMatchObject({
      filings: [
        { transactionId: `${ESEF_LEI}-2025-03-31`, form: "ESEF (GB)" },
        { transactionId: `${ESEF_LEI}-2024-03-31`, form: "ESEF (GB)" },
      ],
    });
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("CompanyFilings honours the date window, limit, and latest_annual mode", async () => {
    const windowed = await toolByName(
      createTools({ fetchFn: routedFetch([esefFilingsListRoute]), env: ENV }),
      "CompanyFilings",
    ).handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
      start_date: "2025-01-01",
      end_date: "2025-12-31",
    } as never);
    const windowedText = resultText(windowed);
    expect(windowedText).toContain("2025-03-31");
    expect(windowedText).not.toContain("2024-03-31");

    const latest = await toolByName(
      createTools({ fetchFn: routedFetch([esefFilingsListRoute]), env: ENV }),
      "CompanyFilings",
    ).handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
      mode: "latest_annual",
    } as never);
    const latestText = resultText(latest);
    expect(latestText).toContain("2025-03-31");
    expect(latestText).not.toContain("2024-03-31");
  });

  test("CompanyFilings returns an honest empty message and rejects latest_quarterly", async () => {
    const emptyFetch = routedFetch([
      { pattern: `filter%5Bentity.identifier%5D=${ESEF_LEI}`, body: { data: [], included: [] } },
    ]);
    const emptyResult = await toolByName(
      createTools({ fetchFn: emptyFetch, env: ENV }),
      "CompanyFilings",
    ).handler({ company: ESEF_LEI, jurisdiction: "EU" } as never);
    expect(emptyResult.isError).toBeUndefined();
    expect(resultText(emptyResult)).toContain("No ESEF/UKSEF annual reports found");

    const quarterly = await toolByName(
      createTools({ fetchFn: routedFetch([]), env: ENV }),
      "CompanyFilings",
    ).handler({ company: ESEF_LEI, jurisdiction: "EU", mode: "latest_quarterly" } as never);
    expect(resultText(quarterly)).toContain("Latest quarterly mode is unsupported for EU");
  });

  test("CompanyFilings surfaces an upstream failure as an error result", async () => {
    const fetchFn = routedFetch([
      { pattern: `filter%5Bentity.identifier%5D=${ESEF_LEI}`, body: "boom", status: 503 },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "CompanyFilings").handler({
      company: ESEF_LEI,
      jurisdiction: "EU",
    } as never);
    expect(result.isError).toBe(true);
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

  const dePersonSearchRoute: Route = {
    pattern: "meldepflichtigerName=",
    body: loadFixture("bafin", "dealings-person-search.html"),
  };
  const dePersonDetailRoute: Route = {
    pattern: "DealingsInfo/ergebnisListe.do",
    body: loadFixture("bafin", "dealings-person-appointments.html"),
  };

  test("PersonAppointments search lists BaFin notifying persons with ids", async () => {
    const fetchFn = routedFetch([dePersonSearchRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "DE",
      mode: "search",
      query: "Klein",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("DE reporting-person search: Klein");
    expect(text).toContain("Christian Kurt");
    expect(text).toContain("34505");
    expect(text).toContain("Management board (Vorstand)");
    expect(text).toContain("Dr.");
    expect(text).toContain("DealingsInfo");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("PersonAppointments appointments collapses a person's trades by issuer", async () => {
    const fetchFn = routedFetch([dePersonDetailRoute]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "DE",
      mode: "appointments",
      officer_id: "34505",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("DE reporting-person issuers: Klein, Christian Kurt");
    expect(text).toContain("SAP SE");
    expect(text).toContain("40001244");
    expect(text).toContain("SAP Fioneer GmbH");
    // Two SAP SE trades collapse to one row with a count of 2.
    expect(text).toContain("| 2 |");
    expect(text).toContain("2026-07-24");
    expect(fetchFn.requests.some(({ url }) => hitsSec(url))).toBe(false);
  });

  test("PersonAppointments appointments requires an officer_id", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "DE",
      mode: "appointments",
    } as never);
    expect(resultText(result)).toContain("meldepflichtigerId");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("PersonAppointments search requires a query", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "DE",
      mode: "search",
    } as never);
    expect(resultText(result)).toContain("requires a query");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("PersonAppointments disqualifications is honestly unsupported without a network hit", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      jurisdiction: "DE",
      mode: "disqualifications",
      query: "Klein",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain("DE disqualifications: Klein");
    expect(text).toContain("no public disqualified-directors register");
    expect(fetchFn.requests).toHaveLength(0);
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

describe("MCP client ergonomics", () => {
  test("every tool carries read-only open-world annotations except CompanyDocument", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      // CompanyDocument mode="pdf" writes a file to disk, so it alone must
      // not claim to be read-only.
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== "CompanyDocument");
    }
  });

  test("CompanyResolve returns ranked structured candidates alongside the markdown", async () => {
    const fetchFn = routedFetch([krCorpCodeRoute]);
    const tools = createTools({ fetchFn, env: KR_ENV });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "005930",
      jurisdiction: "KR",
    } as never);
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      candidates?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(structured?.candidates)).toBe(true);
    const top = structured.candidates?.[0];
    expect(top?.rank).toBe(1);
    expect(top?.corpCode).toBe("00126380");
    expect(top?.stockCode).toBe("005930");
    expect(typeof top?.matchReason).toBe("string");
  });

  test("CompanyFilings returns structured transaction ids and a next-step trailer", async () => {
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
    expect(resultText(result)).toContain("_Next: pass a transaction id");
    const structured = result.structuredContent as {
      filings?: Array<Record<string, unknown>>;
    };
    expect(structured?.filings?.[0]?.transactionId).toBe("20230307000542");
  });

  test("PersonAppointments search returns structured people with officer ids", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/search/officers",
        body: {
          items: [
            {
              title: "John SMITH",
              links: { self: "/officers/AbC123xYz/appointments" },
              appointment_count: 4,
              date_of_birth: { year: 1970, month: 5 },
              address_snippet: "1 Example Street, London",
            },
          ],
        },
      },
    ]);
    const tools = createTools({ fetchFn, env: GB_ENV });
    const result = await toolByName(tools, "PersonAppointments").handler({
      query: "John Smith",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("_Next: call PersonAppointments mode=\"appointments\"");
    const structured = result.structuredContent as {
      people?: Array<Record<string, unknown>>;
    };
    expect(structured?.people?.[0]?.officerId).toBe("AbC123xYz");
    expect(structured?.people?.[0]?.name).toBe("John SMITH");
  });

  test("CompanyDocument xhtml pages via text_offset with untrusted-text fencing", async () => {
    const longBody = "A".repeat(60_000) + "TAIL-MARKER";
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: {
        cik: "320193",
        name: "Apple Inc.",
        filings: {
          recent: {
            accessionNumber: ["0000320193-25-000079"],
            filingDate: ["2025-10-31"],
            reportDate: ["2025-09-27"],
            form: ["10-K"],
            primaryDocument: ["aapl-20250927.htm"],
            primaryDocDescription: ["Form 10-K"],
          },
        },
      } },
      { pattern: "000032019325000079/index.json", body: {
        directory: {
          name: "/Archives/edgar/data/320193/000032019325000079",
          item: [{ name: "aapl-20250927.htm", type: "text.gif", size: "1000", "last-modified": "2025-10-31 06:01:26" }],
        },
      } },
      { pattern: "aapl-20250927.htm", body: `<html><body><p>${longBody}</p></body></html>` },
    ]);
    const tools = createTools({ fetchFn, env: ENV });
    const first = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: "0000320193-25-000079",
      mode: "xhtml",
    } as never);
    const firstText = resultText(first);
    expect(firstText).toContain("<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>");
    expect(firstText).toContain("<<<END UNTRUSTED DOCUMENT TEXT>>>");
    expect(firstText).toContain("Characters 0–50,000");
    expect(firstText).toContain("re-call with text_offset: 50000");
    expect(firstText).not.toContain("TAIL-MARKER");

    const second = await toolByName(tools, "CompanyDocument").handler({
      company: "320193",
      jurisdiction: "US",
      transaction_id: "0000320193-25-000079",
      mode: "xhtml",
      text_offset: 50_000,
    } as never);
    const secondText = resultText(second);
    expect(secondText).toContain("TAIL-MARKER");
    expect(secondText).not.toContain("re-call with text_offset");
  });
});
