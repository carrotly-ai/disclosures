import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getText,
  getBinary,
  getJson,
  getFollowingRedirects,
  postForm,
  postJson,
  ResponseSizeLimitError,
} from "../src/core/http.js";
import { saveDocument } from "../src/core/documents.js";
import {
  CachedLoader,
  FileCache,
  InMemoryCache,
  readCachedJson,
  writeCachedJson,
} from "../src/core/cache.js";
import {
  searchOpenDartCompanies,
  resetOpenDartCorpCodeCache,
} from "../src/adapters/openDart.js";
import { makeStoredZip } from "./helpers/zipFixture.js";
import { resetRateLimiters } from "../src/core/rateLimiter.js";
import { getHkexDocumentPdf } from "../src/adapters/hkexNews.js";
import type { FetchFn } from "../src/core/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "disclosures-hardening-"));
  resetRateLimiters();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const timeoutReaders: Array<[string, (fetchFn: FetchFn) => Promise<unknown>]> =
  [
    ["text", (f) => getText("https://example.test/", {}, 20, f)],
    ["JSON", (f) => getJson("https://example.test/", {}, 20, f)],
    ["binary", (f) => getBinary("https://example.test/", {}, 20, f)],
    [
      "redirect response",
      async (f) =>
        (
          await getFollowingRedirects("https://example.test/", {}, 20, f)
        ).response.text(),
    ],
    ["form", (f) => postForm("https://example.test/", {}, {}, 20, f)],
    ["POST JSON", (f) => postJson("https://example.test/", {}, {}, 20, f)],
  ];
for (const [name, consume] of timeoutReaders)
  test(`${name} cancels a stalled body at its deadline`, async () => {
    let cancelled = false;
    const fetchFn: FetchFn = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    await expect(consume(fetchFn)).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });

test("an injected fetch that ignores AbortSignal still times out", async () => {
  await expect(
    getText("https://example.test/", {}, 20, () => new Promise(() => {})),
  ).rejects.toThrow("timed out");
});

test("streaming cap cancels rather than draining the entire response", async () => {
  let reads = 0,
    cancelled = false;
  const fetchFn: FetchFn = async () =>
    new Response(
      new ReadableStream(
        {
          pull(c) {
            reads++;
            c.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  await expect(
    getBinary("https://example.test/", {}, 1000, fetchFn, 5),
  ).rejects.toBeInstanceOf(ResponseSizeLimitError);
  expect(reads).toBe(2);
  expect(cancelled).toBe(true);
});

test("HKEX enforces the download cap while reading an undeclared body", async () => {
  let reads = 0,
    cancelled = false;
  await expect(
    getHkexDocumentPdf("/listedco/listconews/test.pdf", {
      fetchFn: async () =>
        new Response(
          new ReadableStream(
            {
              pull(c) {
                reads++;
                c.enqueue(new Uint8Array(1024 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    }),
  ).rejects.toThrow("download cap");
  expect(reads).toBe(26);
  expect(cancelled).toBe(true);
});

test("PDF writes preserve existing files and symlink targets", async () => {
  const target = join(dir, "existing.pdf");
  await writeFile(target, "original");
  const link = join(dir, "link.pdf");
  await symlink(target, link);
  for (const path of [target, link])
    await expect(
      saveDocument(new Uint8Array([1]), "file.pdf", path),
    ).rejects.toThrow("EEXIST");
  expect(await readFile(target, "utf8")).toBe("original");
});

test("generated downloads are unique and hostile suggested filenames stay confined", async () => {
  const a = await saveDocument(
    new Uint8Array([1]),
    "../../file.pdf",
    undefined,
    dir,
  );
  const b = await saveDocument(
    new Uint8Array([2]),
    "../../file.pdf",
    undefined,
    dir,
  );
  expect(a).not.toBe(b);
  expect(a.startsWith(dir + "/")).toBe(true);
  expect(b.startsWith(dir + "/")).toBe(true);
  for (const path of [
    "../escape.pdf",
    "/tmp/escape.pdf",
    "nested/escape.pdf",
    "..\\escape.pdf",
  ])
    await expect(
      saveDocument(new Uint8Array([1]), "file.pdf", path, dir),
    ).rejects.toThrow("filename only");
});

test("concurrent cache writes publish complete envelopes", async () => {
  const cache = new FileCache(dir);
  const values = Array.from({ length: 20 }, (_, i) => String(i).repeat(10000));
  await Promise.all(values.map((v) => cache.set("key", v)));
  expect(values).toContain(await cache.get("key"));
});

test("unavailable cache backends do not break lookups", async () => {
  const cache = {
    get() {
      throw Error("unavailable");
    },
    set() {
      throw Error("unavailable");
    },
  };
  expect(await readCachedJson(cache, "key", (v) => v)).toBeUndefined();
  await writeCachedJson(cache, "key", { ok: true });
  const blocker = join(dir, "not-a-directory");
  await writeFile(blocker, "x");
  await new FileCache(blocker).set("key", "value");
  expect(await new FileCache(blocker).get("key")).toBeUndefined();
});

test("cached loaders share in-flight work and retry rejected loads", async () => {
  const loader = new CachedLoader<number>();
  const validate = (v: unknown) => (typeof v === "number" ? v : undefined);
  let calls = 0;
  const fetchValue = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return 42;
  };
  expect(
    await Promise.all(
      Array.from({ length: 8 }, () =>
        loader.load("key", 1000, validate, fetchValue),
      ),
    ),
  ).toEqual(Array(8).fill(42));
  expect(calls).toBe(1);
  await expect(
    loader.load("failed", 1000, validate, async () => {
      throw Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(await loader.load("failed", 1000, validate, fetchValue)).toBe(42);
});

test("OpenDART refetches when the supplied cache expires", async () => {
  resetOpenDartCorpCodeCache();
  let now = 0,
    downloads = 0;
  const cache = new InMemoryCache(() => now);
  const options = {
    cache,
    env: { OPENDART_API_KEY: "test" },
    fetchFn: async () => {
      downloads++;
      return new Response(
        makeStoredZip(
          "CORPCODE.xml",
          `<result><list><corp_code>00126380</corp_code><corp_name>${downloads === 1 ? "Old" : "New"}</corp_name><stock_code>005930</stock_code></list></result>`,
        ),
      );
    },
  };
  expect((await searchOpenDartCompanies("005930", options))[0]?.legalName).toBe(
    "Old",
  );
  now += 48 * 3600 * 1000;
  expect((await searchOpenDartCompanies("005930", options))[0]?.legalName).toBe(
    "New",
  );
  expect(downloads).toBe(2);
});

test("timeout messages do not expose query credentials", async () => {
  const error = await getText(
    "https://example.test/?api_key=private-value",
    {},
    10,
    async () => new Response(new ReadableStream()),
  ).catch((error) => error);
  expect(error.message).toContain("timed out");
  expect(error.message).not.toContain("private-value");
});

test("default process caches expire fulfilled values", async () => {
  const loader = new CachedLoader<number>();
  let calls = 0;
  const load = () =>
    loader.load(
      "key",
      5,
      (value) => (typeof value === "number" ? value : undefined),
      async () => ++calls,
    );
  expect(await load()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await load()).toBe(2);
});
