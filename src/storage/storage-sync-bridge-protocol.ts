import type { MessagePort } from "node:worker_threads";

export const STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION = 1;

export type StorageSyncBridgeDomain = "control" | "plugin-state" | "task-cohort";

export type SerializedStorageSyncBridgeError = {
  name: string;
  message: string;
  code?: string;
  operation?: string;
  outcomeUnknown?: true;
};

export type StorageSyncBridgeRequest = {
  protocolVersion: typeof STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION;
  generation: number;
  requestId: number;
  domain: StorageSyncBridgeDomain;
  payload: unknown;
};

export type StorageSyncBridgeResponse =
  | {
      protocolVersion: typeof STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION;
      generation: number;
      requestId: number;
      ok: true;
      value?: unknown;
    }
  | {
      protocolVersion: typeof STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION;
      generation: number;
      requestId: number;
      ok: false;
      error: SerializedStorageSyncBridgeError;
    };

export type StorageSyncBridgeWorkerData = {
  generation: number;
  port: MessagePort;
  signal: SharedArrayBuffer;
  maxResponseBytes: number;
};

export function serializeStorageSyncBridgeError(error: unknown): SerializedStorageSyncBridgeError {
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  const operation =
    error && typeof error === "object" ? Reflect.get(error, "operation") : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof operation === "string" ? { operation } : {}),
  };
}
