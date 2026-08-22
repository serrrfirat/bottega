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
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
// The broker HTTP client comes from @oh-my-pi/pi-ai (the SDK's pinned
// transitive auth package, same 17.x release train) — no new dependency.
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { CredentialScope, ExtensionCredential } from "../store/db";
import type { CredentialTarget, CredentialType } from "./manifest";
import type { OrgSecretsBackendSettings, OrgSettings } from "../store/org-settings";
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
 * Post the extension boundary's proxy-control reload (issue #123) and return
 * the raw Response. Callers apply their own status/error policy — the
 * call-scoped boundary throws (fail closed), the egress/catalog writers warn
 * and keep the regenerated config (best effort). Shared so the hand-rolled
 * `fetch(.../v1/reload, { method: "POST", headers })` isn't duplicated at
 * each reload site (catalog-register, egress-reconcile, boundary).
 */
export async function postProxyReload(
  control: { proxyControlUrl?: string; proxyControlToken?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(`${control.proxyControlUrl}/v1/reload`, {
    method: "POST",
    headers: control.proxyControlToken
      ? { Authorization: `Bearer ${control.proxyControlToken}` }
      : undefined,
  });
}

/**
 * The credential reference a secret resolver resolves (issue #190) —
 * metadata only, the same fields the ladder's registry row carries; the
 * secret payload never enters it.
 */
export interface SecretResolverRef {
  provider: string;
  vaultProvider?: string;
  identityKey: string;
  scope: CredentialScope;
  owner: string | null;
  /** The OMP auth-broker vault row id — omp-broker backend only. */
  brokerCredentialId?: number;
}

/** What a resolver returns: the credential kind + the secret payload itself. */
export type SecretResolution = { type: CredentialType; secret: string };

/**
 * The pluggable secret resolver (issue #190): the boundary's fetch half.
 * An implementation resolves a credential reference to its secret payload
 * from the deployment's configured vault backend; the boundary writes that
 * payload to the extension's secret file and iron-proxy injects it. Fail
 * closed: an unknown backend or a resolution failure throws — the
 * extension call errors, it never runs with a wrong or missing credential.
 * The secret is only ever returned to the boundary — it never reaches the
 * agent env, transcripts, or audit.
 */
export interface SecretResolver {
  resolve(ref: SecretResolverRef): Promise<SecretResolution>;
}

/** Adapts a registry row to the resolver's reference shape. */
function toSecretResolverRef(credential: ExtensionCredential): SecretResolverRef {
  return {
    provider: credential.provider,
    vaultProvider: credential.vault_provider,
    identityKey: credential.identity_key,
    scope: credential.scope,
    owner: credential.owner,
    brokerCredentialId: credential.broker_credential_id,
  };
}

/**
 * The omp-broker secret resolution core (the boundary's fetch half, issue
 * #54 wiring shipped with #143): given the ladder's resolved registry
 * credential, returns the SECRET PAYLOAD (+ its kind) from the OMP
 * auth-broker vault so the boundary can write the extension's secret file
 * (iron-proxy injects it).
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
async function resolveBrokerSecret(env: NodeJS.ProcessEnv, ref: SecretResolverRef): Promise<SecretResolution> {
  const brokerUrl = env.OMP_AUTH_BROKER_URL;
  const brokerToken = env.OMP_AUTH_BROKER_TOKEN;
  if (!brokerUrl || !brokerToken) {
    throw new Error(
      "extension credential boundary: broker secret resolution is not configured — set OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN " +
        "(local dev: `bun run dev` starts the auth-broker vault and exports both; deployment: copy the token from the data volume " +
        "`docker compose exec auth-broker cat /data/.omp/auth-broker.token` into .env)",
    );
  }
  if (ref.brokerCredentialId === undefined) {
    throw new Error(
      `extension credential boundary: the omp-broker resolver needs the registry row's broker credential id for "${ref.provider}" — none was recorded`,
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
    (candidate) => candidate.id === ref.brokerCredentialId && candidate.provider === (ref.vaultProvider ?? ref.provider),
  );
  if (!entry) {
    throw new Error(
      `extension credential boundary: the broker has no vault row ${ref.brokerCredentialId} for connection provider "${ref.provider}" — reconnect the selected connection`,
    );
  }
  if (entry.credential.type === "api_key") return { type: "api_key", secret: entry.credential.key };
  if (entry.credential.type === "oauth") return { type: "oauth", secret: entry.credential.access };
  throw new Error(
    `extension credential boundary: unsupported vault credential type "${entry.credential["type"]}" for ${ref.provider}`,
  );
}

/**
 * The original broker resolver signature (issue #54 wiring, #143): returns
 * just the secret payload for a registry credential. Behavior is
 * byte-identical to the omp-broker {@link SecretResolver} backend — this is
 * the thin legacy wrapper.
 */
export function brokerSecretResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): (credential: ExtensionCredential) => Promise<string> {
  return async (credential: ExtensionCredential): Promise<string> =>
    (await resolveBrokerSecret(env, toSecretResolverRef(credential))).secret;
}

