import { beforeEach, describe, expect, test } from "bun:test";
import {
  ESEF_FINANCIAL_CONCEPT_NAMES,
  getEsefFilings,
  getEsefFinancials,
  resolveEsefIssuer,
  XbrlFilingsRateLimitError,
} from "../src/adapters/xbrlFilings.js";
import { resetRateLimiters, xbrlFilingsRateLimiter } from "../src/core/rateLimiter.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

// A real UK ESEF filer's LEI (Kainos Group PLC) — 18 alphanumerics + 2 digits,
// so it passes isLei and the fixtures read like production data.
const LEI = "213800H2PQMIF3OVZY47";

// --- JSON:API filings-list fixtures -----------------------------------------

interface FilingSpec {
  periodEnd: string;
  country?: string;
  jsonPath: string;
  dateAdded?: string;
}

function filingResource(spec: FilingSpec, index: number): Record<string, unknown> {
  return {
    type: "filing",
    id: String(index),
    attributes: {
      fxo_id: `${LEI}-${spec.periodEnd}`,
      country: spec.country ?? "GB",
      period_end: spec.periodEnd,
      json_url: spec.jsonPath,
      viewer_url: `/view/${spec.periodEnd}/`,
      package_url: `/pkg/${spec.periodEnd}.zip`,
      report_url: `/report/${spec.periodEnd}/`,
      date_added: spec.dateAdded ?? `${spec.periodEnd}T09:00:00Z`,
    },
    relationships: { entity: { data: { type: "entity", id: "ent-1" } } },
  };
}

function filingsResponse(specs: FilingSpec[]): Record<string, unknown> {
  return {
    data: specs.map(filingResource),
    included: [
      {
        type: "entity",
        id: "ent-1",
        attributes: { identifier: LEI, name: "KAINOS GROUP PLC" },
      },
    ],
  };
}

// --- xBRL-JSON (OIM) report fixtures ----------------------------------------

interface FactSpec {
  concept: string; // local name, e.g. "Revenue"
  period: string; // OIM period string (duration "start/end" or instant)
  value: number;
  unit?: string; // OIM unit QName, e.g. "iso4217:GBP"
  extraDim?: string; // an extra (non-core) dimension key → dimensional breakdown
}

function report(facts: FactSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  facts.forEach((fact, index) => {
    const dimensions: Record<string, string> = {
      concept: `ifrs-full:${fact.concept}`,
      entity: `lei:${LEI}`,
      period: fact.period,
      unit: fact.unit ?? "iso4217:GBP",
      language: "en",
    };
    if (fact.extraDim) dimensions[fact.extraDim] = "ifrs-full:SomeMember";
    out[`f${index}`] = { value: fact.value, dimensions };
  });
  return { documentInfo: { documentType: "xbrl-json" }, facts: out };
}

// OIM encodes a date-based period end as the following day at midnight, so a
// year ended / balance sheet as at 31 March 2025 is "...2025-04-01T00:00:00".
const FY2025_DURATION = "2024-04-01T00:00:00/2025-04-01T00:00:00";
const FY2024_DURATION = "2023-04-01T00:00:00/2024-04-01T00:00:00";
const FY2023_DURATION = "2022-04-01T00:00:00/2023-04-01T00:00:00";
const FY2025_INSTANT = "2025-04-01T00:00:00";
const H1_2025_DURATION = "2024-04-01T00:00:00/2024-10-01T00:00:00"; // ~183 days

// Newest report (FY2025 file): current year + a restated FY2024 comparative,
// plus an interim and a dimensional fact that must both be filtered out.
const REPORT_A = report([
  { concept: "Revenue", period: FY2025_DURATION, value: 367_246_000 },
  { concept: "Revenue", period: FY2024_DURATION, value: 382_393_000 }, // restated
  { concept: "ProfitLoss", period: FY2025_DURATION, value: 35_560_000 },
  // Lower-priority net-income tag for the same period — must lose to ProfitLoss.
  {
    concept: "ProfitLossAttributableToOwnersOfParent",
    period: FY2025_DURATION,
    value: 30_000_000,
  },
  { concept: "Assets", period: FY2025_INSTANT, value: 267_058_000 },
  // Interim (half-year) revenue — not an annual period, must be skipped.
  { concept: "Revenue", period: H1_2025_DURATION, value: 180_000_000 },
  // Segment breakdown carrying an extra dimension — must be skipped.
  {
    concept: "Revenue",
    period: FY2025_DURATION,
    value: 99_000_000,
    extraDim: "ifrs-full:OperatingSegmentsAxis",
  },
]);

