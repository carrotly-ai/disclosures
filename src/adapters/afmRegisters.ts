import { readCachedJson, writeCachedJson } from "../core/cache.js";
import { AdapterError, AdapterRateLimitError } from "../core/errors.js";
import { getBinary, HttpError } from "../core/http.js";
import { decodeXmlEntities, plainXmlText } from "../core/parsing.js";
import { afmRateLimiter } from "../core/rateLimiter.js";
import type {
  AdapterOptions,
  Entity,
  Insider,
  OwnerRecord,
} from "../core/types.js";

// The Dutch AFM (Autoriteit Financiële Markten) publishes its statutory
// disclosure registers as keyless whole-file exports at
// `https://www.afm.nl/export.aspx?type=<GUID>&format=csv|xml`. No key, no
// login, no token — but also **no server-side filtering**: every export is the
// entire register, and a `?issuer=` style parameter is silently ignored
// (verified live: adding one returns a byte-identical file). Range requests are
// likewise not honoured — the server replies 200 with the whole body — so a
// per-issuer view can only be produced by fetching a register once and
// filtering client-side.
//
// Three registers back this adapter:
//
//   * substantiele-deelnemingen  — Wft substantial holdings (meldingen
//     zeggenschap). Backs CompanyOwners. This is the big one: the CSV is
//     ~108 MB / ~293k rows (the XML variant of the same register is ~360 MB, so
//     CSV is deliberately preferred here even though XML is otherwise safer).
//   * transacties-leidinggevenden-mar19-  — Art.19 MAR managers' transactions.
//     Backs CompanyInsiders. XML, ~4.8 MB.
//   * bestuurders-commissarissen — directors'/commissioners' holdings, with
//     before/change/after positions. Also backs CompanyInsiders. XML, ~8.9 MB.
//
// Because a whole register must be downloaded to answer one issuer's question,
// each register is reduced **at parse time** to a compact per-issuer digest and
// only that digest is cached (`AdapterOptions.cache`, 24h TTL). The
// substantial-holdings digest keeps the latest notification per
// (issuer, holder) pair, which collapses ~293k rows / 108 MB to ~2.4k records /
// ~0.3 MB — a ~360x reduction — so the cache stays small enough for a file or
// KV backend while the raw file is never persisted.
//
// Licence posture: AFM asserts copyright ("© Copyright AFM - alle rechten
// voorbehouden"); these are statutory public registers published under AFM's
// public task, keyless but not open-licensed. Same accepted posture as the
// shipped cninfo / BSE India / TWSE adapters — link-first, fetched on demand,
// AFM cited as the source, and no claim to redistribute the bulk export.

export const AFM_EXPORT_URL = "https://www.afm.nl/export.aspx";

/** Register export GUIDs, harvested from the AFM register pages. */
export const AFM_REGISTER_GUIDS = {
  substantialHoldings: "1331d46f-3fb6-4a36-b903-9584972675af",
  managersTransactions: "0ee836dc-5520-459d-bcf4-a4a689de6614",
  directorHoldings: "1b934036-12ad-4950-9773-31361d5adbd9",
} as const;

export type AfmRegisterKey = keyof typeof AFM_REGISTER_GUIDS;

/** Public AFM register pages, cited as the human-facing source for each row. */
export const AFM_REGISTER_PAGES: Record<AfmRegisterKey, string> = {
  substantialHoldings:
    "https://www.afm.nl/en/sector/registers/meldingenregisters/substantiele-deelnemingen",
  managersTransactions:
    "https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/transacties-leidinggevenden-mar19-",
  directorHoldings:
    "https://www.afm.nl/en/sector/registers/meldingenregisters/bestuurders-commissarissen",
};

/**
 * Substantial-holdings notification documents (org charts, chain-of-control
 * annexes) referenced from a register row's `toelichting` cell as a relative
 * `wmzk_documents/<file>.pdf` href.
 */
export const AFM_DOCUMENT_BASE_URL =
  "https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/substantiele-deelnemingen/";

// The substantial-holdings CSV is ~108 MB and takes ~17 s to transfer from a
// well-connected host, so the read timeout is generous relative to other
// adapters. The digest is cached for a day, so this cost is paid once.
export const AFM_REQUEST_TIMEOUT_MS = 180_000;

/** Guard against an unbounded body if AFM ever changes an export's shape. */
export const AFM_MAX_EXPORT_BYTES = 512 * 1024 * 1024;

/** Cap on rows surfaced from one lookup. */
export const AFM_MAX_RESULTS = 50;

