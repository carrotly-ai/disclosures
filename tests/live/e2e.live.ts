import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_NAMES } from "../../src/tools/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = join(repoRoot, "dist", "server.mjs");
const appleLei = "HWUPKR0MPOU8FGXBT394";
const testTimeoutMs = 300_000;
const callTimeoutMs = 150_000;
const maxAttempts = 2;

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
}

const env = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) => {
    const normalized = normalizeEnvValue(value);
    return normalized === undefined ? [] : [[key, normalized]];
  }),
) as Record<string, string>;

interface CredentialRequirement {
  label: string;
  present: boolean;
}

const secCredential: CredentialRequirement = {
  label: "DISCLOSURES_USER_AGENT or SEC_EDGAR_USER_AGENT",
  present: Boolean(env.DISCLOSURES_USER_AGENT || env.SEC_EDGAR_USER_AGENT),
};
const companiesHouseCredential: CredentialRequirement = {
  label: "COMPANIES_HOUSE_API_KEY",
  present: Boolean(env.COMPANIES_HOUSE_API_KEY),
};
const openDartCredential: CredentialRequirement = {
  label: "OPENDART_API_KEY",
  present: Boolean(env.OPENDART_API_KEY),
};
const edinetCredential: CredentialRequirement = {
  label: "EDINET_API_KEY",
  present: Boolean(env.EDINET_API_KEY),
};
const allCredentials = [
  secCredential,
  companiesHouseCredential,
  openDartCredential,
  edinetCredential,
];

let client: Client;

function firstText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null &&
      (item as { type?: string }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  return block?.text ?? "";
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const key of [
    "DISCLOSURES_USER_AGENT",
    "SEC_EDGAR_USER_AGENT",
    "COMPANIES_HOUSE_API_KEY",
    "OPENDART_API_KEY",
    "EDINET_API_KEY",
  ]) {
    const secret = env[key];
    if (secret) redacted = redacted.split(secret).join(`[REDACTED ${key}]`);
  }
  return redacted.replace(
    /([?&](?:crtfc_key|Subscription-Key|api_key)=)[^&\s)]+/gi,
    "$1[REDACTED]",
  );
}

