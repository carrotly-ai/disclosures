import {
  AdapterError,
  AdapterRateLimitError,
} from "../core/errors.js";
import { getBinary, HttpError, postForm } from "../core/http.js";
import { asArray, asRecord, asString, countPdfPages } from "../core/parsing.js";
import { extractPdfText } from "../core/pdfText.js";
import { cninfoRateLimiter } from "../core/rateLimiter.js";
import { getSzseInsiderChanges } from "./szse.js";
import type { SzseInsiderChange } from "./szse.js";
import type {
  AdapterOptions,
  Entity,
  Filing,
  FinancialFact,
  LatestReportMetadata,
} from "../core/types.js";

// cninfo (巨潮资讯网) is the CSRC-designated disclosure portal for the Shanghai
// (SSE) and Shenzhen (SZSE) exchanges, and also mirrors many Hong Kong (HKEX)
// filings. It exposes a keyless company search plus a date-filterable
// announcement feed; both are POST form endpoints returning JSON.
export const CNINFO_BASE_URL = "https://www.cninfo.com.cn";
export const CNINFO_SEARCH_URL =
  "https://www.cninfo.com.cn/new/information/topSearch/query";
export const CNINFO_ANNOUNCEMENT_URL =
  "https://www.cninfo.com.cn/new/hisAnnouncement/query";
// Announcement PDFs live on the static host, keyed by the row's adjunctUrl.
export const CNINFO_STATIC_BASE_URL = "https://static.cninfo.com.cn";
export const CNINFO_REQUEST_TIMEOUT_MS = 20_000;

export const CNINFO_DEFAULT_SEARCH_LIMIT = 20;
export const CNINFO_MAX_PAGE_SIZE = 30;
export const CNINFO_MAX_PAGES = 10;

// Periodic-report category codes (verified live 2026-08-05). cninfo shares one
// code space across SSE/SZSE; the exchange is selected by the `column` field.
export const CNINFO_ANNUAL_CATEGORY = "category_ndbg_szsh";
export const CNINFO_HALF_YEAR_CATEGORY = "category_bndbg_szsh";
export const CNINFO_Q1_CATEGORY = "category_yjdbg_szsh";
export const CNINFO_Q3_CATEGORY = "category_sjdbg_szsh";
/** The interim (non-annual) periodic reports, newest-of used for "quarterly". */
export const CNINFO_QUARTERLY_CATEGORIES = [
  CNINFO_Q1_CATEGORY,
  CNINFO_Q3_CATEGORY,
  CNINFO_HALF_YEAR_CATEGORY,
] as const;

// Beijing is UTC+8; cninfo announcementTime epochs are local wall-clock, so we
// shift before slicing to recover the intended calendar date.
const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

export const CNINFO_RATE_LIMIT_MESSAGE =
  "cninfo request limit reached. Please retry later.";

export class CninfoRateLimitError extends AdapterRateLimitError {
  constructor(message = CNINFO_RATE_LIMIT_MESSAGE) {
    super(message, 300, 60_000, "cninfo");
    this.name = "CninfoRateLimitError";
  }
}

export class CninfoApiError extends AdapterError {
  constructor(message: string) {
    super(message, "cninfo");
    this.name = "CninfoApiError";
  }
}

function acquireRequest(): void {
  if (!cninfoRateLimiter.tryAcquire()) throw new CninfoRateLimitError();
}

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  Referer: "https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
};

async function cninfoPost(
  url: string,
  form: Record<string, string | number | undefined>,
  options: AdapterOptions,
): Promise<unknown> {
  acquireRequest();
  try {
    return await postForm(
      url,
      form,
      BROWSER_HEADERS,
      CNINFO_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CninfoRateLimitError();
    }
    throw error;
  }
}

// --- Resolution ------------------------------------------------------------

/** cninfo organisation-id prefixes map to the announcement-feed `column`. */
export function exchangeColumnForOrgId(orgId: string): "sse" | "szse" | "hke" {
  const prefix = orgId.slice(0, 4).toLowerCase();
  if (prefix === "gssh") return "sse";
  if (prefix === "gshk") return "hke";
  return "szse";
}

export function exchangeLabel(column: "sse" | "szse" | "hke"): string {
  if (column === "sse") return "Shanghai Stock Exchange";
  if (column === "hke") return "Hong Kong (via cninfo)";
  return "Shenzhen Stock Exchange";
}

export function isChineseStockCode(value: string): boolean {
  // A-shares are 6 digits; HKEX equities are commonly shown as 5 digits.
  return /^\d{5,6}$/.test(value.trim());
}

function disclosureUrl(stockCode: string, orgId: string): string {
  const params = new URLSearchParams({ stockCode, orgId });
  return `${CNINFO_BASE_URL}/new/disclosure/stock?${params.toString()}`;
}

interface CninfoSearchRow {
  code: string;
  orgId: string;
  shortName: string;
  pinyin?: string;
  category?: string;
  delisted: boolean;
}

function parseSearchRow(value: unknown): CninfoSearchRow | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const code = asString(row.code);
  const orgId = asString(row.orgId);
  const shortName = asString(row.zwjc);
  if (!code || !orgId || !shortName) return undefined;
  const delistedRaw = row.delisted;
  const delisted = delistedRaw === true || delistedRaw === "true" ||
    delistedRaw === 1 || delistedRaw === "1";
  const pinyin = asString(row.pinyin);
  const category = asString(row.category);
  return {
    code,
    orgId,
    shortName,
    ...(pinyin ? { pinyin } : {}),
    ...(category ? { category } : {}),
    delisted,
  };
}

export interface CninfoEntity extends Entity {
  stockCode: string;
  orgId: string;
  column: "sse" | "szse" | "hke";
}

function searchRowToEntity(
  row: CninfoSearchRow,
  matchReason: string,
): CninfoEntity {
  const column = exchangeColumnForOrgId(row.orgId);
  const status = row.delisted ? "Delisted" : row.category ?? undefined;
  return {
    legalName: row.shortName,
    stockCode: row.code,
    orgId: row.orgId,
    column,
    jurisdiction: "CN",
    source: "cninfo",
    sourceIdentifiers: {
      stockCode: row.code,
      orgId: row.orgId,
      jurisdiction: "CN",
    },
    sourceUrl: disclosureUrl(row.code, row.orgId),
    ...(row.pinyin ? { aliases: [`${exchangeLabel(column)} · ${row.pinyin}`] } : {
      aliases: [exchangeLabel(column)],
    }),
    ...(status ? { status } : {}),
    matchReason,
  };
}

export async function searchCninfoCompanies(
  query: string,
  options: AdapterOptions = {},
): Promise<CninfoEntity[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const payload = await cninfoPost(
    CNINFO_SEARCH_URL,
    { keyWord: trimmed, maxNum: 10 },
    options,
  );
  // topSearch returns a bare JSON array (occasionally wrapped in { records }).
  const rawRows = Array.isArray(payload)
    ? payload
    : asArray(asRecord(payload)?.records);
  const rows = rawRows
    .map(parseSearchRow)
    .filter((row): row is CninfoSearchRow => row !== undefined);

  if (isChineseStockCode(trimmed)) {
    const exact = rows.filter((row) => row.code === trimmed);
    const chosen = exact.length ? exact : rows;
    return chosen.map((row) => searchRowToEntity(row, "Exact stock-code match"));
  }
  // cninfo's search is already relevance-ordered; preserve its ranking.
  return rows.map((row) => searchRowToEntity(row, "cninfo search result"));
}

