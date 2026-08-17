/**
 * Reads the per-space proactive opt-in used by standups (#92) and reflections
 * (#93). Humans enable it in `spaces.policy_json` (a JSON column — every
 * writer uses JSON.stringify) with:
 *
 *     {"proactive": {"standup": true, "reflection": true}}
 *
 * Only the exact boolean `true` enables a feature. Malformed JSON, absent
 * keys, and non-boolean shapes fail closed (feature disabled).
 */
export function proactiveEnabled(policyJson: string, feature: "standup" | "reflection"): boolean {
  try {
    const policy: unknown = JSON.parse(policyJson);
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return false;
    const proactive = (policy as Record<string, unknown>).proactive;
    if (typeof proactive !== "object" || proactive === null || Array.isArray(proactive)) return false;
    return (proactive as Record<string, unknown>)[feature] === true;
  } catch {
    return false;
  }
}
