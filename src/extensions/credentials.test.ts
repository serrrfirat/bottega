import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type ExtensionCredential, type Store } from "../store/db";
import { EXTENSION_CREDENTIAL_RESOLVED_EVENT } from "../store/audit-events";
import { orgCredentialsAllowed, parseOrgConfigYaml } from "../policy/config";
import { accountPoolFor, recordCredentialResolution, resolveCredential } from "./credentials";

const dir = mkdtempSync(join(tmpdir(), "bottega-creds-"));
const store: Store = createStore(join(dir, "test.db"));
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(overrides: Partial<ExtensionCredential>): ExtensionCredential {
  return {
    id: "ec_test",
    provider: "github",
    identity_key: "email:ada@example.com",
    owner: null,
    scope: "org",
    broker_credential_id: 7,
    created_at: 1,
    ...overrides,
  };
}

const org = row({ scope: "org", owner: null });
const adas = row({ scope: "personal", owner: "UADA", identity_key: "email:ada@example.com" });
const bobs = row({ scope: "personal", owner: "UBOB", identity_key: "email:bob@example.com" });

/** findCredential over an in-memory list; personal lookups are owner-filtered, org lookups ignore the owner. */
function lookup(rows: ExtensionCredential[]) {
  return (scope: "org" | "personal", owner: string | null): ExtensionCredential | null => {
    if (scope === "org") return rows.find((r) => r.scope === "org") ?? null;
    return rows.find((r) => r.scope === "personal" && r.owner === owner) ?? null;
  };
}

describe("resolveCredential org scope", () => {
  test("resolves the org credential for the provider", () => {
    const res = resolveCredential({
      callScope: "org",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([org]),
    });
    expect(res).toEqual({ kind: "credential", credential: org });
  });

  test("missing org credential errors with the connect-as-organization message", () => {
    const res = resolveCredential({
      callScope: "org",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([]),
    });
    expect(res).toEqual({ kind: "error", message: "connect github as an organization" });
  });

  test("org scope never falls back to a personal credential", () => {
    const res = resolveCredential({
      callScope: "org",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: true },
      findCredential: lookup([adas]),
    });
    expect(res.kind).toBe("error");
  });
});

describe("resolveCredential me scope", () => {
  test("resolves the caller's personal credential", () => {
    const res = resolveCredential({
      callScope: "me",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([bobs, adas]),
    });
    expect(res).toEqual({ kind: "credential", credential: adas });
  });

  // Missing and someone-else's-only are the same observable outcome: the
  // ladder never guesses, so both surface the connect-your-account error.
  test("missing personal credential (or only someone else's) errors with the connect-your-account message", () => {
    const res = resolveCredential({
      callScope: "me",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([bobs]),
    });
    expect(res).toEqual({ kind: "error", message: "connect your github account" });
  });

  test("me scope never falls back to the org credential", () => {
    const res = resolveCredential({
      callScope: "me",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: true },
      findCredential: lookup([org]),
    });
    expect(res.kind).toBe("error");
  });
});

describe("resolveCredential auto scope", () => {
  test("org credential wins when the space policy allows org usage", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: true },
      findCredential: lookup([adas, org]),
    });
    expect(res).toEqual({ kind: "credential", credential: org });
  });

  test("falls back to the caller's personal credential when org usage is not allowed", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([org, adas]),
    });
    expect(res).toEqual({ kind: "credential", credential: adas });
  });

  test("falls back to personal when org usage is allowed but no org credential is connected", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: true },
      findCredential: lookup([adas]),
    });
    expect(res).toEqual({ kind: "credential", credential: adas });
  });

  test("asks when nothing is available and org usage is not allowed", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([]),
    });
    expect(res.kind).toBe("ask");
    expect(res.kind === "ask" ? res.reason : "").toContain("org usage is not allowed");
  });

  test("asks when org usage is allowed but neither an org nor a personal credential exists", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: true },
      findCredential: lookup([]),
    });
    expect(res.kind).toBe("ask");
    expect(res.kind === "ask" ? res.reason : "").toContain("allowed by this space's policy");
  });

  test("auto never guesses: no credential is fabricated when only another user's row exists", () => {
    const res = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: false },
      findCredential: lookup([bobs]),
    });
    expect(res.kind).toBe("ask");
  });

  test("auto honors the extensions.org_credentials policy gate (issue #56)", () => {
    // org_credentials: deny (org floor) → the org credential is skipped even
    // though it is connected; the caller's personal credential wins.
    const deniedPolicy = parseOrgConfigYaml("extensions:\n  org_credentials: deny\n");
    const denied = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: orgCredentialsAllowed(deniedPolicy) },
      findCredential: lookup([org, adas]),
    });
    expect(denied).toEqual({ kind: "credential", credential: adas });
    // Default (allow) → the org credential wins.
    const defaultPolicy = parseOrgConfigYaml("");
    expect(orgCredentialsAllowed(defaultPolicy)).toBe(true);
    const allowed = resolveCredential({
      callScope: "auto",
      caller: "UADA",
      provider: "github",
      spacePolicy: { orgUsageAllowed: orgCredentialsAllowed(defaultPolicy) },
      findCredential: lookup([adas, org]),
    });
    expect(allowed).toEqual({ kind: "credential", credential: org });
  });
});

describe("accountPoolFor", () => {
  test("maps a provider to the resolved identity key for the broker pool file", () => {
    expect(accountPoolFor("github", "email:ada@example.com")).toEqual({ github: ["email:ada@example.com"] });
  });
});

describe("recordCredentialResolution", () => {
  test("writes an extension.credential_resolved audit row with credential id and actor", async () => {
    await recordCredentialResolution(store, { actor: "UADA", spaceId: "slack:C1", credential: adas });

    const rows = await store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("UADA");
    expect(rows[0]!.space_id).toBe("slack:C1");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      provider: "github",
      scope: "personal",
      identity_key: "email:ada@example.com",
      credential_id: "ec_test",
      broker_credential_id: 7,
    });
  });
});
