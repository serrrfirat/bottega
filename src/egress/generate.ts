/**
 * Egress config generation (issue #50): config/egress.yml is a generated
 * artifact — the static iron-proxy template plus the allowlist merged from
 * the extension registry's pinned snapshots (extension `domains` entries)
 * AND the runtime-registered set (issue #233: the store-backed runtime
 * registry — machine state, never a repo file; `regenerateEgressConfig`
 * takes it as a parameter and the committed byte-pin tests stay hermetic
 * on the seed fixtures with an empty runtime set) and the secrets
 * transform for boundary credential injection (issue #53).
 *
 * Issue #208 (proxy-only credentials) adds two blocks to the pipeline:
 * the model-gateway static-key entries in the secrets transform (the
 * providers' placeholder bearer swapped for the real key at egress,
 * require: true — fail closed) and the `oauth_token` transform for the
 * OAuth extensions (#198: linear/attio — the proxy holds the refresh
 * token + client credentials and mints access tokens at egress). Issue
 * #230 moves the codex provider (the ChatGPT subscription credential)
 * from the oauth_token transform to the STATIC-key entries: the SEED
 * owns the codex refresh and writes the access token to
 * openai-codex.secret — the proxy never touches auth.openai.com.
 *
 * Run `bun run src/egress/generate.ts` after adding or updating snapshots in
 * config/extensions/; the committed config/egress.yml (strict, deployment)
 * and config/egress.dev.yml (dev-permissive, issue #126) are the generated
 * outputs, and egress-config.test.ts / generate.test.ts pin them to the
 * templates (no drift). Base model endpoints stay hardcoded here; extension
 * domains append to them, deduped. Default-deny enforcement is unchanged:
 * extension domains merely join the allowlist and still pass the judge
 * transform. The DEV config is the ONLY permissive surface: allow-all
 * allowlist + no judge, secrets + management kept — local testing only.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPinnedSnapshots, type PinnedSnapshot } from "../extensions/registry";
import { extensionSecretFileName, PROXY_SECRETS_MOUNT_PATH } from "../extensions/boundary";

/** Base allowlist: model gateways (NEAR.ai, OpenAI, Anthropic — issue #8,
 * #36, #37ee2bf) plus the opencode-go gateway (issue #208 — the pinned
 * deepseek-v4-flash routes to opencode.ai/zen/go/v1), the ChatGPT Codex
 * gateway (issue #214 — the openai-codex provider's
 * chatgpt.com/backend-api/codex/responses), the example KB host
 * (issue #91), the server's OWN Slack traffic (issue #126 — the Web API
 * at slack.com/api/* and api.slack.com, the Socket Mode websocket on
 * *.slack.com, and file downloads on files.slack.com, issue #124), and
 * the GitHub API for the ingest poller (issue #57, mentions search). */
export const BASE_EGRESS_DOMAINS = [
  "cloud-api.near.ai",
  "*.completions.near.ai",
  "opencode.ai",
  "chatgpt.com",
  "api.openai.com",
  "api.anthropic.com",
  "raw.githubusercontent.com",
  "files.slack.com",
  "slack.com",
  "api.slack.com",
  "*.slack.com",
  "api.github.com",
] as const;

/** Where pinned snapshots live; mounted/baked per deployment. */
export const SNAPSHOTS_DIR = "config/extensions";

/** The generated file (mounted by compose into iron-proxy). */
export const EGRESS_CONFIG_PATH = "config/egress.yml";

/** The generated dev-permissive file (mounted by docker-compose.dev.yml into the dev proxy). */
export const DEV_EGRESS_CONFIG_PATH = "config/egress.dev.yml";

/** Base domains first, then extension domains, deduped, order-stable. */
export function mergedEgressDomains(extensionDomains: readonly string[]): string[] {
  const merged: string[] = [...BASE_EGRESS_DOMAINS];
  for (const domain of extensionDomains) {
    if (!merged.includes(domain)) merged.push(domain);
  }
  return merged;
}

/** The job kinds the per-job egress allowlist configures (issue #101). */
export type JobEgressKind = "git" | "extension" | "kb" | "ingest_poll";

/** Per-kind egress allowlist inputs (issue #101). Everything is optional — unset means "no extra hosts". */
export interface JobEgressDomainsOpts {
  /** git: the clone/push repo host (the git_base_url's host, e.g. github.com). */
  repoHost?: string;
  /** git: the outbound tunnel/cloudflared host, when the env uses one. */
  tunnelHost?: string;
  /** extension: the connected extension's declared domains (its pinned manifest `domains`). */
  extensionHosts?: readonly string[];
  /** kb: hosts from config/kb.yml. */
  kbHosts?: readonly string[];
}

