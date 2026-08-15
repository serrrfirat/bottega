import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

const compose = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../docker-compose.yml"), "utf8"),
);

const services = compose["services"] as Record<string, YamlNode>;

function service(name: string): Record<string, YamlNode> {
  return services[name] as Record<string, YamlNode>;
}

function serviceEnv(name: string): Record<string, YamlNode> {
  return service(name)["environment"] as Record<string, YamlNode>;
}

describe("docker-compose.yml (issue #9 credential boundary)", () => {
  test("no service publishes public ports", () => {
    for (const name of Object.keys(services)) {
      expect(service(name)["ports"]).toBeUndefined();
    }
  });

  test("auth-broker runs the OMP vault on the internal network with a token bootstrap", () => {
    const broker = service("auth-broker");
    expect(broker["image"]).toBe("oh-my-pi/pi:dev");
    expect(broker["entrypoint"] as string[]).toEqual(["/entrypoints/broker.sh"]);
    expect(broker["command"] as string[]).toEqual([
      "auth-broker",
      "serve",
      "--bind=0.0.0.0:8765",
    ]);
    expect(serviceEnv("auth-broker")["PI_CONFIG_DIR"]).toBe("/data/.omp");
    const volumes = broker["volumes"] as string[];
    expect(volumes).toContain("./config/entrypoints:/entrypoints:ro");
    expect(volumes).toContain("data:/data");
    // Vault state (token + SQLite) must survive container recreation.
    expect((broker["networks"] as string[]).includes("egress")).toBe(true);
  });

  test("auth-broker healthcheck gates dependents on token readiness", () => {
    const test = (service("auth-broker")["healthcheck"] as Record<string, YamlNode>)[
      "test"
    ] as string[];
    expect(test).toEqual(["CMD", "curl", "-fsS", "http://127.0.0.1:8765/v1/healthz"]);
  });

  test("auth-gateway starts only after the broker is healthy and inherits the broker token", () => {
    const gateway = service("auth-gateway");
    expect(gateway["image"]).toBe("oh-my-pi/pi:dev");
    const depends = gateway["depends_on"] as Record<string, YamlNode>;
    expect((depends["auth-broker"] as Record<string, YamlNode>)["condition"]).toBe(
      "service_healthy",
    );
    expect(gateway["command"] as string[]).toEqual([
      "auth-gateway",
      "serve",
      "--bind=0.0.0.0:4000",
    ]);
    const env = serviceEnv("auth-gateway");
    expect(env["OMP_AUTH_BROKER_URL"]).toBe("http://auth-broker:8765");
    // Same PI_CONFIG_DIR on the shared volume: the gateway resolves the
    // broker token from /data/.omp/auth-broker.token without an env token.
    expect(env["PI_CONFIG_DIR"]).toBe("/data/.omp");
    const volumes = gateway["volumes"] as string[];
    expect(volumes).toContain("data:/data");
  });

  test("server and executor resolve credentials through the broker (env placeholders)", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      expect(env["OMP_AUTH_BROKER_URL"]).toBe("${OMP_AUTH_BROKER_URL:-http://auth-broker:8765}");
      expect(env["OMP_AUTH_BROKER_TOKEN"]).toBe("${OMP_AUTH_BROKER_TOKEN:-}");
      // Broker-mode traffic bypasses the egress proxy.
      expect((env["NO_PROXY"] as string).split(",")).toContain("auth-broker");
      expect((env["NO_PROXY"] as string).split(",")).toContain("auth-gateway");
    }
  });

  test("executor and server env carry no provider keys, channel tokens, or PATs", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      const keys = Object.keys(env);
      expect(keys.some((k) => /^(NEAR_API_KEY|SLACK_APP_TOKEN|SLACK_BOT_TOKEN|GITHUB_PAT)$/.test(k))).toBe(false);
    }
  });

  test("OMP agent config templates mount at the SDK agent dir", () => {
    // /app/data/omp-agent is the container path of the app's relative
    // data/omp-agent (WORKDIR /app, issue #12).
    for (const name of ["server", "executor"]) {
      const volumes = service(name)["volumes"] as string[];
      expect(volumes).toContain("./config/omp:/app/data/omp-agent");
    }
  });

  test("broker bootstrap script exists, is executable, and execs omp", () => {
    const script = resolve(import.meta.dir, "../../config/entrypoints/broker.sh");
    const mode = statSync(script).mode;
    expect(mode & 0o111).not.toBe(0);
    const body = readFileSync(script, "utf8");
    expect(body).toContain("exec omp \"$@\"");
    // Token must be written 0600 into the shared data volume.
    expect(body).toContain("chmod 600");
  });
});
