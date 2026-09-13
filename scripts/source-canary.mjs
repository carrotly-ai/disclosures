import {
  createTools,
  getBoundedBinaryFollowingRedirects,
} from "../dist/server.mjs";
import { appendFile, writeFile } from "node:fs/promises";

// Small, keyless resolution contracts. Restricted sources and credentials are excluded.
const cases = [
  {
    source: "GLEIF",
    company: "HWUPKR0MPOU8FGXBT394",
    key: "lei",
    expected: "HWUPKR0MPOU8FGXBT394",
  },
  {
    source: "filings.xbrl.org",
    company: "213800H2PQMIF3OVZY47",
    jurisdiction: "EU",
    key: "lei",
    expected: "213800H2PQMIF3OVZY47",
  },
  {
    source: "HKEXnews",
    company: "00700",
    jurisdiction: "HK",
    key: "stockCode",
    expected: "00700",
  },
  {
    source: "TWSE",
    company: "2330",
    jurisdiction: "TW",
    key: "stockCode",
    expected: "2330",
  },
];
const results = [];
for (const entry of cases) {
  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 60000);
  let requests = 0,
    bytes = 0;
  const errors = [];
  const fetchFn = async (url, init) => {
    if (deadline.signal.aborted) throw Error("Source deadline exceeded");
    if (init?.method && init.method !== "GET")
      throw Error("Canary permits GET requests only");
    try {
      const result = await getBoundedBinaryFollowingRedirects(
        url,
        8 * 1024 * 1024 - bytes,
        {
          headers: Object.fromEntries(new Headers(init?.headers)),
          timeoutMs: 20000,
          fetchFn: async (target, request) => {
            if (++requests > 6) throw Error("Source request budget exceeded");
            const abort = () => controller.abort();
            const controller = new AbortController();
            deadline.signal.addEventListener("abort", abort, { once: true });
            request.signal.addEventListener("abort", abort, { once: true });
            if (deadline.signal.aborted || request.signal.aborted)
              controller.abort();
            // Cleanup on the source deadline; only six requests can be outstanding.
            return fetch(target, { ...request, signal: controller.signal });
          },
        },
      );
      bytes += result.bytes.byteLength;
      return new Response(result.bytes, { headers: result.headers });
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error.message}`);
      throw error;
    }
  };
  try {
    const tool = createTools({ env: {}, fetchFn }).find(
      (tool) => tool.name === "CompanyResolve",
    );
    const result = await tool.handler({
      company: entry.company,
      ...(entry.jurisdiction ? { jurisdiction: entry.jurisdiction } : {}),
    });
    const candidates = result.structuredContent?.candidates ?? [];
    const matched = candidates.some(
      (candidate) =>
        candidate[entry.key] === entry.expected &&
        candidate.source === entry.source,
    );
    if (result.isError || !matched || errors.length)
      throw Error(
        errors.join("; ") ||
          "Resolution contract failed: expected identifier/source absent",
      );
    results.push({
      source: entry.source,
      status: "healthy",
      requests,
      bytes,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    results.push({
      source: entry.source,
      status: "degraded",
      requests,
      bytes,
      durationMs: Date.now() - started,
      error: error.message,
    });
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
const report = { checkedAt: new Date().toISOString(), results };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--report"))
  await writeFile("source-canary.json", JSON.stringify(report, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    "## Source canary\n\n| Source | Status | Requests | Duration |\n|---|---|---:|---:|\n" +
      results
        .map(
          (r) =>
            `| ${r.source} | ${r.status} | ${r.requests} | ${r.durationMs} ms |`,
        )
        .join("\n") +
      "\n",
  );
if (results.some((result) => result.status !== "healthy")) process.exitCode = 1;
