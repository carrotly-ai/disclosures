import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
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

// --- Lenient node:https GET for hosts with malformed response headers -------
//
// Some upstreams emit response headers that Node's default HTTP/1.1 parser
// (and undici's global `fetch`) reject outright with "Invalid header value
// char", making the page unreadable through `fetch` even though `curl` tolerates
// it. The concrete case (issue #42) is Germany's BaFin portal, whose web server
// emits an obsolete RFC 7230 line-folded (obs-fold) `Permissions-Policy`
// response header. `curl` reads it fine; `fetch` cannot.
//
// The fix is a raw `node:https`/`node:http` request with the documented
// `insecureHTTPParser: true` escape hatch, which relaxes the parser enough to
// accept obs-fold / invalid-char headers. This lenient parser is deliberately
// NOT the default path for any other host: it is gated behind an explicit
// allowlist so a malformed-header tolerance can never silently apply elsewhere.
const LENIENT_HOST_ALLOWLIST = new Set(["portal.mvp.bafin.de"]);

/** Whether `url`'s host is on the malformed-header allowlist (see #42). */
export function isLenientHost(url: string): boolean {
  try {
    return LENIENT_HOST_ALLOWLIST.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const MAX_LENIENT_REDIRECTS = 5;

interface LenientResponse {
  status: number;
  statusMessage: string;
  location?: string;
  contentType?: string;
  body: Buffer;
}

function lenientGetOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<LenientResponse> {
  const transport = new URL(url).protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise<LenientResponse>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = transport(
      url,
      {
        method: "GET",
        headers,
        // BaFin (allowlisted above) folds its Permissions-Policy header across
        // lines (RFC 7230 obs-fold); insecureHTTPParser is Node's documented
        // opt-in to parse such otherwise-rejected headers leniently. See #42.
        insecureHTTPParser: true,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const location = res.headers.location;
          const contentType = res.headers["content-type"];
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              statusMessage: res.statusMessage ?? "",
              ...(typeof location === "string" ? { location } : {}),
              ...(typeof contentType === "string" ? { contentType } : {}),
              body: Buffer.concat(chunks),
            }),
          );
        });
        res.on("error", (error) => settle(() => reject(error)));
      },
    );
    const timer = setTimeout(() => {
      settle(() => {
        req.destroy();
        reject(new HttpError(`Request to ${url} timed out after ${timeoutMs}ms`, undefined, url));
      });
    }, timeoutMs);
    req.on("error", (error) => settle(() => reject(error)));
    req.end();
  });
}

/** Decode a response body the way `fetch(...).text()` would: honour the
 * Content-Type charset if present, otherwise default to UTF-8 (BaFin serves
 * UTF-8 with no charset parameter, so this matches the previous fetch path). */
function decodeLenientBody(body: Buffer, contentType?: string): string {
  const charset = contentType?.match(/charset\s*=\s*"?([^";]+)/i)?.[1]?.trim().toLowerCase();
  const label = charset && charset !== "utf8" ? charset : "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * GET text over a raw `node:https`/`node:http` request with a lenient HTTP
 * parser (`insecureHTTPParser`). Mirrors `getText`'s contract — same timeout
 * semantics and `HttpError` on non-2xx — and follows a small budget of
 * same-origin redirects (a cross-origin hop is refused so a redirect can never
 * carry the lenient parser off the intended host).
 *
 * This is the ungated engine; it does NOT check the host allowlist and must not
 * be wired into any adapter directly. Production callers go through
 * `getTextLenient`, which enforces `isLenientHost` first. It is exported only so
 * the offline suite can exercise the real node path (non-2xx, timeout, decode)
 * against a local server, since the obs-fold behaviour cannot be reproduced
 * through the injected fetch stub.
 */
export async function performLenientGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
  maxRedirects = MAX_LENIENT_REDIRECTS,
): Promise<string> {
  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await lenientGetOnce(currentUrl, headers, timeoutMs);
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.location) {
        throw new HttpError(
          `HTTP ${response.status} redirect without Location`,
          response.status,
          currentUrl,
        );
      }
      const nextUrl = new URL(response.location, currentUrl).toString();
      if (!sameOrigin(currentUrl, nextUrl)) {
        throw new HttpError(
          `Lenient HTTP path refused a cross-origin redirect to ${nextUrl}`,
          response.status,
          currentUrl,
        );
      }
      currentUrl = nextUrl;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(
        `HTTP ${response.status} ${response.statusMessage}`.trim(),
        response.status,
        currentUrl,
      );
    }
    return decodeLenientBody(response.body, response.contentType);
  }
  throw new HttpError(`Too many redirects (>${maxRedirects})`, undefined, currentUrl);
}

/**
 * Gated entry point for the lenient HTTP path: reads text over the raw
 * node:https engine above, but ONLY for hosts on `LENIENT_HOST_ALLOWLIST`
 * (see #42). Any other host throws before a socket is opened, so this lenient
 * parser can never silently become a general-purpose fetch path.
 */
export async function getTextLenient(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<string> {
  if (!isLenientHost(url)) {
    throw new HttpError(
      `Lenient HTTP path refused for non-allowlisted host: ${url}`,
      undefined,
      url,
    );
  }
  return performLenientGet(url, headers, timeoutMs);
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
