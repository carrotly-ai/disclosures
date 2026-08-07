import { beforeEach, describe, expect, test } from "bun:test";
import {
  EDINET_5_PERCENT_THRESHOLD_REGIME,
  EDINET_VIEWER_URL,
  EdinetConfigurationError,
  EdinetRateLimitError,
  getEdinetConfigurationError,
  getEdinetLargeHolders,
  getLatestEdinetReport,
  hasEdinetConfiguration,
  parseEdinetCodeCsv,
  resetEdinetCodeCache,
  resolveEdinetCode,
  searchEdinetCompanies,
  searchEdinetFilings,
} from "../src/adapters/edinet.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env } from "../src/core/types.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";
import {
  EDINET_CODE_CSV_BYTES,
  edinetCodeListRoute,
  edinetDay,
} from "./helpers/edinetFixture.js";

const ENV: Env = { EDINET_API_KEY: "test-edinet-key" };

function options(fetchFn: ReturnType<typeof routedFetch>, env: Env = ENV): AdapterOptions {
  return { fetchFn, env };
}

// One calendar day of documents.json results: three Toyota (E02144) filings plus
// a Sony (E01777) filing that must be filtered out.
const TOYOTA_DAY = [
  {
    docID: "S100ANNUAL",
    edinetCode: "E02144",
    secCode: "72030",
    JCN: "1180301018771",
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
    docDescription: "四半期報告書－第1四半期",
    submitDateTime: "2026-08-05 10:00",
  },
  {
    docID: "S100EXTRA",
    edinetCode: "E02144",
    secCode: "72030",
    filerName: "トヨタ自動車株式会社",
    docTypeCode: "180",
    docDescription: "臨時報告書",
    submitDateTime: "2026-08-05 11:00",
  },
  {
    docID: "S100SONY",
    edinetCode: "E01777",
    secCode: "67580",
    filerName: "ソニーグループ株式会社",
    docTypeCode: "120",
    docDescription: "有価証券報告書",
    submitDateTime: "2026-08-05 08:00",
  },
];

const documentsRoute: Route = { pattern: "documents.json", body: edinetDay(TOYOTA_DAY) };

beforeEach(() => {
  resetRateLimiters();
  resetEdinetCodeCache();
});

describe("EDINET code-list parsing", () => {
  test("locates columns and decodes Shift_JIS filer names", () => {
    const csv = new TextDecoder("shift_jis").decode(EDINET_CODE_CSV_BYTES);
    const entries = parseEdinetCodeCsv(csv);
    expect(entries).toHaveLength(3);
    const toyota = entries.find((entry) => entry.edinetCode === "E02144");
    expect(toyota?.filerName).toBe("トヨタ自動車株式会社");
    expect(toyota?.filerNameEn).toBe("TOYOTA MOTOR CORPORATION");
    expect(toyota?.secCode).toBe("72030");
    expect(toyota?.jcn).toBe("1180301018771");
    expect(toyota?.listed).toBe(true);
  });

  test("treats 非上場 as unlisted rather than matching the 上場 substring", () => {
    const csv = new TextDecoder("shift_jis").decode(EDINET_CODE_CSV_BYTES);
    const unlisted = parseEdinetCodeCsv(csv).find((entry) => entry.edinetCode === "E99999");
    expect(unlisted?.listed).toBe(false);
    expect(unlisted?.secCode).toBeUndefined();
  });
});

describe("searchEdinetCompanies", () => {
  test("resolves an exact EDINET code without an API key", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    const results = await searchEdinetCompanies("E02144", options(fetchFn, {}));
    expect(results).toHaveLength(1);
    expect(results[0]?.legalName).toBe("トヨタ自動車株式会社");
    expect(results[0]?.edinetCode).toBe("E02144");
    expect(results[0]?.jurisdiction).toBe("JP");
    expect(results[0]?.source).toBe("EDINET");
    expect(results[0]?.sourceUrl).toBe(EDINET_VIEWER_URL);
  });

  test("resolves a 4-digit securities code via the 5-digit prefix", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    const results = await searchEdinetCompanies("7203", options(fetchFn));
    expect(results.map((entity) => entity.edinetCode)).toEqual(["E02144"]);
  });

  test("resolves a 13-digit corporate number", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    const results = await searchEdinetCompanies("5010401067252", options(fetchFn));
    expect(results[0]?.legalName).toBe("ソニーグループ株式会社");
  });

  test("ranks legal-name matches and reports unlisted status", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    const results = await searchEdinetCompanies("テスト投資顧問", options(fetchFn));
    expect(results[0]?.edinetCode).toBe("E99999");
    expect(results[0]?.status).toBe("Unlisted");
  });

  test("returns an empty array for an unknown identifier", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    expect(await searchEdinetCompanies("E00000", options(fetchFn))).toHaveLength(0);
  });

  test("resolveEdinetCode throws a not-found message for a miss", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    await expect(resolveEdinetCode("E00000", options(fetchFn))).rejects.toThrow(
      /No EDINET company found/i,
    );
  });
});

