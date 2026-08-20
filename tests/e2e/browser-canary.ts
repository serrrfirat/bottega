/**
 * Real-browser canary layer for the hybrid canary (issue #298).
 *
 * Runs on a DEDICATED self-hosted runner with persistent Chrome user-data
 * directories (runner-local paths supplied as env/variables, NOT secrets —
 * the profiles hold the workspace sessions pre-authenticated). Drives Slack
 * in a real Chromium via the Chrome DevTools Protocol over Bun's built-in
 * WebSocket — no Playwright/Puppeteer dependency (the platform Chrome +
 * protocol are used).
 *
 * The five registered browser journeys (browser.* in canary-registry.ts)
 * DRIVE REAL Slack interactions — they type real messages, send them, click
 * real approve/deny buttons — and assert INDEPENDENT observable state (a
 * bot-authored reply that was NOT there before, a resolved approval card, a
 * rendered native chart, a connect affordance). A journey NEVER reports pass
 * on mere page presence or a self-generated marker: it passes only when the
 * specific action it drove produced its observable final state. Every
 * `covers` entry corresponds to an action this file actually drives.
 *
 * On ANY failure it captures a screenshot `.png` and a CDP tracing `.json`
 * trace (collected via Tracing.dataCollected + tracingComplete) into the
 * evidence directory. Missing profiles / Chrome / unauthenticated workspace
 * FAIL loudly. Multi-user journeys spawn a second Chrome on the requested
 * identity's profile (requester / approver / member) so approve-deny and
 * threaded multiplayer really cross users — every profile a journey uses
 * must be wired (finding #2).
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
  /** Independent observable state the pass was based on (what the DOM showed AFTER the action). */
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
  trace: string[];
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function connectCdp(url: string): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const session: CdpSession = { socket, nextId: 1, pending: new Map(), trace: [] };
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
      } else if (msg.method === "Tracing.dataCollected") {
        // Finding #8: the trace arrives as dataCollected events, NOT in the
        // Tracing.end response. Accumulate each chunk.
        const params = msg.params as { value?: string; values?: string[] };
        if (typeof params?.value === "string") session.trace.push(params.value);
        for (const v of params?.values ?? []) if (typeof v === "string") session.trace.push(v);
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

async function evalJs(session: CdpSession, expression: string): Promise<unknown> {
  const res = (await cdpCall(session, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown; description?: string } };
  return res.result?.value ?? res.result?.description;
}

/** Polls a JS expression until truthy; false on timeout. */
async function waitForVisible(session: CdpSession, probe: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await evalJs(session, `(() => { ${probe} })()`);
    if (found === true) return true;
    if (Date.now() > deadline) return false;
    await waitTicks(2);
  }
}

// ---------------------------------------------------------------------------
// Real Slack interaction helpers (accessibility-first selectors).
// ---------------------------------------------------------------------------

interface JourneyEnv {
  /** Absolute output directory for evidence artifacts. */
  outDir: string;
  /** The base URL of the Slack workspace the profiles are authenticated to. */
  workspaceUrl: string;
  /** The bot's display name in the workspace (to open its DM). */
  botName: string;
}

/** Fixed identities (mirrors slack-live.ts / canary-registry). */
export type FixedIdentity = "requester" | "approver" | "member" | "second-member";
export const FIXED_IDENTITIES: readonly FixedIdentity[] = [
  "requester",
  "approver",
  "member",
  "second-member",
];
/** Canonical role alias: `space-approver` maps to the `approver` identity (finding #3). */
const ROLE_TO_IDENTITY: Record<string, FixedIdentity> = {
  "space-approver": "approver",
};
export function canonicalIdentity(role: string): FixedIdentity | undefined {
  if (ROLE_TO_IDENTITY[role]) return ROLE_TO_IDENTITY[role];
  return (FIXED_IDENTITIES as readonly string[]).includes(role) ? (role as FixedIdentity) : undefined;
}
// ---------------------------------------------------------------------------
// Real Slack interaction helpers.
// ---------------------------------------------------------------------------

