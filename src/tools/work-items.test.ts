import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { defaultPolicy } from "../policy/config";
import { createWorkItemArgsSchema, parseGithubIssueUrl, workItemsExtension } from "./work-items";

const dir = mkdtempSync(join(tmpdir(), "bottega-tools-"));
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function loadTools(store: Store, opts?: { actor?: string }): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as unknown as ExtensionAPI;
  workItemsExtension(store, { orgPolicy: defaultPolicy(), ...opts })(pi);
  return tools;
}

function ctxFor(spaceId: string): ExtensionContext {
  return {
    sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as unknown as ExtensionContext;
}

function resultText(res: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return (res.content[0] as { text: string }).text;
}

describe("workItemsExtension registration", () => {
  test("registers create_work_item and work_item_cancel", () => {
    const tools = loadTools(freshStore());
    expect(tools.map((t) => t.name).sort()).toEqual(["create_work_item", "work_item_cancel"]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
      expect(t.approval).toBe("exec");
    }
  });

  test("describes all delivery kinds without requiring a repo for non-git work (issue #128)", () => {
    const [createTool] = loadTools(freshStore());
    expect(createTool.description).toContain("connected extensions");
    expect(createTool.description).toContain("delivered in-channel");
    expect(createTool.description).toContain("do not need `repo`");
  });
});

describe("parseGithubIssueUrl", () => {
  test("extracts owner, repo, and issue number from a plain URL", () => {
    expect(parseGithubIssueUrl("https://github.com/acme/bottega/issues/42")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 42,
    });
  });

  test("tolerates a trailing slash, query params, http, and a bare host", () => {
    expect(parseGithubIssueUrl("https://github.com/acme/bottega/issues/42/")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 42,
    });
    expect(parseGithubIssueUrl("https://github.com/acme/bottega/issues/42?ref=123&x=1")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 42,
    });
    expect(parseGithubIssueUrl("http://github.com/acme/bottega/issues/7")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 7,
    });
    expect(parseGithubIssueUrl("github.com/acme/bottega/issues/1")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 1,
    });
  });

  test("finds a URL embedded in surrounding text", () => {
    expect(parseGithubIssueUrl("Fix the flaky checkout https://github.com/acme/bottega/issues/42 please")).toEqual({
      owner: "acme",
      repo: "bottega",
      issueNumber: 42,
    });
  });

  test("rejects non-GitHub hosts, PR links, and URL-free text", () => {
    expect(parseGithubIssueUrl("https://example.com/acme/bottega/issues/42")).toBeNull();
    expect(parseGithubIssueUrl("https://github.com/acme/bottega/pull/42")).toBeNull();
    expect(parseGithubIssueUrl("https://notgithub.com/acme/bottega/issues/42")).toBeNull();
    expect(parseGithubIssueUrl("just some words")).toBeNull();
    expect(parseGithubIssueUrl("")).toBeNull();
  });
});