/**
 * The `omp-broker` {@link SecretResolver} backend (issue #190): the
 * deployment default, backed by the OMP auth-broker vault — the current
 * resolver, behavior unchanged. The OAuth lifecycle (token refresh) lives
 * here; see {@link resolveBrokerSecret} for the env contract + fail-closed
 * rules.
 */
export function ompBrokerResolverFromEnv(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return { resolve: (ref) => resolveBrokerSecret(env, ref) };
}

/**
 * The `1password-connect` {@link SecretResolver} backend (issue #190):
 * resolves static credentials (API keys / PATs) from an org's 1Password
 * Connect server.
 *
 * Mapping (the org's config, in the settings blob): `secrets_backend` maps
 * `"<provider>:<identityKey>"` (the credential row's provider + identity
 * key — the same readable identity the connect flow records) to the
 * 1Password location `{vault, item, field}`. The field value is the
 * secret; `field` matches the Connect item field by id OR label. The
 * entry's optional `type` declares the credential kind (default `api_key`;
 * the boundary only consumes the payload, oauth refresh stays with the
 * omp-broker backend).
 *
 * The Connect access token is a SECRET: it lives in env/.env as
 * `OP_CONNECT_TOKEN` (the standard Connect env var), read lazily at
 * resolve time like the broker token — the server boots without it and
 * fails closed on the first extension call. The Connect REST API is a
 * plain `fetch` client (no new dependency).
 *
 * Fail closed: missing mapping → throws (never a wrong credential);
 * missing token → throws before any fetch; a non-2xx item fetch (bad
 * token / missing vault/item) → throws; a field without a value → throws.
 */
