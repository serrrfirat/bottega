import { describe, expect, test, vi } from "bun:test";
import { SLACK_RECONNECT_MAX_DELAY_MS, describeError, watchSocketModeReconnect } from "./slack";

/**
 * Hermetic regression for issue #237: @slack/socket-mode v3 computes its own
 * reconnection backoff as `clientPingTimeout * consecutiveFailures`, and this
 * adapter pins `clientPingTimeout` to 24h (a Bun keepalive workaround), so the
 * SDK's auto-reconnect would stay dead for ~24h after any socket drop. The
 * fix disables the SDK's auto-reconnect and drives reconnection through
 * `watchSocketModeReconnect` with bounded exponential backoff. These tests
 * drive that watchdog against a fake socket-mode client whose connection can
 * be dropped and whose start() can fail — no real sockets, no mock.module.
 * Fake timers make the backoff schedule fully deterministic.
 */

type SocketLifecycleEvent = "connected" | "disconnected";

/** Records start() timestamps and the events the watchdog subscribes to. */
class FakeSocketModeClient {
  readonly startCalls: number[] = [];
  /** start() rejects while > 0 (like a failed apps.connections.open / hello). */
  failNextStart = 0;
  /**
   * When `rejectWithMarkedValue` is set before a failing start(), it rejects
   * with `markedRejectValue` — used to reproduce the SDK rejecting with NO
   * value at all (a pre-hello websocket death under autoReconnectEnabled:
   * false, which is what produced "boot connect failed: undefined").
   */
  markedRejectValue?: unknown;
  rejectWithMarkedValue = false;
  private listeners = new Map<SocketLifecycleEvent, Set<(reason?: Error) => void>>();

  on(event: SocketLifecycleEvent, listener: (reason?: Error) => void): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  emit(event: SocketLifecycleEvent, reason?: Error): void {
    for (const listener of this.listeners.get(event) ?? []) listener(reason);
  }

  async start(): Promise<void> {
    this.startCalls.push(Date.now());
    if (this.failNextStart > 0) {
      this.failNextStart -= 1;
      if (this.rejectWithMarkedValue) throw this.markedRejectValue;
      throw new Error("apps.connections.open simulated failure");
    }
  }
}

function capturingLog() {
  const lines: string[] = [];
  return {
    lines,
    log: { connect: (m: string) => lines.push(m), failure: (m: string) => lines.push(m) },
  };
}

/**
 * Fires fake timers up to `ms`, then yields so the watchdog's reconnect
 * `fire()` can resume its `await` (a microtask) before asserts run.
 */
