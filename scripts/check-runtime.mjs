import { request } from "node:http";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runHttpServer, SERVER_VERSION, TOOL_NAMES } from "../dist/server.mjs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(SERVER_VERSION, pkg.version);
const check = async (transport) => {
  const client = new Client({ name: "runtime-check", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    const result = await client.callTool({
      name: "PrivateRaises",
      arguments: { company: "1", jurisdiction: "NL" },
    });
    assert.match(result.content[0].text, /unsupported/);
    const { contents } = await client.readResource({
      uri: "disclosures://jurisdictions/US",
    });
    assert.match(contents[0].text, /SEC/);
  } finally {
    await client.close();
  }
};
await check(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
    env: {},
  }),
);
const server = await runHttpServer({
  port: 0,
  env: {},
  fetchFn: async () => {
    throw Error("Network forbidden in runtime check");
  },
});
try {
  await check(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  const rejected = await new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${server.port}/mcp`,
      { method: "POST", headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(rejected, 403);
} finally {
  await server.close();
}
console.log(
  `Node ${process.version}: fresh bundle passed stdio and HTTP checks.`,
);
