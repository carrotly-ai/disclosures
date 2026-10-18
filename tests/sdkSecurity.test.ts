import { describe, expect, test } from "bun:test";
import { fetchToken, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const issuer = "https://auth.fixture.example";

function fictionalProvider(): OAuthClientProvider {
  return {
    redirectUrl: undefined,
    clientMetadata: { redirect_uris: [], grant_types: ["client_credentials"] },
    clientInformation: () => ({
      client_id: "fictional-client",
      client_secret: "fictional-secret",
      issuer,
    }),
    tokens: () => undefined,
    saveTokens: () => {},
    redirectToAuthorization: () => { throw new Error("Interactive authorization forbidden"); },
    saveCodeVerifier: () => {},
    codeVerifier: () => { throw new Error("PKCE forbidden in this fixture"); },
    prepareTokenRequest: () => new URLSearchParams({ grant_type: "client_credentials" }),
  };
}

describe("SDK OAuth issuer isolation", () => {
  for (const target of [issuer, "https://untrusted.fixture.example"]) {
    test(`sends fictional client credentials only to their issuer: ${target}`, async () => {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const request = fetchToken(fictionalProvider(), new URL(target), {
        metadata: {
          issuer: target,
          authorization_endpoint: `${target}/authorize`,
          token_endpoint: `${target}/token`,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
        fetchFn: async (url, init) => {
          requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
          return Response.json({ access_token: "fictional-token", token_type: "Bearer" });
        },
      });
      if (target === issuer) {
        expect(await request).toMatchObject({ access_token: "fictional-token" });
        expect(requests).toEqual([{
          url: `${issuer}/token`,
          authorization: `Basic ${btoa("fictional-client:fictional-secret")}`,
        }]);
      } else {
        await expect(request).rejects.toThrow(/issuer/i);
        expect(requests).toHaveLength(0);
      }
    });
  }
});
