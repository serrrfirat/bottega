/**
 * Audit event_type vocabulary — the single source of truth for every event
 * the bottega processes write to the audit trail (issue #33). One event
 * name = one payload schema: writers import these constants instead of
 * spelling literals, so a schema change is a rename in one place.
 *
 * `approval.requested` is reserved for policy-tool approvals (payload
 * {tool, reason}); delivery announcements use `delivery.requested`
 * (payload {id, pr_url, summary}) — the two never share an event name.
 */
/** Work item created (payload {id, requester}). */
export const WORK_ITEM_CREATED_EVENT = "work_item.created";
/** Work item state transition (payload {from, to, by}). */
export const WORK_ITEM_TRANSITION_EVENT = "work_item.transition";
/** Executor failure landing an item in blocked (payload {id, error}). */
export const WORK_ITEM_FAILED_EVENT = "work_item.failed";
/** Executor marker: PR open, delivery approval pending (payload {id, pr_url, summary}). */
export const DELIVERY_PENDING_EVENT = "work_item.delivery_pending";
/** Server announcement of a pending delivery (payload {id, pr_url, summary}). */
export const DELIVERY_REQUESTED_EVENT = "delivery.requested";
/** Policy gate decision (payload {tool, tier, decision, reason, args}). */
export const POLICY_DECISION_EVENT = "policy.decision";
/** Human approval asked for a policy-prompted tool call (payload {tool, reason}). */
export const APPROVAL_REQUESTED_EVENT = "approval.requested";
/** Human approval resolved (payload {tool, approved, approver}). */
export const APPROVAL_RESOLVED_EVENT = "approval.resolved";
/** Memory saved (payload {scope, principal, id, content_hash}). */
export const MEMORY_WRITE_EVENT = "memory.write";
/** Org/space settings changed (payload {scope, space?, actor, before, after}). */
export const SETTINGS_CHANGED_EVENT = "settings.changed";
/** Extension credential resolved through the scope ladder (payload {provider, scope, identity_key, credential_id, broker_credential_id}). */
export const EXTENSION_CREDENTIAL_RESOLVED_EVENT = "extension.credential_resolved";
/** Extension connected through the connect capability (payload {extension, scope, owner}). */
export const EXTENSION_CONNECTED_EVENT = "extension.connected";
/**
 * Extension tool call executed through the runtime (issue #53) — payload
 * {extension, tool, actor, credential_id, decision}; decision is
 * "allow" | "deny" | "error" (credential_id null unless the ladder resolved
 * one). Written on EVERY runtime call, before or without execution when the
 * gate or the ladder blocks it.
 */
export const EXTENSION_CALL_EVENT = "extension.call";
/** Inbound message dropped (payload {reason, ts}). */
export const MESSAGE_DROPPED_EVENT = "message_dropped";
/** Digest-on-idle summarization failed (payload {reason}); the space still disposes. */
export const DIGEST_FAILED_EVENT = "digest.failed";
/** Per-space model settings changed (payload {before, after, by}). */
export const MODEL_SETTINGS_CHANGED_EVENT = "model.settings_changed";
/** Session model role switched for the next turn (payload {role, model, thinking_level, by}). */
export const MODEL_SWITCHED_EVENT = "model.switched";
/**
 * Admin tools (issue #73): every invocation of the four setup/onboarding
 * surfaces appends its own `admin.*` row, on top of the gate's
 * `policy.decision` row. Payloads stay compact (no full dumps).
 */
/** Extension catalog browsed or drafted (payload {action, spec?, query?, written_to?}). */
export const ADMIN_CATALOG_BROWSER_EVENT = "admin.catalog_browser";
/** Stack health check run (payload {ok, services: [{service, status}]}). */
export const ADMIN_STACK_HEALTH_EVENT = "admin.stack_health";
/** Deploy identity read (payload {image_tag, commit, uptime_seconds, config_dir}). */
export const ADMIN_DEPLOY_INFO_EVENT = "admin.deploy_info";
/** First-run wizard run (payload {ok, checks: [{name, ok}]}). */
export const ADMIN_FIRST_RUN_EVENT = "admin.first_run_wizard";
/**
 * Proactive onboarding (issue #116): boot-time guided setup post
 * (payload {posted, checks: [{name, ok}]}; the onboarding space id rides
 * the top-level space_id field). Never carries secrets.
 */
export const ADMIN_ONBOARDING_BOOT_EVENT = "admin.onboarding_boot";
/**
 * In-conversation onboarding nudge appended to a setup-blocked turn
 * (payload {checks: [{name, ok}]}; space_id top-level). Written only when
 * the nudge actually fires (dedupe suppressed repeats are not audited).
 */
export const ADMIN_ONBOARDING_NUDGE_EVENT = "admin.onboarding_nudge";
