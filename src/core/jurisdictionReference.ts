/**
 * Compact per-jurisdiction reference cards, exposed as MCP resources by the
 * server (disclosures://jurisdictions/{code}) so a client can check what a
 * jurisdiction accepts and requires without spending a failed tool call.
 *
 * Deliberately bundled as string constants: the published artifact is one
 * self-contained dist/server.mjs, so the reference must not read from disk.
 * The full per-jurisdiction pages stay in docs/jurisdictions/ — these cards
 * carry only what a caller needs at dispatch time (source, credential,
 * accepted identifiers, supported intents, key caveat).
 */

export interface JurisdictionReference {
  code: string;
  name: string;
  source: string;
  credential: string;
  identifiers: string;
  intents: string;
  caveat: string;
}

export const JURISDICTION_REFERENCE: readonly JurisdictionReference[] = [
  {
    code: "US",
    name: "United States (default jurisdiction)",
    source: "SEC EDGAR + GLEIF",
    credential:
      "DISCLOSURES_USER_AGENT required (descriptive User-Agent with contact " +
      "email, per SEC fair-access policy); SEC_EDGAR_USER_AGENT accepted as " +
      "fallback. No API key.",
    identifiers: "Ticker, CIK, company name, LEI, ISIN (via GLEIF)",
    intents:
      "CompanyResolve, CompanyFilings, CompanyInsiders (Section 16), " +
      "CompanyOwners (13D/13G), CompanyFinancials (XBRL), PrivateRaises " +
      "(Form D), CompanyDocument (accession number), PersonAppointments " +
      "(reporting-owner CIKs + SALI link)",
    caveat:
      "Section 16 and 13D/13G reflect filed disclosures, not a complete " +
      "current cap table.",
  },
  {
    code: "GB",
    name: "United Kingdom",
    source: "Companies House (+ FCA NSM inject-only, + filings.xbrl.org for financials)",
    credential: "COMPANIES_HOUSE_API_KEY required (free).",
    identifiers: "Companies House company number (8 chars) or legal name",
    intents:
      "CompanyResolve (profile + previous names), CompanyFilings (+ " +
      "insolvency mode), CompanyInsiders (officers), CompanyOwners (PSC), " +
      "CompanyFinancials (UKSEF via EU route), CompanyDocument (transaction " +
      "id), CompanyCharges, PersonAppointments (officer ids + " +
      "disqualifications)",
    caveat:
      "TR-1 major holdings appear only when an FCA NSM fetchFn is injected; " +
      "a missing PSC does not prove no controller exists.",
  },
  {
    code: "EU",
    name: "European Union (ESEF filers)",
    source: "filings.xbrl.org (ESEF/UKSEF)",
    credential: "None.",
    identifiers: "LEI or legal name",
    intents:
      "CompanyResolve (ESEF register search), CompanyFilings (annual reports, " +
      "FY2020+), CompanyFinancials (annual IFRS). CompanyInsiders, " +
      "CompanyOwners, and PrivateRaises return an honest unsupported explanation.",
    caveat:
      "ESEF filers only, not a company register; a legal name matches the " +
      "filings.xbrl.org entity name, else pass a 20-character LEI.",
  },
  {
    code: "KR",
    name: "South Korea",
    source: "DART / OpenDART",
    credential: "OPENDART_API_KEY required (free).",
    identifiers: "8-digit corp code, 6-digit stock code, or legal name",
    intents:
      "CompanyResolve, CompanyFilings, CompanyInsiders (executive " +
      "ownership), CompanyOwners (5% rule), CompanyFinancials (major " +
      "accounts), CompanyDocument (14-digit rcept_no)",
    caveat: "CompanyDocument serves DART XML, never PDF.",
  },
  {
    code: "JP",
    name: "Japan",
    source: "EDINET",
    credential:
      "EDINET_API_KEY required for document search and CompanyDocument; " +
      "CompanyResolve is keyless.",
    identifiers:
      "EDINET code (E+5 digits), 4/5-digit securities code, 13-digit " +
      "corporate number, or legal name",
    intents:
      "CompanyResolve, CompanyFilings (date-indexed scan), CompanyOwners " +
      "(large-volume 5% reports; start_date/end_date bound the scan), " +
      "CompanyFinancials (annual XBRL headline totals from the 有価証券報告書, " +
      "JPY, consolidated preferred), CompanyDocument (docID; PDF or XBRL archive)",
    caveat:
      "EDINET's index is by filing date, so searches scan day by day — " +
      "narrow date ranges are much faster. No insider-dealing feed.",
  },
  {
    code: "CN",
    name: "China",
    source: "cninfo (SSE/SZSE + HKEX mirror), SZSE disclosure API",
    credential: "None.",
    identifiers: "6-digit A-share code, 5-digit HK code, or Chinese name",
    intents:
      "CompanyResolve, CompanyFilings (announcement PDFs + latest " +
      "annual/quarterly), CompanyFinancials (headline figures from the latest " +
      "periodic-report PDF), CompanyOwners (top-10 shareholders from the " +
      "freshest periodic report), CompanyInsiders (SZSE structured 董监高 " +
      "share-change feed; SSE annual-report 董监高 roster), CompanyDocument " +
      "(announcement PDF metadata/text/download) — the PDF-derived modes are " +
      "bounded/best-effort",
    caveat:
      "CompanyFinancials extracts revenue/profit/total-assets/net-assets from " +
      "the 主要会计数据 key-data table of the issuer's latest periodic report " +
      "(latest only, no history), normalized to whole RMB from the report's " +
      "stated unit (元/千元/万元/百万元). CompanyOwners parses the 前十名股东 " +
      "top-10 table as published — a point-in-time snapshot, not a live register " +
      "and not UBO tracing; column order varies by issuer so only " +
      "confidently-matched rows are emitted. CompanyInsiders is asymmetric by " +
      "exchange: SZSE codes (0/3xxxxx) get SZSE's keyless structured " +
      "董监高及相关人员股份变动 transaction feed, while SSE codes (6xxxxx) have " +
      "no equivalent public endpoint and fall back to the as-published " +
      "annual-report board roster (names + positions only). Every PDF-derived " +
      "mode degrades to the document link when the report is mojibake (an " +
      "object stream the extractor cannot read), over the size cap, or has no " +
      "readable table — it never emits figures it could not read.",
  },
  {
    code: "IN",
    name: "India",
    source: "BSE India",
    credential: "None, but the host is anti-bot protected.",
    identifiers: "6-digit BSE scrip code or company name",
    intents: "CompanyResolve, CompanyFilings (announcement PDFs)",
    caveat:
      "api.bseindia.com throttles unattended clients; inject a " +
      "browser-backed fetchFn if calls fail.",
  },
  {
    code: "TW",
    name: "Taiwan",
    source: "TWSE OpenAPI",
    credential: "None.",
    identifiers: "4-digit TWSE listing code or company name",
    intents:
      "CompanyResolve, CompanyFilings (material information), " +
      "CompanyInsiders (director/supervisor holdings), CompanyOwners (>10% " +
      "holders), CompanyFinancials (latest-period general-industry statements, NT$)",
    caveat:
      "Financials are the latest reported period only (general-industry issuers); " +
      "finance/insurance issuers file a variant format and history lives on MOPS.",
  },
  {
    code: "BR",
    name: "Brazil",
    source: "CVM open data",
    credential: "None.",
    identifiers: "Numeric CVM code or company name",
    intents:
      "CompanyResolve, CompanyFilings (IPE disclosure index), " +
      "CompanyFinancials (DFP annual, BRL), CompanyOwners (FRE posição " +
      "acionária, item 15), CompanyInsiders (FRE administradores, item 12)",
    caveat:
      "Bulk open-data files; first calls in a session can be slow. Owners and " +
      "insiders are the annual as-filed FRE snapshot, not a live cap table or a " +
      "dealings feed.",
  },
  {
    code: "DE",
    name: "Germany",
    source: "BaFin AnteileInfo + DealingsInfo",
    credential: "None.",
    identifiers: "8-digit BaFin-Id, ISIN, or company name",
    intents:
      "CompanyResolve, CompanyInsiders (Art.19 MAR dealings), CompanyOwners " +
      "(§§33 ff. WpHG voting rights), PersonAppointments (dealings persons); " +
      "for financials use jurisdiction EU",
    caveat:
      "UI-only HTML sources; no filings search — use CompanyFinancials " +
      "jurisdiction EU for German issuer accounts.",
  },
  {
    code: "FR",
    name: "France",
    source: "info-financiere.gouv.fr (OAM) + recherche-entreprises",
    credential: "None (both keyless).",
    identifiers:
      "Company name, 9-digit SIREN, ISIN, or LEI (listed issuers resolve via " +
      "the OAM; others via recherche-entreprises)",
    intents:
      "CompanyResolve, CompanyFilings (OAM regulated-information index with " +
      "direct PDFs), CompanyOwners (threshold-crossing notifications — linked " +
      "PDFs only, holder/% inside the document), CompanyDocument (OAM record id; " +
      "metadata/pdf, xhtml reports the OAM serves PDFs), PersonAppointments " +
      "(dirigeants; person→companies). For financials use jurisdiction EU.",
    caveat:
      "CompanyOwners is a linked-notification list, not a structured cap table " +
      "(the crossing holder and % live inside the PDF). No managers'-transaction " +
      "feed; recherche-entreprises keys people by name, so homonyms are common.",
  },
  {
    code: "HK",
    name: "Hong Kong",
    source: "HKEXnews",
    credential: "None.",
    identifiers: "4/5-digit HKEX stock code or listed issuer name",
    intents:
      "CompanyResolve (listed SEHK/GEM issuers), CompanyFilings (title-search " +
      "servlet + latest_annual), CompanyDocument (HKEXnews FILE_LINK path; PDF " +
      "or metadata), CompanyOwners (CCASS participant/custodian snapshot — " +
      "partial, keyless), CompanyFinancials (headline figures extracted from " +
      "the latest results-announcement PDF — bounded/best-effort)",
    caveat:
      "Listed issuers only (private cos are in the paid Companies Registry). " +
      "CompanyOwners returns the keyless CCASS shareholding search: " +
      "participant/custodian-level holdings (custodian banks, brokers, HKSCC " +
      "Nominees, CSDC), NOT beneficial owners — the SFO Part XV Disclosure of " +
      "Interests register is captcha-walled and linked for manual lookup " +
      "(insiders sit behind that same DI wall — honest unsupported). " +
      "CompanyFinancials extracts revenue/operating-profit/net-profit/total-" +
      "assets/total-equity from the issuer's latest results announcement (latest " +
      "only, no history); it degrades to the PDF link when a page shortfall or " +
      "missing statement makes the numbers unreliable. HKEXnews content is " +
      "copyrighted (link-first, on-demand fetch).",
  },
  {
    code: "SG",
    name: "Singapore",
    source: "ACRA (data.gov.sg)",
    credential: "None.",
    identifiers: "Singapore UEN or company name",
    intents:
      "CompanyResolve only (UEN, status, type, incorporation date, former names, " +
      "auditors, SSIC)",
    caveat:
      "Registry snapshot under the Singapore Open Data Licence — no officer " +
      "names (a count only), shareholders, financials, or charges. SGX/SGXNet " +
      "is Akamai + auth walled and BizFile extracts are paid, so every other SG " +
      "intent is honest unsupported.",
  },
  {
    code: "TH",
    name: "Thailand",
    source: "DBD juristic-person register (openapi.dbd.go.th)",
    credential:
      "None for the by-id lookup (keyless). DBD_API_KEY (free DGA GDX " +
      "registration key) required only for company-name search.",
    identifiers:
      "13-digit juristic-person registration number (keyless), or company " +
      "name in Thai or English (needs DBD_API_KEY)",
    intents:
      "CompanyResolve only (TH/EN legal name, juristic type, status, " +
      "registered + paid-up capital, TSIC objective code, register date, head " +
      "office). Listed and private companies both resolve.",
    caveat:
      "A company register, not a disclosure feed — no filings, officers, " +
      "shareholders or financial statements, so every other TH intent is " +
      "honest unsupported. The keyless endpoint is keyed by exact 13-digit " +
      "juristic number only; name search needs DBD_API_KEY. SET is " +
      "Incapsula-walled and the SEC idisc filings API is keyless but brittle.",
  },
  {
    code: "NL",
    name: "Netherlands",
    source: "AFM disclosure registers (keyless export.aspx CSV/XML)",
    credential: "None.",
    identifiers:
      "Issuer name as the AFM register spells it (e.g. \"ASML Holding N.V.\") " +
      "or a 20-character LEI; no ISIN index in these registers",
    intents:
      "CompanyResolve (from the register issuer names, LEI enriched via GLEIF), " +
      "CompanyOwners (Wft ch. 5.3 substantial holdings — holder, capital and " +
      "voting %, notification date), CompanyInsiders (Art.19 MAR managers' " +
      "transactions + directors'/commissioners' holdings); for financials use " +
      "jurisdiction EU",
    caveat:
      "Whole-file register exports with no server-side filtering: the " +
      "substantial-holdings CSV is ~108 MB, so the first CompanyOwners call in " +
      "a session takes ~20-30 s while it downloads and reduces the register. " +
      "Supply AdapterOptions.cache to keep the reduced digest for 24 h — " +
      "subsequent calls are milliseconds. Listed AFM-supervised issuers only " +
      "(KVK is paid); ESAP will eventually overlap this coverage.",
  },
  {
    code: "ID",
    name: "Indonesia",
    source: "IDX / Bursa Efek Indonesia (keyless /primary JSON + XBRL instances)",
    credential:
      "None — but the host is anti-bot protected. Where the default fetch is " +
      "challenged, supply a browser-backed fetchFn via AdapterOptions.",
    identifiers:
      "4-letter IDX ticker / kode emiten (e.g. BBCA, TLKM) or issuer name",
    intents:
      "CompanyResolve (all ~965 listed emiten — ticker, legal name, " +
      "sector/subsector, listing board and listing date), CompanyFilings " +
      "(per-issuer disclosure announcements with direct attachment PDFs), " +
      "CompanyFinancials (real XBRL: the filer's instance.zip parsed for " +
      "revenue, profit from operations, profit attributable to owners, total " +
      "assets and total equity in IDR)",
    caveat:
      "www.idx.co.id sits behind an anti-bot edge that answers a plain " +
      "request with a 403/503 challenge from some networks. This adapter " +
      "sends browser-class headers and works wherever that passes; where it " +
      "does not, every ID intent returns an explicit \"host blocked this " +
      "request — inject a browser-backed fetchFn via AdapterOptions\" note " +
      "rather than an empty result that would read as \"this issuer has " +
      "nothing on file\". CompanyFinancials is XBRL-first and falls back to " +
      "the official report link (never a guessed figure) when a submission " +
      "carries no instance.zip or tags none of the headline totals. " +
      "CompanyInsiders / CompanyOwners are honest-unsupported: director and " +
      "substantial-shareholder detail sits inside report PDFs or the separate " +
      "KSEI depository channel, not a clean IDX feed. AHU (the national legal- " +
      "entity registry) is a paid PNBP per-document product, and OJK is a " +
      "regulator/licensing site rather than a filing store.",
  },
  {
    code: "MY",
    name: "Malaysia",
    source: "Bursa Malaysia company announcements (api/v1/announcements/search)",
    credential:
      "None (keyless), but the host is Cloudflare-challenged: a browser-backed " +
      "AdapterOptions.fetchFn is required in practice.",
    identifiers:
      "4-digit Bursa stock code, optionally with an instrument suffix " +
      "(e.g. 1155 Maybank, 1295 Public Bank), or listed issuer name",
    intents:
      "CompanyResolve (from the announcements/company surface), CompanyFilings " +
      "(date window, limit, and the exchange's own category taxonomy, each row " +
      "linking the official announcement), CompanyInsiders (the \"Changes in " +
      "Director's Interest (S219 of CA 2016)\" category), CompanyOwners (the " +
      "\"Changes in Sub. S-hldr's Int. (29B/S138 of CA 2016)\" category). " +
      "Insiders and owners parse the linked announcement for director/holder " +
      "name, dated transaction, share count and resulting direct/indirect " +
      "holding.",
    caveat:
      "Both Bursa hosts sit behind a Cloudflare managed challenge whose " +
      "clearance is cookie-bound, so a plain request is answered with the " +
      "\"Just a moment...\" interstitial and every MY intent returns an honest " +
      "message naming AdapterOptions.fetchFn rather than an empty result. " +
      "Announcement detail is read for a capped number of rows per call; the " +
      "rest stay link-only. SSM (Companies Commission e-Info) is a paid " +
      "registry, so private-company resolution, documents and charges are " +
      "unsupported. Exchange copyright (link-first, on-demand fetch).",
  },
] as const;

export function renderJurisdictionReference(
  reference: JurisdictionReference,
): string {
  return [
    `# ${reference.code} — ${reference.name}`,
    "",
    `- **Source:** ${reference.source}`,
    `- **Credential:** ${reference.credential}`,
    `- **Accepted identifiers:** ${reference.identifiers}`,
    `- **Supported intents:** ${reference.intents}`,
    `- **Caveat:** ${reference.caveat}`,
  ].join("\n");
}

export function renderJurisdictionIndex(): string {
  return [
    "# Supported jurisdictions",
    "",
    "Read disclosures://jurisdictions/{code} for one jurisdiction's card.",
    "",
    ...JURISDICTION_REFERENCE.map(
      (reference) =>
        `- **${reference.code}** — ${reference.name}: ${reference.source}`,
    ),
  ].join("\n");
}
