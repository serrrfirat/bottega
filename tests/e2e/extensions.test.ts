/**
 * Journey 3 (issue #66): Extensions + policy + ACP.
 *
 * User journeys over REAL bottega components with emulated boundaries, per
 * the issue #66 harness contract:
 *
 *   real:     SQLite store (temp file), policy (org floor + space overlay),
 *             audit trail, connect capability, extension runtime, policy
 *             gate, Slack-backed approval router, ACP driver, space-service
 *             connect-intent seam.
 *   emulated: auth broker (scripted RecordingBroker), extension MCP
 *             transport (in-memory stub), ACP server (scripted fake stdio
 *             server), Slack message surface (recording adapter).
 *
 * The harness contract (tests/e2e/harness.ts, issue #66) is the same shape;
 * while it is not on main yet this file carries a minimal local fixture and
 * merges into the shared harness when it lands. The ACP fake server and the
 * stub MCP transport are journey-local boundaries by contract.
 *
 * Coverage:
 *   1. connect as me — user message → connect intent → connect_extension
 *      (personal) → broker seam → registry row + audit → reply posted;
 *   2. connect as org — approval required (real Slack buttons) → denied
 *      without approval (no broker call, no row, full gate audit trail);
 *   3. extension tool call — runtime through the stub MCP transport with
 *      the credential ladder (org / me / auto) and the policy gate
 *      (deny-before-tier: an extension outside the space allowlist denies
 *      before any credential resolution) + audit rows;
 *   4. ACP driver — permission round-trip against the fake ACP server:
 *      allow / deny / unknown through the shared gate.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAudit } from "../../src/policy/audit";
import { DenyRouter, type ApprovalRouter } from "../../src/policy/approval-router";
import { loadSpacePolicy, parseOrgConfigYaml, type PolicyConfig } from "../../src/policy/config";
import { createStore, type AuditRow, type ExtensionCredential, type Store } from "../../src/store/db";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
} from "../../src/store/audit-events";
import { CONNECT_EXTENSION_TOOL, type BrokerConnectResult, type ConnectExtensionDeps } from "../../src/extensions/connect";
import type { CallScope } from "../../src/extensions/credentials";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL, fixtureManifest } from "../../src/extensions/fixture";
import type { ExtensionManifest, McpBinding } from "../../src/extensions/manifest";
import { createExtensionRuntime, type ExtensionRuntime, type ExtensionRuntimeDeps } from "../../src/extensions/runtime";
import type { CredentialBoundary } from "../../src/extensions/boundary";
import { SpaceService } from "../../src/server/services/space-service";
import { THINKING_PHRASES } from "../../src/server/services/space-service";
import type { AgentDriver, AgentSessionDriver } from "../../src/server/drivers/agent-driver";
import { createAcpDriver, type AcpPolicyContext } from "../../src/server/drivers/acp-driver";
import { APPROVE_ACTION_ID, DENY_ACTION_ID, type SlackAdapter } from "../../src/server/adapters/slack";
import { SlackApprovalRouter } from "../../src/server/adapters/approval-router";

// ---------------------------------------------------------------------------
// Local harness (mirrors the issue #66 contract until tests/e2e/harness.ts
// lands; the shared harness then owns the store/adapter/space-service and
// this file keeps only its journey-local boundaries: broker, MCP transport,
// fake ACP server).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "bottega-e2e-ext-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

function parse(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

// Polls a condition on real time because the awaited signals live in other
// processes or on the adapter wire (the fake ACP server's logfile, the
// approval router's posted message) — fake timers cannot drive them.
async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return;
    } catch {
      // e.g. the fake server's logfile does not exist yet
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
}

function seedOrgCredential(store: Store, provider = FIXTURE_EXTENSION_ID): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: "email:org@example.com",
    owner: null,
    scope: "org",
    brokerCredentialId: 7,
  });
}

function seedPersonalCredential(store: Store, provider: string, owner: string): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: `email:${owner.toLowerCase()}@example.com`,
    owner,
    scope: "personal",
    brokerCredentialId: 8,
  });
}

/** Second registered extension so the space allowlist can exclude one while staying non-empty (issue #56). */
function secondManifest(): ExtensionManifest {
  const base = fixtureManifest();
  return {
    ...base,
    id: "fixture.history",
    label: "Fixture History",
    tools: [
      {
        ...base.tools[0]!,
        name: "history.current",
        description: "History for a city (fixture extension)",
      },
    ],
  };
}

