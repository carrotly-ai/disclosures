import { beforeEach, describe, expect, test } from "bun:test";
import {
  downloadIdxXbrlInstance,
  findIdxInstanceAttachment,
  findIdxReportFallback,
  getIdxFinancials,
  IDX_ANNOUNCEMENT_URL,
  IDX_ANTIBOT_NOTE,
  IDX_FINANCIAL_CONCEPT_NAMES,
  IDX_PROFILES_URL,
  IdxApiError,
  IdxBlockedError,
  IdxRateLimitError,
  idxAttachmentUrl,
  isIdxTicker,
  parseIdxBasis,
  parseIdxContexts,
  parseIdxFinancialReports,
  parseIdxProfiles,
  parseIdxXbrlFinancials,
  resolveIdxCompany,
  searchIdxCompanies,
  searchIdxFilings,
} from "../src/adapters/idxIndonesia.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";
import {
  IDX_XBRL_INSTANCE,
  IDX_XBRL_INSTANCE_BANK,
  makeIdxInstanceZip,
} from "./helpers/idxFixture.js";
import { makeStoredZipMulti } from "./helpers/zipFixture.js";

// Verbatim IDX responses recorded live from www.idx.co.id (2026-08-29) via a
// browser-class fetch: the listed-company roster, one issuer's announcement
// page, and two financial-report submissions (one carrying an XBRL instance,
// one carrying only spreadsheet/PDF renditions).
const PROFILES = JSON.parse(loadFixture("idx", "company-profiles.json"));
const ANNOUNCEMENTS = JSON.parse(loadFixture("idx", "announcement-bbca.json"));
const REPORT_TLKM = JSON.parse(loadFixture("idx", "financial-report-tlkm.json"));
const REPORT_NO_INSTANCE = JSON.parse(
  loadFixture("idx", "financial-report-no-instance.json"),
);

const INSTANCE_ZIP = makeIdxInstanceZip();

/** The full happy-path route set: roster + report lookup + instance download. */
function financialsRoutes(
  report: unknown = REPORT_TLKM,
  instanceZip: Uint8Array | string = INSTANCE_ZIP,
) {
  return [
    { pattern: "GetCompanyProfiles", body: PROFILES },
    { pattern: "GetFinancialReport", body: report },
    { pattern: "instance.zip", body: instanceZip },
  ];
}

beforeEach(() => {
  resetRateLimiters();
});

describe("idxIndonesia helpers", () => {
  test("recognises 4-letter IDX tickers only", () => {
    expect(isIdxTicker("BBCA")).toBe(true);
    expect(isIdxTicker("tlkm")).toBe(true);
    expect(isIdxTicker(" AALI ")).toBe(true);
    expect(isIdxTicker("BBC")).toBe(false); // 3 letters
    expect(isIdxTicker("BBCAX")).toBe(false); // 5 letters
    expect(isIdxTicker("BBC1")).toBe(false); // digits are not IDX codes
    expect(isIdxTicker("Bank Central Asia")).toBe(false);
  });

  test("encodes attachment paths segment-wise, preserving separators", () => {
    const url = idxAttachmentUrl(
      "/Portals/0/StaticData//Laporan Keuangan Tahun 2024/Audit/TLKM/instance.zip",
    );
    // Spaces are encoded, the filed double slash and path separators survive.
    expect(url).toContain("/Laporan%20Keuangan%20Tahun%202024/");
    expect(url).toContain("StaticData//Laporan");
    expect(url.startsWith("https://www.idx.co.id/Portals/0/")).toBe(true);
  });

  test("parses the listed-company roster into profiles", () => {
    const profiles = parseIdxProfiles(PROFILES);
    expect(profiles).toHaveLength(5);
    const bbca = profiles.find((profile) => profile.kodeEmiten === "BBCA");
    expect(bbca?.namaEmiten).toBe("PT Bank Central Asia Tbk.");
    expect(bbca?.sektor).toBe("Keuangan");
    expect(bbca?.subSektor).toBe("Bank");
    expect(bbca?.papanPencatatan).toBe("Utama");
    // The .NET stamp is reduced to a plain ISO date.
    expect(bbca?.tanggalPencatatan).toBe("2000-05-31");
  });

  test("parses financial-report submissions and picks the XBRL instance", () => {
    const reports = parseIdxFinancialReports(REPORT_TLKM);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.kodeEmiten).toBe("TLKM");
    expect(report.reportYear).toBe("2024");
    expect(report.attachments).toHaveLength(4);

    const instance = findIdxInstanceAttachment(report);
    expect(instance?.fileName).toBe("instance.zip");
    // inlineXBRL.zip is a sibling package, NOT the instance — never confuse them.
    expect(instance?.url).toContain("/TLKM/instance.zip");
    expect(instance?.url).not.toContain("inlineXBRL");

    // The human fallback prefers the spreadsheet, then the PDF.
    expect(findIdxReportFallback(report)?.fileName).toBe(
      "FinancialStatement-2024-Tahunan-TLKM.xlsx",
    );
  });

  test("a submission with no instance.zip reports none", () => {
    const report = parseIdxFinancialReports(REPORT_NO_INSTANCE)[0]!;
    expect(findIdxInstanceAttachment(report)).toBeUndefined();
    expect(findIdxReportFallback(report)?.fileName).toContain(".xlsx");
  });
});