export async function resolveCninfoCompany(
  query: string,
  options: AdapterOptions = {},
): Promise<CninfoEntity | null> {
  return (await searchCninfoCompanies(query, options))[0] ?? null;
}

async function resolveCninfoEntity(
  query: string,
  options: AdapterOptions,
): Promise<CninfoEntity> {
  const entity = await resolveCninfoCompany(query, options);
  if (!entity) throw new Error(`No cninfo company found for ${query}.`);
  return entity;
}

// --- Announcement feed -----------------------------------------------------

function formatAnnouncementDate(value: unknown, fallback: string): string {
  const ms = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : Number.NaN;
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms + CN_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function announcementToFiling(
  row: Record<string, unknown>,
  scanDate: string,
): Filing | undefined {
  const adjunctUrl = asString(row.adjunctUrl);
  const title = asString(row.announcementTitle);
  if (!adjunctUrl || !title) return undefined;
  const secName = asString(row.secName);
  const secCode = asString(row.secCode);
  const orgId = asString(row.orgId);
  const announcementId = asString(row.announcementId);
  const typeName = asString(row.announcementTypeName);
  return {
    filedDate: formatAnnouncementDate(row.announcementTime, scanDate),
    form: typeName ?? "Announcement (公告)",
    ...(secName ? { category: secName } : {}),
    description: title,
    ...(announcementId ? { accession: announcementId } : {}),
    // adjunctUrl is a site-relative path like finalpage/2026-04-17/….PDF
    sourceUrl: `${CNINFO_STATIC_BASE_URL}/${adjunctUrl.replace(/^\/+/, "")}`,
    source: "cninfo",
    sourceIdentifiers: {
      ...(secCode ? { stockCode: secCode } : {}),
      ...(orgId ? { orgId } : {}),
      jurisdiction: "CN",
    },
  };
}

interface CninfoQueryParams {
  entity: CninfoEntity;
  category?: string;
  startDate?: string;
  endDate?: string;
  pageSize: number;
  pageNum: number;
}

async function fetchAnnouncementPage(
  params: CninfoQueryParams,
  options: AdapterOptions,
): Promise<{ filings: Filing[]; hasMore: boolean }> {
  const { entity } = params;
  const seDate = params.startDate && params.endDate
    ? `${params.startDate}~${params.endDate}`
    : undefined;
  const payload = await cninfoPost(
    CNINFO_ANNOUNCEMENT_URL,
    {
      pageNum: params.pageNum,
      pageSize: params.pageSize,
      column: entity.column,
      tabName: "fulltext",
      stock: `${entity.stockCode},${entity.orgId}`,
      isHLtitle: "true",
      ...(params.category ? { category: params.category } : {}),
      ...(seDate ? { seDate } : {}),
    },
    options,
  );
  const record = asRecord(payload);
  if (!record) throw new CninfoApiError("cninfo returned an unexpected response.");
  const scanDate = params.endDate ?? new Date().toISOString().slice(0, 10);
  const filings = asArray(record.announcements).flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const filing = announcementToFiling(row, scanDate);
    return filing ? [filing] : [];
  });
  const total = typeof record.totalAnnouncement === "number"
    ? record.totalAnnouncement
    : 0;
  const hasMore = params.pageNum * params.pageSize < total && filings.length > 0;
  return { filings, hasMore };
}

async function collectAnnouncements(
  entity: CninfoEntity,
  category: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
  limit: number,
  options: AdapterOptions,
): Promise<Filing[]> {
  const pageSize = Math.min(Math.max(limit, 1), CNINFO_MAX_PAGE_SIZE);
  const filings: Filing[] = [];
  for (let page = 1; page <= CNINFO_MAX_PAGES; page += 1) {
    const { filings: pageFilings, hasMore } = await fetchAnnouncementPage(
      { entity, ...(category ? { category } : {}), ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), pageSize, pageNum: page },
      options,
    );
    filings.push(...pageFilings);
    if (filings.length >= limit || !hasMore) break;
  }
  return filings;
}

export interface CninfoFilingSearchParams {
  company: string;
  forms?: readonly string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

function filingMatchesForms(filing: Filing, forms: readonly string[]): boolean {
  if (!forms.length) return true;
  const haystack = `${filing.form} ${filing.description} ${filing.category ?? ""}`
    .toLowerCase();
  return forms.some((form) => {
    const needle = form.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export async function searchCninfoFilings(
  input: string | CninfoFilingSearchParams,
  options: AdapterOptions = {},
): Promise<Filing[]> {
  const params = typeof input === "string" ? { company: input } : input;
  const entity = await resolveCninfoEntity(params.company, options);
  const limit = Math.max(1, params.limit ?? CNINFO_DEFAULT_SEARCH_LIMIT);
  const filings = await collectAnnouncements(
    entity,
    undefined,
    params.startDate,
    params.endDate,
    limit,
    options,
  );
  return filings
    .filter((filing) => filingMatchesForms(filing, params.forms ?? []))
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, limit);
}

export async function getLatestCninfoReport(
  company: string,
  reportKind: "annual" | "quarterly",
  options: AdapterOptions = {},
): Promise<LatestReportMetadata | null> {
  const entity = await resolveCninfoEntity(company, options);
  const categories = reportKind === "annual"
    ? [CNINFO_ANNUAL_CATEGORY]
    : CNINFO_QUARTERLY_CATEGORIES;
  const collected: Filing[] = [];
  for (const category of categories) {
    const filings = await collectAnnouncements(
      entity,
      category,
      undefined,
      undefined,
      5,
      options,
    );
    collected.push(...filings);
  }
  const match = collected
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))[0];
  if (!match) return null;
  return {
    ...match,
    reportKind,
    sectionLinks: [
      {
        section: "cninfo-pdf",
        description: `cninfo full-text PDF — ${match.description}`,
        url: match.sourceUrl,
      },
    ],
  };
}

// --- CompanyFinancials (latest periodic-report figures) --------------------
//
// CN issuers file no keyless structured-XBRL feed, but their standardized SSE/
// SZSE periodic reports (年度报告/半年度报告/季度报告) carry the 主要会计数据
// key-accounting-data summary and the consolidated statements (合并利润表/
// 合并资产负债表) in a form the shipped `pdfText.ts` extractor recovers — after
// one mandatory, CN-specific preprocessing step. These PDFs position every glyph
// individually, so the raw extractor output space-separates *every* character:
// 营业收入 arrives as "营 业 收 入" and 168,838,102,514.79 as
// "1 6 8 , 8 3 8 , ...". The text is correct and in reading order; it just needs
// a deterministic space-collapse before any label match (`normalizeCninfoText`).
//
// This is a bounded "latest periodic-report figures" mode: it anchors solely on
// the 主要会计数据 key-data table (the safest, unambiguous summary — the detailed
// 合并 statements are deliberately not used, their scale/consolidation being
// harder to pin down safely), takes the current-period (first) figure per line,
// pins each figure's scale from the nearest 单位 declaration (元/千元/万元/百万元),
// and degrades to a link only when the report cannot be read honestly:
//   - `cjk === 0` (mojibake — glyphs/fonts packed so the extractor emits Latin/
//     control soup, the ObjStm class) → link-only;
//   - the PDF exceeds the 40 MB cap (large bank/insurer annuals) → link-only;
//   - no readable key-data table → link-only.
// It never emits a figure whose scale it could not determine. Latest report
// only, no history.

/**
 * CJK glyph classes for the space-collapse normalizer: CJK Unified Ideographs
 * (+ Extension A), compatibility ideographs, CJK symbols/punctuation, and the
 * fullwidth/halfwidth forms block (fullwidth parentheses appear in unit-qualified
 * labels like 营业收入（千元）).
 */
const CJK_GLYPH_CLASS = "\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
const CJK_COLLAPSE_RE = new RegExp(
  `([${CJK_GLYPH_CLASS}]) (?! )(?=[${CJK_GLYPH_CLASS}])`,
  "g",
);
// A single space between two number characters is a per-glyph gap to strip; a
// run of 2+ spaces separates adjacent figure columns and MUST be preserved.
const NUMBER_COLLAPSE_RE = /([0-9.,%−-]) (?! )(?=[0-9.,%−-])/g;
const CJK_IDEOGRAPH_RE = /[㐀-鿿豈-﫿]/;
const CJK_IDEOGRAPH_RE_G = /[㐀-鿿豈-﫿]/g;

/**
 * Count CJK ideographs in extracted text — the mojibake gate. A Chinese report
 * whose glyphs decoded correctly carries thousands; an ObjStm-packed file
 * rendered through the WinAnsi fallback carries zero (Latin/control-symbol soup).
 */
export function countCjkChars(text: string): number {
  return (text.match(CJK_IDEOGRAPH_RE_G) ?? []).length;
}

/**
 * The mandatory CN-specific preprocessing. Joins adjacent CJK glyphs separated by
 * a single space (so 营 业 收 入 → 营业收入) and strips single spaces inside number
 * runs (so 1 6 8 , 8 3 8 → 168,838), while preserving 2+-space runs so adjacent
 * figure columns stay separated. Nothing downstream parses without it. Applied
 * per line; the extractor's line structure is left untouched.
 */
export function normalizeCninfoText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(CJK_COLLAPSE_RE, "$1").replace(NUMBER_COLLAPSE_RE, "$1"))
    .join("\n");
}

