/**
 * OAuth callback endpoint tests (issue #198 + #196 follow-up): the stable
 * local port (BOTTEGA_CALLBACK_PORT) the inbound surface binds — a static
 * tunnel / reverse proxy cannot forward to an ephemeral port, so a
 * deployment pins it; absent → ephemeral (tests and local dev, unchanged).
 * The upload-link leg (#196) mounts onto the SAME listener: one stable port
 * serves /upload/*, /oauth/callback, and the webhook route.
 * Hermetic: a real in-process Bun.serve endpoint on 127.0.0.1, a real
 * SQLite store, a recording broker/router. Nothing touches the network,
 * Slack, or a transcript.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { createAudit } from "../policy/audit";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { fixtureManifest } from "./fixture";
import { createExtensionRegistry } from "./registry";
import { mountUploadLink, type UploadLinkEndpointDeps } from "./upload-link";
import { callbackPort, startOAuthCallbackServer } from "./oauth-callback";

const dir = mkdtempSync(join(tmpdir(), "bottega-oauth-callback-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return { store, audit: createAudit(store) };
}

class RecordingRouter implements ApprovalRouter {
  readonly requests: ApprovalRequest[] = [];
  constructor(private resolution: ApprovalResolution = { approved: true }) {}
  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    this.requests.push(d);
    return this.resolution;
  }
}

class RecordingBroker {
  readonly calls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
  async connect(input: { provider: string; credentialType: string; apiKey?: string }): Promise<{ identityKey: null; brokerCredentialId: number }> {
    this.calls.push(input);
    return { identityKey: null, brokerCredentialId: 9 };
  }
}

/** The upload-link mount with real deps, as the boot wires it. */
function uploadMount(store: Store, audit: ReturnType<typeof createAudit>): ReturnType<typeof mountUploadLink> {
  const registry = createExtensionRegistry();
  registry.register(fixtureManifest());
  const router = new RecordingRouter();
  const broker = new RecordingBroker();
  const policy: PolicyConfig = parseOrgConfigYaml("");
  return mountUploadLink({
    registry,
    store,
    audit,
    broker: broker.connect.bind(broker),
    gate: { loadPolicy: () => Promise.resolve(policy), router },
  } satisfies UploadLinkEndpointDeps);
}

describe("oauth callback endpoint — stable local port (issue #196 follow-up)", () => {
  test("BOTTEGA_CALLBACK_PORT pins the listener; absent → ephemeral", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    const h = harness();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18766";
      const pinned = startOAuthCallbackServer({ store: h.store, audit: h.audit });
      try {
        expect(pinned.baseUrl).toBe("http://127.0.0.1:18766");
      } finally {
        pinned.stop();
      }
      delete process.env.BOTTEGA_CALLBACK_PORT;
      const ephemeral = startOAuthCallbackServer({ store: h.store, audit: h.audit });
      try {
        expect(ephemeral.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
        expect(ephemeral.baseUrl).not.toBe("http://127.0.0.1:18766");
      } finally {
        ephemeral.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("callbackPort rejects an invalid port (fail closed)", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "abc";
      expect(() => callbackPort()).toThrow(/BOTTEGA_CALLBACK_PORT/);
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("the upload-link leg mounts onto the SAME listener — one stable port serves /upload/* and /oauth/callback", async () => {
    const h = harness();
    const upload = uploadMount(h.store, h.audit);
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18767";
      const server = startOAuthCallbackServer({ store: h.store, audit: h.audit, uploadLink: upload });
      try {
        expect(server.baseUrl).toBe("http://127.0.0.1:18767");
        // The mint (as server/index.ts wires it) points at the shared
        // surface's baseUrl — the upload form and the callback live on the
        // same listener.
        const minted = upload.store.mint({
          extension: "fixture.weather",
          scope: "personal",
          actor: "UADA",
          label: "Fixture Weather",
        });
        expect(minted.ok).toBe(true);
        const form = await fetch(`${server.baseUrl}/upload/${minted.ok ? minted.token : ""}`);
        expect(form.status).toBe(200);
        expect(await form.text()).toContain('name="secret"');
        // /oauth/callback is served by the same listener: no code/state →
        // the callback route answers (400), not the surface's 404.
        expect((await fetch(`${server.baseUrl}/oauth/callback`)).status).toBe(400);
        // Unknown paths still fail closed.
        expect((await fetch(`${server.baseUrl}/nope`)).status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });
});
