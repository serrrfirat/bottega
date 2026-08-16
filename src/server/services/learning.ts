import { channelFromSpaceId, isDmChannel, type SlackMessage } from "../adapters/slack";
import type { AgentDriver, AgentSessionDriver } from "../drivers/agent-driver";
import { buildExtractionPrompt, createBurstBuffer, filterFacts, parseFacts, type BurstBuffer } from "../../memory/extraction";
import type { MemoryProvider, MemoryScope } from "../../memory/types";
import type { AuditModule } from "../../policy/audit";
import { MEMORY_AUTO_SAVED_EVENT } from "../../store/audit-events";

export interface LearningLogger {
  error(message: string, error?: unknown): void;
}

export interface LearningServiceDeps {
  driver: AgentDriver;
  memory: MemoryProvider;
  audit: AuditModule;
  /** Org policy `learning.auto_extract`. Default true. */
  autoExtract?: boolean;
  quietMs?: number;
  maxTurns?: number;
  now?: () => number;
  transcriptDir?: string;
  logger?: LearningLogger;
}

export interface LearningSessionObserver {
  attachSession(spaceId: string, session: AgentSessionDriver): () => void;
  recordInput(message: SlackMessage): void;
}

export interface LearningService extends LearningSessionObserver {
  /** Flushes pending bursts and waits for extraction, saves, and audit writes. */
  drain(): Promise<void>;
  /** Cancels quiet timers and detaches every live-session listener. */
  close(): void;
}

interface ObservedSession {
  session: AgentSessionDriver;
  inputs: string[];
  reply: string;
  off: Array<() => void>;
}

/** Automatic durable-memory extraction from completed Slack conversation turns. */
export function createLearningService(deps: LearningServiceDeps): LearningService {
  const enabled = deps.autoExtract ?? true;
  const transcriptDir = deps.transcriptDir ?? "data/learning";
  const logger = deps.logger ?? console;
  const observed = new Map<string, ObservedSession>();
  const principalBySpace = new Map<string, string>();
  let sideSessionSequence = 0;

  const extract = async (spaceId: string, turns: readonly { input: string; reply: string }[]): Promise<void> => {
    if (!enabled || turns.length === 0) return;
    const directMessage = isDmChannel(channelFromSpaceId(spaceId));
    const scope: MemoryScope = directMessage ? "user" : "org";
    const principal = directMessage ? principalBySpace.get(spaceId) : undefined;
    if (directMessage && !principal) {
      logger.error(`[learning] missing principal for direct-message burst in ${spaceId}`);
      return;
    }

    let reply = "";
    let sideSession: AgentSessionDriver | undefined;
    let offMessage: (() => void) | undefined;
    try {
      const sequence = ++sideSessionSequence;
      sideSession = await deps.driver.createSession({
        spaceId: `learning:${spaceId}:${sequence}`,
        transcriptDir,
        allowTools: [],
        onOutput: (_sideSpaceId, text) => {
          if (text.trim()) reply = text;
        },
      });
      offMessage = sideSession.on("message", (data) => {
        const text = (data as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.trim()) reply = text;
      });
      await sideSession.prompt(buildExtractionPrompt(turns, scope));
    } catch (error) {
      logger.error(`[learning] extraction failed for ${spaceId}`, error);
      return;
    } finally {
      offMessage?.();
      if (sideSession) {
        try {
          await sideSession.dispose();
        } catch (error) {
          logger.error(`[learning] side-session dispose failed for ${spaceId}`, error);
        }
      }
    }

    const filtered = filterFacts(parseFacts(reply));
    let saved = 0;
    for (const fact of filtered.facts) {
      try {
        await deps.memory.save({
          scope,
          ...(principal ? { principal } : {}),
          content: fact,
          metadata: { source: "auto_extract" },
        });
        saved += 1;
      } catch (error) {
        // Providers reject any secret shape the deterministic filter misses.
        // Learning is best effort and must never fail the human's turn.
        logger.error(`[learning] memory save rejected for ${spaceId}`, error);
      }
    }

    if (saved === 0) return;
    try {
      await deps.audit.appendAudit({
        space_id: spaceId,
        actor: "system",
        event_type: MEMORY_AUTO_SAVED_EVENT,
        payload: { scope, count: saved },
      });
    } catch (error) {
      logger.error(`[learning] audit write failed for ${spaceId}`, error);
    }
  };

  const buffer: BurstBuffer = createBurstBuffer({
    quietMs: deps.quietMs,
    maxTurns: deps.maxTurns,
    now: deps.now,
    flush: extract,
  });

  const detach = (spaceId: string, expected?: ObservedSession): void => {
    const state = observed.get(spaceId);
    if (!state || (expected && state !== expected)) return;
    observed.delete(spaceId);
    for (const off of state.off) off();
  };

  return {
    attachSession(spaceId, session) {
      // Executor/headless and learning side sessions never belong to Slack.
      if (!enabled || !spaceId.startsWith("slack:")) return () => {};
      detach(spaceId);
      const state: ObservedSession = { session, inputs: [], reply: "", off: [] };
      observed.set(spaceId, state);
      state.off.push(
        session.on("message", (data) => {
          const text = (data as { text?: unknown } | null)?.text;
          if (typeof text === "string" && text.trim()) state.reply = text;
        }),
        session.on("turn_end", (data) => {
          if (state.inputs.length > 0 && state.reply.trim()) {
            buffer.add(spaceId, { input: state.inputs.join("\n"), reply: state.reply });
            state.inputs = [];
            state.reply = "";
          } else {
            const error = (data as { error?: unknown } | null)?.error;
            if (error !== undefined) {
              state.inputs = [];
              state.reply = "";
            }
          }
        }),
      );
      return () => detach(spaceId, state);
    },
    recordInput(message) {
      if (!enabled) return;
      const state = observed.get(message.spaceId);
      if (!state) return;
      if (state.session.isStreaming()) state.inputs.push(message.text);
      else {
        state.inputs = [message.text];
        state.reply = "";
      }
      principalBySpace.set(message.spaceId, message.principal);
    },
    drain: () => buffer.drain(),
    close() {
      buffer.close();
      for (const spaceId of [...observed.keys()]) detach(spaceId);
      principalBySpace.clear();
    },
  };
}