/** Scripted auth-broker seam (the connect capability's vault boundary). */
class RecordingBroker {
  readonly calls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
  constructor(private readonly result: BrokerConnectResult = { identityKey: null, brokerCredentialId: 9 }) {}
  async connect(input: Parameters<ConnectExtensionDeps["broker"]>[0]): Promise<BrokerConnectResult> {
    this.calls.push(input);
    return this.result;
  }
}

/** Slack message surface double: records posts/updates, resolves ts like the real adapter. */
function recordingAdapter(): {
  adapter: SlackAdapter;
  posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string; blocks?: unknown[] } }>;
  updates: Array<{ spaceId: string; ts: string; text: string }>;
} {
  const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string; blocks?: unknown[] } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, opts) {
      posts.push({ spaceId, text, opts });
      return `ts-${posts.length}`;
    },
    async updateMessage(spaceId, ts, text) {
      updates.push({ spaceId, ts, text });
    },
    async addReaction() {},
    async removeReaction() {},
    async start() {},
    async stop() {},
  };
  return { adapter, posts, updates };
}

/**
 * Agent driver double for the connect-intent journeys: connect intents are
 * agent-free (issue #61), so sessions never spawn; non-connect messages are
 * recorded to prove they stayed agent territory.
 */
class RecordingDriver implements AgentDriver {
  readonly prompts: Array<{ spaceId: string; text: string }> = [];
  async createSession(opts: { spaceId: string; transcriptDir: string; onOutput: (spaceId: string, text: string) => void }): Promise<AgentSessionDriver> {
    const spaceId = opts.spaceId;
    const prompts = this.prompts;
    return {
      async prompt(text) {
        prompts.push({ spaceId, text });
      },
      async abort() {},
      isStreaming: () => false,
      on: () => () => {},
      async dispose() {},
    };
  }
}

interface ConnectJourney {
  service: SpaceService;
  store: Store;
  broker: RecordingBroker;
  posts: ConnectJourneyPosts;
  updates: ConnectJourneyUpdates;
  driver: RecordingDriver;
}

type ConnectJourneyPosts = Array<{ spaceId: string; text: string; opts?: { threadTs?: string; blocks?: unknown[] } }>;
type ConnectJourneyUpdates = Array<{ spaceId: string; ts: string; text: string }>;

function makeConnectJourney(opts: { policy?: PolicyConfig; router?: ApprovalRouter } = {}): ConnectJourney {
  const store = freshStore();
  const registry = createFixtureRegistry();
  const { adapter, posts, updates } = recordingAdapter();
  const broker = new RecordingBroker();
  const router = opts.router ?? DenyRouter;
  const orgPolicy = opts.policy ?? parseOrgConfigYaml(""); // fail-closed default: connect_extension denied
  const driver = new RecordingDriver();
  const service = new SpaceService({
    store,
    adapter,
    driver,
    idleTimeoutMs: 60_000,
    transcriptDir: join(dir, "sessions"),
    connect: {
      registry,
      store,
      audit: createAudit(store),
      broker: broker.connect.bind(broker),
      gate: {
        loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
        router,
      },
    },
  });
  return { service, store, broker, posts, updates, driver };
}

// ---------------------------------------------------------------------------
// 1. Connect as me / as org — the user journey over the real space-service
//    connect-intent seam (issue #61) + real connect capability (issue #52).
// ---------------------------------------------------------------------------

