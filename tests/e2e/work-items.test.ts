/**
 * E2E journey 2 (issue #66): work items + approvals + executor.
 *
 * The full autonomous loop, end to end, with real components and emulated
 * external services:
 *
 *   Slack DM (REAL Bolt router, app.processEvent — the #29 seam)
 *     → space agent (REAL OMP SDK session; stub model scripts the
 *       create_work_item tool call — repo derived from the conversation
 *       (#47) or from a GitHub issue URL (#48))
 *     → work item created (open) in the REAL store
 *     → executor (REAL executor code) claims → working → clones via the
 *       askpass PAT helper → branches → agent implementation turn (stub
 *       model) → pushes → opens a PR on the emulate.dev GitHub emulator
 *     → delivery_pending audit marker → delivery poller (REAL) announces
 *       the PR in Slack (asserted via the @emulators/slack store)
 *     → approve button click driven through the REAL Bolt action router
 *       (the server's onDelivery hook is a documented TODO — the harness
 *       plays that seam) → working → review (approval recorded) → done
 *       with result.pr_url (store obligations enforced by the REAL state
 *       machine)
 *
 * Failure path: a work item with no repo (no URL, nothing derived) blocks
 * with "repo not specified" evidence before any git work.
 *
 * The delivery-approval button resolution is harness-local: prod's
 * delivery-poller only announces (src/server/services/delivery-poller.ts
 * documents the round-trip as a later adapter issue), so the test wires the
 * executor's onDelivery seam to a resolver driven by block_actions through
 * the same REAL Bolt router the adapter uses.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "@emulators/github";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootHarness, type Harness, type StubTurn } from "./harness";
import { runExecutor, type DeliveryApproval, type DeliveryInfo } from "../../src/executor";
import { inProcessSandboxRunner } from "../../src/worker/run-job";
import { resolveMemoryProvider } from "../../src/server/memory-provider";
import { startDeliveryPoller } from "../../src/server/services/delivery-poller";
import { buildApprovalBlocks } from "../../src/server/adapters/approval-router";
import { APPROVE_ACTION_ID, type SlackAction } from "../../src/server/adapters/slack";
import { DELIVERY_PENDING_EVENT, DELIVERY_REQUESTED_EVENT, WORK_ITEM_TRANSITION_EVENT } from "../../src/store/audit-events";
import { parseOrgConfigYaml } from "../../src/policy/config";
import { workItemsExtension } from "../../src/tools/work-items";
import type { ToolDefinition, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Store, WorkItem, WorkItemState } from "../../src/store/db";

const PAT = "github_pat_e2e_journey_secret_456";

/**
 * Work-item tool definitions for the session's customTools path. Restricted
 * SDK sessions never evaluate extension factories, so the shared definitions
 * are captured here; the __isToolDefinition marker keeps the extension
 * execute contract (full ExtensionContext with sessionManager). The store is
 * proxied because it exists only after bootHarness returns — bind it right
 * after boot, before any session runs.
 */