interface CninfoConceptSpec {
  concept: string;
  /** English gloss shown alongside the matched Chinese label in the output. */
  gloss: string;
  /** Chinese label prefixes tried in priority order (most-specific first). */
  prefixes: readonly string[];
}

/**
 * Canonical concepts and their CN label lexicon. Prefixes are tried in priority
 * order and matched with `startsWith` on the normalized (space-collapsed) line,
 * so, e.g., net profit prefers the listed-company-attributable line
 * (归属于上市公司股东的净利润) over the group total, and its 扣除非经常性损益
 * ("excluding non-recurring") sibling is excluded structurally (it diverges from
 * the prefix). Revenue's 利息净收入 (bank net-interest) never matches (different
 * leading glyph). Total equity prefers the attributable subtotal over the
 * minority-inclusive 所有者权益合计.
 */
export const CNINFO_FINANCIAL_CONCEPTS: readonly CninfoConceptSpec[] = [
  {
    concept: "revenue",
    gloss: "revenue",
    prefixes: ["营业收入", "营业总收入"],
  },
  {
    concept: "operating_profit",
    gloss: "operating profit",
    prefixes: ["营业利润"],
  },
  {
    concept: "total_profit",
    gloss: "total profit (pre-tax)",
    prefixes: ["利润总额"],
  },
  {
    concept: "net_profit",
    gloss: "net profit attributable to shareholders of the listed company",
    prefixes: [
      "归属于上市公司股东的净利润",
      "归属于母公司股东的净利润",
      "归属于母公司所有者的净利润",
    ],
  },
  {
    concept: "total_assets",
    gloss: "total assets",
    prefixes: ["资产总计", "资产总额", "总资产"],
  },
  {
    concept: "total_liabilities",
    gloss: "total liabilities",
    prefixes: ["负债合计", "负债总计"],
  },
  {
    concept: "total_equity",
    gloss: "equity attributable to shareholders of the listed company",
    prefixes: [
      "归属于上市公司股东的净资产",
      "归属于母公司股东权益",
      "归属于母公司所有者权益合计",
      "归属于母公司所有者权益",
      "归属于母公司股东的权益",
    ],
  },
];

export const CNINFO_FINANCIAL_CONCEPT_NAMES = CNINFO_FINANCIAL_CONCEPTS.map(
  (spec) => spec.concept,
);

// A statement figure is always thousands-grouped (168,838,102,514.79), so
// requiring a grouping comma skips note-reference integers, years, and per-share
// decimals that would otherwise be mistaken for the value.
const CN_GROUPED_NUMBER = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/;
const CN_GROUPED_NUMBER_AT_START = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/;

