import { beforeEach, describe, expect, test } from "bun:test";
import {
  SecConfigurationError,
  SecRateLimitError,
  getLatestSecReport,
  getSecDocumentPdf,
  getSecDocumentText,
  getSecFilingManifest,
  getSecFinancials,
  getSecInsiders,
  getSecOwners,
  getSecPrivateRaises,
  normalizeAccession,
  resetSecTickerCache,
  resolveCompanyCik,
  searchSecFilings,
} from "../src/adapters/secEdgar.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

const ENV: Env = { DISCLOSURES_USER_AGENT: "Test test@example.com" };

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
};

const tickersRoute: Route = { pattern: "company_tickers.json", body: TICKERS };

function options(
  fetchFn: ReturnType<typeof routedFetch>,
  env: Env = ENV,
): AdapterOptions {
  return { fetchFn, env };
}

interface SubmissionRowFixture {
  form: string;
  filed: string;
  accession: string;
  primaryDocument?: string;
  reportDate?: string;
  description?: string;
}

function submissionsFixture(rows: SubmissionRowFixture[]): unknown {
  return {
    cik: "320193",
    name: "Apple Inc.",
    filings: {
      recent: {
        accessionNumber: rows.map((row) => row.accession),
        filingDate: rows.map((row) => row.filed),
        reportDate: rows.map((row) => row.reportDate ?? ""),
        form: rows.map((row) => row.form),
        primaryDocument: rows.map((row) => row.primaryDocument ?? ""),
        primaryDocDescription: rows.map((row) => row.description ?? ""),
      },
    },
  };
}

function eftsFixture(hits: Array<{ id: string; source: Record<string, unknown> }>): unknown {
  return { hits: { hits: hits.map((hit) => ({ _id: hit.id, _source: hit.source })) } };
}

beforeEach(() => {
  resetRateLimiters();
  resetSecTickerCache();
});

