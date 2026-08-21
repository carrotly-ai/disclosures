import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getText, getTextLenient, HttpError } from "../core/http.js";
import { decodeXmlEntities, plainXmlText, xmlBlocks } from "../core/parsing.js";
import { bafinRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Insider,
  OwnerRecord,
} from "../core/types.js";

// Germany's federal financial regulator BaFin publishes two public HTML search
// databases that this adapter reads:
//
//   * AnteileInfo  — "Stimmrechtsmitteilungen": major-holding voting-rights
//     notifications under §§33/34 WpHG (plus §38 instruments and §39 aggregate).
//     This backs CompanyOwners: an issuer-holdings page lists every notifiable
//     holder with the disclosed percentage per WpHG limb. Richer than most
//     jurisdictions because the percentages are present in the index itself.
//   * DealingsInfo — "Directors' Dealings": managers' transactions under
//     Art.19 MAR. This backs CompanyInsiders: each row is one reported
//     transaction by a person discharging managerial responsibilities (PDMR)
//     or a closely associated person.
//
// Both are UI-only HTML pages (no JSON API); this adapter scrapes their
// `displaytag` result tables with a zero-dependency parser and never returns
// document text. CompanyFinancials/CompanyFilings/PrivateRaises are out of
// scope for DE (BaFin exposes no free normalized machine-readable equivalent);
// the tool layer returns an honest unsupported explanation for those.
export const BAFIN_ANTEILE_SEARCH_URL =
  "https://portal.mvp.bafin.de/database/AnteileInfo/suche.do";
export const BAFIN_ANTEILE_ISSUER_URL =
  "https://portal.mvp.bafin.de/database/AnteileInfo/aktiengesellschaft.do";
export const BAFIN_ANTEILE_BASE_URL =
  "https://portal.mvp.bafin.de/database/AnteileInfo/";
export const BAFIN_DEALINGS_SEARCH_URL =
  "https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do";
export const BAFIN_DEALINGS_BASE_URL =
  "https://portal.mvp.bafin.de/database/DealingsInfo/";

export const BAFIN_REQUEST_TIMEOUT_MS = 20_000;
/** Cap on issuer search candidates / dealing rows surfaced from one lookup. */
export const BAFIN_MAX_RESULTS = 50;

export const BAFIN_WPHG_THRESHOLD_REGIME =
  "Germany WpHG major-holding notification (Stimmrechtsmitteilung): notifiable " +
  "voting-rights thresholds 3/5/10/15/20/25/30/50/75% under §§33/34 WpHG, with " +
  "§38 (instruments) and §39 (aggregate) holdings reported alongside";

export const BAFIN_MAR_REGIME =
  "EU MAR Art.19 managers' transactions (Directors' Dealings): transactions by " +
  "persons discharging managerial responsibilities and persons closely " +
  "associated with them, notifiable once the €5,000 per-calendar-year threshold " +
  "is crossed";

export const BAFIN_OWNERS_CAVEAT =
  "Parsed from BaFin's AnteileInfo database of major-holding voting-rights " +
  "notifications (§§33 ff. WpHG). Each row is a point-in-time notification, not " +
  "a live share register: a holder who has since crossed back below a threshold, " +
  "or who notified before the shown position, may not reflect the current stake. " +
  "Filing-based disclosure only — not UBO tracing; absence here is not proof no " +
  "notifiable holder exists.";

export const BAFIN_INSIDERS_CAVEAT =
  "Parsed from BaFin's DealingsInfo database of Directors' Dealings " +
  "notifications (Art.19 MAR). Each row is one reported transaction by a manager " +
  "or closely associated person; people who have not transacted recently will " +
  "not appear. This is a transaction feed, not a full officer register.";

export const BAFIN_RATE_LIMIT_MESSAGE =
  "BaFin portal request limit reached. Please retry later.";

export class BafinRateLimitError extends AdapterRateLimitError {
  constructor(message = BAFIN_RATE_LIMIT_MESSAGE) {
    super(message, 60, 60_000, "BaFin");
    this.name = "BafinRateLimitError";
  }
}

export class BafinApiError extends AdapterError {
  constructor(message: string) {
    super(message, "BaFin");
    this.name = "BafinApiError";
  }
}

function acquireRequest(): void {
  if (!bafinRateLimiter.tryAcquire()) throw new BafinRateLimitError();
}

function mapHttpError(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 429) {
    return new BafinRateLimitError();
  }
  return error;
}

