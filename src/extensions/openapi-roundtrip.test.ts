/**
 * OpenAPI end-to-end round-trip (issue #345 residual #4): through
 * runtime.execute with an openapi-kind extension and the production
 * inject-seam shape — a fake egress seam applies the static auth header
 * (modeling the iron-proxy inject transform) and routes to a fake upstream.
 *
 * The acceptance shape:
 *   - a GET operation lands READ tier → NO approval → the call reaches the
 *     fake upstream;
 *   - a DELETE operation lands WRITE tier → approval (ask-human) under the
 *     default policy — denied without approval, approved+executed with it;
 *   - CREDENTIAL-ABSENCE at the fake upstream: the executor sends the
 *     request credential-free; only the inject seam attaches the header the
 *     upstream observes.
 */
import { describe, expect, test } from "bun:test";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml } from "../policy/config";
import { createStore } from "../store/db";
import { createExtensionRegistry } from "./registry";
import { createExtensionRuntime, type ExtensionRuntimeDeps } from "./runtime";
import type { OpenApiEgressSeam } from "./openapi-executor";
import type { CredentialBoundary, AuthorizationContext } from "./boundary";
import type { AuthorizationRequest } from "./boundary";
import type { ExtensionManifest } from "./manifest";

/** The frozen openapi surface: a GET (read) + a DELETE (write) tool. */
function sendgridManifest(): ExtensionManifest {
  return {
    id: "sendgrid",
    label: "SendGrid",
    vendor: "SendGrid",
    kind: "openapi",
    openapi: { specUrl: "https://spec.example.test/openapi.json", auth: { scheme: "bearer" } },
    credentialSchema: { type: "api_key" },
    tools: [
      {
        name: "sendgrid_get_stats",
        tier: "read",
        description: "Fetch stats",
        params: [{ name: "id", type: "string", location: "path" }],
        openapi: { method: "get", path: "/v3/stats/{id}" },
      },
      {
        name: "sendgrid_delete_campaign",
        tier: "write",
        description: "Delete a campaign",
        params: [{ name: "id", type: "string", location: "path" }],
        openapi: { method: "delete", path: "/v3/campaigns/{id}" },
      },
    ],
    domains: ["api.sendgrid.test"],
    credentialTargets: [{ host: "api.sendgrid.test" }],
  };
}

/** A fake upstream recording every request it received. */
interface UpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

