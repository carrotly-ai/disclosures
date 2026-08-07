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
        "8-digit BaFin-Id or ISIN (DE), or 20-character LEI",
    ),
  jurisdiction: z
    .enum(["US", "GB", "EU", "KR", "JP", "CN", "IN", "TW", "BR", "DE"])
    .optional()
    .describe(
      "Jurisdiction to search: US (SEC EDGAR), GB (Companies House), " +
        "EU (pan-European ESEF financials via filings.xbrl.org — CompanyFinancials " +
        "only), KR (OpenDART/DART), JP (EDINET), CN (cninfo — SSE/SZSE), " +
        "IN (BSE India), TW (TWSE OpenAPI — Taiwan listed companies), " +
        "BR (CVM open data — Brazilian listed companies), or " +
        "DE (BaFin — German major-holding voting rights + directors' dealings). " +
        "Omit for the existing US default.",
    ),
};

export type ToolRuntime = AdapterOptions;

/**
 * The EU jurisdiction is served only by filings.xbrl.org (ESEF/UKSEF annual
 * financials), so every intent other than CompanyFinancials returns this honest
 * unsupported explanation rather than silently falling through to the US path.
 */
export function euUnsupportedResult(tool: string): ToolResult {
  return textResult(
    `${tool} is unsupported for jurisdiction "EU". The EU route covers only ` +
      "ESEF/UKSEF annual financial reports indexed by filings.xbrl.org, which serve " +
      'CompanyFinancials. For an EU issuer use CompanyFinancials with jurisdiction "EU", ' +
      "OwnershipChain (global GLEIF), or the issuer's national jurisdiction where this " +
      "release supports one.",
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
    /not found|no sec company found|no gleif entity|no companies house company found|no opendart company found|no edinet company found|no cninfo company found|no bse company found|no twse company found|no cvm company found|no bafin company found/i
      .test(message)
  ) {
    return notFoundResult(company);
  }
  return errorResult(message);
}
