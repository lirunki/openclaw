import { threadId, workerData } from "node:worker_threads";
import {
  STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
  serializeStorageSyncBridgeError,
  type StorageSyncBridgeRequest,
  type StorageSyncBridgeResponse,
  type StorageSyncBridgeWorkerData,
} from "./storage-sync-bridge-protocol.js";

const data = workerData as StorageSyncBridgeWorkerData;
const signal = new Int32Array(data.signal);
let requestCount = 0;

async function handle(request: StorageSyncBridgeRequest): Promise<unknown> {
  const payload = request.payload as { operation?: string; value?: unknown };
  switch (payload.operation) {
    case "echo":
      requestCount += 1;
      return { threadId, requestCount, value: payload.value };
    case "fail":
      throw Object.assign(new Error("fixture conflict"), {
        code: "FIXTURE_CONFLICT",
        operation: "echo",
      });
    case "stall":
      await new Promise(() => undefined);
      return undefined;
    case "close":
      return undefined;
    default:
      throw new Error("unknown fixture operation");
  }
}

data.port.on("message", async (raw) => {
  const request = JSON.parse(String(raw)) as StorageSyncBridgeRequest;
  let response: StorageSyncBridgeResponse;
  try {
    response = {
      protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
      generation: data.generation,
      requestId: request.requestId,
      ok: true,
      value: await handle(request),
    };
  } catch (error) {
    response = {
      protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
      generation: data.generation,
      requestId: request.requestId,
      ok: false,
      error: serializeStorageSyncBridgeError(error),
    };
  }
  data.port.postMessage(JSON.stringify(response));
  Atomics.store(signal, 0, request.requestId);
  Atomics.notify(signal, 0);
});
data.port.start();
