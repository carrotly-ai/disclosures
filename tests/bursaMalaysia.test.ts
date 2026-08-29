import { beforeEach, describe, expect, test } from "bun:test";
import {
  BURSA_ANNOUNCEMENT_CATEGORIES,
  BURSA_CHALLENGE_MESSAGE,
  BURSA_DISCLOSURE_DOCUMENT_URL,
  BURSA_INSIDER_FORM,
  BURSA_MAX_DETAIL_FETCHES,
  BURSA_OWNER_FORM,
  BURSA_SHAREHOLDING_CATEGORY,
  BURSA_THRESHOLD_REGIME,
  BursaApiError,
  BursaChallengeError,
  buildBursaSearchUrl,
  fetchBursaAnnouncementDetail,
  getBursaInsiders,
  getBursaOwners,
  holderNameFromTitle,
  isBursaStockCode,
  isCloudflareChallenge,
  parseBursaAnnouncementDocument,
  parseBursaAnnouncementRow,
  parseBursaDate,
  parseBursaSearchResponse,
  resolveBursaCompany,
  searchBursaCompanies,
  searchBursaFilings,
  toBursaDateParam,
} from "../src/adapters/bursaMalaysia.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

// Verbatim Bursa Malaysia payloads recorded live on 2026-08-29 through a
// challenge-solving browser session (the plain-fetch path is Cloudflare-walled,
// which the blocked-host tests below exercise separately):
//   - the Maybank (1155) announcements feed, a real mix of s.138 rows, a
//     securities announcement carrying a <p> sub-headline, and a quarterly
//     results row;
//   - the market-wide s.219 director-interest feed;
//   - the two announcement-document templates from disclosure.bursamalaysia.com.
const MAYBANK_FEED = loadFixture("bursa", "search-company-1155.json");
const DIRECTOR_FEED = loadFixture("bursa", "search-director-interest.json");
const DIRECTOR_DOC = loadFixture("bursa", "doc-director-3700853.html");
const SUBSHLDR_DOC = loadFixture("bursa", "doc-subshldr-3700039.html");

const EMPTY_FEED = JSON.stringify({
  recordsTotal: 0,
  recordsFiltered: 0,
  category_message: "",
  data: [],
});

// Cloudflare's managed-challenge interstitial, trimmed from the real 403 body
// this box received from www.bursamalaysia.com on 2026-08-29.
const CHALLENGE_HTML =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
  '<meta name="robots" content="noindex,nofollow"></head><body>' +
  '<noscript><div class="h2"><span id="challenge-error-text">Enable ' +
  "JavaScript and cookies to continue</span></div></noscript>" +
  "<script>window._cf_chl_opt = {cRay: 'a32c11917864fdb8'};</script>" +
  "</body></html>";

const searchRoute = (body: string, pattern: string | RegExp = "announcements/search"): Route => ({
  pattern,
  body,
  headers: { "Content-Type": "application/json; charset=utf-8" },
});

const documentRoute = (body: string): Route => ({
  pattern: "FileAccess/viewHtml",
  body,
  headers: { "Content-Type": "text/html; charset=UTF-8" },
});

beforeEach(() => {
  resetRateLimiters();
});