/** Cap on resolution candidates returned. */
export const AFM_MAX_CANDIDATES = 10;

export const AFM_REGISTER_CACHE_TTL_MS = 24 * 60 * 60_000;
export const AFM_CACHE_KEY_PREFIX = "afm:register";

export const AFM_WFT_THRESHOLD_REGIME =
  "NL Wft substantial holdings (AFM register)";

export const AFM_WFT_THRESHOLD_DETAIL =
  "Netherlands Wft substantial-holdings notification (melding zeggenschap): " +
  "notifiable capital-interest and voting-rights thresholds 3/5/10/15/20/25/" +
  "30/40/50/60/75/95% under Wft ch. 5.3, reported to the AFM on crossing";

export const AFM_MAR_REGIME =
  "EU MAR Art.19 managers' transactions as notified to the AFM: transactions " +
  "by persons discharging managerial responsibilities and persons closely " +
  "associated with them, notifiable once the €5,000 per-calendar-year " +
  "threshold is crossed";

export const AFM_OWNERS_CAVEAT =
  "Derived from the AFM's substantial-holdings register (meldingen " +
  "zeggenschap, Wft ch. 5.3), reduced to the latest notification per holder. " +
  "Each row is a point-in-time notification, not a live share register: a " +
  "holder who has since crossed back below a threshold, or whose stake moved " +
  "without crossing one, may not reflect the current position. Percentages are " +
  "the bands as notified. Filing-based disclosure only — not UBO tracing; " +
  "absence here is not proof no notifiable holder exists.";

export const AFM_INSIDERS_CAVEAT =
  "Derived from the AFM's Art.19 MAR managers'-transactions register and its " +
  "directors'/commissioners' holdings register. The MAR register row records " +
  "that a notification was made (person, function, issuer LEI, transaction " +
  "date) — direction and size are in the notification itself, not the export. " +
  "The directors' register carries the before/change/after share and vote " +
  "counts. People who have not transacted recently will not appear; this is a " +
  "transaction feed, not a full officer register.";

export const AFM_RESOLVE_CAVEAT =
  "NL resolution is derived from the AFM disclosure registers themselves, so " +
  "it covers issuers that appear in a Dutch statutory disclosure register — " +
  "principally AFM-supervised listed issuers. A Dutch private company that has " +
  "never been the subject of a substantial-holdings, MAR Art.19, or " +
  "directors'-holdings notification will not resolve here: the KVK " +
  "Handelsregister API is paid (HTTP 401 without a purchased key) and is not " +
  "used. Enrich with OwnershipChain (GLEIF, keyless and global) for an LEI.";

export const AFM_NOT_FOUND_HINT =
  "NL covers issuers named in the AFM disclosure registers (AFM-supervised " +
  "listed issuers). Try the full Dutch legal name as the register spells it " +
  '(e.g. "ASML Holding N.V.", "Koninklijke Philips N.V.", "Heineken N.V."). ' +
  "An NL company that is not an AFM-registered issuer honestly will not " +
  "resolve here — the KVK Handelsregister API is paid, so private-company " +
  "resolution is out of scope; try OwnershipChain (GLEIF) instead.";

export const AFM_RATE_LIMIT_MESSAGE =
  "AFM register export request limit reached. Please retry later.";

export class AfmRateLimitError extends AdapterRateLimitError {
  constructor(message = AFM_RATE_LIMIT_MESSAGE) {
    super(message, 30, 60_000, "AFM");
    this.name = "AfmRateLimitError";
  }
}

export class AfmApiError extends AdapterError {
  constructor(message: string) {
    super(message, "AFM");
    this.name = "AfmApiError";
  }
}

function acquireRequest(): void {
  if (!afmRateLimiter.tryAcquire()) throw new AfmRateLimitError();
}

export function afmExportUrl(
  register: AfmRegisterKey,
  format: "csv" | "xml",
): string {
  const params = new URLSearchParams({
    type: AFM_REGISTER_GUIDS[register],
    format,
  });
  return `${AFM_EXPORT_URL}?${params.toString()}`;
}

/**
 * Fetch one whole-register export. The substantial-holdings CSV is
 * Windows-1252 (its `Reëel` column mojibakes if read as UTF-8) while the XML
 * exports are UTF-8, so the bytes are fetched raw and decoded per format.
 */
