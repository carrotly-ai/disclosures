import type { FetchFn } from "./types.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: FetchFn,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(
        `HTTP ${response.status} ${response.statusText}`.trim(),
        response.status,
        url,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  return request(url, { method: "GET", headers }, timeoutMs, fetchFn).then(
    (response) => response.json(),
  );
}

export async function getText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  return request(url, { method: "GET", headers }, timeoutMs, fetchFn).then(
    (response) => response.text(),
  );
}

export async function getBinary(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<Uint8Array> {
  return request(url, { method: "GET", headers }, timeoutMs, fetchFn).then(
    async (response) => new Uint8Array(await response.arrayBuffer()),
  );
}

export async function getOptionalJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<unknown | null> {
  try {
    return await getJson(url, headers, timeoutMs, fetchFn);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