describe("idxIndonesia XBRL instance parsing", () => {
  test("selects only undimensioned period contexts", () => {
    const contexts = parseIdxContexts(IDX_XBRL_INSTANCE);
    expect([...contexts.keys()].sort()).toEqual([
      "CurrentYearDuration",
      "CurrentYearInstant",
      "PriorEndYearInstant",
      "PriorYearDuration",
    ]);
    // IDX splits the comparative across two prefixes; both are the prior period.
    expect(contexts.get("PriorYearDuration")?.periodKey).toBe("prior1");
    expect(contexts.get("PriorEndYearInstant")?.periodKey).toBe("prior1");
    expect(contexts.get("PriorEndYearInstant")?.periodEnd).toBe("2023-12-31");
    expect(contexts.get("CurrentYearInstant")?.periodEnd).toBe("2024-12-31");
    // The equity-component context must never qualify as a company total.
    expect(
      contexts.has("CurrentYearInstant_3410000_NonControllingInterestsMember"),
    ).toBe(false);
  });

  test("reads the filer's own consolidation declaration", () => {
    expect(parseIdxBasis(IDX_XBRL_INSTANCE)).toBe("consolidated");
    expect(
      parseIdxBasis(
        IDX_XBRL_INSTANCE.replace(
          "Entitas grup / Group entity",
          "Entitas individual / Individual entity",
        ),
      ),
    ).toBe("separate");
    expect(parseIdxBasis("<xbrl/>")).toBeUndefined();
  });

  test("extracts the headline totals at as-filed IDR scale", () => {
    const facts = parseIdxXbrlFinancials(IDX_XBRL_INSTANCE);
    const current = new Map(
      facts
        .filter((fact) => fact.periodEnd === "2024-12-31")
        .map((fact) => [fact.concept, fact.value]),
    );
    expect(current.get("revenues")).toBe(149_967_000_000_000);
    expect(current.get("operating_income")).toBe(37_786_000_000_000);
    // The parent-attributable line wins over the group ProfitLoss total.
    expect(current.get("net_income")).toBe(23_649_000_000_000);
    expect(current.get("total_assets")).toBe(299_675_000_000_000);
    // Parent-owners' equity is preferred over the total including NCI.
    expect(current.get("stockholders_equity")).toBe(142_094_000_000_000);

    expect(facts.every((fact) => fact.unit === "IDR")).toBe(true);
    expect(facts.every((fact) => fact.basis === "consolidated")).toBe(true);
    // The per-share figure (unit IDRPerShares) is never mistaken for a total.
    expect(facts.some((fact) => fact.value === 238.73)).toBe(false);
    // Nor is the non-controlling-interests equity component.
    expect(facts.some((fact) => fact.value === 20_396_000_000_000)).toBe(false);
  });

  test("carries the prior comparative year and orders newest first", () => {
    const facts = parseIdxXbrlFinancials(IDX_XBRL_INSTANCE);
    const prior = facts.filter((fact) => fact.periodEnd === "2023-12-31");
    expect(prior.length).toBeGreaterThan(0);
    expect(
      prior.find((fact) => fact.concept === "total_assets")?.value,
    ).toBe(287_042_000_000_000);
    expect(facts[0]?.periodEnd).toBe("2024-12-31");
  });

  test("periods=1 keeps only the current period", () => {
    const facts = parseIdxXbrlFinancials(IDX_XBRL_INSTANCE, { periods: 1 });
    expect(facts.every((fact) => fact.periodEnd === "2024-12-31")).toBe(true);
  });

  test("concepts filter narrows the extraction", () => {
    const facts = parseIdxXbrlFinancials(IDX_XBRL_INSTANCE, {
      concepts: ["total_assets"],
    });
    expect(new Set(facts.map((fact) => fact.concept))).toEqual(
      new Set(["total_assets"]),
    );
    // An unknown concept name yields nothing rather than silently everything.
    expect(parseIdxXbrlFinancials(IDX_XBRL_INSTANCE, {
      concepts: ["not_a_concept"],
    })).toEqual([]);
  });

  test("resolves a bank's sector-variant revenue element", () => {
    const facts = parseIdxXbrlFinancials(IDX_XBRL_INSTANCE_BANK);
    const byConcept = new Map(facts.map((fact) => [fact.concept, fact.value]));
    // A bank files interest/sharia income in place of SalesAndRevenue.
    expect(byConcept.get("revenues")).toBe(94_796_454_000_000);
    expect(byConcept.get("total_assets")).toBe(1_449_301_328_000_000);
    expect(byConcept.get("net_income")).toBe(54_836_305_000_000);
  });

  test("an instance with no recognisable contexts yields nothing", () => {
    expect(parseIdxXbrlFinancials("<xbrl></xbrl>")).toEqual([]);
  });

  test("exposes the documented concept set", () => {
    expect(IDX_FINANCIAL_CONCEPT_NAMES).toEqual([
      "revenues",
      "operating_income",
      "net_income",
      "total_assets",
      "stockholders_equity",
    ]);
  });
});