function isTransientFailure(message: string): boolean {
  return /HTTP (?:408|425|429|5\d\d)|aborted|ECONN|fetch failed|network|rate limit|socket|temporar|timed? out|timeout|upstream unavailable/i
    .test(message);
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${callTimeoutMs}ms`)),
          callTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callLiveTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let lastFailure = "unknown failure";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await withTimeout(
        client.callTool(
          { name, arguments: args },
          CallToolResultSchema,
          { timeout: callTimeoutMs },
        ),
        name,
      );
      const text = firstText(result);
      if (!result.isError) {
        if (!text.trim()) throw new Error(`${name} returned no text content`);
        return text;
      }
      lastFailure = redactSecrets(text || `${name} returned isError without text`);
    } catch (error) {
      lastFailure = redactSecrets(error instanceof Error ? error.message : String(error));
    }

    if (attempt < maxAttempts && isTransientFailure(lastFailure)) {
      console.error(`${name}: transient live failure; retrying once`);
      await pause(1_000);
      continue;
    }
    break;
  }
  throw new Error(`${name} live call failed: ${lastFailure}`);
}

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "")
    .split("|").map((cell) => cell.trim());
}

function markdownCell(text: string, column: string): string {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim().startsWith("|")) continue;
    const headers = splitMarkdownRow(line);
    const columnIndex = headers.indexOf(column);
    if (columnIndex < 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      if (!row?.trim().startsWith("|")) break;
      const cells = splitMarkdownRow(row);
      const value = cells[columnIndex];
      if (value) return value.replace(/^`|`$/g, "");
    }
  }
  throw new Error(`Could not find a value under markdown column "${column}"`);
}

function previousWeekdayIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

function credentialedTest(
  name: string,
  requirements: readonly CredentialRequirement[],
  run: () => Promise<void>,
): void {
  const missing = requirements.filter((requirement) => !requirement.present);
  if (missing.length) {
    test.skip(`${name} (missing ${missing.map((item) => item.label).join(", ")})`, run);
    return;
  }
  test(name, run, testTimeoutMs);
}

beforeAll(async () => {
  if (!existsSync(serverPath)) {
    throw new Error(
      `Missing ${serverPath}. Run this suite through "bun run test:live", which builds first.`,
    );
  }
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  client = new Client({ name: "disclosures-live-e2e", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

describe("live end-to-end MCP suite", () => {
  test("lists the exact current tool set through the built stdio server", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("has every credential when strict live mode is enabled", () => {
    if (env.LIVE_E2E_REQUIRE_ALL !== "1") return;
    const missing = allCredentials
      .filter((requirement) => !requirement.present)
      .map((requirement) => requirement.label);
    if (missing.length) {
      throw new Error(`Strict live E2E mode is missing: ${missing.join(", ")}`);
    }
  });

  test("resolves Apple's global ownership chain through live GLEIF", async () => {
    const text = await callLiveTool("OwnershipChain", { company: appleLei });
    expect(text).toMatch(/Apple Inc/i);
    expect(text).toContain(appleLei);
    expect(text).toMatch(/gleif\.org/i);
  }, testTimeoutMs);

  credentialedTest(
    "chains live SEC latest-report metadata into CompanyDocument",
    [secCredential],
    async () => {
      const filings = await callLiveTool("CompanyFilings", {
        company: "NVDA",
        jurisdiction: "US",
        mode: "latest_annual",
      });
      expect(filings).toMatch(/Latest annual report/i);
      expect(filings).toMatch(/\b10-K\b/);
      expect(filings).toMatch(/sec\.gov/i);

      const accession = markdownCell(filings, "Accession");
      expect(accession).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      const document = await callLiveTool("CompanyDocument", {
        company: "NVDA",
        jurisdiction: "US",
        transaction_id: accession,
        mode: "metadata",
      });
      expect(document).toContain(`# SEC filing:`);
      expect(document).toContain(accession);
      expect(document).toMatch(/sec\.gov\/Archives/i);
      expect(document).toContain("## Documents in this filing");
    },
  );

  credentialedTest(
    "chains live Companies House resolution and accounts into CompanyDocument",
    [companiesHouseCredential],
    async () => {
      const resolved = await callLiveTool("CompanyResolve", {
        company: "00445790",
        jurisdiction: "GB",
      });
      expect(resolved).toMatch(/TESCO PLC/i);
      expect(resolved).toContain("00445790");
      expect(resolved).toMatch(/Companies House/i);

      const filings = await callLiveTool("CompanyFilings", {
        company: "00445790",
        jurisdiction: "GB",
        mode: "latest_annual",
      });
      expect(filings).toMatch(/Latest accounts filing \(Companies House\)/i);
      const transactionId = markdownCell(filings, "Transaction");

      const document = await callLiveTool("CompanyDocument", {
        company: "00445790",
        jurisdiction: "GB",
        transaction_id: transactionId,
        mode: "metadata",
      });
      expect(document).toMatch(/Companies House document/i);
      expect(document).toContain("## Available renditions");

      const charges = await callLiveTool("CompanyCharges", {
        company: "00445790",
        status: "all",
      });
      expect(charges).toMatch(/Registered charges \(Companies House\)/i);
      expect(charges).toMatch(/company-information\.service\.gov\.uk/i);
    },
  );

  credentialedTest(
    "chains live OpenDART resolution and a recent filing into CompanyDocument",
    [openDartCredential],
    async () => {
      const resolved = await callLiveTool("CompanyResolve", {
        company: "005930",
        jurisdiction: "KR",
      });
      expect(resolved).toMatch(/OpenDART/i);
      expect(resolved).toContain("00126380");
      expect(resolved).toContain("005930");

      // Without start_date OpenDART defaults to a very recent window, which
      // is empty early in the Korean day — pin an explicit 30-day window.
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - 30);
      const filings = await callLiveTool("CompanyFilings", {
        company: "005930",
        jurisdiction: "KR",
        start_date: start.toISOString().slice(0, 10),
        end_date: new Date().toISOString().slice(0, 10),
        limit: 5,
      });
      expect(filings).toMatch(/DART filings \(OpenDART\)/i);
      const receiptNumber = filings.match(/rcpNo=(\d{14})/)?.[1];
      if (!receiptNumber) {
        throw new Error("OpenDART filing output contained no 14-digit receipt number");
      }

      const document = await callLiveTool("CompanyDocument", {
        company: "005930",
        jurisdiction: "KR",
        transaction_id: receiptNumber,
        mode: "metadata",
      });
      expect(document).toContain(`# DART document: ${receiptNumber}`);
      expect(document).toContain("## Documents in this filing");
      expect(document).toMatch(/dart\.fss\.or\.kr/i);
    },
  );

  credentialedTest(
    "queries one bounded live EDINET document-index day with the configured key",
    [edinetCredential],
    async () => {
      const resolved = await callLiveTool("CompanyResolve", {
        company: "7203",
        jurisdiction: "JP",
      });
      expect(resolved).toMatch(/EDINET/i);
      expect(resolved).toContain("E02144");

      const scanDate = previousWeekdayIso();
      const filings = await callLiveTool("CompanyFilings", {
        company: "E02144",
        jurisdiction: "JP",
        start_date: scanDate,
        end_date: scanDate,
        limit: 1,
      });
      expect(filings).toMatch(/EDINET/i);
      expect(filings).toMatch(/date-indexed/i);
    },
  );
});
