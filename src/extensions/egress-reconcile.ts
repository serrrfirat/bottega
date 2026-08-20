/**
 * Connect-time egress reconciliation (issue #250). A successful OAuth
 * connect stores the vault row + `extension_credentials` + registry rows
 * but — pre-#250 — never reconciled the egress proxy plane: the proxy
 * OAuth blob was boot-only, and a later `tool` pin regenerated egress
 * WITHOUT the runtime-registered providers, dropping them from the running
 * proxy config (a 16:29 regen after the 16:18 notion pin dropped notion).
 *
 * This module closes both gaps as one shared capability:
 *
 *   - egress/dev-egress regenerate from a SUPERSET (committed repo pins ∪
 *     runtime-registered rows), so a regen for ANY one extension never
 *     drops another provider's allowlist / `oauth_token` entry;
 *   - the provider's proxy OAuth blob seeds from the vault — per-user
 *     registered client identity first, deployment env second, else
 *     fail-closed-LOUD (the warning names the client-id env, e.g.
 *     NOTION_OAUTH_CLIENT_ID) — never boot-only;
 *   - the running proxy reloads via the existing control boundary.
 *
 * Reconcile NEVER throws: every step folds into the returned `warnings`,
 * so a connect stays successful — the gap is receivable, never fatal.
 */