describe("bursaMalaysia helpers", () => {
  test("recognises Bursa stock codes, with or without instrument suffix", () => {
    expect(isBursaStockCode("1155")).toBe(true);
    expect(isBursaStockCode("1295")).toBe(true);
    expect(isBursaStockCode("1155or")).toBe(true); // case-insensitive suffix
    expect(isBursaStockCode("0800EA")).toBe(true);
    expect(isBursaStockCode("115")).toBe(false); // 3 digits
    expect(isBursaStockCode("11555")).toBe(false); // 5 digits, no suffix form
    expect(isBursaStockCode("MALAYAN BANKING BERHAD")).toBe(false);
  });

  test("normalises both Bursa date renderings to ISO", () => {
    // Feed cells and announcement-info tables render "28 Aug 2026"...
    expect(parseBursaDate("28 Aug 2026")).toBe("2026-08-28");
    expect(parseBursaDate("2 Jan 2020")).toBe("2020-01-02");
    // ...while the s.219 document body renders "26/08/2026".
    expect(parseBursaDate("26/08/2026")).toBe("2026-08-26");
    expect(parseBursaDate("2026-08-26")).toBe("2026-08-26");
    // The responsive date cell renders the date twice; both halves parse the same.
    expect(parseBursaDate("28 Aug 2026 28 Aug 2026")).toBe("2026-08-28");
    expect(parseBursaDate("not a date")).toBeUndefined();
    expect(parseBursaDate(undefined)).toBeUndefined();
  });

  test("renders ISO dates as the DD/MM/YYYY the search form wants", () => {
    expect(toBursaDateParam("2026-01-01")).toBe("01/01/2026");
    expect(toBursaDateParam("2026-08-31")).toBe("31/08/2026");
    // A value that is already in the upstream shape passes through untouched.
    expect(toBursaDateParam("31/08/2026")).toBe("31/08/2026");
  });

  test("extracts the holder name Bursa appends to the announcement title", () => {
    expect(
      holderNameFromTitle(
        "Changes in Director's Interest (Section 219 of CA 2016) - MR WONG WAI FOO",
      ),
    ).toBe("MR WONG WAI FOO");
    expect(
      holderNameFromTitle(
        "Changes in Sub. S-hldr's Int (Section 138 of CA 2016) - " +
          'KUMPULAN WANG PERSARAAN (DIPERBADANKAN) ("KWAP")',
      ),
    ).toBe('KUMPULAN WANG PERSARAAN (DIPERBADANKAN) ("KWAP")');
    // Amended announcements carry a trailing marker that is not part of the name.
    expect(
      holderNameFromTitle(
        "Changes in Director's Interest (Section 219 of CA 2016) - " +
          "MISS LIM XUI JHI (Amended Announcement)",
      ),
    ).toBe("MISS LIM XUI JHI");
    // Titles without the separator carry no holder.
    expect(holderNameFromTitle("Quarterly rpt on consolidated results")).toBeUndefined();
  });

  test("detects the Cloudflare interstitial by several markers", () => {
    expect(isCloudflareChallenge(CHALLENGE_HTML)).toBe(true);
    expect(isCloudflareChallenge("<title>Just a moment...</title>")).toBe(true);
    expect(isCloudflareChallenge("window._cf_chl_opt = {}")).toBe(true);
    expect(isCloudflareChallenge(MAYBANK_FEED)).toBe(false);
    expect(isCloudflareChallenge(DIRECTOR_DOC)).toBe(false);
  });

  test("builds the search URL from the form's own parameter names", () => {
    const url = buildBursaSearchUrl({
      stockCode: "1155",
      category: BURSA_SHAREHOLDING_CATEGORY,
      keyword: "Director",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      perPage: 5,
      page: 2,
    });
    expect(url).toContain("ann_type=company");
    expect(url).toContain("company=1155");
    expect(url).toContain(`cat=${encodeURIComponent(BURSA_SHAREHOLDING_CATEGORY)}`);
    expect(url).toContain("keyword=Director");
    expect(url).toContain(`dt_ht=${encodeURIComponent("01/01/2026")}`);
    expect(url).toContain(`dt_lt=${encodeURIComponent("31/03/2026")}`);
    expect(url).toContain("per_page=5");
    expect(url).toContain("page=2");
  });

  test("caps per_page at the form's own maximum and floors the page", () => {
    const url = buildBursaSearchUrl({ perPage: 5_000, page: 0 });
    expect(url).toContain("per_page=50");
    expect(url).toContain("page=1");
  });

  test("publishes the exchange's category taxonomy for the forms filter", () => {
    const values = BURSA_ANNOUNCEMENT_CATEGORIES.map((entry) => entry.value);
    expect(values).toContain(BURSA_SHAREHOLDING_CATEGORY);
    expect(values).toContain("FA,FRCO");
    expect(values).toContain("AR,ARCO");
  });
});

