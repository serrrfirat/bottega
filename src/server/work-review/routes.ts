import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditModule } from "../../policy/audit";
import type { Store } from "../../store/db";
import type { SlackAdapter } from "../adapters/slack";
import { continueWork, CONTINUATION_GUIDANCE_MAX_CHARS } from "./continuation";
import { projectWorkReview } from "./project";
import { renderReviewMessage, renderWorkReview } from "./render";

export const WORK_REVIEW_COOKIE = "bottega_work_review";
export const WORK_REVIEW_SESSION_TTL_MS = 30 * 60_000;
export const WORK_REVIEW_CSRF_FIELD = "csrf";

const EVENT_REDEEMED = "work_review.redeemed";
const EVENT_DENIED = "work_review.membership_denied";
const EVENT_READ = "work_review.read";
const EVENT_CONTINUATION_FAILED = "work_review.continuation_failed";

export type WorkReviewRouteDeps = {
  store: Store;
  adapter: Pick<SlackAdapter, "isChannelMember" | "postMessage">;
  transcriptDir: string;
  audit?: Pick<AuditModule, "appendAudit">;
  now?: () => number;
  log?: (line: string) => void;
  /** Process-local raw CSRF values; only their digests are persisted. */
  csrfTokens?: Map<string, string>;
};

export interface WorkReviewRoutes {
  fetch(req: Request): Promise<Response>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(raw: string, expected: string): boolean {
  const actual = Buffer.from(digest(raw), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function htmlHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
}

function cookieValue(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === WORK_REVIEW_COOKIE && rest.length > 0) return rest.join("=");
  }
  return null;
}

function genericSession(): Response {
  return renderReviewMessage("Review unavailable", "Open the review again from Slack.", 401);
}

function genericDenied(): Response {
  return renderReviewMessage("Review unavailable", "You cannot access this review.", 403);
}

async function audit(deps: WorkReviewRouteDeps, eventType: string, actor: string, spaceId: string, payload: Record<string, string | boolean>): Promise<void> {
  if (deps.audit === undefined) return;
  await deps.audit.appendAudit({ space_id: spaceId, actor, event_type: eventType, payload });
}

