import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAudit } from "../policy/audit";
import { parseOrgConfigYaml } from "../policy/config";
import { createStore, type ExtensionCredential, type Store } from "../store/db";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID } from "./fixture";
import {
  connectionLifecycleToolDefinitions,
  listConnectionReadModel,
  type ConnectionAuthority,
  type ConnectionBoundary,
} from "./lifecycle";

const roots: string[] = [];
const stores: Store[] = [];
const PHASE_AUDIT_SCHEMA = z.object({ phase: z.string() });

type LifecycleToolArgs = Record<string, string | number>;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function policy(orgMutation: "allow" | "deny") {
  return parseOrgConfigYaml(`
tools:
  replace_connection: ${orgMutation}
  disconnect_connection: ${orgMutation}
approvals:
  always_approve:
    - replace_connection
    - disconnect_connection
`);
}

class FakeAuthority implements ConnectionAuthority {
  nextId = 100;
  readonly live = new Set<number>();
  readonly revoked: number[] = [];
  failRevoke = false;

  async provision(): Promise<{ brokerCredentialId: number; identityKey: string }> {
    const brokerCredentialId = this.nextId++;
    this.live.add(brokerCredentialId);
    return { brokerCredentialId, identityKey: `account:${brokerCredentialId}` };
  }

  async revoke(credential: ExtensionCredential): Promise<void> {
    if (this.failRevoke) throw new Error("oauth revoke unavailable");
    const id = credential.broker_credential_id;
    if (id !== null) {
      this.live.delete(id);
      this.revoked.push(id);
    }
  }
}

class FakeBoundary implements ConnectionBoundary {
  readonly active = new Map<string, number>();
  failPrepare = false;
  failDisconnect = false;

  async prepareReplacement(_current: ExtensionCredential, replacement: ExtensionCredential) {
    if (this.failPrepare) throw new Error("proxy reload failed");
    return {
      activate: async () => {
        if (replacement.broker_credential_id === null) throw new Error("replacement lacks authority");
        this.active.set(replacement.id, replacement.broker_credential_id);
      },
      rollback: async () => undefined,
    };
  }

  async disconnect(credential: ExtensionCredential): Promise<void> {
    if (this.failDisconnect) throw new Error("proxy reload failed");
    this.active.delete(credential.id);
  }
}

async function harness(orgMutation: "allow" | "deny" = "allow") {
  const root = mkdtempSync(join(tmpdir(), "bottega-connection-lifecycle-"));
  roots.push(root);
  const store = createStore(join(root, "state.db"));
  stores.push(store);
  const authority = new FakeAuthority();
  const boundary = new FakeBoundary();
  const registry = createFixtureRegistry();
  const audit = createAudit(store);
  const currentPolicy = policy(orgMutation);

  async function seed(owner: string | null, scope: "personal" | "org", brokerCredentialId: number) {
    authority.live.add(brokerCredentialId);
    return store.upsertExtensionCredential({
      provider: FIXTURE_EXTENSION_ID,
      identityKey: owner === null ? "org-account" : `account:${owner}`,
      owner,
      scope,
      brokerCredentialId,
    });
  }

  function tools(actor: string) {
    return new Map(
      connectionLifecycleToolDefinitions({
        registry,
        store,
        audit,
        authority,
        boundary,
        gate: {
          loadPolicy: async () => currentPolicy,
          router: { request: async () => ({ approved: true, approver: "UADMIN" }) },
        },
        getPrincipal: () => actor,
        spaceIdFromFile: () => "slack:C1",
      }).map((tool) => [tool.name, tool]),
    );
  }

  async function call(actor: string, name: string, args: LifecycleToolArgs) {
    const tool = tools(actor).get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute("call", args, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    });
  }

  return { store, authority, boundary, registry, seed, call };
}

