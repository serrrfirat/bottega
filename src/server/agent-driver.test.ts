import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpSdkDriver, SPACE_AGENT_TOOLS } from "./agent-driver";

describe("omp sdk agent driver", () => {
  test("createSession materializes the space transcript file and disposes cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const spaceFile = join(transcriptDir, "slack:C1.jsonl");
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir,
        onOutput: () => {},
      });
      // The durable space timeline exists at the exact session-file path and
      // carries a JSONL header (non-empty) — the transcript the server restarts
      // from (see SessionManager.setSessionFile).
      expect(existsSync(spaceFile)).toBe(true);
      const header = readFileSync(spaceFile, "utf8").split("\n")[0];
      expect(header.startsWith('{"type":"title"')).toBe(true);
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
      // Dispose is terminal and non-destructive: the transcript survives.
      expect(existsSync(spaceFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart resumes the same space transcript without resetting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const spaceFile = join(transcriptDir, "slack:C1.jsonl");
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const options = { spaceId: "slack:C1", transcriptDir, onOutput: () => {} };

      const first = await driver.createSession(options);
      await first.dispose();
      const beforeRestart = readFileSync(spaceFile, "utf8");

      const second = await driver.createSession(options);
      await second.dispose();
      const afterRestart = readFileSync(spaceFile, "utf8");

      // A fresh session on a missing file materializes the same header, so
      // byte equality alone is ambiguous; the point is the file was NOT
      // truncated, emptied, or moved by the restart cycle — history at the
      // same path survives dispose + re-create.
      expect(existsSync(spaceFile)).toBe(true);
      expect(afterRestart).toBe(beforeRestart);
      expect(afterRestart.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allowTools override is accepted and plumbed to the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
        allowTools: ["read", "grep"],
      });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sessions materialize the SDK agent state in the passed agentDir", async () => {
    // Behavioral proof the agentDir option is honored: the OMP SDK keeps its
    // agent store (agent.db) in the directory the driver was given, not the
    // caller's default (~/.omp/agent). This is the seam that keeps server
    // boots reading config/omp templates instead of a home-directory agent.
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const agentDir = join(dir, "agent");
      const driver = createOmpSdkDriver({ agentDir });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      await session.dispose();
      expect(existsSync(join(agentDir, "agent.db"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("space-agent allowlist: conversation/read-only + task + queue/memory tools, no executor tools", () => {
    // The space agent is a participant, not an executor: it may read the
    // workspace, delegate via task, and use the work-item + memory tools —
    // never write/bash/edit (those are EXECUTOR_TOOLS in executor.ts).
    const allowed: readonly string[] = SPACE_AGENT_TOOLS;
    expect([...allowed].sort()).toEqual(
      [
        "read",
        "glob",
        "grep",
        "ast_grep",
        "web_search",
        "inspect_image",
        "lsp",
        "task",
        "create_work_item",
        "work_item_cancel",
        "memory.save",
        "memory.search",
      ].sort(),
    );
    expect(SPACE_AGENT_TOOLS).not.toContain("write");
    expect(SPACE_AGENT_TOOLS).not.toContain("bash");
    expect(SPACE_AGENT_TOOLS).not.toContain("edit");
  });
});
