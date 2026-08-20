import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../src/tools/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(repoRoot, "dist", "server.mjs");

function ensureBuild(): void {
  if (existsSync(serverPath)) return;
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: repoRoot });
  if (build.exitCode !== 0) {
    throw new Error(`bun run build failed:\n${build.stderr.toString()}`);
  }
  if (!existsSync(serverPath)) {
    throw new Error(`Build completed but ${serverPath} is still missing.`);
  }
}

describe("stdio MCP server", () => {
  test("lists exactly the current tool set over a real stdio transport", async () => {
    ensureBuild();
    const client = new Client({ name: "disclosures-test-client", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      cwd: repoRoot,
      env: { ...process.env, DISCLOSURES_USER_AGENT: "Test test@example.com" } as Record<string, string>,
    });
    // PersonAppointments looks up a person, not a company, so it takes `query`/
    // `officer_id` rather than `company`. Every other tool is company-scoped.
    const nonCompanyTools = new Set(["PersonAppointments"]);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(TOOL_NAMES.length);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description?.length ?? 0).toBeGreaterThan(0);
        expect(tool.annotations?.openWorldHint).toBe(true);
        expect(tool.annotations?.readOnlyHint).toBe(tool.name !== "CompanyDocument");
        if (!nonCompanyTools.has(tool.name)) {
          expect(tool.inputSchema.properties).toHaveProperty("company");
        }
        // outputSchema is declared only where every non-error path emits
        // structuredContent — currently OwnershipChain alone. The other tools
        // emit structuredContent additively on success but keep honest-miss
        // text-only paths legal by not declaring an outputSchema.
        if (tool.name === "OwnershipChain") {
          expect(tool.outputSchema?.type).toBe("object");
          expect(tool.outputSchema?.properties).toHaveProperty("children");
          expect(tool.outputSchema?.properties).toHaveProperty("sourceJurisdiction");
        } else {
          expect(tool.outputSchema).toBeUndefined();
        }
      }

      // Jurisdiction reference cards ride the same server as resources.
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain("disclosures://jurisdictions");
      expect(uris).toContain("disclosures://jurisdictions/US");
      expect(uris).toContain("disclosures://jurisdictions/DE");
      const usCard = await client.readResource({ uri: "disclosures://jurisdictions/US" });
      const usText = usCard.contents
        .map((item) => ("text" in item ? String(item.text) : ""))
        .join("\n");
      expect(usText).toContain("DISCLOSURES_USER_AGENT");
      expect(usText).toContain("SEC EDGAR");
    } finally {
      await client.close();
    }
  }, 20_000);
});
