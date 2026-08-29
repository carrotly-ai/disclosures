import { beforeEach, describe, expect, test } from "bun:test";
import { createTools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/core/toolDefs.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { DBD_GDX_NAME_SEARCH_URL } from "../src/adapters/dbdThailand.js";
import { JURISDICTION_REFERENCE } from "../src/core/jurisdictionReference.js";
import type { ToolResult } from "../src/core/types.js";
import { loadFixture } from "./helpers/loadFixture.js";
import { routedFetch } from "./helpers/routedFetch.js";

const PTT = JSON.parse(loadFixture("dbd", "juristic-0107544000108.json"));
const CP_ALL = JSON.parse(loadFixture("dbd", "juristic-0107542000011.json"));
const NO_DATA = JSON.parse(loadFixture("dbd", "juristic-no-data.json"));

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

beforeEach(() => {
  resetRateLimiters();
});

describe("TH tool dispatch", () => {
  test("CompanyResolve TH resolves by juristic number with a full register profile", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000108", body: PTT },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "0107544000108",
      jurisdiction: "TH",
    } as never);
    const text = resultText(result);
    expect(text).toContain("DBD");
    expect(text).toContain("PTT PUBLIC COMPANY LIMITED");
    // Thai text survives the Markdown rendering intact.
    expect(text).toContain("บริษัท ปตท. จำกัด (มหาชน)");
    expect(text).toContain("ยังดำเนินกิจการอยู่");
    expect(text).toContain("THB 28,562,996,250");
    expect(text).toContain("71209");
    expect(text).toContain("2001-10-01");
    // Resolve-only is stated honestly rather than pointing at a dead end.
    expect(text).toContain("resolve-only");
    const structured = result.structuredContent as {
      candidates: Array<{ juristicId?: string; jurisdiction?: string }>;
    };
    expect(structured.candidates[0]?.juristicId).toBe("0107544000108");
    expect(structured.candidates[0]?.jurisdiction).toBe("TH");
  });

  test("CompanyResolve TH resolves a name search when DBD_API_KEY is set", async () => {
    const fetchFn = routedFetch([
      {
        pattern: DBD_GDX_NAME_SEARCH_URL,
        body: { ResultList: [{ JuristicID: "0107542000011" }] },
      },
      { pattern: "juristic_person/0107542000011", body: CP_ALL },
    ]);
    const tools = createTools({ fetchFn, env: { DBD_API_KEY: "test-gdx-key" } });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "CP ALL PUBLIC COMPANY LIMITED",
      jurisdiction: "TH",
    } as never);
    const text = resultText(result);
    expect(text).toContain("CP ALL PUBLIC COMPANY LIMITED");
    expect(text).toContain("บริษัท ซีพี ออลล์ จำกัด (มหาชน)");
    expect(result.isError).toBeUndefined();
  });

  test("CompanyResolve TH names DBD_API_KEY when a name search has no key", async () => {
    const fetchFn = routedFetch([]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "PTT PUBLIC COMPANY LIMITED",
      jurisdiction: "TH",
    } as never);
    const text = resultText(result);
    expect(text).toContain("DBD_API_KEY");
    // The message points at the keyless escape hatch too.
    expect(text).toContain("13-digit");
    expect(result.isError).toBe(true);
    expect(fetchFn.requests).toHaveLength(0);
  });

  test("CompanyResolve TH reports an unmatched juristic number honestly", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000999", body: NO_DATA },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "0107544000999",
      jurisdiction: "TH",
    } as never);
    const text = resultText(result);
    expect(text).toContain("Could not find");
    expect(text).toContain("0107544000999");
    expect(result.isError).toBeUndefined();
  });

  test("CompanyResolve TH surfaces an upstream failure as an error", async () => {
    const fetchFn = routedFetch([
      { pattern: "juristic_person/0107544000108", body: "boom", status: 500 },
    ]);
    const tools = createTools({ fetchFn, env: {} });
    const result = await toolByName(tools, "CompanyResolve").handler({
      company: "0107544000108",
      jurisdiction: "TH",
    } as never);
    expect(result.isError).toBe(true);
  });
});

describe("TH honest-unsupported intents", () => {
  const cases: Array<[string, string[]]> = [
    ["CompanyFilings", ["Incapsula", "idisc"]],
    ["CompanyInsiders", ["GDX"]],
    ["CompanyOwners", ["shareholder"]],
    ["CompanyFinancials", ["financial statements"]],
    ["PrivateRaises", ["DBD (Thailand)"]],
  ];

  for (const [tool, fragments] of cases) {
    test(`${tool} TH explains Thailand's actual wall, without an error flag`, async () => {
      const tools = createTools({ fetchFn: routedFetch([]), env: {} });
      const result = await toolByName(tools, tool).handler({
        company: "PTT PUBLIC COMPANY LIMITED",
        jurisdiction: "TH",
      } as never);
      const text = resultText(result);
      expect(text).toContain(`unsupported for jurisdiction "TH"`);
      for (const fragment of fragments) expect(text).toContain(fragment);
      expect(result.isError).toBeUndefined();
    });
  }
});

describe("TH jurisdiction reference card", () => {
  test("documents the keyless by-id path and the key-gated name search", () => {
    const card = JURISDICTION_REFERENCE.find((entry) => entry.code === "TH");
    expect(card?.name).toBe("Thailand");
    expect(card?.source).toContain("DBD");
    expect(card?.credential).toContain("DBD_API_KEY");
    expect(card?.credential).toContain("keyless");
    expect(card?.identifiers).toContain("13-digit");
    expect(card?.intents).toContain("CompanyResolve only");
    expect(card?.caveat).toContain("Incapsula");
  });
});
