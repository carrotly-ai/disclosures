import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  runHttpServer,
  SERVER_VERSION,
  TOOL_NAMES,
} from "disclosures";

const packageEntry = fileURLToPath(
  new URL("./node_modules/.bin/disclosures", import.meta.url),
);
const LEI = "HWUPKR0MPOU8FGXBT394";

async function bounded(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function resultText(result) {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

async function checkStdioLifecycle() {
  const client = new Client({ name: "installed-consumer", version: "1" });
  const child = spawn(process.execPath, [packageEntry], { env: {}, stdio: "pipe" });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  let diagnostics = "";
  const protocolErrors = [];
  child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
  const lines = createInterface({ input: child.stdout });
  // Observe EOF directly: SDK StdioClientTransport.close() ignores exit codes
  // and may send termination signals, masking lifecycle regressions.
  const transport = {
    async start() {},
    async send(message) {
      await new Promise((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    },
    async close() {
      child.stdin.end();
      try {
        const exit = await bounded(closed, "stdio EOF shutdown");
        assert.deepEqual(exit, { code: 0, signal: null }, diagnostics);
      } finally {
        lines.close();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    },
  };
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0", "stdout must contain only JSON-RPC");
      transport.onmessage?.(message);
    } catch (error) {
      protocolErrors.push(error);
      transport.onerror?.(error);
    }
  });
  child.stdin.on("error", (error) => transport.onerror?.(error));
  try {
    await bounded(client.connect(transport), "stdio initialization");
    assert.equal(client.getServerVersion().version, SERVER_VERSION);
    const { tools } = await bounded(client.listTools(), "stdio tool discovery");
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );

    const malformed = await bounded(client.callTool({
      name: "CompanyResolve",
      arguments: { company: 42 },
    }), "stdio argument rejection");
    assert.equal(malformed.isError, true);
    assert.match(resultText(malformed), /invalid.*arguments/i);

    child.stdin.write("{malformed JSON}\n");
    const recovered = await bounded(client.listTools(), "stdio recovery after malformed JSON");
    assert.equal(recovered.tools.length, TOOL_NAMES.length);
  } finally {
    await client.close();
  }
  assert.deepEqual(protocolErrors, []);
  assert.match(diagnostics, /ready \(10 tools\)/);
}

async function withHttpClient(fetchFn, check) {
  const server = await runHttpServer({
    port: 0, env: {}, fetchFn, downloadDirectory: process.cwd(),
  });
  const client = new Client({ name: "installed-fixture", version: "1" });
  const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
  try {
    await bounded(client.connect(new StreamableHTTPClientTransport(url)), "HTTP initialization");
    return await check(client, url);
  } finally {
    await client.close();
    await bounded(server.close(), "HTTP shutdown", 10_000);
  }
}

async function checkHttpLifecycle() {
  let requests = 0;
  await withHttpClient(async () => {
    requests += 1;
    throw new Error("Network forbidden in lifecycle check");
  }, async (client, url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{malformed JSON}",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32700);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    const result = await client.callTool({ name: "CompanyResolve", arguments: { company: 42 } });
    assert.equal(result.isError, true);
    const { contents } = await client.readResource({ uri: "disclosures://jurisdictions/US" });
    assert.match(contents[0].text, /SEC EDGAR/);
    assert.equal(requests, 0);
  });
}

async function callResolve(fetchFn) {
  let requests = 0;
  return withHttpClient((url, init) => {
    requests += 1;
    assert.equal(new URL(url).host, "api.gleif.org");
    assert.equal(requests, 1, "Failure fixtures must not fan out or retry");
    return fetchFn(url, init);
  }, async (client) => {
    const result = await client.callTool({
      name: "CompanyResolve",
      arguments: { company: LEI },
    });
    assert.equal(requests, 1);
    await client.listTools();
    return result;
  });
}

async function checkUpstreamError() {
  for (const [fetchFn, message] of [
    [async () => new Response("fixture unavailable", {
      status: 503, statusText: "Service Unavailable",
    }), /HTTP 503 Service Unavailable/],
    [async () => { throw new TypeError("fixture connection failed"); }, /fixture connection failed/],
    [async () => new Response("{invalid upstream JSON}"), /JSON|Unexpected token|Expected property/],
  ]) {
    const result = await callResolve(fetchFn);
    assert.equal(result.isError, true);
    assert.match(resultText(result), message);
  }
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

async function checkStalledBody() {
  let cancelled = false;
  let signal;
  const result = await callResolve(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
      cancel() { cancelled = true; },
    }));
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /Request timed out after 15000ms/);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true, "A timed-out body must be cancelled");
}

await checkStdioLifecycle();
await checkHttpLifecycle();
await checkUpstreamError();
await Promise.all([checkUpstreamTimeout(), checkStalledBody()]);

console.log(
  `Node ${process.version}: installed bin EOF, stdio/HTTP recovery, upstream errors, and fetch/body deadlines passed.`,
);
