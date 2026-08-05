import { describe, expect, test } from "bun:test";
import { HttpError, getJson, getOptionalJson, getText } from "../src/core/http.js";
import { markdownTable } from "../src/core/markdown.js";
import { SlidingWindowRateLimiter } from "../src/core/rateLimiter.js";
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
