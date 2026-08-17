/**
 * Extension credential boundary (issue #53): the seam where the runtime's
 * resolved credential meets the egress proxy. Credentials never enter the
 * agent env, transcripts, or audit — they travel no further than the
 * boundary, and the provider call carries no credential at all.
 *
 * iron-proxy's `secrets` transform in INJECT mode (README "Boundary-level
 * secret injection", v0.49.0): "the proxy always sets the header on
 * matching requests — the client does not need to send any credential."
 * The generated egress config (src/egress) emits one inject entry per
 * extension: `Authorization: Bearer <secret>` for the extension's
 * allowlisted domains, sourced from a FILE the runtime writes.
 *
 * The file source is re-read on config reload (POST /v1/reload) and on
 * `ttl` expiry, so the runtime can rotate the credential on a running
 * proxy: write-temp + rename (the rotation pattern iron-proxy documents),
 * then best-effort reload.
 *
 * File naming is shared with the generated config: the server writes
 * `${secretsDir}/${extensionSecretFileName(id)}` (default data/proxy-secrets
 * on the shared data volume) and the config reads
 * `${PROXY_SECRETS_MOUNT_PATH}/${extensionSecretFileName(id)}` (the same
 * volume at /data on the proxy side).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The broker HTTP client comes from @oh-my-pi/pi-ai (the SDK's pinned
// transitive auth package, same 17.x release train) — no new dependency.
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { ExtensionCredential } from "../store/db";
import { errorMessage } from "../tools/helpers";

/** The server-side secrets directory (shared with iron-proxy via the data volume). */
export const PROXY_SECRETS_DIR = "data/proxy-secrets";

/** The proxy-side mount path of the same directory (the generated config's file sources). */
export const PROXY_SECRETS_MOUNT_PATH = "/data/proxy-secrets";

/** One secret file per extension; both the runtime writer and the generated config use this name. */
export function extensionSecretFileName(extensionId: string): string {
  return `${extensionId}.secret`;
}

/**
 * Proxy control wiring for the boundary (issue #123): the reload half needs
 * BOTH the management URL and its bearer token — a token-less reload would
 * 401 and fail every extension call, so the pair gates together. Unset
 * (hermetic tests, unconfigured deployments) stays write-only.
 *
 * Env contract (set by scripts/dev.sh locally, by docker-compose.yml in
 * deployment): `BOTTEGA_PROXY_CONTROL_URL` (management API base) and
 * `BOTTEGA_PROXY_CONTROL_TOKEN` (the config's `management.api_key_env`
 * value, mirrored to the proxy as `IRON_MANAGEMENT_API_KEY`).
 */
export function proxyBoundaryControlFromEnv(env: NodeJS.ProcessEnv = process.env): {
  proxyControlUrl?: string;
  proxyControlToken?: string;
} {
  const proxyControlUrl = env.BOTTEGA_PROXY_CONTROL_URL;
  const proxyControlToken = env.BOTTEGA_PROXY_CONTROL_TOKEN;
  return proxyControlUrl && proxyControlToken ? { proxyControlUrl, proxyControlToken } : {};
}

/**
 * The broker secret resolver (the boundary's fetch half, issue #54 wiring
 * shipped with #143): given the ladder's resolved registry credential,
 * returns the SECRET PAYLOAD from the OMP auth-broker vault so the
 * boundary can write the extension's secret file (iron-proxy injects it).
 *
 * Env contract (set by scripts/dev.sh locally, by docker-compose.yml in
 * deployment): `OMP_AUTH_BROKER_URL` (broker base, e.g.
 * http://127.0.0.1:8765 or http://auth-broker:8765) and
 * `OMP_AUTH_BROKER_TOKEN` (the vault's bearer token, bootstrapped to
 * /data/.omp/auth-broker.token on the shared data volume).
 *
 * Fail closed: URL or token missing → the resolved call throws before any
 * fetch (an unauthenticated provider call must never proceed); the vault
 * row missing → throws; an unsupported vault credential shape → throws.
 * The check is lazy (at resolve time, reading the live env object) so the
 * server still BOOTS without broker env — the boundary fails closed on the
 * first extension call, the #53 contract. The secret itself is only ever
 * returned to the boundary — it never reaches the caller, transcripts, or
 * audit.
 */
