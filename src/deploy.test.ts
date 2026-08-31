/**
 * Deploy packaging tests (issue #12): the compose build wiring, restart
 * policies, the Slack app manifest, the Dockerfile, and the smoke script.
 * Structural (no docker daemon needed) — parse the hand-authored files and
 * assert the contracts operators rely on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { service, serviceEnv, volumes } from "./compose-test-utils";
import { parseYamlSubset } from "./yaml-subset";
import type { YamlNode } from "./yaml-subset";

const ROOT = resolve(import.meta.dir, "..");

function readRoot(name: string): string {
  return readFileSync(resolve(ROOT, name), "utf8");
}

// The compose file and Slack manifest are hand-authored; every key these
// tests read is asserted below, so narrowing a node to its rendered shape is
// sound — a shape change surfaces as a failing assertion, never a silent skip.
function asRecord(node: YamlNode): Record<string, YamlNode> {
  // SAFETY: every key this suite reads is a block mapping in the hand-authored fixtures.
  return node as Record<string, YamlNode>;
}
function asStringArray(node: YamlNode): string[] {
  // SAFETY: the entrypoint/volumes/bot-scope keys are block sequences of scalar strings in the fixtures.
  return node as string[];
}

describe("docker-compose.yml deploy wiring (issue #12)", () => {
  test("server and executor build from the repo root into a pinned image tag", () => {
    for (const name of ["server", "executor"]) {
      const svc = service(name);
      expect(asRecord(svc["build"])["context"]).toBe(".");
      expect(svc["image"]).toBe("bottega:${BOTTEGA_IMAGE_TAG:-local}");
      expect(asStringArray(svc["entrypoint"])).toEqual([
        "bun",
        "run",
        name === "server" ? "src/server/index.ts" : "src/executor.ts",
      ]);
    }
  });

  test("seeds a persistent writable extensions volume for server and executor", () => {
    const init = service("extensions-config-init");
    expect(asStringArray(init["volumes"])).toEqual([
      "./config/extensions:/seed:ro",
      "extensions:/extensions",
    ]);
    expect(asStringArray(init["command"])).toContain(
      "cp -R -n /seed/. /extensions/ && chown -R 1000:1000 /extensions",
    );

    for (const name of ["server", "executor"]) {
      const svc = service(name);
      expect(asStringArray(svc["volumes"])).toContain("extensions:/app/config/extensions");
      const dependsOn = asRecord(svc["depends_on"]);
      expect(asRecord(dependsOn["extensions-config-init"])["condition"]).toBe(
        "service_completed_successfully",
      );
    }
    expect(asRecord(volumes["extensions"])["name"]).toBe("extensions");
  });

  test("long-running services restart on failure", () => {
    for (const name of ["iron-proxy", "auth-broker", "auth-gateway", "mem0", "searxng", "server", "executor"]) {
      expect(service(name)["restart"]).toBe("on-failure");
    }
  });

  test("egress-config-init runs exactly once, before the proxy reads the policy (issue #317)", () => {
    // One-shot seed copy (issue #317): no restart policy — a restart loop
    // would re-copy over the credential boundary's call-scoped region.
    const init = service("egress-config-init");
    expect(init["restart"]).toBeUndefined();
    const volumes = asStringArray(init["volumes"]);
    expect(volumes).toContain("./config/egress.yml:/seed/egress.yml:ro");
    expect(volumes).toContain("data:/data");
    // The proxy reads the seeded policy from the shared volume and starts
    // only after the init exits successfully.
    const dependsOn = asRecord(service("iron-proxy")["depends_on"]);
    expect(asRecord(dependsOn["egress-config-init"])["condition"]).toBe(
      "service_completed_successfully",
    );
  });

  test("executor reads the git PAT from the container path of the data volume", () => {
    const env = serviceEnv("executor");
    expect(env["EXECUTOR_GIT_TOKEN_FILE"]).toBe("/app/data/secrets/github-pat");
    expect(env["OMP_AUTH_BROKER_TOKEN_FILE"]).toBe("/app/data/.omp/auth-broker.token");
    // Issue #67: the workspaces dir is an org SETTING (settings.workspaces_dir),
    // not an env var — unset, the executor resolves the container default
    // /workspaces (the data volume mounted below).
    expect(env["WORKSPACES_DIR"]).toBeUndefined();
    const volumes = asStringArray(service("executor")["volumes"]);
    expect(volumes).toContain("data:/workspaces");
  });

  test("executor container keeps the reachable #105 hardening profile mandatory", () => {
    const executor = service("executor");
    expect(executor["read_only"]).toBe("true");
    expect(executor["pids_limit"]).toBe("256");
    expect(asStringArray(executor["cap_drop"])).toEqual(["ALL"]);
    expect(asStringArray(executor["security_opt"])).toEqual(["no-new-privileges:true"]);
    expect(asStringArray(executor["tmpfs"])).toContain("/tmp:rw,noexec,nosuid,size=64m");
    const volumes = asStringArray(executor["volumes"]);
    expect(volumes).not.toContain("./config/omp:/app/data/omp-agent");
    expect(volumes).toContain("./certs:/etc/iron-proxy/certs:ro");
  });

  test("searxng uses the pinned internal image and fixed egress topology", () => {
    const searxng = service("searxng");
    expect(searxng["image"]).toBe(
      "searxng/searxng:2026.8.29-d226b78bc@sha256:b36af7984b87191b595bc5301418ed6432c047668a4547ab531a7439b816fac3",
    );
    expect(searxng["ports"]).toBeUndefined();
    const networks = asRecord(searxng["networks"]);
    expect(Object.keys(networks)).toEqual(["egress"]);
    expect(asRecord(networks["egress"])["ipv4_address"]).toBe("172.30.0.6");
    expect(asStringArray(searxng["dns"])).toEqual(["172.30.0.2"]);
  });

  test("searxng routes outbound requests through the iron-proxy tunnel", () => {
    const env = serviceEnv("searxng");
    expect(env["HTTP_PROXY"]).toBe("http://iron-proxy:8080");
    expect(env["HTTPS_PROXY"]).toBe("http://iron-proxy:8080");
    expect(env["REQUESTS_CA_BUNDLE"]).toBe("/etc/iron-proxy/certs/ca.crt");
    expect(env["SSL_CERT_FILE"]).toBe("/etc/iron-proxy/certs/ca.crt");
    const volumes = asStringArray(service("searxng")["volumes"]);
    expect(volumes).toContain("./config/searxng/settings.yml:/etc/searxng/settings.yml:ro");
    expect(volumes).toContain("./certs:/etc/iron-proxy/certs:ro");
  });

  test("searxng has a local-only healthcheck and hardened filesystem", () => {
    const searxng = service("searxng");
    expect(searxng["read_only"]).toBe("true");
    expect(searxng["pids_limit"]).toBe("256");
    expect(searxng["mem_limit"]).toBe("512m");
    expect(asStringArray(searxng["cap_drop"])).toEqual(["ALL"]);
    expect(asStringArray(searxng["security_opt"])).toEqual(["no-new-privileges:true"]);
    expect(asStringArray(searxng["tmpfs"])).toEqual([
      "/tmp:rw,noexec,nosuid,size=64m",
      "/var/cache/searxng:rw,noexec,nosuid,size=64m",
    ]);
    const healthcheck = asRecord(searxng["healthcheck"]);
    expect(asStringArray(healthcheck["test"])).toEqual([
      "CMD",
      "wget",
      "--spider",
      "--timeout=2",
      "http://127.0.0.1:8080/",
    ]);
  });

  test("server waits for healthy searxng and bypasses its internal name", () => {
    const dependsOn = asRecord(service("server")["depends_on"]);
    expect(asRecord(dependsOn["searxng"])["condition"]).toBe("service_healthy");
    expect((serviceEnv("server")["NO_PROXY"] as string).split(",")).toContain("searxng");
  });

  test("committed SearXNG settings keep only reviewed JSON web search engines", () => {
    const settings = parseYamlSubset(readRoot("config/searxng/settings.yml"));
    const useDefaults = asRecord(settings["use_default_settings"]);
    const engines = asRecord(useDefaults["engines"]);
    expect(asStringArray(engines["keep_only"])).toEqual(["duckduckgo", "brave"]);
    expect(asRecord(settings["general"])["debug"]).toBe("false");
    expect(asRecord(settings["general"])["instance_name"]).toBe("bottega-search");
    const search = asRecord(settings["search"]);
    expect(search["safe_search"]).toBe("1");
    expect(asStringArray(search["formats"])).toEqual(["html", "json"]);
  });
});

describe("slack-app-manifest.yml (issue #12)", () => {
  const manifest = parseYamlSubset(readRoot("slack-app-manifest.yml"));

  test("enables Socket Mode (no public ingress needed)", () => {
    const settings = asRecord(manifest["settings"]);
    expect(settings["socket_mode_enabled"]).toBe("true");
  });

  test("grants the bot scopes the adapter needs (issue #4 prerequisites)", () => {
    const oauth = asRecord(manifest["oauth_config"]);
    const scopes = asRecord(oauth["scopes"]);
    const bot = asStringArray(scopes["bot"]);
    for (const scope of ["chat:write", "app_mentions:read", "channels:history", "groups:history", "im:history"]) {
      expect(bot).toContain(scope);
    }
  });

  test("subscribes to the events the server handles", () => {
    const settings = asRecord(manifest["settings"]);
    const subs = asRecord(settings["event_subscriptions"]);
    const events = asStringArray(subs["bot_events"]);
    for (const event of ["message.channels", "message.groups", "app_mention"]) {
      expect(events).toContain(event);
    }
  });
});

describe("Dockerfile + .dockerignore (issue #12)", () => {
  test("app image inherits the tools base so the curated CLIs live in both entrypoints", () => {
    const dockerfile = readRoot("Dockerfile");
    const tools = readRoot("Dockerfile.tools");
    // Issue #62: the single app image used by server AND executor builds
    // FROM the tools image (issue #58) — no separate thin base, so gh/jq/
    // curl/git are on PATH in the executor container at runtime.
    expect(dockerfile).toContain("FROM bottega-tools:ci");
    expect(dockerfile).not.toContain("FROM oven/bun:1");
    // The tools base is the single source of truth for the CLI set and
    // the bun runtime: oven/bun:1 keeps `bun` on PATH for the app
    // entrypoints, and the curated set v1.1 (issue #63) is installed in a
    // single apt layer, exactly once.
    expect(tools).toContain("FROM oven/bun:1");
    expect(tools).toContain("apt-get update");
    expect(tools).toContain("apt-get install -y --no-install-recommends");
    for (const pkg of [
      "git", "ca-certificates", "gh", "jq", "curl",
      "nodejs", "npm", "build-essential", "golang-go",
      "python3", "python3-pip", "sqlite3", "postgresql-client",
      "ripgrep", "glab", "unzip",
    ]) {
      expect(tools).toContain(pkg);
    }
    expect(dockerfile).not.toContain("apt-get install");
    // The tools base ends with USER bun; the app build resets to root for
    // its install/chown steps, then restores the runtime user.
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain("WORKDIR /app");
    expect(dockerfile).toContain("USER bun");
    // Named volumes inherit image ownership on first mount: the writable
    // dirs must exist and be owned by the runtime user before USER bun.
    expect(dockerfile).toContain("mkdir -p /app/data /data /workspaces");
    expect(dockerfile).toContain("chown -R bun:bun");
  });

  test("dockerignore keeps host state and secrets out of the image", () => {
    const ignore = readRoot(".dockerignore");
    for (const entry of ["node_modules", "data", "certs", ".env", ".git"]) {
      expect(ignore).toContain(entry);
    }
  });
});

describe("scripts/smoke.sh (issue #12)", () => {
  test("exists, is executable, and runs the local verification legs", () => {
    const script = resolve(ROOT, "scripts/smoke.sh");
    const mode = statSync(script).mode;
    expect(mode & 0o111).not.toBe(0);
    const body = readFileSync(script, "utf8");
    expect(body).toContain("bun check");
    expect(body).toContain("bun test");
    expect(body).toContain("docker compose --profile executor config");
  });
});