describe("create_work_item", () => {
  test("creates the space row lazily when the session's space is missing (E2E journey finding)", async () => {
    // No getOrCreateSpace call up front: the tool must create the FK parent
    // itself, because no server path materializes space rows eagerly.
    const s = freshStore();
    const [createTool] = loadTools(s);
    const res = await createTool.execute("tc1", { description: "ship it" }, undefined, undefined, ctxFor("slack:C42"));
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.space_id).toBe("slack:C42");
    const space = await s.getSpace("slack:C42");
    expect(space).not.toBeNull();
    expect(space?.channel_id).toBe("C42");
  });

  test("creates an open item in the space, defaults requester to the actor, and audits", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T1" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute("tc1", { description: "ship the queue" }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.state).toBe("open");
    expect(item?.requester).toBe("agent");
    expect(item?.description).toBe("ship the queue");
    expect(item?.delivery).toBe("git");

    const rows = await s.listAudit({ space: space.id, event_type: "work_item.created" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("agent");
    expect(JSON.parse(rows[0]!.payload)).toEqual({ id: item!.id, requester: "agent" });
  });

  test("uses the requester param and the configured actor when given", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T2" });
    const [createTool] = loadTools(s, { actor: "U7" });
    const res = await createTool.execute(
      "tc1",
      { description: "on behalf of a human", requester: "U123" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.requester).toBe("U123");

    const res2 = await createTool.execute("tc1", { description: "defaulted" }, undefined, undefined, ctxFor(space.id));
    expect(res2.isError).not.toBe(true);
    const item2 = await s.getWorkItem(JSON.parse(resultText(res2)).id);
    expect(item2?.requester).toBe("U7");
  });

  test("accepts an optional repo and stores it on the item (issue #47)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T3" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "fix the flaky checkout", repo: "acme/bottega" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.repo).toBe("acme/bottega");
  });

  test("passes explicit delivery kinds through and ignores repo for non-git work (issue #128)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T3-delivery" });
    const [createTool] = loadTools(s);
    for (const delivery of ["extension", "chat"] as const) {
      const res = await createTool.execute(
        "tc1",
        { description: `${delivery} task`, delivery, repo: "ignored/repo" },
        undefined,
        undefined,
        ctxFor(space.id),
      );
      expect(res.isError).not.toBe(true);
      const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
      expect(item?.delivery).toBe(delivery);
      expect(item?.repo).toBeNull();
    }
  });

  test("rejects delivery kinds outside the public tool schema (issue #128)", () => {
    expect(createWorkItemArgsSchema.safeParse({ description: "valid", delivery: "extension" }).success).toBe(true);
    expect(createWorkItemArgsSchema.safeParse({ description: "invalid", delivery: "email" }).success).toBe(false);
  });

  test("keeps GitHub issue evidence without deriving a repo for extension delivery (issue #128)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T3-extension-evidence" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      {
        description: "Create a ticket from https://github.com/acme/bottega/issues/42",
        delivery: "extension",
      },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.repo).toBeNull();
    expect(JSON.parse(item!.evidence)).toEqual([
      { kind: "issue_url", url: "https://github.com/acme/bottega/issues/42", at: expect.any(Number) },
    ]);
  });

  test("omits repo when not provided (nullable column stays null)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T4" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "no repo mentioned" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.repo).toBeNull();
  });

  test("rejects a whitespace-only repo", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T5" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "ambiguous repo", repo: "   " },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("non-empty");
  });

  test("derives repo, canonical URL, and evidence from a shared issue URL (issue #48)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T2B" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "Fix the flaky checkout http://github.com/acme/bottega/issues/42" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.repo).toBe("acme/bottega");
    expect(item?.delivery).toBe("git");
    expect(item?.description).toBe(
      "Fix the flaky checkout http://github.com/acme/bottega/issues/42\nhttps://github.com/acme/bottega/issues/42",
    );
    expect(JSON.parse(item!.evidence)).toEqual([
      { kind: "issue_url", url: "https://github.com/acme/bottega/issues/42", at: expect.any(Number) },
    ]);
  });

  test("explicit repo wins over the repo derived from an issue URL", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T2E" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      {
        description: "Fix the flaky checkout https://github.com/acme/bottega/issues/42",
        repo: "other/org",
      },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.repo).toBe("other/org");
    expect(item?.description).toContain("https://github.com/acme/bottega/issues/42");
    expect(JSON.parse(item!.evidence)).toEqual([
      { kind: "issue_url", url: "https://github.com/acme/bottega/issues/42", at: expect.any(Number) },
    ]);
  });

  test("keeps the description untouched when it already carries the canonical URL (incl. variants)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T2C" });
    const [createTool] = loadTools(s);
    for (const description of [
      "fix https://github.com/acme/bottega/issues/42",
      "fix https://github.com/acme/bottega/issues/42?ref=sharing",
      "fix https://github.com/acme/bottega/issues/42/",
    ]) {
      const res = await createTool.execute("tc1", { description }, undefined, undefined, ctxFor(space.id));
      expect(res.isError).not.toBe(true);
      const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
      expect(item?.description).toBe(description);
      expect(JSON.parse(item!.evidence)).toEqual([
        { kind: "issue_url", url: "https://github.com/acme/bottega/issues/42", at: expect.any(Number) },
      ]);
    }
  });

  test("leaves the item unchanged when the description has no GitHub issue URL", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T2D" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "ship the queue, see https://example.com/tickets/1" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.description).toBe("ship the queue, see https://example.com/tickets/1");
    expect(item?.evidence).toBe("[]");
  });

  test("fails without a space session and on an empty description", async () => {
    const s = freshStore();
    const [createTool] = loadTools(s);
    const noCtx = { sessionManager: { getSessionFile: () => null } } as unknown as ExtensionContext;
    const res = await createTool.execute("tc1", { description: "x" }, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);

    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T3" });
    const res2 = await createTool.execute("tc1", { description: "   " }, undefined, undefined, ctxFor(space.id));
    expect(res2.isError).toBe(true);
    expect(resultText(res2)).toMatch(/empty/);
  });
});

describe("work_item_cancel", () => {
  async function workingItem(s: Store, spaceId: string): Promise<string> {
    const item = await s.createWorkItem({ space_id: spaceId, requester: "U1", description: "to cancel" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item.id, "claimed", "working");
    return item.id;
  }

  test("the requester cancels a working item to aborted, audited with the actor", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T4" });
    const id = await workingItem(s, space.id);
    const cancelTool = loadTools(s, { actor: "U1" }).find((t) => t.name === "work_item_cancel")!;

    const res = await cancelTool.execute("tc2", { id }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ id, state: "aborted" });
    expect((await s.getWorkItem(id))?.state).toBe("aborted");

    const rows = await s.listAudit({ space: space.id, event_type: "work_item.transition" });
    expect(JSON.parse(rows.at(-1)!.payload)).toEqual({ from: "working", to: "aborted", by: "U1" });
    expect(rows.at(-1)!.actor).toBe("U1");
  });

  test("a non-requester without an approver role fails and leaves the item untouched", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T5" });
    const id = await workingItem(s, space.id);
    const cancelTool = loadTools(s, { actor: "U2" }).find((t) => t.name === "work_item_cancel")!;

    const res = await cancelTool.execute("tc2", { id }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/requester or a space approver/);
    expect((await s.getWorkItem(id))?.state).toBe("working");
  });

  test("a non-requester listed in the space policy approvers can cancel", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T6" });
    const id = await workingItem(s, space.id);
    await s.updatePolicy(space.id, JSON.stringify({ approvers: ["U2"] }));
    const cancelTool = loadTools(s, { actor: "U2" }).find((t) => t.name === "work_item_cancel")!;

    const res = await cancelTool.execute("tc2", { id }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect((await s.getWorkItem(id))?.state).toBe("aborted");
  });

  test("fails for an unknown id and for terminal states", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T7" });
    const cancelTool = loadTools(s, { actor: "U1" }).find((t) => t.name === "work_item_cancel")!;

    const missing = await cancelTool.execute("tc2", { id: "wi_nope" }, undefined, undefined, ctxFor(space.id));
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toMatch(/not found/);

    const id = await workingItem(s, space.id);
    await s.transitionWorkItem(id, "working", "blocked", { evidence: "already dead" });
    const done = await cancelTool.execute("tc2", { id }, undefined, undefined, ctxFor(space.id));
    expect(done.isError).toBe(true);
    expect(resultText(done)).toMatch(/illegal work item transition/);
    expect((await s.getWorkItem(id))?.state).toBe("blocked");
  });
});
