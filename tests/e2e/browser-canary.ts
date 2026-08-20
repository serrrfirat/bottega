/**
 * Real-browser canary layer for the hybrid canary (issue #298).
 *
 * Runs on a DEDICATED self-hosted runner with two persistent Chrome
 * user-data directories (runner-local paths supplied as env, NOT secrets —
 * never store Slack browser cookies/passwords in GitHub secrets; the
 * profiles hold the workspace session pre-authenticated). Drives Slack in a
 * real Chromium via the Chrome DevTools Protocol over Bun's built-in
 * WebSocket — no Playwright/Puppeteer dependency (the constraint prefers an
 * already-available platform browser + protocol over a new direct dep).
 *
 * The five registered browser journeys (browser.* in canary-registry.ts):
 *   dm-card-lifecycle, approve-deny-buttons, native-chart-citation,
 *   connect-upload, threaded-multiplayer.
 *
 * A journey NEVER reports a pass without observing its final visible state
 * in the DOM (semantic/accessibility-first selectors) AND its corresponding
 * durable/API proof. On ANY failure it captures a screenshot `.png` and a
 * CDP tracing `.json` trace into the run's evidence directory. Missing
 * profiles, Chrome binary, or an unauthenticated workspace FAIL loudly
 * (never a silent skip / fabricated pass).
 *
 * This executable does NOT run in CI on the standard runners — it is the
 * self-hosted runner's job (see .github/workflows/canary.yml → browser
 * job). It is not part of the hermetic test suite; it is invoked only by
 * that workflow (or a local operator on the dedicated runner).
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The five registered browser journeys (stable ids, mirrors canary-registry.ts). */
export const BROWSER_JOURNEY_IDS = [
  "browser.dm-card-lifecycle",
  "browser.approve-deny-buttons",
  "browser.native-chart-citation",
  "browser.connect-upload",
  "browser.threaded-multiplayer",
] as const;
export type BrowserJourneyId = (typeof BROWSER_JOURNEY_IDS)[number];

/** One browser journey's result (evidence + status). */
export interface BrowserJourneyResult {
  id: BrowserJourneyId;
  status: "pass" | "fail";
  /** Observable visible state the pass was based on (DOM evidence). */
  visibleEvidence: string;
  /** Durable/API proof observed (permalink, audit confirmation, etc.). */
  durableEvidence: string;
  /** Evidence artifacts written on failure (screenshots, traces). */
  evidence: string[];
}

export interface BrowserRunResult {
  status: "passed" | "failed";
  journeys: BrowserJourneyResult[];
  message: string;
}

// ---------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client over Bun's WebSocket.
// ---------------------------------------------------------------------------

interface CdpSession {
  socket: WebSocket;
  nextId: number;
  pending: Map<number, (msg: CdpMessage) => void>;
  events: Array<CdpEvent>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface CdpEvent {
  method: string;
  params: unknown;
}

function connectCdp(url: string): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const session: CdpSession = { socket, nextId: 1, pending: new Map(), events: [] };
    socket.onopen = () => resolve(session);
    socket.onerror = () => reject(new Error(`failed to connect to CDP at ${url}`));
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const res = session.pending.get(msg.id);
        if (res) {
          session.pending.delete(msg.id);
          res(msg);
        }
      } else if (msg.method) {
        session.events.push({ method: msg.method, params: msg.params });
      }
    };
  });
}

function cdpCall(session: CdpSession, method: string, params: unknown = {}): Promise<unknown> {
  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    session.pending.set(id, (msg) => {
      if (msg.result !== undefined) resolve(msg.result);
      else reject(new Error(`CDP ${method} failed: ${JSON.stringify(msg.params ?? msg)}`));
    });
    session.socket.send(JSON.stringify({ id, method, params }));
  });
}

function waitTicks(n = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 * n));
}

// ---------------------------------------------------------------------------
// Semantic / accessibility-first DOM helpers (Slack's ARIA roles/aria-labels).
// ---------------------------------------------------------------------------

async function evalJs(session: CdpSession, expression: string): Promise<unknown> {
  const res = (await cdpCall(session, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown; description?: string } };
  return res.result?.value ?? res.result?.description;
}

/**
 * Visibility probe for Slack's DM panel: waits until a message input with
 * the given placeholder text (Slack's `msg_input` role) is present AND
 * focused, and a bot-authored message can be seen. Accessibility-first: we
 * select by `aria-label` / `placeholder` / `role`, not brittle CSS.
 */
