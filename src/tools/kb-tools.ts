/** Administrative knowledge-base ingestion tool (issue #91). */
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider } from "../memory/types";
import type { AuditModule } from "../policy/audit";
import type { KbConfig } from "../kb/config";
import { ingestAll, ingestSource } from "../kb/ingest";
import { errorMessage, toolError } from "./helpers";

export interface KbToolDependencies {
  memoryProvider: MemoryProvider;
  audit: AuditModule;
  config: KbConfig;
}

export const kbIngestArgsSchema = z.object({ source: z.string().optional() });

/** Returns the write-tier SDK definition for manual KB refreshes. */
export function kbToolDefinitions(deps: KbToolDependencies): ToolDefinition[] {
  const ingest: ToolDefinition<typeof kbIngestArgsSchema> = {
    name: "kb_ingest",
    label: "Ingest knowledge base",
    description:
      "Fetches and appends configured docs/wiki sources to shared org memory. " +
      "Pass a source id to refresh one source, or omit it to refresh all configured sources. " +
      "The source host must be in the egress allowlist and pass the egress judge. Write-tier tool.",
    parameters: kbIngestArgsSchema,
    approval: "write",
    async execute(_toolCallId, params) {
      try {
        if (params.source !== undefined) {
          const source = deps.config.sources.find((candidate) => candidate.id === params.source);
          if (!source) return toolError(`unknown KB source: ${params.source}`);
          const result = await ingestSource(deps.memoryProvider, deps.audit, source);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        const results = await ingestAll(deps.memoryProvider, deps.audit, deps.config);
        return { content: [{ type: "text", text: JSON.stringify({ sources: results }) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  return [ingest];
}
