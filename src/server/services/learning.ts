import { channelFromSpaceId, isDmChannel, type SlackMessage } from "../adapters/slack";
import type { AgentDriver, AgentSessionDriver } from "../drivers/agent-driver";
import { buildExtractionPrompt, createBurstBuffer, filterFacts, parseFacts, type BurstBuffer, type ExtractionScope } from "../../memory/extraction";
import type { MemoryProvider, MemoryScopeKey } from "../../memory/types";
import type { AuditModule } from "../../policy/audit";
import { MEMORY_AUTO_SAVED_EVENT } from "../../store/audit-events";

export interface LearningLogger {
  error(message: string, error?: Error): void;
}

/** Normalize an arbitrary thrown value to the Error the logger contract accepts. */
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
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
    // Extraction-prompt wording: "user" = DM (personal facts), "org" = shared channel facts.
    const promptScope: ExtractionScope = directMessage ? "user" : "org";
    const principal = directMessage ? principalBySpace.get(spaceId) : undefined;
    if (directMessage && !principal) {
      logger.error(`[learning] missing principal for direct-message burst in ${spaceId}`);
      return;
    }
    // Issue #137: DMs save to the authenticated person's key; channel turns
    // save to the current channel key. Facts are never auto-promoted to team/org.
    const saveScope: MemoryScopeKey = directMessage
      ? { kind: "person", principal: principal! }
      : { kind: "channel", spaceId };

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
        // SAFETY: the driver's "message" event always carries { spaceId, text }
        // with text: string (agent-driver.ts #deliver); the optional-read only
        // tolerates non-object payloads from scripted hosts.
        const text = (data as { text?: string } | null)?.text;
        if (text && text.trim()) reply = text;
      });
      await sideSession.prompt(buildExtractionPrompt(turns, promptScope));
    } catch (error) {
      logger.error(`[learning] extraction failed for ${spaceId}`, toError(error));
      return;
    } finally {
      offMessage?.();
      if (sideSession) {
        try {
          await sideSession.dispose();
        } catch (error) {
          logger.error(`[learning] side-session dispose failed for ${spaceId}`, toError(error));
        }
      }
    }

    const filtered = filterFacts(parseFacts(reply));
    let saved = 0;
    for (const fact of filtered.facts) {
      try {
        await deps.memory.save({
          scope: saveScope,
          content: fact,
          metadata: { source: "auto_extract" },
        });
        saved += 1;
      } catch (error) {
        // Providers reject any secret shape the deterministic filter misses.
        // Learning is best effort and must never fail the human's turn.
        logger.error(`[learning] memory save rejected for ${spaceId}`, toError(error));
      }
    }

    if (saved === 0) return;
    try {
      await deps.audit.appendAudit({
        space_id: spaceId,
        actor: "system",
        event_type: MEMORY_AUTO_SAVED_EVENT,
        payload: { scope: saveScope.kind, count: saved },
      });
    } catch (error) {
      logger.error(`[learning] audit write failed for ${spaceId}`, toError(error));
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
          // SAFETY: the driver's "message" event always carries { spaceId, text }
          // with text: string (agent-driver.ts #deliver); the optional-read only
          // tolerates non-object payloads from scripted hosts.
          const text = (data as { text?: string } | null)?.text;
          if (text && text.trim()) state.reply = text;
        }),
        session.on("turn_end", (data) => {
          if (state.inputs.length > 0 && state.reply.trim()) {
            buffer.add(spaceId, { input: state.inputs.join("\n"), reply: state.reply });
            state.inputs = [];
            state.reply = "";
          } else {
            // SAFETY: the driver's "turn_end" event carries { spaceId, error? }
            // where error is a string when the turn failed (#78); any other
            // payload shape means no failure and the branch is skipped.
            const error = (data as { error?: string } | null)?.error;
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
      for (const spaceId of observed.keys()) detach(spaceId);
      principalBySpace.clear();
    },
  };
}
