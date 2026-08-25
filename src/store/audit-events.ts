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
/** Work item created (payload {id, requester, assignee}). */
export const WORK_ITEM_CREATED_EVENT = "work_item.created";
/** Space skill summaries listed (payload {skills:[{name,source_tier,revision}]}). */
export const SPACE_SKILL_LISTED_EVENT = "space_skill.listed";
/**
 * M4 proactive seed (issue #356): a space skill (procedure) went stale —
 * created/updated long ago and never read since (payload {name,
 * age_days}; space_id top-level). One alert per procedure until its next
 * revision; the row doubles as the dedupe marker.
 */
export const PROCEDURE_STALE_ALERTED_EVENT = "procedure.stale_alerted";
/** Effective space skill read (payload {name,source_tier,revision,companion_files}); never bodies. */
export const SPACE_SKILL_READ_EVENT = "space_skill.read";
/** Space-tier skill created (payload {name,revision,companion_files}); never bodies. */
export const SPACE_SKILL_CREATED_EVENT = "space_skill.created";
/** Space-tier skill replaced (payload {name,previous_revision,revision,companion_files}); never bodies. */
export const SPACE_SKILL_UPDATED_EVENT = "space_skill.updated";
/** Space-tier skill deleted (payload {name,revision,revealed?}); never bodies. */
export const SPACE_SKILL_DELETED_EVENT = "space_skill.deleted";
/** Work item state transition (payload {from, to, by}). */
export const WORK_ITEM_TRANSITION_EVENT = "work_item.transition";
/** Queue read (payload {state?, count}; space_id top-level). */
export const WORK_ITEM_LIST_EVENT = "work_item.list";
/** Executor failure landing an item in blocked (payload {id, error}). */
export const WORK_ITEM_FAILED_EVENT = "work_item.failed";
/**
 * Explicit operator purge of a retained failed workspace (issue #310):
 * payload {id, workspace, decision, reason?}. `decision` is requested,
 * removed, or refused; marker contents and credentials never enter it.
 */
export const WORKSPACE_PURGE_EVENT = "workspace.purge";
/** Executor marker: PR open, delivery approval pending (payload {id, pr_url, summary}). */
export const DELIVERY_PENDING_EVENT = "work_item.delivery_pending";
/**
 * Executor applied a work item's per-task model pin (issue #185): what the
 * session actually switched to (payload {id, role, model, thinking_level,
 * applied, by}); `applied: false` means the switch was a no-op (e.g. a role
 * ref with no space settings to resolve it).
 */
export const WORK_ITEM_PIN_APPLIED_EVENT = "work_item.model_pin_applied";
/** Server announcement of a pending delivery (payload {id, pr_url, summary}). */
export const DELIVERY_REQUESTED_EVENT = "delivery.requested";
/**
 * Human resolution of a pending delivery (payload {id, approved, approver}).
 * Written by the server's block-actions handler; the executor's onDelivery
 * wait reads it as the approval decision (issue #149). Never shares
 * `delivery.requested`'s event name (issue #33: one payload schema per
 * event name).
 */
export const DELIVERY_RESOLVED_EVENT = "delivery.resolved";
/**
 * Completed delivery (payload {id, kind, url?, summary}). This never shares
 * `delivery.requested`'s event name because issue #33 requires one payload
 * schema per audit event name.
 */
export const DELIVERY_COMPLETED_EVENT = "delivery.completed";
/** Policy gate decision (payload {tool, tier, decision, reason, args}). */
export const POLICY_DECISION_EVENT = "policy.decision";
/** Human approval asked for a policy-prompted tool call (payload {tool, reason}). */
export const APPROVAL_REQUESTED_EVENT = "approval.requested";
/** Human approval resolved (payload {tool, approved, approver}). */
export const APPROVAL_RESOLVED_EVENT = "approval.resolved";
/** A pending approval was nudged after sitting unanswered (payload {tool, space_id}; issue #109). */
export const APPROVAL_NUDGED_EVENT = "approval.nudged";
/** Memory saved (payload {scope, principal, id, content_hash}). */
export const MEMORY_WRITE_EVENT = "memory.write";
/** Automatic memory extraction completed (payload {scope, count}; actor = system). */
export const MEMORY_AUTO_SAVED_EVENT = "memory.auto_saved";
/**
 * Memory forgotten with a durable tombstone (issue #163): payload
 * {scope, id, source} — the entry id and provenance source, never content.
 * The tombstone itself is the durable record; this audit row joins the
 * forget to its requester.
 */