function parseCninfoNumber(token: string): number | undefined {
  const cleaned = token.replace(/,/g, "").replace(/−/g, "-");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

interface CninfoConceptHit {
  value: number;
  matchedPrefix: string;
  /** Region-relative index of the matched label line (for backward unit scan). */
  index: number;
  /** The remainder of the label line, read for an embedded unit qualifier. */
  unitHint: string;
}

// Chinese statement line items carry a leading enumerator — 一、二、…、四、
// (Chinese numeral + 、) or （一） / 1. — before the concept label. Strip it so
// 四、营业利润 matches the 营业利润 prefix (the 主要会计数据 summary has no such
// enumerator, so stripping is a no-op there).
function stripEnumerator(line: string): string {
  return line
    .replace(/^(?:[一二三四五六七八九十]+|\d+)\s*[、.．]\s*/, "")
    .replace(/^[（(]\s*(?:[一二三四五六七八九十]+|\d+)\s*[）)]\s*/, "");
}

const CJK_ISH_START = /^[㐀-鿿豈-﫿　-〿！-￯]/;

/** Index of the next non-blank line at or after `from`, or -1. */
function nextNonBlank(lines: readonly string[], from: number): number {
  for (let k = from; k < lines.length; k += 1) {
    if ((lines[k] ?? "").trim() !== "") return k;
  }
  return -1;
}

/**
 * Find one concept's current-period figure. For each prefix, at each start line it
 * builds a label buffer, absorbing wrapped CJK fragments (归属于上市公司股东的 /
 * 净利润（元）) across following lines until the buffer matches the prefix — trying
 * every start line, so header remnants (a stray 年) never block the real label.
 * A continuing ideograph after the prefix is a different, longer line item
 * (总资产收益率 ≠ 总资产) and is rejected. The current-period figure is the first
 * grouped number on the label's own line, else on the following lines (one figure
 * per line). Returns the value + matched prefix so the output states the line item.
 */
function extractCninfoConcept(
  lines: readonly string[],
  prefixes: readonly string[],
): CninfoConceptHit | undefined {
  for (const prefix of prefixes) {
    for (let i = 0; i < lines.length; i += 1) {
      let label = stripEnumerator((lines[i] ?? "").trim());
      if (!label || !CJK_ISH_START.test(label)) continue;
      // Absorb wrapped label fragments until the buffer reaches the prefix.
      let last = i;
      for (let hops = 0; hops < 4 && !label.startsWith(prefix); hops += 1) {
        const k = nextNonBlank(lines, last + 1);
        const frag = k === -1 ? "" : (lines[k] ?? "").trim();
        if (!frag || CN_GROUPED_NUMBER.test(frag) || !CJK_ISH_START.test(frag)) break;
        label += frag;
        last = k;
      }
      if (!label.startsWith(prefix)) continue;
      const rest = label.slice(prefix.length);
      // A continuing ideograph is a different, longer label (总资产收益率 etc.).
      if (CJK_IDEOGRAPH_RE.test(rest.charAt(0))) continue;
      const sameLine = rest.match(CN_GROUPED_NUMBER);
      if (sameLine) {
        const value = parseCninfoNumber(sameLine[0]);
        if (value !== undefined) {
          return { value, matchedPrefix: prefix, index: i, unitHint: rest };
        }
        continue;
      }
      for (let j = last + 1; j < Math.min(lines.length, last + 6); j += 1) {
        const next = (lines[j] ?? "").trim();
        if (!next) continue;
        const lead = next.match(CN_GROUPED_NUMBER_AT_START);
        if (lead) {
          const value = parseCninfoNumber(lead[0]);
          if (value !== undefined) {
            return { value, matchedPrefix: prefix, index: i, unitHint: rest };
          }
          break;
        }
        // Reached the next label with no figure — abandon this occurrence.
        if (CJK_IDEOGRAPH_RE.test(next.charAt(0))) break;
      }
    }
  }
  return undefined;
}

function scaleOfToken(token: string): number {
  return token === "百万元"
    ? 1_000_000
    : token === "万元"
      ? 10_000
      : token === "千元"
        ? 1_000
        : 1;
}

/**
 * Determine a figure's scale to whole yuan — the single most safety-critical step
 * (a missed 千元/百万元 is a 1,000×–1,000,000× error). Banks state 千元, insurers
 * 百万元, and most annual tables 元, each declaring its unit in a 单位：X元 header
 * that the extractor may split across lines (单位： / 元). Read an embedded label
 * qualifier (营业收入（千元）) first, else scan BACKWARDS from the figure for the
 * NEAREST 单位 declaration (never a later note or the 母公司 section). Returns
 * `undefined` when no unit can be pinned down — the caller then DROPS the figure
 * rather than guess a scale.
 */
function detectCninfoScale(
  regionLines: readonly string[],
  index: number,
  unitHint: string,
): number | undefined {
  // An inline unit qualifier on the label line — 营业收入（元）/（千元）/（万元）
  // (some issuers state it per-row instead of a table 单位 header).
  const hint = unitHint.match(/百万元|万元|千元|元/);
  if (hint) return scaleOfToken(hint[0]);
  // The unit declaration sits at the table header, above the figure. Real reports
  // phrase it as "单位：X元", "单位： / X元" (split across lines — \s spans it), or a
  // parenthetical "（人民币X元）" with no 单位 keyword (banks/insurers). The
  // parenthetical form REQUIRES 人民币 so a per-share "（元/股）" header (which sits
  // between the table's 单位：千元 and the assets figures) is never mistaken for the
  // table unit — a 1,000× trap. Match only in a unit-declaration context, never a
  // bare 元 in prose, and take the LAST match above the figure (nearest header).
  const windowText = regionLines.slice(0, index + 1).join("\n");
  const re =
    /(?:单位\s*[:：]?\s*(?:人民币\s*)?|[（(]\s*人民币\s*)(百万元|万元|千元|元)/g;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(windowText)) !== null) last = match;
  return last?.[1] ? scaleOfToken(last[1]) : undefined;
}

/**
 * The 主要会计数据 summary block near the front of every report is the safe core:
 * a single clean, unambiguous table carrying revenue, total/net profit, total
 * assets and net assets with one governing 单位 declaration adjacent to its
 * figures — the highest-reliability anchor per the CN corpus. The mode reads ONLY
 * this table; the detailed 合并 statements are deliberately NOT used as a fallback
 * because their unit-of-account and consolidated-vs-parent disambiguation cannot
 * be pinned down as safely (a wrong-scale or parent-column figure is worse than
 * an honest omission). A bounded window covers the operating-results sub-block and
 * the year-end assets/equity sub-block that follows it.
 */
function keyDataRegion(lines: readonly string[]): readonly string[] | undefined {
  // The anchor itself can wrap across fragment lines (主要会计 / 数据), so match it
  // on a whitespace-free join of a small sliding window rather than a single line.
  for (let i = 0; i < lines.length; i += 1) {
    const window = `${lines[i] ?? ""}${lines[i + 1] ?? ""}${lines[i + 2] ?? ""}`
      .replace(/\s/g, "");
    if (window.includes("主要会计数据")) return lines.slice(i, i + 150);
  }
  return undefined;
}

export interface CninfoParsedFinancials {
  currency: "CNY";
  values: Array<{ concept: string; label: string; value: number }>;
}

/**
 * Parse the canonical concept set out of a periodic report's extracted text,
 * anchored solely on the 主要会计数据 key-data table. Each figure's scale is
 * pinned from the nearest preceding 单位 declaration; a figure whose scale cannot
 * be determined is dropped (never guessed). An empty `values` means the key-data
 * table was absent or unreadable (caller degrades to a link). Currency is CNY.
 */
export function parseCninfoFinancials(text: string): CninfoParsedFinancials {
  const lines = normalizeCninfoText(text).split("\n");
  const region = keyDataRegion(lines);
  const values: CninfoParsedFinancials["values"] = [];
  if (!region) return { currency: "CNY", values };
  for (const spec of CNINFO_FINANCIAL_CONCEPTS) {
    const hit = extractCninfoConcept(region, spec.prefixes);
    if (!hit) continue;
    const scale = detectCninfoScale(region, hit.index, hit.unitHint);
    if (scale === undefined) continue;
    values.push({
      concept: spec.concept,
      label: `${hit.matchedPrefix} — ${spec.gloss}`,
      value: hit.value * scale,
    });
  }
  return { currency: "CNY", values };
}

// Non-full-report periodic disclosures that share the periodic-report category
// but are not the report itself (English translations, summaries, corrections).
const CNINFO_NON_FULL_REPORT = /摘要|英文|已取消|取消|更正|补充|提示性|意见|专项/;

/** Derive the reporting period end and a human report label from the filing. */
function cninfoReportPeriod(report: Filing): {
  periodEnd: string;
  reportLabel: string;
} {
  const src = `${report.description ?? ""} ${report.form ?? ""}`;
  const yearMatch = src.match(/(\d{4})\s*年/);
  const year = yearMatch?.[1] ?? report.filedDate.slice(0, 4);
  if (/半年/.test(src)) {
    return { periodEnd: `${year}-06-30`, reportLabel: "Half-year report (半年度报告)" };
  }
  if (/(第一|一|1)\s*季/.test(src)) {
    return { periodEnd: `${year}-03-31`, reportLabel: "Q1 report (一季度报告)" };
  }
  if (/(第三|三|3)\s*季/.test(src)) {
    return { periodEnd: `${year}-09-30`, reportLabel: "Q3 report (三季度报告)" };
  }
  return { periodEnd: `${year}-12-31`, reportLabel: "Annual report (年度报告)" };
}