describe("bursaMalaysia row parsing", () => {
  test("unwraps a positional row's HTML cells into structured fields", () => {
    const row = parseBursaAnnouncementRow([
      "1",
      "<div class='d-lg-none'>28 Aug<br/>2026</div>" +
        "<div class='d-lg-inline-block d-none'>28 Aug 2026</div>",
      "<a href='/trade/trading_resources/listing_directory/company-profile" +
        "?stock_code=1155' target=_blank>MALAYAN BANKING BERHAD</a>",
      "<a href='/market_information/announcements/company_announcement/" +
        "announcement_details?ann_id=3700039' target=_blank>Changes in Sub. " +
        "S-hldr&#39;s Int (Section 138 of CA 2016) - EMPLOYEES PROVIDENT FUND " +
        "BOARD</a>",
    ]);
    expect(row).toBeDefined();
    expect(row?.date).toBe("2026-08-28");
    expect(row?.companyName).toBe("MALAYAN BANKING BERHAD");
    expect(row?.stockCode).toBe("1155");
    expect(row?.announcementId).toBe("3700039");
    expect(row?.title).toBe(
      "Changes in Sub. S-hldr's Int (Section 138 of CA 2016) - " +
        "EMPLOYEES PROVIDENT FUND BOARD",
    );
    expect(row?.detailsUrl).toContain("ann_id=3700039");
  });

  test("keeps the trailing <p> sub-headline separate from the title", () => {
    const { rows } = parseBursaSearchResponse(MAYBANK_FEED);
    const withSubtitle = rows.find((row) => row.subtitle);
    expect(withSubtitle?.title).toBe(
      "NEW ISSUE OF SECURITIES (CHAPTER 6 OF LISTING REQUIREMENTS) : " +
        "OTHER ISSUE OF SECURITIES",
    );
    expect(withSubtitle?.subtitle).toContain("DIVIDEND REINVESTMENT PLAN");
  });

  test("parses the real Maybank feed envelope and every row", () => {
    const { recordsTotal, rows } = parseBursaSearchResponse(MAYBANK_FEED);
    expect(recordsTotal).toBe(10_279);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.stockCode === "1155")).toBe(true);
    expect(rows.every((row) => row.date === "2026-08-28" || row.date === "2026-08-27"))
      .toBe(true);
  });

  test("returns an empty result set rather than throwing on no matches", () => {
    const { recordsTotal, rows } = parseBursaSearchResponse(EMPTY_FEED);
    expect(recordsTotal).toBe(0);
    expect(rows).toEqual([]);
  });

  test("rejects a non-JSON or unexpected payload honestly", () => {
    expect(() => parseBursaSearchResponse("<html>not json</html>")).toThrow(
      BursaApiError,
    );
    expect(() => parseBursaSearchResponse("[1,2,3]")).toThrow(BursaApiError);
  });
});

