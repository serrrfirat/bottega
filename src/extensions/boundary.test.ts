/**
 * Credential boundary control wiring (issue #123): the reload half of the
 * boundary engages only when BOTH the proxy control URL and its bearer
 * token are present — a token-less reload would 401 and fail every
 * extension call, so the pair gates together; unset stays write-only (the
 * hermetic fallback). Pure env mapping, tested hermetically.
 */
import { describe, expect, test } from "bun:test";
import { proxyBoundaryControlFromEnv } from "./boundary";

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