async function fetchExport(
  register: AfmRegisterKey,
  format: "csv" | "xml",
  options: AdapterOptions,
): Promise<string> {
  acquireRequest();
  const url = afmExportUrl(register, format);
  let bytes: Uint8Array;
  try {
    bytes = await getBinary(
      url,
      { Accept: format === "csv" ? "text/csv,*/*" : "application/xml,text/xml,*/*" },
      AFM_REQUEST_TIMEOUT_MS,
      options.fetchFn ?? fetch,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new AfmRateLimitError();
    }
    throw error;
  }
  if (bytes.byteLength > AFM_MAX_EXPORT_BYTES) {
    throw new AfmApiError(
      `AFM ${register} export exceeded ${AFM_MAX_EXPORT_BYTES} bytes.`,
    );
  }
  return new TextDecoder(format === "csv" ? "windows-1252" : "utf-8").decode(bytes);
}

// --- Dutch value helpers ---------------------------------------------------

/**
 * Parse an AFM percentage cell ("2,55 %" -> 2.55). Dutch decimal comma, with a
 * space before the sign; an empty or non-numeric cell yields undefined.
 */
export function parseDutchPercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.replace(/%/g, "").replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse a plain numeric AFM cell ("2227413.00000" -> 2227413). */
export function parseAfmNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return undefined;
  const parsed = Number.parseFloat(text.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Normalise an AFM date to ISO `YYYY-MM-DD`. The CSV uses
 * "2026-08-27 00:00:00"; the XML exports use US-style "8/27/2026 12:00:00 AM"
 * (and the directors register a bare "8/27/2026").
 */
export function parseAfmDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const month = us[1]?.padStart(2, "0");
    const day = us[2]?.padStart(2, "0");
    return `${us[3]}-${month}-${day}`;
  }
  return undefined;
}

/** Fold a company/issuer name for matching (drop legal suffixes and noise). */
export function normalizeIssuerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[.,]/g, " ")
    .replace(/\b(n\s*v|b\s*v|s\s*a|s\s*e|plc|ltd|limited|inc|holding|holdings|koninklijke)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isLei(value: string): boolean {
  return /^[A-Z0-9]{20}$/i.test(value.trim());
}

function isIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(value.trim());
}

/** Resolve a register row's relative document href onto the AFM document base. */
function resolveDocumentUrl(href: string): string | undefined {
  try {
    return new URL(href, AFM_DOCUMENT_BASE_URL).toString();
  } catch {
    return undefined;
  }
}

/**
 * Pull the first `<a href=...>` out of a substantial-holdings `toelichting`
 * cell. AFM emits these unquoted (`<a href=wmzk_documents/199404_...pdf>`), so
 * the href runs to the closing `>` rather than a quote.
 */
