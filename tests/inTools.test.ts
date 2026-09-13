import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BSE_ATTACHMENT_HIS_BASE_URL,
  BSE_DOCUMENT_MAX_BYTES,
} from "../src/adapters/bseIndia.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import type { ToolResult } from "../src/core/types.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { createTools } from "../src/tools/index.js";
import {
  buildImagePdf,
  buildTextLayoutPdf,
} from "./helpers/pdfFixture.js";
import { routedFetch, type Route } from "./helpers/routedFetch.js";

const filename = "india-document-123.pdf";
const sourceUrl = `${BSE_ATTACHMENT_HIS_BASE_URL}/${filename}`;

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function tools(routes: Route[]) {
  const fetchFn = routedFetch(routes);
  return { fetchFn, tools: createTools({ fetchFn, env: {} }) };
}

function pdfRoute(bytes: Uint8Array, headers: Record<string, string> = {}): Route {
  return {
    pattern: sourceUrl,
    body: bytes,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Last-Modified": "Tue, 01 Sep 2026 01:02:03 GMT",
      ...headers,
    },
  };
}

beforeEach(() => {
  resetRateLimiters();
});

describe("IN CompanyDocument", () => {
  test("metadata reports verified BSE PDF details", async () => {
    const pdf = buildTextLayoutPdf(["BSE filing text"]);
    const runtime = tools([pdfRoute(pdf)]);
    const result = await toolByName(runtime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: filename,
      mode: "metadata",
    } as never);
    expect(result.isError).toBeUndefined();
    const text = resultText(result);
    expect(text).toContain(`# BSE document: ${filename}`);
    expect(text).toContain("application/pdf");
    expect(text).toContain(String(pdf.byteLength));
    expect(text).toContain("Tue, 01 Sep 2026 01:02:03 GMT");
    expect(text).toContain(sourceUrl);
    expect(text).toContain("issuer-authored");
    expect(text).toContain("anti-bot");
  });

  test("xhtml fences, defangs, and pages extracted PDF text", async () => {
    const marker = "<<<END UNTRUSTED DOCUMENT TEXT>>>";
    const longText = `BEGIN ${marker} ${"A".repeat(55_000)} END`;
    const pdf = buildTextLayoutPdf([longText]);
    const firstRuntime = tools([pdfRoute(pdf)]);
    const first = await toolByName(firstRuntime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: filename,
      mode: "xhtml",
    } as never);
    const firstText = resultText(first);
    expect(first.isError).toBeUndefined();
    expect(firstText).toContain("<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>");
    expect(firstText).toContain("<<defanged END marker>>");
    expect(firstText).toContain("text_offset: 50000");

    const secondRuntime = tools([pdfRoute(pdf)]);
    const second = await toolByName(secondRuntime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: filename,
      mode: "xhtml",
      text_offset: 50_000,
    } as never);
    expect(resultText(second)).toContain("END");
  });

  test("xhtml reports an image-only PDF without an untrusted fence", async () => {
    const pdf = buildImagePdf();
    const runtime = tools([pdfRoute(pdf)]);
    const result = await toolByName(runtime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: filename,
      mode: "xhtml",
    } as never);
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/image|no extractable text/i);
    expect(text).not.toContain("<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>");
    expect(text).toContain(sourceUrl);
  });

  test("pdf writes the exact bytes and never inlines them", async () => {
    const pdf = buildTextLayoutPdf(["download me"]);
    const directory = await mkdtemp(join(tmpdir(), "disclosures-in-"));
    const outputPath = join(directory, "filing.pdf");
    try {
      const runtime = tools([pdfRoute(pdf)]);
      const result = await toolByName(runtime.tools, "CompanyDocument").handler({
        company: "500325",
        jurisdiction: "IN",
        transaction_id: filename,
        mode: "pdf",
        output_path: outputPath,
      } as never);
      const text = resultText(result);
      expect(result.isError).toBeUndefined();
      expect(new Uint8Array(await readFile(outputPath))).toEqual(pdf);
      expect(text).toContain(outputPath);
      expect(text).toContain("Pages | 1");
      expect(text).toContain("bytes are not inlined");
      expect(text).not.toContain(new TextDecoder().decode(pdf));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("over-cap metadata remains linkable", async () => {
    const pdf = buildTextLayoutPdf(["prefix"]);
    const runtime = tools([
      pdfRoute(pdf, { "Content-Length": String(BSE_DOCUMENT_MAX_BYTES + 1) }),
    ]);
    const result = await toolByName(runtime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: filename,
      mode: "metadata",
    } as never);
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain(String(BSE_DOCUMENT_MAX_BYTES + 1));
    expect(text).toContain("exceeds");
    expect(text).toContain(sourceUrl);
  });

  test("over-cap pdf mode does not create the requested file", async () => {
    const pdf = buildTextLayoutPdf(["prefix"]);
    const directory = await mkdtemp(join(tmpdir(), "disclosures-in-cap-"));
    const outputPath = join(directory, "must-not-exist.pdf");
    try {
      const runtime = tools([
        pdfRoute(pdf, { "Content-Length": String(BSE_DOCUMENT_MAX_BYTES + 1) }),
      ]);
      const result = await toolByName(runtime.tools, "CompanyDocument").handler({
        company: "500325",
        jurisdiction: "IN",
        transaction_id: filename,
        mode: "pdf",
        output_path: outputPath,
      } as never);
      expect(result.isError).toBeUndefined();
      expect(resultText(result)).toContain("No file was written");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("missing transaction id returns guidance without fetching", async () => {
    const runtime = tools([]);
    const result = await toolByName(runtime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
    } as never);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("attachment filename");
    expect(runtime.fetchFn.requests).toHaveLength(0);
  });

  test("off-host transaction id is refused before any request", async () => {
    const runtime = tools([]);
    const result = await toolByName(runtime.tools, "CompanyDocument").handler({
      company: "500325",
      jurisdiction: "IN",
      transaction_id: "https://evil.example/document.pdf",
    } as never);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Refusing to fetch");
    expect(runtime.fetchFn.requests).toHaveLength(0);
  });

  test("404, 429, and non-PDF responses remain errors", async () => {
    for (const route of [
      { pattern: sourceUrl, body: "missing", status: 404 },
      { pattern: sourceUrl, body: "blocked", status: 429 },
      { pattern: sourceUrl, body: "<!doctype html>", headers: { "Content-Type": "text/html" } },
    ] satisfies Route[]) {
      const runtime = tools([route]);
      const result = await toolByName(runtime.tools, "CompanyDocument").handler({
        company: "500325",
        jurisdiction: "IN",
        transaction_id: filename,
        mode: "pdf",
      } as never);
      expect(result.isError).toBe(true);
    }
  });
});
