/**
 * Memory provider selection (issues #43, #67, #135, #348).
 *
 * Resolution order:
 *   1. Explicit org setting `memory_backend.kind = "mnesis"` → the mnesis
 *      remote memory-server backend (MCP Streamable HTTP), driven by the
 *      configured base_url (the `/mcp` endpoint), tenant (org workspace,
 *      sent as `x-tenant-id`) and the vault-held `MNESIS_TOKEN` credential
 *      (same boot-secret provenance as the mem0/model keys). The mnesis
 *      embedding endpoint is a deployment prerequisite probed at BOOT, not
 *      here (fails closed when unconfigured/unreachable).
 *   2. Explicit org setting `memory_backend.base_url` (kind unset, or
 *      kind = "mem0") → the mem0 REST backend.
 *   3. `MEM0_BASE_URL` from the deployment environment → mem0.
 *   4. Unset (or kind = "sqlite") → SQLite sharing the store database.
 *
 * `MEM0_API_KEY`/`MNESIS_TOKEN` remain optional environment secrets,
 * resolved from the vault boot-secret chain at boot. Pure apart from the
 * default environment argument, so tests can drive every branch without
 * mutating process.env.
 */
import type { Database } from "bun:sqlite";
import type { MemoryProvider } from "../memory/types";
import { createMem0MemoryProvider } from "../memory/mem0";
import { createMnesisMemoryProvider } from "../memory/mnesis";
import { createSqliteMemoryProvider } from "../memory/sqlite";

/** The org-settings subset the provider selection reads. */
export interface MemoryProviderSettings {
  memoryBackend?: {
    kind?: "sqlite" | "mem0" | "mnesis";
    baseUrl?: string;
    tenant?: string;
    embeddingUrl?: string;
  };
}

export type ResolvedMemoryProvider = MemoryProvider & {
  readonly backend: "mem0" | "sqlite" | "mnesis";
};

export function resolveMemoryProvider(
  settings: MemoryProviderSettings | null | undefined,
  storeDb: Database,
  env: Record<string, string | undefined> = process.env,
): ResolvedMemoryProvider {
  const backend = settings?.memoryBackend;
  const baseUrl = backend?.baseUrl || env.MEM0_BASE_URL;

  if (backend?.kind === "mnesis") {
    // mnesis: the org workspace + credential drive every request. base_url is
    // the memory-server `/mcp` endpoint. The credential (vault-held) is read
    // from the boot-secret chain into MNESIS_TOKEN at boot; a missing token
    // fails the adapter's fail-closed construct (unconfigured).
    return Object.assign(
      createMnesisMemoryProvider({
        baseUrl: backend.baseUrl ?? "",
        tenantId: backend.tenant ?? "",
        principalId: env.MNESIS_PRINCIPAL ?? "org",
        token: env.MNESIS_TOKEN ?? "",
      }),
      { backend: "mnesis" as const },
    );
  }

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
