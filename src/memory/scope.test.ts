/**
 * Unit contract for permission-aware scope derivation (issue #137).
 *
 * The writable/readable scope sets are the identity seam: a bug here is a
 * cross-user lease, so the derivation rules are pinned directly, not only
 * through callers.
 */
import { describe, expect, test } from "bun:test";
import { deriveReadableScopes, deriveWritableScopes, type MemoryScopeContext } from "./scope";

function ctx(partial: Partial<MemoryScopeContext>): MemoryScopeContext {
  return { spaceId: "slack:C1", principal: undefined, directMessage: false, teamId: undefined, ...partial };
}

describe("deriveWritableScopes (issue #137)", () => {
  test("a DM writes its own person key", () => {
    expect(deriveWritableScopes(ctx({ spaceId: "slack:D9", principal: "U1", directMessage: true }))).toEqual([
      { kind: "person", principal: "U1" },
    ]);
  });

  test("a DM with NO authenticated principal derives NO writable scope (fail closed)", () => {
    // A turn nobody started (or a broken identity seam) must not fall back
    // to a channel key — nothing is writable.
    expect(deriveWritableScopes(ctx({ spaceId: "slack:D9", principal: undefined, directMessage: true }))).toEqual([]);
  });

  test("a shared channel writes its own channel key", () => {
    expect(deriveWritableScopes(ctx({ spaceId: "slack:C1", directMessage: false }))).toEqual([
      { kind: "channel", spaceId: "slack:C1" },
    ]);
  });
});

describe("deriveReadableScopes (issue #137)", () => {
  test("a DM recalls person + org, never channel/team", () => {
    expect(
      deriveReadableScopes(ctx({ spaceId: "slack:D9", principal: "U1", directMessage: true, teamId: "eng" })).keys,
    ).toEqual([{ kind: "org" }, { kind: "person", principal: "U1" }]);
  });

  test("a channel recalls channel + configured team + org, never person", () => {
    expect(
      deriveReadableScopes(ctx({ spaceId: "slack:C1", principal: "U1", directMessage: false, teamId: "eng" })).keys,
    ).toEqual([{ kind: "org" }, { kind: "channel", spaceId: "slack:C1" }, { kind: "team", teamId: "eng" }]);
  });
});