describe("openapi end-to-end round-trip through runtime.execute (issue #345)", () => {
  function harness(opts: { router?: ExtensionRuntimeDeps["router"]; egress?: OpenApiEgressSeam; policy?: ReturnType<typeof parseOrgConfigYaml> }) {
    const registry = createExtensionRegistry();
    registry.register(sendgridManifest());
    const store = createStore(":memory:");
    const boundaryCalls: string[] = [];
    const boundary: CredentialBoundary = {
      async runWithAuthorization<T>(request: AuthorizationRequest, invoke: (context: AuthorizationContext) => Promise<T>): Promise<T> {
        boundaryCalls.push(String(request.credential.id));
        return invoke({ callId: "c1", placeholder: "ph", signal: new AbortController().signal });
      },
    };
    const runtime = createExtensionRuntime({
      registry,
      store,
      audit: createAudit(store),
      orgPolicy: opts.policy ?? parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      router: opts.router ?? DenyRouter,
      boundary,
      openapiEgress: opts.egress,
    });
    return { runtime, store, boundaryCalls };
  }

  test("GET lands read tier → no approval → call reaches the fake upstream with the injected auth; the executor sent none", async () => {
    const upstreamCalls: UpstreamRequest[] = [];
    const executorHeaders: Record<string, string>[] = [];
    const egress: OpenApiEgressSeam = {
      injectForHost: (host) => (host === "api.sendgrid.test" ? { header: "Authorization", formatter: "Bearer {{ .Value }}" } : undefined),
      async fetchWire(request) {
        executorHeaders.push({ ...request.headers });
        const headers = { ...request.headers, Authorization: "Bearer sk-live" };
        upstreamCalls.push({ method: request.method, url: request.url, headers, ...(request.body !== undefined ? { body: request.body } : undefined) });
        return { status: 200, body: '{"ok":true}' };
      },
    };
    const h = harness({ router: DenyRouter, egress });
    await h.store.upsertExtensionCredential({
      provider: "sendgrid",
      identityKey: "api-key:sendgrid",
      owner: null,
      scope: "org",
      brokerCredentialId: 7,
    });

    const result = await h.runtime.execute({
      extensionId: "sendgrid",
      toolName: "sendgrid_get_stats",
      args: { id: "c1" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    // No approval was requested for the read (DenyRouter would have denied
    // an ask-human path) — the request just went out.
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.method).toBe("GET");
    expect(upstreamCalls[0]!.url).toContain("/v3/stats/c1");
    // CREDENTIAL-ABSENCE: the executor sent NO auth header; only the inject
    // seam attached the bearer the upstream observed.
    expect(executorHeaders[0]!["Authorization"]).toBeUndefined();
    expect(executorHeaders[0]!["authorization"]).toBeUndefined();
    expect(upstreamCalls[0]!.headers["Authorization"]).toBe("Bearer sk-live");
    // The ladder + boundary resolved the org credential for the call.
    expect(h.boundaryCalls).toHaveLength(1);
  });

  test("DELETE lands write tier → approval required under default policy (denied without approval)", async () => {
    const upstreamCalls: UpstreamRequest[] = [];
    const egress: OpenApiEgressSeam = {
      injectForHost: (host) => (host === "api.sendgrid.test" ? { header: "Authorization", formatter: "Bearer {{ .Value }}" } : undefined),
      async fetchWire(request) {
        upstreamCalls.push({ method: request.method, url: request.url, headers: { ...request.headers, Authorization: "Bearer sk-live" } });
        return { status: 204, body: "" };
      },
    };
    const h = harness({ router: DenyRouter, egress, policy: parseOrgConfigYaml("tools:\n  unknown: allow\n  sendgrid_delete_campaign: prompt\n") });
    await h.store.upsertExtensionCredential({
      provider: "sendgrid",
      identityKey: "api-key:sendgrid",
      owner: null,
      scope: "org",
      brokerCredentialId: 8,
    });

    const result = await h.runtime.execute({
      extensionId: "sendgrid",
      toolName: "sendgrid_delete_campaign",
      args: { id: "c9" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    // The write-tier DELETE is approval-gated (prompt) under this policy;
    // not granted → the call is refused and NEVER reaches the upstream.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("approval");
    expect(upstreamCalls).toHaveLength(0);
  });

  test("DELETE lands write tier → executed when a human approves, and the injected auth reaches the fake upstream", async () => {
    const upstreamCalls: UpstreamRequest[] = [];
    const egress: OpenApiEgressSeam = {
      injectForHost: (host) => (host === "api.sendgrid.test" ? { header: "Authorization", formatter: "Bearer {{ .Value }}" } : undefined),
      async fetchWire(request) {
        upstreamCalls.push({ method: request.method, url: request.url, headers: { ...request.headers, Authorization: "Bearer sk-live" } });
        return { status: 204, body: "" };
      },
    };
    const approvingRouter: ExtensionRuntimeDeps["router"] = {
      request: async () => ({ approved: true, approver: "U1" }),
    };
    const h = harness({ router: approvingRouter, egress, policy: parseOrgConfigYaml("tools:\n  unknown: allow\n  sendgrid_delete_campaign: prompt\n") });
    await h.store.upsertExtensionCredential({
      provider: "sendgrid",
      identityKey: "api-key:sendgrid",
      owner: null,
      scope: "org",
      brokerCredentialId: 9,
    });

    const result = await h.runtime.execute({
      extensionId: "sendgrid",
      toolName: "sendgrid_delete_campaign",
      args: { id: "c9" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(true);
    // The DELETE reached the fake upstream with the injected auth.
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.method).toBe("DELETE");
    expect(upstreamCalls[0]!.url).toContain("/v3/campaigns/c9");
    expect(upstreamCalls[0]!.headers["Authorization"]).toBe("Bearer sk-live");
  });
});