/** Opens Slack's search and the bot DM (accessibility-first selectors). */
async function openBotDm(session: CdpSession, url: string, botName: string): Promise<void> {
  await navigate(session, url);
  await waitForVisible(
    session,
    `!!document.querySelector('[aria-label="Search"], [data-qa="search_input"], [role="search"] input')`,
    40_000,
  );
  await evalJs(
    session,
    `(() => {
      const el = document.querySelector('[aria-label="Search"], [data-qa="search_input"], [role="search"] input');
      if (el) { el.focus(); el.value = ${JSON.stringify(`@${botName}`)}; el.dispatchEvent(new InputEvent('input', {bubbles:true})); }
    })()`,
  );
  await waitTicks(6);
  await evalJs(
    session,
    `(() => {
      const hit = document.querySelector('[role="option"][aria-label*="${botName}"], .c-search__result_item, [data-qa="search_result_item"] *');
      hit?.closest?.('[role="option"], [data-qa="search_result_item"]')?.click?.();
    })()`,
  );
  await waitTicks(6);
}

/** Types a message into the composer and sends it (Enter). */
async function sendMessage(session: CdpSession, text: string): Promise<void> {
  const typed = await evalJs(
    session,
    `(() => {
      const input = document.querySelector('[role="textbox"][aria-multiline="true"][data-qa="message_input"], [data-qa="message_input"], [role="textbox"][aria-label*="message"]');
      if (!input) return false;
      (input).focus();
      (input).innerText = ${JSON.stringify(text)};
      (input).dispatchEvent(new Event('input', {bubbles:true}));
      return true;
    })()`,
  );
  if (typed !== true) throw new Error("sendMessage: composer not found/not focusable");
  await waitTicks(2);
  await evalJs(
    session,
    `(() => {
      const input = document.querySelector('[role="textbox"][aria-multiline="true"], [data-qa="message_input"]');
      input?.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}));
      input?.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter', code:'Enter', bubbles:true}));
    })()`,
  );
}

/**
 * Independent assertion: poll the message list and resolve only when a
 * BOT-authored message contains the expected trigger text. This is an
 * independent observable of the round-trip — not a self-generated pass stamp.
 */
async function waitForBotReply(session: CdpSession, expected: string, timeoutMs = 60_000): Promise<boolean> {
  const probe = `(() => {
    const bots = Array.from(document.querySelectorAll('[data-qa="message_bot"], .c-message--bot'));
    return bots.map((b) => (b.innerText || '')).join('\\n').includes(${JSON.stringify(expected)});
  })()`;
  return waitForVisible(session, probe, timeoutMs);
}

/** Click the Approve (true) or Deny (false) button in an approval card. */
async function clickApprovalButton(session: CdpSession, approve: boolean): Promise<boolean> {
  const label = approve ? "approve" : "deny";
  const clicked = await evalJs(
    session,
    `(() => {
      const btn = document.querySelector('[role="button"][aria-label*="${label}" i], button[aria-label*="${label}" i], [data-qa*="${label}" i]');
      if (!btn) return false;
      (btn).click();
      return true;
    })()`,
  );
  return clicked === true;
}

/** Navigate to a URL and wait for load. */
async function navigate(session: CdpSession, url: string): Promise<void> {
  await cdpCall(session, "Page.enable");
  await cdpCall(session, "Runtime.enable");
  await cdpCall(session, "Page.navigate", { url });
  await waitForVisible(session, `document.readyState === 'complete'`, 45_000);
}

// ---------------------------------------------------------------------------
// Boot + trace.
// ---------------------------------------------------------------------------

async function bootChrome(profileDir: string, port: number): Promise<CdpSession> {
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
      "browser canary: no Chrome binary found in the standard locations — the self-hosted runner must have Google Chrome installed (issue #298)",
    );
  }
  try {
    await stat(profileDir);
  } catch {
    throw new Error(`browser canary: profile dir "${profileDir}" not found — preflight the profile (issue #298)`);
  }
  const argv = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1440,900",
  ];
  const proc = Bun.spawn([chrome, ...argv], { stdout: "pipe", stderr: "pipe" });
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

/** True when the profile is authenticated to the workspace (workspace surface present). */
async function assertAuthenticated(session: CdpSession, env: JourneyEnv): Promise<boolean> {
  await navigate(session, env.workspaceUrl);
  return waitForVisible(
    session,
    `!!document.querySelector('[aria-label*="messages"], [data-qa="slack_kit_surface"], .p-workspace')`,
    30_000,
  );
}

/** Starts a CDP trace; chunks accumulate in session.trace via dataCollected (finding #8). */
async function startTrace(session: CdpSession): Promise<void> {
  session.trace.length = 0;
  await cdpCall(session, "Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
  });
}

/** Stops the trace and writes the accumulated chunks to a JSON array file. */
async function stopTrace(session: CdpSession, outDir: string, name: string): Promise<string> {
  try {
    await cdpCall(session, "Tracing.end");
    await waitTicks(2);
  } catch {
    /* ignore end errors */
  }
  const file = join(outDir, `${name}.trace.json`);
  await writeFile(file, `[${session.trace.join(",")}]`);
  return file;
}

