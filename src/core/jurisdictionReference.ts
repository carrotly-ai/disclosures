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
    source: "cninfo (SSE/SZSE + HKEX mirror)",
    credential: "None.",
    identifiers: "6-digit A-share code, 5-digit HK code, or Chinese name",
    intents:
      "CompanyResolve, CompanyFilings (announcement PDFs + latest " +
      "annual/quarterly)",
    caveat:
      "Ownership/financial data lives inside Chinese-language report PDFs " +
      "this package does not parse.",
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
      "CompanyFinancials (DFP annual, BRL)",
    caveat: "Bulk open-data files; first calls in a session can be slow.",
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
      "partial, keyless)",
    caveat:
      "Listed issuers only (private cos are in the paid Companies Registry). " +
      "CompanyOwners returns the keyless CCASS shareholding search: " +
      "participant/custodian-level holdings (custodian banks, brokers, HKSCC " +
      "Nominees, CSDC), NOT beneficial owners — the SFO Part XV Disclosure of " +
      "Interests register is captcha-walled and linked for manual lookup. " +
      "Insiders sit behind that same DI wall, and financials live inside " +
      "annual-report PDFs — both honest unsupported. HKEXnews content is " +
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
