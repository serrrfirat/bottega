/**
 * Ingest provider registry tests (issue #57): the single name → adapter
 * lookup for BOTH inbound legs (webhook verifier, poller). The registry is
 * the fail-closed routing seam — unknown providers THROW (an operator
 * error, never a silent no-op), and each known provider routes to its own
 * concrete adapter. These drive the REAL adapters through the registry's
 * public routes: no mock.module, no network, no GitHub, no Slack. The
 * Linear leg is a config-only skeleton (issue #57) whose entire contract is
 * "never configured → refuse/no-op", so its routing is asserted through the
 * registry, not as a tautology on the constant itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPoller, getVerifier, getWatermarkedPoller } from "./registry";
import { linearSignatureVerifier } from "./linear/webhook";
import { githubSignatureVerifier } from "./github/webhook";

const savedTokenFile = process.env.EXECUTOR_GIT_TOKEN_FILE;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedTokenFile === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
  else process.env.EXECUTOR_GIT_TOKEN_FILE = savedTokenFile;
});

/** A fresh temp dir, tracked for cleanup, pointed at by EXECUTOR_GIT_TOKEN_FILE. */
function freshUnconfiguredEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-ingest-registry-"));
  dirs.push(dir);
  // Point the github poller's default token file at a MISSING path so a poll
  // through the registry is the unconfigured no-op — no network is ever hit.
  process.env.EXECUTOR_GIT_TOKEN_FILE = join(dir, "does-not-exist");
  return dir;
}

function sha256Hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("getVerifier — webhook signature routing (issue #57)", () => {
  test("github routes to the real X-Hub-Signature-256 verifier", async () => {
    const verifier = getVerifier("github");
    expect(verifier).toBe(githubSignatureVerifier);
    // The routed adapter really verifies a GitHub HMAC signature over the raw body.
    const body = JSON.stringify({ action: "created" });
    const good = `sha256=${sha256Hex(body, "secret")}`;
    expect(await verifier.verify({ "x-hub-signature-256": good }, body, "secret")).toBe(true);
    expect(await verifier.verify({ "x-hub-signature-256": good }, body, "other")).toBe(false);
    // A missing signature is refused (fail closed).
    expect(await verifier.verify({}, body, "secret")).toBe(false);
  });

  test("linear routes to a fail-closed verifier that refuses every delivery", async () => {
    const verifier = getVerifier("linear");
    expect(verifier).toBe(linearSignatureVerifier);
    // Linear's webhook journey is not wired (issue #57): the verifier NEVER
    // accepts a signature — any headers, any body, any secret → false, so the
    // webhook route rejects the delivery (401, nothing dispatched). It never
    // throws (the route depends on a boolean verdict, not an exception).
    await expect(
      verifier.verify({ "linear-signature": "anything" }, "any raw body", "any secret"),
    ).resolves.toBe(false);
    await expect(verifier.verify({}, "", "")).resolves.toBe(false);
  });

  test("an unknown provider is an operator error → throws (fail closed)", () => {
    expect(() => getVerifier("not-a-provider")).toThrow(/unknown ingest provider: not-a-provider/);
  });
});

describe("getPoller — polling leg routing (issue #57)", () => {
  test("github routes to a real poller (unconfigured → safe empty poll, no network)", async () => {
    freshUnconfiguredEnv();
    const poller = getPoller("github");
    // The routed adapter is the real github poller: with no token file it is
    // unconfigured and yields zero events without ever touching the network.
    expect(await poller.poll()).toEqual([]);
  });

  test("linear routes to the config-only no-op poller (never emits, never throws)", async () => {
    const poller = getPoller("linear");
    expect(await poller.poll()).toEqual([]);
    // A configured-Linear future must never silently emit without config; the
    // skeleton is the fail-safe: poll stays empty and the loop survives.
    await expect(poller.poll()).resolves.toEqual([]);
  });

  test("an unknown provider is an operator error → throws (fail closed)", () => {
    expect(() => getPoller("not-a-provider")).toThrow(/unknown ingest provider: not-a-provider/);
  });
});

describe("getWatermarkedPoller — durable cursor routing (issue #101)", () => {
  test("github routes to the poller that consults the durable cursor", async () => {
    freshUnconfiguredEnv();
    const reads: number[] = [];
    const watermark = {
      getCursor: async () => {
        reads.push(1);
        return "1750000000000";
      },
      setCursor: async () => {},
    };
    const poller = getWatermarkedPoller("github", watermark);
    // The worker's poll-fetch leg (executor runIngestPollJob) supplies this
    // ingest_watermark-backed seam; the registry must thread it through so the
    // real poller seeds from it on every poll. With no token file the poll is a
    // safe no-op, but the cursor is still consulted (seedWatermark) first.
    await poller.poll();
    expect(reads.length).toBeGreaterThan(0);
  });

  test("linear drops the cursor seam — the no-op poller ignores it entirely", async () => {
    const calls: string[] = [];
    const watermark = {
      getCursor: async () => {
        calls.push("read");
        return "1750000000000";
      },
      setCursor: async (cursor: string) => {
        calls.push(`write:${cursor}`);
      },
    };
    const poller = getWatermarkedPoller("linear", watermark);
    // Linear's poller (issue #57) has NO cursor semantics — the registry
    // deliberately returns the config-only skeleton and never threads the
    // durable seam. The executor's poll-fetch leg must never attempt a
    // watermark read/write for a provider that cannot resume.
    expect(await poller.poll()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an unknown provider is an operator error → throws (fail closed)", () => {
    expect(() =>
      getWatermarkedPoller("not-a-provider", {
        getCursor: async () => null,
        setCursor: async () => {},
      }),
    ).toThrow(/unknown ingest provider: not-a-provider/);
  });
});