/**
 * Static OAuth client provisioning tests (issue #288): the typed
 * pre-registered-client validation and the provisioning gate/storage flow.
 * Hermetic — an injected broker records the opaque api_key payload under
 * the synthetic extension provider key, a recording policy router drives
 * the org gate, and a real audit + a fake store assert what lands (and —
 * fail closed — what never lands). No real vault, no real auth storage, no
 * network: the production store's save is driven through the injected
 * broker seam; the load path's discoverAuthStorage is exercised by the
 * upload-link round-trip tests, not here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditModule } from "../policy/audit";
import { createAudit } from "../policy/audit";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { createStore, type AuditRow, type Store } from "../store/db";
import { STATIC_CLIENT_PROVISIONED_EVENT } from "../store/audit-events";
import {
  STATIC_CLIENT_ID_MAX_LENGTH,
  STATIC_CLIENT_SECRET_MAX_LENGTH,
  STATIC_OAUTH_CLIENT_PROVIDER_PREFIX,
  createStaticOAuthClientStore,
  parseStaticOAuthClient,
  provisionStaticOAuthClient,
  staticOAuthClientProviderKey,
  type StaticOAuthClient,
} from "./static-oauth-client";

const dir = mkdtempSync(join(tmpdir(), "bottega-static-oauth-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A deny-everything policy: org provisioning must fail closed. */
function denyPolicy(): PolicyConfig {
  return parseOrgConfigYaml(""); // default config denies connect_extension
}

function allowPolicy(): PolicyConfig {
  return parseOrgConfigYaml("tools:\n  connect_extension: allow\n");
}

/** Records gate requests; serves a scripted allow/deny resolution. */
class RecordingRouter implements ApprovalRouter {
  readonly requests: ApprovalRequest[] = [];
  constructor(private resolution: ApprovalResolution = { approved: true }) {}
  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    this.requests.push(d);
    return this.resolution;
  }
}

/** The broker seam: records the call and returns a scripted row id. */
class RecordingBroker {
  readonly calls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
  constructor(private rowId = 41) {}
  async connect(input: { provider: string; credentialType: string; apiKey?: string }) {
    this.calls.push(input);
    return { identityKey: null, brokerCredentialId: this.rowId };
  }
}

/** A fake store whose save throws — to assert the provisioning fail-closed message. */
const FAILING_STORE = {
  save: async (_ext: string, _client: StaticOAuthClient) => {
    throw new Error("vault write refused");
  },
  load: async () => null,
};

function gateFor(policy: PolicyConfig, router: ApprovalRouter) {
  return { loadPolicy: () => Promise.resolve(policy), router, timeoutMs: 60_000 };
}

interface AuditHarness {
  audit: AuditModule;
  store: Store;
  auditRows(): Promise<AuditRow[]>;
}

function freshAudit(): AuditHarness {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return {
    audit: createAudit(store),
    store,
    auditRows: () => store.listAudit(),
  };
}

describe("parseStaticOAuthClient fail-closed validation (issue #288)", () => {
  test("accepts a valid pre-registered client, trimming pasted whitespace", () => {
    const out = parseStaticOAuthClient({
      client_id: "  gmail.apps.googleusercontent.com  ",
      client_secret: "  GOCSPX-abc123  ",
    });
    expect(out).toEqual({
      ok: true,
      client: { client_id: "gmail.apps.googleusercontent.com", client_secret: "GOCSPX-abc123" },
    });
  });

  test("rejects a non-object (null) shape fail closed", () => {
    expect(parseStaticOAuthClient(null)).toEqual({
      ok: false,
      message: "static OAuth client must be a JSON object with client_id and client_secret",
    });
  });

  test("rejects a missing or empty client_id fail closed", () => {
    expect(parseStaticOAuthClient({ client_secret: "s" })).toMatchObject({ ok: false });
    expect(parseStaticOAuthClient({ client_id: "  ", client_secret: "s" })).toMatchObject({ ok: false });
  });

  test("rejects a missing or empty client_secret fail closed", () => {
    expect(parseStaticOAuthClient({ client_id: "i", client_secret: "" })).toMatchObject({ ok: false });
    expect(parseStaticOAuthClient({ client_id: "i", client_secret: Infinity })).toMatchObject({ ok: false });
  });

  test("rejects an oversized client_id beyond the bound fail closed", () => {
    const client_id = "x".repeat(STATIC_CLIENT_ID_MAX_LENGTH + 1);
    const out = parseStaticOAuthClient({ client_id, client_secret: "s" });
    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.message : "").toContain(`client_id exceeds ${STATIC_CLIENT_ID_MAX_LENGTH}`);
  });

  test("rejects an oversized client_secret beyond the bound fail closed", () => {
    const client_secret = "y".repeat(STATIC_CLIENT_SECRET_MAX_LENGTH + 1);
    const out = parseStaticOAuthClient({ client_id: "i", client_secret });
    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.message : "").toContain("client_secret exceeds");
  });

  test("rejects control characters in either value fail closed", () => {
    const out = parseStaticOAuthClient({ client_id: "i\u0001d", client_secret: "s" });
    expect(out).toEqual({ ok: false, message: "client values must not contain control characters" });
  });
});

