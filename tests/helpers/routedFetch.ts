import { expect } from "bun:test";
import type { FetchFn } from "../../src/core/types.js";

export type Route = {
  pattern: string | RegExp;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
};

export interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

export function routedFetch(routes: Route[]): FetchFn & {
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const stub = (async (url: string, init?: RequestInit) => {
    requests.push(init === undefined ? { url } : { url, init });
    const route = routes.find(({ pattern }) =>
      typeof pattern === "string" ? url.includes(pattern) : pattern.test(url),
    );
    if (!route) {
      throw new Error(`Unexpected network request: ${url}`);
    }
    const status = route.status ?? 200;
    const headers = new Headers(route.headers);
    const body = route.body instanceof Uint8Array
      ? route.body
      : typeof route.body === "string"
        ? route.body
        : JSON.stringify(route.body);
    if (!headers.has("Content-Type")) {
      headers.set(
        "Content-Type",
        route.body instanceof Uint8Array
          ? "application/octet-stream"
          : typeof route.body === "string"
            ? "text/plain"
            : "application/json",
      );
    }
    return new Response(body, { status, headers });
  }) as FetchFn & { requests: RecordedRequest[] };
  stub.requests = requests;
  return stub;
}

export function expectRequested(
  fetchFn: ReturnType<typeof routedFetch>,
  pattern: string,
): void {
  expect(fetchFn.requests.some(({ url }) => url.includes(pattern))).toBe(true);
}
