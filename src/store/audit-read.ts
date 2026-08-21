import { z } from "zod";
import type { AuditRow } from "./db";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AuditPayloadSchema = z.record(z.string(), z.unknown());
const TierSchema = z.enum(["read", "write", "exec"]);
const DecisionSchema = z.enum(["allow", "deny", "ask-human"]);
const ScopeSchema = z.enum(["org", "personal"]);

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
export function auditReasonCategory(reason: unknown): AuditReasonCategory | undefined {
  if (typeof reason !== "string") return undefined;
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

function safeName(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : undefined;
}

/** Event-specific, allowlisted audit DTO. It never returns the stored payload or arbitrary payload values. */
export function summarizeAuditRow(row: AuditRow): AuditSummary {
  const event = safeName(row.event_type) ?? "unknown";
  const actor = safeName(row.actor) ?? "unknown";
  const space = row.space_id === null ? null : safeName(row.space_id) ?? null;
  const summary: AuditSummary = { id: row.id, ts: row.ts, event, space, actor };
  let payload: Record<string, unknown> = {};
  try {
    const parsed = AuditPayloadSchema.safeParse(JSON.parse(row.payload));
    if (parsed.success) payload = parsed.data;
  } catch {
    return summary;
  }

  const tool = safeName(payload.tool);
  if (tool !== undefined) summary.tool = tool;
  const extension = safeName(payload.extension);
  if (extension !== undefined) summary.extension = extension;
  const provider = safeName(payload.provider);
  if (provider !== undefined) summary.provider = provider;
  const tier = TierSchema.safeParse(payload.tier);
  if (tier.success) summary.tier = tier.data;
  const decision = DecisionSchema.safeParse(payload.decision);
  if (decision.success) summary.decision = decision.data;
  const reason = auditReasonCategory(payload.reason);
  if (reason !== undefined) summary.reason = reason;
  if (typeof payload.approved === "boolean") summary.approved = payload.approved;
  if (payload.approver === null) summary.approver = null;
  else {
    const approver = safeName(payload.approver);
    if (approver !== undefined) summary.approver = approver;
  }
  const scope = ScopeSchema.safeParse(payload.scope);
  if (scope.success) summary.scope = scope.data;
  const status = safeName(payload.status ?? payload.result);
  if (status !== undefined) summary.status = status;
  return summary;
}
