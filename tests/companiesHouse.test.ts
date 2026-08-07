import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMPANIES_HOUSE_IMAGE_ONLY_MESSAGE,
  COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
  CompaniesHouseConfigurationError,
  CompaniesHouseRateLimitError,
  deriveCompaniesHousePercentageBand,
  formatIdentityVerification,
  getCompaniesHouseCharge,
  getCompaniesHouseCharges,
  getCompaniesHouseDisqualifiedOfficer,
  getCompaniesHouseDocumentMetadata,
  getCompaniesHouseDocumentPdf,
  getCompaniesHouseDocumentText,
  getCompaniesHouseInsolvency,
  getCompaniesHouseOfficerAppointments,
  getCompaniesHouseOfficers,
  getCompaniesHouseOwners,
  getCompaniesHouseProfileDetail,
  getCompaniesHousePscStatements,
  getCompaniesHousePscs,
  getLatestCompaniesHouseReport,
  normalizeCompanyNumber,
  parseCompaniesHouseProfile,
  resolveCompaniesHouseCompany,
  resolveCompaniesHouseDocumentReference,
  searchCompaniesHouseCompanies,
  searchCompaniesHouseDisqualifiedOfficers,
  searchCompaniesHouseFilings,
  searchCompaniesHouseOfficers,
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

const DOCUMENT_API = "https://document-api.company-information.service.gov.uk";

function documentMetadataBody(
  documentId: string,
  { xhtml = true, pdf = true, pages }: {
    xhtml?: boolean;
    pdf?: boolean;
    pages?: number;
  } = {},
): Record<string, unknown> {
  const resources: Record<string, unknown> = {};
  if (pdf) resources["application/pdf"] = { content_length: 40_000 };
  if (xhtml) resources["application/xhtml+xml"] = { content_length: 8_000 };
  return {
    company_number: COMPANY_NUMBER,
    filename: `${documentId}.pdf`,
    category: "accounts",
    created_at: "2024-09-30T00:00:00Z",
    ...(pages !== undefined ? { pages } : {}),
    resources,
    links: {
      self: `/document/${documentId}`,
      document: `/document/${documentId}/content`,
    },
  };
}

