import { describe, expect, test } from "bun:test";
import {
  createNotionOAuthProvider,
  NOTION_TOKEN_ENDPOINT,
  refreshNotionToken,
} from "./notion-oauth-broker";

const CLIENT_ID = "notion-client-id";
const CLIENT_SECRET = "notion-client-secret";
const REFRESH = "notion-refresh-token";

function credential(authMethod: string) {
  return {
    refresh: REFRESH,
    access: "old-access-token",
    expires: Date.now() - 1,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    token_endpoint_auth_method: authMethod,
    email: "ada@example.com",
    accountId: "notion-account",
    identity_key: "identity:ada@example.com",
    client_metadata: { registration_id: "registration-1" },
  } as never;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response(body, status);
  };
  return { calls, fetchImpl };
}

function formBody(call: { init: RequestInit }): URLSearchParams {
  return new URLSearchParams(String(call.init.body));
}

describe("Notion auth-broker OAuth provider", () => {
  test("factory registers the expected id and refuses interactive broker login", async () => {
    const provider = createNotionOAuthProvider();
    expect(provider.id).toBe("notion");
    await expect(provider.login({} as never)).rejects.toThrow(/interactive login is not supported/i);
  });

  test("refreshes with client_secret_basic and carries rotated refresh plus metadata", async () => {
    const { calls, fetchImpl } = recordingFetch({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    });

    const result = await refreshNotionToken(credential("client_secret_basic"), fetchImpl);
    const call = calls[0]!;
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    expect(call.url).toBe(NOTION_TOKEN_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Basic ${basic}`);
    expect(formBody(call)).toEqual(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH }),
    );
    expect(result).toMatchObject({
      access: "new-access-token",
      refresh: "rotated-refresh-token",
      email: "ada@example.com",
      accountId: "notion-account",
      identity_key: "identity:ada@example.com",
      client_metadata: { registration_id: "registration-1" },
    });
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  test("refreshes with client_secret_post and keeps the old refresh token when not rotated", async () => {
    const { calls, fetchImpl } = recordingFetch({ access_token: "post-access-token", expires_in: 1800 });

    const result = await refreshNotionToken(credential("client_secret_post"), fetchImpl);
    const params = formBody(calls[0]!);

    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
    expect(params).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    );
    expect(result.refresh).toBe(REFRESH);
    expect(result.client_metadata).toEqual({ registration_id: "registration-1" });
    expect(result.identity_key).toBe("identity:ada@example.com");
  });

  test("refreshes public clients with none and client_id only", async () => {
    const { calls, fetchImpl } = recordingFetch({ access_token: "public-access-token", expires_in: 1200 });

    await refreshNotionToken(credential("none"), fetchImpl);
    const call = calls[0]!;
    const params = formBody(call);

    expect(new Headers(call.init.headers).get("authorization")).toBeNull();
    expect(params).toEqual(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID }),
    );
    expect(params.has("client_secret")).toBe(false);
  });

  test("rejects malformed and non-2xx responses without logging token values", async () => {
    const malformed = recordingFetch({ access_token: "leaked-access", expires_in: 0 });
    const non2xx = recordingFetch({ error: "invalid_grant", refresh_token: REFRESH }, 401);
    const original = { log: console.log, warn: console.warn, error: console.error };
    const logs: unknown[][] = [];
    console.log = (...args: unknown[]) => logs.push(args);
    console.warn = (...args: unknown[]) => logs.push(args);
    console.error = (...args: unknown[]) => logs.push(args);
    try {
      await expect(refreshNotionToken(credential("none"), malformed.fetchImpl)).rejects.toThrow();
      await expect(refreshNotionToken(credential("none"), non2xx.fetchImpl)).rejects.toThrow(/invalid_grant/);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
    expect(logs).toEqual([]);
    expect(logs.flat().join(" ")).not.toContain(REFRESH);
    expect(logs.flat().join(" ")).not.toContain(CLIENT_SECRET);
  });

  test("factory uses the same refresh adapter and does not log secrets", async () => {
    const { fetchImpl } = recordingFetch({ access_token: "factory-access-token", expires_in: 60 });
    const provider = createNotionOAuthProvider(fetchImpl);
    const result = await provider.refreshToken!(credential("none"));
    expect(result.access).toBe("factory-access-token");
  });
});
