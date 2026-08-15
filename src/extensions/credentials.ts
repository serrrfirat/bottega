/**
 * Extension credential resolution ladder (issue #51).
 *
 * Registry rows (src/store) hold METADATA only — provider, broker identity
 * key, owner, scope — plus a reference to the secret's row in the OMP auth
 * broker. Secrets never enter our store. This module picks WHICH registry
 * row applies for a tool call; fetching the secret payload from the broker
 * and scoping the broker client to that account is the #53 runtime's job
 * (see {@link accountPoolFor}).
 *
 * The ladder never guesses: when `auto` cannot resolve a credential it
 * returns an ask signal instead of picking a scope silently.
 */
import type { ExtensionCredential } from "../store/db";
import type { Store } from "../store/db";
import { EXTENSION_CREDENTIAL_RESOLVED_EVENT } from "../store/audit-events";

export type CallScope = "org" | "me" | "auto";

/**
 * The effective space policy as seen by the ladder. The caller derives
 * `orgUsageAllowed` from the space's policy (org floor + overlay); the
 * policy knob itself lands with the extension-policy surface (#52/#53).
 */
export type SpacePolicyForCredentials = {
  /** Whether the space policy allows using org-scoped credentials. */
  orgUsageAllowed: boolean;
};

export type CredentialResolution =
  | { kind: "credential"; credential: ExtensionCredential }
  | { kind: "ask"; reason: string }
  | { kind: "error"; message: string };

export type ResolveCredentialInput = {
  callScope: CallScope;
  /** Principal asking for the credential (Slack user id). */
  caller: string;
  /** Extension provider id, e.g. "github". */
  provider: string;
  spacePolicy: SpacePolicyForCredentials;
  /**
   * Registry lookup: personal lookups are pre-filtered to the caller by the
   * implementation, so the ladder never sees other people's rows.
   */
  findCredential: (scope: "org" | "personal", owner: string | null) => ExtensionCredential | null;
};

/**
 * The resolution ladder:
 * - `org`  → the org-scoped credential for the provider (missing → error).
 * - `me`   → the caller's personal credential (missing → error).
 * - `auto` → org when the space policy allows org usage, else the caller's
 *            personal credential, else ASK — never a guess.
 */
export function resolveCredential(input: ResolveCredentialInput): CredentialResolution {
  const { callScope, caller, provider, spacePolicy, findCredential } = input;
  if (callScope === "org") {
    const credential = findCredential("org", null);
    if (!credential) return { kind: "error", message: `connect ${provider} as an organization` };
    return { kind: "credential", credential };
  }
  if (callScope === "me") {
    const credential = findCredential("personal", caller);
    if (!credential) return { kind: "error", message: `connect your ${provider} account` };
    return { kind: "credential", credential };
  }
  // auto
  if (spacePolicy.orgUsageAllowed) {
    const org = findCredential("org", null);
    if (org) return { kind: "credential", credential: org };
  }
  const personal = findCredential("personal", caller);
  if (personal) return { kind: "credential", credential: personal };
  const orgHint = spacePolicy.orgUsageAllowed
    ? `org usage is allowed by this space's policy but no ${provider} credential is connected as an organization`
    : `org usage is not allowed by this space's policy`;
  return {
    kind: "ask",
    reason: `no ${provider} credential is available (${orgHint} and no personal ${provider} account for ${caller}) — ask which account to use`,
  };
}

/**
 * Records a successful resolution on the audit trail (issue #51): the actor
 * column carries the caller; the payload carries the registry credential id
 * and the broker credential id it resolved to.
 */
export async function recordCredentialResolution(
  store: Pick<Store, "appendAudit">,
  input: { actor: string; spaceId?: string | null; credential: ExtensionCredential },
): Promise<void> {
  await store.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT,
    payload: JSON.stringify({
      provider: input.credential.provider,
      scope: input.credential.scope,
      identity_key: input.credential.identity_key,
      credential_id: input.credential.id,
      broker_credential_id: input.credential.broker_credential_id,
    }),
  });
}

/**
 * Account-pool seam (issue #51): the OMP auth broker lets trusted clients
 * restrict which OAuth identities they see via an account pool — a
 * provider → identity-key map. At runtime (#53) the resolved credential is
 * mapped into the pool so the broker client only ever sees that account:
 *
 * - programmatic: pass the pool as `accountPool` to
 *   `discoverAuthStorage()` / `RemoteAuthCredentialStore` (takes precedence
 *   over the file); or
 * - file: write this JSON to the path named by `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`
 *   (loaded by `loadAuthBrokerAccountPool`).
 *
 * API-key credentials are never filtered by the pool; the identity key is
 * still recorded for audit and harmless to include.
 */
export function accountPoolFor(provider: string, identityKey: string): Record<string, string[]> {
  return { [provider]: [identityKey] };
}
