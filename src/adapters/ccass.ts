import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { HttpError } from "../core/http.js";
import { escapeRegExp, plainXmlText } from "../core/parsing.js";
import { ccassRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions, FetchFn } from "../core/types.js";

// CCASS (Central Clearing and Settlement System) Shareholding Search on HKEXnews
// (www3.hkexnews.hk/sdw/search/searchsdw.aspx). A keyless ASP.NET WebForms page —
// no captcha, no login, no token (verified live 2026-08-21). A single viewstate
// round-trip (GET the page for the hidden fields, then POST the 5-digit stock
// code) returns participant-level shareholding for a listed HK issuer.
//
// STRONG CAVEAT — what this is and isn't: CCASS shows shareholding at the CCASS
// *participant* level (custodian banks, brokers, HKSCC Nominees, and China's
// CSDC for Stock-Connect holdings) — the HK analogue of DTC / "Cede & Co."
// custodian concentration. It is NOT the beneficial-owner register: the SFO Part
// XV Disclosure of Interests (DI) register is the substantial-shareholder feed,
// and it remains captcha-walled (di.hkex.com.hk / sdinotice.hkex.com.hk). These
// rows must always be labelled as custodian/participant holdings, never as
// beneficial owners or regulatory disclosure-of-interests filings.
export const CCASS_SEARCH_URL =
  "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx";
export const CCASS_REQUEST_TIMEOUT_MS = 20_000;

export const CCASS_DEFAULT_TOP_N = 20;
export const CCASS_MAX_TOP_N = 100;

export const CCASS_THRESHOLD_REGIME =
  "HK CCASS participant snapshot (custodian-level)";

export const CCASS_RATE_LIMIT_MESSAGE =
  "HKEXnews CCASS search request limit reached. Please retry later.";

export const CCASS_OWNERS_CAVEAT =
  "These are CCASS *participant / custodian* holdings (custodian banks, brokers, " +
  "HKSCC Nominees, and China's CSDC for Stock-Connect shares) — the HK analogue " +
  "of DTC / \"Cede & Co.\" concentration. They are NOT beneficial owners and NOT " +
  "SFO Part XV disclosure-of-interests (DI) filings. The substantial-shareholder " +
  "DI register (beneficial owners) remains captcha-walled; look it up manually at " +
  "di.hkex.com.hk. A large custodian holding does not identify who beneficially " +
  "owns those shares.";

export class CcassRateLimitError extends AdapterRateLimitError {
  constructor(message = CCASS_RATE_LIMIT_MESSAGE) {
    super(message, 30, 60_000, "HKEXnews");
    this.name = "CcassRateLimitError";
  }
}

export class CcassApiError extends AdapterError {
  constructor(message: string) {
    super(message, "HKEXnews");
    this.name = "CcassApiError";
  }
}

function acquireRequest(): void {
  if (!ccassRateLimiter.tryAcquire()) throw new CcassRateLimitError();
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Referer: CCASS_SEARCH_URL,
};

// --- Types -----------------------------------------------------------------

export interface CcassParticipant {
  /** Participant ID, e.g. C00019. Empty for a Consenting Investor Participant. */
  participantId?: string;
  /** Participant name, e.g. THE HONGKONG AND SHANGHAI BANKING. */
  name: string;
  /** Number of shares held in CCASS by this participant. */
  shareholding: number;
  /** Percentage of total issued shares/warrants/units held by this participant. */
  pct: number;
}

export interface CcassSummaryRow {
  /** e.g. "Market Intermediaries", "Consenting Investor Participants", "Total". */
  category: string;
  shareholding: number;
  participants: number;
  pct: number;
}

export interface CcassShareholding {
  /** Zero-padded 5-digit SEHK stock code, e.g. 00700. */
  stockCode: string;
  /** Shareholding date used for the snapshot, yyyy/mm/dd (as the form returns). */
  shareholdingDate: string;
  /** Top-N participants by percentage of issued shares (capped by the caller). */
  participants: CcassParticipant[];
  /** Total participant rows returned before the top-N cap. */
  totalParticipants: number;
  /** Summary breakdown rows (Market Intermediaries / Investor Participants / Total). */
  summary: CcassSummaryRow[];
  /** Total number of issued shares/warrants/units (last updated figure), if shown. */
  totalIssuedShares?: number;
  /** The deep-link a human can reopen the search from. */
  sourceUrl: string;
}

export interface CcassSearchParams {
  /** yyyy/mm/dd. Defaults to the form's pre-filled latest available date. */
  date?: string;
  /** Top-N participants to return (default 20, capped at 100). */
  limit?: number;
}

// --- Hidden-field extraction -----------------------------------------------

