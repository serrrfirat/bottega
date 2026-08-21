import { z } from "zod";
import type { AuditRow } from "./db";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SafeNameSchema = z.string().regex(SAFE_NAME);
const TierSchema = z.enum(["read", "write", "exec"]);
const DecisionSchema = z.enum(["allow", "deny", "ask-human"]);
const ScopeSchema = z.enum(["org", "personal"]);
const AuditPayloadSchema = z.object({
  tool: SafeNameSchema.optional().catch(undefined),
  extension: SafeNameSchema.optional().catch(undefined),
  provider: SafeNameSchema.optional().catch(undefined),
  tier: TierSchema.optional().catch(undefined),
  decision: DecisionSchema.optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  approved: z.boolean().optional().catch(undefined),
  approver: z.union([SafeNameSchema, z.null()]).optional().catch(undefined),
  scope: ScopeSchema.optional().catch(undefined),
  status: SafeNameSchema.optional().catch(undefined),
  result: SafeNameSchema.optional().catch(undefined),
});

type AuditPayload = z.infer<typeof AuditPayloadSchema>;

export type AuditReasonCategory =
  | "policy_denied"
  | "unknown_tool"
  | "human_approval_required"
  | "allowed_by_policy"
  | "auto_approved"
  | "preapproved"
  | "extension_denied"
  | "invalid_policy"
  | "approval_denied"
  | "other";

/** Stable reason codes for operator reads. Raw policy/error strings never cross the read boundary. */
export function auditReasonCategory(reason: string): AuditReasonCategory | undefined {
  if (reason === "policy denies the tool") return "policy_denied";
  if (reason === "tool is not in the known tool table") return "unknown_tool";
  if (reason === "policy requires a human prompt" || reason === "exec-tier tool requires human approval") {
    return "human_approval_required";
  }
  if (reason === "allowed by policy") return "allowed_by_policy";
  if (reason.startsWith("auto-approved by policy")) return "auto_approved";
  if (reason.startsWith("pre-approved executor session")) return "preapproved";
  if (reason.startsWith("extension '") && (reason.includes(" is denied") || reason.includes("allowlist"))) {
    return "extension_denied";
  }
  if (reason.startsWith("policy invalid:")) return "invalid_policy";
  if (reason === "approval denied") return "approval_denied";
  return "other";
}

export interface AuditSummary {
  id: number;
  ts: number;
  event: string;
  space: string | null;
  actor: string;
  tool?: string;
  extension?: string;
  provider?: string;
  tier?: "read" | "write" | "exec";
  decision?: "allow" | "deny" | "ask-human";
  reason?: AuditReasonCategory;
  approved?: boolean;
  approver?: string | null;
  scope?: "org" | "personal";
  status?: string;
}

function safeName(value: string): string | undefined {
  const parsed = SafeNameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Event-specific, allowlisted audit DTO. It never returns the stored payload or arbitrary payload values. */
export function summarizeAuditRow(row: AuditRow): AuditSummary {
  const event = safeName(row.event_type) ?? "unknown";
  const actor = safeName(row.actor) ?? "unknown";
  const space = row.space_id === null ? null : safeName(row.space_id) ?? null;
  const summary: AuditSummary = { id: row.id, ts: row.ts, event, space, actor };
  let payload: AuditPayload;
  try {
    const parsed = AuditPayloadSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success) return summary;
    payload = parsed.data;
  } catch {
    return summary;
  }

  if (payload.tool !== undefined) summary.tool = payload.tool;
  if (payload.extension !== undefined) summary.extension = payload.extension;
  if (payload.provider !== undefined) summary.provider = payload.provider;
  if (payload.tier !== undefined) summary.tier = payload.tier;
  if (payload.decision !== undefined) summary.decision = payload.decision;
  if (payload.reason !== undefined) summary.reason = auditReasonCategory(payload.reason);
  if (payload.approved !== undefined) summary.approved = payload.approved;
  if (payload.approver !== undefined) summary.approver = payload.approver;
  if (payload.scope !== undefined) summary.scope = payload.scope;
  const status = payload.status ?? payload.result;
  if (status !== undefined) summary.status = status;
  return summary;
}