// Older report (FY2024 file): an *original* (pre-restatement) FY2024 figure that
// must lose to REPORT_A's newer restated value, plus a unique FY2023 figure.
const REPORT_B = report([
  { concept: "Revenue", period: FY2024_DURATION, value: 380_000_000 }, // original
  { concept: "Revenue", period: FY2023_DURATION, value: 374_807_000 },
]);

const TWO_FILINGS: FilingSpec[] = [
  { periodEnd: "2024-03-31", jsonPath: "/reportB.json", dateAdded: "2024-08-28T00:00:00Z" },
  { periodEnd: "2025-03-31", jsonPath: "/reportA.json", dateAdded: "2025-08-21T00:00:00Z" },
];

function financialsRoutes(): Route[] {
  return [
    { pattern: `filter%5Bentity.identifier%5D=${LEI}`, body: filingsResponse(TWO_FILINGS) },
    { pattern: "/reportA.json", body: REPORT_A },
    { pattern: "/reportB.json", body: REPORT_B },
  ];
}

beforeEach(() => {
  resetRateLimiters();
});

describe("resolveEsefIssuer", () => {
  test("a bare LEI resolves directly with no network call", async () => {
    const fetchFn = routedFetch([]);
    const issuer = await resolveEsefIssuer(`  ${LEI.toLowerCase()}  `, { fetchFn });
    expect(issuer).toEqual({ lei: LEI });
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("a legal name resolves through GLEIF to the issuer's LEI", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Bentity.legalName%5D",
        body: {
          data: [
            {
              type: "lei-records",
              id: LEI,
              attributes: {
                lei: LEI,
                entity: {
                  legalName: { name: "KAINOS GROUP PLC", language: "en" },
                  otherNames: [],
                  transliteratedOtherNames: [],
                  jurisdiction: "GB",
                  status: "ACTIVE",
                },
                registration: { status: "ISSUED" },
              },
              relationships: {},
              links: {},
            },
          ],
          meta: { pagination: { currentPage: 1, perPage: 100, total: 1 } },
          links: {},
        },
      },
    ]);
    const issuer = await resolveEsefIssuer("Kainos Group PLC", { fetchFn });
    expect(issuer?.lei).toBe(LEI);
    expect(issuer?.name).toBe("KAINOS GROUP PLC");
  });

  test("an unresolvable name returns null", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Bentity.legalName%5D",
        body: { data: [], meta: { pagination: { total: 0 } }, links: {} },
      },
    ]);
    expect(await resolveEsefIssuer("No Such Company Ltd", { fetchFn })).toBeNull();
  });
});

