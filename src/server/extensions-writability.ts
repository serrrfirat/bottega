import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Relative source directory used by local runs and the deployment image. */
export const EXTENSIONS_CONFIG_DIR = "config/extensions";

/** Container mount that must stay writable for catalog drafts and reviewed pins. */
export const EXTENSIONS_MOUNT_PATH = "/app/config/extensions";

/**
 * Verifies that the extension snapshot directory can accept catalog drafts.
 * A deployment bind-mounted with `:ro` fails before the server starts, with
 * the container mount named explicitly so an operator can correct Compose.
 */
export function assertWritableExtensionsDir(dir = process.env.BOTTEGA_EXTENSIONS_DIR ?? EXTENSIONS_CONFIG_DIR): void {
  const probe = join(dir, `.bottega-writable-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "", { flag: "wx" });
  } catch (cause) {
    const diagnostic =
      `bottega boot: ${EXTENSIONS_MOUNT_PATH} is not writable (resolved from ${dir}); ` +
      "catalog drafts and reviewed extension pins require a read-write mount. " +
      "Use the Compose extensions named volume and do not add :ro to this mount.";
    console.error(diagnostic);
    throw new Error(diagnostic, { cause });
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // The probe may not have been created when mkdir/write failed.
    }
  }
}
