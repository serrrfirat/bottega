import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "./yaml-subset";

const compose = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../docker-compose.yml"), "utf8"),
);

const services = compose["services"] as Record<string, YamlNode>;
const networks = compose["networks"] as Record<string, YamlNode>;
const volumes = compose["volumes"] as Record<string, YamlNode>;

const IRON_PROXY_IP = "172.30.0.2";

function service(name: string): Record<string, YamlNode> {
  return services[name] as Record<string, YamlNode>;
}

function serviceEnv(name: string): Record<string, YamlNode> {
  return service(name)["environment"] as Record<string, YamlNode>;
}

function serviceDns(name: string): string[] {
  return service(name)["dns"] as string[];
}

describe("docker-compose.yml (issue #8 egress topology)", () => {
  test("parses and declares the five services", () => {
    expect(Object.keys(services).sort()).toEqual([
      "auth-broker",
      "auth-gateway",
      "executor",
      "iron-proxy",
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

  test("NO_PROXY covers internal names (localhost, loopback, data, auth services)", () => {
    // auth-broker/auth-gateway joined in issue #9: broker-mode traffic is
    // internal and must bypass the proxy (the allowlist would 403 it).
    for (const name of ["server", "executor"]) {
      const noProxy = serviceEnv(name)["NO_PROXY"] as string;
      expect(noProxy.split(",")).toEqual([
        "localhost",
        "127.0.0.1",
        "data",
        "auth-broker",
        "auth-gateway",
      ]);
    }
  });

  test("executor is declared but gated behind a profile until #11", () => {
    expect(service("executor")["profiles"] as string[]).toContain("executor");
    expect(service("executor")["image"]).toBeTruthy();
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
