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
import type { ExtensionCredential } from "../store/db";

/** The server-side secrets directory (shared with iron-proxy via the data volume). */
export const PROXY_SECRETS_DIR = "data/proxy-secrets";

/** The proxy-side mount path of the same directory (the generated config's file sources). */
export const PROXY_SECRETS_MOUNT_PATH = "/data/proxy-secrets";

/** One secret file per extension; both the runtime writer and the generated config use this name. */
export function extensionSecretFileName(extensionId: string): string {
  return `${extensionId}.secret`;
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
          throw new Error(`extension credential boundary: proxy reload failed: ${(err as Error).message}`);
        }
        if (!res.ok) {
          throw new Error(`extension credential boundary: proxy reload failed (${res.status})`);
        }
      }
    },
  };
}