describe("bursaMalaysia announcement documents", () => {
  test("parses the s.219 director-interest template's structured fields", () => {
    const detail = parseBursaAnnouncementDocument(
      DIRECTOR_DOC,
      `${BURSA_DISCLOSURE_DOCUMENT_URL}?e=3700853`,
    );
    expect(detail.heading).toBe(
      "Changes in Director's Interest (Section 219 of CA 2016)",
    );
    expect(detail.companyName).toBe("TIMBERWELL BERHAD");
    expect(detail.holderName).toBe("MR WONG WAI FOO");
    expect(detail.securitiesClass).toBe("Ordinary Shares");
    // Two dated acquisitions in one announcement, each with its own registered
    // holder and consideration.
    expect(detail.transactions).toHaveLength(2);
    expect(detail.transactions[0]).toMatchObject({
      date: "2026-08-26",
      securities: 300_000,
      transactionType: "Acquired",
      natureOfInterest: "Direct Interest",
      consideration: "RM1.950 per ordinary share",
    });
    expect(detail.transactions[0]?.registeredHolder).toContain(
      "MBSB Investment Nominees",
    );
    expect(detail.transactions[1]).toMatchObject({
      date: "2026-08-27",
      securities: 200_000,
      transactionType: "Acquired",
    });
    expect(detail.directUnits).toBe(45_845_259);
    expect(detail.directPct).toBe(51.482);
    expect(detail.indirectUnits).toBe(17_060_251);
    expect(detail.indirectPct).toBe(19.158);
    expect(detail.circumstances).toBe("Acquisition Shares via Open Market");
    expect(detail.noticeDate).toBe("2026-08-28");
    expect(detail.announcedDate).toBe("2026-08-28");
    expect(detail.stockName).toBe("TIMWELL");
    expect(detail.referenceNumber).toBe("CS4-28082026-00026");
  });

  test("parses the s.138 substantial-shareholder template's structured fields", () => {
    const detail = parseBursaAnnouncementDocument(
      SUBSHLDR_DOC,
      `${BURSA_DISCLOSURE_DOCUMENT_URL}?e=3700039`,
    );
    expect(detail.heading).toBe(
      "Changes in Sub. S-hldr's Int (Section 138 of CA 2016)",
    );
    expect(detail.companyName).toBe("MALAYAN BANKING BERHAD");
    expect(detail.holderName).toBe("EMPLOYEES PROVIDENT FUND BOARD");
    expect(detail.transactions).toHaveLength(1);
    expect(detail.transactions[0]).toMatchObject({
      date: "2026-08-24",
      securities: 2_403_400,
      transactionType: "Disposed",
      natureOfInterest: "Direct Interest",
    });
    expect(detail.directUnits).toBe(1_511_246_097);
    expect(detail.directPct).toBe(12.494);
    // This template leaves the indirect columns blank; they must stay unset
    // rather than becoming a misleading zero.
    expect(detail.indirectUnits).toBeUndefined();
    expect(detail.indirectPct).toBeUndefined();
    expect(detail.totalAfterChange).toBe(1_511_246_097);
    expect(detail.circumstances).toBe("DISPOSAL OF SHARES");
    expect(detail.noticeDate).toBe("2026-08-26");
    expect(detail.noticeReceivedDate).toBe("2026-08-28");
    expect(detail.category).toContain("Section 138 of CA 2016");
  });

  test("fetches a document from the disclosure host by ann_id", async () => {
    const fetchFn = routedFetch([documentRoute(DIRECTOR_DOC)]);
    const detail = await fetchBursaAnnouncementDetail("3700853", { fetchFn });
    expect(detail.holderName).toBe("MR WONG WAI FOO");
    expect(fetchFn.requests[0]?.url).toBe(
      `${BURSA_DISCLOSURE_DOCUMENT_URL}?e=3700853`,
    );
  });
});