export function extractToelichtingDocument(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = value.match(/<a\b[^>]*\bhref\s*=\s*["']?([^"'>]+)/i);
  const href = match?.[1]?.trim();
  if (!href) return undefined;
  return resolveDocumentUrl(decodeXmlEntities(href));
}

// --- CSV parsing -----------------------------------------------------------

/**
 * Split one `;`-delimited, `"`-quoted AFM CSV line. Written as an index scan
 * rather than a regex because the file is ~108 MB and a backtracking pattern
 * would dominate the parse.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ";" && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function headerIndex(headers: string[], ...candidates: string[]): number {
  const normalized = headers.map((header) =>
    header.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = normalized.findIndex((header) => header === needle);
    if (found >= 0) return found;
  }
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = normalized.findIndex((header) => header.includes(needle));
    if (found >= 0) return found;
  }
  return -1;
}

// --- Digest shapes ---------------------------------------------------------
//
// Each register is reduced to one of these compact records before caching.
// Field names are short because the substantial-holdings digest is the largest
// cached value and JSON keys repeat per record.

/** One holder's latest substantial-holdings notification for one issuer. */
export interface AfmHoldingDigest {
  /** Issuer (uitgevende instelling). */
  i: string;
  /** Holder (meldingsplichtige). */
  h: string;
  /** Notification date, ISO. */
  d: string;
  /** Issuer domicile (plaats). */
  p?: string;
  /** Total capital interest %, from the "Kapitaalbelang" row. */
  cap?: number;
  /** Total voting rights %, from the "Stemrecht" row. */
  vot?: number;
  /** Share class, English where AFM provides it. */
  s?: string;
  /** Holder's KVK number, when the register carries one. */
  k?: string;
  /** Linked notification document, absolute. */
  u?: string;
}

/** One Art.19 MAR managers'-transaction notification. */
export interface AfmManagerTransactionDigest {
  /** Issuer. */
  i: string;
  /** Notifying person. */
  n: string;
  /** Transaction date, ISO. */
  d: string;
  /** Stated function. */
  f?: string;
  /** Issuer LEI. */
  l?: string;
  /** Person this notifier is closely associated with, when stated. */
  a?: string;
  /** AFM notification id. */
  m?: string;
}

/** One directors'/commissioners' holdings notification. */
export interface AfmDirectorHoldingDigest {
  /** Issuer. */
  i: string;
  /** Notifying director/commissioner. */
  n: string;
  /** Notification date, ISO. */
  d: string;
  /** Security type. */
  s?: string;
  /** Shares held before the change. */
  b?: number;
  /** Shares in the change itself. */
  c?: number;
  /** Shares held after the change. */
  t?: number;
  /** Price per share in the change. */
  v?: number;
  /** Currency of the price. */
  cur?: string;
  /** AFM notification id. */
  m?: string;
}

export interface AfmRegisterDigests {
  substantialHoldings: AfmHoldingDigest[];
  managersTransactions: AfmManagerTransactionDigest[];
  directorHoldings: AfmDirectorHoldingDigest[];
}

// --- Register parsing ------------------------------------------------------

/**
 * Reduce the substantial-holdings CSV to one record per (issuer, holder),
 * keeping the newest notification. The register writes each notification twice
 * — once with `Soort aandeel procentuele verdeling` = "Kapitaalbelang"
 * (capital interest) and once = "Stemrecht" (voting rights) — carrying the same
 * `Totale deelneming` percentage under each heading, plus one row per
 * intermediate holding entity. Collapsing to the latest pair turns ~293k rows
 * into ~2.4k records.
 */
export function parseSubstantialHoldingsCsv(csv: string): AfmHoldingDigest[] {
  const lines = csv.split(/\r?\n/);
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = parseCsvLine(headerLine).map((header) => header.replace(/^"|"$/g, ""));
  const dateCol = headerIndex(headers, "Datum meldingsplicht");
  const issuerCol = headerIndex(headers, "Uitgevende instelling");
  const holderCol = headerIndex(headers, "Meldingsplichtige");
  const kvkCol = headerIndex(headers, "Kvk-nr");
  const placeCol = headerIndex(headers, "Plaats");
  const shareEngCol = headerIndex(headers, "Soort aandeel ENG");
  const toelichtingCol = headerIndex(headers, "Toelichting");
  const splitCol = headerIndex(headers, "Soort aandeel procentuele verdeling");
  const totalCol = headerIndex(headers, "Totale deelneming");
  if (issuerCol < 0 || holderCol < 0) return [];

  const latest = new Map<string, AfmHoldingDigest>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (fields.length <= Math.max(issuerCol, holderCol)) continue;
    const issuer = fields[issuerCol]?.trim();
    const holder = fields[holderCol]?.trim();
    if (!issuer || !holder) continue;
    const date = parseAfmDate(fields[dateCol]);
    if (!date) continue;

    const key = `${issuer} ${holder}`;
    let record = latest.get(key);
    if (!record || date > record.d) {
      const place = fields[placeCol]?.trim();
      const shareClass = fields[shareEngCol]?.trim();
      const kvk = fields[kvkCol]?.trim();
      const documentUrl = extractToelichtingDocument(fields[toelichtingCol]);
      record = {
        i: issuer,
        h: holder,
        d: date,
        ...(place ? { p: place } : {}),
        ...(shareClass ? { s: shareClass } : {}),
        ...(kvk ? { k: kvk } : {}),
        ...(documentUrl ? { u: documentUrl } : {}),
      };
      latest.set(key, record);
    }
    if (record.d !== date) continue;
    // Same notification date: fold in whichever percentage limb this row states.
    const split = fields[splitCol]?.trim().toLowerCase();
    const total = parseDutchPercent(fields[totalCol]);
    if (total === undefined) continue;
    if (split === "kapitaalbelang") record.cap = total;
    else if (split === "stemrecht") record.vot = total;
  }
  return [...latest.values()];
}

/**
 * Split an AFM XML export into its `<vermelding>` records. Written as an index
 * scan for the same reason as the CSV splitter (multi-MB inputs), and because
 * these exports nest a second `<vermelding>` *inside* each record as a display
 * label — a lazy regex would stop at the inner close tag and truncate the row.
 */
export function splitVermeldingen(xml: string): string[] {
  const OPEN = "<vermelding>";
  const CLOSE = "</vermelding>";
  const records: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf(OPEN, cursor);
    if (start === -1) return records;
    let depth = 1;
    let scan = start + OPEN.length;
    let end = -1;
    while (depth > 0) {
      const nextOpen = xml.indexOf(OPEN, scan);
      const nextClose = xml.indexOf(CLOSE, scan);
      if (nextClose === -1) return records;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        scan = nextOpen + OPEN.length;
      } else {
        depth -= 1;
        scan = nextClose + CLOSE.length;
        if (depth === 0) end = nextClose;
      }
    }
    records.push(xml.slice(start + OPEN.length, end));
    cursor = scan;
  }
}