describe("static-oauth-client provider-key identity (issue #288)", () => {
  test("the synthetic provider key is collision-safe and prefixed", () => {
    expect(staticOAuthClientProviderKey("com.example.oauth")).toBe(
      `${STATIC_OAUTH_CLIENT_PROVIDER_PREFIX}:com.example.oauth`,
    );
  });
});

describe("createStaticOAuthClientStore save (issue #288)", () => {
  test("save stores the opaque JSON api_key under the synthetic provider key via the broker", async () => {
    const broker = new RecordingBroker(77);
    const store = createStaticOAuthClientStore({ broker: broker.connect.bind(broker) });
    const result = await store.save("com.example.oauth", { client_id: "cid", client_secret: "sec" });
    expect(result).toEqual({ brokerCredentialId: 77 });
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]!.provider).toBe("static-oauth-client:com.example.oauth");
    expect(broker.calls[0]!.credentialType).toBe("api_key");
    // The opaque payload round-trips through the validator — the secret
    // value never leaks into the broker call's non-payload shape.
    const parsed = parseStaticOAuthClient(JSON.parse(broker.calls[0]!.apiKey!));
    expect(parsed).toEqual({ ok: true, client: { client_id: "cid", client_secret: "sec" } });
  });
});

describe("provisionStaticOAuthClient (issue #288)", () => {
  test("personal scope is refused fail closed — org provisioning only", async () => {
    const broker = new RecordingBroker();
    const router = new RecordingRouter();
    const { audit, auditRows } = freshAudit();
    const store = createStaticOAuthClientStore({ broker: broker.connect.bind(broker) });
    const outcome = await provisionStaticOAuthClient(
      { extension: "com.example.oauth", clientId: "cid", clientSecret: "sec", scope: "personal", actor: "UADA" },
      { store, audit, gate: gateFor(allowPolicy(), router) },
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("org-scoped");
    // Nothing was stored, no gate request, no audit.
    expect(broker.calls).toHaveLength(0);
    expect(router.requests).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  test("invalid client values are refused fail closed with nothing stored", async () => {
    const broker = new RecordingBroker();
    const router = new RecordingRouter();
    const h = freshAudit();
    const store = createStaticOAuthClientStore({ broker: broker.connect.bind(broker) });
    const outcome = await provisionStaticOAuthClient(
      { extension: "com.example.oauth", clientId: "", clientSecret: "", scope: "org", actor: "UADA" },
      { store, audit: h.audit, gate: gateFor(allowPolicy(), router) },
    );
    expect(outcome.ok).toBe(false);
    expect(broker.calls).toHaveLength(0);
    expect(router.requests).toHaveLength(0);
  });

  test("an org provisioning under the deny-by-default policy is blocked with nothing stored", async () => {
    const broker = new RecordingBroker();
    const router = new RecordingRouter();
    const h = freshAudit();
    const store = createStaticOAuthClientStore({ broker: broker.connect.bind(broker) });
    const outcome = await provisionStaticOAuthClient(
      { extension: "com.example.oauth", clientId: "cid", clientSecret: "sec", scope: "org", actor: "UADA", spaceId: "slack:C1" },
      { store, audit: h.audit, gate: gateFor(denyPolicy(), router) },
    );
    expect(outcome.ok).toBe(false);
    // Deny is fail-closed: the broker is never called, nothing stored.
    expect(broker.calls).toHaveLength(0);
  });

  test("an approved org provisioning stores the client and audits metadata only", async () => {
    const broker = new RecordingBroker(9);
    const router = new RecordingRouter({ approved: true });
    const h = freshAudit();
    const store = createStaticOAuthClientStore({ broker: broker.connect.bind(broker) });
    const outcome = await provisionStaticOAuthClient(
      { extension: "com.example.oauth", clientId: "cid", clientSecret: "sec", scope: "org", actor: "UADA", spaceId: "slack:C1" },
      { store, audit: h.audit, gate: gateFor(allowPolicy(), router) },
    );
    expect(outcome).toEqual({ ok: true, brokerCredentialId: 9 });
    // The gate was consulted once (exec-tier org request) and the broker
    // stored the opaque key under the synthetic provider key.
    expect(router.requests).toHaveLength(1);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]!.provider).toBe("static-oauth-client:com.example.oauth");
    // Audited metadata ONLY — never client values.
    const auditRows = await h.auditRows();
    const provisioned = auditRows.find((row) => row.event_type === STATIC_CLIENT_PROVISIONED_EVENT);
    expect(provisioned).toBeDefined();
    expect(JSON.parse(provisioned!.payload)).toEqual({
      extension: "com.example.oauth",
      scope: "org",
      owner: null,
      status: "provisioned",
    });
  });

  test("a store save failure is surfaced fail closed with no audit", async () => {
    const router = new RecordingRouter({ approved: true });
    const h = freshAudit();
    const outcome = await provisionStaticOAuthClient(
      { extension: "com.example.oauth", clientId: "cid", clientSecret: "sec", scope: "org", actor: "UADA" },
      { store: FAILING_STORE, audit: h.audit, gate: gateFor(allowPolicy(), router) },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.message : "").toContain("vault write refused");
    // The failure happened before the audit — no provisioned row.
    const auditRows = await h.auditRows();
    expect(auditRows.find((row) => row.event_type === STATIC_CLIENT_PROVISIONED_EVENT)).toBeUndefined();
  });
});