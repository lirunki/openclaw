import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  StorageSyncBridgeClient,
  StorageSyncBridgeRemoteError,
} from "./storage-sync-bridge-client.js";
import { closeStorageSyncBridge, requestStorageSyncBridge } from "./storage-sync-bridge.js";

const clients = new Set<StorageSyncBridgeClient>();

function createClient(options: { timeoutMs?: number; maxPayloadBytes?: number } = {}) {
  const workerUrl = new URL("./storage-sync-bridge.worker.test-support.ts", import.meta.url);
  const client = new StorageSyncBridgeClient({
    workerUrl,
    workerExecArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
    defaultTimeoutMs: options.timeoutMs,
    maxPayloadBytes: options.maxPayloadBytes,
  });
  clients.add(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
});

describe("StorageSyncBridgeClient", () => {
  it("reuses one worker for sequential synchronous operations", () => {
    const client = createClient();
    const first = client.request<{ threadId: number; requestCount: number; value: string }>({
      domain: "control",
      payload: { operation: "echo", value: "first" },
    });
    const second = client.request<{ threadId: number; requestCount: number; value: string }>({
      domain: "control",
      payload: { operation: "echo", value: "second" },
    });

    expect(first).toMatchObject({ requestCount: 1, value: "first" });
    expect(second).toMatchObject({ requestCount: 2, value: "second" });
    expect(second.threadId).toBe(first.threadId);
  });

  it("restores structured remote failures without retiring a healthy worker", () => {
    const client = createClient();
    expect(() => client.request({ domain: "control", payload: { operation: "fail" } })).toThrow(
      expect.objectContaining({
        remote: {
          name: "Error",
          message: "fixture conflict",
          code: "FIXTURE_CONFLICT",
          operation: "echo",
        },
      } satisfies Partial<StorageSyncBridgeRemoteError>),
    );

    expect(
      client.request<{ requestCount: number }>({
        domain: "control",
        payload: { operation: "echo" },
      }).requestCount,
    ).toBe(1);
  });

  it("retires a timed-out generation before allowing another operation", async () => {
    const client = createClient();
    expect(() =>
      client.request({ domain: "control", payload: { operation: "stall" }, timeoutMs: 10 }),
    ).toThrow("commit outcome is unknown");
    expect(() => client.request({ domain: "control", payload: { operation: "echo" } })).toThrow(
      "replacement is still in progress",
    );

    await client.close();
    expect(
      client.request<{ requestCount: number }>({
        domain: "control",
        payload: { operation: "echo" },
      }).requestCount,
    ).toBe(1);
  });

  it("fails closed when the production worker receives an unknown domain", async () => {
    try {
      expect(() =>
        requestStorageSyncBridge({
          // Deliberately cross the typed boundary to prove the worker rejects unknown domains.
          domain: "unknown" as "control",
          payload: {},
        }),
      ).toThrow("Unknown storage compatibility domain");
    } finally {
      await closeStorageSyncBridge();
    }
  });

  it("rejects oversized commands before sending them to the worker", () => {
    const client = createClient({ maxPayloadBytes: 128 });
    expect(() =>
      client.request({
        domain: "control",
        payload: { operation: "echo", value: "x".repeat(256) },
      }),
    ).toThrow("exceeds the payload limit");
  });
});