describe("connection lifecycle caller surface (#318)", () => {
  test("lists and inspects only the caller's personal connections plus org rows, fully redacted", async () => {
    const h = await harness();
    const a = await h.seed("UA", "personal", 11);
    await h.seed("UB", "personal", 12);
    await h.seed(null, "org", 13);

    const listed = await h.call("UA", "list_connections", {});
    expect(listed.isError).toBeUndefined();
    expect(text(listed)).toContain(a.id);
    expect(text(listed)).toContain("scope=personal");
    expect(text(listed)).toContain("scope=org");
    expect(text(listed)).not.toContain("account:UA");
    expect(text(listed)).not.toContain("account:UB");
    expect(text(listed)).not.toContain("broker_credential");
    const model = await listConnectionReadModel({ actor: "UA" }, h);
    expect(model).toHaveLength(2);
    expect(Object.keys(model[0]!).sort()).toEqual([
      "created_at",
      "id",
      "identity_label",
      "label",
      "owner",
      "provider",
      "reconnect_needed",
      "revision",
      "scope",
      "status",
      "updated_at",
    ]);
    expect(JSON.stringify(model)).not.toContain("account:UA");
    expect(JSON.stringify(model)).not.toContain("broker_credential");
    expect(JSON.stringify(model)).not.toContain("vault_provider");

    const foreign = await h.call("UA", "inspect_connection", { connection_id: (await h.store.listExtensionConnections()).find((row) => row.owner === "UB")!.id });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain("not found");
  });

  test("replacement rolls back on proxy preparation failure, then switches by expected revision and revokes only the old authority", async () => {
    const h = await harness();
    const a = await h.seed("UA", "personal", 21);
    await h.seed("UB", "personal", 22);
    h.boundary.failPrepare = true;

    const failed = await h.call("UA", "replace_connection", { connection_id: a.id, expected_revision: 1 });
    expect(failed.isError).toBe(true);
    const rolledBack = await h.store.getExtensionConnection(a.id);
    expect(rolledBack).toMatchObject({ status: "active", revision: 1, broker_credential_id: 21 });
    expect(h.authority.live.has(21)).toBe(true);

    h.boundary.failPrepare = false;
    const replaced = await h.call("UA", "replace_connection", { connection_id: a.id, expected_revision: 1 });
    expect(replaced.isError).toBeUndefined();
    expect(text(replaced)).toContain("revision 2");
    expect(h.authority.revoked).toEqual([100, 21]);

    const stale = await h.call("UA", "replace_connection", { connection_id: a.id, expected_revision: 1 });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("stale revision");
  });

  test("disconnect denies immediately, resumes after partial failure, and duplicate calls are idempotent without touching another principal", async () => {
    const h = await harness();
    const a = await h.seed("UA", "personal", 31);
    const b = await h.seed("UB", "personal", 32);
    h.boundary.active.set(a.id, 31);
    h.boundary.active.set(b.id, 32);
    h.boundary.failDisconnect = true;

    const partial = await h.call("UA", "disconnect_connection", { connection_id: a.id, expected_revision: 1 });
    expect(partial.isError).toBe(true);
    const denied = await h.store.getExtensionConnection(a.id);
    expect(denied).toMatchObject({ status: "disconnecting_boundary", revision: 2 });
    expect((await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).map((row) => row.id)).not.toContain(a.id);

    h.boundary.failDisconnect = false;
    const resumed = await h.call("UA", "disconnect_connection", { connection_id: a.id, expected_revision: 2 });
    expect(resumed.isError).toBeUndefined();
    expect(await h.store.getExtensionConnection(a.id)).toMatchObject({ status: "disconnected", revision: 2, broker_credential_id: 31 });
    expect(h.authority.revoked).toEqual([31]);
    expect(await h.store.getExtensionConnection(b.id)).toMatchObject({ status: "active", broker_credential_id: 32 });
    expect(h.authority.live.has(32)).toBe(true);

    const duplicate = await h.call("UA", "disconnect_connection", { connection_id: a.id, expected_revision: 2 });
    expect(duplicate.isError).toBeUndefined();
    expect(h.authority.revoked).toEqual([31]);

    const phases = (await h.store.listAudit({ event_type: "extension.connection_phase" }))
      .filter((row) => row.actor === "UA")
      .map((row) => PHASE_AUDIT_SCHEMA.parse(JSON.parse(row.payload)).phase);
    expect(phases).toEqual(expect.arrayContaining(["runtime_denied", "boundary_cleared", "authority_revoked", "disconnected"]));
  });

  test("foreign personal mutations fail closed and org deny changes nothing while org allow succeeds", async () => {
    const denied = await harness("deny");
    const personal = await denied.seed("UB", "personal", 41);
    const org = await denied.seed(null, "org", 42);

    const foreign = await denied.call("UA", "disconnect_connection", { connection_id: personal.id, expected_revision: 1 });
    expect(foreign.isError).toBe(true);
    expect(await denied.store.getExtensionConnection(personal.id)).toMatchObject({ status: "active", revision: 1 });

    const orgDenied = await denied.call("UA", "disconnect_connection", { connection_id: org.id, expected_revision: 1 });
    expect(orgDenied.isError).toBe(true);
    expect(await denied.store.getExtensionConnection(org.id)).toMatchObject({ status: "active", revision: 1 });

    const allowed = await harness("allow");
    const allowedOrg = await allowed.seed(null, "org", 51);
    const orgDisconnected = await allowed.call("UA", "disconnect_connection", { connection_id: allowedOrg.id, expected_revision: 1 });
    expect(orgDisconnected.isError).toBeUndefined();
    expect(await allowed.store.getExtensionConnection(allowedOrg.id)).toMatchObject({ status: "disconnected" });
  });

  test("authority revoke failure stays durable and denied until retry", async () => {
    const h = await harness();
    const a = await h.seed("UA", "personal", 61);
    h.authority.failRevoke = true;

    const partial = await h.call("UA", "disconnect_connection", { connection_id: a.id, expected_revision: 1 });
    expect(partial.isError).toBe(true);
    expect(await h.store.getExtensionConnection(a.id)).toMatchObject({ status: "disconnecting_authority", revision: 2 });
    expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);

    h.authority.failRevoke = false;
    const retry = await h.call("UA", "disconnect_connection", { connection_id: a.id, expected_revision: 2 });
    expect(retry.isError).toBeUndefined();
    expect(await h.store.getExtensionConnection(a.id)).toMatchObject({ status: "disconnected", broker_credential_id: 61 });
  });
});
