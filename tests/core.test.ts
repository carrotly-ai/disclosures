import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  HttpError,
  getFollowingRedirects,
  getJson,
  getOptionalJson,
  getText,
  getTextLenient,
  isLenientHost,
  performLenientGet,
} from "../src/core/http.js";
import { markdownTable } from "../src/core/markdown.js";
import { SlidingWindowRateLimiter } from "../src/core/rateLimiter.js";
import { decodeXmlEntities, plainXmlText } from "../src/core/parsing.js";
import { defineTool } from "../src/core/toolDefs.js";
import { z } from "zod";
import { routedFetch } from "./helpers/routedFetch.js";

describe("HTTP helpers", () => {
  test("parse JSON and text responses", async () => {
    const fetchFn = routedFetch([
      { pattern: "/json", body: { ok: true } },
      { pattern: "/text", body: "hello" },
    ]);
    expect(await getJson("https://example.test/json", {}, 1000, fetchFn)).toEqual({ ok: true });
    expect(await getText("https://example.test/text", {}, 1000, fetchFn)).toBe("hello");
  });

  test("follows a 302 but never forwards Authorization across origins", async () => {
    // Companies House document content 302s to a pre-signed S3 URL that rejects
    // a forwarded Authorization header — the client must drop it on the hop.
    const s3Url = "https://s3.eu-west-2.amazonaws.com/chs-doc/signed.pdf?sig=abc";
    const fetchFn = routedFetch([
      { pattern: "amazonaws.com", body: "PDF-CONTENT" },
      {
        pattern: "document-api.company-information.service.gov.uk",
        body: "",
        status: 302,
        headers: { location: s3Url },
      },
    ]);
    const { response, finalUrl } = await getFollowingRedirects(
      "https://document-api.company-information.service.gov.uk/document/doc-1/content",
      { Authorization: "Basic secret", Accept: "application/pdf" },
      1000,
      fetchFn,
    );
    expect(finalUrl).toBe(s3Url);
    expect(await response.text()).toBe("PDF-CONTENT");
    const first = fetchFn.requests[0]?.init?.headers as Record<string, string>;
    const second = fetchFn.requests[1]?.init?.headers as Record<string, string>;
    expect(first?.Authorization).toBe("Basic secret");
    expect(
      Object.keys(second ?? {}).some((key) => key.toLowerCase() === "authorization"),
    ).toBe(false);
    // Non-credential headers still ride along to the redirect target.
    expect(second?.Accept).toBe("application/pdf");
  });

  test("same-origin redirects keep Authorization", async () => {
    const fetchFn = routedFetch([
      { pattern: "/final", body: { ok: true } },
      {
        pattern: "/start",
        body: "",
        status: 307,
        headers: { location: "https://example.test/final" },
      },
    ]);
    const { response } = await getFollowingRedirects(
      "https://example.test/start",
      { Authorization: "Basic keep" },
      1000,
      fetchFn,
    );
    expect(response.status).toBe(200);
    const second = fetchFn.requests[1]?.init?.headers as Record<string, string>;
    expect(second?.Authorization).toBe("Basic keep");
  });

  test("a redirect without a Location header is an error", async () => {
    const fetchFn = routedFetch([
      { pattern: "/loop", body: "", status: 302 },
    ]);
    await expect(
      getFollowingRedirects("https://example.test/loop", {}, 1000, fetchFn),
    ).rejects.toBeInstanceOf(HttpError);
  });

  test("returns null only for optional 404 responses", async () => {
    const fetchFn = routedFetch([
      { pattern: "/missing", body: "missing", status: 404 },
      { pattern: "/broken", body: "broken", status: 500 },
    ]);
    expect(await getOptionalJson("https://example.test/missing", {}, 1000, fetchFn)).toBeNull();
    await expect(getOptionalJson("https://example.test/broken", {}, 1000, fetchFn)).rejects.toBeInstanceOf(HttpError);
  });
});

