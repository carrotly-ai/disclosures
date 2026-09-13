import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runHttpServer, type RunningHttpServer } from "../src/serverHttp.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/server.js";
import { TOOL_NAMES } from "../src/tools/index.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { resetSecTickerCache } from "../src/adapters/secEdgar.js";
import type { Env } from "../src/core/types.js";
import { routedFetch } from "./helpers/routedFetch.js";

const ENV: Env = { DISCLOSURES_USER_AGENT: "Test test@example.com" };
const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";

function gleifCollection(data: Array<Record<string, unknown>>): Record<string, unknown> {
  return { meta: { pagination: { total: data.length } }, links: {}, data };
}

function gleifRecord(lei: string, legalName: string): Record<string, unknown> {
  return {
    type: "lei-records",
    id: lei,
    attributes: {
      lei,
      entity: {
        legalName: { name: legalName },
        otherNames: [],
        jurisdiction: "US",
        status: "ACTIVE",
      },
      registration: { status: "ISSUED" },
    },
    relationships: {},
    links: { self: `https://api.gleif.org/api/v1/lei-records/${lei}` },
  };
}

let running: RunningHttpServer | undefined;

beforeEach(() => {
  resetRateLimiters();
  resetSecTickerCache();
});

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
});

describe("HTTP MCP server", () => {
  test("GET /healthz returns name, version, and tool count", async () => {
    running = await runHttpServer({ port: 0, env: ENV });
    const response = await fetch(`http://${running.host}:${running.port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string; version: string; tools: number };
    expect(body.name).toBe(SERVER_NAME);
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.tools).toBe(TOOL_NAMES.length);
  });

  test("lists exactly the current tool set over a real streamable-HTTP transport", async () => {
    running = await runHttpServer({ port: 0, fetchFn: routedFetch([]), env: ENV });
    const client = new Client({ name: "disclosures-http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${running.host}:${running.port}/mcp`),
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(TOOL_NAMES.length);

      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain("disclosures://jurisdictions");
    } finally {
      await client.close();
    }
  }, 20_000);

  test("calls CompanyResolve over HTTP with a GLEIF-shaped stub, no live network", async () => {
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: gleifCollection([gleifRecord(APPLE_LEI, "APPLE INC.")]) },
    ]);
    running = await runHttpServer({ port: 0, fetchFn, env: ENV });
    const client = new Client({ name: "disclosures-http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${running.host}:${running.port}/mcp`),
    );
    try {
      await client.connect(transport);
      // LEI input takes the GLEIF-only path, so the stub above fully serves it.
      const result = await client.callTool({ name: "CompanyResolve", arguments: { company: APPLE_LEI } });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((item) => (item.type === "text" ? item.text ?? "" : ""))
        .join("\n");
      expect(text).toContain(APPLE_LEI);
      expect(text).toContain("Exact LEI match");
      // Only the injected stub was hit — no request escaped to the live network.
      expect(fetchFn.requests.every(({ url }) => new URL(url).host === "api.gleif.org")).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  test("OwnershipChain passes SDK output-schema validation on both success and miss", async () => {
    // OwnershipChain is the one tool that declares an outputSchema, so the SDK's
    // validateToolOutput runs on every non-error result. A resolved chain and a
    // not-found miss must BOTH carry schema-valid structuredContent, or the SDK
    // rejects the call — exercising it over the real transport proves it.
    const fetchFn = routedFetch([
      { pattern: "filter%5Blei%5D", body: gleifCollection([gleifRecord(APPLE_LEI, "APPLE INC.")]) },
      { pattern: "filter%5Bentity.legalName%5D", body: gleifCollection([]) },
    ]);
    running = await runHttpServer({ port: 0, fetchFn, env: ENV });
    const client = new Client({ name: "disclosures-http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${running.host}:${running.port}/mcp`),
    );
    try {
      await client.connect(transport);

      const ok = await client.callTool({ name: "OwnershipChain", arguments: { company: APPLE_LEI } });
      expect(ok.isError).toBeFalsy();
      expect((ok.structuredContent as { resolved?: boolean }).resolved).toBe(true);
      expect((ok.structuredContent as { entity?: { lei?: string } }).entity?.lei).toBe(APPLE_LEI);

      const miss = await client.callTool({
        name: "OwnershipChain",
        arguments: { company: "No Such Entity At All" },
      });
      expect(miss.isError).toBeFalsy();
      expect((miss.structuredContent as { resolved?: boolean }).resolved).toBe(false);
    } finally {
      await client.close();
    }
  }, 20_000);
});

test("untrusted Host and Origin fail before tool dispatch", async () => {
  const fetchFn = routedFetch([]);
  running = await runHttpServer({ port: 0, env: {}, fetchFn });
  for (const headers of [{ Host: "attacker.example" }, { Origin: "http://attacker.example" }, { Origin: "null" }]) {
    const response = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}",
    });
    expect(response.status).toBe(403);
    await response.text();
  }
  expect(fetchFn.requests).toHaveLength(0);
});

test("non-loopback binds require authentication and explicit authorities", async () => {
  await expect(runHttpServer({ host: "0.0.0.0", port: 0, env: {} })).rejects.toThrow("requires");
  await expect(runHttpServer({ host: "0.0.0.0", port: 0, env: {}, bearerToken: "test" })).rejects.toThrow("requires");
});

test("hosted requests require the configured bearer token", async () => {
  running = await runHttpServer({ host: "0.0.0.0", port: 0, env: {}, bearerToken: "test-token", allowedHosts: ["disclosures.example"], allowedOrigins: ["https://disclosures.example"] });
  for (const [authorization, expected] of [["", 401], ["Bearer wrong", 401], ["Bearer test-token", 200]] as const) {
    const response = await fetch(`http://127.0.0.1:${running.port}/mcp`, { method: "POST", headers: {
      Host: "disclosures.example", Origin: "https://disclosures.example", Authorization: authorization,
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } }) });
    expect(response.status).toBe(expected);
    await response.text();
  }
});

test("HTTP PDF paths remain confined and existing files survive", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "disclosures-http-files-"));
  const client = new Client({ name: "http-files-test", version: "1" });
  running = await runHttpServer({ port: 0, downloadDirectory: dir, env: { COMPANIES_HOUSE_API_KEY: "fake" },
    fetchFn: async url => url.endsWith("/content")
      ? new Response("%PDF-1.4\n%%EOF", { headers: { "Content-Type": "application/pdf" } })
      : Response.json({ filename: "document.pdf", resources: { "application/pdf": { content_length: 15 } } }),
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    const call = (output_path: string) => client.callTool({ name: "CompanyDocument", arguments: { company: "1", jurisdiction: "GB", document_id: "fake", mode: "pdf", output_path } });
    expect((await call("../outside.pdf")).isError).toBe(true);
    expect((await call("result.pdf")).isError).toBeFalsy();
    expect((await call("result.pdf")).isError).toBe(true);
    expect(await readFile(join(dir, "result.pdf"), "utf8")).toBe("%PDF-1.4\n%%EOF");
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
