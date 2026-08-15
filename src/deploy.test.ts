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
    expect(env["WORKSPACES_DIR"]).toBe("/workspaces");
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
  test("image installs git (executor clone/push) and runs as the bun user", () => {
    const dockerfile = readRoot("Dockerfile");
    expect(dockerfile).toContain("FROM oven/bun:1");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends git");
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