describe("journey 3: connect as me / as org (space-service connect intent)", () => {
  test("'connect fixture.weather' connects the sender's account: broker seam → registry row → audit → reply", async () => {
    const h = makeConnectJourney();
    await h.service.handleInboundMessage({
      spaceId: "slack:C1",
      principal: "UADA",
      text: "connect fixture.weather",
      ts: "1.1",
    });

    // The broker seam was invoked for the provider's credential type.
    expect(h.broker.calls).toEqual([{ provider: FIXTURE_EXTENSION_ID, credentialType: "api_key" }]);
    // A registry row exists: personal scope, owned by the sender, referencing
    // the vault row the broker recorded (secrets never enter our store).
    const rows = await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: FIXTURE_EXTENSION_ID,
      owner: "UADA",
      scope: "personal",
      broker_credential_id: 9,
      identity_key: "api-key:UADA",
    });
    // Audit: extension.connected with the actor and the space.
    const connected = await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
    expect(connected).toHaveLength(1);
    expect(connected[0]!.space_id).toBe("slack:C1");
    expect(connected[0]!.actor).toBe("UADA");
    expect(parse(connected[0]!)).toMatchObject({ extension: FIXTURE_EXTENSION_ID, scope: "personal", owner: "UADA" });
    // The outcome was posted back into the space, threaded under the intent.
    expect(h.posts).toEqual([
      { spaceId: "slack:C1", text: "Fixture Weather connected as @UADA", opts: { threadTs: "1.1" } },
    ]);
  });

  test("'connect fixture.weather as org' requires approval: buttons posted, deny click blocks the connect", async () => {
    const { adapter, posts, updates } = recordingAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 5_000 });
    const h = makeConnectJourney({ policy: parseOrgConfigYaml("tools:\n  connect_extension: allow\n"), router });

    const pending = h.service.handleInboundMessage({
      spaceId: "slack:C1",
      principal: "UADA",
      text: "connect fixture.weather as org",
      ts: "1.2",
    });
    await waitFor(() => posts.length === 1);
    const prompt = posts[0]!;
    expect(prompt).toMatchObject({
      spaceId: "slack:C1",
      text: "Approval required for connect_extension",
    });
    // The interactive prompt carries the approval blocks (the router posts
    // to the channel, not threaded — the threaded reply comes with the
    // outcome below).
    const actions = (prompt.opts!.blocks as Array<Record<string, unknown>>).find((b) => b.type === "actions") as {
      elements: Array<{ type: string; action_id: string; value: string }>;
    };
    const buttons = actions.elements;
    expect(buttons.map((b) => b.action_id).sort()).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    expect(buttons[0]!.value).toBe(buttons[1]!.value);

    // A human denies via the button.
    await router.handleAction({
      actionId: DENY_ACTION_ID,
      value: buttons[0]!.value,
      spaceId: "slack:C1",
      principal: "U_ADMIN",
      messageTs: "ts-1",
    });
    await pending;

    // Denied: the broker was never touched, no registry row, failure posted.
    expect(h.broker.calls).toHaveLength(0);
    expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);
    expect(h.posts.at(-1)!.text).toContain("approval denied");
    // The prompt message was rewritten in place with the outcome.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ spaceId: "slack:C1", ts: "ts-1" });
    // Full gate audit trail for the privileged connect.
    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({
      tool: CONNECT_EXTENSION_TOOL,
      tier: "exec",
      decision: "ask-human",
    });
    const requested = await h.store.listAudit({ event_type: APPROVAL_REQUESTED_EVENT });
    expect(parse(requested.at(-1)!)).toMatchObject({ tool: CONNECT_EXTENSION_TOOL });
    const resolved = await h.store.listAudit({ event_type: APPROVAL_RESOLVED_EVENT });
    expect(parse(resolved.at(-1)!)).toMatchObject({
      tool: CONNECT_EXTENSION_TOOL,
      approved: false,
      approver: "U_ADMIN",
    });
  });

  test("'connect X as org' without an approval channel denies (DenyRouter)", async () => {
    const h = makeConnectJourney({ policy: parseOrgConfigYaml("tools:\n  connect_extension: allow\n") });
    await h.service.handleInboundMessage({
      spaceId: "slack:C1",
      principal: "UADA",
      text: "connect fixture.weather as org",
      ts: "1.3",
    });
    expect(h.broker.calls).toHaveLength(0);
    expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);
    expect(h.posts.at(-1)!.text).toContain("approval denied");
    expect(await h.store.listAudit({ event_type: APPROVAL_RESOLVED_EVENT })).toHaveLength(1);
  });

  test("natural-language mentions of connect stay agent territory (narrow seam)", async () => {
    const h = makeConnectJourney();
    await h.service.handleInboundMessage({
      spaceId: "slack:C1",
      principal: "UADA",
      text: "can you connect github please",
      ts: "1.4",
    });
    // The seam is narrow: the message went to the agent (recorded by the
    // driver double) and the connect capability was never touched. The
    // receipt phrase (issue #119) is the ONLY post — a status phrase, not
    // a connect action.
    expect(h.driver.prompts).toEqual([{ spaceId: "slack:C1", text: "can you connect github please" }]);
    expect(h.broker.calls).toHaveLength(0);
    expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);
    expect(h.posts).toHaveLength(1);
    expect(THINKING_PHRASES).toContain(h.posts[0]!.text);
  });
});