export function brokerSecretResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): (credential: ExtensionCredential) => Promise<string> {
  return async (credential: ExtensionCredential): Promise<string> => {
    const brokerUrl = env.OMP_AUTH_BROKER_URL;
    const brokerToken = env.OMP_AUTH_BROKER_TOKEN;
    if (!brokerUrl || !brokerToken) {
      throw new Error(
        "extension credential boundary: broker secret resolution is not configured — set OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN " +
          "(local dev: `bun run dev` starts the auth-broker vault and exports both; deployment: copy the token from the data volume " +
          "`docker compose exec auth-broker cat /data/.omp/auth-broker.token` into .env)",
      );
    }
    // A fresh client per call: rotation of the broker token applies to the
    // next extension call without a server restart, and the snapshot is
    // always current (the broker is the canonical writer).
    const client = new AuthBrokerClient({ url: brokerUrl, token: brokerToken });
    const result = await client.fetchSnapshot();
    if (result.status !== 200) {
      throw new Error(`extension credential boundary: broker snapshot fetch failed (status ${result.status})`);
    }
    const entry = result.snapshot.credentials.find(
      (candidate) => candidate.id === credential.broker_credential_id && candidate.provider === credential.provider,
    );
    if (!entry) {
      throw new Error(
        `extension credential boundary: the broker has no "${credential.provider}" vault row ${credential.broker_credential_id} — re-run connect ${credential.provider} as me|org`,
      );
    }
    if (entry.credential.type === "api_key") return entry.credential.key;
    if (entry.credential.type === "oauth") return entry.credential.access;
    throw new Error(
      `extension credential boundary: unsupported vault credential type "${entry.credential["type"]}" for ${credential.provider}`,
    );
  };
}

/**
 * The boundary contract. `authorize` makes the resolved credential
 * available to the proxy for the extension's allowlisted domains (writes
 * the secret file + best-effort reload). The credential payload itself is
 * never returned to the caller.
 */
export interface CredentialBoundary {
  authorize(credential: ExtensionCredential): Promise<void>;
}

export interface SecretFileBoundaryOpts {
  /**
   * Fetches the secret payload for the resolved credential from the auth
   * broker (account-pool-scoped, issue #51). The broker client lands with
   * issue #54; until then, missing resolvers fail closed with a clear
   * error instead of running calls without a credential.
   */
  resolveSecret?: (credential: ExtensionCredential) => Promise<string>;
  /** Directory for secret files; defaults to PROXY_SECRETS_DIR (env-overridable). */
  secretsDir?: string;
  /** iron-proxy management API base (e.g. http://iron-proxy:9092); unset → write-only, no reload. */
  proxyControlUrl?: string;
  /** Bearer token for the management API (the config's api_key_env value). */
  proxyControlToken?: string;
}

/**
 * The real boundary: writes the resolved secret to the extension's file
 * (mode 0600, atomic write-temp + rename) and best-effort reloads the
 * proxy when a control URL is set.
 */
export function createSecretFileBoundary(opts: SecretFileBoundaryOpts = {}): CredentialBoundary {
  const secretsDir = opts.secretsDir ?? process.env.BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR;
  const resolveSecret =
    opts.resolveSecret ??
    (() => {
      throw new Error(
        "extension credential boundary: no broker secret resolver wired (issue #54) — the call would run unauthenticated, failing closed",
      );
    });
  return {
    async authorize(credential) {
      const secret = await resolveSecret(credential);
      const fileName = extensionSecretFileName(credential.provider);
      mkdirSync(secretsDir, { recursive: true });
      const tmpPath = join(secretsDir, `${fileName}.tmp`);
      const finalPath = join(secretsDir, fileName);
      writeFileSync(tmpPath, secret, { mode: 0o600 });
      renameSync(tmpPath, finalPath);
      if (opts.proxyControlUrl) {
        let res: Response;
        try {
          res = await fetch(`${opts.proxyControlUrl}/v1/reload`, {
            method: "POST",
            headers: opts.proxyControlToken
              ? { Authorization: `Bearer ${opts.proxyControlToken}` }
              : undefined,
          });
        } catch (err) {
          throw new Error(`extension credential boundary: proxy reload failed: ${errorMessage(err)}`);
        }
        if (!res.ok) {
          throw new Error(`extension credential boundary: proxy reload failed (${res.status})`);
        }
      }
    },
  };
}