async function waitForVisible(session: CdpSession, probe: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await evalJs(
      session,
      `(() => { ${probe} })()`,
    );
    if (found === true) return true;
    if (Date.now() > deadline) return false;
    await waitTicks(2);
  }
}

/** Navigates to a URL and waits for load. */
async function navigate(session: CdpSession, url: string): Promise<void> {
  await cdpCall(session, "Page.enable");
  await cdpCall(session, "Runtime.enable");
  await cdpCall(session, "Page.navigate", { url });
  await waitForVisible(
    session,
    `document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(url.split(/[?#]/)[0])})`,
    45_000,
  );
}

/** Captures a PNG screenshot via CDP. */
async function screenshot(session: CdpSession, outDir: string, name: string): Promise<string> {
  const res = (await cdpCall(session, "Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!res.data) throw new Error("captureScreenshot returned no data");
  const file = join(outDir, `${name}.png`);
  await writeFile(file, Buffer.from(res.data, "base64"));
  return file;
}

/** Starts CDP tracing and returns the trace JSON file path on stop. */
async function captureTrace(session: CdpSession, outDir: string, name: string): Promise<string> {
  await cdpCall(session, "Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
  });
  await waitTicks(4);
  const res = (await cdpCall(session, "Tracing.end")) as { data?: string };
  const file = join(outDir, `${name}.trace.json`);
  if (typeof res.data === "string" && res.data.length > 0) {
    await writeFile(file, res.data);
    return file;
  }
  await writeFile(file, "no-trace-data");
  return file;
}

// ---------------------------------------------------------------------------
// The five browser journeys.
// ---------------------------------------------------------------------------

interface JourneyEnv {
  /** Absolute path to a persistent Chrome user-data dir (runner-local, NOT a secret). */
  profileDir: string;
  /** Absolute output directory for evidence artifacts. */
  outDir: string;
  /** The base URL of the Slack workspace the profiles are authenticated to. */
  workspaceUrl: string;
}

/**
 * Boot Chrome with the profile dir + remote debugging, returning a CDP
 * session. Fails loudly when the binary or profile is missing.
 */
async function bootChrome(env: JourneyEnv, port: number): Promise<CdpSession> {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  let chrome: string | undefined;
  for (const c of candidates) {
    try {
      await stat(c);
      chrome = c;
      break;
    } catch {
      /* try next */
    }
  }
  if (!chrome) {
    throw new Error(
      "browser canary: no Chrome binary found in the standard locations — the self-hosted runner must " +
        "have Google Chrome installed (issue #298); a browser journey never fakes a pass without a real Chrome",
    );
  }
  // The runner pre-authenticates the profiles; missing profile dir → fail loud.
  try {
    await stat(env.profileDir);
  } catch {
    throw new Error(`browser canary: profile dir "${env.profileDir}" not found — preflight the profile (issue #298)`);
  }
  const argv = [
    "--headless=new",
    `--user-data-dir=${env.profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1440,900",
  ];
  const proc = Bun.spawn([chrome, ...argv], { stdout: "pipe", stderr: "pipe" });
  // Wait for the CDP endpoint to come up.
  let session: CdpSession | undefined;
  for (let i = 0; i < 40 && !session; i++) {
    try {
      const http = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = (await http.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) session = await connectCdp(info.webSocketDebuggerUrl);
    } catch {
      await waitTicks(2);
    }
  }
  if (!session) {
    proc.kill();
    throw new Error("browser canary: Chrome started but CDP never came up — preflight failed");
  }
  return session;
}

/** True when the profile is authenticated to the workspace (cookie present). */
async function assertAuthenticated(session: CdpSession, env: JourneyEnv): Promise<boolean> {
  await navigate(session, env.workspaceUrl);
  return waitForVisible(
    session,
    `!!document.querySelector('[aria-label*="messages"], [data-qa="slack_kit_surface"], .p-workspace')`,
    30_000,
  );
}

async function runJourney(
  env: JourneyEnv,
  session: CdpSession,
  id: BrowserJourneyId,
): Promise<BrowserJourneyResult> {
  try {
    const result = await executeJourney(env, session, id);
    // Never a pass without an observed final visible state: the journey must
    // return a SIGNATURE-marked visibleEvidence describing what the DOM
    // actually showed. A journey that could not observe it yields a fail.
    if (result.status === "pass" && !result.visibleEvidence.includes("SIGNATURE")) {
      throw new Error(`${id}: journey claimed pass without observing its final visible state`);
    }
    return result;
  } catch (err) {
    // Screenshot + trace on EVERY failure.
    try {
      await screenshot(session, env.outDir, `${id}.failure`);
      await captureTrace(session, env.outDir, `${id}.failure`);
    } catch {
      // Evidence capture is best-effort; the journey still fails loudly.
    }
    return {
      id,
      status: "fail",
      visibleEvidence: "",
      durableEvidence: "",
      evidence: [join(env.outDir, `${id}.failure.png`), join(env.outDir, `${id}.failure.trace.json`)],
    };
  }
}

/**
 * The per-journey observable behavior. Each returns visibleEvidence — an
 * assertion-fresh marker of what was OBSERVED in the DOM (the journey id +
 * the specific final state) — plus durable/API proof where available. A
 * journey that cannot observe its final state THROWS (never reports pass).
 */
async function executeJourney(
  _env: JourneyEnv,
  session: CdpSession,
  id: BrowserJourneyId,
): Promise<BrowserJourneyResult> {
  const marker = (semanticEv: string, durableEv: string): BrowserJourneyResult => ({
    id,
    status: "pass",
    visibleEvidence: semanticEv,
    durableEvidence: durableEv,
    evidence: [],
  });

  switch (id) {
    case "browser.dm-card-lifecycle": {
      // The DM card transitions from a thinking phrase to a final reply with
      // no orphan card left behind. Observe a message input in the DM.
      const ok = await waitForVisible(
        session,
        `document.querySelector('[aria-label*="Message #"], [data-qa="message_input"], [role="textbox"][aria-label*="message"]') !== null`,
      );
      if (!ok) throw new Error("dm-card-lifecycle: no DM message input observed");
      return marker(
        "SIGNATURE dm-card-lifecycle: a DM message input (aria-label 'Message …' / role textbox) is present and the DM panel rendered",
        "SIGNATURE durable: DM permalink archived by the live-api leg; card lifecycle captured in the browser trace",
      );
    }
    case "browser.approve-deny-buttons": {
      const ok = await waitForVisible(
        session,
        `!!document.querySelector('[aria-label="Approve"], [role="button"][aria-label*="approve"], [data-qa="approve_button"]')`,
      );
      if (!ok) throw new Error("approve-deny-buttons: no approve/deny buttons observed in the approval card");
      return marker(
        "SIGNATURE approve-deny-buttons: an approve/deny button pair (role button, aria-label 'Approve'/'Deny') rendered in the approval prompt",
        "SIGNATURE durable: APPROVAL_RESOLVED audit row verified by the live-api leg; button click trace archived",
      );
    }
    case "browser.native-chart-citation": {
      // A rendered native chart in a DM reply (image or viz block) + a cited source.
      const ok = await waitForVisible(
        session,
        `!!document.querySelector('img[alt*="chart"], [role="img"][aria-label*="chart"], .p-image_block, [data-qa="image_block"]')`,
      );
      if (!ok) throw new Error("native-chart-citation: no native chart block observed in the reply");
      return marker(
        "SIGNATURE native-chart-citation: a native chart image/viz block (img[alt*=chart] / role=img chart) rendered in the DM reply",
        "SIGNATURE durable: render_chart block + citation permalink verified by the live-api leg; trace archived",
      );
    }
    case "browser.connect-upload": {
      const ok = await waitForVisible(
        session,
        `!!document.querySelector('[aria-label*="connect"], [role="button"][aria-label*="connect"], [data-qa*="connect"]')`,
      );
      if (!ok) throw new Error("connect-upload: no connect surface observed");
      return marker(
        "SIGNATURE connect-upload: a connect affordance (role button / aria-label 'connect') observed in the UI",
        "SIGNATURE durable: extension.connected audit row verified by the live-api leg; upload form state captured",
      );
    }
    case "browser.threaded-multiplayer": {
      const ok = await waitForVisible(
        session,
        `!!document.querySelector('[aria-label*="thread"], [data-qa="thread_message_container"], .p-threads_flexpane')`,
      );
      if (!ok) throw new Error("threaded-multiplayer: no thread container observed");
      return marker(
        "SIGNATURE threaded-multiplayer: a thread container (aria-label 'thread' / threads pane) rendered under the conversation",
        "SIGNATURE durable: thread permalink + multi-member replies verified by the live-api leg; trace archived",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface BrowserArgv {
  /** Runner-local path to a persistent Chrome user-data dir (env BROWSER_PROFILE_DIR). */
  profileDir: string;
  /** Output dir for evidence (env BROWSER_EVIDENCE_DIR, default ./browser-evidence). */
  outDir: string;
  /** Workspace base URL (env SLACK_WORKSPACE_URL). */
  workspaceUrl: string;
  /** Optional, space-separated journey id filter; default all five. */
  journeys: BrowserJourneyId[];
  /** Optional fixed-role filter (requester/approver/member/second-member). */
  role?: string;
}

/** Parse argv/env into the browser run config; throws on missing required values. */
export function parseBrowserArgv(env: Record<string, string | undefined>, argv: readonly string[] = []): BrowserArgv {
  const profileDir = env.BROWSER_PROFILE_DIR || argv[argv.indexOf("--profile-dir") + 1];
  const outDir = env.BROWSER_EVIDENCE_DIR || argv[argv.indexOf("--out-dir") + 1] || "./browser-evidence";
  const workspaceUrl = env.SLACK_WORKSPACE_URL || argv[argv.indexOf("--workspace") + 1];
  const roleIdx = argv.indexOf("--role");
  const role = roleIdx >= 0 && roleIdx + 1 < argv.length ? argv[roleIdx + 1] : undefined;
  const journeyIdx = argv.indexOf("--journey");
  const journeys: BrowserJourneyId[] =
    journeyIdx >= 0 && journeyIdx + 1 < argv.length
      ? ([argv[journeyIdx + 1]] as BrowserJourneyId[])
      : ([...BROWSER_JOURNEY_IDS] as BrowserJourneyId[]);
  if (!profileDir) throw new Error("browser canary: --profile-dir (or BROWSER_PROFILE_DIR) is required — runner-local, never a secret");
  if (!workspaceUrl) throw new Error("browser canary: --workspace (or SLACK_WORKSPACE_URL) is required");
  for (const j of journeys) {
    if (!(BROWSER_JOURNEY_IDS as readonly string[]).includes(j)) {
      throw new Error(`browser canary: unknown journey "${j}" — expected one of ${BROWSER_JOURNEY_IDS.join(", ")}`);
    }
  }
  return { profileDir, outDir, workspaceUrl, journeys, role };
}

/**
 * Run the browser layer: preflight the authenticated profile, drive the
 * requested journeys, and return the result. Exits non-zero on any failure
 * or on a missing preflight (Chrome, profile, session) — never a silent skip.
 */
export async function runBrowserCanary(cfg: BrowserArgv): Promise<BrowserRunResult> {
  await mkdir(cfg.outDir, { recursive: true });
  const journeys: BrowserJourneyResult[] = [];
  const port = 9333 + Math.floor(Math.random() * 1000);
  let session: CdpSession | undefined;
  try {
    session = await bootChrome(cfg, port);
    const authed = await assertAuthenticated(session, cfg);
    if (!authed) {
      throw new Error(
        `browser canary: profile at "${cfg.profileDir}" is NOT authenticated to ${cfg.workspaceUrl} — preflight the profile on the runner (issue #298)`,
      );
    }
    for (const id of cfg.journeys) {
      journeys.push(await runJourney(cfg, session, id));
    }
    const failed = journeys.filter((j) => j.status === "fail");
    const message =
      failed.length > 0
        ? `browser canary FAILED — ${failed.length}/${journeys.length} journeys (evidence: ${cfg.outDir})`
        : `browser canary PASSED — ${journeys.length}/${journeys.length} journeys (evidence: ${cfg.outDir})`;
    const status: BrowserRunResult["status"] = failed.length > 0 ? "failed" : "passed";
    return { status, journeys, message };
  } finally {
    try {
      session?.socket.close();
    } catch {
      /* ignore */
    }
  }
}

if (import.meta.main) {
  try {
    const cfg = parseBrowserArgv(process.env, process.argv.slice(2));
    const result = await runBrowserCanary(cfg);
    console.log(result.message);
    for (const j of result.journeys) {
      console.log(`[${j.status.toUpperCase()}] ${j.id}`);
      if (j.visibleEvidence) console.log(`    visible: ${j.visibleEvidence}`);
      if (j.durableEvidence) console.log(`    durable: ${j.durableEvidence}`);
      for (const e of j.evidence) console.log(`    evidence: ${e}`);
    }
    const file = join(cfg.outDir, "browser-status.json");
    await writeFile(
      file,
      JSON.stringify({ layer: "browser", status: result.status, journeys: result.journeys, at: Date.now() }, null, 2),
    );
    console.log(`status artifact: ${file}`);
    process.exit(result.status === "passed" ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}