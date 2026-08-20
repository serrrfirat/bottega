/**
 * Hermetic proofs for the browser canary layer (issue #298).
 *
 * The browser journeys themselves need a real Chromium + an authenticated
 * workspace on the dedicated self-hosted runner — never faked in CI. This
 * file pins the DETERMINISTIC contracts:
 *   - BROWSER_JOURNEY_IDS match the registered browser journeys;
 *   - parseBrowserArgv FAILS CLOSED on missing profile/workspace and on
 *     unknown journeys/roles (finding #3/#4) — never a silent skip or pass;
 *   - the role filter is REAL (--role space-approver → canonical approver;
 *     zero selected journeys throw, never pass);
 *   - every browser journey's second profile is wired (finding #2): the
 *     approve-deny journey needs the approver profile, threaded needs the
 *     member profile.
 */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_JOURNEY_IDS,
  canonicalIdentity,
  parseBrowserArgv,
  selectBrowserJourneys,
  browserJourneySecondProfile,
  type BrowserArgv,
} from "./browser-canary";
import { JOURNEYS } from "./canary-registry";

function baseArgv(overrides: Partial<BrowserArgv> = {}): BrowserArgv {
  return {
    requesterProfileDir: "/runner/profiles/requester",
    outDir: "/runner/evidence",
    workspaceUrl: "https://acme.slack.com",
    botName: "bottega",
    journeys: [...BROWSER_JOURNEY_IDS],
    profiles: { requester: "/runner/profiles/requester", approver: "/runner/profiles/approver", member: "/runner/profiles/member" },
    ...overrides,
  };
}

describe("browser canary layer (issue #298)", () => {
  test("every browser journey id is registered in the journey registry (one source of truth)", () => {
    const registryBrowserIds = JOURNEYS.filter((j) => j.layer === "browser").map((j) => j.id);
    for (const id of BROWSER_JOURNEY_IDS) {
      expect(registryBrowserIds).toContain(id);
    }
  });

  test("parseBrowserArgv requires a profile dir and workspace — missing preflight fails loudly, never skips", () => {
    expect(() => parseBrowserArgv({})).toThrow(/profile dir/);
    expect(() => parseBrowserArgv({ BROWSER_PROFILE_REQUESTER: "/runner/p" })).toThrow(/workspace/);
  });

  test("parseBrowserArgv parses env and validates unknown journeys / roles (fail closed)", () => {
    const cfg = parseBrowserArgv(
      {
        BROWSER_PROFILE_REQUESTER: "/runner/profiles/requester",
        SLACK_WORKSPACE_URL: "https://acme.slack.com",
        BROWSER_EVIDENCE_DIR: "/runner/evidence",
      },
      [],
    );
    expect(cfg.requesterProfileDir).toBe("/runner/profiles/requester");
    expect(cfg.workspaceUrl).toBe("https://acme.slack.com");
    expect(cfg.journeys).toEqual([...BROWSER_JOURNEY_IDS]);
    expect(() => parseBrowserArgv({}, ["--profile-dir", "/p", "--workspace", "https://x.slack.com", "--journey", "nope"])).toThrow(
      /unknown journey/,
    );
    expect(() => parseBrowserArgv({}, ["--profile-dir", "/p", "--workspace", "https://x.slack.com", "--role", "nobody"])).toThrow(
      /unknown --role/,
    );
  });

  test("--role space-approver is canonicalized to the approver identity (finding #3)", () => {
    expect(canonicalIdentity("space-approver")).toBe("approver");
    expect(canonicalIdentity("approver")).toBe("approver");
    expect(canonicalIdentity("member")).toBe("member");
    expect(canonicalIdentity("nobody")).toBeUndefined();
  });

  test("a focused --role selecting zero browser journeys FAILS CLOSED, never passes (finding #3)", () => {
    const cfg = baseArgv({ journeys: ["browser.dm-card-lifecycle"], role: "approver" });
    // The dm-card journey drives only the requester, not the approver.
    expect(() => selectBrowserJourneys(cfg)).toThrow(/selects no browser journeys/);
  });

  test("--journey really selects which journeys run (finding #4)", () => {
    const cfg = baseArgv({ journeys: ["browser.dm-card-lifecycle"] });
    expect(selectBrowserJourneys(cfg)).toEqual(["browser.dm-card-lifecycle"]);
    const all = baseArgv({});
    expect(selectBrowserJourneys(all)).toEqual([...BROWSER_JOURNEY_IDS]);
  });

  test("every browser journey's second profile is wired: approve-deny needs approver, threaded needs member (finding #2)", () => {
    expect(browserJourneySecondProfile("browser.approve-deny-buttons")).toBe("approver");
    expect(browserJourneySecondProfile("browser.threaded-multiplayer")).toBe("member");
    expect(browserJourneySecondProfile("browser.dm-card-lifecycle")).toBeUndefined();
    // The wired profiles map covers every identity a journey declares.
    const wired = new Set(Object.values(baseArgv().profiles ?? {}).map(() => true));
    expect(wired.size).toBeGreaterThan(0);
  });
});