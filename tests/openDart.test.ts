import { beforeEach, describe, expect, test } from "bun:test";
import {
  getOpenDartFinancials,
  getOpenDartInsiders,
  getOpenDartOwners,
  getLatestOpenDartReport,
  OpenDartConfigurationError,
  OpenDartRateLimitError,
  OPEN_DART_5_PERCENT_THRESHOLD_REGIME,
  parseKoreanAmount,
  parseOpenDartCorpCodeXml,
  resetOpenDartCorpCodeCache,
  resolveOpenDartCorpCode,
  searchOpenDartCompanies,
  searchOpenDartFilings,
} from "../src/adapters/openDart.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env } from "../src/core/types.js";
import { routedFetch } from "./helpers/routedFetch.js";
import { makeStoredZip } from "./helpers/zipFixture.js";

const ENV: Env = { OPENDART_API_KEY: "test-api-key" };
const CORP_CODE = "00126380";
const STOCK_CODE = "005930";

function options(
  fetchFn: ReturnType<typeof routedFetch>,
  env: Env = ENV,
): AdapterOptions {
  return { fetchFn, env };
}

const CORP_CODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>${CORP_CODE}</corp_code>
    <corp_name>삼성전자</corp_name>
    <corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name>
    <stock_code>${STOCK_CODE}</stock_code>
    <modify_date>20230101</modify_date>
  </list>
  <list>
    <corp_code>00111111</corp_code>
    <corp_name>테스트비상장</corp_name>
    <corp_eng_name>TEST PRIVATE INC</corp_eng_name>
    <stock_code> </stock_code>
    <modify_date>20220101</modify_date>
  </list>
