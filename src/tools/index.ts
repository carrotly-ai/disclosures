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

function plannedJurisdiction(
  jurisdiction: "KR" | "JP",
  toolName: string,
): ReturnType<typeof textResult> {
  const adapter = jurisdiction === "KR" ? "OpenDART" : "EDINET";
  return textResult(
    `${toolName} does not yet support jurisdiction \"${jurisdiction}\". ` +
      `The ${adapter} adapter is planned for a later release.`,
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
    "Resolve a company name or identifier to canonical candidates. US/default " +
      "combines SEC ticker/CIK/title resolution with GLEIF legal-name search; " +
      "explicit GB uses Companies House company numbers and legal-name search. " +
      "Returns compact identifier sets and match reasons without silently " +
      "merging ambiguous entities. KR/OpenDART and JP/EDINET are planned.",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "CompanyResolve");
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
    "Search regulatory filings from US SEC EDGAR (default/US) or UK Companies " +
      "House (explicit GB). Filters match SEC form types or Companies House " +
      "filing type/category/description. Latest annual mode returns the latest " +
      "SEC annual report or UK accounts filing; latest quarterly is unsupported " +
      "for GB because Companies House has no equivalent normalized quarterly " +
      "report mode. Returns public filing/document links, never document text. " +
      "KR/OpenDART and JP/EDINET are planned.",
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
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "CompanyFilings");
      }
      try {
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
    "Return recent US SEC Section 16 filing insiders (default/US) or the UK " +
      "Companies House officer register (explicit GB). GB output includes role, " +
      "occupation, appointment/resignation dates, and active/former status, but " +
      "does not surface correspondence addresses, nationality, or partial birth " +
      "dates. KR/OpenDART and JP/EDINET are planned.",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "CompanyInsiders");
      }
      try {
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
    "Return US Schedule 13D/13G beneficial-ownership filers (default/US) or " +
      "UK Companies House persons with significant control (explicit GB). GB " +
      "rows include individual/corporate/legal/super-secure kinds, statutory " +
      "natures of control, percentage bands where derivable, ceased entries, " +
      "and PSC statements when no ordinary PSC record exists. Each row states " +
      "its threshold/control regime. Neither source is guaranteed-complete UBO/KYC evidence. " +
      "KR/OpenDART and JP/EDINET are planned.",
    {
      ...companyInput,
    },
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "CompanyOwners");
      }
      try {
        if (jurisdiction === "GB") {
          const owners = await getCompaniesHouseOwners(company, options);
          if (!owners.length) {
            return textResult(joinSections(
              `No Companies House PSC records or PSC statements found for "${company}".`,
              `_${COMPANIES_HOUSE_PSC_CAVEAT}_`,
            ));
          }
          return textResult(joinSections(
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
          ));
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
      "Explicit GB returns an explanation directing callers to Companies House " +
      "accounts filings because this release does not parse normalized UK " +
      "financial facts. KR/OpenDART and JP/EDINET are planned.",
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
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "CompanyFinancials");
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
      "and named related persons. This capability is US-only; explicit GB " +
      "returns an unsupported-jurisdiction explanation because Companies House " +
      "does not provide an equivalent private-raise filing dataset. KR/OpenDART " +
      "and JP/EDINET are planned.",
    companyInput,
    async ({ company, jurisdiction }) => {
      if (jurisdiction === "KR" || jurisdiction === "JP") {
        return plannedJurisdiction(jurisdiction, "PrivateRaises");
      }
      if (jurisdiction === "GB") {
        return textResult(
          "PrivateRaises is unsupported for jurisdiction \"GB\". Companies House " +
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