/**
 * Read a leaf element's text from one record. Restricted to `[^<]*` so it only
 * ever matches a leaf (a container like `<Wijzigingen>` is skipped rather than
 * returning its concatenated children).
 */
function leafValue(record: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const raw = pattern.exec(record)?.[1];
  if (raw === undefined) return undefined;
  const text = decodeXmlEntities(raw).trim();
  return text || undefined;
}

/** Read the first child leaf inside a container element (e.g. Voorposities). */
function nestedLeafValue(
  record: string,
  container: string,
  tag: string,
): string | undefined {
  const pattern = new RegExp(`<${container}>([\\s\\S]*?)</${container}>`, "i");
  const inner = pattern.exec(record)?.[1];
  return inner ? leafValue(inner, tag) : undefined;
}

export function parseManagersTransactionsXml(
  xml: string,
): AfmManagerTransactionDigest[] {
  const records: AfmManagerTransactionDigest[] = [];
  for (const record of splitVermeldingen(xml)) {
    const issuer = leafValue(record, "uitgevendeinstelling");
    const person = leafValue(record, "meldingsplichtige");
    if (!issuer || !person) continue;
    const date = parseAfmDate(leafValue(record, "transactiedatum"));
    if (!date) continue;
    const functie = leafValue(record, "functie");
    const lei = leafValue(record, "lei");
    const associated = leafValue(record, "nauwgelieerdaan");
    const meldingId = leafValue(record, "meldingid");
    records.push({
      i: issuer,
      n: person,
      d: date,
      ...(functie ? { f: functie } : {}),
      ...(lei ? { l: lei } : {}),
      ...(associated ? { a: associated } : {}),
      ...(meldingId ? { m: meldingId } : {}),
    });
  }
  return records;
}

export function parseDirectorHoldingsXml(xml: string): AfmDirectorHoldingDigest[] {
  const records: AfmDirectorHoldingDigest[] = [];
  for (const record of splitVermeldingen(xml)) {
    const issuer = leafValue(record, "UitgevendeInstelling");
    const person = leafValue(record, "Meldingsplichtige");
    if (!issuer || !person) continue;
    const date = parseAfmDate(leafValue(record, "DatumMeldingsplicht"));
    if (!date) continue;
    const before = parseAfmNumber(
      nestedLeafValue(record, "Voorposities", "AantalEffecten"),
    );
    const change = parseAfmNumber(
      nestedLeafValue(record, "Wijzigingen", "AantalEffecten"),
    );
    const after = parseAfmNumber(
      nestedLeafValue(record, "Naposities", "AantalEffecten"),
    );
    const price = parseAfmNumber(
      nestedLeafValue(record, "Wijzigingen", "WaardePerAandeel"),
    );
    const currency = nestedLeafValue(record, "Wijzigingen", "Valuta");
    const securityType =
      nestedLeafValue(record, "Wijzigingen", "SoortEffect") ??
      nestedLeafValue(record, "Naposities", "SoortEffect");
    const meldingId = leafValue(record, "meldingid");
    records.push({
      i: issuer,
      n: person,
      d: date,
      ...(securityType ? { s: securityType } : {}),
      ...(before !== undefined ? { b: before } : {}),
      ...(change !== undefined ? { c: change } : {}),
      ...(after !== undefined ? { t: after } : {}),
      ...(price !== undefined ? { v: price } : {}),
      ...(currency ? { cur: currency } : {}),
      ...(meldingId ? { m: meldingId } : {}),
    });
  }
  return records;
}

// --- Cached register loading -----------------------------------------------

const registerPromises = new Map<AfmRegisterKey, Promise<unknown[]>>();

/** Reset the process-local register memo (used by tests for isolation). */
export function resetAfmRegisterCache(): void {
  registerPromises.clear();
}

function cacheKey(register: AfmRegisterKey): string {
  return `${AFM_CACHE_KEY_PREFIX}:${register}:v1`;
}

function validateDigestCache(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // A digest record always carries issuer + a date; anything else is a stale or
  // corrupt entry and is treated as a miss so the register refetches.
  const usable = value.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { i?: unknown }).i === "string" &&
      typeof (entry as { d?: unknown }).d === "string",
  );
  if (!usable) return undefined;
  return value.length ? value : undefined;
}