describe("getEsefFilings", () => {
  test("parses and sorts filings newest reporting period first", async () => {
    const fetchFn = routedFetch([
      { pattern: `filter%5Bentity.identifier%5D=${LEI}`, body: filingsResponse(TWO_FILINGS) },
    ]);
    const filings = await getEsefFilings(LEI, { fetchFn });
    expect(filings.map((f) => f.periodEnd)).toEqual(["2025-03-31", "2024-03-31"]);
    expect(filings[0]?.entityName).toBe("KAINOS GROUP PLC");
    expect(filings[0]?.country).toBe("GB");
    expect(filings[0]?.lei).toBe(LEI);
    // Relative paths are absolutized against the API base.
    expect(filings[0]?.jsonUrl).toBe("https://filings.xbrl.org/reportA.json");
    expect(filings[0]?.viewerUrl).toBe("https://filings.xbrl.org/view/2025-03-31/");
    expect(filings[0]?.dateAdded).toBe("2025-08-21");
  });

  test("a non-LEI input returns [] without any network call", async () => {
    const fetchFn = routedFetch([]);
    expect(await getEsefFilings("AAPL", { fetchFn })).toEqual([]);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("getEsefFinancials", () => {
  test("extracts annual facts, rolls the period end back to the inclusive date", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const facts = await getEsefFinancials(LEI, ["revenue"], { fetchFn }, 3);
    const revenue = facts.filter((f) => f.concept === "revenue");
    // Newest period first; midnight end instants normalized to 31 March.
    expect(revenue.map((f) => [f.periodEnd, f.value])).toEqual([
      ["2025-03-31", 367_246_000],
      ["2024-03-31", 382_393_000],
      ["2023-03-31", 374_807_000],
    ]);
    const first = revenue[0];
    expect(first?.unit).toBe("GBP");
    expect(first?.source).toBe("filings.xbrl.org");
    expect(first?.form).toBe("ESEF (GB)");
    expect(first?.label).toBe("Revenue");
    expect(first?.filedDate).toBe("2025-08-21");
    expect(first?.sourceUrl).toBe("https://filings.xbrl.org/view/2025-03-31/");
  });

  test("a later report's restatement supersedes the earlier filed figure", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const facts = await getEsefFinancials(LEI, ["revenue"], { fetchFn }, 3);
    const fy2024 = facts.find((f) => f.concept === "revenue" && f.periodEnd === "2024-03-31");
    // 382,393,000 (restated, REPORT_A) wins over 380,000,000 (original, REPORT_B).
    expect(fy2024?.value).toBe(382_393_000);
  });

  test("balance-sheet instants normalize to the same inclusive date", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const facts = await getEsefFinancials(LEI, ["total_assets"], { fetchFn }, 3);
    const assets = facts.find((f) => f.concept === "total_assets");
    expect(assets?.periodEnd).toBe("2025-03-31");
    expect(assets?.value).toBe(267_058_000);
  });

  test("the higher-priority IFRS tag wins within a report", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const facts = await getEsefFinancials(LEI, ["net_income"], { fetchFn }, 3);
    const ni = facts.find((f) => f.concept === "net_income" && f.periodEnd === "2025-03-31");
    // ProfitLoss (35,560,000) preferred over ProfitLossAttributableToOwnersOfParent.
    expect(ni?.value).toBe(35_560_000);
  });

  test("interim durations and dimensional breakdowns are excluded", async () => {
    const fetchFn = routedFetch(financialsRoutes());
    const facts = await getEsefFinancials(LEI, ["revenue"], { fetchFn }, 3);
    // The ~183-day interim (180,000,000) and the segment breakdown (99,000,000)
    // must never appear as reported annual totals.
    const values = facts.map((f) => f.value);
    expect(values).not.toContain(180_000_000);
    expect(values).not.toContain(99_000_000);
  });

  test("an unresolvable issuer yields no facts and no report fetches", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "filter%5Bentity.legalName%5D",
        body: { data: [], meta: { pagination: { total: 0 } }, links: {} },
      },
    ]);
    expect(await getEsefFinancials("No Such Company", ESEF_FINANCIAL_CONCEPT_NAMES, { fetchFn })).toEqual([]);
  });
});

describe("filings.xbrl.org rate limiting", () => {
  test("a depleted budget raises XbrlFilingsRateLimitError", async () => {
    for (let index = 0; index < 120; index += 1) xbrlFilingsRateLimiter.tryAcquire();
    const fetchFn = routedFetch(financialsRoutes());
    await expect(getEsefFilings(LEI, { fetchFn })).rejects.toBeInstanceOf(XbrlFilingsRateLimitError);
    // Nothing reached the network — the guard tripped before fetch.
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("resetRateLimiters clears the filings.xbrl.org budget", async () => {
    for (let index = 0; index < 120; index += 1) xbrlFilingsRateLimiter.tryAcquire();
    expect(xbrlFilingsRateLimiter.canAcquire()).toBe(false);
    resetRateLimiters();
    expect(xbrlFilingsRateLimiter.canAcquire()).toBe(true);
  });
});