</result>`;

function corpCodeRoute() {
  return {
    pattern: "corpCode.xml",
    body: makeStoredZip("CORPCODE.xml", CORP_CODE_XML),
  };
}

const FILINGS_BODY = {
  status: "000",
  message: "정상",
  page_no: 1,
  page_count: 100,
  total_count: 2,
  total_page: 1,
  list: [
    {
      corp_code: CORP_CODE,
      corp_name: "삼성전자",
      stock_code: STOCK_CODE,
      report_nm: "사업보고서 (2022.12)",
      rcept_no: "20230307000542",
      flr_nm: "삼성전자",
      rcept_dt: "20230307",
      rm: "",
    },
    {
      corp_code: CORP_CODE,
      corp_name: "삼성전자",
      stock_code: STOCK_CODE,
      report_nm: "분기보고서 (2022.09)",
      rcept_no: "20221114001234",
      flr_nm: "삼성전자",
      rcept_dt: "20221114",
      rm: "",
    },
  ],
};

const INSIDERS_BODY = {
  status: "000",
  message: "정상",
  list: [
    {
      rcept_no: "20230512000777",
      rcept_dt: "2023-05-12",
      corp_code: CORP_CODE,
      corp_name: "삼성전자",
      repror: "홍길동",
      isu_exctv_rgist_at: "등기임원",
      isu_exctv_ofcps: "대표이사",
      isu_main_shrholdr: "-",
      sp_stock_lmp_cnt: "1,000,000",
      sp_stock_lmp_irds_cnt: "50,000",
      sp_stock_lmp_rate: "0.02",
    },
  ],
};

const OWNERS_BODY = {
  status: "000",
  message: "정상",
  list: [
    {
      rcept_no: "20230101000111",
      rcept_dt: "20230101",
      corp_code: CORP_CODE,
      corp_name: "삼성전자",
      repror: "국민연금공단",
      report_tp: "변동",
      stkqy: "500,000,000",
      stkrt: "8.51",
      stkrt_irds: "1.02",
      report_resn: "장내매수",
    },
  ],
};

function financialRow(
  accountName: string,
  amount: string,
  fsDiv: "CFS" | "OFS",
  thstrmDt: string,
) {
  return {
    rcept_no: "20230307000542",
    corp_code: CORP_CODE,
    bsns_year: "2022",
    fs_div: fsDiv,
    fs_nm: fsDiv === "CFS" ? "연결재무제표" : "재무제표",
    account_nm: accountName,
    thstrm_nm: "제54기",
    thstrm_dt: thstrmDt,
    thstrm_amount: amount,
    currency: "KRW",
  };
}

const FINANCIALS_BODY = {
  status: "000",
  message: "정상",
  list: [
    financialRow("자산총계", "448,424,507", "CFS", "2022.12.31 현재"),
    financialRow("부채총계", "93,674,903", "CFS", "2022.12.31 현재"),
    financialRow("자본총계", "354,749,604", "CFS", "2022.12.31 현재"),
    financialRow("매출액", "302,231,360", "CFS", "2022.01.01 ~ 2022.12.31"),
    financialRow("영업이익", "43,376,630", "CFS", "2022.01.01 ~ 2022.12.31"),
    financialRow("당기순이익", "55,654,077", "CFS", "2022.01.01 ~ 2022.12.31"),
    financialRow("자산총계", "301,257,000", "OFS", "2022.12.31 현재"),
    financialRow("매출액", "211,867,483", "OFS", "2022.01.01 ~ 2022.12.31"),
  ],
};

beforeEach(() => {
  resetRateLimiters();
  resetOpenDartCorpCodeCache();
});

describe("OpenDART configuration", () => {
  test("resolution requires an API key and fails before any request", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    await expect(
      searchOpenDartCompanies("삼성전자", options(fetchFn, {})),
    ).rejects.toBeInstanceOf(OpenDartConfigurationError);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("sends crtfc_key on every request", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    await searchOpenDartCompanies("삼성전자", options(fetchFn));
    expect(fetchFn.requests[0]?.url).toContain("crtfc_key=test-api-key");
  });
});

describe("corp-code parsing and resolution", () => {
  test("parses list entries and drops blank stock codes", () => {
    const entries = parseOpenDartCorpCodeXml(CORP_CODE_XML);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      corpCode: CORP_CODE,
      corpName: "삼성전자",
      corpEngName: "SAMSUNG ELECTRONICS CO,.LTD",
      stockCode: STOCK_CODE,
    });
    expect(entries[1]?.stockCode).toBeUndefined();
  });

  test("resolves by exact 8-digit corp code", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    const results = await searchOpenDartCompanies(CORP_CODE, options(fetchFn));
    expect(results).toHaveLength(1);
    expect(results[0]?.corpCode).toBe(CORP_CODE);
    expect(results[0]?.source).toBe("OpenDART");
    expect(results[0]?.jurisdiction).toBe("KR");
  });

  test("resolves by exact 6-digit stock code", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    const results = await searchOpenDartCompanies(STOCK_CODE, options(fetchFn));
    expect(results[0]?.corpCode).toBe(CORP_CODE);
    expect(results[0]?.stockCode).toBe(STOCK_CODE);
  });

  test("resolves by Korean legal name", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    const code = await resolveOpenDartCorpCode("삼성전자", options(fetchFn));
    expect(code).toBe(CORP_CODE);
  });

  test("resolves by English alias substring", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    const results = await searchOpenDartCompanies("Samsung", options(fetchFn));
    expect(results[0]?.corpCode).toBe(CORP_CODE);
  });

  test("caches the corp-code archive across calls", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    await searchOpenDartCompanies("삼성전자", options(fetchFn));
    await searchOpenDartCompanies("Samsung", options(fetchFn));
    expect(
      fetchFn.requests.filter(({ url }) => url.includes("corpCode.xml")),
    ).toHaveLength(1);
  });

  test("throws a not-found error when the query matches nothing", async () => {
    const fetchFn = routedFetch([corpCodeRoute()]);
    await expect(
      resolveOpenDartCorpCode("no-such-company", options(fetchFn)),
    ).rejects.toThrow(/no opendart company found/i);
  });
});

describe("filings", () => {
  test("returns filings with DART viewer links, newest first", async () => {
    const fetchFn = routedFetch([corpCodeRoute(), { pattern: "list.json", body: FILINGS_BODY }]);
    const filings = await searchOpenDartFilings("삼성전자", options(fetchFn));
    expect(filings).toHaveLength(2);
    expect(filings[0]?.filedDate).toBe("2023-03-07");
    expect(filings[0]?.sourceUrl).toContain("rcpNo=20230307000542");
    expect(filings[0]?.source).toBe("OpenDART");
  });

  test("filters by report-name token", async () => {
    const fetchFn = routedFetch([corpCodeRoute(), { pattern: "list.json", body: FILINGS_BODY }]);
    const filings = await searchOpenDartFilings(
      { company: "삼성전자", forms: ["분기보고서"] },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.form).toContain("분기보고서");
  });

  test("degrades to an empty list on OpenDART status 013 (no data)", async () => {
    const fetchFn = routedFetch([
      corpCodeRoute(),
      { pattern: "list.json", body: { status: "013", message: "조회된 데이타가 없습니다." } },
    ]);
    const filings = await searchOpenDartFilings("삼성전자", options(fetchFn));
    expect(filings).toEqual([]);
  });

  test("finds the latest annual periodic report", async () => {
    const fetchFn = routedFetch([corpCodeRoute(), { pattern: "list.json", body: FILINGS_BODY }]);
    const report = await getLatestOpenDartReport("삼성전자", "annual", options(fetchFn));
    expect(report?.form).toContain("사업보고서");
    expect(report?.reportKind).toBe("annual");
    expect(report?.sectionLinks[0]?.url).toContain("rcpNo=");
  });
});

describe("insiders (elestock)", () => {
  test("parses executive ownership reports", async () => {
    const fetchFn = routedFetch([corpCodeRoute(), { pattern: "elestock.json", body: INSIDERS_BODY }]);
    const insiders = await getOpenDartInsiders("삼성전자", options(fetchFn));
    expect(insiders).toHaveLength(1);
    expect(insiders[0]?.name).toBe("홍길동");
    expect(insiders[0]?.officerRole).toBe("대표이사");
    expect(insiders[0]?.filedDate).toBe("2023-05-12");
    expect(insiders[0]?.pct).toBe(0.02);
    expect(insiders[0]?.change).toBe(50000);
    expect(insiders[0]?.roles.join(" ")).toContain("1,000,000");
  });
});

describe("owners (majorstock)", () => {
  test("parses 5% mass-holding reports and labels the threshold regime", async () => {
    const fetchFn = routedFetch([corpCodeRoute(), { pattern: "majorstock.json", body: OWNERS_BODY }]);
    const owners = await getOpenDartOwners("삼성전자", options(fetchFn));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.holderName).toBe("국민연금공단");
    expect(owners[0]?.pct).toBe(8.51);
    expect(owners[0]?.change).toBe(1.02);
    expect(owners[0]?.thresholdRegime).toBe(OPEN_DART_5_PERCENT_THRESHOLD_REGIME);
    expect(owners[0]?.naturesOfControl).toEqual(["장내매수"]);
    expect(owners[0]?.filedDate).toBe("2023-01-01");
  });
});

describe("financials (fnlttSinglAcnt)", () => {
  test("maps Korean account names to canonical concepts with basis and period end", async () => {
    const fetchFn = routedFetch([
      corpCodeRoute(),
      { pattern: "fnlttSinglAcnt.json", body: FINANCIALS_BODY },
    ]);
    const facts = await getOpenDartFinancials("삼성전자", { years: [2022] }, options(fetchFn));

    const revenueCfs = facts.find((f) => f.concept === "revenue" && f.basis === "consolidated");
    expect(revenueCfs?.value).toBe(302231360);
    expect(revenueCfs?.periodEnd).toBe("2022-12-31");
    expect(revenueCfs?.unit).toBe("KRW");
    expect(revenueCfs?.filedDate).toBe("2023-03-07");

    const assetsCfs = facts.find((f) => f.concept === "total_assets" && f.basis === "consolidated");
    expect(assetsCfs?.value).toBe(448424507);

    const assetsOfs = facts.find((f) => f.concept === "total_assets" && f.basis === "separate");
    expect(assetsOfs?.value).toBe(301257000);
  });

  test("restricts to requested concepts", async () => {
    const fetchFn = routedFetch([
      corpCodeRoute(),
      { pattern: "fnlttSinglAcnt.json", body: FINANCIALS_BODY },
    ]);
    const facts = await getOpenDartFinancials(
      "삼성전자",
      { years: [2022], concepts: ["revenue"] },
      options(fetchFn),
    );
    expect(facts.every((f) => f.concept === "revenue")).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
  });
});

describe("error normalization", () => {
  test("maps OpenDART status 020 to a rate-limit error", async () => {
    const fetchFn = routedFetch([
      corpCodeRoute(),
      { pattern: "list.json", body: { status: "020", message: "요청 제한을 초과하였습니다." } },
    ]);
    await expect(
      searchOpenDartFilings("삼성전자", options(fetchFn)),
    ).rejects.toBeInstanceOf(OpenDartRateLimitError);
  });
});

describe("value parsing", () => {
  test("parseKoreanAmount handles commas, parentheses, and blanks", () => {
    expect(parseKoreanAmount("1,234,567")).toBe(1234567);
    expect(parseKoreanAmount("(1,000)")).toBe(-1000);
    expect(parseKoreanAmount("△500")).toBe(-500);
    expect(parseKoreanAmount("-")).toBeUndefined();
    expect(parseKoreanAmount("")).toBeUndefined();
    expect(parseKoreanAmount(undefined)).toBeUndefined();
  });
});