/**
 * The per-job egress allowlist subset (issue #101, epic #229 P1): the
 * runner's iron-proxy allowlist is the intersection this function renders —
 * the shared base model-gateway/github/slack domains PLUS the hosts the
 * job's kind legitimately needs, default-deny everywhere else. P1 renders
 * + exports the subset for the boss loop's egress config generation and
 * for the caller-surface tests; per-process allowlist ENFORCEMENT on the
 * child is P2/#229 hardening (the proxy already applies the generated
 * config to the whole worker's egress).
 */
export function jobEgressDomains(kind: JobEgressKind, opts: JobEgressDomainsOpts = {}): string[] {
  const merged: string[] = [...BASE_EGRESS_DOMAINS];
  const add = (host: string | undefined): void => {
    if (host !== undefined && host.trim() !== "" && !merged.includes(host)) merged.push(host.trim());
  };
  switch (kind) {
    case "git":
      add(opts.repoHost);
      add(opts.tunnelHost);
      break;
    case "extension":
      for (const host of opts.extensionHosts ?? []) add(host);
      break;
    case "kb":
      for (const host of opts.kbHosts ?? []) add(host);
      break;
    case "ingest_poll":
      // The provider endpoints are already base allowlisted (api.github.com).
      break;
  }
  return merged;
}