async function fetchText(url: string, options: AdapterOptions): Promise<string> {
  acquireRequest();
  const headers = { Accept: "text/html", "Accept-Language": "de,en;q=0.8" };
  try {
    // An injected fetchFn always wins (that is how the offline suite stubs the
    // network). Only when the caller supplies no fetchFn do we read BaFin
    // through the lenient node:https path: BaFin's portal emits an obsolete
    // line-folded `Permissions-Policy` header that undici's global `fetch`
    // rejects with "Invalid header value char", so the built server could never
    // read it under the default fetch. See issue #42 and getTextLenient.
    if (options.fetchFn) {
      return await getText(url, headers, BAFIN_REQUEST_TIMEOUT_MS, options.fetchFn);
    }
    return await getTextLenient(url, headers, BAFIN_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw mapHttpError(error);
  }
}

// --- German text / encoding helpers ---------------------------------------

// BaFin serves UTF-8; when an upstream hop mis-decodes it as Latin-1 the umlauts
// arrive double-encoded ("Geschäfts" -> "GeschÃ¤fts"). Repair the classic
// sequences, but only when the tell-tale "Ã"/"Â" marker is present so correct
// UTF-8 text is left untouched.
const MOJIBAKE_PAIRS: Array<[RegExp, string]> = [
  [/Ã¤/g, "ä"],
  [/Ã¶/g, "ö"],
  [/Ã¼/g, "ü"],
  [/Ã„/g, "Ä"],
  [/Ã–/g, "Ö"],
  [/Ãœ/g, "Ü"],
  [/ÃŸ/g, "ß"],
  [/Ã©/g, "é"],
  [/Ã¨/g, "è"],
  [/Ã¡/g, "á"],
  [/Â§/g, "§"],
  [/Â /g, " "],
];

export function repairGermanText(value: string): string {
  if (!value.includes("Ã") && !value.includes("Â")) return value;
  let result = value;
  for (const [pattern, replacement] of MOJIBAKE_PAIRS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Fold umlauts and strip punctuation/space so German headers match by label. */
export function normalizeHeader(value: string): string {
  return repairGermanText(value)
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Normalise a company name for exact/prefix ranking (fold umlauts, collapse). */
function normalizeName(value: string): string {
  return repairGermanText(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Parse a German "dd.mm.yyyy" date (or ISO) to ISO "YYYY-MM-DD". */
export function parseGermanDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const dmy = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dmy) {
    const day = dmy[1]?.padStart(2, "0");
    const month = dmy[2]?.padStart(2, "0");
    return `${dmy[3]}-${month}-${day}`;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined;
}

/** Parse a German-formatted number ("5,0254" -> 5.0254, "1.234,5" -> 1234.5). */
export function parseGermanNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  let text = value.replace(/%/g, "").replace(/\s/g, "").trim();
  if (!text || text === "-" || text === "–") return undefined;
  if (text.includes(".") && text.includes(",")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(",", ".");
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Strip BaFin's inline "[+]"/"[-]" subsidiary-tree expander tokens (and the
 * trailing "(T)" Tochterunternehmen marker) that follow a holder's name link,
 * then collapse whitespace.
 */
function stripExpander(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/\[\s*[+\-]\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value.trim().toUpperCase());
}

function isBafinId(value: string): boolean {
  return /^\d{3,}$/.test(value.trim());
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// --- Zero-dependency displaytag table parser -------------------------------

export interface HtmlCell {
  text: string;
  href?: string;
}

export type HtmlRow = HtmlCell[];

export interface HtmlTable {
  headers: HtmlRow;
  rows: HtmlRow[];
}

function firstHref(cellHtml: string): string | undefined {
  const match = cellHtml.match(/<a\b[^>]*\bhref\s*=\s*["']?([^"'>\s]+)/i);
  const href = match?.[1];
  return href ? decodeXmlEntities(href) : undefined;
}

function parseRow(rowHtml: string): HtmlRow {
  const cells: HtmlRow = [];
  const cellPattern = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of rowHtml.matchAll(cellPattern)) {
    const inner = match[2] ?? "";
    const text = repairGermanText(plainXmlText(inner));
    const href = firstHref(inner);
    cells.push(href ? { text, href } : { text });
  }
  return cells;
}

interface HeaderSpanCell extends HtmlCell {
  colspan: number;
  rowspan: number;
}

function spanAttr(attrs: string, name: string): number {
  const raw = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"))?.[1];
  const value = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function parseHeaderRow(rowHtml: string): HeaderSpanCell[] {
  const cells: HeaderSpanCell[] = [];
  const cellPattern = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of rowHtml.matchAll(cellPattern)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const href = firstHref(inner);
    cells.push({
      text: repairGermanText(plainXmlText(inner)),
      ...(href ? { href } : {}),
      colspan: spanAttr(attrs, "colspan"),
      rowspan: spanAttr(attrs, "rowspan"),
    });
  }
  return cells;
}

/**
 * Flatten a multi-row `<thead>` (BaFin's AnteileInfo issuer table groups the
 * three WpHG voting-rights columns under a `colspan=3` parent with `rowspan=2`
 * identity columns beside it) into one leaf-header row, so column lookups match
 * the most specific label and the second header row is never read as data.
 */
function flattenHeaderRows(rowsHtml: string[]): HtmlRow {
  const rows = rowsHtml.map(parseHeaderRow);
  if (rows.length <= 1) {
    return (rows[0] ?? []).map(({ text, href }) =>
      href ? { text, href } : { text }
    );
  }
  const grid: (HeaderSpanCell | undefined)[][] = rows.map(() => []);
  for (let r = 0; r < rows.length; r += 1) {
    let col = 0;
    for (const cell of rows[r] ?? []) {
      while (grid[r]?.[col] !== undefined) col += 1;
      for (let i = 0; i < cell.colspan; i += 1) {
        for (let j = 0; j < cell.rowspan && r + j < rows.length; j += 1) {
          const target = grid[r + j];
          if (target) target[col + i] = cell;
        }
      }
      col += cell.colspan;
    }
  }
  const leaf = grid[grid.length - 1] ?? [];
  return leaf.map((cell) =>
    cell ? (cell.href ? { text: cell.text, href: cell.href } : { text: cell.text }) : { text: "" }
  );
}

/**
 * Extract the inner HTML of the first `<table>` whose opening tag satisfies
 * `matcher`, tracking nesting so a table-in-table does not truncate early.
 */
export function extractTable(
  html: string,
  matcher: (openTag: string) => boolean,
): string | undefined {
  const openPattern = /<table\b[^>]*>/gi;
  let open: RegExpExecArray | null;
  while ((open = openPattern.exec(html))) {
    if (!matcher(open[0])) continue;
    const start = open.index + open[0].length;
    const scan = /<(\/?)table\b[^>]*>/gi;
    scan.lastIndex = start;
    let depth = 1;
    let step: RegExpExecArray | null;
    while ((step = scan.exec(html))) {
      if (step[1] === "/") {
        depth -= 1;
        if (depth === 0) return html.slice(start, step.index);
      } else {
        depth += 1;
      }
    }
    return html.slice(start);
  }
  return undefined;
}

function tableToRows(inner: string): HtmlTable {
  // When the table separates <thead>/<tbody> (as both BaFin databases do),
  // flatten the header — which may span two rows — and read the body directly.
  const thead = inner.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
  if (thead?.[1]) {
    const headers = flattenHeaderRows(xmlBlocks(thead[1], "tr"));
    const tbody = inner.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    const bodyHtml = tbody?.[1] ?? inner.slice(thead.index! + thead[0].length);
    const body = xmlBlocks(bodyHtml, "tr").map(parseRow).filter((row) => row.length);
    return { headers, rows: body };
  }
  const rows = xmlBlocks(inner, "tr").map(parseRow).filter((row) => row.length);
  if (!rows.length) return { headers: [], rows: [] };
  // No <thead>: the first row that carries any header-like cell becomes the
  // header row; displaytag renders headers as <th>, so prefer that, else row 0.
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => cell.text.length > 0)
  );
  const headers = headerIndex >= 0 ? rows[headerIndex] ?? [] : rows[0] ?? [];
  const body = rows.slice((headerIndex >= 0 ? headerIndex : 0) + 1);
  return { headers, rows: body };
}

/** Find a displaytag table by its `id` attribute (e.g. id="geschaeft"). */
export function parseTableById(html: string, id: string): HtmlTable | undefined {
  const needle = `id="${id}"`;
  const inner = extractTable(html, (tag) =>
    tag.includes(needle) || tag.includes(`id='${id}'`)
  );
  return inner ? tableToRows(inner) : undefined;
}

/** Find the first table carrying a given class (e.g. class="displaytag"). */
export function parseFirstTableByClass(
  html: string,
  className: string,
): HtmlTable | undefined {
  const inner = extractTable(html, (tag) => {
    const match = tag.match(/class\s*=\s*["']([^"']*)["']/i);
    return match ? match[1]?.split(/\s+/).includes(className) ?? false : false;
  });
  return inner ? tableToRows(inner) : undefined;
}

function columnIndex(headers: HtmlRow, ...candidates: string[]): number {
  const needles = candidates.map(normalizeHeader);
  return headers.findIndex((cell) => {
    const header = normalizeHeader(cell.text);
    return needles.some((needle) => needle.length > 0 && header.includes(needle));
  });
}

function cellAt(row: HtmlRow, index: number): HtmlCell | undefined {
  return index >= 0 ? row[index] : undefined;
}

// --- AnteileInfo (major-holding voting rights) -----------------------------

function anteileSearchUrl(name: string): string {
  const params = new URLSearchParams({
    nameAktiengesellschaft: name,
    aktiengesellschaftSuche: "true",
  });
  return `${BAFIN_ANTEILE_SEARCH_URL}?${params.toString()}`;
}

function issuerHoldingsUrl(bafinId: string): string {
  const params = new URLSearchParams({
    cmd: "zeigeAktiengesellschaft",
    id: bafinId,
  });
  return `${BAFIN_ANTEILE_ISSUER_URL}?${params.toString()}`;
}

interface BafinIssuer {
  bafinId: string;
  legalName: string;
  domicile?: string;
  country?: string;
  sourceUrl: string;
}

function idFromHref(href: string | undefined): string | undefined {
  return href?.match(/[?&]id=(\d+)/)?.[1];
}

function parseAnteileSearch(html: string): BafinIssuer[] {
  const table = parseTableById(html, "aktiengesellschaft") ??
    parseTableById(html, "ergebnis") ??
    parseFirstTableByClass(html, "displaytag");
  if (!table) return [];
  const idCol = columnIndex(table.headers, "bafinid", "bafin");
  const nameCol = columnIndex(table.headers, "emittent");
  const sitzCol = columnIndex(table.headers, "sitz", "ort");
  const landCol = columnIndex(table.headers, "land");
  const issuers: BafinIssuer[] = [];
  for (const row of table.rows) {
    const nameCell = cellAt(row, nameCol);
    const legalName = nameCell?.text?.trim();
    if (!legalName) continue;
    const bafinId = idFromHref(nameCell?.href) ??
      cellAt(row, idCol)?.text?.replace(/\D/g, "");
    if (!bafinId) continue;
    const domicile = cellAt(row, sitzCol)?.text?.trim();
    const country = cellAt(row, landCol)?.text?.trim();
    issuers.push({
      bafinId,
      legalName,
      ...(domicile ? { domicile } : {}),
      ...(country ? { country } : {}),
      sourceUrl: issuerHoldingsUrl(bafinId),
    });
  }
  return issuers.slice(0, BAFIN_MAX_RESULTS);
}

function rankIssuers(issuers: BafinIssuer[], query: string): BafinIssuer[] {
  const target = normalizeName(query);
  const score = (issuer: BafinIssuer): number => {
    const name = normalizeName(issuer.legalName);
    if (name === target) return 0;
    if (name.startsWith(target)) return 1;
    if (name.includes(target)) return 2;
    return 3;
  };
  return issuers
    .map((issuer, index) => ({ issuer, index, rank: score(issuer) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.issuer);
}

function issuerToEntity(issuer: BafinIssuer, matchReason: string): Entity {
  return {
    legalName: issuer.legalName,
    bafinId: issuer.bafinId,
    jurisdiction: "DE",
    ...(issuer.domicile ? { status: issuer.domicile } : {}),
    sourceUrl: issuer.sourceUrl,
    source: "BaFin",
    matchReason,
    sourceIdentifiers: {
      jurisdiction: "DE",
      bafinId: issuer.bafinId,
    },
  };
}

/**
 * Resolve a German issuer to BaFin AnteileInfo candidates. A bare numeric
 * BaFin-Id resolves directly to its issuer-holdings page; an ISIN is resolved
 * to an issuer name via DealingsInfo first (AnteileInfo's search takes a name,
 * not an ISIN); otherwise the name search runs directly.
 */
export async function searchBafinCompanies(
  company: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const query = company.trim();
  if (!query) return [];

  if (isBafinId(query)) {
    return [
      issuerToEntity(
        { bafinId: query, legalName: query, sourceUrl: issuerHoldingsUrl(query) },
        "exact BaFin-Id",
      ),
    ];
  }

  let searchName = query;
  let viaIsin = false;
  if (isIsin(query)) {
    const dealings = await searchDealingsRaw({ isin: query }, options);
    const issuerName = dealings.find((row) => row.issuerName)?.issuerName;
    if (!issuerName) return [];
    searchName = issuerName;
    viaIsin = true;
  }

  const html = await fetchText(anteileSearchUrl(searchName), options);
  const issuers = rankIssuers(parseAnteileSearch(html), searchName);
  return issuers
    .slice(0, 10)
    .map((issuer) =>
      issuerToEntity(
        issuer,
        viaIsin ? `ISIN ${query} → AnteileInfo issuer` : "AnteileInfo name search",
      )
    );
}

interface BafinHolding {
  holderName: string;
  domicile?: string;
  country?: string;
  pctVotingRights?: number;
  pctInstruments?: number;
  pctAggregate?: number;
  publishedDate?: string;
  sourceUrl: string;
}

export function parseIssuerHoldings(
  html: string,
  issuerUrl: string,
): BafinHolding[] {
  const table = parseTableById(html, "geschaeft") ??
    parseFirstTableByClass(html, "displaytag");
  if (!table) return [];
  const holderCol = columnIndex(table.headers, "meldepflichtige");
  const sitzCol = columnIndex(table.headers, "sitzort", "sitz", "ort");
  const landCol = columnIndex(table.headers, "land");
  const vrCol = columnIndex(table.headers, "3334wphg", "3334");
  const instrCol = columnIndex(table.headers, "38wphg");
  const aggCol = columnIndex(table.headers, "39wphg");
  const pubCol = columnIndex(table.headers, "veroffentlichung", "40wphg");
  const holdings: BafinHolding[] = [];
  for (const row of table.rows) {
    const holderCell = cellAt(row, holderCol);
    // The holder cell carries a "[+]" subsidiary-tree expander anchor after the
    // real name link; drop it (and the "(T)" Tochterunternehmen marker) so the
    // notified name is clean.
    const holderName = stripExpander(holderCell?.text);
    if (!holderName) continue;
    const domicile = cellAt(row, sitzCol)?.text?.trim();
    const country = cellAt(row, landCol)?.text?.trim();
    const pctVotingRights = parseGermanNumber(cellAt(row, vrCol)?.text);
    const pctInstruments = parseGermanNumber(cellAt(row, instrCol)?.text);
    const pctAggregate = parseGermanNumber(cellAt(row, aggCol)?.text);
    const publishedDate = parseGermanDate(cellAt(row, pubCol)?.text);
    const href = holderCell?.href;
    holdings.push({
      holderName,
      ...(domicile ? { domicile } : {}),
      ...(country ? { country } : {}),
      ...(pctVotingRights !== undefined ? { pctVotingRights } : {}),
      ...(pctInstruments !== undefined ? { pctInstruments } : {}),
      ...(pctAggregate !== undefined ? { pctAggregate } : {}),
      ...(publishedDate ? { publishedDate } : {}),
      sourceUrl: href ? resolveUrl(BAFIN_ANTEILE_BASE_URL, href) : issuerUrl,
    });
  }
  return holdings;
}

function holdingToOwner(holding: BafinHolding): OwnerRecord {
  const breakdown: string[] = [];
  if (holding.pctInstruments !== undefined) {
    breakdown.push(`§38 instruments: ${holding.pctInstruments}%`);
  }
  if (holding.pctAggregate !== undefined) {
    breakdown.push(`§39 aggregate: ${holding.pctAggregate}%`);
  }
  const domicile = [holding.domicile, holding.country]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  return {
    holderName: holding.holderName,
    holderType: domicile || "Voting-rights holder",
    ...(holding.pctVotingRights !== undefined ? { pct: holding.pctVotingRights } : {}),
    thresholdRegime: BAFIN_WPHG_THRESHOLD_REGIME,
    form: "WpHG §§33/38/39",
    filedDate: holding.publishedDate ?? "Not stated",
    ...(holding.publishedDate ? { notifiedDate: holding.publishedDate } : {}),
    ...(breakdown.length ? { naturesOfControl: breakdown } : {}),
    sourceUrl: holding.sourceUrl,
    source: "BaFin",
    sourceIdentifiers: { jurisdiction: "DE" },
  };
}

/**
 * Return BaFin AnteileInfo major-holding voting-rights notifications for a
 * German issuer, resolved from a name, ISIN, or bare BaFin-Id. Each row is a
 * notifiable holder with the disclosed percentage per WpHG limb.
 */
export async function getBafinOwners(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const query = company.trim();
  if (!query) return [];

  let bafinId: string | undefined;
  if (isBafinId(query)) {
    bafinId = query;
  } else {
    const candidates = await searchBafinCompanies(query, options);
    bafinId = candidates.find((entity) => entity.bafinId)?.bafinId;
  }
  if (!bafinId) return [];

  const issuerUrl = issuerHoldingsUrl(bafinId);
  const html = await fetchText(issuerUrl, options);
  const holdings = parseIssuerHoldings(html, issuerUrl);
  return holdings.map(holdingToOwner);
}

// --- DealingsInfo (directors' dealings, Art.19 MAR) ------------------------

function dealingsSearchUrl(query: { name?: string; isin?: string }): string {
  const params = new URLSearchParams();
  if (query.isin) params.set("emittentIsin", query.isin);
  else if (query.name) params.set("emittentName", query.name);
  // The DealingsInfo form only runs the query when its submit button is posted;
  // without it BaFin re-renders the empty search form and returns no result table.
  params.set("emittentButton", "Suche Emittent");
  return `${BAFIN_DEALINGS_SEARCH_URL}?${params.toString()}`;
}

interface BafinDealing {
  issuerName?: string;
  bafinId?: string;
  isin?: string;
  person: string;
  position?: string;
  instrument?: string;
  transaction?: string;
  tradeDate?: string;
  place?: string;
  publishedDate?: string;
  sourceUrl: string;
}

function translatePosition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const low = value.toLowerCase();
  if (low.includes("vorstand")) return "Management board (Vorstand)";
  if (low.includes("aufsichtsrat")) return "Supervisory board (Aufsichtsrat)";
  return value;
}

function translateInstrument(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const low = value.toLowerCase();
  if (low.includes("derivat")) return "Derivative (Derivat)";
  if (low.includes("aktie")) return "Share (Aktie)";
  return value;
}

function translateTransaction(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const low = value.toLowerCase();
  if (low.includes("verkauf")) return "Sell (Verkauf)";
  if (low.includes("kauf")) return "Buy (Kauf)";
  if (low.includes("zeichnung")) return "Subscription (Zeichnung)";
  if (low.includes("sonstige")) return "Other (Sonstiges)";
  return value;
}

export function parseDealings(html: string, searchUrl: string): BafinDealing[] {
  const table = parseTableById(html, "emittent") ??
    parseFirstTableByClass(html, "displaytag");
  if (!table) return [];
  const issuerCol = columnIndex(table.headers, "emittent");
  const bafinIdCol = columnIndex(table.headers, "bafinid", "bafin");
  const isinCol = columnIndex(table.headers, "isin");
  const personCol = columnIndex(table.headers, "meldepflichtige");
  const posCol = columnIndex(table.headers, "position", "status", "funktion");
  const instrCol = columnIndex(table.headers, "artdesinstruments", "instrument");
  const transCol = columnIndex(table.headers, "artdesgeschaft");
  const tradeCol = columnIndex(table.headers, "datumdesgeschaft");
  const placeCol = columnIndex(table.headers, "ortdesgeschaft");
  const activatedCol = columnIndex(table.headers, "datumderaktivierung", "aktivierung");
  const dealings: BafinDealing[] = [];
  for (const row of table.rows) {
    const person = cellAt(row, personCol)?.text?.trim();
    if (!person) continue;
    const issuerName = cellAt(row, issuerCol)?.text?.trim();
    const bafinId = cellAt(row, bafinIdCol)?.text?.replace(/\D/g, "");
    const isin = cellAt(row, isinCol)?.text?.trim();
    const position = cellAt(row, posCol)?.text?.trim();
    const instrument = cellAt(row, instrCol)?.text?.trim();
    const transaction = cellAt(row, transCol)?.text?.trim();
    const tradeDate = parseGermanDate(cellAt(row, tradeCol)?.text);
    const place = cellAt(row, placeCol)?.text?.trim();
    const publishedDate = parseGermanDate(cellAt(row, activatedCol)?.text);
    // The per-notification detail link sits on the issuer (Emittent) cell;
    // the person cell is plain text. Fall back to the person cell's href, then
    // the search URL, so every row still carries a real, resolvable source.
    const href = cellAt(row, issuerCol)?.href ?? cellAt(row, personCol)?.href;
    dealings.push({
      ...(issuerName ? { issuerName } : {}),
      ...(bafinId ? { bafinId } : {}),
      ...(isin ? { isin } : {}),
      person,
      ...(position ? { position } : {}),
      ...(instrument ? { instrument } : {}),
      ...(transaction ? { transaction } : {}),
      ...(tradeDate ? { tradeDate } : {}),
      ...(place ? { place } : {}),
      ...(publishedDate ? { publishedDate } : {}),
      sourceUrl: href ? resolveUrl(BAFIN_DEALINGS_BASE_URL, href) : searchUrl,
    });
  }
  return dealings.slice(0, BAFIN_MAX_RESULTS);
}

async function searchDealingsRaw(
  query: { name?: string; isin?: string },
  options: AdapterOptions,
): Promise<BafinDealing[]> {
  const url = dealingsSearchUrl(query);
  const html = await fetchText(url, options);
  return parseDealings(html, url);
}

function dealingToInsider(dealing: BafinDealing): Insider {
  const role = translatePosition(dealing.position);
  const occupation = translateInstrument(dealing.instrument);
  return {
    name: dealing.person,
    roles: role ? [role] : [],
    ...(occupation ? { occupation } : {}),
    ...(dealing.place ? { status: dealing.place } : {}),
    form: translateTransaction(dealing.transaction) ?? dealing.transaction ?? "Directors' dealing",
    filedDate: dealing.publishedDate ?? dealing.tradeDate ?? "Not stated",
    ...(dealing.tradeDate ? { notifiedDate: dealing.tradeDate } : {}),
    sourceUrl: dealing.sourceUrl,
    source: "BaFin",
    sourceIdentifiers: {
      jurisdiction: "DE",
      ...(dealing.isin ? { isin: dealing.isin } : {}),
    },
  };
}

/**
 * Return BaFin DealingsInfo directors'-dealings notifications (Art.19 MAR) for
 * a German issuer, resolved from a name or ISIN. Each row is one reported
 * transaction by a PDMR or closely associated person.
 */
export async function getBafinDirectorsDealings(
  company: string,
  options: AdapterOptions = {},
): Promise<Insider[]> {
  const query = company.trim();
  if (!query) return [];
  const dealings = await searchDealingsRaw(
    isIsin(query) ? { isin: query } : { name: query },
    options,
  );
  return dealings
    .map(dealingToInsider)
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate));
}

// --- DealingsInfo person index (PersonAppointments DE analog) --------------
//
// DealingsInfo also indexes the *notifying persons* (Meldepflichtige), not just
// issuers. A person-name search returns candidate PDMRs each carrying a
// meldepflichtigerId; loading that id returns the same Art.19 MAR transaction
// table (id="emittent") scoped to the person — i.e. every issuer they have
// reported dealings to, with their board position. That is the closest German
// open-data analog to a cross-company appointment history: it is a
// transaction-filer index, not an officer register, and Germany publishes no
// disqualified-directors register queryable by individual.

export const BAFIN_DEALINGS_RESULT_URL =
  "https://portal.mvp.bafin.de/database/DealingsInfo/ergebnisListe.do";

export const BAFIN_PERSON_CAVEAT =
  "Parsed from BaFin's DealingsInfo (Directors' Dealings, Art.19 MAR) person " +
  "index. It lists people who have filed a managers'-transaction notification, " +
  "not a company-appointments register: a board member who has never personally " +
  "transacted will not appear, and the position shown is the role stated on the " +
  "notification. German homonyms are common — match by first name, title, and " +
  "issuer, not the id alone.";

export const BAFIN_NO_DISQUALIFICATION_MESSAGE =
  "Germany publishes no public disqualified-directors register queryable by " +
  "individual (unlike the UK Companies House register). A management-board ban " +
  "(Bestellungshindernis under §76 AktG / §6 GmbHG) follows automatically from a " +
  "relevant criminal conviction and is not exposed as a free searchable dataset. " +
  "There is no DE equivalent to surface here.";

function personSearchUrl(name: string): string {
  const params = new URLSearchParams({
    meldepflichtigerName: name,
    // Mirror the issuer form: the query only runs when the person submit button
    // is posted, otherwise BaFin re-renders the empty search form.
    meldepflichtigerButton: "Suche Meldepflichtiger",
  });
  return `${BAFIN_DEALINGS_SEARCH_URL}?${params.toString()}`;
}

function personAppointmentsUrl(meldepflichtigerId: string): string {
  const params = new URLSearchParams({
    cmd: "loadEmittentenAction",
    meldepflichtigerId,
  });
  return `${BAFIN_DEALINGS_RESULT_URL}?${params.toString()}`;
}

export interface BafinPersonMatch {
  meldepflichtigerId: string;
  surname: string;
  firstName?: string;
  title?: string;
  position?: string;
  latestTransactionDate?: string;
  sourceUrl: string;
}

function idFromMeldepflichtigerHref(href: string | undefined): string | undefined {
  return href?.match(/[?&]meldepflichtigerId=(\d+)/)?.[1];
}

export function parsePersonSearch(html: string): BafinPersonMatch[] {
  const table = parseTableById(html, "meldepflichtiger") ??
    parseFirstTableByClass(html, "displaytag");
  if (!table) return [];
  const nameCol = columnIndex(table.headers, "name");
  const firstCol = columnIndex(table.headers, "vorname");
  const titleCol = columnIndex(table.headers, "titel");
  const posCol = columnIndex(table.headers, "positionstatus", "position", "status");
  const dateCol = columnIndex(table.headers, "datumdesgeschaft", "datum");
  const matches: BafinPersonMatch[] = [];
  for (const row of table.rows) {
    const nameCell = cellAt(row, nameCol);
    const surname = nameCell?.text?.trim();
    const meldepflichtigerId = idFromMeldepflichtigerHref(nameCell?.href);
    if (!surname || !meldepflichtigerId) continue;
    const firstName = cellAt(row, firstCol)?.text?.trim();
    const title = cellAt(row, titleCol)?.text?.trim();
    const position = translatePosition(cellAt(row, posCol)?.text?.trim());
    const latestTransactionDate = parseGermanDate(cellAt(row, dateCol)?.text);
    matches.push({
      meldepflichtigerId,
      surname,
      ...(firstName ? { firstName } : {}),
      ...(title ? { title } : {}),
      ...(position ? { position } : {}),
      ...(latestTransactionDate ? { latestTransactionDate } : {}),
      sourceUrl: personAppointmentsUrl(meldepflichtigerId),
    });
  }
  return matches.slice(0, BAFIN_MAX_RESULTS);
}

/**
 * Search BaFin DealingsInfo for notifying persons (PDMRs) by name. Each match
 * carries the meldepflichtigerId used by `getBafinPersonAppointments`.
 */
export async function searchBafinPeople(
  name: string,
  options: AdapterOptions = {},
): Promise<BafinPersonMatch[]> {
  const query = name.trim();
  if (!query) return [];
  const html = await fetchText(personSearchUrl(query), options);
  return parsePersonSearch(html);
}

export interface BafinPersonAppointment {
  issuerName: string;
  bafinId?: string;
  isin?: string;
  position?: string;
  transactionCount: number;
  latestTransactionDate?: string;
  sourceUrl: string;
}

export interface BafinPersonAppointments {
  meldepflichtigerId: string;
  personName?: string;
  appointments: BafinPersonAppointment[];
  sourceUrl: string;
}

/**
 * Resolve one person's cross-issuer directors'-dealings history by
 * meldepflichtigerId: fetch their DealingsInfo detail table and collapse it to
 * one row per issuer (position, transaction count, latest trade date).
 */
export async function getBafinPersonAppointments(
  meldepflichtigerId: string,
  options: AdapterOptions = {},
): Promise<BafinPersonAppointments> {
  const id = meldepflichtigerId.trim();
  if (!/^\d+$/.test(id)) {
    throw new BafinApiError(
      "A numeric BaFin meldepflichtigerId (from PersonAppointments search) is required.",
    );
  }
  const url = personAppointmentsUrl(id);
  const html = await fetchText(url, options);
  const dealings = parseDealings(html, url);
  const byIssuer = new Map<string, BafinPersonAppointment>();
  for (const dealing of dealings) {
    const issuerName = dealing.issuerName;
    if (!issuerName) continue;
    const key = dealing.bafinId ?? issuerName;
    const existing = byIssuer.get(key);
    const position = translatePosition(dealing.position);
    if (existing) {
      existing.transactionCount += 1;
      if (
        dealing.tradeDate &&
        (!existing.latestTransactionDate ||
          dealing.tradeDate > existing.latestTransactionDate)
      ) {
        existing.latestTransactionDate = dealing.tradeDate;
      }
      if (!existing.position && position) existing.position = position;
    } else {
      byIssuer.set(key, {
        issuerName,
        ...(dealing.bafinId ? { bafinId: dealing.bafinId } : {}),
        ...(dealing.isin ? { isin: dealing.isin } : {}),
        ...(position ? { position } : {}),
        transactionCount: 1,
        ...(dealing.tradeDate ? { latestTransactionDate: dealing.tradeDate } : {}),
        sourceUrl: dealing.sourceUrl,
      });
    }
  }
  const appointments = [...byIssuer.values()].sort((left, right) =>
    (right.latestTransactionDate ?? "").localeCompare(left.latestTransactionDate ?? ""),
  );
  const personName = dealings.find((dealing) => dealing.person)?.person;
  return {
    meldepflichtigerId: id,
    ...(personName ? { personName } : {}),
    appointments,
    sourceUrl: url,
  };
}

export function createBafinAdapter(options: AdapterOptions = {}) {
  return {
    search: (company: string) => searchBafinCompanies(company, options),
    getOwners: (company: string) => getBafinOwners(company, options),
    getDirectorsDealings: (company: string) =>
      getBafinDirectorsDealings(company, options),
    searchPeople: (name: string) => searchBafinPeople(name, options),
    getPersonAppointments: (meldepflichtigerId: string) =>
      getBafinPersonAppointments(meldepflichtigerId, options),
  };
}
