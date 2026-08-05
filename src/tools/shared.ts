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
        "securities code, or 13-digit corporate number (JP), or 20-character LEI",
    ),
  jurisdiction: z
    .enum(["US", "GB", "KR", "JP"])
    .optional()
    .describe(
      "Jurisdiction to search: US (SEC EDGAR), GB (Companies House), " +
        "KR (OpenDART/DART), or JP (EDINET). Omit for the existing US default.",
    ),
};

export type ToolRuntime = AdapterOptions;

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
    /not found|no sec company found|no gleif entity|no companies house company found|no opendart company found|no edinet company found/i
      .test(message)
  ) {
    return notFoundResult(company);
  }
  return errorResult(message);
}
