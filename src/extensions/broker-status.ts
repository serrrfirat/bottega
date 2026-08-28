import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";

/** Broker health projected from metadata-only credential endpoints. */
export type BrokerCredentialStatus =
  | { state: "active" }
  | { state: "disabled"; cause?: string }
  | { state: "missing" }
  | { state: "unknown" };

export type BrokerCredentialStatusInput = {
  brokerCredentialId: number;
  /** Broker provider namespace, usually the connection's vault_provider. */
  provider: string;
};

export type BrokerCredentialStatusReader = (input: BrokerCredentialStatusInput) => Promise<BrokerCredentialStatus>;

type BrokerStatusClient = Pick<AuthBrokerClient, "fetchSnapshot" | "listDisabledCredentials">;

export type BrokerStatusConfig = { url: string; token: string };

/**
 * Create the production broker status seam. Only the projected state leaves
 * this function; snapshot credential payloads are never returned or logged.
 */
export function createBrokerCredentialStatusReader(
  clientFactory: (config: BrokerStatusConfig) => BrokerStatusClient = (config) =>
    new AuthBrokerClient({ url: config.url, token: config.token }),
  resolveConfig: () => Promise<BrokerStatusConfig | null> = resolveAuthBrokerConfig,
): BrokerCredentialStatusReader {
  return async ({ brokerCredentialId, provider }) => {
    try {
      const config = await resolveConfig();
      if (!config) return { state: "unknown" };
      const client = clientFactory({ url: config.url, token: config.token });
      const [snapshot, disabled] = await Promise.all([
        client.fetchSnapshot(),
        client.listDisabledCredentials(provider),
      ]);
      if (snapshot.status !== 200) return { state: "unknown" };
      if (snapshot.snapshot.credentials.some((entry) => entry.id === brokerCredentialId && entry.provider === provider)) {
        return { state: "active" };
      }
      if (disabled.some((entry) => entry.id === brokerCredentialId && entry.provider === provider)) {
        return { state: "disabled" };
      }
      return { state: "missing" };
    } catch {
      return { state: "unknown" };
    }
  };
}
