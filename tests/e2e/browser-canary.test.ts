/**
 * Hermetic proofs for the browser canary layer (issue #298).
 *
 * The browser journeys themselves need a real Chromium + an authenticated
 * workspace on the dedicated self-hosted runner — never faked in CI. This
 * file pins the DETERMINISTIC parts:
 *   - BROWSER_JOURNEY_IDS matches the registered browser journeys in the
 *     journey registry (a browser journey added to one place but not the
 *     other is a bug the gate must surface);
 *   - parseBrowserArgv enforces the preflight contract: a missing
 *     profile/workspace THROWS (never a silent skip), and an unknown
 *     journey id fails loudly.
 */
import { describe, expect, test } from "bun:test";
import { BROWSER_JOURNEY_IDS, parseBrowserArgv } from "./browser-canary";
import { JOURNEYS } from "./canary-registry";

describe("browser canary layer (issue #298)", () => {
  test("every browser journey id is registered in the journey registry (one source of truth)", () => {
    const registryBrowserIds = JOURNEYS.filter((j) => j.layer === "browser").map((j) => j.id);
    for (const id of BROWSER_JOURNEY_IDS) {
      expect(registryBrowserIds).toContain(id);
    }
  });

  test("parseBrowserArgv requires a profile dir and workspace — missing preflight fails loudly, never skips", () => {
    expect(() => parseBrowserArgv({})).toThrow(/profile-dir/);
    expect(() => parseBrowserArgv({ BROWSER_PROFILE_DIR: "/runner/profile" })).toThrow(/workspace/);
  });

  test("parseBrowserArgv parses profile/workspace/out-dir and validates unknown journeys", () => {
    const cfg = parseBrowserArgv(
      {
        BROWSER_PROFILE_DIR: "/runner/profiles/requester",
        SLACK_WORKSPACE_URL: "https://acme.slack.com",
        BROWSER_EVIDENCE_DIR: "/runner/evidence",
      },
      [],
    );
    expect(cfg.profileDir).toBe("/runner/profiles/requester");
    expect(cfg.workspaceUrl).toBe("https://acme.slack.com");
    expect(cfg.journeys).toEqual([...BROWSER_JOURNEY_IDS]);
    expect(() => parseBrowserArgv({}, ["--profile-dir", "/p", "--workspace", "https://x.slack.com", "--journey", "nope"])).toThrow(
      /unknown journey/,
    );
  });
});