export const MEMORY_FORGET_EVENT = "memory.forget";
/**
 * Permission-aware memory recall (issue #137): payload {scopes:[{scope,key,count}]}
 * with actor = requester principal, space_id = the space — scopes only, never
 * query or memory content. Appended after every successful recall (even zero
 * results) by the derived-scope recall layer.
 */
export const MEMORY_RECALLED_EVENT = "memory.recalled";
/** Observer read/post/failure (payload {scope, metadata, count}, {pulse_space, posted}, or {error}). */
export const OBSERVER_READ_EVENT = "observer.read";
/** Scheduler job created (payload {id, invocation_id, before:null, after}). */
export const SCHEDULER_JOB_CREATED_EVENT = "scheduler.job_created";
/** Scheduler job deleted (payload {id, invocation_id, before, after:null}). */
export const SCHEDULER_JOB_DELETED_EVENT = "scheduler.job_deleted";
/** Scheduler job fields changed (payload {invocation_id, before, after}). */
export const SCHEDULER_JOB_UPDATED_EVENT = "scheduler.job_updated";
/** Scheduler job paused (payload {invocation_id, before, after}). */
export const SCHEDULER_JOB_PAUSED_EVENT = "scheduler.job_paused";
/** Scheduler job resumed (payload {invocation_id, before, after}). */
export const SCHEDULER_JOB_RESUMED_EVENT = "scheduler.job_resumed";
/** A manual ordinary execution was durably enqueued (payload {invocation_id, before, after}). */
export const SCHEDULER_RUN_REQUESTED_EVENT = "scheduler.run_requested";
/** Scheduler invocation completed (payload {id, action, invocation_id, source, result, scheduled_for?}). */
export const SCHEDULER_FIRE_EVENT = "scheduler.fire";
/** Scheduler skipped an occurrence missed while down (payload {id, action, scheduled_for}). */
export const SCHEDULER_MISSED_EVENT = "scheduler.missed";
/** Scheduler could not run a handler (payload {id, action, error}). */
export const SCHEDULER_ERROR_EVENT = "scheduler.error";
/** Object attached from an inbound message (payload {id, name, mime, size, sha256, by}). */
export const OBJECT_ATTACHED_EVENT = "object.attached";
/** Object created by an agent tool (payload {id, name, mime, size, by}). */
export const OBJECT_CREATED_EVENT = "object.created";
/**
 * A Slack voice note could not be transcribed (issue #96): payload
 * {ts, reason} — the clip's message ts and a short failure reason (e.g.
 * `unsupported_mime`, `too_large`, `not_configured`, `stt_error`,
 * `empty_transcript`). WITHOUT inbox, no agent turn runs; the failure is
 * surfaced as an explicit user-visible reply (never a silent skip).
 */
