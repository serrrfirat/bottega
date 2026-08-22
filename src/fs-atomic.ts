import { chmodSync, renameSync, writeFileSync } from "node:fs";

/**
 * Atomically writes `data` to `target`: writes a temp file in the same
 * directory, sets the exact `mode` (0600 for secrets, 0700 for executable
 * helpers — unaffected by umask), then renames it over the target. Rename
 * within a single directory is atomic, so readers never observe a partial
 * write. The temp file is `${target}.tmp`, the same visible name the
 * hand-rolled call sites this helper replaces used.
 */
export function writeFileAtomic(target: string, data: string | Uint8Array, mode: number): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}