describe("resolveCompanyCik", () => {
  test("bare digits pass through zero-padded without any network call", async () => {
    const fetchFn = routedFetch([]);
    expect(await resolveCompanyCik("320193", options(fetchFn))).toBe("0000320193");
    expect(await resolveCompanyCik("CIK 320193", options(fetchFn))).toBe("0000320193");
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("matches tickers case-insensitively from company_tickers.json", async () => {
    const fetchFn = routedFetch([tickersRoute]);
    expect(await resolveCompanyCik("aapl", options(fetchFn))).toBe("0000320193");
  });

  test("matches exact normalized company titles", async () => {
    const fetchFn = routedFetch([tickersRoute]);
    expect(await resolveCompanyCik("  APPLE   INC.  ", options(fetchFn))).toBe("0000320193");
  });

  test("falls back to browse-EDGAR Atom <CIK> tag", async () => {
    const fetchFn = routedFetch([
      tickersRoute,
      {
        pattern: "browse-edgar",
        body:
          '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
          "<company-info><cik>0001234567</cik>" +
          "<conformed-name>Some Startup Inc</conformed-name></company-info></feed>",
      },
    ]);
    expect(await resolveCompanyCik("Some Startup", options(fetchFn))).toBe("0001234567");
    const browseRequest = fetchFn.requests.find(({ url }) => url.includes("browse-edgar"));
    expect(browseRequest?.url).toContain("output=atom");
  });

  test("falls back to a plain-text CIK marker in the browse response", async () => {
    const fetchFn = routedFetch([
      tickersRoute,
      { pattern: "browse-edgar", body: "Results for CIK #0000456789 follow" },
    ]);
    expect(await resolveCompanyCik("Obscure Fund LP", options(fetchFn))).toBe("0000456789");
  });

  test("throws No SEC company found when every strategy misses", async () => {
    const fetchFn = routedFetch([
      tickersRoute,
      { pattern: "browse-edgar", body: "<feed><title>EDGAR Search Results</title></feed>" },
    ]);
    await expect(resolveCompanyCik("Zzyzx Widgets", options(fetchFn))).rejects.toThrow(
      /No SEC company found for Zzyzx Widgets/,
    );
  });
});

describe("SEC User-Agent handling", () => {
  test("DISCLOSURES_USER_AGENT wins over SEC_EDGAR_USER_AGENT and is sent", async () => {
    const fetchFn = routedFetch([tickersRoute]);
    await resolveCompanyCik("AAPL", options(fetchFn, {
      DISCLOSURES_USER_AGENT: "Test test@example.com",
      SEC_EDGAR_USER_AGENT: "Fallback fb@example.com",
    }));
    const headers = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Test test@example.com");
  });

  test("SEC_EDGAR_USER_AGENT is used when the primary variable is unset", async () => {
    const fetchFn = routedFetch([tickersRoute]);
    await resolveCompanyCik("AAPL", options(fetchFn, {
      SEC_EDGAR_USER_AGENT: "Fallback fb@example.com",
    }));
    const headers = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Fallback fb@example.com");
  });

  test("with neither variable set a SecConfigurationError explains the setup", async () => {
    const fetchFn = routedFetch([]);
    const promise = resolveCompanyCik("AAPL", options(fetchFn, {}));
    await expect(promise).rejects.toBeInstanceOf(SecConfigurationError);
    await expect(resolveCompanyCik("AAPL", options(fetchFn, {}))).rejects.toThrow(
      /Set DISCLOSURES_USER_AGENT or SEC_EDGAR_USER_AGENT/,
    );
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("SEC rate limiting", () => {
  test("the 31st request within the window throws SecRateLimitError", async () => {
    const fetchFn = routedFetch([{ pattern: "efts.sec.gov", body: eftsFixture([]) }]);
    const opts = options(fetchFn);
    for (let index = 0; index < 30; index += 1) {
      expect(await searchSecFilings({ query: "apple" }, opts)).toEqual([]);
    }
    await expect(searchSecFilings({ query: "apple" }, opts)).rejects.toBeInstanceOf(
      SecRateLimitError,
    );
    await expect(searchSecFilings({ query: "apple" }, opts)).rejects.toThrow(
      /30 requests per minute/,
    );
    expect(fetchFn.requests).toHaveLength(30);
  });
});

describe("searchSecFilings", () => {
  test("builds direct archive links, sorts date-desc, and sends a custom date range", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "efts.sec.gov",
        body: eftsFixture([
          {
            id: "0000320193-23-000106:aapl-20230930.htm",
            source: {
              form: "10-K",
              file_date: "2023-11-03",
              adsh: "0000320193-23-000106",
              ciks: ["0000320193"],
              display_names: ["Apple Inc.  (AAPL)  (CIK 0000320193)"],
            },
          },
          {
            id: "0000320193-24-000123:aapl-20240928.htm",
            source: {
              form: "10-K",
              file_date: "2024-11-01",
              adsh: "0000320193-24-000123",
              ciks: ["0000320193"],
              display_names: ["Apple Inc.  (AAPL)  (CIK 0000320193)"],
            },
          },
        ]),
      },
    ]);
    const filings = await searchSecFilings({ cik: "320193", forms: ["10-K"] }, options(fetchFn));
    expect(filings.map((filing) => filing.filedDate)).toEqual(["2024-11-01", "2023-11-03"]);
    expect(filings[0]?.sourceUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
    );
    expect(filings[0]?.accession).toBe("0000320193-24-000123");
    expect(filings[0]?.description).toContain("Apple Inc.");
    const requestUrl = fetchFn.requests[0]?.url ?? "";
    expect(requestUrl).toContain("dateRange=custom");
    expect(requestUrl).toMatch(/startdt=\d{4}-\d{2}-\d{2}/);
    expect(requestUrl).toMatch(/enddt=\d{4}-\d{2}-\d{2}/);
  });
});

describe("getLatestSecReport", () => {
  test("picks the most recently filed 10-K and returns section links", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "data.sec.gov/submissions/CIK0000320193.json",
        body: submissionsFixture([
          {
            form: "10-K",
            filed: "2023-11-03",
            accession: "0000320193-23-000106",
            primaryDocument: "aapl-20230930.htm",
            reportDate: "2023-09-30",
            description: "10-K",
          },
          {
            form: "10-K",
            filed: "2024-11-01",
            accession: "0000320193-24-000123",
            primaryDocument: "aapl-20240928.htm",
            reportDate: "2024-09-28",
            description: "10-K",
          },
          {
            form: "10-Q",
            filed: "2024-08-02",
            accession: "0000320193-24-000081",
            primaryDocument: "aapl-20240629.htm",
            reportDate: "2024-06-29",
            description: "10-Q",
          },
        ]),
      },
    ]);
    const report = await getLatestSecReport("320193", "annual", options(fetchFn));
    expect(report).not.toBeNull();
    expect(report?.form).toBe("10-K");
    expect(report?.filedDate).toBe("2024-11-01");
    expect(report?.accession).toBe("0000320193-24-000123");
    expect(report?.reportKind).toBe("annual");
    expect(report?.sectionLinks[0]).toEqual({
      section: "primary-document",
      description: "10-K",
      url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
    });
    expect(report?.sectionLinks[1]?.section).toBe("filing-index");
    expect(report?.sectionLinks[1]?.url).toContain("0000320193-24-000123-index.html");
  });
});

