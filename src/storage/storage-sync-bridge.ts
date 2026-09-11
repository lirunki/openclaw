import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { StorageSyncBridgeClient } from "./storage-sync-bridge-client.js";
import type { StorageSyncBridgeDomain } from "./storage-sync-bridge-protocol.js";

export {
  StorageSyncBridgeOutcomeUnknownError,
  StorageSyncBridgeRemoteError,
  StorageSyncBridgeTimeoutError,
} from "./storage-sync-bridge-client.js";

function createDefaultClient(): StorageSyncBridgeClient {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.storageSyncBridge);
  return new StorageSyncBridgeClient({
    workerUrl,
    workerExecArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
  });
}

const defaultClient = createDefaultClient();

export function requestStorageSyncBridge<T>(params: {
  domain: StorageSyncBridgeDomain;
  payload: unknown;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}): T {
  return defaultClient.request<T>(params);
}

export async function closeStorageSyncBridge(): Promise<void> {
  await defaultClient.close();
}
