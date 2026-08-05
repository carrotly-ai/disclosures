import { z } from "zod";
import type { AdapterOptions, ToolResult } from "../core/types.js";
import { errorResult, textResult } from "../core/toolDefs.js";
import {
  SecConfigurationError,
  SecRateLimitError,
} from "../adapters/secEdgar.js";
import { GleifRateLimitError } from "../adapters/gleif.js";

export const companyInput = {
  company: z
    .string()
    .min(1)
    .describe("Company name, ticker symbol, SEC CIK number, or 20-character LEI"),
  jurisdiction: z
    .enum(["US"])
    .optional()
    .describe("Jurisdiction to search. v1 supports \"US\" (SEC EDGAR); omit for the default"),
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
  if (error instanceof SecConfigurationError) return errorResult(error.message);
  if (error instanceof SecRateLimitError || error instanceof GleifRateLimitError) {
    return errorResult(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|no sec company found|no gleif entity/i.test(message)) {
    return notFoundResult(company);
  }
  return errorResult(message);
}