export const VOICE_NOTE_FAILED_EVENT = "voice_note.failed";
/** Org/space settings changed (payload {scope, space?, actor, before, after}). */
export const SETTINGS_CHANGED_EVENT = "settings.changed";
/** Extension credential resolved through the scope ladder (payload {provider, scope, identity_key, credential_id, broker_credential_id}). */
export const EXTENSION_CREDENTIAL_RESOLVED_EVENT = "extension.credential_resolved";
/** Extension connected through the connect capability (payload {extension, scope, owner}). */
export const EXTENSION_CONNECTED_EVENT = "extension.connected";
/** Connection lifecycle phase (payload {connection_id, phase, revision, status}). */
export const EXTENSION_CONNECTION_PHASE_EVENT = "extension.connection_phase";
/** Redacted connection list/inspection (payload {action, count?, connection_id?}). */
export const EXTENSION_CONNECTION_READ_EVENT = "extension.connection_read";
/**
 * Deployment-level static OAuth client provisioned (issue #288): payload
 * {extension, scope, owner, status} — metadata ONLY, never client values
 * (the pre-registered client id/secret live in the vault, not the audit
 * trail). Written by the one-time upload POST's static-client leg after a
 * successful policy-gated store.
 */
export const STATIC_CLIENT_PROVISIONED_EVENT = "static_client.provisioned";
/**
 * Boot secret provisioned into the vault (issue #201): payload {secret,
 * scope, owner}. Written by the connect_upload_link endpoint when a boot
 * secret (Slack token / provider key) is stored as the provider's api_key
 * row — the row the boot-time seed reads. There is no extension/registry
 * row for boot secrets; the vault row is the whole record.
 */
export const SECRET_PROVISIONED_EVENT = "secret.provisioned";
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
/**
 * Inbound message received (payload {ts}; actor = sender). Written at
 * receipt — before the session cold-start — so the trail can join receipt
 * to reply (issue #119). Never carries message text (secrets stay out).
 */
export const MESSAGE_RECEIVED_EVENT = "message.in";
/**
 * Agent reply delivered (payload {latency_ms, phrase_ms?}; actor = system).
 * Written when a real reply (or an error) replaces the thinking phrase;
 * latency_ms is receipt → reply, phrase_ms is receipt → phrase posted.
 * Empty completions and churn messages are retry bookkeeping, not replies,
 * and write no row (issue #119).
 */
export const MESSAGE_REPLIED_EVENT = "message.reply";
/**
 * A Slack Stop control stopped the space's active live turn (issue #315):
 * payload {by, stopped} — `by` is the Slack user who clicked Stop,
 * `stopped` is true when an in-flight turn was actually aborted, false
 * when the Stop was a no-op (no live/in-flight turn to stop). Payload is
 * minimal metadata only — never message text or reasoning content.
 */
export const TURN_STOP_EVENT = "turn.stop";
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
/**
 * Ingest dispatch via the WEBHOOK leg (issue #57): a validated inbound
 * webhook event became a work item + Slack post
 * (payload {provider, event_type, url?, work_item_id, space_id}).
 */
export const INGEST_WEBHOOK_DISPATCH_EVENT = "ingest.webhook.dispatch";
/**
 * Ingest dispatch via the POLLING leg (issue #57): a validated polled
 * event became a work item + Slack post
 * (payload {provider, event_type, url?, work_item_id, space_id}).
 */
export const INGEST_POLL_DISPATCH_EVENT = "ingest.poll.dispatch";
/**
 * Ingest event REJECTED at the webhook leg (issue #57): validation or
 * signature failure — nothing was created or posted
 * (payload {provider, event_type, reason}).
 */
export const INGEST_WEBHOOK_REJECTED_EVENT = "ingest.webhook.rejected";
/**
 * Ingest event REJECTED at the polling leg (issue #57): validation
 * failure — nothing was created or posted
 * (payload {provider, event_type, reason}).
 */
export const INGEST_POLL_REJECTED_EVENT = "ingest.poll.rejected";
/**
 * A worker claim loop took a lease on a job (epic #170): the job moved
 * from dispatched to claimed (payload {id, kind, space?}; actor = the
 * worker). Written by the worker on a successful atomic claim.
 */
export const JOB_CLAIMED_EVENT = "job.claimed";
/**
 * A job completed successfully and its outbox row was written (epic #170):
 * payload {id, kind, space?}; actor = the worker. Written by the worker
 * claim loop's completion path, before/with the outbox write.
 */