describe("idxIndonesia resolution", () => {
  test("resolves an exact ticker and asks IDX to filter server-side", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    const entity = await resolveIdxCompany("BBCA", { fetchFn });
    expect(entity?.legalName).toBe("PT Bank Central Asia Tbk.");
    expect(entity?.ticker).toBe("BBCA");
    expect(entity?.jurisdiction).toBe("ID");
    expect(entity?.source).toBe("IDX");
    expect(entity?.matchReason).toContain("Exact IDX ticker");
    expect(entity?.sourceIdentifiers?.kodeEmiten).toBe("BBCA");
    expect(entity?.sourceIdentifiers?.listingDate).toBe("2000-05-31");
    expect(entity?.sourceIdentifiers?.sector).toBe("Keuangan / Bank");
    expect(entity?.status).toBe("Board: Utama");
    expect(fetchFn.requests[0]?.url).toContain("code=BBCA");
  });

  test("lower-case tickers resolve and normalise", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    const entity = await resolveIdxCompany("tlkm", { fetchFn });
    expect(entity?.ticker).toBe("TLKM");
    expect(entity?.legalName).toBe("PT Telkom Indonesia (Persero) Tbk");
  });

  test("resolves by company name against the whole roster", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    const results = await searchIdxCompanies("Astra Agro Lestari", { fetchFn });
    expect(results[0]?.ticker).toBe("AALI");
    expect(results[0]?.legalName).toBe("Astra Agro Lestari Tbk");
    // A name query does not use the server-side ticker filter.
    expect(fetchFn.requests[0]?.url).toContain("code=");
    expect(fetchFn.requests[0]?.url).not.toContain("code=Astra");
  });

  test("an empty query never issues a request", async () => {
    const fetchFn = routedFetch([]);
    expect(await searchIdxCompanies("   ", { fetchFn })).toEqual([]);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("sends browser-class headers on the default fetch", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
    ]);
    await resolveIdxCompany("BBCA", { fetchFn });
    const headers = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(headers.Referer).toContain("idx.co.id");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });
});

