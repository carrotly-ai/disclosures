import { describe, expect, test } from "bun:test";
import { HttpError, getJson, getOptionalJson, getText } from "../src/core/http.js";
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