export const JOB_COMPLETED_EVENT = "job.completed";
/**
 * A job exhausted its bounded requeue (epic #170): payload {id, kind,
 * space?, error}; actor = the worker. Terminal — the job is not retried.
 */
export const JOB_FAILED_EVENT = "job.failed";
/**
 * A job with no live worker within its TTL (epic #170): payload {id, kind,
 * space?}; actor = system. Emitted by the claim-side unclaimed sweep (a
 * dispatched job never claimed) and by the outbox nudge (a completed job's
 * outbox row never consumed within the TTL) — the fail-loud guarantee that
 * a silently never-posting job surfaces.
 */
export const JOB_UNCLAIMED_EVENT = "job.unclaimed";
/**
 * An outbox row was posted by the server post seam (epic #170): payload
 * {id, kind, space?}; actor = the server. Written after the seam's
 * external post succeeds; the outbox row itself is the dedupe key.
 */
export const OUTBOX_POSTED_EVENT = "outbox.posted";
/**
 * An outbox row could not be posted by the server post seam (epic #170):
 * payload {id, kind, space?, error}; actor = the server. Written when the
 * seam's external post fails.
 */
export const OUTBOX_FAILED_EVENT = "outbox.failed";
/** Filtered operator audit read (payload is the allowlisted filter, never results/cursor). */
export const AUDIT_READ_EVENT = "audit.read";
/** Side-effect-free policy/credential explanation (payload {tool, space, decision, tier}). */
export const POLICY_EXPLAINED_EVENT = "policy.explained";
/** Successfully published operator Home read (payload {revision}; no rendered rows). */
export const OPERATOR_HOME_READ_EVENT = "operator.home_read";
/** Weekly governance digest delivered (payload contains aggregate counts only). */
export const GOVERNANCE_DIGEST_POSTED_EVENT = "governance_digest.posted";
/** Weekly governance digest could not be delivered (payload {reason}; audit redaction still applies). */
export const GOVERNANCE_DIGEST_FAILED_EVENT = "governance_digest.failed";
/**
 * Weekly memory review delivered (issue #163): payload carries aggregate
 * counts (recallable, forgotten) + next_review_date — never memory content
 * and never the full review text.
 */
export const MEMORY_REVIEW_POSTED_EVENT = "memory.review_posted";
/** Weekly memory review could not be delivered (payload {reason}; never content). */
export const MEMORY_REVIEW_FAILED_EVENT = "memory.review_failed";
/**
 * One model completion's token usage (issue #103): the usage meter's
 * append-only source. `space_id` = the space, `actor` = the user principal,
 * payload {model, tokensIn, tokensOut}. Tokens are recorded nowhere else;
 * zero-cost turns still write a row so the turn count stays accurate
 * (payload redaction + cap still apply).
 */
export const USAGE_TURN_EVENT = "usage.turn";
/**
 * REST API call rejected at auth (issue #100): payload {method, path};
 * actor api:default, space_id null. A missing or non-matching bearer token
 * never reaches a handler — the denial is the audited record.
 */
export const API_AUTH_DENIED_EVENT = "api.auth_denied";
/** REST API space list (payload {count}; actor api:default). */
export const API_SPACES_LISTED_EVENT = "api.spaces_listed";
/** REST API work-item list (payload {count, space?}; space_id top-level when filtered). */
export const API_WORK_ITEMS_LISTED_EVENT = "api.work_items_listed";
/**
 * REST API audit read (payload {event_type?, space?, since?, limit?} — the
 * filters, never results or a cursor). Written AFTER the query so the read
 * never self-references its own row.
 */
export const API_AUDIT_READ_EVENT = "api.audit_read";
/** REST API work-item create (payload {id, requester}; actor api:default). */
export const API_WORK_ITEM_CREATED_EVENT = "api.work_item_created";
/** REST API org-graph projection read (issue #357): payload {space?, since?, nodes, edges} — counts only; node labels/contents never enter the audit trail. */
export const API_GRAPH_PROJECTED_EVENT = "api.graph_projected";