/**
 * Read an ASP.NET WebForms hidden/input field's value out of the raw page HTML
 * (house-style regex). Matches `<input ... name="FIELD" ... value="VALUE" ...>`
 * regardless of attribute order, so `__VIEWSTATE`, `__VIEWSTATEGENERATOR`,
 * `today`, and `txtShareholdingDate` are all read the same way.
 */
export function readHiddenField(html: string, field: string): string | undefined {
  const escaped = escapeRegExp(field);
  // name before value (the common WebForms order): name="..." ... value="..."
  const forward = html.match(
    new RegExp(`name="${escaped}"[^>]*?\\bvalue="([^"]*)"`),
  );
  if (forward) return forward[1];
  // value before name (defensive): value="..." ... name="..."
  const backward = html.match(
    new RegExp(`\\bvalue="([^"]*)"[^>]*?\\sname="${escaped}"`),
  );
  return backward?.[1];
}

// --- Number parsing --------------------------------------------------------

/** "2,982,059,860" → 2982059860; undefined on an unparseable token. */
function parseGroupedInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return undefined;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** "32.75%" → 32.75; undefined on an unparseable token. */
function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/%/g, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// --- Result-table parsing --------------------------------------------------

/**
 * Pull a participant cell's rendered text by its column class. The data cells
 * wrap the value in `<div class="mobile-list-body">…</div>`. The class match is
 * anchored on the trailing `"` (id/name) or a space (`col-shareholding ` vs
 * `col-shareholding-percent `) so "shareholding" never captures the percent cell.
 */
function cellByColumn(rowHtml: string, columnMarker: string): string | undefined {
  const escaped = escapeRegExp(columnMarker);
  const match = rowHtml.match(
    new RegExp(
      `class="${escaped}[^"]*"[\\s\\S]*?mobile-list-body">([\\s\\S]*?)</div>`,
    ),
  );
  return match ? plainXmlText(match[1] ?? "") : undefined;
}

function parseParticipantRows(html: string): CcassParticipant[] {
  const participants: CcassParticipant[] = [];
  // Each participant is a <tr>…</tr> carrying a col-participant-id cell.
  for (const rowMatch of html.matchAll(/<tr\b[\s\S]*?<\/tr>/g)) {
    const row = rowMatch[0];
    if (!row.includes("col-participant-id")) continue;
    const name = cellByColumn(row, 'col-participant-name"');
    const shareholding = parseGroupedInt(cellByColumn(row, 'col-shareholding '));
    const pct = parsePercent(cellByColumn(row, 'col-shareholding-percent '));
    if (!name || shareholding === undefined || pct === undefined) continue;
    // The consenting-investor rows carry a "*" and no participant ID.
    const idRaw = cellByColumn(row, 'col-participant-id"');
    const participantId = idRaw && idRaw !== "" ? idRaw : undefined;
    participants.push({
      ...(participantId ? { participantId } : {}),
      name,
      shareholding,
      pct,
    });
  }
  return participants;
}

function parseSummaryRows(html: string): CcassSummaryRow[] {
  const summaryStart = html.indexOf("pnlResultSummary");
  if (summaryStart < 0) return [];
  const summaryEnd = html.indexOf("ccass-search-remarks", summaryStart);
  const block = html.slice(
    summaryStart,
    summaryEnd < 0 ? undefined : summaryEnd + 200,
  );
  const rows: CcassSummaryRow[] = [];
  for (const rowMatch of block.matchAll(
    /<div class="ccass-search-datarow[^"]*">([\s\S]*?)(?=<div class="ccass-search-datarow|<div class="ccass-search-remarks|$)/g,
  )) {
    const rowHtml = rowMatch[1] ?? "";
    const categoryMatch = rowHtml.match(
      /class="summary-category">([\s\S]*?)<\/div>/,
    );
    const category = categoryMatch ? plainXmlText(categoryMatch[1] ?? "") : "";
    // Three ordered value cells: shareholding, #participants, percent.
    const values = [
      ...rowHtml.matchAll(/class="value">([\s\S]*?)<\/div>/g),
    ].map((match) => plainXmlText(match[1] ?? ""));
    if (!category || values.length < 3) continue;
    const shareholding = parseGroupedInt(values[0]);
    const participants = parseGroupedInt(values[1]);
    const pct = parsePercent(values[2]);
    if (
      shareholding === undefined ||
      participants === undefined ||
      pct === undefined
    ) {
      continue;
    }
    rows.push({ category, shareholding, participants, pct });
  }
  return rows;
}

function parseTotalIssuedShares(html: string): number | undefined {
  const match = html.match(/class="summary-value">([\s\S]*?)<\/div>/);
  return match ? parseGroupedInt(plainXmlText(match[1] ?? "")) : undefined;
}

// --- HTTP round-trip -------------------------------------------------------

