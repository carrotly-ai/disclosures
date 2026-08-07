import { describe, expect, test } from "bun:test";
import {
  HttpError,
  getFollowingRedirects,
  getJson,
  getOptionalJson,
  getText,
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