describe("getSecInsiders", () => {
  const FORM4_XML =
    "<ownershipDocument><reportingOwner><reportingOwnerId>" +
    "<rptOwnerCik>0001214156</rptOwnerCik><rptOwnerName>COOK TIMOTHY D</rptOwnerName>" +
    "</reportingOwnerId><reportingOwnerRelationship>" +
    "<isDirector>1</isDirector><isOfficer>1</isOfficer>" +
    "<officerTitle>Chief Executive Officer</officerTitle>" +
    "<isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther>" +
    "</reportingOwnerRelationship></reportingOwner></ownershipDocument>";

  const FORM3_XML =
    "<ownershipDocument><reportingOwner><reportingOwnerId>" +
    "<rptOwnerCik>1214156</rptOwnerCik><rptOwnerName>Timothy D. Cook</rptOwnerName>" +
    "</reportingOwnerId><reportingOwnerRelationship>" +
    "<isDirector>false</isDirector><isOfficer>true</isOfficer>" +
    "<officerTitle>Chief Executive Officer</officerTitle>" +
    "<isTenPercentOwner>true</isTenPercentOwner>" +
    "</reportingOwnerRelationship></reportingOwner></ownershipDocument>";

  test("fetches raw XML (xsl prefix stripped) and merges roles by owner CIK", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "data.sec.gov/submissions",
        body: submissionsFixture([
          { form: "8-K", filed: "2024-05-01", accession: "0000320193-24-000050", primaryDocument: "ev.htm" },
          {
            form: "4",
            filed: "2024-04-15",
            accession: "0000320193-24-000040",
            primaryDocument: "xslF345X06/wk-form4_1.xml",
          },
          {
            form: "3",
            filed: "2024-03-01",
            accession: "0000320193-24-000030",
            primaryDocument: "xslF345X05/wk-form3_1.xml",
          },
        ]),
      },
      { pattern: "wk-form4_1.xml", body: FORM4_XML },
      { pattern: "wk-form3_1.xml", body: FORM3_XML },
    ]);
    const insiders = await getSecInsiders("320193", options(fetchFn));

    const documentRequests = fetchFn.requests.filter(({ url }) => url.includes("Archives"));
    expect(documentRequests).toHaveLength(2);
    for (const { url } of documentRequests) {
      expect(url).not.toMatch(/xsl/i);
    }
    expect(documentRequests[0]?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000040/wk-form4_1.xml",
    );

    expect(insiders).toHaveLength(1);
    const insider = insiders[0];
    expect(insider?.name).toBe("COOK TIMOTHY D");
    expect(insider?.ownerCik).toBe("0001214156");
    expect(insider?.roles).toEqual([
      "Director",
      "Officer: Chief Executive Officer",
      "10% Owner",
    ]);
    expect(insider?.form).toBe("4");
    expect(insider?.filedDate).toBe("2024-04-15");
  });

  test("caps document fetches at 12", async () => {
    const rows: SubmissionRowFixture[] = Array.from({ length: 14 }, (_, index) => ({
      form: "4",
      filed: `2024-01-${String(14 - index).padStart(2, "0")}`,
      accession: `0000320193-24-${String(index + 1).padStart(6, "0")}`,
      primaryDocument: `xslF345X06/form4-${index + 1}.xml`,
    }));
    const fetchFn = routedFetch([
      { pattern: "data.sec.gov/submissions", body: submissionsFixture(rows) },
      { pattern: /form4-\d+\.xml/, body: FORM4_XML },
    ]);
    await getSecInsiders("320193", options(fetchFn));
    const documentRequests = fetchFn.requests.filter(({ url }) => url.includes("Archives"));
    expect(documentRequests).toHaveLength(12);
  });

  test("skips unfetchable documents instead of failing", async () => {
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
          {
            form: "4",
            filed: "2024-02-15",
            accession: "0000320193-24-000020",
            primaryDocument: "xslF345X06/broken.xml",
          },
        ]),
      },
      { pattern: "wk-form4_1.xml", body: FORM4_XML },
      { pattern: "broken.xml", body: "gone", status: 404 },
    ]);
    const insiders = await getSecInsiders("320193", options(fetchFn));
    expect(insiders).toHaveLength(1);
    expect(insiders[0]?.name).toBe("COOK TIMOTHY D");
  });
});

