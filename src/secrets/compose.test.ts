import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { service, serviceEnv } from "../compose-test-utils";
import type { YamlNode } from "../yaml-subset";

describe("docker-compose.yml (issue #9 credential boundary)", () => {
  test("auth-broker runs the OMP vault on the internal network with a token bootstrap", () => {
    const broker = service("auth-broker");
    expect(broker["image"]).toBe("oh-my-pi/pi:dev");
    // SAFETY: hand-authored fixture renders `entrypoint` as a block sequence of scalars.
    expect(broker["entrypoint"] as string[]).toEqual(["/entrypoints/broker.sh"]);
    // SAFETY: hand-authored fixture renders `command` as a block sequence of scalars.
    expect(broker["command"] as string[]).toEqual([
      "auth-broker",
      "serve",
      "--bind=0.0.0.0:8765",
    ]);
    expect(serviceEnv("auth-broker")["PI_CONFIG_DIR"]).toBe("/data/.omp");
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const volumes = broker["volumes"] as string[];
    expect(volumes).toContain("./config/entrypoints:/entrypoints:ro");
    expect(volumes).toContain("data:/data");
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

  test("auth-gateway starts only after the broker is healthy and inherits the broker token", () => {
    const gateway = service("auth-gateway");
    expect(gateway["image"]).toBe("oh-my-pi/pi:dev");
    // SAFETY: hand-authored fixture renders `depends_on` as a mapping of service conditions.
    const depends = gateway["depends_on"] as Record<string, YamlNode>;
    // SAFETY: each depends_on entry is itself a mapping in the hand-authored fixture.
    expect((depends["auth-broker"] as Record<string, YamlNode>)["condition"]).toBe(
      "service_healthy",
    );
    // SAFETY: hand-authored fixture renders `command` as a block sequence of scalars.
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
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const volumes = gateway["volumes"] as string[];
    expect(volumes).toContain("data:/data");
  });

  test("server and executor resolve credentials through the broker (env placeholders)", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      expect(env["OMP_AUTH_BROKER_URL"]).toBe("${OMP_AUTH_BROKER_URL:-http://auth-broker:8765}");
      expect(env["OMP_AUTH_BROKER_TOKEN"]).toBe("${OMP_AUTH_BROKER_TOKEN:-}");
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

  test("OMP agent config templates mount at the SDK agent dir", () => {
    // /app/data/omp-agent is the container path of the app's relative
    // data/omp-agent (WORKDIR /app, issue #12).
    for (const name of ["server", "executor"]) {
      // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
      const volumes = service(name)["volumes"] as string[];
      expect(volumes).toContain("./config/omp:/app/data/omp-agent");
    }
  });

  test("broker bootstrap generates the 0600 token once and execs omp with forwarded args", async () => {
    const script = resolve(import.meta.dir, "../../config/entrypoints/broker.sh");
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "bottega-broker-"));
    try {
      // Fake omp on PATH: records its args, its PID, and the exported
      // OMP_AUTH_BROKER_TOKEN. PID equality with the spawned process proves
      // `exec` semantics (no intermediate shell survives).
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

      // omp was exec'd with the vault serve command and saw the token.
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(vaultArgs);
      expect(readFileSync(pidFile, "utf8")).toBe(String(first.pid));
      expect(readFileSync(tokenSeenFile, "utf8")).toBe(token);

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
