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
 * Issue #208 (proxy-only credentials) adds the model-gateway static-key
 * entries to the secrets transform (the providers' placeholder bearer
 * swapped for the real key at egress, require: true — fail closed). Issue
 * #230 moves the codex provider (the ChatGPT subscription credential) to
 * the STATIC-key entries: the SEED owns the codex refresh and writes the
 * access token to openai-codex.secret — the proxy never touches
 * auth.openai.com. Issue #284 removes the extension `oauth_token`
 * transform entirely: OAuth for hosted MCP extensions is owned by the MCP
 * SDK (the runtime's OAuthClientProvider sends the bearer through the
 * allowlisted host), so the proxy is transport/allowlist only and never
 * mints or holds extension OAuth credentials.
 *
 * Run `bun run src/egress/generate.ts` after adding or updating snapshots in
 * config/extensions/; the committed config/egress.yml (strict, deployment)
 * and config/egress.dev.yml (dev-permissive, issue #126) are the generated
 * outputs, and egress-config.test.ts / generate.test.ts pin them to the
 * templates (no drift). The gateway hosts derive from MODEL_GATEWAY_KEYS
 * (one source of truth for allowlist + spec); the remaining base endpoints
 * stay hardcoded here; extension
 * domains append to them, deduped. Default-deny enforcement is unchanged:
 * extension domains merely join the allowlist and still pass the judge
 * transform. The DEV config is the ONLY permissive surface: allow-all
 * allowlist + no judge, secrets + management kept — local testing only.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPinnedSnapshots, type PinnedSnapshot } from "../extensions/registry";
import {
  PROXY_SECRETS_MOUNT_PATH,
  SCOPED_AUTHORIZATIONS_BEGIN,
  SCOPED_AUTHORIZATIONS_END,
} from "../extensions/boundary";

/** Reviewed credential targets retained separately from general egress reachability. */
export interface ExtensionEgressEntry {
  extensionId: string;
  credentialTargets: PinnedSnapshot["manifest"]["credentialTargets"];
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
  // The Tavily web-search gateway (issue #278): the search_web tool's
  // outbound call to api.tavily.com/search sends the placeholder bearer;
  // the proxy injects the real key from data/proxy-secrets/tavily.secret
  // (seeded at boot — require: true, so a missing key rejects the request
  // closed instead of reaching the provider unauthenticated).
  { provider: "tavily", host: "api.tavily.com" },
] as const;

/** The gateway host for a provider, from {@link MODEL_GATEWAY_KEYS} — the
 * single source of truth shared by the base allowlist and the spec tests,
 * so one edit to a gateway host updates both. */
export function gatewayHost(provider: string): string {
  const key = MODEL_GATEWAY_KEYS.find((k) => k.provider === provider);
  if (!key) throw new Error(`egress base allowlist: unknown gateway provider "${provider}"`);
  return key.host;
}

/** Base allowlist: model gateways (NEAR.ai, OpenAI, Anthropic — issue #8,
 * #36, #37ee2bf) plus the opencode-go gateway (issue #208 — the pinned
 * deepseek-v4-flash routes to opencode.ai/zen/go/v1), the ChatGPT Codex
 * gateway (issue #214 — the openai-codex provider's
 * chatgpt.com/backend-api/codex/responses), the example KB host
 * (issue #91), the server's OWN Slack traffic (issue #126 — the Web API
 * at slack.com/api/* and api.slack.com, the Socket Mode websocket on
 * *.slack.com, and file downloads on files.slack.com, issue #124), and
 * the GitHub API for the ingest poller (issue #57, mentions search), and
 * the Tavily web-search gateway (issue #278 — the search_web tool's
 * provider host, api.tavily.com). */