describe("Companies House filed documents", () => {
  test("resolves a filing-history transaction to its document id and public link", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `/company/${COMPANY_NUMBER}/filing-history/txn-1`,
        body: {
          transaction_id: "txn-1",
          links: {
            self: `/company/${COMPANY_NUMBER}/filing-history/txn-1`,
            document_metadata: `${DOCUMENT_API}/document/doc-xyz`,
          },
        },
      },
    ]);
    const resolved = await resolveCompaniesHouseDocumentReference(
      COMPANY_NUMBER,
      "txn-1",
      options(fetchFn),
    );
    expect(resolved.documentId).toBe("doc-xyz");
    expect(resolved.sourceUrl).toBe(
      `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}/filing-history/txn-1/document?format=pdf&download=0`,
    );
  });

  test("a transaction with no filed image reports a readable error", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `/company/${COMPANY_NUMBER}/filing-history/txn-2`,
        body: { transaction_id: "txn-2", links: {} },
      },
    ]);
    await expect(
      resolveCompaniesHouseDocumentReference(COMPANY_NUMBER, "txn-2", options(fetchFn)),
    ).rejects.toThrow(/no downloadable filed document/);
  });

  test("metadata lists every available rendition", async () => {
    const fetchFn = routedFetch([
      { pattern: `${DOCUMENT_API}/document/doc-1`, body: documentMetadataBody("doc-1", { pages: 12 }) },
    ]);
    const metadata = await getCompaniesHouseDocumentMetadata("doc-1", options(fetchFn));
    expect(metadata.pages).toBe(12);
    expect(metadata.resources.map((resource) => resource.contentType).sort()).toEqual([
      "application/pdf",
      "application/xhtml+xml",
    ]);
  });

  test("xhtml mode extracts iXBRL plain text and strips markup", async () => {
    const fetchFn = routedFetch([
      { pattern: "/document/doc-1/content", body: "<html><body><span>Net assets 1,234</span></body></html>" },
      { pattern: "/document/doc-1", body: documentMetadataBody("doc-1") },
    ]);
    const metadata = await getCompaniesHouseDocumentMetadata("doc-1", options(fetchFn));
    const text = await getCompaniesHouseDocumentText(metadata, options(fetchFn));
    expect(text?.text).toContain("Net assets 1,234");
    expect(text?.text).not.toContain("<span>");
  });

  test("image-only accounts return null text rather than fetching content", async () => {
    const fetchFn = routedFetch([
      { pattern: "/document/doc-img", body: documentMetadataBody("doc-img", { xhtml: false }) },
    ]);
    const metadata = await getCompaniesHouseDocumentMetadata("doc-img", options(fetchFn));
    expect(metadata.resources.some((r) => r.contentType === "application/xhtml+xml")).toBe(false);
    const text = await getCompaniesHouseDocumentText(metadata, options(fetchFn));
    expect(text).toBeNull();
    // Only the metadata call was made — no content was downloaded.
    expect(fetchFn.requests).toHaveLength(1);
    // The tool-facing message names the image-only condition explicitly.
    expect(COMPANIES_HOUSE_IMAGE_ONLY_MESSAGE).toContain("Image-only accounts");
  });

  test("pdf mode follows the S3 redirect, strips auth, and counts pages", async () => {
    const s3Url = "https://s3.eu-west-2.amazonaws.com/chs-doc/doc-img.pdf?sig=xyz";
    const pdfBytes = new TextEncoder().encode(
      "%PDF-1.4\n/Type /Page\n/Type /Page\n/Type /Pages\n%%EOF",
    );
    const fetchFn = routedFetch([
      { pattern: "amazonaws.com", body: pdfBytes },
      {
        pattern: "/document/doc-img/content",
        body: "",
        status: 302,
        headers: { location: s3Url },
      },
      { pattern: "/document/doc-img", body: documentMetadataBody("doc-img", { xhtml: false }) },
    ]);
    const metadata = await getCompaniesHouseDocumentMetadata("doc-img", options(fetchFn));
    const pdf = await getCompaniesHouseDocumentPdf(metadata, options(fetchFn));
    expect(pdf.byteLength).toBe(pdfBytes.byteLength);
    expect(pdf.bytes).toEqual(pdfBytes);
    // No metadata `pages`, so the count comes from scanning /Type /Page objects
    // (the two /Type /Page entries; /Type /Pages must not be miscounted).
    expect(pdf.pageCount).toBe(2);
    expect(pdf.suggestedFilename).toBe("doc-img.pdf");
    // The S3 hop is the last request and must not carry Basic auth.
    const s3Request = fetchFn.requests.find((r) => r.url.includes("amazonaws.com"));
    const s3Headers = s3Request?.init?.headers as Record<string, string>;
    expect(
      Object.keys(s3Headers ?? {}).some((key) => key.toLowerCase() === "authorization"),
    ).toBe(false);
  });
});

describe("Companies House registered charges", () => {
  function chargesBody(): Record<string, unknown> {
    return {
      total_count: 2,
      unfiltered_count: 2,
      satisfied_count: 1,
      part_satisfied_count: 0,
      items: [
        {
          charge_id: "chg-outstanding",
          charge_code: "012345670001",
          status: "outstanding",
          created_on: "2019-08-14",
          delivered_on: "2019-08-20",
          classification: { description: "A registered charge" },
          persons_entitled: [{ name: "Capital Values Group Limited" }],
          particulars: {
            contains_fixed_charge: true,
            contains_negative_pledge: true,
          },
          transactions: [
            {
              filing_type: "create-charge-with-deed",
              delivered_on: "2019-08-20",
              links: { filing: `/company/${COMPANY_NUMBER}/filing-history/tx-charge` },
            },
          ],
        },
        {
          charge_id: "chg-satisfied",
          status: "satisfied",
          created_on: "2015-01-01",
          satisfied_on: "2018-01-01",
          persons_entitled: [{ name: "Old Bank plc" }],
          particulars: { contains_floating_charge: true, floating_charge_covers_all: true },
        },
      ],
    };
  }

  test("lists charges with page-1 counts, persons entitled, and particulars flags", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}/charges`, body: chargesBody() },
    ]);
    const result = await getCompaniesHouseCharges(COMPANY_NUMBER, options(fetchFn));
    expect(result.totalCount).toBe(2);
    expect(result.satisfiedCount).toBe(1);
    expect(result.charges).toHaveLength(2);
    const outstanding = result.charges.find((c) => c.chargeId === "chg-outstanding");
    expect(outstanding?.status).toBe("Outstanding");
    expect(outstanding?.personsEntitled).toEqual(["Capital Values Group Limited"]);
    expect(outstanding?.classification).toBe("A registered charge");
    expect(outstanding?.particulars).toEqual([
      "Fixed charge",
      "Negative pledge",
    ]);
    expect(outstanding?.transactions[0]?.sourceUrl).toBe(
      `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}/filing-history/tx-charge`,
    );
    expect(outstanding?.sourceUrl).toBe(
      `https://find-and-update.company-information.service.gov.uk/company/${COMPANY_NUMBER}/charges/chg-outstanding`,
    );
  });

  test("status filter narrows results client-side", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}/charges`, body: chargesBody() },
    ]);
    const result = await getCompaniesHouseCharges(
      COMPANY_NUMBER,
      options(fetchFn),
      "outstanding",
    );
    expect(result.charges.map((c) => c.chargeId)).toEqual(["chg-outstanding"]);
    // The counts still reflect the full unfiltered register.
    expect(result.totalCount).toBe(2);
  });

  test("a single charge is fetched by id", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `/company/${COMPANY_NUMBER}/charges/chg-outstanding`,
        body: {
          charge_id: "chg-outstanding",
          status: "outstanding",
          persons_entitled: [{ name: "Capital Values Group Limited" }],
          particulars: { contains_fixed_charge: true },
        },
      },
    ]);
    const charge = await getCompaniesHouseCharge(
      COMPANY_NUMBER,
      "chg-outstanding",
      options(fetchFn),
    );
    expect(charge?.personsEntitled).toEqual(["Capital Values Group Limited"]);
    expect(charge?.particulars).toEqual(["Fixed charge"]);
  });

  test("a missing charge register returns an empty list", async () => {
    const fetchFn = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}/charges`, body: { error: "not found" }, status: 404 },
    ]);
    const result = await getCompaniesHouseCharges(COMPANY_NUMBER, options(fetchFn));
    expect(result.charges).toEqual([]);
  });
});

