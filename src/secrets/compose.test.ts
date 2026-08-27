import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { service, serviceEnv } from "../compose-test-utils";
import type { YamlNode } from "../yaml-subset";

describe("docker-compose.yml (issue #9 credential boundary)", () => {
  test("auth-broker runs the packaged OMP CLI on the internal network with a token bootstrap", () => {
    const broker = service("auth-broker");
    expect(broker["image"]).toBe("bottega:${BOTTEGA_IMAGE_TAG:-local}");
    // SAFETY: hand-authored fixture renders `entrypoint` as a block sequence of scalars.
    expect(broker["entrypoint"] as string[]).toEqual(["/entrypoints/broker.sh"]);
    expect(broker["command"] as string[]).toEqual([
      "auth-broker",
      "serve",
      "--bind=0.0.0.0:8765",
    ]);
    expect(readFileSync(resolve(import.meta.dir, "../../config/entrypoints/broker.sh"), "utf8")).toContain(
      "exec /app/node_modules/.bin/omp",
    );
    expect(serviceEnv("auth-broker")["PI_CONFIG_DIR"]).toBe("/data/.omp");
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const volumes = broker["volumes"] as string[];
    expect(volumes).toContain("./config/entrypoints:/entrypoints:ro");
    expect(volumes).toContain("data:/data");
    expect(broker["ports"]).toBeUndefined();
    // Vault state (token + SQLite) must survive container recreation.
    // SAFETY: hand-authored fixture renders `networks` as a block sequence of scalars.
    expect((broker["networks"] as string[]).includes("egress")).toBe(true);
  });

  test("auth-broker healthcheck gates dependents on token readiness", () => {
    // SAFETY: the healthcheck is a mapping and its `test` key a block sequence
    // in the hand-authored fixture; a shape change fails this assertion loudly.
    const test = (service("auth-broker")["healthcheck"] as Record<string, YamlNode>)[
      "test"
    ] as string[];
    expect(test).toEqual(["CMD", "curl", "-fsS", "http://127.0.0.1:8765/v1/healthz"]);
  });
  test("auth-gateway runs the packaged OMP CLI after the broker is healthy", () => {
    const gateway = service("auth-gateway");
    expect(gateway["image"]).toBe("bottega:${BOTTEGA_IMAGE_TAG:-local}");
    // SAFETY: hand-authored fixture renders `depends_on` as a mapping of service conditions.
    const depends = gateway["depends_on"] as Record<string, YamlNode>;
    // SAFETY: each depends_on entry is itself a mapping in the hand-authored fixture.
    expect((depends["auth-broker"] as Record<string, YamlNode>)["condition"]).toBe(
      "service_healthy",
    );
    // SAFETY: hand-authored fixture renders `command` as a block sequence of scalars.
    expect(gateway["command"] as string[]).toEqual([
      "/app/node_modules/.bin/omp",
      "auth-gateway",
      "serve",
      "--bind=0.0.0.0:4000",
    ]);
    const env = serviceEnv("auth-gateway");
    expect(env["OMP_AUTH_BROKER_URL"]).toBe("http://auth-broker:8765");
    // The gateway resolves the token from the shared file, never an env bearer.
    expect(env["OMP_AUTH_BROKER_TOKEN"]).toBeUndefined();
    expect(env["PI_CONFIG_DIR"]).toBe("/data/.omp");
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const volumes = gateway["volumes"] as string[];
    expect(volumes).toContain("data:/data");
    expect(gateway["ports"]).toBeUndefined();
  });

  test("server and executor use the broker URL plus shared token file, never a bearer env", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      expect(env["PI_CONFIG_DIR"]).toBe("/app/data/.omp");
      expect(env["OMP_AUTH_BROKER_URL"]).toBe("${OMP_AUTH_BROKER_URL:-http://auth-broker:8765}");
      expect(env["OMP_AUTH_BROKER_TOKEN_FILE"]).toBe("/app/data/.omp/auth-broker.token");
      expect(env["OMP_AUTH_BROKER_TOKEN"]).toBeUndefined();
      // Broker-mode traffic bypasses the egress proxy.
      // SAFETY: NO_PROXY is a scalar string in the hand-authored fixture.
      expect((env["NO_PROXY"] as string).split(",")).toContain("auth-broker");
      // SAFETY: same scalar-string invariant for the gateway entry.
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

  test("server and executor wait for a healthy broker before starting", () => {
    for (const name of ["server", "executor"]) {
      const depends = service(name)["depends_on"] as Record<string, YamlNode>;
      expect((depends["auth-broker"] as Record<string, YamlNode>)["condition"]).toBe("service_healthy");
    }
  });

  test("OMP agent config templates mount at the server's SDK agent dir only", () => {
    // /app/data/omp-agent is the container path of the app's relative
    // data/omp-agent (WORKDIR /app, issue #12).
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const serverVolumes = service("server")["volumes"] as string[];
    expect(serverVolumes).toContain("./config/omp:/app/data/omp-agent");
    // The executor intentionally has no OMP config bind mount (#101/#105):
    // its image root is read-only and only durable data + disposable
    // workspace mounts are writable; it creates data/omp-agent at boot on
    // the data volume. deploy.test.ts asserts the same exclusion.
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const executorVolumes = service("executor")["volumes"] as string[];
    expect(executorVolumes).not.toContain("./config/omp:/app/data/omp-agent");
  });

  test("broker bootstrap generates the 0600 token once and execs packaged omp without exporting it", async () => {
    const script = resolve(import.meta.dir, "../../config/entrypoints/broker.sh");
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "bottega-broker-"));
    try {
      // Fake omp on PATH: records its args, its PID, and whether the bearer
      // leaked into its environment. PID equality with the spawned process
      // proves `exec` semantics (no intermediate shell survives).
      const bin = join(dir, "bin");
      const argsFile = join(dir, "omp.args");
      const pidFile = join(dir, "omp.pid");
      const tokenSeenFile = join(dir, "omp.token-seen");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "omp"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > "${argsFile}"`,
          `printf '%s' "$$" > "${pidFile}"`,
          `printf '%s' "$OMP_AUTH_BROKER_TOKEN" > "${tokenSeenFile}"`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(join(bin, "omp"), 0o700);
      const configDir = join(dir, ".omp");
      const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, PI_CONFIG_DIR: configDir };
      const tokenFile = join(configDir, "auth-broker.token");

      const vaultArgs = ["auth-broker", "serve", "--bind=0.0.0.0:8765"];
      const first = Bun.spawnSync(["sh", script, ...vaultArgs], { env });
      expect(first.success).toBe(true);
      expect(existsSync(tokenFile)).toBe(true);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const token = readFileSync(tokenFile, "utf8").trim();
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      // omp was exec'd with the vault serve command, while the token remains
      // only in the mode-0600 file for the CLI to read.
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(vaultArgs);
      expect(readFileSync(pidFile, "utf8")).toBe(String(first.pid));
      expect(readFileSync(tokenSeenFile, "utf8")).toBe("");

      // Later boots reuse the token: no regeneration, same vault identity.
      const second = Bun.spawnSync(["sh", script, ...vaultArgs], { env });
      expect(second.success).toBe(true);
      expect(readFileSync(tokenFile, "utf8").trim()).toBe(token);
      expect(readFileSync(pidFile, "utf8")).toBe(String(second.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
