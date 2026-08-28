import { registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthProviderInterface } from "@oh-my-pi/pi-ai/oauth";
import { z } from "zod";

export const NOTION_TOKEN_ENDPOINT = "https://mcp.notion.com/token";

type NotionClientCredentials = {
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: "client_secret_basic" | "client_secret_post" | "none";
  identity_key?: string;
  client_metadata?: { registration_id?: string };
};

export type NotionOAuthCredentials = OAuthCredentials & NotionClientCredentials;
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TOKEN_RESPONSE_SCHEMA = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
  refresh_token: z.string().min(1).optional(),
});
type TokenResponse = z.infer<typeof TOKEN_RESPONSE_SCHEMA>;

const ERROR_RESPONSE_SCHEMA = z.object({ error: z.string().regex(/^[a-z0-9_]{1,64}$/).optional() });

type ClientCredentials =
  | { method: "client_secret_basic"; clientId: string; clientSecret: string }
  | { method: "client_secret_post"; clientId: string; clientSecret: string }
  | { method: "none"; clientId: string };


function clientCredentials(credentials: NotionOAuthCredentials): ClientCredentials {
  const parsedMethod = z
    .enum(["client_secret_basic", "client_secret_post", "none"])
    .safeParse(credentials.token_endpoint_auth_method);
  if (!parsedMethod.success) {
    throw new Error("Notion OAuth credential has an unsupported client authentication method");
  }
  const method = parsedMethod.data;
  const clientId = z.string().min(1).safeParse(credentials.client_id);
  if (!clientId.success) {
    throw new Error("Notion OAuth credential is missing its client id");
  }
  if (method !== "none") {
    const clientSecret = z.string().min(1).safeParse(credentials.client_secret);
    if (!clientSecret.success) {
      throw new Error("Notion OAuth credential is missing its client secret");
    }
    return { method, clientId: clientId.data, clientSecret: clientSecret.data };
  }
  return { method, clientId: clientId.data };
}

export async function refreshNotionToken(
  credentials: NotionOAuthCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<NotionOAuthCredentials> {
  const refresh = z.string().min(1).safeParse(credentials.refresh);
  if (!refresh.success) throw new Error("Notion OAuth credential is missing its refresh token");
  const client = clientCredentials(credentials);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh.data });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (client.method === "client_secret_basic") {
    headers.set("authorization", `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`);
  } else {
    body.set("client_id", client.clientId);
    if (client.method === "client_secret_post") body.set("client_secret", client.clientSecret);
  }

  let response: Response;
  try {
    response = await fetchImpl(NOTION_TOKEN_ENDPOINT, { method: "POST", headers, body: body.toString() });
  } catch {
    throw new Error("Notion OAuth token refresh request failed");
  }
  if (!response.ok) {
    let code: string | undefined;
    try {
      const parsedError = ERROR_RESPONSE_SCHEMA.safeParse(await response.json());
      if (parsedError.success) code = parsedError.data.error;
    } catch {
      // Status-only error below: response bodies can contain credential data.
    }
    throw new Error(
      code
        ? `Notion OAuth token refresh failed: ${code}`
        : `Notion OAuth token refresh failed (status ${response.status})`,
    );
  }

  let parsed: TokenResponse | null;
  try {
    const tokenResponse = TOKEN_RESPONSE_SCHEMA.safeParse(await response.json());
    parsed = tokenResponse.success ? tokenResponse.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed) throw new Error("Notion OAuth token refresh returned a malformed response");

  const refreshed: NotionOAuthCredentials = {
    ...credentials,
    access: parsed.access_token,
    expires: Date.now() + parsed.expires_in * 1000,
    refresh: parsed.refresh_token ?? credentials.refresh,
  };
  return refreshed;
}

export function createNotionOAuthProvider(fetchImpl: FetchImpl = fetch): OAuthProviderInterface {
  return {
    id: "notion",
    name: "Notion",
    sourceId: "bottega-notion-oauth",
    login: async () => {
      throw new Error("Notion OAuth interactive login is not supported by the auth broker");
    },
    // SAFETY: the OAuth provider contract supplies its credential object from
    // AuthStorage; Notion adds the optional client fields used by this broker.
    refreshToken: (credentials) => refreshNotionToken(credentials as NotionOAuthCredentials, fetchImpl),
    getApiKey: (credentials) => credentials.access,
  };
}

export const NOTION_OAUTH_PROVIDER = createNotionOAuthProvider();

export function registerNotionOAuthProvider(): void {
  registerOAuthProvider(NOTION_OAUTH_PROVIDER);
}