// The lenient node:https path (issue #42) exists because BaFin's portal emits
// an obsolete line-folded `Permissions-Policy` header that undici's fetch
// rejects. That obs-fold behaviour cannot be reproduced through the injected
// fetch stub, so these tests cover the routing/scoping and error-shape contract
// against a real local node server instead.
describe("lenient HTTP path (issue #42)", () => {
  interface LocalServer {
    origin: string;
    close: () => Promise<void>;
  }

  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<LocalServer> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("isLenientHost gates strictly on the BaFin portal host", () => {
    expect(isLenientHost("https://portal.mvp.bafin.de/database/AnteileInfo/suche.do")).toBe(true);
    expect(isLenientHost("https://example.test/whatever")).toBe(false);
    // A look-alike host must not match.
    expect(isLenientHost("https://portal.mvp.bafin.de.evil.test/x")).toBe(false);
    expect(isLenientHost("not a url")).toBe(false);
  });

  test("getTextLenient refuses a non-allowlisted host before opening a socket", async () => {
    // No server is listening on example.test; if the gate leaked, this would be
    // a DNS/connect error rather than the allowlist HttpError below.
    await expect(getTextLenient("https://example.test/anything", {}, 500))
      .rejects.toBeInstanceOf(HttpError);
    await expect(getTextLenient("https://example.test/anything", {}, 500))
      .rejects.toThrow(/non-allowlisted host/i);
  });

  test("performLenientGet reads and UTF-8 decodes a 2xx body", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      // Non-ASCII German bytes must round-trip as UTF-8 (BaFin serves UTF-8).
      res.end("<html>Geschäftsführung – Müller & Söhne</html>");
    });
    try {
      const body = await performLenientGet(`${server.origin}/page`, {}, 2000);
      expect(body).toContain("Geschäftsführung – Müller & Söhne");
    } finally {
      await server.close();
    }
  });

  test("performLenientGet throws HttpError with the status on a non-2xx response", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503, {});
      res.end("upstream down");
    });
    try {
      const error = await performLenientGet(`${server.origin}/boom`, {}, 2000).catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(503);
    } finally {
      await server.close();
    }
  });

  test("performLenientGet respects the timeout when the server never responds", async () => {
    const server = await startServer(() => {
      // Intentionally never write a response — force the client-side timeout.
    });
    try {
      const error = await performLenientGet(`${server.origin}/hang`, {}, 150).catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).message).toMatch(/timed out/i);
    } finally {
      await server.close();
    }
  });

  test("performLenientGet follows a same-origin redirect but refuses a cross-origin one", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/cross") {
        res.writeHead(302, { location: "https://example.test/elsewhere" });
        res.end();
        return;
      }
      res.writeHead(200, {});
      res.end("landed");
    });
    try {
      expect(await performLenientGet(`${server.origin}/start`, {}, 2000)).toBe("landed");
      const error = await performLenientGet(`${server.origin}/cross`, {}, 2000).catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).message).toMatch(/cross-origin/i);
    } finally {
      await server.close();
    }
  });
});

describe("SlidingWindowRateLimiter", () => {
  test("enforces a rolling limit and expires old entries", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    now = 1000;
    expect(limiter.tryAcquire()).toBe(true);
  });
});

describe("XML parsing", () => {
  test("decodes CDATA, numeric, and named entities in valid markup", () => {
    expect(decodeXmlEntities("<![CDATA[Tom & Jerry]]>")).toBe("Tom & Jerry");
    expect(decodeXmlEntities("A &amp; B &#38; C &#x26; D")).toBe("A & B & C & D");
    expect(decodeXmlEntities("&lt;tag&gt; &quot;q&quot; &apos;a&apos;")).toBe(
      "<tag> \"q\" 'a'",
    );
  });

  test("strips tags and collapses whitespace", () => {
    expect(plainXmlText("<b>Hello</b>\n  <i>world</i>")).toBe("Hello world");
  });

  test("stays linear on pathological CDATA and stray-`<` input", () => {
    // Prefixes that would trigger O(n^2) backtracking with a lazy `[\s\S]*?`
    // CDATA body or a `[^>]*` tag class. The linear regexes must finish fast.
    const start = performance.now();
    decodeXmlEntities("<![CDATA[" + "a".repeat(200_000));
    plainXmlText("<".repeat(200_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("Markdown", () => {
  test("escapes pipes and newlines in table cells", () => {
    expect(markdownTable(["Name"], [["A|B\nC"]])).toContain("A\\|B C");
  });
});

describe("defineTool", () => {
  test("converts thrown errors to MCP errors", async () => {
    const tool = defineTool("Boom", "Throws", { value: z.string() }, async () => {
      throw new Error("broken");
    });
    const result = await tool.handler({ value: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Boom failed: broken" });
  });
});