describe("idxIndonesia announcements", () => {
  test("returns a date-windowed announcement feed with attachment links", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const filings = await searchIdxFilings({
      company: "BBCA",
      startDate: "2025-01-01",
      endDate: "2026-08-29",
    }, { fetchFn });

    expect(filings).toHaveLength(4);
    expect(filings[0]?.filedDate).toBe("2026-08-26");
    expect(filings[0]?.description).toBe(
      "General Announcement Public Expose - Annual",
    );
    expect(filings[0]?.form).toBe("Announcement (STOCK)");
    // The space-padded Kode_Emiten is trimmed.
    expect(filings[0]?.category).toBe("BBCA");
    expect(filings[0]?.accession).toBe("008/CSG-IVR/2026");
    expect(filings[0]?.sourceUrl).toContain(".pdf");
    expect(filings[0]?.sourceIdentifiers?.jurisdiction).toBe("ID");
    // Newest first.
    expect(filings.map((filing) => filing.filedDate)).toEqual([
      "2026-08-26",
      "2026-08-19",
      "2026-07-31",
      "2026-07-08",
    ]);
    // Dates go over the wire as YYYYMMDD, not ISO.
    const url = fetchFn.requests.find(({ url: u }) => u.includes("GetAnnouncement"))!.url;
    expect(url).toContain("dateFrom=20250101");
    expect(url).toContain("dateTo=20260829");
    expect(url).toContain("kodeEmiten=BBCA");
  });

  test("prefers the announcement letter over its lampiran annexes", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const filings = await searchIdxFilings("BBCA", { fetchFn });
    const corporateAction = filings.find(
      (filing) => filing.description === "Schedule of Corporate Action",
    );
    // The fixture lists the lamp2 annex FIRST; the letter must still win.
    expect(corporateAction?.sourceUrl).toContain("c3076472a8_e5ca870b61.pdf");
    expect(corporateAction?.sourceUrl).not.toContain("11548b9ab7");
  });

  test("honours the limit and forms filter", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const limited = await searchIdxFilings({ company: "BBCA", limit: 2 }, { fetchFn });
    expect(limited).toHaveLength(2);
    expect(
      fetchFn.requests.find(({ url }) => url.includes(IDX_ANNOUNCEMENT_URL))?.url,
    ).toContain("pageSize=2");

    resetRateLimiters();
    const fetchFn2 = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: ANNOUNCEMENTS },
    ]);
    const filtered = await searchIdxFilings(
      { company: "BBCA", forms: ["shareholder"] },
      { fetchFn: fetchFn2 },
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.description).toBe("Changes of controlling shareholder");
  });

  test("an empty feed degrades to no filings, not an error", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetAnnouncement", body: { ResultCount: 0, Replies: [] } },
    ]);
    expect(await searchIdxFilings("BBCA", { fetchFn })).toEqual([]);
  });
});