describe("configuration", () => {
  test("hasEdinetConfiguration and getEdinetConfigurationError track EDINET_API_KEY", () => {
    expect(hasEdinetConfiguration({ env: ENV })).toBe(true);
    expect(hasEdinetConfiguration({ env: {} })).toBe(false);
    expect(getEdinetConfigurationError({ env: {} })).toBeInstanceOf(EdinetConfigurationError);
    expect(getEdinetConfigurationError({ env: ENV })).toBeUndefined();
  });

  test("a filings scan without a key throws after code resolution", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    await expect(
      searchEdinetFilings({ company: "E02144" }, options(fetchFn, {})),
    ).rejects.toBeInstanceOf(EdinetConfigurationError);
  });
});

describe("searchEdinetFilings", () => {
  test("filters a scanned day to the resolved filer and labels doc types", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, documentsRoute]);
    const filings = await searchEdinetFilings(
      { company: "7203", startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(3);
    const forms = filings.map((filing) => filing.form);
    expect(forms).toContain("Annual securities report (有価証券報告書)");
    expect(forms).toContain("Quarterly report (四半期報告書)");
    expect(forms).toContain("Extraordinary report (臨時報告書)");
    // Sony's filing for a different EDINET code is excluded.
    expect(filings.some((filing) => filing.accession === "S100SONY")).toBe(false);
    for (const filing of filings) {
      expect(filing.sourceUrl).toBe(EDINET_VIEWER_URL);
      expect(filing.source).toBe("EDINET");
    }
  });

  test("scans a single day when startDate equals endDate", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, documentsRoute]);
    await searchEdinetFilings(
      { company: "E02144", startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    const dayRequests = fetchFn.requests.filter((request) =>
      request.url.includes("documents.json"),
    );
    expect(dayRequests).toHaveLength(1);
    // The API key travels as a query parameter, not a header.
    expect(dayRequests[0]?.url).toContain("Subscription-Key=test-edinet-key");
  });

  test("applies a case-insensitive form filter", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, documentsRoute]);
    const filings = await searchEdinetFilings(
      {
        company: "E02144",
        forms: ["四半期"],
        startDate: "2026-08-05",
        endDate: "2026-08-05",
      },
      options(fetchFn),
    );
    expect(filings).toHaveLength(1);
    expect(filings[0]?.accession).toBe("S100QTR");
  });

  test("returns an empty list when the day index is empty", async () => {
    const fetchFn = routedFetch([
      edinetCodeListRoute,
      { pattern: "documents.json", body: edinetDay([], "404") },
    ]);
    const filings = await searchEdinetFilings(
      { company: "E02144", startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    expect(filings).toHaveLength(0);
  });
});

describe("getLatestEdinetReport", () => {
  test("returns the latest annual report with a viewer section link", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, documentsRoute]);
    const report = await getLatestEdinetReport("E02144", "annual", options(fetchFn));
    expect(report?.reportKind).toBe("annual");
    expect(report?.accession).toBe("S100ANNUAL");
    expect(report?.form).toBe("Annual securities report (有価証券報告書)");
    expect(report?.sectionLinks[0]?.url).toBe(EDINET_VIEWER_URL);
    expect(report?.sectionLinks[0]?.description).toContain("S100ANNUAL");
  });

  test("selects the quarterly doc-type for quarterly mode", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, documentsRoute]);
    const report = await getLatestEdinetReport("E02144", "quarterly", options(fetchFn));
    expect(report?.accession).toBe("S100QTR");
  });
});

// One calendar day of documents.json results for the reverse-lookup path: two
// large-volume holding reports whose *subject* issuer (issuerEdinetCode) is
// Toyota (E02144), plus rows that must be filtered out — a 350 for a different
// issuer, and a non-large-holding filing that happens to name Toyota.
const TOYOTA_HOLDERS_DAY = [
  {
    docID: "S100LVH1",
    edinetCode: "E12345",
    filerName: "野村アセットマネジメント株式会社",
    issuerEdinetCode: "E02144",
    docTypeCode: "350",
    docDescription: "大量保有報告書",
    currentReportReason: "新規保有",
    submitDateTime: "2026-08-04 09:00",
  },
  {
    docID: "S100LVH2",
    edinetCode: "E67890",
    filerName: "ブラックロック・ジャパン株式会社",
    issuerEdinetCode: "E02144",
    docTypeCode: "360",
    docDescription: "変更報告書",
    currentReportReason: "保有割合の変更",
    submitDateTime: "2026-08-05 10:00",
  },
  {
    // A large-holding report for a *different* issuer — must be excluded.
    docID: "S100LVHX",
    edinetCode: "E11111",
    filerName: "みずほ信託銀行株式会社",
    issuerEdinetCode: "E09999",
    docTypeCode: "350",
    docDescription: "大量保有報告書",
    submitDateTime: "2026-08-05 08:00",
  },
  {
    // Toyota is the filer here, not the subject of a large-holding report.
    docID: "S100ANN",
    edinetCode: "E02144",
    filerName: "トヨタ自動車株式会社",
    docTypeCode: "120",
    docDescription: "有価証券報告書",
    submitDateTime: "2026-08-05 07:00",
  },
];

