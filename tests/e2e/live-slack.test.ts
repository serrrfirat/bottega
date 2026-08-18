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
import { runCanary, resolveLiveTokens, resolveModelKey } from "./canary";
import { bootHarness, CANARY_MODEL_REFS, pickRealModelRef } from "./harness";

/** Env vars the canary reads; scrubbed and restored around each test. */
const CANARY_ENV_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_QA_USER_TOKEN",
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