function normalizeStockCode(stockCode: string): string {
  const trimmed = stockCode.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    throw new CcassApiError(
      `"${stockCode}" is not a valid HK stock code (1-5 digits expected).`,
    );
  }
  return trimmed.padStart(5, "0");
}

/**
 * The POST returns the search page HTML as text. `fetch(...).text()` reads it
 * with the same timeout/error contract as the shared GET helpers. Cookie
 * pass-through: the endpoint does NOT require echoing the GET's session cookie
 * (verified live — the POST returns identical results with no Cookie header), so
 * we do not maintain a jar. We still echo a single Set-Cookie value if the GET
 * response exposes one, as a cheap defence against a future server-side change.
 */
async function fetchText(
  url: string,
  init: RequestInit,
  fetchFn: FetchFn,
): Promise<{ text: string; setCookie?: string }> {
  acquireRequest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CCASS_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new CcassApiError(
      `HKEXnews CCASS request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (response.status === 429) throw new CcassRateLimitError();
    throw new HttpError(
      `HTTP ${response.status} ${response.statusText}`.trim(),
      response.status,
      url,
    );
  }
  const setCookie = response.headers.get("set-cookie") ?? undefined;
  const text = await response.text();
  return setCookie ? { text, setCookie } : { text };
}

/** Extract `name=value` pairs from a Set-Cookie header for a minimal echo. */
function cookieHeaderFrom(setCookie: string | undefined): string | undefined {
  if (!setCookie) return undefined;
  const pairs = setCookie
    .split(/,(?=[^;,]+=)/)
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("="));
  return pairs.length ? pairs.join("; ") : undefined;
}

/**
 * Look up a listed HK issuer's CCASS participant-level shareholding. Returns the
 * top-N participants by percentage plus the summary breakdown, or a result with
 * an empty `participants` array when the code is unlisted / has no CCASS holding.
 */
export async function getCcassShareholding(
  stockCode: string,
  params: CcassSearchParams = {},
  options: AdapterOptions = {},
): Promise<CcassShareholding> {
  const code = normalizeStockCode(stockCode);
  const fetchFn = options.fetchFn ?? fetch;

  // 1) GET the search page for the viewstate hidden fields.
  const { text: pageHtml, setCookie } = await fetchText(
    CCASS_SEARCH_URL,
    { method: "GET", headers: BROWSER_HEADERS },
    fetchFn,
  );
  const viewState = readHiddenField(pageHtml, "__VIEWSTATE");
  const viewStateGenerator = readHiddenField(pageHtml, "__VIEWSTATEGENERATOR");
  if (!viewState || !viewStateGenerator) {
    throw new CcassApiError(
      "HKEXnews CCASS search page did not expose the expected ASP.NET " +
        "viewstate fields (the page layout may have changed).",
    );
  }
  const today = readHiddenField(pageHtml, "today") ?? "";
  // Optional field on some deployments; echoed only when present.
  const eventValidation = readHiddenField(pageHtml, "__EVENTVALIDATION");
  // Date: the form pre-fills the latest available shareholding date; honour it
  // when the caller supplies none.
  const date =
    params.date?.trim() ||
    readHiddenField(pageHtml, "txtShareholdingDate") ||
    "";

  // 2) POST the form. btnSearch is an anchor that calls __doPostBack('btnSearch'),
  // so the button is expressed via __EVENTTARGET, not a submit field.
  const body = new URLSearchParams({
    __EVENTTARGET: "btnSearch",
    __EVENTARGUMENT: "",
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    ...(eventValidation ? { __EVENTVALIDATION: eventValidation } : {}),
    today,
    txtStockCode: code,
    txtStockName: "",
    txtParticipantID: "",
    txtParticipantName: "",
    txtSelPartID: "",
    txtShareholdingDate: date,
  });
  const cookie = cookieHeaderFrom(setCookie);
  const { text: resultHtml } = await fetchText(
    CCASS_SEARCH_URL,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body.toString(),
    },
    fetchFn,
  );

  const allParticipants = parseParticipantRows(resultHtml).sort(
    (left, right) => right.pct - left.pct,
  );
  const limit = Math.min(
    Math.max(1, params.limit ?? CCASS_DEFAULT_TOP_N),
    CCASS_MAX_TOP_N,
  );
  const summary = parseSummaryRows(resultHtml);
  const totalIssuedShares = parseTotalIssuedShares(resultHtml);

  return {
    stockCode: code,
    shareholdingDate: date,
    participants: allParticipants.slice(0, limit),
    totalParticipants: allParticipants.length,
    summary,
    ...(totalIssuedShares !== undefined ? { totalIssuedShares } : {}),
    sourceUrl: CCASS_SEARCH_URL,
  };
}