describe("Companies House person appointments and disqualifications", () => {
  test("officer search extracts the officer id and links to the safe public page", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/search/officers",
        body: {
          items_per_page: 35,
          start_index: 0,
          total_results: 2,
          items: [
            {
              title: "Luke Alexander NOLAN",
              appointment_count: 4,
              date_of_birth: { month: 6, year: 1985 },
              address_snippet: "London",
              links: { self: "/officers/AbC123/appointments" },
            },
            {
              title: "Luke NOLAN",
              appointment_count: 1,
              links: { self: "/officers/XyZ789/appointments" },
            },
          ],
        },
      },
    ]);
    const results = await searchCompaniesHouseOfficers("Luke Nolan", options(fetchFn));
    expect(results.map((r) => r.officerId)).toEqual(["AbC123", "XyZ789"]);
    expect(results[0]?.dateOfBirth).toBe("1985-06");
    expect(results[0]?.sourceUrl).toBe(
      "https://find-and-update.company-information.service.gov.uk/officers/AbC123/appointments",
    );
    expect(fetchFn.requests[0]?.url).toContain("q=Luke+Nolan");
  });

  test("appointments list normalizes each company appointment", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/officers/AbC123/appointments",
        body: {
          name: "Luke Alexander NOLAN",
          date_of_birth: { month: 6, year: 1985 },
          is_corporate_officer: false,
          total_results: 2,
          items: [
            {
              company_name: "STUDENT.COM (UK) LIMITED",
              company_number: "09114114",
              company_status: "active",
              officer_role: "director",
              appointed_on: "2014-07-08",
            },
            {
              company_name: "OVERSEAS STUDENT LIVING LLP",
              company_number: "OC401234",
              officer_role: "member",
              appointed_on: "2013-01-01",
              resigned_on: "2018-05-05",
            },
          ],
        },
      },
    ]);
    const list = await getCompaniesHouseOfficerAppointments("AbC123", options(fetchFn));
    expect(list.name).toBe("Luke Alexander NOLAN");
    expect(list.appointments).toHaveLength(2);
    expect(list.appointments[0]).toMatchObject({
      companyName: "STUDENT.COM (UK) LIMITED",
      companyNumber: "09114114",
      officerRole: "Director",
      sourceUrl:
        "https://find-and-update.company-information.service.gov.uk/company/09114114",
    });
    expect(list.appointments[1]?.companyNumber).toBe("OC401234");
  });

  test("disqualification search links only to the safe public search page", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/search/disqualified-officers",
        body: {
          items: [
            {
              title: "Mark SMITH",
              date_of_birth: { month: 3, year: 1970 },
              links: { self: "/disqualified-officers/natural/Dq123" },
            },
          ],
        },
      },
    ]);
    const results = await searchCompaniesHouseDisqualifiedOfficers("Mark Smith", options(fetchFn));
    expect(results[0]?.officerId).toBe("Dq123");
    expect(results[0]?.officerType).toBe("natural");
    // Never a fabricated deep link — always the safe public search page, keyed
    // by the record's own name.
    expect(results[0]?.sourceUrl).toBe(
      "https://find-and-update.company-information.service.gov.uk/search/disqualified-officers?q=Mark%20SMITH",
    );
  });

  test("a disqualified officer record surfaces reasons and dates", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "/disqualified-officers/natural/Dq123",
        body: {
          forename: "Mark",
          surname: "Smith",
          date_of_birth: "1970-03-01",
          disqualifications: [
            {
              disqualified_from: "2019-01-01",
              disqualified_until: "2029-01-01",
              reason: { description_identifier: "order-or-undertaking-and-reporting-provisions" },
              company_names: ["FAILED VENTURES LTD"],
            },
          ],
        },
      },
    ]);
    const officer = await getCompaniesHouseDisqualifiedOfficer(
      "Dq123",
      "natural",
      options(fetchFn),
    );
    expect(officer?.name).toBe("Mark Smith");
    expect(officer?.disqualifications[0]?.disqualifiedUntil).toBe("2029-01-01");
    expect(officer?.disqualifications[0]?.reason).toContain("Order or undertaking");
    expect(officer?.sourceUrl).toBe(
      "https://find-and-update.company-information.service.gov.uk/officers/Dq123/disqualified",
    );
  });
});

