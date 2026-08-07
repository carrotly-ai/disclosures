// Live stdio smoke test: spawns the built Node bundle and calls real SEC and
// GLEIF endpoints. Requires DISCLOSURES_USER_AGENT (or SEC_EDGAR_USER_AGENT).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../src/tools/index.js";

const APPLE_LEI = "HWUPKR0MPOU8FGXBT394";

function firstText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null &&
      (item as { type?: string }).type === "text",
  );
  return block?.text ?? "";
}

async function main(): Promise<void> {
  if (!process.env.DISCLOSURES_USER_AGENT && !process.env.SEC_EDGAR_USER_AGENT) {
    throw new Error(
      "Set DISCLOSURES_USER_AGENT to a real contact string before the live smoke test.",
    );
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.mjs"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "disclosures-smoke", version: "0.0.0" });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    console.error(`tools/list → ${names.join(", ")}`);
    if (tools.tools.length !== TOOL_NAMES.length) {
      throw new Error(
        `Expected ${TOOL_NAMES.length} tools, found ${tools.tools.length}`,
      );
    }

    const insiders = await client.callTool({
      name: "CompanyInsiders",
      arguments: { company: "NVDA" },
    });
    const insidersText = firstText(insiders);
    console.error("--- CompanyInsiders NVDA ---");
    console.error(insidersText.slice(0, 1200));
    if (insiders.isError) throw new Error("CompanyInsiders returned isError");
    if (!/\|.*\|/.test(insidersText)) {
      throw new Error("CompanyInsiders did not return a markdown table");
    }

    const chain = await client.callTool({
      name: "OwnershipChain",
      arguments: { company: APPLE_LEI },
    });
    const chainText = firstText(chain);
    console.error("--- OwnershipChain Apple ---");
    console.error(chainText.slice(0, 1200));
    if (chain.isError) throw new Error("OwnershipChain returned isError");
    if (!/Apple/i.test(chainText)) {
      throw new Error("OwnershipChain did not resolve Apple Inc.");
    }

    console.error("LIVE SMOKE PASSED");
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  console.error("LIVE SMOKE FAILED:", error);
  process.exitCode = 1;
});
