import { beforeEach, describe, expect, test } from "bun:test";
import { TOOL_NAMES, createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetSecTickerCache } from "../src/adapters/secEdgar.js";
import { resetRateLimiters, secRateLimiter } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env, ToolResult } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

const ENV: Env = { DISCLOSURES_USER_AGENT: "Test test@example.com" };

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

beforeEach(() => {
  resetRateLimiters();
  resetSecTickerCache();
});

describe("createTools", () => {
  test("returns exactly the seven tools in TOOL_NAMES order", () => {
    const tools = createTools({ fetchFn: routedFetch([]), env: ENV });
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toHaveLength(7);
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
