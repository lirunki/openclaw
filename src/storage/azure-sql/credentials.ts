import { DeviceCodeCredential } from "@azure/identity";
import type { SecretRef } from "../../config/types.secrets.js";
import type { AzureSqlTokenCredential } from "./runtime.js";

export type AzureSqlSecretResolver = (ref: SecretRef) => Promise<string>;

export function createAzureSqlDeviceCodeCredential(
  options: {
    tenantId?: string;
    writePrompt?: (message: string) => void;
  } = {},
): AzureSqlTokenCredential {
  const credential = new DeviceCodeCredential({
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    userPromptCallback: (info) => {
      (options.writePrompt ?? console.error)(info.message);
    },
  });
  return credential;
}

/**
 * Adapts OpenClaw's secret ownership boundary to the Azure SQL token contract.
 * The resolver is invoked per token request so credential refresh remains owned by the
 * configured secret provider rather than by the storage layer.
 */
export function createAzureSqlSecretCredential(
  ref: SecretRef,
  resolveSecret: AzureSqlSecretResolver,
): AzureSqlTokenCredential {
  return {
    async getToken() {
      const token = (await resolveSecret(ref)).trim();
      if (!token) {
        throw new Error("Azure SQL credential resolver returned an empty token");
      }
      return {
        token,
        // Secret-backed tokens do not expose expiry metadata through the SecretRef contract.
        // Refresh on the next driver request instead of persisting or logging the token.
        expiresOnTimestamp: Date.now() + 60_000,
      };
    },
  };
}
