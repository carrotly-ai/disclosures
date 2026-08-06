import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
  CompaniesHouseConfigurationError,
  CompaniesHouseRateLimitError,
  deriveCompaniesHousePercentageBand,
  formatIdentityVerification,
  getCompaniesHouseOfficers,
  getCompaniesHouseOwners,
  getCompaniesHousePscStatements,
  getCompaniesHousePscs,
  getLatestCompaniesHouseReport,
  normalizeCompanyNumber,
  parseCompaniesHouseProfile,
  resolveCompaniesHouseCompany,
  searchCompaniesHouseCompanies,
  searchCompaniesHouseFilings,
} from "../src/adapters/companiesHouse.js";
import {
  companiesHouseRateLimiter,
  resetRateLimiters,
} from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env } from "../src/core/types.js";
import { routedFetch } from "./helpers/routedFetch.js";

const ENV: Env = { COMPANIES_HOUSE_API_KEY: "test-api-key" };
const COMPANY_NUMBER = "01234567";

function options(
  fetchFn: ReturnType<typeof routedFetch>,
  env: Env = ENV,
): AdapterOptions {
  return { fetchFn, env };
}

function profile(
  companyNumber = COMPANY_NUMBER,
  name = "EXAMPLE HOLDINGS LIMITED",
): Record<string, unknown> {
  return {
    company_number: companyNumber,
    company_name: name,
    company_status: "active",
    jurisdiction: "england-wales",
    previous_company_names: [
      {
        name: "EXAMPLE GROUP LIMITED",
        effective_from: "2015-01-01",
        ceased_on: "2020-01-01",
      },
    ],
    links: { self: `/company/${companyNumber}` },
  };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("Companies House configuration and authentication", () => {
  test("sends the API key as Basic auth username with a blank password", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}`, body: profile() },
    ]);
    await resolveCompaniesHouseCompany(COMPANY_NUMBER, options(fetchFn));
    const headers = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("test-api-key:")}`);
    expect(headers.Accept).toBe("application/json");
  });

  test("throws a configuration error before making a request", async () => {
    const fetchFn = routedFetch([]);
    await expect(
      resolveCompaniesHouseCompany(COMPANY_NUMBER, options(fetchFn, {})),
    ).rejects.toBeInstanceOf(CompaniesHouseConfigurationError);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("the 601st request is blocked by the shared five-minute limiter", async () => {
    while (companiesHouseRateLimiter.tryAcquire()) {
      // Drain the shared limiter without network requests.
    }
    const fetchFn = routedFetch([]);
    await expect(
      resolveCompaniesHouseCompany(COMPANY_NUMBER, options(fetchFn)),
    ).rejects.toBeInstanceOf(CompaniesHouseRateLimitError);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("an upstream 429 is normalized to CompaniesHouseRateLimitError", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}`, body: { error: "rate limit" }, status: 429 },
    ]);
    await expect(
      resolveCompaniesHouseCompany(COMPANY_NUMBER, options(fetchFn)),
    ).rejects.toBeInstanceOf(CompaniesHouseRateLimitError);
  });
});

describe("Companies House company resolution", () => {
  test("normalizes numeric and prefixed company numbers", () => {
    expect(normalizeCompanyNumber("1234567")).toBe("01234567");
    expect(normalizeCompanyNumber(" company no. sc123456 ")).toBe("SC123456");
    expect(normalizeCompanyNumber("OC42")).toBe("OC000042");
    expect(() => normalizeCompanyNumber("Example Limited")).toThrow(/Invalid/);
  });

  test("direct company-number resolution uses the profile and previous names", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}`, body: profile() },
    ]);
    const entity = await resolveCompaniesHouseCompany("1234567", options(fetchFn));
    expect(entity).toMatchObject({
      legalName: "EXAMPLE HOLDINGS LIMITED",
      companyNumber: COMPANY_NUMBER,
      jurisdiction: "GB",
      status: "active",
      source: "Companies House",
      matchReason: "Exact Companies House company-number match",
      aliases: ["EXAMPLE GROUP LIMITED"],
      sourceIdentifiers: {
        companyNumber: COMPANY_NUMBER,
        jurisdiction: "england-wales",
      },
    });
    expect(entity?.sourceUrl).toBe(
      `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}`,
    );
  });

  test("name search uses shared Unicode ranking", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/search/companies",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 3,
          items: [
            {
              title: "Example Technology Limited",
              company_number: "09999999",
              company_status: "active",
            },
            {
              title: "Société Générale UK Limited",
              company_number: "01234567",
              company_status: "active",
            },
            {
              title: "General Example Limited",
              company_number: "08888888",
              company_status: "active",
            },
          ],
        },
      },
    ]);
    const entities = await searchCompaniesHouseCompanies(
      "Societe Generale UK Limited",
      options(fetchFn),
    );
    expect(entities[0]?.legalName).toBe("Société Générale UK Limited");
    expect(entities[0]?.matchReason).toBe("Exact normalized legal-name match");
    expect(fetchFn.requests[0]?.url).toContain("q=Societe+Generale+UK+Limited");
  });

  test("a direct 404 returns null", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}`, body: { error: "not found" }, status: 404 },
    ]);
    expect(
      await resolveCompaniesHouseCompany(COMPANY_NUMBER, options(fetchFn)),
    ).toBeNull();
  });
});

describe("Companies House filing history", () => {
  test("follows offset pagination, filters against type/category/description, and builds public links", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "start_index=1",
        body: {
          items_per_page: 1,
          start_index: 1,
          total_count: 2,
          items: [
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-total-exemption-full",
              date: "2024-09-30",
              transaction_id: "MzAwMDAwMDAwMGFkaXF6a2N4",
              links: {
                document_metadata: "/document/doc-accounts",
                self: `/company/${COMPANY_NUMBER}/filing-history/MzAwMDAwMDAwMGFkaXF6a2N4`,
              },
            },
          ],
        },
      },
      {
        pattern: `/company/${COMPANY_NUMBER}/filing-history`,
        body: {
          items_per_page: 1,
          start_index: 0,
          total_count: 2,
          items: [
            {
              category: "officers",
              type: "AP01",
              description: "appoint-person-director-company-with-name-date",
              date: "2025-01-02",
              transaction_id: "tx-officer",
              links: { self: `/company/${COMPANY_NUMBER}/filing-history/tx-officer` },
            },
          ],
        },
      },
    ]);
    const filings = await searchCompaniesHouseFilings({
      company: COMPANY_NUMBER,
      forms: ["total exemption"],
      limit: 20,
    }, options(fetchFn));
    expect(fetchFn.requests).toHaveLength(2);
    expect(filings).toHaveLength(1);
    expect(filings[0]).toMatchObject({
      form: "AA",
      category: "accounts",
      description: "Accounts with accounts type total exemption full",
      filedDate: "2024-09-30",
      accession: "MzAwMDAwMDAwMGFkaXF6a2N4",
      source: "Companies House",
    });
    expect(filings[0]?.sourceUrl).toBe(
      `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}/filing-history/MzAwMDAwMDAwMGFkaXF6a2N4/document?format=pdf&download=0`,
    );
  });

  test("date and category/type filters work together", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/filing-history",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_count: 3,
          items: [
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-full",
              date: "2024-06-01",
              transaction_id: "accounts",
              links: { document_metadata: "/document/a" },
            },
            {
              category: "confirmation-statement",
              type: "CS01",
              description: "confirmation-statement-with-updates",
              date: "2024-07-01",
              transaction_id: "confirmation",
              links: { document_metadata: "/document/b" },
            },
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-full",
              date: "2022-06-01",
              transaction_id: "old-accounts",
              links: { document_metadata: "/document/c" },
            },
          ],
        },
      },
    ]);
    const filings = await searchCompaniesHouseFilings({
      company: COMPANY_NUMBER,
      forms: ["accounts"],
      startDate: "2023-01-01",
      endDate: "2024-12-31",
    }, options(fetchFn));
    expect(filings.map((filing) => filing.accession)).toEqual(["accounts"]);
  });

  test("latest annual mode selects the newest accounts filing", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/filing-history",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_count: 3,
          items: [
            {
              category: "confirmation-statement",
              type: "CS01",
              description: "confirmation-statement-with-updates",
              date: "2025-01-01",
              transaction_id: "confirmation",
              links: { document_metadata: "/document/c" },
            },
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-small",
              date: "2024-09-30",
              transaction_id: "new-accounts",
              links: { document_metadata: "/document/a" },
            },
            {
              category: "accounts",
              type: "AA",
              description: "accounts-with-accounts-type-small",
              date: "2023-09-30",
              transaction_id: "old-accounts",
              links: { document_metadata: "/document/b" },
            },
          ],
        },
      },
    ]);
    const report = await getLatestCompaniesHouseReport(
      COMPANY_NUMBER,
      "annual",
      options(fetchFn),
    );
    expect(report?.accession).toBe("new-accounts");
    expect(report?.reportKind).toBe("annual");
    expect(report?.sectionLinks.map((item) => item.section)).toEqual([
      "accounts-document",
      "filing-history",
    ]);
    expect(
      await getLatestCompaniesHouseReport(
        COMPANY_NUMBER,
        "quarterly",
        options(routedFetch([])),
      ),
    ).toBeNull();
  });
});

describe("Companies House officers", () => {
  test("normalizes active/former officers without privacy-sensitive fields", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/officers",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 2,
          items: [
            {
              name: "DOE, Jane",
              officer_role: "director",
              occupation: "Software engineer",
              appointed_on: "2020-01-01",
              address: { locality: "London" },
              nationality: "British",
              date_of_birth: { month: 1, year: 1980 },
            },
            {
              name: "EXAMPLE SECRETARIES LIMITED",
              officer_role: "corporate-secretary",
              appointed_on: "2018-01-01",
              resigned_on: "2022-02-03",
            },
          ],
        },
      },
    ]);
    const officers = await getCompaniesHouseOfficers(
      COMPANY_NUMBER,
      options(fetchFn),
    );
    expect(officers[0]).toMatchObject({
      name: "DOE, Jane",
      officerRole: "director",
      occupation: "Software engineer",
      appointedDate: "2020-01-01",
      status: "Active",
    });
    expect(officers[1]).toMatchObject({
      officerRole: "corporate-secretary",
      ceasedDate: "2022-02-03",
      status: "Former",
    });
    const serialized = JSON.stringify(officers);
    expect(serialized).not.toContain("nationality");
    expect(serialized).not.toContain("date_of_birth");
    expect(serialized).not.toContain("London");
  });

  test("surfaces ECCTA identity verification when present and omits it when absent", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/officers",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 2,
          items: [
            {
              name: "VERIFIED, Alex",
              officer_role: "director",
              appointed_on: "2025-12-01",
              identity_verification_details: {
                identity_verified_on: "2025-11-20",
                authorised_corporate_service_provider_name: "DE PINNA LLP",
              },
            },
            {
              name: "UNRECORDED, Sam",
              officer_role: "director",
              appointed_on: "2019-05-01",
            },
          ],
        },
      },
    ]);
    const officers = await getCompaniesHouseOfficers(
      COMPANY_NUMBER,
      options(fetchFn),
    );
    const verified = officers.find((o) => o.name === "VERIFIED, Alex");
    const unrecorded = officers.find((o) => o.name === "UNRECORDED, Sam");
    expect(verified?.identityVerification).toBe(
      "Verified 2025-11-20 (ACSP: DE PINNA LLP)",
    );
    expect(unrecorded?.identityVerification).toBeUndefined();
    // Absence must not be serialized as a false "unverified" signal.
    expect(Object.keys(unrecorded ?? {})).not.toContain("identityVerification");
  });
});

describe("ECCTA identity_verification_details formatting", () => {
  test("verified via ACSP includes the provider name", () => {
    expect(formatIdentityVerification({
      identity_verified_on: "2025-11-20",
      authorised_corporate_service_provider_name: "DE PINNA LLP",
    })).toBe("Verified 2025-11-20 (ACSP: DE PINNA LLP)");
  });

  test("verified without an ACSP name omits the provider clause", () => {
    expect(formatIdentityVerification({
      identity_verified_on: "2025-11-20",
    })).toBe("Verified 2025-11-20");
  });

  test("verification statement supplied without a verified date", () => {
    expect(formatIdentityVerification({
      appointment_verification_start_on: "2026-04-16",
    })).toBe("Verification statement supplied 2026-04-16");
  });

  test("verification statement with an end date is noted as ended", () => {
    expect(formatIdentityVerification({
      appointment_verification_start_on: "2026-04-16",
      appointment_verification_end_on: "2026-05-01",
    })).toBe("Verification statement 2026-04-16 (ended 2026-05-01)");
  });

  test("only a due date surfaces as a pending statement", () => {
    expect(formatIdentityVerification({
      appointment_verification_statement_due_on: "2026-11-17",
    })).toBe("Statement due by 2026-11-17");
  });

  test("an absent or empty block yields undefined, never a false 'unverified'", () => {
    expect(formatIdentityVerification(undefined)).toBeUndefined();
    expect(formatIdentityVerification({})).toBeUndefined();
    expect(formatIdentityVerification("not-an-object")).toBeUndefined();
  });
});

describe("Companies House PSC register", () => {
  test("normalizes polymorphic PSC kinds, bands, natures of control, and ceased entries", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "persons-with-significant-control?",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 4,
          items: [
            {
              kind: "individual-person-with-significant-control",
              name: "Jane Doe",
              notified_on: "2020-01-01",
              natures_of_control: [
                "ownership-of-shares-25-to-50-percent",
                "voting-rights-25-to-50-percent",
              ],
            },
            {
              kind: "corporate-entity-person-with-significant-control",
              name: "Example Parent Limited",
              notified_on: "2020-02-01",
              ceased_on: "2024-01-01",
              natures_of_control: ["ownership-of-shares-75-to-100-percent"],
            },
            {
              kind: "legal-person-with-significant-control",
              name: "Example Foundation",
              notified_on: "2021-01-01",
              natures_of_control: ["significant-influence-or-control"],
            },
            {
              kind: "super-secure-person-with-significant-control",
              description: "super-secure-persons-with-significant-control",
              ceased: false,
            },
          ],
        },
      },
    ]);
    const owners = await getCompaniesHousePscs(COMPANY_NUMBER, options(fetchFn));
    expect(owners.map((owner) => owner.holderType)).toEqual([
      "Individual",
      "Corporate entity",
      "Legal person",
      "Super-secure person",
    ]);
    expect(owners[0]?.percentageBand).toBe(">25% up to 50%");
    expect(owners[0]?.naturesOfControl).toEqual([
      "ownership-of-shares-25-to-50-percent",
      "voting-rights-25-to-50-percent",
    ]);
    expect(owners[1]?.percentageBand).toBe(">75% up to 100%");
    expect(owners[1]?.ceasedDate).toBe("2024-01-01");
    expect(owners[3]?.holderName).toBe("Protected details (super-secure PSC)");
    expect(owners.every((owner) =>
      owner.thresholdRegime === COMPANIES_HOUSE_PSC_THRESHOLD_REGIME
    )).toBe(true);
  });

  test("surfaces ECCTA identity verification on a PSC record", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "persons-with-significant-control?",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 1,
          items: [
            {
              kind: "individual-person-with-significant-control",
              name: "Jane Doe",
              notified_on: "2025-12-01",
              natures_of_control: ["ownership-of-shares-75-to-100-percent"],
              identity_verification_details: {
                appointment_verification_start_on: "2026-04-16",
              },
            },
          ],
        },
      },
    ]);
    const owners = await getCompaniesHousePscs(COMPANY_NUMBER, options(fetchFn));
    expect(owners[0]?.identityVerification).toBe(
      "Verification statement supplied 2026-04-16",
    );
  });

  test("derives every supported statutory percentage band", () => {
    expect(deriveCompaniesHousePercentageBand([
      "ownership-of-shares-25-to-50-percent",
      "voting-rights-50-to-75-percent",
      "ownership-of-shares-75-to-100-percent-as-trust",
    ])).toBe(">25% up to 50%; >50% up to 75%; >75% up to 100%");
  });

  test("fetches and surfaces PSC statements when no normal PSC exists", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "persons-with-significant-control-statements",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 1,
          items: [
            {
              kind: "persons-with-significant-control-statement",
              statement: "no-individual-or-entity-with-signficant-control",
              notified_on: "2020-01-01",
              links: { self: `/company/${COMPANY_NUMBER}/persons-with-significant-control-statements/x` },
            },
          ],
        },
      },
      {
        pattern: "persons-with-significant-control?",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 0,
          items: [],
        },
      },
    ]);
    const owners = await getCompaniesHouseOwners(COMPANY_NUMBER, options(fetchFn));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      holderType: "PSC statement",
      form: "no-individual-or-entity-with-signficant-control",
      notifiedDate: "2020-01-01",
      thresholdRegime: COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
    });
    expect(fetchFn.requests).toHaveLength(2);
  });

  test("returns normalized statement resources directly", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "persons-with-significant-control-statements",
        body: {
          items_per_page: 100,
          start_index: 0,
          total_results: 1,
          items: [
            {
              statement: "psc-contacted-but-no-response",
              linked_psc_name: "Jane Doe",
              notified_on: "2024-02-01",
              ceased_on: "2024-03-01",
            },
          ],
        },
      },
    ]);
    expect(
      await getCompaniesHousePscStatements(COMPANY_NUMBER, options(fetchFn)),
    ).toEqual([
      {
        statement: "psc-contacted-but-no-response",
        description: "Psc contacted but no response",
        linkedPscName: "Jane Doe",
        notifiedDate: "2024-02-01",
        ceasedDate: "2024-03-01",
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}/persons-with-significant-control`,
      },
    ]);
  });
});

describe("malformed Companies House responses", () => {
  test("collection parsers skip malformed rows and malformed collections", async () => {
    const searchFetch = routedFetch([
      {
        pattern: "/search/companies",
        body: {
          items: [
            null,
            { title: "Missing number" },
            { company_number: "01234567" },
            { title: "Valid Limited", company_number: "01234567" },
          ],
        },
      },
    ]);
    const entities = await searchCompaniesHouseCompanies(
      "Valid Limited",
      options(searchFetch),
    );
    expect(entities).toHaveLength(1);

    const filingFetch = routedFetch([
      { pattern: "/filing-history", body: { items: "not-an-array" } },
    ]);
    expect(
      await searchCompaniesHouseFilings(COMPANY_NUMBER, options(filingFetch)),
    ).toEqual([]);
  });

  test("a malformed direct profile fails with a readable message", () => {
    expect(() => parseCompaniesHouseProfile({ company_number: COMPANY_NUMBER }))
      .toThrow(/missing company number or company name/);
  });
});