describe("idxIndonesia financials", () => {
  test("downloads and parses the issuer's XBRL instance", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const result = await getIdxFinancials(
      { company: "TLKM", year: 2024 },
      { fetchFn },
    );

    expect(result.entity.ticker).toBe("TLKM");
    expect(result.report?.reportYear).toBe("2024");
    expect(result.fallbackReason).toBeUndefined();
    const byConcept = new Map(
      result.facts
        .filter((fact) => fact.periodEnd === "2024-12-31")
        .map((fact) => [fact.concept, fact]),
    );
    expect(byConcept.get("revenues")?.value).toBe(149_967_000_000_000);
    expect(byConcept.get("total_assets")?.value).toBe(299_675_000_000_000);
    expect(byConcept.get("revenues")?.unit).toBe("IDR");
    expect(byConcept.get("revenues")?.basis).toBe("consolidated");
    expect(byConcept.get("revenues")?.filedDate).toBe("2025-04-18");
    expect(byConcept.get("revenues")?.form).toContain("2024");
    expect(byConcept.get("revenues")?.source).toBe("IDX");
    expect(byConcept.get("revenues")?.sourceUrl).toContain("instance.zip");
    expect(byConcept.get("revenues")?.sourceIdentifiers?.kodeEmiten).toBe("TLKM");

    // Bounded: roster + one report lookup + one instance download.
    expect(fetchFn.requests).toHaveLength(3);
    const reportUrl = fetchFn.requests[1]!.url;
    expect(reportUrl).toContain("year=2024");
    expect(reportUrl).toContain("periode=audit");
    expect(reportUrl).toContain("reportType=rdf");
  });

  test("falls back honestly when the submission has no XBRL instance", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: REPORT_NO_INSTANCE },
    ]);
    const result = await getIdxFinancials(
      { company: "AALI", year: 2024 },
      { fetchFn },
    );
    expect(result.facts).toEqual([]);
    expect(result.fallbackReason).toContain("no XBRL instance");
    // The official report link is offered instead of an invented figure.
    expect(result.fallbackUrl).toContain(".xlsx");
    // No download was attempted.
    expect(fetchFn.requests).toHaveLength(2);
  });

  test("falls back honestly when the instance tags no headline totals", async () => {
    const emptyInstance = makeIdxInstanceZip(
      '<?xml version="1.0"?><xbrl xmlns="http://www.xbrl.org/2003/instance"/>',
    );
    const fetchFn = routedFetch(financialsRoutes(REPORT_TLKM, emptyInstance));
    const result = await getIdxFinancials(
      { company: "TLKM", year: 2024 },
      { fetchFn },
    );
    expect(result.facts).toEqual([]);
    expect(result.fallbackReason).toContain("tags none of the headline totals");
    expect(result.fallbackUrl).toContain(".xlsx");
  });

  test("falls back honestly when the archive holds no instance document", async () => {
    const noInstance = makeStoredZipMulti([
      { name: "Taxonomy.xsd", content: "<xsd:schema/>" },
    ]);
    const fetchFn = routedFetch(financialsRoutes(REPORT_TLKM, noInstance));
    const result = await getIdxFinancials(
      { company: "TLKM", year: 2024 },
      { fetchFn },
    );
    expect(result.facts).toEqual([]);
    expect(result.fallbackReason).toContain("could not be read");
    expect(result.fallbackUrl).toBeDefined();
  });

  test("reports no submission at all without inventing one", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: { ResultCount: 0, Results: [] } },
    ]);
    const result = await getIdxFinancials(
      { company: "TLKM", year: 2024 },
      { fetchFn },
    );
    expect(result.facts).toEqual([]);
    expect(result.fallbackUrl).toBeUndefined();
    expect(result.report).toBeUndefined();
  });
});

