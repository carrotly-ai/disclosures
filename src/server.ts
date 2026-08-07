#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createTools, TOOL_NAMES } from "./tools/index.js";
import type { AdapterOptions } from "./core/types.js";

export const SERVER_NAME = "disclosures";
export const SERVER_VERSION = "0.1.1";

export function createDisclosuresServer(options: AdapterOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of createTools(options)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => tool.handler(args as never),
    );
  }
  return server;
}

export async function runServer(options: AdapterOptions = {}): Promise<void> {
  const server = createDisclosuresServer(options);
  await server.connect(new StdioServerTransport());
  // Stdout is reserved for JSON-RPC; all diagnostics go to stderr.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready (${TOOL_NAMES.length} tools)`);
}

// Library exports
export { createTools, TOOL_NAMES } from "./tools/index.js";
export { defineTool, textResult, errorResult } from "./core/toolDefs.js";
export type { ToolDefinition } from "./core/toolDefs.js";
export * from "./core/cache.js";
export * from "./core/types.js";
export * from "./core/entityMatching.js";
export * from "./core/errors.js";
export * from "./core/http.js";
export * from "./core/markdown.js";
export * from "./core/parsing.js";
export * from "./core/rateLimiter.js";
export * from "./core/zip.js";
export * as secEdgar from "./adapters/secEdgar.js";
export * as gleif from "./adapters/gleif.js";
export * as companiesHouse from "./adapters/companiesHouse.js";
export * as openDart from "./adapters/openDart.js";
export * as edinet from "./adapters/edinet.js";
export * as cninfo from "./adapters/cninfo.js";
export * as bseIndia from "./adapters/bseIndia.js";
export * as fcaNsm from "./adapters/fcaNsm.js";
export * as xbrlFilings from "./adapters/xbrlFilings.js";
export * as twseOpenApi from "./adapters/twseOpenApi.js";
export * as cvmOpenData from "./adapters/cvmOpenData.js";
export * as bafin from "./adapters/bafin.js";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runServer().catch((error) => {
    console.error("disclosures server failed to start:", error);
    process.exitCode = 1;
  });
}
