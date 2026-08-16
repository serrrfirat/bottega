/**
 * Credential boundary control wiring (issue #123): the reload half of the
 * boundary engages only when BOTH the proxy control URL and its bearer
 * token are present — a token-less reload would 401 and fail every
 * extension call, so the pair gates together; unset stays write-only (the
 * hermetic fallback). Pure env mapping, tested hermetically.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretFileBoundary, extensionSecretFileName, proxyBoundaryControlFromEnv } from "./boundary";
import type { ExtensionCredential } from "../store/db";

describe("proxyBoundaryControlFromEnv (issue #123)", () => {
  test("both vars set -> the boundary reloads the proxy", () => {
    expect(
      proxyBoundaryControlFromEnv({
        BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092",
        BOTTEGA_PROXY_CONTROL_TOKEN: "mgmt-token",
      }),
    ).toEqual({ proxyControlUrl: "http://127.0.0.1:9092", proxyControlToken: "mgmt-token" });
  });

  test("neither var set -> write-only boundary (no reload)", () => {
    expect(proxyBoundaryControlFromEnv({})).toEqual({});
  });

  test("URL without a token -> write-only (a token-less reload would 401)", () => {
    expect(proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092" })).toEqual({});
  });

  test("token without a URL -> write-only", () => {
    expect(proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_TOKEN: "mgmt-token" })).toEqual({});
  });

  test("empty-string values are treated as unset", () => {
    expect(
      proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_URL: "", BOTTEGA_PROXY_CONTROL_TOKEN: "" }),
    ).toEqual({});
  });

  test("defaults to process.env when no env is passed", () => {
    const beforeUrl = process.env.BOTTEGA_PROXY_CONTROL_URL;
    const beforeToken = process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
    try {
      delete process.env.BOTTEGA_PROXY_CONTROL_URL;
      delete process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
      expect(proxyBoundaryControlFromEnv()).toEqual({});
      process.env.BOTTEGA_PROXY_CONTROL_URL = "http://127.0.0.1:9092";
      process.env.BOTTEGA_PROXY_CONTROL_TOKEN = "t";
      expect(proxyBoundaryControlFromEnv()).toEqual({
        proxyControlUrl: "http://127.0.0.1:9092",
        proxyControlToken: "t",
      });
    } finally {
      if (beforeUrl === undefined) delete process.env.BOTTEGA_PROXY_CONTROL_URL;
      else process.env.BOTTEGA_PROXY_CONTROL_URL = beforeUrl;
      if (beforeToken === undefined) delete process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
      else process.env.BOTTEGA_PROXY_CONTROL_TOKEN = beforeToken;
    }
  });
});

describe("createSecretFileBoundary reload half (issue #123, dev token contract)", () => {
  /** Minimal credential: authorize only reads `provider` (the secret file name). */
  const CREDENTIAL = {
    id: "1",
    provider: "github",
    identity_key: "dev",
    owner: null,
    scope: "org",
    broker_credential_id: 1,
    created_at: 0,
  } satisfies ExtensionCredential;

  test("authorize writes the secret file and reloads the management API with the dev token", async () => {
    // Stubbed management API: records the request, answers 200 like the
    // real iron-proxy does for a valid token (dev.sh exports the same token
    // to the container as IRON_MANAGEMENT_API_KEY and to the server as
    // BOTTEGA_PROXY_CONTROL_TOKEN — both come from data/proxy-mgmt-token).
    const seen: Array<{ path: string; auth: string | null }> = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
        return new Response("ok");
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolveSecret: async () => "dev-secret-value",
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "dev-mgmt-token",
      });
      await boundary.authorize(CREDENTIAL);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("dev-secret-value");
      expect(seen).toEqual([{ path: "/v1/reload", auth: "Bearer dev-mgmt-token" }]);
    } finally {
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 401 from the management API fails the extension call closed (token mismatch)", async () => {
    // The fail-closed symptom: a running container whose
    // IRON_MANAGEMENT_API_KEY differs from data/proxy-mgmt-token answers
    // the reload with 401, and the boundary must NOT silently continue
    // without injection — the extension call errors instead.
    const mgmt = Bun.serve({
      port: 0,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolveSecret: async () => "dev-secret-value",
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "wrong-token",
      });
      await expect(boundary.authorize(CREDENTIAL)).rejects.toThrow(/proxy reload failed \(401\)/);
    } finally {
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write-only boundary (no control URL) still writes the secret file, no reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({ secretsDir: dir, resolveSecret: async () => "s" });
      await boundary.authorize(CREDENTIAL);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