async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe("socket-mode reconnect watchdog (issue #237)", () => {
  test("reconnect window is bounded far below the SDK's 24h", () => {
    // The production cap is the contract: minutes, not a day.
    expect(SLACK_RECONNECT_MAX_DELAY_MS).toBeLessThan(5 * 60 * 1000);
  });

  test("a dropped connection reconnects within the bounded window and the reconnect is logged", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketModeClient();
    const capture = capturingLog();
    const watchdog = watchSocketModeReconnect(client, capture.log, {
      baseDelayMs: 10,
      maxDelayMs: 40,
    });
    try {
      client.emit("connected"); // boot handshake (Slack hello)
      expect(capture.lines).toContain("[slack] socket connected");

      client.emit("disconnected"); // schedules the first attempt at +10ms
      await tick(9);
      // Nothing before the bounded delay — a scheduled (not instant) retry.
      expect(client.startCalls.length).toBe(0);
      await tick(1); // the first reconnect attempt fires
      expect(client.startCalls.length).toBe(1);
      // The drop is logged at INFO+ with attempt + elapsed detail.
      expect(capture.lines.some((l) => l.includes("socket-mode connection lost"))).toBe(true);
      expect(capture.lines.some((l) => l.includes("reconnecting in") && l.includes("attempt"))).toBe(true);

      // Recover: complete the new handshake — the successful reconnect is
      // logged — then a second drop reconnects again.
      client.emit("connected");
      expect(capture.lines.some((l) => l.includes("socket connected after 1 reconnect attempt"))).toBe(true);
      client.emit("disconnected");
      await tick(10);
      expect(client.startCalls.length).toBe(2);
    } finally {
      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  test("a failed reconnect retries with bounded exponential backoff and logs every failure", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketModeClient();
    client.failNextStart = 99; // every reconnect attempt fails (e.g. no WSS URL)
    const capture = capturingLog();
    const watchdog = watchSocketModeReconnect(client, capture.log, {
      baseDelayMs: 10,
      maxDelayMs: 40,
    });
    try {
      client.emit("connected");
      client.emit("disconnected");

      // Backoff steps: attempt1 at +10ms, then +20ms, then +40ms (capped).
      // Walk through several steps so the loop demonstrably stays alive past
      // the first retry and the retries stay bounded.
      for (const step of [10, 20, 40, 40, 40]) await tick(step);
      expect(client.startCalls.length).toBeGreaterThanOrEqual(4);
      // Every failure is logged at INFO+ with attempt number + next delay.
      for (const attempt of [1, 2, 3, 4]) {
        expect(capture.lines.some((l) => l.includes(`reconnect attempt ${attempt} failed`))).toBe(true);
      }
      expect(capture.lines.some((l) => l.includes("retrying in"))).toBe(true);
    } finally {
      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  test("dispose() keeps a stopped adapter stopped (manual shutdown never reconnects)", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketModeClient();
    const capture = capturingLog();
    const watchdog = watchSocketModeReconnect(client, capture.log, {
      baseDelayMs: 10,
      maxDelayMs: 40,
    });
    try {
      client.emit("connected");
      watchdog.dispose(); // adapter.stop() runs this BEFORE the SDK disconnects
      const startsBefore = client.startCalls.length;
      client.emit("disconnected"); // the SDK emits this on a manual disconnect
      await tick(1_000); // far past any scheduled first attempt
      expect(client.startCalls.length).toBe(startsBefore);
    } finally {
      watchdog.dispose(); // idempotent
      vi.useRealTimers();
    }
  });
});

describe("socket-mode boot/reconnect error surfacing (#261 nightly red)", () => {
  test("describeError renders every rejection shape without crashing", () => {
    expect(describeError(new Error("boom"))).toContain("boom");
    expect(describeError("plain")).toBe("plain");
    class Circular {
      self?: Circular;
    }
    const circular = new Circular();
    circular.self = circular;
    expect(describeError(circular)).toBe("[object Object]");
  });

  test("a reconnect attempt rejected with NO value still logs a labeled failure", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketModeClient();
    client.failNextStart = 1;
    client.markedRejectValue = undefined; // exactly what the SDK does pre-hello
    client.rejectWithMarkedValue = true;
    const capture = capturingLog();
    const watchdog = watchSocketModeReconnect(client, capture.log, { baseDelayMs: 10, maxDelayMs: 40 });
    try {
      client.emit("connected");
      client.emit("disconnected");
      await tick(10);
      expect(capture.lines.some((l) => l.includes("reconnect attempt 1 failed (undefined)"))).toBe(true);
      // The loop stays alive after the argument-less rejection.
      expect(client.startCalls.length).toBe(1);
    } finally {
      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  test("a disconnect carrying a reason surfaces it in the connection-lost log", () => {
    const client = new FakeSocketModeClient();
    const capture = capturingLog();
    const watchdog = watchSocketModeReconnect(client, capture.log, { baseDelayMs: 10, maxDelayMs: 40 });
    try {
      client.emit("connected");
      client.emit("disconnected", new Error("wss handshake refused"));
      expect(
        capture.lines.some((l) => l.includes("connection lost") && l.includes("reason: Error: wss handshake refused")),
      ).toBe(true);
    } finally {
      watchdog.dispose();
    }
  });
});