const holdersRoute: Route = {
  pattern: "documents.json",
  body: edinetDay(TOYOTA_HOLDERS_DAY),
};

describe("getEdinetLargeHolders", () => {
  test("reverse-maps large-holding reports to the subject issuer", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, holdersRoute]);
    const owners = await getEdinetLargeHolders(
      "7203",
      { startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    // Only the two 350/360 rows whose issuerEdinetCode is Toyota, newest first.
    expect(owners.map((owner) => owner.accession)).toEqual(["S100LVH2", "S100LVH1"]);
    const change = owners[0];
    expect(change?.holderName).toBe("ブラックロック・ジャパン株式会社");
    expect(change?.holderType).toContain("変更報告書");
    expect(change?.form).toBe("Change report — large-volume holding (変更報告書)");
    expect(change?.filedDate).toBe("2026-08-05");
    expect(change?.notifiedDate).toBe("2026-08-05");
    expect(change?.naturesOfControl).toEqual(["保有割合の変更"]);
    expect(change?.pct).toBeUndefined();
    expect(change?.thresholdRegime).toBe(EDINET_5_PERCENT_THRESHOLD_REGIME);
    expect(change?.source).toBe("EDINET");
    expect(change?.sourceUrl).toBe(EDINET_VIEWER_URL);
    // sourceIdentifiers describe the subject issuer, not the filer.
    expect(change?.sourceIdentifiers?.edinetCode).toBe("E02144");
    expect(change?.sourceIdentifiers?.jurisdiction).toBe("JP");

    const initial = owners[1];
    expect(initial?.holderName).toBe("野村アセットマネジメント株式会社");
    expect(initial?.holderType).toContain("大量保有報告書");
    expect(initial?.form).toBe("Large-volume holding report (大量保有報告書)");
  });

  test("excludes large-holding reports for a different issuer", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, holdersRoute]);
    const owners = await getEdinetLargeHolders(
      "E02144",
      { startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    expect(owners.some((owner) => owner.accession === "S100LVHX")).toBe(false);
    // The non-large-holding annual report naming Toyota as filer is not an owner.
    expect(owners.some((owner) => owner.accession === "S100ANN")).toBe(false);
  });

  test("honours the limit and keeps the newest reports", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, holdersRoute]);
    const owners = await getEdinetLargeHolders(
      "E02144",
      { startDate: "2026-08-05", endDate: "2026-08-05", limit: 1 },
      options(fetchFn),
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.accession).toBe("S100LVH2");
  });

  test("returns no owners when no large-holding report names the issuer", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute, holdersRoute]);
    const owners = await getEdinetLargeHolders(
      "6758", // Sony — only its exclusion row exists, for a different subject
      { startDate: "2026-08-05", endDate: "2026-08-05" },
      options(fetchFn),
    );
    expect(owners).toHaveLength(0);
  });

  test("throws a configuration error without an API key (after resolution)", async () => {
    const fetchFn = routedFetch([edinetCodeListRoute]);
    await expect(
      getEdinetLargeHolders(
        "E02144",
        { startDate: "2026-08-05", endDate: "2026-08-05" },
        options(fetchFn, {}),
      ),
    ).rejects.toBeInstanceOf(EdinetConfigurationError);
  });
});

describe("rate limiting", () => {
  test("maps an HTTP 429 to EdinetRateLimitError", async () => {
    const fetchFn = routedFetch([
      edinetCodeListRoute,
      { pattern: "documents.json", body: {}, status: 429 },
    ]);
    await expect(
      searchEdinetFilings(
        { company: "E02144", startDate: "2026-08-05", endDate: "2026-08-05" },
        options(fetchFn),
      ),
    ).rejects.toBeInstanceOf(EdinetRateLimitError);
  });
});

describe("threshold regime constant", () => {
  test("names the Japanese 5% large-holding regime", () => {
    expect(EDINET_5_PERCENT_THRESHOLD_REGIME).toContain("大量保有報告書");
    expect(EDINET_5_PERCENT_THRESHOLD_REGIME).toContain("5%");
  });
});
