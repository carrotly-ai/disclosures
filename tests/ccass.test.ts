import { beforeEach, describe, expect, test } from "bun:test";
import {
  CCASS_DEFAULT_TOP_N,
  CCASS_SEARCH_URL,
  CcassApiError,
  CcassRateLimitError,
  getCcassShareholding,
  readHiddenField,
} from "../src/adapters/ccass.js";
import { ccassRateLimiter, resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, FetchFn } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";

const searchPage = loadFixture("ccass", "search-page.html");
const result00700 = loadFixture("ccass", "result-00700.html");
const resultEmpty = loadFixture("ccass", "result-empty.html");

interface StubOptions {
  postBody?: string;
  status?: number;
  setCookie?: string;
}

/**
 * The CCASS endpoint uses the SAME url for the GET (viewstate page) and the POST
 * (result table), so routedFetch (url-only matching) cannot distinguish them. A
 * method-aware stub returns the search page on GET and the result on POST, and
 * records every request for assertions on the round-trip.
 */
function methodAwareFetch(
  { postBody = result00700, status = 200, setCookie }: StubOptions = {},
): FetchFn & { requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stub = (async (url: string, init?: RequestInit) => {
    requests.push({ url, ...(init ? { init } : {}) });
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      const headers = new Headers({ "Content-Type": "text/html" });
      if (setCookie) headers.set("set-cookie", setCookie);
      return new Response(searchPage, { status: 200, headers });
    }
    return new Response(postBody, {
      status,
      headers: { "Content-Type": "text/html" },
    });
  }) as FetchFn & { requests: Array<{ url: string; init?: RequestInit }> };
  stub.requests = requests;
  return stub;
}