describe("getSecOwners", () => {
  test("excludes the subject, dedupes owners by CIK, and re-sorts by filing date", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "efts.sec.gov",
        body: eftsFixture([
          // Older filing first: EFTS returns relevance order, adapter must re-sort.
          {
            id: "0000315066-23-000010:filing13g.htm",
            source: {
              form: "SC 13G",
              file_date: "2023-02-10",
              adsh: "0000315066-23-000010",
              ciks: ["0000320193", "0000315066"],
              display_names: [
                "Apple Inc.  (AAPL)  (CIK 0000320193)",
                "FMR CORP  (CIK 0000315066)",
              ],
            },
          },
          {
            id: "0000102909-24-000020:filing13ga.htm",
            source: {
              form: "SC 13G/A",
              file_date: "2024-02-12",
              adsh: "0000102909-24-000020",
              ciks: ["0000320193", "0000102909", "0000315066"],
              display_names: [
                "Apple Inc.  (AAPL)  (CIK 0000320193)",
                "VANGUARD GROUP INC  (CIK 0000102909)",
                "FMR CORP  (CIK 0000315066)",
              ],
            },
          },
        ]),
      },
    ]);
    const owners = await getSecOwners("320193", options(fetchFn));
    expect(fetchFn.requests[0]?.url).toContain("forms=SC+13D%2CSC+13G");

    expect(owners).toHaveLength(2);
    expect(owners.map((owner) => owner.holderName)).toEqual(["VANGUARD GROUP INC", "FMR CORP"]);
    // Duplicate FMR appearance keeps the newest filing thanks to the re-sort.
    expect(owners[1]?.filedDate).toBe("2024-02-12");
    expect(owners[1]?.form).toBe("SC 13G/A");
    for (const owner of owners) {
      expect(owner.thresholdRegime).toContain("5%");
      expect(owner.holderName).not.toContain("Apple");
      expect(owner.holderName).not.toContain("CIK");
    }
  });
});

