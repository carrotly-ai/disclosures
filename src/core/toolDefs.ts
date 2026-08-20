import type { z } from "zod";
import type { ToolResult } from "./types.js";

/**
 * MCP tool annotations (behavioral hints for clients). Every tool in this
 * package only reads open-world public registers; CompanyDocument is the one
 * exception to readOnlyHint because mode="pdf" saves a file to local disk.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  /**
   * Optional MCP outputSchema (a Zod raw shape). Declare it only on tools where
   * EVERY non-error result carries structuredContent — the MCP SDK's
   * validateToolOutput throws for a non-error CallToolResult that declares an
   * outputSchema but omits structuredContent (isError results are exempt).
   * Most tools here have honest-miss text-only paths (unsupported jurisdiction,
   * not-found, empty result), so they emit structuredContent additively without
   * declaring an outputSchema.
   */
  outputSchema?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  handler(args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  annotations?: ToolAnnotations,
  outputSchema?: z.ZodRawShape,
): ToolDefinition<Shape> {
  return {
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    async handler(args) {
      try {
        return await handler(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`${name} failed: ${message}`);
      }
    },
  };
}

/**
 * Success result. `structured` (optional) is emitted as MCP structuredContent
 * alongside the Markdown text, so clients can chain identifiers without
 * parsing prose. No outputSchema is declared — structuredContent is additive
 * and only present on paths that have structured data to offer.
 */
export function textResult(
  text: string,
  structured?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
