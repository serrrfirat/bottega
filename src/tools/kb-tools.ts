/** Administrative knowledge-base ingestion tool (issue #91, epic #170 Wave 2). */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { KbConfig } from "../kb/config";
import { dispatchKbIngestJobs } from "../kb/dispatch";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "./helpers";

export interface KbToolDependencies {
  /** The job bus: the tool enqueues kind=kb jobs; the containerized worker ingests. */
  store: Store;
  /** The declared KB sources (config/kb.yml) — the dispatch scope. */
  config: KbConfig;
}

export const kbIngestArgsSchema = z.object({ source: z.string().optional() });

/** Returns the write-tier SDK definition for manual KB refreshes. */
export function kbToolDefinitions(deps: KbToolDependencies): ToolDefinition[] {
  const ingest: ToolDefinition<typeof kbIngestArgsSchema> = {
    name: "kb_ingest",
    label: "Ingest knowledge base",
    description:
      "Dispatches KB ingestion to the worker: fetches and appends configured docs/wiki " +
      "sources to shared org memory as containerized jobs (epic #170). Pass a source id " +
      "to refresh one source, or omit it to dispatch every configured source. " +
      "Egress is scoped to the declared source hosts (config/kb.yml) + the egress allowlist. Write-tier tool.",
    parameters: kbIngestArgsSchema,
    approval: "write",
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      try {
        const ids = await dispatchKbIngestJobs(deps.store, deps.config, { source: params.source });
        return { content: [{ type: "text", text: JSON.stringify({ dispatched: ids }) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  return [ingest];
}
