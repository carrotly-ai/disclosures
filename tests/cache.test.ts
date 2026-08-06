import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCache,
  InMemoryCache,
  readCachedJson,
  writeCachedJson,
} from "../src/core/cache.js";
import {
  OPEN_DART_CORP_CODE_CACHE_KEY,
  resetOpenDartCorpCodeCache,
  resolveOpenDartCorpCode,
} from "../src/adapters/openDart.js";
import { resetEdinetCodeCache, resolveEdinetCode } from "../src/adapters/edinet.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import type { AdapterOptions, Env } from "../src/core/types.js";
import { routedFetch } from "./helpers/routedFetch.js";
import { makeStoredZip } from "./helpers/zipFixture.js";
import { edinetCodeListRoute } from "./helpers/edinetFixture.js";

// A controllable clock so TTL behaviour is deterministic.
function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("InMemoryCache", () => {
  test("round-trips a value and reports misses as undefined", () => {
    const cache = new InMemoryCache();
    expect(cache.get("absent")).toBeUndefined();
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  test("expires entries once the TTL elapses", () => {
    const time = clock();
    const cache = new InMemoryCache(time.now);
    cache.set("k", "v", 1_000);
    time.advance(999);
    expect(cache.get("k")).toBe("v");
    time.advance(1);
    expect(cache.get("k")).toBeUndefined();
  });

  test("a missing TTL never expires", () => {
    const time = clock();
    const cache = new InMemoryCache(time.now);
    cache.set("k", "v");
    time.advance(10 * 365 * 24 * 60 * 60_000);
    expect(cache.get("k")).toBe("v");
  });

  test("delete and clear remove entries", () => {
    const cache = new InMemoryCache();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("FileCache", () => {
  let dir: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "disclosures-cache-"));
    dirs.push(dir);
  });

  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("round-trips a value across instances (persists to disk)", async () => {
    const write = new FileCache(dir);
    await write.set("k", "hello");
    const read = new FileCache(dir);
    expect(await read.get("k")).toBe("hello");
  });

  test("reports a missing key as undefined", async () => {
    const cache = new FileCache(dir);
    expect(await cache.get("never-written")).toBeUndefined();
  });

  test("expires entries once the TTL elapses", async () => {
    const time = clock();
    const cache = new FileCache(dir, time.now);
    await cache.set("k", "v", 1_000);
    time.advance(1_001);
    expect(await cache.get("k")).toBeUndefined();
  });

  test("overwrites an existing key", async () => {
    const cache = new FileCache(dir);
    await cache.set("k", "first");
    await cache.set("k", "second");
    expect(await cache.get("k")).toBe("second");
  });

  test("treats a corrupt entry file as a miss", async () => {
    const cache = new FileCache(dir);
    await cache.set("k", "v");
    // Corrupt the on-disk envelope; sha256 of the key names the file.
    const { createHash } = await import("node:crypto");
    const name = createHash("sha256").update("k").digest("hex");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${name}.json`), "{ not json", "utf8");
    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("readCachedJson / writeCachedJson", () => {
  test("round-trips a validated JSON value", async () => {
    const cache = new InMemoryCache();
    await writeCachedJson(cache, "k", { a: 1, b: ["x"] });
    const value = await readCachedJson(cache, "k", (v) => v as { a: number });
    expect(value).toEqual({ a: 1, b: ["x"] } as never);
  });

  test("a rejecting validator yields a miss", async () => {
    const cache = new InMemoryCache();
    await writeCachedJson(cache, "k", { a: 1 });
    const value = await readCachedJson(cache, "k", () => undefined);
    expect(value).toBeUndefined();
  });

  test("a validator that throws yields a miss, not a throw", async () => {
    const cache = new InMemoryCache();
    await writeCachedJson(cache, "k", { a: 1 });
    const value = await readCachedJson(cache, "k", () => {
      throw new Error("bad shape");
    });
    expect(value).toBeUndefined();
  });

  test("malformed cached JSON yields a miss", async () => {
    const cache = new InMemoryCache();
    cache.set("k", "{ not json");
    const value = await readCachedJson(cache, "k", (v) => v);
    expect(value).toBeUndefined();
  });
});

// --- Adapter wire-through: an injected cache survives a cold process start ----

const CORP_CODE = "00126380";
const CORP_CODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>${CORP_CODE}</corp_code>
    <corp_name>삼성전자</corp_name>
    <corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name>
    <stock_code>005930</stock_code>
    <modify_date>20230101</modify_date>
  </list>
</result>`;

function corpCodeRoute() {
  return { pattern: "corpCode.xml", body: makeStoredZip("CORPCODE.xml", CORP_CODE_XML) };
}

const OPEN_DART_ENV: Env = { OPENDART_API_KEY: "test-api-key" };
const EDINET_ENV: Env = { EDINET_API_KEY: "test-edinet-key" };

describe("cache wire-through", () => {
  beforeEach(() => {
    resetRateLimiters();
    resetOpenDartCorpCodeCache();
    resetEdinetCodeCache();
  });

  test("OpenDART corp-code resolution is served from an injected cache after a cold restart", async () => {
    const cache = new InMemoryCache();

    // First (cold) process: fetch populates the cache.
    const warm = routedFetch([corpCodeRoute()]);
    const options1: AdapterOptions = { fetchFn: warm, env: OPEN_DART_ENV, cache };
    expect(await resolveOpenDartCorpCode("삼성전자", options1)).toBe(CORP_CODE);
    expect(warm.requests.some((r) => r.url.includes("corpCode.xml"))).toBe(true);
    expect(await cache.get(OPEN_DART_CORP_CODE_CACHE_KEY)).toBeDefined();

    // Simulate a fresh process: clear the per-process memo. A second fetchFn
    // with NO corpCode.xml route would throw if the archive were refetched.
    resetOpenDartCorpCodeCache();
    const cold = routedFetch([]);
    const options2: AdapterOptions = { fetchFn: cold, env: OPEN_DART_ENV, cache };
    expect(await resolveOpenDartCorpCode("삼성전자", options2)).toBe(CORP_CODE);
    expect(cold.requests.length).toBe(0);
  });

  test("EDINET code resolution is served from an injected cache after a cold restart", async () => {
    const cache = new InMemoryCache();

    const warm = routedFetch([edinetCodeListRoute]);
    const options1: AdapterOptions = { fetchFn: warm, env: EDINET_ENV, cache };
    expect(await resolveEdinetCode("E02144", options1)).toBe("E02144");
    expect(warm.requests.some((r) => r.url.includes("Edinetcode"))).toBe(true);

    resetEdinetCodeCache();
    const cold = routedFetch([]);
    const options2: AdapterOptions = { fetchFn: cold, env: EDINET_ENV, cache };
    expect(await resolveEdinetCode("E02144", options2)).toBe("E02144");
    expect(cold.requests.length).toBe(0);
  });

  test("without a cache, a cold restart must refetch the reference archive", async () => {
    // Proves the cache is what carries the data across restarts, not some other
    // hidden persistence: a cold process with no route rejects.
    const warm = routedFetch([corpCodeRoute()]);
    expect(
      await resolveOpenDartCorpCode("삼성전자", { fetchFn: warm, env: OPEN_DART_ENV }),
    ).toBe(CORP_CODE);
    resetOpenDartCorpCodeCache();
    const cold = routedFetch([]);
    await expect(
      resolveOpenDartCorpCode("삼성전자", { fetchFn: cold, env: OPEN_DART_ENV }),
    ).rejects.toThrow(/Unexpected network request/);
  });
});
