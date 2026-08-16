/**
 * Deploy packaging tests (issue #12): the compose build wiring, restart
 * policies, the Slack app manifest, the Dockerfile, and the smoke script.
 * Structural (no docker daemon needed) — parse the hand-authored files and
 * assert the contracts operators rely on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { service, services } from "./compose-test-utils";
import { parseYamlSubset } from "./yaml-subset";
import type { YamlNode } from "./yaml-subset";

const ROOT = resolve(import.meta.dir, "..");

function readRoot(name: string): string {
  return readFileSync(resolve(ROOT, name), "utf8");
}

describe("docker-compose.yml deploy wiring (issue #12)", () => {
  test("server and executor build from the repo root into a pinned image tag", () => {
    for (const name of ["server", "executor"]) {
      const svc = service(name);
      expect((svc["build"] as Record<string, YamlNode>)["context"]).toBe(".");
      expect(svc["image"]).toBe("bottega:${BOTTEGA_IMAGE_TAG:-local}");
      expect(svc["entrypoint"] as string[]).toEqual([
        "bun",
        "run",
        name === "server" ? "src/server/index.ts" : "src/executor.ts",
      ]);
    }
  });

  test("every service restarts on failure", () => {
    for (const name of Object.keys(services)) {
      expect(service(name)["restart"]).toBe("on-failure");
    }
  });

  test("executor reads the git PAT from the container path of the data volume", () => {
    const env = service("executor")["environment"] as Record<string, YamlNode>;
    expect(env["EXECUTOR_GIT_TOKEN_FILE"]).toBe("/app/data/secrets/github-pat");
    // Issue #67: the workspaces dir is an org SETTING (settings.workspaces_dir),
    // not an env var — unset, the executor resolves the container default
    // /workspaces (the data volume mounted below).
    expect(env["WORKSPACES_DIR"]).toBeUndefined();
    const volumes = service("executor")["volumes"] as string[];
    expect(volumes).toContain("data:/workspaces");
  });
});

describe("slack-app-manifest.yml (issue #12)", () => {
  const manifest = parseYamlSubset(readRoot("slack-app-manifest.yml"));

  test("enables Socket Mode (no public ingress needed)", () => {
    const settings = manifest["settings"] as Record<string, YamlNode>;
    expect(settings["socket_mode_enabled"]).toBe("true");
  });

  test("grants the bot scopes the adapter needs (issue #4 prerequisites)", () => {
    const oauth = manifest["oauth_config"] as Record<string, YamlNode>;
    const scopes = oauth["scopes"] as Record<string, YamlNode>;
    const bot = scopes["bot"] as string[];
    for (const scope of ["chat:write", "app_mentions:read", "channels:history", "groups:history", "im:history"]) {
      expect(bot).toContain(scope);
    }
  });

  test("subscribes to the events the server handles", () => {
    const settings = manifest["settings"] as Record<string, YamlNode>;
    const subs = settings["event_subscriptions"] as Record<string, YamlNode>;
    const events = subs["bot_events"] as string[];
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
    expect(dockerfile).toContain("mkdir -p /app/data /workspaces");
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