describe("Companies House enriched profile and insolvency", () => {
  test("profile detail surfaces previous names with date ranges and flags", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `/company/${COMPANY_NUMBER}`,
        body: {
          company_number: COMPANY_NUMBER,
          company_name: "STUDENT.COM (UK) LIMITED",
          company_status: "active",
          type: "ltd",
          date_of_creation: "2014-07-08",
          has_charges: true,
          has_insolvency_history: false,
          sic_codes: ["63990"],
          registered_office_address: { address_line_1: "1 Example St", locality: "London", postal_code: "EC1A 1AA" },
          previous_company_names: [
            { name: "OVERSEAS STUDENT LIVING LIMITED", effective_from: "2014-07-08", ceased_on: "2015-06-30" },
          ],
          accounts: {
            next: { due_on: "2025-06-30", period_end_on: "2024-09-30" },
            last_accounts: { made_up_to: "2023-09-30" },
            accounting_reference_date: { day: "30", month: "09" },
          },
          confirmation_statement: { next_due: "2025-07-22", last_made_up_to: "2024-07-08" },
        },
      },
    ]);
    const detail = await getCompaniesHouseProfileDetail(COMPANY_NUMBER, options(fetchFn));
    expect(detail?.legalName).toBe("STUDENT.COM (UK) LIMITED");
    expect(detail?.hasCharges).toBe(true);
    expect(detail?.sicCodes).toEqual(["63990"]);
    expect(detail?.previousNames[0]).toEqual({
      name: "OVERSEAS STUDENT LIVING LIMITED",
      effectiveFrom: "2014-07-08",
      ceasedOn: "2015-06-30",
    });
    expect(detail?.registeredOfficeAddress).toBe("1 Example St, London, EC1A 1AA");
    expect(detail?.accounts?.accountingReferenceDate).toBe("30/09");
    expect(detail?.confirmationStatement?.nextDue).toBe("2025-07-22");
  });

  test("insolvency cases are normalized, and a 404 register is absence not error", async () => {
    const fetchFn = routedFetch([
      {
        pattern: `/company/${COMPANY_NUMBER}/insolvency`,
        body: {
          cases: [
            {
              type: "creditors-voluntary-liquidation",
              number: "1",
              dates: [{ type: "wound-up-on", date: "2018-01-01" }],
              practitioners: [{ name: "Jane Liquidator", role: "practitioner" }],
            },
          ],
        },
      },
    ]);
    const insolvency = await getCompaniesHouseInsolvency(COMPANY_NUMBER, options(fetchFn));
    expect(insolvency?.cases).toHaveLength(1);
    expect(insolvency?.cases[0]?.type).toBe("Creditors voluntary liquidation");
    expect(insolvency?.cases[0]?.dates).toEqual(["Wound up on: 2018-01-01"]);
    expect(insolvency?.cases[0]?.practitioners[0]?.name).toBe("Jane Liquidator");

    const missing = routedFetch([
      { pattern: `/company/${COMPANY_NUMBER}/insolvency`, body: { error: "not found" }, status: 404 },
    ]);
    expect(await getCompaniesHouseInsolvency(COMPANY_NUMBER, options(missing))).toBeNull();
  });
});
