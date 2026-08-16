/**
 * Egress config generation (issue #50): config/egress.yml is a generated
 * artifact — the static iron-proxy template plus the allowlist merged from
 * the extension registry's pinned snapshots (extension `domains` entries)
 * and the secrets transform for boundary credential injection (issue #53).
 *
 * Run `bun run src/egress/generate.ts` after adding or updating snapshots in
 * config/extensions/; the committed config/egress.yml is the generated
 * output, and egress-config.test.ts pins it to the template (no drift).
 * Base model endpoints stay hardcoded here; extension domains append to
 * them, deduped. Default-deny enforcement is unchanged: extension domains
 * merely join the allowlist and still pass the judge transform.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPinnedSnapshots } from "../extensions/registry";
import { extensionSecretFileName, PROXY_SECRETS_MOUNT_PATH } from "../extensions/boundary";

/** Base allowlist (issue #8 scope): NEAR.ai model endpoints. */
export const BASE_EGRESS_DOMAINS = ["cloud-api.near.ai", "*.completions.near.ai"] as const;

/** Where pinned snapshots live; mounted/baked per deployment. */
export const SNAPSHOTS_DIR = "config/extensions";

/** The generated file (mounted by compose into iron-proxy). */
export const EGRESS_CONFIG_PATH = "config/egress.yml";

/** Base domains first, then extension domains, deduped, order-stable. */
export function mergedEgressDomains(extensionDomains: readonly string[]): string[] {
  const merged: string[] = [...BASE_EGRESS_DOMAINS];
  for (const domain of extensionDomains) {
    if (!merged.includes(domain)) merged.push(domain);
  }
  return merged;
}

/** One extension's credential-injection entry for the generated egress config (issue #53). */
export interface ExtensionEgressEntry {
  extensionId: string;
  /** The extension's allowlisted domains; the proxy injects auth for these hosts. */
  domains: string[];
}

/**
 * Renders the `secrets` transform (iron-proxy v0.49.0 inject mode, issue
 * #53): one entry per extension, sourcing the credential from the
 * extension's secret file (written by the runtime's boundary) and
 * injecting it as the Authorization header for the extension's domains.
 * The judge transform runs BEFORE secrets so the LLM judge sees no real
 * credentials (iron-proxy README's recommended ordering).
 */
export function renderSecretsTransform(extensions: readonly ExtensionEgressEntry[]): string {
  const entries = extensions
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
  return `  # 3. Secrets: boundary credential injection (issue #53). Extension calls
  #    carry no credential — the runtime resolves the caller's credential
  #    at call time and writes it to the extension's secret file on the
  #    shared data volume (mode 0600, write-temp + rename); this transform
  #    INJECTS it as the Authorization header for the extension's
  #    allowlisted domains before egress. The file source re-reads on
  #    config reload and on ttl expiry, so the credential rotates on a
  #    running proxy. Judge runs BEFORE secrets so the LLM judge never sees
  #    real credentials (iron-proxy README's recommended ordering).
  - name: secrets
    config:
      secrets:
${entries}
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
  const secretsTransform = extensions.length > 0 ? `${renderSecretsTransform(extensions)}\n` : "";
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
dns:
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
  #   docker run --rm -v \$PWD/certs:/certs ironsh/iron-proxy:0.49.0 generate-ca -outdir /certs
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

transforms:
  # 1. Static allowlist: NEAR.ai model endpoints (issue #8, #36) plus
  #    extension domains from config/extensions snapshots (issue #50).
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
 * Reads pinned snapshots from `snapshotsDir`, merges their domains into the
 * allowlist and their credential-injection entries into the secrets
 * transform (issue #53), writes config/egress.yml, and returns the
 * rendered text. Defaults are the deployment paths; CLI:
 * `bun run src/egress/generate.ts`.
 */
export function regenerateEgressConfig(
  snapshotsDir: string = SNAPSHOTS_DIR,
  outPath: string = EGRESS_CONFIG_PATH,
): string {
  const snapshots = readPinnedSnapshots(snapshotsDir);
  // mergedEgressDomains prepends the base domains and dedupes, so the raw
  // per-snapshot domains pass through as-is (order-stable).
  const extensionDomains = snapshots.flatMap((s) => s.manifest.domains);
  const extensionEntries = snapshots.map((s) => ({ extensionId: s.manifest.id, domains: s.manifest.domains }));
  const yaml = renderEgressConfig(mergedEgressDomains(extensionDomains), extensionEntries);
  writeFileSync(resolve(outPath), yaml);
  return yaml;
}

if (import.meta.main) {
  regenerateEgressConfig();
  console.log(`egress config regenerated: ${EGRESS_CONFIG_PATH}`);
}
