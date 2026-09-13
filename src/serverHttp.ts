import { timingSafeEqual, createHash, webcrypto } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createDisclosuresServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
import { TOOL_NAMES } from "./tools/index.js";
import type { AdapterOptions } from "./core/types.js";

export interface HttpServerOptions extends AdapterOptions {
  /** TCP port to bind; defaults to PORT env or 8080. Pass 0 for an ephemeral port. */
  port?: number;
  /** Interface to bind; defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Exact HTTP authorities, including the port. Required for non-loopback binds. */
  allowedHosts?: string[];
  /** Exact browser origins. Defaults to HTTP origins for allowedHosts. */
  allowedOrigins?: string[];
  /** Required for non-loopback binds. Also configurable via DISCLOSURES_HTTP_TOKEN. */
  bearerToken?: string;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

// Stateless streamable-HTTP has no server-initiated stream or session to tear
// down, so GET/DELETE on the MCP endpoint have nothing to serve.
function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

// Host, Origin, and bearer access are checked before any transport is created.
// Stateless mode: a fresh server + transport per request keeps requests fully
// independent (no shared session state, no cross-request id collisions). The
// transport reads the request body itself via the Node<->Web adapter, so no
// pre-parsing is needed.
async function handleMcpPost(
  adapterOptions: AdapterOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createDisclosuresServer(adapterOptions);
  // Omitting sessionIdGenerator selects stateless mode (no session id, no
  // server-initiated stream); the SDK requires a fresh transport per request.
  const transport = new StreamableHTTPServerTransport({});
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res);
}

export async function runHttpServer(
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const {
    port: portOption,
    host: hostOption,
    allowedHosts: hostsOption,
    allowedOrigins: originsOption,
    bearerToken: tokenOption,
    ...adapterOptions
  } = options;
  const env = options.env ?? process.env;
  const host = hostOption ?? "127.0.0.1";
  const port = portOption ?? (Number(env.PORT) || 8080);

  // Node 18 exposes Web Crypto through node:crypto but not globally in ESM.
  // The MCP HTTP transport uses the standard global for request identifiers.
  if (!globalThis.crypto)
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
    });
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const token = tokenOption ?? env.DISCLOSURES_HTTP_TOKEN;
  const configuredHosts =
    hostsOption ??
    env.DISCLOSURES_HTTP_ALLOWED_HOSTS?.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (!loopback && (!token || !configuredHosts?.length)) {
    throw new Error(
      "Non-loopback HTTP requires DISCLOSURES_HTTP_TOKEN and DISCLOSURES_HTTP_ALLOWED_HOSTS (or bearerToken and allowedHosts options).",
    );
  }
  if (configuredHosts?.some((h) => !h || h.includes("*") || /[\s/@?#]/.test(h)))
    throw new Error("allowedHosts must contain exact HTTP authorities.");
  let allowedHosts = configuredHosts ?? [];
  const configuredOrigins =
    originsOption ??
    env.DISCLOSURES_HTTP_ALLOWED_ORIGINS?.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  let allowedOrigins = configuredOrigins ?? [];
  const tokenHash = token
    ? createHash("sha256").update(`Bearer ${token}`).digest()
    : undefined;
  const downloadDirectory =
    adapterOptions.downloadDirectory ?? env.DISCLOSURES_DOWNLOAD_DIR;
  adapterOptions.downloadDirectory = downloadDirectory?.trim()
    ? resolvePath(downloadDirectory)
    : await mkdtemp(join(tmpdir(), "disclosures-http-"));

  const httpServer = createServer((req, res) => {
    if (
      !allowedHosts.includes(req.headers.host ?? "") ||
      (req.headers.origin !== undefined &&
        !allowedOrigins.includes(req.headers.origin))
    ) {
      sendJson(res, 403, { error: "Untrusted Host or Origin." });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        tools: TOOL_NAMES.length,
      });
      return;
    }
    if (path === "/mcp") {
      if (
        tokenHash &&
        !timingSafeEqual(
          tokenHash,
          createHash("sha256")
            .update(req.headers.authorization ?? "")
            .digest(),
        )
      ) {
        res
          .writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": "Bearer",
          })
          .end(JSON.stringify({ error: "Unauthorized." }));
        return;
      }
      if (req.method === "POST") {
        handleMcpPost(adapterOptions, req, res).catch((error) => {
          // Diagnostics go to stderr; stdout stays clean for parity with stdio mode.
          console.error("disclosures HTTP /mcp error:", error);
          if (!res.headersSent) {
            sendJson(res, 500, {
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error." },
              id: null,
            });
          }
        });
        return;
      }
      methodNotAllowed(res);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      const boundPort =
        typeof address === "object" && address ? address.port : port;
      if (!configuredHosts)
        allowedHosts = ["127.0.0.1", "localhost", "[::1]"].map(
          (h) => `${h}:${boundPort}`,
        );
      if (!configuredOrigins)
        allowedOrigins = allowedHosts.map((h) => `http://${h}`);
      console.error(
        `${SERVER_NAME} ${SERVER_VERSION} HTTP ready on http://${host}:${boundPort}/mcp (${TOOL_NAMES.length} tools)`,
      );
      resolve({
        host,
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) =>
            httpServer.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