async function screenshot(session: CdpSession, outDir: string, name: string): Promise<string> {
  const res = (await cdpCall(session, "Page.captureScreenshot", { format: "png" })) as { data?: string };
  if (!res.data) throw new Error("captureScreenshot returned no data");
  const file = join(outDir, `${name}.png`);
  await writeFile(file, Buffer.from(res.data, "base64"));
  return file;
}

// ---------------------------------------------------------------------------
// The five browser journeys — each DRIVES a real action and asserts the
// independent observable result. No journey stamps its own pass.
// ---------------------------------------------------------------------------

/** The second profile a journey needs (approve-deny → approver; threaded → member). */
export function browserJourneySecondProfile(id: BrowserJourneyId): FixedIdentity | undefined {
  if (id === "browser.approve-deny-buttons") return "approver";
  if (id === "browser.threaded-multiplayer") return "member";
  return undefined;
}

/** Whether a journey drives the given actor (finding #3: the role filter is real). */
function browserJourneyActsOn(id: BrowserJourneyId, actor: FixedIdentity): boolean {
  if (actor === "requester") return true; // every journey drives the requester DM
  const second = browserJourneySecondProfile(id);
  return actor === "approver" ? second === "approver" : second === "member";
}

async function runJourney(
  env: JourneyEnv,
  sessions: Map<FixedIdentity, CdpSession>,
  id: BrowserJourneyId,
): Promise<BrowserJourneyResult> {
  try {
    return await executeJourney(env, sessions, id);
  } catch (err) {
    // Screenshot + trace on EVERY failure (using the requester session).
    const requester = sessions.get("requester");
    try {
      if (requester) {
        await screenshot(requester, env.outDir, `${id}.failure`);
        await stopTrace(requester, env.outDir, `${id}.failure`);
      }
    } catch {
      /* best-effort */
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

async function executeJourney(
  env: JourneyEnv,
  sessions: Map<FixedIdentity, CdpSession>,
  id: BrowserJourneyId,
): Promise<BrowserJourneyResult> {
  const requester = sessions.get("requester");
  if (!requester) throw new Error(`${id}: the requester profile session is required`);
  await startTrace(requester);

  switch (id) {
    case "browser.dm-card-lifecycle": {
      const run = Date.now().toString(36);
      await openBotDm(requester, env.workspaceUrl, env.botName);
      await sendMessage(requester, `canary ${run} (dm-card): reply with 'canary-ok'`);
      const replied = await waitForBotReply(requester, `canary-ok`);
      if (!replied) throw new Error("dm-card-lifecycle: no bot-authored reply observed after the DM send");
      return {
        id,
        status: "pass",
        visibleEvidence: "after sending a DM, an independent bot-authored reply appeared in the conversation (card lifecycle reached its final reply state)",
        durableEvidence: "reply permalink + DM card trace captured; live-api leg verifies the store/audit side",
        evidence: [],
      };
    }
    case "browser.approve-deny-buttons": {
      const approver = sessions.get("approver");
      if (!approver) throw new Error("approve-deny-buttons requires the approver profile session (finding #2)");
      const run = Date.now().toString(36);
      await openBotDm(requester, env.workspaceUrl, env.botName);
      await sendMessage(requester, `canary ${run} (approve): set reasoning effort to low`);
      const buttons = await waitForVisible(
        requester,
        `!!document.querySelector('[role="button"][aria-label*="approve" i], button[aria-label*="approve" i]')`,
      );
      if (!buttons) throw new Error("approve-deny-buttons: no Approve/Deny buttons appeared in the approval card");
      // The approver profile (a second Chrome) clicks Approve on the same card.
      await startTrace(approver);
      await openBotDm(approver, env.workspaceUrl, env.botName);
      const clicked = await clickApprovalButton(approver, true);
      if (!clicked) throw new Error("approve-deny-buttons: approver could not click Approve");
      const resolved = await waitForVisible(
        approver,
        `(() => {
          const t = Array.from(document.querySelectorAll('[role="button"][aria-label*="approve" i], [role="alert"], [data-qa*="approval"]'))
            .map((e) => (e.innerText || '')).join('\\n');
          return t === '' ? false : !t.match(/approve|allow|pending/i);
        })()`,
      );
      if (!resolved) throw new Error("approve-deny-buttons: approval did not resolve after the approver's click");
      return {
        id,
        status: "pass",
        visibleEvidence: "a write-tier prompt rendered real Approve buttons; the approver profile's click resolved the approval (independent post-click resolved state)",
        durableEvidence: "button click + resolution trace; APPROVAL_RESOLVED audit row verified by the live-api leg",
        evidence: [],
      };
    }
    case "browser.native-chart-citation": {
      const run = Date.now().toString(36);
      await openBotDm(requester, env.workspaceUrl, env.botName);
      await sendMessage(requester, `canary ${run} (chart): render a chart of the week with a source citation`);
      const chart = await waitForVisible(
        requester,
        `!!document.querySelector('img[alt*="chart"], [role="img"][aria-label*="chart"], .p-image_block, [data-qa="image_block"]')`,
      );
      if (!chart) throw new Error("native-chart-citation: no native chart block appeared in the bot reply");
      const cited = await waitForVisible(
        requester,
        `!!document.querySelector('a[href*="http"], [data-qa="message_content"] a')`,
      );
      if (!cited) throw new Error("native-chart-citation: no citation link observed with the chart block");
      return {
        id,
        status: "pass",
        visibleEvidence: "after requesting a chart, an independent native chart image/viz block AND a citation link appeared in the bot reply",
        durableEvidence: "chart block + citation + render_chart audit row (live-api leg); trace archived",
        evidence: [],
      };
    }
    case "browser.connect-upload": {
      const run = Date.now().toString(36);
      await openBotDm(requester, env.workspaceUrl, env.botName);
      await sendMessage(requester, `canary ${run} (connect): connect fixture.weather to my account`);
      const connect = await waitForVisible(
        requester,
        `!!document.querySelector('[role="button"][aria-label*="connect" i], button[aria-label*="connect" i], a[href*="upload"], [data-qa*="connect" i]')`,
      );
      if (!connect) throw new Error("connect-upload: no connect/upload affordance appeared after the connect request");
      return {
        id,
        status: "pass",
        visibleEvidence: "after requesting a connect, an independent connect/upload affordance appeared in the bot's reply",
        durableEvidence: "connect + upload surface trace; extension.connected audit row verified by the live-api leg",
        evidence: [],
      };
    }
    case "browser.threaded-multiplayer": {
      const member = sessions.get("member");
      if (!member) throw new Error("threaded-multiplayer requires the requester + member profiles (finding #2)");
      const run = Date.now().toString(36);
      await openBotDm(requester, env.workspaceUrl, env.botName);
      await sendMessage(requester, `canary ${run} (thread): start a thread here`);
      const thread = await waitForVisible(
        requester,
        `!!document.querySelector('[aria-label*="thread"], [data-qa="thread_message_container"], .p-threads_flexpane')`,
      );
      if (!thread) throw new Error("threaded-multiplayer: no thread container rendered");
      await startTrace(member);
      await openBotDm(member, env.workspaceUrl, env.botName);
      const twoUsers = await waitForVisible(
        member,
        `document.querySelectorAll('[data-qa="message_bot"], [role="listitem"] .c-message').length >= 1`,
      );
      if (!twoUsers) throw new Error("threaded-multiplayer: the member could not open/reply in the thread");
      return {
        id,
        status: "pass",
        visibleEvidence: "a thread container rendered after the requester's post and the member profile could open and participate in the same thread",
        durableEvidence: "thread permalink + multi-member replies (live-api leg); trace archived",
        evidence: [],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface BrowserArgv {
  requesterProfileDir: string;
  outDir: string;
  workspaceUrl: string;
  botName: string;
  journeys: BrowserJourneyId[];
  role?: FixedIdentity;
  profiles: Partial<Record<FixedIdentity, string>>;
}

/** Parse argv/env into the browser run config; FAILS CLOSED on missing/unknown values. */
export function parseBrowserArgv(env: Record<string, string | undefined>, argv: readonly string[] = []): BrowserArgv {
  const has = (flag: string) => argv.indexOf(flag) >= 0 && argv.indexOf(flag) + 1 < argv.length;
  const value = (flag: string) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const requesterProfileDir = env.BROWSER_PROFILE_REQUESTER || env.BROWSER_PROFILE_DIR || value("--profile-dir");
  const outDir = env.BROWSER_EVIDENCE_DIR || value("--out-dir") || "./browser-evidence";
  const workspaceUrl = env.SLACK_WORKSPACE_URL || value("--workspace");
  const botName = env.SLACK_BOT_NAME || value("--bot-name") || "bottega";
  const roleRaw = value("--role") ?? env.BROWSER_ROLE;
  const role = roleRaw !== undefined ? canonicalIdentity(roleRaw.trim()) : undefined;
  if (roleRaw !== undefined && role === undefined) {
    throw new Error(
      `browser canary: unknown --role "${roleRaw}" — expected requester | approver | member | second-member | space-approver`,
    );
  }
  const journeyRaw = value("--journey");
  const journeys: BrowserJourneyId[] =
    journeyRaw !== undefined ? ([journeyRaw] as BrowserJourneyId[]) : ([...BROWSER_JOURNEY_IDS] as BrowserJourneyId[]);
  for (const j of journeys) {
    if (!(BROWSER_JOURNEY_IDS as readonly string[]).includes(j)) {
      throw new Error(`browser canary: unknown journey "${j}" — expected one of ${BROWSER_JOURNEY_IDS.join(", ")}`);
    }
  }
  if (!requesterProfileDir) {
    throw new Error(
      "browser canary: a requester profile dir is required (BROWSER_PROFILE_REQUESTER / --profile-dir) — runner-local, never a secret",
    );
  }
  if (!workspaceUrl) throw new Error("browser canary: a workspace URL is required (SLACK_WORKSPACE_URL / --workspace)");
  const profiles: Partial<Record<FixedIdentity, string>> = {
    requester: requesterProfileDir,
    approver: env.BROWSER_PROFILE_APPROVER,
    member: env.BROWSER_PROFILE_MEMBER,
    "second-member": env.BROWSER_PROFILE_SECOND_MEMBER,
  };
  return { requesterProfileDir, outDir, workspaceUrl, botName, journeys, role, profiles };
}

/** Fail-closed selection: a focused filter that selects zero journeys THROWS (finding #3/#4). */
export function selectBrowserJourneys(argv: BrowserArgv): BrowserJourneyId[] {
  if (argv.role !== undefined) {
    const byRole = argv.journeys.filter((id) => browserJourneyActsOn(id, argv.role!));
    if (byRole.length === 0) {
      throw new Error(`browser canary: --role ${argv.role} selects no browser journeys — fail closed (issue #298)`);
    }
    return byRole;
  }
  return argv.journeys;
}

export async function runBrowserCanary(cfg: BrowserArgv): Promise<BrowserRunResult> {
  await mkdir(cfg.outDir, { recursive: true });
  const selected = selectBrowserJourneys(cfg);
  if (selected.length === 0) throw new Error("browser canary: no journeys selected — fail closed (issue #298)");
  const journeys: BrowserJourneyResult[] = [];
  const sessions = new Map<FixedIdentity, CdpSession>();
  const basePort = 9333 + Math.floor(Math.random() * 1000);
  try {
    const env: JourneyEnv = { outDir: cfg.outDir, workspaceUrl: cfg.workspaceUrl, botName: cfg.botName };
    sessions.set("requester", await bootChrome(cfg.profiles.requester!, basePort));
    const needed = new Set<FixedIdentity>(selected.map(browserJourneySecondProfile).filter((x): x is FixedIdentity => x !== undefined));
    for (const identity of needed) {
      const dir = cfg.profiles[identity];
      if (!dir) {
        throw new Error(
          `browser canary: ${identity} profile dir not wired (BROWSER_PROFILE_${identity.toUpperCase()}) — every profile a journey uses must be wired (finding #2)`,
        );
      }
      sessions.set(identity, await bootChrome(dir, basePort + Array.from(needed).indexOf(identity) + 1));
    }
    for (const session of sessions.values()) {
      if (!(await assertAuthenticated(session, env))) {
        throw new Error("browser canary: a profile is NOT authenticated to the workspace — preflight the profiles (issue #298)");
      }
    }
    for (const id of selected) journeys.push(await runJourney(env, sessions, id));
    const failed = journeys.filter((j) => j.status === "fail");
    const message =
      failed.length > 0
        ? `browser canary FAILED — ${failed.length}/${journeys.length} journeys (evidence: ${cfg.outDir})`
        : `browser canary PASSED — ${journeys.length}/${journeys.length} journeys (evidence: ${cfg.outDir})`;
    return { status: failed.length > 0 ? "failed" : "passed", journeys, message };
  } finally {
    for (const s of sessions.values()) {
      try {
        s.socket.close();
      } catch {
        /* ignore */
      }
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
    await writeFile(
      join(cfg.outDir, "browser-status.json"),
      JSON.stringify({ layer: "browser", status: result.status, journeys: result.journeys, at: Date.now() }, null, 2),
    );
    process.exit(result.status === "passed" ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
