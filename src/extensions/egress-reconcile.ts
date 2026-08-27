/**
 * Connect-time egress reconciliation (issue #250). A successful OAuth
 * connect stores the vault row + `extension_credentials` + registry rows
 * but — pre-#250 — never reconciled the egress proxy plane: the proxy
 * OAuth blob was boot-only, and a later `tool` pin regenerated egress
 * WITHOUT the runtime-registered providers, dropping them from the running
 * proxy config (a 16:29 regen after the 16:18 notion pin dropped notion).
 *
 * This module closes the gap as one shared capability:
 *
 *   - egress/dev-egress regenerate from a SUPERSET (committed repo pins ∪
 *     runtime-registered rows), so a regen for ANY one extension never
 *     drops another provider's allowlist entry;
 *   - the running proxy reloads via the existing control boundary.
 *
 * Issue #284: the reconcile touches NO OAuth credentials — no vault OAuth
 * rows, no `<provider>-oauth.json` blob seeding/probing, no refresh-grant
 * POST. The MCP SDK owns OAuth for hosted MCP calls and tools/list; the
 * proxy is transport/allowlist only, so the allowlist regen + reload is
 * the ENTIRE reconcile. The pre-authorization connect preflight uses the
 * same call (nothing to remove from the config anymore, and the connect
 * leg must never probe/rewrite the existing grant).
 *
 * Reconcile NEVER throws: every step folds into the returned `warnings`,
 * so a connect stays successful — the gap is receivable, never fatal.
 */
import { SNAPSHOT_SCHEMA, readPinnedSnapshots, type PinnedSnapshot } from "./registry";
import { runtimeSnapshotsFromStore } from "./runtime-registry";
import {
  DEV_EGRESS_CONFIG_PATH,
  EGRESS_CONFIG_PATH,
  SNAPSHOTS_DIR,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
} from "../egress/generate";
import { proxyBoundaryControlFromEnv } from "./boundary";
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
  /** Proxy control boundary (reload); defaults from env. */
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Log sink; defaults to console.log. */
  log?: (line: string) => void;
}

export type ReconcileEgress = (provider: string) => Promise<{ warnings: string[] }>;

/**
 * Builds the connect-time reconcile: regenerates egress/dev-egress from
 * the superset and reloads the running proxy. Issue #284: no credential
 * seeding/probing of any kind — the SDK owns OAuth; the proxy plane gets
 * only the allowlist update + reload. The returned callable NEVER throws —
 * every failure is a receivable warning.
 */
export function createReconcileEgress(deps: ReconcileEgressDeps): ReconcileEgress {
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;
  const proxyControl = deps.proxyControl ?? proxyBoundaryControlFromEnv();
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (_provider: string): Promise<{ warnings: string[] }> => {
    const warnings: string[] = [];

    // Test isolation (issue #191 pattern, mirroring the boot sync): under
    // the test runner an UNINJECTED reconcile targets the repo's LIVE
    // config — it must never rewrite it (a no-op, logged). Tests inject
    // temp `snapshotsDir`/`egressPath`/`devEgressPath` (like the
    // catalog-register harness) to exercise the real reconcile.
    if (
      process.env.NODE_ENV === "test" &&
      resolve(egressPath) === resolve(import.meta.dir, "../../config/egress.yml")
    ) {
      log("bottega egress reconcile: skipped (test runner, live default egress config)");
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
    //    fixed: a regen for one extension never drops another provider's
    //    allowlist). Issue #284: OAuth extensions get no transform entry
    //    of any kind — their domains allowlist, the SDK sends the bearer.
    try {
      regenerateEgressConfig(snapshotsDir, egressPath, superset);
      regenerateDevEgressConfig(snapshotsDir, devEgressPath, superset);
      log(`bottega egress reconcile: regenerated ${egressPath} + ${devEgressPath} (${superset.length} snapshots)`);
    } catch (err) {
      warnings.push(`egress reconcile: egress regeneration failed (${errorMessage(err)})`);
    }

    // 3. Reload the running proxy via the existing control boundary.
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

/**
 * Pre-probe egress ensure (issue #366): the connect flow's MCP validation
 * probe runs BEFORE registration, and on a strict deployment the egress
 * gate 403s an unlisted candidate host — probe-before-registration made
 * runtime connects unreachable there. This synthesizes a candidate
 * snapshot for the probed hosts, regenerates the superset (committed pins
 * ∪ runtime rows ∪ candidate), and reloads the running proxy.
 *
 * Transient by design: the candidate entry persists only via a successful
 * connect (the runtime row upsert) or a reviewed pin — a failed/aborted
 * connect leaves nothing behind but an allowlisted read-only host until
 * the next regen.
 */
export interface PreProbeEgressEnsureDeps {
  store: Pick<Store, "listRuntimeExtensions">;
  snapshotsDir?: string;
  egressPath?: string;
  devEgressPath?: string;
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  log?: (line: string) => void;
}

export function createPreProbeEgressEnsure(
  deps: PreProbeEgressEnsureDeps,
): (hosts: string[], provider: string) => Promise<{ ok: boolean; warnings: string[] }> {
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;
  const proxyControl = deps.proxyControl ?? proxyBoundaryControlFromEnv();
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (hosts: string[], provider: string): Promise<{ ok: boolean; warnings: string[] }> => {
    const warnings: string[] = [];
    const clean = [...new Set(hosts.map((h) => h.trim()).filter(Boolean))];
    if (clean.length === 0) return { ok: true, warnings };

    const candidate: PinnedSnapshot = {
      schema: SNAPSHOT_SCHEMA,
      extensionId: provider,
      pinnedAt: new Date().toISOString(),
      source: {
        catalog: "https://integrations.sh/api.json",
        specId: provider,
        vendorOfficial: false,
        reviewed: false,
      },
      manifest: {
        id: provider,
        label: provider,
        vendor: provider,
        kind: "mcp",
        mcp: { serverUrl: `https://${clean[0]}/mcp`, transport: "streamable-http" },
        credentialSchema: { type: "oauth" },
        domains: clean,
        credentialTargets: clean.map((host) => ({ host })),
      },
    };

    let runtimeSet: PinnedSnapshot[] = [];
    try {
      runtimeSet = await runtimeSnapshotsFromStore(deps.store);
    } catch (err) {
      warnings.push(`runtime rows unavailable (${errorMessage(err)}) — regenerating with committed pins only`);
    }

    try {
      regenerateEgressConfig(snapshotsDir, egressPath, [candidate, ...runtimeSet]);
      regenerateDevEgressConfig(snapshotsDir, devEgressPath, [candidate, ...runtimeSet]);
    } catch (err) {
      warnings.push(`pre-probe egress regen failed for ${provider}: ${errorMessage(err)}`);
      return { ok: false, warnings };
    }

    if (proxyControl.proxyControlUrl !== undefined && proxyControl.proxyControlToken !== undefined) {
      try {
        const res = await fetch(`${proxyControl.proxyControlUrl}/v1/reload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxyControl.proxyControlToken}` },
        });
        if (!res.ok) {
          warnings.push(`proxy reload failed (${res.status})`);
          return { ok: false, warnings };
        }
      } catch (err) {
        warnings.push(`proxy reload failed: ${errorMessage(err)}`);
        return { ok: false, warnings };
      }
      log(`pre-probe egress ensure: proxy reloaded with the candidate hosts for ${provider}`);
    } else {
      warnings.push("no proxy control configured — the regenerated allowlist is not live until a proxy restart");
    }
    return { ok: warnings.length === 0, warnings };
  };
}
