/**
 * Memory provider selection (issue #43).
 *
 * The server picks its memory backend from the deployment environment:
 *   - MEM0_BASE_URL set  → mem0 OSS server backend (self-hosted, shipped as
 *     the `mem0` compose service). MEM0_API_KEY is optional — the OSS server
 *     only demands a key when its auth is enabled.
 *   - otherwise          → the SQLite provider (original default, #20).
 *
 * Pure: reads only the passed env record, so tests can drive both branches
 * without touching process.env.
 */
import type { Database } from "bun:sqlite";
import type { MemoryProvider } from "../memory/types";
import { createMem0MemoryProvider } from "../memory/mem0";
import { createSqliteMemoryProvider } from "../memory/sqlite";

export function resolveMemoryProvider(
  env: Record<string, string | undefined>,
  storeDb: Database,
): MemoryProvider {
  const baseUrl = env.MEM0_BASE_URL;
  if (baseUrl) {
    return createMem0MemoryProvider({ baseUrl, apiKey: env.MEM0_API_KEY });
  }
  return createSqliteMemoryProvider(storeDb);
}