/** A host extracted from a base URL ("https://github.com/org/repo" → "github.com"). */
export function hostFromBaseUrl(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/** One extension's credential-injection entry for the generated egress config (issue #53). */
export interface ExtensionEgressEntry {
  extensionId: string;
  /** The extension's allowlisted domains; the proxy injects auth for these hosts. */
  domains: string[];
}

/**
 * The model-gateway static keys (issue #208 + #230): the providers
 * config/omp/models.yml declares (near/opencode/openai/anthropic, plus
 * openai-codex — the ChatGPT subscription credential) talk to their
 * gateways with a PLACEHOLDER bearer; the proxy injects the real value
 * from the provider's secret file (`data/proxy-secrets/<provider>.secret`,
 * seeded at boot by the proxy credential sync, src/extensions/proxy-seed).
 * Each entry REQUIRES its secret file (`inject.require: true`) — a missing
 * key fails the request closed (502) instead of letting the placeholder
 * reach the gateway (the #208 fail-closed invariant). For codex the
 * secret file holds the ACCESS token minted by the seed's own refresh
 * (issue #230: the seed owns the rotation; the proxy injects the static
 * bearer at egress and never touches auth.openai.com).
 */
export interface ModelGatewayKey {
  /** The provider id (the sync's vault provider / Keychain service suffix). */
  provider: string;
  /** The gateway host the proxy injects the key for. */
  host: string;
}

/** The base model-gateway keys, shared by the strict and dev renderers. */
export const MODEL_GATEWAY_KEYS: readonly ModelGatewayKey[] = [
  { provider: "near", host: "cloud-api.near.ai" },
  // opencode-go's built-in gateway (the catalog entry for
  // deepseek-v4-flash: https://opencode.ai/zen/go/v1).
  { provider: "opencode", host: "opencode.ai" },
  { provider: "openai", host: "api.openai.com" },
  { provider: "anthropic", host: "api.anthropic.com" },
  // Issue #214/#230 (the openai-codex model provider): the ChatGPT
  // subscription OAuth access token, seeded as a STATIC secret by the
  // proxy credential sync's codex leg (data/proxy-secrets/openai-codex.secret
  // — the seed owns the refresh and writes the minted access token; the
  // proxy injects it as the bearer for chatgpt.com, require: true).
  { provider: "openai-codex", host: "chatgpt.com" },
] as const;

/**
 * One OAuth provider's `oauth_token` transform entry (issue #208): the
 * proxy holds the provider's refresh token (+ client credentials) and
 * mints the access token at egress, so the app never touches a live OAuth
 * credential. The credential fields come from ONE JSON blob per provider
 * (`data/proxy-secrets/<provider>-oauth.json`, seeded by the sync) via
 * `json_key`. `require: true` — a missing/unmintable credential rejects
 * the request (502) instead of forwarding it unauthenticated.
 */
export interface OAuthTokenEntry {
  extensionId: string;
  /** The extension's allowlisted domains; the proxy injects the minted bearer for these hosts. */
  domains: string[];
  /**
   * The provider's OAuth2 token endpoint (RFC 8414 discovery, verified
   * 2026-08-18): the proxy POSTs the refresh grant here AND stubs inbound
   * requests to this host+path with a synthetic token, so the app's SDK
   * can complete its own token dance against the proxy.
   */
  tokenEndpoint: string;
  /**
   * The path globs scoping each mint rule (iron-proxy `paths` rule,
   * v0.49.0 — issue #246): a request only gets the minted bearer injected
   * when its path matches one of these AND its host matches the rule's
   * host. The scope is the provider's MCP resource subtree (the
   * serverUrl's path, e.g. `/mcp` + `/mcp/*`). The RFC 8414/9207 public
   * discovery endpoints (`/.well-known/*`) are deliberately OUT of scope:
   * the SDK probes them BEFORE any credential exists, and a bare-host rule
   * under `require: true` 502s every discovery probe (the issue #246
   * symptom). The token_endpoint STUB is NOT rule-gated (iron-proxy
   * matches it on exact host+path before rules), so it needs no path here.
   */
  paths: readonly string[];
}

/**
 * Verified token endpoints for the OAuth extensions (the #198 providers;
 * RFC 8414 authorization-server metadata, fetched 2026-08-18):
 *   linear — https://mcp.linear.app/.well-known/oauth-authorization-server
 *   attio  — https://mcp.attio.com/.well-known/oauth-authorization-server
 * An oauth-type extension without an endpoint here FAILS config generation
 * (never a guessed URL — a wrong token endpoint would mint garbage). The
 * canary's test fixtures (issue #212) are the exception: `fixture.`-
 * prefixed ids (tests/e2e/canary.ts — fixture.pin, fixture.oauth) are
 * test-only and synthesize their endpoint from their own allowlisted
 * domain in {@link oauthTokenEntries} — they never appear in
 * config/extensions, so the production map stays fake-domain-free.
 * (The codex endpoint moved out under issue #230: the SEED calls
 * auth.openai.com/oauth/token directly — see CODEX_TOKEN_ENDPOINT in
 * src/extensions/proxy-seed.ts — the proxy never mints for codex.)
 */
/** Verified token endpoints keyed by OAuth extension id (the #198 providers). */
interface VerifiedTokenEndpoints {
  [extensionId: string]: string;
}

export const OAUTH_TOKEN_ENDPOINTS: VerifiedTokenEndpoints = {
  linear: "https://mcp.linear.app/token",
  attio: "https://app.attio.com/oidc/token",
  notion: "https://mcp.notion.com/token",
};

/**
 * Verified MCP resource paths keyed by OAuth extension id (the #198
 * providers — issue #246): the serverUrl path the SDK calls as the MCP
 * resource (linear/attio/notion all serve /mcp). Used as the FALLBACK
 * when a snapshot's serverUrl yields no usable path (e.g. a root URL) —
 * never a guessed path: an OAuth extension with neither a usable
 * serverUrl path nor a verification here FAILS generation closed.
 * (Fixtures and every registered provider derive their scope from the
 * serverUrl directly; this table is the fail-closed floor.)
 */
interface VerifiedResourcePaths {
  [extensionId: string]: string;
}

const OAUTH_RESOURCE_PATHS: VerifiedResourcePaths = {
  linear: "/mcp",
  attio: "/mcp",
  notion: "/mcp",
};

/**
 * The rule-scope globs for one OAuth snapshot (issue #246): the
 * serverUrl's resource path plus its subtree when available (e.g. `/mcp` +
 * `/mcp/*`), else the verified per-provider fallback
 * ({@link OAUTH_RESOURCE_PATHS} — e.g. a runtime snapshot carrying a
 * root URL). Fails generation closed when neither yields a path.
 */
function oauthResourcePaths(snapshot: PinnedSnapshot): readonly string[] {
  const serverUrl = snapshot.manifest.kind === "mcp" ? snapshot.manifest.mcp.serverUrl : undefined;
  if (serverUrl !== undefined) {
    try {
      // Normalize a trailing slash so a root URL ("https://host/") is
      // detected as having no usable path (falls through fail-closed).
      const pathname = new URL(serverUrl).pathname.replace(/\/+$/, "");
      if (pathname.length > 0 && pathname !== "/") {
        return [pathname, `${pathname}/*`];
      }
    } catch {
      // malformed serverUrl → the verified fallback below (fail closed).
    }
  }
  const fallback = OAUTH_RESOURCE_PATHS[snapshot.manifest.id];
  if (fallback === undefined) {
    throw new Error(
      `egress config generation: the OAuth extension "${snapshot.manifest.id}" has no usable serverUrl path — ` +
        "add one to OAUTH_RESOURCE_PATHS in src/egress/generate.ts before regenerating",
    );
  }
  return [fallback, `${fallback}/*`];
}

/**
 * The canary's OAuth fixture id prefix (issue #212): test-only extensions
 * (fixture.pin, fixture.oauth — tests/e2e/canary.ts) with reserved testing
 * domains (fixture-pin.example.com, oauth.fixture.test). Their egress
 * regeneration must not demand a verified RFC 8414 token endpoint — there
 * is no real authorization server behind a fixture domain, so the endpoint
 * is synthesized from the fixture's own allowlisted host instead.
 */
const CANARY_OAUTH_FIXTURE_ID_PREFIX = "fixture.";

/** The proxy-side OAuth credential blob for a provider (the `tokens` entry's json_key file). */
export function oauthTokenBlobFileName(extensionId: string): string {
  return `${extensionId}-oauth.json`;
}

/**
 * The file-injection entries for the pinned snapshots: ONLY the api_key
 * extensions (issue #208 — the OAuth extensions move to the oauth_token
 * transform and get no `.secret` file entry).
 */
export function apiKeyExtensionEntries(snapshots: ReturnType<typeof readPinnedSnapshots>): ExtensionEgressEntry[] {
  return snapshots
    .filter((s) => s.manifest.credentialSchema.type !== "oauth")
    .map((s) => ({ extensionId: s.manifest.id, domains: s.manifest.domains }));
}

/**
 * The oauth_token entries for the pinned snapshots' OAuth extensions
 * (issue #208): each needs a VERIFIED token endpoint (OAUTH_TOKEN_ENDPOINTS
 * — RFC 8414 discovery metadata); an OAuth extension without one fails
 * generation closed (never a guessed URL). The canary's `fixture.`-prefixed
 * OAuth fixtures (issue #212) are test-only: their endpoint is synthesized
 * from the fixture's own allowlisted domain (there is no real
 * authorization server behind a fixture domain), so the #195 extension-pin
 * journey's egress regeneration runs deterministically.
 *
 * Decision B (issue #265): `excluded` names providers whose CURRENT vault
 * credential is non-renewable (access-only — no refresh grant anywhere).
 * The oauth_token transform is a refresh_token-grant mint: for a
 * non-renewable provider there is no refresh to seed, so `require: true`
 * would 502 every runtime call (the mint fails) even though the SDK sent a
 * valid access token — the boundary `secrets` injection carries that
 * provider's token instead. The connect-time egress reconcile computes the
 * exclusion set from the vault and passes it; the CLI generator and the
 * committed byte-stable config keep the default (no exclusion).
 */
export function oauthTokenEntries(
  snapshots: ReturnType<typeof readPinnedSnapshots>,
  excluded: ReadonlySet<string> = new Set(),
): OAuthTokenEntry[] {
  return snapshots
    .filter((s) => s.manifest.credentialSchema.type === "oauth" && !excluded.has(s.manifest.id))
    .map((s): OAuthTokenEntry => {
      // Issue #246: every entry's rules get scoped to the MCP resource
      // subtree (paths) so public `/.well-known/*` discovery passes
      // token-less while real API calls stay fail-closed.
      const paths = oauthResourcePaths(s);
      if (s.manifest.id.startsWith(CANARY_OAUTH_FIXTURE_ID_PREFIX)) {
        const host = s.manifest.domains.find((domain) => domain !== "*");
        if (host === undefined) {
          throw new Error(
            `egress config generation: the OAuth fixture "${s.manifest.id}" has no allowlisted domain to ` +
              "synthesize its token endpoint from",
          );
        }
        return {
          extensionId: s.manifest.id,
          domains: s.manifest.domains,
          tokenEndpoint: `https://${host}/token`,
          paths,
        };
      }
      const tokenEndpoint = OAUTH_TOKEN_ENDPOINTS[s.manifest.id];
      if (tokenEndpoint === undefined) {
        throw new Error(
          `egress config generation: the OAuth extension "${s.manifest.id}" has no verified token endpoint — ` +
            "add one to OAUTH_TOKEN_ENDPOINTS in src/egress/generate.ts (from its RFC 8414 discovery metadata) " +
            "before regenerating",
        );
      }
      return { extensionId: s.manifest.id, domains: s.manifest.domains, tokenEndpoint, paths };
    });
}

/** Static blocks shared verbatim by the strict and dev renderers (dns, proxy, tls, management). */
const EGRESS_STATIC_BLOCKS = `dns:
  listen: ":53"
  proxy_ip: "172.30.0.2" # static IP of iron-proxy on the compose \`egress\` network
  # passthrough: [] # names forwarded to the OS resolver (bypasses the proxy)
  # records: []     # static A/CNAME records for internal names

proxy:
  http_listen: ":80"
  https_listen: ":443"
  tunnel_listen: ":8080" # explicit HTTP_PROXY/CONNECT/SOCKS5 listener
  max_request_body_bytes: 1048576
  max_response_body_bytes: 0
  # upstream_deny_cidrs defaults to cloud-metadata + loopback (SSRF guard).

tls:
  # MITM CA, generated once per deployment and never committed:
  #   docker run --rm -v $PWD/certs:/certs ironsh/iron-proxy:0.49.0 generate-ca -outdir /certs
  ca_cert: "/etc/iron-proxy/certs/ca.crt"
  ca_key: "/etc/iron-proxy/certs/ca.key"

management:
  # Operator API (issue #123): the extension credential boundary calls
  # POST /v1/reload after writing each secret file, so rotation applies
  # immediately without a proxy restart. Bound to all interfaces so BOTH
  # topologies reach it from the same config: compose (server ->
  # http://iron-proxy:9092) and local dev (published 127.0.0.1:9092, via
  # docker-compose.dev.yml). The bearer token lives in the env var named
  # below — fail-closed: a reload without a valid token is 401, and the
  # boundary only wires the reload when the URL AND token are both set.
  listen: ":9092"
  api_key_env: "IRON_MANAGEMENT_API_KEY"
`;

/** The indented `- source:` entries of the secrets transform, shared by both renderers. */
function renderSecretsEntries(extensions: readonly ExtensionEgressEntry[]): string {
  return extensions
    .map((extension) => {
      const hostLines = extension.domains.map((domain) => `            - host: "${domain}"`).join("\n");
      return `        - source:
            type: file
            path: "${PROXY_SECRETS_MOUNT_PATH}/${extensionSecretFileName(extension.extensionId)}"
            ttl: "30s"
          inject:
            header: "Authorization"
            formatter: "Bearer {{ .Value }}"
          rules:
${hostLines}`;
    })
    .join("\n");
}

/** The indented `- source:` entries for the model-gateway keys (issue #208). */
function renderModelGatewayEntries(keys: readonly ModelGatewayKey[]): string {
  return keys
    .map(
      (key) => `        - source:
            type: file
            path: "${PROXY_SECRETS_MOUNT_PATH}/${key.provider}.secret"
            ttl: "30s"
          inject:
            header: "Authorization"
            formatter: "Bearer {{ .Value }}"
            require: true
          rules:
            - host: "${key.host}"`,
    )
    .join("\n");
}

/**
 * Renders the `secrets` transform (iron-proxy v0.49.0 inject mode, issue
 * #53 + #208): one entry per extension, sourcing the credential from the
 * extension's secret file (written by the runtime's boundary) and
 * injecting it as the Authorization header for the extension's domains,
 * plus the model-gateway static-key entries (the providers' placeholders
 * swapped for the real key at egress, REQUIRED — a missing key rejects
 * the request closed). The openai-codex provider is one of those static
 * entries (issue #230): the seed writes the minted access token to
 * openai-codex.secret, the proxy injects it for chatgpt.com. The judge
 * transform runs BEFORE secrets so the LLM judge sees no real credentials
 * (iron-proxy README's recommended ordering).
 */
export function renderSecretsTransform(extensions: readonly ExtensionEgressEntry[]): string {
  const extensionEntries = renderSecretsEntries(extensions);
  const gatewayEntries = renderModelGatewayEntries(MODEL_GATEWAY_KEYS);
  const extensionBlock = extensions.length > 0 ? `${extensionEntries}\n` : "";
  return `  # 3. Secrets: boundary credential injection (issue #53 + #208). Extension
  #    calls carry no credential — the runtime resolves the caller's
  #    credential at call time and writes it to the extension's secret file
  #    on the shared data volume (mode 0600, write-temp + rename); this
  #    transform INJECTS it as the Authorization header for the extension's
  #    allowlisted domains before egress. The MODEL GATEWAY entries below
  #    do the same for the providers config/omp/models.yml declares: the
  #    SDK sends the placeholder bearer (bottega-proxy-placeholder), the
  #    proxy swaps the real key from data/proxy-secrets/<provider>.secret
  #    (seeded at boot by src/extensions/proxy-seed). The openai-codex
  #    provider is one of these entries (issue #230): the seed owns the
  #    codex refresh and writes the minted access token to
  #    openai-codex.secret — the proxy injects it for chatgpt.com and never
  #    touches auth.openai.com. require: true — a missing key rejects the
  #    request (502) instead of letting the placeholder reach the gateway.
  #    File sources re-read on config reload and on ttl expiry, so
  #    credentials rotate on a running proxy. Judge runs BEFORE secrets so
  #    the LLM judge never sees real credentials (iron-proxy README's
  #    recommended ordering).
  - name: secrets
    config:
      secrets:
${extensionBlock}${gatewayEntries}
`;
}

/**
 * Renders the `oauth_token` transform (iron-proxy v0.49.0, issue #208):
 * one refresh_token-grant entry per OAuth extension (#198 providers —
 * linear/attio/notion). The proxy holds the provider's refresh token +
 * client credentials (from the sync's JSON blob) and mints the access
 * token at egress; inbound requests to the configured token_endpoint are
 * stubbed with a synthetic token so the app's SDK can complete its own
 * OAuth dance against the proxy (the GCP stub pattern). require: true —
 * an unmintable credential rejects the request (502), never an
 * unauthenticated upstream call. Issue #246: every rule is scoped with
 * `paths` to the provider's MCP resource subtree — the RFC 8414/9207
 * public discovery endpoints (`/.well-known/*`) must load before any
 * credential exists, so the mint rules never match them. The codex model
 * provider is NOT here (issue #230): it is a STATIC secrets entry — the
 * seed owns the refresh, the proxy injects the access token at egress.
 */
export function renderOAuthTokenTransform(entries: readonly OAuthTokenEntry[]): string {
  const tokenBlocks = entries
    .map((entry) => {
      const blobPath = `${PROXY_SECRETS_MOUNT_PATH}/${oauthTokenBlobFileName(entry.extensionId)}`;
      // Issue #246: each host rule is scoped to the provider's MCP
      // resource subtree (`paths`), so the RFC 8414/9207 public discovery
      // endpoints (`/.well-known/*` — probed BEFORE any credential exists)
      // pass token-less while real API calls stay fail-closed under
      // require: true. The token_endpoint stub is NOT rule-gated
      // (iron-proxy matches it on exact host+path before rules), so it
      // needs no rule here.
      const pathLines = entry.paths.map((path) => `                - "${path}"`).join("\n");
      const hostLines = entry.domains
        .map((domain) => `            - host: "${domain}"\n              paths:\n${pathLines}`)
        .join("\n");
      return `        - grant: refresh_token
          refresh_token:
            type: file
            path: "${blobPath}"
            ttl: "30s"
            json_key: "refresh_token"
          client_id:
            type: file
            path: "${blobPath}"
            ttl: "30s"
            json_key: "client_id"
          token_endpoint: "${entry.tokenEndpoint}"
          require: true
          rules:
${hostLines}`;
    })
    .join("\n");
  return `  # 4. OAuth token minting (issue #208): the OAuth extensions (#198) send the
  #    placeholder bearer; this transform holds each provider's refresh
  #    token + client credentials (the sync's JSON blob,
  #    data/proxy-secrets/<provider>-oauth.json), mints short-lived access
  #    tokens at egress, and stubs inbound requests to each configured
  #    token_endpoint with a synthetic token so the SDK's own token dance
  #    completes against the proxy. require: true — a missing/unmintable
  #    credential rejects the request (502), never an unauthenticated
  #    upstream call. The codex model provider is NOT here (issue #230):
  #    its access token is a STATIC secrets entry — the seed owns the
  #    refresh, the proxy injects the minted token for chatgpt.com.
  - name: oauth_token
    config:
      tokens:
${tokenBlocks}
`;
}

/**
 * Renders the full iron-proxy config (v0.49.0) with the given allowlist.
 * Byte-stable: rendering with {@link BASE_EGRESS_DOMAINS} reproduces the
 * committed config/egress.yml exactly.
 */
export function renderEgressConfig(
  domains: readonly string[],
  extensions: readonly ExtensionEgressEntry[] = [],
  oauthTokens: readonly OAuthTokenEntry[] = [],
): string {
  const domainLines = domains.map((domain) => `        - "${domain}"`).join("\n");
  // The secrets transform is always emitted: the model-gateway static-key
  // entries (issue #208) are base config — only the extension entries are
  // optional.
  const secretsTransform = `${renderSecretsTransform(extensions)}\n`;
  // The oauth_token transform covers only extension OAuth entries (issue
  // #230: the codex model provider is a STATIC secrets entry now — the
  // seed owns the refresh); it is omitted entirely when no extension
  // snapshots carry an oauth credential.
  const oauthTransform = oauthTokens.length > 0 ? `${renderOAuthTokenTransform(oauthTokens)}\n` : "";
  return `# iron-proxy egress policy for bottega (issue #8).
# Schema: ironsh/iron-proxy v0.49.0 single YAML config, loaded via
#   iron-proxy -config /etc/iron-proxy/egress.yml
# Reference: https://github.com/ironsh/iron-proxy#configuration
#
# Design: default-deny egress. Containers resolve DNS through this proxy
# (compose \`dns:\`), so every name answers with \`proxy_ip\` — the proxy is the
# only path out of the container network. The transform pipeline then gates:
#   1. allowlist  — model endpoints pass without an LLM round-trip.
#   2. judge      — everything that passed the allowlist is policy-judged by
#                   an LLM ("deny unless clearly required by the task and
#                   safe"). Fallback deny keeps egress closed when the judge
#                   LLM is down or the circuit breaker is open.
# iron-proxy's DNS always answers with proxy_ip (it does not refuse lookups);
# enforcement is at the HTTP layer, so a non-allowlisted host gets a 403.
${EGRESS_STATIC_BLOCKS}
transforms:
  # 1. Static allowlist: NEAR.ai model endpoints (issue #8, #36), the
  #    knowledge-base host (issue #91), the server's own Slack traffic
  #    (issue #126 — the Web API at slack.com/api, Socket Mode on
  #    *.slack.com, file downloads on files.slack.com), plus extension
  #    domains from config/extensions snapshots (issue #50). A KB host
  #    must be listed here and must still pass the judge below.
  #    Generated by \`bun run src/egress/generate.ts\` — edit the template
  #    there, not here. api.near.ai was retired 2025-10-31; config/omp/
  #    models.yml points the \`near\` provider at cloud-api.near.ai/v1.
  - name: allowlist
    config:
      domains:
${domainLines}

  # 2. Judge: LLM policy gate. Fires on every request that passed the
  #    allowlist. Independent circuit breaker + timeout per instance.
  - name: judge
    config:
      name: "egress-policy"
      fallback: "deny" # fail closed on LLM error/timeout/breaker-open
      timeout: "8s"
      max_concurrent: 16
      circuit_breaker:
        consecutive_failures: 5
        cooldown: "10s"
      rules:
        - host: "*"
      provider:
        type: "openai" # NEAR.ai OpenAI-compatible Chat Completions API
        base_url: "https://qwen35-122b.completions.near.ai/v1"
        model: "qwen35-122b"
        # Judge key is separate from the agents' key (issue #8: "separate key
        # if preferred"). Model id is org-chosen; this example is from
        # https://docs.near.ai/cloud/models.
        api_key_env: "NEARAI_JUDGE_API_KEY"
        max_tokens: 256
      prompt: |
        Decide whether this outbound HTTP request is acceptable for a coding
        agent. Policy: DENY unless the request is clearly required by the
        current task and safe. Allow only requests that are necessary to
        complete the work at hand, target a legitimate destination, and
        carry no secrets or sensitive data. When in doubt, deny. Reply with
        exactly one word: ALLOW or DENY.

${secretsTransform}${oauthTransform}log:
  level: "info"
`;
}

/**
 * Renders the dev-permissive secrets transform (issue #126 + #208): same
 * credential-injection entries as the strict config (extension entries
 * + the model-gateway static keys), with a dev-appropriate comment (no
 * judge precedes it in the dev pipeline).
 */
function renderDevSecretsTransform(extensions: readonly ExtensionEgressEntry[]): string {
  const extensionEntries = renderSecretsEntries(extensions);
  const gatewayEntries = renderModelGatewayEntries(MODEL_GATEWAY_KEYS);
  const extensionBlock = extensions.length > 0 ? `${extensionEntries}\n` : "";
  return `  # 2. Secrets: boundary credential injection (issue #53 + #208) — KEPT in
  #    the dev config (the core requirement): extension calls carry no
  #    credential, and this transform INJECTS it as the Authorization
  #    header for the extension's allowlisted domains before egress; the
  #    model-gateway entries swap the providers' placeholder bearer for the
  #    real key (require: true — a missing key rejects the request). File
  #    sources re-read on config reload and on ttl expiry, so credentials
  #    rotate on a running proxy.
  - name: secrets
    config:
      secrets:
${extensionBlock}${gatewayEntries}
`;
}

/**
 * Renders the LOCAL-DEV iron-proxy config (v0.49.0): allow-all allowlist
 * ("*" — iron-proxy hostmatch glob semantics, `MatchGlob("*", name)` is
 * true for every host, so nothing is denied at the allowlist layer), NO
 * judge transform (the LLM policy gate was the dev restrictiveness —
 * issue #126; dev needs no NEARAI_JUDGE_API_KEY), while KEEPING the
 * secrets transform (extension credential injection, issue #53) and the
 * management block (boundary reload, issue #123). The strict
 * config/egress.yml remains the deployment contract, unchanged. Loaded by
 * scripts/dev.sh via docker-compose.dev.yml.
 */
export function renderDevEgressConfig(
  extensions: readonly ExtensionEgressEntry[] = [],
  oauthTokens: readonly OAuthTokenEntry[] = [],
): string {
  // The secrets transform is always emitted: the model-gateway static-key
  // entries (issue #208) are base config — only the extension entries are
  // optional.
  const secretsTransform = `${renderDevSecretsTransform(extensions)}\n`;
  // The oauth_token transform covers only extension OAuth entries (issue
  // #230: the codex model provider is a STATIC secrets entry now — the
  // seed owns the refresh); it is omitted entirely when no extension
  // snapshots carry an oauth credential.
  const oauthTransform = oauthTokens.length > 0 ? `${renderOAuthTokenTransform(oauthTokens)}\n` : "";
  return `# iron-proxy egress policy for bottega — LOCAL DEV (permissive, issue #126).
# Schema: ironsh/iron-proxy v0.49.0 single YAML config, loaded via
#   iron-proxy -config /etc/iron-proxy/egress.yml
# Reference: https://github.com/ironsh/iron-proxy#configuration
#
# Design: PERMISSIVE egress for local testing only. scripts/dev.sh loads
# THIS config into the dev proxy (docker-compose.dev.yml mounts it at
# /etc/iron-proxy/egress.yml); the strict config/egress.yml stays the
# deployment contract (default-deny allowlist + LLM judge + secrets +
# management, unchanged). Differences here:
#   1. allowlist — "*" (allow-all): web search (SDK providers), GitHub,
#                  Slack, model endpoints — anything; no 403s (issue #126).
#   2. judge     — deliberately ABSENT: the LLM policy gate was the source
#                  of the dev 403s; testing needs no policy LLM, so
#                  NEARAI_JUDGE_API_KEY is not required for dev.
#   3. secrets   — KEPT: extension credential injection (issue #53).
#   4. management— KEPT: the boundary's POST /v1/reload (issue #123).
${EGRESS_STATIC_BLOCKS}
transforms:
  # 1. Allow-all (dev testing only): "*" matches ANY host — iron-proxy
  #    v0.49.0 hostmatch glob semantics (MatchGlob("*", name) is true for
  #    every host). Strict default-deny lives in config/egress.yml, not
  #    here. Generated by \`bun run src/egress/generate.ts\` — edit the
  #    template there, not here.
  - name: allowlist
    config:
      domains:
        - "*"

${secretsTransform}${oauthTransform}log:
  level: "info"
`;
}

/**
 * Reads pinned snapshots from `snapshotsDir`, merges the RUNTIME set
 * (issue #233: the store-backed runtime-registered extensions — machine
 * state, never a repo file) into the allowlist and the credential-injection
 * entries (issue #53), writes config/egress.yml, and returns the rendered
 * text. OAuth extensions (#198 providers) move from file injection to the
 * `oauth_token` transform (issue #208): their access tokens are minted by
 * the proxy, so they get no `.secret` file entry. Defaults are the
 * deployment paths; CLI: `bun run src/egress/generate.ts`. The committed
 * byte-pin tests stay hermetic on the seed fixtures: they regenerate with
 * an empty runtime set.
 */
export function regenerateEgressConfig(
  snapshotsDir: string = SNAPSHOTS_DIR,
  outPath: string = EGRESS_CONFIG_PATH,
  runtimeSnapshots: readonly PinnedSnapshot[] = [],
  excludedOAuthProviders: ReadonlySet<string> = new Set(),
): string {
  const snapshots = [...readPinnedSnapshots(snapshotsDir), ...runtimeSnapshots];
  // mergedEgressDomains prepends the base domains and dedupes, so the raw
  // per-snapshot domains pass through as-is (order-stable).
  const extensionDomains = snapshots.flatMap((s) => s.manifest.domains);
  // OAuth extensions (#198) move to the oauth_token transform (issue
  // #208): they get NO file-injection entry — the proxy mints their
  // access token. api_key extensions keep the file-injection entry.
  // Decision B (issue #265): non-renewable providers (access-only vault
  // credential — no refresh anywhere) are EXCLUDED from the oauth_token
  // mint entries — there is no refresh to mint from, and `require: true`
  // would 502 every runtime call; the boundary secrets injection carries
  // their access token instead.
  const extensionEntries = apiKeyExtensionEntries(snapshots);
  const oauthEntries = oauthTokenEntries(snapshots, excludedOAuthProviders);
  const yaml = renderEgressConfig(mergedEgressDomains(extensionDomains), extensionEntries, oauthEntries);
  writeFileSync(resolve(outPath), yaml);
  return yaml;
}

/**
 * Reads pinned snapshots from `snapshotsDir`, merges the RUNTIME set
 * (issue #233), and renders the dev-permissive config (allow-all + no
 * judge + secrets + management, issue #126) into `outPath` (default
 * config/egress.dev.yml), returning the rendered text. The dev config
 * carries the same injection entries as the strict one, so regenerating
 * both keeps them in lockstep. CLI:
 * `bun run src/egress/generate.ts`.
 */
export function regenerateDevEgressConfig(
  snapshotsDir: string = SNAPSHOTS_DIR,
  outPath: string = DEV_EGRESS_CONFIG_PATH,
  runtimeSnapshots: readonly PinnedSnapshot[] = [],
  excludedOAuthProviders: ReadonlySet<string> = new Set(),
): string {
  const snapshots = [...readPinnedSnapshots(snapshotsDir), ...runtimeSnapshots];
  const extensionEntries = apiKeyExtensionEntries(snapshots);
  const oauthEntries = oauthTokenEntries(snapshots, excludedOAuthProviders);
  const yaml = renderDevEgressConfig(extensionEntries, oauthEntries);
  writeFileSync(resolve(outPath), yaml);
  return yaml;
}

if (import.meta.main) {
  regenerateEgressConfig();
  regenerateDevEgressConfig();
  console.log(
    `egress configs regenerated: ${EGRESS_CONFIG_PATH} (strict) and ${DEV_EGRESS_CONFIG_PATH} (dev-permissive)`,
  );
}
