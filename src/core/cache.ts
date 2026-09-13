import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A minimal string key/value cache with optional per-entry TTL. Adapters use it
 * to avoid refetching large, slow-changing reference downloads (the OpenDART
 * corp-code archive, the EDINET code list) on every process start.
 *
 * The interface is deliberately tiny so a consumer can supply any backend —
 * Redis, a KV store, the filesystem — by implementing two methods. `get`/`set`
 * may be synchronous or asynchronous; callers always `await` the result.
 */
export interface DisclosuresCache {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string, ttlMs?: number): Promise<void> | void;
}

interface InMemoryEntry {
  value: string;
  /** Absolute expiry timestamp in ms, or undefined for no expiry. */
  expiresAt: number | undefined;
}

/**
 * Process-local cache backed by a Map. This is the default when a consumer
 * enables caching without supplying their own backend; it survives repeated
 * calls within one process but not across restarts (use {@link FileCache} for
 * that). `now` is injectable so TTL behaviour is deterministic under test.
 */
export class InMemoryCache implements DisclosuresCache {
  private readonly store = new Map<string, InMemoryEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): string | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs === undefined ? undefined : this.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

interface FileEntryEnvelope {
  key: string;
  value: string;
  /** Absolute expiry timestamp in ms, or null for no expiry. */
  expiresAt: number | null;
}

/**
 * Filesystem-backed cache: one JSON file per key under `dir`, named by the
 * SHA-256 of the key (so arbitrary keys map to safe filenames and cannot
 * traverse out of the directory). Suitable for the common MCP deployment where
 * each request spawns a fresh process — the corp-code/code-list downloads then
 * persist across restarts. Errors (missing dir, unreadable/corrupt file) are
 * treated as a cache miss rather than surfaced, so a broken cache never breaks
 * a lookup.
 */
export class FileCache implements DisclosuresCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private pathFor(key: string): string {
    const name = createHash("sha256").update(key).digest("hex");
    return join(this.dir, `${name}.json`);
  }

  async get(key: string): Promise<string | undefined> {
    const path = this.pathFor(key);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    let parsed: FileEntryEnvelope;
    try {
      parsed = JSON.parse(raw) as FileEntryEnvelope;
    } catch {
      return undefined;
    }
    if (
      parsed?.key !== key ||
      typeof parsed.value !== "string" ||
      (parsed.expiresAt !== null && !Number.isFinite(parsed.expiresAt))
    )
      return undefined;
    if (parsed.expiresAt !== null && this.now() >= parsed.expiresAt) {
      return undefined;
    }
    return parsed.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const temporary = join(this.dir, `.cache-${randomUUID()}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const envelope: FileEntryEnvelope = {
        key,
        value,
        expiresAt: ttlMs === undefined ? null : this.now() + ttlMs,
      };
      await writeFile(temporary, JSON.stringify(envelope), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.pathFor(key));
    } catch {
      // Cache availability must not affect the source lookup.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

/**
 * Read a JSON value from the cache and validate it before returning. A missing
 * key, malformed JSON, or a value the validator rejects all resolve to
 * `undefined` (a cache miss) — never a throw — so a stale or corrupt entry
 * simply triggers a refetch.
 */
export async function readCachedJson<T>(
  cache: DisclosuresCache,
  key: string,
  validate: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  let raw: string | undefined;
  try {
    raw = await cache.get(key);
  } catch {
    return undefined;
  }
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  try {
    return validate(parsed);
  } catch {
    return undefined;
  }
}

/** Serialize a JSON value into the cache under `key` with an optional TTL. */
export async function writeCachedJson(
  cache: DisclosuresCache,
  key: string,
  value: unknown,
  ttlMs?: number,
): Promise<void> {
  try {
    await cache.set(key, JSON.stringify(value), ttlMs);
  } catch {
    /* best-effort cache */
  }
}

/** A single TTL-bearing cache layer, with in-flight work shared per backend. */
export class CachedLoader<T> {
  private readonly memory = new InMemoryCache();
  private pending = new WeakMap<DisclosuresCache, Map<string, Promise<T>>>();

  clear(): void {
    this.memory.clear();
    this.pending = new WeakMap();
  }

  async load(
    key: string,
    ttlMs: number,
    validate: (value: unknown) => T | undefined,
    fetchValue: () => Promise<T>,
    cache: DisclosuresCache = this.memory,
  ): Promise<T> {
    const cached = await readCachedJson(cache, key, validate);
    if (cached !== undefined) return cached;
    let pending = this.pending.get(cache);
    if (!pending) {
      pending = new Map();
      this.pending.set(cache, pending);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const value = await fetchValue();
      await writeCachedJson(cache, key, value, ttlMs);
      return value;
    })();
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      if (pending.get(key) === promise) pending.delete(key);
    }
  }
}
