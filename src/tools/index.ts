import { z } from "zod";
import { defineTool, textResult } from "../core/toolDefs.js";
import type { ToolDefinition } from "../core/toolDefs.js";
import { formatNumber, joinSections, link, markdownTable } from "../core/markdown.js";
import type { AdapterOptions, Entity, OwnershipParent } from "../core/types.js";
import {
  SEC_FINANCIAL_CONCEPT_NAMES,
  getLatestSecReport,
  getSecFinancials,
  getSecInsiders,
  getSecOwners,
  getSecPrivateRaises,
  hasSecConfiguration,
  searchSecCompanies,
  searchSecFilings,
} from "../adapters/secEdgar.js";
import {
  getOwnershipChain,
  isLei,
  resolveGleifEntity,
  searchGleifEntities,
} from "../adapters/gleif.js";
import {
  COMPANIES_HOUSE_PSC_THRESHOLD_REGIME,
  getCompaniesHouseOfficers,
  getCompaniesHouseOwners,
  getLatestCompaniesHouseReport,
  searchCompaniesHouseCompanies,
  searchCompaniesHouseFilings,
} from "../adapters/companiesHouse.js";
import {
  getLatestOpenDartReport,
  getOpenDartFinancials,
  getOpenDartInsiders,
  getOpenDartOwners,
  OPEN_DART_5_PERCENT_THRESHOLD_REGIME,
  OPEN_DART_ACCOUNT_CONCEPTS,
  searchOpenDartCompanies,
  searchOpenDartFilings,
} from "../adapters/openDart.js";
import {
  EDINET_5_PERCENT_THRESHOLD_REGIME,
  getLatestEdinetReport,
  searchEdinetCompanies,
  searchEdinetFilings,
} from "../adapters/edinet.js";
import {
  getLatestCninfoReport,
  searchCninfoCompanies,
  searchCninfoFilings,
} from "../adapters/cninfo.js";
import {
  BSE_ANTIBOT_NOTE,
  searchBseCompanies,
  searchBseFilings,
} from "../adapters/bseIndia.js";
import {
  FCA_NSM_INJECT_NOTE,
  FCA_NSM_TR1_CAVEAT,
  getFcaNsmMajorHoldings,
  hasFcaNsmAccess,
} from "../adapters/fcaNsm.js";
import { companyInput, failureResult, notFoundResult } from "./shared.js";

const CONSOLIDATION_CAVEAT =
  "Caveat: GLEIF Level 2 relationships are accounting-consolidation parents " +
  "reported for LEI compliance. They are not market-disclosure ownership " +
  "stakes, and they are not ultimate-beneficial-owner (UBO) tracing through " +
  "private holding chains.";

const COMPANIES_HOUSE_PSC_CAVEAT =
  "The Companies House PSC register is a statutory control register under the " +
  `${COMPANIES_HOUSE_PSC_THRESHOLD_REGIME}. It is not guaranteed-complete ` +
  "UBO/KYC evidence, may include corporate entities and legal persons rather " +
  "than natural persons, and the ECCTA identity-verification transition can " +
  "affect which verification fields are available.";

function readableCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text[0]?.toUpperCase() + text.slice(1) : undefined;
}

// Companies House PSC (a statutory >25% control register) is NOT the UK
// equity/voting-rights signal. That signal is DTR5/TR-1 "major holdings",
// filed to the FCA National Storage Mechanism (NSM). The NSM has no public read
// API, so this section is inject-only: with no supplied fetchFn it renders an
// honest access note; with one it fetches and parses TR-1 artefacts. It is a
// supplementary section — any failure here degrades to a note and never nukes
// the primary PSC result above it.
async function buildGbMajorHoldingsSection(
  company: string,
  options: AdapterOptions,
): Promise<string> {
  const heading = "## UK major holdings (DTR5/TR-1)";
  if (!hasFcaNsmAccess(options)) {
    return joinSections(heading, `_${FCA_NSM_INJECT_NOTE}_`);
  }
  try {
    const holdings = await getFcaNsmMajorHoldings(company, options);
    if (!holdings.length) {
      return joinSections(
        heading,
        `No FCA NSM TR-1 major-holding notifications found for "${company}".`,
        `_${FCA_NSM_TR1_CAVEAT}_`,
      );
    }
    return joinSections(
      `${heading}: ${company}`,
      markdownTable(
        [
          "Holder",
          "Resulting %",
          "Change %",
          "Ultimate controller",
          "Notified",
          "Link",
        ],
        holdings.map((holding) => [
          holding.holderName,
          holding.pct !== undefined ? `${holding.pct}%` : undefined,
          holding.change !== undefined ? `${holding.change}%` : undefined,
          holding.naturesOfControl
            ?.join("; ")
            .replace(/^Ultimate controller:\s*/, ""),
          holding.notifiedDate ?? holding.filedDate,
          link("view", holding.sourceUrl),
        ]),
      ),
      `_${FCA_NSM_TR1_CAVEAT}_`,
    );
  } catch {
    return joinSections(
      heading,
      "_TR-1 major-holdings lookup was unavailable for this request; the " +
        "Companies House PSC data above is unaffected._",
    );
  }
}

