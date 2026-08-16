/**
 * Memory provider selection (issues #43, #67, #135).
 *
 * Resolution order:
 *   1. Explicit org setting `memory_backend.base_url`.
 *   2. `MEM0_BASE_URL` from the deployment environment.
 *   3. SQLite sharing the store database.
 *
 * `MEM0_API_KEY` remains an optional environment secret. Pure apart from
 * the default environment argument, so tests can drive every branch without
 * mutating process.env.
 */
import type { Database } from "bun:sqlite";
import type { MemoryProvider } from "../memory/types";
import { createMem0MemoryProvider } from "../memory/mem0";
import { createSqliteMemoryProvider } from "../memory/sqlite";

/** The org-settings subset the provider selection reads. */
export interface MemoryProviderSettings {
  memoryBackend?: { baseUrl?: string };
}

export type ResolvedMemoryProvider = MemoryProvider & {
  readonly backend: "mem0" | "sqlite";
};

export function resolveMemoryProvider(
  settings: MemoryProviderSettings | null | undefined,
  storeDb: Database,
  env: Record<string, string | undefined> = process.env,
): ResolvedMemoryProvider {
  const baseUrl = settings?.memoryBackend?.baseUrl || env.MEM0_BASE_URL;
  if (baseUrl) {
    return Object.assign(
      createMem0MemoryProvider({ baseUrl, apiKey: env.MEM0_API_KEY }),
      { backend: "mem0" as const },
    );
  }
  return Object.assign(createSqliteMemoryProvider(storeDb), {
    backend: "sqlite" as const,
  });
}
