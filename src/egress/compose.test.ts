import { describe, expect, test } from "bun:test";
import { networks, service, serviceDns, serviceEnv, services, volumes } from "../compose-test-utils";
import type { YamlNode } from "../yaml-subset";

const IRON_PROXY_IP = "172.30.0.2";

describe("docker-compose.yml (issue #8 egress topology)", () => {
  test("parses and declares the six services", () => {
    expect(Object.keys(services).sort()).toEqual([
      "auth-broker",
      "auth-gateway",
      "executor",
      "iron-proxy",
      "mem0",
      "server",
    ]);
  });

  test("iron-proxy is pinned to the latest stable image and is config-driven", () => {
    const proxy = service("iron-proxy");
    expect(proxy["image"]).toBe("ironsh/iron-proxy:0.49.0");
    const command = proxy["command"] as string[];
    expect(command).toEqual(["-config", "/etc/iron-proxy/egress.yml"]);
    const vol = proxy["volumes"] as string[];
    expect(vol).toContain("./config/egress.yml:/etc/iron-proxy/egress.yml:ro");
    expect(vol.some((v) => v.startsWith("./certs:") && v.endsWith(":ro"))).toBe(true);
  });

  test("iron-proxy receives the management API token for boundary reloads (issue #123)", () => {
    // config/egress.yml -> management.api_key_env; the server's extension
    // credential boundary reloads the proxy with this bearer token after
    // writing each secret file. Empty -> the boundary stays write-only.
    const env = serviceEnv("iron-proxy");
    expect(env["IRON_MANAGEMENT_API_KEY"]).toBe("${IRON_MANAGEMENT_API_KEY:-}");
  });

  test("server wires the boundary control URL + token and trusts the MITM CA (issue #123)", () => {
    const env = serviceEnv("server");
    // The reload half of the credential boundary: both vars come from the
    // same source so the server can POST /v1/reload (fail-closed 401
    // without the token).
    expect(env["BOTTEGA_PROXY_CONTROL_URL"]).toBe("http://iron-proxy:9092");
    expect(env["BOTTEGA_PROXY_CONTROL_TOKEN"]).toBe("${IRON_MANAGEMENT_API_KEY:-}");
    // Bun/Node verify the proxy's MITM leaf certs against the generated CA
    // (the same certs/ dir the proxy mounts); without it HTTPS egress
    // through the tunnel fails TLS.
    expect(env["NODE_EXTRA_CA_CERTS"]).toBe("/etc/iron-proxy/certs/ca.crt");
    const vol = service("server")["volumes"] as string[];
    expect(vol).toContain("./certs:/etc/iron-proxy/certs:ro");
  });

  test("executor trusts the MITM CA too (its HTTPS egress rides the tunnel)", () => {
    const env = serviceEnv("executor");
    expect(env["NODE_EXTRA_CA_CERTS"]).toBe("/etc/iron-proxy/certs/ca.crt");
    const vol = service("executor")["volumes"] as string[];
    expect(vol).toContain("./certs:/etc/iron-proxy/certs:ro");
  });

  test("iron-proxy has a static IP on the internal network", () => {
    const net = service("iron-proxy")["networks"] as Record<string, YamlNode>;
    expect((net["egress"] as Record<string, YamlNode>)["ipv4_address"]).toBe(IRON_PROXY_IP);
  });

  test("no service publishes public ports", () => {
    for (const name of Object.keys(services)) {
      expect(service(name)["ports"]).toBeUndefined();
    }
  });

  test("server and executor resolve DNS through iron-proxy", () => {
    expect(serviceDns("server")).toEqual([IRON_PROXY_IP]);
    expect(serviceDns("executor")).toEqual([IRON_PROXY_IP]);
  });

  test("server and executor route explicit proxies at iron-proxy's tunnel", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      expect(env["HTTP_PROXY"]).toBe(`http://iron-proxy:8080`);
      expect(env["HTTPS_PROXY"]).toBe(`http://iron-proxy:8080`);
    }
  });

  test("NO_PROXY covers internal names (localhost, loopback, data, auth services, mem0)", () => {
    // auth-broker/auth-gateway joined in issue #9: broker-mode traffic is
    // internal and must bypass the proxy (the allowlist would 403 it).
    // mem0 joined in issue #43: the memory backend is internal too, so the
    // server bypasses the proxy for it as well. The executor has no memory
    // tools and keeps the original list.
    const serverNoProxy = serviceEnv("server")["NO_PROXY"] as string;
    expect(serverNoProxy.split(",")).toEqual([
      "localhost",
      "127.0.0.1",
      "data",
      "auth-broker",
      "auth-gateway",
      "mem0",
    ]);
    const executorNoProxy = serviceEnv("executor")["NO_PROXY"] as string;
    expect(executorNoProxy.split(",")).toEqual([
      "localhost",
      "127.0.0.1",
      "data",
      "auth-broker",
      "auth-gateway",
    ]);
  });

  test("executor is opt-in via profile (not started by default)", () => {
    // The executor shares the app image with the server (pinned tag asserted
    // in deploy.test.ts); the profile is what keeps it out of `up -d`.
    expect(service("executor")["profiles"] as string[]).toContain("executor");
  });

  test("internal network has the fixed subnet that matches dns.proxy_ip", () => {
    const egress = networks["egress"] as Record<string, YamlNode>;
    expect(egress["driver"]).toBe("bridge");
    const ipam = egress["ipam"] as Record<string, YamlNode>;
    const config = ipam["config"] as Record<string, YamlNode>[];
    expect(config[0]["subnet"]).toBe("172.30.0.0/24");
  });

  test("shared data volume exists for the store and egress audit", () => {
    expect(volumes["data"]).toBeDefined();
    // iron-proxy audits to /data; the app mounts the same volume at /app/data
    // (its relative data/ paths resolve there under WORKDIR /app, issue #12).
    const proxyVol = service("iron-proxy")["volumes"] as string[];
    expect(proxyVol).toContain("data:/data");
    for (const name of ["server", "executor"]) {
      const vol = service(name)["volumes"] as string[];
      expect(vol).toContain("data:/app/data");
    }
  });
});

describe("docker-compose.yml (issue #43 mem0 memory backend)", () => {
  test("mem0 runs the pinned OSS server image on the internal network only", () => {
    const mem0 = service("mem0");
    expect(mem0["image"]).toBe("mem0/mem0-api-server:latest");
    expect(mem0["ports"]).toBeUndefined();
    // Internal service: on the egress network with no published ports.
    expect((mem0["networks"] as string[]).includes("egress")).toBe(true);
  });

  test("mem0 passes OPENAI_API_KEY through from the project .env (fail-closed boot)", () => {
    const env = serviceEnv("mem0");
    // The OSS server's embedder/extractor requires an LLM key at boot
    // ("api_key client option must be set" without one) — passthrough keeps
    // the key out of the repo and fails closed when unset.
    expect(env["OPENAI_API_KEY"]).toBe("${OPENAI_API_KEY:-}");
  });

  test("server defaults MEM0_BASE_URL to the internal mem0 service (issue #135)", () => {
    const env = serviceEnv("server");
    // Compose selects mem0 by default while an explicit project .env value
    // can override it. Local development has no compose env and stays SQLite.
    expect(env["MEM0_BASE_URL"]).toBe("${MEM0_BASE_URL:-http://mem0:8000}");
    expect(env["MEM0_API_KEY"]).toBe("${MEM0_API_KEY:-}");
  });
});
