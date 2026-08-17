/**
 * KB job dispatch (epic #170 Wave 2): the manual `kb_ingest` tool and the
 * scheduled `kb_ingest` action both enqueue `kind=kb` worker jobs instead
 * of ingesting in the server process — untrusted web content is fetched +
 * parsed + stored by the containerized worker, whose egress is scoped to
 * the DECLARED source hosts (config/kb.yml). One job per target source,
 * each with a fresh `kb_<source>_<uuid>` envelope id so enqueue → claim →
 * run → outbox → post stays a single audit-trail query per source.
 *
 * Fail closed: an unknown source id and an empty declared set are errors
 * (never a silent no-op dispatch); the caller surface (tool / scheduler
 * action) decides how to surface them.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db";
import type { KbConfig } from "./config";

export interface DispatchKbJobsOptions {
  /** One source id from the declared config; omitted → every declared source. */
  source?: string;
  /** Threaded onto the envelope for audit/outbox routing (null → org-wide). */
  spaceId?: string | null;
}

/**
 * Enqueues one `kind=kb` job per target source with payload `{url}`. The
 * worker re-resolves the source from ITS copy of config/kb.yml (the
 * declared set) and refuses URLs outside it — the enqueue side never
 * trusts anything beyond the declared config either. Returns the job ids.
 */
export async function dispatchKbIngestJobs(
  store: Store,
  config: KbConfig,
  options: DispatchKbJobsOptions = {},
): Promise<string[]> {
  const targets =
    options.source === undefined
      ? config.sources
      : config.sources.filter((source) => source.id === options.source);
  if (options.source !== undefined && targets.length === 0) {
    throw new Error(`unknown KB source: ${options.source}`);
  }
  if (targets.length === 0) {
    throw new Error("no KB sources configured (config/kb.yml)");
  }
  const ids: string[] = [];
  for (const source of targets) {
    const id = `kb_${source.id}_${randomUUID()}`;
    await store.enqueueJob({ id, kind: "kb", payload: { url: source.url }, spaceId: options.spaceId ?? null });
    ids.push(id);
  }
  return ids;
}