function workItemCustomTools(orgConfigYaml: string) {
  const orgPolicy = parseOrgConfigYaml(orgConfigYaml);
  let storeRef: Store | null = null;
  // SAFETY: the Proxy target is never read directly — every property access is forwarded to the bound store by the get handler.
  const storeProxy = new Proxy({} as Store, {
    get: (_target, prop: PropertyKey) => {
      if (storeRef === null) throw new Error("work item tools used before the harness store was bound");
      // SAFETY: the handler forwards reads for any property key to the bound store; keyof Store is its sound index type.
      return storeRef[prop as keyof Store];
    },
  }) as Store;
  const defs: ToolDefinition[] = [];
  // SAFETY: the extension factory only calls pi.registerTool, so a double exposing just that member satisfies the executed path.
  workItemsExtension(storeProxy, { orgPolicy })({
    registerTool: (t: ToolDefinition) => void defs.push(t),
  } as ExtensionAPI);
  return {
    // SAFETY: __isToolDefinition is a runtime marker; the spread preserves the def's shape, so the result stays a ToolDefinition.
    customTools: defs.map((def) => ({ ...def, __isToolDefinition: true }) as ToolDefinition),
    bindStore(store: Store) {
      storeRef = store;
    },
  };
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/** GitHub emulator + seeded bare repo + PAT file + askpass dir (the #11 pattern). */
function bootGithub() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-e2e-gh-"));
  const bare = join(dir, "bare", "acme", "sandbox.git");
  const seedWork = join(dir, "seed");
  mkdirSync(seedWork, { recursive: true });
  runGit(["init", "-b", "main"], seedWork);
  runGit(["config", "user.email", "seed@example.com"], seedWork);
  runGit(["config", "user.name", "seed"], seedWork);
  writeFileSync(join(seedWork, "README.md"), "# sandbox\n");
  runGit(["add", "README.md"], seedWork);
  runGit(["commit", "-m", "init"], seedWork);
  mkdirSync(join(dir, "bare", "acme"), { recursive: true });
  runGit(["clone", "--bare", seedWork, bare]);
  rmSync(seedWork, { recursive: true, force: true });

  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const emu = createServer(githubPlugin, {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens: { [PAT]: { login: "bottega-bot", id: 1, scopes: ["repo"] } },
  });
  seedFromConfig(emu.store, emu.baseUrl, {
    users: [{ login: "bottega-bot" }],
    orgs: [{ login: "acme" }],
    repos: [{ owner: "acme", name: "sandbox", default_branch: "main" }],
  });
  const http = Bun.serve({ port, fetch: emu.app.fetch });
  return {
    dir,
    bare,
    baseUrl: `http://127.0.0.1:${port}`,
    pat: PAT,
    stop() {
      http.stop(true);
    },
    cleanup() {
      http.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The delivery-approval seam the prod server does not wire yet
 * (delivery-poller only announces; the round-trip is a documented TODO).
 * Plays the server hook: posts an interactive prompt with the REAL approval
 * blocks and resolves the executor's onDelivery promise from a button click
 * driven through the REAL Bolt action router.
 */
class DeliveryGate {
  private readonly pending = new Map<string, { resolve: (a: DeliveryApproval | null) => void }>();
  private adapter: Harness["adapter"] | null = null;

  /** The adapter is created inside bootHarness; bind it right after boot. */
  attach(adapter: Harness["adapter"]): void {
    this.adapter = adapter;
  }

  request = async (item: WorkItem, delivery: DeliveryInfo): Promise<DeliveryApproval | null> => {
    const { promise, resolve } = Promise.withResolvers<DeliveryApproval | null>();
    this.pending.set(item.id, { resolve });
    await this.adapter!.postMessage(item.space_id, `Delivery approval required for ${item.id}`, {
      blocks: buildApprovalBlocks(
        { tool: "work_item.delivery", args: { pr_url: delivery.prUrl, summary: delivery.summary }, reason: `Approve PR ${delivery.prUrl}?`, spaceId: item.space_id, actor: "executor" },
        item.id,
      ),
    });
    return promise;
  };

  async handleAction(a: SlackAction): Promise<void> {
    // The button value is the work item id; unknown ids (policy-approval
    // request ids) belong to the approval router and are ignored here.
    const entry = this.pending.get(a.value);
    if (entry === undefined) return;
    this.pending.delete(a.value);
    entry.resolve(a.actionId === APPROVE_ACTION_ID ? { approver: a.principal } : null);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Executor fixture (issue #67): runtime knobs are ORG SETTINGS, not env
 * vars — seed the settings blob on the harness store (DB wins over
 * config/org.yml), and the PAT stays a FILE (only the file path is env).
 */
function setExecutorFixture(store: Store, gh: { dir: string; baseUrl: string; pat: string }): () => void {
  store.setOrgSettings({
    workspaces_dir: join(gh.dir, "workspaces"),
    git_base_url: `file://${join(gh.dir, "bare")}`,
    api_base_url: gh.baseUrl,
    repos: ["acme/sandbox"],
  });
  const tokenFile = join(gh.dir, "secrets", "github-pat");
  mkdirSync(join(gh.dir, "secrets"), { recursive: true });
  writeFileSync(tokenFile, `${gh.pat}\n`);
  chmodSync(tokenFile, 0o600);
  const saved = process.env.EXECUTOR_GIT_TOKEN_FILE;
  process.env.EXECUTOR_GIT_TOKEN_FILE = tokenFile;
  return () => {
    if (saved === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
    else process.env.EXECUTOR_GIT_TOKEN_FILE = saved;
  };
}

async function waitForState(store: Harness["store"], id: string, state: WorkItemState, timeoutMs = 30_000): Promise<WorkItem> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const item = await store.getWorkItem(id);
    if (item?.state === state) return item;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id} to reach ${state} (last: ${item?.state})`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

/** Runs the real executor loop and aborts it once the item settles. */
async function runUntil(
  harness: Harness,
  gate: DeliveryGate,
  itemId: string,
  state: WorkItemState,
): Promise<WorkItem> {
  const { done, stop } = startExecutor(harness, gate, itemId, state);
  try {
    return await done;
  } finally {
    await stop();
  }
}

/** Starts the executor (unawaited) plus the delivery poller; stop() aborts both. */
function startExecutor(
  harness: Harness,
  gate: DeliveryGate,
  itemId: string,
  state: WorkItemState,
) {
  const ac = new AbortController();
  const poller = startDeliveryPoller({ store: harness.store, adapter: harness.adapter, intervalMs: 20 });
  poller.start();
  const run = runExecutor(
    {
      store: harness.store,
      memoryProvider: resolveMemoryProvider(harness.store.getOrgSettings(), harness.store.getDb()),
      driver: harness.driver,
      transcriptDir: harness.transcriptDir,
      pollIntervalMs: 10,
      onDelivery: gate.request,
      // Issue #335: the same hermetic runner double the executor unit tests
      // use (#101) — the real isolated job body in-process over the scoped
      // store, so prepareExecutor's fail-closed guard passes without Docker
      // while production wiring (createChildProcessSandboxRunner) stays
      // untouched.
      sandboxRunner: inProcessSandboxRunner(),
    },
    ac.signal,
  );
  return {
    done: waitForState(harness.store, itemId, state),
    async stop() {
      ac.abort();
      poller.stop();
      await run;
    },
  };
}

/** Polls the emulator store until a message matches (or times out). */
async function waitForMessage(
  harness: Harness,
  channelId: string,
  predicate: (text: string) => boolean,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = harness.messages(channelId).find((m) => predicate(m.text));
    if (hit) return hit.text;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a message matching the predicate (have: ${JSON.stringify(harness.messages(channelId).map((m) => m.text))})`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

/**
 * Bounded wait for the poller's delivery.requested audit row: the poller
 * writes it AFTER its postMessage, and the executor's done state says
 * nothing about when that write landed. Under CI load the poller's tick can
 * arrive a beat later, so the assertion must poll instead of reading the
 * trail at an arbitrary moment (issue #70). Deterministic time control
 * cannot work here: the poller and executor are live loops on the real
 * event loop (poller intervalMs 20), so the test waits on the real clock —
 * same pattern as waitForState/waitForMessage below.
 */
async function waitForDeliveryRequested(
  store: Harness["store"],
  timeoutMs = 10_000,
): Promise<Array<{ event_type: string; payload: string }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const requested = await store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT });
    if (requested.length > 0) return requested;
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the delivery poller's delivery.requested audit row");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

async function findOpenItem(harness: Harness, spaceId: string, timeoutMs = 30_000): Promise<WorkItem> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await harness.store.listAudit({ space: spaceId, event_type: "work_item.created" });
    // SAFETY: the executor writes the work item id into the created-marker payload.
    const ids = rows.map((r) => (JSON.parse(r.payload) as { id: string }).id);
    for (const id of ids) {
      const item = await harness.store.getWorkItem(id);
      if (item) return item;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the work item to be created");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

const ORG_CONFIG = [
  "tools:",
  "  create_work_item: allow",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "",
].join("\n");

/**
 * Test-level deadline for the full journey-2 loop (issue #300). This test
 * boots a real HTTP GitHub emulator, a real OMP agent session, and the real
 * executor doing real git clone/branch/commit/push, then synchronizes
 * several live loops (executor poll 10ms, delivery poller 20ms) on the real
 * clock — measured at 4.4–5.2s alone, and past 5s under the full serial
 * coverage suite. Bun's implicit default test deadline (5s) therefore kills
 * a completing journey, so it must be declared explicitly.
 *
 * 30s is the file's own longest sync bound (waitForState / findOpenItem
 * already wait up to 30s for the same journey's real transitions). It does
 * NOT mask a hang: every internal wait has a tighter bounded deadline that
 * throws on genuine failure (findOpenItem/waitForState 30s, waitForMessage
 * 20s, waitForDeliveryRequested 10s, modelStub.waitForRequests 20s), so a
 * stuck loop fails via those long before this outer deadline; this deadline
 * only guards the legitimate SUM of those waits plus instrumented git work,
 * which measured ~5s (max observed 5.2s alone, >5s in the full-suite gate).
 */
const JOURNEY2_TIMEOUT_MS = 30_000;

describe("journey 2: work items + approvals + executor", () => {
  test("DM with a GitHub issue URL → item → PR → delivery announcement → approve click → done", async () => {
    const gh = bootGithub();
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [
          {
            name: "create_work_item",
            args: {
              description: "handle https://github.com/acme/sandbox/issues/42 — fix the flaky checkout",
            },
          },
        ],
      },
      { type: "text", text: "On it — created the work item." },
      { type: "text", text: "implemented the requested change" },
    ];
    const gate = new DeliveryGate();
    const approveRouter = {
      // Policy ask-human never fires in restricted sessions; auto-approve if
      // it somehow does. The click resolution is the delivery gate's job.
      async request() {
        return { approved: true };
      },
      handleAction: (a: SlackAction) => gate.handleAction(a),
    };
    const tools = workItemCustomTools(ORG_CONFIG);
    const harness = await bootHarness({
      orgConfigYaml: ORG_CONFIG,
      modelTurns: turns,
      customTools: tools.customTools,
      approve: approveRouter,
    });
    tools.bindStore(harness.store);
    gate.attach(harness.adapter);
    const dm = harness.slack.dmChannelId;
    const human = harness.slack.user("owner")!;
    const restoreEnv = setExecutorFixture(harness.store, gh);
    try {
      // The space agent derives repo + issue from the URL (#48).
      await harness.deliverMessage(dm, "handle https://github.com/acme/sandbox/issues/42 — fix the flaky checkout");
      await harness.modelStub.waitForRequests(2, 20_000);

      const item = await findOpenItem(harness, `slack:${dm}`);
      expect(item.state).toBe("open");
      expect(item.repo).toBe("acme/sandbox");
      // The canonical URL was appended to the description and recorded as evidence.
      expect(item.description).toContain("https://github.com/acme/sandbox/issues/42");
      // SAFETY: evidence is a JSON array of {kind, url} records written by the executor and tools.
      const createdEvidence = JSON.parse(item.evidence) as Array<{ kind: string; url: string }>;
      expect(createdEvidence).toHaveLength(1);
      expect(createdEvidence[0]).toMatchObject({ kind: "issue_url", url: "https://github.com/acme/sandbox/issues/42" });

      // The space turn completed: the agent session ran to a reply. The
      // reply replaces the thinking phrase via chat.update — covered by
      // space-service/slack-emulator unit tests; the emulator's in-place
      // edit no-ops on is_im channels in this setup, so the strict text
      // assertion lives there, not here.

      // Executor: the full loop to done. The delivery approval waits on the
      // gate; the approve click below resolves it (the prod server's
      // onDelivery hook is a documented TODO — the harness plays that seam).
      const { done, stop } = startExecutor(harness, gate, item.id, "done");
      try {
        // Delivery announcement (poller) + approve prompt (gate) both land in
        // Slack while the executor waits — assert the announcement FIRST, in
        // journey order, then click approve through the REAL Bolt router.
        const announced = await waitForMessage(harness, dm, (t) => t.includes("PR ready:"));
        expect(announced).toMatch(/\/acme\/sandbox\/pull\/\d+/);
        await waitForMessage(harness, dm, (t) => t.startsWith("Delivery approval required"));
        expect(gate.pendingCount).toBe(1);

        await harness.deliverAction({
          actionId: APPROVE_ACTION_ID,
          value: item.id,
          channelId: dm,
          messageTs: "1.1",
          user: human,
        });

        const doneItem = await done;
        // SAFETY: the executor's done result carries the PR url and summary of the completed delivery.
        const result = JSON.parse(doneItem.result!) as { pr_url: string; summary: string };
        expect(result.pr_url).toContain("/acme/sandbox/pull/1");
        expect(result.summary).toBe("implemented the requested change");
        // Obligations (real store): review required an approval, done requires pr_url.
        expect(JSON.parse(doneItem.approvals)).toEqual([{ approver: human, at: expect.any(Number) }]);
        // SAFETY: evidence is a JSON array of {kind, url} records written by the executor and tools.
        const evidence = JSON.parse(doneItem.evidence) as Array<{ kind: string; url: string }>;
        expect(evidence.map((e) => e.kind)).toContain("issue_url");
        expect(evidence.map((e) => e.url)).toContain("PR opened: " + result.pr_url);
        expect(gate.pendingCount).toBe(0);

        // Transitions were performed by the real executor and audited.
        const transitions = await harness.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
        expect(transitions.map((t) => JSON.parse(t.payload))).toEqual(
          expect.arrayContaining([
            { from: "claimed", to: "working", by: "executor" },
            { from: "working", to: "review", by: "executor" },
            { from: "review", to: "done", by: "executor" },
          ]),
        );

        // Delivery marker + the poller's announcement (asserted via the emulator).
        const pending = await harness.store.listAudit({ event_type: DELIVERY_PENDING_EVENT });
        expect(pending).toHaveLength(1);
        expect(JSON.parse(pending[0].payload)).toMatchObject({ id: item.id, pr_url: result.pr_url });
        // The poller records delivery.requested AFTER its postMessage; under
        // load that write can land a tick after `done`. Wait for the row
        // (bounded) instead of asserting on a snapshot (issue #70).
        const requested = await waitForDeliveryRequested(harness.store);
        expect(requested).toHaveLength(1);
        const announcedRows = harness.messages(dm).filter((m) => m.text.includes("PR ready:"));
        expect(announcedRows).toHaveLength(1);
        expect(announcedRows[0].text).toContain(result.pr_url);

        // The approve prompt carried the REAL approval blocks (button value =
        // the work item id) and the click resolved the gate through the REAL
        // Bolt action router.
        const prompt = harness.messages(dm).find((m) => m.text.startsWith("Delivery approval required"));
        expect(prompt).toBeDefined();
        // SAFETY: the emulator's stored message exposes the approval blocks the router attached.
        const storedPrompt = harness.slack.store.messages.all().find((m) => m.ts === prompt!.ts) as
          | { blocks?: unknown }
          | undefined;
        // SAFETY: approval blocks are arrays of element-bearing blocks; the button value is the work item id.
        const values = ((storedPrompt?.blocks ?? []) as Array<{ elements?: Array<{ value?: string }> }>)
          .flatMap((b) => b.elements ?? [])
          .map((e) => e.value);
        expect(values).toContain(item.id);

        // GitHub emulator: PR exists with bottega/<id> head against main by the
        // PAT's user (Bearer auth from the FILE).
        // SAFETY: the emulator's PR endpoint returns the pull-request object with head/base refs and the opener.
        const pr = await fetch(`${gh.baseUrl}/repos/acme/sandbox/pulls/1`, {
          headers: { Authorization: `Bearer ${PAT}` },
        }).then((r) => r.json() as Promise<{ head: { ref: string }; base: { ref: string }; user: { login: string } }>);
        expect(pr.head.ref).toBe(`bottega/${item.id}`);
        expect(pr.base.ref).toBe("main");
        expect(pr.user.login).toBe("bottega-bot");

        // Git delivery: the branch landed on the bare remote; the workspace
        // was cleaned up.
        const refs = runGit(["--git-dir", gh.bare, "for-each-ref", "--format=%(refname:short)"]);
        expect(refs).toContain(`bottega/${item.id}`);
        expect(existsSync(join(gh.dir, "workspaces", item.id))).toBe(false);
      } finally {
        // Always stop the executor + poller, even when an assertion failed —
        // a leaked loop keeps claiming rows from the closing store and
        // corrupts the rest of the file.
        await stop();
      }
    } finally {
      await harness.cleanup();
      gh.cleanup();
      restoreEnv();
    }
  }, JOURNEY2_TIMEOUT_MS);

  test("#47 conversation-derived repo: the model derives repo from the message", async () => {
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [
          {
            name: "create_work_item",
            args: { description: "fix the flaky checkout in acme/sandbox", repo: "acme/sandbox" },
          },
        ],
      },
      { type: "text", text: "Created." },
    ];
    const tools = workItemCustomTools(ORG_CONFIG);
    const harness = await bootHarness({
      orgConfigYaml: ORG_CONFIG,
      modelTurns: turns,
      customTools: tools.customTools,
    });
    tools.bindStore(harness.store);
    const dm = harness.slack.dmChannelId;
    try {
      await harness.deliverMessage(dm, "fix the flaky checkout in acme/sandbox");
      await harness.modelStub.waitForRequests(2, 20_000);

      const item = await findOpenItem(harness, `slack:${dm}`);
      expect(item.state).toBe("open");
      // The conversation-derived repo rode the tool call into the item (#47).
      expect(item.repo).toBe("acme/sandbox");
      expect(item.description).toBe("fix the flaky checkout in acme/sandbox");
      expect(JSON.parse(item.evidence)).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  test("failure path: no repo mentioned → executor blocks with 'repo not specified' evidence", async () => {
    const gh = bootGithub();
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "create_work_item", args: { description: "do the thing" } }] },
      { type: "text", text: "ok" },
    ];
    const tools = workItemCustomTools(ORG_CONFIG);
    const gate = new DeliveryGate();
    const approveRouter = {
      async request() {
        return { approved: true };
      },
      handleAction: (a: SlackAction) => gate.handleAction(a),
    };
    const harness = await bootHarness({
      orgConfigYaml: ORG_CONFIG,
      modelTurns: turns,
      customTools: tools.customTools,
      approve: approveRouter,
    });
    tools.bindStore(harness.store);
    gate.attach(harness.adapter);
    const dm = harness.slack.dmChannelId;
    const restoreEnv = setExecutorFixture(harness.store, gh);
    try {
      await harness.deliverMessage(dm, "do the thing");
      await harness.modelStub.waitForRequests(2, 20_000);

      const item = await findOpenItem(harness, `slack:${dm}`);
      expect(item.repo).toBeNull();

      const blocked = await runUntil(harness, gate, item.id, "blocked");

      // SAFETY: evidence is a JSON array of {kind, url} records written by the executor and tools.
      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; url: string }>;
      expect(evidence[0].url).toBe("repo not specified — ask the requester");
      // Fail closed before any git work: no delivery request, no PR, no gate.
      expect(gate.pendingCount).toBe(0);
      expect(await harness.store.listAudit({ event_type: DELIVERY_PENDING_EVENT })).toHaveLength(0);
      // SAFETY: the emulator's pulls list endpoint returns a JSON array of pull objects.
      const pulls = await fetch(`${gh.baseUrl}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${PAT}` },
      }).then((r) => r.json() as Promise<unknown[]>);
      expect(pulls).toHaveLength(0);
      const announced = harness.messages(dm).filter((m) => m.text.includes("PR ready:"));
      expect(announced).toHaveLength(0);
    } finally {
      await harness.cleanup();
      gh.cleanup();
      restoreEnv();
    }
  });
});
