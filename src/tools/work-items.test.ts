import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { defaultPolicy } from "../policy/config";
import type { ModelCatalogEntry } from "../models/model-pin";
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

function loadTools(
  store: Store,
  opts?: { actor?: string; agentDir?: string; listModels?: (agentDir: string) => Promise<ModelCatalogEntry[]> },
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // SAFETY: the extension factory only ever calls registerTool; the rest of
  // the ExtensionAPI surface is inert for registration.
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as ExtensionAPI;
  workItemsExtension(store, { orgPolicy: defaultPolicy(), ...opts })(pi);
  return tools;
}

function ctxFor(spaceId: string): ExtensionContext {
  // SAFETY: the tool paths under test read only sessionManager.getSessionFile();
  // the widened return matches the SDK's contract, other members untouched.
  return {
    sessionManager: { getSessionFile: (): string | undefined => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

function resultText(res: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  // SAFETY: every tool under test returns its report as a single text content
  // block (the SDK's tool-result contract), so content[0] is that block.
  return (res.content[0] as { text: string }).text;
}

describe("workItemsExtension registration", () => {
  test("registers create, cancel, and chat completion tools with their approval tiers", () => {
    const tools = loadTools(freshStore());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "complete_work_item",
      "create_work_item",
      "work_item_cancel",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
    }
    expect(tools.find((t) => t.name === "create_work_item")?.approval).toBe("exec");
    expect(tools.find((t) => t.name === "work_item_cancel")?.approval).toBe("exec");
    expect(tools.find((t) => t.name === "complete_work_item")?.approval).toBe("write");
  });

  test("describes all delivery kinds without requiring a repo for non-git work (issue #128)", () => {
    const [createTool] = loadTools(freshStore());
    expect(createTool.description).toContain("connected extensions");
    expect(createTool.description).toContain("delivered in-channel");
    expect(createTool.description).toContain("do not need `repo`");
  });

  test("tells the agent to answer first and leaves non-chat completion to the executor", () => {
    const completeTool = loadTools(freshStore()).find((t) => t.name === "complete_work_item")!;
    expect(completeTool.description).toContain("Deliver the answer in the channel first");
    expect(completeTool.description).toContain("one-paragraph summary");
    expect(completeTool.description).toContain("completed by the executor");
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
    // SAFETY: the tool reads only sessionManager.getSessionFile(); undefined
    // is the SDK's "no session" signal and the fail-closed path under test.
    const noCtx = {
      sessionManager: { getSessionFile: (): string | undefined => undefined },
    } as ExtensionContext;
    const res = await createTool.execute("tc1", { description: "x" }, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);

    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "T3" });
    const res2 = await createTool.execute("tc1", { description: "   " }, undefined, undefined, ctxFor(space.id));
    expect(res2.isError).toBe(true);
    expect(resultText(res2)).toMatch(/empty/);
  });
});