describe("bursaMalaysia CompanyResolve", () => {
  test("resolves an exact 4-digit stock code from the announcements surface", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    const entity = await resolveBursaCompany("1155", { fetchFn });
    expect(entity?.legalName).toBe("MALAYAN BANKING BERHAD");
    expect(entity?.stockCode).toBe("1155");
    expect(entity?.jurisdiction).toBe("MY");
    expect(entity?.source).toBe("Bursa Malaysia");
    expect(entity?.matchReason).toContain("Exact Bursa stock-code match");
    expect(entity?.sourceUrl).toContain("company-profile?stock_code=1155");
    // A code lookup uses the feed's `company` filter, not a keyword search.
    expect(fetchFn.requests[0]?.url).toContain("company=1155");
    expect(fetchFn.requests[0]?.url).not.toContain("keyword=");
  });

  test("resolves a name to the distinct issuers in the keyword feed", async () => {
    const fetchFn = routedFetch([searchRoute(DIRECTOR_FEED)]);
    const results = await searchBursaCompanies("GLOMAC", { fetchFn });
    // The director feed names four issuers across five rows; GLOMAC appears
    // three times and must collapse to one candidate.
    expect(results.filter((entity) => entity.legalName === "GLOMAC BERHAD"))
      .toHaveLength(1);
    expect(results[0]?.legalName).toBe("GLOMAC BERHAD");
    expect(results[0]?.stockCode).toBe("5020");
    expect(fetchFn.requests[0]?.url).toContain("keyword=GLOMAC");
  });

  test("returns no candidates when the feed is empty", async () => {
    const fetchFn = routedFetch([searchRoute(EMPTY_FEED)]);
    expect(await searchBursaCompanies("NO SUCH ISSUER", { fetchFn })).toEqual([]);
    expect(await resolveBursaCompany("9999", { fetchFn })).toBeNull();
  });

  test("returns nothing for a blank query without touching the network", async () => {
    const fetchFn = routedFetch([]);
    expect(await searchBursaCompanies("   ", { fetchFn })).toEqual([]);
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe("bursaMalaysia CompanyFilings", () => {
  test("returns the announcement feed with links, ids and the record total", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    const { entity, recordsTotal, filings } = await searchBursaFilings(
      "1155",
      { fetchFn },
    );
    expect(entity.stockCode).toBe("1155");
    expect(recordsTotal).toBe(10_279);
    expect(filings).toHaveLength(4);
    const quarterly = filings.find((filing) =>
      filing.form.startsWith("Quarterly rpt")
    );
    expect(quarterly?.filedDate).toBe("2026-08-27");
    expect(quarterly?.accession).toBe("3698925");
    expect(quarterly?.sourceUrl).toContain("ann_id=3698925");
    expect(quarterly?.source).toBe("Bursa Malaysia");
    expect(quarterly?.sourceIdentifiers?.jurisdiction).toBe("MY");
    // The <p> sub-headline becomes the filing's category/description detail.
    const securities = filings.find((filing) => filing.category);
    expect(securities?.description).toContain("DIVIDEND REINVESTMENT PLAN");
  });

  test("passes the date window and category through to the feed", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    await searchBursaFilings({
      company: "1155",
      category: BURSA_SHAREHOLDING_CATEGORY,
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    }, { fetchFn });
    // Request 0 resolves the code; request 1 is the filtered filings query.
    const filingsRequest = fetchFn.requests[1]?.url ?? "";
    expect(filingsRequest).toContain(
      `cat=${encodeURIComponent(BURSA_SHAREHOLDING_CATEGORY)}`,
    );
    expect(filingsRequest).toContain(`dt_ht=${encodeURIComponent("01/01/2026")}`);
    expect(filingsRequest).toContain(`dt_lt=${encodeURIComponent("31/03/2026")}`);
  });

  test("honours the limit both in the request and in the returned rows", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    const { filings } = await searchBursaFilings(
      { company: "1155", limit: 2 },
      { fetchFn },
    );
    expect(filings).toHaveLength(2);
    expect(fetchFn.requests[1]?.url).toContain("per_page=2");
  });

  test("reports no filings honestly when the window is empty", async () => {
    const fetchFn = routedFetch([
      searchRoute(MAYBANK_FEED, /company=1155(?!.*dt_ht)/),
      searchRoute(EMPTY_FEED, "dt_ht"),
    ]);
    const { filings, recordsTotal } = await searchBursaFilings({
      company: "1155",
      startDate: "1999-01-01",
      endDate: "1999-12-31",
    }, { fetchFn });
    expect(filings).toEqual([]);
    expect(recordsTotal).toBe(0);
  });

  test("says so honestly when the company cannot be resolved", async () => {
    const fetchFn = routedFetch([searchRoute(EMPTY_FEED)]);
    await expect(searchBursaFilings("NOPE BERHAD", { fetchFn })).rejects.toThrow(
      /No Bursa company found/i,
    );
  });
});

