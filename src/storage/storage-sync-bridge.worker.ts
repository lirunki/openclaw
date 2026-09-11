import { workerData } from "node:worker_threads";
import {
  STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
  serializeStorageSyncBridgeError,
  type StorageSyncBridgeRequest,
  type StorageSyncBridgeResponse,
  type StorageSyncBridgeWorkerData,
} from "./storage-sync-bridge-protocol.js";

const RESPONSE_SIGNAL_INDEX = 0;
// SAFETY: only StorageSyncBridgeClient launches this private entrypoint with this workerData shape.
const data = workerData as StorageSyncBridgeWorkerData;
const signal = new Int32Array(data.signal);
let closed = false;
let pending = Promise.resolve();
let pluginStateLoaded = false;
let taskCohortLoaded = false;

async function handleRequest(request: StorageSyncBridgeRequest): Promise<unknown> {
  switch (request.domain) {
    case "control": {
      const operation =
        request.payload && typeof request.payload === "object"
          ? Reflect.get(request.payload, "operation")
          : undefined;
      if (operation !== "close") {
        throw new Error("Unknown storage compatibility control operation.");
      }
      if (pluginStateLoaded) {
        const { closePluginStateSyncBridgeHandler } =
          await import("../plugin-state/plugin-state-sync-bridge-handler.js");
        await closePluginStateSyncBridgeHandler();
      }
      if (taskCohortLoaded) {
        const { closeTaskCohortSyncBridgeHandler } =
          await import("../tasks/task-cohort-sync-bridge-handler.js");
        await closeTaskCohortSyncBridgeHandler();
      }
      closed = true;
      return undefined;
    }
    case "plugin-state": {
      pluginStateLoaded = true;
      const { handlePluginStateSyncBridgeRequest } =
        await import("../plugin-state/plugin-state-sync-bridge-handler.js");
      // SAFETY: the plugin-state facade is the sole producer for this closed domain payload.
      const envelope = request.payload as Parameters<typeof handlePluginStateSyncBridgeRequest>[0];
      return await handlePluginStateSyncBridgeRequest(envelope);
    }
    case "task-cohort": {
      taskCohortLoaded = true;
      const { handleTaskCohortSyncBridgeRequest } =
        await import("../tasks/task-cohort-sync-bridge-handler.js");
      // SAFETY: the task-cohort facade is the sole producer for this closed domain payload.
      const envelope = request.payload as Parameters<typeof handleTaskCohortSyncBridgeRequest>[0];
      return await handleTaskCohortSyncBridgeRequest(envelope);
    }
    default:
      throw new Error("Unknown storage compatibility domain.");
  }
}

function encodeResponse(response: StorageSyncBridgeResponse): string {
  let encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, "utf8") <= data.maxResponseBytes) {
    return encoded;
  }
  encoded = JSON.stringify({
    protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
    generation: response.generation,
    requestId: response.requestId,
    ok: false,
    error: {
      ...serializeStorageSyncBridgeError(
        new Error("Storage compatibility response exceeds the payload limit."),
      ),
      outcomeUnknown: true,
    },
  } satisfies StorageSyncBridgeResponse);
  return encoded;
}

async function processRequest(raw: unknown): Promise<void> {
  let request: StorageSyncBridgeRequest | undefined;
  let response: StorageSyncBridgeResponse;
  try {
    if (typeof raw !== "string") {
      throw new Error("Storage compatibility request must be encoded as text.");
    }
    // SAFETY: the private client emits this closed envelope and the identity fields are checked next.
    request = JSON.parse(raw) as StorageSyncBridgeRequest;
    if (
      request.protocolVersion !== STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION ||
      request.generation !== data.generation ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId <= 0
    ) {
      throw new Error("Storage compatibility request envelope is invalid.");
    }
    response = {
      protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
      generation: data.generation,
      requestId: request.requestId,
      ok: true,
      value: await handleRequest(request),
    };
  } catch (error) {
    response = {
      protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
      generation: data.generation,
      requestId: request?.requestId ?? 0,
      ok: false,
      error: serializeStorageSyncBridgeError(error),
    };
  }
  data.port.postMessage(encodeResponse(response));
  Atomics.store(signal, RESPONSE_SIGNAL_INDEX, response.requestId);
  Atomics.notify(signal, RESPONSE_SIGNAL_INDEX);
  if (closed) {
    data.port.close();
  }
}

data.port.on("message", (raw) => {
  pending = pending.then(() => processRequest(raw));
});
data.port.start();