// ---------------------------------------------------------------------------
// 2. Extension tool call through the real runtime (issue #53) with the stub
//    MCP transport, the credential ladder (issue #51) and the policy gate
//    (issue #56 deny-before-tier).
// ---------------------------------------------------------------------------

interface RuntimeHarness {
  runtime: ExtensionRuntime;
  store: Store;
  boundary: CredentialBoundary & { calls: ExtensionCredential[] };
  transports: { bindings: McpBinding[] };
}

function makeRuntimeHarness(opts: {
  policy?: PolicyConfig;
  callScope?: CallScope;
  mcpTransport?: (binding: McpBinding) => Transport;
} = {}): RuntimeHarness {
  const registry = createFixtureRegistry();
  registry.register(secondManifest());
  const store = freshStore();
  const boundary: CredentialBoundary & { calls: ExtensionCredential[] } = {
    calls: [],
    async authorize(credential: ExtensionCredential) {
      boundary.calls.push(credential);
    },
  };
  const transports = { bindings: [] as McpBinding[] };
  const mcpTransport =
    opts.mcpTransport ??
    ((binding: McpBinding) => {
      transports.bindings.push(binding);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return { content: [{ type: "text", text: `sunny in ${String(args["city"] ?? "")}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    });
  const deps: ExtensionRuntimeDeps = {
    registry,
    store,
    audit: createAudit(store),
    orgPolicy: opts.policy ?? parseOrgConfigYaml("tools:\n  unknown: allow\n"),
    router: DenyRouter,
    boundary,
    mcpTransport,
    callScope: opts.callScope,
  };
  return { runtime: createExtensionRuntime(deps), store, boundary, transports };
}

describe("journey 3: extension tool call through the runtime (stub MCP transport)", () => {
  test("allowlisted extension: org ladder → boundary → stub MCP → full audit trail", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n"),
    });
    const org = await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "sunny in Lisbon" }] });
    // The ladder resolved the org row and the boundary received it.
    expect(h.boundary.calls).toEqual([org]);
    // The provider call went out over the injected transport.
    expect(h.transports.bindings).toHaveLength(1);
    // The trail carries policy decision, resolution, and call rows.
    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: FIXTURE_EXTENSION_TOOL, tier: "read", decision: "allow" });
    const resolved = await h.store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT });
    expect(parse(resolved[0]!)).toMatchObject({
      provider: FIXTURE_EXTENSION_ID,
      scope: "org",
      credential_id: org.id,
      broker_credential_id: 7,
    });
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(calls[0]!.space_id).toBe("slack:C1");
    expect(calls[0]!.actor).toBe("UADA");
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      credential_id: org.id,
      decision: "allow",
    });
  });

  test("deny-before-tier: an extension outside the space allowlist denies before any credential resolution", async () => {
    // Org floor allowlists both fixture extensions; the space overlay removes
    // fixture.weather (overlays can only tighten — issue #56).
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml(
        "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n    - fixture.history\n",
      ),
    });
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await h.store.updatePolicy("slack:C1", JSON.stringify({ extensions: { allow: [FIXTURE_EXTENSION_ID] } }));
    await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not in this space's extension allowlist");
    // Deny-before-tier: no credential resolution, no boundary write, no provider call.
    expect(await h.store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT })).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
    expect(h.transports.bindings).toHaveLength(0);
    // ...but the deny itself is on the trail, with no credential id.
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(calls[0]!.space_id).toBe("slack:C1");
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      actor: "UADA",
      credential_id: null,
      decision: "deny",
    });
    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: FIXTURE_EXTENSION_TOOL, decision: "deny" });
  });

  test("me ladder: personal scope resolves the caller's row even when an org row exists", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      callScope: "me",
    });
    await seedOrgCredential(h.store);
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });

    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(parse(calls[0]!)).toMatchObject({ credential_id: personal.id, decision: "allow" });
  });

  test("auto ladder: org_credentials deny → the caller's personal credential wins", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
    });
    await seedOrgCredential(h.store);
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });

    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
  });
});

// ---------------------------------------------------------------------------
// 3. ACP driver permission round-trip (issue #26) against the scripted fake
//    ACP server — the shared policy gate answers allow/deny/unknown.
// ---------------------------------------------------------------------------

const ACP_FIXTURE = join(import.meta.dir, "..", "..", "src", "server", "drivers", "fixtures", "fake-acp-server.ts");
let acpRun = 0;

/**
 * Boots the real ACP driver against the fake ACP server's "permission"
 * scenario with a real store/audit/policy context, waits for the driver's
 * permission response on the wire, disposes the session, and returns the
 * store for audit assertions.
 */
async function acpPermissionRoundTrip(opts: {
  orgYaml: string;
  /** JSON override for the fake server's toolCall (undefined = default execute → bash). */
  override?: Record<string, unknown>;
  /** The optionId the driver must answer with. */
  expectedOption: string;
}): Promise<Store> {
  const store = freshStore();
  const audit = createAudit(store);
  const orgPolicy = parseOrgConfigYaml(opts.orgYaml);
  const policy: AcpPolicyContext = {
    orgPolicy,
    loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
    audit,
    router: DenyRouter,
  };
  const logfile = join(dir, `acp-permission-${acpRun++}.log`);
  const args = [ACP_FIXTURE, "permission", logfile];
  if (opts.override) args.push(JSON.stringify(opts.override));
  const driver = createAcpDriver({
    command: "bun",
    args: ["run", ...args],
    sessionTimeoutMs: 10_000,
    policy,
  });
  const session = await driver.createSession({
    spaceId: "slack:C1",
    transcriptDir: join(dir, "sessions"),
    onOutput: () => {},
  });
  try {
    // The response line is the wire proof the gate answered: it only appears
    // once the driver evaluated the policy and wrote the audit rows.
    await waitFor(() => readFileSync(logfile, "utf8").includes(`"outcome":"selected","optionId":"${opts.expectedOption}"`), 10_000);
  } finally {
    await session.dispose();
  }
  return store;
}

describe("journey 3: ACP driver permission round-trip (fake ACP server)", () => {
  test("allowed tool → allow_once and the policy.decision audit row", async () => {
    const store = await acpPermissionRoundTrip({
      orgYaml: "tools:\n  read: allow\n",
      override: {
        toolCall: { toolCallId: "c1", title: "Read file", kind: "read", rawInput: { path: "/x" } },
      },
      expectedOption: "allow_once",
    });
    const decisions = await store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: "read", tier: "read", decision: "allow" });
  });

  test("denied tool → reject_once and the audit row", async () => {
    const store = await acpPermissionRoundTrip({
      orgYaml: "tools:\n  bash: deny\n",
      expectedOption: "reject_once",
    });
    const decisions = await store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: "bash", tier: "exec", decision: "deny" });
  });

  test("unknown tool kind → reject_once (fail closed)", async () => {
    const store = await acpPermissionRoundTrip({
      orgYaml: "tools:\n  unknown: allow\n",
      override: {
        toolCall: { toolCallId: "c1", title: "Think", kind: "think", rawInput: {} },
      },
      expectedOption: "reject_once",
    });
    const decisions = await store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: "think", decision: "deny" });
  });
});
