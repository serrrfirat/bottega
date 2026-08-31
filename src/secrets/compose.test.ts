import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { service, serviceEnv } from "../compose-test-utils";
import { type YamlNode } from "../yaml-subset";

describe("docker-compose.yml (issue #9 credential boundary)", () => {
  test("auth-broker runs the packaged OMP CLI on the internal network with a token bootstrap", () => {
    const broker = service("auth-broker");
    expect(broker["image"]).toBe("bottega:${BOTTEGA_IMAGE_TAG:-local}");
    // SAFETY: hand-authored fixture renders `entrypoint` as a block sequence of scalars.
    expect(broker["entrypoint"] as string[]).toEqual(["/entrypoints/broker.sh"]);
    // SAFETY: the fixture declares `command` as a block sequence of scalars.
    expect(broker["command"] as string[]).toEqual([
      "auth-broker",
      "serve",
      "--bind=0.0.0.0:8765",
    ]);
    expect(readFileSync(resolve(import.meta.dir, "../../config/entrypoints/broker.sh"), "utf8")).toContain(
      'exec bun --preload "$BROKER_PRELOAD" "$BROKER_CLI" "$@"',
    );
    // OMP joins PI_CONFIG_DIR under HOME (/home/bun), so deployment paths
    // are HOME-relative; absolute-looking values become /home/bun/data.
    expect(serviceEnv("auth-broker")["PI_CONFIG_DIR"]).toBe("../../data/.omp");
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
    expect(env["PI_CONFIG_DIR"]).toBe("../../data/.omp");
    // SAFETY: hand-authored fixture renders `volumes` as a block sequence of scalars.
    const volumes = gateway["volumes"] as string[];
    expect(volumes).toContain("data:/data");
    expect(gateway["ports"]).toBeUndefined();
  });

  test("server and executor use the broker URL plus shared token file, never a bearer env", () => {
    for (const name of ["server", "executor"]) {
      const env = serviceEnv(name);
      expect(env["PI_CONFIG_DIR"]).toBe("../../app/data/.omp");
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
      // SAFETY: each service declares depends_on as a mapping with the broker
      // health condition in the hand-authored compose fixture.
      const depends = service(name)["depends_on"] as Record<string, YamlNode>;
      // SAFETY: the broker depends_on entry is a mapping carrying condition.
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

  test("searxng config init renders the required secret into a read-only runtime volume", () => {
    const init = service("searxng-config-init");
    expect(init["image"]).toBe("alpine:3.19");
    expect(init["environment"] as Record<string, YamlNode>).toEqual({
      SEARXNG_SECRET: "${SEARXNG_SECRET:?SEARXNG_SECRET must be set}",
    });
    expect(init["volumes"] as string[]).toEqual([
      "./config/searxng/settings.yml:/seed/settings.yml:ro",
      "searxng-config:/config",
    ]);
    const command = (init["command"] as string[])[2];
    expect(command).toContain("__SEARXNG_SECRET__");
    expect(command).toContain("at least 64 hexadecimal characters");

    const secret = "0123456789abcdef".repeat(4);
    const dir = mkdtempSync(join(tmpdir(), "bottega-searxng-config-"));
    try {
      const seedPath = join(dir, "settings.yml");
      const outputPath = join(dir, "rendered.yml");
      const source = readFileSync(resolve(import.meta.dir, "../../config/searxng/settings.yml"), "utf8");
      writeFileSync(seedPath, source);
      const renderedCommand = command
        .replaceAll("/seed/settings.yml", seedPath)
        .replaceAll("/config/settings.yml", outputPath)
        .replaceAll("$$", "$");
      const result = Bun.spawnSync(["sh", "-c", renderedCommand], {
        env: { PATH: process.env.PATH ?? "", SEARXNG_SECRET: secret },
      });
      expect(result.success).toBe(true);
      const rendered = readFileSync(outputPath, "utf8");
      expect(rendered).toContain(`secret_key: "${secret}"`);
      expect(rendered).not.toContain("__SEARXNG_SECRET__");
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("broker bootstrap generates the 0600 token once and execs packaged omp without exporting it", async () => {
    const script = resolve(import.meta.dir, "../../config/entrypoints/broker.sh");
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "bottega-broker-"));
    try {
      // Fake source CLI: records args/PID and confirms the preload registered
      // Notion in the SAME unbundled module graph. PID equality proves exec.
      const bin = join(dir, "bin");
      const argsFile = join(dir, "omp.args");
      const pidFile = join(dir, "omp.pid");
      const tokenSeenFile = join(dir, "omp.token-seen");
      const providerFile = join(dir, "omp.provider");

      const oauthImportPath = resolve(import.meta.dir, "../../node_modules/@oh-my-pi/pi-ai/src/registry/oauth/index.ts");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "omp"),
        [
          "#!/usr/bin/env bun",
          `import { getOAuthProvider } from ${JSON.stringify(oauthImportPath)};`,
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join("\\n") + "\\n");`,
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          `writeFileSync(${JSON.stringify(tokenSeenFile)}, process.env.OMP_AUTH_BROKER_TOKEN ?? "");`,
          `writeFileSync(${JSON.stringify(providerFile)}, getOAuthProvider("notion")?.id ?? "missing");`,

          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(join(bin, "omp"), 0o700);
      const configDir = join(dir, ".omp");
      const preloadPath = resolve(import.meta.dir, "../server/notion-oauth-broker-preload.ts");
      const env = {
        PATH: process.env.PATH ?? "",
        PI_CONFIG_DIR: configDir,
        OMP_AUTH_BROKER_PRELOAD: preloadPath,
        OMP_AUTH_BROKER_CLI: join(bin, "omp"),
      };
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
      expect(readFileSync(providerFile, "utf8")).toBe("notion");


      // Later boots reuse the token: no regeneration, same vault identity.
      const second = Bun.spawnSync(["sh", script, ...vaultArgs], { env });
      expect(second.success).toBe(true);
      expect(readFileSync(tokenFile, "utf8").trim()).toBe(token);
      expect(readFileSync(pidFile, "utf8")).toBe(String(second.pid));
      expect(readFileSync(providerFile, "utf8")).toBe("notion");

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
