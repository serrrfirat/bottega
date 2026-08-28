import { describe, expect, test } from "bun:test";
import { createBrokerCredentialStatusReader, type BrokerStatusConfig } from "./broker-status";

const config: BrokerStatusConfig = { url: "http://broker.test", token: "not-returned" };

function reader(snapshotIds: number[], disabledIds: number[], fail = false) {
  const client = {
    fetchSnapshot: async () => {
      if (fail) throw new Error("broker unreachable");
      return {
        status: 200 as const,
        snapshot: {
          credentials: snapshotIds.map((id) => ({ id, provider: "fixture.weather", credential: { type: "api_key", key: "secret" }, identityKey: null })),
        },
      } as never;
    },
    listDisabledCredentials: async () => {
      if (fail) throw new Error("broker unreachable");
      return disabledIds.map((id) => ({ id, provider: "fixture.weather", type: "api_key" as const, cause: "invalid_grant" }));
    },
  };
  return createBrokerCredentialStatusReader((_config: BrokerStatusConfig) => client, async () => config);
}

describe("broker credential status", () => {
  test("projects active, disabled, and missing references without returning credential fields", async () => {
    const status = reader([11], [12]);
    await expect(status({ brokerCredentialId: 11, provider: "fixture.weather" })).resolves.toEqual({ state: "active" });
    await expect(status({ brokerCredentialId: 12, provider: "fixture.weather" })).resolves.toEqual({ state: "disabled" });
    await expect(status({ brokerCredentialId: 13, provider: "fixture.weather" })).resolves.toEqual({ state: "missing" });
  });

  test("unconfigured or unreachable broker is unknown rather than disabled", async () => {
    const unconfigured = createBrokerCredentialStatusReader(() => {
      throw new Error("client should not be created");
    }, async () => null);
    await expect(unconfigured({ brokerCredentialId: 11, provider: "fixture.weather" })).resolves.toEqual({ state: "unknown" });

    const unreachable = reader([], [], true);
    await expect(unreachable({ brokerCredentialId: 11, provider: "fixture.weather" })).resolves.toEqual({ state: "unknown" });
  });
});
