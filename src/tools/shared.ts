import { z } from "zod";
import {
  AdapterConfigurationError,
  AdapterRateLimitError,
} from "../core/errors.js";
import type { AdapterOptions, ToolResult } from "../core/types.js";
import { errorResult, textResult } from "../core/toolDefs.js";

export const companyInput = {
  company: z
    .string()
    .min(1)
    .describe(
      "Company name or jurisdiction-specific identifier: ticker/CIK (US), " +
        "Companies House company number (GB), OpenDART 8-digit corp code or " +
        "6-digit stock code (KR), EDINET code (E + 5 digits), 4/5-digit " +
        "securities code, or 13-digit corporate number (JP), 6-digit A-share " +
        "or 5-digit HK stock code (CN, via cninfo), 6-digit BSE scrip code " +
        "(IN), 4-digit TWSE listing code (TW), numeric CVM code (BR), " +
        "8-digit BaFin-Id or ISIN (DE), SIREN/ISIN/LEI (FR), 4/5-digit HKEX " +
        "stock code (HK), Singapore UEN (SG), 13-digit juristic-person " +
        "registration number (TH), AFM-register issuer name or LEI (NL), " +
        "4-letter IDX ticker / kode emiten (ID), BIST stock code (TR), or " +
        "20-character LEI",
    ),
  jurisdiction: z
    .enum([
      "US", "GB", "EU", "KR", "JP", "CN", "IN", "TW", "BR", "DE", "FR", "HK",
      "SG", "TH", "NL", "ID", "TR",
    ])
    .optional()
    .describe(
      "Jurisdiction to search: US (SEC EDGAR), GB (Companies House), " +
        "EU (pan-European ESEF filers via filings.xbrl.org — CompanyResolve, " +
        "CompanyFilings, and CompanyFinancials), KR (OpenDART/DART), JP (EDINET), " +
        "CN (cninfo — SSE/SZSE), " +
        "IN (BSE India), TW (TWSE OpenAPI — Taiwan listed companies), " +
        "BR (CVM open data — Brazilian listed companies), " +
        "DE (BaFin — German major-holding voting rights + directors' dealings), " +
        "FR (info-financiere.gouv.fr OAM + recherche-entreprises — French " +
        "regulated filings, threshold crossings, and officers), " +
        "HK (HKEXnews — Hong Kong listed issuers: CompanyResolve, CompanyFilings, " +
        "CompanyDocument), SG (ACRA via data.gov.sg — CompanyResolve only), or " +
        "TH (DBD juristic-person register — CompanyResolve only; keyless by " +
        "13-digit juristic number, name search needs DBD_API_KEY), or " +
        "NL (AFM disclosure registers — Dutch listed issuers: CompanyResolve, " +
        "CompanyOwners (Wft substantial holdings), CompanyInsiders (Art.19 MAR " +
        "managers' transactions + directors' holdings)), or " +
        "ID (IDX / Bursa Efek Indonesia — Indonesian listed issuers: " +
        "CompanyResolve, CompanyFilings, CompanyFinancials from real XBRL " +
        "instances; the host is anti-bot protected, so an injected " +
        "browser-backed fetchFn may be required), or " +
        "TR (KAP / Kamuyu Aydınlatma Platformu — Turkish BIST issuers: " +
        "CompanyResolve (BIST directory by stock code or name), " +
        "CompanyDocument (by KAP disclosure id); per-company filing " +
        "enumeration is not keyless-reachable, so CompanyFilings is " +
        "honestly unsupported). " +
        "Omit for the existing US default.",
    ),
};

export type ToolRuntime = AdapterOptions;

/**
 * The EU jurisdiction is served only by filings.xbrl.org (ESEF/UKSEF filers), so
 * every intent beyond CompanyResolve, CompanyFilings, and CompanyFinancials
 * returns this honest unsupported explanation rather than silently falling
 * through to the US path.
 */
export function euUnsupportedResult(tool: string): ToolResult {
  return textResult(
    `${tool} is unsupported for jurisdiction "EU". The EU route covers only ` +
      "ESEF/UKSEF annual financial reports indexed by filings.xbrl.org, which serve " +
      "CompanyResolve, CompanyFilings, and CompanyFinancials. For an EU issuer use one " +
      'of those with jurisdiction "EU", OwnershipChain (global GLEIF), or the issuer\'s ' +
      "national jurisdiction where this release supports one.",
  );
}

export function notFoundResult(company: string, detail?: string): ToolResult {
  return textResult(
    `Could not find a company matching "${company}".` +
      (detail ? ` ${detail}` : " Try a ticker symbol, SEC CIK number, or LEI."),
  );
}

/**
 * Convert adapter failures into readable MCP results. Resolution misses
 * degrade to a plain "Could not find" message without the error flag;
 * configuration and rate-limit failures keep isError so callers can react.
 */
export function failureResult(company: string, error: unknown): ToolResult {
  if (
    error instanceof AdapterConfigurationError ||
    error instanceof AdapterRateLimitError
  ) {
    return errorResult(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /not found|no sec company found|no gleif entity|no companies house company found|no opendart company found|no edinet company found|no cninfo company found|no bse company found|no twse company found|no cvm company found|no bafin company found|no hkexnews company found|no acra company found|no afm issuer found|no idx company found/i
      .test(message)
  ) {
    return notFoundResult(company);
  }
  return errorResult(message);
}
