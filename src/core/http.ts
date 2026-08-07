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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function stripAuthorization(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== "authorization",
    ),
  );
}

export interface RedirectResult {
  response: Response;
  finalUrl: string;
}

/**
 * GET a URL while manually following redirects, so we control header
 * forwarding across hops. Companies House document content endpoints 302 to a
 * pre-signed S3 URL that REJECTS a forwarded `Authorization` header, so we
 * strip credentials on any cross-origin hop. Returns the final (non-redirect)
 * response together with the URL it came from. Throws `HttpError` on a non-2xx
 * final response or if the redirect budget is exhausted.
 */
export async function getFollowingRedirects(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
  maxRedirects = 5,
): Promise<RedirectResult> {
  let currentUrl = url;
  let currentHeaders = headers;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(currentUrl, {
        method: "GET",
        headers: currentHeaders,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(
          `HTTP ${response.status} redirect without Location`,
          response.status,
          currentUrl,
        );
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (!sameOrigin(currentUrl, nextUrl)) {
        currentHeaders = stripAuthorization(currentHeaders);
      }
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) {
      throw new HttpError(
        `HTTP ${response.status} ${response.statusText}`.trim(),
        response.status,
        currentUrl,
      );
    }
    return { response, finalUrl: currentUrl };
  }
  throw new HttpError(
    `Too many redirects (>${maxRedirects})`,
    undefined,
    currentUrl,
  );
}

/**
 * POST a form-url-encoded body and parse the JSON response. Some Asian
 * disclosure portals (e.g. cninfo) only expose POST form endpoints, so this
 * mirrors the GET helpers with the same timeout/error contract.
 */
export async function postForm(
  url: string,
  form: Record<string, string | number | undefined>,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined && value !== "") body.set(key, String(value));
  }
  return request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...headers,
      },
      body: body.toString(),
    },
    timeoutMs,
    fetchFn,
  ).then((response) => response.json());
}

/**
 * POST a JSON body and parse the JSON response. Some disclosure portals expose
 * an undocumented Elasticsearch-style search proxy that only accepts a JSON
 * POST (e.g. the FCA National Storage Mechanism), so this mirrors the GET
 * helpers with the same timeout/error contract.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    timeoutMs,
    fetchFn,
  ).then((response) => response.json());
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