async function liveSession(deps: WorkReviewRouteDeps, req: Request) {
  const raw = cookieValue(req);
  if (raw === null) return null;
  const session = deps.store.getAndTouchWorkReviewSession(raw, (deps.now ?? Date.now)());
  if (session === null) return null;
  const spaceId = `slack:${session.identity.slackChannelId}`;
  try {
    if (!(await deps.adapter.isChannelMember(spaceId, session.identity.slackUserId))) {
      await audit(deps, EVENT_DENIED, session.identity.slackUserId, spaceId, { reason: "not_member" });
      return null;
    }
  } catch (err) {
    deps.log?.(`[work-review] membership lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    await audit(deps, EVENT_DENIED, session.identity.slackUserId, spaceId, { reason: "membership_unavailable" });
    return null;
  }
  const source = await deps.store.getWorkItem(session.identity.workItemId);
  if (source === null || source.space_id !== spaceId) return null;
  return { raw, session, source, spaceId };
}

async function redeem(deps: WorkReviewRouteDeps, token: string): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const rawSession = randomBytes(32).toString("base64url");
  const rawCsrf = randomBytes(32).toString("base64url");
  const session = deps.store.redeemWorkReviewToken({
    rawToken: token,
    rawSession,
    csrfHash: digest(rawCsrf),
    sessionExpiresAt: now + WORK_REVIEW_SESSION_TTL_MS,
    now,
  });
  if (session === null) return renderReviewMessage("Review link unavailable", "This review link is no longer valid.", 404);
  const spaceId = `slack:${session.identity.slackChannelId}`;
  try {
    if (!(await deps.adapter.isChannelMember(spaceId, session.identity.slackUserId))) {
      await audit(deps, EVENT_DENIED, session.identity.slackUserId, spaceId, { reason: "not_member" });
      return genericDenied();
    }
  } catch (err) {
    deps.log?.(`[work-review] redemption membership lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    await audit(deps, EVENT_DENIED, session.identity.slackUserId, spaceId, { reason: "membership_unavailable" });
    return genericDenied();
  }
  deps.csrfTokens?.set(rawSession, rawCsrf);
  await audit(deps, EVENT_REDEEMED, session.identity.slackUserId, spaceId, { work_item_id_present: true });
  const response = new Response(null, { status: 303, headers: { location: "/work-review", "cache-control": "no-store" } });
  response.headers.set("set-cookie", `${WORK_REVIEW_COOKIE}=${rawSession}; Max-Age=${Math.floor(WORK_REVIEW_SESSION_TTL_MS / 1000)}; Secure; HttpOnly; SameSite=Lax; Path=/work-review`);
  return response;
}

async function readReview(deps: WorkReviewRouteDeps, req: Request): Promise<Response> {
  const current = await liveSession(deps, req);
  if (current === null) return cookieValue(req) === null ? genericSession() : genericDenied();
  const review = await projectWorkReview(deps, current.source.id);
  if (review === null) return genericDenied();
  const csrfToken = deps.csrfTokens?.get(current.raw);
  if (csrfToken === undefined) return genericSession();
  await audit(deps, EVENT_READ, current.session.identity.slackUserId, current.spaceId, { work_item_id_present: true });
  const html = renderWorkReview(review, { csrfToken, showForm: true });
  return new Response(html, { headers: htmlHeaders() });
}

async function continueReview(deps: WorkReviewRouteDeps, req: Request): Promise<Response> {
  const current = await liveSession(deps, req);
  if (current === null) return cookieValue(req) === null ? genericSession() : genericDenied();
  const csrfToken = deps.csrfTokens?.get(current.raw);
  if (csrfToken === undefined) return genericSession();
  const form = await req.formData().catch(() => null);
  if (form === null) return renderReviewMessage("Could not continue", "Please try again.", 400);
  const csrf = form.get(WORK_REVIEW_CSRF_FIELD);
  if (typeof csrf !== "string" || !equalDigest(csrf, current.session.csrfHash)) return genericDenied();
  const guidanceValue = form.get("guidance");
  if (guidanceValue !== null && typeof guidanceValue !== "string") return renderReviewMessage("Could not continue", "Please try again.", 400);
  const guidance = typeof guidanceValue === "string" ? guidanceValue : undefined;
  if (guidance !== undefined && guidance.trim().length > CONTINUATION_GUIDANCE_MAX_CHARS) {
    return renderReviewMessage("Could not continue", "Your guidance is too long.", 400);
  }
  try {
    const result = await continueWork(
      { store: deps.store, transcriptDir: deps.transcriptDir },
      { sourceId: current.source.id, requester: current.session.identity.slackUserId, spaceId: current.spaceId, guidance },
    );
    if (!result.existed) {
      await deps.adapter.postMessage(current.spaceId, "This work was continued using the completed work so far.");
    }
    const review = await projectWorkReview(deps, current.source.id);
    if (review === null) return genericDenied();
    const message = result.existed ? "This work was already continued." : "This work was continued using the completed work so far.";
    return new Response(renderWorkReview(review, { csrfToken, message, showForm: false }), { headers: htmlHeaders() });
  } catch (err) {
    await audit(deps, EVENT_CONTINUATION_FAILED, current.session.identity.slackUserId, current.spaceId, { work_item_id_present: true });
    deps.log?.(`[work-review] continuation failed: ${err instanceof Error ? err.message : String(err)}`);
    return renderReviewMessage("Work needs attention", "The work could not be continued. Try again.", 409);
  }
}

export function mountWorkReviewRoutes(deps: WorkReviewRouteDeps): WorkReviewRoutes {
  const routeDeps: WorkReviewRouteDeps = { ...deps, csrfTokens: new Map<string, string>() };
  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.startsWith("/work-review/redeem/")) {
        const encoded = url.pathname.slice("/work-review/redeem/".length);
        if (encoded.length === 0 || encoded.includes("/")) return renderReviewMessage("Review link unavailable", "This review link is no longer valid.", 404);
        let token: string;
        try { token = decodeURIComponent(encoded); } catch { return renderReviewMessage("Review link unavailable", "This review link is no longer valid.", 404); }
        return redeem(routeDeps, token);
      }
      if (url.pathname === "/work-review" && req.method === "GET") return readReview(routeDeps, req);
      if (url.pathname === "/work-review/continue" && req.method === "POST") return continueReview(routeDeps, req);
      return new Response("not found", { status: 404 });
    },
  };
}

export const createWorkReviewRoutes = mountWorkReviewRoutes;