async function buildDigest(
  register: AfmRegisterKey,
  options: AdapterOptions,
): Promise<unknown[]> {
  if (register === "substantialHoldings") {
    // CSV, not XML: the same register's XML export is ~360 MB against ~108 MB
    // for the CSV, so CSV is the smaller dataset that serves the intent.
    const csv = await fetchExport(register, "csv", options);
    const rows = parseSubstantialHoldingsCsv(csv);
    if (!rows.length) {
      throw new AfmApiError("AFM substantial-holdings export contained no rows.");
    }
    return rows;
  }
  const xml = await fetchExport(register, "xml", options);
  const rows =
    register === "managersTransactions"
      ? parseManagersTransactionsXml(xml)
      : parseDirectorHoldingsXml(xml);
  if (!rows.length) {
    throw new AfmApiError(`AFM ${register} export contained no records.`);
  }
  return rows;
}

/**
 * Load one register's digest: injected cache first (survives process restarts,
 * 24h TTL), then a process-local in-flight memo, then the network. Only the
 * reduced digest is ever cached — never the raw multi-MB export.
 */
async function loadRegister<T>(
  register: AfmRegisterKey,
  options: AdapterOptions,
): Promise<T[]> {
  const key = cacheKey(register);
  if (options.cache) {
    const cached = await readCachedJson(options.cache, key, validateDigestCache);
    if (cached) return cached as T[];
  }
  let promise = registerPromises.get(register);
  if (!promise) {
    promise = buildDigest(register, options);
    registerPromises.set(register, promise);
  }
  let rows: unknown[];
  try {
    rows = await promise;
  } catch (error) {
    registerPromises.delete(register);
    throw error;
  }
  if (options.cache) {
    await writeCachedJson(options.cache, key, rows, AFM_REGISTER_CACHE_TTL_MS);
  }
  return rows as T[];
}

export async function loadAfmSubstantialHoldings(
  options: AdapterOptions = {},
): Promise<AfmHoldingDigest[]> {
  return loadRegister<AfmHoldingDigest>("substantialHoldings", options);
}

export async function loadAfmManagersTransactions(
  options: AdapterOptions = {},
): Promise<AfmManagerTransactionDigest[]> {
  return loadRegister<AfmManagerTransactionDigest>("managersTransactions", options);
}

export async function loadAfmDirectorHoldings(
  options: AdapterOptions = {},
): Promise<AfmDirectorHoldingDigest[]> {
  return loadRegister<AfmDirectorHoldingDigest>("directorHoldings", options);
}

// --- Issuer matching -------------------------------------------------------

interface IssuerMatch {
  name: string;
  /** 0 exact, 1 prefix, 2 substring — lower is better. */
  rank: number;
}

function scoreIssuer(name: string, query: string): number | undefined {
  const candidate = normalizeIssuerName(name);
  const target = normalizeIssuerName(query);
  if (!candidate || !target) return undefined;
  if (candidate === target) return 0;
  if (candidate.startsWith(target)) return 1;
  if (candidate.includes(target)) return 2;
  return undefined;
}

/**
 * Rank the distinct issuer names present across the loaded registers against a
 * query. Exact match first, then prefix, then substring, then alphabetical so
 * the ordering is stable.
 */
export function rankIssuerNames(names: Iterable<string>, query: string): string[] {
  const seen = new Map<string, IssuerMatch>();
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    const rank = scoreIssuer(name, query);
    if (rank === undefined) continue;
    seen.set(name, { name, rank });
  }
  return [...seen.values()]
    .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
    .map((match) => match.name);
}

/**
 * Resolve a query to the single best issuer name, preferring the registers a
 * given intent actually reads so an issuer present in one register is not
 * matched against a near-namesake in another.
 */
function bestIssuer(names: Iterable<string>, query: string): string | undefined {
  return rankIssuerNames(names, query)[0];
}

// --- CompanyResolve --------------------------------------------------------

interface AfmIssuerRecord {
  name: string;
  lei?: string;
  domicile?: string;
  registers: string[];
  latestDate?: string;
}

function noteIssuer(
  index: Map<string, AfmIssuerRecord>,
  name: string,
  register: string,
  extra: { lei?: string; domicile?: string; date?: string },
): void {
  let record = index.get(name);
  if (!record) {
    record = { name, registers: [] };
    index.set(name, record);
  }
  if (!record.registers.includes(register)) record.registers.push(register);
  if (extra.lei && !record.lei) record.lei = extra.lei;
  if (extra.domicile && !record.domicile) record.domicile = extra.domicile;
  if (extra.date && (!record.latestDate || extra.date > record.latestDate)) {
    record.latestDate = extra.date;
  }
}