function identifierText(entity: Entity): string {
  return [
    entity.cik ? `CIK ${entity.cik}` : undefined,
    entity.ticker ? `ticker ${entity.ticker}` : undefined,
    entity.lei ? `LEI ${entity.lei}` : undefined,
    entity.companyNumber ? `CH ${entity.companyNumber}` : undefined,
    entity.corpCode ? `DART ${entity.corpCode}` : undefined,
    entity.stockCode ? `stock ${entity.stockCode}` : undefined,
    entity.edinetCode ? `EDINET ${entity.edinetCode}` : undefined,
    entity.secCode ? `security ${entity.secCode}` : undefined,
    entity.jcn ? `JCN ${entity.jcn}` : undefined,
    entity.orgId ? `cninfo ${entity.orgId}` : undefined,
    entity.scripCode ? `BSE ${entity.scripCode}` : undefined,
    entity.isin ? `ISIN ${entity.isin}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("; ") || "—";
}

function entityRows(entities: Entity[]): string {
  return markdownTable(
    ["Legal name", "Identifiers", "Jurisdiction", "Status", "Source", "Match"],
    entities.map((entity) => [
      entity.sourceUrl ? link(entity.legalName, entity.sourceUrl) : entity.legalName,
      identifierText(entity),
      entity.jurisdiction,
      entity.status,
      entity.source,
      entity.matchReason,
    ]),
  );
}

const OPEN_DART_INSIDER_CAVEAT =
  "Parsed from Korean executive/major-shareholder ownership reports " +
  "(특정증권등 소유상황보고). Reflects the most recent reports filed via DART; " +
  "individuals who have not filed recently will not appear.";

const OPEN_DART_OWNER_CAVEAT =
  "Korean 5% mass-holding reports (대량보유상황보고) filed via DART. " +
  "Filing-based disclosure only — not a share register, and not UBO tracing.";

const EDINET_DATE_INDEX_CAVEAT =
  "EDINET's API is date-indexed (one calendar day per request) with no " +
  "server-side company filter, so this scans a bounded recent window " +
  "(default ~90 days, capped at ~1 year). Narrow with start_date/end_date, " +
  "and note a filing older than the window will not appear.";

const EDINET_NO_DEEP_LINK_CAVEAT =
  "EDINET provides no stable public per-document link; open the docID shown " +
  "above in the EDINET viewer, or fetch it via the authenticated API v2 " +
  "documents endpoint. This tool never returns document text.";

const CNINFO_FILINGS_CAVEAT =
  "cninfo announcements are Chinese-language PDFs on SSE/SZSE (and mirrored " +
  "HKEX filings). Links open the official full-text PDF; this tool never " +
  "returns document text. Absence here is not proof a filing does not exist.";

const CNINFO_OWNERSHIP_UNSUPPORTED =
  "Chinese shareholding data (5%+ holders, controlling shareholders, " +
  "executives) is disclosed inside periodic-report and interim-announcement " +
  "PDFs on cninfo, not as a structured feed, so this release does not surface " +
  "it as normalized records. Use CompanyFilings with jurisdiction \"CN\" to " +
  "locate the relevant annual report (年度报告) or equity-change announcement " +
  "(权益变动) PDF.";

const BSE_SHAREHOLDING_UNSUPPORTED =
  "BSE shareholding-pattern data (promoters and 1%+ public shareholders) is " +
  "served from anti-bot-gated endpoints that redirect plain requests to a WAF " +
  "error page. This zero-dependency release does not bundle a browser, so it " +
  "does not return that data by default. Supply a browser-backed fetchFn via " +
  "AdapterOptions to enable it, or read the quarterly shareholding pattern on " +
  "bseindia.com.";

function describeParent(parent: OwnershipParent | undefined): string {
  if (!parent) return "No parent information reported";
  if (parent.entity) {
    const label = parent.entity.lei
      ? `${parent.entity.legalName} (LEI ${parent.entity.lei})`
      : parent.entity.legalName;
    return parent.entity.sourceUrl ? link(label, parent.entity.sourceUrl) : label;
  }
  if (parent.exceptionReason) {
    return `No parent reported (exception: ${parent.exceptionReason})`;
  }
  return "No parent reported";
}

export function createTools(options: AdapterOptions = {}): ToolDefinition[] {
  const companyResolve = defineTool(
    "CompanyResolve",
    "Resolve a company name or identifier to canonical candidates. US/default " +
      "combines SEC ticker/CIK/title resolution with GLEIF legal-name search; " +
      "explicit GB uses Companies House company numbers and legal-name search. " +
      "Returns compact identifier sets and match reasons without silently " +
      "merging ambiguous entities. Explicit KR uses OpenDART corp/stock codes " +
      "and legal-name search; explicit JP uses the EDINET code list (EDINET " +
      "code, securities code, 法人番号, and legal name).",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "JP") {
        try {
          const results = await searchEdinetCompanies(company, options);
          if (!results.length) {
            return notFoundResult(company, "Try an EDINET code (E + 5 digits), a 4/5-digit securities code, a 13-digit corporate number, or legal name.");
          }
          return textResult(joinSections(
            `# Company resolution (EDINET): ${company}`,
            entityRows(results.slice(0, 10)),
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }
      if (jurisdiction === "GB") {
        try {
          const results = await searchCompaniesHouseCompanies(company, options);
          if (!results.length) return notFoundResult(company, "Try an exact Companies House company number or legal name.");
          return textResult(joinSections(
            `# Company resolution (Companies House): ${company}`,
            entityRows(results.slice(0, 10)),
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }
      if (jurisdiction === "KR") {
        try {
          const results = await searchOpenDartCompanies(company, options);
          if (!results.length) {
            return notFoundResult(company, "Try an OpenDART 8-digit corp code, 6-digit stock code, or legal name.");
          }
          return textResult(joinSections(
            `# Company resolution (OpenDART): ${company}`,
            entityRows(results.slice(0, 10)),
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }
      if (jurisdiction === "CN") {
        try {
          const results = await searchCninfoCompanies(company, options);
          if (!results.length) {
            return notFoundResult(company, "Try a 6-digit A-share code, a 5-digit HK code, or a Chinese company name.");
          }
          return textResult(joinSections(
            `# Company resolution (cninfo): ${company}`,
            entityRows(results.slice(0, 10)),
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }
      if (jurisdiction === "IN") {
        try {
          const results = await searchBseCompanies(company, options);
          if (!results.length) {
            return notFoundResult(company, `Try a 6-digit BSE scrip code or a company name. ${BSE_ANTIBOT_NOTE}`);
          }
          return textResult(joinSections(
            `# Company resolution (BSE India): ${company}`,
            entityRows(results.slice(0, 10)),
            `_${BSE_ANTIBOT_NOTE}_`,
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }

      const results: Entity[] = [];
      const warnings: string[] = [];

      if (isLei(company)) {
        const gleifEntity = await resolveGleifEntity(company, options);
        if (gleifEntity) results.push(gleifEntity);
      } else {
        if (hasSecConfiguration(options)) {
          try {
            results.push(...(await searchSecCompanies(company, options)));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no sec company found/i.test(message)) {
              warnings.push(`SEC lookup unavailable: ${message}`);
            }
          }
        } else {
          warnings.push(
            "SEC lookup skipped: set DISCLOSURES_USER_AGENT (or SEC_EDGAR_USER_AGENT) " +
              "to include SEC EDGAR identifiers.",
          );
        }
        try {
          results.push(...(await searchGleifEntities(company, options)).slice(0, 5));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`GLEIF lookup unavailable: ${message}`);
        }
      }

      if (!results.length) return notFoundResult(company);
      return textResult(joinSections(
        `# Company resolution: ${company}`,
        entityRows(results),
        warnings.length ? warnings.map((warning) => `_${warning}_`).join("\n") : undefined,
      ));
    },
  );

  const companyFilings = defineTool(
    "CompanyFilings",
    "Search regulatory filings from US SEC EDGAR (default/US), UK Companies " +
      "House (explicit GB), or Korean DART (explicit KR). Filters match SEC form " +
      "types, Companies House filing type/category/description, or DART report " +
      "names. Latest annual mode returns the latest SEC annual report, UK " +
      "accounts filing, or DART 사업보고서; latest quarterly returns the latest " +
      "SEC 10-Q or DART 분기·반기보고서, and is unsupported for GB because " +
      "Companies House has no equivalent normalized quarterly report mode. " +
      "Explicit JP scans EDINET's date-indexed document index (docTypeCode " +
      "120=annual, 140/160=quarterly/semi-annual). Returns public filing/" +
      "document links, never document text.",
    {
      ...companyInput,
      forms: z
        .array(z.string().min(1))
        .optional()
        .describe('Form-type filter, e.g. ["10-K"] or ["8-K", "DEF 14A"]'),
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Earliest filing date (YYYY-MM-DD); default is six years ago"),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Latest filing date (YYYY-MM-DD); default is today"),
      limit: z.number().int().min(1).max(100).optional()
        .describe("Maximum filings to return (default 20)"),
      mode: z
        .enum(["search", "latest_annual", "latest_quarterly"])
        .optional()
        .describe("\"search\" (default) or latest annual/quarterly report metadata"),
    },
    async ({ company, jurisdiction, forms, start_date, end_date, limit, mode }) => {
      try {
        if (jurisdiction === "JP") {
          if (mode === "latest_annual" || mode === "latest_quarterly") {
            const report = await getLatestEdinetReport(
              company,
              mode === "latest_annual" ? "annual" : "quarterly",
              options,
            );
            if (!report) {
              return textResult(joinSections(
                `No ${mode === "latest_annual" ? "annual (有価証券報告書)" : "quarterly/semi-annual (四半期・半期報告書)"} ` +
                  `report found on EDINET for "${company}" within the scan window.`,
                `_${EDINET_DATE_INDEX_CAVEAT}_`,
              ));
            }
            return textResult(joinSections(
              `# Latest ${report.reportKind} report (EDINET): ${company}`,
              markdownTable(
                ["Report", "Filed", "docID", "Filer", "Description"],
                [[report.form, report.filedDate, report.accession, report.category, report.description]],
              ),
              markdownTable(
                ["Section", "Description", "Link"],
                report.sectionLinks.map((section) => [
                  section.section,
                  section.description,
                  link("open", section.url),
                ]),
              ),
              `_${EDINET_NO_DEEP_LINK_CAVEAT}_`,
            ));
          }
          const filings = await searchEdinetFilings({
            company,
            ...(forms ? { forms } : {}),
            ...(start_date ? { startDate: start_date } : {}),
            ...(end_date ? { endDate: end_date } : {}),
            limit: limit ?? 20,
          }, options);
          if (!filings.length) {
            return textResult(joinSections(
              `No EDINET filings found for "${company}" in the scanned window.`,
              `_${EDINET_DATE_INDEX_CAVEAT}_`,
            ));
          }
          return textResult(joinSections(
            `# EDINET filings: ${company}`,
            markdownTable(
              ["Filed", "Type", "docID", "Filer", "Description"],
              filings.map((filing) => [
                filing.filedDate,
                filing.form,
                filing.accession,
                filing.category,
                filing.description,
              ]),
            ),
            `_${EDINET_DATE_INDEX_CAVEAT}_`,
            `_${EDINET_NO_DEEP_LINK_CAVEAT}_`,
          ));
        }
        if (jurisdiction === "CN") {
          if (mode === "latest_annual" || mode === "latest_quarterly") {
            const report = await getLatestCninfoReport(
              company,
              mode === "latest_annual" ? "annual" : "quarterly",
              options,
            );
            if (!report) {
              return textResult(joinSections(
                `No ${mode === "latest_annual" ? "annual (年度报告)" : "interim (半年度/季度报告)"} ` +
                  `report found on cninfo for "${company}".`,
                `_${CNINFO_FILINGS_CAVEAT}_`,
              ));
            }
            return textResult(joinSections(
              `# Latest ${report.reportKind} report (cninfo): ${company}`,
              markdownTable(
                ["Report", "Filed", "Announcement", "Company", "PDF"],
                [[report.form, report.filedDate, report.description, report.category, link("open", report.sourceUrl)]],
              ),
              `_${CNINFO_FILINGS_CAVEAT}_`,
            ));
          }
          const filings = await searchCninfoFilings({
            company,
            ...(forms ? { forms } : {}),
            ...(start_date ? { startDate: start_date } : {}),
            ...(end_date ? { endDate: end_date } : {}),
            limit: limit ?? 20,
          }, options);
          if (!filings.length) {
            return textResult(joinSections(
              `No cninfo announcements found for "${company}" in the scanned window.`,
              `_${CNINFO_FILINGS_CAVEAT}_`,
            ));
          }
          return textResult(joinSections(
            `# cninfo announcements: ${company}`,
            markdownTable(
              ["Filed", "Type", "Company", "Title", "PDF"],
              filings.map((filing) => [
                filing.filedDate,
                filing.form,
                filing.category,
                filing.description,
                link("open", filing.sourceUrl),
              ]),
            ),
            `_${CNINFO_FILINGS_CAVEAT}_`,
          ));
        }
        if (jurisdiction === "IN") {
          if (mode === "latest_annual" || mode === "latest_quarterly") {
            return textResult(
              `Latest ${mode === "latest_annual" ? "annual" : "quarterly"} mode is unsupported for IN. ` +
                "BSE exposes a corporate-announcements feed, but not a normalized annual/quarterly " +
                'report-metadata equivalent. Use mode "search" (optionally with a forms filter like ' +
                '["Result"] or ["Annual Report"]) instead.',
            );
          }
          const filings = await searchBseFilings({
            company,
            ...(forms ? { forms } : {}),
            ...(start_date ? { startDate: start_date } : {}),
            ...(end_date ? { endDate: end_date } : {}),
            limit: limit ?? 20,
          }, options);
          if (!filings.length) {
            return textResult(joinSections(
              `No BSE announcements found for "${company}" in the scanned window.`,
              `_${BSE_ANTIBOT_NOTE}_`,
            ));
          }
          return textResult(joinSections(
            `# BSE announcements: ${company}`,
            markdownTable(
              ["Filed", "Category", "Sub-category", "Headline", "Attachment"],
              filings.map((filing) => [
                filing.filedDate,
                filing.form,
                filing.category,
                filing.description,
                link("open", filing.sourceUrl),
              ]),
            ),
            "_Attachment links open the public BSE corporate-filing PDF; this tool never returns document text._",
            `_${BSE_ANTIBOT_NOTE}_`,
          ));
        }
        if (jurisdiction === "KR") {
          if (mode === "latest_annual" || mode === "latest_quarterly") {
            const report = await getLatestOpenDartReport(
              company,
              mode === "latest_annual" ? "annual" : "quarterly",
              options,
            );
            if (!report) {
              return textResult(
                `No ${mode === "latest_annual" ? "annual (사업보고서)" : "quarterly/half (분기·반기보고서)"} ` +
                  `periodic report found on DART for "${company}".`,
              );
            }
            return textResult(joinSections(
              `# Latest ${report.reportKind} report (OpenDART): ${company}`,
              markdownTable(
                ["Report", "Filed", "Receipt no.", "Description"],
                [[report.form, report.filedDate, report.accession, report.description]],
              ),
              markdownTable(
                ["Section", "Description", "Link"],
                report.sectionLinks.map((section) => [
                  section.section,
                  section.description,
                  link("open", section.url),
                ]),
              ),
              "_Links open the DART disclosure viewer. This tool does not return document text._",
            ));
          }
          const filings = await searchOpenDartFilings({
            company,
            ...(forms ? { forms } : {}),
            ...(start_date ? { startDate: start_date } : {}),
            ...(end_date ? { endDate: end_date } : {}),
            limit: limit ?? 20,
          }, options);
          if (!filings.length) {
            return textResult(`No DART filings found for "${company}" with the given filters.`);
          }
          return textResult(joinSections(
            `# DART filings (OpenDART): ${company}`,
            markdownTable(
              ["Filed", "Report", "Filer", "Link"],
              filings.map((filing) => [
                filing.filedDate,
                filing.form,
                filing.category,
                link("view", filing.sourceUrl),
              ]),
            ),
            "_Links open the DART disclosure viewer. This tool does not return document text._",
          ));
        }

        if (jurisdiction === "GB") {
          if (mode === "latest_quarterly") {
            return textResult(
              `Latest quarterly mode is unsupported for GB. Companies House exposes ` +
                `filing history and accounts documents, but not a normalized quarterly-report equivalent.`,
            );
          }
          if (mode === "latest_annual") {
            const report = await getLatestCompaniesHouseReport(company, "annual", options);
            if (!report) {
              return textResult(`No Companies House accounts filing found for "${company}".`);
            }
            return textResult(joinSections(
              `# Latest accounts filing (Companies House): ${company}`,
              markdownTable(
                ["Type", "Category", "Filed", "Transaction", "Description"],
                [[
                  report.form,
                  report.category,
                  report.filedDate,
                  report.accession,
                  report.description,
                ]],
              ),
              markdownTable(
                ["Section", "Description", "Link"],
                report.sectionLinks.map((section) => [
                  section.section,
                  section.description,
                  link("open", section.url),
                ]),
              ),
              "_Links open the public Companies House filing or document. This tool does not return document text._",
            ));
          }
          const filings = await searchCompaniesHouseFilings({
            company,
            ...(forms ? { forms } : {}),
            ...(start_date ? { startDate: start_date } : {}),
            ...(end_date ? { endDate: end_date } : {}),
            limit: limit ?? 20,
          }, options);
          if (!filings.length) {
            return textResult(`No Companies House filings found for "${company}" with the given filters.`);
          }
          return textResult(joinSections(
            `# Companies House filings: ${company}`,
            markdownTable(
              ["Filed", "Type", "Category", "Description", "Link"],
              filings.map((filing) => [
                filing.filedDate,
                filing.form,
                filing.category,
                filing.description,
                link("view", filing.sourceUrl),
              ]),
            ),
            "_Links open the public Companies House filing or document. This tool does not return document text._",
          ));
        }

        if (mode === "latest_annual" || mode === "latest_quarterly") {
          const report = await getLatestSecReport(
            company,
            mode === "latest_annual" ? "annual" : "quarterly",
            options,
          );
          if (!report) {
            return textResult(
              `No ${mode === "latest_annual" ? "annual" : "quarterly"} report found for "${company}".`,
            );
          }
          return textResult(joinSections(
            `# Latest ${report.reportKind} report: ${company}`,
            markdownTable(
              ["Form", "Filed", "Accession", "Description"],
              [[report.form, report.filedDate, report.accession, report.description]],
            ),
            markdownTable(
              ["Section", "Description", "Link"],
              report.sectionLinks.map((section) => [
                section.section,
                section.description,
                link("open", section.url),
              ]),
            ),
            "_Links point to the filed documents on sec.gov; this tool does not return the document text._",
          ));
        }

        const filings = (await searchSecFilings({
          cik: company,
          ...(forms ? { forms } : {}),
          ...(start_date ? { startDate: start_date } : {}),
          ...(end_date ? { endDate: end_date } : {}),
          limit: limit ?? 20,
        }, options)).slice(0, limit ?? 20);
        if (!filings.length) {
          return textResult(`No filings found for "${company}" with the given filters.`);
        }
        return textResult(joinSections(
          `# SEC filings: ${company}`,
          markdownTable(
            ["Filed", "Form", "Description", "Link"],
            filings.map((filing) => [
              filing.filedDate,
              filing.form,
              filing.description,
              link("view", filing.sourceUrl),
            ]),
          ),
          "_Links point to the filed documents on sec.gov; this tool does not return the document text._",
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  const companyInsiders = defineTool(
    "CompanyInsiders",
    "Return recent US SEC Section 16 filing insiders (default/US), the UK " +
      "Companies House officer register (explicit GB), or Korean executive/" +
      "major-shareholder ownership reports from DART (explicit KR). GB output " +
      "includes role, occupation, appointment/resignation dates, and active/" +
      "former status, but does not surface correspondence addresses, " +
      "nationality, or partial birth dates. Explicit JP is unsupported: EDINET " +
      "has no Section 16-style insider-dealing feed; officer data lives inside " +
      "the annual securities report (有価証券報告書).",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "JP") {
        return textResult(
          "CompanyInsiders is unsupported for jurisdiction \"JP\". EDINET does not " +
            "expose a Section 16-equivalent per-insider dealing dataset; director and " +
            "officer details are disclosed inside the annual securities report " +
            "(有価証券報告書), which this release does not parse. Use CompanyFilings " +
            'with jurisdiction "JP" and mode "latest_annual" to locate that report.',
        );
      }
      if (jurisdiction === "CN") {
        return textResult(
          "CompanyInsiders is unsupported for jurisdiction \"CN\". " +
            CNINFO_OWNERSHIP_UNSUPPORTED,
        );
      }
      if (jurisdiction === "IN") {
        return textResult(
          "CompanyInsiders is unsupported for jurisdiction \"IN\". " +
            BSE_SHAREHOLDING_UNSUPPORTED,
        );
      }
      try {
        if (jurisdiction === "KR") {
          const insiders = await getOpenDartInsiders(company, options);
          if (!insiders.length) {
            return textResult(
              `No Korean executive/major-shareholder ownership reports found on DART for "${company}".`,
            );
          }
          return textResult(joinSections(
            `# Insiders (OpenDART): ${company}`,
            markdownTable(
              ["Name", "Role(s)", "Registered", "Filed", "Link"],
              insiders.map((insider) => [
                insider.name,
                insider.roles.join(", ") || "—",
                insider.status,
                insider.filedDate,
                link("view", insider.sourceUrl),
              ]),
            ),
            `_${OPEN_DART_INSIDER_CAVEAT}_`,
          ));
        }
        if (jurisdiction === "GB") {
          const officers = await getCompaniesHouseOfficers(company, options);
          if (!officers.length) {
            return textResult(`No Companies House officers found for "${company}".`);
          }
          return textResult(joinSections(
            `# Officers (Companies House): ${company}`,
            markdownTable(
              ["Name", "Role", "Occupation", "Appointed", "Resigned", "Status", "Link"],
              officers.map((officer) => [
                officer.name,
                readableCode(officer.officerRole),
                officer.occupation,
                officer.appointedDate,
                officer.ceasedDate,
                officer.status,
                link("view", officer.sourceUrl),
              ]),
            ),
            "_Public officer-register fields only. Correspondence addresses, nationality, " +
              "and partial dates of birth are intentionally omitted from this output._",
          ));
        }

        const insiders = await getSecInsiders(company, options);
        if (!insiders.length) {
          return textResult(
            `No recent Section 16 insider filings (Forms 3/4/5) found for "${company}".`,
          );
        }
        return textResult(joinSections(
          `# Insiders: ${company}`,
          markdownTable(
            ["Name", "Role(s)", "Latest filing", "Filed", "Link"],
            insiders.map((insider) => [
              insider.name,
              insider.roles.join(", ") || "—",
              insider.form,
              insider.filedDate,
              link("view", insider.sourceUrl),
            ]),
          ),
          "_Parsed from recent Forms 3/4/5. Roles reflect what each insider reported; " +
            "insiders who have not filed recently will not appear._",
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  const companyOwners = defineTool(
    "CompanyOwners",
    "Return US Schedule 13D/13G beneficial-ownership filers (default/US), " +
      "UK Companies House persons with significant control (explicit GB), or " +
      "Korean 5% mass-holding reports from DART (explicit KR). GB rows include " +
      "individual/corporate/legal/super-secure kinds, statutory natures of " +
      "control, percentage bands where derivable, ceased entries, and PSC " +
      "statements when no ordinary PSC record exists. The GB view also adds a " +
      "UK equity/voting-rights (DTR5/TR-1 major-holdings) section from the FCA " +
      "National Storage Mechanism; the NSM has no public read API, so that " +
      "section is populated only when NSM access is supplied via an injected " +
      "fetchFn, and otherwise explains how to enable it. Each row states its " +
      "threshold/control regime. No source is guaranteed-complete UBO/KYC " +
      "evidence. Explicit JP is unsupported: EDINET large-holding reports are " +
      "indexed by the filer (the holder), not the subject issuer.",
    {
      ...companyInput,
    },
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "JP") {
        return textResult(joinSections(
          "CompanyOwners is unsupported for jurisdiction \"JP\". Japan's large-holding " +
            "reports (大量保有報告書) are filed under the " +
            `${EDINET_5_PERCENT_THRESHOLD_REGIME}, but EDINET's date-indexed metadata ` +
            "identifies the filer (the large holder), not the subject company, so a " +
            "reliable \"who owns >5% of company X\" query would require document-level " +
            "parsing this release does not perform.",
          "_Absence of a result here is not evidence that no large holder exists._",
        ));
      }
      if (jurisdiction === "CN") {
        return textResult(joinSections(
          "CompanyOwners is unsupported for jurisdiction \"CN\". " +
            CNINFO_OWNERSHIP_UNSUPPORTED,
          "_Absence of a result here is not evidence that no large holder exists._",
        ));
      }
      if (jurisdiction === "IN") {
        return textResult(joinSections(
          "CompanyOwners is unsupported for jurisdiction \"IN\". " +
            BSE_SHAREHOLDING_UNSUPPORTED,
          "_Absence of a result here is not evidence that no large holder exists._",
        ));
      }
      try {
        if (jurisdiction === "KR") {
          const owners = await getOpenDartOwners(company, options);
          if (!owners.length) {
            return textResult(joinSections(
              `No Korean 5% mass-holding reports found on DART for "${company}".`,
              `_Threshold regime: ${OPEN_DART_5_PERCENT_THRESHOLD_REGIME}._`,
            ));
          }
          return textResult(joinSections(
            `# 5% mass-holding filers (OpenDART): ${company}`,
            markdownTable(
              ["Holder", "Report type", "Stake %", "Change %", "Reason", "Filed", "Link"],
              owners.map((owner) => [
                owner.holderName,
                owner.holderType,
                owner.pct !== undefined ? `${owner.pct}%` : undefined,
                owner.change !== undefined ? `${owner.change}%` : undefined,
                owner.naturesOfControl?.join(", "),
                owner.filedDate,
                link("view", owner.sourceUrl),
              ]),
            ),
            `_Threshold regime: ${OPEN_DART_5_PERCENT_THRESHOLD_REGIME}._`,
            `_${OPEN_DART_OWNER_CAVEAT}_`,
          ));
        }
        if (jurisdiction === "GB") {
          // PSC (statutory >25% control) is the primary section; its config /
          // rate-limit errors must still surface as isError via the outer catch.
          const owners = await getCompaniesHouseOwners(company, options);
          const pscSection = owners.length
            ? joinSections(
              `# Persons with significant control (Companies House): ${company}`,
              markdownTable(
                [
                  "PSC / statement",
                  "Kind",
                  "Control / statement",
                  "Percentage band",
                  "Notified",
                  "Ceased",
                  "Threshold regime",
                  "Link",
                ],
                owners.map((owner) => [
                  owner.holderName,
                  owner.holderType,
                  owner.naturesOfControl?.map(readableCode).join(", ") || readableCode(owner.form),
                  owner.percentageBand,
                  owner.notifiedDate,
                  owner.ceasedDate,
                  owner.thresholdRegime,
                  link("view", owner.sourceUrl),
                ]),
              ),
              `_${COMPANIES_HOUSE_PSC_CAVEAT}_`,
            )
            : joinSections(
              `No Companies House PSC records or PSC statements found for "${company}".`,
              `_${COMPANIES_HOUSE_PSC_CAVEAT}_`,
            );
          const majorHoldings = await buildGbMajorHoldingsSection(company, options);
          return textResult(joinSections(pscSection, majorHoldings));
        }

        const owners = await getSecOwners(company, options);
        if (!owners.length) {
          return textResult(
            `No Schedule 13D/13G filings found naming "${company}" as subject in the search window.`,
          );
        }
        return textResult(joinSections(
          `# Beneficial-ownership filers: ${company}`,
          markdownTable(
            ["Holder", "Type", "Form", "Filed", "Threshold regime", "Link"],
            owners.map((owner) => [
              owner.holderName,
              owner.holderType,
              owner.form,
              owner.filedDate,
              owner.thresholdRegime,
              link("view", owner.sourceUrl),
            ]),
          ),
          "_Newest filing per holder. Exact percentages require opening the linked filing. " +
            "Filing-based disclosure only — not a share register, not UBO tracing._",
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  const companyFinancials = defineTool(
    "CompanyFinancials",
    "Annual as-filed financial figures from XBRL-tagged US SEC annual " +
      `reports (10-K/20-F/40-F): ${SEC_FINANCIAL_CONCEPT_NAMES.join(", ")}. ` +
      "Explicit KR returns Korean DART major-account figures (" +
      `${Object.keys(OPEN_DART_ACCOUNT_CONCEPTS).join(", ")}), showing ` +
      "consolidated and separate bases where both are filed. Explicit GB " +
      "returns an explanation directing callers to Companies House accounts " +
      "filings because this release does not parse normalized UK financial " +
      "facts. Explicit JP likewise directs callers to the EDINET annual " +
      "securities report because this release does not parse its XBRL.",
    {
      ...companyInput,
      concepts: z
        .array(z.enum(SEC_FINANCIAL_CONCEPT_NAMES as [string, ...string[]]))
        .optional()
        .describe("Concepts to fetch (default: all)"),
      periods: z.number().int().min(1).max(10).optional()
        .describe("Fiscal years per concept (default 5)"),
    },
    async ({ company, jurisdiction, concepts, periods }) => {
      if (jurisdiction === "JP") {
        return textResult(
          "EDINET publishes annual securities reports (有価証券報告書) with XBRL " +
            "financial data, but this release does not parse them into normalized " +
            'financial facts. Use CompanyFilings with jurisdiction "JP" and mode ' +
            '"latest_annual" to locate the report and its docID.',
        );
      }
      if (jurisdiction === "CN") {
        return textResult(
          "CompanyFinancials is unsupported for jurisdiction \"CN\". cninfo publishes " +
            "annual and interim reports (年度报告/季度报告) with XBRL data, but this " +
            "release does not parse them into normalized financial facts. Use " +
            'CompanyFilings with jurisdiction "CN" and mode "latest_annual" to locate ' +
            "the report PDF.",
        );
      }
      if (jurisdiction === "IN") {
        return textResult(
          "CompanyFinancials is unsupported for jurisdiction \"IN\". BSE financial " +
            "results are disclosed inside corporate-announcement PDFs and behind " +
            "anti-bot-gated endpoints; this release does not parse them into " +
            'normalized financial facts. Use CompanyFilings with jurisdiction "IN" ' +
            'and a forms filter like ["Result"] to locate the results announcement.',
        );
      }
      if (jurisdiction === "KR") {
        try {
          const supported = Object.keys(OPEN_DART_ACCOUNT_CONCEPTS);
          const requested = concepts?.filter((concept) => supported.includes(concept));
          const facts = await getOpenDartFinancials(company, {
            ...(requested && requested.length ? { concepts: requested } : {}),
            periods: periods ?? 5,
          }, options);
          if (!facts.length) {
            return textResult(
              `No annual major-account financials found on DART for "${company}". ` +
                `OpenDART major accounts cover: ${supported.join(", ")}.`,
            );
          }
          const byConcept = new Map<string, typeof facts>();
          for (const fact of facts) {
            const bucket = byConcept.get(fact.concept) ?? [];
            bucket.push(fact);
            byConcept.set(fact.concept, bucket);
          }
          const sections = [...byConcept.entries()].map(([concept, rows]) => {
            const label = rows[0]?.label ?? concept;
            const unit = rows[0]?.unit ?? "KRW";
            return joinSections(
              `## ${label} (${unit})`,
              markdownTable(
                ["Fiscal period end", "Basis", "Value", "Filed"],
                rows.map((fact) => [
                  fact.periodEnd,
                  fact.basis ?? "—",
                  formatNumber(fact.value, fact.unit),
                  fact.filedDate,
                ]),
              ),
            );
          });
          return textResult(joinSections(
            `# Annual financials (OpenDART): ${company}`,
            ...sections,
            "_As-filed annual major-account values from DART 사업보고서 filings. " +
              "\"Basis\" distinguishes consolidated (CFS) from separate (OFS) statements; " +
              "both are shown where the company files both._",
          ));
        } catch (error) {
          return failureResult(company, error);
        }
      }
      if (jurisdiction === "GB") {
        return textResult(
          "Companies House exposes UK accounts filings and linked documents, but this " +
            "release does not parse them into normalized financial facts. Use " +
            'CompanyFilings with jurisdiction "GB" and an accounts filter to retrieve ' +
            "the latest accounts metadata and public document links.",
        );
      }
      try {
        const facts = await getSecFinancials(company, concepts ?? SEC_FINANCIAL_CONCEPT_NAMES, options);
        if (!facts.length) {
          return textResult(`No annual XBRL financial data found for "${company}".`);
        }
        const maxPeriods = periods ?? 5;
        const byConcept = new Map<string, typeof facts>();
        for (const fact of facts) {
          const bucket = byConcept.get(fact.concept) ?? [];
          if (bucket.length < maxPeriods) bucket.push(fact);
          byConcept.set(fact.concept, bucket);
        }
        const sections = [...byConcept.entries()].map(([concept, rows]) => {
          const label = rows[0]?.label ?? concept;
          const unit = rows[0]?.unit ?? "";
          return joinSections(
            `## ${label} (${unit})`,
            markdownTable(
              ["Fiscal period end", "Value", "Form", "Filed"],
              rows.map((fact) => [
                fact.periodEnd,
                formatNumber(fact.value, fact.unit),
                fact.form,
                fact.filedDate,
              ]),
            ),
          );
        });
        return textResult(joinSections(
          `# Annual financials: ${company}`,
          ...sections,
          "_As-filed annual XBRL values from SEC EDGAR, labeled by fiscal period end; " +
            "restatements supersede original filings._",
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  const ownershipChain = defineTool(
    "OwnershipChain",
    "GLEIF Level 2 relationship data for an entity (global): direct and " +
      "ultimate accounting-consolidating parents and known direct children, " +
      "resolved from an LEI or legal name. Reporting exceptions (e.g. " +
      "natural-person owners, non-consolidating structures) are stated " +
      "explicitly. Consolidation parents are not market-disclosure ownership " +
      "and not UBO tracing.",
    {
      company: companyInput.company,
    },
    async ({ company }) => {
      try {
        const chain = await getOwnershipChain(company, options);
        const childRows = chain.children.length
          ? markdownTable(
              ["Child entity", "LEI", "Jurisdiction", "Status"],
              chain.children.map((child) => [
                child.sourceUrl ? link(child.legalName, child.sourceUrl) : child.legalName,
                child.lei,
                child.jurisdiction,
                child.status,
              ]),
            )
          : "_No direct children reported in GLEIF._";
        return textResult(joinSections(
          `# Ownership chain (GLEIF): ${chain.entity.legalName}`,
          markdownTable(
            ["Field", "Value"],
            [
              ["LEI", chain.entity.lei],
              ["Jurisdiction", chain.entity.jurisdiction],
              ["Status", chain.entity.status],
              ["Direct parent", describeParent(chain.directParent)],
              ["Ultimate parent", describeParent(chain.ultimateParent)],
              ...(chain.goldenCopyPublishedAt
                ? [["GLEIF golden copy", chain.goldenCopyPublishedAt] as [string, string]]
                : []),
            ],
          ),
          `## Known direct children (${chain.children.length})`,
          childRows,
          `_${CONSOLIDATION_CAVEAT}_`,
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  const privateRaises = defineTool(
    "PrivateRaises",
    "US Form D (Regulation D) exempt-offering filings for a company: " +
      "amounts offered and sold, investor counts, industry, date of first sale, " +
      "and named related persons. This capability is US-only; explicit GB, KR, " +
      "JP, CN, and IN return an unsupported-jurisdiction explanation because " +
      "none of Companies House, DART, EDINET, cninfo, or BSE provides an " +
      "equivalent private-raise filing dataset.",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (
        jurisdiction === "GB" || jurisdiction === "KR" || jurisdiction === "JP" ||
        jurisdiction === "CN" || jurisdiction === "IN"
      ) {
        const registry = jurisdiction === "GB"
          ? "Companies House"
          : jurisdiction === "KR"
            ? "OpenDART/DART"
            : jurisdiction === "JP"
              ? "EDINET"
              : jurisdiction === "CN"
                ? "cninfo (SSE/SZSE)"
                : "BSE India";
        return textResult(
          `PrivateRaises is unsupported for jurisdiction \"${jurisdiction}\". ${registry} ` +
            "does not expose a Form D-equivalent public dataset for normalized " +
            "private offering amounts and investor counts in this release.",
        );
      }
      try {
        const raises = await getSecPrivateRaises(company, options);
        if (!raises.length) {
          return textResult(
            `No Form D filings found for "${company}". The company may not have raised ` +
              "under Regulation D, may file under a different entity name, or may have " +
              "raised without a Form D — absence here is not proof of no private raise.",
          );
        }
        const sections = raises.map((raise) => joinSections(
          `## ${raise.form} — filed ${raise.filedDate}`,
          markdownTable(
            ["Field", "Value"],
            [
              ["Issuer", raise.issuerName],
              ["Entity type", raise.entityType],
              ["Industry", raise.industry],
              ["Total offering", raise.totalOfferingAmount],
              ["Amount sold", raise.totalAmountSold],
              ["Investors so far", raise.investorCount],
              ["Date of first sale", raise.dateOfFirstSale],
              ["Filing", link("view", raise.sourceUrl)],
            ],
          ),
          raise.relatedPersons.length
            ? markdownTable(
                ["Related person", "Role(s)"],
                raise.relatedPersons.map((person) => [
                  person.name,
                  person.relationships.join(", ") || "—",
                ]),
              )
            : "_No related persons parsed from this filing._",
        ));
        return textResult(joinSections(
          `# Form D private raises: ${company}`,
          ...sections,
          "_US Regulation D filings only (v1). Absence of Form D does not mean no private raise._",
        ));
      } catch (error) {
        return failureResult(company, error);
      }
    },
  );

  return [
    companyResolve,
    companyFilings,
    companyInsiders,
    companyOwners,
    companyFinancials,
    ownershipChain,
    privateRaises,
  ] as ToolDefinition[];
}

export const TOOL_NAMES = [
  "CompanyResolve",
  "CompanyFilings",
  "CompanyInsiders",
  "CompanyOwners",
  "CompanyFinancials",
  "OwnershipChain",
  "PrivateRaises",
] as const;
