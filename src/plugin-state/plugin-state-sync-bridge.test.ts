import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeState = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("../storage/storage-sync-bridge.js", () => {
  class StorageSyncBridgeTimeoutError extends Error {}
  class StorageSyncBridgeRemoteError extends Error {
    readonly remote: { name: string; message: string; code?: string; operation?: string };

    constructor(remote: { name: string; message: string; code?: string; operation?: string }) {
      super(remote.message);
      this.name = remote.name;
      this.remote = remote;
    }
  }
  return {
    closeStorageSyncBridge: vi.fn(async () => undefined),
    requestStorageSyncBridge: bridgeState.request,
    StorageSyncBridgeRemoteError,
    StorageSyncBridgeTimeoutError,
  };
});

import {
  StorageSyncBridgeRemoteError,
  StorageSyncBridgeTimeoutError,
} from "../storage/storage-sync-bridge.js";
import { AzureSqlPluginStateSyncBridge } from "./plugin-state-sync-bridge.js";

const config = {
  storage: {
    backend: "azuresql" as const,
    azureSql: { server: "sql.example.invalid", database: "openclaw" },
  },
};

const scope = {
  pluginId: "discord",
  namespace: "bindings",
  maxEntries: 10,
  overflowPolicy: "reject-new" as const,
};

afterEach(() => {
  bridgeState.request.mockReset();
});

describe("AzureSqlPluginStateSyncBridge", () => {
  it("returns the durable value from the shared synchronous mailbox", () => {
    bridgeState.request.mockReturnValue({
      key: "thread:1",
      valueJson: '{"session":"main"}',
      createdAt: 1,
      expiresAt: null,
    });

    const env = { OPENCLAW_TEST: "1" };
    const bridge = new AzureSqlPluginStateSyncBridge(config, env, scope);
    expect(bridge.lookup("thread:1")).toEqual({ session: "main" });
    expect(bridgeState.request).toHaveBeenCalledWith({
      domain: "plugin-state",
      payload: {
        config,
        env,
        request: { operation: "lookupRaw", scope, key: "thread:1" },
      },
    });
  });

  it("restores typed plugin-state failures from the worker", () => {
    bridgeState.request.mockImplementation(() => {
      throw new StorageSyncBridgeRemoteError({
        name: "PluginStateStoreError",
        message: "capacity reached",
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
      });
    });

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(() => bridge.register({ key: "thread:1", valueJson: "{}" })).toThrow(
      expect.objectContaining({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
      }),
    );
  });

  it("preserves ambiguous write timeouts as visible write failures", () => {
    bridgeState.request.mockImplementation(() => {
      throw new StorageSyncBridgeTimeoutError("commit outcome is unknown");
    });

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(() => bridge.register({ key: "thread:1", valueJson: "{}" })).toThrow(
      expect.objectContaining({
        message: "commit outcome is unknown",
        code: "PLUGIN_STATE_WRITE_FAILED",
        operation: "register",
      }),
    );
  });

  it("maps mailbox lifecycle failures to plugin-state open failures", () => {
    bridgeState.request.mockImplementation(() => {
      throw new Error("worker failed");
    });

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(() => bridge.lookup("thread:1")).toThrow(
      expect.objectContaining({
        code: "PLUGIN_STATE_OPEN_FAILED",
        operation: "open",
      }),
    );
  });
});