describe("getSecFinancials", () => {
  const conceptRoute = (tag: string, body: unknown, status = 200): Route => ({
    pattern: `us-gaap/${tag}.json`,
    body,
    status,
  });

  test("merges history across tags, keeps latest restatement, drops short-duration stubs", async () => {
    const fetchFn = routedFetch([
      conceptRoute("RevenueFromContractWithCustomerExcludingAssessedTax", {
        tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
        label: "Revenue from contracts with customers",
        units: {
          USD: [
            {
              start: "2022-09-25",
              end: "2023-09-30",
              val: 383_285_000_000,
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
              accn: "0000320193-23-000106",
            },
            {
              // ~90-day FY-tagged stub: must be dropped by the duration guard.
              start: "2023-10-01",
              end: "2023-12-30",
              val: 119_575_000_000,
              fy: 2024,
              fp: "FY",
              form: "10-K",
              filed: "2024-02-02",
              accn: "0000320193-24-000006",
            },
          ],
        },
      }),
      conceptRoute("Revenues", {
        tag: "Revenues",
        label: "Revenues",
        units: {
          USD: [
            {
              start: "2017-10-01",
              end: "2018-09-29",
              val: 265_595_000_000,
              fy: 2018,
              fp: "FY",
              form: "10-K",
              filed: "2018-11-05",
              accn: "0000320193-18-000145",
            },
            {
              // Restatement for the same period end, filed later: must win.
              start: "2017-10-01",
              end: "2018-09-29",
              val: 265_600_000_000,
              fy: 2018,
              fp: "FY",
              form: "10-K/A",
              filed: "2019-01-15",
              accn: "0000320193-19-000010",
            },
          ],
        },
      }),
      conceptRoute("SalesRevenueNet", "not found", 404),
    ]);
    const facts = await getSecFinancials("320193", ["revenue"], options(fetchFn));
    expect(facts.map((fact) => fact.periodEnd)).toEqual(["2023-09-30", "2018-09-29"]);
    expect(facts.every((fact) => fact.concept === "revenue" && fact.label === "Revenue")).toBe(true);
    expect(facts[0]?.value).toBe(383_285_000_000);
    expect(facts[1]?.value).toBe(265_600_000_000);
    expect(facts[1]?.form).toBe("10-K/A");
    // All three candidate revenue tags were tried, including the 404 one.
    expect(fetchFn.requests.filter(({ url }) => url.includes("companyconcept"))).toHaveLength(3);
  });

  test("instant balance-sheet facts without a start date pass the guard", async () => {
    const fetchFn = routedFetch([
      conceptRoute("Assets", {
        tag: "Assets",
        label: "Total assets",
        units: {
          USD: [
            {
              end: "2023-09-30",
              val: 352_583_000_000,
              fy: 2023,
              fp: "FY",
              form: "10-K",
              filed: "2023-11-03",
              accn: "0000320193-23-000106",
            },
          ],
        },
      }),
    ]);
    const facts = await getSecFinancials("320193", ["total_assets"], options(fetchFn));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe(352_583_000_000);
    expect(facts[0]?.unit).toBe("USD");
  });

  test("unknown concept names throw with the list of available concepts", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      getSecFinancials("320193", ["bogus_concept"], options(fetchFn)),
    ).rejects.toThrow(/Unknown financial concept\(s\): bogus_concept.*Available: .*revenue.*net_income/);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("404 tags are skipped silently", async () => {
    const fetchFn = routedFetch([
      conceptRoute("GrossProfit", "not found", 404),
    ]);
    expect(await getSecFinancials("320193", ["gross_profit"], options(fetchFn))).toEqual([]);
  });
});