describe("idxIndonesia blocked-host and failure paths", () => {
  test("a 403 challenge becomes an honest inject-a-fetchFn error", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "GetCompanyProfiles",
        status: 403,
        body: "<html><head><title>Attention Required!</title></head></html>",
      },
    ]);
    const error = await resolveIdxCompany("BBCA", { fetchFn }).catch((e) => e);
    expect(error).toBeInstanceOf(IdxBlockedError);
    expect((error as IdxBlockedError).status).toBe(403);
    expect((error as Error).message).toContain("browser-backed fetchFn");
    // The distinction that matters: this is NOT "the issuer has nothing".
    expect((error as Error).message).toContain("NOT an empty result");
  });

  test("a 503 edge refusal is treated as blocked, not as a data outage", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", status: 503, body: "Service Unavailable" },
    ]);
    const error = await resolveIdxCompany("BBCA", { fetchFn }).catch((e) => e);
    expect(error).toBeInstanceOf(IdxBlockedError);
    expect((error as IdxBlockedError).status).toBe(503);
  });

  test("a 200 challenge page (HTML where JSON was expected) is blocked too", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "GetCompanyProfiles",
        body: "<html>Attention Required! | Cloudflare</html>",
        headers: { "Content-Type": "text/html" },
      },
    ]);
    const error = await resolveIdxCompany("BBCA", { fetchFn }).catch((e) => e);
    expect(error).toBeInstanceOf(IdxBlockedError);
    expect((error as Error).message).toContain("browser-backed fetchFn");
  });

  test("a blocked instance download propagates rather than degrading to a link", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: PROFILES },
      { pattern: "GetFinancialReport", body: REPORT_TLKM },
      { pattern: "instance.zip", status: 403, body: "<html>blocked</html>" },
    ]);
    const error = await getIdxFinancials({ company: "TLKM", year: 2024 }, { fetchFn })
      .catch((e) => e);
    // A transport block must never masquerade as "this filing is unparseable".
    expect(error).toBeInstanceOf(IdxBlockedError);
  });

  test("a challenge shell served in place of the archive is blocked", async () => {
    const fetchFn = routedFetch(financialsRoutes(REPORT_TLKM, "<html>nope</html>"));
    const error = await getIdxFinancials({ company: "TLKM", year: 2024 }, { fetchFn })
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdxBlockedError);
  });

  test("a 429 becomes a typed rate-limit error", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", status: 429, body: "slow down" },
    ]);
    const error = await resolveIdxCompany("BBCA", { fetchFn }).catch((e) => e);
    expect(error).toBeInstanceOf(IdxRateLimitError);
  });

  test("a 500 upstream failure surfaces as-is", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", status: 500, body: "boom" },
    ]);
    const error = await resolveIdxCompany("BBCA", { fetchFn }).catch((e) => e);
    expect(error).not.toBeInstanceOf(IdxBlockedError);
    expect((error as Error).message).toContain("500");
  });

  test("an unresolvable company never reaches the report endpoint", async () => {
    const fetchFn = routedFetch([
      { pattern: "GetCompanyProfiles", body: { data: [] } },
    ]);
    const error = await searchIdxFilings("ZZZZ", { fetchFn }).catch((e) => e);
    expect((error as Error).message).toContain("No IDX company found");
    expect(fetchFn.requests).toHaveLength(1);
  });

  test("an archive with no XBRL document raises a typed API error", async () => {
    const noInstance = makeStoredZipMulti([
      { name: "Taxonomy.xsd", content: "<xsd:schema/>" },
    ]);
    const fetchFn = routedFetch([{ pattern: "instance.zip", body: noInstance }]);
    const error = await downloadIdxXbrlInstance(
      "https://www.idx.co.id/x/instance.zip",
      { fetchFn },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(IdxApiError);
  });

  test("the anti-bot note names the escape hatch by its option name", () => {
    expect(IDX_ANTIBOT_NOTE).toContain("fetchFn");
    expect(IDX_ANTIBOT_NOTE).toContain("AdapterOptions");
  });

  test("the roster endpoint is the documented one", () => {
    expect(IDX_PROFILES_URL).toBe(
      "https://www.idx.co.id/primary/ListedCompany/GetCompanyProfiles",
    );
  });
});
