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
import { readOAuthRowsFromVault, seedProxyOAuthBlob, type OAuthVaultRow } from "./proxy-seed";
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
  /** Proxy control boundary (reload); defaults from env. */
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Log sink; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * Builds the connect-time reconcile: regenerates egress/dev-egress from
 * the superset and seeds + reloads the provider's proxy OAuth blob. The
 * returned callable NEVER throws — every failure is a receivable warning.
 */
export function createReconcileEgress(
  deps: ReconcileEgressDeps,
): (provider: string) => Promise<{ warnings: string[] }> {
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;
  const secretsDir = deps.secretsDir ?? PROXY_SECRETS_DIR;
  const readVaultRows = deps.readVaultRows ?? readOAuthRowsFromVault;
  const proxyControl = deps.proxyControl ?? proxyBoundaryControlFromEnv();
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (provider: string): Promise<{ warnings: string[] }> => {
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
    try {
      regenerateEgressConfig(snapshotsDir, egressPath, superset);
      regenerateDevEgressConfig(snapshotsDir, devEgressPath, superset);
      log(`bottega egress reconcile: regenerated ${egressPath} + ${devEgressPath} (${superset.length} snapshots)`);
    } catch (err) {
      warnings.push(`egress reconcile: egress regeneration failed (${errorMessage(err)})`);
    }

    // 3. Seed the provider's proxy OAuth blob (defect A fixed: not
    //    boot-only). Any fail-closed gap surfaces as a receivable warning.
    try {
      const seed = await seedProxyOAuthBlob(provider, { secretsDir, readOAuthRows: readVaultRows, env: deps.env });
      for (const note of seed.notes) log(note);
      warnings.push(...seed.warnings);
    } catch (err) {
      warnings.push(`egress reconcile: ${provider} OAuth blob seed failed (${errorMessage(err)})`);
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
    } else {
      log("bottega egress reconcile: egress regenerated (no proxy control configured — reload skipped)");
    }

    return { warnings };
  };
}
