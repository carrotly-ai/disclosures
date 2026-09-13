import { beforeEach, expect, test } from "bun:test";
import { getEsefFinancials } from "../src/adapters/xbrlFilings.js";
import { createTools } from "../src/tools/index.js";
import { COMPANY_JURISDICTIONS } from "../src/tools/shared.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";

beforeEach(resetRateLimiters);
const lei = "213800H2PQMIF3OVZY47";
const dimensions = (concept = "Revenue", unit = "iso4217:GBP") => ({
  concept: `ifrs-full:${concept}`, entity: `lei:${lei}`,
  period: "2025-01-01T00:00:00/2026-01-01T00:00:00", unit,
});
const filing = (id: string, date: string) => ({ type: "filing", id, attributes: {
  fxo_id: `${lei}-${id}`, period_end: "2025-12-31", json_url: `/${id}.json`, date_added: date,
}});

test.each([null, undefined, "", " ", true, false, "NaN", "0x10"])("ESEF rejects missing/nonnumeric values: %p", async value => {
  const facts = await getEsefFinancials(lei, ["revenue"], { fetchFn: async url => Response.json(
    url.includes("/api/filings") ? { data: [filing("a", "2026-01-01")] } :
    { facts: { missing: { value, dimensions: dimensions() } } },
  ) });
  expect(facts).toEqual([]);
});

test("ESEF preserves genuine zero and per-share units", async () => {
  const facts = await getEsefFinancials(lei, ["revenue", "eps_basic"], { fetchFn: async url => Response.json(
    url.includes("/api/filings") ? { data: [filing("a", "2026-01-01")] } : { facts: {
      zero: { value: "0", dimensions: dimensions() },
      eps: { value: "2.5", dimensions: dimensions("BasicEarningsLossPerShare", "iso4217:GBP/xbrli:shares") },
    } },
  ) });
  expect(facts.map(f => [f.concept, f.value, f.unit])).toEqual([["revenue", 0, "GBP"], ["eps_basic", 2.5, "GBP/shares"]]);
});

test.each([false, true])("ESEF amendments win within the same day regardless of list order: %p", async reverse => {
  const data = [filing("old", "2026-01-01T08:00:00Z"), filing("new", "2026-01-01T09:00:00Z")];
  if (reverse) data.reverse();
  const facts = await getEsefFinancials(lei, ["revenue"], { fetchFn: async url => Response.json(
    url.includes("/api/filings") ? { data } : { facts: { revenue: {
      value: url.endsWith("/old.json") ? "100" : "200", dimensions: dimensions(),
    } } },
  ) });
  expect(facts[0]?.value).toBe(200);
});

test.each(COMPANY_JURISDICTIONS.filter(j => j !== "US"))("PrivateRaises rejects %s without network access", async jurisdiction => {
  let calls = 0;
  const tool = createTools({ env: {}, fetchFn: async () => { calls++; throw Error("Unexpected network"); } }).find(t => t.name === "PrivateRaises")!;
  const result = await tool.handler({ company: "1", jurisdiction } as never);
  expect(calls).toBe(0);
  expect(result.content[0]?.text).toContain("unsupported");
});

test.each([403, 429, 500])("PrivateRaises reports document HTTP %s as failure, not absence", async status => {
  const tool = createTools({ env: { DISCLOSURES_USER_AGENT: "Audit audit@example.com" }, fetchFn: async url =>
    url.includes("submissions") ? Response.json({ filings: { recent: {
      form: ["D"], filingDate: ["2026-01-01"], accessionNumber: ["0000000001-26-000001"], primaryDocument: ["primary_doc.xml"],
    } } }) : new Response("Unavailable", { status }),
  }).find(t => t.name === "PrivateRaises")!;
  const result = await tool.handler({ company: "1", jurisdiction: "US" } as never);
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).not.toContain("No Form D filings found");
});