/**
 * The newest full periodic report to read: the annual report (年度报告) is
 * preferred, else the newest interim/quarterly (半年度/一季度/三季度). Summaries,
 * English translations and corrections that share the category are filtered out.
 */
async function selectFinancialsReport(
  entity: CninfoEntity,
  options: AdapterOptions,
): Promise<{ report: Filing; reportKind: "annual" | "quarterly" } | null> {
  const attempts: ReadonlyArray<
    readonly ["annual" | "quarterly", readonly string[]]
  > = [
    ["annual", [CNINFO_ANNUAL_CATEGORY]],
    ["quarterly", CNINFO_QUARTERLY_CATEGORIES],
  ];
  for (const [reportKind, categories] of attempts) {
    const collected: Filing[] = [];
    for (const category of categories) {
      collected.push(
        ...(await collectAnnouncements(entity, category, undefined, undefined, 8, options)),
      );
    }
    const full = collected
      .filter((filing) => !CNINFO_NON_FULL_REPORT.test(filing.description ?? ""))
      .sort((left, right) => right.filedDate.localeCompare(left.filedDate))[0];
    if (full) return { report: full, reportKind };
  }
  return null;
}

/**
 * Big bank/insurer annuals can exceed any sane download cap (the corpus saw a
 * 32 MB CMB annual). Raised to 40 MB for this mode; a report above it degrades to
 * the PDF link rather than pulling tens of MB into memory.
 */
export const CNINFO_FINANCIALS_MAX_BYTES = 40 * 1024 * 1024;

function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/** Validate a report PDF URL stays on cninfo (no SSRF to arbitrary hosts). */
function assertCninfoPdfUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CninfoApiError(`"${rawUrl}" is not a valid cninfo document URL.`);
  }
  if (url.protocol !== "https:" || !/(^|\.)cninfo\.com\.cn$/i.test(url.hostname)) {
    throw new CninfoApiError("cninfo report PDFs must be a cninfo.com.cn URL.");
  }
  return url.toString();
}

/** HEAD the PDF to read its content-length (best effort; undefined on failure). */
async function headContentLength(
  url: string,
  options: AdapterOptions,
): Promise<number | undefined> {
  acquireRequest();
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(url, { method: "HEAD", headers: BROWSER_HEADERS });
    const raw = response.headers.get("content-length");
    return raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  } catch {
    return undefined;
  }
}

export type CninfoFinancialsReason =
  | "no-report"
  | "over-cap"
  | "mojibake"
  | "no-statements";

export interface CninfoFinancialsResult {
  entity: CninfoEntity;
  report: Filing | null;
  reportKind?: "annual" | "quarterly";
  reportLabel?: string;
  periodEnd?: string;
  currency?: "CNY";
  facts: FinancialFact[];
  declaredPages?: number;
  extractedPages?: number;
  cjkChars?: number;
  reason?: CninfoFinancialsReason;
}

/**
 * "Latest periodic-report figures" for a listed CN issuer: locate the newest full
 * annual report (else interim/quarterly), download its PDF, extract and
 * space-normalize the text layer, and parse the 主要会计数据 key-data table (else
 * the consolidated statements). Degrades honestly — an over-cap PDF, a mojibake
 * (cjk === 0) text layer, or no matched statement returns no facts with a
 * `reason`, leaving the caller to serve the link only.
 */
export async function getCninfoFinancials(
  company: string,
  options: AdapterOptions = {},
): Promise<CninfoFinancialsResult> {
  const entity = await resolveCninfoEntity(company, options);
  const selection = await selectFinancialsReport(entity, options);
  if (!selection) {
    return { entity, report: null, facts: [], reason: "no-report" };
  }
  const { report, reportKind } = selection;
  const url = assertCninfoPdfUrl(report.sourceUrl);
  const { periodEnd, reportLabel } = cninfoReportPeriod(report);
  const base = { entity, report, reportKind, reportLabel, periodEnd };

  const headLen = await headContentLength(url, options);
  if (headLen !== undefined && headLen > CNINFO_FINANCIALS_MAX_BYTES) {
    return { ...base, facts: [], reason: "over-cap" };
  }

  let bytes: Uint8Array;
  try {
    bytes = await getBinary(
      url,
      { ...BROWSER_HEADERS, Accept: "application/pdf, application/octet-stream, */*" },
      CNINFO_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CninfoRateLimitError();
    }
    throw error;
  }
  if (bytes.byteLength > CNINFO_FINANCIALS_MAX_BYTES) {
    return { ...base, facts: [], reason: "over-cap" };
  }
  if (!isPdfBytes(bytes)) {
    throw new CninfoApiError(`cninfo returned no PDF at ${url}.`);
  }

  const extracted = extractPdfText(bytes);
  const cjkChars = countCjkChars(extracted.text);
  const extractedPages = extracted.pagesWithText ?? extracted.pages ?? 0;
  const withPages = {
    ...base,
    ...(extracted.declaredPages !== undefined ? { declaredPages: extracted.declaredPages } : {}),
    extractedPages,
    cjkChars,
  };
  // Mojibake gate: an ObjStm-packed report the extractor rendered through the
  // WinAnsi fallback carries zero Chinese — never parse Latin/control soup.
  if (cjkChars === 0) {
    return { ...withPages, facts: [], reason: "mojibake" };
  }

  const parsed = parseCninfoFinancials(extracted.text);
  if (parsed.values.length === 0) {
    return { ...withPages, facts: [], reason: "no-statements" };
  }

  const facts: FinancialFact[] = parsed.values.map((entry) => ({
    concept: entry.concept,
    label: entry.label,
    periodEnd,
    value: entry.value,
    unit: parsed.currency,
    filedDate: report.filedDate,
    form: `cninfo ${reportLabel}`,
    ...(report.sourceUrl ? { sourceUrl: report.sourceUrl } : {}),
    source: "cninfo",
    sourceIdentifiers: {
      stockCode: entity.stockCode,
      orgId: entity.orgId,
      jurisdiction: "CN",
    },
  }));

  return { ...withPages, currency: parsed.currency, facts };
}

// --- CompanyOwners (前十名股东 top-10 shareholders, PDF) --------------------
//
// The 前十名股东持股情况 (top-10 shareholders) table is present and readable in
// every clean periodic report (annual AND quarterly carry it), so the freshest
// report wins. It survives extraction with names, share counts and percentages
// intact, but its column ORDER varies by issuer and its rows are ragged (a
// holder with no change has one fewer numeric cell; names wrap across lines).
// So this is a value-heuristic parser, not a fixed-column one: it keys on cell
// SHAPE — a CJK-leading run is a name; the number 0<v≤100 (with a decimal) is
// the 比例 percentage; the largest integer is the 期末持股数量 holding count —
// and emits only rows where both a percentage and a holding count are matched.
// It is an as-published snapshot, not a live register; state-owned and nominee
// holders (香港中央结算, 中国证券登记结算) appear as printed.