describe("getSecPrivateRaises", () => {
  const FORM_D_XML = loadFixture("sec", "form-d-stripe.xml");

  test("parses Form D offering data and related persons", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "data.sec.gov/submissions",
        body: submissionsFixture([
          {
            form: "D",
            filed: "2021-06-15",
            accession: "0001628280-21-000123",
            primaryDocument: "primary_doc.xml",
          },
          { form: "8-K", filed: "2021-05-01", accession: "0001628280-21-000100", primaryDocument: "x.htm" },
        ]),
      },
      { pattern: "primary_doc.xml", body: FORM_D_XML },
    ]);
    const raises = await getSecPrivateRaises("320193", options(fetchFn));
    expect(raises).toHaveLength(1);
    const raise = raises[0];
    expect(raise?.form).toBe("D");
    expect(raise?.issuerName).toBe("Stripe, Inc.");
    expect(raise?.entityType).toBe("Corporation");
    expect(raise?.industry).toBe("Other Technology");
    expect(raise?.totalOfferingAmount).toBe("Indefinite");
    expect(raise?.totalAmountSold).toBe("600000000");
    expect(raise?.investorCount).toBe("58");
    expect(raise?.dateOfFirstSale).toBe("2021-05-14");
    expect(raise?.relatedPersons).toEqual([
      { name: "Patrick Collison", relationships: ["Executive Officer", "Director"] },
      // Entity persons use firstName "N/A" in Form D; the placeholder is dropped.
      { name: "Sequoia Capital Operations LLC", relationships: ["Promoter"] },
    ]);
    expect(raise?.sourceUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000162828021000123/primary_doc.xml",
    );
  });
});

const ACCESSION = "0000320193-25-000079";
const ACCESSION_NODASH = "000032019325000079";

function manifestFixture(
  items: Array<{ name: string; size?: string; lastModified?: string }>,
): unknown {
  return {
    directory: {
      name: `/Archives/edgar/data/320193/${ACCESSION_NODASH}`,
      item: items.map((item) => ({
        name: item.name,
        type: "text.gif",
        size: item.size ?? "",
        "last-modified": item.lastModified ?? "",
      })),
    },
  };
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

describe("normalizeAccession", () => {
  test("accepts both dashed and run-together forms", () => {
    expect(normalizeAccession("0000320193-25-000079")).toBe(ACCESSION);
    expect(normalizeAccession("000032019325000079")).toBe(ACCESSION);
  });

  test("rejects anything that is not 18 digits", () => {
    expect(() => normalizeAccession("123")).toThrow(/18 digits/);
  });
});

describe("getSecFilingManifest", () => {
  test("lists documents and takes the primary document from submissions", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "submissions/CIK0000320193.json",
        body: submissionsFixture([
          {
            form: "10-K",
            filed: "2025-10-31",
            accession: ACCESSION,
            primaryDocument: "aapl-20250927.htm",
            reportDate: "2025-09-27",
            description: "Form 10-K",
          },
        ]),
      },
      {
        pattern: `${ACCESSION_NODASH}/index.json`,
        body: manifestFixture([
          { name: `${ACCESSION}-index.html` },
          { name: "aapl-20250927.htm", size: "1520208", lastModified: "2025-10-31 06:01:26" },
          { name: "exhibit21.htm", size: "11807" },
        ]),
      },
    ]);
    const manifest = await getSecFilingManifest("320193", ACCESSION_NODASH, options(fetchFn));
    expect(manifest.accession).toBe(ACCESSION);
    expect(manifest.cik).toBe("320193");
    expect(manifest.form).toBe("10-K");
    expect(manifest.reportDate).toBe("2025-09-27");
    expect(manifest.primaryDocument).toBe("aapl-20250927.htm");
    expect(manifest.documents.map((doc) => doc.name)).toContain("exhibit21.htm");
    expect(manifest.documents.find((doc) => doc.name === "aapl-20250927.htm")?.sizeBytes).toBe(
      1520208,
    );
    expect(manifest.indexUrl).toContain(`${ACCESSION}-index.html`);
  });

  test("falls back to the largest inline .htm when submissions lack the filing", async () => {
    const fetchFn = routedFetch([
      { pattern: "submissions/CIK0000320193.json", body: submissionsFixture([]) },
      {
        pattern: `${ACCESSION_NODASH}/index.json`,
        body: manifestFixture([
          { name: `${ACCESSION}-index.html`, size: "5000" },
          { name: "small.htm", size: "2000" },
          { name: "primary-big.htm", size: "900000" },
        ]),
      },
    ]);
    const manifest = await getSecFilingManifest("320193", ACCESSION, options(fetchFn));
    expect(manifest.primaryDocument).toBe("primary-big.htm");
    expect(manifest.form).toBeUndefined();
  });
});

