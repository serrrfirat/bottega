import { registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthProviderInterface } from "@oh-my-pi/pi-ai/oauth";

export const NOTION_TOKEN_ENDPOINT = "https://mcp.notion.com/token";

export type NotionOAuthCredentials = OAuthCredentials & Record<string, unknown>;
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

function parseTokenResponse(value: unknown): TokenResponse | null {
  if (value === null || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (typeof response.access_token !== "string" || response.access_token.length === 0) return null;
  if (typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in) || response.expires_in <= 0) return null;
  if (response.refresh_token !== undefined && (typeof response.refresh_token !== "string" || response.refresh_token.length === 0)) {
    return null;
  }
  return {
    access_token: response.access_token,
    expires_in: response.expires_in,
    ...(response.refresh_token === undefined ? {} : { refresh_token: response.refresh_token }),
  };
}

function clientCredentials(credentials: NotionOAuthCredentials): { method: string; clientId: string; clientSecret?: string } {
  const method = credentials.token_endpoint_auth_method;
  const clientId = credentials.client_id;
  if (method !== "client_secret_basic" && method !== "client_secret_post" && method !== "none") {
    throw new Error("Notion OAuth credential has an unsupported client authentication method");
  }
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error("Notion OAuth credential is missing its client id");
  }
  if (method !== "none") {
    const clientSecret = credentials.client_secret;
    if (typeof clientSecret !== "string" || clientSecret.length === 0) {
      throw new Error("Notion OAuth credential is missing its client secret");
    }
    return { method, clientId, clientSecret };
  }
  return { method, clientId };
}

export async function refreshNotionToken(
  credentials: NotionOAuthCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<NotionOAuthCredentials> {
  if (typeof credentials.refresh !== "string" || credentials.refresh.length === 0) {
    throw new Error("Notion OAuth credential is missing its refresh token");
  }
  const client = clientCredentials(credentials);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (client.method === "client_secret_basic") {
    headers.set("authorization", `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret!}`).toString("base64")}`);
  } else {
    body.set("client_id", client.clientId);
    if (client.method === "client_secret_post") body.set("client_secret", client.clientSecret!);
  }

  let response: Response;
  try {
    response = await fetchImpl(NOTION_TOKEN_ENDPOINT, { method: "POST", headers, body: body.toString() });
  } catch {
    throw new Error("Notion OAuth token refresh request failed");
  }
  if (!response.ok) throw new Error("Notion OAuth token refresh returned a non-success response");

  let parsed: TokenResponse | null;
  try {
    parsed = parseTokenResponse(await response.json());
  } catch {
    parsed = null;
  }
  if (!parsed) throw new Error("Notion OAuth token refresh returned a malformed response");

  return {
    ...credentials,
    access: parsed.access_token,
    expires: Date.now() + parsed.expires_in * 1000,
    refresh: parsed.refresh_token ?? credentials.refresh,
  };
}

export function createNotionOAuthProvider(fetchImpl: FetchImpl = fetch): OAuthProviderInterface {
  return {
    id: "notion",
    name: "Notion",
    sourceId: "bottega-notion-oauth",
    login: async () => {
      throw new Error("Notion OAuth interactive login is not supported by the auth broker");
    },
    refreshToken: (credentials) => refreshNotionToken(credentials as NotionOAuthCredentials, fetchImpl),
    getApiKey: (credentials) => credentials.access,
  };
}

export const NOTION_OAUTH_PROVIDER = createNotionOAuthProvider();

export function registerNotionOAuthProvider(): void {
  registerOAuthProvider(NOTION_OAUTH_PROVIDER);
}