describe("bursaMalaysia CompanyInsiders (s.219 director interest)", () => {
  test("parses director name, transaction and resulting holding", async () => {
    const fetchFn = routedFetch([
      searchRoute(DIRECTOR_FEED),
      documentRoute(DIRECTOR_DOC),
    ]);
    const { rows, detailedCount } = await getBursaInsiders("7854", { fetchFn });
    expect(rows.length).toBeGreaterThan(0);
    expect(detailedCount).toBeGreaterThan(0);
    const wong = rows.find((insider) => insider.name === "MR WONG WAI FOO");
    expect(wong).toBeDefined();
    expect(wong?.form).toBe(BURSA_INSIDER_FORM);
    expect(wong?.roles).toEqual(["Director"]);
    expect(wong?.filedDate).toBe("2026-08-28");
    expect(wong?.notifiedDate).toBe("2026-08-26");
    expect(wong?.occupation).toBe("Acquired (Direct Interest)");
    expect(wong?.change).toBe(300_000);
    expect(wong?.pct).toBe(51.482);
    expect(wong?.status).toBe("Acquisition Shares via Open Market");
    expect(wong?.accession).toBe("3700853");
    expect(wong?.sourceUrl).toContain("ann_id=3700853");
    expect(wong?.sourceIdentifiers?.jurisdiction).toBe("MY");
  });

  test("filters the shared shareholding category down to s.219 rows only", async () => {
    const fetchFn = routedFetch([
      searchRoute(MAYBANK_FEED),
      documentRoute(SUBSHLDR_DOC),
    ]);
    const { rows } = await getBursaInsiders("1155", { fetchFn });
    // The Maybank feed carries s.138 rows, a securities announcement and a
    // quarterly result — no s.219 rows, so insiders must be empty rather than
    // borrowing the s.138 rows that share the category.
    expect(rows).toEqual([]);
    // The category filter is requested server-side.
    expect(fetchFn.requests[1]?.url).toContain(
      `cat=${encodeURIComponent(BURSA_SHAREHOLDING_CATEGORY)}`,
    );
  });

  test("returns the honest announcement list when detail is not requested", async () => {
    const fetchFn = routedFetch([searchRoute(DIRECTOR_FEED)]);
    const { rows, detailedCount, detailNote } = await getBursaInsiders(
      { company: "7854", withDetail: false },
      { fetchFn },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(detailedCount).toBe(0);
    // Holder name still comes from the announcement title, and the note says
    // plainly where the per-transaction detail lives.
    expect(rows[0]?.name).toBe("MR WONG WAI FOO");
    expect(rows[0]?.change).toBeUndefined();
    expect(rows[0]?.pct).toBeUndefined();
    expect(detailNote).toContain("links to the official Bursa announcement");
    // No document host was contacted.
    expect(fetchFn.requests.every(({ url }) => !url.includes("FileAccess")))
      .toBe(true);
  });

  test("caps how many announcement documents one call opens", () => {
    expect(BURSA_MAX_DETAIL_FETCHES).toBeLessThanOrEqual(10);
  });
});

describe("bursaMalaysia CompanyOwners (s.138 substantial shareholders)", () => {
  test("parses holder, transaction direction and resulting percentage", async () => {
    const fetchFn = routedFetch([
      searchRoute(MAYBANK_FEED),
      documentRoute(SUBSHLDR_DOC),
    ]);
    const { entity, rows, detailedCount } = await getBursaOwners("1155", { fetchFn });
    expect(entity.stockCode).toBe("1155");
    // Two of the four Maybank rows are s.138 announcements.
    expect(rows).toHaveLength(2);
    expect(detailedCount).toBeGreaterThan(0);
    const epf = rows.find((owner) =>
      owner.holderName === "EMPLOYEES PROVIDENT FUND BOARD"
    );
    expect(epf).toBeDefined();
    expect(epf?.form).toBe(BURSA_OWNER_FORM);
    expect(epf?.holderType).toBe("Substantial shareholder");
    expect(epf?.thresholdRegime).toBe(BURSA_THRESHOLD_REGIME);
    expect(epf?.thresholdRegime).toBe(
      "MY Companies Act 2016 s.137/138 substantial shareholding",
    );
    expect(epf?.filedDate).toBe("2026-08-28");
    expect(epf?.pct).toBe(12.494);
    expect(epf?.crossingDate).toBe("2026-08-24");
    expect(epf?.crossingDirection).toBe("down"); // "Disposed"
    expect(epf?.change).toBe(-2_403_400);
    expect(epf?.naturesOfControl).toContain("Direct Interest");
    expect(epf?.naturesOfControl).toContain("DISPOSAL OF SHARES");
    expect(epf?.machineReadable).toBe(true);
    expect(epf?.accession).toBe("3700039");
    expect(epf?.sourceUrl).toContain("ann_id=3700039");
  });

  test("filters the shared shareholding category down to s.138 rows only", async () => {
    const fetchFn = routedFetch([
      searchRoute(DIRECTOR_FEED),
      documentRoute(DIRECTOR_DOC),
    ]);
    const { rows } = await getBursaOwners("7854", { fetchFn });
    // The s.219 feed carries no substantial-shareholder rows.
    expect(rows).toEqual([]);
  });

  test("returns the honest announcement list when detail is not requested", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    const { rows, detailedCount, detailNote } = await getBursaOwners(
      { company: "1155", withDetail: false },
      { fetchFn },
    );
    expect(rows).toHaveLength(2);
    expect(detailedCount).toBe(0);
    expect(rows[0]?.holderName).toBe("EMPLOYEES PROVIDENT FUND BOARD");
    expect(rows[0]?.thresholdRegime).toBe(BURSA_THRESHOLD_REGIME);
    // Link-only rows must not claim a percentage they did not read.
    expect(rows[0]?.pct).toBeUndefined();
    expect(rows[0]?.machineReadable).toBeUndefined();
    expect(detailNote).toContain("links to the official Bursa announcement");
  });

  test("reports no owners honestly when the feed is empty", async () => {
    const fetchFn = routedFetch([
      searchRoute(MAYBANK_FEED, /company=1155(?!.*cat=)/),
      searchRoute(EMPTY_FEED, "cat="),
    ]);
    const { rows } = await getBursaOwners("1155", { fetchFn });
    expect(rows).toEqual([]);
  });
});