function options(fetchFn: FetchFn): AdapterOptions {
  return { fetchFn };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("readHiddenField", () => {
  test("reads viewstate/generator/date regardless of attribute order", () => {
    expect(readHiddenField(searchPage, "__VIEWSTATE")).toBe(
      "/wEPDwULLTE1Nzg3NjcwNjdkZJW3ITBSFIXTUREVIEWSTATE",
    );
    expect(readHiddenField(searchPage, "__VIEWSTATEGENERATOR")).toBe("A7B2BBE2");
    expect(readHiddenField(searchPage, "today")).toBe("20260821");
    expect(readHiddenField(searchPage, "txtShareholdingDate")).toBe("2026/08/20");
  });

  test("returns undefined for an absent field", () => {
    expect(readHiddenField(searchPage, "__EVENTVALIDATION")).toBeUndefined();
  });
});

describe("getCcassShareholding", () => {
  test("round-trips the viewstate and posts a zero-padded stock code", async () => {
    const fetchFn = methodAwareFetch();
    await getCcassShareholding("700", {}, options(fetchFn));

    expect(fetchFn.requests).toHaveLength(2);
    const [getReq, postReq] = fetchFn.requests;
    expect(getReq?.init?.method ?? "GET").toBe("GET");
    expect(postReq?.init?.method).toBe("POST");
    const body = String(postReq?.init?.body ?? "");
    const form = new URLSearchParams(body);
    // Viewstate from the GET page is echoed on the POST.
    expect(form.get("__VIEWSTATE")).toBe(
      "/wEPDwULLTE1Nzg3NjcwNjdkZJW3ITBSFIXTUREVIEWSTATE",
    );
    expect(form.get("__VIEWSTATEGENERATOR")).toBe("A7B2BBE2");
    // btnSearch is an anchor → expressed via __EVENTTARGET, not a submit field.
    expect(form.get("__EVENTTARGET")).toBe("btnSearch");
    // "700" is zero-padded to the 5-digit SEHK code.
    expect(form.get("txtStockCode")).toBe("00700");
    // Absent __EVENTVALIDATION is not sent.
    expect(form.has("__EVENTVALIDATION")).toBe(false);
    // The form's pre-filled latest date is used when no date is supplied.
    expect(form.get("txtShareholdingDate")).toBe("2026/08/20");
  });

  test("parses participants sorted by percentage and honours the top-N cap", async () => {
    const result = await getCcassShareholding(
      "00700",
      { limit: 2 },
      options(methodAwareFetch()),
    );
    expect(result.stockCode).toBe("00700");
    expect(result.shareholdingDate).toBe("2026/08/20");
    expect(result.totalParticipants).toBe(4);
    expect(result.participants).toHaveLength(2);
    // Highest percentage first even though the fixture lists it second.
    expect(result.participants[0]).toEqual({
      participantId: "C00019",
      name: "THE HONGKONG AND SHANGHAI BANKING",
      shareholding: 2_982_059_860,
      pct: 32.75,
    });
    expect(result.participants[1]?.participantId).toBe("C00010");
    expect(result.participants[1]?.pct).toBe(6.6);
  });

  test("parses grouped shareholding integers and a Consenting Investor row with no ID", async () => {
    const result = await getCcassShareholding(
      "00700",
      { limit: 20 },
      options(methodAwareFetch()),
    );
    const consenting = result.participants.find((p) => !p.participantId);
    expect(consenting).toBeDefined();
    expect(consenting?.name).toBe("A CONSENTING INVESTOR *");
    expect(consenting?.shareholding).toBe(22_400);
    expect(consenting?.pct).toBe(0);
  });

  test("parses the summary breakdown and total issued shares", async () => {
    const result = await getCcassShareholding("00700", {}, options(methodAwareFetch()));
    expect(result.totalIssuedShares).toBe(9_103_125_600);
    const total = result.summary.find((row) => row.category === "Total");
    expect(total).toEqual({
      category: "Total",
      shareholding: 7_060_197_538,
      participants: 826,
      pct: 77.55,
    });
    const mi = result.summary.find((row) => row.category === "Market Intermediaries");
    expect(mi?.pct).toBe(77.51);
  });

  test("defaults the top-N cap to 20 participants", () => {
    expect(CCASS_DEFAULT_TOP_N).toBe(20);
  });

  test("returns an empty participant list for an unlisted code", async () => {
    const result = await getCcassShareholding(
      "99999",
      {},
      options(methodAwareFetch({ postBody: resultEmpty })),
    );
    expect(result.participants).toEqual([]);
    expect(result.totalParticipants).toBe(0);
    expect(result.summary).toEqual([]);
    expect(result.totalIssuedShares).toBeUndefined();
  });

  test("rejects a non-numeric stock code before any network call", async () => {
    const fetchFn = methodAwareFetch();
    await expect(
      getCcassShareholding("NOTACODE", {}, options(fetchFn)),
    ).rejects.toBeInstanceOf(CcassApiError);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("surfaces an upstream failure as a CcassApiError", async () => {
    const fetchFn = (async () => {
      throw new Error("connection reset");
    }) as FetchFn;
    await expect(
      getCcassShareholding("00700", {}, options(fetchFn)),
    ).rejects.toBeInstanceOf(CcassApiError);
  });

  test("throws when the page exposes no viewstate fields", async () => {
    const fetchFn = (async () =>
      new Response("<html><body>no fields here</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as FetchFn;
    await expect(
      getCcassShareholding("00700", {}, options(fetchFn)),
    ).rejects.toBeInstanceOf(CcassApiError);
  });

  test("echoes a session cookie from the GET onto the POST when present", async () => {
    const fetchFn = methodAwareFetch({ setCookie: "bm_so=abc123; Path=/; Secure" });
    await getCcassShareholding("00700", {}, options(fetchFn));
    const postReq = fetchFn.requests[1];
    const headers = new Headers(postReq?.init?.headers as HeadersInit);
    expect(headers.get("cookie")).toBe("bm_so=abc123");
  });

  test("uses a caller-supplied shareholding date over the form default", async () => {
    const fetchFn = methodAwareFetch();
    await getCcassShareholding("00700", { date: "2025/12/31" }, options(fetchFn));
    const form = new URLSearchParams(String(fetchFn.requests[1]?.init?.body ?? ""));
    expect(form.get("txtShareholdingDate")).toBe("2025/12/31");
  });

  test("maps HTTP 429 to a CcassRateLimitError", async () => {
    const fetchFn = methodAwareFetch({ status: 429 });
    await expect(
      getCcassShareholding("00700", {}, options(fetchFn)),
    ).rejects.toBeInstanceOf(CcassRateLimitError);
  });

  test("trips its own rate limiter after the configured budget", async () => {
    while (ccassRateLimiter.tryAcquire()) {
      /* drain the window */
    }
    await expect(
      getCcassShareholding("00700", {}, options(methodAwareFetch())),
    ).rejects.toBeInstanceOf(CcassRateLimitError);
  });

  test("points at the public CCASS search URL", () => {
    expect(CCASS_SEARCH_URL).toContain("searchsdw.aspx");
  });
});
