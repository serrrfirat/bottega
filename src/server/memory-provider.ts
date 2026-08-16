/**
 * Memory provider selection (issues #43, #67).
 *
 * The server picks its memory backend from the org settings blob (DB is
 * the source of truth — issue #67 env pruning moved the knob out of env):
 *   - memory_backend.base_url set → mem0 OSS server backend (self-hosted,
 *     shipped as the `mem0` compose service). MEM0_API_KEY stays an env
 *     secret (optional — the OSS server only demands a key when its auth
 *     is enabled).
 *   - otherwise → the SQLite provider (original default, #20).
 *
 * Pure: reads only the passed settings object (plus the env record for the
 * optional API key), so tests can drive both branches without touching
 * process.env.
 */
import type { Database } from "bun:sqlite";
import type { MemoryProvider } from "../memory/types";
import { createMem0MemoryProvider } from "../memory/mem0";
import { createSqliteMemoryProvider } from "../memory/sqlite";

/** The org-settings subset the provider selection reads. */
export interface MemoryProviderSettings {
  memoryBackend?: { baseUrl?: string };
}

export function resolveMemoryProvider(
  settings: MemoryProviderSettings | null | undefined,
  storeDb: Database,
  env: Record<string, string | undefined> = process.env,
): MemoryProvider {
  const baseUrl = settings?.memoryBackend?.baseUrl;
  if (baseUrl) {
    return createMem0MemoryProvider({ baseUrl, apiKey: env.MEM0_API_KEY });
  }
  return createSqliteMemoryProvider(storeDb);
}