/**
 * Build the NL issuer index from the three registers. The MAR register is the
 * richest for resolution because it carries the issuer's LEI, so it is read
 * first; substantial holdings contributes the issuers that only ever appear in
 * a holdings notification (verified live: 11 issuers are substantial-holdings
 * only), and the directors register contributes the rest.
 */
async function buildIssuerIndex(
  options: AdapterOptions,
): Promise<Map<string, AfmIssuerRecord>> {
  const index = new Map<string, AfmIssuerRecord>();
  const [managers, directors, holdings] = await Promise.all([
    loadAfmManagersTransactions(options),
    loadAfmDirectorHoldings(options),
    loadAfmSubstantialHoldings(options),
  ]);
  for (const row of managers) {
    noteIssuer(index, row.i, "Art.19 MAR managers' transactions", {
      ...(row.l ? { lei: row.l } : {}),
      date: row.d,
    });
  }
  for (const row of directors) {
    noteIssuer(index, row.i, "Directors'/commissioners' holdings", { date: row.d });
  }
  for (const row of holdings) {
    noteIssuer(index, row.i, "Substantial holdings (Wft)", {
      ...(row.p ? { domicile: row.p } : {}),
      date: row.d,
    });
  }
  return index;
}

function issuerToEntity(record: AfmIssuerRecord, matchReason: string): Entity {
  return {
    legalName: record.name,
    jurisdiction: "NL",
    ...(record.lei ? { lei: record.lei } : {}),
    ...(record.domicile ? { status: record.domicile } : {}),
    sourceUrl: AFM_REGISTER_PAGES.substantialHoldings,
    source: "AFM",
    matchReason,
    sourceIdentifiers: {
      jurisdiction: "NL",
      ...(record.lei ? { lei: record.lei } : {}),
    },
  };
}

/**
 * Resolve a Dutch issuer from the AFM registers. A bare LEI matches the LEI the
 * MAR register carries; otherwise the query is name-matched against every
 * issuer named in the three registers. There is no ISIN index in these exports
 * (only the net-short register carries ISINs), so an ISIN query is reported as
 * unresolvable here rather than silently mis-matched.
 */
export async function searchAfmCompanies(
  company: string,
  options: AdapterOptions = {},
): Promise<Entity[]> {
  const query = company.trim();
  if (!query) return [];
  const index = await buildIssuerIndex(options);

  if (isLei(query)) {
    const upper = query.toUpperCase();
    const matches = [...index.values()].filter(
      (record) => record.lei?.toUpperCase() === upper,
    );
    return matches
      .slice(0, AFM_MAX_CANDIDATES)
      .map((record) => issuerToEntity(record, `exact LEI ${upper} (AFM MAR register)`));
  }

  if (isIsin(query)) {
    // The three registers this adapter reads key on issuer name (and LEI in the
    // MAR export); none carries an ISIN column, so an ISIN cannot be matched.
    return [];
  }

  const ranked = rankIssuerNames(index.keys(), query);
  return ranked.slice(0, AFM_MAX_CANDIDATES).map((name) => {
    const record = index.get(name);
    const reason = record?.registers.length
      ? `AFM register name match (${record.registers.join("; ")})`
      : "AFM register name match";
    return issuerToEntity(record ?? { name, registers: [] }, reason);
  });
}

// --- CompanyOwners ---------------------------------------------------------

function holdingToOwner(holding: AfmHoldingDigest): OwnerRecord {
  // Wft notifications state a capital interest and a voting-rights percentage;
  // surface the voting-rights figure as the headline `pct` (matching how DE/GB
  // report control) and keep both in the structured fields.
  const pct = holding.vot ?? holding.cap;
  const breakdown: string[] = [];
  if (holding.cap !== undefined) breakdown.push(`Capital interest: ${holding.cap}%`);
  if (holding.vot !== undefined) breakdown.push(`Voting rights: ${holding.vot}%`);
  if (holding.s) breakdown.push(`Share class: ${holding.s}`);
  return {
    holderName: holding.h,
    holderType: "Substantial holder (Wft ch. 5.3)",
    ...(pct !== undefined ? { pct } : {}),
    ...(holding.cap !== undefined ? { pctCapital: holding.cap } : {}),
    ...(holding.vot !== undefined ? { pctVotingRights: holding.vot } : {}),
    thresholdRegime: AFM_WFT_THRESHOLD_REGIME,
    form: "Wft melding zeggenschap",
    filedDate: holding.d,
    notifiedDate: holding.d,
    ...(breakdown.length ? { naturesOfControl: breakdown } : {}),
    sourceUrl: holding.u ?? AFM_REGISTER_PAGES.substantialHoldings,
    source: "AFM",
    sourceIdentifiers: { jurisdiction: "NL" },
  };
}