describe("create_work_item model pin (issue #185)", () => {
  const catalog: ModelCatalogEntry[] = [
    { id: "gpt-sol-5.6", name: "GPT-Sol 5.6", provider: "opencode-go" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)", provider: "opencode-go" },
  ];

  test("stores a role-ref + effort pin on the item and audits it at creation", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN1" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "fast task at low effort", model: "fast", reasoning_effort: "low" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.model).toBe("fast");
    expect(item?.reasoning_effort).toBe("low");
    // The response echoes the pin so the agent can confirm what was stored.
    expect(JSON.parse(resultText(res))).toMatchObject({ model: "fast", reasoning_effort: "low" });
    const rows = await s.listAudit({ space: space.id, event_type: "work_item.created" });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      id: item!.id,
      requester: "agent",
      model: "fast",
      reasoning_effort: "low",
    });
  });

  test("resolves a friendly model name to the available model id at creation", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN2" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "gpt task", model: "gpt sol" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    // The RESOLVED id is stored — execution never re-interprets the name.
    expect(item?.model).toBe("gpt-sol-5.6");
    expect(JSON.parse(resultText(res))).toMatchObject({ model: "gpt-sol-5.6" });
  });

  test("resolves 'deepseek v4' to the deepseek model id", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN3" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "deepseek task", model: "deepseek v4" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.model).toBe("deepseek-v4-flash");
  });

  test("an unresolvable model name fails closed with candidates and creates nothing", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN4" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "ghost task", model: "gibberish" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toContain("matches no available model");
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("gpt-sol-5.6");
    // Fail closed: no work item was created, nothing audited.
    expect(await s.listAudit({ event_type: "work_item.created" })).toHaveLength(0);
  });

  test("an unavailable explicit model id fails closed", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN5" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "ghost task", model: "ghost-model" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("ghost-model");
    expect(await s.listAudit({ event_type: "work_item.created" })).toHaveLength(0);
  });

  test("an ambiguous name fails closed listing the candidates (the agent can clarify)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN6" });
    const withTwoGptModels = [...catalog, { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "opencode-go" }];
    const [createTool] = loadTools(s, { listModels: async () => withTwoGptModels });
    const res = await createTool.execute(
      "tc1",
      { description: "ambiguous", model: "gpt" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toContain("ambiguous");
    expect(text).toContain("gpt-sol-5.6");
    expect(text).toContain("gpt-5.6-luna");
    expect(await s.listAudit({ event_type: "work_item.created" })).toHaveLength(0);
  });

  test("a whitespace-only model is rejected", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN7" });
    const [createTool] = loadTools(s, { listModels: async () => catalog });
    const res = await createTool.execute(
      "tc1",
      { description: "blank model", model: "   " },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("must not be empty");
    expect(await s.listAudit({ event_type: "work_item.created" })).toHaveLength(0);
  });

  test("an unpinned item keeps null pins and the compact audit payload", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "PIN8" });
    const [createTool] = loadTools(s);
    const res = await createTool.execute(
      "tc1",
      { description: "no pin" },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    const item = await s.getWorkItem(JSON.parse(resultText(res)).id);
    expect(item?.model).toBeNull();
    expect(item?.reasoning_effort).toBeNull();
    const rows = await s.listAudit({ space: space.id, event_type: "work_item.created" });
    expect(JSON.parse(rows[0]!.payload)).toEqual({ id: item!.id, requester: "agent" });
  });
});

