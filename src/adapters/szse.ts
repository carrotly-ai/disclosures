import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getJson, HttpError } from "../core/http.js";
import { asArray, asRecord, asString } from "../core/parsing.js";
import { szseRateLimiter } from "../core/rateLimiter.js";
import type { AdapterOptions } from "../core/types.js";

// The Shenzhen Stock Exchange publishes 董监高及相关人员股份变动 (director/
// supervisor/senior-management and related-party share-change) disclosures
// through a keyless JSON endpoint that backs its public query page
// (www.szse.cn/disclosure/supervision/change). It is a plain GET returning
// [{ metadata, data }], filterable by stock code, newest-first, and requires
// only a szse.cn Referer (how the site serves its own page — not a wall). This
// is the structured feed CN CompanyInsiders routes SZSE-listed issuers to
// (0xxxxx main board / 3xxxxx ChiNext); SSE issuers (6xxxxx) have no equivalent
// clean feed and fall back to the annual-report 董监高 roster PDF.
export const SZSE_INSIDER_URL =
  "https://www.szse.cn/api/report/ShowReport/data";
export const SZSE_INSIDER_CATALOG = "1801_cxda";
export const SZSE_INSIDER_REFERER =
  "https://www.szse.cn/disclosure/supervision/change/index.html";
export const SZSE_REQUEST_TIMEOUT_MS = 20_000;
/** The server fixes the page size at 20 rows. */
export const SZSE_INSIDER_PAGE_SIZE = 20;
/** Cap on pages fetched per CompanyInsiders call (politeness + bounded window). */
export const SZSE_INSIDER_MAX_PAGES = 3;

export const SZSE_INSIDER_THRESHOLD_REGIME =
  "SZSE 董监高及相关人员股份变动 (per-transaction director/supervisor/senior-" +
  "management share-change disclosures, CSRC/exchange rules); each row is one " +
  "reported transaction settled at China Securities Depository, newest first.";

export const SZSE_RATE_LIMIT_MESSAGE =
  "SZSE disclosure request limit reached. Please retry later.";

export class SzseRateLimitError extends AdapterRateLimitError {
  constructor(message = SZSE_RATE_LIMIT_MESSAGE) {
    super(message, 120, 60_000, "SZSE");
    this.name = "SzseRateLimitError";
  }
}

export class SzseApiError extends AdapterError {
  constructor(message: string) {
    super(message, "SZSE");
    this.name = "SzseApiError";
  }
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Referer: SZSE_INSIDER_REFERER,
};

/** One reported 董监高 share-change transaction. */
export interface SzseInsiderChange {
  stockCode: string;
  stockName?: string;
  /** 董监高姓名 — the director/supervisor/senior manager. */
  insiderName: string;
  /** 职务 — reported position(s), e.g. 董事、高管. */
  position?: string;
  /** 变动日期 (YYYY-MM-DD). */
  changeDate: string;
  /** 变动股份数量, normalized from 万股 to whole shares (negative = disposal). */
  sharesChanged?: number;
  /** 成交均价 (yuan per share). */
  avgPrice?: number;
  /** 变动原因, e.g. 竞价交易 / 大宗交易 / 盘后定价. */
  reason?: string;
  /** 变动比例 (per mille, ‰, of total share capital). */
  changeRatioPermille?: number;
  /** 当日结存股数, normalized from 万股 to whole shares. */
  balanceShares?: number;
  /** 股份变动人姓名 — the actual holder (often the insider; may be a relative). */
  holderName?: string;
  /** 变动人与董监高的关系, e.g. 本人 / 配偶. */
  relationship?: string;
}

function acquire(): void {
  if (!szseRateLimiter.tryAcquire()) throw new SzseRateLimitError();
}

function parseSzseNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, "").replace(/−/g, "-").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** 万股 (ten-thousand shares) → whole shares. */
function wanSharesToShares(raw: string | undefined): number | undefined {
  const value = parseSzseNumber(raw);
  return value === undefined ? undefined : Math.round(value * 10_000);
}

function rowToChange(value: unknown): SzseInsiderChange | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const insiderName = asString(row.ggxm);
  const changeDate = asString(row.jyrq);
  const stockCode = asString(row.zqdm);
  if (!insiderName || !changeDate || !stockCode) return undefined;
  const stockName = asString(row.zqjc);
  const position = asString(row.zw);
  const sharesChanged = wanSharesToShares(asString(row.bdgs));
  const avgPrice = parseSzseNumber(asString(row.bdjj));
  const reason = asString(row.bdyy);
  const changeRatioPermille = parseSzseNumber(asString(row.cgbdbl));
  const balanceShares = wanSharesToShares(asString(row.cgzs));
  const holderName = asString(row.gdxm);
  const relationship = asString(row.gxlb);
  return {
    stockCode,
    ...(stockName ? { stockName } : {}),
    insiderName,
    ...(position ? { position } : {}),
    changeDate,
    ...(sharesChanged !== undefined ? { sharesChanged } : {}),
    ...(avgPrice !== undefined ? { avgPrice } : {}),
    ...(reason ? { reason } : {}),
    ...(changeRatioPermille !== undefined ? { changeRatioPermille } : {}),
    ...(balanceShares !== undefined ? { balanceShares } : {}),
    ...(holderName ? { holderName } : {}),
    ...(relationship ? { relationship } : {}),
  };
}

async function fetchPage(
  stockCode: string,
  pageNo: number,
  options: AdapterOptions,
): Promise<{ changes: SzseInsiderChange[]; recordCount: number }> {
  acquire();
  const params = new URLSearchParams({
    SHOWTYPE: "JSON",
    CATALOGID: SZSE_INSIDER_CATALOG,
    TABKEY: "tab1",
    txtDMorJC: stockCode,
    PAGENO: String(pageNo),
    random: Math.random().toString().slice(2, 8),
  });
  let payload: unknown;
  try {
    payload = await getJson(
      `${SZSE_INSIDER_URL}?${params.toString()}`,
      BROWSER_HEADERS,
      SZSE_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new SzseRateLimitError();
    }
    throw error;
  }
  // The endpoint returns a bare array [{ metadata, data }].
  const first = asRecord(asArray(payload)[0]);
  if (!first) return { changes: [], recordCount: 0 };
  const recordCountRaw = asRecord(first.metadata)?.recordcount;
  const recordCount = typeof recordCountRaw === "number"
    ? recordCountRaw
    : parseSzseNumber(asString(recordCountRaw)) ?? 0;
  const changes = asArray(first.data).flatMap((item) => {
    const change = rowToChange(item);
    return change ? [change] : [];
  });
  return { changes, recordCount };
}

/**
 * Fetch a SZSE-listed issuer's most recent 董监高 share-change transactions,
 * newest first, bounded to `limit` rows (paging the fixed-20 server pages up to
 * SZSE_INSIDER_MAX_PAGES). An SSE stock code (6xxxxx) legitimately returns an
 * empty array — it is not carried by this Shenzhen feed.
 */
export async function getSzseInsiderChanges(
  stockCode: string,
  options: AdapterOptions = {},
  limit = 40,
): Promise<SzseInsiderChange[]> {
  const code = stockCode.trim();
  if (!/^\d{6}$/.test(code)) return [];
  const collected: SzseInsiderChange[] = [];
  for (let page = 1; page <= SZSE_INSIDER_MAX_PAGES; page += 1) {
    const { changes, recordCount } = await fetchPage(code, page, options);
    collected.push(...changes);
    if (collected.length >= limit) break;
    if (page * SZSE_INSIDER_PAGE_SIZE >= recordCount || changes.length === 0) break;
  }
  return collected.slice(0, limit);
}