/** One matched top-10 shareholder row (only confidently-parsed rows emit). */
export interface CninfoOwnerRow {
  holderName: string;
  /** 期末持股数量 — shares held at period end (whole shares). */
  shareCount?: number;
  /** 比例 — percentage of share capital. */
  pct?: number;
  /** 股东性质/股份性质 — holder nature (国有法人 / 境内自然人 / …), as printed. */
  nature?: string;
}

// Header/label cells that are NOT shareholder names. Each fragment is specific
// enough that it never appears inside a real holder's name (unlike 股份/有限/
// 公司, which do), so a name-token test can reject them wholesale.
const CN_OWNER_HEADER_RE =
  /比例|持股数量|期末持股|持股总数|报告期|股东性质|股份性质|质押|冻结|标记|股份状态|表决权|限售条件|前十名|战略投资|股东名称|股东.{0,2}总数|参与.{0,4}融资|信用.{0,2}账户|单位[：:]|序号|合计|变动情况|名称|数量|类别|种类/;

// Holder-nature cells (国有法人 etc.). Kept distinct from names so they land in
// the `nature` field rather than starting a spurious row.
const CN_OWNER_NATURE_RE =
  /^(?:国有法人|国有股东|境内非?国有法人|境内一般法人|境内自然人|境外法人|境外自然人|境内法人|自然人|国有|其他|未知|无|境内|境外)$/;

const CN_NUMBER_CELL_RE = /^-?\d[\d,]*(?:\.\d+)?%?$/;
const CJK_LEADING_RE = /^[㐀-鿿豈-﫿·（(]/;

interface OwnerNumberToken {
  value: number;
  hasPercent: boolean;
  hasFraction: boolean;
}

function classifyOwnerNumber(token: string): OwnerNumberToken | undefined {
  const hasPercent = token.includes("%");
  const bare = token.replace(/%/g, "");
  const value = parseCninfoNumber(bare);
  if (value === undefined) return undefined;
  return { value, hasPercent, hasFraction: /\.\d/.test(bare) };
}

interface OwnerRowBuffer {
  nameParts: string[];
  numbers: OwnerNumberToken[];
  natures: string[];
}

function finalizeOwnerRow(buffer: OwnerRowBuffer): CninfoOwnerRow | undefined {
  const holderName = buffer.nameParts.join("").trim();
  if (holderName.length < 2 || holderName.length > 48) return undefined;
  // Percentage: a value in (0,100], preferring an explicit % or a fractional
  // one, never 0 (a no-change 增减 cell is 0 and ≤100 but is not the ratio).
  const pctCandidates = buffer.numbers.filter((n) => n.value > 0 && n.value <= 100);
  const pctToken = pctCandidates.find((n) => n.hasPercent)
    ?? pctCandidates.find((n) => n.hasFraction)
    ?? pctCandidates[pctCandidates.length - 1];
  // Holding count: the largest integer that is not the chosen percentage.
  const countCandidates = buffer.numbers
    .filter((n) => n !== pctToken)
    .map((n) => n.value);
  const shareCount = countCandidates.length
    ? Math.max(...countCandidates.map((v) => Math.abs(v)))
    : undefined;
  if (pctToken === undefined || shareCount === undefined || shareCount <= 0) {
    return undefined;
  }
  const nature = [...buffer.natures].reverse().find((n) => CN_OWNER_NATURE_RE.test(n));
  return {
    holderName,
    shareCount,
    pct: pctToken.value,
    ...(nature ? { nature } : {}),
  };
}

/** Locate the 前十名股东 region on a whitespace-free sliding-window match. */
function topShareholderRegion(lines: readonly string[]): readonly string[] | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const window = `${lines[i] ?? ""}${lines[i + 1] ?? ""}${lines[i + 2] ?? ""}`
      .replace(/\s/g, "");
    if (window.includes("前十名股东持股情况") || window.includes("前十名股东情况")) {
      return lines.slice(i, i + 160);
    }
  }
  return undefined;
}

/**
 * Parse up to ten 前十名股东 rows out of a periodic report's extracted text.
 * Operates on a flat cell stream (each line split on 2+-space gaps) so both the
 * line-per-cell shape and the same-line-with-gaps shape parse identically. A new
 * shareholder name after ≥1 numeric cell finalizes the prior row; a CJK cell
 * before any number is treated as a wrapped-name fragment. Emits only rows that
 * carry both a matched percentage and holding count. Empty ⇒ no readable table.
 */
export function parseCninfoTopShareholders(text: string): CninfoOwnerRow[] {
  const region = topShareholderRegion(normalizeCninfoText(text).split("\n"));
  if (!region) return [];
  const cells: string[] = [];
  for (const line of region) {
    for (const cell of line.split(/\s{2,}/)) {
      const trimmed = cell.trim();
      if (trimmed) cells.push(trimmed);
    }
  }
  const rows: CninfoOwnerRow[] = [];
  let buffer: OwnerRowBuffer | undefined;
  const flush = (): void => {
    if (!buffer) return;
    const row = finalizeOwnerRow(buffer);
    if (row) rows.push(row);
    buffer = undefined;
  };
  for (const cell of cells) {
    if (rows.length >= 10) break;
    if (CN_NUMBER_CELL_RE.test(cell)) {
      const num = classifyOwnerNumber(cell);
      if (num && buffer && buffer.nameParts.length) buffer.numbers.push(num);
      continue;
    }
    if (CN_OWNER_NATURE_RE.test(cell)) {
      if (buffer) buffer.natures.push(cell);
      continue;
    }
    if (!CJK_LEADING_RE.test(cell) || CN_OWNER_HEADER_RE.test(cell)) continue;
    if (cell.length > 48) continue;
    if (buffer && buffer.numbers.length > 0) {
      flush();
      buffer = { nameParts: [cell], numbers: [], natures: [] };
    } else if (buffer && buffer.nameParts.length > 0) {
      // A CJK cell before any number is a wrapped-name continuation.
      buffer.nameParts.push(cell);
    } else {
      buffer = { nameParts: [cell], numbers: [], natures: [] };
    }
  }
  flush();
  return rows.slice(0, 10);
}

export type CninfoOwnersReason = "no-report" | "over-cap" | "mojibake" | "no-table";

export interface CninfoOwnersResult {
  entity: CninfoEntity;
  report: Filing | null;
  reportKind?: "annual" | "quarterly";
  reportLabel?: string;
  periodEnd?: string;
  owners: CninfoOwnerRow[];
  declaredPages?: number;
  extractedPages?: number;
  cjkChars?: number;
  reason?: CninfoOwnersReason;
}

/**
 * The newest full periodic report of ANY kind (annual or interim/quarterly),
 * since all of them carry the top-10 shareholders and 董监高 tables — so the
 * freshest disclosure wins. Summaries/English/corrections are filtered out.
 */
