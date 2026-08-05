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
import { companyInput, failureResult, notFoundResult } from "./shared.js";

const CONSOLIDATION_CAVEAT =
  "Caveat: GLEIF Level 2 relationships are accounting-consolidation parents " +
  "reported for LEI compliance. They are not market-disclosure ownership " +
  "stakes, and they are not ultimate-beneficial-owner (UBO) tracing through " +
  "private holding chains.";

function entityRows(entities: Entity[]): string {
  return markdownTable(
    ["Legal name", "CIK", "Ticker", "LEI", "Jurisdiction", "Source", "Match"],
    entities.map((entity) => [
      entity.sourceUrl ? link(entity.legalName, entity.sourceUrl) : entity.legalName,
      entity.cik,
      entity.ticker,
      entity.lei,
      entity.jurisdiction,
      entity.source,
      entity.matchReason,
    ]),
  );
}

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
    "Resolve a company name, ticker, SEC CIK, or LEI to a canonical entity " +
      "with all known identifiers (CIK, LEI, jurisdiction). Combines the SEC " +
      "ticker/title map with GLEIF legal-name search. Returns a table of " +
      "candidate entities with match reasons; ambiguous matches are listed " +
      "rather than silently merged.",
    companyInput,
    async ({ company }) => {
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
    "Search a company's regulatory filings (US SEC EDGAR in v1) with an " +
      "optional form-type filter and date window, returning filing date, " +
      "form type, description, and direct links to the filed documents. " +
      "Use mode \"latest_annual\" or \"latest_quarterly\" for the most " +
      "recent annual/quarterly report's metadata (filing date, accession " +
      "number, links to the primary document and filing index). Returns " +
      "links to filings, not the filing text itself.",
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
    async ({ company, forms, start_date, end_date, limit, mode }) => {
      try {
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
    "Named directors and officers (with titles) and 10% owners parsed from " +
      "a company's recent US SEC Section 16 insider filings (Forms 3/4/5). " +
      "Reflects only insiders who filed recently — it is not a complete " +
      "officer/director roster.",
    companyInput,
    async ({ company }) => {
      try {
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
    "Investors that filed major-shareholding / beneficial-ownership reports " +
      "naming the company as subject (US Schedules 13D/13G, 5% threshold, in " +
      "v1), with form, filing date, and links. Each row states its source " +
      "threshold regime. This is filing-based disclosure — not a share " +
      "register and not ultimate-beneficial-owner (UBO) tracing.",
    {
      ...companyInput,
    },
    async ({ company }) => {
      try {
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
      "Values are labeled by fiscal period end date; restated values " +
      "supersede originals.",
    {
      ...companyInput,
      concepts: z
        .array(z.enum(SEC_FINANCIAL_CONCEPT_NAMES as [string, ...string[]]))
        .optional()
        .describe("Concepts to fetch (default: all)"),
      periods: z.number().int().min(1).max(10).optional()
        .describe("Fiscal years per concept (default 5)"),
    },
    async ({ company, concepts, periods }) => {
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
      "amounts offered and sold (which may be \"Indefinite\"), investor " +
      "counts, industry, date of first sale, and named executive officers, " +
      "directors, and promoters. US-only in v1. Absence of a Form D does " +
      "not mean a company never raised capital privately.",
    companyInput,
    async ({ company }) => {
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
