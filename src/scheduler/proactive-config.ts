import { parseYamlSubset } from "../yaml-subset";

/**
 * Reads the per-space proactive opt-in used by standups (#92) and reflections
 * (#93). Humans enable it in `spaces.policy_json` with:
 *
 *     proactive:
 *       standup: true
 *       reflection: true
 *
 * The YAML subset parser represents booleans as strings, so only the exact
 * scalar `true` enables a feature. Invalid policy data fails closed.
 */
export function proactiveEnabled(policyJson: string, feature: "standup" | "reflection"): boolean {
  try {
    const policy = parseYamlSubset(policyJson);
    const proactive = policy.proactive;
    if (typeof proactive !== "object" || Array.isArray(proactive)) return false;
    return proactive[feature] === "true";
  } catch {
    return false;
  }
}
