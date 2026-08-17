import { z } from "zod";

/** The `proactive` block inside `spaces.policy_json`, decoded at the boundary. */
const ProactivePolicySchema = z.object({
  proactive: z
    .object({
      standup: z.boolean().optional(),
      reflection: z.boolean().optional(),
    })
    .optional(),
});

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
    const policy = ProactivePolicySchema.parse(JSON.parse(policyJson));
    return policy.proactive?.[feature] === true;
  } catch {
    return false;
  }
}