export function onePasswordConnectResolver(
  backend: OrgSecretsBackendSettings,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  return {
    async resolve(ref: SecretResolverRef): Promise<SecretResolution> {
      const connectUrl = backend.connectUrl;
      if (connectUrl === undefined || connectUrl === "") {
        throw new Error(
          "extension credential boundary: 1password-connect needs secrets_backend.connect_url (the Connect server base URL)",
        );
      }
      const mapping = backend.mapping ?? {};
      const key = `${ref.provider}:${ref.identityKey}`;
      const entry = mapping[key];
      if (!entry) {
        throw new Error(
          `extension credential boundary: no 1Password mapping for "${key}" — add secrets_backend.mapping["${key}"] = {vault, item, field}`,
        );
      }
      const token = env.OP_CONNECT_TOKEN;
      if (!token) {
        throw new Error(
          "extension credential boundary: 1Password Connect token is not configured — set OP_CONNECT_TOKEN in .env (the Connect server's access token)",
        );
      }
      let res: Response;
      try {
        res = await fetch(`${connectUrl}/v1/vaults/${entry.vault}/items/${entry.item}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        throw new Error(`extension credential boundary: 1Password Connect fetch failed: ${errorMessage(err)}`);
      }
      if (!res.ok) {
        throw new Error(
          `extension credential boundary: 1Password Connect item fetch failed (${res.status}) — check connect_url, OP_CONNECT_TOKEN, and the vault/item ids`,
        );
      }
      let item: { fields?: Array<{ id?: string; label?: string; value?: string }> };
      try {
        // SAFETY: the 1Password Connect items API returns the item object; the shape is
        // deliberately defensive (every field optional) so a malformed response simply
        // yields no matching field and fails with the clear "no field" error below.
        item = (await res.json()) as typeof item;
      } catch (err) {
        throw new Error(`extension credential boundary: 1Password Connect returned a malformed item: ${errorMessage(err)}`);
      }
      const field = (item.fields ?? []).find(
        (candidate) => candidate.id === entry.field || candidate.label === entry.field,
      );
      if (!field) {
        throw new Error(
          `extension credential boundary: 1Password item ${entry.item} has no field "${entry.field}" (matched by id or label)`,
        );
      }
      const secret = field.value;
      if (secret === undefined || secret === "") {
        throw new Error(
          `extension credential boundary: 1Password field "${entry.field}" has no value — the Connect token needs read access to it`,
        );
      }
      return { type: entry.type ?? "api_key", secret };
    },
  };
}

/**
 * Picks the deployment's {@link SecretResolver} at boot (issue #190) from
 * the org settings blob's `secrets_backend` knob. Unset (or explicitly
 * `omp-broker`) → the omp-broker backend, behavior byte-identical to the
 * pre-#190 boundary. `1password-connect` → the Connect backend, configured
 * from the blob (connect_url + mapping); its token stays in env.
 * Unknown types are unreachable through the settings validator
 * (parseOrgSettingsJson rejects them) but fail closed here anyway — a
 * resolver must never silently fall back to the default.
 */
export function secretResolverFromSettings(
  settings: OrgSettings | null,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  const backend = settings?.secretsBackend;
  if (backend === undefined || backend.type === "omp-broker") return ompBrokerResolverFromEnv(env);
  if (backend.type === "1password-connect") return onePasswordConnectResolver(backend, env);
  throw new Error(`extension credential boundary: unknown secrets_backend type "${backend["type"]}"`);
}

/** Prepared replacement keeps the new secret staged until activation. */
export interface CredentialReplacementPreparation {
  activate(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Marker pair emitted inside the generated secrets list. The boundary only
 * rewrites this bounded region; the reviewed egress policy stays immutable.
 */
export const SCOPED_AUTHORIZATIONS_BEGIN = "        # bottega:scoped-authorizations begin";
export const SCOPED_AUTHORIZATIONS_END = "        # bottega:scoped-authorizations end";

/** Default maximum lifetime for one extension authorization. */
export const DEFAULT_AUTHORIZATION_TTL_MS = 120_000;

/** Opaque authority passed to a provider transport. It contains no secret. */
export interface AuthorizationContext {
  readonly callId: string;
  readonly placeholder: string;
  readonly signal: AbortSignal;
}

export interface ConnectionBoundary {
  prepareReplacement(
    current: ExtensionCredential,
    replacement: ExtensionCredential,
  ): Promise<CredentialReplacementPreparation>;
  disconnect(credential: ExtensionCredential): Promise<void>;
}

export interface AuthorizationRequest {
  credential: ExtensionCredential;
  targets: readonly CredentialTarget[];
  /** Redacted correlation id recorded by the runtime audit. */
  callId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The boundary owns the whole authorization lifetime. The callback cannot
 * outlive its proxy mapping: success, failure, timeout, and abort all revoke
 * in `finally`.
 */
export interface CredentialBoundary {
  runWithAuthorization<T>(
    request: AuthorizationRequest,
    invoke: (context: AuthorizationContext) => Promise<T>,
  ): Promise<T>;
}

interface ActiveAuthorization {
  fileId: string;
  placeholder: string;
  targets: readonly CredentialTarget[];
}

export interface SecretFileBoundaryOpts {
  resolver?: SecretResolver;
  resolveSecret?: (credential: ExtensionCredential) => Promise<string>;
  /** Host-side directory shared with iron-proxy at PROXY_SECRETS_MOUNT_PATH. */
  secretsDir?: string;
  /** Mutable config file the running proxy reloads. */
  proxyConfigPath?: string;
  proxyControlUrl?: string;
  proxyControlToken?: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Deterministic expiry seam; returns a cancellation function. */
  scheduleExpiry?: (expire: () => void, timeoutMs: number) => () => void;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Renders active call mappings in iron-proxy's token-replacement mode. */
export function renderScopedAuthorizationEntries(
  authorizations: readonly {
    fileId: string;
    placeholder: string;
    targets: readonly CredentialTarget[];
  }[],
): string {
  return authorizations
    .map((authorization) => {
      const rules = authorization.targets
        .map((target) => {
          const paths =
            target.pathPrefix === undefined
              ? ""
              : target.pathPrefix === "/"
                ? "\n              paths: [\"/*\"]"
                : `\n              paths: [${yamlString(target.pathPrefix)}, ${yamlString(`${target.pathPrefix}/*`)}]`;
          return `            - host: ${yamlString(target.host)}${paths}`;
        })
        .join("\n");
      return `        - source:
            type: file
            path: ${yamlString(`${PROXY_SECRETS_MOUNT_PATH}/scoped/${authorization.fileId}.secret`)}
            ttl: "0s"
          replace:
            proxy_value: ${yamlString(authorization.placeholder)}
            match_headers: ["Authorization"]
            match_body: false
            match_query: false
            match_path: false
          rules:
${rules}`;
    })
    .join("\n");
}

function replaceScopedAuthorizationBlock(config: string, entries: string): string {
  const begin = config.indexOf(SCOPED_AUTHORIZATIONS_BEGIN);
  const end = config.indexOf(SCOPED_AUTHORIZATIONS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "extension credential boundary: proxy config has no scoped-authorization markers — regenerate egress config",
    );
  }
  const afterBegin = begin + SCOPED_AUTHORIZATIONS_BEGIN.length;
  const body = entries === "" ? "\n" : `\n${entries}\n`;
  return `${config.slice(0, afterBegin)}${body}${config.slice(end)}`;
}

const abortReasonSchema = z.union([z.instanceof(Error), z.string()]);
type AbortReasonPayload = z.input<typeof abortReasonSchema>;

function abortError(reason: AbortReasonPayload): Error {
  const parsed = abortReasonSchema.safeParse(reason);
  if (!parsed.success) return new Error("authorization aborted");
  return parsed.data instanceof Error ? parsed.data : new Error(parsed.data);
}

/**
 * File-backed call-scoped proxy boundary. Each live call gets a random proxy
 * token and a distinct mode-0600 secret file. Config updates are serialized,
 * but provider callbacks overlap; the applied config contains every live
 * mapping, so one caller can never overwrite another caller's authority.
 */
export function createSecretFileBoundary(
  opts: SecretFileBoundaryOpts = {},
): CredentialBoundary & ConnectionBoundary {
  const secretsDir = opts.secretsDir ?? process.env.BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR;
  const proxyConfigPath = opts.proxyConfigPath ?? process.env.BOTTEGA_PROXY_CONFIG_PATH;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveSecret = opts.resolver
    ? async (credential: ExtensionCredential): Promise<string> =>
        (await opts.resolver!.resolve(toSecretResolverRef(credential))).secret
    : opts.resolveSecret ??
      (() => {
        throw new Error(
          "extension credential boundary: no broker secret resolver wired — refusing an unauthenticated call",
        );
      });
  const active = new Map<string, ActiveAuthorization>();
  let queue: Promise<void> = Promise.resolve();
  let initialized = false;

  function assertSafeTestDirectory(): void {
    if (process.env.NODE_ENV === "test" && resolve(secretsDir) === resolve(PROXY_SECRETS_DIR)) {
      throw new Error(
        "extension credential boundary: refusing the live default secrets dir under test — pass an explicit temp secretsDir (issue #191)",
      );
    }
  }

  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = queue;
    const next = Promise.withResolvers<void>();
    queue = next.promise;
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve();
    }
  };

  const reload = async (required: boolean): Promise<void> => {
    if (!opts.proxyControlUrl) {
      if (required) {
        throw new Error(
          "extension credential boundary: scoped authorization requires BOTTEGA_PROXY_CONTROL_URL and BOTTEGA_PROXY_CONTROL_TOKEN",
        );
      }
      return;
    }
    if (required && !opts.proxyControlToken) {
      throw new Error(
        "extension credential boundary: scoped authorization requires BOTTEGA_PROXY_CONTROL_URL and BOTTEGA_PROXY_CONTROL_TOKEN",
      );
    }
    let response: Response;
    try {
      response = await postProxyReload(
        { proxyControlUrl: opts.proxyControlUrl, proxyControlToken: opts.proxyControlToken },
        fetchImpl,
      );
    } catch (err) {
      throw new Error(`extension credential boundary: proxy reload failed: ${errorMessage(err)}`);
    }
    if (!response.ok) {
      throw new Error(`extension credential boundary: proxy reload failed (${response.status})`);
    }
  };

  const apply = async (): Promise<void> => {
    if (!proxyConfigPath) {
      throw new Error(
        "extension credential boundary: BOTTEGA_PROXY_CONFIG_PATH is required for request-scoped authorization",
      );
    }
    const current = readFileSync(proxyConfigPath, "utf8");
    const entries = renderScopedAuthorizationEntries([...active.values()]);
    const next = replaceScopedAuthorizationBlock(current, entries);
    const tmp = `${proxyConfigPath}.tmp`;
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, proxyConfigPath);
    await reload(true);
  };

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    active.clear();
    rmSync(join(secretsDir, "scoped"), { recursive: true, force: true });
    mkdirSync(join(secretsDir, "scoped"), { recursive: true });
    await apply();
    initialized = true;
  };

  const revoke = async (fileId: string): Promise<void> => {
    await locked(async () => {
      if (!active.delete(fileId)) return;
      // Delete the secret first. Even if config cleanup/reload fails, the
      // currently applied mapping can no longer resolve any authority.
      rmSync(join(secretsDir, "scoped", `${fileId}.secret`), { force: true });
      await apply();
    });
  };

  return {
    async runWithAuthorization(request, invoke) {
      if (request.targets.length === 0) {
        throw new Error("extension credential boundary: reviewed credential targets are required");
      }
      assertSafeTestDirectory();
      if (request.signal?.aborted) throw abortError(request.signal.reason);

      const secret = await resolveSecret(request.credential);
      const fileId = randomUUID();
      const placeholder = `bottega-call-${randomUUID()}`;
      const controller = new AbortController();
      const timeoutMs = request.timeoutMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("extension credential boundary: timeoutMs must be a positive integer");
      }
      const onCallerAbort = (): void => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const expire = (): void =>
        controller.abort(new Error(`extension authorization expired after ${timeoutMs}ms`));
      const cancelExpiry =
        opts.scheduleExpiry?.(expire, timeoutMs) ??
        (() => {
          const timer = setTimeout(expire, timeoutMs);
          return () => clearTimeout(timer);
        })();

      try {
        await locked(async () => {
          await initialize();
          const scopedDir = join(secretsDir, "scoped");
          mkdirSync(scopedDir, { recursive: true });
          const tmp = join(scopedDir, `${fileId}.secret.tmp`);
          const final = join(scopedDir, `${fileId}.secret`);
          writeFileSync(tmp, secret, { mode: 0o600 });
          renameSync(tmp, final);
          active.set(fileId, { fileId, placeholder, targets: request.targets });
          try {
            await apply();
          } catch (err) {
            active.delete(fileId);
            rmSync(final, { force: true });
            try {
              await apply();
            } catch {
              // Secret deletion is the fail-closed cleanup. Preserve the
              // original activation error; no credential remains usable.
            }
            throw err;
          }
        });

        const abortRace = Promise.withResolvers<never>();
        controller.signal.addEventListener(
          "abort",
          () => abortRace.reject(abortError(controller.signal.reason)),
          { once: true },
        );
        return await Promise.race([
          invoke({ callId: request.callId, placeholder, signal: controller.signal }),
          abortRace.promise,
        ]);
      } finally {
        cancelExpiry();
        request.signal?.removeEventListener("abort", onCallerAbort);
        controller.abort(new Error("extension authorization revoked"));
        await revoke(fileId);
      }
    },

    async prepareReplacement(current, replacement) {
      assertSafeTestDirectory();
      if (current.id !== replacement.id || current.provider !== replacement.provider) {
        throw new Error("extension credential boundary: replacement target does not match the current connection");
      }
      const secret = await resolveSecret(replacement);
      mkdirSync(secretsDir, { recursive: true });
      const fileName = extensionSecretFileName(current.provider);
      const finalPath = join(secretsDir, fileName);
      const stagedPath = join(secretsDir, `${fileName}.${current.id}.staged`);
      const backupPath = join(secretsDir, `${fileName}.${current.id}.backup`);
      writeFileSync(stagedPath, secret, { mode: 0o600 });
      let activated = false;
      return {
        async activate() {
          if (activated) return;
          const hadCurrent = existsSync(finalPath);
          if (hadCurrent) renameSync(finalPath, backupPath);
          renameSync(stagedPath, finalPath);
          try {
            await reload(false);
          } catch (activationError) {
            rmSync(finalPath, { force: true });
            if (hadCurrent && existsSync(backupPath)) renameSync(backupPath, finalPath);
            try {
              await reload(false);
            } catch (rollbackError) {
              throw new Error(
                `extension credential boundary: replacement activation failed and rollback reload failed: ${errorMessage(
                  activationError,
                )}; ${errorMessage(rollbackError)}`,
              );
            }
            throw activationError;
          }
          rmSync(backupPath, { force: true });
          activated = true;
        },
        async rollback() {
          if (!activated) rmSync(stagedPath, { force: true });
        },
      };
    },

    async disconnect(credential) {
      assertSafeTestDirectory();
      const finalPath = join(secretsDir, extensionSecretFileName(credential.provider));
      rmSync(finalPath, { force: true });
      await reload(false);
    },
  };
}