describe("getSecDocumentText", () => {
  test("fetches the primary document and strips markup, comments, style, and script", async () => {
    // Note the whitespace before `>` in the end tags — the HTML spec permits it,
    // and the strip regex must handle it or script/style text leaks through.
    const html =
      "<?xml version='1.0'?><!--XBRL comment--><html><head><style>.x{color:red}</style >" +
      "<script>var a=1;</script ></head><body><span>Net sales 391,035</span></body></html>";
    const manifest = await getSecFilingManifest("320193", ACCESSION, {
      fetchFn: routedFetch([
        {
          pattern: "submissions/CIK0000320193.json",
          body: submissionsFixture([
            { form: "10-K", filed: "2025-10-31", accession: ACCESSION, primaryDocument: "aapl.htm" },
          ]),
        },
        { pattern: `${ACCESSION_NODASH}/index.json`, body: manifestFixture([{ name: "aapl.htm" }]) },
      ]),
      env: ENV,
    });
    const fetchFn = routedFetch([{ pattern: "aapl.htm", body: html }]);
    const text = await getSecDocumentText(manifest, options(fetchFn));
    expect(text?.text).toBe("Net sales 391,035");
    expect(text?.text).not.toContain("color:red");
    expect(text?.text).not.toContain("var a=1");
    expect(text?.documentName).toBe("aapl.htm");
  });

  test("returns null when the only primary document is a bare full-submission .txt", async () => {
    const manifest = await getSecFilingManifest("320193", ACCESSION, {
      fetchFn: routedFetch([
        {
          pattern: "submissions/CIK0000320193.json",
          body: submissionsFixture([
            { form: "10-K", filed: "1997-12-05", accession: ACCESSION, primaryDocument: `${ACCESSION}.txt` },
          ]),
        },
        {
          pattern: `${ACCESSION_NODASH}/index.json`,
          body: manifestFixture([{ name: `${ACCESSION}.txt` }]),
        },
      ]),
      env: ENV,
    });
    const fetchFn = routedFetch([]); // no content fetch should happen
    const text = await getSecDocumentText(manifest, options(fetchFn));
    expect(text).toBeNull();
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("getSecDocumentPdf", () => {
  async function manifestWith(items: Array<{ name: string; size?: string }>) {
    return getSecFilingManifest("320193", ACCESSION, {
      fetchFn: routedFetch([
        { pattern: "submissions/CIK0000320193.json", body: submissionsFixture([]) },
        { pattern: `${ACCESSION_NODASH}/index.json`, body: manifestFixture(items) },
      ]),
      env: ENV,
    });
  }

  test("downloads a PDF exhibit and counts its pages", async () => {
    const manifest = await manifestWith([
      { name: "primary.htm", size: "1000" },
      { name: "exhibit99.pdf", size: "2048" },
    ]);
    const pdfBytes = latin1("%PDF-1.4\n/Type /Page\n/Type /Page\n%%EOF");
    const fetchFn = routedFetch([{ pattern: "exhibit99.pdf", body: pdfBytes }]);
    const pdf = await getSecDocumentPdf(manifest, options(fetchFn));
    expect(pdf?.documentName).toBe("exhibit99.pdf");
    expect(pdf?.pageCount).toBe(2);
    expect(pdf?.byteLength).toBe(pdfBytes.byteLength);
    expect(pdf?.suggestedFilename).toBe("exhibit99.pdf");
  });

  test("returns null when the filing has no PDF rendition", async () => {
    const manifest = await manifestWith([{ name: "primary.htm", size: "1000" }]);
    const fetchFn = routedFetch([]);
    const pdf = await getSecDocumentPdf(manifest, options(fetchFn));
    expect(pdf).toBeNull();
    expect(fetchFn.requests).toHaveLength(0);
  });
});
