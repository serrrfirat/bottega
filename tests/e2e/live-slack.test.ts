/**
 * Live-Slack canary skip-gate proofs (issues #79 + #175).
 *
 * The live leg needs real workspace tokens and NEVER runs in ad-hoc CI —
 * this file proves the gates: missing tokens → clean skip message; no flag
 * → usage skip; CI set → refusal; CI-strict mode (--ci / CANARY_CI=1, the
 * scheduled workflow, #175) FAILS instead of skipping when tokens or the
 * model key are missing; harness refuses realSlack without tokens. All
 * hermetic: env is scrubbed per test, the Keychain reader is stubbed, and
 * no Slack API call can ever be reached from these tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanary, resolveLiveTokens, resolveModelKey, resolveRoleIdentities, LIVE_REGISTRY_IDS, registryJourneyLayer, resolveLiveJourneySelection } from "./canary";
import { parseCanaryFilters } from "./canary-registry";
import { bootHarness, CANARY_MODEL_REFS, pickRealModelRef } from "./harness";
import { resolveChannelMembers, type SlackInviteApi } from "./slack-live";
import type { JsonObject } from "../../src/extensions/manifest";

/** Env vars the canary reads; scrubbed and restored around each test. */
const CANARY_ENV_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_QA_USER_TOKEN",
  "SLACK_QA_REQUESTER_TOKEN",
  "SLACK_QA_APPROVER_TOKEN",
  "SLACK_QA_MEMBER_TOKEN",
  "SLACK_QA_SECOND_MEMBER_TOKEN",
  "SLACK_QA_USER_ID",
  "SLACK_QA_USER_NAME",
  "SLACK_QA_CHANNEL",
  "LIVE_SLACK",
  "CI",
  "CANARY_CI",
  "NEAR_API_KEY",
  "OPENCODE_API_KEY",
  "CODEX_AUTH_PATH",
  "CANARY_MODEL_REF",
] as const;

function withScrubbedEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of CANARY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of CANARY_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("live-slack canary skip gates (issue #79)", () => {
  test("skips with a clear message when workspace tokens are missing (env and Keychain)", async () => {
    await withScrubbedEnv(async () => {
      const result = await runCanary(["--live-slack"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("skipped");
      expect(result.message).toContain("SLACK_APP_TOKEN");
      expect(result.message).toContain("SLACK_BOT_TOKEN");
      expect(result.message).toContain("SLACK_QA_USER_TOKEN");
      expect(result.message).toContain("issue #79");
      expect(result.journeys).toEqual([]);
    });
  });

  test("skips with usage when --live-slack / LIVE_SLACK=1 is absent", async () => {
    await withScrubbedEnv(async () => {
      const result = await runCanary([], { env: process.env, keychain: () => null });
      expect(result.status).toBe("skipped");
      expect(result.message).toContain("--live-slack");
      // Even with tokens present, no flag → no live run.
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      const withTokens = await runCanary([], { env: process.env, keychain: () => null });
      expect(withTokens.status).toBe("skipped");
    });
  });

  test("refuses to run in CI even with tokens present", async () => {
    await withScrubbedEnv(async () => {
      process.env.CI = "true";
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      const result = await runCanary(["--live-slack"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("skipped");
      expect(result.message).toMatch(/CI/i);
    });
  });

  test("CI-strict mode (--ci) fails instead of skipping when secrets are missing (issue #175)", async () => {
    await withScrubbedEnv(async () => {
      process.env.CI = "true";
      const result = await runCanary(["--live-slack", "--ci"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("failed");
      expect(result.message).toMatch(/FAILED in CI-strict mode/);
      expect(result.message).toContain("SLACK_APP_TOKEN");
      expect(result.message).toContain("SLACK_BOT_TOKEN");
      expect(result.message).toContain("SLACK_QA_USER_TOKEN");
      expect(result.message).toContain("issue #175");
      expect(result.journeys).toEqual([]);
    });
  });

  test("CANARY_CI=1 is equivalent to --ci for the missing-secrets gate (issue #175)", async () => {
    await withScrubbedEnv(async () => {
      process.env.CI = "true";
      process.env.CANARY_CI = "1";
      const result = await runCanary(["--live-slack"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("failed");
      expect(result.message).toMatch(/FAILED in CI-strict mode/);
    });
  });

  test("CI-strict mode fails when the model key is missing but tokens are present (issue #175)", async () => {
    await withScrubbedEnv(async () => {
      process.env.CI = "true";
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      const result = await runCanary(["--live-slack", "--ci"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("failed");
      expect(result.message).toMatch(/FAILED in CI-strict mode/);
      expect(result.message).toContain("NEAR_API_KEY");
      expect(result.message).toContain("CODEX_AUTH_PATH");
      expect(result.message).toContain("CANARY_MODEL_REF");
    });
  });

  test("CI-strict mode fails with a clear diagnostic when the fixed-identity tokens are missing (issue #298)", async () => {
    await withScrubbedEnv(async () => {
      process.env.CI = "true";
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      process.env.CANARY_MODEL_REF = "near/example/model";
      const result = await runCanary(["--live-slack", "--ci"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("failed");
      expect(result.message).toMatch(/FAILED in CI-strict mode/);
      // The diagnostic names the missing identity token(s) (findings #6/#9).
      expect(result.message).toContain("SLACK_QA_REQUESTER_TOKEN");
      expect(result.message).toContain("fixed-identity");
    });
  });

  test("with all four identity tokens wired, resolveLiveTokens reports no missing identity (finding #6/#9)", async () => {
    await withScrubbedEnv(async () => {
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      process.env.SLACK_QA_REQUESTER_TOKEN = "xoxp-r";
      process.env.SLACK_QA_APPROVER_TOKEN = "xoxp-a";
      process.env.SLACK_QA_MEMBER_TOKEN = "xoxp-m";
      process.env.SLACK_QA_SECOND_MEMBER_TOKEN = "xoxp-m2";
      const resolved = resolveLiveTokens({ env: process.env, keychain: () => null });
      expect(resolved.tokens).toBeDefined();
      expect(resolved.missing).toEqual([]);
      expect(resolved.identityMissing).toEqual([]);
      // Without the identity tokens, each is reported under identityMissing.
      delete process.env.SLACK_QA_REQUESTER_TOKEN;
      delete process.env.SLACK_QA_APPROVER_TOKEN;
      delete process.env.SLACK_QA_MEMBER_TOKEN;
      delete process.env.SLACK_QA_SECOND_MEMBER_TOKEN;
      const partial = resolveLiveTokens({ env: process.env, keychain: () => null });
      expect(partial.missing).toEqual([]); // base tokens still present
      expect(partial.identityMissing).toEqual([
        "SLACK_QA_REQUESTER_TOKEN",
        "SLACK_QA_APPROVER_TOKEN",
        "SLACK_QA_MEMBER_TOKEN",
        "SLACK_QA_SECOND_MEMBER_TOKEN",
      ]);
    });
  });

  test("skips with a clear message when no model key is available (tokens present)", async () => {
    await withScrubbedEnv(async () => {
      process.env.SLACK_APP_TOKEN = "xapp-test";
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-test";
      const result = await runCanary(["--live-slack"], { env: process.env, keychain: () => null });
      expect(result.status).toBe("skipped");
      expect(result.message).toContain("NEAR_API_KEY");
      expect(result.message).toContain("OPENCODE_API_KEY");
      expect(result.message).toContain("CODEX_AUTH_PATH");
    });
  });

  test("model key resolution: CANARY_MODEL_REF overrides; codex beats NEAR; NEAR beats opencode; Keychain fills", async () => {
    await withScrubbedEnv(() => {
      expect(resolveModelKey({ env: process.env, keychain: () => null })).toBeNull();
      // A resolvable Codex CLI auth file (issue #214) beats NEAR when both are present.
      const dir = mkdtempSync(join(tmpdir(), "bottega-codex-key-"));
      try {
        const authPath = join(dir, "auth.json");
        writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt" } }));
        process.env.CODEX_AUTH_PATH = authPath;
        process.env.NEAR_API_KEY = "near-env";
        process.env.OPENCODE_API_KEY = "opencode-env";
        expect(resolveModelKey({ env: process.env, keychain: () => null })).toBe(authPath);
        // A path that does not resolve (missing file) does NOT gate codex — NEAR wins.
        process.env.CODEX_AUTH_PATH = join(dir, "missing.json");
        expect(resolveModelKey({ env: process.env, keychain: () => null })).toBe("near-env");
        delete process.env.CODEX_AUTH_PATH;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // NEAR beats opencode when both are present.
      process.env.NEAR_API_KEY = "near-env";
      process.env.OPENCODE_API_KEY = "opencode-env";
      expect(resolveModelKey({ env: process.env, keychain: () => null })).toBe("near-env");
      // Keychain fills when env lacks.
      delete process.env.NEAR_API_KEY;
      const fromKeychain = resolveModelKey({
        env: process.env,
        keychain: (service) => (service === "bottega-near" ? "near-kc" : null),
      });
      expect(fromKeychain).toBe("near-kc");
      // Explicit model ref overrides the key checks entirely (issue #71).
      process.env.CANARY_MODEL_REF = "custom/model";
      expect(resolveModelKey({ env: process.env, keychain: () => null })).toBe("custom/model");
    });
  });

  test("token resolution: env first, Keychain second, QA defaults applied", async () => {
    await withScrubbedEnv(() => {
      expect(resolveLiveTokens({ env: process.env, keychain: () => null }).missing).toEqual([
        "SLACK_APP_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_QA_USER_TOKEN",
      ]);
      process.env.SLACK_APP_TOKEN = "xapp-env";
      process.env.SLACK_BOT_TOKEN = "xoxb-env";
      process.env.SLACK_QA_USER_TOKEN = "xoxp-env";
      const fromEnv = resolveLiveTokens({ env: process.env, keychain: () => null });
      expect(fromEnv.tokens).toMatchObject({
        appToken: "xapp-env",
        botToken: "xoxb-env",
        qaUserToken: "xoxp-env",
        qaUserName: "bottega-qa",
        channelName: "bottega-qa",
      });
      // Keychain fills what env lacks.
      delete process.env.SLACK_QA_USER_TOKEN;
      const fromKeychain = resolveLiveTokens({
        env: process.env,
        keychain: (service) => (service === "bottega-slack-qa" ? "xoxp-keychain" : null),
      });
      expect(fromKeychain.tokens?.qaUserToken).toBe("xoxp-keychain");
      expect(fromKeychain.missing).toEqual([]);
      // Explicit QA identity passes through.
      process.env.SLACK_QA_USER_TOKEN = "xoxp-env";
      process.env.SLACK_QA_USER_ID = "U0QA";
      process.env.SLACK_QA_USER_NAME = "tester-qa";
      process.env.SLACK_QA_CHANNEL = "qa-room";
      const withIdentity = resolveLiveTokens({ env: process.env, keychain: () => null });
      expect(withIdentity.tokens).toMatchObject({ qaUserId: "U0QA", qaUserName: "tester-qa", channelName: "qa-room" });
    });
  });

  test("bootHarness refuses realSlack mode without tokens (harness-level gate)", async () => {
    await expect(bootHarness({ realSlack: true })).rejects.toThrow(/slackTokens/);
  });
});

describe("harness model ref resolution (issue #214)", () => {
  test("pickRealModelRef precedence: CANARY_MODEL_REF > codex > near > opencode", async () => {
    await withScrubbedEnv(() => {
      const env = () => ({ ...process.env });
      expect(pickRealModelRef(env())).toBeNull();

      const dir = mkdtempSync(join(tmpdir(), "bottega-codex-ref-"));
      try {
        const authPath = join(dir, "auth.json");
        writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt" } }));
        // A resolvable Codex CLI auth file (issue #214) wins over NEAR and
        // opencode; an unresolvable path does not gate codex.
        process.env.CODEX_AUTH_PATH = authPath;
        process.env.NEAR_API_KEY = "near-env";
        process.env.OPENCODE_API_KEY = "opencode-env";
        expect(pickRealModelRef(env())).toBe(CANARY_MODEL_REFS.codex);
        process.env.CODEX_AUTH_PATH = join(dir, "missing.json");
        expect(pickRealModelRef(env())).toBe(CANARY_MODEL_REFS.near);
        delete process.env.CODEX_AUTH_PATH;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      // NEAR beats opencode; CANARY_MODEL_REF overrides everything.
      delete process.env.NEAR_API_KEY;
      expect(pickRealModelRef(env())).toBe(CANARY_MODEL_REFS.opencode);
      process.env.CANARY_MODEL_REF = "custom/model";
      expect(pickRealModelRef(env())).toBe("custom/model");
    });
  });

  test("under the test runner, an UNSET CODEX_AUTH_PATH never reads a real home auth file", async () => {
    // The #191 isolation rule: hermetic tests must not resolve codex
    // against the dev machine's real ~/.codex/auth.json.
    await withScrubbedEnv(() => {
      process.env.NEAR_API_KEY = "near-env";
      expect(pickRealModelRef({ ...process.env })).toBe(CANARY_MODEL_REFS.near);
    });
  });
});

describe("channel membership flag (issue #245)", () => {
  test("the flag reflects REAL membership: an already-joined bot reports present, not the invite error code", async () => {
    // conversations.invite rejects with already_in_channel a user who is
    // ALREADY in the channel, so invite-success flagging reported "bot in
    // channel: false" for a bot that was really there — the #245
    // misclassification. The flag must come from conversations.members,
    // read after the best-effort invites. The stub mirrors Slack's real
    // behavior: the members list starts with the bot (already joined), QA
    // absent; conversations.invite for the bot re-throws
    // already_in_channel, for QA succeeds and joins. Red on the pre-fix
    // code: invite-success flagging shallowly returns { bot: false,
    // qa: true } — the already-joined bot reads as absent.
    let members = ["B-bot"];
    const calls: string[] = [];
    const api: SlackInviteApi = {
      call: async <T = JsonObject>(method: string, body?: JsonObject): Promise<T> => {
        calls.push(method);
        if (method === "conversations.members") return { members } as T;
        if (method === "conversations.invite") {
          const userId = typeof body?.users === "string" ? body.users : "";
          if (members.includes(userId)) {
            throw new Error("slack api conversations.invite: already_in_channel");
          }
          members = [...members, userId];
          return { ok: true } as T;
        }
        throw new Error(`unexpected slack api method ${method}`);
      },
    };
    const flag = await resolveChannelMembers(api, "C1", { bot: "B-bot", qa: "U-qa" });
    expect(flag).toEqual({ bot: true, qa: true });
    // The flag must be derived from the real membership read, not from a
    // guess — at least one conversations.members call must have happened.
    expect(calls.filter((m) => m === "conversations.members").length).toBeGreaterThan(0);
  });
});

describe("live-API focused filters (issue #298 re-review)", () => {
  test("--role space-approver canonicalizes to the approver identity and is non-vacuous (approver actually posts)", () => {
    const { identities, problem } = resolveRoleIdentities("space-approver");
    expect(problem).toBeUndefined();
    expect(identities).toEqual(["approver"]);
  });

  test("--role approver selects exactly the approver identity (never an empty vacuous pass)", () => {
    const { identities, problem } = resolveRoleIdentities("approver");
    expect(problem).toBeUndefined();
    expect(identities).toEqual(["approver"]);
  });

  test("an unknown or generic --role fails closed (problem), never a vacuous pass with no actor", () => {
    expect(resolveRoleIdentities("nobody").problem).toMatch(/unknown --role/);
    expect(resolveRoleIdentities("nobody").identities).toEqual([]);
    // No filter → every fixed identity drives (the full matrix).
    expect(resolveRoleIdentities(undefined).identities).toEqual([
      "requester",
      "approver",
      "member",
      "second-member",
    ]);
  });

  test("--journey selects live bodies by CANONICAL registry ids: one dotted id selects exactly its body, no-body ids fail closed (issue #298)", () => {
    // The canonical namespace is the registry's dotted journey ids — the
    // same namespace parseCanaryFilters validates and the workflow inputs
    // expose. A live.roles.* id maps to the role/multiplayer matrix body.
    expect(LIVE_REGISTRY_IDS).toContain("live.roles.approve-deny");
    expect(LIVE_REGISTRY_IDS).toContain("live.roles.queue-ownership");
    // No short ids leak into the canonical selectable set (the old defect):
    // a short id is NOT a registry id, so it cannot select a body.
    expect((LIVE_REGISTRY_IDS as readonly string[]).includes("roles")).toBe(false);
    expect((LIVE_REGISTRY_IDS as readonly string[]).includes("chat-reply")).toBe(false);
    // A no-body registry journey resolves to its layer for the precise
    // fail-closed message: browser + hermetic journeys have no live-API body.
    expect(registryJourneyLayer("browser.dm-card-lifecycle")).toBe("browser");
    expect(registryJourneyLayer("roles.approve-deny-actors")).toBe("hermetic");
    // An unknown id is not a registry journey at all.
    expect(registryJourneyLayer("nonsense")).toBeUndefined();
  });

  test("end-to-end --journey: parseCanaryFilters resolves a dotted registry id to exactly the roles body, and a no-body dotted id fails closed", () => {
    // A dotted live.roles.* id passes parseCanaryFilters (it is a registered
    // journey) and the selector resolves it to the roles body — proving one
    // actual registry id selects exactly its body (unrelated bodies do not run).
    const filter = parseCanaryFilters(["--journey", "live.roles.approve-deny"]);
    expect(filter.journey).toBe("live.roles.approve-deny");
    expect(resolveLiveJourneySelection(filter.journey!)).toEqual({
      runner: "roles",
      problem: undefined,
    });
    // A different live.roles.* id selects the same body (the role matrix), so
    // a focused --journey never runs an unrelated journey body.
    expect(resolveLiveJourneySelection("live.roles.queue-ownership").runner).toBe("roles");
    // A no-body dotted registry id fails closed with a precise layer message.
    const browser = resolveLiveJourneySelection("browser.dm-card-lifecycle");
    expect(browser.runner).toBeUndefined();
    expect(browser.problem).toMatch(/browser.*layer|runs in the "browser" layer/);
    const hermetic = resolveLiveJourneySelection("roles.cross-user-queue-ownership");
    expect(hermetic.runner).toBeUndefined();
    expect(hermetic.problem).toMatch(/hermetic/);
    // An unknown id fails closed as not a registered journey.
    const unk = resolveLiveJourneySelection("nonsense");
    expect(unk.runner).toBeUndefined();
    expect(unk.problem).toMatch(/not a registered journey/);
  });
});
