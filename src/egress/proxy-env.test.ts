/**
 * Verifies Bun's native proxy-env handling (issue #8 finding):
 * Bun.fetch honors HTTP_PROXY/HTTPS_PROXY (upper and lower case) and NO_PROXY.
 * iron-proxy exposes an explicit tunnel listener for exactly this wiring, so
 * no proxied-fetch wrapper is needed.
 *
 * Each case runs `bun -e` in a fresh child process whose env is set at boot —
 * the same shape as the compose wiring (HTTP_PROXY/HTTPS_PROXY/NO_PROXY in
 * the container environment). All servers bind 127.0.0.1 ephemeral ports:
 * no real network.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { serve } from "bun";

const origin = await serve({ port: 0, fetch: () => new Response("from-origin") });
let proxyHits = 0;
const proxy = await serve({
  port: 0,
  fetch: (req) => {
    proxyHits++;
    return new Response(`via-proxy ${req.url}`);
  },
});

const originUrl = `http://127.0.0.1:${origin.port}/ping`;
const proxyUrl = `http://127.0.0.1:${proxy.port}`;

beforeEach(() => {
  proxyHits = 0;
});

afterAll(() => {
  origin.stop();
  proxy.stop();
});

async function fetchWithEnv(env: Record<string, string>): Promise<{ body: string; proxyHits: number }> {
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const [k, v] of Object.entries(env)) childEnv[k] = v;
  const proc = Bun.spawn(["bun", "-e", `const r = await fetch(${JSON.stringify(originUrl)}); console.log(await r.text());`], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (err.trim()) throw new Error(`child stderr: ${err.trim()}`);
  return { body: out.trim(), proxyHits };
}

describe("Bun fetch proxy environment wiring (issue #8)", () => {
  test("HTTP_PROXY/HTTPS_PROXY route fetch through the proxy", async () => {
    const r = await fetchWithEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
    expect(r.body).toContain("via-proxy");
    expect(r.proxyHits).toBe(1);
  });

  test("lowercase http_proxy/https_proxy are honored too", async () => {
    const r = await fetchWithEnv({ http_proxy: proxyUrl, https_proxy: proxyUrl });
    expect(r.body).toContain("via-proxy");
    expect(r.proxyHits).toBe(1);
  });

  test("NO_PROXY=127.0.0.1,localhost bypasses the proxy for internal hosts", async () => {
    const r = await fetchWithEnv({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
    });
    expect(r.body).toBe("from-origin");
    expect(r.proxyHits).toBe(0);
  });
});