export const BASE_EGRESS_DOMAINS = [
  gatewayHost("near"),
  "*.completions.near.ai",
  gatewayHost("opencode"),
  gatewayHost("openai-codex"),
  gatewayHost("openai"),
  gatewayHost("anthropic"),
  gatewayHost("tavily"),
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

/** Reviewed credential-target summaries for authenticated extensions. */
export function credentialTargetEntries(
  snapshots: ReturnType<typeof readPinnedSnapshots>,
): ExtensionEgressEntry[] {
  return snapshots.map((snapshot) => ({
    extensionId: snapshot.manifest.id,
    credentialTargets: snapshot.manifest.credentialTargets,
  }));
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

/**
 * Empty call-scoped region. The runtime boundary atomically fills this
 * bounded region with opaque-token replacement entries for live calls only.
 */
function renderScopedAuthorizationRegion(): string {
  return `${SCOPED_AUTHORIZATIONS_BEGIN}
${SCOPED_AUTHORIZATIONS_END}`;
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
export function renderSecretsTransform(_extensions: readonly ExtensionEgressEntry[] = []): string {
  const gatewayEntries = renderModelGatewayEntries(MODEL_GATEWAY_KEYS);
  return `  # 3. Secrets: request-scoped extension authorization plus static
  #    model-gateway keys. Extension calls carry a random per-call proxy
  #    token. The credential boundary installs its token-to-secret mapping
  #    only for the call lifetime and only for reviewed credential targets,
  #    then revokes it in finally. Egress domains remain reachability policy
  #    and never grant credential authority.
  - name: secrets
    config:
      secrets:
${renderScopedAuthorizationRegion()}
${gatewayEntries}
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
): string {
  const domainLines = domains.map((domain) => `        - "${domain}"`).join("\n");
  // The secrets transform is always emitted: the model-gateway static-key
  // entries (issue #208) are base config — only the extension entries are
  // optional.
  const secretsTransform = `${renderSecretsTransform(extensions)}\n`;
  // Issue #284: there is NO oauth_token transform — OAuth for hosted MCP
  // extensions is owned by the MCP SDK (the runtime's OAuthClientProvider
  // sends the bearer through the allowlisted host); the proxy is
  // transport/allowlist only and never mints tokens. The codex MODEL
  // provider's access token is a STATIC secrets entry (issue #230 — the
  // seed owns the refresh), so no transform is emitted for it either.
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

${secretsTransform}log:
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
  return renderSecretsTransform(extensions).replace(
    "  # 3. Secrets:",
    "  # 2. Secrets:",
  );
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
): string {
  // The secrets transform is always emitted: the model-gateway static-key
  // entries (issue #208) are base config — only the extension entries are
  // optional. Issue #284: no oauth_token transform — hosted-MCP OAuth is
  // the SDK's job, the proxy never mints.
  const secretsTransform = `${renderDevSecretsTransform(extensions)}\n`;
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

${secretsTransform}log:
  level: "info"
`;
}

/**
 * Reads pinned snapshots from `snapshotsDir`, merges the RUNTIME set
 * (issue #233: the store-backed runtime-registered extensions — machine
 * state, never a repo file) into the allowlist and the credential-injection
 * entries (issue #53), writes config/egress.yml, and returns the rendered
 * text. Issue #284: OAuth extensions get NO egress entry of any kind —
 * their domains stay allowlisted (the SDK's bearer passes through the
 * proxy transport), but the proxy never holds or mints their credentials.
 * api_key extensions keep the file-injection entry (issue #53). Defaults
 * are the deployment paths; CLI: `bun run src/egress/generate.ts`. The
 * committed byte-pin tests stay hermetic on the seed fixtures: they
 * regenerate with an empty runtime set.
 */
export function regenerateEgressConfig(
  snapshotsDir: string = SNAPSHOTS_DIR,
  outPath: string = EGRESS_CONFIG_PATH,
  runtimeSnapshots: readonly PinnedSnapshot[] = [],
): string {
  const snapshots = [...readPinnedSnapshots(snapshotsDir), ...runtimeSnapshots];
  // mergedEgressDomains prepends the base domains and dedupes, so the raw
  // per-snapshot domains pass through as-is (order-stable).
  const extensionDomains = snapshots.flatMap((snapshot) => snapshot.manifest.domains);
  const extensionEntries = credentialTargetEntries(snapshots);
  const yaml = renderEgressConfig(mergedEgressDomains(extensionDomains), extensionEntries);
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
): string {
  const snapshots = [...readPinnedSnapshots(snapshotsDir), ...runtimeSnapshots];
  const extensionEntries = credentialTargetEntries(snapshots);
  const yaml = renderDevEgressConfig(extensionEntries);
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