describe("bursaMalaysia Cloudflare posture", () => {
  test("a 403 interstitial becomes the honest fetchFn message, not empty data", async () => {
    const fetchFn = routedFetch([
      { pattern: "announcements/search", body: CHALLENGE_HTML, status: 403 },
    ]);
    const error = await searchBursaCompanies("1155", { fetchFn }).catch((e) => e);
    expect(error).toBeInstanceOf(BursaChallengeError);
    expect(error.message).toBe(BURSA_CHALLENGE_MESSAGE);
    expect(error.message).toContain("AdapterOptions.fetchFn");
    expect(error.message).toContain("will not fabricate");
  });

  test("a 200 interstitial is caught too, rather than parsed as data", async () => {
    const fetchFn = routedFetch([
      {
        pattern: "announcements/search",
        body: CHALLENGE_HTML,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      },
    ]);
    await expect(searchBursaCompanies("1155", { fetchFn })).rejects.toThrow(
      BursaChallengeError,
    );
  });

  test("a challenge on the document host surfaces rather than degrading silently", async () => {
    const fetchFn = routedFetch([
      searchRoute(DIRECTOR_FEED),
      { pattern: "FileAccess/viewHtml", body: CHALLENGE_HTML, status: 403 },
    ]);
    await expect(getBursaInsiders("7854", { fetchFn })).rejects.toThrow(
      BursaChallengeError,
    );
  });

  test("every MY intent names the escape hatch when challenged", async () => {
    for (const call of [
      () => searchBursaCompanies("1155", { fetchFn: challengeFetch() }),
      () => searchBursaFilings("1155", { fetchFn: challengeFetch() }),
      () => getBursaInsiders("1155", { fetchFn: challengeFetch() }),
      () => getBursaOwners("1155", { fetchFn: challengeFetch() }),
    ]) {
      resetRateLimiters();
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(BursaChallengeError);
      expect(error.message).toContain("AdapterOptions.fetchFn");
    }
  });

  function challengeFetch() {
    return routedFetch([
      { pattern: "bursamalaysia.com", body: CHALLENGE_HTML, status: 403 },
    ]);
  }
});

describe("bursaMalaysia upstream failures", () => {
  test("a 500 surfaces as an error rather than an empty result", async () => {
    const fetchFn = routedFetch([
      { pattern: "announcements/search", body: "upstream error", status: 500 },
    ]);
    await expect(searchBursaCompanies("1155", { fetchFn })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  test("a 429 becomes a retryable rate-limit error", async () => {
    const fetchFn = routedFetch([
      { pattern: "announcements/search", body: "slow down", status: 429 },
    ]);
    const error = await searchBursaCompanies("1155", { fetchFn }).catch((e) => e);
    expect(error.name).toBe("BursaRateLimitError");
    expect(error.message).toContain("retry later");
  });

  test("a malformed body surfaces honestly instead of parsing as empty", async () => {
    const fetchFn = routedFetch([searchRoute("{not json at all")]);
    await expect(searchBursaCompanies("1155", { fetchFn })).rejects.toThrow(
      BursaApiError,
    );
  });

  test("the local budget trips before hammering the challenged host", async () => {
    const fetchFn = routedFetch([searchRoute(MAYBANK_FEED)]);
    let error: unknown;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await searchBursaCompanies("1155", { fetchFn });
      } catch (caught) {
        error = caught;
        break;
      }
    }
    expect((error as Error)?.name).toBe("BursaRateLimitError");
  });
});