async function selectFreshestReport(
  entity: CninfoEntity,
  options: AdapterOptions,
): Promise<{ report: Filing; reportKind: "annual" | "quarterly" } | null> {
  const collected: Array<{ filing: Filing; kind: "annual" | "quarterly" }> = [];
  for (
    const [kind, categories] of [
      ["annual", [CNINFO_ANNUAL_CATEGORY]],
      ["quarterly", CNINFO_QUARTERLY_CATEGORIES],
    ] as ReadonlyArray<readonly ["annual" | "quarterly", readonly string[]]>
  ) {
    for (const category of categories) {
      for (
        const filing of await collectAnnouncements(entity, category, undefined, undefined, 8, options)
      ) {
        if (!CNINFO_NON_FULL_REPORT.test(filing.description ?? "")) {
          collected.push({ filing, kind });
        }
      }
    }
  }
  const best = collected.sort((a, b) =>
    b.filing.filedDate.localeCompare(a.filing.filedDate)
  )[0];
  return best ? { report: best.filing, reportKind: best.kind } : null;
}

/** Shared fetch+extract+gate for the PDF ownership/insider table parsers. */
async function fetchReportText(
  url: string,
  options: AdapterOptions,
): Promise<
  | { kind: "over-cap" }
  | { kind: "mojibake"; cjkChars: number; extractedPages: number; declaredPages?: number }
  | {
    kind: "ok";
    text: string;
    cjkChars: number;
    extractedPages: number;
    declaredPages?: number;
  }
> {
  const headLen = await headContentLength(url, options);
  if (headLen !== undefined && headLen > CNINFO_FINANCIALS_MAX_BYTES) {
    return { kind: "over-cap" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await getBinary(
      url,
      { ...BROWSER_HEADERS, Accept: "application/pdf, application/octet-stream, */*" },
      CNINFO_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CninfoRateLimitError();
    }
    throw error;
  }
  if (bytes.byteLength > CNINFO_FINANCIALS_MAX_BYTES) return { kind: "over-cap" };
  if (!isPdfBytes(bytes)) throw new CninfoApiError(`cninfo returned no PDF at ${url}.`);
  const extracted = extractPdfText(bytes);
  const cjkChars = countCjkChars(extracted.text);
  const extractedPages = extracted.pagesWithText ?? extracted.pages ?? 0;
  const declaredPages = extracted.declaredPages;
  if (cjkChars === 0) {
    return {
      kind: "mojibake",
      cjkChars,
      extractedPages,
      ...(declaredPages !== undefined ? { declaredPages } : {}),
    };
  }
  return {
    kind: "ok",
    text: extracted.text,
    cjkChars,
    extractedPages,
    ...(declaredPages !== undefined ? { declaredPages } : {}),
  };
}

/**
 * "Latest top-10 shareholders" for a listed CN issuer: locate the freshest full
 * periodic report, extract + space-normalize its text, and value-heuristic-parse
 * the 前十名股东持股情况 table. Degrades honestly (over-cap / mojibake / no
 * table) to a link-only result, exactly like getCninfoFinancials.
 */
export async function getCninfoOwners(
  company: string,
  options: AdapterOptions = {},
): Promise<CninfoOwnersResult> {
  const entity = await resolveCninfoEntity(company, options);
  const selection = await selectFreshestReport(entity, options);
  if (!selection) return { entity, report: null, owners: [], reason: "no-report" };
  const { report, reportKind } = selection;
  const url = assertCninfoPdfUrl(report.sourceUrl);
  const { periodEnd, reportLabel } = cninfoReportPeriod(report);
  const base = { entity, report, reportKind, reportLabel, periodEnd };
  const fetched = await fetchReportText(url, options);
  if (fetched.kind === "over-cap") return { ...base, owners: [], reason: "over-cap" };
  const withPages = {
    ...base,
    ...(fetched.declaredPages !== undefined ? { declaredPages: fetched.declaredPages } : {}),
    extractedPages: fetched.extractedPages,
    cjkChars: fetched.cjkChars,
  };
  if (fetched.kind === "mojibake") return { ...withPages, owners: [], reason: "mojibake" };
  const owners = parseCninfoTopShareholders(fetched.text);
  if (owners.length === 0) return { ...withPages, owners: [], reason: "no-table" };
  return { ...withPages, owners };
}

// --- CompanyInsiders (董监高, structured SZSE + PDF roster fallback) ---------
//
// Insider disclosure is asymmetric across the two mainland exchanges. SZSE
// serves a keyless, filterable JSON feed of every reported 董监高 share-change
// transaction (see szse.ts), so SZSE-listed issuers (0xxxxx / 3xxxxx) route to
// that structured feed. SSE (6xxxxx) has no equivalent clean public endpoint —
// its 董监高 changes live in the JS/credit-file-walled 上市公司诚信记录 — so SSE
// issuers fall back to the board roster (董事、监事、高级管理人员) table in the
// latest annual report PDF, which the extractor reads with names and positions
// clean (dates fragment, so they are not emitted). The two are honestly
// different views: a transactional share-change feed vs. an as-published roster
// snapshot.

/** One board member parsed from the annual-report 董监高 roster table. */
export interface CninfoBoardMember {
  name: string;
  /** 职务 — reported position(s), e.g. 董事、董事长. */
  position: string;
}

// Position cells carry a governance role keyword; person-name cells do not.
const CN_ROLE_RE =
  /董事|监事|高管|高级管理|经理|总监|董秘|秘书|总裁|首席|书记|主席|独立|职工|副总|总工|财务负责|法定代表/;
const CN_PERSON_NAME_RE = /^[㐀-鿿·]{2,6}$/;
const CN_INSIDER_HEADER_RE =
  /姓名|职务|性别|年龄|任期|持股|报告期|薪酬|期初|期末|增减|变动|股数|原因|合计|单位|简称|代码/;

/** Locate the 董监高 roster region (董事、监事、(和)?高级管理人员). */
function boardRosterRegion(lines: readonly string[]): readonly string[] | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const window = `${lines[i] ?? ""}${lines[i + 1] ?? ""}${lines[i + 2] ?? ""}${lines[i + 3] ?? ""}`
      .replace(/\s/g, "");
    if (
      window.includes("董事") && window.includes("监事") &&
      window.includes("高级管理人员")
    ) {
      return lines.slice(i, i + 220);
    }
  }
  return undefined;
}

/**
 * Parse the annual-report 董监高 roster into {name, position} rows. Walks the
 * cell stream and emits a row whenever a plausible person-name cell (2–6 Han
 * chars, no role keyword, not a header) is immediately followed by a
 * position cell (carrying a governance role keyword). Deduplicated, capped at
 * 60. Names and positions are the load-bearing fields (they hold cleanly);
 * fragmenting date/shareholding cells are intentionally not emitted.
 */