describe("complete_work_item", () => {
  function completeTool(s: Store, actor = "agent"): ToolDefinition {
    return loadTools(s, { actor }).find((t) => t.name === "complete_work_item")!;
  }

  test("completes an open chat item with a summary and audits every legal hop", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE1" });
    const item = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Answer in chat",
      delivery: "chat",
    });

    const res = await completeTool(s, "U7").execute(
      "tc-complete",
      { id: item.id, summary: "Shared the answer with the channel." },
      undefined,
      undefined,
      ctxFor(space.id),
    );

    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ id: item.id, state: "done" });
    const stored = await s.getWorkItem(item.id);
    expect(stored?.state).toBe("done");
    expect(JSON.parse(stored!.result!)).toEqual({ summary: "Shared the answer with the channel." });
    const rows = await s.listAudit({ space: space.id, event_type: "work_item.transition" });
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
      { from: "open", to: "claimed", by: "U7" },
      { from: "claimed", to: "working", by: "U7" },
      { from: "working", to: "done", by: "U7" },
    ]);
    expect(rows.map((row) => row.actor)).toEqual(["U7", "U7", "U7"]);
  });

  test("completes chat items already in claimed or working", async () => {
    for (const initialState of ["claimed", "working"] as const) {
      const s = freshStore();
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: `COMPLETE-${initialState}` });
      const item = await s.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: `Chat item in ${initialState}`,
        delivery: "chat",
      });
      await s.transitionWorkItem(item.id, "open", "claimed", { by: "setup" });
      if (initialState === "working") {
        await s.transitionWorkItem(item.id, "claimed", "working", { by: "setup" });
      }
      const before = await s.listAudit({ space: space.id, event_type: "work_item.transition" });

      const res = await completeTool(s).execute(
        "tc-complete",
        { id: item.id, summary: `Completed from ${initialState}.` },
        undefined,
        undefined,
        ctxFor(space.id),
      );

      expect(res.isError).not.toBe(true);
      const stored = await s.getWorkItem(item.id);
      expect(stored?.state).toBe("done");
      expect(JSON.parse(stored!.result!)).toEqual({ summary: `Completed from ${initialState}.` });
      const after = await s.listAudit({ space: space.id, event_type: "work_item.transition" });
      expect(after.slice(before.length).map((row) => JSON.parse(row.payload))).toEqual(
        initialState === "claimed"
          ? [
              { from: "claimed", to: "working", by: "agent" },
              { from: "working", to: "done", by: "agent" },
            ]
          : [{ from: "working", to: "done", by: "agent" }],
      );
    }
  });

  test("rejects git and extension items because the executor completes them", async () => {
    for (const delivery of ["git", "extension"] as const) {
      const s = freshStore();
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: `COMPLETE-${delivery}` });
      const item = await s.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: `${delivery} work`,
        delivery,
      });

      const res = await completeTool(s).execute(
        "tc-complete",
        { id: item.id, summary: "Not allowed." },
        undefined,
        undefined,
        ctxFor(space.id),
      );

      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/only completes chat-delivered work items.*executor/);
      expect((await s.getWorkItem(item.id))?.state).toBe("open");
    }
  });

  test("rejects an empty or whitespace-only summary without changing the item", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-EMPTY" });
    const item = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Needs a real summary",
      delivery: "chat",
    });

    for (const summary of ["", " \n "]) {
      const res = await completeTool(s).execute(
        "tc-complete",
        { id: item.id, summary },
        undefined,
        undefined,
        ctxFor(space.id),
      );
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/summary must not be empty/);
    }
    expect((await s.getWorkItem(item.id))?.state).toBe("open");
  });

  test("rejects an item from another space", async () => {
    const s = freshStore();
    const ownerSpace = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-OWNER" });
    const foreignSpace = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-FOREIGN" });
    const item = await s.createWorkItem({
      space_id: ownerSpace.id,
      requester: "U1",
      description: "Private to the owner space",
      delivery: "chat",
    });

    const res = await completeTool(s).execute(
      "tc-complete",
      { id: item.id, summary: "Must not cross spaces." },
      undefined,
      undefined,
      ctxFor(foreignSpace.id),
    );

    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/does not belong to this space/);
    expect((await s.getWorkItem(item.id))?.state).toBe("open");
  });

  test("rejects completion outside a space session", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-NO-SESSION" });
    const item = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Requires a space session",
      delivery: "chat",
    });
    // SAFETY: the tool reads only sessionManager.getSessionFile(); undefined
    // is the SDK's "no session" signal and the fail-closed path under test.
    const noSpaceCtx = {
      sessionManager: { getSessionFile: (): string | undefined => undefined },
    } as ExtensionContext;

    const res = await completeTool(s).execute(
      "tc-complete",
      { id: item.id, summary: "Must not complete." },
      undefined,
      undefined,
      noSpaceCtx,
    );

    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/require a space session/);
    expect((await s.getWorkItem(item.id))?.state).toBe("open");
  });

  test("rejects an unknown item id", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-MISSING" });

    const res = await completeTool(s).execute(
      "tc-complete",
      { id: "wi_missing", summary: "Nothing to complete." },
      undefined,
      undefined,
      ctxFor(space.id),
    );

    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/work item not found/);
  });

  test("rejects review, done, blocked, and aborted chat items", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "COMPLETE-STATES" });
    const idsByState: Array<{ id: string; state: "review" | "done" | "blocked" | "aborted" }> = [];

    for (const target of ["review", "done", "blocked"] as const) {
      const item = await s.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: `Already ${target}`,
        delivery: "chat",
      });
      await s.transitionWorkItem(item.id, "open", "claimed", { by: "setup" });
      await s.transitionWorkItem(item.id, "claimed", "working", { by: "setup" });
      if (target === "blocked") {
        await s.transitionWorkItem(item.id, "working", "blocked", { by: "setup", evidence: "blocked" });
      } else {
        await s.transitionWorkItem(item.id, "working", "review", {
          by: "setup",
          approval: { approver: "U1" },
        });
        if (target === "done") {
          await s.transitionWorkItem(item.id, "review", "done", {
            by: "setup",
            result: JSON.stringify({ summary: "Already completed." }),
          });
        }
      }
      idsByState.push({ id: item.id, state: target });
    }

    const aborted = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Already aborted",
      delivery: "chat",
    });
    await s.transitionWorkItem(aborted.id, "open", "aborted", { by: "setup" });
    idsByState.push({ id: aborted.id, state: "aborted" });

    for (const { id, state } of idsByState) {
      const res = await completeTool(s).execute(
        "tc-complete",
        { id, summary: "Must not overwrite terminal state." },
        undefined,
        undefined,
        ctxFor(space.id),
      );
      expect(res.isError).toBe(true);
      expect(resultText(res)).toContain(`state ${state}`);
      expect((await s.getWorkItem(id))?.state).toBe(state);
    }
  });
});

describe("work_item_cancel", () => {
  async function workingItem(s: Store, spaceId: string): Promise<string> {
    const item = await s.createWorkItem({ space_id: spaceId, requester: "U1", description: "to cancel" });
    await s.claimWorkItemById(item.id);
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
