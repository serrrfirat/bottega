import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackAdapter } from "../adapters/slack";
import type { AgentDriver, AgentSessionDriver } from "../drivers/agent-driver";
import { createStore } from "../../store/db";
import { createAudit } from "../../policy/audit";
import { defaultPolicy } from "../../policy/config";
import { SLACK_FORMAT_DIRECTIVE, SpaceService } from "./space-service";

const tempDirs: string[] = [];

class CapturingDriver implements AgentDriver {
  readonly sessions: Array<Parameters<AgentDriver["createSession"]>[0]> = [];

  async createSession(opts: Parameters<AgentDriver["createSession"]>[0]): Promise<AgentSessionDriver> {
    this.sessions.push(opts);
    return {
      async prompt(): Promise<void> {},
      async abort(): Promise<void> {},
      isStreaming: () => false,
      on: () => () => {},
      async dispose(): Promise<void> {},
      getTodoPhases: () => [],
    };
  }
}

function fakeAdapter(): SlackAdapter {
  return {
    async postMessage(): Promise<string> {
      return "reply-ts";
    },
    async updateMessage(): Promise<void> {},
    async addReaction(): Promise<void> {},
    async removeReaction(): Promise<void> {},
    async downloadFile(): Promise<{ name: string; mimeType: string; size: number; bytes: Uint8Array }> {
      return { name: "file.bin", mimeType: "application/octet-stream", size: 0, bytes: new Uint8Array() };
    },
    async uploadFile(): Promise<string | undefined> {
      return undefined;
    },
    async startStream(): Promise<string | undefined> {
      throw new Error("not used");
    },
    async appendText(): Promise<void> {},
    async appendTask(): Promise<void> {},
    async stopStream(): Promise<void> {},
    async isChannelMember(): Promise<boolean> {
      return true;
    },
    async postEphemeral(): Promise<void> {},
    streamingSupported: () => false,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };
}

async function personaService(): Promise<{
  service: SpaceService;
  driver: CapturingDriver;
}> {
  const root = mkdtempSync(join(tmpdir(), "bottega-persona-session-"));
  const personaDir = join(root, "personas");
  mkdirSync(personaDir);
  writeFileSync(join(personaDir, "default.md"), "Default persona fragment.");
  writeFileSync(join(personaDir, "default.tools.yml"), "- memory.search\n");
  writeFileSync(join(personaDir, "ops.md"), "Prioritize operational monitoring, tickets, and reports.");
  writeFileSync(
    join(personaDir, "ops.tools.yml"),
    "- memory.search\n- memory.save\n- create_work_item\n- linear.create_issue\n",
  );
  tempDirs.push(root);

  const store = createStore(join(root, "bottega.db"));
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C130" });
  await store.updatePolicy(space.id, JSON.stringify({ persona: "ops" }));
  const driver = new CapturingDriver();
  const service = new SpaceService({
    store,
    adapter: fakeAdapter(),
    audit: createAudit(store),
    orgPolicy: defaultPolicy(),
    driver,
    personaDir: root,
    onboardingChecks: () => [],
  });
  return { service, driver };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SpaceService department personas (issue #130)", () => {
  test("appends the selected persona fragment without replacing existing directives", async () => {
    const { service, driver } = await personaService();

    await service.handleInboundMessage({ spaceId: "slack:C130", principal: "U1", text: "status?", ts: "1.0" });

    expect(driver.sessions).toHaveLength(1);
    expect(driver.sessions[0]?.appendSystemPrompt).toContain("Prioritize operational monitoring, tickets, and reports.");
    expect(driver.sessions[0]?.appendSystemPrompt).toContain(SLACK_FORMAT_DIRECTIVE);
    expect(driver.sessions[0]?.appendSystemPrompt).toContain(
      "Never send artifact:// URIs or internal spill/display-limit notices to Slack users; read artifacts when needed, otherwise omit notices silently.",
    );
    await service.stop();
  });

  test("adds the persona tool floor to the normal space session toolset", async () => {
    const { service, driver } = await personaService();

    await service.handleInboundMessage({ spaceId: "slack:C130", principal: "U1", text: "triage", ts: "2.0" });

    expect(driver.sessions[0]?.allowTools).toEqual(
      expect.arrayContaining(["web_search", "memory.search", "memory.save", "create_work_item", "linear.create_issue"]),
    );
    // Issue #338: the persona floor widens the surface but never re-adds a
    // host-native shell/filesystem/subagent tool to the space session.
    expect(driver.sessions[0]?.allowTools).not.toContain("read");
    expect(driver.sessions[0]?.allowTools).not.toContain("bash");
    expect(driver.sessions[0]?.allowTools).not.toContain("task");
    await service.stop();
  });
});