/**
 * Return the AFM substantial-holdings notifications for a Dutch issuer, newest
 * first. Each row is the latest notification by one holder.
 */
export async function getAfmOwners(
  company: string,
  options: AdapterOptions = {},
): Promise<OwnerRecord[]> {
  const query = company.trim();
  if (!query) return [];
  const holdings = await loadAfmSubstantialHoldings(options);
  const issuer = bestIssuer(holdings.map((row) => row.i), query);
  if (!issuer) return [];
  return holdings
    .filter((row) => row.i === issuer)
    .map(holdingToOwner)
    .sort(
      (left, right) =>
        right.filedDate.localeCompare(left.filedDate) ||
        (right.pct ?? 0) - (left.pct ?? 0),
    )
    .slice(0, AFM_MAX_RESULTS);
}

// --- CompanyInsiders -------------------------------------------------------

function managerTransactionToInsider(
  row: AfmManagerTransactionDigest,
): Insider {
  const roles = row.f ? [row.f] : [];
  const status = row.a ? `Closely associated with ${row.a}` : undefined;
  return {
    name: row.n,
    roles,
    ...(row.f ? { officerRole: row.f } : {}),
    ...(status ? { status } : {}),
    form: "Art.19 MAR managers' transaction",
    filedDate: row.d,
    notifiedDate: row.d,
    sourceUrl: AFM_REGISTER_PAGES.managersTransactions,
    source: "AFM",
    sourceIdentifiers: {
      jurisdiction: "NL",
      ...(row.l ? { lei: row.l } : {}),
    },
  };
}

function directorHoldingToInsider(row: AfmDirectorHoldingDigest): Insider {
  const detail: string[] = [];
  if (row.b !== undefined) detail.push(`before ${row.b.toLocaleString("en-US")}`);
  if (row.c !== undefined) detail.push(`change ${row.c.toLocaleString("en-US")}`);
  if (row.t !== undefined) detail.push(`after ${row.t.toLocaleString("en-US")}`);
  if (row.v !== undefined) {
    detail.push(`at ${row.cur ? `${row.cur} ` : ""}${row.v}`);
  }
  const occupation = detail.length
    ? `${row.s ? `${row.s}: ` : ""}${detail.join(", ")}`
    : row.s;
  return {
    name: row.n,
    roles: ["Director / commissioner"],
    ...(occupation ? { occupation } : {}),
    ...(row.c !== undefined ? { change: row.c } : {}),
    form: "Directors'/commissioners' holdings notification",
    filedDate: row.d,
    notifiedDate: row.d,
    sourceUrl: AFM_REGISTER_PAGES.directorHoldings,
    source: "AFM",
    sourceIdentifiers: { jurisdiction: "NL" },
  };
}

/**
 * Return AFM insider records for a Dutch issuer: Art.19 MAR managers'
 * transactions merged with directors'/commissioners' holdings notifications,
 * newest first. The two registers are matched independently so an issuer
 * present in only one still returns rows.
 */
export async function getAfmInsiders(
  company: string,
  options: AdapterOptions = {},
): Promise<Insider[]> {
  const query = company.trim();
  if (!query) return [];
  const [managers, directors] = await Promise.all([
    loadAfmManagersTransactions(options),
    loadAfmDirectorHoldings(options),
  ]);

  const managerIssuer = bestIssuer(managers.map((row) => row.i), query);
  const directorIssuer = bestIssuer(directors.map((row) => row.i), query);

  const insiders: Insider[] = [
    ...(managerIssuer
      ? managers.filter((row) => row.i === managerIssuer).map(managerTransactionToInsider)
      : []),
    ...(directorIssuer
      ? directors.filter((row) => row.i === directorIssuer).map(directorHoldingToInsider)
      : []),
  ];

  return insiders
    .sort((left, right) => right.filedDate.localeCompare(left.filedDate))
    .slice(0, AFM_MAX_RESULTS);
}

export function createAfmAdapter(options: AdapterOptions = {}) {
  return {
    search: (company: string) => searchAfmCompanies(company, options),
    getOwners: (company: string) => getAfmOwners(company, options),
    getInsiders: (company: string) => getAfmInsiders(company, options),
  };
}
