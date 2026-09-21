import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDisclosuresServer,
  TOOL_NAMES,
} from "disclosures";

const packageEntry = fileURLToPath(
  new URL("./node_modules/disclosures/dist/server.mjs", import.meta.url),
);
const LEI = "HWUPKR0MPOU8FGXBT394";

function resultText(result) {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

async function checkStdioLifecycle() {
  const client = new Client({ name: "installed-consumer", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [packageEntry],
    env: {},
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );

    const malformed = await client.callTool({
      name: "CompanyResolve",
      arguments: { company: 42 },
    });
    assert.equal(malformed.isError, true);
    assert.match(resultText(malformed), /invalid.*arguments/i);
  } finally {
    await client.close();
  }
}

async function callResolve(fetchFn) {
  const server = createDisclosuresServer({ env: {}, fetchFn });
  const client = new Client({ name: "installed-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({
      name: "CompanyResolve",
      arguments: { company: LEI },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

async function checkUpstreamError() {
  const result = await callResolve(async () =>
    new Response("fixture unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    }),
  );
  assert.equal(result.isError, true);
  assert.match(resultText(result), /HTTP 503 Service Unavailable/);
}

async function checkUpstreamTimeout() {
  const startedAt = Date.now();
  const result = await callResolve((_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert(signal, "The packed adapter must pass an abort signal upstream");
      signal.addEventListener(
        "abort",
        () => reject(new Error("deterministic fixture observed abort")),
        { once: true },
      );
    }),
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /Request timed out after 15000ms/);
  assert(
    elapsedMs >= 14_000 && elapsedMs < 25_000,
    `Expected the 15s upstream deadline, observed ${elapsedMs}ms`,
  );
}

await checkStdioLifecycle();
await checkUpstreamError();
await checkUpstreamTimeout();

console.log(
  `Node ${process.version}: installed package passed MCP lifecycle, malformed-input, upstream-error, and timeout checks.`,
);