import { readPinnedSnapshots, type PinnedSnapshot } from "./registry";
import { runtimeSnapshotsFromStore } from "./runtime-registry";
import {
  DEV_EGRESS_CONFIG_PATH,
  EGRESS_CONFIG_PATH,
  SNAPSHOTS_DIR,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
} from "../egress/generate";
import { REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import {
  readOAuthRowsFromVault,
  seedProxyOAuthBlob,
  type McpOAuthRefreshProbe,
  type OAuthVaultRow,
  type RotatedTokenPersister,
} from "./proxy-seed";
import { PROXY_SECRETS_DIR, proxyBoundaryControlFromEnv } from "./boundary";
import { errorMessage } from "../tools/helpers";
import { resolve } from "node:path";
import type { Store } from "../store/db";

export interface ReconcileEgressDeps {
  /**
   * The runtime extension registry (the persisted `extension_registry`
   * snapshot rows). Default egress regen joins these to the committed
   * pins — the superset that prevents regen clobbering.
   */
  store: Pick<Store, "listRuntimeExtensions">;
  /** Committed snapshot dir; default config/extensions (SNAPSHOTS_DIR). */
  snapshotsDir?: string;
  /** Egress write path; default config/egress.yml. */
  egressPath?: string;
  /** Dev-egress write path; default config/egress.dev.yml. */
  devEgressPath?: string;
  /** Proxy secret-file dir; default data/proxy-secrets (PROXY_SECRETS_DIR). */
  secretsDir?: string;
  /** Vault-row seam; defaults to the broker-aware vault reader (issue #252). */
  readVaultRows?: (provider: string) => Promise<Array<OAuthVaultRow>>;
  /** The env override source for the client-credential fallback; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Refresh-grant seam (issue #269): the connect-time seed refreshes a
   * renewable credential app-side, exactly like the boot sync. Default: a
   * real refresh-grant POST (no-op success under the test runner). Tests
   * stub it.
   */
  refreshOAuthToken?: McpOAuthRefreshProbe;
  /**
   * Rotated-token write-back seam (issue #269): persists the endpoint's
   * rotated refresh token to the vault row (the broker write seam).
   * Default: the production broker-aware writer; tests stub it.
   */
  persistRotatedToken?: RotatedTokenPersister;
  /** Proxy control boundary (reload); defaults from env. */
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Log sink; defaults to console.log. */
  log?: (line: string) => void;
}

export interface ReconcileEgressOptions {
  /**
   * Remove this provider's oauth_token entry before a fresh authorization
   * exchange. iron-proxy stubs configured token endpoints, so the connect
   * leg must reach the provider with that entry absent.
   */
  excludeProvider?: boolean;
  /** Skip credential seeding during the pre-authorization config reload. */
  seedProvider?: boolean;
}

export type ReconcileEgress = (
  provider: string,
  options?: ReconcileEgressOptions,
) => Promise<{ warnings: string[] }>;

/**
 * Builds the connect-time reconcile: regenerates egress/dev-egress from
 * the superset and seeds + reloads the provider's proxy OAuth blob. The
 * returned callable NEVER throws — every failure is a receivable warning.
 */
export function createReconcileEgress(deps: ReconcileEgressDeps): ReconcileEgress {
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;
  const secretsDir = deps.secretsDir ?? PROXY_SECRETS_DIR;
  const readVaultRows = deps.readVaultRows ?? readOAuthRowsFromVault;
  const proxyControl = deps.proxyControl ?? proxyBoundaryControlFromEnv();
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (provider: string, options: ReconcileEgressOptions = {}): Promise<{ warnings: string[] }> => {
    const warnings: string[] = [];

    // Test isolation (issue #191 pattern, mirroring the boot sync): under
    // the test runner an UNINJECTED reconcile targets the repo's LIVE
    // config + secrets dir — it must never rewrite those (a no-op, logged).
    // Tests inject temp `snapshotsDir`/`egressPath`/`devEgressPath`/
    // `secretsDir` (like the catalog-register harness) to exercise the
    // real reconcile.
    if (process.env.NODE_ENV === "test" && resolve(secretsDir) === resolve(import.meta.dir, "../../data/proxy-secrets")) {
      log("bottega egress reconcile: skipped (test runner, live default secrets dir)");
      return { warnings };
    }

    // 1. The superset: committed pins ∪ runtime-registered rows. A
    //    malformed runtime row must not fail the reconcile — loud warning,
    //    regen on the committed-only set (the #205 posture).
    let runtime: PinnedSnapshot[] = [];
    try {
      runtime = await runtimeSnapshotsFromStore(deps.store);
    } catch (err) {
      warnings.push(
        `egress reconcile: runtime registry read failed (${errorMessage(err)}) — regenerating with committed pins only`,
      );
    }
    let pinned: PinnedSnapshot[] = [];
    try {
      pinned = readPinnedSnapshots(snapshotsDir);
    } catch (err) {
      warnings.push(`egress reconcile: committed snapshot read failed (${errorMessage(err)})`);
    }
    const superset = [...pinned, ...runtime];

    // 2. Regenerate BOTH egress configs with the superset (defect B
    //    fixed: a regen for one extension never drops another provider).
    //    Decision B (issue #265): a provider whose CURRENT vault credential
    //    is non-renewable (access-only — no refresh-bearing row anywhere)
    //    is EXCLUDED from the oauth_token mint entries: there is no
    //    refresh to seed, and the transform's require:true would 502 every
    //    runtime call even though the SDK sent a valid access token (the
    //    boundary secrets injection carries that provider's token instead).
    //    An unreadable vault fails safe to KEEPING the entry (status quo —
    //    a refreshable assumption), never silently dropping a provider.
    const excludedOAuthProviders = new Set<string>();
    if (options.excludeProvider === true) excludedOAuthProviders.add(provider);
    for (const snapshot of superset) {
      if (snapshot.manifest.credentialSchema.type !== "oauth") continue;
      if (snapshot.manifest.id === provider && options.excludeProvider === true) continue;
      try {
        const rows = await readVaultRows(snapshot.manifest.id);
        const refreshable = rows.some(
          (r) => r.refresh !== undefined && r.refresh !== "" && r.refresh !== REMOTE_REFRESH_SENTINEL,
        );
        if (!refreshable) excludedOAuthProviders.add(snapshot.manifest.id);
      } catch (err) {
        warnings.push(
          `egress reconcile: ${snapshot.manifest.id} OAuth vault read failed (${errorMessage(err)}) — keeping its oauth_token entry`,
        );
      }
    }
    try {
      regenerateEgressConfig(snapshotsDir, egressPath, superset, excludedOAuthProviders);
      regenerateDevEgressConfig(snapshotsDir, devEgressPath, superset, excludedOAuthProviders);
      log(`bottega egress reconcile: regenerated ${egressPath} + ${devEgressPath} (${superset.length} snapshots)`);
    } catch (err) {
      warnings.push(`egress reconcile: egress regeneration failed (${errorMessage(err)})`);
    }

    // 3. Seed the provider's proxy OAuth blob unless this is the
    // pre-authorization reload. The connect leg must not probe or rewrite
    // the existing grant before the browser exchanges its fresh code.
    if (options.seedProvider !== false) {
      try {
        const seed = await seedProxyOAuthBlob(provider, {
          secretsDir,
          readOAuthRows: readVaultRows,
          env: deps.env,
          refreshOAuthToken: deps.refreshOAuthToken,
          persistRotatedToken: deps.persistRotatedToken,
        });
        for (const note of seed.notes) log(note);
        warnings.push(...seed.warnings);
      } catch (err) {
        warnings.push(`egress reconcile: ${provider} OAuth blob seed failed (${errorMessage(err)})`);
      }
    }

    // 4. Reload the running proxy via the existing control boundary.
    if (proxyControl.proxyControlUrl !== undefined && proxyControl.proxyControlToken !== undefined) {
      try {
        const res = await fetch(`${proxyControl.proxyControlUrl}/v1/reload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxyControl.proxyControlToken}` },
        });
        if (!res.ok) {
          warnings.push(`egress reconcile: proxy reload failed (${res.status})`);
        } else {
          log("bottega egress reconcile: proxy reloaded with the reconciled egress");
        }
      } catch (err) {
        warnings.push(`egress reconcile: proxy reload failed (${errorMessage(err)})`);
      }
    } else if (options.excludeProvider === true) {
      warnings.push("egress reconcile: proxy control is not configured — cannot remove the OAuth mint entry before authorization");
    } else {
      log("bottega egress reconcile: egress regenerated (no proxy control configured — reload skipped)");
    }

    return { warnings };
  };
}