export function parseCninfoBoardRoster(text: string): CninfoBoardMember[] {
  const region = boardRosterRegion(normalizeCninfoText(text).split("\n"));
  if (!region) return [];
  const cells: string[] = [];
  for (const line of region) {
    for (const cell of line.split(/\s{2,}/)) {
      const trimmed = cell.trim();
      if (trimmed) cells.push(trimmed);
    }
  }
  const members: CninfoBoardMember[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cells.length - 1 && members.length < 60; i += 1) {
    const name = cells[i]!;
    const next = cells[i + 1]!;
    if (!CN_PERSON_NAME_RE.test(name)) continue;
    if (CN_ROLE_RE.test(name) || CN_INSIDER_HEADER_RE.test(name)) continue;
    if (!CN_ROLE_RE.test(next) || next.length > 24 || CN_INSIDER_HEADER_RE.test(next)) {
      continue;
    }
    const key = `${name} ${next}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ name, position: next });
  }
  return members;
}

export type CninfoInsidersMode = "szse-structured" | "pdf-roster";
export type CninfoInsidersReason =
  | "no-records"
  | "no-report"
  | "over-cap"
  | "mojibake"
  | "no-table";

export interface CninfoInsidersResult {
  entity: CninfoEntity;
  exchange: "SZSE" | "SSE" | "HKE";
  mode: CninfoInsidersMode;
  changes?: SzseInsiderChange[];
  roster?: CninfoBoardMember[];
  report?: Filing | null;
  reportKind?: "annual" | "quarterly";
  reportLabel?: string;
  periodEnd?: string;
  declaredPages?: number;
  extractedPages?: number;
  cjkChars?: number;
  reason?: CninfoInsidersReason;
}

/**
 * CompanyInsiders for a listed CN issuer, routed per exchange. SZSE issuers
 * (column "szse") get the structured 董监高 share-change feed; SSE/HK-mirrored
 * issuers get the annual-report 董监高 roster snapshot, degrading honestly on
 * over-cap / mojibake / no-table exactly like the other PDF modes.
 */
export async function getCninfoInsiders(
  company: string,
  options: AdapterOptions = {},
): Promise<CninfoInsidersResult> {
  const entity = await resolveCninfoEntity(company, options);
  const exchange = entity.column === "sse"
    ? "SSE"
    : entity.column === "hke"
      ? "HKE"
      : "SZSE";
  if (entity.column === "szse") {
    const changes = await getSzseInsiderChanges(entity.stockCode, options);
    return {
      entity,
      exchange,
      mode: "szse-structured",
      changes,
      ...(changes.length === 0 ? { reason: "no-records" as const } : {}),
    };
  }
  // SSE (and HK-mirrored) issuers: annual-report roster snapshot.
  const selection = await selectFinancialsReport(entity, options);
  if (!selection) {
    return { entity, exchange, mode: "pdf-roster", report: null, reason: "no-report" };
  }
  const { report, reportKind } = selection;
  const url = assertCninfoPdfUrl(report.sourceUrl);
  const { periodEnd, reportLabel } = cninfoReportPeriod(report);
  const base = {
    entity,
    exchange: exchange as "SSE" | "HKE",
    mode: "pdf-roster" as const,
    report,
    reportKind,
    reportLabel,
    periodEnd,
  };
  const fetched = await fetchReportText(url, options);
  if (fetched.kind === "over-cap") return { ...base, reason: "over-cap" };
  const withPages = {
    ...base,
    ...(fetched.declaredPages !== undefined ? { declaredPages: fetched.declaredPages } : {}),
    extractedPages: fetched.extractedPages,
    cjkChars: fetched.cjkChars,
  };
  if (fetched.kind === "mojibake") return { ...withPages, reason: "mojibake" };
  const roster = parseCninfoBoardRoster(fetched.text);
  if (roster.length === 0) return { ...withPages, reason: "no-table" };
  return { ...withPages, roster };
}

// --- CompanyDocument (cninfo announcement PDF → text) ----------------------
//
// cninfo announcement PDFs (the same SSE/SZSE full-text feed CompanyFilings
// returns) flow through the shared extract → CN-normalize → page pipeline. The
// stable transaction_id scheme is the announcement's cninfo PDF URL (the
// "open" link every CompanyFilings row carries) or its adjunctUrl path
// (finalpage/YYYY-MM-DD/ID.PDF) — both resolve directly to the static host with
// no re-query. Documents are capped at 25 MB (larger than the financials mode's
// cap is unnecessary here; big bank annuals over 25 MB degrade to the link).

export const CNINFO_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface CninfoDocument {
  bytes: Uint8Array;
  sourceUrl: string;
  suggestedFilename: string;
  pageCount?: number;
}

/** Resolve a CompanyDocument transaction_id to the cninfo static PDF URL. */
export function cninfoDocumentUrl(transactionId: string): string {
  const raw = transactionId.trim();
  if (/^https?:\/\//i.test(raw)) return assertCninfoPdfUrl(raw);
  const path = raw.replace(/^\/+/, "");
  return assertCninfoPdfUrl(`${CNINFO_STATIC_BASE_URL}/${path}`);
}

/** Fetch one cninfo announcement PDF by transaction_id (URL or adjunctUrl path). */
export async function getCninfoDocumentPdf(
  transactionId: string,
  options: AdapterOptions = {},
): Promise<CninfoDocument> {
  const url = cninfoDocumentUrl(transactionId);
  const headLen = await headContentLength(url, options);
  if (headLen !== undefined && headLen > CNINFO_DOCUMENT_MAX_BYTES) {
    throw new CninfoApiError(
      `cninfo document exceeds the ${CNINFO_DOCUMENT_MAX_BYTES / (1024 * 1024)} MB download cap.`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await getBinary(
      url,
      { ...BROWSER_HEADERS, Accept: "application/pdf, application/octet-stream, */*" },
      CNINFO_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new CninfoRateLimitError();
    }
    throw error;
  }
  if (bytes.byteLength > CNINFO_DOCUMENT_MAX_BYTES) {
    throw new CninfoApiError(
      `cninfo document exceeds the ${CNINFO_DOCUMENT_MAX_BYTES / (1024 * 1024)} MB download cap.`,
    );
  }
  if (!isPdfBytes(bytes)) throw new CninfoApiError(`cninfo returned no PDF at ${url}.`);
  const pageCount = countPdfPages(bytes);
  const basename = new URL(url).pathname.split("/").pop() || "cninfo-document.pdf";
  return {
    bytes,
    sourceUrl: url,
    suggestedFilename: basename.toLowerCase().endsWith(".pdf") ? basename : `${basename}.pdf`,
    ...(pageCount !== undefined ? { pageCount } : {}),
  };
}

// --- Aliases and adapter factory -------------------------------------------

export const resolveCompany = resolveCninfoCompany;
export const searchCompanies = searchCninfoCompanies;
export const searchFilings = searchCninfoFilings;
export const getLatestReport = getLatestCninfoReport;

export function createCninfoAdapter(options: AdapterOptions = {}) {
  return {
    resolveEntity: (query: string) => resolveCninfoCompany(query, options),
    searchEntities: (query: string) => searchCninfoCompanies(query, options),
    searchFilings: (input: string | CninfoFilingSearchParams) =>
      searchCninfoFilings(input, options),
    getLatestReport: (company: string, reportKind: "annual" | "quarterly") =>
      getLatestCninfoReport(company, reportKind, options),
    getFinancials: (company: string) => getCninfoFinancials(company, options),
    getOwners: (company: string) => getCninfoOwners(company, options),
    getInsiders: (company: string) => getCninfoInsiders(company, options),
    getDocumentPdf: (transactionId: string) =>
      getCninfoDocumentPdf(transactionId, options),
  };
}
